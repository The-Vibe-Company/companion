/**
 * Claude Code Backend Adapter
 *
 * Translates between the Claude Code NDJSON stdio protocol and
 * The Companion's BrowserIncomingMessage/BrowserOutgoingMessage types.
 *
 * Transport: companion spawns claude in headless stdio mode
 * (`--print --input-format stream-json --output-format stream-json`) and
 * pipes stdin/stdout directly. The bridge stays transport-agnostic — it
 * only sees the typed Browser* messages.
 *
 * Historical note: through 2026-05 this adapter consumed the CLI's
 * `--sdk-url` WebSocket. Claude Code 2.1.121 added hostname validation
 * that broke that path (companion#655); we cut over to documented stdio.
 */

import { randomUUID } from "node:crypto";
import type { IBackendAdapter } from "./backend-adapter.js";
import type {
  BrowserIncomingMessage,
  BrowserOutgoingMessage,
  CLIMessage,
  CLISystemMessage,
  CLISystemInitMessage,
  CLIAssistantMessage,
  CLIResultMessage,
  CLIStreamEventMessage,
  CLIToolProgressMessage,
  CLIToolUseSummaryMessage,
  CLIControlRequestMessage,
  CLIControlResponseMessage,
  CLIAuthStatusMessage,
  CLIControlCancelRequestMessage,
  CLIStreamlinedTextMessage,
  CLIStreamlinedToolUseSummaryMessage,
  CLIPromptSuggestionMessage,
  CLICompactBoundaryMessage,
  CLITaskNotificationMessage,
  CLIFilesPersistedMessage,
  CLIHookStartedMessage,
  CLIHookProgressMessage,
  CLIHookResponseMessage,
  PermissionRequest,
  McpServerDetail,
  SessionState,
} from "./session-types.js";
import type { PendingControlRequest } from "./ws-bridge-types.js";
import type { RecorderManager } from "./recorder.js";
import { parseNDJSON, isDuplicateCLIMessage } from "./ws-bridge-cli-ingest.js";
import type { CLIDedupState } from "./ws-bridge-cli-ingest.js";
import { reportProtocolDrift } from "./protocol-monitor.js";
import { companionBus } from "./event-bus.js";
import { log } from "./logger.js";

// --- Constants ----------------------------------------------------------------

/** Number of recent CLI message hashes to track for deduplication on WS reconnect. */
const CLI_DEDUP_WINDOW = 2000;

// --- Claude Code Adapter ------------------------------------------------------

/** Minimal duck-typed stdin handle. Wide return type accommodates both
 *  Node's Writable (returns boolean) and Bun's FileSink (returns number |
 *  Promise<number>) without coupling callers to a specific stream library.
 */
export interface ClaudeAdapterStdinSink {
  write(data: string): unknown;
}

/** Minimal duck-typed stdout source. The adapter only listens for `data`
 *  events; using a small interface keeps tests free of real streams. */
export interface ClaudeAdapterStdoutSource {
  on(event: "data", listener: (chunk: Buffer | string) => void): unknown;
  off(event: "data", listener: (chunk: Buffer | string) => void): unknown;
}

export class ClaudeAdapter implements IBackendAdapter {
  private sessionId: string;

  // stdio handles to the spawned Claude Code CLI subprocess. Both null until
  // attachStdio() runs; null again after disconnect / child exit.
  private cliStdin: ClaudeAdapterStdinSink | null = null;
  private cliStdout: ClaudeAdapterStdoutSource | null = null;
  private stdoutListener: ((chunk: Buffer | string) => void) | null = null;
  // Line buffer for stdout — OS pipe boundaries can split an NDJSON line in
  // half, so we accumulate until we see a newline before dispatching.
  private stdoutBuffer = "";

  // Callbacks registered by the bridge via on*() methods
  private browserMessageCb: ((msg: BrowserIncomingMessage) => void) | null = null;
  private sessionMetaCb: ((meta: { cliSessionId?: string; model?: string; cwd?: string }) => void) | null = null;
  private disconnectCb: (() => void) | null = null;

  // Pending NDJSON messages queued before stdio is attached. The launcher
  // attaches synchronously after spawn, so this normally stays empty, but
  // a stray send() between adapter construction and attach is still queued.
  private pendingMessages: string[] = [];

  // Last model reported via sessionMetaCb. Used to debounce per-assistant-message
  // model reconciliation so we only fire onSessionMeta when the model actually
  // changes (otherwise refreshGitInfo would run on every turn).
  private lastReportedModel: string | null = null;

  // Async control request/response pairs (e.g. MCP status queries)
  private pendingControlRequests = new Map<string, PendingControlRequest>();

  // CLI message deduplication state (rolling hash window)
  private dedupState: CLIDedupState = {
    recentCLIMessageHashes: [],
    recentCLIMessageHashSet: new Set(),
  };

  // Optional recorder for raw protocol messages
  private recorder: RecorderManager | null;

  // Callback to update session.lastCliActivityTs from the bridge
  private onActivityUpdate: (() => void) | null;

  // Hang-watchdog: kills the child process if no stdout arrives within
  // `hangWatchdogMs` while we're still expecting a turn to finish.
  // Recovers from cases where the upstream API SSE stream silently stalls
  // (proxy stops sending chunks without closing TCP) — the stall can happen
  // before the first byte OR mid-stream, so the watchdog ticks across the
  // entire turn until a `result` arrives. See project_claude_silent_hang.md.
  //
  // Permission-gate pause: while `pendingPermissionGates > 0` the CLI is
  // waiting on the user (control_request{can_use_tool} was sent and the
  // user hasn't clicked Allow/Deny yet). Suspend the watchdog refcounted
  // so a long human-side delay doesn't get misread as an upstream hang.
  private killProcess: (() => void) | null;
  private hangWatchdogMs: number;
  private hangWatchdogTimer: ReturnType<typeof setTimeout> | null = null;
  private expectingTurnResponse = false;
  private pendingPermissionGates = 0;

  private protocolDriftSeen = new Set<string>();
  private parseErrorSeen = new Set<string>();

  constructor(
    sessionId: string,
    opts?: {
      recorder?: RecorderManager | null;
      onActivityUpdate?: () => void;
      /** Fired when no stdout arrives within hangWatchdogMs of a user
       *  message — usually wired to `proc.kill("SIGTERM")` so the
       *  orchestrator's keepalive can respawn with --resume. */
      killProcess?: () => void;
      /** Silence threshold after a user_message before killProcess fires.
       *  Default 90s. Set to 0 to disable. Override via env in launcher. */
      hangWatchdogMs?: number;
    },
  ) {
    this.sessionId = sessionId;
    this.recorder = opts?.recorder ?? null;
    this.onActivityUpdate = opts?.onActivityUpdate ?? null;
    this.killProcess = opts?.killProcess ?? null;
    this.hangWatchdogMs = opts?.hangWatchdogMs ?? 90_000;
  }

  // -- stdio lifecycle --------------------------------------------------------

  /**
   * Wire the adapter to the spawned CLI's stdin/stdout. Stdin is used for
   * outgoing NDJSON; stdout is line-buffered and each complete line is fed
   * back into handleRawMessage(). Flushes any messages that were queued
   * before the spawn completed.
   */
  attachStdio(stdin: ClaudeAdapterStdinSink, stdout: ClaudeAdapterStdoutSource): void {
    // If something else is still attached (re-spawn race), detach it first.
    this.detachStdio();
    this.cliStdin = stdin;
    this.cliStdout = stdout;
    this.stdoutBuffer = "";

    const onData = (chunk: Buffer | string) => {
      this.stdoutBuffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      let nl: number;
      while ((nl = this.stdoutBuffer.indexOf("\n")) !== -1) {
        const line = this.stdoutBuffer.slice(0, nl);
        this.stdoutBuffer = this.stdoutBuffer.slice(nl + 1);
        if (line.trim().length === 0) continue;
        this.handleRawMessage(line);
      }
    };
    this.stdoutListener = onData;
    stdout.on("data", onData);

    // Flush pending messages
    if (this.pendingMessages.length > 0) {
      console.log(
        `[claude-adapter] Flushing ${this.pendingMessages.length} queued message(s) for session ${this.sessionId}`,
      );
      const queued = this.pendingMessages.splice(0);
      for (const ndjson of queued) {
        this.sendRaw(ndjson);
      }
    }
  }

  /**
   * Tear down the stdio attachment without firing the disconnect callback.
   * Called from attachStdio() (re-attach path) and disconnect() (intentional
   * shutdown). The bridge invokes notifyDisconnect() separately on child exit.
   */
  detachStdio(): void {
    if (this.cliStdout && this.stdoutListener) {
      try {
        this.cliStdout.off("data", this.stdoutListener);
      } catch {
        // Stream already destroyed; nothing to clean up.
      }
    }
    this.cliStdin = null;
    this.cliStdout = null;
    this.stdoutListener = null;
    this.stdoutBuffer = "";
    // Clear any armed hang watchdog — the child is gone (or about to be
    // re-attached); firing killProcess on a stale process would either
    // be a no-op or kill the wrong PID after fork-then-spawn.
    this.clearHangWatchdog();
  }

  /**
   * Called by the launcher when the spawned CLI process exits. Drops the
   * stdio refs and fires the disconnect callback so the bridge / orchestrator
   * can run their existing relaunch path.
   */
  notifyChildExited(): void {
    if (!this.cliStdin && !this.cliStdout) return;
    this.detachStdio();
    this.disconnectCb?.();
  }

  // -- IBackendAdapter: Event registration ------------------------------------

  onBrowserMessage(cb: (msg: BrowserIncomingMessage) => void): void {
    this.browserMessageCb = cb;
  }

  onSessionMeta(cb: (meta: { cliSessionId?: string; model?: string; cwd?: string }) => void): void {
    this.sessionMetaCb = cb;
  }

  onDisconnect(cb: () => void): void {
    this.disconnectCb = cb;
  }

  // -- IBackendAdapter: Transport state ---------------------------------------

  isConnected(): boolean {
    return this.cliStdin !== null;
  }

  async disconnect(): Promise<void> {
    // Clear pending control requests to prevent memory leaks from
    // unresolved promises (CLI won't respond after disconnect)
    this.pendingControlRequests.clear();
    this.detachStdio();
  }

  /**
   * Drop the transport without firing the disconnect callback. Kept for
   * parity with the old API; functionally equivalent to detachStdio() in
   * the stdio world (no separate proxy layer to consider).
   */
  handleTransportClose(): void {
    this.detachStdio();
  }

  // -- IBackendAdapter: Raw message ingestion from CLI ------------------------

  /**
   * Called when raw NDJSON data arrives from the CLI's stdout pipe.
   * Parses lines, deduplicates, and routes each message.
   */
  handleRawMessage(data: string): void {
    // Any byte from the CLI counts as liveness — the silent-hang watchdog
    // is purely about "is the child still talking to us?", not about
    // whether the message is meaningful. Reschedule before parsing so
    // even garbled lines that fail JSON.parse defuse a pending kill,
    // then re-arm if we're still expecting a result for this turn.
    this.scheduleHangWatchdog();

    // Record raw incoming CLI message before any parsing
    this.recorder?.record(
      this.sessionId, "in", data, "cli", "claude", "",
    );

    const lines = parseNDJSON(data);
    for (const line of lines) {
      let msg: CLIMessage;
      try {
        msg = JSON.parse(line);
      } catch {
        reportProtocolDrift(
          this.parseErrorSeen,
          {
            backend: "claude",
            sessionId: this.sessionId,
            direction: "incoming",
            messageKind: "parse_error",
            messageName: "ndjson",
            rawPreview: line,
          },
          (message) => this.browserMessageCb?.({ type: "error", message }),
        );
        continue;
      }

      if (isDuplicateCLIMessage(msg, line, this.dedupState, CLI_DEDUP_WINDOW)) {
        continue;
      }

      this.routeCLIMessage(msg);
    }
  }

  // -- IBackendAdapter: send() -- browser -> CLI translation ------------------

  send(msg: BrowserOutgoingMessage): boolean {
    if (msg.type === "user_message") {
      // Arm the silent-hang watchdog: if no stdout line arrives from the
      // CLI within hangWatchdogMs after we ship this user message, the
      // upstream SSE has probably stalled and we kill the child so the
      // orchestrator's keepalive can respawn it with --resume.
      this.armHangWatchdog();
    }
    switch (msg.type) {
      case "user_message":
        return this.handleOutgoingUserMessage(msg);

      case "permission_response":
        return this.handleOutgoingPermissionResponse(msg);

      case "interrupt":
        return this.handleOutgoingInterrupt();

      case "set_model":
        return this.handleOutgoingSetModel(msg.model);

      case "set_permission_mode":
        return this.handleOutgoingSetPermissionMode(msg.mode);

      case "set_ai_validation":
        // AI validation state is managed at the bridge/session level, not
        // forwarded to the CLI. Return true to indicate acceptance.
        return true;

      case "mcp_get_status":
        return this.handleOutgoingMcpGetStatus();

      case "mcp_toggle":
        return this.handleOutgoingMcpToggle(msg.serverName, msg.enabled);

      case "mcp_reconnect":
        return this.handleOutgoingMcpReconnect(msg.serverName);

      case "mcp_set_servers":
        return this.handleOutgoingMcpSetServers(msg.servers);

      case "end_session":
        return this.handleOutgoingEndSession((msg as { reason?: string }).reason);

      case "stop_task":
        return this.handleOutgoingStopTask((msg as { task_id: string }).task_id);

      case "update_environment_variables":
        return this.handleOutgoingUpdateEnvVars((msg as { variables: Record<string, string> }).variables);

      case "session_subscribe":
      case "session_ack":
        // These are handled at the bridge level -- never forwarded to the backend.
        return false;

      default:
        return false;
    }
  }

  // -- Outgoing message handlers (browser -> NDJSON) --------------------------

  private handleOutgoingUserMessage(
    msg: { type: "user_message"; content: string; session_id?: string; images?: { media_type: string; data: string }[] },
  ): boolean {
    // Build content: if images are present, use content block array; otherwise plain string
    let content: string | unknown[];
    if (msg.images?.length) {
      const blocks: unknown[] = [];
      for (const img of msg.images) {
        blocks.push({
          type: "image",
          source: { type: "base64", media_type: img.media_type, data: img.data },
        });
      }
      blocks.push({ type: "text", text: msg.content });
      content = blocks;
    } else {
      content = msg.content;
    }

    const ndjson = JSON.stringify({
      type: "user",
      message: { role: "user", content },
      parent_tool_use_id: null,
      session_id: msg.session_id || "",
    });
    this.sendToBackend(ndjson);
    return true;
  }

  private handleOutgoingPermissionResponse(
    msg: {
      type: "permission_response";
      request_id: string;
      behavior: "allow" | "deny";
      updated_input?: Record<string, unknown>;
      updated_permissions?: unknown[];
      message?: string;
    },
  ): boolean {
    if (msg.behavior === "allow") {
      const response: Record<string, unknown> = {
        behavior: "allow",
        updatedInput: msg.updated_input ?? {},
      };
      if (msg.updated_permissions?.length) {
        response.updatedPermissions = msg.updated_permissions;
      }
      const ndjson = JSON.stringify({
        type: "control_response",
        response: {
          subtype: "success",
          request_id: msg.request_id,
          response,
        },
      });
      this.sendToBackend(ndjson);
    } else {
      const ndjson = JSON.stringify({
        type: "control_response",
        response: {
          subtype: "success",
          request_id: msg.request_id,
          response: {
            behavior: "deny",
            message: msg.message || "Denied by user",
          },
        },
      });
      this.sendToBackend(ndjson);
    }
    // Close one permission gate. When the last one closes, the CLI is
    // back at work on the upstream API — re-arm the hang watchdog so it
    // can catch a stall that happens between here and `result`.
    if (this.pendingPermissionGates > 0) {
      this.pendingPermissionGates--;
      if (this.pendingPermissionGates === 0) {
        this.scheduleHangWatchdog();
      }
    }
    return true;
  }

  private handleOutgoingInterrupt(): boolean {
    const ndjson = JSON.stringify({
      type: "control_request",
      request_id: randomUUID(),
      request: { subtype: "interrupt" },
    });
    this.sendToBackend(ndjson);
    return true;
  }

  private handleOutgoingSetModel(model: string): boolean {
    const ndjson = JSON.stringify({
      type: "control_request",
      request_id: randomUUID(),
      request: { subtype: "set_model", model },
    });
    this.sendToBackend(ndjson);
    return true;
  }

  private handleOutgoingSetPermissionMode(mode: string): boolean {
    const ndjson = JSON.stringify({
      type: "control_request",
      request_id: randomUUID(),
      request: { subtype: "set_permission_mode", mode },
    });
    this.sendToBackend(ndjson);
    return true;
  }

  private handleOutgoingMcpGetStatus(): boolean {
    this.sendControlRequest(
      { subtype: "mcp_status" },
      {
        subtype: "mcp_status",
        resolve: (response) => {
          const servers = (response as { mcpServers?: McpServerDetail[] }).mcpServers ?? [];
          this.browserMessageCb?.({ type: "mcp_status", servers });
        },
      },
    );
    return true;
  }

  private handleOutgoingMcpToggle(serverName: string, enabled: boolean): boolean {
    this.sendControlRequest({ subtype: "mcp_toggle", serverName, enabled });
    // Refresh MCP status after a delay to pick up the change
    setTimeout(() => this.handleOutgoingMcpGetStatus(), 500);
    return true;
  }

  private handleOutgoingMcpReconnect(serverName: string): boolean {
    this.sendControlRequest({ subtype: "mcp_reconnect", serverName });
    // Refresh MCP status after a delay to pick up the reconnection
    setTimeout(() => this.handleOutgoingMcpGetStatus(), 1000);
    return true;
  }

  private handleOutgoingMcpSetServers(servers: Record<string, unknown>): boolean {
    this.sendControlRequest({ subtype: "mcp_set_servers", servers });
    // Refresh MCP status after a delay to pick up the new server config
    setTimeout(() => this.handleOutgoingMcpGetStatus(), 2000);
    return true;
  }

  private handleOutgoingEndSession(reason?: string): boolean {
    this.sendControlRequest({ subtype: "end_session", ...(reason ? { reason } : {}) });
    return true;
  }

  private handleOutgoingStopTask(taskId: string): boolean {
    this.sendControlRequest({ subtype: "stop_task", task_id: taskId });
    return true;
  }

  private handleOutgoingUpdateEnvVars(variables: Record<string, string>): boolean {
    const ndjson = JSON.stringify({
      type: "update_environment_variables",
      variables,
    });
    this.sendToBackend(ndjson);
    return true;
  }

  // -- CLI message routing (NDJSON -> BrowserIncomingMessage) -----------------

  private routeCLIMessage(msg: CLIMessage): void {
    // Track activity for idle detection (skip keepalives -- they don't indicate real work)
    if (msg.type !== "keep_alive") {
      this.onActivityUpdate?.();
    }

    switch (msg.type) {
      case "system":
        this.handleSystemMessage(msg);
        break;

      case "assistant":
        this.handleAssistantMessage(msg);
        break;

      case "result":
        this.handleResultMessage(msg);
        break;

      case "stream_event":
        this.handleStreamEvent(msg);
        break;

      case "control_request":
        this.handleControlRequest(msg);
        break;

      case "control_response":
        this.handleControlResponse(msg);
        break;

      case "tool_progress":
        this.handleToolProgress(msg);
        break;

      case "tool_use_summary":
        this.handleToolUseSummary(msg);
        break;

      case "auth_status":
        this.handleAuthStatus(msg);
        break;

      case "keep_alive":
        // Silently consume keepalives
        break;

      case "user":
        // CLI echoes back user messages (including tool_result blocks from
        // subagents). The browser doesn't need these — it already has
        // tool_progress/tool_use_summary for live state, and persists user
        // messages from its own send path. But non-browser observers need
        // a signal that a tool completed; emit tool:result on the bus for
        // each tool_result content block we see.
        this.handleUserEcho(msg as { message?: { content?: unknown } });
        break;

      case "rate_limit_event":
        // Rate-limit status from Claude API (allowed/throttled). Silently
        // consumed — no user-facing action needed.
        break;

      case "control_cancel_request":
        this.handleControlCancelRequest(msg as CLIControlCancelRequestMessage);
        break;

      case "streamlined_text":
        this.handleStreamlinedText(msg as CLIStreamlinedTextMessage);
        break;

      case "streamlined_tool_use_summary":
        this.handleStreamlinedToolUseSummary(msg as CLIStreamlinedToolUseSummaryMessage);
        break;

      case "prompt_suggestion":
        this.handlePromptSuggestion(msg as CLIPromptSuggestionMessage);
        break;

      default:
        reportProtocolDrift(
          this.protocolDriftSeen,
          {
            backend: "claude",
            sessionId: this.sessionId,
            direction: "incoming",
            messageKind: "message",
            messageName: (msg as { type?: string }).type || "unknown",
            rawPreview: JSON.stringify(msg),
          },
          (message) => this.browserMessageCb?.({ type: "error", message }),
        );
        break;
    }
  }

  // -- System message handling ------------------------------------------------

  private handleSystemMessage(msg: CLISystemMessage): void {
    if (msg.subtype === "init") {
      this.handleSystemInit(msg as CLISystemInitMessage);
      return;
    }

    if (msg.subtype === "status") {
      const statusMsg = msg as { subtype: "status"; status: "compacting" | null; permissionMode?: string; uuid: string; session_id: string };
      // Include permissionMode in the emitted message so the bridge can update session state
      const statusChange: Record<string, unknown> = {
        type: "status_change",
        status: statusMsg.status ?? null,
      };
      if (statusMsg.permissionMode) {
        statusChange.permissionMode = statusMsg.permissionMode;
      }
      this.browserMessageCb?.(statusChange as BrowserIncomingMessage);
      return;
    }

    if (msg.subtype === "api_retry") {
      // 2.1.119+ emits this when the upstream API call fails with a 5xx
      // and the CLI is about to retry. Forward as a system_event so the
      // UI can show "retrying after 502" inline; without this the user
      // sees only the eventual error result after a long opaque pause.
      const m = msg as import("./session-types.js").CLISystemApiRetryMessage;
      this.emitSystemEvent({
        subtype: "api_retry",
        attempt: m.attempt,
        max_retries: m.max_retries,
        retry_delay_ms: m.retry_delay_ms,
        error_status: m.error_status,
        error: m.error,
        uuid: m.uuid,
        session_id: m.session_id,
      });
      return;
    }

    if (msg.subtype === "compact_boundary") {
      const m = msg as CLICompactBoundaryMessage;
      this.emitSystemEvent({
        subtype: "compact_boundary",
        compact_metadata: m.compact_metadata,
        uuid: m.uuid,
        session_id: m.session_id,
      });
      return;
    }

    if (msg.subtype === "task_notification") {
      const m = msg as CLITaskNotificationMessage;
      this.emitSystemEvent({
        subtype: "task_notification",
        task_id: m.task_id,
        status: m.status,
        output_file: m.output_file,
        summary: m.summary,
        uuid: m.uuid,
        session_id: m.session_id,
      });
      return;
    }

    if (msg.subtype === "files_persisted") {
      const m = msg as CLIFilesPersistedMessage;
      this.emitSystemEvent({
        subtype: "files_persisted",
        files: m.files,
        failed: m.failed,
        processed_at: m.processed_at,
        uuid: m.uuid,
        session_id: m.session_id,
      });
      return;
    }

    if (msg.subtype === "hook_started") {
      const m = msg as CLIHookStartedMessage;
      this.emitSystemEvent({
        subtype: "hook_started",
        hook_id: m.hook_id,
        hook_name: m.hook_name,
        hook_event: m.hook_event,
        uuid: m.uuid,
        session_id: m.session_id,
      });
      return;
    }

    if (msg.subtype === "hook_progress") {
      const m = msg as CLIHookProgressMessage;
      // hook_progress is transient -- emitted but not persisted in message history.
      // The bridge handler decides on persistence based on message type.
      this.emitSystemEvent({
        subtype: "hook_progress",
        hook_id: m.hook_id,
        hook_name: m.hook_name,
        hook_event: m.hook_event,
        stdout: m.stdout,
        stderr: m.stderr,
        output: m.output,
        uuid: m.uuid,
        session_id: m.session_id,
      });
      return;
    }

    if (msg.subtype === "hook_response") {
      const m = msg as CLIHookResponseMessage;
      this.emitSystemEvent({
        subtype: "hook_response",
        hook_id: m.hook_id,
        hook_name: m.hook_name,
        hook_event: m.hook_event,
        output: m.output,
        stdout: m.stdout,
        stderr: m.stderr,
        exit_code: m.exit_code,
        outcome: m.outcome,
        uuid: m.uuid,
        session_id: m.session_id,
      });
      return;
    }

    // Unknown system subtypes are intentionally ignored until we map them.
  }

  private handleSystemInit(msg: CLISystemInitMessage): void {
    // Emit session metadata so the bridge can update session state
    this.sessionMetaCb?.({
      cliSessionId: msg.session_id,
      model: msg.model,
      cwd: msg.cwd,
    });
    this.lastReportedModel = msg.model;

    // Emit session_init to browsers with CLI-provided fields only.
    // The bridge's attachBackendAdapter handler will merge these into the
    // canonical session state (which owns git info, cost, etc.) and broadcast.
    this.browserMessageCb?.({
      type: "session_init",
      session: {
        session_id: msg.session_id,
        model: msg.model,
        cwd: msg.cwd,
        tools: msg.tools,
        permissionMode: msg.permissionMode,
        claude_code_version: msg.claude_code_version,
        mcp_servers: msg.mcp_servers,
        agents: msg.agents ?? [],
        slash_commands: msg.slash_commands ?? [],
        skills: msg.skills ?? [],
        // memory_paths is only emitted by 2.1.119+ — leave undefined when
        // the field is absent so older CLIs don't poison existing state with
        // a stale empty string.
        ...(msg.memory_paths?.auto ? { memory_path: msg.memory_paths.auto } : {}),
      } as SessionState,
    });

    // Flush any NDJSON messages queued before the CLI was initialized
    // (e.g. user sent a message while the CLI was still starting up).
    if (this.pendingMessages.length > 0) {
      console.log(
        `[claude-adapter] Flushing ${this.pendingMessages.length} queued message(s) after init for session ${this.sessionId}`,
      );
      const queued = this.pendingMessages.splice(0);
      for (const ndjson of queued) {
        this.sendRaw(ndjson);
      }
    }
  }

  // -- Assistant, result, stream ----------------------------------------------

  private handleAssistantMessage(msg: CLIAssistantMessage): void {
    // Reconcile session model with what the CLI actually used. Set_model is
    // fire-and-forget with no control_response, and the CLI doesn't re-emit
    // `system init`, so this assistant.model field is the authoritative
    // confirmation. Skip subagent turns (parent_tool_use_id != null) since
    // those run under their own model and shouldn't overwrite the session's.
    const model = msg.message.model;
    if (model && msg.parent_tool_use_id == null && model !== this.lastReportedModel) {
      this.lastReportedModel = model;
      this.sessionMetaCb?.({ model });
    }
    this.browserMessageCb?.({
      type: "assistant",
      message: msg.message,
      parent_tool_use_id: msg.parent_tool_use_id,
      timestamp: Date.now(),
    });
  }

  private handleResultMessage(msg: CLIResultMessage): void {
    // Turn complete — stop ticking the hang watchdog until the next
    // user_message arms it again.
    this.finishTurnWatchdog();
    this.browserMessageCb?.({
      type: "result",
      data: msg,
    });
  }

  private handleStreamEvent(msg: CLIStreamEventMessage): void {
    this.browserMessageCb?.({
      type: "stream_event",
      event: msg.event,
      parent_tool_use_id: msg.parent_tool_use_id,
    });
  }

  // -- Control request (permission) -------------------------------------------

  private handleControlRequest(msg: CLIControlRequestMessage): void {
    if (msg.request.subtype === "can_use_tool") {
      // Open a permission gate: the CLI is now waiting on the user, not on
      // the upstream API. Pause the hang watchdog until the response goes
      // back out (handleOutgoingPermissionResponse decrements & re-arms).
      this.pendingPermissionGates++;
      this.clearHangWatchdog();

      const perm: PermissionRequest = {
        request_id: msg.request_id,
        tool_name: msg.request.tool_name,
        input: msg.request.input,
        permission_suggestions: msg.request.permission_suggestions,
        description: msg.request.description,
        tool_use_id: msg.request.tool_use_id,
        agent_id: msg.request.agent_id,
        title: msg.request.title,
        display_name: msg.request.display_name,
        blocked_path: msg.request.blocked_path,
        decision_reason: msg.request.decision_reason,
        timestamp: Date.now(),
      };

      this.browserMessageCb?.({
        type: "permission_request",
        request: perm,
      });
    }
  }

  // -- Control cancel request ------------------------------------------------

  private handleControlCancelRequest(msg: CLIControlCancelRequestMessage): void {
    // Clean up any pending async control request in the adapter
    this.pendingControlRequests.delete(msg.request_id);
    // CLI is rescinding the permission gate — re-arm watchdog if this
    // closes the last one. Same accounting as a user-side response.
    if (this.pendingPermissionGates > 0) {
      this.pendingPermissionGates--;
      if (this.pendingPermissionGates === 0) {
        this.scheduleHangWatchdog();
      }
    }
    // Emit permission_cancelled so the bridge removes from pendingPermissions
    this.browserMessageCb?.({
      type: "permission_cancelled",
      request_id: msg.request_id,
    });
  }

  // -- Streamlined messages (simplified output mode) -------------------------

  private handleStreamlinedText(msg: CLIStreamlinedTextMessage): void {
    this.browserMessageCb?.({
      type: "streamlined_text",
      text: msg.text,
    } as BrowserIncomingMessage);
  }

  private handleStreamlinedToolUseSummary(msg: CLIStreamlinedToolUseSummaryMessage): void {
    this.browserMessageCb?.({
      type: "streamlined_tool_use_summary",
      tool_summary: msg.tool_summary,
    } as BrowserIncomingMessage);
  }

  // -- Prompt suggestions ----------------------------------------------------

  private handlePromptSuggestion(msg: CLIPromptSuggestionMessage): void {
    this.browserMessageCb?.({
      type: "prompt_suggestion",
      suggestions: msg.suggestions,
    } as BrowserIncomingMessage);
  }

  // -- Control response (for pending control requests like MCP status) --------

  private handleControlResponse(msg: CLIControlResponseMessage): void {
    const reqId = msg.response.request_id;
    const pending = this.pendingControlRequests.get(reqId);
    if (!pending) return;
    this.pendingControlRequests.delete(reqId);
    if (msg.response.subtype === "error") {
      console.warn(
        `[claude-adapter] Control request ${pending.subtype} failed: ${msg.response.error}`,
      );
      return;
    }
    pending.resolve(msg.response.response ?? {});
  }

  // -- Tool progress & summary ------------------------------------------------

  private handleToolProgress(msg: CLIToolProgressMessage): void {
    this.browserMessageCb?.({
      type: "tool_progress",
      tool_use_id: msg.tool_use_id,
      tool_name: msg.tool_name,
      elapsed_time_seconds: msg.elapsed_time_seconds,
    });
  }

  private handleToolUseSummary(msg: CLIToolUseSummaryMessage): void {
    this.browserMessageCb?.({
      type: "tool_use_summary",
      summary: msg.summary,
      tool_use_ids: msg.preceding_tool_use_ids,
    });
  }

  // -- User echo (extract tool_result blocks for the event bus) -------------
  //
  // The CLI echoes back its own user message after running a tool — content
  // is an array of blocks, typically one or more tool_result entries.
  // Browsers ignore this echo for normal tool outcomes (tool state is
  // communicated via tool_progress and tool_use_summary). Non-browser
  // observers need to know when a tool finished, so emit tool:result
  // on the bus per tool_result block.
  //
  // Exception: the CLI's internal "sensitive file" rejection of Write/Edit
  // returns `{is_error:true, content:"Claude requested permissions to edit
  // X which is a sensitive file."}` and never fires can_use_tool. Without
  // a side-channel the browser never learns the gate exists. We sniff that
  // exact wording and forward it to the browser so the
  // SensitiveFileWriteApproval card can render. See
  // project_claude_sensitive_file_gate.md.
  private handleUserEcho(msg: { message?: { content?: unknown } }): void {
    const content = msg.message?.content;
    if (!Array.isArray(content)) return;
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      const b = block as { type?: string; tool_use_id?: string; content?: unknown; is_error?: boolean };
      if (b.type !== "tool_result") continue;
      if (typeof b.tool_use_id !== "string") continue;
      companionBus.emit("tool:result", {
        sessionId: this.sessionId,
        toolUseId: b.tool_use_id,
        content: typeof b.content === "string" || Array.isArray(b.content) ? b.content : "",
        isError: Boolean(b.is_error),
      });
      if (
        b.is_error
        && typeof b.content === "string"
        && /which is a sensitive file\.?\s*$/i.test(b.content.trim())
      ) {
        this.browserMessageCb?.({
          type: "sensitive_file_rejection",
          tool_use_id: b.tool_use_id,
          content: b.content,
        });
      }
    }
  }

  // -- Auth status ------------------------------------------------------------

  private handleAuthStatus(msg: CLIAuthStatusMessage): void {
    this.browserMessageCb?.({
      type: "auth_status",
      isAuthenticating: msg.isAuthenticating,
      output: msg.output,
      error: msg.error,
    });
  }

  // -- Helpers ----------------------------------------------------------------

  /**
   * Emit a system_event BrowserIncomingMessage to browsers.
   */
  private emitSystemEvent(
    event: Extract<BrowserIncomingMessage, { type: "system_event" }>["event"],
  ): void {
    this.browserMessageCb?.({
      type: "system_event",
      event,
      timestamp: Date.now(),
    });
  }

  /**
   * Send a control_request to the CLI and optionally track the pending response.
   */
  private sendControlRequest(
    request: Record<string, unknown>,
    onResponse?: { subtype: string; resolve: (response: unknown) => void },
  ): void {
    const requestId = randomUUID();
    if (onResponse) {
      this.pendingControlRequests.set(requestId, onResponse);
    }
    const ndjson = JSON.stringify({
      type: "control_request",
      request_id: requestId,
      request,
    });
    this.sendToBackend(ndjson);
  }

  /**
   * Send a raw NDJSON string to the CLI, bypassing the BrowserOutgoingMessage
   * translation layer. Used for Claude-specific control requests (e.g. initialize)
   * that don't map to a BrowserOutgoingMessage type.
   */
  sendRawNDJSON(ndjson: string): void {
    this.sendToBackend(ndjson);
  }

  /**
   * Begin watching for stdout activity for the current turn. Called when
   * a user_message goes out; turn ends when a `result` message arrives
   * (handled in routeCLIMessage → finishTurnWatchdog).
   */
  private armHangWatchdog(): void {
    this.expectingTurnResponse = true;
    this.scheduleHangWatchdog();
  }

  /**
   * (Re)start the silent-stdout timer. Called by armHangWatchdog and on
   * every incoming line so the timer rolls forward across a streaming
   * turn — the SSE stall can happen mid-stream too.
   */
  private scheduleHangWatchdog(): void {
    this.clearHangWatchdog();
    if (!this.expectingTurnResponse) return;
    if (!this.killProcess || this.hangWatchdogMs <= 0) return;
    // Don't tick while a permission gate is open — the CLI is waiting on
    // the user, not the API. Will be re-armed when the last permission
    // resolves (see handleOutgoingPermissionResponse).
    if (this.pendingPermissionGates > 0) return;
    this.hangWatchdogTimer = setTimeout(() => {
      this.hangWatchdogTimer = null;
      log.warn("claude-adapter", "CLI hang watchdog fired — no stdout during active turn", {
        sessionId: this.sessionId,
        windowMs: this.hangWatchdogMs,
      });
      // Two-step recovery: emit the bus event FIRST so the orchestrator
      // can mark this as an intentional kill BEFORE the SIGTERM causes
      // proc.exited → session:exited → keepalive. Without that ordering,
      // keepalive would race ahead and auto-respawn into the same SSE
      // stall (or worse, into a session-level upstream outage). The user
      // still gets a relaunch when they focus the session again, via the
      // existing browser-driven relaunch-needed path.
      companionBus.emit("session:hang-detected", { sessionId: this.sessionId });
      try {
        this.killProcess?.();
      } catch (err) {
        log.error("claude-adapter", "killProcess threw during hang recovery", {
          sessionId: this.sessionId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }, this.hangWatchdogMs);
  }

  private clearHangWatchdog(): void {
    if (this.hangWatchdogTimer) {
      clearTimeout(this.hangWatchdogTimer);
      this.hangWatchdogTimer = null;
    }
  }

  /**
   * Mark the current turn as finished. Called when `result` arrives —
   * after that, no further stdout is expected and the watchdog should
   * stop ticking until the next user_message. Any permission gates that
   * were open at turn end are also closed (the CLI won't ask again on
   * this turn) so the refcount can't leak across turns.
   */
  private finishTurnWatchdog(): void {
    this.expectingTurnResponse = false;
    this.pendingPermissionGates = 0;
    this.clearHangWatchdog();
  }

  /**
   * Send an NDJSON string to the CLI. If stdio isn't attached yet (rare:
   * launcher attaches synchronously after spawn), queue for the next flush
   * in attachStdio().
   */
  private sendToBackend(ndjson: string): void {
    if (!this.cliStdin) {
      console.log(
        `[claude-adapter] CLI not yet connected for session ${this.sessionId}, queuing message`,
      );
      this.pendingMessages.push(ndjson);
      return;
    }
    this.sendRaw(ndjson);
  }

  /**
   * Low-level send: writes NDJSON to the CLI's stdin with a newline delimiter.
   * Records the outgoing message. Assumes cliStdin is non-null.
   */
  private sendRaw(ndjson: string): void {
    // Record raw outgoing CLI message
    this.recorder?.record(
      this.sessionId, "out", ndjson, "cli", "claude", "",
    );
    try {
      this.cliStdin!.write(ndjson + "\n");
    } catch (err) {
      console.error(
        `[claude-adapter] Failed to write to CLI stdin for session ${this.sessionId}:`,
        err,
      );
    }
  }
}
