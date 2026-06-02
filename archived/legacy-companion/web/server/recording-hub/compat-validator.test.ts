import { describe, it, expect } from "vitest";
import { validateRecording, compareRecordings } from "./compat-validator.js";
import type { Recording } from "../replay.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeRecording(browserMessages: Record<string, unknown>[]): Recording {
  return {
    header: {
      _header: true as const,
      version: 1 as const,
      session_id: "test",
      backend_type: "claude" as const,
      started_at: 0,
      cwd: "/",
    },
    entries: browserMessages.map((msg, i) => ({
      ts: i * 100,
      dir: "out" as const,
      raw: JSON.stringify(msg),
      ch: "browser" as const,
    })),
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("compat-validator", () => {
  describe("validateRecording", () => {
    it("reports compatible for well-formed messages", () => {
      const recording = makeRecording([
        { type: "session_init", session: { session_id: "s", cwd: "/", model: "claude" } },
        { type: "assistant", text: "Hello" },
        { type: "result", subtype: "success" },
      ]);

      const result = validateRecording(recording);
      expect(result.compatible).toBe(true);
      expect(result.diffs).toHaveLength(0);
      expect(result.totalMessages).toBe(3);
    });

    it("detects missing type field", () => {
      const recording = makeRecording([{ text: "no type" }]);
      const result = validateRecording(recording);
      expect(result.compatible).toBe(false);
      expect(result.diffs[0].kind).toBe("field_mismatch");
      expect(result.diffs[0].details).toContain("missing 'type'");
    });

    it("detects missing session_init session object", () => {
      const recording = makeRecording([{ type: "session_init" }]);
      const result = validateRecording(recording);
      expect(result.compatible).toBe(false);
      expect(result.diffs[0].details).toContain("missing 'session' object");
    });

    it("detects missing permission_request tool_name", () => {
      const recording = makeRecording([{ type: "permission_request", input: {} }]);
      const result = validateRecording(recording);
      expect(result.compatible).toBe(false);
      expect(result.diffs[0].details).toContain("missing 'tool_name'");
    });

    it("detects missing result subtype", () => {
      const recording = makeRecording([{ type: "result" }]);
      const result = validateRecording(recording);
      expect(result.compatible).toBe(false);
      expect(result.diffs[0].details).toContain("missing 'subtype'");
    });

    it("provides message type breakdown", () => {
      const recording = makeRecording([
        { type: "assistant", text: "a" },
        { type: "assistant", text: "b" },
        { type: "result", subtype: "success" },
      ]);
      const result = validateRecording(recording);
      expect(result.messageTypeBreakdown.assistant.count).toBe(2);
      expect(result.messageTypeBreakdown.result.count).toBe(1);
    });

    it("reports backendType from header", () => {
      const recording = makeRecording([{ type: "assistant" }]);
      const result = validateRecording(recording);
      expect(result.backendType).toBe("claude");
    });
  });

  describe("compareRecordings", () => {
    it("returns empty diffs for matching recordings", () => {
      const recording = makeRecording([
        { type: "assistant", text: "Hello" },
        { type: "result", subtype: "success" },
      ]);
      const actual = [
        { type: "assistant", text: "Hello" },
        { type: "result", subtype: "success" },
      ];
      const diffs = compareRecordings(recording, actual);
      expect(diffs).toHaveLength(0);
    });

    it("detects type mismatch", () => {
      const recording = makeRecording([{ type: "assistant", text: "Hi" }]);
      const actual = [{ type: "result", subtype: "success" }];
      const diffs = compareRecordings(recording, actual);
      expect(diffs).toHaveLength(1);
      expect(diffs[0].kind).toBe("type_mismatch");
    });

    it("detects missing messages in actual", () => {
      const recording = makeRecording([
        { type: "assistant", text: "a" },
        { type: "assistant", text: "b" },
      ]);
      const actual = [{ type: "assistant", text: "a" }];
      const diffs = compareRecordings(recording, actual);
      expect(diffs.some((d) => d.kind === "missing")).toBe(true);
    });

    it("detects extra messages in actual", () => {
      const recording = makeRecording([{ type: "assistant", text: "a" }]);
      const actual = [
        { type: "assistant", text: "a" },
        { type: "result", subtype: "success" },
      ];
      const diffs = compareRecordings(recording, actual);
      expect(diffs.some((d) => d.kind === "extra")).toBe(true);
    });

    it("detects missing fields in actual", () => {
      const recording = makeRecording([{ type: "assistant", text: "Hi", content: [] }]);
      const actual = [{ type: "assistant", text: "Hi" }];
      const diffs = compareRecordings(recording, actual);
      expect(diffs.some((d) => d.kind === "field_mismatch" && d.details.includes("missing field"))).toBe(true);
    });

    it("ignores timestamp and cost fields", () => {
      const recording = makeRecording([
        { type: "result", subtype: "success", timestamp: 123, cost_usd: 0.01, data: "x" },
      ]);
      const actual = [
        { type: "result", subtype: "success", timestamp: 999, cost_usd: 0.99, data: "x" },
      ];
      const diffs = compareRecordings(recording, actual);
      expect(diffs).toHaveLength(0);
    });
  });
});
