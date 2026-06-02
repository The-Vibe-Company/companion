// Tests for the Linear Agent SDK webhook and OAuth routes.
// Covers webhook signature verification, event dispatch, OAuth callback,
// authorization URL generation, status endpoint, and disconnect flow.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";

// Mock linear-agent module
vi.mock("../linear-agent.js", () => ({
  verifyWebhookSignature: vi.fn(),
  isLinearOAuthConfigured: vi.fn(),
  getOAuthAuthorizeUrl: vi.fn(),
  exchangeCodeForTokens: vi.fn(),
  validateOAuthState: vi.fn(),
}));

// Mock agent-store
vi.mock("../agent-store.js", () => ({
  listAgents: vi.fn(),
}));

// Mock linear-staging module
vi.mock("../linear-staging.js", () => ({
  createSlot: vi.fn(),
  getSlot: vi.fn(),
  deleteSlot: vi.fn(),
  updateSlotTokens: vi.fn(),
}));

// Mock settings-manager
vi.mock("../settings-manager.js", () => ({
  getSettings: vi.fn().mockReturnValue({
    publicUrl: "https://companion.example.com",
    linearOAuthClientId: "client-id",
    linearOAuthClientSecret: "client-secret",
    linearOAuthWebhookSecret: "webhook-secret",
    linearOAuthAccessToken: "access-token",
  }),
  updateSettings: vi.fn(),
}));

import * as linearAgent from "../linear-agent.js";
import * as settingsManager from "../settings-manager.js";
import * as agentStore from "../agent-store.js";
import * as staging from "../linear-staging.js";
import {
  registerLinearAgentWebhookRoute,
  registerLinearAgentProtectedRoutes,
} from "./linear-agent-routes.js";

// ─── Test helpers ────────────────────────────────────────────────────────────

function createMockBridge() {
  return {
    handleEvent: vi.fn().mockResolvedValue(undefined),
  } as unknown as import("../linear-agent-bridge.js").LinearAgentBridge;
}

function createApp() {
  const app = new Hono();
  const bridge = createMockBridge();
  registerLinearAgentWebhookRoute(app, bridge);
  registerLinearAgentProtectedRoutes(app);
  return { app, bridge };
}

const testAgent = {
  id: "agent-1",
  name: "Linear Bot",
  enabled: true,
  triggers: {
    linear: {
      enabled: true,
      oauthClientId: "test-client-id",
      webhookSecret: "test-webhook-secret",
    },
  },
};

const validPayload = {
  type: "AgentSessionEvent",
  action: "created",
  oauthClientId: "test-client-id",
  agentSession: {
    id: "session-123",
    status: "pending",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  },
  promptContext: "Fix the bug",
};

// ─── Webhook endpoint tests ─────────────────────────────────────────────────

describe("POST /linear/agent-webhook", () => {
  let app: Hono;
  let bridge: ReturnType<typeof createMockBridge>;
  let consoleWarnSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    ({ app, bridge } = createApp());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns 401 when webhook signature is invalid", async () => {
    // Agent must be found first (per-agent lookup), then signature check fails
    vi.mocked(agentStore.listAgents).mockReturnValue([testAgent] as ReturnType<typeof agentStore.listAgents>);
    vi.mocked(linearAgent.verifyWebhookSignature).mockReturnValue(false);

    const res = await app.request("/linear/agent-webhook", {
      method: "POST",
      body: JSON.stringify(validPayload),
      headers: { "Content-Type": "application/json", "linear-signature": "bad-sig" },
    });

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("Invalid signature");
    expect(consoleWarnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Invalid webhook signature"),
    );
  });

  it("returns 400 for invalid JSON body", async () => {
    // JSON parsing now happens before signature verification
    const res = await app.request("/linear/agent-webhook", {
      method: "POST",
      body: "not-json{{",
      headers: { "Content-Type": "text/plain", "linear-signature": "valid-sig" },
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Invalid JSON");
  });

  it("dispatches AgentSessionEvent to bridge and returns 200", async () => {
    vi.mocked(agentStore.listAgents).mockReturnValue([testAgent] as ReturnType<typeof agentStore.listAgents>);
    vi.mocked(linearAgent.verifyWebhookSignature).mockReturnValue(true);

    const res = await app.request("/linear/agent-webhook", {
      method: "POST",
      body: JSON.stringify(validPayload),
      headers: { "Content-Type": "application/json", "linear-signature": "valid-sig" },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);

    // Wait a tick for the async dispatch
    await new Promise((r) => setTimeout(r, 10));
    expect(bridge.handleEvent).toHaveBeenCalledWith(validPayload);
    expect(consoleLogSpy).toHaveBeenCalledWith(
      expect.stringContaining("Accepted AgentSessionEvent"),
    );
  });

  it("ignores non-AgentSessionEvent types", async () => {
    // Type check happens before agent lookup, so no agent mock needed
    const res = await app.request("/linear/agent-webhook", {
      method: "POST",
      body: JSON.stringify({ type: "Issue", action: "created", data: {} }),
      headers: { "Content-Type": "application/json", "linear-signature": "valid-sig" },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ignored).toBe(true);
    expect(bridge.handleEvent).not.toHaveBeenCalled();
  });

  it("accepts x-linear-signature header as fallback", async () => {
    vi.mocked(agentStore.listAgents).mockReturnValue([testAgent] as ReturnType<typeof agentStore.listAgents>);
    vi.mocked(linearAgent.verifyWebhookSignature).mockReturnValue(true);

    const res = await app.request("/linear/agent-webhook", {
      method: "POST",
      body: JSON.stringify(validPayload),
      headers: { "Content-Type": "application/json", "x-linear-signature": "valid-sig" },
    });

    expect(res.status).toBe(200);
    // verifyWebhookSignature now takes (webhookSecret, rawBody, signature)
    expect(linearAgent.verifyWebhookSignature).toHaveBeenCalledWith(
      "test-webhook-secret",
      expect.any(String),
      "valid-sig",
    );
  });

  it("returns 404 when no agent matches the oauthClientId", async () => {
    // No agents configured — should return 404
    vi.mocked(agentStore.listAgents).mockReturnValue([]);

    const res = await app.request("/linear/agent-webhook", {
      method: "POST",
      body: JSON.stringify(validPayload),
      headers: { "Content-Type": "application/json", "linear-signature": "valid-sig" },
    });

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toContain("No agent configured");
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("No agent found for oauthClientId"),
    );
  });

  it("sanitizes user-controlled fields before logging webhook diagnostics", async () => {
    vi.mocked(agentStore.listAgents).mockReturnValue([]);

    const maliciousPayload = {
      ...validPayload,
      action: "created\nforged",
      oauthClientId: "evil\n[linear-agent-routes] Accepted AgentSessionEvent",
      agentSession: {
        ...validPayload.agentSession,
        id: "session-123\tforged",
      },
    };

    const res = await app.request("/linear/agent-webhook", {
      method: "POST",
      body: JSON.stringify(maliciousPayload),
      headers: { "Content-Type": "application/json", "linear-signature": "valid-sig" },
    });

    expect(res.status).toBe(404);
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      "[linear-agent-routes] No agent found for oauthClientId: evil_[linear-agent-routes] Accepted AgentSessionEvent action=created_forged sessionId=session-123_forged",
    );
  });
});

describe("console spy cleanup", () => {
  it("restores console spies before later describe blocks run", () => {
    // Regression test: webhook tests install console spies, but later describes
    // should still see the original console implementations.
    expect(vi.isMockFunction(console.log)).toBe(false);
    expect(vi.isMockFunction(console.warn)).toBe(false);
    expect(vi.isMockFunction(console.error)).toBe(false);
  });
});

// ─── OAuth callback tests ───────────────────────────────────────────────────

describe("GET /linear/oauth/callback", () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    ({ app } = createApp());
  });

  it("redirects with error when error parameter is present", async () => {
    const res = await app.request("/linear/oauth/callback?error=access_denied");

    expect(res.status).toBe(302);
    const location = res.headers.get("location");
    expect(location).toContain("oauth_error=access_denied");
  });

  it("redirects with error when no code parameter", async () => {
    const res = await app.request("/linear/oauth/callback");

    expect(res.status).toBe(302);
    const location = res.headers.get("location");
    expect(location).toContain("oauth_error=no_code");
  });

  it("redirects with error when state is missing (CSRF protection)", async () => {
    vi.mocked(linearAgent.validateOAuthState).mockReturnValue({ valid: false });
    const res = await app.request("/linear/oauth/callback?code=auth-code-123");

    expect(res.status).toBe(302);
    const location = res.headers.get("location");
    expect(location).toContain("oauth_error=invalid_state");
  });

  it("redirects with error when state is invalid (CSRF protection)", async () => {
    vi.mocked(linearAgent.validateOAuthState).mockReturnValue({ valid: false });

    const res = await app.request("/linear/oauth/callback?code=auth-code-123&state=bad-state");

    expect(res.status).toBe(302);
    const location = res.headers.get("location");
    expect(location).toContain("oauth_error=invalid_state");
  });

  it("exchanges code for tokens and redirects on success", async () => {
    vi.mocked(linearAgent.validateOAuthState).mockReturnValue({ valid: true });
    vi.mocked(linearAgent.exchangeCodeForTokens).mockResolvedValue({
      accessToken: "new-access",
      refreshToken: "new-refresh",
    });

    const res = await app.request("/linear/oauth/callback?code=auth-code-123&state=valid-state");

    expect(res.status).toBe(302);
    const location = res.headers.get("location");
    expect(location).toContain("oauth_success=true");

    // exchangeCodeForTokens now receives credentials object as first arg
    expect(linearAgent.exchangeCodeForTokens).toHaveBeenCalledWith(
      { clientId: "client-id", clientSecret: "client-secret" },
      "auth-code-123",
      expect.stringContaining("/api/linear/oauth/callback"),
    );

    // Should persist tokens to global staging
    expect(settingsManager.updateSettings).toHaveBeenCalledWith({
      linearOAuthAccessToken: "new-access",
      linearOAuthRefreshToken: "new-refresh",
    });
  });

  it("redirects with error when token exchange fails", async () => {
    vi.mocked(linearAgent.validateOAuthState).mockReturnValue({ valid: true });
    vi.mocked(linearAgent.exchangeCodeForTokens).mockResolvedValue(null);

    const res = await app.request("/linear/oauth/callback?code=bad-code&state=valid-state");

    expect(res.status).toBe(302);
    const location = res.headers.get("location");
    expect(location).toContain("oauth_error=token_exchange_failed");
  });
});

// ─── OAuth authorize URL endpoint ───────────────────────────────────────────

describe("GET /linear/oauth/authorize-url", () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    ({ app } = createApp());
  });

  it("returns authorization URL when configured", async () => {
    vi.mocked(linearAgent.getOAuthAuthorizeUrl).mockReturnValue({
      url: "https://linear.app/oauth/authorize?client_id=test&state=abc123",
      state: "abc123",
    });

    const res = await app.request("/linear/oauth/authorize-url");

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.url).toContain("linear.app/oauth/authorize");

    // getOAuthAuthorizeUrl receives clientId, redirectUri, and an options object
    expect(linearAgent.getOAuthAuthorizeUrl).toHaveBeenCalledWith(
      "client-id",
      expect.stringContaining("/api/linear/oauth/callback"),
      { returnTo: undefined, stagingId: undefined },
    );
  });

  it("returns 400 when OAuth client ID is not configured", async () => {
    vi.mocked(linearAgent.getOAuthAuthorizeUrl).mockReturnValue(null);

    const res = await app.request("/linear/oauth/authorize-url");

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("not configured");
  });
});

// ─── OAuth status endpoint ──────────────────────────────────────────────────

describe("GET /linear/oauth/status", () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    ({ app } = createApp());
  });

  it("returns OAuth configuration status", async () => {
    vi.mocked(linearAgent.isLinearOAuthConfigured).mockReturnValue(true);

    const res = await app.request("/linear/oauth/status");

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.configured).toBe(true);
    expect(body.hasClientId).toBe(true);
    expect(body.hasClientSecret).toBe(true);
    expect(body.hasWebhookSecret).toBe(true);
    expect(body.hasAccessToken).toBe(true);

    // isLinearOAuthConfigured now receives credentials object
    expect(linearAgent.isLinearOAuthConfigured).toHaveBeenCalledWith({
      clientId: "client-id",
      clientSecret: "client-secret",
      accessToken: "access-token",
    });
  });
});

// ─── OAuth disconnect endpoint ──────────────────────────────────────────────

describe("POST /linear/oauth/disconnect", () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    ({ app } = createApp());
  });

  it("clears OAuth tokens and returns success", async () => {
    const res = await app.request("/linear/oauth/disconnect", { method: "POST" });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);

    expect(settingsManager.updateSettings).toHaveBeenCalledWith({
      linearOAuthAccessToken: "",
      linearOAuthRefreshToken: "",
    });
  });
});

// ─── Staging slot CRUD tests ────────────────────────────────────────────────

describe("POST /linear/oauth/staging", () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    ({ app } = createApp());
  });

  it("creates a staging slot and returns the stagingId", async () => {
    // createSlot should return a hex ID when given valid credentials
    vi.mocked(staging.createSlot).mockReturnValue("abcd1234abcd1234abcd1234abcd1234");

    const res = await app.request("/linear/oauth/staging", {
      method: "POST",
      body: JSON.stringify({
        clientId: "my-client-id",
        clientSecret: "my-client-secret",
        webhookSecret: "my-webhook-secret",
      }),
      headers: { "Content-Type": "application/json" },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.stagingId).toBe("abcd1234abcd1234abcd1234abcd1234");

    // Verify createSlot was called with the provided credentials
    expect(staging.createSlot).toHaveBeenCalledWith({
      clientId: "my-client-id",
      clientSecret: "my-client-secret",
      webhookSecret: "my-webhook-secret",
    });
  });

  it("returns 400 when required fields are missing", async () => {
    // Missing webhookSecret — should be rejected before createSlot is called
    const res = await app.request("/linear/oauth/staging", {
      method: "POST",
      body: JSON.stringify({
        clientId: "my-client-id",
        clientSecret: "my-client-secret",
        // webhookSecret intentionally omitted
      }),
      headers: { "Content-Type": "application/json" },
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("required");
    expect(staging.createSlot).not.toHaveBeenCalled();
  });

  it("returns 400 when all fields are empty strings", async () => {
    // All fields present but empty — should be rejected after trimming
    const res = await app.request("/linear/oauth/staging", {
      method: "POST",
      body: JSON.stringify({
        clientId: "  ",
        clientSecret: "",
        webhookSecret: "",
      }),
      headers: { "Content-Type": "application/json" },
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("required");
    expect(staging.createSlot).not.toHaveBeenCalled();
  });
});

describe("GET /linear/oauth/staging/:id/status", () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    ({ app } = createApp());
  });

  it("returns full status for an existing staging slot", async () => {
    // Simulate a slot that has completed OAuth (has accessToken)
    vi.mocked(staging.getSlot).mockReturnValue({
      id: "abcd1234abcd1234abcd1234abcd1234",
      clientId: "my-client-id",
      clientSecret: "my-client-secret",
      webhookSecret: "my-webhook-secret",
      accessToken: "token-abc",
      refreshToken: "refresh-abc",
      createdAt: Date.now(),
    });

    const res = await app.request("/linear/oauth/staging/abcd1234abcd1234abcd1234abcd1234/status");

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.exists).toBe(true);
    expect(body.hasAccessToken).toBe(true);
    expect(body.hasClientId).toBe(true);
    expect(body.hasClientSecret).toBe(true);
  });

  it("returns exists:false for a non-existent or expired slot", async () => {
    // getSlot returns null when the slot doesn't exist or has expired
    vi.mocked(staging.getSlot).mockReturnValue(null);

    const res = await app.request("/linear/oauth/staging/deadbeefdeadbeefdeadbeefdeadbeef/status");

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.exists).toBe(false);
    expect(body.hasAccessToken).toBe(false);
    expect(body.hasClientId).toBe(false);
    expect(body.hasClientSecret).toBe(false);
  });
});

describe("DELETE /linear/oauth/staging/:id", () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    ({ app } = createApp());
  });

  it("deletes a staging slot and returns ok", async () => {
    vi.mocked(staging.deleteSlot).mockReturnValue(true);

    const res = await app.request("/linear/oauth/staging/abcd1234abcd1234abcd1234abcd1234", {
      method: "DELETE",
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);

    expect(staging.deleteSlot).toHaveBeenCalledWith("abcd1234abcd1234abcd1234abcd1234");
  });
});

// ─── OAuth callback with expired staging slot ───────────────────────────────

describe("GET /linear/oauth/callback — expired staging slot", () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    ({ app } = createApp());
  });

  it("redirects with staging_slot_expired error when staging slot has expired", async () => {
    // The state nonce is valid and contains a stagingId, but the slot has been
    // deleted or expired (getSlot returns null). The callback should NOT fall
    // back to global credentials — it should return an explicit error.
    vi.mocked(linearAgent.validateOAuthState).mockReturnValue({
      valid: true,
      stagingId: "abcd1234abcd1234abcd1234abcd1234",
      returnTo: "/#/agents",
    });
    vi.mocked(staging.getSlot).mockReturnValue(null);

    const res = await app.request(
      "/linear/oauth/callback?code=auth-code-123&state=valid-state-with-staging",
    );

    expect(res.status).toBe(302);
    const location = res.headers.get("location");
    // Should redirect to the returnTo path with the staging_slot_expired error
    expect(location).toContain("/#/agents");
    expect(location).toContain("oauth_error=staging_slot_expired");

    // Token exchange should never be attempted when the staging slot is expired
    expect(linearAgent.exchangeCodeForTokens).not.toHaveBeenCalled();
  });

  it("uses staging slot credentials when slot exists", async () => {
    // When a stagingId is in the state and the slot is still alive, the callback
    // should use the staging slot's credentials for token exchange and persist
    // the tokens back to the slot via updateSlotTokens.
    vi.mocked(linearAgent.validateOAuthState).mockReturnValue({
      valid: true,
      stagingId: "abcd1234abcd1234abcd1234abcd1234",
      returnTo: "/#/agents",
    });
    vi.mocked(staging.getSlot).mockReturnValue({
      id: "abcd1234abcd1234abcd1234abcd1234",
      clientId: "staging-client-id",
      clientSecret: "staging-client-secret",
      webhookSecret: "staging-webhook-secret",
      accessToken: "",
      refreshToken: "",
      createdAt: Date.now(),
    });
    vi.mocked(linearAgent.exchangeCodeForTokens).mockResolvedValue({
      accessToken: "new-staging-access",
      refreshToken: "new-staging-refresh",
    });

    const res = await app.request(
      "/linear/oauth/callback?code=auth-code-456&state=valid-state-with-staging",
    );

    expect(res.status).toBe(302);
    const location = res.headers.get("location");
    expect(location).toContain("/#/agents");
    expect(location).toContain("oauth_success=true");

    // Should use the staging slot's credentials, not global settings
    expect(linearAgent.exchangeCodeForTokens).toHaveBeenCalledWith(
      { clientId: "staging-client-id", clientSecret: "staging-client-secret" },
      "auth-code-456",
      expect.stringContaining("/api/linear/oauth/callback"),
    );

    // Tokens should be persisted to the staging slot, not global settings
    expect(staging.updateSlotTokens).toHaveBeenCalledWith(
      "abcd1234abcd1234abcd1234abcd1234",
      { accessToken: "new-staging-access", refreshToken: "new-staging-refresh" },
    );
    // Global settings should NOT be updated
    expect(settingsManager.updateSettings).not.toHaveBeenCalled();
  });
});

// ─── OAuth authorize URL with staging slot ──────────────────────────────────

describe("GET /linear/oauth/authorize-url — with stagingId", () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    ({ app } = createApp());
  });

  it("uses the staging slot's clientId when stagingId is provided", async () => {
    // When the authorize-url request includes a stagingId, the route should look
    // up the staging slot and use its clientId instead of the global setting.
    vi.mocked(staging.getSlot).mockReturnValue({
      id: "abcd1234abcd1234abcd1234abcd1234",
      clientId: "staging-oauth-client-id",
      clientSecret: "staging-oauth-client-secret",
      webhookSecret: "staging-webhook-secret",
      accessToken: "",
      refreshToken: "",
      createdAt: Date.now(),
    });
    vi.mocked(linearAgent.getOAuthAuthorizeUrl).mockReturnValue({
      url: "https://linear.app/oauth/authorize?client_id=staging-oauth-client-id&state=xyz",
      state: "xyz",
    });

    const res = await app.request(
      "/linear/oauth/authorize-url?stagingId=abcd1234abcd1234abcd1234abcd1234",
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.url).toContain("linear.app/oauth/authorize");

    // getOAuthAuthorizeUrl should receive the staging slot's clientId
    expect(linearAgent.getOAuthAuthorizeUrl).toHaveBeenCalledWith(
      "staging-oauth-client-id",
      expect.stringContaining("/api/linear/oauth/callback"),
      { returnTo: undefined, stagingId: "abcd1234abcd1234abcd1234abcd1234" },
    );
  });

  it("returns 404 when staging slot doesn't exist (expired or deleted)", async () => {
    // If stagingId is provided but the slot is expired/missing, the endpoint
    // should return 404 immediately rather than generating a URL that will
    // fail at callback time with staging_slot_expired.
    vi.mocked(staging.getSlot).mockReturnValue(null);

    const res = await app.request(
      "/linear/oauth/authorize-url?stagingId=deadbeefdeadbeefdeadbeefdeadbeef",
    );

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toContain("Staging slot expired");

    // Should not have attempted to generate an authorize URL
    expect(linearAgent.getOAuthAuthorizeUrl).not.toHaveBeenCalled();
  });
});
