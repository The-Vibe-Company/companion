/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion, anti-slop/no-conditional-empty-object-spread -- Existing integration and storage fixture patterns are retained while removing hosted Companion expectations. */
/**
 * Product promise:
 * The irreversible Runtime v2 migration cannot start until the exact split-role grant contract has
 * succeeded on the same PostgreSQL backend and every former union credential is already inert.
 *
 * Regression caught:
 * Applying 0094 before validating grants strands a deployment on the destructive schema while a
 * missing role/object or still-live legacy login leaves the old executor privileged.
 *
 * Why integrated:
 * Drizzle's migration journal, session GUC lifetime, pg_stat_activity and ACL/default-ACL catalogs
 * are PostgreSQL behavior. String-shape tests cannot prove the two-phase commit boundary.
 */
import { randomUUID } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";
import {
  RUNTIME_V2_FINAL_CUTOVER_TAG,
  extractRuntimeRoleGrantBlock,
  resolveRuntimeRoleGrantsFile,
  run as runMigrations,
} from "../../src/migrate";

const adminUrl = process.env.DATABASE_MIGRATION_URL ?? process.env.DATABASE_URL;
if (!adminUrl?.trim()) {
  throw new Error("Runtime cutover migration test requires an explicit disposable DATABASE_URL");
}
const requiredAdminUrl: string = adminUrl;

const migrationsDir = fileURLToPath(new URL("../../../../packages/db/drizzle/", import.meta.url));
const adminSql = postgres(requiredAdminUrl, { max: 1 });
const cleanupDatabases: string[] = [];
const cleanupRoles: string[] = [];
const tempDirs: string[] = [];
const desktopReplayWhen = 1_788_152_800_000;
const finalCutoverWhen = 1_788_196_000_000;
const desktopReplayRecoveryWhen = 1_788_282_400_000;
const desktopReplayTag = "0093_companion_runtime_desktop_replay";

interface Fixture {
  databaseName: string;
  databaseUrl: string;
  apiRole: string;
  workerRole: string;
  runtimeRole: string;
}

function name(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
}

async function createRole(role: string, options?: { login?: boolean; password?: string }): Promise<void> {
  const login = options?.login === false ? "nologin" : "login";
  const password = options?.password ? ` password '${options.password}'` : "";
  await adminSql.unsafe(
    `create role ${role} ${login}${password} nosuperuser nobypassrls noinherit`,
  );
  cleanupRoles.push(role);
}

async function createFixture(): Promise<Fixture> {
  const databaseName = name("runtime_cutover");
  const apiRole = name("cutover_api");
  const workerRole = name("cutover_worker");
  const runtimeRole = name("cutover_runtime");
  await createRole(apiRole);
  await createRole(workerRole);
  await createRole(runtimeRole);
  await adminSql.unsafe(`create database ${databaseName}`);
  cleanupDatabases.push(databaseName);
  const url = new URL(requiredAdminUrl);
  url.pathname = `/${databaseName}`;
  url.search = "";
  return { databaseName, databaseUrl: url.toString(), apiRole, workerRole, runtimeRole };
}

function migrationEnv(fixture: Fixture, retiredRuntimeRole?: string): NodeJS.ProcessEnv {
  return {
    DATABASE_MIGRATION_URL: fixture.databaseUrl,
    DATABASE_API_ROLE: fixture.apiRole,
    DATABASE_WORKER_ROLE: fixture.workerRole,
    DATABASE_COMPANION_RUNTIME_ROLE: fixture.runtimeRole,
    ...(retiredRuntimeRole ? { DATABASE_RETIRED_RUNTIME_ROLE: retiredRuntimeRole } : {}),
    COMPANION_MIGRATIONS_DIR: migrationsDir,
  };
}

async function migrateThrough0092(databaseUrl: string): Promise<void> {
  const journal = JSON.parse(
    await readFile(join(migrationsDir, "meta", "_journal.json"), "utf8"),
  ) as { entries: Array<{ tag: string }> };
  const desktopReplayIndex = journal.entries.findIndex((entry) => entry.tag === desktopReplayTag);
  if (desktopReplayIndex < 0) throw new Error("desktop replay repair migration is missing");
  const migrationsThrough0092 = await mkdtemp(join(tmpdir(), "companion-migrations-through-0092-"));
  tempDirs.push(migrationsThrough0092);
  await mkdir(join(migrationsThrough0092, "meta"), { recursive: true });
  const checkpointEntries = journal.entries.slice(0, desktopReplayIndex);
  await writeFile(
    join(migrationsThrough0092, "meta", "_journal.json"),
    `${JSON.stringify({ ...journal, entries: checkpointEntries }, null, 2)}\n`,
    "utf8",
  );
  await Promise.all(checkpointEntries.map((entry) =>
    copyFile(join(migrationsDir, `${entry.tag}.sql`), join(migrationsThrough0092, `${entry.tag}.sql`))
  ));
  const client = postgres(databaseUrl, { max: 1 });
  try {
    await migrate(drizzle(client), { migrationsFolder: migrationsThrough0092 });
  } finally {
    await client.end({ timeout: 1 });
  }
}

async function applyMigrationFile(
  client: ReturnType<typeof postgres>,
  name: string,
): Promise<void> {
  const source = await readFile(join(migrationsDir, name), "utf8");
  const statements = source
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter(Boolean);
  await client.begin(async (transaction) => {
    for (const statement of statements) await transaction.unsafe(statement);
  });
}

async function applyHistoricalRuntimeGrantsWithoutDesktopReplay(
  client: ReturnType<typeof postgres>,
  fixture: Fixture,
): Promise<void> {
  const consumeGrantCast =
    "        'public.companion_runtime_consume_desktop_request(text,bigint,integer)'::regprocedure,\n";
  const grants = extractRuntimeRoleGrantBlock(
    await readFile(await resolveRuntimeRoleGrantsFile(), "utf8"),
  );
  if (!grants.includes(consumeGrantCast)) {
    throw new Error("runtime grants no longer contain the desktop replay function cast");
  }
  await client`select
    set_config('companion.api_role', ${fixture.apiRole}, false),
    set_config('companion.worker_role', ${fixture.workerRole}, false),
    set_config('companion.companion_runtime_role', ${fixture.runtimeRole}, false),
    set_config('companion.retired_runtime_role', '', false)`;
  await client.unsafe(grants.replace(consumeGrantCast, ""));
}

async function expectedLastMigrationWhen(): Promise<number> {
  const journal = JSON.parse(
    await readFile(join(migrationsDir, "meta", "_journal.json"), "utf8"),
  ) as { entries: Array<{ when: number }> };
  const last = journal.entries.at(-1);
  if (!last) throw new Error("migration journal has no entries");
  return last.when;
}

async function lastMigration(databaseUrl: string): Promise<number | null> {
  const client = postgres(databaseUrl, { max: 1 });
  try {
    const [row] = await client<Array<{ createdAt: string | null }>>`
      select max(created_at)::text as "createdAt" from drizzle.__drizzle_migrations
    `;
    return row?.createdAt === null || row?.createdAt === undefined ? null : Number(row.createdAt);
  } finally {
    await client.end({ timeout: 1 });
  }
}

async function expectCutoverAbsent(databaseUrl: string): Promise<void> {
  const latestMigration = await lastMigration(databaseUrl);
  if (latestMigration === null) throw new Error("migration ledger is missing");
  expect(latestMigration).toBeLessThan(finalCutoverWhen);
  const client = postgres(databaseUrl, { max: 1 });
  try {
    const [row] = await client<Array<{ legacyTable: string | null }>>`
      select to_regclass('public.companion_runtime_pools')::text as "legacyTable"
    `;
    expect(row?.legacyTable).toBe("companion_runtime_pools");
  } finally {
    await client.end({ timeout: 1 });
  }
}

async function seedLegacyUnionAcl(
  databaseUrl: string,
  role: string,
): Promise<void> {
  const owner = postgres(databaseUrl, { max: 1 });
  try {
    await owner.unsafe(`grant connect on database ${new URL(databaseUrl).pathname.slice(1)} to ${role}`);
    await owner.unsafe(`grant usage on schema public to ${role}`);
    await owner.unsafe(`grant select, insert, update, delete on all tables in schema public to ${role}`);
    await owner.unsafe(`grant update (email) on table public."user" to ${role}`);
    await owner.unsafe(`grant usage, select on all sequences in schema public to ${role}`);
    await owner.unsafe(`grant execute on all functions in schema public to ${role}`);
    await owner.unsafe(
      `alter default privileges in schema public
       grant select, insert, update, delete on tables to ${role}`,
    );
    await owner.unsafe(
      `alter default privileges in schema public grant usage, select on sequences to ${role}`,
    );
    await owner.unsafe(
      `alter default privileges in schema public grant execute on functions to ${role}`,
    );
  } finally {
    await owner.end({ timeout: 1 });
  }
}

afterAll(async () => {
  for (const database of cleanupDatabases.reverse()) {
    await adminSql.unsafe(`drop database if exists ${database} with (force)`);
  }
  for (const role of cleanupRoles.reverse()) {
    await adminSql.unsafe(`drop role if exists ${role}`);
  }
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  await adminSql.end({ timeout: 1 });
}, 30_000);

describe("Runtime v2 final migration protocol", () => {
  it("refuses retirement with external image ownership and preserves skill data after cleanup", async () => {
    const fixture = await createFixture();
    const folder = await mkdtemp(join(tmpdir(), "companion-before-retirement-"));
    tempDirs.push(folder);
    await mkdir(join(folder, "meta"));
    const journal = JSON.parse(await readFile(join(migrationsDir, "meta", "_journal.json"), "utf8"));
    journal.entries = journal.entries.filter((entry: { idx: number }) => entry.idx < 186);
    await writeFile(join(folder, "meta", "_journal.json"), JSON.stringify(journal));
    for (const entry of journal.entries) {
      await copyFile(join(migrationsDir, `${entry.tag}.sql`), join(folder, `${entry.tag}.sql`));
    }
    await runMigrations({ env: { ...migrationEnv(fixture), COMPANION_MIGRATIONS_DIR: folder } });
    const client = postgres(fixture.databaseUrl, { max: 1 });
    try {
      await client`insert into companion_images (digest, image_name) values (${'a'.repeat(64)}, 'retirement-test')`;
      const orgId = randomUUID();
      await client`insert into public."user" (id, name, email) values ('retirement-member', 'Member', 'retirement@example.test')`;
      await client`insert into public.organizations (id, name, slug) values (${orgId}, 'Retained workspace', 'retained-workspace')`;
      await client`insert into public.skills (org_id, creator_id, slug, description, scope)
        values (${orgId}, 'retirement-member', 'retained-skill', 'Keep this package', 'personal')`;
      await client`insert into public.api_tokens (org_id, user_id, name, token_prefix, token_hash, source_type, source_agent_id, expires_at)
        values (${orgId}, 'retirement-member', 'retired', 'cmp_pat_retired', ${'b'.repeat(64)}, 'companion', ${randomUUID()}, now() + interval '1 day'),
          (${orgId}, 'retirement-member', 'retained', 'cmp_pat_human', ${'c'.repeat(64)}, 'human', null, now() + interval '1 day')`;
      const before = await client`select count(*)::integer as count from public.skills`;
      await expect(runMigrations({ env: migrationEnv(fixture) })).rejects.toThrow(/external resource cleanup/);
      expect(await lastMigration(fixture.databaseUrl)).not.toBe(await expectedLastMigrationWhen());
      expect(await client`select image_name from companion_images`).toEqual([{ image_name: 'retirement-test' }]);
      // This fixture has no provider resource: removing its fake ownership completes its cleanup.
      await client`delete from companion_images`;
      await runMigrations({ env: migrationEnv(fixture) });
      expect(await client`select count(*)::integer as count from public.skills`).toEqual(before);
      expect(await client`select slug, scope, description from public.skills`).toEqual([
        { slug: 'retained-skill', scope: 'personal', description: 'Keep this package' },
      ]);
      expect(await client`select name from public.api_tokens`).toEqual([{ name: 'retained' }]);
      const [retired] = await client`select to_regclass('public.companions') as companions,
        to_regprocedure('public.companion_v3_worker_admit_turn(uuid,uuid,text,jsonb)') as admission`;
      expect(retired).toEqual({ companions: null, admission: null });
      await runMigrations({ env: migrationEnv(fixture) });
    } finally {
      await client.end({ timeout: 1 });
    }
  }, 120_000);

  it("applies a fresh database through recovery 0095 and repairs post-cutover grants every run", async () => {
    const fixture = await createFixture();
    await runMigrations({ env: migrationEnv(fixture) });
    expect(await lastMigration(fixture.databaseUrl)).toBe(await expectedLastMigrationWhen());

    const client = postgres(fixture.databaseUrl, { max: 1 });
    try {
      const [row] = await client<Array<{ legacyTable: string | null }>>`
        select to_regclass('public.companion_runtime_pools')::text as "legacyTable"
      `;
      expect(row?.legacyTable).toBeNull();
    } finally {
      await client.end({ timeout: 1 });
    }

    const dir = await mkdtemp(join(tmpdir(), "companion-cutover-poison-grants-"));
    tempDirs.push(dir);
    const grantsFile = join(dir, "runtime-role-grants.sql");
    await writeFile(
      grantsFile,
      "-- companion-runtime-grants-begin\nDO $$ BEGIN RAISE EXCEPTION 'post-cutover grants ran'; END $$;\n-- companion-runtime-grants-end\n",
    );
    // The post-cutover repair pass runs on every invocation, including one that applies nothing:
    // gating it on "this run applied a migration" would make a deploy that died between the
    // migration and the grant unrepairable. The poisoned file proves the hook was read.
    await expect(runMigrations({
      env: { ...migrationEnv(fixture), COMPANION_RUNTIME_GRANTS_FILE: grantsFile },
    })).rejects.toThrow(/post-cutover grants ran/);
    expect(await lastMigration(fixture.databaseUrl)).toBe(await expectedLastMigrationWhen());

    // With the real hook it is idempotent, so a no-op run still succeeds and still leaves the
    // executor surface granted.
    await expect(runMigrations({ env: migrationEnv(fixture) })).resolves.toBeUndefined();
  }, 120_000);

  it("repairs an old 0091/0092 ledger before grants and cutover", async () => {
    const fixture = await createFixture();
    await migrateThrough0092(fixture.databaseUrl);
    const client = postgres(fixture.databaseUrl, { max: 1 });
    try {
      const [before] = await client<Array<{ replayTable: string | null; consumeFunction: string | null }>>`
        select
          to_regclass('public.companion_runtime_desktop_requests')::text as "replayTable",
          to_regprocedure(
            'public.companion_runtime_consume_desktop_request(text,bigint,integer)'
          )::text as "consumeFunction"
      `;
      expect(before).toEqual({ replayTable: null, consumeFunction: null });

      await runMigrations({ env: migrationEnv(fixture) });
      const ledger = await client<Array<{ createdAt: string }>>`
        select created_at::text as "createdAt"
        from drizzle.__drizzle_migrations
        where created_at in (
          ${desktopReplayWhen}, ${finalCutoverWhen}, ${desktopReplayRecoveryWhen}
        )
        order by created_at
      `;
      expect(ledger.map((row) => Number(row.createdAt))).toEqual([
        desktopReplayWhen,
        finalCutoverWhen,
        desktopReplayRecoveryWhen,
      ]);
      const [retired] = await client`select to_regclass('public.companions') as companions`;
      expect(retired?.companions).toBeNull();
      await client.unsafe("reset role");
    } finally {
      await client.unsafe("reset role").catch(() => undefined);
      await client.end({ timeout: 1 });
    }
  }, 120_000);

  it("repairs a ledger that recorded the old cutover before desktop replay existed", async () => {
    const fixture = await createFixture();
    await migrateThrough0092(fixture.databaseUrl);
    const client = postgres(fixture.databaseUrl, { max: 1 });
    const dir = await mkdtemp(join(tmpdir(), "companion-cutover-recorded-poison-grants-"));
    tempDirs.push(dir);
    const grantsFile = join(dir, "runtime-role-grants.sql");
    await writeFile(
      grantsFile,
      "-- companion-runtime-grants-begin\nDO $$ BEGIN RAISE EXCEPTION 'post-cutover grants ran'; END $$;\n-- companion-runtime-grants-end\n",
    );
    try {
      await applyHistoricalRuntimeGrantsWithoutDesktopReplay(client, fixture);
      await applyMigrationFile(client, RUNTIME_V2_FINAL_CUTOVER_TAG + ".sql");
      await client`
        insert into drizzle.__drizzle_migrations(hash, created_at)
        values (${"0".repeat(64)}, ${finalCutoverWhen})
      `;

      const [before] = await client<Array<{
        replayTable: string | null;
        consumeFunction: string | null;
      }>>`
        select
          to_regclass('public.companion_runtime_desktop_requests')::text as "replayTable",
          to_regprocedure(
            'public.companion_runtime_consume_desktop_request(text,bigint,integer)'
          )::text as "consumeFunction"
      `;
      expect(before).toEqual({ replayTable: null, consumeFunction: null });

      // This run does apply post-cutover migrations, and one of them has to DROP + CREATE a
      // function whose return type changed -- which resets that function's ACL. The runner
      // therefore re-runs the grants hook, so this run needs the real one.
      await expect(runMigrations({ env: migrationEnv(fixture) })).resolves.toBeUndefined();
      expect(await lastMigration(fixture.databaseUrl)).toBe(await expectedLastMigrationWhen());

      // The repair pass is unconditional, so even a no-op run reads the hook. Proven with the
      // poisoned file, then repeated with the real one so the ACL assertions below still hold.
      await expect(runMigrations({
        env: {
          ...migrationEnv(fixture),
          COMPANION_RUNTIME_GRANTS_FILE: grantsFile,
        },
      })).rejects.toThrow(/post-cutover grants ran/);
      await expect(runMigrations({ env: migrationEnv(fixture) })).resolves.toBeUndefined();
      expect(await lastMigration(fixture.databaseUrl)).toBe(await expectedLastMigrationWhen());

      const [retired] = await client`select to_regclass('public.companion_runtime_desktop_requests') as requests`;
      expect(retired?.requests).toBeNull();

    } finally {
      await client.unsafe("reset role").catch(() => undefined);
      await client.end({ timeout: 1 });
    }
  }, 120_000);

  it("fails closed when recorded-cutover source ACLs are no longer private", async () => {
    const fixture = await createFixture();
    await migrateThrough0092(fixture.databaseUrl);
    const client = postgres(fixture.databaseUrl, { max: 1 });
    try {
      await applyHistoricalRuntimeGrantsWithoutDesktopReplay(client, fixture);
      await applyMigrationFile(client, RUNTIME_V2_FINAL_CUTOVER_TAG + ".sql");
      await client`
        insert into drizzle.__drizzle_migrations(hash, created_at)
        values (${"1".repeat(64)}, ${finalCutoverWhen})
      `;
      await client.unsafe(
        "grant execute on function public.companion_runtime_claim_work(text,integer,integer,bigint) to public",
      );

      await expect(runMigrations({ env: migrationEnv(fixture) }))
        .rejects.toThrow("runtime source ACL is public or delegates grant authority");
      expect(await lastMigration(fixture.databaseUrl)).toBe(finalCutoverWhen);
      const [after] = await client<Array<{
        replayTable: string | null;
        consumeFunction: string | null;
      }>>`
        select
          to_regclass('public.companion_runtime_desktop_requests')::text as "replayTable",
          to_regprocedure(
            'public.companion_runtime_consume_desktop_request(text,bigint,integer)'
          )::text as "consumeFunction"
      `;
      expect(after).toEqual({ replayTable: null, consumeFunction: null });
    } finally {
      await client.end({ timeout: 1 });
    }
  }, 120_000);

  it("leaves 0094 unapplied when an active role or a grant-block object is missing", async () => {
    const missingRole = await createFixture();
    await adminSql.unsafe(`drop role ${missingRole.runtimeRole}`);
    cleanupRoles.splice(cleanupRoles.indexOf(missingRole.runtimeRole), 1);
    await expect(runMigrations({ env: migrationEnv(missingRole) })).rejects.toThrow("does not exist");
    await expectCutoverAbsent(missingRole.databaseUrl);

    const missingObject = await createFixture();
    const grantsSource = await readFile(await resolveRuntimeRoleGrantsFile(), "utf8");
    const dir = await mkdtemp(join(tmpdir(), "companion-cutover-broken-grants-"));
    tempDirs.push(dir);
    const grantsFile = join(dir, "runtime-role-grants.sql");
    await writeFile(
      grantsFile,
      grantsSource.replace(
        "'public.companion_runtime_gate_status()'::regprocedure",
        "'public.companion_runtime_missing_object()'::regprocedure",
      ),
    );
    await expect(
      runMigrations({
        env: { ...migrationEnv(missingObject), COMPANION_RUNTIME_GRANTS_FILE: grantsFile },
      }),
    ).rejects.toThrow();
    await expectCutoverAbsent(missingObject.databaseUrl);
  }, 120_000);

  it("retires the historical union role before applying 0094 and leaves no direct/default ACL", async () => {
    const fixture = await createFixture();
    await migrateThrough0092(fixture.databaseUrl);
    const retiredRole = name("cutover_retired");
    await createRole(retiredRole);
    await seedLegacyUnionAcl(fixture.databaseUrl, retiredRole);
    await adminSql.unsafe(`alter role ${retiredRole} nologin`);

    await expect(runMigrations({ env: migrationEnv(fixture) }))
      .rejects.toThrow("legacy union runtime role detected but not named for retirement");
    await expectCutoverAbsent(fixture.databaseUrl);
    await runMigrations({ env: migrationEnv(fixture, retiredRole) });
    const client = postgres(fixture.databaseUrl, { max: 1 });
    try {
      const [attributes] = await client<Array<{ canLogin: boolean }>>`
        select rolcanlogin as "canLogin" from pg_catalog.pg_roles where rolname = ${retiredRole}
      `;
      expect(attributes?.canLogin).toBe(false);
      const [acl] = await client<Array<{
        defaults: number;
        objects: number;
        columns: number;
        functions: number;
        schema: number;
        database: number;
      }>>`
        select
          (select count(*)::int from pg_catalog.pg_default_acl d
            cross join lateral pg_catalog.aclexplode(d.defaclacl) a
            where a.grantee = ${retiredRole}::regrole) as defaults,
          (select count(*)::int from pg_catalog.pg_class c
            join pg_catalog.pg_namespace n on n.oid = c.relnamespace
            cross join lateral pg_catalog.aclexplode(c.relacl) a
            where n.nspname = 'public' and a.grantee = ${retiredRole}::regrole) as objects,
          (select count(*)::int from pg_catalog.pg_attribute attribute
            join pg_catalog.pg_class c on c.oid = attribute.attrelid
            join pg_catalog.pg_namespace n on n.oid = c.relnamespace
            cross join lateral pg_catalog.aclexplode(attribute.attacl) a
            where n.nspname = 'public' and a.grantee = ${retiredRole}::regrole) as columns,
          (select count(*)::int from pg_catalog.pg_proc p
            join pg_catalog.pg_namespace n on n.oid = p.pronamespace
            cross join lateral pg_catalog.aclexplode(p.proacl) a
            where n.nspname = 'public' and a.grantee = ${retiredRole}::regrole) as functions,
          (select count(*)::int from pg_catalog.pg_namespace n
            cross join lateral pg_catalog.aclexplode(n.nspacl) a
            where n.nspname = 'public' and a.grantee = ${retiredRole}::regrole) as schema,
          (select count(*)::int from pg_catalog.pg_database d
            cross join lateral pg_catalog.aclexplode(d.datacl) a
            where d.datname = current_database()
              and a.grantee = ${retiredRole}::regrole) as database
      `;
      expect(acl).toEqual({
        defaults: 0,
        objects: 0,
        columns: 0,
        functions: 0,
        schema: 0,
        database: 0,
      });
    } finally {
      await client.end({ timeout: 1 });
    }
  }, 120_000);

  it("rejects an absent or spoofed same-connection grant marker before any 0094 DDL", async () => {
    const fixture = await createFixture();
    await migrateThrough0092(fixture.databaseUrl);
    const source = await readFile(join(migrationsDir, `${RUNTIME_V2_FINAL_CUTOVER_TAG}.sql`), "utf8");
    const guard = source.split("--> statement-breakpoint", 1)[0]?.trim();
    if (!guard) throw new Error("0094 no longer has a first-statement grants guard");
    const client = postgres(fixture.databaseUrl, { max: 1 });
    try {
      await expect(client.unsafe(guard)).rejects.toThrow("grants were not verified");
      await client`select
        set_config('companion.api_role', ${fixture.apiRole}, false),
        set_config('companion.worker_role', ${fixture.workerRole}, false),
        set_config('companion.companion_runtime_role', ${fixture.runtimeRole}, false),
        set_config('companion.retired_runtime_role', '', false),
        set_config('companion.runtime_grants_nonce', ${"0".repeat(32)}, false),
        set_config('companion.runtime_grants_verified', 'v1:verified', false)`;
      await expect(client.unsafe(guard)).rejects.toThrow("grants were not verified");
    } finally {
      await client.end({ timeout: 1 });
    }
    await expectCutoverAbsent(fixture.databaseUrl);
  }, 120_000);

  it("rejects partial role variables and a retired role reused as an active role", async () => {
    const fixture = await createFixture();
    await expect(
      runMigrations({
        env: {
          DATABASE_MIGRATION_URL: fixture.databaseUrl,
          DATABASE_API_ROLE: fixture.apiRole,
          COMPANION_MIGRATIONS_DIR: migrationsDir,
        },
      }),
    ).rejects.toThrow("must be configured together");
    await expect(
      runMigrations({
        env: {
          ...migrationEnv(fixture),
          DATABASE_RETIRED_RUNTIME_ROLE: fixture.runtimeRole,
        },
      }),
    ).rejects.toThrow("must be distinct");
    const client = postgres(fixture.databaseUrl, { max: 1 });
    try {
      const [row] = await client<Array<{ schemaName: string | null }>>`
        select to_regnamespace('drizzle')::text as "schemaName"
      `;
      expect(row?.schemaName).toBeNull();
    } finally {
      await client.end({ timeout: 1 });
    }
  });

  it("rejects a NOLOGIN retired role while one of its old sessions is still active", async () => {
    const fixture = await createFixture();
    await migrateThrough0092(fixture.databaseUrl);
    const retiredRole = name("cutover_live_retired");
    const password = `legacy-${randomUUID()}`;
    await createRole(retiredRole, { password });
    await seedLegacyUnionAcl(fixture.databaseUrl, retiredRole);
    const retiredUrl = new URL(fixture.databaseUrl);
    retiredUrl.username = retiredRole;
    retiredUrl.password = password;
    const oldSession = postgres(retiredUrl.toString(), { max: 1 });
    try {
      await oldSession`select 1`;
      await adminSql.unsafe(`alter role ${retiredRole} nologin`);
      await expect(runMigrations({ env: migrationEnv(fixture, retiredRole) }))
        .rejects.toThrow("still has active sessions");
      await expectCutoverAbsent(fixture.databaseUrl);
    } finally {
      await oldSession.end({ timeout: 1 });
    }
  }, 120_000);
});
