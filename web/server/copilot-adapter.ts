/**
 * Copilot ACP Adapter
 *
 * Bridges the GitHub Copilot CLI's Agent Communication Protocol (ACP) —
 * a JSON-RPC 2.0 protocol over stdio, launched with `copilot --acp` —
 * to The Companion's BrowserIncomingMessage/BrowserOutgoingMessage types.
 *
 * ACP Protocol summary (protocolVersion: 1):
 *   initialize       → {protocolVersion:1, clientInfo, capabilities}
 *   session/new      → {mcpServers:[], cwd} → {sessionId, models}
 *   session/load     → {sessionId, mcpServers:[], cwd} → {models}
 *   session/list     → {} → {sessions:[{sessionId, cwd, title, updatedAt}]}
 *   session/prompt   → {sessionId, prompt:[{type:"text",text}], cwd}
 *                    → {stopReason:"end_turn"}  (blocking; notifications come mid-flight)
 *
 * Notifications received during session/prompt:
 *   session/update with update.sessionUpdate:
 *     "agent_message_chunk"  — streaming text: {content:{type:"text",text}}
 *     "agent_thought_chunk"  — thinking text:  {content:{type:"text",text}}
 *     "tool_call"            — tool started:   {toolCallId, title, kind, status:"pending", rawInput}
 *     "tool_call_update"     — tool result:    {toolCallId, status:"completed", content, rawOutput}
 */

import { randomUUID } from "node:crypto";
import type { Subprocess } from "bun";
import type {
  BrowserIncomingMessage,
  BrowserOutgoingMessage,
  ContentBlock,
  SessionState,
} from "./session-types.js";
import type { RecorderManager } from "./recorder.js";

// ─── ACP JSON-RPC Types ───────────────────────────────────────────────────────

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

interface AcpSessionUpdate {
  sessionUpdate: string;
  // agent_message_chunk / agent_thought_chunk
  content?: { type: "text"; text: string };
  // tool_call
  toolCallId?: string;
  title?: string;
  kind?: string;
  status?: string;
  rawInput?: Record<string, unknown>;
  // tool_call_update (content is an array of blocks)
  toolResultContent?: Array<{ type: "content"; content: { type: "text"; text: string } }>;
  rawOutput?: { content?: string; detailedContent?: string };
}

// ─── JSON-RPC Transport (stdio) ───────────────────────────────────────────────

class AcpTransport {
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private notificationHandler: ((method: string, params: Record<string, unknown>) => void) | null = null;
  private rawInCb: ((line: string) => void) | null = null;
  private rawOutCb: ((data: string) => void) | null = null;
  private writer: WritableStreamDefaultWriter<Uint8Array>;
  private connected = true;
  private buffer = "";

  constructor(
    stdin: WritableStream<Uint8Array> | { write(data: Uint8Array): number },
    stdout: ReadableStream<Uint8Array>,
  ) {
    let writable: WritableStream<Uint8Array>;
    if ("write" in stdin && typeof stdin.write === "function") {
      writable = new WritableStream({
        write(chunk) {
          (stdin as { write(data: Uint8Array): number }).write(chunk);
        },
      });
    } else {
      writable = stdin as WritableStream<Uint8Array>;
    }
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
      console.error("[copilot-adapter] stdout reader error:", err);
    } finally {
      this.connected = false;
      for (const [, { reject }] of this.pending) {
        reject(new Error("ACP transport closed"));
      }
      this.pending.clear();
    }
  }

  private processBuffer(): void {
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() || "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      this.rawInCb?.(trimmed);
      let msg: JsonRpcMessage;
      try {
        msg = JSON.parse(trimmed);
      } catch {
        console.warn("[copilot-adapter] Failed to parse JSON-RPC:", trimmed.substring(0, 200));
        continue;
      }
      this.dispatch(msg);
    }
  }

  private dispatch(msg: JsonRpcMessage): void {
    if ("id" in msg && msg.id !== undefined && !("method" in msg && (msg as JsonRpcRequest).method)) {
      // Response to our request
      const resp = msg as JsonRpcResponse;
      const pending = this.pending.get(resp.id);
      if (pending) {
        this.pending.delete(resp.id);
        if (resp.error) {
          pending.reject(new Error(resp.error.message));
        } else {
          pending.resolve(resp.result);
        }
      }
    } else if ("method" in msg) {
      // Notification (no id or has id — copilot notifications have no id)
      this.notificationHandler?.(
        (msg as JsonRpcNotification).method,
        (msg as JsonRpcNotification).params || {},
      );
    }
  }

  async call(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const id = this.nextId++;
    return new Promise(async (resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      const request = JSON.stringify({ jsonrpc: "2.0", method, id, params });
      try {
        await this.writeRaw(request + "\n");
      } catch (err) {
        this.pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  onNotification(handler: (method: string, params: Record<string, unknown>) => void): void {
    this.notificationHandler = handler;
  }

  isConnected(): boolean {
    return this.connected;
  }

  onRawIncoming(cb: (line: string) => void): void {
    this.rawInCb = cb;
  }

  onRawOutgoing(cb: (data: string) => void): void {
    this.rawOutCb = cb;
  }

  private async writeRaw(data: string): Promise<void> {
    if (!this.connected) throw new Error("ACP transport closed");
    this.rawOutCb?.(data);
    await this.writer.write(new TextEncoder().encode(data));
  }
}

// ─── Adapter Options ──────────────────────────────────────────────────────────

export interface CopilotAdapterOptions {
  model?: string;
  cwd?: string;
  /** ACP session ID to resume (from a previous run). */
  acpSessionId?: string;
  /** Optional recorder for raw message capture. */
  recorder?: RecorderManager;
}

// ─── CopilotAdapter ───────────────────────────────────────────────────────────

export class CopilotAdapter {
  private transport: AcpTransport;
  private proc: Subprocess;
  private sessionId: string;
  private options: CopilotAdapterOptions;

  private browserMessageCb: ((msg: BrowserIncomingMessage) => void) | null = null;
  private sessionMetaCb: ((meta: { cliSessionId?: string; model?: string; cwd?: string }) => void) | null = null;
  private disconnectCb: (() => void) | null = null;
  private initErrorCb: ((error: string) => void) | null = null;

  // The ACP session ID assigned by the copilot CLI
  private acpSessionId: string | null = null;
  private connected = false;
  private initialized = false;
  private initFailed = false;

  // Per-turn state — reset on each session/prompt call
  private turnTextChunks: string[] = [];
  private turnThinkingChunks: string[] = [];
  private turnToolCalls: Array<{
    toolCallId: string;
    title: string;
    kind: string;
    rawInput: Record<string, unknown>;
    rawOutput?: string;
    status: string;
  }> = [];

  // Queued browser messages received before initialization
  private pendingOutgoing: BrowserOutgoingMessage[] = [];

  // Counter to generate stable message IDs
  private msgCounter = 0;

  constructor(proc: Subprocess, sessionId: string, options: CopilotAdapterOptions = {}) {
    this.proc = proc;
    this.sessionId = sessionId;
    this.options = options;

    const stdout = proc.stdout;
    const stdin = proc.stdin;
    if (!stdout || !stdin || typeof stdout === "number" || typeof stdin === "number") {
      throw new Error("Copilot process must have stdio pipes");
    }

    this.transport = new AcpTransport(
      stdin as WritableStream<Uint8Array> | { write(data: Uint8Array): number },
      stdout as ReadableStream<Uint8Array>,
    );

    this.transport.onNotification((method, params) => this.handleNotification(method, params));

    if (options.recorder) {
      const recorder = options.recorder;
      const cwd = options.cwd || "";
      this.transport.onRawIncoming((line) => {
        recorder.record(sessionId, "in", line, "cli", "copilot", cwd);
      });
      this.transport.onRawOutgoing((data) => {
        recorder.record(sessionId, "out", data.trimEnd(), "cli", "copilot", cwd);
      });
    }

    proc.exited.then(() => {
      this.connected = false;
      this.disconnectCb?.();
    });

    this.initialize();
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  sendBrowserMessage(msg: BrowserOutgoingMessage): boolean {
    if (this.initFailed) return false;

    if (!this.initialized || !this.acpSessionId) {
      if (msg.type === "user_message") {
        console.log(`[copilot-adapter] Queuing ${msg.type} — adapter not yet initialized`);
        this.pendingOutgoing.push(msg);
        return true;
      }
      return false;
    }

    return this.dispatchOutgoing(msg);
  }

  private dispatchOutgoing(msg: BrowserOutgoingMessage): boolean {
    switch (msg.type) {
      case "user_message":
        this.handleOutgoingUserMessage(msg);
        return true;
      case "interrupt":
        // ACP has no interrupt method — kill and signal disconnect; relaunch handles restart
        console.warn("[copilot-adapter] Interrupt not supported by ACP; killing process");
        this.proc.kill("SIGTERM");
        return true;
      case "set_model":
        console.warn("[copilot-adapter] Runtime model switching not supported by ACP");
        return false;
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
    try {
      this.proc.kill("SIGTERM");
      await Promise.race([this.proc.exited, new Promise((r) => setTimeout(r, 5000))]);
    } catch {}
  }

  getAcpSessionId(): string | null {
    return this.acpSessionId;
  }

  // ── Initialization ──────────────────────────────────────────────────────────

  private async initialize(): Promise<void> {
    try {
      // Step 1: ACP initialize handshake
      await this.transport.call("initialize", {
        protocolVersion: 1,
        clientInfo: { name: "thecompanion", version: "1.0.0" },
        capabilities: {},
      });

      this.connected = true;

      // Step 2: Create new ACP session or resume existing one
      const cwd = this.options.cwd || process.cwd();
      if (this.options.acpSessionId) {
        try {
          await this.transport.call("session/load", {
            sessionId: this.options.acpSessionId,
            mcpServers: [],
            cwd,
          });
          this.acpSessionId = this.options.acpSessionId;
        } catch (loadErr) {
          // Session no longer exists in the CLI (e.g. after a CLI restart).
          // Fall back to creating a fresh session instead of failing entirely.
          const loadMsg = loadErr instanceof Error ? loadErr.message : String(loadErr);
          console.warn(`[copilot-adapter] session/load failed (${loadMsg}), starting new session`);
          const result = await this.transport.call("session/new", {
            mcpServers: [],
            cwd,
            ...(this.options.model ? { model: this.options.model } : {}),
          }) as { sessionId: string; models?: unknown };
          this.acpSessionId = result.sessionId;
        }
      } else {
        const result = await this.transport.call("session/new", {
          mcpServers: [],
          cwd,
          ...(this.options.model ? { model: this.options.model } : {}),
        }) as { sessionId: string; models?: unknown };
        this.acpSessionId = result.sessionId;
      }

      this.initialized = true;

      // Notify WsBridge of the ACP session ID (used for session resume on relaunch)
      this.sessionMetaCb?.({
        cliSessionId: this.acpSessionId,
        model: this.options.model,
        cwd,
      });

      // Emit session_init to the browser
      const state: SessionState = {
        session_id: this.sessionId,
        backend_type: "copilot",
        model: this.options.model || "",
        cwd,
        tools: [],
        permissionMode: "bypassPermissions",
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

      // Flush queued outgoing messages
      if (this.pendingOutgoing.length > 0) {
        console.log(`[copilot-adapter] Flushing ${this.pendingOutgoing.length} queued message(s)`);
        const queued = this.pendingOutgoing.splice(0);
        for (const msg of queued) {
          this.dispatchOutgoing(msg);
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[copilot-adapter] Initialization failed for session ${this.sessionId}:`, msg);
      this.initFailed = true;
      this.initErrorCb?.(msg);
    }
  }

  // ── Notification handler ────────────────────────────────────────────────────

  private handleNotification(method: string, params: Record<string, unknown>): void {
    if (method !== "session/update") return;

    const update = params.update as AcpSessionUpdate | undefined;
    if (!update) return;

    switch (update.sessionUpdate) {
      case "agent_thought_chunk": {
        const text = update.content?.text ?? "";
        if (text) {
          this.turnThinkingChunks.push(text);
          // Emit streaming think delta so the browser shows live thinking
          this.emit({
            type: "stream_event",
            event: {
              type: "content_block_delta",
              index: 0,
              delta: { type: "thinking_delta", thinking: text },
            },
            parent_tool_use_id: null,
          });
        }
        break;
      }

      case "agent_message_chunk": {
        const text = update.content?.text ?? "";
        if (text) {
          this.turnTextChunks.push(text);
          // Emit streaming text delta
          this.emit({
            type: "stream_event",
            event: {
              type: "content_block_delta",
              index: 0,
              delta: { type: "text_delta", text },
            },
            parent_tool_use_id: null,
          });
        }
        break;
      }

      case "tool_call": {
        const toolCallId = update.toolCallId ?? randomUUID();
        const title = update.title ?? "Tool call";
        const kind = update.kind ?? "unknown";
        const rawInput = update.rawInput ?? {};

        this.turnToolCalls.push({ toolCallId, title, kind, rawInput, status: "pending" });

        // Emit tool_progress so the browser shows the spinner
        this.emit({
          type: "tool_progress",
          tool_use_id: toolCallId,
          tool_name: title,
          elapsed_time_seconds: 0,
        });

        // Emit an assistant message with a tool_use block so the UI can show it
        const msgId = `msg_${this.msgCounter++}`;
        this.emit({
          type: "assistant",
          message: {
            id: msgId,
            type: "message",
            role: "assistant",
            model: this.options.model || "copilot",
            content: [
              {
                type: "tool_use",
                id: toolCallId,
                name: title,
                input: rawInput,
              },
            ],
            stop_reason: null,
            usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
          },
          parent_tool_use_id: null,
          timestamp: Date.now(),
        });
        break;
      }

      case "tool_call_update": {
        const toolCallId = update.toolCallId ?? "";
        const entry = this.turnToolCalls.find((t) => t.toolCallId === toolCallId);
        if (entry) {
          entry.status = update.status ?? "completed";
          // Flatten result text from content array or rawOutput
          const contentArr = update.toolResultContent ?? [];
          const resultText = contentArr
            .map((c) => c?.content?.text ?? "")
            .join("")
            || update.rawOutput?.content
            || "";
          entry.rawOutput = resultText;

          // Emit tool_result as an assistant message
          const msgId = `msg_${this.msgCounter++}`;
          const isError = entry.status === "failed" || entry.status === "declined";
          this.emit({
            type: "assistant",
            message: {
              id: msgId,
              type: "message",
              role: "assistant",
              model: this.options.model || "copilot",
              content: [
                {
                  type: "tool_result",
                  tool_use_id: toolCallId,
                  content: resultText,
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
        break;
      }
    }
  }

  // ── Outgoing user message → session/prompt ──────────────────────────────────

  private async handleOutgoingUserMessage(msg: BrowserOutgoingMessage & { type: "user_message" }): Promise<void> {
    if (!this.acpSessionId) return;

    const cwd = this.options.cwd || process.cwd();

    // Reset per-turn accumulators
    this.turnTextChunks = [];
    this.turnThinkingChunks = [];
    this.turnToolCalls = [];

    // Signal turn start (message_start stream event so browser shows streaming indicator)
    this.emit({
      type: "stream_event",
      event: { type: "message_start", message: { id: `msg_${this.msgCounter}`, usage: { input_tokens: 0 } } },
      parent_tool_use_id: null,
    });
    this.emit({ type: "status_change", status: "running" });

    try {
      const promptBlocks: Array<{ type: string; text?: string; mediaType?: string; data?: string }> = [
        { type: "text", text: msg.content },
      ];

      // Attach images if provided
      if (msg.images && msg.images.length > 0) {
        for (const img of msg.images) {
          promptBlocks.push({ type: "image", mediaType: img.media_type, data: img.data });
        }
      }

      await this.transport.call("session/prompt", {
        sessionId: this.acpSessionId,
        prompt: promptBlocks,
        cwd,
        ...(this.options.model ? { model: this.options.model } : {}),
      });

      // Emit the final assembled assistant message (accumulated text + thinking)
      const fullText = this.turnTextChunks.join("");
      const thinkingText = this.turnThinkingChunks.join("");
      const contentBlocks: ContentBlock[] = [];

      if (thinkingText) {
        contentBlocks.push({ type: "thinking", thinking: thinkingText });
      }
      if (fullText) {
        contentBlocks.push({ type: "text", text: fullText });
      }

      if (contentBlocks.length > 0) {
        const msgId = `msg_${this.msgCounter++}`;
        this.emit({
          type: "assistant",
          message: {
            id: msgId,
            type: "message",
            role: "assistant",
            model: this.options.model || "copilot",
            content: contentBlocks,
            stop_reason: "end_turn",
            usage: { input_tokens: 0, output_tokens: this.turnTextChunks.reduce((a, c) => a + c.length, 0), cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
          },
          parent_tool_use_id: null,
          timestamp: Date.now(),
        });
      }

      // Emit result to signal turn completion
      this.emit({
        type: "result",
        data: {
          type: "result",
          subtype: "success",
          is_error: false,
          duration_ms: 0,
          duration_api_ms: 0,
          num_turns: 1,
          total_cost_usd: 0,
          stop_reason: "end_turn",
          usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
          uuid: randomUUID(),
          session_id: this.sessionId,
        },
      });

      this.emit({ type: "status_change", status: "idle" });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`[copilot-adapter] session/prompt failed for session ${this.sessionId}:`, errMsg);
      this.emit({ type: "error", message: `Copilot error: ${errMsg}` });
      this.emit({ type: "status_change", status: null });
    }
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  private emit(msg: BrowserIncomingMessage): void {
    this.browserMessageCb?.(msg);
  }
}
