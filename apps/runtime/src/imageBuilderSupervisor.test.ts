/* oxlint-disable anti-slop/no-known-value-widening, anti-slop/no-unknown-parameters, anti-slop/no-unsafe-dictionary-type, anti-slop/require-safety-comment-for-type-assertion -- Hand-written fakes match the used surface exactly. */
import { describe, expect, it, vi } from "vitest";
import type { RuntimeProcessLog } from "@companion/companion-runtime/runtime-support";

import { superviseImageBuilder } from "./imageBuilderSupervisor";

function silentLog(): RuntimeProcessLog {
  return { error() {}, warn() {}, info() {} };
}

describe("image builder supervisor", () => {
  it("reports the loop alive while running and dead once it exits", async () => {
    const controller = new AbortController();
    const supervisor = superviseImageBuilder({
      worker: {
        run: (signal) => new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve(), { once: true });
        }),
      },
      registry: { getByDigest: async () => null },
      digest: "digest-1",
      log: silentLog(),
      sleep: (_ms, s) => new Promise<void>((resolve) => {
        if (s.aborted) { resolve(); return; }
        s.addEventListener("abort", () => resolve(), { once: true });
      }),
    });

    const run = supervisor.run(controller.signal);
    expect(supervisor.snapshot().loopAlive).toBe(true);
    controller.abort();
    await run;
    expect(supervisor.snapshot().loopAlive).toBe(false);
  });

  it("marks the loop dead when the worker run crashes", async () => {
    const controller = new AbortController();
    const supervisor = superviseImageBuilder({
      worker: { run: async () => { throw new Error("builder exploded"); } },
      registry: { getByDigest: async () => null },
      digest: "digest-1",
      log: silentLog(),
      sleep: (_ms, s) => new Promise<void>((resolve) => {
        if (s.aborted) { resolve(); return; }
        s.addEventListener("abort", () => resolve(), { once: true });
      }),
    });

    // The run resolves (never rejects) but liveness reflects the crash even though the outer signal
    // was never aborted — the poll stops on the worker's exit, not only on shutdown.
    await supervisor.run(controller.signal);
    expect(supervisor.snapshot().loopAlive).toBe(false);
  });

  it("caches the polled registry status and counts cold fallbacks", async () => {
    const controller = new AbortController();
    const getByDigest = vi.fn(async () => ({
      digest: "digest-1",
      status: "building" as const,
      lastErrorCode: null,
    }));
    let sleeps = 0;
    const supervisor = superviseImageBuilder({
      worker: {
        run: (signal) => new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve(), { once: true });
        }),
      },
      registry: { getByDigest: getByDigest as never },
      digest: "digest-1",
      log: silentLog(),
      sleep: async () => {
        sleeps += 1;
        // Let one poll land, then stop the loop.
        if (sleeps >= 1) controller.abort();
      },
    });

    supervisor.recordColdFallback("image_wait_exhausted");
    supervisor.recordColdFallback("image_build_failed");
    const run = supervisor.run(controller.signal);
    await run;

    expect(getByDigest).toHaveBeenCalled();
    const snapshot = supervisor.snapshot();
    expect(snapshot.status).toBe("building");
    expect(snapshot.coldFallbackCount).toBe(2);
  });
});
