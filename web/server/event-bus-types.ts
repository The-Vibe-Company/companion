// Typed event map for the Companion internal event bus.
// Each key is a namespaced event name; values are the payload passed to handlers.

import type { BrowserIncomingMessage } from "./session-types.js";
import type { CodexAdapter } from "./codex-adapter.js";
import type { SessionPhase } from "./session-state-machine.js";
import type { PortStatus } from "./port-monitor.js";
import type { ServiceStatus } from "./launch-runner.js";
import type { LaunchPortConfig } from "./launch-config.js";

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

  // ── Port monitoring ────────────────────────────────────────────────

  /** Port health status changed (emitted by port-monitor). */
  "port:status": { sessionId: string; ports: PortStatus[] };

  /** Launch config ports resolved for a session before monitoring begins. */
  "session:launch-ports-resolved": {
    sessionId: string;
    ports: Record<string, LaunchPortConfig>;
  };

  // ── Service monitoring ──────────────────────────────────────────────

  /** A single log line from a service process (emitted by launch-runner). */
  "service:log": { sessionId: string; serviceName: string; line: string };

  /** Service status changed (emitted by launch-runner). */
  "service:status": {
    sessionId: string;
    services: Array<{ name: string; status: ServiceStatus; pid?: number; port?: number }>;
  };
}
