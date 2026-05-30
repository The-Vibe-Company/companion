import { Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { streamSSE } from "hono/streaming";
import { execSync } from "node:child_process";
import { resolveBinary } from "./path-resolver.js";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { COMPANION_HOME } from "./paths.js";
import { existsSync, readFileSync } from "node:fs";
import type { SessionOrchestrator } from "./session-orchestrator.js";
import type { CliLauncher } from "./cli-launcher.js";
import type { WsBridge } from "./ws-bridge.js";
import type { TerminalManager } from "./terminal-manager.js";
import * as sessionNames from "./session-names.js";
import * as sessionLinearIssues from "./session-linear-issues.js";
import { containerManager } from "./container-manager.js";
import { registerFsRoutes } from "./routes/fs-routes.js";
import { registerSkillRoutes } from "./routes/skills-routes.js";
import { registerEnvRoutes } from "./routes/env-routes.js";
import { registerSandboxRoutes } from "./routes/sandbox-routes.js";
import { registerCronRoutes } from "./routes/cron-routes.js";
import { registerAgentRoutes } from "./routes/agent-routes.js";
import { registerMetricsRoutes } from "./routes/metrics-routes.js";
import { registerLinearAgentWebhookRoute, registerLinearAgentProtectedRoutes } from "./routes/linear-agent-routes.js";
import { registerPromptRoutes } from "./routes/prompt-routes.js";
import { registerSettingsRoutes } from "./routes/settings-routes.js";
import { registerTailscaleRoutes } from "./routes/tailscale-routes.js";
import { registerGitRoutes } from "./routes/git-routes.js";
import { registerSystemRoutes } from "./routes/system-routes.js";
import { registerIdeSessionRoutes } from "./routes/ide-session-routes.js";
import { isRecordingHubEnabled } from "./recording-hub/hub-config.js";
import { registerHubRoutes } from "./recording-hub/hub-routes.js";
import { registerLinearRoutes, fetchLinearTeamStates } from "./routes/linear-routes.js";
import { registerLinearConnectionRoutes } from "./routes/linear-connection-routes.js";
import { getConnection, resolveApiKey } from "./linear-connections.js";
import { registerLinearOAuthConnectionRoutes } from "./routes/linear-oauth-connection-routes.js";
import { getSettings } from "./settings-manager.js";
import { discoverClaudeSessions } from "./claude-session-discovery.js";
import { getClaudeSessionHistoryPage } from "./claude-session-history.js";
import { verifyToken, getToken, regenerateToken, getAllAddresses } from "./auth-manager.js";
import QRCode from "qrcode";
import { VSCODE_EDITOR_CONTAINER_PORT, NOVNC_CONTAINER_PORT } from "./constants.js";

const UPDATE_CHECK_STALE_MS = 5 * 60 * 1000;
const ROUTES_DIR = dirname(fileURLToPath(import.meta.url));
const WEB_DIR = dirname(ROUTES_DIR);
const VSCODE_EDITOR_HOST_PORT = Number(process.env.COMPANION_EDITOR_PORT || "13338");

function shellEscapeArg(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export function createRoutes(
  orchestrator: SessionOrchestrator,
  launcher: CliLauncher,
  wsBridge: WsBridge,
  terminalManager: TerminalManager,
  prPoller?: import("./pr-poller.js").PRPoller,
  recorder?: import("./recorder.js").RecorderManager,
  cronScheduler?: import("./cron-scheduler.js").CronScheduler,
  agentExecutor?: import("./agent-executor.js").AgentExecutor,
  linearAgentBridge?: import("./linear-agent-bridge.js").LinearAgentBridge,
  port?: number,
) {
  const api = new Hono();

  // ─── Auth endpoints (exempt from auth middleware) ──────────────────

  api.post("/auth/verify", async (c) => {
    const body = await c.req.json().catch(() => ({} as { token?: string }));
    if (verifyToken(body.token)) {
      // Set cookie so the dynamic manifest can embed the token in start_url.
      // This bridges auth from Safari to standalone PWA on iOS (isolated storage).
      setCookie(c, "companion_auth", body.token!, {
        path: "/",
        httpOnly: true,
        sameSite: "Strict",
        maxAge: 365 * 24 * 60 * 60,
      });
      return c.json({ ok: true });
    }
    return c.json({ error: "Invalid token" }, 401);
  });

  api.get("/auth/qr", async (c) => {
    // QR endpoint requires auth — only authenticated users can generate QR for mobile
    const authHeader = c.req.header("Authorization");
    const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
    if (!isLocalhostRequest(c) && !verifyToken(token)) {
      return c.json({ error: "unauthorized" }, 401);
    }

    const port = Number(process.env.PORT) || (process.env.NODE_ENV === "production" ? 3456 : 3457);
    const authToken = getToken();

    // Build QR codes for each remote address (skip localhost — it auto-auths).
    // Each QR encodes the full login URL so the native iPhone Camera app can
    // open it directly: scan → tap popup → Safari opens → auto-authenticated.
    const addresses = getAllAddresses().filter((a) => a.ip !== "localhost");
    const qrCodes = await Promise.all(
      addresses.map(async (a) => {
        const loginUrl = `http://${a.ip}:${port}/?token=${authToken}`;
        const qrDataUrl = await QRCode.toDataURL(loginUrl, { width: 256, margin: 2 });
        return { label: a.label, url: `http://${a.ip}:${port}`, qrDataUrl };
      }),
    );

    return c.json({ qrCodes });
  });

  // ─── Localhost auto-auth (exempt from auth middleware) ────────────
  // Localhost users are on the same machine as the server, so they can
  // auto-authenticate without a token. This makes first-launch seamless.

  // Check if the request comes from localhost (same machine as the server).
  // Uses Bun's requestIP which returns the actual TCP source address.
  // Returns false in test environments where c.env is not a Bun server.
  function isLocalhostRequest(c: { env: unknown; req: { raw: Request } }): boolean {
    const bunServer = c.env as { requestIP?: (req: Request) => { address: string } | null };
    const ip = bunServer?.requestIP?.(c.req.raw);
    const addr = ip?.address ?? "";
    return addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
  }

  api.get("/auth/auto", (c) => {
    if (isLocalhostRequest(c)) {
      const token = getToken();
      setCookie(c, "companion_auth", token, {
        path: "/",
        httpOnly: true,
        sameSite: "Strict",
        maxAge: 365 * 24 * 60 * 60,
      });
      return c.json({ ok: true, token });
    }
    return c.json({ ok: false });
  });

  // ─── Linear Agent SDK webhook route (exempt from auth middleware) ────────
  // Uses HMAC-SHA256 signature verification, not Companion auth tokens.
  if (linearAgentBridge) {
    registerLinearAgentWebhookRoute(api, linearAgentBridge);
  }

  // ─── Auth middleware (protects all routes below) ───────────────────

  api.use("/*", async (c, next) => {
    // Skip auth for the verify endpoint (handled above)
    if (c.req.path === "/auth/verify") {
      return next();
    }

    // Localhost bypass — same machine as the server, always trusted
    if (isLocalhostRequest(c)) {
      return next();
    }

    const authHeader = c.req.header("Authorization");
    const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
    // Also check the companion_auth cookie — iframes (browser preview) can't
    // send Authorization headers, but browsers do forward cookies automatically.
    const cookieToken = getCookie(c, "companion_auth") ?? null;
    if (!verifyToken(token) && !verifyToken(cookieToken)) {
      return c.json({ error: "unauthorized" }, 401);
    }
    return next();
  });

  // ─── Linear Agent SDK protected routes (status, authorize URL, disconnect) ─────
  registerLinearAgentProtectedRoutes(api);

  // ─── Auth management (protected) ──────────────────────────────────

  api.get("/auth/token", (c) => {
    return c.json({ token: getToken() });
  });

  api.post("/auth/regenerate", (c) => {
    const token = regenerateToken();
    return c.json({ token });
  });

  // ─── SDK Sessions (--sdk-url) ─────────────────────────────────────

  api.post("/sessions/create", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const result = await orchestrator.createSession(body);
    if (!result.ok) {
      return c.json({ error: result.error }, result.status as any);
    }
    return c.json(result.session);
  });

  // ─── SSE Session Creation (with progress streaming) ─────────────────────

  api.post("/sessions/create-stream", async (c) => {
    const body = await c.req.json().catch(() => ({}));

    return streamSSE(c, async (stream) => {
      const result = await orchestrator.createSessionStreaming(
        body,
        async (step, label, status, detail) => {
          await stream.writeSSE({
            event: "progress",
            data: JSON.stringify({ step, label, status, detail }),
          });
        },
      );

      if (!result.ok) {
        await stream.writeSSE({
          event: "error",
          data: JSON.stringify({ error: result.error }),
        });
        return;
      }

      await stream.writeSSE({
        event: "done",
        data: JSON.stringify({
          sessionId: result.session.sessionId,
          state: result.session.state,
          cwd: result.session.cwd,
          backendType: result.session.backendType,
          resumeSessionAt: result.session.resumeSessionAt,
          forkSession: result.session.forkSession,
        }),
      });
    });
  });

  api.get("/sessions", (c) => {
    const sessions = launcher.listSessions();
    const names = sessionNames.getAllNames();
    const bridgeStates = wsBridge.getAllSessions();
    const bridgeMap = new Map(bridgeStates.map((s) => [s.session_id, s]));
    const enriched = sessions.map((s) => {
      const bridge = bridgeMap.get(s.sessionId);
      return {
        ...s,
        // Bridge state is the source of truth for runtime cwd updates
        // (notably containerized sessions mapped back to host paths).
        cwd: bridge?.cwd || s.cwd,
        name: names[s.sessionId] ?? s.name,
        gitBranch: bridge?.git_branch || "",
        gitAhead: bridge?.git_ahead || 0,
        gitBehind: bridge?.git_behind || 0,
        totalLinesAdded: bridge?.total_lines_added || 0,
        totalLinesRemoved: bridge?.total_lines_removed || 0,
      };
    });
    return c.json(enriched);
  });

  api.get("/sessions/:id", (c) => {
    const id = c.req.param("id");
    const session = launcher.getSession(id);
    if (!session) return c.json({ error: "Session not found" }, 404);
    return c.json(session);
  });

  api.get("/claude/sessions/discover", (c) => {
    const limitRaw = c.req.query("limit");
    const limit = limitRaw ? Number(limitRaw) : undefined;
    const sessions = discoverClaudeSessions({ limit });
    return c.json({ sessions });
  });

  api.get("/claude/sessions/:id/history", (c) => {
    const sessionId = c.req.param("id");
    const limitRaw = c.req.query("limit");
    const cursorRaw = c.req.query("cursor");
    const limit = limitRaw !== undefined ? Number(limitRaw) : undefined;
    const cursor = cursorRaw !== undefined ? Number(cursorRaw) : undefined;

    const page = getClaudeSessionHistoryPage({
      sessionId,
      limit,
      cursor,
    });
    if (!page) {
      return c.json({ error: "Claude session history not found" }, 404);
    }
    return c.json(page);
  });

  api.post("/sessions/:id/editor/start", async (c) => {
    const id = c.req.param("id");
    const session = launcher.getSession(id);
    if (!session) return c.json({ error: "Session not found" }, 404);

    // For container sessions, try code-server inside the container first.
    // If unavailable, fall through to host code-server with the host-mapped cwd.
    let hostFallbackCwd = session.cwd;

    if (session.containerId) {
      const container = containerManager.getContainer(id);
      const hasContainerCodeServer = container
        && containerManager.hasBinaryInContainer(container.containerId, "code-server");

      if (container && hasContainerCodeServer) {
        const editorPathSuffix = `?folder=${encodeURIComponent("/workspace")}`;
        const portMapping = container.portMappings.find(
          (p) => p.containerPort === VSCODE_EDITOR_CONTAINER_PORT,
        );
        if (!portMapping) {
          return c.json({
            available: false,
            installed: true,
            mode: "container",
            message: "Container editor port is missing. Start a new session to enable the VS Code editor.",
          });
        }

        try {
          const alive = containerManager.isContainerAlive(container.containerId);
          if (alive === "stopped") {
            containerManager.startContainer(container.containerId);
          } else if (alive === "missing") {
            return c.json({
              available: false,
              installed: true,
              mode: "container",
              message: "Session container no longer exists. Start a new session to use the editor.",
            });
          }

          const startCmd = [
            `if ! pgrep -f ${shellEscapeArg(`code-server.*--bind-addr 0.0.0.0:${VSCODE_EDITOR_CONTAINER_PORT}`)} >/dev/null 2>&1; then`,
            `nohup code-server --auth none --disable-telemetry --bind-addr 0.0.0.0:${VSCODE_EDITOR_CONTAINER_PORT} /workspace >/tmp/companion-code-server.log 2>&1 &`,
            "fi",
          ].join(" ");
          containerManager.execInContainer(container.containerId, ["sh", "-lc", startCmd], 10_000);

          // Wait for code-server to be ready (up to 5s)
          const containerEditorUrl = `http://localhost:${portMapping.hostPort}${editorPathSuffix}`;
          for (let i = 0; i < 25; i++) {
            try {
              const res = await fetch(`http://127.0.0.1:${portMapping.hostPort}/healthz`);
              if (res.ok || res.status === 302 || res.status === 200) break;
            } catch {
              // not ready yet
            }
            await new Promise((r) => setTimeout(r, 200));
          }

          return c.json({
            available: true,
            installed: true,
            mode: "container",
            url: containerEditorUrl,
          });
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          return c.json({
            available: false,
            installed: true,
            mode: "container",
            message: `Failed to start VS Code editor in container: ${message}`,
          });
        }
      }

      // Container doesn't have code-server — fall through to host code-server
      // using the host-mapped workspace path
      if (container) {
        hostFallbackCwd = container.hostCwd;
      }
    }

    const hostCodeServer = resolveBinary("code-server");
    if (!hostCodeServer) {
      return c.json({
        available: false,
        installed: false,
        mode: "host",
        message: "VS Code editor is not installed. Install it with: brew install code-server",
      });
    }

    const editorPathSuffix = `?folder=${encodeURIComponent(hostFallbackCwd)}`;

    try {
      const logFile = join(COMPANION_HOME, "code-server-host.log");
      const startCmd = [
        `if ! pgrep -f ${shellEscapeArg(`code-server.*--bind-addr 127.0.0.1:${VSCODE_EDITOR_HOST_PORT}`)} >/dev/null 2>&1; then`,
        `nohup ${shellEscapeArg(hostCodeServer)} --auth none --disable-telemetry --bind-addr 127.0.0.1:${VSCODE_EDITOR_HOST_PORT} ${shellEscapeArg(hostFallbackCwd)} >> ${shellEscapeArg(logFile)} 2>&1 &`,
        "fi",
      ].join(" ");
      const startHostCmd = `mkdir -p ${shellEscapeArg(COMPANION_HOME)} && ${startCmd}`;
      execSync(startHostCmd, { encoding: "utf-8", timeout: 10_000 });

      // Wait for code-server to be ready (up to 5s)
      const editorUrl = `http://localhost:${VSCODE_EDITOR_HOST_PORT}${editorPathSuffix}`;
      for (let i = 0; i < 25; i++) {
        try {
          const res = await fetch(`http://127.0.0.1:${VSCODE_EDITOR_HOST_PORT}/healthz`);
          if (res.ok || res.status === 302 || res.status === 200) break;
        } catch {
          // not ready yet
        }
        await new Promise((r) => setTimeout(r, 200));
      }

      return c.json({
        available: true,
        installed: true,
        mode: "host",
        url: editorUrl,
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return c.json({
        available: false,
        installed: true,
        mode: "host",
        message: `Failed to start VS Code editor: ${message}`,
      });
    }
  });

  // ── Browser preview ──────────────────────────────────────────────────────

  api.post("/sessions/:id/browser/start", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json().catch(() => ({} as { url?: string }));
    const session = launcher.getSession(id);
    if (!session) return c.json({ error: "Session not found" }, 404);

    if (!session.containerId) {
      return c.json({
        available: true,
        mode: "host" as const,
      });
    }

    const container = containerManager.getContainer(id);
    if (!container) {
      return c.json({
        available: false,
        mode: "container" as const,
        message: "Container not found for this session.",
      });
    }

    const alive = containerManager.isContainerAlive(container.containerId);
    if (alive === "stopped") {
      containerManager.startContainer(container.containerId);
    } else if (alive === "missing") {
      return c.json({
        available: false,
        mode: "container" as const,
        message: "Session container no longer exists.",
      });
    }

    const portMapping = container.portMappings.find(
      (p) => p.containerPort === NOVNC_CONTAINER_PORT,
    );
    if (!portMapping) {
      return c.json({
        available: false,
        mode: "container" as const,
        message: "Browser preview port not mapped. Start a new session to enable browser preview.",
      });
    }

    const hasXvfb = containerManager.hasBinaryInContainer(container.containerId, "Xvfb");
    const hasWebsockify = containerManager.hasBinaryInContainer(container.containerId, "websockify");
    if (!hasXvfb || !hasWebsockify) {
      return c.json({
        available: false,
        mode: "container" as const,
        message: "Browser preview requires Xvfb and noVNC in the container image. Rebuild with the latest the-companion image.",
      });
    }

    try {
      // Start display stack (idempotent — guarded by pgrep)
      const startScript = [
        "export DISPLAY=:99",
        'if ! pgrep -f "Xvfb :99" >/dev/null 2>&1; then',
        "  Xvfb :99 -screen 0 1280x720x24 -ac -nolisten tcp &",
        "  sleep 0.5",
        "  fluxbox -display :99 &>/dev/null &",
        "  sleep 0.3",
        "  x11vnc -display :99 -forever -shared -nopw -rfbport 5900 -noxdamage -wait 20 &>/dev/null &",
        "  sleep 0.3",
        "  websockify --web /usr/share/novnc/ 6080 localhost:5900 &>/dev/null &",
        "  sleep 1.0",
        "fi",
      ].join("\n");

      await containerManager.execInContainerAsync(
        container.containerId,
        ["sh", "-c", startScript],
        { timeout: 15_000 },
      );

      // Optionally launch Chromium to a URL (validate scheme if provided)
      let targetUrl = "about:blank";
      if (body.url && typeof body.url === "string") {
        try {
          const parsed = new URL(body.url);
          if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
            return c.json({
              available: false,
              mode: "container" as const,
              message: "Only http:// and https:// URLs are allowed.",
            });
          }
          targetUrl = body.url;
        } catch {
          return c.json({
            available: false,
            mode: "container" as const,
            message: "Invalid URL provided.",
          });
        }
      }
      const launchChrome = [
        "export DISPLAY=:99",
        'if ! pgrep -f "chromium.*--user-data-dir=/tmp/companion-chrome" >/dev/null 2>&1; then',
        `  nohup chromium --no-sandbox --disable-gpu --disable-dev-shm-usage --user-data-dir=/tmp/companion-chrome --window-size=1280,720 --window-position=0,0 ${shellEscapeArg(targetUrl)} &>/dev/null &`,
        "fi",
      ].join("\n");

      await containerManager.execInContainerAsync(
        container.containerId,
        ["sh", "-c", launchChrome],
        { timeout: 10_000 },
      );

      // Wait for noVNC to be ready (up to 10s)
      let noVncReady = false;
      for (let i = 0; i < 50; i++) {
        try {
          const res = await fetch(`http://127.0.0.1:${portMapping.hostPort}/`);
          if (res.ok || res.status === 200) {
            noVncReady = true;
            break;
          }
        } catch {
          // not ready yet
        }
        await new Promise((r) => setTimeout(r, 200));
      }

      if (!noVncReady) {
        return c.json({
          available: false,
          mode: "container" as const,
          message: "Browser preview timed out waiting for noVNC to start.",
        });
      }

      const proxyBase = `/api/sessions/${encodeURIComponent(id)}/browser/proxy`;
      const noVncUrl = `${proxyBase}/vnc.html?autoconnect=true&resize=scale&path=ws/novnc/${encodeURIComponent(id)}`;

      return c.json({
        available: true,
        mode: "container" as const,
        url: noVncUrl,
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return c.json({
        available: false,
        mode: "container" as const,
        message: `Failed to start browser preview: ${message}`,
      });
    }
  });

  api.post("/sessions/:id/browser/navigate", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json().catch(() => ({} as { url?: string }));
    const session = launcher.getSession(id);
    if (!session) return c.json({ error: "Session not found" }, 404);
    if (!session.containerId) return c.json({ error: "Not a container session" }, 400);

    const url = body.url;
    if (!url || typeof url !== "string") return c.json({ error: "url is required" }, 400);

    // Validate URL scheme — only allow http/https to prevent file:// access
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        return c.json({ error: "Only http:// and https:// URLs are allowed" }, 400);
      }
    } catch {
      return c.json({ error: "Invalid URL" }, 400);
    }

    const container = containerManager.getContainer(id);
    if (!container) return c.json({ error: "Container not found" }, 404);

    try {
      // Use xdotool to send the URL to the existing Chromium window's address bar
      // instead of spawning a new Chromium process each time
      const navScript = [
        "export DISPLAY=:99",
        // Focus the Chromium window and navigate via keyboard shortcut
        'xdotool search --onlyvisible --name "Chromium" windowactivate --sync key --clearmodifiers ctrl+l',
        "sleep 0.1",
        `xdotool type --clearmodifiers ${shellEscapeArg(url)}`,
        "xdotool key --clearmodifiers Return",
      ].join(" && ");
      await containerManager.execInContainerAsync(
        container.containerId,
        ["sh", "-c", navScript],
        { timeout: 10_000 },
      );
      return c.json({ ok: true, url });
    } catch {
      return c.json({ error: "Navigation failed" }, 500);
    }
  });

  // HTTP proxy for noVNC static files — serves through the companion's port
  api.get("/sessions/:id/browser/proxy/*", async (c) => {
    const id = c.req.param("id");
    const session = launcher.getSession(id);
    if (!session) return c.json({ error: "Session not found" }, 404);
    if (!session.containerId) return c.json({ error: "Not a container session" }, 400);

    const container = containerManager.getContainer(id);
    if (!container) return c.json({ error: "Container not found" }, 404);

    const portMapping = container.portMappings.find(
      (p) => p.containerPort === NOVNC_CONTAINER_PORT,
    );
    if (!portMapping) return c.json({ error: "Browser preview port not mapped" }, 400);

    // Extract the wildcard path after /browser/proxy/
    const fullPath = c.req.path;
    const proxyPrefix = `/api/sessions/${id}/browser/proxy/`;
    const subPath = fullPath.startsWith(proxyPrefix) ? fullPath.slice(proxyPrefix.length) : "";

    // Block path traversal (defense-in-depth)
    if (subPath.includes("..")) {
      return c.json({ error: "Invalid path" }, 400);
    }

    const queryString = new URL(c.req.url).search;

    try {
      const targetUrl = `http://127.0.0.1:${portMapping.hostPort}/${subPath}${queryString}`;
      const upstream = await fetch(targetUrl);
      const headers = new Headers();
      const ct = upstream.headers.get("content-type");
      if (ct) headers.set("Content-Type", ct);
      const cl = upstream.headers.get("content-length");
      if (cl) headers.set("Content-Length", cl);
      return new Response(upstream.body, {
        status: upstream.status,
        headers,
      });
    } catch {
      return c.json({ error: "Proxy failed: upstream unreachable" }, 502);
    }
  });


  // HTTP proxy for host browser preview — proxies localhost requests through the companion’s port
  const HOP_BY_HOP = new Set(["connection", "keep-alive", "transfer-encoding", "upgrade", "proxy-connection", "te", "trailer"]);
  api.all("/sessions/:id/browser/host-proxy/:port/*", async (c) => {
    const id = c.req.param("id");
    const session = launcher.getSession(id);
    if (!session) return c.json({ error: "Session not found" }, 404);

    const portStr = c.req.param("port");
    const portNum = parseInt(portStr, 10);
    if (isNaN(portNum) || portNum < 1 || portNum > 65535) {
      return c.json({ error: "Invalid port" }, 400);
    }

    // Block well-known sensitive service ports to limit SSRF surface area
    const BLOCKED_PORTS = new Set([22, 23, 25, 110, 143, 3306, 5432, 6379, 27017, 11211]);
    const serverPort = port || (process.env.NODE_ENV === "production" ? 3456 : 3457);
    if (portNum === serverPort || BLOCKED_PORTS.has(portNum)) {
      return c.json({ error: "Port not allowed" }, 400);
    }

    // Reconstruct path from wildcard — only take path, query comes separately
    const fullPath = c.req.path;
    const proxyPrefix = `/api/sessions/${id}/browser/host-proxy/${portNum}/`;
    const subPath = fullPath.startsWith(proxyPrefix) ? fullPath.slice(proxyPrefix.length) : "";

    // Block path traversal (Hono decodes %2e%2e before c.req.path)
    if (subPath.includes("..")) {
      return c.json({ error: "Invalid path" }, 400);
    }

    const queryString = new URL(c.req.url).search;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    try {
      const targetUrl = `http://127.0.0.1:${portNum}/${subPath}${queryString}`;
      const upstream = await fetch(targetUrl, {
        method: c.req.method,
        headers: { "accept": c.req.header("accept") || "*/*" },
        body: ["GET", "HEAD"].includes(c.req.method) ? undefined : c.req.raw.body,
        redirect: "follow",
        signal: controller.signal,
      });
      clearTimeout(timeout);
      // Forward response headers, stripping hop-by-hop headers
      const headers = new Headers();
      upstream.headers.forEach((value, key) => {
        if (!HOP_BY_HOP.has(key.toLowerCase())) {
          headers.set(key, value);
        }
      });
      return new Response(upstream.body, {
        status: upstream.status,
        headers,
      });
    } catch {
      clearTimeout(timeout);
      return c.json({ error: "Proxy failed: upstream unreachable" }, 502);
    }
  });

    api.patch("/sessions/:id/name", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json().catch(() => ({}));
    if (typeof body.name !== "string" || !body.name.trim()) {
      return c.json({ error: "name is required" }, 400);
    }
    const session = launcher.getSession(id);
    if (!session) return c.json({ error: "Session not found" }, 404);
    sessionNames.setName(id, body.name.trim());
    wsBridge.broadcastNameUpdate(id, body.name.trim());
    return c.json({ ok: true, name: body.name.trim() });
  });

  api.post("/sessions/:id/kill", async (c) => {
    const id = c.req.param("id");
    const result = await orchestrator.killSession(id);
    if (!result.ok) return c.json({ error: "Session not found or already exited" }, 404);
    return c.json({ ok: true });
  });

  api.post("/sessions/:id/relaunch", async (c) => {
    const id = c.req.param("id");
    const result = await orchestrator.relaunchSession(id);
    if (!result.ok) {
      const status = result.error?.includes("not found") || result.error?.includes("Session not found") ? 404 : 503;
      return c.json({ error: result.error || "Relaunch failed" }, status);
    }
    return c.json({ ok: true });
  });

  // Kill a background process spawned by a session
  api.post("/sessions/:id/processes/:taskId/kill", async (c) => {
    const sessionId = c.req.param("id");
    const taskId = c.req.param("taskId");

    // Validate taskId to prevent command injection (hex string from Claude Code)
    if (!/^[a-f0-9]+$/i.test(taskId)) {
      return c.json({ error: "Invalid task ID format" }, 400);
    }

    const session = launcher.getSession(sessionId);
    if (!session) return c.json({ error: "Session not found" }, 404);
    if (!session.pid) return c.json({ error: "Session PID unknown" }, 503);

    try {
      const { execFileSync } = await import("node:child_process");
      // The taskId appears in the output file path of the background process,
      // so pkill -f matches it reliably.
      // Use execFileSync (array form) to avoid shell injection — taskId is passed
      // as an argument, never interpolated into a shell string.
      if (session.containerId) {
        containerManager.execInContainer(
          session.containerId,
          ["pkill", "-f", taskId],
          5_000,
        );
      } else {
        try {
          execFileSync("pkill", ["-f", taskId], {
            timeout: 5_000,
            encoding: "utf-8",
          });
        } catch {
          // pkill returns non-zero when no processes matched — that's fine
        }
      }
      return c.json({ ok: true, taskId });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return c.json({ error: `Kill failed: ${msg}` }, 500);
    }
  });

  // Kill all background processes for a session
  api.post("/sessions/:id/processes/kill-all", async (c) => {
    const sessionId = c.req.param("id");
    const body = await c.req.json().catch(() => ({} as { taskIds?: string[] }));
    const taskIds = Array.isArray(body.taskIds) ? body.taskIds : [];

    const session = launcher.getSession(sessionId);
    if (!session) return c.json({ error: "Session not found" }, 404);
    if (!session.pid) return c.json({ error: "Session PID unknown" }, 503);

    const results: { taskId: string; ok: boolean; error?: string }[] = [];
    const { execSync } = await import("node:child_process");

    for (const taskId of taskIds) {
      if (!/^[a-f0-9]+$/i.test(taskId)) {
        results.push({ taskId, ok: false, error: "Invalid task ID" });
        continue;
      }
      try {
        if (session.containerId) {
          containerManager.execInContainer(
            session.containerId,
            ["sh", "-c", `pkill -f ${shellEscapeArg(taskId)} 2>/dev/null; true`],
            5_000,
          );
        } else {
          execSync(`pkill -f ${shellEscapeArg(taskId)} 2>/dev/null; true`, {
            timeout: 5_000,
            encoding: "utf-8",
          });
        }
        results.push({ taskId, ok: true });
      } catch (e) {
        results.push({ taskId, ok: false, error: e instanceof Error ? e.message : String(e) });
      }
    }

    return c.json({ ok: true, results });
  });

  // Scan for dev-related processes listening on TCP ports
  const DEV_COMMANDS = new Set([
    "node", "bun", "deno", "ts-node", "tsx",
    "python", "python3", "uvicorn", "gunicorn", "flask",
    "ruby", "rails", "puma",
    "go", "air",
    "java", "gradle", "mvn",
    "cargo",
    "php", "php-fpm",
    "dotnet",
    "vite", "next", "nuxt", "remix", "astro",
    "webpack", "esbuild", "rollup", "parcel",
    "tsc",
  ]);
  // System/IDE processes to exclude even if they listen on a port
  const EXCLUDE_COMMANDS = new Set([
    "launchd", "mDNSResponder", "rapportd", "systemd",
    "sshd", "cupsd", "httpd", "nginx", "postgres", "mysqld",
    "Cursor", "Code", "Electron", "WindowServer", "BetterDisplay",
    "com.docker", "Docker", "docker-proxy", "vpnkit",
    "Dropbox", "Creative Cloud", "zoom.us",
    "ControlCenter", "Finder", "loginwindow", "SystemUIServer",
  ]);

  function parseLsofCwd(raw: string): string | undefined {
    // `lsof -Fn` emits records like:
    // p1234\nfcwd\nn/Users/me/project\n
    const match = raw.match(/^n(.+)$/m);
    const cwd = match?.[1]?.trim();
    return cwd || undefined;
  }

  function parsePsStartTime(raw: string): number | undefined {
    const text = raw.trim();
    if (!text) return undefined;
    const ts = Date.parse(text);
    if (!Number.isFinite(ts)) return undefined;
    return ts;
  }

  api.get("/sessions/:id/processes/system", async (c) => {
    const sessionId = c.req.param("id");
    const session = launcher.getSession(sessionId);
    if (!session) return c.json({ error: "Session not found" }, 404);

    try {
      let raw: string;
      if (session.containerId) {
        raw = containerManager.execInContainer(
          session.containerId,
          ["sh", "-c", "lsof -iTCP -sTCP:LISTEN -P -n 2>/dev/null || ss -tlnp 2>/dev/null || true"],
          5_000,
        );
      } else {
        raw = execSync("lsof -iTCP -sTCP:LISTEN -P -n 2>/dev/null || true", {
          timeout: 5_000,
          encoding: "utf-8",
        });
      }

      // Parse lsof output: COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME
      const lines = raw.trim().split("\n").slice(1); // skip header
      const pidMap = new Map<number, { command: string; ports: Set<number> }>();

      for (const line of lines) {
        const parts = line.trim().split(/\s+/);
        if (parts.length < 9) continue;
        const command = parts[0];
        const pid = parseInt(parts[1], 10);
        if (isNaN(pid)) continue;
        if (EXCLUDE_COMMANDS.has(command)) continue;

        // macOS lsof NAME ends like `TCP *:3000 (LISTEN)`, so the final token is
        // often `(LISTEN)` rather than the address. Parse from the full line.
        const portMatch = line.match(/:(\d+)\s+\(LISTEN\)\s*$/) ?? line.match(/:(\d+)\s*$/);
        if (!portMatch) continue;
        const port = parseInt(portMatch[1], 10);

        const existing = pidMap.get(pid);
        if (existing) {
          existing.ports.add(port);
        } else {
          pidMap.set(pid, { command, ports: new Set([port]) });
        }
      }

      // Get full command line for each PID
      const processes: {
        pid: number;
        command: string;
        fullCommand: string;
        ports: number[];
        cwd?: string;
        startedAt?: number;
      }[] = [];

      for (const [pid, info] of pidMap) {
        // Skip if command isn't dev-related (check both exact name and prefix)
        const lowerCmd = info.command.toLowerCase();
        const isDev = DEV_COMMANDS.has(lowerCmd)
          || DEV_COMMANDS.has(info.command)
          || [...DEV_COMMANDS].some((d) => lowerCmd.startsWith(d));

        if (!isDev) continue;

        let fullCommand = info.command;
        let cwd: string | undefined;
        let startedAt: number | undefined;
        try {
          if (session.containerId) {
            fullCommand = containerManager.execInContainer(
              session.containerId,
              ["ps", "-p", String(pid), "-o", "args="],
              2_000,
            ).trim();
          } else {
            fullCommand = execSync(`ps -p ${pid} -o args= 2>/dev/null || true`, {
              timeout: 2_000,
              encoding: "utf-8",
            }).trim();
          }
        } catch {
          // Fall back to short command name
        }

        try {
          if (session.containerId) {
            const cwdRaw = containerManager.execInContainer(
              session.containerId,
              ["sh", "-c", `readlink /proc/${pid}/cwd 2>/dev/null || true`],
              2_000,
            ).trim();
            cwd = cwdRaw || undefined;
          } else {
            const cwdRaw = execSync(`lsof -a -p ${pid} -d cwd -Fn 2>/dev/null || true`, {
              timeout: 2_000,
              encoding: "utf-8",
            });
            cwd = parseLsofCwd(cwdRaw);
          }
        } catch {
          // Best-effort only
        }

        try {
          if (session.containerId) {
            const startRaw = containerManager.execInContainer(
              session.containerId,
              ["sh", "-c", `ps -p ${pid} -o lstart= 2>/dev/null || true`],
              2_000,
            );
            startedAt = parsePsStartTime(startRaw);
          } else {
            const startRaw = execSync(`ps -p ${pid} -o lstart= 2>/dev/null || true`, {
              timeout: 2_000,
              encoding: "utf-8",
            });
            startedAt = parsePsStartTime(startRaw);
          }
        } catch {
          // Best-effort only
        }

        processes.push({
          pid,
          command: info.command,
          fullCommand: fullCommand || info.command,
          ports: [...info.ports].sort((a, b) => a - b),
          cwd,
          startedAt,
        });
      }

      // Sort by port (lowest first)
      processes.sort((a, b) => (a.ports[0] || 0) - (b.ports[0] || 0));

      return c.json({ ok: true, processes });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return c.json({ error: `Scan failed: ${msg}` }, 500);
    }
  });

  // Kill a system process by PID
  api.post("/sessions/:id/processes/system/:pid/kill", async (c) => {
    const sessionId = c.req.param("id");
    const pidStr = c.req.param("pid");
    const pid = parseInt(pidStr, 10);

    if (isNaN(pid) || pid <= 0) {
      return c.json({ error: "Invalid PID" }, 400);
    }

    const session = launcher.getSession(sessionId);
    if (!session) return c.json({ error: "Session not found" }, 404);

    // Safety: don't allow killing the Companion server or Claude CLI process itself
    if (pid === process.pid) {
      return c.json({ error: "Cannot kill the Companion server" }, 403);
    }
    if (session.pid === pid) {
      return c.json({ error: "Use the session kill endpoint to terminate Claude" }, 403);
    }

    try {
      if (session.containerId) {
        containerManager.execInContainer(
          session.containerId,
          ["kill", "-TERM", String(pid)],
          5_000,
        );
      } else {
        process.kill(pid, "SIGTERM");
      }
      return c.json({ ok: true, pid });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return c.json({ error: `Kill failed: ${msg}` }, 500);
    }
  });

  api.delete("/sessions/:id", async (c) => {
    const id = c.req.param("id");
    const result = await orchestrator.deleteSession(id);
    return c.json({ ok: true, worktree: result.worktree });
  });

  api.get("/sessions/:id/archive-info", async (c) => {
    const id = c.req.param("id");
    const linkedIssue = sessionLinearIssues.getLinearIssue(id);

    if (!linkedIssue) {
      return c.json({ hasLinkedIssue: false, issueNotDone: false });
    }

    const stateType = (linkedIssue.stateType || "").toLowerCase();
    const isDone = stateType === "completed" || stateType === "canceled" || stateType === "cancelled";

    if (isDone) {
      return c.json({
        hasLinkedIssue: true,
        issueNotDone: false,
        issue: {
          id: linkedIssue.id,
          identifier: linkedIssue.identifier,
          stateName: linkedIssue.stateName,
          stateType: linkedIssue.stateType,
          teamId: linkedIssue.teamId,
        },
      });
    }

    // Issue is not done — check if backlog state is available and if archive transition is configured
    const resolved = resolveApiKey(linkedIssue.connectionId);
    let hasBacklogState = false;
    if (resolved && linkedIssue.teamId) {
      const teams = await fetchLinearTeamStates(resolved.apiKey);
      const team = teams.find((t) => t.id === linkedIssue.teamId);
      if (team) {
        hasBacklogState = team.states.some((s) => s.type === "backlog");
      }
    }

    // Use connection-level archive settings if available, fall back to global settings
    const settings = getSettings();
    const conn = resolved && resolved.connectionId !== "legacy" ? getConnection(resolved.connectionId) : null;
    const archiveTransitionConfigured = conn
      ? conn.archiveTransition && !!conn.archiveTransitionStateId.trim()
      : settings.linearArchiveTransition && !!settings.linearArchiveTransitionStateId.trim();
    const archiveTransitionStateName = conn
      ? conn.archiveTransitionStateName || undefined
      : settings.linearArchiveTransitionStateName || undefined;

    return c.json({
      hasLinkedIssue: true,
      issueNotDone: true,
      issue: {
        id: linkedIssue.id,
        identifier: linkedIssue.identifier,
        stateName: linkedIssue.stateName,
        stateType: linkedIssue.stateType,
        teamId: linkedIssue.teamId,
      },
      hasBacklogState,
      archiveTransitionConfigured,
      archiveTransitionStateName,
    });
  });

  api.post("/sessions/:id/archive", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json().catch(() => ({}));
    const result = await orchestrator.archiveSession(id, {
      force: body.force,
      linearTransition: body.linearTransition,
    });
    return c.json({ ok: true, worktree: result.worktree, linearTransition: result.linearTransition });
  });

  api.post("/sessions/:id/unarchive", (c) => {
    const id = c.req.param("id");
    orchestrator.unarchiveSession(id);
    return c.json({ ok: true });
  });

  // ─── IDE binding (Task 7 — API-03, API-04) ──────────────────
  // Registered via a dedicated helper next to the archive routes; the
  // handlers delegate entirely to wsBridge.bindIde / wsBridge.unbindIde.
  registerIdeSessionRoutes(api, { wsBridge });

  // ─── Recording Management ──────────────────────────────────

  api.post("/sessions/:id/recording/start", (c) => {
    const id = c.req.param("id");
    if (!recorder) return c.json({ error: "Recording not available" }, 501);
    recorder.enableForSession(id);
    return c.json({ ok: true, recording: true });
  });

  api.post("/sessions/:id/recording/stop", (c) => {
    const id = c.req.param("id");
    if (!recorder) return c.json({ error: "Recording not available" }, 501);
    recorder.disableForSession(id);
    return c.json({ ok: true, recording: false });
  });

  api.get("/sessions/:id/recording/status", (c) => {
    const id = c.req.param("id");
    if (!recorder) return c.json({ recording: false, available: false });
    return c.json({
      recording: recorder.isRecording(id),
      available: true,
      ...recorder.getRecordingStatus(id),
    });
  });

  api.get("/recordings", (c) => {
    if (!recorder) return c.json({ recordings: [] });
    return c.json({ recordings: recorder.listRecordings() });
  });

  // ─── Available backends ─────────────────────────────────────

  api.get("/backends", (c) => {
    const backends: Array<{ id: string; name: string; available: boolean }> = [];

    backends.push({ id: "claude", name: "Claude Code", available: resolveBinary("claude") !== null });
    backends.push({ id: "codex", name: "Codex", available: resolveBinary("codex") !== null });

    return c.json(backends);
  });

  api.get("/backends/:id/models", (c) => {
    const backendId = c.req.param("id");

    if (backendId === "codex") {
      // Read Codex model list from its local cache file
      const cachePath = join(homedir(), ".codex", "models_cache.json");
      if (!existsSync(cachePath)) {
        return c.json({ error: "Codex models cache not found. Run codex once to populate it." }, 404);
      }
      try {
        const raw = readFileSync(cachePath, "utf-8");
        const cache = JSON.parse(raw) as {
          models: Array<{
            slug: string;
            display_name?: string;
            description?: string;
            visibility?: string;
            priority?: number;
          }>;
        };
        // Only return visible models, sorted by priority
        const models = cache.models
          .filter((m) => m.visibility === "list")
          .sort((a, b) => (a.priority ?? 99) - (b.priority ?? 99))
          .map((m) => ({
            value: m.slug,
            label: m.display_name || m.slug,
            description: m.description || "",
          }));
        return c.json(models);
      } catch (e) {
        return c.json({ error: "Failed to parse Codex models cache" }, 500);
      }
    }

    // Claude models are hardcoded on the frontend
    return c.json({ error: "Use frontend defaults for this backend" }, 404);
  });

  // ─── Containers ─────────────────────────────────────────────────

  api.get("/containers/status", (c) => {
    const available = containerManager.checkDocker();
    const version = available ? containerManager.getDockerVersion() : null;
    return c.json({ available, version });
  });

  api.get("/containers/images", (c) => {
    const images = containerManager.listImages();
    return c.json(images);
  });

  registerFsRoutes(api);
  registerEnvRoutes(api, { webDir: WEB_DIR });
  registerSandboxRoutes(api);

  registerPromptRoutes(api);
  registerSettingsRoutes(api);

  // ─── Tailscale ──────────────────────────────────────────────────────

  if (port !== undefined) registerTailscaleRoutes(api, port);

  // ─── Linear ────────────────────────────────────────────────────────

  registerLinearRoutes(api);
  registerLinearConnectionRoutes(api);
  registerLinearOAuthConnectionRoutes(api);

  registerGitRoutes(api, prPoller);
  registerSystemRoutes(api, {
    launcher,
    wsBridge,
    terminalManager,
    updateCheckStaleMs: UPDATE_CHECK_STALE_MS,
  });

  registerSkillRoutes(api);
  registerCronRoutes(api, cronScheduler);
  registerAgentRoutes(api, agentExecutor);
  registerMetricsRoutes(api, { gaugeProvider: wsBridge });

  // ─── Recording Hub (hidden feature: COMPANION_RECORDING_HUB=1) ──────
  if (isRecordingHubEnabled()) {
    registerHubRoutes(api, {
      wsBridge,
      recordingsDir: recorder?.getRecordingsDir() ?? "",
    });
  }

  return api;
}
