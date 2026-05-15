import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SessionStore, type PersistedSession } from "./session-store.js";

let tempDir: string;
let store: SessionStore;

function makeSession(id: string, overrides: Partial<PersistedSession> = {}): PersistedSession {
  return {
    id,
    state: {
      session_id: id,
      model: "claude-sonnet-4-6",
      cwd: "/test",
      tools: [],
      permissionMode: "default",
      claude_code_version: "1.0.0",
      mcp_servers: [],
      agents: [],
      slash_commands: [],
      skills: [],
      total_cost_usd: 0,
      num_turns: 0,
      context_used_percent: 0,
      is_compacting: false,
      git_branch: "",
      is_worktree: false,
      is_containerized: false,
      repo_root: "",
      git_ahead: 0,
      git_behind: 0,
      total_lines_added: 0,
      total_lines_removed: 0,
    },
    messageHistory: [],
    pendingMessages: [],
    pendingPermissions: [],
    ...overrides,
  };
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "ss-test-"));
  store = new SessionStore(tempDir);
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

// ─── saveSync / load ──────────────────────────────────────────────────────────

describe("saveSync / load", () => {
  it("writes a session to disk and reads it back", () => {
    const session = makeSession("s1");
    store.saveSync(session);

    const filePath = join(tempDir, "s1.json");
    expect(existsSync(filePath)).toBe(true);

    const loaded = store.load("s1");
    expect(loaded).toEqual(session);
  });

  it("returns null for a non-existent session", () => {
    const loaded = store.load("does-not-exist");
    expect(loaded).toBeNull();
  });

  it("returns null for a corrupt JSON file", () => {
    writeFileSync(join(tempDir, "corrupt.json"), "{{not valid json!!", "utf-8");
    const loaded = store.load("corrupt");
    expect(loaded).toBeNull();
  });

  it("preserves all session fields through round-trip", () => {
    const session = makeSession("s2", {
      messageHistory: [{ type: "error", message: "test error" }],
      pendingMessages: ["msg1", "msg2"],
      pendingPermissions: [
        [
          "req-1",
          {
            request_id: "req-1",
            tool_name: "Write",
            input: { path: "/tmp/test.txt" },
            tool_use_id: "tu-1",
            timestamp: Date.now(),
          },
        ],
      ],
      eventBuffer: [
        { seq: 1, message: { type: "cli_connected" } },
      ],
      nextEventSeq: 2,
      lastAckSeq: 1,
      processedClientMessageIds: ["client-msg-1", "client-msg-2"],
      archived: true,
    });

    store.saveSync(session);
    const loaded = store.load("s2");
    expect(loaded).toEqual(session);
    expect(loaded!.archived).toBe(true);
    expect(loaded!.pendingPermissions).toHaveLength(1);
    expect(loaded!.pendingMessages).toEqual(["msg1", "msg2"]);
    expect(loaded!.eventBuffer).toEqual([{ seq: 1, message: { type: "cli_connected" } }]);
    expect(loaded!.nextEventSeq).toBe(2);
    expect(loaded!.lastAckSeq).toBe(1);
    expect(loaded!.processedClientMessageIds).toEqual(["client-msg-1", "client-msg-2"]);
  });
});

// ─── save (debounced) ─────────────────────────────────────────────────────────

describe("save (debounced)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not write immediately", () => {
    const session = makeSession("debounce-1");
    store.save(session);

    const filePath = join(tempDir, "debounce-1.json");
    expect(existsSync(filePath)).toBe(false);
  });

  it("writes after the 150ms debounce period", () => {
    const session = makeSession("debounce-2");
    store.save(session);

    vi.advanceTimersByTime(150);

    const filePath = join(tempDir, "debounce-2.json");
    expect(existsSync(filePath)).toBe(true);

    const loaded = store.load("debounce-2");
    expect(loaded).toEqual(session);
  });

  it("coalesces rapid calls and only writes the last version", () => {
    const session1 = makeSession("debounce-3", {
      pendingMessages: ["first"],
    });
    const session2 = makeSession("debounce-3", {
      pendingMessages: ["second"],
    });
    const session3 = makeSession("debounce-3", {
      pendingMessages: ["third"],
    });

    store.save(session1);
    vi.advanceTimersByTime(50);
    store.save(session2);
    vi.advanceTimersByTime(50);
    store.save(session3);

    // Not yet written (timer restarted with session3)
    expect(existsSync(join(tempDir, "debounce-3.json"))).toBe(false);

    vi.advanceTimersByTime(150);

    const loaded = store.load("debounce-3");
    expect(loaded!.pendingMessages).toEqual(["third"]);
  });
});

// ─── loadAll ──────────────────────────────────────────────────────────────────

describe("loadAll", () => {
  it("returns all saved sessions", () => {
    store.saveSync(makeSession("a"));
    store.saveSync(makeSession("b"));
    store.saveSync(makeSession("c"));

    const all = store.loadAll();
    const ids = all.map((s) => s.id).sort();
    expect(ids).toEqual(["a", "b", "c"]);
  });

  it("skips corrupt JSON files", () => {
    store.saveSync(makeSession("good"));
    writeFileSync(join(tempDir, "bad.json"), "not-json!", "utf-8");

    const all = store.loadAll();
    expect(all).toHaveLength(1);
    expect(all[0].id).toBe("good");
  });

  it("excludes launcher.json from results", () => {
    store.saveSync(makeSession("session-1"));
    store.saveLauncher({ some: "launcher data" });

    const all = store.loadAll();
    expect(all).toHaveLength(1);
    expect(all[0].id).toBe("session-1");
  });

  it("returns an empty array for an empty directory", () => {
    const all = store.loadAll();
    expect(all).toEqual([]);
  });
});

// ─── setArchived ──────────────────────────────────────────────────────────────

describe("setArchived", () => {
  it("sets archived flag to true and persists it", () => {
    store.saveSync(makeSession("arch-1"));
    const result = store.setArchived("arch-1", true);

    expect(result).toBe(true);

    const loaded = store.load("arch-1");
    expect(loaded!.archived).toBe(true);
  });

  it("sets archived flag to false and persists it", () => {
    store.saveSync(makeSession("arch-2", { archived: true }));
    const result = store.setArchived("arch-2", false);

    expect(result).toBe(true);

    const loaded = store.load("arch-2");
    expect(loaded!.archived).toBe(false);
  });

  it("returns false for a non-existent session", () => {
    const result = store.setArchived("no-such-session", true);
    expect(result).toBe(false);
  });
});

// ─── remove ───────────────────────────────────────────────────────────────────

describe("remove", () => {
  it("deletes the session file from disk", () => {
    store.saveSync(makeSession("rm-1"));
    expect(existsSync(join(tempDir, "rm-1.json"))).toBe(true);

    store.remove("rm-1");
    expect(existsSync(join(tempDir, "rm-1.json"))).toBe(false);
    expect(store.load("rm-1")).toBeNull();
  });

  it("cancels a pending debounced save so it never writes", () => {
    vi.useFakeTimers();
    try {
      const session = makeSession("rm-2");
      store.save(session);

      // Remove before the debounce fires
      store.remove("rm-2");

      // Advance past the debounce window
      vi.advanceTimersByTime(300);

      expect(existsSync(join(tempDir, "rm-2.json"))).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not throw when removing a non-existent session", () => {
    expect(() => store.remove("ghost-session")).not.toThrow();
  });
});

// ─── saveLauncher / loadLauncher ──────────────────────────────────────────────

describe("saveLauncher / loadLauncher", () => {
  it("writes and reads launcher data", () => {
    const data = { pids: [123, 456], lastBoot: "2025-01-01T00:00:00Z" };
    store.saveLauncher(data);

    const loaded = store.loadLauncher<{ pids: number[]; lastBoot: string }>();
    expect(loaded).toEqual(data);
  });

  it("returns null when no launcher file exists", () => {
    const loaded = store.loadLauncher();
    expect(loaded).toBeNull();
  });
});

// ─── Legacy /tmp migration ───────────────────────────────────────────────────
// /tmp gets wiped on most Linux distros at boot, so a fresh boot loses every
// session. Default storage now lives under ~/.companion/sessions, but to keep
// upgrades seamless we copy any leftover files from the legacy $TMPDIR path
// the first time a SessionStore is created with the default location.

describe("legacy /tmp migration", () => {
  let homeDir: string;
  let legacyDir: string;
  let prevHome: string | undefined;
  let prevTmp: string | undefined;

  beforeEach(() => {
    // Sandbox HOME and TMPDIR so the test does not touch the real disk.
    homeDir = mkdtempSync(join(tmpdir(), "ss-home-"));
    const tmpRoot = mkdtempSync(join(tmpdir(), "ss-tmp-"));
    legacyDir = join(tmpRoot, "vibe-sessions");
    prevHome = process.env.HOME;
    prevTmp = process.env.TMPDIR;
    process.env.HOME = homeDir;
    process.env.TMPDIR = tmpRoot;
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevTmp === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = prevTmp;
    rmSync(homeDir, { recursive: true, force: true });
    rmSync(legacyDir, { recursive: true, force: true });
  });

  it("copies launcher.json and per-session files from legacy $TMPDIR/vibe-sessions/ on first default-path init", () => {
    // Seed the legacy dir with a launcher.json + one session file.
    const legacyStore = new SessionStore(legacyDir);
    legacyStore.saveLauncher([{ sessionId: "legacy-1", state: "exited" }]);
    legacyStore.saveSync(makeSession("legacy-1"));

    // Construct with no dir arg → uses default ~/.companion/sessions and
    // should pull the legacy files over.
    const migrated = new SessionStore();

    expect(migrated.loadLauncher()).toEqual([{ sessionId: "legacy-1", state: "exited" }]);
    expect(migrated.load("legacy-1")?.id).toBe("legacy-1");
  });

  it("does not migrate when an explicit dir is passed (custom deployments must opt in)", () => {
    // Seed legacy dir.
    const legacyStore = new SessionStore(legacyDir);
    legacyStore.saveSync(makeSession("legacy-1"));

    // Caller passes a custom dir — we must respect it and leave it pristine.
    const customDir = mkdtempSync(join(tmpdir(), "ss-custom-"));
    try {
      const custom = new SessionStore(customDir);
      expect(custom.load("legacy-1")).toBeNull();
    } finally {
      rmSync(customDir, { recursive: true, force: true });
    }
  });

  it("does not overwrite an existing session in the new dir", () => {
    // If the user already has data in ~/.companion/sessions from a prior run
    // of the new code, do not let the legacy /tmp contents stomp on it.
    const newDir = join(homeDir, ".companion", "sessions");
    const seed = new SessionStore(newDir);
    seed.saveSync(makeSession("legacy-1", { state: { ...makeSession("legacy-1").state, cwd: "/from-new-dir" } }));

    const legacyStore = new SessionStore(legacyDir);
    legacyStore.saveSync(makeSession("legacy-1", { state: { ...makeSession("legacy-1").state, cwd: "/from-legacy" } }));

    const migrated = new SessionStore();
    expect(migrated.load("legacy-1")?.state.cwd).toBe("/from-new-dir");
  });

  it("is a no-op when the legacy directory does not exist", () => {
    // Most fresh installs will hit this path.
    expect(() => new SessionStore()).not.toThrow();
  });
});
