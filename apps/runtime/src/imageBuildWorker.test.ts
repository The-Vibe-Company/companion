/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion, anti-slop/no-chained-type-assertions, anti-slop/no-unsafe-dictionary-type, anti-slop/no-known-value-widening, anti-slop/no-unknown-parameters -- Registry stubs are hand-written fakes whose shapes match the used methods exactly. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CompanionPiLayoutIdentity } from "@companion/box-runtime";
import type { RuntimeProcessLog } from "@companion/companion-runtime/runtime-support";

import { createImageBuildWorker, type ImageBuildWorkerOptions } from "./imageBuildWorker";

type BakeOnce = NonNullable<ImageBuildWorkerOptions["bakeOnce"]>;
const bakeCompanionRuntimeImageOnce = vi.fn<BakeOnce>();

const IDENTITY: CompanionPiLayoutIdentity = {
  layoutVersion: 14,
  packages: [],
  qmdPackage: "qmd",
  minimumPiVersion: "0.84.2",
  companionSkillChecksum: null,
  bootProfileRevision: 1,
  overlayRevision: 6,
  overlayMarker: "overlay",
  baseMarker: "14:base",
  fullMarker: "14:base:overlay=overlay",
  imageMarker: "14:base:overlay=overlay:skill=none:boot=1",
  imageName: "companion-l14-aaaaaaaaaaaa",
};

function capturingLog(): RuntimeProcessLog & { records: unknown[] } {
  const records: unknown[] = [];
  return {
    records,
    error(record: unknown) { records.push(record); },
    warn(record: unknown) { records.push(record); },
    info(record: unknown) { records.push(record); },
  };
}

interface RegistryCalls {
  requested: Array<{ digest: string; imageName: string }>;
  claims: Array<Record<string, unknown>>;
  buildingBoxes: Array<Record<string, unknown>>;
  clearedBoxes: Array<Record<string, unknown>>;
  deletionIntents: Array<Record<string, unknown>>;
  deletionOperations: Array<Record<string, unknown>>;
  deletionRequests: Array<Record<string, unknown>>;
  deletedBoxes: Array<Record<string, unknown>>;
  publicationAuthorizations: Array<Record<string, unknown>>;
  outcomes: Array<Record<string, unknown>>;
}

function harness(input: {
  claim?: Record<string, unknown> | null;
  outcome?: "ready" | "failed" | "lease_lost";
  deleteError?: Error;
  authorizePublication?: boolean;
  attemptBudgetMs?: number;
  visibleBoxId?: string;
} = {}): {
  options: ImageBuildWorkerOptions;
  calls: RegistryCalls;
  controller: AbortController;
  done: Promise<void>;
  log?: { records: unknown[] };
} {
  const calls: RegistryCalls = {
    requested: [],
    claims: [],
    buildingBoxes: [],
    clearedBoxes: [],
    deletionIntents: [],
    deletionOperations: [],
    deletionRequests: [],
    deletedBoxes: [],
    publicationAuthorizations: [],
    outcomes: [],
  };
  const registry = {
    async requestImage(request: { digest: string; imageName: string }) {
      calls.requested.push(request);
      return request;
    },
    async claimImageBuild(claimInput: Record<string, unknown>) {
      calls.claims.push(claimInput);
      if (input.claim === null || calls.claims.length > 1) return null;
      return input.claim ?? {
        digest: IDENTITY.imageMarker,
        imageName: IDENTITY.imageName,
        claimEpoch: 3,
        attemptCount: 1,
        buildBoxId: null,
        buildDeleteIntentRecorded: false,
        buildDeleteOperationId: null,
        recoveryOnly: false,
      };
    },
    async getByDigest() {
      return null;
    },
    async authorizeSnapshotPublication(authorization: Record<string, unknown>) {
      calls.publicationAuthorizations.push(authorization);
      return input.authorizePublication ?? true;
    },
    async markBuildingBox(box: Record<string, unknown>) {
      calls.buildingBoxes.push(box);
      return true;
    },
    async clearBuildingBox(box: Record<string, unknown>) {
      calls.clearedBoxes.push(box);
      return true;
    },
    async markBuildingBoxDeletion(operation: Record<string, unknown>) {
      calls.deletionOperations.push(operation);
      return true;
    },
    async markBuildingBoxDeletionIntent(intent: Record<string, unknown>) {
      calls.deletionIntents.push(intent);
      return true;
    },
    async recordBuildOutcome(outcome: Record<string, unknown>) {
      calls.outcomes.push(outcome);
      return input.outcome ?? "ready";
    },
  };
  const controller = new AbortController();
  // One full loop pass runs to completion; the second sleep parks on the abort signal.
  let firstSleep = true;
  const parked = new Promise<never>((_resolve, reject) => {
    controller.signal.addEventListener("abort", () => {
      reject(new Error("aborted"));
    });
  });
  const log = capturingLog();
  const options = {
    registry: registry as never,
    identity: IDENTITY,
    lifecycle: {
      async listAllBoxes() {
        return input.visibleBoxId
          ? [{ id: input.visibleBoxId, state: "ready" as const }]
          : [];
      },
      async requestPermanentDeletion(deleteInput: Record<string, unknown>) {
        calls.deletionRequests.push(deleteInput);
        return {
          outcome: "accepted" as const,
          operation: {
            id: "bdop_00000000000000000000000000000001",
            targetId: String(deleteInput.boxId),
            status: "pending" as const,
            attemptCount: 1,
            requestedAt: "2026-08-23T00:00:00.000Z",
            completedAt: null,
          },
        };
      },
      async deletePermanentlyAndWait(deleteInput: Record<string, unknown>) {
        calls.deletedBoxes.push(deleteInput);
        if (input.deleteError) throw input.deleteError;
        return { outcome: "already_deleted" as const, boxId: String(deleteInput.boxId) };
      },
    } as never,
    runtime: (() => ({})) as never,
    executorId: "executor-1",
    bakeOnce: bakeCompanionRuntimeImageOnce as never,
    log,
    pollIntervalMs: 1,
    now: () => Date.now(),
    sleep: () => {
      if (firstSleep) {
        firstSleep = false;
        return Promise.resolve();
      }
      return parked;
    },
  } as unknown as ImageBuildWorkerOptions;
  if (input.attemptBudgetMs !== undefined) options.attemptBudgetMs = input.attemptBudgetMs;
  const done = createImageBuildWorker(options).run(controller.signal)
    .catch(() => undefined);
  return { options, calls, controller, done, log };
}

describe("image build worker", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("requests its digest, claims a lease, and persists readiness", async () => {
    vi.mocked(bakeCompanionRuntimeImageOnce).mockImplementation(async (input) => {
      await input.onBoxCreated?.({
        boxId: "bx_baker01",
        parentImageName: "companion-l14-bbbbbbbbbbbb",
      });
      await input.onBeforeSnapshotPublish?.({ boxId: "bx_baker01" });
      await input.onBoxDeletionIntentRecorded?.({ boxId: "bx_baker01" });
      await input.onBoxDeletionRequested?.({
        boxId: "bx_baker01",
        operationId: "bdop_00000000000000000000000000000001",
      });
      await input.onBoxDeleted?.({ boxId: "bx_baker01" });
      return {
        name: IDENTITY.imageName,
        ready: true,
        parentImageName: "companion-l14-bbbbbbbbbbbb",
      };
    });
    const { calls, controller, done } = harness();
    await vi.waitFor(() => expect(calls.outcomes).toHaveLength(1));
    controller.abort();
    await done;

    expect(calls.requested[0]).toEqual({
      digest: IDENTITY.imageMarker,
      imageName: IDENTITY.imageName,
    });
    expect(calls.claims[0]).toEqual({
      executorId: "executor-1",
      digest: IDENTITY.imageMarker,
      imageName: IDENTITY.imageName,
    });
    expect(calls.buildingBoxes).toEqual([{
      digest: IDENTITY.imageMarker,
      claimEpoch: 3,
      buildBoxId: "bx_baker01",
    }]);
    expect(calls.publicationAuthorizations).toEqual([{
      digest: IDENTITY.imageMarker,
      claimEpoch: 3,
      buildBoxId: "bx_baker01",
    }]);
    expect(calls.clearedBoxes).toEqual([{
      digest: IDENTITY.imageMarker,
      claimEpoch: 3,
      buildBoxId: "bx_baker01",
    }]);
    expect(calls.deletionOperations).toEqual([{
      digest: IDENTITY.imageMarker,
      claimEpoch: 3,
      buildBoxId: "bx_baker01",
      operationId: "bdop_00000000000000000000000000000001",
    }]);
    expect(calls.deletionIntents).toEqual([{
      digest: IDENTITY.imageMarker,
      claimEpoch: 3,
      buildBoxId: "bx_baker01",
    }]);
    expect(calls.outcomes).toEqual([expect.objectContaining({
      digest: IDENTITY.imageMarker,
      claimEpoch: 3,
      kind: "ready",
      imageName: IDENTITY.imageName,
      parentImageName: "companion-l14-bbbbbbbbbbbb",
    })]);
  });

  it("logs the newly created Box identity when baker cleanup fails", async () => {
    vi.mocked(bakeCompanionRuntimeImageOnce).mockImplementation(async (input) => {
      await input.onBoxCreated?.({ boxId: "bx_newbaker", parentImageName: null });
      await input.onBoxDeletionIntentRecorded?.({ boxId: "bx_newbaker" });
      await input.onBoxDeletionRequested?.({
        boxId: "bx_newbaker",
        operationId: "bdop_00000000000000000000000000000001",
      });
      input.onCleanupError?.(new Error("cleanup failed"), "baker_box_delete");
      return {
        name: IDENTITY.imageName,
        ready: true,
        parentImageName: null,
      };
    });
    const { calls, controller, done, log } = harness();
    await vi.waitFor(() => expect(calls.outcomes).toHaveLength(1));
    controller.abort();
    await done;

    expect(log?.records).toContainEqual(expect.objectContaining({
      event: "runtime.image_build_cleanup_failed",
      buildBoxId: "bx_newbaker",
      buildDeleteIntentRecorded: true,
      buildDeleteOperationId: "bdop_00000000000000000000000000000001",
    }));
  });

  it("keeps image readiness independent from a cold create fallback", async () => {
    const getByDigest = vi.fn(async () => ({
      digest: IDENTITY.imageMarker,
      imageName: IDENTITY.imageName,
      status: "building" as const,
      parentImageName: null,
      buildBoxId: null,
      buildDeleteIntentRecorded: false,
      buildDeleteOperationId: null,
      attemptCount: 1,
      lastErrorCode: null,
      lastErrorMessage: null,
      leaseExpiresAt: null,
    }));
    const worker = createImageBuildWorker({
      registry: {
        async requestImage() {
          throw new Error("not used");
        },
        async claimImageBuild() {
          throw new Error("not used");
        },
        getByDigest,
      } as never,
      identity: IDENTITY,
      lifecycle: {} as never,
      runtime: () => {
        throw new Error("cold fallback must not contact runtime image builder");
      },
      executorId: "executor-1",
      bakeOnce: bakeCompanionRuntimeImageOnce as never,
      log: capturingLog(),
    });

    await expect(worker.source().availability(new AbortController().signal)).resolves.toBe("building");
    expect(getByDigest).toHaveBeenCalledOnce();
    expect(bakeCompanionRuntimeImageOnce).not.toHaveBeenCalled();
  });

  it("persists a failure instead of publishing a snapshot that never became ready", async () => {
    vi.mocked(bakeCompanionRuntimeImageOnce).mockResolvedValue({
      name: IDENTITY.imageName,
      ready: false,
      parentImageName: null,
    });
    const { calls, controller, done } = harness({ outcome: "failed" });
    await vi.waitFor(() => expect(calls.outcomes).toHaveLength(1));
    controller.abort();
    await done;

    expect(calls.outcomes).toEqual([expect.objectContaining({
      kind: "failed",
      errorCode: "image_build_failed",
    })]);
  });

  it("persists and logs an expurgated failure when the bake throws", async () => {
    vi.mocked(bakeCompanionRuntimeImageOnce).mockRejectedValue(
      new Error("provider payload https://provider.invalid/signed?token=secret-image-token"),
    );
    const { calls, controller, done, log } = harness({ outcome: "failed" });
    await vi.waitFor(() => expect(calls.outcomes).toHaveLength(1));
    controller.abort();
    await done;

    expect(calls.outcomes).toEqual([expect.objectContaining({
      digest: IDENTITY.imageMarker,
      claimEpoch: 3,
      kind: "failed",
      errorCode: "image_build_failed",
      errorMessage: "The runtime image build attempt failed.",
    })]);
    expect(JSON.stringify(log?.records)).not.toContain("secret-image-token");
  });

  it("stops waiting for an uncooperative bake at the hard attempt budget", async () => {
    vi.useFakeTimers();
    try {
      let bakeSignal: AbortSignal | undefined;
      vi.mocked(bakeCompanionRuntimeImageOnce).mockImplementation(async (input) => {
        bakeSignal = input.signal;
        return await new Promise<never>(() => undefined);
      });
      const { calls, controller, done } = harness({
        outcome: "failed",
        attemptBudgetMs: 40,
      });
      await vi.waitFor(() => expect(bakeCompanionRuntimeImageOnce).toHaveBeenCalledOnce());
      await vi.advanceTimersByTimeAsync(40);
      await vi.waitFor(() => expect(calls.outcomes).toHaveLength(1));
      controller.abort();
      await done;

      expect(bakeSignal?.aborted).toBe(true);
      expect(calls.outcomes).toEqual([expect.objectContaining({
        kind: "failed",
        errorCode: "image_build_timeout",
        errorMessage: "The runtime image build attempt exceeded its budget.",
      })]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("deletes and clears a Box left by an expired claim before baking again", async () => {
    vi.mocked(bakeCompanionRuntimeImageOnce).mockResolvedValue({
      name: IDENTITY.imageName,
      ready: true,
      parentImageName: null,
    });
    const { calls, controller, done } = harness({
      visibleBoxId: "bx_orphaned01",
      claim: {
        digest: IDENTITY.imageMarker,
        imageName: IDENTITY.imageName,
        claimEpoch: 4,
        attemptCount: 2,
        buildBoxId: "bx_orphaned01",
        buildDeleteIntentRecorded: false,
        buildDeleteOperationId: null,
        recoveryOnly: false,
      },
    });
    await vi.waitFor(() => expect(calls.outcomes).toHaveLength(1));
    controller.abort();
    await done;

    expect(calls.deletedBoxes[0]).toEqual(expect.objectContaining({ boxId: "bx_orphaned01" }));
    expect(calls.clearedBoxes[0]).toEqual({
      digest: IDENTITY.imageMarker,
      claimEpoch: 4,
      buildBoxId: "bx_orphaned01",
    });
    expect(calls.deletionOperations[0]).toEqual(expect.objectContaining({
      buildBoxId: "bx_orphaned01",
      operationId: "bdop_00000000000000000000000000000001",
    }));
    expect(bakeCompanionRuntimeImageOnce).toHaveBeenCalledOnce();
  });

  it("settles an expired terminal claim after cleanup without starting a fifth bake", async () => {
    const { calls, controller, done } = harness({
      visibleBoxId: "bx_terminal01",
      claim: {
        digest: IDENTITY.imageMarker,
        imageName: IDENTITY.imageName,
        claimEpoch: 10,
        attemptCount: 4,
        buildBoxId: "bx_terminal01",
        buildDeleteIntentRecorded: true,
        buildDeleteOperationId: "bdop_00000000000000000000000000000002",
        recoveryOnly: true,
      },
      outcome: "failed",
    });
    await vi.waitFor(() => expect(calls.outcomes).toHaveLength(1));
    controller.abort();
    await done;

    expect(calls.deletedBoxes[0]).toEqual(expect.objectContaining({ boxId: "bx_terminal01" }));
    expect(calls.deletedBoxes[0]).toEqual(expect.objectContaining({
      operationId: "bdop_00000000000000000000000000000002",
    }));
    expect(calls.deletionRequests).toEqual([]);
    expect(calls.clearedBoxes[0]).toEqual(expect.objectContaining({ buildBoxId: "bx_terminal01" }));
    expect(calls.outcomes[0]).toEqual(expect.objectContaining({
      kind: "failed",
      errorCode: "image_build_interrupted",
    }));
    expect(bakeCompanionRuntimeImageOnce).not.toHaveBeenCalled();
  });

  it("records cleanup failure without clearing the durable Box pointer", async () => {
    const { calls, controller, done } = harness({
      visibleBoxId: "bx_orphaned01",
      claim: {
        digest: IDENTITY.imageMarker,
        imageName: IDENTITY.imageName,
        claimEpoch: 4,
        attemptCount: 2,
        buildBoxId: "bx_orphaned01",
        buildDeleteIntentRecorded: false,
        buildDeleteOperationId: null,
        recoveryOnly: false,
      },
      outcome: "failed",
      deleteError: new Error("provider delete failed"),
    });
    await vi.waitFor(() => expect(calls.outcomes).toHaveLength(1));
    controller.abort();
    await done;

    expect(calls.clearedBoxes).toEqual([]);
    expect(calls.outcomes[0]).toEqual(expect.objectContaining({
      kind: "failed",
      errorMessage: "The runtime image build attempt failed.",
    }));
    expect(bakeCompanionRuntimeImageOnce).not.toHaveBeenCalled();
  });

  it("exposes one non-blocking registry readiness read to Box creation", async () => {
    const statuses = [
      { status: "ready", leaseExpiresAt: null },
      { status: "failed", leaseExpiresAt: null },
      { status: "requested", leaseExpiresAt: null },
      { status: "building", leaseExpiresAt: new Date(4_000) },
      { status: "building", leaseExpiresAt: new Date(6_000) },
      null,
    ] as const;
    let index = 0;
    const registry = {
      async requestImage() {
        throw new Error("not used");
      },
      async claimImageBuild() {
        return null;
      },
      async getByDigest() {
        const image = statuses[index];
        index += 1;
        return image ? { digest: IDENTITY.imageMarker, ...image } : null;
      },
      async recordBuildOutcome() {
        return "ready" as const;
      },
    };
    const worker = createImageBuildWorker({
      registry: registry as never,
      identity: IDENTITY,
      lifecycle: {} as never,
      runtime: () => ({}) as never,
      executorId: "executor-1",
      bakeOnce: bakeCompanionRuntimeImageOnce as never,
      log: capturingLog(),
      now: () => 5_000,
    });
    const signal = new AbortController().signal;
    await expect(worker.source().availability(signal)).resolves.toBe("ready");
    await expect(worker.source().availability(signal)).resolves.toBe("failed");
    await expect(worker.source().availability(signal)).resolves.toBe("requested");
    await expect(worker.source().availability(signal)).resolves.toBe("stale");
    await expect(worker.source().availability(signal)).resolves.toBe("building");
    await expect(worker.source().availability(signal)).resolves.toBe("missing");
    expect(index).toBe(6);
  });

  it("does not let a stale epoch reach snapshot publication", async () => {
    vi.mocked(bakeCompanionRuntimeImageOnce).mockImplementation(async (input) => {
      await input.onBoxCreated?.({ boxId: "bx_baker01", parentImageName: null });
      await input.onBeforeSnapshotPublish?.({ boxId: "bx_baker01" });
      throw new Error("snapshot publication should have been fenced");
    });
    const { calls, controller, done } = harness({
      authorizePublication: false,
      outcome: "failed",
    });
    await vi.waitFor(() => expect(calls.outcomes).toHaveLength(1));
    controller.abort();
    await done;

    expect(calls.publicationAuthorizations).toHaveLength(1);
    expect(calls.outcomes[0]).toEqual(expect.objectContaining({
      kind: "failed",
      errorMessage: "The runtime image build attempt failed.",
    }));
  });
});
