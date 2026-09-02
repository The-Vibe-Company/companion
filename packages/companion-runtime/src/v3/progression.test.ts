import { describe, expect, it, vi } from "vitest";

import {
  createRuntimeV3Progression,
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
  },
};

function persistence(
  overrides: Partial<RuntimeV3ProgressionPersistence> = {},
): RuntimeV3ProgressionPersistence {
  return {
    admitTurn: vi.fn().mockResolvedValue(acceptedTurn),
    recordDesiredLifecycle: vi.fn().mockResolvedValue({
      intent: "archive",
      revision: 2n,
    }),
    claimAvailable: vi.fn().mockResolvedValue([]),
    completeProgression: vi.fn().mockResolvedValue(true),
    ...overrides,
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
    const store = persistence({
      claimAvailable: vi.fn()
        .mockResolvedValueOnce([mainClaim])
        .mockResolvedValueOnce([]),
    });
    const progression = createRuntimeV3Progression({ persistence: store, advance });

    await expect(progression.converge({ executorId: "runtime-1" }))
      .resolves.toEqual({ progressed: 1, exhausted: false });
    expect(advance).toHaveBeenCalledWith(mainClaim);
    expect(store.completeProgression).toHaveBeenCalledWith(mainClaim, { kind: "release" });
  });

  it("advances main and background claims independently", async () => {
    let releaseMain!: () => void;
    const mainWait = new Promise<void>((resolve) => {
      releaseMain = resolve;
    });
    const background = {
      orgId: mainClaim.orgId,
      companionId: mainClaim.companionId,
      turn: { ...acceptedTurn, id: "17307732-d811-4eb8-af79-0ae7e7942390", lane: "background" as const },
      fence: { token: "a60fa0eb-e514-4453-94ef-d6668220fb85", epoch: 7n },
    };
    const completed: string[] = [];
    const store = persistence({
      claimAvailable: vi.fn()
        .mockResolvedValueOnce([mainClaim, background])
        .mockResolvedValueOnce([]),
      completeProgression: vi.fn(async (claimed) => {
        completed.push(claimed.turn.lane);
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
    await vi.waitFor(() => expect(completed).toEqual(["background"]));
    releaseMain();
    await expect(convergence).resolves.toEqual({ progressed: 2, exhausted: false });
  });
});
