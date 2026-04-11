// Typed event map for the Companion internal event bus.
// Each key is a namespaced event name; values are the payload passed to handlers.

import type { BrowserIncomingMessage, PermissionRequest } from "./session-types.js";
import type { CodexAdapter } from "./codex-adapter.js";
import type { SessionPhase } from "./session-state-machine.js";

export interface CompanionEventMap {
  // ── Session lifecycle ──────────────────────────────────────────────

  /** CLI reported its internal session ID (used for --resume). */
  "session:cli-id-received": { sessionId: string; cliSessionId: string };

  /** CLI/Codex process exited. */
  "session:exited": { sessionId: string; exitCode: number | null };

  /** CLI WebSocket disconnected and a browser needs a relaunch. */
  "session:relaunch-needed": { sessionId: string };

  /** Idle-kill threshold reached with no connected browsers. */
  "session:idle-kill": { sessionId: string };

  /** First non-error turn completed (triggers auto-naming). */
  "session:first-turn-completed": {
    sessionId: string;
    firstUserMessage: string;
  };

  /** Git info resolved for a session (branch and cwd known). */
  "session:git-info-ready": { sessionId: string; cwd: string; branch: string };

  /** Session phase changed (formal state machine transition). */
  "session:phase-changed": {
    sessionId: string;
    from: SessionPhase;
    to: SessionPhase;
    trigger: string;
  };

  /** CLI requested permission for a tool use (before AI validation). */
  "session:permission-request": {
    sessionId: string;
    request: PermissionRequest;
  };

  /** A permission request was cancelled (by CLI or session disconnect). */
  "session:permission-cancelled": {
    sessionId: string;
    requestId: string;
  };

  // ── Backend integration ────────────────────────────────────────────

  /** Codex adapter created and ready to be attached to WsBridge. */
  "backend:codex-adapter-created": {
    sessionId: string;
    adapter: CodexAdapter;
  };

  // ── Per-session messages (high volume) ─────────────────────────────

  /** An assistant message was processed and broadcast to browsers. */
  "message:assistant": {
    sessionId: string;
    message: BrowserIncomingMessage;
  };

  /** A stream event was processed and broadcast to browsers. */
  "message:stream_event": {
    sessionId: string;
    message: BrowserIncomingMessage;
  };

  /** A result (turn completion) was processed and broadcast to browsers. */
  "message:result": { sessionId: string; message: BrowserIncomingMessage };

  /** Simplified text output from CLI (streamlined mode). */
  "message:streamlined_text": {
    sessionId: string;
    message: BrowserIncomingMessage;
  };

  /** Simplified tool use summary from CLI (streamlined mode). */
  "message:streamlined_tool_use_summary": {
    sessionId: string;
    message: BrowserIncomingMessage;
  };

  /** System event from CLI (task_notification, files_persisted, hook events, etc.). */
  "message:system_event": {
    sessionId: string;
    message: BrowserIncomingMessage;
  };

  /** Status change from CLI (compacting, idle, running). */
  "message:status_change": {
    sessionId: string;
    message: BrowserIncomingMessage;
  };

  /** Tool progress update with elapsed time. */
  "message:tool_progress": {
    sessionId: string;
    message: BrowserIncomingMessage;
  };

  /** Authentication status from CLI. */
  "message:auth_status": {
    sessionId: string;
    message: BrowserIncomingMessage;
  };

  /** Prompt suggestions for the next turn. */
  "message:prompt_suggestion": {
    sessionId: string;
    message: BrowserIncomingMessage;
  };

  /** AI validation auto-resolved a permission request. */
  "session:permission-auto-resolved": {
    sessionId: string;
    request: PermissionRequest;
    behavior: "allow" | "deny";
    reason: string;
  };

  /** Rate limit event from CLI API. */
  "message:rate_limit_event": {
    sessionId: string;
    message: BrowserIncomingMessage;
  };
}
