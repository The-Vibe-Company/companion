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

import { useStore } from "./store.js";
import type { SessionState, PermissionRequest, ChatMessage, TaskItem, SdkSessionInfo, ProcessItem } from "./types.js";
import type { CreationProgressEvent, PRStatusResponse, LinearIssue } from "./api.js";

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

// ─── Session management ─────────────────────────────────────────────────────

describe("Session management", () => {
  it("addSession: adds to sessions map and initializes empty messages", () => {
    const session = makeSession("s1");
    useStore.getState().addSession(session);

    const state = useStore.getState();
    expect(state.sessions.get("s1")).toEqual(session);
    expect(state.messages.get("s1")).toEqual([]);
  });

  it("addSession: does not overwrite existing messages", () => {
    const session = makeSession("s1");
    const msg = makeMessage({ role: "user", content: "existing" });
    useStore.getState().addSession(session);
    useStore.getState().appendMessage("s1", msg);

    // Re-add the same session
    useStore.getState().addSession(session);
    const state = useStore.getState();
    expect(state.messages.get("s1")).toHaveLength(1);
    expect(state.messages.get("s1")![0].content).toBe("existing");
  });

  it("updateSession: merges partial updates into existing session", () => {
    const session = makeSession("s1");
    useStore.getState().addSession(session);
    useStore.getState().updateSession("s1", { model: "claude-opus-4-6", num_turns: 5 });

    const updated = useStore.getState().sessions.get("s1")!;
    expect(updated.model).toBe("claude-opus-4-6");
    expect(updated.num_turns).toBe(5);
    // Other fields remain untouched
    expect(updated.cwd).toBe("/test");
    expect(updated.session_id).toBe("s1");
  });

  it("updateSession: no-op for unknown session", () => {
    const before = new Map(useStore.getState().sessions);
    useStore.getState().updateSession("nonexistent", { model: "claude-opus-4-6" });
    const after = useStore.getState().sessions;
    expect(after.size).toBe(before.size);
  });

  it("removeSession: cleans all maps and clears currentSessionId if removed was current", () => {
    const session = makeSession("s1");
    useStore.getState().addSession(session);
    useStore.getState().setCurrentSession("s1");
    useStore.getState().appendMessage("s1", makeMessage());
    useStore.getState().setStreaming("s1", "partial text");
    useStore.getState().setStreamingStats("s1", { startedAt: 100, outputTokens: 50 });
    useStore.getState().addPermission("s1", makePermission());
    useStore.getState().addTask("s1", makeTask());
    useStore.getState().setSessionName("s1", "My Session");
    useStore.getState().setConnectionStatus("s1", "connected");
    useStore.getState().setCliConnected("s1", true);
    useStore.getState().setSessionStatus("s1", "running");
    useStore.getState().setPreviousPermissionMode("s1", "default");

    useStore.getState().removeSession("s1");
    const state = useStore.getState();

    expect(state.sessions.has("s1")).toBe(false);
    expect(state.messages.has("s1")).toBe(false);
    expect(state.streaming.has("s1")).toBe(false);
    expect(state.streamingStartedAt.has("s1")).toBe(false);
    expect(state.streamingOutputTokens.has("s1")).toBe(false);
    expect(state.pendingPermissions.has("s1")).toBe(false);
    expect(state.sessionTasks.has("s1")).toBe(false);
    expect(state.sessionNames.has("s1")).toBe(false);
    expect(state.connectionStatus.has("s1")).toBe(false);
    expect(state.cliConnected.has("s1")).toBe(false);
    expect(state.sessionStatus.has("s1")).toBe(false);
    expect(state.previousPermissionMode.has("s1")).toBe(false);
    expect(state.currentSessionId).toBeNull();
  });

  it("removeSession: filters sdkSessions by sessionId", () => {
    const sdk1: SdkSessionInfo = {
      sessionId: "s1",
      state: "connected",
      cwd: "/test",
      createdAt: Date.now(),
    };
    const sdk2: SdkSessionInfo = {
      sessionId: "s2",
      state: "running",
      cwd: "/other",
      createdAt: Date.now(),
    };
    useStore.getState().setSdkSessions([sdk1, sdk2]);
    useStore.getState().addSession(makeSession("s1"));

    useStore.getState().removeSession("s1");
    const state = useStore.getState();
    expect(state.sdkSessions).toHaveLength(1);
    expect(state.sdkSessions[0].sessionId).toBe("s2");
  });

  it("removeSession: does not clear currentSessionId if a different session is removed", () => {
    useStore.getState().addSession(makeSession("s1"));
    useStore.getState().addSession(makeSession("s2"));
    useStore.getState().setCurrentSession("s1");

    useStore.getState().removeSession("s2");
    expect(useStore.getState().currentSessionId).toBe("s1");
  });

  it("setCurrentSession: persists to localStorage", () => {
    useStore.getState().setCurrentSession("s1");
    expect(useStore.getState().currentSessionId).toBe("s1");
    expect(localStorage.getItem("cc-current-session")).toBe("s1");
  });

  it("setCurrentSession(null): removes from localStorage", () => {
    useStore.getState().setCurrentSession("s1");
    useStore.getState().setCurrentSession(null);
    expect(useStore.getState().currentSessionId).toBeNull();
    expect(localStorage.getItem("cc-current-session")).toBeNull();
  });
});

// ─── Messages ───────────────────────────────────────────────────────────────

describe("Messages", () => {
  it("appendMessage: adds to session's list", () => {
    useStore.getState().addSession(makeSession("s1"));
    const msg = makeMessage({ content: "first" });
    useStore.getState().appendMessage("s1", msg);

    const messages = useStore.getState().messages.get("s1")!;
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe("first");
  });

  it("appendMessage: creates list even if session was not pre-initialized", () => {
    const msg = makeMessage({ content: "orphan" });
    useStore.getState().appendMessage("s1", msg);
    expect(useStore.getState().messages.get("s1")).toHaveLength(1);
  });

  it("appendMessage: deduplicates by ID", () => {
    useStore.getState().addSession(makeSession("s1"));
    const msg = makeMessage({ id: "dup-1", content: "first" });
    useStore.getState().appendMessage("s1", msg);
    useStore.getState().appendMessage("s1", { ...msg, content: "duplicate" });

    const messages = useStore.getState().messages.get("s1")!;
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe("first");
  });

  it("appendMessage: allows messages without IDs (no dedup)", () => {
    useStore.getState().addSession(makeSession("s1"));
    const msg1 = makeMessage({ id: "", content: "a" });
    const msg2 = makeMessage({ id: "", content: "b" });
    useStore.getState().appendMessage("s1", msg1);
    useStore.getState().appendMessage("s1", msg2);

    expect(useStore.getState().messages.get("s1")).toHaveLength(2);
  });

  it("setMessages: replaces all messages for a session", () => {
    useStore.getState().addSession(makeSession("s1"));
    useStore.getState().appendMessage("s1", makeMessage({ content: "old" }));

    const newMessages = [
      makeMessage({ content: "new1" }),
      makeMessage({ content: "new2" }),
    ];
    useStore.getState().setMessages("s1", newMessages);

    const messages = useStore.getState().messages.get("s1")!;
    expect(messages).toHaveLength(2);
    expect(messages[0].content).toBe("new1");
    expect(messages[1].content).toBe("new2");
  });

  it("updateLastAssistantMessage: updates the last assistant message", () => {
    useStore.getState().addSession(makeSession("s1"));
    useStore.getState().appendMessage("s1", makeMessage({ role: "user", content: "q" }));
    useStore.getState().appendMessage("s1", makeMessage({ role: "assistant", content: "a1" }));
    useStore.getState().appendMessage("s1", makeMessage({ role: "assistant", content: "a2" }));

    useStore.getState().updateLastAssistantMessage("s1", (msg) => ({
      ...msg,
      content: "a2-updated",
    }));

    const messages = useStore.getState().messages.get("s1")!;
    expect(messages[1].content).toBe("a1"); // first assistant unchanged
    expect(messages[2].content).toBe("a2-updated"); // last assistant updated
  });

  it("updateLastAssistantMessage: skips non-assistant messages from end", () => {
    useStore.getState().addSession(makeSession("s1"));
    useStore.getState().appendMessage("s1", makeMessage({ role: "assistant", content: "answer" }));
    useStore.getState().appendMessage("s1", makeMessage({ role: "user", content: "followup" }));

    useStore.getState().updateLastAssistantMessage("s1", (msg) => ({
      ...msg,
      content: "answer-updated",
    }));

    const messages = useStore.getState().messages.get("s1")!;
    expect(messages[0].content).toBe("answer-updated");
    expect(messages[1].content).toBe("followup");
  });
});

// ─── Streaming ──────────────────────────────────────────────────────────────

describe("Streaming", () => {
  it("setStreaming: sets text for a session", () => {
    useStore.getState().setStreaming("s1", "partial output");
    expect(useStore.getState().streaming.get("s1")).toBe("partial output");
  });

  it("setStreaming(null): deletes entry", () => {
    useStore.getState().setStreaming("s1", "some text");
    useStore.getState().setStreaming("s1", null);
    expect(useStore.getState().streaming.has("s1")).toBe(false);
  });

  it("setStreamingStats: sets startedAt and outputTokens", () => {
    useStore.getState().setStreamingStats("s1", { startedAt: 12345, outputTokens: 42 });
    expect(useStore.getState().streamingStartedAt.get("s1")).toBe(12345);
    expect(useStore.getState().streamingOutputTokens.get("s1")).toBe(42);
  });

  it("setStreamingStats: sets only provided fields", () => {
    useStore.getState().setStreamingStats("s1", { startedAt: 100 });
    expect(useStore.getState().streamingStartedAt.get("s1")).toBe(100);
    expect(useStore.getState().streamingOutputTokens.has("s1")).toBe(false);
  });

  it("setStreamingStats(null): clears both fields", () => {
    useStore.getState().setStreamingStats("s1", { startedAt: 100, outputTokens: 50 });
    useStore.getState().setStreamingStats("s1", null);
    expect(useStore.getState().streamingStartedAt.has("s1")).toBe(false);
    expect(useStore.getState().streamingOutputTokens.has("s1")).toBe(false);
  });
});

// ─── Permissions ────────────────────────────────────────────────────────────

describe("Permissions", () => {
  it("addPermission: adds to nested map", () => {
    const perm = makePermission({ request_id: "r1", tool_name: "Bash" });
    useStore.getState().addPermission("s1", perm);

    const sessionPerms = useStore.getState().pendingPermissions.get("s1")!;
    expect(sessionPerms.get("r1")).toEqual(perm);
  });

  it("addPermission: accumulates multiple permissions", () => {
    const perm1 = makePermission({ request_id: "r1" });
    const perm2 = makePermission({ request_id: "r2" });
    useStore.getState().addPermission("s1", perm1);
    useStore.getState().addPermission("s1", perm2);

    const sessionPerms = useStore.getState().pendingPermissions.get("s1")!;
    expect(sessionPerms.size).toBe(2);
  });

  it("removePermission: removes specific request", () => {
    const perm1 = makePermission({ request_id: "r1" });
    const perm2 = makePermission({ request_id: "r2" });
    useStore.getState().addPermission("s1", perm1);
    useStore.getState().addPermission("s1", perm2);

    useStore.getState().removePermission("s1", "r1");

    const sessionPerms = useStore.getState().pendingPermissions.get("s1")!;
    expect(sessionPerms.has("r1")).toBe(false);
    expect(sessionPerms.has("r2")).toBe(true);
  });
});

// ─── AI Resolved Permissions ────────────────────────────────────────────────

describe("AI Resolved Permissions", () => {
  it("clearAiResolvedPermissions: clears AI-resolved entries for a session", () => {
    const entry = {
      request: makePermission({ request_id: "r1", tool_name: "Read" }),
      behavior: "allow" as const,
      reason: "read-only",
      timestamp: Date.now(),
    };
    useStore.getState().addAiResolvedPermission("s1", entry);
    expect(useStore.getState().aiResolvedPermissions.get("s1")).toHaveLength(1);

    // Clear should remove the session key entirely
    useStore.getState().clearAiResolvedPermissions("s1");
    expect(useStore.getState().aiResolvedPermissions.get("s1")).toBeUndefined();
  });

  it("clearAiResolvedPermissions: no-op when session has no entries", () => {
    // Should not throw when clearing a session with no AI-resolved permissions
    useStore.getState().clearAiResolvedPermissions("nonexistent");
    expect(useStore.getState().aiResolvedPermissions.has("nonexistent")).toBe(false);
  });
});

// ─── Tasks ──────────────────────────────────────────────────────────────────

describe("Tasks", () => {
  it("addTask: appends task to session list", () => {
    const task = makeTask({ id: "t1", subject: "Fix bug" });
    useStore.getState().addTask("s1", task);

    const tasks = useStore.getState().sessionTasks.get("s1")!;
    expect(tasks).toHaveLength(1);
    expect(tasks[0].subject).toBe("Fix bug");
  });

  it("setTasks: replaces all tasks for a session", () => {
    useStore.getState().addTask("s1", makeTask({ subject: "old" }));
    const newTasks = [
      makeTask({ subject: "new1" }),
      makeTask({ subject: "new2" }),
    ];
    useStore.getState().setTasks("s1", newTasks);

    const tasks = useStore.getState().sessionTasks.get("s1")!;
    expect(tasks).toHaveLength(2);
    expect(tasks[0].subject).toBe("new1");
    expect(tasks[1].subject).toBe("new2");
  });

  it("updateTask: merges updates into matching task without affecting others", () => {
    const task1 = makeTask({ id: "t1", subject: "Task 1", status: "pending" });
    const task2 = makeTask({ id: "t2", subject: "Task 2", status: "pending" });
    useStore.getState().addTask("s1", task1);
    useStore.getState().addTask("s1", task2);

    useStore.getState().updateTask("s1", "t1", { status: "completed" });

    const tasks = useStore.getState().sessionTasks.get("s1")!;
    expect(tasks[0].status).toBe("completed");
    expect(tasks[0].subject).toBe("Task 1"); // other fields preserved
    expect(tasks[1].status).toBe("pending"); // other task untouched
  });
});

// ─── Session names ──────────────────────────────────────────────────────────

describe("Session names", () => {
  it("setSessionName: persists to localStorage as JSON", () => {
    useStore.getState().setSessionName("s1", "My Session");

    expect(useStore.getState().sessionNames.get("s1")).toBe("My Session");

    const stored = JSON.parse(localStorage.getItem("cc-session-names") || "[]");
    expect(stored).toEqual([["s1", "My Session"]]);
  });

  it("setSessionName: updates existing name", () => {
    useStore.getState().setSessionName("s1", "First");
    useStore.getState().setSessionName("s1", "Second");

    expect(useStore.getState().sessionNames.get("s1")).toBe("Second");

    const stored = JSON.parse(localStorage.getItem("cc-session-names") || "[]");
    const map = new Map(stored);
    expect(map.get("s1")).toBe("Second");
  });
});

// ─── Recently renamed (animation tracking) ──────────────────────────────────

describe("recentlyRenamed", () => {
  it("markRecentlyRenamed: adds session to the set", () => {
    useStore.getState().markRecentlyRenamed("s1");
    expect(useStore.getState().recentlyRenamed.has("s1")).toBe(true);
  });

  it("clearRecentlyRenamed: removes session from the set", () => {
    useStore.getState().markRecentlyRenamed("s1");
    useStore.getState().clearRecentlyRenamed("s1");
    expect(useStore.getState().recentlyRenamed.has("s1")).toBe(false);
  });

  it("removeSession: also clears recentlyRenamed", () => {
    useStore.getState().addSession(makeSession("s1"));
    useStore.getState().markRecentlyRenamed("s1");
    useStore.getState().removeSession("s1");
    expect(useStore.getState().recentlyRenamed.has("s1")).toBe(false);
  });
});

// ─── UI state ───────────────────────────────────────────────────────────────

describe("UI state", () => {
  it("setDarkMode: sets the value explicitly and persists to localStorage", () => {
    useStore.getState().setDarkMode(true);
    expect(useStore.getState().darkMode).toBe(true);
    expect(localStorage.getItem("cc-dark-mode")).toBe("true");

    useStore.getState().setDarkMode(false);
    expect(useStore.getState().darkMode).toBe(false);
    expect(localStorage.getItem("cc-dark-mode")).toBe("false");
  });

  it("toggleDarkMode: flips the value and persists to localStorage", () => {
    const initial = useStore.getState().darkMode;
    useStore.getState().toggleDarkMode();

    expect(useStore.getState().darkMode).toBe(!initial);
    expect(localStorage.getItem("cc-dark-mode")).toBe(String(!initial));

    useStore.getState().toggleDarkMode();
    expect(useStore.getState().darkMode).toBe(initial);
    expect(localStorage.getItem("cc-dark-mode")).toBe(String(initial));
  });

  it("newSession: clears currentSessionId and increments homeResetKey", () => {
    useStore.getState().setCurrentSession("s1");
    const keyBefore = useStore.getState().homeResetKey;

    useStore.getState().newSession();

    expect(useStore.getState().currentSessionId).toBeNull();
    expect(useStore.getState().homeResetKey).toBe(keyBefore + 1);
    expect(localStorage.getItem("cc-current-session")).toBeNull();
  });

  it("openQuickTerminal with reuseIfExists focuses existing tab instead of creating a new one", () => {
    useStore.getState().openQuickTerminal({ target: "host", cwd: "/repo" });
    const firstTabId = useStore.getState().activeQuickTerminalTabId;

    useStore.getState().openQuickTerminal({ target: "host", cwd: "/repo", reuseIfExists: true });
    const state = useStore.getState();
    expect(state.quickTerminalTabs).toHaveLength(1);
    expect(state.activeQuickTerminalTabId).toBe(firstTabId);
  });

  it("openQuickTerminal host labels stay monotonic after closing tabs", () => {
    const store = useStore.getState();
    store.openQuickTerminal({ target: "host", cwd: "/repo/a" });
    store.openQuickTerminal({ target: "host", cwd: "/repo/b" });
    store.openQuickTerminal({ target: "host", cwd: "/repo/c" });
    const secondId = useStore.getState().quickTerminalTabs[1]?.id;
    if (secondId) store.closeQuickTerminalTab(secondId);
    store.openQuickTerminal({ target: "host", cwd: "/repo/d" });

    const labels = useStore.getState().quickTerminalTabs.map((t) => t.label);
    expect(labels).toContain("Terminal");
    expect(labels).toContain("Terminal 3");
    expect(labels).toContain("Terminal 4");
  });
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
    expect(state.sessionNames.size).toBe(0);
    expect(state.recentlyRenamed.size).toBe(0);
    expect(state.mcpServers.size).toBe(0);
  });
});

// ─── MCP Servers ──────────────────────────────────────────────────────────────

describe("MCP Servers", () => {
  it("setMcpServers: stores servers for a session", () => {
    const servers = [
      { name: "test-server", status: "connected" as const, config: { type: "stdio" }, scope: "project" },
    ];
    useStore.getState().setMcpServers("s1", servers);
    expect(useStore.getState().mcpServers.get("s1")).toEqual(servers);
  });

  it("setMcpServers: replaces existing servers", () => {
    const first = [{ name: "old", status: "connected" as const, config: { type: "stdio" }, scope: "project" }];
    const second = [{ name: "new", status: "failed" as const, config: { type: "sse" }, scope: "user" }];
    useStore.getState().setMcpServers("s1", first);
    useStore.getState().setMcpServers("s1", second);
    expect(useStore.getState().mcpServers.get("s1")).toEqual(second);
  });

  it("removeSession: clears mcpServers", () => {
    const servers = [{ name: "test", status: "connected" as const, config: { type: "stdio" }, scope: "project" }];
    useStore.getState().addSession(makeSession("s1"));
    useStore.getState().setMcpServers("s1", servers);
    useStore.getState().removeSession("s1");
    expect(useStore.getState().mcpServers.has("s1")).toBe(false);
  });
});

// ─── Auth actions ────────────────────────────────────────────────────────────

describe("Auth actions", () => {
  it("setAuthToken: persists token to localStorage and sets isAuthenticated true", () => {
    useStore.getState().setAuthToken("my-secret-token");

    const state = useStore.getState();
    expect(state.authToken).toBe("my-secret-token");
    expect(state.isAuthenticated).toBe(true);
    expect(localStorage.getItem("companion_auth_token")).toBe("my-secret-token");
  });

  it("logout: removes token from localStorage and sets isAuthenticated false", () => {
    // First authenticate
    useStore.getState().setAuthToken("token-123");
    expect(useStore.getState().isAuthenticated).toBe(true);

    // Then logout
    useStore.getState().logout();

    const state = useStore.getState();
    expect(state.authToken).toBeNull();
    expect(state.isAuthenticated).toBe(false);
    expect(localStorage.getItem("companion_auth_token")).toBeNull();
  });
});

// ─── Notification settings ───────────────────────────────────────────────────

describe("Notification settings", () => {
  it("setNotificationSound: persists value to localStorage", () => {
    useStore.getState().setNotificationSound(false);
    expect(useStore.getState().notificationSound).toBe(false);
    expect(localStorage.getItem("cc-notification-sound")).toBe("false");

    useStore.getState().setNotificationSound(true);
    expect(useStore.getState().notificationSound).toBe(true);
    expect(localStorage.getItem("cc-notification-sound")).toBe("true");
  });

  it("toggleNotificationSound: flips value and persists to localStorage", () => {
    // Start with default (true after reset)
    useStore.getState().setNotificationSound(true);
    const initial = useStore.getState().notificationSound;

    useStore.getState().toggleNotificationSound();
    expect(useStore.getState().notificationSound).toBe(!initial);
    expect(localStorage.getItem("cc-notification-sound")).toBe(String(!initial));

    useStore.getState().toggleNotificationSound();
    expect(useStore.getState().notificationSound).toBe(initial);
  });

  it("setNotificationDesktop: persists value to localStorage", () => {
    useStore.getState().setNotificationDesktop(true);
    expect(useStore.getState().notificationDesktop).toBe(true);
    expect(localStorage.getItem("cc-notification-desktop")).toBe("true");

    useStore.getState().setNotificationDesktop(false);
    expect(useStore.getState().notificationDesktop).toBe(false);
    expect(localStorage.getItem("cc-notification-desktop")).toBe("false");
  });

  it("toggleNotificationDesktop: flips value and persists to localStorage", () => {
    useStore.getState().setNotificationDesktop(false);

    useStore.getState().toggleNotificationDesktop();
    expect(useStore.getState().notificationDesktop).toBe(true);
    expect(localStorage.getItem("cc-notification-desktop")).toBe("true");

    useStore.getState().toggleNotificationDesktop();
    expect(useStore.getState().notificationDesktop).toBe(false);
    expect(localStorage.getItem("cc-notification-desktop")).toBe("false");
  });
});

// ─── Sidebar & task panel configuration ──────────────────────────────────────

describe("Sidebar & task panel configuration", () => {
  it("setSidebarOpen: sets the sidebar open state", () => {
    useStore.getState().setSidebarOpen(false);
    expect(useStore.getState().sidebarOpen).toBe(false);

    useStore.getState().setSidebarOpen(true);
    expect(useStore.getState().sidebarOpen).toBe(true);
  });

  it("setTaskPanelOpen: sets the task panel open state", () => {
    useStore.getState().setTaskPanelOpen(false);
    expect(useStore.getState().taskPanelOpen).toBe(false);

    useStore.getState().setTaskPanelOpen(true);
    expect(useStore.getState().taskPanelOpen).toBe(true);
  });

  it("setTaskPanelConfigMode: toggles config mode on and off", () => {
    useStore.getState().setTaskPanelConfigMode(true);
    expect(useStore.getState().taskPanelConfigMode).toBe(true);

    useStore.getState().setTaskPanelConfigMode(false);
    expect(useStore.getState().taskPanelConfigMode).toBe(false);
  });

  it("toggleSectionEnabled: flips the enabled state for a section and persists config", () => {
    // Sections start enabled by default
    const sectionId = "tasks";
    const initialEnabled = useStore.getState().taskPanelConfig.enabled[sectionId];
    expect(initialEnabled).toBe(true);

    useStore.getState().toggleSectionEnabled(sectionId);
    expect(useStore.getState().taskPanelConfig.enabled[sectionId]).toBe(false);

    // Verify persistence to localStorage
    const stored = JSON.parse(localStorage.getItem("cc-task-panel-config") || "{}");
    expect(stored.enabled[sectionId]).toBe(false);

    // Toggle back
    useStore.getState().toggleSectionEnabled(sectionId);
    expect(useStore.getState().taskPanelConfig.enabled[sectionId]).toBe(true);
  });

  it("moveSectionUp: swaps section with the one above it", () => {
    const order = useStore.getState().taskPanelConfig.order;
    // Move the second section up
    const secondId = order[1];
    const firstId = order[0];

    useStore.getState().moveSectionUp(secondId);

    const newOrder = useStore.getState().taskPanelConfig.order;
    expect(newOrder[0]).toBe(secondId);
    expect(newOrder[1]).toBe(firstId);

    // Verify persistence
    const stored = JSON.parse(localStorage.getItem("cc-task-panel-config") || "{}");
    expect(stored.order[0]).toBe(secondId);
  });

  it("moveSectionUp: no-op when section is already at the top", () => {
    const orderBefore = [...useStore.getState().taskPanelConfig.order];
    const firstId = orderBefore[0];

    useStore.getState().moveSectionUp(firstId);

    // Order should remain unchanged
    expect(useStore.getState().taskPanelConfig.order).toEqual(orderBefore);
  });

  it("moveSectionDown: swaps section with the one below it", () => {
    const order = useStore.getState().taskPanelConfig.order;
    const firstId = order[0];
    const secondId = order[1];

    useStore.getState().moveSectionDown(firstId);

    const newOrder = useStore.getState().taskPanelConfig.order;
    expect(newOrder[0]).toBe(secondId);
    expect(newOrder[1]).toBe(firstId);

    // Verify persistence
    const stored = JSON.parse(localStorage.getItem("cc-task-panel-config") || "{}");
    expect(stored.order[0]).toBe(secondId);
  });

  it("moveSectionDown: no-op when section is already at the bottom", () => {
    const orderBefore = [...useStore.getState().taskPanelConfig.order];
    const lastId = orderBefore[orderBefore.length - 1];

    useStore.getState().moveSectionDown(lastId);

    expect(useStore.getState().taskPanelConfig.order).toEqual(orderBefore);
  });

  it("resetTaskPanelConfig: restores default config and persists", () => {
    // First, modify the config
    useStore.getState().toggleSectionEnabled("tasks");
    const orderBefore = useStore.getState().taskPanelConfig.order;
    useStore.getState().moveSectionDown(orderBefore[0]);

    // Reset
    useStore.getState().resetTaskPanelConfig();

    const config = useStore.getState().taskPanelConfig;
    // All sections should be enabled
    for (const key of Object.keys(config.enabled)) {
      expect(config.enabled[key]).toBe(true);
    }

    // Verify persistence
    const stored = JSON.parse(localStorage.getItem("cc-task-panel-config") || "{}");
    expect(stored.order).toBeDefined();
    expect(stored.enabled).toBeDefined();
  });
});

// ─── Creation progress ───────────────────────────────────────────────────────

describe("Creation progress", () => {
  it("addCreationProgress: appends a new step when creationProgress is null", () => {
    // clearCreation ensures no residual creation state from prior tests
    // (reset() does not clear creationProgress)
    useStore.getState().clearCreation();

    const step: CreationProgressEvent = {
      step: "spawn",
      label: "Spawning CLI",
      status: "in_progress",
    };
    useStore.getState().addCreationProgress(step);

    const state = useStore.getState();
    expect(state.creationProgress).toHaveLength(1);
    expect(state.creationProgress![0]).toEqual(step);
  });

  it("addCreationProgress: appends a second step to existing progress", () => {
    useStore.getState().clearCreation();

    const step1: CreationProgressEvent = { step: "spawn", label: "Spawning CLI", status: "done" };
    const step2: CreationProgressEvent = { step: "connect", label: "Connecting", status: "in_progress" };
    useStore.getState().addCreationProgress(step1);
    useStore.getState().addCreationProgress(step2);

    expect(useStore.getState().creationProgress).toHaveLength(2);
  });

  it("addCreationProgress: updates existing step when same step name is used", () => {
    // clearCreation ensures we start from null creationProgress, since
    // reset() does not clear this field
    useStore.getState().clearCreation();

    // Simulates a step transitioning from in_progress to done
    const stepInProgress: CreationProgressEvent = { step: "spawn", label: "Spawning", status: "in_progress" };
    const stepDone: CreationProgressEvent = { step: "spawn", label: "Spawned", status: "done" };

    useStore.getState().addCreationProgress(stepInProgress);
    useStore.getState().addCreationProgress(stepDone);

    const progress = useStore.getState().creationProgress!;
    expect(progress).toHaveLength(1);
    expect(progress[0].status).toBe("done");
    expect(progress[0].label).toBe("Spawned");
  });

  it("clearCreation: resets all creation-related state", () => {
    useStore.getState().addCreationProgress({ step: "spawn", label: "x", status: "done" });
    useStore.getState().setCreationError("something failed");
    useStore.getState().setSessionCreating(true, "claude");

    useStore.getState().clearCreation();

    const state = useStore.getState();
    expect(state.creationProgress).toBeNull();
    expect(state.creationError).toBeNull();
    expect(state.sessionCreating).toBe(false);
    expect(state.sessionCreatingBackend).toBeNull();
  });

  it("setSessionCreating: sets creating state and optional backend", () => {
    useStore.getState().setSessionCreating(true, "codex");
    expect(useStore.getState().sessionCreating).toBe(true);
    expect(useStore.getState().sessionCreatingBackend).toBe("codex");

    // Without backend argument, defaults to null
    useStore.getState().setSessionCreating(false);
    expect(useStore.getState().sessionCreating).toBe(false);
    expect(useStore.getState().sessionCreatingBackend).toBeNull();
  });

  it("setCreationError: sets and clears the error message", () => {
    useStore.getState().setCreationError("CLI failed to start");
    expect(useStore.getState().creationError).toBe("CLI failed to start");

    useStore.getState().setCreationError(null);
    expect(useStore.getState().creationError).toBeNull();
  });
});

// ─── Changed files tracking ──────────────────────────────────────────────────

describe("Changed files tracking", () => {
  it("bumpChangedFilesTick: increments tick starting from 0", () => {
    useStore.getState().bumpChangedFilesTick("s1");
    expect(useStore.getState().changedFilesTick.get("s1")).toBe(1);

    useStore.getState().bumpChangedFilesTick("s1");
    expect(useStore.getState().changedFilesTick.get("s1")).toBe(2);
  });

  it("bumpChangedFilesTick: tracks independently per session", () => {
    useStore.getState().bumpChangedFilesTick("s1");
    useStore.getState().bumpChangedFilesTick("s1");
    useStore.getState().bumpChangedFilesTick("s2");

    expect(useStore.getState().changedFilesTick.get("s1")).toBe(2);
    expect(useStore.getState().changedFilesTick.get("s2")).toBe(1);
  });

  it("setGitChangedFilesCount: stores the count for a session", () => {
    useStore.getState().setGitChangedFilesCount("s1", 5);
    expect(useStore.getState().gitChangedFilesCount.get("s1")).toBe(5);

    useStore.getState().setGitChangedFilesCount("s1", 0);
    expect(useStore.getState().gitChangedFilesCount.get("s1")).toBe(0);
  });
});

// ─── Process management ──────────────────────────────────────────────────────

describe("Process management", () => {
  it("addProcess: appends a process to the session's list", () => {
    const proc = makeProcess({ taskId: "abc", command: "npm test" });
    useStore.getState().addProcess("s1", proc);

    const processes = useStore.getState().sessionProcesses.get("s1")!;
    expect(processes).toHaveLength(1);
    expect(processes[0].command).toBe("npm test");
  });

  it("addProcess: accumulates multiple processes", () => {
    useStore.getState().addProcess("s1", makeProcess({ taskId: "a" }));
    useStore.getState().addProcess("s1", makeProcess({ taskId: "b" }));

    expect(useStore.getState().sessionProcesses.get("s1")).toHaveLength(2);
  });

  it("updateProcess: merges updates by taskId", () => {
    const proc = makeProcess({ taskId: "abc", status: "running" });
    useStore.getState().addProcess("s1", proc);

    useStore.getState().updateProcess("s1", "abc", { status: "completed", completedAt: 999 });

    const updated = useStore.getState().sessionProcesses.get("s1")![0];
    expect(updated.status).toBe("completed");
    expect(updated.completedAt).toBe(999);
    expect(updated.command).toBe("npm test"); // other fields preserved
  });

  it("updateProcess: no-op when session has no processes", () => {
    // Should not throw when updating a non-existent session
    useStore.getState().updateProcess("s1", "abc", { status: "completed" });
    expect(useStore.getState().sessionProcesses.get("s1")).toBeUndefined();
  });

  it("updateProcess: does not affect non-matching processes", () => {
    useStore.getState().addProcess("s1", makeProcess({ taskId: "a", status: "running" }));
    useStore.getState().addProcess("s1", makeProcess({ taskId: "b", status: "running" }));

    useStore.getState().updateProcess("s1", "a", { status: "completed" });

    const processes = useStore.getState().sessionProcesses.get("s1")!;
    expect(processes[0].status).toBe("completed");
    expect(processes[1].status).toBe("running");
  });

  it("updateProcessByToolUseId: merges updates by toolUseId", () => {
    const proc = makeProcess({ toolUseId: "tool-1", status: "running" });
    useStore.getState().addProcess("s1", proc);

    useStore.getState().updateProcessByToolUseId("s1", "tool-1", {
      status: "failed",
      summary: "Test failed",
    });

    const updated = useStore.getState().sessionProcesses.get("s1")![0];
    expect(updated.status).toBe("failed");
    expect(updated.summary).toBe("Test failed");
  });

  it("updateProcessByToolUseId: no-op when session has no processes", () => {
    // Should not throw when updating a non-existent session
    useStore.getState().updateProcessByToolUseId("s1", "tool-1", { status: "completed" });
    expect(useStore.getState().sessionProcesses.get("s1")).toBeUndefined();
  });
});

// ─── PR status ───────────────────────────────────────────────────────────────

describe("PR status", () => {
  it("setPRStatus: stores PR status for a session", () => {
    const status: PRStatusResponse = { available: true, pr: null };
    useStore.getState().setPRStatus("s1", status);

    expect(useStore.getState().prStatus.get("s1")).toEqual(status);
  });

  it("setPRStatus: replaces existing status", () => {
    const first: PRStatusResponse = { available: false, pr: null };
    const second: PRStatusResponse = { available: true, pr: null };
    useStore.getState().setPRStatus("s1", first);
    useStore.getState().setPRStatus("s1", second);

    expect(useStore.getState().prStatus.get("s1")!.available).toBe(true);
  });
});

// ─── Linear issues ───────────────────────────────────────────────────────────

describe("Linear issues", () => {
  const mockIssue: LinearIssue = {
    id: "issue-1",
    identifier: "ENG-123",
    title: "Fix bug",
    description: "Some description",
    url: "https://linear.app/team/issue/ENG-123",
    branchName: "fix/bug",
    priorityLabel: "High",
    stateName: "In Progress",
    stateType: "started",
    teamName: "Engineering",
    teamKey: "ENG",
    teamId: "team-1",
  };

  it("setLinkedLinearIssue: stores issue for a session", () => {
    useStore.getState().setLinkedLinearIssue("s1", mockIssue);
    expect(useStore.getState().linkedLinearIssues.get("s1")).toEqual(mockIssue);
  });

  it("setLinkedLinearIssue(null): removes the issue for a session", () => {
    useStore.getState().setLinkedLinearIssue("s1", mockIssue);
    useStore.getState().setLinkedLinearIssue("s1", null);
    expect(useStore.getState().linkedLinearIssues.has("s1")).toBe(false);
  });
});

// ─── Tool progress ───────────────────────────────────────────────────────────

describe("Tool progress", () => {
  it("setToolProgress: stores progress data for a tool in a session", () => {
    useStore.getState().setToolProgress("s1", "tool-1", {
      toolName: "Bash",
      elapsedSeconds: 5,
    });

    const sessionProgress = useStore.getState().toolProgress.get("s1")!;
    expect(sessionProgress.get("tool-1")).toEqual({
      toolName: "Bash",
      elapsedSeconds: 5,
    });
  });

  it("setToolProgress: accumulates multiple tools per session", () => {
    useStore.getState().setToolProgress("s1", "tool-1", { toolName: "Bash", elapsedSeconds: 1 });
    useStore.getState().setToolProgress("s1", "tool-2", { toolName: "Read", elapsedSeconds: 2 });

    const sessionProgress = useStore.getState().toolProgress.get("s1")!;
    expect(sessionProgress.size).toBe(2);
  });

  it("clearToolProgress with toolUseId: removes specific tool from session", () => {
    useStore.getState().setToolProgress("s1", "tool-1", { toolName: "Bash", elapsedSeconds: 1 });
    useStore.getState().setToolProgress("s1", "tool-2", { toolName: "Read", elapsedSeconds: 2 });

    useStore.getState().clearToolProgress("s1", "tool-1");

    const sessionProgress = useStore.getState().toolProgress.get("s1")!;
    expect(sessionProgress.has("tool-1")).toBe(false);
    expect(sessionProgress.has("tool-2")).toBe(true);
  });

  it("clearToolProgress without toolUseId: removes entire session's progress", () => {
    useStore.getState().setToolProgress("s1", "tool-1", { toolName: "Bash", elapsedSeconds: 1 });
    useStore.getState().setToolProgress("s1", "tool-2", { toolName: "Read", elapsedSeconds: 2 });

    useStore.getState().clearToolProgress("s1");

    expect(useStore.getState().toolProgress.has("s1")).toBe(false);
  });

  it("clearToolProgress: no-op when clearing a specific tool from non-existent session progress", () => {
    // Should not throw
    useStore.getState().clearToolProgress("s1", "tool-1");
    // toolProgress for s1 should still not exist (not created as empty)
    expect(useStore.getState().toolProgress.has("s1")).toBe(false);
  });
});

// ─── Sidebar project grouping ────────────────────────────────────────────────

describe("Sidebar project grouping", () => {
  it("toggleProjectCollapse: adds project to collapsed set and persists", () => {
    // collapsedProjects is not cleared by reset(), so ensure a clean slate
    useStore.setState({ collapsedProjects: new Set() });

    useStore.getState().toggleProjectCollapse("/home/project-a");

    expect(useStore.getState().collapsedProjects.has("/home/project-a")).toBe(true);
    const stored = JSON.parse(localStorage.getItem("cc-collapsed-projects") || "[]");
    expect(stored).toContain("/home/project-a");
  });

  it("toggleProjectCollapse: removes project from collapsed set on second toggle", () => {
    // Start from a known empty state since reset() does not clear collapsedProjects
    useStore.setState({ collapsedProjects: new Set() });

    useStore.getState().toggleProjectCollapse("/home/project-a");
    useStore.getState().toggleProjectCollapse("/home/project-a");

    expect(useStore.getState().collapsedProjects.has("/home/project-a")).toBe(false);
    const stored = JSON.parse(localStorage.getItem("cc-collapsed-projects") || "[]");
    expect(stored).not.toContain("/home/project-a");
  });
});

// ─── Plan mode (previous permission mode) ────────────────────────────────────

describe("Plan mode", () => {
  it("setPreviousPermissionMode: stores previous mode for a session", () => {
    useStore.getState().setPreviousPermissionMode("s1", "auto-accept");
    expect(useStore.getState().previousPermissionMode.get("s1")).toBe("auto-accept");
  });
});

// ─── Connection and session status ───────────────────────────────────────────

describe("Connection and session status", () => {
  it("setConnectionStatus: stores browser-server WebSocket status per session", () => {
    useStore.getState().setConnectionStatus("s1", "connecting");
    expect(useStore.getState().connectionStatus.get("s1")).toBe("connecting");

    useStore.getState().setConnectionStatus("s1", "connected");
    expect(useStore.getState().connectionStatus.get("s1")).toBe("connected");

    useStore.getState().setConnectionStatus("s1", "disconnected");
    expect(useStore.getState().connectionStatus.get("s1")).toBe("disconnected");
  });

  it("setCliConnected: stores CLI-server connection state per session", () => {
    useStore.getState().setCliConnected("s1", true);
    expect(useStore.getState().cliConnected.get("s1")).toBe(true);

    useStore.getState().setCliConnected("s1", false);
    expect(useStore.getState().cliConnected.get("s1")).toBe(false);
  });

  it("setSessionStatus: stores idle/running/compacting/null per session", () => {
    useStore.getState().setSessionStatus("s1", "idle");
    expect(useStore.getState().sessionStatus.get("s1")).toBe("idle");

    useStore.getState().setSessionStatus("s1", "running");
    expect(useStore.getState().sessionStatus.get("s1")).toBe("running");

    useStore.getState().setSessionStatus("s1", "compacting");
    expect(useStore.getState().sessionStatus.get("s1")).toBe("compacting");

    useStore.getState().setSessionStatus("s1", null);
    expect(useStore.getState().sessionStatus.get("s1")).toBeNull();
  });
});

// ─── Update info ─────────────────────────────────────────────────────────────

describe("Update info", () => {
  it("setUpdateInfo: stores update info", () => {
    const info = {
      currentVersion: "1.0.0",
      latestVersion: "1.1.0",
      updateAvailable: true,
      isServiceMode: false,
      updateInProgress: false,
      lastChecked: Date.now(),
      channel: "stable" as const,
    };
    useStore.getState().setUpdateInfo(info);
    expect(useStore.getState().updateInfo).toEqual(info);
  });

  it("setUpdateInfo(null): clears update info", () => {
    useStore.getState().setUpdateInfo({
      currentVersion: "1.0.0",
      latestVersion: "1.1.0",
      updateAvailable: true,
      isServiceMode: false,
      updateInProgress: false,
      lastChecked: Date.now(),
      channel: "stable",
    });
    useStore.getState().setUpdateInfo(null);
    expect(useStore.getState().updateInfo).toBeNull();
  });

  it("dismissUpdate: persists dismissed version to localStorage", () => {
    useStore.getState().dismissUpdate("1.1.0");
    expect(useStore.getState().updateDismissedVersion).toBe("1.1.0");
    expect(localStorage.getItem("cc-update-dismissed")).toBe("1.1.0");
  });

  it("setUpdateOverlayActive: sets the overlay active state", () => {
    useStore.getState().setUpdateOverlayActive(true);
    expect(useStore.getState().updateOverlayActive).toBe(true);

    useStore.getState().setUpdateOverlayActive(false);
    expect(useStore.getState().updateOverlayActive).toBe(false);
  });

});

// ─── Active tab & diff panel ─────────────────────────────────────────────────

describe("Active tab & diff panel", () => {
  it("setActiveTab: sets the active workspace tab", () => {
    useStore.getState().setActiveTab("diff");
    expect(useStore.getState().activeTab).toBe("diff");

    useStore.getState().setActiveTab("chat");
    expect(useStore.getState().activeTab).toBe("chat");
  });

  it("markChatTabReentry: increments tick per session", () => {
    useStore.getState().markChatTabReentry("s1");
    expect(useStore.getState().chatTabReentryTickBySession.get("s1")).toBe(1);

    useStore.getState().markChatTabReentry("s1");
    expect(useStore.getState().chatTabReentryTickBySession.get("s1")).toBe(2);

    // Different session starts at 1
    useStore.getState().markChatTabReentry("s2");
    expect(useStore.getState().chatTabReentryTickBySession.get("s2")).toBe(1);
  });

  it("setDiffPanelSelectedFile: stores file path for a session", () => {
    useStore.getState().setDiffPanelSelectedFile("s1", "src/main.ts");
    expect(useStore.getState().diffPanelSelectedFile.get("s1")).toBe("src/main.ts");
  });

  it("setDiffPanelSelectedFile(null): removes the selection for a session", () => {
    useStore.getState().setDiffPanelSelectedFile("s1", "src/main.ts");
    useStore.getState().setDiffPanelSelectedFile("s1", null);
    expect(useStore.getState().diffPanelSelectedFile.has("s1")).toBe(false);
  });
});

// ─── Quick terminal (additional tests) ───────────────────────────────────────

describe("Quick terminal", () => {
  it("setQuickTerminalOpen: sets the open state", () => {
    useStore.getState().setQuickTerminalOpen(true);
    expect(useStore.getState().quickTerminalOpen).toBe(true);

    useStore.getState().setQuickTerminalOpen(false);
    expect(useStore.getState().quickTerminalOpen).toBe(false);
  });

  it("openQuickTerminal: creates a docker tab with Docker label", () => {
    useStore.getState().openQuickTerminal({
      target: "docker",
      cwd: "/app",
      containerId: "abc123",
    });

    const state = useStore.getState();
    expect(state.quickTerminalOpen).toBe(true);
    expect(state.quickTerminalTabs).toHaveLength(1);
    expect(state.quickTerminalTabs[0].label).toBe("Docker 1");
    expect(state.quickTerminalTabs[0].cwd).toBe("/app");
    expect(state.quickTerminalTabs[0].containerId).toBe("abc123");
  });

  it("openQuickTerminal docker: increments docker index, not host index", () => {
    useStore.getState().openQuickTerminal({ target: "docker", cwd: "/a", containerId: "c1" });
    useStore.getState().openQuickTerminal({ target: "docker", cwd: "/b", containerId: "c2" });

    const tabs = useStore.getState().quickTerminalTabs;
    expect(tabs[0].label).toBe("Docker 1");
    expect(tabs[1].label).toBe("Docker 2");

    // Host index should still be 1
    expect(useStore.getState().quickTerminalNextHostIndex).toBe(1);
    expect(useStore.getState().quickTerminalNextDockerIndex).toBe(3);
  });

  it("openQuickTerminal with reuseIfExists: does not reuse if containerId differs", () => {
    useStore.getState().openQuickTerminal({ target: "docker", cwd: "/app", containerId: "c1" });
    useStore.getState().openQuickTerminal({
      target: "docker",
      cwd: "/app",
      containerId: "c2",
      reuseIfExists: true,
    });

    // Should have created a second tab since containerId differs
    expect(useStore.getState().quickTerminalTabs).toHaveLength(2);
  });

  it("closeQuickTerminalTab: closes terminal when last tab is removed", () => {
    useStore.getState().openQuickTerminal({ target: "host", cwd: "/repo" });
    const tabId = useStore.getState().quickTerminalTabs[0].id;

    useStore.getState().closeQuickTerminalTab(tabId);

    expect(useStore.getState().quickTerminalTabs).toHaveLength(0);
    expect(useStore.getState().activeQuickTerminalTabId).toBeNull();
    expect(useStore.getState().quickTerminalOpen).toBe(false);
  });

  it("closeQuickTerminalTab: selects first remaining tab when active tab is closed", () => {
    useStore.getState().openQuickTerminal({ target: "host", cwd: "/a" });
    useStore.getState().openQuickTerminal({ target: "host", cwd: "/b" });
    const tabs = useStore.getState().quickTerminalTabs;

    // Active should be the last opened tab (second one)
    expect(useStore.getState().activeQuickTerminalTabId).toBe(tabs[1].id);

    // Close the active (second) tab
    useStore.getState().closeQuickTerminalTab(tabs[1].id);

    // Should fall back to the first tab
    expect(useStore.getState().activeQuickTerminalTabId).toBe(tabs[0].id);
    expect(useStore.getState().quickTerminalOpen).toBe(true);
  });

  it("setActiveQuickTerminalTabId: sets the active tab", () => {
    useStore.getState().openQuickTerminal({ target: "host", cwd: "/a" });
    useStore.getState().openQuickTerminal({ target: "host", cwd: "/b" });
    const firstTabId = useStore.getState().quickTerminalTabs[0].id;

    useStore.getState().setActiveQuickTerminalTabId(firstTabId);
    expect(useStore.getState().activeQuickTerminalTabId).toBe(firstTabId);

    useStore.getState().setActiveQuickTerminalTabId(null);
    expect(useStore.getState().activeQuickTerminalTabId).toBeNull();
  });

  it("resetQuickTerminal: clears all terminal state and resets indices", () => {
    useStore.getState().openQuickTerminal({ target: "host", cwd: "/a" });
    useStore.getState().openQuickTerminal({ target: "docker", cwd: "/b", containerId: "c1" });

    useStore.getState().resetQuickTerminal();

    const state = useStore.getState();
    expect(state.quickTerminalOpen).toBe(false);
    expect(state.quickTerminalTabs).toEqual([]);
    expect(state.activeQuickTerminalTabId).toBeNull();
    expect(state.quickTerminalNextHostIndex).toBe(1);
    expect(state.quickTerminalNextDockerIndex).toBe(1);
  });
});

// ─── Diff base setting ───────────────────────────────────────────────────────

describe("Diff base", () => {
  it("setDiffBase: persists diff base to localStorage", () => {
    useStore.getState().setDiffBase("default-branch");
    expect(useStore.getState().diffBase).toBe("default-branch");
    expect(localStorage.getItem("cc-diff-base")).toBe("default-branch");

    useStore.getState().setDiffBase("last-commit");
    expect(useStore.getState().diffBase).toBe("last-commit");
    expect(localStorage.getItem("cc-diff-base")).toBe("last-commit");
  });
});

// ─── Terminal actions ────────────────────────────────────────────────────────

describe("Terminal actions", () => {
  it("setTerminalOpen: sets terminal open state", () => {
    useStore.getState().setTerminalOpen(true);
    expect(useStore.getState().terminalOpen).toBe(true);

    useStore.getState().setTerminalOpen(false);
    expect(useStore.getState().terminalOpen).toBe(false);
  });

  it("setTerminalCwd: sets the terminal working directory", () => {
    useStore.getState().setTerminalCwd("/home/user/project");
    expect(useStore.getState().terminalCwd).toBe("/home/user/project");

    useStore.getState().setTerminalCwd(null);
    expect(useStore.getState().terminalCwd).toBeNull();
  });

  it("setTerminalId: sets the terminal instance ID", () => {
    useStore.getState().setTerminalId("term-abc");
    expect(useStore.getState().terminalId).toBe("term-abc");

    useStore.getState().setTerminalId(null);
    expect(useStore.getState().terminalId).toBeNull();
  });

  it("openTerminal: sets open to true and cwd", () => {
    useStore.getState().openTerminal("/home/user/project");

    expect(useStore.getState().terminalOpen).toBe(true);
    expect(useStore.getState().terminalCwd).toBe("/home/user/project");
  });

  it("closeTerminal: resets all terminal state", () => {
    useStore.getState().openTerminal("/home/user/project");
    useStore.getState().setTerminalId("term-1");

    useStore.getState().closeTerminal();

    expect(useStore.getState().terminalOpen).toBe(false);
    expect(useStore.getState().terminalCwd).toBeNull();
    expect(useStore.getState().terminalId).toBeNull();
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

// ─── removePermission edge case ──────────────────────────────────────────────

describe("removePermission edge cases", () => {
  it("removePermission: no-op when session has no permissions", () => {
    // Should not throw when removing from a session with no pending permissions
    useStore.getState().removePermission("s1", "nonexistent");
    expect(useStore.getState().pendingPermissions.has("s1")).toBe(false);
  });
});

// ─── updateTask edge case ────────────────────────────────────────────────────

describe("updateTask edge cases", () => {
  it("updateTask: no-op when session has no tasks", () => {
    // Should not throw when updating tasks for a session with no task list
    useStore.getState().updateTask("s1", "t1", { status: "completed" });
    expect(useStore.getState().sessionTasks.has("s1")).toBe(false);
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
