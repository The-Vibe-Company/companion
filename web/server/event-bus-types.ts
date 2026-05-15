// Typed event map for the Companion internal event bus.
// Each key is a namespaced event name; values are the payload passed to handlers.

import type { BrowserIncomingMessage, PermissionRequest } from "./session-types.js";
import type { ClaudeAdapter } from "./claude-adapter.js";
import type { CodexAdapter } from "./codex-adapter.js";
import type { SessionPhase } from "./session-state-machine.js";

export interface CompanionEventMap {
  // ── Session lifecycle ──────────────────────────────────────────────

  /** CLI reported its internal session ID (used for --resume). */
  "session:cli-id-received": { sessionId: string; cliSessionId: string };

  /** CLI/Codex process exited. */
  "session:exited": { sessionId: string; exitCode: number | null };

  /** The CLI child process disconnected (its stdio pipe closed or it exited)
   *  and a browser is still attached, so the orchestrator may want to relaunch. */
  "session:relaunch-needed": { sessionId: string };

  /** Idle-kill threshold reached with no connected browsers. */
  "session:idle-kill": { sessionId: string };

  /** Claude adapter's hang watchdog detected silent stdout during an
   *  active turn. Orchestrator marks the kill intentional (so keepalive
   *  doesn't auto-respawn) and SIGTERMs the child; the existing
   *  relaunch-needed path will bring it back when the user focuses the
   *  session again. See project_claude_silent_hang.md memory entry. */
  "session:hang-detected": { sessionId: string };

  /** cli-launcher refused to spawn because the session's cwd is not on
   *  disk (worktree removed, etc.). The condition is permanent until the
   *  user recreates the directory or updates the session cwd, so the
   *  orchestrator should NOT keep retrying with the auto-relaunch budget
   *  — it adds the session to intentionalKills + clears the relaunch
   *  count. See project_companion_missing_cwd.md memory entry. */
  "session:spawn-aborted-permanent": { sessionId: string; reason: string };

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

  /** Claude adapter created (right after the launcher spawns the CLI in
   *  stdio mode) and ready to be attached to WsBridge. */
  "backend:claude-adapter-created": {
    sessionId: string;
    adapter: ClaudeAdapter;
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

  /** A user message was routed into a session. Source identifies who sent
   *  it ("browser" for web UI, "cron"/"agent"/etc. for programmatic
   *  injectors). Lets non-browser observers mirror web-side input without
   *  echoing their own messages. */
  "message:user": {
    sessionId: string;
    content: string;
    timestamp: number;
    id: string;
    source: "browser" | "cron" | "agent" | "external";
  };

  /** A tool call's result was received from the backend. Both Claude (via
   *  the CLI's `user` echo containing tool_result blocks) and Codex (via
   *  its synthetic assistant messages) emit this — adapters normalize the
   *  payload so subscribers don't have to care which backend produced it.
   *  Browsers don't subscribe to this event; they get tool results via the
   *  existing tool_progress / tool_use_summary / assistant-message path. */
  "tool:result": {
    sessionId: string;
    toolUseId: string;
    content: string | unknown[];
    isError: boolean;
  };

  // ── Permission lifecycle ───────────────────────────────────────────
  // These let non-browser observers react to permission prompts. Browsers
  // themselves still use the dedicated permission_request/permission_response
  // broadcast path; bus events run in parallel and carry the same data.

  /** A permission request was added to a session's pending set. */
  "permission:request-created": {
    sessionId: string;
    request: PermissionRequest;
  };

  /** A permission request was resolved (allow/deny) by any client. */
  "permission:request-resolved": {
    sessionId: string;
    requestId: string;
    behavior: "allow" | "deny";
  };

  /** A permission request was cancelled (timeout, session interrupt, etc). */
  "permission:request-cancelled": {
    sessionId: string;
    requestId: string;
  };
}
