/**
 * Product promise: callers admit intent and request convergence without owning lease choreography.
 * Regression guarded: a blocked main Turn must never stop later background Turns from progressing.
 * Why unit-level: deterministic deferred promises expose scheduling at the public module boundary.
 * Sensitivity: serializing the lane loops or returning arbitrary failure text makes these fail.
 */
import { describe, expect, it, vi } from "vitest";

import {
  createRuntimeV3Progression,
  createRuntimeV3WarmTurnAdvance,
  type RuntimeV3Claim,
  type RuntimeV3ConvergencePersistence,
  type RuntimeV3ProgressionPersistence,
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
      claimLane: vi.fn().mockResolvedValue(null),
      completeProgression: vi.fn().mockResolvedValue(true),
      ...overrides,
    },
  };
}

describe("Runtime v3 progression interface", () => {
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
      cursor: 0n,
    });
    expect(warm.project).toHaveBeenCalledWith(mainClaim, expect.objectContaining({
      throughCursor: 2n,
      settled: true,
      assistant: [{
        eventId: expect.stringMatching(/^v3:/),
        content: "The incident is resolved.",
      }],
    }));
    expect(pi.acknowledge).toHaveBeenCalledWith(expect.objectContaining({ through: 2n }));
    expect(store.convergence.completeProgression).toHaveBeenCalledWith(
      mainClaim,
      { kind: "succeeded" },
    );
  });

  it("fails closed without contacting Pi when fenced warm authorization is unavailable", async () => {
    const claims: ClaimQueues = { main: [mainClaim, null], background: [null] };
    const store = persistence({ claimLane: vi.fn(claimFrom(claims)) });
    const warm = {
      authorize: vi.fn().mockResolvedValue(null),
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
