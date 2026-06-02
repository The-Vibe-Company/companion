import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";

// Mock COMPANION_HOME before importing hub-store
const TEST_HOME = join(tmpdir(), `hub-test-${randomBytes(4).toString("hex")}`);
vi.mock("../paths.js", () => ({ COMPANION_HOME: TEST_HOME }));

// Must import after mock
const { HubStore } = await import("./hub-store.js");

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeRecordingContent(options?: {
  sessionId?: string;
  backendType?: string;
  entries?: number;
}): string {
  const sessionId = options?.sessionId ?? "test-session";
  const backendType = options?.backendType ?? "claude";
  const entryCount = options?.entries ?? 3;

  const header = JSON.stringify({
    _header: true,
    version: 1,
    session_id: sessionId,
    backend_type: backendType,
    started_at: 1000000,
    cwd: "/test/dir",
  });

  const entries: string[] = [];
  for (let i = 0; i < entryCount; i++) {
    entries.push(
      JSON.stringify({
        ts: 1000000 + i * 1000,
        dir: "out",
        raw: JSON.stringify({ type: i === 0 ? "session_init" : "assistant", session: {} }),
        ch: "browser",
      }),
    );
  }

  return [header, ...entries].join("\n");
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("HubStore", () => {
  beforeEach(() => {
    // Ensure clean test directory
    if (existsSync(TEST_HOME)) rmSync(TEST_HOME, { recursive: true });
    mkdirSync(join(TEST_HOME, "hub", "recordings"), { recursive: true });
  });

  afterEach(() => {
    if (existsSync(TEST_HOME)) rmSync(TEST_HOME, { recursive: true });
  });

  describe("importContent", () => {
    it("imports valid JSONL content and returns metadata", () => {
      const store = new HubStore();
      const content = makeRecordingContent();
      const meta = store.importContent(content, "test.jsonl");

      expect(meta.id).toBeTruthy();
      expect(meta.sessionId).toBe("test-session");
      expect(meta.backendType).toBe("claude");
      expect(meta.entryCount).toBe(3);
      expect(meta.filename).toBe("test.jsonl");
      expect(meta.tags).toEqual([]);
    });

    it("rejects empty content", () => {
      const store = new HubStore();
      expect(() => store.importContent("")).toThrow("empty");
    });

    it("rejects invalid header", () => {
      const store = new HubStore();
      expect(() => store.importContent('{"version": 2}')).toThrow("Invalid recording header");
    });

    it("rejects invalid backend_type", () => {
      const store = new HubStore();
      const header = JSON.stringify({
        _header: true,
        version: 1,
        session_id: "s",
        backend_type: "invalid",
        started_at: 0,
        cwd: "/",
      });
      expect(() => store.importContent(header)).toThrow("Invalid backend_type");
    });

    it("rejects malformed entry JSON", () => {
      const store = new HubStore();
      const header = JSON.stringify({
        _header: true,
        version: 1,
        session_id: "s",
        backend_type: "claude",
        started_at: 0,
        cwd: "/",
      });
      expect(() => store.importContent(header + "\n{not json}")).toThrow("Malformed JSON");
    });
  });

  describe("list", () => {
    it("returns empty array when no recordings", () => {
      const store = new HubStore();
      expect(store.list()).toEqual([]);
    });

    it("returns all imported recordings", () => {
      const store = new HubStore();
      store.importContent(makeRecordingContent({ sessionId: "s1" }));
      store.importContent(makeRecordingContent({ sessionId: "s2" }));

      const list = store.list();
      expect(list).toHaveLength(2);
      const sessionIds = list.map((m) => m.sessionId);
      expect(sessionIds).toContain("s1");
      expect(sessionIds).toContain("s2");
    });
  });

  describe("get", () => {
    it("returns null for unknown id", () => {
      const store = new HubStore();
      expect(store.get("nonexistent")).toBeNull();
    });

    it("returns meta for known id", () => {
      const store = new HubStore();
      const meta = store.importContent(makeRecordingContent());
      expect(store.get(meta.id)).toEqual(meta);
    });
  });

  describe("delete", () => {
    it("returns false for unknown id", () => {
      const store = new HubStore();
      expect(store.delete("nonexistent")).toBe(false);
    });

    it("removes recording and returns true", () => {
      const store = new HubStore();
      const meta = store.importContent(makeRecordingContent());
      expect(store.delete(meta.id)).toBe(true);
      expect(store.get(meta.id)).toBeNull();
      expect(store.list()).toHaveLength(0);
    });
  });

  describe("updateTags", () => {
    it("updates tags on existing recording", () => {
      const store = new HubStore();
      const meta = store.importContent(makeRecordingContent());
      const updated = store.updateTags(meta.id, ["regression", "claude-code"]);
      expect(updated?.tags).toEqual(["regression", "claude-code"]);
    });

    it("returns null for unknown id", () => {
      const store = new HubStore();
      expect(store.updateTags("nonexistent", ["tag"])).toBeNull();
    });
  });

  describe("loadRecording", () => {
    it("loads full recording content", () => {
      const store = new HubStore();
      const meta = store.importContent(makeRecordingContent({ entries: 5 }));
      const recording = store.loadRecording(meta.id);
      expect(recording).not.toBeNull();
      expect(recording!.header.session_id).toBe("test-session");
      expect(recording!.entries).toHaveLength(5);
    });

    it("returns null for unknown id", () => {
      const store = new HubStore();
      expect(store.loadRecording("nonexistent")).toBeNull();
    });
  });

  describe("getSummary", () => {
    it("returns summary with tool names and permission count", () => {
      const store = new HubStore();
      const header = JSON.stringify({
        _header: true,
        version: 1,
        session_id: "s",
        backend_type: "claude",
        started_at: 0,
        cwd: "/",
      });
      const entries = [
        JSON.stringify({
          ts: 100,
          dir: "out",
          raw: JSON.stringify({ type: "permission_request", tool_name: "Bash" }),
          ch: "browser",
        }),
        JSON.stringify({
          ts: 200,
          dir: "out",
          raw: JSON.stringify({ type: "permission_request", tool_name: "Edit" }),
          ch: "browser",
        }),
        JSON.stringify({
          ts: 300,
          dir: "out",
          raw: JSON.stringify({ type: "assistant", text: "hello" }),
          ch: "browser",
        }),
      ];
      const content = [header, ...entries].join("\n");
      const meta = store.importContent(content);
      const summary = store.getSummary(meta.id);

      expect(summary).not.toBeNull();
      expect(summary!.toolNames).toContain("Bash");
      expect(summary!.toolNames).toContain("Edit");
      expect(summary!.permissionCount).toBe(2);
    });
  });

  describe("importLocal", () => {
    it("copies a recording file from the auto-recordings directory", () => {
      const store = new HubStore();
      // Create a source file in a temp location
      const sourceDir = join(TEST_HOME, "recordings");
      mkdirSync(sourceDir, { recursive: true });
      const sourcePath = join(sourceDir, "source.jsonl");
      writeFileSync(sourcePath, makeRecordingContent());

      const meta = store.importLocal(sourcePath);
      expect(meta.sessionId).toBe("test-session");
      // Source file should still exist (copy, not move)
      expect(existsSync(sourcePath)).toBe(true);
      // Hub file should exist
      expect(existsSync(store.recordingPath(meta.id))).toBe(true);
    });
  });

  describe("persistence", () => {
    it("persists index across HubStore instances", () => {
      // Import with first store
      const store1 = new HubStore();
      const meta = store1.importContent(makeRecordingContent());

      // Load with second store instance
      const store2 = new HubStore();
      expect(store2.get(meta.id)).toBeTruthy();
      expect(store2.get(meta.id)!.sessionId).toBe("test-session");
    });
  });
});
