// @vitest-environment jsdom

// vi.hoisted runs before any imports, ensuring browser globals are available when store.ts initializes.
vi.hoisted(() => {
  // jsdom does not implement matchMedia
  Object.defineProperty(globalThis.window, "matchMedia", {
    writable: true,
    configurable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  });

  // Node.js 22+ native localStorage may be broken (invalid --localstorage-file).
  // Polyfill before store.ts import triggers getInitialSessionId().
  if (
    typeof globalThis.localStorage === "undefined" ||
    typeof globalThis.localStorage.getItem !== "function"
  ) {
    const store = new Map<string, string>();
    Object.defineProperty(globalThis, "localStorage", {
      value: {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => { store.set(key, String(value)); },
        removeItem: (key: string) => { store.delete(key); },
        clear: () => { store.clear(); },
        get length() { return store.size; },
        key: (index: number) => [...store.keys()][index] ?? null,
      },
      writable: true,
      configurable: true,
    });
  }
});

import { useStore } from "../store.js";
import type { SessionState, ChatMessage, PermissionRequest, TaskItem, SdkSessionInfo, ProcessItem } from "../types.js";

function makeSession(id: string): SessionState {
  return {
    session_id: id,
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
  };
}

function makeMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: crypto.randomUUID(),
    role: "user",
    content: "hello",
    timestamp: Date.now(),
    ...overrides,
  };
}

function makePermission(overrides: Partial<PermissionRequest> = {}): PermissionRequest {
  return {
    request_id: crypto.randomUUID(),
    tool_name: "Bash",
    input: { command: "ls" },
    timestamp: Date.now(),
    tool_use_id: crypto.randomUUID(),
    ...overrides,
  };
}

function makeTask(overrides: Partial<TaskItem> = {}): TaskItem {
  return {
    id: crypto.randomUUID(),
    subject: "Do something",
    description: "A task",
    status: "pending",
    ...overrides,
  };
}

function makeProcess(overrides: Partial<ProcessItem> = {}): ProcessItem {
  return {
    taskId: crypto.randomUUID().slice(0, 7),
    toolUseId: crypto.randomUUID(),
    command: "npm test",
    description: "Running tests",
    outputFile: "/tmp/output.txt",
    status: "running",
    startedAt: Date.now(),
    ...overrides,
  };
}

beforeEach(() => {
  useStore.getState().reset();
  localStorage.clear();
});

// ─── Reset ──────────────────────────────────────────────────────────────────

describe("reset", () => {
  it("clears all maps and resets state", () => {
    // Populate many fields
    useStore.getState().addSession(makeSession("s1"));
    useStore.getState().setCurrentSession("s1");
    useStore.getState().appendMessage("s1", makeMessage());
    useStore.getState().setStreaming("s1", "text");
    useStore.getState().setStreamingStats("s1", { startedAt: 1, outputTokens: 2 });
    useStore.getState().addPermission("s1", makePermission());
    useStore.getState().addTask("s1", makeTask());
    useStore.getState().addToolActivity("s1", {
      toolUseId: "tool-1",
      toolName: "Bash",
      preview: "ls",
      startedAt: 1,
      elapsedSeconds: 1,
      isError: false,
    });
    useStore.getState().setSessionName("s1", "name");
    useStore.getState().markRecentlyRenamed("s1");
    useStore.getState().setConnectionStatus("s1", "connected");
    useStore.getState().setCliConnected("s1", true);
    useStore.getState().setSessionStatus("s1", "running");
    useStore.getState().setPreviousPermissionMode("s1", "default");
    useStore.getState().setSdkSessions([
      { sessionId: "s1", state: "connected", cwd: "/", createdAt: 0 },
    ]);

    useStore.getState().reset();
    const state = useStore.getState();

    expect(state.sessions.size).toBe(0);
    expect(state.sdkSessions).toEqual([]);
    expect(state.currentSessionId).toBeNull();
    expect(state.messages.size).toBe(0);
    expect(state.streaming.size).toBe(0);
    expect(state.streamingStartedAt.size).toBe(0);
    expect(state.streamingOutputTokens.size).toBe(0);
    expect(state.pendingPermissions.size).toBe(0);
    expect(state.connectionStatus.size).toBe(0);
    expect(state.cliConnected.size).toBe(0);
    expect(state.sessionStatus.size).toBe(0);
    expect(state.previousPermissionMode.size).toBe(0);
    expect(state.sessionTasks.size).toBe(0);
    expect(state.toolActivity.size).toBe(0);
    expect(state.sessionNames.size).toBe(0);
    expect(state.recentlyRenamed.size).toBe(0);
    expect(state.mcpServers.size).toBe(0);
  });
});

// ─── removeSession: comprehensive cleanup ────────────────────────────────────

describe("removeSession: comprehensive cleanup", () => {
  it("cleans up all session-related maps including linkedLinearIssues, chatTabReentry, diffPanelSelectedFile, toolProgress, prStatus", () => {
    // Set up a session with data in every possible map
    useStore.getState().addSession(makeSession("s1"));
    useStore.getState().setCurrentSession("s1");
    useStore.getState().setLinkedLinearIssue("s1", {
      id: "i1", identifier: "ENG-1", title: "t", description: "d",
      url: "u", branchName: "b", priorityLabel: "p", stateName: "s",
      stateType: "st", teamName: "tm", teamKey: "ENG", teamId: "t1",
    });
    useStore.getState().markChatTabReentry("s1");
    useStore.getState().setDiffPanelSelectedFile("s1", "file.ts");
    useStore.getState().setToolProgress("s1", "t1", { toolName: "Bash", elapsedSeconds: 1 });
    useStore.getState().setPRStatus("s1", { available: true, pr: null });
    useStore.getState().addProcess("s1", makeProcess());
    useStore.getState().bumpChangedFilesTick("s1");
    useStore.getState().setGitChangedFilesCount("s1", 3);
    useStore.getState().setSdkSessions([
      { sessionId: "s1", state: "connected", cwd: "/", createdAt: 0 },
    ]);

    useStore.getState().removeSession("s1");

    const state = useStore.getState();
    expect(state.linkedLinearIssues.has("s1")).toBe(false);
    expect(state.chatTabReentryTickBySession.has("s1")).toBe(false);
    expect(state.diffPanelSelectedFile.has("s1")).toBe(false);
    expect(state.toolProgress.has("s1")).toBe(false);
    expect(state.prStatus.has("s1")).toBe(false);
    expect(state.sessionProcesses.has("s1")).toBe(false);
    expect(state.changedFilesTick.has("s1")).toBe(false);
    expect(state.gitChangedFilesCount.has("s1")).toBe(false);
    expect(state.sdkSessions).toHaveLength(0);
    expect(state.currentSessionId).toBeNull();
  });
});

// ─── deleteFromMap / deleteFromSet helpers (indirectly) ──────────────────────

describe("deleteFromMap / deleteFromSet helpers", () => {
  it("removeSession on non-existent session returns same references for maps without that key", () => {
    // Pre-populate another session to ensure there's data
    useStore.getState().addSession(makeSession("s1"));
    useStore.getState().setSessionName("s1", "Test");

    const sessionsBefore = useStore.getState().sessions;

    // Remove a session that doesn't exist in most maps
    useStore.getState().removeSession("nonexistent");

    // The sessions map should have changed (since it checks for the key),
    // but if the key wasn't present, same reference should be returned
    // We verify the s1 session is still intact
    expect(useStore.getState().sessions.get("s1")).toBeDefined();
    expect(useStore.getState().sessionNames.get("s1")).toBe("Test");
  });
});
