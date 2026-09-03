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
  /** The single background lane runs on its own clock so Pi work cannot retain human chat. */
  backgroundConvergence?: RuntimeV3Convergence;
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
  let v3BackgroundTimer: ReturnType<typeof setTimeout> | null = null;
  let v3BackgroundSweep: Promise<void> | null = null;
  let v3BackgroundAbort: AbortController | null = null;
  let v3DeadlineTimer: ReturnType<typeof setTimeout> | null = null;
  let v3DeadlineSweep: Promise<void> | null = null;
  let v3DeadlineAbort: AbortController | null = null;
  let v3Stopped = true;
  let v3ErrorAt: Date | null = null;
  let v3DeadlineErrorAt: Date | null = null;
  let v3BackgroundErrorAt: Date | null = null;
  let v3LastSweepStartedAt: Date | null = null;
  let v3LastSweepCompletedAt: Date | null = null;
  let v3LastDeadlineStartedAt: Date | null = null;
  let v3LastDeadlineCompletedAt: Date | null = null;
  let v3LastBackgroundStartedAt: Date | null = null;
  let v3LastBackgroundCompletedAt: Date | null = null;

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

  const scheduleV3Background = (delayMs: number): void => {
    if (!runtimeV3?.backgroundConvergence || v3Stopped) return;
    v3BackgroundTimer = setTimeout(() => {
      v3BackgroundTimer = null;
      v3LastBackgroundStartedAt = new Date();
      v3BackgroundAbort = new AbortController();
      v3BackgroundSweep = runtimeV3.backgroundConvergence!.converge({
        executorId: runtimeV3.executorId,
        signal: v3BackgroundAbort.signal,
      })
        .then((result) => {
          v3BackgroundErrorAt = null;
          v3LastBackgroundCompletedAt = new Date();
          if (result.exhausted) scheduleV3Background(0);
        })
        .catch(() => {
          v3BackgroundErrorAt = new Date();
        })
        .finally(() => {
          v3BackgroundSweep = null;
          v3BackgroundAbort = null;
          if (!v3BackgroundTimer) scheduleV3Background(runtimeV3.sweepIntervalMs);
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
        scheduleV3Background(0);
        scheduleV3Deadlines(0);
      }
    },
    stopClaims: () => {
      v3Stopped = true;
      if (v3Timer) clearTimeout(v3Timer);
      if (v3BackgroundTimer) clearTimeout(v3BackgroundTimer);
      if (v3DeadlineTimer) clearTimeout(v3DeadlineTimer);
      v3Timer = null;
      v3BackgroundTimer = null;
      v3DeadlineTimer = null;
      v3SweepAbort?.abort();
      v3BackgroundAbort?.abort();
      v3DeadlineAbort?.abort();
      scheduler.stopClaims();
    },
    shutdown: async ({ drainTimeoutMs }) => {
      v3Stopped = true;
      if (v3Timer) clearTimeout(v3Timer);
      if (v3BackgroundTimer) clearTimeout(v3BackgroundTimer);
      if (v3DeadlineTimer) clearTimeout(v3DeadlineTimer);
      v3Timer = null;
      v3BackgroundTimer = null;
      v3DeadlineTimer = null;
      v3SweepAbort?.abort();
      v3BackgroundAbort?.abort();
      v3DeadlineAbort?.abort();
      await Promise.all([
        v3Sweep,
        v3BackgroundSweep,
        v3DeadlineSweep,
        scheduler.shutdown({ drainTimeoutMs }),
      ]);
    },
    snapshot: () => {
      const snapshot = scheduler.snapshot();
      const v3Alive = !runtimeV3 || !v3Stopped;
      const v3StartedAt = runtimeV3
        ? runtimeV3.backgroundConvergence
          ? earlierDate(
            earlierDate(v3LastSweepStartedAt, v3LastDeadlineStartedAt),
            v3LastBackgroundStartedAt,
          )
          : earlierDate(v3LastSweepStartedAt, v3LastDeadlineStartedAt)
        : null;
      const v3CompletedAt = runtimeV3
        ? runtimeV3.backgroundConvergence
          ? earlierDate(
            earlierDate(v3LastSweepCompletedAt, v3LastDeadlineCompletedAt),
            v3LastBackgroundCompletedAt,
          )
          : earlierDate(v3LastSweepCompletedAt, v3LastDeadlineCompletedAt)
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
        claimLoopErrorAt: v3ErrorAt ?? v3DeadlineErrorAt ?? v3BackgroundErrorAt
          ?? snapshot.claimLoopErrorAt,
        activeCount: snapshot.activeCount,
      };
    },
  };
}

function earlierDate(left: Date | null, right: Date | null): Date | null {
  if (!left || !right) return null;
  return left.getTime() <= right.getTime() ? left : right;
}
