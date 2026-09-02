import type {
  RuntimeV3ConvergencePersistence,
  RuntimeV3DurableOutcome,
  RuntimeV3PreparationPersistence,
  RuntimeV3ProviderMaterial,
  RuntimeV3Turn,
  RuntimeV3WarmTurnPersistence,
} from "@companion/companion-runtime/v3/internal";
import type { Sql } from "postgres";

interface CancellableQuery<T> extends PromiseLike<T> {
  cancel(): void;
}

const PREPARATION_LEASE_SECONDS = 90;

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
}

interface TerminalCompletion {
  outcome: "release" | "succeeded" | "failed" | "interrupted";
  code: string | null;
  message: string | null;
  action: string | null;
}

function turnFromRow(row: {
  turnId: string;
  commandId: string;
  lane: "main" | "background";
  state: RuntimeV3Turn["state"];
}): RuntimeV3Turn {
  return {
    id: row.turnId,
    commandId: row.commandId,
    lane: row.lane,
    state: row.state,
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
    async claimLane({ executorId, lane, signal }) {
      if (options.enabledLanes && !options.enabledLanes.has(lane)) return null;
      const rows = warmOnly
        ? await abortable(sql<ClaimRow[]>`
          select org_id as "orgId", companion_id as "companionId", turn_id as "turnId",
            command_id as "commandId", lane::text, state::text,
            claim_token as "claimToken", claim_epoch::text as "claimEpoch",
            gate_epoch::text as "gateEpoch"
          from public.companion_v3_runtime_claim_warm(${executorId}, ${lane}, 30, 3)
        `, signal)
        : await abortable(sql<ClaimRow[]>`
          select org_id as "orgId", companion_id as "companionId", turn_id as "turnId",
            command_id as "commandId", lane::text, state::text,
            claim_token as "claimToken", claim_epoch::text as "claimEpoch",
            gate_epoch::text as "gateEpoch"
          from public.companion_v3_runtime_claim(${executorId}, ${lane}, 30, 3)
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
        select public.companion_v3_runtime_complete(
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
          3
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
}

interface PreparationClaimRow {
  orgId: string;
  companionId: string;
  turnId: string | null;
  commandId: string | null;
  checkpoint: "pending" | "box_created" | "box_ready" | "staged";
  boxIdempotencyKey: string;
  boxId: string | null;
  modelId: string;
  persona: string | null;
  providerMaterial: RuntimeV3ProviderMaterial[];
  claimToken: string;
  claimEpoch: string;
  gateEpoch: string;
  createdAt: Date;
}

/** Runtime-only preparation facts. Box identity crosses this seam only after a fenced checkpoint. */
export function createRuntimeV3PostgresPreparationPersistence(
  sql: Sql,
): RuntimeV3PreparationPersistence {
  return {
    async claim({ executorId }) {
      const rows = await sql<PreparationClaimRow[]>`
        select org_id as "orgId", companion_id as "companionId", turn_id as "turnId",
          command_id as "commandId", checkpoint, box_idempotency_key as "boxIdempotencyKey",
          box_id as "boxId", claim_token as "claimToken", claim_epoch::text as "claimEpoch",
          gate_epoch::text as "gateEpoch", model_id as "modelId", persona,
          provider_material as "providerMaterial", created_at as "createdAt"
        from public.companion_v3_runtime_claim_preparation(
          ${executorId}, ${PREPARATION_LEASE_SECONDS}, 3
        )
      `;
      const row = rows[0];
      return row ? {
        orgId: row.orgId,
        companionId: row.companionId,
        turnId: row.turnId,
        commandId: row.commandId,
        checkpoint: row.checkpoint,
        boxIdempotencyKey: row.boxIdempotencyKey,
        boxId: row.boxId,
        modelId: row.modelId,
        persona: row.persona,
        providerMaterial: row.providerMaterial,
        createdAt: row.createdAt,
        fence: {
          token: row.claimToken,
          epoch: BigInt(row.claimEpoch),
          gateEpoch: BigInt(row.gateEpoch),
        },
      } : null;
    },
    async checkpoint(claim, input) {
      const rows = await sql<Array<{ checkpointed: boolean }>>`
        select public.companion_v3_runtime_checkpoint_preparation(
          ${claim.orgId}::uuid, ${claim.companionId}::uuid,
          ${claim.fence.token}::uuid, ${claim.fence.epoch.toString()}::bigint,
          ${claim.fence.gateEpoch.toString()}::bigint, ${claim.checkpoint}, ${input.next},
          ${input.boxId ?? null}, ${input.piInvocationId ?? null}, 3
        ) as checkpointed
      `;
      return rows[0]?.checkpointed === true;
    },
    async defer(claim, input) {
      const rows = await sql<Array<{ deferred: boolean }>>`
        select public.companion_v3_runtime_defer_preparation(
          ${claim.orgId}::uuid, ${claim.companionId}::uuid,
          ${claim.fence.token}::uuid, ${claim.fence.epoch.toString()}::bigint,
          ${claim.fence.gateEpoch.toString()}::bigint, ${input.delaySeconds},
          ${input.error?.code ?? null}, ${input.error?.message ?? null}, 3
        ) as deferred
      `;
      return rows[0]?.deferred === true;
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
          content, activity_cursor::text as "activityCursor"
        from public.companion_v3_runtime_authorize_warm_turn(
          ${claim.orgId}::uuid,
          ${claim.companionId}::uuid,
          ${claim.turn.lane},
          ${claim.turn.id}::uuid,
          ${claim.fence.token}::uuid,
          ${claim.fence.epoch.toString()}::bigint,
          ${claim.fence.gateEpoch.toString()}::bigint,
          3
        )
      `, signal);
      const row = rows[0];
      return row
        ? {
          boxId: row.boxId,
          piInvocationId: row.piInvocationId,
          content: row.content,
          cursor: BigInt(row.activityCursor),
        }
        : null;
    },
    async recordAdmission(claim, input, signal) {
      const rows = await abortable(sql<Array<{ recorded: boolean }>>`
        select public.companion_v3_runtime_record_admission(
          ${claim.orgId}::uuid,
          ${claim.companionId}::uuid,
          ${claim.turn.lane},
          ${claim.turn.id}::uuid,
          ${claim.fence.token}::uuid,
          ${claim.fence.epoch.toString()}::bigint,
          ${claim.fence.gateEpoch.toString()}::bigint,
          ${input.invocationId},
          ${input.cursor.toString()}::bigint,
          3
        ) as recorded
      `, signal);
      return rows[0]?.recorded === true;
    },
    async project(claim, projection, signal) {
      const rows = await abortable(sql<Array<{ projected: boolean }>>`
        select public.companion_v3_runtime_project_page(
          ${claim.orgId}::uuid,
          ${claim.companionId}::uuid,
          ${claim.turn.lane},
          ${claim.turn.id}::uuid,
          ${claim.fence.token}::uuid,
          ${claim.fence.epoch.toString()}::bigint,
          ${claim.fence.gateEpoch.toString()}::bigint,
          ${projection.throughCursor.toString()}::bigint,
          ${sql.json(projection.assistant)}::jsonb,
          ${projection.needsInput},
          ${projection.settled},
          3
        ) as projected
      `, signal);
      return rows[0]?.projected === true;
    },
  };
}
