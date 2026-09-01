import { describe, expect, it } from "vitest";
import { RuntimeEngine } from "./engine";
import {
  COMPANION_ID,
  MemoryRuntimeStore,
  PI_INVOCATION_ID,
  attemptAuthorization,
  attemptClaim,
  engineDependencies,
  fakePorts,
} from "./test/fixtures";
import type { RuntimeAuthorization, SettingsRuntimeClaim } from "./types";

function settingsClaim(overrides: Partial<SettingsRuntimeClaim> = {}): SettingsRuntimeClaim {
  return {
    ...attemptClaim(),
    workKind: "settings",
    workId: COMPANION_ID,
    actorId: "user-1",
    clientSurface: "web",
    checkpoint: "applying",
    checkpointSequence: 1n,
    turnStatus: "queued",
    attemptStatus: null,
    dispatchState: null,
    eventCursor: null,
    unknownEventCount: null,
    malformedEventCount: null,
    oversizedEventCount: null,
    inactivityDeadlineAt: null,
    absoluteDeadlineAt: null,
    targetSettingsRevision: 2n,
    targetSkillsRevision: 2,
    ...overrides,
  };
}

function settingsAuthorization(
  claim: SettingsRuntimeClaim,
  overrides: Partial<RuntimeAuthorization> = {},
): RuntimeAuthorization {
  return attemptAuthorization(attemptClaim(), {
    authorizationActorId: claim.actorId,
    clientSurface: claim.clientSurface,
    runtimeGeneration: claim.runtimeGeneration,
    piState: "idle",
    piInvocationId: "old-pi-invocation",
    appliedSettingsRevision: 1n,
    appliedSkillsRevision: 1,
    desiredSettingsRevision: claim.targetSettingsRevision,
    skillsRevision: claim.targetSkillsRevision,
    workCheckpoint: claim.checkpoint,
    workCheckpointSequence: claim.checkpointSequence,
    turnId: claim.turnId,
    turnStatus: claim.turnStatus,
    attemptStatus: null,
    dispatchState: null,
    eventCursor: null,
    unknownEventCount: null,
    malformedEventCount: null,
    oversizedEventCount: null,
    inactivityDeadlineAt: null,
    absoluteDeadlineAt: null,
    operationKind: null,
    operationStartedAt: null,
    operationAttemptCount: null,
    targetSettingsRevision: claim.targetSettingsRevision,
    targetSkillsRevision: claim.targetSkillsRevision,
    ...overrides,
  });
}

describe("implicit settings activation", () => {
  it("restarts Pi and publishes the exact revisions only with a new idle invocation", async () => {
    const claim = settingsClaim();
    const store = new MemoryRuntimeStore({
      authorization: settingsAuthorization(claim),
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
      return { state: "starting", invocationId: "old-pi-invocation" };
    };
    let statusCalls = 0;
    ports.pi.piDaemonStatus = async () => {
      statusCalls += 1;
      effects.push(`pi-status:${statusCalls}`);
      return statusCalls === 1
        ? { state: "idle", invocationId: "old-pi-invocation" }
        : { state: "idle", invocationId: PI_INVOCATION_ID };
    };

    const result = await new RuntimeEngine(engineDependencies({ store, ports })).execute(claim);

    expect(result.outcome).toBe("succeeded");
    expect(effects).toEqual(["stage", "restart-pi", "pi-status:1", "pi-status:2"]);
    expect(store.authorization.piInvocationId).toBe(PI_INVOCATION_ID);
    expect(store.authorization.appliedSettingsRevision).toBe(2n);
    expect(store.authorization.appliedSkillsRevision).toBe(2);
    expect(store.authorization.workCheckpoint).toBe("applied");
    expect(store.observations).toEqual([expect.objectContaining({
      piState: "idle",
      piInvocationId: PI_INVOCATION_ID,
      appliedSettingsRevision: 2n,
      appliedSkillsRevision: 2,
    })]);
    expect(store.recordedMaterialSnapshots).toEqual([{
      clientSurface: "web",
      materialExpiresAt: new Date("2026-08-16T18:00:00.000Z"),
      agentEndpoint: null,
    }]);
    expect(store.publishedMaterialSnapshots).toEqual([PI_INVOCATION_ID]);
    expect(store.settlements).toEqual([{ terminalStatus: "succeeded" }]);
  });

  it("does not publish revisions when Pi cannot expose a new idle invocation", async () => {
    const claim = settingsClaim();
    const store = new MemoryRuntimeStore({
      authorization: settingsAuthorization(claim),
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

    const result = await new RuntimeEngine(engineDependencies({ store, ports })).execute(claim);

    expect(result.outcome).toBe("failed");
    expect(stages).toBe(1);
    expect(store.authorization.piInvocationId).toBe("old-pi-invocation");
    expect(store.authorization.appliedSettingsRevision).toBe(1n);
    expect(store.authorization.appliedSkillsRevision).toBe(1);
    expect(store.authorization.workCheckpoint).toBe("applying");
    expect(store.observations).toHaveLength(0);
    expect(store.recordedMaterialSnapshots).toHaveLength(1);
    expect(store.publishedMaterialSnapshots).toHaveLength(0);
    expect(store.settlements[0]?.error?.code).toBe("pi_start_failed");
  });

  it("activates native-mobile settings with the unified Skills and MCP layout", async () => {
    const claim = settingsClaim({
      clientSurface: "native_mobile",
      targetSkillsRevision: 1,
    });
    const store = new MemoryRuntimeStore({
      authorization: settingsAuthorization(claim, {
        clientSurface: "native_mobile",
        skillsRevision: 1,
      }),
    });
    const ports = fakePorts(store);
    ports.resourceStager.stageExistingBox = async (input) => {
      expect(input.clientSurface).toBe("native_mobile");
      expect(input.targetSkillsRevision).toBe(1);
      return {
        diskLayoutVersion: 14,
        appliedSettingsRevision: input.targetSettingsRevision,
        appliedSkillsRevision: input.targetSkillsRevision,
        materialExpiresAt: new Date("2026-08-16T18:00:00.000Z"),
      };
    };
    ports.pi.restartPiDaemon = async () => ({
      state: "idle",
      invocationId: "native-settings-pi",
    });

    const result = await new RuntimeEngine(engineDependencies({ store, ports })).execute(claim);

    expect(result.outcome).toBe("succeeded");
    expect(store.authorization.piInvocationId).toBe("native-settings-pi");
    expect(store.authorization.appliedSettingsRevision).toBe(2n);
    expect(store.authorization.appliedSkillsRevision).toBe(1);
    expect(store.observations).toEqual([expect.objectContaining({
      piState: "idle",
      piInvocationId: "native-settings-pi",
      appliedSettingsRevision: 2n,
      appliedSkillsRevision: 1,
    })]);
    expect(store.recordedMaterialSnapshots).toEqual([{
      clientSurface: "native_mobile",
      materialExpiresAt: new Date("2026-08-16T18:00:00.000Z"),
      agentEndpoint: null,
    }]);
    expect(store.publishedMaterialSnapshots).toEqual(["native-settings-pi"]);
  });

  it("repeats stage and restart after takeover when the activation observation was lost", async () => {
    const claim = settingsClaim();
    const store = new MemoryRuntimeStore({
      authorization: settingsAuthorization(claim),
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

    const durableObserve = store.observeInstance.bind(store);
    store.observeInstance = async () => null;
    const first = await new RuntimeEngine(engineDependencies({ store, ports })).execute(claim);

    expect(first.outcome).toBe("fence_lost");
    expect(store.authorization.piInvocationId).toBe("old-pi-invocation");
    expect(store.authorization.appliedSettingsRevision).toBe(1n);
    expect(store.settlements).toHaveLength(0);

    store.observeInstance = durableObserve;
    const takeover = await new RuntimeEngine(engineDependencies({ store, ports })).execute(
      settingsClaim({ claimEpoch: 2n }),
    );

    expect(takeover.outcome).toBe("succeeded");
    expect(stages).toBe(2);
    expect(restarts).toBe(2);
    expect(store.recordedMaterialSnapshots).toHaveLength(2);
    expect(store.publishedMaterialSnapshots).toEqual(["settings-pi-2"]);
    expect(store.authorization.piInvocationId).toBe("settings-pi-2");
    expect(store.authorization.appliedSettingsRevision).toBe(2n);
    expect(store.authorization.workCheckpoint).toBe("applied");
    expect(store.settlements).toEqual([{ terminalStatus: "succeeded" }]);
  });
});
