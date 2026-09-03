/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- Lifecycle fixtures are hand-written fakes matching the used client surface exactly. */
import { describe, expect, it, vi } from "vitest";

import { BoxRuntimeAdapterError, type BoxRuntimeLifecycleClient } from "./boxMaintenanceClient";
import { BoxRuntimeProviderError } from "./boxCompanionRuntime";
import {
  bakeCompanionRuntimeImageOnce,
  deleteCompanionRuntimeBakerBox,
} from "./companionRuntimeBaker";
import { companionPiLayoutIdentity } from "./companionRuntimeImage";

const identity = companionPiLayoutIdentity({
  layoutVersion: 14,
  packages: ["npm:pi-mcp-adapter@2.12.1"],
  qmdPackage: "@tobilu/qmd@2.8.3",
  minimumPiVersion: "0.84.2",
});

function snapshot(name: string, createdAt = "2026-08-19T00:00:00.000Z") {
  return {
    listAllBoxes: vi.fn(async () => []),
    name,
    status: "ready" as const,
    sourceBoxId: "bx_23456789",
    createdAt,
  };
}

function lifecycle(overrides: Partial<BoxRuntimeLifecycleClient> = {}): BoxRuntimeLifecycleClient {
  const deletionOperation = {
    id: "bdop_00000000000000000000000000000001",
    targetId: "bx_23456789",
    status: "pending" as const,
    attemptCount: 1,
    requestedAt: "2026-08-23T00:00:00.000Z",
    completedAt: null,
  };
  return {
    getNamedSnapshot: vi.fn(async () => null),
    listNamedSnapshots: vi.fn(async () => []),
    createEphemeralBox: vi.fn(async () => ({ boxId: "bx_23456789" })),
    saveNamedSnapshot: vi.fn(async () => snapshot(identity.imageName)),
    deleteNamedSnapshot: vi.fn(async () => undefined),
    requestPermanentDeletion: vi.fn(async () => ({
      outcome: "accepted" as const,
      operation: deletionOperation,
    })),
    deletePermanentlyAndWait: vi.fn(async () => ({ outcome: "already_deleted", boxId: "bx_23456789" })),
    ...overrides,
  } as BoxRuntimeLifecycleClient;
}

function runtime(overrides: Partial<Parameters<typeof bakeCompanionRuntimeImageOnce>[0]["runtime"]> = {}) {
  return {
    existingBoxStatus: async () => ({ boxId: "bx_23456789", state: "ready" as const }),
    refreshPiLayout: async () => ({ boxId: "bx_23456789", applied: "base" as const }),
    refreshTtl: async () => undefined,
    ...overrides,
  };
}

const bundledSkill = {
  slug: "companion",
  version: "1.0.0",
  checksum: `sha256:${"1".repeat(64)}`,
  archive: Buffer.from("bundled"),
};

function providerError(status: number): BoxRuntimeProviderError {
  return new BoxRuntimeProviderError("The Box command was not ready", status);
}

describe("bakeCompanionRuntimeImageOnce", () => {
  it("reuses a ready named snapshot without creating a baker Box", async () => {
    const client = lifecycle({
      getNamedSnapshot: vi.fn(async () => snapshot(identity.imageName)),
    });
    const refreshPiLayout = vi.fn();
    const refreshTtl = vi.fn();

    await expect(bakeCompanionRuntimeImageOnce({
      identity,
      lifecycle: client,
      runtime: runtime({ refreshPiLayout, refreshTtl }),
      signal: new AbortController().signal,
    })).resolves.toEqual({
      name: identity.imageName,
      ready: true,
      baked: false,
      parentImageName: null,
    });
    expect(client.createEphemeralBox).not.toHaveBeenCalled();
    expect(refreshPiLayout).not.toHaveBeenCalled();
    expect(refreshTtl).not.toHaveBeenCalled();
  });

  it("waits out an in-flight sibling save instead of rebaking", async () => {
    const saving = { ...snapshot(identity.imageName), status: "saving" as const };
    const getNamedSnapshot = vi.fn()
      .mockResolvedValueOnce(saving)
      .mockResolvedValue(snapshot(identity.imageName));

    await expect(bakeCompanionRuntimeImageOnce({
      identity,
      lifecycle: lifecycle({ getNamedSnapshot }),
      runtime: runtime(),
      sleep: async () => undefined,
      signal: new AbortController().signal,
    })).resolves.toEqual({
      name: identity.imageName,
      ready: true,
      baked: false,
      parentImageName: null,
    });
    expect(getNamedSnapshot).toHaveBeenCalledTimes(2);
  });

  it("clones the previous companion image and retains registry-backed snapshots", async () => {
    const parent = "companion-l14-bbbbbbbbbbbb";
    const stale = "companion-l14-cccccccccccc";
    const refreshTtl = vi.fn(async () => undefined);
    const onBoxCreated = vi.fn(async () => undefined);
    const onBoxDeletionRequested = vi.fn(async () => undefined);
    const onBoxDeleted = vi.fn(async () => undefined);
    const attemptController = new AbortController();
    const client = lifecycle({
      listNamedSnapshots: vi.fn(async () => [
        snapshot(parent, "2026-08-18T00:00:00.000Z"),
        snapshot(stale, "2026-08-17T00:00:00.000Z"),
      ]),
      getNamedSnapshot: vi.fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValue(snapshot(identity.imageName, "2026-08-19T00:00:01.000Z")),
    });

    await expect(bakeCompanionRuntimeImageOnce({
      identity,
      lifecycle: client,
      runtime: runtime({ refreshTtl }),
      signal: attemptController.signal,
      onBoxCreated,
      onBoxDeletionRequested,
      onBoxDeleted,
    })).resolves.toEqual({
      name: identity.imageName,
      ready: true,
      baked: true,
      parentImageName: parent,
    });
    expect(client.createEphemeralBox).toHaveBeenCalledWith(expect.objectContaining({
      from: parent,
      noEnv: true,
      ttlSeconds: 300,
    }));
    expect(refreshTtl).toHaveBeenCalledWith(expect.objectContaining({
      boxId: "bx_23456789",
      ttlSeconds: 3_600,
    }));
    expect(client.deleteNamedSnapshot).not.toHaveBeenCalled();
    expect(onBoxCreated).toHaveBeenCalledWith({
      boxId: "bx_23456789",
      parentImageName: parent,
    });
    expect(onBoxDeleted).toHaveBeenCalledWith({ boxId: "bx_23456789" });
    expect(onBoxDeletionRequested).toHaveBeenCalledWith({
      boxId: "bx_23456789",
      operationId: "bdop_00000000000000000000000000000001",
    });
    expect(client.deletePermanentlyAndWait).toHaveBeenCalledWith(expect.objectContaining({
      boxId: "bx_23456789",
    }));
    const cleanupInput = vi.mocked(client.deletePermanentlyAndWait).mock.calls[0]?.[0];
    expect(cleanupInput?.signal).not.toBe(attemptController.signal);
    expect(cleanupInput?.signal?.aborted).toBe(false);
  });

  it("checkpoints the created Box before any follow-up lifecycle or command work", async () => {
    const events: string[] = [];
    const getNamedSnapshot = vi.fn()
      .mockImplementationOnce(async () => null)
      .mockResolvedValue(snapshot(identity.imageName));
    const client = lifecycle({
      getNamedSnapshot,
      createEphemeralBox: vi.fn(async () => {
        events.push("created");
        return { boxId: "bx_23456789" };
      }),
    });
    const onBoxCreated = vi.fn(async () => {
      events.push("checkpointed");
    });
    const refreshTtl = vi.fn(async () => {
      events.push("ttl");
    });
    const existingBoxStatus = vi.fn(async () => {
      events.push("status");
      return { boxId: "bx_23456789", state: "ready" as const };
    });
    const refreshPiLayout = vi.fn(async () => {
      events.push("layout");
      return { boxId: "bx_23456789", applied: "base" as const };
    });

    await expect(bakeCompanionRuntimeImageOnce({
      identity,
      lifecycle: client,
      runtime: runtime({ existingBoxStatus, refreshTtl, refreshPiLayout }),
      onBoxCreated,
      signal: new AbortController().signal,
    })).resolves.toMatchObject({ ready: true, baked: true });

    expect(events.slice(0, 5)).toEqual([
      "created",
      "checkpointed",
      "ttl",
      "status",
      "layout",
    ]);
    expect(onBoxCreated).toHaveBeenCalledWith({
      boxId: "bx_23456789",
      parentImageName: null,
    });
    expect(client.deletePermanentlyAndWait).toHaveBeenCalledWith(expect.objectContaining({
      boxId: "bx_23456789",
    }));
  });

  it("retries only an immediate post-create 409 with bounded exponential backoff", async () => {
    const sleeps: number[] = [];
    const getNamedSnapshot = vi.fn()
      .mockImplementationOnce(async () => null)
      .mockResolvedValue(snapshot(identity.imageName));
    const refreshPiLayout = vi.fn()
      .mockRejectedValueOnce(providerError(409))
      .mockRejectedValueOnce(providerError(409))
      .mockResolvedValue({ boxId: "bx_23456789", applied: "base" as const });

    await expect(bakeCompanionRuntimeImageOnce({
      identity,
      lifecycle: lifecycle({ getNamedSnapshot }),
      runtime: runtime({ refreshPiLayout }),
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      signal: new AbortController().signal,
    })).resolves.toEqual({
      name: identity.imageName,
      ready: true,
      baked: true,
      parentImageName: null,
    });

    expect(refreshPiLayout).toHaveBeenCalledTimes(3);
    expect(sleeps).toEqual([1_000, 2_000]);
  });

  it("fails fast for a non-409 layout error and does not retry it", async () => {
    const failure = providerError(500);
    const sleep = vi.fn(async () => undefined);
    const refreshPiLayout = vi.fn().mockRejectedValue(failure);

    await expect(bakeCompanionRuntimeImageOnce({
      identity,
      lifecycle: lifecycle(),
      runtime: runtime({ refreshPiLayout }),
      sleep,
      signal: new AbortController().signal,
    })).rejects.toBe(failure);

    expect(refreshPiLayout).toHaveBeenCalledOnce();
    expect(sleep).not.toHaveBeenCalled();
  });

  it("stops readiness retries at the attempt deadline", async () => {
    let clock = 0;
    const sleeps: number[] = [];
    const refreshPiLayout = vi.fn()
      .mockRejectedValueOnce(providerError(409))
      .mockRejectedValueOnce(providerError(409));

    await expect(bakeCompanionRuntimeImageOnce({
      identity,
      lifecycle: lifecycle({
        getNamedSnapshot: vi.fn()
          .mockResolvedValueOnce(null)
          .mockResolvedValue(snapshot(identity.imageName)),
      }),
      runtime: runtime({ refreshPiLayout }),
      now: () => clock,
      deadlineAt: 1_500,
      sleep: async (ms) => {
        sleeps.push(ms);
        clock += ms;
      },
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ status: 409 });

    expect(refreshPiLayout).toHaveBeenCalledTimes(2);
    expect(sleeps).toEqual([1_000]);
  });

  it("cancels readiness backoff through the attempt signal", async () => {
    const controller = new AbortController();
    const refreshPiLayout = vi.fn().mockRejectedValue(providerError(409));
    const sleep = vi.fn(async (_ms: number, signal: AbortSignal) => {
      controller.abort(new Error("image bake cancelled"));
      signal.throwIfAborted();
    });

    await expect(bakeCompanionRuntimeImageOnce({
      identity,
      lifecycle: lifecycle(),
      runtime: runtime({ refreshPiLayout }),
      sleep,
      signal: controller.signal,
    })).rejects.toThrow("image bake cancelled");

    expect(refreshPiLayout).toHaveBeenCalledOnce();
    expect(sleep).toHaveBeenCalledWith(1_000, controller.signal);
  });

  it("falls back to an empty baker Box when the parent snapshot disappeared", async () => {
    const client = lifecycle({
      listNamedSnapshots: vi.fn(async () => [snapshot("companion-l14-bbbbbbbbbbbb")]),
      createEphemeralBox: vi.fn()
        .mockRejectedValueOnce(new BoxRuntimeAdapterError({
          stableCode: "box_not_found",
          message: "The Box provider resource was not found",
          status: 404,
          providerCode: "unknown_snapshot",
          retryable: false,
          outcomeUnknown: false,
        }))
        .mockResolvedValue({ boxId: "bx_abcdefgh" }),
      getNamedSnapshot: vi.fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValue(snapshot(identity.imageName)),
    });

    await expect(bakeCompanionRuntimeImageOnce({
      identity,
      lifecycle: client,
      runtime: runtime({ existingBoxStatus: async () => ({ boxId: "bx_abcdefgh", state: "ready" as const }) }),
      signal: new AbortController().signal,
    })).resolves.toMatchObject({ ready: true, baked: true });
    expect(client.createEphemeralBox).toHaveBeenNthCalledWith(1, expect.objectContaining({
      from: "companion-l14-bbbbbbbbbbbb",
    }));
    expect(client.createEphemeralBox).toHaveBeenNthCalledWith(2, expect.not.objectContaining({
      from: expect.anything(),
    }));
    expect(client.deletePermanentlyAndWait).toHaveBeenCalledWith(expect.objectContaining({
      boxId: "bx_abcdefgh",
    }));
  });

  it("never saves the snapshot when the bundled Skill warmup fails", async () => {
    const saveNamedSnapshot = vi.fn(async () => snapshot(identity.imageName));
    const warmupFailure = new Error("playbook did not stabilize");

    await expect(bakeCompanionRuntimeImageOnce({
      identity,
      lifecycle: lifecycle({ saveNamedSnapshot }),
      runtime: runtime({
        prepareRuntimeImage: async () => { throw warmupFailure; },
      }),
      bundledSkill,
      signal: new AbortController().signal,
    })).rejects.toBe(warmupFailure);
    expect(saveNamedSnapshot).not.toHaveBeenCalled();
    expect(lifecycle().deletePermanentlyAndWait).not.toHaveBeenCalled();
  });

  it("checks the builder fence immediately before publishing the named snapshot", async () => {
    const saveNamedSnapshot = vi.fn(async () => snapshot(identity.imageName));
    const onBeforeSnapshotPublish = vi.fn(async () => {
      throw new Error("image build lease lost");
    });

    await expect(bakeCompanionRuntimeImageOnce({
      identity,
      lifecycle: lifecycle({ saveNamedSnapshot }),
      runtime: runtime(),
      onBeforeSnapshotPublish,
      signal: new AbortController().signal,
    })).rejects.toThrow("image build lease lost");
    expect(onBeforeSnapshotPublish).toHaveBeenCalledWith({ boxId: "bx_23456789" });
    expect(saveNamedSnapshot).not.toHaveBeenCalled();
  });

  it("does not treat a named snapshot limit as an in-flight save", async () => {
    const saveNamedSnapshot = vi.fn(async () => {
      throw new BoxRuntimeAdapterError({
        stableCode: "box_conflict",
        message: "The Box request conflicted with current provider state",
        status: 409,
        providerCode: "named_snapshot_limit",
        retryable: false,
        outcomeUnknown: false,
      });
    });

    await expect(bakeCompanionRuntimeImageOnce({
      identity,
      lifecycle: lifecycle({ saveNamedSnapshot }),
      runtime: runtime(),
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ providerCode: "named_snapshot_limit" });
    expect(saveNamedSnapshot).toHaveBeenCalledOnce();
  });

  it("tolerates save-in-flight and resolves on the published snapshot", async () => {
    const saveNamedSnapshot = vi.fn(async () => {
      throw new BoxRuntimeAdapterError({
        stableCode: "box_conflict",
        message: "A snapshot save is already running",
        status: 409,
        providerCode: "save_in_progress",
        retryable: false,
        outcomeUnknown: false,
      });
    });
    const getNamedSnapshot = vi.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValue(snapshot(identity.imageName));

    await expect(bakeCompanionRuntimeImageOnce({
      identity,
      lifecycle: lifecycle({ saveNamedSnapshot, getNamedSnapshot }),
      runtime: runtime(),
      signal: new AbortController().signal,
    })).resolves.toEqual({
      name: identity.imageName,
      ready: true,
      baked: true,
      parentImageName: null,
    });
  });

  it("fails the attempt and keeps the durable pointer when baker Box cleanup fails", async () => {
    const cleanupFailure = new Error("delete blocked at deadline");
    const onCleanupError = vi.fn();
    const onBoxDeleted = vi.fn();

    await expect(bakeCompanionRuntimeImageOnce({
      identity,
      lifecycle: lifecycle({
        getNamedSnapshot: vi.fn()
          .mockResolvedValueOnce(null)
          .mockResolvedValue(snapshot(identity.imageName)),
        deletePermanentlyAndWait: vi.fn(async () => {
          throw cleanupFailure;
        }),
      }),
      runtime: runtime(),
      onCleanupError,
      onBoxDeleted,
      signal: new AbortController().signal,
    })).rejects.toBe(cleanupFailure);
    expect(onCleanupError).toHaveBeenCalledWith(cleanupFailure, "baker_box_delete");
    expect(onBoxDeleted).not.toHaveBeenCalled();
  });

  it("does not report a blocked provider deletion as completed cleanup", async () => {
    const onBoxDeleted = vi.fn();
    const blocked = {
      id: "bdop_00000000000000000000000000000001",
      targetId: "bx_23456789",
      status: "blocked" as const,
      attemptCount: 2,
      requestedAt: "2026-08-23T00:00:00.000Z",
      completedAt: null,
    };

    await expect(bakeCompanionRuntimeImageOnce({
      identity,
      lifecycle: lifecycle({
        getNamedSnapshot: vi.fn()
          .mockResolvedValueOnce(null)
          .mockResolvedValue(snapshot(identity.imageName)),
        deletePermanentlyAndWait: vi.fn(async () => ({
          outcome: "blocked" as const,
          operation: blocked,
        })),
      }),
      runtime: runtime(),
      onBoxDeleted,
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ stableCode: "box_deletion_deadline_exceeded" });
    expect(onBoxDeleted).not.toHaveBeenCalled();
  });

  it("never replays DELETE after durable intent when the accepted-operation checkpoint was lost", async () => {
    const requestPermanentDeletion = vi.fn<BoxRuntimeLifecycleClient["requestPermanentDeletion"]>();
    const client = lifecycle({
      listAllBoxes: vi.fn(async () => [{ id: "bx_23456789", state: "archiving" as const }]),
      requestPermanentDeletion,
    });

    await expect(deleteCompanionRuntimeBakerBox({
      lifecycle: client,
      boxId: "bx_23456789",
      deletionIntentRecorded: true,
      operationId: null,
      deadlineAt: Date.now() + 30_000,
      signal: new AbortController().signal,
    })).rejects.toMatchObject({
      stableCode: "box_deletion_deadline_exceeded",
      outcomeUnknown: true,
    });
    expect(requestPermanentDeletion).not.toHaveBeenCalled();
    expect(client.deletePermanentlyAndWait).not.toHaveBeenCalled();
  });

  it("uses an independent cleanup signal after the bake signal is aborted", async () => {
    const controller = new AbortController();
    const warmupFailure = new Error("warmup interrupted");
    const deletePermanentlyAndWait = vi.fn<BoxRuntimeLifecycleClient["deletePermanentlyAndWait"]>(async (input) => {
      expect(input.signal).not.toBe(controller.signal);
      expect(input.signal?.aborted).toBe(false);
      return { outcome: "already_deleted" as const, boxId: "bx_23456789" };
    });

    await expect(bakeCompanionRuntimeImageOnce({
      identity,
      lifecycle: lifecycle({
        deletePermanentlyAndWait,
      }),
      runtime: runtime({
        refreshPiLayout: async () => {
          controller.abort(warmupFailure);
          throw warmupFailure;
        },
      }),
      signal: controller.signal,
    })).rejects.toBe(warmupFailure);
    expect(deletePermanentlyAndWait).toHaveBeenCalledOnce();
  });
});
