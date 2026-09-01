import { COMPANION_BUDGETS } from "@companion/contracts";

import type { RuntimeClock } from "./clock";
import type { RuntimeExecutionOutcome, RuntimeExecutionResult } from "./engine";
import { describeThrownError, type RuntimeProcessLog } from "./logging";
import type { RuntimeClaim } from "./types";
import { claimFence } from "./leaseSession";
import { RUNTIME_LEASE_SECONDS, type RuntimeStore } from "./store";

export const DEFAULT_RUNTIME_SWEEP_INTERVAL_MS = COMPANION_BUDGETS.sweepIntervalMs;
export const DEFAULT_RUNTIME_CONCURRENCY = 8;
export const DEFAULT_RUNTIME_DRAIN_TIMEOUT_MS = COMPANION_BUDGETS.shutdownDrainMs;
export const RUNTIME_RECOVERY_METRICS_INTERVAL_MS = 60_000;

const IMMEDIATE_WAKE_OUTCOMES = new Set<RuntimeExecutionOutcome>([
  "succeeded",
  "failed",
  "interrupted",
  "cancelled",
]);

export interface RuntimeSchedulerSnapshot {
  claimLoopAlive: boolean;
  acceptingClaims: boolean;
  claimsEnabled: boolean;
  gateEnabled: boolean | null;
  lastSweepStartedAt: Date | null;
  lastSweepCompletedAt: Date | null;
  claimLoopErrorAt: Date | null;
  activeCount: number;
  concurrency: number;
  sweepIntervalMs: number;
}

export interface RuntimeEngineControl {
  execute(claim: RuntimeClaim): Promise<RuntimeExecutionResult>;
  handoffActive(): void;
  interruptActive(): void;
  requestShutdown(): void;
  drain(): Promise<void>;
}

function activeExecutionKey(claim: RuntimeClaim, executorId: string): string {
  const fence = claimFence(claim, executorId);
  return [
    fence.orgId,
    fence.companionId,
    fence.claimToken,
    fence.claimEpoch.toString(),
    fence.gateEpoch.toString(),
    fence.executorId,
    fence.workKind,
    fence.workId,
  ].join("\u001f");
}

export class RuntimeScheduler {
  readonly #store: RuntimeStore;
  readonly #engine: RuntimeEngineControl;
  readonly #clock: RuntimeClock;
  readonly #executorId: string;
  readonly #concurrency: number;
  readonly #sweepIntervalMs: number;
  readonly #claimsEnabled: boolean;
  readonly #log: RuntimeProcessLog | undefined;
  readonly #active = new Map<string, Promise<RuntimeExecutionResult>>();
  #loopAbort = new AbortController();
  #sleepAbort: AbortController | null = null;
  #wakePending = false;
  #loopTask: Promise<void> | null = null;
  #loopAlive = false;
  #acceptingClaims = true;
  #gateEnabled: boolean | null = null;
  #lastSweepStartedAt: Date | null = null;
  #lastSweepCompletedAt: Date | null = null;
  #claimLoopErrorAt: Date | null = null;
  #claimLoopErrorStreak = 0;
  #disableApplied = false;
  #gateInterruptionApplied = false;
  #lastRecoveryMetricsAt: Date | null = null;
  #recoveryMetricsTask: Promise<void> | null = null;
  readonly #jitter: () => number;

  constructor(input: {
    store: RuntimeStore;
    engine: RuntimeEngineControl;
    clock: RuntimeClock;
    executorId: string;
    concurrency?: number;
    sweepIntervalMs?: number;
    claimsEnabled: boolean;
    log?: RuntimeProcessLog;
    /** Injectable 0..1 source for backoff jitter; defaults to Math.random. Deterministic in tests. */
    jitter?: () => number;
  }) {
    this.#store = input.store;
    this.#engine = input.engine;
    this.#clock = input.clock;
    this.#executorId = input.executorId;
    this.#concurrency = input.concurrency ?? DEFAULT_RUNTIME_CONCURRENCY;
    this.#sweepIntervalMs = input.sweepIntervalMs ?? DEFAULT_RUNTIME_SWEEP_INTERVAL_MS;
    this.#claimsEnabled = input.claimsEnabled;
    this.#log = input.log;
    this.#jitter = input.jitter ?? Math.random;
    if (!Number.isInteger(this.#concurrency) || this.#concurrency < 1 || this.#concurrency > 100) {
      throw new TypeError("Runtime concurrency must be between 1 and 100");
    }
    if (!Number.isInteger(this.#sweepIntervalMs) || this.#sweepIntervalMs < 100) {
      throw new TypeError("Runtime sweep interval must be at least 100ms");
    }
  }

  start(): void {
    if (this.#loopTask) return;
    this.#acceptingClaims = true;
    this.#loopTask = this.#runLoop();
  }

  stopClaims(): void {
    this.#acceptingClaims = false;
    if (!this.#loopAbort.signal.aborted) this.#loopAbort.abort();
    if (this.#sleepAbort && !this.#sleepAbort.signal.aborted) this.#sleepAbort.abort();
  }

  async shutdown(input: { drainTimeoutMs?: number } = {}): Promise<void> {
    const timeout = input.drainTimeoutMs ?? DEFAULT_RUNTIME_DRAIN_TIMEOUT_MS;
    if (!Number.isFinite(timeout) || timeout < 0) {
      throw new TypeError("Runtime drain timeout must be a non-negative finite number");
    }
    this.stopClaims();
    this.#engine.handoffActive();
    const drain = (async () => {
      await this.#loopTask?.catch(() => undefined);
      await Promise.allSettled(this.#active.values());
      await this.#engine.drain();
    })();
    let timeoutHandle: unknown;
    const deadline = new Promise<void>((resolve) => {
      timeoutHandle = this.#clock.setTimeout(resolve, timeout);
    });
    await Promise.race([drain, deadline]);
    if (timeoutHandle !== undefined) this.#clock.clearTimeout(timeoutHandle);
  }

  snapshot(): RuntimeSchedulerSnapshot {
    return {
      claimLoopAlive: this.#loopAlive,
      acceptingClaims: this.#acceptingClaims,
      claimsEnabled: this.#claimsEnabled,
      gateEnabled: this.#gateEnabled,
      lastSweepStartedAt: this.#lastSweepStartedAt,
      lastSweepCompletedAt: this.#lastSweepCompletedAt,
      claimLoopErrorAt: this.#claimLoopErrorAt,
      activeCount: this.#active.size,
      concurrency: this.#concurrency,
      sweepIntervalMs: this.#sweepIntervalMs,
    };
  }

  async sweepOnce(): Promise<void> {
    this.#lastSweepStartedAt = this.#clock.now();
    try {
      let gate = await this.#store.gateStatus();
      this.#gateEnabled = gate.enabled;
      if (!this.#claimsEnabled) {
        if (gate.enabled) {
          gate = await this.#store.disable(gate.gateEpoch, `runtime:${this.#executorId}`);
          this.#gateEnabled = gate.enabled;
        }
        if (!this.#disableApplied) {
          this.#disableApplied = true;
          this.#engine.requestShutdown();
        }
        this.#claimLoopErrorAt = null;
        this.#claimLoopErrorStreak = 0;
        this.#lastSweepCompletedAt = this.#clock.now();
        return;
      }
      if (!this.#acceptingClaims || !gate.enabled) {
        if (!gate.enabled && !this.#gateInterruptionApplied) {
          this.#gateInterruptionApplied = true;
          this.#engine.interruptActive();
        }
        this.#claimLoopErrorAt = null;
        this.#claimLoopErrorStreak = 0;
        this.#lastSweepCompletedAt = this.#clock.now();
        return;
      }
      this.#gateInterruptionApplied = false;
      this.#startRecoveryMetricsObservation();
      const freeSlots = this.#concurrency - this.#active.size;
      if (freeSlots > 0) {
        const claims = await this.#store.claimWork({
          executorId: this.#executorId,
          limit: freeSlots,
          leaseSeconds: RUNTIME_LEASE_SECONDS,
          gateEpoch: gate.gateEpoch,
        });
        for (const claim of claims) {
          if (!this.#acceptingClaims) {
            await this.#store.release(claimFence(claim, this.#executorId));
            continue;
          }
          const activeKey = activeExecutionKey(claim, this.#executorId);
          if (this.#active.has(activeKey)) {
            // A repeated row with the exact active fence is already owned by this execution.
            // Releasing it here would revoke the lease underneath the in-flight promise.
            continue;
          }
          const execution = this.#engine.execute(claim);
          this.#active.set(activeKey, execution);
          void execution.then(
            (result) => this.#removeActive(activeKey, execution, result.outcome),
            () => this.#removeActive(activeKey, execution, null),
          );
        }
      }
      this.#claimLoopErrorAt = null;
      this.#claimLoopErrorStreak = 0;
      this.#lastSweepCompletedAt = this.#clock.now();
    } catch (error) {
      this.#claimLoopErrorAt = this.#clock.now();
      this.#claimLoopErrorStreak += 1;
      this.#log?.error({
        ts: this.#clock.now().toISOString(),
        event: "runtime.claim_loop.error",
        streak: this.#claimLoopErrorStreak,
        thrown: describeThrownError(error),
      });
      throw error;
    }
  }

  async #observeRecoveryMetrics(): Promise<void> {
    if (!this.#store.recoveryMetrics) return;
    const now = this.#clock.now();
    if (this.#lastRecoveryMetricsAt
      && now.getTime() - this.#lastRecoveryMetricsAt.getTime()
        < RUNTIME_RECOVERY_METRICS_INTERVAL_MS) return;
    this.#lastRecoveryMetricsAt = now;
    try {
      const metrics = await this.#store.recoveryMetrics();
      this.#log?.info({
        ts: this.#clock.now().toISOString(),
        event: "runtime.recovery.metrics",
        pendingCount: metrics.pendingCount,
        oldestAgeSeconds: metrics.oldestAgeSeconds,
        autoAbandonedCount: metrics.autoAbandonedCount,
        stalledCount: metrics.stalledCount,
        maxAttemptCount: metrics.maxAttemptCount,
      });
      if (metrics.stalledCount > 0) {
        this.#log?.warn({
          ts: this.#clock.now().toISOString(),
          event: "runtime.recovery.stalled",
          stalledCount: metrics.stalledCount,
          oldestAgeSeconds: metrics.oldestAgeSeconds,
          maxAttemptCount: metrics.maxAttemptCount,
        });
      }
    } catch (error) {
      // Telemetry is never a claim gate. A broken metric read is itself expurgated and retried on
      // the next one-minute observation boundary while normal recovery continues.
      this.#log?.warn({
        ts: this.#clock.now().toISOString(),
        event: "runtime.recovery.metrics_failed",
        thrown: describeThrownError(error),
      });
    }
  }

  #startRecoveryMetricsObservation(): void {
    if (this.#recoveryMetricsTask) return;
    const task = this.#observeRecoveryMetrics();
    this.#recoveryMetricsTask = task;
    void task.finally(() => {
      if (this.#recoveryMetricsTask === task) this.#recoveryMetricsTask = null;
    });
  }

  /**
   * Sleep before the next sweep. After a claim-loop error, back off from the base sweep interval so
   * a persistently failing DB is not hammered every `sweepIntervalMs`: the base doubles per
   * consecutive error up to a cap of ten sweep intervals, then a ±20% jitter de-synchronizes
   * concurrent executors. A healthy loop keeps the flat sweep cadence.
   */
  #nextSweepDelayMs(): number {
    if (this.#claimLoopErrorStreak === 0) return this.#sweepIntervalMs;
    const growth = Math.min(this.#claimLoopErrorStreak - 1, 10);
    const capped = Math.min(this.#sweepIntervalMs * 2 ** growth, this.#sweepIntervalMs * 10);
    const sample = Math.min(1, Math.max(0, this.#jitter()));
    return Math.max(1, Math.round(capped * (0.8 + sample * 0.4)));
  }

  async #runLoop(): Promise<void> {
    this.#loopAlive = true;
    try {
      while (this.#acceptingClaims) {
        try {
          await this.sweepOnce();
        } catch {
          // Health exposes the stable error timestamp. The loop remains alive for DB recovery.
        }
        if (!this.#acceptingClaims) break;
        if (this.#wakePending) {
          this.#wakePending = false;
          continue;
        }
        const sleepAbort = new AbortController();
        this.#sleepAbort = sleepAbort;
        try {
          await this.#clock.sleep(
            this.#nextSweepDelayMs(),
            AbortSignal.any([this.#loopAbort.signal, sleepAbort.signal]),
          );
        } catch {
          if (!this.#acceptingClaims || this.#loopAbort.signal.aborted) break;
        } finally {
          if (this.#sleepAbort === sleepAbort) this.#sleepAbort = null;
        }
      }
    } finally {
      this.#loopAlive = false;
    }
  }

  #removeActive(
    activeKey: string,
    execution: Promise<RuntimeExecutionResult>,
    outcome: RuntimeExecutionOutcome | null,
  ): void {
    if (this.#active.get(activeKey) !== execution) return;
    this.#active.delete(activeKey);
    // A durable terminal result can have made queued work claimable. A release, lost fence,
    // handoff, or unexpected rejection has not proved that PostgreSQL changed, so the periodic
    // sweep remains its recovery path instead of immediately reclaiming the same dormant row.
    if (outcome === null || !IMMEDIATE_WAKE_OUTCOMES.has(outcome)) return;
    if (this.#sleepAbort && !this.#sleepAbort.signal.aborted) {
      this.#sleepAbort.abort();
    } else {
      // An already-resolved execution may finish in the microtask gap between sweepOnce() and the
      // sleep controller being installed. Retain that wake so the loop never pays the full sweep.
      this.#wakePending = true;
    }
  }
}
