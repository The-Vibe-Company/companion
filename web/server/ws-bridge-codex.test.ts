import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock settings-manager before importing the module under test
vi.mock("./settings-manager.js", () => ({
  DEFAULT_ANTHROPIC_MODEL: "claude-sonnet-4-6",
  getSettings: vi.fn(),
}));

// Mock ai-validator before importing the module under test
vi.mock("./ai-validator.js", () => ({
  validatePermission: vi.fn(),
}));

import { attachCodexAdapterHandlers } from "./ws-bridge-codex.js";
import type { BrowserIncomingMessage, SessionState } from "./session-types.js";
import type { Session } from "./ws-bridge-types.js";
import type { CodexAdapter } from "./codex-adapter.js";
import type { CodexAttachDeps } from "./ws-bridge-codex.js";
import * as settingsManager from "./settings-manager.js";
import * as aiValidator from "./ai-validator.js";
import { companionBus } from "./event-bus.js";
import { SessionStateMachine } from "./session-state-machine.js";

// ── Mock Factories ──────────────────────────────────────────────────────────

function createMockSession(overrides = {}): Session {
  return {
    id: "test-session",
    backendType: "codex",
    backendAdapter: null,
    browserSockets: new Set(),
    state: {
      session_id: "test-session",
      backend_type: "codex",
      model: "",
      cwd: "",
      tools: [],
      permissionMode: "default",
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
    } as SessionState,
    pendingPermissions: new Map(),
    messageHistory: [] as BrowserIncomingMessage[],
    pendingMessages: [] as string[],
    nextEventSeq: 0,
    eventBuffer: [],
    lastAckSeq: 0,
    processedClientMessageIds: [],
    processedClientMessageIdSet: new Set(),
    lastCliActivityTs: Date.now(),
    stateMachine: new SessionStateMachine("test-session"),
    dynamicMcpServers: {},
    ...overrides,
  } as Session;
}

function createMockAdapter() {
  const handlers: Record<string, Function> = {};
  return {
    onBrowserMessage: vi.fn((fn: Function) => {
      handlers.onBrowserMessage = fn;
    }),
    onSessionMeta: vi.fn((fn: Function) => {
      handlers.onSessionMeta = fn;
    }),
    onDisconnect: vi.fn((fn: Function) => {
      handlers.onDisconnect = fn;
    }),
    sendBrowserMessage: vi.fn(),
    /** Helper to trigger a registered handler in tests */
    _trigger: (event: string, data: any) => handlers[event]?.(data),
  };
}

function createMockDeps(overrides = {}): CodexAttachDeps {
  return {
    persistSession: vi.fn(),
    refreshGitInfo: vi.fn(),
    broadcastToBrowsers: vi.fn(),
    autoNamingAttempted: new Set<string>(),
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("attachCodexAdapterHandlers", () => {
  let session: Session;
  let adapter: ReturnType<typeof createMockAdapter>;
  let deps: CodexAttachDeps;

  beforeEach(() => {
    vi.clearAllMocks();
    companionBus.clear();
    session = createMockSession();
    adapter = createMockAdapter();
    deps = createMockDeps();

    // Default: AI validation disabled — existing tests should not be affected
    vi.mocked(settingsManager.getSettings).mockReturnValue({
      anthropicApiKey: "",
      anthropicModel: "claude-sonnet-4-6",
      linearApiKey: "",
      linearAutoTransition: false,
      linearAutoTransitionStateId: "",
      linearAutoTransitionStateName: "",
    linearArchiveTransition: false,
    linearArchiveTransitionStateId: "",
    linearArchiveTransitionStateName: "",
      linearOAuthClientId: "",
      linearOAuthClientSecret: "",
      linearOAuthWebhookSecret: "",
      linearOAuthAccessToken: "",
      linearOAuthRefreshToken: "",
      claudeCodeOAuthToken: "",
      openaiApiKey: "",
      onboardingCompleted: false,
      aiValidationEnabled: false,
      aiValidationAutoApprove: true,
      aiValidationAutoDeny: false,
      publicUrl: "",
      updateChannel: "stable",
      dockerAutoUpdate: false,
      updatedAt: 0,
    });
  });

  // ── Handler registration ────────────────────────────────────────────────

  it("registers onBrowserMessage, onSessionMeta, and onDisconnect handlers", () => {
    // Verifies that attachCodexAdapterHandlers wires all three adapter callbacks.
    attachCodexAdapterHandlers("test-session", session, adapter as unknown as CodexAdapter, deps);

    expect(adapter.onBrowserMessage).toHaveBeenCalledOnce();
    expect(adapter.onSessionMeta).toHaveBeenCalledOnce();
    expect(adapter.onDisconnect).toHaveBeenCalledOnce();
  });

  // ── session_init ────────────────────────────────────────────────────────

  it("session_init updates session state with backend_type and persists", () => {
    // session_init should merge the incoming session state into session.state,
    // set backend_type to "codex", call refreshGitInfo, and persist.
    attachCodexAdapterHandlers("test-session", session, adapter as unknown as CodexAdapter, deps);

    const sessionInitPayload: BrowserIncomingMessage = {
      type: "session_init",
      session: {
        session_id: "test-session",
        backend_type: "codex",
        model: "o3-pro",
        cwd: "/home/user/project",
        tools: [],
        permissionMode: "default",
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
    };

    adapter._trigger("onBrowserMessage", sessionInitPayload);

    expect(session.state.model).toBe("o3-pro");
    expect(session.state.cwd).toBe("/home/user/project");
    expect(session.state.backend_type).toBe("codex");
    expect(deps.refreshGitInfo).toHaveBeenCalledWith(session, { notifyPoller: true });
    expect(deps.persistSession).toHaveBeenCalledWith(session);
  });

  it("session_init preserves pre-populated commands/skills when adapter sends empty arrays", () => {
    // When prePopulateCommands has set commands/skills on the session before
    // the Codex adapter sends session_init with empty arrays, the pre-populated
    // data should be preserved (Codex does not provide its own commands/skills).
    session.state.slash_commands = ["pre-cmd-1", "pre-cmd-2"];
    session.state.skills = ["pre-skill"];

    attachCodexAdapterHandlers("test-session", session, adapter as unknown as CodexAdapter, deps);

    adapter._trigger("onBrowserMessage", {
      type: "session_init",
      session: {
        session_id: "test-session",
        backend_type: "codex",
        model: "o3-pro",
        cwd: "/home/user/project",
        tools: [],
        permissionMode: "default",
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

    // Pre-populated data should survive the Codex session_init merge
    expect(session.state.slash_commands).toEqual(["pre-cmd-1", "pre-cmd-2"]);
    expect(session.state.skills).toEqual(["pre-skill"]);
    // Other fields should still be updated
    expect(session.state.model).toBe("o3-pro");
    expect(session.state.cwd).toBe("/home/user/project");
  });

  it("session_init allows overwriting commands/skills when adapter sends non-empty arrays", () => {
    // If a future Codex version sends actual commands/skills, they should
    // overwrite the pre-populated data.
    session.state.slash_commands = ["pre-cmd"];
    session.state.skills = ["pre-skill"];

    attachCodexAdapterHandlers("test-session", session, adapter as unknown as CodexAdapter, deps);

    adapter._trigger("onBrowserMessage", {
      type: "session_init",
      session: {
        session_id: "test-session",
        backend_type: "codex",
        model: "o3-pro",
        cwd: "/home/user/project",
        tools: [],
        permissionMode: "default",
        claude_code_version: "",
        mcp_servers: [],
        agents: [],
        slash_commands: ["codex-cmd"],
        skills: ["codex-skill"],
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

    // Non-empty arrays from the adapter should overwrite pre-populated data
    expect(session.state.slash_commands).toEqual(["codex-cmd"]);
    expect(session.state.skills).toEqual(["codex-skill"]);
  });

  // ── session_update ──────────────────────────────────────────────────────

  it("session_update preserves pre-populated commands/skills when update has empty arrays", () => {
    // Same preservation logic applies to session_update messages.
    session.state.slash_commands = ["pre-cmd"];
    session.state.skills = ["pre-skill"];

    attachCodexAdapterHandlers("test-session", session, adapter as unknown as CodexAdapter, deps);

    adapter._trigger("onBrowserMessage", {
      type: "session_update",
      session: { model: "gpt-4.1", slash_commands: [], skills: [] },
    });

    expect(session.state.slash_commands).toEqual(["pre-cmd"]);
    expect(session.state.skills).toEqual(["pre-skill"]);
    expect(session.state.model).toBe("gpt-4.1");
  });

  it("session_update merges partial state and sets backend_type to codex", () => {
    // session_update should spread the partial session fields into state,
    // force backend_type to "codex", refresh git info, and persist.
    attachCodexAdapterHandlers("test-session", session, adapter as unknown as CodexAdapter, deps);

    adapter._trigger("onBrowserMessage", {
      type: "session_update",
      session: { model: "gpt-4.1", permissionMode: "bypassPermissions" },
    });

    expect(session.state.model).toBe("gpt-4.1");
    expect(session.state.permissionMode).toBe("bypassPermissions");
    expect(session.state.backend_type).toBe("codex");
    expect(deps.refreshGitInfo).toHaveBeenCalledWith(session, { notifyPoller: true });
    expect(deps.persistSession).toHaveBeenCalled();
  });

  // ── status_change ───────────────────────────────────────────────────────

  it("status_change sets is_compacting to true when status is 'compacting'", () => {
    // When the adapter emits a status_change with status "compacting",
    // the handler should set session.state.is_compacting = true.
    attachCodexAdapterHandlers("test-session", session, adapter as unknown as CodexAdapter, deps);

    adapter._trigger("onBrowserMessage", {
      type: "status_change",
      status: "compacting",
    });

    expect(session.state.is_compacting).toBe(true);
    expect(deps.persistSession).toHaveBeenCalled();
  });

  it("status_change sets is_compacting to false when status is not 'compacting'", () => {
    // When status is something other than "compacting" (e.g. null),
    // is_compacting should be false.
    session.state.is_compacting = true;
    attachCodexAdapterHandlers("test-session", session, adapter as unknown as CodexAdapter, deps);

    adapter._trigger("onBrowserMessage", {
      type: "status_change",
      status: null,
    });

    expect(session.state.is_compacting).toBe(false);
    expect(deps.persistSession).toHaveBeenCalled();
  });

  // ── assistant message ───────────────────────────────────────────────────

  it("assistant message is pushed to messageHistory with timestamp", () => {
    // Assistant messages should be appended to the session's messageHistory
    // array with a timestamp, and persisted.
    attachCodexAdapterHandlers("test-session", session, adapter as unknown as CodexAdapter, deps);

    const assistantMsg: BrowserIncomingMessage = {
      type: "assistant",
      message: {
        id: "msg-1",
        type: "message",
        role: "assistant",
        model: "o3-pro",
        content: [{ type: "text", text: "Hello world" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
      parent_tool_use_id: null,
      timestamp: 1700000000000,
    };

    adapter._trigger("onBrowserMessage", assistantMsg);

    expect(session.messageHistory).toHaveLength(1);
    expect(session.messageHistory[0].type).toBe("assistant");
    expect((session.messageHistory[0] as any).timestamp).toBe(1700000000000);
    expect(deps.persistSession).toHaveBeenCalled();
  });

  it("assistant message gets a default timestamp when none is provided", () => {
    // If the assistant message doesn't have a timestamp, it should use Date.now().
    attachCodexAdapterHandlers("test-session", session, adapter as unknown as CodexAdapter, deps);

    const beforeTime = Date.now();
    adapter._trigger("onBrowserMessage", {
      type: "assistant",
      message: {
        id: "msg-2",
        type: "message",
        role: "assistant",
        model: "o3-pro",
        content: [{ type: "text", text: "No timestamp" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
      parent_tool_use_id: null,
    });
    const afterTime = Date.now();

    const stored = session.messageHistory[0] as any;
    expect(stored.timestamp).toBeGreaterThanOrEqual(beforeTime);
    expect(stored.timestamp).toBeLessThanOrEqual(afterTime);
  });

  // ── result message ──────────────────────────────────────────────────────

  it("result message is pushed to messageHistory", () => {
    // Result messages should also be appended to messageHistory and persisted.
    attachCodexAdapterHandlers("test-session", session, adapter as unknown as CodexAdapter, deps);

    const resultMsg: BrowserIncomingMessage = {
      type: "result",
      data: {
        type: "result",
        subtype: "success",
        is_error: false,
        result: undefined,
        duration_ms: 100,
        duration_api_ms: 80,
        num_turns: 1,
        total_cost_usd: 0.01,
        stop_reason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        uuid: "result-uuid-1",
        session_id: "test-session",
      },
    };

    adapter._trigger("onBrowserMessage", resultMsg);

    expect(session.messageHistory).toHaveLength(1);
    expect(session.messageHistory[0].type).toBe("result");
    expect(deps.persistSession).toHaveBeenCalled();
  });

  // ── permission_request ──────────────────────────────────────────────────

  it("permission_request is added to pendingPermissions", () => {
    // When a permission_request comes in, it should be stored in the session's
    // pendingPermissions map keyed by request_id, and persisted.
    attachCodexAdapterHandlers("test-session", session, adapter as unknown as CodexAdapter, deps);

    const permMsg: BrowserIncomingMessage = {
      type: "permission_request",
      request: {
        request_id: "perm-1",
        tool_name: "Bash",
        input: { command: "ls -la" },
        description: "Execute: ls -la",
        tool_use_id: "tool-1",
        timestamp: Date.now(),
      },
    };

    adapter._trigger("onBrowserMessage", permMsg);

    expect(session.pendingPermissions.has("perm-1")).toBe(true);
    expect(session.pendingPermissions.get("perm-1")).toEqual(
      expect.objectContaining({ request_id: "perm-1", tool_name: "Bash" }),
    );
    expect(deps.persistSession).toHaveBeenCalled();
  });

  it("permission_cancelled removes entry from pendingPermissions", () => {
    // When the adapter emits permission_cancelled (e.g. after a WS reconnect),
    // the bridge should remove the corresponding entry from pendingPermissions
    // so the browser doesn't show a stale approval dialog.
    attachCodexAdapterHandlers("test-session", session, adapter as unknown as CodexAdapter, deps);

    // Pre-populate a pending permission
    session.pendingPermissions.set("perm-stale", {
      request_id: "perm-stale",
      tool_name: "Bash",
      input: { command: "rm -rf /" },
      description: "Execute: rm -rf /",
      tool_use_id: "tool-stale",
      timestamp: Date.now(),
    });

    adapter._trigger("onBrowserMessage", {
      type: "permission_cancelled",
      request_id: "perm-stale",
    });

    expect(session.pendingPermissions.has("perm-stale")).toBe(false);
    expect(deps.persistSession).toHaveBeenCalled();
    expect(deps.broadcastToBrowsers).toHaveBeenCalledWith(
      session,
      expect.objectContaining({ type: "permission_cancelled", request_id: "perm-stale" }),
    );
  });

  // ── broadcast to browsers ───────────────────────────────────────────────

  it("all messages are broadcast to browsers", () => {
    // Every message that goes through onBrowserMessage should be broadcast
    // to connected browser sockets.
    attachCodexAdapterHandlers("test-session", session, adapter as unknown as CodexAdapter, deps);

    const testMessages: BrowserIncomingMessage[] = [
      {
        type: "session_init",
        session: session.state,
      },
      {
        type: "session_update",
        session: { model: "updated-model" },
      },
      {
        type: "status_change",
        status: "compacting",
      },
      {
        type: "assistant",
        message: {
          id: "msg-1",
          type: "message",
          role: "assistant",
          model: "o3-pro",
          content: [{ type: "text", text: "hello" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        },
        parent_tool_use_id: null,
        timestamp: Date.now(),
      },
      {
        type: "result",
        data: {
          type: "result",
          subtype: "success",
          is_error: false,
          result: undefined,
          duration_ms: 0,
          duration_api_ms: 0,
          num_turns: 1,
          total_cost_usd: 0,
          stop_reason: "end_turn",
          usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
          uuid: "r-1",
          session_id: "test-session",
        },
      },
      {
        type: "permission_request",
        request: {
          request_id: "perm-2",
          tool_name: "Edit",
          input: {},
          description: "Edit file",
          tool_use_id: "tool-2",
          timestamp: Date.now(),
        },
      },
    ];

    for (const msg of testMessages) {
      adapter._trigger("onBrowserMessage", msg);
    }

    // Each message should trigger one broadcastToBrowsers call, plus the initial
    // cli_connected broadcast that happens during attachCodexAdapterHandlers setup.
    // The first call (index 0) is cli_connected, then each message adds one more.
    expect(deps.broadcastToBrowsers).toHaveBeenCalledTimes(testMessages.length + 1);

    // First call is cli_connected (from attach)
    expect(deps.broadcastToBrowsers).toHaveBeenNthCalledWith(1, session, {
      type: "cli_connected",
    });

    // Verify each subsequent call passed the session and the original message
    for (let i = 0; i < testMessages.length; i++) {
      expect(deps.broadcastToBrowsers).toHaveBeenNthCalledWith(
        i + 2,
        session,
        testMessages[i],
      );
    }
  });

  // ── auto-naming via onFirstTurnCompleted ────────────────────────────────

  it("result triggers session:first-turn-completed event for auto-naming on first successful result", () => {
    // When a non-error result arrives and auto-naming hasn't been attempted yet,
    // the handler should emit session:first-turn-completed with the first user_message content.
    const onFirstTurnCompleted = vi.fn();
    companionBus.on("session:first-turn-completed", onFirstTurnCompleted);

    session.messageHistory.push({
      type: "user_message",
      content: "What is the meaning of life?",
    } as any);

    attachCodexAdapterHandlers("test-session", session, adapter as unknown as CodexAdapter, deps);

    adapter._trigger("onBrowserMessage", {
      type: "result",
      data: {
        type: "result",
        subtype: "success",
        is_error: false,
        result: null,
        duration_ms: 100,
        duration_api_ms: 80,
        num_turns: 1,
        total_cost_usd: 0,
        stop_reason: "end_turn",
        usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        uuid: "r-2",
        session_id: "test-session",
      },
    });

    expect(onFirstTurnCompleted).toHaveBeenCalledOnce();
    expect(onFirstTurnCompleted).toHaveBeenCalledWith({
      sessionId: "test-session",
      firstUserMessage: "What is the meaning of life?",
    });
    // The session ID should be recorded in autoNamingAttempted
    expect(deps.autoNamingAttempted.has("test-session")).toBe(true);
  });

  it("result does NOT trigger session:first-turn-completed a second time (only once per session)", () => {
    // Auto-naming should only fire once per session. Subsequent results should not
    // re-trigger the event.
    const onFirstTurnCompleted = vi.fn();
    companionBus.on("session:first-turn-completed", onFirstTurnCompleted);

    session.messageHistory.push({
      type: "user_message",
      content: "First message",
    } as any);

    attachCodexAdapterHandlers("test-session", session, adapter as unknown as CodexAdapter, deps);

    const resultMsg = {
      type: "result",
      data: {
        type: "result",
        subtype: "success",
        is_error: false,
        result: null,
        duration_ms: 0,
        duration_api_ms: 0,
        num_turns: 1,
        total_cost_usd: 0,
        stop_reason: "end_turn",
        usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        uuid: "r-3",
        session_id: "test-session",
      },
    };

    adapter._trigger("onBrowserMessage", resultMsg);
    adapter._trigger("onBrowserMessage", resultMsg);

    // Should only be called once despite two result messages
    expect(onFirstTurnCompleted).toHaveBeenCalledOnce();
  });

  it("result does NOT trigger session:first-turn-completed when result is an error", () => {
    // Error results should not trigger auto-naming.
    const onFirstTurnCompleted = vi.fn();
    companionBus.on("session:first-turn-completed", onFirstTurnCompleted);

    session.messageHistory.push({
      type: "user_message",
      content: "Some message",
    } as any);

    attachCodexAdapterHandlers("test-session", session, adapter as unknown as CodexAdapter, deps);

    adapter._trigger("onBrowserMessage", {
      type: "result",
      data: {
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        result: "Something went wrong",
        duration_ms: 0,
        duration_api_ms: 0,
        num_turns: 1,
        total_cost_usd: 0,
        stop_reason: "error",
        usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        uuid: "r-4",
        session_id: "test-session",
      },
    });

    expect(onFirstTurnCompleted).not.toHaveBeenCalled();
  });

  it("result does NOT trigger session:first-turn-completed when no user_message exists", () => {
    // If there's no user_message in the history, the event should not be emitted
    // even on a successful result.
    const onFirstTurnCompleted = vi.fn();
    companionBus.on("session:first-turn-completed", onFirstTurnCompleted);

    attachCodexAdapterHandlers("test-session", session, adapter as unknown as CodexAdapter, deps);

    adapter._trigger("onBrowserMessage", {
      type: "result",
      data: {
        type: "result",
        subtype: "success",
        is_error: false,
        result: null,
        duration_ms: 0,
        duration_api_ms: 0,
        num_turns: 1,
        total_cost_usd: 0,
        stop_reason: "end_turn",
        usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        uuid: "r-5",
        session_id: "test-session",
      },
    });

    expect(onFirstTurnCompleted).not.toHaveBeenCalled();
    // But the session should still be marked as naming-attempted
    expect(deps.autoNamingAttempted.has("test-session")).toBe(true);
  });

  it("result emits session:first-turn-completed safely even with no bus subscribers", () => {
    // When no subscriber is listening on the bus, the event should still be
    // emitted without errors and autoNamingAttempted should be updated.
    session.messageHistory.push({
      type: "user_message",
      content: "Some message",
    } as any);

    attachCodexAdapterHandlers("test-session", session, adapter as unknown as CodexAdapter, deps);

    adapter._trigger("onBrowserMessage", {
      type: "result",
      data: {
        type: "result",
        subtype: "success",
        is_error: false,
        result: null,
        duration_ms: 0,
        duration_api_ms: 0,
        num_turns: 1,
        total_cost_usd: 0,
        stop_reason: "end_turn",
        usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        uuid: "r-6",
        session_id: "test-session",
      },
    });

    // autoNamingAttempted should be set — the bus event fires even without subscribers
    expect(deps.autoNamingAttempted.has("test-session")).toBe(true);
  });

  // ── onSessionMeta ───────────────────────────────────────────────────────

  it("onSessionMeta updates model and cwd on session state", () => {
    // When session metadata arrives, it should update model, cwd, and
    // set backend_type to "codex", then refresh git info and persist.
    attachCodexAdapterHandlers("test-session", session, adapter as unknown as CodexAdapter, deps);

    adapter._trigger("onSessionMeta", {
      cliSessionId: "codex-thread-123",
      model: "o3-pro",
      cwd: "/home/user/project",
    });

    expect(session.state.model).toBe("o3-pro");
    expect(session.state.cwd).toBe("/home/user/project");
    expect(session.state.backend_type).toBe("codex");
    expect(deps.refreshGitInfo).toHaveBeenCalledWith(session, {
      broadcastUpdate: true,
      notifyPoller: true,
    });
    expect(deps.persistSession).toHaveBeenCalledWith(session);
  });

  it("onSessionMeta emits session:cli-id-received when cliSessionId is present", () => {
    // When the meta includes a cliSessionId, the bus event should be emitted
    // to track the mapping from our session ID to the Codex thread ID.
    const onCLISessionId = vi.fn();
    companionBus.on("session:cli-id-received", onCLISessionId);

    attachCodexAdapterHandlers("test-session", session, adapter as unknown as CodexAdapter, deps);

    adapter._trigger("onSessionMeta", {
      cliSessionId: "codex-thread-456",
      model: "gpt-4.1",
    });

    expect(onCLISessionId).toHaveBeenCalledWith({ sessionId: "test-session", cliSessionId: "codex-thread-456" });
  });

  it("onSessionMeta does not emit session:cli-id-received when cliSessionId is absent", () => {
    // If no cliSessionId in the meta, the bus event should not be emitted.
    const onCLISessionId = vi.fn();
    companionBus.on("session:cli-id-received", onCLISessionId);

    attachCodexAdapterHandlers("test-session", session, adapter as unknown as CodexAdapter, deps);

    adapter._trigger("onSessionMeta", { model: "gpt-4.1" });

    expect(onCLISessionId).not.toHaveBeenCalled();
  });

  it("onSessionMeta emits session:cli-id-received safely even with no bus subscribers", () => {
    // When no subscriber is listening, the event should fire without errors.
    attachCodexAdapterHandlers("test-session", session, adapter as unknown as CodexAdapter, deps);

    // Should not throw
    adapter._trigger("onSessionMeta", { cliSessionId: "thread-789" });

    expect(session.state.backend_type).toBe("codex");
  });

  it("onSessionMeta handles partial meta (only model or only cwd)", () => {
    // The handler should only update fields that are present in the meta object.
    attachCodexAdapterHandlers("test-session", session, adapter as unknown as CodexAdapter, deps);

    session.state.model = "old-model";
    session.state.cwd = "/old/path";

    // Only model provided
    adapter._trigger("onSessionMeta", { model: "new-model" });

    expect(session.state.model).toBe("new-model");
    expect(session.state.cwd).toBe("/old/path"); // unchanged
  });

  // ── onDisconnect ────────────────────────────────────────────────────────

  it("onDisconnect clears pending permissions and broadcasts cli_disconnected", () => {
    // When the adapter disconnects, all pending permissions should be cancelled
    // (broadcast permission_cancelled for each), the map cleared, backendAdapter set to null,
    // session persisted, and a cli_disconnected message broadcast.
    // Simulate the real flow: ws-bridge sets session.backendAdapter before calling handlers.
    session.backendAdapter = adapter as unknown as CodexAdapter;
    attachCodexAdapterHandlers("test-session", session, adapter as unknown as CodexAdapter, deps);

    // Add some pending permissions first
    session.pendingPermissions.set("perm-a", {
      request_id: "perm-a",
      tool_name: "Bash",
      input: {},
      description: "test",
      tool_use_id: "t-a",
      timestamp: Date.now(),
    });
    session.pendingPermissions.set("perm-b", {
      request_id: "perm-b",
      tool_name: "Edit",
      input: {},
      description: "test",
      tool_use_id: "t-b",
      timestamp: Date.now(),
    });

    adapter._trigger("onDisconnect", undefined);

    // Pending permissions should be cleared
    expect(session.pendingPermissions.size).toBe(0);

    // backendAdapter should be nulled out
    expect(session.backendAdapter).toBeNull();

    // Should broadcast permission_cancelled for each pending permission
    expect(deps.broadcastToBrowsers).toHaveBeenCalledWith(session, {
      type: "permission_cancelled",
      request_id: "perm-a",
    });
    expect(deps.broadcastToBrowsers).toHaveBeenCalledWith(session, {
      type: "permission_cancelled",
      request_id: "perm-b",
    });

    // Should broadcast cli_disconnected
    expect(deps.broadcastToBrowsers).toHaveBeenCalledWith(session, {
      type: "cli_disconnected",
    });

    expect(deps.persistSession).toHaveBeenCalled();
  });

  it("onDisconnect with no pending permissions still broadcasts cli_disconnected", () => {
    // Even when there are no pending permissions to cancel, the disconnect handler
    // should still broadcast cli_disconnected and persist.
    // Simulate the real flow: ws-bridge sets session.backendAdapter before calling handlers.
    session.backendAdapter = adapter as unknown as CodexAdapter;
    attachCodexAdapterHandlers("test-session", session, adapter as unknown as CodexAdapter, deps);

    adapter._trigger("onDisconnect", undefined);

    expect(session.pendingPermissions.size).toBe(0);
    expect(session.backendAdapter).toBeNull();
    expect(deps.broadcastToBrowsers).toHaveBeenCalledWith(session, {
      type: "cli_disconnected",
    });
    expect(deps.persistSession).toHaveBeenCalled();
  });

  it("onDisconnect from stale adapter is ignored when adapter has been replaced", () => {
    // When a session is relaunched, the new adapter is set on session.backendAdapter
    // before the old adapter's disconnect fires. The old adapter's disconnect should
    // be a no-op so it doesn't null out the new adapter.
    const oldAdapter = createMockAdapter();
    const newAdapter = createMockAdapter();

    // Simulate: old adapter is attached
    session.backendAdapter = oldAdapter as unknown as CodexAdapter;
    attachCodexAdapterHandlers("test-session", session, oldAdapter as unknown as CodexAdapter, deps);

    // Simulate: relaunch replaces the adapter
    session.backendAdapter = newAdapter as unknown as CodexAdapter;
    attachCodexAdapterHandlers("test-session", session, newAdapter as unknown as CodexAdapter, deps);

    // Clear broadcast calls from the two cli_connected broadcasts during attach
    (deps.broadcastToBrowsers as ReturnType<typeof vi.fn>).mockClear();

    // Old adapter fires disconnect (happens async after kill)
    oldAdapter._trigger("onDisconnect", undefined);

    // session.backendAdapter should still be the NEW adapter, not null
    expect(session.backendAdapter).toBe(newAdapter);
    // No cli_disconnected broadcast should have happened
    expect(deps.broadcastToBrowsers).not.toHaveBeenCalledWith(session, {
      type: "cli_disconnected",
    });
  });

  it("onDisconnect triggers auto-relaunch when browsers are still connected", () => {
    // When the transport drops mid-conversation and browsers are still connected,
    // the session should be auto-relaunched instead of leaving users with a dead session.
    const onRelaunchNeeded = vi.fn();
    companionBus.on("session:relaunch-needed", onRelaunchNeeded);

    session.backendAdapter = adapter as unknown as CodexAdapter;
    // Simulate a connected browser
    const fakeBrowserWs = {} as any;
    session.browserSockets.add(fakeBrowserWs);
    attachCodexAdapterHandlers("test-session", session, adapter as unknown as CodexAdapter, deps);

    adapter._trigger("onDisconnect", undefined);

    expect(onRelaunchNeeded).toHaveBeenCalledWith({ sessionId: "test-session" });
  });

  it("onDisconnect does NOT auto-relaunch when no browsers are connected", () => {
    // If no browsers are watching, don't waste resources relaunching — the relaunch
    // will happen when a browser reconnects via handleBrowserOpen.
    const onRelaunchNeeded = vi.fn();
    companionBus.on("session:relaunch-needed", onRelaunchNeeded);

    session.backendAdapter = adapter as unknown as CodexAdapter;
    expect(session.browserSockets.size).toBe(0);
    attachCodexAdapterHandlers("test-session", session, adapter as unknown as CodexAdapter, deps);

    adapter._trigger("onDisconnect", undefined);

    expect(onRelaunchNeeded).not.toHaveBeenCalled();
  });

  it("onDisconnect works safely even with no bus subscribers for relaunch", () => {
    // When no subscriber is listening for session:relaunch-needed, disconnect
    // should still work without errors.
    session.backendAdapter = adapter as unknown as CodexAdapter;
    const fakeBrowserWs = {} as any;
    session.browserSockets.add(fakeBrowserWs);
    attachCodexAdapterHandlers("test-session", session, adapter as unknown as CodexAdapter, deps);

    // Should not throw
    adapter._trigger("onDisconnect", undefined);

    expect(session.backendAdapter).toBeNull();
  });

  it("stale adapter disconnect does NOT trigger auto-relaunch", () => {
    // When a stale adapter disconnects after being replaced, it should not
    // trigger a relaunch (the new adapter is already active).
    const onRelaunchNeeded = vi.fn();
    companionBus.on("session:relaunch-needed", onRelaunchNeeded);

    const oldAdapter = createMockAdapter();
    const newAdapter = createMockAdapter();
    const fakeBrowserWs = {} as any;
    session.browserSockets.add(fakeBrowserWs);

    session.backendAdapter = oldAdapter as unknown as CodexAdapter;
    attachCodexAdapterHandlers("test-session", session, oldAdapter as unknown as CodexAdapter, deps);

    // Relaunch replaces the adapter
    session.backendAdapter = newAdapter as unknown as CodexAdapter;
    attachCodexAdapterHandlers("test-session", session, newAdapter as unknown as CodexAdapter, deps);
    onRelaunchNeeded.mockClear();

    // Old adapter fires disconnect
    oldAdapter._trigger("onDisconnect", undefined);

    // Should NOT trigger relaunch since the old adapter was stale
    expect(onRelaunchNeeded).not.toHaveBeenCalled();
  });

  // ── Pending message flushing ────────────────────────────────────────────

  it("flushes pending messages to adapter on attach", () => {
    // If there are queued messages in session.pendingMessages, they should be
    // JSON-parsed and sent to the adapter via sendBrowserMessage during attach.
    const userMsg = JSON.stringify({ type: "user_message", content: "Hello" });
    const permResp = JSON.stringify({
      type: "permission_response",
      request_id: "perm-1",
      behavior: "allow",
    });
    session.pendingMessages = [userMsg, permResp];

    attachCodexAdapterHandlers("test-session", session, adapter as unknown as CodexAdapter, deps);

    // Both messages should be sent to the adapter
    expect(adapter.sendBrowserMessage).toHaveBeenCalledTimes(2);
    expect(adapter.sendBrowserMessage).toHaveBeenCalledWith({ type: "user_message", content: "Hello" });
    expect(adapter.sendBrowserMessage).toHaveBeenCalledWith({
      type: "permission_response",
      request_id: "perm-1",
      behavior: "allow",
    });

    // pendingMessages should be drained
    expect(session.pendingMessages).toHaveLength(0);
  });

  it("does not call sendBrowserMessage when pendingMessages is empty", () => {
    // No messages to flush — sendBrowserMessage should not be called.
    session.pendingMessages = [];

    attachCodexAdapterHandlers("test-session", session, adapter as unknown as CodexAdapter, deps);

    expect(adapter.sendBrowserMessage).not.toHaveBeenCalled();
  });

  it("gracefully handles invalid JSON in pendingMessages", () => {
    // If a queued message is invalid JSON, it should be skipped without throwing.
    // The valid messages around it should still be flushed.
    session.pendingMessages = [
      JSON.stringify({ type: "user_message", content: "Valid" }),
      "NOT VALID JSON {{{",
      JSON.stringify({ type: "user_message", content: "Also valid" }),
    ];

    // Should not throw
    attachCodexAdapterHandlers("test-session", session, adapter as unknown as CodexAdapter, deps);

    // Only the two valid messages should be sent
    expect(adapter.sendBrowserMessage).toHaveBeenCalledTimes(2);
    expect(adapter.sendBrowserMessage).toHaveBeenCalledWith({ type: "user_message", content: "Valid" });
    expect(adapter.sendBrowserMessage).toHaveBeenCalledWith({ type: "user_message", content: "Also valid" });
    expect(session.pendingMessages).toHaveLength(0);
  });

  // ── cli_connected broadcast ─────────────────────────────────────────────

  it("broadcasts cli_connected on attach", () => {
    // After setting up handlers and flushing pending messages, the function
    // should broadcast cli_connected to all browser sockets.
    attachCodexAdapterHandlers("test-session", session, adapter as unknown as CodexAdapter, deps);

    expect(deps.broadcastToBrowsers).toHaveBeenCalledWith(session, {
      type: "cli_connected",
    });
  });

  it("broadcasts cli_connected after flushing pending messages", () => {
    // cli_connected should come after pending messages are flushed, ensuring
    // browsers know the adapter is ready only after queued work is processed.
    session.pendingMessages = [JSON.stringify({ type: "user_message", content: "Hello" })];

    const callOrder: string[] = [];
    (adapter.sendBrowserMessage as ReturnType<typeof vi.fn>).mockImplementation(() => {
      callOrder.push("sendBrowserMessage");
    });
    (deps.broadcastToBrowsers as ReturnType<typeof vi.fn>).mockImplementation((_session: any, msg: any) => {
      if (msg.type === "cli_connected") {
        callOrder.push("cli_connected_broadcast");
      }
    });

    attachCodexAdapterHandlers("test-session", session, adapter as unknown as CodexAdapter, deps);

    expect(callOrder).toEqual(["sendBrowserMessage", "cli_connected_broadcast"]);
  });

  // ── AI Validation Mode ──────────────────────────────────────────────────

  describe("AI validation mode", () => {
    /** Helper: configure settings for AI validation enabled with all auto-actions on */
    function enableAiValidation() {
      vi.mocked(settingsManager.getSettings).mockReturnValue({
        anthropicApiKey: "test-api-key",
        anthropicModel: "claude-sonnet-4-6",
        linearApiKey: "",
        linearAutoTransition: false,
        linearAutoTransitionStateId: "",
        linearAutoTransitionStateName: "",
    linearArchiveTransition: false,
    linearArchiveTransitionStateId: "",
    linearArchiveTransitionStateName: "",
        linearOAuthClientId: "",
        linearOAuthClientSecret: "",
        linearOAuthWebhookSecret: "",
        linearOAuthAccessToken: "",
        linearOAuthRefreshToken: "",
        claudeCodeOAuthToken: "",
        openaiApiKey: "",
        onboardingCompleted: false,
        aiValidationEnabled: true,
        aiValidationAutoApprove: true,
        aiValidationAutoDeny: true,
        publicUrl: "",
        updateChannel: "stable",
        dockerAutoUpdate: false,
        updatedAt: 0,
      });
    }

    /** Helper: create a permission_request BrowserIncomingMessage for the given tool */
    function makePermissionMsg(
      toolName: string,
      requestId = "perm-ai-1",
    ): BrowserIncomingMessage {
      return {
        type: "permission_request",
        request: {
          request_id: requestId,
          tool_name: toolName,
          input: { command: "ls -la" },
          description: `Execute: ${toolName}`,
          tool_use_id: `tool-${requestId}`,
          timestamp: Date.now(),
        },
      };
    }

    it("auto-approves when AI validation returns safe verdict", async () => {
      // When AI validation is enabled and the validator returns "safe",
      // the handler should broadcast permission_auto_resolved with behavior "allow"
      // and send a permission_response to the CLI adapter without prompting the user.
      enableAiValidation();
      vi.mocked(aiValidator.validatePermission).mockResolvedValue({
        verdict: "safe",
        reason: "Read-only tool",
        ruleBasedOnly: true,
      });

      attachCodexAdapterHandlers("test-session", session, adapter as unknown as CodexAdapter, deps);
      adapter._trigger("onBrowserMessage", makePermissionMsg("Bash"));

      // Allow the async handleCodexAiValidation to resolve
      await vi.waitFor(() => {
        expect(adapter.sendBrowserMessage).toHaveBeenCalled();
      });

      // Should broadcast permission_auto_resolved to browsers
      expect(deps.broadcastToBrowsers).toHaveBeenCalledWith(session, {
        type: "permission_auto_resolved",
        request: expect.objectContaining({
          request_id: "perm-ai-1",
          tool_name: "Bash",
          ai_validation: { verdict: "safe", reason: "Read-only tool", ruleBasedOnly: true },
        }),
        behavior: "allow",
        reason: "Read-only tool",
      });

      // Should send allow response back to CLI
      expect(adapter.sendBrowserMessage).toHaveBeenCalledWith({
        type: "permission_response",
        request_id: "perm-ai-1",
        behavior: "allow",
      });

      // Should NOT store in pendingPermissions (auto-resolved, no manual action needed)
      expect(session.pendingPermissions.has("perm-ai-1")).toBe(false);
    });

    it("auto-denies when AI validation returns dangerous verdict", async () => {
      // When AI validation is enabled and the validator returns "dangerous",
      // the handler should broadcast permission_auto_resolved with behavior "deny"
      // and send a permission_response "deny" to the CLI adapter.
      enableAiValidation();
      vi.mocked(aiValidator.validatePermission).mockResolvedValue({
        verdict: "dangerous",
        reason: "Recursive delete of root directory",
        ruleBasedOnly: true,
      });

      attachCodexAdapterHandlers("test-session", session, adapter as unknown as CodexAdapter, deps);
      adapter._trigger("onBrowserMessage", makePermissionMsg("Bash", "perm-danger"));

      await vi.waitFor(() => {
        expect(adapter.sendBrowserMessage).toHaveBeenCalled();
      });

      // Should broadcast permission_auto_resolved with "deny" to browsers
      expect(deps.broadcastToBrowsers).toHaveBeenCalledWith(session, {
        type: "permission_auto_resolved",
        request: expect.objectContaining({
          request_id: "perm-danger",
          tool_name: "Bash",
          ai_validation: { verdict: "dangerous", reason: "Recursive delete of root directory", ruleBasedOnly: true },
        }),
        behavior: "deny",
        reason: "Recursive delete of root directory",
      });

      // Should send deny response back to CLI
      expect(adapter.sendBrowserMessage).toHaveBeenCalledWith({
        type: "permission_response",
        request_id: "perm-danger",
        behavior: "deny",
      });

      // Should NOT store in pendingPermissions
      expect(session.pendingPermissions.has("perm-danger")).toBe(false);
    });

    it("falls through to manual review when AI validation returns uncertain verdict", async () => {
      // When the validator returns "uncertain", the handler should NOT auto-resolve.
      // Instead it should store the permission in pendingPermissions and broadcast
      // the permission_request to browsers for manual review, with ai_validation info attached.
      enableAiValidation();
      vi.mocked(aiValidator.validatePermission).mockResolvedValue({
        verdict: "uncertain",
        reason: "Complex bash pipeline",
        ruleBasedOnly: false,
      });

      attachCodexAdapterHandlers("test-session", session, adapter as unknown as CodexAdapter, deps);
      adapter._trigger("onBrowserMessage", makePermissionMsg("Bash", "perm-uncertain"));

      await vi.waitFor(() => {
        expect(session.pendingPermissions.has("perm-uncertain")).toBe(true);
      });

      // Should store in pendingPermissions for manual review
      const stored = session.pendingPermissions.get("perm-uncertain");
      expect(stored).toBeDefined();
      expect(stored!.ai_validation).toEqual({
        verdict: "uncertain",
        reason: "Complex bash pipeline",
        ruleBasedOnly: false,
      });

      // Should persist session
      expect(deps.persistSession).toHaveBeenCalled();

      // Should broadcast permission_request to browsers (not permission_auto_resolved)
      expect(deps.broadcastToBrowsers).toHaveBeenCalledWith(session, {
        type: "permission_request",
        request: expect.objectContaining({
          request_id: "perm-uncertain",
          ai_validation: { verdict: "uncertain", reason: "Complex bash pipeline", ruleBasedOnly: false },
        }),
      });

      // Should NOT send any response back to CLI (user must decide)
      expect(adapter.sendBrowserMessage).not.toHaveBeenCalled();
    });

    it("skips AI validation when disabled — uses normal permission flow", () => {
      // When aiValidationEnabled is false, the handler should go through the normal
      // flow: store in pendingPermissions, persist, and broadcast the permission_request
      // without calling validatePermission at all.
      vi.mocked(settingsManager.getSettings).mockReturnValue({
        anthropicApiKey: "test-api-key",
        anthropicModel: "claude-sonnet-4-6",
        linearApiKey: "",
        linearAutoTransition: false,
        linearAutoTransitionStateId: "",
        linearAutoTransitionStateName: "",
    linearArchiveTransition: false,
    linearArchiveTransitionStateId: "",
    linearArchiveTransitionStateName: "",
        linearOAuthClientId: "",
        linearOAuthClientSecret: "",
        linearOAuthWebhookSecret: "",
        linearOAuthAccessToken: "",
        linearOAuthRefreshToken: "",
        claudeCodeOAuthToken: "",
        openaiApiKey: "",
        onboardingCompleted: false,
        aiValidationEnabled: false,  // disabled
        aiValidationAutoApprove: true,
        aiValidationAutoDeny: true,
        publicUrl: "",
        updateChannel: "stable",
        dockerAutoUpdate: false,
        updatedAt: 0,
      });

      attachCodexAdapterHandlers("test-session", session, adapter as unknown as CodexAdapter, deps);
      adapter._trigger("onBrowserMessage", makePermissionMsg("Bash", "perm-no-ai"));

      // validatePermission should NOT have been called
      expect(aiValidator.validatePermission).not.toHaveBeenCalled();

      // Should store in pendingPermissions (normal flow)
      expect(session.pendingPermissions.has("perm-no-ai")).toBe(true);

      // Should broadcast permission_request to browsers
      expect(deps.broadcastToBrowsers).toHaveBeenCalledWith(
        session,
        expect.objectContaining({ type: "permission_request" }),
      );
    });

    it("skips AI validation when anthropicApiKey is empty", () => {
      // Even if aiValidationEnabled is true, an empty API key means we can't call
      // the AI — fall through to normal manual flow.
      vi.mocked(settingsManager.getSettings).mockReturnValue({
        anthropicApiKey: "",  // empty
        anthropicModel: "claude-sonnet-4-6",
        linearApiKey: "",
        linearAutoTransition: false,
        linearAutoTransitionStateId: "",
        linearAutoTransitionStateName: "",
    linearArchiveTransition: false,
    linearArchiveTransitionStateId: "",
    linearArchiveTransitionStateName: "",
        linearOAuthClientId: "",
        linearOAuthClientSecret: "",
        linearOAuthWebhookSecret: "",
        linearOAuthAccessToken: "",
        linearOAuthRefreshToken: "",
        claudeCodeOAuthToken: "",
        openaiApiKey: "",
        onboardingCompleted: false,
        aiValidationEnabled: true,
        aiValidationAutoApprove: true,
        aiValidationAutoDeny: true,
        publicUrl: "",
        updateChannel: "stable",
        dockerAutoUpdate: false,
        updatedAt: 0,
      });

      attachCodexAdapterHandlers("test-session", session, adapter as unknown as CodexAdapter, deps);
      adapter._trigger("onBrowserMessage", makePermissionMsg("Bash", "perm-no-key"));

      // Should NOT call AI validator
      expect(aiValidator.validatePermission).not.toHaveBeenCalled();

      // Should fall through to normal flow
      expect(session.pendingPermissions.has("perm-no-key")).toBe(true);
    });

    it("skips AI validation for AskUserQuestion tool even when enabled", () => {
      // AskUserQuestion is an interactive tool that always requires the user's direct
      // attention — it should never be auto-resolved by AI validation.
      enableAiValidation();

      attachCodexAdapterHandlers("test-session", session, adapter as unknown as CodexAdapter, deps);
      adapter._trigger("onBrowserMessage", makePermissionMsg("AskUserQuestion", "perm-ask"));

      // Should NOT call AI validator
      expect(aiValidator.validatePermission).not.toHaveBeenCalled();

      // Should go through normal flow
      expect(session.pendingPermissions.has("perm-ask")).toBe(true);
      expect(deps.broadcastToBrowsers).toHaveBeenCalledWith(
        session,
        expect.objectContaining({ type: "permission_request" }),
      );
    });

    it("skips AI validation for ExitPlanMode tool even when enabled", () => {
      // ExitPlanMode is an interactive tool that always requires the user's direct
      // attention — it should never be auto-resolved by AI validation.
      enableAiValidation();

      attachCodexAdapterHandlers("test-session", session, adapter as unknown as CodexAdapter, deps);
      adapter._trigger("onBrowserMessage", makePermissionMsg("ExitPlanMode", "perm-exit"));

      // Should NOT call AI validator
      expect(aiValidator.validatePermission).not.toHaveBeenCalled();

      // Should go through normal flow
      expect(session.pendingPermissions.has("perm-exit")).toBe(true);
      expect(deps.broadcastToBrowsers).toHaveBeenCalledWith(
        session,
        expect.objectContaining({ type: "permission_request" }),
      );
    });

    it("falls through to manual flow when AI validation throws an error", async () => {
      // When validatePermission rejects with an error, the .catch() handler should
      // fall through to the normal manual flow: store in pendingPermissions, persist,
      // and broadcast to browsers.
      enableAiValidation();
      vi.mocked(aiValidator.validatePermission).mockRejectedValue(
        new Error("Network timeout"),
      );

      attachCodexAdapterHandlers("test-session", session, adapter as unknown as CodexAdapter, deps);
      adapter._trigger("onBrowserMessage", makePermissionMsg("Bash", "perm-err"));

      // Wait for the .catch() path to execute
      await vi.waitFor(() => {
        expect(session.pendingPermissions.has("perm-err")).toBe(true);
      });

      // Should persist session
      expect(deps.persistSession).toHaveBeenCalled();

      // Should broadcast permission_request to browsers for manual review
      expect(deps.broadcastToBrowsers).toHaveBeenCalledWith(
        session,
        expect.objectContaining({
          type: "permission_request",
          request: expect.objectContaining({ request_id: "perm-err" }),
        }),
      );

      // Should NOT auto-resolve
      expect(adapter.sendBrowserMessage).not.toHaveBeenCalled();
    });

    it("does not auto-approve safe verdict when aiValidationAutoApprove is false", async () => {
      // When the verdict is "safe" but auto-approve is disabled, the handler
      // should fall through to manual review instead of auto-approving.
      vi.mocked(settingsManager.getSettings).mockReturnValue({
        anthropicApiKey: "test-api-key",
        anthropicModel: "claude-sonnet-4-6",
        linearApiKey: "",
        linearAutoTransition: false,
        linearAutoTransitionStateId: "",
        linearAutoTransitionStateName: "",
    linearArchiveTransition: false,
    linearArchiveTransitionStateId: "",
    linearArchiveTransitionStateName: "",
        linearOAuthClientId: "",
        linearOAuthClientSecret: "",
        linearOAuthWebhookSecret: "",
        linearOAuthAccessToken: "",
        linearOAuthRefreshToken: "",
        claudeCodeOAuthToken: "",
        openaiApiKey: "",
        onboardingCompleted: false,
        aiValidationEnabled: true,
        aiValidationAutoApprove: false,  // disabled
        aiValidationAutoDeny: true,
        publicUrl: "",
        updateChannel: "stable",
        dockerAutoUpdate: false,
        updatedAt: 0,
      });

      vi.mocked(aiValidator.validatePermission).mockResolvedValue({
        verdict: "safe",
        reason: "Standard dev command",
        ruleBasedOnly: false,
      });

      attachCodexAdapterHandlers("test-session", session, adapter as unknown as CodexAdapter, deps);
      adapter._trigger("onBrowserMessage", makePermissionMsg("Bash", "perm-safe-no-auto"));

      await vi.waitFor(() => {
        expect(session.pendingPermissions.has("perm-safe-no-auto")).toBe(true);
      });

      // Should NOT auto-resolve — falls through to manual
      expect(adapter.sendBrowserMessage).not.toHaveBeenCalled();

      // Should broadcast permission_request with ai_validation info attached
      expect(deps.broadcastToBrowsers).toHaveBeenCalledWith(session, {
        type: "permission_request",
        request: expect.objectContaining({
          request_id: "perm-safe-no-auto",
          ai_validation: { verdict: "safe", reason: "Standard dev command", ruleBasedOnly: false },
        }),
      });
    });

    it("propagates actionable AI service error reason through to browser permission request", async () => {
      // When aiEvaluate returns an uncertain verdict due to a service failure (e.g., invalid key),
      // the specific error reason should be attached to the permission request sent to browsers,
      // allowing users to see why AI analysis failed and take corrective action.
      enableAiValidation();
      vi.mocked(aiValidator.validatePermission).mockResolvedValue({
        verdict: "uncertain",
        reason: "Invalid Anthropic API key: invalid x-api-key",
        ruleBasedOnly: false,
      });

      attachCodexAdapterHandlers("test-session", session, adapter as unknown as CodexAdapter, deps);
      adapter._trigger("onBrowserMessage", makePermissionMsg("Bash", "perm-api-err"));

      await vi.waitFor(() => {
        expect(session.pendingPermissions.has("perm-api-err")).toBe(true);
      });

      // The permission stored and broadcast should carry the actionable reason
      const stored = session.pendingPermissions.get("perm-api-err");
      expect(stored!.ai_validation).toEqual({
        verdict: "uncertain",
        reason: "Invalid Anthropic API key: invalid x-api-key",
        ruleBasedOnly: false,
      });

      // Browser should receive the specific reason, not a generic "AI service request failed"
      expect(deps.broadcastToBrowsers).toHaveBeenCalledWith(session, {
        type: "permission_request",
        request: expect.objectContaining({
          request_id: "perm-api-err",
          ai_validation: expect.objectContaining({
            reason: "Invalid Anthropic API key: invalid x-api-key",
          }),
        }),
      });

      // Manual review — no auto-resolution
      expect(adapter.sendBrowserMessage).not.toHaveBeenCalled();
    });

    it("logs AI validation errors with session and tool context", async () => {
      // When AI validation throws, the console.warn should include session ID,
      // tool name, and request ID for debugging correlation.
      enableAiValidation();
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      vi.mocked(aiValidator.validatePermission).mockRejectedValue(
        new Error("Connection refused"),
      );

      attachCodexAdapterHandlers("test-session", session, adapter as unknown as CodexAdapter, deps);
      adapter._trigger("onBrowserMessage", makePermissionMsg("Bash", "perm-log-test"));

      await vi.waitFor(() => {
        expect(session.pendingPermissions.has("perm-log-test")).toBe(true);
      });

      // The console.warn should contain session/tool/request context
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("tool=Bash"),
        expect.any(Error),
      );
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("session=test-session"),
        expect.any(Error),
      );
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("request_id=perm-log-test"),
        expect.any(Error),
      );

      warnSpy.mockRestore();
    });

    it("does not auto-deny dangerous verdict when aiValidationAutoDeny is false", async () => {
      // When the verdict is "dangerous" but auto-deny is disabled, the handler
      // should fall through to manual review instead of auto-denying.
      vi.mocked(settingsManager.getSettings).mockReturnValue({
        anthropicApiKey: "test-api-key",
        anthropicModel: "claude-sonnet-4-6",
        linearApiKey: "",
        linearAutoTransition: false,
        linearAutoTransitionStateId: "",
        linearAutoTransitionStateName: "",
    linearArchiveTransition: false,
    linearArchiveTransitionStateId: "",
    linearArchiveTransitionStateName: "",
        linearOAuthClientId: "",
        linearOAuthClientSecret: "",
        linearOAuthWebhookSecret: "",
        linearOAuthAccessToken: "",
        linearOAuthRefreshToken: "",
        claudeCodeOAuthToken: "",
        openaiApiKey: "",
        onboardingCompleted: false,
        aiValidationEnabled: true,
        aiValidationAutoApprove: true,
        aiValidationAutoDeny: false,  // disabled
        publicUrl: "",
        updateChannel: "stable",
        dockerAutoUpdate: false,
        updatedAt: 0,
      });

      vi.mocked(aiValidator.validatePermission).mockResolvedValue({
        verdict: "dangerous",
        reason: "Recursive delete",
        ruleBasedOnly: true,
      });

      attachCodexAdapterHandlers("test-session", session, adapter as unknown as CodexAdapter, deps);
      adapter._trigger("onBrowserMessage", makePermissionMsg("Bash", "perm-danger-no-auto"));

      await vi.waitFor(() => {
        expect(session.pendingPermissions.has("perm-danger-no-auto")).toBe(true);
      });

      // Should NOT auto-resolve — falls through to manual
      expect(adapter.sendBrowserMessage).not.toHaveBeenCalled();

      // Should broadcast permission_request with ai_validation info attached
      expect(deps.broadcastToBrowsers).toHaveBeenCalledWith(session, {
        type: "permission_request",
        request: expect.objectContaining({
          request_id: "perm-danger-no-auto",
          ai_validation: { verdict: "dangerous", reason: "Recursive delete", ruleBasedOnly: true },
        }),
      });
    });
  });

  // ── Per-session listeners (chat relay) ──────────────────────────────────

  describe("per-session bus events (chat relay)", () => {
    it("emits message:assistant on bus when assistant message arrives", () => {
      // Chat relay relies on bus events to forward agent responses
      // to external platforms. The Codex path must emit these just like the
      // Claude Code path does.
      const listener = vi.fn();
      companionBus.on("message:assistant", ({ sessionId, message }) => {
        if (sessionId === "test-session") listener(message);
      });

      attachCodexAdapterHandlers("test-session", session, adapter as unknown as CodexAdapter, deps);

      const assistantMsg: BrowserIncomingMessage = {
        type: "assistant",
        message: {
          id: "msg-listener",
          type: "message",
          role: "assistant",
          model: "o3-pro",
          content: [{ type: "text", text: "Hello from Codex" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        },
        parent_tool_use_id: null,
        timestamp: 1700000000000,
      };

      adapter._trigger("onBrowserMessage", assistantMsg);

      expect(listener).toHaveBeenCalledOnce();
      // The listener should receive the message with timestamp
      expect(listener.mock.calls[0][0]).toMatchObject({
        type: "assistant",
        timestamp: 1700000000000,
      });
    });

    it("emits message:result on bus when result message arrives", () => {
      // Result events signal turn completion so chat relay can post
      // accumulated text back to the platform.
      const listener = vi.fn();
      companionBus.on("message:result", ({ sessionId, message }) => {
        if (sessionId === "test-session") listener(message);
      });

      attachCodexAdapterHandlers("test-session", session, adapter as unknown as CodexAdapter, deps);

      const resultMsg: BrowserIncomingMessage = {
        type: "result",
        data: {
          type: "result",
          subtype: "success",
          is_error: false,
          result: undefined,
          duration_ms: 100,
          duration_api_ms: 80,
          num_turns: 1,
          total_cost_usd: 0.01,
          stop_reason: "end_turn",
          usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
          uuid: "result-listener-1",
          session_id: "test-session",
        },
      };

      adapter._trigger("onBrowserMessage", resultMsg);

      expect(listener).toHaveBeenCalledOnce();
      expect(listener.mock.calls[0][0]).toMatchObject({ type: "result" });
    });

    it("does not invoke session-filtered listeners for a different session", () => {
      // Bus subscribers that filter by sessionId should not fire when
      // messages arrive for a different session.
      const listener = vi.fn();
      companionBus.on("message:assistant", ({ sessionId, message }) => {
        if (sessionId === "other-session") listener(message);
      });

      attachCodexAdapterHandlers("test-session", session, adapter as unknown as CodexAdapter, deps);

      adapter._trigger("onBrowserMessage", {
        type: "assistant",
        message: {
          id: "msg-other",
          type: "message",
          role: "assistant",
          model: "o3-pro",
          content: [{ type: "text", text: "Hello" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        },
        parent_tool_use_id: null,
        timestamp: Date.now(),
      });

      expect(listener).not.toHaveBeenCalled();
    });

    it("does not throw when no bus subscribers are registered", () => {
      // When no subscribers are listening on the bus, emitting events
      // should not throw.
      attachCodexAdapterHandlers("test-session", session, adapter as unknown as CodexAdapter, deps);

      expect(() => {
        adapter._trigger("onBrowserMessage", {
          type: "assistant",
          message: {
            id: "msg-no-listener",
            type: "message",
            role: "assistant",
            model: "o3-pro",
            content: [{ type: "text", text: "Hello" }],
            stop_reason: "end_turn",
            usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
          },
          parent_tool_use_id: null,
          timestamp: Date.now(),
        });
      }).not.toThrow();
    });
  });

  // ── lastCliActivityTs tracking ──────────────────────────────────────────

  describe("lastCliActivityTs tracking for idle detection", () => {
    it("updates lastCliActivityTs when adapter emits messages", () => {
      // Codex sessions route through the adapter, not routeCLIMessage.
      // Without updating lastCliActivityTs here, the idle kill watchdog
      // would incorrectly kill active Codex sessions.
      const initialTs = session.lastCliActivityTs;

      // Advance time — use try/finally to ensure fake timers are restored
      // even if assertions fail, preventing leaks into subsequent tests.
      vi.useFakeTimers();
      try {
        vi.advanceTimersByTime(5000);

        attachCodexAdapterHandlers("test-session", session, adapter as unknown as CodexAdapter, deps);

        // Simulate an assistant message from Codex
        adapter._trigger("onBrowserMessage", {
          type: "assistant",
          message: {
            id: "msg-1",
            type: "message",
            role: "assistant",
            model: "o4-mini",
            content: [{ type: "text", text: "Hi" }],
            stop_reason: "end_turn",
            usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
          },
          parent_tool_use_id: null,
          timestamp: Date.now(),
        });

        // lastCliActivityTs should have been updated
        expect(session.lastCliActivityTs).toBeGreaterThan(initialTs);
      } finally {
        vi.useRealTimers();
      }
    });

    it("updates lastCliActivityTs on result messages", () => {
      // Result messages (turn completed) should also update activity tracking
      const oldTs = Date.now() - 60000;
      session.lastCliActivityTs = oldTs;

      attachCodexAdapterHandlers("test-session", session, adapter as unknown as CodexAdapter, deps);

      adapter._trigger("onBrowserMessage", {
        type: "result",
        subtype: "result",
        data: { result: "Task completed" },
      });

      expect(session.lastCliActivityTs).toBeGreaterThan(oldTs);
    });

    it("updates lastCliActivityTs on session_init messages", () => {
      // Even session_init should count as activity
      const oldTs = Date.now() - 60000;
      session.lastCliActivityTs = oldTs;

      attachCodexAdapterHandlers("test-session", session, adapter as unknown as CodexAdapter, deps);

      adapter._trigger("onBrowserMessage", {
        type: "session_init",
        session: {
          session_id: "test-session",
          backend_type: "codex",
          model: "o4-mini",
          cwd: "/tmp",
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

      expect(session.lastCliActivityTs).toBeGreaterThan(oldTs);
    });
  });
});
