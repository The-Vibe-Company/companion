process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = "1";

// Enrich process PATH at startup so binary resolution and `which` calls can find
// binaries installed via version managers (nvm, volta, fnm, etc.).
// Critical when running as a launchd/systemd service with a restricted PATH.
import { getEnrichedPath } from "./path-resolver.js";
process.env.PATH = getEnrichedPath();

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { serveStatic } from "hono/bun";
import { cacheControlMiddleware } from "./cache-headers.js";
import { createRoutes } from "./routes.js";
import { CliLauncher } from "./cli-launcher.js";
import { WsBridge } from "./ws-bridge.js";
import { SessionStore } from "./session-store.js";
import { WorktreeTracker } from "./worktree-tracker.js";
import { containerManager } from "./container-manager.js";
import { join } from "node:path";
import { COMPANION_HOME } from "./paths.js";
import { TerminalManager } from "./terminal-manager.js";
import { PRPoller } from "./pr-poller.js";
import { RecorderManager } from "./recorder.js";
import { initLogFile, closeLogFile } from "./logger.js";
import { CronScheduler } from "./cron-scheduler.js";
import { AgentExecutor } from "./agent-executor.js";
import { SessionOrchestrator } from "./session-orchestrator.js";
import { migrateCronJobsToAgents } from "./agent-cron-migrator.js";
import { migrateLinearCredentialsToAgents } from "./linear-credential-migration.js";
import { authenticateManagedWebSocket } from "./ws-auth.js";
import { LinearAgentBridge } from "./linear-agent-bridge.js";
import { NoVncProxy } from "./novnc-proxy.js";

import { startPeriodicCheck, setServiceMode } from "./update-checker.js";
import { imagePullManager } from "./image-pull-manager.js";
import { restoreIfNeeded as restoreTailscaleFunnel, cleanup as cleanupTailscaleFunnel } from "./tailscale-manager.js";
import { isRunningAsService } from "./service.js";
import { getToken, verifyToken } from "./auth-manager.js";
import { getCookie } from "hono/cookie";
import type { SocketData } from "./ws-bridge.js";
import type { ServerWebSocket } from "bun";

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageRoot = process.env.__COMPANION_PACKAGE_ROOT || resolve(__dirname, "..");

import { DEFAULT_PORT_DEV, DEFAULT_PORT_PROD } from "./constants.js";

const defaultPort = process.env.NODE_ENV === "production" ? DEFAULT_PORT_PROD : DEFAULT_PORT_DEV;
const port = Number(process.env.PORT) || defaultPort;
const host = process.env.HOST || "0.0.0.0";
const sessionStore = new SessionStore(process.env.COMPANION_SESSION_DIR);
const wsBridge = new WsBridge();
const launcher = new CliLauncher(port);
const worktreeTracker = new WorktreeTracker();
const CONTAINER_STATE_PATH = join(COMPANION_HOME, "containers.json");
const terminalManager = new TerminalManager();
const noVncProxy = new NoVncProxy();
const prPoller = new PRPoller(wsBridge);
const recorder = new RecorderManager();
const cronScheduler = new CronScheduler(launcher, wsBridge);
const agentExecutor = new AgentExecutor(launcher, wsBridge);
const linearAgentBridge = new LinearAgentBridge(agentExecutor, wsBridge);

const orchestrator = new SessionOrchestrator({
  launcher, wsBridge, sessionStore, worktreeTracker,
  prPoller, agentExecutor,
});

// ── Cloud relay connection (for receiving webhooks behind a firewall) ────────
// The relay forwards platform webhooks (e.g. GitHub, Slack) to the Companion
// instance via an outbound WebSocket. Currently no webhook handlers are
// registered (Chat SDK was removed). The relay is left disabled until handlers
// are wired up (e.g. LinearAgentBridge or future platform integrations).
if (process.env.COMPANION_RELAY_URL && process.env.COMPANION_RELAY_SECRET) {
  console.warn(
    "[server] COMPANION_RELAY_URL is set but no relay webhook handlers are registered. " +
    "The relay client will not be started. Remove COMPANION_RELAY_URL/COMPANION_RELAY_SECRET " +
    "or wire up webhook handlers to use relay mode.",
  );
}

// ── Restore persisted sessions from disk ────────────────────────────────────
wsBridge.setStore(sessionStore);
wsBridge.setRecorder(recorder);
launcher.setStore(sessionStore);
launcher.setRecorder(recorder);
launcher.restoreFromDisk();
wsBridge.restoreFromDisk();
containerManager.restoreState(CONTAINER_STATE_PATH);

// ── Session orchestrator — centralizes lifecycle event wiring ────────────────
orchestrator.initialize();

console.log(`[server] Session persistence: ${sessionStore.directory}`);
if (recorder.isGloballyEnabled()) {
  console.log(`[server] Recording enabled (dir: ${recorder.getRecordingsDir()}, max: ${recorder.getMaxLines()} lines)`);
}

// ── Log file persistence — writes all log output to ~/.companion/logs/ ───────
const logFileWriter = initLogFile();
if (logFileWriter) {
  console.log(`[server] Log file enabled (dir: ${logFileWriter.getLogsDir()}, max: ${logFileWriter.getMaxLines()} lines, file: ${logFileWriter.filePath})`);
}

const app = new Hono();

// ── Health endpoint — always unauthenticated (used by Fly.io + control plane) ─
const startTime = Date.now();
app.get("/health", (c) => {
  return c.json({
    ok: true,
    uptime: Math.floor((Date.now() - startTime) / 1000),
    sessions: launcher.listSessions().length,
  });
});

// ── Managed auth middleware — only active when COMPANION_AUTH_ENABLED=1 ────
const hasManagedAuthSecret = Boolean(process.env.COMPANION_AUTH_SECRET?.trim());
const managedAuthEnabled =
  process.env.COMPANION_AUTH_ENABLED === "1" ||
  (hasManagedAuthSecret && process.env.COMPANION_AUTH_ENABLED !== "0");

if (managedAuthEnabled) {
  const { managedAuth } = await import("./middleware/managed-auth.js");
  app.use("/*", managedAuth);
  console.log("[server] Managed auth enabled");
} else {
  console.log("[server] Managed auth disabled");
}

app.use("/api/*", cors());
app.route("/api", createRoutes(orchestrator, launcher, wsBridge, terminalManager, prPoller, recorder, cronScheduler, agentExecutor, linearAgentBridge, port));

// Dynamic manifest — embeds auth token in start_url so PWA auto-authenticates
// on first launch. iOS gives standalone PWAs isolated storage from Safari,
// so this is the only way to bridge auth across the install boundary.
app.get("/manifest.json", (c) => {
  const manifest = {
    name: "The Companion",
    short_name: "Companion",
    description: "Web UI for Claude Code and Codex",
    start_url: "/",
    scope: "/",
    display: "standalone" as const,
    background_color: "#262624",
    theme_color: "#d97757",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
    ],
  };

  // If the user has an auth cookie (set during login), embed token in start_url.
  // Safari sends this cookie when fetching the manifest at "Add to Home Screen" time.
  const authCookie = getCookie(c, "companion_auth");
  if (authCookie && verifyToken(authCookie)) {
    manifest.start_url = `/?token=${authCookie}`;
  } else {
    // Localhost bypass — always embed the token for same-machine installs
    const bunServer = c.env as { requestIP?: (req: Request) => { address: string } | null };
    const ip = bunServer?.requestIP?.(c.req.raw);
    const addr = ip?.address ?? "";
    if (addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1") {
      manifest.start_url = `/?token=${getToken()}`;
    }
  }

  c.header("Content-Type", "application/manifest+json");
  return c.json(manifest);
});

// In production, serve built frontend using absolute path (works when installed as npm package)
if (process.env.NODE_ENV === "production") {
  const distDir = resolve(packageRoot, "dist");
  app.use("/*", cacheControlMiddleware());
  app.use("/*", serveStatic({ root: distDir }));
  app.get("/*", serveStatic({ path: resolve(distDir, "index.html") }));
}

const server = Bun.serve<SocketData>({
  hostname: host,
  port,
  idleTimeout: 0, // Disable top-level idle timeout — it kills idle browser WebSockets (code 1006)
  async fetch(req, server) {
    const url = new URL(req.url);

    // ── CLI WebSocket — Claude Code CLI connects here via --sdk-url ────
    const cliMatch = url.pathname.match(/^\/ws\/cli\/([a-f0-9-]+)$/);
    if (cliMatch) {
      const sessionId = cliMatch[1];
      const upgraded = server.upgrade(req, {
        data: { kind: "cli" as const, sessionId },
      });
      if (upgraded) return undefined;
      return new Response("WebSocket upgrade failed", { status: 400 });
    }

    // Helper: check if request is from localhost (same machine)
    const reqIp = server.requestIP(req);
    const reqAddr = reqIp?.address ?? "";
    const isLocalhost = reqAddr === "127.0.0.1" || reqAddr === "::1" || reqAddr === "::ffff:127.0.0.1";

    // ── Browser WebSocket — connects to a specific session ─────────────
    const browserMatch = url.pathname.match(/^\/ws\/browser\/([a-f0-9-]+)$/);
    if (browserMatch) {
      if (managedAuthEnabled) {
        const auth = await authenticateManagedWebSocket(req);
        if (!auth.ok) {
          return new Response(auth.body || "Unauthorized", { status: auth.status });
        }
      } else {
        const wsToken = url.searchParams.get("token");
        if (!isLocalhost && !verifyToken(wsToken)) {
          return new Response("Unauthorized", { status: 401 });
        }
      }
      const sessionId = browserMatch[1];
      const upgraded = server.upgrade(req, {
        data: { kind: "browser" as const, sessionId },
      });
      if (upgraded) return undefined;
      return new Response("WebSocket upgrade failed", { status: 400 });
    }

    // ── Terminal WebSocket — embedded terminal PTY connection ─────────
    const termMatch = url.pathname.match(/^\/ws\/terminal\/([a-f0-9-]+)$/);
    if (termMatch) {
      if (managedAuthEnabled) {
        const auth = await authenticateManagedWebSocket(req);
        if (!auth.ok) {
          return new Response(auth.body || "Unauthorized", { status: auth.status });
        }
      } else {
        const wsToken = url.searchParams.get("token");
        if (!isLocalhost && !verifyToken(wsToken)) {
          return new Response("Unauthorized", { status: 401 });
        }
      }
      const terminalId = termMatch[1];
      const upgraded = server.upgrade(req, {
        data: { kind: "terminal" as const, terminalId },
      });
      if (upgraded) return undefined;
      return new Response("WebSocket upgrade failed", { status: 400 });
    }

    // ── noVNC WebSocket — proxies VNC data to container's websockify ────
    const novncMatch = url.pathname.match(/^\/ws\/novnc\/([a-f0-9-]+)$/);
    if (novncMatch) {
      if (managedAuthEnabled) {
        const auth = await authenticateManagedWebSocket(req);
        if (!auth.ok) {
          return new Response(auth.body || "Unauthorized", { status: auth.status });
        }
      } else {
        const wsToken = url.searchParams.get("token");
        if (!isLocalhost && !verifyToken(wsToken)) {
          return new Response("Unauthorized", { status: 401 });
        }
      }
      const sessionId = novncMatch[1];
      const upgraded = server.upgrade(req, {
        data: { kind: "novnc" as const, sessionId },
      });
      if (upgraded) return undefined;
      return new Response("WebSocket upgrade failed", { status: 400 });
    }

    // Hono handles the rest
    return app.fetch(req, server);
  },
  websocket: {
    idleTimeout: 0,
    sendPings: false, // Disable Bun ping timeout that kills CLI connections (code 1006)
    open(ws: ServerWebSocket<SocketData>) {
      const data = ws.data;
      if (data.kind === "cli") {
        wsBridge.handleCLIOpen(ws, data.sessionId);
        launcher.markConnected(data.sessionId);
      } else if (data.kind === "browser") {
        wsBridge.handleBrowserOpen(ws, data.sessionId);
      } else if (data.kind === "terminal") {
        terminalManager.addBrowserSocket(ws);
      } else if (data.kind === "novnc") {
        noVncProxy.handleOpen(ws, data.sessionId);
      }
    },
    message(ws: ServerWebSocket<SocketData>, msg: string | Buffer) {
      const data = ws.data;
      if (data.kind === "cli") {
        wsBridge.handleCLIMessage(ws, msg);
      } else if (data.kind === "browser") {
        wsBridge.handleBrowserMessage(ws, msg);
      } else if (data.kind === "terminal") {
        terminalManager.handleBrowserMessage(ws, msg);
      } else if (data.kind === "novnc") {
        noVncProxy.handleMessage(ws, msg);
      }
    },
    close(ws: ServerWebSocket<SocketData>, code?: number, _reason?: string) {
      console.log("[ws-close]", ws.data.kind, "code=" + code);
      const data = ws.data;
      if (data.kind === "cli") {
        wsBridge.handleCLIClose(ws);
      } else if (data.kind === "browser") {
        wsBridge.handleBrowserClose(ws);
      } else if (data.kind === "terminal") {
        terminalManager.removeBrowserSocket(ws);
      } else if (data.kind === "novnc") {
        noVncProxy.handleClose(ws);
      }
    },
  },
});

const authToken = getToken();
console.log(`Server running on http://${host}:${server.port}`);
console.log();
console.log(`  Auth token: ${authToken}`);
if (process.env.COMPANION_AUTH_TOKEN) {
  console.log("  (using COMPANION_AUTH_TOKEN env var)");
}
console.log();
console.log(`  CLI WebSocket:     ws://localhost:${server.port}/ws/cli/:sessionId`);
console.log(`  Browser WebSocket: ws://localhost:${server.port}/ws/browser/:sessionId`);

if (process.env.NODE_ENV !== "production") {
  console.log("Dev mode: frontend at http://localhost:5174");
}

// ── Cron scheduler ──────────────────────────────────────────────────────────
cronScheduler.startAll();

// ── Agent system ────────────────────────────────────────────────────────────
migrateCronJobsToAgents();
migrateLinearCredentialsToAgents();
agentExecutor.startAll();

// ── Image pull manager — pre-pull missing Docker images for environments ────
imagePullManager.initFromEnvironments();

// ── Tailscale Funnel restoration ────────────────────────────────────────────
restoreTailscaleFunnel(port).catch((err) => {
  console.warn("[server] Tailscale Funnel restoration failed:", err);
});

// ── Update checker ──────────────────────────────────────────────────────────
startPeriodicCheck();
if (isRunningAsService()) {
  setServiceMode(true);
  console.log("[server] Running as background service (auto-update available)");
}

// ── Runtime diagnostics ──────────────────────────────────────────────────────
import { log } from "./logger.js";
import { metricsCollector } from "./metrics-collector.js";

const DIAGNOSTICS_INTERVAL_MS = 5 * 60_000; // every 5 minutes
setInterval(() => {
  const snap = metricsCollector.getSnapshot(wsBridge);
  const mem = snap.gauges.memory;
  const mb = (bytes: number) => (bytes / 1024 / 1024).toFixed(1);
  const sessionStats = wsBridge.getSessionMemoryStats();
  const topSessions = sessionStats
    .sort((a, b) => b.historyLen - a.historyLen)
    .slice(0, 3)
    .map((s) => `${s.id.slice(0, 8)}(h=${s.historyLen},b=${s.browsers})`)
    .join(", ");

  log.info("diagnostics", "Runtime snapshot", {
    rss: `${mb(mem.rss)}MB`,
    heap: `${mb(mem.heapUsed)}/${mb(mem.heapTotal)}MB`,
    external: `${mb(mem.external)}MB`,
    sessions: snap.gauges.totalActiveSessions,
    browsers: snap.gauges.connectedBrowsers,
    historyMsgs: snap.gauges.totalHistoryMessages,
    pendingMsgs: snap.gauges.totalPendingMessages,
    eventBuffer: snap.gauges.totalEventBufferSize,
    errors: Object.values(snap.counters.errors).reduce((a, b) => a + b, 0),
    topSessions: topSessions || "none",
  });
}, DIAGNOSTICS_INTERVAL_MS);

// ── Graceful shutdown — persist container state ──────────────────────────────
function gracefulShutdown() {
  console.log("[server] Persisting container state before shutdown...");
  containerManager.persistState(CONTAINER_STATE_PATH);
  cleanupTailscaleFunnel(port);
  closeLogFile();
  process.exit(0);
}
process.on("SIGTERM", gracefulShutdown);
process.on("SIGINT", gracefulShutdown);

