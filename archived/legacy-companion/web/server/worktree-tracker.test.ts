import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  readFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { WorktreeMapping } from "./worktree-tracker.js";

let tempDir: string;
let WorktreeTracker: typeof import("./worktree-tracker.js").WorktreeTracker;

const mockHomedir = vi.hoisted(() => {
  let dir = "";
  return {
    get: () => dir,
    set: (d: string) => {
      dir = d;
    },
  };
});

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return {
    ...actual,
    homedir: () => mockHomedir.get(),
  };
});

beforeEach(async () => {
  tempDir = mkdtempSync(join(tmpdir(), "wt-test-"));
  mockHomedir.set(tempDir);
  vi.resetModules();
  const mod = await import("./worktree-tracker.js");
  WorktreeTracker = mod.WorktreeTracker;
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function makeMapping(overrides: Partial<WorktreeMapping> = {}): WorktreeMapping {
  return {
    sessionId: "session-1",
    repoRoot: "/repo",
    branch: "feat-1",
    worktreePath: "/worktrees/feat-1",
    createdAt: Date.now(),
    ...overrides,
  };
}

function trackerFilePath(): string {
  return join(tempDir, ".companion", "worktrees.json");
}

function readTrackerFile(): WorktreeMapping[] {
  return JSON.parse(readFileSync(trackerFilePath(), "utf-8"));
}

// ─── Constructor ─────────────────────────────────────────────────────────────

describe("WorktreeTracker", () => {
  describe("constructor", () => {
    it("initializes with empty mappings when no file exists", () => {
      const tracker = new WorktreeTracker();
      expect(tracker.getBySession("anything")).toBeNull();
    });

    it("loads existing mappings from disk", () => {
      const mapping = makeMapping();
      mkdirSync(join(tempDir, ".companion"), { recursive: true });
      writeFileSync(trackerFilePath(), JSON.stringify([mapping]));

      const tracker = new WorktreeTracker();
      expect(tracker.getBySession("session-1")).toEqual(mapping);
    });

    it("handles corrupt JSON gracefully", () => {
      mkdirSync(join(tempDir, ".companion"), { recursive: true });
      writeFileSync(trackerFilePath(), "NOT VALID JSON {{{");

      const tracker = new WorktreeTracker();
      expect(tracker.getBySession("anything")).toBeNull();
    });
  });

  // ─── addMapping ──────────────────────────────────────────────────────────────

  describe("addMapping", () => {
    it("persists mapping to disk", () => {
      const tracker = new WorktreeTracker();
      const mapping = makeMapping();
      tracker.addMapping(mapping);

      const onDisk = readTrackerFile();
      expect(onDisk).toHaveLength(1);
      expect(onDisk[0]).toEqual(mapping);
    });

    it("replaces existing mapping for same sessionId", () => {
      const tracker = new WorktreeTracker();
      const original = makeMapping({ branch: "feat-1" });
      tracker.addMapping(original);

      const updated = makeMapping({ branch: "feat-2", worktreePath: "/worktrees/feat-2" });
      tracker.addMapping(updated);

      const onDisk = readTrackerFile();
      expect(onDisk).toHaveLength(1);
      expect(onDisk[0].branch).toBe("feat-2");
      expect(onDisk[0].worktreePath).toBe("/worktrees/feat-2");
    });

    it("allows multiple mappings with different sessionIds", () => {
      const tracker = new WorktreeTracker();
      tracker.addMapping(makeMapping({ sessionId: "s1" }));
      tracker.addMapping(makeMapping({ sessionId: "s2" }));
      tracker.addMapping(makeMapping({ sessionId: "s3" }));

      const onDisk = readTrackerFile();
      expect(onDisk).toHaveLength(3);
    });
  });

  // ─── removeBySession ────────────────────────────────────────────────────────

  describe("removeBySession", () => {
    it("returns removed mapping and persists deletion", () => {
      const tracker = new WorktreeTracker();
      const mapping = makeMapping();
      tracker.addMapping(mapping);

      const removed = tracker.removeBySession("session-1");
      expect(removed).toEqual(mapping);

      const onDisk = readTrackerFile();
      expect(onDisk).toHaveLength(0);
    });

    it("returns null for unknown sessionId", () => {
      const tracker = new WorktreeTracker();
      const result = tracker.removeBySession("nonexistent");
      expect(result).toBeNull();
    });
  });

  // ─── getBySession ───────────────────────────────────────────────────────────

  describe("getBySession", () => {
    it("returns mapping when found", () => {
      const tracker = new WorktreeTracker();
      const mapping = makeMapping();
      tracker.addMapping(mapping);

      expect(tracker.getBySession("session-1")).toEqual(mapping);
    });

    it("returns null when not found", () => {
      const tracker = new WorktreeTracker();
      expect(tracker.getBySession("nonexistent")).toBeNull();
    });
  });

  // ─── getSessionsForWorktree ─────────────────────────────────────────────────

  describe("getSessionsForWorktree", () => {
    it("returns all mappings sharing a worktree path", () => {
      const tracker = new WorktreeTracker();
      const sharedPath = "/worktrees/shared";
      tracker.addMapping(makeMapping({ sessionId: "s1", worktreePath: sharedPath }));
      tracker.addMapping(makeMapping({ sessionId: "s2", worktreePath: sharedPath }));
      tracker.addMapping(makeMapping({ sessionId: "s3", worktreePath: "/worktrees/other" }));

      const results = tracker.getSessionsForWorktree(sharedPath);
      expect(results).toHaveLength(2);
      expect(results.map((r) => r.sessionId).sort()).toEqual(["s1", "s2"]);
    });

    it("returns empty array when no sessions use the worktree", () => {
      const tracker = new WorktreeTracker();
      tracker.addMapping(makeMapping({ worktreePath: "/worktrees/other" }));

      const results = tracker.getSessionsForWorktree("/worktrees/nonexistent");
      expect(results).toEqual([]);
    });
  });

  // ─── getSessionsForRepo ─────────────────────────────────────────────────────

  describe("getSessionsForRepo", () => {
    it("returns all mappings for a repo root", () => {
      const tracker = new WorktreeTracker();
      tracker.addMapping(makeMapping({ sessionId: "s1", repoRoot: "/repo-a", branch: "feat-1" }));
      tracker.addMapping(makeMapping({ sessionId: "s2", repoRoot: "/repo-a", branch: "feat-2" }));
      tracker.addMapping(makeMapping({ sessionId: "s3", repoRoot: "/repo-b", branch: "feat-1" }));

      const results = tracker.getSessionsForRepo("/repo-a");
      expect(results).toHaveLength(2);
      expect(results.map((r) => r.sessionId).sort()).toEqual(["s1", "s2"]);
    });

    it("returns empty array when no sessions belong to the repo", () => {
      const tracker = new WorktreeTracker();
      const results = tracker.getSessionsForRepo("/nonexistent-repo");
      expect(results).toEqual([]);
    });
  });

  // ─── isWorktreeInUse ────────────────────────────────────────────────────────

  describe("isWorktreeInUse", () => {
    it("returns true when another session uses the worktree", () => {
      const tracker = new WorktreeTracker();
      tracker.addMapping(makeMapping({ sessionId: "s1", worktreePath: "/worktrees/feat" }));

      expect(tracker.isWorktreeInUse("/worktrees/feat")).toBe(true);
    });

    it("returns false when no session uses the worktree", () => {
      const tracker = new WorktreeTracker();
      expect(tracker.isWorktreeInUse("/worktrees/feat")).toBe(false);
    });

    it("excludes the specified session from the check", () => {
      const tracker = new WorktreeTracker();
      tracker.addMapping(makeMapping({ sessionId: "s1", worktreePath: "/worktrees/feat" }));

      expect(tracker.isWorktreeInUse("/worktrees/feat", "s1")).toBe(false);
    });

    it("returns true when other sessions use it despite excludeSessionId", () => {
      const tracker = new WorktreeTracker();
      tracker.addMapping(makeMapping({ sessionId: "s1", worktreePath: "/worktrees/feat" }));
      tracker.addMapping(makeMapping({ sessionId: "s2", worktreePath: "/worktrees/feat" }));

      expect(tracker.isWorktreeInUse("/worktrees/feat", "s1")).toBe(true);
    });
  });
});
