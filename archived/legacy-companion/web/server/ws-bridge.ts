import type { ServerWebSocket } from "bun";
import type {
  BrowserOutgoingMessage,
  BrowserIncomingMessage,
  SessionState,
  PermissionRequest,
  BackendType,
  McpServerConfig,
} from "./session-types.js";
import type { SessionStore } from "./session-store.js";
import type { IBackendAdapter } from "./backend-adapter.js";
import { ClaudeAdapter } from "./claude-adapter.js";
import type { RecorderManager } from "./recorder.js";
import { resolveSessionGitInfo } from "./session-git-info.js";
import type {
  Session,
  SocketData,
  CLISocketData,
  BrowserSocketData,
  GitSessionKey,
} from "./ws-bridge-types.js";
import { makeDefaultState } from "./ws-bridge-types.js";
export type { SocketData } from "./ws-bridge-types.js";
import {
  isHistoryBackedEvent,
} from "./ws-bridge-replay.js";
import {
  parseBrowserMessage,
  deduplicateBrowserMessage,
  IDEMPOTENT_BROWSER_MESSAGE_TYPES,
} from "./ws-bridge-browser-ingest.js";
import {
  appendHistory as appendHistoryFn,
  persistSession as persistSessionFn,
} from "./ws-bridge-persist.js";
import {
  broadcastToBrowsers as broadcastToBrowsersFn,
  sendToBrowser as sendToBrowserFn,
  EVENT_BUFFER_LIMIT,
} from "./ws-bridge-publish.js";
import {
  handleSetAiValidation,
} from "./ws-bridge-controls.js";
import {
  handleSessionSubscribe,
  handleSessionAck,
} from "./ws-bridge-browser.js";
import { validatePermission } from "./ai-validator.js";
import { getEffectiveAiValidation } from "./ai-validation-settings.js";
import { companionBus } from "./event-bus.js";
import { SessionStateMachine } from "./session-state-machine.js";
import { metricsCollector } from "./metrics-collector.js";
import { log } from "./logger.js";

// ─── Bridge ───────────────────────────────────────────────────────────────────

const RETRYABLE_BACKEND_MESSAGE_TYPES = new Set<BrowserOutgoingMessage["type"]>([
  "user_message",
  "mcp_get_status",
  "mcp_toggle",
  "mcp_reconnect",
  "mcp_set_servers",
]);

export class WsBridge {
  private static readonly PROCESSED_CLIENT_MSG_ID_LIMIT = 1000;
  /** Maximum number of queued browser→backend messages per session to prevent unbounded memory growth. */
  private static readonly PENDING_MESSAGES_LIMIT = 200;
  private static readonly DISCONNECT_DEBOUNCE_MS = Number(
    process.env.COMPANION_DISCONNECT_DEBOUNCE_MS || "15000",
  );
  /** Shorter debounce for Codex: no WS cycling, so 5s is plenty. */
  private static readonly CODEX_DISCONNECT_DEBOUNCE_MS = Number(
    process.env.COMPANION_CODEX_DISCONNECT_DEBOUNCE_MS || "5000",
  );
  private disconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private idleKillTimers = new Map<string, ReturnType<typeof setInterval>>();
  private sessions = new Map<string, Session>();
  private store: SessionStore | null = null;
  private recorder: RecorderManager | null = null;
  private autoNamingAttempted = new Set<string>();
  private userMsgCounter = 0;
  private static readonly GIT_SESSION_KEYS: GitSessionKey[] = [
    "git_branch",
    "is_worktree",
    "is_containerized",
    "repo_root",
    "git_ahead",
    "git_behind",
  ];

  /** Set the Linear agent session ID on a Companion session and persist it. */
  setLinearSessionId(sessionId: string, linearSessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.state.linearSessionId = linearSessionId;
    this.persistSession(session);
  }

  /** Return all sessions that have a linearSessionId set (for map restoration on startup). */
  getLinearSessionMappings(): Array<{ sessionId: string; linearSessionId: string }> {
    const mappings: Array<{ sessionId: string; linearSessionId: string }> = [];
    for (const [sessionId, session] of this.sessions) {
      if (session.state.linearSessionId) {
        mappings.push({ sessionId, linearSessionId: session.state.linearSessionId });
      }
    }
    return mappings;
  }

  /**
   * Pre-populate a session with container info so that handleSystemMessage
   * preserves the host cwd instead of overwriting it with /workspace.
   * Call this right after launcher.launch() for containerized sessions.
   */
  markContainerized(sessionId: string, hostCwd: string): void {
    const session = this.getOrCreateSession(sessionId);
    session.state.is_containerized = true;
    session.state.cwd = hostCwd;
  }

  /**
   * Pre-populate slash_commands and skills on a session so they are
   * available to browsers immediately (before system.init from the CLI).
   * If system.init arrives later, it overwrites these with the CLI's
   * authoritative list (see handleSystemMessage).
   */
  prePopulateCommands(sessionId: string, slashCommands: string[], skills: string[]): void {
    const session = this.getOrCreateSession(sessionId);
    let changed = false;
    if (session.state.slash_commands.length === 0 && slashCommands.length > 0) {
      session.state.slash_commands = slashCommands;
      changed = true;
    }
    if (session.state.skills.length === 0 && skills.length > 0) {
      session.state.skills = skills;
      changed = true;
    }
    if (changed && session.browserSockets.size > 0) {
      this.broadcastToBrowsers(session, { type: "session_init", session: session.state });
    }
  }

  /** Push a message to all connected browsers for a session (public, for PRPoller etc.). */
  broadcastToSession(sessionId: string, msg: BrowserIncomingMessage): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.broadcastToBrowsers(session, msg);
  }

  /** Attach a persistent store. Call restoreFromDisk() after. */
  setStore(store: SessionStore): void {
    this.store = store;
  }

  /** Attach a recorder for raw message capture. */
  setRecorder(recorder: RecorderManager): void {
    this.recorder = recorder;
  }

  /** Restore sessions from disk (call once at startup). */
  restoreFromDisk(): number {
    if (!this.store) return 0;
    const persisted = this.store.loadAll();
    let count = 0;
    for (const p of persisted) {
      if (this.sessions.has(p.id)) continue; // don't overwrite live sessions
      const session: Session = {
        id: p.id,
        backendType: p.state.backend_type || "claude",
        backendAdapter: null,
        browserSockets: new Set(),
        state: p.state,
        pendingPermissions: new Map(p.pendingPermissions || []),
        messageHistory: p.messageHistory || [],
        pendingMessages: p.pendingMessages || [],
        nextEventSeq: p.nextEventSeq && p.nextEventSeq > 0 ? p.nextEventSeq : 1,
        eventBuffer: Array.isArray(p.eventBuffer) ? p.eventBuffer : [],
        lastAckSeq: typeof p.lastAckSeq === "number" ? p.lastAckSeq : 0,
        processedClientMessageIds: Array.isArray(p.processedClientMessageIds) ? p.processedClientMessageIds : [],
        processedClientMessageIdSet: new Set(
          Array.isArray(p.processedClientMessageIds) ? p.processedClientMessageIds : [],
        ),
        lastCliActivityTs: Date.now(),
        stateMachine: new SessionStateMachine(p.id, "terminated"),
      };
      session.state.backend_type = session.backendType;
      // Resolve git info for restored sessions (may have been persisted without it)
      resolveSessionGitInfo(session.id, session.state);
      this.sessions.set(p.id, session);
      // Restored sessions with completed turns don't need auto-naming re-triggered
      if (session.state.num_turns > 0) {
        this.autoNamingAttempted.add(session.id);
      }
      count++;
    }
    if (count > 0) {
      console.log(`[ws-bridge] Restored ${count} session(s) from disk`);
    }
    return count;
  }

  /** Persist a session to disk (debounced). Delegates to ws-bridge-persist. */
  private persistSession(session: Session): void {
    persistSessionFn(session, this.store);
  }

  private refreshGitInfo(
    session: Session,
    options: { broadcastUpdate?: boolean; notifyPoller?: boolean } = {},
  ): void {
    const before = {
      git_branch: session.state.git_branch,
      is_worktree: session.state.is_worktree,
      is_containerized: session.state.is_containerized,
      repo_root: session.state.repo_root,
      git_ahead: session.state.git_ahead,
      git_behind: session.state.git_behind,
    };

    resolveSessionGitInfo(session.id, session.state);

    let changed = false;
    for (const key of WsBridge.GIT_SESSION_KEYS) {
      if (session.state[key] !== before[key]) {
        changed = true;
        break;
      }
    }

    if (changed) {
      if (options.broadcastUpdate) {
        this.broadcastToBrowsers(session, {
          type: "session_update",
          session: {
            git_branch: session.state.git_branch,
            is_worktree: session.state.is_worktree,
            is_containerized: session.state.is_containerized,
            repo_root: session.state.repo_root,
            git_ahead: session.state.git_ahead,
            git_behind: session.state.git_behind,
          },
        });
      }
      this.persistSession(session);
    }

    if (options.notifyPoller && session.state.git_branch && session.state.cwd) {
      companionBus.emit("session:git-info-ready", { sessionId: session.id, cwd: session.state.cwd, branch: session.state.git_branch });
    }
  }

  // ── Session management ──────────────────────────────────────────────────

  getOrCreateSession(sessionId: string, backendType?: BackendType): Session {
    let session = this.sessions.get(sessionId);
    if (!session) {
      const type = backendType || "claude";
      session = {
        id: sessionId,
        backendType: type,
        backendAdapter: null,
        browserSockets: new Set(),
        state: makeDefaultState(sessionId, type),
        pendingPermissions: new Map(),
        messageHistory: [],
        pendingMessages: [],
        nextEventSeq: 1,
        eventBuffer: [],
        lastAckSeq: 0,
        processedClientMessageIds: [],
        processedClientMessageIdSet: new Set(),
        lastCliActivityTs: Date.now(),
        stateMachine: new SessionStateMachine(sessionId),
      };
      this.sessions.set(sessionId, session);
      this.wireStateMachineListeners(session);
    } else if (backendType) {
      // Only overwrite backendType when explicitly provided (e.g. attachBackendAdapter)
      // Prevents handleBrowserOpen from resetting codex→claude
      session.backendType = backendType;
      session.state.backend_type = backendType;
    }
    return session;
  }

  getSession(sessionId: string): Session | undefined {
    return this.sessions.get(sessionId);
  }

  getAllSessions(): SessionState[] {
    return Array.from(this.sessions.values()).map((s) => s.state);
  }

  /** Return per-session memory stats for diagnostics. */
  getSessionMemoryStats(): { id: string; browsers: number; historyLen: number; eventBufferLen: number; pendingMsgs: number }[] {
    return Array.from(this.sessions.values()).map((s) => ({
      id: s.id,
      browsers: s.browserSockets.size,
      historyLen: s.messageHistory.length,
      eventBufferLen: s.eventBuffer.length,
      pendingMsgs: s.pendingMessages.length,
    }));
  }

  /** Return current phase for each session (for metrics gauges). */
  getSessionPhases(): Map<string, import("./session-state-machine.js").SessionPhase> {
    const phases = new Map<string, import("./session-state-machine.js").SessionPhase>();
    for (const [id, session] of this.sessions) {
      phases.set(id, session.stateMachine.phase);
    }
    return phases;
  }

  getCodexRateLimits(sessionId: string) {
    const session = this.sessions.get(sessionId);
    return session?.backendAdapter?.getRateLimits?.() ?? null;
  }

  isCliConnected(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    return session?.backendAdapter?.isConnected() ?? false;
  }

  removeSession(sessionId: string) {
    const session = this.sessions.get(sessionId);
    session?.unsubscribeStateMachine?.();
    this.cancelDisconnectTimer(sessionId);
    this.stopIdleKillWatchdog(sessionId);
    this.sessions.delete(sessionId);
    this.autoNamingAttempted.delete(sessionId);
    this.store?.remove(sessionId);
  }

  /** Wire state machine transition listener to broadcast phase changes. */
  private wireStateMachineListeners(session: Session): void {
    // Unsubscribe any previous listener (e.g. from session restoration) to prevent leaks
    session.unsubscribeStateMachine?.();
    session.unsubscribeStateMachine = session.stateMachine.onTransition((event) => {
      companionBus.emit("session:phase-changed", {
        sessionId: event.sessionId,
        from: event.from,
        to: event.to,
        trigger: event.trigger,
      });
      this.broadcastToBrowsers(session, {
        type: "session_phase",
        phase: event.to,
        previousPhase: event.from,
      });
    });
  }

  /**
   * Close all sockets (CLI + browsers) for a session and remove it.
   */
  closeSession(sessionId: string) {
    this.cancelDisconnectTimer(sessionId);
    this.stopIdleKillWatchdog(sessionId);
    const session = this.sessions.get(sessionId);
    if (!session) return;

    // Unsubscribe state machine listener to prevent leaks
    session.unsubscribeStateMachine?.();

    // Disconnect backend adapter (Claude or Codex)
    if (session.backendAdapter) {
      session.backendAdapter.disconnect().catch(() => {});
      session.backendAdapter = null;
    }

    // Close all browser sockets
    for (const ws of session.browserSockets) {
      try { ws.close(); } catch {}
    }
    session.browserSockets.clear();

    this.sessions.delete(sessionId);
    this.autoNamingAttempted.delete(sessionId);
    this.store?.remove(sessionId);
  }

  // ── Backend adapter attachment ────────────────────────────────────────────

  /**
   * Attach a backend adapter (Claude or Codex) to a session.
   * Wires up the shared event pipeline: activity tracking, session state
   * merging, history appending, broadcasting, and persistence.
   */
  attachBackendAdapter(sessionId: string, adapter: IBackendAdapter, backendType?: BackendType): void {
    const session = this.getOrCreateSession(sessionId, backendType);
    session.backendAdapter = adapter;

    // Advance the state machine so that system_init (starting → ready) is reachable.
    // For Claude, handleCLIOpen does starting → initializing via cli_ws_open.
    // For Codex (and any non-Claude adapter), the adapter attachment IS the transport
    // open event — no separate WS open fires — so do the equivalent transition here.
    // Also handles relaunched sessions stuck in "terminated": step through
    // terminated → starting → initializing so system_init can land on "ready".
    if (!(adapter instanceof ClaudeAdapter)) {
      // Cancel any pending disconnect debounce — new adapter is reconnecting
      this.cancelDisconnectTimer(sessionId);
      const phase = session.stateMachine.phase;
      if (phase === "terminated") {
        session.stateMachine.transition("starting", "adapter_reattached");
      }
      // starting → initializing (or reconnecting → initializing)
      session.stateMachine.transition("initializing", "adapter_attached");
    }

    // ── onBrowserMessage — messages from backend → browsers ──────────────
    adapter.onBrowserMessage((msg) => {
      // Track activity for idle detection
      session.lastCliActivityTs = Date.now();
      metricsCollector.recordMessageProcessed(msg.type);

      // -- session_init: merge into session state, broadcast, persist -----
      if (msg.type === "session_init") {
        // Exclude session_id from the spread: the CLI reports its own internal
        // session ID which differs from the Companion's session ID.  Allowing
        // it to overwrite session.state.session_id causes the browser to key
        // the session under the wrong ID, producing duplicate sidebar entries.
        const { slash_commands, skills, session_id: _cliSessionId, ...rest } = msg.session;
        // For containerized sessions, the CLI reports /workspace as its cwd.
        // Keep the host path (set by markContainerized()) for correct project grouping.
        const cwdOverride = session.state.is_containerized ? { cwd: session.state.cwd } : {};
        session.state = {
          ...session.state,
          ...rest,
          // Preserve pre-populated commands/skills when adapter sends empty arrays
          ...(slash_commands?.length ? { slash_commands } : {}),
          ...(skills?.length ? { skills } : {}),
          ...cwdOverride,
          backend_type: session.backendType,
        };
        this.refreshGitInfo(session, { notifyPoller: true });
        this.broadcastToBrowsers(session, { type: "session_init", session: session.state });
        session.stateMachine.transition("ready", "system_init");
        this.persistSession(session);
        return;
      }

      // -- session_update: merge into session state, persist ---------------
      if (msg.type === "session_update") {
        // Exclude session_id — same rationale as session_init above.
        const { slash_commands, skills, session_id: _cliSessionId, ...rest } = msg.session;
        session.state = {
          ...session.state,
          ...rest,
          ...(slash_commands?.length ? { slash_commands } : {}),
          ...(skills?.length ? { skills } : {}),
          backend_type: session.backendType,
        };
        this.refreshGitInfo(session, { notifyPoller: true });
        this.persistSession(session);
        if (session.pendingMessages.length > 0 && adapter.isConnected()) {
          this.flushQueuedBrowserMessages(session, adapter, "backend_session_update");
        }
      }

      // -- status_change: update compacting flag ---------------------------
      if (msg.type === "status_change") {
        session.state.is_compacting = msg.status === "compacting";
        if (msg.status === "compacting") {
          session.stateMachine.transition("compacting", "compaction_started");
        } else {
          session.stateMachine.transition("ready", "compaction_ended");
        }
        // Claude status messages may include permissionMode (not in the typed interface).
        // When the CLI changes mode autonomously (e.g. after ExitPlanMode approval),
        // we must broadcast the update so browsers sync their UI (plan toggle, etc.).
        const permMode = (msg as unknown as { permissionMode?: string }).permissionMode;
        if (permMode && permMode !== session.state.permissionMode) {
          session.state.permissionMode = permMode;
          this.broadcastToBrowsers(session, {
            type: "session_update",
            session: { permissionMode: permMode },
          });
        }
        this.persistSession(session);
      }

      if (msg.type === "user_message") {
        const alreadyPersisted = msg.id
          ? session.messageHistory.some((entry) => entry.type === "user_message" && entry.id === msg.id)
          : false;
        if (!alreadyPersisted) {
          this.appendHistory(session, msg);
          this.persistSession(session);
        }
      }

      // -- assistant: append to history, notify listeners ------------------
      if (msg.type === "assistant") {
        const assistantMsg = { ...msg, timestamp: msg.timestamp || Date.now() };
        this.appendHistory(session, assistantMsg);
        this.persistSession(session);
        companionBus.emit("message:assistant", { sessionId: session.id, message: assistantMsg });
      }

      if (msg.type === "stream_event") {
        companionBus.emit("message:stream_event", { sessionId: session.id, message: msg });
      }

      // -- result: update session cost/turns, refresh git, notify listeners
      if (msg.type === "result") {
        const resultData = msg.data;
        session.state.total_cost_usd = resultData.total_cost_usd;
        session.state.num_turns = resultData.num_turns;
        if (typeof resultData.total_lines_added === "number") {
          session.state.total_lines_added = resultData.total_lines_added;
        }
        if (typeof resultData.total_lines_removed === "number") {
          session.state.total_lines_removed = resultData.total_lines_removed;
        }
        if (resultData.modelUsage) {
          for (const usage of Object.values(resultData.modelUsage)) {
            if (usage.contextWindow > 0) {
              const pct = Math.round(
                ((usage.inputTokens + usage.outputTokens) / usage.contextWindow) * 100
              );
              session.state.context_used_percent = Math.max(0, Math.min(pct, 100));
            }
          }
        }
        this.refreshGitInfo(session, { broadcastUpdate: true, notifyPoller: true });
        this.appendHistory(session, msg);
        session.stateMachine.transition("ready", "turn_completed");
        this.persistSession(session);
        companionBus.emit("message:result", { sessionId: session.id, message: msg });

        // Trigger auto-naming after first successful result
        if (
          !(resultData as { is_error?: boolean }).is_error &&
          !this.autoNamingAttempted.has(session.id)
        ) {
          this.autoNamingAttempted.add(session.id);
          const firstUserMsg = session.messageHistory.find((m) => m.type === "user_message");
          if (firstUserMsg && firstUserMsg.type === "user_message") {
            companionBus.emit("session:first-turn-completed", { sessionId: session.id, firstUserMessage: firstUserMsg.content });
          }
        }
      }

      // -- permission_request: AI validation, add to pending ---------------
      if (msg.type === "permission_request") {
        const perm = msg.request;
        metricsCollector.recordPermissionRequested(perm.request_id, session.id);

        // AI Validation Mode: evaluate the tool call before showing to user
        const aiSettings = getEffectiveAiValidation(session.state);
        if (
          aiSettings.enabled
          && aiSettings.anthropicApiKey
          && perm.tool_name !== "AskUserQuestion"
          && perm.tool_name !== "ExitPlanMode"
        ) {
          // Run AI validation async
          this.handleAiValidation(session, adapter, perm).catch((err) => {
            console.warn(`[ws-bridge] AI validation error for tool=${perm.tool_name} request_id=${perm.request_id} session=${session.id}, falling through to manual:`, err);
            // On error, fall through to normal permission flow
            session.pendingPermissions.set(perm.request_id, perm);
            session.stateMachine.transition("awaiting_permission", "ai_validation_error_fallback");
            this.persistSession(session);
            this.broadcastToBrowsers(session, msg);
          });
          return; // Don't broadcast yet — AI validation is async
        }

        session.pendingPermissions.set(perm.request_id, perm);
        session.stateMachine.transition("awaiting_permission", "permission_requested");
        this.persistSession(session);
      }

      // -- permission_cancelled: remove from pending -----------------------
      if (msg.type === "permission_cancelled") {
        const reqId = (msg as { request_id: string }).request_id;
        session.pendingPermissions.delete(reqId);
        // If no more pending permissions, transition back to streaming
        if (session.pendingPermissions.size === 0 && session.stateMachine.phase === "awaiting_permission") {
          session.stateMachine.transition("streaming", "permission_cancelled");
        }
        this.persistSession(session);
      }

      // -- system_event: append to history (except hook_progress) ----------
      if (msg.type === "system_event") {
        const event = msg.event;
        if (event.subtype !== "hook_progress") {
          this.appendHistory(session, msg);
          this.persistSession(session);
        }
      }

      // Broadcast all messages to browsers
      this.broadcastToBrowsers(session, msg);
    });

    // ── onSessionMeta — metadata updates (CLI session ID, model, cwd) ────
    adapter.onSessionMeta((meta) => {
      if (meta.cliSessionId) {
        companionBus.emit("session:cli-id-received", { sessionId: session.id, cliSessionId: meta.cliSessionId });
      }
      if (meta.model) session.state.model = meta.model;
      // For containerized sessions, the CLI reports the container's cwd (e.g. /workspace).
      // Keep the host path (set by markContainerized()) for correct project grouping.
      if (meta.cwd && !session.state.is_containerized) {
        session.state.cwd = meta.cwd;
      }
      session.state.backend_type = session.backendType;
      this.refreshGitInfo(session, { broadcastUpdate: true, notifyPoller: true });
      this.persistSession(session);
      if (session.pendingMessages.length > 0 && adapter.isConnected()) {
        this.flushQueuedBrowserMessages(session, adapter, "backend_session_meta");
      }
    });

    // ── onDisconnect — handle transport disconnection ────────────────────
    adapter.onDisconnect(() => {
      // Guard: only act if THIS adapter is still the active one
      if (session.backendAdapter !== adapter) {
        console.log(`[ws-bridge] Ignoring stale disconnect for session ${sessionId} (adapter replaced)`);
        return;
      }

      // For ClaudeAdapter, disconnect is handled by handleCLIClose debounce logic
      if (adapter instanceof ClaudeAdapter) {
        // Do nothing here — handleCLIClose manages the debounce timer
        return;
      }

      // For Codex adapters: transition to "reconnecting" with a short debounce
      // (5s vs 15s for Claude Code, since Codex doesn't cycle its WebSocket).
      session.backendAdapter = null;
      session.stateMachine.transition("reconnecting", "codex_adapter_disconnected");
      this.persistSession(session);
      log.info("ws-bridge", "Codex adapter disconnected, starting debounce", { sessionId });

      const existing = this.disconnectTimers.get(sessionId);
      if (existing) clearTimeout(existing);
      this.disconnectTimers.set(sessionId, setTimeout(() => {
        this.disconnectTimers.delete(sessionId);
        // Check if a new adapter reconnected during the grace period
        if (session.backendAdapter?.isConnected()) return;

        log.warn("ws-bridge", "Codex disconnect confirmed", { sessionId });
        for (const [reqId] of session.pendingPermissions) {
          this.broadcastToBrowsers(session, { type: "permission_cancelled", request_id: reqId });
        }
        session.pendingPermissions.clear();
        session.stateMachine.transition("terminated", "disconnect_confirmed");
        this.persistSession(session);
        this.broadcastToBrowsers(session, { type: "cli_disconnected" });

        // Request auto-relaunch regardless of browser state — proactive
        // keepalive in the orchestrator ensures headless sessions stay alive.
        companionBus.emit("session:relaunch-needed", { sessionId });
      }, WsBridge.CODEX_DISCONNECT_DEBOUNCE_MS));
    });

    // ── onInitError (optional) ───────────────────────────────────────────
    adapter.onInitError?.((error) => {
      log.error("ws-bridge", "Backend init error", { sessionId, error });
      this.broadcastToBrowsers(session, { type: "error", message: error });
    });

    // Flush pending messages for non-Claude backends (Codex uses stdio, not
    // a CLI WebSocket, so handleCLIOpen never runs to flush the queue).
    // For Claude backends, handleCLIOpen handles this after attachWebSocket.
    if (!(adapter instanceof ClaudeAdapter) && session.pendingMessages.length > 0) {
      this.flushQueuedBrowserMessages(session, adapter, "adapter_attach");
      this.persistSession(session);
    }

    // Broadcast cli_connected
    this.broadcastToBrowsers(session, { type: "cli_connected" });
    log.info("ws-bridge", "Backend adapter attached", {
      sessionId,
      backendType: session.backendType,
    });
  }

  /** AI validation for permission requests — shared by Claude and Codex paths. */
  private async handleAiValidation(
    session: Session,
    adapter: IBackendAdapter,
    perm: PermissionRequest,
  ): Promise<void> {
    const aiSettings = getEffectiveAiValidation(session.state);
    const result = await validatePermission(
      perm.tool_name,
      perm.input,
      perm.description,
    );

    perm.ai_validation = {
      verdict: result.verdict,
      reason: result.reason,
      ruleBasedOnly: result.ruleBasedOnly,
    };

    // Auto-approve safe tools
    if (result.verdict === "safe" && aiSettings.autoApprove) {
      metricsCollector.recordPermissionResolved(perm.request_id, "allow", true);
      this.broadcastToBrowsers(session, {
        type: "permission_auto_resolved",
        request: perm,
        behavior: "allow",
        reason: result.reason,
      });
      adapter.send({
        type: "permission_response",
        request_id: perm.request_id,
        behavior: "allow",
        updated_input: perm.input,
      });
      return;
    }

    // Auto-deny dangerous tools
    if (result.verdict === "dangerous" && aiSettings.autoDeny) {
      metricsCollector.recordPermissionResolved(perm.request_id, "deny", true);
      this.broadcastToBrowsers(session, {
        type: "permission_auto_resolved",
        request: perm,
        behavior: "deny",
        reason: result.reason,
      });
      adapter.send({
        type: "permission_response",
        request_id: perm.request_id,
        behavior: "deny",
      });
      return;
    }

    // Uncertain or auto-action disabled: fall through to manual
    session.pendingPermissions.set(perm.request_id, perm);
    session.stateMachine.transition("awaiting_permission", "ai_validation_manual_fallback");
    this.persistSession(session);
    this.broadcastToBrowsers(session, {
      type: "permission_request",
      request: perm,
    });
  }

  /** Cancel a pending disconnect debounce timer for a session, if any. */
  cancelDisconnectTimer(sessionId: string): boolean {
    const timer = this.disconnectTimers.get(sessionId);
    if (!timer) return false;
    clearTimeout(timer);
    this.disconnectTimers.delete(sessionId);
    return true;
  }

  // ── CLI WebSocket handlers ──────────────────────────────────────────────

  handleCLIOpen(ws: ServerWebSocket<SocketData>, sessionId: string) {
    metricsCollector.recordWsConnection("cli", "open");
    this.recorder?.recordEvent(sessionId, "ws_open", "cli");
    const session = this.getOrCreateSession(sessionId);

    // Create or retrieve ClaudeAdapter for this session
    let adapter: ClaudeAdapter;
    let isNewAdapter = false;
    if (session.backendAdapter instanceof ClaudeAdapter) {
      adapter = session.backendAdapter;
    } else {
      isNewAdapter = true;
      adapter = new ClaudeAdapter(sessionId, {
        recorder: this.recorder,
        onActivityUpdate: () => { session.lastCliActivityTs = Date.now(); },
      });
      // Wire up the shared event pipeline via attachBackendAdapter
      // (also broadcasts cli_connected for new adapters)
      this.attachBackendAdapter(sessionId, adapter);
    }
    // For relaunched sessions the state machine may be "terminated".
    // Step through terminated → starting first so the cli_ws_open trigger can land.
    if (session.stateMachine.phase === "terminated") {
      session.stateMachine.transition("starting", "cli_reattached");
    }
    session.stateMachine.transition("initializing", "cli_ws_open");

    // Cancel any pending disconnect debounce timer — CLI reconnected in time
    if (this.cancelDisconnectTimer(sessionId)) {
      log.info("ws-bridge", "CLI reconnected (debounce cancelled)", { sessionId });
    } else {
      log.info("ws-bridge", "CLI connected", { sessionId });
    }

    // Attach the raw WebSocket to the adapter (flushes pending NDJSON)
    adapter.attachWebSocket(ws);

    // Broadcast cli_connected on reconnection (new adapters already got this
    // via attachBackendAdapter to avoid double-broadcasting)
    if (!isNewAdapter) {
      this.broadcastToBrowsers(session, { type: "cli_connected" });
    }

    // Flush any messages queued while waiting for the CLI WebSocket.
    // Per the SDK protocol, the first user message triggers system.init,
    // so we must send it as soon as the WebSocket is open — NOT wait for
    // system.init (which would create a deadlock for slow-starting sessions
    // like Docker containers where the user message arrives before CLI connects).
    if (session.pendingMessages.length > 0) {
      console.log(`[ws-bridge] Flushing ${session.pendingMessages.length} queued message(s) on CLI connect for session ${sessionId}`);
      const queued = session.pendingMessages.splice(0);
      for (const raw of queued) {
        try {
          const queued_msg = JSON.parse(raw) as BrowserOutgoingMessage;
          adapter.send(queued_msg);
        } catch {
          console.warn(`[ws-bridge] Failed to parse queued message: ${raw.substring(0, 100)}`);
        }
      }
    }
  }

  handleCLIMessage(ws: ServerWebSocket<SocketData>, raw: string | Buffer) {
    const data = typeof raw === "string" ? raw : raw.toString("utf-8");
    const sessionId = (ws.data as CLISocketData).sessionId;
    const session = this.sessions.get(sessionId);
    if (!session) return;

    // Delegate raw NDJSON parsing, dedup, and routing to the ClaudeAdapter
    // (recording is done inside the adapter's handleRawMessage)
    if (!(session.backendAdapter instanceof ClaudeAdapter)) {
      console.warn(`[ws-bridge] handleCLIMessage: no ClaudeAdapter for session ${sessionId}, dropping message`);
      return;
    }
    session.backendAdapter.handleRawMessage(data);
  }

  handleCLIClose(ws: ServerWebSocket<SocketData>) {
    metricsCollector.recordWsConnection("cli", "close");
    const sessionId = (ws.data as CLISocketData).sessionId;
    this.recorder?.recordEvent(sessionId, "ws_close", "cli");
    const session = this.sessions.get(sessionId);
    if (!session) return;

    // Detach the WebSocket from the ClaudeAdapter (guards against stale sockets)
    if (session.backendAdapter instanceof ClaudeAdapter) {
      session.backendAdapter.detachWebSocket(ws);
    }
    session.stateMachine.transition("reconnecting", "cli_ws_closed");

    // Debounce: delay disconnect notification by 15s.
    // CLI cycles its WebSocket every ~30s (close code 1000) and uses exponential
    // backoff (1s → 2s → 4s → 8s → …) on reconnect. After rapid successive
    // disconnects, the backoff can exceed 5s, so we use 15s to cover the worst
    // case (8s backoff + connection overhead).
    const existing = this.disconnectTimers.get(sessionId);
    if (existing) clearTimeout(existing);
    this.disconnectTimers.set(sessionId, setTimeout(() => {
      this.disconnectTimers.delete(sessionId);
      // Check if CLI reconnected during grace period
      if (session.backendAdapter?.isConnected()) return;
      log.warn("ws-bridge", "CLI disconnect confirmed", { sessionId });
      session.stateMachine.transition("terminated", "disconnect_confirmed");
      this.broadcastToBrowsers(session, { type: "cli_disconnected" });
      for (const [reqId] of session.pendingPermissions) {
        this.broadcastToBrowsers(session, { type: "permission_cancelled", request_id: reqId });
      }
      session.pendingPermissions.clear();

      // Request auto-relaunch regardless of browser state — the proactive
      // keepalive in the orchestrator ensures headless sessions stay alive.
      companionBus.emit("session:relaunch-needed", { sessionId });
    }, WsBridge.DISCONNECT_DEBOUNCE_MS));
  }

  // ── Browser WebSocket handlers ──────────────────────────────────────────

  handleBrowserOpen(ws: ServerWebSocket<SocketData>, sessionId: string) {
    metricsCollector.recordWsConnection("browser", "open");
    this.recorder?.recordEvent(sessionId, "ws_open", "browser");
    const session = this.getOrCreateSession(sessionId);
    const browserData = ws.data as BrowserSocketData;
    browserData.subscribed = false;
    browserData.lastAckSeq = 0;
    session.browserSockets.add(ws);
    log.info("ws-bridge", "Browser connected", { sessionId, browsers: session.browserSockets.size });

    // Cancel idle kill watchdog — a browser is back
    this.stopIdleKillWatchdog(sessionId);

    // Refresh git state on browser connect so branch changes made mid-session are reflected.
    this.refreshGitInfo(session, { notifyPoller: true });

    // Send current session state as snapshot
    const snapshot: BrowserIncomingMessage = {
      type: "session_init",
      session: session.state,
    };
    this.sendToBrowser(ws, snapshot);

    // Replay message history so the browser can reconstruct the conversation
    if (session.messageHistory.length > 0) {
      this.sendToBrowser(ws, {
        type: "message_history",
        messages: session.messageHistory,
      });
    }

    // Send any pending permission requests
    for (const perm of session.pendingPermissions.values()) {
      this.sendToBrowser(ws, { type: "permission_request", request: perm });
    }

    // Notify if backend is not connected and request relaunch.
    // Treat an attached adapter as "alive" during init — `isConnected()`
    // may flip true only after initialize/thread start, and relaunching
    // during that window can kill a healthy startup.
    const backendConnected = !!session.backendAdapter;

    if (!backendConnected && !this.disconnectTimers.has(sessionId)) {
      // Only signal disconnection if we're not within the debounce window
      // (CLI may be mid-reconnect — avoid UI flap and spurious relaunch)
      this.sendToBrowser(ws, { type: "cli_disconnected" });
      console.log(`[ws-bridge] Browser connected but backend is dead for session ${sessionId}, requesting relaunch`);
      companionBus.emit("session:relaunch-needed", { sessionId });
    }
  }

  handleBrowserMessage(ws: ServerWebSocket<SocketData>, raw: string | Buffer) {
    const data = typeof raw === "string" ? raw : raw.toString("utf-8");
    const sessionId = (ws.data as BrowserSocketData).sessionId;
    const session = this.sessions.get(sessionId);
    if (!session) return;

    // Record raw incoming browser message
    this.recorder?.record(sessionId, "in", data, "browser", session.backendType, session.state.cwd);

    // Pipeline: parse → route (dedup happens inside routeBrowserMessage)
    const msg = parseBrowserMessage(data);
    if (!msg) return;

    this.routeBrowserMessage(session, msg, ws);
  }

  /** Send a user message into a session programmatically (no browser required).
   *  Used by the cron scheduler and agent executor to send prompts to autonomous sessions. */
  injectUserMessage(sessionId: string, content: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      console.error(`[ws-bridge] Cannot inject message: session ${sessionId} not found`);
      return;
    }
    this.routeBrowserMessage(session, { type: "user_message", content });
  }

  /** Configure MCP servers on a session programmatically (no browser required).
   *  Used by the agent executor to set up MCP servers after CLI connects. */
  injectMcpSetServers(sessionId: string, servers: Record<string, McpServerConfig>): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      console.error(`[ws-bridge] Cannot inject MCP servers: session ${sessionId} not found`);
      return;
    }
    this.routeBrowserMessage(session, { type: "mcp_set_servers", servers });
  }

  /** Send an initialize control request with context appended to the system prompt.
   *  Must be called before the first user message. Claude-specific: uses ClaudeAdapter
   *  to send a raw control_request. If CLI isn't connected yet, the adapter queues it. */
  injectSystemPrompt(sessionId: string, appendSystemPrompt: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      console.error(`[ws-bridge] Cannot inject system prompt: session ${sessionId} not found`);
      return;
    }
    if (session.backendAdapter instanceof ClaudeAdapter) {
      const { randomUUID } = require("node:crypto") as typeof import("node:crypto");
      const ndjson = JSON.stringify({
        type: "control_request",
        request_id: randomUUID(),
        request: { subtype: "initialize", appendSystemPrompt },
      });
      session.backendAdapter.sendRawNDJSON(ndjson);
    }
  }

  handleBrowserClose(ws: ServerWebSocket<SocketData>) {
    metricsCollector.recordWsConnection("browser", "close");
    const sessionId = (ws.data as BrowserSocketData).sessionId;
    this.recorder?.recordEvent(sessionId, "ws_close", "browser");
    const session = this.sessions.get(sessionId);
    if (!session) return;

    session.browserSockets.delete(ws);
    log.info("ws-bridge", "Browser disconnected", { sessionId, browsers: session.browserSockets.size });

    // Start idle kill watchdog when last browser disconnects
    if (session.browserSockets.size === 0 && !this.idleKillTimers.has(sessionId)) {
      this.startIdleKillWatchdog(sessionId);
    }
  }

  // ── Idle kill watchdog ─────────────────────────────────────────────────

  private static readonly IDLE_KILL_THRESHOLD_MS = Number(
    process.env.COMPANION_IDLE_KILL_MINUTES
      ? Number(process.env.COMPANION_IDLE_KILL_MINUTES) * 60_000
      : 24 * 60 * 60_000, // 24 hours default
  );
  private static readonly IDLE_CHECK_INTERVAL_MS = 60_000; // check every 60s

  private startIdleKillWatchdog(sessionId: string) {
    // Reset activity timestamp so we measure from when browsers left, not from
    // last CLI message (which may have been seconds ago during active work)
    const session = this.sessions.get(sessionId);
    if (session) {
      session.lastCliActivityTs = Date.now();
    }
    console.log(`[ws-bridge] Starting idle kill watchdog for ${sessionId} (threshold: ${WsBridge.IDLE_KILL_THRESHOLD_MS / 60_000}min)`);
    const timer = setInterval(() => {
      this.checkIdleKill(sessionId);
    }, WsBridge.IDLE_CHECK_INTERVAL_MS);
    this.idleKillTimers.set(sessionId, timer);
  }

  private stopIdleKillWatchdog(sessionId: string) {
    const timer = this.idleKillTimers.get(sessionId);
    if (timer) {
      clearInterval(timer);
      this.idleKillTimers.delete(sessionId);
      console.log(`[ws-bridge] Cancelled idle kill watchdog for ${sessionId} (browser reconnected)`);
    }
  }

  private checkIdleKill(sessionId: string) {
    const session = this.sessions.get(sessionId);
    if (!session) {
      this.stopIdleKillWatchdog(sessionId);
      return;
    }

    // Browser reconnected — cancel
    if (session.browserSockets.size > 0) {
      this.stopIdleKillWatchdog(sessionId);
      return;
    }

    const idleMs = Date.now() - session.lastCliActivityTs;
    if (idleMs < WsBridge.IDLE_KILL_THRESHOLD_MS) {
      return; // still active or not idle long enough
    }

    // Truly idle with no browsers — kill
    console.log(`[ws-bridge] Idle kill triggered for ${sessionId} (idle ${Math.round(idleMs / 60_000)}min, 0 browsers)`);
    this.stopIdleKillWatchdog(sessionId);
    companionBus.emit("session:idle-kill", { sessionId });
  }

  /** Append to messageHistory with cap. Delegates to ws-bridge-persist. */
  private appendHistory(session: Session, msg: BrowserIncomingMessage) {
    appendHistoryFn(session, msg);
  }

  // ── Browser message routing ─────────────────────────────────────────────

  private routeBrowserMessage(
    session: Session,
    msg: BrowserOutgoingMessage,
    ws?: ServerWebSocket<SocketData>,
  ) {
    // Bridge-level message types — never forwarded to backend
    if (msg.type === "session_subscribe") {
      handleSessionSubscribe(
        session,
        ws,
        msg.last_seq,
        this.sendToBrowser.bind(this),
        isHistoryBackedEvent,
      );
      return;
    }

    if (msg.type === "session_ack") {
      handleSessionAck(session, ws, msg.last_seq, this.persistSession.bind(this));
      return;
    }

    // Dedup idempotent messages
    if (deduplicateBrowserMessage(
      msg,
      IDEMPOTENT_BROWSER_MESSAGE_TYPES,
      session,
      WsBridge.PROCESSED_CLIENT_MSG_ID_LIMIT,
      this.persistSession.bind(this),
    )) {
      return;
    }

    // -- set_ai_validation: bridge-level, not forwarded to backend --------
    if (msg.type === "set_ai_validation") {
      handleSetAiValidation(session, msg);
      this.persistSession(session);
      this.broadcastToBrowsers(session, {
        type: "session_update",
        session: {
          aiValidationEnabled: session.state.aiValidationEnabled,
          aiValidationAutoApprove: session.state.aiValidationAutoApprove,
          aiValidationAutoDeny: session.state.aiValidationAutoDeny,
        },
      });
      return;
    }

    // -- user_message: store in history before delegating to adapter ------
    if (msg.type === "user_message") {
      metricsCollector.recordTurnStarted(session.id);
      const ts = Date.now();
      const userMessage: BrowserIncomingMessage = {
        type: "user_message",
        content: msg.content,
        timestamp: ts,
        id: msg.client_msg_id || `user-${ts}-${this.userMsgCounter++}`,
      };
      this.appendHistory(session, userMessage);
      const transitioned = session.stateMachine.transition("streaming", "user_message");
      if (!transitioned) {
        // Session not ready yet (e.g. still initializing). Log a warning so
        // protocol drift is visible, but still forward the message — the
        // backend adapter has its own internal queue for pre-init messages.
        log.warn("ws-bridge", "Session not ready for user message, forwarding to adapter queue", {
          sessionId: session.id,
          phase: session.stateMachine.phase,
        });
      }
      this.persistSession(session);
      this.broadcastToBrowsers(session, userMessage);
    }

    // -- permission_response: populate updatedInput fallback from pending, then remove -------
    if (msg.type === "permission_response") {
      metricsCollector.recordPermissionResolved(msg.request_id, msg.behavior as "allow" | "deny", false);
      const pending = session.pendingPermissions.get(msg.request_id);
      // When the browser sends allow without updated_input, use the original tool input
      // as a fallback. This matches the pre-adapter behavior.
      if (msg.behavior === "allow" && !msg.updated_input && pending?.input) {
        msg = { ...msg, updated_input: pending.input };
      }
      session.pendingPermissions.delete(msg.request_id);
      session.stateMachine.transition("streaming", "permission_resolved");
      this.persistSession(session);
    }

    // Delegate to the backend adapter if connected; otherwise queue for later flush.
    // For Claude: adapter may exist but WS is disconnected (CLI cycling). Queue at
    // bridge level so handleCLIOpen flushes via adapter.send() after reconnect.
    if (session.backendAdapter?.isConnected()) {
      if (session.pendingMessages.length > 0) {
        this.flushQueuedBrowserMessages(session, session.backendAdapter, "backend_connected_send");
        // Preserve FIFO ordering: if flush was interrupted and left pending
        // messages, queue this incoming message behind them instead of sending
        // it immediately (which could overtake older queued work).
        if (session.pendingMessages.length > 0) {
          this.enqueuePendingMessage(session, JSON.stringify(msg));
          this.persistSession(session);
          return;
        }
      }
      const sent = session.backendAdapter.send(msg);
      // Codex can be "adapter-connected" while its underlying transport is in a
      // transient disconnected state. If send rejects retryable messages, keep
      // them queued so they can be flushed after reconnect/relaunch.
      if (!sent && RETRYABLE_BACKEND_MESSAGE_TYPES.has(msg.type)) {
        log.warn("ws-bridge", "Backend send failed, re-queuing", {
          sessionId: session.id,
          messageType: msg.type,
        });
        this.enqueuePendingMessage(session, JSON.stringify(msg));
      }
      this.persistSession(session);
    } else {
      // Adapter not yet attached or transport disconnected — queue for when it reconnects
      log.info("ws-bridge", "Backend not connected, queuing message", {
        sessionId: session.id,
        messageType: msg.type,
      });
      this.enqueuePendingMessage(session, JSON.stringify(msg));
      this.persistSession(session);
    }
  }

  // ── Transport helpers (delegate to ws-bridge-publish) ────────────────────

  /** Push a session name update to all connected browsers for a session. */
  broadcastNameUpdate(sessionId: string, name: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.broadcastToBrowsers(session, { type: "session_name_update", name });
  }

  private broadcastToBrowsers(session: Session, msg: BrowserIncomingMessage) {
    broadcastToBrowsersFn(session, msg, {
      eventBufferLimit: EVENT_BUFFER_LIMIT,
      recorder: this.recorder,
      persistFn: this.persistSession.bind(this),
    });
  }

  private sendToBrowser(ws: ServerWebSocket<SocketData>, msg: BrowserIncomingMessage) {
    sendToBrowserFn(ws, msg);
  }

  /**
   * Flush queued browser-originated messages to an attached backend adapter.
   * Keeps ordering and re-queues retryable messages if dispatch fails.
   */
  /** Enqueue a browser→backend message, dropping the oldest if the queue is full. */
  private enqueuePendingMessage(session: Session, raw: string): void {
    if (session.pendingMessages.length >= WsBridge.PENDING_MESSAGES_LIMIT) {
      const dropped = session.pendingMessages.shift();
      log.warn("ws-bridge", "Pending message queue full, dropping oldest message", {
        sessionId: session.id,
        queueSize: session.pendingMessages.length,
        droppedPreview: dropped?.substring(0, 80),
      });
      this.broadcastToBrowsers(session, {
        type: "error",
        message: "Message queue full: the oldest queued message was discarded.",
      });
    }
    session.pendingMessages.push(raw);
  }

  private flushQueuedBrowserMessages(session: Session, adapter: IBackendAdapter, reason: string): void {
    if (session.pendingMessages.length === 0) return;

    log.info("ws-bridge", "Flushing queued messages", {
      sessionId: session.id,
      backendType: session.backendType,
      reason,
      count: session.pendingMessages.length,
    });

    const queued = session.pendingMessages.splice(0);
    for (let i = 0; i < queued.length; i++) {
      const raw = queued[i];
      let queuedMsg: BrowserOutgoingMessage;
      try {
        queuedMsg = JSON.parse(raw) as BrowserOutgoingMessage;
      } catch {
        log.warn("ws-bridge", "Failed to parse queued message during flush", {
          sessionId: session.id,
          backendType: session.backendType,
          rawPreview: raw.substring(0, 100),
        });
        continue;
      }

      const sent = adapter.send(queuedMsg);
      if (!sent && RETRYABLE_BACKEND_MESSAGE_TYPES.has(queuedMsg.type)) {
        const remaining = queued.slice(i);
        session.pendingMessages = remaining.concat(session.pendingMessages);
        log.warn("ws-bridge", "Queued message flush interrupted, re-queued remaining messages", {
          sessionId: session.id,
          backendType: session.backendType,
          reason,
          failedMessageType: queuedMsg.type,
          remaining: remaining.length,
        });
        break;
      }

      if (!sent) {
        log.warn("ws-bridge", "Dropping non-retryable queued message after flush failure", {
          sessionId: session.id,
          backendType: session.backendType,
          reason,
          failedMessageType: queuedMsg.type,
        });
      }
    }
  }
}
