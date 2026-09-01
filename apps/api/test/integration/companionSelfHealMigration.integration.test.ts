/**
 * Product promise:
 * Protocol 6 makes every interrupted occurrence terminal history. The migration releases old
 * queue locks, retires durable recovery operations, and prevents protocol-5 executors from
 * claiming work under the new rules.
 *
 * Why integrated:
 * This is a deployment-time backfill across transition triggers, partial indexes, lane claims,
 * SECURITY DEFINER grants, and the material-protocol fence. Unit fixtures cannot prove it.
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
const interruptedTurnId = randomUUID();
const interruptedMessageId = randomUUID();
const queuedChatMessageId = randomUUID();
const queuedRoutineMessageId = randomUUID();
let queuedChatTurnId = "";
let queuedRoutineTurnId = "";

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

async function asRole<T>(
  role: string,
  action: (tx: postgres.TransactionSql) => Promise<T>,
): Promise<T> {
  const result = await upgradeSql.begin(async (tx) => {
    await tx.unsafe(`set local role ${role}`);
    await tx`select set_config('app.org_id', ${orgId}, true)`;
    await tx`select set_config('app.user_id', ${actorId}, true)`;
    return { value: await action(tx) };
  });
  return result.value;
}

describe("0155 terminal interruption protocol-6 upgrade", () => {
  beforeAll(async () => {
    await adminSql.unsafe(`
      create role ${apiRole} login nosuperuser nobypassrls noinherit;
      create role ${workerRole} login nosuperuser nobypassrls noinherit;
      create role ${runtimeRole} login nosuperuser nobypassrls noinherit;
    `);
    await adminSql.unsafe(`create database "${databaseName}"`);
    upgradeSql = postgres(upgradeUrl.toString(), { max: 1 });

    const migrations = (await readdir(migrationsDir))
      .filter((name) => /^\d{4}_.+\.sql$/.test(name) && name < "0155_companion_interruption_terminal_protocol_6.sql")
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
      values (${orgId}::uuid, ${companionId}::uuid, 1, now())
    `;
    await upgradeSql`
      insert into companion_routines(
        id, org_id, companion_id, name, prompt, cron, timezone, enabled, next_fire_at, created_by
      ) values (
        ${routineId}::uuid, ${orgId}::uuid, ${companionId}::uuid,
        'Daily routine', 'Send an update.', '0 9 * * *', 'UTC', false, null, ${actorId}
      )
    `;
    await upgradeSql`
      insert into companion_transcript_entries(
        org_id, companion_id, event_id, ordinal, role, content, author_id, routine_name
      ) values (
        ${orgId}::uuid, ${companionId}::uuid, ${`msg:${interruptedMessageId}`}, 0,
        'user', 'Historical ambiguous occurrence', ${actorId}, null
      )
    `;
    await upgradeSql`
      insert into companion_turns(
        id, org_id, companion_id, client_message_id, message_event_id, queue_sequence,
        actor_id, client_surface, status, absolute_deadline_at, state_changed_at, settled_at,
        last_error_code, last_error_message, last_error_action,
        routine_id, routine_snapshot_id, routine_name
      ) values (
        ${interruptedTurnId}::uuid, ${orgId}::uuid, ${companionId}::uuid,
        ${interruptedMessageId}::uuid, ${`msg:${interruptedMessageId}`}, 1, ${actorId}, 'web',
        'interrupted', now() - interval '1 minute', now() - interval '2 minutes',
        now() - interval '2 minutes', 'pi_response_lost',
        'The provider response was lost after dispatch.', 'retry', null, null, null
      )
    `;

    const [chat] = await upgradeSql<Array<{ turn: { id: string } }>>`
      select turn from public.companion_api_enqueue_turn(
        ${orgId}::uuid, ${companionId}::uuid, ${queuedChatMessageId}::uuid,
        'Next chat message', 'web', '[]'::jsonb
      )
    `;
    const [routine] = await upgradeSql<Array<{ turn: { id: string } }>>`
      select turn from public.companion_api_enqueue_turn(
        ${orgId}::uuid, ${companionId}::uuid, ${queuedRoutineMessageId}::uuid,
        'Next routine occurrence', 'web', '[]'::jsonb,
        ${routineId}::uuid, 'Daily routine'
      )
    `;
    queuedChatTurnId = chat?.turn.id ?? "";
    queuedRoutineTurnId = routine?.turn.id ?? "";
    if (!queuedChatTurnId || !queuedRoutineTurnId) throw new Error("queued turn fixture failed");

    await applyMigrationFile("0155_companion_interruption_terminal_protocol_6.sql");
    await applySplitGrants();
    await upgradeSql`
      select * from public.companion_runtime_enable(
        (select gate_epoch from public.companion_runtime_gate_status()),
        'self-heal-migration-test'
      )
    `;
  }, 120_000);

  afterAll(async () => {
    await upgradeSql?.end({ timeout: 1 });
    await adminSql.unsafe(`drop database if exists "${databaseName}" with (force)`);
    await adminSql.unsafe(`drop role if exists ${runtimeRole}, ${workerRole}, ${apiRole}`);
    await adminSql.end({ timeout: 1 });
  });

  it("backfills terminal history and cancels every durable recovery", async () => {
    const [state] = await upgradeSql<Array<{
      status: string;
      resolution: string;
      errorCode: string;
      errorMessage: string;
      errorAction: string;
      recoveryTotal: number;
      liveRecoveryTotal: number;
      transcriptCount: number;
      boxState: string;
      piState: string;
    }>>`
      select turn_row.status::text as status, turn_row.resolution,
        turn_row.last_error_code as "errorCode", turn_row.last_error_message as "errorMessage",
        turn_row.last_error_action::text as "errorAction",
        (select count(*)::int from companion_operations operation
          where operation.companion_id = turn_row.companion_id
            and operation.kind = 'restart_pi' and operation.trigger = 'recovery') as "recoveryTotal",
        (select count(*)::int from companion_operations operation
          where operation.companion_id = turn_row.companion_id
            and operation.kind = 'restart_pi' and operation.trigger = 'recovery'
            and operation.status in ('pending', 'running')) as "liveRecoveryTotal",
        (select count(*)::int from companion_transcript_entries entry
          where entry.companion_id = turn_row.companion_id) as "transcriptCount",
        (select instance.box_state::text from companion_runtime_instances instance
          where instance.companion_id = turn_row.companion_id) as "boxState",
        (select instance.pi_state::text from companion_runtime_instances instance
          where instance.companion_id = turn_row.companion_id) as "piState"
      from companion_turns turn_row where turn_row.id = ${interruptedTurnId}::uuid
    `;
    expect(state).toEqual({
      status: "interrupted",
      resolution: "auto_abandoned",
      errorCode: "pi_response_lost",
      errorMessage: "The provider response was lost after dispatch.",
      errorAction: "none",
      recoveryTotal: 1,
      liveRecoveryTotal: 0,
      transcriptCount: 3,
      boxState: "unknown",
      piState: "unknown",
    });
  });

  it("keeps terminal interruption history in thread window and delta projections", async () => {
    const [window] = await asRole(apiRole, (tx) => tx<Array<{
      interruptedTurn: { id: string; status: string; resolution: string } | null;
    }>>`
      select interrupted_turn as "interruptedTurn"
      from public.companion_api_read_thread_window(
        ${orgId}::uuid, ${companionId}::uuid, null, 50, false
      )
    `);
    const [delta] = await asRole(apiRole, (tx) => tx<Array<{
      interruptedTurn: { id: string; status: string; resolution: string } | null;
    }>>`
      select interrupted_turn as "interruptedTurn"
      from public.companion_api_read_thread_changes(
        ${orgId}::uuid, ${companionId}::uuid, 0, 200
      )
    `);

    expect(window?.interruptedTurn).toMatchObject({
      id: interruptedTurnId,
      status: "interrupted",
      resolution: "auto_abandoned",
    });
    expect(delta?.interruptedTurn).toMatchObject({
      id: interruptedTurnId,
      status: "interrupted",
      resolution: "auto_abandoned",
    });
  });

  it("refuses protocol 5 and lets protocol 6 claim the next FIFO turn", async () => {
    const oldClaims = await asRole(runtimeRole, (tx) => tx<Array<{ workId: string }>>`
      select work_id::text as "workId"
      from public.companion_runtime_claim_work('old-runtime', 4, 30, (
        select gate_epoch from public.companion_runtime_gate_status()
      ), 5, 1)
    `);
    expect(oldClaims).toEqual([]);

    const claims = await asRole(runtimeRole, (tx) => tx<Array<{ workId: string; workKind: string }>>`
      select work_id::text as "workId", work_kind::text as "workKind"
      from public.companion_runtime_claim_work('protocol-6-runtime', 4, 30, (
        select gate_epoch from public.companion_runtime_gate_status()
      ), 6, 1) claim
    `);
    expect(claims).not.toEqual([]);
    const claimedTurns = await upgradeSql<Array<{ turnId: string }>>`
      select coalesce(attempt.turn_id, operation.source_turn_id)::text as "turnId"
      from unnest(${claims.map((claim) => claim.workId)}::uuid[]) claimed(id)
      left join companion_turn_attempts attempt on attempt.id = claimed.id
      left join companion_operations operation on operation.id = claimed.id
    `;
    expect(claimedTurns.map((claim) => claim.turnId)).toContain(queuedChatTurnId);
    const [routine] = await upgradeSql<Array<{ status: string }>>`
      select status::text as status from companion_turns where id = ${queuedRoutineTurnId}::uuid
    `;
    expect(routine?.status).toBe("queued");
  });

  it("removes Retry and rejects Cancel for an interruption without mutation", async () => {
    const [surface] = await upgradeSql<Array<{ retry: string | null; recoveryMetrics: string | null }>>`
      select
        to_regprocedure('public.companion_api_retry_turn(uuid,uuid,uuid,uuid,public.companion_client_surface)')::text as retry,
        to_regprocedure('public.companion_runtime_recovery_metrics()')::text as "recoveryMetrics"
    `;
    expect(surface).toEqual({ retry: null, recoveryMetrics: null });

    await expect(
      asRole(apiRole, (tx) => tx`
        select public.companion_api_cancel_turn(
          ${orgId}::uuid, ${companionId}::uuid, ${interruptedTurnId}::uuid
        )
      `),
    ).rejects.toMatchObject({ code: "55000" });

    const [turn] = await upgradeSql<Array<{ status: string; resolution: string }>>`
      select status::text as status, resolution from companion_turns
      where id = ${interruptedTurnId}::uuid
    `;
    expect(turn).toEqual({ status: "interrupted", resolution: "auto_abandoned" });
  });
});
