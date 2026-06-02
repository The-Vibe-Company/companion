import { describe, it, expect } from "vitest";
import { analyzeDisconnections, buildTimeline } from "./diagnostics.js";
import type { Recording } from "../replay.js";
import type { RecordingEntry } from "../recorder.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeRecording(entries: Partial<RecordingEntry>[]): Recording {
  return {
    header: {
      _header: true as const,
      version: 1 as const,
      session_id: "test",
      backend_type: "claude" as const,
      started_at: 0,
      cwd: "/",
    },
    entries: entries.map((e) => ({
      ts: e.ts ?? 0,
      dir: e.dir ?? "in",
      raw: e.raw ?? "",
      ch: e.ch ?? "cli",
      ...(e.event ? { event: e.event } : {}),
      ...(e.meta ? { meta: e.meta } : {}),
    })) as RecordingEntry[],
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("diagnostics", () => {
  describe("buildTimeline", () => {
    it("extracts explicit lifecycle events", () => {
      const recording = makeRecording([
        { ts: 100, event: "ws_open", ch: "cli" },
        { ts: 200, dir: "in", raw: '{"type":"system"}', ch: "cli" },
        { ts: 500, event: "ws_close", ch: "cli", meta: { code: 1000 } },
      ]);

      const timeline = buildTimeline(recording);
      expect(timeline).toHaveLength(2); // ws_open and ws_close (data messages aren't timeline events)
      expect(timeline[0].event).toBe("ws_open");
      expect(timeline[1].event).toBe("ws_close");
      expect(timeline[1].detail).toContain("1000");
    });

    it("extracts cli_connected/disconnected from data messages", () => {
      const recording = makeRecording([
        { ts: 100, dir: "out", raw: JSON.stringify({ type: "cli_connected" }), ch: "browser" },
        { ts: 500, dir: "out", raw: JSON.stringify({ type: "cli_disconnected" }), ch: "browser" },
      ]);

      const timeline = buildTimeline(recording);
      expect(timeline).toHaveLength(2);
      expect(timeline[0].event).toBe("cli_connected");
      expect(timeline[1].event).toBe("cli_disconnected");
    });

    it("returns sorted timeline", () => {
      const recording = makeRecording([
        { ts: 500, event: "ws_close", ch: "cli" },
        { ts: 100, event: "ws_open", ch: "cli" },
      ]);

      const timeline = buildTimeline(recording);
      expect(timeline[0].ts).toBeLessThan(timeline[1].ts);
    });
  });

  describe("analyzeDisconnections", () => {
    it("reports no disconnections for clean session", () => {
      const recording = makeRecording([
        { ts: 100, dir: "in", raw: '{"type":"system"}', ch: "cli" },
        { ts: 200, dir: "in", raw: '{"type":"assistant"}', ch: "cli" },
        { ts: 300, dir: "in", raw: '{"type":"result"}', ch: "cli" },
      ]);

      const report = analyzeDisconnections(recording);
      expect(report.totalDisconnections).toBe(0);
      expect(report.dataGaps).toHaveLength(0);
      expect(report.patterns).toContain("No disconnection issues detected in this recording.");
    });

    it("detects disconnection from lifecycle events", () => {
      const recording = makeRecording([
        { ts: 100, event: "ws_open", ch: "cli" },
        { ts: 1000, event: "ws_close", ch: "cli" },
        { ts: 5000, event: "ws_open", ch: "cli" },
      ]);

      const report = analyzeDisconnections(recording);
      expect(report.totalDisconnections).toBe(1);
      expect(report.disconnections[0].gapMs).toBe(4000);
    });

    it("detects data gaps in CLI messages", () => {
      // Gap of 60s between two CLI messages (exceeds 30s threshold)
      const recording = makeRecording([
        { ts: 1000, dir: "in", raw: '{"type":"a"}', ch: "cli" },
        { ts: 61000, dir: "in", raw: '{"type":"b"}', ch: "cli" },
      ]);

      const report = analyzeDisconnections(recording);
      expect(report.dataGaps).toHaveLength(1);
      expect(report.dataGaps[0].gapMs).toBe(60000);
    });

    it("reports asymmetric disconnection pattern (CLI-only)", () => {
      const recording = makeRecording([
        { ts: 100, dir: "out", raw: JSON.stringify({ type: "cli_disconnected" }), ch: "browser" },
        { ts: 5000, dir: "out", raw: JSON.stringify({ type: "cli_connected" }), ch: "browser" },
      ]);

      const report = analyzeDisconnections(recording);
      expect(report.patterns.some((p) => p.includes("CLI-side"))).toBe(true);
    });

    it("detects rapid reconnect cycling", () => {
      // 3 rapid disconnect/reconnect cycles (< 5s gaps), spaced >20s apart so dedup doesn't merge them
      const recording = makeRecording([
        { ts: 1000, dir: "out", raw: JSON.stringify({ type: "cli_disconnected" }), ch: "browser" },
        { ts: 2000, dir: "out", raw: JSON.stringify({ type: "cli_connected" }), ch: "browser" },
        { ts: 25000, dir: "out", raw: JSON.stringify({ type: "cli_disconnected" }), ch: "browser" },
        { ts: 26000, dir: "out", raw: JSON.stringify({ type: "cli_connected" }), ch: "browser" },
        { ts: 50000, dir: "out", raw: JSON.stringify({ type: "cli_disconnected" }), ch: "browser" },
        { ts: 51000, dir: "out", raw: JSON.stringify({ type: "cli_connected" }), ch: "browser" },
      ]);

      const report = analyzeDisconnections(recording);
      expect(report.patterns.some((p) => p.includes("rapid reconnections"))).toBe(true);
    });

    it("includes session metadata in report", () => {
      const recording = makeRecording([{ ts: 100, dir: "in", raw: "{}", ch: "cli" }]);
      const report = analyzeDisconnections(recording);
      expect(report.sessionId).toBe("test");
      expect(report.backendType).toBe("claude");
    });
  });
});
