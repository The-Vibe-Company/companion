import { describe, expect, it, vi } from "vitest";
import type { RuntimeV3Convergence } from "@companion/companion-runtime/v3/internal";

import { createRuntimeV3Scheduler } from "./schedulerAdapter";

function idleConvergence(): RuntimeV3Convergence {
  return {
    converge: vi.fn(async () => ({ progressed: 0, exhausted: false })),
  };
}

describe("Runtime v3 scheduler", () => {
  it("starts healthy without scheduling any claim when the feature is disabled", async () => {
    vi.useFakeTimers();
    try {
      const scheduler = createRuntimeV3Scheduler({
        claimsEnabled: false,
        executorId: "runtime-v3-disabled",
        sweepIntervalMs: 2_000,
      });

      scheduler.start();
      await vi.advanceTimersByTimeAsync(10_000);

      const snapshot = scheduler.snapshot();
      expect(snapshot.claimLoopAlive).toBe(true);
      expect(snapshot.lastSweepStartedAt).toBeInstanceOf(Date);
      expect(snapshot.lastSweepCompletedAt).toEqual(snapshot.lastSweepStartedAt);
      expect(snapshot.claimLoopErrorAt).toBeNull();
      expect(snapshot.activeCount).toBe(0);

      scheduler.stopClaims();
      expect(scheduler.snapshot().claimLoopAlive).toBe(false);
      await scheduler.shutdown({ drainTimeoutMs: 25 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("runs main, background, and deadline loops without a Runtime v2 scheduler", async () => {
    vi.useFakeTimers();
    try {
      const main = idleConvergence();
      const background = idleConvergence();
      const deadlines = idleConvergence();
      const scheduler = createRuntimeV3Scheduler({
        claimsEnabled: true,
        convergence: main,
        backgroundConvergence: background,
        deadlineSweep: deadlines,
        executorId: "runtime-v3-only",
        sweepIntervalMs: 2_000,
      });

      scheduler.start();
      scheduler.start();
      await vi.advanceTimersByTimeAsync(0);

      expect(main.converge).toHaveBeenCalledOnce();
      expect(background.converge).toHaveBeenCalledOnce();
      expect(deadlines.converge).toHaveBeenCalledOnce();
      expect(main.converge).toHaveBeenCalledWith(expect.objectContaining({
        executorId: "runtime-v3-only",
        signal: expect.any(AbortSignal),
      }));
      expect(scheduler.snapshot()).toEqual({
        claimLoopAlive: true,
        fatal: false,
        lastSweepStartedAt: expect.any(Date),
        lastSweepCompletedAt: expect.any(Date),
        claimLoopErrorAt: null,
        activeCount: 0,
      });

      scheduler.stopClaims();
      await scheduler.shutdown({ drainTimeoutMs: 25 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps health stale and reports activity while one v3 claim sweep is blocked", async () => {
    let releaseMain!: () => void;
    const blocked = new Promise<void>((resolve) => { releaseMain = resolve; });
    const main: RuntimeV3Convergence = {
      converge: vi.fn(async () => {
        await blocked;
        return { progressed: 0, exhausted: false };
      }),
    };
    const scheduler = createRuntimeV3Scheduler({
      claimsEnabled: true,
      convergence: main,
      backgroundConvergence: idleConvergence(),
      deadlineSweep: idleConvergence(),
      executorId: "runtime-v3-health",
      sweepIntervalMs: 2_000,
    });

    scheduler.start();
    await vi.waitFor(() => expect(main.converge).toHaveBeenCalledOnce());
    expect(scheduler.snapshot().lastSweepCompletedAt).toBeNull();
    expect(scheduler.snapshot().activeCount).toBe(1);

    releaseMain();
    await vi.waitFor(() => expect(scheduler.snapshot().lastSweepCompletedAt).toBeInstanceOf(Date));
    expect(scheduler.snapshot().activeCount).toBe(0);
    scheduler.stopClaims();
    await scheduler.shutdown({ drainTimeoutMs: 1_000 });
  });

  it("keeps claiming other main Companions while one preparation is blocked", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const main: RuntimeV3Convergence = {
      converge: vi.fn()
        .mockImplementationOnce(async () => {
          await blocked;
          return { progressed: 0, exhausted: false };
        })
        .mockResolvedValue({ progressed: 0, exhausted: false }),
    };
    const scheduler = createRuntimeV3Scheduler({
      claimsEnabled: true,
      concurrency: 2,
      convergence: main,
      backgroundConvergence: idleConvergence(),
      deadlineSweep: idleConvergence(),
      executorId: "runtime-v3-concurrent-main",
      sweepIntervalMs: 2_000,
    });

    scheduler.start();
    await vi.waitFor(() => expect(main.converge).toHaveBeenCalledTimes(2));
    expect(scheduler.snapshot().activeCount).toBe(1);

    release();
    await vi.waitFor(() => expect(scheduler.snapshot().activeCount).toBe(0));
    scheduler.stopClaims();
    await scheduler.shutdown({ drainTimeoutMs: 1_000 });
  });

  it("keeps a rejected loop unhealthy until that same loop recovers", async () => {
    vi.useFakeTimers();
    try {
      const main = {
        converge: vi.fn()
          .mockRejectedValueOnce(new Error("redacted claim failure"))
          .mockResolvedValue({ progressed: 0, exhausted: false }),
      } satisfies RuntimeV3Convergence;
      const scheduler = createRuntimeV3Scheduler({
        claimsEnabled: true,
        convergence: main,
        backgroundConvergence: idleConvergence(),
        deadlineSweep: idleConvergence(),
        executorId: "runtime-v3-error-health",
        sweepIntervalMs: 2_000,
      });

      scheduler.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(scheduler.snapshot().claimLoopErrorAt).toBeInstanceOf(Date);
      expect(scheduler.snapshot().lastSweepCompletedAt).toBeNull();

      await vi.advanceTimersByTimeAsync(2_000);
      expect(main.converge).toHaveBeenCalledTimes(2);
      expect(scheduler.snapshot().claimLoopErrorAt).toBeNull();
      expect(scheduler.snapshot().lastSweepCompletedAt).toBeInstanceOf(Date);
      scheduler.stopClaims();
      await scheduler.shutdown({ drainTimeoutMs: 25 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("aborts active v3 I/O and joins cooperative loops during shutdown", async () => {
    vi.useFakeTimers();
    try {
      const signals: AbortSignal[] = [];
      const blocked = (): RuntimeV3Convergence => ({
        converge: vi.fn(async (input) => {
          if (input.signal) signals.push(input.signal);
          return await new Promise<{ progressed: number; exhausted: boolean }>((resolve) => {
            input.signal?.addEventListener("abort", () => {
              resolve({ progressed: 0, exhausted: false });
            }, { once: true });
          });
        }),
      });
      const scheduler = createRuntimeV3Scheduler({
        claimsEnabled: true,
        convergence: blocked(),
        backgroundConvergence: blocked(),
        deadlineSweep: blocked(),
        executorId: "runtime-v3-shutdown",
        sweepIntervalMs: 2_000,
      });

      scheduler.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(signals).toHaveLength(3);
      expect(scheduler.snapshot().activeCount).toBe(3);

      await scheduler.shutdown({ drainTimeoutMs: 25 });
      expect(signals.every((signal) => signal.aborted)).toBe(true);
      expect(scheduler.snapshot().activeCount).toBe(0);
      expect(scheduler.snapshot().claimLoopAlive).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds shutdown even when a convergence implementation ignores abort", async () => {
    vi.useFakeTimers();
    try {
      const never = new Promise<{ progressed: number; exhausted: boolean }>(() => undefined);
      const scheduler = createRuntimeV3Scheduler({
        claimsEnabled: true,
        convergence: { converge: vi.fn(async () => await never) },
        backgroundConvergence: idleConvergence(),
        deadlineSweep: idleConvergence(),
        executorId: "runtime-v3-bounded-drain",
        sweepIntervalMs: 2_000,
      });

      scheduler.start();
      await vi.advanceTimersByTimeAsync(0);
      let drained = false;
      const shutdown = scheduler.shutdown({ drainTimeoutMs: 25 }).then(() => { drained = true; });
      await vi.advanceTimersByTimeAsync(24);
      expect(drained).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await shutdown;
      expect(drained).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("sweeps deadlines while ordinary v3 convergence is blocked", async () => {
    vi.useFakeTimers();
    try {
      const main: RuntimeV3Convergence = {
        converge: vi.fn(async (input) => await new Promise<{ progressed: number; exhausted: boolean }>((resolve) => {
          input.signal?.addEventListener("abort", () => {
            resolve({ progressed: 0, exhausted: false });
          }, { once: true });
        })),
      };
      const deadlines = idleConvergence();
      const scheduler = createRuntimeV3Scheduler({
        claimsEnabled: true,
        convergence: main,
        backgroundConvergence: idleConvergence(),
        deadlineSweep: deadlines,
        executorId: "runtime-v3-independent-deadline",
        sweepIntervalMs: 2_000,
      });

      scheduler.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(main.converge).toHaveBeenCalledOnce();
      expect(deadlines.converge).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(2_000);
      expect(main.converge).toHaveBeenCalledOnce();
      expect(deadlines.converge).toHaveBeenCalledTimes(2);
      await scheduler.shutdown({ drainTimeoutMs: 25 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps main convergence advancing while background Pi work is blocked", async () => {
    vi.useFakeTimers();
    try {
      const main = idleConvergence();
      const background: RuntimeV3Convergence = {
        converge: vi.fn(async (input) => await new Promise<{ progressed: number; exhausted: boolean }>((resolve) => {
          input.signal?.addEventListener("abort", () => {
            resolve({ progressed: 0, exhausted: false });
          }, { once: true });
        })),
      };
      const scheduler = createRuntimeV3Scheduler({
        claimsEnabled: true,
        convergence: main,
        backgroundConvergence: background,
        deadlineSweep: idleConvergence(),
        executorId: "runtime-v3-independent-background",
        sweepIntervalMs: 2_000,
      });

      scheduler.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(main.converge).toHaveBeenCalledOnce();
      expect(background.converge).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(2_000);
      expect(main.converge).toHaveBeenCalledTimes(2);
      expect(background.converge).toHaveBeenCalledOnce();
      await scheduler.shutdown({ drainTimeoutMs: 25 });
    } finally {
      vi.useRealTimers();
    }
  });
});
