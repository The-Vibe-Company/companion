import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

process.env.COMPANION_SECRETS_MASTER_KEY ??= Buffer.alloc(32, 7).toString("base64");

const serviceMocks = vi.hoisted(() => {
  const noop = vi.fn(async () => undefined);
  return {
    ApiTokenRefreshError: class ApiTokenRefreshError extends Error {},
    acceptInvitation: noop,
    addComment: noop,
    assertCommentTarget: noop,
    addOrgAccessDomain: noop,
    archiveSkill: vi.fn(async () => ({ id: "skill-1" })),
    assignLabel: noop,
    authorizePublicSkillPackageForSession: vi.fn(),
    buildDependencyPlan: noop,
    buildSkillSharePlan: vi.fn(),
    clearSkillPublicVersion: vi.fn(),
    completeOnboarding: noop,
    createInvitation: noop,
    createLabel: noop,
    createOrg: noop,
    consumePublicSkillTransferTicket: vi.fn(),
    deleteLabel: noop,
    DependencyPublishError: class DependencyPublishError extends Error {},
    computeLocalSkillStatus: vi.fn(() => "installed"),
    getLocalSkillInstall: noop,
    getOnboardingContext: noop,
    getOnboardingState: noop,
    getSkillBySlug: vi.fn(),
    getSkillDependencies: noop,
    restoreSkill: vi.fn(async () => ({ id: "skill-1" })),
    getSkillFilterPreferences: noop,
    getOrgSettings: noop,
    getSkillNamingPolicy: vi.fn(),
    getDownloadVersion: vi.fn(),
    getCommentImageAsset: noop,
    getOrgLogoAsset: noop,
    getSkillPublicPreviewByShareToken: vi.fn(),
    getSkillShareTargetByShareToken: vi.fn(),
    issueApiToken: noop,
    joinOrgByDomain: noop,
    listApiTokens: noop,
    listLabels: noop,
    listOrgs: vi.fn(),
    listSkillComments: noop,
    listSkills: vi.fn(),
    listSkillVersions: noop,
    publishSkillVersion: noop,
    assertCanPublishSkillVersion: noop,
    renameSkill: vi.fn(),
    renameLabel: noop,
    reportLocalSkillInstall: noop,
    removeOrgAccessDomain: noop,
    removeMember: noop,
    revokeApiToken: noop,
    revokeInvitation: noop,
    setCommentDeprecated: noop,
    setLabelColor: noop,
    setLabelIcon: noop,
    setMemberRole: noop,
    setSkillFilterPreferences: noop,
    setSkillPublicVersion: vi.fn(),
    setOrgLogoFromUpload: noop,
    orgLogoPublicPath: vi.fn(() => "/org-logo.png"),
    shareSkill: vi.fn(),
    installSkill: noop,
    unassignLabel: noop,
    uninstallSkill: noop,
    updateOrg: noop,
    updateUserProfile: noop,
    listPersonalLabels: noop,
    createPersonalLabel: noop,
    assignPersonalLabel: noop,
    unassignPersonalLabel: noop,
    setPersonalLabelColor: noop,
    setPersonalLabelIcon: noop,
    renamePersonalLabel: noop,
    deletePersonalLabel: noop,
    listSecrets: vi.fn(),
    getSecret: vi.fn(),
    createSecret: vi.fn(),
    updateSecret: vi.fn(),
    rotateSecret: vi.fn(),
    deleteSecret: vi.fn(),
    getSkillSecretConfiguration: vi.fn(),
    setSkillSecretBinding: vi.fn(),
    removeSkillSecretBinding: vi.fn(),
    setSkillSecretSuggestion: vi.fn(),
    removeSkillSecretSuggestion: vi.fn(),
    acceptSkillSecretSuggestion: vi.fn(),
    preflightSecretRetrieval: vi.fn(),
    createSecretRetrievalGrant: vi.fn(),
    redeemSecretRetrievalGrant: vi.fn(),
    ensureUserBootstrap: noop,
    resolveApiToken: vi.fn(),
    refreshApiToken: vi.fn(),
    resolveDependencyReferences: vi.fn(async (input: { slugs: string[] }) =>
      input.slugs.map((slug) => ({ declaredSlug: slug, slug, skillId: null })),
    ),
    resolvedDependencySlugs: vi.fn((dependencies: Array<{ slug: string }>) => [...new Set(dependencies.map((d) => d.slug))]),
    resolvedDependencyIdMap: vi.fn((dependencies: Array<{ slug: string; skillId: string | null }>) =>
      Object.fromEntries(dependencies.filter((d) => d.skillId).map((d) => [d.slug, d.skillId])),
    ),
    prepareSkillPublishDependencies: vi.fn(async (input: { slugs: string[] }) => {
      const references = input.slugs.map((slug) => ({ declaredSlug: slug, slug, skillId: null }));
      return { references, slugs: [...new Set(input.slugs)], manifestDependencies: {} };
    }),
    SkillPublicReleaseConflictError: class SkillPublicReleaseConflictError extends Error {},
    SkillPublicReleaseForbiddenError: class SkillPublicReleaseForbiddenError extends Error {},
    SkillPublicReleaseNotFoundError: class SkillPublicReleaseNotFoundError extends Error {},
    SkillPublicReleaseValidationError: class SkillPublicReleaseValidationError extends Error {},
  };
});

const dbMocks = vi.hoisted(() => ({
  withTenantContext: vi.fn(async (_ctx: unknown, fn: (database: unknown) => unknown) => fn({})),
}));

const coreMocks = vi.hoisted(() => ({
  bumpCompanionSkillRevision: vi.fn(async () => 1),
}));

const authMocks = vi.hoisted(() => ({
  getSession: vi.fn(async (): Promise<unknown | null> => null),
  handler: vi.fn(),
}));

const storageMocks = vi.hoisted(() => ({
  getSkillArchive: vi.fn(async () => Buffer.from("stored-tar")),
  putPublicSkillReleaseSnapshot: vi.fn(async () => "org-1/public-releases/sha256/snapshot.zip"),
}));
const skillsMocks = vi.hoisted(() => ({ tarGzToZip: vi.fn(async () => Buffer.from("public-zip-bytes")) }));

vi.mock("@hono/node-server", () => ({
  serve: vi.fn(),
}));

vi.mock("@companion/auth", () => ({
  auth: {
    api: {
      getSession: authMocks.getSession,
    },
    handler: authMocks.handler,
    $Infer: {},
  },
  registerAgentCapabilityExecutor: vi.fn(() => () => undefined),
}));

vi.mock("@companion/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@companion/db")>()),
  ...dbMocks,
}));

vi.mock("@companion/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@companion/core")>()),
  ...coreMocks,
}));

vi.mock("@companion/core/services", () => serviceMocks);
vi.mock("@companion/storage", async (importActual) => ({
  ...(await importActual<typeof import("@companion/storage")>()),
  getSkillArchive: storageMocks.getSkillArchive,
  putPublicSkillReleaseSnapshot: storageMocks.putPublicSkillReleaseSnapshot,
}));
vi.mock("@companion/skills", async (importActual) => ({
  ...(await importActual<typeof import("@companion/skills")>()),
  tarGzToZip: skillsMocks.tarGzToZip,
}));

import { app } from "./index";

describe("Skills Hub-only API registry", () => {
  it("does not register any removed execution endpoint", () => {
    const paths = app.routes.map((route) => route.path);
    expect(paths.some((path) =>
      /^\/v1\/(projects|runs|models|model-preferences|org-model-preferences|provider-connections|org-provider-connections)(\/|$)/.test(path)
      || /^\/v1\/skills\/[^/]+\/runs(\/|$)/.test(path),
    )).toBe(false);
    expect(paths).toContain("/v1/skills");
  });
});

const actorA = { id: "user-a", email: "a@example.test", name: "User A" };
const actorB = { id: "user-b", email: "b@example.test", name: "User B" };

function tokenFor(header: string | undefined) {
  if (header === "read-a") return { actor: actorA, orgId: "org-1", scopes: ["skills:read"] };
  if (header === "read-b") return { actor: actorB, orgId: "org-1", scopes: ["skills:read"] };
  if (header === "write-only") return { actor: actorA, orgId: "org-1", scopes: ["skills:write"] };
  if (header === "read-write") return { actor: actorA, orgId: "org-1", scopes: ["skills:read", "skills:write"] };
  if (header === "secrets-a") return { actor: actorA, orgId: "org-1", scopes: ["secrets:read"] };
  if (header === "secrets-write-a") return { actor: actorA, orgId: "org-1", scopes: ["secrets:write"] };
  return null;
}

describe("Secrets PAT boundary and retrieval protocol", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authMocks.getSession.mockResolvedValue(null);
    serviceMocks.resolveApiToken.mockImplementation(async (token: string) => tokenFor(token));
    serviceMocks.getDownloadVersion.mockResolvedValue({
      versionId: "version-2",
      isCurrent: true,
      version: "2.0.0",
      storagePath: "skills/review/2.0.0.tar.gz",
    });
  });

  it("allows authorized metadata reads only with secrets:read", async () => {
    serviceMocks.listSecrets.mockResolvedValue([{ id: "meta-only", name: "Deploy key" }]);
    const allowed = await app.request("/v1/secrets", { headers: { Authorization: "Bearer secrets-a" } });
    expect(allowed.status).toBe(200);
    await expect(allowed.json()).resolves.toEqual([{ id: "meta-only", name: "Deploy key" }]);
    expect(serviceMocks.listSecrets).toHaveBeenCalledWith(expect.objectContaining({ actor: actorA, orgId: "org-1" }));

    const denied = await app.request("/v1/secrets", { headers: { Authorization: "Bearer read-a" } });
    expect(denied.status).toBe(401);
  });

  it("lets secrets:write create a write-only value", async () => {
    const sentinel = "secret-value-that-must-not-return";
    serviceMocks.createSecret.mockResolvedValue({ id: "secret-1", name: "Deploy key", key: "DEPLOY_KEY", audience: "personal" });
    const denied = await app.request("/v1/secrets", {
      method: "POST",
      headers: { Authorization: "Bearer secrets-a", "content-type": "application/json" },
      body: JSON.stringify({ name: "Deploy key", key: "DEPLOY_KEY", value: sentinel, audience: "personal", recipient_ids: [] }),
    });
    expect(denied.status).toBe(400);

    const created = await app.request("/v1/secrets", {
      method: "POST",
      headers: { Authorization: "Bearer secrets-write-a", "content-type": "application/json" },
      body: JSON.stringify({ name: "Deploy key", key: "DEPLOY_KEY", value: sentinel, audience: "personal", recipient_ids: [] }),
    });
    expect(created.status).toBe(201);
    expect(JSON.stringify(await created.json())).not.toContain(sentinel);
    expect(serviceMocks.createSecret).toHaveBeenCalledWith(expect.objectContaining({ actor: actorA, orgId: "org-1", value: expect.objectContaining({ value: sentinel }) }));
  });

  it("gives a secrets:write PAT parity with signed-in secret management", async () => {
    const secretId = "a6b47409-4a02-4d8a-9df7-c50d2b1365e1";
    const slotId = "4c2fb48c-55a6-51b5-a7e9-0ec2c36f38f4";
    const metadata = { id: secretId, name: "Deploy key", key: "DEPLOY_KEY", audience: "organization" };
    const configuration = { skill_id: "skill-1", slug: "demo-skill", configured: true, blockers: 0, warnings: 0, slots: [] };
    serviceMocks.updateSecret.mockResolvedValue(metadata);
    serviceMocks.rotateSecret.mockResolvedValue(metadata);
    serviceMocks.deleteSecret.mockResolvedValue(undefined);
    serviceMocks.setSkillSecretBinding.mockResolvedValue(configuration);
    serviceMocks.removeSkillSecretBinding.mockResolvedValue(configuration);
    serviceMocks.setSkillSecretSuggestion.mockResolvedValue(configuration);
    serviceMocks.removeSkillSecretSuggestion.mockResolvedValue(configuration);
    serviceMocks.acceptSkillSecretSuggestion.mockResolvedValue(configuration);

    const headers = { Authorization: "Bearer secrets-write-a", "content-type": "application/json" };
    const update = await app.request(`/v1/secrets/${secretId}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ name: "Updated deploy key" }),
    });
    expect(update.status).toBe(200);

    const rotate = await app.request(`/v1/secrets/${secretId}/rotate`, {
      method: "POST",
      headers,
      body: JSON.stringify({ value: "rotated-value" }),
    });
    expect(rotate.status).toBe(200);

    const bind = await app.request(`/v1/skills/demo-skill/secret-bindings/${slotId}`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ secret_id: secretId }),
    });
    expect(bind.status).toBe(200);

    const unbind = await app.request(`/v1/skills/demo-skill/secret-bindings/${slotId}`, {
      method: "DELETE",
      headers,
    });
    expect(unbind.status).toBe(200);

    const suggest = await app.request(`/v1/skills/demo-skill/secret-suggestions/${slotId}`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ secret_id: secretId }),
    });
    expect(suggest.status).toBe(200);

    const unsuggest = await app.request(`/v1/skills/demo-skill/secret-suggestions/${slotId}`, {
      method: "DELETE",
      headers,
    });
    expect(unsuggest.status).toBe(200);

    const accept = await app.request(`/v1/skills/demo-skill/secret-suggestions/${slotId}/accept`, {
      method: "POST",
      headers,
    });
    expect(accept.status).toBe(200);

    const remove = await app.request(`/v1/secrets/${secretId}`, { method: "DELETE", headers });
    expect(remove.status).toBe(200);

    expect(serviceMocks.updateSecret).toHaveBeenCalledWith(expect.objectContaining({ actor: actorA, orgId: "org-1" }));
    expect(serviceMocks.rotateSecret).toHaveBeenCalledWith(expect.objectContaining({ actor: actorA, orgId: "org-1" }));
    expect(serviceMocks.setSkillSecretBinding).toHaveBeenCalledWith(expect.objectContaining({ actor: actorA, orgId: "org-1", slug: "demo-skill", slotId, secretId }));
    expect(serviceMocks.setSkillSecretSuggestion).toHaveBeenCalledWith(expect.objectContaining({ actor: actorA, orgId: "org-1", slug: "demo-skill", slotId, secretId }));

    const denied = await app.request(`/v1/skills/demo-skill/secret-bindings/${slotId}`, {
      method: "PUT",
      headers: { Authorization: "Bearer secrets-a", "content-type": "application/json" },
      body: JSON.stringify({ secret_id: secretId }),
    });
    expect(denied.status).toBe(400);
  });

  it("rejects an oversized secret request before calling the service", async () => {
    const oversized = await app.request("/v1/secrets", {
      method: "POST",
      headers: { Authorization: "Bearer secrets-write-a", "content-type": "application/json" },
      body: JSON.stringify({ name: "Oversized", key: "TOO_LARGE", value: "x".repeat(129 * 1024), audience: "personal", recipient_ids: [] }),
    });

    expect(oversized.status).toBe(413);
    await expect(oversized.json()).resolves.toMatchObject({ ok: false, error: expect.stringContaining("128 KiB") });
    expect(serviceMocks.createSecret).not.toHaveBeenCalled();
  });

  it("runs preflight, grant, and one-time redemption behind secrets:read", async () => {
    serviceMocks.preflightSecretRetrieval.mockResolvedValue({ plan_id: "plan-1", blockers: 0, warnings: 0, items: [], tombstones: [] });
    serviceMocks.createSecretRetrievalGrant.mockResolvedValue({ grant: "cmp_grant_value", expires_at: "soon", item_count: 1 });
    serviceMocks.redeemSecretRetrievalGrant.mockResolvedValue({ ok: true, value: { operation_id: "773941d6-bcb2-4c3b-b1a9-2eea1d17ecfd", items: [], tombstones: [] } });

    const preflight = await app.request("/v1/secret-retrievals/preflight", {
      method: "POST",
      headers: { Authorization: "Bearer secrets-a", "content-type": "application/json" },
      body: JSON.stringify({ operation_id: "773941d6-bcb2-4c3b-b1a9-2eea1d17ecfd", skills: [{ slug: "demo-skill" }], direct: [] }),
    });
    expect(preflight.status).toBe(200);

    const grant = await app.request("/v1/secret-retrievals/2decd106-927d-4a99-9515-f9281038f944/grant", { method: "POST", headers: { Authorization: "Bearer secrets-a" } });
    expect(grant.status).toBe(200);

    const redeem = await app.request("/v1/secret-grants/redeem", {
      method: "POST",
      headers: { Authorization: "Bearer secrets-a", "content-type": "application/json" },
      body: JSON.stringify({ grant: "cmp_grant_value" }),
    });
    expect(redeem.status).toBe(200);
    expect(serviceMocks.redeemSecretRetrievalGrant).toHaveBeenCalledWith(expect.objectContaining({ grant: "cmp_grant_value", actor: actorA }));
  });

  it("returns 503 for every Secrets surface when the root key is missing without stopping the rest of the API", async () => {
    const configured = process.env.COMPANION_SECRETS_MASTER_KEY;
    delete process.env.COMPANION_SECRETS_MASTER_KEY;
    try {
      const secretResponse = await app.request("/v1/secrets", { headers: { Authorization: "Bearer secrets-a" } });
      expect(secretResponse.status).toBe(503);
      expect(serviceMocks.listSecrets).not.toHaveBeenCalled();

      serviceMocks.getSkillPublicPreviewByShareToken.mockResolvedValue(null);
      const ordinaryResponse = await app.request("/v1/public/skills/unknown");
      expect(ordinaryResponse.status).toBe(404);
    } finally {
      process.env.COMPANION_SECRETS_MASTER_KEY = configured;
    }
  });
});

describe("GET /v1/public/skills/:token", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authMocks.getSession.mockResolvedValue(null);
  });

  it("returns a metadata-only skill preview without auth", async () => {
    serviceMocks.getSkillPublicPreviewByShareToken.mockResolvedValue({
      display_name: "Mega Code Review",
      slug: "mega-code-review",
      description: "Review changes with repository context.",
      current_version: "1.2.3",
      creator_name: "Ada Lovelace",
      creator_initials: "AL",
      updated_at: "2026-06-25T10:00:00.000Z",
      public_release: {
        version: "1.2.3",
        checksum: `sha256:${"a".repeat(64)}`,
        size_bytes: 123,
        released_at: "2026-06-24T10:00:00.000Z",
      },
    });

    const res = await app.request("/v1/public/skills/share-token-1");

    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    await expect(res.json()).resolves.toEqual({
      display_name: "Mega Code Review",
      slug: "mega-code-review",
      description: "Review changes with repository context.",
      current_version: "1.2.3",
      creator_name: "Ada Lovelace",
      creator_initials: "AL",
      updated_at: "2026-06-25T10:00:00.000Z",
      public_release: {
        version: "1.2.3",
        checksum: `sha256:${"a".repeat(64)}`,
        size_bytes: 123,
        released_at: "2026-06-24T10:00:00.000Z",
      },
    });
    expect(serviceMocks.getSkillPublicPreviewByShareToken).toHaveBeenCalledWith({ token: "share-token-1" });
    expect(dbMocks.withTenantContext).not.toHaveBeenCalled();
  });

  it("404s unknown, personal, or archived share tokens", async () => {
    serviceMocks.getSkillPublicPreviewByShareToken.mockResolvedValue(null);

    const res = await app.request("/v1/public/skills/not-public");

    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toMatchObject({ ok: false, error: "skill not found" });
  });
});

describe("removed skill star endpoint", () => {
  it("returns the normal 404", async () => {
    const res = await app.request("/v1/skills/mega-code-review/star", { method: "POST" });
    expect(res.status).toBe(404);
  });
});

describe("PUT/DELETE /v1/skills/:slug/public-version", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authMocks.getSession.mockResolvedValue(null);
    serviceMocks.resolveApiToken.mockImplementation(async (token: string) => tokenFor(token));
    serviceMocks.getDownloadVersion.mockResolvedValue({
      versionId: "version-2",
      isCurrent: true,
      version: "2.0.0",
      storagePath: "skills/review/2.0.0.tar.gz",
    });
  });

  it("promotes the exact current version with skills:write", async () => {
    serviceMocks.setSkillPublicVersion.mockResolvedValue({
      ok: true,
      public_version: "2.0.0",
      share_token: "share-token-1",
      changed: true,
    });

    const response = await app.request("/v1/skills/review/public-version", {
      method: "PUT",
      headers: { authorization: "Bearer write-only", "content-type": "application/json" },
      body: JSON.stringify({ version: "2.0.0" }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ public_version: "2.0.0", changed: true });
    expect(serviceMocks.getDownloadVersion).toHaveBeenCalledWith(expect.objectContaining({
      actor: actorA,
      orgId: "org-1",
      slug: "review",
      version: "2.0.0",
      forPublicRelease: true,
    }));
    expect(serviceMocks.setSkillPublicVersion).toHaveBeenCalledWith(expect.objectContaining({
      actor: actorA,
      orgId: "org-1",
      slug: "review",
      version: "2.0.0",
      packageChecksum: "sha256:a351d9ebec44a0a9e50a392a84d43d2cb610b74149bb6baf0d8f74da55765761",
      packageSizeBytes: 16,
      expectedCurrentVersionId: "version-2",
    }));
    expect(storageMocks.putPublicSkillReleaseSnapshot).toHaveBeenCalledWith({
      orgId: "org-1",
      checksum: "sha256:a351d9ebec44a0a9e50a392a84d43d2cb610b74149bb6baf0d8f74da55765761",
      body: Buffer.from("public-zip-bytes"),
    });
  });

  it("returns 409 when a prepared current version becomes non-current during promotion", async () => {
    serviceMocks.setSkillPublicVersion.mockRejectedValueOnce(
      new serviceMocks.SkillPublicReleaseConflictError("the current skill version changed concurrently"),
    );

    const response = await app.request("/v1/skills/review/public-version", {
      method: "PUT",
      headers: { authorization: "Bearer write-only", "content-type": "application/json" },
      body: JSON.stringify({ version: "2.0.0" }),
    });

    expect(response.status).toBe(409);
    expect(storageMocks.putPublicSkillReleaseSnapshot).toHaveBeenCalledOnce();
    expect(serviceMocks.setSkillPublicVersion).toHaveBeenCalledWith(expect.objectContaining({
      version: "2.0.0",
      expectedCurrentVersionId: "version-2",
    }));
  });

  it("performs Core public-release authorization before writing the snapshot", async () => {
    serviceMocks.getDownloadVersion.mockRejectedValueOnce(
      new serviceMocks.SkillPublicReleaseForbiddenError("forbidden"),
    );

    const response = await app.request("/v1/skills/review/public-version", {
      method: "PUT",
      headers: { authorization: "Bearer write-only", "content-type": "application/json" },
      body: JSON.stringify({ version: "2.0.0" }),
    });

    expect(response.status).toBe(403);
    expect(storageMocks.putPublicSkillReleaseSnapshot).not.toHaveBeenCalled();
    expect(serviceMocks.setSkillPublicVersion).not.toHaveBeenCalled();
  });

  it("does not promote a historical archive that cannot be converted safely", async () => {
    skillsMocks.tarGzToZip.mockRejectedValueOnce(new Error("Windows-unsafe path segment"));

    const response = await app.request("/v1/skills/review/public-version", {
      method: "PUT",
      headers: { authorization: "Bearer write-only", "content-type": "application/json" },
      body: JSON.stringify({ version: "2.0.0" }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "the stored skill package is not safe for public installation; publish a corrected version first",
    });
    expect(storageMocks.putPublicSkillReleaseSnapshot).not.toHaveBeenCalled();
    expect(serviceMocks.setSkillPublicVersion).not.toHaveBeenCalled();
  });

  it("rejects missing write scope and maps authorization/CAS failures", async () => {
    const missingScope = await app.request("/v1/skills/review/public-version", {
      method: "PUT",
      headers: { authorization: "Bearer read-a", "content-type": "application/json" },
      body: JSON.stringify({ version: "2.0.0" }),
    });
    expect(missingScope.status).toBe(400);

    serviceMocks.setSkillPublicVersion.mockRejectedValueOnce(
      new serviceMocks.SkillPublicReleaseForbiddenError("forbidden"),
    );
    const forbidden = await app.request("/v1/skills/review/public-version", {
      method: "PUT",
      headers: { authorization: "Bearer write-only", "content-type": "application/json" },
      body: JSON.stringify({ version: "2.0.0" }),
    });
    expect(forbidden.status).toBe(403);

    serviceMocks.setSkillPublicVersion.mockRejectedValueOnce(
      new serviceMocks.SkillPublicReleaseConflictError("concurrent"),
    );
    const conflict = await app.request("/v1/skills/review/public-version", {
      method: "PUT",
      headers: { authorization: "Bearer write-only", "content-type": "application/json" },
      body: JSON.stringify({ version: "2.0.0" }),
    });
    expect(conflict.status).toBe(409);
  });

  it("withdraws idempotently without rotating the share token", async () => {
    serviceMocks.clearSkillPublicVersion.mockResolvedValue({
      ok: true,
      public_version: null,
      share_token: "share-token-1",
      changed: false,
    });
    const response = await app.request("/v1/skills/review/public-version", {
      method: "DELETE",
      headers: { authorization: "Bearer write-only" },
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      public_version: null,
      share_token: "share-token-1",
      changed: false,
    });
  });
});

describe("GET/POST /v1/skills/:slug/share", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    serviceMocks.resolveApiToken.mockImplementation(async (token: string) => tokenFor(token));
  });

  it("returns the mandatory private dependency plan", async () => {
    serviceMocks.buildSkillSharePlan.mockResolvedValue({
      slug: "pdf-extractor",
      dependencies: [{ slug: "markdown-report", status: "satisfied", note: null }],
      blocked: [],
    });

    const res = await app.request("/v1/skills/pdf-extractor/share-plan", { headers: { Authorization: "Bearer read-a" } });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      slug: "pdf-extractor",
      dependencies: [{ slug: "markdown-report", status: "satisfied", note: null }],
      blocked: [],
    });
    expect(serviceMocks.buildSkillSharePlan).toHaveBeenCalledWith(
      expect.objectContaining({ actor: actorA, orgId: "org-1", slug: "pdf-extractor" }),
    );
  });

  it("shares the skill and echoes migrated private dependencies", async () => {
    serviceMocks.shareSkill.mockResolvedValue({ scope: "org", shared_dependencies: ["markdown-report"] });

    const res = await app.request("/v1/skills/pdf-extractor/share", {
      method: "POST",
      headers: { Authorization: "Bearer write-only" },
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      ok: true,
      slug: "pdf-extractor",
      scope: "org",
      shared_dependencies: ["markdown-report"],
    });
    expect(serviceMocks.shareSkill).toHaveBeenCalledWith(
      expect.objectContaining({ actor: actorA, orgId: "org-1", slug: "pdf-extractor" }),
    );
  });

  it("keeps share-plan behind skills:read", async () => {
    const res = await app.request("/v1/skills/pdf-extractor/share-plan", { headers: { Authorization: "Bearer write-only" } });

    expect(res.status).toBe(400);
    expect(serviceMocks.buildSkillSharePlan).not.toHaveBeenCalled();
  });
});

describe("POST /v1/skills/:slug/rename", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    serviceMocks.resolveApiToken.mockImplementation(async (token: string) => tokenFor(token));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("renames a skill through the explicit service mutation", async () => {
    vi.stubEnv("COMPANION_COMPANIONS_ENABLED", "true");
    vi.stubEnv("COMPANION_COMPANIONS_ALLOWED_EMAIL_DOMAINS", "example.test");
    serviceMocks.renameSkill.mockResolvedValue({
      ok: true,
      id: "skill-1",
      old_slug: "skill-creator",
      slug: "skill-creator-and-eval",
      title: "Skill Creator and Eval",
    });

    const res = await app.request("/v1/skills/skill-creator/rename", {
      method: "POST",
      headers: { Authorization: "Bearer write-only", "content-type": "application/json" },
      body: JSON.stringify({ newSlug: "skill-creator-and-eval", title: "Skill Creator and Eval" }),
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      ok: true,
      id: "skill-1",
      old_slug: "skill-creator",
      slug: "skill-creator-and-eval",
      title: "Skill Creator and Eval",
    });
    expect(serviceMocks.renameSkill).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: actorA,
        orgId: "org-1",
        slug: "skill-creator",
        newSlug: "skill-creator-and-eval",
        title: "Skill Creator and Eval",
      }),
    );
    // Boxes stage skills by slug, so a rename marks every selecting Companion as needing a restage.
    expect(coreMocks.bumpCompanionSkillRevision).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "org-1", skillId: "skill-1" }),
    );
  });

  it("keeps the durable restage invalidation when Companions are disabled", async () => {
    vi.stubEnv("COMPANION_COMPANIONS_ENABLED", "false");
    vi.stubEnv("COMPANION_COMPANIONS_ALLOWED_EMAIL_DOMAINS", "example.test");
    serviceMocks.renameSkill.mockResolvedValue({
      ok: true,
      id: "skill-1",
      old_slug: "skill-creator",
      slug: "skill-creator-and-eval",
      title: "Skill Creator and Eval",
    });

    const res = await app.request("/v1/skills/skill-creator/rename", {
      method: "POST",
      headers: { Authorization: "Bearer write-only", "content-type": "application/json" },
      body: JSON.stringify({ newSlug: "skill-creator-and-eval" }),
    });

    expect(res.status).toBe(200);
    expect(serviceMocks.renameSkill).toHaveBeenCalledOnce();
    expect(coreMocks.bumpCompanionSkillRevision).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "org-1", skillId: "skill-1" }),
    );
  });

  it("validates the new slug before calling the service", async () => {
    const res = await app.request("/v1/skills/skill-creator/rename", {
      method: "POST",
      headers: { Authorization: "Bearer write-only", "content-type": "application/json" },
      body: JSON.stringify({ newSlug: "Skill Creator" }),
    });

    expect(res.status).toBe(400);
    expect(serviceMocks.renameSkill).not.toHaveBeenCalled();
  });

  it("requires skills:write", async () => {
    const res = await app.request("/v1/skills/skill-creator/rename", {
      method: "POST",
      headers: { Authorization: "Bearer read-a", "content-type": "application/json" },
      body: JSON.stringify({ newSlug: "skill-creator-and-eval" }),
    });

    expect(res.status).toBe(400);
    expect(serviceMocks.renameSkill).not.toHaveBeenCalled();
  });
});

describe("durable Companion Skill invalidations", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("COMPANION_COMPANIONS_ENABLED", "false");
    vi.stubEnv("COMPANION_COMPANIONS_ALLOWED_EMAIL_DOMAINS", "example.test");
    serviceMocks.resolveApiToken.mockImplementation(async (token: string) => tokenFor(token));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each([
    { action: "archive", service: serviceMocks.archiveSkill },
    { action: "restore", service: serviceMocks.restoreSkill },
  ])("marks selected Companions stale after $action while execution is disabled", async ({
    action,
    service,
  }) => {
    service.mockResolvedValueOnce({ id: "skill-1" });

    const res = await app.request(`/v1/skills/skill-creator/${action}`, {
      method: "POST",
      headers: { Authorization: "Bearer write-only", "content-type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(200);
    expect(service).toHaveBeenCalledOnce();
    expect(coreMocks.bumpCompanionSkillRevision).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "org-1", skillId: "skill-1" }),
    );
  });
});

describe("GET /v1/skills/share-target/:token", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authMocks.getSession.mockResolvedValue({
      user: { id: "user-a", email: "a@example.test", name: "User A" },
      session: { id: "session-1" },
    });
  });

  it("returns the token's org target for a signed-in member", async () => {
    serviceMocks.getSkillShareTargetByShareToken.mockResolvedValue({
      org_id: "org-target",
      slug: "mega-code-review",
    });

    const res = await app.request("/v1/skills/share-target/share-token-1", {
      headers: { cookie: "session=value" },
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ org_id: "org-target", slug: "mega-code-review" });
    expect(serviceMocks.getSkillShareTargetByShareToken).toHaveBeenCalledWith({
      actor: actorA,
      token: "share-token-1",
    });
  });

  it("404s when the token is unknown or not accessible to the signed-in user", async () => {
    serviceMocks.getSkillShareTargetByShareToken.mockResolvedValue(null);

    const res = await app.request("/v1/skills/share-target/not-public", {
      headers: { cookie: "session=value" },
    });

    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toMatchObject({ ok: false, error: "skill not found" });
  });

  it("requires a signed-in session", async () => {
    authMocks.getSession.mockResolvedValue(null);

    const res = await app.request("/v1/skills/share-target/share-token-1");

    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toMatchObject({ ok: false, error: "not authenticated" });
    expect(serviceMocks.getSkillShareTargetByShareToken).not.toHaveBeenCalled();
  });
});

describe("GET /v1/orgs/current/skill-naming-policy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    serviceMocks.resolveApiToken.mockImplementation(async (token: string) => tokenFor(token));
    serviceMocks.getSkillNamingPolicy.mockResolvedValue("verb-object-root");
  });

  it("allows a skills:read PAT to read the org policy", async () => {
    const res = await app.request("/v1/orgs/current/skill-naming-policy", {
      headers: { Authorization: "Bearer read-a" },
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ policy: "verb-object-root" });
    expect(serviceMocks.getSkillNamingPolicy).toHaveBeenCalledWith(
      expect.objectContaining({ actor: actorA, orgId: "org-1" }),
    );
  });

  it("rejects a PAT without skills:read with 401", async () => {
    const res = await app.request("/v1/orgs/current/skill-naming-policy", {
      headers: { Authorization: "Bearer write-only" },
    });

    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toMatchObject({ ok: false, error: expect.stringContaining("skills:read") });
    expect(serviceMocks.getSkillNamingPolicy).not.toHaveBeenCalled();
  });

  it("returns 401 when the actor is not a member of the selected org", async () => {
    serviceMocks.getSkillNamingPolicy.mockRejectedValue(new Error("not a member of this organization"));

    const res = await app.request("/v1/orgs/current/skill-naming-policy", {
      headers: { Authorization: "Bearer read-a" },
    });

    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toMatchObject({ ok: false, error: "not a member of this organization" });
  });
});

/**
 * Product promise:
 * The official Companion installer can resolve skill metadata with its scoped PAT before downloading
 * the dependency closure.
 *
 * Regression caught:
 * Making the canonical detail route session-only returns 401 to install_skill.py and blocks every
 * automated skill installation before package download.
 *
 * Why this test is HTTP-level:
 * The failure lives in route authentication and scope wiring; the service visibility rules are
 * protected separately by the skill lifecycle integration suite.
 *
 * Failure proof:
 * Removing PAT opt-in or the skills:read gate from GET /v1/skills/:slug makes these cases fail.
 */
describe("GET /v1/skills/:slug", () => {
  const row = { id: "skill-1", slug: "workspace-skill", current_version: "1.2.3" };

  beforeEach(() => {
    vi.clearAllMocks();
    authMocks.getSession.mockResolvedValue(null);
    serviceMocks.resolveApiToken.mockImplementation(async (token: string) => tokenFor(token));
    serviceMocks.getSkillBySlug.mockResolvedValue(row);
  });

  it("lets the official installer resolve metadata with a skills:read PAT", async () => {
    const res = await app.request("/v1/skills/workspace-skill", {
      headers: { Authorization: "Bearer read-a" },
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual(row);
    expect(serviceMocks.getSkillBySlug).toHaveBeenCalledWith(
      expect.objectContaining({ actor: actorA, orgId: "org-1", slug: "workspace-skill" }),
    );
  });

  it("rejects a PAT without skills:read before resolving the skill", async () => {
    const res = await app.request("/v1/skills/workspace-skill", {
      headers: { Authorization: "Bearer write-only" },
    });

    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toMatchObject({ ok: false, error: expect.stringContaining("skills:read") });
    expect(serviceMocks.getSkillBySlug).not.toHaveBeenCalled();
  });

  it("keeps signed-in session access unchanged", async () => {
    authMocks.getSession.mockResolvedValue({
      user: { id: "user-a", email: "a@example.test", name: "User A" },
      session: { id: "session-1" },
    });
    serviceMocks.listOrgs.mockResolvedValue([{ org_id: "org-1" }]);

    const res = await app.request("/v1/skills/workspace-skill", {
      headers: { cookie: "session=value" },
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual(row);
    expect(serviceMocks.getSkillBySlug).toHaveBeenCalledWith(
      expect.objectContaining({ actor: actorA, orgId: "org-1", slug: "workspace-skill" }),
    );
  });
});

describe("GET /v1/skills", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    serviceMocks.resolveApiToken.mockImplementation(async (token: string) => tokenFor(token));
    serviceMocks.listSkills.mockResolvedValue([{ slug: "workspace-skill", install_status: "none" }]);
  });

  it("allows a skills:read PAT to list org and My Skills libraries", async () => {
    const org = await app.request("/v1/skills", { headers: { Authorization: "Bearer read-a" } });
    const mine = await app.request("/v1/skills?lib=mine", { headers: { Authorization: "Bearer read-a" } });

    expect(org.status).toBe(200);
    expect(mine.status).toBe(200);
    expect(serviceMocks.listSkills).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ actor: actorA, orgId: "org-1", library: "org", installedOnly: false }),
    );
    expect(serviceMocks.listSkills).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ actor: actorA, orgId: "org-1", library: "mine", installedOnly: false }),
    );
  });

  it("passes lib=accessible through so personal skills reach the Companion skill picker", async () => {
    const res = await app.request("/v1/skills?lib=accessible", { headers: { Authorization: "Bearer read-a" } });

    expect(res.status).toBe(200);
    expect(serviceMocks.listSkills).toHaveBeenCalledWith(
      expect.objectContaining({ actor: actorA, orgId: "org-1", library: "accessible" }),
    );
  });

  it("rejects a PAT without skills:read", async () => {
    const res = await app.request("/v1/skills", { headers: { Authorization: "Bearer write-only" } });

    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toMatchObject({ ok: false, error: expect.stringContaining("skills:read") });
    expect(serviceMocks.listSkills).not.toHaveBeenCalled();
  });

  it("passes installed=true through with the current token actor", async () => {
    serviceMocks.listSkills.mockImplementation(async ({ actor, installedOnly }) => {
      if (!installedOnly) return [];
      return actor.id === "user-a" ? [{ slug: "a-installed" }] : [{ slug: "b-installed" }];
    });

    const a = await app.request("/v1/skills?installed=true", { headers: { Authorization: "Bearer read-a" } });
    const b = await app.request("/v1/skills?installed=true", { headers: { Authorization: "Bearer read-b" } });

    await expect(a.json()).resolves.toEqual([{ slug: "a-installed" }]);
    await expect(b.json()).resolves.toEqual([{ slug: "b-installed" }]);
    expect(serviceMocks.listSkills).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ actor: actorA, orgId: "org-1", library: "org", installedOnly: true }),
    );
    expect(serviceMocks.listSkills).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ actor: actorB, orgId: "org-1", library: "org", installedOnly: true }),
    );
  });
});
