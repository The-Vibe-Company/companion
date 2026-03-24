/**
 * Disconnection diagnostics for recorded sessions.
 *
 * Analyzes recording entries for connection lifecycle events and data gaps
 * to identify disconnection patterns and potential causes.
 */

import type { Recording } from "../replay.js";
import type { RecordingEntry } from "../recorder.js";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface TimelineEntry {
  ts: number;
  event: string;
  channel: "cli" | "browser";
  detail?: string;
}

export interface DisconnectionEvent {
  ts: number;
  channel: "cli" | "browser";
  closeCode?: number;
  closeReason?: string;
  reconnectedAt?: number;
  gapMs: number;
  messagesLostEstimate: number;
}

export interface DisconnectionReport {
  sessionId: string;
  backendType: string;
  totalDuration: number;
  totalDisconnections: number;
  disconnections: DisconnectionEvent[];
  patterns: string[];
  dataGaps: DataGap[];
}

export interface DataGap {
  startTs: number;
  endTs: number;
  gapMs: number;
  channel: "cli" | "browser";
  messagesBefore: number;
  messagesAfter: number;
}

// ─── Constants ───────────────────────────────────────────────────────────────

/** Gaps longer than this in CLI messages suggest a disconnection. */
const CLI_GAP_THRESHOLD_MS = 30_000;
/** Minimum number of disconnections to detect a pattern. */
const PATTERN_MIN_COUNT = 3;
/** Tolerance for regular interval detection (±20%). */
const INTERVAL_TOLERANCE = 0.2;

// ─── Analysis ────────────────────────────────────────────────────────────────

/**
 * Analyze a recording for disconnection patterns.
 *
 * Works with both legacy recordings (data messages only) and enhanced
 * recordings that include connection lifecycle events.
 */
export function analyzeDisconnections(recording: Recording): DisconnectionReport {
  const entries = recording.entries;
  const header = recording.header;

  // Build timeline from both lifecycle events and data gap analysis
  const timeline = buildTimeline(recording);
  const disconnections = detectDisconnections(entries, timeline);
  const dataGaps = detectDataGaps(entries);
  const patterns = detectPatterns(disconnections, dataGaps);

  const firstTs = entries[0]?.ts ?? header.started_at;
  const lastTs = entries[entries.length - 1]?.ts ?? firstTs;

  return {
    sessionId: header.session_id,
    backendType: header.backend_type,
    totalDuration: lastTs - firstTs,
    totalDisconnections: disconnections.length,
    disconnections,
    patterns,
    dataGaps,
  };
}

/**
 * Build a timeline of connection events from a recording.
 *
 * Extracts both explicit lifecycle events (ws_open, ws_close, etc.) from
 * enhanced recordings and infers events from data gaps in legacy recordings.
 */
export function buildTimeline(recording: Recording): TimelineEntry[] {
  const timeline: TimelineEntry[] = [];

  for (const entry of recording.entries) {
    // Enhanced recordings have explicit lifecycle events
    const enhanced = entry as RecordingEntry & { event?: string; meta?: Record<string, unknown> };
    if (enhanced.event) {
      timeline.push({
        ts: entry.ts,
        event: enhanced.event,
        channel: entry.ch,
        detail: enhanced.meta ? JSON.stringify(enhanced.meta) : undefined,
      });
      continue;
    }

    // For data messages, track key protocol events
    if (entry.dir === "out" && entry.ch === "browser") {
      try {
        const msg = JSON.parse(entry.raw);
        if (msg.type === "cli_connected") {
          timeline.push({ ts: entry.ts, event: "cli_connected", channel: "cli" });
        } else if (msg.type === "cli_disconnected") {
          timeline.push({ ts: entry.ts, event: "cli_disconnected", channel: "cli" });
        } else if (msg.type === "session_init") {
          timeline.push({ ts: entry.ts, event: "session_init", channel: "cli" });
        }
      } catch {
        // Skip unparseable
      }
    }
  }

  return timeline.sort((a, b) => a.ts - b.ts);
}

// ─── Internal helpers ────────────────────────────────────────────────────────

function detectDisconnections(
  entries: RecordingEntry[],
  timeline: TimelineEntry[],
): DisconnectionEvent[] {
  const disconnections: DisconnectionEvent[] = [];

  // From explicit timeline events
  for (let i = 0; i < timeline.length; i++) {
    const event = timeline[i];
    if (event.event === "ws_close" || event.event === "cli_disconnected") {
      // Find next reconnect/connect event on same channel
      let reconnectedAt: number | undefined;
      for (let j = i + 1; j < timeline.length; j++) {
        if (
          timeline[j].channel === event.channel &&
          (timeline[j].event === "ws_open" || timeline[j].event === "cli_connected" || timeline[j].event === "reconnect_success")
        ) {
          reconnectedAt = timeline[j].ts;
          break;
        }
      }

      // Estimate messages lost during the gap
      let messagesLost = 0;
      if (reconnectedAt) {
        // Count messages that arrived on the other channel during the gap
        messagesLost = entries.filter(
          (e) =>
            e.ts > event.ts &&
            e.ts < reconnectedAt! &&
            e.ch !== event.channel,
        ).length;
      }

      let meta: Record<string, unknown> | undefined;
      try {
        meta = event.detail ? JSON.parse(event.detail) : undefined;
      } catch {
        // ignore
      }

      disconnections.push({
        ts: event.ts,
        channel: event.channel,
        closeCode: meta?.code as number | undefined,
        closeReason: meta?.reason as string | undefined,
        reconnectedAt,
        gapMs: reconnectedAt ? reconnectedAt - event.ts : 0,
        messagesLostEstimate: messagesLost,
      });
    }
  }

  // Deduplicate: ws_close and cli_disconnected for the same outage.
  // Only dedup if the second disconnect happens before the first one reconnected.
  const deduped: DisconnectionEvent[] = [];
  for (const d of disconnections) {
    const isDuplicate = deduped.some(
      (existing) =>
        existing.channel === d.channel &&
        // Only dedup if this disconnect happened before the previous one reconnected
        // (i.e. same outage, not a new one after recovery)
        (!existing.reconnectedAt || d.ts < existing.reconnectedAt),
    );
    if (!isDuplicate) deduped.push(d);
  }
  return deduped;
}

function detectDataGaps(entries: RecordingEntry[]): DataGap[] {
  const gaps: DataGap[] = [];

  // Group entries by channel
  const cliEntries = entries.filter((e) => e.ch === "cli" && e.dir === "in" && !e.event);
  const browserEntries = entries.filter((e) => e.ch === "browser" && e.dir === "in" && !e.event);

  for (const [channel, channelEntries] of [
    ["cli", cliEntries],
    ["browser", browserEntries],
  ] as const) {
    for (let i = 1; i < channelEntries.length; i++) {
      const gapMs = channelEntries[i].ts - channelEntries[i - 1].ts;
      if (gapMs > CLI_GAP_THRESHOLD_MS) {
        gaps.push({
          startTs: channelEntries[i - 1].ts,
          endTs: channelEntries[i].ts,
          gapMs,
          channel,
          messagesBefore: i,
          messagesAfter: channelEntries.length - i,
        });
      }
    }
  }

  return gaps.sort((a, b) => a.startTs - b.startTs);
}

function detectPatterns(
  disconnections: DisconnectionEvent[],
  dataGaps: DataGap[],
): string[] {
  const patterns: string[] = [];

  // Pattern: Keep-alive failure (regular interval disconnections)
  if (disconnections.length >= PATTERN_MIN_COUNT) {
    const cliDisconnections = disconnections.filter((d) => d.channel === "cli");
    if (cliDisconnections.length >= PATTERN_MIN_COUNT) {
      const intervals = [];
      for (let i = 1; i < cliDisconnections.length; i++) {
        intervals.push(cliDisconnections[i].ts - cliDisconnections[i - 1].ts);
      }
      const avgInterval = intervals.reduce((a, b) => a + b, 0) / intervals.length;
      const allClose = intervals.every(
        (iv) => Math.abs(iv - avgInterval) / avgInterval < INTERVAL_TOLERANCE,
      );
      if (allClose) {
        patterns.push(
          `Regular CLI disconnections every ~${Math.round(avgInterval / 1000)}s — possible keep-alive or timeout issue`,
        );
      }
    }
  }

  // Pattern: Rapid reconnect cycling
  const rapidReconnects = disconnections.filter(
    (d) => d.reconnectedAt && d.gapMs < 5000,
  );
  if (rapidReconnects.length >= PATTERN_MIN_COUNT) {
    patterns.push(
      `${rapidReconnects.length} rapid reconnections (< 5s gap) — possible flapping connection`,
    );
  }

  // Pattern: Large data gaps without explicit disconnect events
  const unexplainedGaps = dataGaps.filter((g) => {
    // Check if any disconnection event falls within this gap
    return !disconnections.some(
      (d) => d.ts >= g.startTs && d.ts <= g.endTs,
    );
  });
  if (unexplainedGaps.length > 0) {
    patterns.push(
      `${unexplainedGaps.length} data gap(s) without recorded disconnect events — possible silent connection drops`,
    );
  }

  // Pattern: Asymmetric disconnection (CLI drops but browser stays)
  const cliOnly = disconnections.filter((d) => d.channel === "cli");
  const browserOnly = disconnections.filter((d) => d.channel === "browser");
  if (cliOnly.length > 0 && browserOnly.length === 0) {
    patterns.push(
      `All ${cliOnly.length} disconnection(s) are CLI-side — browser connections are stable. Check CLI process health.`,
    );
  } else if (browserOnly.length > 0 && cliOnly.length === 0) {
    patterns.push(
      `All ${browserOnly.length} disconnection(s) are browser-side — CLI connection is stable. Check network/proxy.`,
    );
  }

  if (patterns.length === 0 && disconnections.length === 0 && dataGaps.length === 0) {
    patterns.push("No disconnection issues detected in this recording.");
  }

  return patterns;
}
