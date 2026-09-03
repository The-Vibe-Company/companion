/* oxlint-disable anti-slop/no-unknown-parameters -- describeError redacts an unknown thrown value at the builder-loop process boundary into a bounded message, mirroring boxAdapters/imageBuildWorker. */
import type { CompanionImageRegistry, RuntimeProcessLog } from "@companion/companion-runtime/runtime-support";

import { IMAGE_BUILD_POLL_INTERVAL_MS, type ImageBuildWorker } from "./imageBuildWorker";

/**
 * Read-only liveness of the registry-driven image builder, surfaced on `/healthz`. A dead loop is a
 * hard health failure (every create silently cold-installs while it stays down); a `failed` digest
 * is informational only, because creates still succeed via the loud cold-install fallback.
 */
export interface ImageBuilderHealth {
  /** True while the builder loop is running. False after it exits or crashes — a 503 contribution. */
  loopAlive: boolean;
  /** Last observed registry status for this executor's digest, or null before the first read. */
  status: string | null;
  /** Last observed registry error code for this digest, if any. Never a provider payload. */
  lastErrorCode: string | null;
  /** Monotonic count of creates that cold-installed despite a snapshot source, this process. */
  coldFallbackCount: number;
}

export interface ImageBuilderSupervisor {
  /** Runs the builder loop, tracking liveness. Resolves when the signal aborts or the loop dies. */
  run(signal: AbortSignal): Promise<void>;
  /** Records one cold-install fallback. Passed to the Box create adapter as `onColdFallback`. */
  recordColdFallback(reason: string): void;
  snapshot(): ImageBuilderHealth;
}

export interface ImageBuilderSupervisorOptions {
  worker: Pick<ImageBuildWorker, "run">;
  registry: Pick<CompanionImageRegistry, "getByDigest">;
  digest: string;
  log: RuntimeProcessLog;
  now?: () => number;
  pollIntervalMs?: number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

/**
 * Wraps the fire-and-forget builder run in a small liveness object. It never restarts the worker
 * (its internal retry/backoff is unchanged); it only makes a crashed or exited loop observable, and
 * caches the digest status on a slow poll so `/healthz` stays synchronous and cheap.
 */
export function superviseImageBuilder(
  options: ImageBuilderSupervisorOptions,
): ImageBuilderSupervisor {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const pollIntervalMs = options.pollIntervalMs ?? IMAGE_BUILD_POLL_INTERVAL_MS;
  let loopAlive = false;
  let status: string | null = null;
  let lastErrorCode: string | null = null;
  let coldFallbackCount = 0;

  async function pollStatus(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        const image = await options.registry.getByDigest(options.digest);
        status = image?.status ?? null;
        lastErrorCode = image?.lastErrorCode ?? null;
      } catch {
        // Best effort: a transient read failure must not itself flap the builder health signal.
      }
      await sleep(pollIntervalMs, signal);
    }
  }

  async function run(signal: AbortSignal): Promise<void> {
    loopAlive = true;
    // The status poll has its own stop signal so it terminates when the worker exits or crashes,
    // not only when the outer shutdown signal aborts. Otherwise a dead builder would leave the poll
    // (and this run) hanging forever instead of surfacing loopAlive=false.
    const pollAbort = new AbortController();
    const onAbort = (): void => pollAbort.abort();
    signal.addEventListener("abort", onAbort, { once: true });
    const poll = pollStatus(pollAbort.signal);
    try {
      await options.worker.run(signal);
    } catch (error) {
      if (!signal.aborted) {
        options.log.warn({
          ts: new Date(now()).toISOString(),
          event: "runtime.image_build_worker_died",
          error: describeError(error),
        });
      }
    } finally {
      loopAlive = false;
      pollAbort.abort();
      signal.removeEventListener("abort", onAbort);
      await poll;
    }
  }

  return {
    run,
    recordColdFallback(): void {
      coldFallbackCount += 1;
    },
    snapshot(): ImageBuilderHealth {
      return { loopAlive, status, lastErrorCode, coldFallbackCount };
    },
  };
}

function describeError(error: unknown): string {
  return error instanceof Error && error.message.length > 0
    ? error.message.slice(0, 500)
    : "The image build loop exited without a message.";
}

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
