import type { RuntimeV3Convergence } from "@companion/companion-runtime/v3/internal";

import type { RuntimeApplicationScheduler } from "./application";

interface RuntimeV3SchedulerBaseOptions {
  executorId: string;
  sweepIntervalMs: number;
}

export type RuntimeV3SchedulerOptions = RuntimeV3SchedulerBaseOptions & (
  | {
    claimsEnabled: false;
  }
  | {
    claimsEnabled: true;
    convergence: RuntimeV3Convergence;
    /** The background lane runs independently so blocked Pi work cannot retain human chat. */
    backgroundConvergence: RuntimeV3Convergence;
    /** Deadline enforcement is independent from potentially blocked Box/Pi convergence. */
    deadlineSweep: RuntimeV3Convergence;
  }
);

interface RuntimeV3Loop {
  convergence: RuntimeV3Convergence;
  repeatImmediatelyWhenExhausted: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  sweep: Promise<void> | null;
  abort: AbortController | null;
  errorAt: Date | null;
  lastStartedAt: Date | null;
  lastCompletedAt: Date | null;
}

/** Owns Runtime v3 lifecycle, main-Turn, background-Turn, and deadline convergence. */
export function createRuntimeV3Scheduler(
  options: RuntimeV3SchedulerOptions,
): RuntimeApplicationScheduler {
  const loops: RuntimeV3Loop[] = options.claimsEnabled
    ? [
      loop(options.convergence, true),
      loop(options.backgroundConvergence, true),
      loop(options.deadlineSweep, false),
    ]
    : [];
  let started = false;
  let stopped = true;
  let disabledStartedAt: Date | null = null;
  let disabledCompletedAt: Date | null = null;

  const schedule = (state: RuntimeV3Loop, delayMs: number): void => {
    if (stopped || state.timer || state.sweep) return;
    state.timer = setTimeout(() => {
      state.timer = null;
      if (stopped) return;
      state.lastStartedAt = new Date();
      state.abort = new AbortController();
      const signal = state.abort.signal;
      state.sweep = state.convergence.converge({
        executorId: options.executorId,
        signal,
      })
        .then((result) => {
          state.errorAt = null;
          state.lastCompletedAt = new Date();
          return result.exhausted && state.repeatImmediatelyWhenExhausted
            ? 0
            : options.sweepIntervalMs;
        })
        .catch(() => {
          state.errorAt = new Date();
          return options.sweepIntervalMs;
        })
        .then((nextDelayMs) => {
          state.sweep = null;
          state.abort = null;
          schedule(state, nextDelayMs);
        });
    }, delayMs);
  };

  const stop = (): void => {
    stopped = true;
    for (const state of loops) {
      if (state.timer) clearTimeout(state.timer);
      state.timer = null;
      state.abort?.abort();
    }
  };

  return {
    start: () => {
      if (started && !stopped) return;
      started = true;
      stopped = false;
      if (!options.claimsEnabled) {
        disabledStartedAt = new Date();
        disabledCompletedAt = disabledStartedAt;
        return;
      }
      for (const state of loops) schedule(state, 0);
    },
    stopClaims: stop,
    shutdown: async ({ drainTimeoutMs }) => {
      stop();
      const active = loops.flatMap((state) => state.sweep ? [state.sweep] : []);
      if (active.length > 0) {
        await settleWithin(Promise.allSettled(active), drainTimeoutMs);
      }
    },
    snapshot: () => ({
      claimLoopAlive: started && !stopped,
      fatal: false,
      lastSweepStartedAt: options.claimsEnabled
        ? leastRecent(loops.map((state) => state.lastStartedAt))
        : disabledStartedAt,
      lastSweepCompletedAt: options.claimsEnabled
        ? leastRecent(loops.map((state) => state.lastCompletedAt))
        : disabledCompletedAt,
      claimLoopErrorAt: latest(loops.map((state) => state.errorAt)),
      activeCount: loops.filter((state) => state.sweep !== null).length,
    }),
  };
}

function loop(
  convergence: RuntimeV3Convergence,
  repeatImmediatelyWhenExhausted: boolean,
): RuntimeV3Loop {
  return {
    convergence,
    repeatImmediatelyWhenExhausted,
    timer: null,
    sweep: null,
    abort: null,
    errorAt: null,
    lastStartedAt: null,
    lastCompletedAt: null,
  };
}

function leastRecent(values: Array<Date | null>): Date | null {
  if (values.some((value) => value === null)) return null;
  return values.reduce<Date | null>((least, value) => {
    if (!value) return null;
    if (!least || value.getTime() < least.getTime()) return value;
    return least;
  }, null);
}

function latest(values: Array<Date | null>): Date | null {
  return values.reduce<Date | null>((mostRecent, value) => {
    if (!value) return mostRecent;
    if (!mostRecent || value.getTime() > mostRecent.getTime()) return value;
    return mostRecent;
  }, null);
}

async function settleWithin(settlement: Promise<unknown>, timeoutMs: number): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  await Promise.race([
    settlement,
    new Promise<void>((resolve) => {
      timeout = setTimeout(resolve, timeoutMs);
    }),
  ]);
  if (timeout) clearTimeout(timeout);
}
