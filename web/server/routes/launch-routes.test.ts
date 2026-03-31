// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { registerLaunchRoutes } from "./launch-routes.js";

vi.mock("../launch-config.js", () => ({
  loadLaunchConfig: vi.fn(),
  resolveForContext: vi.fn(),
  resolveEnvVars: vi.fn().mockReturnValue({ topLevelEnv: {}, serviceEnvs: {}, setupEnvs: {}, warnings: [] }),
}));

vi.mock("../port-monitor.js", () => ({
  getPortStatuses: vi.fn().mockReturnValue([]),
  checkPort: vi.fn().mockResolvedValue("healthy"),
  startMonitoring: vi.fn(),
  stopMonitoring: vi.fn(),
}));

vi.mock("../launch-runner.js", () => ({
  getServiceStatuses: vi.fn().mockReturnValue([]),
  stopAllServices: vi.fn(),
  startServices: vi.fn().mockResolvedValue({ ok: true }),
}));

vi.mock("../git-utils.js", () => ({
  getRepoInfo: vi.fn(() => null),
}));

import { loadLaunchConfig, resolveForContext } from "../launch-config.js";
import { getPortStatuses, checkPort, startMonitoring, stopMonitoring } from "../port-monitor.js";
import { getServiceStatuses, stopAllServices, startServices } from "../launch-runner.js";
import { getRepoInfo } from "../git-utils.js";

const mockLoadLaunchConfig = vi.mocked(loadLaunchConfig);
const mockResolveForContext = vi.mocked(resolveForContext);
const mockGetPortStatuses = vi.mocked(getPortStatuses);
const mockCheckPort = vi.mocked(checkPort);
const mockGetServiceStatuses = vi.mocked(getServiceStatuses);
const mockStopAllServices = vi.mocked(stopAllServices);
const mockStartServices = vi.mocked(startServices);
const mockStartMonitoring = vi.mocked(startMonitoring);
const mockStopMonitoring = vi.mocked(stopMonitoring);
const mockGetRepoInfo = vi.mocked(getRepoInfo);

// Mock launcher that returns session info by ID
const mockLauncher = {
  getSession: vi.fn().mockReturnValue(null),
  getSessionEnv: vi.fn().mockReturnValue(undefined),
} as any;

describe("Launch Routes", () => {
  let app: Hono;
  const allowedBase = process.cwd();

  beforeEach(() => {
    vi.clearAllMocks();
    mockLoadLaunchConfig.mockReturnValue(null);
    mockGetPortStatuses.mockReturnValue([]);
    mockCheckPort.mockResolvedValue("healthy");
    mockGetServiceStatuses.mockReturnValue([]);
    mockStartServices.mockResolvedValue({ ok: true } as any);
    mockLauncher.getSession.mockReturnValue(null);
    mockGetRepoInfo.mockReturnValue(null);
    app = new Hono();
    registerLaunchRoutes(app, mockLauncher);
  });

  // ── GET /launch-config ────────────────────────────────────────────────────

  it("GET /launch-config returns 400 when cwd is missing", async () => {
    const res = await app.request("/launch-config");
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("cwd");
  });

  it("GET /launch-config returns exists: false when no config found", async () => {
    mockLoadLaunchConfig.mockReturnValue(null);
    const res = await app.request(`/launch-config?cwd=${encodeURIComponent(`${allowedBase}/test`)}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.exists).toBe(false);
  });

  it("GET /launch-config returns config when found", async () => {
    const mockConfig = { version: "1", services: {} } as any;
    mockLoadLaunchConfig.mockReturnValue(mockConfig);
    const res = await app.request(`/launch-config?cwd=${encodeURIComponent(`${allowedBase}/test`)}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.exists).toBe(true);
    expect(body.config.version).toBe("1");
  });

  it("GET /launch-config rejects cwd outside workspace and home", async () => {
    const res = await app.request("/launch-config?cwd=/etc");
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toContain("workspace or home");
  });

  // ── GET /sessions/:id/ports ───────────────────────────────────────────────

  it("GET /sessions/:id/ports returns port statuses", async () => {
    mockGetPortStatuses.mockReturnValue([
      { port: 3000, label: "API", protocol: "http", status: "healthy", lastCheck: 123 },
    ] as any);
    const res = await app.request("/sessions/test-123/ports");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveLength(1);
    expect(body[0].port).toBe(3000);
    expect(mockGetPortStatuses).toHaveBeenCalledWith("test-123");
  });

  // ── POST /sessions/:id/ports/:port/check ──────────────────────────────────

  it("POST check returns port status", async () => {
    const res = await app.request("/sessions/test-123/ports/3000/check", { method: "POST" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.port).toBe(3000);
    expect(body.status).toBe("healthy");
    expect(mockCheckPort).toHaveBeenCalledWith("test-123", 3000);
  });

  it("POST check returns 400 for invalid port", async () => {
    const res = await app.request("/sessions/test-123/ports/abc/check", { method: "POST" });
    expect(res.status).toBe(400);
  });

  // ── GET /sessions/:id/services ────────────────────────────────────────────

  it("GET /sessions/:id/services returns service statuses", async () => {
    mockGetServiceStatuses.mockReturnValue([
      { name: "api", status: "running", pid: 1234 },
    ] as any);
    const res = await app.request("/sessions/test-123/services");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveLength(1);
    expect(body[0].name).toBe("api");
    expect(mockGetServiceStatuses).toHaveBeenCalledWith("test-123");
  });

  it("GET /sessions/:id/services resolves launch config with repoRoot and worktree context", async () => {
    mockGetServiceStatuses.mockReturnValue([{ name: "api", status: "ready", pid: 1234 }] as any);
    mockLauncher.getSession.mockReturnValue({ cwd: "/repo/worktrees/feature", containerId: null });
    mockGetRepoInfo.mockReturnValue({
      repoRoot: "/repo",
      repoName: "repo",
      currentBranch: "feature",
      defaultBranch: "main",
      isWorktree: true,
    } as any);
    mockLoadLaunchConfig.mockReturnValue({
      version: "1",
      services: { api: { command: "node api.js" }, web: { command: "node web.js" } },
    } as any);
    mockResolveForContext.mockReturnValue({
      setup: [],
      services: {
        api: { name: "api", command: "node api.js", env: {}, dependsOn: {}, readyTimeout: 60 },
        web: { name: "web", command: "node web.js", env: {}, dependsOn: {}, readyTimeout: 60 },
      },
      ports: {},
    } as any);

    const res = await app.request("/sessions/test-123/services");

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual([
      { name: "api", status: "ready", pid: 1234 },
      { name: "web", status: "stopped" },
    ]);
    expect(mockLoadLaunchConfig).toHaveBeenCalledWith("/repo/worktrees/feature", "/repo");
    expect(mockResolveForContext).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ isWorktree: true, isSandbox: false }),
    );
  });

  // ── POST /sessions/:id/launch-config/reload ─────────────────────────────

  it("POST reload returns 404 when session not found", async () => {
    mockLauncher.getSession.mockReturnValue(null);
    const res = await app.request("/sessions/unknown/launch-config/reload", { method: "POST" });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toContain("Session not found");
  });

  it("POST reload returns reloaded: false when no config found", async () => {
    mockLauncher.getSession.mockReturnValue({ cwd: "/my/project", containerId: null });
    mockLoadLaunchConfig.mockReturnValue(null);

    const res = await app.request("/sessions/sess-1/launch-config/reload", { method: "POST" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.reloaded).toBe(false);
    expect(body.error).toContain("launch.json");
    // Should NOT stop services when config is missing (avoid leaving session in stopped state)
    expect(mockStopAllServices).not.toHaveBeenCalled();
    expect(mockStopMonitoring).not.toHaveBeenCalled();
  });

  it("POST reload succeeds with valid config, starts services and monitoring", async () => {
    mockLauncher.getSession.mockReturnValue({ cwd: "/my/project", containerId: "ctr-abc" });
    const config = {
      version: "1",
      services: { api: { command: "node server.js" } },
      ports: { "3000": { label: "API", protocol: "http" as const } },
    };
    mockLoadLaunchConfig.mockReturnValue(config);
    mockResolveForContext.mockReturnValue({
      setup: [],
      services: { api: { name: "api", command: "node server.js", env: {}, dependsOn: {}, readyTimeout: 60 } },
      ports: { "3000": { label: "API", protocol: "http" as const } },
    });

    const res = await app.request("/sessions/sess-2/launch-config/reload", { method: "POST" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.reloaded).toBe(true);
    expect(body.services).toEqual(["api"]);
    expect(body.ports).toEqual(["3000"]);

    // Verify lifecycle: stop → reload → start services → start monitoring
    expect(mockStopAllServices).toHaveBeenCalledWith("sess-2");
    expect(mockStopMonitoring).toHaveBeenCalledWith("sess-2");
    expect(mockStartServices).toHaveBeenCalled();
    expect(mockStartMonitoring).toHaveBeenCalledWith("sess-2", { "3000": { label: "API", protocol: "http" } });
  });

  it("POST reload passes worktree context and repo root to launch config resolution", async () => {
    mockLauncher.getSession.mockReturnValue({ cwd: "/repo/worktrees/feature", containerId: null });
    mockGetRepoInfo.mockReturnValue({
      repoRoot: "/repo",
      repoName: "repo",
      currentBranch: "feature",
      defaultBranch: "main",
      isWorktree: true,
    } as any);
    mockLoadLaunchConfig.mockReturnValue({
      version: "1",
      services: {},
      ports: {},
    } as any);
    mockResolveForContext.mockReturnValue({
      setup: [],
      services: {},
      ports: {},
    } as any);

    const res = await app.request("/sessions/sess-3/launch-config/reload", { method: "POST" });

    expect(res.status).toBe(200);
    expect(mockLoadLaunchConfig).toHaveBeenCalledWith("/repo/worktrees/feature", "/repo");
    expect(mockResolveForContext).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ isWorktree: true }),
    );
  });
});
