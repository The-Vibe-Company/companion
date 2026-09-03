import type {
  RuntimeSchedulerSnapshot,
} from "@companion/companion-runtime";
import type { RuntimeV3Convergence } from "@companion/companion-runtime/v3/internal";

import type { RuntimeApplicationScheduler } from "./application";

export interface RuntimeKernelScheduler {
  start(): void;
  stopClaims(): void;
  shutdown(input?: { drainTimeoutMs?: number }): Promise<void>;
  snapshot(): RuntimeSchedulerSnapshot;
}

export interface RuntimeV3SchedulerOptions {
  convergence: RuntimeV3Convergence;
  deadlineSweep: RuntimeV3Convergence;
  executorId: string;
  sweepIntervalMs: number;
}

/** Adapt the reusable kernel without inventing a second drain timer or health state. */
export function createRuntimeSchedulerAdapter(
  scheduler: RuntimeKernelScheduler,
  runtimeV3?: RuntimeV3SchedulerOptions,
): RuntimeApplicationScheduler {
  let v3Timer: ReturnType<typeof setTimeout> | null = null;
  let v3Sweep: Promise<void> | null = null;
  let v3SweepAbort: AbortController | null = null;
  let v3DeadlineTimer: ReturnType<typeof setTimeout> | null = null;
  let v3DeadlineSweep: Promise<void> | null = null;
  let v3DeadlineAbort: AbortController | null = null;
  let v3Stopped = true;
  let v3ErrorAt: Date | null = null;
  let v3DeadlineErrorAt: Date | null = null;
  let v3LastSweepStartedAt: Date | null = null;
  let v3LastSweepCompletedAt: Date | null = null;
  let v3LastDeadlineStartedAt: Date | null = null;
  let v3LastDeadlineCompletedAt: Date | null = null;

  const scheduleV3 = (delayMs: number): void => {
    if (!runtimeV3 || v3Stopped) return;
    v3Timer = setTimeout(() => {
      v3Timer = null;
      v3LastDeadlineStartedAt = new Date();
      v3SweepAbort = new AbortController();
      v3Sweep = runtimeV3.convergence.converge({
        executorId: runtimeV3.executorId,
        signal: v3SweepAbort.signal,
      })
        .then((result) => {
          v3DeadlineErrorAt = null;
          v3LastDeadlineCompletedAt = new Date();
          if (result.exhausted) scheduleV3(0);
        })
        .catch(() => {
          v3DeadlineErrorAt = new Date();
        })
        .finally(() => {
          v3Sweep = null;
          v3SweepAbort = null;
          if (!v3Timer) scheduleV3(runtimeV3.sweepIntervalMs);
        });
    }, delayMs);
  };

  const scheduleV3Deadlines = (delayMs: number): void => {
    if (!runtimeV3 || v3Stopped) return;
    v3DeadlineTimer = setTimeout(() => {
      v3DeadlineTimer = null;
      v3LastSweepStartedAt = new Date();
      v3DeadlineAbort = new AbortController();
      v3DeadlineSweep = runtimeV3.deadlineSweep.converge({
        executorId: runtimeV3.executorId,
        signal: v3DeadlineAbort.signal,
      })
        .then(() => {
          v3ErrorAt = null;
          v3LastSweepCompletedAt = new Date();
        })
        .catch(() => {
          v3ErrorAt = new Date();
        })
        .finally(() => {
          v3DeadlineSweep = null;
          v3DeadlineAbort = null;
          if (!v3DeadlineTimer) scheduleV3Deadlines(runtimeV3.sweepIntervalMs);
        });
    }, delayMs);
  };

  return {
    start: () => {
      scheduler.start();
      if (runtimeV3) {
        v3Stopped = false;
        scheduleV3(0);
        scheduleV3Deadlines(0);
      }
    },
    stopClaims: () => {
      v3Stopped = true;
      if (v3Timer) clearTimeout(v3Timer);
      if (v3DeadlineTimer) clearTimeout(v3DeadlineTimer);
      v3Timer = null;
      v3DeadlineTimer = null;
      v3SweepAbort?.abort();
      v3DeadlineAbort?.abort();
      scheduler.stopClaims();
    },
    shutdown: async ({ drainTimeoutMs }) => {
      v3Stopped = true;
      if (v3Timer) clearTimeout(v3Timer);
      if (v3DeadlineTimer) clearTimeout(v3DeadlineTimer);
      v3Timer = null;
      v3DeadlineTimer = null;
      v3SweepAbort?.abort();
      v3DeadlineAbort?.abort();
      await Promise.all([
        v3Sweep,
        v3DeadlineSweep,
        scheduler.shutdown({ drainTimeoutMs }),
      ]);
    },
    snapshot: () => {
      const snapshot = scheduler.snapshot();
      const v3Alive = !runtimeV3 || !v3Stopped;
      const v3StartedAt = runtimeV3
        ? earlierDate(v3LastSweepStartedAt, v3LastDeadlineStartedAt)
        : null;
      const v3CompletedAt = runtimeV3
        ? earlierDate(v3LastSweepCompletedAt, v3LastDeadlineCompletedAt)
        : null;
      return {
        claimLoopAlive: snapshot.claimLoopAlive && v3Alive,
        // RuntimeScheduler contains no terminal loop state: sweep errors are recoverable and carry
        // their timestamp. A process-level fatal error rejects startup instead of reaching here.
        fatal: false,
        lastSweepStartedAt: runtimeV3
          ? earlierDate(snapshot.lastSweepStartedAt, v3StartedAt)
          : snapshot.lastSweepStartedAt,
        lastSweepCompletedAt: runtimeV3
          ? earlierDate(snapshot.lastSweepCompletedAt, v3CompletedAt)
          : snapshot.lastSweepCompletedAt,
        claimLoopErrorAt: v3ErrorAt ?? v3DeadlineErrorAt ?? snapshot.claimLoopErrorAt,
        activeCount: snapshot.activeCount,
      };
    },
  };
}

function earlierDate(left: Date | null, right: Date | null): Date | null {
  if (!left || !right) return null;
  return left.getTime() <= right.getTime() ? left : right;
}
