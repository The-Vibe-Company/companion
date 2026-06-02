import type { CLIMessage } from "./session-types.js";

// ─── CLI Ingest Pipeline ────────────────────────────────────────────────────
// Pure functions for parsing and deduplicating CLI (NDJSON) messages.
// Extracted from WsBridge.handleCLIMessage to enable isolated testing
// of reconnect/replay deduplication scenarios.

/** State needed for CLI message deduplication. Matches a subset of Session. */
export interface CLIDedupState {
  recentCLIMessageHashes: string[];
  recentCLIMessageHashSet: Set<string>;
}

/**
 * Parse raw NDJSON data into individual line strings.
 * Splits on newlines and filters blank lines.
 */
export function parseNDJSON(raw: string | Buffer): string[] {
  const data = typeof raw === "string" ? raw : raw.toString("utf-8");
  return data.split("\n").filter((l) => l.trim());
}

/**
 * Check if a CLI message is a duplicate based on a rolling hash window.
 * On WS reconnect, the CLI replays in-flight messages; this dedup prevents
 * duplicates from reaching downstream handlers.
 *
 * - `assistant`, `result`, `system` messages: deduped by content hash (Bun.hash)
 * - `stream_event` messages: deduped by their stable `uuid` field
 * - All other types (keep_alive, control_request, tool_progress, etc.): never deduped
 *
 * Returns true if the message is a duplicate and should be skipped.
 * Mutates the dedupState window as a side effect.
 */
export function isDuplicateCLIMessage(
  msg: CLIMessage,
  rawLine: string,
  state: CLIDedupState,
  windowSize: number,
): boolean {
  if (msg.type === "assistant" || msg.type === "result" || msg.type === "system") {
    // Namespace with "h:" prefix to prevent collisions with uuid-based keys
    const key = `h:${Bun.hash(rawLine).toString(36)}`;
    if (state.recentCLIMessageHashSet.has(key)) {
      return true;
    }
    state.recentCLIMessageHashes.push(key);
    state.recentCLIMessageHashSet.add(key);
    while (state.recentCLIMessageHashes.length > windowSize) {
      const old = state.recentCLIMessageHashes.shift()!;
      state.recentCLIMessageHashSet.delete(old);
    }
    return false;
  }

  if (msg.type === "stream_event" && (msg as { uuid?: string }).uuid) {
    // Namespace with "u:" prefix to prevent collisions with hash-based keys.
    // Current CLI versions (1.0+) always provide UUIDs on stream_event messages.
    // UUID-less stream_events from older protocol versions fall through to no-dedup below.
    const key = `u:${(msg as { uuid: string }).uuid}`;
    if (state.recentCLIMessageHashSet.has(key)) {
      return true;
    }
    state.recentCLIMessageHashes.push(key);
    state.recentCLIMessageHashSet.add(key);
    while (state.recentCLIMessageHashes.length > windowSize) {
      const old = state.recentCLIMessageHashes.shift()!;
      state.recentCLIMessageHashSet.delete(old);
    }
    return false;
  }

  // All other message types (keep_alive, control_request, tool_progress, etc.)
  // are never considered duplicates — they're either stateless or handled by
  // separate mechanisms. stream_event without uuid also falls through here;
  // current CLI versions (1.0+) always provide UUIDs, but older protocol
  // versions may not. In that case, reconnect replay could produce duplicate
  // stream content in the UI — acceptable since stream_events are transient
  // and the final assistant message is always deduplicated.
  return false;
}
