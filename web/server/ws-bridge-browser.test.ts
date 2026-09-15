import { vi, describe, it, expect, beforeEach } from "vitest";
import { handleSessionSubscribe, handleSessionAck } from "./ws-bridge-browser.js";
import type { ServerWebSocket } from "bun";
import type { BrowserSocketData, Session, SocketData } from "./ws-bridge-types.js";
import type { BrowserIncomingMessage, ReplayableBrowserIncomingMessage } from "./session-types.js";

/**
 * Tests for ws-bridge-browser — the module that handles browser WebSocket
 * subscription (event replay, gap detection, history resend) and ack tracking.
 *
 * Key behaviors tested:
 * - handleSessionSubscribe: message_history send, event_replay, gap detection,
 *   status correction via inferCliStatus, session_phase broadcast
 * - handleSessionAck: seq tracking on ws.data and session, persistence trigger
 */

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeWs(overrides?: Partial<BrowserSocketData>): ServerWebSocket<SocketData> {
  const wsData: BrowserSocketData = {
    kind: "browser",
    sessionId: "test-session",
    subscribed: false,
    lastAckSeq: 0,
    ...overrides,
  };
  return {
    send: vi.fn(),
    data: wsData,
  } as unknown as ServerWebSocket<SocketData>;
}

/** Creates a minimal Session object with sensible defaults for testing */
function makeSession(overrides?: Partial<Session>): Session {
  return {
    id: "test-session",
    backendType: "claude",
    backendAdapter: null,
    browserSockets: new Set(),
    state: {
      session_id: "test-session",
      backend_type: "claude",
      is_compacting: false,
    } as any,
    pendingPermissions: new Map(),
    messageHistory: [],
    pendingMessages: [],
    nextEventSeq: 1,
    eventBuffer: [],
    lastAckSeq: 0,
    processedClientMessageIds: [],
    processedClientMessageIdSet: new Set(),
    lastCliActivityTs: 0,
    stateMachine: { phase: "ready" } as any,
    ...overrides,
  };
}

const mockSendToBrowser = vi.fn();
const mockIsHistoryBacked = vi.fn(() => false);

beforeEach(() => {
  vi.clearAllMocks();
});

// ── handleSessionSubscribe ──────────────────────────────────────────────────

describe("handleSessionSubscribe", () => {
  it("should_noop_when_ws_is_undefined", () => {
    const session = makeSession();
    // Should not throw
    handleSessionSubscribe(session, undefined, 0, mockSendToBrowser, mockIsHistoryBacked);
    expect(mockSendToBrowser).not.toHaveBeenCalled();
  });

  it("should_set_subscribed_true_on_ws_data", () => {
    const ws = makeWs();
    const session = makeSession();
    handleSessionSubscribe(session, ws, 0, mockSendToBrowser, mockIsHistoryBacked);
    expect((ws.data as BrowserSocketData).subscribed).toBe(true);
  });

  it("should_normalize_lastSeq_to_zero_when_negative", () => {
    const ws = makeWs();
    const session = makeSession();
    handleSessionSubscribe(session, ws, -5, mockSendToBrowser, mockIsHistoryBacked);
    expect((ws.data as BrowserSocketData).lastAckSeq).toBe(0);
  });

  it("should_normalize_lastSeq_to_zero_when_NaN", () => {
    const ws = makeWs();
    const session = makeSession();
    handleSessionSubscribe(session, ws, NaN, mockSendToBrowser, mockIsHistoryBacked);
    expect((ws.data as BrowserSocketData).lastAckSeq).toBe(0);
  });

  it("should_floor_fractional_lastSeq", () => {
    const ws = makeWs();
    const session = makeSession();
    handleSessionSubscribe(session, ws, 5.7, mockSendToBrowser, mockIsHistoryBacked);
    expect((ws.data as BrowserSocketData).lastAckSeq).toBe(5);
  });

  // ── message_history send on fresh subscribe ───────────────────────────────

  it("should_send_message_history_when_lastSeq_is_zero_and_history_exists", () => {
    const ws = makeWs();
    const history = [{ type: "result", content: "hello" }] as any[];
    const session = makeSession({ messageHistory: history });

    handleSessionSubscribe(session, ws, 0, mockSendToBrowser, mockIsHistoryBacked);

    expect(mockSendToBrowser).toHaveBeenCalledWith(ws, {
      type: "message_history",
      messages: history,
    });
  });

  it("should_not_send_message_history_when_history_is_empty", () => {
    const ws = makeWs();
    const session = makeSession({ messageHistory: [] });

    handleSessionSubscribe(session, ws, 0, mockSendToBrowser, mockIsHistoryBacked);

    const historyCall = mockSendToBrowser.mock.calls.find(
      (c: any[]) => c[1].type === "message_history",
    );
    expect(historyCall).toBeUndefined();
  });

  // ── Early return when no events to replay ─────────────────────────────────

  it("should_return_early_when_event_buffer_is_empty", () => {
    const ws = makeWs();
    const session = makeSession({
      messageHistory: [{ type: "result" }] as any[],
      eventBuffer: [],
    });

    handleSessionSubscribe(session, ws, 0, mockSendToBrowser, mockIsHistoryBacked);

    // Only message_history should be sent, no event_replay
    const replayCalls = mockSendToBrowser.mock.calls.filter(
      (c: any[]) => c[1].type === "event_replay",
    );
    expect(replayCalls).toHaveLength(0);
  });

  it("should_return_early_when_already_caught_up", () => {
    const ws = makeWs();
    const session = makeSession({
      nextEventSeq: 10,
      eventBuffer: [{ seq: 9, message: { type: "assistant" } as any }],
    });

    // lastSeq >= nextEventSeq - 1 means fully caught up
    handleSessionSubscribe(session, ws, 9, mockSendToBrowser, mockIsHistoryBacked);

    const replayCalls = mockSendToBrowser.mock.calls.filter(
      (c: any[]) => c[1].type === "event_replay",
    );
    expect(replayCalls).toHaveLength(0);
  });

  // ── Event replay (no gap) ─────────────────────────────────────────────────

  it("should_send_event_replay_when_missed_events_exist", () => {
    const ws = makeWs();
    const events = [
      { seq: 5, message: { type: "assistant" } as any },
      { seq: 6, message: { type: "result" } as any },
    ];
    const session = makeSession({
      nextEventSeq: 7,
      eventBuffer: events,
    });

    // Client has seq 4, so events 5 and 6 are missed
    handleSessionSubscribe(session, ws, 4, mockSendToBrowser, mockIsHistoryBacked);

    const replayCall = mockSendToBrowser.mock.calls.find(
      (c: any[]) => c[1].type === "event_replay",
    );
    expect(replayCall).toBeDefined();
    expect(replayCall![1].events).toEqual(events);
  });

  it("should_send_status_change_and_session_phase_after_replay", () => {
    const ws = makeWs();
    const session = makeSession({
      nextEventSeq: 5,
      eventBuffer: [{ seq: 3, message: { type: "assistant" } as any }],
      stateMachine: { phase: "streaming" } as any,
    });

    handleSessionSubscribe(session, ws, 2, mockSendToBrowser, mockIsHistoryBacked);

    const types = mockSendToBrowser.mock.calls.map((c: any[]) => c[1].type);
    expect(types).toContain("status_change");
    expect(types).toContain("session_phase");

    const phaseMsg = mockSendToBrowser.mock.calls.find(
      (c: any[]) => c[1].type === "session_phase",
    );
    expect(phaseMsg![1].phase).toBe("streaming");
  });

  it("should_filter_history_backed_events_when_full_history_already_sent", () => {
    const ws = makeWs();
    const historyBackedMsg = { type: "result" } as any;
    const transientMsg = { type: "stream_event" } as any;
    const events = [
      { seq: 2, message: historyBackedMsg },
      { seq: 3, message: transientMsg },
    ];
    const session = makeSession({
      messageHistory: [{ type: "result" }] as any[],
      nextEventSeq: 4,
      eventBuffer: events,
    });

    // Mark result as history-backed so it gets filtered when history was sent
    mockIsHistoryBacked.mockImplementation((msg: any) => msg.type === "result");

    // lastSeq=0 → full history sent → history-backed events filtered from replay
    handleSessionSubscribe(session, ws, 0, mockSendToBrowser, mockIsHistoryBacked);

    const replayCall = mockSendToBrowser.mock.calls.find(
      (c: any[]) => c[1].type === "event_replay",
    );
    expect(replayCall).toBeDefined();
    // Only the transient event should be in the replay
    expect(replayCall![1].events).toEqual([{ seq: 3, message: transientMsg }]);
  });

  // ── Gap detection ─────────────────────────────────────────────────────────

  it("should_resend_full_history_when_gap_detected", () => {
    const ws = makeWs();
    const history = [{ type: "assistant", content: "old" }] as any[];
    const events = [
      // Earliest event is seq 10, but client only has seq 5 → gap (5 < 10-1)
      { seq: 10, message: { type: "stream_event" } as any },
    ];
    const session = makeSession({
      messageHistory: history,
      nextEventSeq: 11,
      eventBuffer: events,
    });

    handleSessionSubscribe(session, ws, 5, mockSendToBrowser, mockIsHistoryBacked);

    // Should resend full history due to gap
    const historyCall = mockSendToBrowser.mock.calls.find(
      (c: any[]) => c[1].type === "message_history",
    );
    expect(historyCall).toBeDefined();
    expect(historyCall![1].messages).toEqual(history);
  });

  it("should_replay_only_transient_events_when_gap_detected", () => {
    const ws = makeWs();
    const historyBackedMsg = { type: "result" } as any;
    const transientMsg = { type: "stream_event" } as any;
    const events = [
      { seq: 10, message: historyBackedMsg },
      { seq: 11, message: transientMsg },
    ];
    const session = makeSession({
      messageHistory: [{ type: "result" }] as any[],
      nextEventSeq: 12,
      eventBuffer: events,
    });

    mockIsHistoryBacked.mockImplementation((msg: any) => msg.type === "result");

    // Gap: client has seq 5, earliest buffer is 10
    handleSessionSubscribe(session, ws, 5, mockSendToBrowser, mockIsHistoryBacked);

    const replayCall = mockSendToBrowser.mock.calls.find(
      (c: any[]) => c[1].type === "event_replay",
    );
    expect(replayCall).toBeDefined();
    // Only transient (non-history-backed) events in the replay
    expect(replayCall![1].events).toEqual([{ seq: 11, message: transientMsg }]);
  });

  // ── inferCliStatus (tested indirectly via status_change) ──────────────────

  it("should_infer_idle_status_when_last_message_is_result", () => {
    const ws = makeWs();
    const session = makeSession({
      messageHistory: [{ type: "result" }] as any[],
      nextEventSeq: 3,
      eventBuffer: [{ seq: 2, message: { type: "result" } as any }],
    });

    handleSessionSubscribe(session, ws, 1, mockSendToBrowser, mockIsHistoryBacked);

    const statusCall = mockSendToBrowser.mock.calls.find(
      (c: any[]) => c[1].type === "status_change",
    );
    expect(statusCall![1].status).toBe("idle");
  });

  it("should_infer_running_status_when_last_message_is_assistant", () => {
    const ws = makeWs();
    const session = makeSession({
      messageHistory: [{ type: "assistant" }] as any[],
      nextEventSeq: 3,
      eventBuffer: [{ seq: 2, message: { type: "assistant" } as any }],
    });

    handleSessionSubscribe(session, ws, 1, mockSendToBrowser, mockIsHistoryBacked);

    const statusCall = mockSendToBrowser.mock.calls.find(
      (c: any[]) => c[1].type === "status_change",
    );
    expect(statusCall![1].status).toBe("running");
  });

  it("should_infer_compacting_status_when_session_state_is_compacting", () => {
    const ws = makeWs();
    const session = makeSession({
      state: { session_id: "x", backend_type: "claude", is_compacting: true } as any,
      messageHistory: [{ type: "result" }] as any[],
      nextEventSeq: 3,
      eventBuffer: [{ seq: 2, message: { type: "result" } as any }],
    });

    handleSessionSubscribe(session, ws, 1, mockSendToBrowser, mockIsHistoryBacked);

    const statusCall = mockSendToBrowser.mock.calls.find(
      (c: any[]) => c[1].type === "status_change",
    );
    expect(statusCall![1].status).toBe("compacting");
  });

  it("should_infer_idle_when_message_history_is_empty", () => {
    const ws = makeWs();
    const session = makeSession({
      messageHistory: [],
      nextEventSeq: 3,
      eventBuffer: [{ seq: 2, message: { type: "stream_event" } as any }],
    });

    handleSessionSubscribe(session, ws, 1, mockSendToBrowser, mockIsHistoryBacked);

    const statusCall = mockSendToBrowser.mock.calls.find(
      (c: any[]) => c[1].type === "status_change",
    );
    expect(statusCall![1].status).toBe("idle");
  });

  it("should_not_send_replay_when_missed_events_are_empty_after_filtering", () => {
    const ws = makeWs();
    const historyBackedMsg = { type: "result" } as any;
    const session = makeSession({
      messageHistory: [{ type: "result" }] as any[],
      nextEventSeq: 3,
      eventBuffer: [{ seq: 2, message: historyBackedMsg }],
    });

    // All events are history-backed → replay is empty after filtering
    mockIsHistoryBacked.mockReturnValue(true);

    handleSessionSubscribe(session, ws, 0, mockSendToBrowser, mockIsHistoryBacked);

    const replayCalls = mockSendToBrowser.mock.calls.filter(
      (c: any[]) => c[1].type === "event_replay",
    );
    expect(replayCalls).toHaveLength(0);
  });
});

// ── handleSessionAck ──────────────────────────────────────────────────────────

describe("handleSessionAck", () => {
  it("should_update_ws_data_lastAckSeq_when_higher_seq_received", () => {
    const ws = makeWs({ lastAckSeq: 3 });
    const session = makeSession({ lastAckSeq: 3 });
    const mockPersist = vi.fn();

    handleSessionAck(session, ws, 7, mockPersist);

    expect((ws.data as BrowserSocketData).lastAckSeq).toBe(7);
  });

  it("should_not_decrease_ws_data_lastAckSeq_when_lower_seq_received", () => {
    const ws = makeWs({ lastAckSeq: 10 });
    const session = makeSession({ lastAckSeq: 10 });
    const mockPersist = vi.fn();

    handleSessionAck(session, ws, 5, mockPersist);

    // Should keep the higher value
    expect((ws.data as BrowserSocketData).lastAckSeq).toBe(10);
  });

  it("should_update_session_lastAckSeq_and_persist_when_higher", () => {
    const ws = makeWs();
    const session = makeSession({ lastAckSeq: 3 });
    const mockPersist = vi.fn();

    handleSessionAck(session, ws, 8, mockPersist);

    expect(session.lastAckSeq).toBe(8);
    expect(mockPersist).toHaveBeenCalledWith(session);
  });

  it("should_not_persist_when_seq_is_not_higher_than_session", () => {
    const ws = makeWs();
    const session = makeSession({ lastAckSeq: 10 });
    const mockPersist = vi.fn();

    handleSessionAck(session, ws, 5, mockPersist);

    expect(session.lastAckSeq).toBe(10); // unchanged
    expect(mockPersist).not.toHaveBeenCalled();
  });

  it("should_normalize_NaN_to_zero", () => {
    const ws = makeWs({ lastAckSeq: 5 });
    const session = makeSession({ lastAckSeq: 5 });
    const mockPersist = vi.fn();

    handleSessionAck(session, ws, NaN, mockPersist);

    // NaN normalizes to 0, which is less than current 5 → no change
    expect((ws.data as BrowserSocketData).lastAckSeq).toBe(5);
    expect(session.lastAckSeq).toBe(5);
    expect(mockPersist).not.toHaveBeenCalled();
  });

  it("should_normalize_negative_seq_to_zero", () => {
    const ws = makeWs({ lastAckSeq: 0 });
    const session = makeSession({ lastAckSeq: 0 });
    const mockPersist = vi.fn();

    handleSessionAck(session, ws, -10, mockPersist);

    expect((ws.data as BrowserSocketData).lastAckSeq).toBe(0);
  });

  it("should_floor_fractional_seq_values", () => {
    const ws = makeWs({ lastAckSeq: 0 });
    const session = makeSession({ lastAckSeq: 0 });
    const mockPersist = vi.fn();

    handleSessionAck(session, ws, 7.9, mockPersist);

    expect((ws.data as BrowserSocketData).lastAckSeq).toBe(7);
    expect(session.lastAckSeq).toBe(7);
  });

  it("should_handle_ws_being_undefined", () => {
    const session = makeSession({ lastAckSeq: 3 });
    const mockPersist = vi.fn();

    // Should not throw and should still update session
    handleSessionAck(session, undefined, 8, mockPersist);

    expect(session.lastAckSeq).toBe(8);
    expect(mockPersist).toHaveBeenCalledWith(session);
  });

  it("should_handle_ws_data_without_prior_lastAckSeq", () => {
    // Simulate a ws.data where lastAckSeq was never set
    const ws = {
      send: vi.fn(),
      data: { kind: "browser", sessionId: "test" },
    } as unknown as ServerWebSocket<SocketData>;
    const session = makeSession({ lastAckSeq: 0 });
    const mockPersist = vi.fn();

    handleSessionAck(session, ws, 5, mockPersist);

    expect((ws.data as BrowserSocketData).lastAckSeq).toBe(5);
  });
});
