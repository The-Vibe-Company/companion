import type { ServerWebSocket } from "bun";
import type { BrowserIncomingMessage } from "./session-types.js";
import type { Session, SocketData } from "./ws-bridge-types.js";
import type { RecorderManager } from "./recorder.js";
import { sequenceEvent } from "./ws-bridge-replay.js";

// ─── Publish Pipeline ───────────────────────────────────────────────────────
// Transport functions for sending messages to CLI and browser sockets.
// Extracted from WsBridge to enable isolated testing of message delivery,
// sequencing, and recording behavior.

export const EVENT_BUFFER_LIMIT = 600;

/**
 * Broadcast a message to all connected browsers for a session.
 * Assigns a monotonic sequence number via sequenceEvent, records the
 * outgoing message, and sends to every browser socket (removing broken ones).
 *
 * Note: sequenceEvent internally calls persistFn when buffering events.
 * Callers that also call persistSession after broadcastToBrowsers will
 * trigger a redundant (but harmless) debounced save. This is intentional —
 * the caller-side persist covers state mutations beyond the event buffer
 * (e.g. messageHistory, pendingPermissions), while the internal persist
 * covers the event buffer/seq counters. SessionStore's debouncer coalesces
 * them into a single write.
 */
export function broadcastToBrowsers(
  session: Session,
  msg: BrowserIncomingMessage,
  opts: {
    eventBufferLimit: number;
    recorder: RecorderManager | null;
    persistFn: (session: Session) => void;
  },
): void {
  // Warn when messages that should be visible to users are broadcast to 0 browsers
  if (
    session.browserSockets.size === 0
    && (msg.type === "assistant" || msg.type === "stream_event" || msg.type === "result")
  ) {
    console.log(
      `[ws-bridge] ⚠ Broadcasting ${msg.type} to 0 browsers for session ${session.id} (stored in history: ${msg.type === "assistant" || msg.type === "result"})`,
    );
  }

  const json = JSON.stringify(
    sequenceEvent(session, msg, opts.eventBufferLimit, opts.persistFn),
  );

  // Record raw outgoing browser message
  opts.recorder?.record(
    session.id, "out", json, "browser", session.backendType, session.state.cwd,
  );

  for (const ws of session.browserSockets) {
    try {
      ws.send(json);
    } catch {
      session.browserSockets.delete(ws);
    }
  }
}

/**
 * Send a message to a single browser socket (no sequencing).
 * Used for replay, session_init, and message_history — messages that
 * should NOT go through the event buffer.
 */
export function sendToBrowser(
  ws: ServerWebSocket<SocketData>,
  msg: BrowserIncomingMessage,
): void {
  try {
    ws.send(JSON.stringify(msg));
  } catch {
    // Socket will be cleaned up on close
  }
}

