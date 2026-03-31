// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from "vitest";
import { handleMcpRequest, type McpHandlerDeps } from "./mcp-server.js";

// ── Mock launch-config ──────────────────────────────────────────────────────

vi.mock("./launch-config.js", () => ({
  loadLaunchConfig: vi.fn(),
  validateConfig: vi.fn(),
  resolveForContext: vi.fn(),
  buildStartupOrder: vi.fn(),
  resolveEnvVars: vi.fn().mockReturnValue({ topLevelEnv: {}, serviceEnvs: {}, setupEnvs: {}, warnings: [] }),
}));

vi.mock("./launch-runner.js", () => ({
  runSetupScripts: vi.fn().mockResolvedValue({ ok: true }),
  startServices: vi.fn().mockResolvedValue({ ok: true }),
  stopAllServices: vi.fn(),
  getServiceStatuses: vi.fn().mockReturnValue([]),
}));

vi.mock("./port-monitor.js", () => ({
  getPortStatuses: vi.fn().mockReturnValue([]),
  startMonitoring: vi.fn(),
  stopMonitoring: vi.fn(),
}));

import { loadLaunchConfig, validateConfig, resolveForContext, buildStartupOrder } from "./launch-config.js";

const mockLoadLaunchConfig = loadLaunchConfig as ReturnType<typeof vi.fn>;
const mockValidateConfig = validateConfig as ReturnType<typeof vi.fn>;
const mockResolveForContext = resolveForContext as ReturnType<typeof vi.fn>;
const mockBuildStartupOrder = buildStartupOrder as ReturnType<typeof vi.fn>;

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeDeps(overrides: Partial<McpHandlerDeps> = {}): McpHandlerDeps {
  return {
    wsBridge: {
      getSession: vi.fn().mockReturnValue(null),
    } as unknown as McpHandlerDeps["wsBridge"],
    launcher: {
      getSession: vi.fn().mockReturnValue(null),
      getSessionEnv: vi.fn().mockReturnValue(undefined),
    } as unknown as McpHandlerDeps["launcher"],
    ...overrides,
  };
}

function rpc(method: string, params?: Record<string, unknown>, id: number | string = 1) {
  return { jsonrpc: "2.0" as const, id, method, params };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("MCP Server — handleMcpRequest", () => {
  let deps: McpHandlerDeps;

  beforeEach(() => {
    vi.clearAllMocks();
    deps = makeDeps();
  });

  // ── initialize ────────────────────────────────────────────────────────────

  it("initialize returns protocol version, capabilities, and server info", async () => {
    const res = await handleMcpRequest(rpc("initialize"), null, deps);
    expect(res.jsonrpc).toBe("2.0");
    expect(res.id).toBe(1);
    expect(res.error).toBeUndefined();
    const result = res.result as Record<string, unknown>;
    expect(result.protocolVersion).toBe("2024-11-05");
    expect(result.capabilities).toEqual({ tools: {} });
    const serverInfo = result.serverInfo as Record<string, unknown>;
    expect(serverInfo.name).toBe("companion");
    expect(typeof serverInfo.version).toBe("string");
  });

  // ── notifications/initialized ─────────────────────────────────────────────

  it("notifications/initialized returns success (acknowledgment)", async () => {
    const res = await handleMcpRequest(rpc("notifications/initialized"), null, deps);
    expect(res.result).toEqual({});
    expect(res.error).toBeUndefined();
  });

  // ── tools/list ────────────────────────────────────────────────────────────

  it("tools/list returns all five tools", async () => {
    const res = await handleMcpRequest(rpc("tools/list"), null, deps);
    const result = res.result as { tools: Array<{ name: string; inputSchema: unknown }> };
    expect(result.tools).toHaveLength(5);
    const names = result.tools.map((t) => t.name);
    expect(names).toContain("get_launch_config_schema");
    expect(names).toContain("validate_launch_config");
    expect(names).toContain("test_launch_config");
    expect(names).toContain("reload_launch_config");
    expect(names).toContain("get_session_environment_status");
    // Each tool should have an inputSchema
    for (const tool of result.tools) {
      expect(tool.inputSchema).toBeDefined();
      expect((tool.inputSchema as Record<string, unknown>).type).toBe("object");
    }
  });

  // ── Unknown method ────────────────────────────────────────────────────────

  it("unknown method returns -32601 error", async () => {
    const res = await handleMcpRequest(rpc("nonexistent/method"), null, deps);
    expect(res.error).toBeDefined();
    expect(res.error!.code).toBe(-32601);
    expect(res.error!.message).toContain("nonexistent/method");
  });

  // ── tools/call — missing tool name ────────────────────────────────────────

  it("tools/call with missing tool name returns -32602 error", async () => {
    const res = await handleMcpRequest(
      rpc("tools/call", { arguments: {} }),
      null,
      deps,
    );
    expect(res.error).toBeDefined();
    expect(res.error!.code).toBe(-32602);
    expect(res.error!.message).toContain("Missing tool name");
  });

  // ── tools/call — unknown tool ─────────────────────────────────────────────

  it("tools/call with unknown tool returns -32602 error", async () => {
    const res = await handleMcpRequest(
      rpc("tools/call", { name: "unknown_tool", arguments: { cwd: "/tmp" } }),
      null,
      deps,
    );
    expect(res.error).toBeDefined();
    expect(res.error!.code).toBe(-32602);
    expect(res.error!.message).toContain("Unknown tool");
  });

  // ── get_launch_config_schema ──────────────────────────────────────────────

  it("get_launch_config_schema returns schema and example without needing session context", async () => {
    const res = await handleMcpRequest(
      rpc("tools/call", { name: "get_launch_config_schema", arguments: {} }),
      null, // no session
      deps,
    );
    expect(res.error).toBeUndefined();
    const result = res.result as { content: Array<{ type: string; text: string }>; isError?: boolean };
    expect(result.isError).toBeFalsy();
    expect(result.content).toHaveLength(1);
    const text = result.content[0].text;
    // Should contain schema documentation
    expect(text).toContain("JSON Schema");
    expect(text).toContain("Complete Example");
    // Should reference the key config sections
    expect(text).toContain("setup");
    expect(text).toContain("services");
    expect(text).toContain("ports");
    expect(text).toContain("dependsOn");
  });

  // ── get_session_environment_status ─────────────────────────────────────────

  it("get_session_environment_status returns services and ports for a session", async () => {
    // The tool should return empty arrays when no services/ports are tracked for this session
    const res = await handleMcpRequest(
      rpc("tools/call", { name: "get_session_environment_status", arguments: {} }),
      "test-session-123",
      deps,
    );
    expect(res.error).toBeUndefined();
    const result = res.result as { content: Array<{ type: string; text: string }>; isError?: boolean };
    expect(result.isError).toBe(false);
    const data = JSON.parse(result.content[0].text);
    expect(data.sessionId).toBe("test-session-123");
    expect(Array.isArray(data.services)).toBe(true);
    expect(Array.isArray(data.ports)).toBe(true);
  });

  it("get_session_environment_status returns error when no session ID available", async () => {
    const res = await handleMcpRequest(
      rpc("tools/call", { name: "get_session_environment_status", arguments: {} }),
      null, // no session
      deps,
    );
    expect(res.error).toBeUndefined();
    const result = res.result as { content: Array<{ type: string; text: string }> };
    const data = JSON.parse(result.content[0].text);
    expect(data.error).toBeDefined();
    expect(typeof data.error).toBe("string");
  });

  // ── validate_launch_config ────────────────────────────────────────────────

  it("validate_launch_config with no cwd returns error in tool result", async () => {
    // No session, no cwd in args → tool result indicates error
    const res = await handleMcpRequest(
      rpc("tools/call", { name: "validate_launch_config", arguments: {} }),
      null,
      deps,
    );
    expect(res.error).toBeUndefined();
    const result = res.result as { content: Array<{ text: string }>; isError?: boolean };
    const data = JSON.parse(result.content[0].text);
    expect(data.valid).toBe(false);
    expect(data.errors[0]).toContain("working directory");
  });

  it("validate_launch_config with missing config file returns not-found error", async () => {
    mockLoadLaunchConfig.mockReturnValue(null);

    const res = await handleMcpRequest(
      rpc("tools/call", { name: "validate_launch_config", arguments: { cwd: "/fake/project" } }),
      null,
      deps,
    );
    const result = res.result as { content: Array<{ text: string }> };
    const data = JSON.parse(result.content[0].text);
    expect(data.valid).toBe(false);
    expect(data.errors[0]).toContain("launch.json");
  });

  it("validate_launch_config with valid config returns summary", async () => {
    const config = {
      version: "1",
      setup: [{ name: "install", command: "npm install" }],
      services: { api: { command: "node server.js" } },
      ports: { "3000": { label: "API" } },
    };
    mockLoadLaunchConfig.mockReturnValue(config);
    mockValidateConfig.mockReturnValue({ valid: true, errors: [] });

    const res = await handleMcpRequest(
      rpc("tools/call", { name: "validate_launch_config", arguments: { cwd: "/my/project" } }),
      null,
      deps,
    );
    const result = res.result as { content: Array<{ text: string }> };
    const data = JSON.parse(result.content[0].text);
    expect(data.valid).toBe(true);
    expect(data.config_summary.version).toBe("1");
    expect(data.config_summary.setup_count).toBe(1);
    expect(data.config_summary.service_count).toBe(1);
    expect(data.config_summary.port_count).toBe(1);
    expect(data.config_summary.services).toEqual(["api"]);
  });

  it("validate_launch_config with invalid config returns errors", async () => {
    const config = { version: "1" };
    mockLoadLaunchConfig.mockReturnValue(config);
    mockValidateConfig.mockReturnValue({ valid: false, errors: ["Services are misconfigured"] });

    const res = await handleMcpRequest(
      rpc("tools/call", { name: "validate_launch_config", arguments: { cwd: "/bad/project" } }),
      null,
      deps,
    );
    const result = res.result as { content: Array<{ text: string }> };
    const data = JSON.parse(result.content[0].text);
    expect(data.valid).toBe(false);
    expect(data.errors).toContain("Services are misconfigured");
  });

  // ── test_launch_config ────────────────────────────────────────────────────

  it("test_launch_config with no cwd returns error", async () => {
    const res = await handleMcpRequest(
      rpc("tools/call", { name: "test_launch_config", arguments: {} }),
      null,
      deps,
    );
    const result = res.result as { content: Array<{ text: string }> };
    const data = JSON.parse(result.content[0].text);
    expect(data.valid).toBe(false);
    expect(data.errors[0]).toContain("working directory");
  });

  it("test_launch_config with invalid config returns validation errors", async () => {
    const config = { version: "1" };
    mockLoadLaunchConfig.mockReturnValue(config);
    mockValidateConfig.mockReturnValue({ valid: false, errors: ["Missing services"] });

    const res = await handleMcpRequest(
      rpc("tools/call", { name: "test_launch_config", arguments: { cwd: "/project" } }),
      null,
      deps,
    );
    const result = res.result as { content: Array<{ text: string }> };
    const data = JSON.parse(result.content[0].text);
    expect(data.valid).toBe(false);
    expect(data.errors).toContain("Missing services");
  });

  it("test_launch_config returns startup order error when circular deps found", async () => {
    const config = {
      version: "1",
      services: {
        a: { command: "start-a", dependsOn: { b: "started" } },
        b: { command: "start-b", dependsOn: { a: "started" } },
      },
    };
    mockLoadLaunchConfig.mockReturnValue(config);
    mockValidateConfig.mockReturnValue({ valid: true, errors: [] });
    mockResolveForContext.mockReturnValue({
      setup: [],
      services: {
        a: { name: "a", command: "start-a", env: {}, dependsOn: { b: "started" }, readyTimeout: 60 },
        b: { name: "b", command: "start-b", env: {}, dependsOn: { a: "started" }, readyTimeout: 60 },
      },
      ports: {},
    });
    mockBuildStartupOrder.mockImplementation(() => {
      throw new Error("Circular dependency detected: a, b");
    });

    const res = await handleMcpRequest(
      rpc("tools/call", { name: "test_launch_config", arguments: { cwd: "/project" } }),
      null,
      deps,
    );
    const result = res.result as { content: Array<{ text: string }> };
    const data = JSON.parse(result.content[0].text);
    expect(data.valid).toBe(false);
    expect(data.errors[0]).toContain("Circular dependency");
  });

  it("test_launch_config with setup scripts reports their results", async () => {
    const config = {
      version: "1",
      setup: [{ name: "install", command: "npm install" }],
    };
    mockLoadLaunchConfig.mockReturnValue(config);
    mockValidateConfig.mockReturnValue({ valid: true, errors: [] });
    mockResolveForContext.mockReturnValue({
      setup: [{ name: "install", command: "npm install" }],
      services: {},
      ports: {},
    });
    mockBuildStartupOrder.mockReturnValue([]);

    const { runSetupScripts } = await import("./launch-runner.js");
    (runSetupScripts as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true });

    const res = await handleMcpRequest(
      rpc("tools/call", { name: "test_launch_config", arguments: { cwd: "/project" } }),
      null,
      deps,
    );
    const result = res.result as { content: Array<{ text: string }> };
    const data = JSON.parse(result.content[0].text);
    expect(data.valid).toBe(true);
    expect(data.setup_results).toHaveLength(1);
    expect(data.setup_results[0].ok).toBe(true);
  });

  it("test_launch_config with context arg applies condition filtering", async () => {
    const config = { version: "1" };
    mockLoadLaunchConfig.mockReturnValue(config);
    mockValidateConfig.mockReturnValue({ valid: true, errors: [] });
    mockResolveForContext.mockReturnValue({ setup: [], services: {}, ports: {} });
    mockBuildStartupOrder.mockReturnValue([]);

    await handleMcpRequest(
      rpc("tools/call", {
        name: "test_launch_config",
        arguments: { cwd: "/project", context: { isSandbox: true, isWorktree: false } },
      }),
      null,
      deps,
    );
    expect(mockResolveForContext).toHaveBeenCalledWith(config, { isSandbox: true, isWorktree: false });
  });

  it("test_launch_config with valid config runs full test cycle", async () => {
    // Set up a valid config scenario
    const config = {
      version: "1",
      services: { web: { command: "node app.js" } },
      ports: { "8080": { label: "Web", protocol: "http", healthCheck: { path: "/" } } },
    };
    mockLoadLaunchConfig.mockReturnValue(config);
    mockValidateConfig.mockReturnValue({ valid: true, errors: [] });
    mockResolveForContext.mockReturnValue({
      setup: [],
      services: { web: { name: "web", command: "node app.js", env: {}, dependsOn: {}, readyTimeout: 60 } },
      ports: { "8080": { label: "Web", protocol: "http", healthCheck: { path: "/" } } },
    });
    mockBuildStartupOrder.mockReturnValue([["web"]]);

    const res = await handleMcpRequest(
      rpc("tools/call", { name: "test_launch_config", arguments: { cwd: "/project" } }),
      null,
      deps,
    );
    const result = res.result as { content: Array<{ text: string }> };
    const data = JSON.parse(result.content[0].text);
    expect(data.valid).toBe(true);
    expect(data.config_summary).toBeDefined();
    expect(data.startup_order).toEqual([["web"]]);
  });

  // ── cwd resolution from session ───────────────────────────────────────────

  it("resolves cwd from wsBridge session when not in args", async () => {
    mockLoadLaunchConfig.mockReturnValue(null);

    const depsWithSession = makeDeps({
      wsBridge: {
        getSession: vi.fn().mockReturnValue({
          state: { cwd: "/ws/project", repo_root: "/repo", is_worktree: true, is_containerized: false },
        }),
      } as unknown as McpHandlerDeps["wsBridge"],
    });

    const res = await handleMcpRequest(
      rpc("tools/call", { name: "validate_launch_config", arguments: {} }),
      "session-1",
      depsWithSession,
    );
    // Should use repo-root fallback for worktree sessions
    expect(mockLoadLaunchConfig).toHaveBeenCalledWith("/ws/project", "/repo");
  });

  it("resolves cwd from launcher session as fallback", async () => {
    mockLoadLaunchConfig.mockReturnValue(null);

    const depsWithLauncher = makeDeps({
      wsBridge: {
        getSession: vi.fn().mockReturnValue(null),
      } as unknown as McpHandlerDeps["wsBridge"],
      launcher: {
        getSession: vi.fn().mockReturnValue({ cwd: "/launcher/project" }),
        getSessionEnv: vi.fn().mockReturnValue(undefined),
      } as unknown as McpHandlerDeps["launcher"],
    });

    const res = await handleMcpRequest(
      rpc("tools/call", { name: "validate_launch_config", arguments: {} }),
      "session-2",
      depsWithLauncher,
    );
    expect(mockLoadLaunchConfig).toHaveBeenCalledWith("/launcher/project", undefined);
  });

  it("reload_launch_config uses worktree repo root fallback from wsBridge state", async () => {
    const config = { version: "1", services: {}, ports: {} };
    mockLoadLaunchConfig.mockReturnValue(config);
    mockResolveForContext.mockReturnValue({ setup: [], services: {}, ports: {} });

    const depsWithWorktree = makeDeps({
      wsBridge: {
        getSession: vi.fn().mockReturnValue({
          state: {
            cwd: "/repo/worktrees/feature",
            repo_root: "/repo",
            is_worktree: true,
            is_containerized: false,
          },
        }),
      } as unknown as McpHandlerDeps["wsBridge"],
    });

    await handleMcpRequest(
      rpc("tools/call", { name: "reload_launch_config", arguments: {} }),
      "session-worktree",
      depsWithWorktree,
    );

    expect(mockLoadLaunchConfig).toHaveBeenCalledWith("/repo/worktrees/feature", "/repo");
  });

  // ── reload_launch_config ─────────────────────────────────────────────────

  it("reload_launch_config returns error when no session ID", async () => {
    const res = await handleMcpRequest(
      rpc("tools/call", { name: "reload_launch_config", arguments: {} }),
      null, // no session
      deps,
    );
    expect(res.error).toBeUndefined();
    const result = res.result as { content: Array<{ text: string }> };
    const data = JSON.parse(result.content[0].text);
    expect(data.error).toContain("No session ID");
  });

  it("reload_launch_config returns error when no cwd available", async () => {
    // Session exists but no cwd available from any source
    const res = await handleMcpRequest(
      rpc("tools/call", { name: "reload_launch_config", arguments: {} }),
      "session-no-cwd",
      deps,
    );
    expect(res.error).toBeUndefined();
    const result = res.result as { content: Array<{ text: string }> };
    const data = JSON.parse(result.content[0].text);
    expect(data.error).toContain("working directory");
  });

  it("reload_launch_config returns error when no config found", async () => {
    mockLoadLaunchConfig.mockReturnValue(null);
    const depsWithCwd = makeDeps({
      launcher: {
        getSession: vi.fn().mockReturnValue({ cwd: "/my/project" }),
        getSessionEnv: vi.fn().mockReturnValue(undefined),
      } as unknown as McpHandlerDeps["launcher"],
    });

    const res = await handleMcpRequest(
      rpc("tools/call", { name: "reload_launch_config", arguments: {} }),
      "session-123",
      depsWithCwd,
    );
    expect(res.error).toBeUndefined();
    const result = res.result as { content: Array<{ text: string }> };
    const data = JSON.parse(result.content[0].text);
    expect(data.reloaded).toBe(false);
    expect(data.error).toContain("launch.json");
  });

  it("reload_launch_config succeeds with valid config and session", async () => {
    const config = {
      version: "1",
      services: { api: { command: "node server.js" } },
      ports: { "3000": { label: "API", protocol: "http" } },
    };
    mockLoadLaunchConfig.mockReturnValue(config);
    mockResolveForContext.mockReturnValue({
      setup: [],
      services: { api: { name: "api", command: "node server.js" } },
      ports: { "3000": { label: "API", protocol: "http" } },
    });

    const depsWithSession = makeDeps({
      launcher: {
        getSession: vi.fn().mockReturnValue({ cwd: "/my/project", containerId: null }),
        getSessionEnv: vi.fn().mockReturnValue(undefined),
      } as unknown as McpHandlerDeps["launcher"],
    });

    const res = await handleMcpRequest(
      rpc("tools/call", { name: "reload_launch_config", arguments: {} }),
      "session-456",
      depsWithSession,
    );
    expect(res.error).toBeUndefined();
    const result = res.result as { content: Array<{ text: string }>; isError?: boolean };
    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0].text);
    expect(data.reloaded).toBe(true);
    expect(data.services).toEqual(["api"]);
    expect(data.ports).toEqual(["3000"]);
  });

  // ── JSON-RPC ID propagation ───────────────────────────────────────────────

  it("preserves the JSON-RPC id in the response", async () => {
    const res = await handleMcpRequest(rpc("initialize", undefined, 42), null, deps);
    expect(res.id).toBe(42);

    const res2 = await handleMcpRequest(rpc("initialize", undefined, "abc"), null, deps);
    expect(res2.id).toBe("abc");
  });
});
