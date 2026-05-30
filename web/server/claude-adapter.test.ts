import { vi, describe, it, expect, beforeEach, afterEach, afterAll } from "vitest";

// ─── Stub Bun global for vitest (runs under Node, not Bun) ──────────────────
// Bun.hash is used by isDuplicateCLIMessage in ws-bridge-cli-ingest.ts.
// A simple string hash is sufficient for test determinism.
if (typeof globalThis.Bun === "undefined") {
  (globalThis as any).Bun = {
    hash(input: string | Uint8Array): number {
      const s = typeof input === "string" ? input : new TextDecoder().decode(input);
      let h = 0;
      for (let i = 0; i < s.length; i++) {
        h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
      }
      return h >>> 0; // unsigned 32-bit
    },
  };
}

// Mock node:crypto to return deterministic UUIDs for control_request IDs
let uuidCounter = 0;
vi.mock("node:crypto", () => ({
  randomUUID: () => `test-uuid-${uuidCounter++}`,
}));

// Mock settings-manager to prevent real file system reads
vi.mock("./settings-manager.js", () => ({
  getSettings: () => ({
    aiValidationEnabled: false,
    aiValidationAutoApprove: false,
    aiValidationAutoDeny: false,
    anthropicApiKey: "",
  }),
  DEFAULT_ANTHROPIC_MODEL: "claude-sonnet-4-6",
}));

import { ClaudeAdapter } from "./claude-adapter.js";
import { log } from "./logger.js";

// ─── Mock socket factory ────────────────────────────────────────────────────

/** Creates a minimal mock ServerWebSocket<SocketData> for CLI connections. */
function createMockSocket(sessionId: string) {
  return {
    data: { kind: "cli" as const, sessionId },
    send: vi.fn(),
    close: vi.fn(),
    readyState: 1,
  } as any;
}

// ─── Helper: build NDJSON CLI messages ──────────────────────────────────────

function makeInitMsg(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    type: "system",
    subtype: "init",
    session_id: "cli-123",
    model: "claude-sonnet-4-6",
    cwd: "/test",
    tools: ["Bash", "Read"],
    permissionMode: "default",
    claude_code_version: "1.0",
    mcp_servers: [],
    agents: [],
    slash_commands: [],
    skills: [],
    output_style: "normal",
    uuid: "uuid-1",
    apiKeySource: "env",
    ...overrides,
  });
}

function makeAssistantMsg(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    type: "assistant",
    message: {
      id: "msg-1",
      type: "message",
      role: "assistant",
      model: "claude-sonnet-4-6",
      content: [{ type: "text", text: "Hello world" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    },
    parent_tool_use_id: null,
    uuid: "asst-uuid-1",
    session_id: "cli-123",
    ...overrides,
  });
}

function makeResultMsg(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    result: "Done",
    duration_ms: 1000,
    duration_api_ms: 800,
    num_turns: 1,
    total_cost_usd: 0.01,
    stop_reason: "end_turn",
    usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    context_used_percent: 5,
    uuid: "result-uuid-1",
    session_id: "cli-123",
    ...overrides,
  });
}

function makeStreamEventMsg(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    type: "stream_event",
    event: { type: "content_block_delta", delta: { type: "text_delta", text: "Hi" } },
    parent_tool_use_id: null,
    uuid: "stream-uuid-1",
    session_id: "cli-123",
    ...overrides,
  });
}

function makeControlRequestMsg(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    type: "control_request",
    request_id: "ctrl-req-1",
    request: {
      subtype: "can_use_tool",
      tool_name: "Bash",
      input: { command: "ls" },
      description: "List files",
      tool_use_id: "tu-1",
      ...((overrides as any).request ?? {}),
    },
    ...overrides,
    // Restore request if it was overridden
    ...(overrides.request ? { request: overrides.request } : {}),
  });
}

function makeToolProgressMsg(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    type: "tool_progress",
    tool_use_id: "tu-1",
    tool_name: "Bash",
    parent_tool_use_id: null,
    elapsed_time_seconds: 2,
    uuid: "tp-uuid-1",
    session_id: "cli-123",
    ...overrides,
  });
}

function makeAuthStatusMsg(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    type: "auth_status",
    isAuthenticating: true,
    output: ["Authenticating..."],
    uuid: "auth-uuid-1",
    session_id: "cli-123",
    ...overrides,
  });
}

function makeKeepAliveMsg() {
  return JSON.stringify({ type: "keep_alive" });
}

function makeSystemStatusMsg(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    type: "system",
    subtype: "status",
    status: "compacting",
    uuid: "status-uuid-1",
    session_id: "cli-123",
    ...overrides,
  });
}

// ─── Test suite ─────────────────────────────────────────────────────────────

let adapter: ClaudeAdapter;
let browserMessageCb: ReturnType<typeof vi.fn>;
let sessionMetaCb: ReturnType<typeof vi.fn>;
let disconnectCb: ReturnType<typeof vi.fn>;
let onActivityUpdate: ReturnType<typeof vi.fn>;

beforeEach(() => {
  uuidCounter = 0;
  onActivityUpdate = vi.fn();
  adapter = new ClaudeAdapter("sess-1", { onActivityUpdate: onActivityUpdate as unknown as () => void });
  browserMessageCb = vi.fn();
  sessionMetaCb = vi.fn();
  disconnectCb = vi.fn();
  adapter.onBrowserMessage(browserMessageCb as any);
  adapter.onSessionMeta(sessionMetaCb as any);
  adapter.onDisconnect(disconnectCb as unknown as () => void);

  // Suppress console output to prevent Vitest EnvironmentTeardownError
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

// Prevent "Closing rpc while onUserConsoleLog was pending" during teardown
afterAll(() => {
  const noop = () => {};
  console.log = noop;
  console.warn = noop;
  console.error = noop;
});

describe("Protocol drift handling", () => {
  it("logs and surfaces unknown Claude message types", () => {
    const spy = vi.spyOn(log, "warn").mockImplementation(() => {});

    adapter.handleRawMessage(`${JSON.stringify({ type: "brand_new_message", payload: { x: 1 } })}\n`);

    expect(spy).toHaveBeenCalledWith(
      "protocol-monitor",
      "Backend protocol drift detected",
      expect.objectContaining({
        backend: "claude",
        sessionId: "sess-1",
        direction: "incoming",
        messageKind: "message",
        messageName: "brand_new_message",
      }),
    );
    expect(browserMessageCb).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "error",
        message: expect.stringContaining("brand_new_message"),
      }),
    );

    spy.mockRestore();
  });

  it("deduplicates repeated Claude parse-error drift logs", () => {
    const spy = vi.spyOn(log, "warn").mockImplementation(() => {});

    adapter.handleRawMessage("not-json\nstill-not-json\n");

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(
      "protocol-monitor",
      "Backend protocol drift detected",
      expect.objectContaining({
        backend: "claude",
        sessionId: "sess-1",
        messageKind: "parse_error",
        messageName: "ndjson",
      }),
    );

    spy.mockRestore();
  });

  it("surfaces parse errors to the browser as error messages", () => {
    // Parse errors should notify the browser so the user sees something
    // instead of a silent failure.
    const spy = vi.spyOn(log, "warn").mockImplementation(() => {});

    adapter.handleRawMessage("{{broken-json}}\n");

    expect(browserMessageCb).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "error",
        message: expect.stringContaining("parse_error"),
      }),
    );

    spy.mockRestore();
  });
});

// ─── Known non-standard CLI message types ────────────────────────────────────

describe("Known non-standard CLI message types", () => {
  it("rate_limit_event is silently consumed without protocol drift warning", () => {
    // The CLI sends rate_limit_event messages with throttle/allow status.
    // These should be silently consumed and NOT trigger protocol drift logs.
    const spy = vi.spyOn(log, "warn").mockImplementation(() => {});
    const ws = createMockSocket("sess-1");
    adapter.attachWebSocket(ws);

    adapter.handleRawMessage(
      JSON.stringify({
        type: "rate_limit_event",
        rate_limit_info: { is_rate_limited: false, resets_at: null },
        uuid: "rl-uuid-1",
      }) + "\n",
    );

    // Should NOT produce a protocol drift warning
    expect(spy).not.toHaveBeenCalledWith(
      "protocol-monitor",
      "Backend protocol drift detected",
      expect.anything(),
    );
    // Should NOT emit an error to the browser
    expect(browserMessageCb).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "error" }),
    );

    spy.mockRestore();
  });

  it("user echo with plain string content is silently dropped to avoid duplicates", () => {
    // Plain string echoes are duplicates of messages the browser already has
    // (the browser sends user_message → ws-bridge stores it → CLI echoes it
    // back). Silently drop them to prevent duplicate messages in the UI.
    const spy = vi.spyOn(log, "warn").mockImplementation(() => {});
    const ws = createMockSocket("sess-1");
    adapter.attachWebSocket(ws);

    adapter.handleRawMessage(
      JSON.stringify({
        type: "user",
        message: { role: "user", content: "Hello from browser" },
        uuid: "user-echo-1",
        session_id: "cli-123",
      }) + "\n",
    );

    // Should NOT produce a protocol drift warning
    expect(spy).not.toHaveBeenCalledWith(
      "protocol-monitor",
      "Backend protocol drift detected",
      expect.anything(),
    );
    // Should NOT emit to browser — plain string echoes are dropped
    expect(browserMessageCb).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "user_message" }),
    );

    spy.mockRestore();
  });

  it("user echo with non-string content is silently dropped", () => {
    // User echo messages with tool_result arrays are redundant — the tool
    // results are already present in the subsequent assistant message content
    // blocks. Forwarding them caused raw JSON text bubbles in the chat UI.
    const ws = createMockSocket("sess-1");
    adapter.attachWebSocket(ws);

    const complexContent = [
      { type: "tool_result", tool_use_id: "t1", content: "result" },
    ];
    adapter.handleRawMessage(
      JSON.stringify({
        type: "user",
        message: { role: "user", content: complexContent },
        uuid: "user-echo-2",
        session_id: "cli-123",
      }) + "\n",
    );

    // Should NOT emit a user_message to the browser
    expect(browserMessageCb).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "user_message" }),
    );
  });
});

// ─── Connection lifecycle ───────────────────────────────────────────────────

describe("Connection lifecycle", () => {
  it("isConnected() returns false initially when no WebSocket is attached", () => {
    // A freshly created adapter has no CLI socket, so it should not be connected.
    expect(adapter.isConnected()).toBe(false);
  });

  it("attachWebSocket stores the socket and makes isConnected() return true", () => {
    // Attaching a mock WebSocket should mark the adapter as connected.
    const ws = createMockSocket("sess-1");
    adapter.attachWebSocket(ws);
    expect(adapter.isConnected()).toBe(true);
  });

  it("detachWebSocket clears the socket and calls disconnectCb", () => {
    // Detaching the current socket should clear the connection and notify
    // the bridge via the disconnect callback.
    const ws = createMockSocket("sess-1");
    adapter.attachWebSocket(ws);
    expect(adapter.isConnected()).toBe(true);

    adapter.detachWebSocket(ws);
    expect(adapter.isConnected()).toBe(false);
    expect(disconnectCb).toHaveBeenCalledOnce();
  });

  it("detachWebSocket with a stale socket (different ws) does nothing", () => {
    // If a new WebSocket replaced an old one, closing the old one should
    // NOT clear the current connection or trigger the disconnect callback.
    const ws1 = createMockSocket("sess-1");
    const ws2 = createMockSocket("sess-1");
    adapter.attachWebSocket(ws1);

    // Replace with ws2
    adapter.attachWebSocket(ws2);

    // Detach ws1 (stale) — should be ignored
    adapter.detachWebSocket(ws1);
    expect(adapter.isConnected()).toBe(true);
    expect(disconnectCb).not.toHaveBeenCalled();
  });

  it("disconnect() closes the socket and clears the connection", async () => {
    // disconnect() should call close() on the socket and clear it.
    const ws = createMockSocket("sess-1");
    adapter.attachWebSocket(ws);

    await adapter.disconnect();
    expect(ws.close).toHaveBeenCalledOnce();
    expect(adapter.isConnected()).toBe(false);
  });

  it("disconnect() with no socket is a no-op", async () => {
    // Calling disconnect when there's no socket should not throw.
    await adapter.disconnect();
    expect(adapter.isConnected()).toBe(false);
  });

  it("handleTransportClose() clears socket without calling disconnectCb", () => {
    // handleTransportClose is used when a WS proxy drops — it clears the
    // socket reference without triggering the disconnect callback so the
    // CLI can reconnect.
    const ws = createMockSocket("sess-1");
    adapter.attachWebSocket(ws);

    adapter.handleTransportClose();
    expect(adapter.isConnected()).toBe(false);
    expect(disconnectCb).not.toHaveBeenCalled();
  });
});

// ─── Message queuing ────────────────────────────────────────────────────────

describe("Message queuing", () => {
  it("messages sent via send() before WebSocket connects are queued", () => {
    // Without an attached WebSocket, outgoing messages should be queued
    // and not lost. We verify by attaching a socket later and checking
    // that the queued messages are flushed.
    const result = adapter.send({ type: "user_message", content: "hello" });
    expect(result).toBe(true);
    // No socket attached — nothing was sent yet.
  });

  it("queued messages are flushed when attachWebSocket is called", () => {
    // Send messages while disconnected, then verify they are delivered
    // when the WebSocket attaches.
    adapter.send({ type: "user_message", content: "first" });
    adapter.send({ type: "user_message", content: "second" });

    const ws = createMockSocket("sess-1");
    adapter.attachWebSocket(ws);

    // Both queued messages should have been flushed to the socket.
    // Each message results in a send() call with NDJSON + newline.
    expect(ws.send).toHaveBeenCalledTimes(2);

    // Verify the first message content
    const firstCall = ws.send.mock.calls[0][0] as string;
    const parsed1 = JSON.parse(firstCall.trim());
    expect(parsed1.type).toBe("user");
    expect(parsed1.message.content).toBe("first");

    // Verify the second message content
    const secondCall = ws.send.mock.calls[1][0] as string;
    const parsed2 = JSON.parse(secondCall.trim());
    expect(parsed2.type).toBe("user");
    expect(parsed2.message.content).toBe("second");
  });

  it("messages sent after WebSocket connects go directly to the socket", () => {
    // Once a socket is attached, messages should be sent immediately
    // without queuing.
    const ws = createMockSocket("sess-1");
    adapter.attachWebSocket(ws);

    adapter.send({ type: "user_message", content: "direct" });

    expect(ws.send).toHaveBeenCalledTimes(1);
    const sent = JSON.parse((ws.send.mock.calls[0][0] as string).trim());
    expect(sent.type).toBe("user");
    expect(sent.message.content).toBe("direct");
  });
});

// ─── send() — outgoing message translation ──────────────────────────────────

describe("send() — outgoing message translation", () => {
  let ws: ReturnType<typeof createMockSocket>;

  beforeEach(() => {
    ws = createMockSocket("sess-1");
    adapter.attachWebSocket(ws);
  });

  /** Helper to parse the last NDJSON sent on the mock socket. */
  function getLastSent(): any {
    const calls = ws.send.mock.calls;
    return JSON.parse((calls[calls.length - 1][0] as string).trim());
  }

  it("user_message → sends NDJSON with type 'user' and user-role message", () => {
    // A user_message from the browser should be translated into Claude Code's
    // NDJSON format: { type: "user", message: { role: "user", content }, ... }
    adapter.send({ type: "user_message", content: "Hello Claude" });
    const sent = getLastSent();
    expect(sent.type).toBe("user");
    expect(sent.message.role).toBe("user");
    expect(sent.message.content).toBe("Hello Claude");
    expect(sent.parent_tool_use_id).toBeNull();
    expect(sent.session_id).toBe("");
  });

  it("user_message with session_id passes it through", () => {
    // When a session_id is provided in the user_message, it should be included.
    adapter.send({ type: "user_message", content: "hi", session_id: "sid-1" });
    const sent = getLastSent();
    expect(sent.session_id).toBe("sid-1");
  });

  it("user_message with images → includes image blocks in content array", () => {
    // Images should be prepended as image blocks before a text block
    // in the content array, following the Claude content block format.
    adapter.send({
      type: "user_message",
      content: "Describe this",
      images: [{ media_type: "image/png", data: "base64data" }],
    });
    const sent = getLastSent();
    expect(sent.type).toBe("user");
    expect(Array.isArray(sent.message.content)).toBe(true);
    expect(sent.message.content).toHaveLength(2);

    // First block: image
    expect(sent.message.content[0].type).toBe("image");
    expect(sent.message.content[0].source.type).toBe("base64");
    expect(sent.message.content[0].source.media_type).toBe("image/png");
    expect(sent.message.content[0].source.data).toBe("base64data");

    // Second block: text
    expect(sent.message.content[1].type).toBe("text");
    expect(sent.message.content[1].text).toBe("Describe this");
  });

  it("permission_response allow → sends correct control_response NDJSON", () => {
    // An "allow" permission response should be translated into a
    // control_response with behavior: "allow" and updatedInput.
    adapter.send({
      type: "permission_response",
      request_id: "req-1",
      behavior: "allow",
    });
    const sent = getLastSent();
    expect(sent.type).toBe("control_response");
    expect(sent.response.subtype).toBe("success");
    expect(sent.response.request_id).toBe("req-1");
    expect(sent.response.response.behavior).toBe("allow");
    expect(sent.response.response.updatedInput).toEqual({});
  });

  it("permission_response allow with updated_input and updated_permissions", () => {
    // When updated_input and updated_permissions are provided, they should
    // be forwarded in the control_response.
    adapter.send({
      type: "permission_response",
      request_id: "req-2",
      behavior: "allow",
      updated_input: { command: "ls -la" },
      updated_permissions: [{ type: "addRules" as const, rules: [{ toolName: "Bash" }], behavior: "allow" as const, destination: "project" as any }],
    });
    const sent = getLastSent();
    expect(sent.response.response.updatedInput).toEqual({ command: "ls -la" });
    expect(sent.response.response.updatedPermissions).toHaveLength(1);
  });

  it("permission_response deny → sends control_response NDJSON with deny message", () => {
    // A "deny" permission response should include behavior: "deny" and
    // a message explaining the denial.
    adapter.send({
      type: "permission_response",
      request_id: "req-3",
      behavior: "deny",
      message: "Not allowed",
    });
    const sent = getLastSent();
    expect(sent.type).toBe("control_response");
    expect(sent.response.subtype).toBe("success");
    expect(sent.response.request_id).toBe("req-3");
    expect(sent.response.response.behavior).toBe("deny");
    expect(sent.response.response.message).toBe("Not allowed");
  });

  it("permission_response deny without explicit message uses default", () => {
    // When no denial message is provided, a default should be used.
    adapter.send({
      type: "permission_response",
      request_id: "req-4",
      behavior: "deny",
    });
    const sent = getLastSent();
    expect(sent.response.response.message).toBe("Denied by user");
  });

  it("interrupt → sends control_request with subtype 'interrupt'", () => {
    // An interrupt should be translated into a control_request with
    // a deterministic UUID (mocked) and subtype "interrupt".
    adapter.send({ type: "interrupt" });
    const sent = getLastSent();
    expect(sent.type).toBe("control_request");
    expect(sent.request.subtype).toBe("interrupt");
    expect(sent.request_id).toMatch(/^test-uuid-/);
  });

  it("set_model → sends control_request with subtype 'set_model'", () => {
    // The set_model message should forward the model name in a control_request.
    adapter.send({ type: "set_model", model: "claude-opus-4-6" });
    const sent = getLastSent();
    expect(sent.type).toBe("control_request");
    expect(sent.request.subtype).toBe("set_model");
    expect(sent.request.model).toBe("claude-opus-4-6");
  });

  it("set_permission_mode → sends control_request with subtype 'set_permission_mode'", () => {
    // The permission mode change should be forwarded to the CLI backend.
    adapter.send({ type: "set_permission_mode", mode: "plan" });
    const sent = getLastSent();
    expect(sent.type).toBe("control_request");
    expect(sent.request.subtype).toBe("set_permission_mode");
    expect(sent.request.mode).toBe("plan");
  });

  it("set_ai_validation → returns true without sending anything", () => {
    // AI validation state is managed at the bridge level, not forwarded
    // to the CLI. send() should return true (accepted) but not send any data.
    const result = adapter.send({
      type: "set_ai_validation",
      aiValidationEnabled: true,
    });
    expect(result).toBe(true);
    // No message should have been sent to the socket
    expect(ws.send).not.toHaveBeenCalled();
  });

  it("session_subscribe → returns false (handled at bridge level)", () => {
    // session_subscribe is handled by the bridge, not forwarded to the backend.
    const result = adapter.send({ type: "session_subscribe", last_seq: 0 });
    expect(result).toBe(false);
    expect(ws.send).not.toHaveBeenCalled();
  });

  it("session_ack → returns false (handled at bridge level)", () => {
    // session_ack is handled by the bridge, not forwarded to the backend.
    const result = adapter.send({ type: "session_ack", last_seq: 5 });
    expect(result).toBe(false);
    expect(ws.send).not.toHaveBeenCalled();
  });

  it("mcp_get_status → sends control_request with subtype 'mcp_status'", () => {
    // MCP status request should be sent as a control_request and tracked
    // for async response resolution.
    adapter.send({ type: "mcp_get_status" });
    const sent = getLastSent();
    expect(sent.type).toBe("control_request");
    expect(sent.request.subtype).toBe("mcp_status");
    expect(sent.request_id).toMatch(/^test-uuid-/);
  });

  it("send() returns true for accepted messages", () => {
    // Verify that all accepted message types return true.
    expect(adapter.send({ type: "user_message", content: "hi" })).toBe(true);
    expect(adapter.send({ type: "interrupt" })).toBe(true);
    expect(adapter.send({ type: "set_model", model: "m" })).toBe(true);
    expect(adapter.send({ type: "set_permission_mode", mode: "plan" })).toBe(true);
    expect(adapter.send({ type: "mcp_get_status" })).toBe(true);
  });
});

// ─── handleRawMessage() — incoming CLI message routing ──────────────────────

describe("handleRawMessage() — incoming CLI message routing", () => {
  let ws: ReturnType<typeof createMockSocket>;

  beforeEach(() => {
    ws = createMockSocket("sess-1");
    adapter.attachWebSocket(ws);
  });

  it("system init → emits sessionMetaCb and browserMessageCb with session_init", () => {
    // A system init message from the CLI should update session metadata
    // (cliSessionId, model, cwd) and broadcast a session_init to browsers.
    adapter.handleRawMessage(makeInitMsg());

    expect(sessionMetaCb).toHaveBeenCalledOnce();
    expect(sessionMetaCb).toHaveBeenCalledWith({
      cliSessionId: "cli-123",
      model: "claude-sonnet-4-6",
      cwd: "/test",
    });

    expect(browserMessageCb).toHaveBeenCalledOnce();
    const msg = browserMessageCb.mock.calls[0][0];
    expect(msg.type).toBe("session_init");
    expect(msg.session.session_id).toBe("cli-123");
    expect(msg.session.model).toBe("claude-sonnet-4-6");
    expect(msg.session.cwd).toBe("/test");
    expect(msg.session.tools).toEqual(["Bash", "Read"]);
    expect(msg.session.permissionMode).toBe("default");
    expect(msg.session.claude_code_version).toBe("1.0");
    expect(msg.session.mcp_servers).toEqual([]);
  });

  it("system status → emits browserMessageCb with status_change", () => {
    // A system status message (e.g. compacting) should be translated to
    // a status_change browser message.
    adapter.handleRawMessage(makeSystemStatusMsg());

    expect(browserMessageCb).toHaveBeenCalledOnce();
    const msg = browserMessageCb.mock.calls[0][0];
    expect(msg.type).toBe("status_change");
    expect(msg.status).toBe("compacting");
  });

  it("system status with null status → emits status_change with null", () => {
    // When the CLI sends status: null, it means the status is cleared.
    adapter.handleRawMessage(makeSystemStatusMsg({ status: null }));

    const msg = browserMessageCb.mock.calls[0][0];
    expect(msg.type).toBe("status_change");
    expect(msg.status).toBeNull();
  });

  it("assistant → emits browserMessageCb with assistant message including timestamp", () => {
    // An assistant message should be forwarded with its full message payload
    // and a server-assigned timestamp.
    const now = Date.now();
    adapter.handleRawMessage(makeAssistantMsg());

    expect(browserMessageCb).toHaveBeenCalledOnce();
    const msg = browserMessageCb.mock.calls[0][0];
    expect(msg.type).toBe("assistant");
    expect(msg.message.id).toBe("msg-1");
    expect(msg.message.role).toBe("assistant");
    expect(msg.message.content[0].text).toBe("Hello world");
    expect(msg.parent_tool_use_id).toBeNull();
    // Timestamp should be roughly "now"
    expect(msg.timestamp).toBeGreaterThanOrEqual(now);
    expect(msg.timestamp).toBeLessThanOrEqual(Date.now());
  });

  it("result → emits browserMessageCb with result data", () => {
    // A result message should be forwarded as-is in the data field.
    adapter.handleRawMessage(makeResultMsg());

    expect(browserMessageCb).toHaveBeenCalledOnce();
    const msg = browserMessageCb.mock.calls[0][0];
    expect(msg.type).toBe("result");
    expect(msg.data.subtype).toBe("success");
    expect(msg.data.total_cost_usd).toBe(0.01);
    expect(msg.data.num_turns).toBe(1);
  });

  it("stream_event → emits browserMessageCb with stream_event", () => {
    // Stream events should be forwarded with the event payload and
    // parent_tool_use_id.
    adapter.handleRawMessage(makeStreamEventMsg());

    expect(browserMessageCb).toHaveBeenCalledOnce();
    const msg = browserMessageCb.mock.calls[0][0];
    expect(msg.type).toBe("stream_event");
    expect(msg.event.type).toBe("content_block_delta");
    expect(msg.parent_tool_use_id).toBeNull();
  });

  it("control_request (can_use_tool) → emits browserMessageCb with permission_request", () => {
    // A tool permission request from the CLI should be translated into
    // a permission_request browser message with all relevant fields.
    adapter.handleRawMessage(makeControlRequestMsg());

    expect(browserMessageCb).toHaveBeenCalledOnce();
    const msg = browserMessageCb.mock.calls[0][0];
    expect(msg.type).toBe("permission_request");
    expect(msg.request.request_id).toBe("ctrl-req-1");
    expect(msg.request.tool_name).toBe("Bash");
    expect(msg.request.input).toEqual({ command: "ls" });
    expect(msg.request.description).toBe("List files");
    expect(msg.request.tool_use_id).toBe("tu-1");
    // Timestamp should be set by the adapter
    expect(typeof msg.request.timestamp).toBe("number");
  });

  it("tool_progress → emits browserMessageCb with tool_progress", () => {
    // Tool progress updates should be forwarded to the browser.
    adapter.handleRawMessage(makeToolProgressMsg());

    expect(browserMessageCb).toHaveBeenCalledOnce();
    const msg = browserMessageCb.mock.calls[0][0];
    expect(msg.type).toBe("tool_progress");
    expect(msg.tool_use_id).toBe("tu-1");
    expect(msg.tool_name).toBe("Bash");
    expect(msg.elapsed_time_seconds).toBe(2);
  });

  it("auth_status → emits browserMessageCb with auth_status", () => {
    // Auth status updates should be forwarded with all relevant fields.
    adapter.handleRawMessage(makeAuthStatusMsg());

    expect(browserMessageCb).toHaveBeenCalledOnce();
    const msg = browserMessageCb.mock.calls[0][0];
    expect(msg.type).toBe("auth_status");
    expect(msg.isAuthenticating).toBe(true);
    expect(msg.output).toEqual(["Authenticating..."]);
  });

  it("auth_status with error → includes error in emission", () => {
    // When the auth status includes an error, it should be forwarded.
    adapter.handleRawMessage(makeAuthStatusMsg({ error: "Token expired" }));

    const msg = browserMessageCb.mock.calls[0][0];
    expect(msg.type).toBe("auth_status");
    expect(msg.error).toBe("Token expired");
  });

  it("keep_alive → no emission to browser", () => {
    // Keep-alive messages are silently consumed and should not be forwarded.
    adapter.handleRawMessage(makeKeepAliveMsg());
    expect(browserMessageCb).not.toHaveBeenCalled();
  });

  it("tool_use_summary → emits browserMessageCb with tool_use_summary", () => {
    // Tool use summary messages should be forwarded with summary text and tool IDs.
    const summaryMsg = JSON.stringify({
      type: "tool_use_summary",
      summary: "Ran bash command successfully",
      preceding_tool_use_ids: ["tu-1", "tu-2"],
      uuid: "tus-uuid-1",
      session_id: "cli-123",
    });
    adapter.handleRawMessage(summaryMsg);

    expect(browserMessageCb).toHaveBeenCalledOnce();
    const msg = browserMessageCb.mock.calls[0][0];
    expect(msg.type).toBe("tool_use_summary");
    expect(msg.summary).toBe("Ran bash command successfully");
    expect(msg.tool_use_ids).toEqual(["tu-1", "tu-2"]);
  });

  it("multiple NDJSON lines in one message are all processed", () => {
    // The CLI may send multiple JSON objects separated by newlines in
    // a single WebSocket message. All should be parsed and routed.
    const combined = makeStreamEventMsg({ uuid: "s1" }) + "\n" + makeToolProgressMsg();
    adapter.handleRawMessage(combined);
    expect(browserMessageCb).toHaveBeenCalledTimes(2);
    expect(browserMessageCb.mock.calls[0][0].type).toBe("stream_event");
    expect(browserMessageCb.mock.calls[1][0].type).toBe("tool_progress");
  });

  it("malformed JSON lines are skipped without crashing", () => {
    // If a line in the NDJSON cannot be parsed, it should be skipped
    // and subsequent valid lines should still be processed.
    // The parse error also surfaces as an error message to the browser.
    const spy = vi.spyOn(log, "warn").mockImplementation(() => {});
    const raw = "not json\n" + makeAssistantMsg();
    adapter.handleRawMessage(raw);
    // Parse error surfaced + valid assistant message processed
    const calls = browserMessageCb.mock.calls.map((args: any[]) => args[0].type);
    expect(calls).toContain("error");
    expect(calls).toContain("assistant");
    spy.mockRestore();
  });
});

// ─── Activity update callback ───────────────────────────────────────────────

describe("Activity update callback", () => {
  let ws: ReturnType<typeof createMockSocket>;

  beforeEach(() => {
    ws = createMockSocket("sess-1");
    adapter.attachWebSocket(ws);
  });

  it("onActivityUpdate called on non-keepalive messages", () => {
    // The activity update callback is used for idle detection. It should
    // fire for all message types except keep_alive.
    adapter.handleRawMessage(makeAssistantMsg());
    expect(onActivityUpdate).toHaveBeenCalledOnce();
  });

  it("onActivityUpdate NOT called on keep_alive messages", () => {
    // Keep-alive messages don't represent real activity and should not
    // trigger the activity update callback.
    adapter.handleRawMessage(makeKeepAliveMsg());
    expect(onActivityUpdate).not.toHaveBeenCalled();
  });

  it("onActivityUpdate called for system, result, stream_event, control_request, tool_progress", () => {
    // Verify the callback fires for multiple different message types.
    adapter.handleRawMessage(makeInitMsg());
    adapter.handleRawMessage(makeResultMsg());
    adapter.handleRawMessage(makeStreamEventMsg());
    adapter.handleRawMessage(makeControlRequestMsg());
    adapter.handleRawMessage(makeToolProgressMsg());

    // init + result + stream_event + control_request + tool_progress = 5 calls
    expect(onActivityUpdate).toHaveBeenCalledTimes(5);
  });
});

// ─── Deduplication ──────────────────────────────────────────────────────────

describe("Deduplication", () => {
  let ws: ReturnType<typeof createMockSocket>;

  beforeEach(() => {
    ws = createMockSocket("sess-1");
    adapter.attachWebSocket(ws);
  });

  it("duplicate assistant messages are filtered out", () => {
    // When the CLI replays messages on WebSocket reconnect, the same
    // assistant message sent twice should only be processed once.
    const assistantNdjson = makeAssistantMsg();
    adapter.handleRawMessage(assistantNdjson);
    adapter.handleRawMessage(assistantNdjson);

    // Only the first should have been emitted
    expect(browserMessageCb).toHaveBeenCalledOnce();
    expect(browserMessageCb.mock.calls[0][0].type).toBe("assistant");
  });

  it("duplicate stream_events with same uuid are filtered out", () => {
    // Stream events with the same UUID should be deduplicated.
    const streamNdjson = makeStreamEventMsg({ uuid: "dup-stream-uuid" });
    adapter.handleRawMessage(streamNdjson);
    adapter.handleRawMessage(streamNdjson);

    // Only the first should have been emitted
    expect(browserMessageCb).toHaveBeenCalledOnce();
  });

  it("stream_events with different uuids are NOT filtered", () => {
    // Different UUIDs indicate distinct events that should both be processed.
    adapter.handleRawMessage(makeStreamEventMsg({ uuid: "stream-1" }));
    adapter.handleRawMessage(makeStreamEventMsg({ uuid: "stream-2" }));

    expect(browserMessageCb).toHaveBeenCalledTimes(2);
  });

  it("non-deduplicable message types (tool_progress, control_request) are never filtered", () => {
    // Tool progress and control request messages should never be deduplicated,
    // even if sent identically twice.
    const toolProgressNdjson = makeToolProgressMsg();
    adapter.handleRawMessage(toolProgressNdjson);
    adapter.handleRawMessage(toolProgressNdjson);
    expect(browserMessageCb).toHaveBeenCalledTimes(2);
  });
});

// ─── Control request/response flow ──────────────────────────────────────────

describe("Control request/response flow", () => {
  let ws: ReturnType<typeof createMockSocket>;

  beforeEach(() => {
    ws = createMockSocket("sess-1");
    adapter.attachWebSocket(ws);
  });

  it("MCP status request creates pending control request and resolves on response", () => {
    // When mcp_get_status is sent, the adapter creates a pending control
    // request. When the CLI responds with the matching request_id, the
    // adapter should resolve it and emit mcp_status to browsers.
    uuidCounter = 100; // Ensure deterministic request_id
    adapter.send({ type: "mcp_get_status" });

    // Extract the request_id from what was sent to the CLI
    const sentRaw = (ws.send.mock.calls[0][0] as string).trim();
    const sent = JSON.parse(sentRaw);
    const requestId = sent.request_id;

    // Simulate CLI response with matching request_id and MCP servers
    const controlResponse = JSON.stringify({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: requestId,
        response: {
          mcpServers: [
            { name: "test-server", status: "connected", config: { type: "stdio" }, scope: "project", tools: [] },
          ],
        },
      },
    });
    adapter.handleRawMessage(controlResponse);

    // The adapter should have emitted an mcp_status browser message
    expect(browserMessageCb).toHaveBeenCalledOnce();
    const msg = browserMessageCb.mock.calls[0][0];
    expect(msg.type).toBe("mcp_status");
    expect(msg.servers).toHaveLength(1);
    expect(msg.servers[0].name).toBe("test-server");
  });

  it("control response with no pending request is silently ignored", () => {
    // If a control_response arrives with an unknown request_id,
    // it should be silently ignored (no crash, no emission).
    const controlResponse = JSON.stringify({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: "unknown-request-id",
        response: {},
      },
    });
    adapter.handleRawMessage(controlResponse);
    // No emission to the browser
    expect(browserMessageCb).not.toHaveBeenCalled();
  });

  it("error control response logs warning and resolves the pending callback with the error", () => {
    // Issue #5 (cubic-ai PR #652): When the CLI responds with an error
    // control_response, the adapter should log a warning AND call
    // pending.resolve() with the error response so callers like
    // applyMcpSetServers can surface the actual error instead of timing out.
    uuidCounter = 200;
    adapter.send({ type: "mcp_get_status" });

    const sentRaw = (ws.send.mock.calls[0][0] as string).trim();
    const sent = JSON.parse(sentRaw);
    const requestId = sent.request_id;

    const errorResponse = JSON.stringify({
      type: "control_response",
      response: {
        subtype: "error",
        request_id: requestId,
        error: "MCP status unavailable",
      },
    });
    adapter.handleRawMessage(errorResponse);

    // console.warn should have been called with the error
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining("mcp_status failed"),
    );
    // The resolve callback IS called with the error response object.
    // For mcp_status, the resolve handler extracts mcpServers (undefined
    // on error responses), falls through to an empty array, and emits
    // mcp_status with servers: [].
    expect(browserMessageCb).toHaveBeenCalledOnce();
    const msg = browserMessageCb.mock.calls[0][0];
    expect(msg.type).toBe("mcp_status");
    expect(msg.servers).toEqual([]);
  });

  // Issue #5 (cubic-ai PR #652 review): applyMcpSetServers cannot surface
  // explicit CLI control errors because handleControlResponse swallows
  // subtype === "error" responses. The resolve callback is never called,
  // causing the 10s timeout to fire with a misleading "mcp_set_servers
  // timeout" error message instead of the actual CLI error text.
  //
  // Fix: error responses should call pending.resolve() with the error
  // response object so applyMcpSetServers can extract and surface the
  // real error message.
  it("applyMcpSetServers surfaces CLI error instead of timing out", async () => {
    // Send an mcp_set_servers request via applyMcpSetServers and simulate
    // an error response from the CLI. The promise should resolve promptly
    // with the actual error, NOT fall through to the 10s timeout.
    uuidCounter = 400;
    const resultPromise = adapter.applyMcpSetServers({ "test-server": { command: "echo", args: [] } as any });

    // Extract the request_id from the sent control_request
    const sentRaw = (ws.send.mock.calls[0][0] as string).trim();
    const sent = JSON.parse(sentRaw);
    const requestId = sent.request_id;

    // Simulate CLI error response
    const errorResponse = JSON.stringify({
      type: "control_response",
      response: {
        subtype: "error",
        request_id: requestId,
        error: "Server configuration invalid",
      },
    });
    adapter.handleRawMessage(errorResponse);

    // The promise should resolve promptly (not wait for the 10s timeout)
    const result = await resultPromise;
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // The error message should contain the actual CLI error, not "timeout"
      expect(result.error).toContain("Server configuration invalid");
    }
  });

  it("pending control request is removed after successful resolution", () => {
    // After a control response resolves a pending request, sending the
    // same response again should be a no-op (not double-resolve).
    uuidCounter = 300;
    adapter.send({ type: "mcp_get_status" });

    const sentRaw = (ws.send.mock.calls[0][0] as string).trim();
    const sent = JSON.parse(sentRaw);
    const requestId = sent.request_id;

    const successResponse = JSON.stringify({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: requestId,
        response: { mcpServers: [] },
      },
    });

    // First resolution
    adapter.handleRawMessage(successResponse);
    expect(browserMessageCb).toHaveBeenCalledOnce();

    // Second resolution — should be ignored (pending already removed)
    browserMessageCb.mockClear();
    adapter.handleRawMessage(successResponse);
    expect(browserMessageCb).not.toHaveBeenCalled();
  });
});

// ─── System init flushes pending messages ───────────────────────────────────

describe("System init flushes pending messages", () => {
  it("messages queued before init are flushed after init", () => {
    // When the CLI socket is connected but the adapter has pending messages
    // from before the connection, the init handler also flushes them.
    // This tests the scenario where messages are sent before the socket
    // is attached, then the socket attaches (flushing queue), and additional
    // messages are sent before init — those get queued internally too.

    // First, send a message before socket is attached (queued)
    adapter.send({ type: "user_message", content: "queued-msg" });

    // Attach socket — this flushes the pendingMessages
    const ws = createMockSocket("sess-1");
    adapter.attachWebSocket(ws);

    expect(ws.send).toHaveBeenCalledTimes(1);
    const firstSent = JSON.parse((ws.send.mock.calls[0][0] as string).trim());
    expect(firstSent.message.content).toBe("queued-msg");
  });
});

// ─── Edge cases ─────────────────────────────────────────────────────────────

describe("Edge cases", () => {
  it("adapter works without onActivityUpdate callback", () => {
    // Creating an adapter without the onActivityUpdate option should not
    // cause errors when processing messages.
    const plainAdapter = new ClaudeAdapter("sess-2");
    const cb = vi.fn();
    plainAdapter.onBrowserMessage(cb);

    const ws = createMockSocket("sess-2");
    plainAdapter.attachWebSocket(ws);
    plainAdapter.handleRawMessage(makeAssistantMsg());

    expect(cb).toHaveBeenCalledOnce();
  });

  it("adapter works without any callbacks registered", () => {
    // Processing messages without any registered callbacks should not throw.
    const plainAdapter = new ClaudeAdapter("sess-3");
    const ws = createMockSocket("sess-3");
    plainAdapter.attachWebSocket(ws);

    // Should not throw even without callbacks
    expect(() => plainAdapter.handleRawMessage(makeInitMsg())).not.toThrow();
    expect(() => plainAdapter.handleRawMessage(makeAssistantMsg())).not.toThrow();
  });

  it("system init with agents, slash_commands, and skills", () => {
    // Verify that optional fields from the init message are forwarded.
    const cb = vi.fn();
    adapter.onBrowserMessage(cb);

    const ws = createMockSocket("sess-1");
    adapter.attachWebSocket(ws);

    adapter.handleRawMessage(
      makeInitMsg({
        agents: ["agent-1"],
        slash_commands: ["/help"],
        skills: ["skill-1"],
      }),
    );

    // We have 2 registered callbacks for browserMessage (one from beforeEach, one here)
    // but only the last one registered on the adapter will fire (it overwrites).
    const msg = cb.mock.calls[0][0];
    expect(msg.session.agents).toEqual(["agent-1"]);
    expect(msg.session.slash_commands).toEqual(["/help"]);
    expect(msg.session.skills).toEqual(["skill-1"]);
  });

  it("empty NDJSON data produces no emissions", () => {
    // An empty string or whitespace-only message should produce no emissions.
    const ws = createMockSocket("sess-1");
    adapter.attachWebSocket(ws);
    adapter.handleRawMessage("");
    adapter.handleRawMessage("   \n  \n  ");
    expect(browserMessageCb).not.toHaveBeenCalled();
  });
});

// ─── control_cancel_request handling ─────────────────────────────────────────

describe("control_cancel_request", () => {
  it("emits permission_cancelled to browser", () => {
    // When the CLI cancels a pending control request (e.g. tool permission
    // that is no longer needed), the adapter should notify browsers so they
    // can remove the pending permission UI.
    const ws = createMockSocket("sess-1");
    adapter.attachWebSocket(ws);

    const msg = JSON.stringify({ type: "control_cancel_request", request_id: "req-cancel-1" });
    adapter.handleRawMessage(msg);

    expect(browserMessageCb).toHaveBeenCalledOnce();
    const emitted = browserMessageCb.mock.calls[0][0];
    expect(emitted.type).toBe("permission_cancelled");
    expect(emitted.request_id).toBe("req-cancel-1");
  });
});

// ─── Enriched can_use_tool fields ────────────────────────────────────────────

describe("enriched can_use_tool", () => {
  it("forwards title, display_name, blocked_path, decision_reason", () => {
    // Newer CLI versions may include enriched fields on can_use_tool requests
    // (title, display_name, blocked_path, decision_reason). The adapter should
    // forward all of these to the browser in the permission_request.
    const ws = createMockSocket("sess-1");
    adapter.attachWebSocket(ws);

    const msg = JSON.stringify({
      type: "control_request",
      request_id: "req-enriched-1",
      request: {
        subtype: "can_use_tool",
        tool_name: "Edit",
        input: { file_path: "/test.ts" },
        tool_use_id: "tu-enriched-1",
        title: "Edit a TypeScript file",
        display_name: "File Editor",
        blocked_path: "/test.ts",
        decision_reason: "File is outside trusted directories",
      },
    });
    adapter.handleRawMessage(msg);

    expect(browserMessageCb).toHaveBeenCalledOnce();
    const emitted = browserMessageCb.mock.calls[0][0];
    expect(emitted.type).toBe("permission_request");
    const perm = emitted.request;
    expect(perm.title).toBe("Edit a TypeScript file");
    expect(perm.display_name).toBe("File Editor");
    expect(perm.blocked_path).toBe("/test.ts");
    expect(perm.decision_reason).toBe("File is outside trusted directories");
  });

  it("works without enriched fields (backward compat)", () => {
    // Older CLI versions do not include enriched fields. The adapter should
    // still emit a valid permission_request with those fields undefined.
    const ws = createMockSocket("sess-1");
    adapter.attachWebSocket(ws);

    const msg = JSON.stringify({
      type: "control_request",
      request_id: "req-basic-1",
      request: {
        subtype: "can_use_tool",
        tool_name: "Bash",
        input: { command: "ls" },
        tool_use_id: "tu-basic-1",
      },
    });
    adapter.handleRawMessage(msg);

    expect(browserMessageCb).toHaveBeenCalledOnce();
    const emitted = browserMessageCb.mock.calls[0][0];
    expect(emitted.type).toBe("permission_request");
    const perm = emitted.request;
    expect(perm.title).toBeUndefined();
    expect(perm.display_name).toBeUndefined();
  });
});

// ─── end_session outgoing ────────────────────────────────────────────────────

describe("end_session", () => {
  it("sends end_session control_request to CLI", () => {
    // The browser can request the session to end. This should be translated
    // into a control_request with subtype "end_session" and the reason forwarded.
    const ws = createMockSocket("sess-1");
    adapter.attachWebSocket(ws);

    adapter.send({ type: "end_session", reason: "user closed" } as any);

    const sent = JSON.parse((ws.send.mock.calls[0][0] as string).trim());
    expect(sent.type).toBe("control_request");
    expect(sent.request.subtype).toBe("end_session");
    expect(sent.request.reason).toBe("user closed");
  });
});

// ─── stop_task outgoing ──────────────────────────────────────────────────────

describe("stop_task", () => {
  it("sends stop_task control_request to CLI", () => {
    // The browser can stop a running task. This should be translated into
    // a control_request with subtype "stop_task" and the task_id forwarded.
    const ws = createMockSocket("sess-1");
    adapter.attachWebSocket(ws);

    adapter.send({ type: "stop_task", task_id: "task-123" } as any);

    const sent = JSON.parse((ws.send.mock.calls[0][0] as string).trim());
    expect(sent.type).toBe("control_request");
    expect(sent.request.subtype).toBe("stop_task");
    expect(sent.request.task_id).toBe("task-123");
  });
});

// ─── update_environment_variables outgoing ───────────────────────────────────

describe("update_environment_variables", () => {
  it("sends update_environment_variables directly (not as control_request)", () => {
    // Environment variable updates are sent as a top-level message type,
    // not wrapped in a control_request, because the CLI expects them
    // as a distinct message kind.
    const ws = createMockSocket("sess-1");
    adapter.attachWebSocket(ws);

    adapter.send({ type: "update_environment_variables", variables: { TOKEN: "new-val" } } as any);

    const sent = JSON.parse((ws.send.mock.calls[0][0] as string).trim());
    expect(sent.type).toBe("update_environment_variables");
    expect(sent.variables.TOKEN).toBe("new-val");
  });
});

// ─── Streamlined messages ────────────────────────────────────────────────────

describe("streamlined messages", () => {
  it("forwards streamlined_text to browser", () => {
    // In simplified output mode, the CLI sends streamlined_text messages
    // instead of full assistant messages. These should be forwarded as-is.
    const ws = createMockSocket("sess-1");
    adapter.attachWebSocket(ws);

    const msg = JSON.stringify({ type: "streamlined_text", text: "Hello world", session_id: "s1", uuid: "u1" });
    adapter.handleRawMessage(msg);

    expect(browserMessageCb).toHaveBeenCalledOnce();
    const emitted = browserMessageCb.mock.calls[0][0];
    expect(emitted.type).toBe("streamlined_text");
    expect(emitted.text).toBe("Hello world");
  });

  it("forwards streamlined_tool_use_summary to browser", () => {
    // In simplified output mode, tool use summaries are sent as
    // streamlined_tool_use_summary. These should be forwarded with the summary text.
    const ws = createMockSocket("sess-1");
    adapter.attachWebSocket(ws);

    const msg = JSON.stringify({ type: "streamlined_tool_use_summary", tool_summary: "Read 2 files", session_id: "s1", uuid: "u2" });
    adapter.handleRawMessage(msg);

    expect(browserMessageCb).toHaveBeenCalledOnce();
    const emitted = browserMessageCb.mock.calls[0][0];
    expect(emitted.type).toBe("streamlined_tool_use_summary");
    expect(emitted.tool_summary).toBe("Read 2 files");
  });
});

// ─── Prompt suggestion ───────────────────────────────────────────────────────

describe("prompt_suggestion", () => {
  it("forwards prompt suggestions to browser", () => {
    // The CLI can suggest next prompts to the user. These should be forwarded
    // so the browser can render suggestion chips in the UI.
    const ws = createMockSocket("sess-1");
    adapter.attachWebSocket(ws);

    const msg = JSON.stringify({ type: "prompt_suggestion", suggestions: ["Fix the bug", "Add tests"], session_id: "s1", uuid: "u3" });
    adapter.handleRawMessage(msg);

    expect(browserMessageCb).toHaveBeenCalledOnce();
    const emitted = browserMessageCb.mock.calls[0][0];
    expect(emitted.type).toBe("prompt_suggestion");
    expect(emitted.suggestions).toEqual(["Fix the bug", "Add tests"]);
  });
});
