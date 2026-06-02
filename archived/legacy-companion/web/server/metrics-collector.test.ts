import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { MetricsCollector } from "./metrics-collector.js";
import type { GaugeDataProvider } from "./metrics-collector.js";
import type { SessionPhase } from "./session-state-machine.js";
import { companionBus } from "./event-bus.js";

// Fresh collector per test (avoids singleton pollution)
let collector: MetricsCollector;

beforeEach(() => {
  collector = new MetricsCollector();
});

afterEach(() => {
  collector.destroy();
});

// ── Helper: mock gauge provider ───────────────────────────────────────────

function createMockGaugeProvider(overrides?: {
  phases?: Map<string, SessionPhase>;
  stats?: { id: string; browsers: number; historyLen: number; eventBufferLen: number; pendingMsgs: number }[];
}): GaugeDataProvider {
  return {
    getSessionPhases: vi.fn(() => overrides?.phases ?? new Map()),
    getSessionMemoryStats: vi.fn(() => overrides?.stats ?? []),
  };
}

// ── Counters ──────────────────────────────────────────────────────────────

describe("counters", () => {
  it("tracks sessions created by backend type", () => {
    collector.recordSessionCreated("claude");
    collector.recordSessionCreated("claude");
    collector.recordSessionCreated("codex");

    const snap = collector.getSnapshot();
    expect(snap.counters.sessionsCreated).toEqual({ claude: 2, codex: 1 });
  });

  it("tracks sessions terminated by exit code via event bus", () => {
    companionBus.emit("session:exited", { sessionId: "s1", exitCode: 0 });
    companionBus.emit("session:exited", { sessionId: "s2", exitCode: 1 });
    companionBus.emit("session:exited", { sessionId: "s3", exitCode: null });
    companionBus.emit("session:exited", { sessionId: "s4", exitCode: 0 });

    const snap = collector.getSnapshot();
    expect(snap.counters.sessionsTerminated).toEqual({ "0": 2, "1": 1, "null": 1 });
  });

  it("tracks auto-relaunch counters", () => {
    collector.recordRelaunchAttempted();
    collector.recordRelaunchAttempted();
    collector.recordRelaunchSucceeded();
    collector.recordRelaunchExhausted();

    const snap = collector.getSnapshot();
    expect(snap.counters.autoRelaunches).toEqual({
      attempted: 2,
      succeeded: 1,
      exhausted: 1,
    });
  });

  it("tracks messages processed by type", () => {
    collector.recordMessageProcessed("assistant");
    collector.recordMessageProcessed("assistant");
    collector.recordMessageProcessed("result");
    collector.recordMessageProcessed("stream_event");

    const snap = collector.getSnapshot();
    expect(snap.counters.messagesProcessed).toEqual({
      assistant: 2,
      result: 1,
      stream_event: 1,
    });
  });

  it("tracks permission requests", () => {
    // 2 auto-approved, 1 auto-denied, 1 user-approved, 1 user-denied
    collector.recordPermissionRequested("r1");
    collector.recordPermissionResolved("r1", "allow", true);
    collector.recordPermissionRequested("r2");
    collector.recordPermissionResolved("r2", "allow", true);
    collector.recordPermissionRequested("r3");
    collector.recordPermissionResolved("r3", "deny", true);
    collector.recordPermissionRequested("r4");
    collector.recordPermissionResolved("r4", "allow", false);
    collector.recordPermissionRequested("r5");
    collector.recordPermissionResolved("r5", "deny", false);

    const snap = collector.getSnapshot();
    expect(snap.counters.permissionRequests).toEqual({
      total: 5,
      autoApproved: 2,
      autoDenied: 1,
      userApproved: 1,
      userDenied: 1,
    });
  });

  it("tracks errors by category", () => {
    collector.recordError("invalid_state_transition");
    collector.recordError("invalid_state_transition");
    collector.recordError("parse_error");

    const snap = collector.getSnapshot();
    expect(snap.counters.errors).toEqual({
      invalid_state_transition: 2,
      parse_error: 1,
    });
  });

  it("tracks state transitions via event bus", () => {
    companionBus.emit("session:phase-changed", {
      sessionId: "s1",
      from: "starting" as SessionPhase,
      to: "initializing" as SessionPhase,
      trigger: "cli_ws_open",
    });
    companionBus.emit("session:phase-changed", {
      sessionId: "s1",
      from: "initializing" as SessionPhase,
      to: "ready" as SessionPhase,
      trigger: "system_init",
    });

    const snap = collector.getSnapshot();
    expect(snap.counters.stateTransitions).toEqual({
      "starting→initializing": 1,
      "initializing→ready": 1,
    });
  });

  it("tracks WebSocket connections", () => {
    collector.recordWsConnection("cli", "open");
    collector.recordWsConnection("cli", "open");
    collector.recordWsConnection("cli", "close");
    collector.recordWsConnection("browser", "open");
    collector.recordWsConnection("browser", "close");

    const snap = collector.getSnapshot();
    expect(snap.counters.wsConnections).toEqual({
      cliOpened: 2,
      cliClosed: 1,
      browserOpened: 1,
      browserClosed: 1,
    });
  });
});

// ── Histograms ────────────────────────────────────────────────────────────

describe("histograms", () => {
  it("records session init time (spawn → ready via event bus)", () => {
    // Simulate spawn + phase transition with controlled timing
    vi.useFakeTimers();

    collector.recordSessionSpawned("s1");
    vi.advanceTimersByTime(2000);

    // Simulate initializing → ready transition
    companionBus.emit("session:phase-changed", {
      sessionId: "s1",
      from: "initializing" as SessionPhase,
      to: "ready" as SessionPhase,
      trigger: "system_init",
    });

    vi.useRealTimers();

    const snap = collector.getSnapshot();
    expect(snap.histograms.sessionInitTimeMs.count).toBe(1);
    expect(snap.histograms.sessionInitTimeMs.sum).toBe(2000);
    expect(snap.histograms.sessionInitTimeMs.min).toBe(2000);
    expect(snap.histograms.sessionInitTimeMs.max).toBe(2000);
    expect(snap.histograms.sessionInitTimeMs.avg).toBe(2000);
  });

  it("records turn duration (user message → result via event bus)", () => {
    vi.useFakeTimers();

    collector.recordTurnStarted("s1");
    vi.advanceTimersByTime(3000);

    companionBus.emit("message:result", {
      sessionId: "s1",
      message: { type: "result", data: {} } as any,
    });

    vi.useRealTimers();

    const snap = collector.getSnapshot();
    expect(snap.histograms.turnDurationMs.count).toBe(1);
    expect(snap.histograms.turnDurationMs.sum).toBe(3000);
  });

  it("records permission duration (request → resolve)", () => {
    vi.useFakeTimers();

    collector.recordPermissionRequested("r1");
    vi.advanceTimersByTime(1500);
    collector.recordPermissionResolved("r1", "allow", false);

    vi.useRealTimers();

    const snap = collector.getSnapshot();
    expect(snap.histograms.permissionDurationMs.count).toBe(1);
    expect(snap.histograms.permissionDurationMs.sum).toBe(1500);
    // 1500ms falls in the 2500 bucket
    expect(snap.histograms.permissionDurationMs.p50Bucket).toBe(2500);
  });

  it("returns zeros for empty histograms", () => {
    const snap = collector.getSnapshot();
    expect(snap.histograms.sessionInitTimeMs.count).toBe(0);
    expect(snap.histograms.sessionInitTimeMs.min).toBe(0);
    expect(snap.histograms.sessionInitTimeMs.max).toBe(0);
    expect(snap.histograms.sessionInitTimeMs.avg).toBe(0);
    expect(snap.histograms.sessionInitTimeMs.p50Bucket).toBe(0);
  });

  it("distributes values across correct buckets", () => {
    vi.useFakeTimers();

    // Record values in different buckets: 30ms, 75ms, 200ms, 800ms, 5000ms
    const durations = [30, 75, 200, 800, 5000];
    for (const d of durations) {
      collector.recordTurnStarted(`s-${d}`);
      vi.advanceTimersByTime(d);
      companionBus.emit("message:result", {
        sessionId: `s-${d}`,
        message: { type: "result", data: {} } as any,
      });
    }

    vi.useRealTimers();

    const snap = collector.getSnapshot();
    const h = snap.histograms.turnDurationMs;
    expect(h.count).toBe(5);
    expect(h.min).toBe(30);
    expect(h.max).toBe(5000);
    // 30ms → bucket 50, 75ms → bucket 100, 200ms → bucket 250,
    // 800ms → bucket 1000, 5000ms → bucket 5000
    expect(h.buckets["50"]).toBe(1);
    expect(h.buckets["100"]).toBe(1);
    expect(h.buckets["250"]).toBe(1);
    expect(h.buckets["1000"]).toBe(1);
    expect(h.buckets["5000"]).toBe(1);
  });
});

// ── Gauges ─────────────────────────────────────────────────────────────────

describe("gauges", () => {
  it("computes session phase distribution from gauge provider", () => {
    const phases = new Map<string, SessionPhase>([
      ["s1", "ready"],
      ["s2", "streaming"],
      ["s3", "ready"],
      ["s4", "terminated"],
    ]);
    const provider = createMockGaugeProvider({ phases });

    const snap = collector.getSnapshot(provider);
    expect(snap.gauges.activeSessions).toEqual({
      ready: 2,
      streaming: 1,
      terminated: 1,
    });
    expect(snap.gauges.totalActiveSessions).toBe(3); // excludes terminated
  });

  it("aggregates memory stats from gauge provider", () => {
    const stats = [
      { id: "s1", browsers: 2, historyLen: 100, eventBufferLen: 5, pendingMsgs: 1 },
      { id: "s2", browsers: 1, historyLen: 50, eventBufferLen: 3, pendingMsgs: 0 },
    ];
    const provider = createMockGaugeProvider({ stats });

    const snap = collector.getSnapshot(provider);
    expect(snap.gauges.connectedBrowsers).toBe(3);
    expect(snap.gauges.totalPendingMessages).toBe(1);
    expect(snap.gauges.totalEventBufferSize).toBe(8);
    expect(snap.gauges.totalHistoryMessages).toBe(150);
  });

  it("includes process memory info", () => {
    const snap = collector.getSnapshot();
    expect(snap.gauges.memory.rss).toBeGreaterThan(0);
    expect(snap.gauges.memory.heapUsed).toBeGreaterThan(0);
    expect(snap.gauges.memory.heapTotal).toBeGreaterThan(0);
  });

  it("returns empty gauges when no provider is given", () => {
    const snap = collector.getSnapshot();
    expect(snap.gauges.activeSessions).toEqual({});
    expect(snap.gauges.totalActiveSessions).toBe(0);
    expect(snap.gauges.connectedBrowsers).toBe(0);
  });
});

// ── Snapshot shape ────────────────────────────────────────────────────────

describe("snapshot shape", () => {
  it("returns well-formed MetricsSnapshot", () => {
    const snap = collector.getSnapshot();
    expect(snap.serverUptimeMs).toBeGreaterThanOrEqual(0);
    expect(snap.snapshotAt).toBeGreaterThan(0);
    expect(snap.counters).toBeDefined();
    expect(snap.gauges).toBeDefined();
    expect(snap.histograms).toBeDefined();
    expect(snap.histograms.sessionInitTimeMs).toBeDefined();
    expect(snap.histograms.turnDurationMs).toBeDefined();
    expect(snap.histograms.permissionDurationMs).toBeDefined();
  });
});

// ── Reset ─────────────────────────────────────────────────────────────────

describe("reset", () => {
  it("zeros all counters and histograms", () => {
    // Record some data
    collector.recordSessionCreated("claude");
    collector.recordRelaunchAttempted();
    collector.recordMessageProcessed("assistant");
    collector.recordError("parse_error");
    collector.recordWsConnection("cli", "open");

    collector.reset();

    const snap = collector.getSnapshot();
    expect(snap.counters.sessionsCreated).toEqual({});
    expect(snap.counters.autoRelaunches).toEqual({ attempted: 0, succeeded: 0, exhausted: 0 });
    expect(snap.counters.messagesProcessed).toEqual({});
    expect(snap.counters.errors).toEqual({});
    expect(snap.counters.wsConnections).toEqual({
      cliOpened: 0, cliClosed: 0, browserOpened: 0, browserClosed: 0,
    });
    expect(snap.histograms.sessionInitTimeMs.count).toBe(0);
    expect(snap.histograms.turnDurationMs.count).toBe(0);
    expect(snap.histograms.permissionDurationMs.count).toBe(0);
  });
});

// ── Edge cases ────────────────────────────────────────────────────────────

describe("edge cases", () => {
  it("handles permission resolve for unknown requestId without crashing", () => {
    // Should not throw — just increments the counter without recording duration
    collector.recordPermissionResolved("unknown-id", "allow", false);

    const snap = collector.getSnapshot();
    expect(snap.counters.permissionRequests.userApproved).toBe(1);
    expect(snap.histograms.permissionDurationMs.count).toBe(0);
  });

  it("cleans up timing state on session exit", () => {
    collector.recordSessionSpawned("s1");
    collector.recordTurnStarted("s1");

    companionBus.emit("session:exited", { sessionId: "s1", exitCode: 0 });

    // Subsequent result should not record a turn duration (timing state was cleaned up)
    companionBus.emit("message:result", {
      sessionId: "s1",
      message: { type: "result", data: {} } as any,
    });

    const snap = collector.getSnapshot();
    expect(snap.histograms.turnDurationMs.count).toBe(0);
  });

  it("cleans up orphaned permission timers on session exit", () => {
    // Record a permission request tied to a session, then exit without resolving
    collector.recordPermissionRequested("perm-1", "s1");
    collector.recordPermissionRequested("perm-2", "s1");
    collector.recordPermissionRequested("perm-3", "s2"); // different session

    companionBus.emit("session:exited", { sessionId: "s1", exitCode: 0 });

    // Resolving perm-1 and perm-2 should NOT record a duration (cleaned up on exit)
    collector.recordPermissionResolved("perm-1", "allow", false);
    collector.recordPermissionResolved("perm-2", "deny", false);

    const snap = collector.getSnapshot();
    // No duration should have been recorded for perm-1/perm-2
    expect(snap.histograms.permissionDurationMs.count).toBe(0);

    // perm-3 from s2 should still be resolvable
    collector.recordPermissionResolved("perm-3", "allow", false);
    const snap2 = collector.getSnapshot();
    expect(snap2.histograms.permissionDurationMs.count).toBe(1);
  });

  it("handles very large histogram values (overflow bucket)", () => {
    vi.useFakeTimers();

    collector.recordTurnStarted("s1");
    vi.advanceTimersByTime(120_000); // 2 minutes
    companionBus.emit("message:result", {
      sessionId: "s1",
      message: { type: "result", data: {} } as any,
    });

    vi.useRealTimers();

    const snap = collector.getSnapshot();
    expect(snap.histograms.turnDurationMs.buckets["Infinity"]).toBe(1);
  });
});
