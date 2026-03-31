import { homedir } from "node:os";
import { resolve } from "node:path";
import type { Hono } from "hono";
import type { CliLauncher } from "../cli-launcher.js";
import type { WsBridge } from "../ws-bridge.js";
import { loadLaunchConfig, resolveForContext, resolveEnvVars } from "../launch-config.js";
import { getPortStatuses, checkPort, startMonitoring, stopMonitoring } from "../port-monitor.js";
import { getServiceStatuses, stopAllServices, startServices, restartService, stopService, getServiceLogs } from "../launch-runner.js";
import { companionBus } from "../event-bus.js";
import * as gitUtils from "../git-utils.js";

function guardPath(rawPath: string, allowedBases: string[]): string | null {
  const abs = resolve(rawPath);
  for (const base of allowedBases) {
    if (abs === base || abs.startsWith(base + "/")) return abs;
  }
  return null;
}

/** Resolve a session's cwd — checks launcher first, then ws-bridge for SDK sessions. */
function resolveSessionCwd(
  sessionId: string,
  launcher: CliLauncher,
  wsBridge?: WsBridge,
): { cwd: string; containerId?: string; repoRoot?: string; isWorktree: boolean } | null {
  // Try launcher sessions first (sessions spawned by the companion)
  const launched = launcher.getSession(sessionId);
  if (launched) {
    const repoInfo = gitUtils.getRepoInfo(launched.cwd);
    return {
      cwd: launched.cwd,
      containerId: launched.containerId,
      repoRoot: repoInfo?.repoRoot,
      isWorktree: repoInfo?.isWorktree ?? false,
    };
  }
  // Fallback: SDK sessions connected via WebSocket
  if (wsBridge) {
    const session = wsBridge.getSession(sessionId);
    if (session?.state?.cwd) {
      return {
        cwd: session.state.cwd,
        repoRoot: session.state.repo_root || undefined,
        isWorktree: session.state.is_worktree,
      };
    }
  }
  return null;
}

function resolveLaunchConfigForSession(
  session: { cwd: string; repoRoot?: string; isWorktree: boolean },
) {
  const config = loadLaunchConfig(session.cwd, session.repoRoot);
  if (!config) return null;
  return {
    config,
    resolved: resolveForContext(config, {
      isSandbox: false,
      isWorktree: session.isWorktree,
    }),
  };
}

export function registerLaunchRoutes(api: Hono, launcher: CliLauncher, wsBridge?: WsBridge): void {
  const portStatusCleanupTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const serviceStatusCleanupTimers = new Map<string, ReturnType<typeof setTimeout>>();

  companionBus.on("port:status", ({ sessionId, ports }) => {
    if (ports.length > 0 || portStatusCleanupTimers.has(sessionId)) return;
    const existing = portStatusCleanupTimers.get(sessionId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      portStatusCleanupTimers.delete(sessionId);
    }, 2_000);
    portStatusCleanupTimers.set(sessionId, timer);
  });

  companionBus.on("service:status", ({ sessionId, services }) => {
    if (services.length > 0 || serviceStatusCleanupTimers.has(sessionId)) return;
    const existing = serviceStatusCleanupTimers.get(sessionId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      serviceStatusCleanupTimers.delete(sessionId);
    }, 2_000);
    serviceStatusCleanupTimers.set(sessionId, timer);
  });

  // Check if a launch config exists for a given working directory
  api.get("/launch-config", (c) => {
    const cwd = c.req.query("cwd");
    if (!cwd) {
      return c.json({ error: "cwd query parameter is required" }, 400);
    }

    const guardedCwd = guardPath(cwd, [process.cwd(), homedir()]);
    if (!guardedCwd) {
      return c.json({ error: "cwd must be inside the workspace or home directory" }, 403);
    }

    const repoInfo = gitUtils.getRepoInfo(guardedCwd);
    const config = loadLaunchConfig(guardedCwd, repoInfo?.repoRoot);
    return c.json({
      exists: config !== null,
      config: config ?? undefined,
    });
  });

  // Get port health statuses for a session
  api.get("/sessions/:id/ports", (c) => {
    const sessionId = c.req.param("id");
    const pendingCleanup = portStatusCleanupTimers.get(sessionId);
    if (pendingCleanup) {
      portStatusCleanupTimers.delete(sessionId);
      clearTimeout(pendingCleanup);
      return c.json([]);
    }
    const statuses = getPortStatuses(sessionId);
    return c.json(statuses);
  });

  // Trigger a manual health check for a specific port
  api.post("/sessions/:id/ports/:port/check", async (c) => {
    const sessionId = c.req.param("id");
    const port = Number(c.req.param("port"));
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return c.json({ error: "Invalid port number" }, 400);
    }

    const status = await checkPort(sessionId, port);
    return c.json({ port, status });
  });

  // Get service statuses for a session (running services + configured but not started)
  api.get("/sessions/:id/services", (c) => {
    const sessionId = c.req.param("id");
    const pendingCleanup = serviceStatusCleanupTimers.get(sessionId);
    if (pendingCleanup) {
      serviceStatusCleanupTimers.delete(sessionId);
      clearTimeout(pendingCleanup);
      return c.json([]);
    }
    const running = getServiceStatuses(sessionId);

    // Also include configured services from launch.json that aren't running yet
    const session = resolveSessionCwd(sessionId, launcher, wsBridge);
    if (session) {
      const launch = resolveLaunchConfigForSession(session);
      if (launch) {
        const runningNames = new Set(running.map((s) => s.name));
        for (const name of Object.keys(launch.resolved.services)) {
          if (!runningNames.has(name)) {
            running.push({
              name,
              status: "stopped" as const,
            });
          }
        }
      }
    }

    return c.json(running);
  });

  // Get buffered log lines for a specific service
  api.get("/sessions/:id/services/:name/logs", (c) => {
    const id = c.req.param("id");
    const name = c.req.param("name");
    const limit = parseInt(c.req.query("limit") || "200", 10);
    const logs = getServiceLogs(id, name, limit);
    return c.json({ logs });
  });

  // Reload .companion/launch.json — stops existing services/monitoring,
  // re-reads config, starts services and port monitoring fresh.
  api.post("/sessions/:id/launch-config/reload", async (c) => {
    const sessionId = c.req.param("id");
    const session = resolveSessionCwd(sessionId, launcher, wsBridge);
    if (!session) {
      return c.json({ error: "Session not found" }, 404);
    }

    // Validate config exists before tearing down running services
    const config = loadLaunchConfig(session.cwd, session.repoRoot);
    if (!config) {
      return c.json({ reloaded: false, error: "No .companion/launch.json found" });
    }

    // Stop existing services and port monitoring only after confirming valid config
    stopAllServices(sessionId);
    stopMonitoring(sessionId);

    const resolved = resolveForContext(config, {
      isSandbox: !!session.containerId,
      isWorktree: session.isWorktree,
    });

    // Resolve env vars (session env → envFile → process.env)
    const sessionEnv = launcher.getSessionEnv(sessionId);
    const resolvedEnv = resolveEnvVars(config, session.cwd, sessionEnv);

    // Start services
    const serviceNames = Object.keys(resolved.services);
    if (serviceNames.length > 0) {
      await startServices(resolved, {
        cwd: session.cwd,
        containerId: session.containerId,
        sessionId,
        env: resolvedEnv.topLevelEnv,
      });
    }

    // Start port monitoring (health checks auto-broadcast via companionBus)
    const portKeys = Object.keys(resolved.ports);
    if (portKeys.length > 0) {
      startMonitoring(sessionId, resolved.ports);
    }

    return c.json({
      reloaded: true,
      services: serviceNames,
      ports: portKeys,
    });
  });

  // Restart a specific service
  api.post("/sessions/:id/services/:name/restart", async (c) => {
    const sessionId = c.req.param("id");
    const serviceName = c.req.param("name");
    const session = resolveSessionCwd(sessionId, launcher, wsBridge);
    if (!session) {
      return c.json({ error: "Session not found" }, 404);
    }

    const config = loadLaunchConfig(session.cwd, session.repoRoot);
    if (!config) {
      return c.json({ error: "No .companion/launch.json found" }, 404);
    }

    const resolved = resolveForContext(config, {
      isSandbox: !!session.containerId,
      isWorktree: session.isWorktree,
    });

    const sessionEnv = launcher.getSessionEnv(sessionId);
    const resolvedEnv = resolveEnvVars(config, session.cwd, sessionEnv);

    const result = await restartService(sessionId, serviceName, resolved, {
      cwd: session.cwd,
      containerId: session.containerId,
      env: resolvedEnv.serviceEnvs[serviceName] ?? resolvedEnv.topLevelEnv,
    });

    if (!result.ok) {
      return c.json({ error: result.error }, 400);
    }

    return c.json({ restarted: true, service: serviceName });
  });

  // Stop a specific service
  api.post("/sessions/:id/services/:name/stop", (c) => {
    const sessionId = c.req.param("id");
    const serviceName = c.req.param("name");

    const stopped = stopService(sessionId, serviceName);
    if (!stopped) {
      return c.json({ error: `Service "${serviceName}" not found` }, 404);
    }

    return c.json({ stopped: true, service: serviceName });
  });
}
