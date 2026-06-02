// Tests for the Linear Agent Interaction SDK client module.
// Covers webhook verification, OAuth token management, GraphQL calls,
// activity posting, and configuration checks.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHmac } from "node:crypto";

import type { LinearOAuthCredentials } from "./linear-agent.js";
import {
  verifyWebhookSignature,
  isLinearOAuthConfigured,
  getOAuthAuthorizeUrl,
  exchangeCodeForTokens,
  refreshAccessToken,
  linearGraphQL,
  postActivity,
  updateSessionUrls,
  updateSessionPlan,
  generateOAuthState,
  validateOAuthState,
} from "./linear-agent.js";

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// Default test credentials matching the LinearOAuthCredentials interface
const testCreds: LinearOAuthCredentials = {
  clientId: "client-id",
  clientSecret: "client-secret",
  webhookSecret: "webhook-secret",
  accessToken: "access-token",
  refreshToken: "refresh-token",
};

beforeEach(() => {
  vi.clearAllMocks();
});

// ─── Webhook signature verification ──────────────────────────────────────────

describe("verifyWebhookSignature", () => {
  it("returns true for valid HMAC-SHA256 signature", () => {
    const body = '{"type":"AgentSessionEvent"}';
    const signature = createHmac("sha256", "test-secret").update(body).digest("hex");

    expect(verifyWebhookSignature("test-secret", body, signature)).toBe(true);
  });

  it("returns false for invalid signature", () => {
    expect(verifyWebhookSignature("test-secret", "body", "bad-signature")).toBe(false);
  });

  it("returns false when webhook secret is not configured", () => {
    expect(verifyWebhookSignature("", "body", "some-sig")).toBe(false);
  });

  it("returns false when signature is null", () => {
    expect(verifyWebhookSignature("webhook-secret", "body", null)).toBe(false);
  });

  it("returns false for malformed hex signature (timing-safe compare failure)", () => {
    // Non-hex string will cause Buffer.from to produce different length
    expect(verifyWebhookSignature("test-secret", "body", "not-valid-hex!!")).toBe(false);
  });
});

// ─── OAuth configuration checks ─────────────────────────────────────────────

describe("isLinearOAuthConfigured", () => {
  it("returns true when all required fields are present", () => {
    expect(isLinearOAuthConfigured(testCreds)).toBe(true);
  });

  it("returns false when client ID is missing", () => {
    expect(isLinearOAuthConfigured({ ...testCreds, clientId: "" })).toBe(false);
  });

  it("returns false when access token is missing", () => {
    expect(isLinearOAuthConfigured({ ...testCreds, accessToken: "" })).toBe(false);
  });
});

describe("getOAuthAuthorizeUrl", () => {
  it("returns authorization URL and state nonce with correct parameters", () => {
    const result = getOAuthAuthorizeUrl("my-client-id", "http://localhost:3456/api/linear/oauth/callback");
    expect(result).not.toBeNull();
    expect(result!.url).toContain("linear.app/oauth/authorize");
    expect(result!.url).toContain("client_id=my-client-id");
    expect(result!.url).toContain("response_type=code");
    expect(result!.url).toContain("actor=app");
    expect(result!.url).toContain("app%3Amentionable");
    expect(result!.url).toContain("state=");
    expect(result!.state).toBeTruthy();
  });

  it("returns null when client ID is not configured", () => {
    expect(getOAuthAuthorizeUrl("", "http://localhost/callback")).toBeNull();
  });
});

// ─── OAuth state CSRF protection ─────────────────────────────────────────────

describe("OAuth state nonce (CSRF protection)", () => {
  it("generates unique state nonces", () => {
    const state1 = generateOAuthState();
    const state2 = generateOAuthState();
    expect(state1).not.toBe(state2);
    expect(state1.length).toBe(48); // 24 bytes → 48 hex chars
  });

  it("validates a generated state nonce (single use)", () => {
    const state = generateOAuthState();
    expect(validateOAuthState(state)).toEqual({ valid: true });
    // Second use should fail — consumed
    expect(validateOAuthState(state)).toEqual({ valid: false });
  });

  it("rejects unknown state nonces", () => {
    expect(validateOAuthState("unknown-nonce")).toEqual({ valid: false });
  });

  it("rejects null/undefined state", () => {
    expect(validateOAuthState(null)).toEqual({ valid: false });
    expect(validateOAuthState(undefined)).toEqual({ valid: false });
  });

  it("preserves returnTo path in state", () => {
    const state = generateOAuthState({ returnTo: "/#/setup/linear-agent" });
    const result = validateOAuthState(state);
    expect(result).toEqual({ valid: true, returnTo: "/#/setup/linear-agent" });
  });

  it("works without returnTo", () => {
    const state = generateOAuthState();
    const result = validateOAuthState(state);
    expect(result).toEqual({ valid: true });
  });

  it("preserves stagingId in state round-trip", () => {
    const state = generateOAuthState({ stagingId: "abc123def456" });
    const result = validateOAuthState(state);
    expect(result).toEqual({ valid: true, stagingId: "abc123def456" });
  });

  it("preserves both stagingId and returnTo in state round-trip", () => {
    const state = generateOAuthState({ stagingId: "slot-42", returnTo: "/#/agents" });
    const result = validateOAuthState(state);
    expect(result).toEqual({ valid: true, stagingId: "slot-42", returnTo: "/#/agents" });
  });

  it("returns stagingId as undefined when not provided", () => {
    const state = generateOAuthState({ returnTo: "/#/settings" });
    const result = validateOAuthState(state);
    expect(result.valid).toBe(true);
    expect(result.stagingId).toBeUndefined();
    expect(result.returnTo).toBe("/#/settings");
  });
});

// ─── Token exchange ─────────────────────────────────────────────────────────

describe("exchangeCodeForTokens", () => {
  it("exchanges authorization code for tokens", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        access_token: "new-access",
        refresh_token: "new-refresh",
        expires_in: 86400,
        scope: "read,write",
      }),
    });

    const result = await exchangeCodeForTokens(
      { clientId: testCreds.clientId, clientSecret: testCreds.clientSecret },
      "auth-code",
      "http://localhost/callback",
    );

    expect(result).toEqual({ accessToken: "new-access", refreshToken: "new-refresh" });
    expect(mockFetch).toHaveBeenCalledWith("https://api.linear.app/oauth/token", expect.objectContaining({
      method: "POST",
    }));
  });

  it("returns null when client credentials are missing", async () => {
    const result = await exchangeCodeForTokens(
      { clientId: "", clientSecret: testCreds.clientSecret },
      "code",
      "http://localhost/callback",
    );
    expect(result).toBeNull();
  });

  it("returns null when token exchange fails", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 400,
      text: () => Promise.resolve("Bad Request"),
    });

    const result = await exchangeCodeForTokens(
      { clientId: testCreds.clientId, clientSecret: testCreds.clientSecret },
      "bad-code",
      "http://localhost/callback",
    );
    expect(result).toBeNull();
  });

  it("returns null when fetch throws a network error", async () => {
    mockFetch.mockRejectedValueOnce(new Error("Network error"));

    const result = await exchangeCodeForTokens(
      { clientId: testCreds.clientId, clientSecret: testCreds.clientSecret },
      "code",
      "http://localhost/callback",
    );
    expect(result).toBeNull();
  });
});

// ─── Token refresh ──────────────────────────────────────────────────────────

describe("refreshAccessToken", () => {
  it("refreshes token and invokes onTokensRefreshed callback", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        access_token: "refreshed-access",
        refresh_token: "refreshed-refresh",
        expires_in: 86400,
      }),
    });

    const onTokensRefreshed = vi.fn();
    const result = await refreshAccessToken(testCreds, onTokensRefreshed);

    expect(result).toBe("refreshed-access");
    expect(onTokensRefreshed).toHaveBeenCalledWith({
      accessToken: "refreshed-access",
      refreshToken: "refreshed-refresh",
    });
  });

  it("returns null when refresh credentials are missing", async () => {
    const result = await refreshAccessToken({ ...testCreds, refreshToken: "" });
    expect(result).toBeNull();
  });

  it("returns null when refresh request fails", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 401 });

    const result = await refreshAccessToken(testCreds);
    expect(result).toBeNull();
  });

  it("keeps old refresh token if new one is not provided", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        access_token: "new-access",
        // No refresh_token in response
        expires_in: 86400,
      }),
    });

    const onTokensRefreshed = vi.fn();
    await refreshAccessToken(
      { ...testCreds, refreshToken: "old-refresh" },
      onTokensRefreshed,
    );

    expect(onTokensRefreshed).toHaveBeenCalledWith({
      accessToken: "new-access",
      refreshToken: "old-refresh",
    });
  });
});

// ─── GraphQL helper ─────────────────────────────────────────────────────────

describe("linearGraphQL", () => {
  it("sends authenticated GraphQL request and returns data", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ data: { viewer: { id: "user-1" } } }),
    });

    const result = await linearGraphQL(testCreds, "{ viewer { id } }");

    expect(result).toEqual({ data: { viewer: { id: "user-1" } } });
    expect(mockFetch).toHaveBeenCalledWith("https://api.linear.app/graphql", expect.objectContaining({
      method: "POST",
      headers: expect.objectContaining({
        Authorization: "Bearer access-token",
      }),
    }));
  });

  it("throws when no access token is configured", async () => {
    await expect(
      linearGraphQL({ ...testCreds, accessToken: "" }, "{ viewer { id } }")
    ).rejects.toThrow("Linear OAuth not configured");
  });

  it("throws on non-OK response without 401", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: () => Promise.resolve("Internal Server Error"),
    });

    await expect(linearGraphQL(testCreds, "{ viewer { id } }")).rejects.toThrow(
      "Linear API error 500"
    );
  });

  it("auto-refreshes token on 401 and retries", async () => {
    // First call: 401
    mockFetch.mockResolvedValueOnce({ ok: false, status: 401 });
    // Token refresh call
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        access_token: "new-token",
        refresh_token: "new-refresh",
        expires_in: 86400,
      }),
    });
    // Retry with new token: success
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ data: { viewer: { id: "user-1" } } }),
    });

    const result = await linearGraphQL(testCreds, "{ viewer { id } }");

    expect(result).toEqual({ data: { viewer: { id: "user-1" } } });
    // Should have made 3 fetch calls: initial GraphQL, token refresh, retry GraphQL
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it("persists refreshed tokens via callback when a 401 is recovered", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 401 });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        access_token: "new-token",
        refresh_token: "new-refresh",
        expires_in: 86400,
      }),
    });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ data: { viewer: { id: "user-1" } } }),
    });

    const onTokensRefreshed = vi.fn();
    await linearGraphQL(testCreds, "{ viewer { id } }", undefined, onTokensRefreshed);

    expect(onTokensRefreshed).toHaveBeenCalledWith({
      accessToken: "new-token",
      refreshToken: "new-refresh",
    });
  });
});

// ─── Activity posting ───────────────────────────────────────────────────────

describe("postActivity", () => {
  it("sends agentActivityCreate mutation with correct input", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ data: { agentActivityCreate: { success: true } } }),
    });

    await postActivity(testCreds, "session-123", { type: "thought", body: "Thinking...", ephemeral: true });

    const fetchBody = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(fetchBody.variables.input).toEqual({
      agentSessionId: "session-123",
      content: { type: "thought", body: "Thinking...", ephemeral: true },
    });
  });

  it("logs error when activity creation returns errors", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ errors: [{ message: "Session not found" }] }),
    });

    await postActivity(testCreds, "bad-session", { type: "response", body: "Done" });

    expect(consoleSpy).toHaveBeenCalledWith(
      "[linear-agent] Activity creation failed:",
      "Session not found"
    );
    consoleSpy.mockRestore();
  });

  it("passes token refresh callback through to linearGraphQL", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 401 });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        access_token: "new-access",
        refresh_token: "new-refresh",
        expires_in: 86400,
      }),
    });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ data: { agentActivityCreate: { success: true } } }),
    });

    const onTokensRefreshed = vi.fn();
    await postActivity(testCreds, "session-123", { type: "response", body: "Done" }, onTokensRefreshed);

    expect(onTokensRefreshed).toHaveBeenCalledWith({
      accessToken: "new-access",
      refreshToken: "new-refresh",
    });
  });
});

// ─── Session updates ────────────────────────────────────────────────────────

describe("updateSessionUrls", () => {
  it("sends agentSessionUpdate mutation with external URLs", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ data: { agentSessionUpdate: { success: true } } }),
    });

    await updateSessionUrls(testCreds, "session-123", [
      { label: "Companion", url: "http://localhost:3456/#/session/abc" },
    ]);

    const fetchBody = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(fetchBody.variables.input.externalUrls).toEqual([
      { label: "Companion", url: "http://localhost:3456/#/session/abc" },
    ]);
  });
});

describe("updateSessionPlan", () => {
  it("sends agentSessionUpdate mutation with plan items", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ data: { agentSessionUpdate: { success: true } } }),
    });

    const plan = [
      { content: "Analyze issue", status: "completed" as const },
      { content: "Fix bug", status: "inProgress" as const },
    ];
    await updateSessionPlan(testCreds, "session-123", plan);

    const fetchBody = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(fetchBody.variables.input.plan).toEqual(plan);
  });
});
