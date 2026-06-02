// In-memory runtime metrics collector for the Companion server.
// Subscribes to the event bus and provides direct instrumentation methods.
// All data is in-memory — resets on server restart.

import { companionBus } from "./event-bus.js";
import type { SessionPhase } from "./session-state-machine.js";
import type {
  MetricsSnapshot,
  HistogramSnapshot,
  CounterMetrics,
  GaugeMetrics,
} from "./metrics-types.js";

// ── Histogram bucket boundaries (ms) ──────────────────────────────────────

const TIMING_BUCKETS_MS = [50, 100, 250, 500, 1_000, 2_500, 5_000, 10_000, 30_000, 60_000] as const;

// ── Internal histogram data structure ─────────────────────────────────────

interface Histogram {
  count: number;
  sum: number;
  min: number;
  max: number;
  /** Frequency bucket counts. buckets[i] = count of values in (TIMING_BUCKETS_MS[i-1], TIMING_BUCKETS_MS[i]]. */
  buckets: number[];
}

function createHistogram(): Histogram {
  return {
    count: 0,
    sum: 0,
    min: Infinity,
    max: -Infinity,
    buckets: new Array(TIMING_BUCKETS_MS.length + 1).fill(0), // +1 for +Infinity bucket
  };
}

function recordHistogramValue(h: Histogram, value: number): void {
  h.count++;
  h.sum += value;
  if (value < h.min) h.min = value;
  if (value > h.max) h.max = value;

  // Find the appropriate bucket
  for (let i = 0; i < TIMING_BUCKETS_MS.length; i++) {
    if (value <= TIMING_BUCKETS_MS[i]) {
      h.buckets[i]++;
      return;
    }
  }
  // Falls into the +Infinity bucket
  h.buckets[TIMING_BUCKETS_MS.length]++;
}

function serializeHistogram(h: Histogram): HistogramSnapshot {
  const buckets: Record<string, number> = {};
  for (let i = 0; i < TIMING_BUCKETS_MS.length; i++) {
    buckets[String(TIMING_BUCKETS_MS[i])] = h.buckets[i];
  }
  buckets["Infinity"] = h.buckets[TIMING_BUCKETS_MS.length];

  return {
    count: h.count,
    sum: h.sum,
    min: h.count > 0 ? h.min : 0,
    max: h.count > 0 ? h.max : 0,
    avg: h.count > 0 ? Math.round(h.sum / h.count) : 0,
    p50Bucket: computePercentileBucket(h, 0.5),
    p95Bucket: computePercentileBucket(h, 0.95),
    p99Bucket: computePercentileBucket(h, 0.99),
    buckets,
  };
}

/** Approximate the bucket boundary for a given percentile. */
function computePercentileBucket(h: Histogram, p: number): number {
  if (h.count === 0) return 0;
  const target = Math.ceil(h.count * p);
  let cumulative = 0;
  for (let i = 0; i < TIMING_BUCKETS_MS.length; i++) {
    cumulative += h.buckets[i];
    if (cumulative >= target) return TIMING_BUCKETS_MS[i];
  }
  return Infinity;
}

// ── Gauge data provider interface ─────────────────────────────────────────

/** Minimal interface for computing gauges at snapshot time. */
export interface GaugeDataProvider {
  getSessionMemoryStats(): { id: string; browsers: number; historyLen: number; eventBufferLen: number; pendingMsgs: number }[];
  getSessionPhases(): Map<string, SessionPhase>;
}

// ── MetricsCollector ──────────────────────────────────────────────────────

export class MetricsCollector {
  private startedAt: number;

  // Counters
  private sessionsCreated = new Map<string, number>();
  private sessionsTerminated = new Map<string, number>();
  private autoRelaunches = { attempted: 0, succeeded: 0, exhausted: 0 };
  private messagesProcessed = new Map<string, number>();
  private permissions = { total: 0, autoApproved: 0, autoDenied: 0, userApproved: 0, userDenied: 0 };
  private errors = new Map<string, number>();
  private stateTransitions = new Map<string, number>();
  private wsConnections = { cliOpened: 0, cliClosed: 0, browserOpened: 0, browserClosed: 0 };

  // Histograms
  private sessionInitTime = createHistogram();
  private turnDuration = createHistogram();
  private permissionDuration = createHistogram();

  // Ephemeral timing state
  private sessionSpawnedAt = new Map<string, number>();
  private turnStartedAt = new Map<string, number>();
  private permissionRequestedAt = new Map<string, number>();
  /** Maps requestId → sessionId so permission timers can be cleaned up on session exit. */
  private permissionRequestToSession = new Map<string, string>();

  // Event bus unsubscribers (for cleanup in tests)
  private unsubscribers: (() => void)[] = [];

  constructor() {
    this.startedAt = Date.now();
    this.wireEventBus();
  }

  // ── Event bus wiring ──────────────────────────────────────────────────

  private wireEventBus(): void {
    this.unsubscribers.push(
      companionBus.on("session:phase-changed", ({ sessionId, from, to }) => {
        // Count state transitions
        const key = `${from}→${to}`;
        this.stateTransitions.set(key, (this.stateTransitions.get(key) ?? 0) + 1);

        // Compute session init time: initializing → ready
        if (to === "ready" && (from === "initializing" || from === "starting")) {
          const spawned = this.sessionSpawnedAt.get(sessionId);
          if (spawned != null) {
            recordHistogramValue(this.sessionInitTime, Date.now() - spawned);
            this.sessionSpawnedAt.delete(sessionId);
          }
        }
      }),

      companionBus.on("session:exited", ({ sessionId, exitCode }) => {
        const key = String(exitCode ?? "null");
        this.sessionsTerminated.set(key, (this.sessionsTerminated.get(key) ?? 0) + 1);

        // Clean up ephemeral timing state
        this.sessionSpawnedAt.delete(sessionId);
        this.turnStartedAt.delete(sessionId);

        // Evict orphaned permission timers for this session
        for (const [reqId, sid] of this.permissionRequestToSession) {
          if (sid === sessionId) {
            this.permissionRequestedAt.delete(reqId);
            this.permissionRequestToSession.delete(reqId);
          }
        }
      }),

      companionBus.on("message:result", ({ sessionId }) => {
        const started = this.turnStartedAt.get(sessionId);
        if (started != null) {
          recordHistogramValue(this.turnDuration, Date.now() - started);
          this.turnStartedAt.delete(sessionId);
        }
      }),
    );
  }

  // ── Direct instrumentation methods ────────────────────────────────────

  recordSessionCreated(backendType: string): void {
    this.sessionsCreated.set(backendType, (this.sessionsCreated.get(backendType) ?? 0) + 1);
  }

  recordSessionSpawned(sessionId: string): void {
    this.sessionSpawnedAt.set(sessionId, Date.now());
  }

  recordRelaunchAttempted(): void {
    this.autoRelaunches.attempted++;
  }

  recordRelaunchSucceeded(): void {
    this.autoRelaunches.succeeded++;
  }

  recordRelaunchExhausted(): void {
    this.autoRelaunches.exhausted++;
  }

  recordTurnStarted(sessionId: string): void {
    this.turnStartedAt.set(sessionId, Date.now());
  }

  recordPermissionRequested(requestId: string, sessionId?: string): void {
    this.permissions.total++;
    this.permissionRequestedAt.set(requestId, Date.now());
    if (sessionId) {
      this.permissionRequestToSession.set(requestId, sessionId);
    }
  }

  recordPermissionResolved(requestId: string, behavior: "allow" | "deny", isAutomatic: boolean): void {
    if (isAutomatic) {
      if (behavior === "allow") this.permissions.autoApproved++;
      else this.permissions.autoDenied++;
    } else {
      if (behavior === "allow") this.permissions.userApproved++;
      else this.permissions.userDenied++;
    }

    const requested = this.permissionRequestedAt.get(requestId);
    if (requested != null) {
      recordHistogramValue(this.permissionDuration, Date.now() - requested);
      this.permissionRequestedAt.delete(requestId);
      this.permissionRequestToSession.delete(requestId);
    }
  }

  recordWsConnection(kind: "cli" | "browser", event: "open" | "close"): void {
    if (kind === "cli") {
      if (event === "open") this.wsConnections.cliOpened++;
      else this.wsConnections.cliClosed++;
    } else {
      if (event === "open") this.wsConnections.browserOpened++;
      else this.wsConnections.browserClosed++;
    }
  }

  recordMessageProcessed(messageType: string): void {
    this.messagesProcessed.set(messageType, (this.messagesProcessed.get(messageType) ?? 0) + 1);
  }

  recordError(category: string): void {
    this.errors.set(category, (this.errors.get(category) ?? 0) + 1);
  }

  // ── Snapshot ──────────────────────────────────────────────────────────

  getSnapshot(gaugeProvider?: GaugeDataProvider): MetricsSnapshot {
    const counters = this.buildCounters();
    const gauges = this.buildGauges(gaugeProvider);
    const histograms = {
      sessionInitTimeMs: serializeHistogram(this.sessionInitTime),
      turnDurationMs: serializeHistogram(this.turnDuration),
      permissionDurationMs: serializeHistogram(this.permissionDuration),
    };

    return {
      serverUptimeMs: Date.now() - this.startedAt,
      snapshotAt: Date.now(),
      counters,
      gauges,
      histograms,
    };
  }

  private buildCounters(): CounterMetrics {
    return {
      sessionsCreated: Object.fromEntries(this.sessionsCreated),
      sessionsTerminated: Object.fromEntries(this.sessionsTerminated),
      autoRelaunches: { ...this.autoRelaunches },
      messagesProcessed: Object.fromEntries(this.messagesProcessed),
      permissionRequests: { ...this.permissions },
      errors: Object.fromEntries(this.errors),
      stateTransitions: Object.fromEntries(this.stateTransitions),
      wsConnections: { ...this.wsConnections },
    };
  }

  private buildGauges(provider?: GaugeDataProvider): GaugeMetrics {
    const activeSessions: Partial<Record<SessionPhase, number>> = {};
    let totalActive = 0;
    let connectedBrowsers = 0;
    let totalPending = 0;
    let totalEventBuffer = 0;
    let totalHistory = 0;

    if (provider) {
      // Compute phase distribution
      for (const [, phase] of provider.getSessionPhases()) {
        activeSessions[phase] = (activeSessions[phase] ?? 0) + 1;
        if (phase !== "terminated") totalActive++;
      }

      // Compute memory stats
      for (const stats of provider.getSessionMemoryStats()) {
        connectedBrowsers += stats.browsers;
        totalPending += stats.pendingMsgs;
        totalEventBuffer += stats.eventBufferLen;
        totalHistory += stats.historyLen;
      }
    }

    const mem = process.memoryUsage();

    return {
      activeSessions,
      totalActiveSessions: totalActive,
      connectedBrowsers,
      totalPendingMessages: totalPending,
      totalEventBufferSize: totalEventBuffer,
      totalHistoryMessages: totalHistory,
      memory: {
        rss: mem.rss,
        heapUsed: mem.heapUsed,
        heapTotal: mem.heapTotal,
        external: mem.external,
      },
    };
  }

  // ── Reset (for testing) ───────────────────────────────────────────────

  reset(): void {
    this.startedAt = Date.now();
    this.sessionsCreated.clear();
    this.sessionsTerminated.clear();
    this.autoRelaunches = { attempted: 0, succeeded: 0, exhausted: 0 };
    this.messagesProcessed.clear();
    this.permissions = { total: 0, autoApproved: 0, autoDenied: 0, userApproved: 0, userDenied: 0 };
    this.errors.clear();
    this.stateTransitions.clear();
    this.wsConnections = { cliOpened: 0, cliClosed: 0, browserOpened: 0, browserClosed: 0 };
    this.sessionInitTime = createHistogram();
    this.turnDuration = createHistogram();
    this.permissionDuration = createHistogram();
    this.sessionSpawnedAt.clear();
    this.turnStartedAt.clear();
    this.permissionRequestedAt.clear();
    this.permissionRequestToSession.clear();
  }

  /** Unsubscribe from all event bus listeners. */
  destroy(): void {
    for (const unsub of this.unsubscribers) unsub();
    this.unsubscribers = [];
  }
}

/** Singleton instance used by the server. */
export const metricsCollector = new MetricsCollector();
