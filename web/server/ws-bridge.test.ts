import { vi } from "vitest";

// Stub Bun global for vitest (runs under Node, not Bun).
// Bun.hash is used for CLI message deduplication in ws-bridge.ts.
// A simple string hash is sufficient for test determinism.
if (typeof globalThis.Bun === "undefined") {
  (globalThis as any).Bun = {
    hash(input: string | Uint8Array): number {
      const s = typeof input === "string" ? input : new TextDecoder().decode(input);
      let h = 0;
      for (let i = 0; i < s.length; i++) {
        h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
      }
      return h >>> 0; // unsigned 32-bit
    },
  };
}

const mockExecSync = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ execSync: mockExecSync }));
vi.mock("node:crypto", () => ({ randomUUID: () => "test-uuid" }));

// Mock settings-manager to prevent AI validation from interfering with tests.
// Without this mock, the real settings file (~/.companion/settings.json) may have
// aiValidationEnabled: true, causing handleControlRequest to call validatePermission
// (an external API call) and auto-approve/deny permissions before they reach pendingPermissions.
vi.mock("./settings-manager.js", () => ({
  getSettings: () => ({
    aiValidationEnabled: false,
    aiValidationAutoApprove: false,
    aiValidationAutoDeny: false,
    anthropicApiKey: "",
  }),
  DEFAULT_ANTHROPIC_MODEL: "claude-sonnet-4-6",
}));

import { WsBridge, type SocketData } from "./ws-bridge.js";
import { SessionStore } from "./session-store.js";
import { containerManager } from "./container-manager.js";
import { companionBus } from "./event-bus.js";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

function createMockSocket(data: SocketData) {
  return {
    data,
    send: vi.fn(),
    close: vi.fn(),
    readyState: 1,
  } as any;
}

function makeCliSocket(sessionId: string) {
  return createMockSocket({ kind: "cli", sessionId });
}

function makeBrowserSocket(sessionId: string) {
  return createMockSocket({ kind: "browser", sessionId });
}

let bridge: WsBridge;
let tempDir: string;
let store: SessionStore;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "bridge-test-"));
  store = new SessionStore(tempDir);
  bridge = new WsBridge();
  bridge.setStore(store);
  mockExecSync.mockReset();
  companionBus.clear();
  // Suppress console output to prevent Vitest EnvironmentTeardownError.
  // ws-bridge.ts and session-store.ts log via console.log/warn/error;
  // when the Vitest worker tears down while a console relay RPC is still
  // in-flight, it causes "Closing rpc while onUserConsoleLog was pending".
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  // Cancel pending debounce timers from SessionStore before removing
  // the temp directory. Without this, debounced writes fire after rmSync
  // and produce console.error calls that race with Vitest worker teardown.
  store.dispose();
  rmSync(tempDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

// Re-suppress console after the last test to prevent "Closing rpc while
// onUserConsoleLog was pending" during Vitest worker teardown.
afterAll(() => {
  const noop = () => {};
  console.log = noop;
  console.warn = noop;
  console.error = noop;
});

// ─── Helper: build a system.init NDJSON string ────────────────────────────────

function makeInitMsg(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    type: "system",
    subtype: "init",
    session_id: "cli-123",
    model: "claude-sonnet-4-6",
    cwd: "/test",
    tools: ["Bash", "Read"],
    permissionMode: "default",
    claude_code_version: "1.0",
    mcp_servers: [],
    agents: [],
    slash_commands: [],
    skills: [],
    output_style: "normal",
    uuid: "uuid-1",
    apiKeySource: "env",
    ...overrides,
  });
}

// ─── Session management ──────────────────────────────────────────────────────

describe("Session management", () => {
  it("getOrCreateSession: creates new session with default state", () => {
    const session = bridge.getOrCreateSession("s1");
    expect(session.id).toBe("s1");
    expect(session.state.session_id).toBe("s1");
    expect(session.state.model).toBe("");
    expect(session.state.cwd).toBe("");
    expect(session.state.tools).toEqual([]);
    expect(session.state.permissionMode).toBe("default");
    expect(session.state.total_cost_usd).toBe(0);
    expect(session.state.num_turns).toBe(0);
    expect(session.state.context_used_percent).toBe(0);
    expect(session.state.is_compacting).toBe(false);
    expect(session.state.git_branch).toBe("");
    expect(session.state.is_worktree).toBe(false);
    expect(session.state.is_containerized).toBe(false);
    expect(session.state.repo_root).toBe("");
    expect(session.state.git_ahead).toBe(0);
    expect(session.state.git_behind).toBe(0);
    expect(session.backendAdapter).toBeNull();
    expect(session.browserSockets.size).toBe(0);
    expect(session.pendingPermissions.size).toBe(0);
    expect(session.messageHistory).toEqual([]);
    expect(session.pendingMessages).toEqual([]);
  });

  it("getOrCreateSession: returns existing session on second call", () => {
    const first = bridge.getOrCreateSession("s1");
    first.state.model = "modified";
    const second = bridge.getOrCreateSession("s1");
    expect(second).toBe(first);
    expect(second.state.model).toBe("modified");
  });

  it("getOrCreateSession: sets backendType when creating a new session", () => {
    const session = bridge.getOrCreateSession("s1", "codex");
    expect(session.backendType).toBe("codex");
    expect(session.state.backend_type).toBe("codex");
  });

  it("getOrCreateSession: does NOT overwrite backendType when called without explicit type", () => {
    // Simulate: attachCodexAdapter creates session as "codex"
    const session = bridge.getOrCreateSession("s1", "codex");
    expect(session.backendType).toBe("codex");
    expect(session.state.backend_type).toBe("codex");

    // Simulate: handleBrowserOpen calls getOrCreateSession without backendType
    const same = bridge.getOrCreateSession("s1");
    expect(same.backendType).toBe("codex");
    expect(same.state.backend_type).toBe("codex");
  });

  it("getOrCreateSession: overwrites backendType when explicitly provided on existing session", () => {
    const session = bridge.getOrCreateSession("s1");
    expect(session.backendType).toBe("claude");

    // Explicit override (e.g. attachCodexAdapter)
    bridge.getOrCreateSession("s1", "codex");
    expect(session.backendType).toBe("codex");
    expect(session.state.backend_type).toBe("codex");
  });

  it("getSession: returns undefined for unknown session", () => {
    expect(bridge.getSession("nonexistent")).toBeUndefined();
  });

  it("getAllSessions: returns all session states", () => {
    bridge.getOrCreateSession("s1");
    bridge.getOrCreateSession("s2");
    bridge.getOrCreateSession("s3");
    const all = bridge.getAllSessions();
    expect(all).toHaveLength(3);
    const ids = all.map((s) => s.session_id);
    expect(ids).toContain("s1");
    expect(ids).toContain("s2");
    expect(ids).toContain("s3");
  });

  it("isCliConnected: returns false without CLI socket", () => {
    bridge.getOrCreateSession("s1");
    expect(bridge.isCliConnected("s1")).toBe(false);
    expect(bridge.isCliConnected("nonexistent")).toBe(false);
  });

  it("removeSession: deletes from map and store", () => {
    bridge.getOrCreateSession("s1");
    const removeSpy = vi.spyOn(store, "remove");
    bridge.removeSession("s1");
    expect(bridge.getSession("s1")).toBeUndefined();
    expect(removeSpy).toHaveBeenCalledWith("s1");
  });

  it("closeSession: closes all sockets and removes session", () => {
    const cli = makeCliSocket("s1");
    const browser1 = makeBrowserSocket("s1");
    const browser2 = makeBrowserSocket("s1");

    bridge.handleCLIOpen(cli, "s1");
    bridge.handleBrowserOpen(browser1, "s1");
    bridge.handleBrowserOpen(browser2, "s1");

    bridge.closeSession("s1");

    expect(cli.close).toHaveBeenCalled();
    expect(browser1.close).toHaveBeenCalled();
    expect(browser2.close).toHaveBeenCalled();
    expect(bridge.getSession("s1")).toBeUndefined();
  });
});

// ─── prePopulateCommands ─────────────────────────────────────────────────────

describe("prePopulateCommands", () => {
  it("populates empty session state with commands and skills", () => {
    // When a session has no commands/skills yet, prePopulateCommands should
    // set them so the slash menu works before system.init arrives.
    bridge.prePopulateCommands("s1", ["commit", "review-pr"], ["my-skill"]);
    const session = bridge.getSession("s1")!;
    expect(session.state.slash_commands).toEqual(["commit", "review-pr"]);
    expect(session.state.skills).toEqual(["my-skill"]);
  });

  it("does not overwrite existing commands if already set", () => {
    // If system.init already arrived and set commands, prePopulateCommands
    // should not clobber them (guard against race condition).
    const session = bridge.getOrCreateSession("s1");
    session.state.slash_commands = ["existing-cmd"];
    session.state.skills = ["existing-skill"];

    bridge.prePopulateCommands("s1", ["new-cmd"], ["new-skill"]);

    expect(session.state.slash_commands).toEqual(["existing-cmd"]);
    expect(session.state.skills).toEqual(["existing-skill"]);
  });

  it("partially populates when only one field is empty", () => {
    // If commands are already set but skills are empty, only skills
    // should be populated.
    const session = bridge.getOrCreateSession("s1");
    session.state.slash_commands = ["existing-cmd"];
    session.state.skills = [];

    bridge.prePopulateCommands("s1", ["new-cmd"], ["new-skill"]);

    expect(session.state.slash_commands).toEqual(["existing-cmd"]);
    expect(session.state.skills).toEqual(["new-skill"]);
  });

  it("does nothing when provided arrays are empty", () => {
    // Empty discovery results should not replace the (also empty) defaults.
    bridge.prePopulateCommands("s1", [], []);
    const session = bridge.getSession("s1")!;
    expect(session.state.slash_commands).toEqual([]);
    expect(session.state.skills).toEqual([]);
  });

  it("pre-populated data appears in session_init broadcast to browsers", () => {
    // When a browser connects after prePopulateCommands, the session_init
    // message should include the pre-populated commands/skills.
    bridge.prePopulateCommands("s1", ["deploy"], ["prd"]);

    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");

    // The session_init message sent to the browser should contain the pre-populated data
    expect(browser.send).toHaveBeenCalled();
    const sentData = JSON.parse(browser.send.mock.calls[0][0]);
    expect(sentData.type).toBe("session_init");
    expect(sentData.session.slash_commands).toEqual(["deploy"]);
    expect(sentData.session.skills).toEqual(["prd"]);
  });

  it("broadcasts session_init to already-connected browsers when state changes", () => {
    // If a browser is already connected when prePopulateCommands runs
    // (e.g. discovery resolved after browser connected), the browser should
    // receive a session_init with the updated commands/skills.
    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");
    browser.send.mockClear();

    bridge.prePopulateCommands("s1", ["deploy"], ["prd"]);

    expect(browser.send).toHaveBeenCalledTimes(1);
    const sentData = JSON.parse(browser.send.mock.calls[0][0]);
    expect(sentData.type).toBe("session_init");
    expect(sentData.session.slash_commands).toEqual(["deploy"]);
    expect(sentData.session.skills).toEqual(["prd"]);
  });

  it("does not broadcast when no browsers are connected", () => {
    // When no browsers are subscribed, prePopulateCommands should not
    // attempt to broadcast (no-op beyond state mutation).
    bridge.prePopulateCommands("s1", ["deploy"], ["prd"]);
    const session = bridge.getSession("s1")!;
    // State should still be updated
    expect(session.state.slash_commands).toEqual(["deploy"]);
    expect(session.state.skills).toEqual(["prd"]);
    // No browser sockets to verify send wasn't called -- just ensure no throw
  });

  it("does not broadcast when state did not change", () => {
    // When provided arrays are empty, no state change occurs and no
    // broadcast should be sent even if browsers are connected.
    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");
    browser.send.mockClear();

    bridge.prePopulateCommands("s1", [], []);

    expect(browser.send).not.toHaveBeenCalled();
  });

  it("system.init overwrites pre-populated data with authoritative list", async () => {
    // After prePopulateCommands, when CLI sends system.init, the CLI's
    // authoritative list should replace the pre-populated data.
    bridge.prePopulateCommands("s1", ["pre-cmd"], ["pre-skill"]);

    const cli = makeCliSocket("s1");
    bridge.handleCLIOpen(cli, "s1");
    await bridge.handleCLIMessage(
      cli,
      makeInitMsg({
        slash_commands: ["cli-cmd-1", "cli-cmd-2"],
        skills: ["cli-skill"],
      }),
    );

    const session = bridge.getSession("s1")!;
    expect(session.state.slash_commands).toEqual(["cli-cmd-1", "cli-cmd-2"]);
    expect(session.state.skills).toEqual(["cli-skill"]);
  });
});

// ─── CLI handlers ────────────────────────────────────────────────────────────

describe("CLI handlers", () => {
  it("handleCLIOpen: sets backendAdapter and broadcasts cli_connected", () => {
    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");
    // Clear session_init send calls
    browser.send.mockClear();

    const cli = makeCliSocket("s1");
    bridge.handleCLIOpen(cli, "s1");

    const session = bridge.getSession("s1")!;
    expect(session.backendAdapter).not.toBeNull();
    expect(session.backendAdapter?.isConnected()).toBe(true);
    expect(bridge.isCliConnected("s1")).toBe(true);

    // Should have broadcast cli_connected
    const calls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    expect(calls).toContainEqual(expect.objectContaining({ type: "cli_connected" }));
  });

  it("handleCLIOpen: flushes pending messages immediately", () => {
    // Per the SDK protocol, the first user message triggers system.init,
    // so queued messages must be flushed as soon as the CLI WebSocket connects
    // (not deferred until system.init, which would create a deadlock for
    // slow-starting sessions like Docker containers).
    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");

    bridge.handleBrowserMessage(browser, JSON.stringify({
      type: "user_message",
      content: "hello queued",
    }));

    // CLI not yet connected, message should be queued
    const session = bridge.getSession("s1")!;
    expect(session.pendingMessages.length).toBe(1);

    // Now connect CLI — messages should be flushed immediately
    const cli = makeCliSocket("s1");
    bridge.handleCLIOpen(cli, "s1");

    // Pending should have been flushed
    expect(session.pendingMessages).toEqual([]);
    // The CLI socket should have received the queued message
    expect(cli.send).toHaveBeenCalled();
    const sentCalls = cli.send.mock.calls.map(([arg]: [string]) => arg);
    const userMsg = sentCalls.find((s: string) => s.includes('"type":"user"'));
    expect(userMsg).toBeDefined();
    const parsed = JSON.parse(userMsg!.trim());
    expect(parsed.type).toBe("user");
    expect(parsed.message.content).toBe("hello queued");
  });

  it("handleCLIMessage: system.init does not re-flush already-sent messages", async () => {
    // Messages are flushed on CLI connect, so by the time system.init
    // arrives the queue should already be empty.
    mockExecSync.mockImplementation(() => { throw new Error("not a git repo"); });

    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");

    bridge.handleBrowserMessage(browser, JSON.stringify({
      type: "user_message",
      content: "hello queued",
    }));

    const session = bridge.getSession("s1")!;
    expect(session.pendingMessages.length).toBe(1);

    // Connect CLI — messages flushed immediately
    const cli = makeCliSocket("s1");
    bridge.handleCLIOpen(cli, "s1");
    expect(session.pendingMessages).toEqual([]);
    const sendCountAfterOpen = cli.send.mock.calls.length;

    // Send system.init — no additional flush should happen
    await bridge.handleCLIMessage(cli, makeInitMsg());

    // Verify no additional user messages were sent after system.init
    const newCalls = cli.send.mock.calls.slice(sendCountAfterOpen);
    const userMsgAfterInit = newCalls.find(([arg]: [string]) => arg.includes('"type":"user"'));
    expect(userMsgAfterInit).toBeUndefined();
  });

  it("handleCLIMessage: parses NDJSON and routes system.init", async () => {
    mockExecSync.mockImplementation(() => {
      throw new Error("not a git repo");
    });

    const cli = makeCliSocket("s1");
    const browser = makeBrowserSocket("s1");
    bridge.handleCLIOpen(cli, "s1");
    bridge.handleBrowserOpen(browser, "s1");
    browser.send.mockClear();

    await bridge.handleCLIMessage(cli, makeInitMsg());

    const session = bridge.getSession("s1")!;
    expect(session.state.model).toBe("claude-sonnet-4-6");
    expect(session.state.cwd).toBe("/test");

    // Should broadcast session_init to browser
    const calls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    const initCall = calls.find((c: any) => c.type === "session_init");
    expect(initCall).toBeDefined();
    expect(initCall.session.model).toBe("claude-sonnet-4-6");
  });

  it("handleCLIMessage: system.init fires onCLISessionIdReceived callback", async () => {
    mockExecSync.mockImplementation(() => {
      throw new Error("not a git repo");
    });

    const callback = vi.fn();
    companionBus.on("session:cli-id-received", ({ sessionId, cliSessionId }) => callback(sessionId, cliSessionId));

    const cli = makeCliSocket("s1");
    bridge.handleCLIOpen(cli, "s1");
    await bridge.handleCLIMessage(cli, makeInitMsg({ session_id: "cli-internal-id" }));

    expect(callback).toHaveBeenCalledWith("s1", "cli-internal-id");
  });

  it("handleCLIMessage: system.init preserves Companion session_id (does not overwrite with CLI internal ID)", async () => {
    // Regression test for duplicate sidebar entries bug.
    // The CLI sends its own internal session_id in the system.init message.
    // The bridge must NOT allow this to overwrite session.state.session_id
    // (which is the Companion's session ID used by the browser as a Map key).
    // If overwritten, the browser adds the session under the CLI's ID while
    // the sdkSessions poll uses the Companion's ID — creating two entries.
    mockExecSync.mockImplementation(() => {
      throw new Error("not a git repo");
    });

    const cli = makeCliSocket("s1");
    const browser = makeBrowserSocket("s1");
    bridge.handleCLIOpen(cli, "s1");
    bridge.handleBrowserOpen(browser, "s1");
    browser.send.mockClear();

    // CLI reports a different session_id than the Companion's "s1"
    await bridge.handleCLIMessage(cli, makeInitMsg({ session_id: "cli-internal-uuid-abc123" }));

    const session = bridge.getSession("s1")!;
    // session.state.session_id must remain the Companion's ID
    expect(session.state.session_id).toBe("s1");

    // The broadcast to the browser must also use the Companion's ID
    const calls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    const initCall = calls.find((c: any) => c.type === "session_init");
    expect(initCall).toBeDefined();
    expect(initCall.session.session_id).toBe("s1");
  });

  it("handleCLIMessage: session_update preserves Companion session_id (does not overwrite with CLI internal ID)", async () => {
    // Regression test: after session_init lands, a subsequent session_update
    // from the adapter must NOT overwrite session.state.session_id with the
    // CLI's internal ID.  This mirrors the session_init regression test above.
    mockExecSync.mockImplementation(() => {
      throw new Error("not a git repo");
    });

    const cli = makeCliSocket("s1");
    bridge.handleCLIOpen(cli, "s1");

    // First, send session_init to get the session into ready state
    await bridge.handleCLIMessage(cli, makeInitMsg({ session_id: "cli-internal-uuid-abc123" }));

    const session = bridge.getSession("s1")!;
    expect(session.state.session_id).toBe("s1"); // sanity check after init

    // Now simulate a session_update with a different session_id coming through
    // the adapter pipeline.  We invoke the adapter's browserMessageCb directly
    // because the Claude adapter does not natively emit session_update — this
    // path is exercised by the Codex adapter in production.
    const adapter = session.backendAdapter as any;
    adapter.browserMessageCb({
      type: "session_update",
      session: {
        session_id: "cli-internal-uuid-abc123",
        model: "claude-opus-4-6",
      },
    });

    // session.state.session_id must still be the Companion's ID
    expect(session.state.session_id).toBe("s1");
    // The model update should still have been applied
    expect(session.state.model).toBe("claude-opus-4-6");
  });

  it("handleCLIMessage: updates state from init (model, cwd, tools, permissionMode)", async () => {
    mockExecSync.mockImplementation(() => {
      throw new Error("not a git repo");
    });

    const cli = makeCliSocket("s1");
    bridge.handleCLIOpen(cli, "s1");

    await bridge.handleCLIMessage(cli, makeInitMsg({
      model: "claude-opus-4-5-20250929",
      cwd: "/workspace",
      tools: ["Bash", "Read", "Edit"],
      permissionMode: "bypassPermissions",
      claude_code_version: "2.0",
      mcp_servers: [{ name: "test-mcp", status: "connected" }],
      agents: ["agent1"],
      slash_commands: ["/commit"],
      skills: ["pdf"],
    }));

    const state = bridge.getSession("s1")!.state;
    expect(state.model).toBe("claude-opus-4-5-20250929");
    expect(state.cwd).toBe("/workspace");
    expect(state.tools).toEqual(["Bash", "Read", "Edit"]);
    expect(state.permissionMode).toBe("bypassPermissions");
    expect(state.claude_code_version).toBe("2.0");
    expect(state.mcp_servers).toEqual([{ name: "test-mcp", status: "connected" }]);
    expect(state.agents).toEqual(["agent1"]);
    expect(state.slash_commands).toEqual(["/commit"]);
    expect(state.skills).toEqual(["pdf"]);
  });

  it("handleCLIMessage: system.init preserves host cwd for containerized sessions", async () => {
    // markContainerized sets the host cwd and is_containerized before CLI connects
    bridge.markContainerized("s1", "/Users/stan/Dev/myproject");

    mockExecSync.mockImplementation(() => {
      throw new Error("container not tracked");
    });

    const cli = makeCliSocket("s1");
    bridge.handleCLIOpen(cli, "s1");

    // CLI inside the container reports /workspace — should be ignored
    await bridge.handleCLIMessage(cli, makeInitMsg({ cwd: "/workspace" }));

    const state = bridge.getSession("s1")!.state;
    expect(state.cwd).toBe("/Users/stan/Dev/myproject");
    expect(state.is_containerized).toBe(true);
  });

  it("handleCLIMessage: keeps previous git info when container metadata is temporarily unavailable", async () => {
    const session = bridge.getOrCreateSession("s1");
    session.state.git_branch = "existing-branch";
    session.state.repo_root = "/workspace";
    session.state.git_ahead = 2;
    session.state.git_behind = 1;
    bridge.markContainerized("s1", "/Users/stan/Dev/myproject");

    mockExecSync.mockImplementation(() => {
      throw new Error("container not tracked");
    });

    const cli = makeCliSocket("s1");
    bridge.handleCLIOpen(cli, "s1");
    await bridge.handleCLIMessage(cli, makeInitMsg({ cwd: "/workspace" }));

    const state = bridge.getSession("s1")!.state;
    expect(state.git_branch).toBe("existing-branch");
    expect(state.repo_root).toBe("/workspace");
    expect(state.git_ahead).toBe(2);
    expect(state.git_behind).toBe(1);
  });

  it("handleCLIMessage: resolves git info from container for containerized sessions", async () => {
    bridge.markContainerized("s1", "/Users/stan/Dev/myproject");
    const getContainerSpy = vi.spyOn(containerManager, "getContainer").mockReturnValue({
      containerId: "abc123def456",
      name: "companion-test",
      image: "the-companion:latest",
      portMappings: [],
      hostCwd: "/Users/stan/Dev/myproject",
      containerCwd: "/workspace",
      state: "running",
    });

    mockExecSync.mockImplementation((cmd: string) => {
      if (!cmd.startsWith("docker exec abc123def456 sh -lc ")) {
        throw new Error(`unexpected command: ${cmd}`);
      }
      if (cmd.includes("--abbrev-ref HEAD")) return "container-branch\n";
      if (cmd.includes("--git-dir")) return ".git\n";
      if (cmd.includes("--show-toplevel")) return "/workspace\n";
      if (cmd.includes("--left-right --count")) return "1\t3\n";
      throw new Error(`unknown git cmd: ${cmd}`);
    });

    const cli = makeCliSocket("s1");
    bridge.handleCLIOpen(cli, "s1");
    await bridge.handleCLIMessage(cli, makeInitMsg({ cwd: "/workspace" }));

    const state = bridge.getSession("s1")!.state;
    expect(state.cwd).toBe("/Users/stan/Dev/myproject");
    expect(state.git_branch).toBe("container-branch");
    expect(state.repo_root).toBe("/Users/stan/Dev/myproject");
    expect(state.git_behind).toBe(1);
    expect(state.git_ahead).toBe(3);
    expect(getContainerSpy).toHaveBeenCalledWith("s1");
    getContainerSpy.mockRestore();
  });

  it("handleCLIMessage: maps nested container repo_root paths back to host paths", async () => {
    bridge.markContainerized("s1", "/Users/stan/Dev/myproject");
    const getContainerSpy = vi.spyOn(containerManager, "getContainer").mockReturnValue({
      containerId: "abc123def456",
      name: "companion-test",
      image: "the-companion:latest",
      portMappings: [],
      hostCwd: "/Users/stan/Dev/myproject",
      containerCwd: "/workspace",
      state: "running",
    });

    mockExecSync.mockImplementation((cmd: string) => {
      if (!cmd.startsWith("docker exec abc123def456 sh -lc ")) {
        throw new Error(`unexpected command: ${cmd}`);
      }
      if (cmd.includes("--abbrev-ref HEAD")) return "container-branch\n";
      if (cmd.includes("--git-dir")) return ".git\n";
      if (cmd.includes("--show-toplevel")) return "/workspace/packages/api\n";
      if (cmd.includes("--left-right --count")) return "0\t0\n";
      throw new Error(`unknown git cmd: ${cmd}`);
    });

    const cli = makeCliSocket("s1");
    bridge.handleCLIOpen(cli, "s1");
    await bridge.handleCLIMessage(cli, makeInitMsg({ cwd: "/workspace" }));

    const state = bridge.getSession("s1")!.state;
    expect(state.repo_root).toBe("/Users/stan/Dev/myproject/packages/api");
    expect(getContainerSpy).toHaveBeenCalledWith("s1");
    getContainerSpy.mockRestore();
  });

  it("handleCLIMessage: system.init resolves git info via execSync", async () => {
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("--abbrev-ref HEAD")) return "feat/test-branch\n";
      if (cmd.includes("--show-toplevel")) return "/repo\n";
      if (cmd.includes("--left-right --count")) return "2\t5\n";
      throw new Error("unknown git cmd");
    });

    const cli = makeCliSocket("s1");
    bridge.handleCLIOpen(cli, "s1");
    await bridge.handleCLIMessage(cli, makeInitMsg());

    const state = bridge.getSession("s1")!.state;
    expect(state.git_branch).toBe("feat/test-branch");
    expect(state.repo_root).toBe("/repo");
    expect(state.git_ahead).toBe(5);
    expect(state.git_behind).toBe(2);
  });

  it("handleCLIMessage: system.init resolves repo_root via --show-toplevel for standard repo", async () => {
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("--abbrev-ref HEAD")) return "main\n";
      if (cmd.includes("--git-dir")) return ".git\n";
      if (cmd.includes("--show-toplevel")) return "/home/user/myproject\n";
      if (cmd.includes("--left-right --count")) return "0\t0\n";
      throw new Error("unknown git cmd");
    });

    const cli = makeCliSocket("s1");
    bridge.handleCLIOpen(cli, "s1");
    await bridge.handleCLIMessage(cli, makeInitMsg({ cwd: "/home/user/myproject" }));

    const state = bridge.getSession("s1")!.state;
    expect(state.repo_root).toBe("/home/user/myproject");
  });

  it("handleCLIMessage: system.status updates compacting and permissionMode", async () => {
    const cli = makeCliSocket("s1");
    const browser = makeBrowserSocket("s1");
    bridge.handleCLIOpen(cli, "s1");
    bridge.handleBrowserOpen(browser, "s1");
    browser.send.mockClear();

    const statusMsg = JSON.stringify({
      type: "system",
      subtype: "status",
      status: "compacting",
      permissionMode: "plan",
      uuid: "uuid-2",
      session_id: "s1",
    });

    await bridge.handleCLIMessage(cli, statusMsg);

    const state = bridge.getSession("s1")!.state;
    expect(state.is_compacting).toBe(true);
    expect(state.permissionMode).toBe("plan");

    const calls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    expect(calls).toContainEqual(expect.objectContaining({ type: "status_change", status: "compacting" }));
    // When the CLI changes permissionMode via system.status, the server should
    // broadcast a session_update so browsers sync their UI (e.g. plan toggle).
    expect(calls).toContainEqual(expect.objectContaining({
      type: "session_update",
      session: expect.objectContaining({ permissionMode: "plan" }),
    }));
  });

  it("handleCLIMessage: system.status does NOT broadcast session_update when permissionMode unchanged", async () => {
    // Pre-set the session to "default" mode, then send a status with the same mode.
    const cli = makeCliSocket("s1");
    const browser = makeBrowserSocket("s1");
    bridge.handleCLIOpen(cli, "s1");
    bridge.handleBrowserOpen(browser, "s1");
    browser.send.mockClear();

    const statusMsg = JSON.stringify({
      type: "system",
      subtype: "status",
      status: "idle",
      permissionMode: "default",
      uuid: "uuid-3",
      session_id: "s1",
    });

    await bridge.handleCLIMessage(cli, statusMsg);

    const calls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    // Should NOT have a session_update for permissionMode since it didn't change.
    const permUpdates = calls.filter(
      (c: Record<string, unknown>) => c.type === "session_update" && (c.session as Record<string, unknown>)?.permissionMode,
    );
    expect(permUpdates).toHaveLength(0);
  });

  it("handleCLIMessage: system.status broadcasts session_update on plan→default (ExitPlanMode scenario)", async () => {
    // Regression test for the exact bug: after ExitPlanMode approval, the CLI
    // sends system.status with permissionMode:"default" but the browser was
    // never notified, leaving the plan toggle stuck.
    const cli = makeCliSocket("s1");
    const browser = makeBrowserSocket("s1");
    bridge.handleCLIOpen(cli, "s1");
    bridge.handleBrowserOpen(browser, "s1");

    // First put the session into plan mode
    await bridge.handleCLIMessage(cli, JSON.stringify({
      type: "system", subtype: "status", status: "idle",
      permissionMode: "plan", uuid: "uuid-plan", session_id: "s1",
    }));
    expect(bridge.getSession("s1")!.state.permissionMode).toBe("plan");
    browser.send.mockClear();

    // CLI exits plan mode (ExitPlanMode scenario)
    await bridge.handleCLIMessage(cli, JSON.stringify({
      type: "system", subtype: "status", status: "idle",
      permissionMode: "default", uuid: "uuid-exit-plan", session_id: "s1",
    }));

    const calls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    expect(calls).toContainEqual(expect.objectContaining({
      type: "session_update",
      session: expect.objectContaining({ permissionMode: "default" }),
    }));
    expect(bridge.getSession("s1")!.state.permissionMode).toBe("default");
  });

  it("handleCLIMessage: forwards compact_boundary as system_event and persists it", async () => {
    const cli = makeCliSocket("s1");
    const browser = makeBrowserSocket("s1");
    bridge.handleCLIOpen(cli, "s1");
    bridge.handleBrowserOpen(browser, "s1");
    browser.send.mockClear();

    await bridge.handleCLIMessage(cli, JSON.stringify({
      type: "system",
      subtype: "compact_boundary",
      compact_metadata: { trigger: "auto", pre_tokens: 4096 },
      uuid: "uuid-compact",
      session_id: "s1",
    }));

    const session = bridge.getSession("s1")!;
    expect(session.messageHistory).toHaveLength(1);
    expect(session.messageHistory[0]).toMatchObject({
      type: "system_event",
      event: {
        subtype: "compact_boundary",
      },
    });

    const calls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    const forwarded = calls.find((c: any) => c.type === "system_event");
    expect(forwarded).toBeDefined();
    expect(forwarded.event.subtype).toBe("compact_boundary");
  });

  it("handleCLIMessage: forwards hook_progress as system_event without persisting history", async () => {
    const cli = makeCliSocket("s1");
    const browser = makeBrowserSocket("s1");
    bridge.handleCLIOpen(cli, "s1");
    bridge.handleBrowserOpen(browser, "s1");
    browser.send.mockClear();

    await bridge.handleCLIMessage(cli, JSON.stringify({
      type: "system",
      subtype: "hook_progress",
      hook_id: "hk-1",
      hook_name: "lint",
      hook_event: "post_tool_use",
      stdout: "running",
      stderr: "",
      output: "running",
      uuid: "uuid-hook-progress",
      session_id: "s1",
    }));

    const session = bridge.getSession("s1")!;
    expect(session.messageHistory).toHaveLength(0);

    const calls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    const forwarded = calls.find((c: any) => c.type === "system_event");
    expect(forwarded).toBeDefined();
    expect(forwarded.event.subtype).toBe("hook_progress");
  });

  it("handleCLIClose: disconnects backendAdapter and broadcasts cli_disconnected", () => {
    vi.useFakeTimers();
    const cli = makeCliSocket("s1");
    const browser = makeBrowserSocket("s1");
    bridge.handleCLIOpen(cli, "s1");
    bridge.handleBrowserOpen(browser, "s1");
    browser.send.mockClear();

    bridge.handleCLIClose(cli);

    const session = bridge.getSession("s1")!;
    expect(session.backendAdapter?.isConnected()).toBe(false);
    expect(bridge.isCliConnected("s1")).toBe(false);

    // Advance past disconnect debounce (15s)
    vi.advanceTimersByTime(16_000);

    const calls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    expect(calls).toContainEqual(expect.objectContaining({ type: "cli_disconnected" }));
    vi.useRealTimers();
  });

  it("handleCLIClose: cancels pending permissions", async () => {
    vi.useFakeTimers();
    const cli = makeCliSocket("s1");
    const browser = makeBrowserSocket("s1");
    bridge.handleCLIOpen(cli, "s1");
    bridge.handleBrowserOpen(browser, "s1");

    // Simulate a pending permission request
    const controlReq = JSON.stringify({
      type: "control_request",
      request_id: "req-1",
      request: {
        subtype: "can_use_tool",
        tool_name: "Bash",
        input: { command: "rm -rf /" },
        tool_use_id: "tu-1",
      },
    });
    await bridge.handleCLIMessage(cli, controlReq);
    browser.send.mockClear();

    bridge.handleCLIClose(cli);

    // Advance past disconnect debounce (15s)
    vi.advanceTimersByTime(16_000);

    const session = bridge.getSession("s1")!;
    expect(session.pendingPermissions.size).toBe(0);

    const calls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    const cancelMsg = calls.find((c: any) => c.type === "permission_cancelled");
    expect(cancelMsg).toBeDefined();
    expect(cancelMsg.request_id).toBe("req-1");
    vi.useRealTimers();
  });

  it("handleCLIClose: ignores stale socket close (new WS opened before old closed)", () => {
    const cli1 = makeCliSocket("s1");
    const cli2 = makeCliSocket("s1");
    const browser = makeBrowserSocket("s1");

    bridge.handleCLIOpen(cli1, "s1");
    bridge.handleBrowserOpen(browser, "s1");

    // CLI reconnects — new socket opens before old one closes
    bridge.handleCLIOpen(cli2, "s1");
    browser.send.mockClear();

    // Stale close event fires from cli1
    bridge.handleCLIClose(cli1);

    // backendAdapter should still be connected via cli2, not disconnected
    const session = bridge.getSession("s1")!;
    expect(session.backendAdapter).not.toBeNull();
    expect(session.backendAdapter?.isConnected()).toBe(true);
    expect(bridge.isCliConnected("s1")).toBe(true);

    // No cli_disconnected should be broadcast
    const calls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    expect(calls.find((c: any) => c.type === "cli_disconnected")).toBeUndefined();
  });

  it("handleCLIClose: debounces disconnect notification", () => {
    vi.useFakeTimers();
    const cli = makeCliSocket("s1");
    const browser = makeBrowserSocket("s1");

    bridge.handleCLIOpen(cli, "s1");
    bridge.handleBrowserOpen(browser, "s1");
    browser.send.mockClear();

    bridge.handleCLIClose(cli);

    // Immediately after close: no cli_disconnected broadcast yet
    const immediateCalls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    expect(immediateCalls.find((c: any) => c.type === "cli_disconnected")).toBeUndefined();

    // After debounce period: cli_disconnected should be broadcast
    vi.advanceTimersByTime(16_000);

    const calls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    expect(calls).toContainEqual(expect.objectContaining({ type: "cli_disconnected" }));

    vi.useRealTimers();
  });

  it("handleCLIClose: debounce cancelled by reconnect", () => {
    vi.useFakeTimers();
    const cli1 = makeCliSocket("s1");
    const cli2 = makeCliSocket("s1");
    const browser = makeBrowserSocket("s1");

    bridge.handleCLIOpen(cli1, "s1");
    bridge.handleBrowserOpen(browser, "s1");
    browser.send.mockClear();

    // CLI disconnects
    bridge.handleCLIClose(cli1);

    // CLI reconnects within debounce window
    vi.advanceTimersByTime(5_000);
    bridge.handleCLIOpen(cli2, "s1");
    browser.send.mockClear();

    // Debounce timer fires — should NOT broadcast disconnect
    vi.advanceTimersByTime(16_000);

    const calls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    expect(calls.find((c: any) => c.type === "cli_disconnected")).toBeUndefined();
    expect(bridge.isCliConnected("s1")).toBe(true);

    vi.useRealTimers();
  });

  it("Codex adapter disconnect: uses debounce and broadcasts cli_disconnected only after 5s", () => {
    vi.useFakeTimers();
    const session = bridge.getOrCreateSession("s1", "codex");
    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");

    // Create a mock Codex adapter and capture the onDisconnect callback
    let disconnectCb: (() => void) | undefined;
    const adapter = {
      isConnected: () => false,
      send: () => true,
      disconnect: async () => {},
      onBrowserMessage: () => {},
      onSessionMeta: () => {},
      onDisconnect: (cb: () => void) => { disconnectCb = cb; },
      onInitError: () => {},
    };

    bridge.attachBackendAdapter("s1", adapter as any, "codex");
    browser.send.mockClear();

    // Trigger disconnect
    disconnectCb!();

    // Immediately after disconnect: should transition to "reconnecting" but NOT broadcast cli_disconnected yet
    expect(session.stateMachine.phase).toBe("reconnecting");
    const immediateCalls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    expect(immediateCalls.find((c: any) => c.type === "cli_disconnected")).toBeUndefined();
    // session_phase: reconnecting should be broadcast (sets cliReconnecting=true on frontend)
    expect(immediateCalls).toContainEqual(expect.objectContaining({ type: "session_phase", phase: "reconnecting" }));

    // After 5s debounce: cli_disconnected should be broadcast
    vi.advanceTimersByTime(5_000);
    const laterCalls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    expect(laterCalls).toContainEqual(expect.objectContaining({ type: "cli_disconnected" }));

    vi.useRealTimers();
  });

  it("Codex adapter disconnect: debounce is cancelled when new adapter attaches", () => {
    vi.useFakeTimers();
    bridge.getOrCreateSession("s1", "codex");
    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");

    let disconnectCb: (() => void) | undefined;
    const adapter1 = {
      isConnected: () => false,
      send: () => true,
      disconnect: async () => {},
      onBrowserMessage: () => {},
      onSessionMeta: () => {},
      onDisconnect: (cb: () => void) => { disconnectCb = cb; },
      onInitError: () => {},
    };

    bridge.attachBackendAdapter("s1", adapter1 as any, "codex");
    browser.send.mockClear();

    // Trigger disconnect
    disconnectCb!();

    // Advance 2s (before debounce fires)
    vi.advanceTimersByTime(2_000);

    // Attach a new adapter (simulating relaunch)
    const adapter2 = {
      isConnected: () => true,
      send: () => true,
      disconnect: async () => {},
      onBrowserMessage: () => {},
      onSessionMeta: () => {},
      onDisconnect: () => {},
      onInitError: () => {},
    };
    bridge.attachBackendAdapter("s1", adapter2 as any, "codex");
    browser.send.mockClear();

    // Advance past the original debounce time
    vi.advanceTimersByTime(5_000);

    // cli_disconnected should NOT have been broadcast (debounce was cancelled)
    const calls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    expect(calls.find((c: any) => c.type === "cli_disconnected")).toBeUndefined();

    vi.useRealTimers();
  });

  it("Codex adapter disconnect: emits session:relaunch-needed regardless of browser count", () => {
    vi.useFakeTimers();
    // Create session with NO browsers connected
    bridge.getOrCreateSession("s1", "codex");

    let disconnectCb: (() => void) | undefined;
    const adapter = {
      isConnected: () => false,
      send: () => true,
      disconnect: async () => {},
      onBrowserMessage: () => {},
      onSessionMeta: () => {},
      onDisconnect: (cb: () => void) => { disconnectCb = cb; },
      onInitError: () => {},
    };

    const relaunchCb = vi.fn();
    companionBus.on("session:relaunch-needed", ({ sessionId }) => relaunchCb(sessionId));

    bridge.attachBackendAdapter("s1", adapter as any, "codex");

    // Trigger disconnect (no browsers connected)
    disconnectCb!();

    // Advance past debounce
    vi.advanceTimersByTime(5_000);

    // Should still emit relaunch-needed even without browsers
    expect(relaunchCb).toHaveBeenCalledWith("s1");

    vi.useRealTimers();
  });
});

// ─── Browser handlers ────────────────────────────────────────────────────────

describe("Browser handlers", () => {
  it("handleBrowserOpen: adds to set and sends session_init", () => {
    bridge.getOrCreateSession("s1");
    const browser = makeBrowserSocket("s1");

    bridge.handleBrowserOpen(browser, "s1");

    const session = bridge.getSession("s1")!;
    expect(session.browserSockets.has(browser)).toBe(true);

    expect(browser.send).toHaveBeenCalled();
    const firstMsg = JSON.parse(browser.send.mock.calls[0][0]);
    expect(firstMsg.type).toBe("session_init");
    expect(firstMsg.session.session_id).toBe("s1");
  });

  it("handleBrowserOpen: refreshes git branch before sending session snapshot", () => {
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("--abbrev-ref HEAD")) return "feat/dynamic-branch\n";
      if (cmd.includes("--git-dir")) return ".git\n";
      if (cmd.includes("--show-toplevel")) return "/repo\n";
      if (cmd.includes("--left-right --count")) return "0\t0\n";
      throw new Error("unknown git cmd");
    });

    const session = bridge.getOrCreateSession("s1");
    session.state.cwd = "/repo";
    session.state.git_branch = "main";

    const gitInfoCb = vi.fn();
    companionBus.on("session:git-info-ready", ({ sessionId, cwd, branch }) => gitInfoCb(sessionId, cwd, branch));

    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");

    const firstMsg = JSON.parse(browser.send.mock.calls[0][0]);
    expect(firstMsg.type).toBe("session_init");
    expect(firstMsg.session.git_branch).toBe("feat/dynamic-branch");
    expect(gitInfoCb).toHaveBeenCalledWith("s1", "/repo", "feat/dynamic-branch");
  });

  it("handleBrowserOpen: replays message history", async () => {
    // First populate some history
    mockExecSync.mockImplementation(() => {
      throw new Error("not a git repo");
    });

    const cli = makeCliSocket("s1");
    bridge.handleCLIOpen(cli, "s1");

    const assistantMsg = JSON.stringify({
      type: "assistant",
      message: {
        id: "msg-1",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-4-6",
        content: [{ type: "text", text: "Hello!" }],
        stop_reason: null,
        usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
      parent_tool_use_id: null,
      uuid: "uuid-2",
      session_id: "s1",
    });
    await bridge.handleCLIMessage(cli, assistantMsg);

    // Now connect a new browser
    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");

    const calls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    const historyMsg = calls.find((c: any) => c.type === "message_history");
    expect(historyMsg).toBeDefined();
    expect(historyMsg.messages).toHaveLength(1);
    expect(historyMsg.messages[0].type).toBe("assistant");
  });

  it("handleBrowserOpen: sends pending permissions", async () => {
    const cli = makeCliSocket("s1");
    bridge.handleCLIOpen(cli, "s1");

    // Create a pending permission
    const controlReq = JSON.stringify({
      type: "control_request",
      request_id: "req-1",
      request: {
        subtype: "can_use_tool",
        tool_name: "Edit",
        input: { file_path: "/test.ts" },
        tool_use_id: "tu-1",
      },
    });
    await bridge.handleCLIMessage(cli, controlReq);

    // Now connect a browser
    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");

    const calls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    const permMsg = calls.find((c: any) => c.type === "permission_request");
    expect(permMsg).toBeDefined();
    expect(permMsg.request.tool_name).toBe("Edit");
    expect(permMsg.request.request_id).toBe("req-1");
  });

  it("handleBrowserOpen: triggers relaunch callback when CLI is dead", () => {
    const relaunchCb = vi.fn();
    companionBus.on("session:relaunch-needed", ({ sessionId }) => relaunchCb(sessionId));

    bridge.getOrCreateSession("s1");
    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");

    expect(relaunchCb).toHaveBeenCalledWith("s1");

    // Also sends cli_disconnected
    const calls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    const disconnectedMsg = calls.find((c: any) => c.type === "cli_disconnected");
    expect(disconnectedMsg).toBeDefined();
  });

  it("handleBrowserOpen: does NOT relaunch when Codex adapter is attached but still initializing", () => {
    const relaunchCb = vi.fn();
    companionBus.on("session:relaunch-needed", ({ sessionId }) => relaunchCb(sessionId));

    const session = bridge.getOrCreateSession("s1", "codex");
    session.backendAdapter = { isConnected: () => false, send: () => false, disconnect: async () => {}, onBrowserMessage: () => {}, onSessionMeta: () => {}, onDisconnect: () => {} } as any;

    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");

    expect(relaunchCb).not.toHaveBeenCalled();

    const calls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    const disconnectedMsg = calls.find((c: any) => c.type === "cli_disconnected");
    expect(disconnectedMsg).toBeUndefined();
  });

  it("handleBrowserClose: removes from set", () => {
    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");
    expect(bridge.getSession("s1")!.browserSockets.has(browser)).toBe(true);

    bridge.handleBrowserClose(browser);
    expect(bridge.getSession("s1")!.browserSockets.has(browser)).toBe(false);
  });

  it("session_subscribe: replays buffered sequenced events after last_seq", async () => {
    const cli = makeCliSocket("s1");
    bridge.handleCLIOpen(cli, "s1");

    // Generate replayable events while no browser is connected.
    await bridge.handleCLIMessage(cli, JSON.stringify({
      type: "stream_event",
      event: { type: "content_block_delta", delta: { type: "text_delta", text: "a" } },
      parent_tool_use_id: null,
      uuid: "u1",
      session_id: "s1",
    }));
    await bridge.handleCLIMessage(cli, JSON.stringify({
      type: "stream_event",
      event: { type: "content_block_delta", delta: { type: "text_delta", text: "b" } },
      parent_tool_use_id: null,
      uuid: "u2",
      session_id: "s1",
    }));

    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");
    browser.send.mockClear();

    // Ask for replay after seq=2 (session_phase + cli_connected). Both stream events should replay.
    bridge.handleBrowserMessage(browser, JSON.stringify({
      type: "session_subscribe",
      last_seq: 2,
    }));

    const calls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    const replay = calls.find((c: any) => c.type === "event_replay");
    expect(replay).toBeDefined();
    expect(replay.events).toHaveLength(2);
    expect(replay.events[0].seq).toBe(3);
    expect(replay.events[0].message.type).toBe("stream_event");
    expect(replay.events[1].message.type).toBe("stream_event");
  });

  it("session_subscribe: sends full message_history on first subscribe even without a replay gap", async () => {
    // A brand-new browser tab starts with last_seq=0 and needs the persisted
    // message history, including user messages that are never sequenced in the
    // event buffer. Without this bootstrap payload, Codex sessions can reopen
    // without their first user prompt in chat.
    const session = bridge.getOrCreateSession("s1", "codex");
    session.messageHistory.push({
      type: "user_message",
      id: "user-1",
      content: "first prompt",
      timestamp: 1000,
    });
    session.messageHistory.push({
      type: "assistant",
      message: {
        id: "assistant-1",
        type: "message",
        role: "assistant",
        model: "gpt-5.4",
        content: [{ type: "text", text: "reply" }],
        stop_reason: "end_turn",
        usage: {
          input_tokens: 1,
          output_tokens: 1,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
      parent_tool_use_id: null,
      timestamp: 2000,
    });
    session.eventBuffer.push({
      seq: 1,
      message: {
        type: "assistant",
        message: {
          id: "assistant-1",
          type: "message",
          role: "assistant",
          model: "gpt-5.4",
          content: [{ type: "text", text: "reply" }],
          stop_reason: "end_turn",
          usage: {
            input_tokens: 1,
            output_tokens: 1,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
        },
        parent_tool_use_id: null,
        timestamp: 2000,
      },
    });
    session.eventBuffer.push({
      seq: 2,
      message: {
        type: "stream_event",
        event: {
          type: "content_block_delta",
          delta: { type: "text_delta", text: "stream-only" },
        },
        parent_tool_use_id: null,
      },
    });
    session.nextEventSeq = 3;

    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");
    browser.send.mockClear();

    bridge.handleBrowserMessage(browser, JSON.stringify({
      type: "session_subscribe",
      last_seq: 0,
    }));

    const calls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    const historyMsg = calls.find((c: any) => c.type === "message_history");
    expect(historyMsg).toBeDefined();
    expect(historyMsg.messages).toHaveLength(2);
    expect(historyMsg.messages.some((m: any) => m.type === "user_message")).toBe(true);
    expect(historyMsg.messages.some((m: any) => m.type === "assistant")).toBe(true);

    const replayMsg = calls.find((c: any) => c.type === "event_replay");
    expect(replayMsg).toBeDefined();
    expect(replayMsg.events).toHaveLength(1);
    expect(replayMsg.events[0].message.type).toBe("stream_event");
  });

  it("session_subscribe: falls back to message_history when last_seq is older than buffer window", async () => {
    const cli = makeCliSocket("s1");
    bridge.handleCLIOpen(cli, "s1");

    // Populate history so fallback payload has content.
    await bridge.handleCLIMessage(cli, JSON.stringify({
      type: "assistant",
      message: {
        id: "hist-1",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-4-6",
        content: [{ type: "text", text: "from history" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
      parent_tool_use_id: null,
      uuid: "hist-u1",
      session_id: "s1",
    }));

    // Generate several stream events, then trim the first one from in-memory buffer.
    await bridge.handleCLIMessage(cli, JSON.stringify({
      type: "stream_event",
      event: { type: "content_block_delta", delta: { type: "text_delta", text: "1" } },
      parent_tool_use_id: null,
      uuid: "se-u1",
      session_id: "s1",
    }));
    await bridge.handleCLIMessage(cli, JSON.stringify({
      type: "stream_event",
      event: { type: "content_block_delta", delta: { type: "text_delta", text: "2" } },
      parent_tool_use_id: null,
      uuid: "se-u2",
      session_id: "s1",
    }));
    const session = bridge.getSession("s1")!;
    session.eventBuffer.shift();
    session.eventBuffer.shift(); // force earliest seq high enough to create a gap for last_seq=1

    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");
    browser.send.mockClear();

    bridge.handleBrowserMessage(browser, JSON.stringify({
      type: "session_subscribe",
      last_seq: 1,
    }));

    const calls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    const historyMsg = calls.find((c: any) => c.type === "message_history");
    expect(historyMsg).toBeDefined();
    expect(historyMsg.messages.some((m: any) => m.type === "assistant")).toBe(true);
    const replayMsg = calls.find((c: any) => c.type === "event_replay");
    expect(replayMsg).toBeDefined();
    expect(replayMsg.events.some((e: any) => e.message.type === "stream_event")).toBe(true);
  });

  it("session_subscribe: sends ground-truth status_change=idle after event_replay when last history is result", async () => {
    // When the CLI finished (result in messageHistory), the server should send
    // a status_change after event_replay so the browser clears stale "running" state.
    const cli = makeCliSocket("s1");
    bridge.handleCLIOpen(cli, "s1");

    // Simulate a completed turn: assistant → result in history
    await bridge.handleCLIMessage(cli, JSON.stringify({
      type: "assistant",
      message: {
        id: "a1",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-4-6",
        content: [{ type: "text", text: "hello" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
      parent_tool_use_id: null,
      uuid: "u1",
      session_id: "s1",
    }));
    await bridge.handleCLIMessage(cli, JSON.stringify({
      type: "result",
      is_error: false,
      total_cost_usd: 0.01,
      num_turns: 1,
      session_id: "s1",
    }));

    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");
    browser.send.mockClear();

    bridge.handleBrowserMessage(browser, JSON.stringify({
      type: "session_subscribe",
      last_seq: 0,
    }));

    const calls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    // Last message should be a status_change with idle
    const statusMsg = calls.filter((c: any) => c.type === "status_change");
    expect(statusMsg.length).toBeGreaterThanOrEqual(1);
    const lastStatus = statusMsg[statusMsg.length - 1];
    expect(lastStatus.status).toBe("idle");
  });

  it("session_subscribe: sends ground-truth status_change=running after event_replay when last history is assistant", async () => {
    // When the CLI is mid-turn (assistant in messageHistory but no result yet),
    // the ground-truth status should be "running".
    const cli = makeCliSocket("s1");
    bridge.handleCLIOpen(cli, "s1");

    await bridge.handleCLIMessage(cli, JSON.stringify({
      type: "assistant",
      message: {
        id: "a1",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-4-6",
        content: [{ type: "text", text: "working on it" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
      parent_tool_use_id: null,
      uuid: "u1",
      session_id: "s1",
    }));

    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");
    browser.send.mockClear();

    bridge.handleBrowserMessage(browser, JSON.stringify({
      type: "session_subscribe",
      last_seq: 0,
    }));

    const calls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    const statusMsg = calls.filter((c: any) => c.type === "status_change");
    expect(statusMsg.length).toBeGreaterThanOrEqual(1);
    const lastStatus = statusMsg[statusMsg.length - 1];
    expect(lastStatus.status).toBe("running");
  });

  it("session_subscribe: sends status_change=idle in gap path when session completed", async () => {
    // Even when falling back to message_history + transient replay,
    // a trailing status_change should correct stale state.
    const cli = makeCliSocket("s1");
    bridge.handleCLIOpen(cli, "s1");

    await bridge.handleCLIMessage(cli, JSON.stringify({
      type: "assistant",
      message: {
        id: "a1",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-4-6",
        content: [{ type: "text", text: "done" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
      parent_tool_use_id: null,
      uuid: "u1",
      session_id: "s1",
    }));
    await bridge.handleCLIMessage(cli, JSON.stringify({
      type: "result",
      is_error: false,
      total_cost_usd: 0.01,
      num_turns: 1,
      session_id: "s1",
    }));
    // Add a stream event and then force a gap by trimming the buffer
    await bridge.handleCLIMessage(cli, JSON.stringify({
      type: "stream_event",
      event: { type: "content_block_delta", delta: { type: "text_delta", text: "x" } },
      parent_tool_use_id: null,
      uuid: "se1",
      session_id: "s1",
    }));
    const session = bridge.getSession("s1")!;
    session.eventBuffer.shift(); // force a gap

    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");
    browser.send.mockClear();

    bridge.handleBrowserMessage(browser, JSON.stringify({
      type: "session_subscribe",
      last_seq: 1,
    }));

    const calls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    const statusMsg = calls.filter((c: any) => c.type === "status_change");
    expect(statusMsg.length).toBeGreaterThanOrEqual(1);
    expect(statusMsg[statusMsg.length - 1].status).toBe("idle");
  });

  it("session_ack: updates lastAckSeq for the session", () => {
    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");

    bridge.handleBrowserMessage(browser, JSON.stringify({
      type: "session_ack",
      last_seq: 42,
    }));

    const session = bridge.getSession("s1")!;
    expect(session.lastAckSeq).toBe(42);
  });
});

// ─── CLI message routing ─────────────────────────────────────────────────────

describe("CLI message routing", () => {
  let cli: ReturnType<typeof makeCliSocket>;
  let browser: ReturnType<typeof makeBrowserSocket>;

  beforeEach(() => {
    cli = makeCliSocket("s1");
    browser = makeBrowserSocket("s1");
    bridge.handleCLIOpen(cli, "s1");
    bridge.handleBrowserOpen(browser, "s1");
    browser.send.mockClear();
  });

  it("assistant: stores in history and broadcasts", async () => {
    const msg = JSON.stringify({
      type: "assistant",
      message: {
        id: "msg-1",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-4-6",
        content: [{ type: "text", text: "Hello world!" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
      parent_tool_use_id: null,
      uuid: "uuid-3",
      session_id: "s1",
    });

    await bridge.handleCLIMessage(cli, msg);

    const session = bridge.getSession("s1")!;
    expect(session.messageHistory).toHaveLength(1);
    expect(session.messageHistory[0].type).toBe("assistant");

    const calls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    const assistantBroadcast = calls.find((c: any) => c.type === "assistant");
    expect(assistantBroadcast).toBeDefined();
    expect(assistantBroadcast.message.content[0].text).toBe("Hello world!");
    expect(assistantBroadcast.parent_tool_use_id).toBeNull();
  });

  it("result: updates cost/turns/context% and stores + broadcasts", async () => {
    const msg = JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "Done!",
      duration_ms: 5000,
      duration_api_ms: 4000,
      num_turns: 3,
      total_cost_usd: 0.05,
      stop_reason: "end_turn",
      usage: { input_tokens: 500, output_tokens: 200, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      total_lines_added: 42,
      total_lines_removed: 10,
      uuid: "uuid-4",
      session_id: "s1",
    });

    await bridge.handleCLIMessage(cli, msg);

    const state = bridge.getSession("s1")!.state;
    expect(state.total_cost_usd).toBe(0.05);
    expect(state.num_turns).toBe(3);
    expect(state.total_lines_added).toBe(42);
    expect(state.total_lines_removed).toBe(10);

    const session = bridge.getSession("s1")!;
    expect(session.messageHistory).toHaveLength(1);
    expect(session.messageHistory[0].type).toBe("result");

    const calls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    const resultBroadcast = calls.find((c: any) => c.type === "result");
    expect(resultBroadcast).toBeDefined();
    expect(resultBroadcast.data.total_cost_usd).toBe(0.05);
  });

  it("result: refreshes git branch and broadcasts session_update when branch changes", async () => {
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("--abbrev-ref HEAD")) return "feat/new-branch\n";
      if (cmd.includes("--git-dir")) return ".git\n";
      if (cmd.includes("--show-toplevel")) return "/test\n";
      if (cmd.includes("--left-right --count")) return "0\t1\n";
      throw new Error("unknown git cmd");
    });

    const session = bridge.getSession("s1")!;
    session.state.cwd = "/test";
    session.state.git_branch = "main";

    const msg = JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "Done!",
      duration_ms: 5000,
      duration_api_ms: 4000,
      num_turns: 1,
      total_cost_usd: 0.01,
      stop_reason: "end_turn",
      usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      uuid: "uuid-refresh-git",
      session_id: "s1",
    });

    await bridge.handleCLIMessage(cli, msg);

    const calls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    const updateMsg = calls.find((c: any) => c.type === "session_update");
    expect(updateMsg).toBeDefined();
    expect(updateMsg.session.git_branch).toBe("feat/new-branch");
    expect(updateMsg.session.git_ahead).toBe(1);
    expect(bridge.getSession("s1")!.state.git_branch).toBe("feat/new-branch");
  });

  it("result: computes context_used_percent from modelUsage", async () => {
    const msg = JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      duration_ms: 5000,
      duration_api_ms: 4000,
      num_turns: 1,
      total_cost_usd: 0.02,
      stop_reason: "end_turn",
      usage: { input_tokens: 500, output_tokens: 200, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      modelUsage: {
        "claude-sonnet-4-6": {
          inputTokens: 8000,
          outputTokens: 2000,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          contextWindow: 200000,
          maxOutputTokens: 16384,
          costUSD: 0.02,
        },
      },
      uuid: "uuid-5",
      session_id: "s1",
    });

    await bridge.handleCLIMessage(cli, msg);

    const state = bridge.getSession("s1")!.state;
    // (8000 + 2000) / 200000 * 100 = 5
    expect(state.context_used_percent).toBe(5);
  });

  it("stream_event: broadcasts without storing", async () => {
    const msg = JSON.stringify({
      type: "stream_event",
      event: { type: "content_block_delta", delta: { type: "text_delta", text: "hi" } },
      parent_tool_use_id: null,
      uuid: "uuid-6",
      session_id: "s1",
    });

    await bridge.handleCLIMessage(cli, msg);

    const session = bridge.getSession("s1")!;
    expect(session.messageHistory).toHaveLength(0);

    const calls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    const streamEvent = calls.find((c: any) => c.type === "stream_event");
    expect(streamEvent).toBeDefined();
    expect(streamEvent.event.delta.text).toBe("hi");
    expect(streamEvent.parent_tool_use_id).toBeNull();
  });

  it("control_request (can_use_tool): adds to pending and broadcasts", async () => {
    const msg = JSON.stringify({
      type: "control_request",
      request_id: "req-42",
      request: {
        subtype: "can_use_tool",
        tool_name: "Bash",
        input: { command: "ls -la" },
        description: "List files",
        tool_use_id: "tu-42",
        agent_id: "agent-1",
        permission_suggestions: [{ type: "addRules", rules: [{ toolName: "Bash" }], behavior: "allow", destination: "session" }],
      },
    });

    await bridge.handleCLIMessage(cli, msg);

    const session = bridge.getSession("s1")!;
    expect(session.pendingPermissions.size).toBe(1);
    const perm = session.pendingPermissions.get("req-42")!;
    expect(perm.tool_name).toBe("Bash");
    expect(perm.input).toEqual({ command: "ls -la" });
    expect(perm.description).toBe("List files");
    expect(perm.tool_use_id).toBe("tu-42");
    expect(perm.agent_id).toBe("agent-1");
    expect(perm.timestamp).toBeGreaterThan(0);

    const calls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    const permBroadcast = calls.find((c: any) => c.type === "permission_request");
    expect(permBroadcast).toBeDefined();
    expect(permBroadcast.request.request_id).toBe("req-42");
    expect(permBroadcast.request.tool_name).toBe("Bash");
  });

  it("tool_progress: broadcasts", async () => {
    const msg = JSON.stringify({
      type: "tool_progress",
      tool_use_id: "tu-10",
      tool_name: "Bash",
      parent_tool_use_id: null,
      elapsed_time_seconds: 3.5,
      uuid: "uuid-7",
      session_id: "s1",
    });

    await bridge.handleCLIMessage(cli, msg);

    const calls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    const progressMsg = calls.find((c: any) => c.type === "tool_progress");
    expect(progressMsg).toBeDefined();
    expect(progressMsg.tool_use_id).toBe("tu-10");
    expect(progressMsg.tool_name).toBe("Bash");
    expect(progressMsg.elapsed_time_seconds).toBe(3.5);
  });

  it("tool_use_summary: broadcasts", async () => {
    const msg = JSON.stringify({
      type: "tool_use_summary",
      summary: "Ran bash command successfully",
      preceding_tool_use_ids: ["tu-10", "tu-11"],
      uuid: "uuid-8",
      session_id: "s1",
    });

    await bridge.handleCLIMessage(cli, msg);

    const calls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    const summaryMsg = calls.find((c: any) => c.type === "tool_use_summary");
    expect(summaryMsg).toBeDefined();
    expect(summaryMsg.summary).toBe("Ran bash command successfully");
    expect(summaryMsg.tool_use_ids).toEqual(["tu-10", "tu-11"]);
  });

  it("keep_alive: silently consumed, no broadcast", async () => {
    const msg = JSON.stringify({ type: "keep_alive" });

    await bridge.handleCLIMessage(cli, msg);

    expect(browser.send).not.toHaveBeenCalled();
  });

  it("multi-line NDJSON: processes both lines", async () => {
    const line1 = JSON.stringify({
      type: "tool_progress",
      tool_use_id: "tu-a",
      tool_name: "Read",
      parent_tool_use_id: null,
      elapsed_time_seconds: 1,
      uuid: "uuid-a",
      session_id: "s1",
    });
    const line2 = JSON.stringify({
      type: "tool_progress",
      tool_use_id: "tu-b",
      tool_name: "Edit",
      parent_tool_use_id: null,
      elapsed_time_seconds: 2,
      uuid: "uuid-b",
      session_id: "s1",
    });

    await bridge.handleCLIMessage(cli, line1 + "\n" + line2);

    const calls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    const progressMsgs = calls.filter((c: any) => c.type === "tool_progress");
    expect(progressMsgs).toHaveLength(2);
    expect(progressMsgs[0].tool_use_id).toBe("tu-a");
    expect(progressMsgs[1].tool_use_id).toBe("tu-b");
  });

  it("malformed JSON: skips gracefully without crashing", async () => {
    const validLine = JSON.stringify({ type: "keep_alive" });
    const raw = "not-valid-json\n" + validLine;

    // Should not throw (async — just await it directly)
    await bridge.handleCLIMessage(cli, raw);
    // Parse errors now surface as error messages to the browser,
    // but keep_alive is still silently consumed. Only the parse error
    // should reach the browser.
    const calls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    const errorMsgs = calls.filter((c: any) => c.type === "error");
    expect(errorMsgs.length).toBe(1);
    expect(errorMsgs[0].message).toContain("parse_error");
    // No keep_alive should have been broadcast
    expect(calls.filter((c: any) => c.type === "keep_alive").length).toBe(0);
  });
});

// ─── Browser message routing ─────────────────────────────────────────────────

describe("Browser message routing", () => {
  let cli: ReturnType<typeof makeCliSocket>;
  let browser: ReturnType<typeof makeBrowserSocket>;

  beforeEach(() => {
    cli = makeCliSocket("s1");
    browser = makeBrowserSocket("s1");
    bridge.handleCLIOpen(cli, "s1");
    bridge.handleBrowserOpen(browser, "s1");
    cli.send.mockClear();
    browser.send.mockClear();
  });

  it("user_message: sends NDJSON to CLI and stores in history", () => {
    bridge.handleBrowserMessage(browser, JSON.stringify({
      type: "user_message",
      content: "What is 2+2?",
    }));

    // Should have sent NDJSON to CLI
    expect(cli.send).toHaveBeenCalledTimes(1);
    const sentRaw = cli.send.mock.calls[0][0] as string;
    const sent = JSON.parse(sentRaw.trim());
    expect(sent.type).toBe("user");
    expect(sent.message.role).toBe("user");
    expect(sent.message.content).toBe("What is 2+2?");

    // Should store in history
    const session = bridge.getSession("s1")!;
    expect(session.messageHistory).toHaveLength(1);
    expect(session.messageHistory[0].type).toBe("user_message");
    if (session.messageHistory[0].type === "user_message") {
      expect(session.messageHistory[0].content).toBe("What is 2+2?");
    }
  });

  it("user_message: queues when CLI not connected", () => {
    // Close CLI
    bridge.handleCLIClose(cli);
    browser.send.mockClear();

    bridge.handleBrowserMessage(browser, JSON.stringify({
      type: "user_message",
      content: "queued message",
    }));

    // Messages are now queued as BrowserOutgoingMessage JSON (not NDJSON)
    // and converted to backend format when flushed via adapter.send()
    const session = bridge.getSession("s1")!;
    expect(session.pendingMessages).toHaveLength(1);
    const queued = JSON.parse(session.pendingMessages[0]);
    expect(queued.type).toBe("user_message");
    expect(queued.content).toBe("queued message");
  });

  it("user_message: re-queues when backend send fails despite adapter connected", () => {
    const session = bridge.getSession("s1")!;
    session.backendAdapter = {
      isConnected: () => true,
      send: () => false,
      disconnect: async () => {},
      onBrowserMessage: () => {},
      onSessionMeta: () => {},
      onDisconnect: () => {},
    } as any;

    bridge.handleBrowserMessage(browser, JSON.stringify({
      type: "user_message",
      content: "retry this",
    }));

    expect(session.pendingMessages).toHaveLength(1);
    const queued = JSON.parse(session.pendingMessages[0]);
    expect(queued.type).toBe("user_message");
    expect(queued.content).toBe("retry this");
  });

  it("flushes bridge-queued messages once backend becomes connected", () => {
    const browser = makeBrowserSocket("codex-s1");
    bridge.handleBrowserOpen(browser, "codex-s1");

    bridge.handleBrowserMessage(browser, JSON.stringify({
      type: "user_message",
      content: "hello queued before connect",
    }));

    const session = bridge.getSession("codex-s1")!;
    expect(session.pendingMessages).toHaveLength(1);

    let connected = false;
    const send = vi.fn((msg: any) => connected);
    const adapter = {
      isConnected: () => connected,
      send,
      disconnect: async () => {},
      onBrowserMessage: () => {},
      onSessionMeta: () => {},
      onDisconnect: () => {},
      onInitError: () => {},
    };

    bridge.attachBackendAdapter("codex-s1", adapter as any, "codex");

    // Initial attach flush is attempted but backend still disconnected,
    // so the queued message must remain pending.
    expect(send).toHaveBeenCalledTimes(1);
    expect(session.pendingMessages).toHaveLength(1);

    connected = true;
    bridge.handleBrowserMessage(browser, JSON.stringify({ type: "mcp_get_status" }));

    // Queued user message flushes first, then current message is dispatched.
    expect(session.pendingMessages).toHaveLength(0);
    expect(send).toHaveBeenCalledTimes(3);
    const messageTypes = send.mock.calls.map(([msg]: [any]) => msg.type);
    expect(messageTypes).toEqual(["user_message", "user_message", "mcp_get_status"]);
  });

  it("flushes bridge-queued messages when codex session init marks the adapter connected", () => {
    const browser = makeBrowserSocket("codex-init-flush");
    bridge.handleBrowserOpen(browser, "codex-init-flush");

    bridge.handleBrowserMessage(browser, JSON.stringify({
      type: "user_message",
      content: "flush me after codex init",
    }));

    const session = bridge.getSession("codex-init-flush")!;
    expect(session.pendingMessages).toHaveLength(1);

    let onBrowserMessage: ((msg: any) => void) | undefined;
    let onSessionMeta: ((meta: any) => void) | undefined;
    const send = vi.fn(() => connected);
    let connected = false;
    const adapter = {
      isConnected: () => connected,
      send,
      disconnect: async () => {},
      onBrowserMessage: (cb: (msg: any) => void) => {
        onBrowserMessage = cb;
      },
      onSessionMeta: (cb: (meta: any) => void) => {
        onSessionMeta = cb;
      },
      onDisconnect: () => {},
      onInitError: () => {},
    };

    bridge.attachBackendAdapter("codex-init-flush", adapter as any, "codex");

    expect(send).toHaveBeenCalledTimes(1);
    expect(session.pendingMessages).toHaveLength(1);

    connected = true;
    onSessionMeta?.({
      cliSessionId: "thr-codex-init-flush",
      model: "gpt-5.4",
      cwd: "/test",
    });
    onBrowserMessage?.({
      type: "session_init",
      session: {
        session_id: "codex-init-flush",
        backend_type: "codex",
        model: "gpt-5.4",
        cwd: "/test",
        tools: [],
        permissionMode: "bypassPermissions",
        claude_code_version: "",
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
    });

    expect(send).toHaveBeenCalledTimes(2);
    const flushedCall = (send.mock.calls as any[][])[1];
    const flushedArg = flushedCall?.[0];
    expect(flushedCall).toBeDefined();
    expect(flushedArg).toMatchObject({
      type: "user_message",
      content: "flush me after codex init",
    });
    expect(session.pendingMessages).toHaveLength(0);
  });

  it("preserves FIFO when queued flush is interrupted before sending current message", () => {
    const session = bridge.getSession("s1")!;
    session.pendingMessages.push(JSON.stringify({
      type: "user_message",
      content: "older queued",
    }));

    const send = vi.fn((msg: any) => {
      if (msg.type === "user_message" && msg.content === "older queued" && send.mock.calls.length === 1) {
        return false;
      }
      return true;
    });

    session.backendAdapter = {
      isConnected: () => true,
      send,
      disconnect: async () => {},
      onBrowserMessage: () => {},
      onSessionMeta: () => {},
      onDisconnect: () => {},
    } as any;

    // First dispatch tries to flush the older queued message, fails, and must
    // queue the current message instead of sending it out-of-order.
    bridge.handleBrowserMessage(browser, JSON.stringify({ type: "mcp_get_status" }));

    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toMatchObject({ type: "user_message", content: "older queued" });
    expect(session.pendingMessages).toHaveLength(2);
    expect(JSON.parse(session.pendingMessages[0])).toMatchObject({ type: "user_message", content: "older queued" });
    expect(JSON.parse(session.pendingMessages[1])).toMatchObject({ type: "mcp_get_status" });
  });

  it("permission_response: does not re-queue when backend send fails", async () => {
    await bridge.handleCLIMessage(cli, JSON.stringify({
      type: "control_request",
      request_id: "req-no-requeue",
      request: {
        subtype: "can_use_tool",
        tool_name: "Bash",
        input: { command: "echo hi" },
        tool_use_id: "tu-no-requeue",
      },
    }));

    const session = bridge.getSession("s1")!;
    const send = vi.fn(() => false);
    session.backendAdapter = {
      isConnected: () => true,
      send,
      disconnect: async () => {},
      onBrowserMessage: () => {},
      onSessionMeta: () => {},
      onDisconnect: () => {},
    } as any;

    bridge.handleBrowserMessage(browser, JSON.stringify({
      type: "permission_response",
      request_id: "req-no-requeue",
      behavior: "allow",
    }));

    expect(send).toHaveBeenCalledTimes(1);
    expect(session.pendingPermissions.has("req-no-requeue")).toBe(false);
    expect(session.pendingMessages).toHaveLength(0);
  });

  it("user_message: deduplicates repeated client_msg_id", () => {
    const payload = {
      type: "user_message",
      content: "once only",
      client_msg_id: "client-msg-1",
    };

    bridge.handleBrowserMessage(browser, JSON.stringify(payload));
    bridge.handleBrowserMessage(browser, JSON.stringify(payload));

    expect(cli.send).toHaveBeenCalledTimes(1);
    const session = bridge.getSession("s1")!;
    const userMessages = session.messageHistory.filter((m) => m.type === "user_message");
    expect(userMessages).toHaveLength(1);
  });

  it("user_message with images: builds content blocks", () => {
    bridge.handleBrowserMessage(browser, JSON.stringify({
      type: "user_message",
      content: "What's in this image?",
      images: [
        { media_type: "image/png", data: "base64data==" },
      ],
    }));

    const sentRaw = cli.send.mock.calls[0][0] as string;
    const sent = JSON.parse(sentRaw.trim());
    expect(sent.type).toBe("user");
    expect(Array.isArray(sent.message.content)).toBe(true);
    expect(sent.message.content).toHaveLength(2);
    // First block should be the image
    expect(sent.message.content[0].type).toBe("image");
    expect(sent.message.content[0].source.type).toBe("base64");
    expect(sent.message.content[0].source.media_type).toBe("image/png");
    expect(sent.message.content[0].source.data).toBe("base64data==");
    // Second block should be the text
    expect(sent.message.content[1].type).toBe("text");
    expect(sent.message.content[1].text).toBe("What's in this image?");
  });

  it("permission_response allow: sends control_response to CLI", async () => {
    // First create a pending permission
    await bridge.handleCLIMessage(cli, JSON.stringify({
      type: "control_request",
      request_id: "req-allow",
      request: {
        subtype: "can_use_tool",
        tool_name: "Bash",
        input: { command: "echo hi" },
        tool_use_id: "tu-allow",
      },
    }));
    cli.send.mockClear();

    bridge.handleBrowserMessage(browser, JSON.stringify({
      type: "permission_response",
      request_id: "req-allow",
      behavior: "allow",
    }));

    expect(cli.send).toHaveBeenCalledTimes(1);
    const sentRaw = cli.send.mock.calls[0][0] as string;
    const sent = JSON.parse(sentRaw.trim());
    expect(sent.type).toBe("control_response");
    expect(sent.response.subtype).toBe("success");
    expect(sent.response.request_id).toBe("req-allow");
    expect(sent.response.response.behavior).toBe("allow");
    expect(sent.response.response.updatedInput).toEqual({ command: "echo hi" });

    // Should remove from pending
    const session = bridge.getSession("s1")!;
    expect(session.pendingPermissions.has("req-allow")).toBe(false);
  });

  it("permission_response deny: sends deny response to CLI", async () => {
    // Create a pending permission
    await bridge.handleCLIMessage(cli, JSON.stringify({
      type: "control_request",
      request_id: "req-deny",
      request: {
        subtype: "can_use_tool",
        tool_name: "Bash",
        input: { command: "rm -rf /" },
        tool_use_id: "tu-deny",
      },
    }));
    cli.send.mockClear();

    bridge.handleBrowserMessage(browser, JSON.stringify({
      type: "permission_response",
      request_id: "req-deny",
      behavior: "deny",
      message: "Too dangerous",
    }));

    expect(cli.send).toHaveBeenCalledTimes(1);
    const sentRaw = cli.send.mock.calls[0][0] as string;
    const sent = JSON.parse(sentRaw.trim());
    expect(sent.type).toBe("control_response");
    expect(sent.response.subtype).toBe("success");
    expect(sent.response.request_id).toBe("req-deny");
    expect(sent.response.response.behavior).toBe("deny");
    expect(sent.response.response.message).toBe("Too dangerous");

    // Should remove from pending
    const session = bridge.getSession("s1")!;
    expect(session.pendingPermissions.has("req-deny")).toBe(false);
  });

  it("permission_response: deduplicates repeated client_msg_id", async () => {
    await bridge.handleCLIMessage(cli, JSON.stringify({
      type: "control_request",
      request_id: "req-dedupe",
      request: {
        subtype: "can_use_tool",
        tool_name: "Bash",
        input: { command: "echo hi" },
        tool_use_id: "tu-dedupe",
      },
    }));
    cli.send.mockClear();

    const payload = {
      type: "permission_response",
      request_id: "req-dedupe",
      behavior: "allow",
      client_msg_id: "perm-msg-1",
    };
    bridge.handleBrowserMessage(browser, JSON.stringify(payload));
    bridge.handleBrowserMessage(browser, JSON.stringify(payload));

    expect(cli.send).toHaveBeenCalledTimes(1);
    const session = bridge.getSession("s1")!;
    expect(session.pendingPermissions.has("req-dedupe")).toBe(false);
  });

  it("interrupt: sends control_request with interrupt subtype to CLI", () => {
    bridge.handleBrowserMessage(browser, JSON.stringify({
      type: "interrupt",
    }));

    expect(cli.send).toHaveBeenCalledTimes(1);
    const sentRaw = cli.send.mock.calls[0][0] as string;
    const sent = JSON.parse(sentRaw.trim());
    expect(sent.type).toBe("control_request");
    expect(sent.request_id).toBe("test-uuid");
    expect(sent.request.subtype).toBe("interrupt");
  });

  it("interrupt: deduplicates repeated client_msg_id", () => {
    const payload = { type: "interrupt", client_msg_id: "ctrl-msg-1" };
    bridge.handleBrowserMessage(browser, JSON.stringify(payload));
    bridge.handleBrowserMessage(browser, JSON.stringify(payload));

    expect(cli.send).toHaveBeenCalledTimes(1);
  });

  it("set_model: sends control_request with set_model subtype to CLI", () => {
    bridge.handleBrowserMessage(browser, JSON.stringify({
      type: "set_model",
      model: "claude-opus-4-5-20250929",
    }));

    expect(cli.send).toHaveBeenCalledTimes(1);
    const sentRaw = cli.send.mock.calls[0][0] as string;
    const sent = JSON.parse(sentRaw.trim());
    expect(sent.type).toBe("control_request");
    expect(sent.request_id).toBe("test-uuid");
    expect(sent.request.subtype).toBe("set_model");
    expect(sent.request.model).toBe("claude-opus-4-5-20250929");
  });

  it("set_permission_mode: sends control_request with set_permission_mode subtype to CLI", () => {
    bridge.handleBrowserMessage(browser, JSON.stringify({
      type: "set_permission_mode",
      mode: "bypassPermissions",
    }));

    expect(cli.send).toHaveBeenCalledTimes(1);
    const sentRaw = cli.send.mock.calls[0][0] as string;
    const sent = JSON.parse(sentRaw.trim());
    expect(sent.type).toBe("control_request");
    expect(sent.request_id).toBe("test-uuid");
    expect(sent.request.subtype).toBe("set_permission_mode");
    expect(sent.request.mode).toBe("bypassPermissions");
  });

  it("set_model: deduplicates repeated client_msg_id", () => {
    const payload = {
      type: "set_model",
      model: "claude-opus-4-5-20250929",
      client_msg_id: "set-model-1",
    };
    bridge.handleBrowserMessage(browser, JSON.stringify(payload));
    bridge.handleBrowserMessage(browser, JSON.stringify(payload));
    expect(cli.send).toHaveBeenCalledTimes(1);
  });

  it("set_permission_mode: deduplicates repeated client_msg_id", () => {
    const payload = {
      type: "set_permission_mode",
      mode: "plan",
      client_msg_id: "set-mode-1",
    };
    bridge.handleBrowserMessage(browser, JSON.stringify(payload));
    bridge.handleBrowserMessage(browser, JSON.stringify(payload));
    expect(cli.send).toHaveBeenCalledTimes(1);
  });

  it("mcp_toggle: deduplicates repeated client_msg_id", () => {
    const payload = {
      type: "mcp_toggle",
      serverName: "my-mcp",
      enabled: true,
      client_msg_id: "mcp-msg-1",
    };
    bridge.handleBrowserMessage(browser, JSON.stringify(payload));
    bridge.handleBrowserMessage(browser, JSON.stringify(payload));

    // 1 send for mcp_toggle control_request + delayed status refresh timer not run in this assertion window.
    expect(cli.send).toHaveBeenCalledTimes(1);
  });

  it("mcp_get_status: deduplicates repeated client_msg_id", () => {
    const payload = {
      type: "mcp_get_status",
      client_msg_id: "mcp-status-1",
    };
    bridge.handleBrowserMessage(browser, JSON.stringify(payload));
    bridge.handleBrowserMessage(browser, JSON.stringify(payload));
    expect(cli.send).toHaveBeenCalledTimes(1);
  });

  it("mcp_reconnect: deduplicates repeated client_msg_id", () => {
    const payload = {
      type: "mcp_reconnect",
      serverName: "my-mcp",
      client_msg_id: "mcp-reconnect-1",
    };
    bridge.handleBrowserMessage(browser, JSON.stringify(payload));
    bridge.handleBrowserMessage(browser, JSON.stringify(payload));
    expect(cli.send).toHaveBeenCalledTimes(1);
  });

  it("mcp_set_servers: deduplicates repeated client_msg_id", () => {
    const payload = {
      type: "mcp_set_servers",
      servers: {
        "server-a": {
          type: "stdio",
          command: "node",
          args: ["server.js"],
        },
      },
      client_msg_id: "mcp-set-servers-1",
    };
    bridge.handleBrowserMessage(browser, JSON.stringify(payload));
    bridge.handleBrowserMessage(browser, JSON.stringify(payload));
    expect(cli.send).toHaveBeenCalledTimes(1);
  });
});

// ─── Persistence ─────────────────────────────────────────────────────────────

describe("Persistence", () => {
  it("restoreFromDisk: loads sessions from store", () => {
    // Save a session directly to the store
    store.saveSync({
      id: "persisted-1",
      state: {
        session_id: "persisted-1",
        model: "claude-sonnet-4-6",
        cwd: "/saved",
        tools: ["Bash"],
        permissionMode: "default",
        claude_code_version: "1.0",
        mcp_servers: [],
        agents: [],
        slash_commands: [],
        skills: [],
        total_cost_usd: 0.1,
        num_turns: 5,
        context_used_percent: 15,
        is_compacting: false,
        git_branch: "main",
        is_worktree: false,
        is_containerized: false,
        repo_root: "/saved",
        git_ahead: 0,
        git_behind: 0,
        total_lines_added: 0,
        total_lines_removed: 0,
      },
      messageHistory: [
        { type: "user_message", content: "Hello", timestamp: 1000 },
      ],
      pendingMessages: [],
      pendingPermissions: [],
      processedClientMessageIds: ["restored-client-1"],
    });

    const count = bridge.restoreFromDisk();
    expect(count).toBe(1);

    const session = bridge.getSession("persisted-1");
    expect(session).toBeDefined();
    expect(session!.state.model).toBe("claude-sonnet-4-6");
    expect(session!.state.cwd).toBe("/saved");
    expect(session!.state.total_cost_usd).toBe(0.1);
    expect(session!.messageHistory).toHaveLength(1);
    expect(session!.backendAdapter).toBeNull();
    expect(session!.browserSockets.size).toBe(0);
    expect(session!.processedClientMessageIdSet.has("restored-client-1")).toBe(true);
  });

  it("restoreFromDisk: does not overwrite live sessions", () => {
    // Create a live session first
    const liveSession = bridge.getOrCreateSession("live-1");
    liveSession.state.model = "live-model";

    // Save a different version to disk
    store.saveSync({
      id: "live-1",
      state: {
        session_id: "live-1",
        model: "disk-model",
        cwd: "/disk",
        tools: [],
        permissionMode: "default",
        claude_code_version: "1.0",
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
    });

    const count = bridge.restoreFromDisk();
    expect(count).toBe(0);

    // Should still have the live model
    const session = bridge.getSession("live-1")!;
    expect(session.state.model).toBe("live-model");
  });

  // ─── MIGRATE-01 / MIGRATE-02: legacy-key migration invariant (codex round-4 BLOCK 2) ─
  //
  // Context: earlier commits wrote the IDE MCP entry under the bare sanitized
  // ideName (e.g. `"neovim"`), then under `"companionideneovim"`, and now
  // under `"companion-ide-neovim"`. Codex review asked: after upgrade, do
  // legacy entries on disk become permanent orphans?
  //
  // Verified (see session-store.ts + ws-bridge.ts:287): `dynamicMcpServers`
  // is a ws-bridge-local in-memory mirror that is NEVER persisted. The only
  // state that round-trips to disk is `session.state` (which includes
  // `ideBinding`), `messageHistory`, `pendingMessages`, and a few metadata
  // fields — never `dynamicMcpServers`. On every `restoreFromDisk`, the
  // bridge hydrates `dynamicMcpServers: {}` unconditionally (ws-bridge.ts
  // line 287), so no legacy IDE MCP key from a prior in-memory run can
  // survive a restart. The Claude CLI subprocess is restarted too, and its
  // dynamic MCP set (scope:"dynamic") is also in-memory only. BLOCK 2 is
  // therefore moot — there is no persistence path that carries the old key
  // forward.
  //
  // These two tests pin the invariant so a future refactor that adds
  // `dynamicMcpServers` to `PersistedSession` (e.g. for hot-restart speed)
  // cannot silently re-introduce the orphan bug.

  it("MIGRATE-01: restoreFromDisk always hydrates dynamicMcpServers to {} — legacy IDE keys cannot survive a restart", () => {
    // Emulate a pre-fix persisted session that had an `ideBinding` and that
    // at runtime carried a legacy IDE MCP entry under the bare ideName. The
    // legacy entry lives only in the in-memory mirror (which is not
    // persisted); on disk we just have the ideBinding + standard state.
    store.saveSync({
      id: "migrate-1",
      state: {
        session_id: "migrate-1",
        model: "claude-sonnet-4-6",
        cwd: "/w",
        tools: ["Bash"],
        permissionMode: "default",
        claude_code_version: "1.0",
        mcp_servers: [],
        agents: [],
        slash_commands: [],
        skills: [],
        total_cost_usd: 0,
        num_turns: 0,
        context_used_percent: 0,
        is_compacting: false,
        git_branch: "main",
        is_worktree: false,
        is_containerized: false,
        repo_root: "/w",
        git_ahead: 0,
        git_behind: 0,
        total_lines_added: 0,
        total_lines_removed: 0,
        // Legacy ideBinding shape — ideName "Neovim" would sanitize to "neovim"
        // under the old code, "companionideneovim" under the prior fix.
        ideBinding: {
          port: 50001,
          ideName: "Neovim",
          workspaceFolders: ["/w"],
          transport: "ws-ide",
          boundAt: 1_700_000_000_000,
          lockfilePath: "/tmp/fake.lock",
        },
      } as any,
      messageHistory: [],
      pendingMessages: [],
      pendingPermissions: [],
    });

    const count = bridge.restoreFromDisk();
    expect(count).toBe(1);

    const session = bridge.getSession("migrate-1")!;
    // The IDE binding is restored (state round-trips).
    expect(session.state.ideBinding?.ideName).toBe("Neovim");
    // But the dynamicMcpServers mirror is ALWAYS fresh-empty after restore,
    // regardless of what key format the previous process used. Any legacy
    // `"neovim"`, `"companionideneovim"`, etc. is simply not reachable.
    expect(session.dynamicMcpServers).toEqual({});
  });

  it("MIGRATE-02: restoreFromDisk does not accept dynamicMcpServers from the PersistedSession shape (defensive)", () => {
    // Even if a future disk write accidentally includes a `dynamicMcpServers`
    // field (via a cast / new type / forked bridge), the restore path must
    // NOT read it. This guards against silently re-introducing the legacy
    // key problem if persistence shape is expanded later.
    const maliciousPersisted = {
      id: "migrate-2",
      state: {
        session_id: "migrate-2",
        model: "claude-sonnet-4-6",
        cwd: "/w",
        tools: [],
        permissionMode: "default",
        claude_code_version: "1.0",
        mcp_servers: [],
        agents: [],
        slash_commands: [],
        skills: [],
        total_cost_usd: 0,
        num_turns: 0,
        context_used_percent: 0,
        is_compacting: false,
        git_branch: "main",
        is_worktree: false,
        is_containerized: false,
        repo_root: "/w",
        git_ahead: 0,
        git_behind: 0,
        total_lines_added: 0,
        total_lines_removed: 0,
      },
      messageHistory: [],
      pendingMessages: [],
      pendingPermissions: [],
      // Attacker / legacy-bug shape: an old dynamicMcpServers field that
      // includes BOTH the legacy bare key AND a user entry at the current
      // structurally-disjoint key. Per BLOCK 2 concern, we must never read
      // this back — the bridge builds dynamicMcpServers fresh.
      dynamicMcpServers: {
        neovim: { type: "ws-ide", ideName: "Neovim" },
        "companion-ide-neovim": { type: "ws-ide", ideName: "Neovim" },
      },
    };
    store.saveSync(maliciousPersisted as any);

    const count = bridge.restoreFromDisk();
    expect(count).toBe(1);

    const session = bridge.getSession("migrate-2")!;
    // Critical invariant: the bridge does NOT trust the on-disk
    // `dynamicMcpServers` — it always starts empty. If a future change
    // breaks this invariant, both keys above would leak into the mirror
    // and potentially be re-sent to the CLI on the next `bindIde` merge.
    expect(session.dynamicMcpServers).toEqual({});
    expect(session.dynamicMcpServers.neovim).toBeUndefined();
    expect(session.dynamicMcpServers["companion-ide-neovim"]).toBeUndefined();
  });

  it("persistSession: called after state changes (via store.save)", async () => {
    mockExecSync.mockImplementation(() => {
      throw new Error("not a git repo");
    });

    const saveSpy = vi.spyOn(store, "save");

    const cli = makeCliSocket("s1");
    bridge.handleCLIOpen(cli, "s1");

    // system.init should trigger persist
    await bridge.handleCLIMessage(cli, makeInitMsg());
    expect(saveSpy).toHaveBeenCalled();

    const lastCall = saveSpy.mock.calls[saveSpy.mock.calls.length - 1][0];
    expect(lastCall.id).toBe("s1");
    expect(lastCall.state.model).toBe("claude-sonnet-4-6");

    saveSpy.mockClear();

    // assistant message should trigger persist
    await bridge.handleCLIMessage(cli, JSON.stringify({
      type: "assistant",
      message: {
        id: "msg-1",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-4-6",
        content: [{ type: "text", text: "Test" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
      parent_tool_use_id: null,
      uuid: "uuid-p1",
      session_id: "s1",
    }));
    expect(saveSpy).toHaveBeenCalled();

    saveSpy.mockClear();

    // result message should trigger persist
    await bridge.handleCLIMessage(cli, JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      duration_ms: 1000,
      duration_api_ms: 800,
      num_turns: 1,
      total_cost_usd: 0.01,
      stop_reason: "end_turn",
      usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      uuid: "uuid-p2",
      session_id: "s1",
    }));
    expect(saveSpy).toHaveBeenCalled();

    saveSpy.mockClear();

    // control_request (can_use_tool) should trigger persist
    await bridge.handleCLIMessage(cli, JSON.stringify({
      type: "control_request",
      request_id: "req-persist",
      request: {
        subtype: "can_use_tool",
        tool_name: "Bash",
        input: { command: "echo test" },
        tool_use_id: "tu-persist",
      },
    }));
    expect(saveSpy).toHaveBeenCalled();

    saveSpy.mockClear();

    // user message from browser should trigger persist
    const browserWs = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browserWs, "s1");
    bridge.handleBrowserMessage(browserWs, JSON.stringify({
      type: "user_message",
      content: "test persist",
    }));
    expect(saveSpy).toHaveBeenCalled();
  });
});

// ─── auth_status message routing ──────────────────────────────────────────────

describe("auth_status message routing", () => {
  let cli: ReturnType<typeof makeCliSocket>;
  let browser: ReturnType<typeof makeBrowserSocket>;

  beforeEach(() => {
    cli = makeCliSocket("s1");
    browser = makeBrowserSocket("s1");
    bridge.handleCLIOpen(cli, "s1");
    bridge.handleBrowserOpen(browser, "s1");
    browser.send.mockClear();
  });

  it("broadcasts auth_status with isAuthenticating: true", async () => {
    const msg = JSON.stringify({
      type: "auth_status",
      isAuthenticating: true,
      output: ["Waiting for authentication..."],
      uuid: "uuid-auth-1",
      session_id: "s1",
    });

    await bridge.handleCLIMessage(cli, msg);

    const calls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    const authMsg = calls.find((c: any) => c.type === "auth_status");
    expect(authMsg).toBeDefined();
    expect(authMsg.isAuthenticating).toBe(true);
    expect(authMsg.output).toEqual(["Waiting for authentication..."]);
    expect(authMsg.error).toBeUndefined();
  });

  it("broadcasts auth_status with isAuthenticating: false", async () => {
    const msg = JSON.stringify({
      type: "auth_status",
      isAuthenticating: false,
      output: ["Authentication complete"],
      uuid: "uuid-auth-2",
      session_id: "s1",
    });

    await bridge.handleCLIMessage(cli, msg);

    const calls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    const authMsg = calls.find((c: any) => c.type === "auth_status");
    expect(authMsg).toBeDefined();
    expect(authMsg.isAuthenticating).toBe(false);
    expect(authMsg.output).toEqual(["Authentication complete"]);
  });

  it("broadcasts auth_status with error field", async () => {
    const msg = JSON.stringify({
      type: "auth_status",
      isAuthenticating: false,
      output: ["Failed to authenticate"],
      error: "Token expired",
      uuid: "uuid-auth-3",
      session_id: "s1",
    });

    await bridge.handleCLIMessage(cli, msg);

    const calls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    const authMsg = calls.find((c: any) => c.type === "auth_status");
    expect(authMsg).toBeDefined();
    expect(authMsg.isAuthenticating).toBe(false);
    expect(authMsg.error).toBe("Token expired");
    expect(authMsg.output).toEqual(["Failed to authenticate"]);
  });
});

// ─── permission_response with updated_permissions ─────────────────────────────

describe("permission_response with updated_permissions", () => {
  let cli: ReturnType<typeof makeCliSocket>;
  let browser: ReturnType<typeof makeBrowserSocket>;

  beforeEach(() => {
    cli = makeCliSocket("s1");
    browser = makeBrowserSocket("s1");
    bridge.handleCLIOpen(cli, "s1");
    bridge.handleBrowserOpen(browser, "s1");
    cli.send.mockClear();
    browser.send.mockClear();
  });

  it("allow with updated_permissions forwards updatedPermissions in control_response", async () => {
    // Create pending permission
    await bridge.handleCLIMessage(cli, JSON.stringify({
      type: "control_request",
      request_id: "req-perm-update",
      request: {
        subtype: "can_use_tool",
        tool_name: "Bash",
        input: { command: "echo hello" },
        tool_use_id: "tu-perm-update",
      },
    }));
    cli.send.mockClear();

    const updatedPermissions = [
      { type: "addRules", rules: [{ toolName: "Bash", ruleContent: "echo *" }], behavior: "allow", destination: "session" },
    ];

    bridge.handleBrowserMessage(browser, JSON.stringify({
      type: "permission_response",
      request_id: "req-perm-update",
      behavior: "allow",
      updated_permissions: updatedPermissions,
    }));

    expect(cli.send).toHaveBeenCalledTimes(1);
    const sentRaw = cli.send.mock.calls[0][0] as string;
    const sent = JSON.parse(sentRaw.trim());
    expect(sent.type).toBe("control_response");
    expect(sent.response.response.behavior).toBe("allow");
    expect(sent.response.response.updatedPermissions).toEqual(updatedPermissions);
  });

  it("allow without updated_permissions does not include updatedPermissions key", async () => {
    // Create pending permission
    await bridge.handleCLIMessage(cli, JSON.stringify({
      type: "control_request",
      request_id: "req-no-perm",
      request: {
        subtype: "can_use_tool",
        tool_name: "Read",
        input: { file_path: "/test.ts" },
        tool_use_id: "tu-no-perm",
      },
    }));
    cli.send.mockClear();

    bridge.handleBrowserMessage(browser, JSON.stringify({
      type: "permission_response",
      request_id: "req-no-perm",
      behavior: "allow",
    }));

    const sentRaw = cli.send.mock.calls[0][0] as string;
    const sent = JSON.parse(sentRaw.trim());
    expect(sent.response.response.updatedPermissions).toBeUndefined();
  });

  it("allow with empty updated_permissions does not include updatedPermissions key", async () => {
    await bridge.handleCLIMessage(cli, JSON.stringify({
      type: "control_request",
      request_id: "req-empty-perm",
      request: {
        subtype: "can_use_tool",
        tool_name: "Read",
        input: { file_path: "/test.ts" },
        tool_use_id: "tu-empty-perm",
      },
    }));
    cli.send.mockClear();

    bridge.handleBrowserMessage(browser, JSON.stringify({
      type: "permission_response",
      request_id: "req-empty-perm",
      behavior: "allow",
      updated_permissions: [],
    }));

    const sentRaw = cli.send.mock.calls[0][0] as string;
    const sent = JSON.parse(sentRaw.trim());
    expect(sent.response.response.updatedPermissions).toBeUndefined();
  });
});

// ─── Multiple browser sockets ─────────────────────────────────────────────────

describe("Multiple browser sockets", () => {
  it("broadcasts to ALL connected browsers", async () => {
    const cli = makeCliSocket("s1");
    const browser1 = makeBrowserSocket("s1");
    const browser2 = makeBrowserSocket("s1");
    const browser3 = makeBrowserSocket("s1");

    bridge.handleCLIOpen(cli, "s1");
    bridge.handleBrowserOpen(browser1, "s1");
    bridge.handleBrowserOpen(browser2, "s1");
    bridge.handleBrowserOpen(browser3, "s1");
    browser1.send.mockClear();
    browser2.send.mockClear();
    browser3.send.mockClear();

    const msg = JSON.stringify({
      type: "tool_progress",
      tool_use_id: "tu-multi",
      tool_name: "Bash",
      parent_tool_use_id: null,
      elapsed_time_seconds: 1.5,
      uuid: "uuid-multi",
      session_id: "s1",
    });
    await bridge.handleCLIMessage(cli, msg);

    // All three browsers should receive the broadcast
    for (const browser of [browser1, browser2, browser3]) {
      expect(browser.send).toHaveBeenCalledTimes(1);
      const sent = JSON.parse(browser.send.mock.calls[0][0]);
      expect(sent.type).toBe("tool_progress");
      expect(sent.tool_use_id).toBe("tu-multi");
    }
  });

  it("removes a browser whose send() throws, but others continue to receive", async () => {
    const cli = makeCliSocket("s1");
    const browser1 = makeBrowserSocket("s1");
    const browser2 = makeBrowserSocket("s1");
    const browser3 = makeBrowserSocket("s1");

    bridge.handleCLIOpen(cli, "s1");
    bridge.handleBrowserOpen(browser1, "s1");
    bridge.handleBrowserOpen(browser2, "s1");
    bridge.handleBrowserOpen(browser3, "s1");
    browser1.send.mockClear();
    browser2.send.mockClear();
    browser3.send.mockClear();

    // Make browser2's send throw
    browser2.send.mockImplementation(() => {
      throw new Error("WebSocket closed");
    });

    const msg = JSON.stringify({
      type: "tool_progress",
      tool_use_id: "tu-fail",
      tool_name: "Bash",
      parent_tool_use_id: null,
      elapsed_time_seconds: 2,
      uuid: "uuid-fail",
      session_id: "s1",
    });
    await bridge.handleCLIMessage(cli, msg);

    // browser1 and browser3 should have received the message
    expect(browser1.send).toHaveBeenCalledTimes(1);
    expect(browser3.send).toHaveBeenCalledTimes(1);

    // browser2 should have been removed from the set
    const session = bridge.getSession("s1")!;
    expect(session.browserSockets.has(browser2)).toBe(false);
    expect(session.browserSockets.has(browser1)).toBe(true);
    expect(session.browserSockets.has(browser3)).toBe(true);
    expect(session.browserSockets.size).toBe(2);
  });
});

// ─── handleCLIMessage with Buffer ─────────────────────────────────────────────

describe("handleCLIMessage with Buffer", () => {
  it("parses Buffer input correctly", async () => {
    const cli = makeCliSocket("s1");
    const browser = makeBrowserSocket("s1");
    bridge.handleCLIOpen(cli, "s1");
    bridge.handleBrowserOpen(browser, "s1");
    browser.send.mockClear();

    const jsonStr = JSON.stringify({
      type: "tool_progress",
      tool_use_id: "tu-buf",
      tool_name: "Bash",
      parent_tool_use_id: null,
      elapsed_time_seconds: 1,
      uuid: "uuid-buf",
      session_id: "s1",
    });

    // Pass as Buffer instead of string
    await bridge.handleCLIMessage(cli, Buffer.from(jsonStr, "utf-8"));

    const calls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    const progressMsg = calls.find((c: any) => c.type === "tool_progress");
    expect(progressMsg).toBeDefined();
    expect(progressMsg.tool_use_id).toBe("tu-buf");
    expect(progressMsg.tool_name).toBe("Bash");
  });

  it("handles multi-line NDJSON as Buffer", async () => {
    const cli = makeCliSocket("s1");
    const browser = makeBrowserSocket("s1");
    bridge.handleCLIOpen(cli, "s1");
    bridge.handleBrowserOpen(browser, "s1");
    browser.send.mockClear();

    const line1 = JSON.stringify({ type: "keep_alive" });
    const line2 = JSON.stringify({
      type: "tool_progress",
      tool_use_id: "tu-buf2",
      tool_name: "Read",
      parent_tool_use_id: null,
      elapsed_time_seconds: 3,
      uuid: "uuid-buf2",
      session_id: "s1",
    });
    const ndjson = line1 + "\n" + line2;

    await bridge.handleCLIMessage(cli, Buffer.from(ndjson, "utf-8"));

    // keep_alive is silently consumed, only tool_progress should be broadcast
    const calls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    expect(calls).toHaveLength(1);
    expect(calls[0].type).toBe("tool_progress");
    expect(calls[0].tool_use_id).toBe("tu-buf2");
  });
});

// ─── handleBrowserMessage with Buffer ─────────────────────────────────────────

describe("handleBrowserMessage with Buffer", () => {
  it("parses Buffer input and routes user_message correctly", () => {
    const cli = makeCliSocket("s1");
    const browser = makeBrowserSocket("s1");
    bridge.handleCLIOpen(cli, "s1");
    bridge.handleBrowserOpen(browser, "s1");
    cli.send.mockClear();

    const msgStr = JSON.stringify({
      type: "user_message",
      content: "Hello from buffer",
    });

    bridge.handleBrowserMessage(browser, Buffer.from(msgStr, "utf-8"));

    expect(cli.send).toHaveBeenCalledTimes(1);
    const sentRaw = cli.send.mock.calls[0][0] as string;
    const sent = JSON.parse(sentRaw.trim());
    expect(sent.type).toBe("user");
    expect(sent.message.content).toBe("Hello from buffer");
  });

  it("parses Buffer input and routes interrupt correctly", () => {
    const cli = makeCliSocket("s1");
    const browser = makeBrowserSocket("s1");
    bridge.handleCLIOpen(cli, "s1");
    bridge.handleBrowserOpen(browser, "s1");
    cli.send.mockClear();

    const msgStr = JSON.stringify({ type: "interrupt" });
    bridge.handleBrowserMessage(browser, Buffer.from(msgStr, "utf-8"));

    expect(cli.send).toHaveBeenCalledTimes(1);
    const sentRaw = cli.send.mock.calls[0][0] as string;
    const sent = JSON.parse(sentRaw.trim());
    expect(sent.type).toBe("control_request");
    expect(sent.request.subtype).toBe("interrupt");
  });
});

// ─── handleBrowserMessage with malformed JSON ─────────────────────────────────

describe("handleBrowserMessage with malformed JSON", () => {
  it("does not throw on invalid JSON", async () => {
    const cli = makeCliSocket("s1");
    const browser = makeBrowserSocket("s1");
    bridge.handleCLIOpen(cli, "s1");
    bridge.handleBrowserOpen(browser, "s1");
    cli.send.mockClear();

    expect(() => {
      bridge.handleBrowserMessage(browser, "this is not json {{{");
    }).not.toThrow();

    // CLI should not receive anything
    expect(cli.send).not.toHaveBeenCalled();
  });

  it("does not throw on empty string", () => {
    const cli = makeCliSocket("s1");
    const browser = makeBrowserSocket("s1");
    bridge.handleCLIOpen(cli, "s1");
    bridge.handleBrowserOpen(browser, "s1");
    cli.send.mockClear();

    expect(() => {
      bridge.handleBrowserMessage(browser, "");
    }).not.toThrow();

    expect(cli.send).not.toHaveBeenCalled();
  });

  it("does not throw on truncated JSON", () => {
    const cli = makeCliSocket("s1");
    const browser = makeBrowserSocket("s1");
    bridge.handleCLIOpen(cli, "s1");
    bridge.handleBrowserOpen(browser, "s1");
    cli.send.mockClear();

    expect(() => {
      bridge.handleBrowserMessage(browser, '{"type":"user_message","con');
    }).not.toThrow();

    expect(cli.send).not.toHaveBeenCalled();
  });
});

// ─── Empty NDJSON lines ───────────────────────────────────────────────────────

describe("Empty NDJSON lines", () => {
  let cli: ReturnType<typeof makeCliSocket>;
  let browser: ReturnType<typeof makeBrowserSocket>;

  beforeEach(() => {
    cli = makeCliSocket("s1");
    browser = makeBrowserSocket("s1");
    bridge.handleCLIOpen(cli, "s1");
    bridge.handleBrowserOpen(browser, "s1");
    browser.send.mockClear();
  });

  it("skips empty lines between valid NDJSON", async () => {
    const validMsg = JSON.stringify({
      type: "tool_progress",
      tool_use_id: "tu-empty-lines",
      tool_name: "Bash",
      parent_tool_use_id: null,
      elapsed_time_seconds: 1,
      uuid: "uuid-empty-lines",
      session_id: "s1",
    });

    // Empty lines, whitespace-only lines interspersed
    const raw = "\n\n" + validMsg + "\n\n   \n\t\n";
    await bridge.handleCLIMessage(cli, raw);

    const calls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    expect(calls).toHaveLength(1);
    expect(calls[0].type).toBe("tool_progress");
    expect(calls[0].tool_use_id).toBe("tu-empty-lines");
  });

  it("handles entirely empty/whitespace input without crashing", async () => {
    await bridge.handleCLIMessage(cli, "");
    await bridge.handleCLIMessage(cli, "\n\n\n");
    await bridge.handleCLIMessage(cli, "   \t  \n  ");
    expect(browser.send).not.toHaveBeenCalled();
  });

  it("processes valid lines around whitespace-only lines", async () => {
    const line1 = JSON.stringify({
      type: "tool_progress",
      tool_use_id: "tu-ws-1",
      tool_name: "Read",
      parent_tool_use_id: null,
      elapsed_time_seconds: 1,
      uuid: "uuid-ws-1",
      session_id: "s1",
    });
    const line2 = JSON.stringify({
      type: "tool_progress",
      tool_use_id: "tu-ws-2",
      tool_name: "Edit",
      parent_tool_use_id: null,
      elapsed_time_seconds: 2,
      uuid: "uuid-ws-2",
      session_id: "s1",
    });

    const raw = line1 + "\n   \n\n" + line2 + "\n";
    await bridge.handleCLIMessage(cli, raw);

    const calls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    const progressMsgs = calls.filter((c: any) => c.type === "tool_progress");
    expect(progressMsgs).toHaveLength(2);
    expect(progressMsgs[0].tool_use_id).toBe("tu-ws-1");
    expect(progressMsgs[1].tool_use_id).toBe("tu-ws-2");
  });
});

// ─── Session not found scenarios ──────────────────────────────────────────────

describe("Session not found scenarios", () => {
  it("handleCLIMessage does nothing for unknown session", async () => {
    const cli = makeCliSocket("unknown-session");
    // Do NOT call handleCLIOpen — session does not exist in the bridge

    // Should not throw (async — just await it directly)
    await bridge.handleCLIMessage(cli, JSON.stringify({
      type: "tool_progress",
      tool_use_id: "tu-unknown",
      tool_name: "Bash",
      parent_tool_use_id: null,
      elapsed_time_seconds: 1,
      uuid: "uuid-unknown",
      session_id: "unknown-session",
    }));

    // Session should not have been created
    expect(bridge.getSession("unknown-session")).toBeUndefined();
  });

  it("handleCLIClose does nothing for unknown session", () => {
    const cli = makeCliSocket("nonexistent");

    expect(() => {
      bridge.handleCLIClose(cli);
    }).not.toThrow();

    expect(bridge.getSession("nonexistent")).toBeUndefined();
  });

  it("handleBrowserClose does nothing for unknown session", () => {
    const browser = makeBrowserSocket("nonexistent");

    expect(() => {
      bridge.handleBrowserClose(browser);
    }).not.toThrow();

    expect(bridge.getSession("nonexistent")).toBeUndefined();
  });

  it("handleBrowserMessage does nothing for unknown session", () => {
    const browser = makeBrowserSocket("nonexistent");

    expect(() => {
      bridge.handleBrowserMessage(browser, JSON.stringify({
        type: "user_message",
        content: "hello",
      }));
    }).not.toThrow();

    expect(bridge.getSession("nonexistent")).toBeUndefined();
  });
});

// ─── Restore from disk with pendingPermissions ───────────────────────────────

describe("Restore from disk with pendingPermissions", () => {
  it("restores sessions with pending permissions as a Map", () => {
    const pendingPerms: [string, any][] = [
      ["req-restored-1", {
        request_id: "req-restored-1",
        tool_name: "Bash",
        input: { command: "rm -rf /tmp/test" },
        tool_use_id: "tu-restored-1",
        timestamp: 1700000000000,
      }],
      ["req-restored-2", {
        request_id: "req-restored-2",
        tool_name: "Edit",
        input: { file_path: "/test.ts" },
        description: "Edit file",
        tool_use_id: "tu-restored-2",
        agent_id: "agent-1",
        timestamp: 1700000001000,
      }],
    ];

    store.saveSync({
      id: "perm-session",
      state: {
        session_id: "perm-session",
        model: "claude-sonnet-4-6",
        cwd: "/test",
        tools: ["Bash", "Edit"],
        permissionMode: "default",
        claude_code_version: "1.0",
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
      pendingPermissions: pendingPerms,
    });

    const count = bridge.restoreFromDisk();
    expect(count).toBe(1);

    const session = bridge.getSession("perm-session")!;
    expect(session.pendingPermissions).toBeInstanceOf(Map);
    expect(session.pendingPermissions.size).toBe(2);

    const perm1 = session.pendingPermissions.get("req-restored-1")!;
    expect(perm1.tool_name).toBe("Bash");
    expect(perm1.input).toEqual({ command: "rm -rf /tmp/test" });
    expect(perm1.tool_use_id).toBe("tu-restored-1");
    expect(perm1.timestamp).toBe(1700000000000);

    const perm2 = session.pendingPermissions.get("req-restored-2")!;
    expect(perm2.tool_name).toBe("Edit");
    expect(perm2.description).toBe("Edit file");
    expect(perm2.agent_id).toBe("agent-1");
  });

  it("restored pending permissions are sent to newly connected browsers", () => {
    store.saveSync({
      id: "perm-replay",
      state: {
        session_id: "perm-replay",
        model: "claude-sonnet-4-6",
        cwd: "/test",
        tools: ["Bash"],
        permissionMode: "default",
        claude_code_version: "1.0",
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
      pendingPermissions: [
        ["req-replay", {
          request_id: "req-replay",
          tool_name: "Bash",
          input: { command: "echo test" },
          tool_use_id: "tu-replay",
          timestamp: 1700000000000,
        }],
      ],
    });

    bridge.restoreFromDisk();

    // Connect a CLI so we don't trigger relaunch
    const cli = makeCliSocket("perm-replay");
    bridge.handleCLIOpen(cli, "perm-replay");

    // Now connect a browser
    const browser = makeBrowserSocket("perm-replay");
    bridge.handleBrowserOpen(browser, "perm-replay");

    const calls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    const permMsg = calls.find((c: any) => c.type === "permission_request");
    expect(permMsg).toBeDefined();
    expect(permMsg.request.request_id).toBe("req-replay");
    expect(permMsg.request.tool_name).toBe("Bash");
    expect(permMsg.request.input).toEqual({ command: "echo test" });
  });

  it("restores sessions with empty pendingPermissions array", () => {
    store.saveSync({
      id: "empty-perms",
      state: {
        session_id: "empty-perms",
        model: "claude-sonnet-4-6",
        cwd: "/test",
        tools: [],
        permissionMode: "default",
        claude_code_version: "1.0",
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
    });

    const count = bridge.restoreFromDisk();
    expect(count).toBe(1);

    const session = bridge.getSession("empty-perms")!;
    expect(session.pendingPermissions).toBeInstanceOf(Map);
    expect(session.pendingPermissions.size).toBe(0);
  });

  it("restores sessions with undefined pendingPermissions", () => {
    // Simulate a persisted session from an older version that lacks pendingPermissions
    store.saveSync({
      id: "no-perms-field",
      state: {
        session_id: "no-perms-field",
        model: "claude-sonnet-4-6",
        cwd: "/test",
        tools: [],
        permissionMode: "default",
        claude_code_version: "1.0",
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
      // Cast to bypass TypeScript — simulating missing field from older persisted data
      pendingPermissions: undefined as any,
    });

    const count = bridge.restoreFromDisk();
    expect(count).toBe(1);

    const session = bridge.getSession("no-perms-field")!;
    expect(session.pendingPermissions).toBeInstanceOf(Map);
    expect(session.pendingPermissions.size).toBe(0);
  });
});

// ─── First turn callback ──────────────────────────────────────────────────────

describe("onFirstTurnCompletedCallback", () => {
  it("fires on first successful result regardless of num_turns", async () => {
    const callback = vi.fn();
    companionBus.on("session:first-turn-completed", ({ sessionId, firstUserMessage }) => callback(sessionId, firstUserMessage));

    const cli = makeCliSocket("s1");
    bridge.handleCLIOpen(cli, "s1");
    await bridge.handleCLIMessage(cli, makeInitMsg());

    // Simulate a browser sending a user message
    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");
    bridge.handleBrowserMessage(browser, JSON.stringify({
      type: "user_message",
      content: "Fix the login bug",
    }));

    // Simulate the result — num_turns is 5 because CLI auto-approved tool calls
    await bridge.handleCLIMessage(cli, JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "Done",
      duration_ms: 1000,
      duration_api_ms: 800,
      num_turns: 5,
      total_cost_usd: 0.01,
      stop_reason: "end_turn",
      usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      uuid: "uuid-first",
      session_id: "s1",
    }));

    expect(callback).toHaveBeenCalledWith("s1", "Fix the login bug");
  });

  it("does not fire on subsequent results for the same session", async () => {
    const callback = vi.fn();
    companionBus.on("session:first-turn-completed", ({ sessionId, firstUserMessage }) => callback(sessionId, firstUserMessage));

    const cli = makeCliSocket("s1");
    bridge.handleCLIOpen(cli, "s1");
    await bridge.handleCLIMessage(cli, makeInitMsg());

    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");
    bridge.handleBrowserMessage(browser, JSON.stringify({
      type: "user_message",
      content: "First message",
    }));

    // First result — triggers callback
    await bridge.handleCLIMessage(cli, JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      duration_ms: 1000,
      duration_api_ms: 800,
      num_turns: 3,
      total_cost_usd: 0.05,
      stop_reason: "end_turn",
      usage: { input_tokens: 500, output_tokens: 200, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      uuid: "uuid-first",
      session_id: "s1",
    }));

    expect(callback).toHaveBeenCalledTimes(1);

    // Second user message + result — should NOT trigger callback again
    bridge.handleBrowserMessage(browser, JSON.stringify({
      type: "user_message",
      content: "Second message",
    }));
    await bridge.handleCLIMessage(cli, JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      duration_ms: 1000,
      duration_api_ms: 800,
      num_turns: 6,
      total_cost_usd: 0.10,
      stop_reason: "end_turn",
      usage: { input_tokens: 800, output_tokens: 300, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      uuid: "uuid-second",
      session_id: "s1",
    }));

    expect(callback).toHaveBeenCalledTimes(1);
  });

  it("does not fire on error results", async () => {
    const callback = vi.fn();
    companionBus.on("session:first-turn-completed", ({ sessionId, firstUserMessage }) => callback(sessionId, firstUserMessage));

    const cli = makeCliSocket("s1");
    bridge.handleCLIOpen(cli, "s1");
    await bridge.handleCLIMessage(cli, makeInitMsg());

    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");
    bridge.handleBrowserMessage(browser, JSON.stringify({
      type: "user_message",
      content: "Some request",
    }));

    await bridge.handleCLIMessage(cli, JSON.stringify({
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      errors: ["Something went wrong"],
      duration_ms: 500,
      duration_api_ms: 400,
      num_turns: 1,
      total_cost_usd: 0.005,
      stop_reason: null,
      usage: { input_tokens: 50, output_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      uuid: "uuid-err",
      session_id: "s1",
    }));

    expect(callback).not.toHaveBeenCalled();
  });

  it("fires after initial error result followed by a successful result", async () => {
    const callback = vi.fn();
    companionBus.on("session:first-turn-completed", ({ sessionId, firstUserMessage }) => callback(sessionId, firstUserMessage));

    const cli = makeCliSocket("s1");
    bridge.handleCLIOpen(cli, "s1");
    await bridge.handleCLIMessage(cli, makeInitMsg());

    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");
    bridge.handleBrowserMessage(browser, JSON.stringify({
      type: "user_message",
      content: "Fix the bug",
    }));

    // First result is an error — should NOT trigger
    await bridge.handleCLIMessage(cli, JSON.stringify({
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      errors: ["Oops"],
      duration_ms: 100,
      duration_api_ms: 50,
      num_turns: 1,
      total_cost_usd: 0.001,
      stop_reason: null,
      usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      uuid: "uuid-err",
      session_id: "s1",
    }));
    expect(callback).not.toHaveBeenCalled();

    // Second result is success — should trigger since no successful result yet
    await bridge.handleCLIMessage(cli, JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "Done",
      duration_ms: 500,
      duration_api_ms: 400,
      num_turns: 3,
      total_cost_usd: 0.01,
      stop_reason: "end_turn",
      usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      uuid: "uuid-ok",
      session_id: "s1",
    }));
    expect(callback).toHaveBeenCalledWith("s1", "Fix the bug");
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it("does not fire when there is no user message in history", async () => {
    const callback = vi.fn();
    companionBus.on("session:first-turn-completed", ({ sessionId, firstUserMessage }) => callback(sessionId, firstUserMessage));

    const cli = makeCliSocket("s1");
    bridge.handleCLIOpen(cli, "s1");
    await bridge.handleCLIMessage(cli, makeInitMsg());

    // Send result without any user message first
    await bridge.handleCLIMessage(cli, JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "Done",
      duration_ms: 100,
      duration_api_ms: 50,
      num_turns: 1,
      total_cost_usd: 0.001,
      stop_reason: "end_turn",
      usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      uuid: "uuid-1",
      session_id: "s1",
    }));

    expect(callback).not.toHaveBeenCalled();
  });

  it("fires independently for different sessions", async () => {
    const callback = vi.fn();
    companionBus.on("session:first-turn-completed", ({ sessionId, firstUserMessage }) => callback(sessionId, firstUserMessage));

    // Setup session 1
    const cli1 = makeCliSocket("s1");
    bridge.handleCLIOpen(cli1, "s1");
    await bridge.handleCLIMessage(cli1, makeInitMsg());
    const browser1 = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser1, "s1");
    bridge.handleBrowserMessage(browser1, JSON.stringify({
      type: "user_message",
      content: "Message for s1",
    }));

    // Setup session 2
    const cli2 = makeCliSocket("s2");
    bridge.handleCLIOpen(cli2, "s2");
    await bridge.handleCLIMessage(cli2, makeInitMsg());
    const browser2 = makeBrowserSocket("s2");
    bridge.handleBrowserOpen(browser2, "s2");
    bridge.handleBrowserMessage(browser2, JSON.stringify({
      type: "user_message",
      content: "Message for s2",
    }));

    // Result for s1
    await bridge.handleCLIMessage(cli1, JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      duration_ms: 100,
      duration_api_ms: 50,
      num_turns: 2,
      total_cost_usd: 0.01,
      stop_reason: "end_turn",
      usage: { input_tokens: 50, output_tokens: 25, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      uuid: "uuid-s1",
      session_id: "s1",
    }));

    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledWith("s1", "Message for s1");

    // Result for s2 — should also fire (independent session)
    await bridge.handleCLIMessage(cli2, JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      duration_ms: 100,
      duration_api_ms: 50,
      num_turns: 4,
      total_cost_usd: 0.02,
      stop_reason: "end_turn",
      usage: { input_tokens: 80, output_tokens: 40, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      uuid: "uuid-s2",
      session_id: "s2",
    }));

    expect(callback).toHaveBeenCalledTimes(2);
    expect(callback).toHaveBeenCalledWith("s2", "Message for s2");
  });

  it("cleans up auto-naming tracking when session is removed", async () => {
    const callback = vi.fn();
    companionBus.on("session:first-turn-completed", ({ sessionId, firstUserMessage }) => callback(sessionId, firstUserMessage));

    const cli = makeCliSocket("s1");
    bridge.handleCLIOpen(cli, "s1");
    await bridge.handleCLIMessage(cli, makeInitMsg());
    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");
    bridge.handleBrowserMessage(browser, JSON.stringify({
      type: "user_message",
      content: "Hello",
    }));

    // First result triggers callback
    await bridge.handleCLIMessage(cli, JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      duration_ms: 100,
      duration_api_ms: 50,
      num_turns: 1,
      total_cost_usd: 0.01,
      stop_reason: "end_turn",
      usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      uuid: "uuid-1",
      session_id: "s1",
    }));
    expect(callback).toHaveBeenCalledTimes(1);

    // Remove and recreate the session
    bridge.removeSession("s1");
    const cli2 = makeCliSocket("s1");
    bridge.handleCLIOpen(cli2, "s1");
    await bridge.handleCLIMessage(cli2, makeInitMsg());
    const browser2 = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser2, "s1");
    bridge.handleBrowserMessage(browser2, JSON.stringify({
      type: "user_message",
      content: "Hello again",
    }));

    // Should fire again for the recreated session
    await bridge.handleCLIMessage(cli2, JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      duration_ms: 100,
      duration_api_ms: 50,
      num_turns: 2,
      total_cost_usd: 0.01,
      stop_reason: "end_turn",
      usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      uuid: "uuid-2",
      session_id: "s1",
    }));
    expect(callback).toHaveBeenCalledTimes(2);
    expect(callback).toHaveBeenLastCalledWith("s1", "Hello again");
  });

  it("cleans up auto-naming tracking when session is closed", async () => {
    const callback = vi.fn();
    companionBus.on("session:first-turn-completed", ({ sessionId, firstUserMessage }) => callback(sessionId, firstUserMessage));

    const cli = makeCliSocket("s1");
    bridge.handleCLIOpen(cli, "s1");
    await bridge.handleCLIMessage(cli, makeInitMsg());
    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");
    bridge.handleBrowserMessage(browser, JSON.stringify({
      type: "user_message",
      content: "First session",
    }));

    // Trigger callback
    await bridge.handleCLIMessage(cli, JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      duration_ms: 100,
      duration_api_ms: 50,
      num_turns: 1,
      total_cost_usd: 0.01,
      stop_reason: "end_turn",
      usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      uuid: "uuid-1",
      session_id: "s1",
    }));
    expect(callback).toHaveBeenCalledTimes(1);

    // Close session (should clean up tracking)
    bridge.closeSession("s1");

    // Recreate and verify callback fires again
    const cli2 = makeCliSocket("s1");
    bridge.handleCLIOpen(cli2, "s1");
    await bridge.handleCLIMessage(cli2, makeInitMsg());
    const browser2 = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser2, "s1");
    bridge.handleBrowserMessage(browser2, JSON.stringify({
      type: "user_message",
      content: "Second session",
    }));
    await bridge.handleCLIMessage(cli2, JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      duration_ms: 100,
      duration_api_ms: 50,
      num_turns: 1,
      total_cost_usd: 0.01,
      stop_reason: "end_turn",
      usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      uuid: "uuid-2",
      session_id: "s1",
    }));
    expect(callback).toHaveBeenCalledTimes(2);
  });

  it("does not fire for restored sessions with completed turns", async () => {
    const callback = vi.fn();
    companionBus.on("session:first-turn-completed", ({ sessionId, firstUserMessage }) => callback(sessionId, firstUserMessage));

    // Persist a session with num_turns > 0 and a user message in history
    store.save({
      id: "restored-1",
      state: {
        session_id: "restored-1",
        model: "claude-sonnet-4-6",
        cwd: "/test",
        tools: [],
        permissionMode: "default",
        claude_code_version: "1.0",
        mcp_servers: [],
        agents: [],
        slash_commands: [],
        skills: [],
        total_cost_usd: 0.01,
        num_turns: 3,
        context_used_percent: 10,
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
      messageHistory: [
        { type: "user_message" as const, content: "Build the app", timestamp: Date.now() },
      ],
      pendingMessages: [],
      pendingPermissions: [],
    });

    // Restore from disk — this should mark the session as auto-naming attempted
    bridge.restoreFromDisk();

    // CLI reconnects
    const cli = makeCliSocket("restored-1");
    bridge.handleCLIOpen(cli, "restored-1");

    // Another result comes in — should NOT trigger callback
    await bridge.handleCLIMessage(cli, JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      duration_ms: 200,
      duration_api_ms: 150,
      num_turns: 5,
      total_cost_usd: 0.02,
      stop_reason: "end_turn",
      usage: { input_tokens: 200, output_tokens: 100, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      uuid: "uuid-restored",
      session_id: "restored-1",
    }));

    expect(callback).not.toHaveBeenCalled();
  });

  it("allows auto-naming for restored sessions with zero turns", async () => {
    const callback = vi.fn();
    companionBus.on("session:first-turn-completed", ({ sessionId, firstUserMessage }) => callback(sessionId, firstUserMessage));

    // Persist a session with num_turns === 0 (brand new, never completed a turn)
    store.save({
      id: "fresh-restored",
      state: {
        session_id: "fresh-restored",
        model: "claude-sonnet-4-6",
        cwd: "/test",
        tools: [],
        permissionMode: "default",
        claude_code_version: "1.0",
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
    });

    bridge.restoreFromDisk();

    // CLI connects and browser sends message
    const cli = makeCliSocket("fresh-restored");
    bridge.handleCLIOpen(cli, "fresh-restored");
    await bridge.handleCLIMessage(cli, makeInitMsg());
    const browser = makeBrowserSocket("fresh-restored");
    bridge.handleBrowserOpen(browser, "fresh-restored");
    bridge.handleBrowserMessage(browser, JSON.stringify({
      type: "user_message",
      content: "Hello world",
    }));

    await bridge.handleCLIMessage(cli, JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      duration_ms: 100,
      duration_api_ms: 50,
      num_turns: 2,
      total_cost_usd: 0.01,
      stop_reason: "end_turn",
      usage: { input_tokens: 50, output_tokens: 25, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      uuid: "uuid-fresh",
      session_id: "fresh-restored",
    }));

    expect(callback).toHaveBeenCalledWith("fresh-restored", "Hello world");
  });
});

// ─── broadcastNameUpdate ──────────────────────────────────────────────────────

describe("broadcastNameUpdate", () => {
  it("sends session_name_update to connected browsers", () => {
    const cli = makeCliSocket("s1");
    bridge.handleCLIOpen(cli, "s1");

    const browser1 = makeBrowserSocket("s1");
    const browser2 = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser1, "s1");
    bridge.handleBrowserOpen(browser2, "s1");

    bridge.broadcastNameUpdate("s1", "Fix Auth Bug");

    const calls1 = browser1.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    const calls2 = browser2.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    expect(calls1).toContainEqual(expect.objectContaining({ type: "session_name_update", name: "Fix Auth Bug" }));
    expect(calls2).toContainEqual(expect.objectContaining({ type: "session_name_update", name: "Fix Auth Bug" }));
  });

  it("does nothing for unknown sessions", async () => {
    // Should not throw
    bridge.broadcastNameUpdate("nonexistent", "Name");
  });
});

// ─── MCP Control Messages ────────────────────────────────────────────────────

describe("MCP control messages", () => {
  let cli: ReturnType<typeof makeCliSocket>;
  let browser: ReturnType<typeof makeBrowserSocket>;

  beforeEach(async () => {
    cli = makeCliSocket("s1");
    browser = makeBrowserSocket("s1");
    bridge.handleCLIOpen(cli, "s1");
    bridge.handleBrowserOpen(browser, "s1");
    await bridge.handleCLIMessage(cli, makeInitMsg());
    cli.send.mockClear();
    browser.send.mockClear();
  });

  it("mcp_get_status: sends mcp_status control_request to CLI", () => {
    bridge.handleBrowserMessage(browser, JSON.stringify({
      type: "mcp_get_status",
    }));

    expect(cli.send).toHaveBeenCalledTimes(1);
    const sentRaw = cli.send.mock.calls[0][0] as string;
    const sent = JSON.parse(sentRaw.trim());
    expect(sent.type).toBe("control_request");
    expect(sent.request_id).toBe("test-uuid");
    expect(sent.request.subtype).toBe("mcp_status");
  });

  it("mcp_toggle: sends mcp_toggle control_request to CLI", () => {
    // Use vi.useFakeTimers to prevent the delayed mcp_get_status
    vi.useFakeTimers();
    bridge.handleBrowserMessage(browser, JSON.stringify({
      type: "mcp_toggle",
      serverName: "my-server",
      enabled: false,
    }));

    expect(cli.send).toHaveBeenCalledTimes(1);
    const sentRaw = cli.send.mock.calls[0][0] as string;
    const sent = JSON.parse(sentRaw.trim());
    expect(sent.type).toBe("control_request");
    expect(sent.request.subtype).toBe("mcp_toggle");
    expect(sent.request.serverName).toBe("my-server");
    expect(sent.request.enabled).toBe(false);
    vi.useRealTimers();
  });

  it("mcp_reconnect: sends mcp_reconnect control_request to CLI", () => {
    vi.useFakeTimers();
    bridge.handleBrowserMessage(browser, JSON.stringify({
      type: "mcp_reconnect",
      serverName: "failing-server",
    }));

    expect(cli.send).toHaveBeenCalledTimes(1);
    const sentRaw = cli.send.mock.calls[0][0] as string;
    const sent = JSON.parse(sentRaw.trim());
    expect(sent.type).toBe("control_request");
    expect(sent.request.subtype).toBe("mcp_reconnect");
    expect(sent.request.serverName).toBe("failing-server");
    vi.useRealTimers();
  });

  it("control_response for mcp_status: broadcasts mcp_status to browsers", async () => {
    // Send mcp_get_status to create the pending request
    bridge.handleBrowserMessage(browser, JSON.stringify({
      type: "mcp_get_status",
    }));
    browser.send.mockClear();

    // Simulate CLI responding with control_response
    const mockServers = [
      {
        name: "test-server",
        status: "connected",
        config: { type: "stdio", command: "node", args: ["server.js"] },
        scope: "project",
        tools: [{ name: "myTool" }],
      },
    ];

    await bridge.handleCLIMessage(cli, JSON.stringify({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: "test-uuid",
        response: { mcpServers: mockServers },
      },
    }));

    expect(browser.send).toHaveBeenCalledTimes(1);
    const browserMsg = JSON.parse(browser.send.mock.calls[0][0] as string);
    expect(browserMsg.type).toBe("mcp_status");
    expect(browserMsg.servers).toHaveLength(1);
    expect(browserMsg.servers[0].name).toBe("test-server");
    expect(browserMsg.servers[0].status).toBe("connected");
    expect(browserMsg.servers[0].tools).toHaveLength(1);
  });

  it("control_response with error: resolves pending callback and broadcasts mcp_status", async () => {
    // Issue #5 (cubic-ai PR #652): error control_responses now resolve the
    // pending callback. For mcp_status, this emits mcp_status with servers: [].
    bridge.handleBrowserMessage(browser, JSON.stringify({
      type: "mcp_get_status",
    }));
    browser.send.mockClear();

    await bridge.handleCLIMessage(cli, JSON.stringify({
      type: "control_response",
      response: {
        subtype: "error",
        request_id: "test-uuid",
        error: "MCP not available",
      },
    }));

    // The pending resolve IS called, which for mcp_status emits
    // mcp_status with an empty server list to browsers.
    expect(browser.send).toHaveBeenCalledTimes(1);
    const sent = JSON.parse(browser.send.mock.calls[0][0]);
    expect(sent.type).toBe("mcp_status");
    expect(sent.servers).toEqual([]);
  });

  it("control_response for unknown request_id: ignored silently", async () => {
    await bridge.handleCLIMessage(cli, JSON.stringify({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: "unknown-id",
        response: { mcpServers: [] },
      },
    }));

    // Should not throw and not send anything
    expect(browser.send).not.toHaveBeenCalled();
  });

  it("mcp_set_servers: sends mcp_set_servers control_request to CLI", () => {
    vi.useFakeTimers();
    const servers = {
      "my-notes": {
        type: "stdio" as const,
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-memory"],
      },
    };
    bridge.handleBrowserMessage(browser, JSON.stringify({
      type: "mcp_set_servers",
      servers,
    }));

    expect(cli.send).toHaveBeenCalledTimes(1);
    const sentRaw = cli.send.mock.calls[0][0] as string;
    const sent = JSON.parse(sentRaw.trim());
    expect(sent.type).toBe("control_request");
    expect(sent.request.subtype).toBe("mcp_set_servers");
    expect(sent.request.servers).toEqual(servers);
    vi.useRealTimers();
  });
});

// ─── Per-session listener error handling ────────────────────────────────────

describe("per-session listener error handling", () => {
  it("catches and logs errors thrown by assistant message listeners", async () => {
    // A throwing listener registered on the event bus should not crash
    // the message pipeline or prevent persistSession from running.
    // The EventBus catches handler errors and logs them.
    const sessionId = "listener-error-session";
    const cli = makeCliSocket(sessionId);
    bridge.handleCLIOpen(cli, sessionId);
    await bridge.handleCLIMessage(cli, makeInitMsg());

    const browser = makeBrowserSocket(sessionId);
    bridge.handleBrowserOpen(browser, sessionId);

    // Register a throwing listener via the event bus
    const throwingCb = () => { throw new Error("listener boom"); };
    companionBus.on("message:assistant", ({ sessionId: sid, message }) => {
      if (sid === sessionId) throwingCb();
    });

    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    // Send an assistant message — should not throw
    const assistantMsg = JSON.stringify({
      type: "assistant",
      message: { id: "m1", type: "message", role: "assistant", content: [{ type: "text", text: "hi" }], model: "test", stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } },
    });
    await bridge.handleCLIMessage(cli, assistantMsg);

    expect(spy).toHaveBeenCalledWith(
      expect.stringContaining("Handler error"),
      expect.any(Error),
    );

    spy.mockRestore();
  });

  it("catches and logs errors from async result listeners", async () => {
    // A sync-throwing result listener registered on the event bus should
    // have its error caught and logged, not become an unhandled exception.
    const sessionId = "async-listener-session";
    const cli = makeCliSocket(sessionId);
    bridge.handleCLIOpen(cli, sessionId);
    await bridge.handleCLIMessage(cli, makeInitMsg());

    const browser = makeBrowserSocket(sessionId);
    bridge.handleBrowserOpen(browser, sessionId);

    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    // Register a sync-throwing listener for result via the event bus
    const throwingCb = () => { throw new Error("result listener boom"); };
    companionBus.on("message:result", ({ sessionId: sid, message }) => {
      if (sid === sessionId) throwingCb();
    });

    // Send a result message
    const resultMsg = JSON.stringify({
      type: "result",
      data: { subtype: "success" },
      total_cost_usd: 0.01,
      num_turns: 1,
      is_error: false,
    });
    await bridge.handleCLIMessage(cli, resultMsg);

    expect(spy).toHaveBeenCalledWith(
      expect.stringContaining("Handler error"),
      expect.any(Error),
    );

    spy.mockRestore();
  });

  it("catches and logs errors thrown by stream event listeners", async () => {
    const sessionId = "stream-listener-error-session";
    const cli = makeCliSocket(sessionId);
    bridge.handleCLIOpen(cli, sessionId);
    await bridge.handleCLIMessage(cli, makeInitMsg());

    const browser = makeBrowserSocket(sessionId);
    bridge.handleBrowserOpen(browser, sessionId);

    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    companionBus.on("message:stream_event", ({ sessionId: sid }) => {
      if (sid === sessionId) {
        throw new Error("stream listener boom");
      }
    });

    await bridge.handleCLIMessage(cli, JSON.stringify({
      type: "stream_event",
      event: { type: "content_block_delta", delta: { type: "text_delta", text: "hi" } },
      parent_tool_use_id: null,
      uuid: "stream-listener-uuid-1",
      session_id: sessionId,
    }));

    expect(spy).toHaveBeenCalledWith(
      expect.stringContaining("Handler error"),
      expect.any(Error),
    );

    spy.mockRestore();
  });
});

// ─── sendToCLI error handling ──────────────────────────────────────────────

describe("sendToCLI error path", () => {
  it("logs error when CLI socket send throws", async () => {
    // When the CLI socket's send() throws (e.g. socket already closed),
    // sendToCLI should catch the error and log it rather than crashing.
    const sessionId = "send-error-session";

    const cli = makeCliSocket(sessionId);
    bridge.handleCLIOpen(cli, sessionId);

    // Send a system.init to fully connect the session
    const initMsg = makeInitMsg();
    await bridge.handleCLIMessage(cli, initMsg);

    // Now make send() throw to simulate a broken socket
    cli.send.mockImplementation(() => {
      throw new Error("Socket is closed");
    });

    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    // Inject a user message which calls sendToCLI internally
    bridge.injectUserMessage(sessionId, "test message");

    // The error should be caught and logged, not thrown
    expect(spy).toHaveBeenCalledWith(
      expect.stringContaining("Failed to send to CLI"),
      expect.any(Error),
    );

    spy.mockRestore();
  });
});

// ─── CLI message deduplication (Bun.hash-based) ─────────────────────────────

describe("CLI message deduplication", () => {
  async function setupSession() {
    const cli = makeCliSocket("s1");
    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");
    bridge.handleCLIOpen(cli, "s1");
    await bridge.handleCLIMessage(cli, makeInitMsg());
    browser.send.mockClear();
    return { cli, browser };
  }

  it("filters duplicate assistant messages (same content replayed on reconnect)", async () => {
    const { cli, browser } = await setupSession();
    const msg = JSON.stringify({ type: "assistant", message: { content: "hello world" } });

    // First send — should forward to browser
    await bridge.handleCLIMessage(cli, msg);
    expect(browser.send).toHaveBeenCalledTimes(1);

    // Same message again (simulates CLI replay on WS reconnect) — should be filtered
    browser.send.mockClear();
    await bridge.handleCLIMessage(cli, msg);
    expect(browser.send).not.toHaveBeenCalled();
  });

  it("forwards non-duplicate assistant messages normally", async () => {
    const { cli, browser } = await setupSession();
    const msg1 = JSON.stringify({ type: "assistant", message: { content: "first" } });
    const msg2 = JSON.stringify({ type: "assistant", message: { content: "second" } });

    await bridge.handleCLIMessage(cli, msg1);
    await bridge.handleCLIMessage(cli, msg2);

    expect(browser.send).toHaveBeenCalledTimes(2);
  });

  it("evicts oldest hashes when window is exceeded", async () => {
    const { cli, browser } = await setupSession();

    // Send CLI_DEDUP_WINDOW + 1 unique messages to push the first one out
    const WINDOW = 2000; // matches WsBridge.CLI_DEDUP_WINDOW
    for (let i = 0; i <= WINDOW; i++) {
      await bridge.handleCLIMessage(
        cli,
        JSON.stringify({ type: "assistant", message: { content: `msg-${i}` } }),
      );
    }

    // The first message's hash should have been evicted — resending it should work
    browser.send.mockClear();
    const firstMsg = JSON.stringify({ type: "assistant", message: { content: "msg-0" } });
    await bridge.handleCLIMessage(cli, firstMsg);
    expect(browser.send).toHaveBeenCalledTimes(1);
  });

  it("deduplicates stream_event messages with the same uuid on reconnect replay", async () => {
    const { cli, browser } = await setupSession();
    const uuid = "cc6aeb12-1aad-4126-8ad2-03bad206e9fe";
    const msg = JSON.stringify({
      type: "stream_event",
      event: { type: "content_block_delta", delta: { type: "thinking_delta", text: "thinking..." } },
      parent_tool_use_id: null,
      uuid,
      session_id: "test-cli-session",
    });

    // First send — should forward to browser
    await bridge.handleCLIMessage(cli, msg);
    expect(browser.send).toHaveBeenCalledTimes(1);

    // Same uuid again (simulates CLI replay on WS reconnect) — should be filtered
    browser.send.mockClear();
    await bridge.handleCLIMessage(cli, msg);
    expect(browser.send).not.toHaveBeenCalled();
  });

  it("forwards stream_event messages without uuid (no dedup possible)", async () => {
    const { cli, browser } = await setupSession();
    // stream_event without uuid — cannot dedup, must forward
    const msg = JSON.stringify({
      type: "stream_event",
      event: { type: "content_block_delta", delta: { type: "text_delta", text: "hi" } },
      parent_tool_use_id: null,
    });

    await bridge.handleCLIMessage(cli, msg);
    await bridge.handleCLIMessage(cli, msg);

    // Both should be forwarded — no uuid means no dedup
    expect(browser.send).toHaveBeenCalledTimes(2);
  });
});

// ─── Linear session ID mapping ──────────────────────────────────────────────

describe("Linear session ID mapping", () => {
  it("setLinearSessionId sets linearSessionId on session state", () => {
    // Create a session via getOrCreateSession, then call setLinearSessionId
    // and verify the linearSessionId is persisted on the session state.
    bridge.getOrCreateSession("s1");
    const saveSpy = vi.spyOn(store, "save");

    bridge.setLinearSessionId("s1", "linear-abc-123");

    const session = bridge.getSession("s1")!;
    expect(session.state.linearSessionId).toBe("linear-abc-123");

    // Verify persistSession was called (via store.save) to persist the change
    expect(saveSpy).toHaveBeenCalled();
    const lastCall = saveSpy.mock.calls[saveSpy.mock.calls.length - 1][0];
    expect(lastCall.id).toBe("s1");
    expect(lastCall.state.linearSessionId).toBe("linear-abc-123");
  });

  it("setLinearSessionId is a no-op when session does not exist", () => {
    // Calling setLinearSessionId with a non-existent sessionId should not
    // throw an error and should not create a new session.
    const saveSpy = vi.spyOn(store, "save");

    expect(() => {
      bridge.setLinearSessionId("nonexistent-session", "linear-xyz");
    }).not.toThrow();

    // No session should have been created
    expect(bridge.getSession("nonexistent-session")).toBeUndefined();

    // persistSession should NOT have been called since the session doesn't exist
    expect(saveSpy).not.toHaveBeenCalled();
  });

  it("getLinearSessionMappings returns sessions with linearSessionId", () => {
    // Create multiple sessions, set linearSessionId on some of them,
    // and verify only the sessions with a linearSessionId are returned.
    bridge.getOrCreateSession("s1");
    bridge.getOrCreateSession("s2");
    bridge.getOrCreateSession("s3");

    bridge.setLinearSessionId("s1", "linear-aaa");
    bridge.setLinearSessionId("s3", "linear-ccc");
    // s2 intentionally left without a linearSessionId

    const mappings = bridge.getLinearSessionMappings();

    expect(mappings).toHaveLength(2);
    expect(mappings).toEqual(
      expect.arrayContaining([
        { sessionId: "s1", linearSessionId: "linear-aaa" },
        { sessionId: "s3", linearSessionId: "linear-ccc" },
      ]),
    );

    // Verify s2 (which has no linearSessionId) is NOT included
    const s2Mapping = mappings.find((m) => m.sessionId === "s2");
    expect(s2Mapping).toBeUndefined();
  });

  it("getLinearSessionMappings returns empty array when no sessions have linearSessionId", () => {
    // Create sessions without setting any linearSessionId and verify
    // the method returns an empty array.
    bridge.getOrCreateSession("s1");
    bridge.getOrCreateSession("s2");

    const mappings = bridge.getLinearSessionMappings();

    expect(mappings).toEqual([]);
  });
});

// ─── Callback registration coverage ────────────────────────────────────────────

describe("diagnostics and callbacks", () => {
  it("getSessionMemoryStats returns memory stats for all sessions", () => {
    bridge.getOrCreateSession("diag-1");
    bridge.getOrCreateSession("diag-2");

    const stats = bridge.getSessionMemoryStats();
    expect(stats).toHaveLength(2);
    expect(stats[0].id).toBe("diag-1");
    expect(stats[0].browsers).toBe(0);
    expect(stats[0].historyLen).toBe(0);
    expect(stats[1].id).toBe("diag-2");
  });

  it("companionBus message:assistant: unsubscribe function removes the listener", async () => {
    // After event bus migration, per-session listeners are registered via
    // companionBus.on("message:assistant", ...) with a sessionId filter.
    const cli = makeCliSocket("s1");
    const browser = makeBrowserSocket("s1");
    bridge.handleCLIOpen(cli, "s1");
    bridge.handleBrowserOpen(browser, "s1");

    const listener = vi.fn();
    const unsubscribe = companionBus.on("message:assistant", ({ sessionId, message }) => {
      if (sessionId === "s1") listener(message);
    });

    // Send an assistant message — listener should fire
    await bridge.handleCLIMessage(cli, JSON.stringify({
      type: "assistant",
      message: { id: "m1", type: "message", role: "assistant", model: "claude", content: [], stop_reason: "end_turn", usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } },
      parent_tool_use_id: null,
      uuid: "uuid-unsub-1",
      session_id: "s1",
    }));
    expect(listener).toHaveBeenCalledTimes(1);

    // Unsubscribe and send another — listener should NOT fire again
    unsubscribe();
    await bridge.handleCLIMessage(cli, JSON.stringify({
      type: "assistant",
      message: { id: "m2", type: "message", role: "assistant", model: "claude", content: [], stop_reason: "end_turn", usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } },
      parent_tool_use_id: null,
      uuid: "uuid-unsub-2",
      session_id: "s1",
    }));
    expect(listener).toHaveBeenCalledTimes(1); // Still 1 — unsubscribed
  });

  it("companionBus message:result: unsubscribe function removes the listener", async () => {
    // After event bus migration, per-session listeners are registered via
    // companionBus.on("message:result", ...) with a sessionId filter.
    const cli = makeCliSocket("s1");
    const browser = makeBrowserSocket("s1");
    bridge.handleCLIOpen(cli, "s1");
    bridge.handleBrowserOpen(browser, "s1");

    // First send a user message so onFirstTurnCompleted logic works
    bridge.handleBrowserMessage(browser, JSON.stringify({
      type: "user_message", content: "test",
    }));

    const listener = vi.fn();
    const unsubscribe = companionBus.on("message:result", ({ sessionId, message }) => {
      if (sessionId === "s1") listener(message);
    });

    // Send a result message — listener should fire
    await bridge.handleCLIMessage(cli, JSON.stringify({
      type: "result", subtype: "success", is_error: false,
      duration_ms: 100, duration_api_ms: 50, num_turns: 1,
      total_cost_usd: 0.01, stop_reason: "end_turn",
      usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      uuid: "uuid-result-unsub-1", session_id: "s1",
    }));
    expect(listener).toHaveBeenCalledTimes(1);

    // Unsubscribe and send another — listener should NOT fire again
    unsubscribe();
    await bridge.handleCLIMessage(cli, JSON.stringify({
      type: "result", subtype: "success", is_error: false,
      duration_ms: 200, duration_api_ms: 100, num_turns: 2,
      total_cost_usd: 0.02, stop_reason: "end_turn",
      usage: { input_tokens: 20, output_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      uuid: "uuid-result-unsub-2", session_id: "s1",
    }));
    expect(listener).toHaveBeenCalledTimes(1); // Still 1 — unsubscribed
  });

  it("getCodexRateLimits returns null for unknown session", () => {
    // Covers the early-return path when session doesn't exist.
    expect(bridge.getCodexRateLimits("nonexistent")).toBeNull();
  });

  it("getCodexRateLimits returns null when no codex adapter", () => {
    // Covers the path where session exists but has no codex adapter.
    bridge.getOrCreateSession("no-adapter");
    expect(bridge.getCodexRateLimits("no-adapter")).toBeNull();
  });

  it("broadcastToSession is a no-op for unknown session", () => {
    // Covers the early-return path when session doesn't exist.
    expect(() => bridge.broadcastToSession("nonexistent", { type: "cli_connected" })).not.toThrow();
  });

  it("broadcastToSession sends to connected browsers", () => {
    // Covers the happy path: session exists and has browsers.
    const browser = makeBrowserSocket("bcast");
    bridge.getOrCreateSession("bcast");
    bridge.handleBrowserOpen(browser, "bcast");
    bridge.broadcastToSession("bcast", { type: "cli_connected" });
    expect(browser.send).toHaveBeenCalled();
  });

  it("setRecorder stores the recorder reference", () => {
    // Covers the setRecorder setter (line 165).
    const fakeRecorder = { start: vi.fn(), stop: vi.fn() } as any;
    bridge.setRecorder(fakeRecorder);
    expect((bridge as any).recorder).toBe(fakeRecorder);
  });
});

// ─── set_ai_validation browser message ──────────────────────────────────────

describe("set_ai_validation browser message", () => {
  it("updates AI validation settings and broadcasts session_update", () => {
    // When a browser sends set_ai_validation, the bridge should update the
    // session state and broadcast the new settings to all connected browsers.
    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");
    browser.send.mockClear();

    bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "set_ai_validation",
        aiValidationEnabled: true,
        aiValidationAutoApprove: true,
        aiValidationAutoDeny: false,
      }),
    );

    const session = bridge.getSession("s1")!;
    expect(session.state.aiValidationEnabled).toBe(true);
    expect(session.state.aiValidationAutoApprove).toBe(true);
    expect(session.state.aiValidationAutoDeny).toBe(false);

    // Should have broadcast session_update with the new AI validation settings
    const calls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    const updateMsg = calls.find((c: any) => c.type === "session_update");
    expect(updateMsg).toBeDefined();
    expect(updateMsg.session.aiValidationEnabled).toBe(true);
    expect(updateMsg.session.aiValidationAutoApprove).toBe(true);
    expect(updateMsg.session.aiValidationAutoDeny).toBe(false);
  });

  it("does not forward set_ai_validation to CLI backend", () => {
    // set_ai_validation is a bridge-level message that should never be
    // sent to the CLI. Verify the CLI socket does not receive it.
    const cli = makeCliSocket("s1");
    const browser = makeBrowserSocket("s1");
    bridge.handleCLIOpen(cli, "s1");
    bridge.handleBrowserOpen(browser, "s1");
    cli.send.mockClear();

    bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "set_ai_validation",
        aiValidationEnabled: true,
      }),
    );

    // CLI should not have received any messages after clearing
    const cliCalls = cli.send.mock.calls.map(([arg]: [string]) => arg);
    const aiMsg = cliCalls.find((s: string) => s.includes("set_ai_validation"));
    expect(aiMsg).toBeUndefined();
  });
});

// ─── Idle kill watchdog ─────────────────────────────────────────────────────

describe("Idle kill watchdog", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts watchdog when last browser disconnects and emits idle-kill after threshold", () => {
    // When the last browser disconnects, the bridge should start a periodic
    // idle check. If no CLI activity occurs for IDLE_KILL_THRESHOLD_MS and
    // no browser reconnects, the session:idle-kill event should fire.
    const idleKillHandler = vi.fn();
    companionBus.on("session:idle-kill", idleKillHandler);

    const cli = makeCliSocket("s1");
    const browser = makeBrowserSocket("s1");
    bridge.handleCLIOpen(cli, "s1");
    bridge.handleBrowserOpen(browser, "s1");

    // Disconnect the browser — should start idle watchdog
    bridge.handleBrowserClose(browser);

    // Advance past the idle kill threshold (default 24h) + check interval (60s)
    // The watchdog checks every 60s, so we need to advance enough for:
    // 1) The idle threshold to be exceeded (24h)
    // 2) A check interval to fire
    vi.advanceTimersByTime(24 * 60 * 60_000 + 60_000);

    expect(idleKillHandler).toHaveBeenCalledWith({ sessionId: "s1" });
  });

  it("cancels watchdog when browser reconnects before idle threshold", () => {
    // If a browser reconnects before the idle threshold, the watchdog
    // should be cancelled and no idle-kill event should fire.
    const idleKillHandler = vi.fn();
    companionBus.on("session:idle-kill", idleKillHandler);

    const cli = makeCliSocket("s1");
    const browser1 = makeBrowserSocket("s1");
    bridge.handleCLIOpen(cli, "s1");
    bridge.handleBrowserOpen(browser1, "s1");

    // Disconnect browser — starts watchdog
    bridge.handleBrowserClose(browser1);

    // Advance a bit (5 min) but not past threshold
    vi.advanceTimersByTime(5 * 60_000);

    // Reconnect a browser — should cancel watchdog
    const browser2 = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser2, "s1");

    // Advance well past the 24h threshold
    vi.advanceTimersByTime(25 * 60 * 60_000);

    // Should NOT have triggered idle kill
    expect(idleKillHandler).not.toHaveBeenCalled();
  });

  it("checkIdleKill stops watchdog if session is removed", () => {
    // If the session is removed while the watchdog is running (e.g. user
    // deleted it), the watchdog should clean itself up on the next tick.
    const idleKillHandler = vi.fn();
    companionBus.on("session:idle-kill", idleKillHandler);

    const cli = makeCliSocket("s1");
    const browser = makeBrowserSocket("s1");
    bridge.handleCLIOpen(cli, "s1");
    bridge.handleBrowserOpen(browser, "s1");

    // Disconnect browser — starts watchdog
    bridge.handleBrowserClose(browser);

    // Remove session while watchdog is active
    bridge.removeSession("s1");

    // Advance past 24h threshold + check interval
    vi.advanceTimersByTime(24 * 60 * 60_000 + 60_000);

    // Should NOT fire idle-kill because session was removed
    expect(idleKillHandler).not.toHaveBeenCalled();
  });

  it("checkIdleKill stops watchdog if browser reconnects before check fires", () => {
    // Edge case: browser reconnects between check intervals. The next
    // check should see browserSockets.size > 0 and cancel the watchdog.
    const idleKillHandler = vi.fn();
    companionBus.on("session:idle-kill", idleKillHandler);

    const cli = makeCliSocket("s1");
    const browser1 = makeBrowserSocket("s1");
    bridge.handleCLIOpen(cli, "s1");
    bridge.handleBrowserOpen(browser1, "s1");

    // Disconnect browser
    bridge.handleBrowserClose(browser1);

    // Advance 10 min (past one check interval but under threshold)
    vi.advanceTimersByTime(10 * 60_000);

    // Manually add a browser socket directly to simulate reconnect
    // without calling handleBrowserOpen (which would cancel watchdog)
    const session = bridge.getSession("s1")!;
    const browser2 = makeBrowserSocket("s1");
    session.browserSockets.add(browser2);

    // Advance past 24h threshold
    vi.advanceTimersByTime(24 * 60 * 60_000);

    // Watchdog should have noticed the browser and cancelled itself
    expect(idleKillHandler).not.toHaveBeenCalled();
  });
});

// ─── injectMcpSetServers ────────────────────────────────────────────────────

describe("injectMcpSetServers", () => {
  it("sends mcp_set_servers to backend adapter", () => {
    // When injectMcpSetServers is called on a connected session, it should
    // forward the MCP server configuration to the backend adapter.
    const cli = makeCliSocket("s1");
    bridge.handleCLIOpen(cli, "s1");

    const servers = { "test-mcp": { command: "test-cmd", args: [] } } as any;
    bridge.injectMcpSetServers("s1", servers);

    // The CLI socket should have received the mcp_set_servers message
    const calls = cli.send.mock.calls.map(([arg]: [string]) => arg);
    const mcpMsg = calls.find((s: string) => s.includes("mcp_set_servers"));
    expect(mcpMsg).toBeDefined();
  });

  it("is a no-op for nonexistent session", () => {
    // Should log an error but not throw.
    expect(() => bridge.injectMcpSetServers("nonexistent", {})).not.toThrow();
  });
});

// ─── injectSystemPrompt ─────────────────────────────────────────────────────

describe("injectSystemPrompt", () => {
  it("sends initialize control_request to ClaudeAdapter", () => {
    // When injectSystemPrompt is called on a Claude session, it should
    // send a raw NDJSON control_request with the appendSystemPrompt.
    const cli = makeCliSocket("s1");
    bridge.handleCLIOpen(cli, "s1");

    bridge.injectSystemPrompt("s1", "You are a helpful assistant.");

    // The CLI socket should have received the control_request
    const calls = cli.send.mock.calls.map(([arg]: [string]) => arg);
    const initMsg = calls.find((s: string) => s.includes("appendSystemPrompt"));
    expect(initMsg).toBeDefined();
    const parsed = JSON.parse(initMsg!.trim());
    expect(parsed.type).toBe("control_request");
    expect(parsed.request.subtype).toBe("initialize");
    expect(parsed.request.appendSystemPrompt).toBe("You are a helpful assistant.");
  });

  it("is a no-op for nonexistent session", () => {
    // Should log an error but not throw.
    expect(() => bridge.injectSystemPrompt("nonexistent", "prompt")).not.toThrow();
  });
});

// ─── User message during initialization ──────────────────────────────────────

describe("User message during initializing phase", () => {
  it("transitions to streaming and forwards user_message when session is initializing", () => {
    // Simulate a session where the CLI socket has connected (initializing)
    // but the system.init message hasn't arrived yet (so not "ready").
    // The message should still be forwarded to the adapter's internal queue
    // rather than being dropped, so the user doesn't have to resend.
    const cli = makeCliSocket("s1");
    const browser = makeBrowserSocket("s1");
    bridge.handleCLIOpen(cli, "s1");
    bridge.handleBrowserOpen(browser, "s1");

    // Session should be in "initializing" phase after CLI connects
    const session = bridge.getSession("s1")!;
    expect(session.stateMachine.phase).toBe("initializing");

    // Send a user message while still initializing
    cli.send.mockClear();
    bridge.handleBrowserMessage(browser, JSON.stringify({
      type: "user_message",
      content: "Hello while initializing",
    }));

    // The message IS forwarded to the CLI adapter (which queues internally)
    expect(cli.send).toHaveBeenCalledTimes(1);

    // The message should be in the history (user typed it)
    const userMsgs = session.messageHistory.filter((m) => m.type === "user_message");
    expect(userMsgs.length).toBe(1);

    // State machine transitions to streaming — the adapter queues the
    // message internally until the backend is ready.
    expect(session.stateMachine.phase).toBe("streaming");
  });
});

// ─── IDE binding (Task 6: BIND-01, BIND-02, BIND-04, BIND-06, STATE-01) ──────
//
// These tests pin the bindIde/unbindIde contract on WsBridge.
//
// Test seam: we seed `listAvailableIdes()` by running `startIdeDiscovery` on a
// fresh temp directory and writing real lockfile JSON with our own pid (so
// isPidAlive returns true). That exercises the production discovery path —
// no internal mock — matching how routes/ide-routes.test.ts seeds fixtures.
//
// Adapter seam: we attach a fake IBackendAdapter via attachBackendAdapter and
// capture every .send() call. bindIde must route through session.backendAdapter.send
// with a single {type:"mcp_set_servers", servers:{ide:{...}}} message — never a
// {type:"user_message"} carrying "/ide" (that would leak the slash command into
// the CLI and duplicate the intercept, violating BIND-06).

import {
  startIdeDiscovery as startIdeDiscoveryForBind,
  resetIdeDiscoveryForTests as resetIdeDiscoveryForBind,
  listAvailableIdes as listAvailableIdesForBind,
} from "./ide-discovery.js";
import { writeFileSync as writeFileSyncForBind } from "node:fs";

describe("IDE binding (bindIde / unbindIde)", () => {
  let ideTmpDir: string;
  let stopDiscovery: (() => void) | null = null;

  /** Write a healthy lockfile to the ide dir and wait for discovery to see it. */
  async function seedIde(opts: {
    port: number;
    ideName?: string;
    workspaceFolders?: string[];
    authToken?: string;
    transport?: "ws" | "sse";
  }): Promise<void> {
    const path = join(ideTmpDir, `${opts.port}.lock`);
    writeFileSyncForBind(
      path,
      JSON.stringify({
        pid: process.pid, // our own pid — guaranteed alive
        ideName: opts.ideName ?? "Neovim",
        workspaceFolders: opts.workspaceFolders ?? ["/Users/test/proj"],
        authToken: opts.authToken ?? "tok-xyz",
        transport: opts.transport ?? "ws",
      }),
    );
    // Wait until discovery reflects the new IDE. fs.watch on macOS can lag
    // up to several hundred ms; we poll for up to 4s and fall back to
    // manually restarting discovery (which does a synchronous scan) if the
    // watcher event never fires.
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline) {
      if (listAvailableIdesForBind().some((i) => i.port === opts.port)) return;
      await new Promise((r) => setTimeout(r, 20));
    }
    // Watcher event never fired — force a synchronous rescan via restart.
    if (stopDiscovery) {
      try { stopDiscovery(); } catch { /* ignore */ }
    }
    stopDiscovery = startIdeDiscoveryForBind({ ideDir: ideTmpDir });
    if (listAvailableIdesForBind().some((i) => i.port === opts.port)) return;
    throw new Error(`seedIde: discovery did not pick up port ${opts.port}`);
  }

  /**
   * Walk a deserialized JSON object tree and fail the test if any key named
   * `authToken` is encountered. Used to enforce BIND-03 (authToken never
   * crosses the browser WS boundary).
   */
  function walkAssertNoAuthToken(node: unknown, path: string = "$"): void {
    if (node === null || typeof node !== "object") return;
    if (Array.isArray(node)) {
      node.forEach((v, i) => walkAssertNoAuthToken(v, `${path}[${i}]`));
      return;
    }
    for (const [k, v] of Object.entries(node)) {
      if (k === "authToken") {
        throw new Error(`BIND-03 violation: authToken present at ${path}.${k}`);
      }
      walkAssertNoAuthToken(v, `${path}.${k}`);
    }
  }

  /** Build a fake backend adapter that records every outgoing message. */
  function makeFakeAdapter(): { adapter: any; sendCalls: any[] } {
    const sendCalls: any[] = [];
    const adapter = {
      isConnected: () => true,
      send: (msg: any) => {
        sendCalls.push(msg);
        return true;
      },
      disconnect: async () => {},
      onBrowserMessage: () => {},
      onSessionMeta: () => {},
      onDisconnect: () => {},
      onInitError: () => {},
    };
    return { adapter, sendCalls };
  }

  beforeEach(() => {
    ideTmpDir = mkdtempSync(join(tmpdir(), "ide-bind-"));
    resetIdeDiscoveryForBind();
    // NOTE: the top-level beforeEach (above, outside any describe) creates
    // `bridge = new WsBridge()` and THEN calls companionBus.clear(). The
    // clear() wipes out the constructor's "ide:removed" subscription (the
    // BIND-04 auto-unbind wiring). Re-create the bridge here, AFTER clear,
    // so the subscription is alive for these tests. This is specific to the
    // ordering chosen by the outer setup and does not affect other describes.
    bridge = new WsBridge();
    bridge.setStore(store);
    // startIdeDiscovery populates the internal known-map by scanning ideTmpDir.
    stopDiscovery = startIdeDiscoveryForBind({ ideDir: ideTmpDir });
  });

  afterEach(() => {
    if (stopDiscovery) {
      try { stopDiscovery(); } catch { /* ignore */ }
      stopDiscovery = null;
    }
    resetIdeDiscoveryForBind();
    try { rmSync(ideTmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  // BIND-01 core contract: bindIde must translate into exactly one
  // mcp_set_servers with the IDE server entry keyed by the sanitized ideName.
  // We assert on the PROTOCOL payload, not on a derivative — per the plan,
  // this pins "CLI sees mcp_set_servers, never /ide text".
  //
  // NOTE: The key must NOT be the literal "ide" — see BIND-07 for why.
  // The CLI's _35 filter blocks all mcp__ide__* tools except getDiagnostics
  // and executeCode. Using the sanitized ideName (e.g. "neovim") causes the
  // CLI to prefix tools as mcp__neovim__* which bypasses the filter entirely.
  it("bindIde sends mcp_set_servers with a sanitized-ideName entry containing transport/url/ideName/authToken/scope", async () => {
    await seedIde({ port: 42424, ideName: "Neovim", authToken: "secret-t" });

    const { adapter, sendCalls } = makeFakeAdapter();
    bridge.getOrCreateSession("s1");
    bridge.attachBackendAdapter("s1", adapter, "claude");
    sendCalls.length = 0; // ignore any send that happened during attach

    const result = await bridge.bindIde("s1", 42424);
    expect(result).toEqual({ ok: true });

    // Find the mcp_set_servers call — there should be exactly one.
    const mcpCalls = sendCalls.filter((m) => m.type === "mcp_set_servers");
    expect(mcpCalls).toHaveLength(1);
    const payload = mcpCalls[0];
    // Keyed by `companion-ide-` structural-separator prefix + sanitized
    // ideName (BIND-08 / BIND-08d). The bare "ide" literal was ruled out by
    // BIND-07 (CLI tool filter bypass); the bare "neovim" was ruled out by
    // BIND-08 (namespace collision with user MCP servers); the bare
    // `companionide` prefix was ruled out by BIND-08d (same-namespace
    // collision still possible — hyphens are structurally disjoint).
    const serverEntry = payload.servers["companion-ide-neovim"];
    expect(serverEntry).toBeDefined();
    expect(serverEntry).toMatchObject({
      type: "ws-ide",
      url: "ws://127.0.0.1:42424",
      ideName: "Neovim",
      authToken: "secret-t",
      ideRunningInWindows: false,
      scope: "dynamic",
    });
  });

  // STATE-01 + session_update broadcast contract.
  // ideBinding must land on session.state AND be visible to browsers via the
  // existing session_update channel (never a new variant — plan forbids it).
  it("bindIde sets session.state.ideBinding and broadcasts session_update with the binding", async () => {
    await seedIde({ port: 50001, ideName: "VSCode", workspaceFolders: ["/w/a", "/w/b"] });

    bridge.getOrCreateSession("s1");
    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");
    const { adapter } = makeFakeAdapter();
    bridge.attachBackendAdapter("s1", adapter, "claude");
    browser.send.mockClear();

    const result = await bridge.bindIde("s1", 50001);
    expect(result).toEqual({ ok: true });

    const session = bridge.getSession("s1")!;
    expect(session.state.ideBinding).toMatchObject({
      port: 50001,
      ideName: "VSCode",
      workspaceFolders: ["/w/a", "/w/b"],
      transport: "ws-ide",
      authToken: "tok-xyz",
    });
    expect(typeof session.state.ideBinding?.boundAt).toBe("number");
    expect(session.state.ideBinding?.lockfilePath.endsWith("50001.lock")).toBe(true);

    // At least one session_update broadcast contained ideBinding.
    const broadcasts = browser.send.mock.calls
      .map(([arg]: [string]) => JSON.parse(arg))
      .filter((m: any) => m.type === "session_update");
    const hasBinding = broadcasts.some(
      (m: any) => m.session && m.session.ideBinding && m.session.ideBinding.port === 50001,
    );
    expect(hasBinding).toBe(true);
  });

  // BIND-03 SECURITY: authToken MUST NEVER leak over the browser WebSocket.
  // Spec says it is runtime-only, server-internal (same rule as session-store
  // persistence). If a future refactor re-adds the field to the session_update
  // payload, this test fails loudly with a string match on the raw wire bytes.
  //
  // Regression-guarded by two orthogonal assertions:
  //   (1) Structural — walk the deserialized object tree, assert no authToken key.
  //   (2) String-level — the raw send payload never contains "authToken".
  it("BIND-03: bindIde session_update broadcast never includes authToken (or the string)", async () => {
    await seedIde({ port: 50099, ideName: "Neovim", authToken: "must-not-leak-xyz" });

    const { adapter } = makeFakeAdapter();
    bridge.getOrCreateSession("s1");
    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");
    bridge.attachBackendAdapter("s1", adapter, "claude");
    browser.send.mockClear();

    const result = await bridge.bindIde("s1", 50099);
    expect(result).toEqual({ ok: true });

    // (1) Structural walk across all outbound browser messages.
    const allBroadcasts = browser.send.mock.calls.map(
      ([arg]: [string]) => JSON.parse(arg),
    );
    for (const msg of allBroadcasts) {
      walkAssertNoAuthToken(msg);
    }

    // (2) String-level: the literal secret must never appear on the wire.
    for (const [raw] of browser.send.mock.calls) {
      expect(raw).not.toContain("must-not-leak-xyz");
      expect(raw).not.toContain("authToken");
    }
  });

  // Negative safety: binding without a live backend adapter is incoherent.
  // Without the adapter we cannot dispatch the mcp_set_servers that tells the
  // CLI about the IDE; setting ideBinding anyway produces a split-brain where
  // the FE renders "bound" but the CLI sees nothing. The bridge MUST return
  // an error and NOT mutate session state or broadcast when no adapter exists.
  it("bindIde with no backendAdapter returns error and does NOT mutate session state", async () => {
    await seedIde({ port: 49999, ideName: "Neovim" });

    bridge.getOrCreateSession("s1");
    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");
    // Deliberately do NOT attach a backend adapter — simulates a session that
    // hasn't reached CLI-connected yet.
    browser.send.mockClear();

    const result = await bridge.bindIde("s1", 49999);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/backend|adapter|not connected/i);

    // State untouched.
    const session = bridge.getSession("s1")!;
    expect(session.state.ideBinding).toBeFalsy();

    // No session_update ideBinding broadcast fired.
    const broadcasts = browser.send.mock.calls
      .map(([arg]: [string]) => JSON.parse(arg))
      .filter((m: any) => m.type === "session_update" && m.session?.ideBinding);
    expect(broadcasts).toHaveLength(0);
  });

  // Negative safety: unknown port must NOT issue any backend send. A failed
  // match leaking mcp_set_servers with an empty `ide` would destabilize the
  // live MCP config for the session — never acceptable.
  it("bindIde with an unknown port returns error and does NOT call adapter.send", async () => {
    const { adapter, sendCalls } = makeFakeAdapter();
    bridge.getOrCreateSession("s1");
    bridge.attachBackendAdapter("s1", adapter, "claude");
    sendCalls.length = 0;

    const result = await bridge.bindIde("s1", 9999);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/unknown port/i);

    // Critical: no MCP traffic on the failure path.
    expect(sendCalls.filter((m) => m.type === "mcp_set_servers")).toHaveLength(0);
  });

  // Unbind contract — pins the BIND-04 transition payload the FE relies on:
  // ideBinding must be EXPLICITLY null (not undefined) so ChatView can detect
  // the bound → unbound transition and render the disconnect banner.
  it("unbindIde clears binding, sends mcp_set_servers (ide removed), and broadcasts session_update with ideBinding:null", async () => {
    await seedIde({ port: 33333, ideName: "Neovim" });

    const { adapter, sendCalls } = makeFakeAdapter();
    bridge.getOrCreateSession("s1");
    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");
    bridge.attachBackendAdapter("s1", adapter, "claude");

    await bridge.bindIde("s1", 33333);
    sendCalls.length = 0;
    browser.send.mockClear();

    const result = await bridge.unbindIde("s1");
    expect(result).toEqual({ ok: true });

    const session = bridge.getSession("s1")!;
    // Use Object.is to prove it's LITERAL null, not undefined.
    expect(session.state.ideBinding).toBeNull();

    // mcp_set_servers was sent on unbind. Claude uses full-replace wire
    // semantics, so the IDE entry is dropped by OMISSION from `servers`
    // (no `deleteKeys` — that's Codex-only, see the backend-split tests
    // below for the full rationale). Regardless of backend, the IDE's
    // sanitized key ("neovim") must not appear in the outbound `servers`.
    const mcpCalls = sendCalls.filter((m) => m.type === "mcp_set_servers");
    expect(mcpCalls).toHaveLength(1);
    expect(mcpCalls[0].servers.ide).toBeUndefined();
    expect(mcpCalls[0].servers.neovim).toBeUndefined();
    // BIND-08: the actual IDE key is the companion-ide-prefixed form.
    expect(mcpCalls[0].servers["companion-ide-neovim"]).toBeUndefined();
    // Claude: deleteKeys is an empty array (Claude adapter ignores the
    // field, but we pin the shape to prevent accidental wire churn).
    expect(mcpCalls[0].deleteKeys).toEqual([]);

    // session_update carries the explicit null.
    const broadcasts = browser.send.mock.calls
      .map(([arg]: [string]) => JSON.parse(arg))
      .filter((m: any) => m.type === "session_update");
    const hasNullBinding = broadcasts.some(
      (m: any) => m.session && Object.prototype.hasOwnProperty.call(m.session, "ideBinding") && m.session.ideBinding === null,
    );
    expect(hasNullBinding).toBe(true);
  });

  // BIND-04 auto-unbind wiring: when the lockfile goes away mid-session,
  // discovery emits ide:removed. ws-bridge must react by unbinding every
  // session whose binding matches that port — no user action required.
  it("BIND-04: companionBus.emit ide:removed for a bound port auto-unbinds matching sessions", async () => {
    await seedIde({ port: 44444, ideName: "Neovim" });

    const { adapter } = makeFakeAdapter();
    bridge.getOrCreateSession("s1");
    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");
    bridge.attachBackendAdapter("s1", adapter, "claude");

    await bridge.bindIde("s1", 44444);
    expect(bridge.getSession("s1")!.state.ideBinding?.port).toBe(44444);
    browser.send.mockClear();

    // Emit the event as if the lockfile had disappeared. We emit directly
    // on companionBus rather than rely on fs.watch timing — the bridge's
    // wiring is what we're pinning here, not discovery's eviction loop.
    companionBus.emit("ide:removed", {
      port: 44444,
      lockfilePath: join(ideTmpDir, "44444.lock"),
      generation: 1,
    });

    // Auto-unbind may be async (unbindIde is async); give microtasks a tick.
    await new Promise((r) => setTimeout(r, 20));

    expect(bridge.getSession("s1")!.state.ideBinding).toBeNull();
    const broadcasts = browser.send.mock.calls
      .map(([arg]: [string]) => JSON.parse(arg))
      .filter((m: any) => m.type === "session_update");
    expect(
      broadcasts.some(
        (m: any) =>
          m.session &&
          Object.prototype.hasOwnProperty.call(m.session, "ideBinding") &&
          m.session.ideBinding === null,
      ),
    ).toBe(true);
  });

  // BIND-10 (Round-4 robustness): when the IDE lockfile goes away AND the
  // backend adapter is disconnected, unbindIde's wire send fails. Without
  // a force path, `session.state.ideBinding` would stay pointing at the
  // dead IDE — UI shows it bound, MCP mirror keeps the stale entry, and
  // the disconnect banner never fires. The auto-unbind listener must
  // detect unbindIde's failure and force-clear local state so reality
  // matches the on-disk truth (IDE is gone).
  it("BIND-10a: ide:removed while backend disconnected force-clears local ideBinding and broadcasts", async () => {
    await seedIde({ port: 57001, ideName: "Neovim" });

    // Build an adapter that is "connected" for the initial bind (so the
    // bind succeeds), then flip to disconnected before the ide:removed
    // event so unbindIde's wire send fails.
    const sendCalls: any[] = [];
    let connected = true;
    const adapter = {
      isConnected: () => connected,
      send: (msg: any) => {
        sendCalls.push(msg);
        return connected;
      },
      disconnect: async () => {},
      onBrowserMessage: () => {},
      onSessionMeta: () => {},
      onDisconnect: () => {},
      onInitError: () => {},
    };

    bridge.getOrCreateSession("s1");
    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");
    bridge.attachBackendAdapter("s1", adapter, "claude");

    // Bind with backend connected.
    await bridge.bindIde("s1", 57001);
    const session = bridge.getSession("s1")!;
    expect(session.state.ideBinding?.port).toBe(57001);
    // Sanity: the bridge's MCP mirror now has the companion-ide-neovim key.
    expect(session.dynamicMcpServers["companion-ide-neovim"]).toBeDefined();
    browser.send.mockClear();
    sendCalls.length = 0;

    // Backend goes away (e.g. CLI process died). Now simulate the
    // lockfile being removed by discovery.
    connected = false;
    companionBus.emit("ide:removed", {
      port: 57001,
      lockfilePath: join(ideTmpDir, "57001.lock"),
      generation: 2,
    });
    // Auto-unbind is fire-and-forget — wait a tick for the promise chain.
    await new Promise((r) => setTimeout(r, 20));

    // Even though unbindIde's wire send failed (backend disconnected),
    // the force-clear path must still set ideBinding to null and purge
    // the MCP mirror. Otherwise the UI stays stuck "bound" to a dead IDE.
    expect(
      bridge.getSession("s1")!.state.ideBinding,
      "BIND-10a: dead-IDE ideBinding must be force-cleared to null",
    ).toBeNull();
    expect(
      bridge.getSession("s1")!.dynamicMcpServers["companion-ide-neovim"],
      "BIND-10a: stale MCP mirror entry must be purged",
    ).toBeUndefined();

    // The disconnect banner relies on receiving a session_update with
    // ideBinding === null. Force-clear must broadcast this to the browser.
    const broadcasts = browser.send.mock.calls
      .map(([arg]: [string]) => JSON.parse(arg))
      .filter((m: any) => m.type === "session_update");
    expect(
      broadcasts.some(
        (m: any) =>
          m.session &&
          Object.prototype.hasOwnProperty.call(m.session, "ideBinding") &&
          m.session.ideBinding === null,
      ),
      "BIND-10a: force-clear must broadcast session_update with ideBinding:null so BIND-05 fires",
    ).toBe(true);

    // unbindIde short-circuits before adapter.send when isConnected() is
    // false, so NO mcp_set_servers should have been sent — the force path
    // intentionally skips the adapter entirely (backend is dead).
    expect(
      sendCalls.filter((m) => m.type === "mcp_set_servers"),
      "BIND-10a: force-clear path must not attempt adapter.send",
    ).toEqual([]);
  });

  // BIND-10b regression guard: when backend IS connected, ide:removed must
  // still flow through the normal unbindIde path — wire send succeeds,
  // local state cleared by the regular flow. The force path must NOT run
  // (and in particular, must not double-broadcast or double-persist).
  it("BIND-10b: ide:removed with backend connected runs normal unbindIde (no force path)", async () => {
    await seedIde({ port: 57002, ideName: "Neovim" });

    const { adapter, sendCalls } = makeFakeAdapter();
    bridge.getOrCreateSession("s1");
    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");
    bridge.attachBackendAdapter("s1", adapter, "claude");

    await bridge.bindIde("s1", 57002);
    const session = bridge.getSession("s1")!;
    expect(session.state.ideBinding?.port).toBe(57002);
    browser.send.mockClear();
    sendCalls.length = 0;

    companionBus.emit("ide:removed", {
      port: 57002,
      lockfilePath: join(ideTmpDir, "57002.lock"),
      generation: 3,
    });
    await new Promise((r) => setTimeout(r, 20));

    // Local state cleared by the normal unbindIde path.
    expect(bridge.getSession("s1")!.state.ideBinding).toBeNull();

    // mcp_set_servers was sent over the wire (regular unbind). The IDE
    // key is gone from `servers` (Claude full-replace semantics).
    const mcpCalls = sendCalls.filter((m) => m.type === "mcp_set_servers");
    expect(mcpCalls).toHaveLength(1);
    expect(mcpCalls[0].servers["companion-ide-neovim"]).toBeUndefined();

    // Exactly ONE session_update with ideBinding:null — if the force path
    // erroneously also ran, we'd see two. This guards against double-fire.
    const nullBindingBroadcasts = browser.send.mock.calls
      .map(([arg]: [string]) => JSON.parse(arg))
      .filter(
        (m: any) =>
          m.type === "session_update" &&
          m.session &&
          Object.prototype.hasOwnProperty.call(m.session, "ideBinding") &&
          m.session.ideBinding === null,
      );
    expect(
      nullBindingBroadcasts,
      "BIND-10b: normal path must broadcast ideBinding:null exactly once",
    ).toHaveLength(1);
  });

  // BIND-06 safety (positive form): prePopulateCommands must never be invoked
  // with "ide" or "/ide" during binding. The /ide slash is a CLIENT-ONLY
  // affordance — the CLI never sees it.
  it("BIND-06: prePopulateCommands is never called with `ide` or `/ide` during bindIde", async () => {
    await seedIde({ port: 55555, ideName: "Neovim" });

    const { adapter } = makeFakeAdapter();
    bridge.getOrCreateSession("s1");
    bridge.attachBackendAdapter("s1", adapter, "claude");

    const preSpy = vi.spyOn(bridge, "prePopulateCommands");

    await bridge.bindIde("s1", 55555);

    for (const call of preSpy.mock.calls) {
      const slash = call[1] as string[];
      const skills = call[2] as string[];
      expect(slash).not.toContain("ide");
      expect(slash).not.toContain("/ide");
      expect(skills).not.toContain("ide");
      expect(skills).not.toContain("/ide");
    }

    preSpy.mockRestore();
  });

  // BIND-06 safety (negative form): adapter.send must NEVER receive a
  // user_message containing "/ide" during bind. If this ever starts firing,
  // the CLI would interpret it as a slash command and recursively bind —
  // exactly the bug the client-side intercept was designed to prevent.
  it("BIND-06: adapter.send is never called with {type:'user_message'} carrying `/ide` text during bind", async () => {
    await seedIde({ port: 55556, ideName: "Neovim" });

    const { adapter, sendCalls } = makeFakeAdapter();
    bridge.getOrCreateSession("s1");
    bridge.attachBackendAdapter("s1", adapter, "claude");
    sendCalls.length = 0;

    await bridge.bindIde("s1", 55556);

    const leaked = sendCalls.filter(
      (m) =>
        m.type === "user_message" &&
        typeof m.content === "string" &&
        m.content.includes("/ide"),
    );
    expect(leaked).toEqual([]);
  });

  // BIND-07 regression: the CLI binary contains a hardcoded filter (`_35`) that
  // blocks all MCP tools prefixed `mcp__ide__*` except `getDiagnostics` and
  // `executeCode`. When we name the MCP server `"ide"`, the CLI prefixes ALL
  // tools as `mcp__ide__<name>` and the filter strips 8 of 10.
  //
  // Fix: use the sanitized ideName (lowercase, alphanumeric only) as the server
  // key instead of the literal string `"ide"`. Tools then get the prefix
  // `mcp__<idename>__<tool>` which does NOT match `mcp__ide__*`, so all tools
  // pass the filter.
  //
  // This test asserts:
  //   (a) The `servers` object does NOT have a key literally named `"ide"`.
  //   (b) The `servers` object HAS a key equal to the sanitized ideName.
  //   (c) Different ideName values produce the correct sanitized key (e.g.
  //       "VS Code" → "vscode", "Zed" → "zed").
  //
  // Why (a) matters: if "ide" is ever re-introduced as the key, the CLI filter
  // silently drops 8 tools with no error — this test is the only guard.
  it("BIND-07: bindIde uses sanitized ideName (not 'ide') as mcp_set_servers key to bypass CLI tool filter", async () => {
    // Test with "Neovim" → expected key "neovim"
    await seedIde({ port: 56001, ideName: "Neovim", authToken: "tok-bind07" });

    const { adapter, sendCalls } = makeFakeAdapter();
    bridge.getOrCreateSession("s1");
    bridge.attachBackendAdapter("s1", adapter, "claude");
    sendCalls.length = 0;

    await bridge.bindIde("s1", 56001);

    const mcpCalls = sendCalls.filter((m) => m.type === "mcp_set_servers");
    expect(mcpCalls).toHaveLength(1);
    const servers = mcpCalls[0].servers as Record<string, unknown>;

    // (a) Must NOT use the literal "ide" key — that triggers the CLI's _35 filter
    // which allows only getDiagnostics and executeCode from mcp__ide__* tools.
    expect(servers.ide).toBeUndefined();

    // (b) Must use the sanitized ideName prefixed with "companionide"
    // (BIND-08 namespace). "Neovim" → "companion-ide-neovim"
    const expectedKey = "companion-ide-neovim";
    expect(servers[expectedKey]).toBeDefined();
    expect(servers[expectedKey]).toMatchObject({
      type: "ws-ide",
      ideName: "Neovim",
      authToken: "tok-bind07",
    });
    // Must ALSO not use the bare sanitized name — that collides with user
    // MCP servers (see BIND-08 for the namespace rationale).
    expect(servers["neovim"]).toBeUndefined();
  });

  // Issue #2 (codex adversarial review): bindIde must treat a rejecting
  // adapter.send (returns false) as a failure. The guard previously only
  // checked `session.backendAdapter !== null` — a Codex adapter whose
  // transport is disconnected can be attached yet reject sends, producing
  // a split-brain where UI says "bound" but the CLI never learned.
  it("Issue #2: bindIde returns error and does NOT mutate state when adapter.send returns false", async () => {
    await seedIde({ port: 60001, ideName: "Neovim" });

    // Build a fake adapter whose send() always returns false. isConnected
    // optionally lies true — the bridge must still trust the send() return.
    const sendCalls: any[] = [];
    const adapter = {
      isConnected: () => true,
      send: (msg: any) => {
        sendCalls.push(msg);
        return false; // transport rejected the write
      },
      disconnect: async () => {},
      onBrowserMessage: () => {},
      onSessionMeta: () => {},
      onDisconnect: () => {},
      onInitError: () => {},
    };

    bridge.getOrCreateSession("s1");
    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");
    bridge.attachBackendAdapter("s1", adapter, "claude");
    browser.send.mockClear();

    const result = await bridge.bindIde("s1", 60001);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/backend|adapter|not connected/i);

    // State MUST NOT be mutated — no split-brain binding on the server.
    const session = bridge.getSession("s1")!;
    expect(session.state.ideBinding).toBeFalsy();

    // No session_update broadcast carrying ideBinding went out.
    const broadcasts = browser.send.mock.calls
      .map(([arg]: [string]) => JSON.parse(arg))
      .filter((m: any) => m.type === "session_update" && m.session?.ideBinding);
    expect(broadcasts).toHaveLength(0);
  });

  // Issue #2: also check the isConnected=false branch — adapter present
  // but its underlying transport is down. Bridge must return error.
  it("Issue #2: bindIde returns error when adapter.isConnected() is false", async () => {
    await seedIde({ port: 60002, ideName: "Neovim" });

    const sendCalls: any[] = [];
    const adapter = {
      isConnected: () => false, // transport-level disconnected
      send: (_msg: any) => {
        sendCalls.push(_msg);
        return true;
      },
      disconnect: async () => {},
      onBrowserMessage: () => {},
      onSessionMeta: () => {},
      onDisconnect: () => {},
      onInitError: () => {},
    };

    bridge.getOrCreateSession("s1");
    bridge.attachBackendAdapter("s1", adapter, "claude");

    const result = await bridge.bindIde("s1", 60002);
    expect(result.ok).toBe(false);

    // Bridge MUST NOT call send() on a disconnected adapter for the bind path.
    const mcpCalls = sendCalls.filter((m) => m.type === "mcp_set_servers");
    expect(mcpCalls).toHaveLength(0);

    const session = bridge.getSession("s1")!;
    expect(session.state.ideBinding).toBeFalsy();
  });

  it("BIND-07b: sanitized server key handles multi-word and mixed-case ideName", async () => {
    // "VS Code" → "vscode" (spaces stripped, lowercased)
    await seedIde({ port: 56002, ideName: "VS Code", authToken: "tok-bind07b" });

    const { adapter, sendCalls } = makeFakeAdapter();
    bridge.getOrCreateSession("s2");
    bridge.attachBackendAdapter("s2", adapter, "claude");
    sendCalls.length = 0;

    await bridge.bindIde("s2", 56002);

    const mcpCalls = sendCalls.filter((m) => m.type === "mcp_set_servers");
    expect(mcpCalls).toHaveLength(1);
    const servers = mcpCalls[0].servers as Record<string, unknown>;

    expect(servers.ide).toBeUndefined();
    expect(servers["companion-ide-vscode"]).toBeDefined();
    expect(servers["companion-ide-vscode"]).toMatchObject({ ideName: "VS Code" });
  });

  // ─── BIND-08: `companionide` prefix namespacing (cubic PR #652 round-3 P1) ─
  //
  // Context: the MCP server key used to be the bare sanitized ideName (e.g.
  // `"neovim"`), which shared a namespace with user-configured dynamic MCP
  // servers. A user who had already registered an MCP server named `"neovim"`
  // via McpPanel would see bindIde overwrite it, and unbindIde delete it —
  // silent data loss.
  //
  // Fix: prefix the server key with `"companionide"`. The sanitization guard
  // (BIND-07 empty-name) still runs against the TAIL, so `"!?"` → empty tail
  // is rejected (the prefix alone is not a valid key).
  //
  // The three BIND-08 tests below pin:
  //   (a) bindIde preserves a user's `"neovim"` entry (key collision avoided);
  //   (b) unbindIde targets `"companion-ide-neovim"` in deleteKeys, leaving the
  //       user's `"neovim"` entry untouched;
  //   (c) empty-tail ideNames still reject with "invalid IDE name" — the
  //       `companionide` prefix alone is NOT a usable key.

  it("BIND-08a: bindIde preserves a user's identically-named MCP server (namespace collision)", async () => {
    // User had already configured a dynamic MCP server literally named "neovim"
    // via McpPanel. If the IDE bind reuses the same key it would clobber this.
    await seedIde({ port: 41001, ideName: "Neovim", authToken: "tok-bind08a" });

    const { adapter, sendCalls } = makeFakeAdapter();
    bridge.getOrCreateSession("s1");
    bridge.attachBackendAdapter("s1", adapter, "claude");

    const userNeovimConfig = {
      type: "stdio" as const,
      command: "/usr/bin/user-neovim",
      args: ["--some", "flag"],
    };
    bridge.injectMcpSetServers("s1", {
      neovim: userNeovimConfig as any,
    });

    sendCalls.length = 0;
    const result = await bridge.bindIde("s1", 41001);
    expect(result).toEqual({ ok: true });

    const session = bridge.getSession("s1")!;
    // The user's `"neovim"` must be preserved byte-for-byte.
    expect(session.dynamicMcpServers.neovim).toMatchObject(userNeovimConfig);
    // The IDE entry lives under the namespaced key.
    expect(session.dynamicMcpServers["companion-ide-neovim"]).toMatchObject({
      type: "ws-ide",
      ideName: "Neovim",
      authToken: "tok-bind08a",
    });

    // On the wire (Claude full-replace): BOTH keys must be present in servers.
    const mcpCalls = sendCalls.filter((m) => m.type === "mcp_set_servers");
    expect(mcpCalls).toHaveLength(1);
    expect(mcpCalls[0].servers.neovim).toMatchObject(userNeovimConfig);
    expect(mcpCalls[0].servers["companion-ide-neovim"]).toMatchObject({
      ideName: "Neovim",
    });
  });

  it("BIND-08b: unbindIde targets the companion-ide-prefixed key only; user's identically-named MCP server is preserved", async () => {
    await seedIde({ port: 41002, ideName: "Neovim", authToken: "tok-bind08b" });

    const { adapter, sendCalls } = makeFakeAdapter();
    bridge.getOrCreateSession("s1");
    bridge.attachBackendAdapter("s1", adapter, "codex"); // codex path uses deleteKeys

    const userNeovimConfig = {
      type: "stdio" as const,
      command: "/usr/bin/user-neovim",
    };
    bridge.injectMcpSetServers("s1", {
      neovim: userNeovimConfig as any,
    });

    await bridge.bindIde("s1", 41002);
    sendCalls.length = 0;

    const result = await bridge.unbindIde("s1");
    expect(result).toEqual({ ok: true });

    const mcpCalls = sendCalls.filter((m) => m.type === "mcp_set_servers");
    expect(mcpCalls).toHaveLength(1);
    // Codex deleteKeys: ONLY the namespaced key, never the user's bare "neovim".
    expect(mcpCalls[0].deleteKeys).toEqual(["companion-ide-neovim"]);

    // The mirror's user entry is still there after unbind.
    const session = bridge.getSession("s1")!;
    expect(session.dynamicMcpServers.neovim).toMatchObject(userNeovimConfig);
    // The IDE entry was dropped from the mirror.
    expect(session.dynamicMcpServers["companion-ide-neovim"]).toBeUndefined();
  });

  it("BIND-08c: empty-sanitized-tail ideNames still reject — `companion-ide-` prefix alone is NOT a valid key", async () => {
    // "!?" sanitizes to "" — with or without the prefix we must reject, else
    // every all-punctuation lockfile would collide under one bare "companion-ide-"
    // key across different IDE processes.
    await seedIde({ port: 41003, ideName: "!?", authToken: "tok-bind08c" });

    const { adapter, sendCalls } = makeFakeAdapter();
    bridge.getOrCreateSession("s1");
    bridge.attachBackendAdapter("s1", adapter, "claude");
    sendCalls.length = 0;

    const result = await bridge.bindIde("s1", 41003);
    expect(result).toEqual({ ok: false, error: "invalid IDE name" });

    // No wire traffic, no state mutation, no mirror pollution.
    expect(sendCalls.filter((m) => m.type === "mcp_set_servers")).toHaveLength(0);
    const session = bridge.getSession("s1")!;
    expect(session.state.ideBinding).toBeFalsy();
    expect(session.dynamicMcpServers["companion-ide-"]).toBeUndefined();
  });

  // ─── BIND-08d: structural-separator key disjointness (codex round-4 review) ─
  //
  // Context: the previous fix wrote the IDE entry under
  // `companionide${sanitized}` — e.g. `companionideneovim`. That still shared
  // a sanitization namespace with user input: a user could register a dynamic
  // MCP server literally named `"companion-ide-neovim"` (sanitizes to itself),
  // and bindIde would overwrite it / unbindIde would delete it — the same
  // silent data-loss bug, just moved to a less-likely name.
  //
  // Fix: use `companion-ide-${sanitized}` — the two hyphens are STRUCTURAL
  // separators that our sanitization (`[^a-z0-9]`) strips from any user
  // ideName, so no user-generated key can collide with our namespaced keys.
  // The post-sanitization keyspace for IDE entries is `companion-ide-[a-z0-9]+`,
  // which is provably disjoint from anything our sanitizer can emit.
  //
  // This test uses the OLD broken collision case (`companionideneovim`) as
  // the user entry — under the previous fix this would fail; under the new
  // structural-separator fix it MUST pass.
  it("BIND-08d: structural hyphen separator — user entry literally named `companionideneovim` is preserved", async () => {
    // User pre-registered an MCP server with the exact name that the PREVIOUS
    // fix used as the IDE key. Under the old code this is a direct collision;
    // under the structural-hyphen fix it is just another user key, distinct
    // from `companion-ide-neovim`.
    await seedIde({ port: 41004, ideName: "Neovim", authToken: "tok-bind08d" });

    const { adapter, sendCalls } = makeFakeAdapter();
    bridge.getOrCreateSession("s1");
    bridge.attachBackendAdapter("s1", adapter, "claude");

    const userEntryConfig = {
      type: "stdio" as const,
      command: "/usr/bin/user-companionideneovim",
      args: ["--user"],
    };
    // Note: this key would be the OLD broken collision; the new key must be
    // structurally disjoint so it survives bind/unbind.
    bridge.injectMcpSetServers("s1", {
      companionideneovim: userEntryConfig as any,
    });

    sendCalls.length = 0;
    const bindResult = await bridge.bindIde("s1", 41004);
    expect(bindResult).toEqual({ ok: true });

    const session = bridge.getSession("s1")!;
    // The user's `companionideneovim` must survive — previous fix would have
    // overwritten this; the structural-separator fix leaves it alone.
    expect(session.dynamicMcpServers.companionideneovim).toMatchObject(userEntryConfig);
    // The IDE entry lives under the new structurally-disjoint key.
    expect(session.dynamicMcpServers["companion-ide-neovim"]).toMatchObject({
      type: "ws-ide",
      ideName: "Neovim",
      authToken: "tok-bind08d",
    });

    // Claude full-replace wire payload must carry BOTH keys.
    const bindCalls = sendCalls.filter((m) => m.type === "mcp_set_servers");
    expect(bindCalls).toHaveLength(1);
    expect(bindCalls[0].servers.companionideneovim).toMatchObject(userEntryConfig);
    expect(bindCalls[0].servers["companion-ide-neovim"]).toMatchObject({
      ideName: "Neovim",
    });

    // Now unbind and assert the user entry is STILL preserved — previous fix
    // would have deleted it in the Codex path.
    sendCalls.length = 0;
    // Swap to Codex to exercise the deleteKeys path for unbindIde.
    bridge.attachBackendAdapter("s1", adapter, "codex");
    // Re-bind under Codex so unbind has something to tear down on this backend.
    await bridge.bindIde("s1", 41004);
    sendCalls.length = 0;

    const unbindResult = await bridge.unbindIde("s1");
    expect(unbindResult).toEqual({ ok: true });

    const unbindCalls = sendCalls.filter((m) => m.type === "mcp_set_servers");
    expect(unbindCalls).toHaveLength(1);
    // Codex deleteKeys must ONLY target the structurally-namespaced key,
    // never the user's bare `companionideneovim`.
    expect(unbindCalls[0].deleteKeys).toEqual(["companion-ide-neovim"]);
    expect(session.dynamicMcpServers.companionideneovim).toMatchObject(userEntryConfig);
    expect(session.dynamicMcpServers["companion-ide-neovim"]).toBeUndefined();
  });

  // Codex round-2 issue #1: unbindIde must mirror bindIde's adapter guard.
  //
  // Context: bindIde already refuses to mutate state when the adapter is
  // disconnected or send() returns false, so the UI "bound" state and the
  // CLI MCP registry never diverge. unbindIde used to unconditionally clear
  // `session.state.ideBinding` and broadcast `ideBinding: null` even when
  // the tear-down mcp_set_servers could not be delivered. Result: UI says
  // "unbound", CLI still has the IDE MCP server registered — split-brain.
  //
  // Fix: if a binding exists, require (a) adapter attached, (b) isConnected()
  // true, and (c) send() returns true. Only then clear state and broadcast.
  // Any failure short-circuits with {ok:false, error: "backend not connected"}.
  //
  // These three tests pin the new contract. They deliberately mirror the
  // Issue #2 bindIde tests above so the two paths cannot silently regress
  // in isolation.
  it("Issue #1: unbindIde returns error and does NOT clear ideBinding when adapter.send returns false", async () => {
    await seedIde({ port: 61001, ideName: "Neovim" });

    // First bind with a healthy adapter so state.ideBinding is populated.
    const { adapter: goodAdapter } = makeFakeAdapter();
    bridge.getOrCreateSession("s1");
    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");
    bridge.attachBackendAdapter("s1", goodAdapter, "claude");
    await bridge.bindIde("s1", 61001);
    expect(bridge.getSession("s1")!.state.ideBinding?.port).toBe(61001);

    // Swap in a rejecting adapter — isConnected lies true, but send returns
    // false. The bridge must trust the send() return (same pattern as bindIde).
    const badSendCalls: any[] = [];
    const badAdapter = {
      isConnected: () => true,
      send: (msg: any) => {
        badSendCalls.push(msg);
        return false; // transport rejected the write
      },
      disconnect: async () => {},
      onBrowserMessage: () => {},
      onSessionMeta: () => {},
      onDisconnect: () => {},
      onInitError: () => {},
    };
    bridge.attachBackendAdapter("s1", badAdapter, "claude");
    browser.send.mockClear();

    const result = await bridge.unbindIde("s1");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/backend|adapter|not connected/i);

    // CRITICAL: ideBinding must NOT be cleared on send failure — otherwise
    // UI says "unbound" while the CLI still has the MCP entry (split-brain).
    const session = bridge.getSession("s1")!;
    expect(session.state.ideBinding?.port).toBe(61001);

    // No session_update broadcast carrying ideBinding:null went out.
    const broadcasts = browser.send.mock.calls
      .map(([arg]: [string]) => JSON.parse(arg))
      .filter(
        (m: any) =>
          m.type === "session_update" &&
          m.session &&
          Object.prototype.hasOwnProperty.call(m.session, "ideBinding") &&
          m.session.ideBinding === null,
      );
    expect(broadcasts).toHaveLength(0);
  });

  it("Issue #1: unbindIde returns error when adapter.isConnected() is false (binding preserved)", async () => {
    await seedIde({ port: 61002, ideName: "Neovim" });

    // Bind with a healthy adapter first so there IS a binding to tear down.
    const { adapter: goodAdapter } = makeFakeAdapter();
    bridge.getOrCreateSession("s1");
    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");
    bridge.attachBackendAdapter("s1", goodAdapter, "claude");
    await bridge.bindIde("s1", 61002);
    expect(bridge.getSession("s1")!.state.ideBinding?.port).toBe(61002);

    // Swap in an adapter whose transport is disconnected.
    const badSendCalls: any[] = [];
    const badAdapter = {
      isConnected: () => false,
      send: (msg: any) => {
        badSendCalls.push(msg);
        return true;
      },
      disconnect: async () => {},
      onBrowserMessage: () => {},
      onSessionMeta: () => {},
      onDisconnect: () => {},
      onInitError: () => {},
    };
    bridge.attachBackendAdapter("s1", badAdapter, "claude");
    browser.send.mockClear();

    const result = await bridge.unbindIde("s1");
    expect(result.ok).toBe(false);

    // Bridge MUST NOT call send() on a disconnected adapter.
    expect(badSendCalls.filter((m) => m.type === "mcp_set_servers")).toHaveLength(0);

    // Binding preserved (split-brain avoidance).
    const session = bridge.getSession("s1")!;
    expect(session.state.ideBinding?.port).toBe(61002);

    // No ideBinding:null broadcast.
    const broadcasts = browser.send.mock.calls
      .map(([arg]: [string]) => JSON.parse(arg))
      .filter(
        (m: any) =>
          m.type === "session_update" &&
          m.session &&
          Object.prototype.hasOwnProperty.call(m.session, "ideBinding") &&
          m.session.ideBinding === null,
      );
    expect(broadcasts).toHaveLength(0);
  });

  // Idempotency: if no binding is currently set, unbindIde must still
  // return {ok:true} (it's a no-op) even with a disconnected adapter.
  // This preserves existing idempotent semantics that the DELETE route
  // and auto-unbind flow rely on.
  it("Issue #1: unbindIde is idempotent when no binding exists — returns ok:true even without a connected adapter", async () => {
    bridge.getOrCreateSession("s1");
    // No adapter attached and no prior bind — state.ideBinding is falsy.

    const result = await bridge.unbindIde("s1");
    expect(result).toEqual({ ok: true });
  });

  // Codex round-3 + round-4: `unbindIde` must drop the IDE's `mcp_servers.<key>`
  // entry on whichever backend is attached, without silently wiping any OTHER
  // dynamic MCP servers the user has configured.
  //
  // Context (round-3): `servers: {}` alone was a no-op on Codex — its
  // `config/batchWrite` builds one upsert edit per key, so zero keys = zero
  // edits. The bridge started sending `deleteKeys: [sanitizedIdeName]` so
  // Codex translates each deleteKey into a `config/value/write` with
  // `value: null, mergeStrategy: "replace"`.
  //
  // Round-4 Codex review (Issue 1): on Claude, `mcp_set_servers` is a FULL
  // REPLACE of the dynamic set — an empty `{servers: {}, deleteKeys: […]}`
  // payload would drop every dynamic server the user had added via McpPanel.
  // The bridge now branches the wire shape by backend:
  //
  //   Claude: servers = `{...session.dynamicMcpServers}` minus IDE key.
  //           deleteKeys unused (Claude adapter ignores it anyway).
  //   Codex:  servers = {}, deleteKeys = [sanitizedIdeName] (surgical).
  //
  // The sanitization rule (BIND-07) is unchanged on both paths.
  //
  // These two tests pin the backend-split contract. The Claude test uses the
  // dynamicMcpServers mirror being empty as a baseline so the "drop IDE via
  // omission" behavior is observable. Preservation of OTHER servers is
  // covered by the dedicated "MCP-merge preservation" tests below.
  it("unbindIde on Claude drops the IDE by OMITTING it from servers (no deleteKeys — Claude is full-replace)", async () => {
    // "VS Code" → "vscode" (spaces stripped, lowercased) — same sanitization
    // as BIND-07b. We pick a multi-word name specifically to prove the
    // unbind path recomputes the key from ideBinding.ideName, not from
    // whatever the CLI originally received.
    await seedIde({ port: 62001, ideName: "VS Code", authToken: "tok-unbind-claude" });

    const { adapter, sendCalls } = makeFakeAdapter();
    bridge.getOrCreateSession("s1");
    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");
    bridge.attachBackendAdapter("s1", adapter, "claude");

    await bridge.bindIde("s1", 62001);
    sendCalls.length = 0;

    const result = await bridge.unbindIde("s1");
    expect(result).toEqual({ ok: true });

    const mcpCalls = sendCalls.filter((m) => m.type === "mcp_set_servers");
    expect(mcpCalls).toHaveLength(1);
    const msg = mcpCalls[0]!;

    // Claude full-replace: the IDE key must NOT appear in `servers` (that's
    // how we delete it). With no other dynamic servers seeded, the payload
    // is empty — but the absence of `companionidevscode` is the real
    // contract here (BIND-08 namespacing).
    expect(msg.servers["companion-ide-vscode"]).toBeUndefined();
    expect(msg.servers.vscode).toBeUndefined();
    // Claude ignores deleteKeys; sending an empty array avoids any chance
    // of surprise if that contract ever changes.
    expect(msg.deleteKeys).toEqual([]);
  });

  // Codex-backed sessions keep the round-3 surgical shape: `servers: {}` plus
  // `deleteKeys: [sanitizedIdeName]`. The Codex adapter translates each
  // deleteKey into a `config/value/write` with `value: null, mergeStrategy:
  // "replace"`. This test pins that shape so a future refactor cannot
  // accidentally collapse the Claude and Codex payloads back into one.
  it("unbindIde on Codex backend emits servers:{} with deleteKeys:[sanitizedIdeName]", async () => {
    await seedIde({ port: 62002, ideName: "Neovim", authToken: "tok-unbind-codex" });

    const { adapter, sendCalls } = makeFakeAdapter();
    bridge.getOrCreateSession("s1");
    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");
    bridge.attachBackendAdapter("s1", adapter, "codex");

    await bridge.bindIde("s1", 62002);
    sendCalls.length = 0;

    const result = await bridge.unbindIde("s1");
    expect(result).toEqual({ ok: true });

    const mcpCalls = sendCalls.filter((m) => m.type === "mcp_set_servers");
    expect(mcpCalls).toHaveLength(1);
    expect(mcpCalls[0]!.servers).toEqual({});
    // BIND-08: the deleteKey is the companion-ide-prefixed form.
    expect(mcpCalls[0]!.deleteKeys).toEqual(["companion-ide-neovim"]);
  });

  // ─── MCP-merge preservation (round-4 Codex review, Issue 1) ─────────────────
  //
  // Context: Claude's `mcp_set_servers` control_request is a FULL REPLACE of
  // the dynamic MCP server set — any key omitted from `servers` is dropped.
  // Before this fix, `bindIde` sent `{ [ideKey]: entry }` alone and `unbindIde`
  // sent `{}` alone, silently wiping every OTHER dynamic MCP server the user
  // had configured via the McpPanel (sendMcpSetServers path).
  //
  // Fix: ws-bridge now tracks per-session dynamic MCP state by intercepting
  // every `mcp_set_servers` routed through routeBrowserMessage and merging
  // updates into `session.dynamicMcpServers`. bindIde/unbindIde derive their
  // outbound payload from that tracked state so user-added dynamic servers
  // are preserved across an IDE bind cycle.
  //
  // Backend semantics:
  //   - Claude: merge on the bridge side (full-replace wire protocol).
  //     bindIde sends `{ ...others, [ideKey]: entry }`; unbindIde sends
  //     `{ ...others }` (IDE key omitted). No `deleteKeys` on Claude.
  //   - Codex: the adapter's `config/batchWrite` treats `servers` as independent
  //     per-key upserts and `deleteKeys` as per-key removals. We therefore keep
  //     the pre-existing surgical shape: bindIde sends `{ [ideKey]: entry }`
  //     (upsert only — does NOT touch other keys) and unbindIde sends
  //     `{ servers: {}, deleteKeys: [ideKey] }` (per-key delete — does NOT
  //     touch other keys). This preserves the BIND-07 Codex contract while
  //     avoiding silent data loss.

  it("bindIde on Claude preserves user's other dynamic MCP servers", async () => {
    await seedIde({ port: 40001, ideName: "Neovim", authToken: "tok-merge-claude-bind" });

    const { adapter, sendCalls } = makeFakeAdapter();
    bridge.getOrCreateSession("s1");
    bridge.attachBackendAdapter("s1", adapter, "claude");

    // Seed: user has already configured a dynamic MCP server "otherServer"
    // via McpPanel (which calls sendMcpSetServers). This goes through the
    // bridge's routeBrowserMessage path so dynamicMcpServers state accumulates.
    const otherServerConfig = {
      type: "stdio",
      command: "/usr/bin/other",
      args: ["--flag"],
    };
    bridge.injectMcpSetServers("s1", {
      otherServer: otherServerConfig as any,
    });

    sendCalls.length = 0;
    const result = await bridge.bindIde("s1", 40001);
    expect(result).toEqual({ ok: true });

    const mcpCalls = sendCalls.filter((m) => m.type === "mcp_set_servers");
    expect(mcpCalls).toHaveLength(1);
    const msg = mcpCalls[0]!;

    // BOTH the user's server and the IDE entry must be present on Claude —
    // full-replace means omission == deletion. The IDE key is the
    // companion-ide-prefixed form (BIND-08).
    expect(msg.servers.otherServer).toMatchObject(otherServerConfig);
    expect(msg.servers["companion-ide-neovim"]).toMatchObject({
      type: "ws-ide",
      url: "ws://127.0.0.1:40001",
      ideName: "Neovim",
      authToken: "tok-merge-claude-bind",
      scope: "dynamic",
    });
  });

  it("unbindIde on Claude preserves user's other dynamic MCP servers", async () => {
    await seedIde({ port: 40002, ideName: "Neovim", authToken: "tok-merge-claude-unbind" });

    const { adapter, sendCalls } = makeFakeAdapter();
    bridge.getOrCreateSession("s1");
    bridge.attachBackendAdapter("s1", adapter, "claude");

    const otherServerConfig = {
      type: "http",
      url: "http://example.com/mcp",
    };
    bridge.injectMcpSetServers("s1", {
      otherServer: otherServerConfig as any,
    });

    await bridge.bindIde("s1", 40002);
    sendCalls.length = 0;

    const result = await bridge.unbindIde("s1");
    expect(result).toEqual({ ok: true });

    const mcpCalls = sendCalls.filter((m) => m.type === "mcp_set_servers");
    expect(mcpCalls).toHaveLength(1);
    const msg = mcpCalls[0]!;

    // otherServer MUST still be present; IDE entry (companion-ide-prefixed,
    // BIND-08) MUST be gone. Claude ignores `deleteKeys` — the preservation
    // comes from re-sending otherServer in `servers`.
    expect(msg.servers.otherServer).toMatchObject(otherServerConfig);
    expect(msg.servers["companion-ide-neovim"]).toBeUndefined();
  });

  it("bindIde on Codex upserts only the IDE key (does not touch other dynamic MCP servers)", async () => {
    await seedIde({ port: 40003, ideName: "Neovim", authToken: "tok-merge-codex-bind" });

    const { adapter, sendCalls } = makeFakeAdapter();
    bridge.getOrCreateSession("s1");
    bridge.attachBackendAdapter("s1", adapter, "codex");

    const otherServerConfig = {
      type: "stdio",
      command: "/usr/bin/other",
    };
    bridge.injectMcpSetServers("s1", {
      otherServer: otherServerConfig as any,
    });

    sendCalls.length = 0;
    const result = await bridge.bindIde("s1", 40003);
    expect(result).toEqual({ ok: true });

    const mcpCalls = sendCalls.filter((m) => m.type === "mcp_set_servers");
    expect(mcpCalls).toHaveLength(1);
    const msg = mcpCalls[0]!;

    // Codex upserts are per-key — the payload must contain ONLY the IDE entry
    // (BIND-08 companion-ide-prefixed), never the other server (otherwise
    // we'd be re-upserting it spuriously).
    expect(msg.servers["companion-ide-neovim"]).toBeDefined();
    expect(msg.servers.otherServer).toBeUndefined();
  });

  it("unbindIde on Codex sends deleteKeys:[ideKey] without touching other dynamic MCP servers", async () => {
    await seedIde({ port: 40004, ideName: "Neovim", authToken: "tok-merge-codex-unbind" });

    const { adapter, sendCalls } = makeFakeAdapter();
    bridge.getOrCreateSession("s1");
    bridge.attachBackendAdapter("s1", adapter, "codex");

    const otherServerConfig = {
      type: "stdio",
      command: "/usr/bin/other",
    };
    bridge.injectMcpSetServers("s1", {
      otherServer: otherServerConfig as any,
    });

    await bridge.bindIde("s1", 40004);
    sendCalls.length = 0;

    const result = await bridge.unbindIde("s1");
    expect(result).toEqual({ ok: true });

    const mcpCalls = sendCalls.filter((m) => m.type === "mcp_set_servers");
    expect(mcpCalls).toHaveLength(1);
    const msg = mcpCalls[0]!;

    // Codex per-key surgical delete: servers empty, deleteKeys = [ideKey]
    // (BIND-08 companion-ide-prefixed). otherServer MUST NOT appear in either
    // field — we never want to re-upsert or incidentally delete it during unbind.
    expect(msg.servers).toEqual({});
    expect(msg.deleteKeys).toEqual(["companion-ide-neovim"]);
    expect(msg.servers.otherServer).toBeUndefined();
  });

  // ─── Round-5 Codex review (BLOCK): stale-queue replay clobbers IDE ──────────
  //
  // Scenario that motivated this guard:
  //   1. Browser sends `mcp_set_servers({foo})` while `adapter.send()` is
  //      transiently returning false (Codex transport race, or Claude CLI
  //      disconnect debounce window). The message lands in
  //      `session.pendingMessages`. `session.dynamicMcpServers` has ALREADY
  //      been mutated at route time (see `updateDynamicMcpServers`).
  //   2. User binds an IDE. `bindIde` passes the `adapter.isConnected()`
  //      guard, reads `session.dynamicMcpServers` (already has `{foo}`), and
  //      sends merged `{foo, ide}` successfully.
  //   3. Later, `handleCLIOpen` / next browser message triggers
  //      `flushQueuedBrowserMessages`. The stale `{foo}` payload is replayed
  //      verbatim. On Claude (full-replace on the wire) the IDE key is
  //      dropped — split-brain: UI shows bound, CLI lost the IDE MCP entry.
  //
  // Fix: bindIde (and unbindIde) drain any queued browser messages AFTER the
  // connectivity guard but BEFORE the direct `adapter.send()`, so the
  // queue's effects land first and our IDE mutation is the last writer.
  // If the drain fails to fully clear (a retryable message re-queued itself),
  // treat as not-connected — safer than proceeding with a racing half-queue.

  it("bindIde drains pending browser messages FIRST so a stale mcp_set_servers cannot replay after and clobber the IDE entry (Claude full-replace)", async () => {
    // Seed an IDE the bind will resolve against.
    await seedIde({ port: 48001, ideName: "Neovim", authToken: "tok-predrain-claude" });

    const { adapter, sendCalls } = makeFakeAdapter();
    bridge.getOrCreateSession("s1");
    bridge.attachBackendAdapter("s1", adapter, "claude");

    // Simulate the race: a stale `mcp_set_servers({foo})` is sitting in
    // session.pendingMessages (it was enqueued earlier when adapter.send()
    // transiently returned false). The mirror was mutated at route time, so
    // mirror state here matches what the bridge would have if the message
    // had been routed normally — pre-drain bindIde would therefore compute
    // a correct `{foo, ide}` payload, but a later replay would silently
    // clobber it on Claude's full-replace wire.
    const session = bridge.getSession("s1")!;
    const fooConfig = { type: "stdio" as const, command: "/usr/bin/foo" };
    session.dynamicMcpServers.foo = fooConfig as any;
    session.pendingMessages.push(
      JSON.stringify({ type: "mcp_set_servers", servers: { foo: fooConfig } }),
    );

    sendCalls.length = 0;
    const result = await bridge.bindIde("s1", 48001);
    expect(result).toEqual({ ok: true });

    // CALL ORDER is the crux: the drained `{foo}` payload must hit the
    // adapter FIRST, then bindIde's merged `{foo, neovim}` payload. If the
    // drain happens AFTER bindIde (current bug), the neovim key gets
    // clobbered by the replay.
    const mcpCalls = sendCalls.filter((m) => m.type === "mcp_set_servers");
    expect(mcpCalls).toHaveLength(2);

    // First call: the drained stale payload — only foo, no IDE key.
    expect(mcpCalls[0].servers.foo).toBeDefined();
    expect(mcpCalls[0].servers["companion-ide-neovim"]).toBeUndefined();

    // Second call: bindIde's merged Claude full-replace — BOTH keys present
    // (IDE key under BIND-08 companion-ide-prefixed form).
    expect(mcpCalls[1].servers.foo).toBeDefined();
    expect(mcpCalls[1].servers["companion-ide-neovim"]).toBeDefined();
    expect(mcpCalls[1].servers["companion-ide-neovim"].ideName).toBe("Neovim");

    // The queue must be empty after bindIde — nothing can replay after us.
    expect(session.pendingMessages).toHaveLength(0);

    // Session state reflects the bind.
    expect(session.state.ideBinding).toMatchObject({ port: 48001, ideName: "Neovim" });
  });

  it("bindIde returns {ok:false, error:'backend not connected'} when the pre-drain cannot fully flush (retryable send failed)", async () => {
    await seedIde({ port: 48002, ideName: "Neovim", authToken: "tok-predrain-fail" });

    // Adapter that refuses the first send (the queued `mcp_set_servers`),
    // causing it to be re-queued as a retryable type. The drain's post-check
    // then sees pendingMessages.length > 0 and short-circuits bindIde
    // BEFORE any state mutation or browser broadcast.
    const sendCalls: any[] = [];
    const adapter = {
      isConnected: () => true,
      send: (msg: any) => {
        sendCalls.push(msg);
        return false; // every send fails
      },
      disconnect: async () => {},
      onBrowserMessage: () => {},
      onSessionMeta: () => {},
      onDisconnect: () => {},
      onInitError: () => {},
    };
    bridge.getOrCreateSession("s1");
    bridge.attachBackendAdapter("s1", adapter as any, "claude");

    const session = bridge.getSession("s1")!;
    const fooConfig = { type: "stdio" as const, command: "/usr/bin/foo" };
    session.dynamicMcpServers.foo = fooConfig as any;
    session.pendingMessages.push(
      JSON.stringify({ type: "mcp_set_servers", servers: { foo: fooConfig } }),
    );

    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");
    browser.send.mockClear();
    sendCalls.length = 0;

    const result = await bridge.bindIde("s1", 48002);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/backend|not connected/i);

    // State must be untouched — no ideBinding set.
    expect(session.state.ideBinding).toBeFalsy();

    // No session_update ideBinding broadcast — the bind failed before broadcast.
    const broadcasts = browser.send.mock.calls
      .map(([arg]: [string]) => JSON.parse(arg))
      .filter((m: any) => m.type === "session_update" && m.session?.ideBinding);
    expect(broadcasts).toHaveLength(0);

    // The bindIde's own `mcp_set_servers` must NEVER hit the adapter: we
    // short-circuited after the failed drain. Only the drain attempt fired.
    // The IDE key uses the companion-ide-prefixed form (BIND-08).
    const bindAttempts = sendCalls.filter(
      (m) => m.type === "mcp_set_servers" && m.servers?.["companion-ide-neovim"],
    );
    expect(bindAttempts).toHaveLength(0);

    // The stale message re-queued itself (retryable) so the queue remains
    // non-empty — that IS the signal the drain post-check reads.
    expect(session.pendingMessages.length).toBeGreaterThan(0);
  });

  it("unbindIde drains pending browser messages FIRST so a stale mcp_set_servers cannot replay after and clobber the unbind (Claude full-replace)", async () => {
    await seedIde({ port: 48003, ideName: "Neovim", authToken: "tok-unbind-predrain" });

    const { adapter, sendCalls } = makeFakeAdapter();
    bridge.getOrCreateSession("s1");
    bridge.attachBackendAdapter("s1", adapter, "claude");

    // Bind first (so we have something to unbind against).
    await bridge.bindIde("s1", 48003);

    // Now seed a stale `mcp_set_servers({foo})` payload in the queue +
    // mirror, mimicking a concurrent McpPanel write whose send transiently
    // failed. Without the unbind pre-drain, this would replay AFTER unbind
    // and re-upsert the merged state, potentially re-adding the IDE key.
    const session = bridge.getSession("s1")!;
    const fooConfig = { type: "stdio" as const, command: "/usr/bin/foo" };
    session.dynamicMcpServers.foo = fooConfig as any;
    session.pendingMessages.push(
      JSON.stringify({ type: "mcp_set_servers", servers: { foo: fooConfig } }),
    );

    sendCalls.length = 0;
    const result = await bridge.unbindIde("s1");
    expect(result).toEqual({ ok: true });

    const mcpCalls = sendCalls.filter((m) => m.type === "mcp_set_servers");
    expect(mcpCalls).toHaveLength(2);

    // First: the drained stale payload — has `foo`. The pre-unbind replay
    // does not touch the IDE key (that's unbindIde's job).
    expect(mcpCalls[0].servers.foo).toBeDefined();

    // Second: unbindIde's merge-minus-ide payload — `foo` present (merged
    // from the mirror the drain just refreshed), IDE entry (BIND-08
    // companion-ide-prefixed) OMITTED so Claude drops it from the dynamic
    // registry.
    expect(mcpCalls[1].servers.foo).toBeDefined();
    expect(mcpCalls[1].servers["companion-ide-neovim"]).toBeUndefined();

    // Queue is empty; unbind committed.
    expect(session.pendingMessages).toHaveLength(0);
    expect(session.state.ideBinding).toBeNull();
  });

  it("bindIde on Codex also pre-drains queued browser messages BEFORE emitting its per-key upsert", async () => {
    await seedIde({ port: 48004, ideName: "Neovim", authToken: "tok-predrain-codex" });

    const { adapter, sendCalls } = makeFakeAdapter();
    bridge.getOrCreateSession("s1");
    bridge.attachBackendAdapter("s1", adapter, "codex");

    const session = bridge.getSession("s1")!;
    const fooConfig = { type: "stdio" as const, command: "/usr/bin/foo" };
    session.dynamicMcpServers.foo = fooConfig as any;
    session.pendingMessages.push(
      JSON.stringify({ type: "mcp_set_servers", servers: { foo: fooConfig } }),
    );

    sendCalls.length = 0;
    const result = await bridge.bindIde("s1", 48004);
    expect(result).toEqual({ ok: true });

    // Two `mcp_set_servers` calls, drain first then bindIde's upsert.
    const mcpCalls = sendCalls.filter((m) => m.type === "mcp_set_servers");
    expect(mcpCalls).toHaveLength(2);

    // First: the drained stale payload (carries `foo`).
    expect(mcpCalls[0].servers.foo).toBeDefined();

    // Second: Codex per-key upsert — ONLY the IDE entry (BIND-08
    // companion-ide-prefixed), never re-upserting the other mirror keys
    // (the whole point of per-key on Codex). If the pre-drain accidentally
    // promoted the Codex branch to full-replace, this assertion would fail.
    expect(mcpCalls[1].servers["companion-ide-neovim"]).toBeDefined();
    expect(mcpCalls[1].servers.foo).toBeUndefined();

    expect(session.pendingMessages).toHaveLength(0);
  });

  // ─── Round-6 Codex review (BLOCK): restore-from-disk mirror/queue split ─────
  //
  // `session.pendingMessages` is persisted to disk by session-store, but
  // `session.dynamicMcpServers` is NOT — on server restart the mirror is
  // re-initialized to `{}` while the queue still holds pre-restart
  // `mcp_set_servers` payloads. Round-5's pre-drain fix in `bindIde` avoids
  // post-bind replay clobber, but a cold restore exposes a second path:
  //
  //   1. Pre-drain replays `mcp_set_servers({foo})` to the adapter. The
  //      adapter now knows `{foo}`. But the mirror is still `{}` because the
  //      drain path NEVER mutated the mirror before this fix.
  //   2. bindIde reads the empty mirror, computes `{ide}` alone, sends.
  //   3. On Claude's full-replace wire, the adapter replaces `{foo}` with
  //      `{ide}` — `foo` is dropped. Split-brain: UI thinks bound, Claude
  //      forgot `foo`.
  //
  // Fix: `flushQueuedBrowserMessages` now calls `updateDynamicMcpServers`
  // for each queued `mcp_set_servers` BEFORE forwarding. Idempotent for the
  // in-process path (mirror already updated at route time), corrective for
  // the cold-restore path.
  it("bindIde after restart rebuilds dynamicMcpServers from queued mcp_set_servers BEFORE sending (Claude)", async () => {
    await seedIde({ port: 48005, ideName: "Neovim", authToken: "tok-restore-claude" });

    const { adapter, sendCalls } = makeFakeAdapter();
    bridge.getOrCreateSession("s1");
    bridge.attachBackendAdapter("s1", adapter, "claude");

    // Simulate the cold-restore state: queue has the pre-restart payload,
    // but the mirror was re-initialized to `{}` by session reconstruction.
    const session = bridge.getSession("s1")!;
    const fooConfig = { type: "stdio" as const, command: "/usr/bin/foo" };
    expect(session.dynamicMcpServers).toEqual({});
    session.pendingMessages.push(
      JSON.stringify({ type: "mcp_set_servers", servers: { foo: fooConfig } }),
    );

    sendCalls.length = 0;
    const result = await bridge.bindIde("s1", 48005);
    expect(result).toEqual({ ok: true });

    const mcpCalls = sendCalls.filter((m) => m.type === "mcp_set_servers");
    expect(mcpCalls).toHaveLength(2);

    // First call (drain replay): carries the queued `{foo}`.
    expect(mcpCalls[0].servers.foo).toBeDefined();
    expect(mcpCalls[0].servers["companion-ide-neovim"]).toBeUndefined();

    // Second call (bindIde's merged Claude full-replace): MUST carry BOTH
    // `foo` (recovered from the queue via the mirror catch-up) AND the IDE
    // entry (BIND-08 companion-ide-prefixed). If the catch-up were missing,
    // the mirror would still be `{}` and the payload would be
    // `{companionideneovim}` alone, clobbering `foo` on the wire.
    expect(mcpCalls[1].servers.foo).toBeDefined();
    expect(mcpCalls[1].servers["companion-ide-neovim"]).toBeDefined();

    // Mirror reflects both, ready for subsequent bind/unbind cycles. The
    // IDE entry lives under the BIND-08 companion-ide-prefixed key.
    expect(session.dynamicMcpServers.foo).toBeDefined();
    expect(session.dynamicMcpServers["companion-ide-neovim"]).toBeDefined();
    expect(session.pendingMessages).toHaveLength(0);
  });

  it("flushQueuedBrowserMessages applies deleteKeys from queued mcp_set_servers so bindIde merges a clean mirror", async () => {
    await seedIde({ port: 48006, ideName: "Neovim", authToken: "tok-restore-delete" });

    const { adapter, sendCalls } = makeFakeAdapter();
    bridge.getOrCreateSession("s1");
    bridge.attachBackendAdapter("s1", adapter, "claude");

    // Cold-restore with a cached `foo` in the mirror AND a queued payload
    // that deletes `foo`. The mirror catch-up must apply the delete so
    // bindIde reads a `{}` mirror and emits `{companionideneovim}` alone on
    // the wire (BIND-08) — NOT `{foo, companionideneovim}` which would
    // resurrect a deleted server.
    const session = bridge.getSession("s1")!;
    const fooConfig = { type: "stdio" as const, command: "/usr/bin/foo" };
    session.dynamicMcpServers.foo = fooConfig as any;
    session.pendingMessages.push(
      JSON.stringify({ type: "mcp_set_servers", servers: {}, deleteKeys: ["foo"] }),
    );

    sendCalls.length = 0;
    const result = await bridge.bindIde("s1", 48006);
    expect(result).toEqual({ ok: true });

    const mcpCalls = sendCalls.filter((m) => m.type === "mcp_set_servers");
    expect(mcpCalls).toHaveLength(2);

    // First: drained delete payload replay as-is.
    expect(mcpCalls[0].deleteKeys).toEqual(["foo"]);

    // Second: bindIde's full-replace — `foo` must NOT appear, the delete
    // propagated through the mirror catch-up. IDE entry under BIND-08 key.
    expect(mcpCalls[1].servers.foo).toBeUndefined();
    expect(mcpCalls[1].servers["companion-ide-neovim"]).toBeDefined();

    // Mirror: foo deleted, IDE entry present (BIND-08 prefixed).
    expect(session.dynamicMcpServers.foo).toBeUndefined();
    expect(session.dynamicMcpServers["companion-ide-neovim"]).toBeDefined();
  });

  // ─── Empty-sanitized-key guard (round-4 Codex review, Issue 2) ──────────────
  //
  // Context: `bindIde` previously computed
  //   `serverKey = ideName.toLowerCase().replace(/[^a-z0-9]/g, "")`
  // without checking the result. A lockfile with `ideName: "!?"` would
  // yield `serverKey === ""` and cause the CLI/Codex to register an
  // `mcp_servers.""` orphan. `unbindIde`'s empty-key guard would then
  // refuse to delete it (deleteKeys: []), leaving a permanent orphan
  // entry in the user's dynamic MCP registry.
  //
  // Fix: reject the bind early with {ok:false, error: "invalid IDE name"}
  // so the route maps to 400 and nothing is sent on the wire. Same shape
  // as "unknown port" / "backend not connected" errors.
  it("bindIde rejects lockfiles with non-alphanumeric-only ideName (prevents empty-key MCP orphan)", async () => {
    // "!?" sanitizes to "" — classic empty-key trap.
    await seedIde({ port: 40099, ideName: "!?", authToken: "tok-invalid-name" });

    const { adapter, sendCalls } = makeFakeAdapter();
    bridge.getOrCreateSession("s1");
    bridge.attachBackendAdapter("s1", adapter, "claude");
    sendCalls.length = 0;

    const result = await bridge.bindIde("s1", 40099);
    expect(result).toEqual({ ok: false, error: "invalid IDE name" });

    // No mcp_set_servers must be sent — the fix must short-circuit BEFORE
    // any adapter write. Same principle as the "unknown port" guard.
    const mcpCalls = sendCalls.filter((m) => m.type === "mcp_set_servers");
    expect(mcpCalls).toHaveLength(0);

    // Session state must be untouched — no ideBinding mutation.
    const session = bridge.getSession("s1")!;
    expect(session.state.ideBinding).toBeFalsy();
  });

  // ─── cubic-ai review (PR #652, Issue 1): browser mcp_set_servers after IDE bind ─
  //
  // Context: Claude's `mcp_set_servers` is FULL REPLACE on the wire. After
  // `bindIde` merges the IDE entry into session.dynamicMcpServers and sends
  // a merged `{...others, [ideKey]: entry}` payload, the user can later edit
  // MCP servers via McpPanel — that sends a NEW `mcp_set_servers` from the
  // browser. Before this fix, that browser-originated payload was forwarded
  // verbatim to Claude, DROPPING the IDE entry (because the browser had no
  // reason to include it). Result: split-brain — UI says bound, Claude lost
  // the IDE MCP server, tools disappear.
  //
  // Fix: for Claude ONLY, in `routeBrowserMessage`'s `mcp_set_servers` branch,
  // inject the active IDE entry (from `session.dynamicMcpServers[ideKey]`)
  // into `msg.servers` BEFORE mirror update + adapter.send, unless the user
  // explicitly opts in to delete the IDE key via `deleteKeys`. Codex path is
  // per-key upsert (not full-replace), so no injection needed.
  it("Claude: browser mcp_set_servers preserves active IDE entry on full-replace", async () => {
    await seedIde({ port: 59001, ideName: "Neovim", authToken: "tok-preserve" });

    const { adapter, sendCalls } = makeFakeAdapter();
    bridge.getOrCreateSession("s1");
    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");
    bridge.attachBackendAdapter("s1", adapter, "claude");

    // Bind the IDE first — this populates dynamicMcpServers under the
    // BIND-08 companion-ide-prefixed key.
    const bindResult = await bridge.bindIde("s1", 59001);
    expect(bindResult).toEqual({ ok: true });
    sendCalls.length = 0;

    // User edits MCP via McpPanel — browser sends a full-replace with ONLY
    // the new server. Pre-fix: this payload was forwarded verbatim, dropping
    // the IDE entry.
    const fooConfig = { type: "stdio" as const, command: "/usr/bin/foo" };
    bridge.handleBrowserMessage(
      browser,
      JSON.stringify({ type: "mcp_set_servers", servers: { foo: fooConfig } }),
    );

    // Adapter must have seen ONE mcp_set_servers — with BOTH the user's new
    // `foo` AND the merged-in IDE entry (BIND-08 companion-ide-prefixed).
    const mcpCalls = sendCalls.filter((m) => m.type === "mcp_set_servers");
    expect(mcpCalls).toHaveLength(1);
    expect(mcpCalls[0].servers.foo).toMatchObject(fooConfig);
    expect(mcpCalls[0].servers["companion-ide-neovim"]).toBeDefined();
    expect(mcpCalls[0].servers["companion-ide-neovim"]).toMatchObject({
      type: "ws-ide",
      ideName: "Neovim",
    });
  });

  it("Claude: browser mcp_set_servers with deleteKeys:[ideKey] cannot drop the IDE (reserved-namespace strip supersedes)", async () => {
    // HISTORICAL CONTEXT (cubic-ai PR #652 Issue 1): earlier contract said
    // "if the user explicitly sends `deleteKeys: ['companion-ide-neovim']`,
    // forward it and skip merge re-injection — cleaning up the binding is
    // bindIde/unbindIde's job, not routeBrowserMessage's."
    //
    // NEW CONTRACT (Codex round-5 BLOCK 1, BIND-08f): the reserved
    // `companion-ide-*` namespace is no longer reachable from the public
    // `mcp_set_servers` path. Any user-supplied deleteKey matching the
    // reserved prefix is STRIPPED before the merge-injection check, which
    // means the Claude merge-injection then sees no user-authored delete,
    // and re-inserts the IDE entry from the mirror. Net effect: users
    // cannot remove the bridge-authored IDE entry via the public path —
    // only bindIde/unbindIde (which bypass this path via adapter.send
    // directly) may.
    //
    // This inverts the previous expectation; see BIND-08f for the canonical
    // "user attempt to delete is suppressed" assertion.
    await seedIde({ port: 59002, ideName: "Neovim", authToken: "tok-delete" });

    const { adapter, sendCalls } = makeFakeAdapter();
    bridge.getOrCreateSession("s1");
    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");
    bridge.attachBackendAdapter("s1", adapter, "claude");

    await bridge.bindIde("s1", 59002);
    sendCalls.length = 0;

    // User attempts to delete the IDE key via deleteKeys.
    bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "mcp_set_servers",
        servers: {},
        deleteKeys: ["companion-ide-neovim"],
      }),
    );

    const mcpCalls = sendCalls.filter((m) => m.type === "mcp_set_servers");
    expect(mcpCalls).toHaveLength(1);
    // The reserved-key deleteKey was stripped BEFORE reaching the merge
    // check — Claude merge-injection then re-inserted the IDE entry from
    // the mirror, so the outbound payload contains the IDE entry and an
    // empty (or missing-the-reserved-key) deleteKeys.
    expect(mcpCalls[0].servers["companion-ide-neovim"]).toBeDefined();
    expect(mcpCalls[0].deleteKeys ?? []).not.toContain("companion-ide-neovim");

    // Binding state is still populated — user attempt to delete the IDE
    // entry via this path is a no-op at the state level.
    const session = bridge.getSession("s1")!;
    expect(session.state.ideBinding).not.toBeNull();
    // Mirror unchanged — reserved entry survives.
    expect(session.dynamicMcpServers["companion-ide-neovim"]).toBeDefined();
  });

  it("Codex: browser mcp_set_servers is unchanged (per-key upsert — no merge injected)", async () => {
    // Codex's `config/batchWrite` is per-key upsert, not full-replace, so
    // omitting the IDE key does NOT drop it. Injecting the IDE entry here
    // would spuriously re-upsert it on every user edit. Contract: Codex
    // path forwards the browser payload byte-for-byte (minus bridge-level
    // bookkeeping).
    await seedIde({ port: 59003, ideName: "Neovim", authToken: "tok-codex" });

    const { adapter, sendCalls } = makeFakeAdapter();
    bridge.getOrCreateSession("s1");
    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");
    bridge.attachBackendAdapter("s1", adapter, "codex");

    await bridge.bindIde("s1", 59003);
    sendCalls.length = 0;

    const fooConfig = { type: "stdio" as const, command: "/usr/bin/foo" };
    bridge.handleBrowserMessage(
      browser,
      JSON.stringify({ type: "mcp_set_servers", servers: { foo: fooConfig } }),
    );

    const mcpCalls = sendCalls.filter((m) => m.type === "mcp_set_servers");
    expect(mcpCalls).toHaveLength(1);
    // Codex: payload is forwarded as-is. `foo` is present; IDE key
    // (BIND-08 companion-ide-prefixed) is NOT (because Codex didn't need it
    // to be — upserts are independent).
    expect(mcpCalls[0].servers.foo).toMatchObject(fooConfig);
    expect(mcpCalls[0].servers["companion-ide-neovim"]).toBeUndefined();
  });

  it("Claude: browser mcp_set_servers when no IDE is bound is forwarded unchanged", async () => {
    // Baseline: merge injection only kicks in when an IDE is actively bound.
    // Without a binding, there is nothing to preserve — forward verbatim.
    const { adapter, sendCalls } = makeFakeAdapter();
    bridge.getOrCreateSession("s1");
    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");
    bridge.attachBackendAdapter("s1", adapter, "claude");
    sendCalls.length = 0;

    const fooConfig = { type: "stdio" as const, command: "/usr/bin/foo" };
    bridge.handleBrowserMessage(
      browser,
      JSON.stringify({ type: "mcp_set_servers", servers: { foo: fooConfig } }),
    );

    const mcpCalls = sendCalls.filter((m) => m.type === "mcp_set_servers");
    expect(mcpCalls).toHaveLength(1);
    expect(mcpCalls[0].servers).toEqual({ foo: fooConfig });
  });

  // ─── Codex round-5 BLOCK 1: reserved `companion-ide-*` namespace ─────────
  //
  // Context: user-supplied `mcp_set_servers` payloads were forwarded
  // verbatim. A malicious or accidental payload with a key in our reserved
  // `companion-ide-*` namespace (e.g. `servers: {"companion-ide-neovim":
  // {...user-crafted...}}` OR `deleteKeys: ["companion-ide-neovim"]`)
  // could either clobber or delete a bridge-authored IDE entry — producing
  // a split-brain (UI says bound; CLI has a user-controlled or missing
  // MCP entry at the reserved key).
  //
  // Fix: routeBrowserMessage strips any keys with the `companion-ide-`
  // prefix from BOTH `servers` and `deleteKeys` BEFORE the merge injection,
  // mirror update, and adapter.send. bindIde/unbindIde remain the only
  // writers allowed to touch that namespace (they bypass routeBrowserMessage
  // via adapter.send directly, which is intentional).

  it("BIND-08e: user mcp_set_servers cannot write into reserved `companion-ide-*` namespace (stripped before mirror + send)", async () => {
    // No IDE bind — we only care that a user attempt to occupy the reserved
    // namespace is rejected (stripped from wire + mirror). Non-reserved keys
    // must still pass through unchanged.
    const { adapter, sendCalls } = makeFakeAdapter();
    bridge.getOrCreateSession("s1");
    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");
    bridge.attachBackendAdapter("s1", adapter, "claude");
    sendCalls.length = 0;

    // User tries to occupy the reserved namespace with a user-controlled
    // entry AND register a legitimate server at the same time.
    const userIdeEntry = {
      type: "stdio" as const,
      command: "/tmp/evil-ide",
    };
    const userMyServer = { type: "stdio" as const, command: "/usr/bin/myserver" };
    bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "mcp_set_servers",
        servers: {
          "companion-ide-neovim": userIdeEntry,
          myserver: userMyServer,
        },
      }),
    );

    const mcpCalls = sendCalls.filter((m) => m.type === "mcp_set_servers");
    expect(mcpCalls).toHaveLength(1);
    // Outbound wire payload: reserved key stripped; non-reserved passes through.
    expect(mcpCalls[0].servers["companion-ide-neovim"]).toBeUndefined();
    expect(mcpCalls[0].servers.myserver).toMatchObject(userMyServer);

    // Bridge mirror matches the wire payload — user did NOT register anything
    // into the reserved namespace; non-reserved key WAS registered.
    const session = bridge.getSession("s1")!;
    expect(session.dynamicMcpServers["companion-ide-neovim"]).toBeUndefined();
    expect(session.dynamicMcpServers.myserver).toMatchObject(userMyServer);
  });

  it("BIND-08f: user deleteKeys cannot delete a bridge-authored IDE entry via reserved prefix", async () => {
    // Scenario: IDE is actively bound. A malicious/accidental browser payload
    // attempts `deleteKeys: ["companion-ide-neovim"]`. The reserved-prefix
    // stripper must remove that entry from deleteKeys BEFORE the mirror
    // update and BEFORE the outbound send — so our bridge-authored IDE
    // registration survives.
    await seedIde({ port: 59101, ideName: "Neovim", authToken: "tok-bind08f" });

    const { adapter, sendCalls } = makeFakeAdapter();
    bridge.getOrCreateSession("s1");
    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");
    bridge.attachBackendAdapter("s1", adapter, "claude");

    // Bind IDE — this creates a `companion-ide-neovim` entry under our control.
    const bindResult = await bridge.bindIde("s1", 59101);
    expect(bindResult).toEqual({ ok: true });
    sendCalls.length = 0;

    // User tries to nuke the IDE key via deleteKeys. Must be stripped.
    bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "mcp_set_servers",
        servers: {},
        deleteKeys: ["companion-ide-neovim"],
      }),
    );

    const mcpCalls = sendCalls.filter((m) => m.type === "mcp_set_servers");
    expect(mcpCalls).toHaveLength(1);
    // Outbound wire payload: the user's deleteKeys entry for our reserved key
    // is stripped. (The claude merge injection may or may not re-add the IDE
    // entry into servers — we only pin that the reserved delete is suppressed.)
    expect(mcpCalls[0].deleteKeys).not.toContain("companion-ide-neovim");

    // Bridge mirror still has our IDE entry. User attempt to delete it fails.
    const session = bridge.getSession("s1")!;
    expect(session.dynamicMcpServers["companion-ide-neovim"]).toBeDefined();
    // IDE binding state remains — the user's attack did not tear down the bind.
    expect(session.state.ideBinding).not.toBeNull();
  });

  // ─── BIND-08h: defensive invariant at the replay site ──────────────────────
  //
  // Context (Codex CONDITIONAL-GO): `routeBrowserMessage` today is the only
  // entry point that populates `session.pendingMessages` for `mcp_set_servers`,
  // and it calls `stripReservedIdeKeys` BEFORE enqueue. So today the queue
  // never contains reserved-namespace keys. But `flushQueuedBrowserMessages`
  // does not re-sanitize on replay — it trusts the enqueued payload and
  // pushes it straight into `updateDynamicMcpServers` and `adapter.send`.
  //
  // That trust is a one-line-upstream invariant. If ANY future code path
  // were added that enqueues an unsanitized message (a new adapter hook, a
  // deserialized-from-disk path, a `Session.pendingMessages.push(...)` from
  // some other module), the reserved-namespace protection — the whole
  // reason `companion-ide-*` can't be clobbered via the public MCP path —
  // would silently disappear on replay.
  //
  // Fix: `flushQueuedBrowserMessages` runs `stripReservedIdeKeys` on every
  // `mcp_set_servers` payload it replays, BEFORE the mirror update AND
  // BEFORE the adapter.send. Reserved-namespace stripping becomes a
  // structural invariant at every mirror write site, not a caller contract.
  //
  // Test strategy: simulate a hypothetical future bug where an unsanitized
  // message bypassed `routeBrowserMessage` and landed directly in
  // `session.pendingMessages`. Trigger the flush via a public seam
  // (`bindIde`'s pre-drain path, which calls `flushQueuedBrowserMessages`
  // with reason `ide_bind_predrain`). Assert:
  //   1. The mirror (`session.dynamicMcpServers`) does NOT contain the
  //      reserved key after the flush.
  //   2. The outbound adapter.send does NOT carry the reserved key.
  //   3. The strip fired a `log.warn`.
  it("BIND-08h: flushQueuedBrowserMessages re-strips reserved `companion-ide-*` keys on replay", async () => {
    // Capture log.warn so we can assert the strip fired.
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await seedIde({ port: 59102, ideName: "Neovim", authToken: "tok-bind08h" });

    const { adapter, sendCalls } = makeFakeAdapter();
    bridge.getOrCreateSession("s1");
    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");
    bridge.attachBackendAdapter("s1", adapter, "claude");
    sendCalls.length = 0;

    // Manually inject an unsanitized `mcp_set_servers` into the queue —
    // simulates the hypothetical future bug the invariant defends against.
    // Reserved keys: one in `servers` (attempts to register under the
    // reserved namespace) and one in `deleteKeys` (attempts to delete a
    // bridge-authored entry).
    const session = bridge.getSession("s1")!;
    const userFoo = { type: "stdio" as const, command: "/usr/bin/foo" };
    const spoofedIdeEntry = {
      type: "ws-ide" as const,
      url: "ws://attacker",
      ideName: "Spoofed",
      authToken: "pwned",
      ideRunningInWindows: false,
    };
    session.pendingMessages.push(
      JSON.stringify({
        type: "mcp_set_servers",
        servers: {
          foo: userFoo,
          "companion-ide-neovim": spoofedIdeEntry,
        },
        deleteKeys: ["companion-ide-other"],
      }),
    );

    // Trigger the flush via the `bindIde` pre-drain seam. `bindIde` calls
    // `flushQueuedBrowserMessages(..., "ide_bind_predrain")` BEFORE its own
    // merge send, so the queued payload is replayed first.
    const bindResult = await bridge.bindIde("s1", 59102);
    expect(bindResult).toEqual({ ok: true });

    // ── Assertion 1: the mirror after the full sequence has exactly ONE
    // `companion-ide-*` entry — the one `bindIde` wrote. The spoofed
    // payload's reserved key must have been stripped BEFORE
    // `updateDynamicMcpServers` ran on the queued payload, so the mirror
    // was never polluted with `{url: "ws://attacker", authToken: "pwned"}`.
    const ideEntry = session.dynamicMcpServers["companion-ide-neovim"];
    expect(ideEntry).toBeDefined();
    expect(ideEntry).toMatchObject({
      type: "ws-ide",
      ideName: "Neovim",
      url: "ws://127.0.0.1:59102",
      authToken: "tok-bind08h",
    });
    // The user-authored non-reserved entry must still be applied.
    expect(session.dynamicMcpServers.foo).toMatchObject(userFoo);

    // ── Assertion 2: the outbound REPLAY send (the first `mcp_set_servers`
    // the adapter received, from `ide_bind_predrain`) must NOT contain the
    // reserved key in `servers` OR in `deleteKeys`. Pre-fix, the replay
    // would forward the spoofed payload verbatim.
    const mcpCalls = sendCalls.filter((m) => m.type === "mcp_set_servers");
    expect(mcpCalls.length).toBeGreaterThanOrEqual(1);
    const replayCall = mcpCalls[0];
    expect(replayCall.servers["companion-ide-neovim"]).toBeUndefined();
    expect(replayCall.servers.foo).toMatchObject(userFoo);
    expect(replayCall.deleteKeys ?? []).not.toContain("companion-ide-other");

    // ── Assertion 3: the strip logged a warning. Matches the format used
    // by `routeBrowserMessage`'s strip path for consistency.
    const warnCalls = warnSpy.mock.calls
      .map((args) => args.join(" "))
      .filter((line) => line.includes("companion-ide") || line.includes("reserved"));
    expect(warnCalls.length).toBeGreaterThan(0);

    warnSpy.mockRestore();
  });

  it("BIND-08g: prefix match only — `mycompanion-ide-helper` (substring only, not prefix) passes through unchanged", async () => {
    // Stripping must be PREFIX-MATCH, not SUBSTRING. A user registering a
    // server with "companion-ide" as a substring somewhere other than the
    // start of the key is not in our reserved namespace and must pass through.
    const { adapter, sendCalls } = makeFakeAdapter();
    bridge.getOrCreateSession("s1");
    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");
    bridge.attachBackendAdapter("s1", adapter, "claude");
    sendCalls.length = 0;

    const helperConfig = { type: "stdio" as const, command: "/usr/bin/helper" };
    bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "mcp_set_servers",
        servers: { "mycompanion-ide-helper": helperConfig },
      }),
    );

    const mcpCalls = sendCalls.filter((m) => m.type === "mcp_set_servers");
    expect(mcpCalls).toHaveLength(1);
    // Non-reserved: substring match but NOT prefix — must pass through.
    expect(mcpCalls[0].servers["mycompanion-ide-helper"]).toMatchObject(helperConfig);

    const session = bridge.getSession("s1")!;
    expect(session.dynamicMcpServers["mycompanion-ide-helper"]).toMatchObject(helperConfig);
  });
});

// ─── IDE list change broadcast (Task 12, DISC-03 UX side) ─────────────────────
//
// Pins the contract: when `companionBus` fires `ide:added`, `ide:removed`, or
// `ide:changed`, ws-bridge broadcasts `{type: "ide_list_changed"}` to EVERY
// connected browser socket across ALL sessions. The broadcast is payload-free
// (no sensitive fields leak) — IdePicker instances refetch via REST on receipt.
describe("IDE list change broadcast (Task 12)", () => {
  beforeEach(() => {
    // The outer beforeEach creates a fresh bridge but then calls
    // companionBus.clear() which wipes out the constructor subscriptions.
    // Recreate the bridge AFTER clear so the Task 12 subscriptions are live.
    bridge = new WsBridge();
    bridge.setStore(store);
  });

  it("ide:added → every connected browser socket receives one {type: ide_list_changed}", () => {
    // Two sessions, multiple browsers each — the broadcast must fan out
    // across sessions, not only to the session the event relates to.
    const b1a = makeBrowserSocket("s1");
    const b1b = makeBrowserSocket("s1");
    const b2 = makeBrowserSocket("s2");
    bridge.handleBrowserOpen(b1a, "s1");
    bridge.handleBrowserOpen(b1b, "s1");
    bridge.handleBrowserOpen(b2, "s2");
    b1a.send.mockClear();
    b1b.send.mockClear();
    b2.send.mockClear();

    companionBus.emit("ide:added", {
      port: 40001,
      ideName: "Neovim",
      workspaceFolders: ["/tmp/proj"],
      lockfilePath: "/tmp/.claude/ide/40001.lock",
      generation: 1,
    });

    for (const browser of [b1a, b1b, b2]) {
      const listChanges = browser.send.mock.calls
        .map(([raw]: [string]) => JSON.parse(raw))
        .filter((m: any) => m.type === "ide_list_changed");
      expect(listChanges).toHaveLength(1);
    }
  });

  it("ide:removed → every browser receives {type: ide_list_changed}", () => {
    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");
    browser.send.mockClear();

    companionBus.emit("ide:removed", {
      port: 40002,
      lockfilePath: "/tmp/.claude/ide/40002.lock",
      generation: 2,
    });

    const listChanges = browser.send.mock.calls
      .map(([raw]: [string]) => JSON.parse(raw))
      .filter((m: any) => m.type === "ide_list_changed");
    expect(listChanges).toHaveLength(1);
  });

  it("ide:changed → every browser receives {type: ide_list_changed}", () => {
    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");
    browser.send.mockClear();

    companionBus.emit("ide:changed", {
      port: 40003,
      ideName: "VS Code",
      workspaceFolders: ["/tmp/proj-new"],
      lockfilePath: "/tmp/.claude/ide/40003.lock",
      generation: 3,
    });

    const listChanges = browser.send.mock.calls
      .map(([raw]: [string]) => JSON.parse(raw))
      .filter((m: any) => m.type === "ide_list_changed");
    expect(listChanges).toHaveLength(1);
  });

  it("broadcast payload is exactly {type: ide_list_changed} — no sensitive fields leak", () => {
    // The ide:added event carries authToken-adjacent fields (lockfilePath,
    // port, workspaceFolders, ideName). The browser broadcast must NOT
    // include any of those — clients refetch through the authenticated
    // REST endpoint which applies the same trust boundary as discovery.
    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");
    browser.send.mockClear();

    companionBus.emit("ide:added", {
      port: 40004,
      ideName: "Neovim",
      workspaceFolders: ["/secret/path"],
      lockfilePath: "/secret/path/.claude/ide/40004.lock",
      generation: 4,
    });

    const listChanges = browser.send.mock.calls
      .map(([raw]: [string]) => JSON.parse(raw))
      .filter((m: any) => m.type === "ide_list_changed");
    expect(listChanges).toHaveLength(1);
    // Exact-equality assertion is the strongest form — any additional key
    // (e.g. a payload that copies the event verbatim) fails this test.
    // `generation` is the ONLY additional field clients use for dedupe —
    // still no authToken / lockfilePath / workspaceFolders leak.
    expect(listChanges[0]).toEqual({ type: "ide_list_changed", generation: 4 });
  });
});
