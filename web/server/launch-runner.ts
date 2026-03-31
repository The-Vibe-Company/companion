/**
 * launch-runner.ts — Execute setup scripts and manage background service
 * processes with dependency-aware startup ordering.
 */

import { spawn, type ChildProcess } from "node:child_process";
import type { ResolvedService, LaunchSetupScript, ResolvedLaunchConfig } from "./launch-config.js";
import { buildStartupOrder } from "./launch-config.js";
import { containerManager } from "./container-manager.js";
import { log } from "./logger.js";
import { companionBus } from "./event-bus.js";

// ── Types ───────────────────────────────────────────────────────────────────

export type ServiceStatus = "starting" | "started" | "ready" | "failed" | "stopped";

export interface ServiceHandle {
  name: string;
  sessionId: string;
  pid: number | undefined;
  port: number | undefined;
  status: ServiceStatus;
  process: ChildProcess | null;
  /** Subscribe to stdout/stderr lines. Returns unsubscribe function. */
  onLine(cb: (line: string) => void): () => void;
  /** Return buffered log history (up to the ring buffer capacity). */
  getHistory(limit?: number): string[];
  kill(): void;
}

export interface RunSetupOpts {
  cwd: string;
  containerId?: string;
  onOutput?: (scriptName: string, line: string) => void;
  timeout?: number; // ms per script, default 120_000
  /** Resolved top-level env vars to merge into all scripts */
  env?: Record<string, string>;
  /** Per-script env overrides keyed by script name */
  perScriptEnv?: Record<string, Record<string, string>>;
}

export interface StartServicesOpts {
  cwd: string;
  containerId?: string;
  sessionId: string;
  onProgress?: (serviceName: string, status: ServiceStatus, detail?: string) => void;
  onOutput?: (serviceName: string, line: string) => void;
  /** Resolved top-level env vars to merge into all services */
  env?: Record<string, string>;
  /** Optional per-service env overrides after top-level env */
  perServiceEnv?: Record<string, Record<string, string>>;
}

// ── Module state ────────────────────────────────────────────────────────────

const sessionServices = new Map<string, ServiceHandle[]>();

function emitServiceStatus(sessionId: string): void {
  companionBus.emit("service:status", {
    sessionId,
    services: getServiceStatuses(sessionId),
  });
}

function serviceEnvFor(
  opts: StartServicesOpts | Omit<StartServicesOpts, "sessionId">,
  serviceName: string,
): Record<string, string> {
  return (opts.perServiceEnv?.[serviceName] ?? opts.env ?? {});
}

// ── Setup Scripts ───────────────────────────────────────────────────────────

/**
 * Run setup scripts sequentially. Fails fast on first non-zero exit.
 */
export async function runSetupScripts(
  scripts: LaunchSetupScript[],
  opts: RunSetupOpts,
): Promise<{ ok: boolean; error?: string }> {
  const timeout = opts.timeout ?? 120_000;

  for (const script of scripts) {
    log.info("launch-runner", ` Running setup: ${script.name} → ${script.command}`);
    try {
      const scriptEnv = {
        ...(opts.env ?? {}),
        ...(opts.perScriptEnv?.[script.name] ?? {}),
      };
      const result = opts.containerId
        ? await runInContainer(script.command, opts.containerId, { timeout, onOutput: (line) => opts.onOutput?.(script.name, line), env: scriptEnv })
        : await runLocal(script.command, opts.cwd, { timeout, onOutput: (line) => opts.onOutput?.(script.name, line), env: scriptEnv });

      if (result.exitCode !== 0) {
        const truncated = result.output.length > 2000
          ? result.output.slice(0, 500) + "\n...[truncated]...\n" + result.output.slice(-1500)
          : result.output;
        return {
          ok: false,
          error: `Setup "${script.name}" failed (exit ${result.exitCode}):\n${truncated}`,
        };
      }
      log.info("launch-runner", ` Setup "${script.name}" completed`);
    } catch (e) {
      return {
        ok: false,
        error: `Setup "${script.name}" failed: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
  }

  return { ok: true };
}

async function runLocal(
  command: string,
  cwd: string,
  opts: { timeout: number; onOutput?: (line: string) => void; env?: Record<string, string> },
): Promise<{ exitCode: number; output: string }> {
  return new Promise<{ exitCode: number; output: string }>((resolve, reject) => {
    const proc = spawn("sh", ["-lc", command], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...(opts.env ?? {}) },
    });

    const lines: string[] = [];
    const pipeLines = (stream: NodeJS.ReadableStream | null) => {
      if (!stream) return;
      let buffer = "";
      stream.setEncoding("utf8");
      stream.on("data", (chunk: string) => {
        buffer += chunk;
        const parts = buffer.split("\n");
        buffer = parts.pop() ?? "";
        for (const part of parts) {
          lines.push(part);
          opts.onOutput?.(part);
        }
      });
      stream.on("end", () => {
        if (buffer) {
          lines.push(buffer);
          opts.onOutput?.(buffer);
        }
      });
    };
    pipeLines(proc.stdout);
    pipeLines(proc.stderr);

    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error(`Command timed out after ${opts.timeout}ms`));
    }, opts.timeout);

    proc.on("close", (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code ?? 1, output: lines.join("\n") });
    });
    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

async function runInContainer(
  command: string,
  containerId: string,
  opts: { timeout: number; onOutput?: (line: string) => void; env?: Record<string, string> },
): Promise<{ exitCode: number; output: string }> {
  const envPrefix = Object.entries(opts.env ?? {})
    .map(([k, v]) => `${quoteForShellWord(k)}=${quoteForShellWord(v)}`)
    .join(" ");
  const wrappedCommand = envPrefix ? `env ${envPrefix} sh -lc ${JSON.stringify(command)}` : command;
  const cmdWithEnv = ["sh", "-lc", wrappedCommand];
  return containerManager.execInContainerAsync(containerId, cmdWithEnv, {
    timeout: opts.timeout,
    onOutput: opts.onOutput,
  });
}

// ── Line Emitter ────────────────────────────────────────────────────────────

/**
 * Simple pub/sub for stdout/stderr lines from a service process.
 * Allows both the output piping and readyPattern matching to subscribe.
 */
class LineEmitter {
  private listeners = new Set<(line: string) => void>();
  private readonly buffer: string[] = [];
  private readonly maxBuffer: number;

  constructor(maxBuffer = 500) {
    this.maxBuffer = maxBuffer;
  }

  subscribe(cb: (line: string) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  emit(line: string): void {
    // Ring buffer: push and trim from the front when over capacity
    this.buffer.push(line);
    if (this.buffer.length > this.maxBuffer) {
      this.buffer.splice(0, this.buffer.length - this.maxBuffer);
    }

    for (const cb of this.listeners) {
      try {
        cb(line);
      } catch {
        // don't let subscriber errors kill the pipe
      }
    }
  }

  /** Return the last N buffered lines (or all if no limit). */
  getHistory(limit?: number): string[] {
    if (limit === undefined || limit >= this.buffer.length) {
      return [...this.buffer];
    }
    return this.buffer.slice(-limit);
  }
}

function quoteForShellWord(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Pipe a Node.js readable stream line by line into a LineEmitter. */
function pipeNodeStreamToEmitter(
  stream: NodeJS.ReadableStream | null,
  emitter: LineEmitter,
): void {
  if (!stream) return;
  let buffer = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk: string) => {
    buffer += chunk;
    const parts = buffer.split("\n");
    buffer = parts.pop() ?? "";
    for (const part of parts) {
      emitter.emit(part);
    }
  });
  stream.on("end", () => {
    if (buffer) emitter.emit(buffer);
  });
}

// ── Service Startup (dependency-aware) ──────────────────────────────────────

/**
 * Start all services in dependency order. Uses execution waves from
 * topological sort — services within the same wave start in parallel.
 */
export async function startServices(
  resolved: ResolvedLaunchConfig,
  opts: StartServicesOpts,
): Promise<{ ok: boolean; error?: string }> {
  const { services } = resolved;
  const serviceNames = Object.keys(services);
  if (serviceNames.length === 0) return { ok: true };

  const waves = buildStartupOrder(services);
  const handles: ServiceHandle[] = [];
  sessionServices.set(opts.sessionId, handles);
  const startupErrors: string[] = [];
  const readyPromises = new Map<string, Promise<void>>();
  const readyResolvers = new Map<string, () => void>();
  const startedPromises = new Map<string, Promise<void>>();
  const startedResolvers = new Map<string, () => void>();

  // Pre-create promise/resolver pairs for each service
  for (const name of serviceNames) {
    let readyResolve!: () => void;
    readyPromises.set(name, new Promise<void>((r) => { readyResolve = r; }));
    readyResolvers.set(name, readyResolve);

    let startedResolve!: () => void;
    startedPromises.set(name, new Promise<void>((r) => { startedResolve = r; }));
    startedResolvers.set(name, startedResolve);
  }

  for (const wave of waves) {
    // Wait for all dependencies of this wave's services
    const depWaits: Promise<void>[] = [];
    for (const name of wave) {
      const svc = services[name];
      for (const [dep, cond] of Object.entries(svc.dependsOn)) {
        depWaits.push(
          cond === "ready" ? readyPromises.get(dep)! : startedPromises.get(dep)!,
        );
      }
    }
    await Promise.all(depWaits);

    // Start all services in this wave in parallel
    const wavePromises = wave.map(async (name) => {
      const svc = services[name];
      opts.onProgress?.(name, "starting");
      log.info("launch-runner", ` Starting service: ${name} → ${svc.command}`);

      try {
        const handle = spawnService(name, svc, opts);
        handles.push(handle);

        await new Promise((resolve) => setTimeout(resolve, 0));
        if (handle.status === "failed") {
          throw new Error(`Service "${name}" exited before becoming ready`);
        }

        // Mark as started immediately (process is spawned)
        handle.status = "started";
        emitServiceStatus(handle.sessionId);
        startedResolvers.get(name)?.();
        opts.onProgress?.(name, "started");

        // Wait for readyPattern if defined
        if (svc.readyPattern) {
          const matched = await waitForReady(handle, svc);
          if (matched) {
            handle.status = "ready";
            emitServiceStatus(handle.sessionId);
            opts.onProgress?.(name, "ready", `Matched: ${svc.readyPattern}`);
          } else {
            opts.onProgress?.(name, "started", `readyPattern timeout after ${svc.readyTimeout}s`);
            log.warn("launch-runner", ` Service "${name}" readyPattern timeout after ${svc.readyTimeout}s`);
          }
        } else {
          handle.status = "ready";
          emitServiceStatus(handle.sessionId);
          opts.onProgress?.(name, "ready");
        }

        // Resolve ready (even on timeout — don't block dependents forever)
        readyResolvers.get(name)?.();
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        startupErrors.push(`Service "${name}" failed to start: ${msg}`);
        log.error("launch-runner", ` Service "${name}" failed to start: ${msg}`);
        opts.onProgress?.(name, "failed", msg);
        emitServiceStatus(opts.sessionId);
        // Unblock dependents
        startedResolvers.get(name)?.();
        readyResolvers.get(name)?.();
      }
    });

    await Promise.all(wavePromises);
  }

  if (startupErrors.length > 0) {
    return { ok: false, error: startupErrors.join("\n") };
  }

  return { ok: true };
}

function spawnService(
  name: string,
  svc: ResolvedService,
  opts: StartServicesOpts,
): ServiceHandle {
  const emitter = new LineEmitter();

  // Merge env: resolved per-service env (already includes top-level env) + svc.env as final fallback
  const mergedEnv = { ...serviceEnvFor(opts, name), ...(svc.env ?? {}) };
  const hasEnv = Object.keys(mergedEnv).length > 0;

  let cmd: string[];
  if (opts.containerId) {
    cmd = ["docker", "exec"];
    // Pass env vars via -e flags for container mode
    if (hasEnv) {
      for (const [k, v] of Object.entries(mergedEnv)) {
        cmd.push("-e", `${k}=${v}`);
      }
    }
    cmd.push(opts.containerId, "sh", "-lc", svc.command);
  } else {
    cmd = ["sh", "-lc", svc.command];
  }

  const proc = spawn(cmd[0], cmd.slice(1), {
    cwd: opts.containerId ? undefined : opts.cwd,
    stdio: ["ignore", "pipe", "pipe"],
    env: opts.containerId ? undefined : { ...process.env, ...mergedEnv },
  });

  const handle: ServiceHandle = {
    name,
    sessionId: opts.sessionId,
    pid: proc.pid,
    port: undefined,
    status: "starting",
    process: proc,
    onLine: (cb) => emitter.subscribe(cb),
    getHistory: (limit) => emitter.getHistory(limit),
    kill() {
      try {
        proc.kill();
      } catch {
        // already dead
      }
      this.status = "stopped";
    },
  };

  // Forward lines to the caller's onOutput
  if (opts.onOutput) {
    emitter.subscribe((line) => opts.onOutput!(name, line));
  }

  // Broadcast log lines via companionBus for WebSocket push
  emitter.subscribe((line) => {
    companionBus.emit("service:log", { sessionId: handle.sessionId, serviceName: name, line });
  });

  pipeNodeStreamToEmitter(proc.stdout, emitter);
  pipeNodeStreamToEmitter(proc.stderr, emitter);

  // Monitor process exit
  proc.on("close", (code) => {
    if (handle.status !== "stopped") {
      handle.status = "failed";
      log.warn("launch-runner", ` Service "${name}" exited with code ${code}`);
      emitServiceStatus(handle.sessionId);
    }
  });

  return handle;
}

// ── Ready Pattern Matching ──────────────────────────────────────────────────

/**
 * Wait for a service's readyPattern to match in stdout/stderr.
 * Returns true if matched, false on timeout.
 */
function waitForReady(
  handle: ServiceHandle,
  svc: ResolvedService,
): Promise<boolean> {
  if (!svc.readyPattern) return Promise.resolve(true);

  const regex = new RegExp(svc.readyPattern);
  const timeoutMs = svc.readyTimeout * 1000;

  return new Promise<boolean>((resolve) => {
    let resolved = false;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    const unsub = handle.onLine((line) => {
      if (resolved) return;
      if (regex.test(line)) {
        resolved = true;
        unsub();
        if (timeoutId) clearTimeout(timeoutId);
        resolve(true);
      }
    });

    timeoutId = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        unsub();
        resolve(false);
      }
    }, timeoutMs);
  });
}

async function ensureProcessStillRunning(handle: ServiceHandle): Promise<boolean> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  return handle.status !== "failed";
}

// ── Lifecycle Management ────────────────────────────────────────────────────

/** Stop all background services for a session (reverse order). */
export function stopAllServices(sessionId: string): void {
  const handles = sessionServices.get(sessionId);
  if (!handles) return;

  log.info("launch-runner", ` Stopping ${handles.length} service(s) for session ${sessionId}`);

  // Kill in reverse order (dependents first)
  for (let i = handles.length - 1; i >= 0; i--) {
    handles[i].kill();
  }

  emitServiceStatus(sessionId);
  sessionServices.delete(sessionId);
}

/** Stop a single service by name. */
export function stopService(sessionId: string, serviceName: string): boolean {
  const handles = sessionServices.get(sessionId);
  if (!handles) return false;
  const handle = handles.find((h) => h.name === serviceName);
  if (!handle) return false;
  handle.kill();
  emitServiceStatus(sessionId);
  return true;
}

/** Restart a single service by name. Requires the resolved config to respawn. */
export async function restartService(
  sessionId: string,
  serviceName: string,
  resolved: ResolvedLaunchConfig,
  opts: Omit<StartServicesOpts, "sessionId">,
): Promise<{ ok: boolean; error?: string }> {
  const handles = sessionServices.get(sessionId);
  if (!handles) return { ok: false, error: "No services found for session" };

  const idx = handles.findIndex((h) => h.name === serviceName);
  if (idx === -1) return { ok: false, error: `Service "${serviceName}" not found` };

  const svc = resolved.services[serviceName];
  if (!svc) return { ok: false, error: `Service "${serviceName}" not in config` };

  // Kill existing
  handles[idx].kill();

  // Respawn
  try {
    const handle = spawnService(serviceName, svc, {
      ...opts,
      sessionId,
      env: serviceEnvFor(opts, serviceName),
    });
    handles[idx] = handle;
    let restartFailed = false;
    handle.status = "started";
    emitServiceStatus(sessionId);

    if (svc.readyPattern) {
      const matched = await waitForReady(handle, svc);
      restartFailed = (handle.status as ServiceStatus) === "failed";
      if (matched) {
        if (!restartFailed) {
          handle.status = "ready";
        }
      } else if (!restartFailed) {
        handle.status = "started";
      }
    } else if (!restartFailed) {
      handle.status = "ready";
    }

    restartFailed = (handle.status as ServiceStatus) === "failed";
    emitServiceStatus(sessionId);
    return restartFailed
      ? { ok: false, error: `Service "${serviceName}" failed to restart` }
      : { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Get all running service handles for a session. */
export function getServices(sessionId: string): ServiceHandle[] {
  return sessionServices.get(sessionId) ?? [];
}

/** Get service statuses in a serializable format. */
export function getServiceStatuses(
  sessionId: string,
): Array<{ name: string; status: ServiceStatus; pid?: number; port?: number }> {
  return getServices(sessionId).map((h) => ({
    name: h.name,
    status: h.status,
    pid: h.pid,
    port: h.port,
  }));
}

/**
 * Re-associate services from a temporary session ID to the real one.
 * Used during session creation when services start before the CLI assigns
 * the real session ID.
 */
export function reassociateServices(oldSessionId: string, newSessionId: string): void {
  const handles = sessionServices.get(oldSessionId);
  if (!handles) return;
  for (const handle of handles) {
    handle.sessionId = newSessionId;
  }
  sessionServices.delete(oldSessionId);
  sessionServices.set(newSessionId, handles);
  log.info("launch-runner", ` Re-associated ${handles.length} service(s): ${oldSessionId} → ${newSessionId}`);
}

/** Return buffered log lines for a specific service. */
export function getServiceLogs(sessionId: string, serviceName: string, limit?: number): string[] {
  const handles = sessionServices.get(sessionId);
  if (!handles) return [];
  const handle = handles.find((h) => h.name === serviceName);
  if (!handle) return [];
  return handle.getHistory(limit);
}

/** Stop all services across all sessions (for server shutdown). */
export function stopAll(): void {
  for (const [sessionId] of sessionServices) {
    stopAllServices(sessionId);
  }
}
