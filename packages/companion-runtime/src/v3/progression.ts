import { safeRuntimeError } from "../errors";
import { classifyPiJournalPage, type ValidatedPiJournalRead } from "../piEvents";
import { COMPANION_BUDGETS, COMPANION_RUNTIME_V3_BUDGETS } from "@companion/contracts";
import type {
  ErrorAction,
  ProviderRef,
  RuntimeConfigCatalog,
  SafeRuntimeError,
  SkillRef,
  RuntimeV3McpMaterial,
  RuntimeV3McpRef,
  RuntimeV3ProviderMaterial,
  RuntimeV3SkillMaterial,
} from "../types";
export type {
  RuntimeV3McpMaterial,
  RuntimeV3McpRef,
  RuntimeV3ProviderMaterial,
  RuntimeV3SkillMaterial,
} from "../types";
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
  admissionStartedAt?: Date | null;
  inactivityDeadlineAt?: Date | null;
  absoluteDeadlineAt?: Date | null;
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
  requestId: string;
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
  | { kind: "ack_completed" }
  | { kind: "retry_ack" }
  | { kind: "succeeded" }
  | { kind: "failed"; code: string; message: unknown; action: RuntimeV3ErrorAction }
  | { kind: "interrupted"; code: string; message: unknown; action: RuntimeV3ErrorAction };

export type RuntimeV3ErrorAction = Exclude<ErrorAction, "restart_box">;

export type RuntimeV3DurableOutcome =
  | { kind: "release" }
  | { kind: "ack_completed" }
  | { kind: "retry_ack" }
  | { kind: "succeeded" }
  | { kind: "failed"; error: SafeRuntimeError }
  | { kind: "interrupted"; error: SafeRuntimeError };

export interface RuntimeV3AdmissionPersistence {
  admitTurn(input: RuntimeV3Admission): Promise<RuntimeV3Turn>;
}

export interface RuntimeV3LifecycleIntentPersistence {
  recordDesiredLifecycle(
    input: RuntimeV3DesiredLifecycleChange,
  ): Promise<RuntimeV3LifecycleRevision>;
}

export interface RuntimeV3ConvergencePersistence {
  sweepLane(input: {
    lane: RuntimeV3Lane;
    signal?: AbortSignal;
  }): Promise<number>;
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
  lifecycle: RuntimeV3LifecycleIntentPersistence;
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
export type RuntimeV3PiRecycleCheckpoint = "terminate" | "reset" | "ready" | null;

export interface RuntimeV3PreparationClaim {
  executorId: string;
  orgId: string;
  companionId: string;
  turnId: string | null;
  commandId: string | null;
  checkpoint: RuntimeV3PreparationCheckpoint;
  piRecycleCheckpoint?: RuntimeV3PiRecycleCheckpoint;
  recyclePiInvocationId?: string | null;
  recoveryId?: string | null;
  recoveryContext?: string | null;
  boxIdempotencyKey: string;
  boxId: string | null;
  createdAt: Date;
  attemptCount?: number;
  deadlineAt?: Date | null;
  authorized: boolean;
  actorId: string | null;
  modelId: string | null;
  persona: string | null;
  settingsRevision: bigint | null;
  skillsRevision: number | null;
  providerRefs: ProviderRef[];
  skillRefs: SkillRef[];
  mcpRefs: RuntimeV3McpRef[];
  providerMaterial: RuntimeV3ProviderMaterial[];
  skillMaterial: RuntimeV3SkillMaterial[];
  mcpMaterial: RuntimeV3McpMaterial[];
  configCatalog: RuntimeConfigCatalog | null;
  fence: RuntimeV3Fence;
}

export interface RuntimeV3PreparationCredentials {
  hubToken: string;
  mcpBrokerToken: string | null;
  controlToken: string;
  expiresAt: Date;
}

export interface RuntimeV3PreparedMaterial {
  diskLayoutVersion: number;
  appliedSettingsRevision: bigint;
  appliedSkillsRevision: number;
  skillsDigest: string;
  materialExpiresAt: Date;
}

export interface RuntimeV3PreparationPersistence {
  claim(input: { executorId: string }): Promise<RuntimeV3PreparationClaim | null>;
  checkpoint(
    claim: RuntimeV3PreparationClaim,
    input: {
      next: "box_created" | "box_ready" | "staged" | "prepared";
      boxId?: string;
      piInvocationId?: string;
      diskLayoutVersion?: number;
      appliedSettingsRevision?: bigint;
      appliedSkillsRevision?: number;
      skillsDigest?: string;
      materialExpiresAt?: Date;
    },
  ): Promise<boolean>;
  checkpointPiRecycle?(
    claim: RuntimeV3PreparationClaim,
    next: "reset" | "complete",
  ): Promise<boolean>;
  defer(
    claim: RuntimeV3PreparationClaim,
    input: { delaySeconds: number; error: SafeRuntimeError | null },
  ): Promise<boolean>;
  reauthorize(claim: RuntimeV3PreparationClaim): Promise<boolean>;
  mintCredentials(
    claim: RuntimeV3PreparationClaim,
  ): Promise<RuntimeV3PreparationCredentials | null>;
}

export interface RuntimeV3PreparationStager {
  stagePreparation(input: {
    claim: RuntimeV3PreparationClaim;
    authorize: () => Promise<RuntimeV3PreparationCredentials | null>;
    signal: AbortSignal;
  }): Promise<RuntimeV3PreparedMaterial>;
}

export interface RuntimeV3PreparationOptions {
  persistence: RuntimeV3PreparationPersistence;
  box: Pick<RuntimeBoxControl, "createGenerationBox" | "applyGenerationBoxSettings" | "getStatus">;
  preparationStager: RuntimeV3PreparationStager;
  pi: Pick<RuntimePiControl, "startPiDaemon">
    & Partial<Pick<RuntimePiControl, "terminatePiInvocation" | "resetPiSession">>;
  observePreparedLatency?: (durationMs: number) => void;
  now?: () => Date;
  jitter?: () => number;
}

export type RuntimeV3LifecycleCheckpoint =
  | "archive_pending"
  | "archive_requested"
  | "waiting_archived"
  | "wake_pending"
  | "wake_requested"
  | "waiting_ready"
  | "delete_pending"
  | "delete_requested"
  | "delete_dispatched"
  | "waiting_deleted";

export interface RuntimeV3LifecycleClaim {
  executorId: string;
  orgId: string;
  companionId: string;
  boxId: string | null;
  checkpoint: RuntimeV3LifecycleCheckpoint;
  providerOperationId: string | null;
  fence: RuntimeV3Fence;
}

export interface RuntimeV3LifecyclePersistence {
  claim(input: {
    executorId: string;
    signal?: AbortSignal;
  }): Promise<RuntimeV3LifecycleClaim | null>;
  checkpoint(
    claim: RuntimeV3LifecycleClaim,
    input: {
      next:
        | "archive_requested"
        | "waiting_archived"
        | "archived"
        | "wake_requested"
        | "waiting_ready"
        | "active"
        | "delete_requested"
        | "delete_dispatched"
        | "waiting_deleted";
      providerOperationId?: string;
    },
    signal?: AbortSignal,
  ): Promise<boolean>;
  defer(
    claim: RuntimeV3LifecycleClaim,
    input: { delaySeconds: number; error: SafeRuntimeError | null },
    signal?: AbortSignal,
  ): Promise<boolean>;
  finalizeDeletion(claim: RuntimeV3LifecycleClaim, signal?: AbortSignal): Promise<boolean>;
}

export interface RuntimeV3LifecycleOptions {
  persistence: RuntimeV3LifecyclePersistence;
  box: Pick<RuntimeBoxControl,
    | "getStatus"
    | "stopExistingBox"
    | "resumeExistingBox"
    | "requestPermanentDeletion"
    | "pollPermanentDeletion">;
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
  compactions?: Array<{
    cursor: bigint;
    summary: string;
    firstKeptEntryId: string;
    tokensBefore: number;
    estimatedTokensAfter: number;
    cacheRead: number | null;
    cacheWrite: number | null;
  }>;
  needsInput: boolean;
  settled: boolean;
  processExited: boolean;
  activity: boolean;
}

export interface RuntimeV3WarmTurnPersistence {
  authorize(
    claim: RuntimeV3Claim,
    signal?: AbortSignal,
  ): Promise<RuntimeV3WarmTurnMaterial | null>;
  beginAdmission(
    claim: RuntimeV3Claim,
    input: { invocationId: string; cursor: bigint },
    signal?: AbortSignal,
  ): Promise<boolean>;
  recordAdmission(
    claim: RuntimeV3Claim,
    input: { invocationId: string; responseTurnId: string; cursor: bigint },
    signal?: AbortSignal,
  ): Promise<boolean>;
  project(
    claim: RuntimeV3Claim,
    projection: RuntimeV3WarmTurnProjection,
    signal?: AbortSignal,
  ): Promise<boolean | "succeeded" | "failed">;
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
    | {
      outcome: "accepted";
      invocationId: string;
      responseAttemptId?: string;
      initialCursor: bigint;
    }
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
}

const LANE_CONVERGENCE_LIMIT = 16;

export interface RuntimeV3CommandWindow {
  commandMs: number;
  settlementMs: number;
}

export function runtimeV3CommandWindow(input: {
  now: Date;
  inactivityDeadlineAt: Date | null;
  absoluteDeadlineAt: Date | null;
}): RuntimeV3CommandWindow {
  const silentDeadline = input.inactivityDeadlineAt
    ? input.inactivityDeadlineAt.getTime() - COMPANION_RUNTIME_V3_BUDGETS.silentSettlementMs
    : Number.POSITIVE_INFINITY;
  const absoluteDeadline = input.absoluteDeadlineAt
    ? input.absoluteDeadlineAt.getTime() - COMPANION_RUNTIME_V3_BUDGETS.heartbeatSettlementMs
    : input.now.getTime() + COMPANION_RUNTIME_V3_BUDGETS.heartbeatCommandMs;
  const silentWins = silentDeadline <= absoluteDeadline;
  return {
    commandMs: Math.max(1, (silentWins ? silentDeadline : absoluteDeadline) - input.now.getTime()),
    settlementMs: silentWins
      ? COMPANION_RUNTIME_V3_BUDGETS.silentSettlementMs
      : COMPANION_RUNTIME_V3_BUDGETS.heartbeatSettlementMs,
  };
}

function boundedSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

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
    let projectionPendingAck: "none" | "nonterminal" | "terminal" = "none";
    let admissionWriteIntent = false;
    let inactivityDeadlineAt = claim.turn.inactivityDeadlineAt ?? null;
    let absoluteDeadlineAt = claim.turn.absoluteDeadlineAt ?? null;
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
      if (claim.turn.state === "succeeded" || claim.turn.state === "failed") {
        projectionPendingAck = "terminal";
        await options.pi.acknowledge({
          boxId: material.boxId,
          through: cursor,
          signal: boundedSignal(signal, COMPANION_RUNTIME_V3_BUDGETS.heartbeatSettlementMs),
        });
        projectionPendingAck = "none";
        return { kind: "ack_completed" };
      }
      if (claim.turn.state === "queued") {
        if (claim.turn.admissionStartedAt) {
          return {
            kind: "interrupted",
            code: "pi_admission_outcome_unknown",
            message: "Pi may have acted on this message; it will not be sent again.",
            action: "none",
          };
        }
        const admissionFence = { invocationId: material.piInvocationId, cursor: material.cursor };
        const begun = signal
          ? await options.persistence.beginAdmission(claim, admissionFence, signal)
          : await options.persistence.beginAdmission(claim, admissionFence);
        signal?.throwIfAborted();
        if (!begun) {
          return {
            kind: "interrupted",
            code: "pi_admission_fence_lost",
            message: "Pi admission could not be fenced safely.",
            action: "none",
          };
        }
        admissionWriteIntent = true;
        const admissionTimeout = AbortSignal.timeout(
          COMPANION_RUNTIME_V3_BUDGETS.admissionAckMs,
        );
        const admissionSignal = signal
          ? AbortSignal.any([signal, admissionTimeout])
          : admissionTimeout;
        const admission = await options.pi.prompt({
          boxId: material.boxId,
          commandId: claim.turn.commandId,
          turnId: claim.turn.id,
          expectedInvocationId: material.piInvocationId,
          message: material.content,
          signal: admissionSignal,
        });
        signal?.throwIfAborted();
        if (admission.outcome === "rejected") {
          return { kind: "release" };
        }
        if (admission.outcome === "ambiguous") {
          return {
            kind: "interrupted",
            code: "pi_admission_ambiguous",
            message: "Pi may have acted on this message; it will not be sent again.",
            action: "none",
          };
        }
        const admissionRecord = {
          invocationId: admission.invocationId,
          responseTurnId: admission.responseAttemptId ?? claim.turn.id,
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
            message: "Pi may have acted on this message; it will not be sent again.",
            action: "none",
          };
        }
        admissionWriteIntent = false;
        const admittedAt = Date.now();
        absoluteDeadlineAt ??= new Date(admittedAt + COMPANION_BUDGETS.turnAbsoluteDeadlineMs);
        inactivityDeadlineAt ??= new Date(Math.min(
          admittedAt + COMPANION_BUDGETS.inactivityStallMs,
          absoluteDeadlineAt.getTime(),
        ));
        invocationId = admission.invocationId;
        cursor = admission.initialCursor;
        if (admission.responseAttemptId && admission.responseAttemptId !== claim.turn.id) {
          return { kind: "release" };
        }
      } else if (
        claim.turn.state !== "admitted"
        && claim.turn.state !== "running"
        && claim.turn.state !== "needs_input"
      ) {
        return {
          kind: "interrupted",
          code: "warm_turn_state_invalid",
          message: "The warm Turn cannot resume from its durable state.",
          action: "none",
        };
      }

      let assistantResults = 0;
      for (let pageNumber = 0; pageNumber < 32; pageNumber += 1) {
        const commandWindow = runtimeV3CommandWindow({
          now: new Date(),
          inactivityDeadlineAt,
          absoluteDeadlineAt,
        });
        const commandSignal = boundedSignal(signal, commandWindow.commandMs);
        const page = await options.pi.read({
          boxId: material.boxId,
          after: cursor,
          turnId: claim.turn.id,
          invocationId,
          signal: commandSignal,
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
          compactions: classified.projections.flatMap((item) => item.type === "compaction"
            ? [{
              cursor: item.sequence,
              summary: item.summary,
              firstKeptEntryId: item.first_kept_entry_id,
              tokensBefore: item.tokens_before,
              estimatedTokensAfter: item.estimated_tokens_after,
              cacheRead: item.cache_read,
              cacheWrite: item.cache_write,
            }]
            : []),
          needsInput: classified.needsInput,
          settled: classified.settled,
          processExited: classified.processExit !== null,
          activity: classified.activity,
        };
        const projected = await options.persistence.project(claim, projection, commandSignal);
        if (projected) {
          projectionPendingAck = projected === "succeeded" || projected === "failed"
            ? "terminal"
            : "nonterminal";
        }
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
          signal: boundedSignal(signal, commandWindow.settlementMs),
        });
        projectionPendingAck = "none";
        signal?.throwIfAborted();
        cursor = classified.throughCursor;
        if (classified.needsInput) {
          inactivityDeadlineAt = null;
        } else if (classified.activity && absoluteDeadlineAt) {
          inactivityDeadlineAt = new Date(Math.min(
            Date.now() + COMPANION_BUDGETS.inactivityStallMs,
            absoluteDeadlineAt.getTime(),
          ));
        }
        if (projected === "succeeded" || projected === "failed") {
          return { kind: "ack_completed" };
        }
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
        if (!page.hasMore) return { kind: "release" };
      }
      return { kind: "release" };
    } catch {
      if (projectionPendingAck === "terminal") {
        return { kind: "retry_ack" };
      }
      if (projectionPendingAck === "nonterminal") return { kind: "release" };
      if (admissionWriteIntent) {
        return {
          kind: "interrupted",
          code: "pi_admission_outcome_unknown",
          message: "Pi may have acted on this message; it will not be sent again.",
          action: "none",
        };
      }
      return {
        kind: "failed",
        code: "warm_turn_failed",
        message: "The warm Turn could not be completed.",
        action: "none",
      };
    }
  };
}

const PREPARATION_POLL_SECONDS = 1;
const PREPARATION_BOX_TTL_SECONDS = 6 * 60 * 60;
export const RUNTIME_V3_PREPARATION_BUDGET_MS =
  COMPANION_RUNTIME_V3_BUDGETS.preparationDeadlineMs;
export const RUNTIME_V3_STAGING_BUDGET_MS = COMPANION_RUNTIME_V3_BUDGETS.stagingMs;
export const RUNTIME_V3_PI_ACTIVATION_BUDGET_MS =
  COMPANION_RUNTIME_V3_BUDGETS.piActivationMs;

if (
  RUNTIME_V3_STAGING_BUDGET_MS >= RUNTIME_V3_PREPARATION_BUDGET_MS
  || RUNTIME_V3_PI_ACTIVATION_BUDGET_MS >= RUNTIME_V3_STAGING_BUDGET_MS
) throw new Error("Runtime v3 nested preparation budgets require a strict margin");

export function runtimeV3PreparationRetryDelaySeconds(input: {
  attemptCount: number;
  jitter: number;
  now: Date;
  deadlineAt: Date | null;
}): number {
  const ladder = COMPANION_RUNTIME_V3_BUDGETS.preparationRetrySeconds;
  const index = Math.min(Math.max(0, Math.trunc(input.attemptCount)), ladder.length - 1);
  const base = ladder[index]!;
  const sample = Math.min(1, Math.max(0, Number.isFinite(input.jitter) ? input.jitter : 0.5));
  const jittered = Math.min(
    ladder[ladder.length - 1]!,
    Math.max(1, Math.round(base * (0.8 + sample * 0.4))),
  );
  if (!input.deadlineAt) return jittered;
  const remaining = Math.floor((input.deadlineAt.getTime() - input.now.getTime()) / 1_000);
  return Math.max(1, Math.min(jittered, remaining));
}

const LIFECYCLE_RETRY_SECONDS = 5;

/**
 * Converge cost-saving lifecycle work without exposing any Box creation or restart primitive.
 * Every accepted provider mutation is preceded by a durable checkpoint; takeover therefore
 * observes or polls the same persistent Box instead of replaying an ambiguous destructive call.
 */
export function createRuntimeV3Lifecycle(
  options: RuntimeV3LifecycleOptions,
): RuntimeV3Convergence {
  return {
    async converge({ executorId, signal: shutdownSignal }) {
      let progressed = 0;
      while (progressed < LANE_CONVERGENCE_LIMIT) {
        const timeoutSignal = AbortSignal.timeout(COMPANION_BUDGETS.boxRequestTimeoutMs);
        const signal = shutdownSignal
          ? AbortSignal.any([shutdownSignal, timeoutSignal])
          : timeoutSignal;
        const claim = await options.persistence.claim({ executorId, signal });
        if (!claim) return { progressed, exhausted: false };
        let errorClaim = claim;
        try {
          if (claim.checkpoint === "archive_pending") {
            if (!await options.persistence.checkpoint(claim, { next: "archive_requested" }, signal)) {
              return { progressed, exhausted: false };
            }
          } else if (
            claim.checkpoint === "archive_requested"
            || claim.checkpoint === "waiting_archived"
          ) {
            if (!claim.boxId) throw new Error("Persistent Companion Box identity is missing");
            const observed = await options.box.getStatus({ boxId: claim.boxId, signal });
            if (observed.state === "absent") {
              throw new Error("The persistent Companion Box is absent and cannot be replaced");
            }
            if (observed.state === "archived") {
              if (!await options.persistence.checkpoint(claim, { next: "archived" }, signal)) {
                return { progressed, exhausted: false };
              }
            } else if (claim.checkpoint === "archive_requested"
              && !["archiving", "initializing", "provisioning"].includes(observed.state)) {
              await options.box.stopExistingBox({ boxId: claim.boxId, signal });
              if (!await options.persistence.checkpoint(claim, { next: "waiting_archived" }, signal)) {
                return { progressed, exhausted: false };
              }
            } else {
              await options.persistence.defer(claim, {
                delaySeconds: LIFECYCLE_RETRY_SECONDS,
                error: null,
              }, signal);
            }
          } else if (claim.checkpoint === "wake_pending") {
            if (!await options.persistence.checkpoint(claim, { next: "wake_requested" }, signal)) {
              return { progressed, exhausted: false };
            }
          } else if (
            claim.checkpoint === "wake_requested"
            || claim.checkpoint === "waiting_ready"
          ) {
            if (!claim.boxId) throw new Error("Persistent Companion Box identity is missing");
            const observed = await options.box.getStatus({ boxId: claim.boxId, signal });
            if (observed.state === "absent") {
              throw new Error("The persistent Companion Box is absent and cannot be replaced");
            }
            if (["ready", "idle", "running"].includes(observed.state)) {
              if (!await options.persistence.checkpoint(claim, { next: "active" }, signal)) {
                return { progressed, exhausted: false };
              }
            } else if (claim.checkpoint === "wake_requested" && observed.state === "archived") {
              await options.box.resumeExistingBox({ boxId: claim.boxId, signal });
              if (!await options.persistence.checkpoint(claim, { next: "waiting_ready" }, signal)) {
                return { progressed, exhausted: false };
              }
            } else {
              await options.persistence.defer(claim, {
                delaySeconds: LIFECYCLE_RETRY_SECONDS,
                error: null,
              }, signal);
            }
          } else if (claim.checkpoint === "delete_pending") {
            if (!await options.persistence.checkpoint(claim, { next: "delete_requested" }, signal)) {
              return { progressed, exhausted: false };
            }
          } else if (claim.checkpoint === "delete_requested") {
            if (!claim.boxId) {
              if (!await options.persistence.finalizeDeletion(claim, signal)) {
                return { progressed, exhausted: false };
              }
              progressed += 1;
              continue;
            }
            if (!await options.persistence.checkpoint(claim, { next: "delete_dispatched" }, signal)) {
              return { progressed, exhausted: false };
            }
            const dispatchedClaim: RuntimeV3LifecycleClaim = {
              ...claim,
              checkpoint: "delete_dispatched",
            };
            errorClaim = dispatchedClaim;
            const requested = await options.box.requestPermanentDeletion({
              boxId: claim.boxId,
              signal,
            });
            if (requested.outcome === "absent") {
              if (!await options.persistence.finalizeDeletion(dispatchedClaim, signal)) {
                return { progressed, exhausted: false };
              }
            } else if (!await options.persistence.checkpoint(dispatchedClaim, {
              next: "waiting_deleted",
              providerOperationId: requested.operationId,
            }, signal)) {
              return { progressed, exhausted: false };
            }
          } else if (claim.checkpoint === "delete_dispatched") {
            if (!claim.boxId) throw new Error("Persistent Companion Box identity is missing");
            const observed = await options.box.getStatus({ boxId: claim.boxId, signal });
            if (observed.state === "absent") {
              if (!await options.persistence.finalizeDeletion(claim, signal)) {
                return { progressed, exhausted: false };
              }
            } else {
              await options.persistence.defer(claim, {
                delaySeconds: LIFECYCLE_RETRY_SECONDS,
                error: safeRuntimeError({
                  code: "companion_delete_outcome_unknown",
                  message: "Provider deletion outcome is unknown; waiting for Box absence confirmation.",
                  action: "retry",
                }),
              }, signal);
            }
          } else {
            if (!claim.boxId || !claim.providerOperationId) {
              throw new Error("Permanent deletion operation identity is missing");
            }
            const deletion = await options.box.pollPermanentDeletion({
              boxId: claim.boxId,
              operationId: claim.providerOperationId,
              signal,
            });
            if (deletion.status === "completed") {
              if (!await options.persistence.finalizeDeletion(claim, signal)) {
                return { progressed, exhausted: false };
              }
            } else {
              await options.persistence.defer(claim, {
                delaySeconds: LIFECYCLE_RETRY_SECONDS,
                error: null,
              }, signal);
            }
          }
          progressed += 1;
        } catch (error) {
          const action = "retry" as const;
          await options.persistence.defer(errorClaim, {
            delaySeconds: LIFECYCLE_RETRY_SECONDS,
            error: safeRuntimeError({
              code: errorClaim.checkpoint.startsWith("delete")
                || errorClaim.checkpoint === "waiting_deleted"
                ? "companion_delete_failed"
                : errorClaim.checkpoint.startsWith("wake")
                  || errorClaim.checkpoint === "waiting_ready"
                  ? "companion_wake_failed"
                  : "companion_archive_failed",
              message: error,
              action,
            }),
          }, signal);
          return { progressed: progressed + 1, exhausted: false };
        }
      }
      return { progressed, exhausted: true };
    },
  };
}

/** Prepare one cold Companion through fenced, restart-safe checkpoints. */
export function createRuntimeV3Preparation(
  options: RuntimeV3PreparationOptions,
): RuntimeV3Convergence {
  const now = options.now ?? (() => new Date());
  const jitter = options.jitter ?? Math.random;
  return {
    async converge({ executorId }) {
      let progressed = 0;
      while (progressed < LANE_CONVERGENCE_LIMIT) {
        const claim = await options.persistence.claim({ executorId });
        if (!claim) return { progressed, exhausted: false };
        const remainingMs = claim.deadlineAt
          ? Math.max(1, claim.deadlineAt.getTime() - now().getTime())
          : RUNTIME_V3_PREPARATION_BUDGET_MS;
        const signal = AbortSignal.timeout(Math.min(RUNTIME_V3_STAGING_BUDGET_MS, remainingMs));
        try {
          if (!claim.authorized) throw new Error("Runtime v3 preparation is not authorized");
          if (claim.piRecycleCheckpoint === "terminate") {
            if (!claim.boxId || !claim.recyclePiInvocationId || !claim.recoveryId) {
              throw new Error("Fenced Pi recycle identity is incomplete");
            }
            if (!options.pi.terminatePiInvocation || !options.persistence.checkpointPiRecycle) {
              throw new Error("Fenced Pi recycle boundary is unavailable");
            }
            if (!await options.persistence.reauthorize(claim)) {
              throw new Error("Runtime v3 preparation authorization changed");
            }
            const stopped = await options.pi.terminatePiInvocation({
              boxId: claim.boxId,
              expectedInvocationId: claim.recyclePiInvocationId,
              signal,
            });
            if (stopped.outcome === "superseded") {
              throw new Error("A newer Pi invocation superseded the fenced recycle");
            }
            if (!await options.persistence.checkpointPiRecycle(claim, "reset")) {
              return { progressed, exhausted: false };
            }
          } else if (claim.piRecycleCheckpoint === "reset") {
            if (!claim.boxId || !claim.recoveryId) {
              throw new Error("Fenced Pi recycle identity is incomplete");
            }
            if (!await options.persistence.reauthorize(claim)) {
              throw new Error("Runtime v3 preparation authorization changed");
            }
            if (!options.pi.resetPiSession || !options.persistence.checkpointPiRecycle) {
              throw new Error("Fenced Pi recycle boundary is unavailable");
            }
            await options.pi.resetPiSession({
              boxId: claim.boxId,
              recoveryId: claim.recoveryId,
              signal,
            });
            if (!await options.persistence.checkpointPiRecycle(claim, "complete")) {
              return { progressed, exhausted: false };
            }
          } else if (claim.checkpoint === "pending") {
            if (!await options.persistence.reauthorize(claim)) {
              throw new Error("Runtime v3 preparation authorization changed");
            }
            const created = await options.box.createGenerationBox({
              companionId: claim.companionId,
              generation: 1n,
              ttlSeconds: PREPARATION_BOX_TTL_SECONDS,
              idempotencyKey: claim.boxIdempotencyKey,
              // Preparation owns no user-facing operation deadline. The signal bounds the whole
              // claim, while this bound lets an unknown-snapshot fallback take a fresh create slot.
              workDeadlineAt: new Date(now().getTime() + 60_000),
              // A preparation claim never waits for an image build. It may consume a ready image,
              // while the next fenced claim retries after the normal preparation backoff.
              deadlineAt: now(),
              signal: AbortSignal.any([
                signal,
                AbortSignal.timeout(COMPANION_RUNTIME_V3_BUDGETS.providerRequestMs),
              ]),
            });
            if (!await options.persistence.checkpoint(claim, {
              next: "box_created",
              boxId: created.boxId,
            })) return { progressed, exhausted: false };
          } else if (claim.checkpoint === "box_created") {
            if (!claim.boxId) throw new Error("Box identity is missing after creation");
            if (!await options.persistence.reauthorize(claim)) {
              throw new Error("Runtime v3 preparation authorization changed");
            }
            await options.box.applyGenerationBoxSettings({
              boxId: claim.boxId,
              companionId: claim.companionId,
              generation: 1n,
              ttlSeconds: PREPARATION_BOX_TTL_SECONDS,
              signal: AbortSignal.any([
                signal,
                AbortSignal.timeout(COMPANION_RUNTIME_V3_BUDGETS.providerRequestMs),
              ]),
            });
            const observed = await options.box.getStatus({
              boxId: claim.boxId,
              companionId: claim.companionId,
              generation: 1n,
              signal: AbortSignal.any([
                signal,
                AbortSignal.timeout(COMPANION_RUNTIME_V3_BUDGETS.providerRequestMs),
              ]),
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
            const staged = await options.preparationStager.stagePreparation({
              claim,
              authorize: async () => await options.persistence.mintCredentials(claim),
              signal: AbortSignal.any([
                signal,
                AbortSignal.timeout(RUNTIME_V3_STAGING_BUDGET_MS),
              ]),
            });
            if (!await options.persistence.checkpoint(claim, {
              next: "staged",
              diskLayoutVersion: staged.diskLayoutVersion,
              appliedSettingsRevision: staged.appliedSettingsRevision,
              appliedSkillsRevision: staged.appliedSkillsRevision,
              skillsDigest: staged.skillsDigest,
              materialExpiresAt: staged.materialExpiresAt,
            })) {
              return { progressed, exhausted: false };
            }
          } else {
            if (!claim.boxId) throw new Error("Box identity is missing before Pi activation");
            if (!await options.persistence.reauthorize(claim)) {
              throw new Error("Runtime v3 preparation authorization changed");
            }
            const pi = await options.pi.startPiDaemon({
              boxId: claim.boxId,
              signal: AbortSignal.any([
                signal,
                AbortSignal.timeout(RUNTIME_V3_PI_ACTIVATION_BUDGET_MS),
              ]),
            });
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
            delaySeconds: runtimeV3PreparationRetryDelaySeconds({
              attemptCount: claim.attemptCount ?? 0,
              jitter: jitter(),
              now: now(),
              deadlineAt: claim.deadlineAt ?? null,
            }),
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
  ...convergences: RuntimeV3Convergence[]
): RuntimeV3Convergence {
  return {
    async converge(input) {
      const results = [];
      for (const convergence of convergences) {
        results.push(await convergence.converge(input));
      }
      return {
        progressed: results.reduce((count, result) => count + result.progressed, 0),
        exhausted: results.some((result) => result.exhausted),
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
          if (outcome.kind === "release" || outcome.kind === "retry_ack") {
            return { progressed, exhausted: false };
          }
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

/** Deadline enforcement runs on its own scheduler so blocked preparation cannot delay a Turn. */
export function createRuntimeV3DeadlineSweep(
  persistence: Pick<RuntimeV3ConvergencePersistence, "sweepLane">,
): RuntimeV3Convergence {
  return {
    converge: async ({ signal }) => {
      const swept = await Promise.all(RUNTIME_V3_LANES.map(async (lane) =>
        await persistence.sweepLane({ lane, signal })));
      return {
        progressed: swept.reduce((count, value) => count + value, 0),
        exhausted: false,
      };
    },
  };
}
