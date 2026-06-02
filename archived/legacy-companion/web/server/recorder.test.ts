import {
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  existsSync,
  utimesSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SessionRecorder, RecorderManager } from "./recorder.js";

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "recorder-test-"));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function readDirSafe(dir: string): string[] {
  try {
    return readdirSync(dir) as string[];
  } catch {
    return [];
  }
}

/**
 * Create a fake JSONL recording file with a given number of entry lines.
 * Returns the full path. The header counts as 1 line, so total lines = 1 + entryCount.
 */
function createFakeRecording(
  dir: string,
  filename: string,
  entryCount: number,
  mtime?: Date,
): string {
  const header = JSON.stringify({
    _header: true,
    version: 1,
    session_id: "fake",
    backend_type: "claude",
    started_at: Date.now(),
    cwd: "/fake",
  });
  const entry = JSON.stringify({ ts: Date.now(), dir: "in", raw: "x", ch: "cli" });
  const lines = [header, ...Array(entryCount).fill(entry)];
  const filePath = join(dir, filename);
  writeFileSync(filePath, lines.join("\n") + "\n");
  if (mtime) {
    utimesSync(filePath, mtime, mtime);
  }
  return filePath;
}

// ─── SessionRecorder ─────────────────────────────────────────────────────────

describe("SessionRecorder", () => {
  it("writes a header as the first line with correct metadata", () => {
    const rec = new SessionRecorder("sess-1", "claude", "/project", tempDir);
    rec.close();

    const lines = readFileSync(rec.filePath, "utf-8").trim().split("\n");
    expect(lines.length).toBe(1);

    const header = JSON.parse(lines[0]);
    expect(header._header).toBe(true);
    expect(header.version).toBe(1);
    expect(header.session_id).toBe("sess-1");
    expect(header.backend_type).toBe("claude");
    expect(header.cwd).toBe("/project");
    expect(typeof header.started_at).toBe("number");
  });

  it("preserves raw strings exactly without re-serialization", () => {
    // The raw string has intentional formatting (extra spaces, specific order)
    // that must be preserved verbatim — not re-parsed and re-serialized.
    const rawMsg = '{"type":"system",  "subtype":"init", "extra_field": true}';
    const rec = new SessionRecorder("sess-2", "claude", "/project", tempDir);
    rec.record("in", rawMsg, "cli");
    rec.close();

    const lines = readFileSync(rec.filePath, "utf-8").trim().split("\n");
    expect(lines.length).toBe(2);

    const entry = JSON.parse(lines[1]);
    expect(entry.raw).toBe(rawMsg);
  });

  it("records entries with monotonically increasing timestamps", () => {
    const rec = new SessionRecorder("sess-3", "codex", "/project", tempDir);
    rec.record("in", "msg1", "cli");
    rec.record("out", "msg2", "cli");
    rec.record("in", "msg3", "browser");
    rec.close();

    const lines = readFileSync(rec.filePath, "utf-8").trim().split("\n");
    expect(lines.length).toBe(4);

    const entries = lines.slice(1).map((l) => JSON.parse(l));
    for (let i = 1; i < entries.length; i++) {
      expect(entries[i].ts).toBeGreaterThanOrEqual(entries[i - 1].ts);
    }
  });

  it("records direction and channel correctly", () => {
    const rec = new SessionRecorder("sess-4", "claude", "/cwd", tempDir);
    rec.record("in", "hello", "cli");
    rec.record("out", "world", "browser");
    rec.close();

    const lines = readFileSync(rec.filePath, "utf-8").trim().split("\n");
    const e1 = JSON.parse(lines[1]);
    const e2 = JSON.parse(lines[2]);

    expect(e1.dir).toBe("in");
    expect(e1.ch).toBe("cli");
    expect(e2.dir).toBe("out");
    expect(e2.ch).toBe("browser");
  });

  it("does not record after close()", () => {
    const rec = new SessionRecorder("sess-5", "claude", "/cwd", tempDir);
    rec.record("in", "before-close", "cli");
    rec.close();
    rec.record("in", "after-close", "cli");

    const lines = readFileSync(rec.filePath, "utf-8").trim().split("\n");
    expect(lines.length).toBe(2);
    expect(JSON.parse(lines[1]).raw).toBe("before-close");
  });

  it("generates a filename with session ID and backend type", () => {
    const rec = new SessionRecorder("my-session", "codex", "/cwd", tempDir);
    rec.close();

    expect(rec.filePath).toContain("my-session");
    expect(rec.filePath).toContain("codex");
    expect(rec.filePath).toMatch(/\.jsonl$/);
  });

  it("tracks lineCount correctly (header + entries)", () => {
    // lineCount starts at 1 (the header), increments for each recorded entry
    const rec = new SessionRecorder("sess-lc", "claude", "/cwd", tempDir);
    expect(rec.lineCount).toBe(1);

    rec.record("in", "a", "cli");
    rec.record("in", "b", "cli");
    rec.record("out", "c", "browser");
    rec.record("in", "d", "cli");
    rec.record("out", "e", "browser");
    expect(rec.lineCount).toBe(6);

    rec.close();
    // lineCount doesn't change after close
    expect(rec.lineCount).toBe(6);
  });
});

// ─── RecorderManager ─────────────────────────────────────────────────────────

describe("RecorderManager", () => {
  it("enabled by default when no options provided", () => {
    // Recording is always on unless explicitly disabled
    const mgr = new RecorderManager({ recordingsDir: tempDir });
    expect(mgr.isGloballyEnabled()).toBe(true);
    expect(mgr.isRecording("any-session")).toBe(true);
    mgr.closeAll();
  });

  it("respects globalEnabled: true", () => {
    const mgr = new RecorderManager({ globalEnabled: true, recordingsDir: tempDir });
    expect(mgr.isGloballyEnabled()).toBe(true);
    expect(mgr.isRecording("any-session")).toBe(true);
    mgr.closeAll();
  });

  it("does not record when disabled globally and per-session", () => {
    const mgr = new RecorderManager({ globalEnabled: false, recordingsDir: tempDir });
    expect(mgr.isRecording("sess-1")).toBe(false);

    mgr.record("sess-1", "in", "test", "cli", "claude", "/cwd");

    const files = readDirSafe(tempDir);
    expect(files.length).toBe(0);
  });

  it("supports per-session enable/disable", () => {
    const mgr = new RecorderManager({ globalEnabled: false, recordingsDir: tempDir });

    expect(mgr.isRecording("sess-1")).toBe(false);

    mgr.enableForSession("sess-1");
    expect(mgr.isRecording("sess-1")).toBe(true);
    expect(mgr.isRecording("sess-2")).toBe(false);

    mgr.disableForSession("sess-1");
    expect(mgr.isRecording("sess-1")).toBe(false);
  });

  it("lazily creates a recorder on first record() call", () => {
    const mgr = new RecorderManager({ globalEnabled: true, recordingsDir: tempDir });

    expect(readDirSafe(tempDir).length).toBe(0);

    mgr.record("sess-1", "in", "first-msg", "cli", "claude", "/cwd");

    const files = readDirSafe(tempDir);
    expect(files.length).toBe(1);
    expect(files[0]).toMatch(/^sess-1_claude_.*\.jsonl$/);
    mgr.closeAll();
  });

  it("creates separate files for concurrent sessions", () => {
    const mgr = new RecorderManager({ globalEnabled: true, recordingsDir: tempDir });

    mgr.record("sess-a", "in", "msg-a", "cli", "claude", "/cwd");
    mgr.record("sess-b", "in", "msg-b", "cli", "codex", "/cwd");

    const files = readDirSafe(tempDir);
    expect(files.length).toBe(2);
    expect(files.some((f) => f.includes("sess-a"))).toBe(true);
    expect(files.some((f) => f.includes("sess-b"))).toBe(true);
    mgr.closeAll();
  });

  it("stopRecording closes the recorder and removes it", () => {
    const mgr = new RecorderManager({ globalEnabled: true, recordingsDir: tempDir });
    mgr.record("sess-1", "in", "msg1", "cli", "claude", "/cwd");

    mgr.stopRecording("sess-1");

    mgr.record("sess-1", "in", "msg2", "cli", "claude", "/cwd");

    const files = readDirSafe(tempDir);
    expect(files.length).toBe(2);
    mgr.closeAll();
  });

  it("getRecordingStatus returns filePath when active", () => {
    const mgr = new RecorderManager({ globalEnabled: true, recordingsDir: tempDir });
    mgr.record("sess-1", "in", "msg", "cli", "claude", "/cwd");

    const status = mgr.getRecordingStatus("sess-1");
    expect(status.filePath).toBeDefined();
    expect(status.filePath!).toMatch(/sess-1.*\.jsonl$/);
    mgr.closeAll();
  });

  it("getRecordingStatus returns empty when not active", () => {
    const mgr = new RecorderManager({ globalEnabled: false, recordingsDir: tempDir });
    const status = mgr.getRecordingStatus("sess-1");
    expect(status.filePath).toBeUndefined();
  });

  it("listRecordings returns correct metadata and line counts", () => {
    const mgr = new RecorderManager({ globalEnabled: true, recordingsDir: tempDir });
    // sess-1: header + 1 entry = 2 lines
    mgr.record("sess-1", "in", "msg", "cli", "claude", "/cwd");
    // sess-2: header + 1 entry = 2 lines
    mgr.record("sess-2", "in", "msg", "cli", "codex", "/cwd");

    const recordings = mgr.listRecordings();
    expect(recordings.length).toBe(2);

    const r1 = recordings.find((r) => r.sessionId === "sess-1");
    expect(r1).toBeDefined();
    expect(r1!.backendType).toBe("claude");
    expect(r1!.lines).toBe(2);

    const r2 = recordings.find((r) => r.sessionId === "sess-2");
    expect(r2).toBeDefined();
    expect(r2!.backendType).toBe("codex");
    expect(r2!.lines).toBe(2);
    mgr.closeAll();
  });

  it("listRecordings returns empty array when directory does not exist", () => {
    const mgr = new RecorderManager({
      globalEnabled: false,
      recordingsDir: join(tempDir, "nonexistent"),
    });
    expect(mgr.listRecordings()).toEqual([]);
  });

  it("closeAll closes all active recorders and stops cleanup timer", () => {
    const mgr = new RecorderManager({ globalEnabled: true, recordingsDir: tempDir });
    mgr.record("sess-1", "in", "msg", "cli", "claude", "/cwd");
    mgr.record("sess-2", "in", "msg", "cli", "codex", "/cwd");

    mgr.closeAll();

    expect(mgr.getRecordingStatus("sess-1").filePath).toBeUndefined();
    expect(mgr.getRecordingStatus("sess-2").filePath).toBeUndefined();
  });

  it("disableForSession also stops and closes the recorder", () => {
    const mgr = new RecorderManager({ globalEnabled: false, recordingsDir: tempDir });
    mgr.enableForSession("sess-1");
    mgr.record("sess-1", "in", "msg", "cli", "claude", "/cwd");

    expect(mgr.getRecordingStatus("sess-1").filePath).toBeDefined();

    mgr.disableForSession("sess-1");

    expect(mgr.getRecordingStatus("sess-1").filePath).toBeUndefined();
  });

  it("disableForSession overrides globalEnabled and prevents new recordings", () => {
    // When globalEnabled is true, disableForSession must still stop recording
    // for that specific session by adding it to the perSessionDisabled set.
    const mgr = new RecorderManager({ globalEnabled: true, recordingsDir: tempDir });
    mgr.record("sess-1", "in", "msg1", "cli", "claude", "/cwd");

    expect(mgr.isRecording("sess-1")).toBe(true);

    mgr.disableForSession("sess-1");

    // Session is no longer recording despite globalEnabled=true
    expect(mgr.isRecording("sess-1")).toBe(false);

    // New record() calls should be no-ops (no new file created)
    const filesBefore = readDirSafe(tempDir).length;
    mgr.record("sess-1", "in", "msg2", "cli", "claude", "/cwd");
    expect(readDirSafe(tempDir).length).toBe(filesBefore);

    // Re-enabling should work
    mgr.enableForSession("sess-1");
    expect(mgr.isRecording("sess-1")).toBe(true);

    mgr.closeAll();
  });

  it("getMaxLines returns configured limit", () => {
    const mgr = new RecorderManager({
      globalEnabled: false,
      recordingsDir: tempDir,
      maxLines: 42,
    });
    expect(mgr.getMaxLines()).toBe(42);
  });
});

// ─── Cleanup / Rotation ─────────────────────────────────────────────────────

describe("cleanup / rotation", () => {
  it("deletes oldest files when total lines exceed maxLines", () => {
    // Create 3 files with 10 entries each (= 11 lines each including header, 33 total)
    // Use different mtimes so we control which is "oldest"
    const now = Date.now();
    createFakeRecording(tempDir, "old_claude_2025-01-01.jsonl", 10, new Date(now - 3000));
    createFakeRecording(tempDir, "mid_claude_2025-01-02.jsonl", 10, new Date(now - 2000));
    createFakeRecording(tempDir, "new_claude_2025-01-03.jsonl", 10, new Date(now - 1000));

    // maxLines = 20 → total 33 lines exceeds limit → should delete oldest first
    const mgr = new RecorderManager({
      globalEnabled: false, // don't start auto-cleanup timer
      recordingsDir: tempDir,
      maxLines: 20,
    });

    const deleted = mgr.cleanup();

    // Should have deleted at least the oldest file (11 lines), bringing total to 22,
    // still > 20, so the mid file (11 lines) gets deleted too → total 11 lines
    expect(deleted).toBe(2);

    const remaining = readDirSafe(tempDir);
    expect(remaining.length).toBe(1);
    expect(remaining[0]).toContain("new_claude");
  });

  it("does not delete files from active recording sessions", () => {
    // Create an old file that would normally be deleted
    const now = Date.now();
    createFakeRecording(tempDir, "stale_claude_2025-01-01.jsonl", 10, new Date(now - 3000));

    // Start an active recording — this file's path will be in the active set
    const mgr = new RecorderManager({
      globalEnabled: true,
      recordingsDir: tempDir,
      maxLines: 5, // Very low limit to force cleanup
    });
    mgr.record("active-sess", "in", "msg", "cli", "claude", "/cwd");

    // Now cleanup should delete the stale file but NOT the active recording's file
    const deleted = mgr.cleanup();

    // stale file deleted
    expect(existsSync(join(tempDir, "stale_claude_2025-01-01.jsonl"))).toBe(false);

    // active session's file should still exist
    const status = mgr.getRecordingStatus("active-sess");
    expect(status.filePath).toBeDefined();
    expect(existsSync(status.filePath!)).toBe(true);

    mgr.closeAll();
  });

  it("is a no-op when total lines are under the limit", () => {
    // 2 files × 3 entries = 2 × 4 lines = 8 total, well under 100
    createFakeRecording(tempDir, "a_claude_2025-01-01.jsonl", 3);
    createFakeRecording(tempDir, "b_claude_2025-01-02.jsonl", 3);

    const mgr = new RecorderManager({
      globalEnabled: false,
      recordingsDir: tempDir,
      maxLines: 100,
    });

    const deleted = mgr.cleanup();
    expect(deleted).toBe(0);

    expect(readDirSafe(tempDir).length).toBe(2);
  });

  it("handles empty recordings directory gracefully", () => {
    const mgr = new RecorderManager({
      globalEnabled: false,
      recordingsDir: tempDir,
      maxLines: 10,
    });

    const deleted = mgr.cleanup();
    expect(deleted).toBe(0);
  });

  it("runs cleanup at construction when globally enabled", () => {
    // Pre-fill the directory over the limit
    const now = Date.now();
    createFakeRecording(tempDir, "old_claude_2025-01-01.jsonl", 20, new Date(now - 2000));
    createFakeRecording(tempDir, "new_claude_2025-01-02.jsonl", 5, new Date(now - 1000));

    // Total = 21 + 6 = 27 lines, maxLines = 10
    // Constructor should run cleanup immediately, deleting the old file
    const mgr = new RecorderManager({
      globalEnabled: true,
      recordingsDir: tempDir,
      maxLines: 10,
    });

    const remaining = readDirSafe(tempDir);
    expect(remaining.length).toBe(1);
    expect(remaining[0]).toContain("new_claude");

    mgr.closeAll();
  });
});
