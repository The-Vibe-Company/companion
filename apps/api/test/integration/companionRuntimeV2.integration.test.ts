/**
 * Product promise:
 * Runtime v2 is a tenant-safe, serial, leased work engine. Only its isolated executor role can
 * claim work, and every external effect must cross the current token + claim epoch + gate epoch
 * fence before a checkpoint or settlement becomes durable.
 *
 * Regression caught:
 * A deploy over an unpurged v1 fleet, an inherited table/function grant, a stale executor after
 * takeover, or a revoked actor/resource snapshot could otherwise run work for the wrong tenant or
 * commit a provider result after authority moved elsewhere.
 *
 * Why integrated:
 * These guarantees depend on PostgreSQL migration guards, FORCE RLS, partial unique indexes,
 * SECURITY DEFINER functions, SKIP LOCKED, and two real connections racing for leases. Mocks cannot
 * establish any of those properties.
 *
 * Failure proof:
 * The suite replays the real migrations into disposable databases, applies the production grants,
 * and checks durable rows after every refusal, takeover, checkpoint, settlement, and gate change.
 */
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { extractRuntimeRoleGrantBlock, resolveRuntimeRoleGrantsFile } from "../../src/migrate";

const databaseUrl = process.env.DATABASE_MIGRATION_URL ?? process.env.DATABASE_URL;
if (!databaseUrl?.trim()) {
  throw new Error("Companion Runtime v2 integration test requires an explicit disposable DATABASE_URL");
}

const migrationsDir = fileURLToPath(new URL("../../../../packages/db/drizzle/", import.meta.url));
const suffix = randomUUID().replaceAll("-", "").slice(0, 16);
const runtimeDatabaseName = `runtime_v2_${suffix}`;
const guardDatabaseName = `runtime_v2_guard_${suffix}`;
const apiRole = `runtime_v2_api_${suffix}`;
const workerRole = `runtime_v2_worker_${suffix}`;
const executorRole = `runtime_v2_exec_${suffix}`;
const unexpectedFunctionRole = `runtime_v2_unexpected_${suffix}`;
const apiParentRole = `runtime_v2_api_parent_${suffix}`;
const workerParentRole = `runtime_v2_worker_parent_${suffix}`;

const runtimeTables = [
  "companion_runtime_control",
  "companion_runtime_instances",
  "companion_turns",
  "companion_turn_attempts",
  "companion_operations",
  "companion_decision_deliveries",
  "companion_runtime_leases",
  "companion_runtime_duplicate_cleanups",
  "companion_runtime_event_projections",
  "companion_runtime_desktop_requests",
] as const;

const runtimeFunctionSignatures = [
  "public.companion_runtime_gate_status()",
  "public.companion_runtime_disable(bigint,text)",
  "public.companion_runtime_claim_work(text,integer,integer,bigint)",
  "public.companion_runtime_renew_and_authorize(uuid,uuid,uuid,bigint,bigint,text,public.companion_runtime_work_kind,uuid,integer)",
  "public.companion_runtime_checkpoint(uuid,uuid,uuid,bigint,bigint,text,public.companion_runtime_work_kind,uuid,bigint,text,text,uuid,text,bigint,timestamp with time zone,integer,integer,integer)",
  "public.companion_runtime_observe_instance(uuid,uuid,uuid,bigint,bigint,text,public.companion_runtime_work_kind,uuid,bigint,bigint,text,public.companion_box_observed_state,public.companion_pi_observed_state,text,integer,bigint,integer,timestamp with time zone)",
  "public.companion_runtime_get_material(uuid,uuid,uuid,bigint,bigint,text,public.companion_runtime_work_kind,uuid,integer)",
  "public.companion_runtime_get_attempt_terminal_projection(uuid,uuid,uuid,bigint,bigint,text,public.companion_runtime_work_kind,uuid)",
  "public.companion_runtime_cas_mcp_oauth(uuid,uuid,uuid,bigint,bigint,text,public.companion_runtime_work_kind,uuid,uuid,uuid,uuid,text,text,text,text,text,text,text)",
  "public.companion_runtime_register_duplicate_cleanups(uuid,uuid,uuid,bigint,bigint,text,public.companion_runtime_work_kind,uuid,text[])",
  "public.companion_runtime_checkpoint_duplicate_cleanup(uuid,uuid,uuid,bigint,bigint,text,public.companion_runtime_work_kind,uuid,text,bigint,public.companion_duplicate_cleanup_status,text)",
  "public.companion_runtime_authorize_desktop(uuid,uuid,text)",
  "public.companion_runtime_consume_desktop_request(text,bigint,integer)",
  "public.companion_runtime_project_event_batch(uuid,uuid,uuid,bigint,bigint,text,public.companion_runtime_work_kind,uuid,bigint,text,jsonb,bigint,timestamp with time zone,integer,integer,integer)",
  "public.companion_runtime_settle(uuid,uuid,uuid,bigint,bigint,text,public.companion_runtime_work_kind,uuid,text,text,text,public.companion_runtime_error_action)",
  "public.companion_runtime_release_lease(uuid,uuid,uuid,bigint,bigint,text,public.companion_runtime_work_kind,uuid)",
] as const;
const runtimeHelperFunctionSignatures = [
  "public.companion_runtime_create_lease_row()",
  "public.companion_runtime_assert_v2_mutation()",
  "public.companion_runtime_require_v2_mutation()",
  "public.companion_runtime_require_instance_at_commit()",
  "public.companion_runtime_assign_turn_sequence()",
  "public.companion_runtime_assign_operation_intent()",
  "public.companion_runtime_assign_attempt_snapshot()",
  "public.companion_runtime_reject_actor_change()",
  "public.companion_runtime_reject_turn_surface_change()",
  "public.companion_runtime_reject_attempt_snapshot_change()",
  "public.companion_runtime_reject_operation_snapshot_change()",
  "public.companion_runtime_reject_responder_change()",
  "public.companion_runtime_close_attempt_decisions(uuid,uuid,uuid,text,text,public.companion_runtime_error_action,uuid)",
  "public.companion_runtime_guard_duplicate_cleanup()",
  "public.companion_runtime_resume_after_decision_delivery()",
  "public.companion_api_actor(uuid)",
  "public.companion_api_require_access(uuid,uuid,text)",
  "public.companion_api_safe_error(text,text,public.companion_runtime_error_action)",
  "public.companion_api_turn_json(uuid,uuid,uuid)",
  "public.companion_api_operation_json(uuid,uuid,uuid)",
  "public.companion_api_validate_resource_selection(uuid,jsonb,jsonb,jsonb,jsonb)",
  "public.companion_api_retry_operation_handoff()",
  "public.companion_api_assign_attempt_retry_id()",
] as const;
const companionApiFunctionSignatures = [
  "public.companion_api_create_companion(uuid,text,text,text,text,jsonb,boolean,jsonb,uuid)",
  "public.companion_api_update_companion(uuid,uuid,jsonb)",
  "public.companion_api_set_workspace_access(uuid,uuid,public.companion_share_role)",
  "public.companion_api_update_member_state(uuid,uuid,boolean,boolean,boolean)",
  "public.companion_api_mark_thread_read(uuid,uuid)",
  "public.companion_api_enqueue_turn(uuid,uuid,uuid,text,public.companion_client_surface)",
  "public.companion_api_read_runtime(uuid,uuid)",
  "public.companion_api_list_runtime(uuid)",
  "public.companion_api_read_thread(uuid,uuid)",
  "public.companion_api_enqueue_operation(uuid,uuid,uuid,public.companion_operation_kind,public.companion_client_surface)",
  "public.companion_api_cancel_turn(uuid,uuid,uuid)",
  "public.companion_api_answer_decision(uuid,uuid,text,text,text)",
  "public.companion_api_bump_skill_revision(uuid,uuid)",
] as const;
const enableFunctionSignature = "public.companion_runtime_enable(bigint,text)";

const adminSql = postgres(databaseUrl, { max: 1 });
const runtimeUrl = new URL(databaseUrl);
runtimeUrl.pathname = `/${runtimeDatabaseName}`;
runtimeUrl.search = "";
const guardUrl = new URL(databaseUrl);
guardUrl.pathname = `/${guardDatabaseName}`;
guardUrl.search = "";

type Sql = ReturnType<typeof postgres>;
type Tx = postgres.TransactionSql;

interface Claim {
  orgId: string;
  companionId: string;
  claimToken: string;
  claimEpoch: number;
  gateEpoch: number;
  workKind: "operation" | "decision" | "attempt" | "settings" | "health";
  workId: string;
  actorId: string | null;
  clientSurface: "web" | "mobile_web" | "native_mobile";
  runtimeGeneration: number;
  checkpoint: string;
  checkpointSequence: number;
  turnId: string | null;
  turnStatus: string | null;
  attemptStatus: string | null;
  dispatchState: string | null;
  eventCursor: number | null;
  unknownEventCount: number | null;
  malformedEventCount: number | null;
  oversizedEventCount: number | null;
  coldStartDeadlineAt: string | null;
  inactivityDeadlineAt: string | null;
  absoluteDeadlineAt: string | null;
  operationKind: string | null;
  operationStartedAt: Date | null;
  operationAttemptCount: number | null;
  providerOperationId: string | null;
  targetSettingsRevision: number | null;
  targetSkillsRevision: number | null;
  decisionStatus: string | null;
  decisionDeliveryState: string | null;
}

interface GateStatus {
  enabled: boolean;
  gateEpoch: number;
}

interface Authorization {
  authorized: boolean;
  denialCode: string | null;
  authorizationActorId: string | null;
  decisionActorId: string | null;
  clientSurface: "web" | "mobile_web" | "native_mobile";
  boxId: string | null;
  boxState: string | null;
  piState: string | null;
  piInvocationId: string | null;
  diskLayoutVersion: number | null;
  appliedSettingsRevision: number | null;
  appliedSkillsRevision: number | null;
  modelId: string | null;
  persona: string | null;
  canWriteSkills: boolean | null;
  providerRefs: unknown[];
  skillRefs: unknown[];
  mcpRefs: unknown[];
  desiredSettingsRevision: number | null;
  skillsRevision: number | null;
  workCheckpoint: string;
  workCheckpointSequence: number;
  coldStartDeadlineAt: string | null;
  inactivityDeadlineAt: string | null;
  absoluteDeadlineAt: string | null;
  unknownEventCount: number | null;
  malformedEventCount: number | null;
  oversizedEventCount: number | null;
  operationKind: string | null;
  operationStartedAt: Date | null;
  operationAttemptCount: number | null;
  providerOperationId: string | null;
  targetSettingsRevision: number | null;
  targetSkillsRevision: number | null;
  decisionStatus: string | null;
  decisionDeliveryState: string | null;
  decisionRequestKey: string | null;
  decisionResponseText: string | null;
}

const ids = {
  orgA: randomUUID(),
  orgB: randomUUID(),
  ownerA: `runtime-owner-a-${suffix}`,
  editorA: `runtime-editor-a-${suffix}`,
  revokedA: `runtime-revoked-a-${suffix}`,
  ownerB: `runtime-owner-b-${suffix}`,
  companionA: randomUUID(),
  companionB: randomUUID(),
  companionC: randomUUID(),
  companionOtherTenant: randomUUID(),
  ownerSkill: randomUUID(),
  editorSkill: randomUUID(),
};

const providerId = `runtime-provider-${suffix}`;
const modelId = "runtime-test-model";

let runtimeSql: Sql | undefined;
let guardSql: Sql | undefined;
let runtimeDatabaseCreated = false;
let guardDatabaseCreated = false;
let rolesCreated = false;
let freshMigrationHadNoLedger = false;
let freshGate: GateStatus | undefined;

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

async function migrationNames(before?: string): Promise<string[]> {
  return (await readdir(migrationsDir))
    .filter((name) => /^\d{4}_.+\.sql$/.test(name) && (before === undefined || name < before))
    .sort();
}

async function replayMigrations(client: Sql, before?: string): Promise<void> {
  for (const migration of await migrationNames(before)) await applyMigrationFile(client, migration);
}

async function applySplitRuntimeGrants(
  client: Sql | undefined = runtimeSql,
  preserveCutoverMarker = false,
): Promise<void> {
  if (!client) throw new Error("runtime database is not initialized");
  const grants = extractRuntimeRoleGrantBlock(
    await readFile(await resolveRuntimeRoleGrantsFile(), "utf8"),
  );
  if (preserveCutoverMarker) {
    await client`select
      set_config('companion.api_role', ${apiRole}, false),
      set_config('companion.worker_role', ${workerRole}, false),
      set_config('companion.companion_runtime_role', ${executorRole}, false),
      set_config('companion.retired_runtime_role', '', false)`;
    await client.unsafe(grants);
    return;
  }
  await client.begin(async (tx) => {
    await tx`select
      set_config('companion.api_role', ${apiRole}, true),
      set_config('companion.worker_role', ${workerRole}, true),
      set_config('companion.companion_runtime_role', ${executorRole}, true),
      set_config('companion.retired_runtime_role', '', true)`;
    await tx.unsafe(grants);
  });
}

async function asRole<T>(role: string, action: (tx: Tx) => Promise<T>): Promise<T> {
  if (!runtimeSql) throw new Error("runtime database is not initialized");
  const wrapped = await runtimeSql.begin(async (tx) => {
    await tx.unsafe(`set local role ${role}`);
    return { value: await action(tx) };
  });
  return wrapped.value;
}

async function gateStatus(role = executorRole): Promise<GateStatus> {
  return asRole(role, async (tx) => {
    const [row] = await tx<Array<GateStatus>>`
      select enabled, gate_epoch::int as "gateEpoch"
      from public.companion_runtime_gate_status()
    `;
    if (!row) throw new Error("Runtime v2 gate status returned no row");
    return row;
  });
}

async function ensureEnabled(): Promise<GateStatus> {
  if (!runtimeSql) throw new Error("runtime database is not initialized");
  const status = await gateStatus();
  if (status.enabled) return status;
  const [enabled] = await runtimeSql<Array<GateStatus>>`
    select enabled, gate_epoch::int as "gateEpoch"
    from public.companion_runtime_enable(${status.gateEpoch}, 'integration-owner')
  `;
  if (!enabled) throw new Error("Runtime v2 enable returned no row");
  return enabled;
}

async function claimWork(
  executorId: string,
  gateEpoch: number,
  limit = 1,
  leaseSeconds = 30,
  role = executorRole,
): Promise<Claim[]> {
  return asRole(role, (tx) => tx<Array<Claim>>`
    select
      org_id::text as "orgId",
      companion_id::text as "companionId",
      claim_token::text as "claimToken",
      claim_epoch::int as "claimEpoch",
      gate_epoch::int as "gateEpoch",
      work_kind::text as "workKind",
      work_id::text as "workId",
      actor_id as "actorId",
      client_surface::text as "clientSurface",
      runtime_generation::int as "runtimeGeneration",
      checkpoint,
      checkpoint_sequence::int as "checkpointSequence",
      turn_id::text as "turnId",
      turn_status::text as "turnStatus",
      attempt_status::text as "attemptStatus",
      dispatch_state::text as "dispatchState",
      event_cursor::int as "eventCursor",
      unknown_event_count::int as "unknownEventCount",
      malformed_event_count::int as "malformedEventCount",
      oversized_event_count::int as "oversizedEventCount",
      cold_start_deadline_at as "coldStartDeadlineAt",
      inactivity_deadline_at as "inactivityDeadlineAt",
      absolute_deadline_at as "absoluteDeadlineAt",
      operation_kind::text as "operationKind",
      operation_started_at as "operationStartedAt",
      operation_attempt_count::int as "operationAttemptCount",
      provider_operation_id as "providerOperationId",
      target_settings_revision::int as "targetSettingsRevision",
      target_skills_revision::int as "targetSkillsRevision",
      decision_status::text as "decisionStatus",
      decision_delivery_state::text as "decisionDeliveryState"
    from public.companion_runtime_claim_work(
      ${executorId}, ${limit}, ${leaseSeconds}, ${gateEpoch}
    )
  `);
}

async function renewAndAuthorize(
  claim: Claim,
  executorId: string,
  overrides: Partial<Pick<Claim, "orgId" | "companionId" | "claimToken" | "claimEpoch" | "gateEpoch">> = {},
): Promise<Authorization[]> {
  const value = { ...claim, ...overrides };
  return asRole(executorRole, (tx) => tx<Array<Authorization>>`
    select
      authorized,
      denial_code as "denialCode",
      authorization_actor_id as "authorizationActorId",
      decision_actor_id as "decisionActorId",
      client_surface::text as "clientSurface",
      box_id as "boxId",
      box_state::text as "boxState",
      pi_state::text as "piState",
      pi_invocation_id as "piInvocationId",
      disk_layout_version::int as "diskLayoutVersion",
      applied_settings_revision::int as "appliedSettingsRevision",
      applied_skills_revision::int as "appliedSkillsRevision",
      model_id as "modelId",
      persona,
      can_write_skills as "canWriteSkills",
      provider_refs as "providerRefs",
      skill_refs as "skillRefs",
      mcp_refs as "mcpRefs",
      desired_settings_revision::int as "desiredSettingsRevision",
      skills_revision::int as "skillsRevision",
      work_checkpoint as "workCheckpoint",
      work_checkpoint_sequence::int as "workCheckpointSequence",
      unknown_event_count::int as "unknownEventCount",
      malformed_event_count::int as "malformedEventCount",
      oversized_event_count::int as "oversizedEventCount",
      cold_start_deadline_at as "coldStartDeadlineAt",
      inactivity_deadline_at as "inactivityDeadlineAt",
      absolute_deadline_at as "absoluteDeadlineAt",
      operation_kind::text as "operationKind",
      operation_started_at as "operationStartedAt",
      operation_attempt_count::int as "operationAttemptCount",
      provider_operation_id as "providerOperationId",
      target_settings_revision::int as "targetSettingsRevision",
      target_skills_revision::int as "targetSkillsRevision",
      decision_status::text as "decisionStatus",
      decision_delivery_state::text as "decisionDeliveryState",
      decision_request_key as "decisionRequestKey",
      decision_response_text as "decisionResponseText"
    from public.companion_runtime_renew_and_authorize(
      ${value.orgId}::uuid, ${value.companionId}::uuid, ${value.claimToken}::uuid,
      ${value.claimEpoch}, ${value.gateEpoch}, ${executorId}, ${claim.workKind},
      ${claim.workId}::uuid, 30
    )
  `);
}

async function checkpoint(
  claim: Claim,
  executorId: string,
  nextCheckpoint: string,
  overrides: {
    claimToken?: string;
    claimEpoch?: number;
    gateEpoch?: number;
    expectedSequence?: number;
    providerOperationId?: string | null;
    commandId?: string | null;
    piInvocationId?: string | null;
    eventCursor?: number | null;
    activityAt?: Date | null;
    unknownEventCount?: number | null;
    malformedEventCount?: number | null;
    oversizedEventCount?: number | null;
  } = {},
): Promise<number | null> {
  if (claim.workKind === "attempt" && nextCheckpoint === "dispatch_accepted") {
    if (!runtimeSql) throw new Error("runtime database is not initialized");
    // Runtime v2 freezes encrypted credential references while material is read, before Pi ACK.
    // These state-machine fixtures bypass get_material, so model that prerequisite explicitly.
    await runtimeSql`
      update companion_turn_attempts
      set provider_credential_refs = coalesce(provider_credential_refs, '[]'::jsonb),
          mcp_credential_refs = coalesce(mcp_credential_refs, '[]'::jsonb)
      where org_id = ${claim.orgId}::uuid
        and companion_id = ${claim.companionId}::uuid
        and id = ${claim.workId}::uuid
    `;
  }
  const [row] = await asRole(executorRole, (tx) => tx<Array<{ sequence: number | null }>>`
    select public.companion_runtime_checkpoint(
      ${claim.orgId}::uuid, ${claim.companionId}::uuid,
      ${overrides.claimToken ?? claim.claimToken}::uuid,
      ${overrides.claimEpoch ?? claim.claimEpoch}, ${overrides.gateEpoch ?? claim.gateEpoch},
      ${executorId}, ${claim.workKind}, ${claim.workId}::uuid,
      ${overrides.expectedSequence ?? claim.checkpointSequence}, ${nextCheckpoint},
      ${overrides.providerOperationId ?? null}, ${overrides.commandId ?? null}::uuid,
      ${overrides.piInvocationId ?? null}, ${overrides.eventCursor ?? null},
      ${overrides.activityAt ?? null}, ${overrides.unknownEventCount ?? null},
      ${overrides.malformedEventCount ?? null}, ${overrides.oversizedEventCount ?? null}
    )::int as sequence
  `);
  return row?.sequence ?? null;
}

async function settle(
  claim: Claim,
  executorId: string,
  terminalStatus: "succeeded" | "failed" | "interrupted" | "cancelled",
  overrides: {
    claimToken?: string;
    claimEpoch?: number;
    gateEpoch?: number;
    errorCode?: string | null;
    errorMessage?: string | null;
    errorAction?: string | null;
  } = {},
): Promise<boolean> {
  const failed = terminalStatus === "failed" || terminalStatus === "interrupted";
  const [row] = await asRole(executorRole, (tx) => tx<Array<{ settled: boolean }>>`
    select public.companion_runtime_settle(
      ${claim.orgId}::uuid, ${claim.companionId}::uuid,
      ${overrides.claimToken ?? claim.claimToken}::uuid,
      ${overrides.claimEpoch ?? claim.claimEpoch}, ${overrides.gateEpoch ?? claim.gateEpoch},
      ${executorId}, ${claim.workKind}, ${claim.workId}::uuid, ${terminalStatus},
      ${overrides.errorCode ?? (failed ? "integration_failure" : null)},
      ${overrides.errorMessage ?? (failed ? "Integration failure." : null)},
      ${overrides.errorAction ?? (failed ? "retry" : null)}
    ) as settled
  `);
  return row?.settled ?? false;
}

async function observeInstance(
  claim: Claim,
  executorId: string,
  overrides: {
    claimToken?: string;
    claimEpoch?: number;
    gateEpoch?: number;
    runtimeGeneration?: number;
    expectedSequence?: number;
    boxId?: string | null;
    boxState?: "absent" | "initializing" | "provisioning" | "ready" | "idle" | "running" | "archiving" | "archived" | "error" | "unknown" | null;
    piState?: "absent" | "starting" | "idle" | "running" | "stopped" | "error" | "unknown" | null;
    piInvocationId?: string | null;
    diskLayoutVersion?: number | null;
    appliedSettingsRevision?: number | null;
    appliedSkillsRevision?: number | null;
    observedAt?: Date;
  } = {},
): Promise<number | null> {
  const [row] = await asRole(executorRole, (tx) => tx<Array<{ sequence: number | null }>>`
    select public.companion_runtime_observe_instance(
      ${claim.orgId}::uuid, ${claim.companionId}::uuid,
      ${overrides.claimToken ?? claim.claimToken}::uuid,
      ${overrides.claimEpoch ?? claim.claimEpoch}, ${overrides.gateEpoch ?? claim.gateEpoch},
      ${executorId}, ${claim.workKind}, ${claim.workId}::uuid,
      ${overrides.runtimeGeneration ?? claim.runtimeGeneration},
      ${overrides.expectedSequence ?? claim.checkpointSequence},
      ${overrides.boxId ?? null},
      ${overrides.boxState ?? null}::public.companion_box_observed_state,
      ${overrides.piState ?? null}::public.companion_pi_observed_state,
      ${overrides.piInvocationId ?? null}, ${overrides.diskLayoutVersion ?? null},
      ${overrides.appliedSettingsRevision ?? null}, ${overrides.appliedSkillsRevision ?? null},
      ${overrides.observedAt ?? new Date()}
    )::int as sequence
  `);
  return row?.sequence ?? null;
}

async function releaseLease(claim: Claim, executorId: string): Promise<boolean> {
  const [row] = await asRole(executorRole, (tx) => tx<Array<{ released: boolean }>>`
    select public.companion_runtime_release_lease(
      ${claim.orgId}::uuid, ${claim.companionId}::uuid, ${claim.claimToken}::uuid,
      ${claim.claimEpoch}, ${claim.gateEpoch}, ${executorId}, ${claim.workKind},
      ${claim.workId}::uuid
    ) as released
  `);
  return row?.released ?? false;
}

async function resetWork(): Promise<void> {
  if (!runtimeSql) throw new Error("runtime database is not initialized");
  // Permanent-delete tests remove the aggregate root. Recreate the stable cross-test fixtures
  // through the migration-owner escape hatch before resetting their Runtime v2 state.
  await runtimeSql`
    insert into companions (
      id, org_id, owner_id, name, model_id, provider_ids, selected_skill_ids
    ) values
      (
        ${ids.companionA}::uuid, ${ids.orgA}::uuid, ${ids.ownerA}, 'Runtime A',
        ${modelId}, ${runtimeSql.json([providerId])}, ${runtimeSql.json([ids.ownerSkill])}
      ),
      (
        ${ids.companionB}::uuid, ${ids.orgA}::uuid, ${ids.ownerA}, 'Runtime B',
        ${modelId}, ${runtimeSql.json([providerId])}, ${runtimeSql.json([ids.ownerSkill])}
      ),
      (
        ${ids.companionC}::uuid, ${ids.orgA}::uuid, ${ids.ownerA}, 'Runtime C',
        ${modelId}, ${runtimeSql.json([providerId])}, ${runtimeSql.json([ids.ownerSkill])}
      ),
      (
        ${ids.companionOtherTenant}::uuid, ${ids.orgB}::uuid, ${ids.ownerB}, 'Runtime other',
        null, '[]'::jsonb, '[]'::jsonb
      )
    on conflict (id) do nothing
  `;
  await runtimeSql`
    insert into companion_runtime_instances (
      org_id, companion_id, applied_settings_revision, applied_skills_revision,
      applied_client_surface, health_due_at
    ) values
      (${ids.orgA}::uuid, ${ids.companionA}::uuid, 1, 1, 'web', now() + interval '1 day'),
      (${ids.orgA}::uuid, ${ids.companionB}::uuid, 1, 1, 'web', now() + interval '1 day'),
      (${ids.orgA}::uuid, ${ids.companionC}::uuid, 1, 1, 'web', now() + interval '1 day'),
      (${ids.orgB}::uuid, ${ids.companionOtherTenant}::uuid, 1, 1, 'web', now() + interval '1 day')
    on conflict (companion_id) do nothing
  `;
  // Clear the reverse settings-work pointer before deleting its source turn fixture.
  await runtimeSql`
    update companion_runtime_instances
    set settings_claim_turn_id = null, settings_claim_cold_start_deadline_at = null
    where settings_claim_turn_id is not null
  `;
  await runtimeSql`delete from companion_decision_deliveries`;
  await runtimeSql`delete from companion_runtime_leases`;
  await runtimeSql`delete from companion_turn_attempts`;
  await runtimeSql`delete from companion_operations`;
  await runtimeSql`delete from companion_turns`;
  await runtimeSql`
    update companion_runtime_instances
    set generation = 1,
        box_id = null,
        box_state = 'absent',
        pi_state = 'absent',
        pi_invocation_id = null,
        disk_layout_version = 0,
        desired_settings_revision = 1,
        applied_settings_revision = 1,
        applied_skills_revision = 1,
        applied_client_surface = 'web',
        settings_actor_id = null,
        settings_checkpoint = 'pending',
        settings_checkpoint_sequence = 0,
        settings_claim_epoch = null,
        settings_claim_actor_id = null,
        settings_claim_client_surface = null,
        settings_claim_turn_id = null,
        settings_claim_cold_start_deadline_at = null,
        settings_claim_revision = null,
        settings_claim_skills_revision = null,
        settings_claim_model_id = null,
        settings_claim_persona = null,
        settings_claim_can_write_skills = null,
        settings_claim_provider_ids = null,
        settings_claim_selected_skill_ids = null,
        settings_claim_skill_refs = null,
        settings_claim_selected_mcp_account_ids = null,
        health_checkpoint = 'pending',
        health_checkpoint_sequence = 0,
        health_claim_epoch = null,
        health_due_at = now() + interval '1 day',
        next_turn_sequence = 1,
        next_operation_sequence = 1,
        last_heartbeat_at = null,
        box_observed_at = null,
        pi_observed_at = null,
        last_observed_at = null,
        retirement_state = 'active',
        retirement_requested_at = null,
        retired_at = null,
        last_write_epoch = 0,
        last_error_code = null,
        last_error_message = null,
        last_error_action = null
  `;
  await runtimeSql`
    insert into companion_runtime_leases (org_id, companion_id)
    select org_id, companion_id from companion_runtime_instances
    on conflict (companion_id) do nothing
  `;
  await runtimeSql`
    update companions
    set model_id = ${modelId},
        provider_ids = ${runtimeSql.json([providerId])},
        selected_skill_ids = ${runtimeSql.json([ids.ownerSkill])},
        selected_mcp_account_ids = '[]'::jsonb,
        skills_revision = 1
    where org_id = ${ids.orgA}::uuid
  `;
}

async function insertOperation(input: {
  companionId: string;
  actorId?: string;
  kind?: "delete" | "stop" | "restart_pi" | "restart_box" | "start" | "apply_settings";
  trigger?: "turn" | "user" | "settings" | "recovery" | "kill_switch";
  orgId?: string;
  requestId?: string;
  sourceTurnId?: string | null;
  clientSurface?: "web" | "mobile_web" | "native_mobile";
  targetSettingsRevision?: number | null;
  targetSkillsRevision?: number | null;
}): Promise<string> {
  if (!runtimeSql) throw new Error("runtime database is not initialized");
  const id = randomUUID();
  await runtimeSql`
    insert into companion_operations (
      id, org_id, companion_id, request_id, kind, trigger, actor_id, source_turn_id,
      runtime_generation, client_surface,
      target_settings_revision, target_skills_revision
    ) values (
      ${id}::uuid, ${input.orgId ?? ids.orgA}::uuid, ${input.companionId}::uuid,
      ${input.requestId ?? randomUUID()}::uuid, ${input.kind ?? "stop"}, ${input.trigger ?? "user"},
      ${input.actorId ?? ids.ownerA}, ${input.sourceTurnId ?? null}::uuid, 1,
      ${input.clientSurface ?? null}::companion_client_surface,
      ${input.targetSettingsRevision ?? null},
      ${input.targetSkillsRevision ?? null}
    )
  `;
  return id;
}

async function insertDecision(input: {
  companionId: string;
  turnId: string;
  attemptId: string;
  actorId?: string | null;
  requestKey?: string;
  status?: "pending" | "allowed" | "denied" | "answered";
  deliveryState?: "pending" | "write_intent";
  commandId?: string | null;
}): Promise<{ id: string; requestKey: string }> {
  if (!runtimeSql) throw new Error("runtime database is not initialized");
  const id = randomUUID();
  const requestKey = input.requestKey ?? `decision-${randomUUID()}`;
  const status = input.status ?? "answered";
  const actorId = status === "pending" ? null : (input.actorId ?? ids.ownerA);
  const deliveryState = input.deliveryState ?? "pending";
  const commandId = deliveryState === "write_intent" ? (input.commandId ?? randomUUID()) : null;
  await runtimeSql`
    insert into companion_decision_deliveries (
      id, org_id, companion_id, turn_id, attempt_id, request_key,
      decision_status, actor_id, response_text, responded_at, expires_at,
      delivery_state, delivery_checkpoint, delivery_checkpoint_sequence,
      command_id, delivery_started_at
    ) values (
      ${id}::uuid, ${ids.orgA}::uuid, ${input.companionId}::uuid,
      ${input.turnId}::uuid, ${input.attemptId}::uuid, ${requestKey},
      ${status}, ${actorId},
      ${status === "answered" ? "approved by integration test" : null},
      ${status === "pending" ? null : new Date()}, now() + interval '10 minutes',
      ${deliveryState}, ${deliveryState}, ${deliveryState === "write_intent" ? 1 : 0},
      ${commandId}::uuid, ${deliveryState === "write_intent" ? new Date() : null}
    )
  `;
  return { id, requestKey };
}

async function insertQueuedTurn(input: {
  companionId: string;
  actorId?: string;
  orgId?: string;
  clientSurface?: "web" | "mobile_web" | "native_mobile";
}): Promise<string> {
  if (!runtimeSql) throw new Error("runtime database is not initialized");
  const id = randomUUID();
  const clientMessageId = randomUUID();
  await runtimeSql`
    insert into companion_turns (
      id, org_id, companion_id, client_message_id, message_event_id,
      queue_sequence, actor_id, client_surface
    ) values (
      ${id}::uuid, ${input.orgId ?? ids.orgA}::uuid, ${input.companionId}::uuid,
      ${clientMessageId}::uuid, ${`msg:${clientMessageId}`}, 1,
      ${input.actorId ?? ids.ownerA}, ${input.clientSurface ?? "web"}
    )
  `;
  return id;
}

async function insertActiveTurnAttempt(input: {
  companionId: string;
  actorId?: string;
  orgId?: string;
  selectedSkillIds?: string[];
  selectedMcpAccountIds?: string[];
}): Promise<{ turnId: string; attemptId: string }> {
  if (!runtimeSql) throw new Error("runtime database is not initialized");
  const orgId = input.orgId ?? ids.orgA;
  const actorId = input.actorId ?? ids.ownerA;
  const turnId = randomUUID();
  const attemptId = randomUUID();
  const clientMessageId = randomUUID();
  await runtimeSql`
    insert into companion_turns (
      id, org_id, companion_id, client_message_id, message_event_id, queue_sequence,
      actor_id, client_surface, status, inactivity_deadline_at, absolute_deadline_at
    ) values (
      ${turnId}::uuid, ${orgId}::uuid, ${input.companionId}::uuid,
      ${clientMessageId}::uuid, ${`msg:${clientMessageId}`}, 1, ${actorId}, 'web',
      'running', now() + interval '10 minutes', now() + interval '2 hours'
    )
  `;
  await runtimeSql`
    insert into companion_turn_attempts (
      id, org_id, companion_id, turn_id, attempt_number, actor_id,
      runtime_generation, settings_revision, skills_revision, model_id,
      provider_ids, selected_skill_ids, selected_mcp_account_ids,
      provider_credential_refs, mcp_credential_refs,
      status, checkpoint, dispatch_state, command_id, last_activity_at
    ) values (
      ${attemptId}::uuid, ${orgId}::uuid, ${input.companionId}::uuid, ${turnId}::uuid,
      1, ${actorId}, 1, 1, 1, ${modelId}, ${runtimeSql.json([providerId])},
      ${runtimeSql.json(input.selectedSkillIds ?? [ids.ownerSkill])},
      ${runtimeSql.json(input.selectedMcpAccountIds ?? [])},
      '[]'::jsonb, '[]'::jsonb,
      'running', 'running', 'accepted', ${randomUUID()}::uuid, now()
    )
  `;
  return { turnId, attemptId };
}

async function disableGate(expectedEpoch: number): Promise<GateStatus> {
  return asRole(executorRole, async (tx) => {
    const [row] = await tx<Array<GateStatus>>`
      select enabled, gate_epoch::int as "gateEpoch"
      from public.companion_runtime_disable(${expectedEpoch}, 'integration-kill-switch')
    `;
    if (!row) throw new Error("Runtime v2 disable returned no row");
    return row;
  });
}

async function waitForBackendLock(pid: number, label: string): Promise<void> {
  if (!runtimeSql) throw new Error("runtime database is not initialized");
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const [activity] = await runtimeSql<Array<{ waitEventType: string | null }>>`
      select wait_event_type as "waitEventType"
      from pg_stat_activity
      where pid = ${pid} and datname = ${runtimeDatabaseName}
    `;
    if (activity?.waitEventType === "Lock") return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`${label} did not reach the expected PostgreSQL lock wait`);
}

async function settlesWithin<T>(promise: Promise<T>, milliseconds: number, label: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(`${label} exceeded ${milliseconds}ms`)), milliseconds);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

// oxlint-disable-next-line anti-slop/no-unknown-returns -- legacy pattern predating the incremental anti-slop gate
async function aclSnapshot(roles: readonly string[]): Promise<unknown> {
  if (!runtimeSql) throw new Error("runtime database is not initialized");
  const tables: unknown[] = [];
  const functions: unknown[] = [];
  for (const role of roles) {
    for (const table of runtimeTables) {
      const [row] = await runtimeSql<Array<{
        role: string;
        table: string;
        select: boolean;
        insert: boolean;
        update: boolean;
        delete: boolean;
      }>>`
        select ${role} as role, ${table} as table,
          has_table_privilege(${role}, ${`public.${table}`}, 'SELECT') as select,
          has_table_privilege(${role}, ${`public.${table}`}, 'INSERT') as insert,
          has_table_privilege(${role}, ${`public.${table}`}, 'UPDATE') as update,
          has_table_privilege(${role}, ${`public.${table}`}, 'DELETE') as delete
      `;
      tables.push(row);
    }
    for (const signature of [
      ...runtimeFunctionSignatures,
      ...companionApiFunctionSignatures,
      ...runtimeHelperFunctionSignatures,
      enableFunctionSignature,
    ]) {
      const [row] = await runtimeSql<Array<{
        role: string;
        signature: string;
        oid: string | null;
        execute: boolean | null;
      }>>`
        select ${role} as role, ${signature} as signature,
          to_regprocedure(${signature})::text as oid,
          has_function_privilege(${role}, to_regprocedure(${signature}), 'EXECUTE') as execute
      `;
      functions.push(row);
    }
  }
  const sequences = await runtimeSql<Array<{
    role: string;
    sequence: string;
    usage: boolean;
    select: boolean;
  }>>`
    select configured.role, sequence_class.oid::regclass::text as sequence,
      has_sequence_privilege(configured.role, sequence_class.oid, 'USAGE') as usage,
      has_sequence_privilege(configured.role, sequence_class.oid, 'SELECT') as select
    from unnest(${[...roles]}::text[]) configured(role)
    join pg_class sequence_class on sequence_class.relkind = 'S'
    join pg_namespace sequence_namespace
      on sequence_namespace.oid = sequence_class.relnamespace
    join pg_depend sequence_dependency
      on sequence_dependency.classid = 'pg_class'::regclass
      and sequence_dependency.objid = sequence_class.oid
      and sequence_dependency.deptype in ('a', 'i')
    join pg_class owning_table on owning_table.oid = sequence_dependency.refobjid
    where sequence_namespace.nspname = 'public'
      and owning_table.relname = any(${[...runtimeTables]}::text[])
    order by configured.role, sequence
  `;
  return { tables, functions, sequences };
}

describe("Companion Runtime v2 PostgreSQL contract", () => {
  beforeAll(async () => {
    await adminSql.unsafe(`
      create role ${apiRole} login nosuperuser nobypassrls noinherit;
      create role ${workerRole} login nosuperuser nobypassrls noinherit;
      create role ${executorRole} login nosuperuser nobypassrls noinherit;
      create role ${unexpectedFunctionRole} login nosuperuser nobypassrls noinherit;
      create role ${apiParentRole} nologin nosuperuser nobypassrls noinherit;
      create role ${workerParentRole} nologin nosuperuser nobypassrls noinherit;
    `);
    rolesCreated = true;
    await adminSql.unsafe(`create database "${guardDatabaseName}"`);
    guardDatabaseCreated = true;
    guardSql = postgres(guardUrl.toString(), { max: 1 });
    await replayMigrations(guardSql, "0094_companion_runtime_cutover.sql");
    await applySplitRuntimeGrants(guardSql, true);

    await guardSql`
      insert into "user" (id, name, email, email_verified)
      values ('runtime-v2-guard-owner', 'Guard Owner', 'runtime-v2-guard@example.test', true)
    `;
    const guardOrg = randomUUID();
    await guardSql`
      insert into organizations (id, name, slug, kind)
      values (${guardOrg}::uuid, 'Runtime v2 guard', ${`runtime-v2-guard-${suffix}`}, 'team')
    `;
    await guardSql`
      insert into memberships (org_id, user_id, org_role)
      values (${guardOrg}::uuid, 'runtime-v2-guard-owner', 'owner')
    `;
    const guardCompanion = randomUUID();
    await guardSql`
      insert into companions (id, org_id, owner_id, name)
      values (${guardCompanion}::uuid, ${guardOrg}::uuid, 'runtime-v2-guard-owner', 'Cutover guard')
    `;
    await guardSql`
      insert into companion_runtime_instances (org_id, companion_id)
      values (${guardOrg}::uuid, ${guardCompanion}::uuid)
    `;
    await guardSql`
      insert into companion_legacy_purge_runs (
        id, phase, inventory_hash, inventory, completed_at
      ) values (
        'legacy-companion-purge', 'database_complete', ${"0".repeat(64)}, '{}'::jsonb, now()
      )
    `;
    await guardSql`
      insert into companion_runtime_pools (org_id, scope)
      values (${guardOrg}::uuid, 'org')
    `;

    await adminSql.unsafe(`create database "${runtimeDatabaseName}"`);
    runtimeDatabaseCreated = true;
    const runtimeMigrationSql = postgres(runtimeUrl.toString(), { max: 1 });
    await replayMigrations(runtimeMigrationSql, "0094_companion_runtime_cutover.sql");

    const [ledger] = await runtimeMigrationSql<Array<{ count: number }>>`
      select count(*)::int as count from companion_legacy_purge_runs
    `;
    freshMigrationHadNoLedger = ledger?.count === 0;
    const [initialGate] = await runtimeMigrationSql<Array<GateStatus>>`
      select enabled, gate_epoch::int as "gateEpoch"
      from companion_runtime_control where id = 'runtime-v2'
    `;
    freshGate = initialGate;

    await applySplitRuntimeGrants(runtimeMigrationSql, true);
    await applyMigrationFile(runtimeMigrationSql, "0094_companion_runtime_cutover.sql");
    // This suite pins the post-cutover contract. 0109 redefines
    // companion_runtime_observe_instance with CREATE OR REPLACE, so grants survive and the
    // final split-grants pass below mirrors the production grants hook running after it.
    await applyMigrationFile(runtimeMigrationSql, "0109_companion_runtime_health_identity.sql");
    await runtimeMigrationSql.end({ timeout: 1 });
    runtimeSql = postgres(runtimeUrl.toString(), { max: 10 });
    await runtimeSql.unsafe(`
      grant usage on schema public to ${unexpectedFunctionRole};
      grant execute on all functions in schema public to ${unexpectedFunctionRole};
      alter default privileges
        grant execute on functions to ${unexpectedFunctionRole};
      alter default privileges in schema public
        grant execute on functions to ${unexpectedFunctionRole};
    `);
    await applySplitRuntimeGrants();

    const actors = [ids.ownerA, ids.editorA, ids.revokedA, ids.ownerB];
    for (const [index, actor] of actors.entries()) {
      await runtimeSql`
        insert into "user" (id, name, email, email_verified)
        values (${actor}, ${`Runtime actor ${index}`}, ${`${actor}@example.test`}, true)
      `;
    }
    await runtimeSql`
      insert into organizations (id, name, slug, kind) values
        (${ids.orgA}::uuid, 'Runtime org A', ${`runtime-a-${suffix}`}, 'team'),
        (${ids.orgB}::uuid, 'Runtime org B', ${`runtime-b-${suffix}`}, 'team')
    `;
    await runtimeSql`
      insert into memberships (org_id, user_id, org_role) values
        (${ids.orgA}::uuid, ${ids.ownerA}, 'owner'),
        (${ids.orgA}::uuid, ${ids.editorA}, 'developer'),
        (${ids.orgB}::uuid, ${ids.ownerB}, 'owner')
    `;

    await runtimeSql`
      insert into companion_provider_connections (
        org_id, provider_id, auth_method, ciphertext, iv, auth_tag,
        wrapped_dek, wrap_iv, wrap_auth_tag, key_id, connected_by
      ) values (
        ${ids.orgA}::uuid, ${providerId}, 'api_key', 'ciphertext', 'iv', 'auth-tag',
        'wrapped-dek', 'wrap-iv', 'wrap-auth-tag', 'integration-key', ${ids.ownerA}
      )
    `;
    await runtimeSql`
      insert into skills (id, org_id, slug, description, creator_id, scope) values
        (
          ${ids.ownerSkill}::uuid, ${ids.orgA}::uuid, ${`owner-skill-${suffix}`},
          'Owner private runtime fixture', ${ids.ownerA}, 'personal'
        ),
        (
          ${ids.editorSkill}::uuid, ${ids.orgA}::uuid, ${`editor-skill-${suffix}`},
          'Another actor private runtime fixture', ${ids.editorA}, 'personal'
        )
    `;
    await runtimeSql`
      insert into companions (
        id, org_id, owner_id, name, model_id, provider_ids, selected_skill_ids
      ) values
        (
          ${ids.companionA}::uuid, ${ids.orgA}::uuid, ${ids.ownerA}, 'Runtime A',
          ${modelId}, ${runtimeSql.json([providerId])}, ${runtimeSql.json([ids.ownerSkill])}
        ),
        (
          ${ids.companionB}::uuid, ${ids.orgA}::uuid, ${ids.ownerA}, 'Runtime B',
          ${modelId}, ${runtimeSql.json([providerId])}, ${runtimeSql.json([ids.ownerSkill])}
        ),
        (
          ${ids.companionC}::uuid, ${ids.orgA}::uuid, ${ids.ownerA}, 'Runtime C',
          ${modelId}, ${runtimeSql.json([providerId])}, ${runtimeSql.json([ids.ownerSkill])}
        ),
        (
          ${ids.companionOtherTenant}::uuid, ${ids.orgB}::uuid, ${ids.ownerB}, 'Runtime other',
          null, '[]'::jsonb, '[]'::jsonb
        )
    `;
    await runtimeSql`
      insert into companion_runtime_instances (
        org_id, companion_id, applied_settings_revision, applied_skills_revision,
        applied_client_surface, health_due_at
      ) values
        (${ids.orgA}::uuid, ${ids.companionA}::uuid, 1, 1, 'web', now() + interval '1 day'),
        (${ids.orgA}::uuid, ${ids.companionB}::uuid, 1, 1, 'web', now() + interval '1 day'),
        (${ids.orgA}::uuid, ${ids.companionC}::uuid, 1, 1, 'web', now() + interval '1 day'),
        (${ids.orgB}::uuid, ${ids.companionOtherTenant}::uuid, 1, 1, 'web', now() + interval '1 day')
    `;
  }, 120_000);

  beforeEach(async () => {
    await resetWork();
    await ensureEnabled();
  });

  afterAll(async () => {
    await runtimeSql?.end({ timeout: 1 });
    await guardSql?.end({ timeout: 1 });
    if (runtimeDatabaseCreated) {
      await adminSql.unsafe(`drop database if exists "${runtimeDatabaseName}" with (force)`);
    }
    if (guardDatabaseCreated) {
      await adminSql.unsafe(`drop database if exists "${guardDatabaseName}" with (force)`);
    }
    if (rolesCreated) {
      for (const role of [
        apiRole,
        workerRole,
        executorRole,
        unexpectedFunctionRole,
        apiParentRole,
        workerParentRole,
      ]) {
        await adminSql.unsafe(`drop role if exists ${role}`);
      }
    }
    await adminSql.end({ timeout: 1 });
  }, 30_000);

  it("blocks final cutover until legacy ownership is gone and retains owner-only purge evidence", async () => {
    if (!guardSql) throw new Error("guard database is not initialized");

    await expect(applyMigrationFile(guardSql, "0094_companion_runtime_cutover.sql"))
      .rejects.toThrow("Runtime v2 final cutover preflight failed");

    const [blocked] = await guardSql<Array<{ poolTable: string | null; poolCount: number }>>`
      select to_regclass('public.companion_runtime_pools')::text as "poolTable",
             (select count(*)::int from companion_runtime_pools) as "poolCount"
    `;
    expect(blocked).toEqual({ poolTable: "companion_runtime_pools", poolCount: 1 });

    await guardSql`delete from companion_runtime_pools`;

    const [disabledGate] = await guardSql<Array<GateStatus>>`
      select enabled, gate_epoch::int as "gateEpoch"
      from companion_runtime_control where id = 'runtime-v2'
    `;
    if (!disabledGate) throw new Error("guard runtime gate is missing");
    await guardSql`
      select * from public.companion_runtime_enable(
        ${disabledGate.gateEpoch}, 'runtime-v2-cutover-guard-test'
      )
    `;
    await expect(applyMigrationFile(guardSql, "0094_companion_runtime_cutover.sql"))
      .rejects.toThrow("Runtime v2 final cutover preflight failed");

    const [enabledGate] = await guardSql<Array<GateStatus>>`
      select enabled, gate_epoch::int as "gateEpoch"
      from companion_runtime_control where id = 'runtime-v2'
    `;
    if (!enabledGate) throw new Error("enabled guard runtime gate is missing");
    await guardSql`
      select * from public.companion_runtime_disable(
        ${enabledGate.gateEpoch}, 'runtime-v2-cutover-guard-test'
      )
    `;
    await applyMigrationFile(guardSql, "0094_companion_runtime_cutover.sql");

    const [cutover] = await guardSql<Array<{
      poolTable: string | null;
      reconcileTable: string | null;
      purgeRunCount: number;
      purgeRunRls: boolean;
      purgeRunForced: boolean;
      ownerReadPolicies: number;
      applicationPrivilegeCount: number;
    }>>`
      select
        to_regclass('public.companion_runtime_pools')::text as "poolTable",
        to_regclass('public.companion_reconcile_leases')::text as "reconcileTable",
        (select count(*)::int from companion_legacy_purge_runs) as "purgeRunCount",
        (select relrowsecurity from pg_class where oid = 'public.companion_legacy_purge_runs'::regclass)
          as "purgeRunRls",
        (select relforcerowsecurity from pg_class where oid = 'public.companion_legacy_purge_runs'::regclass)
          as "purgeRunForced",
        (
          select count(*)::int from pg_policies
          where schemaname = 'public'
            and tablename in ('companion_legacy_purge_runs', 'companion_legacy_purge_targets')
            and policyname like '%owner_read_rls'
        ) as "ownerReadPolicies",
        (
          select count(*)::int
          from unnest(${[apiRole, workerRole, executorRole]}::text[]) configured(role)
          cross join unnest(${[
            "companion_legacy_purge_runs",
            "companion_legacy_purge_targets",
          ]}::text[]) evidence(table_name)
          where has_table_privilege(configured.role, 'public.' || evidence.table_name, 'SELECT')
        ) as "applicationPrivilegeCount"
    `;
    expect(cutover).toEqual({
      poolTable: null,
      reconcileTable: null,
      purgeRunCount: 1,
      purgeRunRls: true,
      purgeRunForced: true,
      ownerReadPolicies: 2,
      applicationPrivilegeCount: 0,
    });
  });

  it("admits a fresh final cutover without a synthetic purge ledger and removes legacy schema", async () => {
    if (!runtimeSql) throw new Error("runtime database is not initialized");
    expect(freshMigrationHadNoLedger).toBe(true);
    expect(freshGate).toEqual({ enabled: false, gateEpoch: 1 });

    const legacyFunctions = [
      "public.companion_accept_delivery_lease(uuid,uuid,uuid,integer,integer)",
      "public.companion_claim_delivery_lease(uuid,uuid,uuid,integer)",
      "public.companion_release_delivery_lease(uuid,uuid,uuid)",
      "public.companion_renew_delivery_lease(uuid,uuid,uuid,integer)",
      "public.companion_refresh_delivery_compat_backfill(integer)",
      "public.companion_delivery_read_fence(uuid,uuid,text)",
      "public.companion_delivery_compat_deadline(uuid,uuid,timestamp with time zone)",
      "public.companion_block_delivery_compat_claim()",
      "public.companion_expire_tool_runs(uuid,uuid,timestamp with time zone,integer,integer)",
      "public.companion_claim_reconcile_candidates(text,integer,integer,integer,integer)",
      "public.companion_settle_reconcile_lease(uuid,uuid,text,text,integer)",
      "public.companion_finalize_legacy_purge()",
      "public.companion_runtime_fence_legacy_token()",
    ];
    const legacyCompanionColumns = [
      "box_id", "runtime_state", "daemon_state", "provider_credential_generation",
      "skills_applied_revision", "skills_applied_at", "skills_last_error",
      "disk_layout_version", "desktop_available", "last_error", "last_observed_at",
      "last_started_at", "last_stopped_at",
    ];
    const legacyThreadColumns = [
      "delivered_ordinal", "accepted_delivery_ordinal", "timeout_recovery_ordinal",
      "timeout_restart_ordinal", "timeout_delivery_ordinal", "pi_log_offset",
    ];
    // oxlint-disable-next-line anti-slop/no-shape-in-symbol-names -- legacy pattern predating the incremental anti-slop gate
    const [shape] = await runtimeSql<Array<{
      legacyTableCount: number;
      legacyFunctionCount: number;
      legacyTypeCount: number;
      legacyCompanionColumnCount: number;
      legacyThreadColumnCount: number;
      retainedLedgerTableCount: number;
    }>>`
      select
        (
          select count(*)::int from unnest(${[
            "companion_runtime_pools",
            "companion_reconcile_leases",
          ]}::text[]) legacy(name)
          where to_regclass('public.' || legacy.name) is not null
        ) as "legacyTableCount",
        (
          select count(*)::int from unnest(${legacyFunctions}::text[]) legacy(signature)
          where to_regprocedure(legacy.signature) is not null
        ) as "legacyFunctionCount",
        (
          select count(*)::int from unnest(${[
            "public.companion_runtime_pool_scope",
            "public.companion_runtime_state",
            "public.companion_daemon_state",
          ]}::text[]) legacy(name)
          where to_regtype(legacy.name) is not null
        ) as "legacyTypeCount",
        (
          select count(*)::int from information_schema.columns
          where table_schema = 'public' and table_name = 'companions'
            and column_name = any(${legacyCompanionColumns}::text[])
        ) as "legacyCompanionColumnCount",
        (
          select count(*)::int from information_schema.columns
          where table_schema = 'public' and table_name = 'companion_threads'
            and column_name = any(${legacyThreadColumns}::text[])
        ) as "legacyThreadColumnCount",
        (
          select count(*)::int from unnest(${[
            "companion_legacy_purge_runs",
            "companion_legacy_purge_targets",
          ]}::text[]) evidence(name)
          where to_regclass('public.' || evidence.name) is not null
        ) as "retainedLedgerTableCount"
    `;
    // oxlint-disable-next-line anti-slop/no-shape-in-symbol-names -- legacy pattern predating the incremental anti-slop gate
    expect(shape).toEqual({
      legacyTableCount: 0,
      legacyFunctionCount: 0,
      legacyTypeCount: 0,
      legacyCompanionColumnCount: 0,
      legacyThreadColumnCount: 0,
      retainedLedgerTableCount: 2,
    });
  });

  it("scrubs unknown current and default grantees from every Runtime v2 function", async () => {
    if (!runtimeSql) throw new Error("runtime database is not initialized");
    const protectedSignatures = [
      ...runtimeFunctionSignatures,
      ...companionApiFunctionSignatures,
      ...runtimeHelperFunctionSignatures,
      enableFunctionSignature,
    ];

    for (const signature of protectedSignatures) {
      await runtimeSql.unsafe(
        `grant execute on function ${signature} to ${unexpectedFunctionRole}`,
      );
    }
    await runtimeSql.unsafe(`
      alter default privileges
        grant execute on functions to ${unexpectedFunctionRole};
      alter default privileges in schema public
        grant execute on functions to ${unexpectedFunctionRole}
    `);

    // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- legacy pattern predating the incremental anti-slop gate
    const before = await aclSnapshot([unexpectedFunctionRole]) as {
      functions: Array<{ signature: string; execute: boolean | null }>;
    };
    expect(before.functions).toHaveLength(protectedSignatures.length);
    expect(before.functions.every((entry) => entry.execute)).toBe(true);

    await applySplitRuntimeGrants();

    // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- legacy pattern predating the incremental anti-slop gate
    const after = await aclSnapshot([unexpectedFunctionRole]) as {
      functions: Array<{ signature: string; execute: boolean | null }>;
    };
    expect(after.functions).toHaveLength(protectedSignatures.length);
    expect(after.functions.every((entry) => !entry.execute)).toBe(true);

    const [defaults] = await runtimeSql<Array<{ executePrivileges: number }>>`
      select count(*)::int as "executePrivileges"
      from pg_catalog.pg_default_acl defaults
      cross join lateral pg_catalog.aclexplode(defaults.defaclacl) acl
      join pg_catalog.pg_roles grantee on grantee.oid = acl.grantee
      where defaults.defaclrole = (
          select owner.oid from pg_catalog.pg_roles owner where owner.rolname = current_user
        )
        and defaults.defaclnamespace in (0, 'public'::regnamespace)
        and defaults.defaclobjtype = 'f'
        and grantee.rolname = ${unexpectedFunctionRole}
        and acl.privilege_type = 'EXECUTE'
    `;
    expect(defaults).toEqual({ executePrivileges: 0 });

    await expect(asRole(unexpectedFunctionRole, (tx) => tx`
      select * from companion_runtime_gate_status()
    `)).rejects.toThrow(/permission denied.*companion_runtime_gate_status/i);
    await expect(asRole(unexpectedFunctionRole, (tx) => tx`
      select * from companion_runtime_claim_work('unexpected', 1, 30, 1)
    `)).rejects.toThrow(/permission denied.*companion_runtime_claim_work/i);
    await expect(asRole(unexpectedFunctionRole, (tx) => tx`
      select * from companion_runtime_disable(1, 'unexpected')
    `)).rejects.toThrow(/permission denied.*companion_runtime_disable/i);
    await expect(asRole(unexpectedFunctionRole, (tx) => tx`
      select * from companion_runtime_enable(1, 'unexpected')
    `)).rejects.toThrow(/permission denied.*companion_runtime_enable/i);

    await runtimeSql.unsafe(`
      create function public.companion_runtime_future_acl_probe()
      returns integer
      language sql
      security definer
      set search_path = pg_catalog, public
      as 'select 1'
    `);
    try {
      const [futureAcl] = await runtimeSql<Array<{
        unexpectedCanExecute: boolean;
        publicCanExecute: boolean;
      }>>`
        select
          has_function_privilege(
            ${unexpectedFunctionRole},
            'public.companion_runtime_future_acl_probe()',
            'EXECUTE'
          ) as "unexpectedCanExecute",
          has_function_privilege(
            'public',
            'public.companion_runtime_future_acl_probe()',
            'EXECUTE'
          ) as "publicCanExecute"
      `;
      expect(futureAcl).toEqual({ unexpectedCanExecute: false, publicCanExecute: false });
    } finally {
      await runtimeSql.unsafe("drop function public.companion_runtime_future_acl_probe()");
    }
  });

  it("fails closed when another role can assume the dedicated runtime executor", async () => {
    if (!runtimeSql) throw new Error("runtime database is not initialized");
    await runtimeSql.unsafe(`grant ${executorRole} to ${unexpectedFunctionRole}`);
    try {
      const [membership] = await runtimeSql<Array<{ member: boolean; canSet: boolean }>>`
        select
          pg_has_role(${unexpectedFunctionRole}, ${executorRole}, 'MEMBER') as member,
          pg_has_role(${unexpectedFunctionRole}, ${executorRole}, 'SET') as "canSet"
      `;
      expect(membership).toEqual({ member: true, canSet: true });
      await expect(applySplitRuntimeGrants())
        .rejects.toThrow(/active companion database role .* must have no role memberships/i);
    } finally {
      await runtimeSql.unsafe(`revoke ${executorRole} from ${unexpectedFunctionRole}`);
    }
    await applySplitRuntimeGrants();
  });

  it("rejects unrelated SET ROLE paths from both API and worker logins", async () => {
    if (!runtimeSql) throw new Error("runtime database is not initialized");
    const cases = [
      { login: apiRole, parent: apiParentRole },
      { login: workerRole, parent: workerParentRole },
    ];

    for (const roleCase of cases) {
      await runtimeSql.unsafe(`grant update on table public.companions to ${roleCase.parent}`);
      await runtimeSql.unsafe(`grant ${roleCase.parent} to ${roleCase.login}`);
      try {
        const [membership] = await runtimeSql<Array<{ member: boolean; canSet: boolean }>>`
          select
            pg_has_role(${roleCase.login}, ${roleCase.parent}, 'MEMBER') as member,
            pg_has_role(${roleCase.login}, ${roleCase.parent}, 'SET') as "canSet"
        `;
        expect(membership).toEqual({ member: true, canSet: true });
        await expect(applySplitRuntimeGrants())
          .rejects.toThrow(/active companion database role .* must have no role memberships/i);
      } finally {
        await runtimeSql.unsafe(`revoke ${roleCase.parent} from ${roleCase.login}`);
      }

      await applySplitRuntimeGrants();
      await expect(runtimeSql.begin(async (tx) => {
        await tx.unsafe(`set local session authorization ${roleCase.login}`);
        await tx.unsafe(`set local role ${roleCase.parent}`);
        await tx`select set_config('app.companion_runtime_protocol', '2', true)`;
        await tx`update companions set updated_at = updated_at where id = ${ids.companionA}::uuid`;
      })).rejects.toThrow(/permission denied to set role/i);
      const [directPrivilege] = await runtimeSql<Array<{ canUpdate: boolean }>>`
        select has_table_privilege(${roleCase.login}, 'public.companions', 'UPDATE') as "canUpdate"
      `;
      expect(directPrivilege).toEqual({ canUpdate: false });
      await runtimeSql.unsafe(`revoke all privileges on table public.companions from ${roleCase.parent}`);
    }
  });

  it("commits only atomic v2 Companion aggregates while preserving the operator fixture path", async () => {
    if (!runtimeSql) throw new Error("runtime database is not initialized");
    const sql = runtimeSql;
    const atomicCompanionId = randomUUID();
    const missingInstanceId = randomUUID();
    const operatorFixtureId = randomUUID();

    try {
      await sql.begin(async (tx) => {
        await tx.unsafe(`grant insert on table public.companions to ${apiRole}`);
        await tx`select set_config('app.org_id', ${ids.orgA}, true)`;
        await tx`select set_config('app.user_id', ${ids.ownerA}, true)`;
        await tx`select set_config('app.companion_runtime_protocol', '2', true)`;
        await tx.unsafe(`set local role ${apiRole}`);
        await tx`
          insert into companions (id, org_id, owner_id, name)
          values (
            ${atomicCompanionId}::uuid, ${ids.orgA}::uuid, ${ids.ownerA},
            'Atomic Runtime v2 Companion'
          )
        `;
        await tx.unsafe("reset role");
        await tx`
          insert into companion_runtime_instances (
            org_id, companion_id, applied_settings_revision, applied_skills_revision,
            applied_client_surface
          ) values (${ids.orgA}::uuid, ${atomicCompanionId}::uuid, 1, 1, 'web')
        `;
        await tx.unsafe(`revoke insert on table public.companions from ${apiRole}`);
        // The deferred aggregate constraint evaluates under the application role at COMMIT.
        await tx.unsafe(`set local role ${apiRole}`);
      });

      const [atomicAggregate] = await sql<Array<{
        companion: boolean;
        instance: boolean;
        lease: boolean;
      }>>`
        select
          exists(select 1 from companions where id = ${atomicCompanionId}::uuid) as companion,
          exists(select 1 from companion_runtime_instances where companion_id = ${atomicCompanionId}::uuid)
            as instance,
          exists(select 1 from companion_runtime_leases where companion_id = ${atomicCompanionId}::uuid)
            as lease
      `;
      expect(atomicAggregate).toEqual({ companion: true, instance: true, lease: true });

      await expect(sql.begin(async (tx) => {
        await tx.unsafe(`grant insert on table public.companions to ${apiRole}`);
        await tx`select set_config('app.org_id', ${ids.orgA}, true)`;
        await tx`select set_config('app.user_id', ${ids.ownerA}, true)`;
        await tx`select set_config('app.companion_runtime_protocol', '2', true)`;
        await tx.unsafe(`set local role ${apiRole}`);
        await tx`
          insert into companions (id, org_id, owner_id, name)
          values (
            ${missingInstanceId}::uuid, ${ids.orgA}::uuid, ${ids.ownerA},
            'Missing Runtime v2 instance'
          )
        `;
      })).rejects.toThrow(/requires an atomic runtime instance/);
      const [missingAggregate] = await sql<Array<{ count: number }>>`
        select count(*)::int as count from companions where id = ${missingInstanceId}::uuid
      `;
      expect(missingAggregate).toEqual({ count: 0 });

      // The real table owner keeps the documented escape hatch for migrations and test fixtures.
      await sql`
        insert into companions (id, org_id, owner_id, name)
        values (
          ${operatorFixtureId}::uuid, ${ids.orgA}::uuid, ${ids.ownerA},
          'Operator-only fixture'
        )
      `;
      const [operatorFixture] = await sql<Array<{ count: number }>>`
        select count(*)::int as count from companions where id = ${operatorFixtureId}::uuid
      `;
      expect(operatorFixture).toEqual({ count: 1 });
    } finally {
      await sql`delete from companion_runtime_leases where companion_id = ${atomicCompanionId}::uuid`;
      await sql`delete from companion_runtime_instances where companion_id = ${atomicCompanionId}::uuid`;
      await sql`
        delete from companions
        where id in (${atomicCompanionId}::uuid, ${missingInstanceId}::uuid, ${operatorFixtureId}::uuid)
      `;
    }
  });

  it("rejects Companion-token provenance permanently without blocking ordinary API tokens", async () => {
    if (!runtimeSql) throw new Error("runtime database is not initialized");
    const sql = runtimeSql;
    const humanTokenId = randomUUID();
    const companionTokenId = randomUUID();
    const rejectedTokenId = randomUUID();
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000);

    const asApi = <T>(action: (tx: Tx) => Promise<T>) => asRole(apiRole, async (tx) => {
      await tx`select set_config('app.org_id', ${ids.orgA}, true)`;
      await tx`select set_config('app.user_id', ${ids.ownerA}, true)`;
      return action(tx);
    });

    try {
      await asApi((tx) => tx`
        insert into api_tokens (
          id, org_id, user_id, name, token_prefix, token_hash, scopes, source_type, expires_at
        ) values (
          ${humanTokenId}::uuid, ${ids.orgA}::uuid, ${ids.ownerA}, 'Human PAT',
          'cmp_pat_human', ${`human-${suffix}`}, '[]'::jsonb, 'human', ${expiresAt}
        )
      `);
      await asApi((tx) => tx`
        update api_tokens set source_type = 'human', name = 'Updated human PAT'
        where id = ${humanTokenId}::uuid
      `);

      await expect(asApi((tx) => tx`
        insert into api_tokens (
          id, org_id, user_id, name, token_prefix, token_hash, scopes,
          source_type, source_agent_id, expires_at
        ) values (
          ${rejectedTokenId}::uuid, ${ids.orgA}::uuid, ${ids.ownerA}, 'Rejected Companion PAT',
          'cmp_pat_rejected', ${`rejected-${suffix}`}, '[]'::jsonb,
          'companion', ${ids.companionA}, ${expiresAt}
        )
      `)).rejects.toThrow(/api_tokens_source_provenance_check/);
      await expect(asApi((tx) => tx`
        update api_tokens
        set source_type = 'companion', source_agent_id = ${ids.companionA}
        where id = ${humanTokenId}::uuid
      `)).rejects.toThrow(/api_tokens_source_provenance_check/);

      // The final data constraint has no migration-owner escape hatch: legacy Pi bearer tokens
      // cannot be recreated after the one-shot purge.
      await expect(sql`
        insert into api_tokens (
          id, org_id, user_id, name, token_prefix, token_hash, scopes,
          source_type, source_agent_id, expires_at
        ) values (
          ${companionTokenId}::uuid, ${ids.orgA}::uuid, ${ids.ownerA}, 'Legacy Companion PAT',
          'cmp_pat_companion', ${`companion-${suffix}`}, '[]'::jsonb,
          'companion', ${ids.companionA}, ${expiresAt}
        )
      `).rejects.toThrow(/api_tokens_source_provenance_check/);

      await asApi((tx) => tx`delete from api_tokens where id = ${humanTokenId}::uuid`);
      const [tokens] = await sql<Array<{ human: number; companion: number; rejected: number }>>`
        select
          count(*) filter (where id = ${humanTokenId}::uuid)::int as human,
          count(*) filter (where id = ${companionTokenId}::uuid)::int as companion,
          count(*) filter (where id = ${rejectedTokenId}::uuid)::int as rejected
        from api_tokens
      `;
      expect(tokens).toEqual({ human: 0, companion: 0, rejected: 0 });
    } finally {
      await sql`
        delete from api_tokens
        where id in (${humanTokenId}::uuid, ${companionTokenId}::uuid, ${rejectedTokenId}::uuid)
      `;
    }
  });

  it("accepts delete only as an explicit user-triggered destructive operation", async () => {
    if (!runtimeSql) throw new Error("runtime database is not initialized");
    for (const trigger of ["recovery", "turn", "settings", "kill_switch"] as const) {
      await expect(insertOperation({
        companionId: ids.companionA,
        kind: "delete",
        trigger,
      })).rejects.toThrow(/companion_operations_explicit_destructive_trigger_check/);
    }

    const operationId = await insertOperation({
      companionId: ids.companionA,
      kind: "delete",
      trigger: "user",
    });
    const [operation] = await runtimeSql<Array<{ kind: string; trigger: string; status: string }>>`
      select kind::text, trigger::text, status::text
      from companion_operations where id = ${operationId}::uuid
    `;
    expect(operation).toEqual({ kind: "delete", trigger: "user", status: "pending" });
  });

  it("keeps all nine runtime tables private and applies repeatable exact three-role grants", async () => {
    if (!runtimeSql) throw new Error("runtime database is not initialized");
    await runtimeSql.unsafe("reset companion.companion_runtime_role");

    const rls = await runtimeSql<Array<{
      table: string;
      enabled: boolean;
      forced: boolean;
    }>>`
      select c.relname as table, c.relrowsecurity as enabled, c.relforcerowsecurity as forced
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname = any(${[...runtimeTables]}::text[])
      order by c.relname
    `;
    expect(rls).toHaveLength(runtimeTables.length);
    expect(rls.every((row) => row.enabled && row.forced)).toBe(true);

    const roleRows = await runtimeSql<Array<{
      role: string;
      login: boolean;
      superuser: boolean;
      bypassRls: boolean;
      inherit: boolean;
    }>>`
      select rolname as role, rolcanlogin as login, rolsuper as superuser,
             rolbypassrls as "bypassRls", rolinherit as inherit
      from pg_roles
      where rolname = any(${[apiRole, workerRole, executorRole]}::text[])
      order by rolname
    `;
    expect(roleRows).toHaveLength(3);
    for (const role of roleRows) {
      expect(role).toMatchObject({ login: true, superuser: false, bypassRls: false, inherit: false });
    }
    for (const role of [apiRole, workerRole, executorRole]) {
      for (const peer of [apiRole, workerRole, executorRole]) {
        if (role === peer) continue;
        const [membership] = await runtimeSql<Array<{ member: boolean; canSet: boolean }>>`
          select pg_has_role(${role}, ${peer}, 'MEMBER') as member,
                 pg_has_role(${role}, ${peer}, 'SET') as "canSet"
        `;
        expect(membership).toEqual({ member: false, canSet: false });
      }
    }

    const before = await aclSnapshot([apiRole, workerRole, executorRole, "public"]);
    await applySplitRuntimeGrants();
    expect(await aclSnapshot([apiRole, workerRole, executorRole, "public"])).toEqual(before);

    // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- legacy pattern predating the incremental anti-slop gate
    const split = before as {
      // oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- legacy pattern predating the incremental anti-slop gate
      tables: Array<Record<string, unknown>>;
      functions: Array<{ role: string; signature: string; oid: string | null; execute: boolean | null }>;
      sequences: Array<{ role: string; usage: boolean; select: boolean }>;
    };
    expect(split.tables.every((entry) =>
      entry.select === false && entry.insert === false
      && entry.update === false && entry.delete === false)).toBe(true);
    expect(split.sequences.every((entry) => !entry.usage && !entry.select)).toBe(true);
    expect(split.functions.every((entry) => entry.oid !== null)).toBe(true);
    for (const signature of runtimeFunctionSignatures) {
      expect(split.functions.find((entry) =>
        entry.role === executorRole && entry.signature === signature)?.execute).toBe(true);
      for (const deniedRole of [apiRole, workerRole, "public"]) {
        expect(split.functions.find((entry) =>
          entry.role === deniedRole && entry.signature === signature)?.execute).toBe(false);
      }
    }
    for (const signature of companionApiFunctionSignatures) {
      expect(split.functions.find((entry) =>
        entry.role === apiRole && entry.signature === signature)?.execute).toBe(true);
      for (const deniedRole of [workerRole, executorRole, "public"]) {
        expect(split.functions.find((entry) =>
          entry.role === deniedRole && entry.signature === signature)?.execute).toBe(false);
      }
    }
    for (const role of [apiRole, workerRole, executorRole, "public"]) {
      expect(split.functions.find((entry) =>
        entry.role === role && entry.signature === enableFunctionSignature)?.execute).toBe(false);
      for (const signature of runtimeHelperFunctionSignatures) {
        expect(split.functions.find((entry) =>
          entry.role === role && entry.signature === signature)?.execute).toBe(false);
      }
    }

    const configs = await runtimeSql<Array<{ signature: string; config: string[] | null }>>`
      select p.oid::regprocedure::text as signature, p.proconfig as config
      from pg_proc p
      where p.oid = any(${[...runtimeFunctionSignatures]}::regprocedure[])
      order by p.oid::regprocedure::text
    `;
    expect(configs).toHaveLength(runtimeFunctionSignatures.length);
    // Custom GUC proconfig requires a deployment-specific SET privilege from a non-superuser
    // migration owner. Runtime authorization is entirely token/epoch/ACL fenced; the diagnostic
    // protocol marker is set locally only around the proven aggregate delete that needs it.
    expect(configs.every((row) =>
      !row.config?.includes("app.companion_runtime_protocol=2")))
      .toBe(true);

    await expect(asRole(apiRole, (tx) => tx`
      select * from companion_runtime_claim_work('api', 1, 30, 1)
    `)).rejects.toThrow(/permission denied/);
    await expect(asRole(workerRole, (tx) => tx`
      select * from companion_runtime_gate_status()
    `)).rejects.toThrow(/permission denied/);
    await expect(asRole(executorRole, (tx) => tx`
      select * from companion_runtime_enable(1, 'runtime')
    `)).rejects.toThrow(/permission denied/);
    await expect(asRole(executorRole, (tx) => tx`
      select * from companion_resolve_api_token('missing')
    `)).rejects.toThrow(/permission denied/);
    await expect(asRole(apiRole, (tx) => tx`
      insert into companion_runtime_leases (org_id, companion_id)
      values (${ids.orgA}::uuid, ${ids.companionA}::uuid)
    `)).rejects.toThrow(/permission denied/);
    await expect(asRole(workerRole, (tx) => tx`
      delete from companion_operations where false
    `)).rejects.toThrow(/permission denied/);
    await expect(asRole(executorRole, (tx) => tx`
      update companion_runtime_instances set updated_at = now() where false
    `)).rejects.toThrow(/permission denied/);
  });

  it("fails closed when the Runtime v2 sentinel exists but its function set is incomplete", async () => {
    if (!runtimeSql) throw new Error("runtime database is not initialized");
    const roles = [apiRole, workerRole, executorRole, "public"];
    const before = await aclSnapshot(roles);
    const grants = extractRuntimeRoleGrantBlock(
      await readFile(await resolveRuntimeRoleGrantsFile(), "utf8"),
    );

    await expect(runtimeSql.begin(async (tx) => {
      await tx`select set_config('companion.api_role', ${apiRole}, true)`;
      await tx`select set_config('companion.worker_role', ${workerRole}, true)`;
      await tx`select set_config('companion.companion_runtime_role', ${executorRole}, true)`;
      await tx.unsafe(`
        drop function public.companion_runtime_release_lease(
          uuid, uuid, uuid, bigint, bigint, text,
          public.companion_runtime_work_kind, uuid
        )
      `);
      await tx.unsafe(grants);
    })).rejects.toThrow(/companion_runtime_release_lease.*does not exist/i);

    const releaseSignature = runtimeFunctionSignatures[runtimeFunctionSignatures.length - 1]!;
    const [restored] = await runtimeSql<Array<{ signature: string | null }>>`
      select to_regprocedure(${releaseSignature})::text as signature
    `;
    expect(restored?.signature).not.toBeNull();
    expect(await aclSnapshot(roles)).toEqual(before);
  });

  it("orders durable work, preserves enqueue idempotence, and enforces active-row cardinality", async () => {
    if (!runtimeSql) throw new Error("runtime database is not initialized");
    const gate = await gateStatus();
    const startId = await insertOperation({ companionId: ids.companionA, kind: "start" });
    const deleteId = await insertOperation({ companionId: ids.companionA, kind: "delete" });

    const [first] = await claimWork("priority-replica", gate.gateEpoch);
    expect(first).toMatchObject({
      companionId: ids.companionA,
      workKind: "operation",
      workId: deleteId,
      operationKind: "delete",
      checkpoint: "pending",
      checkpointSequence: 0,
    });
    expect(await claimWork("duplicate-replica", gate.gateEpoch)).toEqual([]);
    expect(await releaseLease(first!, "priority-replica")).toBe(true);

    const [reclaimed] = await claimWork("priority-takeover", gate.gateEpoch);
    expect(reclaimed).toMatchObject({ workId: deleteId, claimEpoch: first!.claimEpoch + 1 });
    expect(reclaimed!.claimToken).not.toBe(first!.claimToken);
    await settle(reclaimed!, "priority-takeover", "failed");

    const operationRows = await runtimeSql<Array<{
      id: string;
      status: string;
      attemptCount: number;
    }>>`
      select id::text, status::text, attempt_count::int as "attemptCount"
      from companion_operations where companion_id = ${ids.companionA}::uuid order by kind
    `;
    expect(operationRows).toEqual(expect.arrayContaining([
      { id: deleteId, status: "failed", attemptCount: 2 },
      { id: startId, status: "cancelled", attemptCount: 0 },
    ]));

    const requestId = randomUUID();
    await insertOperation({ companionId: ids.companionB, requestId });
    await expect(insertOperation({ companionId: ids.companionB, requestId }))
      .rejects.toThrow(/companion_operations_request_uq/);

    const pendingOne = await insertOperation({ companionId: ids.companionC });
    const pendingTwo = await insertOperation({ companionId: ids.companionC });
    await runtimeSql`
      update companion_operations set status = 'running'
      where id = ${pendingOne}::uuid
    `;
    await expect(runtimeSql`
      update companion_operations set status = 'running'
      where id = ${pendingTwo}::uuid
    `).rejects.toThrow(/companion_operations_one_running_uq/);

    const active = await insertActiveTurnAttempt({ companionId: ids.companionB });
    const secondAttemptId = randomUUID();
    await expect(runtimeSql`
      insert into companion_turn_attempts (
        id, org_id, companion_id, turn_id, attempt_number, actor_id,
        runtime_generation, settings_revision, skills_revision, model_id,
        provider_ids, selected_skill_ids, selected_mcp_account_ids
      ) values (
        ${secondAttemptId}::uuid, ${ids.orgA}::uuid, ${ids.companionB}::uuid,
        ${active.turnId}::uuid, 2, ${ids.ownerA}, 1, 1, 1, ${modelId},
        ${runtimeSql.json([providerId])}, ${runtimeSql.json([ids.ownerSkill])}, '[]'::jsonb
      )
    `).rejects.toThrow(/companion_turn_attempts_one_active_uq/);
    await expect(insertActiveTurnAttempt({ companionId: ids.companionB }))
      .rejects.toThrow(/companion_turns_one_active_uq/);

    const queuedOne = await insertQueuedTurn({ companionId: ids.companionC });
    const queuedTwo = await insertQueuedTurn({ companionId: ids.companionC });
    const queueRows = await runtimeSql<Array<{ id: string; sequence: number }>>`
      select id::text, queue_sequence::int as sequence from companion_turns
      where id in (${queuedOne}::uuid, ${queuedTwo}::uuid) order by queue_sequence
    `;
    expect(queueRows.map((row) => row.id)).toEqual([queuedOne, queuedTwo]);
    expect(queueRows[1]!.sequence).toBe(queueRows[0]!.sequence + 1);
  });

  it("lets replicas race once, preempts running lower-priority work, and fences a stale takeover", async () => {
    if (!runtimeSql) throw new Error("runtime database is not initialized");
    let gate = await gateStatus();
    const operationB = await insertOperation({ companionId: ids.companionB });
    const operationC = await insertOperation({ companionId: ids.companionC });
    const [replicaOne, replicaTwo] = await Promise.all([
      claimWork("replica-one", gate.gateEpoch),
      claimWork("replica-two", gate.gateEpoch),
    ]);
    const raced = [replicaOne[0], replicaTwo[0]].filter((claim): claim is Claim => Boolean(claim));
    expect(raced).toHaveLength(2);
    expect(new Set(raced.map((claim) => claim.workId))).toEqual(new Set([operationB, operationC]));
    expect(new Set(raced.map((claim) => claim.companionId)).size).toBe(2);
    expect(await claimWork("replica-three", gate.gateEpoch)).toEqual([]);
    const raceRows = await runtimeSql<Array<{ id: string; attempts: number }>>`
      select id::text, attempt_count::int as attempts from companion_operations
      where id in (${operationB}::uuid, ${operationC}::uuid) order by id
    `;
    expect(raceRows.every((row) => row.attempts === 1)).toBe(true);
    await Promise.all(raced.map((claim) => settle(
      claim,
      claim === replicaOne[0] ? "replica-one" : "replica-two",
      "failed",
    )));

    await resetWork();
    gate = await gateStatus();
    const startId = await insertOperation({ companionId: ids.companionA, kind: "start" });
    const [startClaim] = await claimWork("start-replica", gate.gateEpoch);
    expect(startClaim?.workId).toBe(startId);
    const deleteId = await insertOperation({ companionId: ids.companionA, kind: "delete" });
    const [preemptedAuthorization] = await renewAndAuthorize(startClaim!, "start-replica");
    expect(preemptedAuthorization).toMatchObject({
      authorized: false,
      denialCode: "higher_priority_work_pending",
      authorizationActorId: null,
      modelId: null,
      providerRefs: [],
      skillRefs: [],
      mcpRefs: [],
    });
    expect(await releaseLease(startClaim!, "start-replica")).toBe(true);
    const [deleteClaim] = await claimWork("delete-replica", gate.gateEpoch);
    expect(deleteClaim?.workId).toBe(deleteId);
    const [preemptedStart] = await runtimeSql<Array<{
      status: string;
      code: string | null;
      message: string | null;
    }>>`
      select status::text, last_error_code as code, last_error_message as message
      from companion_operations where id = ${startId}::uuid
    `;
    expect(preemptedStart).toEqual({
      status: "interrupted",
      code: "superseded_by_higher_priority",
      message: "A higher-priority runtime operation superseded this operation.",
    });
    await settle(deleteClaim!, "delete-replica", "failed");

    await resetWork();
    gate = await gateStatus();
    const takeoverId = await insertOperation({ companionId: ids.companionA });
    const [oldClaim] = await claimWork("old-replica", gate.gateEpoch);
    expect(oldClaim?.workId).toBe(takeoverId);
    expect(await claimWork("new-replica", gate.gateEpoch)).toEqual([]);
    await runtimeSql`
      update companion_runtime_leases
      set renewed_at = now() - interval '2 seconds', expires_at = now() - interval '1 second'
      where companion_id = ${ids.companionA}::uuid
    `;
    const [newClaim] = await claimWork("new-replica", gate.gateEpoch);
    expect(newClaim).toMatchObject({ workId: takeoverId, claimEpoch: oldClaim!.claimEpoch + 1 });
    expect(newClaim!.claimToken).not.toBe(oldClaim!.claimToken);
    expect(await renewAndAuthorize(oldClaim!, "old-replica")).toEqual([]);
    expect(await checkpoint(oldClaim!, "old-replica", "stopping_pi")).toBeNull();
    expect(await settle(oldClaim!, "old-replica", "failed")).toBe(false);
    const [stillRunning] = await runtimeSql<Array<{ status: string; claimEpoch: number }>>`
      select status::text, claim_epoch::int as "claimEpoch"
      from companion_operations where id = ${takeoverId}::uuid
    `;
    expect(stillRunning).toEqual({ status: "running", claimEpoch: newClaim!.claimEpoch });
    expect(await settle(newClaim!, "new-replica", "failed")).toBe(true);
  });

  it("terminalizes a cold-start source before Stop or restart-Pi supersedes its start", async () => {
    if (!runtimeSql) throw new Error("runtime database is not initialized");
    const variants = [
      {
        kind: "stop" as const,
        executorId: "cold-start-stop",
        boxId: "bx_6789abcd",
        sourceMessage: "The Companion was stopped before this turn completed.",
      },
      {
        kind: "restart_pi" as const,
        executorId: "cold-start-restart-pi",
        boxId: "bx_789abcde",
        sourceMessage: "The Companion runtime restarted before this turn completed.",
      },
    ];

    for (const variant of variants) {
      await resetWork();
      const gate = await gateStatus();
      await runtimeSql`
        update companion_runtime_instances
        set box_id = ${variant.boxId}, box_state = 'ready', pi_state = 'idle',
            pi_invocation_id = 'pi-cold-start-preemption', disk_layout_version = 14
        where companion_id = ${ids.companionA}::uuid
      `;
      const sourceTurnId = await insertQueuedTurn({ companionId: ids.companionA });
      const startId = await insertOperation({
        companionId: ids.companionA,
        kind: "start",
        trigger: "turn",
        sourceTurnId,
      });
      const [startClaim] = await claimWork(`${variant.executorId}-start`, gate.gateEpoch);
      expect(startClaim).toMatchObject({
        workKind: "operation",
        workId: startId,
        operationKind: "start",
      });
      const [beforePreemption] = await runtimeSql<Array<{
        operationStatus: string;
        sourceStatus: string;
        sourceDeadline: Date | null;
      }>>`
        select o.status::text as "operationStatus", t.status::text as "sourceStatus",
               t.absolute_deadline_at as "sourceDeadline"
        from companion_operations o join companion_turns t on t.id = o.source_turn_id
        where o.id = ${startId}::uuid
      `;
      expect(beforePreemption).toEqual({
        operationStatus: "running",
        sourceStatus: "queued",
        sourceDeadline: null,
      });

      const lifecycleId = await insertOperation({
        companionId: ids.companionA,
        kind: variant.kind,
      });
      expect(await releaseLease(startClaim!, `${variant.executorId}-start`)).toBe(true);
      const [lifecycleClaim] = await claimWork(variant.executorId, gate.gateEpoch);
      expect(lifecycleClaim).toMatchObject({
        workKind: "operation",
        workId: lifecycleId,
        operationKind: variant.kind,
      });

      const [preempted] = await runtimeSql<Array<{
        startStatus: string;
        startCode: string | null;
        startAction: string | null;
        startSettledAt: Date | null;
        sourceStatus: string;
        sourceCode: string | null;
        sourceMessage: string | null;
        sourceAction: string | null;
        sourceInactivityDeadline: Date | null;
        sourceAbsoluteDeadline: Date | null;
        sourceStateChangedAt: Date;
        sourceSettledAt: Date | null;
        attemptCount: number;
      }>>`
        select start.status::text as "startStatus", start.last_error_code as "startCode",
               start.last_error_action::text as "startAction",
               start.settled_at as "startSettledAt",
               source.status::text as "sourceStatus", source.last_error_code as "sourceCode",
               source.last_error_message as "sourceMessage",
               source.last_error_action::text as "sourceAction",
               source.inactivity_deadline_at as "sourceInactivityDeadline",
               source.absolute_deadline_at as "sourceAbsoluteDeadline",
               source.state_changed_at as "sourceStateChangedAt",
               source.settled_at as "sourceSettledAt",
               (select count(*)::int from companion_turn_attempts attempt
                where attempt.turn_id = source.id) as "attemptCount"
        from companion_operations start
        join companion_turns source on source.id = start.source_turn_id
        where start.id = ${startId}::uuid
      `;
      expect(preempted).toMatchObject({
        startStatus: "interrupted",
        startCode: "superseded_by_higher_priority",
        startAction: "none",
        sourceStatus: "interrupted",
        sourceCode: "runtime_lifecycle_preempted",
        sourceMessage: variant.sourceMessage,
        sourceAction: "retry",
        sourceInactivityDeadline: null,
        attemptCount: 0,
      });
      expect(preempted?.startSettledAt).toBeInstanceOf(Date);
      expect(preempted?.sourceAbsoluteDeadline).toBeInstanceOf(Date);
      expect(preempted?.sourceSettledAt).toBeInstanceOf(Date);
      expect(preempted?.sourceStateChangedAt.getTime())
        .toBe(preempted?.sourceSettledAt?.getTime());
      expect(preempted?.sourceAbsoluteDeadline?.getTime())
        .toBe(preempted?.sourceSettledAt?.getTime());

      if (variant.kind === "stop") {
        expect(await checkpoint(lifecycleClaim!, variant.executorId, "stopping_pi")).toBe(1);
        expect(await checkpoint(lifecycleClaim!, variant.executorId, "provider_stop_requested", {
          expectedSequence: 1,
        })).toBe(2);
        expect(await checkpoint(lifecycleClaim!, variant.executorId, "waiting_archived", {
          expectedSequence: 2,
        })).toBe(3);
        expect(await observeInstance(lifecycleClaim!, variant.executorId, {
          expectedSequence: 3,
          boxId: variant.boxId,
          boxState: "archived",
          piState: "stopped",
        })).toBe(4);
        expect(await settle(lifecycleClaim!, variant.executorId, "succeeded")).toBe(true);
        const [stopped] = await runtimeSql<Array<{
          status: string;
          checkpoint: string;
          boxState: string;
        }>>`
          select o.status::text, o.checkpoint, i.box_state::text as "boxState"
          from companion_operations o join companion_runtime_instances i
            on i.org_id = o.org_id and i.companion_id = o.companion_id
          where o.id = ${lifecycleId}::uuid
        `;
        expect(stopped).toEqual({
          status: "succeeded",
          checkpoint: "box_archived",
          boxState: "archived",
        });
      } else {
        expect(await settle(lifecycleClaim!, variant.executorId, "failed")).toBe(true);
      }

      const [sourceAfterLifecycle] = await runtimeSql<Array<{
        status: string;
        attemptCount: number;
      }>>`
        select source.status::text,
               (select count(*)::int from companion_turn_attempts attempt
                where attempt.turn_id = source.id) as "attemptCount"
        from companion_turns source where source.id = ${sourceTurnId}::uuid
      `;
      expect(sourceAfterLifecycle).toEqual({ status: "interrupted", attemptCount: 0 });
      expect(await claimWork(`${variant.executorId}-source-probe`, gate.gateEpoch)).toEqual([]);
    }
  });

  it("uses a Stop queue cutoff to fence old sends while preserving later sends", async () => {
    if (!runtimeSql) throw new Error("runtime database is not initialized");
    const gate = await gateStatus();
    const boxId = "bx_89abcdef";
    await runtimeSql`
      update companion_runtime_instances
      set box_id = ${boxId}, box_state = 'ready', pi_state = 'idle',
          pi_invocation_id = 'pi-cutoff-stop', disk_layout_version = 14
      where companion_id = ${ids.companionA}::uuid
    `;

    const oldTurnId = await insertQueuedTurn({ companionId: ids.companionA });
    const oldStartId = await insertOperation({
      companionId: ids.companionA,
      kind: "start",
      trigger: "turn",
      sourceTurnId: oldTurnId,
    });
    const stopId = await insertOperation({ companionId: ids.companionA, kind: "stop" });
    const laterTurnId = await insertQueuedTurn({ companionId: ids.companionA });
    const laterStartId = await insertOperation({
      companionId: ids.companionA,
      kind: "start",
      trigger: "turn",
      sourceTurnId: laterTurnId,
    });

    const operationOrder = await runtimeSql<Array<{
      id: string;
      queueSequence: number;
      turnQueueCutoff: number;
    }>>`
      select id::text, queue_sequence::int as "queueSequence",
             turn_queue_cutoff::int as "turnQueueCutoff"
      from companion_operations
      where id in (${oldStartId}::uuid, ${stopId}::uuid, ${laterStartId}::uuid)
      order by queue_sequence
    `;
    expect(operationOrder).toEqual([
      { id: oldStartId, queueSequence: 1, turnQueueCutoff: 1 },
      { id: stopId, queueSequence: 2, turnQueueCutoff: 1 },
      { id: laterStartId, queueSequence: 3, turnQueueCutoff: 2 },
    ]);
    const turnOrder = await runtimeSql<Array<{ id: string; queueSequence: number }>>`
      select id::text, queue_sequence::int as "queueSequence"
      from companion_turns where id in (${oldTurnId}::uuid, ${laterTurnId}::uuid)
      order by queue_sequence
    `;
    expect(turnOrder).toEqual([
      { id: oldTurnId, queueSequence: 1 },
      { id: laterTurnId, queueSequence: 2 },
    ]);

    const [stopClaim] = await claimWork("pre-sweep-stop", gate.gateEpoch);
    expect(stopClaim).toMatchObject({
      workKind: "operation",
      workId: stopId,
      operationKind: "stop",
    });
    const preempted = await runtimeSql<Array<{
      operationId: string;
      operationStatus: string;
      turnId: string;
      turnStatus: string;
      turnCode: string | null;
      absoluteDeadlineAt: Date | null;
      settledAt: Date | null;
      attemptCount: number;
    }>>`
      select operation.id::text as "operationId", operation.status::text as "operationStatus",
             source.id::text as "turnId", source.status::text as "turnStatus",
             source.last_error_code as "turnCode",
             source.absolute_deadline_at as "absoluteDeadlineAt",
             source.settled_at as "settledAt",
             (select count(*)::int from companion_turn_attempts attempt
              where attempt.turn_id = source.id) as "attemptCount"
      from companion_operations operation
      join companion_turns source on source.id = operation.source_turn_id
      where operation.id in (${oldStartId}::uuid, ${laterStartId}::uuid)
      order by operation.queue_sequence
    `;
    expect(preempted[0]).toMatchObject({
      operationId: oldStartId,
      operationStatus: "interrupted",
      turnId: oldTurnId,
      turnStatus: "interrupted",
      turnCode: "runtime_lifecycle_preempted",
      attemptCount: 0,
    });
    expect(preempted[0]?.absoluteDeadlineAt).toBeInstanceOf(Date);
    expect(preempted[0]?.settledAt).toBeInstanceOf(Date);
    expect(preempted[1]).toEqual({
      operationId: laterStartId,
      operationStatus: "pending",
      turnId: laterTurnId,
      turnStatus: "queued",
      turnCode: null,
      absoluteDeadlineAt: null,
      settledAt: null,
      attemptCount: 0,
    });

    expect(await checkpoint(stopClaim!, "pre-sweep-stop", "stopping_pi")).toBe(1);
    expect(await checkpoint(stopClaim!, "pre-sweep-stop", "provider_stop_requested", {
      expectedSequence: 1,
    })).toBe(2);
    expect(await checkpoint(stopClaim!, "pre-sweep-stop", "waiting_archived", {
      expectedSequence: 2,
    })).toBe(3);
    expect(await observeInstance(stopClaim!, "pre-sweep-stop", {
      expectedSequence: 3,
      boxId,
      boxState: "archived",
      piState: "stopped",
    })).toBe(4);
    expect(await settle(stopClaim!, "pre-sweep-stop", "succeeded")).toBe(true);

    const [nextClaim] = await claimWork("post-stop-send", gate.gateEpoch);
    expect(nextClaim).toMatchObject({
      workKind: "operation",
      workId: laterStartId,
      operationKind: "start",
    });
    const [oldSourceAfterArchive] = await runtimeSql<Array<{
      status: string;
      attemptCount: number;
    }>>`
      select source.status::text,
             (select count(*)::int from companion_turn_attempts attempt
              where attempt.turn_id = source.id) as "attemptCount"
      from companion_turns source where source.id = ${oldTurnId}::uuid
    `;
    expect(oldSourceAfterArchive).toEqual({ status: "interrupted", attemptCount: 0 });
    expect(await settle(nextClaim!, "post-stop-send", "failed", {
      errorCode: "post_stop_fixture_complete",
      errorMessage: "The post-Stop send survived its ordering barrier.",
      errorAction: "retry",
    })).toBe(true);
  });

  it("terminalizes the queued source turn when a cold-start operation fails", async () => {
    if (!runtimeSql) throw new Error("runtime database is not initialized");
    const gate = await gateStatus();
    const sourceTurnId = await insertQueuedTurn({ companionId: ids.companionA });
    const operationId = await insertOperation({
      companionId: ids.companionA,
      kind: "start",
      trigger: "turn",
      sourceTurnId,
    });
    const [claim] = await claimWork("cold-start-failure", gate.gateEpoch);
    expect(claim).toMatchObject({
      workKind: "operation",
      workId: operationId,
      operationKind: "start",
    });

    const error = {
      errorCode: "box_provision_failed",
      errorMessage: "The Box provider rejected the cold start.",
      errorAction: "retry",
    };
    expect(await settle(claim!, "cold-start-failure", "failed", error)).toBe(true);
    expect(await claimWork("orphan-probe", gate.gateEpoch)).toEqual([]);

    const [terminal] = await runtimeSql<Array<{
      operationStatus: string;
      operationCode: string | null;
      operationMessage: string | null;
      operationAction: string | null;
      operationSettledAt: Date;
      turnStatus: string;
      turnCode: string | null;
      turnMessage: string | null;
      turnAction: string | null;
      inactivityDeadlineAt: Date | null;
      absoluteDeadlineAt: Date | null;
      stateChangedAt: Date;
      turnSettledAt: Date;
    }>>`
      select o.status::text as "operationStatus", o.last_error_code as "operationCode",
             o.last_error_message as "operationMessage",
             o.last_error_action::text as "operationAction",
             o.settled_at as "operationSettledAt",
             t.status::text as "turnStatus", t.last_error_code as "turnCode",
             t.last_error_message as "turnMessage", t.last_error_action::text as "turnAction",
             t.inactivity_deadline_at as "inactivityDeadlineAt",
             t.absolute_deadline_at as "absoluteDeadlineAt",
             t.state_changed_at as "stateChangedAt", t.settled_at as "turnSettledAt"
      from companion_operations o
      join companion_turns t on t.id = o.source_turn_id
      where o.id = ${operationId}::uuid
    `;
    expect(terminal).toMatchObject({
      operationStatus: "failed",
      operationCode: error.errorCode,
      operationMessage: error.errorMessage,
      operationAction: error.errorAction,
      turnStatus: "failed",
      turnCode: error.errorCode,
      turnMessage: error.errorMessage,
      turnAction: error.errorAction,
      inactivityDeadlineAt: null,
    });
    expect(terminal?.absoluteDeadlineAt).toBeInstanceOf(Date);
    expect(terminal?.operationSettledAt).toBeInstanceOf(Date);
    expect(terminal?.stateChangedAt).toBeInstanceOf(Date);
    expect(terminal?.turnSettledAt).toBeInstanceOf(Date);
    expect(terminal?.absoluteDeadlineAt?.getTime()).toBe(terminal?.turnSettledAt.getTime());
    expect(terminal?.stateChangedAt.getTime()).toBe(terminal?.turnSettledAt.getTime());
    expect(terminal?.operationSettledAt.getTime()).toBe(terminal?.turnSettledAt.getTime());
  });

  it("terminalizes a cold-start source turn on disable and requires an explicit retry", async () => {
    if (!runtimeSql) throw new Error("runtime database is not initialized");
    const gate = await gateStatus();
    const sourceTurnId = await insertQueuedTurn({ companionId: ids.companionA });
    const operationId = await insertOperation({
      companionId: ids.companionA,
      kind: "start",
      trigger: "turn",
      sourceTurnId,
    });
    const [claim] = await claimWork("cold-start-disable", gate.gateEpoch);
    expect(claim).toMatchObject({ workId: operationId, operationKind: "start" });

    const disabled = await disableGate(gate.gateEpoch);
    expect(disabled).toEqual({ enabled: false, gateEpoch: gate.gateEpoch + 1 });
    expect(await claimWork("disabled-source-probe", disabled.gateEpoch)).toEqual([]);

    const [terminal] = await runtimeSql<Array<{
      operationStatus: string;
      operationCode: string | null;
      operationMessage: string | null;
      operationAction: string | null;
      operationSettledAt: Date;
      turnStatus: string;
      turnCode: string | null;
      turnMessage: string | null;
      turnAction: string | null;
      inactivityDeadlineAt: Date | null;
      absoluteDeadlineAt: Date | null;
      stateChangedAt: Date;
      turnSettledAt: Date;
    }>>`
      select o.status::text as "operationStatus", o.last_error_code as "operationCode",
             o.last_error_message as "operationMessage",
             o.last_error_action::text as "operationAction",
             o.settled_at as "operationSettledAt",
             t.status::text as "turnStatus", t.last_error_code as "turnCode",
             t.last_error_message as "turnMessage", t.last_error_action::text as "turnAction",
             t.inactivity_deadline_at as "inactivityDeadlineAt",
             t.absolute_deadline_at as "absoluteDeadlineAt",
             t.state_changed_at as "stateChangedAt", t.settled_at as "turnSettledAt"
      from companion_operations o
      join companion_turns t on t.id = o.source_turn_id
      where o.id = ${operationId}::uuid
    `;
    expect(terminal).toMatchObject({
      operationStatus: "interrupted",
      operationCode: "runtime_gate_disabled",
      operationMessage: "Runtime execution was disabled.",
      operationAction: "retry",
      turnStatus: "interrupted",
      turnCode: "runtime_gate_disabled",
      turnMessage: "Runtime execution was disabled.",
      turnAction: "retry",
      inactivityDeadlineAt: null,
    });
    expect(terminal?.absoluteDeadlineAt).toBeInstanceOf(Date);
    expect(terminal?.operationSettledAt).toBeInstanceOf(Date);
    expect(terminal?.stateChangedAt).toBeInstanceOf(Date);
    expect(terminal?.turnSettledAt).toBeInstanceOf(Date);
    expect(terminal?.absoluteDeadlineAt?.getTime()).toBe(terminal?.turnSettledAt.getTime());
    expect(terminal?.stateChangedAt.getTime()).toBe(terminal?.turnSettledAt.getTime());
    expect(terminal?.operationSettledAt.getTime()).toBe(terminal?.turnSettledAt.getTime());

    const [enabled] = await runtimeSql<Array<GateStatus>>`
      select enabled, gate_epoch::int as "gateEpoch"
      from public.companion_runtime_enable(${disabled.gateEpoch}, 'integration-owner')
    `;
    expect(enabled).toEqual({ enabled: true, gateEpoch: disabled.gateEpoch + 1 });
    expect(await claimWork("reenabled-source-probe", enabled!.gateEpoch)).toEqual([]);

    const retryTurnId = await insertQueuedTurn({ companionId: ids.companionA });
    const retryOperationId = await insertOperation({
      companionId: ids.companionA,
      kind: "start",
      trigger: "turn",
      sourceTurnId: retryTurnId,
    });
    const [retryClaim] = await claimWork("explicit-cold-start-retry", enabled!.gateEpoch);
    expect(retryClaim).toMatchObject({
      workKind: "operation",
      workId: retryOperationId,
    });
    expect(await settle(retryClaim!, "explicit-cold-start-retry", "failed", {
      errorCode: "retry_fixture_complete",
      errorMessage: "Explicit retry was claimed once.",
      errorAction: "retry",
    })).toBe(true);
  });

  it("reclaims an expired Box-create intent and adopts the late deterministic-name result once", async () => {
    if (!runtimeSql) throw new Error("runtime database is not initialized");
    const gate = await gateStatus();
    const sourceTurnId = await insertQueuedTurn({ companionId: ids.companionA });
    const operationId = await insertOperation({
      companionId: ids.companionA,
      kind: "start",
      trigger: "turn",
      sourceTurnId,
    });
    const [claimA] = await claimWork("box-create-intent-a", gate.gateEpoch);
    expect(claimA).toMatchObject({
      workKind: "operation",
      workId: operationId,
      operationKind: "start",
      checkpoint: "pending",
      checkpointSequence: 0,
    });
    expect(await checkpoint(claimA!, "box-create-intent-a", "resolving_box")).toBe(1);
    expect(await observeInstance(claimA!, "box-create-intent-a", {
      expectedSequence: 1,
      boxState: "absent",
      piState: "absent",
    })).toBe(2);
    expect(await checkpoint(claimA!, "box-create-intent-a", "creating_box", {
      expectedSequence: 2,
    })).toBe(3);
    const [leaseBefore] = await runtimeSql<Array<{ claimEpoch: number }>>`
      select claim_epoch::int as "claimEpoch"
      from companion_runtime_leases where companion_id = ${ids.companionA}::uuid
    `;

    await runtimeSql`
      update companion_runtime_leases
      set renewed_at = now() - interval '2 seconds', expires_at = now() - interval '1 second'
      where companion_id = ${ids.companionA}::uuid
    `;
    const [claimB] = await claimWork("box-create-intent-b", gate.gateEpoch);
    expect(claimB).toMatchObject({
      workKind: "operation",
      workId: operationId,
      operationKind: "start",
      checkpoint: "creating_box",
      checkpointSequence: 3,
      claimEpoch: leaseBefore!.claimEpoch + 1,
      operationAttemptCount: 2,
    });

    expect(await observeInstance(claimA!, "box-create-intent-a", {
      expectedSequence: 3,
      boxId: "bx_56789abc",
      boxState: "provisioning",
      piState: "absent",
    })).toBeNull();
    expect(await settle(claimA!, "box-create-intent-a", "succeeded")).toBe(false);

    // The replacement replica lists `Companion <id> g<generation>` before any create attempt. A
    // provider result that became visible after the first replica died is attached through the
    // same fenced observation; replaying that observation cannot create a second durable identity.
    expect(await observeInstance(claimB!, "box-create-intent-b", {
      expectedSequence: 3,
      boxId: "bx_56789abc",
      boxState: "provisioning",
      piState: "absent",
    })).toBe(4);
    expect(await observeInstance(claimB!, "box-create-intent-b", {
      expectedSequence: 3,
      boxId: "bx_56789abc",
      boxState: "provisioning",
      piState: "absent",
    })).toBeNull();

    const [recovered] = await runtimeSql<Array<{
      operationStatus: string;
      checkpoint: string;
      sequence: number;
      operationCode: string | null;
      operationAction: string | null;
      operationSettled: boolean;
      turnStatus: string;
      turnCode: string | null;
      turnSettled: boolean;
      boxId: string | null;
      boxState: string;
      leaseEpoch: number;
      leaseToken: string | null;
      leaseExecutor: string | null;
      leaseWorkKind: string | null;
      leaseWorkId: string | null;
      lastWriteEpoch: number;
    }>>`
      select o.status::text as "operationStatus", o.checkpoint,
             o.checkpoint_sequence::int as sequence, o.last_error_code as "operationCode",
             o.last_error_action::text as "operationAction",
             (o.settled_at is not null) as "operationSettled",
             t.status::text as "turnStatus", t.last_error_code as "turnCode",
             (t.settled_at is not null) as "turnSettled",
             i.box_id as "boxId", i.box_state::text as "boxState",
             l.claim_epoch::int as "leaseEpoch", l.claim_token::text as "leaseToken",
             l.executor_id as "leaseExecutor", l.work_kind::text as "leaseWorkKind",
             l.work_id::text as "leaseWorkId",
             i.last_write_epoch::int as "lastWriteEpoch"
      from companion_operations o
      join companion_turns t on t.id = o.source_turn_id
      join companion_runtime_instances i on i.companion_id = o.companion_id
      join companion_runtime_leases l on l.companion_id = o.companion_id
      where o.id = ${operationId}::uuid
    `;
    expect(recovered).toEqual({
      operationStatus: "running",
      checkpoint: "box_created",
      sequence: 4,
      operationCode: null,
      operationAction: null,
      operationSettled: false,
      turnStatus: "queued",
      turnCode: null,
      turnSettled: false,
      boxId: "bx_56789abc",
      boxState: "provisioning",
      leaseEpoch: leaseBefore!.claimEpoch + 1,
      leaseToken: claimB!.claimToken,
      leaseExecutor: "box-create-intent-b",
      leaseWorkKind: "operation",
      leaseWorkId: operationId,
      lastWriteEpoch: leaseBefore!.claimEpoch + 1,
    });
    expect(await settle(claimB!, "box-create-intent-b", "failed", {
      errorCode: "fixture_complete",
      errorMessage: "The recovered create fixture completed.",
      errorAction: "retry",
    })).toBe(true);
  });

  it("makes Delete resolve a preempted Box-create before proving absence or deleting the found Box", async () => {
    if (!runtimeSql) throw new Error("runtime database is not initialized");
    const variants = [
      { outcome: "stable_absent" as const, executor: "delete-create-absent", boxId: null },
      { outcome: "late_found" as const, executor: "delete-create-late", boxId: "bx_89abcdef" },
      { outcome: "found" as const, executor: "delete-create-found", boxId: "bx_9abcdefg" },
    ];

    for (const variant of variants) {
      await resetWork();
      const gate = await gateStatus();
      const startId = await insertOperation({ companionId: ids.companionA, kind: "start" });
      const [startClaim] = await claimWork(`${variant.executor}-start`, gate.gateEpoch);
      expect(startClaim).toMatchObject({
        workKind: "operation",
        workId: startId,
        operationKind: "start",
      });
      expect(await checkpoint(startClaim!, `${variant.executor}-start`, "resolving_box"))
        .toBe(1);
      expect(await observeInstance(startClaim!, `${variant.executor}-start`, {
        expectedSequence: 1,
        boxState: "absent",
        piState: "absent",
      })).toBe(2);
      expect(await checkpoint(startClaim!, `${variant.executor}-start`, "creating_box", {
        expectedSequence: 2,
      })).toBe(3);

      const deleteId = await insertOperation({ companionId: ids.companionA, kind: "delete" });
      const [preemptedAuthorization] = await renewAndAuthorize(
        startClaim!,
        `${variant.executor}-start`,
      );
      expect(preemptedAuthorization).toMatchObject({
        authorized: false,
        denialCode: "higher_priority_work_pending",
      });
      expect(await releaseLease(startClaim!, `${variant.executor}-start`)).toBe(true);

      const [deleteClaim] = await claimWork(variant.executor, gate.gateEpoch);
      expect(deleteClaim).toMatchObject({
        workKind: "operation",
        workId: deleteId,
        operationKind: "delete",
        checkpoint: "pending",
        checkpointSequence: 0,
      });
      const [preemptedStart] = await runtimeSql<Array<{
        status: string;
        checkpoint: string;
        errorCode: string | null;
      }>>`
        select status::text, checkpoint, last_error_code as "errorCode"
        from companion_operations where id = ${startId}::uuid
      `;
      expect(preemptedStart).toEqual({
        status: "interrupted",
        checkpoint: "creating_box",
        errorCode: "superseded_by_higher_priority",
      });

      await expect(checkpoint(deleteClaim!, variant.executor, "box_absent"))
        .rejects.toThrow(/operation-bound provider absence evidence|invalid operation checkpoint transition/);
      const [deleteStarted] = await runtimeSql<Array<{ updatedAt: Date }>>`
        select updated_at as "updatedAt" from companion_operations where id = ${deleteId}::uuid
      `;
      const observedAt = new Date(Math.max(
        Date.now(),
        new Date(deleteStarted!.updatedAt).getTime() + 1,
      ));

      if (variant.outcome !== "found") {
        // The first exact-name absence is not proof while the preempted create may still become
        // visible. Neither settlement nor a second immediate poll can bypass the durable horizon.
        expect(await observeInstance(deleteClaim!, variant.executor, {
          boxState: "absent",
          piState: "absent",
          observedAt,
        })).toBeNull();
        await runtimeSql`
          update companion_operations
          set updated_at = clock_timestamp() - interval '3 minutes 1 second'
          where id = ${startId}::uuid
        `;
        expect(await observeInstance(deleteClaim!, variant.executor, {
          boxState: "absent",
          piState: "absent",
          observedAt,
        })).toBe(1);
        await expect(settle(deleteClaim!, variant.executor, "succeeded"))
          .rejects.toThrow(/terminal checkpoint proof/);
        expect(await observeInstance(deleteClaim!, variant.executor, {
          expectedSequence: 1,
          boxState: "absent",
          piState: "absent",
          observedAt: new Date(observedAt.getTime() + 1),
        })).toBe(1);
      }

      if (variant.outcome === "stable_absent") {
        await runtimeSql`
          update companion_operations
          set updated_at = clock_timestamp() - interval '31 seconds'
          where id = ${deleteId}::uuid
        `;
        expect(await observeInstance(deleteClaim!, variant.executor, {
          expectedSequence: 1,
          boxState: "absent",
          piState: "absent",
          observedAt: new Date(observedAt.getTime() + 2),
        })).toBe(2);
      } else {
        const attachmentSequence = variant.outcome === "late_found" ? 1 : 0;
        expect(await observeInstance(deleteClaim!, variant.executor, {
          expectedSequence: attachmentSequence,
          boxId: variant.boxId,
          boxState: "provisioning",
          piState: "absent",
          observedAt: new Date(observedAt.getTime() + (attachmentSequence === 0 ? 0 : 2)),
        })).toBe(attachmentSequence);
        const [attached] = await runtimeSql<Array<{
          boxId: string | null;
          boxState: string;
          checkpoint: string;
        }>>`
          select i.box_id as "boxId", i.box_state::text as "boxState", o.checkpoint
          from companion_runtime_instances i
          join companion_operations o
            on o.org_id = i.org_id and o.companion_id = i.companion_id
          where o.id = ${deleteId}::uuid
        `;
        expect(attached).toEqual({
          boxId: variant.boxId,
          boxState: "provisioning",
          checkpoint: attachmentSequence === 0 ? "pending" : "box_absence_observed",
        });
        await expect(checkpoint(deleteClaim!, variant.executor, "box_absent", {
          expectedSequence: attachmentSequence,
        }))
          .rejects.toThrow(/operation-bound provider absence evidence|invalid operation checkpoint transition/);

        const providerOperationId = "delete-preempted-create";
        expect(await checkpoint(deleteClaim!, variant.executor, "provider_delete_requested", {
          expectedSequence: attachmentSequence,
          providerOperationId,
        })).toBe(attachmentSequence + 1);
        expect(await checkpoint(deleteClaim!, variant.executor, "waiting_deleted", {
          expectedSequence: attachmentSequence + 1,
          providerOperationId,
        })).toBe(attachmentSequence + 2);
        await expect(settle(deleteClaim!, variant.executor, "succeeded"))
          .rejects.toThrow(/terminal checkpoint proof/);
        expect(await observeInstance(deleteClaim!, variant.executor, {
          expectedSequence: attachmentSequence + 2,
          boxId: variant.boxId,
          boxState: "absent",
          piState: "absent",
        })).toBe(attachmentSequence + 3);
      }

      expect(await settle(deleteClaim!, variant.executor, "succeeded")).toBe(true);
      const [deleted] = await runtimeSql<Array<{
        companionCount: number;
        runtimeCount: number;
        operationCount: number;
        auditCount: number;
      }>>`
        select
          (select count(*)::int from companions
            where org_id = ${ids.orgA}::uuid and id = ${ids.companionA}::uuid) as "companionCount",
          (select count(*)::int from companion_runtime_instances
            where companion_id = ${ids.companionA}::uuid) as "runtimeCount",
          (select count(*)::int from companion_operations
            where companion_id = ${ids.companionA}::uuid) as "operationCount",
          (select count(*)::int from audit_log
            where org_id = ${ids.orgA}::uuid
              and action = 'companion.deleted'
              and target_id = ${ids.companionA}
              and metadata ->> 'operation_id' = ${deleteId}) as "auditCount"
      `;
      expect(deleted).toEqual({
        companionCount: 0,
        runtimeCount: 0,
        operationCount: 0,
        auditCount: 1,
      });
    }
  });

  it("allows only interrupted settlement while a dispatch write intent has no ACK", async () => {
    if (!runtimeSql) throw new Error("runtime database is not initialized");
    const gate = await gateStatus();
    const turnId = await insertQueuedTurn({ companionId: ids.companionA });
    const executorId = "unacked-dispatch-settlement";
    const [claim] = await claimWork(executorId, gate.gateEpoch);
    expect(claim).toMatchObject({
      workKind: "attempt",
      turnId,
      checkpoint: "starting",
      checkpointSequence: 0,
      dispatchState: "pending",
    });

    const commandId = randomUUID();
    expect(await checkpoint(claim!, executorId, "dispatch_write_intent", {
      commandId,
    })).toBe(1);
    await expect(settle(claim!, executorId, "failed", {
      errorCode: "dispatch_failed",
      errorMessage: "Dispatch failed before its acknowledgement was known.",
      errorAction: "retry",
    })).rejects.toMatchObject({
      code: "22023",
      message: expect.stringMatching(/write intent without ACK may only settle interrupted/i),
    });

    const [preserved] = await runtimeSql<Array<{
      attemptStatus: string;
      dispatchState: string;
      checkpoint: string;
      sequence: number;
      commandId: string | null;
      attemptSettledAt: Date | null;
      attemptCode: string | null;
      turnStatus: string;
      turnSettledAt: Date | null;
      turnCode: string | null;
      leaseToken: string | null;
      leaseEpoch: number;
      gateEpoch: number | null;
      leaseExecutor: string | null;
      leaseWorkKind: string | null;
      leaseWorkId: string | null;
      leaseCurrent: boolean;
    }>>`
      select a.status::text as "attemptStatus", a.dispatch_state::text as "dispatchState",
             a.checkpoint, a.checkpoint_sequence::int as sequence,
             a.command_id::text as "commandId", a.settled_at as "attemptSettledAt",
             a.last_error_code as "attemptCode", t.status::text as "turnStatus",
             t.settled_at as "turnSettledAt", t.last_error_code as "turnCode",
             l.claim_token::text as "leaseToken", l.claim_epoch::int as "leaseEpoch",
             l.gate_epoch::int as "gateEpoch", l.executor_id as "leaseExecutor",
             l.work_kind::text as "leaseWorkKind", l.work_id::text as "leaseWorkId",
             (l.expires_at > statement_timestamp()) as "leaseCurrent"
      from companion_turn_attempts a
      join companion_turns t on t.id = a.turn_id
      join companion_runtime_leases l on l.companion_id = a.companion_id
      where a.id = ${claim!.workId}::uuid
    `;
    expect(preserved).toEqual({
      attemptStatus: "dispatching",
      dispatchState: "write_intent",
      checkpoint: "dispatch_write_intent",
      sequence: 1,
      commandId,
      attemptSettledAt: null,
      attemptCode: null,
      turnStatus: "dispatching",
      turnSettledAt: null,
      turnCode: null,
      leaseToken: claim!.claimToken,
      leaseEpoch: claim!.claimEpoch,
      gateEpoch: claim!.gateEpoch,
      leaseExecutor: executorId,
      leaseWorkKind: "attempt",
      leaseWorkId: claim!.workId,
      leaseCurrent: true,
    });
    expect(await claimWork("unacked-dispatch-competitor", gate.gateEpoch)).toEqual([]);

    const interruption = {
      errorCode: "dispatch_ack_unknown",
      errorMessage: "Pi prompt acceptance could not be established.",
      errorAction: "retry",
    };
    expect(await settle(claim!, executorId, "interrupted", interruption)).toBe(true);
    const [terminal] = await runtimeSql<Array<{
      attemptStatus: string;
      dispatchState: string;
      checkpoint: string;
      commandId: string | null;
      attemptCode: string | null;
      attemptSettledAt: Date | null;
      turnStatus: string;
      turnCode: string | null;
      turnSettledAt: Date | null;
      leaseToken: string | null;
      leaseWorkKind: string | null;
      leaseWorkId: string | null;
    }>>`
      select a.status::text as "attemptStatus", a.dispatch_state::text as "dispatchState",
             a.checkpoint, a.command_id::text as "commandId",
             a.last_error_code as "attemptCode", a.settled_at as "attemptSettledAt",
             t.status::text as "turnStatus", t.last_error_code as "turnCode",
             t.settled_at as "turnSettledAt", l.claim_token::text as "leaseToken",
             l.work_kind::text as "leaseWorkKind", l.work_id::text as "leaseWorkId"
      from companion_turn_attempts a
      join companion_turns t on t.id = a.turn_id
      join companion_runtime_leases l on l.companion_id = a.companion_id
      where a.id = ${claim!.workId}::uuid
    `;
    expect(terminal).toMatchObject({
      attemptStatus: "interrupted",
      dispatchState: "write_intent",
      checkpoint: "dispatch_write_intent",
      commandId,
      attemptCode: interruption.errorCode,
      turnStatus: "interrupted",
      turnCode: interruption.errorCode,
      leaseToken: null,
      leaseWorkKind: null,
      leaseWorkId: null,
    });
    expect(terminal?.attemptSettledAt).toBeInstanceOf(Date);
    expect(terminal?.turnSettledAt).toBeInstanceOf(Date);
    expect(await claimWork("unacked-dispatch-after-interrupt", gate.gateEpoch)).toEqual([]);
  });

  it("terminalizes an expired dispatch write intent instead of handing it to a takeover claimant", async () => {
    if (!runtimeSql) throw new Error("runtime database is not initialized");
    const gate = await gateStatus();
    const turnId = await insertQueuedTurn({ companionId: ids.companionA });
    const [claimA] = await claimWork("dispatch-intent-a", gate.gateEpoch);
    expect(claimA).toMatchObject({
      workKind: "attempt",
      turnId,
      checkpoint: "starting",
      checkpointSequence: 0,
    });

    const commandId = randomUUID();
    expect(await checkpoint(claimA!, "dispatch-intent-a", "dispatch_write_intent", {
      commandId,
    })).toBe(1);
    const [leaseBefore] = await runtimeSql<Array<{ claimEpoch: number }>>`
      select claim_epoch::int as "claimEpoch"
      from companion_runtime_leases where companion_id = ${ids.companionA}::uuid
    `;
    expect(leaseBefore?.claimEpoch).toBe(claimA!.claimEpoch);

    await runtimeSql`
      update companion_runtime_leases
      set renewed_at = now() - interval '2 seconds', expires_at = now() - interval '1 second'
      where companion_id = ${ids.companionA}::uuid
    `;
    expect(await claimWork("dispatch-intent-b", gate.gateEpoch)).toEqual([]);

    expect(await checkpoint(claimA!, "dispatch-intent-a", "dispatch_accepted", {
      expectedSequence: 1,
      commandId,
      piInvocationId: "pi-stale-dispatch",
    })).toBeNull();
    expect(await settle(claimA!, "dispatch-intent-a", "succeeded")).toBe(false);

    const [terminal] = await runtimeSql<Array<{
      attemptStatus: string;
      dispatchState: string;
      checkpoint: string;
      sequence: number;
      commandId: string | null;
      attemptCode: string | null;
      attemptAction: string | null;
      attemptSettled: boolean;
      turnStatus: string;
      turnCode: string | null;
      turnSettled: boolean;
      leaseEpoch: number;
      leaseToken: string | null;
      leaseExecutor: string | null;
      leaseWorkKind: string | null;
      leaseWorkId: string | null;
      lastWriteEpoch: number;
    }>>`
      select a.status::text as "attemptStatus", a.dispatch_state::text as "dispatchState",
             a.checkpoint, a.checkpoint_sequence::int as sequence,
             a.command_id::text as "commandId", a.last_error_code as "attemptCode",
             a.last_error_action::text as "attemptAction",
             (a.settled_at is not null) as "attemptSettled",
             t.status::text as "turnStatus", t.last_error_code as "turnCode",
             (t.settled_at is not null) as "turnSettled",
             l.claim_epoch::int as "leaseEpoch", l.claim_token::text as "leaseToken",
             l.executor_id as "leaseExecutor", l.work_kind::text as "leaseWorkKind",
             l.work_id::text as "leaseWorkId",
             i.last_write_epoch::int as "lastWriteEpoch"
      from companion_turn_attempts a
      join companion_turns t on t.id = a.turn_id
      join companion_runtime_leases l on l.companion_id = a.companion_id
      join companion_runtime_instances i on i.companion_id = a.companion_id
      where a.id = ${claimA!.workId}::uuid
    `;
    expect(terminal).toEqual({
      attemptStatus: "interrupted",
      dispatchState: "ambiguous",
      checkpoint: "dispatch_ambiguous",
      sequence: 2,
      commandId,
      attemptCode: "dispatch_ack_unknown",
      attemptAction: "retry",
      attemptSettled: true,
      turnStatus: "interrupted",
      turnCode: "dispatch_ack_unknown",
      turnSettled: true,
      leaseEpoch: leaseBefore!.claimEpoch + 1,
      leaseToken: null,
      leaseExecutor: null,
      leaseWorkKind: null,
      leaseWorkId: null,
      lastWriteEpoch: leaseBefore!.claimEpoch + 1,
    });
  });

  it("terminalizes an expired decision write intent without allowing delivered settlement", async () => {
    if (!runtimeSql) throw new Error("runtime database is not initialized");
    const gate = await gateStatus();
    const parent = await insertActiveTurnAttempt({ companionId: ids.companionA });
    const decision = await insertDecision({
      companionId: ids.companionA,
      turnId: parent.turnId,
      attemptId: parent.attemptId,
    });
    const [claimA] = await claimWork("decision-intent-a", gate.gateEpoch);
    expect(claimA).toMatchObject({
      workKind: "decision",
      workId: decision.id,
      decisionStatus: "answered",
      decisionDeliveryState: "pending",
      checkpointSequence: 0,
    });

    const commandId = randomUUID();
    expect(await checkpoint(claimA!, "decision-intent-a", "write_intent", {
      commandId,
    })).toBe(1);
    const [leaseBefore] = await runtimeSql<Array<{ claimEpoch: number }>>`
      select claim_epoch::int as "claimEpoch"
      from companion_runtime_leases where companion_id = ${ids.companionA}::uuid
    `;
    expect(leaseBefore?.claimEpoch).toBe(claimA!.claimEpoch);

    await runtimeSql`
      update companion_runtime_leases
      set renewed_at = now() - interval '2 seconds', expires_at = now() - interval '1 second'
      where companion_id = ${ids.companionA}::uuid
    `;
    expect(await claimWork("decision-intent-b", gate.gateEpoch)).toEqual([]);

    expect(await checkpoint(claimA!, "decision-intent-a", "delivered", {
      expectedSequence: 1,
      commandId,
    })).toBeNull();
    expect(await settle(claimA!, "decision-intent-a", "succeeded")).toBe(false);

    const [terminal] = await runtimeSql<Array<{
      decisionStatus: string;
      deliveryState: string;
      checkpoint: string;
      sequence: number;
      commandId: string | null;
      deliveryCode: string | null;
      deliveryAction: string | null;
      delivered: boolean;
      attemptStatus: string;
      attemptCode: string | null;
      attemptSettled: boolean;
      turnStatus: string;
      turnCode: string | null;
      turnSettled: boolean;
      leaseEpoch: number;
      leaseToken: string | null;
      leaseExecutor: string | null;
      leaseWorkKind: string | null;
      leaseWorkId: string | null;
      lastWriteEpoch: number;
    }>>`
      select d.decision_status::text as "decisionStatus",
             d.delivery_state::text as "deliveryState", d.delivery_checkpoint as checkpoint,
             d.delivery_checkpoint_sequence::int as sequence,
             d.command_id::text as "commandId", d.last_error_code as "deliveryCode",
             d.last_error_action::text as "deliveryAction",
             (d.delivered_at is not null) as delivered,
             a.status::text as "attemptStatus", a.last_error_code as "attemptCode",
             (a.settled_at is not null) as "attemptSettled",
             t.status::text as "turnStatus", t.last_error_code as "turnCode",
             (t.settled_at is not null) as "turnSettled",
             l.claim_epoch::int as "leaseEpoch", l.claim_token::text as "leaseToken",
             l.executor_id as "leaseExecutor", l.work_kind::text as "leaseWorkKind",
             l.work_id::text as "leaseWorkId",
             i.last_write_epoch::int as "lastWriteEpoch"
      from companion_decision_deliveries d
      join companion_turn_attempts a on a.id = d.attempt_id
      join companion_turns t on t.id = d.turn_id
      join companion_runtime_leases l on l.companion_id = d.companion_id
      join companion_runtime_instances i on i.companion_id = d.companion_id
      where d.id = ${decision.id}::uuid
    `;
    expect(terminal).toEqual({
      decisionStatus: "answered",
      deliveryState: "ambiguous",
      checkpoint: "ambiguous",
      sequence: 2,
      commandId,
      deliveryCode: "decision_ack_unknown",
      deliveryAction: "retry",
      delivered: false,
      attemptStatus: "interrupted",
      attemptCode: "decision_ack_unknown",
      attemptSettled: true,
      turnStatus: "interrupted",
      turnCode: "decision_ack_unknown",
      turnSettled: true,
      leaseEpoch: leaseBefore!.claimEpoch + 1,
      leaseToken: null,
      leaseExecutor: null,
      leaseWorkKind: null,
      leaseWorkId: null,
      lastWriteEpoch: leaseBefore!.claimEpoch + 1,
    });
  });

  it("refuses cross-tenant, revoked-actor, and another actor's personal resources before disclosure", async () => {
    if (!runtimeSql) throw new Error("runtime database is not initialized");
    let gate = await gateStatus();
    const revokedOperation = await insertOperation({
      companionId: ids.companionA,
      actorId: ids.revokedA,
    });
    expect(await claimWork("auth-replica", gate.gateEpoch)).toEqual([]);
    const [revoked] = await runtimeSql<Array<{
      status: string;
      errorCode: string | null;
      settledAt: Date | null;
      attemptCount: number;
    }>>`
      select status::text, last_error_code as "errorCode", settled_at as "settledAt",
             attempt_count::int as "attemptCount"
      from companion_operations where id = ${revokedOperation}::uuid
    `;
    expect(revoked).toMatchObject({
      status: "failed",
      errorCode: "actor_access_revoked",
      attemptCount: 0,
    });
    expect(revoked?.settledAt).toBeInstanceOf(Date);

    await resetWork();
    gate = await gateStatus();
    await runtimeSql`
      update companions set selected_skill_ids = ${runtimeSql.json([ids.editorSkill])}
      where org_id = ${ids.orgA}::uuid and id = ${ids.companionA}::uuid
    `;
    const privateOperation = await insertOperation({ companionId: ids.companionA, kind: "start" });
    const [privateClaim] = await claimWork("privacy-replica", gate.gateEpoch);
    expect(privateClaim?.workId).toBe(privateOperation);
    const [privateDenial] = await renewAndAuthorize(privateClaim!, "privacy-replica");
    expect(privateDenial).toMatchObject({
      authorized: false,
      denialCode: "skill_access_revoked",
      authorizationActorId: null,
      modelId: null,
      providerRefs: [],
      skillRefs: [],
      mcpRefs: [],
    });
    await settle(privateClaim!, "privacy-replica", "failed");
  });

  it("never grants Owner and Editor access to each other's personal resource pins", async () => {
    if (!runtimeSql) throw new Error("runtime database is not initialized");
    const sql = runtimeSql;
    const ownerMcpId = randomUUID();
    const editorMcpId = randomUUID();

    try {
      await sql`
        insert into companion_workspace_access (
          org_id, companion_id, owner_id, role, granted_by
        ) values (
          ${ids.orgA}::uuid, ${ids.companionA}::uuid, ${ids.ownerA}, 'editor', ${ids.ownerA}
        )
        on conflict (companion_id) do update
        set role = 'editor', granted_by = excluded.granted_by, updated_at = now()
      `;
      await sql`
        insert into companion_mcp_accounts (
          id, org_id, owner_id, provider, label, transport, account_config,
          ciphertext, iv, auth_tag, wrapped_dek, wrap_iv, wrap_auth_tag, key_id
        ) values
          (
            ${ownerMcpId}::uuid, ${ids.orgA}::uuid, ${ids.ownerA}, 'github',
            'runtime owner pin', 'http', ${sql.json({ url: "https://owner-mcp.example.test" })},
            'owner-ciphertext', 'owner-iv', 'owner-auth-tag', 'owner-wrapped-dek',
            'owner-wrap-iv', 'owner-wrap-auth-tag', 'runtime-owner-key'
          ),
          (
            ${editorMcpId}::uuid, ${ids.orgA}::uuid, ${ids.editorA}, 'github',
            'runtime editor pin', 'http', ${sql.json({ url: "https://editor-mcp.example.test" })},
            'editor-ciphertext', 'editor-iv', 'editor-auth-tag', 'editor-wrapped-dek',
            'editor-wrap-iv', 'editor-wrap-auth-tag', 'runtime-editor-key'
          )
      `;

      await sql`
        update companions
        set selected_skill_ids = ${sql.json([ids.ownerSkill])},
            selected_mcp_account_ids = ${sql.json([ownerMcpId])}, skills_revision = 1
        where org_id = ${ids.orgA}::uuid and id = ${ids.companionA}::uuid
      `;
      let gate = await gateStatus();
      const editorTurnId = await insertQueuedTurn({
        companionId: ids.companionA,
        actorId: ids.editorA,
      });
      const [editorClaim] = await claimWork("editor-owner-pins", gate.gateEpoch);
      expect(editorClaim).toMatchObject({ workKind: "attempt", turnId: editorTurnId });
      const [editorAuthorization] = await renewAndAuthorize(
        editorClaim!,
        "editor-owner-pins",
      );
      expect(editorAuthorization).toMatchObject({
        authorized: false,
        denialCode: "skill_access_revoked",
        authorizationActorId: null,
        skillRefs: [],
        mcpRefs: [],
      });
      expect(await settle(editorClaim!, "editor-owner-pins", "failed")).toBe(true);

      await resetWork();
      await sql`
        update companions
        set selected_skill_ids = '[]'::jsonb,
            selected_mcp_account_ids = ${sql.json([ownerMcpId])}, skills_revision = 1
        where org_id = ${ids.orgA}::uuid and id = ${ids.companionA}::uuid
      `;
      gate = await gateStatus();
      const editorMcpTurnId = await insertQueuedTurn({
        companionId: ids.companionA,
        actorId: ids.editorA,
      });
      const [editorMcpClaim] = await claimWork("editor-owner-mcp", gate.gateEpoch);
      expect(editorMcpClaim).toMatchObject({ workKind: "attempt", turnId: editorMcpTurnId });
      const [editorMcpDenial] = await renewAndAuthorize(
        editorMcpClaim!,
        "editor-owner-mcp",
      );
      expect(editorMcpDenial).toMatchObject({
        authorized: false,
        denialCode: "mcp_access_revoked",
        authorizationActorId: null,
        skillRefs: [],
        mcpRefs: [],
      });
      expect(await settle(editorMcpClaim!, "editor-owner-mcp", "failed")).toBe(true);

      await resetWork();
      gate = await gateStatus();
      const ownerAttempt = await insertActiveTurnAttempt({ companionId: ids.companionA });
      const editorDecision = await insertDecision({
        companionId: ids.companionA,
        turnId: ownerAttempt.turnId,
        attemptId: ownerAttempt.attemptId,
        actorId: ids.editorA,
      });
      const [editorDecisionClaim] = await claimWork("editor-owner-decision", gate.gateEpoch);
      expect(editorDecisionClaim).toMatchObject({
        workKind: "decision",
        workId: editorDecision.id,
      });
      const [editorDecisionDenial] = await renewAndAuthorize(
        editorDecisionClaim!,
        "editor-owner-decision",
      );
      expect(editorDecisionDenial).toMatchObject({
        authorized: false,
        denialCode: "skill_access_revoked",
        authorizationActorId: null,
        decisionActorId: null,
        skillRefs: [],
        mcpRefs: [],
      });
      expect(await settle(editorDecisionClaim!, "editor-owner-decision", "failed")).toBe(true);

      await resetWork();
      await sql`
        update companions
        set selected_skill_ids = ${sql.json([ids.editorSkill])},
            selected_mcp_account_ids = '[]'::jsonb, skills_revision = 1
        where org_id = ${ids.orgA}::uuid and id = ${ids.companionA}::uuid
      `;
      gate = await gateStatus();
      const ownerSkillTurnId = await insertQueuedTurn({ companionId: ids.companionA });
      const [ownerSkillClaim] = await claimWork("owner-editor-skill", gate.gateEpoch);
      expect(ownerSkillClaim).toMatchObject({ workKind: "attempt", turnId: ownerSkillTurnId });
      const [ownerSkillDenial] = await renewAndAuthorize(
        ownerSkillClaim!,
        "owner-editor-skill",
      );
      expect(ownerSkillDenial).toMatchObject({
        authorized: false,
        denialCode: "skill_access_revoked",
        authorizationActorId: null,
        skillRefs: [],
        mcpRefs: [],
      });
      expect(await settle(ownerSkillClaim!, "owner-editor-skill", "failed")).toBe(true);

      await resetWork();
      await sql`
        update companions
        set selected_skill_ids = ${sql.json([ids.ownerSkill])},
            selected_mcp_account_ids = ${sql.json([editorMcpId])}, skills_revision = 1
        where org_id = ${ids.orgA}::uuid and id = ${ids.companionA}::uuid
      `;
      gate = await gateStatus();
      const ownerMcpTurnId = await insertQueuedTurn({ companionId: ids.companionA });
      const [ownerMcpClaim] = await claimWork("owner-editor-mcp", gate.gateEpoch);
      expect(ownerMcpClaim).toMatchObject({ workKind: "attempt", turnId: ownerMcpTurnId });
      const [ownerMcpDenial] = await renewAndAuthorize(ownerMcpClaim!, "owner-editor-mcp");
      expect(ownerMcpDenial).toMatchObject({
        authorized: false,
        denialCode: "mcp_access_revoked",
        authorizationActorId: null,
        skillRefs: [],
        mcpRefs: [],
      });
      expect(await settle(ownerMcpClaim!, "owner-editor-mcp", "failed")).toBe(true);
    } finally {
      await resetWork();
      await sql`
        delete from companion_mcp_accounts where id in (${ownerMcpId}::uuid, ${editorMcpId}::uuid)
      `;
      await sql`
        delete from companion_workspace_access
        where org_id = ${ids.orgA}::uuid and companion_id = ${ids.companionA}::uuid
      `;
    }
  });

  it("ignores a revoked Editor's pending Stop when renewing an active Owner attempt", async () => {
    if (!runtimeSql) throw new Error("runtime database is not initialized");
    const sql = runtimeSql;
    let editorMembershipRevoked = false;

    try {
      await sql`
        insert into companion_workspace_access (
          org_id, companion_id, owner_id, role, granted_by
        ) values (
          ${ids.orgA}::uuid, ${ids.companionA}::uuid, ${ids.ownerA}, 'editor', ${ids.ownerA}
        )
        on conflict (companion_id) do update
        set role = 'editor', granted_by = excluded.granted_by, updated_at = now()
      `;
      const gate = await gateStatus();
      const active = await insertActiveTurnAttempt({ companionId: ids.companionA });
      const [attemptClaim] = await claimWork("revoked-stop-active", gate.gateEpoch);
      expect(attemptClaim).toMatchObject({
        workKind: "attempt",
        workId: active.attemptId,
        actorId: ids.ownerA,
        attemptStatus: "running",
      });
      const stopId = await insertOperation({
        companionId: ids.companionA,
        actorId: ids.editorA,
        kind: "stop",
      });

      await sql`
        delete from memberships
        where org_id = ${ids.orgA}::uuid and user_id = ${ids.editorA}
      `;
      editorMembershipRevoked = true;

      const [renewed] = await renewAndAuthorize(attemptClaim!, "revoked-stop-active");
      expect(renewed).toMatchObject({
        authorized: true,
        denialCode: null,
        authorizationActorId: ids.ownerA,
        workCheckpoint: "running",
      });
      const [stillPending] = await sql<Array<{
        status: string;
        attemptCount: number;
        errorCode: string | null;
      }>>`
        select status::text, attempt_count::int as "attemptCount",
               last_error_code as "errorCode"
        from companion_operations where id = ${stopId}::uuid
      `;
      expect(stillPending).toEqual({
        status: "pending",
        attemptCount: 0,
        errorCode: null,
      });

      expect(await settle(attemptClaim!, "revoked-stop-active", "failed")).toBe(true);
      expect(await claimWork("revoked-stop-sweep", gate.gateEpoch)).toEqual([]);
      const [swept] = await sql<Array<{
        status: string;
        attemptCount: number;
        errorCode: string | null;
        settledAt: Date | null;
      }>>`
        select status::text, attempt_count::int as "attemptCount",
               last_error_code as "errorCode", settled_at as "settledAt"
        from companion_operations where id = ${stopId}::uuid
      `;
      expect(swept).toMatchObject({
        status: "failed",
        attemptCount: 0,
        errorCode: "actor_access_revoked",
      });
      expect(swept?.settledAt).toBeInstanceOf(Date);
    } finally {
      if (editorMembershipRevoked) {
        await sql`
          insert into memberships (org_id, user_id, org_role)
          values (${ids.orgA}::uuid, ${ids.editorA}, 'developer')
          on conflict (org_id, user_id) do update
          set org_role = excluded.org_role, updated_at = now()
        `;
      }
      await sql`
        delete from companion_workspace_access
        where org_id = ${ids.orgA}::uuid and companion_id = ${ids.companionA}::uuid
      `;
    }
  });

  it("serializes an Editor downgrade behind the claim authorization lock", async () => {
    if (!runtimeSql) throw new Error("runtime database is not initialized");
    const sql = runtimeSql;
    await sql`
      insert into companion_workspace_access (
        org_id, companion_id, owner_id, role, granted_by
      ) values (
        ${ids.orgA}::uuid, ${ids.companionA}::uuid, ${ids.ownerA}, 'editor', ${ids.ownerA}
      )
      on conflict (companion_id) do update
      set role = 'editor', granted_by = excluded.granted_by, updated_at = now()
    `;
    const gate = await gateStatus();
    const operationId = await insertOperation({
      companionId: ids.companionA,
      actorId: ids.editorA,
      kind: "stop",
    });
    const claimSql = postgres(runtimeUrl.toString(), { max: 1 });
    const downgradeSql = postgres(runtimeUrl.toString(), { max: 1 });
    let releaseClaim: (() => void) | undefined;
    const claimRelease = new Promise<void>((resolve) => {
      releaseClaim = resolve;
    });
    let claimReady: ((claim: Claim) => void) | undefined;
    const claimed = new Promise<Claim>((resolve) => {
      claimReady = resolve;
    });
    let downgradePidReady: ((pid: number) => void) | undefined;
    const downgradePid = new Promise<number>((resolve) => {
      downgradePidReady = resolve;
    });

    const claimRun = claimSql.begin(async (tx) => {
      await tx.unsafe("set local lock_timeout = '5s'");
      await tx.unsafe(`set local role ${executorRole}`);
      const [claim] = await tx<Array<Claim>>`
        select org_id::text as "orgId", companion_id::text as "companionId",
               claim_token::text as "claimToken", claim_epoch::int as "claimEpoch",
               gate_epoch::int as "gateEpoch", work_kind::text as "workKind",
               work_id::text as "workId", actor_id as "actorId",
               runtime_generation::int as "runtimeGeneration", checkpoint,
               checkpoint_sequence::int as "checkpointSequence",
               operation_kind::text as "operationKind"
        from public.companion_runtime_claim_work(
          'editor-downgrade-claim', 1, 30, ${gate.gateEpoch}
        )
      `;
      if (!claim) throw new Error("Editor operation was not claimed");
      claimReady?.(claim);
      await claimRelease;
      return claim;
    });
    void claimRun.catch(() => undefined);
    let downgradeRun: Promise<string> | undefined;

    try {
      const heldClaim = await claimed;
      expect(heldClaim).toMatchObject({
        workKind: "operation",
        workId: operationId,
        actorId: ids.editorA,
        operationKind: "stop",
      });
      downgradeRun = downgradeSql.begin(async (tx) => {
        await tx.unsafe("set local deadlock_timeout = '100ms'");
        await tx.unsafe("set local lock_timeout = '5s'");
        const [backend] = await tx<Array<{ pid: number }>>`
          select pg_backend_pid()::int as pid
        `;
        downgradePidReady?.(backend!.pid);
        const [downgraded] = await tx<Array<{ role: string }>>`
          update companion_workspace_access
          set role = 'viewer', updated_at = now()
          where org_id = ${ids.orgA}::uuid and companion_id = ${ids.companionA}::uuid
          returning role::text
        `;
        return downgraded!.role;
      });
      void downgradeRun.catch(() => undefined);
      await waitForBackendLock(await downgradePid, "Editor downgrade behind claim authorization");

      const [whileClaimHeld] = await sql<Array<{ role: string }>>`
        select role::text from companion_workspace_access
        where org_id = ${ids.orgA}::uuid and companion_id = ${ids.companionA}::uuid
      `;
      expect(whileClaimHeld?.role).toBe("editor");
      releaseClaim?.();
      const [committedClaim, downgradedRole] = await Promise.all([
        settlesWithin(claimRun, 5_000, "claim authorization commit"),
        settlesWithin(downgradeRun, 5_000, "Editor downgrade after claim"),
      ]);
      expect(committedClaim.workId).toBe(operationId);
      expect(downgradedRole).toBe("viewer");

      const [revoked] = await renewAndAuthorize(committedClaim, "editor-downgrade-claim");
      expect(revoked).toMatchObject({
        authorized: false,
        denialCode: "actor_access_revoked",
        authorizationActorId: null,
      });
      expect(await settle(committedClaim, "editor-downgrade-claim", "failed")).toBe(true);
    } finally {
      releaseClaim?.();
      await Promise.allSettled([claimRun, ...(downgradeRun ? [downgradeRun] : [])]);
      await claimSql.end({ timeout: 1 });
      await downgradeSql.end({ timeout: 1 });
      await sql`
        delete from companion_workspace_access
        where org_id = ${ids.orgA}::uuid and companion_id = ${ids.companionA}::uuid
      `;
    }
  });

  it("never returns renewed Editor authority after a concurrent Viewer downgrade commits", async () => {
    if (!runtimeSql) throw new Error("runtime database is not initialized");
    const sql = runtimeSql;
    await sql`
      insert into companion_workspace_access (
        org_id, companion_id, owner_id, role, granted_by
      ) values (
        ${ids.orgA}::uuid, ${ids.companionA}::uuid, ${ids.ownerA}, 'editor', ${ids.ownerA}
      )
      on conflict (companion_id) do update
      set role = 'editor', granted_by = excluded.granted_by, updated_at = now()
    `;
    // Exercise only the ACL lock ordering: an Editor cannot use the Owner's default personal
    // fixture, so this attempt intentionally carries no member-private resources.
    await sql`
      update companions set selected_skill_ids = '[]'::jsonb
      where org_id = ${ids.orgA}::uuid and id = ${ids.companionA}::uuid
    `;
    const gate = await gateStatus();
    const turnId = await insertQueuedTurn({
      companionId: ids.companionA,
      actorId: ids.editorA,
    });
    const [claim] = await claimWork("renew-editor-downgrade", gate.gateEpoch);
    expect(claim).toMatchObject({
      workKind: "attempt",
      turnId,
      actorId: ids.editorA,
    });

    const renewSql = postgres(runtimeUrl.toString(), { max: 1 });
    const downgradeSql = postgres(runtimeUrl.toString(), { max: 1 });
    let releaseRenew: (() => void) | undefined;
    const renewRelease = new Promise<void>((resolve) => {
      releaseRenew = resolve;
    });
    let renewReady: (() => void) | undefined;
    const renewedInsideTransaction = new Promise<void>((resolve) => {
      renewReady = resolve;
    });
    let downgradePidReady: ((pid: number) => void) | undefined;
    const downgradePid = new Promise<number>((resolve) => {
      downgradePidReady = resolve;
    });
    const commitOrder: string[] = [];
    const renewRun = renewSql.begin(async (tx) => {
      await tx.unsafe("set local lock_timeout = '5s'");
      await tx.unsafe(`set local role ${executorRole}`);
      const rows = await tx<Array<{ authorized: boolean; denialCode: string | null }>>`
        select authorized, denial_code as "denialCode"
        from public.companion_runtime_renew_and_authorize(
          ${claim!.orgId}::uuid, ${claim!.companionId}::uuid,
          ${claim!.claimToken}::uuid, ${claim!.claimEpoch}, ${claim!.gateEpoch},
          'renew-editor-downgrade', ${claim!.workKind}, ${claim!.workId}::uuid, 30
        )
      `;
      expect(rows).toEqual([{ authorized: true, denialCode: null }]);
      renewReady?.();
      await renewRelease;
      return rows;
    }).then((rows) => {
      commitOrder.push("renew");
      return rows;
    });
    void renewRun.catch(() => undefined);
    let downgradeRun: Promise<string> | undefined;

    try {
      await renewedInsideTransaction;
      downgradeRun = downgradeSql.begin(async (tx) => {
        await tx.unsafe("set local deadlock_timeout = '100ms'");
        await tx.unsafe("set local lock_timeout = '5s'");
        const [backend] = await tx<Array<{ pid: number }>>`
          select pg_backend_pid()::int as pid
        `;
        downgradePidReady?.(backend!.pid);
        const [row] = await tx<Array<{ role: string }>>`
          update companion_workspace_access
          set role = 'viewer', updated_at = now()
          where org_id = ${ids.orgA}::uuid and companion_id = ${ids.companionA}::uuid
          returning role::text
        `;
        return row!.role;
      }).then((role) => {
        commitOrder.push("downgrade");
        return role;
      });
      void downgradeRun.catch(() => undefined);
      await waitForBackendLock(await downgradePid, "Viewer downgrade behind renewal ACL");

      releaseRenew?.();
      const [authorizedRows, downgradedRole] = await Promise.all([
        settlesWithin(renewRun, 5_000, "authorized renewal commit"),
        settlesWithin(downgradeRun, 5_000, "Viewer downgrade commit"),
      ]);
      expect(authorizedRows).toEqual([{ authorized: true, denialCode: null }]);
      expect(downgradedRole).toBe("viewer");
      expect(commitOrder).toEqual(["renew", "downgrade"]);

      const [afterDowngrade] = await renewAndAuthorize(claim!, "renew-editor-downgrade");
      expect(afterDowngrade).toMatchObject({
        authorized: false,
        denialCode: "actor_access_revoked",
        authorizationActorId: null,
      });
      expect(await settle(claim!, "renew-editor-downgrade", "failed")).toBe(true);
    } finally {
      releaseRenew?.();
      await Promise.allSettled([renewRun, ...(downgradeRun ? [downgradeRun] : [])]);
      await renewSql.end({ timeout: 1 });
      await downgradeSql.end({ timeout: 1 });
      await sql`
        delete from companion_workspace_access
        where org_id = ${ids.orgA}::uuid and companion_id = ${ids.companionA}::uuid
      `;
    }
  });

  it("lets lifecycle work close every decision and parent, while start never preempts an active turn", async () => {
    if (!runtimeSql) throw new Error("runtime database is not initialized");
    const lifecycleKinds = ["delete", "stop", "restart_pi"] as const;
    for (const kind of lifecycleKinds) {
      await resetWork();
      const gate = await gateStatus();
      const parent = await insertActiveTurnAttempt({ companionId: ids.companionA });
      const pending = await insertDecision({
        companionId: ids.companionA,
        turnId: parent.turnId,
        attemptId: parent.attemptId,
        status: "pending",
      });
      const answered = await insertDecision({
        companionId: ids.companionA,
        turnId: parent.turnId,
        attemptId: parent.attemptId,
      });
      const writeIntent = await insertDecision({
        companionId: ids.companionA,
        turnId: parent.turnId,
        attemptId: parent.attemptId,
        deliveryState: "write_intent",
      });
      const lifecycleId = await insertOperation({ companionId: ids.companionA, kind });

      const executorId = `lifecycle-${kind}`;
      const [lifecycleClaim] = await claimWork(executorId, gate.gateEpoch);
      expect(lifecycleClaim).toMatchObject({
        workKind: "operation",
        workId: lifecycleId,
        operationKind: kind,
      });
      const [parentState] = await runtimeSql<Array<{
        attemptStatus: string;
        turnStatus: string;
        attemptCode: string;
        turnCode: string;
      }>>`
        select a.status::text as "attemptStatus", t.status::text as "turnStatus",
               a.last_error_code as "attemptCode", t.last_error_code as "turnCode"
        from companion_turn_attempts a join companion_turns t on t.id = a.turn_id
        where a.id = ${parent.attemptId}::uuid
      `;
      expect(parentState).toEqual({
        attemptStatus: "interrupted",
        turnStatus: "interrupted",
        attemptCode: "runtime_lifecycle_preempted",
        turnCode: "runtime_lifecycle_preempted",
      });
      const closed = await runtimeSql<Array<{
        id: string;
        decisionStatus: string;
        deliveryState: string;
        code: string;
      }>>`
        select id::text, decision_status::text as "decisionStatus",
               delivery_state::text as "deliveryState", last_error_code as code
        from companion_decision_deliveries
        where id in (${pending.id}::uuid, ${answered.id}::uuid, ${writeIntent.id}::uuid)
      `;
      const byId = new Map(closed.map((row) => [row.id, row]));
      expect(byId.get(pending.id)).toMatchObject({
        decisionStatus: "cancelled",
        deliveryState: "cancelled",
        code: "runtime_lifecycle_preempted",
      });
      expect(byId.get(answered.id)).toMatchObject({
        decisionStatus: "answered",
        deliveryState: "cancelled",
        code: "runtime_lifecycle_preempted",
      });
      expect(byId.get(writeIntent.id)).toMatchObject({
        decisionStatus: "answered",
        deliveryState: "ambiguous",
        code: "runtime_lifecycle_preempted",
      });
      await settle(lifecycleClaim!, executorId, "failed");
    }

    await resetWork();
    const gate = await gateStatus();
    const parent = await insertActiveTurnAttempt({ companionId: ids.companionA });
    const startId = await insertOperation({ companionId: ids.companionA, kind: "start" });
    const [attemptClaim] = await claimWork("start-below-attempt", gate.gateEpoch);
    expect(attemptClaim).toMatchObject({
      workKind: "attempt",
      workId: parent.attemptId,
      attemptStatus: "running",
    });
    const [notPreempted] = await runtimeSql<Array<{
      attemptStatus: string;
      turnStatus: string;
      startStatus: string;
    }>>`
      select a.status::text as "attemptStatus", t.status::text as "turnStatus",
             o.status::text as "startStatus"
      from companion_turn_attempts a
      join companion_turns t on t.id = a.turn_id
      join companion_operations o on o.id = ${startId}::uuid
      where a.id = ${parent.attemptId}::uuid
    `;
    expect(notPreempted).toEqual({
      attemptStatus: "running",
      turnStatus: "running",
      startStatus: "pending",
    });
    expect(await releaseLease(attemptClaim!, "start-below-attempt")).toBe(true);
  });

  it("rejects ambiguous decision success before closing siblings and interrupting its parent", async () => {
    if (!runtimeSql) throw new Error("runtime database is not initialized");
    const sql = runtimeSql;
    const gate = await gateStatus();
    const parent = await insertActiveTurnAttempt({ companionId: ids.companionA });
    const primary = await insertDecision({
      companionId: ids.companionA,
      turnId: parent.turnId,
      attemptId: parent.attemptId,
    });
    const pendingSibling = await insertDecision({
      companionId: ids.companionA,
      turnId: parent.turnId,
      attemptId: parent.attemptId,
      status: "pending",
    });
    const answeredSibling = await insertDecision({
      companionId: ids.companionA,
      turnId: parent.turnId,
      attemptId: parent.attemptId,
    });
    const writeSibling = await insertDecision({
      companionId: ids.companionA,
      turnId: parent.turnId,
      attemptId: parent.attemptId,
      deliveryState: "write_intent",
    });
    await runtimeSql`
      update companion_decision_deliveries
      set created_at = case
        when id = ${primary.id}::uuid then now() - interval '4 seconds'
        when id = ${pendingSibling.id}::uuid then now() - interval '3 seconds'
        when id = ${answeredSibling.id}::uuid then now() - interval '2 seconds'
        else now() - interval '1 second'
      end
      where attempt_id = ${parent.attemptId}::uuid
    `;

    const [primaryClaim] = await claimWork("sibling-replica", gate.gateEpoch);
    expect(primaryClaim).toMatchObject({ workKind: "decision", workId: primary.id });
    const commandId = randomUUID();
    expect(await checkpoint(primaryClaim!, "sibling-replica", "write_intent", {
      commandId,
    })).toBe(1);
    expect(await checkpoint(primaryClaim!, "sibling-replica", "ambiguous", {
      expectedSequence: 1,
      commandId,
    })).toBe(2);
    const decisionState = () => sql<Array<{
      deliveryState: string;
      checkpoint: string;
      sequence: number;
      deliveredAt: Date | null;
      leaseToken: string | null;
      attemptStatus: string;
      turnStatus: string;
    }>>`
      select d.delivery_state::text as "deliveryState", d.delivery_checkpoint as checkpoint,
             d.delivery_checkpoint_sequence::int as sequence, d.delivered_at as "deliveredAt",
             l.claim_token::text as "leaseToken", a.status::text as "attemptStatus",
             t.status::text as "turnStatus"
      from companion_decision_deliveries d
      join companion_turn_attempts a on a.id = d.attempt_id
      join companion_turns t on t.id = d.turn_id
      left join companion_runtime_leases l
        on l.org_id = d.org_id and l.companion_id = d.companion_id
      where d.id = ${primary.id}::uuid
    `;
    const [beforeRejectedSuccess] = await decisionState();
    expect(beforeRejectedSuccess).toEqual({
      deliveryState: "ambiguous",
      checkpoint: "ambiguous",
      sequence: 2,
      deliveredAt: null,
      leaseToken: primaryClaim!.claimToken,
      attemptStatus: "running",
      turnStatus: "running",
    });
    await expect(settle(primaryClaim!, "sibling-replica", "succeeded"))
      .rejects.toThrow(/unambiguous durable write intent/);
    const [afterRejectedSuccess] = await decisionState();
    expect(afterRejectedSuccess).toEqual(beforeRejectedSuccess);

    expect(await settle(primaryClaim!, "sibling-replica", "interrupted", {
      errorCode: "decision_delivery_ambiguous",
      errorMessage: "Decision delivery acknowledgement was ambiguous.",
      errorAction: "retry",
    })).toBe(true);

    const rows = await runtimeSql<Array<{
      id: string;
      decisionStatus: string;
      deliveryState: string;
      code: string;
    }>>`
      select id::text, decision_status::text as "decisionStatus",
             delivery_state::text as "deliveryState", last_error_code as code
      from companion_decision_deliveries where attempt_id = ${parent.attemptId}::uuid
    `;
    const byId = new Map(rows.map((row) => [row.id, row]));
    expect(byId.get(primary.id)).toMatchObject({
      decisionStatus: "answered",
      deliveryState: "ambiguous",
      code: "decision_delivery_ambiguous",
    });
    expect(byId.get(pendingSibling.id)).toMatchObject({
      decisionStatus: "cancelled",
      deliveryState: "cancelled",
      code: "decision_delivery_ambiguous",
    });
    expect(byId.get(answeredSibling.id)).toMatchObject({
      decisionStatus: "answered",
      deliveryState: "cancelled",
      code: "decision_delivery_ambiguous",
    });
    expect(byId.get(writeSibling.id)).toMatchObject({
      decisionStatus: "answered",
      deliveryState: "ambiguous",
      code: "decision_delivery_ambiguous",
    });
    const [parentState] = await runtimeSql<Array<{ attemptStatus: string; turnStatus: string }>>`
      select a.status::text as "attemptStatus", t.status::text as "turnStatus"
      from companion_turn_attempts a join companion_turns t on t.id = a.turn_id
      where a.id = ${parent.attemptId}::uuid
    `;
    expect(parentState).toEqual({ attemptStatus: "interrupted", turnStatus: "interrupted" });
  });

  it("terminalizes a pre-write decision after responder revocation without replaying it", async () => {
    if (!runtimeSql) throw new Error("runtime database is not initialized");
    const sql = runtimeSql;
    const executorId = "revoked-decision-responder";
    let responderRevoked = false;

    try {
      await sql`
        insert into companion_workspace_access (
          org_id, companion_id, owner_id, role, granted_by
        ) values (
          ${ids.orgA}::uuid, ${ids.companionA}::uuid, ${ids.ownerA}, 'editor', ${ids.ownerA}
        )
        on conflict (companion_id) do update
        set role = 'editor', granted_by = excluded.granted_by, updated_at = now()
      `;
      // This case isolates responder ACL revocation. Cross-actor delivery with an Owner-private
      // resource is denied separately and must never reach the delivery state machine.
      await sql`
        update companions set selected_skill_ids = '[]'::jsonb
        where org_id = ${ids.orgA}::uuid and id = ${ids.companionA}::uuid
      `;
      const gate = await gateStatus();
      const parent = await insertActiveTurnAttempt({
        companionId: ids.companionA,
        selectedSkillIds: [],
      });
      const primary = await insertDecision({
        companionId: ids.companionA,
        turnId: parent.turnId,
        attemptId: parent.attemptId,
        actorId: ids.editorA,
      });
      const [firstClaim] = await claimWork(`${executorId}-first`, gate.gateEpoch);
      expect(firstClaim).toMatchObject({
        workKind: "decision",
        workId: primary.id,
        decisionStatus: "answered",
        decisionDeliveryState: "pending",
        checkpointSequence: 0,
      });
      const [initialAuthorization] = await renewAndAuthorize(
        firstClaim!,
        `${executorId}-first`,
      );
      expect(initialAuthorization).toMatchObject({
        authorized: true,
        denialCode: null,
        authorizationActorId: ids.ownerA,
        decisionActorId: ids.editorA,
      });

      expect(await settle(firstClaim!, `${executorId}-first`, "failed", {
        errorCode: "prewrite_delivery_failed",
        errorMessage: "The response was not written and remains retryable.",
        errorAction: "retry",
      })).toBe(true);
      const [retryable] = await sql<Array<{
        decisionStatus: string;
        deliveryState: string;
        checkpoint: string;
        sequence: number;
        commandId: string | null;
        code: string | null;
        attemptStatus: string;
        turnStatus: string;
        leaseToken: string | null;
      }>>`
        select d.decision_status::text as "decisionStatus",
               d.delivery_state::text as "deliveryState", d.delivery_checkpoint as checkpoint,
               d.delivery_checkpoint_sequence::int as sequence,
               d.command_id::text as "commandId", d.last_error_code as code,
               a.status::text as "attemptStatus", t.status::text as "turnStatus",
               l.claim_token::text as "leaseToken"
        from companion_decision_deliveries d
        join companion_turn_attempts a on a.id = d.attempt_id
        join companion_turns t on t.id = d.turn_id
        join companion_runtime_leases l on l.companion_id = d.companion_id
        where d.id = ${primary.id}::uuid
      `;
      expect(retryable).toEqual({
        decisionStatus: "answered",
        deliveryState: "pending",
        checkpoint: "pending",
        sequence: 1,
        commandId: null,
        code: "prewrite_delivery_failed",
        attemptStatus: "running",
        turnStatus: "running",
        leaseToken: null,
      });

      const [retryClaim] = await claimWork(`${executorId}-retry`, gate.gateEpoch);
      expect(retryClaim).toMatchObject({
        workKind: "decision",
        workId: primary.id,
        decisionStatus: "answered",
        decisionDeliveryState: "pending",
        checkpointSequence: 1,
        claimEpoch: firstClaim!.claimEpoch + 1,
      });
      const pendingSibling = await insertDecision({
        companionId: ids.companionA,
        turnId: parent.turnId,
        attemptId: parent.attemptId,
        status: "pending",
      });
      const answeredSibling = await insertDecision({
        companionId: ids.companionA,
        turnId: parent.turnId,
        attemptId: parent.attemptId,
      });

      await sql`
        delete from memberships
        where org_id = ${ids.orgA}::uuid and user_id = ${ids.editorA}
      `;
      responderRevoked = true;
      const [revokedAuthorization] = await renewAndAuthorize(
        retryClaim!,
        `${executorId}-retry`,
      );
      expect(revokedAuthorization).toMatchObject({
        authorized: false,
        denialCode: "decision_actor_access_revoked",
        authorizationActorId: null,
        decisionActorId: null,
        modelId: null,
        providerRefs: [],
        skillRefs: [],
        mcpRefs: [],
        workCheckpoint: "pending",
        workCheckpointSequence: 1,
      });

      const terminalError = {
        errorCode: "decision_actor_access_revoked",
        errorMessage: "Decision responder access was revoked before delivery.",
        errorAction: "retry",
      };
      expect(await settle(
        retryClaim!,
        `${executorId}-retry`,
        "interrupted",
        terminalError,
      )).toBe(true);

      const decisions = await sql<Array<{
        id: string;
        decisionStatus: string;
        deliveryState: string;
        checkpoint: string;
        commandId: string | null;
        code: string | null;
        deliveredAt: Date | null;
      }>>`
        select id::text, decision_status::text as "decisionStatus",
               delivery_state::text as "deliveryState", delivery_checkpoint as checkpoint,
               command_id::text as "commandId", last_error_code as code,
               delivered_at as "deliveredAt"
        from companion_decision_deliveries
        where id in (${primary.id}::uuid, ${pendingSibling.id}::uuid, ${answeredSibling.id}::uuid)
      `;
      const decisionsById = new Map(decisions.map((row) => [row.id, row]));
      expect(decisionsById.get(primary.id)).toEqual({
        id: primary.id,
        decisionStatus: "answered",
        deliveryState: "cancelled",
        checkpoint: "cancelled",
        commandId: null,
        code: terminalError.errorCode,
        deliveredAt: null,
      });
      expect(decisionsById.get(pendingSibling.id)).toMatchObject({
        decisionStatus: "cancelled",
        deliveryState: "cancelled",
        checkpoint: "cancelled",
        commandId: null,
        code: terminalError.errorCode,
        deliveredAt: null,
      });
      expect(decisionsById.get(answeredSibling.id)).toMatchObject({
        decisionStatus: "answered",
        deliveryState: "cancelled",
        checkpoint: "cancelled",
        commandId: null,
        code: terminalError.errorCode,
        deliveredAt: null,
      });

      const [terminalParent] = await sql<Array<{
        attemptStatus: string;
        attemptCode: string | null;
        attemptSettledAt: Date | null;
        turnStatus: string;
        turnCode: string | null;
        turnSettledAt: Date | null;
        leaseToken: string | null;
        leaseWorkKind: string | null;
        leaseWorkId: string | null;
      }>>`
        select a.status::text as "attemptStatus", a.last_error_code as "attemptCode",
               a.settled_at as "attemptSettledAt", t.status::text as "turnStatus",
               t.last_error_code as "turnCode", t.settled_at as "turnSettledAt",
               l.claim_token::text as "leaseToken", l.work_kind::text as "leaseWorkKind",
               l.work_id::text as "leaseWorkId"
        from companion_turn_attempts a
        join companion_turns t on t.id = a.turn_id
        join companion_runtime_leases l on l.companion_id = a.companion_id
        where a.id = ${parent.attemptId}::uuid
      `;
      expect(terminalParent).toMatchObject({
        attemptStatus: "interrupted",
        attemptCode: terminalError.errorCode,
        turnStatus: "interrupted",
        turnCode: terminalError.errorCode,
        leaseToken: null,
        leaseWorkKind: null,
        leaseWorkId: null,
      });
      expect(terminalParent?.attemptSettledAt).toBeInstanceOf(Date);
      expect(terminalParent?.turnSettledAt).toBeInstanceOf(Date);
      expect(await claimWork(`${executorId}-replay-probe`, gate.gateEpoch)).toEqual([]);
    } finally {
      if (responderRevoked) {
        await sql`
          insert into memberships (org_id, user_id, org_role)
          values (${ids.orgA}::uuid, ${ids.editorA}, 'developer')
          on conflict (org_id, user_id) do update
          set org_role = excluded.org_role, updated_at = now()
        `;
      }
      await sql`
        delete from companion_workspace_access
        where org_id = ${ids.orgA}::uuid and companion_id = ${ids.companionA}::uuid
      `;
    }
  });

  it("preserves a Start origin timestamp while takeover increments its attempt count", async () => {
    if (!runtimeSql) throw new Error("runtime database is not initialized");
    const gate = await gateStatus();
    const operationId = await insertOperation({ companionId: ids.companionA, kind: "start" });
    const [firstClaim] = await claimWork("start-origin-first", gate.gateEpoch);
    expect(firstClaim).toMatchObject({
      workKind: "operation",
      workId: operationId,
      operationKind: "start",
      operationAttemptCount: 1,
    });
    expect(firstClaim?.operationStartedAt).toBeInstanceOf(Date);
    const originTime = firstClaim!.operationStartedAt!.getTime();

    await runtimeSql`
      update companion_runtime_leases
      set renewed_at = now() - interval '2 seconds', expires_at = now() - interval '1 second'
      where companion_id = ${ids.companionA}::uuid
    `;
    const [takeover] = await claimWork("start-origin-takeover", gate.gateEpoch);
    expect(takeover).toMatchObject({
      workKind: "operation",
      workId: operationId,
      operationKind: "start",
      operationAttemptCount: 2,
      claimEpoch: firstClaim!.claimEpoch + 1,
    });
    expect(takeover?.operationStartedAt).toBeInstanceOf(Date);
    expect(takeover!.operationStartedAt!.getTime()).toBe(originTime);

    const [authorization] = await renewAndAuthorize(takeover!, "start-origin-takeover");
    expect(authorization).toMatchObject({
      authorized: true,
      denialCode: null,
      operationKind: "start",
      operationAttemptCount: 2,
    });
    expect(authorization?.operationStartedAt).toBeInstanceOf(Date);
    expect(authorization!.operationStartedAt!.getTime()).toBe(originTime);

    const [durable] = await runtimeSql<Array<{
      startedAt: Date | null;
      attemptCount: number;
    }>>`
      select started_at as "startedAt", attempt_count::int as "attemptCount"
      from companion_operations where id = ${operationId}::uuid
    `;
    expect(durable?.startedAt).toBeInstanceOf(Date);
    expect(durable?.startedAt?.getTime()).toBe(originTime);
    expect(durable?.attemptCount).toBe(2);
    expect(await settle(takeover!, "start-origin-takeover", "failed")).toBe(true);
  });

  it("carries one cold-start deadline through Start and the attempt, expiring only before ACK", async () => {
    if (!runtimeSql) throw new Error("runtime database is not initialized");
    const sql = runtimeSql;
    const gate = await gateStatus();

    const prepareAttempt = async (
      companionId: string,
      executorPrefix: string,
      boxId: string,
      piInvocationId: string,
    ): Promise<{ claim: Claim; deadlineMs: number; piInvocationId: string }> => {
      await sql`
        update companion_runtime_instances
        set box_id = ${boxId}, box_state = 'ready', pi_state = 'idle',
            pi_invocation_id = ${`${piInvocationId}-old`}, disk_layout_version = 14
        where companion_id = ${companionId}::uuid
      `;
      const sourceTurnId = await insertQueuedTurn({ companionId });
      await sql`
        update companion_turns
        set created_at = statement_timestamp() - interval '2 minutes 52 seconds'
        where id = ${sourceTurnId}::uuid
      `;
      const startId = await insertOperation({
        companionId,
        kind: "start",
        trigger: "turn",
        sourceTurnId,
      });
      const [source] = await sql<Array<{
        createdAt: Date;
        coldStartDeadlineAt: Date;
      }>>`
        select created_at as "createdAt", cold_start_deadline_at as "coldStartDeadlineAt"
        from companion_turns where id = ${sourceTurnId}::uuid
      `;
      const deadlineMs = source!.coldStartDeadlineAt.getTime();
      expect(deadlineMs - source!.createdAt.getTime()).toBe(3 * 60 * 1_000);
      expect(deadlineMs).toBeGreaterThan(Date.now());

      const startExecutor = `${executorPrefix}-start`;
      const [startClaim] = await claimWork(startExecutor, gate.gateEpoch);
      expect(startClaim).toMatchObject({
        workKind: "operation",
        workId: startId,
        operationKind: "start",
        turnId: sourceTurnId,
      });
      expect(new Date(startClaim!.coldStartDeadlineAt!).getTime()).toBe(deadlineMs);
      const [startAuthorization] = await renewAndAuthorize(startClaim!, startExecutor);
      expect(startAuthorization).toMatchObject({
        authorized: true,
        denialCode: null,
        operationKind: "start",
      });
      expect(new Date(startAuthorization!.coldStartDeadlineAt!).getTime()).toBe(deadlineMs);

      expect(await checkpoint(startClaim!, startExecutor, "resolving_box")).toBe(1);
      expect(await observeInstance(startClaim!, startExecutor, {
        expectedSequence: 1,
        boxId,
        boxState: "ready",
      })).toBe(2);
      expect(await checkpoint(startClaim!, startExecutor, "installing_layout", {
        expectedSequence: 2,
      })).toBe(3);
      expect(await checkpoint(startClaim!, startExecutor, "starting_pi", {
        expectedSequence: 3,
      })).toBe(4);
      expect(await observeInstance(startClaim!, startExecutor, {
        expectedSequence: 4,
        boxId,
        boxState: "ready",
        piState: "idle",
        piInvocationId,
      })).toBe(5);
      expect(await checkpoint(startClaim!, startExecutor, "pi_ready", {
        expectedSequence: 5,
      })).toBe(6);
      expect(await settle(startClaim!, startExecutor, "succeeded")).toBe(true);

      const attemptExecutor = `${executorPrefix}-attempt`;
      const [attemptClaim] = await claimWork(attemptExecutor, gate.gateEpoch);
      expect(attemptClaim).toMatchObject({
        workKind: "attempt",
        turnId: sourceTurnId,
        dispatchState: "pending",
      });
      expect(new Date(attemptClaim!.coldStartDeadlineAt!).getTime()).toBe(deadlineMs);
      const [attemptAuthorization] = await renewAndAuthorize(attemptClaim!, attemptExecutor);
      expect(attemptAuthorization).toMatchObject({
        authorized: true,
        denialCode: null,
        workCheckpoint: "starting",
      });
      expect(new Date(attemptAuthorization!.coldStartDeadlineAt!).getTime()).toBe(deadlineMs);
      return { claim: attemptClaim!, deadlineMs, piInvocationId };
    };

    const accepted = await prepareAttempt(
      ids.companionA,
      "cold-deadline-accepted",
      "bx_c23dacc2",
      "pi-cold-accepted",
    );
    const acceptedCommandId = randomUUID();
    expect(await checkpoint(
      accepted.claim,
      "cold-deadline-accepted-attempt",
      "dispatch_write_intent",
      { commandId: acceptedCommandId },
    )).toBe(1);
    expect(await checkpoint(
      accepted.claim,
      "cold-deadline-accepted-attempt",
      "dispatch_accepted",
      {
        expectedSequence: 1,
        commandId: acceptedCommandId,
        piInvocationId: accepted.piInvocationId,
      },
    )).toBe(2);

    const unacknowledged = await prepareAttempt(
      ids.companionB,
      "cold-deadline-unacked",
      "bx_c23dacc3",
      "pi-cold-unacked",
    );
    const waitMilliseconds = Math.max(
      accepted.deadlineMs,
      unacknowledged.deadlineMs,
    ) - Date.now() + 25;
    if (waitMilliseconds > 0) {
      await new Promise((resolve) => setTimeout(resolve, waitMilliseconds));
    }

    const [expiredBeforeAck] = await renewAndAuthorize(
      unacknowledged.claim,
      "cold-deadline-unacked-attempt",
    );
    expect(expiredBeforeAck).toMatchObject({
      authorized: false,
      denialCode: "cold_start_deadline_exceeded",
      workCheckpoint: "starting",
    });
    expect(new Date(expiredBeforeAck!.coldStartDeadlineAt!).getTime())
      .toBe(unacknowledged.deadlineMs);

    const [acceptedAfterDeadline] = await renewAndAuthorize(
      accepted.claim,
      "cold-deadline-accepted-attempt",
    );
    expect(acceptedAfterDeadline).toMatchObject({
      authorized: true,
      denialCode: null,
      workCheckpoint: "dispatch_accepted",
    });
    expect(new Date(acceptedAfterDeadline!.coldStartDeadlineAt!).getTime())
      .toBe(accepted.deadlineMs);

    expect(await settle(
      accepted.claim,
      "cold-deadline-accepted-attempt",
      "failed",
    )).toBe(true);
    expect(await settle(
      unacknowledged.claim,
      "cold-deadline-unacked-attempt",
      "failed",
    )).toBe(true);
  });

  it("preserves the native-mobile profile for an explicit start without a source turn", async () => {
    if (!runtimeSql) throw new Error("runtime database is not initialized");
    const operationId = await insertOperation({
      companionId: ids.companionA,
      kind: "start",
      trigger: "user",
      clientSurface: "native_mobile",
    });

    const [snapshot] = await runtimeSql<Array<{
      clientSurface: string;
      canWriteSkills: boolean;
      selectedSkillIds: string[];
      skillRefs: unknown[];
      selectedMcpAccountIds: string[];
    }>>`
      select client_surface::text as "clientSurface", can_write_skills as "canWriteSkills",
             selected_skill_ids as "selectedSkillIds", skill_refs as "skillRefs",
             selected_mcp_account_ids as "selectedMcpAccountIds"
      from companion_operations where id = ${operationId}::uuid
    `;
    expect(snapshot).toEqual({
      clientSurface: "native_mobile",
      canWriteSkills: false,
      selectedSkillIds: [],
      skillRefs: [],
      selectedMcpAccountIds: [],
    });

    const gate = await gateStatus();
    const executorId = "explicit-native-start";
    const [claim] = await claimWork(executorId, gate.gateEpoch);
    expect(claim).toMatchObject({
      workKind: "operation",
      workId: operationId,
      operationKind: "start",
      turnId: null,
      clientSurface: "native_mobile",
    });
    const [authorization] = await renewAndAuthorize(claim!, executorId);
    expect(authorization).toMatchObject({
      authorized: true,
      clientSurface: "native_mobile",
      canWriteSkills: false,
      skillRefs: [],
      mcpRefs: [],
    });
    expect(await settle(claim!, executorId, "failed")).toBe(true);
  });

  it("keeps native-mobile cold starts Skill-free while restaging Skills before the next web turn", async () => {
    if (!runtimeSql) throw new Error("runtime database is not initialized");
    const sql = runtimeSql;
    const nativeMcpId = randomUUID();
    const [originalCompanion] = await sql<Array<{ canWriteSkills: boolean }>>`
      select can_write_skills as "canWriteSkills"
      from companions
      where org_id = ${ids.orgA}::uuid and id = ${ids.companionA}::uuid
    `;

    try {
      await sql`
        insert into companion_mcp_accounts (
          id, org_id, owner_id, provider, label, transport, account_config,
          ciphertext, iv, auth_tag, wrapped_dek, wrap_iv, wrap_auth_tag, key_id
        ) values (
          ${nativeMcpId}::uuid, ${ids.orgA}::uuid, ${ids.ownerA}, 'github',
          'native surface regression', 'http',
          ${sql.json({ url: "https://native-surface.example.test" })},
          'ciphertext', 'iv', 'auth-tag', 'wrapped-dek', 'wrap-iv', 'wrap-auth-tag',
          'integration-key'
        )
      `;
      await sql`
        update companions
        set can_write_skills = true,
            selected_skill_ids = ${sql.json([ids.ownerSkill])},
            selected_mcp_account_ids = ${sql.json([nativeMcpId])},
            skills_revision = 2
        where org_id = ${ids.orgA}::uuid and id = ${ids.companionA}::uuid
      `;
      await sql`
        update companion_runtime_instances
        set desired_settings_revision = 2,
            applied_settings_revision = 1,
            applied_skills_revision = 1,
            settings_actor_id = ${ids.ownerA},
            settings_available_at = now() - interval '1 second'
        where org_id = ${ids.orgA}::uuid and companion_id = ${ids.companionA}::uuid
      `;

      const nativeTurnId = await insertQueuedTurn({
        companionId: ids.companionA,
        clientSurface: "native_mobile",
      });
      const webTurnId = await insertQueuedTurn({
        companionId: ids.companionA,
        clientSurface: "web",
      });
      const startId = await insertOperation({
        companionId: ids.companionA,
        kind: "start",
        trigger: "turn",
        sourceTurnId: nativeTurnId,
      });
      const gate = await gateStatus();
      const startExecutor = "native-cold-start";
      const [startClaim] = await claimWork(startExecutor, gate.gateEpoch);
      expect(startClaim).toMatchObject({
        workKind: "operation",
        workId: startId,
        turnId: nativeTurnId,
        operationKind: "start",
        clientSurface: "native_mobile",
        targetSettingsRevision: 2,
        targetSkillsRevision: 2,
      });
      const [startAuthorization] = await renewAndAuthorize(startClaim!, startExecutor);
      expect(startAuthorization).toMatchObject({
        authorized: true,
        denialCode: null,
        clientSurface: "native_mobile",
        canWriteSkills: false,
        desiredSettingsRevision: 2,
        skillsRevision: 2,
        providerRefs: [expect.objectContaining({ provider_id: providerId })],
        skillRefs: [],
        mcpRefs: [],
      });

      expect(await checkpoint(startClaim!, startExecutor, "resolving_box")).toBe(1);
      expect(await observeInstance(startClaim!, startExecutor, {
        expectedSequence: 1,
        boxState: "absent",
        piState: "absent",
      })).toBe(2);
      expect(await checkpoint(startClaim!, startExecutor, "creating_box", {
        expectedSequence: 2,
      })).toBe(3);
      const boxId = "bx_2345abcd";
      expect(await observeInstance(startClaim!, startExecutor, {
        expectedSequence: 3,
        boxId,
        boxState: "ready",
        piState: "absent",
      })).toBe(4);
      expect(await checkpoint(startClaim!, startExecutor, "installing_layout", {
        expectedSequence: 4,
      })).toBe(5);
      expect(await observeInstance(startClaim!, startExecutor, {
        expectedSequence: 5,
        diskLayoutVersion: 14,
        appliedSettingsRevision: 2,
      })).toBe(5);
      expect(await checkpoint(startClaim!, startExecutor, "starting_pi", {
        expectedSequence: 5,
      })).toBe(6);
      const piInvocationId = "pi-native-surface";
      expect(await observeInstance(startClaim!, startExecutor, {
        expectedSequence: 6,
        boxId,
        boxState: "ready",
        piState: "idle",
        piInvocationId,
      })).toBe(7);
      expect(await checkpoint(startClaim!, startExecutor, "pi_ready", {
        expectedSequence: 7,
      })).toBe(8);
      expect(await settle(startClaim!, startExecutor, "succeeded")).toBe(true);

      const [nativeStartProjection] = await sql<Array<{
        operationStatus: string;
        appliedSettingsRevision: number;
        appliedSkillsRevision: number;
      }>>`
        select o.status::text as "operationStatus",
               i.applied_settings_revision::int as "appliedSettingsRevision",
               i.applied_skills_revision::int as "appliedSkillsRevision"
        from companion_operations o
        join companion_runtime_instances i
          on i.org_id = o.org_id and i.companion_id = o.companion_id
        where o.id = ${startId}::uuid
      `;
      expect(nativeStartProjection).toEqual({
        operationStatus: "succeeded",
        appliedSettingsRevision: 2,
        appliedSkillsRevision: 1,
      });

      const nativeExecutor = "native-turn-after-start";
      const [nativeClaim] = await claimWork(nativeExecutor, gate.gateEpoch);
      expect(nativeClaim).toMatchObject({
        workKind: "attempt",
        turnId: nativeTurnId,
        clientSurface: "native_mobile",
      });
      const [nativeAuthorization] = await renewAndAuthorize(nativeClaim!, nativeExecutor);
      expect(nativeAuthorization).toMatchObject({
        authorized: true,
        denialCode: null,
        clientSurface: "native_mobile",
        appliedSettingsRevision: 2,
        appliedSkillsRevision: 1,
        canWriteSkills: false,
        providerRefs: [expect.objectContaining({ provider_id: providerId })],
        skillRefs: [],
        mcpRefs: [],
      });
      const [nativeAttempt] = await sql<Array<{
        canWriteSkills: boolean;
        selectedSkillIds: string[];
        skillRefs: unknown[];
        selectedMcpAccountIds: string[];
      }>>`
        select can_write_skills as "canWriteSkills",
               selected_skill_ids as "selectedSkillIds", skill_refs as "skillRefs",
               selected_mcp_account_ids as "selectedMcpAccountIds"
        from companion_turn_attempts where id = ${nativeClaim!.workId}::uuid
      `;
      expect(nativeAttempt).toEqual({
        canWriteSkills: false,
        selectedSkillIds: [],
        skillRefs: [],
        selectedMcpAccountIds: [],
      });

      const nativeCommandId = randomUUID();
      expect(await checkpoint(nativeClaim!, nativeExecutor, "dispatch_write_intent", {
        commandId: nativeCommandId,
      })).toBe(1);
      expect(await checkpoint(nativeClaim!, nativeExecutor, "dispatch_accepted", {
        expectedSequence: 1,
        commandId: nativeCommandId,
        piInvocationId,
        activityAt: new Date(),
      })).toBe(2);
      expect(await checkpoint(nativeClaim!, nativeExecutor, "running", {
        expectedSequence: 2,
        commandId: nativeCommandId,
        piInvocationId,
        eventCursor: 1,
        activityAt: new Date(),
      })).toBe(3);
      expect(await checkpoint(nativeClaim!, nativeExecutor, "agent_settled", {
        expectedSequence: 3,
        commandId: nativeCommandId,
        piInvocationId,
        eventCursor: 2,
        activityAt: new Date(),
      })).toBe(4);
      expect(await settle(nativeClaim!, nativeExecutor, "succeeded")).toBe(true);

      const [webBeforeRestage] = await sql<Array<{ attemptCount: number; status: string }>>`
        select status::text,
               (select count(*)::int from companion_turn_attempts a
                where a.turn_id = t.id) as "attemptCount"
        from companion_turns t where t.id = ${webTurnId}::uuid
      `;
      expect(webBeforeRestage).toEqual({ status: "queued", attemptCount: 0 });

      const settingsExecutor = "web-skill-restage";
      const [settingsClaim] = await claimWork(settingsExecutor, gate.gateEpoch);
      expect(settingsClaim).toMatchObject({
        workKind: "settings",
        clientSurface: "web",
        checkpoint: "applying",
      });
      const [settingsAuthorization] = await renewAndAuthorize(
        settingsClaim!,
        settingsExecutor,
      );
      expect(settingsAuthorization).toMatchObject({
        authorized: true,
        denialCode: null,
        clientSurface: "web",
        canWriteSkills: true,
        desiredSettingsRevision: 2,
        skillsRevision: 2,
        skillRefs: [expect.objectContaining({ skill_id: ids.ownerSkill })],
        mcpRefs: [expect.objectContaining({ account_id: nativeMcpId })],
      });
      expect(await observeInstance(settingsClaim!, settingsExecutor, {
        piState: "idle",
        piInvocationId: "pi-web-skill-restage",
        appliedSettingsRevision: 2,
        appliedSkillsRevision: 2,
      })).toBe(settingsClaim!.checkpointSequence + 1);
      expect(await settle(settingsClaim!, settingsExecutor, "succeeded")).toBe(true);

      const webExecutor = "web-turn-after-restage";
      const [webClaim] = await claimWork(webExecutor, gate.gateEpoch);
      expect(webClaim).toMatchObject({
        workKind: "attempt",
        turnId: webTurnId,
        clientSurface: "web",
      });
      const [webAuthorization] = await renewAndAuthorize(webClaim!, webExecutor);
      expect(webAuthorization).toMatchObject({
        authorized: true,
        clientSurface: "web",
        canWriteSkills: true,
        skillRefs: [expect.objectContaining({ skill_id: ids.ownerSkill })],
        mcpRefs: [expect.objectContaining({ account_id: nativeMcpId })],
      });
      expect(await settle(webClaim!, webExecutor, "failed")).toBe(true);
    } finally {
      await resetWork();
      await sql`
        update companions set can_write_skills = ${originalCompanion?.canWriteSkills ?? false}
        where org_id = ${ids.orgA}::uuid and id = ${ids.companionA}::uuid
      `;
      await sql`
        delete from companion_mcp_accounts where id = ${nativeMcpId}::uuid
      `;
    }
  });

  it("refuses a dispatch ACK when the cold-start deadline expires after renewal", async () => {
    if (!runtimeSql) throw new Error("runtime database is not initialized");
    const sql = runtimeSql;
    const gate = await gateStatus();
    const turnId = await insertQueuedTurn({ companionId: ids.companionA });
    const executorId = "cold-deadline-after-renew";
    const [claim] = await claimWork(executorId, gate.gateEpoch);
    expect(claim).toMatchObject({
      workKind: "attempt",
      turnId,
      checkpoint: "starting",
      checkpointSequence: 0,
      dispatchState: "pending",
    });

    const commandId = randomUUID();
    expect(await checkpoint(claim!, executorId, "dispatch_write_intent", {
      commandId,
    })).toBe(1);
    await sql`
      update companion_turns
      set created_at = clock_timestamp() - interval '4 minutes',
          cold_start_deadline_at = clock_timestamp() + interval '1 minute'
      where id = ${turnId}::uuid
    `;

    const [renewed] = await renewAndAuthorize(claim!, executorId);
    expect(renewed).toMatchObject({
      authorized: true,
      denialCode: null,
      workCheckpoint: "dispatch_write_intent",
      workCheckpointSequence: 1,
    });

    // Move only the product deadline past the already-renewed lease. No wall-clock sleep is
    // involved: this isolates the checkpoint's final deadline fence from lease expiry.
    await sql`
      update companion_turns
      set cold_start_deadline_at = clock_timestamp() - interval '1 second'
      where id = ${turnId}::uuid
    `;
    expect(await checkpoint(claim!, executorId, "dispatch_accepted", {
      expectedSequence: 1,
      commandId,
      piInvocationId: "pi-too-late-for-cold-start",
      activityAt: new Date(),
    })).toBeNull();

    const [durable] = await sql<Array<{
      turnStatus: string;
      attemptStatus: string;
      checkpoint: string;
      checkpointSequence: number;
      dispatchState: string;
      piInvocationId: string | null;
      dispatchAcceptedAt: Date | null;
      inactivityDeadlineAt: Date | null;
      leaseToken: string | null;
    }>>`
      select t.status::text as "turnStatus", a.status::text as "attemptStatus",
             a.checkpoint, a.checkpoint_sequence::int as "checkpointSequence",
             a.dispatch_state::text as "dispatchState",
             a.pi_invocation_id as "piInvocationId",
             a.dispatch_accepted_at as "dispatchAcceptedAt",
             t.inactivity_deadline_at as "inactivityDeadlineAt",
             l.claim_token::text as "leaseToken"
      from companion_turns t
      join companion_turn_attempts a
        on a.org_id = t.org_id and a.companion_id = t.companion_id and a.turn_id = t.id
      join companion_runtime_leases l
        on l.org_id = t.org_id and l.companion_id = t.companion_id
      where t.id = ${turnId}::uuid
    `;
    expect(durable).toEqual({
      turnStatus: "dispatching",
      attemptStatus: "dispatching",
      checkpoint: "dispatch_write_intent",
      checkpointSequence: 1,
      dispatchState: "write_intent",
      piInvocationId: null,
      dispatchAcceptedAt: null,
      inactivityDeadlineAt: null,
      leaseToken: claim!.claimToken,
    });
    expect(await releaseLease(claim!, executorId)).toBe(true);
  });

  it("refuses success when an attempt deadline expires after renewal", async () => {
    if (!runtimeSql) throw new Error("runtime database is not initialized");
    const sql = runtimeSql;
    const gate = await gateStatus();
    const variants = [
      {
        companionId: ids.companionA,
        name: "inactivity",
        executorId: "settle-after-inactivity-deadline",
      },
      {
        companionId: ids.companionB,
        name: "absolute",
        executorId: "settle-after-absolute-deadline",
      },
    ] as const;

    for (const variant of variants) {
      const turnId = await insertQueuedTurn({ companionId: variant.companionId });
      const [claim] = await claimWork(variant.executorId, gate.gateEpoch);
      expect(claim).toMatchObject({
        workKind: "attempt",
        turnId,
        checkpoint: "starting",
      });

      const commandId = randomUUID();
      const piInvocationId = `pi-${variant.name}-deadline`;
      expect(await checkpoint(claim!, variant.executorId, "dispatch_write_intent", {
        commandId,
      })).toBe(1);
      expect(await checkpoint(claim!, variant.executorId, "dispatch_accepted", {
        expectedSequence: 1,
        commandId,
        piInvocationId,
        activityAt: new Date(),
      })).toBe(2);
      expect(await checkpoint(claim!, variant.executorId, "agent_settled", {
        expectedSequence: 2,
        commandId,
        piInvocationId,
        activityAt: new Date(),
      })).toBe(3);

      const [renewed] = await renewAndAuthorize(claim!, variant.executorId);
      expect(renewed).toMatchObject({
        authorized: true,
        denialCode: null,
        workCheckpoint: "agent_settled",
        workCheckpointSequence: 3,
      });

      if (variant.name === "inactivity") {
        await sql`
          update companion_turns
          set inactivity_deadline_at = clock_timestamp() - interval '1 second',
              absolute_deadline_at = clock_timestamp() + interval '1 hour'
          where id = ${turnId}::uuid
        `;
      } else {
        await sql`
          update companion_turns
          set inactivity_deadline_at = null,
              absolute_deadline_at = clock_timestamp() - interval '1 second'
          where id = ${turnId}::uuid
        `;
      }

      expect(await settle(claim!, variant.executorId, "succeeded")).toBe(false);
      const [durable] = await sql<Array<{
        turnStatus: string;
        attemptStatus: string;
        checkpoint: string;
        checkpointSequence: number;
        dispatchState: string;
        settledAt: Date | null;
        leaseToken: string | null;
      }>>`
        select t.status::text as "turnStatus", a.status::text as "attemptStatus",
               a.checkpoint, a.checkpoint_sequence::int as "checkpointSequence",
               a.dispatch_state::text as "dispatchState", a.settled_at as "settledAt",
               l.claim_token::text as "leaseToken"
        from companion_turns t
        join companion_turn_attempts a
          on a.org_id = t.org_id and a.companion_id = t.companion_id and a.turn_id = t.id
        join companion_runtime_leases l
          on l.org_id = t.org_id and l.companion_id = t.companion_id
        where t.id = ${turnId}::uuid
      `;
      expect(durable).toEqual({
        turnStatus: "running",
        attemptStatus: "running",
        checkpoint: "agent_settled",
        checkpointSequence: 3,
        dispatchState: "accepted",
        settledAt: null,
        leaseToken: claim!.claimToken,
      });
      expect(await settle(claim!, variant.executorId, "interrupted", {
        errorCode: `${variant.name}_deadline_exceeded`,
        errorMessage: `The ${variant.name} deadline elapsed.`,
        errorAction: "retry",
      })).toBe(true);
    }
  });

  it("requires a canonical Box id before persisting a provider Delete request", async () => {
    if (!runtimeSql) throw new Error("runtime database is not initialized");
    const gate = await gateStatus();
    const deleteId = await insertOperation({ companionId: ids.companionA, kind: "delete" });
    const executorId = "delete-without-box";
    const [deleteClaim] = await claimWork(executorId, gate.gateEpoch);
    expect(deleteClaim).toMatchObject({
      workKind: "operation",
      workId: deleteId,
      operationKind: "delete",
      checkpoint: "pending",
    });
    const [authorization] = await renewAndAuthorize(deleteClaim!, executorId);
    expect(authorization).toMatchObject({ authorized: true, boxId: null });

    await expect(checkpoint(deleteClaim!, executorId, "provider_delete_requested", {
      providerOperationId: "must-not-delete-without-canonical-box",
    })).rejects.toThrow(/canonical Box id|Box id/i);
    const [unchanged] = await runtimeSql<Array<{
      status: string;
      checkpoint: string;
      providerOperationId: string | null;
    }>>`
      select status::text, checkpoint, provider_operation_id as "providerOperationId"
      from companion_operations where id = ${deleteId}::uuid
    `;
    expect(unchanged).toEqual({
      status: "running",
      checkpoint: "pending",
      providerOperationId: null,
    });
    expect(await settle(deleteClaim!, executorId, "failed")).toBe(true);
  });

  it("deletes the aggregate only after provider proof and retains workspace resources plus audit", async () => {
    if (!runtimeSql) throw new Error("runtime database is not initialized");
    const gate = await gateStatus();
    const retainedMcpId = randomUUID();
    await runtimeSql`
      update companion_runtime_instances
      set box_id = 'bx_2345678a', box_state = 'ready'
      where companion_id = ${ids.companionA}::uuid
    `;
    await runtimeSql`
      insert into companion_threads (org_id, companion_id, next_ordinal, last_message_at)
      values (${ids.orgA}::uuid, ${ids.companionA}::uuid, 1, clock_timestamp())
    `;
    await runtimeSql`
      insert into companion_transcript_entries (
        org_id, companion_id, event_id, ordinal, role, content, author_id
      ) values (
        ${ids.orgA}::uuid, ${ids.companionA}::uuid, 'runtime-delete-fixture', 0, 'user',
        'Delete only after provider proof.', ${ids.ownerA}
      )
    `;
    await runtimeSql`
      insert into companion_mcp_accounts (
        id, org_id, owner_id, provider, label, transport, account_config,
        ciphertext, iv, auth_tag, wrapped_dek, wrap_iv, wrap_auth_tag, key_id
      ) values (
        ${retainedMcpId}::uuid, ${ids.orgA}::uuid, ${ids.ownerA}, 'github',
        'delete retention fixture', 'http',
        ${runtimeSql.json({ url: "https://delete-retention.example.test" })},
        'ciphertext', 'iv', 'auth-tag', 'wrapped-dek', 'wrap-iv', 'wrap-auth-tag',
        'integration-key'
      )
    `;
    const pendingIds = await Promise.all([
      insertOperation({ companionId: ids.companionA, kind: "start" }),
      insertOperation({ companionId: ids.companionA, kind: "stop" }),
      insertOperation({
        companionId: ids.companionA,
        kind: "apply_settings",
        targetSettingsRevision: 1,
        targetSkillsRevision: 1,
      }),
    ]);
    const deleteId = await insertOperation({ companionId: ids.companionA, kind: "delete" });
    const [deleteClaim] = await claimWork("terminal-delete-replica", gate.gateEpoch);
    expect(deleteClaim).toMatchObject({ workKind: "operation", workId: deleteId, operationKind: "delete" });
    const cancelled = await runtimeSql<Array<{ id: string; status: string; settledAt: Date | null }>>`
      select id::text, status::text, settled_at as "settledAt"
      from companion_operations where id = any(${pendingIds}::uuid[]) order by id
    `;
    expect(cancelled).toHaveLength(pendingIds.length);
    expect(cancelled.every((row) => row.status === "cancelled" && row.settledAt instanceof Date))
      .toBe(true);

    const providerDeleteId = "provider-delete-proof";
    expect(await checkpoint(deleteClaim!, "terminal-delete-replica", "provider_delete_requested", {
      providerOperationId: providerDeleteId,
    })).toBe(1);
    expect(await releaseLease(deleteClaim!, "terminal-delete-replica")).toBe(true);
    const [deleteTakeover] = await claimWork("terminal-delete-takeover", gate.gateEpoch);
    expect(deleteTakeover).toMatchObject({
      workId: deleteId,
      checkpoint: "provider_delete_requested",
      checkpointSequence: 1,
      providerOperationId: providerDeleteId,
      targetSettingsRevision: null,
      targetSkillsRevision: null,
    });
    const [deleteAuthorization] = await renewAndAuthorize(
      deleteTakeover!,
      "terminal-delete-takeover",
    );
    expect(deleteAuthorization).toMatchObject({
      authorized: true,
      providerOperationId: providerDeleteId,
      targetSettingsRevision: null,
      targetSkillsRevision: null,
    });
    expect(await checkpoint(deleteTakeover!, "terminal-delete-takeover", "waiting_deleted", {
      expectedSequence: 1,
      providerOperationId: providerDeleteId,
    })).toBe(2);
    await expect(settle(deleteTakeover!, "terminal-delete-takeover", "succeeded"))
      .rejects.toThrow(/terminal checkpoint proof/);
    const [beforeProof] = await runtimeSql<Array<{
      companionCount: number;
      runtimeCount: number;
      threadCount: number;
    }>>`
      select
        (select count(*)::int from companions where id = ${ids.companionA}::uuid) as "companionCount",
        (select count(*)::int from companion_runtime_instances
          where companion_id = ${ids.companionA}::uuid) as "runtimeCount",
        (select count(*)::int from companion_threads
          where companion_id = ${ids.companionA}::uuid) as "threadCount"
    `;
    expect(beforeProof).toEqual({ companionCount: 1, runtimeCount: 1, threadCount: 1 });
    expect(await observeInstance(deleteTakeover!, "terminal-delete-takeover", {
      expectedSequence: 2,
      boxState: "absent",
      piState: "absent",
    })).toBe(3);
    expect(await settle(deleteTakeover!, "terminal-delete-takeover", "succeeded")).toBe(true);
    const [durable] = await runtimeSql<Array<{
      companionCount: number;
      threadCount: number;
      transcriptCount: number;
      runtimeCount: number;
      turnCount: number;
      attemptCount: number;
      operationCount: number;
      leaseCount: number;
      auditCount: number;
      auditActor: string | null;
      providerCount: number;
      mcpCount: number;
      skillCount: number;
    }>>`
      select
        (select count(*)::int from companions where id = ${ids.companionA}::uuid) as "companionCount",
        (select count(*)::int from companion_threads
          where companion_id = ${ids.companionA}::uuid) as "threadCount",
        (select count(*)::int from companion_transcript_entries
          where companion_id = ${ids.companionA}::uuid) as "transcriptCount",
        (select count(*)::int from companion_runtime_instances
          where companion_id = ${ids.companionA}::uuid) as "runtimeCount",
        (select count(*)::int from companion_turns
          where companion_id = ${ids.companionA}::uuid) as "turnCount",
        (select count(*)::int from companion_turn_attempts
          where companion_id = ${ids.companionA}::uuid) as "attemptCount",
        (select count(*)::int from companion_operations
          where companion_id = ${ids.companionA}::uuid) as "operationCount",
        (select count(*)::int from companion_runtime_leases
          where companion_id = ${ids.companionA}::uuid) as "leaseCount",
        (select count(*)::int from audit_log
          where action = 'companion.deleted' and target_id = ${ids.companionA}
            and metadata ->> 'operation_id' = ${deleteId}) as "auditCount",
        (select actor_id from audit_log
          where action = 'companion.deleted' and target_id = ${ids.companionA}
            and metadata ->> 'operation_id' = ${deleteId}) as "auditActor",
        (select count(*)::int from companion_provider_connections
          where org_id = ${ids.orgA}::uuid and provider_id = ${providerId}) as "providerCount",
        (select count(*)::int from companion_mcp_accounts
          where id = ${retainedMcpId}::uuid) as "mcpCount",
        (select count(*)::int from skills where id = ${ids.ownerSkill}::uuid) as "skillCount"
    `;
    expect(durable).toEqual({
      companionCount: 0,
      threadCount: 0,
      transcriptCount: 0,
      runtimeCount: 0,
      turnCount: 0,
      attemptCount: 0,
      operationCount: 0,
      leaseCount: 0,
      auditCount: 1,
      auditActor: ids.ownerA,
      providerCount: 1,
      mcpCount: 1,
      skillCount: 1,
    });

    await expect(insertOperation({ companionId: ids.companionA, kind: "start" }))
      .rejects.toThrow(/runtime instance does not exist|foreign key|companion_operations_runtime_instance_fk/i);
    expect(await claimWork("post-retirement-replica", gate.gateEpoch)).toEqual([]);
    await runtimeSql`delete from companion_mcp_accounts where id = ${retainedMcpId}::uuid`;
  });

  it("requires observation-derived terminal proof for stop and apply-settings success", async () => {
    if (!runtimeSql) throw new Error("runtime database is not initialized");
    let gate = await gateStatus();
    const boxId = "bx_56789abc";
    await runtimeSql`
      update companion_runtime_instances
      set box_id = ${boxId}, box_state = 'ready', pi_state = 'idle',
          pi_invocation_id = 'pi-stop-proof'
      where companion_id = ${ids.companionA}::uuid
    `;
    const stopId = await insertOperation({ companionId: ids.companionA, kind: "stop" });
    const [stopClaim] = await claimWork("terminal-stop-replica", gate.gateEpoch);
    expect(stopClaim?.workId).toBe(stopId);
    expect(await checkpoint(stopClaim!, "terminal-stop-replica", "stopping_pi")).toBe(1);
    expect(await checkpoint(stopClaim!, "terminal-stop-replica", "provider_stop_requested", {
      expectedSequence: 1,
    })).toBe(2);
    expect(await checkpoint(stopClaim!, "terminal-stop-replica", "waiting_archived", {
      expectedSequence: 2,
    })).toBe(3);
    await expect(settle(stopClaim!, "terminal-stop-replica", "succeeded"))
      .rejects.toThrow(/terminal checkpoint proof/);
    expect(await observeInstance(stopClaim!, "terminal-stop-replica", {
      expectedSequence: 3,
      boxId,
      boxState: "archived",
      piState: "stopped",
    })).toBe(4);
    expect(await settle(stopClaim!, "terminal-stop-replica", "succeeded")).toBe(true);
    const [stopped] = await runtimeSql<Array<{
      status: string;
      checkpoint: string;
      boxState: string;
    }>>`
      select o.status::text, o.checkpoint, i.box_state::text as "boxState"
      from companion_operations o join companion_runtime_instances i
        on i.org_id = o.org_id and i.companion_id = o.companion_id
      where o.id = ${stopId}::uuid
    `;
    expect(stopped).toEqual({ status: "succeeded", checkpoint: "box_archived", boxState: "archived" });

    await resetWork();
    gate = await gateStatus();
    await runtimeSql`
      update companion_runtime_instances
      set box_id = ${boxId}, box_state = 'ready', desired_settings_revision = 2,
          applied_settings_revision = 1
      where companion_id = ${ids.companionA}::uuid
    `;
    const applyId = await insertOperation({
      companionId: ids.companionA,
      kind: "apply_settings",
      targetSettingsRevision: 2,
      targetSkillsRevision: 1,
    });
    const [applyClaim] = await claimWork("terminal-settings-replica", gate.gateEpoch);
    expect(applyClaim).toMatchObject({
      workId: applyId,
      targetSettingsRevision: 2,
      targetSkillsRevision: 1,
    });
    expect(await checkpoint(applyClaim!, "terminal-settings-replica", "applying_settings")).toBe(1);
    expect(await releaseLease(applyClaim!, "terminal-settings-replica")).toBe(true);
    const [applyTakeover] = await claimWork("terminal-settings-takeover", gate.gateEpoch);
    expect(applyTakeover).toMatchObject({
      workId: applyId,
      checkpoint: "applying_settings",
      checkpointSequence: 1,
      providerOperationId: null,
      targetSettingsRevision: 2,
      targetSkillsRevision: 1,
    });
    const [applyAuthorization] = await renewAndAuthorize(
      applyTakeover!,
      "terminal-settings-takeover",
    );
    expect(applyAuthorization).toMatchObject({
      authorized: true,
      boxId,
      boxState: "ready",
      piState: "absent",
      piInvocationId: null,
      diskLayoutVersion: 0,
      appliedSettingsRevision: 1,
      appliedSkillsRevision: 1,
      providerOperationId: null,
      targetSettingsRevision: 2,
      targetSkillsRevision: 1,
    });
    await expect(settle(applyTakeover!, "terminal-settings-takeover", "succeeded"))
      .rejects.toThrow(/terminal checkpoint proof/);
    await expect(observeInstance(applyTakeover!, "terminal-settings-takeover", {
      expectedSequence: 1,
      piState: "idle",
      piInvocationId: "pi-terminal-settings-invalid",
      appliedSettingsRevision: 1,
      appliedSkillsRevision: 1,
    })).rejects.toThrow(/exact revisions and a new idle Pi invocation/);
    expect(await observeInstance(applyTakeover!, "terminal-settings-takeover", {
      expectedSequence: 1,
      piState: "idle",
      piInvocationId: "pi-terminal-settings-applied",
      appliedSettingsRevision: 2,
      appliedSkillsRevision: 1,
    })).toBe(2);
    expect(await settle(applyTakeover!, "terminal-settings-takeover", "succeeded")).toBe(true);
    const [applied] = await runtimeSql<Array<{
      status: string;
      checkpoint: string;
      appliedRevision: number;
      piState: string;
      piInvocationId: string;
    }>>`
      select o.status::text, o.checkpoint,
             i.applied_settings_revision::int as "appliedRevision",
             i.pi_state::text as "piState", i.pi_invocation_id as "piInvocationId"
      from companion_operations o join companion_runtime_instances i
        on i.org_id = o.org_id and i.companion_id = o.companion_id
      where o.id = ${applyId}::uuid
    `;
    expect(applied).toEqual({
      status: "succeeded",
      checkpoint: "settings_applied",
      appliedRevision: 2,
      piState: "idle",
      piInvocationId: "pi-terminal-settings-applied",
    });
  });

  it("claims every Skill invalidation persisted while the runtime gate is disabled", async () => {
    if (!runtimeSql) throw new Error("runtime database is not initialized");
    const initialGate = await gateStatus();
    const disabled = await disableGate(initialGate.gateEpoch);
    expect(disabled).toEqual({ enabled: false, gateEpoch: initialGate.gateEpoch + 1 });

    await runtimeSql`
      update companion_runtime_instances
      set box_id = 'bx_5679abcd', box_state = 'ready',
          desired_settings_revision = 1, applied_settings_revision = 1,
          applied_skills_revision = 1, settings_actor_id = ${ids.ownerA},
          settings_available_at = now() - interval '1 second'
      where org_id = ${ids.orgA}::uuid and companion_id = ${ids.companionA}::uuid
    `;
    // The API route tests exercise rename, archive, and restore with the feature flag off. These
    // three committed increments model those same durable invalidations while claims are gated.
    await runtimeSql`
      update companions
      set skills_revision = skills_revision + 3
      where org_id = ${ids.orgA}::uuid and id = ${ids.companionA}::uuid
    `;
    const queuedTurnId = await insertQueuedTurn({ companionId: ids.companionA });
    expect(await claimWork("disabled-skill-invalidation", disabled.gateEpoch)).toEqual([]);

    const [beforeEnable] = await runtimeSql<Array<{
      skillsRevision: number;
      appliedSkillsRevision: number;
    }>>`
      select c.skills_revision::int as "skillsRevision",
             i.applied_skills_revision::int as "appliedSkillsRevision"
      from companions c join companion_runtime_instances i
        on i.org_id = c.org_id and i.companion_id = c.id
      where c.org_id = ${ids.orgA}::uuid and c.id = ${ids.companionA}::uuid
    `;
    expect(beforeEnable).toEqual({ skillsRevision: 4, appliedSkillsRevision: 1 });

    const enabled = await ensureEnabled();
    expect(enabled.gateEpoch).toBe(disabled.gateEpoch + 1);
    const [settingsClaim] = await claimWork(
      "reenabled-skill-invalidation",
      enabled.gateEpoch,
    );
    expect(settingsClaim).toMatchObject({
      companionId: ids.companionA,
      workKind: "settings",
      workId: ids.companionA,
      actorId: ids.ownerA,
      turnId: queuedTurnId,
      checkpoint: "applying",
      checkpointSequence: 1,
    });
    const [authorization] = await renewAndAuthorize(
      settingsClaim!,
      "reenabled-skill-invalidation",
    );
    expect(authorization).toMatchObject({
      authorized: true,
      skillsRevision: 4,
      appliedSkillsRevision: 1,
    });
    expect(await settle(settingsClaim!, "reenabled-skill-invalidation", "failed", {
      errorCode: "fixture_complete",
      errorMessage: "The durable Skill invalidation fixture completed.",
      errorAction: "retry",
    })).toBe(true);
  });

  it("settles implicit settings work only after observing the exact claimed revisions", async () => {
    if (!runtimeSql) throw new Error("runtime database is not initialized");
    const gate = await gateStatus();
    const boxId = "bx_6789abcd";
    await runtimeSql`
      update companion_runtime_instances
      set box_id = ${boxId}, box_state = 'ready',
          pi_state = 'idle', pi_invocation_id = 'pi-implicit-settings-old',
          desired_settings_revision = 2, applied_settings_revision = 1,
          applied_skills_revision = 1, settings_actor_id = ${ids.ownerA},
          settings_available_at = now() - interval '1 second'
      where org_id = ${ids.orgA}::uuid and companion_id = ${ids.companionA}::uuid
    `;
    await runtimeSql`
      update companions
      set skills_revision = 2
      where org_id = ${ids.orgA}::uuid and id = ${ids.companionA}::uuid
    `;

    const [settingsClaim] = await claimWork("implicit-settings-replica", gate.gateEpoch);
    expect(settingsClaim).toMatchObject({
      orgId: ids.orgA,
      companionId: ids.companionA,
      workKind: "settings",
      workId: ids.companionA,
      actorId: ids.ownerA,
      checkpoint: "applying",
      checkpointSequence: 1,
    });
    expect(await settle(settingsClaim!, "implicit-settings-replica", "succeeded")).toBe(false);
    await expect(observeInstance(settingsClaim!, "implicit-settings-replica", {
      appliedSettingsRevision: 2,
      appliedSkillsRevision: 2,
    })).rejects.toThrow(/exact revisions and a new idle Pi invocation/);
    await expect(observeInstance(settingsClaim!, "implicit-settings-replica", {
      piState: "idle",
      piInvocationId: "pi-implicit-settings-old",
      appliedSettingsRevision: 2,
      appliedSkillsRevision: 2,
    })).rejects.toThrow(/exact revisions and a new idle Pi invocation/);

    expect(await observeInstance(settingsClaim!, "implicit-settings-replica", {
      piState: "idle",
      piInvocationId: "pi-implicit-settings-new",
      appliedSettingsRevision: 2,
      appliedSkillsRevision: 2,
    })).toBe(2);
    expect(await observeInstance(settingsClaim!, "implicit-settings-replica", {
      piState: "idle",
      piInvocationId: "pi-implicit-settings-new",
      appliedSettingsRevision: 2,
      appliedSkillsRevision: 2,
    })).toBeNull();
    const [observed] = await runtimeSql<Array<{
      checkpoint: string;
      sequence: number;
      appliedSettings: number;
      appliedSkills: number;
      piState: string;
      piInvocationId: string;
      claimRevision: number | null;
      claimSkillsRevision: number | null;
      leaseToken: string | null;
    }>>`
      select i.settings_checkpoint as checkpoint,
             i.settings_checkpoint_sequence::int as sequence,
             i.applied_settings_revision::int as "appliedSettings",
             i.applied_skills_revision::int as "appliedSkills",
             i.pi_state::text as "piState", i.pi_invocation_id as "piInvocationId",
             i.settings_claim_revision::int as "claimRevision",
             i.settings_claim_skills_revision::int as "claimSkillsRevision",
             l.claim_token::text as "leaseToken"
      from companion_runtime_instances i
      left join companion_runtime_leases l
        on l.org_id = i.org_id and l.companion_id = i.companion_id
      where i.org_id = ${ids.orgA}::uuid and i.companion_id = ${ids.companionA}::uuid
    `;
    expect(observed).toEqual({
      checkpoint: "applied",
      sequence: 2,
      appliedSettings: 1,
      appliedSkills: 1,
      piState: "idle",
      piInvocationId: "pi-implicit-settings-new",
      claimRevision: 2,
      claimSkillsRevision: 2,
      leaseToken: settingsClaim!.claimToken,
    });

    expect(await settle(settingsClaim!, "implicit-settings-replica", "succeeded")).toBe(true);
    const [settled] = await runtimeSql<Array<{
      checkpoint: string;
      sequence: number;
      appliedSettings: number;
      appliedSkills: number;
      piState: string;
      piInvocationId: string;
      claimEpoch: number | null;
      claimActor: string | null;
      claimRevision: number | null;
      claimSkillsRevision: number | null;
      leaseToken: string | null;
    }>>`
      select i.settings_checkpoint as checkpoint,
             i.settings_checkpoint_sequence::int as sequence,
             i.applied_settings_revision::int as "appliedSettings",
             i.applied_skills_revision::int as "appliedSkills",
             i.pi_state::text as "piState", i.pi_invocation_id as "piInvocationId",
             i.settings_claim_epoch::int as "claimEpoch",
             i.settings_claim_actor_id as "claimActor",
             i.settings_claim_revision::int as "claimRevision",
             i.settings_claim_skills_revision::int as "claimSkillsRevision",
             l.claim_token::text as "leaseToken"
      from companion_runtime_instances i
      left join companion_runtime_leases l
        on l.org_id = i.org_id and l.companion_id = i.companion_id
      where i.org_id = ${ids.orgA}::uuid and i.companion_id = ${ids.companionA}::uuid
    `;
    expect(settled).toEqual({
      checkpoint: "applied",
      sequence: 3,
      appliedSettings: 2,
      appliedSkills: 2,
      piState: "idle",
      piInvocationId: "pi-implicit-settings-new",
      claimEpoch: null,
      claimActor: null,
      claimRevision: null,
      claimSkillsRevision: null,
      leaseToken: null,
    });
  });

  it("binds implicit settings work to the oldest cold turn and fences every post-deadline write", async () => {
    if (!runtimeSql) throw new Error("runtime database is not initialized");
    const sql = runtimeSql;
    const oldestTurnId = await insertQueuedTurn({ companionId: ids.companionA });
    const laterTurnId = await insertQueuedTurn({ companionId: ids.companionA });
    await sql`
      update companion_turns
      set created_at = case
            when id = ${oldestTurnId}::uuid then clock_timestamp() - interval '2 minutes 59 seconds'
            else clock_timestamp() - interval '1 minute'
          end,
          cold_start_deadline_at = case
            when id = ${oldestTurnId}::uuid then clock_timestamp() + interval '1 second'
            else clock_timestamp() + interval '2 minutes'
          end
      where id in (${oldestTurnId}::uuid, ${laterTurnId}::uuid)
    `;
    await sql`
      update companion_runtime_instances
      set desired_settings_revision = 2, applied_settings_revision = 1,
          settings_actor_id = ${ids.ownerA}, settings_available_at = now() - interval '1 second'
      where org_id = ${ids.orgA}::uuid and companion_id = ${ids.companionA}::uuid
    `;

    const gate = await gateStatus();
    const executorId = "cold-implicit-settings";
    const [claim] = await claimWork(executorId, gate.gateEpoch);
    expect(claim).toMatchObject({
      workKind: "settings",
      workId: ids.companionA,
      turnId: oldestTurnId,
      clientSurface: "web",
      checkpoint: "applying",
      checkpointSequence: 1,
    });
    expect(claim?.coldStartDeadlineAt).not.toBeNull();

    const [captured] = await sql<Array<{
      claimTurnId: string | null;
      claimDeadline: Date | null;
      oldestDeadline: Date;
      laterDeadline: Date;
    }>>`
      select i.settings_claim_turn_id::text as "claimTurnId",
             i.settings_claim_cold_start_deadline_at as "claimDeadline",
             oldest.cold_start_deadline_at as "oldestDeadline",
             later.cold_start_deadline_at as "laterDeadline"
      from companion_runtime_instances i
      join companion_turns oldest on oldest.id = ${oldestTurnId}::uuid
      join companion_turns later on later.id = ${laterTurnId}::uuid
      where i.org_id = ${ids.orgA}::uuid and i.companion_id = ${ids.companionA}::uuid
    `;
    expect(captured?.claimTurnId).toBe(oldestTurnId);
    expect(captured?.claimDeadline?.getTime()).toBe(captured?.oldestDeadline.getTime());
    expect(new Date(claim!.coldStartDeadlineAt!).getTime()).toBe(captured?.oldestDeadline.getTime());
    expect(captured!.oldestDeadline.getTime()).toBeLessThan(captured!.laterDeadline.getTime());

    const [authorized] = await renewAndAuthorize(claim!, executorId);
    expect(authorized).toMatchObject({
      authorized: true,
      denialCode: null,
      coldStartDeadlineAt: expect.anything(),
    });

    const waitMilliseconds = captured!.oldestDeadline.getTime() - Date.now() + 25;
    if (waitMilliseconds > 0) {
      await new Promise((resolve) => setTimeout(resolve, waitMilliseconds));
    }

    const [expired] = await renewAndAuthorize(claim!, executorId);
    expect(expired).toMatchObject({
      authorized: false,
      denialCode: "cold_start_deadline_exceeded",
    });
    expect(await checkpoint(claim!, executorId, "applying")).toBeNull();
    expect(await observeInstance(claim!, executorId, {
      appliedSettingsRevision: 2,
      appliedSkillsRevision: 1,
    })).toBeNull();
    expect(await settle(claim!, executorId, "succeeded")).toBe(false);
    expect(await settle(claim!, executorId, "interrupted", {
      errorCode: "cold_start_deadline_exceeded",
      errorMessage: "The cold-start deadline elapsed while applying settings.",
      errorAction: "retry",
    })).toBe(true);

    const [durable] = await sql<Array<{
      oldestStatus: string;
      oldestSettledAt: Date | null;
      oldestAbsoluteDeadlineAt: Date | null;
      oldestErrorCode: string | null;
      laterStatus: string;
      settingsCheckpoint: string;
      nonNullClaimFields: number;
      leaseToken: string | null;
    }>>`
      select oldest.status::text as "oldestStatus",
             oldest.settled_at as "oldestSettledAt",
             oldest.absolute_deadline_at as "oldestAbsoluteDeadlineAt",
             oldest.last_error_code as "oldestErrorCode",
             later.status::text as "laterStatus",
             i.settings_checkpoint as "settingsCheckpoint",
             num_nonnulls(
               i.settings_claim_epoch, i.settings_claim_actor_id,
               i.settings_claim_client_surface, i.settings_claim_turn_id,
               i.settings_claim_cold_start_deadline_at, i.settings_claim_revision,
               i.settings_claim_skills_revision, i.settings_claim_model_id,
               i.settings_claim_persona, i.settings_claim_can_write_skills,
               i.settings_claim_provider_ids, i.settings_claim_selected_skill_ids,
               i.settings_claim_skill_refs, i.settings_claim_selected_mcp_account_ids
             )::int as "nonNullClaimFields",
             l.claim_token::text as "leaseToken"
      from companion_runtime_instances i
      join companion_turns oldest on oldest.id = ${oldestTurnId}::uuid
      join companion_turns later on later.id = ${laterTurnId}::uuid
      left join companion_runtime_leases l
        on l.org_id = i.org_id and l.companion_id = i.companion_id
      where i.org_id = ${ids.orgA}::uuid and i.companion_id = ${ids.companionA}::uuid
    `;
    expect(durable).toMatchObject({
      oldestStatus: "interrupted",
      oldestSettledAt: expect.any(Date),
      oldestAbsoluteDeadlineAt: expect.any(Date),
      oldestErrorCode: "cold_start_deadline_exceeded",
      laterStatus: "queued",
      settingsCheckpoint: "pending",
      nonNullClaimFields: 0,
      leaseToken: null,
    });
  });

  it("rebinds a stale apply-settings source to the oldest cold turn and fences its deadline", async () => {
    if (!runtimeSql) throw new Error("runtime database is not initialized");
    const sql = runtimeSql;
    const staleTurnId = await insertQueuedTurn({ companionId: ids.companionA });
    await sql`
      update companion_runtime_instances
      set box_id = 'bx_789abcde', box_state = 'ready',
          desired_settings_revision = 2, applied_settings_revision = 1
      where org_id = ${ids.orgA}::uuid and companion_id = ${ids.companionA}::uuid
    `;
    const operationId = await insertOperation({
      companionId: ids.companionA,
      kind: "apply_settings",
      sourceTurnId: staleTurnId,
    });
    await sql`
      update companion_turns
      set status = 'cancelled', settled_at = clock_timestamp(), state_changed_at = clock_timestamp()
      where id = ${staleTurnId}::uuid
    `;

    const oldestTurnId = await insertQueuedTurn({ companionId: ids.companionA });
    const laterTurnId = await insertQueuedTurn({ companionId: ids.companionA });
    await sql`
      update companion_turns
      set created_at = case
            when id = ${oldestTurnId}::uuid then clock_timestamp() - interval '2 minutes 59 seconds'
            else clock_timestamp() - interval '1 minute'
          end,
          cold_start_deadline_at = case
            when id = ${oldestTurnId}::uuid then clock_timestamp() + interval '1 second'
            else clock_timestamp() + interval '2 minutes'
          end
      where id in (${oldestTurnId}::uuid, ${laterTurnId}::uuid)
    `;

    const gate = await gateStatus();
    const executorId = "cold-explicit-settings";
    const [claim] = await claimWork(executorId, gate.gateEpoch);
    expect(claim).toMatchObject({
      workKind: "operation",
      workId: operationId,
      operationKind: "apply_settings",
      turnId: oldestTurnId,
      clientSurface: "web",
      checkpoint: "pending",
      checkpointSequence: 0,
      targetSettingsRevision: 2,
      targetSkillsRevision: 1,
    });
    expect(claim?.coldStartDeadlineAt).not.toBeNull();

    const [rebound] = await sql<Array<{
      sourceTurnId: string | null;
      sourceDeadline: Date;
      operationStatus: string;
      staleStatus: string;
    }>>`
      select o.source_turn_id::text as "sourceTurnId",
             source.cold_start_deadline_at as "sourceDeadline",
             o.status::text as "operationStatus", stale.status::text as "staleStatus"
      from companion_operations o
      join companion_turns source on source.id = o.source_turn_id
      join companion_turns stale on stale.id = ${staleTurnId}::uuid
      where o.id = ${operationId}::uuid
    `;
    expect(rebound).toMatchObject({
      sourceTurnId: oldestTurnId,
      operationStatus: "running",
      staleStatus: "cancelled",
    });
    expect(new Date(claim!.coldStartDeadlineAt!).getTime()).toBe(rebound?.sourceDeadline.getTime());

    const [authorized] = await renewAndAuthorize(claim!, executorId);
    expect(authorized).toMatchObject({ authorized: true, denialCode: null });

    const waitMilliseconds = rebound!.sourceDeadline.getTime() - Date.now() + 25;
    if (waitMilliseconds > 0) {
      await new Promise((resolve) => setTimeout(resolve, waitMilliseconds));
    }

    const [expired] = await renewAndAuthorize(claim!, executorId);
    expect(expired).toMatchObject({
      authorized: false,
      denialCode: "cold_start_deadline_exceeded",
      operationKind: "apply_settings",
    });
    expect(await checkpoint(claim!, executorId, "applying_settings")).toBeNull();
    expect(await observeInstance(claim!, executorId, {
      appliedSettingsRevision: 2,
      appliedSkillsRevision: 1,
    })).toBeNull();
    expect(await settle(claim!, executorId, "succeeded")).toBe(false);
    expect(await settle(claim!, executorId, "interrupted", {
      errorCode: "cold_start_deadline_exceeded",
      errorMessage: "The cold-start deadline elapsed before settings were applied.",
      errorAction: "retry",
    })).toBe(true);

    const [durable] = await sql<Array<{
      operationStatus: string;
      operationSettledAt: Date | null;
      operationErrorCode: string | null;
      sourceTurnId: string | null;
      sourceStatus: string;
      sourceSettledAt: Date | null;
      sourceAbsoluteDeadlineAt: Date | null;
      sourceErrorCode: string | null;
      staleStatus: string;
      laterStatus: string;
      leaseToken: string | null;
    }>>`
      select o.status::text as "operationStatus", o.settled_at as "operationSettledAt",
             o.last_error_code as "operationErrorCode",
             o.source_turn_id::text as "sourceTurnId",
             source.status::text as "sourceStatus", source.settled_at as "sourceSettledAt",
             source.absolute_deadline_at as "sourceAbsoluteDeadlineAt",
             source.last_error_code as "sourceErrorCode",
             stale.status::text as "staleStatus", later.status::text as "laterStatus",
             l.claim_token::text as "leaseToken"
      from companion_operations o
      join companion_turns source on source.id = o.source_turn_id
      join companion_turns stale on stale.id = ${staleTurnId}::uuid
      join companion_turns later on later.id = ${laterTurnId}::uuid
      left join companion_runtime_leases l
        on l.org_id = o.org_id and l.companion_id = o.companion_id
      where o.id = ${operationId}::uuid
    `;
    expect(durable).toMatchObject({
      operationStatus: "interrupted",
      operationSettledAt: expect.any(Date),
      operationErrorCode: "cold_start_deadline_exceeded",
      sourceTurnId: oldestTurnId,
      sourceStatus: "interrupted",
      sourceSettledAt: expect.any(Date),
      sourceAbsoluteDeadlineAt: expect.any(Date),
      sourceErrorCode: "cold_start_deadline_exceeded",
      staleStatus: "cancelled",
      laterStatus: "queued",
      leaseToken: null,
    });
  });

  it("keeps a native apply-settings snapshot across a web rebind, then restages web", async () => {
    if (!runtimeSql) throw new Error("runtime database is not initialized");
    const sql = runtimeSql;
    await resetWork();
    await sql`
      update companion_runtime_instances
      set box_id = 'bx_789abcde', box_state = 'ready',
          desired_settings_revision = 2, applied_settings_revision = 1,
          applied_skills_revision = 1, applied_client_surface = 'web',
          settings_actor_id = ${ids.ownerA}, settings_available_at = now() - interval '1 second'
      where org_id = ${ids.orgA}::uuid and companion_id = ${ids.companionA}::uuid
    `;

    const staleNativeTurnId = await insertQueuedTurn({
      companionId: ids.companionA,
      clientSurface: "native_mobile",
    });
    const operationId = await insertOperation({
      companionId: ids.companionA,
      kind: "apply_settings",
      sourceTurnId: staleNativeTurnId,
    });
    await sql`
      update companion_turns
      set status = 'cancelled', settled_at = clock_timestamp(), state_changed_at = clock_timestamp()
      where id = ${staleNativeTurnId}::uuid
    `;
    const webTurnId = await insertQueuedTurn({ companionId: ids.companionA });

    const gate = await gateStatus();
    const operationExecutor = "native-settings-web-rebind";
    const [operationClaim] = await claimWork(operationExecutor, gate.gateEpoch);
    expect(operationClaim).toMatchObject({
      workKind: "operation",
      workId: operationId,
      operationKind: "apply_settings",
      turnId: webTurnId,
      clientSurface: "native_mobile",
      targetSettingsRevision: 2,
      targetSkillsRevision: 1,
    });
    const [operationAuthorization] = await renewAndAuthorize(operationClaim!, operationExecutor);
    expect(operationAuthorization).toMatchObject({
      authorized: true,
      clientSurface: "native_mobile",
      canWriteSkills: false,
      skillRefs: [],
      mcpRefs: [],
    });
    expect(await checkpoint(operationClaim!, operationExecutor, "applying_settings")).toBe(1);
    expect(await observeInstance(operationClaim!, operationExecutor, {
      expectedSequence: 1,
      piState: "idle",
      piInvocationId: "pi-native-settings-applied",
      appliedSettingsRevision: 2,
    })).toBe(2);
    expect(await settle(operationClaim!, operationExecutor, "succeeded")).toBe(true);

    const [nativeApplied] = await sql<Array<{
      sourceTurnId: string;
      operationSurface: string;
      appliedSettings: number;
      appliedSkills: number;
      appliedSurface: string;
      piState: string;
      piInvocationId: string;
      webStatus: string;
    }>>`
      select o.source_turn_id::text as "sourceTurnId",
             o.client_surface::text as "operationSurface",
             i.applied_settings_revision::int as "appliedSettings",
             i.applied_skills_revision::int as "appliedSkills",
             i.applied_client_surface::text as "appliedSurface",
             i.pi_state::text as "piState", i.pi_invocation_id as "piInvocationId",
             t.status::text as "webStatus"
      from companion_operations o
      join companion_runtime_instances i
        on i.org_id = o.org_id and i.companion_id = o.companion_id
      join companion_turns t on t.id = ${webTurnId}::uuid
      where o.id = ${operationId}::uuid
    `;
    expect(nativeApplied).toEqual({
      sourceTurnId: webTurnId,
      operationSurface: "native_mobile",
      appliedSettings: 2,
      appliedSkills: 1,
      appliedSurface: "native_mobile",
      piState: "idle",
      piInvocationId: "pi-native-settings-applied",
      webStatus: "queued",
    });

    const settingsExecutor = "web-restage-after-native-settings";
    const [settingsClaim] = await claimWork(settingsExecutor, gate.gateEpoch);
    expect(settingsClaim).toMatchObject({
      workKind: "settings",
      turnId: webTurnId,
      clientSurface: "web",
      checkpoint: "applying",
    });
    const [settingsAuthorization] = await renewAndAuthorize(settingsClaim!, settingsExecutor);
    expect(settingsAuthorization).toMatchObject({
      authorized: true,
      clientSurface: "web",
      skillRefs: [expect.objectContaining({ skill_id: ids.ownerSkill })],
    });
    expect(await observeInstance(settingsClaim!, settingsExecutor, {
      piState: "idle",
      piInvocationId: "pi-web-restage-after-native",
      appliedSettingsRevision: 2,
      appliedSkillsRevision: 1,
    })).toBe(settingsClaim!.checkpointSequence + 1);
    expect(await settle(settingsClaim!, settingsExecutor, "succeeded")).toBe(true);

    const [attemptClaim] = await claimWork("web-after-native-restage", gate.gateEpoch);
    expect(attemptClaim).toMatchObject({ workKind: "attempt", turnId: webTurnId });
    expect(await settle(attemptClaim!, "web-after-native-restage", "failed")).toBe(true);
  });

  it("settles native restart-box without claiming that Skills were applied", async () => {
    if (!runtimeSql) throw new Error("runtime database is not initialized");
    const sql = runtimeSql;
    await resetWork();
    const sourceTurnId = await insertQueuedTurn({
      companionId: ids.companionA,
      clientSurface: "native_mobile",
    });
    await sql`
      update companion_runtime_instances
      set box_id = 'bx_89abcdef', box_state = 'ready', pi_state = 'stopped',
          pi_invocation_id = 'pi-native-restart-old', disk_layout_version = 14,
          desired_settings_revision = 1, applied_settings_revision = 1,
          applied_skills_revision = 1, applied_client_surface = 'web'
      where org_id = ${ids.orgA}::uuid and companion_id = ${ids.companionA}::uuid
    `;
    const operationId = await insertOperation({
      companionId: ids.companionA,
      kind: "restart_box",
      sourceTurnId,
    });
    const gate = await gateStatus();
    const executorId = "native-restart-box";
    const [claim] = await claimWork(executorId, gate.gateEpoch);
    expect(claim).toMatchObject({
      workKind: "operation",
      workId: operationId,
      operationKind: "restart_box",
      clientSurface: "native_mobile",
    });
    const [authorization] = await renewAndAuthorize(claim!, executorId);
    expect(authorization).toMatchObject({
      authorized: true,
      clientSurface: "native_mobile",
      canWriteSkills: false,
      skillRefs: [],
      mcpRefs: [],
    });
    expect(await checkpoint(claim!, executorId, "restarting_box")).toBe(1);
    expect(await checkpoint(claim!, executorId, "waiting_ready", { expectedSequence: 1 })).toBe(2);
    expect(await observeInstance(claim!, executorId, {
      expectedSequence: 2,
      boxId: "bx_89abcdef",
      boxState: "ready",
      piState: "stopped",
    })).toBe(3);
    expect(await checkpoint(claim!, executorId, "installing_layout", {
      expectedSequence: 3,
    })).toBe(4);
    expect(await observeInstance(claim!, executorId, {
      expectedSequence: 4,
      diskLayoutVersion: 14,
      appliedSettingsRevision: 1,
    })).toBe(4);
    expect(await checkpoint(claim!, executorId, "starting_pi", {
      expectedSequence: 4,
    })).toBe(5);
    expect(await observeInstance(claim!, executorId, {
      expectedSequence: 5,
      boxId: "bx_89abcdef",
      boxState: "ready",
      piState: "idle",
      piInvocationId: "pi-native-restart-new",
    })).toBe(6);
    expect(await checkpoint(claim!, executorId, "pi_ready", {
      expectedSequence: 6,
      piInvocationId: "pi-native-restart-new",
    })).toBe(7);
    expect(await settle(claim!, executorId, "succeeded")).toBe(true);

    const [projection] = await sql<Array<{
      operationStatus: string;
      appliedSettings: number;
      appliedSkills: number;
      appliedSurface: string;
      invocationId: string;
    }>>`
      select o.status::text as "operationStatus",
             i.applied_settings_revision::int as "appliedSettings",
             i.applied_skills_revision::int as "appliedSkills",
             i.applied_client_surface::text as "appliedSurface",
             i.pi_invocation_id as "invocationId"
      from companion_operations o
      join companion_runtime_instances i
        on i.org_id = o.org_id and i.companion_id = o.companion_id
      where o.id = ${operationId}::uuid
    `;
    expect(projection).toEqual({
      operationStatus: "succeeded",
      appliedSettings: 1,
      appliedSkills: 1,
      appliedSurface: "native_mobile",
      invocationId: "pi-native-restart-new",
    });
  });

  it("denies a drifted settings claim before the next claim captures live resources", async () => {
    if (!runtimeSql) throw new Error("runtime database is not initialized");
    const sql = runtimeSql;
    const providerTwoId = `runtime-settings-provider-${suffix}`;
    const mcpOneId = randomUUID();
    const mcpTwoId = randomUUID();
    const versionOneId = randomUUID();
    const versionTwoId = randomUUID();
    const [originalSkill] = await sql<Array<{ currentVersionId: string | null }>>`
      select current_version_id::text as "currentVersionId"
      from skills where id = ${ids.ownerSkill}::uuid
    `;
    const [originalCompanion] = await sql<Array<{
      persona: string | null;
      canWriteSkills: boolean;
    }>>`
      select persona, can_write_skills as "canWriteSkills"
      from companions where id = ${ids.companionA}::uuid
    `;

    try {
      await sql`
        insert into skill_versions (
          id, org_id, skill_id, version, frontmatter, body, size_bytes,
          checksum, storage_path, created_by
        ) values
          (
            ${versionOneId}::uuid, ${ids.orgA}::uuid, ${ids.ownerSkill}::uuid,
            '20.0.0', 'name: settings-pin', 'Settings version one', 20,
            ${`sha256:${"c".repeat(64)}`}, ${`runtime-settings/${versionOneId}`}, ${ids.ownerA}
          ),
          (
            ${versionTwoId}::uuid, ${ids.orgA}::uuid, ${ids.ownerSkill}::uuid,
            '21.0.0', 'name: settings-pin', 'Settings version two', 20,
            ${`sha256:${"d".repeat(64)}`}, ${`runtime-settings/${versionTwoId}`}, ${ids.ownerA}
          )
      `;
      await sql`
        update skills set current_version_id = ${versionOneId}::uuid
        where id = ${ids.ownerSkill}::uuid
      `;
      await sql`
        insert into companion_provider_connections (
          org_id, provider_id, auth_method, ciphertext, iv, auth_tag,
          wrapped_dek, wrap_iv, wrap_auth_tag, key_id, connected_by
        ) values (
          ${ids.orgA}::uuid, ${providerTwoId}, 'api_key', 'settings-ciphertext-v2',
          'settings-iv-v2', 'settings-auth-tag-v2', 'settings-wrapped-dek-v2',
          'settings-wrap-iv-v2', 'settings-wrap-auth-tag-v2', 'settings-key-v2', ${ids.ownerA}
        )
      `;
      await sql`
        insert into companion_mcp_accounts (
          id, org_id, owner_id, provider, label, transport, account_config,
          ciphertext, iv, auth_tag, wrapped_dek, wrap_iv, wrap_auth_tag, key_id
        ) values
          (
            ${mcpOneId}::uuid, ${ids.orgA}::uuid, ${ids.ownerA}, 'github',
            'settings MCP V1', 'http', ${sql.json({ url: "https://settings-v1.example.test" })},
            'ciphertext', 'iv', 'auth-tag', 'wrapped-dek', 'wrap-iv', 'wrap-auth-tag',
            'integration-key'
          ),
          (
            ${mcpTwoId}::uuid, ${ids.orgA}::uuid, ${ids.ownerA}, 'github',
            'settings MCP V2', 'http', ${sql.json({ url: "https://settings-v2.example.test" })},
            'ciphertext', 'iv', 'auth-tag', 'wrapped-dek', 'wrap-iv', 'wrap-auth-tag',
            'integration-key'
          )
      `;
      await sql`
        update companion_runtime_instances
        set box_id = 'bx_6789abcd', box_state = 'ready',
            desired_settings_revision = 2, applied_settings_revision = 1,
            applied_skills_revision = 1, settings_actor_id = ${ids.ownerA},
            settings_available_at = now() - interval '1 second'
        where org_id = ${ids.orgA}::uuid and companion_id = ${ids.companionA}::uuid
      `;
      await sql`
        update companions
        set model_id = 'settings-model-v1', persona = 'Settings persona V1',
            can_write_skills = false, provider_ids = ${sql.json([providerId])},
            selected_skill_ids = ${sql.json([ids.ownerSkill])},
            selected_mcp_account_ids = ${sql.json([mcpOneId])}, skills_revision = 2
        where org_id = ${ids.orgA}::uuid and id = ${ids.companionA}::uuid
      `;

      const gate = await gateStatus();
      const [firstClaim] = await claimWork("settings-drift-replica", gate.gateEpoch);
      expect(firstClaim).toMatchObject({
        companionId: ids.companionA,
        workKind: "settings",
        checkpoint: "applying",
        checkpointSequence: 1,
      });
      const [initialAuthorization] = await renewAndAuthorize(
        firstClaim!,
        "settings-drift-replica",
      );
      expect(initialAuthorization).toMatchObject({
        authorized: true,
        denialCode: null,
        modelId: "settings-model-v1",
        persona: "Settings persona V1",
        canWriteSkills: false,
        desiredSettingsRevision: 2,
        skillsRevision: 2,
        providerRefs: [expect.objectContaining({ provider_id: providerId })],
        skillRefs: [{ skill_id: ids.ownerSkill, current_version_id: versionOneId }],
        mcpRefs: [expect.objectContaining({ account_id: mcpOneId })],
      });

      await sql`
        update skills set current_version_id = ${versionTwoId}::uuid
        where id = ${ids.ownerSkill}::uuid
      `;
      await sql`
        update companion_runtime_instances set desired_settings_revision = 3
        where org_id = ${ids.orgA}::uuid and companion_id = ${ids.companionA}::uuid
      `;
      await sql`
        update companions
        set model_id = 'settings-model-v2', persona = 'Settings persona V2',
            can_write_skills = true, provider_ids = ${sql.json([providerTwoId])},
            selected_mcp_account_ids = ${sql.json([mcpTwoId])}, skills_revision = 3
        where org_id = ${ids.orgA}::uuid and id = ${ids.companionA}::uuid
      `;
      const [pinnedAfterDrift] = await renewAndAuthorize(firstClaim!, "settings-drift-replica");
      expect(pinnedAfterDrift).toMatchObject({
        authorized: false,
        denialCode: "settings_changed_since_claim",
        modelId: null,
        persona: null,
        canWriteSkills: null,
        desiredSettingsRevision: null,
        skillsRevision: null,
        providerRefs: [],
        skillRefs: [],
        mcpRefs: [],
      });
      expect(await releaseLease(firstClaim!, "settings-drift-replica")).toBe(true);

      const [nextClaim] = await claimWork("settings-drift-next-replica", gate.gateEpoch);
      expect(nextClaim).toMatchObject({
        companionId: ids.companionA,
        workKind: "settings",
        checkpoint: "applying",
        checkpointSequence: 2,
        claimEpoch: firstClaim!.claimEpoch + 1,
      });
      const [nextAuthorization] = await renewAndAuthorize(
        nextClaim!,
        "settings-drift-next-replica",
      );
      expect(nextAuthorization).toMatchObject({
        authorized: true,
        denialCode: null,
        modelId: "settings-model-v2",
        persona: "Settings persona V2",
        canWriteSkills: true,
        desiredSettingsRevision: 3,
        skillsRevision: 3,
        providerRefs: [expect.objectContaining({ provider_id: providerTwoId })],
        skillRefs: [{ skill_id: ids.ownerSkill, current_version_id: versionTwoId }],
        mcpRefs: [expect.objectContaining({ account_id: mcpTwoId })],
      });
      expect(await observeInstance(nextClaim!, "settings-drift-next-replica", {
        piState: "idle",
        piInvocationId: "pi-settings-drift-next",
        appliedSettingsRevision: 3,
        appliedSkillsRevision: 3,
      })).toBe(3);
      expect(await settle(nextClaim!, "settings-drift-next-replica", "succeeded")).toBe(true);
      const [applied] = await sql<Array<{
        settingsRevision: number;
        skillsRevision: number;
        checkpoint: string;
      }>>`
        select applied_settings_revision::int as "settingsRevision",
               applied_skills_revision::int as "skillsRevision",
               settings_checkpoint as checkpoint
        from companion_runtime_instances
        where org_id = ${ids.orgA}::uuid and companion_id = ${ids.companionA}::uuid
      `;
      expect(applied).toEqual({ settingsRevision: 3, skillsRevision: 3, checkpoint: "applied" });
    } finally {
      await resetWork();
      await sql`
        update skills set current_version_id = ${originalSkill?.currentVersionId ?? null}::uuid
        where id = ${ids.ownerSkill}::uuid
      `;
      await sql`
        delete from skill_versions where id in (${versionOneId}::uuid, ${versionTwoId}::uuid)
      `;
      await sql`
        delete from companion_mcp_accounts where id in (${mcpOneId}::uuid, ${mcpTwoId}::uuid)
      `;
      await sql`
        delete from companion_provider_connections
        where org_id = ${ids.orgA}::uuid and provider_id = ${providerTwoId}
      `;
      await sql`
        update companions
        set persona = ${originalCompanion?.persona ?? null},
            can_write_skills = ${originalCompanion?.canWriteSkills ?? false}
        where id = ${ids.companionA}::uuid
      `;
    }
  });

  it("binds apply-settings operations to exact settings and skills target revisions", async () => {
    if (!runtimeSql) throw new Error("runtime database is not initialized");
    const gate = await gateStatus();
    await runtimeSql`
      update companion_runtime_instances
      set box_id = 'bx_6789abcd', box_state = 'ready',
          desired_settings_revision = 2, applied_settings_revision = 1,
          applied_skills_revision = 1
      where org_id = ${ids.orgA}::uuid and companion_id = ${ids.companionA}::uuid
    `;
    await runtimeSql`
      update companions set skills_revision = 2
      where org_id = ${ids.orgA}::uuid and id = ${ids.companionA}::uuid
    `;

    const spoofedApplyId = await insertOperation({
      companionId: ids.companionA,
      kind: "apply_settings",
      targetSettingsRevision: 999,
    });
    const spoofedStartId = await insertOperation({
      companionId: ids.companionA,
      kind: "start",
      targetSettingsRevision: 999,
      targetSkillsRevision: 999,
    });
    const spoofed = await runtimeSql<Array<{
      id: string;
      kind: string;
      settingsRevision: number;
      skillsRevision: number;
    }>>`
      select id::text, kind::text, target_settings_revision::int as "settingsRevision",
             target_skills_revision::int as "skillsRevision"
      from companion_operations
      where id in (${spoofedApplyId}::uuid, ${spoofedStartId}::uuid)
      order by kind
    `;
    expect(spoofed).toEqual([
      {
        id: spoofedApplyId,
        kind: "apply_settings",
        settingsRevision: 2,
        skillsRevision: 2,
      },
      {
        id: spoofedStartId,
        kind: "start",
        settingsRevision: 2,
        skillsRevision: 2,
      },
    ]);
    await runtimeSql`
      delete from companion_operations
      where id in (${spoofedApplyId}::uuid, ${spoofedStartId}::uuid)
    `;

    const operationId = await insertOperation({
      companionId: ids.companionA,
      kind: "apply_settings",
      targetSettingsRevision: 999,
      targetSkillsRevision: 999,
    });
    const [claim] = await claimWork("apply-settings-drift-replica", gate.gateEpoch);
    expect(claim).toMatchObject({
      workId: operationId,
      operationKind: "apply_settings",
      checkpoint: "pending",
      checkpointSequence: 0,
    });
    const [initialAuthorization] = await renewAndAuthorize(
      claim!,
      "apply-settings-drift-replica",
    );
    expect(initialAuthorization).toMatchObject({
      authorized: true,
      denialCode: null,
      desiredSettingsRevision: 2,
      skillsRevision: 2,
    });

    await runtimeSql`
      update companion_runtime_instances
      set desired_settings_revision = 3
      where org_id = ${ids.orgA}::uuid and companion_id = ${ids.companionA}::uuid
    `;
    await runtimeSql`
      update companions set skills_revision = 3
      where org_id = ${ids.orgA}::uuid and id = ${ids.companionA}::uuid
    `;
    const [driftedAuthorization] = await renewAndAuthorize(
      claim!,
      "apply-settings-drift-replica",
    );
    expect(driftedAuthorization).toMatchObject({
      authorized: true,
      denialCode: null,
      desiredSettingsRevision: 2,
      skillsRevision: 2,
      targetSettingsRevision: 2,
      targetSkillsRevision: 2,
    });
    expect(await checkpoint(claim!, "apply-settings-drift-replica", "applying_settings"))
      .toBe(1);
    await expect(observeInstance(claim!, "apply-settings-drift-replica", {
      expectedSequence: 1,
      piState: "idle",
      piInvocationId: "pi-apply-settings-drift-invalid",
      appliedSettingsRevision: 3,
      appliedSkillsRevision: 3,
    })).rejects.toThrow(/exact revisions and a new idle Pi invocation/);
    expect(await observeInstance(claim!, "apply-settings-drift-replica", {
      expectedSequence: 1,
      piState: "idle",
      piInvocationId: "pi-apply-settings-drift-exact",
      appliedSettingsRevision: 2,
      appliedSkillsRevision: 2,
    })).toBe(2);
    expect(await settle(claim!, "apply-settings-drift-replica", "succeeded")).toBe(true);
    const [operation] = await runtimeSql<Array<{
      status: string;
      checkpoint: string;
      appliedSettingsRevision: number;
      desiredSettingsRevision: number;
      appliedSkillsRevision: number;
      skillsRevision: number;
      piState: string;
      piInvocationId: string;
    }>>`
      select o.status::text, o.checkpoint,
             i.applied_settings_revision::int as "appliedSettingsRevision",
             i.desired_settings_revision::int as "desiredSettingsRevision",
             i.applied_skills_revision::int as "appliedSkillsRevision",
             c.skills_revision::int as "skillsRevision",
             i.pi_state::text as "piState", i.pi_invocation_id as "piInvocationId"
      from companion_operations o
      join companion_runtime_instances i
        on i.org_id = o.org_id and i.companion_id = o.companion_id
      join companions c on c.org_id = o.org_id and c.id = o.companion_id
      where o.id = ${operationId}::uuid
    `;
    expect(operation).toEqual({
      status: "succeeded",
      checkpoint: "settings_applied",
      appliedSettingsRevision: 2,
      desiredSettingsRevision: 3,
      appliedSkillsRevision: 2,
      skillsRevision: 3,
      piState: "idle",
      piInvocationId: "pi-apply-settings-drift-exact",
    });
  });

  it("requires layout 14 and a fresh post-start Pi invocation after Pi and Box restarts", async () => {
    if (!runtimeSql) throw new Error("runtime database is not initialized");
    let gate = await gateStatus();
    const incompatibleBoxId = "bx_6789abcd";
    await runtimeSql`
      update companion_runtime_instances
      set box_id = ${incompatibleBoxId}, box_state = 'ready', pi_state = 'idle',
          pi_invocation_id = 'restart-pi-incompatible', disk_layout_version = 13
      where org_id = ${ids.orgA}::uuid and companion_id = ${ids.companionB}::uuid
    `;
    const incompatibleRestartId = await insertOperation({
      companionId: ids.companionB,
      kind: "restart_pi",
    });
    const [incompatibleRestart] = await claimWork("restart-pi-layout-replica", gate.gateEpoch);
    expect(incompatibleRestart).toMatchObject({
      workId: incompatibleRestartId,
      operationKind: "restart_pi",
    });
    expect(await checkpoint(
      incompatibleRestart!,
      "restart-pi-layout-replica",
      "restarting_pi",
    )).toBe(1);
    await expect(checkpoint(
      incompatibleRestart!,
      "restart-pi-layout-replica",
      "starting_pi",
      { expectedSequence: 1 },
    )).rejects.toThrow(/disk layout version 14/);
    expect(await settle(incompatibleRestart!, "restart-pi-layout-replica", "failed")).toBe(true);

    const variants = [
      {
        kind: "restart_pi" as const,
        companionId: ids.companionA,
        executorId: "restart-pi-observation-replica",
        boxId: "bx_789abcde",
        restartCheckpoint: "restarting_pi",
      },
      {
        kind: "restart_box" as const,
        companionId: ids.companionC,
        executorId: "restart-box-observation-replica",
        boxId: "bx_89abcdef",
        restartCheckpoint: "restarting_box",
      },
    ];

    for (const variant of variants) {
      await resetWork();
      gate = await gateStatus();
      const oldInvocationId = `${variant.kind}-old-invocation`;
      await runtimeSql`
        update companion_runtime_instances
        set box_id = ${variant.boxId}, box_state = 'ready', pi_state = 'idle',
            pi_invocation_id = ${oldInvocationId},
            disk_layout_version = ${variant.kind === "restart_pi" ? 14 : 0},
            box_observed_at = now() - interval '1 minute',
            pi_observed_at = now() - interval '1 minute',
            last_observed_at = now() - interval '1 minute'
        where org_id = ${ids.orgA}::uuid and companion_id = ${variant.companionId}::uuid
      `;
      const operationId = await insertOperation({
        companionId: variant.companionId,
        kind: variant.kind,
      });
      const [claim] = await claimWork(variant.executorId, gate.gateEpoch);
      expect(claim).toMatchObject({
        companionId: variant.companionId,
        workId: operationId,
        operationKind: variant.kind,
        checkpoint: "pending",
        checkpointSequence: 0,
      });

      let sequence = 0;
      expect(await checkpoint(claim!, variant.executorId, variant.restartCheckpoint, {
        expectedSequence: sequence,
      })).toBe(1);
      sequence = 1;
      if (variant.kind === "restart_box") {
        expect(await checkpoint(claim!, variant.executorId, "waiting_ready", {
          expectedSequence: sequence,
        })).toBe(sequence + 1);
        sequence += 1;
        await expect(checkpoint(claim!, variant.executorId, "installing_layout", {
          expectedSequence: sequence,
        })).rejects.toThrow(/invalid operation checkpoint transition/);
        expect(await observeInstance(claim!, variant.executorId, {
          expectedSequence: sequence,
          boxId: variant.boxId,
          boxState: "ready",
        })).toBe(sequence + 1);
        sequence += 1;
        expect(await checkpoint(claim!, variant.executorId, "installing_layout", {
          expectedSequence: sequence,
        })).toBe(sequence + 1);
        sequence += 1;
        await expect(checkpoint(claim!, variant.executorId, "starting_pi", {
          expectedSequence: sequence,
        })).rejects.toThrow(/disk layout version 14/);
        expect(await observeInstance(claim!, variant.executorId, {
          expectedSequence: sequence,
          diskLayoutVersion: 14,
        })).toBe(sequence);
      }
      const [restartAuthorization] = await renewAndAuthorize(claim!, variant.executorId);
      expect(restartAuthorization).toMatchObject({
        authorized: true,
        boxId: variant.boxId,
        boxState: "ready",
        piState: "idle",
        piInvocationId: oldInvocationId,
        diskLayoutVersion: 14,
        appliedSettingsRevision: 1,
        appliedSkillsRevision: 1,
      });
      expect(await checkpoint(claim!, variant.executorId, "starting_pi", {
        expectedSequence: sequence,
      })).toBe(sequence + 1);
      sequence += 1;

      await expect(checkpoint(claim!, variant.executorId, "pi_ready", {
        expectedSequence: sequence,
      })).rejects.toThrow(/invalid operation checkpoint transition/);
      const [starting] = await runtimeSql<Array<{
        checkpoint: string;
        sequence: number;
        invocationId: string | null;
        operationUpdatedAt: Date;
      }>>`
        select o.checkpoint, o.checkpoint_sequence::int as sequence,
               i.pi_invocation_id as "invocationId", o.updated_at as "operationUpdatedAt"
        from companion_operations o join companion_runtime_instances i
          on i.org_id = o.org_id and i.companion_id = o.companion_id
        where o.id = ${operationId}::uuid
      `;
      expect(starting).toMatchObject({
        checkpoint: "starting_pi",
        sequence,
        invocationId: oldInvocationId,
      });

      const freshInvocationId = `${variant.kind}-fresh-invocation`;
      expect(await observeInstance(claim!, variant.executorId, {
        expectedSequence: sequence,
        piState: "idle",
        piInvocationId: freshInvocationId,
        observedAt: new Date(new Date(starting!.operationUpdatedAt).getTime() - 1),
      })).toBe(sequence + 1);
      const [operationBoundObservation] = await runtimeSql<Array<{
        checkpoint: string;
        sequence: number;
        invocationId: string | null;
      }>>`
        select o.checkpoint, o.checkpoint_sequence::int as sequence,
               i.pi_invocation_id as "invocationId"
        from companion_operations o join companion_runtime_instances i
          on i.org_id = o.org_id and i.companion_id = o.companion_id
        where o.id = ${operationId}::uuid
      `;
      expect(operationBoundObservation).toEqual({
        checkpoint: "pi_observed",
        sequence: sequence + 1,
        invocationId: freshInvocationId,
      });
      expect(await observeInstance(claim!, variant.executorId, {
        expectedSequence: sequence,
        piState: "idle",
        piInvocationId: `${variant.kind}-competing-invocation`,
      })).toBeNull();
      if (variant.kind === "restart_box") {
        await runtimeSql`
          update companion_runtime_instances set disk_layout_version = 13
          where org_id = ${ids.orgA}::uuid and companion_id = ${variant.companionId}::uuid
        `;
        await expect(checkpoint(claim!, variant.executorId, "pi_ready", {
          expectedSequence: sequence + 1,
        })).rejects.toThrow(/disk layout version 14/);
        await runtimeSql`
          update companion_runtime_instances set disk_layout_version = 14
          where org_id = ${ids.orgA}::uuid and companion_id = ${variant.companionId}::uuid
        `;
      }
      expect(await checkpoint(claim!, variant.executorId, "pi_ready", {
        expectedSequence: sequence + 1,
      })).toBe(sequence + 2);
      if (variant.kind === "restart_box") {
        await runtimeSql`
          update companion_runtime_instances set disk_layout_version = 13
          where org_id = ${ids.orgA}::uuid and companion_id = ${variant.companionId}::uuid
        `;
        await expect(settle(claim!, variant.executorId, "succeeded"))
          .rejects.toThrow(/Box\/Pi\/layout observation proof/);
        await runtimeSql`
          update companion_runtime_instances set disk_layout_version = 14
          where org_id = ${ids.orgA}::uuid and companion_id = ${variant.companionId}::uuid
        `;
      }
      expect(await settle(claim!, variant.executorId, "succeeded")).toBe(true);

      const [settled] = await runtimeSql<Array<{
        status: string;
        checkpoint: string;
        sequence: number;
        invocationId: string | null;
      }>>`
        select o.status::text, o.checkpoint, o.checkpoint_sequence::int as sequence,
               i.pi_invocation_id as "invocationId"
        from companion_operations o join companion_runtime_instances i
          on i.org_id = o.org_id and i.companion_id = o.companion_id
        where o.id = ${operationId}::uuid
      `;
      expect(settled).toEqual({
        status: "succeeded",
        checkpoint: "pi_ready",
        sequence: sequence + 3,
        invocationId: freshInvocationId,
      });
    }
  });

  it("keeps Start and restart-Box configuration snapshots immutable across takeover", async () => {
    if (!runtimeSql) throw new Error("runtime database is not initialized");
    const sql = runtimeSql;
    const versionOneId = randomUUID();
    const versionTwoId = randomUUID();
    const mcpOneId = randomUUID();
    const mcpTwoId = randomUUID();
    const providerTwoId = `runtime-provider-v2-${suffix}`;
    const modelOne = "runtime-operation-model-v1";
    const modelTwo = "runtime-operation-model-v2";
    const [originalSkill] = await sql<Array<{ currentVersionId: string | null }>>`
      select current_version_id::text as "currentVersionId"
      from skills where id = ${ids.ownerSkill}::uuid
    `;
    const originals = await sql<Array<{
      id: string;
      persona: string | null;
      canWriteSkills: boolean;
    }>>`
      select id::text, persona, can_write_skills as "canWriteSkills"
      from companions where id in (${ids.companionA}::uuid, ${ids.companionC}::uuid)
    `;

    try {
      await sql`
        insert into skill_versions (
          id, org_id, skill_id, version, frontmatter, body, size_bytes,
          checksum, storage_path, created_by
        ) values
          (
            ${versionOneId}::uuid, ${ids.orgA}::uuid, ${ids.ownerSkill}::uuid,
            '10.0.0', 'name: operation-pin', 'Operation version one', 21,
            ${`sha256:${"a".repeat(64)}`}, ${`runtime-operation/${versionOneId}`}, ${ids.ownerA}
          ),
          (
            ${versionTwoId}::uuid, ${ids.orgA}::uuid, ${ids.ownerSkill}::uuid,
            '11.0.0', 'name: operation-pin', 'Operation version two', 21,
            ${`sha256:${"b".repeat(64)}`}, ${`runtime-operation/${versionTwoId}`}, ${ids.ownerA}
          )
      `;
      await sql`
        update skills set current_version_id = ${versionOneId}::uuid
        where id = ${ids.ownerSkill}::uuid
      `;
      await sql`
        insert into companion_provider_connections (
          org_id, provider_id, auth_method, ciphertext, iv, auth_tag,
          wrapped_dek, wrap_iv, wrap_auth_tag, key_id, connected_by
        ) values (
          ${ids.orgA}::uuid, ${providerTwoId}, 'api_key', 'ciphertext-v2', 'iv-v2',
          'auth-tag-v2', 'wrapped-dek-v2', 'wrap-iv-v2', 'wrap-auth-tag-v2',
          'integration-key-v2', ${ids.ownerA}
        )
      `;
      await sql`
        insert into companion_mcp_accounts (
          id, org_id, owner_id, provider, label, transport, account_config,
          ciphertext, iv, auth_tag, wrapped_dek, wrap_iv, wrap_auth_tag, key_id
        ) values
          (
            ${mcpOneId}::uuid, ${ids.orgA}::uuid, ${ids.ownerA}, 'github',
            'operation MCP V1', 'http', ${sql.json({ url: "https://operation-v1.example.test" })},
            'ciphertext', 'iv', 'auth-tag', 'wrapped-dek', 'wrap-iv', 'wrap-auth-tag',
            'integration-key'
          ),
          (
            ${mcpTwoId}::uuid, ${ids.orgA}::uuid, ${ids.ownerA}, 'github',
            'operation MCP V2', 'http', ${sql.json({ url: "https://operation-v2.example.test" })},
            'ciphertext', 'iv', 'auth-tag', 'wrapped-dek', 'wrap-iv', 'wrap-auth-tag',
            'integration-key'
          )
      `;
      await sql`
        update companions
        set model_id = ${modelOne}, persona = 'Operation persona V1',
            can_write_skills = false, provider_ids = ${sql.json([providerId])},
            selected_skill_ids = ${sql.json([ids.ownerSkill])},
            selected_mcp_account_ids = ${sql.json([mcpOneId])}, skills_revision = 2
        where id in (${ids.companionA}::uuid, ${ids.companionC}::uuid)
      `;
      await sql`
        update companion_runtime_instances
        set desired_settings_revision = 2, applied_settings_revision = 1,
            applied_skills_revision = 1
        where companion_id in (${ids.companionA}::uuid, ${ids.companionC}::uuid)
      `;
      const restartBoxId = "bx_4567cdef";
      await sql`
        update companion_runtime_instances
        set box_id = ${restartBoxId}, box_state = 'ready', pi_state = 'idle',
            pi_invocation_id = 'operation-restart-old', disk_layout_version = 0
        where companion_id = ${ids.companionC}::uuid
      `;

      const startId = await insertOperation({ companionId: ids.companionA, kind: "start" });
      const restartId = await insertOperation({
        companionId: ids.companionC,
        kind: "restart_box",
      });
      const captured = await sql<Array<{
        id: string;
        modelId: string | null;
        persona: string | null;
        canWriteSkills: boolean;
        providerIds: string[];
        skillRefs: Array<{ skill_id: string; current_version_id: string | null }>;
        mcpIds: string[];
        settingsRevision: number;
        skillsRevision: number;
      }>>`
        select id::text, model_id as "modelId", persona,
               can_write_skills as "canWriteSkills", provider_ids as "providerIds",
               skill_refs as "skillRefs", selected_mcp_account_ids as "mcpIds",
               target_settings_revision::int as "settingsRevision",
               target_skills_revision::int as "skillsRevision"
        from companion_operations
        where id in (${startId}::uuid, ${restartId}::uuid)
        order by id
      `;
      expect(captured).toHaveLength(2);
      for (const row of captured) {
        expect(row).toMatchObject({
          modelId: modelOne,
          persona: "Operation persona V1",
          canWriteSkills: false,
          providerIds: [providerId],
          skillRefs: [{ skill_id: ids.ownerSkill, current_version_id: versionOneId }],
          mcpIds: [mcpOneId],
          settingsRevision: 2,
          skillsRevision: 2,
        });
      }

      const gate = await gateStatus();
      const [restartClaim] = await claimWork("operation-snapshot-restart", gate.gateEpoch);
      expect(restartClaim).toMatchObject({ workId: restartId, operationKind: "restart_box" });
      expect(await checkpoint(restartClaim!, "operation-snapshot-restart", "restarting_box"))
        .toBe(1);
      expect(await checkpoint(restartClaim!, "operation-snapshot-restart", "waiting_ready", {
        expectedSequence: 1,
      })).toBe(2);
      expect(await observeInstance(restartClaim!, "operation-snapshot-restart", {
        expectedSequence: 2,
        boxId: restartBoxId,
        boxState: "ready",
      })).toBe(3);
      expect(await checkpoint(restartClaim!, "operation-snapshot-restart", "installing_layout", {
        expectedSequence: 3,
      })).toBe(4);
      expect(await observeInstance(restartClaim!, "operation-snapshot-restart", {
        expectedSequence: 4,
        diskLayoutVersion: 14,
      })).toBe(4);
      expect(await checkpoint(restartClaim!, "operation-snapshot-restart", "starting_pi", {
        expectedSequence: 4,
      })).toBe(5);

      const [startClaim] = await claimWork("operation-snapshot-start", gate.gateEpoch);
      expect(startClaim).toMatchObject({ workId: startId, operationKind: "start" });
      expect(await checkpoint(startClaim!, "operation-snapshot-start", "resolving_box")).toBe(1);
      expect(await observeInstance(startClaim!, "operation-snapshot-start", {
        expectedSequence: 1,
        boxState: "absent",
        piState: "absent",
      })).toBe(2);
      expect(await checkpoint(startClaim!, "operation-snapshot-start", "creating_box", {
        expectedSequence: 2,
      })).toBe(3);
      const startBoxId = "bx_5678defg";
      expect(await observeInstance(startClaim!, "operation-snapshot-start", {
        expectedSequence: 3,
        boxId: startBoxId,
        boxState: "ready",
        piState: "absent",
      })).toBe(4);
      expect(await checkpoint(startClaim!, "operation-snapshot-start", "installing_layout", {
        expectedSequence: 4,
      })).toBe(5);
      expect(await observeInstance(startClaim!, "operation-snapshot-start", {
        expectedSequence: 5,
        diskLayoutVersion: 14,
      })).toBe(5);
      expect(await checkpoint(startClaim!, "operation-snapshot-start", "starting_pi", {
        expectedSequence: 5,
      })).toBe(6);

      await sql`
        update skills set current_version_id = ${versionTwoId}::uuid
        where id = ${ids.ownerSkill}::uuid
      `;
      await sql`
        update companions
        set model_id = ${modelTwo}, persona = 'Operation persona V2',
            can_write_skills = true, provider_ids = ${sql.json([providerTwoId])},
            selected_skill_ids = ${sql.json([ids.ownerSkill])},
            selected_mcp_account_ids = ${sql.json([mcpTwoId])}, skills_revision = 3
        where id in (${ids.companionA}::uuid, ${ids.companionC}::uuid)
      `;
      await sql`
        update companion_runtime_instances set desired_settings_revision = 3
        where companion_id in (${ids.companionA}::uuid, ${ids.companionC}::uuid)
      `;
      expect(await releaseLease(restartClaim!, "operation-snapshot-restart")).toBe(true);
      expect(await releaseLease(startClaim!, "operation-snapshot-start")).toBe(true);

      const takeovers = await claimWork("operation-snapshot-takeover", gate.gateEpoch, 2);
      expect(new Set(takeovers.map((claim) => claim.workId)))
        .toEqual(new Set([startId, restartId]));
      for (const takeover of takeovers) {
        const [authorization] = await renewAndAuthorize(
          takeover,
          "operation-snapshot-takeover",
        );
        expect(authorization).toMatchObject({
          authorized: true,
          denialCode: null,
          modelId: modelOne,
          persona: "Operation persona V1",
          canWriteSkills: false,
          desiredSettingsRevision: 2,
          skillsRevision: 2,
          targetSettingsRevision: 2,
          targetSkillsRevision: 2,
          providerRefs: [expect.objectContaining({ provider_id: providerId })],
          skillRefs: [{ skill_id: ids.ownerSkill, current_version_id: versionOneId }],
          mcpRefs: [expect.objectContaining({ account_id: mcpOneId })],
        });
        await expect(observeInstance(takeover, "operation-snapshot-takeover", {
          appliedSettingsRevision: 3,
          appliedSkillsRevision: 3,
        })).rejects.toThrow(/exact captured revisions/);
        expect(await observeInstance(takeover, "operation-snapshot-takeover", {
          appliedSettingsRevision: 2,
          appliedSkillsRevision: 2,
        })).toBe(takeover.checkpointSequence);
        expect(await settle(takeover, "operation-snapshot-takeover", "failed")).toBe(true);
      }
    } finally {
      await resetWork();
      await sql`
        update skills set current_version_id = ${originalSkill?.currentVersionId ?? null}::uuid
        where id = ${ids.ownerSkill}::uuid
      `;
      await sql`
        delete from skill_versions where id in (${versionOneId}::uuid, ${versionTwoId}::uuid)
      `;
      await sql`
        delete from companion_mcp_accounts where id in (${mcpOneId}::uuid, ${mcpTwoId}::uuid)
      `;
      await sql`
        delete from companion_provider_connections
        where org_id = ${ids.orgA}::uuid and provider_id = ${providerTwoId}
      `;
      for (const original of originals) {
        await sql`
          update companions
          set persona = ${original.persona}, can_write_skills = ${original.canWriteSkills}
          where id = ${original.id}::uuid
        `;
      }
    }
  });

  it("persists absolute parser counters only with monotonic event progress", async () => {
    if (!runtimeSql) throw new Error("runtime database is not initialized");
    const gate = await gateStatus();
    const turnId = await insertQueuedTurn({ companionId: ids.companionA });
    const [claim] = await claimWork("parser-counters", gate.gateEpoch);
    expect(claim).toMatchObject({
      workKind: "attempt",
      turnId,
      eventCursor: 0,
      unknownEventCount: 0,
      malformedEventCount: 0,
      oversizedEventCount: 0,
    });

    const commandId = randomUUID();
    const piInvocationId = "pi-parser-counters";
    expect(await checkpoint(claim!, "parser-counters", "dispatch_write_intent", {
      commandId,
    })).toBe(1);
    expect(await checkpoint(claim!, "parser-counters", "dispatch_accepted", {
      expectedSequence: 1,
      commandId,
      piInvocationId,
      activityAt: new Date(),
    })).toBe(2);
    expect(await checkpoint(claim!, "parser-counters", "event_projected", {
      expectedSequence: 2,
      eventCursor: 10,
      activityAt: new Date(),
      unknownEventCount: 3,
      malformedEventCount: 2,
      oversizedEventCount: 1,
    })).toBe(3);

    const [authorization] = await renewAndAuthorize(claim!, "parser-counters");
    expect(authorization).toMatchObject({
      authorized: true,
      workCheckpoint: "event_projected",
      workCheckpointSequence: 3,
      unknownEventCount: 3,
      malformedEventCount: 2,
      oversizedEventCount: 1,
    });
    await expect(checkpoint(claim!, "parser-counters", "event_projected", {
      expectedSequence: 3,
      eventCursor: 11,
      unknownEventCount: -1,
      malformedEventCount: 2,
      oversizedEventCount: 1,
    })).rejects.toMatchObject({ code: "22023" });
    expect(await checkpoint(claim!, "parser-counters", "event_projected", {
      expectedSequence: 3,
      eventCursor: 11,
      unknownEventCount: 2,
      malformedEventCount: 2,
      oversizedEventCount: 1,
    })).toBeNull();
    expect(await checkpoint(claim!, "parser-counters", "event_projected", {
      expectedSequence: 3,
      eventCursor: 10,
      unknownEventCount: 4,
      malformedEventCount: 2,
      oversizedEventCount: 1,
    })).toBeNull();
    expect(await checkpoint(claim!, "parser-counters", "event_projected", {
      expectedSequence: 3,
      eventCursor: 9,
      unknownEventCount: 3,
      malformedEventCount: 2,
      oversizedEventCount: 1,
    })).toBeNull();

    const [unchanged] = await runtimeSql<Array<{
      checkpoint: string;
      sequence: number;
      eventCursor: number;
      unknownEventCount: number;
      malformedEventCount: number;
      oversizedEventCount: number;
    }>>`
      select checkpoint, checkpoint_sequence::int as sequence, event_cursor::int as "eventCursor",
             unknown_event_count::int as "unknownEventCount",
             malformed_event_count::int as "malformedEventCount",
             oversized_event_count::int as "oversizedEventCount"
      from companion_turn_attempts where id = ${claim!.workId}::uuid
    `;
    expect(unchanged).toEqual({
      checkpoint: "event_projected",
      sequence: 3,
      eventCursor: 10,
      unknownEventCount: 3,
      malformedEventCount: 2,
      oversizedEventCount: 1,
    });

    expect(await releaseLease(claim!, "parser-counters")).toBe(true);
    const [takeover] = await claimWork("parser-counters-takeover", gate.gateEpoch);
    expect(takeover).toMatchObject({
      workKind: "attempt",
      workId: claim!.workId,
      checkpoint: "event_projected",
      checkpointSequence: 3,
      eventCursor: 10,
      unknownEventCount: 3,
      malformedEventCount: 2,
      oversizedEventCount: 1,
      claimEpoch: claim!.claimEpoch + 1,
    });
    const [takeoverAuthorization] = await renewAndAuthorize(
      takeover!,
      "parser-counters-takeover",
    );
    expect(takeoverAuthorization).toMatchObject({
      authorized: true,
      workCheckpoint: "event_projected",
      workCheckpointSequence: 3,
      unknownEventCount: 3,
      malformedEventCount: 2,
      oversizedEventCount: 1,
    });
    expect(await settle(takeover!, "parser-counters-takeover", "failed")).toBe(true);
  });

  it("pins the exact Skill version captured when an attempt is claimed", async () => {
    if (!runtimeSql) throw new Error("runtime database is not initialized");
    const sql = runtimeSql;
    const versionOneId = randomUUID();
    const versionTwoId = randomUUID();
    const [originalSkill] = await sql<Array<{ currentVersionId: string | null }>>`
      select current_version_id::text as "currentVersionId"
      from skills where id = ${ids.ownerSkill}::uuid
    `;
    const [originalCompanion] = await sql<Array<{
      persona: string | null;
      canWriteSkills: boolean;
    }>>`
      select persona, can_write_skills as "canWriteSkills"
      from companions where id = ${ids.companionA}::uuid
    `;

    try {
      await sql`
        insert into skill_versions (
          id, org_id, skill_id, version, frontmatter, body, size_bytes,
          checksum, storage_path, created_by
        ) values
          (
            ${versionOneId}::uuid, ${ids.orgA}::uuid, ${ids.ownerSkill}::uuid,
            '1.0.0', 'name: pinned-owner-skill', 'Version one', 11,
            ${`sha256:${"1".repeat(64)}`}, ${`runtime-pin/${versionOneId}`}, ${ids.ownerA}
          ),
          (
            ${versionTwoId}::uuid, ${ids.orgA}::uuid, ${ids.ownerSkill}::uuid,
            '2.0.0', 'name: pinned-owner-skill', 'Version two', 11,
            ${`sha256:${"2".repeat(64)}`}, ${`runtime-pin/${versionTwoId}`}, ${ids.ownerA}
          )
      `;
      await sql`
        update skills set current_version_id = ${versionOneId}::uuid
        where id = ${ids.ownerSkill}::uuid
      `;
      await sql`
        update companions
        set persona = 'Pinned persona V1', can_write_skills = false, skills_revision = 1
        where org_id = ${ids.orgA}::uuid and id = ${ids.companionA}::uuid
      `;
      const gate = await gateStatus();
      const turnId = await insertQueuedTurn({ companionId: ids.companionA });
      const [claim] = await claimWork("skill-version-pin", gate.gateEpoch);
      expect(claim).toMatchObject({ workKind: "attempt", turnId, workId: expect.any(String) });

      const [captured] = await sql<Array<{
        selectedSkillIds: string[];
        skillRefs: Array<{ skill_id: string; current_version_id: string | null }>;
        skillsRevision: number;
        persona: string | null;
        canWriteSkills: boolean;
      }>>`
        select selected_skill_ids as "selectedSkillIds", skill_refs as "skillRefs",
               skills_revision::int as "skillsRevision", persona,
               can_write_skills as "canWriteSkills"
        from companion_turn_attempts where id = ${claim!.workId}::uuid
      `;
      expect(captured).toEqual({
        selectedSkillIds: [ids.ownerSkill],
        skillRefs: [{ skill_id: ids.ownerSkill, current_version_id: versionOneId }],
        skillsRevision: 1,
        persona: "Pinned persona V1",
        canWriteSkills: false,
      });

      await sql`
        update skills set current_version_id = ${versionTwoId}::uuid
        where id = ${ids.ownerSkill}::uuid
      `;
      await sql`
        update companions
        set persona = 'Live persona V2', can_write_skills = true, skills_revision = 2
        where org_id = ${ids.orgA}::uuid and id = ${ids.companionA}::uuid
      `;
      const [authorization] = await renewAndAuthorize(claim!, "skill-version-pin");
      expect(authorization).toMatchObject({
        authorized: true,
        denialCode: null,
        authorizationActorId: ids.ownerA,
        skillsRevision: 1,
        persona: "Pinned persona V1",
        canWriteSkills: false,
        skillRefs: [{ skill_id: ids.ownerSkill, current_version_id: versionOneId }],
      });
      const [afterPublication] = await sql<Array<{
        skillRefs: Array<{ skill_id: string; current_version_id: string | null }>;
        persona: string | null;
        canWriteSkills: boolean;
      }>>`
        select skill_refs as "skillRefs", persona, can_write_skills as "canWriteSkills"
        from companion_turn_attempts where id = ${claim!.workId}::uuid
      `;
      expect(afterPublication).toEqual({
        skillRefs: [{ skill_id: ids.ownerSkill, current_version_id: versionOneId }],
        persona: "Pinned persona V1",
        canWriteSkills: false,
      });
      expect(await settle(claim!, "skill-version-pin", "failed")).toBe(true);

      const liveStartId = await insertOperation({ companionId: ids.companionA, kind: "start" });
      const [liveStartClaim] = await claimWork("skill-version-live-start", gate.gateEpoch);
      expect(liveStartClaim).toMatchObject({
        workKind: "operation",
        workId: liveStartId,
        operationKind: "start",
      });
      const [liveAuthorization] = await renewAndAuthorize(
        liveStartClaim!,
        "skill-version-live-start",
      );
      expect(liveAuthorization).toMatchObject({
        authorized: true,
        skillsRevision: 2,
        persona: "Live persona V2",
        canWriteSkills: true,
        skillRefs: [{ skill_id: ids.ownerSkill, current_version_id: versionTwoId }],
      });
      expect(await settle(liveStartClaim!, "skill-version-live-start", "failed")).toBe(true);
    } finally {
      await sql`
        update skills set current_version_id = ${originalSkill?.currentVersionId ?? null}::uuid
        where id = ${ids.ownerSkill}::uuid
      `;
      await sql`
        delete from skill_versions where id in (${versionOneId}::uuid, ${versionTwoId}::uuid)
      `;
      await sql`
        update companions
        set skills_revision = 1, persona = ${originalCompanion?.persona ?? null},
            can_write_skills = ${originalCompanion?.canWriteSkills ?? false}
        where org_id = ${ids.orgA}::uuid and id = ${ids.companionA}::uuid
      `;
    }
  });

  it("freezes attempt resources and deadlines, and requires explicit dispatch and agent-settled proof", async () => {
    if (!runtimeSql) throw new Error("runtime database is not initialized");
    const gate = await gateStatus();
    const turnId = await insertQueuedTurn({ companionId: ids.companionA });
    const beforeClaim = Date.now();
    const [claim] = await claimWork("attempt-replica", gate.gateEpoch);
    expect(claim).toMatchObject({
      workKind: "attempt",
      turnId,
      checkpoint: "starting",
      checkpointSequence: 0,
      turnStatus: "starting",
      attemptStatus: "starting",
      dispatchState: "pending",
      inactivityDeadlineAt: null,
    });
    const absoluteDeadline = new Date(claim!.absoluteDeadlineAt!).getTime();
    expect(absoluteDeadline).toBeGreaterThanOrEqual(beforeClaim + 2 * 60 * 60 * 1000 - 5_000);
    expect(absoluteDeadline).toBeLessThanOrEqual(Date.now() + 2 * 60 * 60 * 1000 + 5_000);

    const [initialAuthorization] = await renewAndAuthorize(claim!, "attempt-replica");
    expect(initialAuthorization).toMatchObject({
      authorized: true,
      denialCode: null,
      authorizationActorId: ids.ownerA,
      modelId,
      desiredSettingsRevision: 1,
      skillsRevision: 1,
    });
    expect(initialAuthorization!.providerRefs).toHaveLength(1);
    expect(initialAuthorization!.skillRefs).toEqual([
      expect.objectContaining({ skill_id: ids.ownerSkill }),
    ]);

    await runtimeSql`
      update companions
      set model_id = 'changed-after-claim',
          selected_skill_ids = ${runtimeSql.json([ids.editorSkill])},
          skills_revision = 2
      where org_id = ${ids.orgA}::uuid and id = ${ids.companionA}::uuid
    `;
    const [snapshotAuthorization] = await renewAndAuthorize(claim!, "attempt-replica");
    expect(snapshotAuthorization).toMatchObject({
      authorized: true,
      modelId,
      skillsRevision: 1,
    });
    expect(snapshotAuthorization!.skillRefs).toEqual([
      expect.objectContaining({ skill_id: ids.ownerSkill }),
    ]);

    await expect(settle(claim!, "attempt-replica", "succeeded"))
      .rejects.toThrow(/terminal_proof|agent[_ ]settlement|agent_settled|check constraint/i);
    const [unsettled] = await runtimeSql<Array<{ status: string; leaseToken: string | null }>>`
      select a.status::text,
        (select claim_token::text from companion_runtime_leases l
         where l.companion_id = a.companion_id) as "leaseToken"
      from companion_turn_attempts a where a.id = ${claim!.workId}::uuid
    `;
    expect(unsettled).toEqual({ status: "starting", leaseToken: claim!.claimToken });

    const commandId = randomUUID();
    expect(await checkpoint(claim!, "attempt-replica", "dispatch_write_intent", {
      commandId,
    })).toBe(1);
    await expect(checkpoint(claim!, "attempt-replica", "dispatch_accepted", {
      expectedSequence: 1,
      commandId,
      activityAt: new Date(),
    })).rejects.toThrow(/stable Pi invocation id/);
    expect(await checkpoint(claim!, "attempt-replica", "dispatch_accepted", {
      expectedSequence: 1,
      commandId,
      piInvocationId: "pi-invocation-one",
      activityAt: new Date(),
    })).toBe(2);
    expect(await checkpoint(claim!, "attempt-replica", "running", {
      expectedSequence: 2,
      commandId,
      piInvocationId: "pi-invocation-one",
      eventCursor: 1,
      activityAt: new Date(),
    })).toBe(3);
    await expect(checkpoint(claim!, "attempt-replica", "agent_settled", {
      expectedSequence: 3,
      commandId,
      eventCursor: 2,
      activityAt: new Date(),
    })).rejects.toThrow(/preserve the accepted Pi invocation id/);
    await expect(checkpoint(claim!, "attempt-replica", "agent_settled", {
      expectedSequence: 3,
      commandId,
      piInvocationId: "pi-invocation-two",
      eventCursor: 2,
      activityAt: new Date(),
    })).rejects.toThrow(/preserve the accepted Pi invocation id/);
    expect(await checkpoint(claim!, "attempt-replica", "agent_settled", {
      expectedSequence: 3,
      commandId,
      piInvocationId: "pi-invocation-one",
      eventCursor: 2,
      activityAt: new Date(),
    })).toBe(4);
    await runtimeSql`
      update companion_turn_attempts set pi_invocation_id = null
      where id = ${claim!.workId}::uuid
    `;
    await expect(settle(claim!, "attempt-replica", "succeeded"))
      .rejects.toThrow(/Pi invocation/);
    await runtimeSql`
      update companion_turn_attempts set pi_invocation_id = 'pi-invocation-one'
      where id = ${claim!.workId}::uuid
    `;
    expect(await settle(claim!, "attempt-replica", "succeeded")).toBe(true);
    const [settled] = await runtimeSql<Array<{
      turnStatus: string;
      attemptStatus: string;
      checkpoint: string;
      dispatchState: string;
      inactivityDeadline: Date;
      absoluteDeadline: Date;
      model: string;
      skills: unknown[];
    }>>`
      select t.status::text as "turnStatus", a.status::text as "attemptStatus",
             a.checkpoint, a.dispatch_state::text as "dispatchState",
             t.inactivity_deadline_at as "inactivityDeadline",
             t.absolute_deadline_at as "absoluteDeadline", a.model_id as model,
             a.selected_skill_ids as skills
      from companion_turns t join companion_turn_attempts a on a.turn_id = t.id
      where t.id = ${turnId}::uuid
    `;
    expect(settled).toMatchObject({
      turnStatus: "succeeded",
      attemptStatus: "succeeded",
      checkpoint: "agent_settled",
      dispatchState: "accepted",
      model: modelId,
      skills: [ids.ownerSkill],
    });
    expect(new Date(settled!.inactivityDeadline).getTime())
      .toBeLessThanOrEqual(new Date(settled!.absoluteDeadline).getTime());

    const rejectedTurn = await insertQueuedTurn({ companionId: ids.companionB });
    const [rejectedClaim] = await claimWork("negative-ack-replica", gate.gateEpoch);
    expect(rejectedClaim?.turnId).toBe(rejectedTurn);
    const rejectedCommand = randomUUID();
    expect(await checkpoint(rejectedClaim!, "negative-ack-replica", "dispatch_write_intent", {
      commandId: rejectedCommand,
    })).toBe(1);
    expect(await checkpoint(rejectedClaim!, "negative-ack-replica", "dispatch_rejected", {
      expectedSequence: 1,
      commandId: rejectedCommand,
    })).toBe(2);
    expect(await settle(rejectedClaim!, "negative-ack-replica", "failed", {
      errorCode: "dispatch_rejected",
      errorMessage: "Pi explicitly rejected the command.",
      errorAction: "retry",
    })).toBe(true);

    const ambiguousTurn = await insertQueuedTurn({ companionId: ids.companionC });
    const [ambiguousClaim] = await claimWork("ambiguous-replica", gate.gateEpoch);
    expect(ambiguousClaim?.turnId).toBe(ambiguousTurn);
    const ambiguousCommand = randomUUID();
    expect(await checkpoint(ambiguousClaim!, "ambiguous-replica", "dispatch_write_intent", {
      commandId: ambiguousCommand,
    })).toBe(1);
    expect(await checkpoint(ambiguousClaim!, "ambiguous-replica", "dispatch_ambiguous", {
      expectedSequence: 1,
      commandId: ambiguousCommand,
    })).toBe(2);
    await expect(settle(ambiguousClaim!, "ambiguous-replica", "failed"))
      .rejects.toThrow(/ambiguous|terminal_proof|check constraint/i);
    expect(await settle(ambiguousClaim!, "ambiguous-replica", "interrupted", {
      errorCode: "dispatch_ambiguous",
      errorMessage: "Dispatch acknowledgement was ambiguous.",
      errorAction: "retry",
    })).toBe(true);
  });

  it("observes instance state monotonically and proves start, health, and Box absence terminals", async () => {
    if (!runtimeSql) throw new Error("runtime database is not initialized");
    let gate = await gateStatus();
    const startSourceTurnId = await insertQueuedTurn({ companionId: ids.companionA });
    const startId = await insertOperation({
      companionId: ids.companionA,
      kind: "start",
      trigger: "turn",
      sourceTurnId: startSourceTurnId,
    });
    const [startClaim] = await claimWork("observe-start-replica", gate.gateEpoch);
    expect(startClaim).toMatchObject({ workId: startId, operationKind: "start" });
    expect(await checkpoint(startClaim!, "observe-start-replica", "resolving_box")).toBe(1);
    expect(await observeInstance(startClaim!, "observe-start-replica", {
      expectedSequence: 1,
      boxState: "absent",
      piState: "absent",
    })).toBe(2);
    expect(await checkpoint(startClaim!, "observe-start-replica", "creating_box", {
      expectedSequence: 2,
    })).toBe(3);
    await expect(checkpoint(startClaim!, "observe-start-replica", "waiting_ready", {
      expectedSequence: 3,
    })).rejects.toThrow(/invalid operation checkpoint transition/);

    const createdBoxId = "bx_23456789";
    const creationObservedAt = new Date(Date.now() + 10);
    expect(await observeInstance(startClaim!, "observe-start-replica", {
      expectedSequence: 3,
      boxId: createdBoxId,
      boxState: "provisioning",
      piState: "absent",
      observedAt: creationObservedAt,
    })).toBe(4);
    const [creation] = await runtimeSql<Array<{
      checkpoint: string;
      sequence: number;
      boxId: string | null;
      boxState: string;
      observedAt: Date | null;
    }>>`
      select o.checkpoint, o.checkpoint_sequence::int as sequence,
             i.box_id as "boxId", i.box_state::text as "boxState",
             i.last_observed_at as "observedAt"
      from companion_operations o join companion_runtime_instances i
        on i.org_id = o.org_id and i.companion_id = o.companion_id
      where o.id = ${startId}::uuid
    `;
    expect(creation).toMatchObject({
      checkpoint: "box_created",
      sequence: 4,
      boxId: createdBoxId,
      boxState: "provisioning",
    });
    expect(new Date(creation!.observedAt!).getTime()).toBe(creationObservedAt.getTime());

    expect(await releaseLease(startClaim!, "observe-start-replica")).toBe(true);
    const [takeover] = await claimWork("observe-takeover-replica", gate.gateEpoch);
    expect(takeover).toMatchObject({ workId: startId, checkpoint: "box_created", checkpointSequence: 4 });
    expect(await observeInstance(startClaim!, "observe-start-replica", {
      expectedSequence: 4,
      boxId: createdBoxId,
      boxState: "ready",
      observedAt: new Date(),
    })).toBeNull();
    await expect(observeInstance(takeover!, "observe-takeover-replica", {
      boxId: "bx_abcdefgh",
      boxState: "ready",
      observedAt: new Date(creationObservedAt.getTime() + 1),
    })).rejects.toThrow(/Box id is immutable within a runtime generation/);
    const [afterRefusals] = await runtimeSql<Array<{
      boxId: string | null;
      boxState: string;
      checkpoint: string;
    }>>`
      select i.box_id as "boxId", i.box_state::text as "boxState", o.checkpoint
      from companion_runtime_instances i join companion_operations o
        on o.org_id = i.org_id and o.companion_id = i.companion_id
      where o.id = ${startId}::uuid
    `;
    expect(afterRefusals).toEqual({
      boxId: createdBoxId,
      boxState: "provisioning",
      checkpoint: "box_created",
    });
    expect(await checkpoint(takeover!, "observe-takeover-replica", "waiting_ready", {
      expectedSequence: 4,
    })).toBe(5);
    await expect(checkpoint(takeover!, "observe-takeover-replica", "installing_layout", {
      expectedSequence: 5,
    })).rejects.toThrow(/invalid operation checkpoint transition/);
    expect(await observeInstance(takeover!, "observe-takeover-replica", {
      expectedSequence: 5,
      boxId: createdBoxId,
      boxState: "ready",
      observedAt: new Date(creationObservedAt.getTime() + 2),
    })).toBe(6);
    expect(await checkpoint(takeover!, "observe-takeover-replica", "installing_layout", {
      expectedSequence: 6,
    })).toBe(7);
    await expect(checkpoint(takeover!, "observe-takeover-replica", "starting_pi", {
      expectedSequence: 7,
    })).rejects.toThrow(/disk layout version 14/);
    expect(await observeInstance(takeover!, "observe-takeover-replica", {
      expectedSequence: 7,
      diskLayoutVersion: 14,
      observedAt: new Date(creationObservedAt.getTime() + 3),
    })).toBe(7);
    const [startAuthorization] = await renewAndAuthorize(
      takeover!,
      "observe-takeover-replica",
    );
    expect(startAuthorization).toMatchObject({
      authorized: true,
      boxId: createdBoxId,
      boxState: "ready",
      piState: "absent",
      piInvocationId: null,
      diskLayoutVersion: 14,
      appliedSettingsRevision: 1,
      appliedSkillsRevision: 1,
    });
    expect(await checkpoint(takeover!, "observe-takeover-replica", "starting_pi", {
      expectedSequence: 7,
    })).toBe(8);
    await expect(settle(takeover!, "observe-takeover-replica", "succeeded"))
      .rejects.toThrow(/terminal checkpoint proof/);
    await expect(checkpoint(takeover!, "observe-takeover-replica", "pi_ready", {
      expectedSequence: 8,
    })).rejects.toThrow(/invalid operation checkpoint transition/);
    expect(await observeInstance(takeover!, "observe-takeover-replica", {
      expectedSequence: 8,
      boxId: createdBoxId,
      boxState: "ready",
      piState: "idle",
      piInvocationId: "pi-start-proof",
      observedAt: new Date(creationObservedAt.getTime() + 4),
    })).toBe(9);
    expect(await checkpoint(takeover!, "observe-takeover-replica", "pi_ready", {
      expectedSequence: 9,
    })).toBe(10);
    expect(await settle(takeover!, "observe-takeover-replica", "succeeded")).toBe(true);
    const [preservedSource] = await runtimeSql<Array<{
      status: string;
      inactivityDeadlineAt: Date | null;
      absoluteDeadlineAt: Date | null;
      settledAt: Date | null;
      errorCode: string | null;
    }>>`
      select status::text, inactivity_deadline_at as "inactivityDeadlineAt",
             absolute_deadline_at as "absoluteDeadlineAt", settled_at as "settledAt",
             last_error_code as "errorCode"
      from companion_turns where id = ${startSourceTurnId}::uuid
    `;
    expect(preservedSource).toEqual({
      status: "queued",
      inactivityDeadlineAt: null,
      absoluteDeadlineAt: null,
      settledAt: null,
      errorCode: null,
    });
    const [sourceClaim] = await claimWork("source-after-start-replica", gate.gateEpoch);
    expect(sourceClaim).toMatchObject({
      workKind: "attempt",
      turnId: startSourceTurnId,
    });
    expect(await settle(sourceClaim!, "source-after-start-replica", "failed")).toBe(true);

    await resetWork();
    gate = await gateStatus();
    await runtimeSql`
      update companion_runtime_instances
      set box_id = ${createdBoxId}, box_state = 'ready'
      where companion_id = ${ids.companionC}::uuid
    `;
    const adoptedStartId = await insertOperation({ companionId: ids.companionC, kind: "start" });
    const [adoptedStart] = await claimWork("observe-adopt-replica", gate.gateEpoch);
    expect(adoptedStart?.workId).toBe(adoptedStartId);
    expect(await checkpoint(adoptedStart!, "observe-adopt-replica", "resolving_box")).toBe(1);
    await expect(checkpoint(adoptedStart!, "observe-adopt-replica", "creating_box", {
      expectedSequence: 1,
    })).rejects.toThrow(/invalid operation checkpoint transition/);
    expect(await observeInstance(adoptedStart!, "observe-adopt-replica", {
      expectedSequence: 1,
      boxId: createdBoxId,
      boxState: "ready",
    })).toBe(2);
    expect(await checkpoint(adoptedStart!, "observe-adopt-replica", "installing_layout", {
      expectedSequence: 2,
    })).toBe(3);
    await settle(adoptedStart!, "observe-adopt-replica", "failed");

    await resetWork();
    gate = await gateStatus();
    const healthBoxId = "bx_3456789a";
    await runtimeSql`
      update companion_runtime_instances
      set box_id = ${healthBoxId}, box_state = 'idle', pi_state = 'running',
          pi_invocation_id = 'pi-health-one', disk_layout_version = 1,
          health_due_at = now() - interval '1 second'
      where companion_id = ${ids.companionB}::uuid
    `;
    const [healthClaim] = await claimWork("observe-health-replica", gate.gateEpoch);
    expect(healthClaim).toMatchObject({
      companionId: ids.companionB,
      workKind: "health",
      checkpoint: "observing",
      checkpointSequence: 1,
    });
    const [healthAuthorization] = await renewAndAuthorize(
      healthClaim!,
      "observe-health-replica",
    );
    expect(healthAuthorization).toMatchObject({
      authorized: true,
      denialCode: null,
      authorizationActorId: null,
      clientSurface: null,
      boxId: healthBoxId,
      boxState: "idle",
      piState: "running",
      piInvocationId: "pi-health-one",
      diskLayoutVersion: 1,
      appliedSettingsRevision: 1,
      appliedSkillsRevision: 1,
      modelId: null,
      providerRefs: [],
      skillRefs: [],
      mcpRefs: [],
    });
    const healthObservedAt = new Date(Date.now() - 2_000);
    expect(await settle(healthClaim!, "observe-health-replica", "succeeded")).toBe(false);
    await expect(observeInstance(healthClaim!, "observe-health-replica", {
      boxId: "bx_456789ab",
      boxState: "running",
      observedAt: healthObservedAt,
    })).rejects.toThrow(/Box id is immutable|health observation cannot mutate runtime identity/);
    expect(await observeInstance(healthClaim!, "observe-health-replica", {
      boxId: healthBoxId,
      boxState: "running",
      piState: "absent",
      observedAt: healthObservedAt,
    })).toBe(2);
    expect(await observeInstance(healthClaim!, "observe-health-replica", {
      boxId: healthBoxId,
      boxState: "error",
      piState: "error",
      observedAt: new Date(healthObservedAt.getTime() + 1_000),
    })).toBeNull();
    const [healthProjection] = await runtimeSql<Array<{
      boxId: string;
      boxState: string;
      piState: string;
      piInvocationId: string | null;
      layout: number;
      healthCheckpoint: string;
      healthSequence: number;
      heartbeatAt: Date;
      observedAt: Date;
    }>>`
      select box_id as "boxId", box_state::text as "boxState", pi_state::text as "piState",
             pi_invocation_id as "piInvocationId",
             disk_layout_version::int as layout, health_checkpoint as "healthCheckpoint",
             health_checkpoint_sequence::int as "healthSequence", last_heartbeat_at as "heartbeatAt",
             last_observed_at as "observedAt"
      from companion_runtime_instances where companion_id = ${ids.companionB}::uuid
    `;
    expect(healthProjection).toMatchObject({
      boxId: healthBoxId,
      boxState: "running",
      piState: "absent",
      piInvocationId: null,
      layout: 1,
      healthCheckpoint: "observed",
      healthSequence: 2,
    });
    expect(new Date(healthProjection!.heartbeatAt).getTime())
      .toBe(new Date(healthProjection!.observedAt).getTime());
    expect(await settle(healthClaim!, "observe-health-replica", "succeeded")).toBe(true);

    await resetWork();
    gate = await gateStatus();
    await runtimeSql`
      update companion_runtime_instances
      set box_id = ${createdBoxId}, box_state = 'archived', pi_state = 'stopped',
          retirement_state = 'requested', retirement_requested_at = now()
      where companion_id = ${ids.companionC}::uuid
    `;
    const deleteId = await insertOperation({ companionId: ids.companionC, kind: "delete" });
    const [deleteClaim] = await claimWork("observe-delete-replica", gate.gateEpoch);
    expect(deleteClaim?.workId).toBe(deleteId);
    await expect(checkpoint(deleteClaim!, "observe-delete-replica", "box_absent"))
      .rejects.toThrow(/operation-bound provider absence evidence|invalid operation checkpoint transition/);
    const [deleteStarted] = await runtimeSql<Array<{ updatedAt: Date }>>`
      select updated_at as "updatedAt" from companion_operations where id = ${deleteId}::uuid
    `;
    expect(await observeInstance(deleteClaim!, "observe-delete-replica", {
      boxState: "absent",
      piState: "absent",
      observedAt: new Date(Math.max(
        Date.now(),
        new Date(deleteStarted!.updatedAt).getTime() + 1,
      )),
    })).toBe(1);
    expect(await settle(deleteClaim!, "observe-delete-replica", "succeeded")).toBe(true);
    const [deleted] = await runtimeSql<Array<{
      companionCount: number;
      runtimeCount: number;
      operationCount: number;
      auditCount: number;
    }>>`
      select
        (select count(*)::int from companions where id = ${ids.companionC}::uuid)
          as "companionCount",
        (select count(*)::int from companion_runtime_instances
          where companion_id = ${ids.companionC}::uuid) as "runtimeCount",
        (select count(*)::int from companion_operations
          where companion_id = ${ids.companionC}::uuid) as "operationCount",
        (select count(*)::int from audit_log
          where action = 'companion.deleted' and target_id = ${ids.companionC}
            and metadata ->> 'operation_id' = ${deleteId}) as "auditCount"
    `;
    expect(deleted).toEqual({
      companionCount: 0,
      runtimeCount: 0,
      operationCount: 0,
      auditCount: 1,
    });
  });

  it("attaches a restarted Pi invocation from health only with idle proof", async () => {
    if (!runtimeSql) throw new Error("runtime database is not initialized");
    await resetWork();
    const gate = await gateStatus();
    const healthBoxId = "bx_3456789a";
    await runtimeSql`
      update companion_runtime_instances
      set box_id = ${healthBoxId}, box_state = 'ready', pi_state = 'idle',
          pi_invocation_id = 'pi-health-recycled-old',
          health_due_at = now() - interval '1 second'
      where companion_id = ${ids.companionB}::uuid
    `;
    const [claim] = await claimWork("observe-health-identity", gate.gateEpoch);
    expect(claim).toMatchObject({
      companionId: ids.companionB,
      workKind: "health",
      checkpoint: "observing",
    });
    await expect(observeInstance(claim!, "observe-health-identity", {
      piState: "running",
      piInvocationId: "pi-health-recycled-new",
    })).rejects.toThrow(/health observation cannot mutate runtime identity/);
    await expect(observeInstance(claim!, "observe-health-identity", {
      boxId: "bx_456789ab",
      piState: "idle",
    })).rejects.toThrow(/Box id is immutable|health observation cannot mutate runtime identity/);
    await expect(observeInstance(claim!, "observe-health-identity", {
      diskLayoutVersion: 14,
      piState: "idle",
    })).rejects.toThrow(/health observation cannot mutate runtime identity/);
    expect(await observeInstance(claim!, "observe-health-identity", {
      boxState: "ready",
      piState: "idle",
      piInvocationId: "pi-health-recycled-new",
    })).toBe(2);
    const [projection] = await runtimeSql<Array<{
      piState: string;
      piInvocationId: string | null;
      healthCheckpoint: string;
    }>>`
      select pi_state::text as "piState", pi_invocation_id as "piInvocationId",
             health_checkpoint as "healthCheckpoint"
      from companion_runtime_instances where companion_id = ${ids.companionB}::uuid
    `;
    expect(projection).toMatchObject({
      piState: "idle",
      piInvocationId: "pi-health-recycled-new",
      healthCheckpoint: "observed",
    });
    expect(await settle(claim!, "observe-health-identity", "succeeded")).toBe(true);
  });

  it("repairs a NULL durable Pi identity after a crashed start only with idle proof", async () => {
    if (!runtimeSql) throw new Error("runtime database is not initialized");
    await resetWork();
    const gate = await gateStatus();
    const healthBoxId = "bx_3456789a";
    await runtimeSql`
      update companion_runtime_instances
      set box_id = ${healthBoxId}, box_state = 'ready', pi_state = 'starting',
          pi_invocation_id = null,
          health_due_at = now() - interval '1 second'
      where companion_id = ${ids.companionB}::uuid
    `;
    const [claim] = await claimWork("observe-health-orphan", gate.gateEpoch);
    expect(claim).toMatchObject({
      companionId: ids.companionB,
      workKind: "health",
      checkpoint: "observing",
    });
    await expect(observeInstance(claim!, "observe-health-orphan", {
      piState: "running",
      piInvocationId: "pi-health-orphaned-live",
    })).rejects.toThrow(/health observation cannot mutate runtime identity/);
    expect(await observeInstance(claim!, "observe-health-orphan", {
      boxState: "ready",
      piState: "idle",
      piInvocationId: "pi-health-orphaned-live",
    })).toBe(2);
    const [projection] = await runtimeSql<Array<{
      piState: string;
      piInvocationId: string | null;
      healthCheckpoint: string;
    }>>`
      select pi_state::text as "piState", pi_invocation_id as "piInvocationId",
             health_checkpoint as "healthCheckpoint"
      from companion_runtime_instances where companion_id = ${ids.companionB}::uuid
    `;
    expect(projection).toMatchObject({
      piState: "idle",
      piInvocationId: "pi-health-orphaned-live",
      healthCheckpoint: "observed",
    });
    expect(await settle(claim!, "observe-health-orphan", "succeeded")).toBe(true);
  });

  it("keeps decision delivery durable, blocks an interrupted queue, and globally fences on disable", async () => {
    if (!runtimeSql) throw new Error("runtime database is not initialized");
    let gate = await gateStatus();
    const parent = await insertActiveTurnAttempt({ companionId: ids.companionA });
    const queuedBehind = await insertQueuedTurn({ companionId: ids.companionA });
    const decision = await insertDecision({
      companionId: ids.companionA,
      turnId: parent.turnId,
      attemptId: parent.attemptId,
    });
    await expect(insertDecision({
      companionId: ids.companionA,
      turnId: parent.turnId,
      attemptId: parent.attemptId,
      requestKey: decision.requestKey,
    })).rejects.toThrow(/companion_decision_deliveries_request_uq/);

    const [decisionClaim] = await claimWork("decision-replica", gate.gateEpoch);
    expect(decisionClaim).toMatchObject({
      workKind: "decision",
      workId: decision.id,
      decisionStatus: "answered",
      decisionDeliveryState: "pending",
    });
    const [decisionAuthorization] = await renewAndAuthorize(
      decisionClaim!,
      "decision-replica",
    );
    expect(decisionAuthorization).toMatchObject({
      authorized: true,
      decisionStatus: "answered",
      decisionDeliveryState: "pending",
      decisionRequestKey: decision.requestKey,
      decisionResponseText: "approved by integration test",
    });
    await expect(settle(decisionClaim!, "decision-replica", "succeeded"))
      .rejects.toThrow(/unambiguous durable write intent/);
    let [delivery] = await runtimeSql<Array<{
      state: string;
      sequence: number;
      commandId: string | null;
      errorMessage: string | null;
    }>>`
      select delivery_state::text as state,
             delivery_checkpoint_sequence::int as sequence,
             command_id::text as "commandId", last_error_message as "errorMessage"
      from companion_decision_deliveries where id = ${decision.id}::uuid
    `;
    expect(delivery).toEqual({ state: "pending", sequence: 0, commandId: null, errorMessage: null });
    const [heldLease] = await runtimeSql<Array<{ token: string | null }>>`
      select claim_token::text as token from companion_runtime_leases
      where companion_id = ${ids.companionA}::uuid
    `;
    expect(heldLease?.token).toBe(decisionClaim!.claimToken);

    await expect(settle(decisionClaim!, "decision-replica", "failed", {
      errorCode: "delivery_failed",
      errorMessage: "raw-secret\nmust-not-persist",
      errorAction: "retry",
    })).rejects.toThrow(/invalid Runtime v2 settlement/);
    [delivery] = await runtimeSql<Array<{
      state: string;
      sequence: number;
      commandId: string | null;
      errorMessage: string | null;
    }>>`
      select delivery_state::text as state,
             delivery_checkpoint_sequence::int as sequence,
             command_id::text as "commandId", last_error_message as "errorMessage"
      from companion_decision_deliveries where id = ${decision.id}::uuid
    `;
    expect(delivery).toEqual({ state: "pending", sequence: 0, commandId: null, errorMessage: null });

    const decisionCommand = randomUUID();
    expect(await checkpoint(decisionClaim!, "decision-replica", "write_intent", {
      commandId: decisionCommand,
    })).toBe(1);
    expect(await settle(decisionClaim!, "decision-replica", "failed", {
      errorCode: "delivery_ack_missing",
      errorMessage: "Delivery acknowledgement was not received.",
      errorAction: "retry",
    })).toBe(true);
    const [interrupted] = await runtimeSql<Array<{
      deliveryState: string;
      deliveryMessage: string;
      attemptStatus: string;
      turnStatus: string;
      queuedStatus: string;
    }>>`
      select d.delivery_state::text as "deliveryState",
             d.last_error_message as "deliveryMessage",
             a.status::text as "attemptStatus", t.status::text as "turnStatus",
             queued.status::text as "queuedStatus"
      from companion_decision_deliveries d
      join companion_turn_attempts a on a.id = d.attempt_id
      join companion_turns t on t.id = d.turn_id
      join companion_turns queued on queued.id = ${queuedBehind}::uuid
      where d.id = ${decision.id}::uuid
    `;
    expect(interrupted).toEqual({
      deliveryState: "ambiguous",
      deliveryMessage: "Delivery acknowledgement was not received.",
      attemptStatus: "interrupted",
      turnStatus: "interrupted",
      queuedStatus: "queued",
    });
    expect(JSON.stringify(interrupted)).not.toContain("raw-secret");
    expect(await claimWork("blocked-queue-replica", gate.gateEpoch)).toEqual([]);

    await resetWork();
    gate = await gateStatus();
    const gatedOperation = await insertOperation({ companionId: ids.companionB });
    const [gatedClaim] = await claimWork("gate-replica", gate.gateEpoch);
    expect(gatedClaim?.workId).toBe(gatedOperation);
    const disabled = await disableGate(gate.gateEpoch);
    expect(disabled).toEqual({ enabled: false, gateEpoch: gate.gateEpoch + 1 });
    expect(await claimWork("after-disable-replica", disabled.gateEpoch)).toEqual([]);
    expect(await renewAndAuthorize(gatedClaim!, "gate-replica")).toEqual([]);
    expect(await checkpoint(gatedClaim!, "gate-replica", "stopping_pi")).toBeNull();
    expect(await settle(gatedClaim!, "gate-replica", "failed")).toBe(false);
    const [fenced] = await runtimeSql<Array<{
      status: string;
      code: string;
      message: string;
      token: string | null;
      leaseEpoch: number;
    }>>`
      select o.status::text, o.last_error_code as code, o.last_error_message as message,
             l.claim_token::text as token, l.claim_epoch::int as "leaseEpoch"
      from companion_operations o join companion_runtime_leases l
        on l.companion_id = o.companion_id
      where o.id = ${gatedOperation}::uuid
    `;
    expect(fenced).toEqual({
      status: "interrupted",
      code: "runtime_gate_disabled",
      message: "Runtime execution was disabled.",
      token: null,
      leaseEpoch: gatedClaim!.claimEpoch + 1,
    });
  });

  it("rejects NULL gate epochs without bypassing the gate CAS", async () => {
    if (!runtimeSql) throw new Error("runtime database is not initialized");
    const initial = await gateStatus();

    await expect(asRole(executorRole, (tx) => tx`
      select * from public.companion_runtime_disable(${null}::bigint, 'null-disable')
    `)).rejects.toThrow(/invalid runtime gate epoch/);
    await expect(asRole(executorRole, (tx) => tx`
      select * from public.companion_runtime_claim_work('null-claim', 1, 30, ${null}::bigint)
    `)).rejects.toThrow(/invalid Runtime v2 claim arguments/);
    expect(await gateStatus()).toEqual(initial);

    const disabled = await disableGate(initial.gateEpoch);
    await expect(runtimeSql`
      select * from public.companion_runtime_enable(${null}::bigint, 'null-enable')
    `).rejects.toThrow(/invalid runtime gate epoch/);
    expect(await gateStatus()).toEqual(disabled);
  });

  it("refuses a renewal that starts before lease expiry but clears its locks afterward", async () => {
    if (!runtimeSql) throw new Error("runtime database is not initialized");
    const gate = await gateStatus();
    const operationId = await insertOperation({ companionId: ids.companionA, kind: "stop" });
    const [claim] = await claimWork("renew-across-expiry", gate.gateEpoch, 1, 5);
    expect(claim).toMatchObject({
      workKind: "operation",
      workId: operationId,
      operationKind: "stop",
    });
    const [leaseBefore] = await runtimeSql<Array<{
      renewedAt: Date;
      expiresAt: Date;
    }>>`
      select renewed_at as "renewedAt", expires_at as "expiresAt"
      from companion_runtime_leases where companion_id = ${ids.companionA}::uuid
    `;
    expect(leaseBefore!.expiresAt.getTime() - leaseBefore!.renewedAt.getTime())
      .toBe(5_000);

    const blockerSql = postgres(runtimeUrl.toString(), { max: 1 });
    const renewSql = postgres(runtimeUrl.toString(), { max: 1 });
    let releaseInstance: (() => void) | undefined;
    const instanceRelease = new Promise<void>((resolve) => {
      releaseInstance = resolve;
    });
    let instanceLocked: (() => void) | undefined;
    const instanceLock = new Promise<void>((resolve) => {
      instanceLocked = resolve;
    });
    let renewPidReady: ((pid: number) => void) | undefined;
    const renewPid = new Promise<number>((resolve) => {
      renewPidReady = resolve;
    });
    const blockerRun = blockerSql.begin(async (tx) => {
      await tx`
        select 1 from companion_runtime_instances
        where companion_id = ${ids.companionA}::uuid
        for update
      `;
      instanceLocked?.();
      await instanceRelease;
    });
    void blockerRun.catch(() => undefined);
    let renewRun: Promise<Array<{ authorized: boolean }>> | undefined;

    try {
      await instanceLock;
      renewRun = renewSql.begin(async (tx) => {
        await tx.unsafe("set local deadlock_timeout = '100ms'");
        await tx.unsafe("set local lock_timeout = '10s'");
        await tx.unsafe(`set local role ${executorRole}`);
        const [backend] = await tx<Array<{ pid: number }>>`
          select pg_backend_pid()::int as pid
        `;
        renewPidReady?.(backend!.pid);
        return tx<Array<{ authorized: boolean }>>`
          select authorized
          from public.companion_runtime_renew_and_authorize(
            ${claim!.orgId}::uuid, ${claim!.companionId}::uuid,
            ${claim!.claimToken}::uuid, ${claim!.claimEpoch}, ${claim!.gateEpoch},
            'renew-across-expiry', ${claim!.workKind}, ${claim!.workId}::uuid, 30
          )
        `;
      });
      void renewRun.catch(() => undefined);
      await waitForBackendLock(await renewPid, "renewal behind instance ACL state");

      await runtimeSql`
        select pg_sleep(
          greatest(
            0,
            extract(epoch from ${leaseBefore!.expiresAt}::timestamptz - clock_timestamp())
          ) + 0.2
        )
      `;
      const [expiredWhileBlocked] = await runtimeSql<Array<{ expired: boolean }>>`
        select clock_timestamp() >= expires_at as expired
        from companion_runtime_leases where companion_id = ${ids.companionA}::uuid
      `;
      expect(expiredWhileBlocked?.expired).toBe(true);

      releaseInstance?.();
      await blockerRun;
      expect(await settlesWithin(renewRun, 5_000, "renewal past lease expiry")).toEqual([]);
      const [leaseAfter] = await runtimeSql<Array<{
        renewedAt: Date;
        expiresAt: Date;
      }>>`
        select renewed_at as "renewedAt", expires_at as "expiresAt"
        from companion_runtime_leases where companion_id = ${ids.companionA}::uuid
      `;
      expect(leaseAfter?.renewedAt.getTime()).toBe(leaseBefore!.renewedAt.getTime());
      expect(leaseAfter?.expiresAt.getTime()).toBe(leaseBefore!.expiresAt.getTime());

      const [takeover] = await claimWork("renew-across-expiry-takeover", gate.gateEpoch);
      expect(takeover).toMatchObject({
        workId: operationId,
        claimEpoch: claim!.claimEpoch + 1,
      });
      expect(await settle(takeover!, "renew-across-expiry-takeover", "failed")).toBe(true);
    } finally {
      releaseInstance?.();
      await Promise.allSettled([blockerRun, ...(renewRun ? [renewRun] : [])]);
      await blockerSql.end({ timeout: 1 });
      await renewSql.end({ timeout: 1 });
    }
  }, 15_000);

  it("skips a lease held by an in-flight checkpoint at expiry, then takes over once", async () => {
    if (!runtimeSql) throw new Error("runtime database is not initialized");
    const gate = await gateStatus();
    const operationId = await insertOperation({ companionId: ids.companionA, kind: "stop" });
    const [oldClaim] = await claimWork("expiry-checkpoint", gate.gateEpoch);
    expect(oldClaim?.workId).toBe(operationId);
    await runtimeSql`
      update companion_runtime_leases
      set expires_at = clock_timestamp() + interval '2 seconds'
      where companion_id = ${ids.companionA}::uuid
    `;

    const blockerSql = postgres(runtimeUrl.toString(), { max: 1 });
    const checkpointSql = postgres(runtimeUrl.toString(), { max: 1 });
    let unblockInstance: (() => void) | undefined;
    const instanceRelease = new Promise<void>((resolve) => {
      unblockInstance = resolve;
    });
    let instanceLocked: (() => void) | undefined;
    const instanceLock = new Promise<void>((resolve) => {
      instanceLocked = resolve;
    });
    const blockerRun = blockerSql.begin(async (tx) => {
      await tx`
        select 1 from companion_runtime_instances
        where companion_id = ${ids.companionA}::uuid
        for update
      `;
      instanceLocked?.();
      await instanceRelease;
    });
    void blockerRun.catch(() => undefined);

    let checkpointPidReady: ((pid: number) => void) | undefined;
    const checkpointPid = new Promise<number>((resolve) => {
      checkpointPidReady = resolve;
    });
    let checkpointRun: Promise<number | null> | undefined;
    try {
      await instanceLock;
      checkpointRun = checkpointSql.begin(async (tx) => {
        await tx.unsafe("set local deadlock_timeout = '100ms'");
        await tx.unsafe("set local lock_timeout = '5s'");
        await tx.unsafe(`set local role ${executorRole}`);
        const [backend] = await tx<Array<{ pid: number }>>`select pg_backend_pid()::int as pid`;
        checkpointPidReady?.(backend!.pid);
        const [row] = await tx<Array<{ sequence: number | null }>>`
          select public.companion_runtime_checkpoint(
            ${oldClaim!.orgId}::uuid, ${oldClaim!.companionId}::uuid,
            ${oldClaim!.claimToken}::uuid, ${oldClaim!.claimEpoch}, ${oldClaim!.gateEpoch},
            'expiry-checkpoint', ${oldClaim!.workKind}, ${oldClaim!.workId}::uuid,
            ${oldClaim!.checkpointSequence}, 'stopping_pi', null, null::uuid, null, null, null,
            null, null, null
          )::int as sequence
        `;
        return row?.sequence ?? null;
      });
      void checkpointRun.catch(() => undefined);
      await waitForBackendLock(await checkpointPid, "checkpoint behind instance");

      await runtimeSql`select pg_sleep(2.1)`;
      expect(await settlesWithin(
        claimWork("expiry-racer", gate.gateEpoch),
        1_000,
        "SKIP LOCKED takeover",
      )).toEqual([]);

      unblockInstance?.();
      await blockerRun;
      expect(await settlesWithin(checkpointRun, 5_000, "blocked checkpoint")).toBeNull();

      const [takeover] = await claimWork("expiry-takeover", gate.gateEpoch);
      expect(takeover).toMatchObject({
        workId: operationId,
        claimEpoch: oldClaim!.claimEpoch + 1,
        checkpoint: "pending",
        checkpointSequence: 0,
      });
      expect(await settle(takeover!, "expiry-takeover", "failed")).toBe(true);
    } finally {
      unblockInstance?.();
      await Promise.allSettled([blockerRun, ...(checkpointRun ? [checkpointRun] : [])]);
      await blockerSql.end({ timeout: 1 });
      await checkpointSql.end({ timeout: 1 });
    }
  }, 15_000);

  it("disable holds leases before work while a checkpoint waits behind it", async () => {
    if (!runtimeSql) throw new Error("runtime database is not initialized");
    const gate = await gateStatus();
    const operationId = await insertOperation({ companionId: ids.companionB, kind: "stop" });
    const [claim] = await claimWork("disable-checkpoint", gate.gateEpoch);
    expect(claim?.workId).toBe(operationId);

    const blockerSql = postgres(runtimeUrl.toString(), { max: 1 });
    const disableSql = postgres(runtimeUrl.toString(), { max: 1 });
    const checkpointSql = postgres(runtimeUrl.toString(), { max: 1 });
    let unblockOperation: (() => void) | undefined;
    const operationRelease = new Promise<void>((resolve) => {
      unblockOperation = resolve;
    });
    let operationLocked: (() => void) | undefined;
    const operationLock = new Promise<void>((resolve) => {
      operationLocked = resolve;
    });
    const blockerRun = blockerSql.begin(async (tx) => {
      await tx`
        select 1 from companion_operations
        where id = ${operationId}::uuid
        for update
      `;
      operationLocked?.();
      await operationRelease;
    });
    void blockerRun.catch(() => undefined);

    let disablePidReady: ((pid: number) => void) | undefined;
    const disablePid = new Promise<number>((resolve) => {
      disablePidReady = resolve;
    });
    let checkpointPidReady: ((pid: number) => void) | undefined;
    const checkpointPid = new Promise<number>((resolve) => {
      checkpointPidReady = resolve;
    });
    let disableRun: Promise<GateStatus> | undefined;
    let checkpointRun: Promise<number | null> | undefined;
    try {
      await operationLock;
      disableRun = disableSql.begin(async (tx) => {
        await tx.unsafe("set local deadlock_timeout = '100ms'");
        await tx.unsafe("set local lock_timeout = '5s'");
        await tx.unsafe(`set local role ${executorRole}`);
        const [backend] = await tx<Array<{ pid: number }>>`select pg_backend_pid()::int as pid`;
        disablePidReady?.(backend!.pid);
        const [row] = await tx<Array<GateStatus>>`
          select enabled, gate_epoch::int as "gateEpoch"
          from public.companion_runtime_disable(${gate.gateEpoch}, 'concurrent-disable')
        `;
        return row!;
      });
      void disableRun.catch(() => undefined);
      await waitForBackendLock(await disablePid, "disable behind operation");

      checkpointRun = checkpointSql.begin(async (tx) => {
        await tx.unsafe("set local deadlock_timeout = '100ms'");
        await tx.unsafe("set local lock_timeout = '5s'");
        await tx.unsafe(`set local role ${executorRole}`);
        const [backend] = await tx<Array<{ pid: number }>>`select pg_backend_pid()::int as pid`;
        checkpointPidReady?.(backend!.pid);
        const [row] = await tx<Array<{ sequence: number | null }>>`
          select public.companion_runtime_checkpoint(
            ${claim!.orgId}::uuid, ${claim!.companionId}::uuid,
            ${claim!.claimToken}::uuid, ${claim!.claimEpoch}, ${claim!.gateEpoch},
            'disable-checkpoint', ${claim!.workKind}, ${claim!.workId}::uuid,
            ${claim!.checkpointSequence}, 'stopping_pi', null, null::uuid, null, null, null,
            null, null, null
          )::int as sequence
        `;
        return row?.sequence ?? null;
      });
      void checkpointRun.catch(() => undefined);
      await waitForBackendLock(await checkpointPid, "checkpoint behind disable lease");

      unblockOperation?.();
      await blockerRun;
      const [disabled, sequence] = await Promise.all([
        settlesWithin(disableRun, 5_000, "concurrent disable"),
        settlesWithin(checkpointRun, 5_000, "checkpoint fenced by disable"),
      ]);
      expect(disabled).toEqual({ enabled: false, gateEpoch: gate.gateEpoch + 1 });
      expect(sequence).toBeNull();

      const [state] = await runtimeSql<Array<{
        status: string;
        token: string | null;
        leaseEpoch: number;
      }>>`
        select o.status::text, l.claim_token::text as token, l.claim_epoch::int as "leaseEpoch"
        from companion_operations o
        join companion_runtime_leases l on l.companion_id = o.companion_id
        where o.id = ${operationId}::uuid
      `;
      expect(state).toEqual({
        status: "interrupted",
        token: null,
        leaseEpoch: claim!.claimEpoch + 1,
      });
    } finally {
      unblockOperation?.();
      await Promise.allSettled([
        blockerRun,
        ...(disableRun ? [disableRun] : []),
        ...(checkpointRun ? [checkpointRun] : []),
      ]);
      await blockerSql.end({ timeout: 1 });
      await disableSql.end({ timeout: 1 });
      await checkpointSql.end({ timeout: 1 });
    }
  }, 15_000);
});
