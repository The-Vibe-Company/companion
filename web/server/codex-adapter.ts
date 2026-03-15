/**
 * Codex App-Server Adapter
 *
 * Translates between the Codex app-server JSON-RPC protocol (stdin/stdout)
 * and The Companion's BrowserIncomingMessage/BrowserOutgoingMessage types.
 *
 * This allows the browser to be completely unaware of which backend is running —
 * it sees the same message types regardless of whether Claude Code or Codex is
 * the backend.
 */

import { randomUUID } from "node:crypto";
import type { Subprocess } from "bun";
import type { IBackendAdapter } from "./backend-adapter.js";
import type {
  BrowserIncomingMessage,
  BrowserOutgoingMessage,
  SessionState,
  PermissionRequest,
  CLIResultMessage,
  McpServerDetail,
  McpServerConfig,
} from "./session-types.js";
import type { RecorderManager } from "./recorder.js";
import { reportProtocolDrift } from "./protocol-monitor.js";
import { log } from "./logger.js";

// ─── Codex JSON-RPC Types ─────────────────────────────────────────────────────

interface JsonRpcRequest {
  method: string;
  id: number;
  params: Record<string, unknown>;
}

interface JsonRpcNotification {
  method: string;
  params: Record<string, unknown>;
}

interface JsonRpcResponse {
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

// Codex item types
interface CodexItem {
  type: string;
  id: string;
  [key: string]: unknown;
}

/** Safely extract a string kind from a Codex file change entry.
 *  Codex may send kind as a string ("create") or as an object ({ type: "modify" }). */
function safeKind(kind: unknown): string {
  if (typeof kind === "string") return kind;
  if (kind && typeof kind === "object" && "type" in kind) {
    const t = (kind as Record<string, unknown>).type;
    if (typeof t === "string") return t;
  }
  return "modify";
}

interface CodexAgentMessageItem extends CodexItem {
  type: "agentMessage";
  text?: string;
}

interface CodexCommandExecutionItem extends CodexItem {
  type: "commandExecution";
  command: string | string[];
  cwd?: string;
  status: "inProgress" | "completed" | "failed" | "declined";
  exitCode?: number;
  durationMs?: number;
}

interface CodexFileChangeItem extends CodexItem {
  type: "fileChange";
  changes?: Array<{ path: string; kind: unknown; diff?: string }>;
  status: "inProgress" | "completed" | "failed" | "declined";
}

interface CodexMcpToolCallItem extends CodexItem {
  type: "mcpToolCall";
  server: string;
  tool: string;
  status: "inProgress" | "completed" | "failed";
  arguments?: Record<string, unknown>;
  result?: string;
  error?: string;
}

interface CodexWebSearchItem extends CodexItem {
  type: "webSearch";
  query?: string;
  action?: { type: string; url?: string; pattern?: string };
}

interface CodexReasoningItem extends CodexItem {
  type: "reasoning";
  summary?: string;
  content?: string;
}

interface CodexContextCompactionItem extends CodexItem {
  type: "contextCompaction";
}

interface CodexCollabAgentToolCallItem extends CodexItem {
  type: "collabAgentToolCall";
  tool: string;
  status: "inProgress" | "completed" | "failed";
  senderThreadId?: string;
  receiverThreadIds?: string[];
  prompt?: string | null;
  agentsStates?: Record<string, unknown>;
}

interface PlanTodo {
  content: string;
  status: "pending" | "in_progress" | "completed";
  activeForm?: string;
}

interface CodexMcpServerStatus {
  name: string;
  tools?: Record<string, { name?: string; annotations?: unknown }>;
  authStatus?: "unsupported" | "notLoggedIn" | "bearerToken" | "oAuth";
}

interface CodexMcpStatusListResponse {
  data?: CodexMcpServerStatus[];
  nextCursor?: string | null;
}

// ─── Transport Interface ─────────────────────────────────────────────────────

/** Abstract transport for Codex JSON-RPC communication. */
export interface ICodexTransport {
  call(method: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<unknown>;
  notify(method: string, params?: Record<string, unknown>): Promise<void>;
  respond(id: number, result: unknown): Promise<void>;
  onNotification(handler: (method: string, params: Record<string, unknown>) => void): void;
  onRequest(handler: (method: string, id: number, params: Record<string, unknown>) => void): void;
  onRawIncoming(cb: (line: string) => void): void;
  onRawOutgoing(cb: (data: string) => void): void;
  onParseError(cb: (message: string) => void): void;
  isConnected(): boolean;
}

/** Default RPC call timeout in milliseconds. */
const DEFAULT_RPC_TIMEOUT_MS = 60_000;

/** Per-method timeout overrides (ms). */
const RPC_METHOD_TIMEOUTS: Record<string, number> = {
  "turn/start": 120_000,
  "turn/interrupt": 15_000,
  "codex/configureSession": 30_000,
  "thread/start": 30_000,
  "thread/resume": 30_000,
};

// ─── Adapter Options ──────────────────────────────────────────────────────────

export interface CodexAdapterOptions {
  model?: string;
  cwd?: string;
  /** Runtime cwd for Codex RPC calls. Falls back to `cwd` when omitted. */
  executionCwd?: string;
  approvalMode?: string;
  sandbox?: "workspace-write" | "danger-full-access";
  /** If provided, resume an existing thread instead of starting a new one. */
  threadId?: string;
  /** Optional recorder for raw message capture. */
  recorder?: RecorderManager;
  /** Callback to kill the underlying process/connection on disconnect. */
  killProcess?: () => Promise<void> | void;
  /** Optional system prompt injected into thread/start as instructions (e.g. Linear context). */
  systemPrompt?: string;
}

// ─── Stdio JSON-RPC Transport ────────────────────────────────────────────────

export class StdioTransport implements ICodexTransport {
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private pendingTimers = new Map<number, ReturnType<typeof setTimeout>>();
  private notificationHandler: ((method: string, params: Record<string, unknown>) => void) | null = null;
  private requestHandler: ((method: string, id: number, params: Record<string, unknown>) => void) | null = null;
  private rawInCb: ((line: string) => void) | null = null;
  private rawOutCb: ((data: string) => void) | null = null;
  private parseErrorCb: ((message: string) => void) | null = null;
  private writer: WritableStreamDefaultWriter<Uint8Array>;
  private connected = true;
  private buffer = "";
  private protocolDriftSeen = new Set<string>();

  constructor(
    stdin: WritableStream<Uint8Array> | { write(data: Uint8Array): number },
    stdout: ReadableStream<Uint8Array>,
    private readonly sessionId = "unknown",
  ) {
    // Handle both Bun subprocess stdin types
    let writable: WritableStream<Uint8Array>;
    if ("write" in stdin && typeof stdin.write === "function") {
      // Bun's subprocess stdin has a .write() method directly
      writable = new WritableStream({
        write(chunk) {
          (stdin as { write(data: Uint8Array): number }).write(chunk);
        },
      });
    } else {
      writable = stdin as WritableStream<Uint8Array>;
    }
    // Acquire writer once and hold it — avoids "WritableStream is locked" race
    // when concurrent async calls (e.g. rateLimits + turn/start) overlap.
    this.writer = writable.getWriter();

    this.readStdout(stdout);
  }

  private async readStdout(stdout: ReadableStream<Uint8Array>): Promise<void> {
    const reader = stdout.getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        this.buffer += decoder.decode(value, { stream: true });
        this.processBuffer();
      }
    } catch (err) {
      log.error("codex-adapter", "stdout reader error", {
        sessionId: this.sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      this.connected = false;
      // Clear all pending RPC timers and reject promises so callers don't
      // hang indefinitely when the Codex process crashes or exits.
      for (const [id, timer] of this.pendingTimers) {
        clearTimeout(timer);
      }
      this.pendingTimers.clear();
      for (const [id, { reject }] of this.pending) {
        reject(new Error("Transport closed"));
      }
      this.pending.clear();
    }
  }

  private processBuffer(): void {
    const lines = this.buffer.split("\n");
    // Keep the last incomplete line in the buffer
    this.buffer = lines.pop() || "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      // Record raw incoming line before parsing
      this.rawInCb?.(trimmed);

      let msg: JsonRpcMessage;
      try {
        msg = JSON.parse(trimmed);
      } catch {
        reportProtocolDrift(
          this.protocolDriftSeen,
          {
            backend: "codex",
            sessionId: this.sessionId,
            direction: "incoming",
            messageKind: "parse_error",
            messageName: "json-rpc",
            rawPreview: trimmed,
          },
          (message) => this.parseErrorCb?.(message),
        );
        continue;
      }

      this.dispatch(msg);
    }
  }

  private dispatch(msg: JsonRpcMessage): void {
    if ("id" in msg && msg.id !== undefined) {
      if ("method" in msg && msg.method) {
        // This is a request FROM the server (e.g., approval request)
        this.requestHandler?.(msg.method, msg.id as number, (msg as JsonRpcRequest).params || {});
      } else {
        // This is a response to one of our requests
        const msgId = msg.id as number;
        const pending = this.pending.get(msgId);
        if (pending) {
          this.pending.delete(msgId);
          const timer = this.pendingTimers.get(msgId);
          if (timer) {
            clearTimeout(timer);
            this.pendingTimers.delete(msgId);
          }
          const resp = msg as JsonRpcResponse;
          if (resp.error) {
            pending.reject(new Error(resp.error.message));
          } else {
            pending.resolve(resp.result);
          }
        }
      }
    } else if ("method" in msg) {
      // When the WS proxy reconnects to Codex, all pending RPC calls are
      // orphaned (Codex sees a fresh connection and won't respond to them).
      // Reject them immediately so callers don't hang until timeout.
      if ((msg as JsonRpcNotification).method === "companion/wsReconnected") {
        const pendingCount = this.pending.size;
        if (pendingCount > 0) {
          console.warn(
            `[codex-adapter] WS proxy reconnected — rejecting ${pendingCount} orphaned RPC call(s)`,
          );
          for (const [id, timer] of this.pendingTimers) {
            clearTimeout(timer);
          }
          this.pendingTimers.clear();
          for (const [id, { reject }] of this.pending) {
            reject(new Error("Transport reconnected"));
          }
          this.pending.clear();
        }
      }
      // Notification (no id)
      this.notificationHandler?.(msg.method, (msg as JsonRpcNotification).params || {});
    }
  }

  /** Send a request and wait for the matching response.
   *  Rejects with a timeout error if no response arrives within the deadline. */
  async call(method: string, params: Record<string, unknown> = {}, timeoutMs?: number): Promise<unknown> {
    const id = this.nextId++;
    const effectiveTimeout = timeoutMs ?? RPC_METHOD_TIMEOUTS[method] ?? DEFAULT_RPC_TIMEOUT_MS;
    return new Promise(async (resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.pendingTimers.delete(id);
        reject(new Error(`RPC timeout: ${method} did not respond within ${effectiveTimeout}ms`));
      }, effectiveTimeout);
      this.pendingTimers.set(id, timer);
      this.pending.set(id, { resolve, reject });
      const request = JSON.stringify({ method, id, params });
      try {
        await this.writeRaw(request + "\n");
      } catch (err) {
        clearTimeout(timer);
        this.pendingTimers.delete(id);
        this.pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /** Send a notification (no response expected). */
  async notify(method: string, params: Record<string, unknown> = {}): Promise<void> {
    const notification = JSON.stringify({ method, params });
    await this.writeRaw(notification + "\n");
  }

  /** Respond to a request from the server (e.g., approval). */
  async respond(id: number, result: unknown): Promise<void> {
    const response = JSON.stringify({ id, result });
    await this.writeRaw(response + "\n");
  }

  /** Register handler for server-initiated notifications. */
  onNotification(handler: (method: string, params: Record<string, unknown>) => void): void {
    this.notificationHandler = handler;
  }

  /** Register handler for server-initiated requests (need a response). */
  onRequest(handler: (method: string, id: number, params: Record<string, unknown>) => void): void {
    this.requestHandler = handler;
  }

  isConnected(): boolean {
    return this.connected;
  }

  /** Register callback for raw incoming lines (before JSON parse). */
  onRawIncoming(cb: (line: string) => void): void {
    this.rawInCb = cb;
  }

  /** Register callback for raw outgoing data (before write). */
  onRawOutgoing(cb: (data: string) => void): void {
    this.rawOutCb = cb;
  }

  /** Register callback for parse error messages to surface to the browser. */
  onParseError(cb: (message: string) => void): void {
    this.parseErrorCb = cb;
  }

  private async writeRaw(data: string): Promise<void> {
    if (!this.connected) {
      throw new Error("Transport closed");
    }
    // Record raw outgoing data before writing
    this.rawOutCb?.(data);
    await this.writer.write(new TextEncoder().encode(data));
  }
}

// ─── Codex Adapter ────────────────────────────────────────────────────────────

export class CodexAdapter implements IBackendAdapter {
  private transport: ICodexTransport;
  private sessionId: string;
  private options: CodexAdapterOptions;

  private browserMessageCb: ((msg: BrowserIncomingMessage) => void) | null = null;
  private sessionMetaCb: ((meta: { cliSessionId?: string; model?: string; cwd?: string }) => void) | null = null;
  private disconnectCb: (() => void) | null = null;
  private initErrorCb: ((error: string) => void) | null = null;

  // State
  private threadId: string | null = null;
  private currentTurnId: string | null = null;
  private connected = false;
  private initialized = false;
  private initFailed = false;
  private initInProgress = false;

  // Streaming accumulator for agent messages
  private streamingText = "";
  private streamingItemId: string | null = null;

  // Track command execution start times for progress indicator
  private commandStartTimes = new Map<string, number>();

  // Track requested runtime mode for subsequent turns.
  private currentPermissionMode: string;
  private lastNonPlanPermissionMode: string;
  private currentCollaborationModeKind: "default" | "plan";
  // Track what we last sent to Codex so we only send on transitions.
  // null = nothing sent yet (first turn needs to send if starting in plan).
  private lastSentCollaborationModeKind: "default" | "plan" | null = null;

  // Track Codex plan deltas and updates per turn (used by /plan).
  private planDeltaByTurnId = new Map<string, string>();
  private planUpdateCountByTurnId = new Map<string, number>();

  // Accumulate reasoning text by item ID so we can emit final thinking blocks.
  private reasoningTextByItemId = new Map<string, string>();

  // Track which item IDs we have already emitted a tool_use block for.
  // When Codex auto-approves (approvalPolicy "never"), it may skip item/started
  // and only send item/completed — we need to emit tool_use before tool_result.
  private emittedToolUseIds = new Set<string>();
  // Receiver subagent thread ID -> parent collab tool_use ID.
  private parentToolUseByThreadId = new Map<string, string>();

  // Queue messages received before initialization completes
  private pendingOutgoing: BrowserOutgoingMessage[] = [];
  /** Number of consecutive reconnect-retries for the current user message. */
  private reconnectRetryCount = 0;
  private static readonly MAX_RECONNECT_RETRIES = 2;

  // Pending approval requests (Codex sends these as JSON-RPC requests with an id)
  private pendingApprovals = new Map<string, number>(); // request_id -> JSON-RPC id

  // Track request types that need different response formats
  private pendingUserInputQuestionIds = new Map<string, string[]>(); // request_id -> ordered Codex question IDs
  private pendingReviewDecisions = new Set<string>(); // request_ids that need ReviewDecision format
  private pendingExitPlanModeRequests = new Set<string>(); // request_ids for ExitPlanMode approvals
  private pendingDynamicToolCalls = new Map<string, {
    jsonRpcId: number;
    callId: string;
    toolName: string;
    timeout: ReturnType<typeof setTimeout>;
  }>(); // request_id -> pending dynamic tool call metadata

  // Codex account rate limits (fetched after init, updated via notification)
  private _rateLimits: {
    primary: { usedPercent: number; windowDurationMins: number; resetsAt: number } | null;
    secondary: { usedPercent: number; windowDurationMins: number; resetsAt: number } | null;
  } | null = null;
  private static readonly DYNAMIC_TOOL_CALL_TIMEOUT_MS = 120_000;
  private protocolDriftSeen = new Set<string>();

  private getExecutionCwd(): string {
    return this.options.executionCwd || this.options.cwd || "";
  }

  /**
   * Create a CodexAdapter.
   * @param transportOrProc - Either a pre-built ICodexTransport or a Bun Subprocess
   *   (backward compat: when given a Subprocess, a StdioTransport is built from its pipes).
   */
  constructor(transportOrProc: ICodexTransport | Subprocess, sessionId: string, options: CodexAdapterOptions = {}) {
    this.sessionId = sessionId;
    this.options = options;
    this.currentPermissionMode = options.approvalMode || "default";
    this.lastNonPlanPermissionMode = this.currentPermissionMode === "plan"
      ? "acceptEdits"
      : this.currentPermissionMode;
    this.currentCollaborationModeKind = this.currentPermissionMode === "plan"
      ? "plan"
      : "default";

    // Determine whether we received a transport or a subprocess
    if (this.isTransport(transportOrProc)) {
      // Pre-built transport (e.g. WebSocketTransport)
      this.transport = transportOrProc;
    } else {
      // Subprocess — build StdioTransport from its pipes (legacy path)
      const proc = transportOrProc;
      const stdout = proc.stdout;
      const stdin = proc.stdin;
      if (!stdout || !stdin || typeof stdout === "number" || typeof stdin === "number") {
        throw new Error("Codex process must have stdio pipes");
      }

      this.transport = new StdioTransport(
        stdin as WritableStream<Uint8Array> | { write(data: Uint8Array): number },
        stdout as ReadableStream<Uint8Array>,
        this.sessionId,
      );

      // Monitor process exit — when using a subprocess directly,
      // set up the exit handler here. For transport-only mode,
      // the caller provides killProcess and the transport's own
      // close handling triggers disconnectCb.
      if (!options.killProcess) {
        options.killProcess = async () => {
          try {
            proc.kill("SIGTERM");
            await Promise.race([
              proc.exited,
              new Promise((r) => setTimeout(r, 5000)),
            ]);
          } catch {}
        };
      }

      proc.exited.then(() => {
        this.connected = false;
        for (const pending of this.pendingDynamicToolCalls.values()) {
          clearTimeout(pending.timeout);
        }
        this.pendingDynamicToolCalls.clear();
        this.pendingExitPlanModeRequests.clear();
        this.disconnectCb?.();
      });
    }

    this.transport.onNotification((method, params) => this.handleNotification(method, params));
    this.transport.onRequest((method, id, params) => this.handleRequest(method, id, params));

    // Wire raw message recording if a recorder is provided
    if (options.recorder) {
      const recorder = options.recorder;
      const cwd = options.cwd || "";
      this.transport.onRawIncoming((line) => {
        recorder.record(sessionId, "in", line, "cli", "codex", cwd);
      });
      this.transport.onRawOutgoing((data) => {
        recorder.record(sessionId, "out", data.trimEnd(), "cli", "codex", cwd);
      });
    }

    // Surface transport-level parse errors to the browser
    this.transport.onParseError((message) => {
      this.browserMessageCb?.({ type: "error", message });
    });

    // Start initialization
    this.initialize();
  }

  /** Type guard: is the argument an ICodexTransport (vs a Subprocess)? */
  private isTransport(obj: ICodexTransport | Subprocess): obj is ICodexTransport {
    return typeof (obj as ICodexTransport).call === "function"
      && typeof (obj as ICodexTransport).notify === "function"
      && typeof (obj as ICodexTransport).respond === "function"
      && typeof (obj as ICodexTransport).onNotification === "function";
  }

  /**
   * Notify the adapter that the underlying transport has closed.
   * Used by WebSocket transport mode — the launcher wires the WS close
   * event to this method so the adapter can clean up and fire disconnectCb.
   */
  handleTransportClose(): void {
    this.cleanupAndDisconnect();
  }

  /**
   * Handle a WebSocket proxy reconnection event.  The proxy reconnected
   * to the Codex app-server after a transient drop (e.g. outbound queue
   * overflow on the Codex side).  Pending RPC calls were already rejected
   * by the StdioTransport, but we need to:
   *  1. Cancel any pending dynamic tool call timers
   *  2. Cancel pending permissions (they're stale after reconnect)
   *  3. Re-initialize the thread so we can accept new messages
   */
  private handleWsReconnected(): void {
    console.log(`[codex-adapter] Session ${this.sessionId}: WS proxy reconnected to Codex`);

    // Clean up pending dynamic tool calls (timers would fire stale errors)
    for (const pending of this.pendingDynamicToolCalls.values()) {
      clearTimeout(pending.timeout);
    }
    this.pendingDynamicToolCalls.clear();
    this.pendingExitPlanModeRequests.clear();
    // Emit permission_cancelled for each stale approval so the browser
    // can dismiss its permission dialog (the bridge also clears its own
    // pendingPermissions map when it sees these messages).
    for (const [requestId] of this.pendingApprovals) {
      this.emit({ type: "permission_cancelled", request_id: requestId });
    }
    this.pendingApprovals.clear();
    this.pendingUserInputQuestionIds.clear();
    this.pendingReviewDecisions.clear();

    // Clear the current turn — it's gone after reconnect
    this.currentTurnId = null;
    // Reset so the next turn/start re-sends collaborationMode (the server
    // sees a fresh connection and won't have the previously-set mode).
    this.lastSentCollaborationModeKind = null;
    // NOTE: Do NOT reset reconnectRetryCount here. The rejection microtask
    // from StdioTransport.dispatch() hasn't fired yet — resetting the counter
    // would defeat the MAX_RECONNECT_RETRIES guard. The counter is reset on
    // successful turn/start instead.
    // Clear pending outgoing messages to prevent duplicate sends — each
    // reconnect cycle would otherwise accumulate another copy of the message.
    this.pendingOutgoing.length = 0;

    // If initialization was in progress or had previously failed, re-attempt.
    // A WS reconnect means the transport is healthy again — a prior transient
    // failure should not permanently block the session.
    if (this.initInProgress || this.initFailed) {
      this.initInProgress = false;
      this.initialized = false;
      this.initFailed = false;
      this.initialize();
    }
  }

  /**
   * Clear pending timers, mark disconnected, and fire the disconnect callback.
   * Shared by handleTransportClose, RPC timeout paths, and process exit handlers.
   */
  private cleanupAndDisconnect(): void {
    this.connected = false;
    for (const pending of this.pendingDynamicToolCalls.values()) {
      clearTimeout(pending.timeout);
    }
    this.pendingDynamicToolCalls.clear();
    this.pendingExitPlanModeRequests.clear();
    this.disconnectCb?.();
  }

  /**
   * Reset the adapter so it can re-initialize after a transport reconnection.
   * Called by the launcher when a new proxy/transport is established for the
   * same session (e.g. after relaunch).  The threadId is preserved so the
   * adapter can resume the existing Codex thread.
   */
  resetForReconnect(newTransport: ICodexTransport): void {
    this.transport = newTransport;
    this.connected = false;
    this.initialized = false;
    this.initFailed = false;
    this.initInProgress = false;

    // Re-wire handlers on the new transport
    this.transport.onNotification((method, params) => this.handleNotification(method, params));
    this.transport.onRequest((method, id, params) => this.handleRequest(method, id, params));

    // Re-wire raw recording if recorder was provided
    if (this.options.recorder) {
      const recorder = this.options.recorder;
      const cwd = this.options.cwd || "";
      this.transport.onRawIncoming((line) => {
        recorder.record(this.sessionId, "in", line, "cli", "codex", cwd);
      });
      this.transport.onRawOutgoing((data) => {
        recorder.record(this.sessionId, "out", data.trimEnd(), "cli", "codex", cwd);
      });
    }

    // Re-wire parse error surfacing
    this.transport.onParseError((message) => {
      this.browserMessageCb?.({ type: "error", message });
    });

    // Re-run initialization (which will resume the thread if threadId is set)
    this.initialize();
  }

  // ── Public API ──────────────────────────────────────────────────────────

  getRateLimits() {
    return this._rateLimits;
  }

  /** IBackendAdapter.send() — unified entry point for browser-originated messages. */
  send(msg: BrowserOutgoingMessage): boolean {
    return this.sendBrowserMessage(msg);
  }

  /** @deprecated Use send() instead. Kept for backward compatibility during migration. */
  sendBrowserMessage(msg: BrowserOutgoingMessage): boolean {
    // If initialization failed, reject all new messages
    if (this.initFailed) {
      return false;
    }

    // Queue messages if not yet initialized (init is async)
    if (!this.initialized || !this.threadId || this.initInProgress) {
      if (
        msg.type === "user_message"
        || msg.type === "permission_response"
        || msg.type === "mcp_get_status"
        || msg.type === "mcp_toggle"
        || msg.type === "mcp_reconnect"
        || msg.type === "mcp_set_servers"
      ) {
        console.log(`[codex-adapter] Queuing ${msg.type} — adapter not yet initialized`);
        this.pendingOutgoing.push(msg);
        return true; // accepted, will be sent after init
      }
      // Non-queueable messages are dropped if not connected
      if (!this.connected) return false;
    }

    // Guard against dispatching when transport is down (e.g. after proxy WS drop)
    if (!this.transport.isConnected()) {
      console.warn(`[codex-adapter] Transport disconnected — cannot dispatch ${msg.type}`);
      return false;
    }

    // Drain any messages that were queued during init but not yet flushed
    // (e.g. if the post-init flush found the transport temporarily unavailable
    // but it recovered by the time the next message arrives).
    this.flushPendingOutgoing();

    return this.dispatchOutgoing(msg);
  }

  /**
   * Drain any messages still sitting in the pendingOutgoing queue.
   * Called both at the end of initialize() and as a safety net in
   * sendBrowserMessage() — the latter covers edge cases where the
   * post-init flush was skipped (e.g. transport was momentarily
   * unavailable right after init completed in a Docker container).
   */
  private flushPendingOutgoing(): void {
    if (this.pendingOutgoing.length === 0) return;
    if (!this.transport.isConnected()) {
      console.warn(
        `[codex-adapter] Session ${this.sessionId}: transport disconnected — keeping ${this.pendingOutgoing.length} message(s) queued`,
      );
      return;
    }
    console.log(
      `[codex-adapter] Session ${this.sessionId}: flushing ${this.pendingOutgoing.length} queued message(s)`,
    );
    const queued = this.pendingOutgoing.splice(0);
    for (const msg of queued) {
      this.dispatchOutgoing(msg);
    }
  }

  private dispatchOutgoing(msg: BrowserOutgoingMessage): boolean {
    switch (msg.type) {
      case "user_message":
        this.handleOutgoingUserMessage(msg);
        return true;
      case "permission_response":
        this.handleOutgoingPermissionResponse(msg);
        return true;
      case "interrupt":
        this.handleOutgoingInterrupt();
        return true;
      case "set_model":
        console.warn("[codex-adapter] Runtime model switching not supported by Codex");
        return false;
      case "set_permission_mode":
        this.handleOutgoingSetPermissionMode(msg.mode);
        return true;
      case "mcp_get_status":
        this.handleOutgoingMcpGetStatus();
        return true;
      case "mcp_toggle":
        this.handleOutgoingMcpToggle(msg.serverName, msg.enabled);
        return true;
      case "mcp_reconnect":
        this.handleOutgoingMcpReconnect();
        return true;
      case "mcp_set_servers":
        this.handleOutgoingMcpSetServers(msg.servers);
        return true;
      default:
        return false;
    }
  }

  onBrowserMessage(cb: (msg: BrowserIncomingMessage) => void): void {
    this.browserMessageCb = cb;
  }

  onSessionMeta(cb: (meta: { cliSessionId?: string; model?: string; cwd?: string }) => void): void {
    this.sessionMetaCb = cb;
  }

  onDisconnect(cb: () => void): void {
    this.disconnectCb = cb;
  }

  onInitError(cb: (error: string) => void): void {
    this.initErrorCb = cb;
  }

  isConnected(): boolean {
    return this.connected;
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    if (this.options.killProcess) {
      try {
        await this.options.killProcess();
      } catch {}
    }
  }

  getThreadId(): string | null {
    return this.threadId;
  }

  // ── Initialization ──────────────────────────────────────────────────────

  /** Max retries for thread/start or thread/resume during initialization. */
  private static readonly INIT_THREAD_MAX_RETRIES = 3;
  private static readonly INIT_THREAD_RETRY_BASE_MS = 500;

  private async initialize(): Promise<void> {
    if (this.initInProgress) {
      console.warn("[codex-adapter] initialize() called while already in progress — skipping");
      return;
    }
    this.initInProgress = true;

    try {
      // Step 1: Send initialize request
      const result = await this.transport.call("initialize", {
        clientInfo: {
          name: "thecompanion",
          title: "The Companion",
          version: "1.0.0",
        },
        capabilities: {
          experimentalApi: true,
        },
      }) as Record<string, unknown>;

      // Step 2: Send initialized notification
      await this.transport.notify("initialized", {});

      this.connected = true;

      // Step 3: Start or resume a thread — retry with backoff on transient
      // transport errors (e.g. proxy WS drops during handshake).
      // Note: thread/start and thread/resume use `sandbox` (SandboxMode string),
      // while turn/start uses `sandboxPolicy` (SandboxPolicy object) — these are
      // different Codex API fields by design.
      let threadStarted = false;
      let lastThreadError: unknown;

      for (let attempt = 0; attempt < CodexAdapter.INIT_THREAD_MAX_RETRIES; attempt++) {
        // Bail out early if the transport went away between retries
        if (!this.transport.isConnected()) {
          lastThreadError = new Error("Transport closed before thread start");
          break;
        }

        try {
          if (this.options.threadId) {
            try {
              const resumeResult = await this.transport.call("thread/resume", {
                threadId: this.options.threadId,
                model: this.options.model,
                cwd: this.getExecutionCwd(),
                approvalPolicy: this.mapApprovalPolicy(this.currentPermissionMode),
                sandbox: this.options.sandbox || this.mapSandboxPolicy(this.currentPermissionMode),
              }) as { thread: { id: string } };
              this.threadId = resumeResult.thread.id;
            } catch (resumeErr) {
              // If resume fails with a non-transient error (e.g. "no rollout found"),
              // fall back to starting a fresh thread instead of failing entirely.
              const isTransport = resumeErr instanceof Error && resumeErr.message === "Transport closed";
              if (isTransport) throw resumeErr; // Let outer retry handle transient errors
              console.warn(
                `[codex-adapter] thread/resume failed for ${this.sessionId} (threadId=${this.options.threadId}), falling back to thread/start: ${resumeErr instanceof Error ? resumeErr.message : String(resumeErr)}`,
              );
              const freshResult = await this.transport.call("thread/start", {
                model: this.options.model,
                cwd: this.getExecutionCwd(),
                approvalPolicy: this.mapApprovalPolicy(this.currentPermissionMode),
                sandbox: this.options.sandbox || this.mapSandboxPolicy(this.currentPermissionMode),
                ...(this.options.systemPrompt ? { instructions: this.options.systemPrompt } : {}),
              }) as { thread: { id: string } };
              this.threadId = freshResult.thread.id;
              // Update options.threadId so subsequent resetForReconnect calls
              // attempt to resume this new thread, not the original stale one.
              this.options.threadId = freshResult.thread.id;
            }
          } else {
            const threadResult = await this.transport.call("thread/start", {
              model: this.options.model,
              cwd: this.getExecutionCwd(),
              approvalPolicy: this.mapApprovalPolicy(this.currentPermissionMode),
              sandbox: this.options.sandbox || this.mapSandboxPolicy(this.currentPermissionMode),
              ...(this.options.systemPrompt ? { instructions: this.options.systemPrompt } : {}),
            }) as { thread: { id: string } };
            this.threadId = threadResult.thread.id;
          }
          threadStarted = true;
          break;
        } catch (threadErr) {
          lastThreadError = threadErr;
          const isTransportClosed = threadErr instanceof Error && threadErr.message === "Transport closed";
          if (!isTransportClosed || attempt >= CodexAdapter.INIT_THREAD_MAX_RETRIES - 1) {
            break; // Non-transient error or last attempt — give up
          }
          const delay = CodexAdapter.INIT_THREAD_RETRY_BASE_MS * Math.pow(2, attempt);
          console.warn(`[codex-adapter] thread start attempt ${attempt + 1} failed (Transport closed), retrying in ${delay}ms`);
          await new Promise((r) => setTimeout(r, delay));
        }
      }

      if (!threadStarted) {
        throw lastThreadError || new Error("Failed to start thread");
      }

      this.initialized = true;
      console.log(`[codex-adapter] Session ${this.sessionId} initialized (threadId=${this.threadId})`);

      // Notify session metadata
      this.sessionMetaCb?.({
        cliSessionId: this.threadId ?? undefined,
        model: this.options.model,
        cwd: this.options.cwd,
      });

      // Send session_init to browser
      const state: SessionState = {
        session_id: this.sessionId,
        backend_type: "codex",
        model: this.options.model || "",
        cwd: this.options.cwd || "",
        tools: [],
        permissionMode: this.currentPermissionMode,
        claude_code_version: "",
        mcp_servers: [],
        agents: [],
        slash_commands: [],
        skills: [],
        total_cost_usd: 0,
        num_turns: 0,
        context_used_percent: 0,
        is_compacting: false,
        git_branch: "",
        is_worktree: false,
        is_containerized: false,
        repo_root: "",
        git_ahead: 0,
        git_behind: 0,
        total_lines_added: 0,
        total_lines_removed: 0,
      };

      this.emit({ type: "session_init", session: state });

      // Fetch initial rate limits (non-blocking — don't fail init if this errors)
      this.transport.call("account/rateLimits/read", {}).then((result) => {
        this.updateRateLimits(result as Record<string, unknown>);
      }).catch(() => { /* best-effort */ });

      // Flush any messages that were queued during initialization, but only
      // if the transport is still connected (avoids immediate "Transport closed").
      this.flushPendingOutgoing();
      this.initInProgress = false;
    } catch (err) {
      // If a WS reconnection was detected mid-init, handleWsReconnected
      // already kicked off a fresh initialize(). Don't reset initInProgress
      // here — that would clobber the new initialize() call's flag.
      if (err instanceof Error && err.message === "Transport reconnected") {
        console.warn(`[codex-adapter] Session ${this.sessionId}: init interrupted by WS reconnection, re-init in progress`);
        return;
      }
      this.initInProgress = false;
      const errorMsg = `Codex initialization failed: ${err}`;
      console.error(`[codex-adapter] ${errorMsg}`);
      this.initFailed = true;
      this.connected = false;
      // Discard any messages queued during the failed init attempt
      this.pendingOutgoing.length = 0;
      this.emit({ type: "error", message: errorMsg });
      this.initErrorCb?.(errorMsg);
    }
  }

  // ── Outgoing message handlers ───────────────────────────────────────────

  private async handleOutgoingUserMessage(
    msg: { type: "user_message"; content: string; images?: { media_type: string; data: string }[] },
  ): Promise<void> {
    if (!this.threadId) {
      this.emit({ type: "error", message: "No Codex thread started yet" });
      return;
    }

    const input: Array<{ type: string; text?: string; url?: string }> = [];

    // Add images if present
    if (msg.images?.length) {
      for (const img of msg.images) {
        input.push({
          type: "image",
          url: `data:${img.media_type};base64,${img.data}`,
        });
      }
    }

    // Add text
    input.push({ type: "text", text: msg.content });

    try {
      // Only send collaborationMode on mode transitions — sending it every turn
      // in "default" mode overrides approvalPolicy and re-enables permission prompts.
      // The server persists collaborationMode across turns, so we only need to send
      // it when switching (e.g. auto→plan or plan→auto).
      // approvalPolicy and sandboxPolicy are static ("never" / dangerFullAccess) so
      // resending them each turn is idempotent and ensures consistency if the server
      // resets state. collaborationMode is only sent on transitions (see below).
      const turnParams: Record<string, unknown> = {
        threadId: this.threadId,
        input,
        cwd: this.getExecutionCwd(),
        approvalPolicy: this.mapApprovalPolicy(this.currentPermissionMode),
        sandboxPolicy: this.mapSandboxPolicyObject(this.currentPermissionMode),
      };
      if (this.currentCollaborationModeKind !== this.lastSentCollaborationModeKind) {
        turnParams.collaborationMode = this.mapCollaborationMode(this.currentCollaborationModeKind);
        this.lastSentCollaborationModeKind = this.currentCollaborationModeKind;
      }
      const result = await this.transport.call("turn/start", turnParams) as { turn: { id: string } };

      this.currentTurnId = result.turn.id;
      this.reconnectRetryCount = 0; // Reset on success
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      if (errMsg === "Transport reconnected") {
        // The WS proxy reconnected mid-call — this is transient.
        // Retry up to MAX_RECONNECT_RETRIES times before giving up to
        // avoid an unbounded loop when the WS keeps dropping.
        this.reconnectRetryCount++;
        if (this.reconnectRetryCount > CodexAdapter.MAX_RECONNECT_RETRIES) {
          this.reconnectRetryCount = 0;
          this.emit({ type: "error", message: "Connection lost after multiple reconnects. Relaunching session..." });
          this.cleanupAndDisconnect();
        } else {
          this.emit({ type: "error", message: "Connection briefly interrupted. Retrying your message..." });
          this.pendingOutgoing.push(msg);
          this.flushPendingOutgoing();
        }
      } else if (errMsg.startsWith("RPC timeout")) {
        this.emit({ type: "error", message: "Codex is not responding. Relaunching session..." });
        this.cleanupAndDisconnect();
      } else if (errMsg === "Transport closed") {
        this.emit({ type: "error", message: "Connection to Codex lost. Relaunching session..." });
        this.cleanupAndDisconnect();
      } else {
        this.emit({ type: "error", message: `Failed to start turn: ${err}` });
      }
    }
  }

  private async handleOutgoingPermissionResponse(
    msg: { type: "permission_response"; request_id: string; behavior: "allow" | "deny"; updated_input?: Record<string, unknown> },
  ): Promise<void> {
    const jsonRpcId = this.pendingApprovals.get(msg.request_id);
    if (jsonRpcId === undefined) {
      console.warn(`[codex-adapter] No pending approval for request_id=${msg.request_id}`);
      return;
    }

    // Dynamic tool calls (item/tool/call) require a DynamicToolCallResponse payload.
    const pendingDynamic = this.pendingDynamicToolCalls.get(msg.request_id);
    if (pendingDynamic) {
      this.pendingDynamicToolCalls.delete(msg.request_id);
      this.pendingApprovals.delete(msg.request_id);
      clearTimeout(pendingDynamic.timeout);

      const result = this.buildDynamicToolCallResponse(msg, pendingDynamic.toolName);
      await this.transport.respond(jsonRpcId, result);
      return;
    }

    // ExitPlanMode requests need DynamicToolCallResponse + collaboration mode update
    if (this.pendingExitPlanModeRequests.has(msg.request_id)) {
      this.pendingExitPlanModeRequests.delete(msg.request_id);
      this.pendingApprovals.delete(msg.request_id);

      if (msg.behavior === "allow") {
        // Exit plan mode: switch collaboration mode back to default
        this.currentCollaborationModeKind = "default";
        this.currentPermissionMode = this.lastNonPlanPermissionMode;
        this.emit({
          type: "session_update",
          session: { permissionMode: this.currentPermissionMode },
        });

        await this.transport.respond(jsonRpcId, {
          contentItems: [{ type: "inputText", text: "Plan approved. Exiting plan mode." }],
          success: true,
        });
      } else {
        await this.transport.respond(jsonRpcId, {
          contentItems: [{ type: "inputText", text: "Plan denied by user." }],
          success: false,
        });
      }
      return;
    }

    this.pendingApprovals.delete(msg.request_id);

    // User input requests (item/tool/requestUserInput) need ToolRequestUserInputResponse
    const questionIds = this.pendingUserInputQuestionIds.get(msg.request_id);
    if (questionIds) {
      this.pendingUserInputQuestionIds.delete(msg.request_id);

      if (msg.behavior === "deny") {
        // Respond with empty answers on deny
        await this.transport.respond(jsonRpcId, { answers: {} });
        return;
      }

      // Convert browser answers (keyed by index "0","1",...) to Codex format (keyed by question ID)
      const browserAnswers = msg.updated_input?.answers as Record<string, string> || {};
      const codexAnswers: Record<string, { answers: string[] }> = {};
      for (let i = 0; i < questionIds.length; i++) {
        const answer = browserAnswers[String(i)];
        if (answer !== undefined) {
          codexAnswers[questionIds[i]] = { answers: [answer] };
        }
      }

      await this.transport.respond(jsonRpcId, { answers: codexAnswers });
      return;
    }

    // Review decisions (applyPatchApproval / execCommandApproval) need ReviewDecision
    if (this.pendingReviewDecisions.has(msg.request_id)) {
      this.pendingReviewDecisions.delete(msg.request_id);
      const decision = msg.behavior === "allow" ? "approved" : "denied";
      await this.transport.respond(jsonRpcId, { decision });
      return;
    }

    // Standard item/*/requestApproval — uses accept/decline
    const decision = msg.behavior === "allow" ? "accept" : "decline";
    await this.transport.respond(jsonRpcId, { decision });
  }

  private async handleOutgoingInterrupt(): Promise<void> {
    if (!this.threadId || !this.currentTurnId) return;

    try {
      await this.transport.call("turn/interrupt", {
        threadId: this.threadId,
        turnId: this.currentTurnId,
      });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      if (errMsg.startsWith("RPC timeout")) {
        this.emit({ type: "error", message: "Codex is not responding to interrupt. Relaunching session..." });
        this.cleanupAndDisconnect();
      } else {
        console.warn("[codex-adapter] Interrupt failed:", err);
      }
    }
  }

  private handleOutgoingSetPermissionMode(mode: string): void {
    const nextMode = mode === "default"
      ? this.lastNonPlanPermissionMode
      : mode;

    this.currentPermissionMode = nextMode;
    if (nextMode === "plan") {
      this.currentCollaborationModeKind = "plan";
    } else {
      this.currentCollaborationModeKind = "default";
      this.lastNonPlanPermissionMode = nextMode;
    }

    this.emit({
      type: "session_update",
      session: { permissionMode: this.currentPermissionMode },
    });
  }

  private async handleOutgoingMcpGetStatus(): Promise<void> {
    try {
      const statusEntries = await this.listAllMcpServerStatuses();
      const configMap = await this.readMcpServersConfig();

      const names = new Set<string>([
        ...statusEntries.map((s) => s.name),
        ...Object.keys(configMap),
      ]);

      const statusByName = new Map(statusEntries.map((s) => [s.name, s]));
      const servers: McpServerDetail[] = Array.from(names).sort().map((name) => {
        const status = statusByName.get(name);
        const config = this.toMcpServerConfig(configMap[name]);
        const isEnabled = this.isMcpServerEnabled(configMap[name]);
        const serverStatus: McpServerDetail["status"] =
          !isEnabled
            ? "disabled"
            : (status?.authStatus === "notLoggedIn" ? "failed" : "connected");

        return {
          name,
          status: serverStatus,
          error: status?.authStatus === "notLoggedIn" ? "MCP server requires login" : undefined,
          config,
          scope: "user",
          tools: this.mapMcpTools(status?.tools),
        };
      });

      this.emit({ type: "mcp_status", servers });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      if (errMsg === "Transport closed") {
        this.emit({ type: "error", message: "Connection to Codex lost. Cannot fetch MCP status." });
      } else {
        this.emit({ type: "error", message: `Failed to get MCP status: ${err}` });
      }
    }
  }

  private async handleOutgoingMcpToggle(serverName: string, enabled: boolean): Promise<void> {
    try {
      if (serverName.includes(".")) {
        throw new Error("Server names containing '.' are not supported for toggle");
      }
      await this.transport.call("config/value/write", {
        keyPath: `mcp_servers.${serverName}.enabled`,
        value: enabled,
        mergeStrategy: "upsert",
      });
      await this.reloadMcpServers();
      await this.handleOutgoingMcpGetStatus();
    } catch (err) {
      // Some existing configs may contain legacy/foreign fields (e.g. `transport`)
      // that fail on reload when touched. If so, remove this server entry entirely.
      const msg = String(err);
      if (msg.includes("invalid transport")) {
        try {
          await this.transport.call("config/value/write", {
            keyPath: `mcp_servers.${serverName}`,
            value: null,
            mergeStrategy: "replace",
          });
          await this.reloadMcpServers();
          await this.handleOutgoingMcpGetStatus();
          return;
        } catch {
          // fall through to user-visible error below
        }
      }
      this.emit({ type: "error", message: `Failed to toggle MCP server "${serverName}": ${err}` });
    }
  }

  private async handleOutgoingMcpReconnect(): Promise<void> {
    try {
      await this.reloadMcpServers();
      await this.handleOutgoingMcpGetStatus();
    } catch (err) {
      this.emit({ type: "error", message: `Failed to reload MCP servers: ${err}` });
    }
  }

  private async handleOutgoingMcpSetServers(servers: Record<string, McpServerConfig>): Promise<void> {
    try {
      const edits: Array<{ keyPath: string; value: Record<string, unknown>; mergeStrategy: "upsert" }> = [];
      for (const [name, config] of Object.entries(servers)) {
        if (name.includes(".")) {
          throw new Error(`Server names containing '.' are not supported: ${name}`);
        }
        edits.push({
          keyPath: `mcp_servers.${name}`,
          value: this.fromMcpServerConfig(config),
          mergeStrategy: "upsert",
        });
      }
      if (edits.length > 0) {
        await this.transport.call("config/batchWrite", {
          edits,
        });
      }
      await this.reloadMcpServers();
      await this.handleOutgoingMcpGetStatus();
    } catch (err) {
      this.emit({ type: "error", message: `Failed to configure MCP servers: ${err}` });
    }
  }

  // ── Incoming notification handlers ──────────────────────────────────────

  private handleNotification(method: string, params: Record<string, unknown>): void {
    // Debug: log all significant notifications to understand Codex event flow
    if (method.startsWith("item/") || method.startsWith("turn/") || method.startsWith("thread/")) {
      const item = params.item as { type?: string; id?: string } | undefined;
      console.log(`[codex-adapter] ← ${method}${item ? ` type=${item.type} id=${item.id}` : ""}${!item && Object.keys(params).length > 0 ? ` keys=[${Object.keys(params).join(",")}]` : ""}`);
    }

    try {
    switch (method) {
      case "item/started":
        this.handleItemStarted(params);
        break;
      case "item/agentMessage/delta":
        this.handleAgentMessageDelta(params);
        break;
      case "item/commandExecution/outputDelta":
        // Streaming command output — emit as tool_progress so the browser
        // shows a live elapsed-time indicator while the command runs.
        this.emitCommandProgress(params);
        break;
      case "item/fileChange/outputDelta":
        // Streaming file change output. Same as above.
        break;
      case "item/reasoning/textDelta":
      case "item/reasoning/delta":
      case "item/reasoning/summaryTextDelta":
      case "item/reasoning/summaryPartAdded":
        this.handleReasoningDelta(params);
        break;
      case "item/mcpToolCall/progress": {
        // MCP tool call progress — map to tool_progress
        const itemId = params.itemId as string | undefined;
        const threadId = params.threadId as string | undefined;
        if (itemId) {
          this.emit({
            type: "tool_progress",
            tool_use_id: itemId,
            tool_name: "mcp_tool_call",
            elapsed_time_seconds: 0,
          });
        }
        break;
      }
      case "item/plan/delta":
        this.handlePlanDelta(params);
        break;
      case "item/updated":
        this.handleItemUpdated(params);
        break;
      case "item/completed":
        this.handleItemCompleted(params);
        break;
      case "rawResponseItem/completed":
        // Raw model response — internal, not needed for UI.
        break;
      case "turn/started":
        this.handleTurnStarted(params);
        break;
      case "turn/completed":
        this.handleTurnCompleted(params);
        break;
      case "turn/plan/updated":
        this.handleTurnPlanUpdated(params);
        break;
      case "turn/diff/updated":
        // Could show diff, but not needed for MVP
        break;
      case "thread/started":
        // Thread started after init — nothing to emit.
        break;
      case "thread/status/changed":
        this.handleThreadStatusChanged(params);
        break;
      case "thread/tokenUsage/updated":
        this.handleTokenUsageUpdated(params);
        break;
      case "account/updated":
      case "account/login/completed":
        // Auth events
        break;
      case "account/rateLimits/updated":
        this.updateRateLimits(params);
        break;
      case "codex/event/token_count":
        this.handleLegacyTokenCount(params);
        break;
      case "codex/event/agent_message_delta":
      case "codex/event/agent_message_content_delta": {
        const legacy = this.asRecord(params.msg);
        const delta = typeof legacy?.delta === "string" ? legacy.delta : "";
        if (!delta) break;
        const normalized: Record<string, unknown> = { delta };
        if (typeof legacy?.thread_id === "string") {
          normalized.threadId = legacy.thread_id;
        }
        this.handleAgentMessageDelta(normalized);
        break;
      }
      case "codex/event/reasoning_content_delta": {
        const legacy = this.asRecord(params.msg);
        const itemId = typeof legacy?.item_id === "string" ? legacy.item_id : null;
        const delta = typeof legacy?.delta === "string" ? legacy.delta : null;
        if (!itemId || !delta) break;
        this.handleReasoningDelta({ itemId, delta });
        break;
      }
      // Legacy codex/event/* notifications forwarded by newer Codex runtimes.
      // These are either duplicates of canonical v2 notifications we already
      // handle (item/*, turn/*, thread/*) or metadata not needed for the UI.
      case "codex/event/agent_message":
      case "codex/event/item_started":
      case "codex/event/item_completed":
      case "codex/event/exec_command_begin":
      case "codex/event/exec_command_output_delta":
      case "codex/event/exec_command_end":
      case "codex/event/turn_diff":
      case "codex/event/terminal_interaction":
      case "codex/event/patch_apply_begin":
      case "codex/event/patch_apply_end":
      case "codex/event/user_message":
      case "codex/event/task_started":
      case "codex/event/task_complete":
      case "codex/event/mcp_startup_complete":
      case "codex/event/context_compacted":
      case "codex/event/agent_reasoning":
      case "codex/event/agent_reasoning_delta":
      case "codex/event/agent_reasoning_section_break":
        break;
      case "codex/event/stream_error": {
        const msg = params.msg as { message?: string } | undefined;
        if (msg?.message) {
          console.log(`[codex-adapter] Stream error: ${msg.message}`);
        }
        break;
      }
      case "codex/event/error": {
        const msg = params.msg as { message?: string } | undefined;
        if (msg?.message) {
          console.error(`[codex-adapter] Codex error: ${msg.message}`);
          this.emit({ type: "error", message: msg.message });
        }
        break;
      }
      case "companion/wsReconnected":
        this.handleWsReconnected();
        break;
      default:
        this.reportProtocolDrift("notification", method, { payload: params });
        break;
    }
    } catch (err) {
      log.error("codex-adapter", `Error handling notification ${method}`, {
        sessionId: this.sessionId,
        method,
        error: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      });
      this.browserMessageCb?.({
        type: "error",
        message: `Codex notification handler crashed on "${method}". Companion may need an update.`,
      });
    }
  }

  // ── Incoming request handlers (approval requests) ───────────────────────

  private handleRequest(method: string, id: number, params: Record<string, unknown>): void {
    try {
      switch (method) {
        case "item/commandExecution/requestApproval":
          this.handleCommandApproval(id, params);
          break;
        case "item/fileChange/requestApproval":
          this.handleFileChangeApproval(id, params);
          break;
        case "item/mcpToolCall/requestApproval":
          this.handleMcpToolCallApproval(id, params);
          break;
        case "item/tool/call":
          if ((params as Record<string, unknown>).tool === "ExitPlanMode") {
            this.handleExitPlanModeRequest(id, params);
          } else {
            this.handleDynamicToolCall(id, params);
          }
          break;
        case "item/tool/requestUserInput":
          this.handleUserInputRequest(id, params);
          break;
        case "applyPatchApproval":
          this.handleApplyPatchApproval(id, params);
          break;
        case "execCommandApproval":
          this.handleExecCommandApproval(id, params);
          break;
        case "account/chatgptAuthTokens/refresh":
          console.warn("[codex-adapter] Auth token refresh not supported");
          this.transport.respond(id, { error: "not supported" });
          break;
        default:
          this.reportProtocolDrift("request", method, { payload: params, blockedForSafety: true });
          this.transport.respond(id, { error: `Unsupported Codex request method: ${method}` });
          break;
      }
    } catch (err) {
      log.error("codex-adapter", `Error handling request ${method}`, {
        sessionId: this.sessionId,
        method,
        error: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      });
      this.browserMessageCb?.({
        type: "error",
        message: `Codex request handler crashed on "${method}". Companion may need an update.`,
      });
    }
  }

  private handleTurnStarted(params: Record<string, unknown>): void {
    const turn = this.asRecord(params.turn);
    const collab = this.asRecord(turn?.collaborationMode);
    const fromObject = collab?.mode;
    const fromFlat = turn?.collaborationModeKind;
    const kind = fromObject === "plan" || fromObject === "default"
      ? fromObject
      : (fromFlat === "plan" || fromFlat === "default" ? fromFlat : null);

    if (!kind) return;
    this.currentCollaborationModeKind = kind;
    const nextMode = kind === "plan" ? "plan" : this.lastNonPlanPermissionMode;
    if (nextMode === this.currentPermissionMode) return;

    this.currentPermissionMode = nextMode;
    this.emit({
      type: "session_update",
      session: { permissionMode: this.currentPermissionMode },
    });
  }

  private handleCommandApproval(jsonRpcId: number, params: Record<string, unknown>): void {
    const requestId = `codex-approval-${randomUUID()}`;
    this.pendingApprovals.set(requestId, jsonRpcId);

    const command = params.command as string | string[] | undefined;
    const commandStr = params.parsedCmd as string || (Array.isArray(command) ? command.join(" ") : command) || "";

    const perm: PermissionRequest = {
      request_id: requestId,
      tool_name: "Bash",
      input: {
        command: commandStr,
        cwd: params.cwd as string || this.getExecutionCwd(),
      },
      description: params.reason as string || `Execute: ${commandStr}`,
      tool_use_id: params.itemId as string || requestId,
      timestamp: Date.now(),
    };

    this.emit({ type: "permission_request", request: perm });
  }

  private handleFileChangeApproval(jsonRpcId: number, params: Record<string, unknown>): void {
    const requestId = `codex-approval-${randomUUID()}`;
    this.pendingApprovals.set(requestId, jsonRpcId);

    // Extract file paths from changes array if available
    const changes = params.changes as Array<{ path?: string; kind?: string }> | undefined;
    const filePaths = changes?.map((c) => c.path).filter(Boolean) || [];
    const fileList = filePaths.length > 0 ? filePaths.join(", ") : undefined;

    const perm: PermissionRequest = {
      request_id: requestId,
      tool_name: "Edit",
      input: {
        description: params.reason as string || "File changes pending approval",
        ...(filePaths.length > 0 && { file_paths: filePaths }),
        ...(changes && { changes }),
      },
      description: params.reason as string || (fileList ? `Codex wants to modify: ${fileList}` : "Codex wants to modify files"),
      tool_use_id: params.itemId as string || requestId,
      timestamp: Date.now(),
    };

    this.emit({ type: "permission_request", request: perm });
  }

  private handleMcpToolCallApproval(jsonRpcId: number, params: Record<string, unknown>): void {
    const requestId = `codex-approval-${randomUUID()}`;
    this.pendingApprovals.set(requestId, jsonRpcId);

    const server = params.server as string || "unknown";
    const tool = params.tool as string || "unknown";
    const args = params.arguments as Record<string, unknown> || {};

    const perm: PermissionRequest = {
      request_id: requestId,
      tool_name: `mcp:${server}:${tool}`,
      input: args,
      description: params.reason as string || `MCP tool call: ${server}/${tool}`,
      tool_use_id: params.itemId as string || requestId,
      timestamp: Date.now(),
    };

    this.emit({ type: "permission_request", request: perm });
  }

  private handleDynamicToolCall(jsonRpcId: number, params: Record<string, unknown>): void {
    const callId = params.callId as string || `dynamic-${randomUUID()}`;
    const toolName = params.tool as string || "unknown_dynamic_tool";
    const toolArgs = params.arguments as Record<string, unknown> || {};
    const requestId = `codex-dynamic-${randomUUID()}`;

    console.log(`[codex-adapter] Dynamic tool call received: ${toolName} (callId=${callId})`);

    // Emit tool_use so the browser sees this custom tool invocation.
    this.emitToolUseTracked(callId, `dynamic:${toolName}`, toolArgs);

    this.pendingApprovals.set(requestId, jsonRpcId);
    const timeout = setTimeout(() => {
      this.resolveDynamicToolCallTimeout(requestId);
    }, CodexAdapter.DYNAMIC_TOOL_CALL_TIMEOUT_MS);

    this.pendingDynamicToolCalls.set(requestId, {
      jsonRpcId,
      callId,
      toolName,
      timeout,
    });

    const perm: PermissionRequest = {
      request_id: requestId,
      tool_name: `dynamic:${toolName}`,
      input: {
        ...toolArgs,
        call_id: callId,
      },
      description: `Custom tool call: ${toolName}`,
      tool_use_id: callId,
      timestamp: Date.now(),
    };

    this.emit({ type: "permission_request", request: perm });
  }

  private async resolveDynamicToolCallTimeout(requestId: string): Promise<void> {
    const pending = this.pendingDynamicToolCalls.get(requestId);
    if (!pending) return;

    this.pendingDynamicToolCalls.delete(requestId);
    this.pendingApprovals.delete(requestId);

    this.emitToolResult(
      pending.callId,
      `Dynamic tool "${pending.toolName}" timed out waiting for output.`,
      true,
    );

    try {
      await this.transport.respond(pending.jsonRpcId, {
        contentItems: [{ type: "inputText", text: `Timed out waiting for dynamic tool output: ${pending.toolName}` }],
        success: false,
      });
    } catch (err) {
      console.warn(`[codex-adapter] Failed to send dynamic tool timeout response: ${err}`);
    }
  }

  private buildDynamicToolCallResponse(
    msg: { behavior: "allow" | "deny"; updated_input?: Record<string, unknown> },
    toolName: string,
  ): { contentItems: unknown[]; success: boolean; structuredContent?: unknown } {
    if (msg.behavior === "deny") {
      return {
        contentItems: [{ type: "inputText", text: `Dynamic tool "${toolName}" was denied by user` }],
        success: false,
      };
    }

    const rawContentItems = msg.updated_input?.contentItems;
    const contentItems = Array.isArray(rawContentItems) && rawContentItems.length > 0
      ? rawContentItems
      : [{ type: "inputText", text: String(msg.updated_input?.text || "Dynamic tool call completed") }];

    const success = typeof msg.updated_input?.success === "boolean"
      ? msg.updated_input.success
      : true;

    const structuredContent = msg.updated_input?.structuredContent;

    return {
      contentItems,
      success,
      ...(structuredContent !== undefined ? { structuredContent } : {}),
    };
  }

  private handleUserInputRequest(jsonRpcId: number, params: Record<string, unknown>): void {
    const requestId = `codex-userinput-${randomUUID()}`;
    this.pendingApprovals.set(requestId, jsonRpcId);

    const questions = params.questions as Array<{
      id: string; header: string; question: string;
      isOther: boolean; isSecret: boolean;
      options: Array<{ label: string; description: string }> | null;
    }> || [];

    // Store question IDs so we can map browser indices back to Codex IDs in the response
    this.pendingUserInputQuestionIds.set(requestId, questions.map((q) => q.id));

    // Convert to our AskUserQuestion format (matches AskUserQuestionDisplay component)
    const perm: PermissionRequest = {
      request_id: requestId,
      tool_name: "AskUserQuestion",
      input: {
        questions: questions.map((q) => ({
          header: q.header,
          question: q.question,
          options: q.options?.map((o) => ({ label: o.label, description: o.description })) || [],
        })),
      },
      description: questions[0]?.question || "User input requested",
      tool_use_id: params.itemId as string || requestId,
      timestamp: Date.now(),
    };

    this.emit({ type: "permission_request", request: perm });
  }

  private handleExitPlanModeRequest(jsonRpcId: number, params: Record<string, unknown>): void {
    const callId = params.callId as string || `exitplan-${randomUUID()}`;
    const toolArgs = params.arguments as Record<string, unknown> || {};
    const requestId = `codex-exitplan-${randomUUID()}`;

    console.log(`[codex-adapter] ExitPlanMode request received (callId=${callId})`);

    this.pendingApprovals.set(requestId, jsonRpcId);
    this.pendingExitPlanModeRequests.add(requestId);

    // Emit tool_use with the bare "ExitPlanMode" name (no "dynamic:" prefix)
    this.emitToolUseTracked(callId, "ExitPlanMode", toolArgs);

    // Build permission request with the format ExitPlanModeDisplay expects
    const perm: PermissionRequest = {
      request_id: requestId,
      tool_name: "ExitPlanMode",
      input: {
        plan: typeof toolArgs.plan === "string" ? toolArgs.plan : "",
        allowedPrompts: Array.isArray(toolArgs.allowedPrompts) ? toolArgs.allowedPrompts : [],
      },
      description: "Plan approval requested",
      tool_use_id: callId,
      timestamp: Date.now(),
    };

    this.emit({ type: "permission_request", request: perm });
  }

  private handleApplyPatchApproval(jsonRpcId: number, params: Record<string, unknown>): void {
    const requestId = `codex-patch-${randomUUID()}`;
    this.pendingApprovals.set(requestId, jsonRpcId);
    this.pendingReviewDecisions.add(requestId);

    const fileChanges = params.fileChanges as Record<string, unknown> || {};
    const filePaths = Object.keys(fileChanges);
    const reason = params.reason as string | null;

    const perm: PermissionRequest = {
      request_id: requestId,
      tool_name: "Edit",
      input: {
        file_paths: filePaths,
        ...(reason && { reason }),
      },
      description: reason || (filePaths.length > 0
        ? `Codex wants to modify: ${filePaths.join(", ")}`
        : "Codex wants to modify files"),
      tool_use_id: params.callId as string || requestId,
      timestamp: Date.now(),
    };

    this.emit({ type: "permission_request", request: perm });
  }

  private handleExecCommandApproval(jsonRpcId: number, params: Record<string, unknown>): void {
    const requestId = `codex-exec-${randomUUID()}`;
    this.pendingApprovals.set(requestId, jsonRpcId);
    this.pendingReviewDecisions.add(requestId);

    const command = params.command as string[] || [];
    const commandStr = command.join(" ");
    const cwd = params.cwd as string || this.getExecutionCwd();
    const reason = params.reason as string | null;

    const perm: PermissionRequest = {
      request_id: requestId,
      tool_name: "Bash",
      input: {
        command: commandStr,
        cwd,
      },
      description: reason || `Execute: ${commandStr}`,
      tool_use_id: params.callId as string || requestId,
      timestamp: Date.now(),
    };

    this.emit({ type: "permission_request", request: perm });
  }

  // ── Item event handlers ─────────────────────────────────────────────────

  private handleItemStarted(params: Record<string, unknown>): void {
    const item = params.item as CodexItem;
    if (!item) return;
    const threadId = typeof params.threadId === "string" ? params.threadId : undefined;
    const parentToolUseId = this.getParentToolUseIdForThread(threadId);

    switch (item.type) {
      case "agentMessage":
        // Start streaming accumulation
        this.streamingItemId = item.id;
        this.streamingText = "";
        // Emit message_start stream event so the browser knows streaming began
        this.emit({
          type: "stream_event",
          event: {
            type: "message_start",
            message: {
              id: this.makeMessageId("agent", item.id),
              type: "message",
              role: "assistant",
              model: this.options.model || "",
              content: [],
              stop_reason: null,
              usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
            },
          },
          parent_tool_use_id: parentToolUseId,
        });
        // Also emit content_block_start
        this.emit({
          type: "stream_event",
          event: {
            type: "content_block_start",
            index: 0,
            content_block: { type: "text", text: "" },
          },
          parent_tool_use_id: parentToolUseId,
        });
        break;

      case "commandExecution": {
        const cmd = item as CodexCommandExecutionItem;
        const commandStr = Array.isArray(cmd.command) ? cmd.command.join(" ") : (cmd.command || "");
        this.commandStartTimes.set(item.id, Date.now());
        this.emitToolUseStart(item.id, "Bash", { command: commandStr });
        break;
      }

      case "fileChange": {
        const fc = item as CodexFileChangeItem;
        const changes = fc.changes || [];
        const firstChange = changes[0];
        const toolName = safeKind(firstChange?.kind) === "create" ? "Write" : "Edit";
        const toolInput = {
          file_path: firstChange?.path || "",
          changes: changes.map((c) => ({ path: c.path, kind: safeKind(c.kind) })),
        };
        this.emitToolUseStart(item.id, toolName, toolInput);
        break;
      }

      case "mcpToolCall": {
        const mcp = item as CodexMcpToolCallItem;
        this.emitToolUseStart(item.id, `mcp:${mcp.server}:${mcp.tool}`, mcp.arguments || {});
        break;
      }

      case "webSearch": {
        const ws = item as CodexWebSearchItem;
        this.emitToolUseStart(item.id, "WebSearch", { query: ws.query || "" });
        break;
      }

      case "reasoning": {
        const r = item as CodexReasoningItem;
        const initialThinking = this.coerceReasoningText(r.summary) || this.coerceReasoningText(r.content);
        this.reasoningTextByItemId.set(item.id, initialThinking);
        // Emit as thinking content block
        if (initialThinking) {
          this.emit({
            type: "stream_event",
            event: {
              type: "content_block_start",
              index: 0,
              content_block: { type: "thinking", thinking: initialThinking },
            },
            parent_tool_use_id: null,
          });
        }
        break;
      }

      case "contextCompaction":
        this.emit({ type: "status_change", status: "compacting" });
        break;

      case "collabAgentToolCall": {
        const collab = item as CodexCollabAgentToolCallItem;
        const receiverThreadIds = Array.isArray(collab.receiverThreadIds)
          ? collab.receiverThreadIds.filter((id): id is string => typeof id === "string" && id.length > 0)
          : [];
        const prompt = typeof collab.prompt === "string" ? collab.prompt.trim() : "";
        const description = prompt
          || `${collab.tool || "agent"} (${receiverThreadIds.length || 1} agent${(receiverThreadIds.length || 1) === 1 ? "" : "s"})`;
        this.emitToolUseStart(item.id, "Task", {
          description,
          subagent_type: collab.tool || "codex-collab",
          codex_status: collab.status,
          sender_thread_id: collab.senderThreadId || null,
          receiver_thread_ids: receiverThreadIds,
        }, parentToolUseId);
        this.setSubagentThreadMappings(item.id, collab);
        this.emitAssistantText(
          `Started ${collab.tool || "collab"} for ${receiverThreadIds.length || 1} agent${(receiverThreadIds.length || 1) === 1 ? "" : "s"}.`,
          item.id,
        );
        break;
      }

      default:
        // userMessage is an echo of browser input and not needed in UI.
        if (item.type !== "userMessage") {
          console.log(`[codex-adapter] Unhandled item/started type: ${item.type}`, JSON.stringify(item).substring(0, 300));
        }
        break;
    }
  }

  private handleReasoningDelta(params: Record<string, unknown>): void {
    const itemId = params.itemId as string | undefined;
    if (!itemId) return;

    if (!this.reasoningTextByItemId.has(itemId)) {
      this.reasoningTextByItemId.set(itemId, "");
    }

    const delta = params.delta as string | undefined;
    if (delta) {
      const current = this.reasoningTextByItemId.get(itemId) || "";
      this.reasoningTextByItemId.set(itemId, current + delta);
    }
  }

  private handlePlanDelta(params: Record<string, unknown>): void {
    const turnId = typeof params.turnId === "string" ? params.turnId : null;
    const delta = typeof params.delta === "string" ? params.delta : null;
    if (!turnId || !delta) return;
    const current = this.planDeltaByTurnId.get(turnId) || "";
    this.planDeltaByTurnId.set(turnId, current + delta);
  }

  private handleTurnPlanUpdated(params: Record<string, unknown>): void {
    const turnObj = params.turn as Record<string, unknown> | undefined;
    const turnId = typeof params.turnId === "string"
      ? params.turnId
      : (typeof turnObj?.id === "string" ? turnObj.id : this.currentTurnId);
    if (!turnId) return;

    const todos = this.extractPlanTodos(params, turnId);
    if (todos.length === 0) return;

    const nextCount = (this.planUpdateCountByTurnId.get(turnId) || 0) + 1;
    this.planUpdateCountByTurnId.set(turnId, nextCount);
    const toolUseId = `codex-plan-${turnId}-${nextCount}`;

    this.emitToolUseTracked(toolUseId, "TodoWrite", { todos });
  }

  private handleThreadStatusChanged(params: Record<string, unknown>): void {
    const raw = params.status;
    const statusRaw = typeof raw === "string"
      ? raw
      : (raw && typeof raw === "object" && typeof (raw as Record<string, unknown>).type === "string")
        ? ((raw as Record<string, unknown>).type as string)
        : null;
    const status = statusRaw === "running" || statusRaw === "compacting"
      ? statusRaw
      : null;
    this.emit({ type: "status_change", status });
  }

  private extractPlanTodos(params: Record<string, unknown>, turnId: string): PlanTodo[] {
    const directPlan = params.plan;
    const turnObj = params.turn as Record<string, unknown> | undefined;
    const nestedPlan = turnObj?.plan;

    const fromPlanObject = this.extractPlanTodosFromUnknown(
      directPlan !== undefined ? directPlan : nestedPlan,
    );
    if (fromPlanObject.length > 0) {
      return fromPlanObject;
    }

    const fallbackDelta = this.planDeltaByTurnId.get(turnId);
    if (!fallbackDelta) return [];
    return this.extractPlanTodosFromMarkdown(fallbackDelta);
  }

  private extractPlanTodosFromUnknown(input: unknown): PlanTodo[] {
    if (typeof input === "string") {
      return this.extractPlanTodosFromMarkdown(input);
    }

    if (!input || typeof input !== "object") {
      return [];
    }

    const obj = input as Record<string, unknown>;
    const stepArrayCandidates = [
      obj.steps,
      obj.items,
      obj.planSteps,
      (obj.plan as Record<string, unknown> | undefined)?.steps,
      (obj.plan as Record<string, unknown> | undefined)?.items,
    ];

    for (const candidate of stepArrayCandidates) {
      if (!Array.isArray(candidate)) continue;
      const todos: PlanTodo[] = [];
      for (const step of candidate) {
        if (typeof step === "string") {
          const trimmed = step.trim();
          if (trimmed) todos.push({ content: trimmed, status: "pending" });
          continue;
        }
        if (!step || typeof step !== "object") continue;
        const stepObj = step as Record<string, unknown>;
        const content = this.firstString(stepObj, ["content", "text", "title", "description", "step", "name"]);
        if (!content) continue;
        const status = this.normalizePlanStatus(this.firstString(stepObj, ["status", "state", "phase"]));
        const activeForm = this.firstString(stepObj, ["activeForm", "active_form", "inProgressText", "in_progress_text"]);
        todos.push({
          content,
          status,
          ...(activeForm ? { activeForm } : {}),
        });
      }
      if (todos.length > 0) return todos;
    }

    const markdown = this.firstString(obj, ["markdown", "text", "content"]);
    if (markdown) {
      return this.extractPlanTodosFromMarkdown(markdown);
    }

    return [];
  }

  private extractPlanTodosFromMarkdown(markdown: string): PlanTodo[] {
    const todos: PlanTodo[] = [];
    for (const rawLine of markdown.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line) continue;

      let match = line.match(/^[-*]\s+\[(x|X|~|>| )\]\s+(.+)$/);
      if (match) {
        const marker = match[1].toLowerCase();
        const status = marker === "x" ? "completed"
          : (marker === "~" || marker === ">") ? "in_progress"
          : "pending";
        todos.push({ content: match[2].trim(), status });
        continue;
      }

      match = line.match(/^[-*]\s+(.+)$/);
      if (match) {
        todos.push({ content: match[1].trim(), status: "pending" });
        continue;
      }

      match = line.match(/^\d+\.\s+(.+)$/);
      if (match) {
        todos.push({ content: match[1].trim(), status: "pending" });
      }
    }
    return todos;
  }

  private firstString(obj: Record<string, unknown>, keys: string[]): string | null {
    for (const key of keys) {
      const value = obj[key];
      if (typeof value === "string" && value.trim()) {
        return value.trim();
      }
    }
    return null;
  }

  private coerceReasoningText(value: unknown): string {
    if (typeof value === "string") return value;
    if (Array.isArray(value)) {
      return value
        .map((entry) => this.coerceReasoningText(entry))
        .filter(Boolean)
        .join("\n");
    }
    if (value && typeof value === "object") {
      const obj = value as Record<string, unknown>;
      return this.firstString(obj, ["text", "content", "summary"]) || "";
    }
    return "";
  }

  private normalizePlanStatus(statusRaw: string | null): "pending" | "in_progress" | "completed" {
    const status = (statusRaw || "").toLowerCase();
    if (
      status === "completed"
      || status === "done"
      || status === "complete"
      || status === "success"
      || status === "succeeded"
    ) {
      return "completed";
    }
    if (
      status === "in_progress"
      || status === "inprogress"
      || status === "active"
      || status === "running"
      || status === "current"
    ) {
      return "in_progress";
    }
    return "pending";
  }

  private handleAgentMessageDelta(params: Record<string, unknown>): void {
    const delta = params.delta as string;
    if (!delta) return;
    const threadId = typeof params.threadId === "string" ? params.threadId : undefined;
    const parentToolUseId = this.getParentToolUseIdForThread(threadId);

    this.streamingText += delta;

    // Emit as content_block_delta (matches Claude's streaming format)
    this.emit({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: delta },
      },
      parent_tool_use_id: parentToolUseId,
    });
  }

  private handleItemUpdated(params: Record<string, unknown>): void {
    // item/updated is a general update — currently we handle streaming via the specific delta events
    // Could handle status updates for command_execution / file_change items here
  }

  private handleItemCompleted(params: Record<string, unknown>): void {
    const item = params.item as CodexItem;
    if (!item) return;
    const threadId = typeof params.threadId === "string" ? params.threadId : undefined;
    const parentToolUseId = this.getParentToolUseIdForThread(threadId);

    switch (item.type) {
      case "agentMessage": {
        const agentMsg = item as CodexAgentMessageItem;
        const text = agentMsg.text || this.streamingText;

        // Emit message_stop for streaming
        this.emit({
          type: "stream_event",
          event: {
            type: "content_block_stop",
            index: 0,
          },
          parent_tool_use_id: parentToolUseId,
        });
        this.emit({
          type: "stream_event",
          event: {
            type: "message_delta",
            delta: { stop_reason: null }, // null, not "end_turn" — the turn may continue with tool calls
            usage: { output_tokens: 0 },
          },
          parent_tool_use_id: parentToolUseId,
        });

        // Emit the full assistant message
        this.emit({
          type: "assistant",
          message: {
            id: this.makeMessageId("agent", item.id),
            type: "message",
            role: "assistant",
            model: this.options.model || "",
            content: [{ type: "text", text }],
            stop_reason: "end_turn",
            usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
          },
          parent_tool_use_id: parentToolUseId,
          timestamp: Date.now(),
        });

        // Reset streaming state
        this.streamingText = "";
        this.streamingItemId = null;
        break;
      }

      case "commandExecution": {
        const cmd = item as CodexCommandExecutionItem;
        const commandStr = Array.isArray(cmd.command) ? cmd.command.join(" ") : (cmd.command || "");
        // Ensure tool_use was emitted (may be skipped when auto-approved)
        this.ensureToolUseEmitted(item.id, "Bash", { command: commandStr });
        // Clean up progress tracking
        this.commandStartTimes.delete(item.id);
        // Emit tool result
        const output = (item as Record<string, unknown>).stdout as string || "";
        const stderr = (item as Record<string, unknown>).stderr as string || "";
        const combinedOutput = [output, stderr].filter(Boolean).join("\n").trim();
        const exitCode = typeof cmd.exitCode === "number" ? cmd.exitCode : 0;
        const durationMs = typeof cmd.durationMs === "number" ? cmd.durationMs : undefined;
        const failed = cmd.status === "failed" || cmd.status === "declined" || exitCode !== 0;

        // Keep successful no-output commands silent in the chat feed.
        if (!combinedOutput && !failed) {
          break;
        }

        let resultText = combinedOutput;
        if (!resultText) {
          resultText = `Exit code: ${exitCode}`;
        } else if (exitCode !== 0) {
          resultText = `${resultText}\nExit code: ${exitCode}`;
        }
        // Append duration if available and significant (>100ms)
        if (durationMs !== undefined && durationMs >= 100) {
          const durationStr = durationMs >= 1000
            ? `${(durationMs / 1000).toFixed(1)}s`
            : `${durationMs}ms`;
          resultText = `${resultText}\n(${durationStr})`;
        }

        this.emitToolResult(item.id, resultText, failed);
        break;
      }

      case "fileChange": {
        const fc = item as CodexFileChangeItem;
        const changes = fc.changes || [];
        const firstChange = changes[0];
        const toolName = safeKind(firstChange?.kind) === "create" ? "Write" : "Edit";
        // Ensure tool_use was emitted
        this.ensureToolUseEmitted(item.id, toolName, {
          file_path: firstChange?.path || "",
          changes: changes.map((c) => ({ path: c.path, kind: safeKind(c.kind) })),
        });
        const summary = changes.map((c) => `${safeKind(c.kind)}: ${c.path}`).join("\n");
        this.emitToolResult(item.id, summary || "File changes applied", fc.status === "failed");
        break;
      }

      case "mcpToolCall": {
        const mcp = item as CodexMcpToolCallItem;
        // Ensure tool_use was emitted
        this.ensureToolUseEmitted(item.id, `mcp:${mcp.server}:${mcp.tool}`, mcp.arguments || {});
        this.emitToolResult(item.id, mcp.result || mcp.error || "MCP tool call completed", mcp.status === "failed");
        break;
      }

      case "webSearch": {
        const ws = item as CodexWebSearchItem;
        // Ensure tool_use was emitted
        this.ensureToolUseEmitted(item.id, "WebSearch", { query: ws.query || "" });
        this.emitToolResult(item.id, ws.action?.url || ws.query || "Web search completed", false);
        break;
      }

      case "reasoning": {
        const r = item as CodexReasoningItem;
        const thinkingText = (
          this.reasoningTextByItemId.get(item.id)
          || this.coerceReasoningText(r.summary)
          || this.coerceReasoningText(r.content)
          || ""
        ).trim();

        if (thinkingText) {
          this.emit({
            type: "assistant",
            message: {
              id: this.makeMessageId("reasoning", item.id),
              type: "message",
              role: "assistant",
              model: this.options.model || "",
              content: [{ type: "thinking", thinking: thinkingText }],
              stop_reason: null,
              usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
            },
            parent_tool_use_id: null,
            timestamp: Date.now(),
          });
        }

        this.reasoningTextByItemId.delete(item.id);

        // Close the thinking content block that was opened in handleItemStarted
        this.emit({
          type: "stream_event",
          event: {
            type: "content_block_stop",
            index: 0,
          },
          parent_tool_use_id: null,
        });
        break;
      }

      case "contextCompaction":
        this.emit({ type: "status_change", status: null });
        break;

      case "collabAgentToolCall": {
        const collab = item as CodexCollabAgentToolCallItem;
        const receiverThreadIds = Array.isArray(collab.receiverThreadIds)
          ? collab.receiverThreadIds.filter((id): id is string => typeof id === "string" && id.length > 0)
          : [];
        this.ensureToolUseEmitted(item.id, "Task", {
          description: (typeof collab.prompt === "string" && collab.prompt.trim())
            || `${collab.tool || "agent"} (${receiverThreadIds.length || 1} agent${(receiverThreadIds.length || 1) === 1 ? "" : "s"})`,
          subagent_type: collab.tool || "codex-collab",
          codex_status: collab.status,
          sender_thread_id: collab.senderThreadId || null,
          receiver_thread_ids: receiverThreadIds,
        }, parentToolUseId);
        const isError = collab.status === "failed";
        const summary = this.summarizeCollabCall(collab);
        this.emitToolResult(item.id, summary, isError);
        this.emitAssistantText(summary, item.id);
        this.clearSubagentThreadMappings(collab);
        break;
      }

      default:
        if (item.type !== "userMessage") {
          console.log(`[codex-adapter] Unhandled item/completed type: ${item.type}`, JSON.stringify(item).substring(0, 300));
        }
        break;
    }
  }

  private handleTurnCompleted(params: Record<string, unknown>): void {
    const turn = params.turn as { id: string; status: string; error?: { message: string } } | undefined;

    // Synthesize a CLIResultMessage-like structure
    const result: CLIResultMessage = {
      type: "result",
      subtype: turn?.status === "completed" ? "success" : "error_during_execution",
      is_error: turn?.status !== "completed",
      result: turn?.error?.message,
      duration_ms: 0,
      duration_api_ms: 0,
      num_turns: 1,
      total_cost_usd: 0,
      stop_reason: turn?.status || "end_turn",
      usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      uuid: randomUUID(),
      session_id: this.sessionId,
    };

    this.emit({ type: "result", data: result });

    // Clean up per-turn plan tracking now that the turn is complete.
    if (turn?.id) {
      this.planDeltaByTurnId.delete(turn.id);
      this.planUpdateCountByTurnId.delete(turn.id);
    }
    this.currentTurnId = null;
  }

  private updateRateLimits(data: Record<string, unknown>): void {
    const rl = data?.rateLimits as Record<string, unknown> | undefined;
    if (!rl) return;
    const toEpochMs = (value: unknown): number => {
      if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
        return 0;
      }
      return value < 1_000_000_000_000 ? value * 1000 : value;
    };
    const normalizeLimit = (raw: unknown): { usedPercent: number; windowDurationMins: number; resetsAt: number } | null => {
      if (!raw || typeof raw !== "object") return null;
      const limit = raw as Record<string, unknown>;
      return {
        usedPercent: typeof limit.usedPercent === "number" ? limit.usedPercent : 0,
        windowDurationMins: typeof limit.windowDurationMins === "number" ? limit.windowDurationMins : 0,
        resetsAt: toEpochMs(limit.resetsAt),
      };
    };
    this._rateLimits = {
      primary: normalizeLimit(rl.primary),
      secondary: normalizeLimit(rl.secondary),
    };
    // Forward rate limits to browser for UI display
    this.emit({
      type: "session_update",
      session: {
        codex_rate_limits: {
          primary: this._rateLimits.primary,
          secondary: this._rateLimits.secondary,
        },
      },
    });
  }

  private handleTokenUsageUpdated(params: Record<string, unknown>): void {
    // Codex sends: { threadId, turnId, tokenUsage: {
    //   total: { totalTokens, inputTokens, cachedInputTokens, outputTokens, reasoningOutputTokens },
    //   last: { totalTokens, inputTokens, cachedInputTokens, outputTokens, reasoningOutputTokens },
    //   modelContextWindow: 258400
    // }}
    // IMPORTANT: `total` is cumulative across all turns and can far exceed the context window.
    // `last` is the most recent turn — its inputTokens reflects what's actually in context.
    const tokenUsage = params.tokenUsage as Record<string, unknown> | undefined;
    if (!tokenUsage) return;

    const total = tokenUsage.total as Record<string, number> | undefined;
    const last = tokenUsage.last as Record<string, number> | undefined;
    const contextWindow = tokenUsage.modelContextWindow as number | undefined;

    const updates: Partial<SessionState> = {};

    // Use last turn's input tokens for context usage — that's what's actually in the window
    if (last && contextWindow && contextWindow > 0) {
      const usedInContext = (last.inputTokens || 0) + (last.outputTokens || 0);
      const pct = Math.round((usedInContext / contextWindow) * 100);
      updates.context_used_percent = Math.max(0, Math.min(pct, 100));
    }

    // Forward cumulative token breakdown for display in the UI
    if (total) {
      updates.codex_token_details = {
        inputTokens: total.inputTokens || 0,
        outputTokens: total.outputTokens || 0,
        cachedInputTokens: total.cachedInputTokens || 0,
        reasoningOutputTokens: total.reasoningOutputTokens || 0,
        modelContextWindow: contextWindow || 0,
      };
    }

    if (Object.keys(updates).length > 0) {
      this.emit({
        type: "session_update",
        session: updates,
      });
    }
  }

  private handleLegacyTokenCount(params: Record<string, unknown>): void {
    const msg = this.asRecord(params.msg);
    const info = this.asRecord(msg?.info);
    if (!info) return;

    const toUsage = (raw: unknown): Record<string, number> => {
      const usage = this.asRecord(raw);
      if (!usage) {
        return {
          totalTokens: 0,
          inputTokens: 0,
          cachedInputTokens: 0,
          outputTokens: 0,
          reasoningOutputTokens: 0,
        };
      }
      return {
        totalTokens: Number(usage.total_tokens || 0),
        inputTokens: Number(usage.input_tokens || 0),
        cachedInputTokens: Number(usage.cached_input_tokens || 0),
        outputTokens: Number(usage.output_tokens || 0),
        reasoningOutputTokens: Number(usage.reasoning_output_tokens || 0),
      };
    };

    const normalized = {
      tokenUsage: {
        total: toUsage(info.total_token_usage),
        last: toUsage(info.last_token_usage),
        modelContextWindow: Number(info.model_context_window || 0),
      },
    };
    this.handleTokenUsageUpdated(normalized);
  }

  // ── Command progress tracking ─────────────────────────────────────────

  private emitCommandProgress(params: Record<string, unknown>): void {
    const itemId = params.itemId as string | undefined;
    if (!itemId) return;
    const startTime = this.commandStartTimes.get(itemId);
    const elapsed = startTime ? Math.round((Date.now() - startTime) / 1000) : 0;
    this.emit({
      type: "tool_progress",
      tool_use_id: itemId,
      tool_name: "Bash",
      elapsed_time_seconds: elapsed,
    });
  }

  // ── Helpers ─────────────────────────────────────────────────────────────

  private emit(msg: BrowserIncomingMessage): void {
    this.browserMessageCb?.(msg);
  }

  private reportProtocolDrift(
    messageKind: "notification" | "request",
    messageName: string,
    options?: { payload?: Record<string, unknown>; blockedForSafety?: boolean },
  ): void {
    reportProtocolDrift(
      this.protocolDriftSeen,
      {
        backend: "codex",
        sessionId: this.sessionId,
        direction: "incoming",
        messageKind,
        messageName,
        keys: options?.payload ? Object.keys(options.payload) : undefined,
        rawPreview: options?.payload ? JSON.stringify(options.payload) : undefined,
        blockedForSafety: options?.blockedForSafety,
      },
      (message) => this.emit({ type: "error", message }),
    );
  }

  private getParentToolUseIdForThread(threadId?: string): string | null {
    if (!threadId) return null;
    return this.parentToolUseByThreadId.get(threadId) || null;
  }

  private setSubagentThreadMappings(parentToolUseId: string, collab: CodexCollabAgentToolCallItem): void {
    const receiverThreadIds = Array.isArray(collab.receiverThreadIds)
      ? collab.receiverThreadIds
      : [];
    for (const receiverThreadId of receiverThreadIds) {
      if (typeof receiverThreadId === "string" && receiverThreadId.length > 0) {
        this.parentToolUseByThreadId.set(receiverThreadId, parentToolUseId);
      }
    }
  }

  private clearSubagentThreadMappings(collab: CodexCollabAgentToolCallItem): void {
    const receiverThreadIds = Array.isArray(collab.receiverThreadIds)
      ? collab.receiverThreadIds
      : [];
    for (const receiverThreadId of receiverThreadIds) {
      if (typeof receiverThreadId === "string" && receiverThreadId.length > 0) {
        this.parentToolUseByThreadId.delete(receiverThreadId);
      }
    }
  }

  private summarizeCollabCall(collab: CodexCollabAgentToolCallItem): string {
    const receiverCount = Array.isArray(collab.receiverThreadIds)
      ? collab.receiverThreadIds.filter((id): id is string => typeof id === "string" && id.length > 0).length
      : 0;
    const statusText = collab.status === "completed"
      ? "completed"
      : collab.status === "failed"
        ? "failed"
        : "running";
    const tool = collab.tool || "collab";
    const count = receiverCount || 1;
    return `${tool} ${statusText} for ${count} agent${count === 1 ? "" : "s"}`;
  }

  private emitAssistantText(text: string, parentToolUseId: string | null): void {
    this.emit({
      type: "assistant",
      message: {
        id: this.makeMessageId("agent_text"),
        type: "message",
        role: "assistant",
        model: this.options.model || "",
        content: [{ type: "text", text }],
        stop_reason: null,
        usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
      parent_tool_use_id: parentToolUseId,
      timestamp: Date.now(),
    });
  }

  /** Emit an assistant message with a tool_use content block (no tracking). */
  private emitToolUse(toolUseId: string, toolName: string, input: Record<string, unknown>, parentToolUseId: string | null = null): void {
    console.log(`[codex-adapter] Emitting tool_use: ${toolName} id=${toolUseId}`);
    this.emit({
      type: "assistant",
      message: {
        id: this.makeMessageId("tool_use", toolUseId),
        type: "message",
        role: "assistant",
        model: this.options.model || "",
        content: [
          {
            type: "tool_use",
            id: toolUseId,
            name: toolName,
            input,
          },
        ],
        stop_reason: null,
        usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
      parent_tool_use_id: parentToolUseId,
      timestamp: Date.now(),
    });
  }

  /** Emit tool_use and track the ID so we don't double-emit. */
  private emitToolUseTracked(toolUseId: string, toolName: string, input: Record<string, unknown>, parentToolUseId: string | null = null): void {
    this.emittedToolUseIds.add(toolUseId);
    this.emitToolUse(toolUseId, toolName, input, parentToolUseId);
  }

  /**
   * Emit a tool_use start sequence: stream_event content_block_start + assistant message.
   * This matches Claude Code's streaming pattern and ensures the frontend sees the tool block
   * even during active streaming.
   */
  private emitToolUseStart(
    toolUseId: string,
    toolName: string,
    input: Record<string, unknown>,
    parentToolUseId: string | null = null,
  ): void {
    // Emit stream event for tool_use start (matches Claude Code pattern)
    this.emit({
      type: "stream_event",
      event: {
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: toolUseId, name: toolName, input: {} },
      },
      parent_tool_use_id: parentToolUseId,
    });
    this.emitToolUseTracked(toolUseId, toolName, input, parentToolUseId);
  }

  /** Emit tool_use only if item/started was never received for this ID. */
  private ensureToolUseEmitted(
    toolUseId: string,
    toolName: string,
    input: Record<string, unknown>,
    parentToolUseId: string | null = null,
  ): void {
    if (!this.emittedToolUseIds.has(toolUseId)) {
      console.log(`[codex-adapter] Backfilling tool_use for ${toolName} (id=${toolUseId}) — item/started was missing`);
      this.emitToolUseTracked(toolUseId, toolName, input, parentToolUseId);
    }
  }

  /** Emit an assistant message with a tool_result content block. */
  private emitToolResult(toolUseId: string, content: unknown, isError: boolean): void {
    const safeContent = typeof content === "string" ? content : JSON.stringify(content);
    this.emit({
      type: "assistant",
      message: {
        id: this.makeMessageId("tool_result", toolUseId),
        type: "message",
        role: "assistant",
        model: this.options.model || "",
        content: [
          {
            type: "tool_result",
            tool_use_id: toolUseId,
            content: safeContent,
            is_error: isError,
          },
        ],
        stop_reason: null,
        usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
      parent_tool_use_id: null,
      timestamp: Date.now(),
    });
  }

  private makeMessageId(kind: string, sourceId?: string): string {
    if (sourceId) return `codex-${kind}-${sourceId}`;
    return `codex-${kind}-${randomUUID()}`;
  }

  private mapApprovalPolicy(_mode?: string): string {
    // Always "never" — the user never wants permission prompts in Codex,
    // regardless of whether the collaboration mode is Auto or Plan.
    return "never";
  }

  private mapSandboxPolicy(_mode?: string): string {
    // Always full access — matches approvalPolicy: "never" for full autonomy.
    return "danger-full-access";
  }

  /** Map permission mode to SandboxPolicy object (for turn/start's sandboxPolicy field). */
  private mapSandboxPolicyObject(_mode?: string): { type: string } {
    // Always full access — matches approvalPolicy: "never" for full autonomy.
    return { type: "dangerFullAccess" };
  }

  private mapCollaborationMode(kind: "default" | "plan"): { mode: "default" | "plan"; settings: { model: string } } {
    return { mode: kind, settings: { model: this.options.model || "" } };
  }

  private async listAllMcpServerStatuses(): Promise<CodexMcpServerStatus[]> {
    const out: CodexMcpServerStatus[] = [];
    let cursor: string | null = null;
    let page = 0;

    while (page < 50) {
      const response = await this.transport.call("mcpServerStatus/list", {
        cursor,
        limit: 100,
      }) as CodexMcpStatusListResponse;
      if (Array.isArray(response.data)) {
        out.push(...response.data);
      }
      cursor = typeof response.nextCursor === "string" ? response.nextCursor : null;
      if (!cursor) break;
      page++;
    }

    return out;
  }

  private async readMcpServersConfig(): Promise<Record<string, unknown>> {
    const response = await this.transport.call("config/read", {}) as {
      config?: Record<string, unknown>;
    };
    const config = this.asRecord(response?.config) || {};
    return this.asRecord(config.mcp_servers) || {};
  }

  private async reloadMcpServers(): Promise<void> {
    await this.transport.call("config/mcpServer/reload", {});
  }

  private isMcpServerEnabled(value: unknown): boolean {
    const cfg = this.asRecord(value);
    if (!cfg) return true;
    return cfg.enabled !== false;
  }

  private asRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  }

  private toMcpServerConfig(value: unknown): McpServerConfig {
    const cfg = this.asRecord(value) || {};
    const args = Array.isArray(cfg.args)
      ? cfg.args.filter((a): a is string => typeof a === "string")
      : undefined;
    const env = this.asRecord(cfg.env) as Record<string, string> | null;

    let type: McpServerConfig["type"] = "sdk";
    if (cfg.type === "stdio" || cfg.type === "sse" || cfg.type === "http" || cfg.type === "sdk") {
      type = cfg.type;
    } else if (typeof cfg.command === "string") {
      type = "stdio";
    } else if (typeof cfg.url === "string") {
      type = "http";
    }

    return {
      type,
      command: typeof cfg.command === "string" ? cfg.command : undefined,
      args,
      env: env || undefined,
      url: typeof cfg.url === "string" ? cfg.url : undefined,
    };
  }

  private fromMcpServerConfig(config: McpServerConfig): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    if (typeof config.command === "string") out.command = config.command;
    if (Array.isArray(config.args)) out.args = config.args;
    if (config.env) out.env = config.env;
    if (typeof config.url === "string") out.url = config.url;
    return out;
  }

  private mapMcpTools(
    tools: Record<string, { name?: string; annotations?: unknown }> | undefined,
  ): McpServerDetail["tools"] {
    if (!tools) return [];
    return Object.entries(tools).map(([key, tool]) => {
      const ann = this.asRecord(tool.annotations);
      const annotations = ann ? {
        readOnly: (ann.readOnly ?? ann.readOnlyHint) === true,
        destructive: (ann.destructive ?? ann.destructiveHint) === true,
        openWorld: (ann.openWorld ?? ann.openWorldHint) === true,
      } : undefined;

      return {
        name: typeof tool.name === "string" ? tool.name : key,
        annotations,
      };
    });
  }
}
