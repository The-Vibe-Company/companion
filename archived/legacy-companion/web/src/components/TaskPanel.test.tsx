// @vitest-environment jsdom
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import { getDefaultConfig, type TaskPanelConfig } from "./task-panel-sections.js";

vi.mock("../api.js", () => ({
  api: {
    getSessionUsageLimits: vi.fn().mockRejectedValue(new Error("skip")),
    getPRStatus: vi.fn().mockRejectedValue(new Error("skip")),
    getLinkedLinearIssue: vi.fn().mockResolvedValue({ issue: null }),
    gitPull: vi.fn().mockResolvedValue({ success: true, git_ahead: 0, git_behind: 0, output: "" }),
    searchLinearIssues: vi.fn().mockResolvedValue({ issues: [] }),
    addLinearComment: vi.fn().mockResolvedValue({ comment: { id: "c1", body: "test", createdAt: new Date().toISOString(), userName: "User" } }),
    unlinkLinearIssue: vi.fn().mockResolvedValue({}),
    linkLinearIssue: vi.fn().mockResolvedValue({}),
    archiveSession: vi.fn().mockResolvedValue({}),
  },
}));

vi.mock("./McpPanel.js", () => ({
  McpSection: () => <div data-testid="mcp-section">MCP Section</div>,
}));

vi.mock("./ClaudeConfigBrowser.js", () => ({
  ClaudeConfigBrowser: () => <div data-testid="claude-config-browser">Config</div>,
}));

vi.mock("./LinearLogo.js", () => ({
  LinearLogo: ({ className }: { className?: string }) => (
    <span data-testid="linear-logo" className={className}>L</span>
  ),
}));

vi.mock("../analytics.js", () => ({
  captureException: vi.fn(),
}));

interface CodexTokenDetails {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  reasoningOutputTokens: number;
  modelContextWindow: number;
}

interface CodexRateLimits {
  primary: { usedPercent: number; windowDurationMins: number; resetsAt: number } | null;
  secondary: { usedPercent: number; windowDurationMins: number; resetsAt: number } | null;
}

interface TaskItemMock {
  id: string;
  status: string;
  subject: string;
  activeForm?: string;
  blockedBy?: string[];
}

interface MockStoreState {
  sessionTasks: Map<string, TaskItemMock[]>;
  sessions: Map<string, {
    backend_type?: string;
    cwd?: string;
    git_branch?: string;
    git_ahead?: number;
    git_behind?: number;
    total_lines_added?: number;
    total_lines_removed?: number;
    repo_root?: string;
    is_containerized?: boolean;
    codex_token_details?: CodexTokenDetails;
    codex_rate_limits?: CodexRateLimits;
    context_used_percent?: number;
  }>;
  sdkSessions: { sessionId: string; backendType?: string; cwd?: string; gitBranch?: string }[];
  taskPanelOpen: boolean;
  setTaskPanelOpen: ReturnType<typeof vi.fn>;
  taskPanelConfig: TaskPanelConfig;
  taskPanelConfigMode: boolean;
  setTaskPanelConfigMode: ReturnType<typeof vi.fn>;
  toggleSectionEnabled: ReturnType<typeof vi.fn>;
  moveSectionUp: ReturnType<typeof vi.fn>;
  moveSectionDown: ReturnType<typeof vi.fn>;
  resetTaskPanelConfig: ReturnType<typeof vi.fn>;
  prStatus: Map<string, { available: boolean; pr?: unknown } | null>;
  linkedLinearIssues: Map<string, unknown>;
  setPRStatus: ReturnType<typeof vi.fn>;
  updateSession: ReturnType<typeof vi.fn>;
  newSession: ReturnType<typeof vi.fn>;
  setLinkedLinearIssue: ReturnType<typeof vi.fn>;
}

let mockState: MockStoreState;

function resetStore(overrides: Partial<MockStoreState> = {}) {
  mockState = {
    sessionTasks: new Map(),
    sessions: new Map([["s1", { backend_type: "codex" }]]),
    sdkSessions: [],
    taskPanelOpen: true,
    setTaskPanelOpen: vi.fn(),
    taskPanelConfig: getDefaultConfig(),
    taskPanelConfigMode: false,
    setTaskPanelConfigMode: vi.fn(),
    toggleSectionEnabled: vi.fn(),
    moveSectionUp: vi.fn(),
    moveSectionDown: vi.fn(),
    resetTaskPanelConfig: vi.fn(),
    prStatus: new Map(),
    linkedLinearIssues: new Map(),
    setPRStatus: vi.fn(),
    updateSession: vi.fn(),
    newSession: vi.fn(),
    setLinkedLinearIssue: vi.fn(),
    ...overrides,
  };
}

vi.mock("../store.js", () => ({
  useStore: Object.assign(
    (selector: (s: MockStoreState) => unknown) => selector(mockState),
    { getState: () => mockState },
  ),
}));

import { TaskPanel, GitHubPRDisplay, CodexRateLimitsSection, CodexTokenDetailsSection } from "./TaskPanel.js";
import { api } from "../api.js";
import type { GitHubPRInfo } from "../api.js";

// Typed reference to the mocked api for per-test overrides
const mockApi = vi.mocked(api);

beforeEach(() => {
  vi.clearAllMocks();
  resetStore();
  // Clear PanelSection collapse state persisted in localStorage
  localStorage.removeItem("cc-panel-collapsed");
});

describe("TaskPanel", () => {
  it("renders nothing when closed", () => {
    resetStore({ taskPanelOpen: false });
    const { container } = render(<TaskPanel sessionId="s1" />);
    expect(container.firstChild).toBeNull();
  });

  it("keeps a single scroll container for long MCP content even without tasks", () => {
    // Regression coverage: Codex sessions do not render the Tasks list,
    // so the panel itself must still provide vertical scrolling.
    const { container } = render(<TaskPanel sessionId="s1" />);

    expect(screen.getByTestId("mcp-section")).toBeInTheDocument();
    expect(screen.getByTestId("task-panel-content")).toHaveClass("overflow-y-auto");
    expect(container.querySelectorAll(".overflow-y-auto")).toHaveLength(1);
  });

  it("shows 'Customize panel' button in normal mode", () => {
    // Verify the settings button appears at the bottom of the panel
    render(<TaskPanel sessionId="s1" />);
    expect(screen.getByTestId("customize-panel-btn")).toBeInTheDocument();
    expect(screen.getByText("Customize panel")).toBeInTheDocument();
  });

  it("shows 'Panel Settings' header when in config mode", () => {
    // Config mode should replace the normal panel content with the config view
    resetStore({ taskPanelConfigMode: true });
    render(<TaskPanel sessionId="s1" />);
    expect(screen.getByText("Panel Settings")).toBeInTheDocument();
    expect(screen.queryByTestId("task-panel-content")).not.toBeInTheDocument();
  });

  it("does not show tasks section for Codex sessions (backend filter)", () => {
    // The "tasks" section is claude-only — it should not appear for Codex
    resetStore({
      sessions: new Map([["s1", { backend_type: "codex" }]]),
      taskPanelConfigMode: true,
    });
    render(<TaskPanel sessionId="s1" />);
    // Tasks section config row should not exist for Codex
    expect(screen.queryByTestId("config-section-tasks")).not.toBeInTheDocument();
    // Other sections should still be present
    expect(screen.getByTestId("config-section-usage-limits")).toBeInTheDocument();
  });

  it("shows tasks section config for Claude sessions", () => {
    // "tasks" section should appear in config for Claude Code backend
    resetStore({
      sessions: new Map([["s1", { backend_type: "claude" }]]),
      taskPanelConfigMode: true,
    });
    render(<TaskPanel sessionId="s1" />);
    expect(screen.getByTestId("config-section-tasks")).toBeInTheDocument();
  });

  it("hides disabled sections from the main panel content", () => {
    // When a section is disabled in config, it should not render in normal mode
    const config = getDefaultConfig();
    config.enabled["mcp-servers"] = false;
    resetStore({ taskPanelConfig: config });
    render(<TaskPanel sessionId="s1" />);
    // MCP section should be hidden since it's disabled
    expect(screen.queryByTestId("mcp-section")).not.toBeInTheDocument();
  });

  it("renders config view with Done and Reset buttons", () => {
    // Verify config mode footer buttons
    resetStore({ taskPanelConfigMode: true });
    render(<TaskPanel sessionId="s1" />);
    expect(screen.getByTestId("config-done")).toBeInTheDocument();
    expect(screen.getByTestId("reset-panel-config")).toBeInTheDocument();
  });

  it("renders toggle switches for all applicable sections in config mode", () => {
    // Codex should see 5 sections (all except "tasks" which is claude-only)
    resetStore({ taskPanelConfigMode: true });
    render(<TaskPanel sessionId="s1" />);
    expect(screen.getByTestId("toggle-usage-limits")).toBeInTheDocument();
    expect(screen.getByTestId("toggle-git-branch")).toBeInTheDocument();
    expect(screen.getByTestId("toggle-github-pr")).toBeInTheDocument();
    expect(screen.getByTestId("toggle-linear-issue")).toBeInTheDocument();
    expect(screen.getByTestId("toggle-mcp-servers")).toBeInTheDocument();
  });

  it("calls toggleSectionEnabled when toggle is clicked", () => {
    // Clicking a toggle should call the store action
    resetStore({ taskPanelConfigMode: true });
    render(<TaskPanel sessionId="s1" />);
    fireEvent.click(screen.getByTestId("toggle-git-branch"));
    expect(mockState.toggleSectionEnabled).toHaveBeenCalledWith("git-branch");
  });

  it("calls moveSectionUp when up arrow is clicked", () => {
    // Clicking the up arrow should call the store action
    resetStore({ taskPanelConfigMode: true });
    render(<TaskPanel sessionId="s1" />);
    fireEvent.click(screen.getByTestId("move-up-git-branch"));
    expect(mockState.moveSectionUp).toHaveBeenCalledWith("git-branch");
  });

  it("calls moveSectionDown when down arrow is clicked", () => {
    // Clicking the down arrow should call the store action
    resetStore({ taskPanelConfigMode: true });
    render(<TaskPanel sessionId="s1" />);
    fireEvent.click(screen.getByTestId("move-down-git-branch"));
    expect(mockState.moveSectionDown).toHaveBeenCalledWith("git-branch");
  });

  it("renders sections in the configured order", () => {
    // When config order is changed, sections should render in that order
    const config = getDefaultConfig();
    config.order = ["mcp-servers", "usage-limits", "git-branch", "github-pr", "linear-issue", "tasks"];
    resetStore({ taskPanelConfig: config, taskPanelConfigMode: true });
    render(<TaskPanel sessionId="s1" />);

    // Verify the first config row is MCP servers (since we reordered)
    const rows = screen.getAllByTestId(/^config-section-/);
    expect(rows[0]).toHaveAttribute("data-testid", "config-section-mcp-servers");
    expect(rows[1]).toHaveAttribute("data-testid", "config-section-usage-limits");
  });
});

describe("CodexRateLimitsSection", () => {
  it("renders nothing when no rate limits data", () => {
    // Session exists but has no codex_rate_limits
    resetStore({ sessions: new Map([["s1", { backend_type: "codex" }]]) });
    const { container } = render(<CodexRateLimitsSection sessionId="s1" />);
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing when both primary and secondary are null", () => {
    resetStore({
      sessions: new Map([["s1", {
        backend_type: "codex",
        codex_rate_limits: { primary: null, secondary: null },
      }]]),
    });
    const { container } = render(<CodexRateLimitsSection sessionId="s1" />);
    expect(container.firstChild).toBeNull();
  });

  it("renders primary rate limit bar with percentage and window label", () => {
    resetStore({
      sessions: new Map([["s1", {
        backend_type: "codex",
        codex_rate_limits: {
          primary: { usedPercent: 62, windowDurationMins: 300, resetsAt: Date.now() + 7_200_000 },
          secondary: null,
        },
      }]]),
    });
    render(<CodexRateLimitsSection sessionId="s1" />);
    // 300 mins = 5h
    expect(screen.getByText("5h Limit")).toBeInTheDocument();
    expect(screen.getByText("62%")).toBeInTheDocument();
  });

  it("renders both primary and secondary limits", () => {
    resetStore({
      sessions: new Map([["s1", {
        backend_type: "codex",
        codex_rate_limits: {
          primary: { usedPercent: 30, windowDurationMins: 300, resetsAt: Date.now() + 3_600_000 },
          secondary: { usedPercent: 10, windowDurationMins: 10080, resetsAt: Date.now() + 86_400_000 },
        },
      }]]),
    });
    render(<CodexRateLimitsSection sessionId="s1" />);
    // 300 mins = 5h, 10080 mins = 7d
    expect(screen.getByText("5h Limit")).toBeInTheDocument();
    expect(screen.getByText("7d Limit")).toBeInTheDocument();
    expect(screen.getByText("30%")).toBeInTheDocument();
    expect(screen.getByText("10%")).toBeInTheDocument();
  });
});

describe("CodexTokenDetailsSection", () => {
  it("renders nothing when no token details", () => {
    resetStore({ sessions: new Map([["s1", { backend_type: "codex" }]]) });
    const { container } = render(<CodexTokenDetailsSection sessionId="s1" />);
    expect(container.firstChild).toBeNull();
  });

  it("renders input and output token counts", () => {
    resetStore({
      sessions: new Map([["s1", {
        backend_type: "codex",
        context_used_percent: 42,
        codex_token_details: {
          inputTokens: 84_230,
          outputTokens: 12_450,
          cachedInputTokens: 0,
          reasoningOutputTokens: 0,
          modelContextWindow: 200_000,
        },
      }]]),
    });
    render(<CodexTokenDetailsSection sessionId="s1" />);
    expect(screen.getByText("Tokens")).toBeInTheDocument();
    expect(screen.getByText("84.2k")).toBeInTheDocument();
    expect(screen.getByText("12.4k")).toBeInTheDocument();
  });

  it("shows cached and reasoning rows only when non-zero", () => {
    resetStore({
      sessions: new Map([["s1", {
        backend_type: "codex",
        context_used_percent: 55,
        codex_token_details: {
          inputTokens: 100_000,
          outputTokens: 5_000,
          cachedInputTokens: 41_200,
          reasoningOutputTokens: 8_900,
          modelContextWindow: 200_000,
        },
      }]]),
    });
    render(<CodexTokenDetailsSection sessionId="s1" />);
    // Cached and reasoning should be visible
    expect(screen.getByText("Cached")).toBeInTheDocument();
    expect(screen.getByText("41.2k")).toBeInTheDocument();
    expect(screen.getByText("Reasoning")).toBeInTheDocument();
    expect(screen.getByText("8.9k")).toBeInTheDocument();
  });

  it("hides cached and reasoning rows when zero", () => {
    resetStore({
      sessions: new Map([["s1", {
        backend_type: "codex",
        context_used_percent: 20,
        codex_token_details: {
          inputTokens: 10_000,
          outputTokens: 1_000,
          cachedInputTokens: 0,
          reasoningOutputTokens: 0,
          modelContextWindow: 200_000,
        },
      }]]),
    });
    render(<CodexTokenDetailsSection sessionId="s1" />);
    expect(screen.queryByText("Cached")).not.toBeInTheDocument();
    expect(screen.queryByText("Reasoning")).not.toBeInTheDocument();
  });

  it("uses server-computed context_used_percent, not local calculation", () => {
    // Scenario: inputTokens=289500, outputTokens=2100, contextWindow=258400
    // Naive local calc would give 112%, but server caps at 100
    // This verifies the UI uses the session's context_used_percent (capped at 100)
    resetStore({
      sessions: new Map([["s1", {
        backend_type: "codex",
        context_used_percent: 100,
        codex_token_details: {
          inputTokens: 289_500,
          outputTokens: 2_100,
          cachedInputTokens: 210_300,
          reasoningOutputTokens: 741,
          modelContextWindow: 258_400,
        },
      }]]),
    });
    render(<CodexTokenDetailsSection sessionId="s1" />);
    // Should show 100%, not 112%
    expect(screen.getByText("100%")).toBeInTheDocument();
    expect(screen.queryByText("112%")).not.toBeInTheDocument();
  });

  it("hides context bar when modelContextWindow is 0", () => {
    resetStore({
      sessions: new Map([["s1", {
        backend_type: "codex",
        context_used_percent: 0,
        codex_token_details: {
          inputTokens: 1_000,
          outputTokens: 500,
          cachedInputTokens: 0,
          reasoningOutputTokens: 0,
          modelContextWindow: 0,
        },
      }]]),
    });
    render(<CodexTokenDetailsSection sessionId="s1" />);
    expect(screen.queryByText("Context")).not.toBeInTheDocument();
  });
});

describe("TaskPanel — close button behavior", () => {
  it("calls setTaskPanelOpen(false) when close button is clicked in normal mode", () => {
    // In normal mode, clicking the close button should close the panel entirely
    resetStore();
    render(<TaskPanel sessionId="s1" />);
    fireEvent.click(screen.getByLabelText("Close panel"));
    expect(mockState.setTaskPanelOpen).toHaveBeenCalledWith(false);
  });

  it("exits config mode when close button is clicked in config mode", () => {
    // In config mode, clicking the close button should go back to normal mode
    // (not close the panel)
    resetStore({ taskPanelConfigMode: true });
    render(<TaskPanel sessionId="s1" />);
    fireEvent.click(screen.getByLabelText("Close panel"));
    expect(mockState.setTaskPanelConfigMode).toHaveBeenCalledWith(false);
    expect(mockState.setTaskPanelOpen).not.toHaveBeenCalled();
  });

  it("shows 'Context' header in normal mode", () => {
    // The panel header should say "Context" in normal mode
    resetStore();
    render(<TaskPanel sessionId="s1" />);
    expect(screen.getByText("Context")).toBeInTheDocument();
  });
});

describe("TaskPanel — config mode interactions", () => {
  it("calls resetTaskPanelConfig when Reset to defaults is clicked", () => {
    // Clicking "Reset to defaults" should invoke the store action
    resetStore({ taskPanelConfigMode: true });
    render(<TaskPanel sessionId="s1" />);
    fireEvent.click(screen.getByTestId("reset-panel-config"));
    expect(mockState.resetTaskPanelConfig).toHaveBeenCalled();
  });

  it("calls setConfigMode(false) when Done is clicked", () => {
    // Clicking "Done" should exit config mode
    resetStore({ taskPanelConfigMode: true });
    render(<TaskPanel sessionId="s1" />);
    fireEvent.click(screen.getByTestId("config-done"));
    expect(mockState.setTaskPanelConfigMode).toHaveBeenCalledWith(false);
  });

  it("shows disabled sections with reduced opacity styling", () => {
    // Sections toggled off should render with opacity-60 class in config mode
    const config = getDefaultConfig();
    config.enabled["git-branch"] = false;
    resetStore({ taskPanelConfig: config, taskPanelConfigMode: true });
    render(<TaskPanel sessionId="s1" />);
    const section = screen.getByTestId("config-section-git-branch");
    expect(section.className).toContain("opacity-60");
  });

  it("shows enabled sections without reduced opacity", () => {
    // Enabled sections should not have opacity-60
    resetStore({ taskPanelConfigMode: true });
    render(<TaskPanel sessionId="s1" />);
    const section = screen.getByTestId("config-section-git-branch");
    expect(section.className).not.toContain("opacity-60");
  });

  it("disables the up arrow on the first section and down arrow on the last", () => {
    // The first section's up button and last section's down button should be disabled
    resetStore({ taskPanelConfigMode: true });
    render(<TaskPanel sessionId="s1" />);
    // For Codex, "usage-limits" is first, "mcp-servers" is last (tasks is claude-only)
    const upFirst = screen.getByTestId("move-up-usage-limits");
    expect(upFirst).toBeDisabled();
    const downLast = screen.getByTestId("move-down-mcp-servers");
    expect(downLast).toBeDisabled();
  });
});

describe("TasksSection (Claude Code sessions)", () => {
  it("renders 'No tasks yet' when there are no tasks for a Claude session", () => {
    // Claude sessions should show the tasks section with empty state
    resetStore({
      sessions: new Map([["s1", { backend_type: "claude" }]]),
      sessionTasks: new Map(),
    });
    render(<TaskPanel sessionId="s1" />);
    expect(screen.getByText("Tasks")).toBeInTheDocument();
    expect(screen.getByText("Tasks will appear here as the agent works")).toBeInTheDocument();
  });

  it("renders task list with correct completed count", () => {
    // With tasks present, the header should show completed/total count
    resetStore({
      sessions: new Map([["s1", { backend_type: "claude" }]]),
      sessionTasks: new Map([
        ["s1", [
          { id: "t1", status: "completed", subject: "Setup project" },
          { id: "t2", status: "in_progress", subject: "Write tests" },
          { id: "t3", status: "pending", subject: "Deploy app" },
        ]],
      ]),
    });
    render(<TaskPanel sessionId="s1" />);
    expect(screen.getByText("Tasks")).toBeInTheDocument();
    // 1 out of 3 completed
    expect(screen.getByText("1/3")).toBeInTheDocument();
  });

  it("renders individual task rows with correct text", () => {
    // Each task's subject text should appear in the rendered output
    resetStore({
      sessions: new Map([["s1", { backend_type: "claude" }]]),
      sessionTasks: new Map([
        ["s1", [
          { id: "t1", status: "pending", subject: "First task" },
          { id: "t2", status: "completed", subject: "Second task" },
        ]],
      ]),
    });
    render(<TaskPanel sessionId="s1" />);
    expect(screen.getByText("First task")).toBeInTheDocument();
    expect(screen.getByText("Second task")).toBeInTheDocument();
  });

  it("shows activeForm text for in_progress tasks", () => {
    // When a task is in_progress and has an activeForm, it should be displayed
    resetStore({
      sessions: new Map([["s1", { backend_type: "claude" }]]),
      sessionTasks: new Map([
        ["s1", [
          { id: "t1", status: "in_progress", subject: "Running tests", activeForm: "Executing test suite" },
        ]],
      ]),
    });
    render(<TaskPanel sessionId="s1" />);
    expect(screen.getByText("Running tests")).toBeInTheDocument();
    expect(screen.getByText("Executing test suite")).toBeInTheDocument();
  });

  it("shows blockedBy info for blocked tasks", () => {
    // Tasks with blockedBy should show the blocking task references
    resetStore({
      sessions: new Map([["s1", { backend_type: "claude" }]]),
      sessionTasks: new Map([
        ["s1", [
          { id: "t1", status: "pending", subject: "Blocked task", blockedBy: ["t2", "t3"] },
        ]],
      ]),
    });
    render(<TaskPanel sessionId="s1" />);
    expect(screen.getByText("blocked by #t2, #t3")).toBeInTheDocument();
  });

  it("applies line-through and opacity for completed tasks", () => {
    // Completed tasks should have line-through text styling and reduced opacity
    resetStore({
      sessions: new Map([["s1", { backend_type: "claude" }]]),
      sessionTasks: new Map([
        ["s1", [
          { id: "t1", status: "completed", subject: "Done task" },
        ]],
      ]),
    });
    render(<TaskPanel sessionId="s1" />);
    const taskText = screen.getByText("Done task");
    expect(taskText.className).toContain("line-through");
  });

  it("does not render TasksSection for Codex sessions", () => {
    // Codex backend sessions should not show the Tasks section at all
    resetStore({
      sessions: new Map([["s1", { backend_type: "codex" }]]),
      sessionTasks: new Map([
        ["s1", [{ id: "t1", status: "pending", subject: "Some task" }]],
      ]),
    });
    render(<TaskPanel sessionId="s1" />);
    expect(screen.queryByText("Tasks")).not.toBeInTheDocument();
    expect(screen.queryByText("Some task")).not.toBeInTheDocument();
  });
});

describe("GitBranchSection", () => {
  it("renders branch name when session has git_branch", () => {
    // A Claude session with a git branch should show the branch section
    resetStore({
      sessions: new Map([["s1", { backend_type: "claude", git_branch: "feat/my-feature" }]]),
    });
    render(<TaskPanel sessionId="s1" />);
    expect(screen.getByText("Git Branch")).toBeInTheDocument();
    expect(screen.getByText("feat/my-feature")).toBeInTheDocument();
  });

  it("renders nothing inside branch section when no branch info is available", () => {
    // No git_branch means the section content should be empty (header still renders)
    resetStore({
      sessions: new Map([["s1", { backend_type: "claude" }]]),
    });
    render(<TaskPanel sessionId="s1" />);
    // The PanelSection header "Git Branch" renders, but no branch name appears
    expect(screen.getByText("Git Branch")).toBeInTheDocument();
    expect(screen.queryByText("feat/my-feature")).not.toBeInTheDocument();
  });

  it("shows ahead and behind counts", () => {
    // When there are commits ahead/behind, they should be displayed
    resetStore({
      sessions: new Map([["s1", {
        backend_type: "claude",
        git_branch: "main",
        git_ahead: 3,
        git_behind: 2,
      }]]),
    });
    render(<TaskPanel sessionId="s1" />);
    // The up arrow character is &#8593; and down is &#8595;
    expect(screen.getByText(/3/)).toBeInTheDocument();
    expect(screen.getByText(/2/)).toBeInTheDocument();
  });

  it("shows line additions and removals", () => {
    // Line change statistics should be rendered when present
    resetStore({
      sessions: new Map([["s1", {
        backend_type: "claude",
        git_branch: "main",
        total_lines_added: 150,
        total_lines_removed: 30,
      }]]),
    });
    render(<TaskPanel sessionId="s1" />);
    expect(screen.getByText("+150")).toBeInTheDocument();
    expect(screen.getByText("-30")).toBeInTheDocument();
  });

  it("shows container badge when session is containerized", () => {
    // Containerized sessions should display a "container" badge
    resetStore({
      sessions: new Map([["s1", {
        backend_type: "claude",
        git_branch: "main",
        is_containerized: true,
      }]]),
    });
    render(<TaskPanel sessionId="s1" />);
    expect(screen.getByText("container")).toBeInTheDocument();
  });

  it("shows Pull button when behind and cwd is available", () => {
    // When behind on commits and a cwd is known, a Pull button should appear
    resetStore({
      sessions: new Map([["s1", {
        backend_type: "claude",
        git_branch: "main",
        git_behind: 5,
        cwd: "/home/user/project",
      }]]),
    });
    render(<TaskPanel sessionId="s1" />);
    expect(screen.getByText("Pull")).toBeInTheDocument();
  });

  it("does not show Pull button when not behind", () => {
    // If there are no commits behind, Pull should not appear
    resetStore({
      sessions: new Map([["s1", {
        backend_type: "claude",
        git_branch: "main",
        git_behind: 0,
        git_ahead: 1,
        cwd: "/home/user/project",
      }]]),
    });
    render(<TaskPanel sessionId="s1" />);
    expect(screen.queryByText("Pull")).not.toBeInTheDocument();
  });

  it("falls back to sdkSession branch when session has no branch", () => {
    // When the session object lacks git_branch, the SDK session's gitBranch is used
    resetStore({
      sessions: new Map([["s1", { backend_type: "claude" }]]),
      sdkSessions: [{ sessionId: "s1", gitBranch: "sdk-branch" }],
    });
    render(<TaskPanel sessionId="s1" />);
    expect(screen.getByText("sdk-branch")).toBeInTheDocument();
  });
});

describe("GitHubPRDisplay", () => {
  function makePR(overrides: Partial<GitHubPRInfo> = {}): GitHubPRInfo {
    return {
      number: 42,
      title: "Add new feature",
      url: "https://github.com/org/repo/pull/42",
      state: "OPEN",
      isDraft: false,
      reviewDecision: null,
      additions: 100,
      deletions: 20,
      changedFiles: 5,
      checks: [],
      checksSummary: { total: 0, success: 0, failure: 0, pending: 0 },
      reviewThreads: { total: 0, resolved: 0, unresolved: 0 },
      ...overrides,
    };
  }

  it("renders the PR number and title", () => {
    // Basic PR display should show number and title
    render(<GitHubPRDisplay pr={makePR()} />);
    expect(screen.getByText("PR #42")).toBeInTheDocument();
    expect(screen.getByText("Add new feature")).toBeInTheDocument();
  });

  it("shows diff stats with additions, deletions, and file count", () => {
    // The diff stats row should show +additions, -deletions, and changed file count
    render(<GitHubPRDisplay pr={makePR({ additions: 200, deletions: 50, changedFiles: 12 })} />);
    expect(screen.getByText("+200")).toBeInTheDocument();
    expect(screen.getByText("-50")).toBeInTheDocument();
    expect(screen.getByText(/12 files/)).toBeInTheDocument();
  });

  it("renders 'Open' state pill for open PRs", () => {
    render(<GitHubPRDisplay pr={makePR({ state: "OPEN" })} />);
    expect(screen.getByText("Open")).toBeInTheDocument();
  });

  it("renders 'Merged' state pill for merged PRs", () => {
    render(<GitHubPRDisplay pr={makePR({ state: "MERGED" })} />);
    expect(screen.getByText("Merged")).toBeInTheDocument();
  });

  it("renders 'Closed' state pill for closed PRs", () => {
    render(<GitHubPRDisplay pr={makePR({ state: "CLOSED" })} />);
    expect(screen.getByText("Closed")).toBeInTheDocument();
  });

  it("renders 'Draft' state pill for draft PRs regardless of state", () => {
    // Draft overrides the state display
    render(<GitHubPRDisplay pr={makePR({ state: "OPEN", isDraft: true })} />);
    expect(screen.getByText("Draft")).toBeInTheDocument();
    expect(screen.queryByText("Open")).not.toBeInTheDocument();
  });

  it("shows failing CI checks count", () => {
    // When there are failing checks, the failure count should be displayed
    render(<GitHubPRDisplay pr={makePR({
      checksSummary: { total: 5, success: 3, failure: 2, pending: 0 },
    })} />);
    expect(screen.getByText("2 failing")).toBeInTheDocument();
    expect(screen.getByText("3 passed")).toBeInTheDocument();
  });

  it("shows pending CI checks count", () => {
    // When there are pending checks (but no failures), the pending count is shown
    render(<GitHubPRDisplay pr={makePR({
      checksSummary: { total: 4, success: 1, failure: 0, pending: 3 },
    })} />);
    expect(screen.getByText("3 pending")).toBeInTheDocument();
    expect(screen.getByText("1 passed")).toBeInTheDocument();
  });

  it("shows all checks passed when all succeed", () => {
    // When all checks pass, it shows a summary like "5/5 checks passed"
    render(<GitHubPRDisplay pr={makePR({
      checksSummary: { total: 5, success: 5, failure: 0, pending: 0 },
    })} />);
    expect(screen.getByText("5/5 checks passed")).toBeInTheDocument();
  });

  it("does not show CI checks section when total is 0", () => {
    // No checks at all means no CI section displayed.
    // Use a non-OPEN state to avoid "Review pending" text interfering.
    render(<GitHubPRDisplay pr={makePR({
      state: "MERGED",
      checksSummary: { total: 0, success: 0, failure: 0, pending: 0 },
    })} />);
    expect(screen.queryByText(/failing/)).not.toBeInTheDocument();
    expect(screen.queryByText(/\d+ pending/)).not.toBeInTheDocument();
    expect(screen.queryByText(/passed/)).not.toBeInTheDocument();
  });

  it("shows 'Approved' review decision", () => {
    render(<GitHubPRDisplay pr={makePR({ reviewDecision: "APPROVED" })} />);
    expect(screen.getByText("Approved")).toBeInTheDocument();
  });

  it("shows 'Changes requested' review decision", () => {
    render(<GitHubPRDisplay pr={makePR({ reviewDecision: "CHANGES_REQUESTED" })} />);
    expect(screen.getByText("Changes requested")).toBeInTheDocument();
  });

  it("shows 'Review pending' for open PRs with REVIEW_REQUIRED", () => {
    render(<GitHubPRDisplay pr={makePR({
      state: "OPEN",
      reviewDecision: "REVIEW_REQUIRED",
    })} />);
    expect(screen.getByText("Review pending")).toBeInTheDocument();
  });

  it("shows 'Review pending' for open PRs with null review decision", () => {
    // When reviewDecision is null and state is OPEN, review pending is shown
    render(<GitHubPRDisplay pr={makePR({
      state: "OPEN",
      reviewDecision: null,
    })} />);
    expect(screen.getByText("Review pending")).toBeInTheDocument();
  });

  it("does not show 'Review pending' for merged PRs with null review decision", () => {
    // Merged PRs should not show "Review pending"
    render(<GitHubPRDisplay pr={makePR({
      state: "MERGED",
      reviewDecision: null,
    })} />);
    expect(screen.queryByText("Review pending")).not.toBeInTheDocument();
  });

  it("shows unresolved comment count", () => {
    // When there are unresolved review threads, the count should be displayed
    render(<GitHubPRDisplay pr={makePR({
      reviewThreads: { total: 5, resolved: 3, unresolved: 2 },
    })} />);
    expect(screen.getByText("2 unresolved")).toBeInTheDocument();
  });

  it("does not show unresolved count when zero", () => {
    render(<GitHubPRDisplay pr={makePR({
      reviewThreads: { total: 3, resolved: 3, unresolved: 0 },
    })} />);
    expect(screen.queryByText(/unresolved/)).not.toBeInTheDocument();
  });

  it("renders the PR link with correct href", () => {
    // The PR number should be a link to the PR URL
    render(<GitHubPRDisplay pr={makePR()} />);
    const link = screen.getByText("PR #42").closest("a");
    expect(link).toHaveAttribute("href", "https://github.com/org/repo/pull/42");
    expect(link).toHaveAttribute("target", "_blank");
  });
});

describe("TaskPanel — backend detection via sdkSessions", () => {
  it("uses sdkSession backendType when session lacks backend_type", () => {
    // If the session object does not have backend_type, the panel should
    // fall back to the SDK session's backendType for filtering sections
    resetStore({
      sessions: new Map([["s1", {}]]),
      sdkSessions: [{ sessionId: "s1", backendType: "codex" }],
      taskPanelConfigMode: true,
    });
    render(<TaskPanel sessionId="s1" />);
    // Tasks section is claude-only, so it should not appear for Codex
    expect(screen.queryByTestId("config-section-tasks")).not.toBeInTheDocument();
  });

  it("treats unknown backend as claude (shows tasks section)", () => {
    // When no backend_type is specified at all, it defaults to claude behavior
    resetStore({
      sessions: new Map([["s1", {}]]),
      sdkSessions: [],
      taskPanelConfigMode: true,
    });
    render(<TaskPanel sessionId="s1" />);
    // Without a codex backend, tasks section should be visible
    expect(screen.getByTestId("config-section-tasks")).toBeInTheDocument();
  });
});

describe("TaskPanel — barColor visual behavior via progress bars", () => {
  it("applies error color class for usage above 80%", () => {
    // Usage > 80% should render bars with bg-cc-error class
    resetStore({
      sessions: new Map([["s1", {
        backend_type: "codex",
        codex_rate_limits: {
          primary: { usedPercent: 90, windowDurationMins: 300, resetsAt: Date.now() + 3_600_000 },
          secondary: null,
        },
      }]]),
    });
    const { container } = render(<CodexRateLimitsSection sessionId="s1" />);
    // Find the inner progress bar div (the one with width style)
    const bar = container.querySelector("[style]");
    expect(bar?.className).toContain("bg-cc-error");
  });

  it("applies warning color class for usage between 50% and 80%", () => {
    // Usage 51-80% should render bars with bg-cc-warning class
    resetStore({
      sessions: new Map([["s1", {
        backend_type: "codex",
        codex_rate_limits: {
          primary: { usedPercent: 65, windowDurationMins: 300, resetsAt: Date.now() + 3_600_000 },
          secondary: null,
        },
      }]]),
    });
    const { container } = render(<CodexRateLimitsSection sessionId="s1" />);
    const bar = container.querySelector("[style]");
    expect(bar?.className).toContain("bg-cc-warning");
  });

  it("applies primary color class for usage at or below 50%", () => {
    // Usage <= 50% should render bars with bg-cc-primary class
    resetStore({
      sessions: new Map([["s1", {
        backend_type: "codex",
        codex_rate_limits: {
          primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: Date.now() + 3_600_000 },
          secondary: null,
        },
      }]]),
    });
    const { container } = render(<CodexRateLimitsSection sessionId="s1" />);
    const bar = container.querySelector("[style]");
    expect(bar?.className).toContain("bg-cc-primary");
  });
});

describe("UsageLimitsSection (Claude Code sessions)", () => {
  it("renders 5h limit bar and percentage when data is available", async () => {
    // For Claude sessions, UsageLimitsSection fetches from api.getSessionUsageLimits.
    // When five_hour data is present, it should render the 5h limit bar.
    mockApi.getSessionUsageLimits.mockResolvedValueOnce({
      five_hour: { utilization: 45, resets_at: new Date(Date.now() + 3_600_000).toISOString() },
      seven_day: null,
      extra_usage: null,
    });
    resetStore({
      sessions: new Map([["s1", { backend_type: "claude" }]]),
    });
    render(<TaskPanel sessionId="s1" />);
    // Wait for async fetch to resolve and component to re-render
    expect(await screen.findByText("5h Limit")).toBeInTheDocument();
    expect(screen.getByText("45%")).toBeInTheDocument();
  });

  it("renders 7d limit bar when seven_day data is available", async () => {
    // When seven_day data is present, it should render the 7d limit bar
    mockApi.getSessionUsageLimits.mockResolvedValueOnce({
      five_hour: null,
      seven_day: { utilization: 72, resets_at: new Date(Date.now() + 86_400_000).toISOString() },
      extra_usage: null,
    });
    resetStore({
      sessions: new Map([["s1", { backend_type: "claude" }]]),
    });
    render(<TaskPanel sessionId="s1" />);
    expect(await screen.findByText("7d Limit")).toBeInTheDocument();
    expect(screen.getByText("72%")).toBeInTheDocument();
  });

  it("renders both 5h and 7d limits simultaneously", async () => {
    // Both limits can be present at the same time
    mockApi.getSessionUsageLimits.mockResolvedValueOnce({
      five_hour: { utilization: 30, resets_at: null },
      seven_day: { utilization: 60, resets_at: null },
      extra_usage: null,
    });
    resetStore({
      sessions: new Map([["s1", { backend_type: "claude" }]]),
    });
    render(<TaskPanel sessionId="s1" />);
    expect(await screen.findByText("5h Limit")).toBeInTheDocument();
    expect(screen.getByText("7d Limit")).toBeInTheDocument();
    expect(screen.getByText("30%")).toBeInTheDocument();
    expect(screen.getByText("60%")).toBeInTheDocument();
  });

  it("renders extra usage when 5h/7d not available and extra is enabled", async () => {
    // When neither 5h nor 7d is available, but extra_usage is enabled, show extra bar
    mockApi.getSessionUsageLimits.mockResolvedValueOnce({
      five_hour: null,
      seven_day: null,
      extra_usage: {
        is_enabled: true,
        monthly_limit: 100,
        used_credits: 42.5,
        utilization: 42,
      },
    });
    resetStore({
      sessions: new Map([["s1", { backend_type: "claude" }]]),
    });
    render(<TaskPanel sessionId="s1" />);
    expect(await screen.findByText("Extra")).toBeInTheDocument();
    expect(screen.getByText("$42.50 / $100")).toBeInTheDocument();
  });

  it("does not render extra usage when 5h data is also available", async () => {
    // Extra usage is only shown when NEITHER 5h NOR 7d limits exist
    mockApi.getSessionUsageLimits.mockResolvedValueOnce({
      five_hour: { utilization: 20, resets_at: null },
      seven_day: null,
      extra_usage: {
        is_enabled: true,
        monthly_limit: 100,
        used_credits: 50,
        utilization: 50,
      },
    });
    resetStore({
      sessions: new Map([["s1", { backend_type: "claude" }]]),
    });
    render(<TaskPanel sessionId="s1" />);
    expect(await screen.findByText("5h Limit")).toBeInTheDocument();
    // Extra should NOT be shown since 5h is available
    expect(screen.queryByText("Extra")).not.toBeInTheDocument();
  });

  it("renders nothing when API returns all null limits", async () => {
    // When none of the limits have data, the section renders nothing
    mockApi.getSessionUsageLimits.mockResolvedValueOnce({
      five_hour: null,
      seven_day: null,
      extra_usage: null,
    });
    resetStore({
      sessions: new Map([["s1", { backend_type: "claude" }]]),
    });
    render(<TaskPanel sessionId="s1" />);
    // Wait a tick for the fetch to resolve
    await vi.waitFor(() => {
      expect(mockApi.getSessionUsageLimits).toHaveBeenCalled();
    });
    expect(screen.queryByText("5h Limit")).not.toBeInTheDocument();
    expect(screen.queryByText("7d Limit")).not.toBeInTheDocument();
    expect(screen.queryByText("Extra")).not.toBeInTheDocument();
  });

  it("applies warning bar color for 5h usage between 50 and 80", async () => {
    // Usage at 65% should render with bg-cc-warning
    mockApi.getSessionUsageLimits.mockResolvedValueOnce({
      five_hour: { utilization: 65, resets_at: null },
      seven_day: null,
      extra_usage: null,
    });
    resetStore({
      sessions: new Map([["s1", { backend_type: "claude" }]]),
    });
    const { container } = render(<TaskPanel sessionId="s1" />);
    await screen.findByText("5h Limit");
    const bar = container.querySelector("[style*='width: 65%']");
    expect(bar?.className).toContain("bg-cc-warning");
  });

  it("applies error bar color for 5h usage above 80", async () => {
    // Usage at 95% should render with bg-cc-error
    mockApi.getSessionUsageLimits.mockResolvedValueOnce({
      five_hour: { utilization: 95, resets_at: null },
      seven_day: null,
      extra_usage: null,
    });
    resetStore({
      sessions: new Map([["s1", { backend_type: "claude" }]]),
    });
    const { container } = render(<TaskPanel sessionId="s1" />);
    await screen.findByText("5h Limit");
    const bar = container.querySelector("[style*='width: 95%']");
    expect(bar?.className).toContain("bg-cc-error");
  });

  it("caps the bar width at 100% even when utilization exceeds 100", async () => {
    // Utilization can technically exceed 100 but the bar should cap at 100%
    mockApi.getSessionUsageLimits.mockResolvedValueOnce({
      five_hour: { utilization: 120, resets_at: null },
      seven_day: null,
      extra_usage: null,
    });
    resetStore({
      sessions: new Map([["s1", { backend_type: "claude" }]]),
    });
    const { container } = render(<TaskPanel sessionId="s1" />);
    await screen.findByText("5h Limit");
    // Math.min(120, 100) = 100
    const bar = container.querySelector("[style*='width: 100%']");
    expect(bar).toBeTruthy();
  });
});

describe("LinearIssueSection", () => {
  const mockLinearIssue = {
    id: "issue-1",
    identifier: "ENG-123",
    title: "Fix login bug",
    description: "Users cannot log in",
    url: "https://linear.app/team/ENG-123",
    branchName: "fix/login-bug",
    priorityLabel: "High",
    stateName: "In Progress",
    stateType: "started",
    teamName: "Engineering",
    teamKey: "ENG",
    teamId: "team-1",
  };

  it("shows 'Link Linear issue' button when no issue is linked", () => {
    // When there's no linked issue, a "Link Linear issue" button should appear
    resetStore({
      sessions: new Map([["s1", { backend_type: "claude" }]]),
      linkedLinearIssues: new Map(),
    });
    render(<TaskPanel sessionId="s1" />);
    expect(screen.getByText("Link Linear issue")).toBeInTheDocument();
  });

  it("shows search input when Link button is clicked", () => {
    // Clicking the "Link Linear issue" button should reveal a search input
    resetStore({
      sessions: new Map([["s1", { backend_type: "claude" }]]),
      linkedLinearIssues: new Map(),
    });
    render(<TaskPanel sessionId="s1" />);
    fireEvent.click(screen.getByText("Link Linear issue"));
    expect(screen.getByLabelText("Search Linear issues")).toBeInTheDocument();
  });

  it("renders linked issue identifier and state pill", async () => {
    // When an issue is linked, show its identifier and state
    mockApi.getLinkedLinearIssue.mockResolvedValue({
      issue: mockLinearIssue,
      comments: [],
      assignee: null,
      labels: [],
    });
    resetStore({
      sessions: new Map([["s1", { backend_type: "claude" }]]),
      linkedLinearIssues: new Map([["s1", mockLinearIssue]]),
    });
    render(<TaskPanel sessionId="s1" />);
    expect(screen.getByText("ENG-123")).toBeInTheDocument();
    expect(screen.getByText("In Progress")).toBeInTheDocument();
    expect(screen.getByText("Fix login bug")).toBeInTheDocument();
  });

  it("renders priority and team name for linked issue", async () => {
    // Metadata row should include priority label and team name
    mockApi.getLinkedLinearIssue.mockResolvedValue({
      issue: mockLinearIssue,
      comments: [],
      assignee: null,
      labels: [],
    });
    resetStore({
      sessions: new Map([["s1", { backend_type: "claude" }]]),
      linkedLinearIssues: new Map([["s1", mockLinearIssue]]),
    });
    render(<TaskPanel sessionId="s1" />);
    expect(screen.getByText("High")).toBeInTheDocument();
    expect(screen.getByText("Engineering")).toBeInTheDocument();
  });

  it("shows the comment input when an issue is linked", () => {
    // Linked issues should always have the comment input visible
    mockApi.getLinkedLinearIssue.mockResolvedValue({
      issue: mockLinearIssue,
      comments: [],
      assignee: null,
      labels: [],
    });
    resetStore({
      sessions: new Map([["s1", { backend_type: "claude" }]]),
      linkedLinearIssues: new Map([["s1", mockLinearIssue]]),
    });
    render(<TaskPanel sessionId="s1" />);
    expect(screen.getByLabelText("Add a comment")).toBeInTheDocument();
  });

  it("shows unlink button for linked issue", () => {
    // Linked issues should have an unlink button
    mockApi.getLinkedLinearIssue.mockResolvedValue({
      issue: mockLinearIssue,
      comments: [],
      assignee: null,
      labels: [],
    });
    resetStore({
      sessions: new Map([["s1", { backend_type: "claude" }]]),
      linkedLinearIssues: new Map([["s1", mockLinearIssue]]),
    });
    render(<TaskPanel sessionId="s1" />);
    expect(screen.getByTitle("Unlink issue")).toBeInTheDocument();
  });

  it("renders correct state pill for different state types", () => {
    // Verify linearStatePill produces correct labels for various state types
    const completedIssue = { ...mockLinearIssue, stateType: "completed", stateName: "Done" };
    mockApi.getLinkedLinearIssue.mockResolvedValue({
      issue: completedIssue,
      comments: [],
      assignee: null,
      labels: [],
    });
    resetStore({
      sessions: new Map([["s1", { backend_type: "claude" }]]),
      linkedLinearIssues: new Map([["s1", completedIssue]]),
    });
    render(<TaskPanel sessionId="s1" />);
    expect(screen.getByText("Done")).toBeInTheDocument();
  });

  it("renders cancelled state pill", () => {
    const cancelledIssue = { ...mockLinearIssue, stateType: "cancelled", stateName: "Cancelled" };
    mockApi.getLinkedLinearIssue.mockResolvedValue({
      issue: cancelledIssue,
      comments: [],
      assignee: null,
      labels: [],
    });
    resetStore({
      sessions: new Map([["s1", { backend_type: "claude" }]]),
      linkedLinearIssues: new Map([["s1", cancelledIssue]]),
    });
    render(<TaskPanel sessionId="s1" />);
    expect(screen.getByText("Cancelled")).toBeInTheDocument();
  });

  it("renders unstarted state pill with correct label", () => {
    const unstartedIssue = { ...mockLinearIssue, stateType: "unstarted", stateName: "Todo" };
    mockApi.getLinkedLinearIssue.mockResolvedValue({
      issue: unstartedIssue,
      comments: [],
      assignee: null,
      labels: [],
    });
    resetStore({
      sessions: new Map([["s1", { backend_type: "claude" }]]),
      linkedLinearIssues: new Map([["s1", unstartedIssue]]),
    });
    render(<TaskPanel sessionId="s1" />);
    expect(screen.getByText("Todo")).toBeInTheDocument();
  });

  it("renders backlog state pill", () => {
    const backlogIssue = { ...mockLinearIssue, stateType: "backlog", stateName: "Backlog" };
    mockApi.getLinkedLinearIssue.mockResolvedValue({
      issue: backlogIssue,
      comments: [],
      assignee: null,
      labels: [],
    });
    resetStore({
      sessions: new Map([["s1", { backend_type: "claude" }]]),
      linkedLinearIssues: new Map([["s1", backlogIssue]]),
    });
    render(<TaskPanel sessionId="s1" />);
    expect(screen.getByText("Backlog")).toBeInTheDocument();
  });

  it("links to the issue URL", () => {
    // The issue identifier should be a link to the Linear issue URL
    mockApi.getLinkedLinearIssue.mockResolvedValue({
      issue: mockLinearIssue,
      comments: [],
      assignee: null,
      labels: [],
    });
    resetStore({
      sessions: new Map([["s1", { backend_type: "claude" }]]),
      linkedLinearIssues: new Map([["s1", mockLinearIssue]]),
    });
    render(<TaskPanel sessionId="s1" />);
    const link = screen.getByText("ENG-123").closest("a");
    expect(link).toHaveAttribute("href", "https://linear.app/team/ENG-123");
    expect(link).toHaveAttribute("target", "_blank");
  });
});

describe("GitBranchSection — pull button behavior", () => {
  it("calls api.gitPull when the Pull button is clicked", async () => {
    // Clicking Pull should invoke the gitPull API with the cwd
    resetStore({
      sessions: new Map([["s1", {
        backend_type: "claude",
        git_branch: "main",
        git_behind: 3,
        cwd: "/home/user/project",
      }]]),
    });
    render(<TaskPanel sessionId="s1" />);
    fireEvent.click(screen.getByText("Pull"));
    expect(mockApi.gitPull).toHaveBeenCalledWith("/home/user/project");
  });

  it("uses repo_root when available for pull", async () => {
    // The pull button should prefer repo_root over cwd
    resetStore({
      sessions: new Map([["s1", {
        backend_type: "claude",
        git_branch: "main",
        git_behind: 2,
        cwd: "/home/user/project/subdir",
        repo_root: "/home/user/project",
      }]]),
    });
    render(<TaskPanel sessionId="s1" />);
    fireEvent.click(screen.getByText("Pull"));
    expect(mockApi.gitPull).toHaveBeenCalledWith("/home/user/project");
  });
});

describe("TaskPanel accessibility", () => {
  it("passes axe accessibility checks in normal mode", async () => {
    const { axe } = await import("vitest-axe");
    resetStore();
    const { container } = render(<TaskPanel sessionId="s1" />);
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  it("passes axe accessibility checks in config mode", async () => {
    // Config mode renders toggle switches with role="switch" and aria-checked
    const { axe } = await import("vitest-axe");
    resetStore({ taskPanelConfigMode: true });
    const { container } = render(<TaskPanel sessionId="s1" />);
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  it("passes axe accessibility checks with tasks rendered", async () => {
    // Ensure task items with various states pass accessibility checks
    const { axe } = await import("vitest-axe");
    resetStore({
      sessions: new Map([["s1", { backend_type: "claude" }]]),
      sessionTasks: new Map([
        ["s1", [
          { id: "t1", status: "completed", subject: "Done task" },
          { id: "t2", status: "in_progress", subject: "Active task", activeForm: "Working on it" },
          { id: "t3", status: "pending", subject: "Upcoming task" },
        ]],
      ]),
    });
    const { container } = render(<TaskPanel sessionId="s1" />);
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  it("passes axe for GitHubPRDisplay", async () => {
    const { axe } = await import("vitest-axe");
    const pr: GitHubPRInfo = {
      number: 1,
      title: "Test PR",
      url: "https://github.com/test/pr/1",
      state: "OPEN",
      isDraft: false,
      reviewDecision: "APPROVED",
      additions: 10,
      deletions: 5,
      changedFiles: 2,
      checks: [],
      checksSummary: { total: 3, success: 3, failure: 0, pending: 0 },
      reviewThreads: { total: 1, resolved: 1, unresolved: 0 },
    };
    const { container } = render(<GitHubPRDisplay pr={pr} />);
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});

describe("PanelSection — collapsible behavior", () => {
  it("renders section headers with aria-expanded for all visible sections", () => {
    // Each section rendered via SectionWithBadge should have an aria-expanded header
    resetStore({
      sessions: new Map([["s1", { backend_type: "claude" }]]),
    });
    render(<TaskPanel sessionId="s1" />);
    const expandedButtons = screen.getAllByRole("button", { expanded: true });
    // At least some section headers should be expanded by default
    expect(expandedButtons.length).toBeGreaterThan(0);
  });

  it("collapses a section when its header is clicked", () => {
    // Clicking a PanelSection header should toggle aria-expanded to false
    resetStore({
      sessions: new Map([["s1", { backend_type: "claude" }]]),
    });
    render(<TaskPanel sessionId="s1" />);
    // Find the "Tasks" section header button
    const tasksHeader = screen.getByText("Tasks").closest("button");
    expect(tasksHeader).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(tasksHeader!);
    expect(tasksHeader).toHaveAttribute("aria-expanded", "false");
  });

  it("re-expands a collapsed section when header is clicked again", () => {
    // Double-clicking should return to expanded state
    resetStore({
      sessions: new Map([["s1", { backend_type: "claude" }]]),
    });
    render(<TaskPanel sessionId="s1" />);
    const tasksHeader = screen.getByText("Tasks").closest("button");
    fireEvent.click(tasksHeader!); // collapse
    expect(tasksHeader).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(tasksHeader!); // re-expand
    expect(tasksHeader).toHaveAttribute("aria-expanded", "true");
  });

  it("renders chevron icon in section headers", () => {
    // Each PanelSection header should have an aria-hidden chevron SVG
    resetStore({
      sessions: new Map([["s1", { backend_type: "claude" }]]),
    });
    const { container } = render(<TaskPanel sessionId="s1" />);
    // Chevron SVGs have aria-hidden="true"
    const chevrons = container.querySelectorAll("svg[aria-hidden='true']");
    expect(chevrons.length).toBeGreaterThan(0);
  });
});

describe("ProgressMeter — accessibility attributes", () => {
  it("renders progress bars with role=meter and aria attributes", async () => {
    // Usage bars should have role="meter" for accessibility
    mockApi.getSessionUsageLimits.mockResolvedValueOnce({
      five_hour: { utilization: 50, resets_at: null },
      seven_day: null,
      extra_usage: null,
    });
    resetStore({
      sessions: new Map([["s1", { backend_type: "claude" }]]),
    });
    render(<TaskPanel sessionId="s1" />);
    await screen.findByText("5h Limit");
    const meter = screen.getByRole("meter");
    expect(meter).toHaveAttribute("aria-valuenow", "50");
    expect(meter).toHaveAttribute("aria-valuemin", "0");
    expect(meter).toHaveAttribute("aria-valuemax", "100");
  });
});

describe("LinearIssueSection — comments and labels rendering", () => {
  const mockLinearIssue = {
    id: "issue-1",
    identifier: "ENG-123",
    title: "Fix login bug",
    description: "Users cannot log in",
    url: "https://linear.app/team/ENG-123",
    branchName: "fix/login-bug",
    priorityLabel: "High",
    stateName: "In Progress",
    stateType: "started",
    teamName: "Engineering",
    teamKey: "ENG",
    teamId: "team-1",
  };

  it("renders comments when available", async () => {
    // Comments section should show recent comments after async fetch
    mockApi.getLinkedLinearIssue.mockResolvedValue({
      issue: mockLinearIssue,
      comments: [
        { id: "c1", body: "Looks good!", createdAt: new Date().toISOString(), userName: "Alice" },
        { id: "c2", body: "Please fix the tests", createdAt: new Date().toISOString(), userName: "Bob" },
      ],
      assignee: null,
      labels: [],
    });
    resetStore({
      sessions: new Map([["s1", { backend_type: "claude" }]]),
      linkedLinearIssues: new Map([["s1", mockLinearIssue]]),
    });
    render(<TaskPanel sessionId="s1" />);
    expect(await screen.findByText("Comments")).toBeInTheDocument();
    expect(screen.getByText("Looks good!")).toBeInTheDocument();
    expect(screen.getByText("Please fix the tests")).toBeInTheDocument();
  });

  it("renders labels when available", async () => {
    // Labels should display with their colors after async fetch
    mockApi.getLinkedLinearIssue.mockResolvedValue({
      issue: mockLinearIssue,
      comments: [],
      assignee: null,
      labels: [
        { id: "l1", name: "Bug", color: "#e53e3e" },
        { id: "l2", name: "Priority", color: "#ed8936" },
      ],
    });
    resetStore({
      sessions: new Map([["s1", { backend_type: "claude" }]]),
      linkedLinearIssues: new Map([["s1", mockLinearIssue]]),
    });
    render(<TaskPanel sessionId="s1" />);
    expect(await screen.findByText("Bug")).toBeInTheDocument();
    expect(screen.getByText("Priority")).toBeInTheDocument();
  });

  it("renders assignee when available", async () => {
    // Assignee name should appear in metadata row after async fetch
    mockApi.getLinkedLinearIssue.mockResolvedValue({
      issue: mockLinearIssue,
      comments: [],
      assignee: { name: "Jane Doe" },
      labels: [],
    });
    resetStore({
      sessions: new Map([["s1", { backend_type: "claude" }]]),
      linkedLinearIssues: new Map([["s1", mockLinearIssue]]),
    });
    render(<TaskPanel sessionId="s1" />);
    expect(await screen.findByText("@ Jane Doe")).toBeInTheDocument();
  });

  it("calls api.unlinkLinearIssue when unlink button is clicked", () => {
    // Clicking the unlink button should call the unlink API
    mockApi.getLinkedLinearIssue.mockResolvedValue({
      issue: mockLinearIssue,
      comments: [],
      assignee: null,
      labels: [],
    });
    resetStore({
      sessions: new Map([["s1", { backend_type: "claude" }]]),
      linkedLinearIssues: new Map([["s1", mockLinearIssue]]),
    });
    render(<TaskPanel sessionId="s1" />);
    fireEvent.click(screen.getByTitle("Unlink issue"));
    expect(mockApi.unlinkLinearIssue).toHaveBeenCalledWith("s1");
  });
});
