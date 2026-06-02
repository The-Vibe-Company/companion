import type { BrowserOutgoingMessage } from "./session-types.js";
import type { Session } from "./ws-bridge-types.js";
import {
  isDuplicateClientMessage,
  rememberClientMessage,
} from "./ws-bridge-replay.js";

// ─── Browser Ingest Pipeline ────────────────────────────────────────────────
// Pure functions for parsing and deduplicating browser WebSocket messages.
// Extracted from WsBridge.handleBrowserMessage and routeBrowserMessage
// to enable isolated testing of idempotent message scenarios.

/** Message types that support client_msg_id-based deduplication. */
export const IDEMPOTENT_BROWSER_MESSAGE_TYPES: ReadonlySet<string> = new Set([
  "user_message",
  "permission_response",
  "interrupt",
  "set_model",
  "set_permission_mode",
  "mcp_get_status",
  "mcp_toggle",
  "mcp_reconnect",
  "mcp_set_servers",
  "set_ai_validation",
]);

/**
 * Parse a raw browser WebSocket message into a typed BrowserOutgoingMessage.
 * Returns null if parsing fails (malformed JSON).
 */
export function parseBrowserMessage(raw: string | Buffer): BrowserOutgoingMessage | null {
  const data = typeof raw === "string" ? raw : raw.toString("utf-8");
  try {
    return JSON.parse(data) as BrowserOutgoingMessage;
  } catch {
    console.warn(`[ws-bridge] Failed to parse browser message: ${data.substring(0, 200)}`);
    return null;
  }
}

/**
 * Check if a browser message is a duplicate based on client_msg_id.
 * Returns true if the message should be skipped.
 *
 * Only checks messages whose type is in `idempotentTypes` and that have
 * a non-empty `client_msg_id` field. For non-idempotent types or messages
 * without client_msg_id, always returns false.
 *
 * If not a duplicate, remembers the client_msg_id for future dedup checks.
 */
export function deduplicateBrowserMessage(
  msg: BrowserOutgoingMessage,
  idempotentTypes: ReadonlySet<string>,
  session: Session,
  processedIdLimit: number,
  persistFn: (session: Session) => void,
): boolean {
  if (
    !idempotentTypes.has(msg.type)
    || !("client_msg_id" in msg)
    || !msg.client_msg_id
  ) {
    return false;
  }

  if (isDuplicateClientMessage(session, msg.client_msg_id)) {
    return true;
  }

  rememberClientMessage(session, msg.client_msg_id, processedIdLimit, persistFn);
  return false;
}
