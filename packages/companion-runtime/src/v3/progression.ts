import { safeRuntimeError } from "../errors";
import { classifyPiJournalPage, type ValidatedPiJournalRead } from "../piEvents";
import type { ErrorAction, SafeRuntimeError } from "../types";
import type { RuntimeBoxControl, RuntimePiControl } from "../ports";

export const RUNTIME_V3_LANES = ["main", "background"] as const;
export type RuntimeV3Lane = (typeof RUNTIME_V3_LANES)[number];

export const RUNTIME_V3_LIFECYCLE_INTENTS = [
  "prepare",
  "archive",
  "recycle_pi",
  "delete",
] as const;
export type RuntimeV3LifecycleIntent = (typeof RUNTIME_V3_LIFECYCLE_INTENTS)[number];

export type RuntimeV3TurnState =
  | "queued"
  | "admitted"
  | "running"
  | "needs_input"
  | "succeeded"
  | "failed"
  | "interrupted"
  | "cancelled";

export interface RuntimeV3Turn {
  id: string;
  commandId: string;
  lane: RuntimeV3Lane;
  state: RuntimeV3TurnState;
}

export interface RuntimeV3Admission {
  orgId: string;
  companionId: string;
  actorId: string;
  clientMessageId: string;
  messageEventId: string;
  lane: RuntimeV3Lane;
}

export interface RuntimeV3DesiredLifecycleChange {
  orgId: string;
  companionId: string;
  actorId: string;
  intent: RuntimeV3LifecycleIntent;
}

export interface RuntimeV3LifecycleRevision {
  intent: RuntimeV3LifecycleIntent;
  revision: bigint;
}

export interface RuntimeV3Fence {
  token: string;
  epoch: bigint;
  gateEpoch: bigint;
}

export interface RuntimeV3Claim {
  orgId: string;
  companionId: string;
  turn: RuntimeV3Turn;
  fence: RuntimeV3Fence;
}

export type RuntimeV3ProgressionOutcome =
  | { kind: "release" }
  | { kind: "succeeded" }
  | { kind: "failed"; code: string; message: unknown; action: RuntimeV3ErrorAction }
  | { kind: "interrupted"; code: string; message: unknown; action: RuntimeV3ErrorAction };

export type RuntimeV3ErrorAction = Exclude<ErrorAction, "restart_box">;

export type RuntimeV3DurableOutcome =
  | { kind: "release" }
  | { kind: "succeeded" }
  | { kind: "failed"; error: SafeRuntimeError }
  | { kind: "interrupted"; error: SafeRuntimeError };

export interface RuntimeV3AdmissionPersistence {
  admitTurn(input: RuntimeV3Admission): Promise<RuntimeV3Turn>;
}

export interface RuntimeV3LifecyclePersistence {
  recordDesiredLifecycle(
    input: RuntimeV3DesiredLifecycleChange,
  ): Promise<RuntimeV3LifecycleRevision>;
}

export interface RuntimeV3ConvergencePersistence {
  claimLane(input: {
    executorId: string;
    lane: RuntimeV3Lane;
    signal?: AbortSignal;
  }): Promise<RuntimeV3Claim | null>;
  completeProgression(
    claim: RuntimeV3Claim,
    outcome: RuntimeV3DurableOutcome,
    signal?: AbortSignal,
  ): Promise<boolean>;
}

/**
 * Internal persistence seam for the progression implementation. HTTP, workers, and lifecycle
 * callers receive RuntimeV3Progression instead, so none of them coordinate claims or fences.
 */
export interface RuntimeV3ProgressionPersistence {
  admission: RuntimeV3AdmissionPersistence;
  lifecycle: RuntimeV3LifecyclePersistence;
  convergence: RuntimeV3ConvergencePersistence;
}

export interface RuntimeV3Progression {
  admit(input: RuntimeV3Admission): Promise<RuntimeV3Turn>;
  desire(input: RuntimeV3DesiredLifecycleChange): Promise<RuntimeV3LifecycleRevision>;
  converge(input: { executorId: string; signal?: AbortSignal }): Promise<{
    progressed: number;
    exhausted: boolean;
  }>;
}

export type RuntimeV3Convergence = Pick<RuntimeV3Progression, "converge">;

export type RuntimeV3PreparationCheckpoint =
  | "pending" | "box_created" | "box_ready" | "staged";

export type RuntimeV3ProviderMaterial = {
  provider_id: string;
  auth_method: string;
  credential_generation: string;
  credential_version: number;
  ciphertext: string;
  iv: string;
  auth_tag: string;
  wrapped_dek: string;
  wrap_iv: string;
  wrap_auth_tag: string;
  key_id: string;
};

export interface RuntimeV3PreparationClaim {
  orgId: string;
  companionId: string;
  turnId: string | null;
  commandId: string | null;
  checkpoint: RuntimeV3PreparationCheckpoint;
  boxIdempotencyKey: string;
  boxId: string | null;
  modelId: string;
  persona: string | null;
  providerMaterial: RuntimeV3ProviderMaterial[];
  createdAt: Date;
  fence: RuntimeV3Fence;
}

export interface RuntimeV3PreparationPersistence {
  claim(input: { executorId: string }): Promise<RuntimeV3PreparationClaim | null>;
  checkpoint(
    claim: RuntimeV3PreparationClaim,
    input: {
      next: "box_created" | "box_ready" | "staged" | "prepared";
      boxId?: string;
      piInvocationId?: string;
    },
  ): Promise<boolean>;
  defer(
    claim: RuntimeV3PreparationClaim,
    input: { delaySeconds: number; error: SafeRuntimeError | null },
  ): Promise<boolean>;
}

export interface RuntimeV3PreparationOptions {
  persistence: RuntimeV3PreparationPersistence;
  box: Pick<RuntimeBoxControl, "createGenerationBox" | "applyGenerationBoxSettings" | "getStatus">;
  resourceStager: {
    stagePreparation(input: {
      orgId: string;
      companionId: string;
      boxId: string;
      modelId: string;
      persona: string | null;
      providerMaterial: RuntimeV3ProviderMaterial[];
      signal: AbortSignal;
    }): Promise<void>;
  };
  pi: Pick<RuntimePiControl, "startPiDaemon">;
  observePreparedLatency?: (durationMs: number) => void;
  now?: () => Date;
}

export interface RuntimeV3ProgressionOptions {
  persistence: RuntimeV3ProgressionPersistence;
  advance: (
    claim: RuntimeV3Claim,
    signal?: AbortSignal,
  ) => Promise<RuntimeV3ProgressionOutcome>;
}

export interface RuntimeV3ConvergenceOptions {
  persistence: RuntimeV3ConvergencePersistence;
  advance: (
    claim: RuntimeV3Claim,
    signal?: AbortSignal,
  ) => Promise<RuntimeV3ProgressionOutcome>;
}

export interface RuntimeV3WarmTurnMaterial {
  boxId: string;
  piInvocationId: string;
  content: string;
  cursor: bigint;
}

export interface RuntimeV3WarmTurnProjection {
  throughCursor: bigint;
  assistant: Array<{ eventId: string; content: string }>;
  needsInput: boolean;
  settled: boolean;
}

export interface RuntimeV3WarmTurnPersistence {
  authorize(
    claim: RuntimeV3Claim,
    signal?: AbortSignal,
  ): Promise<RuntimeV3WarmTurnMaterial | null>;
  recordAdmission(
    claim: RuntimeV3Claim,
    input: { invocationId: string; cursor: bigint },
    signal?: AbortSignal,
  ): Promise<boolean>;
  project(
    claim: RuntimeV3Claim,
    projection: RuntimeV3WarmTurnProjection,
    signal?: AbortSignal,
  ): Promise<boolean>;
}

export interface RuntimeV3WarmPi {
  prompt(input: {
    boxId: string;
    commandId: string;
    turnId: string;
    expectedInvocationId: string;
    message: string;
    signal?: AbortSignal;
  }): Promise<
    | { outcome: "accepted"; invocationId: string; initialCursor: bigint }
    | { outcome: "rejected"; code: string }
    | { outcome: "ambiguous"; code: string }
  >;
  read(input: {
    boxId: string;
    after: bigint;
    turnId: string;
    invocationId: string;
    signal?: AbortSignal;
  }): Promise<ValidatedPiJournalRead>;
  acknowledge(input: {
    boxId: string;
    through: bigint;
    signal?: AbortSignal;
  }): Promise<bigint>;
}

export interface RuntimeV3WarmTurnAdvanceOptions {
  persistence: RuntimeV3WarmTurnPersistence;
  pi: RuntimeV3WarmPi;
  wait?: () => Promise<void>;
}

const LANE_CONVERGENCE_LIMIT = 16;

function durableOutcome(outcome: RuntimeV3ProgressionOutcome): RuntimeV3DurableOutcome {
  if (outcome.kind !== "failed" && outcome.kind !== "interrupted") return outcome;
  return {
    kind: outcome.kind,
    error: safeRuntimeError({
      code: outcome.code,
      message: outcome.message,
      action: outcome.action,
    }),
  };
}

/**
 * Warm text tracer bullet kept behind the progression seam. The runtime composition supplies only
 * a PostgreSQL adapter and the Pi boundary; callers never coordinate admission, projection, ACK,
 * or lane release themselves.
 */
export function createRuntimeV3WarmTurnAdvance(
  options: RuntimeV3WarmTurnAdvanceOptions,
): RuntimeV3ConvergenceOptions["advance"] {
  return async (claim, signal) => {
    try {
      signal?.throwIfAborted();
      const material = signal
        ? await options.persistence.authorize(claim, signal)
        : await options.persistence.authorize(claim);
      signal?.throwIfAborted();
      if (!material) {
        return {
          kind: "failed",
          code: "warm_turn_unauthorized",
          message: "The warm Turn is no longer authorized to run.",
          action: "none",
        };
      }
      let invocationId = material.piInvocationId;
      let cursor = material.cursor;
      if (claim.turn.state === "queued") {
        const admission = await options.pi.prompt({
          boxId: material.boxId,
          commandId: claim.turn.commandId,
          turnId: claim.turn.id,
          expectedInvocationId: material.piInvocationId,
          message: material.content,
          signal,
        });
        signal?.throwIfAborted();
        if (admission.outcome === "rejected") {
          return {
            kind: "failed",
            code: "pi_admission_rejected",
            message: "Pi rejected the warm Turn.",
            action: "none",
          };
        }
        if (admission.outcome === "ambiguous") {
          return {
            kind: "interrupted",
            code: "pi_admission_ambiguous",
            message: "Pi admission could not be confirmed.",
            action: "none",
          };
        }
        const admissionRecord = {
          invocationId: admission.invocationId,
          cursor: admission.initialCursor,
        };
        const admitted = signal
          ? await options.persistence.recordAdmission(claim, admissionRecord, signal)
          : await options.persistence.recordAdmission(claim, admissionRecord);
        signal?.throwIfAborted();
        if (!admitted) {
          return {
            kind: "interrupted",
            code: "pi_admission_fence_lost",
            message: "Pi admission could not be recorded safely.",
            action: "none",
          };
        }
        invocationId = admission.invocationId;
        cursor = admission.initialCursor;
      } else if (claim.turn.state !== "needs_input") {
        return {
          kind: "interrupted",
          code: "warm_turn_state_invalid",
          message: "The warm Turn cannot resume from its durable state.",
          action: "none",
        };
      }

      let assistantResults = 0;
      for (let pageNumber = 0; pageNumber < 32; pageNumber += 1) {
        const page = await options.pi.read({
          boxId: material.boxId,
          after: cursor,
          turnId: claim.turn.id,
          invocationId,
          signal,
        });
        signal?.throwIfAborted();
        if (claim.turn.state === "needs_input" && page.events.length === 0 && !page.hasMore) {
          return { kind: "release" };
        }
        const classified = classifyPiJournalPage(page);
        const assistant = classified.projections.flatMap((projection) =>
          projection.type === "assistant"
            ? [{
              eventId: `v3:${claim.turn.id}:${projection.sequence.toString()}`,
              content: projection.content,
            }]
            : []);
        assistantResults += assistant.length;
        if (assistantResults > 1) {
          return {
            kind: "failed",
            code: "pi_result_count_invalid",
            message: "Pi produced more than one assistant result for the Turn.",
            action: "none",
          };
        }
        const projection = {
          throughCursor: classified.throughCursor,
          assistant,
          needsInput: classified.needsInput,
          settled: classified.settled,
        };
        const projected = signal
          ? await options.persistence.project(claim, projection, signal)
          : await options.persistence.project(claim, projection);
        signal?.throwIfAborted();
        if (!projected) {
          return {
            kind: "interrupted",
            code: "pi_projection_fence_lost",
            message: "Pi output could not be projected safely.",
            action: "none",
          };
        }
        await options.pi.acknowledge({
          boxId: material.boxId,
          through: classified.throughCursor,
          signal,
        });
        signal?.throwIfAborted();
        cursor = classified.throughCursor;
        if (classified.processExit) {
          return {
            kind: "failed",
            code: "pi_process_exited",
            message: "Pi stopped before the Turn completed.",
            action: "none",
          };
        }
        if (classified.needsInput) return { kind: "release" };
        if (classified.settled) {
          return assistantResults === 1
            ? { kind: "succeeded" }
            : {
              kind: "failed",
              code: "pi_result_missing",
              message: "Pi settled without an assistant result.",
              action: "none",
            };
        }
        if (!page.hasMore && page.events.length === 0) {
          await (options.wait ?? defaultWarmPollWait)();
          signal?.throwIfAborted();
        }
      }
      return {
        kind: "failed",
        code: "pi_settlement_missing",
        message: "Pi did not produce a terminal result.",
        action: "none",
      };
    } catch {
      return {
        kind: "failed",
        code: "warm_turn_failed",
        message: "The warm Turn could not be completed.",
        action: "none",
      };
    }
  };
}

async function defaultWarmPollWait(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 100));
}

const PREPARATION_RETRY_SECONDS = 5;
const PREPARATION_POLL_SECONDS = 1;
const PREPARATION_BOX_TTL_SECONDS = 6 * 60 * 60;

/** Prepare one cold Companion through fenced, restart-safe checkpoints. */
export function createRuntimeV3Preparation(
  options: RuntimeV3PreparationOptions,
): RuntimeV3Convergence {
  const now = options.now ?? (() => new Date());
  return {
    async converge({ executorId }) {
      let progressed = 0;
      while (progressed < LANE_CONVERGENCE_LIMIT) {
        const claim = await options.persistence.claim({ executorId });
        if (!claim) return { progressed, exhausted: false };
        const signal = AbortSignal.timeout(60_000);
        try {
          if (claim.checkpoint === "pending") {
            const created = await options.box.createGenerationBox({
              companionId: claim.companionId,
              generation: 1n,
              ttlSeconds: PREPARATION_BOX_TTL_SECONDS,
              idempotencyKey: claim.boxIdempotencyKey,
              // Preparation owns no user-facing operation deadline. Use a ready image if already
              // published, but never spend this fenced claim waiting for the image builder.
              imageWaitDeadlineAt: now(),
              signal,
            });
            if (!await options.persistence.checkpoint(claim, {
              next: "box_created",
              boxId: created.boxId,
            })) return { progressed, exhausted: false };
          } else if (claim.checkpoint === "box_created") {
            if (!claim.boxId) throw new Error("Box identity is missing after creation");
            await options.box.applyGenerationBoxSettings({
              boxId: claim.boxId,
              companionId: claim.companionId,
              generation: 1n,
              ttlSeconds: PREPARATION_BOX_TTL_SECONDS,
              signal,
            });
            const observed = await options.box.getStatus({
              boxId: claim.boxId,
              companionId: claim.companionId,
              generation: 1n,
              signal,
            });
            if (!["ready", "idle", "running"].includes(observed.state)) {
              await options.persistence.defer(claim, {
                delaySeconds: PREPARATION_POLL_SECONDS,
                error: null,
              });
              return { progressed: progressed + 1, exhausted: false };
            }
            if (!await options.persistence.checkpoint(claim, { next: "box_ready" })) {
              return { progressed, exhausted: false };
            }
          } else if (claim.checkpoint === "box_ready") {
            if (!claim.boxId) throw new Error("Box identity is missing before staging");
            await options.resourceStager.stagePreparation({
              orgId: claim.orgId,
              companionId: claim.companionId,
              boxId: claim.boxId,
              modelId: claim.modelId,
              persona: claim.persona,
              providerMaterial: claim.providerMaterial,
              signal,
            });
            if (!await options.persistence.checkpoint(claim, { next: "staged" })) {
              return { progressed, exhausted: false };
            }
          } else {
            if (!claim.boxId) throw new Error("Box identity is missing before Pi activation");
            const pi = await options.pi.startPiDaemon({ boxId: claim.boxId, signal });
            if (pi.state !== "idle") throw new Error("Pi did not become idle during preparation");
            if (!await options.persistence.checkpoint(claim, {
              next: "prepared",
              piInvocationId: pi.invocationId,
            })) return { progressed, exhausted: false };
            options.observePreparedLatency?.(Math.max(0, now().getTime() - claim.createdAt.getTime()));
          }
          progressed += 1;
        } catch (error) {
          const safe = safeRuntimeError({
            code: "companion_prepare_failed",
            message: error,
            action: "retry",
          });
          await options.persistence.defer(claim, {
            delaySeconds: PREPARATION_RETRY_SECONDS,
            error: safe,
          });
          return { progressed: progressed + 1, exhausted: false };
        }
      }
      return { progressed, exhausted: true };
    },
  };
}

/** Run preparation before dispatch so a queued head Turn itself implies preparation. */
export function combineRuntimeV3Convergence(
  preparation: RuntimeV3Convergence,
  turns: RuntimeV3Convergence,
): RuntimeV3Convergence {
  return {
    async converge(input) {
      const prepared = await preparation.converge(input);
      const dispatched = await turns.converge(input);
      return {
        progressed: prepared.progressed + dispatched.progressed,
        exhausted: prepared.exhausted || dispatched.exhausted,
      };
    },
  };
}

/**
 * Runtime v3 deep module. Production composes the warm text tracer bullet through this interface;
 * callers never learn its lease, Pi admission, projection, or settlement choreography.
 */
export function createRuntimeV3Progression(
  options: RuntimeV3ProgressionOptions,
): RuntimeV3Progression {
  const convergence = createRuntimeV3Convergence({
    persistence: options.persistence.convergence,
    advance: options.advance,
  });
  return {
    admit: async (input) => await options.persistence.admission.admitTurn(input),
    desire: async (input) => await options.persistence.lifecycle.recordDesiredLifecycle(input),
    converge: convergence.converge,
  };
}

/** Runtime-process view: lane choice and parallel scheduling stay inside the deep module. */
export function createRuntimeV3Convergence(
  options: RuntimeV3ConvergenceOptions,
): RuntimeV3Convergence {
  return {
    converge: async ({ executorId, signal }) => {
      const lanes = await Promise.all(RUNTIME_V3_LANES.map(async (lane) => {
        let progressed = 0;
        while (progressed < LANE_CONVERGENCE_LIMIT) {
          if (signal?.aborted) return { progressed, exhausted: false };
          const claim = await options.persistence.claimLane({ executorId, lane, signal });
          if (signal?.aborted) return { progressed, exhausted: false };
          if (!claim) return { progressed, exhausted: false };
          const advanced = signal
            ? await options.advance(claim, signal)
            : await options.advance(claim);
          const outcome = durableOutcome(advanced);
          if (signal?.aborted) return { progressed, exhausted: false };
          const completed = signal
            ? await options.persistence.completeProgression(claim, outcome, signal)
            : await options.persistence.completeProgression(claim, outcome);
          if (!completed) return { progressed, exhausted: false };
          progressed += 1;
          if (outcome.kind === "release") return { progressed, exhausted: false };
        }
        return { progressed, exhausted: true };
      }));
      return {
        progressed: lanes.reduce((count, lane) => count + lane.progressed, 0),
        exhausted: lanes.some((lane) => lane.exhausted),
      };
    },
  };
}
