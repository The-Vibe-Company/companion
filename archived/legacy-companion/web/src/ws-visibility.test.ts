// @vitest-environment jsdom
/**
 * Tests for RC9: page visibility-aware WebSocket reconnection.
 *
 * Mobile browsers (Android Chrome, iOS Safari) kill WebSocket connections when
 * the page is backgrounded. Without visibility handling, the frontend enters a
 * rapid connect/disconnect cycle. These tests verify that:
 *   1. scheduleReconnect skips when the page is hidden
 *   2. visibilitychange → hidden cancels pending reconnect timers
 *   3. visibilitychange → visible reconnects active sessions
 */

import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

// Mock WebSocket globally before ws.ts is imported
const mockWsSend = vi.fn();
const mockWsClose = vi.fn();
let wsInstances: Array<{ onopen?: (() => void) | null; onclose?: (() => void) | null; onerror?: (() => void) | null; onmessage?: ((e: any) => void) | null }> = [];

class MockWebSocket {
  static OPEN = 1;
  static CLOSED = 3;
  static CONNECTING = 0;
  static CLOSING = 2;
  OPEN = 1;
  CLOSED = 3;
  CONNECTING = 0;
  CLOSING = 2;
  send = mockWsSend;
  close = mockWsClose;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((e: any) => void) | null = null;
  readyState = MockWebSocket.OPEN;
  constructor() {
    wsInstances.push(this);
  }
}
vi.stubGlobal("WebSocket", MockWebSocket);

// Mock notification sound to avoid import errors
vi.mock("./utils/notification-sound.js", () => ({
  playNotificationSound: vi.fn(),
}));

// We need dynamic import to control document.hidden at import time
let connectSession: typeof import("./ws.js")["connectSession"];
let disconnectSession: typeof import("./ws.js")["disconnectSession"];
let disconnectAll: typeof import("./ws.js")["disconnectAll"];

// Track visibilitychange listeners
let visibilityListeners: Array<() => void> = [];
const originalAddEventListener = document.addEventListener.bind(document);

describe("RC9: visibility-aware reconnection", () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    wsInstances = [];
    mockWsSend.mockReset();
    mockWsClose.mockReset();
    visibilityListeners = [];

    // Intercept visibilitychange listeners
    vi.spyOn(document, "addEventListener").mockImplementation((event: string, handler: any) => {
      if (event === "visibilitychange") {
        visibilityListeners.push(handler);
      }
      return originalAddEventListener(event, handler);
    });

    // Start with visible page
    Object.defineProperty(document, "hidden", { value: false, writable: true, configurable: true });

    // Reset module so ws.ts re-runs its top-level setup
    vi.resetModules();
    const ws = await import("./ws.js");
    connectSession = ws.connectSession;
    disconnectSession = ws.disconnectSession;
    disconnectAll = ws.disconnectAll;

    // Set up a session in the store (sdkSessions is what visibility handler reads)
    const { useStore } = await import("./store.js");
    useStore.getState().reset();
    useStore.setState({
      sdkSessions: [{
        sessionId: "test-1",
        model: "claude-sonnet-4-6",
        cwd: "/test",
        num_turns: 0,
        archived: false,
      } as any],
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("scheduleReconnect skips when page is hidden", () => {
    // Connect a session
    connectSession("test-1");
    expect(wsInstances).toHaveLength(1);

    // Simulate page hidden
    Object.defineProperty(document, "hidden", { value: true, configurable: true });
    for (const fn of visibilityListeners) fn();

    // Trigger onclose — should call scheduleReconnect which should skip
    wsInstances[0].onclose?.();

    // Advance past reconnect delay — no new WebSocket should be created
    vi.advanceTimersByTime(5_000);
    expect(wsInstances).toHaveLength(1); // no reconnect attempt
  });

  it("visibilitychange → hidden cancels pending reconnect timers", () => {
    // Connect and then disconnect to trigger a reconnect timer
    connectSession("test-1");
    expect(wsInstances).toHaveLength(1);

    // Trigger close while visible — schedules reconnect
    wsInstances[0].onclose?.();

    // Before reconnect fires, hide the page
    Object.defineProperty(document, "hidden", { value: true, configurable: true });
    for (const fn of visibilityListeners) fn();

    // Advance past reconnect delay — timer should have been cancelled
    vi.advanceTimersByTime(5_000);
    expect(wsInstances).toHaveLength(1); // no reconnect
  });

  it("visibilitychange → visible reconnects disconnected active sessions", () => {
    // Connect and disconnect
    connectSession("test-1");
    expect(wsInstances).toHaveLength(1);

    // Hide page first, then trigger close
    Object.defineProperty(document, "hidden", { value: true, configurable: true });
    for (const fn of visibilityListeners) fn();
    wsInstances[0].onclose?.();

    // No reconnect while hidden
    vi.advanceTimersByTime(5_000);
    expect(wsInstances).toHaveLength(1);

    // Page becomes visible — should reconnect
    Object.defineProperty(document, "hidden", { value: false, configurable: true });
    for (const fn of visibilityListeners) fn();

    expect(wsInstances).toHaveLength(2); // new connection attempt
  });

  it("does not reconnect archived sessions on visibility restore", async () => {
    const { useStore } = await import("./store.js");

    // Connect and disconnect
    connectSession("test-1");
    wsInstances[0].onclose?.();

    // Archive the session while hidden
    Object.defineProperty(document, "hidden", { value: true, configurable: true });
    for (const fn of visibilityListeners) fn();
    useStore.setState({
      sdkSessions: [{
        sessionId: "test-1",
        model: "claude-sonnet-4-6",
        cwd: "/test",
        num_turns: 0,
        archived: true,
      } as any],
    });

    // Page becomes visible — should NOT reconnect archived session
    Object.defineProperty(document, "hidden", { value: false, configurable: true });
    for (const fn of visibilityListeners) fn();

    expect(wsInstances).toHaveLength(1); // no reconnect
  });

  it("visibilitychange → visible reconnects current session even if sdkSessions is stale", async () => {
    const { useStore } = await import("./store.js");

    // Simulate stale sdkSessions list that doesn't include the current session.
    useStore.setState({
      currentSessionId: "test-1",
      sdkSessions: [],
    });

    connectSession("test-1");
    expect(wsInstances).toHaveLength(1);

    // Hidden + close: no reconnect while hidden
    Object.defineProperty(document, "hidden", { value: true, configurable: true });
    for (const fn of visibilityListeners) fn();
    wsInstances[0].onclose?.();
    vi.advanceTimersByTime(5_000);
    expect(wsInstances).toHaveLength(1);

    // Visible: should reconnect from currentSessionId fallback.
    Object.defineProperty(document, "hidden", { value: false, configurable: true });
    for (const fn of visibilityListeners) fn();
    expect(wsInstances).toHaveLength(2);
  });
});
