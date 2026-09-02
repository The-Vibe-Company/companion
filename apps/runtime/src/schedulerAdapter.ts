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
  let v3Stopped = true;
  let v3ErrorAt: Date | null = null;

  const scheduleV3 = (delayMs: number): void => {
    if (!runtimeV3 || v3Stopped) return;
    v3Timer = setTimeout(() => {
      v3Timer = null;
      v3SweepAbort = new AbortController();
      v3Sweep = runtimeV3.convergence.converge({
        executorId: runtimeV3.executorId,
        signal: v3SweepAbort.signal,
      })
        .then((result) => {
          v3ErrorAt = null;
          if (result.exhausted) scheduleV3(0);
        })
        .catch(() => {
          v3ErrorAt = new Date();
        })
        .finally(() => {
          v3Sweep = null;
          v3SweepAbort = null;
          if (!v3Timer) scheduleV3(runtimeV3.sweepIntervalMs);
        });
    }, delayMs);
  };

  return {
    start: () => {
      scheduler.start();
      if (runtimeV3) {
        v3Stopped = false;
        scheduleV3(0);
      }
    },
    stopClaims: () => {
      v3Stopped = true;
      if (v3Timer) clearTimeout(v3Timer);
      v3Timer = null;
      v3SweepAbort?.abort();
      scheduler.stopClaims();
    },
    shutdown: async ({ drainTimeoutMs }) => {
      v3Stopped = true;
      if (v3Timer) clearTimeout(v3Timer);
      v3Timer = null;
      v3SweepAbort?.abort();
      await Promise.all([
        v3Sweep,
        scheduler.shutdown({ drainTimeoutMs }),
      ]);
    },
    snapshot: () => {
      const snapshot = scheduler.snapshot();
      return {
        claimLoopAlive: snapshot.claimLoopAlive,
        // RuntimeScheduler contains no terminal loop state: sweep errors are recoverable and carry
        // their timestamp. A process-level fatal error rejects startup instead of reaching here.
        fatal: false,
        lastSweepStartedAt: snapshot.lastSweepStartedAt,
        lastSweepCompletedAt: snapshot.lastSweepCompletedAt,
        claimLoopErrorAt: v3ErrorAt ?? snapshot.claimLoopErrorAt,
        activeCount: snapshot.activeCount,
      };
    },
  };
}
