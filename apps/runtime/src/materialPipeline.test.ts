import { describe, expect, it, vi } from "vitest";
import { BoxRuntimeProviderError, type CompanionBoxRuntime } from "@companion/box-runtime";
import { RuntimeExternalDependencyError } from "@companion/companion-runtime/runtime-support";
import {
  createRuntimeV3Preparation,
  type RuntimeV3PreparationClaim,
} from "@companion/companion-runtime/v3/internal";

import { companionHubApiUrl, createRuntimeMaterialPipeline } from "./materialPipeline";

const orgId = "11111111-1111-4111-8111-111111111111";
const companionId = "22222222-2222-4222-8222-222222222222";
const actorId = "33333333-3333-4333-8333-333333333333";
const claimToken = "44444444-4444-4444-8444-444444444444";
const masterKey = Buffer.alloc(32, 71);

function preparationClaim(): RuntimeV3PreparationClaim {
  return {
    executorId: "runtime-test",
    orgId,
    companionId,
    turnId: "66666666-6666-4666-8666-666666666666",
    commandId: "77777777-7777-4777-8777-777777777777",
    checkpoint: "box_ready",
    boxIdempotencyKey: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    boxId: "bx_23456789",
    createdAt: new Date("2026-09-03T00:00:00.000Z"),
    authorized: true,
    actorId,
    modelId: "claude-test",
    persona: "test",
    settingsRevision: 3n,
    skillsRevision: 4,
    providerRefs: [],
    skillRefs: [],
    mcpRefs: [],
    providerMaterial: [],
    skillMaterial: [],
    mcpMaterial: [],
    configCatalog: null,
    fence: { token: claimToken, epoch: 1n, gateEpoch: 1n },
  };
}

function fakeRuntime(
  stageExistingBox: (
    ...args: Parameters<CompanionBoxRuntime["stageExistingBox"]>
  ) => ReturnType<CompanionBoxRuntime["stageExistingBox"]>,
): CompanionBoxRuntime {
  // SAFETY: these tests exercise only the v3 preparation staging seam.
  return { stageExistingBox } as CompanionBoxRuntime;
}

function pipeline(stageExistingBox = vi.fn()) {
  return createRuntimeMaterialPipeline({
    masterKey,
    apiUrl: "https://api.example.test",
    bundledSkill: {
      slug: "companion",
      version: "1.0.0",
      checksum: `sha256:${"1".repeat(64)}`,
      archive: Buffer.from("bundled"),
    },
    runtime: () => fakeRuntime(stageExistingBox),
    loadSkillArchive: vi.fn(),
    storeAttachment: vi.fn(),
  });
}

const credentials = {
  hubToken: "hub-token",
  mcpBrokerToken: null,
  controlToken: "control-token",
  expiresAt: new Date("2027-01-01T00:00:00.000Z"),
};

describe("Runtime v3 material preparation", () => {
  it("normalizes the staged Skills Hub API base to /v1", () => {
    expect(companionHubApiUrl("https://api.example.test")).toBe("https://api.example.test/v1");
    expect(companionHubApiUrl("https://api.example.test/")).toBe("https://api.example.test/v1");
    expect(companionHubApiUrl("https://api.example.test/v1")).toBe("https://api.example.test/v1");
  });

  it("attributes a failed credential mint to the exact authority grant", async () => {
    const stageExistingBox = vi.fn();

    await expect(pipeline(stageExistingBox).preparationStager.stagePreparation({
      claim: preparationClaim(),
      authorize: async () => null,
      signal: new AbortController().signal,
    })).rejects.toMatchObject({
      name: "RuntimeExternalDependencyError",
      failureClass: "authority",
      dependency: { kind: "grant", id: `actor:${actorId}` },
    } satisfies Partial<RuntimeExternalDependencyError>);
    expect(stageExistingBox).not.toHaveBeenCalled();
  });

  it.each([
    [409, "terminal"],
    [422, "terminal"],
    [408, "external"],
    [429, "external"],
    [500, "external"],
    [503, "external"],
  ] as const)("settles Box status %i through preparation as %s", async (status, outcome) => {
    const stageExistingBox = vi.fn(async () => {
      throw new BoxRuntimeProviderError("provider-controlled detail", status);
    });
    const claim = preparationClaim();
    const defer = vi.fn().mockResolvedValue(true);
    const fail = vi.fn().mockResolvedValue(true);
    const preparation = createRuntimeV3Preparation({
      persistence: {
        claim: vi.fn().mockResolvedValueOnce(claim),
        checkpoint: vi.fn().mockResolvedValue(true),
        defer,
        fail,
        reauthorize: vi.fn().mockResolvedValue(true),
        mintCredentials: vi.fn().mockResolvedValue(credentials),
      },
      box: {
        createGenerationBox: vi.fn(),
        applyGenerationBoxSettings: vi.fn(),
        getStatus: vi.fn(),
      },
      preparationStager: pipeline(stageExistingBox).preparationStager,
      pi: { startPiDaemon: vi.fn() },
      jitter: () => 0.5,
    });

    await preparation.converge({ executorId: claim.executorId });

    if (outcome === "terminal") {
      expect(fail).toHaveBeenCalledWith(claim, {
        error: {
          code: "box_staging_conflict",
          message: "The Companion Box rejected its runtime material.",
          action: "none",
        },
      }, expect.any(AbortSignal));
      expect(defer).not.toHaveBeenCalled();
    } else {
      expect(fail).not.toHaveBeenCalled();
      expect(defer).toHaveBeenCalledWith(claim, expect.objectContaining({
        delaySeconds: 5,
        error: expect.objectContaining({ code: "box_unavailable", action: "retry" }),
        externalFailureClass: "box",
        dependencyKey: "box:companion",
      }), expect.any(AbortSignal));
    }
  });
});
