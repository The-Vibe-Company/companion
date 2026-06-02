/**
 * Tailscale CLI wrapper for Funnel integration.
 *
 * Detects the `tailscale` binary, checks connection status, and manages
 * Tailscale Funnel to expose the Companion over HTTPS. Persists funnel
 * state to ~/.companion/tailscale-state.json for restoration across
 * server restarts.
 */

import { spawnSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { resolveBinary } from "./path-resolver.js";
import { getSettings, updateSettings } from "./settings-manager.js";

// ── Types ───────────────────────────────────────────────────────────────────

/** Keep in sync with web/src/api.ts TailscaleStatus */
export interface TailscaleStatus {
  /** Whether the `tailscale` binary was found on PATH */
  installed: boolean;
  /** Resolved absolute path to the binary, or null */
  binaryPath: string | null;
  /** Whether Tailscale is connected to a tailnet */
  connected: boolean;
  /** Machine DNS name, e.g. "my-machine.tail1234.ts.net" */
  dnsName: string | null;
  /** Whether Funnel is currently active for our port */
  funnelActive: boolean;
  /** HTTPS Funnel URL when active, e.g. "https://my-machine.tail1234.ts.net" */
  funnelUrl: string | null;
  /** Error message if the last operation failed */
  error: string | null;
  /** True when on Linux and Tailscale operator mode is not configured */
  needsOperatorMode?: boolean;
  /** Non-blocking warning (e.g. DNS not resolving publicly) */
  warning?: string;
}

interface PersistedFunnelState {
  wasActive: boolean;
  port: number;
  funnelUrl: string;
  activatedAt: number;
}

// ── Internal state ──────────────────────────────────────────────────────────

const STATE_PATH = join(homedir(), ".companion", "tailscale-state.json");
const CMD_TIMEOUT = 15_000;
const BINARY_CACHE_TTL = 60_000; // 1 minute — allows detecting install/uninstall without restart

let cachedBinaryPath: string | null | undefined; // undefined = not yet checked
let binaryCacheTime = 0;

// ── Helpers ─────────────────────────────────────────────────────────────────

function findBinary(): string | null {
  if (cachedBinaryPath !== undefined && Date.now() - binaryCacheTime < BINARY_CACHE_TTL) {
    return cachedBinaryPath;
  }
  cachedBinaryPath = resolveBinary("tailscale");
  binaryCacheTime = Date.now();
  return cachedBinaryPath;
}

/**
 * Run a command asynchronously using spawn with explicit argument array
 * (no shell interpolation — eliminates command injection).
 */
function execAsync(binary: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(binary, args, {
      stdio: ["pipe", "pipe", "pipe"],
      timeout: CMD_TIMEOUT,
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (data: Buffer) => { stdout += data.toString(); });
    proc.stderr.on("data", (data: Buffer) => { stderr += data.toString(); });

    proc.on("error", (err) => reject(err));
    proc.on("close", (code) => {
      if (code === 0) {
        resolve(stdout.trim());
      } else {
        reject(new Error(stderr.trim() || `Process exited with code ${code}`));
      }
    });
  });
}

/**
 * Check if operator mode is needed but not configured (Linux only).
 * On macOS the Tailscale GUI app handles permissions, so this is a no-op.
 */
async function checkNeedsOperatorMode(binary: string): Promise<boolean> {
  if (process.platform !== "linux") return false;
  try {
    const output = await execAsync(binary, ["debug", "prefs"]);
    const prefs = JSON.parse(output);
    return !prefs.OperatorUser;
  } catch {
    return false; // Can't determine — assume ok
  }
}

/**
 * Check if a hostname resolves via public DNS (Google 8.8.8.8).
 * We explicitly use a public resolver to avoid Tailscale's MagicDNS
 * returning private CGNAT addresses (100.64.x.x) for .ts.net hostnames.
 */
async function checkFunnelDnsResolves(hostname: string): Promise<boolean> {
  try {
    const { Resolver } = await import("node:dns/promises");
    const resolver = new Resolver();
    resolver.setServers(["8.8.8.8"]);
    const addresses = await resolver.resolve4(hostname);
    return addresses.length > 0;
  } catch {
    return false;
  }
}

function loadPersistedState(): PersistedFunnelState | null {
  try {
    if (!existsSync(STATE_PATH)) return null;
    const raw = JSON.parse(readFileSync(STATE_PATH, "utf-8")) as PersistedFunnelState;
    if (raw && typeof raw.wasActive === "boolean" && typeof raw.port === "number") {
      return raw;
    }
    return null;
  } catch {
    return null;
  }
}

function persistState(state: PersistedFunnelState): void {
  try {
    mkdirSync(dirname(STATE_PATH), { recursive: true });
    writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), "utf-8");
  } catch (err) {
    console.warn("[tailscale] Failed to persist state:", err);
  }
}

function clearPersistedState(): void {
  try {
    if (existsSync(STATE_PATH)) unlinkSync(STATE_PATH);
  } catch {
    // best-effort
  }
}

/**
 * Parse `tailscale status --json` to get connection state and DNS name.
 */
async function parseConnectionStatus(binary: string): Promise<{ connected: boolean; dnsName: string | null }> {
  try {
    const output = await execAsync(binary, ["status", "--json"]);
    const status = JSON.parse(output) as {
      BackendState?: string;
      Self?: { DNSName?: string };
    };

    const backendState = status.BackendState ?? "";
    const connected = backendState === "Running";
    let dnsName: string | null = null;

    if (connected && status.Self?.DNSName) {
      // DNSName typically ends with a trailing dot — strip it
      dnsName = status.Self.DNSName.replace(/\.$/, "");
    }

    return { connected, dnsName };
  } catch {
    return { connected: false, dnsName: null };
  }
}

/**
 * Parse `tailscale serve status --json` to determine if a given port is being
 * funneled. The output looks like:
 * {
 *   "Web": { "machine.ts.net:443": { "Handlers": { "/": { "Proxy": "http://127.0.0.1:PORT" } } } },
 *   "AllowFunnel": { "machine.ts.net:443": true }
 * }
 */
async function parseFunnelStatus(binary: string, port: number): Promise<{ active: boolean; funnelUrl: string | null }> {
  try {
    const output = await execAsync(binary, ["serve", "status", "--json"]);
    const config = JSON.parse(output) as {
      Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> }>;
      AllowFunnel?: Record<string, boolean>;
    };

    if (!config.Web || !config.AllowFunnel) {
      return { active: false, funnelUrl: null };
    }

    // Match port precisely: the Proxy URL ends with ":PORT" (no trailing path beyond optional /)
    const portSuffix = `:${port}`;
    for (const [hostPort, isFunnel] of Object.entries(config.AllowFunnel)) {
      if (!isFunnel) continue;
      const handlers = config.Web[hostPort]?.Handlers;
      if (!handlers) continue;
      for (const handler of Object.values(handlers)) {
        if (!handler.Proxy) continue;
        // Exact port match: URL ends with ":PORT" or ":PORT/"
        if (handler.Proxy.endsWith(portSuffix) || handler.Proxy.endsWith(`${portSuffix}/`)) {
          // Extract the hostname from "machine.ts.net:443"
          const hostname = hostPort.split(":")[0];
          return { active: true, funnelUrl: `https://${hostname}` };
        }
      }
    }

    return { active: false, funnelUrl: null };
  } catch {
    return { active: false, funnelUrl: null };
  }
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Get full Tailscale status: binary availability, connection, and funnel state.
 */
export async function getTailscaleStatus(port: number): Promise<TailscaleStatus> {
  const binary = findBinary();
  if (!binary) {
    return {
      installed: false,
      binaryPath: null,
      connected: false,
      dnsName: null,
      funnelActive: false,
      funnelUrl: null,
      error: null,
    };
  }

  const { connected, dnsName } = await parseConnectionStatus(binary);
  if (!connected) {
    return {
      installed: true,
      binaryPath: binary,
      connected: false,
      dnsName: null,
      funnelActive: false,
      funnelUrl: null,
      error: null,
    };
  }

  const { active, funnelUrl } = await parseFunnelStatus(binary, port);
  const needsOperatorMode = !active ? await checkNeedsOperatorMode(binary) : undefined;

  // If funnel is active, check if the URL actually resolves publicly
  let warning: string | undefined;
  if (active && dnsName) {
    const dnsOk = await checkFunnelDnsResolves(dnsName);
    if (!dnsOk) {
      warning = "DNS for this hostname is not resolving publicly. Ensure Funnel is enabled in your Tailscale admin console (admin.tailscale.com \u2192 Access Controls \u2192 nodeAttrs). DNS propagation can take up to 10 minutes on first use.";
    }
  }

  return {
    installed: true,
    binaryPath: binary,
    connected: true,
    dnsName,
    funnelActive: active,
    funnelUrl,
    error: null,
    ...(needsOperatorMode && { needsOperatorMode }),
    ...(warning && { warning }),
  };
}

/**
 * Start Tailscale Funnel for the given port.
 * Automatically updates publicUrl in settings and persists funnel state.
 */
export async function startFunnel(port: number): Promise<TailscaleStatus> {
  const binary = findBinary();
  if (!binary) {
    return { installed: false, binaryPath: null, connected: false, dnsName: null, funnelActive: false, funnelUrl: null, error: "Tailscale is not installed" };
  }

  const { connected, dnsName } = await parseConnectionStatus(binary);
  if (!connected) {
    return { installed: true, binaryPath: binary, connected: false, dnsName: null, funnelActive: false, funnelUrl: null, error: "Tailscale is not connected. Run `tailscale up` to connect." };
  }

  try {
    await execAsync(binary, ["funnel", "--bg", String(port)]);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    const isPermissionError = process.platform === "linux" && /permission|sudo|access denied/i.test(message);
    return {
      installed: true, binaryPath: binary, connected: true, dnsName,
      funnelActive: false, funnelUrl: null,
      error: isPermissionError
        ? "Tailscale requires operator mode on Linux to manage Funnel."
        : `Failed to start Funnel: ${message}`,
      ...(isPermissionError && { needsOperatorMode: true }),
    };
  }

  // Verify it's running and get the URL
  const { active, funnelUrl } = await parseFunnelStatus(binary, port);

  // DNS reachability is NOT checked here — it takes seconds to minutes for
  // Tailscale to provision public DNS records after first enablement.
  // The check runs in getTailscaleStatus() on subsequent polls instead.

  if (!active || !funnelUrl) {
    // Funnel command succeeded but we can't detect it yet — construct URL from DNS name
    const constructedUrl = dnsName ? `https://${dnsName}` : null;
    if (constructedUrl) {
      updateSettings({ publicUrl: constructedUrl });
      persistState({ wasActive: true, port, funnelUrl: constructedUrl, activatedAt: Date.now() });
      return { installed: true, binaryPath: binary, connected: true, dnsName, funnelActive: true, funnelUrl: constructedUrl, error: null };
    }
    return { installed: true, binaryPath: binary, connected: true, dnsName, funnelActive: false, funnelUrl: null, error: "Funnel started but could not determine URL" };
  }

  updateSettings({ publicUrl: funnelUrl });
  persistState({ wasActive: true, port, funnelUrl, activatedAt: Date.now() });
  console.log(`[tailscale] Funnel started: ${funnelUrl} → localhost:${port}`);

  return { installed: true, binaryPath: binary, connected: true, dnsName, funnelActive: true, funnelUrl, error: null };
}

/**
 * Stop Tailscale Funnel for the given port.
 * Clears publicUrl if it still matches the Funnel URL.
 */
export async function stopFunnel(port: number): Promise<TailscaleStatus> {
  const binary = findBinary();
  if (!binary) {
    return { installed: false, binaryPath: null, connected: false, dnsName: null, funnelActive: false, funnelUrl: null, error: "Tailscale is not installed" };
  }

  // Read persisted URL before stopping
  const persisted = loadPersistedState();
  const previousUrl = persisted?.funnelUrl ?? null;

  try {
    await execAsync(binary, ["funnel", String(port), "off"]);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    // Re-query actual state — funnel is likely still running after a failed stop
    const { connected, dnsName } = await parseConnectionStatus(binary).catch(() => ({ connected: true, dnsName: null as string | null }));
    const { active, funnelUrl } = await parseFunnelStatus(binary, port).catch(() => ({ active: true, funnelUrl: null as string | null }));
    return { installed: true, binaryPath: binary, connected, dnsName, funnelActive: active, funnelUrl, error: `Failed to stop Funnel: ${message}` };
  }

  clearPersistedState();

  // Clear publicUrl only if it matches the Funnel URL (don't overwrite manual URL)
  if (previousUrl) {
    const currentPublicUrl = getSettings().publicUrl;
    if (currentPublicUrl === previousUrl) {
      updateSettings({ publicUrl: "" });
    }
  }

  console.log(`[tailscale] Funnel stopped for port ${port}`);

  const { connected, dnsName } = await parseConnectionStatus(binary);
  return { installed: true, binaryPath: binary, connected, dnsName, funnelActive: false, funnelUrl: null, error: null };
}

/**
 * Check if Tailscale Funnel was previously active and verify it's still running.
 * Called on server startup to keep publicUrl in sync.
 */
export async function restoreIfNeeded(port: number): Promise<void> {
  const persisted = loadPersistedState();
  if (!persisted?.wasActive) return;

  const binary = findBinary();
  if (!binary) {
    console.log("[tailscale] Binary not found, clearing persisted funnel state");
    clearPersistedState();
    return;
  }

  const { connected } = await parseConnectionStatus(binary);
  if (!connected) {
    console.log("[tailscale] Not connected, clearing persisted funnel state");
    clearPersistedState();
    return;
  }

  // Check if funnel is still active (--bg makes it a daemon, so it should survive restarts)
  const { active, funnelUrl } = await parseFunnelStatus(binary, port);
  if (active && funnelUrl) {
    console.log(`[tailscale] Funnel still active: ${funnelUrl}`);
    // Ensure publicUrl is in sync
    const currentPublicUrl = getSettings().publicUrl;
    if (currentPublicUrl !== funnelUrl) {
      updateSettings({ publicUrl: funnelUrl });
      console.log(`[tailscale] Updated publicUrl to match active Funnel: ${funnelUrl}`);
    }
  } else {
    console.log("[tailscale] Funnel no longer active, clearing persisted state");
    clearPersistedState();
    // Clear publicUrl if it still points to the old Funnel URL
    const currentPublicUrl = getSettings().publicUrl;
    if (persisted.funnelUrl && currentPublicUrl === persisted.funnelUrl) {
      updateSettings({ publicUrl: "" });
    }
  }
}

/**
 * Best-effort cleanup on server shutdown. Uses spawnSync since process.exit follows.
 * By default, leaves Funnel running (it's a system daemon).
 * Set COMPANION_TAILSCALE_CLEANUP_ON_EXIT=1 to stop on shutdown.
 */
export function cleanup(port: number): void {
  const shouldCleanup = process.env.COMPANION_TAILSCALE_CLEANUP_ON_EXIT === "1";
  if (!shouldCleanup) return;

  const binary = findBinary();
  if (!binary) return;

  try {
    spawnSync(binary, ["funnel", String(port), "off"], {
      encoding: "utf-8",
      timeout: 5_000,
      stdio: ["pipe", "pipe", "pipe"],
    });
    clearPersistedState();
    console.log(`[tailscale] Funnel stopped on shutdown for port ${port}`);
  } catch {
    // best-effort
  }
}

/** Reset cached state for testing. */
export function _resetForTest(): void {
  cachedBinaryPath = undefined;
  binaryCacheTime = 0;
}
