/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-unsafe-dictionary-type, anti-slop/require-safety-comment-for-type-assertion -- Existing runtime fixtures predate the incremental anti-slop gate. */

import { describe, expect, it } from "vitest";
import { RuntimeEngine } from "./engine";
import { RuntimeStoreIndeterminateError } from "./store";
import type { OperationRuntimeClaim } from "./types";
import {
  BOX_ID,
  PI_INVOCATION_ID,
  ROUTINE_SNAPSHOT_ID,
  TURN_ID,
  MemoryRuntimeStore,
  TestClock,
  engineDependencies,
  fakePorts,
  operationAuthorization,
  operationClaim,
  attemptMaterial,
} from "./test/fixtures";

describe("runtime lifecycle operations", () => {
  it("resumes a durable Box by id without account discovery, PATCH, or adapter polling", async () => {
    const claim = operationClaim();
    const store = new MemoryRuntimeStore({
      authorization: operationAuthorization(claim, {
        boxId: BOX_ID,
        boxState: "archived",
        piState: "stopped",
        piInvocationId: null,
      }),
    });
    const ports = fakePorts(store);
    let statuses = 0;
    let resumes = 0;
    let listings = 0;
    let settings = 0;
    const statusInputs: Array<{ companionId?: string; generation?: bigint }> = [];
    ports.box.getStatus = async (input) => {
      statusInputs.push(input);
      return {
      state: (["archived", "provisioning", "ready"] as const)[Math.min(statuses++, 2)]!,
      };
    };
    ports.box.resumeExistingBox = async () => { resumes += 1; };
    ports.box.findGenerationBoxes = async () => {
      listings += 1;
      throw new Error("known Box must not list");
    };
    ports.box.applyGenerationBoxSettings = async () => { settings += 1; };

    const result = await new RuntimeEngine(engineDependencies({ store, ports })).execute(claim);

    expect(result.outcome).toBe("succeeded");
    expect({ resumes, listings, settings }).toEqual({ resumes: 1, listings: 0, settings: 0 });
    expect(statuses).toBe(3);
    expect(statusInputs).toEqual(Array.from({ length: 3 }, () => ({
      boxId: BOX_ID,
      companionId: claim.companionId,
      generation: claim.runtimeGeneration,
      signal: expect.any(AbortSignal),
    })));
  });

  it.each([null, "old-pi-invocation"])(
    "recycles Pi after staging when the previous invocation is %s",
    async (previousInvocationId) => {
      const claim = operationClaim({ checkpoint: "starting_pi", checkpointSequence: 6n });
      const store = new MemoryRuntimeStore({
        authorization: operationAuthorization(claim, {
          boxId: BOX_ID,
          boxState: "ready",
          piState: "idle",
          piInvocationId: previousInvocationId,
        }),
      });
      const ports = fakePorts(store);
      let starts = 0;
      let restarts = 0;
      let boxRestarts = 0;
      const restartDeadlines: Array<Date | undefined> = [];
      ports.pi.startPiDaemon = async () => {
        starts += 1;
        return { state: "idle", invocationId: PI_INVOCATION_ID };
      };
      ports.pi.restartPiDaemon = async (input) => {
        restarts += 1;
        restartDeadlines.push(input.deadlineAt);
        return { state: "idle", invocationId: PI_INVOCATION_ID };
      };
      ports.box.stopExistingBox = async () => { boxRestarts += 1; };

      const result = await new RuntimeEngine(engineDependencies({ store, ports })).execute(claim);

      expect(result.outcome).toBe("succeeded");
      expect(starts).toBe(0);
      expect(restarts).toBe(1);
      expect(restartDeadlines).toEqual([new Date("2026-08-16T12:03:00.000Z")]);
      expect(boxRestarts).toBe(0);
      expect(store.authorization.piInvocationId).toBe(PI_INVOCATION_ID);
    },
  );

  it("durably deletes a duplicate discovered by create recovery before attaching canonical", async () => {
    const claim = operationClaim();
    const store = new MemoryRuntimeStore({
      authorization: operationAuthorization(claim, {
        boxId: null,
        boxState: "absent",
        piState: "absent",
        piInvocationId: null,
        diskLayoutVersion: 0,
        appliedSettingsRevision: 0n,
        appliedSkillsRevision: 0,
      }),
    });
    const ports = fakePorts(store);
    const generationName = `Companion ${claim.companionId} g1`;
    const duplicateId = "bx_2345678a";
    const effects: string[] = [];
    let discoveryCalls = 0;
    ports.box.findGenerationBoxes = async () => {
      discoveryCalls += 1;
      return discoveryCalls === 1
        ? { name: generationName, canonical: null, duplicates: [] }
        : {
            name: generationName,
            canonical: { id: BOX_ID, name: generationName, state: "provisioning" },
            duplicates: [],
          };
    };
    ports.box.createGenerationBox = async () => {
      effects.push("create");
      return {
        outcome: "recovered",
        boxId: BOX_ID,
        name: generationName,
        canonical: { id: BOX_ID, name: generationName, state: "provisioning" },
        duplicates: [{ id: duplicateId, name: generationName, state: "ready" }],
      };
    };
    ports.box.requestPermanentDeletion = async ({ boxId }) => {
      effects.push(`delete:${boxId}`);
      return { outcome: "accepted", operationId: "delete-op-1" };
    };
    ports.box.pollPermanentDeletion = async ({ boxId }) => {
      effects.push(`poll:${boxId}`);
      return { status: "completed" };
    };
    ports.box.applyGenerationBoxSettings = async ({ boxId }) => {
      effects.push(`settings:${boxId}`);
    };
    const originalStage = ports.resourceStager.stageExistingBox;
    ports.resourceStager.stageExistingBox = async (input) => {
      effects.push(`stage:${input.boxId}`);
      return await originalStage(input);
    };
    const engine = new RuntimeEngine(engineDependencies({ store, ports }));

    const result = await engine.execute(claim);

    expect(result.outcome).toBe("succeeded");
    expect(effects).toEqual([
      "create",
      `delete:${duplicateId}`,
      `poll:${duplicateId}`,
      `settings:${BOX_ID}`,
      `stage:${BOX_ID}`,
    ]);
    expect(store.duplicateCleanups.get(duplicateId)).toMatchObject({
      status: "deleted",
      providerOperationId: "delete-op-1",
    });
    expect(store.authorization.boxId).toBe(BOX_ID);
    expect(store.settlements).toEqual([{ terminalStatus: "succeeded" }]);
  });

  it("finishes duplicate Box deletion after a transient provider blocked status", async () => {
    const claim = operationClaim();
    const store = new MemoryRuntimeStore({
      authorization: operationAuthorization(claim, {
        boxId: null,
        boxState: "absent",
        piState: "absent",
        piInvocationId: null,
        diskLayoutVersion: 0,
        appliedSettingsRevision: 0n,
        appliedSkillsRevision: 0,
      }),
    });
    const ports = fakePorts(store);
    const generationName = `Companion ${claim.companionId} g1`;
    const duplicateId = "bx_2345678b";
    let discoveryCalls = 0;
    let polls = 0;
    ports.box.findGenerationBoxes = async () => {
      discoveryCalls += 1;
      return discoveryCalls === 1
        ? { name: generationName, canonical: null, duplicates: [] }
        : {
            name: generationName,
            canonical: { id: BOX_ID, name: generationName, state: "provisioning" },
            duplicates: [],
          };
    };
    ports.box.createGenerationBox = async () => ({
      outcome: "recovered",
      boxId: BOX_ID,
      name: generationName,
      canonical: { id: BOX_ID, name: generationName, state: "provisioning" },
      duplicates: [{ id: duplicateId, name: generationName, state: "ready" }],
    });
    ports.box.requestPermanentDeletion = async () => ({
      outcome: "accepted",
      operationId: "delete-op-blocked",
    });
    ports.box.pollPermanentDeletion = async () => {
      polls += 1;
      return polls === 1 ? { status: "blocked" } : { status: "completed" };
    };

    const result = await new RuntimeEngine(engineDependencies({
      store,
      ports,
      clock: new TestClock(),
    })).execute(claim);

    expect(result.outcome).toBe("succeeded");
    expect(polls).toBe(2);
    expect(store.duplicateCleanups.get(duplicateId)).toMatchObject({
      status: "deleted",
      providerOperationId: "delete-op-blocked",
    });
  });

  it("keeps a previously terminal blocked duplicate cleanup non-retryable", async () => {
    const claim = operationClaim({
      checkpoint: "box_created",
      checkpointSequence: 4n,
    });
    const store = new MemoryRuntimeStore({
      authorization: operationAuthorization(claim, {
        boxId: BOX_ID,
        boxState: "provisioning",
        piState: "absent",
        piInvocationId: null,
        diskLayoutVersion: 0,
        appliedSettingsRevision: 0n,
        appliedSkillsRevision: 0,
      }),
    });
    const generationName = `Companion ${claim.companionId} g1`;
    const duplicateId = "bx_2345678e";
    store.duplicateCleanups.set(duplicateId, {
      boxId: duplicateId,
      status: "blocked",
      providerOperationId: "delete-op-old",
      checkpointSequence: 3n,
    });
    const ports = fakePorts(store);
    let polls = 0;
    ports.box.findGenerationBoxes = async () => ({
      name: generationName,
      canonical: { id: BOX_ID, name: generationName, state: "provisioning" },
      duplicates: [{ id: duplicateId, name: generationName, state: "ready" }],
    });
    ports.box.pollPermanentDeletion = async () => {
      polls += 1;
      return { status: "completed" };
    };

    const result = await new RuntimeEngine(engineDependencies({ store, ports })).execute(claim);

    expect(result.outcome).toBe("failed");
    expect(polls).toBe(0);
    expect(store.settlements[0]?.error).toMatchObject({
      code: "duplicate_box_delete_blocked",
      action: "none",
    });
  });

  it("times out a still-blocked duplicate deletion as retryable", async () => {
    const claim = operationClaim({
      coldStartDeadlineAt: new Date("2026-08-16T12:00:02.000Z"),
    });
    const store = new MemoryRuntimeStore({
      authorization: operationAuthorization(claim, {
        boxId: null,
        boxState: "absent",
        piState: "absent",
        piInvocationId: null,
        diskLayoutVersion: 0,
        appliedSettingsRevision: 0n,
        appliedSkillsRevision: 0,
      }),
    });
    const ports = fakePorts(store);
    const generationName = `Companion ${claim.companionId} g1`;
    const duplicateId = "bx_2345678f";
    let discoveryCalls = 0;
    ports.box.findGenerationBoxes = async () => {
      discoveryCalls += 1;
      return discoveryCalls === 1
        ? { name: generationName, canonical: null, duplicates: [] }
        : {
            name: generationName,
            canonical: { id: BOX_ID, name: generationName, state: "provisioning" },
            duplicates: [],
          };
    };
    ports.box.createGenerationBox = async () => ({
      outcome: "recovered",
      boxId: BOX_ID,
      name: generationName,
      canonical: { id: BOX_ID, name: generationName, state: "provisioning" },
      duplicates: [{ id: duplicateId, name: generationName, state: "ready" }],
    });
    ports.box.requestPermanentDeletion = async () => ({
      outcome: "accepted",
      operationId: "delete-op-deadline",
    });
    ports.box.pollPermanentDeletion = async () => ({ status: "blocked" });

    const result = await new RuntimeEngine(engineDependencies({
      store,
      ports,
      clock: new TestClock(),
    })).execute(claim);

    expect(result.outcome).toBe("failed");
    expect(store.settlements[0]?.error).toMatchObject({
      code: "duplicate_box_delete_deadline_exceeded",
      action: "retry",
    });
  });

  it("does not turn authorization loss immediately before create into an ambiguous effect", async () => {
    const claim = operationClaim({
      checkpoint: "box_absence_observed",
      checkpointSequence: 1n,
    });
    const authorized = operationAuthorization(claim, {
      boxId: null,
      boxState: "absent",
      piState: "absent",
      piInvocationId: null,
    });
    const store = new MemoryRuntimeStore({ authorization: authorized });
    const ports = fakePorts(store);
    let creates = 0;
    ports.box.createGenerationBox = async () => {
      creates += 1;
      return {
        outcome: "created",
        boxId: BOX_ID,
        name: `Companion ${claim.companionId} g1`,
      };
    };
    const renew = store.renewAndAuthorize.bind(store);
    let creatingRenewals = 0;
    store.renewAndAuthorize = async () => {
      const current = await renew();
      if (current?.workCheckpoint === "creating_box") {
        creatingRenewals += 1;
        if (creatingRenewals === 2) {
          return {
            ...current,
            authorized: false,
            denialCode: "actor_access_revoked",
          };
        }
      }
      return current;
    };

    const result = await new RuntimeEngine(engineDependencies({ store, ports })).execute(claim);

    expect(result.outcome).toBe("failed");
    expect(creates).toBe(0);
    expect(store.settlements[0]?.error?.code).toBe("actor_access_revoked");
    expect(store.settlements[0]?.error?.code).not.toBe("box_create_ambiguous");
  });

  it("permanently deletes a generation Box that appears during absence confirmation", async () => {
    const claim: OperationRuntimeClaim = {
      ...operationClaim(),
      clientSurface: null,
      operationKind: "delete",
      checkpoint: "box_absence_observed",
      checkpointSequence: 1n,
      targetSettingsRevision: null,
      targetSkillsRevision: null,
    };
    const store = new MemoryRuntimeStore({
      authorization: operationAuthorization(claim, {
        boxId: null,
        boxState: "absent",
        piState: "absent",
        piInvocationId: null,
        desiredSettingsRevision: null,
        skillsRevision: null,
      }),
    });
    const ports = fakePorts(store);
    const requests: string[] = [];
    ports.box.findGenerationBoxes = async () => ({
      name: `Companion ${claim.companionId} g1`,
      canonical: {
        id: BOX_ID,
        name: `Companion ${claim.companionId} g1`,
        state: "ready",
      },
      duplicates: [],
    });
    ports.box.requestPermanentDeletion = async ({ boxId }) => {
      requests.push(boxId);
      return { outcome: "accepted", operationId: "delete-op-late" };
    };

    const result = await new RuntimeEngine(engineDependencies({
      store,
      ports,
      clock: new TestClock(),
    })).execute(claim);

    expect(result.outcome).toBe("succeeded");
    expect(requests).toEqual([BOX_ID]);
    expect(store.authorization.providerOperationId).toBe("delete-op-late");
    expect(store.authorization.workCheckpoint).toBe("provider_deleted");
  });

  it("defers a blocked accepted deletion after exactly one provider poll", async () => {
    const claim: OperationRuntimeClaim = {
      ...operationClaim(),
      clientSurface: null,
      operationKind: "delete",
      checkpoint: "waiting_deleted",
      checkpointSequence: 2n,
      targetSettingsRevision: null,
      targetSkillsRevision: null,
      providerOperationId: "bdop_00000000000000000000000000000001",
    };
    const store = new MemoryRuntimeStore({
      authorization: operationAuthorization(claim, {
        boxId: BOX_ID,
        boxState: "ready",
        piState: "absent",
        piInvocationId: null,
        desiredSettingsRevision: null,
        skillsRevision: null,
      }),
    });
    const ports = fakePorts(store);
    const polls: string[] = [];
    ports.box.pollPermanentDeletion = async ({ operationId }) => {
      polls.push(operationId);
      return { status: "blocked" };
    };
    const clock = new TestClock();

    const result = await new RuntimeEngine(engineDependencies({ store, ports, clock })).execute(claim);

    expect(result.outcome).toBe("released");
    expect(polls).toEqual(["bdop_00000000000000000000000000000001"]);
    expect(clock.sleeps).toEqual([]);
    expect(store.authorization.workCheckpoint).toBe("waiting_deleted");
    expect(store.authorization.providerOperationId)
      .toBe("bdop_00000000000000000000000000000001");
    expect(store.deferredDeletes).toBe(1);
    expect(store.settlements).toEqual([]);
  });

  it("defers an accepted deletion even after its former operation deadline", async () => {
    const claim: OperationRuntimeClaim = {
      ...operationClaim(),
      clientSurface: null,
      operationKind: "delete",
      checkpoint: "waiting_deleted",
      checkpointSequence: 2n,
      targetSettingsRevision: null,
      targetSkillsRevision: null,
      providerOperationId: "bdop_00000000000000000000000000000001",
      coldStartDeadlineAt: new Date("2026-08-16T12:00:02.000Z"),
    };
    const store = new MemoryRuntimeStore({
      authorization: operationAuthorization(claim, {
        boxId: BOX_ID,
        boxState: "ready",
        piState: "absent",
        piInvocationId: null,
        desiredSettingsRevision: null,
        skillsRevision: null,
      }),
    });
    const ports = fakePorts(store);
    ports.box.pollPermanentDeletion = async () => ({ status: "blocked" });

    const result = await new RuntimeEngine(engineDependencies({
      store,
      ports,
      clock: new TestClock(),
    })).execute(claim);

    expect(result.outcome).toBe("released");
    expect(store.deferredDeletes).toBe(1);
    expect(store.settlements).toEqual([]);
  });

  it("deletes a duplicate that appears after deterministic Box naming before staging", async () => {
    const claim = operationClaim();
    const store = new MemoryRuntimeStore({
      authorization: operationAuthorization(claim, {
        boxId: null,
        boxState: "absent",
        piState: "absent",
        piInvocationId: null,
        diskLayoutVersion: 0,
        appliedSettingsRevision: 0n,
        appliedSkillsRevision: 0,
      }),
    });
    const ports = fakePorts(store);
    const generationName = `Companion ${claim.companionId} g1`;
    const duplicateId = "bx_2345678c";
    const effects: string[] = [];
    let discoveryCalls = 0;
    ports.box.findGenerationBoxes = async () => {
      discoveryCalls += 1;
      effects.push(`list:${discoveryCalls}`);
      return discoveryCalls === 1
        ? { name: generationName, canonical: null, duplicates: [] }
        : {
            name: generationName,
            canonical: { id: BOX_ID, name: generationName, state: "provisioning" },
            duplicates: [{ id: duplicateId, name: generationName, state: "ready" }],
          };
    };
    ports.box.createGenerationBox = async () => {
      effects.push("create");
      return { outcome: "created", boxId: BOX_ID, name: generationName };
    };
    ports.box.applyGenerationBoxSettings = async ({ boxId }) => {
      effects.push(`settings:${boxId}`);
    };
    ports.box.requestPermanentDeletion = async ({ boxId }) => {
      effects.push(`delete:${boxId}`);
      return { outcome: "accepted", operationId: "delete-op-late" };
    };
    ports.box.pollPermanentDeletion = async ({ boxId }) => {
      effects.push(`poll:${boxId}`);
      return { status: "completed" };
    };
    const originalStage = ports.resourceStager.stageExistingBox;
    ports.resourceStager.stageExistingBox = async (input) => {
      effects.push(`stage:${input.boxId}`);
      return await originalStage(input);
    };

    const result = await new RuntimeEngine(engineDependencies({ store, ports })).execute(claim);

    expect(result.outcome).toBe("succeeded");
    expect(effects).toEqual([
      "list:1",
      "create",
      `settings:${BOX_ID}`,
      "list:2",
      `delete:${duplicateId}`,
      `poll:${duplicateId}`,
      `stage:${BOX_ID}`,
    ]);
    expect(store.authorization.boxId).toBe(BOX_ID);
    expect(store.duplicateCleanups.get(duplicateId)).toMatchObject({
      status: "deleted",
      providerOperationId: "delete-op-late",
    });
  });

  it("resumes post-name duplicate cleanup after an indeterminate durable checkpoint", async () => {
    const claim = operationClaim({
      checkpoint: "box_created",
      checkpointSequence: 4n,
    });
    const store = new MemoryRuntimeStore({
      authorization: operationAuthorization(claim, {
        boxId: BOX_ID,
        boxState: "provisioning",
        piState: "absent",
        piInvocationId: null,
        diskLayoutVersion: 0,
        appliedSettingsRevision: 0n,
        appliedSkillsRevision: 0,
      }),
    });
    const ports = fakePorts(store);
    const generationName = `Companion ${claim.companionId} g1`;
    const duplicateId = "bx_2345678d";
    let creates = 0;
    let deleteRequests = 0;
    let deletePolls = 0;
    ports.box.findGenerationBoxes = async () => ({
      name: generationName,
      canonical: { id: BOX_ID, name: generationName, state: "provisioning" },
      duplicates: [{ id: duplicateId, name: generationName, state: "ready" }],
    });
    ports.box.createGenerationBox = async () => {
      creates += 1;
      return { outcome: "created", boxId: BOX_ID, name: generationName };
    };
    ports.box.requestPermanentDeletion = async () => {
      deleteRequests += 1;
      return { outcome: "accepted", operationId: "delete-op-takeover" };
    };
    ports.box.pollPermanentDeletion = async () => {
      deletePolls += 1;
      return { status: "completed" };
    };
    const durableCleanupCheckpoint = store.checkpointDuplicateCleanup.bind(store);
    let loseFirstResponse = true;
    store.checkpointDuplicateCleanup = async (fence, input) => {
      const result = await durableCleanupCheckpoint(fence, input);
      if (loseFirstResponse) {
        loseFirstResponse = false;
        throw new RuntimeStoreIndeterminateError();
      }
      return result;
    };

    const first = await new RuntimeEngine(engineDependencies({ store, ports })).execute(claim);

    expect(first.outcome).toBe("fence_lost");
    expect(store.duplicateCleanups.get(duplicateId)).toMatchObject({
      status: "delete_requested",
      providerOperationId: "delete-op-takeover",
    });
    expect(store.settlements).toHaveLength(0);

    store.checkpointDuplicateCleanup = durableCleanupCheckpoint;
    const takeoverClaim = operationClaim({
      claimEpoch: 2n,
      checkpoint: "box_created",
      checkpointSequence: store.authorization.workCheckpointSequence,
    });
    const takeover = await new RuntimeEngine(engineDependencies({ store, ports }))
      .execute(takeoverClaim);

    expect(takeover.outcome).toBe("succeeded");
    expect(creates).toBe(0);
    expect(deleteRequests).toBe(1);
    expect(deletePolls).toBe(1);
    expect(store.authorization.boxId).toBe(BOX_ID);
    expect(store.duplicateCleanups.get(duplicateId)).toMatchObject({
      status: "deleted",
      providerOperationId: "delete-op-takeover",
    });
    expect(store.settlements).toEqual([{ terminalStatus: "succeeded" }]);
  });

  it("waits for archive completion before resuming an explicit Box restart", async () => {
    const claim = operationClaim({ operationKind: "restart_box" });
    const store = new MemoryRuntimeStore({
      authorization: operationAuthorization(claim, {
        boxId: BOX_ID,
        boxState: "ready",
        piState: "idle",
        piInvocationId: "old-pi-invocation",
      }),
    });
    const ports = fakePorts(store);
    const effects: string[] = [];
    const states: Array<"archiving" | "archived" | "ready"> = [
      "archiving",
      "archived",
      "ready",
    ];
    ports.box.stopExistingBox = async () => { effects.push("stop"); };
    ports.box.getStatus = async () => {
      const state = states.shift() ?? "ready";
      effects.push(`status:${state}`);
      return { state };
    };
    ports.box.resumeExistingBox = async () => { effects.push("resume"); };
    ports.pi.restartPiDaemon = async () => {
      effects.push("restart-pi");
      return { state: "idle", invocationId: PI_INVOCATION_ID };
    };
    const engine = new RuntimeEngine(engineDependencies({ store, ports }));

    const result = await engine.execute(claim);

    expect(result.outcome).toBe("succeeded");
    expect(effects.slice(0, 5)).toEqual([
      "stop",
      "status:archiving",
      "status:archived",
      "resume",
      "status:ready",
    ]);
    expect(effects.indexOf("resume")).toBeGreaterThan(effects.indexOf("status:archived"));
    expect(effects).toContain("restart-pi");
  });

  it("waits for a different idle Pi invocation after an explicit Pi restart", async () => {
    const claim = operationClaim({ operationKind: "restart_pi" });
    const store = new MemoryRuntimeStore({
      authorization: operationAuthorization(claim, {
        boxId: BOX_ID,
        boxState: "ready",
        piState: "idle",
        piInvocationId: "old-pi-invocation",
      }),
    });
    const ports = fakePorts(store);
    const effects: string[] = [];
    const originalStage = ports.resourceStager.stageExistingBox;
    ports.resourceStager.stageExistingBox = async (input) => {
      effects.push("stage");
      return await originalStage(input);
    };
    let statusCalls = 0;
    ports.pi.restartPiDaemon = async () => {
      effects.push("restart-pi");
      return { state: "starting", invocationId: "old-pi-invocation" };
    };
    ports.pi.piDaemonStatus = async () => {
      statusCalls += 1;
      return statusCalls === 1
        ? { state: "idle", invocationId: "old-pi-invocation" }
        : { state: "idle", invocationId: PI_INVOCATION_ID };
    };
    const engine = new RuntimeEngine(engineDependencies({ store, ports }));

    const result = await engine.execute(claim);

    expect(result.outcome).toBe("succeeded");
    expect(statusCalls).toBe(2);
    expect(effects).toEqual(["stage", "restart-pi"]);
    expect(store.recordedMaterialSnapshots).toEqual([{
      clientSurface: "web",
      materialExpiresAt: new Date("2026-08-16T18:00:00.000Z"),
      agentEndpoint: null,
    }]);
    expect(store.publishedMaterialSnapshots).toEqual([PI_INVOCATION_ID]);
    expect(store.authorization.piInvocationId).toBe(PI_INVOCATION_ID);
  });

  it("retries an isolated routine by terminating only that run's Pi process", async () => {
    const invocationId = `routine:${TURN_ID}:dispatch-v2:previous`;
    const claim = operationClaim({ operationKind: "restart_pi", turnId: TURN_ID });
    const store = new MemoryRuntimeStore({
      authorization: operationAuthorization(claim, {
        boxId: BOX_ID,
        boxState: "ready",
        piState: "running",
        piInvocationId: "main-pi-invocation",
        commandPiInvocationId: invocationId,
      }),
      material: attemptMaterial({
        routineId: ROUTINE_SNAPSHOT_ID,
        routineName: "Parallel routine",
        routineIsolated: true,
      }),
    });
    const ports = fakePorts(store);
    let mainRestarts = 0;
    ports.pi.restartPiDaemon = async () => {
      mainRestarts += 1;
      return { state: "idle", invocationId: PI_INVOCATION_ID };
    };

    const result = await new RuntimeEngine(engineDependencies({ store, ports })).execute(claim);

    expect(result.outcome).toBe("succeeded");
    expect(ports.routineTerminates).toEqual([TURN_ID]);
    expect(mainRestarts).toBe(0);
    expect(store.authorization.piInvocationId).toBe("main-pi-invocation");
  });

  it("retries a legacy routine through the shared main Pi process", async () => {
    const claim = operationClaim({ operationKind: "restart_pi", turnId: TURN_ID });
    const store = new MemoryRuntimeStore({
      authorization: operationAuthorization(claim, {
        boxId: BOX_ID,
        boxState: "ready",
        piState: "idle",
        piInvocationId: "legacy-main-pi-invocation",
      }),
      material: attemptMaterial({
        routineId: ROUTINE_SNAPSHOT_ID,
        routineName: "Legacy routine",
        routineIsolated: false,
      }),
    });
    const ports = fakePorts(store);
    let mainRestarts = 0;
    ports.pi.restartPiDaemon = async () => {
      mainRestarts += 1;
      return { state: "idle", invocationId: PI_INVOCATION_ID };
    };

    const result = await new RuntimeEngine(engineDependencies({ store, ports })).execute(claim);

    expect(result.outcome).toBe("succeeded");
    expect(ports.routineTerminates).toEqual([]);
    expect(mainRestarts).toBe(1);
    expect(store.authorization.piInvocationId).toBe(PI_INVOCATION_ID);
  });

  it("keeps the installed tree and completes Restart Pi when an auto-update fails", async () => {
    const claim = operationClaim({ operationKind: "restart_pi", targetSkillsRevision: 2 });
    const store = new MemoryRuntimeStore({
      authorization: operationAuthorization(claim, {
        boxId: BOX_ID,
        boxState: "ready",
        piState: "idle",
        piInvocationId: "old-pi-invocation",
        appliedSkillsRevision: 1,
        skillsRevision: 1,
      }),
    });
    store.getSkillUpdateMaterial = async () => ({
      targetSkillsRevision: 2,
      requiredSkillsRevision: 1,
      selectedSkillIds: [],
      skillRefs: [],
      skillMaterial: [],
    });
    const effects: string[] = [];
    store.recordSkillUpdateError = async (_fence, error) => {
      effects.push(`error:${error.code}`);
      return true;
    };
    const ports = fakePorts(store);
    ports.pi.stopPiDaemon = async () => { effects.push("stop-pi"); };
    ports.resourceStager.stageSkillTree = async () => {
      effects.push("update-skills");
      throw new Error("simulated archive failure");
    };
    const originalStage = ports.resourceStager.stageExistingBox;
    ports.resourceStager.stageExistingBox = async (input) => {
      effects.push("stage-preserving-skills");
      expect(input.preserveInstalledSkills).toBe(true);
      return await originalStage(input);
    };
    ports.pi.restartPiDaemon = async () => {
      effects.push("restart-pi");
      return { state: "idle", invocationId: PI_INVOCATION_ID };
    };

    const result = await new RuntimeEngine(engineDependencies({ store, ports })).execute(claim);

    expect(result.outcome).toBe("succeeded");
    expect(store.authorization.appliedSkillsRevision).toBe(1);
    expect(effects).toEqual([
      "stop-pi",
      "update-skills",
      "error:skill_auto_update_failed",
      "stage-preserving-skills",
      "restart-pi",
    ]);
  });

  it("blocks Restart Pi when a required Skill selection cannot be installed", async () => {
    const claim = operationClaim({ operationKind: "restart_pi", targetSkillsRevision: 2 });
    const store = new MemoryRuntimeStore({
      authorization: operationAuthorization(claim, {
        boxId: BOX_ID,
        boxState: "ready",
        piState: "idle",
        piInvocationId: "old-pi-invocation",
        appliedSkillsRevision: 1,
        skillsRevision: 2,
      }),
    });
    const ports = fakePorts(store);
    let restarts = 0;
    ports.resourceStager.stageSkillTree = async () => {
      throw new Error("simulated archive failure");
    };
    ports.pi.restartPiDaemon = async () => {
      restarts += 1;
      return { state: "idle", invocationId: PI_INVOCATION_ID };
    };

    const result = await new RuntimeEngine(engineDependencies({ store, ports })).execute(claim);

    expect(result.outcome).toBe("failed");
    expect(restarts).toBe(0);
    expect(store.authorization.appliedSkillsRevision).toBe(1);
  });

  it("activates staged settings with a new idle Pi invocation before publishing revisions", async () => {
    const claim = operationClaim({
      operationKind: "apply_settings",
      targetSettingsRevision: 2n,
      targetSkillsRevision: 2,
    });
    const store = new MemoryRuntimeStore({
      authorization: operationAuthorization(claim, {
        boxId: BOX_ID,
        boxState: "ready",
        piState: "idle",
        piInvocationId: "old-pi-invocation",
        appliedSettingsRevision: 1n,
        appliedSkillsRevision: 1,
      }),
    });
    const ports = fakePorts(store);
    const effects: string[] = [];
    const originalStage = ports.resourceStager.stageExistingBox;
    ports.resourceStager.stageExistingBox = async (input) => {
      effects.push("stage");
      expect(store.authorization.appliedSettingsRevision).toBe(1n);
      return await originalStage(input);
    };
    ports.pi.restartPiDaemon = async () => {
      effects.push("restart-pi");
      expect(store.authorization.appliedSettingsRevision).toBe(1n);
      return { state: "starting", invocationId: "old-pi-invocation" };
    };
    let statusCalls = 0;
    ports.pi.piDaemonStatus = async () => {
      statusCalls += 1;
      effects.push(`pi-status:${statusCalls}`);
      expect(store.authorization.appliedSettingsRevision).toBe(1n);
      return statusCalls === 1
        ? { state: "idle", invocationId: "old-pi-invocation" }
        : { state: "idle", invocationId: PI_INVOCATION_ID };
    };
    ports.box.stopExistingBox = async () => { effects.push("stop-box"); };
    ports.box.resumeExistingBox = async () => { effects.push("resume-box"); };

    const result = await new RuntimeEngine(engineDependencies({ store, ports })).execute(claim);

    expect(result.outcome).toBe("succeeded");
    expect(effects).toEqual(["stage", "restart-pi", "pi-status:1", "pi-status:2"]);
    expect(store.authorization.piInvocationId).toBe(PI_INVOCATION_ID);
    expect(store.authorization.appliedSettingsRevision).toBe(2n);
    expect(store.authorization.appliedSkillsRevision).toBe(2);
    expect(store.authorization.workCheckpoint).toBe("settings_applied");
    expect(store.observations.at(-1)).toMatchObject({
      piState: "idle",
      piInvocationId: PI_INVOCATION_ID,
      appliedSettingsRevision: 2n,
      appliedSkillsRevision: 2,
    });
    expect(store.observations.at(-1)).not.toHaveProperty("diskLayoutVersion");
    expect(store.recordedMaterialSnapshots).toEqual([{
      clientSurface: "web",
      materialExpiresAt: new Date("2026-08-16T18:00:00.000Z"),
      agentEndpoint: null,
    }]);
    expect(store.publishedMaterialSnapshots).toEqual([PI_INVOCATION_ID]);
    expect(store.settlements).toEqual([{ terminalStatus: "succeeded" }]);
  });

  it("activates native-mobile settings without publishing a Skills revision", async () => {
    const claim = operationClaim({
      clientSurface: "native_mobile",
      operationKind: "apply_settings",
      targetSettingsRevision: 2n,
      targetSkillsRevision: 2,
    });
    const store = new MemoryRuntimeStore({
      authorization: operationAuthorization(claim, {
        clientSurface: "native_mobile",
        boxId: BOX_ID,
        boxState: "ready",
        piState: "idle",
        piInvocationId: "old-native-pi",
        appliedSettingsRevision: 1n,
        appliedSkillsRevision: 1,
      }),
    });
    const ports = fakePorts(store);
    ports.resourceStager.stageExistingBox = async (input) => {
      expect(input.clientSurface).toBe("native_mobile");
      expect(input.targetSkillsRevision).toBeNull();
      return {
        diskLayoutVersion: 14,
        appliedSettingsRevision: input.targetSettingsRevision,
        appliedSkillsRevision: null,
        materialExpiresAt: null,
      };
    };
    ports.pi.restartPiDaemon = async () => ({
      state: "idle",
      invocationId: "new-native-pi",
    });

    const result = await new RuntimeEngine(engineDependencies({ store, ports })).execute(claim);

    expect(result.outcome).toBe("succeeded");
    expect(store.authorization.piInvocationId).toBe("new-native-pi");
    expect(store.authorization.appliedSettingsRevision).toBe(2n);
    expect(store.authorization.appliedSkillsRevision).toBe(1);
    expect(store.observations.at(-1)).toMatchObject({
      piState: "idle",
      piInvocationId: "new-native-pi",
      appliedSettingsRevision: 2n,
    });
    expect(store.observations.at(-1)).not.toHaveProperty("appliedSkillsRevision");
    expect(store.recordedMaterialSnapshots).toEqual([{
      clientSurface: "native_mobile",
      materialExpiresAt: null,
      agentEndpoint: null,
    }]);
    expect(store.publishedMaterialSnapshots).toEqual(["new-native-pi"]);
  });

  it("does not publish staged revisions when settings activation lacks a new idle Pi", async () => {
    const claim = operationClaim({
      checkpoint: "applying_settings",
      checkpointSequence: 1n,
      operationKind: "apply_settings",
      targetSettingsRevision: 2n,
      targetSkillsRevision: 2,
    });
    const store = new MemoryRuntimeStore({
      authorization: operationAuthorization(claim, {
        boxId: BOX_ID,
        boxState: "ready",
        piState: "idle",
        piInvocationId: "old-pi-invocation",
        appliedSettingsRevision: 1n,
        appliedSkillsRevision: 1,
      }),
    });
    const ports = fakePorts(store);
    let stages = 0;
    const originalStage = ports.resourceStager.stageExistingBox;
    ports.resourceStager.stageExistingBox = async (input) => {
      stages += 1;
      return await originalStage(input);
    };
    ports.pi.restartPiDaemon = async () => ({
      state: "idle",
      invocationId: "old-pi-invocation",
    });
    ports.pi.piDaemonStatus = async () => ({ state: "error", invocationId: null });
    let boxLifecycleCalls = 0;
    ports.box.stopExistingBox = async () => { boxLifecycleCalls += 1; };
    ports.box.resumeExistingBox = async () => { boxLifecycleCalls += 1; };

    const result = await new RuntimeEngine(engineDependencies({ store, ports })).execute(claim);

    expect(result.outcome).toBe("failed");
    expect(stages).toBe(1);
    expect(boxLifecycleCalls).toBe(0);
    expect(store.authorization.piInvocationId).toBe("old-pi-invocation");
    expect(store.authorization.appliedSettingsRevision).toBe(1n);
    expect(store.authorization.appliedSkillsRevision).toBe(1);
    expect(store.authorization.workCheckpoint).toBe("applying_settings");
    expect(store.observations).toHaveLength(0);
    expect(store.recordedMaterialSnapshots).toHaveLength(1);
    expect(store.publishedMaterialSnapshots).toHaveLength(0);
    expect(store.settlements[0]?.error?.code).toBe("pi_start_failed");
  });

  it("repeats idempotent settings activation after takeover when the final observation was lost", async () => {
    const claim = operationClaim({
      checkpoint: "applying_settings",
      checkpointSequence: 1n,
      operationKind: "apply_settings",
      targetSettingsRevision: 2n,
      targetSkillsRevision: 2,
    });
    const store = new MemoryRuntimeStore({
      authorization: operationAuthorization(claim, {
        boxId: BOX_ID,
        boxState: "ready",
        piState: "idle",
        piInvocationId: "old-pi-invocation",
        appliedSettingsRevision: 1n,
        appliedSkillsRevision: 1,
      }),
    });
    const ports = fakePorts(store);
    let stages = 0;
    const originalStage = ports.resourceStager.stageExistingBox;
    ports.resourceStager.stageExistingBox = async (input) => {
      stages += 1;
      return await originalStage(input);
    };
    let restarts = 0;
    ports.pi.restartPiDaemon = async () => {
      restarts += 1;
      return { state: "idle", invocationId: `settings-pi-${restarts}` };
    };
    let boxLifecycleCalls = 0;
    ports.box.stopExistingBox = async () => { boxLifecycleCalls += 1; };
    ports.box.resumeExistingBox = async () => { boxLifecycleCalls += 1; };

    const durableObserve = store.observeInstance.bind(store);
    store.observeInstance = async () => null;
    const first = await new RuntimeEngine(engineDependencies({ store, ports })).execute(claim);

    expect(first.outcome).toBe("fence_lost");
    expect(store.authorization.workCheckpoint).toBe("applying_settings");
    expect(store.authorization.appliedSettingsRevision).toBe(1n);

    store.observeInstance = durableObserve;
    const takeover = await new RuntimeEngine(engineDependencies({ store, ports })).execute(
      operationClaim({
        claimEpoch: 2n,
        checkpoint: "applying_settings",
        checkpointSequence: 1n,
        operationKind: "apply_settings",
        targetSettingsRevision: 2n,
        targetSkillsRevision: 2,
      }),
    );

    expect(takeover.outcome).toBe("succeeded");
    expect(stages).toBe(2);
    expect(restarts).toBe(2);
    expect(boxLifecycleCalls).toBe(0);
    expect(store.recordedMaterialSnapshots).toHaveLength(2);
    expect(store.publishedMaterialSnapshots).toEqual(["settings-pi-2"]);
    expect(store.authorization.piInvocationId).toBe("settings-pi-2");
    expect(store.authorization.appliedSettingsRevision).toBe(2n);
    expect(store.authorization.workCheckpoint).toBe("settings_applied");
  });

  it("never replays create after takeover of an unresolved write intent", async () => {
    const claim = operationClaim({
      checkpoint: "creating_box",
      checkpointSequence: 3n,
    });
    const store = new MemoryRuntimeStore({
      authorization: operationAuthorization(claim, {
        boxId: null,
        boxState: "absent",
        piState: "absent",
        piInvocationId: null,
      }),
    });
    const ports = fakePorts(store);
    let creates = 0;
    ports.box.findGenerationBoxes = async () => ({
      name: `Companion ${claim.companionId} g1`,
      canonical: null,
      duplicates: [],
    });
    ports.box.createGenerationBox = async () => {
      creates += 1;
      return {
        outcome: "created",
        boxId: BOX_ID,
        name: `Companion ${claim.companionId} g1`,
      };
    };
    const engine = new RuntimeEngine(engineDependencies({ store, ports }));

    const result = await engine.execute(claim);

    expect(result.outcome).toBe("interrupted");
    expect(creates).toBe(0);
    expect(store.settlements[0]?.error?.code).toBe("box_create_ambiguous");
  });

  it("fails stop explicitly instead of polling forever when the recorded Box is absent", async () => {
    const resourceClaim = operationClaim();
    const claim = {
      ...resourceClaim,
      clientSurface: null,
      operationKind: "stop",
      checkpoint: "waiting_archived",
      checkpointSequence: 2n,
      targetSettingsRevision: null,
      targetSkillsRevision: null,
      coldStartDeadlineAt: null,
    } as OperationRuntimeClaim;
    const store = new MemoryRuntimeStore({
      authorization: operationAuthorization(claim, {
        clientSurface: null,
        workCheckpoint: "waiting_archived",
        workCheckpointSequence: 2n,
        operationKind: "stop",
        desiredSettingsRevision: null,
        skillsRevision: null,
        modelId: null,
      }),
    });
    const ports = fakePorts(store);
    ports.box.getStatus = async () => ({ state: "absent" });
    const engine = new RuntimeEngine(engineDependencies({ store, ports }));

    const result = await engine.execute(claim);

    expect(result.outcome).toBe("failed");
    expect(store.settlements[0]?.error?.code).toBe("box_stop_failed");
  });

  it("terminates explicit provider polling at the durable operation deadline", async () => {
    const resourceClaim = operationClaim();
    const claim = {
      ...resourceClaim,
      clientSurface: null,
      operationKind: "stop",
      checkpoint: "waiting_archived",
      checkpointSequence: 2n,
      operationStartedAt: new Date("2026-08-16T11:49:00.000Z"),
      targetSettingsRevision: null,
      targetSkillsRevision: null,
      coldStartDeadlineAt: null,
    } as OperationRuntimeClaim;
    const store = new MemoryRuntimeStore({
      authorization: operationAuthorization(claim, {
        clientSurface: null,
        workCheckpoint: "waiting_archived",
        workCheckpointSequence: 2n,
        operationKind: "stop",
        operationStartedAt: claim.operationStartedAt,
        desiredSettingsRevision: null,
        skillsRevision: null,
        modelId: null,
      }),
    });
    const ports = fakePorts(store);
    let statusCalls = 0;
    ports.box.getStatus = async () => {
      statusCalls += 1;
      return { state: "archiving" };
    };
    const engine = new RuntimeEngine(engineDependencies({ store, ports }));

    const result = await engine.execute(claim);

    expect(result.outcome).toBe("failed");
    expect(statusCalls).toBe(0);
    expect(store.settlements[0]?.error?.code).toBe("box_stop_deadline_exceeded");
  });

  function deleteClaimAtWaitingDeleted(overrides: Partial<OperationRuntimeClaim> = {}) {
    const claim = {
      ...operationClaim(),
      clientSurface: null,
      operationKind: "delete",
      checkpoint: "waiting_deleted",
      checkpointSequence: 3n,
      targetSettingsRevision: null,
      targetSkillsRevision: null,
      ...overrides,
    } as OperationRuntimeClaim;
    const store = new MemoryRuntimeStore({
      authorization: operationAuthorization(claim, {
        workCheckpoint: "waiting_deleted",
        workCheckpointSequence: 3n,
        operationKind: "delete",
        providerOperationId: "delete-op-1",
        desiredSettingsRevision: null,
        skillsRevision: null,
        modelId: null,
      }),
    });
    return { claim, store };
  }

  function deleteClaimWithCapturedRoutine() {
    const claim = {
      ...operationClaim(),
      clientSurface: null,
      operationKind: "delete",
      turnId: TURN_ID,
      targetSettingsRevision: null,
      targetSkillsRevision: null,
    } as OperationRuntimeClaim;
    const store = new MemoryRuntimeStore({
      authorization: operationAuthorization(claim, {
        boxId: BOX_ID,
        boxState: "ready",
        piState: "idle",
        piInvocationId: PI_INVOCATION_ID,
        workCheckpoint: "pending",
        workCheckpointSequence: 0n,
        operationKind: "delete",
        turnId: TURN_ID,
        commandPiInvocationId: `routine:${TURN_ID}:dispatch-v2:captured`,
      }),
      material: attemptMaterial({
        routineId: ROUTINE_SNAPSHOT_ID,
        routineName: "Parallel routine",
        routineIsolated: true,
      }),
    });
    return { claim, store };
  }

  it("terminates the captured isolated routine before issuing permanent delete", async () => {
    const { claim, store } = deleteClaimWithCapturedRoutine();
    const ports = fakePorts(store);
    ports.box.requestPermanentDeletion = async ({ boxId }) => {
      store.effectLog.push(`delete:${boxId}`);
      return { outcome: "accepted", operationId: "delete-op-after-routine" };
    };

    const result = await new RuntimeEngine(engineDependencies({ store, ports })).execute(claim);

    expect(result.outcome).toBe("succeeded");
    expect(ports.routineTerminates).toEqual([TURN_ID]);
    expect(store.effectLog).toEqual(["routine-terminate", `delete:${BOX_ID}`]);
  });

  it("blocks provider delete when the captured routine cannot be terminated", async () => {
    const { claim, store } = deleteClaimWithCapturedRoutine();
    const ports = fakePorts(store);
    let deleteRequests = 0;
    ports.pi.routineSession!.terminate = async () => {
      throw new Error("routine process did not stop");
    };
    ports.box.requestPermanentDeletion = async () => {
      deleteRequests += 1;
      return { outcome: "accepted", operationId: "unexpected-delete" };
    };

    const result = await new RuntimeEngine(engineDependencies({ store, ports })).execute(claim);

    expect(result.outcome).toBe("failed");
    expect(deleteRequests).toBe(0);
    expect(store.settlements[0]?.error).toMatchObject({
      code: "runtime_execution_failed",
      action: "retry",
    });
  });

  it.each(["pending", "processing", "blocked"] as const)(
    "defers provider delete status %s without settling",
    async (status) => {
      const { claim, store } = deleteClaimAtWaitingDeleted();
      const ports = fakePorts(store);
      const polls: string[] = [];
      ports.box.pollPermanentDeletion = async ({ operationId }) => {
        polls.push(operationId);
        return { status };
      };

      const result = await new RuntimeEngine(engineDependencies({ store, ports })).execute(claim);

      expect(result.outcome).toBe("released");
      expect(polls).toEqual(["delete-op-1"]);
      expect(store.authorization.providerOperationId).toBe("delete-op-1");
      expect(store.deferredDeletes).toBe(1);
      expect(store.settlements).toEqual([]);
    },
  );

  it("defers an explicitly retryable provider GET error without settling", async () => {
    const { claim, store } = deleteClaimAtWaitingDeleted();
    const ports = fakePorts(store);
    let polls = 0;
    ports.box.pollPermanentDeletion = async () => {
      polls += 1;
      throw Object.assign(new Error("temporary outage"), { retryable: true, status: 503 });
    };

    const result = await new RuntimeEngine(engineDependencies({ store, ports })).execute(claim);

    expect(result.outcome).toBe("released");
    expect(polls).toBe(1);
    expect(store.deferredDeletes).toBe(1);
    expect(store.settlements).toEqual([]);
  });

  it("lets a new runtime resume the same accepted delete without replaying DELETE", async () => {
    const { claim, store } = deleteClaimAtWaitingDeleted();
    const ports = fakePorts(store);
    const requestedOperations: string[] = [];
    let polls = 0;
    ports.box.requestPermanentDeletion = async () => {
      requestedOperations.push("unexpected-delete");
      return { outcome: "accepted", operationId: "replacement-operation" };
    };
    ports.box.pollPermanentDeletion = async ({ operationId }) => {
      polls += 1;
      expect(operationId).toBe("delete-op-1");
      return { status: polls === 1 ? "processing" : "completed" };
    };

    const firstRuntime = await new RuntimeEngine(engineDependencies({ store, ports })).execute(claim);
    const takeoverClaim: OperationRuntimeClaim = { ...claim, claimEpoch: claim.claimEpoch + 1n };
    const secondRuntime = await new RuntimeEngine(engineDependencies({ store, ports }))
      .execute(takeoverClaim);

    expect(firstRuntime.outcome).toBe("released");
    expect(secondRuntime.outcome).toBe("succeeded");
    expect(requestedOperations).toEqual([]);
    expect(polls).toBe(2);
    expect(store.authorization.providerOperationId).toBe("delete-op-1");
    expect(store.deferredDeletes).toBe(1);
    expect(store.settlements).toEqual([{ terminalStatus: "succeeded" }]);
  });

  it("advances a recovered provider-delete checkpoint without replaying DELETE", async () => {
    const claim: OperationRuntimeClaim = {
      ...operationClaim(),
      clientSurface: null,
      operationKind: "delete",
      checkpoint: "provider_delete_requested",
      checkpointSequence: 2n,
      targetSettingsRevision: null,
      targetSkillsRevision: null,
      providerOperationId: "delete-op-recovered",
    };
    const store = new MemoryRuntimeStore({
      authorization: operationAuthorization(claim, {
        boxId: BOX_ID,
        boxState: "ready",
        piState: "absent",
        piInvocationId: null,
        desiredSettingsRevision: null,
        skillsRevision: null,
      }),
    });
    const ports = fakePorts(store);
    let deleteRequests = 0;
    const polls: string[] = [];
    ports.box.requestPermanentDeletion = async () => {
      deleteRequests += 1;
      return { outcome: "accepted", operationId: "unexpected-replacement" };
    };
    ports.box.pollPermanentDeletion = async ({ operationId }) => {
      polls.push(operationId);
      return { status: "completed" };
    };

    const result = await new RuntimeEngine(engineDependencies({ store, ports })).execute(claim);

    expect(result.outcome).toBe("succeeded");
    expect(deleteRequests).toBe(0);
    expect(polls).toEqual(["delete-op-recovered"]);
    expect(store.authorization.workCheckpoint).toBe("provider_deleted");
  });

  it("settles an invalid or non-retryable provider GET as an expurgated failure", async () => {
    const { claim, store } = deleteClaimAtWaitingDeleted();
    const ports = fakePorts(store);
    ports.box.pollPermanentDeletion = async () => {
      throw Object.assign(new Error("provider payload contained a secret"), {
        code: "box_response_invalid",
        retryable: false,
      });
    };

    const result = await new RuntimeEngine(engineDependencies({ store, ports })).execute(claim);

    expect(result.outcome).toBe("failed");
    expect(store.deferredDeletes).toBe(0);
    expect(store.settlements).toHaveLength(1);
    expect(store.settlements[0]?.error).toMatchObject({
      code: "runtime_execution_failed",
      message: "Runtime execution failed.",
    });
  });

  it("completes a waiting delete when the provider operation is already gone", async () => {
    const { claim, store } = deleteClaimAtWaitingDeleted();
    const ports = fakePorts(store);
    ports.box.pollPermanentDeletion = async () => {
      throw Object.assign(new Error("gone"), { status: 404 });
    };

    const result = await new RuntimeEngine(engineDependencies({ store, ports })).execute(claim);

    expect(result.outcome).toBe("succeeded");
    expect(store.authorization.workCheckpoint).toBe("provider_deleted");
  });

  it("records per-stage timings for a start", async () => {
    const claim = operationClaim({ checkpoint: "waiting_ready", checkpointSequence: 2n });
    const store = new MemoryRuntimeStore({
      authorization: operationAuthorization(claim, {
        boxId: BOX_ID,
        boxState: "provisioning",
        piState: "absent",
        piInvocationId: null,
      }),
    });
    const ports = fakePorts(store);
    const records: Array<Record<string, unknown>> = [];
    const engine = new RuntimeEngine(engineDependencies({
      store,
      ports,
      clock: new TestClock(),
      log: {
        error: () => {},
        warn: () => {},
        info: (record) => records.push(record),
      },
    }));

    const result = await engine.execute(claim);

    expect(result.outcome).toBe("succeeded");
    const stages = records.filter((record) => record.event === "runtime.operation.stage");
    expect(stages.map((record) => record.stage)).toEqual([
      "waiting_ready",
      "installing_layout",
      "starting_pi",
    ]);
    for (const record of stages) {
      expect(record).toMatchObject({
        companionId: claim.companionId,
        operationKind: "start",
        boxId: BOX_ID,
      });
      expect(typeof record.durationMs).toBe("number");
    }
  });

  it("runs a start without a process log", async () => {
    const claim = operationClaim({ checkpoint: "waiting_ready", checkpointSequence: 2n });
    const store = new MemoryRuntimeStore({
      authorization: operationAuthorization(claim, {
        boxId: BOX_ID,
        boxState: "provisioning",
        piState: "absent",
        piInvocationId: null,
      }),
    });
    const ports = fakePorts(store);

    const result = await new RuntimeEngine(engineDependencies({ store, ports })).execute(claim);

    expect(result.outcome).toBe("succeeded");
  });
});
