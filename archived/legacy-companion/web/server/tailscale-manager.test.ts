import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";

// Mock dns/promises for checkFunnelDnsResolves (uses Resolver with public DNS)
const mockResolve4 = vi.fn();
vi.mock("node:dns/promises", () => ({
  Resolver: class {
    setServers() { /* no-op */ }
    resolve4(...args: unknown[]) { return mockResolve4(...args); }
  },
}));

// ── Mocks ───────────────────────────────────────────────────────────────────

vi.mock("./path-resolver.js", () => ({
  resolveBinary: vi.fn(),
}));

vi.mock("./settings-manager.js", () => ({
  updateSettings: vi.fn(),
  getSettings: vi.fn(() => ({ publicUrl: "" })),
}));

// Queue of results for successive spawn calls. Each entry is either
// { stdout, code } for success or { stderr, code } for failure.
type SpawnResult = { stdout?: string; stderr?: string; code: number };
let spawnQueue: SpawnResult[] = [];

/**
 * Mock spawn: returns a fake ChildProcess that emits data/close based on
 * the next entry in spawnQueue. This avoids shell interpolation entirely
 * (matching the real implementation).
 */
function mockSpawnImpl() {
  const result = spawnQueue.shift() ?? { stdout: "", code: 0 };
  const proc = new EventEmitter() as ReturnType<typeof import("node:child_process").spawn>;

  const stdoutEmitter = new EventEmitter();
  const stderrEmitter = new EventEmitter();
  (proc as unknown as Record<string, unknown>).stdout = stdoutEmitter;
  (proc as unknown as Record<string, unknown>).stderr = stderrEmitter;

  // Emit data + close asynchronously so the caller can attach listeners first
  queueMicrotask(() => {
    if (result.stdout !== undefined) {
      stdoutEmitter.emit("data", Buffer.from(result.stdout));
    }
    if (result.stderr !== undefined) {
      stderrEmitter.emit("data", Buffer.from(result.stderr));
    }
    proc.emit("close", result.code);
  });

  return proc;
}

vi.mock("node:child_process", () => ({
  spawnSync: vi.fn(),
  spawn: vi.fn(() => mockSpawnImpl()),
}));

vi.mock("node:fs", () => ({
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  unlinkSync: vi.fn(),
}));

import { resolveBinary } from "./path-resolver.js";
import { updateSettings, getSettings } from "./settings-manager.js";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import {
  getTailscaleStatus,
  startFunnel,
  stopFunnel,
  restoreIfNeeded,
  cleanup,
  _resetForTest,
} from "./tailscale-manager.js";

const mockResolveBinary = vi.mocked(resolveBinary);
const mockSpawnSync = vi.mocked(spawnSync);
const mockUpdateSettings = vi.mocked(updateSettings);
const mockGetSettings = vi.mocked(getSettings);
const mockExistsSync = vi.mocked(existsSync);
const mockReadFileSync = vi.mocked(readFileSync);

// Sample JSON outputs from the tailscale CLI
const CONNECTED_STATUS_JSON = JSON.stringify({
  BackendState: "Running",
  Self: { DNSName: "my-machine.tail1234.ts.net." },
});

const DISCONNECTED_STATUS_JSON = JSON.stringify({
  BackendState: "Stopped",
  Self: { DNSName: "" },
});

const FUNNEL_ACTIVE_JSON = JSON.stringify({
  Web: {
    "my-machine.tail1234.ts.net:443": {
      Handlers: { "/": { Proxy: "http://127.0.0.1:3456" } },
    },
  },
  AllowFunnel: { "my-machine.tail1234.ts.net:443": true },
});

const FUNNEL_INACTIVE_JSON = JSON.stringify({
  Web: {},
  AllowFunnel: {},
});

/** Helper to enqueue a successful spawn result */
function enqueueSpawnSuccess(stdout: string) {
  spawnQueue.push({ stdout, code: 0 });
}

/** Helper to enqueue a failed spawn result */
function enqueueSpawnFailure(stderr: string, code = 1) {
  spawnQueue.push({ stderr, code });
}

beforeEach(() => {
  vi.clearAllMocks();
  spawnQueue = [];
  _resetForTest();
  // Default: DNS resolves successfully (override per-test when needed)
  mockResolve4.mockResolvedValue(["100.64.0.1"]);
});

afterEach(() => {
  _resetForTest();
});

// ── getTailscaleStatus ──────────────────────────────────────────────────────

describe("getTailscaleStatus", () => {
  it("returns installed=false when binary is not found", async () => {
    mockResolveBinary.mockReturnValue(null);
    const status = await getTailscaleStatus(3456);

    expect(status.installed).toBe(false);
    expect(status.binaryPath).toBeNull();
    expect(status.connected).toBe(false);
    expect(status.funnelActive).toBe(false);
    expect(status.error).toBeNull();
  });

  it("returns connected=false when Tailscale is not running", async () => {
    mockResolveBinary.mockReturnValue("/usr/bin/tailscale");
    // parseConnectionStatus: `tailscale status --json`
    enqueueSpawnSuccess(DISCONNECTED_STATUS_JSON);

    const status = await getTailscaleStatus(3456);

    expect(status.installed).toBe(true);
    expect(status.binaryPath).toBe("/usr/bin/tailscale");
    expect(status.connected).toBe(false);
    expect(status.dnsName).toBeNull();
    expect(status.funnelActive).toBe(false);
  });

  it("parses connected status and DNS name correctly", async () => {
    mockResolveBinary.mockReturnValue("/usr/bin/tailscale");
    // First call: tailscale status --json
    enqueueSpawnSuccess(CONNECTED_STATUS_JSON);
    // Second call: tailscale serve status --json
    enqueueSpawnSuccess(FUNNEL_INACTIVE_JSON);

    const status = await getTailscaleStatus(3456);

    expect(status.installed).toBe(true);
    expect(status.connected).toBe(true);
    expect(status.dnsName).toBe("my-machine.tail1234.ts.net");
    expect(status.funnelActive).toBe(false);
    expect(status.funnelUrl).toBeNull();
  });

  it("detects active funnel for the correct port", async () => {
    mockResolveBinary.mockReturnValue("/usr/bin/tailscale");
    enqueueSpawnSuccess(CONNECTED_STATUS_JSON);
    enqueueSpawnSuccess(FUNNEL_ACTIVE_JSON);

    const status = await getTailscaleStatus(3456);

    expect(status.funnelActive).toBe(true);
    expect(status.funnelUrl).toBe("https://my-machine.tail1234.ts.net");
  });

  it("does not report funnel for a different port", async () => {
    mockResolveBinary.mockReturnValue("/usr/bin/tailscale");
    enqueueSpawnSuccess(CONNECTED_STATUS_JSON);
    enqueueSpawnSuccess(FUNNEL_ACTIVE_JSON);

    // Port 9999 is not in the funnel config (config has 3456)
    const status = await getTailscaleStatus(9999);

    expect(status.funnelActive).toBe(false);
    expect(status.funnelUrl).toBeNull();
  });

  // Regression: port 34 should NOT match a funnel configured for port 3456
  it("does not false-positive match port substring (e.g. 34 vs 3456)", async () => {
    mockResolveBinary.mockReturnValue("/usr/bin/tailscale");
    enqueueSpawnSuccess(CONNECTED_STATUS_JSON);
    enqueueSpawnSuccess(FUNNEL_ACTIVE_JSON); // has port 3456

    const status = await getTailscaleStatus(34);

    expect(status.funnelActive).toBe(false);
    expect(status.funnelUrl).toBeNull();
  });

  it("handles spawn errors gracefully", async () => {
    mockResolveBinary.mockReturnValue("/usr/bin/tailscale");
    // parseConnectionStatus fails
    enqueueSpawnFailure("command failed");

    const status = await getTailscaleStatus(3456);

    expect(status.installed).toBe(true);
    expect(status.connected).toBe(false);
  });

  it("returns needsOperatorMode=true on Linux when operator is not set", async () => {
    const origPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });

    mockResolveBinary.mockReturnValue("/usr/bin/tailscale");
    enqueueSpawnSuccess(CONNECTED_STATUS_JSON);
    enqueueSpawnSuccess(FUNNEL_INACTIVE_JSON);
    // checkNeedsOperatorMode: `tailscale debug prefs`
    enqueueSpawnSuccess(JSON.stringify({ OperatorUser: "" }));

    const status = await getTailscaleStatus(3456);

    expect(status.needsOperatorMode).toBe(true);

    Object.defineProperty(process, "platform", { value: origPlatform, configurable: true });
  });

  it("returns needsOperatorMode=false on Linux when operator IS set", async () => {
    const origPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });

    mockResolveBinary.mockReturnValue("/usr/bin/tailscale");
    enqueueSpawnSuccess(CONNECTED_STATUS_JSON);
    enqueueSpawnSuccess(FUNNEL_INACTIVE_JSON);
    enqueueSpawnSuccess(JSON.stringify({ OperatorUser: "myuser" }));

    const status = await getTailscaleStatus(3456);

    expect(status.needsOperatorMode).toBeUndefined();

    Object.defineProperty(process, "platform", { value: origPlatform, configurable: true });
  });

  it("does not check operator mode on macOS", async () => {
    const origPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });

    mockResolveBinary.mockReturnValue("/usr/bin/tailscale");
    enqueueSpawnSuccess(CONNECTED_STATUS_JSON);
    enqueueSpawnSuccess(FUNNEL_INACTIVE_JSON);
    // No additional spawn for debug prefs expected

    const status = await getTailscaleStatus(3456);

    expect(status.needsOperatorMode).toBeUndefined();

    Object.defineProperty(process, "platform", { value: origPlatform, configurable: true });
  });

  it("returns DNS warning when funnel is active but hostname does not resolve", async () => {
    mockResolveBinary.mockReturnValue("/usr/bin/tailscale");
    enqueueSpawnSuccess(CONNECTED_STATUS_JSON);
    enqueueSpawnSuccess(FUNNEL_ACTIVE_JSON);
    // DNS check fails
    mockResolve4.mockRejectedValueOnce(new Error("NXDOMAIN"));

    const status = await getTailscaleStatus(3456);

    expect(status.funnelActive).toBe(true);
    expect(status.warning).toContain("not resolving publicly");
  });

  it("returns no warning when funnel is active and hostname resolves", async () => {
    mockResolveBinary.mockReturnValue("/usr/bin/tailscale");
    enqueueSpawnSuccess(CONNECTED_STATUS_JSON);
    enqueueSpawnSuccess(FUNNEL_ACTIVE_JSON);
    // DNS check succeeds
    mockResolve4.mockResolvedValueOnce(["100.64.0.1"]);

    const status = await getTailscaleStatus(3456);

    expect(status.funnelActive).toBe(true);
    expect(status.warning).toBeUndefined();
  });
});

// ── startFunnel ─────────────────────────────────────────────────────────────

describe("startFunnel", () => {
  it("returns error when Tailscale is not installed", async () => {
    mockResolveBinary.mockReturnValue(null);
    const result = await startFunnel(3456);

    expect(result.error).toBe("Tailscale is not installed");
    expect(result.installed).toBe(false);
  });

  it("returns error when Tailscale is not connected", async () => {
    mockResolveBinary.mockReturnValue("/usr/bin/tailscale");
    enqueueSpawnSuccess(DISCONNECTED_STATUS_JSON);

    const result = await startFunnel(3456);

    expect(result.error).toContain("not connected");
    expect(result.connected).toBe(false);
  });

  it("runs the funnel command and updates settings on success", async () => {
    mockResolveBinary.mockReturnValue("/usr/bin/tailscale");
    // parseConnectionStatus
    enqueueSpawnSuccess(CONNECTED_STATUS_JSON);
    // tailscale funnel --bg 3456 (succeeds)
    enqueueSpawnSuccess("");
    // parseFunnelStatus (verify)
    enqueueSpawnSuccess(FUNNEL_ACTIVE_JSON);

    const result = await startFunnel(3456);

    expect(result.funnelActive).toBe(true);
    expect(result.funnelUrl).toBe("https://my-machine.tail1234.ts.net");
    expect(result.error).toBeNull();
    expect(mockUpdateSettings).toHaveBeenCalledWith({ publicUrl: "https://my-machine.tail1234.ts.net" });
  });

  it("returns needsOperatorMode and clean message on permission failure (Linux)", async () => {
    // Reactive permission detection is Linux-only to avoid false positives on macOS
    const origPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });

    mockResolveBinary.mockReturnValue("/usr/bin/tailscale");
    enqueueSpawnSuccess(CONNECTED_STATUS_JSON);
    // funnel command fails with permission error
    enqueueSpawnFailure("access denied: permission required");

    const result = await startFunnel(3456);

    expect(result.error).toBe("Tailscale requires operator mode on Linux to manage Funnel.");
    expect(result.needsOperatorMode).toBe(true);
    expect(result.funnelActive).toBe(false);

    Object.defineProperty(process, "platform", { value: origPlatform, configurable: true });
  });

  it("does not set needsOperatorMode on permission failure on macOS", async () => {
    // On macOS, permission errors are not operator mode related
    const origPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });

    mockResolveBinary.mockReturnValue("/usr/bin/tailscale");
    enqueueSpawnSuccess(CONNECTED_STATUS_JSON);
    enqueueSpawnFailure("access denied: permission required");

    const result = await startFunnel(3456);

    expect(result.error).toContain("Failed to start Funnel");
    expect(result.needsOperatorMode).toBeUndefined();
    expect(result.funnelActive).toBe(false);

    Object.defineProperty(process, "platform", { value: origPlatform, configurable: true });
  });

  it("does not check DNS immediately after start (deferred to status polls)", async () => {
    // DNS check is deferred to getTailscaleStatus() to avoid false warnings
    // during DNS propagation after first enablement.
    mockResolveBinary.mockReturnValue("/usr/bin/tailscale");
    enqueueSpawnSuccess(CONNECTED_STATUS_JSON);
    enqueueSpawnSuccess(""); // funnel command succeeds
    enqueueSpawnSuccess(FUNNEL_ACTIVE_JSON);

    const result = await startFunnel(3456);

    expect(result.funnelActive).toBe(true);
    expect(result.funnelUrl).toBe("https://my-machine.tail1234.ts.net");
    expect(result.warning).toBeUndefined();
  });

  it("constructs URL from DNS name when serve status is empty", async () => {
    mockResolveBinary.mockReturnValue("/usr/bin/tailscale");
    enqueueSpawnSuccess(CONNECTED_STATUS_JSON);
    enqueueSpawnSuccess(""); // funnel command succeeds
    enqueueSpawnSuccess(FUNNEL_INACTIVE_JSON); // serve status doesn't show it yet

    const result = await startFunnel(3456);

    // Falls back to constructing URL from DNS name
    expect(result.funnelActive).toBe(true);
    expect(result.funnelUrl).toBe("https://my-machine.tail1234.ts.net");
    expect(mockUpdateSettings).toHaveBeenCalled();
  });
});

// ── stopFunnel ──────────────────────────────────────────────────────────────

describe("stopFunnel", () => {
  it("runs the off command and clears publicUrl when it matches", async () => {
    mockResolveBinary.mockReturnValue("/usr/bin/tailscale");
    // Persisted state exists
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({
      wasActive: true,
      port: 3456,
      funnelUrl: "https://my-machine.tail1234.ts.net",
      activatedAt: Date.now(),
    }));
    mockGetSettings.mockReturnValue({
      publicUrl: "https://my-machine.tail1234.ts.net",
    } as ReturnType<typeof getSettings>);

    // stop command succeeds
    enqueueSpawnSuccess("");
    // parseConnectionStatus for final status
    enqueueSpawnSuccess(CONNECTED_STATUS_JSON);

    const result = await stopFunnel(3456);

    expect(result.funnelActive).toBe(false);
    expect(result.error).toBeNull();
    expect(mockUpdateSettings).toHaveBeenCalledWith({ publicUrl: "" });
  });

  it("does not clear publicUrl if it was manually changed", async () => {
    mockResolveBinary.mockReturnValue("/usr/bin/tailscale");
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({
      wasActive: true,
      port: 3456,
      funnelUrl: "https://my-machine.tail1234.ts.net",
      activatedAt: Date.now(),
    }));
    // User manually set a different URL
    mockGetSettings.mockReturnValue({
      publicUrl: "https://custom-domain.example.com",
    } as ReturnType<typeof getSettings>);

    enqueueSpawnSuccess(""); // stop
    enqueueSpawnSuccess(CONNECTED_STATUS_JSON); // status

    await stopFunnel(3456);

    // Should NOT have called updateSettings since publicUrl doesn't match
    expect(mockUpdateSettings).not.toHaveBeenCalled();
  });

  it("returns error and re-queries actual state when stop command fails", async () => {
    mockResolveBinary.mockReturnValue("/usr/bin/tailscale");
    mockExistsSync.mockReturnValue(false);
    enqueueSpawnFailure("stop failed");
    // After failure, stopFunnel re-queries connection + funnel status
    enqueueSpawnSuccess(CONNECTED_STATUS_JSON);
    enqueueSpawnSuccess(FUNNEL_ACTIVE_JSON);

    const result = await stopFunnel(3456);

    expect(result.error).toContain("Failed to stop Funnel");
    // Should reflect actual state from re-query, not hardcoded values
    expect(result.funnelActive).toBe(true);
    expect(result.connected).toBe(true);
    expect(result.dnsName).toBe("my-machine.tail1234.ts.net");
  });
});

// ── restoreIfNeeded ─────────────────────────────────────────────────────────

describe("restoreIfNeeded", () => {
  it("does nothing when no persisted state exists", async () => {
    mockExistsSync.mockReturnValue(false);
    await restoreIfNeeded(3456);
    // No binary resolution attempted
    expect(mockResolveBinary).not.toHaveBeenCalled();
  });

  it("clears state when binary is not found", async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({
      wasActive: true,
      port: 3456,
      funnelUrl: "https://my-machine.tail1234.ts.net",
      activatedAt: Date.now(),
    }));
    mockResolveBinary.mockReturnValue(null);

    await restoreIfNeeded(3456);
    // Should not crash, just log and clear
  });

  it("updates publicUrl when funnel is still active", async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({
      wasActive: true,
      port: 3456,
      funnelUrl: "https://my-machine.tail1234.ts.net",
      activatedAt: Date.now(),
    }));
    mockResolveBinary.mockReturnValue("/usr/bin/tailscale");
    // parseConnectionStatus
    enqueueSpawnSuccess(CONNECTED_STATUS_JSON);
    // parseFunnelStatus
    enqueueSpawnSuccess(FUNNEL_ACTIVE_JSON);
    mockGetSettings.mockReturnValue({ publicUrl: "" } as ReturnType<typeof getSettings>);

    await restoreIfNeeded(3456);

    expect(mockUpdateSettings).toHaveBeenCalledWith({ publicUrl: "https://my-machine.tail1234.ts.net" });
  });
});

// ── cleanup ─────────────────────────────────────────────────────────────────
// cleanup() uses spawnSync (synchronous) because it runs before process.exit

describe("cleanup", () => {
  it("is a no-op when COMPANION_TAILSCALE_CLEANUP_ON_EXIT is not set", () => {
    delete process.env.COMPANION_TAILSCALE_CLEANUP_ON_EXIT;
    mockResolveBinary.mockReturnValue("/usr/bin/tailscale");

    cleanup(3456);

    // spawnSync should not have been called for the funnel off command
    expect(mockSpawnSync).not.toHaveBeenCalled();
  });

  it("stops funnel when COMPANION_TAILSCALE_CLEANUP_ON_EXIT=1", () => {
    process.env.COMPANION_TAILSCALE_CLEANUP_ON_EXIT = "1";
    mockResolveBinary.mockReturnValue("/usr/bin/tailscale");
    mockSpawnSync.mockReturnValue({ status: 0 } as ReturnType<typeof spawnSync>);

    cleanup(3456);

    // Should call spawnSync with arg array (no shell interpolation)
    expect(mockSpawnSync).toHaveBeenCalledWith(
      "/usr/bin/tailscale",
      ["funnel", "3456", "off"],
      expect.any(Object),
    );

    delete process.env.COMPANION_TAILSCALE_CLEANUP_ON_EXIT;
  });
});
