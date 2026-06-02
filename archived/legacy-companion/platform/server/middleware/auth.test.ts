import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import { requireAuth, requireOrganization } from "./auth";

/**
 * Tests for the auth middleware (requireAuth and requireOrganization).
 *
 * Strategy: mock getAuth() to return a fake auth object whose
 * api.getSession() we control. Then mount the middleware on a test Hono
 * app and hit it with fetch to verify 401/403/pass-through behaviour.
 */

// Mock getAuth to return a controllable auth stub.
const mockGetSession = vi.fn();

vi.mock("../auth.js", () => ({
  getAuth: vi.fn(() => ({
    api: {
      getSession: mockGetSession,
    },
  })),
}));

function createTestApp() {
  const app = new Hono();

  // Route that only requires auth
  app.get("/auth-only", requireAuth, (c) => {
    const auth = c.get("auth");
    return c.json({ userId: auth.userId });
  });

  // Route that requires auth + active organization
  app.get("/org-required", requireAuth, requireOrganization, (c) => {
    const orgId = c.get("organizationId");
    return c.json({ organizationId: orgId });
  });

  return app;
}

describe("requireAuth", () => {
  beforeEach(() => {
    mockGetSession.mockReset();
  });

  it("returns 401 when no session exists", async () => {
    mockGetSession.mockResolvedValue(null);
    const app = createTestApp();
    const res = await app.request("/auth-only");
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("Unauthorized");
  });

  it("passes through and sets auth context when session is valid", async () => {
    mockGetSession.mockResolvedValue({
      user: { id: "user-1", email: "test@example.com", name: "Test User" },
      session: { id: "session-1", activeOrganizationId: "org-1" },
    });
    const app = createTestApp();
    const res = await app.request("/auth-only");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.userId).toBe("user-1");
  });

  it("passes the request headers to getSession", async () => {
    mockGetSession.mockResolvedValue(null);
    const app = createTestApp();
    await app.request("/auth-only", {
      headers: { Cookie: "better-auth.session=abc123" },
    });
    // Verify getSession was called with headers from the request.
    expect(mockGetSession).toHaveBeenCalledOnce();
    const callArg = mockGetSession.mock.calls[0][0];
    expect(callArg.headers).toBeDefined();
  });
});

describe("requireOrganization", () => {
  beforeEach(() => {
    mockGetSession.mockReset();
  });

  it("returns 403 when session has no activeOrganizationId", async () => {
    mockGetSession.mockResolvedValue({
      user: { id: "user-1", email: "test@example.com", name: "Test" },
      session: { id: "session-1" },
      // No activeOrganizationId
    });
    const app = createTestApp();
    const res = await app.request("/org-required");
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toContain("No active organization");
  });

  it("passes through and sets organizationId when session has an active org", async () => {
    mockGetSession.mockResolvedValue({
      user: { id: "user-1", email: "test@example.com", name: "Test" },
      session: { id: "session-1", activeOrganizationId: "org-42" },
    });
    const app = createTestApp();
    const res = await app.request("/org-required");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.organizationId).toBe("org-42");
  });

  it("returns 401 before reaching org check when not authenticated", async () => {
    // requireAuth should fire first and return 401 before requireOrganization runs.
    mockGetSession.mockResolvedValue(null);
    const app = createTestApp();
    const res = await app.request("/org-required");
    expect(res.status).toBe(401);
  });
});
