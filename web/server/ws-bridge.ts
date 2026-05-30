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
import { listAvailableIdes } from "./ide-discovery.js";
import type { IdeBinding } from "./session-types.js";

// ─── Bridge ───────────────────────────────────────────────────────────────────

/**
 * Strip `authToken` from an IdeBinding before it crosses ANY browser-visible
 * surface (WS broadcast, REST response). BIND-03: authToken is runtime-only,
 * server-internal — same rule as session-store.sanitizeForDisk.
 *
 * Shallow-cloned so the caller's in-memory binding (ws-bridge keeps it for
 * MCP re-injection) is not mutated.
 */
export function stripAuthToken(binding: IdeBinding): IdeBinding {
  // biome-ignore lint/correctness/noUnusedVariables: explicit destructure-drop
  const { authToken: _authToken, ...safe } = binding;
  return safe as IdeBinding;
}

/**
 * Return a browser-safe projection of a SessionState: same shape, but any
 * nested `ideBinding.authToken` is stripped. BIND-03. Used by session_init
 * and any other broadcast that sends the full SessionState to browsers.
 *
 * Shallow copy at the top level plus a fresh ideBinding object — the
 * in-memory session retains the authToken for MCP re-injection.
 */
export function sanitizeSessionStateForBrowser<T extends { ideBinding?: IdeBinding | null }>(
  state: T,
): T {
  if (!state.ideBinding) return state;
  return { ...state, ideBinding: stripAuthToken(state.ideBinding) };
}

const RETRYABLE_BACKEND_MESSAGE_TYPES = new Set<BrowserOutgoingMessage["type"]>([
  "user_message",
  "mcp_get_status",
  "mcp_toggle",
  "mcp_reconnect",
  "mcp_set_servers",
]);

/**
 * Reserved MCP-server key prefix for Companion-managed IDE entries.
 *
 * Codex round-5 BLOCK 1: two-layer protection against namespace collisions
 * with user-supplied `mcp_set_servers` payloads.
 *
 *   Layer 1 — producer side (bindIde / unbindIde): always construct their
 *     server key as `${IDE_SERVER_KEY_PREFIX}<sanitizedIdeName>` so bridge-
 *     authored IDE entries live in a dedicated namespace, separate from
 *     anything a sanitized user ideName could produce (sanitizer emits
 *     `[a-z0-9]+`; hyphens in the prefix are structurally distinguishing).
 *
 *   Layer 2 — consumer side (routeBrowserMessage): when a user (or any
 *     caller routing through `routeBrowserMessage`) sends `mcp_set_servers`,
 *     strip any keys that start with this prefix from both the `servers`
 *     map and the `deleteKeys` array BEFORE mirror update AND before
 *     adapter.send. A malicious or accidental `servers: { "companion-ide-
 *     neovim": {...} }` would otherwise occupy our reserved namespace and
 *     collide with bindIde/unbindIde (e.g., delete our IDE entry via
 *     `deleteKeys: ["companion-ide-neovim"]`, or clobber our entry with
 *     user-controlled contents).
 *
 * Any change to this literal must be reflected in BOTH bindIde/unbindIde
 * (producers) and the stripper applied in routeBrowserMessage (consumer).
 */
const IDE_SERVER_KEY_PREFIX = "companion-ide-";

/**
 * Return `true` if `key` is in the reserved IDE-server namespace (has the
 * `companion-ide-` prefix). Prefix-match only — substring matches (e.g.
 * `"mycompanion-ide-helper"`) are NOT reserved and pass through unchanged.
 */
function isReservedIdeServerKey(key: string): boolean {
  return key.startsWith(IDE_SERVER_KEY_PREFIX);
}

/**
 * Sanitize a user-originated `mcp_set_servers` payload by removing any keys
 * in the reserved `companion-ide-*` namespace. Returns a fresh `servers`
 * map and a fresh `deleteKeys` array (or `undefined` if `deleteKeys` was
 * not provided and no stripping happened) plus a list of the keys that
 * were stripped (empty if none) so the caller can emit a single warning.
 *
 * The input objects are never mutated.
 */
export function stripReservedIdeKeys(
  servers: Record<string, McpServerConfig>,
  deleteKeys: string[] | undefined,
): {
  servers: Record<string, McpServerConfig>;
  deleteKeys: string[] | undefined;
  stripped: string[];
} {
  const stripped: string[] = [];
  const cleanServers: Record<string, McpServerConfig> = {};
  for (const [k, v] of Object.entries(servers)) {
    if (isReservedIdeServerKey(k)) {
      stripped.push(k);
    } else {
      cleanServers[k] = v;
    }
  }
  let cleanDeleteKeys: string[] | undefined = deleteKeys;
  if (deleteKeys && deleteKeys.length > 0) {
    const filtered: string[] = [];
    for (const k of deleteKeys) {
      if (isReservedIdeServerKey(k)) {
        stripped.push(k);
      } else {
        filtered.push(k);
      }
    }
    cleanDeleteKeys = filtered;
  }
  return { servers: cleanServers, deleteKeys: cleanDeleteKeys, stripped };
}

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

  /**
   * Unsubscribe handles for the Task 12 companionBus listeners that
   * fan out `{type: "ide_list_changed"}` to every connected browser socket
   * whenever the underlying IDE list mutates (added/removed/changed).
   */
  private ideListChangedUnsubscribes: Array<() => void> = [];

  constructor() {
    // BIND-04: when the IDE discovery layer detects that a lockfile has
    // disappeared (process died, lockfile deleted, etc.), auto-unbind any
    // session currently bound to that port. The frontend detects the
    // bound→null transition via the existing session_update channel and
    // renders the "IDE disconnected — rebind via /ide" banner (BIND-05).
    //
    // The unsubscribe handle is intentionally dropped: WsBridge is a
    // process-lifetime singleton, so there is no teardown path that would
    // call it. Matches the pattern used by other long-lived bus listeners
    // in this file (e.g. ideListChangedUnsubscribes handles are stored but
    // never invoked either).
    companionBus.on("ide:removed", ({ port, lockfilePath }) => {
      for (const [sessionId, session] of this.sessions) {
        const binding = session.state.ideBinding;
        if (!binding) continue;
        // Codex round-7 P2: match by `lockfilePath` (one-to-one with the
        // dead IDE process), not by `port`. Matching on port alone has a
        // race when an IDE dies and another IDE rebinds the same port
        // before the removal event is processed — the bridge would tear
        // down a valid current binding for the new IDE. lockfilePath is
        // unique per IDE process and never reused. Fall back to port for
        // legacy bindings that predate `lockfilePath` storage.
        const matches = binding.lockfilePath
          ? binding.lockfilePath === lockfilePath
          : binding.port === port;
        if (!matches) continue;
        // Fire-and-forget: unbindIde is idempotent and never throws.
        // Round-4 robustness (BIND-10): if the wire send fails because
        // the backend adapter is disconnected, the IDE is STILL gone
        // (discovery removed the lockfile). Force-clear local state so
        // the UI reflects reality and the BIND-05 disconnect banner
        // fires — otherwise the session stays stuck "bound" to a dead
        // IDE with a stale MCP mirror entry forever.
        void this.unbindIde(sessionId).then((result) => {
          if (!result.ok) {
            this.forceClearDeadIdeBinding(sessionId);
          }
        });
      }
    });

    // Task 12 (DISC-03 UX side): broadcast an IDE-list-changed ping to every
    // connected browser whenever the discovery layer adds/removes/changes an
    // IDE. Open IdePicker instances refetch GET /api/ide/available on receipt;
    // closed pickers ignore the ping. The broadcast is payload-free — clients
    // re-enter the same authenticated REST path discovery uses, so no
    // sensitive fields (authToken, lockfilePath) leak over the browser WS.
    const onIdeListChanged = (payload: { generation: number }) =>
      this.broadcastIdeListChanged(payload.generation);
    this.ideListChangedUnsubscribes.push(
      companionBus.on("ide:added", onIdeListChanged),
      companionBus.on("ide:removed", onIdeListChanged),
      companionBus.on("ide:changed", onIdeListChanged),
    );
  }

  /**
   * Fan `{type: "ide_list_changed", generation}` out to every browser socket
   * across every live session. Uses sendToBrowser (no sequencing) because
   * this is a transient refresh ping — clients that missed it while offline
   * will refetch the list on reconnect anyway.
   *
   * `generation` is a monotonic counter from ide-discovery's scan loop. The
   * client uses it to dedupe fan-out across multiple sockets: same generation
   * => same underlying discovery scan (skip); newer generation => fresh
   * event (dispatch). This is stricter than a time-window dedupe because it
   * preserves legitimate fast add+remove cycles (e.g. IDE restart) that
   * would otherwise be lost.
   */
  private broadcastIdeListChanged(generation: number): void {
    const msg: BrowserIncomingMessage = { type: "ide_list_changed", generation };
    for (const session of this.sessions.values()) {
      for (const ws of session.browserSockets) {
        this.sendToBrowser(ws, msg);
      }
    }
  }

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
      // BIND-03: sanitize session state before broadcast — ideBinding.authToken
      // is runtime-only and must not cross the browser WS boundary.
      this.broadcastToBrowsers(session, {
        type: "session_init",
        session: sanitizeSessionStateForBrowser(session.state),
      });
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
        dynamicMcpServers: {},
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
        dynamicMcpServers: {},
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
        // BIND-03: sanitize session state before broadcast (strip ideBinding.authToken).
        this.broadcastToBrowsers(session, {
          type: "session_init",
          session: sanitizeSessionStateForBrowser(session.state),
        });
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
    //
    // cubic round-N P1: delegate to `flushQueuedBrowserMessages` instead of
    // an inline replay loop. The shared helper also re-syncs the dynamic
    // MCP mirror (`updateDynamicMcpServers`) and re-runs `stripReservedIdeKeys`
    // for any queued `mcp_set_servers` payloads. Without that, a Claude
    // reconnect after a server restart (`dynamicMcpServers` reset to `{}` in
    // `restoreFromDisk`) would replay user-configured MCP servers on the wire
    // but leave the mirror empty — a later `bindIde` / `unbindIde` full-replace
    // write would then silently drop every user MCP entry.
    if (session.pendingMessages.length > 0) {
      this.flushQueuedBrowserMessages(session, adapter, "cli_reconnect");
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

    // Send current session state as snapshot.
    // BIND-03: sanitize — strip ideBinding.authToken before it crosses the WS.
    const snapshot: BrowserIncomingMessage = {
      type: "session_init",
      session: sanitizeSessionStateForBrowser(session.state),
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

  // ── IDE binding (Task 6: BIND-01/02/04/06, STATE-01) ─────────────────────
  //
  // MCP-merge contract (round-4 Codex review, Issue 1):
  //
  // The Claude CLI's `mcp_set_servers` control_request is a full replace of
  // the session's DYNAMIC MCP server set (entries submitted via
  // mcp_set_servers at runtime — distinct from the user's persistent
  // ~/.claude.json config, which the CLI continues to merge on top). Keys
  // omitted from `servers` are dropped. Earlier versions of `bindIde` /
  // `unbindIde` sent `{ [ideKey]: entry }` / `{}` alone, silently wiping
  // every other dynamic server the user had configured (via McpPanel →
  // sendMcpSetServers).
  //
  // Fix: ws-bridge tracks `session.dynamicMcpServers` — a per-session
  // in-memory mirror of the dynamic set, updated every time a
  // `mcp_set_servers` flows through `routeBrowserMessage`. bindIde/unbindIde
  // derive their outbound payload from that mirror:
  //
  //   - Claude (full-replace wire protocol):
  //       bind: servers = { ...others, [ideKey]: entry }
  //       unbind: servers = { ...others } (IDE key omitted), no deleteKeys
  //   - Codex (per-key upsert/delete via config/batchWrite):
  //       bind: servers = { [ideKey]: entry } (upsert — doesn't touch others)
  //       unbind: servers = {}, deleteKeys = [ideKey] (per-key delete)
  //
  // Both variants preserve user-added dynamic MCP servers across a bind
  // cycle. Regression tests live under the "MCP-merge preservation" heading
  // in ws-bridge.test.ts.

  /**
   * Apply a `mcp_set_servers` payload (with optional `deleteKeys`) to the
   * session's in-memory dynamic MCP mirror. Deletes are applied first,
   * then upserts — same ordering as codex-adapter.handleOutgoingMcpSetServers
   * so a combined message is well-defined.
   */
  private updateDynamicMcpServers(
    session: Session,
    servers: Record<string, McpServerConfig>,
    deleteKeys?: string[],
  ): void {
    if (deleteKeys && deleteKeys.length > 0) {
      for (const k of deleteKeys) {
        delete session.dynamicMcpServers[k];
      }
    }
    for (const [k, v] of Object.entries(servers)) {
      session.dynamicMcpServers[k] = v;
    }
  }

  /**
   * Bind a Companion session to a running IDE discovered via ~/.claude/ide/.
   *
   * Sends a single {type: "mcp_set_servers", servers: {ide: {...}}} through
   * the existing backend adapter pipeline — NEVER a user_message containing
   * "/ide" text (BIND-06). The /ide slash command stays client-side.
   */
  async bindIde(
    sessionId: string,
    port: number,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    const session = this.sessions.get(sessionId);
    if (!session) return { ok: false, error: "session not found" };

    const ide = listAvailableIdes().find((i) => i.port === port);
    if (!ide) return { ok: false, error: "unknown port" };

    // Shape matches the CLI's internal /ide command (PROBE-02, see
    // WEBSOCKET_PROTOCOL_REVERSED.md IDE appendix). The `type` field
    // carries the transport flavor (ws-ide vs sse-ide); scope:"dynamic"
    // tells the CLI this entry is ephemeral, not persisted to ~/.claude.json.
    const host = session.state.is_containerized ? "host.docker.internal" : "127.0.0.1";
    const ideServerEntry = {
      type: ide.transport, // "ws-ide" or "sse-ide"
      url: `${ide.transport === "ws-ide" ? "ws" : "http"}://${host}:${ide.port}`,
      ideName: ide.ideName,
      authToken: ide.authToken,
      ideRunningInWindows: false,
      scope: "dynamic",
    };

    // Build the MCP server key from the sanitized ideName, prefixed with
    // `"companion-ide-"` to namespace it away from any user-configured dynamic
    // MCP server. Three reasons the prefix matters:
    //
    // (1) TOOL EXPOSURE (original BIND-07): the Claude Code CLI binary contains
    //     a hardcoded filter (`_35`) that blocks all MCP tools prefixed
    //     `mcp__ide__*` EXCEPT `getDiagnostics` and `executeCode`. When the
    //     server is named "ide", the CLI prefixes every tool as
    //     `mcp__ide__<name>` and the filter silently drops 8 of 10 tools.
    //     Using `mcp__companion-ide-<name>__*` bypasses the filter entirely —
    //     any non-empty character between `mcp__` and the next `__` breaks
    //     the exact-match filter, and hyphens are legal in MCP tool names.
    //
    // (2) NAMESPACE COLLISION (cubic P1, prior fix): the bare sanitized name
    //     (e.g. `"neovim"`) shared a namespace with user MCP servers. If a
    //     user registered a dynamic MCP server literally named `"neovim"`,
    //     bindIde would overwrite it and unbindIde would delete it. Adding
    //     any prefix reduces the likelihood, but an attacker/user could still
    //     pick the prefixed form (e.g. `"companionideneovim"`).
    //
    // (3) STRUCTURAL SEPARATOR (codex round-4 review, this fix): the prefix
    //     must share NO characters with the post-sanitization output of user
    //     ideNames. Our sanitizer is `ideName.toLowerCase().replace(/[^a-z0-9]/g, "")`
    //     which emits `[a-z0-9]+`. The hyphens in `"companion-ide-"` are
    //     stripped from any user ideName, so the keyspace of IDE entries
    //     (`companion-ide-[a-z0-9]+`) is DISJOINT from anything a user-sanitized
    //     key can look like. No collision is reachable via the public
    //     `mcp_set_servers` path — users can literally name their MCP server
    //     `"companion-ide-neovim"`, but that still collides with *themselves*,
    //     not with us, because the user key goes through a different write
    //     path that doesn't re-sanitize.
    //
    // Reference: HYPOTHESES.md H4 (confirmed) + Option 3 (confirmed fix) +
    // cubic-ai PR #652 round-3 Issue 1 + codex round-4 BLOCK 1.
    // Regression tests: BIND-07, BIND-08, BIND-08d in ws-bridge.test.ts.
    const sanitizedIdeName = ide.ideName.toLowerCase().replace(/[^a-z0-9]/g, "");

    // Round-4 Codex review, Issue 2 + cubic round-3: reject empty-sanitized
    // tails. A lockfile whose ideName is all punctuation (e.g. "!?", "---")
    // would sanitize to "" — even with the `companion-ide-` prefix we must
    // reject, otherwise every such lockfile would register under the same
    // literal key `"companion-ide-"` and collide across different IDE processes.
    // Short-circuit BEFORE any adapter write — same error shape as the other
    // bind errors so routes/ide-session-routes maps to 400 and nothing is
    // sent on the wire.
    if (sanitizedIdeName.length === 0) {
      return { ok: false, error: "invalid IDE name" };
    }
    const serverKey = `${IDE_SERVER_KEY_PREFIX}${sanitizedIdeName}`;

    // CORRECTNESS: require a live, connected backend adapter. Without it,
    // the CLI will never learn about the IDE and any binding we record is
    // split-brain (UI says bound; CLI has no MCP entry). Three-layer guard
    // per codex adversarial review issue #2:
    //   (1) adapter must be attached,
    //   (2) adapter.isConnected() must be true (transport-level),
    //   (3) adapter.send() must return true (write accepted by transport).
    // Any failure short-circuits BEFORE mutating session state or
    // broadcasting — same error string so the picker surfaces the existing
    // "backend not connected" banner + Retry.
    const adapter = session.backendAdapter;
    if (!adapter || !adapter.isConnected()) {
      return { ok: false, error: "backend not connected" };
    }

    // Guard: prevent concurrent browser `mcp_set_servers` from racing us.
    // While this flag is set, `routeBrowserMessage` queues `mcp_set_servers`
    // messages instead of forwarding them immediately. Cleared in `finally`.
    session.ideBindInProgress = true;
    try {

    // Round-5 Codex review, BLOCK: drain pending browser messages first so a
    // stale `mcp_set_servers` in the queue (enqueued while `adapter.send()`
    // transiently returned false) cannot replay AFTER us and clobber the IDE
    // entry. On Claude this matters most: `mcp_set_servers` is full-replace
    // semantics on the wire, so a later-arriving stale payload missing the
    // IDE key silently drops the IDE MCP entry and produces a split-brain
    // (UI shows bound, CLI lost the IDE server). Draining first also means
    // the `session.dynamicMcpServers` mirror we read on the next line is
    // already up to date with the queue's effects (the mirror mutates at
    // route time in `updateDynamicMcpServers`).
    //
    // If the drain fails to fully clear (send() returned false mid-flush and
    // a retryable message was re-queued), treat this as not-connected — it's
    // safer than proceeding with a half-flushed queue that would race us.
    if (session.pendingMessages.length > 0) {
      this.flushQueuedBrowserMessages(session, adapter, "ide_bind_predrain");
      if (session.pendingMessages.length > 0) {
        return { ok: false, error: "backend not connected" };
      }
    }

    // Codex round-7 P1: when re-binding to a DIFFERENT IDE (e.g. switching
    // from Neovim to VS Code), the prior IDE's `companion-ide-<old>` entry
    // must be evicted from BOTH the outbound payload and the local mirror.
    // bindIde only ever upserts the *new* serverKey; without this eviction,
    // the prior entry stays live in `session.dynamicMcpServers` indefinitely
    // (carrying a stale `authToken`) and on Claude's full-replace wire shape
    // both old and new IDE servers would be sent at once. unbindIde later
    // only deletes the *current* serverKey, so the orphan entry would leak
    // forever.
    const priorIdeKeys = Object.keys(session.dynamicMcpServers).filter(
      (k) => k.startsWith(IDE_SERVER_KEY_PREFIX) && k !== serverKey,
    );

    // Build the outbound `servers` payload — backend-specific shape.
    //
    // Claude (full-replace): we MUST include every dynamic server the user
    //   has previously configured or it will be dropped. We merge on top of
    //   the bridge's in-memory mirror (session.dynamicMcpServers). The IDE
    //   entry overrides any prior entry at the same key (same-ideName rebind).
    //   Prior `companion-ide-*` keys (other IDE) are omitted via the filter
    //   above so the wire payload reflects "exactly one IDE bound".
    //
    // Codex (per-key upsert): `config/batchWrite` processes each key
    //   independently. Sending the full mirror here would spuriously re-upsert
    //   every other server on every bind. Send only the IDE entry, plus a
    //   deleteKeys list to evict any prior IDE entry on the wire.
    //
    // `servers` is typed as Record<string, McpServerConfig> in session-types,
    // but the real wire shape for ws-ide/sse-ide carries extra fields
    // (ideName, authToken, ideRunningInWindows, scope). Cast through unknown
    // to bypass the narrow type — the adapter's handleOutgoingMcpSetServers
    // accepts Record<string, unknown>.
    let outboundServers: Record<string, unknown>;
    let outboundDeleteKeys: string[];
    if (session.backendType === "claude") {
      const merged: Record<string, unknown> = { ...session.dynamicMcpServers };
      for (const k of priorIdeKeys) delete merged[k];
      merged[serverKey] = ideServerEntry;
      outboundServers = merged;
      outboundDeleteKeys = [];
    } else {
      outboundServers = { [serverKey]: ideServerEntry };
      outboundDeleteKeys = priorIdeKeys;
    }
    // Await the backend's actual acknowledgement before committing UI state.
    // Previously this used fire-and-forget `send()` which returns `true` the
    // moment the message is enqueued — for Codex that meant UI showed
    // "bound" before `config/batchWrite` even ran, and a silent backend
    // failure only surfaced via a later `error` emission. `applyMcpSetServers`
    // resolves `{ok: false}` on real backend failure so we can bail out
    // without touching `session.state.ideBinding`.
    if (adapter.applyMcpSetServers) {
      const result = await adapter.applyMcpSetServers(
        outboundServers as Record<string, import("./session-types.js").McpServerConfig>,
        outboundDeleteKeys,
      );
      if (!result.ok) return { ok: false, error: result.error };
    } else {
      const accepted = adapter.send({
        type: "mcp_set_servers",
        servers: outboundServers as Record<string, import("./session-types.js").McpServerConfig>,
        deleteKeys: outboundDeleteKeys,
      });
      if (!accepted) {
        return { ok: false, error: "backend not connected" };
      }
    }

    // Mirror the mutation we just sent to the backend so subsequent
    // bind/unbind cycles (and any later user mcp_set_servers) see a
    // consistent view. Drop prior IDE entries first, then upsert the new one.
    for (const k of priorIdeKeys) delete session.dynamicMcpServers[k];
    session.dynamicMcpServers[serverKey] = ideServerEntry as unknown as McpServerConfig;

    const binding: IdeBinding = {
      port: ide.port,
      ideName: ide.ideName,
      workspaceFolders: ide.workspaceFolders,
      transport: ide.transport,
      authToken: ide.authToken,
      boundAt: Date.now(),
      lockfilePath: ide.lockfilePath,
    };

    // Mutate session.state directly — same pattern used by setLinearSessionId
    // (ws-bridge.ts line ~97) and the session_update handler (~line 447).
    session.state.ideBinding = binding;
    this.persistSession(session);
    companionBus.emit("ide:binding-changed", { sessionId, binding });

    // Browser sync via the existing session_update message (not a new
    // variant — the plan explicitly forbids inventing one).
    //
    // BIND-03 SECURITY: `authToken` is runtime-only and must NEVER cross the
    // browser WS boundary. Strip it from the broadcast payload. The server's
    // in-memory `session.state.ideBinding` still carries it (required for
    // MCP injection on re-bind); the wire shape does not.
    this.broadcastToBrowsers(session, {
      type: "session_update",
      session: { ideBinding: stripAuthToken(binding) },
    });

    return { ok: true };

    } finally {
      session.ideBindInProgress = false;
      if (session.pendingMessages.length > 0 && adapter.isConnected()) {
        this.flushQueuedBrowserMessages(session, adapter, "ide_bind_postdrain");
      }
    }
  }

  /**
   * Unbind a session's IDE. Idempotent: missing session or already-null
   * binding both return {ok: true}. Always sets `ideBinding` to an
   * explicit `null` (not undefined) so the FE can distinguish
   * "never bound" from "was bound, now disconnected" (BIND-04 / BIND-05).
   */
  async unbindIde(
    sessionId: string,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    const session = this.sessions.get(sessionId);
    if (!session) return { ok: true };

    // If already null/undefined, no-op. Idempotent: DELETE /api/sessions/:id/ide
    // and the auto-unbind path both call this without first checking state.
    const hadBinding = session.state.ideBinding != null;
    if (!hadBinding) return { ok: true };

    // Codex round-2 issue #1: mirror bindIde's three-layer adapter guard so
    // the UI "unbound" state and the CLI MCP registry cannot diverge.
    //   (1) adapter attached, (2) isConnected() true, (3) send() accepted.
    // Without all three, the CLI never sees the tear-down mcp_set_servers
    // and keeps the stale IDE MCP entry — a split-brain where UI shows
    // "unbound" but MCP tools are still registered. Return the same error
    // string as bindIde so the picker surfaces the existing
    // "backend not connected" banner + Retry.
    const adapter = session.backendAdapter;
    if (!adapter || !adapter.isConnected()) {
      return { ok: false, error: "backend not connected" };
    }

    session.ideBindInProgress = true;
    try {

    // Round-5 Codex review, BLOCK: same rationale as `bindIde` — drain any
    // queued browser `mcp_set_servers` BEFORE we emit our own mutation, so
    // a stale payload cannot replay after us and clobber the unbind (Claude
    // full-replace) or re-upsert the IDE key (Codex per-key upsert) once
    // we've torn it down. If the drain doesn't fully clear the queue, refuse
    // to proceed: better to surface "backend not connected" and let the
    // picker retry than to half-apply an unbind with a racing queue behind us.
    if (session.pendingMessages.length > 0) {
      this.flushQueuedBrowserMessages(session, adapter, "ide_unbind_predrain");
      if (session.pendingMessages.length > 0) {
        return { ok: false, error: "backend not connected" };
      }
    }
    // Recompute `serverKey` with the same BIND-07/BIND-08 sanitization +
    // `companion-ide-` structural-separator prefix that `bindIde` used.
    // `ideBinding.ideName` is always the canonical source — the CLI was
    // taught that prefixed key at bind time and will only delete it if we
    // target it exactly.
    const boundIdeName = session.state.ideBinding?.ideName ?? "";
    const sanitizedIdeName = boundIdeName.toLowerCase().replace(/[^a-z0-9]/g, "");
    const serverKey = sanitizedIdeName ? `${IDE_SERVER_KEY_PREFIX}${sanitizedIdeName}` : "";

    // Round-4 Codex review, Issue 1: the outbound payload is backend-specific
    // so other user-configured dynamic MCP servers are preserved.
    //
    // Claude (full-replace wire protocol): send the in-memory mirror WITH
    //   the IDE key omitted. Claude will then drop the IDE entry (it's not
    //   in the payload) while keeping every other key we include. We do NOT
    //   set `deleteKeys` because the Claude adapter ignores it anyway —
    //   Claude expresses deletion via omission.
    //
    // Codex (per-key upsert/delete): keep the surgical shape. `servers: {}`
    //   is an empty upsert set; `deleteKeys: [serverKey]` drops the single
    //   IDE entry without touching any other mcp_servers.<key>. Sending the
    //   full mirror here would re-upsert every other dynamic server on every
    //   unbind — wasteful and racy with concurrent edits.
    let outboundServers: Record<string, import("./session-types.js").McpServerConfig>;
    let outboundDeleteKeys: string[];
    if (session.backendType === "claude") {
      const merged: Record<string, McpServerConfig> = { ...session.dynamicMcpServers };
      if (serverKey) delete merged[serverKey];
      outboundServers = merged as Record<string, import("./session-types.js").McpServerConfig>;
      outboundDeleteKeys = [];
    } else {
      outboundServers = {} as Record<string, import("./session-types.js").McpServerConfig>;
      outboundDeleteKeys = serverKey ? [serverKey] : [];
    }
    // Await the backend's ack before committing `ideBinding = null`. See the
    // rationale on the matching block in `bindIde` — we'd rather surface a
    // real failure than leave the UI saying "unbound" while the CLI still
    // has the IDE MCP entry registered.
    if (adapter.applyMcpSetServers) {
      const result = await adapter.applyMcpSetServers(
        outboundServers,
        outboundDeleteKeys,
      );
      if (!result.ok) return { ok: false, error: result.error };
    } else {
      const accepted = adapter.send({
        type: "mcp_set_servers",
        servers: outboundServers,
        deleteKeys: outboundDeleteKeys,
      });
      if (!accepted) {
        return { ok: false, error: "backend not connected" };
      }
    }

    // Drop the IDE entry from the bridge's mirror so subsequent reads are
    // consistent with what we just told the backend.
    if (serverKey) delete session.dynamicMcpServers[serverKey];

    // Explicit null (not undefined) — FE key to detect the transition.
    session.state.ideBinding = null;
    this.persistSession(session);
    companionBus.emit("ide:binding-changed", { sessionId, binding: null });

    this.broadcastToBrowsers(session, {
      type: "session_update",
      session: { ideBinding: null },
    });

    return { ok: true };

    } finally {
      session.ideBindInProgress = false;
      if (session.pendingMessages.length > 0 && adapter.isConnected()) {
        this.flushQueuedBrowserMessages(session, adapter, "ide_unbind_postdrain");
      }
    }
  }

  /**
   * BIND-10 (Round-4): force-clear a dead IDE binding when the auto-unbind
   * wire send failed because the backend was disconnected. The lockfile is
   * definitively gone (discovery emitted `ide:removed`), so the binding is
   * dead regardless of backend reachability. This path diverges from
   * `unbindIde` in that it does NOT attempt adapter.send — it simply
   * reconciles local state with the on-disk truth so:
   *
   *   - `session.state.ideBinding === null` (UI transitions out of "bound")
   *   - `dynamicMcpServers["companion-ide-*"]` is purged (no stale entry
   *     gets replayed next time the backend reconnects via restoreMcpState)
   *   - a session_update broadcast fires so the BIND-05 disconnect banner
   *     renders in every open browser tab for this session.
   *
   * Only called from the `ide:removed` bus listener after unbindIde has
   * already returned {ok: false}. Safe to call when ideBinding is already
   * null — no-ops cleanly.
   */
  private forceClearDeadIdeBinding(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    if (session.state.ideBinding == null) return;

    // Purge any companion-ide-* entries from the MCP mirror. There should
    // only be one, but we sweep by prefix so the cleanup is robust even if
    // a past bug ever stashed multiples.
    for (const key of Object.keys(session.dynamicMcpServers)) {
      if (key.startsWith(IDE_SERVER_KEY_PREFIX)) {
        delete session.dynamicMcpServers[key];
      }
    }

    session.state.ideBinding = null;
    this.persistSession(session);
    companionBus.emit("ide:binding-changed", { sessionId, binding: null });

    this.broadcastToBrowsers(session, {
      type: "session_update",
      session: { ideBinding: null },
    });
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

    // -- mcp_set_servers: mirror the dynamic MCP state the bridge has sent to
    // the backend. This is the authoritative in-memory record of what the
    // CLI / Codex should know about. `bindIde` / `unbindIde` later read this
    // to construct merge-safe payloads (Claude full-replace; Codex surgical).
    // Apply deleteKeys BEFORE upserts so a single message with both fields is
    // well-defined (matches codex-adapter's phase-1-delete / phase-2-upsert).
    //
    // cubic-ai review (PR #652, Issue 1): Claude's `mcp_set_servers` is a
    // FULL REPLACE on the wire. When a browser sends `mcp_set_servers` while
    // an IDE is bound, the user's payload has no reason to include the IDE
    // entry — so Claude would drop it on the next CLI apply, producing a
    // split-brain (UI shows bound; CLI lost the IDE MCP server). Inject the
    // active IDE entry into the outbound payload BEFORE forwarding, unless
    // the user explicitly deletes the IDE key via `deleteKeys`. Codex is
    // per-key upsert (not full-replace), so no injection needed there.
    if (msg.type === "mcp_set_servers") {
      // Codex round-5 BLOCK 1: reserved-namespace stripping. Any caller going
      // through `routeBrowserMessage` is USER-ORIGINATED (browser payload via
      // handleBrowserMessage, or programmatic `injectMcpSetServers`). Neither
      // is allowed to occupy the `companion-ide-*` namespace — only
      // bindIde/unbindIde (which write directly via adapter.send, bypassing
      // this path) may touch those keys. Strip any reserved keys from BOTH
      // `servers` and `deleteKeys` BEFORE the merge injection, mirror update,
      // and adapter.send. Without this, a user payload of
      // `{servers: {"companion-ide-neovim": {...}}}` would overwrite our
      // bridge-authored IDE entry (or `{deleteKeys: ["companion-ide-neovim"]}`
      // would delete it) and produce a split-brain between UI and CLI.
      const { servers: cleanServers, deleteKeys: cleanDeleteKeys, stripped } =
        stripReservedIdeKeys(msg.servers, msg.deleteKeys);
      if (stripped.length > 0) {
        log.warn(
          "ws-bridge",
          "Stripped reserved companion-ide-* keys from user mcp_set_servers payload",
          {
            sessionId: session.id,
            strippedKeys: stripped,
          },
        );
        msg = { ...msg, servers: cleanServers, deleteKeys: cleanDeleteKeys };
      }

      if (session.backendType === "claude" && session.state.ideBinding) {
        // Must match the `companion-ide-`-prefixed structural-separator key
        // that bindIde/unbindIde use (BIND-08 / BIND-08d). Using the bare
        // sanitized name here would fail to detect the IDE entry in
        // session.dynamicMcpServers.
        const sanitizedIdeName = session.state.ideBinding.ideName
          .toLowerCase()
          .replace(/[^a-z0-9]/g, "");
        const ideKey = sanitizedIdeName ? `${IDE_SERVER_KEY_PREFIX}${sanitizedIdeName}` : "";
        // Post-strip invariant: the reserved-key stripper above has already
        // removed any user-supplied entry for `ideKey` from msg.servers and
        // msg.deleteKeys. `explicitlyDeleted` / `alreadyPresent` can therefore
        // only be true if a prior adapter-level caller (which bypasses the
        // stripper) set them — and that never happens on this path. We still
        // evaluate them defensively to keep the merge-injection semantics
        // idempotent if the stripping contract ever shifts.
        const explicitlyDeleted = !!msg.deleteKeys?.includes(ideKey);
        const alreadyPresent = Object.prototype.hasOwnProperty.call(
          msg.servers,
          ideKey,
        );
        const ideEntry = session.dynamicMcpServers[ideKey];
        if (
          ideKey.length > 0 &&
          !explicitlyDeleted &&
          !alreadyPresent &&
          ideEntry !== undefined
        ) {
          // Non-mutating: rebuild msg with the IDE entry injected into
          // servers. `msg` is reassigned so the downstream adapter.send()
          // picks up the merged payload.
          msg = {
            ...msg,
            servers: { ...msg.servers, [ideKey]: ideEntry },
          };
        }
      }
      this.updateDynamicMcpServers(session, msg.servers, msg.deleteKeys);
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

    // H2 race guard: if bindIde/unbindIde is mid-flight, queue this message
    // instead of sending it. The message has already been through IDE
    // injection and mirror updates above, so the queued payload is correct.
    // The postdrain in bind/unbind's `finally` block will flush it.
    if (msg.type === "mcp_set_servers" && session.ideBindInProgress) {
      this.enqueuePendingMessage(session, JSON.stringify(msg));
      this.persistSession(session);
      return;
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

      // Round-6 Codex review, BLOCK: keep the `dynamicMcpServers` mirror in
      // sync with queued `mcp_set_servers` payloads whose in-process mirror
      // update was lost across a server restart. `pendingMessages` is
      // persisted to disk (session-store) but `dynamicMcpServers` is not —
      // after a cold restore the mirror is `{}` even though the queued
      // payload still remembers user-configured servers. Without this
      // catch-up, a subsequent `bindIde` reads an empty mirror, sends
      // `{ide}` alone, and the full-replace semantics on Claude's wire
      // silently drop every other dynamic server.
      //
      // `updateDynamicMcpServers` is idempotent (merge + delete), so the
      // in-process path (where `routeBrowserMessage` already mirrored
      // before enqueue) just reapplies the same mutation. Must run BEFORE
      // `adapter.send()` so bindIde's pre-drain → mirror-read sequence
      // sees the mirror up to date even if send() fails and we re-queue.
      //
      // BIND-08h (Codex CONDITIONAL-GO → blocking defensive invariant):
      // re-run `stripReservedIdeKeys` at the replay site. Today
      // `routeBrowserMessage` is the only enqueue path and it already
      // strips before enqueue, so this is a no-op in practice. But by
      // making the strip a STRUCTURAL INVARIANT at every mirror write
      // site (not a caller contract), we defend against any future code
      // path that might enqueue an unsanitized `mcp_set_servers` — a
      // deserialized-from-disk payload, a new adapter hook, a direct
      // `session.pendingMessages.push` from another module. Without
      // this, such a bug would silently pollute the `companion-ide-*`
      // namespace on replay.
      if (queuedMsg.type === "mcp_set_servers") {
        const { servers: cleanServers, deleteKeys: cleanDeleteKeys, stripped } =
          stripReservedIdeKeys(queuedMsg.servers, queuedMsg.deleteKeys);
        if (stripped.length > 0) {
          log.warn(
            "ws-bridge",
            "Stripped reserved companion-ide-* keys from queued mcp_set_servers during flush replay",
            {
              sessionId: session.id,
              strippedKeys: stripped,
              reason,
            },
          );
          queuedMsg = { ...queuedMsg, servers: cleanServers, deleteKeys: cleanDeleteKeys };
        }
        // C2 fix: re-inject the active IDE entry after stripping. The strip
        // above correctly removes user-supplied companion-ide-* keys, but also
        // removes bridge-injected IDE entries (e.g. from messages queued during
        // ideBindInProgress). On Claude's full-replace wire, omitting the IDE
        // entry causes the CLI to drop it. Mirror the injection logic from
        // routeBrowserMessage so the flushed payload preserves the IDE binding.
        if (session.backendType === "claude" && session.state.ideBinding) {
          const sanitizedIdeName = session.state.ideBinding.ideName
            .toLowerCase()
            .replace(/[^a-z0-9]/g, "");
          const ideKey = sanitizedIdeName ? `${IDE_SERVER_KEY_PREFIX}${sanitizedIdeName}` : "";
          const explicitlyDeleted = !!queuedMsg.deleteKeys?.includes(ideKey);
          const ideEntry = session.dynamicMcpServers[ideKey];
          if (ideKey.length > 0 && !explicitlyDeleted && ideEntry !== undefined) {
            queuedMsg = {
              ...queuedMsg,
              servers: { ...queuedMsg.servers, [ideKey]: ideEntry },
            };
          }
        }
        this.updateDynamicMcpServers(session, queuedMsg.servers, queuedMsg.deleteKeys);
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
