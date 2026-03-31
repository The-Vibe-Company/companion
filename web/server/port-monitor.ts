/**
 * port-monitor.ts — Periodic health checks for declared ports.
 * Emits status changes via the companion event bus.
 */

import type { LaunchPortConfig } from "./launch-config.js";
import { companionBus } from "./event-bus.js";
import { log } from "./logger.js";

// ── Types ───────────────────────────────────────────────────────────────────

export type PortHealthStatus = "unknown" | "healthy" | "unhealthy";

export interface PortStatus {
  port: number;
  label: string;
  protocol: "http" | "tcp";
  status: PortHealthStatus;
  lastCheck: number; // timestamp ms
  service?: string;  // associated service name
  healthCheckPath?: string; // stored for manual refresh
  openOnReady?: boolean; // auto-open in browser when healthy
}

interface MonitorEntry {
  sessionId: string;
  ports: Map<number, PortStatus>;
  timers: Map<number, ReturnType<typeof setInterval>>;
  hostname: string;
}

// ── Module state ────────────────────────────────────────────────────────────

const monitors = new Map<string, MonitorEntry>();

// ── Public API ──────────────────────────────────────────────────────────────

export interface StartMonitoringOpts {
  /** Service name → port mapping, for labeling which service owns a port. */
  servicePortMap?: Record<string, number>;
  /** Hostname to check (default: "127.0.0.1"). */
  hostname?: string;
}

/**
 * Start periodic health checks for declared ports.
 * Status changes are emitted as `port:status` events on `companionBus`.
 */
export function startMonitoring(
  sessionId: string,
  portConfigs: Record<string, LaunchPortConfig>,
  opts?: StartMonitoringOpts,
): void {
  // Stop existing monitoring if any
  stopMonitoring(sessionId);

  const hostname = opts?.hostname ?? "127.0.0.1";
  const entry: MonitorEntry = {
    sessionId,
    ports: new Map(),
    timers: new Map(),
    hostname,
  };

  // Build reverse map: port → service name
  const portToService = new Map<number, string>();
  if (opts?.servicePortMap) {
    for (const [svc, port] of Object.entries(opts.servicePortMap)) {
      portToService.set(port, svc);
    }
  }

  for (const [portStr, config] of Object.entries(portConfigs)) {
    const port = Number(portStr);
    const protocol = config.protocol ?? "http";
    const interval = sanitizeIntervalMs(config.healthCheck?.interval);

    const status: PortStatus = {
      port,
      label: config.label,
      protocol,
      status: "unknown",
      lastCheck: 0,
      service: portToService.get(port),
      healthCheckPath: config.healthCheck?.path ?? "/",
      openOnReady: config.openOnReady,
    };
    entry.ports.set(port, status);

    // Only run health checks if healthCheck config is provided (or TCP)
    if (config.healthCheck || protocol === "tcp") {
      const checkFn = protocol === "http"
        ? () => checkHttp(entry, port, hostname, config.healthCheck?.path ?? "/")
        : () => checkTcp(entry, port, hostname);

      // Run first check immediately
      checkFn();

      // Then periodically
      const timer = setInterval(checkFn, interval);
      entry.timers.set(port, timer);
    }
  }

  monitors.set(sessionId, entry);
  log.info("port-monitor", ` Started monitoring ${entry.ports.size} port(s) for session ${sessionId}`);
}

/** Stop all health checks for a session. */
export function stopMonitoring(sessionId: string): void {
  const entry = monitors.get(sessionId);
  if (!entry) return;

  for (const timer of entry.timers.values()) {
    clearInterval(timer);
  }
  monitors.delete(sessionId);
  log.info("port-monitor", ` Stopped monitoring for session ${sessionId}`);
}

/** Get current port statuses for a session. */
export function getPortStatuses(sessionId: string): PortStatus[] {
  const entry = monitors.get(sessionId);
  if (!entry) return [];
  return Array.from(entry.ports.values());
}

/** Trigger a single health check for a specific port (manual refresh). */
export async function checkPort(
  sessionId: string,
  port: number,
): Promise<PortHealthStatus> {
  const entry = monitors.get(sessionId);
  if (!entry) return "unknown";

  const status = entry.ports.get(port);
  if (!status) return "unknown";

  if (status.protocol === "tcp") {
    await checkTcp(entry, port, entry.hostname);
  } else {
    await checkHttp(entry, port, entry.hostname, status.healthCheckPath ?? "/");
  }

  return entry.ports.get(port)?.status ?? "unknown";
}

/**
 * Re-associate port monitoring from a temporary session ID to the real one.
 * Existing timers continue running but emit events under the new session ID.
 */
export function reassociateMonitoring(oldSessionId: string, newSessionId: string): void {
  const entry = monitors.get(oldSessionId);
  if (!entry) return;
  entry.sessionId = newSessionId;
  monitors.delete(oldSessionId);
  monitors.set(newSessionId, entry);
  // Emit current status under the new session ID so browsers pick it up
  emitStatusChange(entry);
  log.info("port-monitor", ` Re-associated monitoring: ${oldSessionId} → ${newSessionId}`);
}

/** Stop all monitors (for server shutdown). */
export function stopAllMonitors(): void {
  for (const sessionId of monitors.keys()) {
    stopMonitoring(sessionId);
  }
}

// ── Health Check Implementations ────────────────────────────────────────────

async function checkHttp(
  entry: MonitorEntry,
  port: number,
  hostname: string,
  path: string,
): Promise<void> {
  const status = entry.ports.get(port);
  if (!status) return;

  const prevStatus = status.status;
  try {
    const url = `http://${hostname}:${port}${path}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    const res = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
    });
    clearTimeout(timeout);

    // Any 2xx/3xx = healthy
    status.status = res.status < 400 ? "healthy" : "unhealthy";
  } catch {
    status.status = "unhealthy";
  }
  status.lastCheck = Date.now();

  if (status.status !== prevStatus) {
    emitStatusChange(entry);
  }
}

async function checkTcp(
  entry: MonitorEntry,
  port: number,
  hostname: string,
): Promise<void> {
  const status = entry.ports.get(port);
  if (!status) return;

  const prevStatus = status.status;
  try {
    await Bun.connect({
      hostname,
      port,
      socket: {
        data() {},
        open(socket) {
          socket.end();
        },
        error() {},
        close() {},
      },
    });
    // If we got here, connection succeeded
    status.status = "healthy";
  } catch {
    status.status = "unhealthy";
  }
  status.lastCheck = Date.now();

  if (status.status !== prevStatus) {
    emitStatusChange(entry);
  }
}

function emitStatusChange(entry: MonitorEntry): void {
  const ports = Array.from(entry.ports.values());
  companionBus.emit("port:status", { sessionId: entry.sessionId, ports });
}

function sanitizeIntervalMs(intervalSeconds: number | undefined): number {
  if (!Number.isFinite(intervalSeconds) || intervalSeconds === undefined) {
    return 10_000;
  }

  const roundedSeconds = Math.floor(intervalSeconds);
  const clampedSeconds = Math.min(Math.max(roundedSeconds, 1), 300);
  return clampedSeconds * 1000;
}
