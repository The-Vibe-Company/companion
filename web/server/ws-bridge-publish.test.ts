import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  broadcastToBrowsers,
  sendToBrowser,
  EVENT_BUFFER_LIMIT,
} from "./ws-bridge-publish.js";
import type { Session, SocketData } from "./ws-bridge-types.js";
import type { BrowserIncomingMessage } from "./session-types.js";
import { SessionStateMachine } from "./session-state-machine.js";
import type { ServerWebSocket } from "bun";

function makeMockSocket(sessionId = "test-session") {
  return {
    data: { kind: "browser", sessionId } as SocketData,
    send: vi.fn(),
    close: vi.fn(),
    readyState: 1,
  } as unknown as ServerWebSocket<SocketData>;
}

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "test-session",
    backendType: "claude",
    backendAdapter: null,
    browserSockets: new Set(),
    state: {
      session_id: "test-session",
      model: "claude-sonnet-4-6",
      cwd: "/test",
      tools: [],
      permissionMode: "default",
      claude_code_version: "1.0",
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
      aiValidationEnabled: false,
      aiValidationAutoApprove: false,
      aiValidationAutoDeny: false,
    },
    pendingPermissions: new Map(),
    messageHistory: [],
    pendingMessages: [],
    nextEventSeq: 1,
    eventBuffer: [],
    lastAckSeq: 0,
    processedClientMessageIds: [],
    processedClientMessageIdSet: new Set(),
    lastCliActivityTs: Date.now(),
    stateMachine: new SessionStateMachine("test-session"),
    dynamicMcpServers: {},
    ...overrides,
  };
}

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ─── broadcastToBrowsers ──────────────────────────────────────────────────────

describe("broadcastToBrowsers", () => {
  it("sends message to all connected browser sockets", () => {
    const ws1 = makeMockSocket();
    const ws2 = makeMockSocket();
    const session = makeSession();
    session.browserSockets.add(ws1);
    session.browserSockets.add(ws2);

    const msg: BrowserIncomingMessage = { type: "cli_connected" };
    broadcastToBrowsers(session, msg, {
      eventBufferLimit: EVENT_BUFFER_LIMIT,
      recorder: null,
      persistFn: vi.fn(),
    });

    expect(ws1.send).toHaveBeenCalledTimes(1);
    expect(ws2.send).toHaveBeenCalledTimes(1);

    // Both should receive the same JSON
    const sent1 = (ws1.send as any).mock.calls[0][0];
    const sent2 = (ws2.send as any).mock.calls[0][0];
    expect(sent1).toBe(sent2);
  });

  it("removes broken sockets that throw on send", () => {
    const goodWs = makeMockSocket();
    const badWs = makeMockSocket();
    (badWs.send as any).mockImplementation(() => { throw new Error("broken"); });

    const session = makeSession();
    session.browserSockets.add(goodWs);
    session.browserSockets.add(badWs);

    broadcastToBrowsers(session, { type: "cli_connected" }, {
      eventBufferLimit: EVENT_BUFFER_LIMIT,
      recorder: null,
      persistFn: vi.fn(),
    });

    // Good socket still connected, bad one removed
    expect(session.browserSockets.has(goodWs)).toBe(true);
    expect(session.browserSockets.has(badWs)).toBe(false);
  });

  it("assigns monotonically increasing seq numbers", () => {
    const ws = makeMockSocket();
    const session = makeSession();
    session.browserSockets.add(ws);

    const opts = {
      eventBufferLimit: EVENT_BUFFER_LIMIT,
      recorder: null,
      persistFn: vi.fn(),
    };

    // Send 3 messages
    broadcastToBrowsers(session, { type: "cli_connected" }, opts);
    broadcastToBrowsers(session, { type: "cli_disconnected" }, opts);
    broadcastToBrowsers(session, { type: "cli_connected" }, opts);

    const seqs = (ws.send as any).mock.calls.map((call: any) => {
      const parsed = JSON.parse(call[0]);
      return parsed.seq;
    });

    // seq numbers should be strictly increasing
    expect(seqs[0]).toBeLessThan(seqs[1]);
    expect(seqs[1]).toBeLessThan(seqs[2]);
  });

  it("calls recorder.record when recorder is provided", () => {
    const ws = makeMockSocket();
    const session = makeSession();
    session.browserSockets.add(ws);

    const recorder = {
      record: vi.fn(),
    };

    broadcastToBrowsers(session, { type: "cli_connected" }, {
      eventBufferLimit: EVENT_BUFFER_LIMIT,
      recorder: recorder as any,
      persistFn: vi.fn(),
    });

    expect(recorder.record).toHaveBeenCalledTimes(1);
    expect(recorder.record).toHaveBeenCalledWith(
      "test-session", "out", expect.any(String), "browser", "claude", "/test",
    );
  });

  it("logs warning when broadcasting to 0 browsers for assistant/stream_event/result", () => {
    const session = makeSession(); // no browser sockets
    const logSpy = vi.mocked(console.log);

    broadcastToBrowsers(session, { type: "assistant", message: {} as any, parent_tool_use_id: null, timestamp: 1 }, {
      eventBufferLimit: EVENT_BUFFER_LIMIT,
      recorder: null,
      persistFn: vi.fn(),
    });

    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining("Broadcasting assistant to 0 browsers"),
    );
  });

  it("does not warn for non-critical message types with 0 browsers", () => {
    const session = makeSession();
    const logSpy = vi.mocked(console.log);
    logSpy.mockClear();

    broadcastToBrowsers(session, { type: "cli_connected" }, {
      eventBufferLimit: EVENT_BUFFER_LIMIT,
      recorder: null,
      persistFn: vi.fn(),
    });

    // Should not have the "Broadcasting ... to 0 browsers" warning
    const warningCalls = logSpy.mock.calls.filter(
      (call) => typeof call[0] === "string" && call[0].includes("0 browsers"),
    );
    expect(warningCalls).toHaveLength(0);
  });
});

// ─── sendToBrowser ────────────────────────────────────────────────────────────

describe("sendToBrowser", () => {
  it("sends JSON-serialized message to socket", () => {
    const ws = makeMockSocket();
    const msg: BrowserIncomingMessage = { type: "cli_connected" };

    sendToBrowser(ws, msg);

    expect(ws.send).toHaveBeenCalledTimes(1);
    const sent = JSON.parse((ws.send as any).mock.calls[0][0]);
    expect(sent.type).toBe("cli_connected");
  });

  it("does not throw when socket.send fails", () => {
    const ws = makeMockSocket();
    (ws.send as any).mockImplementation(() => { throw new Error("broken"); });

    // Should not throw
    expect(() => sendToBrowser(ws, { type: "cli_connected" })).not.toThrow();
  });
});

// ─── EVENT_BUFFER_LIMIT ───────────────────────────────────────────────────────

describe("EVENT_BUFFER_LIMIT", () => {
  it("is 600", () => {
    expect(EVENT_BUFFER_LIMIT).toBe(600);
  });
});
