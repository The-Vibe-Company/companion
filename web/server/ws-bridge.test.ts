import { vi } from "vitest";

const mockExecSync = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ execSync: mockExecSync }));
vi.mock("node:crypto", () => ({ randomUUID: () => "test-uuid" }));

import { WsBridge, type SocketData } from "./ws-bridge.js";
import { SessionStore } from "./session-store.js";
import { containerManager } from "./container-manager.js";
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
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
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
    expect(session.cliSocket).toBeNull();
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

// ─── CLI handlers ────────────────────────────────────────────────────────────

describe("CLI handlers", () => {
  it("handleCLIOpen: sets cliSocket and broadcasts cli_connected", () => {
    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");
    // Clear session_init send calls
    browser.send.mockClear();

    const cli = makeCliSocket("s1");
    bridge.handleCLIOpen(cli, "s1");

    const session = bridge.getSession("s1")!;
    expect(session.cliSocket).toBe(cli);
    expect(bridge.isCliConnected("s1")).toBe(true);

    // Should have broadcast cli_connected
    const calls = browser.send.mock.calls.map(([arg]: [string]) =>
      JSON.parse(arg),
    );
    expect(calls).toContainEqual(
      expect.objectContaining({ type: "cli_connected" }),
    );
  });

  it("handleCLIOpen: flushes pending messages immediately", () => {
    // Per the SDK protocol, the first user message triggers system.init,
    // so queued messages must be flushed as soon as the CLI WebSocket connects
    // (not deferred until system.init, which would create a deadlock for
    // slow-starting sessions like Docker containers).
    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");

    bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "user_message",
        content: "hello queued",
      }),
    );

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

  it("handleCLIMessage: system.init does not re-flush already-sent messages", () => {
    // Messages are flushed on CLI connect, so by the time system.init
    // arrives the queue should already be empty.
    mockExecSync.mockImplementation(() => {
      throw new Error("not a git repo");
    });

    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");

    bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "user_message",
        content: "hello queued",
      }),
    );

    const session = bridge.getSession("s1")!;
    expect(session.pendingMessages.length).toBe(1);

    // Connect CLI — messages flushed immediately
    const cli = makeCliSocket("s1");
    bridge.handleCLIOpen(cli, "s1");
    expect(session.pendingMessages).toEqual([]);
    const sendCountAfterOpen = cli.send.mock.calls.length;

    // Send system.init — no additional flush should happen
    bridge.handleCLIMessage(cli, makeInitMsg());

    // Verify no additional user messages were sent after system.init
    const newCalls = cli.send.mock.calls.slice(sendCountAfterOpen);
    const userMsgAfterInit = newCalls.find(([arg]: [string]) =>
      arg.includes('"type":"user"'),
    );
    expect(userMsgAfterInit).toBeUndefined();
  });

  it("handleCLIMessage: parses NDJSON and routes system.init", () => {
    mockExecSync.mockImplementation(() => {
      throw new Error("not a git repo");
    });

    const cli = makeCliSocket("s1");
    const browser = makeBrowserSocket("s1");
    bridge.handleCLIOpen(cli, "s1");
    bridge.handleBrowserOpen(browser, "s1");
    browser.send.mockClear();

    bridge.handleCLIMessage(cli, makeInitMsg());

    const session = bridge.getSession("s1")!;
    expect(session.state.model).toBe("claude-sonnet-4-6");
    expect(session.state.cwd).toBe("/test");

    // Should broadcast session_init to browser
    const calls = browser.send.mock.calls.map(([arg]: [string]) =>
      JSON.parse(arg),
    );
    const initCall = calls.find((c: any) => c.type === "session_init");
    expect(initCall).toBeDefined();
    expect(initCall.session.model).toBe("claude-sonnet-4-6");
  });

  it("handleCLIMessage: system.init fires onCLISessionIdReceived callback", () => {
    mockExecSync.mockImplementation(() => {
      throw new Error("not a git repo");
    });

    const callback = vi.fn();
    bridge.onCLISessionIdReceived(callback);

    const cli = makeCliSocket("s1");
    bridge.handleCLIOpen(cli, "s1");
    bridge.handleCLIMessage(
      cli,
      makeInitMsg({ session_id: "cli-internal-id" }),
    );

    expect(callback).toHaveBeenCalledWith("s1", "cli-internal-id");
  });

  it("handleCLIMessage: updates state from init (model, cwd, tools, permissionMode)", () => {
    mockExecSync.mockImplementation(() => {
      throw new Error("not a git repo");
    });

    const cli = makeCliSocket("s1");
    bridge.handleCLIOpen(cli, "s1");

    bridge.handleCLIMessage(
      cli,
      makeInitMsg({
        model: "claude-opus-4-5-20250929",
        cwd: "/workspace",
        tools: ["Bash", "Read", "Edit"],
        permissionMode: "bypassPermissions",
        claude_code_version: "2.0",
        mcp_servers: [{ name: "test-mcp", status: "connected" }],
        agents: ["agent1"],
        slash_commands: ["/commit"],
        skills: ["pdf"],
      }),
    );

    const state = bridge.getSession("s1")!.state;
    expect(state.model).toBe("claude-opus-4-5-20250929");
    expect(state.cwd).toBe("/workspace");
    expect(state.tools).toEqual(["Bash", "Read", "Edit"]);
    expect(state.permissionMode).toBe("bypassPermissions");
    expect(state.claude_code_version).toBe("2.0");
    expect(state.mcp_servers).toEqual([
      { name: "test-mcp", status: "connected" },
    ]);
    expect(state.agents).toEqual(["agent1"]);
    expect(state.slash_commands).toEqual(["/commit"]);
    expect(state.skills).toEqual(["pdf"]);
  });

  it("handleCLIMessage: system.init preserves host cwd for containerized sessions", () => {
    // markContainerized sets the host cwd and is_containerized before CLI connects
    bridge.markContainerized("s1", "/Users/stan/Dev/myproject");

    mockExecSync.mockImplementation(() => {
      throw new Error("container not tracked");
    });

    const cli = makeCliSocket("s1");
    bridge.handleCLIOpen(cli, "s1");

    // CLI inside the container reports /workspace — should be ignored
    bridge.handleCLIMessage(cli, makeInitMsg({ cwd: "/workspace" }));

    const state = bridge.getSession("s1")!.state;
    expect(state.cwd).toBe("/Users/stan/Dev/myproject");
    expect(state.is_containerized).toBe(true);
  });

  it("handleCLIMessage: keeps previous git info when container metadata is temporarily unavailable", () => {
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
    bridge.handleCLIMessage(cli, makeInitMsg({ cwd: "/workspace" }));

    const state = bridge.getSession("s1")!.state;
    expect(state.git_branch).toBe("existing-branch");
    expect(state.repo_root).toBe("/workspace");
    expect(state.git_ahead).toBe(2);
    expect(state.git_behind).toBe(1);
  });

  it("handleCLIMessage: resolves git info from container for containerized sessions", () => {
    bridge.markContainerized("s1", "/Users/stan/Dev/myproject");
    const getContainerSpy = vi
      .spyOn(containerManager, "getContainer")
      .mockReturnValue({
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
    bridge.handleCLIMessage(cli, makeInitMsg({ cwd: "/workspace" }));

    const state = bridge.getSession("s1")!.state;
    expect(state.cwd).toBe("/Users/stan/Dev/myproject");
    expect(state.git_branch).toBe("container-branch");
    expect(state.repo_root).toBe("/Users/stan/Dev/myproject");
    expect(state.git_behind).toBe(1);
    expect(state.git_ahead).toBe(3);
    expect(getContainerSpy).toHaveBeenCalledWith("s1");
    getContainerSpy.mockRestore();
  });

  it("handleCLIMessage: maps nested container repo_root paths back to host paths", () => {
    bridge.markContainerized("s1", "/Users/stan/Dev/myproject");
    const getContainerSpy = vi
      .spyOn(containerManager, "getContainer")
      .mockReturnValue({
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
    bridge.handleCLIMessage(cli, makeInitMsg({ cwd: "/workspace" }));

    const state = bridge.getSession("s1")!.state;
    expect(state.repo_root).toBe("/Users/stan/Dev/myproject/packages/api");
    expect(getContainerSpy).toHaveBeenCalledWith("s1");
    getContainerSpy.mockRestore();
  });

  it("handleCLIMessage: system.init resolves git info via execSync", () => {
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("--abbrev-ref HEAD")) return "feat/test-branch\n";
      if (cmd.includes("--show-toplevel")) return "/repo\n";
      if (cmd.includes("--left-right --count")) return "2\t5\n";
      throw new Error("unknown git cmd");
    });

    const cli = makeCliSocket("s1");
    bridge.handleCLIOpen(cli, "s1");
    bridge.handleCLIMessage(cli, makeInitMsg());

    const state = bridge.getSession("s1")!.state;
    expect(state.git_branch).toBe("feat/test-branch");
    expect(state.repo_root).toBe("/repo");
    expect(state.git_ahead).toBe(5);
    expect(state.git_behind).toBe(2);
  });

  it("handleCLIMessage: system.init resolves repo_root via --show-toplevel for standard repo", () => {
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("--abbrev-ref HEAD")) return "main\n";
      if (cmd.includes("--git-dir")) return ".git\n";
      if (cmd.includes("--show-toplevel")) return "/home/user/myproject\n";
      if (cmd.includes("--left-right --count")) return "0\t0\n";
      throw new Error("unknown git cmd");
    });

    const cli = makeCliSocket("s1");
    bridge.handleCLIOpen(cli, "s1");
    bridge.handleCLIMessage(cli, makeInitMsg({ cwd: "/home/user/myproject" }));

    const state = bridge.getSession("s1")!.state;
    expect(state.repo_root).toBe("/home/user/myproject");
  });

  it("handleCLIMessage: system.status updates compacting and permissionMode", () => {
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

    bridge.handleCLIMessage(cli, statusMsg);

    const state = bridge.getSession("s1")!.state;
    expect(state.is_compacting).toBe(true);
    expect(state.permissionMode).toBe("plan");

    const calls = browser.send.mock.calls.map(([arg]: [string]) =>
      JSON.parse(arg),
    );
    expect(calls).toContainEqual(
      expect.objectContaining({ type: "status_change", status: "compacting" }),
    );
  });

  it("handleCLIMessage: forwards compact_boundary as system_event and persists it", () => {
    const cli = makeCliSocket("s1");
    const browser = makeBrowserSocket("s1");
    bridge.handleCLIOpen(cli, "s1");
    bridge.handleBrowserOpen(browser, "s1");
    browser.send.mockClear();

    bridge.handleCLIMessage(
      cli,
      JSON.stringify({
        type: "system",
        subtype: "compact_boundary",
        compact_metadata: { trigger: "auto", pre_tokens: 4096 },
        uuid: "uuid-compact",
        session_id: "s1",
      }),
    );

    const session = bridge.getSession("s1")!;
    expect(session.messageHistory).toHaveLength(1);
    expect(session.messageHistory[0]).toMatchObject({
      type: "system_event",
      event: {
        subtype: "compact_boundary",
      },
    });

    const calls = browser.send.mock.calls.map(([arg]: [string]) =>
      JSON.parse(arg),
    );
    const forwarded = calls.find((c: any) => c.type === "system_event");
    expect(forwarded).toBeDefined();
    expect(forwarded.event.subtype).toBe("compact_boundary");
  });

  it("handleCLIMessage: forwards hook_progress as system_event without persisting history", () => {
    const cli = makeCliSocket("s1");
    const browser = makeBrowserSocket("s1");
    bridge.handleCLIOpen(cli, "s1");
    bridge.handleBrowserOpen(browser, "s1");
    browser.send.mockClear();

    bridge.handleCLIMessage(
      cli,
      JSON.stringify({
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
      }),
    );

    const session = bridge.getSession("s1")!;
    expect(session.messageHistory).toHaveLength(0);

    const calls = browser.send.mock.calls.map(([arg]: [string]) =>
      JSON.parse(arg),
    );
    const forwarded = calls.find((c: any) => c.type === "system_event");
    expect(forwarded).toBeDefined();
    expect(forwarded.event.subtype).toBe("hook_progress");
  });

  it("handleCLIClose: nulls cliSocket and broadcasts cli_disconnected", () => {
    const cli = makeCliSocket("s1");
    const browser = makeBrowserSocket("s1");
    bridge.handleCLIOpen(cli, "s1");
    bridge.handleBrowserOpen(browser, "s1");
    browser.send.mockClear();

    bridge.handleCLIClose(cli);

    const session = bridge.getSession("s1")!;
    expect(session.cliSocket).toBeNull();
    expect(bridge.isCliConnected("s1")).toBe(false);

    const calls = browser.send.mock.calls.map(([arg]: [string]) =>
      JSON.parse(arg),
    );
    expect(calls).toContainEqual(
      expect.objectContaining({ type: "cli_disconnected" }),
    );
  });

  it("handleCLIClose: cancels pending permissions", () => {
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
    bridge.handleCLIMessage(cli, controlReq);
    browser.send.mockClear();

    bridge.handleCLIClose(cli);

    const session = bridge.getSession("s1")!;
    expect(session.pendingPermissions.size).toBe(0);

    const calls = browser.send.mock.calls.map(([arg]: [string]) =>
      JSON.parse(arg),
    );
    const cancelMsg = calls.find((c: any) => c.type === "permission_cancelled");
    expect(cancelMsg).toBeDefined();
    expect(cancelMsg.request_id).toBe("req-1");
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
    bridge.onSessionGitInfoReadyCallback(gitInfoCb);

    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");

    const firstMsg = JSON.parse(browser.send.mock.calls[0][0]);
    expect(firstMsg.type).toBe("session_init");
    expect(firstMsg.session.git_branch).toBe("feat/dynamic-branch");
    expect(gitInfoCb).toHaveBeenCalledWith(
      "s1",
      "/repo",
      "feat/dynamic-branch",
    );
  });

  it("handleBrowserOpen: replays message history", () => {
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
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
      parent_tool_use_id: null,
      uuid: "uuid-2",
      session_id: "s1",
    });
    bridge.handleCLIMessage(cli, assistantMsg);

    // Now connect a new browser
    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");

    const calls = browser.send.mock.calls.map(([arg]: [string]) =>
      JSON.parse(arg),
    );
    const historyMsg = calls.find((c: any) => c.type === "message_history");
    expect(historyMsg).toBeDefined();
    expect(historyMsg.messages).toHaveLength(1);
    expect(historyMsg.messages[0].type).toBe("assistant");
  });

  it("handleBrowserOpen: sends pending permissions", () => {
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
    bridge.handleCLIMessage(cli, controlReq);

    // Now connect a browser
    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");

    const calls = browser.send.mock.calls.map(([arg]: [string]) =>
      JSON.parse(arg),
    );
    const permMsg = calls.find((c: any) => c.type === "permission_request");
    expect(permMsg).toBeDefined();
    expect(permMsg.request.tool_name).toBe("Edit");
    expect(permMsg.request.request_id).toBe("req-1");
  });

  it("handleBrowserOpen: triggers relaunch callback when CLI is dead", () => {
    const relaunchCb = vi.fn();
    bridge.onCLIRelaunchNeededCallback(relaunchCb);

    bridge.getOrCreateSession("s1");
    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");

    expect(relaunchCb).toHaveBeenCalledWith("s1");

    // Also sends cli_disconnected
    const calls = browser.send.mock.calls.map(([arg]: [string]) =>
      JSON.parse(arg),
    );
    const disconnectedMsg = calls.find(
      (c: any) => c.type === "cli_disconnected",
    );
    expect(disconnectedMsg).toBeDefined();
  });

  it("handleBrowserOpen: does NOT relaunch when Codex adapter is attached but still initializing", () => {
    const relaunchCb = vi.fn();
    bridge.onCLIRelaunchNeededCallback(relaunchCb);

    const session = bridge.getOrCreateSession("s1", "codex");
    session.codexAdapter = { isConnected: () => false } as any;

    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");

    expect(relaunchCb).not.toHaveBeenCalled();

    const calls = browser.send.mock.calls.map(([arg]: [string]) =>
      JSON.parse(arg),
    );
    const disconnectedMsg = calls.find(
      (c: any) => c.type === "cli_disconnected",
    );
    expect(disconnectedMsg).toBeUndefined();
  });

  it("handleBrowserClose: removes from set", () => {
    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");
    expect(bridge.getSession("s1")!.browserSockets.has(browser)).toBe(true);

    bridge.handleBrowserClose(browser);
    expect(bridge.getSession("s1")!.browserSockets.has(browser)).toBe(false);
  });

  it("session_subscribe: replays buffered sequenced events after last_seq", () => {
    const cli = makeCliSocket("s1");
    bridge.handleCLIOpen(cli, "s1");

    // Generate replayable events while no browser is connected.
    bridge.handleCLIMessage(
      cli,
      JSON.stringify({
        type: "stream_event",
        event: {
          type: "content_block_delta",
          delta: { type: "text_delta", text: "a" },
        },
        parent_tool_use_id: null,
        uuid: "u1",
        session_id: "s1",
      }),
    );
    bridge.handleCLIMessage(
      cli,
      JSON.stringify({
        type: "stream_event",
        event: {
          type: "content_block_delta",
          delta: { type: "text_delta", text: "b" },
        },
        parent_tool_use_id: null,
        uuid: "u2",
        session_id: "s1",
      }),
    );

    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");
    browser.send.mockClear();

    // Ask for replay after seq=1 (cli_connected). Both stream events should replay.
    bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "session_subscribe",
        last_seq: 1,
      }),
    );

    const calls = browser.send.mock.calls.map(([arg]: [string]) =>
      JSON.parse(arg),
    );
    const replay = calls.find((c: any) => c.type === "event_replay");
    expect(replay).toBeDefined();
    expect(replay.events).toHaveLength(2);
    expect(replay.events[0].seq).toBe(2);
    expect(replay.events[0].message.type).toBe("stream_event");
  });

  it("session_subscribe: falls back to message_history when last_seq is older than buffer window", () => {
    const cli = makeCliSocket("s1");
    bridge.handleCLIOpen(cli, "s1");

    // Populate history so fallback payload has content.
    bridge.handleCLIMessage(
      cli,
      JSON.stringify({
        type: "assistant",
        message: {
          id: "hist-1",
          type: "message",
          role: "assistant",
          model: "claude-sonnet-4-6",
          content: [{ type: "text", text: "from history" }],
          stop_reason: "end_turn",
          usage: {
            input_tokens: 1,
            output_tokens: 1,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
        },
        parent_tool_use_id: null,
        uuid: "hist-u1",
        session_id: "s1",
      }),
    );

    // Generate several stream events, then trim the first one from in-memory buffer.
    bridge.handleCLIMessage(
      cli,
      JSON.stringify({
        type: "stream_event",
        event: {
          type: "content_block_delta",
          delta: { type: "text_delta", text: "1" },
        },
        parent_tool_use_id: null,
        uuid: "se-u1",
        session_id: "s1",
      }),
    );
    bridge.handleCLIMessage(
      cli,
      JSON.stringify({
        type: "stream_event",
        event: {
          type: "content_block_delta",
          delta: { type: "text_delta", text: "2" },
        },
        parent_tool_use_id: null,
        uuid: "se-u2",
        session_id: "s1",
      }),
    );
    const session = bridge.getSession("s1")!;
    session.eventBuffer.shift();
    session.eventBuffer.shift(); // force earliest seq high enough to create a gap for last_seq=1

    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");
    browser.send.mockClear();

    bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "session_subscribe",
        last_seq: 1,
      }),
    );

    const calls = browser.send.mock.calls.map(([arg]: [string]) =>
      JSON.parse(arg),
    );
    const historyMsg = calls.find((c: any) => c.type === "message_history");
    expect(historyMsg).toBeDefined();
    expect(historyMsg.messages.some((m: any) => m.type === "assistant")).toBe(
      true,
    );
    const replayMsg = calls.find((c: any) => c.type === "event_replay");
    expect(replayMsg).toBeDefined();
    expect(
      replayMsg.events.some((e: any) => e.message.type === "stream_event"),
    ).toBe(true);
  });

  it("session_subscribe: sends ground-truth status_change=idle after event_replay when last history is result", () => {
    // When the CLI finished (result in messageHistory), the server should send
    // a status_change after event_replay so the browser clears stale "running" state.
    const cli = makeCliSocket("s1");
    bridge.handleCLIOpen(cli, "s1");

    // Simulate a completed turn: assistant → result in history
    bridge.handleCLIMessage(
      cli,
      JSON.stringify({
        type: "assistant",
        message: {
          id: "a1",
          type: "message",
          role: "assistant",
          model: "claude-sonnet-4-6",
          content: [{ type: "text", text: "hello" }],
          stop_reason: "end_turn",
          usage: {
            input_tokens: 1,
            output_tokens: 1,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
        },
        parent_tool_use_id: null,
        uuid: "u1",
        session_id: "s1",
      }),
    );
    bridge.handleCLIMessage(
      cli,
      JSON.stringify({
        type: "result",
        is_error: false,
        total_cost_usd: 0.01,
        num_turns: 1,
        session_id: "s1",
      }),
    );

    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");
    browser.send.mockClear();

    bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "session_subscribe",
        last_seq: 0,
      }),
    );

    const calls = browser.send.mock.calls.map(([arg]: [string]) =>
      JSON.parse(arg),
    );
    // Last message should be a status_change with idle
    const statusMsg = calls.filter((c: any) => c.type === "status_change");
    expect(statusMsg.length).toBeGreaterThanOrEqual(1);
    const lastStatus = statusMsg[statusMsg.length - 1];
    expect(lastStatus.status).toBe("idle");
  });

  it("session_subscribe: sends ground-truth status_change=running after event_replay when last history is assistant", () => {
    // When the CLI is mid-turn (assistant in messageHistory but no result yet),
    // the ground-truth status should be "running".
    const cli = makeCliSocket("s1");
    bridge.handleCLIOpen(cli, "s1");

    bridge.handleCLIMessage(
      cli,
      JSON.stringify({
        type: "assistant",
        message: {
          id: "a1",
          type: "message",
          role: "assistant",
          model: "claude-sonnet-4-6",
          content: [{ type: "text", text: "working on it" }],
          stop_reason: "end_turn",
          usage: {
            input_tokens: 1,
            output_tokens: 1,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
        },
        parent_tool_use_id: null,
        uuid: "u1",
        session_id: "s1",
      }),
    );

    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");
    browser.send.mockClear();

    bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "session_subscribe",
        last_seq: 0,
      }),
    );

    const calls = browser.send.mock.calls.map(([arg]: [string]) =>
      JSON.parse(arg),
    );
    const statusMsg = calls.filter((c: any) => c.type === "status_change");
    expect(statusMsg.length).toBeGreaterThanOrEqual(1);
    const lastStatus = statusMsg[statusMsg.length - 1];
    expect(lastStatus.status).toBe("running");
  });

  it("session_subscribe: sends status_change=idle in gap path when session completed", () => {
    // Even when falling back to message_history + transient replay,
    // a trailing status_change should correct stale state.
    const cli = makeCliSocket("s1");
    bridge.handleCLIOpen(cli, "s1");

    bridge.handleCLIMessage(
      cli,
      JSON.stringify({
        type: "assistant",
        message: {
          id: "a1",
          type: "message",
          role: "assistant",
          model: "claude-sonnet-4-6",
          content: [{ type: "text", text: "done" }],
          stop_reason: "end_turn",
          usage: {
            input_tokens: 1,
            output_tokens: 1,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
        },
        parent_tool_use_id: null,
        uuid: "u1",
        session_id: "s1",
      }),
    );
    bridge.handleCLIMessage(
      cli,
      JSON.stringify({
        type: "result",
        is_error: false,
        total_cost_usd: 0.01,
        num_turns: 1,
        session_id: "s1",
      }),
    );
    // Add a stream event and then force a gap by trimming the buffer
    bridge.handleCLIMessage(
      cli,
      JSON.stringify({
        type: "stream_event",
        event: {
          type: "content_block_delta",
          delta: { type: "text_delta", text: "x" },
        },
        parent_tool_use_id: null,
        uuid: "se1",
        session_id: "s1",
      }),
    );
    const session = bridge.getSession("s1")!;
    session.eventBuffer.shift(); // force a gap

    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");
    browser.send.mockClear();

    bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "session_subscribe",
        last_seq: 1,
      }),
    );

    const calls = browser.send.mock.calls.map(([arg]: [string]) =>
      JSON.parse(arg),
    );
    const statusMsg = calls.filter((c: any) => c.type === "status_change");
    expect(statusMsg.length).toBeGreaterThanOrEqual(1);
    expect(statusMsg[statusMsg.length - 1].status).toBe("idle");
  });

  it("session_ack: updates lastAckSeq for the session", () => {
    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");

    bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "session_ack",
        last_seq: 42,
      }),
    );

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

  it("assistant: stores in history and broadcasts", () => {
    const msg = JSON.stringify({
      type: "assistant",
      message: {
        id: "msg-1",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-4-6",
        content: [{ type: "text", text: "Hello world!" }],
        stop_reason: "end_turn",
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
      parent_tool_use_id: null,
      uuid: "uuid-3",
      session_id: "s1",
    });

    bridge.handleCLIMessage(cli, msg);

    const session = bridge.getSession("s1")!;
    expect(session.messageHistory).toHaveLength(1);
    expect(session.messageHistory[0].type).toBe("assistant");

    const calls = browser.send.mock.calls.map(([arg]: [string]) =>
      JSON.parse(arg),
    );
    const assistantBroadcast = calls.find((c: any) => c.type === "assistant");
    expect(assistantBroadcast).toBeDefined();
    expect(assistantBroadcast.message.content[0].text).toBe("Hello world!");
    expect(assistantBroadcast.parent_tool_use_id).toBeNull();
  });

  it("result: updates cost/turns/context% and stores + broadcasts", () => {
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
      usage: {
        input_tokens: 500,
        output_tokens: 200,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
      total_lines_added: 42,
      total_lines_removed: 10,
      uuid: "uuid-4",
      session_id: "s1",
    });

    bridge.handleCLIMessage(cli, msg);

    const state = bridge.getSession("s1")!.state;
    expect(state.total_cost_usd).toBe(0.05);
    expect(state.num_turns).toBe(3);
    expect(state.total_lines_added).toBe(42);
    expect(state.total_lines_removed).toBe(10);

    const session = bridge.getSession("s1")!;
    expect(session.messageHistory).toHaveLength(1);
    expect(session.messageHistory[0].type).toBe("result");

    const calls = browser.send.mock.calls.map(([arg]: [string]) =>
      JSON.parse(arg),
    );
    const resultBroadcast = calls.find((c: any) => c.type === "result");
    expect(resultBroadcast).toBeDefined();
    expect(resultBroadcast.data.total_cost_usd).toBe(0.05);
  });

  it("result: refreshes git branch and broadcasts session_update when branch changes", () => {
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
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
      uuid: "uuid-refresh-git",
      session_id: "s1",
    });

    bridge.handleCLIMessage(cli, msg);

    const calls = browser.send.mock.calls.map(([arg]: [string]) =>
      JSON.parse(arg),
    );
    const updateMsg = calls.find((c: any) => c.type === "session_update");
    expect(updateMsg).toBeDefined();
    expect(updateMsg.session.git_branch).toBe("feat/new-branch");
    expect(updateMsg.session.git_ahead).toBe(1);
    expect(bridge.getSession("s1")!.state.git_branch).toBe("feat/new-branch");
  });

  it("result: computes context_used_percent from modelUsage (fallback without prior assistant)", () => {
    const msg = JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      duration_ms: 5000,
      duration_api_ms: 4000,
      num_turns: 1,
      total_cost_usd: 0.02,
      stop_reason: "end_turn",
      usage: {
        input_tokens: 500,
        output_tokens: 200,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
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

    bridge.handleCLIMessage(cli, msg);

    const state = bridge.getSession("s1")!.state;
    // No prior assistant message → fallback: (8000 + 2000) / 200000 * 100 = 5
    expect(state.context_used_percent).toBe(5);
  });

  it("result: recomputes context_used_percent using per-turn data from assistant + contextWindow from modelUsage", () => {
    // First: assistant message provides per-turn token usage
    const assistantMsg = JSON.stringify({
      type: "assistant",
      message: {
        id: "msg-1",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-4-6",
        content: [{ type: "text", text: "Hello" }],
        stop_reason: "end_turn",
        usage: {
          input_tokens: 50000,
          output_tokens: 1000,
          cache_read_input_tokens: 100000,
          cache_creation_input_tokens: 10000,
        },
      },
      parent_tool_use_id: null,
      uuid: "uuid-a1",
      session_id: "s1",
    });
    bridge.handleCLIMessage(cli, assistantMsg);

    // Then: result message provides contextWindow
    const resultMsg = JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      duration_ms: 5000,
      duration_api_ms: 4000,
      num_turns: 1,
      total_cost_usd: 0.05,
      stop_reason: "end_turn",
      usage: {
        input_tokens: 50000,
        output_tokens: 1000,
        cache_creation_input_tokens: 10000,
        cache_read_input_tokens: 100000,
      },
      modelUsage: {
        "claude-sonnet-4-6": {
          inputTokens: 50000,
          outputTokens: 1000,
          cacheReadInputTokens: 100000,
          cacheCreationInputTokens: 10000,
          contextWindow: 200000,
          maxOutputTokens: 16384,
          costUSD: 0.05,
        },
      },
      uuid: "uuid-r1",
      session_id: "s1",
    });
    bridge.handleCLIMessage(cli, resultMsg);

    const state = bridge.getSession("s1")!.state;
    // Per-turn formula: (50000 + 100000 + 10000) / 200000 * 100 = 80
    expect(state.context_used_percent).toBe(80);
    expect(state.claude_token_details).toEqual({
      inputTokens: 50000,
      outputTokens: 1000,
      cacheReadInputTokens: 100000,
      cacheCreationInputTokens: 10000,
      contextWindow: 200000,
      maxOutputTokens: 16384,
    });
  });

  it("stream_event: broadcasts without storing", () => {
    const msg = JSON.stringify({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        delta: { type: "text_delta", text: "hi" },
      },
      parent_tool_use_id: null,
      uuid: "uuid-6",
      session_id: "s1",
    });

    bridge.handleCLIMessage(cli, msg);

    const session = bridge.getSession("s1")!;
    expect(session.messageHistory).toHaveLength(0);

    const calls = browser.send.mock.calls.map(([arg]: [string]) =>
      JSON.parse(arg),
    );
    const streamEvent = calls.find((c: any) => c.type === "stream_event");
    expect(streamEvent).toBeDefined();
    expect(streamEvent.event.delta.text).toBe("hi");
    expect(streamEvent.parent_tool_use_id).toBeNull();
  });

  it("control_request (can_use_tool): adds to pending and broadcasts", () => {
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
        permission_suggestions: [
          {
            type: "addRules",
            rules: [{ toolName: "Bash" }],
            behavior: "allow",
            destination: "session",
          },
        ],
      },
    });

    bridge.handleCLIMessage(cli, msg);

    const session = bridge.getSession("s1")!;
    expect(session.pendingPermissions.size).toBe(1);
    const perm = session.pendingPermissions.get("req-42")!;
    expect(perm.tool_name).toBe("Bash");
    expect(perm.input).toEqual({ command: "ls -la" });
    expect(perm.description).toBe("List files");
    expect(perm.tool_use_id).toBe("tu-42");
    expect(perm.agent_id).toBe("agent-1");
    expect(perm.timestamp).toBeGreaterThan(0);

    const calls = browser.send.mock.calls.map(([arg]: [string]) =>
      JSON.parse(arg),
    );
    const permBroadcast = calls.find(
      (c: any) => c.type === "permission_request",
    );
    expect(permBroadcast).toBeDefined();
    expect(permBroadcast.request.request_id).toBe("req-42");
    expect(permBroadcast.request.tool_name).toBe("Bash");
  });

  it("tool_progress: broadcasts", () => {
    const msg = JSON.stringify({
      type: "tool_progress",
      tool_use_id: "tu-10",
      tool_name: "Bash",
      parent_tool_use_id: null,
      elapsed_time_seconds: 3.5,
      uuid: "uuid-7",
      session_id: "s1",
    });

    bridge.handleCLIMessage(cli, msg);

    const calls = browser.send.mock.calls.map(([arg]: [string]) =>
      JSON.parse(arg),
    );
    const progressMsg = calls.find((c: any) => c.type === "tool_progress");
    expect(progressMsg).toBeDefined();
    expect(progressMsg.tool_use_id).toBe("tu-10");
    expect(progressMsg.tool_name).toBe("Bash");
    expect(progressMsg.elapsed_time_seconds).toBe(3.5);
  });

  it("tool_use_summary: broadcasts", () => {
    const msg = JSON.stringify({
      type: "tool_use_summary",
      summary: "Ran bash command successfully",
      preceding_tool_use_ids: ["tu-10", "tu-11"],
      uuid: "uuid-8",
      session_id: "s1",
    });

    bridge.handleCLIMessage(cli, msg);

    const calls = browser.send.mock.calls.map(([arg]: [string]) =>
      JSON.parse(arg),
    );
    const summaryMsg = calls.find((c: any) => c.type === "tool_use_summary");
    expect(summaryMsg).toBeDefined();
    expect(summaryMsg.summary).toBe("Ran bash command successfully");
    expect(summaryMsg.tool_use_ids).toEqual(["tu-10", "tu-11"]);
  });

  it("keep_alive: silently consumed, no broadcast", () => {
    const msg = JSON.stringify({ type: "keep_alive" });

    bridge.handleCLIMessage(cli, msg);

    expect(browser.send).not.toHaveBeenCalled();
  });

  it("multi-line NDJSON: processes both lines", () => {
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

    bridge.handleCLIMessage(cli, line1 + "\n" + line2);

    const calls = browser.send.mock.calls.map(([arg]: [string]) =>
      JSON.parse(arg),
    );
    const progressMsgs = calls.filter((c: any) => c.type === "tool_progress");
    expect(progressMsgs).toHaveLength(2);
    expect(progressMsgs[0].tool_use_id).toBe("tu-a");
    expect(progressMsgs[1].tool_use_id).toBe("tu-b");
  });

  it("malformed JSON: skips gracefully without crashing", () => {
    const validLine = JSON.stringify({ type: "keep_alive" });
    const raw = "not-valid-json\n" + validLine;

    // Should not throw
    expect(() => bridge.handleCLIMessage(cli, raw)).not.toThrow();
    // keep_alive is silently consumed, so no broadcast
    expect(browser.send).not.toHaveBeenCalled();
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
    bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "user_message",
        content: "What is 2+2?",
      }),
    );

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

    bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "user_message",
        content: "queued message",
      }),
    );

    const session = bridge.getSession("s1")!;
    expect(session.pendingMessages).toHaveLength(1);
    const queued = JSON.parse(session.pendingMessages[0]);
    expect(queued.type).toBe("user");
    expect(queued.message.content).toBe("queued message");
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
    const userMessages = session.messageHistory.filter(
      (m) => m.type === "user_message",
    );
    expect(userMessages).toHaveLength(1);
  });

  it("user_message with images: builds content blocks", () => {
    bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "user_message",
        content: "What's in this image?",
        images: [{ media_type: "image/png", data: "base64data==" }],
      }),
    );

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

  it("permission_response allow: sends control_response to CLI", () => {
    // First create a pending permission
    bridge.handleCLIMessage(
      cli,
      JSON.stringify({
        type: "control_request",
        request_id: "req-allow",
        request: {
          subtype: "can_use_tool",
          tool_name: "Bash",
          input: { command: "echo hi" },
          tool_use_id: "tu-allow",
        },
      }),
    );
    cli.send.mockClear();

    bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "permission_response",
        request_id: "req-allow",
        behavior: "allow",
      }),
    );

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

  it("permission_response deny: sends deny response to CLI", () => {
    // Create a pending permission
    bridge.handleCLIMessage(
      cli,
      JSON.stringify({
        type: "control_request",
        request_id: "req-deny",
        request: {
          subtype: "can_use_tool",
          tool_name: "Bash",
          input: { command: "rm -rf /" },
          tool_use_id: "tu-deny",
        },
      }),
    );
    cli.send.mockClear();

    bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "permission_response",
        request_id: "req-deny",
        behavior: "deny",
        message: "Too dangerous",
      }),
    );

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

  it("permission_response: deduplicates repeated client_msg_id", () => {
    bridge.handleCLIMessage(
      cli,
      JSON.stringify({
        type: "control_request",
        request_id: "req-dedupe",
        request: {
          subtype: "can_use_tool",
          tool_name: "Bash",
          input: { command: "echo hi" },
          tool_use_id: "tu-dedupe",
        },
      }),
    );
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
    bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "interrupt",
      }),
    );

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
    bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "set_model",
        model: "claude-opus-4-5-20250929",
      }),
    );

    expect(cli.send).toHaveBeenCalledTimes(1);
    const sentRaw = cli.send.mock.calls[0][0] as string;
    const sent = JSON.parse(sentRaw.trim());
    expect(sent.type).toBe("control_request");
    expect(sent.request_id).toBe("test-uuid");
    expect(sent.request.subtype).toBe("set_model");
    expect(sent.request.model).toBe("claude-opus-4-5-20250929");
  });

  it("set_permission_mode: sends control_request with set_permission_mode subtype to CLI", () => {
    bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "set_permission_mode",
        mode: "bypassPermissions",
      }),
    );

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
    expect(session!.cliSocket).toBeNull();
    expect(session!.browserSockets.size).toBe(0);
    expect(session!.processedClientMessageIdSet.has("restored-client-1")).toBe(
      true,
    );
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

  it("persistSession: called after state changes (via store.save)", () => {
    mockExecSync.mockImplementation(() => {
      throw new Error("not a git repo");
    });

    const saveSpy = vi.spyOn(store, "save");

    const cli = makeCliSocket("s1");
    bridge.handleCLIOpen(cli, "s1");

    // system.init should trigger persist
    bridge.handleCLIMessage(cli, makeInitMsg());
    expect(saveSpy).toHaveBeenCalled();

    const lastCall = saveSpy.mock.calls[saveSpy.mock.calls.length - 1][0];
    expect(lastCall.id).toBe("s1");
    expect(lastCall.state.model).toBe("claude-sonnet-4-6");

    saveSpy.mockClear();

    // assistant message should trigger persist
    bridge.handleCLIMessage(
      cli,
      JSON.stringify({
        type: "assistant",
        message: {
          id: "msg-1",
          type: "message",
          role: "assistant",
          model: "claude-sonnet-4-6",
          content: [{ type: "text", text: "Test" }],
          stop_reason: "end_turn",
          usage: {
            input_tokens: 10,
            output_tokens: 5,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
        },
        parent_tool_use_id: null,
        uuid: "uuid-p1",
        session_id: "s1",
      }),
    );
    expect(saveSpy).toHaveBeenCalled();

    saveSpy.mockClear();

    // result message should trigger persist
    bridge.handleCLIMessage(
      cli,
      JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        duration_ms: 1000,
        duration_api_ms: 800,
        num_turns: 1,
        total_cost_usd: 0.01,
        stop_reason: "end_turn",
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
        uuid: "uuid-p2",
        session_id: "s1",
      }),
    );
    expect(saveSpy).toHaveBeenCalled();

    saveSpy.mockClear();

    // control_request (can_use_tool) should trigger persist
    bridge.handleCLIMessage(
      cli,
      JSON.stringify({
        type: "control_request",
        request_id: "req-persist",
        request: {
          subtype: "can_use_tool",
          tool_name: "Bash",
          input: { command: "echo test" },
          tool_use_id: "tu-persist",
        },
      }),
    );
    expect(saveSpy).toHaveBeenCalled();

    saveSpy.mockClear();

    // user message from browser should trigger persist
    const browserWs = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browserWs, "s1");
    bridge.handleBrowserMessage(
      browserWs,
      JSON.stringify({
        type: "user_message",
        content: "test persist",
      }),
    );
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

  it("broadcasts auth_status with isAuthenticating: true", () => {
    const msg = JSON.stringify({
      type: "auth_status",
      isAuthenticating: true,
      output: ["Waiting for authentication..."],
      uuid: "uuid-auth-1",
      session_id: "s1",
    });

    bridge.handleCLIMessage(cli, msg);

    const calls = browser.send.mock.calls.map(([arg]: [string]) =>
      JSON.parse(arg),
    );
    const authMsg = calls.find((c: any) => c.type === "auth_status");
    expect(authMsg).toBeDefined();
    expect(authMsg.isAuthenticating).toBe(true);
    expect(authMsg.output).toEqual(["Waiting for authentication..."]);
    expect(authMsg.error).toBeUndefined();
  });

  it("broadcasts auth_status with isAuthenticating: false", () => {
    const msg = JSON.stringify({
      type: "auth_status",
      isAuthenticating: false,
      output: ["Authentication complete"],
      uuid: "uuid-auth-2",
      session_id: "s1",
    });

    bridge.handleCLIMessage(cli, msg);

    const calls = browser.send.mock.calls.map(([arg]: [string]) =>
      JSON.parse(arg),
    );
    const authMsg = calls.find((c: any) => c.type === "auth_status");
    expect(authMsg).toBeDefined();
    expect(authMsg.isAuthenticating).toBe(false);
    expect(authMsg.output).toEqual(["Authentication complete"]);
  });

  it("broadcasts auth_status with error field", () => {
    const msg = JSON.stringify({
      type: "auth_status",
      isAuthenticating: false,
      output: ["Failed to authenticate"],
      error: "Token expired",
      uuid: "uuid-auth-3",
      session_id: "s1",
    });

    bridge.handleCLIMessage(cli, msg);

    const calls = browser.send.mock.calls.map(([arg]: [string]) =>
      JSON.parse(arg),
    );
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

  it("allow with updated_permissions forwards updatedPermissions in control_response", () => {
    // Create pending permission
    bridge.handleCLIMessage(
      cli,
      JSON.stringify({
        type: "control_request",
        request_id: "req-perm-update",
        request: {
          subtype: "can_use_tool",
          tool_name: "Bash",
          input: { command: "echo hello" },
          tool_use_id: "tu-perm-update",
        },
      }),
    );
    cli.send.mockClear();

    const updatedPermissions = [
      {
        type: "addRules",
        rules: [{ toolName: "Bash", ruleContent: "echo *" }],
        behavior: "allow",
        destination: "session",
      },
    ];

    bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "permission_response",
        request_id: "req-perm-update",
        behavior: "allow",
        updated_permissions: updatedPermissions,
      }),
    );

    expect(cli.send).toHaveBeenCalledTimes(1);
    const sentRaw = cli.send.mock.calls[0][0] as string;
    const sent = JSON.parse(sentRaw.trim());
    expect(sent.type).toBe("control_response");
    expect(sent.response.response.behavior).toBe("allow");
    expect(sent.response.response.updatedPermissions).toEqual(
      updatedPermissions,
    );
  });

  it("allow without updated_permissions does not include updatedPermissions key", () => {
    // Create pending permission
    bridge.handleCLIMessage(
      cli,
      JSON.stringify({
        type: "control_request",
        request_id: "req-no-perm",
        request: {
          subtype: "can_use_tool",
          tool_name: "Read",
          input: { file_path: "/test.ts" },
          tool_use_id: "tu-no-perm",
        },
      }),
    );
    cli.send.mockClear();

    bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "permission_response",
        request_id: "req-no-perm",
        behavior: "allow",
      }),
    );

    const sentRaw = cli.send.mock.calls[0][0] as string;
    const sent = JSON.parse(sentRaw.trim());
    expect(sent.response.response.updatedPermissions).toBeUndefined();
  });

  it("allow with empty updated_permissions does not include updatedPermissions key", () => {
    bridge.handleCLIMessage(
      cli,
      JSON.stringify({
        type: "control_request",
        request_id: "req-empty-perm",
        request: {
          subtype: "can_use_tool",
          tool_name: "Read",
          input: { file_path: "/test.ts" },
          tool_use_id: "tu-empty-perm",
        },
      }),
    );
    cli.send.mockClear();

    bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "permission_response",
        request_id: "req-empty-perm",
        behavior: "allow",
        updated_permissions: [],
      }),
    );

    const sentRaw = cli.send.mock.calls[0][0] as string;
    const sent = JSON.parse(sentRaw.trim());
    expect(sent.response.response.updatedPermissions).toBeUndefined();
  });
});

// ─── Multiple browser sockets ─────────────────────────────────────────────────

describe("Multiple browser sockets", () => {
  it("broadcasts to ALL connected browsers", () => {
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
    bridge.handleCLIMessage(cli, msg);

    // All three browsers should receive the broadcast
    for (const browser of [browser1, browser2, browser3]) {
      expect(browser.send).toHaveBeenCalledTimes(1);
      const sent = JSON.parse(browser.send.mock.calls[0][0]);
      expect(sent.type).toBe("tool_progress");
      expect(sent.tool_use_id).toBe("tu-multi");
    }
  });

  it("removes a browser whose send() throws, but others continue to receive", () => {
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
    bridge.handleCLIMessage(cli, msg);

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
  it("parses Buffer input correctly", () => {
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
    bridge.handleCLIMessage(cli, Buffer.from(jsonStr, "utf-8"));

    const calls = browser.send.mock.calls.map(([arg]: [string]) =>
      JSON.parse(arg),
    );
    const progressMsg = calls.find((c: any) => c.type === "tool_progress");
    expect(progressMsg).toBeDefined();
    expect(progressMsg.tool_use_id).toBe("tu-buf");
    expect(progressMsg.tool_name).toBe("Bash");
  });

  it("handles multi-line NDJSON as Buffer", () => {
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

    bridge.handleCLIMessage(cli, Buffer.from(ndjson, "utf-8"));

    // keep_alive is silently consumed, only tool_progress should be broadcast
    const calls = browser.send.mock.calls.map(([arg]: [string]) =>
      JSON.parse(arg),
    );
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
  it("does not throw on invalid JSON", () => {
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

  it("skips empty lines between valid NDJSON", () => {
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
    bridge.handleCLIMessage(cli, raw);

    const calls = browser.send.mock.calls.map(([arg]: [string]) =>
      JSON.parse(arg),
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].type).toBe("tool_progress");
    expect(calls[0].tool_use_id).toBe("tu-empty-lines");
  });

  it("handles entirely empty/whitespace input without crashing", () => {
    expect(() => bridge.handleCLIMessage(cli, "")).not.toThrow();
    expect(() => bridge.handleCLIMessage(cli, "\n\n\n")).not.toThrow();
    expect(() => bridge.handleCLIMessage(cli, "   \t  \n  ")).not.toThrow();
    expect(browser.send).not.toHaveBeenCalled();
  });

  it("processes valid lines around whitespace-only lines", () => {
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
    bridge.handleCLIMessage(cli, raw);

    const calls = browser.send.mock.calls.map(([arg]: [string]) =>
      JSON.parse(arg),
    );
    const progressMsgs = calls.filter((c: any) => c.type === "tool_progress");
    expect(progressMsgs).toHaveLength(2);
    expect(progressMsgs[0].tool_use_id).toBe("tu-ws-1");
    expect(progressMsgs[1].tool_use_id).toBe("tu-ws-2");
  });
});

// ─── Session not found scenarios ──────────────────────────────────────────────

describe("Session not found scenarios", () => {
  it("handleCLIMessage does nothing for unknown session", () => {
    const cli = makeCliSocket("unknown-session");
    // Do NOT call handleCLIOpen — session does not exist in the bridge

    expect(() => {
      bridge.handleCLIMessage(
        cli,
        JSON.stringify({
          type: "tool_progress",
          tool_use_id: "tu-unknown",
          tool_name: "Bash",
          parent_tool_use_id: null,
          elapsed_time_seconds: 1,
          uuid: "uuid-unknown",
          session_id: "unknown-session",
        }),
      );
    }).not.toThrow();

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
      bridge.handleBrowserMessage(
        browser,
        JSON.stringify({
          type: "user_message",
          content: "hello",
        }),
      );
    }).not.toThrow();

    expect(bridge.getSession("nonexistent")).toBeUndefined();
  });
});

// ─── Restore from disk with pendingPermissions ───────────────────────────────

describe("Restore from disk with pendingPermissions", () => {
  it("restores sessions with pending permissions as a Map", () => {
    const pendingPerms: [string, any][] = [
      [
        "req-restored-1",
        {
          request_id: "req-restored-1",
          tool_name: "Bash",
          input: { command: "rm -rf /tmp/test" },
          tool_use_id: "tu-restored-1",
          timestamp: 1700000000000,
        },
      ],
      [
        "req-restored-2",
        {
          request_id: "req-restored-2",
          tool_name: "Edit",
          input: { file_path: "/test.ts" },
          description: "Edit file",
          tool_use_id: "tu-restored-2",
          agent_id: "agent-1",
          timestamp: 1700000001000,
        },
      ],
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
        [
          "req-replay",
          {
            request_id: "req-replay",
            tool_name: "Bash",
            input: { command: "echo test" },
            tool_use_id: "tu-replay",
            timestamp: 1700000000000,
          },
        ],
      ],
    });

    bridge.restoreFromDisk();

    // Connect a CLI so we don't trigger relaunch
    const cli = makeCliSocket("perm-replay");
    bridge.handleCLIOpen(cli, "perm-replay");

    // Now connect a browser
    const browser = makeBrowserSocket("perm-replay");
    bridge.handleBrowserOpen(browser, "perm-replay");

    const calls = browser.send.mock.calls.map(([arg]: [string]) =>
      JSON.parse(arg),
    );
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
  it("fires on first successful result regardless of num_turns", () => {
    const callback = vi.fn();
    bridge.onFirstTurnCompletedCallback(callback);

    const cli = makeCliSocket("s1");
    bridge.handleCLIOpen(cli, "s1");
    bridge.handleCLIMessage(cli, makeInitMsg());

    // Simulate a browser sending a user message
    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");
    bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "user_message",
        content: "Fix the login bug",
      }),
    );

    // Simulate the result — num_turns is 5 because CLI auto-approved tool calls
    bridge.handleCLIMessage(
      cli,
      JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        result: "Done",
        duration_ms: 1000,
        duration_api_ms: 800,
        num_turns: 5,
        total_cost_usd: 0.01,
        stop_reason: "end_turn",
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
        uuid: "uuid-first",
        session_id: "s1",
      }),
    );

    expect(callback).toHaveBeenCalledWith("s1", "Fix the login bug");
  });

  it("does not fire on subsequent results for the same session", () => {
    const callback = vi.fn();
    bridge.onFirstTurnCompletedCallback(callback);

    const cli = makeCliSocket("s1");
    bridge.handleCLIOpen(cli, "s1");
    bridge.handleCLIMessage(cli, makeInitMsg());

    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");
    bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "user_message",
        content: "First message",
      }),
    );

    // First result — triggers callback
    bridge.handleCLIMessage(
      cli,
      JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        duration_ms: 1000,
        duration_api_ms: 800,
        num_turns: 3,
        total_cost_usd: 0.05,
        stop_reason: "end_turn",
        usage: {
          input_tokens: 500,
          output_tokens: 200,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
        uuid: "uuid-first",
        session_id: "s1",
      }),
    );

    expect(callback).toHaveBeenCalledTimes(1);

    // Second user message + result — should NOT trigger callback again
    bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "user_message",
        content: "Second message",
      }),
    );
    bridge.handleCLIMessage(
      cli,
      JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        duration_ms: 1000,
        duration_api_ms: 800,
        num_turns: 6,
        total_cost_usd: 0.1,
        stop_reason: "end_turn",
        usage: {
          input_tokens: 800,
          output_tokens: 300,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
        uuid: "uuid-second",
        session_id: "s1",
      }),
    );

    expect(callback).toHaveBeenCalledTimes(1);
  });

  it("does not fire on error results", () => {
    const callback = vi.fn();
    bridge.onFirstTurnCompletedCallback(callback);

    const cli = makeCliSocket("s1");
    bridge.handleCLIOpen(cli, "s1");
    bridge.handleCLIMessage(cli, makeInitMsg());

    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");
    bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "user_message",
        content: "Some request",
      }),
    );

    bridge.handleCLIMessage(
      cli,
      JSON.stringify({
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        errors: ["Something went wrong"],
        duration_ms: 500,
        duration_api_ms: 400,
        num_turns: 1,
        total_cost_usd: 0.005,
        stop_reason: null,
        usage: {
          input_tokens: 50,
          output_tokens: 10,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
        uuid: "uuid-err",
        session_id: "s1",
      }),
    );

    expect(callback).not.toHaveBeenCalled();
  });

  it("fires after initial error result followed by a successful result", () => {
    const callback = vi.fn();
    bridge.onFirstTurnCompletedCallback(callback);

    const cli = makeCliSocket("s1");
    bridge.handleCLIOpen(cli, "s1");
    bridge.handleCLIMessage(cli, makeInitMsg());

    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");
    bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "user_message",
        content: "Fix the bug",
      }),
    );

    // First result is an error — should NOT trigger
    bridge.handleCLIMessage(
      cli,
      JSON.stringify({
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        errors: ["Oops"],
        duration_ms: 100,
        duration_api_ms: 50,
        num_turns: 1,
        total_cost_usd: 0.001,
        stop_reason: null,
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
        uuid: "uuid-err",
        session_id: "s1",
      }),
    );
    expect(callback).not.toHaveBeenCalled();

    // Second result is success — should trigger since no successful result yet
    bridge.handleCLIMessage(
      cli,
      JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        result: "Done",
        duration_ms: 500,
        duration_api_ms: 400,
        num_turns: 3,
        total_cost_usd: 0.01,
        stop_reason: "end_turn",
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
        uuid: "uuid-ok",
        session_id: "s1",
      }),
    );
    expect(callback).toHaveBeenCalledWith("s1", "Fix the bug");
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it("does not fire when there is no user message in history", () => {
    const callback = vi.fn();
    bridge.onFirstTurnCompletedCallback(callback);

    const cli = makeCliSocket("s1");
    bridge.handleCLIOpen(cli, "s1");
    bridge.handleCLIMessage(cli, makeInitMsg());

    // Send result without any user message first
    bridge.handleCLIMessage(
      cli,
      JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        result: "Done",
        duration_ms: 100,
        duration_api_ms: 50,
        num_turns: 1,
        total_cost_usd: 0.001,
        stop_reason: "end_turn",
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
        uuid: "uuid-1",
        session_id: "s1",
      }),
    );

    expect(callback).not.toHaveBeenCalled();
  });

  it("fires independently for different sessions", () => {
    const callback = vi.fn();
    bridge.onFirstTurnCompletedCallback(callback);

    // Setup session 1
    const cli1 = makeCliSocket("s1");
    bridge.handleCLIOpen(cli1, "s1");
    bridge.handleCLIMessage(cli1, makeInitMsg());
    const browser1 = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser1, "s1");
    bridge.handleBrowserMessage(
      browser1,
      JSON.stringify({
        type: "user_message",
        content: "Message for s1",
      }),
    );

    // Setup session 2
    const cli2 = makeCliSocket("s2");
    bridge.handleCLIOpen(cli2, "s2");
    bridge.handleCLIMessage(cli2, makeInitMsg());
    const browser2 = makeBrowserSocket("s2");
    bridge.handleBrowserOpen(browser2, "s2");
    bridge.handleBrowserMessage(
      browser2,
      JSON.stringify({
        type: "user_message",
        content: "Message for s2",
      }),
    );

    // Result for s1
    bridge.handleCLIMessage(
      cli1,
      JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        duration_ms: 100,
        duration_api_ms: 50,
        num_turns: 2,
        total_cost_usd: 0.01,
        stop_reason: "end_turn",
        usage: {
          input_tokens: 50,
          output_tokens: 25,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
        uuid: "uuid-s1",
        session_id: "s1",
      }),
    );

    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledWith("s1", "Message for s1");

    // Result for s2 — should also fire (independent session)
    bridge.handleCLIMessage(
      cli2,
      JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        duration_ms: 100,
        duration_api_ms: 50,
        num_turns: 4,
        total_cost_usd: 0.02,
        stop_reason: "end_turn",
        usage: {
          input_tokens: 80,
          output_tokens: 40,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
        uuid: "uuid-s2",
        session_id: "s2",
      }),
    );

    expect(callback).toHaveBeenCalledTimes(2);
    expect(callback).toHaveBeenCalledWith("s2", "Message for s2");
  });

  it("cleans up auto-naming tracking when session is removed", () => {
    const callback = vi.fn();
    bridge.onFirstTurnCompletedCallback(callback);

    const cli = makeCliSocket("s1");
    bridge.handleCLIOpen(cli, "s1");
    bridge.handleCLIMessage(cli, makeInitMsg());
    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");
    bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "user_message",
        content: "Hello",
      }),
    );

    // First result triggers callback
    bridge.handleCLIMessage(
      cli,
      JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        duration_ms: 100,
        duration_api_ms: 50,
        num_turns: 1,
        total_cost_usd: 0.01,
        stop_reason: "end_turn",
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
        uuid: "uuid-1",
        session_id: "s1",
      }),
    );
    expect(callback).toHaveBeenCalledTimes(1);

    // Remove and recreate the session
    bridge.removeSession("s1");
    const cli2 = makeCliSocket("s1");
    bridge.handleCLIOpen(cli2, "s1");
    bridge.handleCLIMessage(cli2, makeInitMsg());
    const browser2 = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser2, "s1");
    bridge.handleBrowserMessage(
      browser2,
      JSON.stringify({
        type: "user_message",
        content: "Hello again",
      }),
    );

    // Should fire again for the recreated session
    bridge.handleCLIMessage(
      cli2,
      JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        duration_ms: 100,
        duration_api_ms: 50,
        num_turns: 2,
        total_cost_usd: 0.01,
        stop_reason: "end_turn",
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
        uuid: "uuid-2",
        session_id: "s1",
      }),
    );
    expect(callback).toHaveBeenCalledTimes(2);
    expect(callback).toHaveBeenLastCalledWith("s1", "Hello again");
  });

  it("cleans up auto-naming tracking when session is closed", () => {
    const callback = vi.fn();
    bridge.onFirstTurnCompletedCallback(callback);

    const cli = makeCliSocket("s1");
    bridge.handleCLIOpen(cli, "s1");
    bridge.handleCLIMessage(cli, makeInitMsg());
    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");
    bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "user_message",
        content: "First session",
      }),
    );

    // Trigger callback
    bridge.handleCLIMessage(
      cli,
      JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        duration_ms: 100,
        duration_api_ms: 50,
        num_turns: 1,
        total_cost_usd: 0.01,
        stop_reason: "end_turn",
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
        uuid: "uuid-1",
        session_id: "s1",
      }),
    );
    expect(callback).toHaveBeenCalledTimes(1);

    // Close session (should clean up tracking)
    bridge.closeSession("s1");

    // Recreate and verify callback fires again
    const cli2 = makeCliSocket("s1");
    bridge.handleCLIOpen(cli2, "s1");
    bridge.handleCLIMessage(cli2, makeInitMsg());
    const browser2 = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser2, "s1");
    bridge.handleBrowserMessage(
      browser2,
      JSON.stringify({
        type: "user_message",
        content: "Second session",
      }),
    );
    bridge.handleCLIMessage(
      cli2,
      JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        duration_ms: 100,
        duration_api_ms: 50,
        num_turns: 1,
        total_cost_usd: 0.01,
        stop_reason: "end_turn",
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
        uuid: "uuid-2",
        session_id: "s1",
      }),
    );
    expect(callback).toHaveBeenCalledTimes(2);
  });

  it("does not fire for restored sessions with completed turns", () => {
    const callback = vi.fn();
    bridge.onFirstTurnCompletedCallback(callback);

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
        {
          type: "user_message" as const,
          content: "Build the app",
          timestamp: Date.now(),
        },
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
    bridge.handleCLIMessage(
      cli,
      JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        duration_ms: 200,
        duration_api_ms: 150,
        num_turns: 5,
        total_cost_usd: 0.02,
        stop_reason: "end_turn",
        usage: {
          input_tokens: 200,
          output_tokens: 100,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
        uuid: "uuid-restored",
        session_id: "restored-1",
      }),
    );

    expect(callback).not.toHaveBeenCalled();
  });

  it("allows auto-naming for restored sessions with zero turns", () => {
    const callback = vi.fn();
    bridge.onFirstTurnCompletedCallback(callback);

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
    bridge.handleCLIMessage(cli, makeInitMsg());
    const browser = makeBrowserSocket("fresh-restored");
    bridge.handleBrowserOpen(browser, "fresh-restored");
    bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "user_message",
        content: "Hello world",
      }),
    );

    bridge.handleCLIMessage(
      cli,
      JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        duration_ms: 100,
        duration_api_ms: 50,
        num_turns: 2,
        total_cost_usd: 0.01,
        stop_reason: "end_turn",
        usage: {
          input_tokens: 50,
          output_tokens: 25,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
        uuid: "uuid-fresh",
        session_id: "fresh-restored",
      }),
    );

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

    const calls1 = browser1.send.mock.calls.map(([arg]: [string]) =>
      JSON.parse(arg),
    );
    const calls2 = browser2.send.mock.calls.map(([arg]: [string]) =>
      JSON.parse(arg),
    );
    expect(calls1).toContainEqual(
      expect.objectContaining({
        type: "session_name_update",
        name: "Fix Auth Bug",
      }),
    );
    expect(calls2).toContainEqual(
      expect.objectContaining({
        type: "session_name_update",
        name: "Fix Auth Bug",
      }),
    );
  });

  it("does nothing for unknown sessions", () => {
    // Should not throw
    bridge.broadcastNameUpdate("nonexistent", "Name");
  });
});

// ─── MCP Control Messages ────────────────────────────────────────────────────

describe("MCP control messages", () => {
  let cli: ReturnType<typeof makeCliSocket>;
  let browser: ReturnType<typeof makeBrowserSocket>;

  beforeEach(() => {
    cli = makeCliSocket("s1");
    browser = makeBrowserSocket("s1");
    bridge.handleCLIOpen(cli, "s1");
    bridge.handleBrowserOpen(browser, "s1");
    bridge.handleCLIMessage(cli, makeInitMsg());
    cli.send.mockClear();
    browser.send.mockClear();
  });

  it("mcp_get_status: sends mcp_status control_request to CLI", () => {
    bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "mcp_get_status",
      }),
    );

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
    bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "mcp_toggle",
        serverName: "my-server",
        enabled: false,
      }),
    );

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
    bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "mcp_reconnect",
        serverName: "failing-server",
      }),
    );

    expect(cli.send).toHaveBeenCalledTimes(1);
    const sentRaw = cli.send.mock.calls[0][0] as string;
    const sent = JSON.parse(sentRaw.trim());
    expect(sent.type).toBe("control_request");
    expect(sent.request.subtype).toBe("mcp_reconnect");
    expect(sent.request.serverName).toBe("failing-server");
    vi.useRealTimers();
  });

  it("control_response for mcp_status: broadcasts mcp_status to browsers", () => {
    // Send mcp_get_status to create the pending request
    bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "mcp_get_status",
      }),
    );
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

    bridge.handleCLIMessage(
      cli,
      JSON.stringify({
        type: "control_response",
        response: {
          subtype: "success",
          request_id: "test-uuid",
          response: { mcpServers: mockServers },
        },
      }),
    );

    expect(browser.send).toHaveBeenCalledTimes(1);
    const browserMsg = JSON.parse(browser.send.mock.calls[0][0] as string);
    expect(browserMsg.type).toBe("mcp_status");
    expect(browserMsg.servers).toHaveLength(1);
    expect(browserMsg.servers[0].name).toBe("test-server");
    expect(browserMsg.servers[0].status).toBe("connected");
    expect(browserMsg.servers[0].tools).toHaveLength(1);
  });

  it("control_response with error: does not broadcast to browsers", () => {
    bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "mcp_get_status",
      }),
    );
    browser.send.mockClear();

    bridge.handleCLIMessage(
      cli,
      JSON.stringify({
        type: "control_response",
        response: {
          subtype: "error",
          request_id: "test-uuid",
          error: "MCP not available",
        },
      }),
    );

    // Should not broadcast anything
    expect(browser.send).not.toHaveBeenCalled();
  });

  it("control_response for unknown request_id: ignored silently", () => {
    bridge.handleCLIMessage(
      cli,
      JSON.stringify({
        type: "control_response",
        response: {
          subtype: "success",
          request_id: "unknown-id",
          response: { mcpServers: [] },
        },
      }),
    );

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
    bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "mcp_set_servers",
        servers,
      }),
    );

    expect(cli.send).toHaveBeenCalledTimes(1);
    const sentRaw = cli.send.mock.calls[0][0] as string;
    const sent = JSON.parse(sentRaw.trim());
    expect(sent.type).toBe("control_request");
    expect(sent.request.subtype).toBe("mcp_set_servers");
    expect(sent.request.servers).toEqual(servers);
    vi.useRealTimers();
  });
});
