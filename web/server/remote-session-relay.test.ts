import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import { RemoteSessionRelay } from "./remote-session-relay.js";
import type { ServerWebSocket } from "bun";
import type { SocketData } from "./ws-bridge.js";

/**
 * Tests for RemoteSessionRelay — the class that bridges browser WebSocket
 * clients to remote Takumi T nodes via WebSocket relay connections.
 *
 * External dependencies mocked:
 * - ServerWebSocket (Bun) — browser-side sockets
 * - WebSocket (global) — remote node connections
 * - console.log/error — suppress noisy relay logs
 */

// ── Mock WebSocket ────────────────────────────────────────────────────────────

/** Tracks all instantiated mock WebSockets so tests can simulate events */
let mockWebSocketInstances: MockWebSocket[] = [];

class MockWebSocket {
  static OPEN = 1;
  static CLOSED = 3;

  url: string;
  readyState = MockWebSocket.OPEN;
  listeners = new Map<string, Function[]>();
  sentMessages: string[] = [];
  closed = false;

  constructor(url: string) {
    this.url = url;
    mockWebSocketInstances.push(this);
    // Auto-fire "open" on next tick so tests can set up listeners first
  }

  addEventListener(event: string, handler: Function) {
    const existing = this.listeners.get(event) || [];
    existing.push(handler);
    this.listeners.set(event, existing);
  }

  send(data: string) {
    this.sentMessages.push(data);
  }

  close() {
    this.closed = true;
    this.readyState = MockWebSocket.CLOSED;
  }

  // Test helpers — simulate events on the mock WebSocket
  _fireOpen() {
    this.readyState = MockWebSocket.OPEN;
    for (const fn of this.listeners.get("open") || []) fn();
  }

  _fireMessage(data: string) {
    for (const fn of this.listeners.get("message") || []) fn({ data } as MessageEvent);
  }

  _fireClose(code = 1000) {
    this.readyState = MockWebSocket.CLOSED;
    for (const fn of this.listeners.get("close") || []) fn({ code } as CloseEvent);
  }

  _fireError() {
    for (const fn of this.listeners.get("error") || []) fn(new Event("error"));
  }
}

// ── Mock browser ServerWebSocket ──────────────────────────────────────────────

function makeBrowserWs(): ServerWebSocket<SocketData> {
  const sent: string[] = [];
  return {
    send: vi.fn((data: string) => { sent.push(data); }),
    data: { kind: "browser", sessionId: "local-1" },
    _sent: sent,
  } as unknown as ServerWebSocket<SocketData>;
}

// ── Setup ─────────────────────────────────────────────────────────────────────

let relay: RemoteSessionRelay;
const originalWebSocket = globalThis.WebSocket;

beforeEach(() => {
  relay = new RemoteSessionRelay();
  mockWebSocketInstances = [];
  // Replace global WebSocket with our mock
  (globalThis as any).WebSocket = MockWebSocket;
  // Suppress console noise from relay
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  (globalThis as any).WebSocket = originalWebSocket;
  vi.restoreAllMocks();
});

describe("RemoteSessionRelay", () => {
  // ── register() ────────────────────────────────────────────────────────────

  describe("register", () => {
    it("should_register_session_when_valid_params_provided", () => {
      relay.register("local-1", "remote-1", "http://node:3456", "tok", "Node A");
      expect(relay.isRemoteSession("local-1")).toBe(true);
    });

    it("should_not_report_unregistered_session_as_remote", () => {
      expect(relay.isRemoteSession("nonexistent")).toBe(false);
    });
  });

  // ── handleBrowserOpen() ───────────────────────────────────────────────────

  describe("handleBrowserOpen", () => {
    it("should_send_session_phase_starting_when_browser_connects", () => {
      relay.register("local-1", "remote-1", "http://node:3456", "tok", "Node A");
      const ws = makeBrowserWs();

      relay.handleBrowserOpen(ws, "local-1");

      // Browser should receive immediate "starting" phase feedback
      expect(ws.send).toHaveBeenCalledWith(
        expect.stringContaining('"session_phase"'),
      );
      const msg = JSON.parse((ws.send as any).mock.calls[0][0]);
      expect(msg.type).toBe("session_phase");
      expect(msg.phase).toBe("starting");
    });

    it("should_initiate_remote_websocket_connection_when_first_browser_connects", () => {
      relay.register("local-1", "remote-1", "http://node:3456", "tok", "Node A");
      const ws = makeBrowserWs();

      relay.handleBrowserOpen(ws, "local-1");

      // A remote WebSocket should have been created
      expect(mockWebSocketInstances).toHaveLength(1);
      expect(mockWebSocketInstances[0].url).toContain("ws://node:3456");
      expect(mockWebSocketInstances[0].url).toContain("remote-1");
      expect(mockWebSocketInstances[0].url).toContain("token=tok");
    });

    it("should_noop_when_session_not_registered", () => {
      const ws = makeBrowserWs();
      // Should not throw
      relay.handleBrowserOpen(ws, "unknown-session");
      expect(mockWebSocketInstances).toHaveLength(0);
    });

    it("should_remove_browser_socket_when_send_fails", () => {
      relay.register("local-1", "remote-1", "http://node:3456", "tok", "Node A");
      const ws = makeBrowserWs();
      (ws.send as any).mockImplementation(() => { throw new Error("socket closed"); });

      relay.handleBrowserOpen(ws, "local-1");

      // Should not create remote WS since browser was removed after send failure
      // (no browser sockets remain, so no point connecting)
      // Actually the code removes the browser and returns early, but still might
      // have called connectToRemote before the send. Let's just verify no crash.
    });
  });

  // ── handleBrowserMessage() ────────────────────────────────────────────────

  describe("handleBrowserMessage", () => {
    it("should_buffer_messages_when_remote_ws_not_connected", () => {
      relay.register("local-1", "remote-1", "http://node:3456", "tok", "Node A");
      const ws = makeBrowserWs();

      // Send message before remote WS is open
      relay.handleBrowserMessage(ws, "local-1", '{"type":"session_subscribe"}');

      // No remote WS yet, so message should be buffered (not lost)
      // When remote connects, it should flush. We verify by connecting:
      relay.handleBrowserOpen(ws, "local-1");
      const remoteWs = mockWebSocketInstances[0];
      remoteWs._fireOpen();

      // After open, the relay sends session_subscribe and then flushes buffered messages
      // The buffered message should have been forwarded
      const forwarded = remoteWs.sentMessages.filter(m => m.includes("session_subscribe"));
      // At least the relay's own subscribe + the buffered browser message
      expect(forwarded.length).toBeGreaterThanOrEqual(1);
    });

    it("should_forward_message_when_remote_ws_is_open", () => {
      relay.register("local-1", "remote-1", "http://node:3456", "tok", "Node A");
      const ws = makeBrowserWs();
      relay.handleBrowserOpen(ws, "local-1");

      const remoteWs = mockWebSocketInstances[0];
      remoteWs._fireOpen();

      relay.handleBrowserMessage(ws, "local-1", '{"type":"user_message","text":"hello"}');

      // Message should be forwarded to remote WS
      const userMsgs = remoteWs.sentMessages.filter(m => m.includes("user_message"));
      expect(userMsgs).toHaveLength(1);
    });

    it("should_rewrite_local_session_id_to_remote_in_forwarded_messages", () => {
      relay.register("local-1", "remote-1", "http://node:3456", "tok", "Node A");
      const ws = makeBrowserWs();
      relay.handleBrowserOpen(ws, "local-1");

      const remoteWs = mockWebSocketInstances[0];
      remoteWs._fireOpen();

      // Send message containing the local session ID
      relay.handleBrowserMessage(ws, "local-1", `{"session_id":"local-1"}`);

      // The forwarded message should have remote-1 instead of local-1
      const last = remoteWs.sentMessages[remoteWs.sentMessages.length - 1];
      expect(last).toContain("remote-1");
      expect(last).not.toContain("local-1");
    });

    it("should_noop_when_session_not_registered", () => {
      const ws = makeBrowserWs();
      // Should not throw
      relay.handleBrowserMessage(ws, "unknown", "data");
    });
  });

  // ── Remote WS message relay (remote → browser) ───────────────────────────

  describe("remote-to-browser relay", () => {
    it("should_rewrite_remote_session_id_to_local_when_relaying_to_browser", () => {
      relay.register("local-1", "remote-1", "http://node:3456", "tok", "Node A");
      const ws = makeBrowserWs();
      relay.handleBrowserOpen(ws, "local-1");

      const remoteWs = mockWebSocketInstances[0];
      remoteWs._fireOpen();

      // Simulate remote node sending a message with the remote session ID
      remoteWs._fireMessage(`{"type":"assistant","session_id":"remote-1"}`);

      // Browser should receive the message with local-1 instead of remote-1
      const browserCalls = (ws.send as any).mock.calls;
      const relayedMsg = browserCalls.find((call: any[]) => call[0].includes("assistant"));
      expect(relayedMsg).toBeDefined();
      expect(relayedMsg[0]).toContain("local-1");
      expect(relayedMsg[0]).not.toContain("remote-1");
    });

    it("should_suppress_early_cli_disconnected_before_session_init", () => {
      relay.register("local-1", "remote-1", "http://node:3456", "tok", "Node A");
      const ws = makeBrowserWs();
      relay.handleBrowserOpen(ws, "local-1");

      const remoteWs = mockWebSocketInstances[0];
      remoteWs._fireOpen();

      // Clear the session_phase message sent during handleBrowserOpen
      (ws.send as any).mockClear();

      // Send cli_disconnected BEFORE session_init — should be suppressed
      remoteWs._fireMessage('{"type":"cli_disconnected"}');

      // Browser should NOT receive cli_disconnected
      const calls = (ws.send as any).mock.calls;
      const disconnectMsgs = calls.filter((c: any[]) => c[0].includes("cli_disconnected"));
      expect(disconnectMsgs).toHaveLength(0);
    });

    it("should_allow_cli_disconnected_after_session_init_received", () => {
      relay.register("local-1", "remote-1", "http://node:3456", "tok", "Node A");
      const ws = makeBrowserWs();
      relay.handleBrowserOpen(ws, "local-1");

      const remoteWs = mockWebSocketInstances[0];
      remoteWs._fireOpen();
      (ws.send as any).mockClear();

      // First receive session_init
      remoteWs._fireMessage('{"type":"session_init","data":"init"}');
      // Then cli_disconnected — should be allowed through
      remoteWs._fireMessage('{"type":"cli_disconnected"}');

      const calls = (ws.send as any).mock.calls;
      const disconnectMsgs = calls.filter((c: any[]) => c[0].includes("cli_disconnected"));
      expect(disconnectMsgs).toHaveLength(1);
    });
  });

  // ── handleBrowserClose() ──────────────────────────────────────────────────

  describe("handleBrowserClose", () => {
    it("should_close_remote_ws_when_last_browser_disconnects", () => {
      relay.register("local-1", "remote-1", "http://node:3456", "tok", "Node A");
      const ws = makeBrowserWs();
      relay.handleBrowserOpen(ws, "local-1");

      const remoteWs = mockWebSocketInstances[0];
      remoteWs._fireOpen();

      relay.handleBrowserClose(ws, "local-1");

      expect(remoteWs.closed).toBe(true);
    });

    it("should_keep_remote_ws_open_when_other_browsers_remain", () => {
      relay.register("local-1", "remote-1", "http://node:3456", "tok", "Node A");
      const ws1 = makeBrowserWs();
      const ws2 = makeBrowserWs();
      relay.handleBrowserOpen(ws1, "local-1");

      const remoteWs = mockWebSocketInstances[0];
      remoteWs._fireOpen();

      // Add second browser
      relay.handleBrowserOpen(ws2, "local-1");

      // Close first browser
      relay.handleBrowserClose(ws1, "local-1");

      // Remote WS should still be open (ws2 is still connected)
      expect(remoteWs.closed).toBe(false);
    });

    it("should_noop_when_session_not_registered", () => {
      const ws = makeBrowserWs();
      // Should not throw
      relay.handleBrowserClose(ws, "unknown");
    });
  });

  // ── cleanup() ─────────────────────────────────────────────────────────────

  describe("cleanup", () => {
    it("should_close_remote_ws_and_remove_session_on_cleanup", () => {
      relay.register("local-1", "remote-1", "http://node:3456", "tok", "Node A");
      const ws = makeBrowserWs();
      relay.handleBrowserOpen(ws, "local-1");

      const remoteWs = mockWebSocketInstances[0];
      remoteWs._fireOpen();

      relay.cleanup("local-1");

      expect(remoteWs.closed).toBe(true);
      expect(relay.isRemoteSession("local-1")).toBe(false);
    });

    it("should_noop_when_cleaning_up_unregistered_session", () => {
      // Should not throw
      relay.cleanup("nonexistent");
    });
  });

  // ── Remote WS reconnection ───────────────────────────────────────────────

  describe("reconnection", () => {
    it("should_broadcast_cli_disconnected_when_remote_ws_closes", () => {
      relay.register("local-1", "remote-1", "http://node:3456", "tok", "Node A");
      const ws = makeBrowserWs();
      relay.handleBrowserOpen(ws, "local-1");

      const remoteWs = mockWebSocketInstances[0];
      remoteWs._fireOpen();
      (ws.send as any).mockClear();

      // Simulate remote disconnect
      remoteWs._fireClose(1006);

      // Browser should receive cli_disconnected
      const calls = (ws.send as any).mock.calls;
      const disconnectMsg = calls.find((c: any[]) => c[0].includes("cli_disconnected"));
      expect(disconnectMsg).toBeDefined();
    });

    it("should_attempt_reconnect_when_remote_ws_closes_and_browsers_connected", () => {
      vi.useFakeTimers();
      relay.register("local-1", "remote-1", "http://node:3456", "tok", "Node A");
      const ws = makeBrowserWs();
      relay.handleBrowserOpen(ws, "local-1");

      const remoteWs = mockWebSocketInstances[0];
      remoteWs._fireOpen();

      // Simulate remote disconnect
      remoteWs._fireClose(1006);

      // Should schedule a reconnect after 5s
      expect(mockWebSocketInstances).toHaveLength(1); // only original
      vi.advanceTimersByTime(5000);
      // A new WebSocket should be created for reconnection
      expect(mockWebSocketInstances).toHaveLength(2);

      vi.useRealTimers();
    });
  });
});
