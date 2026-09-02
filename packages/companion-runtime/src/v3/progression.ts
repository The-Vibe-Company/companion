import { safeRuntimeError } from "../errors";
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
 * The dormant v3 deep module. It is intentionally absent from every production composition root;
 * later tracer bullets can move behavior behind this interface without teaching callers lease
 * choreography. Its internal composition requires an explicit advance adapter so claimed work
 * can never be silently released by a partial composition.
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
