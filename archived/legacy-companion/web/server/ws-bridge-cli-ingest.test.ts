import { describe, it, expect } from "vitest";

// Stub Bun.hash for vitest (runs under Node, not Bun).
if (typeof globalThis.Bun === "undefined") {
  (globalThis as any).Bun = {
    hash(input: string | Uint8Array): number {
      const s = typeof input === "string" ? input : new TextDecoder().decode(input);
      let h = 0;
      for (let i = 0; i < s.length; i++) {
        h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
      }
      return h >>> 0;
    },
  };
}

import { parseNDJSON, isDuplicateCLIMessage, type CLIDedupState } from "./ws-bridge-cli-ingest.js";
import type { CLIMessage } from "./session-types.js";

function makeDedupState(): CLIDedupState {
  return {
    recentCLIMessageHashes: [],
    recentCLIMessageHashSet: new Set(),
  };
}

// ─── parseNDJSON ──────────────────────────────────────────────────────────────

describe("parseNDJSON", () => {
  it("returns empty array for empty string", () => {
    expect(parseNDJSON("")).toEqual([]);
  });

  it("returns empty array for whitespace-only input", () => {
    expect(parseNDJSON("  \n  \n  ")).toEqual([]);
  });

  it("parses a single JSON line", () => {
    const line = '{"type":"system","subtype":"init"}';
    expect(parseNDJSON(line)).toEqual([line]);
  });

  it("parses multiple JSON lines separated by newlines", () => {
    const line1 = '{"type":"assistant","message":{}}';
    const line2 = '{"type":"result","data":{}}';
    const input = `${line1}\n${line2}`;
    expect(parseNDJSON(input)).toEqual([line1, line2]);
  });

  it("filters blank lines between valid JSON", () => {
    const line1 = '{"type":"system"}';
    const line2 = '{"type":"result"}';
    const input = `${line1}\n\n\n${line2}\n`;
    expect(parseNDJSON(input)).toEqual([line1, line2]);
  });

  it("handles Buffer input", () => {
    const line = '{"type":"assistant"}';
    const buffer = Buffer.from(line, "utf-8");
    expect(parseNDJSON(buffer)).toEqual([line]);
  });

  it("handles multi-line NDJSON with trailing newline", () => {
    const input = '{"a":1}\n{"b":2}\n';
    expect(parseNDJSON(input)).toEqual(['{"a":1}', '{"b":2}']);
  });
});

// ─── isDuplicateCLIMessage ────────────────────────────────────────────────────

describe("isDuplicateCLIMessage", () => {
  describe("assistant/result/system messages (hash-based dedup)", () => {
    it("returns false for first occurrence", () => {
      const state = makeDedupState();
      const line = '{"type":"assistant","message":{}}';
      const msg: CLIMessage = { type: "assistant" } as any;
      expect(isDuplicateCLIMessage(msg, line, state, 100)).toBe(false);
    });

    it("returns true for duplicate assistant message", () => {
      const state = makeDedupState();
      const line = '{"type":"assistant","message":{"id":"m1"}}';
      const msg: CLIMessage = { type: "assistant" } as any;

      // First occurrence — not duplicate
      expect(isDuplicateCLIMessage(msg, line, state, 100)).toBe(false);
      // Same content again — duplicate
      expect(isDuplicateCLIMessage(msg, line, state, 100)).toBe(true);
    });

    it("returns true for duplicate result message", () => {
      const state = makeDedupState();
      const line = '{"type":"result","num_turns":3}';
      const msg: CLIMessage = { type: "result" } as any;

      expect(isDuplicateCLIMessage(msg, line, state, 100)).toBe(false);
      expect(isDuplicateCLIMessage(msg, line, state, 100)).toBe(true);
    });

    it("returns true for duplicate system message", () => {
      const state = makeDedupState();
      const line = '{"type":"system","subtype":"init","model":"claude"}';
      const msg: CLIMessage = { type: "system", subtype: "init" } as any;

      expect(isDuplicateCLIMessage(msg, line, state, 100)).toBe(false);
      expect(isDuplicateCLIMessage(msg, line, state, 100)).toBe(true);
    });

    it("different content is not a duplicate", () => {
      const state = makeDedupState();
      const msg: CLIMessage = { type: "assistant" } as any;

      expect(isDuplicateCLIMessage(msg, '{"type":"assistant","id":"1"}', state, 100)).toBe(false);
      expect(isDuplicateCLIMessage(msg, '{"type":"assistant","id":"2"}', state, 100)).toBe(false);
    });
  });

  describe("stream_event messages (uuid-based dedup)", () => {
    it("returns false for first occurrence with uuid", () => {
      const state = makeDedupState();
      const line = '{"type":"stream_event","uuid":"evt-1"}';
      const msg = { type: "stream_event", uuid: "evt-1" } as CLIMessage;

      expect(isDuplicateCLIMessage(msg, line, state, 100)).toBe(false);
    });

    it("returns true for duplicate stream_event with same uuid", () => {
      const state = makeDedupState();
      const line = '{"type":"stream_event","uuid":"evt-1"}';
      const msg = { type: "stream_event", uuid: "evt-1" } as CLIMessage;

      expect(isDuplicateCLIMessage(msg, line, state, 100)).toBe(false);
      expect(isDuplicateCLIMessage(msg, line, state, 100)).toBe(true);
    });

    it("different uuids are not duplicates", () => {
      const state = makeDedupState();
      const msg1 = { type: "stream_event", uuid: "evt-1" } as CLIMessage;
      const msg2 = { type: "stream_event", uuid: "evt-2" } as CLIMessage;

      expect(isDuplicateCLIMessage(msg1, "", state, 100)).toBe(false);
      expect(isDuplicateCLIMessage(msg2, "", state, 100)).toBe(false);
    });

    it("stream_event without uuid is never considered a duplicate", () => {
      const state = makeDedupState();
      const msg = { type: "stream_event" } as CLIMessage;

      // Same message twice without uuid — both pass through
      expect(isDuplicateCLIMessage(msg, '{"type":"stream_event"}', state, 100)).toBe(false);
      expect(isDuplicateCLIMessage(msg, '{"type":"stream_event"}', state, 100)).toBe(false);
    });
  });

  describe("types that skip dedup", () => {
    it.each([
      "keep_alive",
      "control_request",
      "control_response",
      "tool_progress",
      "tool_use_summary",
      "auth_status",
    ])("'%s' messages are never deduplicated", (type) => {
      const state = makeDedupState();
      const msg = { type } as CLIMessage;
      const line = JSON.stringify(msg);

      // Same message twice — both pass through
      expect(isDuplicateCLIMessage(msg, line, state, 100)).toBe(false);
      expect(isDuplicateCLIMessage(msg, line, state, 100)).toBe(false);
    });
  });

  describe("window eviction", () => {
    it("evicts oldest hash when window size is exceeded", () => {
      const state = makeDedupState();
      const windowSize = 3;

      // Fill the window with 3 messages
      const lines = ["msg-A", "msg-B", "msg-C"];
      for (const line of lines) {
        isDuplicateCLIMessage({ type: "assistant" } as any, line, state, windowSize);
      }
      expect(state.recentCLIMessageHashes).toHaveLength(3);

      // Add a 4th — should evict "msg-A"
      isDuplicateCLIMessage({ type: "assistant" } as any, "msg-D", state, windowSize);
      expect(state.recentCLIMessageHashes).toHaveLength(3);

      // "msg-A" should no longer be considered a duplicate (evicted from window)
      expect(isDuplicateCLIMessage({ type: "assistant" } as any, "msg-A", state, windowSize)).toBe(false);
      // "msg-B" should still be a duplicate (still in window... unless evicted by adding msg-A back)
      // After adding msg-A back, window is [msg-C, msg-D, msg-A], so msg-B is evicted
    });

    it("maintains correct window size under heavy traffic", () => {
      const state = makeDedupState();
      const windowSize = 10;

      // Send 50 unique messages
      for (let i = 0; i < 50; i++) {
        isDuplicateCLIMessage(
          { type: "assistant" } as any,
          `message-${i}`,
          state,
          windowSize,
        );
      }

      // Window should cap at windowSize
      expect(state.recentCLIMessageHashes).toHaveLength(windowSize);
      expect(state.recentCLIMessageHashSet.size).toBe(windowSize);
    });
  });

  describe("reconnect scenarios", () => {
    it("filters all replayed messages after CLI reconnect", () => {
      // Simulate: CLI sends 10 messages, then reconnects and replays all 10.
      // All replayed messages should be filtered as duplicates.
      const state = makeDedupState();
      const messages = Array.from({ length: 10 }, (_, i) => ({
        line: `{"type":"assistant","id":"${i}"}`,
        msg: { type: "assistant" } as CLIMessage,
      }));

      // First send: all unique
      for (const { line, msg } of messages) {
        expect(isDuplicateCLIMessage(msg, line, state, 100)).toBe(false);
      }

      // Replay (reconnect): all duplicates
      for (const { line, msg } of messages) {
        expect(isDuplicateCLIMessage(msg, line, state, 100)).toBe(true);
      }
    });

    it("filters replayed messages but passes new ones after partial overlap", () => {
      // Simulate: CLI sends messages 0-9, reconnects, replays messages 5-9
      // plus sends new messages 10-14. Messages 5-9 should be filtered,
      // messages 10-14 should pass through.
      const state = makeDedupState();
      const allLines = Array.from({ length: 15 }, (_, i) =>
        `{"type":"assistant","content":"msg-${i}"}`,
      );

      // Original send: messages 0-9
      for (let i = 0; i < 10; i++) {
        isDuplicateCLIMessage({ type: "assistant" } as CLIMessage, allLines[i], state, 100);
      }

      // Reconnect: replay 5-9 (duplicate) + new 10-14 (unique)
      const replayResults: boolean[] = [];
      for (let i = 5; i < 15; i++) {
        replayResults.push(
          isDuplicateCLIMessage({ type: "assistant" } as CLIMessage, allLines[i], state, 100),
        );
      }

      // First 5 (indices 5-9) should be duplicates
      expect(replayResults.slice(0, 5)).toEqual([true, true, true, true, true]);
      // Last 5 (indices 10-14) should be new
      expect(replayResults.slice(5, 10)).toEqual([false, false, false, false, false]);
    });

    it("filters replayed stream_events by uuid after reconnect", () => {
      const state = makeDedupState();

      // Original: 5 stream_events
      for (let i = 0; i < 5; i++) {
        const msg = { type: "stream_event", uuid: `uuid-${i}` } as CLIMessage;
        expect(isDuplicateCLIMessage(msg, "", state, 100)).toBe(false);
      }

      // Reconnect replay: same 5 stream_events + 3 new ones
      for (let i = 0; i < 5; i++) {
        const msg = { type: "stream_event", uuid: `uuid-${i}` } as CLIMessage;
        expect(isDuplicateCLIMessage(msg, "", state, 100)).toBe(true);
      }
      for (let i = 5; i < 8; i++) {
        const msg = { type: "stream_event", uuid: `uuid-${i}` } as CLIMessage;
        expect(isDuplicateCLIMessage(msg, "", state, 100)).toBe(false);
      }
    });

    it("shares dedup window between assistant messages and stream_events", () => {
      // The dedup state is shared — stream_event uuids and message hashes
      // live in the same rolling window. Verify they don't interfere.
      const state = makeDedupState();

      // Mix of types
      const assistantLine = '{"type":"assistant","content":"hello"}';
      isDuplicateCLIMessage({ type: "assistant" } as CLIMessage, assistantLine, state, 100);

      const streamMsg = { type: "stream_event", uuid: "evt-1" } as CLIMessage;
      isDuplicateCLIMessage(streamMsg, "", state, 100);

      // Both should be deduplicated on replay
      expect(isDuplicateCLIMessage({ type: "assistant" } as CLIMessage, assistantLine, state, 100)).toBe(true);
      expect(isDuplicateCLIMessage(streamMsg, "", state, 100)).toBe(true);
    });
  });
});
