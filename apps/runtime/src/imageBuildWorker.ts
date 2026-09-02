/* oxlint-disable anti-slop/no-unknown-parameters -- Failure reporting receives unknown thrown values at this process boundary and redacts them into bounded messages. */
import {
  bakeCompanionRuntimeImageOnce,
  deleteCompanionRuntimeBakerBox,
  type BoxRuntimeLifecycleClient,
  type CompanionBoxRuntimeV2,
  type CompanionPiLayoutIdentity,
  type CompanionRuntimeSkill,
} from "@companion/box-runtime";
import {
  CompanionImageRegistry,
  IMAGE_BUILD_BACKOFF_MS,
} from "@companion/companion-runtime";
import type { RuntimeProcessLog } from "@companion/companion-runtime";

import type { RuntimeImageSource } from "./boxAdapters";

/** How often the builder polls for claimable work when the registry is empty. */
export const IMAGE_BUILD_POLL_INTERVAL_MS = 5_000;
/**
 * Hard ceiling for one bake attempt. Every provider call inside a bake is individually
 * bounded, but their sequence is not: this budget guarantees a wedged attempt can never
 * hold the build lease forever — the attempt fails closed and the backoff takes over.
 */
export const IMAGE_BUILD_ATTEMPT_BUDGET_MS = 40 * 60_000;
/** Independent cleanup budget; it intentionally survives an expired bake signal. */
export const IMAGE_BUILD_CLEANUP_BUDGET_MS = 2 * 60_000;

export interface ImageBuildWorkerOptions {
  registry: CompanionImageRegistry;
  identity: CompanionPiLayoutIdentity;
  lifecycle: BoxRuntimeLifecycleClient;
  runtime(): CompanionBoxRuntimeV2;
  bundledSkill?: CompanionRuntimeSkill;
  /** Injected for tests; defaults to the single-attempt provider bake. */
  bakeOnce?: typeof bakeCompanionRuntimeImageOnce;
  executorId: string;
  log: RuntimeProcessLog;
  pollIntervalMs?: number;
  attemptBudgetMs?: number;
  cleanupBudgetMs?: number;
  now?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

export interface ImageBuildWorker {
  /** Drives claimed builds until aborted. Never rejects while the signal is aborted. */
  run(signal: AbortSignal): Promise<void>;
  /** Ensures this identity's digest is requested; safe to call concurrently and repeatedly. */
  requestCurrentImage(): Promise<void>;
  source(): RuntimeImageSource;
}

/**
 * The registry-driven image builder: one leased row at a time, every transition persisted.
 * Replaces the baker's in-process infinite retry loop (docs/companion-image-pipeline.md).
 */
export function createImageBuildWorker(options: ImageBuildWorkerOptions): ImageBuildWorker {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const pollIntervalMs = options.pollIntervalMs ?? IMAGE_BUILD_POLL_INTERVAL_MS;
  const attemptBudgetMs = options.attemptBudgetMs ?? IMAGE_BUILD_ATTEMPT_BUDGET_MS;
  const cleanupBudgetMs = options.cleanupBudgetMs ?? IMAGE_BUILD_CLEANUP_BUDGET_MS;

  async function run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        await requestCurrentImage();
        const claim = await options.registry.claimImageBuild({
          executorId: options.executorId,
          digest: options.identity.imageMarker,
          imageName: options.identity.imageName,
        });
        if (!claim) {
          await sleep(pollIntervalMs, signal);
          continue;
        }
        options.log.info({
          ts: new Date(now()).toISOString(),
          event: "runtime.image_build_started",
          digest: claim.digest,
          imageName: claim.imageName,
          attempt: claim.attemptCount,
        });
        let outcome: "ready" | "failed" | "lease_lost";
        // The attempt signal is the run signal plus one hard wall-clock budget.
        const attemptController = new AbortController();
        const abortRun = () => attemptController.abort();
        signal.addEventListener("abort", abortRun, { once: true });
        const budgetTimer = setTimeout(() => {
          attemptController.abort(new Error("The image build attempt exceeded its budget."));
        }, attemptBudgetMs);
        const bake = options.bakeOnce ?? bakeCompanionRuntimeImageOnce;
        const bakeInput: Parameters<typeof bakeCompanionRuntimeImageOnce>[0] = {
          identity: options.identity,
          lifecycle: options.lifecycle,
          runtime: {
            existingBoxStatus: (input: Parameters<CompanionBoxRuntimeV2["existingBoxStatus"]>[0]) =>
              options.runtime().existingBoxStatus(input),
            refreshPiLayout: (input: Parameters<CompanionBoxRuntimeV2["refreshPiLayout"]>[0]) =>
              options.runtime().refreshPiLayout(input),
            refreshTtl: (input: Parameters<CompanionBoxRuntimeV2["refreshTtl"]>[0]) =>
              options.runtime().refreshTtl(input),
            prepareRuntimeImage: (
              input: Parameters<NonNullable<CompanionBoxRuntimeV2["prepareRuntimeImage"]>>[0],
            ) => options.runtime().prepareRuntimeImage?.(input),
          },
          signal: attemptController.signal,
          onBoxCreated: async ({ boxId }) => {
            const marked = await options.registry.markBuildingBox({
              digest: claim.digest,
              claimEpoch: claim.claimEpoch,
              buildBoxId: boxId,
            });
            if (!marked) throw new Error("The image build lease was lost after Box creation.");
          },
          onBeforeSnapshotPublish: async ({ boxId }) => {
            const authorized = await options.registry.authorizeSnapshotPublication({
              digest: claim.digest,
              claimEpoch: claim.claimEpoch,
              buildBoxId: boxId,
            });
            if (!authorized) {
              throw new Error("The image build lease was lost before snapshot publication.");
            }
          },
          onBoxDeleted: async ({ boxId }) => {
            const cleared = await options.registry.clearBuildingBox({
              digest: claim.digest,
              claimEpoch: claim.claimEpoch,
              buildBoxId: boxId,
            });
            if (!cleared) throw new Error("The image build lease was lost after Box cleanup.");
          },
          onBoxDeletionIntentRecorded: async ({ boxId }) => {
            const marked = await options.registry.markBuildingBoxDeletionIntent({
              digest: claim.digest,
              claimEpoch: claim.claimEpoch,
              buildBoxId: boxId,
            });
            if (!marked) {
              throw new Error("The image build lease was lost before Box deletion started.");
            }
          },
          onBoxDeletionRequested: async ({ boxId, operationId }) => {
            const marked = await options.registry.markBuildingBoxDeletion({
              digest: claim.digest,
              claimEpoch: claim.claimEpoch,
              buildBoxId: boxId,
              operationId,
            });
            if (!marked) {
              throw new Error("The image build lease was lost after Box deletion started.");
            }
          },
          onCleanupError: (error) => {
            options.log.warn({
              ts: new Date(now()).toISOString(),
              event: "runtime.image_build_cleanup_failed",
              digest: claim.digest,
              buildBoxId: claim.buildBoxId,
              buildDeleteOperationId: claim.buildDeleteOperationId,
              error: describeError(error),
            });
          },
        };
        try {
          if (claim.buildBoxId) {
            await cleanupClaimedBox({
              lifecycle: options.lifecycle,
              registry: options.registry,
              digest: claim.digest,
              claimEpoch: claim.claimEpoch,
              buildBoxId: claim.buildBoxId,
              buildDeleteIntentRecorded: claim.buildDeleteIntentRecorded,
              buildDeleteOperationId: claim.buildDeleteOperationId,
              cleanupBudgetMs,
              now,
            });
          }
          if (claim.recoveryOnly) {
            outcome = await options.registry.recordBuildOutcome({
              digest: claim.digest,
              claimEpoch: claim.claimEpoch,
              kind: "failed",
              errorCode: "image_build_interrupted",
              errorMessage: "The final image build attempt lost its worker before settlement.",
            });
          } else {
            if (options.bundledSkill) {
              bakeInput.bundledSkill = options.bundledSkill;
            }
            const baked = await bake(bakeInput);
            if (!baked.ready) {
              throw new Error("The runtime image snapshot did not become ready.");
            }
            outcome = await options.registry.recordBuildOutcome({
              digest: claim.digest,
              claimEpoch: claim.claimEpoch,
              kind: "ready",
              imageName: claim.imageName,
              parentImageName: baked.parentImageName,
            });
          }
        } catch (error) {
          clearTimeout(budgetTimer);
          signal.removeEventListener("abort", abortRun);
          if (signal.aborted) return;
          const timedOut = attemptController.signal.aborted && !signal.aborted;
          outcome = await options.registry.recordBuildOutcome({
            digest: claim.digest,
            claimEpoch: claim.claimEpoch,
            kind: "failed",
            errorCode: timedOut ? "image_build_timeout" : "image_build_failed",
            errorMessage: describeError(error),
          });
          options.log.warn({
            ts: new Date(now()).toISOString(),
            event: "runtime.image_build_failed",
            digest: claim.digest,
            attempt: claim.attemptCount,
            timedOut,
            retryBackoffMs: claim.attemptCount >= 4
              ? null
              : IMAGE_BUILD_BACKOFF_MS[claim.attemptCount - 1] ?? null,
            error: describeError(error),
          });
        }
        clearTimeout(budgetTimer);
        signal.removeEventListener("abort", abortRun);
        if (outcome === "ready") {
          options.log.info({
            ts: new Date(now()).toISOString(),
            event: "runtime.image_build_ready",
            digest: claim.digest,
            imageName: claim.imageName,
          });
        }
      } catch (error) {
        if (signal.aborted) return;
        options.log.warn({
          ts: new Date(now()).toISOString(),
          event: "runtime.image_build_worker_error",
          error: describeError(error),
        });
        await sleep(pollIntervalMs, signal);
      }
    }
  }

  async function requestCurrentImage(): Promise<void> {
    await options.registry.requestImage({
      digest: options.identity.imageMarker,
      imageName: options.identity.imageName,
    });
  }

  function source(): RuntimeImageSource {
    return {
      expectedName: () => options.identity.imageName,
      async availability(signal) {
        signal.throwIfAborted();
        const image = await options.registry.getByDigest(options.identity.imageMarker);
        signal.throwIfAborted();
        if (!image) return "missing";
        if (
          image.status === "building"
          && image.leaseExpiresAt !== null
          && image.leaseExpiresAt.getTime() <= now()
        ) return "stale";
        return image.status;
      },
    };
  }

  return { run, requestCurrentImage, source };
}

async function cleanupClaimedBox(input: {
  lifecycle: BoxRuntimeLifecycleClient;
  registry: CompanionImageRegistry;
  digest: string;
  claimEpoch: number;
  buildBoxId: string;
  buildDeleteIntentRecorded: boolean;
  buildDeleteOperationId: string | null;
  cleanupBudgetMs: number;
  now: () => number;
}): Promise<void> {
  const cleanupController = new AbortController();
  const cleanupTimer = setTimeout(() => {
    cleanupController.abort(new Error("The image build cleanup exceeded its budget."));
  }, input.cleanupBudgetMs);
  try {
    await deleteCompanionRuntimeBakerBox({
      lifecycle: input.lifecycle,
      boxId: input.buildBoxId,
      deletionIntentRecorded: input.buildDeleteIntentRecorded,
      operationId: input.buildDeleteOperationId,
      deadlineAt: input.now() + input.cleanupBudgetMs,
      signal: cleanupController.signal,
      onDeletionIntentRecorded: async () => {
        const marked = await input.registry.markBuildingBoxDeletionIntent({
          digest: input.digest,
          claimEpoch: input.claimEpoch,
          buildBoxId: input.buildBoxId,
        });
        if (!marked) {
          throw new Error("The image build lease was lost before Box deletion started.");
        }
      },
      onDeletionRequested: async ({ operationId }) => {
        const marked = await input.registry.markBuildingBoxDeletion({
          digest: input.digest,
          claimEpoch: input.claimEpoch,
          buildBoxId: input.buildBoxId,
          operationId,
        });
        if (!marked) {
          throw new Error("The image build lease was lost after Box deletion started.");
        }
      },
    });
    const cleared = await input.registry.clearBuildingBox({
      digest: input.digest,
      claimEpoch: input.claimEpoch,
      buildBoxId: input.buildBoxId,
    });
    if (!cleared) throw new Error("The image build lease was lost during Box reconciliation.");
  } finally {
    clearTimeout(cleanupTimer);
  }
}

function describeError(error: unknown): string {
  return error instanceof Error && error.message.length > 0
    ? error.message.slice(0, 500)
    : "The image build failed without a message.";
}

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason instanceof Error ? signal.reason : new Error("aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}
