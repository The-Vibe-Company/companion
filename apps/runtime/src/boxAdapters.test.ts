/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion, anti-slop/no-chained-type-assertions, anti-slop/no-unsafe-dictionary-type, anti-slop/no-known-value-widening -- Lifecycle fixtures are hand-written fakes matching the used client surface exactly. */
import { describe, expect, it, vi } from "vitest";
import { BoxRuntimeAdapterError, type BoxRuntimeLifecycleClient, type CompanionBoxRuntimeV2 } from "@companion/box-runtime";
import type { RuntimeProcessLog } from "@companion/companion-runtime";

import {
  createRuntimeBoxControl,
  createRuntimePiControl,
  type RuntimeImageSource,
} from "./boxAdapters";

const signal = new AbortController().signal;
const deadlineAt = new Date("2027-01-01T00:00:00.000Z");

function runtimeImage(overrides: Partial<RuntimeImageSource> = {}): RuntimeImageSource {
  return {
    expectedName: () => "companion-l14-aaaaaaaaaaaa",
    availability: async () => "failed",
    ...overrides,
  };
}

function capturingLog(): { log: RuntimeProcessLog; records: Record<string, unknown>[] } {
  const records: Record<string, unknown>[] = [];
  return {
    records,
    log: {
      error(record) { records.push({ level: "error", ...record }); },
      warn(record) { records.push({ level: "warn", ...record }); },
      info(record) { records.push({ level: "info", ...record }); },
    },
  };
}

function lifecycle(overrides: Partial<BoxRuntimeLifecycleClient> = {}): BoxRuntimeLifecycleClient {
  const createAfterAbsence = overrides.createGenerationBoxAfterObservedAbsence
    ?? overrides.createOrRecoverGenerationBox
    ?? vi.fn();
  return {
    listAllBoxes: vi.fn(),
    requestPermanentDeletion: vi.fn(),
    getDeletionOperation: vi.fn(),
    findGenerationBoxes: vi.fn(),
    createOrRecoverGenerationBox: createAfterAbsence,
    createGenerationBoxAfterObservedAbsence: createAfterAbsence,
    applyGenerationBoxSettings: vi.fn(),
    deletePermanentlyAndWait: vi.fn(),
    ...overrides,
  } as BoxRuntimeLifecycleClient;
}

function boxRuntime(overrides: Partial<CompanionBoxRuntimeV2> = {}): CompanionBoxRuntimeV2 {
  return {
    layoutIdentity: () => ({ fullMarker: "layout-current" }),
    ...overrides,
  } as CompanionBoxRuntimeV2;
}

describe("runtime Box/Pi port adapters", () => {
  it("uses only generation-qualified lifecycle create and exact provider status", async () => {
    const findGenerationBoxes = vi.fn(async () => ({
      name: "Companion 11111111-1111-4111-8111-111111111111 g4",
      canonical: { id: "bx_23456789", name: "canonical" },
      duplicates: [],
    }));
    const createOrRecoverGenerationBox = vi.fn(async () => ({
      outcome: "created" as const,
      boxId: "bx_23456789",
      name: "canonical",
    }));
    const existingBoxStatus = vi.fn(async () => ({
      boxId: "bx_23456789",
      state: "archiving" as const,
    }));
    const control = createRuntimeBoxControl({
      lifecycle: lifecycle({ findGenerationBoxes, createOrRecoverGenerationBox }),
      runtime: () => boxRuntime({ existingBoxStatus }),
      now: () => deadlineAt.getTime() - 10_000,
    });

    await control.findGenerationBoxes({
      companionId: "11111111-1111-4111-8111-111111111111",
      generation: 4n,
      deadlineAt,
      signal,
    });
    await expect(control.createGenerationBox({
      companionId: "11111111-1111-4111-8111-111111111111",
      generation: 4n,
      ttlSeconds: 21_600,
      deadlineAt,
      signal,
    })).resolves.toMatchObject({ outcome: "created", boxId: "bx_23456789" });
    await expect(control.getStatus({ boxId: "bx_23456789", signal }))
      .resolves.toEqual({ state: "archiving" });

    expect(findGenerationBoxes).toHaveBeenCalledWith(expect.objectContaining({
      generation: 4,
      deadlineAt,
      signal,
    }));
    expect(createOrRecoverGenerationBox).toHaveBeenCalledWith(expect.objectContaining({
      generation: 4,
      ttlSeconds: 21_600,
      deadlineAt,
      signal,
    }));
    expect(existingBoxStatus).toHaveBeenCalledWith({
      boxId: "bx_23456789",
      signal,
    });
  });

  it("proves the durable Box identity with the direct status GET", async () => {
    const existingBoxStatus = vi.fn(async () => ({
      boxId: "bx_23456789",
      state: "archived" as const,
    }));
    const control = createRuntimeBoxControl({
      lifecycle: lifecycle(),
      runtime: () => boxRuntime({ existingBoxStatus }),
    });

    await expect(control.getStatus({
      boxId: "bx_23456789",
      companionId: "11111111-1111-4111-8111-111111111111",
      generation: 4n,
      signal,
    })).resolves.toEqual({ state: "archived" });
    expect(existingBoxStatus).toHaveBeenCalledWith({
      boxId: "bx_23456789",
      companionId: "11111111-1111-4111-8111-111111111111",
      runtimeGeneration: 4,
      signal,
    });
  });

  it("gives an unknown-snapshot cold fallback a fresh create budget within the work deadline", async () => {
    let currentTime = 1_000_000;
    const createOrRecoverGenerationBox = vi.fn()
      .mockImplementationOnce(async () => {
        currentTime += 29_999;
        throw new BoxRuntimeAdapterError({
          stableCode: "box_not_found",
          message: "The Box provider resource was not found",
          status: 404,
          providerCode: "unknown_snapshot",
          retryable: false,
          outcomeUnknown: false,
        });
      })
      .mockResolvedValue({
        outcome: "created" as const,
        boxId: "bx_23456789",
        name: "canonical",
      });
    const control = createRuntimeBoxControl({
      lifecycle: lifecycle({ createOrRecoverGenerationBox }),
      runtime: () => boxRuntime(),
      runtimeImage: runtimeImage({ availability: async () => "ready" }),
      providerDeadlineMs: 30_000,
      now: () => currentTime,
    });

    await expect(control.createGenerationBox({
      companionId: "11111111-1111-4111-8111-111111111111",
      generation: 4n,
      ttlSeconds: 21_600,
      idempotencyKey: "11111111-1111-4111-8111-111111111111",
      deadlineAt: new Date(1_030_000),
      workDeadlineAt: new Date(1_180_000),
      signal,
    })).resolves.toMatchObject({ outcome: "created", boxId: "bx_23456789" });

    expect(createOrRecoverGenerationBox).toHaveBeenNthCalledWith(1, expect.objectContaining({
      from: "companion-l14-aaaaaaaaaaaa",
      idempotencyKey: "11111111-1111-4111-8111-111111111111",
      deadlineAt: new Date(1_030_000),
    }));
    expect(createOrRecoverGenerationBox).toHaveBeenNthCalledWith(2, expect.objectContaining({
      deadlineAt: new Date(1_059_999),
    }));
    expect(createOrRecoverGenerationBox.mock.calls[1]?.[0]).not.toEqual(expect.objectContaining({
      from: expect.anything(),
    }));
    expect(createOrRecoverGenerationBox.mock.calls[1]?.[0].idempotencyKey)
      .toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(createOrRecoverGenerationBox.mock.calls[1]?.[0].idempotencyKey)
      .not.toBe("11111111-1111-4111-8111-111111111111");
  });

  it.each([
    ["missing", "image_missing"],
    ["requested", "image_build_pending"],
    ["building", "image_build_pending"],
    ["stale", "image_build_stale"],
    ["failed", "image_build_failed"],
  ] as const)("cold-installs immediately when image state is %s", async (availability, reason) => {
    const createOrRecoverGenerationBox = vi.fn(async () => ({
      outcome: "created" as const,
      boxId: "bx_23456789",
      name: "canonical",
    }));
    const fallbacks: string[] = [];
    const captured = capturingLog();
    const control = createRuntimeBoxControl({
      lifecycle: lifecycle({ createOrRecoverGenerationBox }),
      runtime: () => boxRuntime(),
      runtimeImage: runtimeImage({ availability: async () => availability }),
      onColdFallback: (fallback) => fallbacks.push(fallback),
      log: captured.log,
      now: () => 1_000_000,
    });

    await expect(control.createGenerationBox({
      companionId: "11111111-1111-4111-8111-111111111111",
      generation: 4n,
      ttlSeconds: 21_600,
      deadlineAt,
      signal,
    })).resolves.toMatchObject({ outcome: "created", boxId: "bx_23456789" });

    expect(createOrRecoverGenerationBox).toHaveBeenCalledOnce();
    expect(createOrRecoverGenerationBox).toHaveBeenCalledWith(expect.not.objectContaining({
      from: expect.anything(),
    }));
    expect(fallbacks).toEqual([reason]);
    expect(captured.records).toEqual([expect.objectContaining({
      event: "runtime.box.create",
      fallbackReason: reason,
      fromImage: null,
      imageLookupMs: 0,
    })]);
  });

  it("clones only when the registry proves the exact image ready", async () => {
    const createOrRecoverGenerationBox = vi.fn(async () => ({
      outcome: "created" as const,
      boxId: "bx_23456789",
      name: "canonical",
    }));
    const control = createRuntimeBoxControl({
      lifecycle: lifecycle({ createOrRecoverGenerationBox }),
      runtime: () => boxRuntime(),
      runtimeImage: runtimeImage({ availability: async () => "ready" }),
    });

    await control.createGenerationBox({
      companionId: "11111111-1111-4111-8111-111111111111",
      generation: 4n,
      ttlSeconds: 21_600,
      deadlineAt,
      signal,
    });

    expect(createOrRecoverGenerationBox).toHaveBeenCalledWith(expect.objectContaining({
      from: "companion-l14-aaaaaaaaaaaa",
    }));
  });

  it("cold-installs when the registry lookup fails without surfacing a chat failure", async () => {
    const createOrRecoverGenerationBox = vi.fn(async () => ({
      outcome: "created" as const,
      boxId: "bx_23456789",
      name: "canonical",
    }));
    const fallbacks: string[] = [];
    const control = createRuntimeBoxControl({
      lifecycle: lifecycle({ createOrRecoverGenerationBox }),
      runtime: () => boxRuntime(),
      runtimeImage: runtimeImage({
        availability: async () => { throw new Error("registry unavailable"); },
      }),
      onColdFallback: (reason) => fallbacks.push(reason),
    });

    await expect(control.createGenerationBox({
      companionId: "11111111-1111-4111-8111-111111111111",
      generation: 4n,
      ttlSeconds: 21_600,
      deadlineAt,
      signal,
    })).resolves.toMatchObject({ outcome: "created" });
    expect(fallbacks).toEqual(["image_registry_unavailable"]);
  });

  it("keeps provisioned and cloning in the provisioning bucket until the Box is ready", async () => {
    const existingBoxStatus = vi.fn()
      .mockResolvedValueOnce({ boxId: "bx_23456789", state: "provisioned" as const })
      .mockResolvedValueOnce({ boxId: "bx_23456789", state: "cloning" as const })
      .mockResolvedValueOnce({ boxId: "bx_23456789", state: "idle" as const });
    const control = createRuntimeBoxControl({
      lifecycle: lifecycle(),
      runtime: () => boxRuntime({ existingBoxStatus }),
    });

    await expect(control.getStatus({ boxId: "bx_23456789", signal }))
      .resolves.toEqual({ state: "provisioning" });
    await expect(control.getStatus({ boxId: "bx_23456789", signal }))
      .resolves.toEqual({ state: "provisioning" });
    await expect(control.getStatus({ boxId: "bx_23456789", signal }))
      .resolves.toEqual({ state: "idle" });
  });

  it("forwards a present but invalid Companion identity instead of dropping its ownership proof", async () => {
    const existingBoxStatus = vi.fn(async () => {
      throw new Error("invalid Companion identity");
    });
    const control = createRuntimeBoxControl({
      lifecycle: lifecycle(),
      runtime: () => boxRuntime({ existingBoxStatus }),
    });

    await expect(control.getStatus({
      boxId: "bx_23456789",
      companionId: "",
      generation: 4n,
      signal,
    })).rejects.toThrow("invalid Companion identity");
    expect(existingBoxStatus).toHaveBeenCalledWith({
      boxId: "bx_23456789",
      companionId: "",
      runtimeGeneration: 4,
      signal,
    });
  });

  it("adds an explicit provider deadline to delete work without a turn deadline", async () => {
    const requestPermanentDeletion = vi.fn(async () => ({
      outcome: "accepted" as const,
      operation: {
        id: "bdop_11111111111111111111111111111111",
        targetId: "bx_23456789",
        status: "pending" as const,
        attemptCount: 0,
        requestedAt: "2027-01-01T00:00:00.000Z",
        completedAt: null,
      },
    }));
    const getDeletionOperation = vi.fn(async () => ({
      id: "bdop_11111111111111111111111111111111",
      targetId: "bx_23456789",
      status: "completed" as const,
      attemptCount: 1,
      requestedAt: "2027-01-01T00:00:00.000Z",
      completedAt: "2027-01-01T00:00:01.000Z",
    }));
    const control = createRuntimeBoxControl({
      lifecycle: lifecycle({ requestPermanentDeletion, getDeletionOperation }),
      runtime: () => boxRuntime(),
      providerDeadlineMs: 12_000,
      now: () => 1_000,
    });

    await expect(control.requestPermanentDeletion({ boxId: "bx_23456789", signal }))
      .resolves.toEqual({
        outcome: "accepted",
        operationId: "bdop_11111111111111111111111111111111",
      });
    await expect(control.pollPermanentDeletion({
      boxId: "bx_23456789",
      operationId: "bdop_11111111111111111111111111111111",
      signal,
    })).resolves.toEqual({ status: "completed" });
    expect(requestPermanentDeletion).toHaveBeenCalledWith(expect.objectContaining({
      deadlineAt: new Date(13_000),
      signal,
    }));
    expect(getDeletionOperation).toHaveBeenCalledWith(expect.objectContaining({
      deadlineAt: new Date(13_000),
      signal,
    }));
  });

  it("maps the broker's positive ACK directly without a second post-effect probe", async () => {
    const dispatchPrompt = vi.fn(async () => ({
      outcome: "accepted" as const,
      attemptId: "attempt-1",
      invocationId: "invocation-1",
      initialCursor: 7,
    }));
    const brokerState = vi.fn();
    const factory = vi.fn(() => boxRuntime({ dispatchPrompt, brokerState }));
    const pi = createRuntimePiControl({ lifecycle: lifecycle(), runtime: factory });

    await expect(pi.prompt({
      boxId: "bx_23456789",
      commandId: "command-1",
      attemptId: "attempt-1",
      expectedInvocationId: "invocation-1",
      message: "hello",
      signal,
    })).resolves.toEqual({
      outcome: "accepted",
      invocationId: "invocation-1",
      initialCursor: 7n,
    });
    expect(factory).toHaveBeenCalledOnce();
    expect(dispatchPrompt).toHaveBeenCalledWith({
      boxId: "bx_23456789",
      requestId: "command-1",
      attemptId: "attempt-1",
      expectedInvocationId: "invocation-1",
      message: "hello",
      signal,
    });
    expect(brokerState).not.toHaveBeenCalled();
  });

  it("maps a Pi abort ACK without probing broker state afterwards", async () => {
    const dispatchAbort = vi.fn(async () => ({
      outcome: "accepted" as const,
      attemptId: "attempt-1",
      invocationId: "invocation-1",
    }));
    const brokerState = vi.fn();
    const factory = vi.fn(() => boxRuntime({ dispatchAbort, brokerState }));
    const pi = createRuntimePiControl({ lifecycle: lifecycle(), runtime: factory });

    await expect(pi.abort({
      boxId: "bx_23456789",
      commandId: "command-abort",
      attemptId: "attempt-1",
      signal,
    })).resolves.toEqual({ outcome: "accepted", invocationId: "invocation-1" });
    expect(dispatchAbort).toHaveBeenCalledWith({
      boxId: "bx_23456789",
      requestId: "command-abort",
      attemptId: "attempt-1",
      signal,
    });
    expect(brokerState).not.toHaveBeenCalled();
  });

  it("delegates exact main Pi termination without widening it to a daemon stop", async () => {
    const terminatePiInvocation = vi.fn(async () => ({ outcome: "superseded" as const }));
    const stopPiDaemon = vi.fn(async () => undefined);
    const pi = createRuntimePiControl({
      lifecycle: lifecycle(),
      runtime: () => boxRuntime({ terminatePiInvocation, stopPiDaemon }),
    });

    await expect(pi.terminatePiInvocation({
      boxId: "bx_23456789",
      expectedInvocationId: "invocation-interrupted",
      signal,
    })).resolves.toEqual({ outcome: "superseded" });

    expect(terminatePiInvocation).toHaveBeenCalledWith({
      boxId: "bx_23456789",
      expectedInvocationId: "invocation-interrupted",
      signal,
    });
    expect(stopPiDaemon).not.toHaveBeenCalled();
  });

  it("preserves refusal/ambiguity and converts broker cursors without precision loss", async () => {
    const dispatchPrompt = vi.fn()
      .mockResolvedValueOnce({ outcome: "refused", code: "pi_busy", message: "ignored" })
      .mockResolvedValueOnce({ outcome: "ambiguous", code: "pi_ack_ambiguous", message: "ignored" });
    const ackEvents = vi.fn(async () => ({ acknowledgedCursor: 42 }));
    const readEvents = vi.fn(async () => ({
      events: [], nextCursor: 42, acknowledgedCursor: 42, hasMore: false,
    }));
    const pi = createRuntimePiControl({
      lifecycle: lifecycle(),
      runtime: () => boxRuntime({
        dispatchPrompt,
        ackEvents,
        readEvents: readEvents as unknown as CompanionBoxRuntimeV2["readEvents"],
      }),
    });
    const request = {
      boxId: "bx_23456789",
      commandId: "command-1",
      attemptId: "attempt-1",
      expectedInvocationId: "invocation-1",
      message: "hello",
      signal,
    };
    await expect(pi.prompt(request)).resolves.toEqual({ outcome: "rejected", code: "pi_busy" });
    await expect(pi.prompt(request)).resolves.toEqual({
      outcome: "ambiguous",
      code: "pi_ack_ambiguous",
    });
    await expect(pi.readBrokerEvents({ boxId: "bx_23456789", after: 41n, signal }))
      .resolves.toMatchObject({ nextCursor: 42 });
    await expect(pi.ackBrokerEvents({ boxId: "bx_23456789", through: 42n, signal }))
      .resolves.toBe(42n);
    expect(readEvents).toHaveBeenCalledWith({ boxId: "bx_23456789", after: 41, signal });
    expect(ackEvents).toHaveBeenCalledWith({ boxId: "bx_23456789", through: 42, signal });
    await expect(pi.readBrokerEvents({
      boxId: "bx_23456789",
      after: BigInt(Number.MAX_SAFE_INTEGER) + 1n,
      signal,
    })).rejects.toThrow(/safe integer range/);
  });

  it("addresses every routine Pi operation by run id and exposes terminal teardown", async () => {
    const runId = "11111111-1111-4111-8111-111111111111";
    const routineInvocationId = `routine:${runId}:dispatch-v2:invocation`;
    const startRoutineSession = vi.fn(async () => ({ state: "idle" as const, invocationId: routineInvocationId }));
    const routineSessionState = vi.fn(async () => ({
      invocationId: routineInvocationId,
      layoutMarker: "layout-current",
      activeAttemptId: null,
      tailCursor: 0,
      acknowledgedCursor: 0,
      counters: {
        malformedLines: 0,
        oversizedLines: 0,
        unterminatedLines: 0,
        unknownEvents: 0,
        unboundEvents: 0,
        orphanResponses: 0,
      },
      modelInput: ["text" as const],
    }));
    const dispatchRoutinePrompt = vi.fn(async () => ({
      outcome: "accepted" as const,
      attemptId: "attempt-1",
      invocationId: routineInvocationId,
      initialCursor: 0,
    }));
    const readRoutineEvents = vi.fn(async () => ({
      events: [], nextCursor: 0, acknowledgedCursor: 0, hasMore: false,
    }));
    const ackRoutineEvents = vi.fn(async () => ({ acknowledgedCursor: 0 }));
    const dispatchRoutineAbort = vi.fn(async () => ({
      outcome: "accepted" as const,
      attemptId: "attempt-1",
      invocationId: routineInvocationId,
    }));
    const terminateRoutineSession = vi.fn(async () => undefined);
    const pi = createRuntimePiControl({
      lifecycle: lifecycle(),
      runtime: () => boxRuntime({
        startRoutineSession,
        routineSessionState,
        dispatchRoutinePrompt,
        readRoutineEvents,
        ackRoutineEvents,
        dispatchRoutineAbort,
        terminateRoutineSession,
      }),
    });
    const routine = pi.routineSession;
    expect(routine).toBeDefined();

    await expect(routine!.start({
      boxId: "bx_23456789",
      runId,
      persona: "Routine persona",
      validationOnly: true,
      expectedInvocationId: routineInvocationId,
      signal,
    })).resolves.toEqual({
      state: "idle",
      invocationId: routineInvocationId,
    });
    await expect(routine!.state({ boxId: "bx_23456789", runId, signal }))
      .resolves.toMatchObject({ invocationId: routineInvocationId });
    await expect(routine!.prompt({
      boxId: "bx_23456789",
      runId,
      commandId: "command-1",
      attemptId: "attempt-1",
      expectedInvocationId: routineInvocationId,
      message: "routine prompt",
      signal,
    })).resolves.toMatchObject({ outcome: "accepted", initialCursor: 0n });
    await expect(routine!.read({ boxId: "bx_23456789", runId, after: 0n, signal }))
      .resolves.toMatchObject({ nextCursor: 0 });
    await expect(routine!.ack({ boxId: "bx_23456789", runId, through: 0n, signal })).resolves.toBe(0n);
    await expect(routine!.abort({
      boxId: "bx_23456789", runId, commandId: "command-abort", attemptId: "attempt-1", signal,
    })).resolves.toMatchObject({ outcome: "accepted" });
    await expect(routine!.terminate({
      boxId: "bx_23456789",
      runId,
      expectedInvocationId: routineInvocationId,
      signal,
    })).resolves.toBeUndefined();

    expect(startRoutineSession).toHaveBeenCalledWith({
      boxId: "bx_23456789",
      runId,
      persona: "Routine persona",
      validationOnly: true,
      expectedInvocationId: routineInvocationId,
      signal,
    });
    expect(routineSessionState).toHaveBeenCalledWith({ boxId: "bx_23456789", runId, signal });
    expect(dispatchRoutinePrompt).toHaveBeenCalledWith(expect.objectContaining({
      boxId: "bx_23456789", runId, requestId: "command-1", signal,
    }));
    expect(readRoutineEvents).toHaveBeenCalledWith({ boxId: "bx_23456789", runId, after: 0, signal });
    expect(ackRoutineEvents).toHaveBeenCalledWith({ boxId: "bx_23456789", runId, through: 0, signal });
    expect(dispatchRoutineAbort).toHaveBeenCalledWith(expect.objectContaining({
      boxId: "bx_23456789", runId, requestId: "command-abort", signal,
    }));
    expect(terminateRoutineSession).toHaveBeenCalledWith({
      boxId: "bx_23456789",
      runId,
      expectedInvocationId: routineInvocationId,
      signal,
    });
  });
});
