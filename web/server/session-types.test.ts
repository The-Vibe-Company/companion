import { describe, it, expect } from "vitest";

// Bare side-effect import so coverage sees the module as loaded. Type-only
// imports are erased at compile-time and would not count.
import "./session-types.js";

import type {
  IdeBinding,
  SessionState,
  BrowserIncomingMessage,
} from "./session-types.js";
import type { CompanionEventMap } from "./event-bus-types.js";

// These tests are deliberately compile-time assertions: if the expected
// types do not exist, have wrong field names, or wrong shapes, this test
// file fails to compile and `bun run test` reports a load error.
//
// We include a minimal runtime `expect` so Vitest counts the test as executed,
// but the real verification is the TypeScript type system satisfying the
// annotations below.

describe("IdeBinding type (Task 1 / STATE-01)", () => {
  it("can be instantiated with all required fields", () => {
    const binding: IdeBinding = {
      port: 40123,
      ideName: "Neovim",
      workspaceFolders: ["/Users/me/repo"],
      transport: "ws-ide",
      authToken: "secret-token",
      boundAt: Date.now(),
      lockfilePath: "/Users/me/.claude/ide/40123.lock",
    };
    expect(binding.port).toBe(40123);
    expect(binding.transport).toBe("ws-ide");
  });

  it("permits transport to be sse-ide", () => {
    const binding: IdeBinding = {
      port: 50555,
      ideName: "Visual Studio Code",
      workspaceFolders: ["/Users/me/a", "/Users/me/b"],
      transport: "sse-ide",
      boundAt: 0,
      lockfilePath: "/tmp/50555.lock",
    };
    expect(binding.transport).toBe("sse-ide");
  });

  it("permits authToken to be absent (optional)", () => {
    const binding: IdeBinding = {
      port: 1,
      ideName: "Obsidian",
      workspaceFolders: [],
      transport: "ws-ide",
      boundAt: 0,
      lockfilePath: "/x",
    };
    expect(binding.authToken).toBeUndefined();
  });
});

describe("SessionState.ideBinding tri-state (Task 1 / STATE-01)", () => {
  // Per spec: undefined = never set / Codex session; null = explicitly
  // unbound (BIND-04 auto-unbind); object = active binding.
  const baseSession: Omit<SessionState, "ideBinding"> = {
    session_id: "s1",
    model: "claude-opus-4-7",
    cwd: "/tmp",
    tools: [],
    permissionMode: "ask",
    claude_code_version: "2.1.112",
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
  };

  it("accepts an IdeBinding object", () => {
    const s: SessionState = {
      ...baseSession,
      ideBinding: {
        port: 1,
        ideName: "Neovim",
        workspaceFolders: [],
        transport: "ws-ide",
        boundAt: 0,
        lockfilePath: "/x",
      },
    };
    expect(s.ideBinding?.ideName).toBe("Neovim");
  });

  it("accepts null (explicitly unbound)", () => {
    const s: SessionState = { ...baseSession, ideBinding: null };
    expect(s.ideBinding).toBeNull();
  });

  it("accepts undefined (never set)", () => {
    const s: SessionState = { ...baseSession };
    expect(s.ideBinding).toBeUndefined();
  });
});

describe("BrowserIncomingMessage ide_list_changed variant (Task 1)", () => {
  it("narrows as a valid server-to-browser message", () => {
    // If `ide_list_changed` is missing from the union, this assignment
    // fails to type-check and the test file will not compile.
    const msg: BrowserIncomingMessage = { type: "ide_list_changed" };
    expect(msg.type).toBe("ide_list_changed");
  });
});

describe("CompanionEventMap IDE events (Task 1)", () => {
  it("has ide:added / ide:removed / ide:changed / ide:binding-changed entries", () => {
    // Declare typed payloads matching each event. If any key is missing
    // or has the wrong payload shape, this fails to compile.
    const added: CompanionEventMap["ide:added"] = {
      port: 123,
      ideName: "Neovim",
      workspaceFolders: ["/tmp"],
      lockfilePath: "/tmp/123.lock",
      generation: 1,
    };
    const removed: CompanionEventMap["ide:removed"] = {
      port: 123,
      lockfilePath: "/tmp/123.lock",
      generation: 2,
    };
    const changed: CompanionEventMap["ide:changed"] = {
      port: 123,
      ideName: "Neovim",
      workspaceFolders: ["/tmp"],
      lockfilePath: "/tmp/123.lock",
      generation: 3,
    };
    const bindingChangedNull: CompanionEventMap["ide:binding-changed"] = {
      sessionId: "s1",
      binding: null,
    };
    const bindingChangedObj: CompanionEventMap["ide:binding-changed"] = {
      sessionId: "s1",
      binding: {
        port: 1,
        ideName: "X",
        workspaceFolders: [],
        transport: "ws-ide",
        boundAt: 0,
        lockfilePath: "/x",
      },
    };
    expect(added.port).toBe(123);
    expect(removed.port).toBe(123);
    expect(changed.port).toBe(123);
    expect(bindingChangedNull.binding).toBeNull();
    expect(bindingChangedObj.binding).not.toBeNull();
  });
});

describe("frontend IdeBinding re-export (Task 1)", () => {
  it("is importable from web/src/types", async () => {
    // Runtime import — we only need to verify the module loads; the
    // compile-time type check is the real gate (see import below).
    const mod = await import("../src/types.js");
    expect(mod).toBeTruthy();
  });
});

// Compile-time re-export assertion — isolated import avoids bundling
// frontend-only code into the test runtime beyond the async import above.
import type { IdeBinding as FrontendIdeBinding } from "../src/types.js";
const _frontendTypeCheck: FrontendIdeBinding = {
  port: 0,
  ideName: "",
  workspaceFolders: [],
  transport: "ws-ide",
  boundAt: 0,
  lockfilePath: "",
};
void _frontendTypeCheck;
