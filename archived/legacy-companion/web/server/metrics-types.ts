// Type definitions for the Companion runtime metrics system.
// Defines the shape of the JSON snapshot returned by GET /api/metrics.

import type { SessionPhase } from "./session-state-machine.js";

// ── Snapshot (top-level) ───────────────────────────────────────────────────

export interface MetricsSnapshot {
  /** Milliseconds since server started. */
  serverUptimeMs: number;
  /** Unix timestamp (ms) when this snapshot was taken. */
  snapshotAt: number;
  counters: CounterMetrics;
  gauges: GaugeMetrics;
  histograms: HistogramMetrics;
}

// ── Counters (monotonically increasing) ────────────────────────────────────

export interface CounterMetrics {
  /** Sessions created, keyed by backend type ("claude" | "codex"). */
  sessionsCreated: Record<string, number>;
  /** Sessions terminated, keyed by exit code (stringified). */
  sessionsTerminated: Record<string, number>;
  /** Auto-relaunch tracking. */
  autoRelaunches: {
    attempted: number;
    succeeded: number;
    exhausted: number;
  };
  /** Messages processed by the bridge, keyed by message type. */
  messagesProcessed: Record<string, number>;
  /** Permission request flow tracking. */
  permissionRequests: {
    total: number;
    autoApproved: number;
    autoDenied: number;
    userApproved: number;
    userDenied: number;
  };
  /** Errors by category (e.g. "invalid_state_transition", "parse_error"). */
  errors: Record<string, number>;
  /** State machine transitions, keyed by "from→to". */
  stateTransitions: Record<string, number>;
  /** WebSocket connection events. */
  wsConnections: {
    cliOpened: number;
    cliClosed: number;
    browserOpened: number;
    browserClosed: number;
  };
}

// ── Gauges (point-in-time values) ──────────────────────────────────────────

export interface GaugeMetrics {
  /** Active sessions grouped by phase. */
  activeSessions: Partial<Record<SessionPhase, number>>;
  /** Total non-terminated sessions. */
  totalActiveSessions: number;
  /** Total connected browser WebSockets across all sessions. */
  connectedBrowsers: number;
  /** Total pending messages queued across all sessions. */
  totalPendingMessages: number;
  /** Total event buffer entries across all sessions. */
  totalEventBufferSize: number;
  /** Total message history entries across all sessions. */
  totalHistoryMessages: number;
  /** Process memory usage in bytes. */
  memory: {
    rss: number;
    heapUsed: number;
    heapTotal: number;
    external: number;
  };
}

// ── Histograms (distributions) ─────────────────────────────────────────────

export interface HistogramSnapshot {
  /** Number of observations. */
  count: number;
  /** Sum of all observed values. */
  sum: number;
  /** Minimum observed value (0 if no observations). */
  min: number;
  /** Maximum observed value (0 if no observations). */
  max: number;
  /** Average (0 if no observations). */
  avg: number;
  /** Approximate bucket boundary for the 50th percentile. */
  p50Bucket: number;
  /** Approximate bucket boundary for the 95th percentile. */
  p95Bucket: number;
  /** Approximate bucket boundary for the 99th percentile. */
  p99Bucket: number;
  /** Cumulative counts per bucket boundary (stringified keys). */
  buckets: Record<string, number>;
}

export interface HistogramMetrics {
  /** Session initialization time: spawn → ready (ms). */
  sessionInitTimeMs: HistogramSnapshot;
  /** Turn duration: user message → result (ms). */
  turnDurationMs: HistogramSnapshot;
  /** Permission request duration: request → response (ms). */
  permissionDurationMs: HistogramSnapshot;
}
