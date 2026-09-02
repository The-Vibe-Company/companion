import { describe, expect, it, vi } from "vitest";

import { createRuntimeSchedulerAdapter, type RuntimeKernelScheduler } from "./schedulerAdapter";

describe("runtime scheduler composition adapter", () => {
  it("passes the bounded drain to the kernel and maps only safe health fields", async () => {
    const now = new Date("2027-01-01T00:00:00.000Z");
    const scheduler: RuntimeKernelScheduler = {
      start: vi.fn(),
      stopClaims: vi.fn(),
      shutdown: vi.fn(async () => undefined),
      snapshot: () => ({
        claimLoopAlive: true,
        acceptingClaims: true,
        claimsEnabled: true,
        gateEnabled: true,
        lastSweepStartedAt: now,
        lastSweepCompletedAt: now,
        claimLoopErrorAt: null,
        activeCount: 2,
        concurrency: 8,
        sweepIntervalMs: 2_000,
      }),
    };
    const adapter = createRuntimeSchedulerAdapter(scheduler);

    adapter.start();
    adapter.stopClaims();
    await adapter.shutdown({ drainTimeoutMs: 25_000 });

    expect(scheduler.start).toHaveBeenCalledOnce();
    expect(scheduler.stopClaims).toHaveBeenCalledOnce();
    expect(scheduler.shutdown).toHaveBeenCalledWith({ drainTimeoutMs: 25_000 });
    expect(adapter.snapshot()).toEqual({
      claimLoopAlive: true,
      fatal: false,
      lastSweepStartedAt: now,
      lastSweepCompletedAt: now,
      claimLoopErrorAt: null,
      activeCount: 2,
    });
  });

  it("keeps health stale while the Runtime v3 claim sweep is blocked", async () => {
    const kernelCompletedAt = new Date("2027-01-01T00:00:00.000Z");
    let releaseSweep!: () => void;
    const blocked = new Promise<void>((resolve) => { releaseSweep = resolve; });
    const scheduler: RuntimeKernelScheduler = {
      start: vi.fn(),
      stopClaims: vi.fn(),
      shutdown: vi.fn(async () => undefined),
      snapshot: () => ({
        claimLoopAlive: true,
        acceptingClaims: true,
        claimsEnabled: true,
        gateEnabled: true,
        lastSweepStartedAt: kernelCompletedAt,
        lastSweepCompletedAt: kernelCompletedAt,
        claimLoopErrorAt: null,
        activeCount: 0,
        concurrency: 8,
        sweepIntervalMs: 2_000,
      }),
    };
    const converge = vi.fn(async () => {
      await blocked;
      return { progressed: 0, exhausted: false };
    });
    const adapter = createRuntimeSchedulerAdapter(scheduler, {
      convergence: { converge },
      executorId: "runtime-v3-health",
      sweepIntervalMs: 2_000,
    });

    adapter.start();
    await vi.waitFor(() => expect(converge).toHaveBeenCalledOnce());
    expect(adapter.snapshot().lastSweepCompletedAt).toBeNull();

    releaseSweep();
    await vi.waitFor(() => expect(adapter.snapshot().lastSweepCompletedAt).toBeInstanceOf(Date));
    adapter.stopClaims();
    await adapter.shutdown({ drainTimeoutMs: 1_000 });
  });

  it("does not mark a rejected Runtime v3 sweep as completed", async () => {
    const kernelCompletedAt = new Date("2027-01-01T00:00:00.000Z");
    const scheduler: RuntimeKernelScheduler = {
      start: vi.fn(),
      stopClaims: vi.fn(),
      shutdown: vi.fn(async () => undefined),
      snapshot: () => ({
        claimLoopAlive: true,
        acceptingClaims: true,
        claimsEnabled: true,
        gateEnabled: true,
        lastSweepStartedAt: kernelCompletedAt,
        lastSweepCompletedAt: kernelCompletedAt,
        claimLoopErrorAt: null,
        activeCount: 0,
        concurrency: 8,
        sweepIntervalMs: 2_000,
      }),
    };
    const converge = vi.fn(async () => {
      throw new Error("redacted claim failure");
    });
    const adapter = createRuntimeSchedulerAdapter(scheduler, {
      convergence: { converge },
      executorId: "runtime-v3-error-health",
      sweepIntervalMs: 2_000,
    });

    adapter.start();
    await vi.waitFor(() => expect(adapter.snapshot().claimLoopErrorAt).toBeInstanceOf(Date));
    expect(adapter.snapshot().lastSweepCompletedAt).toBeNull();
    adapter.stopClaims();
    await adapter.shutdown({ drainTimeoutMs: 1_000 });
  });

  it("bounds a pending Runtime v3 sweep inside the shutdown drain timeout", async () => {
    vi.useFakeTimers();
    try {
      const scheduler: RuntimeKernelScheduler = {
        start: vi.fn(),
        stopClaims: vi.fn(),
        shutdown: vi.fn(async () => undefined),
        snapshot: () => ({
          claimLoopAlive: true,
          acceptingClaims: true,
          claimsEnabled: true,
          gateEnabled: true,
          lastSweepStartedAt: null,
          lastSweepCompletedAt: null,
          claimLoopErrorAt: null,
          activeCount: 0,
          concurrency: 8,
          sweepIntervalMs: 2_000,
        }),
      };
      const converge = vi.fn(async () => await new Promise<never>(() => undefined));
      const adapter = createRuntimeSchedulerAdapter(scheduler, {
        convergence: { converge },
        executorId: "runtime-v3-shutdown",
        sweepIntervalMs: 2_000,
      });

      adapter.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(converge).toHaveBeenCalledOnce();

      let stopped = false;
      const shutdown = adapter.shutdown({ drainTimeoutMs: 25 }).then(() => { stopped = true; });
      await Promise.resolve();
      expect(scheduler.shutdown).toHaveBeenCalledWith({ drainTimeoutMs: 25 });
      expect(stopped).toBe(false);

      await vi.advanceTimersByTimeAsync(25);
      await shutdown;
      expect(stopped).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
