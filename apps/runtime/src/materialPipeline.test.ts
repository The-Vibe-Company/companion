import { describe, expect, it, vi } from "vitest";
import {
  decryptOpaqueValue,
  encryptCompanionMcpRuntimeCredential,
  encryptOpaqueValue,
} from "@companion/core";
import {
  RuntimeExternalDependencyError,
  type LeaseFence,
  type RuntimeAuthorization,
  type RuntimeStore,
  type RuntimeWorkMaterial,
} from "@companion/companion-runtime";
import {
  createRuntimeV3Preparation,
  type RuntimeV3PreparationClaim,
} from "@companion/companion-runtime/v3/internal";
import {
  BoxRuntimeProviderError,
  type CompanionBoxRuntimeV2,
} from "@companion/box-runtime";

import { companionHubApiUrl, createRuntimeMaterialPipeline } from "./materialPipeline";
import { RuntimeMaterialError } from "./resourceMaterial";

const orgId = "11111111-1111-4111-8111-111111111111";
const companionId = "22222222-2222-4222-8222-222222222222";
const accountId = "33333333-3333-4333-8333-333333333333";
const generation = "44444444-4444-4444-8444-444444444444";
const nextGeneration = "55555555-5555-4555-8555-555555555555";
const skillId = "88888888-8888-4888-8888-888888888888";
const skillVersionId = "99999999-9999-4999-8999-999999999999";
const nextSkillVersionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const masterKey = Buffer.alloc(32, 71);

function oauth(
  accessToken: string,
  accessExpiresAt: string | null = "2027-01-01T00:00:00.000Z",
) {
  return {
    kind: "oauth" as const,
    version: 1 as const,
    serverName: "app.linear/linear" as const,
    accessToken,
    refreshToken: "refresh-token",
    accessExpiresAt,
    scope: "read write",
    tokenType: "Bearer" as const,
    tokenEndpoint: "https://mcp.linear.app/token",
    resource: "https://mcp.linear.app/mcp",
    client: { clientId: "client", clientSecret: null, tokenEndpointAuthMethod: "none" as const },
  };
}

function workMaterial(accessExpiresAt?: string | null): RuntimeWorkMaterial {
  const envelope = encryptCompanionMcpRuntimeCredential({
    orgId,
    accountId,
    credentialGeneration: generation,
    credential: oauth("old-token", accessExpiresAt),
  }, masterKey);
  return {
    turnId: null,
    attemptId: null,
    messageEventId: null,
    promptText: null,
    turnStartedAt: null,
    memberTimezone: null,
    routineId: null,
    routineName: null,
    triggerName: null,
    triggerMode: null,
    routineIsolated: false,
    routineContext: null,
    decisionRequestKind: null,
    decisionResponsePayload: null,
    providerMaterial: [],
    skillMaterial: [],
    mcpMaterial: [{
      account_id: accountId,
      credential_generation: generation,
      account_config: {
        id: accountId,
        label: "Linear",
        lifecycle: "lazy",
        direct_tools: false,
        transport: "http",
        url: "https://mcp.linear.app/mcp",
        headers: { Authorization: "LINEAR_AUTH" },
      },
      ...snakeEnvelope(envelope),
    }],
    modelInput: null,
    hasVisibleOutput: false,
    attachments: [],
    configCatalog: null,
    boxId: null,
    agentEndpoint: null,
  };
}

const fence = {
  orgId,
  companionId,
  claimToken: "66666666-6666-4666-8666-666666666666",
  claimEpoch: 1n,
  gateEpoch: 1n,
  executorId: "executor",
  workKind: "settings",
  workId: "77777777-7777-4777-8777-777777777777",
} satisfies LeaseFence;

const authorization: RuntimeAuthorization = {
  authorized: true,
  denialCode: null,
  leaseExpiresAt: new Date("2027-01-01T01:00:00.000Z"),
  authorizationActorId: "actor-1",
  decisionActorId: null,
  clientSurface: "web",
  runtimeGeneration: 1n,
  boxId: "bx_23456789",
  boxState: "ready",
  piState: "idle",
  piInvocationId: "pi-invocation-1",
  diskLayoutVersion: 14,
  appliedSettingsRevision: 1n,
  appliedSkillsRevision: 1,
  modelId: "provider/model",
  persona: "Be useful",
  canWriteSkills: true,
  providerRefs: [],
  skillRefs: [],
  mcpRefs: [],
  desiredSettingsRevision: 1n,
  skillsRevision: 1,
  workCheckpoint: "starting",
  workCheckpointSequence: 0n,
  turnId: null,
  turnStatus: null,
  attemptStatus: null,
  dispatchState: null,
  eventCursor: null,
  unknownEventCount: null,
  malformedEventCount: null,
  oversizedEventCount: null,
  coldStartDeadlineAt: null,
  inactivityDeadlineAt: null,
  absoluteDeadlineAt: null,
  operationKind: null,
  operationStartedAt: null,
  operationAttemptCount: null,
  operationTrigger: null,
  operationLane: null,
  sourceDispatchState: null,
  sourcePiInvocationId: null,
  providerOperationId: null,
  targetSettingsRevision: null,
  targetSkillsRevision: null,
  decisionStatus: null,
  decisionDeliveryState: null,
  decisionRequestKey: null,
  decisionResponseText: null,
  commandId: null,
  commandPiInvocationId: null,
};

describe("runtime material provider and Box stager", () => {
  it("normalizes the staged Skills Hub API base to /v1", () => {
    expect(companionHubApiUrl("https://api.example.test")).toBe("https://api.example.test/v1");
    expect(companionHubApiUrl("https://api.example.test/")).toBe("https://api.example.test/v1");
    expect(companionHubApiUrl("https://api.example.test/v1")).toBe("https://api.example.test/v1");
    expect(companionHubApiUrl("https://api.example.test/v1/")).toBe("https://api.example.test/v1");
  });

  it.each(["web", "native_mobile"] as const)(
    "stages the unified OAuth and control capabilities on %s without exposing an access token",
    async (clientSurface) => {
    const material = workMaterial();
    const catalog = {
      companion: { model_id: "claude-opus-4-8", provider_id: "anthropic", persona: null },
      skills: [],
      plugins: [],
      note: "Propose changes with propose_config.",
    };
    const store = fakeStore({
      getMaterial: vi.fn(async () => material),
      getConfigCatalog: vi.fn(async () => catalog),
      mintHubToken: vi.fn(async () => ({
        token: "cmp_pat_hubtokenfixture000000000000000000000000",
        expiresAt: new Date("2027-01-01T04:00:00.000Z"),
      })),
      mintMcpBrokerToken: vi.fn(async () => ({
        token: `cmp_mcp_${"a".repeat(48)}`,
        expiresAt: new Date("2027-01-01T02:00:00.000Z"),
      })),
    });
    const stageExistingBox = vi.fn(async () => ({
      boxId: "bx_23456789",
      diskLayoutVersion: 14 as const,
    }));
    const pipeline = createRuntimeMaterialPipeline({
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
      loadAttachment: vi.fn(),
      storeAttachment: vi.fn(),
      now: () => Date.parse("2027-01-01T00:00:00.000Z"),
    });

    const frozen = await pipeline.materialProvider.getMaterial({ store, fence });
    expect(frozen).toBe(material);
    expect(store.getConfigCatalog).toHaveBeenCalled();
    expect(store.mintHubToken).toHaveBeenCalled();
    expect(store.mintMcpBrokerToken).toHaveBeenCalledWith(fence, expect.any(Number));

    await expect(pipeline.resourceStager.stageExistingBox({
      orgId,
      companionId,
      boxId: "bx_23456789",
      allowBoxCreate: false,
      authorization: {
        ...authorization,
        clientSurface,
        mcpRefs: [{ account_id: accountId, credential_generation: generation }],
      },
      material,
      clientSurface,
      targetSettingsRevision: 3n,
      targetSkillsRevision: 4,
      signal: new AbortController().signal,
    })).resolves.toEqual({
      diskLayoutVersion: 14,
      appliedSettingsRevision: 3n,
      appliedSkillsRevision: 4,
      materialExpiresAt: new Date("2027-01-01T02:00:00.000Z"),
      agentEndpoint: null,
    });
    expect(stageExistingBox).toHaveBeenCalledWith(expect.objectContaining({
      boxId: "bx_23456789",
      runtimeGeneration: 1,
      clientSurface,
      mcpCredentials: [],
      mcpAccounts: [{
        account: expect.objectContaining({ id: accountId, url: "https://mcp.linear.app/mcp" }),
        oauthBroker: { credentialGeneration: generation, github: false },
      }],
      skills: [expect.objectContaining({ slug: "companion" })],
      hubEnv: {
        COMPANION_API_URL: "https://api.example.test/v1",
        COMPANION_WORKSPACE_ID: orgId,
        COMPANION_DELEGATION_TOKEN: "cmp_pat_hubtokenfixture000000000000000000000000",
        COMPANION_MCP_BROKER_TOKEN: `cmp_mcp_${"a".repeat(48)}`,
        COMPANION_CONTROL_TOKEN: `cmp_ctl_${"c".repeat(48)}`,
      },
      configCatalog: catalog,
      signal: expect.any(AbortSignal),
    }));
    },
  );

  it("encrypts the staged agent endpoint tokens and surfaces only ciphertext", async () => {
    const nowMs = Date.parse("2027-01-01T00:00:00.000Z");
    const material = workMaterial(null);
    const store = fakeStore({
      getMaterial: vi.fn(async () => material),
      getConfigCatalog: vi.fn(async () => null),
      mintHubToken: vi.fn(async () => ({
        token: "cmp_pat_hubtokenfixture000000000000000000000000",
        expiresAt: new Date(nowMs + 6 * 60 * 60 * 1_000),
      })),
      mintMcpBrokerToken: vi.fn(async () => ({
        token: `cmp_mcp_${"e".repeat(48)}`,
        expiresAt: new Date(nowMs + 6 * 60 * 60 * 1_000),
      })),
    });
    const proxyToken = "c".repeat(64);
    const bearerToken = "d".repeat(64);
    const stageExistingBox = vi.fn(async () => ({
      boxId: "bx_23456789",
      diskLayoutVersion: 14 as const,
      agentEndpoint: {
        hostedUrl: "https://abc-8790.on.ascii.dev",
        proxyToken,
        bearerToken,
      },
    }));
    const pipeline = createRuntimeMaterialPipeline({
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
      loadAttachment: vi.fn(),
      storeAttachment: vi.fn(),
      now: () => nowMs,
    });

    await expect(pipeline.materialProvider.getMaterial({ store, fence })).resolves.toBe(material);
    const staged = await pipeline.resourceStager.stageExistingBox({
      orgId,
      companionId,
      boxId: "bx_23456789",
      allowBoxCreate: false,
      authorization: {
        ...authorization,
        mcpRefs: [{ account_id: accountId, credential_generation: generation }],
      },
      material,
      clientSurface: "web",
      targetSettingsRevision: 3n,
      targetSkillsRevision: 4,
      signal: new AbortController().signal,
    });
    expect(staged.agentEndpoint?.hostedUrl).toBe("https://abc-8790.on.ascii.dev");
    const ciphertext = staged.agentEndpoint?.tokenCiphertext ?? "";
    // Plaintext must never appear in what companion-runtime persists.
    expect(ciphertext).not.toContain(proxyToken);
    expect(ciphertext).not.toContain(bearerToken);
    const decrypted = decryptOpaqueValue({
      orgId,
      purpose: "companion_box_agent_endpoint",
      subjectId: companionId,
      ...JSON.parse(ciphertext),
    }, masterKey);
    expect(JSON.parse(decrypted)).toEqual({ proxyToken, bearerToken });
  });

  it("feeds the direct-transport registry from a live staging and from a durable material read", async () => {
    const nowMs = Date.parse("2027-01-01T00:00:00.000Z");
    const proxyToken = "c".repeat(64);
    const bearerToken = "d".repeat(64);
    const observedAt = new Date(nowMs - 60_000);
    const durableCiphertext = JSON.stringify(encryptOpaqueValue({
      orgId,
      purpose: "companion_box_agent_endpoint",
      subjectId: companionId,
      value: JSON.stringify({ proxyToken, bearerToken }),
    }, masterKey));
    const material = {
      ...workMaterial(null),
      boxId: "bx_23456789",
      agentEndpoint: {
        hostedUrl: "https://abc-8790.on.ascii.dev",
        tokenCiphertext: durableCiphertext,
        observedAt,
      },
    };
    const store = fakeStore({
      getMaterial: vi.fn(async () => material),
      getConfigCatalog: vi.fn(async () => null),
      mintHubToken: vi.fn(async () => ({
        token: "cmp_pat_hubtokenfixture000000000000000000000000",
        expiresAt: new Date(nowMs + 6 * 60 * 60 * 1_000),
      })),
      mintMcpBrokerToken: vi.fn(async () => ({
        token: `cmp_mcp_${"e".repeat(48)}`,
        expiresAt: new Date(nowMs + 6 * 60 * 60 * 1_000),
      })),
    });
    const registered: Array<{
      boxId: string;
      endpoint: { hostedUrl: string; proxyToken: string; bearerToken: string; observedAt: Date };
    }> = [];
    const stageExistingBox = vi.fn(async () => ({
      boxId: "bx_23456789",
      diskLayoutVersion: 14 as const,
      agentEndpoint: {
        hostedUrl: "https://fresh-8790.on.ascii.dev",
        proxyToken: "f".repeat(64),
        bearerToken: "g".repeat(64),
      },
    }));
    const pipeline = createRuntimeMaterialPipeline({
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
      loadAttachment: vi.fn(),
      storeAttachment: vi.fn(),
      registerAgentEndpoint: (boxId, endpoint) => registered.push({ boxId, endpoint }),
      now: () => nowMs,
    });

    // A durable material read decrypts the stored tokens and registers the endpoint by Box id.
    await expect(pipeline.materialProvider.getMaterial({ store, fence })).resolves.toBe(material);
    expect(registered).toEqual([{
      boxId: "bx_23456789",
      endpoint: {
        hostedUrl: "https://abc-8790.on.ascii.dev",
        proxyToken,
        bearerToken,
        observedAt,
      },
    }]);

    // A live staging registers the freshly minted endpoint with a now() observation.
    await pipeline.resourceStager.stageExistingBox({
      orgId,
      companionId,
      boxId: "bx_23456789",
      allowBoxCreate: false,
      authorization: {
        ...authorization,
        mcpRefs: [{ account_id: accountId, credential_generation: generation }],
      },
      material,
      clientSurface: "web",
      targetSettingsRevision: 3n,
      targetSkillsRevision: 4,
      signal: new AbortController().signal,
    });
    expect(registered[1]).toEqual({
      boxId: "bx_23456789",
      endpoint: {
        hostedUrl: "https://fresh-8790.on.ascii.dev",
        proxyToken: "f".repeat(64),
        bearerToken: "g".repeat(64),
        observedAt: new Date(nowMs),
      },
    });
  });

  it("skips registration on an undecryptable endpoint without failing the claim", async () => {
    const nowMs = Date.parse("2027-01-01T00:00:00.000Z");
    const material = {
      ...workMaterial(null),
      boxId: "bx_23456789",
      agentEndpoint: {
        hostedUrl: "https://abc-8790.on.ascii.dev",
        tokenCiphertext: "{\"ciphertext\":\"corrupted\"}",
        observedAt: new Date(nowMs),
      },
    };
    const store = fakeStore({
      getMaterial: vi.fn(async () => material),
      getConfigCatalog: vi.fn(async () => null),
      mintHubToken: vi.fn(async () => ({
        token: "cmp_pat_hubtokenfixture000000000000000000000000",
        expiresAt: new Date(nowMs + 6 * 60 * 60 * 1_000),
      })),
      mintMcpBrokerToken: vi.fn(async () => ({
        token: `cmp_mcp_${"e".repeat(48)}`,
        expiresAt: new Date(nowMs + 6 * 60 * 60 * 1_000),
      })),
    });
    const registered: Array<{ boxId: string }> = [];
    const pipeline = createRuntimeMaterialPipeline({
      masterKey,
      apiUrl: "https://api.example.test",
      bundledSkill: {
        slug: "companion",
        version: "1.0.0",
        checksum: `sha256:${"1".repeat(64)}`,
        archive: Buffer.from("bundled"),
      },
      runtime: () => fakeRuntime(vi.fn()),
      loadSkillArchive: vi.fn(),
      loadAttachment: vi.fn(),
      storeAttachment: vi.fn(),
      registerAgentEndpoint: (boxId) => registered.push({ boxId }),
      now: () => nowMs,
    });
    await expect(pipeline.materialProvider.getMaterial({ store, fence })).resolves.toBe(material);
    expect(registered).toHaveLength(0);
  });

  it.each([
    { label: "without expiry", ttlMs: null },
    { label: "lasting one second", ttlMs: 1_000 },
    { label: "lasting thirty seconds", ttlMs: 30_000 },
    { label: "lasting fifteen minutes", ttlMs: 15 * 60 * 1_000 },
    { label: "lasting more than two hours", ttlMs: 126 * 60 * 1_000 },
  ])("accepts an OAuth access token $label at startup", async ({ ttlMs }) => {
    const nowMs = Date.parse("2027-01-01T00:00:00.000Z");
    const material = workMaterial(ttlMs === null ? null : new Date(nowMs + ttlMs).toISOString());
    const store = fakeStore({
      getMaterial: vi.fn(async () => material),
      getConfigCatalog: vi.fn(async () => ({
        companion: { model_id: "model", provider_id: "provider", persona: null },
        skills: [],
        plugins: [],
        note: "note",
      })),
      mintHubToken: vi.fn(async () => ({
        token: "cmp_pat_hubtokenfixture000000000000000000000000",
        expiresAt: new Date(nowMs + 6 * 60 * 60 * 1_000),
      })),
      mintMcpBrokerToken: vi.fn(async () => ({
        token: `cmp_mcp_${"b".repeat(48)}`,
        expiresAt: new Date(nowMs + 6 * 60 * 60 * 1_000),
      })),
    });
    const stageExistingBox = vi.fn(async () => ({
      boxId: "bx_23456789",
      diskLayoutVersion: 14 as const,
    }));
    const pipeline = createRuntimeMaterialPipeline({
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
      loadAttachment: vi.fn(),
      storeAttachment: vi.fn(),
      now: () => nowMs,
    });

    await expect(pipeline.materialProvider.getMaterial({ store, fence })).resolves.toBe(material);
    await expect(pipeline.resourceStager.stageExistingBox({
      orgId,
      companionId,
      boxId: "bx_23456789",
      allowBoxCreate: false,
      authorization: {
        ...authorization,
        mcpRefs: [{ account_id: accountId, credential_generation: generation }],
      },
      material,
      clientSurface: "web",
      targetSettingsRevision: 3n,
      targetSkillsRevision: 4,
      signal: new AbortController().signal,
    })).resolves.toMatchObject({ diskLayoutVersion: 14 });
    expect(stageExistingBox).toHaveBeenCalledWith(expect.objectContaining({
      mcpCredentials: [],
      hubEnv: expect.not.objectContaining({ GITHUB_TOKEN: expect.anything() }),
    }));
  });

  it.each([
    {
      label: "provider credential rotation",
      material: {
        providerMaterial: [{
          provider_id: "openai",
          auth_method: "api_key",
          credential_generation: generation,
          credential_version: 1,
          ...fakeEncryptedEnvelope(),
        }],
      },
      refs: {
        providerRefs: [{
          provider_id: "openai",
          credential_generation: nextGeneration,
          credential_version: 2,
        }],
      },
    },
    {
      label: "Skill version rotation",
      material: {
        skillMaterial: [{
          skill_id: skillId,
          version_id: skillVersionId,
          slug: "example",
          version: "1.0.0",
          checksum: `sha256:${"1".repeat(64)}`,
          size_bytes: 1,
          storage_path: "org/example.tar.gz",
        }],
      },
      refs: {
        skillRefs: [{ skill_id: skillId, current_version_id: nextSkillVersionId }],
      },
    },
    {
      label: "MCP credential rotation",
      material: {
        mcpMaterial: [{
          account_id: accountId,
          credential_generation: generation,
          account_config: {},
          ...fakeEncryptedEnvelope(),
        }],
      },
      refs: {
        mcpRefs: [{ account_id: accountId, credential_generation: nextGeneration }],
      },
    },
  ])("rejects a stale $label before reading storage or contacting Box", async ({
    material: staleMaterial,
    refs,
  }) => {
    const material = {
      ...workMaterial(),
      providerMaterial: [],
      skillMaterial: [],
      mcpMaterial: [],
      ...staleMaterial,
    };
    const stageExistingBox = vi.fn();
    const loadSkillArchive = vi.fn();
    const pipeline = createRuntimeMaterialPipeline({
      masterKey,
      apiUrl: "https://api.example.test",
      bundledSkill: {
        slug: "companion",
        version: "1.0.0",
        checksum: `sha256:${"1".repeat(64)}`,
        archive: Buffer.from("bundled"),
      },
      runtime: () => fakeRuntime(stageExistingBox),
      loadSkillArchive,
      loadAttachment: vi.fn(),
      storeAttachment: vi.fn(),
    });

    await expect(pipeline.resourceStager.stageExistingBox({
      orgId,
      companionId,
      boxId: "bx_23456789",
      allowBoxCreate: false,
      authorization: { ...authorization, ...refs },
      material,
      clientSurface: "web",
      targetSettingsRevision: 3n,
      targetSkillsRevision: 4,
      signal: new AbortController().signal,
    })).rejects.toBeInstanceOf(RuntimeMaterialError);
    expect(loadSkillArchive).not.toHaveBeenCalled();
    expect(stageExistingBox).not.toHaveBeenCalled();
  });

  it("attributes a failed preparation credential mint to the exact authority grant", async () => {
    const stageExistingBox = vi.fn();
    const pipeline = createRuntimeMaterialPipeline({
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
      loadAttachment: vi.fn(),
      storeAttachment: vi.fn(),
    });
    const claim = preparationClaim();

    await expect(pipeline.preparationStager.stagePreparation({
      claim,
      authorize: async () => null,
      signal: new AbortController().signal,
    })).rejects.toMatchObject({
      name: "RuntimeExternalDependencyError",
      failureClass: "authority",
      dependency: { kind: "grant", id: `actor:${accountId}` },
    } satisfies Partial<RuntimeExternalDependencyError>);
    expect(stageExistingBox).not.toHaveBeenCalled();
  });

  it("preserves deterministic Box conflicts while classifying provider failures as outages", async () => {
    const conflict = new BoxRuntimeProviderError(
      "The durable Box identity does not match this Companion",
      409,
    );
    const invalidSnapshot = new BoxRuntimeProviderError("Invalid staged snapshot", 422);
    const providerFailure = new BoxRuntimeProviderError("Box API is unavailable", 502);
    const stageExistingBox = vi.fn()
      .mockRejectedValueOnce(conflict)
      .mockRejectedValueOnce(invalidSnapshot)
      .mockRejectedValueOnce(providerFailure);
    const pipeline = createRuntimeMaterialPipeline({
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
      loadAttachment: vi.fn(),
      storeAttachment: vi.fn(),
    });

    await expect(pipeline.preparationStager.stagePreparation({
      claim: preparationClaim(),
      authorize: async () => ({
        hubToken: "hub-token",
        mcpBrokerToken: null,
        controlToken: "control-token",
        expiresAt: new Date("2027-01-01T00:00:00.000Z"),
      }),
      signal: new AbortController().signal,
    })).rejects.toMatchObject({
      name: "RuntimeTerminalPreparationError",
      error: {
        code: "box_staging_conflict",
        message: "The Companion Box rejected its runtime material.",
        action: "none",
      },
    });

    await expect(pipeline.preparationStager.stagePreparation({
      claim: preparationClaim(),
      authorize: async () => ({
        hubToken: "hub-token",
        mcpBrokerToken: null,
        controlToken: "control-token",
        expiresAt: new Date("2027-01-01T00:00:00.000Z"),
      }),
      signal: new AbortController().signal,
    })).rejects.toMatchObject({
      name: "RuntimeTerminalPreparationError",
      error: { code: "box_staging_conflict", action: "none" },
    });

    await expect(pipeline.preparationStager.stagePreparation({
      claim: preparationClaim(),
      authorize: async () => ({
        hubToken: "hub-token",
        mcpBrokerToken: null,
        controlToken: "control-token",
        expiresAt: new Date("2027-01-01T00:00:00.000Z"),
      }),
      signal: new AbortController().signal,
    })).rejects.toMatchObject({
      name: "RuntimeExternalDependencyError",
      failureClass: "box",
      dependency: { kind: "box", id: "bx_23456789" },
    } satisfies Partial<RuntimeExternalDependencyError>);
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
    const pipeline = createRuntimeMaterialPipeline({
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
      loadAttachment: vi.fn(),
      storeAttachment: vi.fn(),
    });
    const claim = preparationClaim();
    const defer = vi.fn().mockResolvedValue(true);
    const fail = vi.fn().mockResolvedValue(true);
    const persistence = {
      claim: vi.fn().mockResolvedValueOnce(claim),
      checkpoint: vi.fn().mockResolvedValue(true),
      defer,
      fail,
      reauthorize: vi.fn().mockResolvedValue(true),
      mintCredentials: vi.fn().mockResolvedValue({
        hubToken: "hub-token",
        mcpBrokerToken: null,
        controlToken: "control-token",
        expiresAt: new Date("2027-01-01T00:00:00.000Z"),
      }),
    };
    const preparation = createRuntimeV3Preparation({
      persistence,
      box: {
        createGenerationBox: vi.fn(),
        applyGenerationBoxSettings: vi.fn(),
        getStatus: vi.fn(),
      },
      preparationStager: pipeline.preparationStager,
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
    actorId: accountId,
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
    fence: { token: generation, epoch: 1n, gateEpoch: 1n },
  };
}

function fakeEncryptedEnvelope() {
  return {
    ciphertext: "ciphertext",
    iv: "iv",
    auth_tag: "auth-tag",
    wrapped_dek: "wrapped-dek",
    wrap_iv: "wrap-iv",
    wrap_auth_tag: "wrap-auth-tag",
    key_id: "key-id",
  };
}

function snakeEnvelope(envelope: {
  ciphertext: string;
  iv: string;
  authTag: string;
  wrappedDek: string;
  wrapIv: string;
  wrapAuthTag: string;
  keyId: string;
}) {
  return {
    ciphertext: envelope.ciphertext,
    iv: envelope.iv,
    auth_tag: envelope.authTag,
    wrapped_dek: envelope.wrappedDek,
    wrap_iv: envelope.wrapIv,
    wrap_auth_tag: envelope.wrapAuthTag,
    key_id: envelope.keyId,
  };
}

function fakeRuntime(
  stageExistingBox: (
    ...args: Parameters<CompanionBoxRuntimeV2["stageExistingBox"]>
  ) => Promise<{ boxId: string; diskLayoutVersion: 14 }>,
): CompanionBoxRuntimeV2 {
  // SAFETY: The pipeline tests exercise only `stageExistingBox`; every other runtime call is
  // unreachable in these cases and the fake is intentionally scoped to that seam.
  return { stageExistingBox } as CompanionBoxRuntimeV2;
}

type MaterialTestStore = Pick<
  RuntimeStore,
  "getMaterial" | "getConfigCatalog" | "mintHubToken" | "mintMcpBrokerToken"
>;

function fakeStore(value: MaterialTestStore): RuntimeStore {
  // SAFETY: The material pipeline tests exercise only these material/token store methods.
  const store = Object.create(null) as RuntimeStore;
  return Object.assign(store, {
    mintControlToken: vi.fn(async () => ({
      token: `cmp_ctl_${"c".repeat(48)}`,
      expiresAt: new Date("2027-01-01T06:00:00.000Z"),
    })),
    ...value,
  });
}
