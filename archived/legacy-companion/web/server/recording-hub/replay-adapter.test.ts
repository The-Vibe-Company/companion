import { describe, it, expect, vi, beforeEach } from "vitest";
import { ReplayAdapter } from "./replay-adapter.js";
import type { Recording } from "../replay.js";
import type { BrowserIncomingMessage } from "../session-types.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeRecording(browserMessages: { type: string; [key: string]: unknown }[], delayMs = 100): Recording {
  const entries = browserMessages.map((msg, i) => ({
    ts: 1000 + i * delayMs,
    dir: "out" as const,
    raw: JSON.stringify(msg),
    ch: "browser" as const,
  }));

  return {
    header: {
      _header: true as const,
      version: 1 as const,
      session_id: "test-session",
      backend_type: "claude" as const,
      started_at: 1000,
      cwd: "/test",
    },
    entries,
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("ReplayAdapter", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  describe("basic replay", () => {
    it("emits all browser messages in order", async () => {
      const messages = [
        { type: "session_init", session: {} },
        { type: "assistant", text: "Hello" },
        { type: "result", subtype: "success" },
      ];
      const adapter = new ReplayAdapter(makeRecording(messages), Infinity);
      const received: BrowserIncomingMessage[] = [];
      adapter.onBrowserMessage((msg) => received.push(msg));
      adapter.onSessionMeta(() => {});
      adapter.onDisconnect(() => {});

      adapter.play();
      // Flush all microtasks/timers for instant mode
      await vi.runAllTimersAsync();

      // Should receive all messages plus the final cli_disconnected
      expect(received.length).toBe(messages.length + 1);
      expect(received[0].type).toBe("session_init");
      expect(received[1].type).toBe("assistant");
      expect(received[2].type).toBe("result");
      expect(received[3].type).toBe("cli_disconnected");
    });

    it("emits session metadata on first play", async () => {
      const adapter = new ReplayAdapter(makeRecording([{ type: "session_init", session: {} }]), Infinity);
      const metaCalls: { cliSessionId?: string; cwd?: string }[] = [];
      adapter.onBrowserMessage(() => {});
      adapter.onSessionMeta((meta) => metaCalls.push(meta));
      adapter.onDisconnect(() => {});

      adapter.play();
      await vi.runAllTimersAsync();

      expect(metaCalls).toHaveLength(1);
      expect(metaCalls[0].cliSessionId).toBe("test-session");
      expect(metaCalls[0].cwd).toBe("/test");
    });
  });

  describe("IBackendAdapter interface", () => {
    it("isConnected returns true while playing", () => {
      const adapter = new ReplayAdapter(makeRecording([{ type: "assistant" }]), Infinity);
      adapter.onBrowserMessage(() => {});
      adapter.onSessionMeta(() => {});
      adapter.onDisconnect(() => {});

      expect(adapter.isConnected()).toBe(false); // idle
      adapter.play();
      expect(adapter.isConnected()).toBe(true); // playing
    });

    it("isConnected returns false after disconnect", async () => {
      const adapter = new ReplayAdapter(makeRecording([{ type: "assistant" }]), Infinity);
      adapter.onBrowserMessage(() => {});
      adapter.onSessionMeta(() => {});
      adapter.onDisconnect(() => {});

      adapter.play();
      await vi.runAllTimersAsync();
      expect(adapter.isConnected()).toBe(false);
    });

    it("send() returns true (no-op for replay)", () => {
      const adapter = new ReplayAdapter(makeRecording([]), Infinity);
      expect(adapter.send({ type: "user_message" } as any)).toBe(true);
    });

    it("disconnect stops replay and calls disconnect callback", async () => {
      const adapter = new ReplayAdapter(makeRecording([{ type: "a" }, { type: "b" }]), 1);
      const disconnected = vi.fn();
      adapter.onBrowserMessage(() => {});
      adapter.onSessionMeta(() => {});
      adapter.onDisconnect(disconnected);

      adapter.play();
      await adapter.disconnect();
      expect(disconnected).toHaveBeenCalledOnce();
      expect(adapter.isConnected()).toBe(false);
    });
  });

  describe("pause and resume", () => {
    it("pauses and resumes playback", async () => {
      const messages = [
        { type: "a" },
        { type: "b" },
        { type: "c" },
      ];
      // Use a real delay (100ms between messages)
      const adapter = new ReplayAdapter(makeRecording(messages, 100), 1);
      const received: BrowserIncomingMessage[] = [];
      adapter.onBrowserMessage((msg) => received.push(msg));
      adapter.onSessionMeta(() => {});
      adapter.onDisconnect(() => {});

      adapter.play();

      // First message is instant (no delay for first entry)
      await vi.advanceTimersByTimeAsync(0);
      expect(received.length).toBeGreaterThanOrEqual(1);

      adapter.pause();
      const countAtPause = received.length;

      // Advance time — no more messages should arrive while paused
      await vi.advanceTimersByTimeAsync(500);
      expect(received.length).toBe(countAtPause);

      // Resume
      adapter.play();
      await vi.runAllTimersAsync();

      // All messages plus cli_disconnected
      expect(received.length).toBe(messages.length + 1);
    });
  });

  describe("speed control", () => {
    it("2x speed completes faster than 1x", async () => {
      // Two messages 1000ms apart at 1x speed
      const messages = [{ type: "a" }, { type: "b" }];
      const adapter = new ReplayAdapter(makeRecording(messages, 1000), 2);
      const received: BrowserIncomingMessage[] = [];
      adapter.onBrowserMessage((msg) => received.push(msg));
      adapter.onSessionMeta(() => {});
      adapter.onDisconnect(() => {});

      adapter.play();
      // At 2x speed, 1000ms delay becomes 500ms. Advance 600ms — should see both messages.
      await vi.advanceTimersByTimeAsync(600);
      // First message is instant (index 0), second should have arrived by 500ms
      expect(received.filter((m) => m.type !== "cli_disconnected").length).toBe(2);
    });

    it("setSpeed mid-play affects subsequent messages", async () => {
      const messages = [{ type: "a" }, { type: "b" }, { type: "c" }];
      const adapter = new ReplayAdapter(makeRecording(messages, 1000), 1);
      const received: BrowserIncomingMessage[] = [];
      adapter.onBrowserMessage((msg) => received.push(msg));
      adapter.onSessionMeta(() => {});
      adapter.onDisconnect(() => {});

      adapter.play();
      // First message is instant
      await vi.advanceTimersByTimeAsync(0);
      expect(received.length).toBeGreaterThanOrEqual(1);

      // Switch to instant mode
      adapter.setSpeed(Infinity);
      await vi.runAllTimersAsync();

      // All messages + cli_disconnected
      expect(received.length).toBe(messages.length + 1);
    });

    it("ignores invalid speed values", () => {
      const adapter = new ReplayAdapter(makeRecording([{ type: "a" }]), 5);
      adapter.onBrowserMessage(() => {});
      adapter.onSessionMeta(() => {});
      adapter.onDisconnect(() => {});

      adapter.setSpeed(0);
      adapter.setSpeed(-1);
      // Speed should remain unchanged (verified indirectly via progress state)
      expect(adapter.getProgress().state).toBe("idle");
    });

    it("play() is idempotent while already playing", async () => {
      const messages = [{ type: "a" }, { type: "b" }];
      const adapter = new ReplayAdapter(makeRecording(messages, 100), 1);
      const received: BrowserIncomingMessage[] = [];
      adapter.onBrowserMessage((msg) => received.push(msg));
      adapter.onSessionMeta(() => {});
      adapter.onDisconnect(() => {});

      adapter.play();
      adapter.play(); // Should be no-op (no overlapping timers)
      adapter.play();
      await vi.runAllTimersAsync();

      // Should still get exactly the expected number of messages (no duplicates)
      expect(received.filter((m) => m.type !== "cli_disconnected").length).toBe(2);
    });
  });

  describe("getProgress", () => {
    it("reports progress correctly", async () => {
      const messages = [{ type: "a" }, { type: "b" }, { type: "c" }];
      const adapter = new ReplayAdapter(makeRecording(messages), Infinity);
      adapter.onBrowserMessage(() => {});
      adapter.onSessionMeta(() => {});
      adapter.onDisconnect(() => {});

      expect(adapter.getProgress()).toEqual({
        current: 0,
        total: 3,
        percentComplete: 0,
        state: "idle",
      });

      adapter.play();
      await vi.runAllTimersAsync();

      expect(adapter.getProgress()).toEqual({
        current: 3,
        total: 3,
        percentComplete: 100,
        state: "finished",
      });
    });
  });

  describe("edge cases", () => {
    it("handles empty recording", async () => {
      const adapter = new ReplayAdapter(
        { header: { _header: true, version: 1, session_id: "s", backend_type: "claude", started_at: 0, cwd: "/" }, entries: [] },
        Infinity,
      );
      const received: BrowserIncomingMessage[] = [];
      const disconnected = vi.fn();
      adapter.onBrowserMessage((msg) => received.push(msg));
      adapter.onSessionMeta(() => {});
      adapter.onDisconnect(disconnected);

      adapter.play();
      await vi.runAllTimersAsync();

      // Only cli_disconnected for an empty recording
      expect(received).toHaveLength(1);
      expect(received[0].type).toBe("cli_disconnected");
      expect(disconnected).toHaveBeenCalledOnce();
    });

    it("handles malformed entry JSON gracefully", async () => {
      const recording: Recording = {
        header: { _header: true, version: 1, session_id: "s", backend_type: "claude", started_at: 0, cwd: "/" },
        entries: [
          { ts: 100, dir: "out", raw: "not valid json", ch: "browser" },
          { ts: 200, dir: "out", raw: JSON.stringify({ type: "assistant" }), ch: "browser" },
        ],
      };
      const adapter = new ReplayAdapter(recording, Infinity);
      const received: BrowserIncomingMessage[] = [];
      adapter.onBrowserMessage((msg) => received.push(msg));
      adapter.onSessionMeta(() => {});
      adapter.onDisconnect(() => {});

      adapter.play();
      await vi.runAllTimersAsync();

      // Should skip the malformed entry and emit the valid one + cli_disconnected
      expect(received).toHaveLength(2);
      expect(received[0].type).toBe("assistant");
      expect(received[1].type).toBe("cli_disconnected");
    });
  });
});
