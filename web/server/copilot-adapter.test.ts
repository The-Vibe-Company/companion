import { describe, it, expect, vi, beforeEach } from "vitest";
import { CopilotAdapter } from "./copilot-adapter.js";
import type { BrowserIncomingMessage } from "./session-types.js";

// ─── Mock Subprocess ──────────────────────────────────────────────────────────

class MockWritableStream {
  chunks: string[] = [];
  private writer = {
    write: async (chunk: Uint8Array) => {
      this.chunks.push(new TextDecoder().decode(chunk));
    },
    releaseLock: () => {},
  };
  getWriter() {
    return this.writer;
  }
}

class MockReadableStream {
  private controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  readonly stream: ReadableStream<Uint8Array>;

  constructor() {
    this.stream = new ReadableStream({
      start: (controller) => {
        this.controller = controller;
      },
    });
  }

  push(data: string) {
    this.controller?.enqueue(new TextEncoder().encode(data));
  }

  close() {
    this.controller?.close();
  }
}

function createMockProcess() {
  const stdinStream = new MockWritableStream();
  const stdoutReadable = new MockReadableStream();
  const stderrReadable = new MockReadableStream();

  let resolveExit!: (code: number) => void;
  const exitPromise = new Promise<number>((resolve) => {
    resolveExit = resolve;
  });

  const proc = {
    stdin: stdinStream,
    stdout: stdoutReadable.stream,
    stderr: stderrReadable.stream,
    pid: 12345,
    exited: exitPromise,
    kill: vi.fn(),
  };

  return { proc, stdin: stdinStream, stdout: stdoutReadable, stderr: stderrReadable, resolveExit };
}

// ─── NDJSON helpers ───────────────────────────────────────────────────────────

/** Parse all complete NDJSON lines from accumulated stdin chunks. */
function parseNdjsonLines(chunks: string[]): unknown[] {
  return chunks
    .join("")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l));
}

/** Complete the ACP initialize handshake (id:1) and session/new (id:2) sequence. */
async function completeInit(
  stdout: MockReadableStream,
  sessionId = "acp-sess-1",
) {
  // Wait for initialize to be sent
  await new Promise((r) => setTimeout(r, 50));
  // Respond to initialize (id:1)
  stdout.push(JSON.stringify({ id: 1, jsonrpc: "2.0", result: {} }) + "\n");
  await new Promise((r) => setTimeout(r, 20));
  // Respond to session/new (id:2)
  stdout.push(JSON.stringify({ id: 2, result: { sessionId } }) + "\n");
  await new Promise((r) => setTimeout(r, 50));
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("CopilotAdapter", () => {
  let proc: ReturnType<typeof createMockProcess>["proc"];
  let stdin: MockWritableStream;
  let stdout: MockReadableStream;
  let resolveExit: ReturnType<typeof createMockProcess>["resolveExit"];

  beforeEach(() => {
    const mock = createMockProcess();
    proc = mock.proc;
    stdin = mock.stdin;
    stdout = mock.stdout;
    resolveExit = mock.resolveExit;
  });

  // ── ACP handshake ─────────────────────────────────────────────────────────

  it("sends initialize JSON-RPC request on construction", async () => {
    // The adapter must send an ACP initialize handshake as its very first message.
    // protocolVersion MUST be the number 1 (not the string "1") per the ACP spec.
    new CopilotAdapter(proc as never, "test-session", { cwd: "/tmp" });

    await new Promise((r) => setTimeout(r, 50));

    const lines = parseNdjsonLines(stdin.chunks) as Array<Record<string, unknown>>;
    const initReq = lines.find((l) => l.method === "initialize");
    expect(initReq).toBeDefined();
    expect(initReq!.method).toBe("initialize");
    expect(initReq!.id).toBe(1);
    // protocolVersion must be numeric 1, not string "1"
    expect((initReq!.params as Record<string, unknown>).protocolVersion).toBe(1);
    // clientInfo must identify thecompanion
    expect(JSON.stringify(initReq!.params)).toContain("thecompanion");
  });

  it("includes capabilities object in initialize params", async () => {
    // ACP requires a capabilities key in the initialize params even if empty.
    new CopilotAdapter(proc as never, "test-session", {});

    await new Promise((r) => setTimeout(r, 50));

    const lines = parseNdjsonLines(stdin.chunks) as Array<Record<string, unknown>>;
    const initReq = lines.find((l) => l.method === "initialize");
    expect(initReq).toBeDefined();
    const params = initReq!.params as Record<string, unknown>;
    expect(params).toHaveProperty("capabilities");
  });

  // ── session/new ──────────────────────────────────────────────────────────

  it("calls session/new after initialize and emits session_init with backend_type copilot", async () => {
    // After the handshake completes, the adapter must call session/new to create an ACP
    // session, then emit session_init to the browser so the UI can render the chat view.
    const messages: BrowserIncomingMessage[] = [];
    const adapter = new CopilotAdapter(proc as never, "test-session", {
      cwd: "/home/user/project",
      model: "gpt-4o",
    });
    adapter.onBrowserMessage((msg) => messages.push(msg));

    await new Promise((r) => setTimeout(r, 50));

    // Respond to initialize (id:1)
    stdout.push(JSON.stringify({ id: 1, jsonrpc: "2.0", result: {} }) + "\n");
    await new Promise((r) => setTimeout(r, 20));

    // Verify session/new was sent as the second request (id:2)
    const lines = parseNdjsonLines(stdin.chunks) as Array<Record<string, unknown>>;
    const sessionNewReq = lines.find((l) => l.method === "session/new");
    expect(sessionNewReq).toBeDefined();
    expect(sessionNewReq!.id).toBe(2);
    const params = sessionNewReq!.params as Record<string, unknown>;
    expect(params.mcpServers).toEqual([]);
    expect(params.cwd).toBe("/home/user/project");
    expect(params.model).toBe("gpt-4o");

    // Respond to session/new (id:2)
    stdout.push(JSON.stringify({ id: 2, result: { sessionId: "acp-sess-1" } }) + "\n");
    await new Promise((r) => setTimeout(r, 50));

    // Should have emitted session_init
    const initMsgs = messages.filter((m) => m.type === "session_init");
    expect(initMsgs.length).toBe(1);

    const init = initMsgs[0] as unknown as { session: Record<string, unknown> };
    expect(init.session.backend_type).toBe("copilot");
    expect(init.session.model).toBe("gpt-4o");
    expect(init.session.cwd).toBe("/home/user/project");
    expect(init.session.session_id).toBe("test-session");
  });

  it("omits model from session/new when not provided", async () => {
    // model is optional in session/new — it should only appear when explicitly set.
    new CopilotAdapter(proc as never, "test-session", { cwd: "/tmp" });

    await new Promise((r) => setTimeout(r, 50));
    stdout.push(JSON.stringify({ id: 1, jsonrpc: "2.0", result: {} }) + "\n");
    await new Promise((r) => setTimeout(r, 20));

    const lines = parseNdjsonLines(stdin.chunks) as Array<Record<string, unknown>>;
    const sessionNewReq = lines.find((l) => l.method === "session/new");
    expect(sessionNewReq).toBeDefined();
    const params = sessionNewReq!.params as Record<string, unknown>;
    expect(params).not.toHaveProperty("model");
  });

  it("calls onSessionMeta with ACP session ID after init", async () => {
    // WsBridge uses onSessionMeta to persist the ACP session ID for process relaunch/resume.
    const metaCalls: Array<{ cliSessionId?: string; model?: string; cwd?: string }> = [];
    const adapter = new CopilotAdapter(proc as never, "test-session", {
      model: "gpt-4o",
      cwd: "/workspace",
    });
    adapter.onSessionMeta((meta) => metaCalls.push(meta));

    await completeInit(stdout, "acp-sess-42");

    expect(metaCalls.length).toBe(1);
    expect(metaCalls[0].cliSessionId).toBe("acp-sess-42");
    expect(metaCalls[0].model).toBe("gpt-4o");
    expect(metaCalls[0].cwd).toBe("/workspace");
  });

  // ── session/load (resume) ─────────────────────────────────────────────────

  it("calls session/load instead of session/new when acpSessionId is provided", async () => {
    // When resuming a session (after server restart or relaunch), the adapter must
    // use session/load with the previously assigned ACP session ID, not create a new one.
    new CopilotAdapter(proc as never, "test-session", {
      cwd: "/home/user",
      acpSessionId: "existing-acp-session-99",
    });

    await new Promise((r) => setTimeout(r, 50));
    stdout.push(JSON.stringify({ id: 1, jsonrpc: "2.0", result: {} }) + "\n");
    await new Promise((r) => setTimeout(r, 20));

    const lines = parseNdjsonLines(stdin.chunks) as Array<Record<string, unknown>>;

    // Must NOT send session/new
    expect(lines.find((l) => l.method === "session/new")).toBeUndefined();

    // Must send session/load with the existing session ID
    const loadReq = lines.find((l) => l.method === "session/load");
    expect(loadReq).toBeDefined();
    expect(loadReq!.id).toBe(2);
    const params = loadReq!.params as Record<string, unknown>;
    expect(params.sessionId).toBe("existing-acp-session-99");
    expect(params.mcpServers).toEqual([]);
    expect(params.cwd).toBe("/home/user");
  });

  it("exposes the ACP session ID via getAcpSessionId after session/load", async () => {
    // getAcpSessionId() is used by WsBridge to persist the session ID.
    // For session/load, the provided acpSessionId must be stored as-is.
    const adapter = new CopilotAdapter(proc as never, "test-session", {
      cwd: "/tmp",
      acpSessionId: "loaded-session-id",
    });

    await new Promise((r) => setTimeout(r, 50));
    stdout.push(JSON.stringify({ id: 1, jsonrpc: "2.0", result: {} }) + "\n");
    await new Promise((r) => setTimeout(r, 20));
    // Respond to session/load (id:2) — result has no sessionId field, adapter uses the provided one
    stdout.push(JSON.stringify({ id: 2, result: { models: [] } }) + "\n");
    await new Promise((r) => setTimeout(r, 50));

    expect(adapter.getAcpSessionId()).toBe("loaded-session-id");
  });

  it("falls back to session/new when session/load fails with 'not found'", async () => {
    // When a Copilot session is relaunched after a CLI restart, the previously stored
    // ACP session ID may no longer exist. The adapter must silently fall back to
    // session/new and continue initializing rather than failing entirely.
    const adapter = new CopilotAdapter(proc as never, "test-session", {
      cwd: "/home/user",
      acpSessionId: "stale-acp-session-id",
    });

    await new Promise((r) => setTimeout(r, 50));
    // Respond to initialize
    stdout.push(JSON.stringify({ id: 1, jsonrpc: "2.0", result: {} }) + "\n");
    await new Promise((r) => setTimeout(r, 20));
    // Respond to session/load with an error (session not found)
    stdout.push(JSON.stringify({ id: 2, jsonrpc: "2.0", error: { code: -32001, message: "Resource not found: Session stale-acp-session-id not found" } }) + "\n");
    await new Promise((r) => setTimeout(r, 20));
    // Respond to the fallback session/new
    stdout.push(JSON.stringify({ id: 3, jsonrpc: "2.0", result: { sessionId: "new-acp-session-fallback" } }) + "\n");
    await new Promise((r) => setTimeout(r, 50));

    // Adapter must have recovered and assigned the new session ID
    expect(adapter.getAcpSessionId()).toBe("new-acp-session-fallback");

    const lines = parseNdjsonLines(stdin.chunks) as Array<Record<string, unknown>>;
    // Must have sent session/load first, then session/new as fallback
    expect(lines.find((l) => l.method === "session/load")).toBeDefined();
    expect(lines.find((l) => l.method === "session/new")).toBeDefined();
  });



  it("sends session/prompt when receiving a user_message", async () => {
    // User messages from the browser must be translated to session/prompt JSON-RPC calls.
    // The prompt must include the user's text wrapped in a {type:"text"} block.
    const adapter = new CopilotAdapter(proc as never, "test-session", { cwd: "/project" });

    await completeInit(stdout);

    stdin.chunks = [];

    adapter.sendBrowserMessage({ type: "user_message", content: "Hello, copilot!" });

    await new Promise((r) => setTimeout(r, 50));

    const lines = parseNdjsonLines(stdin.chunks) as Array<Record<string, unknown>>;
    const promptReq = lines.find((l) => l.method === "session/prompt");
    expect(promptReq).toBeDefined();
    expect(promptReq!.id).toBe(3);

    const params = promptReq!.params as Record<string, unknown>;
    expect(params.sessionId).toBe("acp-sess-1");
    expect(params.cwd).toBe("/project");

    const prompt = params.prompt as Array<{ type: string; text?: string }>;
    expect(Array.isArray(prompt)).toBe(true);
    const textBlock = prompt.find((b) => b.type === "text");
    expect(textBlock).toBeDefined();
    expect(textBlock!.text).toBe("Hello, copilot!");
  });

  // ── Streaming text ────────────────────────────────────────────────────────

  it("translates agent_message_chunk notification to text_delta stream_event", async () => {
    // ACP streaming text arrives as session/update notifications with sessionUpdate="agent_message_chunk".
    // These must be re-emitted as stream_event / content_block_delta / text_delta messages
    // so the browser can display live streaming text.
    const messages: BrowserIncomingMessage[] = [];
    const adapter = new CopilotAdapter(proc as never, "test-session", { cwd: "/tmp" });
    adapter.onBrowserMessage((msg) => messages.push(msg));

    await completeInit(stdout);

    // Push a streaming text notification (no id → it's a notification, not a response)
    stdout.push(JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "Hello from Copilot" },
        },
      },
    }) + "\n");

    await new Promise((r) => setTimeout(r, 50));

    const deltas = messages.filter(
      (m) =>
        m.type === "stream_event" &&
        (m as { event: { type: string } }).event?.type === "content_block_delta",
    );
    expect(deltas.length).toBeGreaterThanOrEqual(1);

    const delta = deltas[0] as { event: { delta: { type: string; text: string } } };
    expect(delta.event.delta.type).toBe("text_delta");
    expect(delta.event.delta.text).toBe("Hello from Copilot");
  });

  it("accumulates text chunks and emits assembled assistant message on end_turn", async () => {
    // When session/prompt resolves, the adapter should emit an assistant message
    // containing all accumulated text chunks joined together.
    const messages: BrowserIncomingMessage[] = [];
    const adapter = new CopilotAdapter(proc as never, "test-session", { cwd: "/tmp" });
    adapter.onBrowserMessage((msg) => messages.push(msg));

    await completeInit(stdout);

    // Send user message to start a prompt turn
    adapter.sendBrowserMessage({ type: "user_message", content: "Tell me something" });
    await new Promise((r) => setTimeout(r, 20));

    // Push two text chunk notifications mid-flight
    stdout.push(JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hello " } } },
    }) + "\n");

    stdout.push(JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "world!" } } },
    }) + "\n");

    await new Promise((r) => setTimeout(r, 20));

    // Resolve session/prompt (id:3) → stop_reason end_turn
    stdout.push(JSON.stringify({ id: 3, result: { stopReason: "end_turn" } }) + "\n");
    await new Promise((r) => setTimeout(r, 50));

    // The assembled assistant message must concatenate all chunks
    const assistantMsgs = messages.filter((m) => m.type === "assistant") as Array<{
      message: { content: Array<{ type: string; text?: string }>; stop_reason: string | null };
    }>;
    const finalMsg = assistantMsgs.find((m) => m.message.stop_reason === "end_turn");
    expect(finalMsg).toBeDefined();

    const textBlock = finalMsg!.message.content.find((b) => b.type === "text");
    expect(textBlock).toBeDefined();
    expect(textBlock!.text).toBe("Hello world!");
  });

  // ── Thinking chunks ───────────────────────────────────────────────────────

  it("translates agent_thought_chunk notification to thinking_delta stream_event", async () => {
    // Copilot extended-thinking chunks arrive with sessionUpdate="agent_thought_chunk".
    // These must be mapped to thinking_delta stream events so the browser can render them.
    const messages: BrowserIncomingMessage[] = [];
    const adapter = new CopilotAdapter(proc as never, "test-session", { cwd: "/tmp" });
    adapter.onBrowserMessage((msg) => messages.push(msg));

    await completeInit(stdout);

    stdout.push(JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        update: {
          sessionUpdate: "agent_thought_chunk",
          content: { type: "text", text: "Let me think about this..." },
        },
      },
    }) + "\n");

    await new Promise((r) => setTimeout(r, 50));

    const thinkingDeltas = messages.filter(
      (m) =>
        m.type === "stream_event" &&
        (m as { event: { type: string } }).event?.type === "content_block_delta" &&
        (m as { event: { delta: { type: string } } }).event.delta?.type === "thinking_delta",
    );
    expect(thinkingDeltas.length).toBeGreaterThanOrEqual(1);

    const delta = thinkingDeltas[0] as { event: { delta: { type: string; thinking: string } } };
    expect(delta.event.delta.thinking).toBe("Let me think about this...");
  });

  it("includes thinking block in assembled assistant message after end_turn", async () => {
    // Thinking content must be assembled into a {type:"thinking"} block in the final
    // assistant message so the UI can collapse/expand it.
    const messages: BrowserIncomingMessage[] = [];
    const adapter = new CopilotAdapter(proc as never, "test-session", { cwd: "/tmp" });
    adapter.onBrowserMessage((msg) => messages.push(msg));

    await completeInit(stdout);

    adapter.sendBrowserMessage({ type: "user_message", content: "Think!" });
    await new Promise((r) => setTimeout(r, 20));

    stdout.push(JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: { update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Deep thought." } } },
    }) + "\n");
    stdout.push(JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Answer." } } },
    }) + "\n");
    await new Promise((r) => setTimeout(r, 20));

    // Resolve prompt
    stdout.push(JSON.stringify({ id: 3, result: { stopReason: "end_turn" } }) + "\n");
    await new Promise((r) => setTimeout(r, 50));

    const assistantMsgs = messages.filter((m) => m.type === "assistant") as Array<{
      message: { content: Array<{ type: string; thinking?: string; text?: string }>; stop_reason: string | null };
    }>;
    const finalMsg = assistantMsgs.find((m) => m.message.stop_reason === "end_turn");
    expect(finalMsg).toBeDefined();

    const thinkingBlock = finalMsg!.message.content.find((b) => b.type === "thinking");
    expect(thinkingBlock).toBeDefined();
    expect(thinkingBlock!.thinking).toBe("Deep thought.");

    const textBlock = finalMsg!.message.content.find((b) => b.type === "text");
    expect(textBlock).toBeDefined();
    expect(textBlock!.text).toBe("Answer.");
  });

  // ── Tool call ─────────────────────────────────────────────────────────────

  it("emits tool_progress and assistant tool_use on tool_call notification", async () => {
    // ACP tool_call notifications signal that the CLI started running a tool.
    // The adapter must emit:
    //   1. tool_progress — so the browser shows the spinner with elapsed time
    //   2. assistant message with tool_use block — so the message feed shows the invocation
    const messages: BrowserIncomingMessage[] = [];
    const adapter = new CopilotAdapter(proc as never, "test-session", { cwd: "/tmp" });
    adapter.onBrowserMessage((msg) => messages.push(msg));

    await completeInit(stdout);

    stdout.push(JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "tc1",
          title: "Bash",
          kind: "shell",
          status: "pending",
          rawInput: { command: "ls -la" },
        },
      },
    }) + "\n");

    await new Promise((r) => setTimeout(r, 50));

    // tool_progress must be present
    const toolProgress = messages.filter((m) => m.type === "tool_progress") as Array<{
      tool_use_id: string;
      tool_name: string;
    }>;
    expect(toolProgress.length).toBeGreaterThanOrEqual(1);
    expect(toolProgress[0].tool_use_id).toBe("tc1");
    expect(toolProgress[0].tool_name).toBe("Bash");

    // assistant message with tool_use block must be present
    const assistantMsgs = messages.filter((m) => m.type === "assistant") as Array<{
      message: { content: Array<{ type: string; id?: string; name?: string; input?: Record<string, unknown> }> };
    }>;
    const toolUseMsg = assistantMsgs.find((m) =>
      m.message.content.some((b) => b.type === "tool_use" && b.name === "Bash"),
    );
    expect(toolUseMsg).toBeDefined();

    const toolBlock = toolUseMsg!.message.content.find((b) => b.type === "tool_use");
    expect(toolBlock!.id).toBe("tc1");
    expect((toolBlock!.input as { command: string }).command).toBe("ls -la");
  });

  // ── Tool call update ──────────────────────────────────────────────────────

  it("emits assistant tool_result on tool_call_update with toolResultContent", async () => {
    // ACP tool_call_update notifies the adapter that a tool run is complete.
    // The adapter must emit an assistant message with a tool_result block so
    // the UI can show the output beneath the tool_use block.
    const messages: BrowserIncomingMessage[] = [];
    const adapter = new CopilotAdapter(proc as never, "test-session", { cwd: "/tmp" });
    adapter.onBrowserMessage((msg) => messages.push(msg));

    await completeInit(stdout);

    // First emit a tool_call so the adapter tracks the entry
    stdout.push(JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "tc1",
          title: "Bash",
          kind: "shell",
          status: "pending",
          rawInput: { command: "ls" },
        },
      },
    }) + "\n");
    await new Promise((r) => setTimeout(r, 20));

    // Now emit tool_call_update with the completed result
    stdout.push(JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "tc1",
          status: "completed",
          toolResultContent: [
            { type: "content", content: { type: "text", text: "file1.txt\nfile2.txt" } },
          ],
          rawOutput: { content: "file1.txt\nfile2.txt" },
        },
      },
    }) + "\n");
    await new Promise((r) => setTimeout(r, 50));

    const toolResultMsgs = messages.filter((m) => {
      if (m.type !== "assistant") return false;
      const content = (m as { message: { content: Array<{ type: string }> } }).message.content;
      return content.some((b) => b.type === "tool_result");
    }) as Array<{
      message: { content: Array<{ type: string; tool_use_id?: string; content?: string; is_error?: boolean }> };
    }>;

    expect(toolResultMsgs.length).toBeGreaterThanOrEqual(1);
    const resultBlock = toolResultMsgs[0].message.content.find((b) => b.type === "tool_result");
    expect(resultBlock).toBeDefined();
    expect(resultBlock!.tool_use_id).toBe("tc1");
    expect(resultBlock!.content).toContain("file1.txt");
    expect(resultBlock!.is_error).toBe(false);
  });

  it("emits tool_result with is_error=true when tool_call_update status is failed", async () => {
    // Failed tool runs (status "failed" or "declined") must have is_error=true so the
    // browser can display them with an error indicator.
    const messages: BrowserIncomingMessage[] = [];
    const adapter = new CopilotAdapter(proc as never, "test-session", { cwd: "/tmp" });
    adapter.onBrowserMessage((msg) => messages.push(msg));

    await completeInit(stdout);

    stdout.push(JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "tc-fail",
          title: "Bash",
          kind: "shell",
          status: "pending",
          rawInput: { command: "rm -rf /" },
        },
      },
    }) + "\n");
    await new Promise((r) => setTimeout(r, 20));

    stdout.push(JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "tc-fail",
          status: "failed",
          toolResultContent: [],
          rawOutput: { content: "Permission denied" },
        },
      },
    }) + "\n");
    await new Promise((r) => setTimeout(r, 50));

    const resultMsgs = messages.filter((m) => {
      if (m.type !== "assistant") return false;
      const content = (m as { message: { content: Array<{ type: string }> } }).message.content;
      return content.some((b) => b.type === "tool_result");
    }) as Array<{
      message: { content: Array<{ type: string; is_error?: boolean }> };
    }>;

    expect(resultMsgs.length).toBeGreaterThanOrEqual(1);
    const resultBlock = resultMsgs[0].message.content.find((b) => b.type === "tool_result");
    expect(resultBlock!.is_error).toBe(true);
  });

  // ── End of turn ───────────────────────────────────────────────────────────

  it("emits result message with stop_reason end_turn when session/prompt resolves", async () => {
    // When session/prompt completes, a result message must be emitted to signal
    // the end of the turn to the browser. This lets the UI hide the streaming indicator.
    const messages: BrowserIncomingMessage[] = [];
    const adapter = new CopilotAdapter(proc as never, "test-session", { cwd: "/tmp" });
    adapter.onBrowserMessage((msg) => messages.push(msg));

    await completeInit(stdout);

    adapter.sendBrowserMessage({ type: "user_message", content: "What is 2+2?" });
    await new Promise((r) => setTimeout(r, 20));

    stdout.push(JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "4" } } },
    }) + "\n");
    await new Promise((r) => setTimeout(r, 20));

    // Resolve session/prompt
    stdout.push(JSON.stringify({ id: 3, result: { stopReason: "end_turn" } }) + "\n");
    await new Promise((r) => setTimeout(r, 50));

    const resultMsgs = messages.filter((m) => m.type === "result") as Array<{
      data: { subtype: string; is_error: boolean; stop_reason: string };
    }>;
    expect(resultMsgs.length).toBe(1);
    expect(resultMsgs[0].data.subtype).toBe("success");
    expect(resultMsgs[0].data.is_error).toBe(false);
    expect(resultMsgs[0].data.stop_reason).toBe("end_turn");
  });

  it("emits status_change running/idle around a session/prompt turn", async () => {
    // The adapter must signal status changes so the browser can show/hide the
    // "thinking" indicator correctly.
    const messages: BrowserIncomingMessage[] = [];
    const adapter = new CopilotAdapter(proc as never, "test-session", { cwd: "/tmp" });
    adapter.onBrowserMessage((msg) => messages.push(msg));

    await completeInit(stdout);

    adapter.sendBrowserMessage({ type: "user_message", content: "Go" });
    await new Promise((r) => setTimeout(r, 20));

    // Resolve prompt immediately
    stdout.push(JSON.stringify({ id: 3, result: { stopReason: "end_turn" } }) + "\n");
    await new Promise((r) => setTimeout(r, 50));

    const statusChanges = messages.filter((m) => m.type === "status_change") as Array<{
      status: string | null;
    }>;
    const running = statusChanges.find((m) => m.status === "running");
    const idle = statusChanges.find((m) => m.status === "idle");
    expect(running).toBeDefined();
    expect(idle).toBeDefined();
  });

  // ── Queued messages ───────────────────────────────────────────────────────

  it("queues user_message before init completes and flushes it afterwards", async () => {
    // The adapter is constructed before the ACP handshake finishes.
    // Any user_message sent before initialization must be queued (not dropped)
    // and dispatched once session/new succeeds.
    const adapter = new CopilotAdapter(proc as never, "test-session", { cwd: "/tmp" });

    await new Promise((r) => setTimeout(r, 20));

    // Send message before init completes — should be accepted (returns true) but queued
    const accepted = adapter.sendBrowserMessage({ type: "user_message", content: "Early message" });
    expect(accepted).toBe(true);

    // Now complete initialization
    stdout.push(JSON.stringify({ id: 1, jsonrpc: "2.0", result: {} }) + "\n");
    await new Promise((r) => setTimeout(r, 20));
    stdout.push(JSON.stringify({ id: 2, result: { sessionId: "acp-sess-1" } }) + "\n");
    await new Promise((r) => setTimeout(r, 50));

    // The queued message should now have been sent as session/prompt
    const lines = parseNdjsonLines(stdin.chunks) as Array<Record<string, unknown>>;
    const promptReq = lines.find((l) => l.method === "session/prompt");
    expect(promptReq).toBeDefined();
    const params = promptReq!.params as Record<string, unknown>;
    const prompt = params.prompt as Array<{ type: string; text?: string }>;
    expect(prompt[0].text).toBe("Early message");
  });

  // ── Interrupt → process kill ──────────────────────────────────────────────

  it("calls proc.kill when receiving an interrupt message", async () => {
    // ACP has no interrupt protocol method. The adapter must kill the process directly
    // and rely on the WsBridge relaunch mechanism to restart it.
    const adapter = new CopilotAdapter(proc as never, "test-session", { cwd: "/tmp" });

    await completeInit(stdout);

    adapter.sendBrowserMessage({ type: "interrupt" });

    await new Promise((r) => setTimeout(r, 20));

    expect(proc.kill).toHaveBeenCalledWith("SIGTERM");
  });

  // ── Init failure ──────────────────────────────────────────────────────────

  it("calls onInitError when initialize response contains an error", async () => {
    // If the ACP initialize handshake fails (e.g. version mismatch), the adapter
    // must call onInitError with the error message so WsBridge can surface it to the UI.
    const errors: string[] = [];
    const adapter = new CopilotAdapter(proc as never, "test-session", {});
    adapter.onInitError((err) => errors.push(err));

    await new Promise((r) => setTimeout(r, 50));

    // Send an error response to the initialize request
    stdout.push(
      JSON.stringify({ id: 1, jsonrpc: "2.0", error: { code: -32603, message: "fail" } }) + "\n",
    );

    await new Promise((r) => setTimeout(r, 100));

    expect(errors.length).toBe(1);
    expect(errors[0]).toContain("fail");
  });

  it("returns false from sendBrowserMessage after init failure", async () => {
    // After initialization fails, sendBrowserMessage must return false for all
    // message types so WsBridge knows the adapter is non-functional.
    const adapter = new CopilotAdapter(proc as never, "test-session", {});

    await new Promise((r) => setTimeout(r, 50));

    // Fail initialize
    stdout.push(
      JSON.stringify({ id: 1, jsonrpc: "2.0", error: { code: -32603, message: "fail" } }) + "\n",
    );

    await new Promise((r) => setTimeout(r, 100));

    expect(adapter.sendBrowserMessage({ type: "user_message", content: "hello" })).toBe(false);
    expect(adapter.sendBrowserMessage({ type: "interrupt" })).toBe(false);
  });

  it("queues user_message before init, accepts it, but discards it on init failure", async () => {
    // A message queued before init completes is accepted optimistically.
    // If init then fails, it must be silently dropped — the adapter must not
    // process messages for a broken session.
    const messages: BrowserIncomingMessage[] = [];
    const adapter = new CopilotAdapter(proc as never, "test-session", {});
    adapter.onBrowserMessage((msg) => messages.push(msg));

    await new Promise((r) => setTimeout(r, 20));

    // Queue a message — returns true because init hasn't failed yet
    const accepted = adapter.sendBrowserMessage({ type: "user_message", content: "will be dropped" });
    expect(accepted).toBe(true);

    // Fail initialization
    stdout.push(
      JSON.stringify({ id: 1, jsonrpc: "2.0", error: { code: -32603, message: "fail" } }) + "\n",
    );
    await new Promise((r) => setTimeout(r, 100));

    // No session/prompt should have been sent for the queued message
    const lines = parseNdjsonLines(stdin.chunks) as Array<Record<string, unknown>>;
    expect(lines.find((l) => l.method === "session/prompt")).toBeUndefined();

    // Subsequent sends must be rejected
    expect(adapter.sendBrowserMessage({ type: "user_message", content: "also rejected" })).toBe(false);
  });

  // ── Process exit → disconnect ─────────────────────────────────────────────

  it("fires onDisconnect when the process exits", async () => {
    // When the Copilot process terminates (crash or planned shutdown), the adapter
    // must call onDisconnect so WsBridge can clean up and potentially relaunch the process.
    const disconnects: number[] = [];
    const adapter = new CopilotAdapter(proc as never, "test-session", {});
    adapter.onDisconnect(() => disconnects.push(1));

    await completeInit(stdout);

    // Resolve the exit promise (simulates process termination)
    resolveExit(0);

    await new Promise((r) => setTimeout(r, 50));

    expect(disconnects.length).toBe(1);
  });

  // ── isConnected ────────────────────────────────────────────────────────────

  it("reports isConnected=true after successful init and false after process exit", async () => {
    // isConnected() is polled by WsBridge to decide whether to relaunch.
    const adapter = new CopilotAdapter(proc as never, "test-session", {});

    // Not connected before init completes
    expect(adapter.isConnected()).toBe(false);

    await completeInit(stdout);

    expect(adapter.isConnected()).toBe(true);

    resolveExit(0);
    await new Promise((r) => setTimeout(r, 50));

    expect(adapter.isConnected()).toBe(false);
  });

  // ── Ignored session/update notifications ─────────────────────────────────

  it("ignores unknown sessionUpdate types without throwing", async () => {
    // The ACP spec may add new sessionUpdate types in future; the adapter must
    // gracefully ignore unknown values rather than throwing.
    const messages: BrowserIncomingMessage[] = [];
    const adapter = new CopilotAdapter(proc as never, "test-session", { cwd: "/tmp" });
    adapter.onBrowserMessage((msg) => messages.push(msg));

    await completeInit(stdout);

    expect(() => {
      stdout.push(JSON.stringify({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          update: { sessionUpdate: "some_future_event", data: {} },
        },
      }) + "\n");
    }).not.toThrow();

    await new Promise((r) => setTimeout(r, 30));
    // No crash, no unexpected messages emitted for the unknown update type
  });

  it("ignores non-session/update notification methods without throwing", async () => {
    // Other JSON-RPC notification methods (e.g. progress pings) must be ignored silently.
    const messages: BrowserIncomingMessage[] = [];
    const adapter = new CopilotAdapter(proc as never, "test-session", { cwd: "/tmp" });
    adapter.onBrowserMessage((msg) => messages.push(msg));

    await completeInit(stdout);

    expect(() => {
      stdout.push(JSON.stringify({
        jsonrpc: "2.0",
        method: "$/progress",
        params: { token: 1, value: { kind: "report", percentage: 50 } },
      }) + "\n");
    }).not.toThrow();

    await new Promise((r) => setTimeout(r, 30));
  });

  // ── getAcpSessionId ───────────────────────────────────────────────────────

  it("returns null from getAcpSessionId before init completes", async () => {
    // Before session/new resolves, there is no ACP session ID yet.
    const adapter = new CopilotAdapter(proc as never, "test-session", {});
    expect(adapter.getAcpSessionId()).toBeNull();
  });

  it("returns the ACP session ID from getAcpSessionId after session/new", async () => {
    // After init, getAcpSessionId must return the server-assigned session ID.
    const adapter = new CopilotAdapter(proc as never, "test-session", {});

    await completeInit(stdout, "acp-sess-xyz");

    expect(adapter.getAcpSessionId()).toBe("acp-sess-xyz");
  });

  // ── session/prompt error handling ─────────────────────────────────────────

  it("emits error browser message when session/prompt fails", async () => {
    // If session/prompt returns a JSON-RPC error (e.g. rate limit), the adapter must
    // surface it as an error browser message so the UI can display it.
    const messages: BrowserIncomingMessage[] = [];
    const adapter = new CopilotAdapter(proc as never, "test-session", { cwd: "/tmp" });
    adapter.onBrowserMessage((msg) => messages.push(msg));

    await completeInit(stdout);

    adapter.sendBrowserMessage({ type: "user_message", content: "Trigger error" });
    await new Promise((r) => setTimeout(r, 20));

    // Respond with an error to session/prompt (id:3)
    stdout.push(JSON.stringify({
      id: 3,
      jsonrpc: "2.0",
      error: { code: -32000, message: "rate limit exceeded" },
    }) + "\n");
    await new Promise((r) => setTimeout(r, 50));

    const errorMsgs = messages.filter((m) => m.type === "error") as Array<{ message: string }>;
    expect(errorMsgs.length).toBeGreaterThanOrEqual(1);
    expect(errorMsgs[0].message).toContain("rate limit exceeded");
  });

  // ── rawOutput fallback in tool_call_update ────────────────────────────────

  it("falls back to rawOutput.content when toolResultContent is empty", async () => {
    // If toolResultContent is empty but rawOutput.content is present, the adapter
    // must use rawOutput.content as the tool result text. This covers the case where
    // the ACP server does not populate the typed content array.
    const messages: BrowserIncomingMessage[] = [];
    const adapter = new CopilotAdapter(proc as never, "test-session", { cwd: "/tmp" });
    adapter.onBrowserMessage((msg) => messages.push(msg));

    await completeInit(stdout);

    stdout.push(JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "tc-raw",
          title: "Bash",
          kind: "shell",
          status: "pending",
          rawInput: { command: "echo hi" },
        },
      },
    }) + "\n");
    await new Promise((r) => setTimeout(r, 20));

    stdout.push(JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "tc-raw",
          status: "completed",
          toolResultContent: [],
          rawOutput: { content: "hi" },
        },
      },
    }) + "\n");
    await new Promise((r) => setTimeout(r, 50));

    const resultMsgs = messages.filter((m) => {
      if (m.type !== "assistant") return false;
      const content = (m as { message: { content: Array<{ type: string }> } }).message.content;
      return content.some((b) => b.type === "tool_result");
    }) as Array<{
      message: { content: Array<{ type: string; content?: string }> };
    }>;

    expect(resultMsgs.length).toBeGreaterThanOrEqual(1);
    const resultBlock = resultMsgs[0].message.content.find((b) => b.type === "tool_result");
    expect(resultBlock!.content).toBe("hi");
  });
});
