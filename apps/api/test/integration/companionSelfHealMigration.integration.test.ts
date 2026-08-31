/**
 * Product promise:
 * Protocol 5 turns the production-shaped interrupted-routine lock into one internal, idempotent
 * cleanup without replaying the ambiguous prompt or disturbing a concurrently starting chat turn.
 *
 * Why integrated:
 * The guarantee is a deployment-time backfill across enum values, transition triggers, queue
 * allocators, partial uniqueness, and SECURITY DEFININER projections. A fixture created after the
 * migration cannot prove that an already-pending user retry is safely adopted in place.
 */
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { extractRuntimeRoleGrantBlock, resolveRuntimeRoleGrantsFile } from "../../src/migrate";

const databaseUrl = process.env.DATABASE_MIGRATION_URL ?? process.env.DATABASE_URL;
if (!databaseUrl?.trim()) {
  throw new Error("Companion self-heal migration test requires an explicit disposable DATABASE_URL");
}

const migrationsDir = fileURLToPath(new URL("../../../../packages/db/drizzle/", import.meta.url));
const suffix = randomUUID().replaceAll("-", "").slice(0, 16);
const databaseName = `self_heal_${suffix}`;
const apiRole = `self_heal_api_${suffix}`;
const workerRole = `self_heal_worker_${suffix}`;
const runtimeRole = `self_heal_runtime_${suffix}`;
const adminSql = postgres(databaseUrl, { max: 1 });
const upgradeUrl = new URL(databaseUrl);
upgradeUrl.pathname = `/${databaseName}`;
upgradeUrl.search = "";
let upgradeSql: ReturnType<typeof postgres>;

const actorId = `self-heal-owner-${suffix}`;
const orgId = randomUUID();
const companionId = randomUUID();
const routineId = randomUUID();
const routineTurnId = randomUUID();
const routineMessageId = randomUUID();
const chatTurnId = randomUUID();
const chatMessageId = randomUUID();
const retryId = randomUUID();

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
  const grants = extractRuntimeRoleGrantBlock(
    await readFile(await resolveRuntimeRoleGrantsFile(), "utf8"),
  );
  const connection = await upgradeSql.reserve();
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

describe("0150 Companion self-heal upgrade", () => {
  beforeAll(async () => {
    await adminSql.unsafe(`
      create role ${apiRole} login nosuperuser nobypassrls noinherit;
      create role ${workerRole} login nosuperuser nobypassrls noinherit;
      create role ${runtimeRole} login nosuperuser nobypassrls noinherit;
    `);
    await adminSql.unsafe(`create database "${databaseName}"`);
    upgradeSql = postgres(upgradeUrl.toString(), { max: 1 });

    const migrations = (await readdir(migrationsDir))
      .filter((name) => /^\d{4}_.+\.sql$/.test(name) && name < "0151_companion_runtime_self_heal_protocol_5.sql")
      .sort();
    const cutoverIndex = migrations.findIndex((name) => name.startsWith("0094_"));
    if (cutoverIndex < 0) throw new Error("Runtime v2 cutover migration is missing");
    for (const migration of migrations.slice(0, cutoverIndex)) await applyMigrationFile(migration);
    await applySplitGrants();
    for (const migration of migrations.slice(cutoverIndex)) await applyMigrationFile(migration);
    await applySplitGrants();

    await upgradeSql`
      select set_config('app.org_id', ${orgId}, false),
        set_config('app.user_id', ${actorId}, false),
        set_config('app.companion_runtime_protocol', '2', false)
    `;
    await upgradeSql`
      insert into "user" (id, name, email, email_verified)
      values (${actorId}, 'Self Heal Owner', ${`${actorId}@example.test`}, true)
    `;
    await upgradeSql`
      insert into organizations (id, name, slug, kind)
      values (${orgId}::uuid, 'Self Heal Upgrade', ${`self-heal-${suffix}`}, 'team')
    `;
    await upgradeSql`
      insert into memberships (org_id, user_id, org_role)
      values (${orgId}::uuid, ${actorId}, 'owner')
    `;
    await upgradeSql`
      insert into companions (id, org_id, owner_id, name, model_id)
      values (${companionId}::uuid, ${orgId}::uuid, ${actorId}, 'Long-running Companion', 'fixture-model')
    `;
    await upgradeSql`
      insert into companion_runtime_instances(
        org_id, companion_id, box_id, box_state, pi_state, pi_invocation_id,
        disk_layout_version, applied_settings_revision, applied_skills_revision,
        applied_client_surface, health_due_at
      ) values (
        ${orgId}::uuid, ${companionId}::uuid, 'bx_23456789', 'ready', 'idle',
        'pi-self-heal', 14, 1, 1, 'web', now() + interval '1 day'
      )
    `;
    await upgradeSql`
      insert into companion_threads(org_id, companion_id, next_ordinal, last_message_at)
      values (${orgId}::uuid, ${companionId}::uuid, 2, now())
    `;
    await upgradeSql`
      insert into companion_transcript_entries(
        org_id, companion_id, event_id, ordinal, role, content, author_id, routine_name
      ) values
        (
          ${orgId}::uuid, ${companionId}::uuid, ${`msg:${routineMessageId}`}, 0,
          'user', 'Historical routine occurrence', ${actorId}, 'Daily long-thread routine'
        ),
        (
          ${orgId}::uuid, ${companionId}::uuid, ${`msg:${chatMessageId}`}, 1,
          'user', 'Message accepted while cleanup is waiting', ${actorId}, null
        )
    `;
    await upgradeSql`
      insert into companion_routines(
        id, org_id, companion_id, name, prompt, cron, timezone, enabled, next_fire_at, created_by
      ) values (
        ${routineId}::uuid, ${orgId}::uuid, ${companionId}::uuid,
        'Daily long-thread routine', 'Send an update.', '0 9 * * *', 'UTC', false, null, ${actorId}
      )
    `;
    await upgradeSql`
      insert into companion_turns(
        id, org_id, companion_id, client_message_id, message_event_id, queue_sequence,
        actor_id, client_surface, status, routine_id, routine_snapshot_id, routine_name,
        absolute_deadline_at, state_changed_at, settled_at,
        last_error_code, last_error_message, last_error_action
      ) values (
        ${routineTurnId}::uuid, ${orgId}::uuid, ${companionId}::uuid,
        ${routineMessageId}::uuid, ${`msg:${routineMessageId}`}, 1, ${actorId}, 'web',
        'interrupted', ${routineId}::uuid, ${routineId}::uuid, 'Daily long-thread routine',
        now() - interval '1 minute', now() - interval '2 minutes', now() - interval '2 minutes',
        'pi_response_lost', 'The provider response was lost after dispatch.', 'retry'
      ), (
        ${chatTurnId}::uuid, ${orgId}::uuid, ${companionId}::uuid,
        ${chatMessageId}::uuid, ${`msg:${chatMessageId}`}, 2, ${actorId}, 'web', 'starting',
        null, null, null, now() + interval '2 hours', now(), null, null, null, null
      )
    `;
    await upgradeSql`
      select * from public.companion_api_retry_turn(
        ${orgId}::uuid, ${companionId}::uuid, ${routineTurnId}::uuid,
        ${retryId}::uuid, 'web'
      )
    `;

    await applyMigrationFile("0151_companion_runtime_self_heal_protocol_5.sql");
  }, 120_000);

  afterAll(async () => {
    await upgradeSql?.end({ timeout: 1 });
    await adminSql.unsafe(`drop database if exists "${databaseName}" with (force)`);
    await adminSql.unsafe(`drop role if exists ${runtimeRole}, ${workerRole}, ${apiRole}`);
    await adminSql.end({ timeout: 1 });
  });

  it("adopts the pending restart as one routine-lane recovery without replaying either prompt", async () => {
    const [state] = await upgradeSql<Array<{
      operationCount: number;
      operationKind: string;
      operationTrigger: string;
      operationStatus: string;
      requestId: string | null;
      sourceTurnId: string;
      lane: string;
      routineStatus: string;
      routineResolution: string | null;
      routineErrorCode: string;
      chatStatus: string;
      transcriptCount: number;
    }>>`
      select
        count(*) filter (
          where operation.kind = 'restart_pi' and operation.trigger = 'recovery'
        ) over ()::int as "operationCount",
        operation.kind::text as "operationKind",
        operation.trigger::text as "operationTrigger",
        operation.status::text as "operationStatus",
        operation.request_id::text as "requestId",
        operation.source_turn_id::text as "sourceTurnId",
        public.companion_runtime_operation_lane(
          operation.org_id, operation.companion_id, operation.id
        ) as lane,
        routine_turn.status::text as "routineStatus",
        routine_turn.resolution as "routineResolution",
        routine_turn.last_error_code as "routineErrorCode",
        chat_turn.status::text as "chatStatus",
        (select count(*)::int from companion_transcript_entries entry
          where entry.companion_id = operation.companion_id) as "transcriptCount"
      from companion_operations operation
      join companion_turns routine_turn on routine_turn.id = operation.source_turn_id
      join companion_turns chat_turn on chat_turn.id = ${chatTurnId}::uuid
      where operation.companion_id = ${companionId}::uuid
        and operation.kind = 'restart_pi'
        and operation.status in ('pending', 'running')
    `;
    expect(state).toEqual({
      operationCount: 1,
      operationKind: "restart_pi",
      operationTrigger: "recovery",
      operationStatus: "pending",
      requestId: null,
      sourceTurnId: routineTurnId,
      lane: "routine",
      routineStatus: "interrupted",
      routineResolution: null,
      routineErrorCode: "pi_response_lost",
      chatStatus: "starting",
      transcriptCount: 2,
    });

    // Re-firing the migration's backfill trigger shape is idempotent: it cannot create a second
    // cleanup and therefore cannot turn the historical prompt into another execution occurrence.
    await upgradeSql`
      update companion_turns set status = status
      where id = ${routineTurnId}::uuid
    `;
    const [count] = await upgradeSql<Array<{ value: number }>>`
      select count(*)::int as value from companion_operations
      where companion_id = ${companionId}::uuid
        and kind = 'restart_pi' and trigger = 'recovery'
    `;
    expect(count?.value).toBe(1);
  });
});
