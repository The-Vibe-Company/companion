import { vi, describe, it, expect, beforeEach } from "vitest";

vi.mock("../tailscale-manager.js", () => ({
  getTailscaleStatus: vi.fn(),
  startFunnel: vi.fn(),
  stopFunnel: vi.fn(),
}));

import { Hono } from "hono";
import { getTailscaleStatus, startFunnel, stopFunnel } from "../tailscale-manager.js";
import { registerTailscaleRoutes } from "./tailscale-routes.js";

const mockGetStatus = vi.mocked(getTailscaleStatus);
const mockStartFunnel = vi.mocked(startFunnel);
const mockStopFunnel = vi.mocked(stopFunnel);

const PORT = 3456;

function createApp() {
  const api = new Hono();
  registerTailscaleRoutes(api, PORT);
  return api;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /tailscale/status", () => {
  it("returns the Tailscale status", async () => {
    const status = {
      installed: true,
      binaryPath: "/usr/bin/tailscale",
      connected: true,
      dnsName: "my-machine.ts.net",
      funnelActive: false,
      funnelUrl: null,
      error: null,
    };
    mockGetStatus.mockResolvedValue(status);

    const app = createApp();
    const res = await app.request("/tailscale/status");

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.installed).toBe(true);
    expect(body.connected).toBe(true);
    expect(body.dnsName).toBe("my-machine.ts.net");
    expect(mockGetStatus).toHaveBeenCalledWith(PORT);
  });

  it("returns installed=false when Tailscale is not found", async () => {
    mockGetStatus.mockResolvedValue({
      installed: false,
      binaryPath: null,
      connected: false,
      dnsName: null,
      funnelActive: false,
      funnelUrl: null,
      error: null,
    });

    const app = createApp();
    const res = await app.request("/tailscale/status");

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.installed).toBe(false);
  });
});

describe("POST /tailscale/funnel/start", () => {
  it("returns 200 on success", async () => {
    mockStartFunnel.mockResolvedValue({
      installed: true,
      binaryPath: "/usr/bin/tailscale",
      connected: true,
      dnsName: "my-machine.ts.net",
      funnelActive: true,
      funnelUrl: "https://my-machine.ts.net",
      error: null,
    });

    const app = createApp();
    const res = await app.request("/tailscale/funnel/start", { method: "POST" });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.funnelActive).toBe(true);
    expect(body.funnelUrl).toBe("https://my-machine.ts.net");
    expect(mockStartFunnel).toHaveBeenCalledWith(PORT);
  });

  // Routes now always return 200 — error is in the body
  it("returns 200 with error in body when an error occurs", async () => {
    mockStartFunnel.mockResolvedValue({
      installed: true,
      binaryPath: "/usr/bin/tailscale",
      connected: false,
      dnsName: null,
      funnelActive: false,
      funnelUrl: null,
      error: "Tailscale is not connected",
    });

    const app = createApp();
    const res = await app.request("/tailscale/funnel/start", { method: "POST" });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.error).toBe("Tailscale is not connected");
  });

  it("returns 200 with needsOperatorMode on permission error", async () => {
    mockStartFunnel.mockResolvedValue({
      installed: true,
      binaryPath: "/usr/bin/tailscale",
      connected: true,
      dnsName: "my-machine.ts.net",
      funnelActive: false,
      funnelUrl: null,
      error: "Tailscale requires operator mode on Linux to manage Funnel.",
      needsOperatorMode: true,
    });

    const app = createApp();
    const res = await app.request("/tailscale/funnel/start", { method: "POST" });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.needsOperatorMode).toBe(true);
    expect(body.error).toContain("operator mode");
  });
});

describe("POST /tailscale/funnel/stop", () => {
  it("returns 200 on success", async () => {
    mockStopFunnel.mockResolvedValue({
      installed: true,
      binaryPath: "/usr/bin/tailscale",
      connected: true,
      dnsName: "my-machine.ts.net",
      funnelActive: false,
      funnelUrl: null,
      error: null,
    });

    const app = createApp();
    const res = await app.request("/tailscale/funnel/stop", { method: "POST" });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.funnelActive).toBe(false);
    expect(mockStopFunnel).toHaveBeenCalledWith(PORT);
  });

  it("returns 200 with error in body when stop fails", async () => {
    mockStopFunnel.mockResolvedValue({
      installed: true,
      binaryPath: "/usr/bin/tailscale",
      connected: true,
      dnsName: null,
      funnelActive: false,
      funnelUrl: null,
      error: "Failed to stop Funnel: command failed",
    });

    const app = createApp();
    const res = await app.request("/tailscale/funnel/stop", { method: "POST" });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.error).toContain("Failed to stop Funnel");
  });
});
