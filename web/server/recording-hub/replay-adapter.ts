/**
 * ReplayAdapter — replays a recorded session as a fake live backend.
 *
 * Implements IBackendAdapter so the WsBridge treats it identically to a real
 * Claude Code or Codex backend. The browser has no idea it's watching a replay.
 */

import type { IBackendAdapter } from "../backend-adapter.js";
import type { BrowserIncomingMessage, BrowserOutgoingMessage } from "../session-types.js";
import type { Recording } from "../replay.js";
import { filterEntries } from "../replay.js";

type State = "idle" | "playing" | "paused" | "finished";

export class ReplayAdapter implements IBackendAdapter {
  private state: State = "idle";
  private speed: number;

  private browserMessageCb: ((msg: BrowserIncomingMessage) => void) | null = null;
  private sessionMetaCb: ((meta: { cliSessionId?: string; model?: string; cwd?: string }) => void) | null = null;
  private disconnectCb: (() => void) | null = null;

  /** Outgoing browser messages from the recording, in order. */
  private readonly entries: { ts: number; raw: string }[];
  private currentIndex = 0;
  private pendingTimer: ReturnType<typeof setTimeout> | null = null;

  /** Timestamp of last scheduled entry (for pause/resume). */
  private lastScheduledTs = 0;
  /** Wall-clock time when last entry was scheduled. */
  private lastScheduledAt = 0;

  private readonly recording: Recording;

  constructor(recording: Recording, speed = 1) {
    this.recording = recording;
    this.speed = speed;

    // Extract outgoing browser messages (what the server originally sent)
    this.entries = filterEntries(recording.entries, "out", "browser").map((e) => ({
      ts: e.ts,
      raw: e.raw,
    }));
  }

  // ── IBackendAdapter interface ────────────────────────────────────────

  send(_msg: BrowserOutgoingMessage): boolean {
    // Replay doesn't accept input from browsers — it just plays back.
    // Permission responses, user messages, etc. are ignored.
    return true;
  }

  isConnected(): boolean {
    return this.state === "playing" || this.state === "paused";
  }

  async disconnect(): Promise<void> {
    this.clearTimer();
    this.state = "finished";
    this.disconnectCb?.();
  }

  onBrowserMessage(cb: (msg: BrowserIncomingMessage) => void): void {
    this.browserMessageCb = cb;
  }

  onSessionMeta(cb: (meta: { cliSessionId?: string; model?: string; cwd?: string }) => void): void {
    this.sessionMetaCb = cb;
  }

  onDisconnect(cb: () => void): void {
    this.disconnectCb = cb;
  }

  // ── Replay controls ─────────────────────────────────────────────────

  play(): void {
    if (this.state === "finished") return;

    // Emit session metadata from recording header on first play
    if (this.state === "idle") {
      this.sessionMetaCb?.({
        cliSessionId: this.recording.header.session_id,
        cwd: this.recording.header.cwd,
      });
    }

    this.state = "playing";
    this.scheduleNext();
  }

  pause(): void {
    if (this.state !== "playing") return;
    this.clearTimer();
    this.state = "paused";
  }

  setSpeed(multiplier: number): void {
    if (multiplier <= 0) return;
    const wasPlaying = this.state === "playing";
    if (wasPlaying) this.clearTimer();
    this.speed = multiplier;
    if (wasPlaying) this.scheduleNext();
  }

  getProgress(): { current: number; total: number; percentComplete: number; state: State } {
    const total = this.entries.length;
    const current = this.currentIndex;
    return {
      current,
      total,
      percentComplete: total > 0 ? Math.round((current / total) * 100) : 100,
      state: this.state,
    };
  }

  // ── Internal scheduling ─────────────────────────────────────────────

  private scheduleNext(): void {
    if (this.state !== "playing") return;
    if (this.currentIndex >= this.entries.length) {
      this.finish();
      return;
    }

    const entry = this.entries[this.currentIndex];

    // Calculate delay based on timing difference from previous entry
    let delayMs = 0;
    if (this.currentIndex > 0) {
      const prevTs = this.entries[this.currentIndex - 1].ts;
      delayMs = (entry.ts - prevTs) / this.speed;
    }

    // Instant mode: no delay at all
    if (!Number.isFinite(this.speed) || this.speed === Infinity) {
      delayMs = 0;
    }

    // Cap maximum delay to prevent excessively long waits
    delayMs = Math.min(delayMs, 5000 / this.speed);

    this.lastScheduledTs = entry.ts;
    this.lastScheduledAt = Date.now();

    if (delayMs <= 0) {
      // Emit synchronously for instant mode, but use microtask to avoid stack overflow
      this.pendingTimer = setTimeout(() => this.emitEntry(), 0);
    } else {
      this.pendingTimer = setTimeout(() => this.emitEntry(), delayMs);
    }
  }

  private emitEntry(): void {
    if (this.state !== "playing") return;
    if (this.currentIndex >= this.entries.length) {
      this.finish();
      return;
    }

    const entry = this.entries[this.currentIndex];
    this.currentIndex++;

    try {
      const msg = JSON.parse(entry.raw) as BrowserIncomingMessage;
      this.browserMessageCb?.(msg);
    } catch {
      // Skip malformed entries
    }

    this.scheduleNext();
  }

  private finish(): void {
    this.state = "finished";
    // Emit a cli_disconnected so the browser knows the session ended
    this.browserMessageCb?.({ type: "cli_disconnected" } as BrowserIncomingMessage);
    this.disconnectCb?.();
  }

  private clearTimer(): void {
    if (this.pendingTimer !== null) {
      clearTimeout(this.pendingTimer);
      this.pendingTimer = null;
    }
  }
}
