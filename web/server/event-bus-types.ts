// Typed event map for the Companion internal event bus.
// Each key is a namespaced event name; values are the payload passed to handlers.

import type { BrowserIncomingMessage, IdeBinding } from "./session-types.js";
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

  // ── IDE discovery / binding ────────────────────────────────────────

  /** A new IDE lockfile appeared under ~/.claude/ide/. */
  "ide:added": {
    port: number;
    ideName: string;
    workspaceFolders: string[];
    lockfilePath: string;
    /**
     * Monotonic scan generation from ide-discovery. Used by ws-bridge to
     * stamp the browser-facing `ide_list_changed` broadcast so clients can
     * deduplicate fan-out by generation instead of a brittle time window.
     */
    generation: number;
  };

  /** An IDE lockfile was removed or its PID is no longer alive. */
  "ide:removed": { port: number; lockfilePath: string; generation: number };

  /** An IDE lockfile was modified (e.g. workspaceFolders changed). */
  "ide:changed": {
    port: number;
    ideName: string;
    workspaceFolders: string[];
    lockfilePath: string;
    generation: number;
  };

  /** A session's IDE binding changed (bind, unbind, or auto-unbind). */
  "ide:binding-changed": { sessionId: string; binding: IdeBinding | null };
}
