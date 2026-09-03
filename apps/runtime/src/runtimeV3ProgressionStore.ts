import {
  decodeRuntimeV3PreparationSnapshot,
} from "@companion/companion-runtime";
import type {
  RuntimeV3ConvergencePersistence,
  RuntimeV3DurableOutcome,
  RuntimeV3LifecyclePersistence,
  RuntimeV3PreparationPersistence,
  RuntimeV3Turn,
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
}

interface TerminalCompletion {
  outcome: "release" | "ack_completed" | "retry_ack" | "succeeded" | "failed" | "interrupted";
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

function terminalInput(outcome: RuntimeV3DurableOutcome): TerminalCompletion {
  if (outcome.kind === "failed" || outcome.kind === "interrupted") {
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
  options: { enabledLanes?: ReadonlySet<"main" | "background"> } = {},
): RuntimeV3ConvergencePersistence {
  return createPostgresConvergence(sql, false, options);
}

/** Warm-only production adapter: durable v3 preparation is part of claim eligibility. */
export function createRuntimeV3PostgresWarmConvergence(
  sql: Sql,
  options: { enabledLanes?: ReadonlySet<"main" | "background"> } = {},
): RuntimeV3ConvergencePersistence {
  return createPostgresConvergence(sql, true, options);
}

function createPostgresConvergence(
  sql: Sql,
  warmOnly: boolean,
  options: { enabledLanes?: ReadonlySet<"main" | "background"> },
): RuntimeV3ConvergencePersistence {
  return {
    async sweepLane({ lane, signal }) {
      const rows = await abortable(sql<Array<{ swept: number }>>`
        select public.companion_v3_runtime_sweep_deadlines(${lane}, 4) as swept
      `, signal);
      return rows[0]?.swept ?? 0;
    },
    async claimLane({ executorId, lane, signal }) {
      if (options.enabledLanes && !options.enabledLanes.has(lane)) return null;
      const rows = warmOnly
        ? await abortable(sql<ClaimRow[]>`
          select org_id as "orgId", companion_id as "companionId", turn_id as "turnId",
            command_id as "commandId", lane::text, state::text,
            claim_token as "claimToken", claim_epoch::text as "claimEpoch",
            gate_epoch::text as "gateEpoch", admission_started_at as "admissionStartedAt",
            inactivity_deadline_at as "inactivityDeadlineAt",
            absolute_deadline_at as "absoluteDeadlineAt"
          from public.companion_v3_runtime_claim_warm_v5(${executorId}, ${lane}, 30, 5)
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
      return row
        ? {
          turn: turnFromRow(row),
          fence: {
            token: row.claimToken,
            epoch: BigInt(row.claimEpoch),
            gateEpoch: BigInt(row.gateEpoch),
          },
          orgId: row.orgId,
          companionId: row.companionId,
        }
        : null;
    },
    async completeProgression(claim, outcome, signal) {
      const terminal = terminalInput(outcome);
      const rows = await abortable(sql<Array<{ completed: boolean }>>`
        select public.companion_v3_runtime_complete_v5(
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
          5
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
      return rows[0]?.checkpointed === true;
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
): RuntimeV3WarmTurnPersistence {
  return {
    async authorize(claim, signal) {
      const rows = await abortable(sql<WarmMaterialRow[]>`
        select box_id as "boxId", pi_invocation_id as "piInvocationId",
          content, activity_cursor::text as "activityCursor",
          recovery_deferred as "recoveryDeferred"
        from public.companion_v3_runtime_authorize_warm_turn_v5(
          ${claim.orgId}::uuid,
          ${claim.companionId}::uuid,
          ${claim.turn.lane},
          ${claim.turn.id}::uuid,
          ${claim.fence.token}::uuid,
          ${claim.fence.epoch.toString()}::bigint,
          ${claim.fence.gateEpoch.toString()}::bigint,
          5
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
      const rows = await abortable(sql<Array<{ projected: string | null }>>`
        select public.companion_v3_runtime_project_native_page_v5(
          ${claim.orgId}::uuid,
          ${claim.companionId}::uuid,
          ${claim.turn.lane},
          ${claim.turn.id}::uuid,
          ${claim.fence.token}::uuid,
          ${claim.fence.epoch.toString()}::bigint,
          ${claim.fence.gateEpoch.toString()}::bigint,
          ${projection.throughCursor.toString()}::bigint,
          ${sql.json(projection.assistant)}::jsonb,
          ${sql.json((projection.compactions ?? []).map((item) => ({
            ...item,
            cursor: item.cursor.toString(),
          })))}::jsonb,
          ${projection.needsInput},
          ${projection.activity},
          ${projection.processExited ? "process_exit" : projection.settled ? "settled" : null},
          5
        ) as projected
      `, signal);
      const projected = rows[0]?.projected;
      return projected === "succeeded" || projected === "failed" ? projected : projected === "projected";
    },
  };
}
