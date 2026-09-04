/**
 * Product promise: callers admit intent and request convergence without owning lease choreography.
 * Regression guarded: a blocked main Turn must never stop later background Turns from progressing.
 * Why unit-level: deterministic deferred promises expose scheduling at the public module boundary.
 * Sensitivity: serializing the lane loops or returning arbitrary failure text makes these fail.
 */
import { describe, expect, it, vi } from "vitest";
import { RuntimeExternalDependencyError } from "../ports";

import {
  createRuntimeV3Lifecycle,
  createRuntimeV3DeadlineSweep,
  createRuntimeV3Preparation,
  createRuntimeV3Progression,
  createRuntimeV3WarmTurnAdvance,
  runtimeV3CommandWindow,
  runtimeV3ExternalRetryDelaySeconds,
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
  it("uses the shared jittered external ladder and clips every work source to its deadline", () => {
    const now = new Date("2026-09-03T00:00:00.000Z");
    const deadlineAt = new Date(now.getTime() + 1_000_000);
    expect([1, 2, 3, 4, 5, 6].map((failureCount) =>
      runtimeV3ExternalRetryDelaySeconds({ failureCount, jitter: 0.5, now, deadlineAt })
    )).toEqual([5, 15, 30, 60, 300, 300]);
    expect(runtimeV3ExternalRetryDelaySeconds({
      failureCount: 5,
      jitter: 1,
      now,
      deadlineAt: new Date(now.getTime() + 17_000),
    })).toBe(17);
    expect(runtimeV3ExternalRetryDelaySeconds({
      failureCount: 5,
      jitter: 1,
      now,
      deadlineAt,
    })).toBe(300);
    expect(runtimeV3ExternalRetryDelaySeconds({
      failureCount: 1,
      jitter: 0,
      now,
      deadlineAt,
    })).toBe(4);
    expect(runtimeV3ExternalRetryDelaySeconds({
      failureCount: 1,
      jitter: 1,
      now,
      deadlineAt,
    })).toBe(6);
    expect(runtimeV3ExternalRetryDelaySeconds({
      failureCount: 1,
      jitter: 0.5,
      now,
      deadlineAt: new Date(now.getTime() - 1),
    })).toBe(0);
  });

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
    const authorize = vi.fn().mockResolvedValue(null);
    const advance = createRuntimeV3WarmTurnAdvance({
      persistence: {
        authorize,
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
    expect(authorize).not.toHaveBeenCalled();
    expect(prompt).not.toHaveBeenCalled();
  });

  it("releases a recovery-deferred lane without contacting Pi", async () => {
    const prompt = vi.fn();
    const beginAdmission = vi.fn();
    const advance = createRuntimeV3WarmTurnAdvance({
      persistence: {
        authorize: vi.fn().mockResolvedValue({
          boxId: "bx_23456789", piInvocationId: "invocation-1",
          content: "wait for the reserved recovery admission", cursor: 0n,
          recoveryDeferred: true,
        }),
        beginAdmission, recordAdmission: vi.fn(), project: vi.fn(),
      },
      pi: { prompt, read: vi.fn(), acknowledge: vi.fn() },
    });

    await expect(advance(mainClaim)).resolves.toEqual({ kind: "release" });
    expect(beginAdmission).not.toHaveBeenCalled();
    expect(prompt).not.toHaveBeenCalled();
  });

  it("terminates the exact background invocation before completing durable cleanup", async () => {
    const terminate = vi.fn().mockResolvedValue(undefined);
    const prompt = vi.fn();
    const read = vi.fn();
    const advance = createRuntimeV3WarmTurnAdvance({
      persistence: {
        authorize: vi.fn(),
        beginAdmission: vi.fn(),
        recordAdmission: vi.fn(),
        project: vi.fn(),
      },
      pi: { prompt, read, acknowledge: vi.fn(), terminate },
    });
    const claim: RuntimeV3Claim = {
      ...mainClaim,
      turn: { ...acceptedTurn, lane: "background" },
      cleanup: { boxId: "bx_23456789", invocationId: "routine-invocation-1" },
    };

    await expect(advance(claim)).resolves.toEqual({ kind: "cleanup_completed" });
    expect(terminate).toHaveBeenCalledOnce();
    expect(terminate).toHaveBeenCalledWith(expect.objectContaining({
      boxId: "bx_23456789",
      turnId: acceptedTurn.id,
      invocationId: "routine-invocation-1",
    }));
    expect(prompt).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
  });

  it("retains the durable cleanup checkpoint when exact termination is not confirmed", async () => {
    const terminate = vi.fn().mockRejectedValue(new Error("termination result unavailable"));
    const advance = createRuntimeV3WarmTurnAdvance({
      persistence: {
        authorize: vi.fn(),
        beginAdmission: vi.fn(),
        recordAdmission: vi.fn(),
        project: vi.fn(),
      },
      pi: { prompt: vi.fn(), read: vi.fn(), acknowledge: vi.fn(), terminate },
    });
    const claim: RuntimeV3Claim = {
      ...mainClaim,
      turn: { ...acceptedTurn, lane: "background" },
      cleanup: { boxId: "bx_23456789", invocationId: "routine-invocation-1" },
    };

    await expect(advance(claim)).resolves.toEqual({ kind: "release" });
    expect(terminate).toHaveBeenCalledOnce();
  });

  it("releases without contacting Pi when the pre-Pi admission fence is refused", async () => {
    const prompt = vi.fn();
    const beginAdmission = vi.fn().mockResolvedValue(false);
    const advance = createRuntimeV3WarmTurnAdvance({
      persistence: {
        authorize: vi.fn().mockResolvedValue({
          boxId: "bx_23456789", piInvocationId: "invocation-1",
          content: "authorized before invalidation", cursor: 0n,
        }),
        beginAdmission,
        recordAdmission: vi.fn(),
        project: vi.fn(),
      },
      pi: { prompt, read: vi.fn(), acknowledge: vi.fn() },
    });

    await expect(advance(mainClaim)).resolves.toEqual({ kind: "release" });
    expect(beginAdmission).toHaveBeenCalledOnce();
    expect(prompt).not.toHaveBeenCalled();
  });

  it("stages authorized input files and clears the outbox before Pi admission", async () => {
    const stage = vi.fn().mockResolvedValue([{
      path: "~/attachments/2f883a91-92dd-4fec-b674-b7d250f81f61/0-notes.txt",
      contentType: "text/plain",
      byteSize: 5,
    }]);
    const clear = vi.fn().mockResolvedValue(undefined);
    const beginAdmission = vi.fn().mockResolvedValue(true);
    const prompt = vi.fn().mockResolvedValue({
      outcome: "rejected" as const,
      code: "pi_prompt_refused",
    });
    const advance = createRuntimeV3WarmTurnAdvance({
      persistence: {
        authorize: vi.fn().mockResolvedValue({
          boxId: "bx_23456789",
          piInvocationId: "invocation-1",
          content: "Read this",
          cursor: 0n,
          messageEventId: `msg:${acceptedTurn.id}`,
          inputAttachments: [{
            storageKey: "companion-attachments/object",
            contentType: "text/plain",
            byteSize: 5,
            sha256: "a".repeat(64),
            filename: "notes.txt",
            position: 0,
            expiresAt: new Date("2026-10-01T00:00:00.000Z"),
          }],
        }),
        beginAdmission,
        recordAdmission: vi.fn(),
        project: vi.fn(),
      },
      pi: {
        modelInput: vi.fn().mockResolvedValue(["text"]),
        prompt,
        read: vi.fn(),
        acknowledge: vi.fn(),
      },
      inputAttachments: { stage },
      outbox: { harvest: vi.fn(), clear },
    });

    await expect(advance(mainClaim)).resolves.toMatchObject({
      kind: "external_retry",
      failureClass: "box",
    });
    expect(stage).toHaveBeenCalledWith(expect.objectContaining({
      messageEventId: `msg:${acceptedTurn.id}`,
    }));
    expect(prompt).toHaveBeenCalledWith(expect.objectContaining({
      message: expect.stringContaining(
        "~/attachments/2f883a91-92dd-4fec-b674-b7d250f81f61/0-notes.txt (text/plain, 5 bytes)",
      ),
    }));
    expect(stage.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY)
      .toBeLessThan(clear.mock.invocationCallOrder[0] ?? Number.NEGATIVE_INFINITY);
    expect(clear.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY)
      .toBeLessThan(beginAdmission.mock.invocationCallOrder[0] ?? Number.NEGATIVE_INFINITY);
    expect(beginAdmission.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY)
      .toBeLessThan(prompt.mock.invocationCallOrder[0] ?? Number.NEGATIVE_INFINITY);
  });

  it("refuses an image before staging when Pi's live model is text-only", async () => {
    const stage = vi.fn();
    const beginAdmission = vi.fn();
    const prompt = vi.fn();
    const advance = createRuntimeV3WarmTurnAdvance({
      persistence: {
        authorize: vi.fn().mockResolvedValue({
          boxId: "bx_23456789",
          piInvocationId: "invocation-1",
          content: "Inspect this image",
          cursor: 0n,
          messageEventId: `msg:${acceptedTurn.id}`,
          inputAttachments: [{
            storageKey: "companion-attachments/object",
            contentType: "image/png",
            byteSize: 5,
            sha256: "a".repeat(64),
            filename: "image.png",
            position: 0,
            expiresAt: new Date("2026-10-01T00:00:00.000Z"),
          }],
        }),
        beginAdmission,
        recordAdmission: vi.fn(),
        project: vi.fn(),
      },
      pi: {
        modelInput: vi.fn().mockResolvedValue(["text"]),
        prompt,
        read: vi.fn(),
        acknowledge: vi.fn(),
      },
      inputAttachments: { stage },
    });

    await expect(advance(mainClaim)).resolves.toEqual({
      kind: "failed",
      code: "model_image_input_unsupported",
      message: "The selected model does not support image input.",
      action: "switch_model",
    });
    expect(stage).not.toHaveBeenCalled();
    expect(beginAdmission).not.toHaveBeenCalled();
    expect(prompt).not.toHaveBeenCalled();
  });

  it.each([
    ["pi_prompt_refused", "box", "This work is blocked because its Box is unavailable."],
    ["model_unavailable", "model", "This work is blocked until the selected model is usable again."],
    ["plugin_provider_unavailable", "plugin_provider", "This work is blocked until its plugin provider is available again."],
    ["authorization_revoked", "authority", "This work is blocked until its external access is available again."],
  ] as const)("classifies proven background refusal %s for source-preserving retry", async (
    code, failureClass, message,
  ) => {
    const dependencyKeys = {
      box: "box:companion",
      model: "model:claude-test",
      plugin_provider: "provider:anthropic",
      authority: "grant:actor:owner-1",
    } as const;
    const prompt = vi.fn().mockResolvedValue({
      outcome: "rejected" as const,
      code,
      ...(failureClass === "plugin_provider"
        ? { dependency: { kind: "provider" as const, id: "github" } }
        : failureClass === "authority"
          ? { dependency: { kind: "grant" as const, id: "account-1" } }
        : {}),
    });
    const advance = createRuntimeV3WarmTurnAdvance({
      persistence: {
        authorize: vi.fn().mockResolvedValue({
          boxId: "bx_23456789", piInvocationId: "routine-invocation-1",
          content: "run once", cursor: 0n, backgroundRoutine: true,
        }),
        beginAdmission: vi.fn().mockResolvedValue(true),
        recordAdmission: vi.fn(),
        project: vi.fn(),
      },
      pi: { prompt, read: vi.fn(), acknowledge: vi.fn() },
    });
    const claim = {
      ...mainClaim,
      source: "routine" as const,
      externalDependencyKeys: dependencyKeys,
      turn: { ...acceptedTurn, lane: "background" as const },
    };

    await expect(advance(claim)).resolves.toEqual({
      kind: "external_retry",
      failureClass,
      source: "routine",
      dependencyKey: failureClass === "plugin_provider"
        ? "provider:github"
        : failureClass === "authority"
          ? "grant:account-1"
        : dependencyKeys[failureClass],
      code,
      message,
    });
  });

  it("uses one canonical provider key for typed and singleton fallback refusals", async () => {
    const outcomes = [];
    for (const dependency of [undefined, { kind: "provider" as const, id: "github" }]) {
      const advance = createRuntimeV3WarmTurnAdvance({
        persistence: {
          authorize: vi.fn().mockResolvedValue({
            boxId: "bx_23456789", piInvocationId: "invocation-1",
            content: "provider call", cursor: 0n,
          }),
          beginAdmission: vi.fn().mockResolvedValue(true),
          recordAdmission: vi.fn(),
          project: vi.fn(),
        },
        pi: {
          prompt: vi.fn().mockResolvedValue({
            outcome: "rejected", code: "provider_unavailable", dependency,
          }),
          read: vi.fn(),
          acknowledge: vi.fn(),
        },
      });
      outcomes.push(await advance({
        ...mainClaim,
        externalDependencyKeys: {
          box: "box:companion",
          model: "model:claude-test",
          plugin_provider: "provider:github",
          authority: "grant:actor:owner-1",
        },
      }));
    }

    expect(outcomes.map((outcome) => outcome.kind === "external_retry"
      ? outcome.dependencyKey
      : null)).toEqual(["provider:github", "provider:github"]);
  });

  it.each([
    ["provider", "provider_unavailable", "plugin_provider"],
    ["grant", "authorization_revoked", "authority"],
  ] as const)("does not invent a %s incident when a multi-dependency refusal lacks identity", async (
    _kind, code, omittedClass,
  ) => {
    const advance = createRuntimeV3WarmTurnAdvance({
      persistence: {
        authorize: vi.fn().mockResolvedValue({
          boxId: "bx_23456789", piInvocationId: "invocation-1",
          content: "ambiguous dependency", cursor: 0n,
        }),
        beginAdmission: vi.fn().mockResolvedValue(true),
        recordAdmission: vi.fn(),
        project: vi.fn(),
      },
      pi: {
        prompt: vi.fn().mockResolvedValue({ outcome: "rejected", code }),
        read: vi.fn(),
        acknowledge: vi.fn(),
      },
    });
    const keys = {
      box: "box:companion",
      model: "model:claude-test",
      plugin_provider: "provider:github",
      authority: "grant:account-1",
    };
    delete keys[omittedClass];

    await expect(advance({ ...mainClaim, externalDependencyKeys: keys }))
      .resolves.toMatchObject({
        kind: "external_retry",
        failureClass: omittedClass,
        source: "main",
        dependencyKey: null,
      });
  });

  it("keeps an exact typed provider identity when the claim has multiple candidates", async () => {
    const advance = createRuntimeV3WarmTurnAdvance({
      persistence: {
        authorize: vi.fn().mockResolvedValue({
          boxId: "bx_23456789", piInvocationId: "invocation-1",
          content: "exact provider", cursor: 0n,
        }),
        beginAdmission: vi.fn().mockResolvedValue(true),
        recordAdmission: vi.fn(),
        project: vi.fn(),
      },
      pi: {
        prompt: vi.fn().mockResolvedValue({
          outcome: "rejected",
          code: "provider_unavailable",
          dependency: { kind: "provider", id: "github" },
        }),
        read: vi.fn(),
        acknowledge: vi.fn(),
      },
    });

    await expect(advance({
      ...mainClaim,
      externalDependencyKeys: { box: "box:companion", model: "model:claude-test" },
    })).resolves.toMatchObject({
      kind: "external_retry",
      failureClass: "plugin_provider",
      dependencyKey: "provider:github",
    });
  });

  it("releases an authorization reservation failure without inventing a Box incident", async () => {
    const prompt = vi.fn();
    const advance = createRuntimeV3WarmTurnAdvance({
      persistence: {
        authorize: vi.fn(async () => {
          throw new Error("authorization response lost after reservation");
        }),
        beginAdmission: vi.fn(), recordAdmission: vi.fn(), project: vi.fn(),
      },
      pi: { prompt, read: vi.fn(), acknowledge: vi.fn() },
    });

    await expect(advance(mainClaim)).resolves.toEqual({ kind: "release" });
    expect(prompt).not.toHaveBeenCalled();
  });

  it("hands off a committed pre-Pi fence when shutdown arrives before prompt", async () => {
    const controller = new AbortController();
    const prompt = vi.fn();
    const advance = createRuntimeV3WarmTurnAdvance({
      persistence: {
        authorize: vi.fn().mockResolvedValue({
          boxId: "bx_23456789", piInvocationId: "invocation-1",
          content: "fenced before shutdown", cursor: 0n,
        }),
        beginAdmission: vi.fn(async () => {
          controller.abort();
          return true;
        }),
        recordAdmission: vi.fn(), project: vi.fn(),
      },
      pi: { prompt, read: vi.fn(), acknowledge: vi.fn() },
    });

    await expect(advance(mainClaim, controller.signal)).resolves.toEqual({ kind: "release" });
    expect(prompt).not.toHaveBeenCalled();
  });

  it("hands off after a positive admission record commits as shutdown arrives", async () => {
    const controller = new AbortController();
    const prompt = vi.fn().mockResolvedValue({
      outcome: "accepted" as const, invocationId: "invocation-1", initialCursor: 0n,
    });
    const project = vi.fn();
    const advance = createRuntimeV3WarmTurnAdvance({
      persistence: {
        authorize: vi.fn().mockResolvedValue({
          boxId: "bx_23456789", piInvocationId: "invocation-1",
          content: "record before shutdown", cursor: 0n,
        }),
        beginAdmission: vi.fn().mockResolvedValue(true),
        recordAdmission: vi.fn(async () => {
          controller.abort();
          return true;
        }),
        project,
      },
      pi: { prompt, read: vi.fn(), acknowledge: vi.fn() },
    });

    await expect(advance(mainClaim, controller.signal)).resolves.toEqual({ kind: "release" });
    expect(prompt).toHaveBeenCalledOnce();
    expect(project).not.toHaveBeenCalled();
  });

  it("reclaims a cooperatively released background poll without prompting again", async () => {
    const prompt = vi.fn().mockResolvedValue({
      outcome: "accepted" as const, invocationId: "routine-invocation-1", initialCursor: 0n,
    });
    const read = vi.fn().mockResolvedValue({
      events: [], nextCursor: 0n, acknowledgedCursor: 0n, hasMore: false,
    });
    const material = {
      boxId: "bx_23456789", piInvocationId: "routine-invocation-1",
      content: "poll without new activity", cursor: 0n,
    };
    const advance = createRuntimeV3WarmTurnAdvance({
      persistence: {
        authorize: vi.fn().mockResolvedValue(material),
        beginAdmission: vi.fn().mockResolvedValue(true),
        recordAdmission: vi.fn().mockResolvedValue(true),
        project: vi.fn().mockResolvedValue(true),
      },
      pi: { prompt, read, acknowledge: vi.fn() },
    });
    const queued = { ...mainClaim, turn: { ...acceptedTurn, lane: "background" as const } };
    const resumed = {
      ...queued,
      turn: {
        ...queued.turn,
        state: "running" as const,
        inactivityDeadlineAt: new Date(Date.now() + 60_000),
        absoluteDeadlineAt: new Date(Date.now() + 120_000),
      },
    };

    await expect(advance(queued)).resolves.toEqual({ kind: "release" });
    await expect(advance(resumed)).resolves.toEqual({ kind: "release" });
    expect(prompt).toHaveBeenCalledOnce();
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("keeps a proven prompt refusal queued when shutdown arrives with the response", async () => {
    const controller = new AbortController();
    const recordAdmission = vi.fn();
    const prompt = vi.fn(async () => {
      controller.abort();
      return { outcome: "rejected" as const, code: "pi_prompt_refused" };
    });
    const advance = createRuntimeV3WarmTurnAdvance({
      persistence: {
        authorize: vi.fn().mockResolvedValue({
          boxId: "bx_23456789", piInvocationId: "invocation-1",
          content: "refuse before shutdown", cursor: 0n,
        }),
        beginAdmission: vi.fn().mockResolvedValue(true), recordAdmission,
        project: vi.fn(),
      },
      pi: { prompt, read: vi.fn(), acknowledge: vi.fn() },
    });

    await expect(advance(mainClaim, controller.signal)).resolves.toEqual({ kind: "release" });
    expect(prompt).toHaveBeenCalledOnce();
    expect(recordAdmission).not.toHaveBeenCalled();
  });

  it.each(["nonterminal", "terminal"] as const)(
    "hands off when a %s projection may have committed before its transport failed",
    async (projectionKind) => {
      const events = projectionKind === "terminal"
        ? [{
          sequence: 1n, invocationId: "invocation-1", attemptId: acceptedTurn.id,
          kind: "pi_event" as const,
          event: { type: "agent_settled" as const },
        }]
        : [{
          sequence: 1n, invocationId: "invocation-1", attemptId: acceptedTurn.id,
          kind: "pi_event" as const,
          event: { type: "message_start" as const },
        }];
      const project = vi.fn(async () => {
        throw new Error("projection response lost after commit");
      });
      const advance = createRuntimeV3WarmTurnAdvance({
        persistence: {
          authorize: vi.fn().mockResolvedValue({
            boxId: "bx_23456789", piInvocationId: "invocation-1",
            content: "resume projection", cursor: 0n,
          }),
          beginAdmission: vi.fn(), recordAdmission: vi.fn(), project,
        },
        pi: {
          prompt: vi.fn(),
          read: vi.fn().mockResolvedValue({
            events, nextCursor: 1n, acknowledgedCursor: 0n, hasMore: false,
          }),
          acknowledge: vi.fn(),
        },
      });
      const activeClaim = {
        ...mainClaim,
        turn: {
          ...acceptedTurn,
          state: "admitted" as const,
          inactivityDeadlineAt: new Date(Date.now() + 60_000),
          absoluteDeadlineAt: new Date(Date.now() + 120_000),
        },
      };

      await expect(advance(activeClaim)).resolves.toEqual({ kind: "release" });
      expect(project).toHaveBeenCalledOnce();
    },
  );

  it("harvests an image-only v3 Turn before terminal projection and ACK", async () => {
    const attachment = {
      storageKey: "companion-attachments/org/companion/outputs/turn/0-digest",
      contentType: "image/png",
      byteSize: 128,
      sha256: "a".repeat(64),
      filename: "answer.png",
      uploadedAt: new Date("2026-09-03T12:00:00.000Z"),
    };
    const harvest = vi.fn().mockResolvedValue({ attachments: [attachment], incomplete: false });
    const clear = vi.fn().mockResolvedValue(undefined);
    const recordOutputs = vi.fn().mockResolvedValue(true);
    const project = vi.fn().mockResolvedValue("succeeded");
    const acknowledge = vi.fn().mockResolvedValue(1n);
    const advance = createRuntimeV3WarmTurnAdvance({
      persistence: {
        authorize: vi.fn().mockResolvedValue({
          boxId: "bx_23456789", piInvocationId: "invocation-1", content: "image", cursor: 0n,
        }),
        beginAdmission: vi.fn(), recordAdmission: vi.fn(), recordOutputs, project,
      },
      pi: {
        prompt: vi.fn(),
        read: vi.fn().mockResolvedValue({
          events: [{
            sequence: 1n, invocationId: "invocation-1", attemptId: acceptedTurn.id,
            kind: "pi_event", event: { type: "agent_settled" },
          }],
          nextCursor: 1n, acknowledgedCursor: 0n, hasMore: false,
        }),
        acknowledge,
      },
      outbox: { harvest, clear },
    });
    const claim = { ...mainClaim, turn: { ...acceptedTurn, state: "running" as const } };

    await expect(advance(claim)).resolves.toEqual({ kind: "ack_completed" });
    expect(harvest).toHaveBeenCalledWith(expect.objectContaining({ turnId: claim.turn.id }));
    expect(recordOutputs).toHaveBeenCalledWith(
      claim,
      expect.objectContaining({ attachments: [attachment] }),
      expect.any(AbortSignal),
    );
    expect(recordOutputs.mock.invocationCallOrder[0]).toBeLessThan(project.mock.invocationCallOrder[0]!);
    expect(project.mock.invocationCallOrder[0]).toBeLessThan(acknowledge.mock.invocationCallOrder[0]!);
    expect(clear).toHaveBeenCalledOnce();
  });

  it("records an empty degradation before preserving a text terminal result", async () => {
    const recordOutputs = vi.fn().mockResolvedValue(true);
    const project = vi.fn().mockResolvedValue("succeeded");
    const degraded = vi.fn();
    const advance = createRuntimeV3WarmTurnAdvance({
      persistence: {
        authorize: vi.fn().mockResolvedValue({
          boxId: "bx_23456789", piInvocationId: "invocation-1", content: "text", cursor: 0n,
        }),
        beginAdmission: vi.fn(), recordAdmission: vi.fn(), recordOutputs, project,
      },
      pi: {
        prompt: vi.fn(),
        read: vi.fn().mockResolvedValue({
          events: [
            {
              sequence: 1n, invocationId: "invocation-1", attemptId: acceptedTurn.id,
              kind: "pi_event", event: {
                type: "message_end",
                message: { role: "assistant", content: [{ type: "text", text: "Done" }], stopReason: "stop" },
              },
            },
            {
              sequence: 2n, invocationId: "invocation-1", attemptId: acceptedTurn.id,
              kind: "pi_event", event: { type: "agent_settled" },
            },
          ],
          nextCursor: 2n, acknowledgedCursor: 0n, hasMore: false,
        }),
        acknowledge: vi.fn().mockResolvedValue(2n),
      },
      outbox: {
        harvest: vi.fn().mockRejectedValue(new Error("outbox unavailable")),
        clear: vi.fn().mockResolvedValue(undefined),
      },
      onOutboxDegraded: degraded,
    });
    const claim = { ...mainClaim, turn: { ...acceptedTurn, state: "running" as const } };

    await expect(advance(claim)).resolves.toEqual({ kind: "ack_completed" });
    expect(recordOutputs).toHaveBeenCalledWith(
      claim,
      expect.objectContaining({ attachments: [] }),
      expect.any(AbortSignal),
    );
    expect(degraded).toHaveBeenCalledOnce();
  });

  it("does not project or ACK when the output fence is stale", async () => {
    const project = vi.fn();
    const acknowledge = vi.fn();
    const advance = createRuntimeV3WarmTurnAdvance({
      persistence: {
        authorize: vi.fn().mockResolvedValue({
          boxId: "bx_23456789", piInvocationId: "invocation-1", content: "image", cursor: 0n,
        }),
        beginAdmission: vi.fn(), recordAdmission: vi.fn(),
        recordOutputs: vi.fn().mockResolvedValue(false), project,
      },
      pi: {
        prompt: vi.fn(),
        read: vi.fn().mockResolvedValue({
          events: [{
            sequence: 1n, invocationId: "invocation-1", attemptId: acceptedTurn.id,
            kind: "pi_event", event: { type: "agent_settled" },
          }],
          nextCursor: 1n, acknowledgedCursor: 0n, hasMore: false,
        }),
        acknowledge,
      },
      outbox: {
        harvest: vi.fn().mockResolvedValue({ attachments: [], incomplete: false }),
        clear: vi.fn(),
      },
    });

    await expect(advance({
      ...mainClaim, turn: { ...acceptedTurn, state: "running" as const },
    })).resolves.toEqual({ kind: "release" });
    expect(project).not.toHaveBeenCalled();
    expect(acknowledge).not.toHaveBeenCalled();
  });

  it("keeps settled-without-result terminal and visible as pi_result_missing", async () => {
    const project = vi.fn().mockResolvedValue(true);
    const acknowledge = vi.fn().mockResolvedValue(1n);
    const advance = createRuntimeV3WarmTurnAdvance({
      persistence: {
        authorize: vi.fn().mockResolvedValue({
          boxId: "bx_23456789", piInvocationId: "invocation-1", content: "finish", cursor: 0n,
        }),
        beginAdmission: vi.fn(), recordAdmission: vi.fn(), project,
      },
      pi: {
        prompt: vi.fn(),
        read: vi.fn().mockResolvedValue({
          events: [{
            sequence: 1n, invocationId: "invocation-1", attemptId: acceptedTurn.id,
            kind: "pi_event", event: { type: "agent_settled" },
          }],
          nextCursor: 1n, acknowledgedCursor: 0n, hasMore: false,
        }),
        acknowledge,
      },
    });

    await expect(advance({
      ...mainClaim, turn: { ...acceptedTurn, state: "running" as const },
    })).resolves.toEqual({
      kind: "failed",
      code: "pi_result_missing",
      message: "Pi settled without an assistant result.",
      action: "none",
    });
    expect(project).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ assistant: [], assistantFallbacks: [], settled: true }),
      expect.any(AbortSignal),
    );
    expect(acknowledge).toHaveBeenCalledOnce();
  });

  it("settles an exhausted terminal model error with a safe switch-model outcome", async () => {
    const project = vi.fn().mockResolvedValue(true);
    const acknowledge = vi.fn().mockResolvedValue(2n);
    const prompt = vi.fn();
    const advance = createRuntimeV3WarmTurnAdvance({
      persistence: {
        authorize: vi.fn().mockResolvedValue({
          boxId: "bx_23456789", piInvocationId: "invocation-1", content: "finish", cursor: 0n,
        }),
        beginAdmission: vi.fn(), recordAdmission: vi.fn(), project,
      },
      pi: {
        prompt,
        read: vi.fn().mockResolvedValue({
          events: [
            {
              sequence: 1n, invocationId: "invocation-1", attemptId: acceptedTurn.id,
              kind: "pi_event", event: {
                type: "auto_retry_end", success: false,
                finalError: "429 provider entitlement payload that must not escape",
              },
            },
            {
              sequence: 2n, invocationId: "invocation-1", attemptId: acceptedTurn.id,
              kind: "pi_event", event: { type: "agent_settled" },
            },
          ],
          nextCursor: 2n, acknowledgedCursor: 0n, hasMore: false,
        }),
        acknowledge,
      },
    });

    await expect(advance({
      ...mainClaim, turn: { ...acceptedTurn, state: "running" as const },
    })).resolves.toEqual({
      kind: "failed",
      code: "model_unavailable",
      message: "The selected model is unavailable. Choose a different model and try again.",
      action: "switch_model",
    });
    expect(project).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        assistant: [],
        settled: true,
        terminalError: {
          sequence: 1n,
          code: "model_unavailable",
          message: "The selected model is unavailable. Choose a different model and try again.",
          action: "switch_model",
        },
      }),
      expect.any(AbortSignal),
    );
    expect(acknowledge).toHaveBeenCalledOnce();
    expect(prompt).not.toHaveBeenCalled();
  });

  it("does not reread the outbox after a committed harvest is taken over", async () => {
    const harvest = vi.fn();
    const recordOutputs = vi.fn();
    const project = vi.fn().mockResolvedValue("succeeded");
    const acknowledge = vi.fn().mockResolvedValue(1n);
    const advance = createRuntimeV3WarmTurnAdvance({
      persistence: {
        authorize: vi.fn().mockResolvedValue({
          boxId: "bx_23456789", piInvocationId: "invocation-1", content: "image", cursor: 0n,
          outputsHarvested: true,
        }),
        beginAdmission: vi.fn(), recordAdmission: vi.fn(), recordOutputs, project,
      },
      pi: {
        prompt: vi.fn(),
        read: vi.fn().mockResolvedValue({
          events: [{
            sequence: 1n, invocationId: "invocation-1", attemptId: acceptedTurn.id,
            kind: "pi_event", event: { type: "agent_settled" },
          }],
          nextCursor: 1n, acknowledgedCursor: 0n, hasMore: false,
        }),
        acknowledge,
      },
      outbox: { harvest, clear: vi.fn() },
    });

    await expect(advance({
      ...mainClaim, turn: { ...acceptedTurn, state: "running" as const },
    })).resolves.toEqual({ kind: "ack_completed" });
    expect(harvest).not.toHaveBeenCalled();
    expect(recordOutputs).not.toHaveBeenCalled();
    expect(project).toHaveBeenCalledOnce();
    expect(acknowledge).toHaveBeenCalledOnce();
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

  it("delivers one durable main ask_user answer before the active Turn resumes", async () => {
    const respondExtensionUi = vi.fn().mockResolvedValue({
      outcome: "accepted" as const,
      invocationId: "invocation-1",
    });
    const finishDecisionAction = vi.fn().mockResolvedValue(true);
    const advance = createRuntimeV3WarmTurnAdvance({
      persistence: {
        authorize: vi.fn().mockResolvedValue({
          boxId: "bx_23456789", piInvocationId: "invocation-1", content: "waiting", cursor: 0n,
        }),
        beginAdmission: vi.fn(),
        recordAdmission: vi.fn(),
        beginDecisionAction: vi.fn().mockResolvedValue({
          kind: "respond", decisionId: "85312651-3171-4ac8-a99c-8af0875951aa",
          commandId: "bfdd76e0-a78e-4fc7-8230-f4dfd3caf391",
          response: { type: "extension_ui_response", id: "question-1", value: "Choose safe mode" },
        }),
        finishDecisionAction,
        project: vi.fn().mockResolvedValue(true),
      },
      pi: {
        prompt: vi.fn(), abort: vi.fn(), respondExtensionUi,
        read: vi.fn().mockResolvedValue({
          events: [], nextCursor: 0n, acknowledgedCursor: 0n, hasMore: false,
        }),
        acknowledge: vi.fn().mockResolvedValue(0n),
      },
    });
    const claim = {
      ...mainClaim,
      turn: {
        ...mainClaim.turn, state: "running" as const,
        inactivityDeadlineAt: new Date(Date.now() + 60_000),
        absoluteDeadlineAt: new Date(Date.now() + 120_000),
      },
    };

    await expect(advance(claim)).resolves.toEqual({ kind: "release" });
    expect(respondExtensionUi).toHaveBeenCalledOnce();
    expect(respondExtensionUi).toHaveBeenCalledWith(expect.objectContaining({
      turnId: claim.turn.id,
      response: { type: "extension_ui_response", id: "question-1", value: "Choose safe mode" },
    }));
    expect(finishDecisionAction).toHaveBeenCalledOnce();
  });

  it.each(["no_active_attempt", "attempt_mismatch"])(
    "checkpoints a proven-obsolete decision response (%s) before settling the terminal journal",
    async (code) => {
      const finishDecisionAction = vi.fn().mockResolvedValue(true);
      const respondExtensionUi = vi.fn().mockResolvedValue({
        outcome: "rejected" as const,
        code,
      });
      const read = vi.fn().mockResolvedValue({
        events: [
          {
            sequence: 1n, invocationId: "invocation-1", attemptId: acceptedTurn.id,
            kind: "pi_event" as const,
            event: {
              type: "message_end" as const,
              message: {
                role: "assistant" as const,
                content: [{ type: "text" as const, text: "Already settled." }],
                stopReason: "stop" as const,
              },
            },
          },
          {
            sequence: 2n, invocationId: "invocation-1", attemptId: acceptedTurn.id,
            kind: "pi_event" as const, event: { type: "agent_settled" as const },
          },
        ],
        nextCursor: 2n, acknowledgedCursor: 0n, hasMore: false,
      });
      const acknowledge = vi.fn().mockResolvedValue(2n);
      const advance = createRuntimeV3WarmTurnAdvance({
        persistence: {
          authorize: vi.fn().mockResolvedValue({
            boxId: "bx_23456789", piInvocationId: "invocation-1", content: "waiting", cursor: 0n,
          }),
          beginAdmission: vi.fn(), recordAdmission: vi.fn(),
          beginDecisionAction: vi.fn().mockResolvedValue({
            kind: "respond", decisionId: "85312651-3171-4ac8-a99c-8af0875951aa",
            commandId: "bfdd76e0-a78e-4fc7-8230-f4dfd3caf391",
            response: { type: "extension_ui_response", id: "question-1", value: "Proceed" },
          }),
          finishDecisionAction,
          project: vi.fn().mockResolvedValue("succeeded"),
        },
        pi: { prompt: vi.fn(), respondExtensionUi, read, acknowledge },
      });
      const claim = { ...mainClaim, turn: { ...acceptedTurn, state: "running" as const } };

      await expect(advance(claim)).resolves.toEqual({ kind: "ack_completed" });
      expect(respondExtensionUi).toHaveBeenCalledOnce();
      expect(finishDecisionAction).toHaveBeenCalledWith(claim, {
        decisionId: "85312651-3171-4ac8-a99c-8af0875951aa",
        kind: "obsolete",
        invocationId: "invocation-1",
      });
      expect(read).toHaveBeenCalledOnce();
      expect(acknowledge).toHaveBeenCalledOnce();
    },
  );

  it("keeps a transiently refused decision response reclaimable", async () => {
    const finishDecisionAction = vi.fn();
    const read = vi.fn();
    const advance = createRuntimeV3WarmTurnAdvance({
      persistence: {
        authorize: vi.fn().mockResolvedValue({
          boxId: "bx_23456789", piInvocationId: "invocation-1", content: "waiting", cursor: 0n,
        }),
        beginAdmission: vi.fn(), recordAdmission: vi.fn(), project: vi.fn(),
        beginDecisionAction: vi.fn().mockResolvedValue({
          kind: "respond", decisionId: "85312651-3171-4ac8-a99c-8af0875951aa",
          commandId: "bfdd76e0-a78e-4fc7-8230-f4dfd3caf391",
          response: { type: "extension_ui_response", id: "question-1", value: "Proceed" },
        }),
        finishDecisionAction,
      },
      pi: {
        prompt: vi.fn(), read, acknowledge: vi.fn(),
        respondExtensionUi: vi.fn().mockResolvedValue({
          outcome: "rejected" as const, code: "pi_decision_refused",
        }),
      },
    });
    const claim = { ...mainClaim, turn: { ...acceptedTurn, state: "running" as const } };

    await expect(advance(claim)).resolves.toEqual({ kind: "release" });
    expect(finishDecisionAction).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
  });

  it("aborts Pi before durably cancelling an accepted delegated main Turn", async () => {
    const pendingDelegationCancel = vi.fn().mockResolvedValue({
      turnId: "85312651-3171-4ac8-a99c-8af0875951aa",
      responseTurnId: acceptedTurn.id,
      commandId: "bfdd76e0-a78e-4fc7-8230-f4dfd3caf391",
    });
    const finishDelegationCancel = vi.fn().mockResolvedValue(true);
    const abort = vi.fn().mockResolvedValue({
      outcome: "accepted" as const, invocationId: "invocation-1",
    });
    const read = vi.fn();
    const advance = createRuntimeV3WarmTurnAdvance({
      persistence: {
        authorize: vi.fn().mockResolvedValue({
          boxId: "bx_23456789", piInvocationId: "invocation-1", content: "active", cursor: 0n,
        }),
        beginAdmission: vi.fn(), recordAdmission: vi.fn(), project: vi.fn(),
        pendingDelegationCancel, finishDelegationCancel,
      },
      pi: { prompt: vi.fn(), read, acknowledge: vi.fn(), abort },
    });
    const claim = { ...mainClaim, turn: { ...acceptedTurn, state: "running" as const } };

    await expect(advance(claim)).resolves.toEqual({ kind: "release" });
    expect(abort).toHaveBeenCalledWith(expect.objectContaining({
      boxId: "bx_23456789",
      commandId: "bfdd76e0-a78e-4fc7-8230-f4dfd3caf391",
      turnId: claim.turn.id,
    }));
    expect(finishDelegationCancel).toHaveBeenCalledWith(claim, {
      turnId: "85312651-3171-4ac8-a99c-8af0875951aa",
    });
    expect(read).not.toHaveBeenCalled();
  });

  it("rechecks cancellation after admission before releasing a native steer", async () => {
    const responseTurnId = "72f04ea8-8f87-4d53-813a-1d9c4cf46caa";
    const pendingDelegationCancel = vi.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        turnId: acceptedTurn.id,
        responseTurnId,
        commandId: "bfdd76e0-a78e-4fc7-8230-f4dfd3caf391",
      });
    const abort = vi.fn().mockResolvedValue({
      outcome: "accepted" as const, invocationId: "invocation-1",
    });
    const read = vi.fn();
    const finishDelegationCancel = vi.fn().mockResolvedValue(true);
    const advance = createRuntimeV3WarmTurnAdvance({
      persistence: {
        authorize: vi.fn().mockResolvedValue({
          boxId: "bx_23456789",piInvocationId: "invocation-1",content: "steer",cursor: 0n,
        }),
        beginAdmission: vi.fn().mockResolvedValue(true),
        recordAdmission: vi.fn().mockResolvedValue(true),
        project: vi.fn(),pendingDelegationCancel,finishDelegationCancel,
      },
      pi: {
        prompt: vi.fn().mockResolvedValue({
          outcome: "accepted" as const,invocationId: "invocation-1",
          responseAttemptId: responseTurnId,initialCursor: 0n,
        }),
        read,acknowledge: vi.fn(),abort,
      },
    });

    await expect(advance(mainClaim)).resolves.toEqual({ kind: "release" });
    expect(pendingDelegationCancel).toHaveBeenCalledTimes(2);
    expect(abort).toHaveBeenCalledWith(expect.objectContaining({ turnId: responseTurnId }));
    expect(finishDelegationCancel).toHaveBeenCalledOnce();
    expect(read).not.toHaveBeenCalled();
  });

  it("rechecks cancellation after read before projecting a terminal root page", async () => {
    const pendingDelegationCancel = vi.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        turnId: acceptedTurn.id,
        responseTurnId: acceptedTurn.id,
        commandId: "bfdd76e0-a78e-4fc7-8230-f4dfd3caf391",
      });
    const project = vi.fn();
    const abort = vi.fn().mockResolvedValue({
      outcome: "accepted" as const,invocationId: "invocation-1",
    });
    const finishDelegationCancel = vi.fn().mockResolvedValue(true);
    const advance = createRuntimeV3WarmTurnAdvance({
      persistence: {
        authorize: vi.fn().mockResolvedValue({
          boxId: "bx_23456789",piInvocationId: "invocation-1",content: "root",cursor: 0n,
        }),
        beginAdmission: vi.fn(),recordAdmission: vi.fn(),project,
        pendingDelegationCancel,finishDelegationCancel,
      },
      pi: {
        prompt: vi.fn(),
        read: vi.fn().mockResolvedValue({
          events: [{
            sequence: 1n,invocationId: "invocation-1",attemptId: acceptedTurn.id,
            kind: "pi_event",event: { type: "agent_settled" },
          }],
          nextCursor: 1n,acknowledgedCursor: 0n,hasMore: false,
        }),
        acknowledge: vi.fn(),abort,
      },
    });
    const claim = { ...mainClaim,turn: { ...acceptedTurn,state: "running" as const } };

    await expect(advance(claim)).resolves.toEqual({ kind: "release" });
    expect(pendingDelegationCancel).toHaveBeenCalledTimes(2);
    expect(abort).toHaveBeenCalledOnce();
    expect(finishDelegationCancel).toHaveBeenCalledOnce();
    expect(project).not.toHaveBeenCalled();
  });

  it("releases a decision handoff whose durable begin reply was lost before Pi", async () => {
    const respondExtensionUi = vi.fn();
    const advance = createRuntimeV3WarmTurnAdvance({
      persistence: {
        authorize: vi.fn().mockResolvedValue({
          boxId: "bx_23456789", piInvocationId: "invocation-1", content: "waiting", cursor: 0n,
        }),
        beginAdmission: vi.fn(), recordAdmission: vi.fn(), project: vi.fn(),
        beginDecisionAction: vi.fn().mockRejectedValue(new Error("commit reply lost")),
        finishDecisionAction: vi.fn(),
      },
      pi: { prompt: vi.fn(), read: vi.fn(), acknowledge: vi.fn(), respondExtensionUi },
    });
    const claim = { ...mainClaim, turn: { ...acceptedTurn, state: "running" as const } };

    await expect(advance(claim)).resolves.toEqual({ kind: "release" });
    expect(respondExtensionUi).not.toHaveBeenCalled();
  });

  it("terminalizes an ambiguous decision write instead of replaying it", async () => {
    const respondExtensionUi = vi.fn(async () => {
      throw new Error("ledger fsync failed after the send");
    });
    const advance = createRuntimeV3WarmTurnAdvance({
      persistence: {
        authorize: vi.fn().mockResolvedValue({
          boxId: "bx_23456789", piInvocationId: "invocation-1", content: "waiting", cursor: 0n,
        }),
        beginAdmission: vi.fn(), recordAdmission: vi.fn(), project: vi.fn(),
        beginDecisionAction: vi.fn().mockResolvedValue({
          kind: "respond", decisionId: "85312651-3171-4ac8-a99c-8af0875951aa",
          commandId: "bfdd76e0-a78e-4fc7-8230-f4dfd3caf391",
          response: { type: "extension_ui_response", id: "question-1", value: "Proceed" },
        }),
        finishDecisionAction: vi.fn(),
      },
      pi: { prompt: vi.fn(), read: vi.fn(), acknowledge: vi.fn(), respondExtensionUi },
    });
    const claim = { ...mainClaim, turn: { ...acceptedTurn, state: "running" as const } };

    await expect(advance(claim)).resolves.toMatchObject({
      kind: "decision_ambiguous", code: "pi_decision_outcome_unknown",
    });
    expect(respondExtensionUi).toHaveBeenCalledOnce();
  });

  it("completes a durably detached background Turn after its checkpoint reply is lost", async () => {
    const abort = vi.fn().mockResolvedValue({
      outcome: "accepted" as const, invocationId: "invocation-1",
    });
    const beginDecisionAction = vi.fn()
      .mockResolvedValueOnce({
        kind: "detach", decisionId: "85312651-3171-4ac8-a99c-8af0875951aa",
        commandId: "bfdd76e0-a78e-4fc7-8230-f4dfd3caf391", response: null,
      })
      .mockResolvedValueOnce({
        kind: "complete_detached", decisionId: "85312651-3171-4ac8-a99c-8af0875951aa",
        commandId: "85312651-3171-4ac8-a99c-8af0875951aa", response: null,
      });
    const persistence = {
      authorize: vi.fn().mockResolvedValue({
        boxId: "bx_23456789", piInvocationId: "invocation-1", content: "background", cursor: 0n,
      }),
      beginAdmission: vi.fn(), recordAdmission: vi.fn(), project: vi.fn(),
      beginDecisionAction,
      finishDecisionAction: vi.fn().mockRejectedValueOnce(new Error("checkpoint reply lost")),
    };
    const advance = createRuntimeV3WarmTurnAdvance({
      persistence,
      pi: { prompt: vi.fn(), read: vi.fn(), acknowledge: vi.fn(), abort },
    });
    const claim = {
      ...mainClaim,
      turn: { ...acceptedTurn, lane: "background" as const, state: "needs_input" as const },
    };

    await expect(advance(claim)).resolves.toEqual({ kind: "release" });
    await expect(advance(claim)).resolves.toEqual({ kind: "detached" });
    expect(abort).toHaveBeenCalledOnce();
  });

  it("aborts a background Turn after persisting its detached ask_user identity", async () => {
    const turn = { ...acceptedTurn, lane: "background" as const };
    const claim = { ...mainClaim, turn };
    const beginDecisionAction = vi.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        kind: "detach", decisionId: "85312651-3171-4ac8-a99c-8af0875951aa",
        commandId: "bfdd76e0-a78e-4fc7-8230-f4dfd3caf391", response: null,
      });
    const project = vi.fn().mockResolvedValue("detached");
    const abort = vi.fn().mockResolvedValue({ outcome: "accepted" as const, invocationId: "invocation-1" });
    const advance = createRuntimeV3WarmTurnAdvance({
      persistence: {
        authorize: vi.fn().mockResolvedValue({
          boxId: "bx_23456789", piInvocationId: "invocation-1", content: "background", cursor: 0n,
        }),
        beginAdmission: vi.fn().mockResolvedValue(true),
        recordAdmission: vi.fn().mockResolvedValue(true),
        beginDecisionAction,
        finishDecisionAction: vi.fn().mockResolvedValue(true),
        project,
      },
      pi: {
        prompt: vi.fn().mockResolvedValue({
          outcome: "accepted" as const, invocationId: "invocation-1", initialCursor: 0n,
        }),
        read: vi.fn().mockResolvedValue({
          events: [{
            sequence: 1n, invocationId: "invocation-1", attemptId: turn.id,
            kind: "pi_event", event: {
              type: "extension_ui_request", id: "question-1", method: "input",
              title: "companion:question:ask_user", message: "Choose a safe mode",
            },
          }],
          nextCursor: 1n, acknowledgedCursor: 0n, hasMore: false,
        }),
        acknowledge: vi.fn().mockResolvedValue(1n), abort, respondExtensionUi: vi.fn(),
      },
    });

    await expect(advance(claim)).resolves.toEqual({ kind: "detached" });
    expect(project).toHaveBeenCalledWith(claim, expect.objectContaining({
      needsInput: true,
      decisions: [expect.objectContaining({ request_key: "question-1", request_kind: "question" })],
    }), expect.any(AbortSignal));
    expect(abort).toHaveBeenCalledOnce();
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
        fail: vi.fn().mockResolvedValue(true),
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

  it("recycles only the exactly fenced Pi on the same Box before restaging", async () => {
    const base: RuntimeV3PreparationClaim = {
      orgId: mainClaim.orgId,
      companionId: mainClaim.companionId,
      turnId: acceptedTurn.id,
      commandId: acceptedTurn.commandId,
      checkpoint: "box_ready",
      piRecycleCheckpoint: "terminate",
      recyclePiInvocationId: "pi-contaminated",
      recoveryId: acceptedTurn.id,
      recoveryContext: "durable context",
      boxIdempotencyKey: "11111111-1111-4111-8111-111111111111",
      boxId: "bx_23456789",
      createdAt: new Date(), executorId: "runtime-heal", authorized: true,
      actorId: "actor-1", modelId: "claude-test", persona: null,
      settingsRevision: 1n, skillsRevision: 1,
      providerRefs: [], skillRefs: [], mcpRefs: [], providerMaterial: [],
      skillMaterial: [], mcpMaterial: [], configCatalog: null, fence: mainClaim.fence,
    };
    const claims: RuntimeV3PreparationClaim[] = [
      base,
      { ...base, piRecycleCheckpoint: "reset" },
      { ...base, piRecycleCheckpoint: "ready" },
      { ...base, checkpoint: "staged", piRecycleCheckpoint: "ready" },
    ];
    const terminatePiInvocation = vi.fn().mockResolvedValue({ outcome: "terminated" });
    const resetPiSession = vi.fn().mockResolvedValue(undefined);
    const checkpointPiRecycle = vi.fn().mockResolvedValue(true);
    const stagePreparation = vi.fn().mockResolvedValue({
      diskLayoutVersion: 14, appliedSettingsRevision: 1n, appliedSkillsRevision: 1,
      skillsDigest: "b".repeat(64), materialExpiresAt: new Date(Date.now() + 8 * 60 * 60_000),
    });
    const startPiDaemon = vi.fn().mockResolvedValue({ state: "idle", invocationId: "pi-fresh" });
    const preparation = createRuntimeV3Preparation({
      persistence: {
        claim: vi.fn(async () => claims.shift() ?? null), checkpoint: vi.fn().mockResolvedValue(true),
        checkpointPiRecycle, defer: vi.fn().mockResolvedValue(true),
        fail: vi.fn().mockResolvedValue(true),
        reauthorize: vi.fn().mockResolvedValue(true), mintCredentials: vi.fn(),
      },
      box: { createGenerationBox: vi.fn(), applyGenerationBoxSettings: vi.fn(), getStatus: vi.fn() },
      preparationStager: { stagePreparation },
      pi: { terminatePiInvocation, resetPiSession, startPiDaemon },
    });

    await expect(preparation.converge({ executorId: "runtime-heal" }))
      .resolves.toEqual({ progressed: 4, exhausted: false });
    expect(terminatePiInvocation).toHaveBeenCalledWith(expect.objectContaining({
      boxId: "bx_23456789", expectedInvocationId: "pi-contaminated",
    }));
    expect(resetPiSession).toHaveBeenCalledWith(expect.objectContaining({
      boxId: "bx_23456789", recoveryId: acceptedTurn.id,
    }));
    expect(checkpointPiRecycle.mock.calls.map(([, next]) => next)).toEqual(["reset", "complete"]);
    expect(stagePreparation).toHaveBeenCalledTimes(1);
    expect(startPiDaemon).toHaveBeenCalledTimes(1);
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
          fail: vi.fn().mockResolvedValue(true),
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
        checkpoint, defer, fail: vi.fn(), reauthorize: vi.fn(), mintCredentials: vi.fn(),
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

  it.each<[
    string,
    "pending" | "box_ready" | "staged",
    {
      authorized?: boolean;
      createGenerationBox?: Error;
      stagePreparation?: Error;
      startPiDaemon?: Error;
    },
    "box" | "model" | "plugin_provider" | "authority",
    string,
    string,
  ]>([
    ["Box create", "pending", { createGenerationBox: new Error("token=provider-secret") }, "box", "box_unavailable", "box:companion"],
    ["plugin staging", "box_ready", { stagePreparation: new RuntimeExternalDependencyError(
      "provider_unavailable",
      { kind: "provider", id: "github" },
    ) }, "plugin_provider", "plugin_provider_unavailable", "provider:github"],
    ["credential grant", "box_ready", { stagePreparation: new RuntimeExternalDependencyError(
      "external_authority_unavailable",
      { kind: "grant", id: "actor:actor-1" },
    ) }, "authority", "external_authority_unavailable", "grant:actor:actor-1"],
    ["Pi activation", "staged", { startPiDaemon: new Error("token=provider-secret") }, "box", "box_unavailable", "box:companion"],
    ["authority loss", "pending", { authorized: false }, "authority", "external_authority_unavailable", "grant:actor:actor-1"],
  ])("keeps the queued Turn retryable after a %s failure", async (
    _label, checkpoint, failure, failureClass, failureCode, dependencyKey,
  ) => {
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
      authorized: failure.authorized ?? true,
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
        fail: vi.fn().mockResolvedValue(true),
        reauthorize: vi.fn().mockResolvedValue(true),
        mintCredentials: vi.fn().mockResolvedValue(null),
      },
      box: {
        createGenerationBox: "createGenerationBox" in failure
          ? vi.fn().mockRejectedValue(failure.createGenerationBox!)
          : vi.fn(),
        applyGenerationBoxSettings: vi.fn(),
        getStatus: vi.fn(),
      },
      preparationStager: {
        stagePreparation: failure.stagePreparation
          ? vi.fn().mockRejectedValue(failure.stagePreparation)
          : vi.fn(),
      },
      pi: {
        startPiDaemon: "startPiDaemon" in failure
          ? vi.fn().mockRejectedValue(failure.startPiDaemon!)
          : vi.fn(),
      },
      jitter: () => 0.5,
    });

    await preparation.converge({ executorId: "runtime-fault" });
    const deferred = defer.mock.calls[0]?.[1];
    expect(deferred).toMatchObject({
      delaySeconds: 5,
      error: { code: failureCode, action: "retry" },
      externalFailureClass: failureClass,
      dependencyKey,
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
    expect(store.convergence.completeProgression).toHaveBeenCalledWith(mainClaim, {
      kind: "external_retry",
      failureClass: "box",
      source: "main",
      dependencyKey: "box:companion",
      error: {
        code: "pi_prompt_refused",
      message: "This work is blocked because its Box is unavailable.",
        action: "retry",
      },
    });
  });

  it("routes a safely terminated routine start through durable cleanup before retry", async () => {
    const routineClaim = {
      ...mainClaim,
      source: "routine" as const,
      turn: { ...mainClaim.turn, lane: "background" as const },
    };
    const claims: ClaimQueues = { main: [null], background: [routineClaim, null] };
    const store = persistence({ claimLane: vi.fn(claimFrom(claims)) });
    const warm = {
      authorize: vi.fn().mockResolvedValue({
        boxId: "bx_23456789",
        piInvocationId: "routine-invocation-1",
        content: "Run scheduled work",
        cursor: 0n,
      }),
      beginAdmission: vi.fn().mockResolvedValue(true),
      recordAdmission: vi.fn(),
      project: vi.fn(),
    };
    const progression = createRuntimeV3Progression({
      persistence: store,
      advance: createRuntimeV3WarmTurnAdvance({
        persistence: warm,
        pi: {
          prompt: vi.fn().mockResolvedValue({
            outcome: "rejected",
            code: "routine_start_failed",
          }),
          read: vi.fn(),
          acknowledge: vi.fn(),
        },
      }),
    });

    await expect(progression.converge({ executorId: "runtime-routine-retry" }))
      .resolves.toEqual({ progressed: 1, exhausted: false });
    expect(warm.recordAdmission).not.toHaveBeenCalled();
    expect(store.convergence.completeProgression).toHaveBeenCalledWith(routineClaim, {
      kind: "admission_rejected",
      error: {
        code: "routine_start_failed",
        message: "The routine session could not start and will retry automatically.",
        action: "retry",
      },
    });
  });

  it.each(["main", "routine", "trigger", "delegation"] as const)(
    "fails closed without contacting Pi when %s authority is unavailable",
    async (source) => {
      const lane: "main" | "background" =
        source === "routine" || source === "trigger" ? "background" : "main";
      const claim = { ...mainClaim, source, turn: { ...mainClaim.turn, lane } };
      const claims: ClaimQueues = lane === "main"
        ? { main: [claim, null], background: [null] }
        : { main: [null], background: [claim, null] };
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
      expect(store.convergence.completeProgression).toHaveBeenCalledWith(
        claim,
        {
          kind: "external_retry",
          failureClass: "authority",
          source,
          dependencyKey: null,
          error: {
            code: "warm_turn_unauthorized",
            message: "This work is blocked until its external access is available again.",
            action: "retry",
          },
        },
      );
    },
  );
});
