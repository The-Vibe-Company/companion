/**
 * Product promise: a current Runtime v3 MCP broker capability resolves without a retired Runtime
 * v2 projection, while token rotation, expiry, revocation, and inactive lifecycle state fail closed.
 *
 * Why integrated: the resolver is SECURITY DEFINER behind FORCE RLS and derives its authority from
 * the fully migrated PostgreSQL schema; a unit fake cannot prove the table binding or role ACL.
 */
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const databaseUrl = process.env.DATABASE_MIGRATION_URL ?? process.env.DATABASE_URL;
if (!databaseUrl?.trim()) {
  throw new Error("Runtime v3 MCP resolver migration test requires a disposable PostgreSQL URL");
}

const migrationsDir = fileURLToPath(new URL("../../../../packages/db/drizzle/", import.meta.url));
const grantsFile = fileURLToPath(
  new URL("../../../../packages/db/runtime-role-grants.sql", import.meta.url),
);
const suffix = randomUUID().replaceAll("-", "").slice(0, 16);
const databaseName = `v3_mcp_resolver_${suffix}`;
const apiRole = `v3_mcp_api_${suffix}`;
const workerRole = `v3_mcp_worker_${suffix}`;
const runtimeRole = `v3_mcp_runtime_${suffix}`;
const actorId = `v3-mcp-owner-${suffix}`;
const orgId = randomUUID();
const companionId = randomUUID();
const currentTokenId = randomUUID();
const wrongCurrentTokenId = randomUUID();
const revokedTokenId = randomUUID();
const expiredTokenId = randomUUID();
const currentTokenHash = "a".repeat(64);
const wrongCurrentTokenHash = "b".repeat(64);
const revokedTokenHash = "c".repeat(64);
const expiredTokenHash = "d".repeat(64);
const accountRefs = [{ account_id: randomUUID(), credential_generation: randomUUID() }];
const adminSql = postgres(databaseUrl, { max: 1 });
const upgradeUrl = new URL(databaseUrl);
upgradeUrl.pathname = `/${databaseName}`;
upgradeUrl.search = "";
let upgradeSql: ReturnType<typeof postgres>;

async function applyMigrationFile(name: string): Promise<void> {
  const source = await readFile(`${migrationsDir}/${name}`, "utf8");
  const statements = source
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter(Boolean);
  await upgradeSql.begin(async (transaction) => {
    for (const statement of statements) await transaction.unsafe(statement);
  });
}

async function applySplitGrants(): Promise<void> {
  const source = await readFile(grantsFile, "utf8");
  const beginMarker = "-- companion-runtime-grants-begin";
  const endMarker = "-- companion-runtime-grants-end";
  const begin = source.indexOf(beginMarker);
  const end = source.indexOf(endMarker);
  if (begin < 0 || end <= begin) throw new Error("runtime grant hook markers are missing");
  const connection = await upgradeSql.reserve();
  try {
    await connection`select set_config('companion.api_role', ${apiRole}, false)`;
    await connection`select set_config('companion.worker_role', ${workerRole}, false)`;
    await connection`select set_config('companion.companion_runtime_role', ${runtimeRole}, false)`;
    await connection`select set_config('companion.retired_runtime_role', '', false)`;
    await connection.unsafe(source.slice(begin + beginMarker.length, end).trim());
  } finally {
    connection.release();
  }
}

async function resolveAsApi(tokenHash: string): Promise<Array<{
  orgId: string;
  companionId: string;
  actorId: string;
  accountRefs: typeof accountRefs;
}>> {
  return await upgradeSql.begin(async (transaction) => {
    await transaction.unsafe(`set local role ${apiRole}`);
    return await transaction`
      select org_id as "orgId", companion_id as "companionId", actor_id as "actorId",
        account_refs as "accountRefs"
      from public.companion_resolve_mcp_broker_token(${tokenHash})
    `;
  });
}

describe("0183 Runtime v3 MCP broker resolver migration", () => {
  beforeAll(async () => {
    await adminSql.unsafe(`
      create role ${apiRole} login nosuperuser nobypassrls noinherit;
      create role ${workerRole} login nosuperuser nobypassrls noinherit;
      create role ${runtimeRole} login nosuperuser nobypassrls noinherit;
    `);
    await adminSql.unsafe(`create database "${databaseName}"`);
    upgradeSql = postgres(upgradeUrl.toString(), { max: 1 });

    const migrations = (await readdir(migrationsDir))
      .filter((name) => /^\d{4}_.+\.sql$/.test(name))
      .sort();
    const cutoverIndex = migrations.findIndex((name) => name.startsWith("0094_"));
    if (cutoverIndex < 0) throw new Error("Runtime v2 cutover migration is missing");
    const resolverMigrationIndex = migrations.findIndex((name) => name.startsWith("0183_"));
    if (resolverMigrationIndex < 0) throw new Error("Runtime v3 MCP resolver migration is missing");
    for (const migration of migrations.slice(0, cutoverIndex)) await applyMigrationFile(migration);
    await applySplitGrants();
    for (const migration of migrations.slice(cutoverIndex, resolverMigrationIndex)) {
      await applyMigrationFile(migration);
    }
    await applySplitGrants();
    await applyMigrationFile(migrations[resolverMigrationIndex]!);

    await upgradeSql`
      insert into public."user" (id, name, email, email_verified)
      values (${actorId}, 'MCP Resolver Owner', ${`${actorId}@example.test`}, true)
    `;
    await upgradeSql`
      insert into public.organizations (id, name, slug, kind)
      values (${orgId}::uuid, 'MCP Resolver', ${`mcp-resolver-${suffix}`}, 'team')
    `;
    await upgradeSql`
      insert into public.memberships (org_id, user_id, org_role)
      values (${orgId}::uuid, ${actorId}, 'owner')
    `;
    await upgradeSql`
      insert into public.companions (id, org_id, owner_id, name)
      values (${companionId}::uuid, ${orgId}::uuid, ${actorId}, 'MCP Resolver Companion')
    `;
    await upgradeSql`
      insert into public.companion_v3_instances (
        org_id, companion_id, desired_lifecycle_actor_id
      ) values (${orgId}::uuid, ${companionId}::uuid, ${actorId})
    `;
    await upgradeSql`
      insert into public.companion_mcp_broker_tokens (
        id, org_id, companion_id, actor_id, token_prefix, token_hash, account_refs,
        expires_at, revoked_at
      ) values
        (${currentTokenId}::uuid, ${orgId}::uuid, ${companionId}::uuid, ${actorId},
          'cmp_mcp_curren', ${currentTokenHash}, ${upgradeSql.json(accountRefs)},
          now() + interval '1 hour', null),
        (${wrongCurrentTokenId}::uuid, ${orgId}::uuid, ${companionId}::uuid, ${actorId},
          'cmp_mcp_wrong_', ${wrongCurrentTokenHash}, ${upgradeSql.json(accountRefs)},
          now() + interval '1 hour', null),
        (${revokedTokenId}::uuid, ${orgId}::uuid, ${companionId}::uuid, ${actorId},
          'cmp_mcp_revoke', ${revokedTokenHash}, ${upgradeSql.json(accountRefs)},
          now() + interval '1 hour', now()),
        (${expiredTokenId}::uuid, ${orgId}::uuid, ${companionId}::uuid, ${actorId},
          'cmp_mcp_expire', ${expiredTokenHash}, ${upgradeSql.json(accountRefs)},
          now() - interval '1 second', null)
    `;
    await upgradeSql`
      update public.companion_v3_instances set mcp_broker_token_id = ${currentTokenId}::uuid
      where org_id = ${orgId}::uuid and companion_id = ${companionId}::uuid
    `;
  }, 120_000);

  afterAll(async () => {
    if (upgradeSql) await upgradeSql.end({ timeout: 1 });
    await adminSql.unsafe(`drop database if exists "${databaseName}" with (force)`);
    await adminSql.unsafe(`drop role if exists ${apiRole}, ${workerRole}, ${runtimeRole}`);
    await adminSql.end({ timeout: 1 });
  }, 30_000);

  it("resolves only the current active v3 capability without a legacy runtime row", async () => {
    expect(await upgradeSql`
      select companion_id from public.companion_runtime_instances
      where org_id = ${orgId}::uuid and companion_id = ${companionId}::uuid
    `).toEqual([]);

    expect(await resolveAsApi(currentTokenHash)).toEqual([{
      orgId,
      companionId,
      actorId,
      accountRefs,
    }]);
    expect(await resolveAsApi(wrongCurrentTokenHash)).toEqual([]);

    await upgradeSql`
      update public.companion_v3_instances set mcp_broker_token_id = ${revokedTokenId}::uuid
      where org_id = ${orgId}::uuid and companion_id = ${companionId}::uuid
    `;
    expect(await resolveAsApi(revokedTokenHash)).toEqual([]);

    await upgradeSql`
      update public.companion_v3_instances set mcp_broker_token_id = ${expiredTokenId}::uuid
      where org_id = ${orgId}::uuid and companion_id = ${companionId}::uuid
    `;
    expect(await resolveAsApi(expiredTokenHash)).toEqual([]);

    await upgradeSql`
      update public.companion_v3_instances set mcp_broker_token_id = ${currentTokenId}::uuid,
        desired_lifecycle = 'archive'
      where org_id = ${orgId}::uuid and companion_id = ${companionId}::uuid
    `;
    expect(await resolveAsApi(currentTokenHash)).toEqual([]);

    await upgradeSql`
      update public.companion_v3_instances set desired_lifecycle = 'prepare',
        lifecycle_state = 'archived'
      where org_id = ${orgId}::uuid and companion_id = ${companionId}::uuid
    `;
    expect(await resolveAsApi(currentTokenHash)).toEqual([]);
  });

  it("retains the resolver's SECURITY DEFINER, RLS, search path, and API-only execution surface", async () => {
    const [definition] = await upgradeSql<Array<{
      securityDefiner: boolean;
      config: string[];
      apiCanExecute: boolean;
      publicCanExecute: boolean;
    }>>`
      select procedure.prosecdef as "securityDefiner", procedure.proconfig as config,
        has_function_privilege(${apiRole}, procedure.oid, 'EXECUTE') as "apiCanExecute",
        has_function_privilege('public', procedure.oid, 'EXECUTE') as "publicCanExecute"
      from pg_catalog.pg_proc procedure
      where procedure.oid = 'public.companion_resolve_mcp_broker_token(text)'::regprocedure
    `;
    expect(definition).toEqual({
      securityDefiner: true,
      config: ["search_path=pg_catalog, public", "row_security=on"],
      apiCanExecute: true,
      publicCanExecute: false,
    });
  });
});
