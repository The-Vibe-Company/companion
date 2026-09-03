import { createHash } from "node:crypto";
import {
  decodeRuntimeV3PreparationSnapshot,
} from "@companion/companion-runtime/runtime-support";
import type {
  RuntimeV3Claim,
  RuntimeV3ConvergencePersistence,
  RuntimeV3DecisionResponse,
  RuntimeV3DurableOutcome,
  RuntimeV3ExternalFailureClass,
  RuntimeV3LifecyclePersistence,
  RuntimeV3PreparationPersistence,
  RuntimeV3Turn,
  RuntimeV3WorkSource,
  RuntimeV3WarmTurnPersistence,
} from "@companion/companion-runtime/v3/internal";
import type { Sql } from "postgres";

interface CancellableQuery<T> extends PromiseLike<T> {
  cancel(): void;
}

const PREPARATION_LEASE_SECONDS = 90;
const LIFECYCLE_LEASE_SECONDS = 30;

async function abortable<T>(query: CancellableQuery<T>, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted();
  const cancel = (): void => query.cancel();
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    return await query;
  } finally {
    signal?.removeEventListener("abort", cancel);
  }
}

interface ClaimRow {
  orgId: string;
  companionId: string;
  turnId: string;
  commandId: string;
  lane: "main" | "background";
  state: RuntimeV3Turn["state"];
  claimToken: string;
  claimEpoch: string;
  gateEpoch: string;
  admissionStartedAt: Date | null;
  inactivityDeadlineAt: Date | null;
  absoluteDeadlineAt: Date | null;
  cleanupBoxId?: string | null;
  cleanupInvocationId?: string | null;
  workSource?: RuntimeV3WorkSource;
  boxDependency?: string;
  modelDependency?: string;
  pluginProviderDependency?: string;
  authorityDependency?: string;
}

export interface RuntimeV3ExternalIncidentEvent {
  signalId: string;
  incidentId: string;
  state: "opened" | "recovered";
  classification: RuntimeV3ExternalFailureClass;
  source: RuntimeV3WorkSource;
  stableCode?: string;
}

interface PostgresConvergenceOptions {
  enabledLanes?: ReadonlySet<"main" | "background">;
  backgroundOnly?: boolean;
  jitter?: () => number;
  onExternalIncident?: (event: RuntimeV3ExternalIncidentEvent) => void;
}

type IncidentObserverOptions = Pick<PostgresConvergenceOptions, "onExternalIncident">;

async function drainExternalIncidentSignal(
  sql: Sql,
  executorId: string,
  options: IncidentObserverOptions,
  signal?: AbortSignal,
): Promise<boolean> {
  if (!options.onExternalIncident) return false;
  const rows = await abortable(sql<Array<{
    signalId: string;
    incidentId: string;
    state: "opened" | "recovered";
    classification: RuntimeV3ExternalFailureClass;
    source: RuntimeV3WorkSource;
    stableCode: string;
    claimToken: string;
    claimEpoch: string;
  }>>`
    select signal_id as "signalId",incident_id as "incidentId",kind as state,
      failure_class::text as classification,source::text,stable_code as "stableCode",
      claim_token as "claimToken",claim_epoch::text as "claimEpoch"
    from public.companion_v3_runtime_claim_external_incident_signal_v9(${executorId},30,9)
  `, signal);
  const row = rows[0];
  if (!row) return false;
  const event: RuntimeV3ExternalIncidentEvent = {
    signalId: row.signalId,
    incidentId: row.incidentId,
    state: row.state,
    classification: row.classification,
    source: row.source,
  };
  if (row.state === "opened") event.stableCode = row.stableCode;
  options.onExternalIncident(event);
  const acknowledged = await abortable(sql<Array<{ acknowledged: boolean }>>`
    select public.companion_v3_runtime_ack_external_incident_signal_v9(
      ${row.signalId}::uuid,${row.claimToken}::uuid,${row.claimEpoch}::bigint,9) as acknowledged
  `, signal);
  return acknowledged[0]?.acknowledged === true;
}

async function recoverExternalIncident(
  sql: Sql,
  claim: { orgId: string; companionId: string; turnId: string },
  options: IncidentObserverOptions,
  signal?: AbortSignal,
): Promise<boolean> {
  const rows = await abortable(sql<Array<{
    classification: RuntimeV3ExternalFailureClass;
    source: RuntimeV3WorkSource;
  }>>`
    select failure_class::text as classification,source::text
    from public.companion_v3_runtime_recover_external_turn_v9(
      ${claim.orgId}::uuid,${claim.companionId}::uuid,${claim.turnId}::uuid,9)
  `, signal);
  if (rows.length > 0) await drainExternalIncidentSignal(
    sql,
    `incident-recovery:${claim.turnId}`,
    options,
    signal,
  );
  return true;
}

interface TerminalCompletion {
  outcome: "release" | "detached" | "ack_completed" | "retry_ack" | "cleanup_completed" | "admission_rejected" | "succeeded" | "failed" | "interrupted" | "decision_ambiguous";
  code: string | null;
  message: string | null;
  action: string | null;
}

function turnFromRow(row: {
  turnId: string;
  commandId: string;
  lane: "main" | "background";
  state: RuntimeV3Turn["state"];
  admissionStartedAt: Date | null;
  inactivityDeadlineAt: Date | null;
  absoluteDeadlineAt: Date | null;
}): RuntimeV3Turn {
  return {
    id: row.turnId,
    commandId: row.commandId,
    lane: row.lane,
    state: row.state,
    admissionStartedAt: row.admissionStartedAt,
    inactivityDeadlineAt: row.inactivityDeadlineAt,
    absoluteDeadlineAt: row.absoluteDeadlineAt,
  };
}

function terminalInput(
  outcome: Exclude<RuntimeV3DurableOutcome, { kind: "external_retry" }>,
): TerminalCompletion {
  if (
    outcome.kind === "failed"
    || outcome.kind === "interrupted"
    || outcome.kind === "admission_rejected"
    || outcome.kind === "decision_ambiguous"
  ) {
    return {
      outcome: outcome.kind,
      code: outcome.error.code,
      message: outcome.error.message,
      action: outcome.error.action,
    };
  }
  return { outcome: outcome.kind, code: null, message: null, action: null };
}

/** Runtime-role PostgreSQL adapter kept outside the caller-facing interface and composition root. */
export function createRuntimeV3PostgresConvergence(
  sql: Sql,
  options: PostgresConvergenceOptions = {},
): RuntimeV3ConvergencePersistence {
  return createPostgresConvergence(sql, false, options);
}

/** Warm-only production adapter: durable v3 preparation is part of claim eligibility. */
export function createRuntimeV3PostgresWarmConvergence(
  sql: Sql,
  options: PostgresConvergenceOptions = {},
): RuntimeV3ConvergencePersistence {
  return createPostgresConvergence(sql, true, options);
}

/** The single background claimant consumes routine and trigger occurrences in queue order. */
export function createRuntimeV3PostgresBackgroundConvergence(
  sql: Sql,
  options: Pick<PostgresConvergenceOptions, "jitter" | "onExternalIncident"> = {},
): RuntimeV3ConvergencePersistence {
  return createPostgresConvergence(sql, true, {
    ...options,
    enabledLanes: new Set(["background"]),
    backgroundOnly: true,
  });
}

export const createRuntimeV3PostgresRoutineConvergence = createRuntimeV3PostgresBackgroundConvergence;

function createPostgresConvergence(
  sql: Sql,
  warmOnly: boolean,
  options: PostgresConvergenceOptions,
): RuntimeV3ConvergencePersistence {
  return {
    async sweepLane({ lane, signal }) {
      await drainExternalIncidentSignal(sql, `incident-sweep:${lane}`, options, signal);
      if (options.enabledLanes && !options.enabledLanes.has(lane)) return 0;
      if (options.backgroundOnly) {
        const routineRows = await abortable(sql<Array<{ swept: number }>>`
          select public.companion_v3_runtime_sweep_background_deadlines_v8(8) as swept
        `, signal);
        return routineRows[0]?.swept ?? 0;
      }
      const decisionRows = await abortable(sql<Array<{ swept: number }>>`
        select public.companion_v3_runtime_sweep_decisions(${lane}, 6) as swept
      `, signal);
      return decisionRows[0]?.swept ?? 0;
    },
    async claimLane({ executorId, lane, signal }) {
      if (options.enabledLanes && !options.enabledLanes.has(lane)) return null;
      const rows = warmOnly && options.backgroundOnly
        ? await abortable(sql<ClaimRow[]>`
          select org_id as "orgId", companion_id as "companionId", turn_id as "turnId",
            command_id as "commandId", lane::text, state::text,
            claim_token as "claimToken", claim_epoch::text as "claimEpoch",
            gate_epoch::text as "gateEpoch", admission_started_at as "admissionStartedAt",
            inactivity_deadline_at as "inactivityDeadlineAt",
            absolute_deadline_at as "absoluteDeadlineAt", cleanup_box_id as "cleanupBoxId",
            cleanup_invocation_id as "cleanupInvocationId",work_source::text as "workSource",
            box_dependency as "boxDependency",model_dependency as "modelDependency",
            plugin_provider_dependency as "pluginProviderDependency",
            authority_dependency as "authorityDependency"
          from public.companion_v3_runtime_claim_background_v9(${executorId}, ${lane}, 30, 9)
        `, signal)
        : warmOnly ? await abortable(sql<ClaimRow[]>`
          select org_id as "orgId", companion_id as "companionId", turn_id as "turnId",
            command_id as "commandId", lane::text, state::text,
            claim_token as "claimToken", claim_epoch::text as "claimEpoch",
            gate_epoch::text as "gateEpoch", admission_started_at as "admissionStartedAt",
            inactivity_deadline_at as "inactivityDeadlineAt",
            absolute_deadline_at as "absoluteDeadlineAt",work_source::text as "workSource",
            box_dependency as "boxDependency",model_dependency as "modelDependency",
            plugin_provider_dependency as "pluginProviderDependency",
            authority_dependency as "authorityDependency"
          from public.companion_v3_runtime_claim_warm_v9(${executorId}, ${lane}, 30, 9)
        `, signal)
        : await abortable(sql<ClaimRow[]>`
          select org_id as "orgId", companion_id as "companionId", turn_id as "turnId",
            command_id as "commandId", lane::text, state::text,
            claim_token as "claimToken", claim_epoch::text as "claimEpoch",
            gate_epoch::text as "gateEpoch", admission_started_at as "admissionStartedAt",
            inactivity_deadline_at as "inactivityDeadlineAt",
            absolute_deadline_at as "absoluteDeadlineAt"
          from public.companion_v3_runtime_claim_v4(${executorId}, ${lane}, 30, 4)
        `, signal);
      const row = rows[0];
      if (!row) return null;
      const externalDependencyKeys: NonNullable<RuntimeV3Claim["externalDependencyKeys"]> = {};
      if (row.boxDependency) externalDependencyKeys.box = row.boxDependency;
      if (row.modelDependency) externalDependencyKeys.model = row.modelDependency;
      if (row.pluginProviderDependency) {
        externalDependencyKeys.plugin_provider = row.pluginProviderDependency;
      }
      if (row.authorityDependency) externalDependencyKeys.authority = row.authorityDependency;
      const claim: RuntimeV3Claim = {
          turn: turnFromRow(row),
          fence: {
            token: row.claimToken,
            epoch: BigInt(row.claimEpoch),
            gateEpoch: BigInt(row.gateEpoch),
          },
          orgId: row.orgId,
          companionId: row.companionId,
          source: row.workSource,
          externalDependencyKeys,
      };
      if (row.cleanupBoxId && row.cleanupInvocationId) {
        claim.cleanup = {
          boxId: row.cleanupBoxId,
          invocationId: row.cleanupInvocationId,
        };
      }
      return claim;
    },
    async completeProgression(claim, outcome, signal) {
      if (outcome.kind === "external_retry") {
        const dependencyFingerprint = outcome.dependencyKey === null
          ? null
          : createHash("sha256")
            .update(`runtime-v3:${outcome.failureClass}:${outcome.dependencyKey}`)
            .digest("hex");
        const rows = await abortable(sql<Array<{
          incidentId: string;
          incidentOpened: boolean;
          delaySeconds: number;
        }>>`
          select incident_id as "incidentId",incident_opened as "incidentOpened",
            delay_seconds as "delaySeconds"
          from public.companion_v3_runtime_defer_external_v9(
            ${claim.orgId}::uuid,${claim.companionId}::uuid,${claim.turn.lane},
            ${claim.turn.id}::uuid,${claim.fence.token}::uuid,
            ${claim.fence.epoch.toString()}::bigint,${claim.fence.gateEpoch.toString()}::bigint,
            ${outcome.failureClass}::public.companion_v3_external_failure_class,
            ${outcome.source}::public.companion_v3_work_source,${dependencyFingerprint}::text,
            ${outcome.error.code},${outcome.error.message},${(options.jitter ?? Math.random)()},9)
        `, signal);
        const deferred = rows[0];
        if (deferred) await drainExternalIncidentSignal(
          sql,
          `incident-open:${claim.turn.id}`,
          options,
          signal,
        );
        return deferred !== undefined;
      }
      const terminal = terminalInput(outcome);
      const rows = await abortable(sql<Array<{ completed: boolean }>>`
        select ${options.backgroundOnly
          ? sql`public.companion_v3_runtime_complete_v8`
          : sql`public.companion_v3_runtime_complete_v7`}(
          ${claim.orgId}::uuid,
          ${claim.companionId}::uuid,
          ${claim.turn.lane},
          ${claim.turn.id}::uuid,
          ${claim.fence.token}::uuid,
          ${claim.fence.epoch.toString()}::bigint,
          ${claim.fence.gateEpoch.toString()}::bigint,
          ${terminal.outcome},
          ${terminal.code},
          ${terminal.message},
          ${terminal.action}::public.companion_runtime_error_action,
          ${options.backgroundOnly ? 8 : 7}
        ) as completed
      `, signal);
      return rows[0]?.completed === true;
    },
  };
}

interface WarmMaterialRow {
  boxId: string;
  piInvocationId: string;
  content: string;
  activityCursor: string;
  recoveryDeferred: boolean;
  outputsHarvested: boolean;
  messageEventId: string;
  attachments: Array<{
    storage_key: string;
    content_type: string;
    byte_size: number;
    sha256: string;
    filename: string;
    position: number;
    expires_at: string;
  }>;
}

interface RoutineMaterialRow extends Omit<WarmMaterialRow, "messageEventId" | "attachments"> {
  persona: string | null;
  backgroundKind: "routine" | "trigger";
  validationOnly: boolean;
  directWorkspace: boolean;
}

interface DecisionActionRow {
  kind: "respond" | "detach";
  decisionId: string;
  commandId: string;
  response: RuntimeV3DecisionResponse | null;
}

interface PreparationClaimRow {
  orgId: string;
  companionId: string;
  turnId: string | null;
  commandId: string | null;
  checkpoint: "pending" | "box_created" | "box_ready" | "staged";
  piRecycleCheckpoint: "terminate" | "reset" | "ready" | null;
  recyclePiInvocationId: string | null;
  recoveryId: string | null;
  recoveryContext: string | null;
  boxIdempotencyKey: string;
  boxId: string | null;
  claimToken: string;
  claimEpoch: string;
  gateEpoch: string;
  createdAt: Date;
  attemptCount: number;
  deadlineAt: Date | null;
  authorized: boolean;
  actorId: string | null;
  modelId: string | null;
  persona: string | null;
  settingsRevision: string | null;
  skillsRevision: number | null;
  providerRefs: unknown;
  skillRefs: unknown;
  mcpRefs: unknown;
  providerMaterial: unknown;
  skillMaterial: unknown;
  mcpMaterial: unknown;
  configCatalog: unknown;
}

interface LifecycleClaimRow {
  orgId: string;
  companionId: string;
  checkpoint: Parameters<RuntimeV3LifecyclePersistence["checkpoint"]>[0]["checkpoint"];
  boxId: string | null;
  providerOperationId: string | null;
  claimToken: string;
  claimEpoch: string;
  gateEpoch: string;
}

/** Runtime-only lifecycle facts; the API and worker can persist intent but never receive Box data. */
export function createRuntimeV3PostgresLifecyclePersistence(
  sql: Sql,
): RuntimeV3LifecyclePersistence {
  return {
    async claim({ executorId, signal }) {
      const rows = await abortable(sql<LifecycleClaimRow[]>`
        select org_id as "orgId", companion_id as "companionId", checkpoint::text,
          box_id as "boxId", provider_operation_id as "providerOperationId",
          claim_token as "claimToken", claim_epoch::text as "claimEpoch",
          gate_epoch::text as "gateEpoch"
        from public.companion_v3_runtime_claim_lifecycle(
          ${executorId}, ${LIFECYCLE_LEASE_SECONDS}, 5
        )
      `, signal);
      const row = rows[0];
      return row ? {
        executorId,
        orgId: row.orgId,
        companionId: row.companionId,
        checkpoint: row.checkpoint,
        boxId: row.boxId,
        providerOperationId: row.providerOperationId,
        fence: {
          token: row.claimToken,
          epoch: BigInt(row.claimEpoch),
          gateEpoch: BigInt(row.gateEpoch),
        },
      } : null;
    },
    async checkpoint(claim, input, signal) {
      const rows = await abortable(sql<Array<{ checkpointed: boolean }>>`
        select public.companion_v3_runtime_checkpoint_lifecycle(
          ${claim.orgId}::uuid, ${claim.companionId}::uuid,
          ${claim.fence.token}::uuid, ${claim.fence.epoch.toString()}::bigint,
          ${claim.fence.gateEpoch.toString()}::bigint,
          ${claim.checkpoint}::public.companion_v3_lifecycle_state,
          ${input.next}::public.companion_v3_lifecycle_state,
          ${input.providerOperationId ?? null}, 5
        ) as checkpointed
      `, signal);
      return rows[0]?.checkpointed === true;
    },
    async defer(claim, input, signal) {
      const rows = await abortable(sql<Array<{ deferred: boolean }>>`
        select public.companion_v3_runtime_defer_lifecycle(
          ${claim.orgId}::uuid, ${claim.companionId}::uuid,
          ${claim.fence.token}::uuid, ${claim.fence.epoch.toString()}::bigint,
          ${claim.fence.gateEpoch.toString()}::bigint, ${input.delaySeconds},
          ${input.error?.code ?? null}, ${input.error?.message ?? null}, 5
        ) as deferred
      `, signal);
      return rows[0]?.deferred === true;
    },
    async finalizeDeletion(claim, signal) {
      const rows = await abortable(sql<Array<{ finalized: boolean }>>`
        select public.companion_v3_runtime_finalize_delete(
          ${claim.orgId}::uuid, ${claim.companionId}::uuid,
          ${claim.fence.token}::uuid, ${claim.fence.epoch.toString()}::bigint,
          ${claim.fence.gateEpoch.toString()}::bigint, 5
        ) as finalized
      `, signal);
      return rows[0]?.finalized === true;
    },
  };
}

/** Runtime-only preparation facts. Box identity crosses this seam only after a fenced checkpoint. */
export function createRuntimeV3PostgresPreparationPersistence(
  sql: Sql,
  options: Pick<PostgresConvergenceOptions, "onExternalIncident"> = {},
): RuntimeV3PreparationPersistence {
  return {
    async sweepDeadlines({ signal }) {
      const rows = await abortable(sql<Array<{ swept: number }>>`
        select public.companion_v3_runtime_sweep_preparation_deadlines(5) as swept
      `, signal);
      return rows[0]?.swept ?? 0;
    },
    async claim({ executorId, signal }) {
      const rows = await abortable(sql<PreparationClaimRow[]>`
        select org_id as "orgId", companion_id as "companionId", turn_id as "turnId",
          command_id as "commandId", checkpoint, box_idempotency_key as "boxIdempotencyKey",
          box_id as "boxId", claim_token as "claimToken", claim_epoch::text as "claimEpoch",
          gate_epoch::text as "gateEpoch", created_at as "createdAt",
          attempt_count as "attemptCount", deadline_at as "deadlineAt",
          authorized, actor_id as "actorId", model_id as "modelId", persona,
          settings_revision::text as "settingsRevision", skills_revision as "skillsRevision",
          provider_refs as "providerRefs", skill_refs as "skillRefs", mcp_refs as "mcpRefs",
          provider_material as "providerMaterial", skill_material as "skillMaterial",
          mcp_material as "mcpMaterial", config_catalog as "configCatalog",
          pi_recycle_checkpoint as "piRecycleCheckpoint",
          recycle_pi_invocation_id as "recyclePiInvocationId",
          recovery_id as "recoveryId", recovery_context as "recoveryContext"
        from public.companion_v3_runtime_claim_preparation_v6(
          ${executorId}, ${PREPARATION_LEASE_SECONDS}, 6
        )
      `, signal);
      const row = rows[0];
      const material = row ? decodeRuntimeV3PreparationSnapshot({
        provider_refs: row.providerRefs,
        skill_refs: row.skillRefs,
        mcp_refs: row.mcpRefs,
        provider_material: row.providerMaterial,
        skill_material: row.skillMaterial,
        mcp_material: row.mcpMaterial,
        config_catalog: row.configCatalog,
      }) : null;
      return row ? {
        executorId,
        orgId: row.orgId,
        companionId: row.companionId,
        turnId: row.turnId,
        commandId: row.commandId,
        checkpoint: row.checkpoint,
        piRecycleCheckpoint: row.piRecycleCheckpoint,
        recyclePiInvocationId: row.recyclePiInvocationId,
        recoveryId: row.recoveryId,
        recoveryContext: row.recoveryContext,
        boxIdempotencyKey: row.boxIdempotencyKey,
        boxId: row.boxId,
        createdAt: row.createdAt,
        attemptCount: row.attemptCount,
        deadlineAt: row.deadlineAt,
        authorized: row.authorized,
        actorId: row.actorId,
        modelId: row.modelId,
        persona: row.persona,
        settingsRevision: row.settingsRevision === null ? null : BigInt(row.settingsRevision),
        skillsRevision: row.skillsRevision,
        providerRefs: material?.providerRefs ?? [],
        skillRefs: material?.skillRefs ?? [],
        mcpRefs: material?.mcpRefs ?? [],
        providerMaterial: material?.providerMaterial ?? [],
        skillMaterial: material?.skillMaterial ?? [],
        mcpMaterial: material?.mcpMaterial ?? [],
        configCatalog: material?.configCatalog ?? null,
        fence: {
          token: row.claimToken,
          epoch: BigInt(row.claimEpoch),
          gateEpoch: BigInt(row.gateEpoch),
        },
      } : null;
    },
    async checkpoint(claim, input, signal) {
      const rows = await abortable(sql<Array<{ checkpointed: boolean }>>`
        select public.companion_v3_runtime_checkpoint_preparation_v6(
          ${claim.orgId}::uuid, ${claim.companionId}::uuid,
          ${claim.fence.token}::uuid, ${claim.fence.epoch.toString()}::bigint,
          ${claim.fence.gateEpoch.toString()}::bigint, ${claim.checkpoint}, ${input.next},
          ${input.boxId ?? null}, ${input.piInvocationId ?? null},
          ${input.diskLayoutVersion ?? null},
          ${input.appliedSettingsRevision?.toString() ?? null}::bigint,
          ${input.appliedSkillsRevision ?? null}, ${input.skillsDigest ?? null},
          ${input.materialExpiresAt ?? null}, 6
        ) as checkpointed
      `, signal);
      const checkpointed = rows[0]?.checkpointed === true;
      if (checkpointed && claim.turnId) {
        await recoverExternalIncident(
          sql,
          { orgId: claim.orgId, companionId: claim.companionId, turnId: claim.turnId },
          options,
          signal,
        );
      }
      return checkpointed;
    },
    async checkpointPiRecycle(claim, next, signal) {
      const checkpoint = claim.piRecycleCheckpoint;
      if (!checkpoint) return false;
      const rows = await abortable(sql<Array<{ checkpointed: boolean }>>`
        select public.companion_v3_runtime_checkpoint_pi_recycle(
          ${claim.orgId}::uuid, ${claim.companionId}::uuid,
          ${claim.fence.token}::uuid, ${claim.fence.epoch.toString()}::bigint,
          ${claim.fence.gateEpoch.toString()}::bigint,
          ${checkpoint}, ${next}, 6
        ) as checkpointed
      `, signal);
      return rows[0]?.checkpointed === true;
    },
    async reconcilePiRecycleInvocation(claim, input, signal) {
      const rows = await abortable(sql<Array<{ reconciled: boolean }>>`
        select public.companion_v3_runtime_reconcile_pi_recycle_invocation(
          ${claim.orgId}::uuid, ${claim.companionId}::uuid,
          ${claim.fence.token}::uuid, ${claim.fence.epoch.toString()}::bigint,
          ${claim.fence.gateEpoch.toString()}::bigint,
          ${input.expectedInvocationId}, ${input.observedInvocationId}, 6
        ) as reconciled
      `, signal);
      return rows[0]?.reconciled === true;
    },
    async defer(claim, input, signal) {
      if (input.externalFailureClass && input.dependencyKey && claim.turnId && input.error) {
        const fingerprint = createHash("sha256")
          .update(`runtime-v3:${input.externalFailureClass}:${input.dependencyKey}`)
          .digest("hex");
        const rows = await abortable(sql<Array<{
          incidentOpened: boolean;
          source: RuntimeV3WorkSource;
        }>>`
          select incident_opened as "incidentOpened",source::text
          from public.companion_v3_runtime_defer_preparation_external_v9(
            ${claim.orgId}::uuid,${claim.companionId}::uuid,${claim.turnId}::uuid,
            ${claim.fence.token}::uuid,${claim.fence.epoch.toString()}::bigint,
            ${claim.fence.gateEpoch.toString()}::bigint,
            ${input.externalFailureClass}::public.companion_v3_external_failure_class,
            ${fingerprint},${input.error.code},${input.error.message},${input.delaySeconds},9)
        `, signal);
        const row = rows[0];
        if (!row) return false;
        await drainExternalIncidentSignal(
          sql,
          `incident-open:${claim.turnId}`,
          options,
          signal,
        );
        return true;
      }
      const rows = await abortable(sql<Array<{ deferred: boolean }>>`
        select public.companion_v3_runtime_defer_preparation(
          ${claim.orgId}::uuid, ${claim.companionId}::uuid,
          ${claim.fence.token}::uuid, ${claim.fence.epoch.toString()}::bigint,
          ${claim.fence.gateEpoch.toString()}::bigint, ${input.delaySeconds},
          ${input.error?.code ?? null}, ${input.error?.message ?? null}, 4
        ) as deferred
      `, signal);
      return rows[0]?.deferred === true;
    },
    async fail(claim, input, signal) {
      if (!claim.turnId) return false;
      const rows = await abortable(sql<Array<{ failed: boolean }>>`
        select public.companion_v3_runtime_fail_preparation_v9(
          ${claim.orgId}::uuid, ${claim.companionId}::uuid, ${claim.turnId}::uuid,
          ${claim.fence.token}::uuid, ${claim.fence.epoch.toString()}::bigint,
          ${claim.fence.gateEpoch.toString()}::bigint,
          ${input.error.code}, ${input.error.message},
          ${input.error.action}::public.companion_runtime_error_action, 9
        ) as failed
      `, signal);
      return rows[0]?.failed === true;
    },
    async reauthorize(claim, signal) {
      const rows = await abortable(sql<Array<{ authorized: boolean }>>`
        select public.companion_v3_runtime_reauthorize_preparation(
          ${claim.orgId}::uuid, ${claim.companionId}::uuid,
          ${claim.fence.token}::uuid, ${claim.fence.epoch.toString()}::bigint,
          ${claim.fence.gateEpoch.toString()}::bigint, ${claim.executorId},
          ${PREPARATION_LEASE_SECONDS}, 4
        ) as authorized
      `, signal);
      return rows[0]?.authorized === true;
    },
    async mintCredentials(claim, signal) {
      const rows = await abortable(sql<Array<{
        hubToken: string;
        mcpBrokerToken: string | null;
        controlToken: string;
        expiresAt: Date;
      }>>`
        select hub_token as "hubToken", mcp_broker_token as "mcpBrokerToken",
          control_token as "controlToken", expires_at as "expiresAt"
        from public.companion_v3_runtime_mint_preparation_credentials(
          ${claim.orgId}::uuid, ${claim.companionId}::uuid,
          ${claim.fence.token}::uuid, ${claim.fence.epoch.toString()}::bigint,
          ${claim.fence.gateEpoch.toString()}::bigint, ${claim.executorId},
          ${PREPARATION_LEASE_SECONDS}, 4
        )
      `, signal);
      return rows[0] ?? null;
    },
  };
}

/** Fenced Runtime v3 warm-turn facts; Box/Pi values never cross into the API process. */
export function createRuntimeV3PostgresWarmTurnPersistence(
  sql: Sql,
  options: IncidentObserverOptions = {},
): RuntimeV3WarmTurnPersistence {
  return {
    async recoverExternal(claim, signal) {
      return await recoverExternalIncident(
        sql,
        { orgId: claim.orgId, companionId: claim.companionId, turnId: claim.turn.id },
        options,
        signal,
      );
    },
    async authorize(claim, signal) {
      const rows = await abortable(sql<WarmMaterialRow[]>`
        select box_id as "boxId", pi_invocation_id as "piInvocationId",
          content, activity_cursor::text as "activityCursor",
          recovery_deferred as "recoveryDeferred",outputs_harvested as "outputsHarvested",
          message_event_id as "messageEventId",attachments
        from public.companion_v3_runtime_authorize_warm_turn_v8(
          ${claim.orgId}::uuid,
          ${claim.companionId}::uuid,
          ${claim.turn.lane},
          ${claim.turn.id}::uuid,
          ${claim.fence.token}::uuid,
          ${claim.fence.epoch.toString()}::bigint,
          ${claim.fence.gateEpoch.toString()}::bigint,
          8
        )
      `, signal);
      const row = rows[0];
      return row
        ? {
          boxId: row.boxId,
          piInvocationId: row.piInvocationId,
          content: row.content,
          cursor: BigInt(row.activityCursor),
          recoveryDeferred: row.recoveryDeferred,
          outputsHarvested: row.outputsHarvested,
          messageEventId: row.messageEventId,
          inputAttachments: row.attachments.map((attachment) => ({
            storageKey: attachment.storage_key,
            contentType: attachment.content_type,
            byteSize: attachment.byte_size,
            sha256: attachment.sha256,
            filename: attachment.filename,
            position: attachment.position,
            expiresAt: new Date(attachment.expires_at),
          })),
        }
        : null;
    },
    async beginAdmission(claim, input, signal) {
      const rows = await abortable(sql<Array<{ begun: boolean }>>`
        select public.companion_v3_runtime_begin_admission_v5(
          ${claim.orgId}::uuid,
          ${claim.companionId}::uuid,
          ${claim.turn.lane},
          ${claim.turn.id}::uuid,
          ${claim.fence.token}::uuid,
          ${claim.fence.epoch.toString()}::bigint,
          ${claim.fence.gateEpoch.toString()}::bigint,
          ${input.invocationId}, ${input.cursor.toString()}::bigint, 5
        ) as begun
      `, signal);
      return rows[0]?.begun === true;
    },
    async recordAdmission(claim, input, signal) {
      const rows = await abortable(sql<Array<{ recorded: boolean }>>`
        select public.companion_v3_runtime_record_native_admission_v5(
          ${claim.orgId}::uuid,
          ${claim.companionId}::uuid,
          ${claim.turn.lane},
          ${claim.turn.id}::uuid,
          ${claim.fence.token}::uuid,
          ${claim.fence.epoch.toString()}::bigint,
          ${claim.fence.gateEpoch.toString()}::bigint,
          ${input.invocationId},
          ${input.responseTurnId}::uuid,
          ${input.cursor.toString()}::bigint,
          5
        ) as recorded
      `, signal);
      return rows[0]?.recorded === true;
    },
    async project(claim, projection, signal) {
      const fallbacks = projection.assistantFallbacks ?? [];
      if (fallbacks.length > 0) {
        const recorded = await abortable(sql<Array<{ recorded: boolean }>>`
          select public.companion_v3_runtime_record_native_fallback_v8(
            ${claim.orgId}::uuid,
            ${claim.companionId}::uuid,
            ${claim.turn.lane},
            ${claim.turn.id}::uuid,
            ${claim.fence.token}::uuid,
            ${claim.fence.epoch.toString()}::bigint,
            ${claim.fence.gateEpoch.toString()}::bigint,
            ${sql.json(fallbacks.map((fallback) => ({
              ...fallback,
              sequence: fallback.sequence.toString(),
            })))}::jsonb,
            8
          ) as recorded
        `, signal);
        if (recorded[0]?.recorded !== true) return false;
      }
      let assistant = projection.assistant;
      if (projection.settled && assistant.length === 0) {
        const fallback = await abortable(sql<Array<{ sequence: string; content: string }>>`
          select sequence::text, content
          from public.companion_v3_runtime_read_native_fallback_v8(
            ${claim.orgId}::uuid,
            ${claim.companionId}::uuid,
            ${claim.turn.lane},
            ${claim.turn.id}::uuid,
            ${claim.fence.token}::uuid,
            ${claim.fence.epoch.toString()}::bigint,
            ${claim.fence.gateEpoch.toString()}::bigint,
            8
          )
        `, signal);
        assistant = fallback.map((item) => ({
          eventId: `v3:${claim.turn.id}:${item.sequence}`,
          content: item.content,
        }));
      }
      const rows = await abortable(sql<Array<{ projected: string | null }>>`
        select public.companion_v3_runtime_project_native_page_v7(
          ${claim.orgId}::uuid,
          ${claim.companionId}::uuid,
          ${claim.turn.lane},
          ${claim.turn.id}::uuid,
          ${claim.fence.token}::uuid,
          ${claim.fence.epoch.toString()}::bigint,
          ${claim.fence.gateEpoch.toString()}::bigint,
          ${projection.throughCursor.toString()}::bigint,
          ${sql.json(assistant)}::jsonb,
          ${sql.json((projection.compactions ?? []).map((item) => ({
            ...item,
            cursor: item.cursor.toString(),
          })))}::jsonb,
          ${sql.json((projection.decisions ?? []).map((item) => ({
            ...item,
            sequence: item.sequence.toString(),
          })))}::jsonb,
          ${projection.needsInput},
          ${projection.activity},
          ${projection.processExited ? "process_exit" : projection.settled ? "settled" : null},
          7
        ) as projected
      `, signal);
      const projected = rows[0]?.projected;
      return projected === "succeeded" || projected === "failed" || projected === "detached"
        || projected === "cancel_pending"
        ? projected
        : projected === "projected";
    },
    async recordOutputs(claim, input, signal) {
      const attachments = input.attachments.map((attachment, position) => ({
        storage_key: attachment.storageKey,
        content_type: attachment.contentType,
        byte_size: attachment.byteSize,
        sha256: attachment.sha256,
        filename: attachment.filename,
        position,
        uploaded_at: attachment.uploadedAt.toISOString(),
      }));
      const rows = await abortable(sql<Array<{ recorded: number }>>`
        select recorded
        from public.companion_v3_runtime_record_turn_outputs(
          ${claim.orgId}::uuid,
          ${claim.companionId}::uuid,
          ${claim.turn.lane},
          ${claim.turn.id}::uuid,
          ${claim.fence.token}::uuid,
          ${claim.fence.epoch.toString()}::bigint,
          ${claim.fence.gateEpoch.toString()}::bigint,
          ${sql.json(attachments)}::jsonb,
          ${input.activityAt.toISOString()}::timestamptz,
          3
        )
      `, signal);
      return rows[0] !== undefined;
    },
    async pendingDelegationCancel(claim, signal) {
      const rows = await abortable(sql<Array<{
        turnId: string; responseTurnId: string; commandId: string;
      }>>`
        select turn_id as "turnId",response_turn_id as "responseTurnId",
          command_id as "commandId"
        from public.companion_v3_runtime_pending_delegation_cancel(
          ${claim.orgId}::uuid,${claim.companionId}::uuid,${claim.turn.id}::uuid,
          ${claim.fence.token}::uuid,${claim.fence.epoch.toString()}::bigint,
          ${claim.fence.gateEpoch.toString()}::bigint,7
        )
      `, signal);
      return rows[0] ?? null;
    },
    async finishDelegationCancel(claim, input, signal) {
      const rows = await abortable(sql<Array<{ finished: boolean }>>`
        select public.companion_v3_runtime_finish_delegation_cancel(
          ${claim.orgId}::uuid,${claim.companionId}::uuid,${claim.turn.id}::uuid,
          ${input.turnId}::uuid,${claim.fence.token}::uuid,
          ${claim.fence.epoch.toString()}::bigint,
          ${claim.fence.gateEpoch.toString()}::bigint,7
        ) as finished
      `, signal);
      return rows[0]?.finished === true;
    },
    async beginDecisionAction(claim, signal) {
      const rows = await abortable(sql<DecisionActionRow[]>`
        select action_kind as kind, decision_id as "decisionId", command_id as "commandId",
          response
        from public.companion_v3_runtime_begin_decision_action(
          ${claim.orgId}::uuid,
          ${claim.companionId}::uuid,
          ${claim.turn.lane},
          ${claim.turn.id}::uuid,
          ${claim.fence.token}::uuid,
          ${claim.fence.epoch.toString()}::bigint,
          ${claim.fence.gateEpoch.toString()}::bigint,
          6
        )
      `, signal);
      return rows[0] ?? null;
    },
    async finishDecisionAction(claim, input, signal) {
      const rows = await abortable(sql<Array<{ finished: boolean }>>`
        select public.companion_v3_runtime_finish_decision_action(
          ${claim.orgId}::uuid,
          ${claim.companionId}::uuid,
          ${claim.turn.lane},
          ${claim.turn.id}::uuid,
          ${claim.fence.token}::uuid,
          ${claim.fence.epoch.toString()}::bigint,
          ${claim.fence.gateEpoch.toString()}::bigint,
          ${input.decisionId}::uuid,
          ${input.kind},
          ${input.invocationId},
          6
        ) as finished
      `, signal);
      return rows[0]?.finished === true;
    },
  };
}

/** Background projection stays private while routines and triggers share one lane/fence. */
export function createRuntimeV3PostgresBackgroundTurnPersistence(
  sql: Sql,
  options: IncidentObserverOptions = {},
): RuntimeV3WarmTurnPersistence {
  const ordinary = createRuntimeV3PostgresWarmTurnPersistence(sql, options);
  return {
    ...ordinary,
    async authorize(claim, signal) {
      const rows = await abortable(sql<RoutineMaterialRow[]>`
        select box_id as "boxId", pi_invocation_id as "piInvocationId", content,
          activity_cursor::text as "activityCursor", recovery_deferred as "recoveryDeferred",
          outputs_harvested as "outputsHarvested", persona,
          background_kind as "backgroundKind", validation_only as "validationOnly",
          direct_workspace as "directWorkspace"
        from public.companion_v3_runtime_authorize_background_v9(
          ${claim.orgId}::uuid, ${claim.companionId}::uuid, ${claim.turn.id}::uuid,
          ${claim.fence.token}::uuid, ${claim.fence.epoch.toString()}::bigint,
          ${claim.fence.gateEpoch.toString()}::bigint, 9
        )
      `, signal);
      const row = rows[0];
      return row ? {
        boxId: row.boxId,
        piInvocationId: row.piInvocationId,
        content: row.content,
        cursor: BigInt(row.activityCursor),
        recoveryDeferred: row.recoveryDeferred,
        outputsHarvested: row.outputsHarvested,
        backgroundRoutine: true,
        backgroundKind: row.backgroundKind,
        validationOnly: row.validationOnly,
        directWorkspace: row.directWorkspace,
        persona: row.persona,
      } : null;
    },
    async beginAdmission(claim, input, signal) {
      const rows = await abortable(sql<Array<{ begun: boolean }>>`
        select public.companion_v3_runtime_begin_background_admission_v9(
          ${claim.orgId}::uuid, ${claim.companionId}::uuid, ${claim.turn.id}::uuid,
          ${claim.fence.token}::uuid, ${claim.fence.epoch.toString()}::bigint,
          ${claim.fence.gateEpoch.toString()}::bigint, ${input.invocationId},
          ${input.cursor.toString()}::bigint, 9
        ) as begun
      `, signal);
      return rows[0]?.begun === true;
    },
    async project(claim, projection, signal) {
      const fallbacks = projection.assistantFallbacks ?? [];
      if (fallbacks.length > 0) {
        const recorded = await abortable(sql<Array<{ recorded: boolean }>>`
          select public.companion_v3_runtime_record_native_fallback_v8(
            ${claim.orgId}::uuid, ${claim.companionId}::uuid, ${claim.turn.lane},
            ${claim.turn.id}::uuid, ${claim.fence.token}::uuid,
            ${claim.fence.epoch.toString()}::bigint,
            ${claim.fence.gateEpoch.toString()}::bigint,
            ${sql.json(fallbacks.map((fallback) => ({
              ...fallback, sequence: fallback.sequence.toString(),
            })))}::jsonb, 8
          ) as recorded
        `, signal);
        if (recorded[0]?.recorded !== true) return false;
      }
      let privateEntries = projection.privateEntries ?? [];
      if (projection.settled && !privateEntries.some((item) => item.type === "assistant")) {
        const fallback = await abortable(sql<Array<{ sequence: string; content: string }>>`
          select sequence::text, content
          from public.companion_v3_runtime_read_native_fallback_v8(
            ${claim.orgId}::uuid, ${claim.companionId}::uuid, ${claim.turn.lane},
            ${claim.turn.id}::uuid, ${claim.fence.token}::uuid,
            ${claim.fence.epoch.toString()}::bigint,
            ${claim.fence.gateEpoch.toString()}::bigint, 8
          )
        `, signal);
        privateEntries = [...privateEntries, ...fallback.map((item) => {
          const sequence = BigInt(item.sequence);
          return {
            sequence,
            type: "assistant" as const,
            entry_key: `assistant:${item.sequence}`,
            content: item.content,
          };
        })].sort((left, right) => left.sequence < right.sequence ? -1 : 1);
      }
      const rows = await abortable(sql<Array<{ projected: string | null }>>`
        select public.companion_v3_runtime_project_background_page_v9(
          ${claim.orgId}::uuid, ${claim.companionId}::uuid, ${claim.turn.id}::uuid,
          ${claim.fence.token}::uuid, ${claim.fence.epoch.toString()}::bigint,
          ${claim.fence.gateEpoch.toString()}::bigint,
          ${projection.throughCursor.toString()}::bigint,
          ${sql.json(privateEntries.map((item) => ({
            ...item, sequence: item.sequence.toString(),
          })))}::jsonb,
          ${sql.json((projection.decisions ?? []).map((item) => ({
            ...item, sequence: item.sequence.toString(),
          })))}::jsonb,
          ${sql.json((projection.routineReturns ?? []).map((item) => ({
            ...item, sequence: item.sequence.toString(),
          })))}::jsonb,
          ${projection.needsInput}, ${projection.activity},
          ${projection.processExited ? "process_exit" : projection.settled ? "settled" : null},
          9
        ) as projected
      `, signal);
      const projected = rows[0]?.projected;
      return projected === "succeeded" || projected === "failed" || projected === "detached"
        ? projected
        : projected === "projected";
    },
  };
}

export const createRuntimeV3PostgresRoutineTurnPersistence =
  createRuntimeV3PostgresBackgroundTurnPersistence;
