/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion, anti-slop/no-conditional-empty-object-spread -- Existing integration and storage fixture patterns are retained while removing hosted Companion expectations. */
/**
 * Product promise:
 * The Skills Hub-only cutover can be completed on a live database without orphaning the objects it
 * provisioned: every object is deleted from storage before the row naming it is removed, and the
 * API pre-deploy migration then applies.
 *
 * Regression caught:
 * Every API deploy after the cutover fails forever on a populated database because migration 0063
 * fails closed. Emptying the retired tables without deleting their objects first, or without the
 * operator confirming the provider-side resources were released, silently strands paid resources
 * and sensitive objects with no remaining reference.
 *
 * Why integrated:
 * The guard is PL/pgSQL executed by the real Drizzle migrator, and the ordering it protects only
 * exists against a database that replayed the real migration history through 0062.
 *
 * Failure proof:
 * Removing the object-delete step lets the purge succeed while an object key is still live; letting
 * the purge run without --confirm-provider-cleanup discards sandbox identities the operator never
 * released; skipping the purge leaves the migration failing.
 */
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { preflight, purge, report, storageObligations } from "../../src/cutover";
import { run as runMigrations } from "../../src/migrate";

const databaseUrl = process.env.DATABASE_MIGRATION_URL ?? process.env.DATABASE_URL;
if (!databaseUrl?.trim()) {
  throw new Error("Skills Hub cutover test requires an explicit disposable DATABASE_URL");
}

const migrationsDir = fileURLToPath(new URL("../../../../packages/db/drizzle/", import.meta.url));
const databaseName = `companion_cutover_${randomUUID().replaceAll("-", "")}`;
const roleSuffix = randomUUID().replaceAll("-", "").slice(0, 12);
const apiRole = `cutover_api_${roleSuffix}`;
const workerRole = `cutover_worker_${roleSuffix}`;
const runtimeRole = `cutover_runtime_${roleSuffix}`;
const adminSql = postgres(databaseUrl, { max: 1 });
const upgradeUrl = new URL(databaseUrl);
upgradeUrl.pathname = `/${databaseName}`;
upgradeUrl.search = "";

let upgradeSql: ReturnType<typeof postgres>;
const bucket = new Set<string>();
const deleteObject = async (key: string): Promise<void> => {
  if (!bucket.delete(key)) throw new Error(`object is not in the bucket: ${key}`);
};

async function applyMigrationFile(name: string): Promise<void> {
  const source = await readFile(`${migrationsDir}/${name}`, "utf8");
  for (const statement of source.split("--> statement-breakpoint")) {
    const sql = statement.trim();
    if (sql) await upgradeSql.unsafe(sql);
  }
}

/** Replay history through 0062 and tell Drizzle it is already there, exactly like a live database. */
async function replayHistoryThrough0062(): Promise<void> {
  const historical = (await readdir(migrationsDir))
    .filter((name) => /^\d{4}_.+\.sql$/.test(name) && name < "0063_skills_hub_only.sql")
    .sort();
  for (const migration of historical) await applyMigrationFile(migration);

  const journal = JSON.parse(await readFile(`${migrationsDir}/meta/_journal.json`, "utf8")) as {
    entries: { when: number; tag: string }[];
  };
  const lastApplied = journal.entries.find((entry) => entry.tag === "0062_agent_delegation_tokens");
  if (!lastApplied) throw new Error("migration journal no longer contains 0062_agent_delegation_tokens");

  await upgradeSql.unsafe('create schema if not exists "drizzle"');
  await upgradeSql.unsafe(`
    create table if not exists "drizzle"."__drizzle_migrations" (
      id serial primary key,
      hash text not null,
      created_at bigint
    )
  `);
  await upgradeSql`
    insert into "drizzle"."__drizzle_migrations" ("hash", "created_at")
    values ('replayed-through-0062', ${lastApplied.when})
  `;
}

async function migrateWithApiEnvironment(): Promise<void> {
  await runMigrations({
    env: {
      DATABASE_MIGRATION_URL: upgradeUrl.toString(),
      DATABASE_API_ROLE: apiRole,
      DATABASE_WORKER_ROLE: workerRole,
      DATABASE_COMPANION_RUNTIME_ROLE: runtimeRole,
      COMPANION_MIGRATIONS_DIR: migrationsDir,
    },
  });
}

describe("Skills Hub-only cutover", () => {
  beforeAll(async () => {
    await adminSql.unsafe(`
      create role ${apiRole} login nosuperuser nobypassrls noinherit;
      create role ${workerRole} login nosuperuser nobypassrls noinherit;
      create role ${runtimeRole} login nosuperuser nobypassrls noinherit;
    `);
    await adminSql.unsafe(`create database "${databaseName}"`);
    upgradeSql = postgres(upgradeUrl.toString(), { max: 1 });
    await replayHistoryThrough0062();

    // A production-shaped remnant: uploaded objects, a Project, and the sandbox identity it owns.
    const orgId = randomUUID();
    const projectId = randomUUID();
    const userId = "cutover-owner";
    await upgradeSql`
      insert into "user" (id, name, email) values (${userId}, 'Cutover Owner', 'owner@example.test')
    `;
    await upgradeSql`
      insert into organizations (id, name, slug) values (${orgId}::uuid, 'Cutover', 'cutover')
    `;
    await upgradeSql`
      insert into projects (id, org_id, creator_id, idempotency_key, payload_hash, name, default_model)
      values (
        ${projectId}::uuid, ${orgId}::uuid, ${userId}, 'seed-idempotency-key',
        ${"0".repeat(64)}, 'Legacy project', 'legacy/model'
      )
    `;
    await upgradeSql`
      insert into project_workspaces (org_id, project_id, creator_id, sandbox_name, sandbox_id, checkpoint_id)
      values (${orgId}::uuid, ${projectId}::uuid, ${userId}, 'sandbox-legacy', 'sbx_legacy', 'ckpt_legacy')
    `;

    for (const key of ["projects/attachment-object", "projects/file-object"]) bucket.add(key);
    await upgradeSql`
      insert into project_attachment_uploads (storage_key, org_id, project_id, creator_id, kind, committed_at)
      values ('projects/attachment-object', ${orgId}::uuid, ${projectId}::uuid, ${userId}, 'attachment', clock_timestamp())
    `;
    await upgradeSql`
      insert into project_attachment_uploads (storage_key, org_id, project_id, creator_id, kind, committed_at)
      values ('projects/file-object', ${orgId}::uuid, ${projectId}::uuid, ${userId}, 'file', clock_timestamp())
    `;
  }, 60_000);

  afterAll(async () => {
    await upgradeSql?.end({ timeout: 1 });
    await adminSql.unsafe(`drop database if exists "${databaseName}" with (force)`);
    await adminSql.unsafe(`
      drop role if exists ${apiRole};
      drop role if exists ${workerRole};
      drop role if exists ${runtimeRole};
    `);
    await adminSql.end({ timeout: 1 });
  });

  it("blocks the pre-deploy migration and keeps every reference while obligations remain", async () => {
    await expect(migrateWithApiEnvironment()).rejects.toThrow(
      "Skills Hub-only migration requires runtime resource cleanup first",
    );

    const counts = await preflight(upgradeSql);
    expect(counts.pendingStorage).toBe(2);
    expect(counts.pendingProjects).toBe(1);

    const inventory: string[] = [];
    await report(upgradeSql, (message) => inventory.push(message));
    const printed = inventory.join("\n");
    expect(printed).toContain("projects/attachment-object");
    expect(printed).toContain("projects/file-object");
    expect(printed).toContain("sandbox-legacy");
    expect(printed).toContain("ckpt_legacy");
    expect(bucket.size).toBe(2);
  }, 120_000);

  it("refuses to delete anything until provider cleanup is confirmed", async () => {
    await expect(
      purge({ client: upgradeSql, deleteObject, options: { confirmProviderCleanup: false }, log: () => {} }),
    ).rejects.toThrow("--confirm-provider-cleanup");

    expect(bucket.size).toBe(2);
    expect(await storageObligations(upgradeSql)).toHaveLength(2);
  }, 120_000);

  it("previews the work without changing anything on a dry run", async () => {
    const result = await purge({
      client: upgradeSql,
      deleteObject,
      options: { confirmProviderCleanup: true, dryRun: true },
      log: () => {},
    });

    expect(result.deletedObjects).toBe(0);
    expect(result.emptiedTables).toBe(0);
    expect(bucket.size).toBe(2);
    expect(await storageObligations(upgradeSql)).toHaveLength(2);
  }, 120_000);

  it("settles the remaining obligations and lets the pre-deploy migration apply", async () => {
    const result = await purge({
      client: upgradeSql,
      deleteObject,
      options: { confirmProviderCleanup: true },
      log: () => {},
    });
    expect(result.deletedObjects).toBe(2);
    expect(bucket.size).toBe(0);
    expect(result.preflight).toEqual({
      pendingStorage: 0,
      pendingProjects: 0,
      pendingSandboxes: 0,
      activeUsage: 0,
    });

    await migrateWithApiEnvironment();

    const [schema] = await upgradeSql<
      { projects: string | null; companions: string | null; providers: string | null; skills: string | null }[]
    >`
      select
        to_regclass('public.projects')::text as projects,
        to_regclass('public.companions')::text as companions,
        to_regclass('public.companion_provider_connections')::text as providers,
        to_regclass('public.skills')::text as skills
    `;
    expect(schema).toEqual({
      projects: null,
      companions: null,
      providers: null,
      skills: "skills",
    });
  }, 120_000);
});
