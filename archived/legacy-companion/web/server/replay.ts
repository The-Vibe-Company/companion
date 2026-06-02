/**
 * Replay utility for session recordings.
 *
 * Loads JSONL recording files and replays them through WsBridge or CodexAdapter
 * to produce browser messages. Used in tests to validate that message processing
 * produces the expected output from recorded real sessions.
 */

import { readFileSync } from "node:fs";
import type { RecordingHeader, RecordingEntry } from "./recorder.js";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface Recording {
  header: RecordingHeader;
  entries: RecordingEntry[];
}

// ─── Loading ─────────────────────────────────────────────────────────────────

/**
 * Load a JSONL recording file. Returns the parsed header and all entries.
 * Throws if the file is missing a valid header.
 */
export function loadRecording(path: string): Recording {
  const content = readFileSync(path, "utf-8");
  const lines = content.split("\n").filter((l) => l.trim());

  if (lines.length === 0) {
    throw new Error("Recording file is empty");
  }

  const header = JSON.parse(lines[0]) as RecordingHeader;
  if (!header._header || header.version !== 1) {
    throw new Error("Invalid recording header: missing _header or version !== 1");
  }

  const entries: RecordingEntry[] = [];
  for (let i = 1; i < lines.length; i++) {
    try {
      entries.push(JSON.parse(lines[i]) as RecordingEntry);
    } catch {
      // Skip malformed lines — recording might have been truncated
    }
  }

  return { header, entries };
}

// ─── Replay helpers ──────────────────────────────────────────────────────────

/**
 * Filter recording entries by direction and channel.
 * Useful for extracting only incoming CLI messages for replay.
 */
export function filterEntries(
  entries: RecordingEntry[],
  dir: "in" | "out",
  channel: "cli" | "browser",
): RecordingEntry[] {
  return entries.filter((e) => e.dir === dir && e.ch === channel);
}

/**
 * Get all outgoing browser messages from a recording.
 * These represent what the server actually sent to browsers during the recorded session.
 */
export function getExpectedBrowserMessages(entries: RecordingEntry[]): string[] {
  return filterEntries(entries, "out", "browser").map((e) => e.raw);
}

/**
 * Get all incoming CLI messages from a recording.
 * These are the raw NDJSON/JSON-RPC lines received from the backend.
 */
export function getIncomingCLIMessages(entries: RecordingEntry[]): string[] {
  return filterEntries(entries, "in", "cli").map((e) => e.raw);
}
