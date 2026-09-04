/**
 * Product promise: the credential-reload upgrade repairs idle MCP-enabled Companions on their next
 * ordinary Turn without invalidating an already-admitted occurrence.
 *
 * Why integrated: the repair is a one-time data migration over the fully constrained Runtime v3
 * aggregate. A unit fake cannot prove which production rows are expired or preserved.
 */
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const databaseUrl = process.env.DATABASE_MIGRATION_URL ?? process.env.DATABASE_URL;
if (!databaseUrl?.trim()) {
  throw new Error("Runtime v3 credential reload migration test requires a disposable PostgreSQL URL");
}

const migrationsDir = fileURLToPath(new URL("../../../../packages/db/drizzle/", import.meta.url));
const grantsFile = fileURLToPath(
  new URL("../../../../packages/db/runtime-role-grants.sql", import.meta.url),
);
const suffix = randomUUID().replaceAll("-", "").slice(0, 16);
const databaseName = `v3_credential_reload_${suffix}`;
const apiRole = `v3_reload_api_${suffix}`;
const workerRole = `v3_reload_worker_${suffix}`;
const runtimeRole = `v3_reload_runtime_${suffix}`;
const actorId = `v3-reload-owner-${suffix}`;
const orgId = randomUUID();
const idleCompanionId = randomUUID();
const activeCompanionId = randomUUID();
const failedActivationCompanionId = randomUUID();
const terminalAckCompanionId = randomUUID();
const ambiguousAdmissionCompanionId = randomUUID();
const idleTokenId = randomUUID();
const activeTokenId = randomUUID();
const terminalAckTokenId = randomUUID();
const ambiguousAdmissionTokenId = randomUUID();
const idleAccountRef = [{ account_id: randomUUID(), credential_generation: randomUUID() }];
const activeAccountRef = [{ account_id: randomUUID(), credential_generation: randomUUID() }];
const activeTurnId = randomUUID();
const activeClientMessageId = randomUUID();
const terminalAckTurnId = randomUUID();
const terminalAckClientMessageId = randomUUID();
const ambiguousAdmissionTurnId = randomUUID();
const ambiguousAdmissionClientMessageId = randomUUID();
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

describe("0185 staged credential reload migration", () => {
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
    const reloadIndex = migrations.findIndex((name) => name.startsWith("0185_"));
    if (cutoverIndex < 0 || reloadIndex < 0) throw new Error("credential reload migration is missing");
    for (const migration of migrations.slice(0, cutoverIndex)) await applyMigrationFile(migration);
    await applySplitGrants();
    for (const migration of migrations.slice(cutoverIndex, reloadIndex)) {
      await applyMigrationFile(migration);
    }
    await applySplitGrants();

    await upgradeSql`
      insert into public."user" (id, name, email, email_verified)
      values (${actorId}, 'Credential Reload Owner', ${`${actorId}@example.test`}, true)
    `;
    await upgradeSql`
      insert into public.organizations (id, name, slug, kind)
      values (${orgId}::uuid, 'Credential Reload', ${`credential-reload-${suffix}`}, 'team')
    `;
    await upgradeSql`
      insert into public.memberships (org_id, user_id, org_role)
      values (${orgId}::uuid, ${actorId}, 'owner')
    `;
    await upgradeSql`
      insert into public.companions (id, org_id, owner_id, name, model_id)
      values
        (${idleCompanionId}::uuid, ${orgId}::uuid, ${actorId}, 'Idle MCP', 'fixture-model'),
        (${activeCompanionId}::uuid, ${orgId}::uuid, ${actorId}, 'Active MCP', 'fixture-model'),
        (${failedActivationCompanionId}::uuid, ${orgId}::uuid, ${actorId},
          'Failed activation', 'fixture-model'),
        (${terminalAckCompanionId}::uuid, ${orgId}::uuid, ${actorId},
          'Terminal ACK', 'fixture-model'),
        (${ambiguousAdmissionCompanionId}::uuid, ${orgId}::uuid, ${actorId},
          'Ambiguous admission', 'fixture-model')
    `;
    await upgradeSql`
      insert into public.companion_v3_instances (
        org_id, companion_id, desired_lifecycle_actor_id
      ) values
        (${orgId}::uuid, ${idleCompanionId}::uuid, ${actorId}),
        (${orgId}::uuid, ${activeCompanionId}::uuid, ${actorId}),
        (${orgId}::uuid, ${failedActivationCompanionId}::uuid, ${actorId}),
        (${orgId}::uuid, ${terminalAckCompanionId}::uuid, ${actorId}),
        (${orgId}::uuid, ${ambiguousAdmissionCompanionId}::uuid, ${actorId})
    `;
    await upgradeSql`
      insert into public.companion_mcp_broker_tokens (
        id, org_id, companion_id, actor_id, token_prefix, token_hash, account_refs, expires_at
      ) values
        (${idleTokenId}::uuid, ${orgId}::uuid, ${idleCompanionId}::uuid, ${actorId},
          'cmp_mcp_idle__', ${"a".repeat(64)}, ${upgradeSql.json(idleAccountRef)},
          now() + interval '6 hours'),
        (${activeTokenId}::uuid, ${orgId}::uuid, ${activeCompanionId}::uuid, ${actorId},
          'cmp_mcp_active', ${"b".repeat(64)}, ${upgradeSql.json(activeAccountRef)},
          now() + interval '6 hours'),
        (${terminalAckTokenId}::uuid, ${orgId}::uuid, ${terminalAckCompanionId}::uuid, ${actorId},
          'cmp_mcp_ack___', ${"f".repeat(64)}, ${upgradeSql.json(idleAccountRef)},
          now() + interval '6 hours'),
        (${ambiguousAdmissionTokenId}::uuid, ${orgId}::uuid,
          ${ambiguousAdmissionCompanionId}::uuid, ${actorId}, 'cmp_mcp_ambig_',
          ${"1".repeat(64)}, ${upgradeSql.json(activeAccountRef)}, now() + interval '6 hours')
    `;
    await upgradeSql`
      update public.companion_v3_instances instance set
        preparation_checkpoint = 'prepared', box_id = case companion_id
          when ${idleCompanionId}::uuid then 'bx_23456789'
          when ${activeCompanionId}::uuid then 'bx_abcdefgh'
          when ${failedActivationCompanionId}::uuid then 'bx_2345678a'
          when ${terminalAckCompanionId}::uuid then 'bx_2345678c'
          else 'bx_2345678d' end,
        box_ready_at = now() - interval '3 minutes',
        staging_completed_at = now() - interval '2 minutes',
        pi_invocation_id = 'prepared-invocation', prepared_at = now() - interval '1 minute',
        preparation_actor_id = ${actorId}, preparation_settings_revision = 1,
        preparation_skills_revision = 1, preparation_model_id = 'fixture-model',
        preparation_provider_refs = '[]'::jsonb, preparation_skill_refs = '[]'::jsonb,
        preparation_mcp_refs = '[]'::jsonb, prepared_disk_layout_version = 14,
        prepared_skills_digest = ${"c".repeat(64)},
        prepared_material_expires_at = now() + interval '4 hours',
        mcp_broker_token_id = case companion_id
          when ${idleCompanionId}::uuid then ${idleTokenId}::uuid
          when ${activeCompanionId}::uuid then ${activeTokenId}::uuid
          when ${terminalAckCompanionId}::uuid then ${terminalAckTokenId}::uuid
          when ${ambiguousAdmissionCompanionId}::uuid then ${ambiguousAdmissionTokenId}::uuid
          else ${activeTokenId}::uuid end
      where instance.org_id = ${orgId}::uuid
    `;
    await upgradeSql`
      insert into public.companion_v3_turns (
        id, org_id, companion_id, command_id, client_message_id, message_event_id,
        actor_id, lane, queue_sequence, state, admission_state, admission_started_at,
        admitted_at, pi_invocation_id, response_turn_id, admission_cursor,
        inactivity_deadline_at, absolute_deadline_at
      ) values (
        ${activeTurnId}::uuid, ${orgId}::uuid, ${activeCompanionId}::uuid,
        ${randomUUID()}::uuid, ${activeClientMessageId}::uuid,
        ${`msg:${activeClientMessageId}`}, ${actorId}, 'main', 1, 'admitted', 'accepted',
        now(), now(), 'active-invocation', ${activeTurnId}::uuid, 0,
        now() + interval '10 minutes', now() + interval '2 hours'
      )
    `;
    await upgradeSql`
      insert into public.companion_v3_turns (
        id, org_id, companion_id, command_id, client_message_id, message_event_id,
        actor_id, lane, queue_sequence, state, admission_state, admission_started_at,
        admitted_at, pi_invocation_id, response_turn_id, terminal_cursor,
        journal_ack_pending, admission_cursor, outcome, settled_at
      ) values (
        ${terminalAckTurnId}::uuid, ${orgId}::uuid, ${terminalAckCompanionId}::uuid,
        ${randomUUID()}::uuid, ${terminalAckClientMessageId}::uuid,
        ${`msg:${terminalAckClientMessageId}`}, ${actorId}, 'main', 1, 'succeeded',
        'accepted', now(), now(), 'prepared-invocation', ${terminalAckTurnId}::uuid,
        12, true, 0, 'succeeded', now()
      )
    `;
    await upgradeSql`
      insert into public.companion_v3_turns (
        id, org_id, companion_id, command_id, client_message_id, message_event_id,
        actor_id, lane, queue_sequence, state, admission_state
      ) values (
        ${ambiguousAdmissionTurnId}::uuid, ${orgId}::uuid,
        ${ambiguousAdmissionCompanionId}::uuid, ${randomUUID()}::uuid,
        ${ambiguousAdmissionClientMessageId}::uuid, ${`msg:${ambiguousAdmissionClientMessageId}`},
        ${actorId}, 'main', 1, 'queued', 'pending'
      )
    `;
    await upgradeSql`
      insert into public.companion_v3_lane_leases (
        org_id, companion_id, lane, claim_token, claim_epoch, gate_epoch,
        executor_id, turn_id, claimed_at, renewed_at, expires_at
      ) values (
        ${orgId}::uuid, ${ambiguousAdmissionCompanionId}::uuid, 'main',
        ${randomUUID()}::uuid, 1, 1, 'runtime-test', ${ambiguousAdmissionTurnId}::uuid,
        now(), now(), now() + interval '5 minutes'
      )
    `;
    await upgradeSql`
      update public.companion_v3_instances set
        preparation_checkpoint = 'staged', box_id = 'bx_2345678a',
        box_ready_at = now() - interval '3 minutes',
        staging_completed_at = now() - interval '2 minutes',
        pi_invocation_id = null, prepared_at = null,
        preparation_actor_id = ${actorId}, preparation_settings_revision = 1,
        preparation_skills_revision = 1, preparation_model_id = 'fixture-model',
        preparation_provider_refs = '[]'::jsonb, preparation_skill_refs = '[]'::jsonb,
        preparation_mcp_refs = '[]'::jsonb, prepared_disk_layout_version = 14,
        prepared_skills_digest = ${"d".repeat(64)},
        prepared_material_expires_at = now() + interval '4 hours',
        preparation_error_code = 'box_unavailable',
        preparation_error_message = 'Companion Box is temporarily unavailable.'
      where org_id = ${orgId}::uuid and companion_id = ${failedActivationCompanionId}::uuid
    `;

    await applyMigrationFile(migrations[reloadIndex]!);
  }, 120_000);

  afterAll(async () => {
    if (upgradeSql) await upgradeSql.end({ timeout: 1 });
    await adminSql.unsafe(`drop database if exists "${databaseName}" with (force)`);
    await adminSql.unsafe(`drop role if exists ${apiRole}, ${workerRole}, ${runtimeRole}`);
    await adminSql.end({ timeout: 1 });
  }, 30_000);

  it("expires the idle preparation and preserves the admitted Companion", async () => {
    const rows = await upgradeSql<Array<{
      companionId: string;
      expired: boolean;
    }>>`
      select companion_id as "companionId",
        prepared_material_expires_at <= now() as expired
      from public.companion_v3_instances
      where org_id = ${orgId}::uuid
        and companion_id in (${idleCompanionId}::uuid, ${activeCompanionId}::uuid,
          ${terminalAckCompanionId}::uuid, ${ambiguousAdmissionCompanionId}::uuid)
      order by companion_id
    `;
    expect(new Map(rows.map((row) => [row.companionId, row.expired]))).toEqual(new Map([
      [idleCompanionId, true],
      [activeCompanionId, false],
      [terminalAckCompanionId, false],
      [ambiguousAdmissionCompanionId, false],
    ]));
  });

  it("restages a preparation whose consumed credentials cannot activate Pi", async () => {
    const rows = await upgradeSql<Array<{
      checkpoint: string;
      stagingCompletedAt: Date | null;
      preparedMaterialExpiresAt: Date | null;
      errorCode: string | null;
    }>>`
      select preparation_checkpoint as checkpoint,
        staging_completed_at as "stagingCompletedAt",
        prepared_material_expires_at as "preparedMaterialExpiresAt",
        preparation_error_code as "errorCode"
      from public.companion_v3_instances
      where org_id = ${orgId}::uuid and companion_id = ${failedActivationCompanionId}::uuid
    `;
    expect(rows).toEqual([{
      checkpoint: "box_ready",
      stagingCompletedAt: null,
      preparedMaterialExpiresAt: null,
      errorCode: "box_unavailable",
    }]);
  });

  it("restages future activation deferrals after transient material was consumed", async () => {
    const claimToken = randomUUID();
    await upgradeSql`
      update public.companion_runtime_control set enabled = true,
        enabled_at = coalesce(enabled_at, clock_timestamp()), disabled_at = null
      where id = 'runtime-v3'
    `;
    const gateRows = await upgradeSql<Array<{ gateEpoch: string }>>`
      select gate_epoch::text as "gateEpoch"
      from public.companion_runtime_control where id = 'runtime-v3'
    `;
    const gateEpoch = gateRows[0]?.gateEpoch;
    if (!gateEpoch) throw new Error("runtime gate fixture is missing");
    await upgradeSql`
      update public.companion_v3_instances set
        preparation_checkpoint = 'staged', staging_completed_at = now(),
        preparation_actor_id = ${actorId}, preparation_settings_revision = 1,
        preparation_skills_revision = 1, preparation_model_id = 'fixture-model',
        preparation_provider_refs = '[]'::jsonb, preparation_skill_refs = '[]'::jsonb,
        preparation_mcp_refs = '[]'::jsonb, prepared_disk_layout_version = 14,
        prepared_skills_digest = ${"e".repeat(64)},
        prepared_material_expires_at = now() + interval '4 hours',
        preparation_error_code = null, preparation_error_message = null,
        preparation_claim_token = ${claimToken}::uuid, preparation_claim_epoch = 1,
        preparation_gate_epoch = ${gateEpoch}::bigint, preparation_executor_id = 'runtime-test',
        preparation_claimed_at = now(), preparation_expires_at = now() + interval '5 minutes'
      where org_id = ${orgId}::uuid and companion_id = ${failedActivationCompanionId}::uuid
    `;
    const result = await upgradeSql<Array<{ deferred: boolean }>>`
      select public.companion_v3_runtime_defer_preparation(
        ${orgId}::uuid, ${failedActivationCompanionId}::uuid, ${claimToken}::uuid,
        1::bigint, ${gateEpoch}::bigint, 5, 'box_unavailable',
        'Companion Box is temporarily unavailable.', 4
      ) as deferred
    `;
    expect(result).toEqual([{ deferred: true }]);
    const [instance] = await upgradeSql<Array<{
      checkpoint: string;
      stagingCompletedAt: Date | null;
      preparedMaterialExpiresAt: Date | null;
    }>>`
      select preparation_checkpoint as checkpoint,
        staging_completed_at as "stagingCompletedAt",
        prepared_material_expires_at as "preparedMaterialExpiresAt"
      from public.companion_v3_instances
      where org_id = ${orgId}::uuid and companion_id = ${failedActivationCompanionId}::uuid
    `;
    expect(instance).toEqual({
      checkpoint: "box_ready",
      stagingCompletedAt: null,
      preparedMaterialExpiresAt: null,
    });
  });

  it("restages deadline-clipped external activation failures", async () => {
    const claimToken = randomUUID();
    const turnId = randomUUID();
    const clientMessageId = randomUUID();
    const gateRows = await upgradeSql<Array<{ gateEpoch: string }>>`
      select gate_epoch::text as "gateEpoch"
      from public.companion_runtime_control where id = 'runtime-v3'
    `;
    const gateEpoch = gateRows[0]?.gateEpoch;
    if (!gateEpoch) throw new Error("runtime gate fixture is missing");
    await upgradeSql`
      update public.companion_v3_instances set
        preparation_checkpoint = 'staged', staging_completed_at = now(),
        preparation_actor_id = ${actorId}, preparation_settings_revision = 1,
        preparation_skills_revision = 1, preparation_model_id = 'fixture-model',
        preparation_provider_refs = '[]'::jsonb, preparation_skill_refs = '[]'::jsonb,
        preparation_mcp_refs = '[]'::jsonb, prepared_disk_layout_version = 14,
        prepared_skills_digest = ${"2".repeat(64)},
        prepared_material_expires_at = now() + interval '4 hours',
        preparation_error_code = null, preparation_error_message = null,
        preparation_claim_token = ${claimToken}::uuid, preparation_claim_epoch = 2,
        preparation_gate_epoch = ${gateEpoch}::bigint, preparation_executor_id = 'runtime-test',
        preparation_claimed_at = now(), preparation_expires_at = now() + interval '5 minutes'
      where org_id = ${orgId}::uuid and companion_id = ${failedActivationCompanionId}::uuid
    `;
    await upgradeSql`
      insert into public.companion_v3_turns (
        id, org_id, companion_id, command_id, client_message_id, message_event_id,
        actor_id, lane, queue_sequence
      ) values (
        ${turnId}::uuid, ${orgId}::uuid, ${failedActivationCompanionId}::uuid,
        ${randomUUID()}::uuid, ${clientMessageId}::uuid, ${`msg:${clientMessageId}`},
        ${actorId}, 'main', 1
      )
    `;
    await upgradeSql`
      insert into public.companion_threads (org_id, companion_id)
      values (${orgId}::uuid, ${failedActivationCompanionId}::uuid)
      on conflict (companion_id) do nothing
    `;
    const result = await upgradeSql<Array<{ source: string }>>`
      select source::text from public.companion_v3_runtime_defer_preparation_external_v9(
        ${orgId}::uuid, ${failedActivationCompanionId}::uuid, ${turnId}::uuid,
        ${claimToken}::uuid, 2::bigint, ${gateEpoch}::bigint, 'model',
        ${"3".repeat(64)}, 'model_unusable', 'The selected model is unavailable.', 0, 9
      )
    `;
    expect(result).toEqual([{ source: "main" }]);
    const [facts] = await upgradeSql<Array<{ checkpoint: string; state: string }>>`
      select instance.preparation_checkpoint as checkpoint, turn_row.state::text
      from public.companion_v3_instances instance
      join public.companion_v3_turns turn_row on turn_row.org_id=instance.org_id
        and turn_row.companion_id=instance.companion_id
      where instance.org_id = ${orgId}::uuid
        and instance.companion_id = ${failedActivationCompanionId}::uuid
        and turn_row.id = ${turnId}::uuid
    `;
    expect(facts).toEqual({ checkpoint: "box_ready", state: "failed" });
  });
});
