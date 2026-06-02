import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  parseBrowserMessage,
  deduplicateBrowserMessage,
  IDEMPOTENT_BROWSER_MESSAGE_TYPES,
} from "./ws-bridge-browser-ingest.js";
import type { Session } from "./ws-bridge-types.js";
import { SessionStateMachine } from "./session-state-machine.js";

function makeDedupSession(): Session {
  return {
    id: "test-session",
    backendType: "claude",
    backendAdapter: null,
    browserSockets: new Set(),
    state: {} as any,
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
  };
}

// ─── parseBrowserMessage ──────────────────────────────────────────────────────

describe("parseBrowserMessage", () => {
  it("parses valid JSON into BrowserOutgoingMessage", () => {
    const raw = '{"type":"user_message","content":"hello"}';
    const msg = parseBrowserMessage(raw);
    expect(msg).toEqual({ type: "user_message", content: "hello" });
  });

  it("returns null for malformed JSON", () => {
    // Suppress the console.warn from parseBrowserMessage
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(parseBrowserMessage("{invalid")).toBeNull();
    vi.restoreAllMocks();
  });

  it("returns null for empty string", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(parseBrowserMessage("")).toBeNull();
    vi.restoreAllMocks();
  });

  it("handles Buffer input", () => {
    const raw = Buffer.from('{"type":"interrupt"}', "utf-8");
    const msg = parseBrowserMessage(raw);
    expect(msg).toEqual({ type: "interrupt" });
  });

  it("handles complex message types", () => {
    const raw = JSON.stringify({
      type: "permission_response",
      request_id: "req-1",
      behavior: "allow",
      client_msg_id: "cmid-1",
    });
    const msg = parseBrowserMessage(raw);
    expect(msg).toEqual({
      type: "permission_response",
      request_id: "req-1",
      behavior: "allow",
      client_msg_id: "cmid-1",
    });
  });
});

// ─── deduplicateBrowserMessage ────────────────────────────────────────────────

describe("deduplicateBrowserMessage", () => {
  let session: Session;
  let persistFn: ReturnType<typeof vi.fn<(session: Session) => void>>;

  beforeEach(() => {
    session = makeDedupSession();
    persistFn = vi.fn<(session: Session) => void>();
  });

  it("returns false for first occurrence of a message with client_msg_id", () => {
    const msg = { type: "user_message" as const, content: "hello", client_msg_id: "id-1" };
    const result = deduplicateBrowserMessage(
      msg, IDEMPOTENT_BROWSER_MESSAGE_TYPES, session, 100, persistFn,
    );
    expect(result).toBe(false);
  });

  it("returns true for duplicate message with same client_msg_id", () => {
    const msg = { type: "user_message" as const, content: "hello", client_msg_id: "id-1" };

    // First call: not a duplicate
    deduplicateBrowserMessage(msg, IDEMPOTENT_BROWSER_MESSAGE_TYPES, session, 100, persistFn);
    // Second call: duplicate
    const result = deduplicateBrowserMessage(
      msg, IDEMPOTENT_BROWSER_MESSAGE_TYPES, session, 100, persistFn,
    );
    expect(result).toBe(true);
  });

  it("returns false for messages without client_msg_id", () => {
    const msg = { type: "user_message" as const, content: "hello" };

    // No client_msg_id — never considered duplicate
    expect(deduplicateBrowserMessage(msg, IDEMPOTENT_BROWSER_MESSAGE_TYPES, session, 100, persistFn)).toBe(false);
    expect(deduplicateBrowserMessage(msg, IDEMPOTENT_BROWSER_MESSAGE_TYPES, session, 100, persistFn)).toBe(false);
  });

  it("returns false for messages with empty client_msg_id", () => {
    const msg = { type: "user_message" as const, content: "hello", client_msg_id: "" };

    expect(deduplicateBrowserMessage(msg, IDEMPOTENT_BROWSER_MESSAGE_TYPES, session, 100, persistFn)).toBe(false);
    expect(deduplicateBrowserMessage(msg, IDEMPOTENT_BROWSER_MESSAGE_TYPES, session, 100, persistFn)).toBe(false);
  });

  it("returns false for non-idempotent message types even with client_msg_id", () => {
    // session_subscribe and session_ack are not in IDEMPOTENT_BROWSER_MESSAGE_TYPES
    const msg = { type: "session_subscribe" as const, last_seq: 0, client_msg_id: "id-1" } as any;

    expect(deduplicateBrowserMessage(msg, IDEMPOTENT_BROWSER_MESSAGE_TYPES, session, 100, persistFn)).toBe(false);
    // Same message again — still not deduplicated because type is not idempotent
    expect(deduplicateBrowserMessage(msg, IDEMPOTENT_BROWSER_MESSAGE_TYPES, session, 100, persistFn)).toBe(false);
  });

  it("calls persistFn when remembering a new client_msg_id", () => {
    const msg = { type: "interrupt" as const, client_msg_id: "id-1" };
    deduplicateBrowserMessage(msg, IDEMPOTENT_BROWSER_MESSAGE_TYPES, session, 100, persistFn);

    expect(persistFn).toHaveBeenCalledWith(session);
  });

  it("does not call persistFn for duplicate messages", () => {
    const msg = { type: "interrupt" as const, client_msg_id: "id-1" };
    deduplicateBrowserMessage(msg, IDEMPOTENT_BROWSER_MESSAGE_TYPES, session, 100, persistFn);
    persistFn.mockClear();

    // Second call — duplicate, should not persist
    deduplicateBrowserMessage(msg, IDEMPOTENT_BROWSER_MESSAGE_TYPES, session, 100, persistFn);
    expect(persistFn).not.toHaveBeenCalled();
  });

  it("deduplicates within each idempotent message type", () => {
    // Verify each idempotent type is individually deduped by client_msg_id
    const types = Array.from(IDEMPOTENT_BROWSER_MESSAGE_TYPES);
    for (const type of types) {
      const msg = { type, client_msg_id: `${type}-id` } as any;
      expect(deduplicateBrowserMessage(msg, IDEMPOTENT_BROWSER_MESSAGE_TYPES, session, 100, persistFn)).toBe(false);
      expect(deduplicateBrowserMessage(msg, IDEMPOTENT_BROWSER_MESSAGE_TYPES, session, 100, persistFn)).toBe(true);
    }
  });

  it("deduplicates across different idempotent message types with same client_msg_id", () => {
    // A shared client_msg_id should be deduplicated regardless of which
    // idempotent type sends it — the dedup namespace is type-agnostic.
    const sharedId = "shared-cross-type-id";
    const msg1 = { type: "user_message" as const, content: "hello", client_msg_id: sharedId };
    expect(deduplicateBrowserMessage(msg1, IDEMPOTENT_BROWSER_MESSAGE_TYPES, session, 100, persistFn)).toBe(false);

    // Same client_msg_id from a different idempotent type — should be filtered
    const msg2 = { type: "interrupt" as const, client_msg_id: sharedId };
    expect(deduplicateBrowserMessage(msg2, IDEMPOTENT_BROWSER_MESSAGE_TYPES, session, 100, persistFn)).toBe(true);
  });

  it("enforces window cap by evicting oldest client_msg_ids", () => {
    const windowSize = 3;

    // Fill window with 3 IDs
    for (let i = 0; i < 3; i++) {
      const msg = { type: "user_message" as const, content: "", client_msg_id: `id-${i}` };
      deduplicateBrowserMessage(msg, IDEMPOTENT_BROWSER_MESSAGE_TYPES, session, windowSize, persistFn);
    }

    // Add a 4th — should evict id-0
    const msg4 = { type: "user_message" as const, content: "", client_msg_id: "id-3" };
    deduplicateBrowserMessage(msg4, IDEMPOTENT_BROWSER_MESSAGE_TYPES, session, windowSize, persistFn);

    // id-0 should no longer be considered a duplicate (evicted)
    const msg0 = { type: "user_message" as const, content: "", client_msg_id: "id-0" };
    expect(deduplicateBrowserMessage(msg0, IDEMPOTENT_BROWSER_MESSAGE_TYPES, session, windowSize, persistFn)).toBe(false);

    // id-1 should still be a duplicate...
    // But adding id-0 back means window is now [id-2, id-3, id-0], so id-1 is evicted
  });

  describe("reconnect scenarios", () => {
    it("filters resent user_message after browser reconnect", () => {
      // Browser sends user_message with client_msg_id, disconnects, reconnects,
      // and resends the same message. Should be filtered.
      const msg = { type: "user_message" as const, content: "hello", client_msg_id: "msg-1" };

      // Original send
      expect(deduplicateBrowserMessage(msg, IDEMPOTENT_BROWSER_MESSAGE_TYPES, session, 100, persistFn)).toBe(false);

      // After reconnect: same message resent
      expect(deduplicateBrowserMessage(msg, IDEMPOTENT_BROWSER_MESSAGE_TYPES, session, 100, persistFn)).toBe(true);
    });

    it("filters resent permission_response after browser reconnect", () => {
      const msg = {
        type: "permission_response" as const,
        request_id: "req-1",
        behavior: "allow" as const,
        client_msg_id: "perm-1",
      };

      expect(deduplicateBrowserMessage(msg, IDEMPOTENT_BROWSER_MESSAGE_TYPES, session, 100, persistFn)).toBe(false);
      expect(deduplicateBrowserMessage(msg, IDEMPOTENT_BROWSER_MESSAGE_TYPES, session, 100, persistFn)).toBe(true);
    });

    it("two browsers with same client_msg_id — second is filtered", () => {
      // If two browsers somehow send the same client_msg_id (e.g., copied tab),
      // the second should be filtered to ensure idempotency.
      const msg = { type: "user_message" as const, content: "hello", client_msg_id: "shared-id" };

      // Browser A sends
      expect(deduplicateBrowserMessage(msg, IDEMPOTENT_BROWSER_MESSAGE_TYPES, session, 100, persistFn)).toBe(false);
      // Browser B sends same client_msg_id
      expect(deduplicateBrowserMessage(msg, IDEMPOTENT_BROWSER_MESSAGE_TYPES, session, 100, persistFn)).toBe(true);
    });

    it("dedup survives server restart via processedClientMessageIds persistence", () => {
      // This tests the critical path: browser sends message → server persists
      // processedClientMessageIds → server restarts → session restored from disk
      // → browser retransmits same message → dedup fires.
      //
      // Step 1: Process a message (simulates pre-restart state)
      const msg = { type: "user_message" as const, content: "hello", client_msg_id: "restart-id-1" };
      expect(deduplicateBrowserMessage(msg, IDEMPOTENT_BROWSER_MESSAGE_TYPES, session, 100, persistFn)).toBe(false);

      // Step 2: Simulate server restart — create a new session restored from disk.
      // restoreFromDisk reconstructs processedClientMessageIdSet from the persisted
      // processedClientMessageIds array (see WsBridge.restoreFromDisk).
      const restoredSession = makeDedupSession();
      restoredSession.processedClientMessageIds = [...session.processedClientMessageIds];
      restoredSession.processedClientMessageIdSet = new Set(session.processedClientMessageIds);

      // Step 3: Browser retransmits the same message after reconnecting
      const result = deduplicateBrowserMessage(msg, IDEMPOTENT_BROWSER_MESSAGE_TYPES, restoredSession, 100, persistFn);
      expect(result).toBe(true); // Should be deduplicated

      // Step 4: A new message should still pass through
      const newMsg = { type: "user_message" as const, content: "world", client_msg_id: "restart-id-2" };
      expect(deduplicateBrowserMessage(newMsg, IDEMPOTENT_BROWSER_MESSAGE_TYPES, restoredSession, 100, persistFn)).toBe(false);
    });
  });
});

// ─── IDEMPOTENT_BROWSER_MESSAGE_TYPES ─────────────────────────────────────────

describe("IDEMPOTENT_BROWSER_MESSAGE_TYPES", () => {
  it("contains the expected message types", () => {
    const expected = [
      "user_message", "permission_response", "interrupt", "set_model",
      "set_permission_mode", "mcp_get_status", "mcp_toggle", "mcp_reconnect",
      "mcp_set_servers", "set_ai_validation",
    ];
    for (const type of expected) {
      expect(IDEMPOTENT_BROWSER_MESSAGE_TYPES.has(type)).toBe(true);
    }
  });

  it("does not contain session_subscribe or session_ack", () => {
    // These are session management messages, not idempotent user actions
    expect(IDEMPOTENT_BROWSER_MESSAGE_TYPES.has("session_subscribe")).toBe(false);
    expect(IDEMPOTENT_BROWSER_MESSAGE_TYPES.has("session_ack")).toBe(false);
  });
});
