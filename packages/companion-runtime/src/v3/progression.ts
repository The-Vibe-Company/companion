import { safeRuntimeError } from "../errors";
import { classifyPiJournalPage, type ValidatedPiJournalRead } from "../piEvents";
import type { ErrorAction, SafeRuntimeError } from "../types";

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
  claimLane(input: { executorId: string; lane: RuntimeV3Lane }): Promise<RuntimeV3Claim | null>;
  completeProgression(
    claim: RuntimeV3Claim,
    outcome: RuntimeV3DurableOutcome,
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
  converge(input: { executorId: string }): Promise<{
    progressed: number;
    exhausted: boolean;
  }>;
}

export type RuntimeV3Convergence = Pick<RuntimeV3Progression, "converge">;

export interface RuntimeV3ProgressionOptions {
  persistence: RuntimeV3ProgressionPersistence;
  advance: (claim: RuntimeV3Claim) => Promise<RuntimeV3ProgressionOutcome>;
}

export interface RuntimeV3ConvergenceOptions {
  persistence: RuntimeV3ConvergencePersistence;
  advance: (claim: RuntimeV3Claim) => Promise<RuntimeV3ProgressionOutcome>;
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
  authorize(claim: RuntimeV3Claim): Promise<RuntimeV3WarmTurnMaterial | null>;
  recordAdmission(
    claim: RuntimeV3Claim,
    input: { invocationId: string; cursor: bigint },
  ): Promise<boolean>;
  project(claim: RuntimeV3Claim, projection: RuntimeV3WarmTurnProjection): Promise<boolean>;
}

export interface RuntimeV3WarmPi {
  prompt(input: {
    boxId: string;
    commandId: string;
    turnId: string;
    expectedInvocationId: string;
    message: string;
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
  }): Promise<ValidatedPiJournalRead>;
  acknowledge(input: { boxId: string; through: bigint }): Promise<bigint>;
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
  return async (claim) => {
    try {
      const material = await options.persistence.authorize(claim);
      if (!material) {
        return {
          kind: "failed",
          code: "warm_turn_unauthorized",
          message: "The warm Turn is no longer authorized to run.",
          action: "none",
        };
      }
      const admission = await options.pi.prompt({
        boxId: material.boxId,
        commandId: claim.turn.commandId,
        turnId: claim.turn.id,
        expectedInvocationId: material.piInvocationId,
        message: material.content,
      });
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
      const admitted = await options.persistence.recordAdmission(claim, {
        invocationId: admission.invocationId,
        cursor: admission.initialCursor,
      });
      if (!admitted) {
        return {
          kind: "interrupted",
          code: "pi_admission_fence_lost",
          message: "Pi admission could not be recorded safely.",
          action: "none",
        };
      }

      let cursor = admission.initialCursor;
      let assistantResults = 0;
      for (let pageNumber = 0; pageNumber < 32; pageNumber += 1) {
        const page = await options.pi.read({
          boxId: material.boxId,
          after: cursor,
          turnId: claim.turn.id,
          invocationId: admission.invocationId,
        });
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
        const projected = await options.persistence.project(claim, {
          throughCursor: classified.throughCursor,
          assistant,
          needsInput: classified.needsInput,
          settled: classified.settled,
        });
        if (!projected) return { kind: "release" };
        await options.pi.acknowledge({
          boxId: material.boxId,
          through: classified.throughCursor,
        });
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
    converge: async ({ executorId }) => {
      const lanes = await Promise.all(RUNTIME_V3_LANES.map(async (lane) => {
        let progressed = 0;
        while (progressed < LANE_CONVERGENCE_LIMIT) {
          const claim = await options.persistence.claimLane({ executorId, lane });
          if (!claim) return { progressed, exhausted: false };
          const outcome = durableOutcome(await options.advance(claim));
          const completed = await options.persistence.completeProgression(claim, outcome);
          if (!completed) return { progressed, exhausted: false };
          progressed += 1;
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
