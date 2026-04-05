/**
 * Tests for WeChat Bot REST routes.
 *
 * Validates:
 * - GET /wechat/status returns bot running state and QR code
 * - POST /wechat/start starts the bot and handles "already running"
 * - POST /wechat/stop stops the bot
 * - GET /wechat/sessions lists user sessions
 * - DELETE /wechat/sessions/:userId cleans up a user's sessions
 */
import { vi, describe, it, expect, beforeEach } from "vitest";

// Create a mock WeChatBridge instance that we control in each test
const mockWechatBridge = {
  getStatus: vi.fn(),
  start: vi.fn(),
  stop: vi.fn(),
  getSessions: vi.fn(),
  deleteSessionsForUser: vi.fn(),
  isRunning: false,
};

vi.mock("../wechat-bridge.js", () => ({
  WeChatBridge: vi.fn(() => mockWechatBridge),
}));

import { Hono } from "hono";
import { registerWeChatRoutes } from "./wechat-routes.js";

function createApp() {
  const api = new Hono();
  // registerWeChatRoutes expects a WeChatBridge instance — use our mock
  registerWeChatRoutes(api, mockWechatBridge as unknown as import("../wechat-bridge.js").WeChatBridge);
  return api;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockWechatBridge.isRunning = false;
});

// ── GET /wechat/status ──────────────────────────────────────────────────

describe("GET /wechat/status", () => {
  it("returns bot status when stopped", async () => {
    mockWechatBridge.getStatus.mockReturnValue({
      running: false,
      starting: false,
      error: null,
      connectedUsers: 0,
      qrCode: null,
    });

    const app = createApp();
    const res = await app.request("/wechat/status");

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.running).toBe(false);
    expect(body.connectedUsers).toBe(0);
    expect(body.qrCode).toBeNull();
  });

  it("returns bot status when running with QR code", async () => {
    mockWechatBridge.getStatus.mockReturnValue({
      running: true,
      starting: false,
      error: null,
      connectedUsers: 3,
      qrCode: "data:image/png;base64,abc",
    });

    const app = createApp();
    const res = await app.request("/wechat/status");

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.running).toBe(true);
    expect(body.connectedUsers).toBe(3);
    expect(body.qrCode).toBe("data:image/png;base64,abc");
  });
});

// ── POST /wechat/start ──────────────────────────────────────────────────

describe("POST /wechat/start", () => {
  it("starts the bot successfully", async () => {
    mockWechatBridge.isRunning = false;
    mockWechatBridge.start.mockResolvedValue(undefined);

    const app = createApp();
    const res = await app.request("/wechat/start", { method: "POST" });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(mockWechatBridge.start).toHaveBeenCalledTimes(1);
  });

  it("returns already running when bot is active", async () => {
    mockWechatBridge.isRunning = true;

    const app = createApp();
    const res = await app.request("/wechat/start", { method: "POST" });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.message).toBe("Already running");
    // start() should NOT be called when already running
    expect(mockWechatBridge.start).not.toHaveBeenCalled();
  });

  it("returns 500 when start throws", async () => {
    mockWechatBridge.isRunning = false;
    mockWechatBridge.start.mockRejectedValue(new Error("QR login failed"));

    const app = createApp();
    const res = await app.request("/wechat/start", { method: "POST" });

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toBe("QR login failed");
  });
});

// ── POST /wechat/stop ───────────────────────────────────────────────────

describe("POST /wechat/stop", () => {
  it("stops the bot", async () => {
    const app = createApp();
    const res = await app.request("/wechat/stop", { method: "POST" });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(mockWechatBridge.stop).toHaveBeenCalledTimes(1);
  });
});

// ── GET /wechat/sessions ────────────────────────────────────────────────

describe("GET /wechat/sessions", () => {
  it("returns empty sessions list", async () => {
    mockWechatBridge.getSessions.mockReturnValue([]);

    const app = createApp();
    const res = await app.request("/wechat/sessions");

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.sessions).toEqual([]);
  });

  it("returns active WeChat sessions", async () => {
    const sessions = [
      { userId: "wxid_abc123", activeSession: "sess-001", sessionCount: 2 },
      { userId: "wxid_def456", activeSession: null, sessionCount: 0 },
    ];
    mockWechatBridge.getSessions.mockReturnValue(sessions);

    const app = createApp();
    const res = await app.request("/wechat/sessions");

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.sessions).toHaveLength(2);
    expect(body.sessions[0].userId).toBe("wxid_abc123");
    expect(body.sessions[1].activeSession).toBeNull();
  });
});

// ── DELETE /wechat/sessions/:userId ─────────────────────────────────────

describe("DELETE /wechat/sessions/:userId", () => {
  it("deletes sessions for a user", async () => {
    mockWechatBridge.deleteSessionsForUser.mockResolvedValue(undefined);

    const app = createApp();
    const res = await app.request("/wechat/sessions/wxid_abc123", { method: "DELETE" });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(mockWechatBridge.deleteSessionsForUser).toHaveBeenCalledWith("wxid_abc123");
  });

  it("handles URL-encoded user IDs", async () => {
    mockWechatBridge.deleteSessionsForUser.mockResolvedValue(undefined);

    const app = createApp();
    const res = await app.request("/wechat/sessions/wxid_%40special", { method: "DELETE" });

    expect(res.status).toBe(200);
    // Hono decodes the param automatically
    expect(mockWechatBridge.deleteSessionsForUser).toHaveBeenCalledWith("wxid_@special");
  });
});
