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
import type { SessionState, TaskItem, ProcessItem } from "../types.js";

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

// ─── Tool activity ──────────────────────────────────────────────────────────

describe("Tool activity", () => {
  it("addToolActivity: upserts duplicate toolUseId entries instead of appending", () => {
    useStore.getState().addToolActivity("s1", {
      toolUseId: "tool-1",
      toolName: "Bash",
      preview: "ls",
      startedAt: 1000,
      elapsedSeconds: 1,
      isError: false,
    });

    useStore.getState().addToolActivity("s1", {
      toolUseId: "tool-1",
      toolName: "Bash",
      preview: "ls -la",
      startedAt: 2000,
      elapsedSeconds: 3,
      completedAt: 4000,
      isError: true,
    });

    const entries = useStore.getState().toolActivity.get("s1")!;
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      toolUseId: "tool-1",
      preview: "ls -la",
      startedAt: 1000,
      elapsedSeconds: 3,
      completedAt: 4000,
      isError: true,
    });
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

// ─── updateTask edge case ────────────────────────────────────────────────────

describe("updateTask edge cases", () => {
  it("updateTask: no-op when session has no tasks", () => {
    // Should not throw when updating tasks for a session with no task list
    useStore.getState().updateTask("s1", "t1", { status: "completed" });
    expect(useStore.getState().sessionTasks.has("s1")).toBe(false);
  });
});
