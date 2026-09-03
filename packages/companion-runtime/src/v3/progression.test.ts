/**
 * Product promise: callers admit intent and request convergence without owning lease choreography.
 * Regression guarded: a blocked main Turn must never stop later background Turns from progressing.
 * Why unit-level: deterministic deferred promises expose scheduling at the public module boundary.
 * Sensitivity: serializing the lane loops or returning arbitrary failure text makes these fail.
 */
import { describe, expect, it, vi } from "vitest";

import {
  createRuntimeV3Lifecycle,
  createRuntimeV3DeadlineSweep,
  createRuntimeV3Preparation,
  createRuntimeV3Progression,
  createRuntimeV3WarmTurnAdvance,
  runtimeV3CommandWindow,
  runtimeV3PreparationRetryDelaySeconds,
  type RuntimeV3Claim,
  type RuntimeV3ConvergencePersistence,
  type RuntimeV3LifecycleClaim,
  type RuntimeV3ProgressionPersistence,
  type RuntimeV3PreparationClaim,
} from "./progression";

const acceptedTurn = {
  id: "2f883a91-92dd-4fec-b674-b7d250f81f61",
  commandId: "c86217bd-d342-475a-a739-a35d0a829bef",
  lane: "main" as const,
  state: "queued" as const,
};
const mainClaim = {
  orgId: "2d6ca5e0-1696-4692-baa8-cf722771d01e",
  companionId: "52cafaca-b95f-4b4d-bd71-d083a7a07939",
  turn: acceptedTurn,
  fence: {
    token: "3c706ec6-5caf-41fc-a009-614730726ebe",
    epoch: 4n,
    gateEpoch: 9n,
  },
};

interface ClaimQueues {
  main: Array<RuntimeV3Claim | null>;
  background: Array<RuntimeV3Claim | null>;
}

function claimFrom(queues: ClaimQueues): RuntimeV3ConvergencePersistence["claimLane"] {
  return async ({ lane }) => queues[lane].shift() ?? null;
}

function persistence(
  overrides: Partial<RuntimeV3ProgressionPersistence["convergence"]> = {},
): RuntimeV3ProgressionPersistence {
  return {
    admission: { admitTurn: vi.fn().mockResolvedValue(acceptedTurn) },
    lifecycle: {
      recordDesiredLifecycle: vi.fn().mockResolvedValue({
        intent: "archive",
        revision: 2n,
      }),
    },
    convergence: {
      sweepLane: vi.fn().mockResolvedValue(0),
      claimLane: vi.fn().mockResolvedValue(null),
      completeProgression: vi.fn().mockResolvedValue(true),
      ...overrides,
    },
  };
}

describe("Runtime v3 progression interface", () => {
  it("reserves settlement inside silent and active command deadlines", () => {
    const now = new Date("2026-09-03T00:00:00.000Z");
    expect(runtimeV3CommandWindow({
      now,
      inactivityDeadlineAt: new Date(now.getTime() + 10 * 60_000),
      absoluteDeadlineAt: new Date(now.getTime() + 2 * 60 * 60_000),
    })).toEqual({ commandMs: 8 * 60_000 + 30_000, settlementMs: 90_000 });
    expect(runtimeV3CommandWindow({
      now,
      inactivityDeadlineAt: null,
      absoluteDeadlineAt: new Date(now.getTime() + 2 * 60 * 60_000),
    })).toEqual({ commandMs: 118 * 60_000, settlementMs: 2 * 60_000 });
  });

  it("drains more than one bounded deadline batch per lane in one convergence", async () => {
    const calls = { main: 0, background: 0 };
    const sweepLane = vi.fn(async ({ lane }: { lane: "main" | "background" }) => {
      calls[lane] += 1;
      return calls[lane] === 1 ? 64 : lane === "main" ? 1 : 0;
    });
    await expect(createRuntimeV3DeadlineSweep({ sweepLane }).converge({
      executorId: "runtime-deadline-sweep",
    })).resolves.toEqual({ progressed: 129, exhausted: false });
    expect(sweepLane).toHaveBeenCalledTimes(4);
    expect(sweepLane).toHaveBeenCalledWith({ lane: "main", signal: undefined });
    expect(sweepLane).toHaveBeenCalledWith({ lane: "background", signal: undefined });
  });

  it("uses the complete jittered preparation ladder and clips it to the durable deadline", () => {
    const now = new Date("2026-09-02T00:00:00.000Z");
    expect([0, 1, 2, 3, 4, 5].map((attemptCount) =>
      runtimeV3PreparationRetryDelaySeconds({
        attemptCount,
        jitter: 0.5,
        now,
        deadlineAt: null,
      }))).toEqual([5, 15, 30, 60, 300, 300]);
    expect(runtimeV3PreparationRetryDelaySeconds({
      attemptCount: 4,
      jitter: 1,
      now,
      deadlineAt: new Date(now.getTime() + 17_000),
    })).toBe(17);
  });

  it("never redispatches a queued Turn whose admission write-intent survived takeover", async () => {
    const prompt = vi.fn();
    const advance = createRuntimeV3WarmTurnAdvance({
      persistence: {
        authorize: vi.fn().mockResolvedValue({
          boxId: "bx_23456789",
          piInvocationId: "invocation-1",
          content: "do not dispatch twice",
          cursor: 0n,
        }),
        beginAdmission: vi.fn(),
        recordAdmission: vi.fn(),
        project: vi.fn(),
      },
      pi: { prompt, read: vi.fn(), acknowledge: vi.fn() },
    });

    await expect(advance({
      ...mainClaim,
      turn: { ...mainClaim.turn, admissionStartedAt: new Date() },
    })).resolves.toMatchObject({
      kind: "interrupted",
      code: "pi_admission_outcome_unknown",
    });
    expect(prompt).not.toHaveBeenCalled();
  });

  it("preserves needs-input across unknown pages until correlated activity resumes it", async () => {
    const project = vi.fn().mockResolvedValue(true);
    const read = vi.fn()
      .mockResolvedValueOnce({
        events: [{
          sequence: 1n, invocationId: "invocation-1", attemptId: acceptedTurn.id,
          kind: "pi_event", event: { type: "future_compaction_metadata" },
        }],
        nextCursor: 1n, acknowledgedCursor: 0n, hasMore: false,
      })
      .mockResolvedValueOnce({
        events: [{
          sequence: 2n, invocationId: "invocation-1", attemptId: acceptedTurn.id,
          kind: "pi_event", event: { type: "message_start" },
        }],
        nextCursor: 2n, acknowledgedCursor: 1n, hasMore: false,
      });
    const advance = createRuntimeV3WarmTurnAdvance({
      persistence: {
        authorize: vi.fn().mockResolvedValue({
          boxId: "bx_23456789", piInvocationId: "invocation-1",
          content: "waiting", cursor: 0n,
        }),
        beginAdmission: vi.fn(), recordAdmission: vi.fn(), project,
      },
      pi: { prompt: vi.fn(), read, acknowledge: vi.fn().mockResolvedValue(2n) },
    });
    const waitingClaim = {
      ...mainClaim,
      turn: {
        ...mainClaim.turn, state: "needs_input" as const,
        absoluteDeadlineAt: new Date(Date.now() + 60_000), inactivityDeadlineAt: null,
      },
    };

    await expect(advance(waitingClaim)).resolves.toEqual({ kind: "release" });
    await expect(advance(waitingClaim)).resolves.toEqual({ kind: "release" });
    expect(project.mock.calls[0]?.[1]).toMatchObject({ needsInput: true, activity: false });
    expect(project.mock.calls[1]?.[1]).toMatchObject({ needsInput: false, activity: true });
  });

  it("archives, resumes, and permanently deletes only the persistent Box", async () => {
    const lifecycleBase = {
      executorId: "runtime-lifecycle",
      orgId: mainClaim.orgId,
      companionId: mainClaim.companionId,
      boxId: "bx_23456789",
      providerOperationId: null,
      fence: mainClaim.fence,
    };
    const claims: RuntimeV3LifecycleClaim[] = [
      { ...lifecycleBase, checkpoint: "archive_pending" },
      { ...lifecycleBase, checkpoint: "archive_requested" },
      { ...lifecycleBase, checkpoint: "waiting_archived" },
      { ...lifecycleBase, checkpoint: "wake_pending" },
      { ...lifecycleBase, checkpoint: "wake_requested" },
      { ...lifecycleBase, checkpoint: "waiting_ready" },
      { ...lifecycleBase, checkpoint: "delete_pending" },
      { ...lifecycleBase, checkpoint: "delete_requested" },
      {
        ...lifecycleBase,
        checkpoint: "waiting_deleted",
        providerOperationId: "delete-operation-1",
      },
    ];
    const observed = [
      { state: "ready" as const },
      { state: "archived" as const },
      { state: "archived" as const },
      { state: "ready" as const },
      { state: "ready" as const },
    ];
    const checkpoint = vi.fn().mockResolvedValue(true);
    const finalizeDeletion = vi.fn().mockResolvedValue(true);
    const stopExistingBox = vi.fn().mockResolvedValue(undefined);
    const resumeExistingBox = vi.fn().mockResolvedValue(undefined);
    const requestPermanentDeletion = vi.fn().mockResolvedValue({
      outcome: "accepted" as const,
      operationId: "delete-operation-1",
    });
    const pollPermanentDeletion = vi.fn().mockResolvedValue({ status: "completed" as const });
    const lifecycle = createRuntimeV3Lifecycle({
      persistence: {
        claim: vi.fn(async () => claims.shift() ?? null),
        checkpoint,
        defer: vi.fn().mockResolvedValue(true),
        finalizeDeletion,
      },
      box: {
        getStatus: vi.fn(async () => observed.shift() ?? { state: "ready" as const }),
        stopExistingBox,
        resumeExistingBox,
        requestPermanentDeletion,
        pollPermanentDeletion,
      },
    });

    await expect(lifecycle.converge({ executorId: "runtime-lifecycle" }))
      .resolves.toEqual({ progressed: 9, exhausted: false });
    expect(stopExistingBox).toHaveBeenCalledOnce();
    expect(stopExistingBox).toHaveBeenCalledWith(expect.objectContaining({
      boxId: "bx_23456789",
    }));
    expect(resumeExistingBox).toHaveBeenCalledOnce();
    expect(resumeExistingBox).toHaveBeenCalledWith(expect.objectContaining({
      boxId: "bx_23456789",
    }));
    expect(requestPermanentDeletion).toHaveBeenCalledOnce();
    expect(pollPermanentDeletion).toHaveBeenCalledOnce();
    expect(finalizeDeletion).toHaveBeenCalledOnce();
    expect(checkpoint.mock.calls.map(([, value]) => value)).toEqual([
      { next: "archive_requested" },
      { next: "waiting_archived" },
      { next: "archived" },
      { next: "wake_requested" },
      { next: "waiting_ready" },
      { next: "active" },
      { next: "delete_requested" },
      { next: "delete_dispatched" },
      { next: "waiting_deleted", providerOperationId: "delete-operation-1" },
    ]);
  });

  it("never reissues an outcome-unknown permanent deletion after takeover", async () => {
    const lifecycleBase = {
      executorId: "runtime-delete",
      orgId: mainClaim.orgId,
      companionId: mainClaim.companionId,
      boxId: "bx_23456789",
      providerOperationId: null,
      fence: mainClaim.fence,
    };
    const claims: RuntimeV3LifecycleClaim[] = [
      { ...lifecycleBase, checkpoint: "delete_requested" },
      { ...lifecycleBase, executorId: "runtime-takeover", checkpoint: "delete_dispatched" },
    ];
    const requestPermanentDeletion = vi.fn().mockRejectedValue(new Error("transport failed"));
    const finalizeDeletion = vi.fn().mockResolvedValue(true);
    const defer = vi.fn().mockResolvedValue(true);
    const lifecycle = createRuntimeV3Lifecycle({
      persistence: {
        claim: vi.fn(async () => claims.shift() ?? null),
        checkpoint: vi.fn().mockResolvedValue(true),
        defer,
        finalizeDeletion,
      },
      box: {
        getStatus: vi.fn().mockResolvedValue({ state: "ready" as const }),
        stopExistingBox: vi.fn(),
        resumeExistingBox: vi.fn(),
        requestPermanentDeletion,
        pollPermanentDeletion: vi.fn(),
      },
    });

    await lifecycle.converge({ executorId: "runtime-delete" });
    await lifecycle.converge({ executorId: "runtime-takeover" });

    expect(requestPermanentDeletion).toHaveBeenCalledOnce();
    expect(finalizeDeletion).not.toHaveBeenCalled();
    expect(defer).toHaveBeenLastCalledWith(
      expect.objectContaining({ checkpoint: "delete_dispatched" }),
      expect.objectContaining({
        error: expect.objectContaining({ code: "companion_delete_outcome_unknown" }),
      }),
      expect.any(AbortSignal),
    );
  });

  it("propagates runtime shutdown cancellation into lifecycle persistence", async () => {
    const controller = new AbortController();
    controller.abort(new Error("runtime shutdown"));
    const claim = vi.fn(async ({ signal }: { signal?: AbortSignal }) => {
      signal?.throwIfAborted();
      return null;
    });
    const lifecycle = createRuntimeV3Lifecycle({
      persistence: {
        claim,
        checkpoint: vi.fn(),
        defer: vi.fn(),
        finalizeDeletion: vi.fn(),
      },
      box: {
        getStatus: vi.fn(),
        stopExistingBox: vi.fn(),
        resumeExistingBox: vi.fn(),
        requestPermanentDeletion: vi.fn(),
        pollPermanentDeletion: vi.fn(),
      },
    });

    await expect(lifecycle.converge({
      executorId: "runtime-shutdown",
      signal: controller.signal,
    })).rejects.toThrow("runtime shutdown");
    expect(claim).toHaveBeenCalledWith(expect.objectContaining({
      signal: expect.objectContaining({ aborted: true }),
    }));
  });

  it("checkpoints canonical Box identity before readiness, staging, and Pi activation", async () => {
    const base = {
      orgId: mainClaim.orgId,
      companionId: mainClaim.companionId,
      turnId: acceptedTurn.id,
      commandId: acceptedTurn.commandId,
      boxIdempotencyKey: "11111111-1111-4111-8111-111111111111",
      createdAt: new Date("2026-09-02T00:00:00.000Z"),
      executorId: "runtime-prepare",
      authorized: true,
      actorId: "actor-1",
      modelId: "claude-test",
      persona: null,
      settingsRevision: 1n,
      skillsRevision: 1,
      providerRefs: [],
      skillRefs: [],
      mcpRefs: [],
      providerMaterial: [],
      skillMaterial: [],
      mcpMaterial: [],
      configCatalog: null,
      fence: mainClaim.fence,
    };
    const claims: RuntimeV3PreparationClaim[] = [
      { ...base, checkpoint: "pending", boxId: null },
      { ...base, checkpoint: "box_created", boxId: "bx_23456789" },
      { ...base, checkpoint: "box_ready", boxId: "bx_23456789" },
      { ...base, checkpoint: "staged", boxId: "bx_23456789" },
    ];
    const checkpoint = vi.fn().mockResolvedValue(true);
    const preparation = createRuntimeV3Preparation({
      persistence: {
        claim: vi.fn(async () => claims.shift() ?? null),
        checkpoint,
        defer: vi.fn().mockResolvedValue(true),
        reauthorize: vi.fn().mockResolvedValue(true),
        mintCredentials: vi.fn().mockResolvedValue({
          hubToken: "hub", mcpBrokerToken: null, controlToken: "control",
          expiresAt: new Date("2026-09-02T06:00:00.000Z"),
        }),
      },
      box: {
        createGenerationBox: vi.fn().mockResolvedValue({
          outcome: "created", boxId: "bx_23456789", name: "canonical",
        }),
        applyGenerationBoxSettings: vi.fn().mockResolvedValue(undefined),
        getStatus: vi.fn().mockResolvedValue({ state: "ready" }),
      },
      preparationStager: {
        stagePreparation: vi.fn().mockResolvedValue({
          diskLayoutVersion: 14,
          appliedSettingsRevision: 1n,
          appliedSkillsRevision: 1,
          skillsDigest: "a".repeat(64),
          materialExpiresAt: new Date("2026-09-02T06:00:00.000Z"),
        }),
      },
      pi: { startPiDaemon: vi.fn().mockResolvedValue({ state: "idle", invocationId: "pi-1" }) },
      now: () => new Date("2026-09-02T00:00:02.000Z"),
    });

    await expect(preparation.converge({ executorId: "runtime-prepare" }))
      .resolves.toEqual({ progressed: 4, exhausted: false });
    expect(checkpoint.mock.calls.map(([, value]) => value)).toEqual([
      { next: "box_created", boxId: "bx_23456789" },
      { next: "box_ready" },
      expect.objectContaining({
        next: "staged", diskLayoutVersion: 14,
        appliedSettingsRevision: 1n, appliedSkillsRevision: 1,
        skillsDigest: "a".repeat(64),
      }),
      { next: "prepared", piInvocationId: "pi-1" },
    ]);
  });

  it.each(["provider", "staging"] as const)(
    "does not checkpoint or defer when shutdown interrupts %s preparation",
    async (phase) => {
      const controller = new AbortController();
      const claim: RuntimeV3PreparationClaim = {
        orgId: mainClaim.orgId, companionId: mainClaim.companionId,
        turnId: acceptedTurn.id, commandId: acceptedTurn.commandId,
        checkpoint: phase === "provider" ? "pending" : "box_ready",
        boxIdempotencyKey: "11111111-1111-4111-8111-111111111111",
        boxId: phase === "provider" ? null : "bx_23456789", createdAt: new Date(),
        executorId: "runtime-shutdown-preparation", authorized: true, actorId: "actor-1",
        modelId: "claude-test", persona: null, settingsRevision: 1n, skillsRevision: 1,
        providerRefs: [], skillRefs: [], mcpRefs: [], providerMaterial: [], skillMaterial: [],
        mcpMaterial: [], configCatalog: null, fence: mainClaim.fence,
      };
      const checkpoint = vi.fn().mockResolvedValue(true);
      const defer = vi.fn().mockResolvedValue(true);
      const preparation = createRuntimeV3Preparation({
        persistence: {
          claim: vi.fn().mockResolvedValueOnce(claim), checkpoint, defer,
          reauthorize: vi.fn().mockResolvedValue(true), mintCredentials: vi.fn(),
        },
        box: {
          createGenerationBox: vi.fn(async () => {
            controller.abort(new Error("runtime shutdown"));
            return { outcome: "created" as const, boxId: "bx_23456789", name: "canonical" };
          }),
          applyGenerationBoxSettings: vi.fn(), getStatus: vi.fn(),
        },
        preparationStager: {
          stagePreparation: vi.fn(async () => {
            controller.abort(new Error("runtime shutdown"));
            return {
              diskLayoutVersion: 14, appliedSettingsRevision: 1n, appliedSkillsRevision: 1,
              skillsDigest: "a".repeat(64), materialExpiresAt: new Date(Date.now() + 60_000),
            };
          }),
        },
        pi: { startPiDaemon: vi.fn() },
      });

      await expect(preparation.converge({
        executorId: "runtime-shutdown-preparation", signal: controller.signal,
      })).resolves.toEqual({ progressed: 0, exhausted: false });
      expect(checkpoint).not.toHaveBeenCalled();
      expect(defer).not.toHaveBeenCalled();
    },
  );

  it("never contacts Box for an already-expired preparation claim", async () => {
    const createGenerationBox = vi.fn();
    const checkpoint = vi.fn();
    const defer = vi.fn();
    const now = new Date("2026-09-03T00:00:00.000Z");
    const preparation = createRuntimeV3Preparation({
      persistence: {
        claim: vi.fn().mockResolvedValueOnce({
          orgId: mainClaim.orgId, companionId: mainClaim.companionId,
          turnId: acceptedTurn.id, commandId: acceptedTurn.commandId,
          checkpoint: "pending", boxIdempotencyKey: "11111111-1111-4111-8111-111111111111",
          boxId: null, createdAt: now, deadlineAt: new Date(now.getTime() - 1),
          executorId: "runtime-expired", authorized: true, actorId: "actor-1",
          modelId: "claude-test", persona: null, settingsRevision: 1n, skillsRevision: 1,
          providerRefs: [], skillRefs: [], mcpRefs: [], providerMaterial: [], skillMaterial: [],
          mcpMaterial: [], configCatalog: null, fence: mainClaim.fence,
        } satisfies RuntimeV3PreparationClaim),
        checkpoint, defer, reauthorize: vi.fn(), mintCredentials: vi.fn(),
      },
      box: { createGenerationBox, applyGenerationBoxSettings: vi.fn(), getStatus: vi.fn() },
      preparationStager: { stagePreparation: vi.fn() },
      pi: { startPiDaemon: vi.fn() },
      now: () => now,
    });

    await expect(preparation.converge({ executorId: "runtime-expired" }))
      .resolves.toEqual({ progressed: 0, exhausted: false });
    expect(createGenerationBox).not.toHaveBeenCalled();
    expect(checkpoint).not.toHaveBeenCalled();
    expect(defer).not.toHaveBeenCalled();
  });

  it.each([
    ["Box create", "pending" as const, { createGenerationBox: new Error("token=provider-secret") }],
    ["Pi activation", "staged" as const, { startPiDaemon: new Error("token=provider-secret") }],
  ])("keeps the queued Turn retryable after a %s failure", async (_label, checkpoint, failure) => {
    const claim: RuntimeV3PreparationClaim = {
      orgId: mainClaim.orgId,
      companionId: mainClaim.companionId,
      turnId: acceptedTurn.id,
      commandId: acceptedTurn.commandId,
      checkpoint,
      boxIdempotencyKey: "11111111-1111-4111-8111-111111111111",
      boxId: checkpoint === "pending" ? null : "bx_23456789",
      createdAt: new Date(),
      executorId: "runtime-fault",
      authorized: true,
      actorId: "actor-1",
      modelId: "claude-test",
      persona: null,
      settingsRevision: 1n,
      skillsRevision: 1,
      providerRefs: [], skillRefs: [], mcpRefs: [],
      providerMaterial: [], skillMaterial: [], mcpMaterial: [], configCatalog: null,
      fence: mainClaim.fence,
    };
    const defer = vi.fn().mockResolvedValue(true);
    const preparation = createRuntimeV3Preparation({
      persistence: {
        claim: vi.fn().mockResolvedValueOnce(claim),
        checkpoint: vi.fn().mockResolvedValue(true),
        defer,
        reauthorize: vi.fn().mockResolvedValue(true),
        mintCredentials: vi.fn().mockResolvedValue(null),
      },
      box: {
        createGenerationBox: "createGenerationBox" in failure
          ? vi.fn().mockRejectedValue(failure.createGenerationBox)
          : vi.fn(),
        applyGenerationBoxSettings: vi.fn(),
        getStatus: vi.fn(),
      },
      preparationStager: { stagePreparation: vi.fn() },
      pi: {
        startPiDaemon: "startPiDaemon" in failure
          ? vi.fn().mockRejectedValue(failure.startPiDaemon)
          : vi.fn(),
      },
      jitter: () => 0.5,
    });

    await preparation.converge({ executorId: "runtime-fault" });
    const deferred = defer.mock.calls[0]?.[1];
    expect(deferred).toMatchObject({
      delaySeconds: 5,
      error: { code: "companion_prepare_failed", action: "retry" },
    });
    expect(JSON.stringify(deferred)).not.toContain("provider-secret");
  });

  it("admits work without exposing persistence choreography", async () => {
    const store = persistence();
    const progression = createRuntimeV3Progression({
      persistence: store,
      advance: async () => ({ kind: "release" }),
    });

    await expect(progression.admit({
      orgId: "2d6ca5e0-1696-4692-baa8-cf722771d01e",
      companionId: "52cafaca-b95f-4b4d-bd71-d083a7a07939",
      actorId: "member-1",
      clientMessageId: "c86217bd-d342-475a-a739-a35d0a829bef",
      messageEventId: "msg:c86217bd-d342-475a-a739-a35d0a829bef",
      lane: "main",
    })).resolves.toEqual(acceptedTurn);

    expect(Object.keys(progression).sort()).toEqual(["admit", "converge", "desire"]);
  });

  it("accepts only the bounded desired lifecycle intents", async () => {
    const store = persistence();
    const progression = createRuntimeV3Progression({
      persistence: store,
      advance: async () => ({ kind: "release" }),
    });

    await expect(progression.desire({
      orgId: "2d6ca5e0-1696-4692-baa8-cf722771d01e",
      companionId: "52cafaca-b95f-4b4d-bd71-d083a7a07939",
      actorId: "member-1",
      requestId: "6cfebf1f-6d2f-470a-aa89-d6deca17063e",
      intent: "archive",
    })).resolves.toEqual({ intent: "archive", revision: 2n });
  });

  it("owns autonomous claim and settlement while advancing queued facts", async () => {
    const advance = vi.fn().mockResolvedValue({ kind: "release" as const });
    const claims: ClaimQueues = {
      main: [mainClaim, null],
      background: [null],
    };
    const store = persistence({
      claimLane: vi.fn(claimFrom(claims)),
    });
    const progression = createRuntimeV3Progression({ persistence: store, advance });

    await expect(progression.converge({ executorId: "runtime-1" }))
      .resolves.toEqual({ progressed: 1, exhausted: false });
    expect(advance).toHaveBeenCalledWith(mainClaim);
    expect(store.convergence.completeProgression).toHaveBeenCalledWith(
      mainClaim,
      { kind: "release" },
    );
  });

  it("hands an ordinary shutdown lease to takeover without stale settlement", async () => {
    const controller = new AbortController();
    const claims: ClaimQueues = { main: [mainClaim], background: [null] };
    const store = persistence({ claimLane: vi.fn(claimFrom(claims)) });
    const progression = createRuntimeV3Progression({
      persistence: store,
      advance: vi.fn(async () => {
        controller.abort(new Error("runtime shutdown"));
        return { kind: "succeeded" as const };
      }),
    });

    await expect(progression.converge({
      executorId: "runtime-shutdown",
      signal: controller.signal,
    })).resolves.toEqual({ progressed: 0, exhausted: false });
    expect(store.convergence.completeProgression).not.toHaveBeenCalled();
  });

  it("advances main and background claims independently", async () => {
    let releaseMain!: () => void;
    const mainWait = new Promise<void>((resolve) => {
      releaseMain = resolve;
    });
    const backgroundOne = {
      orgId: mainClaim.orgId,
      companionId: mainClaim.companionId,
      turn: { ...acceptedTurn, id: "17307732-d811-4eb8-af79-0ae7e7942390", lane: "background" as const },
      fence: { token: "a60fa0eb-e514-4453-94ef-d6668220fb85", epoch: 7n, gateEpoch: 9n },
    };
    const backgroundTwo = {
      ...backgroundOne,
      turn: { ...backgroundOne.turn, id: "41158351-61ee-4c41-8f5c-888d91df91e1" },
      fence: { token: "2aa20f71-0f55-4f57-82a8-561256f42da3", epoch: 8n, gateEpoch: 9n },
    };
    const completed: string[] = [];
    const claims: ClaimQueues = {
      main: [mainClaim, null],
      background: [backgroundOne, backgroundTwo, null],
    };
    const store = persistence({
      claimLane: vi.fn(claimFrom(claims)),
      completeProgression: vi.fn(async (claimed) => {
        completed.push(claimed.turn.id);
        return true;
      }),
    });
    const progression = createRuntimeV3Progression({
      persistence: store,
      advance: async (claimed) => {
        if (claimed.turn.lane === "main") await mainWait;
        return { kind: "succeeded" };
      },
    });

    const convergence = progression.converge({ executorId: "runtime-1" });
    await vi.waitFor(() => expect(completed).toEqual([
      backgroundOne.turn.id,
      backgroundTwo.turn.id,
    ]));
    releaseMain();
    await expect(convergence).resolves.toEqual({ progressed: 3, exhausted: false });
  });

  it("expurgates terminal failures before they reach persistence", async () => {
    const claims: ClaimQueues = {
      main: [mainClaim, null],
      background: [null],
    };
    const store = persistence({
      claimLane: vi.fn(claimFrom(claims)),
    });
    const progression = createRuntimeV3Progression({
      persistence: store,
      advance: async () => ({
        kind: "failed",
        code: "NOT STABLE",
        message: "provider rejected https://user:secret@example.test/path?token=secret",
        action: "retry",
      }),
    });

    await progression.converge({ executorId: "runtime-safe-errors" });
    const completion = vi.mocked(store.convergence.completeProgression).mock.calls[0]?.[1];
    expect(completion).toMatchObject({
      kind: "failed",
      error: { code: "runtime_failure", action: "retry" },
    });
    expect(JSON.stringify(completion)).not.toContain("secret");
  });

  it("keeps warm Pi admission and durable projection inside autonomous convergence", async () => {
    const claims: ClaimQueues = { main: [mainClaim, null], background: [null] };
    const store = persistence({ claimLane: vi.fn(claimFrom(claims)) });
    const warm = {
      authorize: vi.fn().mockResolvedValue({
        boxId: "bx_23456789",
        piInvocationId: "invocation-1",
        content: "Summarize the incident",
        cursor: 0n,
      }),
      beginAdmission: vi.fn().mockResolvedValue(true),
      recordAdmission: vi.fn().mockResolvedValue(true),
      project: vi.fn().mockResolvedValue(true),
    };
    const pi = {
      prompt: vi.fn().mockResolvedValue({
        outcome: "accepted" as const,
        invocationId: "invocation-1",
        initialCursor: 0n,
      }),
      read: vi.fn().mockResolvedValue({
        events: [
          {
            sequence: 1n,
            invocationId: "invocation-1",
            attemptId: acceptedTurn.id,
            kind: "pi_event",
            event: {
              type: "message_end",
              message: {
                role: "assistant",
                content: [{ type: "text", text: "The incident is resolved." }],
                stopReason: "stop",
              },
            },
          },
          {
            sequence: 2n,
            invocationId: "invocation-1",
            attemptId: acceptedTurn.id,
            kind: "pi_event",
            event: { type: "agent_settled" },
          },
        ],
        nextCursor: 2n,
        acknowledgedCursor: 0n,
        hasMore: false,
      }),
      acknowledge: vi.fn().mockResolvedValue(2n),
    };
    const progression = createRuntimeV3Progression({
      persistence: store,
      advance: createRuntimeV3WarmTurnAdvance({ persistence: warm, pi }),
    });

    await expect(progression.converge({ executorId: "runtime-warm" }))
      .resolves.toEqual({ progressed: 1, exhausted: false });
    expect(warm.recordAdmission).toHaveBeenCalledWith(mainClaim, {
      invocationId: "invocation-1",
      responseTurnId: mainClaim.turn.id,
      cursor: 0n,
    });
    expect(warm.beginAdmission.mock.invocationCallOrder[0])
      .toBeLessThan(pi.prompt.mock.invocationCallOrder[0]!);
    expect(warm.project).toHaveBeenCalledWith(mainClaim, expect.objectContaining({
      throughCursor: 2n,
      settled: true,
      activity: true,
      assistant: [{
        eventId: expect.stringMatching(/^v3:/),
        content: "The incident is resolved.",
      }],
    }), expect.any(AbortSignal));
    expect(pi.acknowledge).toHaveBeenCalledWith(expect.objectContaining({ through: 2n }));
    expect(store.convergence.completeProgression).toHaveBeenCalledWith(
      mainClaim,
      { kind: "succeeded" },
    );
  });

  it("leaves the same Turn queued when Pi refuses before admission", async () => {
    const claims: ClaimQueues = { main: [mainClaim, null], background: [null] };
    const store = persistence({ claimLane: vi.fn(claimFrom(claims)) });
    const warm = {
      authorize: vi.fn().mockResolvedValue({
        boxId: "bx_23456789",
        piInvocationId: "invocation-1",
        content: "Wait until compaction finishes",
        cursor: 0n,
      }),
      beginAdmission: vi.fn().mockResolvedValue(true),
      recordAdmission: vi.fn().mockResolvedValue(true),
      project: vi.fn().mockResolvedValue(true),
    };
    const progression = createRuntimeV3Progression({
      persistence: store,
      advance: createRuntimeV3WarmTurnAdvance({
        persistence: warm,
        pi: {
          prompt: vi.fn().mockResolvedValue({ outcome: "rejected", code: "pi_prompt_refused" }),
          read: vi.fn(),
          acknowledge: vi.fn(),
        },
      }),
    });

    await expect(progression.converge({ executorId: "runtime-compacting" }))
      .resolves.toEqual({ progressed: 1, exhausted: false });
    expect(warm.recordAdmission).not.toHaveBeenCalled();
    expect(store.convergence.completeProgression).toHaveBeenCalledWith(
      mainClaim,
      { kind: "release" },
    );
  });

  it("fails closed without contacting Pi when fenced warm authorization is unavailable", async () => {
    const claims: ClaimQueues = { main: [mainClaim, null], background: [null] };
    const store = persistence({ claimLane: vi.fn(claimFrom(claims)) });
    const warm = {
      authorize: vi.fn().mockResolvedValue(null),
      beginAdmission: vi.fn().mockResolvedValue(true),
      recordAdmission: vi.fn().mockResolvedValue(true),
      project: vi.fn().mockResolvedValue(true),
    };
    const pi = {
      prompt: vi.fn(),
      read: vi.fn(),
      acknowledge: vi.fn(),
    };
    const progression = createRuntimeV3Progression({
      persistence: store,
      advance: createRuntimeV3WarmTurnAdvance({ persistence: warm, pi }),
    });

    await expect(progression.converge({ executorId: "runtime-unprepared" }))
      .resolves.toEqual({ progressed: 1, exhausted: false });
    expect(pi.prompt).not.toHaveBeenCalled();
    expect(store.convergence.completeProgression).toHaveBeenCalledWith(mainClaim, {
      kind: "failed",
      error: {
        code: "warm_turn_unauthorized",
        message: "The warm Turn is no longer authorized to run.",
        action: "none",
      },
    });
  });
});
