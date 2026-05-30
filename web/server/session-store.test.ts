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

// ─── ideBinding persistence (Task 8: BIND-03, STATE-01) ───────────────────────
//
// These tests verify:
//   a) ideBinding round-trips through the store cleanly (minus authToken).
//   b) authToken is NEVER written to disk — neither as a string nor a JSON key.
//      (SPEC.md BIND-03 line 30: "authToken is NOT written to disk".)
//   c) The loader tolerates a stale/dangling lockfilePath without throwing.

describe("ideBinding persistence (BIND-03, STATE-01)", () => {
  // (a) Roundtrip: populated ideBinding without authToken must come back byte-equal.
  it("round-trips an ideBinding through saveSync / load", () => {
    const boundAt = 1_700_000_000_000;
    const session = makeSession("ide-a", {
      state: {
        ...makeSession("ide-a").state,
        ideBinding: {
          port: 63210,
          ideName: "Neovim",
          workspaceFolders: ["/Users/test/project"],
          transport: "ws-ide",
          boundAt,
          lockfilePath: "/Users/test/.claude/ide/63210.lock",
        },
      },
    });

    store.saveSync(session);

    // Simulate a server restart: drop in-memory state and reload from disk.
    const reloaded = store.load("ide-a");
    expect(reloaded).not.toBeNull();
    expect(reloaded!.state.ideBinding).toEqual({
      port: 63210,
      ideName: "Neovim",
      workspaceFolders: ["/Users/test/project"],
      transport: "ws-ide",
      boundAt,
      lockfilePath: "/Users/test/.claude/ide/63210.lock",
    });
  });

  // (b) SECURITY: authToken must NEVER be persisted — string-level and key-level check.
  //     Corresponds to BIND-03 (SPEC.md line 30).
  it("never writes authToken to disk even when present in ideBinding", () => {
    const session = makeSession("ide-b", {
      state: {
        ...makeSession("ide-b").state,
        ideBinding: {
          port: 63211,
          ideName: "Visual Studio Code",
          workspaceFolders: ["/Users/test/project-b"],
          transport: "ws-ide",
          authToken: "secret-token-xyz",
          boundAt: 1_700_000_000_000,
          lockfilePath: "/Users/test/.claude/ide/63211.lock",
        },
      },
    });

    store.saveSync(session);

    // String-level proof: the raw token must not appear anywhere on disk.
    const raw = readFileSync(join(tempDir, "ide-b.json"), "utf-8");
    expect(raw).not.toContain("secret-token-xyz");

    // Key-level proof: recursively walk the parsed JSON and assert no `authToken` key.
    const parsed = JSON.parse(raw);
    const findAuthToken = (node: unknown, path: string[] = []): string[] | null => {
      if (node && typeof node === "object") {
        for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
          if (k === "authToken") return [...path, k];
          const nested = findAuthToken(v, [...path, k]);
          if (nested) return nested;
        }
      }
      return null;
    };
    expect(findAuthToken(parsed)).toBeNull();

    // Also verify the rest of the binding survived the sanitization.
    const reloaded = store.load("ide-b");
    expect(reloaded!.state.ideBinding).toMatchObject({
      port: 63211,
      ideName: "Visual Studio Code",
      transport: "ws-ide",
    });
    expect((reloaded!.state.ideBinding as unknown as Record<string, unknown>).authToken).toBeUndefined();
  });

  // (c) Stale lockfile: a dangling lockfilePath must NOT crash the loader.
  //     Behavior observed in this codebase: the loader PRESERVES the stale
  //     ideBinding as-is (ws-bridge is expected to reconcile via the discovery
  //     rescan and emit ide:removed). We assert "does not throw" + "no crash"
  //     without asserting a specific post-value beyond the two allowed options.
  it("tolerates an ideBinding whose lockfilePath no longer exists", () => {
    const session = makeSession("ide-c", {
      state: {
        ...makeSession("ide-c").state,
        ideBinding: {
          port: 63212,
          ideName: "Neovim",
          workspaceFolders: ["/Users/test/project-c"],
          transport: "ws-ide",
          boundAt: 1_700_000_000_000,
          lockfilePath: "/tmp/definitely-does-not-exist-12345.lock",
        },
      },
    });

    store.saveSync(session);

    // Loader must not throw on a dangling lockfilePath.
    let reloaded: PersistedSession | null = null;
    expect(() => {
      reloaded = store.load("ide-c");
    }).not.toThrow();

    expect(reloaded).not.toBeNull();
    const binding = reloaded!.state.ideBinding;
    // Acceptable: either preserved as-is OR proactively set to null.
    // This codebase's SessionStore does a raw JSON load (no lockfile touch at
    // load time), so behavior is "preserve as-is"; ws-bridge reconciles later.
    const isPreserved =
      binding !== null &&
      binding !== undefined &&
      binding.lockfilePath === "/tmp/definitely-does-not-exist-12345.lock";
    const isNulled = binding === null;
    expect(isPreserved || isNulled).toBe(true);
  });
});
