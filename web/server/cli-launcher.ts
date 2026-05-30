import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  existsSync,
  copyFileSync,
  cpSync,
  realpathSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Subprocess } from "bun";
import type { SessionStore } from "./session-store.js";
import type { BackendType } from "./session-types.js";
import type { RecorderManager } from "./recorder.js";
import { CodexAdapter } from "./codex-adapter.js";
import { resolveBinary, getEnrichedPath } from "./path-resolver.js";
import { containerManager } from "./container-manager.js";
import { companionBus } from "./event-bus.js";
import {
  getLegacyCodexHome,
  resolveCompanionCodexSessionHome,
} from "./codex-home.js";

/** Whether WebSocket transport is enabled for Codex sessions. */
function isCodexWsTransportEnabled(): boolean {
  const val = (process.env.COMPANION_CODEX_TRANSPORT || "ws").toLowerCase();
  return val === "ws" || val === "websocket";
}

/** Find a free TCP port in the given range by attempting to listen on each. */
async function findFreePort(
  start = 4500,
  end = 4600,
  isReserved?: (port: number) => boolean,
): Promise<number> {
  for (let port = start; port <= end; port++) {
    if (isReserved?.(port)) continue;
    try {
      const server = Bun.listen({
        hostname: "127.0.0.1",
        port,
        socket: {
          data() {},
          open() {},
          close() {},
        },
      });
      server.stop(true);
      return port;
    } catch {
      // Port in use, try next
    }
  }
  throw new Error(`No free port found in range ${start}-${end}`);
}

function sanitizeSpawnArgsForLog(args: string[]): string {
  const secretKeyPattern = /(token|key|secret|password)/i;
  const out = [...args];
  for (let i = 0; i < out.length; i++) {
    if (out[i] === "-e" && i + 1 < out.length) {
      const envPair = out[i + 1];
      const eqIdx = envPair.indexOf("=");
      if (eqIdx > 0) {
        const k = envPair.slice(0, eqIdx);
        if (secretKeyPattern.test(k)) {
          out[i + 1] = `${k}=***`;
        }
      }
    }
  }
  return out.join(" ");
}

const CODEX_WS_PROXY_PATH = fileURLToPath(new URL("./codex-ws-proxy.cjs", import.meta.url));
const CODEX_CONTAINER_WS_PORT = Number(process.env.COMPANION_CODEX_CONTAINER_WS_PORT || "4502");

export interface SdkSessionInfo {
  sessionId: string;
  pid?: number;
  state: "starting" | "connected" | "running" | "exited";
  exitCode?: number | null;
  model?: string;
  permissionMode?: string;
  cwd: string;
  createdAt: number;
  /** The CLI's internal session ID (from system.init), used for --resume */
  cliSessionId?: string;
  archived?: boolean;
  /** User-facing session name */
  name?: string;
  /** Which backend this session uses */
  backendType?: BackendType;
  /** Git branch from bridge state (enriched by REST API) */
  gitBranch?: string;
  /** Git ahead count (enriched by REST API) */
  gitAhead?: number;
  /** Git behind count (enriched by REST API) */
  gitBehind?: number;
  /** Total lines added (enriched by REST API) */
  totalLinesAdded?: number;
  /** Total lines removed (enriched by REST API) */
  totalLinesRemoved?: number;
  /** Whether internet/web search is enabled for Codex sessions */
  codexInternetAccess?: boolean;
  /** Sandbox mode selected for Codex sessions */
  codexSandbox?: "workspace-write" | "danger-full-access";
  /** If this session was spawned by a cron job */
  cronJobId?: string;
  /** Human-readable name of the cron job that spawned this session */
  cronJobName?: string;
  /** If session was created from an existing Claude thread/session. */
  resumeSessionAt?: string;
  /** Whether the resumed session used --fork-session. */
  forkSession?: boolean;
  /** If this session was spawned by an agent */
  agentId?: string;
  /** Human-readable name of the agent that spawned this session */
  agentName?: string;
  /** Sandbox profile slug used for this session */
  sandboxSlug?: string;

  // Codex WebSocket transport fields
  /** Port used for Codex WebSocket transport (host mode). */
  codexWsPort?: number;
  /** Full WebSocket URL for the Codex app-server. */
  codexWsUrl?: string;

  // Container fields
  /** Docker container ID when session runs inside a container */
  containerId?: string;
  /** Docker container name */
  containerName?: string;
  /** Docker image used for the container */
  containerImage?: string;
  /** Runtime cwd inside container for agent RPC calls (e.g. "/workspace"). */
  containerCwd?: string;
}

export interface LaunchOptions {
  model?: string;
  permissionMode?: string;
  cwd?: string;
  claudeBinary?: string;
  codexBinary?: string;
  allowedTools?: string[];
  env?: Record<string, string>;
  backendType?: BackendType;
  /** Codex sandbox mode. */
  codexSandbox?: "workspace-write" | "danger-full-access";
  /** Whether Codex internet/web search should be enabled for this session. */
  codexInternetAccess?: boolean;
  /** Optional override for CODEX_HOME used by Codex sessions. */
  codexHome?: string;
  /** Docker container ID — when set, CLI runs inside container via docker exec */
  containerId?: string;
  /** Docker container name */
  containerName?: string;
  /** Docker image used for the container */
  containerImage?: string;
  /** Runtime cwd inside the container (typically "/workspace"). */
  containerCwd?: string;
  /** Start from a specific prior Claude session/thread point. */
  resumeSessionAt?: string;
  /** Fork a new Claude session when resuming from prior context. */
  forkSession?: boolean;
  /** Optional system prompt to inject into Codex sessions (e.g. Linear context). */
  systemPrompt?: string;
  /** Sandbox profile slug used for this session */
  sandboxSlug?: string;
}

/**
 * Manages CLI backend processes (Claude Code via --sdk-url WebSocket,
 * or Codex via app-server stdio/WebSocket).
 */
export class CliLauncher {
  private sessions = new Map<string, SdkSessionInfo>();
  private processes = new Map<string, Subprocess>();
  /** Sidecar Node proxy processes used by Codex WebSocket transport. */
  private codexWsProxies = new Map<string, Subprocess>();
  /** Host-mode Codex WS listen ports currently reserved by active sessions. */
  private claimedCodexWsPorts = new Set<number>();
  /** Runtime-only env vars per session (kept out of persisted launcher state). */
  private sessionEnvs = new Map<string, Record<string, string>>();
  private port: number;
  private store: SessionStore | null = null;
  private recorder: RecorderManager | null = null;
  constructor(port: number) {
    this.port = port;
  }

  /** Attach a persistent store for surviving server restarts. */
  setStore(store: SessionStore): void {
    this.store = store;
  }

  /** Attach a recorder for raw message capture. */
  setRecorder(recorder: RecorderManager): void {
    this.recorder = recorder;
  }

  /** Persist launcher state to disk. */
  private persistState(): void {
    if (!this.store) return;
    const data = Array.from(this.sessions.values());
    this.store.saveLauncher(data);
  }

  private claimCodexWsPort(port: number): void {
    this.claimedCodexWsPorts.add(port);
  }

  private releaseCodexWsPort(info: SdkSessionInfo | undefined): void {
    if (!info || info.containerId) return;
    if (typeof info.codexWsPort !== "number") return;
    this.claimedCodexWsPorts.delete(info.codexWsPort);
    info.codexWsPort = undefined;
    info.codexWsUrl = undefined;
  }

  /**
   * Restore sessions from disk and check which PIDs are still alive.
   * Returns the number of recovered sessions.
   */
  restoreFromDisk(): number {
    if (!this.store) return 0;
    const data = this.store.loadLauncher<SdkSessionInfo[]>();
    if (!data || !Array.isArray(data)) return 0;

    let recovered = 0;
    for (const info of data) {
      if (this.sessions.has(info.sessionId)) continue;

      // Check if the process is still alive
      if (info.state !== "exited") {
        if (info.containerId && info.codexWsPort) {
          // Docker WS mode: the stored PID is `docker exec -d` which exits
          // immediately after launch.  Check container liveness instead.
          const containerState = containerManager.isContainerAlive(info.containerId);
          if (containerState === "running") {
            info.state = "starting";
            this.sessions.set(info.sessionId, info);
            recovered++;
          } else {
            info.state = "exited";
            info.exitCode = -1;
            this.sessions.set(info.sessionId, info);
          }
        } else if (info.pid) {
          try {
            process.kill(info.pid, 0); // signal 0 = just check if alive
            info.state = "starting"; // WS not yet re-established, wait for CLI to reconnect
            this.sessions.set(info.sessionId, info);
            recovered++;
          } catch {
            // Process is dead
            info.state = "exited";
            info.exitCode = -1;
            this.sessions.set(info.sessionId, info);
          }
        } else {
          this.sessions.set(info.sessionId, info);
        }
      } else {
        // Already exited
        this.sessions.set(info.sessionId, info);
      }

      // Avoid reusing ports already owned by recovered host-mode Codex sessions.
      if (
        info.backendType === "codex"
        && !info.containerId
        && info.state !== "exited"
        && typeof info.codexWsPort === "number"
      ) {
        this.claimCodexWsPort(info.codexWsPort);
      }
    }
    if (recovered > 0) {
      console.log(`[cli-launcher] Recovered ${recovered} live session(s) from disk`);
    }
    return recovered;
  }

  /**
   * Launch a new CLI session (Claude Code or Codex).
   */
  launch(options: LaunchOptions = {}): SdkSessionInfo {
    const sessionId = randomUUID();
    const cwd = options.cwd || process.cwd();
    const backendType = options.backendType || "claude";

    const info: SdkSessionInfo = {
      sessionId,
      state: "starting",
      model: options.model,
      permissionMode: options.permissionMode,
      cwd,
      createdAt: Date.now(),
      backendType,
    };

    if (options.resumeSessionAt) {
      info.resumeSessionAt = options.resumeSessionAt;
      info.forkSession = options.forkSession === true;
    }

    if (backendType === "codex") {
      info.codexInternetAccess = options.codexInternetAccess === true;
      info.codexSandbox = options.codexSandbox;
    }

    // Store sandbox slug if provided
    if (options.sandboxSlug) {
      info.sandboxSlug = options.sandboxSlug;
    }

    // Store container metadata if provided
    if (options.containerId) {
      info.containerId = options.containerId;
      info.containerName = options.containerName;
      info.containerImage = options.containerImage;
      info.containerCwd = options.containerCwd || "/workspace";
    }

    this.sessions.set(sessionId, info);
    if (options.env) {
      this.sessionEnvs.set(sessionId, { ...options.env });
    }

    if (backendType === "codex") {
      this.spawnCodex(sessionId, info, options);
    } else {
      this.spawnCLI(sessionId, info, options);
    }
    return info;
  }

  /**
   * Relaunch a CLI process for an existing session.
   * Kills the old process if still alive, then spawns a fresh CLI
   * that connects back to the same session in the WsBridge.
   */
  async relaunch(sessionId: string): Promise<{ ok: boolean; error?: string }> {
    const info = this.sessions.get(sessionId);
    if (!info) return { ok: false, error: "Session not found" };

    // Kill old process(es) if still alive.
    // Snapshot both handles first because killing the proxy can trigger the
    // WS session exit handler, which clears `this.processes`.
    const oldProc = this.processes.get(sessionId);
    const oldProxy = this.codexWsProxies.get(sessionId);
    if (oldProxy) {
      try {
        oldProxy.kill("SIGTERM");
        await Promise.race([
          oldProxy.exited,
          new Promise((r) => setTimeout(r, 2000)),
        ]);
      } catch {}
      this.codexWsProxies.delete(sessionId);
    }
    if (oldProc) {
      try {
        oldProc.kill("SIGTERM");
        await Promise.race([
          oldProc.exited,
          new Promise((r) => setTimeout(r, 2000)),
        ]);
      } catch {}
      this.processes.delete(sessionId);
    } else if (info.pid) {
      // Process from a previous server instance — kill by PID
      try { process.kill(info.pid, "SIGTERM"); } catch {}
    }

    // Release any host-mode Codex port claim before picking a new one.
    this.releaseCodexWsPort(info);

    // Pre-flight validation for containerized sessions
    if (info.containerId) {
      const containerLabel = info.containerName || info.containerId.slice(0, 12);
      const containerState = containerManager.isContainerAlive(info.containerId);

      if (containerState === "missing") {
        console.error(`[cli-launcher] Container ${containerLabel} no longer exists for session ${sessionId}`);
        info.state = "exited";
        info.exitCode = 1;
        this.persistState();
        return {
          ok: false,
          error: `Container "${containerLabel}" was removed externally. Please create a new session.`,
        };
      }

      if (containerState === "stopped") {
        try {
          containerManager.startContainer(info.containerId);
          console.log(`[cli-launcher] Restarted stopped container ${containerLabel} for session ${sessionId}`);
        } catch (e) {
          info.state = "exited";
          info.exitCode = 1;
          this.persistState();
          return {
            ok: false,
            error: `Container "${containerLabel}" is stopped and could not be restarted: ${e instanceof Error ? e.message : String(e)}`,
          };
        }
      }

      // Validate the CLI binary exists inside the container
      const binary = info.backendType === "codex" ? "codex" : "claude";
      if (!containerManager.hasBinaryInContainer(info.containerId, binary)) {
        console.error(`[cli-launcher] "${binary}" not found in container ${containerLabel} for session ${sessionId}`);
        info.state = "exited";
        info.exitCode = 127;
        this.persistState();
        return {
          ok: false,
          error: `"${binary}" command not found inside container "${containerLabel}". The container image may need to be rebuilt.`,
        };
      }
    }

    info.state = "starting";

    const runtimeEnv = this.sessionEnvs.get(sessionId);

    if (info.backendType === "codex") {
      this.spawnCodex(sessionId, info, {
        model: info.model,
        permissionMode: info.permissionMode,
        cwd: info.cwd,
        codexSandbox: info.codexSandbox,
        codexInternetAccess: info.codexInternetAccess,
        containerId: info.containerId,
        containerName: info.containerName,
        containerImage: info.containerImage,
        containerCwd: info.containerCwd,
        env: runtimeEnv,
      });
    } else {
      this.spawnCLI(sessionId, info, {
        model: info.model,
        permissionMode: info.permissionMode,
        cwd: info.cwd,
        resumeSessionId: info.cliSessionId,
        containerId: info.containerId,
        containerName: info.containerName,
        containerImage: info.containerImage,
        env: runtimeEnv,
      });
    }
    return { ok: true };
  }

  /**
   * Get all sessions in "starting" state (awaiting CLI WebSocket connection).
   */
  getStartingSessions(): SdkSessionInfo[] {
    return Array.from(this.sessions.values()).filter((s) => s.state === "starting");
  }

  private spawnCLI(sessionId: string, info: SdkSessionInfo, options: LaunchOptions & { resumeSessionId?: string }): void {
    const isContainerized = !!options.containerId;

    // For containerized sessions, the CLI binary lives inside the container.
    // For host sessions, resolve the binary on the host.
    let binary = options.claudeBinary || "claude";
    if (!isContainerized) {
      const resolved = resolveBinary(binary);
      if (resolved) {
        binary = resolved;
      } else {
        console.error(`[cli-launcher] Binary "${binary}" not found in PATH`);
        info.state = "exited";
        info.exitCode = 127;
        this.persistState();
        return;
      }
    }

    // Allow overriding the host alias used by containerized Claude sessions.
    // Useful when host.docker.internal is unavailable in a given Docker setup.
    const containerSdkHost = (process.env.COMPANION_CONTAINER_SDK_HOST || "host.docker.internal").trim()
      || "host.docker.internal";

    // When running inside a container, the SDK URL should target the host alias
    // so the CLI can connect back to the Hono server running on the host.
    const sdkUrl = isContainerized
      ? `ws://${containerSdkHost}:${this.port}/ws/cli/${sessionId}`
      : `ws://localhost:${this.port}/ws/cli/${sessionId}`;

    // Containers ARE the sandbox — bypass is the correct default. Only
    // downgrade host sessions running as root (Claude Code rejects
    // bypassPermissions under root/sudo).
    let effectivePermissionMode = options.permissionMode;
    const isRootProcess = typeof process.getuid === "function" && process.getuid() === 0;
    const shouldDowngradeRootBypass =
      !isContainerized
      && isRootProcess
      && options.permissionMode === "bypassPermissions"
      && process.env.COMPANION_FORCE_BYPASS_AS_ROOT !== "1";

    if (shouldDowngradeRootBypass) {
      console.warn(
        `[cli-launcher] Session ${sessionId}: downgrading root permission mode ` +
        `from bypassPermissions to acceptEdits.`,
      );
      effectivePermissionMode = "acceptEdits";
      info.permissionMode = "acceptEdits";
    }

    const args: string[] = [
      "--sdk-url", sdkUrl,
      "--print",
      "--output-format", "stream-json",
      "--input-format", "stream-json",
      // Required on newer Claude Code versions to emit streaming chunk events.
      "--include-partial-messages",
      "--verbose",
    ];

    if (options.model) {
      args.push("--model", options.model);
    }
    if (effectivePermissionMode) {
      args.push("--permission-mode", effectivePermissionMode);
    }
    if (options.allowedTools) {
      for (const tool of options.allowedTools) {
        args.push("--allowedTools", tool);
      }
    }
    if (options.resumeSessionAt) {
      args.push("--resume-session-at", options.resumeSessionAt);
    }
    if (options.forkSession) {
      args.push("--fork-session");
    }

    // Always pass -p "" for headless mode. When relaunching, also pass --resume
    // to restore the CLI's conversation context.
    if (options.resumeSessionId) {
      args.push("--resume", options.resumeSessionId);
    }

    args.push("-p", "");

    let spawnCmd: string[];
    let spawnEnv: Record<string, string | undefined>;
    let spawnCwd: string | undefined;

    if (isContainerized) {
      // Run CLI inside the container via docker exec -i.
      // Keeping stdin open avoids premature EOF-driven exits in SDK mode.
      // Environment variables are passed via -e flags to docker exec.
      const dockerArgs = ["docker", "exec", "-i"];

      // Pass env vars via -e flags
      if (options.env) {
        for (const [k, v] of Object.entries(options.env)) {
          dockerArgs.push("-e", `${k}=${v}`);
        }
      }
      // Ensure CLAUDECODE is unset inside container
      dockerArgs.push("-e", "CLAUDECODE=");

      dockerArgs.push(options.containerId!);
      // Use a login shell so ~/.bashrc is sourced and nvm/bun/deno/etc are on PATH
      const innerCmd = [binary, ...args].map(a => `'${a.replace(/'/g, "'\\''")}'`).join(" ");
      dockerArgs.push("bash", "-lc", innerCmd);

      spawnCmd = dockerArgs;
      // Host env for the docker CLI itself
      spawnEnv = { ...process.env, PATH: getEnrichedPath() };
      spawnCwd = undefined; // cwd is set inside the container via -w at creation
    } else {
      // Host-based spawn (original behavior)
      // On Windows, .cmd/.bat files cannot be spawned directly by Bun.spawn;
      // they must be invoked via cmd.exe /c.
      const isCmdScript = process.platform === "win32" && (binary.endsWith(".cmd") || binary.endsWith(".bat"));
      spawnCmd = isCmdScript ? ["cmd.exe", "/c", binary, ...args] : [binary, ...args];
      spawnEnv = {
        ...process.env,
        CLAUDECODE: undefined,
        ...options.env,
        PATH: getEnrichedPath(),
      };
      spawnCwd = info.cwd;
    }

    console.log(
      `[cli-launcher] Spawning session ${sessionId}${isContainerized ? " (container)" : ""}: ` +
      sanitizeSpawnArgsForLog(spawnCmd),
    );

    const proc = Bun.spawn(spawnCmd, {
      cwd: spawnCwd,
      env: spawnEnv,
      stdout: "pipe",
      stderr: "pipe",
    });

    info.pid = proc.pid;
    this.processes.set(sessionId, proc);

    // Stream stdout/stderr for debugging
    this.pipeOutput(sessionId, proc);

    // Monitor process exit
    const spawnedAt = Date.now();
    proc.exited.then((exitCode) => {
      console.log(`[cli-launcher] Session ${sessionId} exited (code=${exitCode})`);
      const session = this.sessions.get(sessionId);
      if (session) {
        session.state = "exited";
        session.exitCode = exitCode;

        // If the process exited almost immediately with --resume, the resume likely failed.
        // Clear cliSessionId so the next relaunch starts fresh.
        const uptime = Date.now() - spawnedAt;
        if (uptime < 5000 && options.resumeSessionId) {
          console.error(`[cli-launcher] Session ${sessionId} exited immediately after --resume (${uptime}ms). Clearing cliSessionId for fresh start.`);
          session.cliSessionId = undefined;
        }
      }
      this.processes.delete(sessionId);
      this.persistState();
      companionBus.emit("session:exited", { sessionId, exitCode });
    });

    this.persistState();
  }

  /**
   * Spawn a Codex app-server subprocess for a session.
   * Transport (stdio vs WebSocket) is selected by `COMPANION_CODEX_TRANSPORT`.
   */
  private prepareCodexHome(codexHome: string): void {
    mkdirSync(codexHome, { recursive: true });

    const legacyHome = getLegacyCodexHome();
    if (resolve(legacyHome) === resolve(codexHome) || !existsSync(legacyHome)) {
      return;
    }

    // Bootstrap only the user-level artifacts Codex needs (auth/config/skills),
    // while intentionally skipping sessions/sqlite to avoid stale rollout indexes.
    const fileSeeds = ["auth.json", "config.toml", "models_cache.json", "version.json"];
    for (const name of fileSeeds) {
      try {
        const src = join(legacyHome, name);
        const dest = join(codexHome, name);
        if (!existsSync(dest) && existsSync(src)) {
          copyFileSync(src, dest);
        }
      } catch (e) {
        console.warn(`[cli-launcher] Failed to bootstrap ${name} from legacy home:`, e);
      }
    }

    const dirSeeds = ["skills", "vendor_imports", "prompts", "rules"];
    for (const name of dirSeeds) {
      try {
        const src = join(legacyHome, name);
        const dest = join(codexHome, name);
        if (!existsSync(dest) && existsSync(src)) {
          cpSync(src, dest, { recursive: true, dereference: true });
        }
      } catch (e) {
        console.warn(`[cli-launcher] Failed to bootstrap ${name}/ from legacy home:`, e);
      }
    }
  }

  private spawnCodex(sessionId: string, info: SdkSessionInfo, options: LaunchOptions): void {
    const useWs = isCodexWsTransportEnabled();
    if (useWs) {
      this.spawnCodexWs(sessionId, info, options);
    } else {
      this.spawnCodexStdio(sessionId, info, options);
    }
  }

  /**
   * Spawn Codex with WebSocket transport.
   * Codex listens on `ws://127.0.0.1:PORT`, Companion connects as a client.
   */
  private async spawnCodexWs(sessionId: string, info: SdkSessionInfo, options: LaunchOptions): Promise<void> {
    const isContainerized = !!options.containerId;
    const connectTimeoutMs = Math.max(1000, parseInt(process.env.COMPANION_CODEX_WS_CONNECT_TIMEOUT_MS ?? "", 10) || 30000);
    const pongTimeoutMs = Math.max(1000, parseInt(process.env.COMPANION_CODEX_PONG_TIMEOUT_MS ?? "", 10) || 30000);

    let binary = options.codexBinary || "codex";
    if (!isContainerized) {
      const resolved = resolveBinary(binary);
      if (resolved) {
        binary = resolved;
      } else {
        console.error(`[cli-launcher] Binary "${binary}" not found in PATH`);
        info.state = "exited";
        info.exitCode = 127;
        this.persistState();
        return;
      }
    }

    // Host mode: choose a free host port. Container mode: use a fixed container port
    // and connect via the container's mapped host port.
    let codexListenPort: number;
    let proxyConnectPort: number;
    if (isContainerized) {
      codexListenPort = CODEX_CONTAINER_WS_PORT;
      const containerInfo = containerManager.getContainerById(options.containerId!);
      const mappedPort = containerInfo?.portMappings.find((p) => p.containerPort === CODEX_CONTAINER_WS_PORT)?.hostPort;
      if (!mappedPort) {
        console.error(
          `[cli-launcher] Missing port mapping for Codex container port ${CODEX_CONTAINER_WS_PORT} ` +
          `on container ${options.containerId}`,
        );
        info.state = "exited";
        info.exitCode = 1;
        this.persistState();
        return;
      }
      proxyConnectPort = mappedPort;
    } else {
      try {
        proxyConnectPort = await findFreePort(
          4500,
          4600,
          (port) => this.claimedCodexWsPorts.has(port),
        );
        this.claimCodexWsPort(proxyConnectPort);
        // Set immediately after claiming so any downstream failure can release it.
        info.codexWsPort = proxyConnectPort;
      } catch (err) {
        console.error(`[cli-launcher] Failed to find free port for Codex WS: ${err}`);
        info.state = "exited";
        info.exitCode = 1;
        this.persistState();
        return;
      }
      codexListenPort = proxyConnectPort;
    }

    const listenAddr = isContainerized
      ? `ws://0.0.0.0:${codexListenPort}`
      : `ws://127.0.0.1:${codexListenPort}`;

    const args: string[] = ["app-server", "--listen", listenAddr];
    // Enable Codex multi-agent mode by default (product decision).
    args.push("--enable", "multi_agent");
    const internetEnabled = options.codexInternetAccess !== false;
    args.push("-c", `tools.webSearch=${internetEnabled ? "true" : "false"}`);
    const codexHome = resolveCompanionCodexSessionHome(
      sessionId,
      options.codexHome,
    );
    if (!isContainerized) {
      this.prepareCodexHome(codexHome);
    }

    let spawnCmd: string[];
    let spawnEnv: Record<string, string | undefined>;
    let spawnCwd: string | undefined;

    if (isContainerized) {
      // Run Codex inside the container via docker exec -d (detached, no stdin pipe needed)
      const dockerArgs = ["docker", "exec", "-d"];
      if (options.env) {
        for (const [k, v] of Object.entries(options.env)) {
          dockerArgs.push("-e", `${k}=${v}`);
        }
      }
      dockerArgs.push("-e", "CLAUDECODE=");
      dockerArgs.push("-e", "CODEX_HOME=/root/.codex");
      dockerArgs.push(options.containerId!);
      const innerCmd = [binary, ...args].map(a => `'${a.replace(/'/g, "'\\''")}'`).join(" ");
      dockerArgs.push("bash", "-lc", innerCmd);

      spawnCmd = dockerArgs;
      spawnEnv = { ...process.env, PATH: getEnrichedPath() };
      spawnCwd = undefined;
    } else {
      const binaryDir = resolve(binary, "..");
      const siblingNode = join(binaryDir, "node");
      const enrichedPath = getEnrichedPath();
      const pathSep = process.platform === "win32" ? ";" : ":";
      const spawnPath = [binaryDir, ...enrichedPath.split(pathSep)].filter(Boolean).join(pathSep);

      if (existsSync(siblingNode)) {
        let codexScript: string;
        try {
          codexScript = realpathSync(binary);
        } catch {
          codexScript = binary;
        }
        spawnCmd = [siblingNode, codexScript, ...args];
      } else {
        // On Windows, .cmd/.bat files cannot be spawned directly by Bun.spawn
        const isCmdScript = process.platform === "win32" && (binary.endsWith(".cmd") || binary.endsWith(".bat"));
        spawnCmd = isCmdScript ? ["cmd.exe", "/c", binary, ...args] : [binary, ...args];
      }

      spawnEnv = {
        ...process.env,
        CLAUDECODE: undefined,
        ...options.env,
        CODEX_HOME: codexHome,
        PATH: spawnPath,
      };
      spawnCwd = info.cwd;
    }

    console.log(
      `[cli-launcher] Spawning Codex WS session ${sessionId}${isContainerized ? " (container)" : ""}: ` +
      sanitizeSpawnArgsForLog(spawnCmd),
    );

    const proc = Bun.spawn(spawnCmd, {
      cwd: spawnCwd,
      env: spawnEnv,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });

    info.pid = proc.pid;
    this.processes.set(sessionId, proc);

    // Pipe stdout/stderr for debugging (JSON-RPC goes over WebSocket now)
    this.pipeOutput(sessionId, proc);

    // Store WS metadata
    const wsUrl = `ws://127.0.0.1:${proxyConnectPort}`;
    if (typeof info.codexWsPort !== "number") {
      info.codexWsPort = proxyConnectPort;
    }
    info.codexWsUrl = wsUrl;

    // Connect to Codex app-server through a Node helper process that uses the
    // `ws` package directly (with perMessageDeflate disabled). This avoids a Bun
    // runtime compatibility issue where the `ws` client can mis-handle a valid
    // 101 upgrade response from Codex's Rust WS server.
    const codexBinaryDir = isContainerized ? undefined : resolve(binary, "..");
    const proxyNodeCandidate = codexBinaryDir ? join(codexBinaryDir, "node") : undefined;
    const proxyNode = proxyNodeCandidate && existsSync(proxyNodeCandidate) ? proxyNodeCandidate : "node";
    const proxyProc = Bun.spawn([proxyNode, CODEX_WS_PROXY_PATH, wsUrl, String(connectTimeoutMs), String(pongTimeoutMs)], {
      cwd: info.cwd,
      env: {
        ...process.env,
        PATH: getEnrichedPath(),
      },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    this.codexWsProxies.set(sessionId, proxyProc);
    // proxy stdout is the JSON-RPC protocol stream (consumed by CodexAdapter).
    // Only pipe stderr for diagnostics to avoid locking stdout.
    const proxyStderr = proxyProc.stderr;
    if (proxyStderr && typeof proxyStderr !== "number") {
      this.pipeStream(sessionId, proxyStderr, "stderr");
    }

    // Create CodexAdapter using stdio transport to the proxy process.
    const adapter = new CodexAdapter(proxyProc, sessionId, {
      model: options.model,
      cwd: info.cwd,
      executionCwd: options.containerId ? (info.containerCwd || "/workspace") : info.cwd,
      approvalMode: options.permissionMode,
      threadId: info.cliSessionId,
      sandbox: options.codexSandbox,
      recorder: this.recorder ?? undefined,
      systemPrompt: options.systemPrompt,
      killProcess: async () => {
        try {
          proxyProc.kill("SIGTERM");
        } catch {}
        try {
          proc.kill("SIGTERM");
        } catch {}
        await Promise.race([
          Promise.allSettled([proxyProc.exited, proc.exited]),
          new Promise((r) => setTimeout(r, 5000)),
        ]);
      },
    });

    // Handle init errors
    adapter.onInitError((error) => {
      console.error(`[cli-launcher] Codex WS session ${sessionId} init failed: ${error}`);
      try { proxyProc.kill("SIGTERM"); } catch {}
      this.codexWsProxies.delete(sessionId);
      const session = this.sessions.get(sessionId);
      if (session) {
        session.state = "exited";
        session.exitCode = 1;
        session.cliSessionId = undefined;
        this.releaseCodexWsPort(session);
      }
      this.persistState();
    });

    // Notify the WsBridge to attach this adapter
    companionBus.emit("backend:codex-adapter-created", { sessionId, adapter });

    info.state = "connected";

    // Monitor the proxy connection process as the primary transport liveness.
    // In container mode, `docker exec -d` exits immediately after launching Codex
    // and must not be treated as the backend process lifetime.
    let exitHandled = false;
    const handleWsSessionExit = (exitCode: number | null, source: "proxy" | "codex") => {
      if (exitHandled) return;
      exitHandled = true;
      console.log(`[cli-launcher] Codex WS session ${sessionId} exited via ${source} (code=${exitCode})`);

      // Notify the adapter that the transport is gone so it can clean up
      // pending promises and stop accepting messages immediately.
      adapter.handleTransportClose();

      // Kill the other process too — if the proxy exits, kill Codex and vice versa.
      // This prevents orphaned processes lingering after a partial crash.
      // Note: The SIGTERM will cause the sibling to exit, which fires its own
      // exit handler, but the `exitHandled` guard above ensures it's a no-op.
      if (source === "proxy") {
        try { proc.kill("SIGTERM"); } catch {}
      } else {
        try { proxyProc.kill("SIGTERM"); } catch {}
      }

      const session = this.sessions.get(sessionId);
      if (session) {
        session.state = "exited";
        session.exitCode = exitCode;
        this.releaseCodexWsPort(session);
      }
      this.processes.delete(sessionId);
      this.codexWsProxies.delete(sessionId);
      this.persistState();
      companionBus.emit("session:exited", { sessionId, exitCode });
    };

    proxyProc.exited.then((exitCode) => {
      handleWsSessionExit(exitCode, "proxy");
    });

    if (!isContainerized) {
      proc.exited.then((exitCode) => {
        handleWsSessionExit(exitCode, "codex");
      });
    } else {
      proc.exited.then((exitCode) => {
        // `docker exec -d` exits immediately after launch in container WS mode.
        // Suppress the expected success case to avoid noisy logs; keep non-zero exits.
        if (exitCode !== 0) {
          console.warn(`[cli-launcher] Codex WS launcher command for ${sessionId} exited (code=${exitCode})`);
        }
      });
    }

    this.persistState();
  }

  /**
   * Spawn Codex with stdio transport (legacy).
   * Unlike Claude Code (which connects back via WebSocket), Codex uses stdin/stdout.
   */
  private spawnCodexStdio(sessionId: string, info: SdkSessionInfo, options: LaunchOptions): void {
    const isContainerized = !!options.containerId;

    let binary = options.codexBinary || "codex";
    if (!isContainerized) {
      const resolved = resolveBinary(binary);
      if (resolved) {
        binary = resolved;
      } else {
        console.error(`[cli-launcher] Binary "${binary}" not found in PATH`);
        info.state = "exited";
        info.exitCode = 127;
        this.persistState();
        return;
      }
    }

    const args: string[] = ["app-server"];
    // Enable Codex multi-agent mode by default (product decision).
    args.push("--enable", "multi_agent");
    const internetEnabled = options.codexInternetAccess !== false;
    args.push("-c", `tools.webSearch=${internetEnabled ? "true" : "false"}`);
    const codexHome = resolveCompanionCodexSessionHome(
      sessionId,
      options.codexHome,
    );
    if (!isContainerized) {
      this.prepareCodexHome(codexHome);
    }

    let spawnCmd: string[];
    let spawnEnv: Record<string, string | undefined>;
    let spawnCwd: string | undefined;

    if (isContainerized) {
      // Run Codex inside the container via docker exec -i (stdin required for JSON-RPC)
      const dockerArgs = ["docker", "exec", "-i"];
      if (options.env) {
        for (const [k, v] of Object.entries(options.env)) {
          dockerArgs.push("-e", `${k}=${v}`);
        }
      }
      dockerArgs.push("-e", "CLAUDECODE=");
      // Point Codex at /root/.codex where container-manager seeded auth/config
      dockerArgs.push("-e", "CODEX_HOME=/root/.codex");
      dockerArgs.push(options.containerId!);
      // Use a login shell so ~/.bashrc is sourced and nvm/bun/deno/etc are on PATH
      const innerCmd = [binary, ...args].map(a => `'${a.replace(/'/g, "'\\''")}'`).join(" ");
      dockerArgs.push("bash", "-lc", innerCmd);

      spawnCmd = dockerArgs;
      spawnEnv = { ...process.env, PATH: getEnrichedPath() };
      spawnCwd = undefined;
    } else {
      // Host-based spawn — resolve node/shebang issues
      const binaryDir = resolve(binary, "..");
      const siblingNode = join(binaryDir, "node");
      const enrichedPath = getEnrichedPath();
      const pathSep = process.platform === "win32" ? ";" : ":";
      const spawnPath = [binaryDir, ...enrichedPath.split(pathSep)].filter(Boolean).join(pathSep);

      if (existsSync(siblingNode)) {
        let codexScript: string;
        try {
          codexScript = realpathSync(binary);
        } catch {
          codexScript = binary;
        }
        spawnCmd = [siblingNode, codexScript, ...args];
      } else {
        // On Windows, .cmd/.bat files cannot be spawned directly by Bun.spawn
        const isCmdScript = process.platform === "win32" && (binary.endsWith(".cmd") || binary.endsWith(".bat"));
        spawnCmd = isCmdScript ? ["cmd.exe", "/c", binary, ...args] : [binary, ...args];
      }

      spawnEnv = {
        ...process.env,
        CLAUDECODE: undefined,
        ...options.env,
        CODEX_HOME: codexHome,
        PATH: spawnPath,
      };
      spawnCwd = info.cwd;
    }

    console.log(
      `[cli-launcher] Spawning Codex session ${sessionId}${isContainerized ? " (container)" : ""}: ` +
      sanitizeSpawnArgsForLog(spawnCmd),
    );

    const proc = Bun.spawn(spawnCmd, {
      cwd: spawnCwd,
      env: spawnEnv,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });

    info.pid = proc.pid;
    this.processes.set(sessionId, proc);

    // Pipe stderr for debugging (stdout is used for JSON-RPC)
    const stderr = proc.stderr;
    if (stderr && typeof stderr !== "number") {
      this.pipeStream(sessionId, stderr, "stderr");
    }

    // Create the CodexAdapter which handles JSON-RPC and message translation
    // Pass the raw permission mode — the adapter maps it to Codex's approval policy
    const adapter = new CodexAdapter(proc, sessionId, {
      model: options.model,
      cwd: info.cwd,
      executionCwd: options.containerId ? (info.containerCwd || "/workspace") : info.cwd,
      approvalMode: options.permissionMode,
      threadId: info.cliSessionId,
      sandbox: options.codexSandbox,
      recorder: this.recorder ?? undefined,
      systemPrompt: options.systemPrompt,
    });

    // Handle init errors — mark session as exited so UI shows failure.
    // Also clear cliSessionId so the next relaunch starts a fresh thread
    // instead of trying to resume one whose rollout may be missing.
    adapter.onInitError((error) => {
      console.error(`[cli-launcher] Codex session ${sessionId} init failed: ${error}`);
      const session = this.sessions.get(sessionId);
      if (session) {
        session.state = "exited";
        session.exitCode = 1;
        session.cliSessionId = undefined;
      }
      this.persistState();
    });

    // Notify the WsBridge to attach this adapter
    companionBus.emit("backend:codex-adapter-created", { sessionId, adapter });

    // Mark as connected immediately (no WS handshake needed for stdio)
    info.state = "connected";

    // Monitor process exit
    proc.exited.then((exitCode) => {
      console.log(`[cli-launcher] Codex session ${sessionId} exited (code=${exitCode})`);
      const session = this.sessions.get(sessionId);
      if (session) {
        session.state = "exited";
        session.exitCode = exitCode;
      }
      this.processes.delete(sessionId);
      this.persistState();
      companionBus.emit("session:exited", { sessionId, exitCode });
    });

    this.persistState();
  }

  /**
   * Mark a session as connected (called when CLI establishes WS connection).
   */
  markConnected(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session && (session.state === "starting" || session.state === "connected")) {
      session.state = "connected";
      console.log(`[cli-launcher] Session ${sessionId} connected via WebSocket`);
      this.persistState();
    }
  }

  /**
   * Store the CLI's internal session ID (from system.init message).
   * This is needed for --resume on relaunch.
   */
  setCLISessionId(sessionId: string, cliSessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.cliSessionId = cliSessionId;
      this.persistState();
    }
  }

  /**
   * Kill a session's CLI process.
   */
  async kill(sessionId: string): Promise<boolean> {
    const proxy = this.codexWsProxies.get(sessionId);
    if (proxy) {
      try { proxy.kill("SIGTERM"); } catch {}
      this.codexWsProxies.delete(sessionId);
    }

    const proc = this.processes.get(sessionId);
    if (!proc) return !!proxy;

    proc.kill("SIGTERM");

    // Wait up to 5s for graceful exit, then force kill
    const exited = await Promise.race([
      proc.exited.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 5_000)),
    ]);

    if (!exited) {
      console.log(`[cli-launcher] Force-killing session ${sessionId}`);
      proc.kill("SIGKILL");
    }

    const session = this.sessions.get(sessionId);
    if (session) {
      session.state = "exited";
      session.exitCode = -1;
      this.releaseCodexWsPort(session);
    }
    this.processes.delete(sessionId);
    this.persistState();
    return true;
  }

  /**
   * List all sessions (active + recently exited).
   */
  listSessions(): SdkSessionInfo[] {
    return Array.from(this.sessions.values());
  }

  /**
   * Get a specific session.
   */
  getSession(sessionId: string): SdkSessionInfo | undefined {
    return this.sessions.get(sessionId);
  }

  /**
   * Check if a session exists and is alive (not exited).
   */
  isAlive(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    return !!session && session.state !== "exited";
  }

  /**
   * Set the archived flag on a session.
   */
  setArchived(sessionId: string, archived: boolean): void {
    const info = this.sessions.get(sessionId);
    if (info) {
      info.archived = archived;
      this.persistState();
    }
  }

  /**
   * Remove a session from the internal map (after kill or cleanup).
   */
  removeSession(sessionId: string) {
    this.releaseCodexWsPort(this.sessions.get(sessionId));
    this.sessions.delete(sessionId);
    this.processes.delete(sessionId);
    this.codexWsProxies.delete(sessionId);
    this.sessionEnvs.delete(sessionId);
    this.persistState();
  }

  /**
   * Remove exited sessions from the list.
   */
  pruneExited(): number {
    let pruned = 0;
    for (const [id, session] of this.sessions) {
      if (session.state === "exited") {
        this.releaseCodexWsPort(session);
        this.sessions.delete(id);
        this.sessionEnvs.delete(id);
        this.codexWsProxies.delete(id);
        pruned++;
      }
    }
    return pruned;
  }

  /**
   * Kill all sessions.
   */
  async killAll(): Promise<void> {
    const ids = [...this.processes.keys()];
    await Promise.all(ids.map((id) => this.kill(id)));
  }

  private async pipeStream(
    sessionId: string,
    stream: ReadableStream<Uint8Array> | null,
    label: "stdout" | "stderr",
  ): Promise<void> {
    if (!stream) return;
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    const log = label === "stdout" ? console.log : console.error;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const text = decoder.decode(value);
        if (text.trim()) {
          log(`[session:${sessionId}:${label}] ${text.trimEnd()}`);
        }
      }
    } catch {
      // stream closed
    }
  }

  private pipeOutput(sessionId: string, proc: Subprocess): void {
    const stdout = proc.stdout;
    const stderr = proc.stderr;
    if (stdout && typeof stdout !== "number") {
      this.pipeStream(sessionId, stdout, "stdout");
    }
    if (stderr && typeof stderr !== "number") {
      this.pipeStream(sessionId, stderr, "stderr");
    }
  }
}
