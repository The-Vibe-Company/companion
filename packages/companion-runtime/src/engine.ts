/* oxlint-disable anti-slop/no-unknown-parameters -- The engine is the existing exception boundary: caught provider/store values are expurgated before persistence and described only for structured process logs. */

import { handleAttempt } from "./attempt";
import { handleDecision } from "./decision";
import {
  AmbiguousExternalEffectError,
  RuntimeInvariantError,
  RuntimeShutdownError,
  denialRuntimeError,
  safeErrorFromUnknown,
} from "./errors";
import type { RuntimeWorkDisposition } from "./handler";
import { handleHealth } from "./health";
import {
  LeaseAuthorizationDeniedError,
  LeaseFenceLostError,
  LeaseRenewalError,
  LeaseSession,
} from "./leaseSession";
import { describeThrownError, workFailureLogRecord } from "./logging";
import { handleOperation } from "./operations";
import type { RuntimeEngineDependencies } from "./ports";
import { handleSettings } from "./settings";
import {
  RuntimeStoreIndeterminateError,
  RuntimeStoreSerializationError,
} from "./store";
import type { RuntimeClaim, RuntimeSettlementInput, SafeRuntimeError } from "./types";

export type RuntimeExecutionOutcome =
  | "succeeded"
  | "failed"
  | "interrupted"
  | "cancelled"
  | "handed_off"
  | "released"
  | "fence_lost";

export interface RuntimeExecutionResult {
  workKind: RuntimeClaim["workKind"];
  workId: string;
  companionId: string;
  outcome: RuntimeExecutionOutcome;
}

const RELEASE_DENIALS = new Set([
  "higher_priority_work_pending",
  "source_turn_settled",
  "settings_changed_since_claim",
  "settings_changed",
]);

class RoutineCancelTerminationError extends Error {
  readonly stableCode = "routine_cancel_termination_ambiguous";
  readonly action = "retry" as const;

  constructor() {
    super("The isolated routine process could not be proven stopped after cancellation.");
    this.name = "RoutineCancelTerminationError";
  }
}

export class RuntimeEngine {
  readonly #deps: RuntimeEngineDependencies;
  readonly #sessions = new Map<string, LeaseSession>();
  readonly #executions = new Set<Promise<RuntimeExecutionResult>>();
  #shuttingDown = false;

  constructor(dependencies: RuntimeEngineDependencies) {
    this.#deps = dependencies;
  }

  get activeCount(): number {
    return this.#executions.size;
  }

  execute(claim: RuntimeClaim): Promise<RuntimeExecutionResult> {
    const execution = this.#execute(claim);
    this.#executions.add(execution);
    const cleanup = (): void => {
      this.#executions.delete(execution);
    };
    // Do not use an ignored `finally()` promise here: it mirrors a rejection and
    // would become an unhandled rejection even when the caller handles `execution`.
    void execution.then(cleanup, cleanup);
    return execution;
  }

  requestShutdown(): void {
    this.#shuttingDown = true;
    this.interruptActive();
  }

  handoffActive(): void {
    for (const session of this.#sessions.values()) session.requestHandoff();
  }

  interruptActive(): void {
    for (const session of this.#sessions.values()) session.requestShutdown();
  }

  async drain(): Promise<void> {
    await Promise.allSettled(this.#executions);
  }

  async #execute(claim: RuntimeClaim): Promise<RuntimeExecutionResult> {
    const session = new LeaseSession({
      store: this.#deps.store,
      claim,
      executorId: this.#deps.executorId,
      clock: this.#deps.clock,
      onRenewalError: ({ fence, attempt, error }) => {
        this.#deps.log?.warn({
          ts: this.#deps.clock.now().toISOString(),
          event: "lease.renew.failed",
          companionId: fence.companionId,
          workKind: fence.workKind,
          workId: fence.workId,
          attempt,
          thrown: describeThrownError(error),
        });
      },
    });
    this.#sessions.set(claim.workId, session);
    try {
      const authorization = await session.start();
      const localControl = await this.#honorLocalControl(claim, session);
      if (localControl) return localControl;
      if (!authorization.authorized) {
        return await this.#finishDenial(claim, session, authorization.denialCode);
      }
      const disposition = await this.#dispatch(claim, session);
      const controlAfterDispatch = await this.#honorLocalControl(claim, session);
      if (controlAfterDispatch) return controlAfterDispatch;
      if (disposition.kind === "release") {
        const released = await session.release();
        return this.#result(claim, released ? "released" : "fence_lost");
      }
      if (disposition.kind === "defer_delete") {
        const deferred = await session.deferDelete();
        return this.#result(claim, deferred ? "released" : "fence_lost");
      }
      return await this.#finishSettlement(claim, session, disposition.settlement);
    } catch (error) {
      const localControl = await this.#honorLocalControl(claim, session);
      if (localControl) return localControl;
      if (error instanceof LeaseFenceLostError || error instanceof LeaseRenewalError) {
        this.#logFailure({
          claim,
          session,
          event: "runtime.work.fence_lost",
          outcome: "fence_lost",
          reason: error instanceof LeaseRenewalError ? "lease_renewal_failed" : "lease_fence_lost",
          thrown: error,
          // A rejected stale fence is the safety mechanism working: the replacement executor owns
          // recovery and this holder must abandon without settlement. A renewal failure is still an
          // error because it means the heartbeat exhausted its lease runway without an authoritative
          // takeover result.
          level: error instanceof LeaseFenceLostError ? "warn" : "error",
        });
        return this.#result(claim, "fence_lost");
      }
      if (
        error instanceof RuntimeStoreSerializationError
        || error instanceof RuntimeStoreIndeterminateError
      ) {
        // The database may have committed a response-lost CAS. Do not guess or replay a side effect.
        session.stop();
        this.#logFailure({
          claim,
          session,
          event: "runtime.work.fence_lost",
          outcome: "fence_lost",
          reason: error instanceof RuntimeStoreSerializationError
            ? "serialization_conflict"
            : "indeterminate_store",
          thrown: error,
        });
        return this.#result(claim, "fence_lost");
      }
      if (error instanceof LeaseAuthorizationDeniedError) {
        try {
          return await this.#finishDenial(claim, session, error.denialCode, error);
        } catch (denialError) {
          if (denialError instanceof RoutineCancelTerminationError) {
            return await this.#finishSettlement(claim, session, {
              terminalStatus: "interrupted",
              error: safeErrorFromUnknown(denialError, {
                code: "routine_cancel_termination_ambiguous",
                message: "The isolated routine process could not be proven stopped after cancellation.",
                action: "retry",
              }),
            }, denialError);
          }
          throw denialError;
        }
      }
      if (
        error instanceof RuntimeInvariantError
        && error.stableCode === "cold_start_deadline_exceeded"
        && claim.workKind === "operation"
        && claim.operationKind === "start"
        && claim.turnId !== null
      ) {
        return await this.#finishSettlement(claim, session, {
          terminalStatus: "interrupted",
          error: safeErrorFromUnknown(error, {
            code: "cold_start_deadline_exceeded",
            message: "The Companion did not start before its deadline.",
            action: "retry",
          }),
        }, error);
      }
      if (error instanceof AmbiguousExternalEffectError) {
        return await this.#finishSettlement(claim, session, {
          terminalStatus: "interrupted",
          error: safeErrorFromUnknown(error, {
            code: "external_effect_ambiguous",
            message: "An external effect may have succeeded and was not replayed.",
            action: "retry",
          }),
        }, error);
      }
      if (error instanceof RoutineCancelTerminationError) {
        return await this.#finishSettlement(claim, session, {
          terminalStatus: "interrupted",
          error: safeErrorFromUnknown(error, {
            code: "routine_cancel_termination_ambiguous",
            message: "The isolated routine process could not be proven stopped after cancellation.",
            action: "retry",
          }),
        }, error);
      }
      if (error instanceof RuntimeShutdownError) {
        return await this.#finishSettlement(claim, session, {
          terminalStatus: "interrupted",
          error: safeErrorFromUnknown(error, {
            code: "runtime_shutting_down",
            message: "Runtime execution was interrupted during shutdown.",
            action: "retry",
          }),
        }, error);
      }
      return await this.#finishSettlement(claim, session, {
        terminalStatus: "failed",
        error: safeErrorFromUnknown(error, {
          code: "runtime_execution_failed",
          message: "Runtime execution failed.",
          action: "retry",
        }),
      }, error);
    } finally {
      session.stop();
      await session.drain();
      this.#sessions.delete(claim.workId);
    }
  }

  async #dispatch(
    claim: RuntimeClaim,
    session: LeaseSession,
  ): Promise<RuntimeWorkDisposition> {
    switch (claim.workKind) {
      case "operation":
        return await handleOperation({ claim, session, deps: this.#deps });
      case "decision":
        return await handleDecision({ claim, session, deps: this.#deps });
      case "attempt":
        return await handleAttempt({ claim, session, deps: this.#deps });
      case "settings":
        return await handleSettings({ claim, session, deps: this.#deps });
      case "health":
        return await handleHealth({ claim, session, deps: this.#deps });
    }
  }

  async #finishDenial(
    claim: RuntimeClaim,
    session: LeaseSession,
    denialCode: string | null,
    thrown?: unknown,
  ): Promise<RuntimeExecutionResult> {
    const code = denialCode ?? "runtime_authorization_denied";
    if (RELEASE_DENIALS.has(code)) {
      const released = await session.release();
      return this.#result(claim, released ? "released" : "fence_lost");
    }
    if (code === "turn_cancel_requested") {
      await this.#abortAttempt(claim, session);
      return await this.#finishSettlement(claim, session, {
        terminalStatus: "cancelled",
      }, thrown);
    }
    const settlement = denialRuntimeError(code);
    return await this.#finishSettlement(claim, session, settlement, thrown);
  }

  /**
   * Best-effort Pi abort on Owner/Editor stop. The lease signal is already aborted by the denial,
   * so this uses a short independent deadline rather than the turn's lease.
   */
  async #abortAttempt(
    claim: RuntimeClaim,
    session: LeaseSession,
  ): Promise<boolean> {
    if (claim.workKind !== "attempt") return true;
    const auth = session.cleanupAuthorization;
    if (!auth?.boxId) return true;
    if (auth.dispatchState !== "accepted"
      && auth.dispatchState !== "write_intent"
      && auth.dispatchState !== "ambiguous") return true;
    const runId = claim.turnId;
    if (
      runId
      // `piInvocationId` is the main Companion Pi. Cancellation authorization preserves the
      // attempt-bound command identity so an isolated run is stopped without touching main Pi.
      && auth.commandPiInvocationId?.startsWith(`routine:${runId}:`)
      && this.#deps.pi.routineSession
    ) {
      const abortController = new AbortController();
      const abortTimer = setTimeout(() => abortController.abort(), 8_000);
      try {
        await this.#deps.pi.routineSession.abort({
          boxId: auth.boxId,
          runId,
          commandId: this.#deps.idFactory.uuid(),
          attemptId: claim.workId,
          signal: abortController.signal,
        });
      } catch {
        // Process termination is the authoritative cancellation boundary for isolated routines.
      } finally {
        clearTimeout(abortTimer);
      }
      const terminateController = new AbortController();
      const terminateTimer = setTimeout(() => terminateController.abort(), 8_000);
      try {
        await this.#deps.pi.routineSession.terminate({
          boxId: auth.boxId,
          runId,
          expectedInvocationId: auth.commandPiInvocationId,
          signal: terminateController.signal,
        });
        return true;
      } catch {
        throw new RoutineCancelTerminationError();
      } finally {
        clearTimeout(terminateTimer);
      }
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8_000);
    try {
      await this.#deps.pi.abort({
        boxId: auth.boxId,
        commandId: this.#deps.idFactory.uuid(),
        attemptId: claim.workId,
        signal: controller.signal,
      });
      return true;
    } catch {
      // Ordinary turn-derived Start/preflight owns persistent main Pi reconciliation.
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  async #honorLocalControl(
    claim: RuntimeClaim,
    session: LeaseSession,
  ): Promise<RuntimeExecutionResult | null> {
    if (session.handoffRequested) {
      return this.#result(claim, "handed_off");
    }
    if (!this.#shuttingDown && !session.shutdownRequested) return null;
    session.requestShutdown();
    return await this.#finishSettlement(claim, session, {
      terminalStatus: "interrupted",
      error: safeErrorFromUnknown(new RuntimeShutdownError(), {
        code: "runtime_shutting_down",
        message: "Runtime execution was interrupted during shutdown.",
        action: "retry",
      }),
    });
  }

  async #finishSettlement(
    claim: RuntimeClaim,
    session: LeaseSession,
    settlement: RuntimeSettlementInput,
    thrown?: unknown,
  ): Promise<RuntimeExecutionResult> {
    const terminalSettlement: RuntimeSettlementInput = settlement.terminalStatus === "interrupted"
      && settlement.error
      ? { ...settlement, error: { ...settlement.error, action: "none" } }
      : settlement;
    if (terminalSettlement.terminalStatus === "interrupted" && claim.workKind === "attempt") {
      try {
        // Cleanup is exact to the accepted/ambiguous attempt and never replays it. Failure remains
        // non-blocking: main preflight recycles a non-idle Pi, while routine runs own isolated roots.
        const cleaned = await this.#abortAttempt(claim, session);
        if (!cleaned) {
          this.#deps.log?.warn({
            ts: this.#deps.clock.now().toISOString(),
            event: "runtime.work.interruption_cleanup_failed",
            companionId: claim.companionId,
            attemptId: claim.workId,
            reason: "attempt_cleanup_unconfirmed",
          });
        }
      } catch (error) {
        this.#deps.log?.warn({
          ts: this.#deps.clock.now().toISOString(),
          event: "runtime.work.interruption_cleanup_failed",
          companionId: claim.companionId,
          attemptId: claim.workId,
          reason: "attempt_cleanup_unconfirmed",
          thrown: describeThrownError(error),
        });
      }
    }
    const settled = await session.settle(terminalSettlement);
    const outcome = settled ? terminalSettlement.terminalStatus : "fence_lost";
    const coldStartRequeued = settled
      && claim.workKind === "operation"
      && claim.operationKind === "start"
      && claim.turnId !== null
      && terminalSettlement.terminalStatus === "interrupted"
      && terminalSettlement.error?.code === "cold_start_deadline_exceeded";
    if (coldStartRequeued) {
      // Protocol 7 atomically re-arms this exact Start and leaves its source turn queued. Keep the
      // existing interrupted scheduler wake, but do not report a terminal interruption that never
      // became durable. This event contains only stable routing/counter fields.
      this.#deps.log?.warn({
        ts: this.#deps.clock.now().toISOString(),
        event: "runtime.work.start_requeued",
        companionId: claim.companionId,
        workKind: claim.workKind,
        workId: claim.workId,
        operationKind: claim.operationKind,
        operationAttemptCount: claim.operationAttemptCount,
        reason: "cold_start_deadline_exceeded",
      });
    } else if (!settled || terminalSettlement.terminalStatus !== "succeeded") {
      this.#logFailure({
        claim,
        session,
        event: settled
          ? `runtime.work.${terminalSettlement.terminalStatus}`
          : "runtime.work.fence_lost",
        outcome,
        reason: settled ? undefined : "settle_rejected",
        thrown,
        persisted: terminalSettlement.error,
        level: terminalSettlement.terminalStatus === "interrupted" && thrown === undefined
          ? "warn"
          : "error",
      });
    }
    return this.#result(claim, outcome);
  }

  #logFailure(input: {
    claim: RuntimeClaim;
    session: LeaseSession;
    event: string;
    outcome: RuntimeExecutionOutcome;
    reason?: string;
    thrown?: unknown;
    persisted?: SafeRuntimeError;
    level?: "error" | "warn";
  }): void {
    const log = this.#deps.log;
    if (!log) return;
    const logInput: Parameters<typeof workFailureLogRecord>[0] = {
      ts: this.#deps.clock.now(),
      event: input.event,
      claim: input.claim,
      authorization: input.session.authorization,
      outcome: input.outcome,
    };
    if (input.reason) logInput.reason = input.reason;
    if (input.thrown !== undefined) logInput.thrown = input.thrown;
    if (input.persisted) logInput.persisted = input.persisted;
    const record = workFailureLogRecord(logInput);
    log[input.level ?? "error"](record);
  }

  #result(claim: RuntimeClaim, outcome: RuntimeExecutionOutcome): RuntimeExecutionResult {
    return {
      workKind: claim.workKind,
      workId: claim.workId,
      companionId: claim.companionId,
      outcome,
    };
  }
}
