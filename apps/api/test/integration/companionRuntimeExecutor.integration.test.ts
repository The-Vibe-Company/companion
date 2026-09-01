/* oxlint-disable anti-slop/no-chained-type-assertions, anti-slop/no-runtime-typeof, anti-slop/no-unsafe-dictionary-type, anti-slop/require-safety-comment-for-type-assertion -- Existing PostgreSQL fixture decoding predates the incremental anti-slop gate. */

/**
 * Product promise:
 * the isolated Runtime v2 login can fetch only lease-authorized material and can commit a typed
 * broker projection before ACK without ever receiving direct table privileges. Desktop minting
 * exposes only a fully staged warm Box whose personal Skills and MCP pins belong to that actor.
 *
 * Regression caught:
 * a forged tenant/fence, response-lost projection retry, revoked actor, duplicate generation Box,
 * Viewer request, revision drift, or Owner/Editor resource-owner swap must not expose a Box,
 * leak credentials, duplicate transcript rows, or cross a stale lease epoch.
 *
 * Why integrated:
 * the guarantees depend on real SECURITY DEFINER ownership, FORCE RLS, triggers, enum/check
 * constraints, and transactional cursor/projection writes.
 */
import { createHash, randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { sql as drizzleSql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { listCompanionTriggerProviderAccounts } from "@companion/core";
import {
  companionOperationSchema,
  companionTranscriptEntrySchema,
  companionTurnSchema,
  type CompanionConfigProposal,
} from "@companion/contracts";
import { schema, type Db } from "@companion/db";
import {
  RuntimeDatabaseRoleError,
  verifyRuntimeDatabaseRole,
} from "@companion/db/runtime-role";
import {
  PostgresRuntimeStore,
  type LeaseFence,
  type RuntimeSqlClient,
} from "@companion/companion-runtime";
import { extractRuntimeRoleGrantBlock, resolveRuntimeRoleGrantsFile } from "../../src/migrate";

const databaseUrl = process.env.DATABASE_MIGRATION_URL ?? process.env.DATABASE_URL;
if (!databaseUrl?.trim()) {
  throw new Error("Companion runtime executor integration test requires an explicit disposable DATABASE_URL");
}

const migrationsDir = fileURLToPath(new URL("../../../../packages/db/drizzle/", import.meta.url));
const suffix = randomUUID().replaceAll("-", "").slice(0, 16);
const databaseName = `runtime_exec_${suffix}`;
const apiRole = `runtime_exec_api_${suffix}`;
const workerRole = `runtime_exec_worker_${suffix}`;
const runtimeRole = `runtime_exec_role_${suffix}`;
const executorId = `runtime-executor-${suffix}`;
const adminSql = postgres(databaseUrl, { max: 1 });
const runtimeUrl = new URL(databaseUrl);
runtimeUrl.pathname = `/${databaseName}`;
runtimeUrl.search = "";

type Sql = ReturnType<typeof postgres>;
type Tx = postgres.TransactionSql;

const integrationJsonObjectSchema = z.record(z.string(), z.unknown());
type IntegrationJsonObject = z.infer<typeof integrationJsonObjectSchema>;

function stringValue<T>(value: T): string | null {
  const parsed = z.string().safeParse(value);
  return parsed.success ? parsed.data : null;
}

interface Claim {
  orgId: string;
  companionId: string;
  claimToken: string;
  claimEpoch: string;
  gateEpoch: string;
  workKind: "operation" | "decision" | "attempt" | "settings" | "health";
  workId: string;
  checkpoint: string;
  checkpointSequence: string;
  runtimeGeneration: string;
}

const ids = {
  orgA: randomUUID(),
  orgB: randomUUID(),
  ownerA: `runtime-exec-owner-a-${suffix}`,
  editorA: `runtime-exec-editor-a-${suffix}`,
  viewerA: `runtime-exec-viewer-a-${suffix}`,
  revokedA: `runtime-exec-revoked-a-${suffix}`,
  ownerB: `runtime-exec-owner-b-${suffix}`,
  skill: randomUUID(),
  skillVersion: randomUUID(),
  orgSkill: randomUUID(),
  orgSkillVersion: randomUUID(),
  editorSkill: randomUUID(),
  editorSkillVersion: randomUUID(),
  mcpAccount: randomUUID(),
  mcpGeneration: randomUUID(),
  editorMcpAccount: randomUUID(),
  editorMcpGeneration: randomUUID(),
  revokedMcpAccount: randomUUID(),
  revokedMcpGeneration: randomUUID(),
};
const providerId = `runtime-exec-${suffix}`;
const providerGeneration = randomUUID();
const checksum = `sha256:${"a".repeat(64)}`;
let sql: Sql | undefined;

async function applyMigrationFile(client: Sql, name: string): Promise<void> {
  const source = await readFile(`${migrationsDir}/${name}`, "utf8");
  const statements = source
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter(Boolean);
  await client.begin(async (tx) => {
    for (const statement of statements) await tx.unsafe(statement);
  });
}

async function migrationFileNames(): Promise<string[]> {
  return (await readdir(migrationsDir))
    .filter((name) => /^\d{4}_.+\.sql$/.test(name))
    .sort();
}

async function replayMigrations(client: Sql, names: string[]): Promise<void> {
  for (const name of names) await applyMigrationFile(client, name);
}

async function applySplitGrants(database: Sql | undefined = sql): Promise<void> {
  if (!database) throw new Error("runtime executor database is not initialized");
  const grants = extractRuntimeRoleGrantBlock(
    await readFile(await resolveRuntimeRoleGrantsFile(), "utf8"),
  );
  const connection = await database.reserve();
  try {
    await connection`select set_config('companion.api_role', ${apiRole}, false)`;
    await connection`select set_config('companion.worker_role', ${workerRole}, false)`;
    await connection`select set_config('companion.companion_runtime_role', ${runtimeRole}, false)`;
    await connection`select set_config('companion.retired_runtime_role', '', false)`;
    await connection.unsafe(grants);
  } finally {
    connection.release();
  }
}

async function asRuntime<T>(action: (tx: Tx) => Promise<T>): Promise<T> {
  if (!sql) throw new Error("runtime executor database is not initialized");
  const wrapped = await sql.begin(async (tx) => {
    await tx.unsafe(`set local role ${runtimeRole}`);
    return { value: await action(tx) };
  });
  return wrapped.value;
}

async function asWorker<T>(action: (tx: Tx) => PromiseLike<T>): Promise<T> {
  if (!sql) throw new Error("runtime executor database is not initialized");
  const wrapped = await sql.begin(async (tx) => {
    await tx.unsafe(`set local role ${workerRole}`);
    return { value: await action(tx) };
  });
  return wrapped.value;
}

async function asApi<T>(input: {
  orgId: string;
  actorId: string;
  action: (tx: Tx) => PromiseLike<T>;
}): Promise<T> {
  if (!sql) throw new Error("runtime executor database is not initialized");
  const wrapped = await sql.begin(async (tx) => {
    await tx.unsafe(`set local role ${apiRole}`);
    await tx`select set_config('app.org_id', ${input.orgId}, true)`;
    await tx`select set_config('app.user_id', ${input.actorId}, true)`;
    return { value: await input.action(tx) };
  });
  return wrapped.value;
}

async function asApplicationRoleWithForgedProtocol<T>(input: {
  role: string;
  action: (tx: Tx) => PromiseLike<T>;
}): Promise<T> {
  if (!sql) throw new Error("runtime executor database is not initialized");
  const wrapped = await sql.begin(async (tx) => {
    await tx.unsafe(`set local role ${input.role}`);
    await tx`select set_config('app.org_id', ${ids.orgA}, true)`;
    await tx`select set_config('app.user_id', ${ids.ownerA}, true)`;
    await tx`select set_config('app.companion_runtime_protocol', '2', true)`;
    return { value: await input.action(tx) };
  });
  return wrapped.value;
}

async function asOwnerV2<T>(action: (tx: Tx) => PromiseLike<T>): Promise<T> {
  if (!sql) throw new Error("runtime executor database is not initialized");
  const wrapped = await sql.begin(async (tx) => {
    await tx`select set_config('app.companion_runtime_protocol', '2', true)`;
    return { value: await action(tx) };
  });
  return wrapped.value;
}

async function createCompanion(input: {
  actorId?: string;
  boxReady?: boolean;
  workspaceRole?: "editor" | "viewer";
  selectedSkillIds?: string[];
  selectedMcpAccountIds?: string[];
} = {}): Promise<{ companionId: string; turnId: string; attemptId: string; prompt: string }> {
  if (!sql) throw new Error("runtime executor database is not initialized");
  const companionId = randomUUID();
  const turnId = randomUUID();
  const attemptId = randomUUID();
  const clientMessageId = randomUUID();
  const prompt = `durable prompt ${clientMessageId}`;
  const actorId = input.actorId ?? ids.ownerA;
  const selectedSkillIds = input.selectedSkillIds ?? [ids.skill];
  const selectedMcpAccountIds = input.selectedMcpAccountIds ?? [ids.mcpAccount];
  const mcpGenerations = new Map<string, string>([
    [ids.mcpAccount, ids.mcpGeneration],
    [ids.editorMcpAccount, ids.editorMcpGeneration],
    [ids.revokedMcpAccount, ids.revokedMcpGeneration],
  ]);
  const mcpCredentialRefs = selectedMcpAccountIds.map((accountId) => ({
    account_id: accountId,
    credential_generation: mcpGenerations.get(accountId) ?? ids.mcpGeneration,
  }));
  await sql`
    insert into companions (
      id, org_id, owner_id, name, model_id, provider_ids,
      selected_skill_ids, selected_mcp_account_ids
    ) values (
      ${companionId}::uuid, ${ids.orgA}::uuid, ${ids.ownerA}, 'Runtime executor fixture',
      'fixture-model', ${sql.json([providerId])}, ${sql.json(selectedSkillIds)},
      ${sql.json(selectedMcpAccountIds)}
    )
  `;
  if (input.workspaceRole) {
    await sql`
      insert into companion_workspace_access (
        org_id, companion_id, owner_id, role, granted_by
      ) values (
        ${ids.orgA}::uuid, ${companionId}::uuid, ${ids.ownerA},
        ${input.workspaceRole}, ${ids.ownerA}
      )
    `;
  }
  await sql`
    insert into companion_runtime_instances (
      org_id, companion_id, box_id, box_state, pi_state, pi_invocation_id,
      disk_layout_version, applied_settings_revision, applied_skills_revision,
      applied_client_surface, health_due_at
    ) values (
      ${ids.orgA}::uuid, ${companionId}::uuid,
      ${input.boxReady ? "bx_23456789" : null},
      ${input.boxReady ? "ready" : "absent"},
      ${input.boxReady ? "idle" : "absent"},
      ${input.boxReady ? `pi-${attemptId}` : null},
      ${input.boxReady ? 14 : 0}, 1, 1, 'web', now() + interval '1 day'
    )
  `;
  await sql`
    insert into companion_threads(org_id, companion_id, next_ordinal, last_message_at)
    values (${ids.orgA}::uuid, ${companionId}::uuid, 1, now())
  `;
  await sql`
    insert into companion_transcript_entries(
      org_id, companion_id, event_id, ordinal, role, content, author_id
    ) values (
      ${ids.orgA}::uuid, ${companionId}::uuid, ${`msg:${clientMessageId}`},
      0, 'user', ${prompt}, ${actorId}
    )
  `;
  await sql`
    insert into companion_turns (
      id, org_id, companion_id, client_message_id, message_event_id,
      queue_sequence, actor_id, client_surface, status,
      inactivity_deadline_at, absolute_deadline_at
    ) values (
      ${turnId}::uuid, ${ids.orgA}::uuid, ${companionId}::uuid,
      ${clientMessageId}::uuid, ${`msg:${clientMessageId}`}, 1,
      ${actorId}, 'web', 'running', now() + interval '10 minutes', now() + interval '2 hours'
    )
  `;
  await sql`
    insert into companion_turn_attempts (
      id, org_id, companion_id, turn_id, attempt_number, actor_id,
      runtime_generation, settings_revision, skills_revision, model_id,
      provider_ids, provider_credential_refs, selected_skill_ids,
      selected_mcp_account_ids, mcp_credential_refs,
      status, checkpoint, dispatch_state, command_id,
      dispatch_accepted_at, pi_invocation_id, last_activity_at
    ) values (
      ${attemptId}::uuid, ${ids.orgA}::uuid, ${companionId}::uuid, ${turnId}::uuid,
      1, ${actorId}, 1, 1, 1, 'fixture-model', ${sql.json([providerId])},
      ${sql.json([{
        provider_id: providerId,
        credential_generation: providerGeneration,
        credential_version: 1,
      }])}, ${sql.json(selectedSkillIds)}, ${sql.json(selectedMcpAccountIds)},
      ${sql.json(mcpCredentialRefs)},
      'running', 'running', 'accepted', ${randomUUID()}::uuid,
      now(), ${`pi-${attemptId}`}, now()
    )
  `;
  return { companionId, turnId, attemptId, prompt };
}

async function claimWorkRows(
  limit: number,
  claimant = executorId,
): Promise<Claim[]> {
  const rows = await asRuntime((tx) => tx<Array<Claim>>`
    select org_id::text as "orgId", companion_id::text as "companionId",
      claim_token::text as "claimToken", claim_epoch::text as "claimEpoch",
      gate_epoch::text as "gateEpoch", work_kind::text as "workKind",
      work_id::text as "workId", checkpoint,
      checkpoint_sequence::text as "checkpointSequence",
      runtime_generation::text as "runtimeGeneration"
    from public.companion_runtime_claim_work(${claimant}, ${limit}, 30, (
      select gate_epoch from public.companion_runtime_gate_status()
    ), 6, 1)
  `);
  return rows;
}

async function claimWork(): Promise<Claim> {
  const rows = await claimWorkRows(1);
  if (!rows[0]) throw new Error("expected one Runtime v2 claim");
  return rows[0];
}

async function release(claim: Claim, claimant = executorId): Promise<void> {
  await asRuntime((tx) => tx`
    select public.companion_runtime_release_lease(
      ${claim.orgId}::uuid, ${claim.companionId}::uuid, ${claim.claimToken}::uuid,
      ${claim.claimEpoch}::bigint, ${claim.gateEpoch}::bigint, ${claimant},
      ${claim.workKind}, ${claim.workId}::uuid
    )
  `);
}

async function authorizeClaim(
  claim: Claim,
  claimant = executorId,
): Promise<{ authorized: boolean; denialCode: string | null }> {
  const [authorization] = await asRuntime((tx) => tx<Array<{
    authorized: boolean;
    denialCode: string | null;
  }>>`
    select authorized, denial_code as "denialCode"
    from public.companion_runtime_renew_and_authorize_v2(
      ${claim.orgId}::uuid, ${claim.companionId}::uuid, ${claim.claimToken}::uuid,
      ${claim.claimEpoch}::bigint, ${claim.gateEpoch}::bigint, ${claimant},
      ${claim.workKind}::public.companion_runtime_work_kind, ${claim.workId}::uuid, 30
    )
  `);
  return authorization ?? { authorized: false, denialCode: "lease_lost" };
}

async function removeCompanion(companionId: string): Promise<void> {
  if (!sql) return;
  await sql`delete from companion_delegations where source_companion_id = ${companionId}::uuid or target_companion_id = ${companionId}::uuid`;
  await sql`delete from companion_peer_grants where source_companion_id = ${companionId}::uuid or target_companion_id = ${companionId}::uuid`;
  await sql`delete from companion_deferred_pi_restarts where companion_id = ${companionId}::uuid`;
  await sql`delete from companion_control_requests where companion_id = ${companionId}::uuid`;
  await sql`delete from companion_control_invocations where companion_id = ${companionId}::uuid`;
  await sql`delete from companion_decision_deliveries where companion_id = ${companionId}::uuid`;
  await sql`delete from companion_runtime_event_projections where companion_id = ${companionId}::uuid`;
  await sql`delete from companion_runtime_duplicate_cleanups where companion_id = ${companionId}::uuid`;
  await sql`delete from companion_turn_attempts where companion_id = ${companionId}::uuid`;
  await sql`delete from companion_operations where companion_id = ${companionId}::uuid`;
  await sql`
    update companion_runtime_instances
    set settings_claim_turn_id = null, settings_claim_cold_start_deadline_at = null
    where companion_id = ${companionId}::uuid
  `;
  await sql`delete from companion_turns where companion_id = ${companionId}::uuid`;
  await sql`delete from companion_runtime_leases where companion_id = ${companionId}::uuid`;
  await sql`delete from companion_runtime_instances where companion_id = ${companionId}::uuid`;
  await sql`delete from companion_control_tokens where companion_id = ${companionId}::uuid`;
  await sql`delete from companions where id = ${companionId}::uuid`;
}

interface DesktopAuthorization {
  authorized: boolean;
  denialCode: string | null;
  boxId: string | null;
  boxState: string | null;
  generation: string | null;
}

async function authorizeDesktop(input: {
  companionId: string;
  orgId?: string;
  actorId: string;
}): Promise<DesktopAuthorization[]> {
  return await asRuntime((tx) => tx<Array<DesktopAuthorization>>`
    select authorized, denial_code as "denialCode", box_id as "boxId",
      box_state::text as "boxState", runtime_generation::text as generation
    from public.companion_runtime_authorize_desktop(
      ${input.orgId ?? ids.orgA}::uuid, ${input.companionId}::uuid, ${input.actorId}
    )
  `);
}

describe("Companion runtime executor PostgreSQL surface", () => {
  beforeAll(async () => {
    await adminSql.unsafe(`
      create role ${apiRole} login nosuperuser nobypassrls noinherit;
      create role ${workerRole} login nosuperuser nobypassrls noinherit;
      create role ${runtimeRole} login nosuperuser nobypassrls noinherit;
    `);
    await adminSql.unsafe(`create database "${databaseName}"`);
    const migrationSql = postgres(runtimeUrl.toString(), { max: 1 });
    const migrations = await migrationFileNames();
    const cutoverIndex = migrations.findIndex((name) => name.startsWith("0094_"));
    if (cutoverIndex < 0) throw new Error("Runtime v2 cutover migration is missing");
    try {
      await replayMigrations(migrationSql, migrations.slice(0, cutoverIndex));
      await applySplitGrants(migrationSql);
      await replayMigrations(migrationSql, migrations.slice(cutoverIndex));
      // The two-phase migration runner re-applies the grants hook after the post-cutover phase, for
      // the same reason it is needed here: a migration that has to DROP + CREATE a function resets
      // that function's ACL, so grants taken before the phase describe a surface that no longer
      // exists. Mirroring production ordering is what makes this suite's ACL assertions meaningful.
      await applySplitGrants(migrationSql);
    } finally {
      await migrationSql.end();
    }
    // Runtime grant application and the cutover guard require one physical
    // migration connection. The behavior tests deliberately use a wider pool
    // so Promise.all exercises concurrent database transactions instead of a
    // serialized single-connection queue.
    sql = postgres(runtimeUrl.toString(), { max: 4 });

    for (const [index, userId] of [
      ids.ownerA, ids.editorA, ids.viewerA, ids.revokedA, ids.ownerB,
    ].entries()) {
      await sql`
        insert into "user" (id, name, email, email_verified)
        values (${userId}, ${`Runtime executor actor ${index}`}, ${`${userId}@example.test`}, true)
      `;
    }
    await sql`
      insert into organizations(id, name, slug, kind) values
        (${ids.orgA}::uuid, 'Runtime executor A', ${`runtime-exec-a-${suffix}`}, 'team'),
        (${ids.orgB}::uuid, 'Runtime executor B', ${`runtime-exec-b-${suffix}`}, 'team')
    `;
    await sql`
      insert into memberships(org_id, user_id, org_role) values
        (${ids.orgA}::uuid, ${ids.ownerA}, 'owner'),
        (${ids.orgA}::uuid, ${ids.editorA}, 'developer'),
        (${ids.orgA}::uuid, ${ids.viewerA}, 'developer'),
        (${ids.orgA}::uuid, ${ids.revokedA}, 'developer'),
        (${ids.orgB}::uuid, ${ids.ownerB}, 'owner')
    `;
    await sql`
      insert into companion_provider_connections(
        org_id, provider_id, auth_method, credential_generation, credential_version,
        ciphertext, iv, auth_tag, wrapped_dek, wrap_iv, wrap_auth_tag, key_id, connected_by
      ) values (
        ${ids.orgA}::uuid, ${providerId}, 'api_key', ${providerGeneration}::uuid, 1,
        'ciphertext-provider', 'iv-provider', 'tag-provider', 'wrapped-provider',
        'wrap-iv-provider', 'wrap-tag-provider', 'key-provider', ${ids.ownerA}
      )
    `;
    await sql`
      insert into skills(id, org_id, slug, description, creator_id, scope)
      values
        (
          ${ids.skill}::uuid, ${ids.orgA}::uuid, ${`runtime-skill-${suffix}`},
          'Runtime immutable Skill fixture', ${ids.ownerA}, 'personal'
        ),
        (
          ${ids.orgSkill}::uuid, ${ids.orgA}::uuid, ${`runtime-org-skill-${suffix}`},
          'Runtime organization Skill fixture', ${ids.ownerA}, 'org'
        ),
        (
          ${ids.editorSkill}::uuid, ${ids.orgA}::uuid, ${`runtime-editor-skill-${suffix}`},
          'Runtime Editor Skill fixture', ${ids.editorA}, 'personal'
        )
    `;
    await sql`
      insert into skill_versions(
        id, org_id, skill_id, version, frontmatter, tools, size_bytes,
        checksum, storage_path, validation, created_by
      ) values
        (
          ${ids.skillVersion}::uuid, ${ids.orgA}::uuid, ${ids.skill}::uuid, '1.0.0',
          'name: runtime-fixture', '[]'::jsonb, 42, ${checksum},
          ${`skills/${ids.skillVersion}.tar.gz`}, 'valid', ${ids.ownerA}
        ),
        (
          ${ids.orgSkillVersion}::uuid, ${ids.orgA}::uuid, ${ids.orgSkill}::uuid, '1.0.0',
          'name: runtime-org-fixture', '[]'::jsonb, 42, ${`sha256:${"b".repeat(64)}`},
          ${`skills/${ids.orgSkillVersion}.tar.gz`}, 'valid', ${ids.ownerA}
        ),
        (
          ${ids.editorSkillVersion}::uuid, ${ids.orgA}::uuid, ${ids.editorSkill}::uuid, '1.0.0',
          'name: runtime-editor-fixture', '[]'::jsonb, 42, ${`sha256:${"c".repeat(64)}`},
          ${`skills/${ids.editorSkillVersion}.tar.gz`}, 'valid', ${ids.editorA}
        )
    `;
    await sql`
      update skills skill
      set current_version_id = version.version_id
      from (values
        (${ids.skill}::uuid, ${ids.skillVersion}::uuid),
        (${ids.orgSkill}::uuid, ${ids.orgSkillVersion}::uuid),
        (${ids.editorSkill}::uuid, ${ids.editorSkillVersion}::uuid)
      ) version(skill_id, version_id)
      where skill.id = version.skill_id
    `;
    await sql`
      insert into companion_mcp_accounts(
        id, org_id, owner_id, provider, label, transport, account_config,
        credential_generation, ciphertext, iv, auth_tag, wrapped_dek,
        wrap_iv, wrap_auth_tag, key_id
      ) values
        (
          ${ids.mcpAccount}::uuid, ${ids.orgA}::uuid, ${ids.ownerA}, 'fixture-mcp',
          'Runtime fixture', 'http', ${sql.json({ endpoint: "fixture" })},
          ${ids.mcpGeneration}::uuid, 'ciphertext-mcp', 'iv-mcp', 'tag-mcp',
          'wrapped-mcp', 'wrap-iv-mcp', 'wrap-tag-mcp', 'key-mcp'
        ),
        (
          ${ids.editorMcpAccount}::uuid, ${ids.orgA}::uuid, ${ids.editorA}, 'fixture-mcp',
          'Runtime fixture', 'http', ${sql.json({ endpoint: "editor-fixture" })},
          ${ids.editorMcpGeneration}::uuid, 'ciphertext-editor-mcp', 'iv-editor-mcp',
          'tag-editor-mcp', 'wrapped-editor-mcp', 'wrap-iv-editor-mcp',
          'wrap-tag-editor-mcp', 'key-editor-mcp'
        ),
        (
          ${ids.revokedMcpAccount}::uuid, ${ids.orgA}::uuid, ${ids.revokedA}, 'fixture-mcp',
          'Revocation fixture', 'http', ${sql.json({ endpoint: "revoked-fixture" })},
          ${ids.revokedMcpGeneration}::uuid, 'ciphertext-revoked-mcp', 'iv-revoked-mcp',
          'tag-revoked-mcp', 'wrapped-revoked-mcp', 'wrap-iv-revoked-mcp',
          'wrap-tag-revoked-mcp', 'key-revoked-mcp'
        )
    `;
    const [gate] = await sql<Array<{ gateEpoch: string }>>`
      select gate_epoch::text as "gateEpoch" from companion_runtime_control
    `;
    await sql`
      select * from public.companion_runtime_enable(
        ${gate?.gateEpoch ?? "1"}::bigint, 'runtime-executor-integration'
      )
    `;
  }, 120_000);

  afterAll(async () => {
    await sql?.end({ timeout: 1 });
    await adminSql.unsafe(`drop database if exists "${databaseName}" with (force)`);
    await adminSql.unsafe(`drop role if exists ${runtimeRole}, ${workerRole}, ${apiRole}`);
    await adminSql.end({ timeout: 1 });
  });

  it("serializes identical control invocations and replays their exact stored response", async () => {
    if (!sql) throw new Error("runtime executor database is not initialized");
    const fixture = await createCompanion({ selectedSkillIds: [], selectedMcpAccountIds: [] });
    try {
    const invocationId = randomUUID();
    const requestKey = `${fixture.attemptId}:rpc-1`;
    const requestDigest = "d".repeat(64);
    const expectedResult = { jsonrpc: "2.0", id: "rpc-1", result: { applied: true } };
    let mutationCount = 0;

    async function invoke(): Promise<IntegrationJsonObject> {
      return await asApi({
        orgId: ids.orgA,
        actorId: ids.ownerA,
        action: async (tx) => {
          const [registered] = await tx<Array<{ replayed: boolean; result: unknown }>>`
            select * from public.companion_api_register_control_invocation(
              ${ids.orgA}::uuid, ${fixture.companionId}::uuid, ${invocationId}::uuid,
              ${fixture.turnId}::uuid, ${fixture.attemptId}::uuid,
              ${requestKey}, ${requestDigest}
            )
          `;
          if (!registered) throw new Error("expected a control invocation registration");
          if (registered.replayed) return integrationJsonObjectSchema.parse(registered.result);
          mutationCount += 1;
          const [finished] = await tx<Array<{ result: unknown }>>`
            select public.companion_api_finish_control_invocation(
              ${ids.orgA}::uuid, ${fixture.companionId}::uuid, ${fixture.attemptId}::uuid,
              ${requestKey}, ${requestDigest}, ${tx.json(expectedResult)}::jsonb
            ) as result
          `;
          return integrationJsonObjectSchema.parse(finished?.result);
        },
      });
    }

    const [first, replay] = await Promise.all([invoke(), invoke()]);
    expect(first).toEqual(expectedResult);
    expect(replay).toEqual(expectedResult);
    expect(mutationCount).toBe(1);
    const [after] = await sql<Array<{ invocationCount: number }>>`
      select count(*)::int as "invocationCount" from companion_control_invocations i
      where i.companion_id = ${fixture.companionId}::uuid and i.request_key = ${requestKey}
    `;
    expect(after).toEqual({ invocationCount: 1 });

    await sql`
      update companion_turn_attempts set status = 'cancelled', settled_at = now()
      where id = ${fixture.attemptId}::uuid
    `;
    await sql`
      update companion_turns set status = 'cancelled', settled_at = now()
      where id = ${fixture.turnId}::uuid
    `;

    await expect(asApi({
      orgId: ids.orgA,
      actorId: ids.ownerA,
      action: (tx) => tx`
        select * from public.companion_api_register_control_invocation(
          ${ids.orgA}::uuid, ${fixture.companionId}::uuid, ${randomUUID()}::uuid,
          ${fixture.turnId}::uuid, ${fixture.attemptId}::uuid,
          ${requestKey}, ${"e".repeat(64)}
        )
      `,
    })).rejects.toThrow(/idempotency conflict/);
    } finally {
      await removeCompanion(fixture.companionId);
    }
  });

  it("delivers notify and relay delegations, paginates ties, and blocks sends after grant revocation", async () => {
    if (!sql) throw new Error("runtime executor database is not initialized");
    const source = await createCompanion({ selectedSkillIds: [], selectedMcpAccountIds: [] });
    let targetCompanionId = "";
    try {
      const [created] = await asApi({
        orgId: ids.orgA,
        actorId: ids.ownerA,
        action: (tx) => tx<Array<{ companionId: string }>>`
          select companion_id::text as "companionId"
          from public.companion_api_create_companion(
            ${ids.orgA}::uuid, 'Delegation target', null, null, null,
            '[]'::jsonb, false, '[]'::jsonb
          )
        `,
      });
      targetCompanionId = created?.companionId ?? "";
      await asApi({
        orgId: ids.orgA,
        actorId: ids.ownerA,
        action: (tx) => tx`
          select * from public.companion_api_grant_peer_access(
            ${ids.orgA}::uuid, ${source.companionId}::uuid, ${targetCompanionId}::uuid
          )
        `,
      });

      const delegationIds = [
        "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      ] as const;
      const modes = ["notify", "relay"] as const;
      const targetTurnIds: string[] = [];
      for (const [index, delegationId] of delegationIds.entries()) {
        const mode = modes[index];
        if (!mode) throw new Error("delegation mode fixture is unavailable");
        const [enqueued] = await asApi({
          orgId: ids.orgA,
          actorId: ids.ownerA,
          action: (tx) => tx<Array<{
            delegation: IntegrationJsonObject;
            targetTurn: IntegrationJsonObject;
          }>>`
            select delegation, target_turn as "targetTurn"
            from public.companion_api_enqueue_delegation(
              ${ids.orgA}::uuid, ${source.companionId}::uuid, ${targetCompanionId}::uuid,
              ${source.turnId}::uuid, ${source.attemptId}::uuid, ${randomUUID()}::uuid,
              ${`Delegation ${index + 1}`}, ${delegationId}::uuid,
              ${mode}::public.companion_routine_surface_mode,
              ${`delegation-key-${index + 1}`}, ${String(index + 1).repeat(64)}
            )
          `,
        });
        expect(enqueued?.delegation).toMatchObject({
          id: delegationId,
          response_mode: mode,
          status: "queued",
        });
        const targetTurnId = stringValue(enqueued?.targetTurn.id);
        if (!targetTurnId) throw new Error("delegation target turn is unavailable");
        targetTurnIds.push(targetTurnId);
      }

      const tiedAt = new Date("2026-09-01T01:00:00.000Z");
      await sql`
        update companion_delegations set created_at=${tiedAt}
        where org_id=${ids.orgA}::uuid and id in (${delegationIds[0]}::uuid,${delegationIds[1]}::uuid)
      `;
      const [firstPage] = await asApi({
        orgId: ids.orgA,
        actorId: ids.ownerA,
        action: (tx) => tx<Array<{ id: string }>>`
          select id::text from public.companion_api_list_delegations(
            ${ids.orgA}::uuid,${source.companionId}::uuid,1,null
          )
        `,
      });
      expect(firstPage?.id).toBe(delegationIds[1]);
      const [secondPage] = await asApi({
        orgId: ids.orgA,
        actorId: ids.ownerA,
        action: (tx) => tx<Array<{ id: string }>>`
          select id::text from public.companion_api_list_delegations(
            ${ids.orgA}::uuid,${source.companionId}::uuid,1,${delegationIds[1]}::uuid
          )
        `,
      });
      expect(secondPage?.id).toBe(delegationIds[0]);

      await asApi({
        orgId: ids.orgA,
        actorId: ids.ownerA,
        action: (tx) => tx`
          select public.companion_api_revoke_peer_access(
            ${ids.orgA}::uuid,${source.companionId}::uuid,${targetCompanionId}::uuid
          )
        `,
      });
      for (const [index, targetTurnId] of targetTurnIds.entries()) {
        await sql`
          insert into companion_transcript_entries(
            org_id,companion_id,event_id,ordinal,role,content,turn_id
          ) select ${ids.orgA}::uuid,${targetCompanionId}::uuid,${`delegation-output-${index}`},
            coalesce(max(ordinal),-1)+1,'assistant',${`Response ${index + 1}`},${targetTurnId}::uuid
          from companion_transcript_entries
          where org_id=${ids.orgA}::uuid and companion_id=${targetCompanionId}::uuid
        `;
        await sql`
          update companion_turns set status='succeeded',settled_at=now(),
            absolute_deadline_at=now()+interval '2 hours',inactivity_deadline_at=null
          where org_id=${ids.orgA}::uuid and companion_id=${targetCompanionId}::uuid
            and id=${targetTurnId}::uuid
        `;
      }
      const delivered = await sql<Array<{
        id: string;
        deliveryStatus: string;
        sourceResultEventId: string | null;
        sourceRelayTurnId: string | null;
      }>>`
        select id::text,delivery_status::text as "deliveryStatus",
          source_result_event_id as "sourceResultEventId",
          source_relay_turn_id::text as "sourceRelayTurnId"
        from companion_delegations
        where org_id=${ids.orgA}::uuid and source_companion_id=${source.companionId}::uuid
        order by id
      `;
      expect(delivered).toEqual([
        {
          id: delegationIds[0],
          deliveryStatus: "delivered",
          sourceResultEventId: `delegation:${delegationIds[0]}:response`,
          sourceRelayTurnId: null,
        },
        {
          id: delegationIds[1],
          deliveryStatus: "delivered",
          sourceResultEventId: expect.stringMatching(/^msg:/),
          sourceRelayTurnId: expect.any(String),
        },
      ]);
      const [notifyEntry] = await sql<Array<{ content: string }>>`
        select content from companion_transcript_entries
        where org_id=${ids.orgA}::uuid and companion_id=${source.companionId}::uuid
          and event_id=${`delegation:${delegationIds[0]}:response`}
      `;
      expect(notifyEntry?.content).toBe("Response 1");
      const relayTurnId = delivered[1]?.sourceRelayTurnId;
      if (!relayTurnId) throw new Error("relay return turn is unavailable");
      const [relayTurn] = await sql<Array<{ delegationReturnId: string | null }>>`
        select delegation_return_id::text as "delegationReturnId" from companion_turns
        where org_id=${ids.orgA}::uuid and companion_id=${source.companionId}::uuid
          and id=${relayTurnId}::uuid
      `;
      expect(relayTurn?.delegationReturnId).toBe(delegationIds[1]);

      const [beforeRejectedRow] = await sql<Array<{ count: number }>>`
        select count(*)::int from companion_turns where companion_id=${targetCompanionId}::uuid
      `;
      await expect(asApi({
        orgId: ids.orgA,
        actorId: ids.ownerA,
        action: (tx) => tx`
          select * from public.companion_api_enqueue_delegation(
            ${ids.orgA}::uuid,${source.companionId}::uuid,${targetCompanionId}::uuid,
            ${source.turnId}::uuid,${source.attemptId}::uuid,${randomUUID()}::uuid,
            'Rejected after revoke',${randomUUID()}::uuid,'notify',
            'delegation-key-revoked',${"f".repeat(64)}
          )
        `,
      })).rejects.toMatchObject({ code: "42501" });
      const [afterRejectedRow] = await sql<Array<{ count: number }>>`
        select count(*)::int from companion_turns where companion_id=${targetCompanionId}::uuid
      `;
      expect(afterRejectedRow?.count).toBe(beforeRejectedRow?.count);
    } finally {
      await removeCompanion(source.companionId);
      if (targetCompanionId) await removeCompanion(targetCompanionId);
    }
  });

  it("grants only the narrow SECURITY DEFINER executor functions", async () => {
    if (!sql) throw new Error("runtime executor database is not initialized");
    const [acl] = await sql<Array<{
      privateTableReads: number;
      callableFunctions: number;
      helperCallable: boolean;
    }>>`
      select
        (
          select count(*)::int from unnest(array[
            'companion_runtime_control', 'companion_runtime_instances', 'companion_turns',
            'companion_turn_attempts', 'companion_operations', 'companion_decision_deliveries',
            'companion_runtime_leases', 'companion_runtime_duplicate_cleanups',
            'companion_runtime_event_projections', 'companion_runtime_desktop_requests',
            'companion_main_pi_compactions', 'companion_routine_context_substrates',
            'companion_message_attachments', 'companion_routines', 'companion_mcp_broker_tokens',
            'companion_triggers', 'companion_images'
          ]) protected(table_name)
          where has_table_privilege(${runtimeRole}, 'public.' || protected.table_name, 'SELECT')
        ) as "privateTableReads",
        (
          select count(*)::int from unnest(array[
            'public.companion_runtime_get_material(uuid,uuid,uuid,bigint,bigint,text,public.companion_runtime_work_kind,uuid,integer)',
            'public.companion_runtime_get_turn_context(uuid,uuid,uuid,bigint,bigint,text,public.companion_runtime_work_kind,uuid,integer)',
            'public.companion_runtime_get_config_catalog(uuid,uuid,uuid,bigint,bigint,text,public.companion_runtime_work_kind,uuid,integer)',
            'public.companion_runtime_mint_hub_token(uuid,uuid,uuid,bigint,bigint,text,public.companion_runtime_work_kind,uuid,integer)',
            'public.companion_runtime_mint_mcp_broker_token(uuid,uuid,uuid,bigint,bigint,text,public.companion_runtime_work_kind,uuid,integer)',
            'public.companion_runtime_record_material_snapshot(uuid,uuid,uuid,bigint,bigint,text,public.companion_runtime_work_kind,uuid,public.companion_client_surface,timestamp with time zone,text,text)',
            'public.companion_runtime_publish_material_snapshot(uuid,uuid,uuid,bigint,bigint,text,public.companion_runtime_work_kind,uuid,text)',
            'public.companion_runtime_get_attempt_terminal_projection(uuid,uuid,uuid,bigint,bigint,text,public.companion_runtime_work_kind,uuid)',
            'public.companion_runtime_register_duplicate_cleanups(uuid,uuid,uuid,bigint,bigint,text,public.companion_runtime_work_kind,uuid,text[])',
            'public.companion_runtime_checkpoint_duplicate_cleanup(uuid,uuid,uuid,bigint,bigint,text,public.companion_runtime_work_kind,uuid,text,bigint,public.companion_duplicate_cleanup_status,text)',
            'public.companion_runtime_authorize_desktop(uuid,uuid,text)',
            'public.companion_runtime_consume_desktop_request(text,bigint,integer)',
            'public.companion_runtime_project_event_batch(uuid,uuid,uuid,bigint,bigint,text,public.companion_runtime_work_kind,uuid,bigint,text,jsonb,bigint,timestamp with time zone,integer,integer,integer)',
            'public.companion_runtime_get_routine_material(uuid,uuid,uuid,bigint,bigint,text,public.companion_runtime_work_kind,uuid,integer)',
            'public.companion_runtime_prepare_routine_run(uuid,uuid,uuid,bigint,bigint,text,public.companion_runtime_work_kind,uuid,boolean)',
            'public.companion_runtime_project_event_batch_v2(uuid,uuid,uuid,bigint,bigint,text,public.companion_runtime_work_kind,uuid,bigint,text,jsonb,bigint,timestamp with time zone,integer,integer,integer)',
            'public.companion_runtime_record_attempt_outputs(uuid,uuid,uuid,bigint,bigint,text,public.companion_runtime_work_kind,uuid,jsonb,timestamp with time zone)',
            'public.companion_runtime_defer_delete(uuid,uuid,uuid,bigint,bigint,text,public.companion_runtime_work_kind,uuid)',
            'public.companion_runtime_image_request(text,text)',
            'public.companion_runtime_image_get(text)',
            'public.companion_runtime_image_claim(text,text,text)',
            'public.companion_runtime_image_mark_building_box(text,bigint,text)',
            'public.companion_runtime_image_clear_building_box(text,bigint,text)',
            'public.companion_runtime_image_mark_delete_intent(text,bigint,text)',
            'public.companion_runtime_image_mark_delete_operation(text,bigint,text,text)',
            'public.companion_runtime_image_record_ready(text,bigint,text,text)',
            'public.companion_runtime_image_record_failure(text,bigint,text,text)'
          ]) protected(signature)
          where has_function_privilege(${runtimeRole}, protected.signature, 'EXECUTE')
        ) as "callableFunctions",
        has_function_privilege(
          ${runtimeRole}, 'public.companion_runtime_guard_duplicate_cleanup()', 'EXECUTE'
        ) as "helperCallable"
    `;
    expect(acl).toEqual({ privateTableReads: 0, callableFunctions: 27, helperCallable: false });
    await expect(asRuntime((tx) => tx`select * from companion_turn_attempts`))
      .rejects.toThrow(/permission denied/i);

    const runtimeOnlySignatures = [
      "public.companion_runtime_record_material_snapshot(uuid,uuid,uuid,bigint,bigint,text,public.companion_runtime_work_kind,uuid,public.companion_client_surface,timestamp with time zone,text,text)",
      "public.companion_runtime_publish_material_snapshot(uuid,uuid,uuid,bigint,bigint,text,public.companion_runtime_work_kind,uuid,text)",
      "public.companion_runtime_get_routine_material(uuid,uuid,uuid,bigint,bigint,text,public.companion_runtime_work_kind,uuid,integer)",
      "public.companion_runtime_prepare_routine_run(uuid,uuid,uuid,bigint,bigint,text,public.companion_runtime_work_kind,uuid,boolean)",
      "public.companion_runtime_project_event_batch_v2(uuid,uuid,uuid,bigint,bigint,text,public.companion_runtime_work_kind,uuid,bigint,text,jsonb,bigint,timestamp with time zone,integer,integer,integer)",
      "public.companion_runtime_claim_work(text,integer,integer,bigint,integer,integer)",
      "public.companion_runtime_defer_delete(uuid,uuid,uuid,bigint,bigint,text,public.companion_runtime_work_kind,uuid)",
      "public.companion_runtime_image_request(text,text)",
      "public.companion_runtime_image_get(text)",
      "public.companion_runtime_image_claim(text,text,text)",
      "public.companion_runtime_image_mark_building_box(text,bigint,text)",
      "public.companion_runtime_image_clear_building_box(text,bigint,text)",
      "public.companion_runtime_image_mark_delete_intent(text,bigint,text)",
      "public.companion_runtime_image_mark_delete_operation(text,bigint,text,text)",
      "public.companion_runtime_image_record_ready(text,bigint,text,text)",
      "public.companion_runtime_image_record_failure(text,bigint,text,text)",
    ];
    const runtimeOnlyAcl = await sql<Array<{
      signature: string;
      api: boolean;
      worker: boolean;
      runtime: boolean;
    }>>`
      select signature,
        has_function_privilege(${apiRole}, signature, 'EXECUTE') as api,
        has_function_privilege(${workerRole}, signature, 'EXECUTE') as worker,
        has_function_privilege(${runtimeRole}, signature, 'EXECUTE') as runtime
      from unnest(${runtimeOnlySignatures}::text[]) signatures(signature)
      order by signature
    `;
    expect(runtimeOnlyAcl.every((entry) => entry.runtime && !entry.api && !entry.worker)).toBe(true);

    await expect(asRuntime(async (tx) => {
      // SAFETY: The transaction exposes the same `unsafe` execution method required by the role
      // verifier; this test deliberately limits the view to that one method.
      const roleClient = tx as Pick<Sql, "unsafe">;
      await verifyRuntimeDatabaseRole(roleClient, runtimeRole);
    })).resolves.toBeUndefined();

    const [owner] = await sql<Array<{ name: string }>>`
      select current_user::text as name
    `;
    await expect(verifyRuntimeDatabaseRole(sql, owner?.name ?? ""))
      .rejects.toBeInstanceOf(RuntimeDatabaseRoleError);

    const apiSignatures = [
      "public.companion_api_create_companion(uuid,text,text,text,text,jsonb,boolean,jsonb,uuid,smallint,smallint,smallint,smallint)",
      "public.companion_api_update_companion(uuid,uuid,jsonb)",
      "public.companion_api_set_initial_provider(uuid,uuid,text,text)",
      "public.companion_api_set_workspace_access(uuid,uuid,public.companion_share_role)",
      "public.companion_api_update_member_state(uuid,uuid,boolean,boolean,boolean)",
      "public.companion_api_mark_thread_read(uuid,uuid)",
      "public.companion_api_enqueue_turn(uuid,uuid,uuid,text,public.companion_client_surface,jsonb,uuid,text,uuid,text)",
      "public.companion_api_read_attachment(uuid,uuid,uuid)",
      "public.companion_api_read_runtime(uuid,uuid)",
      "public.companion_api_list_runtime(uuid)",
      "public.companion_api_read_thread(uuid,uuid)",
      "public.companion_api_sync_thread(uuid,uuid)",
      "public.companion_api_enqueue_operation(uuid,uuid,uuid,public.companion_operation_kind,public.companion_client_surface)",
      "public.companion_api_cancel_turn(uuid,uuid,uuid)",
      "public.companion_api_answer_decision(uuid,uuid,text,text,text)",
      "public.companion_api_answer_config_decision(uuid,uuid,text,text)",
      "public.companion_api_answer_routine_decision(uuid,uuid,text,text,uuid,timestamp with time zone)",
      "public.companion_api_get_decision(uuid,uuid,text)",
      "public.companion_api_bump_skill_revision(uuid,uuid)",
      "public.companion_api_list_routines(uuid,uuid)",
      "public.companion_api_create_routine(uuid,uuid,uuid,text,text,text,text,boolean,timestamp with time zone)",
      "public.companion_api_update_routine(uuid,uuid,uuid,text,text,text,text,boolean,timestamp with time zone)",
      "public.companion_api_delete_routine(uuid,uuid,uuid)",
      "public.companion_api_answer_trigger_decision(uuid,uuid,text,text,uuid,text)",
      "public.companion_api_lock_selected_mcp_account(uuid,uuid,uuid)",
      "public.companion_api_list_triggers(uuid,uuid)",
      "public.companion_api_create_trigger(uuid,uuid,uuid,text,text,text,text,boolean)",
      "public.companion_api_update_trigger(uuid,uuid,uuid,text,text,text,boolean)",
      "public.companion_api_list_trigger_provider_accounts(uuid)",
      "public.companion_api_rotate_trigger_secret(uuid,uuid,uuid,text)",
      "public.companion_api_delete_trigger(uuid,uuid,uuid)",
      "public.companion_webhook_get_trigger(uuid)",
      "public.companion_api_fire_trigger(uuid,uuid,uuid,text)",
      "public.companion_api_fail_trigger_fire(uuid,uuid,text,text)",
    ];
    const apiAcl = await sql<Array<{
      signature: string;
      api: boolean;
      worker: boolean;
      runtime: boolean;
    }>>`
      select signature,
        has_function_privilege(${apiRole}, signature, 'EXECUTE') as api,
        has_function_privilege(${workerRole}, signature, 'EXECUTE') as worker,
        has_function_privilege(${runtimeRole}, signature, 'EXECUTE') as runtime
      from unnest(${apiSignatures}::text[]) signatures(signature)
      order by signature
    `;
    expect(apiAcl).toHaveLength(apiSignatures.length);
    expect(apiAcl.every((entry) => entry.api && !entry.worker && !entry.runtime)).toBe(true);

    const [apiIsolation] = await sql<Array<{
      privateTableReads: number;
      helperCallable: boolean;
    }>>`
      select
        (
          select count(*)::int from unnest(array[
            'companion_runtime_instances', 'companion_turns', 'companion_turn_attempts',
            'companion_operations', 'companion_decision_deliveries',
            'companion_runtime_leases', 'companion_routines'
          ]) protected(table_name)
          where has_table_privilege(${apiRole}, 'public.' || protected.table_name, 'SELECT')
        ) as "privateTableReads",
        has_function_privilege(
          ${apiRole}, 'public.companion_api_actor(uuid)', 'EXECUTE'
        ) as "helperCallable"
    `;
    expect(apiIsolation).toEqual({ privateTableReads: 0, helperCallable: false });

    const workerRoutineSignatures = [
      "public.companion_claim_due_routines(text,integer,integer)",
      "public.companion_fire_routine(text,uuid,uuid,uuid,timestamp with time zone,timestamp with time zone)",
      "public.companion_fail_routine_fire(text,uuid,uuid,text,text,timestamp with time zone)",
    ];
    const workerRoutineAcl = await sql<Array<{
      signature: string;
      api: boolean;
      worker: boolean;
      runtime: boolean;
    }>>`
      select signature,
        has_function_privilege(${apiRole}, signature, 'EXECUTE') as api,
        has_function_privilege(${workerRole}, signature, 'EXECUTE') as worker,
        has_function_privilege(${runtimeRole}, signature, 'EXECUTE') as runtime
      from unnest(${workerRoutineSignatures}::text[]) signatures(signature)
      order by signature
    `;
    expect(workerRoutineAcl).toHaveLength(workerRoutineSignatures.length);
    expect(workerRoutineAcl.every((entry) => entry.worker && !entry.api && !entry.runtime)).toBe(true);
  });

  it("lists member-wide trigger provider accounts without exposing private trigger rows", async () => {
    if (!sql) throw new Error("runtime executor database is not initialized");
    const providerAccountId = randomUUID();
    const triggerId = randomUUID();
    const companion = await createCompanion();
    try {
      await sql`
        insert into companion_trigger_provider_accounts(
          id, org_id, owner_id, provider, label, credential_source, mcp_account_id
        ) values (
          ${providerAccountId}::uuid, ${ids.orgA}::uuid, ${ids.ownerA},
          'github', 'Runtime GitHub', 'mcp_oauth', ${ids.mcpAccount}::uuid
        )
      `;
      await sql`
        insert into companion_triggers(
          id, org_id, companion_id, name, prompt, mode, provider,
          provider_account_id, secret, created_by
        ) values (
          ${triggerId}::uuid, ${ids.orgA}::uuid, ${companion.companionId}::uuid,
          'Runtime account count', 'Notify the owner.', 'notify', 'github',
          ${providerAccountId}::uuid, ${"a".repeat(64)}, ${ids.ownerA}
        )
      `;

      const [acl] = await sql<Array<{ canReadTriggers: boolean; canListAccounts: boolean }>>`
        select
          has_table_privilege(${apiRole}, 'public.companion_triggers', 'SELECT')
            as "canReadTriggers",
          has_function_privilege(
            ${apiRole}, 'public.companion_api_list_trigger_provider_accounts(uuid)', 'EXECUTE'
          ) as "canListAccounts"
      `;
      expect(acl).toEqual({ canReadTriggers: false, canListAccounts: true });

      const serviceSql = postgres(runtimeUrl.toString(), { max: 1 });
      let accounts;
      try {
        const apiDatabase = drizzle(serviceSql, { schema }) as Db;
        accounts = await apiDatabase.transaction(async (transaction) => {
          await transaction.execute(drizzleSql.raw(`set local role ${apiRole}`));
          await transaction.execute(drizzleSql`select
            set_config('app.org_id', ${ids.orgA}, true),
            set_config('app.user_id', ${ids.ownerA}, true)
          `);
          return listCompanionTriggerProviderAccounts({
            actor: {
              id: ids.ownerA,
              email: `${ids.ownerA}@example.test`,
              name: "Runtime executor actor 0",
            },
            orgId: ids.orgA,
            database: transaction as unknown as Db,
          });
        });
      } finally {
        await serviceSql.end({ timeout: 1 });
      }
      expect(accounts).toHaveLength(1);
      expect(accounts[0]).toMatchObject({
        id: providerAccountId,
        provider: "github",
        label: "Runtime GitHub",
        credential_source: "mcp_oauth",
        mcp_account_id: ids.mcpAccount,
        status: "connected",
        dependent_trigger_count: 1,
      });
      await expect(asApi({
        orgId: ids.orgA,
        actorId: ids.ownerA,
        action: (tx) => tx`select id from public.companion_triggers`,
      })).rejects.toThrow(/permission denied/i);
      await expect(asApi({
        orgId: ids.orgA,
        actorId: ids.ownerB,
        action: (tx) => tx`
          select account from public.companion_api_list_trigger_provider_accounts(${ids.orgA}::uuid)
        `,
      })).rejects.toThrow(/not a workspace member/i);
    } finally {
      await removeCompanion(companion.companionId);
      await sql`
        delete from companion_trigger_provider_accounts where id = ${providerAccountId}::uuid
      `;
    }
  });

  it("persists the restart Box skill-update checkpoint before provider restart", async () => {
    if (!sql) throw new Error("runtime executor database is not initialized");
    const fixture = await createCompanion({
      boxReady: true,
      selectedSkillIds: [],
      selectedMcpAccountIds: [],
    });
    const restartExecutor = `${executorId}-restart-box`;
    let claim: Claim | undefined;
    try {
      await sql`
        update companion_turn_attempts set status = 'cancelled', settled_at = now()
        where id = ${fixture.attemptId}::uuid
      `;
      await sql`
        update companion_turns set status = 'cancelled', settled_at = now(),
          inactivity_deadline_at = null
        where id = ${fixture.turnId}::uuid
      `;

      const [enqueued] = await asApi({
        orgId: ids.orgA,
        actorId: ids.ownerA,
        action: (tx) => tx<Array<{ operation: { id: string } }>>`
          select * from public.companion_api_enqueue_operation(
            ${ids.orgA}::uuid, ${fixture.companionId}::uuid, ${randomUUID()}::uuid,
            'restart_box', 'web'
          )
        `,
      });
      if (!enqueued) throw new Error("expected restart Box operation");

      [claim] = await claimWorkRows(1, restartExecutor);
      expect(claim).toMatchObject({
        workKind: "operation",
        workId: enqueued.operation.id,
        checkpoint: "pending",
        checkpointSequence: "0",
      });
      if (!claim) throw new Error("expected restart Box claim");
      const restartClaim = claim;

      const [skillUpdate] = await asRuntime((tx) => tx<Array<{ sequence: string | null }>>`
        select public.companion_runtime_checkpoint(
          ${restartClaim.orgId}::uuid, ${restartClaim.companionId}::uuid,
          ${restartClaim.claimToken}::uuid, ${restartClaim.claimEpoch}::bigint,
          ${restartClaim.gateEpoch}::bigint, ${restartExecutor}, 'operation',
          ${restartClaim.workId}::uuid, ${restartClaim.checkpointSequence}::bigint,
          'skills_updated', null, null, null, null, null, null, null, null
        )::text as sequence
      `);
      expect(skillUpdate?.sequence).toBe("1");

      const [providerRestart] = await asRuntime((tx) => tx<Array<{ sequence: string | null }>>`
        select public.companion_runtime_checkpoint(
          ${restartClaim.orgId}::uuid, ${restartClaim.companionId}::uuid,
          ${restartClaim.claimToken}::uuid, ${restartClaim.claimEpoch}::bigint,
          ${restartClaim.gateEpoch}::bigint, ${restartExecutor}, 'operation',
          ${restartClaim.workId}::uuid, 1, 'restarting_box',
          null, null, null, null, null, null, null, null
        )::text as sequence
      `);
      expect(providerRestart?.sequence).toBe("2");

      const [operation] = await sql<Array<{ checkpoint: string; sequence: string }>>`
        select checkpoint, checkpoint_sequence::text as sequence
        from companion_operations where id = ${restartClaim.workId}::uuid
      `;
      expect(operation).toEqual({ checkpoint: "restarting_box", sequence: "2" });
    } finally {
      if (claim) await release(claim, restartExecutor);
      await removeCompanion(fixture.companionId);
    }
  });

  it("serializes image builds, fences outcomes, applies backoff, and re-arms exhausted failures", async () => {
    if (!sql) throw new Error("runtime executor database is not initialized");
    const database = sql;
    const digest = `image-registry-${suffix}`;
    const imageName = `companion-l14-${suffix.slice(0, 12)}`;
    const otherDigest = `other-image-registry-${suffix}`;
    const otherImageName = `companion-l14-other${suffix.slice(0, 7)}`;

    try {
      await asRuntime((tx) => tx`
        select * from public.companion_runtime_image_request(${otherDigest}, ${otherImageName})
      `);
      const requested = await asRuntime((tx) => tx<Array<{
        status: string;
        attemptCount: number;
      }>>`
        select status::text as status, attempt_count as "attemptCount"
        from public.companion_runtime_image_request(${digest}, ${imageName})
      `);
      expect(requested).toEqual([{ status: "requested", attemptCount: 0 }]);

      const concurrentClaims = await Promise.all([
        asRuntime((tx) => tx<Array<{ claimEpoch: string; attemptCount: number }>>`
          select image_claim_epoch::text as "claimEpoch",
            image_attempt_count as "attemptCount"
          from public.companion_runtime_image_claim(
            'image-builder-a', ${digest}, ${imageName}
          )
        `),
        asRuntime((tx) => tx<Array<{ claimEpoch: string; attemptCount: number }>>`
          select image_claim_epoch::text as "claimEpoch",
            image_attempt_count as "attemptCount"
          from public.companion_runtime_image_claim(
            'image-builder-b', ${digest}, ${imageName}
          )
        `),
      ]);
      const firstClaim = concurrentClaims.find((claim) => claim.length === 1)?.[0];
      expect(concurrentClaims.map((claim) => claim.length).sort()).toEqual([0, 1]);
      expect(firstClaim).toEqual({ claimEpoch: "1", attemptCount: 1 });
      const [unrelated] = await database<Array<{ status: string; attemptCount: number }>>`
        select status::text as status, attempt_count as "attemptCount"
        from companion_images where digest = ${otherDigest}
      `;
      expect(unrelated).toEqual({ status: "requested", attemptCount: 0 });

      const staleMark = await asRuntime((tx) => tx<Array<{ marked: boolean }>>`
        select public.companion_runtime_image_mark_building_box(
          ${digest}, 0, 'bx_stale'
        ) as marked
      `);
      expect(staleMark).toEqual([{ marked: false }]);
      const marked = await asRuntime((tx) => tx<Array<{ marked: boolean }>>`
        select public.companion_runtime_image_mark_building_box(
          ${digest}, ${firstClaim?.claimEpoch ?? "0"}::bigint, 'bx_baker01'
        ) as marked
      `);
      expect(marked).toEqual([{ marked: true }]);

      const staleOutcome = await asRuntime((tx) => tx<Array<{ outcome: string }>>`
        select public.companion_runtime_image_record_failure(
          ${digest}, 0, 'image_build_failed', 'stale writer'
        ) as outcome
      `);
      expect(staleOutcome).toEqual([{ outcome: "lease_lost" }]);
      const failedAttempt = await asRuntime((tx) => tx<Array<{ outcome: string }>>`
        select public.companion_runtime_image_record_failure(
          ${digest}, ${firstClaim?.claimEpoch ?? "0"}::bigint,
          'image_build_failed', 'provider unavailable'
        ) as outcome
      `);
      expect(failedAttempt).toEqual([{ outcome: "requested" }]);

      const [retryState] = await database<Array<{
        status: string;
        attemptCount: number;
        backoffSeconds: number;
        buildBoxId: string | null;
        buildDeleteIntentRecorded: boolean;
        buildDeleteOperationId: string | null;
      }>>`
        select status::text as status, attempt_count as "attemptCount",
          extract(epoch from (next_attempt_at - updated_at))::int as "backoffSeconds",
          build_box_id as "buildBoxId",
          build_delete_intent_at is not null as "buildDeleteIntentRecorded",
          build_delete_operation_id as "buildDeleteOperationId"
        from companion_images where digest = ${digest}
      `;
      expect(retryState).toEqual({
        status: "requested",
        attemptCount: 1,
        backoffSeconds: 30,
        buildBoxId: "bx_baker01",
        buildDeleteIntentRecorded: false,
        buildDeleteOperationId: null,
      });
      const earlyRetry = await asRuntime((tx) => tx<Array<{ attemptCount: number }>>`
        select image_attempt_count as "attemptCount"
        from public.companion_runtime_image_claim(
          'image-builder-too-early', ${digest}, ${imageName}
        )
      `);
      expect(earlyRetry).toEqual([]);

      await database`
        update companion_images set next_attempt_at = now() - interval '1 second'
        where digest = ${digest}
      `;
      const [cleanupClaim] = await asRuntime((tx) => tx<Array<{
        claimEpoch: string;
        attemptCount: number;
        buildBoxId: string | null;
        buildDeleteIntentRecorded: boolean;
        buildDeleteOperationId: string | null;
        recoveryOnly: boolean;
      }>>`
        select image_claim_epoch::text as "claimEpoch",
          image_attempt_count as "attemptCount",
          image_build_box_id as "buildBoxId",
          image_build_delete_intent_recorded as "buildDeleteIntentRecorded",
          image_build_delete_operation_id as "buildDeleteOperationId",
          image_recovery_only as "recoveryOnly"
        from public.companion_runtime_image_claim(
          'image-builder-cleanup', ${digest}, ${imageName}
        )
      `);
      expect(cleanupClaim).toEqual({
        claimEpoch: "2",
        attemptCount: 2,
        buildBoxId: "bx_baker01",
        buildDeleteIntentRecorded: false,
        buildDeleteOperationId: null,
        recoveryOnly: false,
      });
      const staleClear = await asRuntime((tx) => tx<Array<{ cleared: boolean }>>`
        select public.companion_runtime_image_clear_building_box(
          ${digest}, 1, 'bx_baker01'
        ) as cleared
      `);
      expect(staleClear).toEqual([{ cleared: false }]);
      const deletionIntentMarked = await asRuntime((tx) => tx<Array<{ marked: boolean }>>`
        select public.companion_runtime_image_mark_delete_intent(
          ${digest}, ${cleanupClaim?.claimEpoch ?? "0"}::bigint, 'bx_baker01'
        ) as marked
      `);
      expect(deletionIntentMarked).toEqual([{ marked: true }]);
      const deletionMarked = await asRuntime((tx) => tx<Array<{ marked: boolean }>>`
        select public.companion_runtime_image_mark_delete_operation(
          ${digest}, ${cleanupClaim?.claimEpoch ?? "0"}::bigint, 'bx_baker01',
          'bdop_00000000000000000000000000000001'
        ) as marked
      `);
      expect(deletionMarked).toEqual([{ marked: true }]);
      const cleared = await asRuntime((tx) => tx<Array<{ cleared: boolean }>>`
        select public.companion_runtime_image_clear_building_box(
          ${digest}, ${cleanupClaim?.claimEpoch ?? "0"}::bigint, 'bx_baker01'
        ) as cleared
      `);
      expect(cleared).toEqual([{ cleared: true }]);
      await asRuntime((tx) => tx`
        select public.companion_runtime_image_record_failure(
          ${digest}, ${cleanupClaim?.claimEpoch ?? "0"}::bigint,
          'image_build_failed', 'second failure'
        )
      `);

      await database`
        update companion_images
        set status = 'building', attempt_count = 4, build_box_id = 'bx_terminal01',
          build_delete_intent_at = now(),
          build_delete_operation_id = 'bdop_00000000000000000000000000000002',
          claim_actor_id = 'crashed-builder', claim_epoch = 9,
          claimed_at = now() - interval '31 minutes',
          lease_expires_at = now() - interval '1 minute'
        where digest = ${digest}
      `;
      const [terminalRecovery] = await asRuntime((tx) => tx<Array<{
        claimEpoch: string;
        attemptCount: number;
        buildBoxId: string | null;
        buildDeleteIntentRecorded: boolean;
        buildDeleteOperationId: string | null;
        recoveryOnly: boolean;
      }>>`
        select image_claim_epoch::text as "claimEpoch",
          image_attempt_count as "attemptCount",
          image_build_box_id as "buildBoxId",
          image_build_delete_intent_recorded as "buildDeleteIntentRecorded",
          image_build_delete_operation_id as "buildDeleteOperationId",
          image_recovery_only as "recoveryOnly"
        from public.companion_runtime_image_claim(
          'image-builder-terminal-recovery', ${digest}, ${imageName}
        )
      `);
      expect(terminalRecovery).toEqual({
        claimEpoch: "10",
        attemptCount: 4,
        buildBoxId: "bx_terminal01",
        buildDeleteIntentRecorded: true,
        buildDeleteOperationId: "bdop_00000000000000000000000000000002",
        recoveryOnly: true,
      });
      await asRuntime((tx) => tx`
        select public.companion_runtime_image_clear_building_box(
          ${digest}, ${terminalRecovery?.claimEpoch ?? "0"}::bigint, 'bx_terminal01'
        )
      `);
      await asRuntime((tx) => tx`
        select public.companion_runtime_image_record_failure(
          ${digest}, ${terminalRecovery?.claimEpoch ?? "0"}::bigint,
          'image_build_interrupted', 'terminal recovery settled'
        )
      `);

      await database`
        update companion_images set updated_at = now() - interval '11 minutes'
        where digest = ${digest}
      `;
      const rearmed = await asRuntime((tx) => tx<Array<{
        status: string;
        attemptCount: number;
        errorCode: string | null;
      }>>`
        select status::text as status, attempt_count as "attemptCount",
          last_error_code as "errorCode"
        from public.companion_runtime_image_request(${digest}, ${imageName})
      `);
      expect(rearmed).toEqual([{ status: "requested", attemptCount: 0, errorCode: null }]);

      const reclaimed = await asRuntime((tx) => tx<Array<{ attemptCount: number }>>`
        select image_attempt_count as "attemptCount"
        from public.companion_runtime_image_claim(
          'image-builder-c', ${digest}, ${imageName}
        )
      `);
      expect(reclaimed).toEqual([{ attemptCount: 1 }]);
    } finally {
      await database`delete from companion_images where digest in (${digest}, ${otherDigest})`;
    }
  });

  it("fires a due Companion routine once and skips missed or piled-up instants", async () => {
    if (!sql) throw new Error("runtime executor database is not initialized");
    // No shared Skill or MCP account: this fixture outlives nothing, but org-wide revision bumps
    // count every Companion that selects the resource, and routines do not exercise that path.
    const fixture = await createCompanion({
      workspaceRole: "viewer",
      selectedSkillIds: [],
      selectedMcpAccountIds: [],
    });
    try {
    const missedId = randomUUID();
    const standupId = randomUUID();
    const nextFire = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const create = (routineId: string, name: string) => asApi({
      orgId: ids.orgA,
      actorId: ids.ownerA,
      action: (tx: Tx) => tx`
        select public.companion_api_create_routine(
          ${ids.orgA}::uuid, ${fixture.companionId}::uuid, ${routineId}::uuid,
          ${name}, 'Write the standup.', '0 9 * * 1-5', 'UTC', true,
          ${nextFire}::timestamptz
        ) as routine
      `,
    });
    await create(missedId, "Missed");
    await create(standupId, "Standup");
    await expect(asApi({
      orgId: ids.orgA,
      actorId: ids.viewerA,
      action: (tx) => tx`
        select public.companion_api_create_routine(
          ${ids.orgA}::uuid, ${fixture.companionId}::uuid, ${randomUUID()}::uuid,
          'Viewer', 'Write the standup.', '0 9 * * 1-5', 'UTC', true,
          ${nextFire}::timestamptz
        )
      `,
    })).rejects.toMatchObject({ code: "42501" });

    await sql`
      update companion_routines
      set next_fire_at = now() - interval '15 minutes'
      where id = ${missedId}::uuid
    `;
    const missedClaim = await asWorker((tx) => tx<Array<{
      routineId: string;
      scheduledFor: Date;
    }>>`
      select routine_id::text as "routineId", scheduled_for as "scheduledFor"
      from public.companion_claim_due_routines('routine-worker', 25, 60)
    `);
    expect(missedClaim).toEqual([expect.objectContaining({ routineId: missedId })]);
    const missedFire = await asWorker((tx) => tx<Array<{ outcome: string }>>`
      select outcome
      from public.companion_fire_routine(
        'routine-worker', ${ids.orgA}::uuid, ${missedId}::uuid, ${randomUUID()}::uuid,
        ${new Date(missedClaim[0]!.scheduledFor).toISOString()}::timestamptz,
        now() + interval '1 hour'
      )
    `);
    expect(missedFire).toEqual([{ outcome: "skipped_missed" }]);

    await sql`
      update companion_routines
      set next_fire_at = now() - interval '1 second'
      where id = ${standupId}::uuid
    `;
    const due = await asWorker((tx) => tx<Array<{
      routineId: string;
      scheduledFor: Date;
    }>>`
      select routine_id::text as "routineId", scheduled_for as "scheduledFor"
      from public.companion_claim_due_routines('routine-worker', 25, 60)
    `);
    expect(due).toEqual([expect.objectContaining({ routineId: standupId })]);
    const fired = await asWorker((tx) => tx<Array<{
      outcome: string;
      replayed: boolean;
    }>>`
      select outcome, replayed
      from public.companion_fire_routine(
        'routine-worker', ${ids.orgA}::uuid, ${standupId}::uuid, ${randomUUID()}::uuid,
        ${new Date(due[0]!.scheduledFor).toISOString()}::timestamptz,
        now() + interval '1 hour'
      )
    `);
    expect(fired).toEqual([{ outcome: "fired", replayed: false }]);

    await sql`
      update companion_routines
      set next_fire_at = now() - interval '1 second', claimed_by = null, lease_expires_at = null
      where id = ${standupId}::uuid
    `;
    const piled = await asWorker((tx) => tx<Array<{
      routineId: string;
      scheduledFor: Date;
    }>>`
      select routine_id::text as "routineId", scheduled_for as "scheduledFor"
      from public.companion_claim_due_routines('routine-worker', 25, 60)
    `);
    expect(piled).toEqual([expect.objectContaining({ routineId: standupId })]);
    const skipped = await asWorker((tx) => tx<Array<{ outcome: string }>>`
      select outcome
      from public.companion_fire_routine(
        'routine-worker', ${ids.orgA}::uuid, ${standupId}::uuid, ${randomUUID()}::uuid,
        ${new Date(piled[0]!.scheduledFor).toISOString()}::timestamptz,
        now() + interval '1 hour'
      )
    `);
    expect(skipped).toEqual([{ outcome: "skipped_pileup" }]);
    } finally {
      await sql`delete from companion_routines where companion_id = ${fixture.companionId}::uuid`;
      await removeCompanion(fixture.companionId);
    }
  });

  it("atomically accepts only one initial provider selection", async () => {
    if (!sql) throw new Error("runtime executor database is not initialized");
    const database = sql;
    const [created] = await asApi({
      orgId: ids.orgA,
      actorId: ids.ownerA,
      action: (tx) => tx<Array<{ companionId: string }>>`
        select companion_id::text as "companionId"
        from public.companion_api_create_companion(
          ${ids.orgA}::uuid,
          'Atomic initial provider',
          null::text,
          null::text,
          null::text,
          '[]'::jsonb,
          false,
          '[]'::jsonb,
          null::uuid
        )
      `,
    });
    if (!created) throw new Error("failed to create the initial-provider fixture");

    try {
      await database`
        insert into companion_workspace_access(
          org_id, companion_id, owner_id, role, granted_by
        ) values (
          ${ids.orgA}::uuid, ${created.companionId}::uuid, ${ids.ownerA}, 'editor', ${ids.ownerA}
        )
      `;
      await expect(asApi({
        orgId: ids.orgA,
        actorId: ids.editorA,
        action: (tx) => tx`
          select * from public.companion_api_set_initial_provider(
            ${ids.orgA}::uuid,
            ${created.companionId}::uuid,
            ${providerId},
            'editor-model'
          )
        `,
      })).rejects.toMatchObject({ code: "42501" });

      const attempts = await Promise.allSettled([
        asApi({
          orgId: ids.orgA,
          actorId: ids.ownerA,
          action: (tx) => tx`
            select * from public.companion_api_set_initial_provider(
              ${ids.orgA}::uuid,
              ${created.companionId}::uuid,
              ${providerId},
              'fixture-model-a'
            )
          `,
        }),
        asApi({
          orgId: ids.orgA,
          actorId: ids.ownerA,
          action: (tx) => tx`
            select * from public.companion_api_set_initial_provider(
              ${ids.orgA}::uuid,
              ${created.companionId}::uuid,
              ${providerId},
              'fixture-model-b'
            )
          `,
        }),
      ]);

      expect(attempts.map((attempt) => attempt.status).sort()).toEqual([
        "fulfilled",
        "rejected",
      ]);
      const rejected = attempts.find((attempt) => attempt.status === "rejected");
      if (!rejected || rejected.status !== "rejected") {
        throw new Error("expected one conflicting provider selection");
      }
      expect(rejected.reason).toMatchObject({ code: "55000" });

      const [stored] = await database<Array<{
        providerIds: string[];
        modelId: string;
        settingsRevision: string;
        auditCount: number;
      }>>`
        select companion.provider_ids as "providerIds", companion.model_id as "modelId",
          instance.desired_settings_revision::text as "settingsRevision",
          (
            select count(*)::int from audit_log audit
            where audit.org_id = companion.org_id
              and audit.target_id = companion.id::text
              and audit.action = 'companion.settings.updated'
          ) as "auditCount"
        from companions companion
        join companion_runtime_instances instance
          on instance.org_id = companion.org_id and instance.companion_id = companion.id
        where companion.org_id = ${ids.orgA}::uuid
          and companion.id = ${created.companionId}::uuid
      `;
      expect(stored?.providerIds).toEqual([providerId]);
      expect(["fixture-model-a", "fixture-model-b"]).toContain(stored?.modelId);
      expect(stored).toMatchObject({ settingsRevision: "2", auditCount: 1 });
    } finally {
      await database`
        delete from audit_log
        where org_id = ${ids.orgA}::uuid and target_id = ${created.companionId}
      `;
      await removeCompanion(created.companionId);
    }
  });

  it("keeps Companion aggregate DML behind API capabilities even with a forged protocol GUC", async () => {
    if (!sql) throw new Error("runtime executor database is not initialized");
    const capabilityTables = [
      "companions",
      "companion_workspace_access",
      "companion_member_state",
      "companion_threads",
      "companion_transcript_entries",
    ];
    const workerForbiddenTables = [
      ...capabilityTables,
      "companion_provider_connections",
      "companion_mcp_accounts",
    ];
    const tableAcl = await sql<Array<{
      tableName: string;
      apiSelect: boolean;
      apiInsert: boolean;
      apiUpdate: boolean;
      apiDelete: boolean;
      workerSelect: boolean;
      workerInsert: boolean;
      workerUpdate: boolean;
      workerDelete: boolean;
    }>>`
      select table_name as "tableName",
        has_table_privilege(${apiRole}, 'public.' || table_name, 'SELECT') as "apiSelect",
        has_table_privilege(${apiRole}, 'public.' || table_name, 'INSERT') as "apiInsert",
        has_table_privilege(${apiRole}, 'public.' || table_name, 'UPDATE') as "apiUpdate",
        has_table_privilege(${apiRole}, 'public.' || table_name, 'DELETE') as "apiDelete",
        has_table_privilege(${workerRole}, 'public.' || table_name, 'SELECT') as "workerSelect",
        has_table_privilege(${workerRole}, 'public.' || table_name, 'INSERT') as "workerInsert",
        has_table_privilege(${workerRole}, 'public.' || table_name, 'UPDATE') as "workerUpdate",
        has_table_privilege(${workerRole}, 'public.' || table_name, 'DELETE') as "workerDelete"
      from unnest(${workerForbiddenTables}::text[]) tables(table_name)
      order by table_name
    `;
    expect(tableAcl).toHaveLength(workerForbiddenTables.length);
    for (const acl of tableAcl) {
      if (capabilityTables.includes(acl.tableName)) {
        expect(acl.apiSelect, `${acl.tableName} remains an API read projection`).toBe(true);
        expect(
          [acl.apiInsert, acl.apiUpdate, acl.apiDelete],
          `${acl.tableName} API writes require a capability function`,
        ).toEqual([false, false, false]);
      }
      expect(
        [acl.workerSelect, acl.workerInsert, acl.workerUpdate, acl.workerDelete],
        `${acl.tableName} is outside the worker boundary`,
      ).toEqual([false, false, false, false]);
    }

    const directDml = capabilityTables.flatMap((table) => [
      `insert into public.${table} default values`,
      `update public.${table} set org_id = org_id where false`,
      `delete from public.${table} where false`,
    ]);
    for (const role of [apiRole, workerRole]) {
      for (const statement of directDml) {
        await expect(asApplicationRoleWithForgedProtocol({
          role,
          action: (tx) => tx.unsafe(statement),
        })).rejects.toThrow(/permission denied/i);
      }
    }

    let companionId = "";
    try {
      const created = await asApi({
        orgId: ids.orgA,
        actorId: ids.ownerA,
        action: (tx) => tx<Array<{ companionId: string }>>`
          select companion_id::text as "companionId"
          from public.companion_api_create_companion(
            ${ids.orgA}::uuid, 'Capability-only fixture', ${null}::text,
            ${null}::text, ${null}::text, '[]'::jsonb, false, '[]'::jsonb, ${null}::uuid
          )
        `,
      });
      companionId = created[0]?.companionId ?? "";
      expect(companionId).toMatch(/^[0-9a-f-]{36}$/);

      const sharing = await asApi({
        orgId: ids.orgA,
        actorId: ids.ownerA,
        action: (tx) => tx<Array<{ role: string }>>`
          select workspace_role::text as role
          from public.companion_api_set_workspace_access(
            ${ids.orgA}::uuid, ${companionId}::uuid, 'editor'
          )
        `,
      });
      expect(sharing).toEqual([{ role: "editor" }]);

      const memberState = await asApi({
        orgId: ids.orgA,
        actorId: ids.ownerA,
        action: (tx) => tx<Array<{ hidden: boolean }>>`
          select hidden
          from public.companion_api_update_member_state(
            ${ids.orgA}::uuid, ${companionId}::uuid, ${null}::boolean, true, ${null}::boolean
          )
        `,
      });
      expect(memberState).toEqual([{ hidden: true }]);

      const clientMessageId = randomUUID();
      const enqueued = await asApi({
        orgId: ids.orgA,
        actorId: ids.ownerA,
        action: (tx) => tx<Array<{ turn: { client_message_id: string }; replayed: boolean }>>`
          select turn, replayed
          from public.companion_api_enqueue_turn(
            ${ids.orgA}::uuid, ${companionId}::uuid, ${clientMessageId}::uuid,
            'Capability-backed send', 'web', '[]'::jsonb
          )
        `,
      });
      expect(enqueued).toEqual([{
        turn: expect.objectContaining({ client_message_id: clientMessageId }),
        replayed: false,
      }]);
    } finally {
      if (companionId) await removeCompanion(companionId);
    }
  });

  it("carries a send's attachments through replay, projection, and the executor's material", async () => {
    if (!sql) throw new Error("runtime executor database is not initialized");
    const created = await asApi({
      orgId: ids.orgA,
      actorId: ids.ownerA,
      action: (tx) => tx<Array<{ companionId: string }>>`
        select companion_id::text as "companionId"
        from public.companion_api_create_companion(
          ${ids.orgA}::uuid, 'Attachment fixture', null,
          ${null}::text, ${null}::text, ${tx.json([])}::jsonb,
          false, ${tx.json([])}::jsonb
        )
      `,
    });
    const companionId = created[0]!.companionId;
    try {
    const clientMessageId = randomUUID();
    const attachments = [
      {
        storage_key: `companion-attachments/${ids.orgA}/${companionId}/${clientMessageId}/0-${"a".repeat(64)}`,
        content_type: "image/png",
        byte_size: 2048,
        sha256: "a".repeat(64),
        filename: "chart.png",
        position: 0,
      },
      {
        storage_key: `companion-attachments/${ids.orgA}/${companionId}/${clientMessageId}/1-${"b".repeat(64)}`,
        content_type: "application/pdf",
        byte_size: 4096,
        sha256: "b".repeat(64),
        filename: "report.pdf",
        position: 1,
      },
    ];
    type AttachmentInput = (typeof attachments)[number];
    const enqueue = (list: AttachmentInput[]) => asApi({
      orgId: ids.orgA,
      actorId: ids.ownerA,
      action: (tx) => tx<Array<{ replayed: boolean }>>`
        select replayed from public.companion_api_enqueue_turn(
          ${ids.orgA}::uuid, ${companionId}::uuid, ${clientMessageId}::uuid,
          'Look at these', 'web', ${tx.json(list)}::jsonb
        )
      `,
    });

    expect((await enqueue(attachments))[0]?.replayed).toBe(false);
    // Identical bytes are the same intent however many times the request arrives, and no second row
    // is written for them.
    expect((await enqueue(attachments))[0]?.replayed).toBe(true);
    const [rowCount] = await sql<Array<{ count: number }>>`
      select count(*)::int as count from companion_message_attachments
      where companion_id = ${companionId}::uuid
    `;
    expect(rowCount?.count).toBe(2);

    // A different file at the same position is a different message, and says so.
    await expect(enqueue([{ ...attachments[0]!, sha256: "c".repeat(64) }, attachments[1]!]))
      .rejects.toMatchObject({ code: "23505" });
    await expect(enqueue([attachments[0]!])).rejects.toMatchObject({ code: "23505" });

    // The reader's projection carries metadata and an id, and never a storage key.
    const thread = await asApi({
      orgId: ids.orgA,
      actorId: ids.ownerA,
      action: (tx) => tx<Array<{ entries: Array<IntegrationJsonObject> }>>`
        select entries from public.companion_api_read_thread(
          ${ids.orgA}::uuid, ${companionId}::uuid
        )
      `,
    });
    // SAFETY: The SQL projection is the JSONB attachment array returned by the API read function.
    const projected = thread[0]!.entries[0]!.attachments as Array<IntegrationJsonObject>;
    expect(projected).toEqual([
      expect.objectContaining({
        kind: "user_upload",
        content_type: "image/png",
        filename: "chart.png",
        byte_size: 2048,
        position: 0,
      }),
      expect.objectContaining({ content_type: "application/pdf", filename: "report.pdf", position: 1 }),
    ]);
    expect(JSON.stringify(projected)).not.toContain("companion-attachments/");

    // The read route re-authorizes on every request: an Editor may read, a non-member may not.
    const attachmentId = stringValue(projected[0]?.id);
    if (!attachmentId) throw new Error("projected attachment has no id");
    const asset = await asApi({
      orgId: ids.orgA,
      actorId: ids.ownerA,
      action: (tx) => tx<Array<{ storage_key: string; filename: string }>>`
        select storage_key, filename from public.companion_api_read_attachment(
          ${ids.orgA}::uuid, ${companionId}::uuid, ${attachmentId}::uuid
        )
      `,
    });
    expect(asset[0]?.storage_key).toBe(attachments[0]!.storage_key);
    await expect(asApi({
      orgId: ids.orgA,
      actorId: ids.ownerB,
      action: (tx) => tx`
        select * from public.companion_api_read_attachment(
          ${ids.orgA}::uuid, ${companionId}::uuid, ${attachmentId}::uuid
        )
      `,
    })).rejects.toThrow();
    await expect(asApi({
      orgId: ids.orgB,
      actorId: ids.ownerB,
      action: (tx) => tx`
        select * from public.companion_api_read_attachment(
          ${ids.orgB}::uuid, ${companionId}::uuid, ${attachmentId}::uuid
        )
      `,
    })).rejects.toMatchObject({ code: "P0002" });

    // A Viewer reads and downloads attachments -- that is the whole point of a shared thread, and
    // this read is PostgreSQL plus object storage, so it never wakes the Box.
    await asApi({
      orgId: ids.orgA,
      actorId: ids.ownerA,
      action: (tx) => tx`
        select * from public.companion_api_set_workspace_access(
          ${ids.orgA}::uuid, ${companionId}::uuid, 'viewer'::public.companion_share_role
        )
      `,
    });
    const viewerRead = await asApi({
      orgId: ids.orgA,
      actorId: ids.viewerA,
      action: (tx) => tx<Array<{ filename: string }>>`
        select filename from public.companion_api_read_attachment(
          ${ids.orgA}::uuid, ${companionId}::uuid, ${attachmentId}::uuid
        )
      `,
    });
    expect(viewerRead[0]?.filename).toBe("chart.png");

    // A Viewer still cannot send, so the same share does not open the upload path.
    await expect(enqueue(attachments)).resolves.toBeDefined();
    await expect(asApi({
      orgId: ids.orgA,
      actorId: ids.viewerA,
      action: (tx) => tx`
        select * from public.companion_api_enqueue_turn(
          ${ids.orgA}::uuid, ${companionId}::uuid, ${randomUUID()}::uuid,
          'viewer send', 'web', ${tx.json(attachments)}::jsonb
        )
      `,
    })).rejects.toMatchObject({ code: "42501" });

    // Revoking the workspace share takes the bytes away at the next request, not at the next cache
    // expiry -- nothing signed or long-lived was ever minted.
    await asApi({
      orgId: ids.orgA,
      actorId: ids.ownerA,
      action: (tx) => tx`
        select * from public.companion_api_set_workspace_access(
          ${ids.orgA}::uuid, ${companionId}::uuid, null::public.companion_share_role
        )
      `,
    });
    await expect(asApi({
      orgId: ids.orgA,
      actorId: ids.viewerA,
      action: (tx) => tx`
        select * from public.companion_api_read_attachment(
          ${ids.orgA}::uuid, ${companionId}::uuid, ${attachmentId}::uuid
        )
      `,
    })).rejects.toMatchObject({ code: "P0002" });

    // A key outside this tenant's own prefix is refused before any row is written.
    await expect(enqueue([{
      ...attachments[0]!,
      storage_key: `companion-attachments/${ids.orgB}/${companionId}/${clientMessageId}/0-${"a".repeat(64)}`,
    }])).rejects.toMatchObject({ code: "22023" });

    // Removing the entry removes its files and schedules exactly those objects for deletion.
    await asOwnerV2((tx) => tx`
      delete from companion_transcript_entries
      where companion_id = ${companionId}::uuid
    `);
    const queued = await sql<Array<{ storage_key: string }>>`
      select storage_key from skill_database_object_deletions
      where org_id = ${ids.orgA}::uuid and storage_key like ${`companion-attachments/${ids.orgA}/${companionId}/%`}
      order by storage_key
    `;
    expect(queued.map((row) => row.storage_key))
      .toEqual(attachments.map((attachment) => attachment.storage_key).sort());
    } finally {
      await removeCompanion(companionId);
    }
  });

  it("records Pi's outputs once and makes an image-only turn a visible output", async () => {
    if (!sql) throw new Error("runtime executor database is not initialized");
    const fixture = await createCompanion({ boxReady: true });
    await asOwnerV2((tx) => tx`
      update companion_turn_attempts
      set checkpoint = 'agent_settled', event_cursor = 4
      where id = ${fixture.attemptId}::uuid
    `);
    const claim = await claimWork();
    try {
    expect(claim.workKind).toBe("attempt");

    const outputs = [{
      storage_key: `companion-attachments/${ids.orgA}/${fixture.companionId}/outputs/${fixture.attemptId}/0-${"d".repeat(64)}`,
      content_type: "image/png",
      byte_size: 512,
      sha256: "d".repeat(64),
      filename: "plot.png",
      position: 0,
    }];
    const record = () => asRuntime((tx) => tx<Array<{ recorded: number; has_visible_output: boolean }>>`
      select recorded, has_visible_output
      from public.companion_runtime_record_attempt_outputs(
        ${claim.orgId}::uuid, ${claim.companionId}::uuid, ${claim.claimToken}::uuid,
        ${claim.claimEpoch}::bigint, ${claim.gateEpoch}::bigint, ${executorId},
        'attempt', ${claim.workId}::uuid, ${tx.json(outputs)}::jsonb, now()
      )
    `);

    const first = await record();
    // Pi said nothing at all, so the image is the whole reply: without this entry the turn would
    // settle `empty_response`.
    expect(first[0]).toEqual({ recorded: 1, has_visible_output: true });

    // A call that committed and lost its answer is repeated. It must change nothing.
    const replay = await record();
    expect(replay[0]).toEqual({ recorded: 1, has_visible_output: true });
    const [rows] = await sql<Array<{ count: number }>>`
      select count(*)::int as count from companion_message_attachments
      where companion_id = ${fixture.companionId}::uuid and kind = 'pi_output'
    `;
    expect(rows?.count).toBe(1);
    const entries = await sql<Array<{ event_id: string; ordinal: number; content: string }>>`
      select event_id, ordinal, content from companion_transcript_entries
      where companion_id = ${fixture.companionId}::uuid and role = 'assistant'
    `;
    expect(entries).toEqual([{
      event_id: `v2:${fixture.attemptId}:outputs`,
      ordinal: 1,
      content: "",
    }]);

    // The reader's projection is what the browser parses, so the outputs entry has to carry its
    // files as `pi_output` on an assistant entry, in dense order, with no storage key.
    const thread = await asApi({
      orgId: ids.orgA,
      actorId: ids.ownerA,
      action: (tx) => tx<Array<{ entries: Array<IntegrationJsonObject> }>>`
        select entries from public.companion_api_read_thread(
          ${ids.orgA}::uuid, ${fixture.companionId}::uuid
        )
      `,
    });
    const outputsEntry = thread[0]!.entries
      .find((entry) => entry.event_id === `v2:${fixture.attemptId}:outputs`)!;
    expect(outputsEntry.role).toBe("assistant");
    expect(outputsEntry.attachments).toEqual([expect.objectContaining({
      kind: "pi_output",
      content_type: "image/png",
      filename: "plot.png",
      position: 0,
    })]);
    expect(JSON.stringify(outputsEntry)).not.toContain("companion-attachments/");

    // A takeover reads the harvest as already done and does not repeat it.
    const terminal = await asRuntime((tx) => tx<Array<{ outputs_harvested: boolean }>>`
      select outputs_harvested from public.companion_runtime_get_attempt_terminal_projection(
        ${claim.orgId}::uuid, ${claim.companionId}::uuid, ${claim.claimToken}::uuid,
        ${claim.claimEpoch}::bigint, ${claim.gateEpoch}::bigint, ${executorId},
        'attempt', ${claim.workId}::uuid
      )
    `);
    expect(terminal[0]?.outputs_harvested).toBe(true);

    // A succeeded turn proves Pi settled it; the harvest does not weaken that.
    const settled = await asRuntime((tx) => tx<Array<{ settled: boolean }>>`
      select public.companion_runtime_settle(
        ${claim.orgId}::uuid, ${claim.companionId}::uuid, ${claim.claimToken}::uuid,
        ${claim.claimEpoch}::bigint, ${claim.gateEpoch}::bigint, ${executorId},
        'attempt', ${claim.workId}::uuid, 'succeeded', null, null, null
      ) as settled
    `);
    expect(settled[0]?.settled).toBe(true);
    } finally {
      await removeCompanion(fixture.companionId);
    }
  });

  it("refuses attempt outputs that are not bounded images", async () => {
    const fixture = await createCompanion({ boxReady: true });
    if (!sql) throw new Error("runtime executor database is not initialized");
    await asOwnerV2((tx) => tx`
      update companion_turn_attempts
      set checkpoint = 'agent_settled', event_cursor = 4
      where id = ${fixture.attemptId}::uuid
    `);
    const claim = await claimWork();
    try {
    const valid = {
      storage_key: `companion-attachments/${ids.orgA}/${fixture.companionId}/outputs/${fixture.attemptId}/0-${"d".repeat(64)}`,
      content_type: "image/png",
      byte_size: 512,
      sha256: "d".repeat(64),
      filename: "plot.png",
      position: 0,
    };
    const record = (list: (typeof valid)[]) =>
      asRuntime((tx) => tx`
        select * from public.companion_runtime_record_attempt_outputs(
          ${claim.orgId}::uuid, ${claim.companionId}::uuid, ${claim.claimToken}::uuid,
          ${claim.claimEpoch}::bigint, ${claim.gateEpoch}::bigint, ${executorId},
          'attempt', ${claim.workId}::uuid, ${tx.json(list)}::jsonb, now()
        )
      `);

    // A document, an oversized file, a bad digest, and a name that could traverse are all refused
    // before anything is written.
    await expect(record([{ ...valid, content_type: "application/pdf" }]))
      .rejects.toMatchObject({ code: "22023" });
    await expect(record([{ ...valid, byte_size: 20 * 1024 * 1024 }]))
      .rejects.toMatchObject({ code: "22023" });
    await expect(record([{ ...valid, sha256: "not-a-digest" }]))
      .rejects.toMatchObject({ code: "22023" });
    await expect(record([{ ...valid, filename: "../escape.png" }]))
      .rejects.toMatchObject({ code: "22023" });
    await expect(record(Array.from({ length: 11 }, (_unused, index) => ({ ...valid, position: index }))))
      .rejects.toMatchObject({ code: "22023" });
    } finally {
      await removeCompanion(fixture.companionId);
    }
  });

  it("persists API intents atomically, projects exact queue state, and enforces tenant ACLs", async () => {
    if (!sql) throw new Error("runtime executor database is not initialized");
    let companionId = "";
    let duplicateId = "";
    try {
      const created = await asApi({
        orgId: ids.orgA,
        actorId: ids.ownerA,
        action: (tx) => tx<Array<{
          companionId: string;
          settingsRevision: string;
          skillsRevision: number;
        }>>`
          select companion_id::text as "companionId",
            desired_settings_revision::text as "settingsRevision",
            skills_revision as "skillsRevision"
          from public.companion_api_create_companion(
            ${ids.orgA}::uuid, 'API capability fixture', 'Initial persona',
            ${null}::text, ${null}::text, ${tx.json([ids.skill])}::jsonb,
            false, ${tx.json([ids.mcpAccount])}::jsonb
          )
        `,
      });
      expect(created).toEqual([{
        companionId: expect.any(String),
        settingsRevision: "1",
        skillsRevision: 1,
      }]);
      companionId = created[0]!.companionId;

      const [atomicProjection] = await sql<Array<{
        ownerId: string;
        runtimeRows: number;
        providerIds: string[];
      }>>`
        select companion.owner_id as "ownerId", companion.provider_ids as "providerIds",
          (select count(*)::int from companion_runtime_instances instance
            where instance.org_id = companion.org_id
              and instance.companion_id = companion.id) as "runtimeRows"
        from companions companion
        where companion.org_id = ${ids.orgA}::uuid and companion.id = ${companionId}::uuid
      `;
      expect(atomicProjection).toEqual({
        ownerId: ids.ownerA,
        runtimeRows: 1,
        providerIds: [],
      });

      const [duplicated] = await asApi({
        orgId: ids.orgA,
        actorId: ids.ownerA,
        action: (tx) => tx<Array<{ companionId: string }>>`
          select companion_id::text as "companionId"
          from public.companion_api_create_companion(
            ${ids.orgA}::uuid, 'API capability copy', 'Initial persona',
            ${null}::text, ${null}::text, '[]'::jsonb,
            false, '[]'::jsonb, ${companionId}::uuid
          )
        `,
      });
      duplicateId = duplicated?.companionId ?? "";
      const [duplicateAudit] = await sql<Array<{
        action: string;
        actorId: string | null;
        metadata: IntegrationJsonObject;
      }>>`
        select action, actor_id as "actorId", metadata
        from audit_log
        where org_id = ${ids.orgA}::uuid and target_id = ${duplicateId}
      `;
      expect(duplicateAudit).toEqual({
        action: "companion.duplicated",
        actorId: ids.ownerA,
        metadata: { source_companion_id: companionId },
      });

      const updated = await asApi({
        orgId: ids.orgA,
        actorId: ids.ownerA,
        action: (tx) => tx<Array<{
          settingsRevision: string;
          skillsRevision: number;
          settingsChanged: boolean;
          skillsChanged: boolean;
        }>>`
          select desired_settings_revision::text as "settingsRevision",
            skills_revision as "skillsRevision", settings_changed as "settingsChanged",
            skills_changed as "skillsChanged"
          from public.companion_api_update_companion(
            ${ids.orgA}::uuid, ${companionId}::uuid,
            ${tx.json({ name: "API capability renamed", persona: "Updated persona" })}::jsonb
          )
        `,
      });
      expect(updated).toEqual([{
        settingsRevision: "2",
        skillsRevision: 1,
        settingsChanged: true,
        skillsChanged: false,
      }]);

      const [skillBump] = await asApi({
        orgId: ids.orgA,
        actorId: ids.ownerA,
        action: (tx) => tx<Array<{ changed: number }>>`
          select public.companion_api_bump_skill_revision(
            ${ids.orgA}::uuid, ${ids.skill}::uuid
          ) as changed
        `,
      });
      expect(skillBump?.changed).toBe(1);
      const [deferredPublication] = await sql<Array<{
        requiredRevision: number;
        availableRevision: number;
      }>>`
        select skills_revision as "requiredRevision",
          skills_available_revision as "availableRevision"
        from companions
        where org_id = ${ids.orgA}::uuid and id = ${companionId}::uuid
      `;
      expect(deferredPublication).toEqual({ requiredRevision: 1, availableRevision: 2 });
      await expect(asApi({
        orgId: ids.orgA,
        actorId: ids.editorA,
        action: (tx) => tx`
          select public.companion_api_bump_skill_revision(
            ${ids.orgA}::uuid, ${ids.skill}::uuid
          )
        `,
      })).rejects.toMatchObject({ code: "P0002" });

      await asApi({
        orgId: ids.orgA,
        actorId: ids.ownerA,
        action: (tx) => tx`
          select * from public.companion_api_set_workspace_access(
            ${ids.orgA}::uuid, ${companionId}::uuid, 'editor'
          )
        `,
      });
      await sql`
        update companions
        set selected_skill_ids = ${sql.json([ids.skill, ids.editorSkill, ids.orgSkill])},
            selected_mcp_account_ids = ${sql.json([ids.mcpAccount, ids.editorMcpAccount])}
        where org_id = ${ids.orgA}::uuid and id = ${companionId}::uuid
      `;
      const [editorRuntime] = await asApi({
        orgId: ids.orgA,
        actorId: ids.editorA,
        action: (tx) => tx<Array<{
          selectedSkillIds: string[];
          selectedMcpAccountIds: string[];
        }>>`
          select selected_skill_ids as "selectedSkillIds",
            selected_mcp_account_ids as "selectedMcpAccountIds"
          from public.companion_api_read_runtime(${ids.orgA}::uuid, ${companionId}::uuid)
        `,
      });
      expect(editorRuntime).toEqual({
        selectedSkillIds: [ids.editorSkill, ids.orgSkill],
        selectedMcpAccountIds: [ids.editorMcpAccount],
      });
      const [editorList] = await asApi({
        orgId: ids.orgA,
        actorId: ids.editorA,
        action: (tx) => tx<Array<{
          selectedSkillIds: string[];
          selectedMcpAccountIds: string[];
        }>>`
          select selected_skill_ids as "selectedSkillIds",
            selected_mcp_account_ids as "selectedMcpAccountIds"
          from public.companion_api_list_runtime(${ids.orgA}::uuid)
          where companion_id = ${companionId}::uuid
        `,
      });
      expect(editorList).toEqual(editorRuntime);
      const clientMessageId = randomUUID();
      const enqueue = () => asApi({
        orgId: ids.orgA,
        actorId: ids.editorA,
        action: (tx: Tx) => tx<Array<{
          turn: IntegrationJsonObject;
          operation: IntegrationJsonObject;
          replayed: boolean;
        }>>`
          select * from public.companion_api_enqueue_turn(
            ${ids.orgA}::uuid, ${companionId}::uuid, ${clientMessageId}::uuid,
            'One durable message', 'web', '[]'::jsonb
          )
        `,
      });
      const first = await enqueue();
      const replay = await enqueue();
      expect(first).toHaveLength(1);
      expect(first[0]?.replayed).toBe(false);
      expect(first[0]?.turn).toMatchObject({
        client_message_id: clientMessageId,
        companion_id: companionId,
        status: "queued",
        queue_sequence: 1,
        latest_attempt: null,
        replying: false,
        error: null,
      });
      expect(first[0]?.operation).toMatchObject({
        companion_id: companionId,
        request_id: clientMessageId,
        source_turn_id: first[0]?.turn.id,
        kind: "start",
        trigger: "turn",
        status: "pending",
        queue_sequence: 1,
        error: null,
      });
      expect(companionTurnSchema.safeParse(first[0]?.turn).success).toBe(true);
      expect(companionOperationSchema.safeParse(first[0]?.operation).success).toBe(true);
      expect(replay).toEqual([{ ...first[0], replayed: true }]);

      const [allocation] = await sql<Array<{
        turns: number;
        messages: number;
        operations: number;
        nextTurn: string;
        nextOperation: string;
      }>>`
        select
          (select count(*)::int from companion_turns where companion_id = ${companionId}::uuid) as turns,
          (select count(*)::int from companion_transcript_entries
            where companion_id = ${companionId}::uuid and role = 'user') as messages,
          (select count(*)::int from companion_operations
            where companion_id = ${companionId}::uuid) as operations,
          instance.next_turn_sequence::text as "nextTurn",
          instance.next_operation_sequence::text as "nextOperation"
        from companion_runtime_instances instance
        where instance.companion_id = ${companionId}::uuid
      `;
      expect(allocation).toEqual({
        turns: 1,
        messages: 1,
        operations: 1,
        nextTurn: "2",
        nextOperation: "2",
      });

      await sql`
        update companion_runtime_instances
        set box_id = 'bx_2345678d', box_state = 'ready', pi_state = 'idle',
          disk_layout_version = 14, pi_invocation_id = 'pi-api-capability'
        where companion_id = ${companionId}::uuid
      `;
      const ownerRuntime = await asApi({
        orgId: ids.orgA,
        actorId: ids.ownerA,
        action: (tx) => tx<Array<{
          accessRole: string;
          generation: string;
          selectedSkillIds: string[];
          selectedMcpAccountIds: string[];
          boxId: string | null;
          queuedCount: number;
          activeTurn: unknown;
        }>>`
          select access_role as "accessRole", generation::text,
            selected_skill_ids as "selectedSkillIds",
            selected_mcp_account_ids as "selectedMcpAccountIds", box_id as "boxId",
            queued_count as "queuedCount", active_turn as "activeTurn"
          from public.companion_api_read_runtime(${ids.orgA}::uuid, ${companionId}::uuid)
        `,
      });
      expect(ownerRuntime).toEqual([{
        accessRole: "owner",
        generation: "1",
        selectedSkillIds: [ids.skill, ids.orgSkill],
        selectedMcpAccountIds: [ids.mcpAccount],
        boxId: "bx_2345678d",
        queuedCount: 1,
        activeTurn: null,
      }]);

      const thread = await asApi({
        orgId: ids.orgA,
        actorId: ids.editorA,
        action: (tx) => tx<Array<{
          accessRole: string;
          entries: Array<IntegrationJsonObject>;
          queuedCount: number;
          interruptedTurn: unknown;
        }>>`
          select access_role as "accessRole", entries, queued_count as "queuedCount",
            interrupted_turn as "interruptedTurn"
          from public.companion_api_read_thread(${ids.orgA}::uuid, ${companionId}::uuid)
        `,
      });
      expect(thread).toHaveLength(1);
      expect(thread[0]).toMatchObject({
        accessRole: "editor",
        queuedCount: 1,
        interruptedTurn: null,
      });
      expect(thread[0]?.entries).toEqual([expect.objectContaining({
        event_id: `msg:${clientMessageId}`,
        ordinal: 0,
        role: "user",
        content: "One durable message",
        author_id: ids.editorA,
        author_name: null,
        tool: null,
        decision: null,
      })]);
      const parsedEntry = companionTranscriptEntrySchema.safeParse(thread[0]?.entries[0]);
      expect(
        parsedEntry.success,
        parsedEntry.success
          ? undefined
          : `${parsedEntry.error.message}: ${JSON.stringify(thread[0]?.entries[0])}`,
      ).toBe(true);
      const [memberState] = await asApi({
        orgId: ids.orgA,
        actorId: ids.editorA,
        action: (tx) => tx<Array<{
          pinnedAt: Date | null;
          hidden: boolean;
          lastReadOrdinal: number | null;
        }>>`
          select pinned_at as "pinnedAt", hidden,
            last_read_ordinal as "lastReadOrdinal"
          from public.companion_api_update_member_state(
            ${ids.orgA}::uuid, ${companionId}::uuid, true, null, null
          )
        `,
      });
      expect(memberState).toEqual({
        pinnedAt: expect.any(Date),
        hidden: false,
        lastReadOrdinal: 0,
      });

      await asApi({
        orgId: ids.orgA,
        actorId: ids.ownerA,
        action: (tx) => tx`
          select * from public.companion_api_set_workspace_access(
            ${ids.orgA}::uuid, ${companionId}::uuid, 'viewer'
          )
        `,
      });
      const viewerRuntime = await asApi({
        orgId: ids.orgA,
        actorId: ids.viewerA,
        action: (tx) => tx<Array<{
          accessRole: string;
          selectedSkillIds: string[];
          selectedMcpAccountIds: string[];
          boxId: string | null;
        }>>`
          select access_role as "accessRole", selected_skill_ids as "selectedSkillIds",
            selected_mcp_account_ids as "selectedMcpAccountIds", box_id as "boxId"
          from public.companion_api_read_runtime(${ids.orgA}::uuid, ${companionId}::uuid)
        `,
      });
      expect(viewerRuntime).toEqual([{
        accessRole: "viewer",
        selectedSkillIds: [ids.orgSkill],
        selectedMcpAccountIds: [],
        boxId: null,
      }]);
      const viewerList = await asApi({
        orgId: ids.orgA,
        actorId: ids.viewerA,
        action: (tx) => tx<Array<{
          companionId: string;
          accessRole: string;
          selectedSkillIds: string[];
          selectedMcpAccountIds: string[];
          boxId: string | null;
        }>>`
          select companion_id::text as "companionId", access_role as "accessRole",
            selected_skill_ids as "selectedSkillIds",
            selected_mcp_account_ids as "selectedMcpAccountIds", box_id as "boxId"
          from public.companion_api_list_runtime(${ids.orgA}::uuid)
          where companion_id = ${companionId}::uuid
        `,
      });
      expect(viewerList).toEqual([{
        companionId,
        accessRole: "viewer",
        selectedSkillIds: [ids.orgSkill],
        selectedMcpAccountIds: [],
        boxId: null,
      }]);
      await expect(enqueue()).rejects.toMatchObject({ code: "42501" });

      await asApi({
        orgId: ids.orgA,
        actorId: ids.ownerA,
        action: (tx) => tx`
          select * from public.companion_api_set_workspace_access(
            ${ids.orgA}::uuid, ${companionId}::uuid, 'editor'
          )
        `,
      });
      await expect(asApi({
        orgId: ids.orgB,
        actorId: ids.ownerB,
        action: (tx) => tx`
          select * from public.companion_api_read_runtime(
            ${ids.orgB}::uuid, ${companionId}::uuid
          )
        `,
      })).rejects.toMatchObject({ code: "P0002" });

      await sql`
        delete from memberships where org_id = ${ids.orgA}::uuid and user_id = ${ids.viewerA}
      `;
      try {
        await expect(asApi({
          orgId: ids.orgA,
          actorId: ids.viewerA,
          action: (tx) => tx`
            select * from public.companion_api_update_member_state(
              ${ids.orgA}::uuid, ${companionId}::uuid, true, null, null
            )
          `,
        })).rejects.toMatchObject({ code: "42501" });
      } finally {
        await sql`
          insert into memberships(org_id, user_id, org_role)
          values (${ids.orgA}::uuid, ${ids.viewerA}, 'developer')
          on conflict (org_id, user_id) do nothing
        `;
      }

      await expect(asApi({
        orgId: ids.orgA,
        actorId: ids.editorA,
        action: (tx) => tx`
          select * from public.companion_api_enqueue_operation(
            ${ids.orgA}::uuid, ${companionId}::uuid, ${randomUUID()}::uuid,
            'delete', 'web'
          )
        `,
      })).rejects.toMatchObject({ code: "42501" });

      const stopRequestId = randomUUID();
      const enqueueStop = () => asApi({
        orgId: ids.orgA,
        actorId: ids.editorA,
      action: (tx: Tx) => tx<Array<{ operation: IntegrationJsonObject; replayed: boolean }>>`
          select * from public.companion_api_enqueue_operation(
            ${ids.orgA}::uuid, ${companionId}::uuid, ${stopRequestId}::uuid,
            'stop', 'web'
          )
        `,
      });
      const stop = await enqueueStop();
      expect(stop).toEqual([{
        operation: expect.objectContaining({
          request_id: stopRequestId,
          kind: "stop",
          status: "pending",
          queue_sequence: 2,
        }),
        replayed: false,
      }]);
      expect(await enqueueStop()).toEqual([{ ...stop[0], replayed: true }]);

      for (const [initialSurface, conflictingSurface] of [
        ["web", "native_mobile"],
        ["native_mobile", "web"],
      ] as const) {
        const startRequestId = randomUUID();
        const enqueueStart = (surface: "web" | "native_mobile") => asApi({
          orgId: ids.orgA,
          actorId: ids.editorA,
          action: (tx: Tx) => tx<Array<{ replayed: boolean }>>`
            select replayed from public.companion_api_enqueue_operation(
              ${ids.orgA}::uuid, ${companionId}::uuid, ${startRequestId}::uuid,
              'start', ${surface}::public.companion_client_surface
            )
          `,
        });
        expect(await enqueueStart(initialSurface)).toEqual([{ replayed: false }]);
        expect(await enqueueStart(initialSurface)).toEqual([{ replayed: true }]);
        await expect(enqueueStart(conflictingSurface)).rejects.toMatchObject({ code: "22023" });
      }

      const deleteRequestId = randomUUID();
      const enqueueDelete = () => asApi({
        orgId: ids.orgA,
        actorId: ids.ownerA,
        action: (tx: Tx) => tx<Array<{ operation: IntegrationJsonObject; replayed: boolean }>>`
          select * from public.companion_api_enqueue_operation(
            ${ids.orgA}::uuid, ${companionId}::uuid, ${deleteRequestId}::uuid,
            'delete', 'web'
          )
        `,
      });
      const deletion = await enqueueDelete();
      expect(deletion[0]).toMatchObject({
        operation: { request_id: deleteRequestId, kind: "delete", status: "pending" },
        replayed: false,
      });
      expect(await enqueueDelete()).toEqual([{ ...deletion[0], replayed: true }]);

      const audits = await sql<Array<{
        action: string;
        actorId: string | null;
        metadata: IntegrationJsonObject;
      }>>`
        select action, actor_id as "actorId", metadata
        from audit_log
        where org_id = ${ids.orgA}::uuid and target_id = ${companionId}
        order by created_at, action
      `;
      expect(audits.filter((entry) => entry.action === "companion.settings.updated"))
        .toEqual([expect.objectContaining({
          actorId: ids.ownerA,
          metadata: expect.objectContaining({ name: true, persona: true }),
        })]);
      expect(audits.filter((entry) => entry.action === "companion.share.workspace.updated"))
        .toHaveLength(3);
      expect(audits.filter((entry) => entry.action === "companion.delete.requested"))
        .toEqual([expect.objectContaining({
          actorId: ids.ownerA,
          metadata: { operation_id: deletion[0]?.operation.id },
        })]);
    } finally {
      if (duplicateId) await removeCompanion(duplicateId);
      if (companionId) await removeCompanion(companionId);
    }
  });

  it("enqueues an already-warm send without a start operation and dispatches it directly", async () => {
    if (!sql) throw new Error("runtime executor database is not initialized");
    let companionId = "";
    try {
      const created = await asApi({
        orgId: ids.orgA,
        actorId: ids.ownerA,
        action: (tx) => tx<Array<{ companionId: string }>>`
          select companion_id::text as "companionId"
          from public.companion_api_create_companion(
            ${ids.orgA}::uuid, 'Warm send fixture', null, null, null,
            '[]'::jsonb, false, '[]'::jsonb
          )
        `,
      });
      companionId = created[0]?.companionId ?? "";

      // Simulate a Companion that already finished its cold start on an earlier message: the Box is
      // observed ready and Pi is idle before this send, exactly as it is moments after Pi replies.
      await sql`
        update companion_runtime_instances
        set box_id = 'bx_warmsend', box_state = 'ready', pi_state = 'idle',
          pi_invocation_id = 'pi-already-warm', disk_layout_version = 14,
          applied_settings_revision = desired_settings_revision,
          applied_skills_revision = 1, applied_client_surface = 'web',
          last_observed_at = now()
        where companion_id = ${companionId}::uuid
      `;
      await sql`
        update companion_runtime_instances
        set material_client_surface = 'web', material_pi_invocation_id = 'pi-already-warm',
            material_expires_at = now() + interval '6 hours'
        where companion_id = ${companionId}::uuid
      `;

      const clientMessageId = randomUUID();
      const enqueued = await asApi({
        orgId: ids.orgA,
        actorId: ids.ownerA,
        action: (tx: Tx) => tx<Array<{
          turn: IntegrationJsonObject;
          operation: IntegrationJsonObject | null;
          replayed: boolean;
        }>>`
          select * from public.companion_api_enqueue_turn(
            ${ids.orgA}::uuid, ${companionId}::uuid, ${clientMessageId}::uuid,
            'Already warm, no wake needed', 'web', '[]'::jsonb
          )
        `,
      });
      expect(enqueued[0]?.replayed).toBe(false);
      expect(enqueued[0]?.operation).toBeNull();
      expect(companionTurnSchema.safeParse(enqueued[0]?.turn).success).toBe(true);
      const turnId = enqueued[0]?.turn.id;

      // Sending the identical message again must still replay idempotently even though no operation
      // was ever created to prove the first insert's completeness.
      const replay = await asApi({
        orgId: ids.orgA,
        actorId: ids.ownerA,
        action: (tx: Tx) => tx<Array<{ turn: IntegrationJsonObject; replayed: boolean }>>`
          select turn, replayed from public.companion_api_enqueue_turn(
            ${ids.orgA}::uuid, ${companionId}::uuid, ${clientMessageId}::uuid,
            'Already warm, no wake needed', 'web', '[]'::jsonb
          )
        `,
      });
      expect(replay[0]?.replayed).toBe(true);
      expect(replay[0]?.turn.id).toBe(turnId);

      const [operationCount] = await sql<Array<{ count: number }>>`
        select count(*)::int as count from companion_operations
        where companion_id = ${companionId}::uuid
      `;
      expect(operationCount).toEqual({ count: 0 });

      // No 'start' operation stands between the send and dispatch: the very next claim picks the
      // turn itself up directly as an 'attempt', ready to prompt the already-idle Pi.
      const claim = await claimWork();
      expect(claim).toMatchObject({ workKind: "attempt", companionId });
      const [claimedAttempt] = await sql<Array<{ turnId: string }>>`
        select turn_id::text as "turnId" from companion_turn_attempts
        where id = ${claim.workId}::uuid
      `;
      expect(claimedAttempt).toEqual({ turnId });
      await release(claim);

      const [instance] = await sql<Array<{ boxState: string; piState: string; piInvocationId: string }>>`
        select box_state::text as "boxState", pi_state::text as "piState",
          pi_invocation_id as "piInvocationId"
        from companion_runtime_instances where companion_id = ${companionId}::uuid
      `;
      expect(instance).toEqual({
        boxState: "ready", piState: "idle", piInvocationId: "pi-already-warm",
      });
    } finally {
      if (companionId) await removeCompanion(companionId);
    }
  });

  it("returns a pending decision to Pi and defers Start when a member sends a follow-up", async () => {
    if (!sql) throw new Error("runtime executor database is not initialized");
    let companionId = "";
    try {
      const [created] = await asApi({
        orgId: ids.orgA,
        actorId: ids.ownerA,
        action: (tx) => tx<Array<{ companionId: string }>>`
          select companion_id::text as "companionId"
          from public.companion_api_create_companion(
            ${ids.orgA}::uuid, 'Busy warm follow-up fixture', null,
            ${providerId}, 'fixture-model',
            '[]'::jsonb, false, '[]'::jsonb
          )
        `,
      });
      companionId = created?.companionId ?? "";

      await sql`
        update companion_runtime_instances
        set box_id = 'bx_busywarm', box_state = 'ready', pi_state = 'idle',
          pi_invocation_id = 'pi-busy-warm', disk_layout_version = 14,
          applied_settings_revision = desired_settings_revision,
          applied_skills_revision = 1, applied_client_surface = 'web',
          last_observed_at = now()
        where companion_id = ${companionId}::uuid
      `;
      await sql`
        update companion_runtime_instances
        set material_client_surface = 'web', material_pi_invocation_id = 'pi-busy-warm',
          material_expires_at = now() + interval '6 hours'
        where companion_id = ${companionId}::uuid
      `;

      const firstMessageId = randomUUID();
      await asApi({
        orgId: ids.orgA,
        actorId: ids.ownerA,
        action: (tx: Tx) => tx`
          select * from public.companion_api_enqueue_turn(
            ${ids.orgA}::uuid, ${companionId}::uuid, ${firstMessageId}::uuid,
            'Keep Pi busy', 'web', '[]'::jsonb
          )
        `,
      });
      const firstClaim = await claimWork();
      expect(firstClaim).toMatchObject({ workKind: "attempt", companionId });
      const decisionId = randomUUID();
      const requestKey = `superseded-${randomUUID()}`;
      const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
      const decision = {
        request_id: requestKey,
        kind: "question",
        name: "ask_user",
        title: "Should the old turn continue?",
        detail: "A newer member message should return control to Pi.",
        status: "pending",
        answer: null,
        decided_by_id: null,
        decided_by_name: null,
        decided_at: null,
        expires_at: expiresAt,
      };
      await sql`
        update companion_runtime_instances
        set pi_state = 'running', last_observed_at = now()
        where companion_id = ${companionId}::uuid
      `;
      await sql`
        update companion_turn_attempts
        set status = 'needs_input', checkpoint = 'needs_input', updated_at = now()
        where id = ${firstClaim.workId}::uuid
      `;
      await sql`
        update companion_turns
        set status = 'needs_input', state_changed_at = now(), updated_at = now()
        where companion_id = ${companionId}::uuid and status = 'starting'
      `;
      const followUpMessageId = randomUUID();
      const [followUp] = await asApi({
        orgId: ids.orgA,
        actorId: ids.ownerA,
        action: (tx: Tx) => tx<Array<{
          turn: IntegrationJsonObject;
          operation: IntegrationJsonObject | null;
        }>>`
          select turn, operation from public.companion_api_enqueue_turn(
            ${ids.orgA}::uuid, ${companionId}::uuid, ${followUpMessageId}::uuid,
            'Wait behind the active turn', 'web', '[]'::jsonb
          )
        `,
      });
      expect(followUp?.operation).toBeNull();
      expect(followUp?.turn).toMatchObject({ status: "queued" });
      const followUpTurnId = stringValue(followUp?.turn.id);

      // Reproduce the projection/send race in the harder commit order: the member turn is already
      // durable before the still-running attempt projects its decision. The deferred delivery
      // reconciliation must close it after the transcript insert, without treating the message as
      // an answer or waiting for the ten-minute expiry.
      await sql.begin(async (tx) => {
        await tx`
          insert into companion_decision_deliveries(
            id, org_id, companion_id, turn_id, attempt_id,
            request_key, request_kind, expires_at
          )
          select ${decisionId}::uuid, ${ids.orgA}::uuid, ${companionId}::uuid,
            attempt.turn_id, attempt.id, ${requestKey}, 'question', ${expiresAt}
          from companion_turn_attempts attempt
          where attempt.id = ${firstClaim.workId}::uuid
        `;
        await tx`
          with next_entry as (
            update companion_threads
            set next_ordinal = next_ordinal + 1, updated_at = now()
            where companion_id = ${companionId}::uuid
            returning next_ordinal - 1 as ordinal
          )
          insert into companion_transcript_entries(
            org_id, companion_id, event_id, ordinal, role, content, decision
          )
          select ${ids.orgA}::uuid, ${companionId}::uuid, ${`decision:${requestKey}`},
            next_entry.ordinal, 'decision', ${decision.title}, ${tx.json(decision)}
          from next_entry
        `;
      });

      const [durable] = await sql<Array<{
        startOperations: number;
        coldStartDeadlineAt: Date | null;
        decisionStatus: string;
        transcriptStatus: string;
      }>>`
        select
          (select count(*)::int from companion_operations operation
           where operation.companion_id = ${companionId}::uuid
             and operation.source_turn_id = ${followUpTurnId}::uuid
             and operation.kind = 'start') as "startOperations",
          turn_row.cold_start_deadline_at as "coldStartDeadlineAt",
          delivery.decision_status::text as "decisionStatus",
          transcript.decision ->> 'status' as "transcriptStatus"
        from companion_turns turn_row
        join companion_decision_deliveries delivery
          on delivery.id = ${decisionId}::uuid
        join companion_transcript_entries transcript
          on transcript.companion_id = turn_row.companion_id
         and transcript.event_id = ${`decision:${requestKey}`}
        where turn_row.id = ${followUpTurnId}::uuid
      `;
      expect(durable).toEqual({
        startOperations: 0,
        coldStartDeadlineAt: null,
        decisionStatus: "cancelled",
        transcriptStatus: "cancelled",
      });
      await release(firstClaim);
      const decisionClaim = await claimWork();
      expect(decisionClaim).toMatchObject({
        companionId,
        workKind: "decision",
        workId: decisionId,
      });
      const authorization = await asRuntime((tx) => tx<Array<{
        authorized: boolean;
        denialCode: string | null;
      }>>`
        select authorized, denial_code as "denialCode"
        from public.companion_runtime_renew_and_authorize(
          ${decisionClaim.orgId}::uuid, ${decisionClaim.companionId}::uuid,
          ${decisionClaim.claimToken}::uuid, ${decisionClaim.claimEpoch}::bigint,
          ${decisionClaim.gateEpoch}::bigint, ${executorId}, 'decision',
          ${decisionClaim.workId}::uuid, 30
        )
      `);
      expect(authorization).toEqual([{ authorized: true, denialCode: null }]);
      const response = await asRuntime((tx) => tx<Array<{
        kind: string;
        payload: IntegrationJsonObject;
      }>>`
        select decision_request_kind::text as kind, decision_response_payload as payload
        from public.companion_runtime_get_material(
          ${decisionClaim.orgId}::uuid, ${decisionClaim.companionId}::uuid,
          ${decisionClaim.claimToken}::uuid, ${decisionClaim.claimEpoch}::bigint,
          ${decisionClaim.gateEpoch}::bigint, ${executorId}, 'decision',
          ${decisionClaim.workId}::uuid, 30
        )
      `);
      expect(response).toEqual([{
        kind: "question",
        payload: { type: "extension_ui_response", id: requestKey, cancelled: true },
      }]);
      await release(decisionClaim);
    } finally {
      if (companionId) await removeCompanion(companionId);
    }
  });

  it("quarantines old material claimers while the routine-safe executor can claim the work", async () => {
    if (!sql) throw new Error("runtime executor database is not initialized");
    let companionId = "";
    try {
      const [created] = await asApi({
        orgId: ids.orgA,
        actorId: ids.ownerA,
        action: (tx) => tx<Array<{ companionId: string }>>`
          select companion_id::text as "companionId"
          from public.companion_api_create_companion(
            ${ids.orgA}::uuid, 'Legacy claimer quarantine', null, null, null,
            '[]'::jsonb, false, '[]'::jsonb
          )
        `,
      });
      companionId = created?.companionId ?? "";

      const legacyClaims = await asRuntime((tx) => tx<Array<{ workId: string }>>`
        select work_id::text as "workId"
        from public.companion_runtime_claim_work(${executorId}, 1, 30, (
          select gate_epoch from public.companion_runtime_gate_status()
        ), 1)
      `);
      expect(legacyClaims).toEqual([]);
      const protocolOneClaims = await asRuntime((tx) => tx<Array<{ workId: string }>>`
        select work_id::text as "workId"
        from public.companion_runtime_claim_work(${executorId}, 1, 30, (
          select gate_epoch from public.companion_runtime_gate_status()
        ), 1, 1)
      `);
      expect(protocolOneClaims).toEqual([]);
      const protocolTwoClaims = await asRuntime((tx) => tx<Array<{ workId: string }>>`
        select work_id::text as "workId"
        from public.companion_runtime_claim_work(${executorId}, 1, 30, (
          select gate_epoch from public.companion_runtime_gate_status()
        ), 2, 1)
      `);
      expect(protocolTwoClaims).toEqual([]);
      const protocolFourClaims = await asRuntime((tx) => tx<Array<{ workId: string }>>`
        select work_id::text as "workId"
        from public.companion_runtime_claim_work(${executorId}, 1, 30, (
          select gate_epoch from public.companion_runtime_gate_status()
        ), 4, 1)
      `);
      expect(protocolFourClaims).toEqual([]);
      const [unclaimed] = await sql<Array<{ workKind: string | null; workId: string | null }>>`
        select work_kind::text as "workKind", work_id::text as "workId"
        from companion_runtime_leases
        where companion_id = ${companionId}::uuid and lane = 'main'
      `;
      expect(unclaimed).toEqual({ workKind: null, workId: null });

      const versionedClaim = await claimWork();
      expect(versionedClaim).toMatchObject({ companionId, workKind: "health" });
      await release(versionedClaim);
    } finally {
      if (companionId) await removeCompanion(companionId);
    }
  });

  it("atomically defers an accepted delete with fenced PostgreSQL backoff", async () => {
    if (!sql) throw new Error("runtime executor database is not initialized");
    const fixture = await createCompanion({ boxReady: true });
    const operationId = randomUUID();
    const providerOperationId = `delete-operation-${suffix}`;
    try {
      await sql`delete from companion_turn_attempts where id = ${fixture.attemptId}::uuid`;
      await sql`
        update companion_turns set status = 'cancelled', settled_at = now(),
          inactivity_deadline_at = null, absolute_deadline_at = null
        where id = ${fixture.turnId}::uuid
      `;
      await sql`
        insert into companion_operations(
          id, org_id, companion_id, request_id, kind, trigger, actor_id,
          runtime_generation, checkpoint, provider_operation_id, started_at
        ) values (
          ${operationId}::uuid, ${ids.orgA}::uuid, ${fixture.companionId}::uuid,
          ${randomUUID()}::uuid, 'delete', 'user', ${ids.ownerA}, 1,
          'waiting_deleted', ${providerOperationId}, now() - interval '1 hour'
        )
      `;

      const expectedDelays = [5, 15, 30, 60];
      let staleClaim: Claim | null = null;
      for (const expectedDelay of expectedDelays) {
        await sql`
          update companion_operations set available_at = now()
          where id = ${operationId}::uuid
        `;
        const claim = await claimWork();
        expect(claim).toMatchObject({
          companionId: fixture.companionId,
          workKind: "operation",
          workId: operationId,
          checkpoint: "waiting_deleted",
        });
        const before = Date.now();
        const [result] = await asRuntime((tx) => tx<Array<{ deferred: boolean }>>`
          select public.companion_runtime_defer_delete(
            ${claim.orgId}::uuid, ${claim.companionId}::uuid, ${claim.claimToken}::uuid,
            ${claim.claimEpoch}::bigint, ${claim.gateEpoch}::bigint, ${executorId},
            'operation', ${claim.workId}::uuid
          ) as deferred
        `);
        const after = Date.now();
        expect(result?.deferred).toBe(true);
        const [durable] = await sql<Array<{
          status: string;
          attemptCount: number;
          availableAt: Date;
          providerOperationId: string | null;
          settledAt: Date | null;
          claimToken: string | null;
        }>>`
          select operation.status::text, operation.attempt_count as "attemptCount",
            operation.available_at as "availableAt",
            operation.provider_operation_id as "providerOperationId",
            operation.settled_at as "settledAt", lease.claim_token::text as "claimToken"
          from companion_operations operation
          join companion_runtime_leases lease
            on lease.org_id = operation.org_id and lease.companion_id = operation.companion_id
           and lease.lane = 'main'
          where operation.id = ${operationId}::uuid
        `;
        expect(durable).toMatchObject({
          status: "pending",
          providerOperationId,
          settledAt: null,
          claimToken: null,
        });
        expect(durable?.attemptCount).toBe(expectedDelays.indexOf(expectedDelay) + 1);
        expect(durable!.availableAt.getTime()).toBeGreaterThanOrEqual(before + expectedDelay * 1_000);
        expect(durable!.availableAt.getTime()).toBeLessThanOrEqual(after + expectedDelay * 1_000 + 250);
        staleClaim ??= claim;
      }

      const [stale] = await asRuntime((tx) => tx<Array<{ deferred: boolean }>>`
        select public.companion_runtime_defer_delete(
          ${staleClaim!.orgId}::uuid, ${staleClaim!.companionId}::uuid,
          ${staleClaim!.claimToken}::uuid, ${staleClaim!.claimEpoch}::bigint,
          ${staleClaim!.gateEpoch}::bigint, ${executorId}, 'operation',
          ${staleClaim!.workId}::uuid
        ) as deferred
      `);
      expect(stale?.deferred).toBe(false);
    } finally {
      await removeCompanion(fixture.companionId);
    }
  });

  it("rewinds a proof-less legacy operation before a material-aware lease takeover", async () => {
    if (!sql) throw new Error("runtime executor database is not initialized");
    let companionId = "";
    try {
      const [created] = await asApi({
        orgId: ids.orgA,
        actorId: ids.ownerA,
        action: (tx) => tx<Array<{ companionId: string }>>`
          select companion_id::text as "companionId"
          from public.companion_api_create_companion(
            ${ids.orgA}::uuid, 'Legacy operation takeover', null, null, null,
            '[]'::jsonb, false, '[]'::jsonb
          )
        `,
      });
      companionId = created?.companionId ?? "";
      await asApi({
        orgId: ids.orgA,
        actorId: ids.ownerA,
        action: (tx) => tx`
          select * from public.companion_api_enqueue_operation(
            ${ids.orgA}::uuid, ${companionId}::uuid, ${randomUUID()}::uuid,
            'start', 'web'
          )
        `,
      });
      const legacyLease = await claimWork();
      expect(legacyLease).toMatchObject({ companionId, workKind: "operation" });
      await sql.begin(async (tx) => {
        await tx`
          update companion_operations
          set checkpoint = 'starting_pi', checkpoint_sequence = 7,
              material_staged_at = null, material_expires_at = null
          where id = ${legacyLease.workId}::uuid
        `;
        await tx`
          update companion_runtime_leases
          set claimed_at = now() - interval '1 minute',
              renewed_at = now() - interval '2 seconds',
              expires_at = now() - interval '1 second'
          where companion_id = ${companionId}::uuid and lane = 'main'
        `;
      });

      const takeover = await claimWork();
      expect(takeover).toMatchObject({
        companionId,
        workKind: "operation",
        workId: legacyLease.workId,
        checkpoint: "installing_layout",
        checkpointSequence: "8",
      });
      const [operation] = await sql<Array<{
        checkpoint: string;
        stagedAt: Date | null;
      }>>`
        select checkpoint, material_staged_at as "stagedAt"
        from companion_operations where id = ${takeover.workId}::uuid
      `;
      expect(operation).toEqual({ checkpoint: "installing_layout", stagedAt: null });
      await release(takeover);
    } finally {
      if (companionId) await removeCompanion(companionId);
    }
  });

  it("rewinds proof-less legacy settings before a material-aware lease takeover", async () => {
    if (!sql) throw new Error("runtime executor database is not initialized");
    let companionId = "";
    try {
      const [created] = await asApi({
        orgId: ids.orgA,
        actorId: ids.ownerA,
        action: (tx) => tx<Array<{ companionId: string }>>`
          select companion_id::text as "companionId"
          from public.companion_api_create_companion(
            ${ids.orgA}::uuid, 'Legacy settings takeover', null, null, null,
            '[]'::jsonb, false, '[]'::jsonb
          )
        `,
      });
      companionId = created?.companionId ?? "";
      await sql`
        update companion_runtime_instances
        set box_id = 'bx_2345678h', box_state = 'ready', pi_state = 'idle',
            pi_invocation_id = 'pi-legacy-settings', disk_layout_version = 14,
            last_observed_at = now(), health_due_at = now() + interval '1 day'
        where companion_id = ${companionId}::uuid
      `;
      const legacyLease = await claimWork();
      expect(legacyLease).toMatchObject({ companionId, workKind: "settings" });
      await sql.begin(async (tx) => {
        await tx`
          update companion_runtime_instances
          set settings_checkpoint = 'applied', settings_checkpoint_sequence = 4,
              settings_claim_material_staged_at = null,
              settings_claim_material_expires_at = null
          where companion_id = ${companionId}::uuid
        `;
        await tx`
          update companion_runtime_leases
          set claimed_at = now() - interval '1 minute',
              renewed_at = now() - interval '2 seconds',
              expires_at = now() - interval '1 second'
          where companion_id = ${companionId}::uuid and lane = 'main'
        `;
      });

      const takeover = await claimWork();
      expect(takeover).toMatchObject({
        companionId,
        workKind: "settings",
        workId: companionId,
        checkpoint: "applying",
        checkpointSequence: "6",
      });
      await release(takeover);
    } finally {
      if (companionId) await removeCompanion(companionId);
    }
  });

  it("restages exactly once when warm material is missing, near expiry, or from another surface", async () => {
    if (!sql) throw new Error("runtime executor database is not initialized");
    const companions: string[] = [];
    try {
      for (const variant of [
        { name: "missing", boxId: "bx_2345678a", surface: "web", materialSurface: null, expires: null },
        { name: "near-expiry", boxId: "bx_2345678b", surface: "web", materialSurface: "web", expires: "2 hours 4 minutes" },
        { name: "native-boundary", boxId: "bx_2345678c", surface: "native_mobile", materialSurface: "web", expires: "6 hours" },
        { name: "native-near-expiry", boxId: "bx_2345678e", surface: "native_mobile", materialSurface: "native_mobile", expires: "2 hours 4 minutes" },
      ] as const) {
        const [created] = await asApi({
          orgId: ids.orgA,
          actorId: ids.ownerA,
          action: (tx) => tx<Array<{ companionId: string }>>`
            select companion_id::text as "companionId"
            from public.companion_api_create_companion(
              ${ids.orgA}::uuid, ${`Material ${variant.name}`}, null, null, null,
              '[]'::jsonb, false, '[]'::jsonb
            )
          `,
        });
        const companionId = created?.companionId ?? "";
        companions.push(companionId);
        await sql`
          update companion_runtime_instances
          set box_id = ${variant.boxId},
              box_state = 'ready', pi_state = 'idle', pi_invocation_id = 'pi-warm-material',
              disk_layout_version = 14, applied_settings_revision = desired_settings_revision,
              applied_skills_revision = 1,
              applied_client_surface = ${variant.surface}::public.companion_client_surface,
              last_observed_at = now()
          where companion_id = ${companionId}::uuid
        `;
        await sql`
          update companion_runtime_instances
          set material_client_surface = ${variant.materialSurface}::public.companion_client_surface,
              material_pi_invocation_id = CASE WHEN ${variant.materialSurface}::text IS NULL
                THEN NULL ELSE 'pi-warm-material' END,
              material_expires_at = CASE WHEN ${variant.expires}::text IS NULL THEN NULL
                ELSE now() + ${variant.expires}::interval END
          where companion_id = ${companionId}::uuid
        `;
        const clientMessageId = randomUUID();
        const [enqueued] = await asApi({
          orgId: ids.orgA,
          actorId: ids.ownerA,
          action: (tx: Tx) => tx<Array<{ operation: IntegrationJsonObject | null }>>`
            select operation from public.companion_api_enqueue_turn(
              ${ids.orgA}::uuid, ${companionId}::uuid, ${clientMessageId}::uuid,
              ${`Restage ${variant.name}`},
              ${variant.surface}::public.companion_client_surface, '[]'::jsonb
            )
          `,
        });
        expect(enqueued?.operation).toMatchObject({ kind: "start", status: "pending" });

        const [replayed] = await asApi({
          orgId: ids.orgA,
          actorId: ids.ownerA,
          action: (tx: Tx) => tx<Array<{ replayed: boolean }>>`
            select replayed from public.companion_api_enqueue_turn(
              ${ids.orgA}::uuid, ${companionId}::uuid, ${clientMessageId}::uuid,
              ${`Restage ${variant.name}`},
              ${variant.surface}::public.companion_client_surface, '[]'::jsonb
            )
          `,
        });
        expect(replayed).toEqual({ replayed: true });
        const [count] = await sql<Array<{ count: number }>>`
          select count(*)::int as count from companion_operations
          where companion_id = ${companionId}::uuid and kind = 'start'
        `;
        expect(count).toEqual({ count: 1 });
      }
    } finally {
      for (const companionId of companions) await removeCompanion(companionId);
    }
  });

  it("rechecks the material reserve at claim time for a turn that waited in the warm queue", async () => {
    if (!sql) throw new Error("runtime executor database is not initialized");
    let companionId = "";
    try {
      const [created] = await asApi({
        orgId: ids.orgA,
        actorId: ids.ownerA,
        action: (tx) => tx<Array<{ companionId: string }>>`
          select companion_id::text as "companionId"
          from public.companion_api_create_companion(
            ${ids.orgA}::uuid, 'Queued material expiry', null, null, null,
            '[]'::jsonb, false, '[]'::jsonb
          )
        `,
      });
      companionId = created?.companionId ?? "";
      await sql`
        update companion_runtime_instances
        set box_id = 'bx_2345678d', box_state = 'ready', pi_state = 'idle',
            pi_invocation_id = 'pi-queued-material', disk_layout_version = 14,
            applied_settings_revision = desired_settings_revision,
            applied_skills_revision = 1, applied_client_surface = 'web',
            last_observed_at = now()
        where companion_id = ${companionId}::uuid
      `;
      await sql`
        update companion_runtime_instances
        set material_client_surface = 'web', material_pi_invocation_id = 'pi-queued-material',
            material_expires_at = now() + interval '6 hours'
        where companion_id = ${companionId}::uuid
      `;
      const clientMessageId = randomUUID();
      const [enqueued] = await asApi({
        orgId: ids.orgA,
        actorId: ids.ownerA,
          action: (tx: Tx) => tx<Array<{ operation: IntegrationJsonObject | null }>>`
          select operation from public.companion_api_enqueue_turn(
            ${ids.orgA}::uuid, ${companionId}::uuid, ${clientMessageId}::uuid,
            'Wait beyond the material reserve', 'web', '[]'::jsonb
          )
        `,
      });
      expect(enqueued?.operation).toBeNull();

      await sql`
        update companion_runtime_instances
        set material_expires_at = now() + interval '2 hours 4 minutes'
        where companion_id = ${companionId}::uuid
      `;
      const claim = await claimWork();
      expect(claim).toMatchObject({ companionId, workKind: "operation" });
      const [operation] = await sql<Array<{ kind: string; sourceTurnId: string }>>`
        select kind::text as kind, source_turn_id::text as "sourceTurnId"
        from companion_operations where id = ${claim.workId}::uuid
      `;
      expect(operation).toMatchObject({ kind: "start", sourceTurnId: expect.any(String) });
      await release(claim);
    } finally {
      if (companionId) await removeCompanion(companionId);
    }
  });

  it("claims a warm main turn when installed Skills are ahead of its required revision", async () => {
    if (!sql) throw new Error("runtime executor database is not initialized");
    let companionId = "";
    try {
      const [created] = await asApi({
        orgId: ids.orgA,
        actorId: ids.ownerA,
        action: (tx) => tx<Array<{ companionId: string }>>`
          select companion_id::text as "companionId"
          from public.companion_api_create_companion(
            ${ids.orgA}::uuid, 'Ahead Skills material', null, null, null,
            '[]'::jsonb, false, '[]'::jsonb
          )
        `,
      });
      companionId = created?.companionId ?? "";
      await sql`
        update companion_runtime_instances instance
        set box_id = 'bx_2345678f', box_state = 'ready', pi_state = 'idle',
            pi_invocation_id = 'pi-ahead-skills', disk_layout_version = 14,
            applied_settings_revision = desired_settings_revision,
            applied_skills_revision = companion.skills_revision,
            applied_client_surface = 'web', last_observed_at = now()
        from companions companion
        where instance.companion_id = ${companionId}::uuid
          and companion.org_id = instance.org_id
          and companion.id = instance.companion_id
      `;
      await sql`
        update companion_runtime_instances
        set material_client_surface = 'web', material_pi_invocation_id = 'pi-ahead-skills',
            material_expires_at = now() + interval '6 hours'
        where companion_id = ${companionId}::uuid
      `;

      const [enqueued] = await asApi({
        orgId: ids.orgA,
        actorId: ids.ownerA,
        action: (tx: Tx) => tx<Array<{
          operation: IntegrationJsonObject | null;
          turn: { id: string };
        }>>`
          select operation, turn from public.companion_api_enqueue_turn(
            ${ids.orgA}::uuid, ${companionId}::uuid, ${randomUUID()}::uuid,
            'Use the already-installed Skills revision.', 'web', '[]'::jsonb
          )
        `,
      });
      expect(enqueued?.operation).toBeNull();

      // A deferred Skill publication may advance the installed snapshot while this warm turn is
      // queued. Refresh the material proof after that activation: ahead-of-required is still warm.
      await sql`
        update companion_runtime_instances
        set applied_skills_revision = applied_skills_revision + 1
        where companion_id = ${companionId}::uuid
      `;
      await sql`
        update companion_runtime_instances
        set material_client_surface = 'web', material_pi_invocation_id = pi_invocation_id,
            material_expires_at = now() + interval '6 hours', last_observed_at = now()
        where companion_id = ${companionId}::uuid
      `;

      const claim = await claimWork();
      expect(claim).toMatchObject({
        companionId,
        workKind: "attempt",
        workId: expect.any(String),
      });
      await release(claim);
    } finally {
      if (companionId) await removeCompanion(companionId);
    }
  });

  it.each([
    { from: "native_mobile", to: "web", oldPi: "pi-old-native", newPi: "pi-new-web" },
    { from: "web", to: "native_mobile", oldPi: "pi-old-web", newPi: "pi-new-native" },
  ] as const)("invalidates a $from snapshot when an old executor observes a new $to Pi", async ({
    from,
    to,
    oldPi,
    newPi,
  }) => {
    if (!sql) throw new Error("runtime executor database is not initialized");
    let companionId = "";
    try {
      const [created] = await asApi({
        orgId: ids.orgA,
        actorId: ids.ownerA,
        action: (tx) => tx<Array<{ companionId: string }>>`
          select companion_id::text as "companionId"
          from public.companion_api_create_companion(
            ${ids.orgA}::uuid, ${`Mixed runtime ${from} to ${to}`}, null, null, null,
            '[]'::jsonb, false, '[]'::jsonb
          )
        `,
      });
      companionId = created?.companionId ?? "";
      await sql`
        update companion_runtime_instances
        set box_id = 'bx_2345678e', box_state = 'ready', pi_state = 'idle',
            pi_invocation_id = ${oldPi}, disk_layout_version = 14,
            applied_settings_revision = desired_settings_revision,
            applied_skills_revision = 1,
            applied_client_surface = ${from}::public.companion_client_surface,
            last_observed_at = now()
        where companion_id = ${companionId}::uuid
      `;
      await sql`
        update companion_runtime_instances
        set material_client_surface = ${from}::public.companion_client_surface,
            material_pi_invocation_id = ${oldPi},
            material_expires_at = now() + interval '6 hours'
        where companion_id = ${companionId}::uuid
      `;

      // This is the observation shape an executor deployed before 0110 can still write.
      await sql`
        update companion_runtime_instances
        set pi_invocation_id = ${newPi},
            applied_client_surface = ${to}::public.companion_client_surface,
            last_observed_at = now()
        where companion_id = ${companionId}::uuid
      `;
      const [invalidated] = await sql<Array<{
        surface: string | null;
        piInvocationId: string | null;
        expiresAt: Date | null;
      }>>`
        select material_client_surface::text as surface,
          material_pi_invocation_id as "piInvocationId", material_expires_at as "expiresAt"
        from companion_runtime_instances where companion_id = ${companionId}::uuid
      `;
      expect(invalidated).toEqual({ surface: null, piInvocationId: null, expiresAt: null });

      const [enqueued] = await asApi({
        orgId: ids.orgA,
        actorId: ids.ownerA,
          action: (tx: Tx) => tx<Array<{ operation: IntegrationJsonObject | null }>>`
          select operation from public.companion_api_enqueue_turn(
            ${ids.orgA}::uuid, ${companionId}::uuid, ${randomUUID()}::uuid,
            'Mixed runtime send', ${to}::public.companion_client_surface, '[]'::jsonb
          )
        `,
      });
      expect(enqueued?.operation).toMatchObject({ kind: "start", status: "pending" });
    } finally {
      if (companionId) await removeCompanion(companionId);
    }
  });

  it("publishes staged material only after the claimed operation observes a new idle Pi", async () => {
    if (!sql) throw new Error("runtime executor database is not initialized");
    let companionId = "";
    try {
      const [created] = await asApi({
        orgId: ids.orgA,
        actorId: ids.ownerA,
        action: (tx) => tx<Array<{ companionId: string }>>`
          select companion_id::text as "companionId"
          from public.companion_api_create_companion(
            ${ids.orgA}::uuid, 'Material activation proof', null, null, null,
            '[]'::jsonb, false, '[]'::jsonb
          )
        `,
      });
      companionId = created?.companionId ?? "";
      await asApi({
        orgId: ids.orgA,
        actorId: ids.ownerA,
        action: (tx) => tx`
          select * from public.companion_api_enqueue_operation(
            ${ids.orgA}::uuid, ${companionId}::uuid, ${randomUUID()}::uuid,
            'start', 'web'
          )
        `,
      });
      const claim = await claimWork();
      expect(claim).toMatchObject({ companionId, workKind: "operation" });

      // Fault-injection fixture: staging committed, but Pi has not restarted yet.
      await sql`
        update companion_operations set checkpoint = 'installing_layout'
        where id = ${claim.workId}::uuid
      `;
      const expiresAt = new Date(Date.now() + 6 * 60 * 60 * 1_000);
      const [recorded] = await asRuntime((tx) => tx<Array<{ recorded: boolean }>>`
        select public.companion_runtime_record_material_snapshot(
          ${claim.orgId}::uuid, ${claim.companionId}::uuid, ${claim.claimToken}::uuid,
          ${claim.claimEpoch}::bigint, ${claim.gateEpoch}::bigint, ${executorId},
          ${claim.workKind}, ${claim.workId}::uuid, 'web', ${expiresAt},
          'https://abc-8790.on.ascii.dev', 'agent-ciphertext'
        ) as recorded
      `);
      expect(recorded).toEqual({ recorded: true });
      const [beforePi] = await sql<Array<{ surface: string | null; expiresAt: Date | null }>>`
        select material_client_surface::text as surface, material_expires_at as "expiresAt"
        from companion_runtime_instances where companion_id = ${companionId}::uuid
      `;
      expect(beforePi).toEqual({ surface: null, expiresAt: null });
      // The hosted agent endpoint publishes with the fenced record itself: it is per-Box state,
      // deliberately not gated on the Pi invocation the material snapshot waits for.
      const [agentEndpoint] = await sql<Array<{
        hostedUrl: string | null;
        tokenCiphertext: string | null;
        observed: boolean;
      }>>`
        select agent_hosted_url as "hostedUrl", agent_token_ciphertext as "tokenCiphertext",
          agent_observed_at is not null as observed
        from companion_runtime_instances where companion_id = ${companionId}::uuid
      `;
      expect(agentEndpoint).toEqual({
        hostedUrl: "https://abc-8790.on.ascii.dev",
        tokenCiphertext: "agent-ciphertext",
        observed: true,
      });

      const publish = (piInvocationId: string) => asRuntime((tx) => tx<Array<{
        published: boolean;
      }>>`
        select public.companion_runtime_publish_material_snapshot(
          ${claim.orgId}::uuid, ${claim.companionId}::uuid, ${claim.claimToken}::uuid,
          ${claim.claimEpoch}::bigint, ${claim.gateEpoch}::bigint, ${executorId},
          ${claim.workKind}, ${claim.workId}::uuid, ${piInvocationId}
        ) as published
      `);
      expect(await publish("pi-not-observed")).toEqual([{ published: false }]);

      await sql.begin(async (tx) => {
        await tx`
          update companion_operations set checkpoint = 'pi_observed'
          where id = ${claim.workId}::uuid
        `;
        await tx`
          update companion_runtime_instances
          set pi_state = 'idle', pi_invocation_id = 'pi-material-new'
          where companion_id = ${companionId}::uuid
        `;
      });
      expect(await publish("pi-material-new")).toEqual([{ published: true }]);
      expect(await publish("pi-old")).toEqual([{ published: false }]);
      const [activated] = await sql<Array<{ surface: string; expiresAt: Date }>>`
        select material_client_surface::text as surface, material_expires_at as "expiresAt"
        from companion_runtime_instances where companion_id = ${companionId}::uuid
      `;
      expect(activated?.surface).toBe("web");
      expect(activated?.expiresAt.toISOString()).toBe(expiresAt.toISOString());
      await release(claim);
    } finally {
      if (companionId) await removeCompanion(companionId);
    }
  });

  it("preserves settings material across takeover but clears it at the claim boundary", async () => {
    if (!sql) throw new Error("runtime executor database is not initialized");
    const runtimeSql = sql;
    let companionId = "";
    try {
      const [created] = await asApi({
        orgId: ids.orgA,
        actorId: ids.ownerA,
        action: (tx) => tx<Array<{ companionId: string }>>`
          select companion_id::text as "companionId"
          from public.companion_api_create_companion(
            ${ids.orgA}::uuid, 'Settings material takeover', null, null, null,
            '[]'::jsonb, false, '[]'::jsonb
          )
        `,
      });
      companionId = created?.companionId ?? "";

      // Starting genuinely new settings work clears any value a caller attempted to carry across
      // the unclaimed boundary. Recording happens only after the new claim exists.
      await runtimeSql`
        update companion_runtime_instances
        set settings_claim_epoch = 11,
            settings_claim_actor_id = ${ids.ownerA},
            settings_claim_client_surface = 'web',
            settings_claim_revision = desired_settings_revision,
            settings_claim_skills_revision = 1,
            settings_claim_can_write_skills = false,
            settings_claim_provider_ids = '[]'::jsonb,
            settings_claim_selected_skill_ids = '[]'::jsonb,
            settings_claim_skill_refs = '[]'::jsonb,
            settings_claim_selected_mcp_account_ids = '[]'::jsonb,
            settings_claim_material_client_surface = 'web',
            settings_claim_material_staged_at = now(),
            settings_claim_material_expires_at = now() + interval '6 hours'
        where companion_id = ${companionId}::uuid
      `;
      const readStaged = () => runtimeSql<Array<{
        epoch: number | null;
        surface: string | null;
        stagedAt: Date | null;
      }>>`
        select settings_claim_epoch::int as epoch,
          settings_claim_material_client_surface::text as surface,
          settings_claim_material_staged_at as "stagedAt"
        from companion_runtime_instances where companion_id = ${companionId}::uuid
      `;
      expect(await readStaged()).toEqual([{ epoch: 11, surface: null, stagedAt: null }]);

      await runtimeSql`
        update companion_runtime_instances
        set settings_claim_material_client_surface = 'web',
            settings_claim_material_staged_at = now(),
            settings_claim_material_expires_at = now() + interval '6 hours'
        where companion_id = ${companionId}::uuid
      `;
      await runtimeSql`
        update companion_runtime_instances set settings_claim_epoch = 12
        where companion_id = ${companionId}::uuid
      `;
      const [takenOver] = await readStaged();
      expect(takenOver).toMatchObject({ epoch: 12, surface: "web" });
      expect(takenOver?.stagedAt).toBeInstanceOf(Date);

      await runtimeSql`
        update companion_runtime_instances
        set settings_claim_epoch = null,
            settings_claim_actor_id = null,
            settings_claim_client_surface = null,
            settings_claim_revision = null,
            settings_claim_skills_revision = null,
            settings_claim_can_write_skills = null,
            settings_claim_provider_ids = null,
            settings_claim_selected_skill_ids = null,
            settings_claim_skill_refs = null,
            settings_claim_selected_mcp_account_ids = null
        where companion_id = ${companionId}::uuid
      `;
      expect(await readStaged()).toEqual([{ epoch: null, surface: null, stagedAt: null }]);
    } finally {
      if (companionId) await removeCompanion(companionId);
    }
  });

  it("records and publishes settings material through a real lease takeover", async () => {
    if (!sql) throw new Error("runtime executor database is not initialized");
    let companionId = "";
    try {
      const [created] = await asApi({
        orgId: ids.orgA,
        actorId: ids.ownerA,
        action: (tx) => tx<Array<{ companionId: string }>>`
          select companion_id::text as "companionId"
          from public.companion_api_create_companion(
            ${ids.orgA}::uuid, 'Settings material functions', null, null, null,
            '[]'::jsonb, false, '[]'::jsonb
          )
        `,
      });
      companionId = created?.companionId ?? "";
      await sql`
        update companion_runtime_instances
        set box_id = 'bx_2345678g', box_state = 'ready', pi_state = 'idle',
            pi_invocation_id = 'pi-settings-old', disk_layout_version = 14,
            last_observed_at = now(), health_due_at = now() + interval '1 day'
        where companion_id = ${companionId}::uuid
      `;

      const firstClaim = await claimWork();
      expect(firstClaim).toMatchObject({ companionId, workKind: "settings", workId: companionId });
      const expiresAt = new Date(Date.now() + 6 * 60 * 60 * 1_000);
      const record = (claim: Claim) => asRuntime((tx) => tx<Array<{ recorded: boolean }>>`
        select public.companion_runtime_record_material_snapshot(
          ${claim.orgId}::uuid, ${claim.companionId}::uuid, ${claim.claimToken}::uuid,
          ${claim.claimEpoch}::bigint, ${claim.gateEpoch}::bigint, ${executorId},
          ${claim.workKind}, ${claim.workId}::uuid, 'web', ${expiresAt},
          null, null
        ) as recorded
      `);
      expect(await record(firstClaim)).toEqual([{ recorded: true }]);
      await release(firstClaim);

      const takeover = await claimWork();
      expect(takeover).toMatchObject({ companionId, workKind: "settings", workId: companionId });
      expect(BigInt(takeover.claimEpoch)).toBeGreaterThan(BigInt(firstClaim.claimEpoch));
      const publish = (claim: Claim, piInvocationId: string) => asRuntime((tx) => tx<Array<{
        published: boolean;
      }>>`
        select public.companion_runtime_publish_material_snapshot(
          ${claim.orgId}::uuid, ${claim.companionId}::uuid, ${claim.claimToken}::uuid,
          ${claim.claimEpoch}::bigint, ${claim.gateEpoch}::bigint, ${executorId},
          ${claim.workKind}, ${claim.workId}::uuid, ${piInvocationId}
        ) as published
      `);
      expect(await publish(takeover, "pi-settings-old")).toEqual([{ published: false }]);

      await sql`
        update companion_runtime_instances
        set settings_checkpoint = 'applied', settings_checkpoint_sequence = 1,
            pi_state = 'idle', pi_invocation_id = 'pi-settings-new',
            applied_settings_revision = desired_settings_revision,
            applied_skills_revision = 1, applied_client_surface = 'web',
            last_observed_at = now()
        where companion_id = ${companionId}::uuid
      `;
      expect(await publish(takeover, "pi-settings-new")).toEqual([{ published: true }]);
      const [activated] = await sql<Array<{
        surface: string;
        piInvocationId: string;
        expiresAt: Date;
      }>>`
        select material_client_surface::text as surface,
          material_pi_invocation_id as "piInvocationId", material_expires_at as "expiresAt"
        from companion_runtime_instances where companion_id = ${companionId}::uuid
      `;
      expect(activated?.surface).toBe("web");
      expect(activated?.piInvocationId).toBe("pi-settings-new");
      expect(activated?.expiresAt.toISOString()).toBe(expiresAt.toISOString());
      await release(takeover);
    } finally {
      if (companionId) await removeCompanion(companionId);
    }
  });

  it("still enqueues a start operation when the cached warm observation is stale", async () => {
    if (!sql) throw new Error("runtime executor database is not initialized");
    let companionId = "";
    try {
      const created = await asApi({
        orgId: ids.orgA,
        actorId: ids.ownerA,
        action: (tx) => tx<Array<{ companionId: string }>>`
          select companion_id::text as "companionId"
          from public.companion_api_create_companion(
            ${ids.orgA}::uuid, 'Stale warm send fixture', null, null, null,
            '[]'::jsonb, false, '[]'::jsonb
          )
        `,
      });
      companionId = created[0]?.companionId ?? "";

      // Same cached box_state='ready'/pi_state='idle' as a genuinely warm instance, but the last
      // observation is older than the periodic health check's own cadence: nothing has re-verified
      // Pi is still actually alive recently enough to trust for a direct dispatch.
      await sql`
        update companion_runtime_instances
        set box_id = 'bx_2345678s', box_state = 'ready', pi_state = 'idle',
          pi_invocation_id = 'pi-stale-observed', disk_layout_version = 14,
          applied_settings_revision = desired_settings_revision,
          applied_skills_revision = 1, applied_client_surface = 'web',
          last_observed_at = now() - interval '10 minutes'
        where companion_id = ${companionId}::uuid
      `;

      const clientMessageId = randomUUID();
      const enqueued = await asApi({
        orgId: ids.orgA,
        actorId: ids.ownerA,
        action: (tx: Tx) => tx<Array<{
          turn: IntegrationJsonObject;
          operation: IntegrationJsonObject | null;
          replayed: boolean;
        }>>`
          select * from public.companion_api_enqueue_turn(
            ${ids.orgA}::uuid, ${companionId}::uuid, ${clientMessageId}::uuid,
            'Stale observation still needs a start', 'web', '[]'::jsonb
          )
        `,
      });
      expect(enqueued[0]?.operation).toMatchObject({ kind: "start", status: "pending" });

      const [operationCount] = await sql<Array<{ count: number }>>`
        select count(*)::int as count from companion_operations
        where companion_id = ${companionId}::uuid
      `;
      expect(operationCount).toEqual({ count: 1 });
    } finally {
      if (companionId) await removeCompanion(companionId);
    }
  });

  it("accepts only exact sequential and concurrent client_message_id replays", async () => {
    if (!sql) throw new Error("runtime executor database is not initialized");
    let companionId = "";
    try {
      const [created] = await asApi({
        orgId: ids.orgA,
        actorId: ids.ownerA,
        action: (tx) => tx<Array<{ companionId: string }>>`
          select companion_id::text as "companionId"
          from public.companion_api_create_companion(
            ${ids.orgA}::uuid, 'Concurrent enqueue fixture', null, null, null,
            '[]'::jsonb, false, '[]'::jsonb
          )
        `,
      });
      companionId = created?.companionId ?? "";
      await asApi({
        orgId: ids.orgA,
        actorId: ids.ownerA,
        action: (tx) => tx`
          select * from public.companion_api_set_workspace_access(
            ${ids.orgA}::uuid, ${companionId}::uuid, 'editor'
          )
        `,
      });

      const clientMessageId = randomUUID();
      const enqueue = (
        actorId = ids.editorA,
        content = "Concurrent durable message",
        surface: "web" | "mobile_web" = "web",
      ) => asApi({
        orgId: ids.orgA,
        actorId,
        action: (tx: Tx) => tx<Array<{
          turn: IntegrationJsonObject;
          replayed: boolean;
        }>>`
          select turn, replayed from public.companion_api_enqueue_turn(
            ${ids.orgA}::uuid, ${companionId}::uuid, ${clientMessageId}::uuid,
            ${content}, ${surface}::companion_client_surface, '[]'::jsonb
          )
        `,
      });

      const concurrent = await Promise.all([enqueue(), enqueue()]);
      expect(concurrent.flatMap((result) => result.map((row) => row.replayed)).sort())
        .toEqual([false, true]);
      expect(new Set(concurrent.flatMap((result) => result.map((row) => row.turn.id))).size).toBe(1);
      await expect(enqueue(ids.editorA, "  Concurrent durable message  "))
        .resolves.toEqual([expect.objectContaining({ replayed: true })]);

      await expect(enqueue(ids.editorA, "Different content"))
        .rejects.toMatchObject({ code: "23505" });
      await expect(enqueue(ids.editorA, "Concurrent durable message", "mobile_web"))
        .rejects.toMatchObject({ code: "23505" });
      await expect(enqueue(ids.ownerA))
        .rejects.toMatchObject({ code: "23505" });

      const [stored] = await sql<Array<{ turns: number; messages: number; operations: number }>>`
        select
          (select count(*)::int from companion_turns
            where companion_id = ${companionId}::uuid) as turns,
          (select count(*)::int from companion_transcript_entries
            where companion_id = ${companionId}::uuid and role = 'user') as messages,
          (select count(*)::int from companion_operations
            where companion_id = ${companionId}::uuid) as operations
      `;
      expect(stored).toEqual({ turns: 1, messages: 1, operations: 1 });
    } finally {
      if (companionId) await removeCompanion(companionId);
    }
  });

  it("releases an interrupted occurrence and claims the next turn without replay", async () => {
    if (!sql) throw new Error("runtime executor database is not initialized");
    const fixture = await createCompanion({ boxReady: true });
    let activeClaim: Claim | undefined;
    let nextClaim: Claim | undefined;
    try {
      activeClaim = await claimWork();
      expect(activeClaim).toMatchObject({
        companionId: fixture.companionId,
        workKind: "attempt",
        workId: fixture.attemptId,
      });
      const nextClientMessageId = randomUUID();
      const [next] = await asApi({
        orgId: ids.orgA,
        actorId: ids.ownerA,
        action: (tx) => tx<Array<{ turn: { id: string } }>>`
          select turn from public.companion_api_enqueue_turn(
            ${ids.orgA}::uuid, ${fixture.companionId}::uuid,
            ${nextClientMessageId}::uuid, 'Continue after interruption.', 'web', '[]'::jsonb
          )
        `,
      });
      const nextTurnId = stringValue(next?.turn.id);
      if (nextTurnId === null) throw new Error("expected the next durable turn");

      await sql`
        update companion_turn_attempts
        set status = 'interrupted', checkpoint = 'dispatch_ambiguous', settled_at = now(),
          last_error_code = 'dispatch_ambiguous',
          last_error_message = 'Pi acceptance could not be proven.',
          last_error_action = 'none', updated_at = now()
        where id = ${fixture.attemptId}::uuid
      `;
      await sql`
        update companion_turns
        set status = 'interrupted', inactivity_deadline_at = null,
          absolute_deadline_at = now(), settled_at = now(), state_changed_at = now(),
          last_error_code = 'dispatch_ambiguous',
          last_error_message = 'Pi acceptance could not be proven.',
          last_error_action = 'none', updated_at = now()
        where id = ${fixture.turnId}::uuid
      `;
      await release(activeClaim);
      activeClaim = undefined;

      const [history] = await sql<Array<{
        status: string;
        resolution: string | null;
        errorAction: string;
        recoveries: number;
      }>>`
        select turn_row.status::text as status, turn_row.resolution,
          turn_row.last_error_action::text as "errorAction",
          count(operation.id)::integer as recoveries
        from companion_turns turn_row
        left join companion_operations operation
          on operation.source_turn_id = turn_row.id
          and operation.kind = 'restart_pi'
          and operation.trigger = 'recovery'
        where turn_row.id = ${fixture.turnId}::uuid
        group by turn_row.status, turn_row.resolution, turn_row.last_error_action
      `;
      expect(history).toEqual({
        status: "interrupted",
        resolution: "auto_abandoned",
        errorAction: "none",
        recoveries: 0,
      });

      nextClaim = await claimWork();
      expect(nextClaim).toMatchObject({
        companionId: fixture.companionId,
        workKind: "operation",
      });
      const [start] = await sql<Array<{ kind: string; sourceTurnId: string | null }>>`
        select kind::text as kind, source_turn_id::text as "sourceTurnId"
        from companion_operations where id = ${nextClaim.workId}::uuid
      `;
      expect(start).toEqual({ kind: "start", sourceTurnId: nextTurnId });
    } finally {
      if (activeClaim) await release(activeClaim);
      if (nextClaim) await release(nextClaim);
      await removeCompanion(fixture.companionId);
    }
  });

  it("atomically cancels a queued turn and its pending cold-start derivative", async () => {
    if (!sql) throw new Error("runtime executor database is not initialized");
    const fixture = await createCompanion({
      boxReady: false,
      selectedSkillIds: [],
      selectedMcpAccountIds: [],
    });
    try {
      await sql`
        update companion_turn_attempts
        set status = 'cancelled', settled_at = now(), updated_at = now()
        where id = ${fixture.attemptId}::uuid
      `;
      await sql`
        update companion_turns
        set status = 'cancelled', settled_at = now(), state_changed_at = now(), updated_at = now()
        where id = ${fixture.turnId}::uuid
      `;

      const [enqueued] = await asApi({
        orgId: ids.orgA,
        actorId: ids.ownerA,
        action: (tx) => tx<Array<{ turn: { id: string }; operation: { id: string } }>>`
          select turn, operation from public.companion_api_enqueue_turn(
            ${ids.orgA}::uuid, ${fixture.companionId}::uuid, ${randomUUID()}::uuid,
            'Cancel this cold queued message.', 'web', '[]'::jsonb
          )
        `,
      });
      const turnId = stringValue(enqueued?.turn.id);
      const startId = stringValue(enqueued?.operation.id);
      if (turnId === null || startId === null) {
        throw new Error("expected a queued turn and its cold-start operation");
      }

      const [cancelled] = await asApi({
        orgId: ids.orgA,
        actorId: ids.ownerA,
        action: (tx) => tx<Array<{ turn: { status: string } }>>`
          select turn from public.companion_api_cancel_turn(
            ${ids.orgA}::uuid, ${fixture.companionId}::uuid, ${turnId}::uuid
          )
        `,
      });
      expect(cancelled?.turn.status).toBe("cancelled");
      const [derivative] = await sql<Array<{ status: string; settledAt: Date | null }>>`
        select status::text as status, settled_at as "settledAt"
        from companion_operations where id = ${startId}::uuid
      `;
      expect(derivative).toEqual({ status: "cancelled", settledAt: expect.any(Date) });
    } finally {
      await removeCompanion(fixture.companionId);
    }
  });

  it("dequeues a follow-up immediately and asks the executor to stop an accepted turn", async () => {
    if (!sql) throw new Error("runtime executor database is not initialized");
    const fixture = await createCompanion({ boxReady: true });
    let claimed: Claim | undefined;
    try {
      const followUpId = randomUUID();
      const [enqueued] = await asApi({
        orgId: ids.orgA,
        actorId: ids.ownerA,
        action: (tx) => tx<Array<{ turn: { id: string; status: string } }>>`
          select turn from public.companion_api_enqueue_turn(
            ${ids.orgA}::uuid, ${fixture.companionId}::uuid, ${followUpId}::uuid,
            'Then this', 'web', '[]'::jsonb
          )
        `,
      });
      const followUpTurnId = stringValue(enqueued?.turn.id);
      if (followUpTurnId === null) throw new Error("expected a queued follow-up");
      expect(enqueued?.turn.status).toBe("queued");

      const [queuedThread] = await asApi({
        orgId: ids.orgA,
        actorId: ids.ownerA,
        action: (tx) => tx<Array<{
          entries: Array<{ content: string; queued: boolean; turn_id: string | null }>;
          queuedCount: number;
        }>>`
          select entries, queued_count as "queuedCount"
          from public.companion_api_read_thread(${ids.orgA}::uuid, ${fixture.companionId}::uuid)
        `,
      });
      expect(queuedThread?.queuedCount).toBe(1);
      expect(queuedThread?.entries).toEqual(expect.arrayContaining([
        expect.objectContaining({
          content: fixture.prompt,
          queued: false,
          turn_id: fixture.turnId,
        }),
        expect.objectContaining({
          content: "Then this",
          queued: true,
          turn_id: followUpTurnId,
        }),
      ]));

      const [dequeued] = await asApi({
        orgId: ids.orgA,
        actorId: ids.ownerA,
        action: (tx) => tx<Array<{ turn: { status: string } }>>`
          select turn from public.companion_api_cancel_turn(
            ${ids.orgA}::uuid, ${fixture.companionId}::uuid, ${followUpTurnId}::uuid
          )
        `,
      });
      expect(dequeued?.turn.status).toBe("cancelled");
      const [afterDequeue] = await asApi({
        orgId: ids.orgA,
        actorId: ids.ownerA,
        action: (tx) => tx<Array<{
          entries: Array<{ content: string }>;
          queuedCount: number;
        }>>`
          select entries, queued_count as "queuedCount"
          from public.companion_api_read_thread(${ids.orgA}::uuid, ${fixture.companionId}::uuid)
        `,
      });
      expect(afterDequeue?.queuedCount).toBe(0);
      expect(afterDequeue?.entries.map((entry) => entry.content)).toEqual([fixture.prompt]);

      claimed = await claimWork();
      expect(claimed.workKind).toBe("attempt");
      expect(claimed.workId).toBe(fixture.attemptId);
      const lease = claimed;
      const acceptedCommandId = randomUUID();
      const runtimePiInvocationId = `pi-${fixture.attemptId}`;
      const acceptedPiInvocationId = `routine:${fixture.turnId}:invocation`;
      await sql`
        update companion_turn_attempts set
          command_id = ${acceptedCommandId}::uuid,
          pi_invocation_id = ${acceptedPiInvocationId}
        where id = ${fixture.attemptId}::uuid
      `;
      const [resolvableAttempt] = await asRuntime((tx) => tx<Array<{
        commandId: string | null;
        commandPiInvocationId: string | null;
        runtimePiInvocationId: string | null;
      }>>`
        select command_id::text as "commandId",
               command_pi_invocation_id as "commandPiInvocationId",
               pi_invocation_id as "runtimePiInvocationId"
        from public.companion_runtime_renew_and_authorize_v2(
          ${lease.orgId}::uuid, ${lease.companionId}::uuid,
          ${lease.claimToken}::uuid, ${lease.claimEpoch}::bigint,
          ${lease.gateEpoch}::bigint, ${executorId},
          ${lease.workKind}::companion_runtime_work_kind, ${lease.workId}::uuid, 30
        )
      `);
      expect(resolvableAttempt).toEqual({
        commandId: acceptedCommandId,
        commandPiInvocationId: acceptedPiInvocationId,
        runtimePiInvocationId,
      });

      const [stopped] = await asApi({
        orgId: ids.orgA,
        actorId: ids.ownerA,
        action: (tx) => tx<Array<{ turn: { id: string; status: string } }>>`
          select turn from public.companion_api_cancel_turn(
            ${ids.orgA}::uuid, ${fixture.companionId}::uuid, ${fixture.turnId}::uuid
          )
        `,
      });
      expect(stopped?.turn).toEqual(expect.objectContaining({
        id: fixture.turnId,
        status: "running",
      }));
      const [requested] = await sql<Array<{ cancelRequestedAt: Date | null; status: string }>>`
        select cancel_requested_at as "cancelRequestedAt", status::text as status
        from companion_turns where id = ${fixture.turnId}::uuid
      `;
      expect(requested?.status).toBe("running");
      expect(requested?.cancelRequestedAt).toBeInstanceOf(Date);

      const [renewal] = await asRuntime((tx) => tx<Array<{
        authorized: boolean;
        denialCode: string | null;
        boxId: string | null;
      }>>`
        select authorized, denial_code as "denialCode", box_id as "boxId"
        from public.companion_runtime_renew_and_authorize(
          ${lease.orgId}::uuid, ${lease.companionId}::uuid,
          ${lease.claimToken}::uuid, ${lease.claimEpoch}::bigint,
          ${lease.gateEpoch}::bigint, ${executorId},
          ${lease.workKind}::companion_runtime_work_kind, ${lease.workId}::uuid, 30
        )
      `);
      expect(renewal).toEqual({
        authorized: false,
        denialCode: "turn_cancel_requested",
        boxId: "bx_23456789",
      });
      const [resolvedCancellation] = await asRuntime((tx) => tx<Array<{
        authorized: boolean;
        commandId: string | null;
        commandPiInvocationId: string | null;
        denialCode: string | null;
        runtimePiInvocationId: string | null;
      }>>`
        select authorized, denial_code as "denialCode", command_id::text as "commandId",
               command_pi_invocation_id as "commandPiInvocationId",
               pi_invocation_id as "runtimePiInvocationId"
        from public.companion_runtime_renew_and_authorize_v2(
          ${lease.orgId}::uuid, ${lease.companionId}::uuid,
          ${lease.claimToken}::uuid, ${lease.claimEpoch}::bigint,
          ${lease.gateEpoch}::bigint, ${executorId},
          ${lease.workKind}::companion_runtime_work_kind, ${lease.workId}::uuid, 30
        )
      `);
      expect(resolvedCancellation).toEqual({
        authorized: false,
        denialCode: "turn_cancel_requested",
        commandId: null,
        commandPiInvocationId: acceptedPiInvocationId,
        runtimePiInvocationId,
      });
    } finally {
      if (claimed) await release(claimed);
      await removeCompanion(fixture.companionId);
    }
  });

  it("keeps lifecycle authority when a deferred personal Skill update is no longer accessible", async () => {
    if (!sql) throw new Error("runtime executor database is not initialized");
    let companionId = "";
    let claimed: Claim | undefined;
    try {
      const [created] = await asApi({
        orgId: ids.orgA,
        actorId: ids.ownerA,
        action: (tx) => tx<Array<{ companionId: string }>>`
          select companion_id::text as "companionId"
          from public.companion_api_create_companion(
            ${ids.orgA}::uuid, 'Deferred personal Skill fixture', null,
            ${providerId}, 'fixture-model',
            ${tx.json([ids.skill])}::jsonb, false, '[]'::jsonb
          )
        `,
      });
      companionId = created?.companionId ?? "";
      await asApi({
        orgId: ids.orgA,
        actorId: ids.ownerA,
        action: (tx) => tx`
          select * from public.companion_api_set_workspace_access(
            ${ids.orgA}::uuid, ${companionId}::uuid, 'editor'
          )
        `,
      });
      await sql`
        update companion_runtime_instances
        set box_id = 'bx_3456789a', box_state = 'ready', pi_state = 'idle',
          pi_invocation_id = 'pi-deferred-personal', disk_layout_version = 14,
          applied_settings_revision = desired_settings_revision, applied_client_surface = 'web',
          applied_skills_revision = 1,
          applied_selected_skill_ids = ${sql.json([ids.skill])},
          applied_skill_refs = ${sql.json([{
            skill_id: ids.skill,
            current_version_id: ids.skillVersion,
          }])},
          applied_skills_digest = ${"a".repeat(64)}
        where companion_id = ${companionId}::uuid
      `;
      await asApi({
        orgId: ids.orgA,
        actorId: ids.ownerA,
        action: (tx) => tx`
          select public.companion_api_bump_skill_revision(${ids.orgA}::uuid, ${ids.skill}::uuid)
        `,
      });
      await sql`
        update companion_runtime_instances set applied_skills_revision = 2
        where companion_id = ${companionId}::uuid
      `;
      expect(await authorizeDesktop({
        companionId,
        actorId: ids.ownerA,
      })).toMatchObject([{ authorized: true, denialCode: null }]);
      await sql`
        update companion_runtime_instances set applied_skills_revision = 1
        where companion_id = ${companionId}::uuid
      `;
      const [requested] = await asApi({
        orgId: ids.orgA,
        actorId: ids.editorA,
        action: (tx) => tx<Array<{ operation: { id: string } }>>`
          select operation from public.companion_api_enqueue_operation(
            ${ids.orgA}::uuid, ${companionId}::uuid, ${randomUUID()}::uuid,
            'restart_pi', 'web'
          )
        `,
      });
      claimed = await claimWork();
      expect(claimed).toMatchObject({
        companionId,
        workKind: "operation",
        workId: requested?.operation.id,
      });
      const lease = claimed;
      const [renewal] = await asRuntime((tx) => tx<Array<{
        authorized: boolean;
        denialCode: string | null;
        skillRefs: unknown;
      }>>`
        select authorized, denial_code as "denialCode", skill_refs as "skillRefs"
        from public.companion_runtime_renew_and_authorize(
          ${lease.orgId}::uuid, ${lease.companionId}::uuid,
          ${lease.claimToken}::uuid, ${lease.claimEpoch}::bigint,
          ${lease.gateEpoch}::bigint, ${executorId}, 'operation', ${lease.workId}::uuid, 30
        )
      `);
      expect(renewal).toEqual({ authorized: true, denialCode: null, skillRefs: [] });
      const material = await asRuntime((tx) => tx`
        select * from public.companion_runtime_get_skill_update_material(
          ${lease.orgId}::uuid, ${lease.companionId}::uuid,
          ${lease.claimToken}::uuid, ${lease.claimEpoch}::bigint,
          ${lease.gateEpoch}::bigint, ${executorId}, 'operation', ${lease.workId}::uuid, 30
        )
      `);
      expect(material).toEqual([]);
      const [recorded] = await asRuntime((tx) => tx<Array<{ recorded: boolean }>>`
        select public.companion_runtime_record_skill_update_error(
          ${lease.orgId}::uuid, ${lease.companionId}::uuid,
          ${lease.claimToken}::uuid, ${lease.claimEpoch}::bigint,
          ${lease.gateEpoch}::bigint, ${executorId}, 'operation', ${lease.workId}::uuid, 30,
          'skill_auto_update_unauthorized',
          'The pending Skill update is no longer authorized and will be retried later.'
        ) as recorded
      `);
      expect(recorded?.recorded).toBe(true);
    } finally {
      if (claimed) await release(claimed);
      if (companionId) await removeCompanion(companionId);
    }
  });

  it("keeps a pending needs_input wait dormant until its decision or absolute deadline is due", async () => {
    if (!sql) throw new Error("runtime executor database is not initialized");
    const fixture = await createCompanion({ boxReady: true });
    const deliveryId = randomUUID();
    let activeClaim: Claim | null = null;
    try {
      await sql`
        update companion_turn_attempts
        set status = 'needs_input', checkpoint = 'needs_input', updated_at = now()
        where id = ${fixture.attemptId}::uuid
      `;
      await sql`
        update companion_turns
        set status = 'needs_input', inactivity_deadline_at = now() - interval '1 second',
          state_changed_at = now(), updated_at = now()
        where id = ${fixture.turnId}::uuid
      `;
      await sql`
        insert into companion_decision_deliveries(
          id, org_id, companion_id, turn_id, attempt_id,
          request_key, request_kind, expires_at
        ) values (
          ${deliveryId}::uuid, ${ids.orgA}::uuid, ${fixture.companionId}::uuid,
          ${fixture.turnId}::uuid, ${fixture.attemptId}::uuid,
          ${`wait-${deliveryId}`}, 'question', now() + interval '10 minutes'
        )
      `;

      expect(await claimWorkRows(4)).toEqual([]);
      expect(await claimWorkRows(4)).toEqual([]);
      const [dormant] = await sql<Array<{
        inactivityDeadlineAt: Date | null;
        absoluteDeadlineLive: boolean;
        deliveryAttempts: number;
        claimToken: string | null;
      }>>`
        select turn_row.inactivity_deadline_at as "inactivityDeadlineAt",
          turn_row.absolute_deadline_at > now() as "absoluteDeadlineLive",
          delivery.delivery_attempt_count as "deliveryAttempts",
          lease.claim_token::text as "claimToken"
        from companion_turns turn_row
        join companion_decision_deliveries delivery on delivery.id = ${deliveryId}::uuid
        join companion_runtime_leases lease
          on lease.org_id = turn_row.org_id
         and lease.companion_id = turn_row.companion_id
         and lease.lane = 'main'
        where turn_row.id = ${fixture.turnId}::uuid
      `;
      expect(dormant).toEqual({
        inactivityDeadlineAt: null,
        absoluteDeadlineLive: true,
        deliveryAttempts: 0,
        claimToken: null,
      });

      await sql`
        update companion_turns
        set absolute_deadline_at = now() - interval '1 second', updated_at = now()
        where id = ${fixture.turnId}::uuid
      `;
      activeClaim = await claimWork();
      expect(activeClaim).toMatchObject({
        companionId: fixture.companionId,
        workKind: "attempt",
        workId: fixture.attemptId,
      });
      await release(activeClaim);
      activeClaim = null;

      await sql`
        update companion_turns
        set absolute_deadline_at = now() + interval '2 hours', updated_at = now()
        where id = ${fixture.turnId}::uuid
      `;
      await sql`
        update companion_decision_deliveries
        set expires_at = now() - interval '1 second', updated_at = now()
        where id = ${deliveryId}::uuid
      `;
      activeClaim = await claimWork();
      expect(activeClaim).toMatchObject({
        companionId: fixture.companionId,
        workKind: "decision",
        workId: deliveryId,
      });
      const [expired] = await sql<Array<{ status: string; deliveryAttempts: number }>>`
        select decision_status::text as status,
          delivery_attempt_count as "deliveryAttempts"
        from companion_decision_deliveries
        where id = ${deliveryId}::uuid
      `;
      expect(expired).toEqual({ status: "expired", deliveryAttempts: 1 });
    } finally {
      if (activeClaim) await release(activeClaim);
      await removeCompanion(fixture.companionId);
    }
  });

  it("persists decision answers as a durable outbox and updates the PostgreSQL transcript", async () => {
    if (!sql) throw new Error("runtime executor database is not initialized");
    const fixture = await createCompanion({ boxReady: true });
    const requestKey = `question-${randomUUID()}`;
    const deliveryId = randomUUID();
    const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
    try {
      await sql`
        update companion_turn_attempts
        set status = 'needs_input', checkpoint = 'needs_input', updated_at = now()
        where id = ${fixture.attemptId}::uuid
      `;
      await sql`
        update companion_turns
        set status = 'needs_input', state_changed_at = now(), updated_at = now()
        where id = ${fixture.turnId}::uuid
      `;
      const decision = {
        request_id: requestKey,
        kind: "question",
        name: "ask_user",
        title: "Choose a safe direction",
        detail: "The answer must survive a browser disconnect.",
        status: "pending",
        answer: null,
        decided_by_id: null,
        decided_by_name: null,
        decided_at: null,
        expires_at: expiresAt,
      };
      await sql`
        insert into companion_decision_deliveries(
          id, org_id, companion_id, turn_id, attempt_id,
          request_key, request_kind, expires_at
        ) values (
          ${deliveryId}::uuid, ${ids.orgA}::uuid, ${fixture.companionId}::uuid,
          ${fixture.turnId}::uuid, ${fixture.attemptId}::uuid,
          ${requestKey}, 'question', ${expiresAt}
        )
      `;
      await sql`
        insert into companion_transcript_entries(
          org_id, companion_id, event_id, ordinal, role, content, decision
        ) values (
          ${ids.orgA}::uuid, ${fixture.companionId}::uuid,
          ${`decision:${requestKey}`}, 1, 'decision', ${decision.title}, ${sql.json(decision)}
        )
      `;
      await sql`
        update companion_threads set next_ordinal = 2, updated_at = now()
        where companion_id = ${fixture.companionId}::uuid
      `;

      await expect(asApi({
        orgId: ids.orgA,
        actorId: ids.ownerA,
        action: (tx) => tx`
          select * from public.companion_api_answer_decision(
            ${ids.orgA}::uuid, ${fixture.companionId}::uuid,
            ${requestKey}, 'allow', null
          )
        `,
      })).rejects.toMatchObject({ code: "22023" });

      const answer = () => asApi({
        orgId: ids.orgA,
        actorId: ids.ownerA,
        action: (tx: Tx) => tx<Array<{
          deliveryId: string;
          turnId: string;
          decisionStatus: string;
          deliveryState: string;
          respondedAt: Date;
        }>>`
          select delivery_id::text as "deliveryId", turn_id::text as "turnId",
            decision_status::text as "decisionStatus",
            delivery_state::text as "deliveryState", responded_at as "respondedAt"
          from public.companion_api_answer_decision(
            ${ids.orgA}::uuid, ${fixture.companionId}::uuid,
            ${requestKey}, 'answer', 'Use the safe path'
          )
        `,
      });
      const answered = await answer();
      expect(answered).toEqual([{
        deliveryId,
        turnId: fixture.turnId,
        decisionStatus: "answered",
        deliveryState: "pending",
        respondedAt: expect.any(Date),
      }]);
      expect(await answer()).toEqual(answered);
      await expect(asApi({
        orgId: ids.orgA,
        actorId: ids.ownerA,
        action: (tx) => tx`
          select * from public.companion_api_answer_decision(
            ${ids.orgA}::uuid, ${fixture.companionId}::uuid,
            ${requestKey}, 'answer', 'A conflicting replay'
          )
        `,
      })).rejects.toMatchObject({ code: "55000" });

      const [projection] = await sql<Array<{
        actorId: string | null;
        responseText: string | null;
        decisionStatus: string;
        transcriptDecision: IntegrationJsonObject;
      }>>`
        select delivery.actor_id as "actorId", delivery.response_text as "responseText",
          delivery.decision_status::text as "decisionStatus",
          entry.decision as "transcriptDecision"
        from companion_decision_deliveries delivery
        join companion_transcript_entries entry
          on entry.companion_id = delivery.companion_id
         and entry.decision ->> 'request_id' = delivery.request_key
        where delivery.id = ${deliveryId}::uuid
      `;
      expect(projection).toMatchObject({
        actorId: ids.ownerA,
        responseText: "Use the safe path",
        decisionStatus: "answered",
        transcriptDecision: {
          request_id: requestKey,
          status: "answered",
          answer: "Use the safe path",
          decided_by_id: ids.ownerA,
          decided_by_name: "Runtime executor actor 0",
          decided_at: expect.any(String),
        },
      });

      await asApi({
        orgId: ids.orgA,
        actorId: ids.ownerA,
        action: (tx) => tx`
          select * from public.companion_api_set_workspace_access(
            ${ids.orgA}::uuid, ${fixture.companionId}::uuid, 'viewer'
          )
        `,
      });
      await expect(asApi({
        orgId: ids.orgA,
        actorId: ids.viewerA,
        action: (tx) => tx`
          select * from public.companion_api_answer_decision(
            ${ids.orgA}::uuid, ${fixture.companionId}::uuid,
            ${requestKey}, 'answer', 'Use the safe path'
          )
        `,
      })).rejects.toMatchObject({ code: "42501" });
    } finally {
      await removeCompanion(fixture.companionId);
    }
  });

  it("stores config proposals, rejects the generic answer path, and builds a confirm response", async () => {
    if (!sql) throw new Error("runtime executor database is not initialized");
    const fixture = await createCompanion();
    const proposal = {
      kind: "config",
      add_skill_ids: ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"],
    };
    try {
      await expect(sql`
        insert into companion_decision_deliveries(
          org_id, companion_id, turn_id, attempt_id, request_key, request_kind, expires_at
        ) values (
          ${ids.orgA}::uuid, ${fixture.companionId}::uuid,
          ${fixture.turnId}::uuid, ${fixture.attemptId}::uuid,
          'config-missing-proposal', 'config_proposal', now() + interval '5 minutes'
        )
      `).rejects.toMatchObject({ code: "23514" });
      await expect(sql`
        insert into companion_decision_deliveries(
          org_id, companion_id, turn_id, attempt_id, request_key, request_kind, expires_at, proposal
        ) values (
          ${ids.orgA}::uuid, ${fixture.companionId}::uuid,
          ${fixture.turnId}::uuid, ${fixture.attemptId}::uuid,
          'question-with-proposal', 'question', now() + interval '5 minutes',
          ${sql.json(proposal)}
        )
      `).rejects.toMatchObject({ code: "23514" });

      const claim = await claimWork();
      const expiresAt = new Date(Date.now() + 5 * 60_000).toISOString();
      const decision = {
        request_id: "config-1",
        kind: "config",
        name: "config",
        title: "Add the search skill",
        detail: "Add the search skill",
        status: "pending",
        answer: null,
        decided_by_id: null,
        decided_by_name: null,
        decided_at: null,
        expires_at: expiresAt,
        proposal,
      };
      const events = [{
        sequence: "1",
        type: "decision",
        entry_key: "decision:1",
        request_key: "config-1",
        request_kind: "config_proposal",
        content: decision.title,
        proposal,
        decision,
        expires_at: expiresAt,
      }];
      await asRuntime((tx) => tx`
        select * from public.companion_runtime_project_event_batch(
          ${claim.orgId}::uuid, ${claim.companionId}::uuid, ${claim.claimToken}::uuid,
          ${claim.claimEpoch}::bigint, ${claim.gateEpoch}::bigint, ${executorId},
          'attempt', ${claim.workId}::uuid, ${claim.checkpointSequence}::bigint,
          ${`pi-${fixture.attemptId}`}, ${tx.json(events)}, 1, now(), 0, 0, 0
        )
      `);
      const [stored] = await sql<Array<{ kind: string; proposal: unknown }>>`
        select request_kind::text as kind, proposal
        from companion_decision_deliveries
        where attempt_id = ${fixture.attemptId}::uuid and request_key = 'config-1'
      `;
      expect(stored).toEqual({ kind: "config_proposal", proposal });
      const [transcript] = await sql<Array<{ proposal: unknown }>>`
        select decision -> 'proposal' as proposal
        from companion_transcript_entries
        where companion_id = ${fixture.companionId}::uuid and role = 'decision'
      `;
      expect(transcript?.proposal).toEqual(proposal);

      await expect(asApi({
        orgId: ids.orgA,
        actorId: ids.ownerA,
        action: (tx) => tx`
          select * from public.companion_api_answer_decision(
            ${ids.orgA}::uuid, ${fixture.companionId}::uuid,
            'config-1', 'allow', null
          )
        `,
      })).rejects.toMatchObject({ code: "22023" });

      await release(claim);
      await sql`
        update companion_decision_deliveries
        set decision_status = 'allowed', actor_id = ${ids.ownerA},
          responded_at = now(), updated_at = now()
        where attempt_id = ${fixture.attemptId}::uuid and request_key = 'config-1'
      `;
      const decisionClaim = await claimWork();
      expect(decisionClaim.workKind).toBe("decision");
      const response = await asRuntime((tx) => tx<Array<{
        kind: string;
        payload: IntegrationJsonObject;
      }>>`
        select decision_request_kind::text as kind, decision_response_payload as payload
        from public.companion_runtime_get_material(
          ${decisionClaim.orgId}::uuid, ${decisionClaim.companionId}::uuid,
          ${decisionClaim.claimToken}::uuid, ${decisionClaim.claimEpoch}::bigint,
          ${decisionClaim.gateEpoch}::bigint, ${executorId}, 'decision',
          ${decisionClaim.workId}::uuid, 30
        )
      `);
      expect(response).toEqual([{
        kind: "config_proposal",
        payload: { type: "extension_ui_response", id: "config-1", confirmed: true },
      }]);
    } finally {
      await removeCompanion(fixture.companionId);
    }
  });

  it("applies an approved config proposal under the approver and rolls back on validation failure", async () => {
    if (!sql) throw new Error("runtime executor database is not initialized");
    const fixture = await createCompanion({ selectedSkillIds: [ids.skill] });
    const requestKey = "config-apply-1";
    const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
    const proposal: CompanionConfigProposal = {
      kind: "config",
      add_skill_ids: [ids.orgSkill],
      remove_skill_ids: [ids.skill],
    };
    const foreignProposal: CompanionConfigProposal = {
      kind: "config",
      add_skill_ids: [ids.editorSkill],
    };
    const connectProposal: CompanionConfigProposal = {
      kind: "config",
      connect_plugin: {
        server_name: "conductor",
        reason: "Need Conductor workspace access",
      },
    };

    // The module-level handle is optional, and TypeScript does not carry the guard above into a
    // nested closure, so this helper holds the checked handle itself.
    const db = sql;
    async function insertPending(key: string, nextProposal: CompanionConfigProposal): Promise<string> {
      const deliveryId = randomUUID();
      const decision = {
        request_id: key,
        kind: "config",
        name: "config",
        title: "Apply these settings",
        detail: "Apply these settings",
        status: "pending",
        answer: null,
        decided_by_id: null,
        decided_by_name: null,
        decided_at: null,
        expires_at: expiresAt,
        proposal: nextProposal,
      };
      await db`
        update companion_turn_attempts
        set status = 'needs_input', checkpoint = 'needs_input', updated_at = now()
        where id = ${fixture.attemptId}::uuid
      `;
      await db`
        insert into companion_decision_deliveries(
          id, org_id, companion_id, turn_id, attempt_id,
          request_key, request_kind, expires_at, proposal
        ) values (
          ${deliveryId}::uuid, ${ids.orgA}::uuid, ${fixture.companionId}::uuid,
          ${fixture.turnId}::uuid, ${fixture.attemptId}::uuid,
          ${key}, 'config_proposal', ${expiresAt}, ${db.json(nextProposal)}
        )
      `;
      await db`
        insert into companion_transcript_entries(
          org_id, companion_id, event_id, ordinal, role, content, decision
        )
        select ${ids.orgA}::uuid, ${fixture.companionId}::uuid,
          ${`decision:${key}`}, next_ordinal, 'decision', ${decision.title},
          ${db.json(decision)}
        from companion_threads
        where companion_id = ${fixture.companionId}::uuid
      `;
      await db`
        update companion_threads set next_ordinal = next_ordinal + 1, updated_at = now()
        where companion_id = ${fixture.companionId}::uuid
      `;
      return deliveryId;
    }

    try {
      const deliveryId = await insertPending(requestKey, proposal);
      const [read] = await asApi({
        orgId: ids.orgA,
        actorId: ids.ownerA,
        action: (tx) => tx<Array<{
          requestKind: string;
          proposal: unknown;
        }>>`
          select request_kind::text as "requestKind", proposal
          from public.companion_api_get_decision(
            ${ids.orgA}::uuid, ${fixture.companionId}::uuid, ${requestKey}
          )
        `,
      });
      expect(read).toEqual({ requestKind: "config_proposal", proposal });

      await expect(asApi({
        orgId: ids.orgA,
        actorId: ids.ownerA,
        action: (tx) => tx`
          select * from public.companion_api_answer_decision(
            ${ids.orgA}::uuid, ${fixture.companionId}::uuid,
            ${requestKey}, 'allow', null
          )
        `,
      })).rejects.toMatchObject({ code: "22023" });

      const allow = () => asApi({
        orgId: ids.orgA,
        actorId: ids.ownerA,
        action: (tx: Tx) => tx<Array<{
          deliveryId: string;
          decisionStatus: string;
        }>>`
          select delivery_id::text as "deliveryId",
            decision_status::text as "decisionStatus"
          from public.companion_api_answer_config_decision(
            ${ids.orgA}::uuid, ${fixture.companionId}::uuid,
            ${requestKey}, 'allow'
          )
        `,
      });
      const allowed = await allow();
      expect(allowed).toEqual([{ deliveryId, decisionStatus: "allowed" }]);
      expect(await allow()).toEqual(allowed);

      const [applied] = await sql<Array<{
        selectedSkillIds: unknown;
        skillsRevision: number;
        desiredSettingsRevision: number;
      }>>`
        select companion.selected_skill_ids as "selectedSkillIds",
          companion.skills_revision as "skillsRevision",
          instance.desired_settings_revision::int as "desiredSettingsRevision"
        from companions companion
        join companion_runtime_instances instance
          on instance.companion_id = companion.id
        where companion.id = ${fixture.companionId}::uuid
      `;
      expect(applied).toMatchObject({
        selectedSkillIds: [ids.orgSkill],
        skillsRevision: 2,
        desiredSettingsRevision: 2,
      });

      const foreignKey = "config-foreign-1";
      await insertPending(foreignKey, foreignProposal);
      await expect(asApi({
        orgId: ids.orgA,
        actorId: ids.ownerA,
        action: (tx) => tx`
          select * from public.companion_api_answer_config_decision(
            ${ids.orgA}::uuid, ${fixture.companionId}::uuid,
            ${foreignKey}, 'allow'
          )
        `,
      })).rejects.toMatchObject({ code: "22023" });
      const [stillPending] = await sql<Array<{ status: string }>>`
        select decision_status::text as status
        from companion_decision_deliveries
        where companion_id = ${fixture.companionId}::uuid and request_key = ${foreignKey}
      `;
      expect(stillPending).toEqual({ status: "pending" });
      const [unchanged] = await sql<Array<{ selectedSkillIds: unknown }>>`
        select selected_skill_ids as "selectedSkillIds"
        from companions where id = ${fixture.companionId}::uuid
      `;
      expect(unchanged?.selectedSkillIds).toEqual([ids.orgSkill]);

      const connectKey = "config-connect-1";
      const connectId = await insertPending(connectKey, connectProposal);
      const [connected] = await asApi({
        orgId: ids.orgA,
        actorId: ids.ownerA,
        action: (tx) => tx<Array<{ deliveryId: string; decisionStatus: string }>>`
          select delivery_id::text as "deliveryId",
            decision_status::text as "decisionStatus"
          from public.companion_api_answer_config_decision(
            ${ids.orgA}::uuid, ${fixture.companionId}::uuid,
            ${connectKey}, 'allow'
          )
        `,
      });
      expect(connected).toEqual({ deliveryId: connectId, decisionStatus: "allowed" });
      for (const provider of ["slack", "gmail"] as const) {
        const providerKey = `config-connect-${provider}`;
        const providerId = await insertPending(providerKey, {
          kind: "config",
          connect_plugin: {
            server_name: provider,
            reason: `Need ${provider} access`,
          },
        });
        const [providerConnected] = await asApi({
          orgId: ids.orgA,
          actorId: ids.ownerA,
          action: (tx) => tx<Array<{ deliveryId: string; decisionStatus: string }>>`
            select delivery_id::text as "deliveryId",
              decision_status::text as "decisionStatus"
            from public.companion_api_answer_config_decision(
              ${ids.orgA}::uuid, ${fixture.companionId}::uuid,
              ${providerKey}, 'allow'
            )
          `,
        });
        expect(providerConnected).toEqual({
          deliveryId: providerId,
          decisionStatus: "allowed",
        });
      }
      const [afterConnect] = await sql<Array<{
        selectedSkillIds: unknown;
        desiredSettingsRevision: number;
      }>>`
        select companion.selected_skill_ids as "selectedSkillIds",
          instance.desired_settings_revision::int as "desiredSettingsRevision"
        from companions companion
        join companion_runtime_instances instance on instance.companion_id = companion.id
        where companion.id = ${fixture.companionId}::uuid
      `;
      expect(afterConnect).toMatchObject({
        selectedSkillIds: [ids.orgSkill],
        desiredSettingsRevision: 2,
      });

      // A Viewer who really can see this Companion is still refused the editor-gated read, rather
      // than being refused only because the Companion was never shared with them.
      await asApi({
        orgId: ids.orgA,
        actorId: ids.ownerA,
        action: (tx) => tx`
          select * from public.companion_api_set_workspace_access(
            ${ids.orgA}::uuid, ${fixture.companionId}::uuid, 'viewer'
          )
        `,
      });
      await expect(asApi({
        orgId: ids.orgA,
        actorId: ids.viewerA,
        action: (tx) => tx`
          select * from public.companion_api_get_decision(
            ${ids.orgA}::uuid, ${fixture.companionId}::uuid, ${requestKey}
          )
        `,
      })).rejects.toMatchObject({ code: "42501" });
    } finally {
      await removeCompanion(fixture.companionId);
    }
  });

  it("returns a claim-fenced config catalog without credentials", async () => {
    if (!sql) throw new Error("runtime executor database is not initialized");
    const fixture = await createCompanion();
    try {
      const claim = await claimWork();
      const [row] = await asRuntime((tx) => tx<Array<{ catalog: IntegrationJsonObject }>>`
        select catalog
        from public.companion_runtime_get_config_catalog(
          ${claim.orgId}::uuid, ${claim.companionId}::uuid, ${claim.claimToken}::uuid,
          ${claim.claimEpoch}::bigint, ${claim.gateEpoch}::bigint, ${executorId},
          ${claim.workKind}, ${claim.workId}::uuid, 30
        )
      `);
      expect(row?.catalog).toMatchObject({
        companion: {
          model_id: "fixture-model",
          provider_id: providerId,
        },
      });
      const skillsResult = z.array(z.object({
        id: z.string(),
        selected: z.boolean(),
        slug: z.string(),
      })).safeParse(row?.catalog.skills);
      if (!skillsResult.success) throw new Error("runtime catalog skills are invalid");
      const skills = skillsResult.data;
      expect(skills.some((skill) => skill.id === ids.skill && skill.selected)).toBe(true);
      expect(skills.some((skill) => skill.id === ids.orgSkill)).toBe(true);
      expect(JSON.stringify(row?.catalog)).not.toMatch(/ciphertext|wrapped_dek|auth_tag|storage_path/i);
      await release(claim);
    } finally {
      await removeCompanion(fixture.companionId);
    }
  });

  it("pins write-on-behalf true and accepts an ephemeral companion-sourced token", async () => {
    if (!sql) throw new Error("runtime executor database is not initialized");
    let companionId = "";
    const companionTokenId = randomUUID();
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
    try {
      const [created] = await asApi({
        orgId: ids.orgA,
        actorId: ids.ownerA,
        action: (tx) => tx<Array<{ companionId: string }>>`
          select companion_id::text as "companionId"
          from public.companion_api_create_companion(
            ${ids.orgA}::uuid, 'Hub access fixture', null::text,
            null::text, null::text, '[]'::jsonb,
            true, '[]'::jsonb, null::uuid
          )
        `,
      });
      companionId = created?.companionId ?? "";
      // Skills Hub access is unconditional, so the legacy flag can never disagree with the token
      // the Box receives.
      const [initial] = await sql<Array<{ canWriteSkills: boolean }>>`
        select can_write_skills as "canWriteSkills" from companions where id = ${companionId}::uuid
      `;
      expect(initial).toEqual({ canWriteSkills: true });

      await asApi({
        orgId: ids.orgA,
        actorId: ids.ownerA,
        action: (tx) => tx`
          insert into api_tokens (
            id, org_id, user_id, name, token_prefix, token_hash, scopes,
            source_type, source_agent_id, expires_at
          ) values (
            ${companionTokenId}::uuid, ${ids.orgA}::uuid, ${ids.ownerA},
            'Ephemeral companion hub token', 'cmp_pat_hub', ${`hub-${companionTokenId}`},
            ${tx.json([
              "skills:read",
              "skills:write",
              "secrets:read",
              "database:read",
              "database:write",
            ])}::jsonb,
            'companion', ${companionId}, ${expiresAt}
          )
        `,
      });
      const [token] = await sql<Array<{ sourceType: string; sourceAgentId: string }>>`
        select source_type as "sourceType", source_agent_id as "sourceAgentId"
        from api_tokens where id = ${companionTokenId}::uuid
      `;
      expect(token).toEqual({ sourceType: "companion", sourceAgentId: companionId });

      // A companion-sourced token still must name a Companion: provenance stays fail-closed.
      await expect(asApi({
        orgId: ids.orgA,
        actorId: ids.ownerA,
        action: (tx) => tx`
          insert into api_tokens (
            id, org_id, user_id, name, token_prefix, token_hash, scopes,
            source_type, source_agent_id, expires_at
          ) values (
            ${randomUUID()}::uuid, ${ids.orgA}::uuid, ${ids.ownerA},
            'Companion token without provenance', 'cmp_pat_bad', ${`bad-${companionTokenId}`},
            ${tx.json(["skills:read"])}::jsonb, 'companion', null, ${expiresAt}
          )
        `,
      })).rejects.toMatchObject({ code: "23514" });
    } finally {
      if (sql) await sql`delete from api_tokens where id = ${companionTokenId}::uuid`;
      if (companionId) await removeCompanion(companionId);
    }
  });

  it("mints a claim-fenced hub token and rotates the previous one", async () => {
    if (!sql) throw new Error("runtime executor database is not initialized");
    const fixture = await createCompanion();
    try {
      const claim = await claimWork();
      // An expired settings lease may leave its snapshot populated while higher-priority work is
      // claimed. The fenced work actor/surface must win over that stale native-mobile claim.
      await sql`
        update companion_runtime_instances
        set settings_claim_epoch = 77,
            settings_claim_actor_id = ${ids.viewerA},
            settings_claim_client_surface = 'native_mobile',
            settings_claim_revision = desired_settings_revision,
            settings_claim_skills_revision = 1,
            settings_claim_can_write_skills = false,
            settings_claim_provider_ids = '[]'::jsonb,
            settings_claim_selected_skill_ids = '[]'::jsonb,
            settings_claim_skill_refs = '[]'::jsonb,
            settings_claim_selected_mcp_account_ids = '[]'::jsonb
        where companion_id = ${fixture.companionId}::uuid
      `;
      const mint = () => asRuntime((tx) => tx<Array<{ token: string; expiresAt: Date }>>`
        select token, expires_at as "expiresAt"
        from public.companion_runtime_mint_hub_token(
          ${claim.orgId}::uuid, ${claim.companionId}::uuid, ${claim.claimToken}::uuid,
          ${claim.claimEpoch}::bigint, ${claim.gateEpoch}::bigint, ${executorId},
          ${claim.workKind}, ${claim.workId}::uuid, 30
        )
      `);
      const [first] = await mint();
      expect(first?.token).toMatch(/^cmp_pat_[0-9a-f]{48}$/);
      expect(first?.expiresAt.getTime()).toBeGreaterThan(Date.now() + 5 * 60 * 60 * 1_000);
      expect(first?.expiresAt.getTime()).toBeLessThan(Date.now() + 7 * 60 * 60 * 1_000);
      await sql`
        update companion_runtime_instances
        set box_id = 'bx_2345678f', box_state = 'ready', pi_state = 'idle',
            pi_invocation_id = 'pi-hub-mint', disk_layout_version = 14,
            applied_settings_revision = desired_settings_revision,
            applied_skills_revision = 1, applied_client_surface = 'web',
            last_observed_at = now()
        where companion_id = ${fixture.companionId}::uuid
      `;
      await sql`
        update companion_runtime_instances
        set material_client_surface = 'web', material_pi_invocation_id = 'pi-hub-mint',
            material_expires_at = now() + interval '6 hours'
        where companion_id = ${fixture.companionId}::uuid
      `;
      const [second] = await mint();
      expect(second?.token).toMatch(/^cmp_pat_[0-9a-f]{48}$/);
      expect(second?.token).not.toEqual(first?.token);
      const [afterMint] = await sql<Array<{
        surface: string | null;
        piInvocationId: string | null;
        expiresAt: Date | null;
      }>>`
        select material_client_surface::text as surface,
          material_pi_invocation_id as "piInvocationId", material_expires_at as "expiresAt"
        from companion_runtime_instances where companion_id = ${fixture.companionId}::uuid
      `;
      expect(afterMint).toEqual({ surface: null, piInvocationId: null, expiresAt: null });
      const [counts] = await sql<Array<{ live: number; revoked: number }>>`
        select
          count(*) filter (where revoked_at is null)::int as live,
          count(*) filter (where revoked_at is not null)::int as revoked
        from api_tokens
        where source_type = 'companion' and source_agent_id = ${fixture.companionId}
      `;
      expect(counts).toEqual({ live: 1, revoked: 1 });
      expect(JSON.stringify(counts)).not.toContain("cmp_pat_");
      // Access is unconditional, so the scope set is fixed — and never widens past reading secrets.
      const [live] = await sql<Array<{ scopes: string[]; userId: string }>>`
        select scopes, user_id as "userId" from api_tokens
        where source_type = 'companion' and source_agent_id = ${fixture.companionId}
          and revoked_at is null
      `;
      expect(live?.userId).toBe(ids.ownerA);
      expect(live?.scopes).toEqual([
        "skills:read",
        "skills:write",
        "secrets:read",
        "database:read",
        "database:write",
      ]);
      await release(claim);
    } finally {
      await sql`delete from api_tokens where source_agent_id = ${fixture.companionId}`;
      await removeCompanion(fixture.companionId);
    }
  });

  it("mints, resolves, rotates, and revokes an account-bound MCP broker capability", async () => {
    if (!sql) throw new Error("runtime executor database is not initialized");
    let companionId = "";
    let claim: Claim | undefined;
    try {
      const [created] = await asApi({
        orgId: ids.orgA,
        actorId: ids.ownerA,
        action: (tx) => tx<Array<{ companionId: string }>>`
          select companion_id::text as "companionId"
          from public.companion_api_create_companion(
            ${ids.orgA}::uuid, 'MCP broker fixture', null, ${providerId}, 'fixture-model',
            '[]'::jsonb, false, ${tx.json([ids.mcpAccount])}::jsonb
          )
        `,
      });
      companionId = created?.companionId ?? "";
      await asApi({
        orgId: ids.orgA,
        actorId: ids.ownerA,
        action: (tx) => tx`
          select * from public.companion_api_enqueue_turn(
            ${ids.orgA}::uuid, ${companionId}::uuid, ${randomUUID()}::uuid,
            'Start the broker fixture', 'web', '[]'::jsonb
          )
        `,
      });
      claim = await claimWork();
      expect(claim).toMatchObject({ companionId, workKind: "operation" });
      const heldClaim = claim;
      const [selection] = await sql<Array<{ companion: unknown; operation: unknown }>>`
        select c.selected_mcp_account_ids as companion,
          o.selected_mcp_account_ids as operation
        from companions c join companion_operations o on o.companion_id = c.id
        where o.id = ${claim.workId}::uuid
      `;
      expect(selection).toEqual({ companion: [ids.mcpAccount], operation: [ids.mcpAccount] });
      const [authorization] = await asRuntime(async (tx) => await tx<Array<{
        authorized: boolean;
        actorId: string | null;
        surface: string | null;
        refs: unknown;
        denialCode: string | null;
      }>>`
        select authorized, denial_code as "denialCode", authorization_actor_id as "actorId",
          client_surface::text as surface, mcp_refs as refs
        from public.companion_runtime_renew_and_authorize(
          ${heldClaim.orgId}::uuid, ${heldClaim.companionId}::uuid, ${heldClaim.claimToken}::uuid,
          ${heldClaim.claimEpoch}::bigint, ${heldClaim.gateEpoch}::bigint, ${executorId},
          ${heldClaim.workKind}, ${heldClaim.workId}::uuid, 30
        )
      `);
      expect(authorization).toEqual({
        authorized: true,
        denialCode: null,
        actorId: ids.ownerA,
        surface: "web",
        refs: [{ account_id: ids.mcpAccount, credential_generation: ids.mcpGeneration }],
      });
      const mint = () => asRuntime(async (tx) => await tx<Array<{ token: string; expiresAt: Date }>>`
        select token, expires_at as "expiresAt"
        from public.companion_runtime_mint_mcp_broker_token(
          ${heldClaim.orgId}::uuid, ${heldClaim.companionId}::uuid, ${heldClaim.claimToken}::uuid,
          ${heldClaim.claimEpoch}::bigint, ${heldClaim.gateEpoch}::bigint, ${executorId},
          ${heldClaim.workKind}, ${heldClaim.workId}::uuid, 30
        )
      `);
      const [first] = await mint();
      expect(first?.token).toMatch(/^cmp_mcp_[0-9a-f]{48}$/);
      expect(first?.expiresAt.getTime()).toBeGreaterThan(Date.now() + 5 * 60 * 60_000);
      const hash = createHash("sha256").update(first?.token ?? "").digest("hex");
      const resolved = await asApi({
        orgId: ids.orgA,
        actorId: ids.ownerA,
        action: (tx) => tx<Array<{ companionId: string; actorId: string; refs: unknown }>>`
          select companion_id::text as "companionId", actor_id as "actorId", account_refs as refs
          from public.companion_resolve_mcp_broker_token(${hash})
        `,
      });
      expect(resolved).toEqual([{
        companionId,
        actorId: ids.ownerA,
        refs: [{ account_id: ids.mcpAccount, credential_generation: ids.mcpGeneration }],
      }]);
      await expect(asRuntime(async (tx) => await tx`
        select * from public.companion_resolve_mcp_broker_token(${hash})
      `)).rejects.toThrow(/permission denied.*companion_resolve_mcp_broker_token/i);

      const [second] = await mint();
      expect(second?.token).toMatch(/^cmp_mcp_[0-9a-f]{48}$/);
      expect(second?.token).not.toBe(first?.token);
      const firstAfterRotation = await asApi({
        orgId: ids.orgA,
        actorId: ids.ownerA,
        action: (tx) => tx`select * from public.companion_resolve_mcp_broker_token(${hash})`,
      });
      expect(firstAfterRotation).toEqual([]);

      await sql`
        update companion_runtime_instances
        set box_state = 'archived'
        where companion_id = ${companionId}::uuid
      `;
      const secondHash = createHash("sha256").update(second?.token ?? "").digest("hex");
      const afterStop = await asApi({
        orgId: ids.orgA,
        actorId: ids.ownerA,
        action: (tx) => tx`select * from public.companion_resolve_mcp_broker_token(${secondHash})`,
      });
      expect(afterStop).toEqual([]);
      const [counts] = await sql<Array<{ live: number; revoked: number }>>`
        select count(*) filter (where revoked_at is null)::int as live,
          count(*) filter (where revoked_at is not null)::int as revoked
        from companion_mcp_broker_tokens where companion_id = ${companionId}::uuid
      `;
      expect(counts).toEqual({ live: 0, revoked: 2 });
      await release(heldClaim);
      claim = undefined;
    } finally {
      if (claim) await release(claim).catch(() => undefined);
      if (companionId) await removeCompanion(companionId);
    }
  });

  it("locks the current MCP selection through the restricted API capability", async () => {
    if (!sql) throw new Error("runtime executor database is not initialized");
    let companionId = "";
    try {
      const [created] = await asApi({
        orgId: ids.orgA,
        actorId: ids.ownerA,
        action: (tx) => tx<Array<{ companionId: string }>>`
          select companion_id::text as "companionId"
          from public.companion_api_create_companion(
            ${ids.orgA}::uuid, 'MCP selection lock fixture', null, ${providerId}, 'fixture-model',
            '[]'::jsonb, false, ${tx.json([ids.mcpAccount])}::jsonb
          )
        `,
      });
      companionId = created?.companionId ?? "";

      const authorize = (actorId: string, accountId: string = ids.mcpAccount) => asApi({
        orgId: ids.orgA,
        actorId,
        action: (tx) => tx<Array<{ authorized: boolean }>>`
          select public.companion_api_lock_selected_mcp_account(
            ${ids.orgA}::uuid, ${companionId}::uuid, ${accountId}::uuid
          ) as authorized
        `,
      });
      await expect(authorize(ids.ownerA)).resolves.toEqual([{ authorized: true }]);
      await expect(authorize(ids.ownerA, randomUUID())).resolves.toEqual([{ authorized: false }]);

      // This is the production regression: FOR UPDATE requires UPDATE even though no row changes.
      await expect(asApi({
        orgId: ids.orgA,
        actorId: ids.ownerA,
        action: (tx) => tx`
          select id from public.companions
          where org_id = ${ids.orgA}::uuid and id = ${companionId}::uuid
          for update
        `,
      })).rejects.toThrow(/permission denied.*companions/i);
      await expect(asRuntime((tx) => tx`
        select public.companion_api_lock_selected_mcp_account(
          ${ids.orgA}::uuid, ${companionId}::uuid, ${ids.mcpAccount}::uuid
        )
      `)).rejects.toThrow(/permission denied.*companion_api_lock_selected_mcp_account/i);
      await expect(asWorker((tx) => tx`
        select public.companion_api_lock_selected_mcp_account(
          ${ids.orgA}::uuid, ${companionId}::uuid, ${ids.mcpAccount}::uuid
        )
      `)).rejects.toThrow(/permission denied.*companion_api_lock_selected_mcp_account/i);

      await asApi({
        orgId: ids.orgA,
        actorId: ids.ownerA,
        action: (tx) => tx`
          select * from public.companion_api_set_workspace_access(
            ${ids.orgA}::uuid, ${companionId}::uuid, 'editor'
          )
        `,
      });
      await expect(authorize(ids.editorA)).resolves.toEqual([{ authorized: true }]);
      await asApi({
        orgId: ids.orgA,
        actorId: ids.ownerA,
        action: (tx) => tx`
          select * from public.companion_api_set_workspace_access(
            ${ids.orgA}::uuid, ${companionId}::uuid, 'viewer'
          )
        `,
      });
      await expect(authorize(ids.viewerA)).resolves.toEqual([{ authorized: false }]);
      await expect(authorize(ids.ownerB)).resolves.toEqual([{ authorized: false }]);
      await expect(asApi({
        orgId: ids.orgB,
        actorId: ids.ownerB,
        action: (tx) => tx`
          select public.companion_api_lock_selected_mcp_account(
            ${ids.orgA}::uuid, ${companionId}::uuid, ${ids.mcpAccount}::uuid
          ) as authorized
        `,
      })).resolves.toEqual([{ authorized: false }]);

      let releaseSelectionLock: () => void = () => undefined;
      let markSelectionLocked: () => void = () => undefined;
      const selectionLocked = new Promise<void>((resolve) => { markSelectionLocked = resolve; });
      const holdSelectionLock = new Promise<void>((resolve) => { releaseSelectionLock = resolve; });
      const holder = asApi({
        orgId: ids.orgA,
        actorId: ids.ownerA,
        action: async (tx) => {
          await tx`
            select public.companion_api_lock_selected_mcp_account(
              ${ids.orgA}::uuid, ${companionId}::uuid, ${ids.mcpAccount}::uuid
            )
          `;
          markSelectionLocked();
          await holdSelectionLock;
        },
      });
      await selectionLocked;
      try {
        await expect(asApi({
          orgId: ids.orgA,
          actorId: ids.ownerA,
          action: async (tx) => {
            await tx.unsafe("set local lock_timeout = '100ms'");
            await tx`
              select * from public.companion_api_update_companion(
                ${ids.orgA}::uuid, ${companionId}::uuid,
                ${tx.json({ selected_mcp_account_ids: [] })}::jsonb
              )
            `;
          },
        })).rejects.toThrow(/lock timeout/i);
      } finally {
        releaseSelectionLock();
        await holder;
      }

      await asApi({
        orgId: ids.orgA,
        actorId: ids.ownerA,
        action: (tx) => tx`
          select * from public.companion_api_update_companion(
            ${ids.orgA}::uuid, ${companionId}::uuid,
            ${tx.json({ selected_mcp_account_ids: [] })}::jsonb
          )
        `,
      });
      await expect(authorize(ids.ownerA)).resolves.toEqual([{ authorized: false }]);
    } finally {
      if (companionId) await removeCompanion(companionId);
    }
  });

  it("rejects effective CREATE inherited through PUBLIC in verification and the real grant hook", async () => {
    if (!sql) throw new Error("runtime executor database is not initialized");
    await sql.unsafe(`grant create on database "${databaseName}" to public`);
    try {
      await expect(asRuntime(async (tx) => {
        // SAFETY: The transaction exposes the same `unsafe` execution method required by the role
        // verifier; this test deliberately limits the view to that one method.
        const roleClient = tx as Pick<Sql, "unsafe">;
        await verifyRuntimeDatabaseRole(roleClient, runtimeRole);
      })).rejects.toBeInstanceOf(RuntimeDatabaseRoleError);
      await expect(applySplitGrants()).rejects.toThrow(/must not have database or public schema CREATE/i);
    } finally {
      await sql.unsafe(`revoke create on database "${databaseName}" from public`);
      await applySplitGrants();
    }
  });

  it("atomically consumes one desktop request id across independent runtime connections", async () => {
    const timestamp = Math.floor(Date.now() / 1_000);
    const requestId = randomUUID();
    const consume = async (): Promise<boolean> => await asRuntime(async (tx) => {
      const [row] = await tx<Array<{ consumed: boolean }>>`
        select public.companion_runtime_consume_desktop_request(
          ${requestId}, ${timestamp}::bigint, 30
        ) as consumed
      `;
      return row?.consumed ?? false;
    });
    expect((await Promise.all([consume(), consume()])).sort()).toEqual([false, true]);
    // A later process/connection sees the durable id and rejects it for the rest of the window.
    expect(await consume()).toBe(false);
  });

  it("projects JSONB and advances the durable cursor through PostgresRuntimeStore", async () => {
    if (!sql) throw new Error("runtime executor database is not initialized");
    // Production createRuntimeDatabase uses prepare:false. Exercise that exact postgres.js
    // serialization boundary instead of this suite's default prepared fixture connection.
    const storeSql = postgres(runtimeUrl.toString(), { max: 1, prepare: false });
    const fixture = await createCompanion();
    try {
      const claim = await claimWork();
      const fence: LeaseFence = {
        orgId: claim.orgId,
        companionId: claim.companionId,
        claimToken: claim.claimToken,
        claimEpoch: BigInt(claim.claimEpoch),
        gateEpoch: BigInt(claim.gateEpoch),
        executorId,
        workKind: "attempt",
        workId: claim.workId,
      };
      const wrapped = await storeSql.begin(async (tx) => {
        await tx.unsafe(`set local role ${runtimeRole}`);
        // SAFETY: postgres.js transactions implement RuntimeSqlClient.unsafe; this integration test
        // uses the narrow adapter contract to exercise the production serializer.
        const runtimeClient = tx as RuntimeSqlClient;
        return { result: await new PostgresRuntimeStore(runtimeClient).projectEventBatch(fence, {
          expectedSequence: BigInt(claim.checkpointSequence),
          piInvocationId: `pi-${fixture.attemptId}`,
          events: [{
            sequence: 1n,
            type: "assistant",
            entry_key: "assistant:1",
            content: "Stored through the production serializer",
          }],
          throughCursor: 1n,
          unknownEventCount: 0,
          malformedEventCount: 0,
          oversizedEventCount: 0,
        }) };
      });
      const result = wrapped.result;
      expect(result).toEqual({
        checkpointSequence: 1n,
        eventCursor: 1n,
        hasVisibleOutput: true,
        routineReturned: false,
      });
      const [durable] = await sql<Array<{ cursor: string; content: string }>>`
        select attempt.event_cursor::text as cursor, entry.content
        from companion_turn_attempts attempt
        join companion_transcript_entries entry
          on entry.org_id = attempt.org_id and entry.companion_id = attempt.companion_id
        where attempt.id = ${fixture.attemptId}::uuid
          and entry.event_id = ${`v2:${fixture.attemptId}:1`}
      `;
      expect(durable).toEqual({
        cursor: "1",
        content: "Stored through the production serializer",
      });
    } finally {
      await storeSql.end({ timeout: 1 });
      await removeCompanion(fixture.companionId);
    }
  });

  it("returns exact encrypted material, fences OAuth CAS, and refuses forged or revoked authority", async () => {
    if (!sql) throw new Error("runtime executor database is not initialized");
    const fixture = await createCompanion({
      actorId: ids.revokedA,
      workspaceRole: "editor",
      selectedSkillIds: [ids.orgSkill],
      selectedMcpAccountIds: [ids.revokedMcpAccount],
    });
    try {
      await sql`
        insert into profiles (id, email, name, initials, timezone)
        values (
          ${ids.revokedA}, ${`${ids.revokedA}@example.test`},
          'Runtime executor actor', 'RE', 'America/Los_Angeles'
        )
        on conflict (id) do update set timezone = excluded.timezone
      `;
      const claim = await claimWork();
      expect(claim.workKind).toBe("attempt");
      // Phase 2.1 read path: the fenced material read carries the instance's Box id and the
      // registered hosted agent endpoint, so an executor can rebuild the direct event channel
      // after a process restart. Seeded directly because registration itself is covered by the
      // record_material_snapshot proof above.
      await sql`
        update companion_runtime_instances
        set agent_hosted_url = 'https://abc-8790.on.ascii.dev',
            agent_token_ciphertext = 'agent-ciphertext',
            agent_observed_at = now()
        where companion_id = ${claim.companionId}::uuid
      `;
      const [instanceBox] = await sql<Array<{ boxId: string | null }>>`
        select box_id as "boxId" from companion_runtime_instances
        where companion_id = ${claim.companionId}::uuid
      `;
      const material = await asRuntime((tx) => tx<Array<{
        promptText: string;
        providerMaterial: Array<IntegrationJsonObject>;
        skillMaterial: Array<IntegrationJsonObject>;
        mcpMaterial: Array<IntegrationJsonObject>;
        boxId: string | null;
        agentHostedUrl: string | null;
        agentTokenCiphertext: string | null;
        agentObserved: boolean;
      }>>`
        select prompt_text as "promptText", provider_material as "providerMaterial",
          skill_material as "skillMaterial", mcp_material as "mcpMaterial",
          box_id as "boxId", agent_hosted_url as "agentHostedUrl",
          agent_token_ciphertext as "agentTokenCiphertext",
          agent_observed_at is not null as "agentObserved"
        from public.companion_runtime_get_material(
          ${claim.orgId}::uuid, ${claim.companionId}::uuid, ${claim.claimToken}::uuid,
          ${claim.claimEpoch}::bigint, ${claim.gateEpoch}::bigint, ${executorId},
          ${claim.workKind}, ${claim.workId}::uuid, 30
        )
      `);
      expect(material).toHaveLength(1);
      expect(material[0]?.promptText).toBe(fixture.prompt);
      expect(material[0]).toMatchObject({
        boxId: instanceBox?.boxId ?? null,
        agentHostedUrl: "https://abc-8790.on.ascii.dev",
        agentTokenCiphertext: "agent-ciphertext",
        agentObserved: true,
      });
      expect(material[0]?.providerMaterial).toMatchObject([{
        provider_id: providerId,
        credential_generation: providerGeneration,
        ciphertext: "ciphertext-provider",
      }]);
      expect(material[0]?.skillMaterial).toMatchObject([{
        skill_id: ids.orgSkill,
        version_id: ids.orgSkillVersion,
        checksum: `sha256:${"b".repeat(64)}`,
      }]);
      expect(material[0]?.mcpMaterial).toMatchObject([{
        account_id: ids.revokedMcpAccount,
        credential_generation: ids.revokedMcpGeneration,
        ciphertext: "ciphertext-revoked-mcp",
      }]);
      const turnContext = await asRuntime((tx) => tx<Array<{
        startedAt: Date;
        timezone: string;
      }>>`
        select turn_started_at as "startedAt", member_timezone as timezone
        from public.companion_runtime_get_turn_context(
          ${claim.orgId}::uuid, ${claim.companionId}::uuid, ${claim.claimToken}::uuid,
          ${claim.claimEpoch}::bigint, ${claim.gateEpoch}::bigint, ${executorId},
          ${claim.workKind}, ${claim.workId}::uuid, 30
        )
      `);
      expect(turnContext).toEqual([{
        startedAt: expect.any(Date),
        timezone: "America/Los_Angeles",
      }]);
      await sql`update profiles set timezone = 'UTC' where id = ${ids.revokedA}`;
      const pinnedTurnContext = await asRuntime((tx) => tx<Array<{ timezone: string }>>`
        select member_timezone as timezone
        from public.companion_runtime_get_turn_context(
          ${claim.orgId}::uuid, ${claim.companionId}::uuid, ${claim.claimToken}::uuid,
          ${claim.claimEpoch}::bigint, ${claim.gateEpoch}::bigint, ${executorId},
          ${claim.workKind}, ${claim.workId}::uuid, 30
        )
      `);
      expect(pinnedTurnContext).toEqual([{ timezone: "America/Los_Angeles" }]);

      const forged = await asRuntime((tx) => tx`
        select * from public.companion_runtime_get_material(
          ${ids.orgB}::uuid, ${claim.companionId}::uuid, ${claim.claimToken}::uuid,
          ${claim.claimEpoch}::bigint, ${claim.gateEpoch}::bigint, ${executorId},
          ${claim.workKind}, ${claim.workId}::uuid, 30
        )
      `);
      expect(forged).toEqual([]);

      const nextGeneration = randomUUID();
      await expect(asRuntime((tx) => tx`
        select updated, credential_generation::text as generation
        from public.companion_runtime_cas_mcp_oauth(
          ${claim.orgId}::uuid, ${claim.companionId}::uuid, ${claim.claimToken}::uuid,
          ${claim.claimEpoch}::bigint, ${claim.gateEpoch}::bigint, ${executorId},
          ${claim.workKind}, ${claim.workId}::uuid, ${ids.revokedMcpAccount}::uuid,
          ${ids.revokedMcpGeneration}::uuid, ${nextGeneration}::uuid,
          'ciphertext-mcp-next', 'iv-mcp-next', 'tag-mcp-next', 'wrapped-mcp-next',
          'wrap-iv-mcp-next', 'wrap-tag-mcp-next', 'key-mcp-next'
        )
      `)).rejects.toThrow(/permission denied.*companion_runtime_cas_mcp_oauth/i);

      // Rotation after the prompt material was pinned is detected before a takeover can project
      // output with only the new credential in its redaction dictionary.
      await sql`
        update companion_mcp_accounts
        set credential_generation = ${nextGeneration}::uuid, updated_at = now()
        where id = ${ids.revokedMcpAccount}::uuid
      `;
      const changed = await asRuntime((tx) => tx<Array<{ matches: boolean }>>`
        select credential_snapshot_matches as matches
        from public.companion_runtime_get_material(
          ${claim.orgId}::uuid, ${claim.companionId}::uuid, ${claim.claimToken}::uuid,
          ${claim.claimEpoch}::bigint, ${claim.gateEpoch}::bigint, ${executorId},
          ${claim.workKind}, ${claim.workId}::uuid, 30
        )
      `);
      expect(changed).toEqual([{ matches: false }]);

      await sql`
        delete from memberships where org_id = ${ids.orgA}::uuid and user_id = ${ids.revokedA}
      `;
      const revoked = await asRuntime((tx) => tx`
        select * from public.companion_runtime_get_material(
          ${claim.orgId}::uuid, ${claim.companionId}::uuid, ${claim.claimToken}::uuid,
          ${claim.claimEpoch}::bigint, ${claim.gateEpoch}::bigint, ${executorId},
          ${claim.workKind}, ${claim.workId}::uuid, 30
        )
      `);
      expect(revoked).toEqual([]);
    } finally {
      await removeCompanion(fixture.companionId);
    }
  });

  it("projects a typed batch atomically, retries idempotently, and builds a decision response", async () => {
    if (!sql) throw new Error("runtime executor database is not initialized");
    const fixture = await createCompanion();
    try {
      const claim = await claimWork();
      const expiresAt = new Date(Date.now() + 5 * 60_000).toISOString();
      const decision = {
        request_id: "request-1",
        kind: "question",
        name: "ask_user",
        title: "Choose a direction",
        detail: "A bounded question",
        status: "pending",
        answer: null,
        decided_by_id: null,
        decided_by_name: null,
        decided_at: null,
        expires_at: expiresAt,
      };
      const events = [
        {
          sequence: "1", type: "assistant", entry_key: "assistant:1",
          content: "A durable answer", reasoning: "bounded reasoning",
        },
        {
          sequence: "2", type: "tool", entry_key: "tool:call-1", content: "Run check",
          tool: {
            call_id: "call-1", kind: "shell", name: "exec", title: "Run check",
            status: "running", detail: "input", screenshot: null,
          },
        },
        {
          sequence: "3", type: "tool", entry_key: "tool:call-1", content: "Run check",
          tool: {
            call_id: "call-1", kind: "tool", name: "tool", title: "Run check",
            status: "ok", detail: "input\n\noutput", screenshot: null,
          },
        },
        {
          sequence: "4", type: "decision", entry_key: "decision:request-1",
          request_key: "request-1", request_kind: "question",
          content: decision.title, decision, expires_at: expiresAt,
        },
        { sequence: "5", type: "activity", event_type: "message_end" },
      ];
      const invalidEvents = [{ ...events[0], raw_event: { credential: "must-not-persist" } }];
      await expect(asRuntime((tx) => tx`
        select * from public.companion_runtime_project_event_batch(
          ${claim.orgId}::uuid, ${claim.companionId}::uuid, ${claim.claimToken}::uuid,
          ${claim.claimEpoch}::bigint, ${claim.gateEpoch}::bigint, ${executorId},
          'attempt', ${claim.workId}::uuid, ${claim.checkpointSequence}::bigint,
          ${`pi-${fixture.attemptId}`}, ${tx.json(invalidEvents)}, 1, now(), 0, 0, 0
        )
      `)).rejects.toMatchObject({ code: "22023" });
      const [before] = await sql<Array<{ cursor: string; projections: number }>>`
        select attempt.event_cursor::text as cursor,
          (select count(*)::int from companion_runtime_event_projections projection
            where projection.attempt_id = attempt.id) as projections
        from companion_turn_attempts attempt where attempt.id = ${fixture.attemptId}::uuid
      `;
      expect(before).toEqual({ cursor: "0", projections: 0 });

      const projected = await asRuntime((tx) => tx<Array<{
        sequence: string;
        cursor: string;
        visible: boolean;
      }>>`
        select checkpoint_sequence::text as sequence, event_cursor::text as cursor,
          has_visible_output as visible
        from public.companion_runtime_project_event_batch(
          ${claim.orgId}::uuid, ${claim.companionId}::uuid, ${claim.claimToken}::uuid,
          ${claim.claimEpoch}::bigint, ${claim.gateEpoch}::bigint, ${executorId},
          'attempt', ${claim.workId}::uuid, ${claim.checkpointSequence}::bigint,
          ${`pi-${fixture.attemptId}`}, ${tx.json(events)}, 5, now(), 2, 1, 0
        )
      `);
      expect(projected).toEqual([{ sequence: "1", cursor: "5", visible: true }]);
      const replayed = await asRuntime((tx) => tx<Array<{
        sequence: string;
        cursor: string;
        visible: boolean;
      }>>`
        select checkpoint_sequence::text as sequence, event_cursor::text as cursor,
          has_visible_output as visible
        from public.companion_runtime_project_event_batch(
          ${claim.orgId}::uuid, ${claim.companionId}::uuid, ${claim.claimToken}::uuid,
          ${claim.claimEpoch}::bigint, ${claim.gateEpoch}::bigint, ${executorId},
          'attempt', ${claim.workId}::uuid, ${claim.checkpointSequence}::bigint,
          ${`pi-${fixture.attemptId}`}, ${tx.json(events)}, 5, now(), 2, 1, 0
        )
      `);
      expect(replayed).toEqual(projected);
      await expect(asRuntime((tx) => tx`
        select * from public.companion_runtime_project_event_batch(
          ${claim.orgId}::uuid, ${claim.companionId}::uuid, ${claim.claimToken}::uuid,
          ${claim.claimEpoch}::bigint, ${claim.gateEpoch}::bigint, ${executorId},
          'attempt', ${claim.workId}::uuid, ${claim.checkpointSequence}::bigint,
          ${`pi-${fixture.attemptId}`}, ${tx.json([
            { ...events[0], content: "tampered" }, ...events.slice(1),
          ])}, 5, now(), 2, 1, 0
        )
      `)).rejects.toMatchObject({ code: "40001" });
      const stale = await asRuntime((tx) => tx`
        select * from public.companion_runtime_project_event_batch(
          ${claim.orgId}::uuid, ${claim.companionId}::uuid, ${claim.claimToken}::uuid,
          (${claim.claimEpoch}::bigint + 1), ${claim.gateEpoch}::bigint, ${executorId},
          'attempt', ${claim.workId}::uuid, 1, ${`pi-${fixture.attemptId}`},
          ${tx.json([])}, 6, now(), 3, 1, 0
        )
      `);
      expect(stale).toEqual([]);

      const transcript = await sql<Array<{
        role: string;
        content: string;
        toolStatus: string | null;
        toolKind: string | null;
        toolName: string | null;
        decisionExpiresAt: string | null;
      }>>`
        select role::text as role, content, tool ->> 'status' as "toolStatus",
          tool ->> 'kind' as "toolKind", tool ->> 'name' as "toolName",
          decision ->> 'expires_at' as "decisionExpiresAt"
        from companion_transcript_entries
        where companion_id = ${fixture.companionId}::uuid and role <> 'user'
        order by ordinal
      `;
      expect(transcript).toEqual([
        {
          role: "assistant",
          content: "A durable answer",
          toolStatus: null,
          toolKind: null,
          toolName: null,
          decisionExpiresAt: null,
        },
        {
          role: "tool",
          content: "Run check",
          toolStatus: "ok",
          toolKind: "shell",
          toolName: "exec",
          decisionExpiresAt: null,
        },
        {
          role: "decision",
          content: "Choose a direction",
          toolStatus: null,
          toolKind: null,
          toolName: null,
          decisionExpiresAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/),
        },
      ]);
      expect(Number.isNaN(Date.parse(transcript[2]!.decisionExpiresAt!))).toBe(false);
      const [attempt] = await sql<Array<{
        cursor: string;
        sequence: string;
        status: string;
        turnStatus: string;
        inactivityDeadlineAt: Date | null;
        unknownCount: number;
        malformedCount: number;
      }>>`
        select attempt.event_cursor::text as cursor,
          attempt.checkpoint_sequence::text as sequence,
          attempt.status::text as status, attempt.unknown_event_count as "unknownCount",
          attempt.malformed_event_count as "malformedCount",
          turn_row.status::text as "turnStatus",
          turn_row.inactivity_deadline_at as "inactivityDeadlineAt"
        from companion_turn_attempts attempt
        join companion_turns turn_row on turn_row.id = attempt.turn_id
        where attempt.id = ${fixture.attemptId}::uuid
      `;
      expect(attempt).toEqual({
        cursor: "5", sequence: "1", status: "needs_input", turnStatus: "needs_input",
        inactivityDeadlineAt: null, unknownCount: 2, malformedCount: 1,
      });
      const [delivery] = await sql<Array<{ id: string; kind: string }>>`
        select id::text as id, request_kind::text as kind
        from companion_decision_deliveries
        where attempt_id = ${fixture.attemptId}::uuid and request_key = 'request-1'
      `;
      expect(delivery?.kind).toBe("question");
      if (!delivery) throw new Error("expected projected decision delivery");

      const siblingDeliveryId = randomUUID();
      await sql`
        insert into companion_decision_deliveries(
          id, org_id, companion_id, turn_id, attempt_id, request_key, expires_at
        ) values (
          ${siblingDeliveryId}::uuid, ${ids.orgA}::uuid, ${fixture.companionId}::uuid,
          ${fixture.turnId}::uuid, ${fixture.attemptId}::uuid, 'request-2', ${expiresAt}
        )
      `;

      await release(claim);
      await sql`
        update companion_decision_deliveries
        set decision_status = 'answered', actor_id = ${ids.ownerA},
          response_text = 'Use the safe path', responded_at = now(), updated_at = now()
        where id = ${delivery.id}::uuid
      `;
      const decisionClaim = await claimWork();
      expect(decisionClaim.workKind).toBe("decision");
      const response = await asRuntime((tx) => tx<Array<{
        attemptId: string;
        kind: string;
        payload: IntegrationJsonObject;
        visible: boolean;
      }>>`
        select attempt_id::text as "attemptId", decision_request_kind::text as kind,
          decision_response_payload as payload, has_visible_output as visible
        from public.companion_runtime_get_material(
          ${decisionClaim.orgId}::uuid, ${decisionClaim.companionId}::uuid,
          ${decisionClaim.claimToken}::uuid, ${decisionClaim.claimEpoch}::bigint,
          ${decisionClaim.gateEpoch}::bigint, ${executorId}, 'decision',
          ${decisionClaim.workId}::uuid, 30
        )
      `);
      expect(response).toEqual([{
        attemptId: fixture.attemptId,
        kind: "question",
        payload: { type: "extension_ui_response", id: "request-1", value: "Use the safe path" },
        visible: true,
      }]);
      const commandId = randomUUID();
      const [intent] = await asRuntime((tx) => tx<Array<{ sequence: string | null }>>`
        select public.companion_runtime_checkpoint(
          ${decisionClaim.orgId}::uuid, ${decisionClaim.companionId}::uuid,
          ${decisionClaim.claimToken}::uuid, ${decisionClaim.claimEpoch}::bigint,
          ${decisionClaim.gateEpoch}::bigint, ${executorId}, 'decision',
          ${decisionClaim.workId}::uuid, ${decisionClaim.checkpointSequence}::bigint,
          'write_intent', null, ${commandId}::uuid, null, null, null, null, null, null
        )::text as sequence
      `);
      expect(intent?.sequence).toBe("1");
      const [resolvedIntent] = await asRuntime((tx) => tx<Array<{ commandId: string | null }>>`
        select command_id::text as "commandId"
        from public.companion_runtime_renew_and_authorize_v2(
          ${decisionClaim.orgId}::uuid, ${decisionClaim.companionId}::uuid,
          ${decisionClaim.claimToken}::uuid, ${decisionClaim.claimEpoch}::bigint,
          ${decisionClaim.gateEpoch}::bigint, ${executorId}, 'decision',
          ${decisionClaim.workId}::uuid, 30
        )
      `);
      expect(resolvedIntent?.commandId).toBe(commandId);
      const [settled] = await asRuntime((tx) => tx<Array<{ settled: boolean }>>`
        select public.companion_runtime_settle(
          ${decisionClaim.orgId}::uuid, ${decisionClaim.companionId}::uuid,
          ${decisionClaim.claimToken}::uuid, ${decisionClaim.claimEpoch}::bigint,
          ${decisionClaim.gateEpoch}::bigint, ${executorId}, 'decision',
          ${decisionClaim.workId}::uuid, 'succeeded', null, null, null
        ) as settled
      `);
      expect(settled?.settled).toBe(true);
      const [stillWaiting] = await sql<Array<{
        delivery: string;
        attempt: string;
        turn: string;
      }>>`
        select delivery.delivery_state::text as delivery,
          attempt.status::text as attempt, turn_row.status::text as turn
        from companion_decision_deliveries delivery
        join companion_turn_attempts attempt on attempt.id = delivery.attempt_id
        join companion_turns turn_row on turn_row.id = delivery.turn_id
        where delivery.id = ${delivery.id}::uuid
      `;
      expect(stillWaiting).toEqual({
        delivery: "delivered",
        attempt: "needs_input",
        turn: "needs_input",
      });

      await sql`
        update companion_decision_deliveries
        set decision_status = 'answered', actor_id = ${ids.ownerA},
          response_text = 'Continue', responded_at = now(), updated_at = now()
        where id = ${siblingDeliveryId}::uuid
      `;
      const siblingClaim = await claimWork();
      expect(siblingClaim).toMatchObject({ workKind: "decision", workId: siblingDeliveryId });
      const siblingCommandId = randomUUID();
      const [siblingIntent] = await asRuntime((tx) => tx<Array<{ sequence: string | null }>>`
        select public.companion_runtime_checkpoint(
          ${siblingClaim.orgId}::uuid, ${siblingClaim.companionId}::uuid,
          ${siblingClaim.claimToken}::uuid, ${siblingClaim.claimEpoch}::bigint,
          ${siblingClaim.gateEpoch}::bigint, ${executorId}, 'decision',
          ${siblingClaim.workId}::uuid, ${siblingClaim.checkpointSequence}::bigint,
          'write_intent', null, ${siblingCommandId}::uuid, null, null, null, null, null, null
        )::text as sequence
      `);
      expect(siblingIntent?.sequence).toBe("1");
      const [siblingSettled] = await asRuntime((tx) => tx<Array<{ settled: boolean }>>`
        select public.companion_runtime_settle(
          ${siblingClaim.orgId}::uuid, ${siblingClaim.companionId}::uuid,
          ${siblingClaim.claimToken}::uuid, ${siblingClaim.claimEpoch}::bigint,
          ${siblingClaim.gateEpoch}::bigint, ${executorId}, 'decision',
          ${siblingClaim.workId}::uuid, 'succeeded', null, null, null
        ) as settled
      `);
      expect(siblingSettled?.settled).toBe(true);
      const [resumedParent] = await sql<Array<{
        delivery: string;
        attempt: string;
        turn: string;
      }>>`
        select delivery.delivery_state::text as delivery,
          attempt.status::text as attempt, turn_row.status::text as turn
        from companion_decision_deliveries delivery
        join companion_turn_attempts attempt on attempt.id = delivery.attempt_id
        join companion_turns turn_row on turn_row.id = delivery.turn_id
        where delivery.id = ${siblingDeliveryId}::uuid
      `;
      expect(resumedParent).toEqual({
        delivery: "delivered",
        attempt: "running",
        turn: "running",
      });
      const resumedClaim = await claimWork();
      expect(resumedClaim).toMatchObject({ workKind: "attempt", workId: fixture.attemptId });
      await release(resumedClaim);
    } finally {
      await removeCompanion(fixture.companionId);
    }
  });

  it("preserves the main cold-start budget while an isolated routine owns shared staging", async () => {
    if (!sql) throw new Error("runtime executor database is not initialized");
    const fixture = await createCompanion({
      boxReady: true,
      selectedSkillIds: [],
      selectedMcpAccountIds: [],
    });
    const routineId = randomUUID();
    const routineExecutor = `${executorId}-routine-budget`;
    const mainExecutor = `${executorId}-main-budget`;
    let routineClaim: Claim | undefined;
    let mainClaim: Claim | undefined;
    try {
      await sql`
        update companion_runtime_instances
        set material_pi_invocation_id = pi_invocation_id, material_client_surface = 'web',
          material_expires_at = now() + interval '6 hours', last_observed_at = now()
        where companion_id = ${fixture.companionId}::uuid
      `;
      const initialMain = await claimWork();
      await sql`
        update companion_turn_attempts set status = 'cancelled', settled_at = now()
        where id = ${fixture.attemptId}::uuid
      `;
      await sql`
        update companion_turns set status = 'cancelled', settled_at = now()
        where id = ${fixture.turnId}::uuid
      `;
      await release(initialMain);

      await asApi({
        orgId: ids.orgA,
        actorId: ids.ownerA,
        action: (tx) => tx`
          select public.companion_api_create_routine(
            ${ids.orgA}::uuid, ${fixture.companionId}::uuid, ${routineId}::uuid,
            'Cold-start budget routine', 'Prepare an isolated report.', '0 9 * * *', 'UTC', true,
            now() + interval '1 hour'
          )
        `,
      });
      await sql`
        update companion_routines set next_fire_at = now() - interval '1 second'
        where id = ${routineId}::uuid
      `;
      const [due] = await asWorker((tx) => tx<Array<{ scheduledFor: Date }>>`
        select scheduled_for as "scheduledFor"
        from public.companion_claim_due_routines('budget-worker', 1, 60)
        where routine_id = ${routineId}::uuid
      `);
      if (!due) throw new Error("expected the budget routine to become due");
      const fired = await asWorker((tx) => tx<Array<{ outcome: string }>>`
        select outcome from public.companion_fire_routine(
          'budget-worker', ${ids.orgA}::uuid, ${routineId}::uuid, ${randomUUID()}::uuid,
          ${due.scheduledFor.toISOString()}::timestamptz, now() + interval '1 hour'
        )
      `);
      expect(fired).toEqual([{ outcome: "fired" }]);

      [routineClaim] = await claimWorkRows(1, routineExecutor);
      expect(routineClaim).toMatchObject({
        workKind: "attempt",
        companionId: fixture.companionId,
      });
      if (!routineClaim) throw new Error("expected the isolated routine claim");

      const [routineTurn] = await sql<Array<{ turnId: string }>>`
        select turn_id::text as "turnId"
        from companion_turn_attempts where id = ${routineClaim.workId}::uuid
      `;
      if (!routineTurn) throw new Error("expected the isolated routine turn");
      await sql`
        update companion_turns set status = 'running'
        where id = ${routineTurn.turnId}::uuid
      `;
      await sql`
        update companion_turn_attempts
        set status = 'running', checkpoint = 'running', dispatch_state = 'accepted',
          provider_credential_refs = '[]'::jsonb, mcp_credential_refs = '[]'::jsonb,
          command_id = ${randomUUID()}::uuid,
          pi_invocation_id = ${`routine:${routineTurn.turnId}:dispatch-v2:budget`},
          dispatch_accepted_at = now(), last_activity_at = now()
        where id = ${routineClaim.workId}::uuid
      `;
      await sql`
        update companion_runtime_instances
        set material_expires_at = null, material_pi_invocation_id = null,
          material_client_surface = null, pi_state = 'unknown'
        where companion_id = ${fixture.companionId}::uuid
      `;

      const [enqueued] = await asApi({
        orgId: ids.orgA,
        actorId: ids.ownerA,
        action: (tx) => tx<Array<{ turn: { id: string } }>>`
          select turn from public.companion_api_enqueue_turn(
            ${ids.orgA}::uuid, ${fixture.companionId}::uuid, ${randomUUID()}::uuid,
            'Start after the isolated routine finishes preparing.', 'web', '[]'::jsonb
          )
        `,
      });
      const mainTurnId = stringValue(enqueued?.turn.id);
      if (mainTurnId === null) throw new Error("expected the queued main turn");

      // Repeated scheduler passes model high-frequency routine preparation. None may consume the
      // main turn's three-minute budget before shared Start can be claimed.
      for (let pass = 0; pass < 4; pass += 1) {
        expect(await claimWorkRows(1, mainExecutor)).toEqual([]);
      }
      const [waiting] = await sql<Array<{
        coldStartDeadlineAt: Date | null;
        startCount: number;
        status: string;
      }>>`
        select turn_row.cold_start_deadline_at as "coldStartDeadlineAt",
          turn_row.status::text as status,
          count(start_operation.id)::integer as "startCount"
        from companion_turns turn_row
        left join companion_operations start_operation
          on start_operation.source_turn_id = turn_row.id
          and start_operation.kind = 'start'
          and start_operation.status in ('pending', 'running')
        where turn_row.id = ${mainTurnId}::uuid
        group by turn_row.id
      `;
      expect(waiting).toEqual({ coldStartDeadlineAt: null, startCount: 0, status: "queued" });

      await sql`
        update companion_turn_attempts set status = 'cancelled', settled_at = now()
        where id = ${routineClaim.workId}::uuid
      `;
      await sql`
        update companion_turns set status = 'cancelled', settled_at = now()
        where id = ${routineTurn.turnId}::uuid
      `;
      await release(routineClaim, routineExecutor);
      routineClaim = undefined;

      [mainClaim] = await claimWorkRows(1, mainExecutor);
      expect(mainClaim).toMatchObject({ workKind: "operation", companionId: fixture.companionId });
      const [started] = await sql<Array<{
        coldStartDeadlineAt: Date | null;
        remainingSeconds: number;
        status: string;
      }>>`
        select source_turn.cold_start_deadline_at as "coldStartDeadlineAt",
          extract(epoch from source_turn.cold_start_deadline_at - now())::integer
            as "remainingSeconds",
          source_turn.status::text as status
        from companion_operations operation
        join companion_turns source_turn on source_turn.id = operation.source_turn_id
        where operation.id = ${mainClaim!.workId}::uuid
      `;
      expect(started?.coldStartDeadlineAt).not.toBeNull();
      expect(started?.remainingSeconds).toBeGreaterThanOrEqual(175);
      expect(started?.status).toBe("queued");
      expect(await authorizeClaim(mainClaim!, mainExecutor)).toEqual({
        authorized: true,
        denialCode: null,
      });
    } finally {
      if (mainClaim) await release(mainClaim, mainExecutor);
      if (routineClaim) await release(routineClaim, routineExecutor);
      await sql`delete from companion_routines where companion_id = ${fixture.companionId}::uuid`;
      await removeCompanion(fixture.companionId);
    }
  });

  it("runs main turns and isolated routines concurrently with independent takeover, interruption, and cancel", async () => {
    if (!sql) throw new Error("runtime executor database is not initialized");
    const fixture = await createCompanion({
      boxReady: true,
      selectedSkillIds: [],
      selectedMcpAccountIds: [],
    });
    const routineId = randomUUID();
    const routineExecutor = `${executorId}-routine-takeover`;
    const mainExecutor = `${executorId}-main-takeover`;
    let routineClaim: Claim | undefined;
    let mainClaim: Claim | undefined;
    try {
      await sql`
        update companion_runtime_instances
        set material_pi_invocation_id = pi_invocation_id, material_client_surface = 'web',
          material_expires_at = now() + interval '6 hours', last_observed_at = now()
        where companion_id = ${fixture.companionId}::uuid
      `;
      const initialMain = await claimWork();
      expect(initialMain).toMatchObject({
        workKind: "attempt",
        workId: fixture.attemptId,
        companionId: fixture.companionId,
      });
      await asApi({
        orgId: ids.orgA,
        actorId: ids.ownerA,
        action: (tx) => tx`
          select public.companion_api_create_routine(
            ${ids.orgA}::uuid, ${fixture.companionId}::uuid, ${routineId}::uuid,
            'Parallel routine', 'Inspect the deployment.', '0 9 * * *', 'UTC', true,
            now() + interval '1 hour'
          )
        `,
      });
      await sql`
        update companion_routines set next_fire_at = now() - interval '1 second'
        where id = ${routineId}::uuid
      `;
      const [due] = await asWorker((tx) => tx<Array<{ scheduledFor: Date }>>`
        select scheduled_for as "scheduledFor"
        from public.companion_claim_due_routines('parallel-worker', 1, 60)
        where routine_id = ${routineId}::uuid
      `);
      if (!due) throw new Error("expected the parallel routine to become due");
      const fired = await asWorker((tx) => tx<Array<{ outcome: string }>>`
        select outcome from public.companion_fire_routine(
          'parallel-worker', ${ids.orgA}::uuid, ${routineId}::uuid, ${randomUUID()}::uuid,
          ${due.scheduledFor.toISOString()}::timestamptz, now() + interval '1 hour'
        )
      `);
      expect(fired).toEqual([{ outcome: "fired" }]);

      const [routineTurn] = await sql<Array<{ turnId: string }>>`
        select id::text as "turnId" from companion_turns
        where companion_id = ${fixture.companionId}::uuid
          and routine_snapshot_id = ${routineId}::uuid
      `;
      if (!routineTurn) throw new Error("expected a routine-origin turn");

      // The newly-fired routine claims its own lane while the main attempt holds a live lease.
      [routineClaim] = await claimWorkRows(1);
      expect(routineClaim).toMatchObject({ workKind: "attempt", companionId: fixture.companionId });
      if (!routineClaim) throw new Error("expected the routine scheduling lane");
      await sql`
        update companion_turns set status = 'running'
        where id = ${routineTurn.turnId}::uuid
      `;
      await sql`
        update companion_turn_attempts
        set status = 'running', checkpoint = 'running', dispatch_state = 'accepted',
          provider_credential_refs = '[]'::jsonb, mcp_credential_refs = '[]'::jsonb,
          command_id = ${randomUUID()}::uuid,
          pi_invocation_id = ${`routine:${routineTurn.turnId}:dispatch-v2:active`},
          dispatch_accepted_at = now(), last_activity_at = now()
        where id = ${routineClaim.workId}::uuid
      `;

      // Expiring only the routine lane transfers only that run; the main fence remains valid.
      await sql`
        update companion_runtime_leases
        set renewed_at = now() - interval '2 seconds', expires_at = now() - interval '1 second'
        where companion_id = ${fixture.companionId}::uuid and lane = 'routine'
      `;
      [routineClaim] = await claimWorkRows(1, routineExecutor);
      expect(routineClaim).toMatchObject({ workId: expect.any(String) });
      expect(await authorizeClaim(initialMain)).toEqual({ authorized: true, denialCode: null });

      await sql`
        update companion_turn_attempts set status = 'cancelled', settled_at = now()
        where id = ${fixture.attemptId}::uuid
      `;
      await sql`
        update companion_turns set status = 'cancelled', settled_at = now()
        where id = ${fixture.turnId}::uuid
      `;
      await release(initialMain);
      const [routineOnlyProjection] = await asApi({
        orgId: ids.orgA,
        actorId: ids.ownerA,
        action: (tx) => tx<Array<{ activeTurn: unknown; queuedCount: number }>>`
          select active_turn as "activeTurn", queued_count as "queuedCount"
          from public.companion_api_read_thread(
            ${ids.orgA}::uuid, ${fixture.companionId}::uuid
          )
        `,
      });
      expect(routineOnlyProjection).toEqual({ activeTurn: null, queuedCount: 0 });

      const lifecycleRequestId = randomUUID();
      const [lifecycle] = await asApi({
        orgId: ids.orgA,
        actorId: ids.ownerA,
        action: (tx) => tx<Array<{ operation: { id: string } }>>`
          select * from public.companion_api_enqueue_operation(
            ${ids.orgA}::uuid, ${fixture.companionId}::uuid,
            ${lifecycleRequestId}::uuid, 'restart_pi', 'web'
          )
        `,
      });
      // A main-Pi recycle waits for an unrelated isolated routine; only an explicit full-Box
      // restart is allowed to preempt that routine lane.
      expect(await claimWorkRows(1, `${mainExecutor}-lifecycle`)).toEqual([]);
      expect(await authorizeClaim(routineClaim!, routineExecutor)).toEqual({
        authorized: true,
        denialCode: null,
      });
      await sql`
        update companion_operations set status = 'cancelled', settled_at = now(), updated_at = now()
        where id = ${lifecycle!.operation.id}::uuid
      `;

      const enqueueMain = async (content: string) => {
        const [enqueued] = await asApi({
          orgId: ids.orgA,
          actorId: ids.ownerA,
          action: (tx) => tx<Array<{ turn: { id: string } }>>`
            select turn from public.companion_api_enqueue_turn(
              ${ids.orgA}::uuid, ${fixture.companionId}::uuid, ${randomUUID()}::uuid,
              ${content}, 'web', '[]'::jsonb
            )
          `,
        });
        const turnId = stringValue(enqueued?.turn.id);
        if (turnId === null) throw new Error("expected an ordinary main turn");
        return turnId;
      };

      const runningTurnId = await enqueueMain("Answer while the routine is running");
      [mainClaim] = await claimWorkRows(1, mainExecutor);
      expect(mainClaim).toMatchObject({ workKind: "attempt", companionId: fixture.companionId });
      const [runningAttempt] = await sql<Array<{ turnId: string; lane: string }>>`
        select turn_id::text as "turnId", execution_lane as lane
        from companion_turn_attempts where id = ${mainClaim!.workId}::uuid
      `;
      expect(runningAttempt).toEqual({ turnId: runningTurnId, lane: "main" });

      await sql`
        update companion_turn_attempts set status = 'cancelled', settled_at = now()
        where id = ${mainClaim!.workId}::uuid
      `;
      await sql`
        update companion_turns set status = 'cancelled', settled_at = now()
        where id = ${runningTurnId}::uuid
      `;
      await release(mainClaim!, mainExecutor);
      mainClaim = undefined;
      await sql`
        update companion_turns set status = 'needs_input'
        where id = ${routineTurn.turnId}::uuid
      `;
      await sql`
        update companion_turn_attempts set status = 'needs_input', checkpoint = 'needs_input'
        where id = ${routineClaim!.workId}::uuid
      `;

      const needsInputTurnId = await enqueueMain("Answer while the routine needs input");
      [mainClaim] = await claimWorkRows(1, mainExecutor);
      const [needsInputAttempt] = await sql<Array<{ turnId: string; lane: string }>>`
        select turn_id::text as "turnId", execution_lane as lane
        from companion_turn_attempts where id = ${mainClaim!.workId}::uuid
      `;
      expect(needsInputAttempt).toEqual({ turnId: needsInputTurnId, lane: "main" });

      // A main takeover does not disturb the routine lease or authorization.
      await sql`
        update companion_runtime_leases
        set renewed_at = now() - interval '2 seconds', expires_at = now() - interval '1 second'
        where companion_id = ${fixture.companionId}::uuid and lane = 'main'
      `;
      const mainAttemptId = mainClaim!.workId;
      [mainClaim] = await claimWorkRows(1, `${mainExecutor}-second`);
      expect(mainClaim).toMatchObject({ workId: mainAttemptId });
      expect(await authorizeClaim(routineClaim!, routineExecutor)).toEqual({
        authorized: true,
        denialCode: null,
      });

      // A routine interruption is terminal immediately and does not disturb the live main lane.
      await sql`
        update companion_turn_attempts set status = 'interrupted', settled_at = now(),
          last_error_code = 'dispatch_ambiguous', last_error_message = 'Ambiguous routine run.',
          last_error_action = 'none'
        where id = ${routineClaim!.workId}::uuid
      `;
      await sql`
        update companion_turns set status = 'interrupted', settled_at = now(),
          inactivity_deadline_at = null, last_error_code = 'dispatch_ambiguous',
          last_error_message = 'Ambiguous routine run.', last_error_action = 'none'
        where id = ${routineTurn.turnId}::uuid
      `;
      await release(routineClaim!, routineExecutor);
      routineClaim = undefined;

      const [resolvedRoutine] = await sql<Array<{
        status: string;
        resolution: string | null;
        errorAction: string;
        recoveries: number;
      }>>`
        select turn_row.status::text as status, turn_row.resolution,
          turn_row.last_error_action::text as "errorAction",
          count(operation.id)::integer as recoveries
        from companion_turns turn_row
        left join companion_operations operation
          on operation.source_turn_id = turn_row.id
          and operation.kind = 'restart_pi'
          and operation.trigger = 'recovery'
        where turn_row.id = ${routineTurn.turnId}::uuid
        group by turn_row.status, turn_row.resolution, turn_row.last_error_action
      `;
      expect(resolvedRoutine).toEqual({
        status: "interrupted",
        resolution: "auto_abandoned",
        errorAction: "none",
        recoveries: 0,
      });
      expect(await authorizeClaim(mainClaim!, `${mainExecutor}-second`)).toEqual({
        authorized: true,
        denialCode: null,
      });
    } finally {
      if (mainClaim) await release(mainClaim, `${mainExecutor}-second`);
      if (routineClaim) await release(routineClaim, routineExecutor);
      await sql`delete from companion_routines where companion_id = ${fixture.companionId}::uuid`;
      await removeCompanion(fixture.companionId);
    }
  });

  it("claims a later ordinary message on main before an older queued routine, then claims the routine lane", async () => {
    if (!sql) throw new Error("runtime executor database is not initialized");
    const fixture = await createCompanion({
      boxReady: true,
      selectedSkillIds: [],
      selectedMcpAccountIds: [],
    });
    const routineId = randomUUID();
    const mainExecutor = `${executorId}-queue-main`;
    const routineExecutor = `${executorId}-queue-routine`;
    let mainClaim: Claim | undefined;
    let routineClaim: Claim | undefined;
    try {
      // The fixture starts with a running main attempt. Finish that seed work so both newly queued
      // turns are eligible, while retaining the material snapshot required by the claim guard.
      await sql`
        update companion_turn_attempts
        set status = 'cancelled', settled_at = now(), updated_at = now()
        where id = ${fixture.attemptId}::uuid
      `;
      await sql`
        update companion_turns
        set status = 'cancelled', settled_at = now(), state_changed_at = now(), updated_at = now()
        where id = ${fixture.turnId}::uuid
      `;
      await sql`
        update companion_runtime_instances
        set material_pi_invocation_id = pi_invocation_id, material_client_surface = 'web',
          material_expires_at = now() + interval '6 hours', last_observed_at = now()
        where companion_id = ${fixture.companionId}::uuid
      `;
      await asApi({
        orgId: ids.orgA,
        actorId: ids.ownerA,
        action: (tx) => tx`
          select public.companion_api_create_routine(
            ${ids.orgA}::uuid, ${fixture.companionId}::uuid, ${routineId}::uuid,
            'Queued routine', 'Write the queued routine result.', '0 9 * * *', 'UTC', true,
            now() + interval '1 hour'
          )
        `,
      });
      await sql`
        update companion_routines
        set next_fire_at = now() - interval '1 second'
        where id = ${routineId}::uuid
      `;
      const [due] = await asWorker((tx) => tx<Array<{ scheduledFor: Date }>>`
        select scheduled_for as "scheduledFor"
        from public.companion_claim_due_routines('queue-routine-worker', 1, 60)
        where routine_id = ${routineId}::uuid
      `);
      if (!due) throw new Error("expected the queued routine to become due");
      const [fired] = await asWorker((tx) => tx<Array<{ outcome: string }>>`
        select outcome from public.companion_fire_routine(
          'queue-routine-worker', ${ids.orgA}::uuid, ${routineId}::uuid, ${randomUUID()}::uuid,
          ${due.scheduledFor.toISOString()}::timestamptz, now() + interval '1 hour'
        )
      `);
      expect(fired).toEqual({ outcome: "fired" });
      const [routineTurn] = await sql<Array<{ turnId: string; status: string }>>`
        select id::text as "turnId", status::text as status
        from companion_turns
        where companion_id = ${fixture.companionId}::uuid
          and routine_snapshot_id = ${routineId}::uuid
      `;
      expect(routineTurn?.status).toBe("queued");

      const clientMessageId = randomUUID();
      const [ordinary] = await asApi({
        orgId: ids.orgA,
        actorId: ids.ownerA,
        action: (tx) => tx<Array<{ turn: { id: string } }>>`
          select turn from public.companion_api_enqueue_turn(
            ${ids.orgA}::uuid, ${fixture.companionId}::uuid, ${clientMessageId}::uuid,
            'Answer the ordinary user message.', 'web', '[]'::jsonb
          )
        `,
      });
      const ordinaryTurnId = stringValue(ordinary?.turn.id);
      if (ordinaryTurnId === null) throw new Error("expected an ordinary queued turn");

      // The routine has the older global queue sequence, but the first claim must honor the main
      // lane for this priority tie. The routine row remains durable and executable independently.
      const [claimDefinition] = await sql<Array<{ definition: string }>>`
        select pg_get_functiondef(
          'public.companion_runtime_claim_work_without_material_guard(text,integer,integer,bigint)'
            ::regprocedure
        ) as definition
      `;
      expect(claimDefinition?.definition).toContain("CASE WHEN l.lane = 'main' THEN 0 ELSE 1 END");
      expect(claimDefinition?.definition).not.toContain(
        "CASE WHEN v_lane = 'main' THEN 0 ELSE 1 END",
      );
      [mainClaim] = await claimWorkRows(1, mainExecutor);
      expect(mainClaim).toMatchObject({ workKind: "attempt", companionId: fixture.companionId });
      const [claimedMain] = await sql<Array<{ turnId: string; lane: string; status: string }>>`
        select attempt.turn_id::text as "turnId", attempt.execution_lane as lane,
          turn_row.status::text as status
        from companion_turn_attempts attempt
        join companion_turns turn_row
          on turn_row.org_id = attempt.org_id
         and turn_row.companion_id = attempt.companion_id
         and turn_row.id = attempt.turn_id
        where attempt.id = ${mainClaim!.workId}::uuid
      `;
      expect(claimedMain).toEqual({ turnId: ordinaryTurnId, lane: "main", status: "starting" });
      const [routineStillQueued] = await sql<Array<{ status: string }>>`
        select status::text as status from companion_turns where id = ${routineTurn!.turnId}::uuid
      `;
      expect(routineStillQueued).toEqual({ status: "queued" });

      await asApi({
        orgId: ids.orgA,
        actorId: ids.ownerA,
        action: (tx) => tx`
          select * from public.companion_api_cancel_turn(
            ${ids.orgA}::uuid, ${fixture.companionId}::uuid, ${ordinaryTurnId}::uuid
          )
        `,
      });
      await release(mainClaim!, mainExecutor);
      mainClaim = undefined;

      [routineClaim] = await claimWorkRows(1, routineExecutor);
      expect(routineClaim).toMatchObject({ workKind: "attempt", companionId: fixture.companionId });
      const [claimedRoutine] = await sql<Array<{ turnId: string; lane: string; status: string }>>`
        select attempt.turn_id::text as "turnId", attempt.execution_lane as lane,
          turn_row.status::text as status
        from companion_turn_attempts attempt
        join companion_turns turn_row
          on turn_row.org_id = attempt.org_id
         and turn_row.companion_id = attempt.companion_id
         and turn_row.id = attempt.turn_id
        where attempt.id = ${routineClaim!.workId}::uuid
      `;
      expect(claimedRoutine).toEqual({
        turnId: routineTurn!.turnId,
        lane: "routine",
        status: "starting",
      });
    } finally {
      if (routineClaim) {
        await sql`
          update companion_turn_attempts
          set status = 'cancelled', settled_at = now(), updated_at = now()
          where id = ${routineClaim.workId}::uuid
        `;
        await sql`
          update companion_turns
          set status = 'cancelled', settled_at = now(), state_changed_at = now(), updated_at = now()
          where id = (select turn_id from companion_turn_attempts where id = ${routineClaim.workId}::uuid)
        `;
        await release(routineClaim, routineExecutor);
      }
      if (mainClaim) {
        await release(mainClaim, mainExecutor);
      }
      await sql`delete from companion_routines where companion_id = ${fixture.companionId}::uuid`;
      await removeCompanion(fixture.companionId);
    }
  });

  it("settles an expired routine queue row in the claim sweep without delaying a main claim", async () => {
    if (!sql) throw new Error("runtime executor database is not initialized");
    const fixture = await createCompanion({
      boxReady: true,
      selectedSkillIds: [],
      selectedMcpAccountIds: [],
    });
    const routineId = randomUUID();
    const mainExecutor = `${executorId}-ttl-main`;
    let mainClaim: Claim | undefined;
    try {
      await sql`
        update companion_turn_attempts
        set status = 'cancelled', settled_at = now(), updated_at = now()
        where id = ${fixture.attemptId}::uuid
      `;
      await sql`
        update companion_turns
        set status = 'cancelled', settled_at = now(), state_changed_at = now(), updated_at = now()
        where id = ${fixture.turnId}::uuid
      `;
      await sql`
        update companion_runtime_instances
        set material_pi_invocation_id = pi_invocation_id, material_client_surface = 'web',
          material_expires_at = now() + interval '6 hours', last_observed_at = now()
        where companion_id = ${fixture.companionId}::uuid
      `;
      await asApi({
        orgId: ids.orgA,
        actorId: ids.ownerA,
        action: (tx) => tx`
          select public.companion_api_create_routine(
            ${ids.orgA}::uuid, ${fixture.companionId}::uuid, ${routineId}::uuid,
            'Expired routine', 'This queued run must expire.', '0 9 * * *', 'UTC', true,
            now() + interval '1 hour'
          )
        `,
      });
      await sql`
        update companion_routines
        set next_fire_at = now() - interval '1 second'
        where id = ${routineId}::uuid
      `;
      const [due] = await asWorker((tx) => tx<Array<{ scheduledFor: Date }>>`
        select scheduled_for as "scheduledFor"
        from public.companion_claim_due_routines('ttl-routine-worker', 1, 60)
        where routine_id = ${routineId}::uuid
      `);
      if (!due) throw new Error("expected the TTL routine to become due");
      await asWorker((tx) => tx`
        select outcome from public.companion_fire_routine(
          'ttl-routine-worker', ${ids.orgA}::uuid, ${routineId}::uuid, ${randomUUID()}::uuid,
          ${due.scheduledFor.toISOString()}::timestamptz, now() + interval '1 hour'
        )
      `);
      const [routineTurn] = await sql<Array<{ turnId: string }>>`
        select id::text as "turnId"
        from companion_turns
        where companion_id = ${fixture.companionId}::uuid
          and routine_snapshot_id = ${routineId}::uuid
      `;
      if (!routineTurn) throw new Error("expected an expired routine turn");
      const staleStartId = randomUUID();
      await sql`
        insert into companion_operations (
          id, org_id, companion_id, request_id, kind, trigger, actor_id,
          source_turn_id, runtime_generation
        ) values (
          ${staleStartId}::uuid, ${ids.orgA}::uuid, ${fixture.companionId}::uuid,
          ${randomUUID()}::uuid, 'start', 'turn', ${ids.ownerA},
          ${routineTurn.turnId}::uuid, 1
        )
      `;
      await sql`
        update companion_turns
        set created_at = now() - interval '11 minutes'
        where id = ${routineTurn.turnId}::uuid
      `;

      const clientMessageId = randomUUID();
      const [ordinary] = await asApi({
        orgId: ids.orgA,
        actorId: ids.ownerA,
        action: (tx) => tx<Array<{ turn: { id: string } }>>`
          select turn from public.companion_api_enqueue_turn(
            ${ids.orgA}::uuid, ${fixture.companionId}::uuid, ${clientMessageId}::uuid,
            'The user message must remain responsive.', 'web', '[]'::jsonb
          )
        `,
      });
      const ordinaryTurnId = stringValue(ordinary?.turn.id);
      if (ordinaryTurnId === null) throw new Error("expected an ordinary queued turn");

      // The wrapper settles the stale routine row first, then the unchanged lane-aware claimer
      // selects the ordinary user turn. Cleanup is bounded and does not hold the main lease.
      [mainClaim] = await claimWorkRows(1, mainExecutor);
      expect(mainClaim).toMatchObject({ workKind: "attempt", companionId: fixture.companionId });
      const [claimed] = await sql<Array<{ turnId: string; lane: string }>>`
        select turn_id::text as "turnId", execution_lane as lane
        from companion_turn_attempts where id = ${mainClaim!.workId}::uuid
      `;
      expect(claimed).toEqual({ turnId: ordinaryTurnId, lane: "main" });
      const [expired] = await sql<Array<{
        status: string;
        errorCode: string | null;
        errorMessage: string | null;
        errorAction: string | null;
      }>>`
        select status::text as status, last_error_code as "errorCode",
          last_error_message as "errorMessage", last_error_action::text as "errorAction"
        from companion_turns where id = ${routineTurn.turnId}::uuid
      `;
      expect(expired).toEqual({
        status: "cancelled",
        errorCode: "routine_queue_expired",
        errorMessage: "This scheduled run expired while waiting in the queue.",
        errorAction: "none",
      });
      const [staleStart] = await sql<Array<{ status: string }>>`
        select status::text as status from companion_operations where id = ${staleStartId}::uuid
      `;
      expect(staleStart).toEqual({ status: "cancelled" });

      await asApi({
        orgId: ids.orgA,
        actorId: ids.ownerA,
        action: (tx) => tx`
          select * from public.companion_api_cancel_turn(
            ${ids.orgA}::uuid, ${fixture.companionId}::uuid, ${ordinaryTurnId}::uuid
          )
        `,
      });
      await release(mainClaim!, mainExecutor);
      mainClaim = undefined;
    } finally {
      if (mainClaim) await release(mainClaim, mainExecutor);
      await sql`delete from companion_routines where companion_id = ${fixture.companionId}::uuid`;
      await removeCompanion(fixture.companionId);
    }
  });

  it("reconciles an orphaned routine Start after lease loss before claiming a later user Start", async () => {
    if (!sql) throw new Error("runtime executor database is not initialized");
    const fixture = await createCompanion({
      boxReady: false,
      selectedSkillIds: [],
      selectedMcpAccountIds: [],
    });
    const routineId = randomUUID();
    const routineExecutor = `${executorId}-orphaned-routine-start`;
    const userExecutor = `${executorId}-orphaned-user-start`;
    let routineStartClaim: Claim | undefined;
    let userStartClaim: Claim | undefined;
    try {
      await sql`
        update companion_turn_attempts
        set status = 'cancelled', settled_at = now(), updated_at = now()
        where id = ${fixture.attemptId}::uuid
      `;
      await sql`
        update companion_turns
        set status = 'cancelled', settled_at = now(), state_changed_at = now(), updated_at = now()
        where id = ${fixture.turnId}::uuid
      `;
      await asApi({
        orgId: ids.orgA,
        actorId: ids.ownerA,
        action: (tx) => tx`
          select public.companion_api_create_routine(
            ${ids.orgA}::uuid, ${fixture.companionId}::uuid, ${routineId}::uuid,
            'Orphaned cold start', 'Say exactly: Hello World.', '*/5 * * * *', 'UTC', true,
            now() + interval '1 hour'
          )
        `,
      });
      await sql`
        update companion_routines set next_fire_at = now() - interval '1 second'
        where id = ${routineId}::uuid
      `;
      const [due] = await asWorker((tx) => tx<Array<{ scheduledFor: Date }>>`
        select scheduled_for as "scheduledFor"
        from public.companion_claim_due_routines('orphaned-start-worker', 1, 60)
        where routine_id = ${routineId}::uuid
      `);
      if (!due) throw new Error("expected the orphaned-start routine to become due");
      expect(await asWorker((tx) => tx<Array<{ outcome: string }>>`
        select outcome from public.companion_fire_routine(
          'orphaned-start-worker', ${ids.orgA}::uuid, ${routineId}::uuid,
          ${randomUUID()}::uuid, ${due.scheduledFor.toISOString()}::timestamptz,
          now() + interval '1 hour'
        )
      `)).toEqual([{ outcome: "fired" }]);

      const [routineTurn] = await sql<Array<{ turnId: string }>>`
        select id::text as "turnId" from companion_turns
        where companion_id = ${fixture.companionId}::uuid
          and routine_snapshot_id = ${routineId}::uuid
      `;
      if (!routineTurn) throw new Error("expected the routine-origin cold turn");
      [routineStartClaim] = await claimWorkRows(1, routineExecutor);
      expect(routineStartClaim).toMatchObject({
        workKind: "operation",
        companionId: fixture.companionId,
      });
      const [claimedRoutineStart] = await sql<Array<{ sourceTurnId: string | null }>>`
        select source_turn_id::text as "sourceTurnId"
        from companion_operations where id = ${routineStartClaim!.workId}::uuid
      `;
      expect(claimedRoutineStart).toEqual({ sourceTurnId: routineTurn.turnId });
      expect(await authorizeClaim(routineStartClaim!, routineExecutor)).toEqual({
        authorized: true,
        denialCode: null,
      });

      // Disable settles the source in its own transaction. The claimed derivative cannot contact
      // Box again, and a dead executor's expired fence must not leave its running row behind.
      await sql`
        update companion_routines set enabled = false, next_fire_at = null, updated_at = now()
        where id = ${routineId}::uuid
      `;
      expect(await authorizeClaim(routineStartClaim!, routineExecutor)).toEqual({
        authorized: false,
        denialCode: "source_turn_settled",
      });
      await sql`
        update companion_runtime_leases
        set renewed_at = now() - interval '2 seconds', expires_at = now() - interval '1 second'
        where companion_id = ${fixture.companionId}::uuid and lane = 'main'
      `;

      const [ordinary] = await asApi({
        orgId: ids.orgA,
        actorId: ids.ownerA,
        action: (tx) => tx<Array<{ turn: { id: string }; operation: { id: string } }>>`
          select turn, operation from public.companion_api_enqueue_turn(
            ${ids.orgA}::uuid, ${fixture.companionId}::uuid, ${randomUUID()}::uuid,
            'This user message must not wait behind the routine.', 'web', '[]'::jsonb
          )
        `,
      });
      const ordinaryTurnId = stringValue(ordinary?.turn.id);
      const ordinaryStartId = stringValue(ordinary?.operation.id);
      if (ordinaryTurnId === null || ordinaryStartId === null) {
        throw new Error("expected the ordinary cold turn and Start operation");
      }

      [userStartClaim] = await claimWorkRows(1, userExecutor);
      expect(userStartClaim).toMatchObject({
        workKind: "operation",
        workId: ordinaryStartId,
        companionId: fixture.companionId,
      });
      const [reconciled] = await sql<Array<{
        operationStatus: string;
        turnStatus: string;
        turnErrorCode: string | null;
      }>>`
        select operation.status::text as "operationStatus",
          turn_row.status::text as "turnStatus",
          turn_row.last_error_code as "turnErrorCode"
        from companion_operations operation
        join companion_turns turn_row on turn_row.id = operation.source_turn_id
        where operation.id = ${routineStartClaim!.workId}::uuid
      `;
      expect(reconciled).toEqual({
        operationStatus: "cancelled",
        turnStatus: "cancelled",
        turnErrorCode: "routine_disabled",
      });
      const [claimedUserSource] = await sql<Array<{ sourceTurnId: string | null }>>`
        select source_turn_id::text as "sourceTurnId"
        from companion_operations where id = ${userStartClaim!.workId}::uuid
      `;
      expect(claimedUserSource).toEqual({ sourceTurnId: ordinaryTurnId });
    } finally {
      if (userStartClaim) await release(userStartClaim, userExecutor);
      await sql`delete from companion_routines where companion_id = ${fixture.companionId}::uuid`;
      await removeCompanion(fixture.companionId);
    }
  });

  it("bootstraps a brand-new Companion before its first thread row exists", async () => {
    if (!sql) throw new Error("runtime executor database is not initialized");
    const companionId = randomUUID();
    try {
      await sql`
        insert into companions (
          id, org_id, owner_id, name, model_id, provider_ids,
          selected_skill_ids, selected_mcp_account_ids
        ) values (
          ${companionId}::uuid, ${ids.orgA}::uuid, ${ids.ownerA},
          'Empty incremental thread fixture', 'fixture-model', ${sql.json([providerId])},
          '[]'::jsonb, '[]'::jsonb
        )
      `;

      const [window] = await asApi({
        orgId: ids.orgA,
        actorId: ids.ownerA,
        action: (tx) => tx<Array<{
          accessRole: string;
          entries: unknown[];
          olderBeforeOrdinal: number | null;
          syncSequence: string;
        }>>`
          select access_role as "accessRole", entries,
            older_before_ordinal as "olderBeforeOrdinal",
            sync_sequence::text as "syncSequence"
          from public.companion_api_read_thread_window(
            ${ids.orgA}::uuid, ${companionId}::uuid, null, 50, true
          )
        `,
      });
      expect(window).toEqual({
        accessRole: "owner",
        entries: [],
        olderBeforeOrdinal: null,
        syncSequence: "0",
      });

      const [delta] = await asApi({
        orgId: ids.orgA,
        actorId: ids.ownerA,
        action: (tx) => tx<Array<{
          changedEntries: unknown[];
          deletedEventIds: string[];
          nextSequence: string;
          hasMore: boolean;
        }>>`
          select changed_entries as "changedEntries", deleted_event_ids as "deletedEventIds",
            next_sequence::text as "nextSequence", has_more as "hasMore"
          from public.companion_api_read_thread_changes(
            ${ids.orgA}::uuid, ${companionId}::uuid, 0, 200
          )
        `,
      });
      expect(delta).toEqual({
        changedEntries: [],
        deletedEventIds: [],
        nextSequence: "0",
        hasMore: false,
      });
    } finally {
      await removeCompanion(companionId);
    }
  });

  it("bounds a 2,000-entry thread with 429 routine returns and streams only changed projections", async () => {
    if (!sql) throw new Error("runtime executor database is not initialized");
    const fixture = await createCompanion({
      boxReady: true,
      workspaceRole: "viewer",
      selectedSkillIds: [],
      selectedMcpAccountIds: [],
    });
    const routineId = randomUUID();
    try {
      await sql`
        update companion_turn_attempts
        set status = 'cancelled', settled_at = now(), updated_at = now()
        where id = ${fixture.attemptId}::uuid
      `;
      await sql`
        update companion_turns
        set status = 'cancelled', settled_at = now(), state_changed_at = now(), updated_at = now()
        where id = ${fixture.turnId}::uuid
      `;
      await sql`
        insert into companion_routines(
          id, org_id, companion_id, name, prompt, cron, timezone,
          enabled, next_fire_at, created_by
        ) values (
          ${routineId}::uuid, ${ids.orgA}::uuid, ${fixture.companionId}::uuid,
          'Long thread routine', 'Project one bounded update.', '0 9 * * *', 'UTC',
          false, null, ${ids.ownerA}
        )
      `;

      await sql`
        insert into companion_turns(
          id, org_id, companion_id, client_message_id, message_event_id,
          queue_sequence, actor_id, client_surface, status, routine_id,
          routine_snapshot_id, routine_name, absolute_deadline_at,
          state_changed_at, settled_at
        )
        select md5('long-run-' || run_number::text)::uuid,
          ${ids.orgA}::uuid, ${fixture.companionId}::uuid,
          md5('long-client-' || run_number::text)::uuid,
          'msg:' || md5('long-client-' || run_number::text)::uuid::text,
          10000 + run_number, ${ids.ownerA}, 'web', 'succeeded',
          ${routineId}::uuid, ${routineId}::uuid, 'Long thread routine', now(), now(), now()
        from generate_series(1, 429) run_number
      `;

      // The seed entry is ordinal zero. The first 858 generated entries are 429 adjacent
      // routine-marker/update pairs; the remaining 1,141 are ordinary history.
      await sql`
        with generated as (
          select ordinal,
            ((ordinal + 1) / 2)::integer as run_number,
            md5('long-run-' || ((ordinal + 1) / 2)::text)::uuid as run_id
          from generate_series(1, 1999) ordinal
        )
        insert into companion_transcript_entries(
          org_id, companion_id, event_id, ordinal, role, content,
          author_id, turn_id, routine_name, created_at
        )
        select ${ids.orgA}::uuid, ${fixture.companionId}::uuid,
          case
            when ordinal <= 858 and ordinal % 2 = 1
              then 'msg:' || md5('long-client-' || run_number::text)::uuid::text
            when ordinal <= 858
              then 'long-routine-update-' || run_number::text
            else 'long-message-' || ordinal::text
          end,
          ordinal,
          case
            when ordinal <= 858 and ordinal % 2 = 1 then 'user'::companion_transcript_role
            else 'assistant'::companion_transcript_role
          end,
          'Bounded transcript entry ' || ordinal::text,
          case when ordinal <= 858 and ordinal % 2 = 1 then ${ids.ownerA} else null end,
          case when ordinal <= 858 and ordinal % 2 = 0 then run_id else null end,
          case when ordinal <= 858 and ordinal % 2 = 1 then 'Long thread routine' else null end,
          now() - make_interval(secs => 2000 - ordinal)
        from generated
      `;
      await sql`
        insert into companion_routine_returns(
          org_id, companion_id, run_id, mode, main_entry_event_id
        )
        select ${ids.orgA}::uuid, ${fixture.companionId}::uuid,
          md5('long-run-' || run_number::text)::uuid, 'notify',
          'long-routine-update-' || run_number::text
        from generate_series(1, 429) run_number
      `;
      await sql`
        update companion_threads
        set next_ordinal = 2000, last_message_at = now(), updated_at = now()
        where companion_id = ${fixture.companionId}::uuid
      `;

      type WindowRow = {
        accessRole: string;
        entries: Array<{ event_id: string; ordinal: number; content: string }>;
        olderBeforeOrdinal: number | null;
        syncSequence: string;
        notifyReturns: Array<{ run_id: string }>;
      };
      const readWindow = (actorId: string, before: number | null, markRead: boolean) => asApi({
        orgId: ids.orgA,
        actorId,
        action: (tx) => tx<Array<WindowRow>>`
          select access_role as "accessRole", entries,
            older_before_ordinal as "olderBeforeOrdinal",
            sync_sequence::text as "syncSequence",
            routine_notify_returns as "notifyReturns"
          from public.companion_api_read_thread_window(
            ${ids.orgA}::uuid, ${fixture.companionId}::uuid,
            ${before}::integer, 50, ${markRead}
          )
        `,
      });
      const [initial] = await readWindow(ids.ownerA, null, true);
      expect(initial?.entries).toHaveLength(50);
      expect(initial?.entries[0]?.ordinal).toBe(1950);
      expect(initial?.entries.at(-1)?.ordinal).toBe(1999);
      expect(Buffer.byteLength(JSON.stringify(initial?.entries), "utf8")).toBeLessThanOrEqual(
        1024 * 1024,
      );
      expect(initial?.olderBeforeOrdinal).toBe(1950);

      const [emptyDelta] = await asApi({
        orgId: ids.orgA,
        actorId: ids.ownerA,
        action: (tx) => tx<Array<{
          changedEntries: unknown[];
          deletedEventIds: string[];
          nextSequence: string;
          hasMore: boolean;
        }>>`
          select changed_entries as "changedEntries", deleted_event_ids as "deletedEventIds",
            next_sequence::text as "nextSequence", has_more as "hasMore"
          from public.companion_api_read_thread_changes(
            ${ids.orgA}::uuid, ${fixture.companionId}::uuid,
            ${initial!.syncSequence}::bigint, 200
          )
        `,
      });
      expect(emptyDelta).toEqual({
        changedEntries: [],
        deletedEventIds: [],
        nextSequence: initial!.syncSequence,
        hasMore: false,
      });
      expect(Buffer.byteLength(JSON.stringify(emptyDelta), "utf8")).toBeLessThan(10_000);

      await sql`
        update companion_transcript_entries set content = 'Exactly one changed projection'
        where companion_id = ${fixture.companionId}::uuid and event_id = 'long-message-1000'
      `;
      const [singleDelta] = await asApi({
        orgId: ids.orgA,
        actorId: ids.ownerA,
        action: (tx) => tx<Array<{
          changedEntries: Array<{ event_id: string; content: string }>;
          nextSequence: string;
          hasMore: boolean;
        }>>`
          select changed_entries as "changedEntries", next_sequence::text as "nextSequence",
            has_more as "hasMore"
          from public.companion_api_read_thread_changes(
            ${ids.orgA}::uuid, ${fixture.companionId}::uuid,
            ${initial!.syncSequence}::bigint, 200
          )
        `,
      });
      expect(singleDelta?.changedEntries).toEqual([expect.objectContaining({
        event_id: "long-message-1000",
        content: "Exactly one changed projection",
      })]);
      expect(singleDelta?.hasMore).toBe(false);

      const [historyPage] = await readWindow(ids.ownerA, 859, false);
      expect(historyPage?.entries).toHaveLength(50);
      expect(historyPage?.notifyReturns).toHaveLength(25);
      const [watermarkBeforeRace] = await sql<Array<{ ordinal: number | null }>>`
        select last_read_ordinal as ordinal from companion_member_state
        where companion_id = ${fixture.companionId}::uuid and user_id = ${ids.ownerA}
      `;
      expect(watermarkBeforeRace?.ordinal).toBe(1999);

      const concurrentEventId = 'long-concurrent-2000';
      const [racedWindow] = await Promise.all([
        readWindow(ids.ownerA, null, false).then((rows) => rows[0]!),
        sql.begin(async (tx) => {
          await tx`
            insert into companion_transcript_entries(
              org_id, companion_id, event_id, ordinal, role, content
            ) values (
              ${ids.orgA}::uuid, ${fixture.companionId}::uuid,
              ${concurrentEventId}, 2000, 'assistant', 'Concurrent bootstrap write'
            )
          `;
          await tx`
            update companion_threads set next_ordinal = 2001, last_message_at = now()
            where companion_id = ${fixture.companionId}::uuid
          `;
        }),
      ]);
      const [afterRace] = await asApi({
        orgId: ids.orgA,
        actorId: ids.ownerA,
        action: (tx) => tx<Array<{ changedEntries: Array<{ event_id: string }> }>>`
          select changed_entries as "changedEntries"
          from public.companion_api_read_thread_changes(
            ${ids.orgA}::uuid, ${fixture.companionId}::uuid,
            ${racedWindow.syncSequence}::bigint, 200
          )
        `,
      });
      const raceObserved =
        racedWindow.entries.some((entry) => entry.event_id === concurrentEventId)
        || afterRace!.changedEntries.some((entry) => entry.event_id === concurrentEventId);
      expect(raceObserved).toBe(true);

      const [viewerWindow] = await readWindow(ids.viewerA, null, false);
      expect(viewerWindow?.accessRole).toBe("viewer");
      expect(await asApi({
        orgId: ids.orgB,
        actorId: ids.ownerB,
        action: (tx) => tx`
          select * from public.companion_api_read_thread_window(
            ${ids.orgB}::uuid, ${fixture.companionId}::uuid, null, 50, false
          )
        `,
      })).toEqual([]);
      const [watermarkAfterHistory] = await sql<Array<{ ordinal: number | null }>>`
        select last_read_ordinal as ordinal from companion_member_state
        where companion_id = ${fixture.companionId}::uuid and user_id = ${ids.ownerA}
      `;
      expect(watermarkAfterHistory).toEqual(watermarkBeforeRace);
    } finally {
      await sql`delete from companion_routines where companion_id = ${fixture.companionId}::uuid`;
      await removeCompanion(fixture.companionId);
    }
  });

  it("lets an explicit full-Box restart preempt and resolve the exact isolated routine", async () => {
    if (!sql) throw new Error("runtime executor database is not initialized");
    const fixture = await createCompanion({
      boxReady: true,
      selectedSkillIds: [],
      selectedMcpAccountIds: [],
    });
    const routineId = randomUUID();
    const oldRoutineToken = randomUUID();
    const oldRoutineExecutor = `${executorId}-full-restart-old-routine`;
    const restartExecutor = `${executorId}-full-restart`;
    let restartClaim: Claim | undefined;
    try {
      await sql`
        insert into companion_routines(
          id, org_id, companion_id, name, prompt, cron, timezone,
          enabled, next_fire_at, created_by
        ) values (
          ${routineId}::uuid, ${ids.orgA}::uuid, ${fixture.companionId}::uuid,
          'Full restart routine', 'Wait for a full restart.', '0 9 * * *', 'UTC',
          false, null, ${ids.ownerA}
        )
      `;
      const routineInvocation = `routine:${fixture.turnId}:dispatch-v2:full-restart`;
      await sql`
        update companion_turns
        set routine_id = ${routineId}::uuid, routine_snapshot_id = ${routineId}::uuid,
          routine_name = 'Full restart routine', status = 'running', settled_at = null,
          state_changed_at = now(), updated_at = now()
        where id = ${fixture.turnId}::uuid
      `;
      await sql`
        update companion_turn_attempts
        set execution_lane = 'routine', status = 'running', checkpoint = 'running',
          dispatch_state = 'accepted', command_id = ${randomUUID()}::uuid,
          pi_invocation_id = ${routineInvocation}, dispatch_accepted_at = now(),
          last_activity_at = now(), updated_at = now()
        where id = ${fixture.attemptId}::uuid
      `;
      await sql`
        update companion_runtime_leases
        set claim_token = ${oldRoutineToken}::uuid, claim_epoch = claim_epoch + 1,
          gate_epoch = (select gate_epoch from companion_runtime_control where id = 'runtime-v2'),
          executor_id = ${oldRoutineExecutor}, work_kind = 'attempt',
          work_id = ${fixture.attemptId}::uuid, claimed_at = now(), renewed_at = now(),
          expires_at = now() + interval '30 seconds', updated_at = now()
        where companion_id = ${fixture.companionId}::uuid and lane = 'routine'
      `;
      const [restart] = await asApi({
        orgId: ids.orgA,
        actorId: ids.ownerA,
        action: (tx) => tx<Array<{ operation: { id: string } }>>`
          select * from public.companion_api_enqueue_operation(
            ${ids.orgA}::uuid, ${fixture.companionId}::uuid,
            ${randomUUID()}::uuid, 'restart_box', 'web'
          )
        `,
      });
      if (!restart) throw new Error("expected a full Box restart operation");

      [restartClaim] = await claimWorkRows(1, restartExecutor);
      expect(restartClaim).toMatchObject({
        companionId: fixture.companionId,
        workKind: "operation",
        workId: restart.operation.id,
      });
      const [preempted] = await sql<Array<{
        turnStatus: string;
        attemptStatus: string;
        errorCode: string | null;
        sourceTurnId: string | null;
        routineToken: string | null;
      }>>`
        select turn_row.status::text as "turnStatus",
          attempt.status::text as "attemptStatus",
          turn_row.last_error_code as "errorCode",
          operation.source_turn_id::text as "sourceTurnId",
          lease.claim_token::text as "routineToken"
        from companion_turns turn_row
        join companion_turn_attempts attempt on attempt.turn_id = turn_row.id
        join companion_operations operation on operation.id = ${restart.operation.id}::uuid
        join companion_runtime_leases lease
          on lease.companion_id = turn_row.companion_id and lease.lane = 'routine'
        where turn_row.id = ${fixture.turnId}::uuid
      `;
      expect(preempted).toEqual({
        turnStatus: "interrupted",
        attemptStatus: "interrupted",
        errorCode: "runtime_lifecycle_preempted",
        sourceTurnId: fixture.turnId,
        routineToken: null,
      });
      const [authorization] = await asRuntime((tx) => tx<Array<{
        authorized: boolean;
        turnId: string | null;
        commandPiInvocationId: string | null;
      }>>`
        select authorized, turn_id::text as "turnId",
          command_pi_invocation_id as "commandPiInvocationId"
        from public.companion_runtime_renew_and_authorize_v2(
          ${restartClaim!.orgId}::uuid, ${restartClaim!.companionId}::uuid,
          ${restartClaim!.claimToken}::uuid, ${restartClaim!.claimEpoch}::bigint,
          ${restartClaim!.gateEpoch}::bigint, ${restartExecutor}, 'operation',
          ${restartClaim!.workId}::uuid, 30
        )
      `);
      expect(authorization).toEqual({
        authorized: true,
        turnId: fixture.turnId,
        commandPiInvocationId: routineInvocation,
      });

      // Operation unit tests prove that this exact run-scoped invocation is terminated before the
      // Box is stopped. Materialize the successful lifecycle proof to verify SQL settlement.
      await sql`
        update companion_operations set checkpoint = 'pi_ready', checkpoint_sequence = 1
        where id = ${restartClaim!.workId}::uuid and status = 'running'
      `;
      const [settled] = await asRuntime((tx) => tx<Array<{ settled: boolean }>>`
        select public.companion_runtime_settle(
          ${restartClaim!.orgId}::uuid, ${restartClaim!.companionId}::uuid,
          ${restartClaim!.claimToken}::uuid, ${restartClaim!.claimEpoch}::bigint,
          ${restartClaim!.gateEpoch}::bigint, ${restartExecutor}, 'operation',
          ${restartClaim!.workId}::uuid, 'succeeded', null, null, null
        ) as settled
      `);
      expect(settled?.settled).toBe(true);
      restartClaim = undefined;
      const [resolved] = await sql<Array<{ resolution: string | null; recoveries: number }>>`
        select turn_row.resolution,
          count(recovery.id)::integer as recoveries
        from companion_turns turn_row
        left join companion_operations recovery
          on recovery.companion_id = turn_row.companion_id
          and recovery.source_turn_id = turn_row.id
          and recovery.trigger = 'recovery'
        where turn_row.id = ${fixture.turnId}::uuid
        group by turn_row.resolution
      `;
      expect(resolved).toEqual({ resolution: "auto_abandoned", recoveries: 0 });
    } finally {
      if (restartClaim) await release(restartClaim, restartExecutor);
      await sql`delete from companion_routines where companion_id = ${fixture.companionId}::uuid`;
      await removeCompanion(fixture.companionId);
    }
  });

  it("lets permanent delete preempt and recover past an interrupted isolated routine", async () => {
    if (!sql) throw new Error("runtime executor database is not initialized");
    const fixture = await createCompanion({
      boxReady: true,
      selectedSkillIds: [],
      selectedMcpAccountIds: [],
    });
    const routineId = randomUUID();
    const routineExecutor = `${executorId}-delete-routine`;
    const deleteExecutor = `${executorId}-delete-main`;
    const takeoverExecutor = `${executorId}-delete-takeover`;
    const routineLeaseBlocker = postgres(runtimeUrl.toString(), { max: 1 });
    let routineLeaseBlockerOpen = false;
    let routineClaim: Claim | undefined;
    let deleteClaim: Claim | undefined;
    try {
      await sql`
        update companion_turn_attempts
        set status = 'cancelled', settled_at = now(), updated_at = now()
        where id = ${fixture.attemptId}::uuid
      `;
      await sql`
        update companion_turns
        set status = 'cancelled', settled_at = now(), state_changed_at = now(), updated_at = now()
        where id = ${fixture.turnId}::uuid
      `;
      await sql`
        update companion_runtime_instances
        set material_pi_invocation_id = pi_invocation_id, material_client_surface = 'web',
          material_expires_at = now() + interval '6 hours', last_observed_at = now()
        where companion_id = ${fixture.companionId}::uuid
      `;
      await asApi({
        orgId: ids.orgA,
        actorId: ids.ownerA,
        action: (tx) => tx`
          select public.companion_api_create_routine(
            ${ids.orgA}::uuid, ${fixture.companionId}::uuid, ${routineId}::uuid,
            'Delete preemption routine', 'Wait for deletion.', '0 9 * * *', 'UTC', true,
            now() + interval '1 hour'
          )
        `,
      });
      await sql`
        update companion_routines set next_fire_at = now() - interval '1 second'
        where id = ${routineId}::uuid
      `;
      const [due] = await asWorker((tx) => tx<Array<{ scheduledFor: Date }>>`
        select scheduled_for as "scheduledFor"
        from public.companion_claim_due_routines('delete-preemption-worker', 1, 60)
        where routine_id = ${routineId}::uuid
      `);
      if (!due) throw new Error("expected the delete preemption routine to become due");
      expect(await asWorker((tx) => tx<Array<{ outcome: string }>>`
        select outcome from public.companion_fire_routine(
          'delete-preemption-worker', ${ids.orgA}::uuid, ${routineId}::uuid,
          ${randomUUID()}::uuid, ${due.scheduledFor.toISOString()}::timestamptz,
          now() + interval '1 hour'
        )
      `)).toEqual([{ outcome: "fired" }]);

      const [routineTurn] = await sql<Array<{ turnId: string }>>`
        select id::text as "turnId" from companion_turns
        where companion_id = ${fixture.companionId}::uuid
          and routine_snapshot_id = ${routineId}::uuid
      `;
      if (!routineTurn) throw new Error("expected a routine-origin turn");
      [routineClaim] = await claimWorkRows(1, routineExecutor);
      if (!routineClaim) throw new Error("expected the routine attempt claim");
      expect(routineClaim).toMatchObject({
        companionId: fixture.companionId,
        workKind: "attempt",
      });
      const routineInvocation = `routine:${routineTurn.turnId}:dispatch-v2:delete-preemption`;
      await sql`
        update companion_turns
        set status = 'running', state_changed_at = now(), updated_at = now()
        where id = ${routineTurn.turnId}::uuid
      `;
      await sql`
        update companion_turn_attempts
        set status = 'running', checkpoint = 'running', dispatch_state = 'accepted',
          provider_credential_refs = '[]'::jsonb, mcp_credential_refs = '[]'::jsonb,
          command_id = ${randomUUID()}::uuid, pi_invocation_id = ${routineInvocation},
          dispatch_accepted_at = now(), last_activity_at = now(), updated_at = now()
        where id = ${routineClaim.workId}::uuid
      `;

      const deleteRequestId = randomUUID();
      const [deletion] = await asApi({
        orgId: ids.orgA,
        actorId: ids.ownerA,
        action: (tx) => tx<Array<{ operation: { id: string } }>>`
          select * from public.companion_api_enqueue_operation(
            ${ids.orgA}::uuid, ${fixture.companionId}::uuid,
            ${deleteRequestId}::uuid, 'delete', 'web'
          )
        `,
      });
      if (!deletion) throw new Error("expected the delete operation");

      // A routine renewal/checkpoint locks its lane lease before the shared instance. Delete must
      // skip this claim opportunity instead of locking the instance and forming the opposite side
      // of a deadlock. The next sweep claims immediately after the short routine transaction ends.
      await routineLeaseBlocker`begin`;
      routineLeaseBlockerOpen = true;
      await routineLeaseBlocker`
        select 1 from companion_runtime_leases
        where companion_id = ${fixture.companionId}::uuid and lane = 'routine'
        for update
      `;
      expect(await claimWorkRows(1, deleteExecutor)).toEqual([]);
      await routineLeaseBlocker`rollback`;
      routineLeaseBlockerOpen = false;

      [deleteClaim] = await claimWorkRows(1, deleteExecutor);
      if (!deleteClaim) throw new Error("expected the permanent delete claim");
      expect(deleteClaim).toMatchObject({
        companionId: fixture.companionId,
        workKind: "operation",
        workId: deletion.operation.id,
        checkpoint: "pending",
      });
      const [preempted] = await sql<Array<{
        turnStatus: string;
        attemptStatus: string;
        errorCode: string | null;
        errorAction: string | null;
        sourceTurnId: string | null;
        routineClaimToken: string | null;
        routineClaimEpoch: string;
      }>>`
        select turn_row.status::text as "turnStatus",
          attempt.status::text as "attemptStatus",
          attempt.last_error_code as "errorCode",
          attempt.last_error_action::text as "errorAction",
          operation.source_turn_id::text as "sourceTurnId",
          lease.claim_token::text as "routineClaimToken",
          lease.claim_epoch::text as "routineClaimEpoch"
        from companion_turns turn_row
        join companion_turn_attempts attempt on attempt.turn_id = turn_row.id
        join companion_operations operation on operation.id = ${deletion.operation.id}::uuid
        join companion_runtime_leases lease
          on lease.companion_id = turn_row.companion_id and lease.lane = 'routine'
        where turn_row.id = ${routineTurn.turnId}::uuid
          and attempt.id = ${routineClaim.workId}::uuid
      `;
      expect(preempted).toMatchObject({
        turnStatus: "interrupted",
        attemptStatus: "interrupted",
        errorCode: "runtime_lifecycle_preempted",
        errorAction: "none",
        sourceTurnId: routineTurn.turnId,
        routineClaimToken: null,
        routineClaimEpoch: deleteClaim!.claimEpoch,
      });
      expect(await authorizeClaim(routineClaim, routineExecutor)).toEqual({
        authorized: false,
        denialCode: "lease_lost",
      });
      const [deleteAuthorization] = await asRuntime((tx) => tx<Array<{
        authorized: boolean;
        turnId: string | null;
        commandPiInvocationId: string | null;
      }>>`
        select authorized, turn_id::text as "turnId",
          command_pi_invocation_id as "commandPiInvocationId"
        from public.companion_runtime_renew_and_authorize_v2(
          ${deleteClaim!.orgId}::uuid, ${deleteClaim!.companionId}::uuid,
          ${deleteClaim!.claimToken}::uuid, ${deleteClaim!.claimEpoch}::bigint,
          ${deleteClaim!.gateEpoch}::bigint, ${deleteExecutor}, 'operation',
          ${deleteClaim!.workId}::uuid, 30
        )
      `);
      expect(deleteAuthorization).toEqual({
        authorized: true,
        turnId: routineTurn.turnId,
        commandPiInvocationId: routineInvocation,
      });

      await release(deleteClaim, deleteExecutor);
      deleteClaim = undefined;
      [deleteClaim] = await claimWorkRows(1, takeoverExecutor);
      expect(deleteClaim).toMatchObject({
        workKind: "operation",
        workId: deletion.operation.id,
        checkpoint: "pending",
      });
      const [recovered] = await sql<Array<{
        retirementState: string;
        turnStatus: string;
        sourceTurnId: string | null;
        attemptCount: number;
      }>>`
        select instance.retirement_state::text as "retirementState",
          turn_row.status::text as "turnStatus",
          operation.source_turn_id::text as "sourceTurnId",
          operation.attempt_count as "attemptCount"
        from companion_runtime_instances instance
        join companion_operations operation
          on operation.companion_id = instance.companion_id
          and operation.id = ${deletion.operation.id}::uuid
        join companion_turns turn_row on turn_row.id = operation.source_turn_id
        where instance.companion_id = ${fixture.companionId}::uuid
      `;
      expect(recovered).toEqual({
        retirementState: "requested",
        turnStatus: "interrupted",
        sourceTurnId: routineTurn.turnId,
        attemptCount: 2,
      });
    } finally {
      if (routineLeaseBlockerOpen) await routineLeaseBlocker`rollback`;
      await routineLeaseBlocker.end();
      if (deleteClaim) await release(deleteClaim, takeoverExecutor);
      if (routineClaim) await release(routineClaim, routineExecutor);
      await sql`delete from companion_routines where companion_id = ${fixture.companionId}::uuid`;
      await removeCompanion(fixture.companionId);
    }
  });

  it("pins routine context and projects private events through one replay-safe terminal return", async () => {
    if (!sql) throw new Error("runtime executor database is not initialized");
    const fixture = await createCompanion();
    const routineId = randomUUID();
    try {
      await sql`
        insert into companion_routines(
          id, org_id, companion_id, name, prompt, cron, timezone,
          enabled, next_fire_at, created_by
        ) values (
          ${routineId}::uuid, ${ids.orgA}::uuid, ${fixture.companionId}::uuid,
          'Isolated executor check', 'Inspect runtime state', '0 9 * * *', 'UTC',
          false, null, ${ids.ownerA}
        )
      `;
      await sql`
        update companion_transcript_entries
        set routine_name = 'Isolated executor check', turn_id = ${fixture.turnId}::uuid
        where companion_id = ${fixture.companionId}::uuid and turn_id is null
      `;
      await sql`
        update companion_turns
        set routine_id = ${routineId}::uuid, routine_snapshot_id = ${routineId}::uuid,
          routine_name = 'Isolated executor check'
        where id = ${fixture.turnId}::uuid
      `;
      await sql`
        update companion_runtime_instances
        set pi_invocation_id = 'main-pi'
        where org_id = ${ids.orgA}::uuid and companion_id = ${fixture.companionId}::uuid
      `;
      await sql`
        insert into companion_main_pi_compactions(
          org_id, companion_id, pi_invocation_id, generation, event_cursor,
          summary, first_kept_entry_id, tokens_before, estimated_tokens_after,
          cache_read, cache_write, sha256, observed_at
        ) values (
          ${ids.orgA}::uuid, ${fixture.companionId}::uuid, 'replaced-main-pi', 1, 8,
          'Stale context from the replaced main Pi must not be used.', 'entry-6',
          4000, 800, 300, 10, ${"b".repeat(64)}, now() + interval '1 minute'
        ), (
          ${ids.orgA}::uuid, ${fixture.companionId}::uuid, 'main-pi', 1, 9,
          ${`The main conversation established a deployment constraint.\n${"token ".repeat(3000)}`}, 'entry-7',
          5000, 900, 400, 20, ${"a".repeat(64)}, now()
        )
      `;
      const claim = await claimWork();
      expect(claim.workKind).toBe("attempt");
      const prepare = async () => await asRuntime((tx) => tx<Array<{
        isolated: boolean;
        contextId: string;
        sha256: string;
        content: string;
      }>>`
        select isolated, context_id::text as "contextId",
          context_sha256 as sha256, context_content as content
        from public.companion_runtime_prepare_routine_run(
          ${claim.orgId}::uuid, ${claim.companionId}::uuid, ${claim.claimToken}::uuid,
          ${claim.claimEpoch}::bigint, ${claim.gateEpoch}::bigint, ${executorId},
          'attempt', ${claim.workId}::uuid, true
        )
      `);
      const firstContext = await prepare();
      const takeoverContext = await prepare();
      expect(takeoverContext).toEqual(firstContext);
      expect(firstContext[0]).toMatchObject({
        isolated: true,
        sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        content: expect.stringContaining("The main conversation established a deployment constraint."),
      });
      expect(firstContext[0]?.content).not.toContain("Stale context from the replaced main Pi");
      expect(firstContext[0]?.content).toContain(
        "[Additional summary detail omitted to fit the routine context budget.]",
      );
      const rendered = firstContext[0]!.content;
      const estimatedTokens = Math.max(
        Math.ceil(Buffer.byteLength(rendered, "utf8") / 4),
        rendered.match(/[A-Za-z0-9_]+|[^\sA-Za-z0-9_]/g)?.length ?? 0,
        Math.ceil((Buffer.byteLength(rendered, "utf8") - [...rendered].length) / 2),
      );
      expect(estimatedTokens).toBeLessThanOrEqual(4_000);

      const events = [
        {
          sequence: "1", type: "assistant", entry_key: "assistant:1",
          content: "Private routine analysis", reasoning: null,
        },
        {
          sequence: "2", type: "tool", entry_key: "tool:call-1", content: "Tool · bash",
          tool: {
            call_id: "call-1", kind: "shell", name: "bash", title: "Check status",
            status: "ok", detail: "green", screenshot: null,
          },
        },
        {
          sequence: "3", type: "routine_return", call_id: "return-1",
          mode: "notify", message: "Deployment is healthy.",
        },
        {
          sequence: "4", type: "routine_return", call_id: "return-2",
          mode: "relay", message: "A later return must not win.",
        },
        {
          sequence: "5", type: "assistant", entry_key: "assistant:5",
          content: "Post-return output must be ignored", reasoning: null,
        },
      ];
      // Reproduce the production 09:33 -> 09:43 arithmetic relative to the database clock: the
      // original deadline is activity + 7 minutes (09:40), and the corrected deadline must be
      // activity + 10 minutes (09:43), including on the isolated routine projector.
      const [timeline] = await sql<Array<{
        activityAt: Date;
        previousActivityAt: Date;
        initialDeadlineAt: Date;
        absoluteDeadlineAt: Date;
      }>>`
        select now() - interval '3 minutes' as "activityAt",
          now() - interval '6 minutes' as "previousActivityAt",
          now() + interval '4 minutes' as "initialDeadlineAt",
          now() + interval '2 hours' as "absoluteDeadlineAt"
      `;
      if (!timeline) throw new Error("expected the monotone activity timeline");
      await sql`
        update companion_turns
        set inactivity_deadline_at = ${timeline.initialDeadlineAt.toISOString()}::timestamptz,
          absolute_deadline_at = ${timeline.absoluteDeadlineAt.toISOString()}::timestamptz
        where id = ${fixture.turnId}::uuid
      `;
      await sql`
        update companion_turn_attempts
        set last_activity_at = ${timeline.previousActivityAt.toISOString()}::timestamptz
        where id = ${fixture.attemptId}::uuid
      `;
      const project = async () => await asRuntime((tx) => tx<Array<{
        sequence: string;
        cursor: string;
        visible: boolean;
        returned: boolean;
      }>>`
        select checkpoint_sequence::text as sequence, event_cursor::text as cursor,
          has_visible_output as visible, routine_returned as returned
        from public.companion_runtime_project_event_batch_v2(
          ${claim.orgId}::uuid, ${claim.companionId}::uuid, ${claim.claimToken}::uuid,
          ${claim.claimEpoch}::bigint, ${claim.gateEpoch}::bigint, ${executorId},
          'attempt', ${claim.workId}::uuid, ${claim.checkpointSequence}::bigint,
          ${`pi-${fixture.attemptId}`}, ${tx.json(events)}, 5,
          ${timeline.activityAt.toISOString()}::timestamptz, 0, 0, 0
        )
      `);
      const projected = await project();
      expect(projected).toEqual([{ sequence: "1", cursor: "5", visible: false, returned: true }]);
      await expect(project()).resolves.toEqual(projected);
      const [activityProjection] = await sql<Array<{
        activityAt: Date | null;
        deadlineAt: Date | null;
      }>>`
        select attempt.last_activity_at as "activityAt",
          turn_row.inactivity_deadline_at as "deadlineAt"
        from companion_turn_attempts attempt
        join companion_turns turn_row on turn_row.id = attempt.turn_id
        where attempt.id = ${fixture.attemptId}::uuid
      `;
      expect(activityProjection?.activityAt?.getTime()).toBe(timeline.activityAt.getTime());
      expect(activityProjection?.deadlineAt?.getTime()).toBe(timeline.activityAt.getTime() + 600_000);
      expect(activityProjection!.deadlineAt!.getTime() - timeline.initialDeadlineAt.getTime())
        .toBe(180_000);

      const privateEntries = await sql<Array<{ role: string; content: string }>>`
        select role::text as role, content
        from companion_routine_run_entries where run_id = ${fixture.turnId}::uuid
        order by ordinal
      `;
      expect(privateEntries).toEqual([
        { role: "assistant", content: "Private routine analysis" },
        { role: "tool", content: "Tool · bash" },
      ]);
      const mainEntries = await sql<Array<{ content: string }>>`
        select content from companion_transcript_entries
        where companion_id = ${fixture.companionId}::uuid order by ordinal
      `;
      expect(mainEntries.map((entry) => entry.content)).toEqual([
        fixture.prompt,
        "Deployment is healthy.",
      ]);
      expect(JSON.stringify(mainEntries)).not.toContain("Private routine analysis");
      expect(JSON.stringify(mainEntries)).not.toContain("later return");
      expect(JSON.stringify(mainEntries)).not.toContain("Post-return");
      const returns = await sql<Array<{ mode: string; relayTurnId: string | null }>>`
        select mode::text as mode, relay_turn_id::text as "relayTurnId"
        from companion_routine_returns where run_id = ${fixture.turnId}::uuid
      `;
      expect(returns).toEqual([{ mode: "notify", relayTurnId: null }]);
    } finally {
      await removeCompanion(fixture.companionId);
    }
  });

  it("returns the non-isolated preparation row for an ordinary main attempt", async () => {
    if (!sql) throw new Error("runtime executor database is not initialized");
    const fixture = await createCompanion();
    try {
      const claim = await claimWork();
      expect(claim).toMatchObject({
        workKind: "attempt",
        companionId: fixture.companionId,
      });

      const prepared = await asRuntime((tx) => tx<Array<{
        isolated: boolean;
        contextId: string | null;
        sha256: string | null;
        content: string | null;
      }>>`
        select isolated, context_id::text as "contextId",
          context_sha256 as sha256, context_content as content
        from public.companion_runtime_prepare_routine_run(
          ${claim.orgId}::uuid, ${claim.companionId}::uuid, ${claim.claimToken}::uuid,
          ${claim.claimEpoch}::bigint, ${claim.gateEpoch}::bigint, ${executorId},
          'attempt', ${claim.workId}::uuid, true
        )
      `);

      // Migration 0147 checked the composite result with `IS NOT NULL`. PostgreSQL evaluates that
      // predicate as false for this valid `(false, NULL, NULL, NULL)` payload, so the wrapper
      // returned no row and every ordinary message was reclaimed until its cold-start deadline.
      expect(prepared).toEqual([{
        isolated: false,
        contextId: null,
        sha256: null,
        content: null,
      }]);
    } finally {
      await removeCompanion(fixture.companionId);
    }
  });

  it("merges a delegated subagent run into one card and still refuses an unknown kind", async () => {
    if (!sql) throw new Error("runtime executor database is not initialized");
    const fixture = await createCompanion();
    const headline = "researcher: read the changelog";
    const callId = `sha256:${"a".repeat(32)}`;
    try {
      const claim = await claimWork();
      const delegated = (
        sequence: string,
        content: string,
        tool: IntegrationJsonObject,
      ) => ({
        sequence,
        type: "tool",
        entry_key: `tool:${sequence}`,
        content,
        tool: {
          call_id: callId,
          kind: "subagent",
          name: "subagent",
          title: "",
          status: "running",
          detail: null,
          screenshot: null,
          ...tool,
        },
      });
      const events = [
        delegated("1", headline, { title: headline, detail: "read the changelog" }),
        delegated("2", "", { detail: "reading CHANGELOG.md" }),
        delegated("3", "", { status: "error" }),
      ];

      // An unrecognized kind is still refused before anything is written, so widening the list is
      // an addition and not an opening.
      await expect(asRuntime((tx) => tx`
        select * from public.companion_runtime_project_event_batch(
          ${claim.orgId}::uuid, ${claim.companionId}::uuid, ${claim.claimToken}::uuid,
          ${claim.claimEpoch}::bigint, ${claim.gateEpoch}::bigint, ${executorId},
          'attempt', ${claim.workId}::uuid, ${claim.checkpointSequence}::bigint,
          ${`pi-${fixture.attemptId}`}, ${tx.json([
            delegated("1", "x", { kind: "telepathy" }),
          ])}, 1, now(), 0, 0, 0
        )
      `)).rejects.toMatchObject({ code: "22023" });

      const projected = await asRuntime((tx) => tx<Array<{
        sequence: string;
        cursor: string;
      }>>`
        select checkpoint_sequence::text as sequence, event_cursor::text as cursor
        from public.companion_runtime_project_event_batch(
          ${claim.orgId}::uuid, ${claim.companionId}::uuid, ${claim.claimToken}::uuid,
          ${claim.claimEpoch}::bigint, ${claim.gateEpoch}::bigint, ${executorId},
          'attempt', ${claim.workId}::uuid, ${claim.checkpointSequence}::bigint,
          ${`pi-${fixture.attemptId}`}, ${tx.json(events)}, 3, now(), 0, 0, 0
        )
      `);
      expect(projected).toEqual([{ sequence: "1", cursor: "3" }]);

      // Three events, one card: the headline survived the progress that carried none, and the
      // settlement kept the last progress it followed. A failure is the case that matters most —
      // it is where a reader needs to see what the child agent was doing when it stopped.
      const cards = await sql<Array<{
        content: string;
        title: string;
        detail: string | null;
        status: string;
      }>>`
        select content, tool ->> 'title' as title, tool ->> 'detail' as detail,
          tool ->> 'status' as status
        from companion_transcript_entries
        where companion_id = ${fixture.companionId}::uuid and role = 'tool'
        order by ordinal
      `;
      expect(cards).toEqual([{
        content: headline,
        title: headline,
        detail: "reading CHANGELOG.md",
        status: "error",
      }]);

      // Replaying the committed page is still a digest check, not a second projection.
      const replayed = await asRuntime((tx) => tx<Array<{ cursor: string }>>`
        select event_cursor::text as cursor
        from public.companion_runtime_project_event_batch(
          ${claim.orgId}::uuid, ${claim.companionId}::uuid, ${claim.claimToken}::uuid,
          ${claim.claimEpoch}::bigint, ${claim.gateEpoch}::bigint, ${executorId},
          'attempt', ${claim.workId}::uuid, ${claim.checkpointSequence}::bigint,
          ${`pi-${fixture.attemptId}`}, ${tx.json(events)}, 3, now(), 0, 0, 0
        )
      `);
      expect(replayed).toEqual([{ cursor: "3" }]);

      // A progress line whose start never landed -- an oversized start line is dropped by the
      // broker and never projected -- still becomes a card that names the tool.
      const orphan = await asRuntime((tx) => tx<Array<{ cursor: string }>>`
        select event_cursor::text as cursor
        from public.companion_runtime_project_event_batch(
          ${claim.orgId}::uuid, ${claim.companionId}::uuid, ${claim.claimToken}::uuid,
          ${claim.claimEpoch}::bigint, ${claim.gateEpoch}::bigint, ${executorId},
          'attempt', ${claim.workId}::uuid, ${projected[0]!.sequence}::bigint,
          ${`pi-${fixture.attemptId}`}, ${tx.json([{
            ...delegated("4", "", { detail: "still working" }),
            tool: {
              call_id: `sha256:${"b".repeat(32)}`,
              kind: "subagent",
              name: "subagent",
              title: "",
              status: "running",
              detail: "still working",
              screenshot: null,
            },
          }])}, 4, now(), 0, 0, 0
        )
      `);
      expect(orphan).toEqual([{ cursor: "4" }]);
      const [started] = await sql<Array<{ content: string; title: string }>>`
        select content, tool ->> 'title' as title
        from companion_transcript_entries
        where companion_id = ${fixture.companionId}::uuid and role = 'tool'
        order by ordinal desc limit 1
      `;
      expect(started).toEqual({ content: "subagent", title: "subagent" });
    } finally {
      await removeCompanion(fixture.companionId);
    }
  });

  it("returns a takeover-safe negative proof when settlement has no visible output", async () => {
    if (!sql) throw new Error("runtime executor database is not initialized");
    const fixture = await createCompanion();
    try {
      const claim = await claimWork();
      const controlOnly = await asRuntime((tx) => tx<Array<{
        sequence: string;
        cursor: string;
        visible: boolean;
      }>>`
        select checkpoint_sequence::text as sequence, event_cursor::text as cursor,
          has_visible_output as visible
        from public.companion_runtime_project_event_batch(
          ${claim.orgId}::uuid, ${claim.companionId}::uuid, ${claim.claimToken}::uuid,
          ${claim.claimEpoch}::bigint, ${claim.gateEpoch}::bigint, ${executorId},
          'attempt', ${claim.workId}::uuid, ${claim.checkpointSequence}::bigint,
          ${`pi-${fixture.attemptId}`}, ${tx.json([])}, 1, null, 0, 0, 0
        )
      `);
      expect(controlOnly).toEqual([{ sequence: "1", cursor: "1", visible: false }]);
      const result = await asRuntime((tx) => tx<Array<{
        sequence: string;
        cursor: string;
        visible: boolean;
      }>>`
        select checkpoint_sequence::text as sequence, event_cursor::text as cursor,
          has_visible_output as visible
        from public.companion_runtime_project_event_batch(
          ${claim.orgId}::uuid, ${claim.companionId}::uuid, ${claim.claimToken}::uuid,
          ${claim.claimEpoch}::bigint, ${claim.gateEpoch}::bigint, ${executorId},
          'attempt', ${claim.workId}::uuid, 1,
          ${`pi-${fixture.attemptId}`}, ${tx.json([{ sequence: "2", type: "settled" }])},
          2, null, 0, 0, 0
        )
      `);
      expect(result).toEqual([{ sequence: "2", cursor: "2", visible: false }]);
      const [terminal] = await sql<Array<{ checkpoint: string }>>`
        select checkpoint from companion_turn_attempts
        where id = ${fixture.attemptId}::uuid
      `;
      expect(terminal).toEqual({ checkpoint: "agent_settled" });
      const material = await asRuntime((tx) => tx<Array<{ visible: boolean }>>`
        select has_visible_output as visible
        from public.companion_runtime_get_material(
          ${claim.orgId}::uuid, ${claim.companionId}::uuid, ${claim.claimToken}::uuid,
          ${claim.claimEpoch}::bigint, ${claim.gateEpoch}::bigint, ${executorId},
          'attempt', ${claim.workId}::uuid, 30
        )
      `);
      expect(material).toEqual([{ visible: false }]);
      const terminalProjection = await asRuntime((tx) => tx<Array<{
        checkpoint: string;
        cursor: string;
        visible: boolean;
      }>>`
        select checkpoint, event_cursor::text as cursor, has_visible_output as visible
        from public.companion_runtime_get_attempt_terminal_projection(
          ${claim.orgId}::uuid, ${claim.companionId}::uuid, ${claim.claimToken}::uuid,
          ${claim.claimEpoch}::bigint, ${claim.gateEpoch}::bigint, ${executorId},
          'attempt', ${claim.workId}::uuid
        )
      `);
      expect(terminalProjection).toEqual([{
        checkpoint: "agent_settled",
        cursor: "2",
        visible: false,
      }]);
    } finally {
      await removeCompanion(fixture.companionId);
    }
  });

  it("persists a projected Pi exit as takeover-safe terminal proof", async () => {
    if (!sql) throw new Error("runtime executor database is not initialized");
    const fixture = await createCompanion();
    try {
      const claim = await claimWork();
      const projected = await asRuntime((tx) => tx<Array<{ cursor: string }>>`
        select event_cursor::text as cursor
        from public.companion_runtime_project_event_batch(
          ${claim.orgId}::uuid, ${claim.companionId}::uuid, ${claim.claimToken}::uuid,
          ${claim.claimEpoch}::bigint, ${claim.gateEpoch}::bigint, ${executorId},
          'attempt', ${claim.workId}::uuid, ${claim.checkpointSequence}::bigint,
          ${`pi-${fixture.attemptId}`},
          ${tx.json([{ sequence: "1", type: "process_exit", code: 137, signal: "SIGKILL" }])},
          1, null, 0, 0, 0
        )
      `);
      expect(projected).toEqual([{ cursor: "1" }]);
      const [terminal] = await sql<Array<{ checkpoint: string; status: string }>>`
        select checkpoint, status::text as status from companion_turn_attempts
        where id = ${fixture.attemptId}::uuid
      `;
      expect(terminal).toEqual({ checkpoint: "process_exited", status: "running" });
    } finally {
      await removeCompanion(fixture.companionId);
    }
  });

  it("resumes duplicate Box cleanup and blocks canonical progression until every child is deleted", async () => {
    if (!sql) throw new Error("runtime executor database is not initialized");
    const fixture = await createCompanion();
    try {
      const operationId = randomUUID();
      await sql`
        insert into companion_operations(
          id, org_id, companion_id, request_id, kind, trigger, actor_id, runtime_generation
        ) values (
          ${operationId}::uuid, ${ids.orgA}::uuid, ${fixture.companionId}::uuid,
          ${randomUUID()}::uuid, 'start', 'user', ${ids.ownerA}, 1
        )
      `;
      // The active attempt has higher precedence than Start; remove it from this operation fixture.
      await sql`delete from companion_turn_attempts where id = ${fixture.attemptId}::uuid`;
      await sql`
        update companion_turns set status = 'cancelled', settled_at = now(),
          inactivity_deadline_at = null, absolute_deadline_at = null
        where id = ${fixture.turnId}::uuid
      `;
      const claim = await claimWork();
      expect(claim.workKind).toBe("operation");
      const [resolving] = await asRuntime((tx) => tx<Array<{ sequence: string | null }>>`
        select public.companion_runtime_checkpoint(
          ${claim.orgId}::uuid, ${claim.companionId}::uuid, ${claim.claimToken}::uuid,
          ${claim.claimEpoch}::bigint, ${claim.gateEpoch}::bigint, ${executorId},
          'operation', ${claim.workId}::uuid, ${claim.checkpointSequence}::bigint,
          'resolving_box', null, null, null, null, null, null, null, null
        )::text as sequence
      `);
      expect(resolving?.sequence).toBe("1");
      const [absence] = await asRuntime((tx) => tx<Array<{ sequence: string | null }>>`
        select public.companion_runtime_observe_instance(
          ${claim.orgId}::uuid, ${claim.companionId}::uuid, ${claim.claimToken}::uuid,
          ${claim.claimEpoch}::bigint, ${claim.gateEpoch}::bigint, ${executorId},
          'operation', ${claim.workId}::uuid, 1, 1, null, 'absent',
          null, null, null, null, null, now()
        )::text as sequence
      `);
      expect(absence?.sequence).toBe("2");
      const [creating] = await asRuntime((tx) => tx<Array<{ sequence: string | null }>>`
        select public.companion_runtime_checkpoint(
          ${claim.orgId}::uuid, ${claim.companionId}::uuid, ${claim.claimToken}::uuid,
          ${claim.claimEpoch}::bigint, ${claim.gateEpoch}::bigint, ${executorId},
          'operation', ${claim.workId}::uuid, 2, 'creating_box',
          null, null, null, null, null, null, null, null
        )::text as sequence
      `);
      expect(creating?.sequence).toBe("3");
      const duplicateIds = ["bx_2345678a", "bx_2345678b"];
      const registered = await asRuntime((tx) => tx<Array<{ boxId: string; status: string }>>`
        select box_id as "boxId", status::text as status
        from public.companion_runtime_register_duplicate_cleanups(
          ${claim.orgId}::uuid, ${claim.companionId}::uuid, ${claim.claimToken}::uuid,
          ${claim.claimEpoch}::bigint, ${claim.gateEpoch}::bigint, ${executorId},
          'operation', ${claim.workId}::uuid, ${duplicateIds}::text[]
        )
      `);
      expect(registered).toEqual(duplicateIds.map((boxId) => ({ boxId, status: "pending" })));

      await expect(asRuntime((tx) => tx`
        select public.companion_runtime_observe_instance(
          ${claim.orgId}::uuid, ${claim.companionId}::uuid, ${claim.claimToken}::uuid,
          ${claim.claimEpoch}::bigint, ${claim.gateEpoch}::bigint, ${executorId},
          'operation', ${claim.workId}::uuid, 1, 3, 'bx_23456789', 'initializing',
          null, null, null, null, null, now()
        )
      `)).rejects.toMatchObject({ code: "22023" });
      const stale = await asRuntime((tx) => tx`
        select * from public.companion_runtime_checkpoint_duplicate_cleanup(
          ${claim.orgId}::uuid, ${claim.companionId}::uuid, ${claim.claimToken}::uuid,
          (${claim.claimEpoch}::bigint + 1), ${claim.gateEpoch}::bigint, ${executorId},
          'operation', ${claim.workId}::uuid, ${duplicateIds[0]!}, 0,
          'already_deleted', null
        )
      `);
      expect(stale).toEqual([]);

      const checkpointCleanup = async (
        boxId: string,
        sequence: number,
        status: "delete_requested" | "waiting_deleted" | "deleted" | "already_deleted",
        operation: string | null,
      ) => asRuntime((tx) => tx`
        select * from public.companion_runtime_checkpoint_duplicate_cleanup(
          ${claim.orgId}::uuid, ${claim.companionId}::uuid, ${claim.claimToken}::uuid,
          ${claim.claimEpoch}::bigint, ${claim.gateEpoch}::bigint, ${executorId},
          'operation', ${claim.workId}::uuid, ${boxId}, ${sequence}, ${status}, ${operation}
        )
      `);
      await checkpointCleanup(duplicateIds[0]!, 0, "delete_requested", "delete-operation-1");
      await checkpointCleanup(duplicateIds[0]!, 1, "waiting_deleted", null);
      await checkpointCleanup(duplicateIds[0]!, 2, "deleted", null);
      await checkpointCleanup(duplicateIds[1]!, 0, "already_deleted", null);
      const resumed = await asRuntime((tx) => tx<Array<{ boxId: string; status: string }>>`
        select box_id as "boxId", status::text as status
        from public.companion_runtime_register_duplicate_cleanups(
          ${claim.orgId}::uuid, ${claim.companionId}::uuid, ${claim.claimToken}::uuid,
          ${claim.claimEpoch}::bigint, ${claim.gateEpoch}::bigint, ${executorId},
          'operation', ${claim.workId}::uuid, array[]::text[]
        )
      `);
      expect(resumed).toEqual([
        { boxId: duplicateIds[0], status: "deleted" },
        { boxId: duplicateIds[1], status: "already_deleted" },
      ]);
      const [observed] = await asRuntime((tx) => tx<Array<{ sequence: string | null }>>`
        select public.companion_runtime_observe_instance(
          ${claim.orgId}::uuid, ${claim.companionId}::uuid, ${claim.claimToken}::uuid,
          ${claim.claimEpoch}::bigint, ${claim.gateEpoch}::bigint, ${executorId},
          'operation', ${claim.workId}::uuid, 1, 3, 'bx_23456789', 'initializing',
          null, null, null, null, null, now()
        )::text as sequence
      `);
      expect(observed?.sequence).toBe("4");

      // A duplicate may appear after the provider accepted the deterministic
      // generation name. Registration and the progression guard must remain
      // active at box_created so a takeover cannot stage the canonical Box
      // before that late child is durably reconciled.
      const lateDuplicateId = "bx_2345678c";
      const lateRegistered = await asRuntime((tx) => tx<Array<{
        boxId: string;
        status: string;
      }>>`
        select box_id as "boxId", status::text as status
        from public.companion_runtime_register_duplicate_cleanups(
          ${claim.orgId}::uuid, ${claim.companionId}::uuid, ${claim.claimToken}::uuid,
          ${claim.claimEpoch}::bigint, ${claim.gateEpoch}::bigint, ${executorId},
          'operation', ${claim.workId}::uuid, array[${lateDuplicateId}]::text[]
        )
        where box_id = ${lateDuplicateId}
      `);
      expect(lateRegistered).toEqual([{ boxId: lateDuplicateId, status: "pending" }]);

      await expect(asRuntime((tx) => tx`
        select public.companion_runtime_checkpoint(
          ${claim.orgId}::uuid, ${claim.companionId}::uuid, ${claim.claimToken}::uuid,
          ${claim.claimEpoch}::bigint, ${claim.gateEpoch}::bigint, ${executorId},
          'operation', ${claim.workId}::uuid, 4, 'waiting_ready',
          null, null, null, null, null, null, null, null
        )
      `)).rejects.toMatchObject({ code: "22023" });

      await checkpointCleanup(lateDuplicateId, 0, "already_deleted", null);
      const [waitingReady] = await asRuntime((tx) => tx<Array<{ sequence: string | null }>>`
        select public.companion_runtime_checkpoint(
          ${claim.orgId}::uuid, ${claim.companionId}::uuid, ${claim.claimToken}::uuid,
          ${claim.claimEpoch}::bigint, ${claim.gateEpoch}::bigint, ${executorId},
          'operation', ${claim.workId}::uuid, 4, 'waiting_ready',
          null, null, null, null, null, null, null, null
        )::text as sequence
      `);
      expect(waitingReady?.sequence).toBe("5");
    } finally {
      await removeCompanion(fixture.companionId);
    }
  });

  it("keeps Viewer, nonmember, and cross-tenant desktop requests opaque", async () => {
    const fixture = await createCompanion({ boxReady: true, workspaceRole: "viewer" });
    const denied = [{
      authorized: false,
      denialCode: "not_authorized",
      boxId: null,
      boxState: null,
      generation: null,
    }];
    try {
      expect(await authorizeDesktop({
        companionId: fixture.companionId,
        actorId: ids.ownerA,
      })).toEqual([{
        authorized: true,
        denialCode: null,
        boxId: "bx_23456789",
        boxState: "ready",
        generation: "1",
      }]);
      expect(await authorizeDesktop({
        companionId: fixture.companionId,
        actorId: ids.viewerA,
      })).toEqual(denied);
      expect(await authorizeDesktop({
        companionId: fixture.companionId,
        actorId: ids.ownerB,
      })).toEqual(denied);
      expect(await authorizeDesktop({
        companionId: fixture.companionId,
        orgId: ids.orgB,
        actorId: ids.ownerB,
      })).toEqual(denied);
    } finally {
      await removeCompanion(fixture.companionId);
    }
  });

  it("requires the desktop actor to own every personal Skill and MCP pin", async () => {
    const privateCases = [
      {
        name: "Editor on Owner personal Skill",
        actorId: ids.editorA,
        selectedSkillIds: [ids.skill],
        selectedMcpAccountIds: [],
      },
      {
        name: "Editor on Owner MCP account",
        actorId: ids.editorA,
        selectedSkillIds: [ids.orgSkill],
        selectedMcpAccountIds: [ids.mcpAccount],
      },
      {
        name: "Owner on Editor personal Skill",
        actorId: ids.ownerA,
        selectedSkillIds: [ids.editorSkill],
        selectedMcpAccountIds: [],
      },
      {
        name: "Owner on Editor MCP account",
        actorId: ids.ownerA,
        selectedSkillIds: [ids.orgSkill],
        selectedMcpAccountIds: [ids.editorMcpAccount],
      },
    ];
    for (const privacyCase of privateCases) {
      const fixture = await createCompanion({
        boxReady: true,
        workspaceRole: "editor",
        selectedSkillIds: privacyCase.selectedSkillIds,
        selectedMcpAccountIds: privacyCase.selectedMcpAccountIds,
      });
      try {
        expect(
          await authorizeDesktop({
            companionId: fixture.companionId,
            actorId: privacyCase.actorId,
          }),
          privacyCase.name,
        ).toEqual([{
          authorized: false,
          denialCode: "resource_access_revoked",
          boxId: null,
          boxState: null,
          generation: null,
        }]);
      } finally {
        await removeCompanion(fixture.companionId);
      }
    }

    const editorFixture = await createCompanion({
      boxReady: true,
      workspaceRole: "editor",
      selectedSkillIds: [ids.editorSkill],
      selectedMcpAccountIds: [ids.editorMcpAccount],
    });
    try {
      expect(await authorizeDesktop({
        companionId: editorFixture.companionId,
        actorId: ids.editorA,
      })).toMatchObject([{ authorized: true, denialCode: null, boxId: "bx_23456789" }]);
    } finally {
      await removeCompanion(editorFixture.companionId);
    }

    const orgFixture = await createCompanion({
      boxReady: true,
      workspaceRole: "editor",
      selectedSkillIds: [ids.orgSkill],
      selectedMcpAccountIds: [],
    });
    try {
      expect(await authorizeDesktop({
        companionId: orgFixture.companionId,
        actorId: ids.editorA,
      })).toMatchObject([{ authorized: true, denialCode: null, boxId: "bx_23456789" }]);
    } finally {
      await removeCompanion(orgFixture.companionId);
    }
  });

  it("denies desktop until both current settings and Skills revisions are applied", async () => {
    if (!sql) throw new Error("runtime executor database is not initialized");
    const fixture = await createCompanion({
      boxReady: true,
      workspaceRole: "editor",
      selectedSkillIds: [ids.orgSkill],
      selectedMcpAccountIds: [],
    });
    const settingsNotApplied = [{
      authorized: false,
      denialCode: "settings_not_applied",
      boxId: null,
      boxState: null,
      generation: null,
    }];
    try {
      await sql`
        update companion_runtime_instances
        set desired_settings_revision = 2
        where companion_id = ${fixture.companionId}::uuid
      `;
      expect(await authorizeDesktop({
        companionId: fixture.companionId,
        actorId: ids.editorA,
      })).toEqual(settingsNotApplied);

      await sql`
        update companion_runtime_instances
        set applied_settings_revision = 2
        where companion_id = ${fixture.companionId}::uuid
      `;
      await sql`
        update companions
        set skills_revision = 2
        where id = ${fixture.companionId}::uuid
      `;
      expect(await authorizeDesktop({
        companionId: fixture.companionId,
        actorId: ids.editorA,
      })).toEqual(settingsNotApplied);

      await sql`
        update companion_runtime_instances
        set applied_skills_revision = 2, generation = 2147483647
        where companion_id = ${fixture.companionId}::uuid
      `;
      expect(await authorizeDesktop({
        companionId: fixture.companionId,
        actorId: ids.editorA,
      })).toMatchObject([{
        authorized: true,
        denialCode: null,
        boxId: "bx_23456789",
        generation: "2147483647",
      }]);
      await expect(sql`
        update companion_runtime_instances set generation = 2147483648
        where companion_id = ${fixture.companionId}::uuid
      `).rejects.toMatchObject({ code: "23514" });
    } finally {
      await removeCompanion(fixture.companionId);
    }
  });

  it("locks staged revisions and resource ownership through desktop authorization", async () => {
    if (!sql) throw new Error("runtime executor database is not initialized");
    const fixture = await createCompanion({
      boxReady: true,
      workspaceRole: "editor",
      selectedSkillIds: [ids.orgSkill],
      selectedMcpAccountIds: [],
    });
    // The final rollout deliberately exercises the application pool at max=1. Use a distinct
    // writer connection for lock races so the authorization call tests PostgreSQL contention,
    // rather than waiting forever for the only client-side pool slot.
    const writer = postgres(runtimeUrl.toString(), { max: 1 });
    let transactionOpen = false;
    const authorizeWithLockTimeout = () => asRuntime(async (tx) => {
      await tx.unsafe("set local lock_timeout = '150ms'");
      return await tx`
        select * from public.companion_runtime_authorize_desktop(
          ${ids.orgA}::uuid, ${fixture.companionId}::uuid, ${ids.editorA}
        )
      `;
    });
    try {
      await writer`begin`;
      transactionOpen = true;
      await writer`
        select 1 from skills where id = ${ids.orgSkill}::uuid for update
      `;
      expect(await authorizeDesktop({
        companionId: fixture.companionId,
        actorId: ids.editorA,
      })).toEqual([{
        authorized: false,
        denialCode: "settings_not_applied",
        boxId: null,
        boxState: null,
        generation: null,
      }]);
      await writer`rollback`;
      transactionOpen = false;
      expect(await authorizeDesktop({
        companionId: fixture.companionId,
        actorId: ids.editorA,
      })).toMatchObject([{ authorized: true, denialCode: null }]);

      await writer`begin`;
      transactionOpen = true;
      // Match the Runtime/API hierarchy: instance before Companion. Authorization must wait and
      // then evaluate the committed pair, never mix either side of this restage boundary.
      await writer`
        update companion_runtime_instances
        set applied_skills_revision = 2
        where companion_id = ${fixture.companionId}::uuid
      `;
      await writer`
        update companions
        set selected_skill_ids = ${sql.json([ids.skill])}, skills_revision = 2
        where id = ${fixture.companionId}::uuid
      `;
      await expect(authorizeWithLockTimeout()).rejects.toMatchObject({ code: "55P03" });
      await writer`commit`;
      transactionOpen = false;
      expect(await authorizeDesktop({
        companionId: fixture.companionId,
        actorId: ids.editorA,
      })).toEqual([{
        authorized: false,
        denialCode: "resource_access_revoked",
        boxId: null,
        boxState: null,
        generation: null,
      }]);
    } finally {
      if (transactionOpen) await writer`rollback`;
      await writer.end({ timeout: 1 });
      await removeCompanion(fixture.companionId);
    }
  });
});
