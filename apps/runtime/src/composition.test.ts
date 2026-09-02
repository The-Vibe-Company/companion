import { describe, expect, it, vi } from "vitest";

import type { RuntimeApplicationScheduler, RuntimeApplicationStore } from "./application";
import { composeRuntimeService } from "./composition";
import type { RuntimeServiceConfig } from "./config";

const baseConfig = {
  databaseUrl: "postgres://runtime:secret@127.0.0.1/companion",
  databaseRole: "runtime",
  boxApiBase: "https://ascii.dev/api/box/v1",
  boxTtlSeconds: 21_600,
  executorId: "11111111-1111-4111-8111-111111111111",
  concurrency: 8,
  sweepIntervalMs: 2_000,
  leaseSeconds: 30,
  renewIntervalMs: 10_000,
  listenHost: "127.0.0.1",
  listenPort: 0,
  desktopMaxSkewSeconds: 30,
  shutdownDrainMs: 25_000,
  releaseId: "production-2026-08-17.3",
  directTransport: "off" as const,
} as const;

function dependencies(config: RuntimeServiceConfig) {
  const store: RuntimeApplicationStore = {
    ping: vi.fn(async () => undefined),
    gateStatus: vi.fn(async () => ({ enabled: false, gateEpoch: 1n, updatedAt: new Date() })),
    disable: vi.fn(async () => ({ enabled: false, gateEpoch: 1n, updatedAt: new Date() })),
  };
  const scheduler: RuntimeApplicationScheduler = {
    start: vi.fn(async () => undefined),
    stopClaims: vi.fn(),
    shutdown: vi.fn(async () => undefined),
    snapshot: () => ({
      claimLoopAlive: true,
      fatal: false,
      lastSweepStartedAt: new Date(),
      lastSweepCompletedAt: new Date(),
      claimLoopErrorAt: null,
      activeCount: 0,
    }),
  };
  return { config, store, scheduler, closeResources: vi.fn(async () => undefined) };
}

describe("runtime service composition seam", () => {
  it("requires desktop reauthorization for an enabled runtime", () => {
    const config: RuntimeServiceConfig = {
      ...baseConfig,
      companionsEnabled: true,
      boxApiKey: "box-key",
      masterKey: Buffer.alloc(32),
      desktopHmacSecret: Buffer.alloc(32),
      apiUrl: "http://127.0.0.1:3001",
    };
    expect(() => composeRuntimeService(dependencies(config))).toThrow(
      "enabled runtime requires desktop authorization and replay adapters",
    );
  });

  it("composes the disabled kill-switch process without Box or desktop dependencies", async () => {
    const config: RuntimeServiceConfig = {
      ...baseConfig,
      companionsEnabled: false,
      boxApiKey: null,
      masterKey: null,
      desktopHmacSecret: null,
      apiUrl: null,
    };
    const input = dependencies(config);
    const service = composeRuntimeService(input);
    await service.application.start();
    expect(input.store.disable).toHaveBeenCalledOnce();
    expect(input.scheduler.start).toHaveBeenCalledOnce();
    await service.application.stop();
    await service.application.stop();
    expect(input.closeResources).toHaveBeenCalledOnce();
  });
});
