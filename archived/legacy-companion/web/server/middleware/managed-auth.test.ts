import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { createToken, verifyToken, managedAuth } from "./managed-auth.js";

const TEST_SECRET = "test-secret-key-for-hmac-256-signing";

describe("managed-auth token utilities", () => {
  describe("createToken + verifyToken", () => {
    it("creates a valid token that can be verified", async () => {
      const token = await createToken(TEST_SECRET, 60);
      expect(typeof token).toBe("string");
      expect(token.split(".")).toHaveLength(2);

      const valid = await verifyToken(token, TEST_SECRET);
      expect(valid).toBe(true);
    });

    it("rejects tokens signed with a different secret", async () => {
      const token = await createToken(TEST_SECRET, 60);
      const valid = await verifyToken(token, "wrong-secret");
      expect(valid).toBe(false);
    });

    it("rejects expired tokens", async () => {
      // Create a token that expires in -1 seconds (already expired)
      const token = await createToken(TEST_SECRET, -1);
      const valid = await verifyToken(token, TEST_SECRET);
      expect(valid).toBe(false);
    });

    it("rejects malformed tokens", async () => {
      expect(await verifyToken("not-a-token", TEST_SECRET)).toBe(false);
      expect(await verifyToken("a.b.c", TEST_SECRET)).toBe(false);
      expect(await verifyToken("", TEST_SECRET)).toBe(false);
    });

    it("rejects tokens with tampered payload", async () => {
      const token = await createToken(TEST_SECRET, 60);
      const [, sig] = token.split(".");
      // Replace payload with different data — signature won't match
      const tamperedPayload = btoa(JSON.stringify({ exp: 9999999999 }))
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");
      const valid = await verifyToken(`${tamperedPayload}.${sig}`, TEST_SECRET);
      expect(valid).toBe(false);
    });

    it("uses custom TTL for token expiration", async () => {
      // Create a token with a very long TTL
      const token = await createToken(TEST_SECRET, 3600);
      const valid = await verifyToken(token, TEST_SECRET);
      expect(valid).toBe(true);
    });
  });
});

describe("managed-auth middleware", () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    savedEnv.COMPANION_AUTH_ENABLED = process.env.COMPANION_AUTH_ENABLED;
    savedEnv.COMPANION_AUTH_SECRET = process.env.COMPANION_AUTH_SECRET;
    savedEnv.COMPANION_LOGIN_URL = process.env.COMPANION_LOGIN_URL;
  });

  afterEach(() => {
    for (const [key, val] of Object.entries(savedEnv)) {
      if (val === undefined) delete process.env[key];
      else process.env[key] = val;
    }
  });

  /**
   * Helper: creates a test Hono app with managedAuth middleware
   * and a catch-all route that returns 200 if reached.
   */
  function createTestApp() {
    const app = new Hono();
    app.use("/*", managedAuth);
    app.all("/*", (c) => c.json({ ok: true }));
    return app;
  }

  it("enforces auth even without COMPANION_AUTH_ENABLED (enable decision is in index.ts)", async () => {
    // The middleware is always active when registered — the enable/disable
    // decision moved to index.ts which only registers it when appropriate.
    delete process.env.COMPANION_AUTH_ENABLED;
    process.env.COMPANION_AUTH_SECRET = TEST_SECRET;
    const app = createTestApp();

    const res = await app.request("/api/sessions");
    expect(res.status).toBe(401);
  });

  it("bypasses auth for /health endpoint", async () => {
    process.env.COMPANION_AUTH_ENABLED = "1";
    process.env.COMPANION_AUTH_SECRET = TEST_SECRET;
    const app = createTestApp();

    const res = await app.request("/health");
    expect(res.status).toBe(200);
  });

  it("bypasses auth for /ws/cli/ paths", async () => {
    process.env.COMPANION_AUTH_ENABLED = "1";
    process.env.COMPANION_AUTH_SECRET = TEST_SECRET;
    const app = createTestApp();

    const res = await app.request("/ws/cli/abc-123");
    expect(res.status).toBe(200);
  });

  it("returns 401 when no token is provided and no login URL is set", async () => {
    process.env.COMPANION_AUTH_ENABLED = "1";
    process.env.COMPANION_AUTH_SECRET = TEST_SECRET;
    delete process.env.COMPANION_LOGIN_URL;
    const app = createTestApp();

    const res = await app.request("/api/sessions");
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("Unauthorized");
  });

  it("redirects when no token is provided and login URL is set", async () => {
    process.env.COMPANION_AUTH_ENABLED = "1";
    process.env.COMPANION_AUTH_SECRET = TEST_SECRET;
    process.env.COMPANION_LOGIN_URL = "https://login.example.com";
    const app = createTestApp();

    const res = await app.request("/api/sessions", { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://login.example.com");
  });

  it("returns 500 when COMPANION_AUTH_SECRET is missing", async () => {
    process.env.COMPANION_AUTH_ENABLED = "1";
    delete process.env.COMPANION_AUTH_SECRET;
    const app = createTestApp();

    // Provide a token so it gets past the "no token" check
    const res = await app.request("/api/sessions?token=fake.token");
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("Server misconfigured");
  });

  it("allows access with a valid token in query param", async () => {
    process.env.COMPANION_AUTH_ENABLED = "1";
    process.env.COMPANION_AUTH_SECRET = TEST_SECRET;
    const app = createTestApp();

    const token = await createToken(TEST_SECRET, 60);
    const res = await app.request(`/api/sessions?token=${token}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(res.headers.get("set-cookie")).toContain("companion_token=");
  });

  it("sets a Secure auth cookie for HTTPS requests", async () => {
    process.env.COMPANION_AUTH_ENABLED = "1";
    process.env.COMPANION_AUTH_SECRET = TEST_SECRET;
    const app = createTestApp();

    const token = await createToken(TEST_SECRET, 60);
    const res = await app.request(`https://instance.example.com/api/sessions?token=${token}`);

    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toContain("Secure");
  });

  it("omits Secure on auth cookie for direct HTTP instance URLs", async () => {
    process.env.COMPANION_AUTH_ENABLED = "1";
    process.env.COMPANION_AUTH_SECRET = TEST_SECRET;
    const app = createTestApp();

    const token = await createToken(TEST_SECRET, 60);
    const res = await app.request(`http://5.161.114.105/?token=${token}`);

    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).not.toContain("Secure");
  });

  it("persists query-token auth as cookie for follow-up requests", async () => {
    process.env.COMPANION_AUTH_ENABLED = "1";
    process.env.COMPANION_AUTH_SECRET = TEST_SECRET;
    const app = createTestApp();

    const token = await createToken(TEST_SECRET, 60);
    const first = await app.request(`/api/sessions?token=${token}`);
    expect(first.status).toBe(200);

    const setCookie = first.headers.get("set-cookie");
    expect(setCookie).toBeTruthy();

    const cookiePair = setCookie!.split(";")[0];
    const second = await app.request("/api/sessions", {
      headers: { cookie: cookiePair },
    });
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ ok: true });
  });

  it("allows access with a valid token in cookie", async () => {
    process.env.COMPANION_AUTH_ENABLED = "1";
    process.env.COMPANION_AUTH_SECRET = TEST_SECRET;
    const app = createTestApp();

    const token = await createToken(TEST_SECRET, 60);
    const res = await app.request("/api/sessions", {
      headers: { cookie: `companion_token=${token}` },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("rejects an invalid token", async () => {
    process.env.COMPANION_AUTH_ENABLED = "1";
    process.env.COMPANION_AUTH_SECRET = TEST_SECRET;
    delete process.env.COMPANION_LOGIN_URL;
    const app = createTestApp();

    const res = await app.request("/api/sessions?token=bad.token");
    expect(res.status).toBe(401);
  });

  it("rejects an expired token", async () => {
    process.env.COMPANION_AUTH_ENABLED = "1";
    process.env.COMPANION_AUTH_SECRET = TEST_SECRET;
    delete process.env.COMPANION_LOGIN_URL;
    const app = createTestApp();

    const token = await createToken(TEST_SECRET, -1);
    const res = await app.request(`/api/sessions?token=${token}`);
    expect(res.status).toBe(401);
  });

  it("redirects with invalid token when login URL is set", async () => {
    process.env.COMPANION_AUTH_ENABLED = "1";
    process.env.COMPANION_AUTH_SECRET = TEST_SECRET;
    process.env.COMPANION_LOGIN_URL = "https://login.example.com";
    const app = createTestApp();

    const res = await app.request("/api/sessions?token=bad.token", {
      redirect: "manual",
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://login.example.com");
  });

  it("prefers query param over cookie when both are present", async () => {
    process.env.COMPANION_AUTH_ENABLED = "1";
    process.env.COMPANION_AUTH_SECRET = TEST_SECRET;
    const app = createTestApp();

    const validToken = await createToken(TEST_SECRET, 60);
    // Query has valid token, cookie has bad token — query wins.
    const res = await app.request(`/api/sessions?token=${validToken}`, {
      headers: { cookie: "companion_token=bad.token" },
    });
    expect(res.status).toBe(200);
  });
});
