import type { RuntimePiControl } from "@companion/companion-runtime";
import { describe, expect, it, vi } from "vitest";

import { createRuntimeV3RoutinePi } from "./runtimeV3RoutinePi";

const boxId = "bx_23456789";
const turnId = "11111111-1111-4111-8111-111111111111";
const commandId = "22222222-2222-4222-8222-222222222222";
const invocationId = `routine:${turnId}:dispatch-v2:${commandId}`;

function control(overrides: Partial<NonNullable<RuntimePiControl["routineSession"]>> = {}) {
  const routine = {
    start: vi.fn(async () => ({ state: "idle" as const, invocationId })),
    state: vi.fn(),
    prompt: vi.fn(async () => ({
      outcome: "accepted" as const,
      invocationId,
      responseAttemptId: turnId,
      initialCursor: 0n,
    })),
    read: vi.fn(async () => ({
      events: [{
        sequence: 1,
        invocationId,
        attemptId: turnId,
        kind: "pi_event",
        event: { type: "agent_settled" },
      }],
      nextCursor: 1,
      acknowledgedCursor: 0,
      hasMore: false,
    })),
    ack: vi.fn(async ({ through }: { through: bigint }) => through),
    abort: vi.fn(async () => ({ outcome: "accepted" as const, invocationId })),
    terminate: vi.fn(async () => undefined),
    ...overrides,
  };
  return {
    pi: { routineSession: routine },
    routine,
  };
}

describe("Runtime v3 routine Pi adapter", () => {
  it("runs with the current capabilities in the durable Box workspace and terminates after ACK", async () => {
    const { pi, routine } = control();
    const adapter = createRuntimeV3RoutinePi(pi);

    await expect(adapter.prompt({
      boxId,
      turnId,
      commandId,
      expectedInvocationId: invocationId,
      message: "Inspect the durable workspace.",
      persona: "A careful teammate.",
    })).resolves.toMatchObject({ outcome: "accepted", invocationId });
    expect(routine.start).toHaveBeenCalledWith(expect.objectContaining({
      boxId,
      runId: turnId,
      persona: "A careful teammate.",
      validationOnly: false,
      directWorkspace: true,
      expectedInvocationId: invocationId,
    }));

    await expect(adapter.read({
      boxId, turnId, invocationId, after: 0n,
    })).resolves.toMatchObject({ nextCursor: 1n });
    await expect(adapter.acknowledge({
      boxId, turnId, invocationId, through: 1n,
    })).resolves.toBe(1n);
    expect(routine.terminate).toHaveBeenCalledOnce();
  });

  it("uses durable run identity to finish terminal ACK after executor takeover", async () => {
    const { pi, routine } = control();
    const adapter = createRuntimeV3RoutinePi(pi);

    await expect(adapter.acknowledge({
      boxId, turnId, invocationId, through: 9n,
    })).resolves.toBe(9n);
    expect(routine.ack).toHaveBeenCalledWith(expect.objectContaining({ runId: turnId, through: 9n }));
    expect(routine.terminate).toHaveBeenCalledWith(expect.objectContaining({
      runId: turnId,
      expectedInvocationId: invocationId,
    }));
  });
});
