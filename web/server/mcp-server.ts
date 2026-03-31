/**
 * mcp-server.ts — MCP HTTP server handler implementing JSON-RPC 2.0.
 *
 * Exposes Companion tools (validate_launch_config, test_launch_config) to
 * Claude Code and Codex agents via the MCP HTTP protocol. Auto-injected
 * into every session so agents get these tools without needing a CLI install.
 */

import { readFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { connect } from "node:net";
import { loadLaunchConfig, validateConfig, resolveForContext, buildStartupOrder, resolveEnvVars } from "./launch-config.js";
import { buildLaunchSchemaResponse } from "./launch-config-schema.js";
import type { LaunchConfig } from "./launch-config.js";
import { runSetupScripts, startServices, stopAllServices, getServiceStatuses } from "./launch-runner.js";
import { getPortStatuses, startMonitoring, stopMonitoring } from "./port-monitor.js";
import type { WsBridge } from "./ws-bridge.js";
import type { CliLauncher } from "./cli-launcher.js";

// ── JSON-RPC Types ─────────────────────────────────────────────────────────

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: string | number;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

// ── Tool Definitions ───────────────────────────────────────────────────────

const TOOLS = [
  {
    name: "validate_launch_config",
    description:
      "Validate a .companion/launch.json config file. Returns structured validation results including errors and a config summary (services, ports, setup scripts).",
    inputSchema: {
      type: "object" as const,
      properties: {
        cwd: {
          type: "string",
          description: "Project directory to check. Defaults to the session's working directory.",
        },
      },
    },
  },
  {
    name: "get_launch_config_schema",
    description:
      "Get the full JSON Schema and a complete example for .companion/launch.json configuration files. Use this before creating or editing a launch config.",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },
  {
    name: "test_launch_config",
    description:
      "Dry-run test of a .companion/launch.json config. Validates the config, attempts to start services, checks port health, then stops everything. Returns a full report.",
    inputSchema: {
      type: "object" as const,
      properties: {
        cwd: {
          type: "string",
          description: "Project directory to test. Defaults to the session's working directory.",
        },
        context: {
          type: "object",
          description: "Execution context for condition filtering.",
          properties: {
            isSandbox: { type: "boolean" },
            isWorktree: { type: "boolean" },
          },
        },
      },
    },
  },
  {
    name: "reload_launch_config",
    description:
      "Reload .companion/launch.json and restart services/ports for the current session. Use after creating or modifying a launch config to apply changes without creating a new session.",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },
  {
    name: "get_session_environment_status",
    description:
      "Get the current status of services and ports for a running session. Returns service statuses (running/stopped/crashed) and port health (healthy/unhealthy/unknown).",
    inputSchema: {
      type: "object" as const,
      properties: {
        sessionId: {
          type: "string",
          description: "Session ID to check. Defaults to the current session.",
        },
      },
    },
  },
];

// ── Server Info ────────────────────────────────────────────────────────────

let cachedVersion: string | null = null;
function getVersion(): string {
  if (cachedVersion) return cachedVersion;
  try {
    const pkgPath = join(dirname(fileURLToPath(import.meta.url)), "..", "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
    cachedVersion = pkg.version ?? "0.0.0";
  } catch {
    cachedVersion = "0.0.0";
  }
  return cachedVersion!;
}

// ── Handler ────────────────────────────────────────────────────────────────

export interface McpHandlerDeps {
  wsBridge: WsBridge;
  launcher: CliLauncher;
}

interface ResolvedSessionContext {
  cwd: string | null;
  repoRoot?: string;
  isWorktree: boolean;
  isSandbox: boolean;
  sessionId: string | null;
}

function resolveExecutionContext(
  sessionContext: ResolvedSessionContext,
  args: Record<string, unknown>,
) {
  const override = (args.context as { isSandbox?: boolean; isWorktree?: boolean } | undefined) ?? {};
  return {
    isSandbox: override.isSandbox ?? sessionContext.isSandbox,
    isWorktree: override.isWorktree ?? sessionContext.isWorktree,
  };
}

/**
 * Handle an MCP JSON-RPC request and return a JSON-RPC response.
 */
export async function handleMcpRequest(
  body: JsonRpcRequest,
  sessionId: string | null,
  deps: McpHandlerDeps,
): Promise<JsonRpcResponse> {
  const id = body.id ?? null;

  switch (body.method) {
    case "initialize":
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "companion", version: getVersion() },
        },
      };

    case "notifications/initialized":
      // Client acknowledgment — no response needed, but return success
      return { jsonrpc: "2.0", id, result: {} };

    case "tools/list":
      return {
        jsonrpc: "2.0",
        id,
        result: { tools: TOOLS },
      };

    case "tools/call":
      return handleToolCall(body.params ?? {}, sessionId, deps, id);

    default:
      return {
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: `Method not found: ${body.method}` },
      };
  }
}

// ── Tool Dispatch ──────────────────────────────────────────────────────────

async function handleToolCall(
  params: Record<string, unknown>,
  sessionId: string | null,
  deps: McpHandlerDeps,
  id: string | number | null,
): Promise<JsonRpcResponse> {
  const toolName = params.name as string | undefined;
  const args = (params.arguments ?? {}) as Record<string, unknown>;

  if (!toolName) {
    return {
      jsonrpc: "2.0",
      id,
      error: { code: -32602, message: "Missing tool name in params.name" },
    };
  }

  // Resolve cwd/session context from tool args or session
  const sessionContext = resolveSessionContext(args, sessionId, deps);

  try {
    switch (toolName) {
      case "get_launch_config_schema":
        return { jsonrpc: "2.0", id, result: toolResult(buildLaunchSchemaResponse()) };

      case "validate_launch_config":
        return { jsonrpc: "2.0", id, result: toolResult(await toolValidate(sessionContext)) };

      case "test_launch_config":
        return { jsonrpc: "2.0", id, result: toolResult(await toolTest(sessionContext, args)) };

      case "reload_launch_config":
        return { jsonrpc: "2.0", id, result: toolResult(await toolReload(sessionContext, deps)) };

      case "get_session_environment_status":
        return { jsonrpc: "2.0", id, result: toolResult(toolEnvironmentStatus(args, sessionContext.sessionId)) };

      default:
        return {
          jsonrpc: "2.0",
          id,
          error: { code: -32602, message: `Unknown tool: ${toolName}` },
        };
    }
  } catch (e) {
    return {
      jsonrpc: "2.0",
      id,
      result: toolResult({ error: e instanceof Error ? e.message : String(e) }, true),
    };
  }
}

function toolResult(data: unknown, isError = false) {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    isError,
  };
}

function resolveSessionContext(
  args: Record<string, unknown>,
  sessionId: string | null,
  deps: McpHandlerDeps,
): ResolvedSessionContext {
  if (typeof args.cwd === "string" && args.cwd) {
    return {
      cwd: resolve(args.cwd),
      isSandbox: false,
      isWorktree: false,
      sessionId,
    };
  }

  if (!sessionId) {
    return {
      cwd: null,
      isSandbox: false,
      isWorktree: false,
      sessionId,
    };
  }

  // Try ws-bridge session state first
  const bridgeSession = deps.wsBridge.getSession(sessionId);
  if (bridgeSession?.state?.cwd) {
    return {
      cwd: bridgeSession.state.cwd,
      repoRoot: bridgeSession.state.repo_root || undefined,
      isWorktree: bridgeSession.state.is_worktree,
      isSandbox: bridgeSession.state.is_containerized,
      sessionId,
    };
  }

  // Fall back to launcher session info
  const launcherSession = deps.launcher.getSession(sessionId);
  if (launcherSession?.cwd) {
    return {
      cwd: launcherSession.cwd,
      isSandbox: !!launcherSession.containerId,
      isWorktree: false,
      sessionId,
    };
  }

  return {
    cwd: null,
    isSandbox: false,
    isWorktree: false,
    sessionId,
  };
}

function loadConfigForContext(
  ctx: ResolvedSessionContext,
): LaunchConfig | null {
  if (!ctx.cwd) return null;
  return loadLaunchConfig(ctx.cwd, ctx.repoRoot);
}

// ── Tool: validate_launch_config ───────────────────────────────────────────

function buildConfigSummary(config: LaunchConfig) {
  return {
    version: config.version,
    setup_count: config.setup?.length ?? 0,
    service_count: config.services ? Object.keys(config.services).length : 0,
    port_count: config.ports ? Object.keys(config.ports).length : 0,
    services: config.services ? Object.keys(config.services) : [],
    ports: config.ports
      ? Object.fromEntries(
          Object.entries(config.ports).map(([port, cfg]) => [port, cfg.label]),
        )
      : {},
  };
}

async function toolValidate(ctx: ResolvedSessionContext) {
  if (!ctx.cwd) {
    return { valid: false, errors: ["No working directory available. Provide 'cwd' argument."], config_summary: null };
  }

  const config = loadConfigForContext(ctx);
  if (!config) {
    return { valid: false, errors: ["No .companion/launch.json found or file is invalid."], config_summary: null };
  }

  const validation = validateConfig(config);
  return {
    valid: validation.valid,
    errors: validation.errors,
    config_summary: buildConfigSummary(config),
  };
}

// ── Tool: test_launch_config ───────────────────────────────────────────────

async function toolTest(sessionContext: ResolvedSessionContext, args: Record<string, unknown>) {
  if (!sessionContext.cwd) {
    return { valid: false, errors: ["No working directory available. Provide 'cwd' argument."] };
  }

  const config = loadConfigForContext(sessionContext);
  if (!config) {
    return { valid: false, errors: ["No .companion/launch.json found or file is invalid."] };
  }

  const validation = validateConfig(config);
  if (!validation.valid) {
    return { valid: false, errors: validation.errors, config_summary: buildConfigSummary(config) };
  }

  const executionContext = resolveExecutionContext(sessionContext, args);
  const resolved = resolveForContext(config, {
    isSandbox: executionContext.isSandbox,
    isWorktree: executionContext.isWorktree,
  });

  const configSummary = buildConfigSummary(config);
  let startupOrder: string[][] = [];

  try {
    startupOrder = buildStartupOrder(resolved.services);
  } catch (e) {
    return {
      valid: false,
      errors: [e instanceof Error ? e.message : String(e)],
      config_summary: configSummary,
    };
  }

  // Use a temporary session ID for the test run
  const testSessionId = `mcp-test-${Date.now()}`;
  const setupResults: Array<{ name: string; ok: boolean; error?: string }> = [];
  const serviceResults: Array<{ name: string; started: boolean; ready: boolean; error?: string }> = [];
  const portResults: Array<{ port: number; label: string; status: string }> = [];

  try {
    // Run setup scripts
    if (resolved.setup.length > 0) {
      const setupResult = await runSetupScripts(resolved.setup, {
        cwd: sessionContext.cwd,
        timeout: 30_000,
      });
      setupResults.push({
        name: resolved.setup.map((s) => s.name).join(", "),
        ok: setupResult.ok,
        error: setupResult.error,
      });
    }

    // Start services
    if (Object.keys(resolved.services).length > 0) {
      await startServices(resolved, {
        cwd: sessionContext.cwd,
        sessionId: testSessionId,
        onProgress: (name, status, detail) => {
          const existing = serviceResults.find((s) => s.name === name);
          if (existing) {
            existing.started = status === "started" || status === "ready";
            existing.ready = status === "ready";
            if (detail && status === "failed") existing.error = detail;
          } else {
            serviceResults.push({
              name,
              started: status === "started" || status === "ready",
              ready: status === "ready",
              error: status === "failed" ? detail : undefined,
            });
          }
        },
      });

      // Brief pause for services to stabilize
      await new Promise((r) => setTimeout(r, 2000));
    }

    // Check port health with direct probes
    if (config.ports) {
      for (const [portStr, portConfig] of Object.entries(config.ports)) {
        const port = Number(portStr);
        const protocol = portConfig.protocol ?? "http";
        const status = protocol === "http"
          ? await probeHttp(port, portConfig.healthCheck?.path ?? "/")
          : await probeTcp(port);
        portResults.push({ port, label: portConfig.label, status });
      }
    }
  } finally {
    // Always clean up
    stopAllServices(testSessionId);
  }

  return {
    valid: true,
    config_summary: configSummary,
    startup_order: startupOrder,
    setup_results: setupResults,
    service_results: serviceResults,
    port_results: portResults,
  };
}

// ── Reload ────────────────────────────────────────────────────────────────

async function toolReload(
  sessionContext: ResolvedSessionContext,
  deps: McpHandlerDeps,
): Promise<unknown> {
  const sessionId = sessionContext.sessionId;
  if (!sessionId) {
    return { error: "No session ID available. Cannot reload without a session context." };
  }

  // Get session info for container context
  const launcherSession = deps.launcher.getSession(sessionId);
  const effectiveCwd = sessionContext.cwd ?? launcherSession?.cwd ?? null;
  if (!effectiveCwd) {
    return { error: "No working directory available for this session." };
  }

  // Validate config exists before tearing down running services
  const config = loadLaunchConfig(effectiveCwd, sessionContext.repoRoot);
  if (!config) {
    return { reloaded: false, error: "No .companion/launch.json found at " + effectiveCwd };
  }

  // Stop existing services and monitoring only after confirming valid config
  stopAllServices(sessionId);
  stopMonitoring(sessionId);

  const resolved = resolveForContext(config, {
    isSandbox: sessionContext.isSandbox || !!launcherSession?.containerId,
    isWorktree: sessionContext.isWorktree,
  });

  // Resolve env vars (session env → envFile → process.env)
  const sessionEnv = deps.launcher.getSessionEnv(sessionId);
  const resolvedEnv = resolveEnvVars(config, effectiveCwd, sessionEnv);

  // Start services
  const serviceNames = Object.keys(resolved.services);
  if (serviceNames.length > 0) {
    const svcResult = await startServices(resolved, {
      cwd: effectiveCwd,
      containerId: launcherSession?.containerId,
      sessionId,
      env: resolvedEnv.topLevelEnv,
    });
    if (!svcResult.ok) {
      return { reloaded: false, error: svcResult.error ?? "Service startup failed", services: serviceNames };
    }
  }

  // Start port monitoring
  const portKeys = Object.keys(resolved.ports);
  if (portKeys.length > 0) {
    startMonitoring(sessionId, resolved.ports);
  }

  return {
    reloaded: true,
    services: serviceNames,
    ports: portKeys,
    env_warnings: resolvedEnv.warnings.length > 0 ? resolvedEnv.warnings : undefined,
  };
}

// ── Environment Status ────────────────────────────────────────────────────

function toolEnvironmentStatus(
  args: Record<string, unknown>,
  requestSessionId: string | null,
): { error: string } | { sessionId: string; services: unknown[]; ports: unknown[] } {
  const sid = (args.sessionId as string | undefined) ?? requestSessionId;
  if (!sid) {
    return { error: "No session ID available. Pass sessionId or call from within a session." };
  }

  const services = getServiceStatuses(sid);
  const ports = getPortStatuses(sid);

  return {
    sessionId: sid,
    services: services.map((s) => ({
      name: s.name,
      status: s.status,
      pid: s.pid,
    })),
    ports: ports.map((p) => ({
      port: p.port,
      label: p.label,
      protocol: p.protocol,
      status: p.status,
      service: p.service,
      lastCheck: p.lastCheck,
    })),
  };
}

// ── Direct Port Probes (for test tool, no monitor dependency) ──────────────

async function probeHttp(port: number, path: string): Promise<string> {
  try {
    const url = `http://127.0.0.1:${port}${path.startsWith("/") ? path : `/${path}`}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    return res.ok ? "healthy" : "unhealthy";
  } catch {
    return "unreachable";
  }
}

function probeTcp(port: number): Promise<string> {
  return new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port, timeout: 5000 });
    socket.on("connect", () => {
      socket.destroy();
      resolve("healthy");
    });
    socket.on("error", () => {
      socket.destroy();
      resolve("unreachable");
    });
    socket.on("timeout", () => {
      socket.destroy();
      resolve("unreachable");
    });
  });
}
