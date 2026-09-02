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
  | { kind: "failed"; code: string; message: string }
  | { kind: "interrupted"; code: string; message: string };

/**
 * Internal persistence seam for the progression implementation. HTTP, workers, and lifecycle
 * callers receive RuntimeV3Progression instead, so none of them coordinate claims or fences.
 */
export interface RuntimeV3ProgressionPersistence {
  admitTurn(input: RuntimeV3Admission): Promise<RuntimeV3Turn>;
  recordDesiredLifecycle(
    input: RuntimeV3DesiredLifecycleChange,
  ): Promise<RuntimeV3LifecycleRevision>;
  claimAvailable(input: { executorId: string }): Promise<RuntimeV3Claim[]>;
  completeProgression(
    claim: RuntimeV3Claim,
    outcome: RuntimeV3ProgressionOutcome,
  ): Promise<boolean>;
}

export interface RuntimeV3Progression {
  admit(input: RuntimeV3Admission): Promise<RuntimeV3Turn>;
  desire(input: RuntimeV3DesiredLifecycleChange): Promise<RuntimeV3LifecycleRevision>;
  converge(input: { executorId: string }): Promise<{
    progressed: number;
    exhausted: boolean;
  }>;
}

export interface RuntimeV3ProgressionOptions {
  persistence: RuntimeV3ProgressionPersistence;
  advance: (claim: RuntimeV3Claim) => Promise<RuntimeV3ProgressionOutcome>;
}

const CONVERGENCE_LIMIT = 32;

/**
 * The dormant v3 deep module. It is intentionally absent from every production composition root;
 * later tracer bullets can move behavior behind this interface without teaching callers lease
 * choreography. Its internal composition requires an explicit advance adapter so claimed work
 * can never be silently released by a partial composition.
 */
export function createRuntimeV3Progression(
  options: RuntimeV3ProgressionOptions,
): RuntimeV3Progression {
  return {
    admit: async (input) => await options.persistence.admitTurn(input),
    desire: async (input) => await options.persistence.recordDesiredLifecycle(input),
    converge: async ({ executorId }) => {
      let progressed = 0;
      while (progressed < CONVERGENCE_LIMIT) {
        const claims = await options.persistence.claimAvailable({ executorId });
        if (claims.length === 0) return { progressed, exhausted: false };
        const completions = await Promise.all(claims.map(async (claim) => {
          const outcome = await options.advance(claim);
          return await options.persistence.completeProgression(claim, outcome);
        }));
        const completed = completions.filter(Boolean).length;
        progressed += completed;
        if (completed === 0) return { progressed, exhausted: false };
      }
      return { progressed, exhausted: true };
    },
  };
}
