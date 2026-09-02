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
});
