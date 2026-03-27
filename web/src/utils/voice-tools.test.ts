// @vitest-environment jsdom
/**
 * Tests for the voice tool executor.
 *
 * Validates that each tool correctly maps to the appropriate
 * Companion API call and returns the expected result.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { useStore } from "../store.js";

// Mock external dependencies to prevent actual API/WS calls
vi.mock("../api.js", () => ({
  api: {
    listSessions: vi.fn().mockResolvedValue([
      { sessionId: "s1", state: "connected", backendType: "claude", cwd: "/home/user/project", archived: false, name: "Test Session" },
      { sessionId: "s2", state: "running", backendType: "codex", cwd: "/home/user/other", archived: true, name: "Archived" },
    ]),
    getGeminiKey: vi.fn().mockResolvedValue({ key: "test-key" }),
  },
  createSessionStream: vi.fn().mockResolvedValue({
    sessionId: "new-session",
    state: "starting",
    cwd: "/home/user/project",
    backendType: "claude",
  }),
}));

vi.mock("../ws.js", () => ({
  sendToSession: vi.fn(),
  createClientMessageId: vi.fn(() => "test-msg-id"),
  connectSession: vi.fn(),
  waitForConnection: vi.fn().mockResolvedValue(undefined),
}));

describe("voice-tools", () => {
  beforeEach(() => {
    useStore.getState().reset();
    vi.clearAllMocks();
    // Reset hash for navigation tests
    window.location.hash = "#/";
  });

  // ── navigate_page ──────────────────────────────────────────────────────

  it("navigate_page sets correct hash for settings", async () => {
    const { executeVoiceTool } = await import("./voice-tools.js");
    const result = await executeVoiceTool("navigate_page", { page: "settings" });
    expect(result).toEqual({ success: true, navigated_to: "settings" });
    expect(window.location.hash).toBe("#/settings");
  });

  it("navigate_page sets #/ for home", async () => {
    const { executeVoiceTool } = await import("./voice-tools.js");
    window.location.hash = "#/settings";
    const result = await executeVoiceTool("navigate_page", { page: "home" });
    expect(result).toEqual({ success: true, navigated_to: "home" });
    expect(window.location.hash).toBe("#/");
  });

  it("navigate_page returns error for invalid page", async () => {
    const { executeVoiceTool } = await import("./voice-tools.js");
    const result = await executeVoiceTool("navigate_page", { page: "nonexistent" });
    expect(result).toEqual(expect.objectContaining({ error: expect.stringContaining("Invalid page") }));
  });

  // ── list_sessions ──────────────────────────────────────────────────────

  it("list_sessions returns formatted session list", async () => {
    const { executeVoiceTool } = await import("./voice-tools.js");
    const result = (await executeVoiceTool("list_sessions", {})) as {
      sessions: Array<{ id: string; name: string; status: string; backend: string }>;
      count: number;
    };
    // Should only include non-archived sessions
    expect(result.count).toBe(1);
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0].id).toBe("s1");
    expect(result.sessions[0].backend).toBe("claude");
  });

  // ── switch_session ─────────────────────────────────────────────────────

  it("switch_session by name finds correct session ID", async () => {
    const { executeVoiceTool } = await import("./voice-tools.js");
    // Set up session names in the store
    useStore.getState().setSessionName("session-123", "My Project");
    // Add to sdkSessions so exists check passes
    useStore.getState().setSdkSessions([
      { sessionId: "session-123", state: "connected", cwd: "/home/user/project", createdAt: Date.now() },
    ]);

    const result = await executeVoiceTool("switch_session", { session_name_or_id: "My Project" });
    expect(result).toEqual(expect.objectContaining({
      success: true,
      session_id: "session-123",
    }));
  });

  it("switch_session returns error for unknown session", async () => {
    const { executeVoiceTool } = await import("./voice-tools.js");
    const result = await executeVoiceTool("switch_session", { session_name_or_id: "nonexistent" });
    expect(result).toEqual(expect.objectContaining({ error: expect.stringContaining("not found") }));
  });

  // ── approve_permission ─────────────────────────────────────────────────

  it("approve_permission sends correct WebSocket message", async () => {
    const { executeVoiceTool } = await import("./voice-tools.js");
    const { sendToSession } = await import("../ws.js");

    const result = await executeVoiceTool("approve_permission", {
      session_id: "s1",
      request_id: "req-1",
    });

    expect(result).toEqual({ success: true, action: "allow" });
    expect(sendToSession).toHaveBeenCalledWith("s1", {
      type: "permission_response",
      request_id: "req-1",
      behavior: "allow",
    });
  });

  // ── deny_permission ────────────────────────────────────────────────────

  it("deny_permission sends deny behavior", async () => {
    const { executeVoiceTool } = await import("./voice-tools.js");
    const { sendToSession } = await import("../ws.js");

    const result = await executeVoiceTool("deny_permission", {
      session_id: "s1",
      request_id: "req-1",
    });

    expect(result).toEqual({ success: true, action: "deny" });
    expect(sendToSession).toHaveBeenCalledWith("s1", {
      type: "permission_response",
      request_id: "req-1",
      behavior: "deny",
    });
  });

  // ── interrupt_session ──────────────────────────────────────────────────

  it("interrupt_session sends interrupt message", async () => {
    const { executeVoiceTool } = await import("./voice-tools.js");
    const { sendToSession } = await import("../ws.js");

    const result = await executeVoiceTool("interrupt_session", { session_id: "s1" });

    expect(result).toEqual({ success: true });
    expect(sendToSession).toHaveBeenCalledWith("s1", { type: "interrupt" });
  });

  // ── send_message ───────────────────────────────────────────────────────

  it("send_message sends user message via WebSocket", async () => {
    const { executeVoiceTool } = await import("./voice-tools.js");
    const { sendToSession } = await import("../ws.js");

    const result = await executeVoiceTool("send_message", {
      session_id: "s1",
      content: "Fix the bug",
    });

    expect(result).toEqual({ success: true });
    expect(sendToSession).toHaveBeenCalledWith("s1", expect.objectContaining({
      type: "user_message",
      content: "Fix the bug",
    }));
  });

  // ── create_session ──────────────────────────────────────────────────────

  it("create_session creates session, navigates, and sends prompt", async () => {
    const { executeVoiceTool } = await import("./voice-tools.js");
    const { createSessionStream } = await import("../api.js");
    const { connectSession, waitForConnection, sendToSession } = await import("../ws.js");

    const result = await executeVoiceTool("create_session", {
      prompt: "Fix the login bug",
      cwd: "/home/user/project",
      backend: "claude",
    }) as { success: boolean; session_id: string };

    expect(result.success).toBe(true);
    expect(result.session_id).toBe("new-session");
    expect(createSessionStream).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: "/home/user/project", backend: "claude" }),
      expect.any(Function),
    );
    expect(connectSession).toHaveBeenCalledWith("new-session");
    expect(waitForConnection).toHaveBeenCalledWith("new-session");
    expect(sendToSession).toHaveBeenCalledWith("new-session", expect.objectContaining({
      type: "user_message",
      content: "Fix the login bug",
    }));
  });

  it("create_session returns error on failure", async () => {
    const { executeVoiceTool } = await import("./voice-tools.js");
    const { createSessionStream } = await import("../api.js");
    vi.mocked(createSessionStream).mockRejectedValueOnce(new Error("CLI not found"));

    const result = await executeVoiceTool("create_session", {
      prompt: "Hello",
    }) as { error: string };

    expect(result.error).toBe("CLI not found");
  });

  it("create_session works without prompt", async () => {
    const { executeVoiceTool } = await import("./voice-tools.js");
    const { sendToSession } = await import("../ws.js");
    vi.mocked(sendToSession).mockClear();

    const result = await executeVoiceTool("create_session", {
      prompt: "",
      cwd: "/tmp",
    }) as { success: boolean };

    expect(result.success).toBe(true);
    // Should not send a user_message when prompt is empty
    // (sendToSession might be called for connectSession internals, check for user_message type)
    const userMsgCalls = vi.mocked(sendToSession).mock.calls.filter(
      (c) => (c[1] as { type: string }).type === "user_message",
    );
    expect(userMsgCalls).toHaveLength(0);
  });

  // ── get_session_status ─────────────────────────────────────────────────

  it("get_session_status returns session info", async () => {
    const { executeVoiceTool } = await import("./voice-tools.js");

    // Set up a session in the store
    const store = useStore.getState();
    store.addSession({
      session_id: "test-session",
      model: "claude-sonnet-4-6",
      cwd: "/home/user/project",
      permissionMode: "acceptEdits",
      total_cost_usd: 0.05,
      num_turns: 3,
      context_used_percent: 42,
      git_branch: "main",
      tools: [],
      claude_code_version: "1.0",
      mcp_servers: [],
      agents: [],
      slash_commands: [],
      skills: [],
      is_compacting: false,
      is_worktree: false,
      is_containerized: false,
      repo_root: "/home/user/project",
      git_ahead: 0,
      git_behind: 0,
      total_lines_added: 10,
      total_lines_removed: 5,
    });
    store.setSessionName("test-session", "My Session");
    store.setSessionStatus("test-session", "running");

    const result = await executeVoiceTool("get_session_status", {
      session_id: "test-session",
    }) as { model: string; cwd: string; status: string; name: string; cost_usd: number; pending_permissions: unknown[] };

    expect(result.name).toBe("My Session");
    expect(result.model).toBe("claude-sonnet-4-6");
    expect(result.cwd).toBe("/home/user/project");
    expect(result.status).toBe("running");
    expect(result.cost_usd).toBe(0.05);
    expect(result.pending_permissions).toEqual([]);
  });

  it("get_session_status returns error for unknown session", async () => {
    const { executeVoiceTool } = await import("./voice-tools.js");

    const result = await executeVoiceTool("get_session_status", {
      session_id: "nonexistent",
    }) as { error: string };

    expect(result.error).toContain("not found");
  });

  // ── approve_all_permissions ────────────────────────────────────────────

  it("approve_all_permissions approves all pending permissions", async () => {
    const { executeVoiceTool } = await import("./voice-tools.js");
    const { sendToSession } = await import("../ws.js");
    vi.mocked(sendToSession).mockClear();

    // Set up pending permissions in the store
    const store = useStore.getState();
    store.addPermission("s1", {
      request_id: "req-1",
      tool_name: "Write",
      input: {},
      tool_use_id: "tu-1",
      timestamp: Date.now(),
    });
    store.addPermission("s1", {
      request_id: "req-2",
      tool_name: "Bash",
      input: {},
      tool_use_id: "tu-2",
      timestamp: Date.now(),
    });

    const result = await executeVoiceTool("approve_all_permissions", {
      session_id: "s1",
    }) as { success: boolean; approved_count: number };

    expect(result.success).toBe(true);
    expect(result.approved_count).toBe(2);
    expect(sendToSession).toHaveBeenCalledTimes(2);
  });

  it("approve_all_permissions returns 0 when no permissions pending", async () => {
    const { executeVoiceTool } = await import("./voice-tools.js");

    const result = await executeVoiceTool("approve_all_permissions", {
      session_id: "no-perms-session",
    }) as { success: boolean; approved_count: number };

    expect(result.success).toBe(true);
    expect(result.approved_count).toBe(0);
  });

  // ── send_message edge cases ────────────────────────────────────────────

  it("send_message returns error when session_id missing", async () => {
    const { executeVoiceTool } = await import("./voice-tools.js");

    const result = await executeVoiceTool("send_message", {
      content: "Hello",
    }) as { error: string };

    expect(result.error).toContain("required");
  });

  // ── unknown tool ───────────────────────────────────────────────────────

  it("returns error for unknown tool name", async () => {
    const { executeVoiceTool } = await import("./voice-tools.js");
    const result = await executeVoiceTool("nonexistent_tool", {});
    expect(result).toEqual({ error: "Unknown tool: nonexistent_tool" });
  });

  // ── TOOL_DECLARATIONS validation ───────────────────────────────────────

  it("TOOL_DECLARATIONS has 10 function declarations", async () => {
    const { TOOL_DECLARATIONS } = await import("./voice-tools.js");
    expect(TOOL_DECLARATIONS).toHaveLength(10);
  });

  it("all tool declarations have name, description, and parameters", async () => {
    const { TOOL_DECLARATIONS } = await import("./voice-tools.js");
    for (const decl of TOOL_DECLARATIONS) {
      expect(decl).toHaveProperty("name");
      expect(decl).toHaveProperty("description");
      expect(decl).toHaveProperty("parameters");
      expect(typeof decl.name).toBe("string");
      expect(typeof decl.description).toBe("string");
      expect(decl.parameters.type).toBe("OBJECT");
    }
  });
});
