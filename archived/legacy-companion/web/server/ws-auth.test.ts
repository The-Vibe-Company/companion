import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createToken } from "./middleware/managed-auth.js";
import { authenticateManagedWebSocket } from "./ws-auth.js";

const TEST_SECRET = "test-secret-key-for-ws-auth";

describe("authenticateManagedWebSocket", () => {
  const savedSecret = process.env.COMPANION_AUTH_SECRET;

  beforeEach(() => {
    process.env.COMPANION_AUTH_SECRET = TEST_SECRET;
  });

  afterEach(() => {
    if (savedSecret === undefined) delete process.env.COMPANION_AUTH_SECRET;
    else process.env.COMPANION_AUTH_SECRET = savedSecret;
  });

  it("returns 401 when no token is provided", async () => {
    const req = new Request("https://example.com/ws/browser/abc");
    const result = await authenticateManagedWebSocket(req);
    expect(result.ok).toBe(false);
    expect(result.status).toBe(401);
  });

  it("accepts a valid query token", async () => {
    const token = await createToken(TEST_SECRET, 60);
    const req = new Request(`https://example.com/ws/browser/abc?token=${token}`);
    const result = await authenticateManagedWebSocket(req);
    expect(result.ok).toBe(true);
  });

  it("accepts a valid cookie token", async () => {
    const token = await createToken(TEST_SECRET, 60);
    const req = new Request("https://example.com/ws/browser/abc", {
      headers: { cookie: `companion_token=${token}` },
    });
    const result = await authenticateManagedWebSocket(req);
    expect(result.ok).toBe(true);
  });

  it("prefers query token over cookie", async () => {
    const token = await createToken(TEST_SECRET, 60);
    const req = new Request(`https://example.com/ws/browser/abc?token=${token}`, {
      headers: { cookie: "companion_token=bad.token" },
    });
    const result = await authenticateManagedWebSocket(req);
    expect(result.ok).toBe(true);
  });

  it("returns 500 when secret is missing", async () => {
    delete process.env.COMPANION_AUTH_SECRET;
    const req = new Request("https://example.com/ws/browser/abc");
    const result = await authenticateManagedWebSocket(req);
    expect(result.ok).toBe(false);
    expect(result.status).toBe(500);
  });
});

