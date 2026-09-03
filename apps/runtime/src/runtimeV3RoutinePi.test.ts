import type { RuntimeV3PiTransport } from "@companion/companion-runtime/runtime-support";
import { describe, expect, it, vi } from "vitest";

import { createRuntimeV3RoutinePi } from "./runtimeV3RoutinePi";

const boxId = "bx_23456789";
const turnId = "11111111-1111-4111-8111-111111111111";
const commandId = "22222222-2222-4222-8222-222222222222";
const invocationId = `background:${turnId}:dispatch-v3:${commandId}`;

function control(overrides: Partial<NonNullable<RuntimeV3PiTransport["routineSession"]>> = {}) {
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
  it("starts trigger validation without skills, plugins, trusted workspace context, or control MCP", async () => {
    const { pi, routine } = control();
    const adapter = createRuntimeV3RoutinePi(pi);

    await expect(adapter.prompt({
      boxId,
      turnId,
      commandId,
      expectedInvocationId: invocationId,
      message: "External, untrusted webhook payload.",
      persona: "A careful teammate.",
      validationOnly: true,
      directWorkspace: false,
    })).resolves.toMatchObject({ outcome: "accepted", invocationId });
    expect(routine.start).toHaveBeenCalledWith(expect.objectContaining({
      validationOnly: true,
      directWorkspace: false,
    }));
  });

  it("retries only a start failure proven clean before prompt dispatch", async () => {
    const start = vi.fn().mockRejectedValue(new Error("spawn failed"));
    const { pi, routine } = control({ start });
    const adapter = createRuntimeV3RoutinePi(pi);

    await expect(adapter.prompt({
      boxId, turnId, commandId, expectedInvocationId: invocationId, message: "Run once.",
    })).resolves.toEqual({ outcome: "rejected", code: "routine_start_failed" });
    expect(routine.prompt).not.toHaveBeenCalled();
    expect(routine.terminate).toHaveBeenCalledOnce();
  });

  it("keeps an explicit Pi prompt rejection retryable", async () => {
    const prompt = vi.fn().mockResolvedValue({
      outcome: "rejected" as const, code: "pi_prompt_refused",
    });
    const { pi, routine } = control({ prompt });
    const adapter = createRuntimeV3RoutinePi(pi);

    await expect(adapter.prompt({
      boxId, turnId, commandId, expectedInvocationId: invocationId, message: "Run once.",
    })).resolves.toEqual({ outcome: "rejected", code: "pi_prompt_refused" });
    expect(routine.terminate).not.toHaveBeenCalled();
  });

  it("never retries when Pi prompt acceptance may have committed before its ACK was lost", async () => {
    const prompt = vi.fn().mockRejectedValue(new Error("prompt ACK timed out"));
    const { pi, routine } = control({ prompt });
    const adapter = createRuntimeV3RoutinePi(pi);

    await expect(adapter.prompt({
      boxId, turnId, commandId, expectedInvocationId: invocationId, message: "Run once.",
    })).resolves.toEqual({ outcome: "ambiguous", code: "routine_prompt_outcome_unknown" });
    expect(routine.terminate).not.toHaveBeenCalled();
  });

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

  it("keeps a resumed routine alive until a terminal page is acknowledged", async () => {
    const read = vi.fn()
      .mockResolvedValueOnce({
        events: [{
          sequence: 1,
          invocationId,
          attemptId: turnId,
          kind: "pi_event",
          event: { type: "message_update" },
        }],
        nextCursor: 1,
        acknowledgedCursor: 0,
        hasMore: false,
      })
      .mockResolvedValueOnce({
        events: [{
          sequence: 2,
          invocationId,
          attemptId: turnId,
          kind: "pi_event",
          event: { type: "agent_settled" },
        }],
        nextCursor: 2,
        acknowledgedCursor: 1,
        hasMore: false,
      });
    const { pi, routine } = control({ read });
    const adapter = createRuntimeV3RoutinePi(pi);

    await adapter.read({ boxId, turnId, invocationId, after: 0n });
    await expect(adapter.acknowledge({
      boxId, turnId, invocationId, through: 1n,
    })).resolves.toBe(1n);
    expect(routine.ack).toHaveBeenCalledWith(expect.objectContaining({ runId: turnId, through: 1n }));
    expect(routine.terminate).not.toHaveBeenCalled();

    await adapter.read({ boxId, turnId, invocationId, after: 1n });
    await expect(adapter.acknowledge({
      boxId, turnId, invocationId, through: 2n,
    })).resolves.toBe(2n);
    expect(routine.terminate).toHaveBeenCalledOnce();
    expect(routine.terminate).toHaveBeenCalledWith(expect.objectContaining({
      runId: turnId,
      expectedInvocationId: invocationId,
    }));
  });

  it("terminates only the exact persisted routine invocation during cleanup", async () => {
    const { pi, routine } = control();
    const adapter = createRuntimeV3RoutinePi(pi);
    if (!adapter.terminate) throw new Error("routine cleanup termination is unavailable");

    await expect(adapter.terminate({
      boxId,
      turnId,
      invocationId,
    })).resolves.toBeUndefined();
    expect(routine.terminate).toHaveBeenCalledOnce();
    expect(routine.terminate).toHaveBeenCalledWith(expect.objectContaining({
      boxId,
      runId: turnId,
      expectedInvocationId: invocationId,
    }));
  });
});
