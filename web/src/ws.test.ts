// @vitest-environment jsdom

import type { SessionState, PermissionRequest, ContentBlock } from "./types.js";

// Mock the names utility before any imports
vi.mock("./utils/names.js", () => ({
  generateUniqueSessionName: vi.fn(() => "Test Session"),
}));

let wsModule: typeof import("./ws.js");
let useStore: typeof import("./store.js").useStore;

// ---------------------------------------------------------------------------
// MockWebSocket
// ---------------------------------------------------------------------------
let lastWs: InstanceType<typeof MockWebSocket>;

class MockWebSocket {
  static OPEN = 1;
  static CLOSED = 3;
  static CONNECTING = 0;
  static CLOSING = 2;
  OPEN = 1;
  CLOSED = 3;
  CONNECTING = 0;
  CLOSING = 2;
  readyState = MockWebSocket.OPEN;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  url: string;
  send = vi.fn();
  close = vi.fn();

  constructor(url: string) {
    this.url = url;
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    lastWs = this;
  }
}

vi.stubGlobal("WebSocket", MockWebSocket);
vi.stubGlobal("location", { protocol: "http:", host: "localhost:3456" });

// ---------------------------------------------------------------------------
// Fresh module state for each test
// ---------------------------------------------------------------------------
beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers();

  const storeModule = await import("./store.js");
  useStore = storeModule.useStore;
  useStore.getState().reset();
  localStorage.clear();

  wsModule = await import("./ws.js");
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function makeSession(id: string): SessionState {
  return {
    session_id: id,
    model: "claude-opus-4-20250514",
    cwd: "/home/user",
    tools: ["Bash", "Read"],
    permissionMode: "default",
    claude_code_version: "2.1.0",
    mcp_servers: [],
    agents: [],
    slash_commands: [],
    skills: [],
    total_cost_usd: 0,
    num_turns: 0,
    context_used_percent: 0,
    is_compacting: false,
    git_branch: "main",
    is_worktree: false,
    is_containerized: false,
    repo_root: "/repo",
    git_ahead: 0,
    git_behind: 0,
    total_lines_added: 0,
    total_lines_removed: 0,
  };
}

function fireMessage(data: Record<string, unknown>) {
  lastWs.onmessage!({ data: JSON.stringify(data) });
}

// ===========================================================================
// Connection
// ===========================================================================
describe("connectSession", () => {
  it("creates a WebSocket with the correct URL", () => {
    wsModule.connectSession("s1");

    expect(lastWs.url).toBe("ws://localhost:3456/ws/browser/s1?token=");
    expect(useStore.getState().connectionStatus.get("s1")).toBe("connecting");
  });

  it("does not create a duplicate socket for the same session", () => {
    wsModule.connectSession("s1");
    const first = lastWs;
    wsModule.connectSession("s1");

    // lastWs should still be the first one (no new constructor call)
    expect(lastWs).toBe(first);
  });

  it("sends session_subscribe with last_seq on open", () => {
    localStorage.setItem("companion:last-seq:s1", "12");
    wsModule.connectSession("s1");

    lastWs.onopen?.(new Event("open"));

    expect(lastWs.send).toHaveBeenCalledWith(
      JSON.stringify({ type: "session_subscribe", last_seq: 12 }),
    );
  });
});

// ===========================================================================
// sendToSession
// ===========================================================================
describe("sendToSession", () => {
  it("JSON-stringifies and sends the message", () => {
    wsModule.connectSession("s1");
    const msg = { type: "user_message" as const, content: "hello" };

    wsModule.sendToSession("s1", msg);

    const payload = JSON.parse(lastWs.send.mock.calls[0][0]);
    expect(payload.type).toBe("user_message");
    expect(payload.content).toBe("hello");
    expect(typeof payload.client_msg_id).toBe("string");
  });

  it("does nothing when session has no socket", () => {
    // Should not throw
    wsModule.sendToSession("nonexistent", { type: "interrupt" });
  });

  it("preserves provided client_msg_id", () => {
    wsModule.connectSession("s1");
    wsModule.sendToSession("s1", {
      type: "user_message",
      content: "hello",
      client_msg_id: "fixed-id-1",
    });

    const payload = JSON.parse(lastWs.send.mock.calls[0][0]);
    expect(payload.client_msg_id).toBe("fixed-id-1");
  });

  it("adds client_msg_id for interrupt control message", () => {
    wsModule.connectSession("s1");
    wsModule.sendToSession("s1", { type: "interrupt" });

    const payload = JSON.parse(lastWs.send.mock.calls[0][0]);
    expect(payload.type).toBe("interrupt");
    expect(typeof payload.client_msg_id).toBe("string");
  });
});

// ===========================================================================
// disconnectSession
// ===========================================================================
describe("disconnectSession", () => {
  it("closes the WebSocket and cleans up", () => {
    wsModule.connectSession("s1");
    const ws = lastWs;

    wsModule.disconnectSession("s1");

    expect(ws.close).toHaveBeenCalled();
    // Sending after disconnect should be a no-op
    wsModule.sendToSession("s1", { type: "interrupt" });
    expect(ws.send).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// handleMessage: session_init
// ===========================================================================
describe("handleMessage: session_init", () => {
  it("adds session to store, sets CLI connected, generates name", () => {
    wsModule.connectSession("s1");
    const session = makeSession("s1");

    fireMessage({ type: "session_init", session });

    const state = useStore.getState();
    expect(state.sessions.has("s1")).toBe(true);
    expect(state.sessions.get("s1")!.model).toBe("claude-opus-4-20250514");
    expect(state.cliConnected.get("s1")).toBe(true);
    expect(state.sessionStatus.get("s1")).toBe("idle");
    expect(state.sessionNames.get("s1")).toBe("Test Session");
  });

  it("does not overwrite an existing session name", () => {
    useStore.getState().setSessionName("s1", "Custom Name");

    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    expect(useStore.getState().sessionNames.get("s1")).toBe("Custom Name");
  });
});

// ===========================================================================
// handleMessage: session_update
// ===========================================================================
describe("handleMessage: session_update", () => {
  it("updates the session in the store", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    fireMessage({
      type: "session_update",
      session: { model: "claude-sonnet-4-20250514" },
    });

    expect(useStore.getState().sessions.get("s1")!.model).toBe(
      "claude-sonnet-4-20250514",
    );
  });
});

describe("handleMessage: event_replay", () => {
  it("replays sequenced stream events and stores latest seq", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    fireMessage({
      type: "event_replay",
      events: [
        {
          seq: 1,
          message: {
            type: "stream_event",
            event: {
              type: "content_block_delta",
              delta: { type: "text_delta", text: "Hello" },
            },
            parent_tool_use_id: null,
          },
        },
      ],
    });

    expect(useStore.getState().streaming.get("s1")).toBe("Hello");
    expect(localStorage.getItem("companion:last-seq:s1")).toBe("1");
    expect(lastWs.send).toHaveBeenCalledWith(
      JSON.stringify({ type: "session_ack", last_seq: 1 }),
    );
  });

  it("acks only once using the latest replayed seq", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });
    lastWs.send.mockClear();

    fireMessage({
      type: "event_replay",
      events: [
        {
          seq: 1,
          message: {
            type: "stream_event",
            event: {
              type: "content_block_delta",
              delta: { type: "text_delta", text: "A" },
            },
            parent_tool_use_id: null,
          },
        },
        {
          seq: 2,
          message: {
            type: "stream_event",
            event: {
              type: "content_block_delta",
              delta: { type: "text_delta", text: "B" },
            },
            parent_tool_use_id: null,
          },
        },
      ],
    });

    expect(useStore.getState().streaming.get("s1")).toBe("AB");
    expect(lastWs.send).toHaveBeenCalledTimes(1);
    expect(lastWs.send).toHaveBeenCalledWith(
      JSON.stringify({ type: "session_ack", last_seq: 2 }),
    );
  });
});

// ===========================================================================
// handleMessage: assistant
// ===========================================================================
describe("handleMessage: assistant", () => {
  it("appends a chat message and clears streaming", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    // Set some streaming text first
    useStore.getState().setStreaming("s1", "partial text...");

    fireMessage({
      type: "assistant",
      message: {
        id: "msg-1",
        type: "message",
        role: "assistant",
        model: "claude-opus-4-20250514",
        content: [{ type: "text", text: "Hello world" }],
        stop_reason: "end_turn",
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
      parent_tool_use_id: null,
    });

    const state = useStore.getState();
    const msgs = state.messages.get("s1")!;
    expect(msgs).toHaveLength(1);
    expect(msgs[0].role).toBe("assistant");
    expect(msgs[0].content).toBe("Hello world");
    expect(msgs[0].id).toBe("msg-1");
    expect(state.streaming.has("s1")).toBe(false);
    expect(state.sessionStatus.get("s1")).toBe("running");
  });

  it("replaces a streaming draft message instead of appending a second assistant bubble", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    fireMessage({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        delta: { type: "text_delta", text: "Partial answer" },
      },
      parent_tool_use_id: null,
    });

    let msgs = useStore.getState().messages.get("s1")!;
    expect(msgs).toHaveLength(1);
    expect(msgs[0].role).toBe("assistant");
    expect(msgs[0].isStreaming).toBe(true);
    expect(msgs[0].content).toBe("Partial answer");

    fireMessage({
      type: "assistant",
      message: {
        id: "msg-final-1",
        type: "message",
        role: "assistant",
        model: "claude-opus-4-20250514",
        content: [{ type: "text", text: "Final answer" }],
        stop_reason: "end_turn",
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
      parent_tool_use_id: null,
    });

    msgs = useStore.getState().messages.get("s1")!;
    expect(msgs).toHaveLength(1);
    expect(msgs[0].id).toBe("msg-final-1");
    expect(msgs[0].content).toBe("Final answer");
    expect(msgs[0].isStreaming).toBeUndefined();
  });

  it("upserts assistant updates when Claude reuses the same message id", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    fireMessage({
      type: "assistant",
      message: {
        id: "msg-shared-1",
        type: "message",
        role: "assistant",
        model: "claude-opus-4-20250514",
        content: [{ type: "thinking", thinking: "Thinking step" }],
        stop_reason: null,
        usage: {
          input_tokens: 10,
          output_tokens: 1,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
      parent_tool_use_id: null,
    });

    fireMessage({
      type: "assistant",
      message: {
        id: "msg-shared-1",
        type: "message",
        role: "assistant",
        model: "claude-opus-4-20250514",
        content: [{ type: "text", text: "Final answer text" }],
        stop_reason: "end_turn",
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
      parent_tool_use_id: null,
    });

    const msgs = useStore.getState().messages.get("s1")!;
    expect(msgs).toHaveLength(1);
    expect(msgs[0].id).toBe("msg-shared-1");
    expect(msgs[0].contentBlocks?.map((b) => b.type)).toEqual([
      "thinking",
      "text",
    ]);
    expect(msgs[0].content).toContain("Final answer text");
  });

  it("tracks changed files using session cwd for relative tool paths", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    fireMessage({
      type: "assistant",
      message: {
        id: "msg-tool-1",
        type: "message",
        role: "assistant",
        model: "claude-opus-4-20250514",
        content: [
          {
            type: "tool_use",
            id: "tool-1",
            name: "Edit",
            input: { file_path: "web/server/index.ts" },
          },
        ],
        stop_reason: "tool_use",
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
      parent_tool_use_id: null,
    });

    expect(useStore.getState().changedFilesTick.get("s1")).toBe(1);
  });

  it("does not bump changedFilesTick for files outside session cwd", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    fireMessage({
      type: "assistant",
      message: {
        id: "msg-tool-2",
        type: "message",
        role: "assistant",
        model: "claude-opus-4-20250514",
        content: [
          {
            type: "tool_use",
            id: "tool-2",
            name: "Write",
            input: { file_path: "/Users/test/.claude/plans/example.md" },
          },
        ],
        stop_reason: "tool_use",
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
      parent_tool_use_id: null,
    });

    expect(useStore.getState().changedFilesTick.get("s1")).toBeUndefined();
  });

  it("bumps changedFilesTick for absolute paths when inside cwd", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    fireMessage({
      type: "assistant",
      message: {
        id: "msg-tool-3",
        type: "message",
        role: "assistant",
        model: "claude-opus-4-20250514",
        content: [
          {
            type: "tool_use",
            id: "tool-3",
            name: "Write",
            input: { file_path: "/home/user/README.md" },
          },
        ],
        stop_reason: "tool_use",
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
      parent_tool_use_id: null,
    });

    expect(useStore.getState().changedFilesTick.get("s1")).toBe(1);
  });
});

// ===========================================================================
// handleMessage: stream_event (content_block_delta)
// ===========================================================================
describe("handleMessage: stream_event content_block_delta", () => {
  it("accumulates streaming text from text_delta events", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    fireMessage({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        delta: { type: "text_delta", text: "Hello " },
      },
      parent_tool_use_id: null,
    });

    fireMessage({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        delta: { type: "text_delta", text: "world" },
      },
      parent_tool_use_id: null,
    });

    expect(useStore.getState().streaming.get("s1")).toBe("Hello world");
  });

  it("accumulates streaming text from thinking_delta events", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    fireMessage({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        delta: { type: "thinking_delta", thinking: "Analyzing " },
      },
      parent_tool_use_id: null,
    });

    fireMessage({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        delta: { type: "thinking_delta", thinking: "context" },
      },
      parent_tool_use_id: null,
    });

    expect(useStore.getState().streaming.get("s1")).toBe(
      "Thinking:\nAnalyzing context",
    );
  });

  it("separates thinking and response text when both delta types stream", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    fireMessage({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        delta: { type: "thinking_delta", thinking: "Planning..." },
      },
      parent_tool_use_id: null,
    });

    fireMessage({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        delta: { type: "text_delta", text: "Final answer" },
      },
      parent_tool_use_id: null,
    });

    expect(useStore.getState().streaming.get("s1")).toBe(
      "Thinking:\nPlanning...\n\nResponse:\nFinal answer",
    );
  });

  it("does not wedge prior text into thinking section when thinking arrives after text", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    fireMessage({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        delta: { type: "text_delta", text: "Hello" },
      },
      parent_tool_use_id: null,
    });

    fireMessage({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        delta: { type: "thinking_delta", thinking: "Plan" },
      },
      parent_tool_use_id: null,
    });

    expect(useStore.getState().streaming.get("s1")).toBe("Thinking:\nPlan");
  });

  it("resets to a new thinking section if thinking resumes after response text", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    fireMessage({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        delta: { type: "thinking_delta", thinking: "A" },
      },
      parent_tool_use_id: null,
    });
    fireMessage({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        delta: { type: "text_delta", text: "B" },
      },
      parent_tool_use_id: null,
    });
    fireMessage({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        delta: { type: "thinking_delta", thinking: "C" },
      },
      parent_tool_use_id: null,
    });

    expect(useStore.getState().streaming.get("s1")).toBe("Thinking:\nC");
  });
});

// ===========================================================================
// handleMessage: stream_event (message_start)
// ===========================================================================
describe("handleMessage: stream_event message_start", () => {
  it("sets streaming start time", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    vi.setSystemTime(new Date(1700000000000));
    fireMessage({
      type: "stream_event",
      event: { type: "message_start" },
      parent_tool_use_id: null,
    });

    expect(useStore.getState().streamingStartedAt.get("s1")).toBe(
      1700000000000,
    );
  });
});

// ===========================================================================
// handleMessage: result
// ===========================================================================
describe("handleMessage: result", () => {
  it("updates cost/turns, clears streaming, sets idle", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });
    useStore.getState().setStreaming("s1", "partial");
    useStore.getState().setStreamingStats("s1", { startedAt: Date.now() });

    fireMessage({
      type: "result",
      data: {
        type: "result",
        subtype: "success",
        is_error: false,
        duration_ms: 1000,
        duration_api_ms: 800,
        num_turns: 3,
        total_cost_usd: 0.05,
        stop_reason: "end_turn",
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
        uuid: "u1",
        session_id: "s1",
      },
    });

    const state = useStore.getState();
    expect(state.sessions.get("s1")!.total_cost_usd).toBe(0.05);
    expect(state.sessions.get("s1")!.num_turns).toBe(3);
    expect(state.streaming.has("s1")).toBe(false);
    expect(state.streamingStartedAt.has("s1")).toBe(false);
    expect(state.sessionStatus.get("s1")).toBe("idle");
  });

  it("clears transient streaming draft bubble when a turn ends without a final assistant message", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    fireMessage({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        delta: { type: "text_delta", text: "Partial output" },
      },
      parent_tool_use_id: null,
    });
    expect(useStore.getState().messages.get("s1")).toHaveLength(1);

    fireMessage({
      type: "result",
      data: {
        type: "result",
        subtype: "success",
        is_error: false,
        duration_ms: 1000,
        duration_api_ms: 800,
        num_turns: 1,
        total_cost_usd: 0.05,
        stop_reason: "end_turn",
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
        uuid: "u1",
        session_id: "s1",
      },
    });

    expect(useStore.getState().messages.get("s1")).toEqual([]);
  });

  it("appends a system error message when result has errors", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    fireMessage({
      type: "result",
      data: {
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        errors: ["Something went wrong", "Another error"],
        duration_ms: 100,
        duration_api_ms: 50,
        num_turns: 1,
        total_cost_usd: 0.01,
        stop_reason: null,
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
        uuid: "u2",
        session_id: "s1",
      },
    });

    const msgs = useStore.getState().messages.get("s1")!;
    expect(msgs).toHaveLength(1);
    expect(msgs[0].role).toBe("system");
    expect(msgs[0].content).toBe("Error: Something went wrong, Another error");
  });
});

// ===========================================================================
// Per-turn token tracking
// ===========================================================================
describe("per-turn token tracking", () => {
  it("assistant message with usage stores claude_token_details via updateSession", () => {
    // Verifies that when an assistant message carries usage data, the handler
    // calls updateSession with a fully-populated claude_token_details object.
    // contextWindow starts at 0 because no result with modelUsage has arrived yet,
    // so context_used_percent must NOT be set in this call.
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    fireMessage({
      type: "assistant",
      message: {
        id: "msg-tok-1",
        type: "message",
        role: "assistant",
        model: "claude-opus-4-20250514",
        content: [{ type: "text", text: "Token test" }],
        stop_reason: "end_turn",
        usage: {
          input_tokens: 1000,
          output_tokens: 200,
          cache_creation_input_tokens: 50,
          cache_read_input_tokens: 300,
        },
      },
      parent_tool_use_id: null,
    });

    const session = useStore.getState().sessions.get("s1")!;
    // claude_token_details must reflect the exact values from msg.usage
    expect(session.claude_token_details).toBeDefined();
    expect(session.claude_token_details!.inputTokens).toBe(1000);
    expect(session.claude_token_details!.outputTokens).toBe(200);
    expect(session.claude_token_details!.cacheCreationInputTokens).toBe(50);
    expect(session.claude_token_details!.cacheReadInputTokens).toBe(300);
    // contextWindow/maxOutputTokens default to 0 before a result with modelUsage arrives
    expect(session.claude_token_details!.contextWindow).toBe(0);
    // context_used_percent must not be updated when contextWindow is 0
    expect(session.context_used_percent).toBe(0);
  });

  it("assistant message with a known contextWindow computes context_used_percent immediately", () => {
    // If a previous result already set contextWindow on claude_token_details,
    // the assistant handler should recompute context_used_percent using
    // the per-turn formula: (inputTokens + cacheRead + cacheCreation) / contextWindow.
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    // Seed the session with a pre-existing contextWindow (simulating a prior result message)
    useStore.getState().updateSession("s1", {
      claude_token_details: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        contextWindow: 200000,
        maxOutputTokens: 8192,
      },
    });

    fireMessage({
      type: "assistant",
      message: {
        id: "msg-tok-2",
        type: "message",
        role: "assistant",
        model: "claude-opus-4-20250514",
        content: [{ type: "text", text: "Context pct test" }],
        stop_reason: "end_turn",
        usage: {
          input_tokens: 80000,
          output_tokens: 1000,
          cache_creation_input_tokens: 10000,
          cache_read_input_tokens: 10000,
        },
      },
      parent_tool_use_id: null,
    });

    const session = useStore.getState().sessions.get("s1")!;
    // Expected: (80000 + 10000 + 10000) / 200000 = 0.5 → 50%
    expect(session.context_used_percent).toBe(50);
  });

  it("result message with modelUsage and existing per-turn data uses per-turn formula for context %", () => {
    // When a result message carries modelUsage AND claude_token_details already
    // exists from a prior assistant message, the handler must use the per-turn
    // input tokens (not modelUsage.inputTokens) so the percentage reflects
    // actual context consumption rather than the cumulative session total.
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    // Simulate an assistant message that populated per-turn data
    fireMessage({
      type: "assistant",
      message: {
        id: "msg-tok-3",
        type: "message",
        role: "assistant",
        model: "claude-opus-4-20250514",
        content: [{ type: "text", text: "Result pct test" }],
        stop_reason: "end_turn",
        usage: {
          input_tokens: 50000,
          output_tokens: 500,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
      parent_tool_use_id: null,
    });

    // Now fire a result with modelUsage containing a large cumulative inputTokens
    // and a concrete contextWindow. The per-turn formula should win.
    fireMessage({
      type: "result",
      data: {
        type: "result",
        subtype: "success",
        is_error: false,
        duration_ms: 500,
        duration_api_ms: 400,
        num_turns: 1,
        total_cost_usd: 0.1,
        stop_reason: "end_turn",
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
        uuid: "u-tok",
        session_id: "s1",
        modelUsage: {
          "claude-opus-4-20250514": {
            // Cumulative totals deliberately higher than per-turn to detect which formula runs
            inputTokens: 999999,
            outputTokens: 999999,
            contextWindow: 200000,
            maxOutputTokens: 8192,
          },
        },
      },
    });

    const session = useStore.getState().sessions.get("s1")!;
    // Per-turn formula: (50000 + 0 + 0) / 200000 = 25%
    // Cumulative fallback would give: (999999 + 999999) / 200000 = 999% → capped at 100%
    // So 25% proves the per-turn path was taken.
    expect(session.context_used_percent).toBe(25);
  });
});

// ===========================================================================
// handleMessage: permission_request
// ===========================================================================
describe("handleMessage: permission_request", () => {
  it("adds permission to the store", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    const request: PermissionRequest = {
      request_id: "req-1",
      tool_name: "Bash",
      input: { command: "rm -rf /" },
      tool_use_id: "tu-1",
      timestamp: Date.now(),
    };

    fireMessage({ type: "permission_request", request });

    const perms = useStore.getState().pendingPermissions.get("s1");
    expect(perms).toBeDefined();
    expect(perms!.get("req-1")).toBeDefined();
    expect(perms!.get("req-1")!.tool_name).toBe("Bash");
  });
});

// ===========================================================================
// handleMessage: permission_cancelled
// ===========================================================================
describe("handleMessage: permission_cancelled", () => {
  it("removes the permission from the store", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    // Add a permission first
    const request: PermissionRequest = {
      request_id: "req-1",
      tool_name: "Bash",
      input: {},
      tool_use_id: "tu-1",
      timestamp: Date.now(),
    };
    useStore.getState().addPermission("s1", request);

    fireMessage({ type: "permission_cancelled", request_id: "req-1" });

    const perms = useStore.getState().pendingPermissions.get("s1");
    expect(perms!.has("req-1")).toBe(false);
  });
});

// ===========================================================================
// handleMessage: status_change (compacting)
// ===========================================================================
describe("handleMessage: status_change", () => {
  it("sets session status to compacting", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    fireMessage({ type: "status_change", status: "compacting" });

    expect(useStore.getState().sessionStatus.get("s1")).toBe("compacting");
  });

  it("sets session status to arbitrary value", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    fireMessage({ type: "status_change", status: "running" });

    expect(useStore.getState().sessionStatus.get("s1")).toBe("running");
  });
});

// ===========================================================================
// handleMessage: system_event
// ===========================================================================
describe("handleMessage: system_event", () => {
  it("appends compact/task/files events as system chat messages", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    fireMessage({
      type: "system_event",
      timestamp: 1500,
      event: {
        subtype: "compact_boundary",
        compact_metadata: { trigger: "auto", pre_tokens: 2048 },
        uuid: "u-compact",
        session_id: "s1",
      },
    });

    const msgs = useStore.getState().messages.get("s1")!;
    expect(msgs).toHaveLength(1);
    expect(msgs[0].role).toBe("system");
    expect(msgs[0].content).toContain("Context compacted");
    expect(msgs[0].timestamp).toBe(1500);
  });

  it("ignores noisy hook_progress events in chat", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    fireMessage({
      type: "system_event",
      event: {
        subtype: "hook_progress",
        hook_id: "hk-1",
        hook_name: "lint",
        hook_event: "post_tool_use",
        stdout: "running",
        stderr: "",
        output: "running",
        uuid: "u-hook-progress",
        session_id: "s1",
      },
    });

    const msgs = useStore.getState().messages.get("s1") || [];
    expect(msgs).toHaveLength(0);
  });
});

// ===========================================================================
// handleMessage: cli_disconnected / cli_connected
// ===========================================================================
describe("handleMessage: cli_disconnected/connected", () => {
  it("toggles cliConnected in the store", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    expect(useStore.getState().cliConnected.get("s1")).toBe(true);

    fireMessage({ type: "cli_disconnected" });
    expect(useStore.getState().cliConnected.get("s1")).toBe(false);
    expect(useStore.getState().sessionStatus.get("s1")).toBeNull();

    fireMessage({ type: "cli_connected" });
    expect(useStore.getState().cliConnected.get("s1")).toBe(true);
  });
});

// ===========================================================================
// handleMessage: message_history
// ===========================================================================
describe("handleMessage: message_history", () => {
  it("reconstructs chat messages from history", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    fireMessage({
      type: "message_history",
      messages: [
        { type: "user_message", content: "What is 2+2?", timestamp: 1000 },
        {
          type: "assistant",
          message: {
            id: "msg-hist-1",
            type: "message",
            role: "assistant",
            model: "claude-opus-4-20250514",
            content: [{ type: "text", text: "4" }],
            stop_reason: "end_turn",
            usage: {
              input_tokens: 5,
              output_tokens: 1,
              cache_creation_input_tokens: 0,
              cache_read_input_tokens: 0,
            },
          },
          parent_tool_use_id: null,
        },
        {
          type: "result",
          data: {
            type: "result",
            subtype: "success",
            is_error: false,
            duration_ms: 100,
            duration_api_ms: 50,
            num_turns: 1,
            total_cost_usd: 0.01,
            stop_reason: "end_turn",
            usage: {
              input_tokens: 5,
              output_tokens: 1,
              cache_creation_input_tokens: 0,
              cache_read_input_tokens: 0,
            },
            uuid: "u1",
            session_id: "s1",
          },
        },
      ],
    });

    const msgs = useStore.getState().messages.get("s1")!;
    expect(msgs).toHaveLength(2);
    expect(msgs[0].role).toBe("user");
    expect(msgs[0].content).toBe("What is 2+2?");
    expect(msgs[1].role).toBe("assistant");
    expect(msgs[1].content).toBe("4");
  });

  it("includes error results from history as system messages", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    fireMessage({
      type: "message_history",
      messages: [
        {
          type: "result",
          data: {
            type: "result",
            subtype: "error_during_execution",
            is_error: true,
            errors: ["Timed out"],
            duration_ms: 100,
            duration_api_ms: 50,
            num_turns: 1,
            total_cost_usd: 0,
            stop_reason: null,
            usage: {
              input_tokens: 0,
              output_tokens: 0,
              cache_creation_input_tokens: 0,
              cache_read_input_tokens: 0,
            },
            uuid: "u1",
            session_id: "s1",
          },
        },
      ],
    });

    const msgs = useStore.getState().messages.get("s1")!;
    expect(msgs).toHaveLength(1);
    expect(msgs[0].role).toBe("system");
    expect(msgs[0].content).toBe("Error: Timed out");
  });

  it("assigns stable IDs to error results based on history index", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    fireMessage({
      type: "message_history",
      messages: [
        { type: "user_message", content: "hi", timestamp: 1000 },
        {
          type: "result",
          data: {
            type: "result",
            subtype: "error_during_execution",
            is_error: true,
            errors: ["Timed out"],
            duration_ms: 100,
            duration_api_ms: 50,
            num_turns: 1,
            total_cost_usd: 0,
            stop_reason: null,
            usage: {
              input_tokens: 0,
              output_tokens: 0,
              cache_creation_input_tokens: 0,
              cache_read_input_tokens: 0,
            },
            uuid: "u1",
            session_id: "s1",
          },
        },
      ],
    });

    const msgs = useStore.getState().messages.get("s1")!;
    const errorMsg = msgs.find((m) => m.role === "system")!;
    expect(errorMsg.id).toBe("hist-error-1");
  });

  it("deduplicates messages on reconnection (replayed history)", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    const history = {
      type: "message_history",
      messages: [
        {
          type: "user_message",
          id: "user-1",
          content: "hello",
          timestamp: 1000,
        },
        {
          type: "assistant",
          message: {
            id: "msg-1",
            type: "message",
            role: "assistant",
            model: "claude-opus-4-20250514",
            content: [{ type: "text", text: "hi" }],
            stop_reason: "end_turn",
            usage: {
              input_tokens: 5,
              output_tokens: 1,
              cache_creation_input_tokens: 0,
              cache_read_input_tokens: 0,
            },
          },
          parent_tool_use_id: null,
          timestamp: 2000,
        },
      ],
    };

    // Initial connect
    fireMessage(history);
    expect(useStore.getState().messages.get("s1")).toHaveLength(2);

    // Simulate reconnect: same history replayed
    fireMessage(history);
    expect(useStore.getState().messages.get("s1")).toHaveLength(2);
  });

  it("merges assistant history entries that share a message id", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    fireMessage({
      type: "message_history",
      messages: [
        {
          type: "assistant",
          message: {
            id: "msg-shared-history-1",
            type: "message",
            role: "assistant",
            model: "claude-opus-4-20250514",
            content: [{ type: "thinking", thinking: "Planning..." }],
            stop_reason: null,
            usage: {
              input_tokens: 10,
              output_tokens: 1,
              cache_creation_input_tokens: 0,
              cache_read_input_tokens: 0,
            },
          },
          parent_tool_use_id: null,
          timestamp: 1000,
        },
        {
          type: "assistant",
          message: {
            id: "msg-shared-history-1",
            type: "message",
            role: "assistant",
            model: "claude-opus-4-20250514",
            content: [{ type: "text", text: "Final from history" }],
            stop_reason: "end_turn",
            usage: {
              input_tokens: 10,
              output_tokens: 5,
              cache_creation_input_tokens: 0,
              cache_read_input_tokens: 0,
            },
          },
          parent_tool_use_id: null,
          timestamp: 1001,
        },
      ],
    });

    const msgs = useStore.getState().messages.get("s1")!;
    expect(msgs).toHaveLength(1);
    expect(msgs[0].id).toBe("msg-shared-history-1");
    expect(msgs[0].contentBlocks?.map((b) => b.type)).toEqual([
      "thinking",
      "text",
    ]);
    expect(msgs[0].content).toContain("Final from history");
  });

  it("preserves original timestamps from history instead of using Date.now()", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    fireMessage({
      type: "message_history",
      messages: [
        { type: "user_message", content: "hello", timestamp: 42000 },
        {
          type: "assistant",
          message: {
            id: "msg-1",
            type: "message",
            role: "assistant",
            model: "claude-opus-4-20250514",
            content: [{ type: "text", text: "hi" }],
            stop_reason: "end_turn",
            usage: {
              input_tokens: 5,
              output_tokens: 1,
              cache_creation_input_tokens: 0,
              cache_read_input_tokens: 0,
            },
          },
          parent_tool_use_id: null,
          timestamp: 43000,
        },
      ],
    });

    const msgs = useStore.getState().messages.get("s1")!;
    expect(msgs[0].timestamp).toBe(42000);
    expect(msgs[1].timestamp).toBe(43000);
  });

  it("reconstructs persisted system events from history and skips hook_progress", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    fireMessage({
      type: "message_history",
      messages: [
        {
          type: "system_event",
          timestamp: 45000,
          event: {
            subtype: "task_notification",
            task_id: "task-1",
            status: "completed",
            output_file: "/tmp/out.txt",
            summary: "Done",
            uuid: "u-task",
            session_id: "s1",
          },
        },
        {
          type: "system_event",
          timestamp: 46000,
          event: {
            subtype: "hook_progress",
            hook_id: "hk-1",
            hook_name: "lint",
            hook_event: "post_tool_use",
            stdout: "running",
            stderr: "",
            output: "running",
            uuid: "u-hook-progress",
            session_id: "s1",
          },
        },
      ],
    });

    const msgs = useStore.getState().messages.get("s1")!;
    expect(msgs).toHaveLength(1);
    expect(msgs[0].role).toBe("system");
    expect(msgs[0].content).toContain("Task completed: task-1");
    expect(msgs[0].timestamp).toBe(45000);
  });
});

// ===========================================================================
// handleMessage: auth_status error
// ===========================================================================
describe("handleMessage: auth_status", () => {
  it("appends a system message when there is an auth error", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    fireMessage({
      type: "auth_status",
      isAuthenticating: false,
      output: [],
      error: "Invalid API key",
    });

    const msgs = useStore.getState().messages.get("s1")!;
    expect(msgs).toHaveLength(1);
    expect(msgs[0].role).toBe("system");
    expect(msgs[0].content).toBe("Auth error: Invalid API key");
  });

  it("does not append a message when there is no error", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    fireMessage({
      type: "auth_status",
      isAuthenticating: true,
      output: ["Authenticating..."],
    });

    const msgs = useStore.getState().messages.get("s1") || [];
    expect(msgs).toHaveLength(0);
  });
});

// ===========================================================================
// Task extraction: TodoWrite
// ===========================================================================
describe("task extraction: TodoWrite", () => {
  it("replaces all tasks via TodoWrite tool_use block", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    fireMessage({
      type: "assistant",
      message: {
        id: "msg-tasks-1",
        type: "message",
        role: "assistant",
        model: "claude-opus-4-20250514",
        content: [
          {
            type: "tool_use",
            id: "tu-todo-1",
            name: "TodoWrite",
            input: {
              todos: [
                {
                  content: "Fix bug",
                  status: "in_progress",
                  activeForm: "Fixing bug",
                },
                {
                  content: "Write tests",
                  status: "pending",
                  activeForm: "Writing tests",
                },
              ],
            },
          },
        ],
        stop_reason: "tool_use",
        usage: {
          input_tokens: 10,
          output_tokens: 20,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
      parent_tool_use_id: null,
    });

    const tasks = useStore.getState().sessionTasks.get("s1")!;
    expect(tasks).toHaveLength(2);
    expect(tasks[0].subject).toBe("Fix bug");
    expect(tasks[0].status).toBe("in_progress");
    expect(tasks[0].activeForm).toBe("Fixing bug");
    expect(tasks[1].subject).toBe("Write tests");
    expect(tasks[1].status).toBe("pending");
  });
});

// ===========================================================================
// Task extraction: TaskCreate
// ===========================================================================
describe("task extraction: TaskCreate", () => {
  it("incrementally adds a task", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    fireMessage({
      type: "assistant",
      message: {
        id: "msg-tc-1",
        type: "message",
        role: "assistant",
        model: "claude-opus-4-20250514",
        content: [
          {
            type: "tool_use",
            id: "tu-tc-1",
            name: "TaskCreate",
            input: {
              subject: "Deploy service",
              description: "Deploy to prod",
              activeForm: "Deploying service",
            },
          },
        ],
        stop_reason: "tool_use",
        usage: {
          input_tokens: 10,
          output_tokens: 20,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
      parent_tool_use_id: null,
    });

    const tasks = useStore.getState().sessionTasks.get("s1")!;
    expect(tasks).toHaveLength(1);
    expect(tasks[0].subject).toBe("Deploy service");
    expect(tasks[0].description).toBe("Deploy to prod");
    expect(tasks[0].status).toBe("pending");
  });
});

// ===========================================================================
// Task extraction: TaskUpdate
// ===========================================================================
describe("task extraction: TaskUpdate", () => {
  it("updates an existing task", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    // Create a task first via TaskCreate
    fireMessage({
      type: "assistant",
      message: {
        id: "msg-tc-2",
        type: "message",
        role: "assistant",
        model: "claude-opus-4-20250514",
        content: [
          {
            type: "tool_use",
            id: "tu-tc-2",
            name: "TaskCreate",
            input: { subject: "Build feature" },
          },
        ],
        stop_reason: "tool_use",
        usage: {
          input_tokens: 10,
          output_tokens: 20,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
      parent_tool_use_id: null,
    });

    const tasksBefore = useStore.getState().sessionTasks.get("s1")!;
    expect(tasksBefore[0].status).toBe("pending");

    // Update the task
    fireMessage({
      type: "assistant",
      message: {
        id: "msg-tu-1",
        type: "message",
        role: "assistant",
        model: "claude-opus-4-20250514",
        content: [
          {
            type: "tool_use",
            id: "tu-tu-1",
            name: "TaskUpdate",
            input: { taskId: "1", status: "completed" },
          },
        ],
        stop_reason: "tool_use",
        usage: {
          input_tokens: 10,
          output_tokens: 10,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
      parent_tool_use_id: null,
    });

    const tasksAfter = useStore.getState().sessionTasks.get("s1")!;
    expect(tasksAfter[0].status).toBe("completed");
  });
});

// ===========================================================================
// handleMessage: session_name_update
// ===========================================================================
describe("handleMessage: session_name_update", () => {
  it("updates session name when current name is a random Adj+Noun name", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    // Current name is "Test Session" from the mock — set a random-style name
    useStore.getState().setSessionName("s1", "Swift Falcon");

    fireMessage({
      type: "session_name_update",
      name: "Fix Authentication Bug",
    });

    expect(useStore.getState().sessionNames.get("s1")).toBe(
      "Fix Authentication Bug",
    );
  });

  it("marks session as recently renamed for animation", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    // Set a random-style name
    useStore.getState().setSessionName("s1", "Calm River");

    fireMessage({ type: "session_name_update", name: "Deploy Dashboard" });

    expect(useStore.getState().recentlyRenamed.has("s1")).toBe(true);
  });

  it("does not overwrite a manually-set custom name", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    // Manually renamed — not matching Adj+Noun pattern
    useStore.getState().setSessionName("s1", "My Custom Project");

    fireMessage({ type: "session_name_update", name: "Auto Generated Title" });

    expect(useStore.getState().sessionNames.get("s1")).toBe(
      "My Custom Project",
    );
  });

  it("does not mark as recently renamed when name is not updated", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    // Custom name — won't be overwritten
    useStore.getState().setSessionName("s1", "My Custom Name");

    fireMessage({ type: "session_name_update", name: "Auto Title" });

    expect(useStore.getState().recentlyRenamed.has("s1")).toBe(false);
  });

  it("updates name when session has no name at all", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    // Clear the name entirely
    const sessionNames = new Map(useStore.getState().sessionNames);
    sessionNames.delete("s1");
    useStore.setState({ sessionNames });

    fireMessage({ type: "session_name_update", name: "Brand New Title" });

    expect(useStore.getState().sessionNames.get("s1")).toBe("Brand New Title");
    expect(useStore.getState().recentlyRenamed.has("s1")).toBe(true);
  });

  it("does not overwrite multi-word custom names that happen to start capitalized", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    // This matches the Adj+Noun pattern (two capitalized words)
    useStore.getState().setSessionName("s1", "Bright Falcon");
    fireMessage({ type: "session_name_update", name: "Auto Title" });
    // Should overwrite random names
    expect(useStore.getState().sessionNames.get("s1")).toBe("Auto Title");

    // But a three-word name should NOT be overwritten
    useStore.getState().setSessionName("s1", "My Cool Project");
    useStore.getState().clearRecentlyRenamed("s1");
    fireMessage({ type: "session_name_update", name: "Another Auto Title" });
    expect(useStore.getState().sessionNames.get("s1")).toBe("My Cool Project");
  });
});

// ===========================================================================
// MCP Status
// ===========================================================================

describe("MCP status messages", () => {
  it("mcp_status: stores servers in store", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    const servers = [
      {
        name: "test-mcp",
        status: "connected",
        config: { type: "stdio", command: "node", args: ["server.js"] },
        scope: "project",
        tools: [{ name: "myTool" }],
      },
      {
        name: "disabled-mcp",
        status: "disabled",
        config: { type: "sse", url: "http://localhost:3000" },
        scope: "user",
      },
    ];

    fireMessage({ type: "mcp_status", servers });

    const stored = useStore.getState().mcpServers.get("s1");
    expect(stored).toHaveLength(2);
    expect(stored![0].name).toBe("test-mcp");
    expect(stored![0].status).toBe("connected");
    expect(stored![0].tools).toHaveLength(1);
    expect(stored![1].name).toBe("disabled-mcp");
    expect(stored![1].status).toBe("disabled");
  });

  it("sendMcpGetStatus: sends mcp_get_status message", () => {
    wsModule.connectSession("s1");
    lastWs.send.mockClear();

    wsModule.sendMcpGetStatus("s1");

    expect(lastWs.send).toHaveBeenCalledTimes(1);
    const sent = JSON.parse(lastWs.send.mock.calls[0][0]);
    expect(sent.type).toBe("mcp_get_status");
    expect(typeof sent.client_msg_id).toBe("string");
  });

  it("sendMcpToggle: sends mcp_toggle message", () => {
    wsModule.connectSession("s1");
    lastWs.send.mockClear();

    wsModule.sendMcpToggle("s1", "my-server", false);

    expect(lastWs.send).toHaveBeenCalledTimes(1);
    const sent = JSON.parse(lastWs.send.mock.calls[0][0]);
    expect(sent.type).toBe("mcp_toggle");
    expect(sent.serverName).toBe("my-server");
    expect(sent.enabled).toBe(false);
    expect(typeof sent.client_msg_id).toBe("string");
  });

  it("sendMcpReconnect: sends mcp_reconnect message", () => {
    wsModule.connectSession("s1");
    lastWs.send.mockClear();

    wsModule.sendMcpReconnect("s1", "failing-server");

    expect(lastWs.send).toHaveBeenCalledTimes(1);
    const sent = JSON.parse(lastWs.send.mock.calls[0][0]);
    expect(sent.type).toBe("mcp_reconnect");
    expect(sent.serverName).toBe("failing-server");
    expect(typeof sent.client_msg_id).toBe("string");
  });

  it("sendMcpSetServers: sends mcp_set_servers message", () => {
    wsModule.connectSession("s1");
    lastWs.send.mockClear();

    const servers = {
      "notes-server": {
        type: "stdio" as const,
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-memory"],
      },
    };
    wsModule.sendMcpSetServers("s1", servers);

    expect(lastWs.send).toHaveBeenCalledTimes(1);
    const sent = JSON.parse(lastWs.send.mock.calls[0][0]);
    expect(sent.type).toBe("mcp_set_servers");
    expect(sent.servers).toEqual(servers);
    expect(typeof sent.client_msg_id).toBe("string");
  });
});

// ===========================================================================
// handleMessage: tool_progress
// ===========================================================================
describe("handleMessage: tool_progress", () => {
  it("stores tool progress in the store", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    fireMessage({
      type: "tool_progress",
      tool_use_id: "tu-123",
      tool_name: "Bash",
      elapsed_time_seconds: 5,
    });

    const progress = useStore.getState().toolProgress.get("s1");
    expect(progress).toBeDefined();
    expect(progress!.get("tu-123")).toEqual({
      toolName: "Bash",
      elapsedSeconds: 5,
    });
  });

  it("updates elapsed time on subsequent messages", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    fireMessage({
      type: "tool_progress",
      tool_use_id: "tu-123",
      tool_name: "Bash",
      elapsed_time_seconds: 2,
    });
    fireMessage({
      type: "tool_progress",
      tool_use_id: "tu-123",
      tool_name: "Bash",
      elapsed_time_seconds: 7,
    });

    const entry = useStore.getState().toolProgress.get("s1")!.get("tu-123");
    expect(entry!.elapsedSeconds).toBe(7);
  });
});

// ===========================================================================
// handleMessage: tool_use_summary
// ===========================================================================
describe("handleMessage: tool_use_summary", () => {
  it("appends a system message with the summary text", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    fireMessage({
      type: "tool_use_summary",
      summary: "Ran 3 tools: Bash, Read, Grep",
      tool_use_ids: ["tu-1", "tu-2", "tu-3"],
    });

    const msgs = useStore.getState().messages.get("s1");
    expect(msgs).toBeDefined();
    const systemMsg = msgs!.find(
      (m) =>
        m.role === "system" && m.content === "Ran 3 tools: Bash, Read, Grep",
    );
    expect(systemMsg).toBeDefined();
  });
});

// ===========================================================================
// assistant message: per-tool progress clearing (not blanket clear)
// ===========================================================================
describe("handleMessage: assistant clears only completed tool progress", () => {
  it("clears progress for tool_result blocks but keeps others", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    // Set up progress for two concurrent tools
    useStore
      .getState()
      .setToolProgress("s1", "tu-a", { toolName: "Grep", elapsedSeconds: 3 });
    useStore
      .getState()
      .setToolProgress("s1", "tu-b", { toolName: "Glob", elapsedSeconds: 2 });

    // Simulate assistant message with tool_result for only tu-a
    fireMessage({
      type: "assistant",
      message: {
        id: "msg-1",
        type: "message",
        role: "assistant",
        model: "claude-opus-4-20250514",
        content: [
          { type: "tool_result", tool_use_id: "tu-a", content: "3 matches" },
        ] as ContentBlock[],
        stop_reason: null,
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
      parent_tool_use_id: null,
    });

    const progress = useStore.getState().toolProgress.get("s1");
    // tu-a should be cleared (its result arrived)
    expect(progress?.has("tu-a")).toBeFalsy();
    // tu-b should still be present (still running)
    expect(progress?.get("tu-b")).toEqual({
      toolName: "Glob",
      elapsedSeconds: 2,
    });
  });
});
