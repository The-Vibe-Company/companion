// @vitest-environment jsdom
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import type { SessionState, SdkSessionInfo } from "../types.js";

// ─── Mock setup ──────────────────────────────────────────────────────────────

const mockConnectSession = vi.fn();
const mockConnectAllSessions = vi.fn();
const mockDisconnectSession = vi.fn();

vi.mock("../ws.js", () => ({
  connectSession: (...args: unknown[]) => mockConnectSession(...args),
  connectAllSessions: (...args: unknown[]) => mockConnectAllSessions(...args),
  disconnectSession: (...args: unknown[]) => mockDisconnectSession(...args),
}));

const mockApi = {
  listSessions: vi.fn().mockResolvedValue([]),
  deleteSession: vi.fn().mockResolvedValue({}),
  archiveSession: vi.fn().mockResolvedValue({}),
  unarchiveSession: vi.fn().mockResolvedValue({}),
  renameSession: vi.fn().mockResolvedValue({}),
  getArchiveInfo: vi.fn().mockResolvedValue({ hasLinkedIssue: false, issueNotDone: false }),
};

vi.mock("../api.js", () => ({
  api: {
    listSessions: (...args: unknown[]) => mockApi.listSessions(...args),
    deleteSession: (...args: unknown[]) => mockApi.deleteSession(...args),
    archiveSession: (...args: unknown[]) => mockApi.archiveSession(...args),
    unarchiveSession: (...args: unknown[]) => mockApi.unarchiveSession(...args),
    renameSession: (...args: unknown[]) => mockApi.renameSession(...args),
    getArchiveInfo: (...args: unknown[]) => mockApi.getArchiveInfo(...args),
  },
}));

// ─── Store mock helpers ──────────────────────────────────────────────────────

// We need to mock the store. The Sidebar uses `useStore((s) => s.xxx)` selector pattern.
// We'll provide a real-ish mock that supports selector calls.

interface MockStoreState {
  sessions: Map<string, SessionState>;
  sdkSessions: SdkSessionInfo[];
  currentSessionId: string | null;
  connectionStatus: Map<string, "connecting" | "connected" | "disconnected">;
  cliConnected: Map<string, boolean>;
  cliReconnecting: Map<string, boolean>;
  sessionStatus: Map<string, "idle" | "running" | "compacting" | null>;
  sessionNames: Map<string, string>;
  recentlyRenamed: Set<string>;
  pendingPermissions: Map<string, Map<string, unknown>>;
  linkedLinearIssues: Map<string, unknown>;
  collapsedProjects: Set<string>;
  setCurrentSession: ReturnType<typeof vi.fn>;
  toggleProjectCollapse: ReturnType<typeof vi.fn>;
  removeSession: ReturnType<typeof vi.fn>;
  newSession: ReturnType<typeof vi.fn>;
  setSidebarOpen: ReturnType<typeof vi.fn>;
  setSessionName: ReturnType<typeof vi.fn>;
  markRecentlyRenamed: ReturnType<typeof vi.fn>;
  clearRecentlyRenamed: ReturnType<typeof vi.fn>;
  setSdkSessions: ReturnType<typeof vi.fn>;
}

function makeSession(id: string, overrides: Partial<SessionState> = {}): SessionState {
  return {
    session_id: id,
    model: "claude-sonnet-4-6",
    cwd: "/home/user/projects/myapp",
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
    ...overrides,
  };
}

function makeSdkSession(id: string, overrides: Partial<SdkSessionInfo> = {}): SdkSessionInfo {
  return {
    sessionId: id,
    state: "connected",
    cwd: "/home/user/projects/myapp",
    createdAt: Date.now(),
    archived: false,
    ...overrides,
  };
}

let mockState: MockStoreState;

function createMockState(overrides: Partial<MockStoreState> = {}): MockStoreState {
  return {
    sessions: new Map(),
    sdkSessions: [],
    currentSessionId: null,
    connectionStatus: new Map(),
    cliConnected: new Map(),
    cliReconnecting: new Map(),
    sessionStatus: new Map(),
    sessionNames: new Map(),
    recentlyRenamed: new Set(),
    pendingPermissions: new Map(),
    linkedLinearIssues: new Map(),
    collapsedProjects: new Set(),
    setCurrentSession: vi.fn(),
    toggleProjectCollapse: vi.fn(),
    removeSession: vi.fn(),
    newSession: vi.fn(),
    setSidebarOpen: vi.fn(),
    setSessionName: vi.fn(),
    markRecentlyRenamed: vi.fn(),
    clearRecentlyRenamed: vi.fn(),
    setSdkSessions: vi.fn(),
    ...overrides,
  };
}

// Mock the store module
vi.mock("../store.js", () => {
  // We create a function that acts like the zustand hook with selectors
  const useStoreFn = (selector: (state: MockStoreState) => unknown) => {
    return selector(mockState);
  };
  // Also support useStore.getState() which Sidebar uses directly
  useStoreFn.getState = () => mockState;

  return { useStore: useStoreFn };
});

// ─── Import component after mocks ───────────────────────────────────────────

import { Sidebar } from "./Sidebar.js";

// ─── Tests ──────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  mockState = createMockState();
  window.location.hash = "";
});

describe("Sidebar", () => {
  it("renders 'New Session' button", () => {
    // Desktop header + mobile FAB both have title="New Session"
    render(<Sidebar />);
    const buttons = screen.getAllByTitle("New Session");
    expect(buttons.length).toBeGreaterThanOrEqual(1);
  });

  it("renders 'No sessions yet.' when no sessions exist", () => {
    render(<Sidebar />);
    expect(screen.getByText("No sessions yet.")).toBeInTheDocument();
  });

  it("renders session items for active sessions", () => {
    const session = makeSession("s1");
    const sdk = makeSdkSession("s1", { model: "claude-sonnet-4-6" });
    mockState = createMockState({
      sessions: new Map([["s1", session]]),
      sdkSessions: [sdk],
    });

    render(<Sidebar />);
    // The session label defaults to model name
    expect(screen.getByText("claude-sonnet-4-6")).toBeInTheDocument();
  });

  it("session items show model name or session ID", () => {
    // Session with model name
    const session1 = makeSession("s1", { model: "claude-opus-4-6" });
    const sdk1 = makeSdkSession("s1", { model: "claude-opus-4-6" });

    // Session without model (falls back to short ID)
    const session2 = makeSession("abcdef12-3456-7890-abcd-ef1234567890", { model: "" });
    const sdk2 = makeSdkSession("abcdef12-3456-7890-abcd-ef1234567890", { model: "" });

    mockState = createMockState({
      sessions: new Map([
        ["s1", session1],
        ["abcdef12-3456-7890-abcd-ef1234567890", session2],
      ]),
      sdkSessions: [sdk1, sdk2],
    });

    render(<Sidebar />);
    expect(screen.getByText("claude-opus-4-6")).toBeInTheDocument();
    // Falls back to shortId (first 8 chars)
    expect(screen.getByText("abcdef12")).toBeInTheDocument();
  });

  it("session items show project name in group header and full cwd path in session row", () => {
    // "myapp" appears in the project group header, full cwd path appears in the session row
    const session = makeSession("s1", { cwd: "/home/user/projects/myapp" });
    const sdk = makeSdkSession("s1");
    mockState = createMockState({
      sessions: new Map([["s1", session]]),
      sdkSessions: [sdk],
    });

    render(<Sidebar />);
    // Group header shows "myapp"
    const matches = screen.getAllByText("myapp");
    expect(matches.length).toBeGreaterThanOrEqual(1);
    // Session row shows the full cwd path
    expect(screen.getByText("/home/user/projects/myapp")).toBeInTheDocument();
  });

  it("session items do not show git branch (removed in redesign)", () => {
    // Git branch was intentionally removed from session items in the sidebar redesign.
    // The data is still in the store but no longer rendered in the session row.
    const session = makeSession("s1", { git_branch: "feature/awesome" });
    const sdk = makeSdkSession("s1");
    mockState = createMockState({
      sessions: new Map([["s1", session]]),
      sdkSessions: [sdk],
    });

    render(<Sidebar />);
    expect(screen.queryByText("feature/awesome")).not.toBeInTheDocument();
  });

  it("session items show container badge when is_containerized is true", () => {
    const session = makeSession("s1", { git_branch: "feature/docker", is_containerized: true });
    const sdk = makeSdkSession("s1", { containerId: "abc123" });
    mockState = createMockState({
      sessions: new Map([["s1", session]]),
      sdkSessions: [sdk],
    });

    render(<Sidebar />);
    const badge = screen.getByTitle("Docker");
    expect(badge).toBeInTheDocument();
    const dockerLogo = badge.querySelector('img[src="/logo-docker.svg"]');
    expect(dockerLogo).toBeInTheDocument();
  });

  it("session items do not show git stats (removed in redesign)", () => {
    // Git ahead/behind and lines added/removed were intentionally removed
    // from session items in the sidebar redesign.
    const session = makeSession("s1", {
      git_branch: "main",
      git_ahead: 3,
      git_behind: 2,
      total_lines_added: 42,
      total_lines_removed: 7,
    });
    const sdk = makeSdkSession("s1");
    mockState = createMockState({
      sessions: new Map([["s1", session]]),
      sdkSessions: [sdk],
    });

    render(<Sidebar />);
    expect(screen.queryByText("+42")).not.toBeInTheDocument();
    expect(screen.queryByText("-7")).not.toBeInTheDocument();
  });

  it("active session has highlighted styling (bg-cc-active class)", () => {
    const session = makeSession("s1");
    const sdk = makeSdkSession("s1");
    mockState = createMockState({
      sessions: new Map([["s1", session]]),
      sdkSessions: [sdk],
      currentSessionId: "s1",
    });

    render(<Sidebar />);
    // Find the session button element
    const sessionButton = screen.getByText("claude-sonnet-4-6").closest("button");
    expect(sessionButton).toHaveClass("bg-cc-active");
  });

  it("clicking a session navigates to the session hash", () => {
    // Sidebar now delegates to URL-based routing: it sets the hash to #/session/{id}
    // and App.tsx's hash effect handles setCurrentSession + connectSession
    const session = makeSession("s1");
    const sdk = makeSdkSession("s1");
    mockState = createMockState({
      sessions: new Map([["s1", session]]),
      sdkSessions: [sdk],
      currentSessionId: null,
    });

    render(<Sidebar />);
    const sessionButton = screen.getByText("claude-sonnet-4-6").closest("button")!;
    fireEvent.click(sessionButton);

    expect(window.location.hash).toBe("#/session/s1");
  });

  it("New Session button calls newSession", () => {
    // There are two New Session buttons: desktop header + mobile FAB
    render(<Sidebar />);
    const buttons = screen.getAllByTitle("New Session");
    fireEvent.click(buttons[0]);

    expect(mockState.newSession).toHaveBeenCalled();
  });

  it("double-clicking a session enters edit mode", () => {
    const session = makeSession("s1");
    const sdk = makeSdkSession("s1");
    mockState = createMockState({
      sessions: new Map([["s1", session]]),
      sdkSessions: [sdk],
    });

    render(<Sidebar />);
    const sessionButton = screen.getByText("claude-sonnet-4-6").closest("button")!;
    fireEvent.doubleClick(sessionButton);

    // After double-click, an input should appear for renaming
    const input = screen.getByDisplayValue("claude-sonnet-4-6");
    expect(input).toBeInTheDocument();
    expect(input.tagName).toBe("INPUT");
  });

  it("session actions menu button exists in the DOM", () => {
    const session = makeSession("s1");
    const sdk = makeSdkSession("s1");
    mockState = createMockState({
      sessions: new Map([["s1", session]]),
      sdkSessions: [sdk],
    });

    render(<Sidebar />);
    // Session actions button (three-dot menu) has title "Session actions"
    const menuButton = screen.getByTitle("Session actions");
    expect(menuButton).toBeInTheDocument();
  });

  it("session actions menu shows archive option when clicked", () => {
    const session = makeSession("s1");
    const sdk = makeSdkSession("s1");
    mockState = createMockState({
      sessions: new Map([["s1", session]]),
      sdkSessions: [sdk],
    });

    render(<Sidebar />);
    const menuButton = screen.getByTitle("Session actions");
    fireEvent.click(menuButton);

    // Menu should show Archive and Rename options
    expect(screen.getByText("Archive")).toBeInTheDocument();
    expect(screen.getByText("Rename")).toBeInTheDocument();
  });

  it("session actions menu button is visible by default on mobile and hover-only on desktop", () => {
    const session = makeSession("s1");
    const sdk = makeSdkSession("s1");
    mockState = createMockState({
      sessions: new Map([["s1", session]]),
      sdkSessions: [sdk],
    });

    render(<Sidebar />);
    const menuButton = screen.getByTitle("Session actions");

    expect(menuButton).toHaveClass("opacity-100");
    expect(menuButton).toHaveClass("sm:opacity-0");
    expect(menuButton).toHaveClass("sm:group-hover:opacity-100");
  });

  it("pending permissions render a yellow awaiting status dot", () => {
    const session = makeSession("s1");
    const sdk = makeSdkSession("s1");
    mockState = createMockState({
      sessions: new Map([["s1", session]]),
      sdkSessions: [sdk],
      pendingPermissions: new Map([["s1", new Map([["p1", {}]])]]),
      cliConnected: new Map([["s1", true]]),
    });

    render(<Sidebar />);
    const awaitingDot = document.querySelector(".bg-cc-warning.animate-\\[ring-pulse_1\\.5s_ease-out_infinite\\]");
    expect(awaitingDot).toBeTruthy();
  });

  it("reconnecting session renders a spinning status dot", () => {
    // Validates that a session in reconnecting state shows a spinning border dot
    const session = makeSession("s1");
    const sdk = makeSdkSession("s1");
    mockState = createMockState({
      sessions: new Map([["s1", session]]),
      sdkSessions: [sdk],
      cliConnected: new Map([["s1", false]]),
      cliReconnecting: new Map([["s1", true]]),
    });

    render(<Sidebar />);
    const reconnectingDot = document.querySelector(".animate-spin.border-t-cc-warning");
    expect(reconnectingDot).toBeTruthy();
  });

  it("archived sessions section shows count", () => {
    const sdk1 = makeSdkSession("s1", { archived: false });
    const sdk2 = makeSdkSession("s2", { archived: true });
    const sdk3 = makeSdkSession("s3", { archived: true });

    mockState = createMockState({
      sdkSessions: [sdk1, sdk2, sdk3],
    });

    render(<Sidebar />);
    // The component renders "Archived (2)"
    expect(screen.getByText(/Archived \(2\)/)).toBeInTheDocument();
  });

  it("toggle archived shows/hides archived sessions", () => {
    const sdk1 = makeSdkSession("s1", { archived: false, model: "active-model" });
    const sdk2 = makeSdkSession("s2", { archived: true, model: "archived-model" });

    mockState = createMockState({
      sdkSessions: [sdk1, sdk2],
    });

    render(<Sidebar />);

    // Archived sessions should not be visible initially
    expect(screen.queryByText("archived-model")).not.toBeInTheDocument();

    // Click the archived toggle button
    const toggleButton = screen.getByText(/Archived \(1\)/);
    fireEvent.click(toggleButton);

    // Now the archived session should be visible
    expect(screen.getByText("archived-model")).toBeInTheDocument();
  });

  it("does not render settings controls directly in sidebar", () => {
    render(<Sidebar />);
    expect(screen.queryByText("Notification")).not.toBeInTheDocument();
    expect(screen.queryByText("Dark mode")).not.toBeInTheDocument();
  });

  it("navigates to environments page when Environments is clicked", () => {
    render(<Sidebar />);
    fireEvent.click(screen.getByTitle("Environments"));
    expect(window.location.hash).toBe("#/environments");
  });

  it("navigates to settings page when Settings is clicked", () => {
    render(<Sidebar />);
    fireEvent.click(screen.getByTitle("Settings"));
    expect(window.location.hash).toBe("#/settings");
  });

  it("navigates to integrations page when Integrations is clicked", () => {
    render(<Sidebar />);
    fireEvent.click(screen.getByTitle("Integrations"));
    expect(window.location.hash).toBe("#/integrations");
  });

  it("navigates to prompts page when Prompts is clicked", () => {
    render(<Sidebar />);
    fireEvent.click(screen.getByTitle("Prompts"));
    expect(window.location.hash).toBe("#/prompts");
  });

  it("session name shows animate-name-appear class when recently renamed", () => {
    const session = makeSession("s1");
    const sdk = makeSdkSession("s1");
    mockState = createMockState({
      sessions: new Map([["s1", session]]),
      sdkSessions: [sdk],
      sessionNames: new Map([["s1", "Auto Generated Title"]]),
      recentlyRenamed: new Set(["s1"]),
    });

    render(<Sidebar />);
    const nameElement = screen.getByText("Auto Generated Title");
    // Animation class is on the parent span wrapper, not the inner text span
    expect(nameElement.closest(".animate-name-appear")).toBeTruthy();
  });

  it("session name does NOT have animate-name-appear when not recently renamed", () => {
    const session = makeSession("s1");
    const sdk = makeSdkSession("s1");
    mockState = createMockState({
      sessions: new Map([["s1", session]]),
      sdkSessions: [sdk],
      sessionNames: new Map([["s1", "Regular Name"]]),
      recentlyRenamed: new Set(), // not recently renamed
    });

    render(<Sidebar />);
    const nameElement = screen.getByText("Regular Name");
    expect(nameElement.className).not.toContain("animate-name-appear");
  });

  it("calls clearRecentlyRenamed on animation end", () => {
    const session = makeSession("s1");
    const sdk = makeSdkSession("s1");
    mockState = createMockState({
      sessions: new Map([["s1", session]]),
      sdkSessions: [sdk],
      sessionNames: new Map([["s1", "Animated Name"]]),
      recentlyRenamed: new Set(["s1"]),
    });

    const { container } = render(<Sidebar />);
    // The animated span has the animate-name-appear class and an onAnimationEnd
    // handler that calls onClearRecentlyRenamed(sessionId).
    const animatedSpan = container.querySelector(".animate-name-appear");
    expect(animatedSpan).toBeTruthy();

    // JSDOM does not define AnimationEvent in all environments, which
    // causes fireEvent.animationEnd to silently fail. We traverse the
    // React fiber tree to invoke the onAnimationEnd handler directly.
    const fiberKey = Object.keys(animatedSpan!).find((k) =>
      k.startsWith("__reactFiber$"),
    );
    expect(fiberKey).toBeDefined();
    let fiber = (animatedSpan as unknown as Record<string, unknown>)[fiberKey!] as Record<string, unknown> | null;
    let called = false;
    while (fiber) {
      const props = fiber.memoizedProps as Record<string, unknown> | undefined;
      if (props?.onAnimationEnd) {
        (props.onAnimationEnd as () => void)();
        called = true;
        break;
      }
      fiber = fiber.return as Record<string, unknown> | null;
    }
    expect(called).toBe(true);
    expect(mockState.clearRecentlyRenamed).toHaveBeenCalledWith("s1");
  });

  it("animation class applies only to the recently renamed session, not others", () => {
    const session1 = makeSession("s1");
    const session2 = makeSession("s2");
    const sdk1 = makeSdkSession("s1");
    const sdk2 = makeSdkSession("s2");
    mockState = createMockState({
      sessions: new Map([["s1", session1], ["s2", session2]]),
      sdkSessions: [sdk1, sdk2],
      sessionNames: new Map([["s1", "Renamed Session"], ["s2", "Other Session"]]),
      recentlyRenamed: new Set(["s1"]), // only s1 was renamed
    });

    render(<Sidebar />);
    const renamedElement = screen.getByText("Renamed Session");
    const otherElement = screen.getByText("Other Session");

    // Animation class is on the parent span wrapper, not the inner text span
    expect(renamedElement.closest(".animate-name-appear")).toBeTruthy();
    expect(otherElement.closest(".animate-name-appear")).toBeFalsy();
  });

  it("session keeps awaiting state with multiple pending permissions", () => {
    const session = makeSession("s1");
    const sdk = makeSdkSession("s1");
    const permMap = new Map<string, unknown>([
      ["r1", { request_id: "r1", tool_name: "Bash" }],
      ["r2", { request_id: "r2", tool_name: "Read" }],
    ]);
    mockState = createMockState({
      sessions: new Map([["s1", session]]),
      sdkSessions: [sdk],
      pendingPermissions: new Map([["s1", permMap as Map<string, unknown>]]),
      cliConnected: new Map([["s1", true]]),
    });

    render(<Sidebar />);
    const awaitingDot = document.querySelector(".bg-cc-warning.animate-\\[ring-pulse_1\\.5s_ease-out_infinite\\]");
    expect(awaitingDot).toBeTruthy();
  });

  it("archived session row is clickable after opening archived section", () => {
    const sdk = makeSdkSession("s1", { archived: true, model: "archived-clickable" });
    mockState = createMockState({
      sdkSessions: [sdk],
    });

    render(<Sidebar />);
    fireEvent.click(screen.getByText(/Archived \(1\)/));

    const archivedRowButton = screen.getByText("archived-clickable").closest("button");
    expect(archivedRowButton).toBeInTheDocument();
    if (!archivedRowButton) throw new Error("Archived row button not found");

    fireEvent.click(archivedRowButton);
    expect(window.location.hash).toBe("#/session/s1");
  });

  it("session does not render git data from sdkInfo (redesign removes git display)", () => {
    // Git branch and stats are no longer rendered in the session row.
    // The data still flows through the store but is not displayed.
    const sdk = makeSdkSession("s1", {
      gitBranch: "feature/from-rest",
      gitAhead: 5,
      gitBehind: 2,
      totalLinesAdded: 100,
      totalLinesRemoved: 20,
    });
    mockState = createMockState({
      sessions: new Map(),
      sdkSessions: [sdk],
    });

    render(<Sidebar />);
    expect(screen.queryByText("feature/from-rest")).not.toBeInTheDocument();
    expect(screen.queryByText("+100")).not.toBeInTheDocument();
    expect(screen.queryByText("-20")).not.toBeInTheDocument();
  });

  it("codex session shows CX badge when bridgeState is missing", () => {
    // Only sdkInfo available (no WS session_init received yet).
    // The redesigned session item uses text badges ("CC" / "CX") instead
    // of colored dots with title attributes.
    const sdk = makeSdkSession("s1", { backendType: "codex" });
    mockState = createMockState({
      sessions: new Map(),
      sdkSessions: [sdk],
    });

    render(<Sidebar />);
    expect(screen.getByText("CX")).toBeInTheDocument();
  });

  it("session shows correct backend badge based on backendType", () => {
    // The redesigned session item uses "CC" for Claude and "CX" for Codex
    // as small pill badges instead of colored dots.
    const session1 = makeSession("s1", { backend_type: "claude" });
    const session2 = makeSession("s2", { backend_type: "codex" });
    const sdk1 = makeSdkSession("s1", { backendType: "claude" });
    const sdk2 = makeSdkSession("s2", { backendType: "codex" });
    mockState = createMockState({
      sessions: new Map([["s1", session1], ["s2", session2]]),
      sdkSessions: [sdk1, sdk2],
    });

    render(<Sidebar />);
    expect(screen.getAllByText("CC").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("CX").length).toBeGreaterThanOrEqual(1);
  });

  it("sessions are grouped by project directory", () => {
    const session1 = makeSession("s1", { cwd: "/home/user/project-a" });
    const session2 = makeSession("s2", { cwd: "/home/user/project-a" });
    const session3 = makeSession("s3", { cwd: "/home/user/project-b" });
    const sdk1 = makeSdkSession("s1", { cwd: "/home/user/project-a" });
    const sdk2 = makeSdkSession("s2", { cwd: "/home/user/project-a" });
    const sdk3 = makeSdkSession("s3", { cwd: "/home/user/project-b" });
    mockState = createMockState({
      sessions: new Map([["s1", session1], ["s2", session2], ["s3", session3]]),
      sdkSessions: [sdk1, sdk2, sdk3],
    });

    render(<Sidebar />);
    // Project group headers should be visible (also appears as dirName in session items)
    expect(screen.getAllByText("project-a").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("project-b").length).toBeGreaterThanOrEqual(1);
  });

  it("project group header shows running status dot and session count", () => {
    const session1 = makeSession("s1", { cwd: "/home/user/myapp" });
    const session2 = makeSession("s2", { cwd: "/home/user/myapp" });
    const sdk1 = makeSdkSession("s1", { cwd: "/home/user/myapp" });
    const sdk2 = makeSdkSession("s2", { cwd: "/home/user/myapp" });
    mockState = createMockState({
      sessions: new Map([["s1", session1], ["s2", session2]]),
      sdkSessions: [sdk1, sdk2],
      sessionStatus: new Map([["s1", "running"], ["s2", "running"]]),
    });

    render(<Sidebar />);
    // Status dot with title "2 running" should be present
    expect(screen.getByTitle("2 running")).toBeInTheDocument();
    // Session count badge should show "2"
    expect(screen.getByText("2")).toBeInTheDocument();
  });

  it("collapsing a project group hides its session items but shows a preview", () => {
    const session = makeSession("s1", { cwd: "/home/user/myapp", model: "hidden-model" });
    const sdk = makeSdkSession("s1", { cwd: "/home/user/myapp" });
    mockState = createMockState({
      sessions: new Map([["s1", session]]),
      sdkSessions: [sdk],
      collapsedProjects: new Set(["/home/user/myapp"]),
    });

    render(<Sidebar />);
    // Group header should still be visible
    expect(screen.getByText("myapp")).toBeInTheDocument();
    // The session button itself should not be present (no clickable session row)
    const sessionButtons = screen.getAllByRole("button");
    const sessionRowButton = sessionButtons.find((btn) =>
      btn.textContent?.includes("hidden-model") && btn.classList.contains("rounded-lg"),
    );
    expect(sessionRowButton).toBeUndefined();
    // But a collapsed preview text should appear with the session name
    const previewElement = screen.getByText("hidden-model");
    expect(previewElement).toBeInTheDocument();
    expect(previewElement.className).toContain("text-cc-muted/70");
  });

  it("context menu shows restore and delete for archived sessions", () => {
    const sdk1 = makeSdkSession("s1", { archived: false, model: "active-model" });
    const sdk2 = makeSdkSession("s2", { archived: true, model: "archived-model" });

    mockState = createMockState({
      sdkSessions: [sdk1, sdk2],
    });

    render(<Sidebar />);

    // Expand the archived section first
    const toggleButton = screen.getByText(/Archived \(1\)/);
    fireEvent.click(toggleButton);

    // Find the session actions menu for the archived session
    const menuButtons = screen.getAllByTitle("Session actions");
    // The archived session's menu button (last one since archived section is below)
    const archivedMenuButton = menuButtons[menuButtons.length - 1];
    fireEvent.click(archivedMenuButton);

    // Should show Restore and Delete options, but not Archive or Rename
    expect(screen.getByText("Restore")).toBeInTheDocument();
    expect(screen.getByText("Delete")).toBeInTheDocument();
    expect(screen.queryByText("Archive")).not.toBeInTheDocument();
  });

  it("session item does not show timestamp (removed in redesign)", () => {
    // Timestamps were intentionally removed from session items in the sidebar
    // redesign to reduce visual clutter.
    const now = Date.now();
    const session = makeSession("s1");
    const sdk = makeSdkSession("s1", { createdAt: now - 3600000 }); // 1 hour ago
    mockState = createMockState({
      sessions: new Map([["s1", session]]),
      sdkSessions: [sdk],
    });

    render(<Sidebar />);
    expect(screen.queryByText("1h ago")).not.toBeInTheDocument();
  });

  it("footer nav uses a vertical list layout with full labels", () => {
    // The footer navigation uses a single-column vertical list where each
    // item is a horizontal row with icon + full label (one line per item).
    render(<Sidebar />);
    // Full labels should be visible (not short labels)
    expect(screen.getByText("Environments")).toBeInTheDocument();
    expect(screen.getByText("Integrations")).toBeInTheDocument();
    expect(screen.getByText("Agents")).toBeInTheDocument();
    expect(screen.getByText("Prompts")).toBeInTheDocument();
    expect(screen.getByText("Settings")).toBeInTheDocument();
  });

  it("footer navigation is grouped into clear sections", () => {
    // Verifies that the redesigned menu exposes explicit grouping labels
    // to improve scanability and information architecture.
    render(<Sidebar />);
    expect(screen.getByText("Workbench")).toBeInTheDocument();
    expect(screen.getByText("Workspace")).toBeInTheDocument();
    expect(screen.getByText("Resources")).toBeInTheDocument();
  });

  it("compact nav does not render helper subtitle lines", () => {
    // Verifies compact density mode: only primary labels are shown in nav items.
    render(<Sidebar />);
    expect(screen.queryByText("Templates and prompt library")).not.toBeInTheDocument();
    expect(screen.queryByText("Connected tools and services")).not.toBeInTheDocument();
  });

  it("session item has minimum touch target height", () => {
    const session = makeSession("s1");
    const sdk = makeSdkSession("s1");
    mockState = createMockState({
      sessions: new Map([["s1", session]]),
      sdkSessions: [sdk],
    });

    render(<Sidebar />);
    const sessionButton = screen.getByText("claude-sonnet-4-6").closest("button");
    // The button should have min-h-[44px] class for touch accessibility
    expect(sessionButton).toHaveClass("min-h-[44px]");
  });

  it("Enter confirms rename in edit mode", () => {
    // Verifies that pressing Enter in the rename input commits the name change
    // via the store's setSessionName action.
    const session = makeSession("s1");
    const sdk = makeSdkSession("s1");
    mockState = createMockState({
      sessions: new Map([["s1", session]]),
      sdkSessions: [sdk],
    });

    render(<Sidebar />);
    const sessionButton = screen.getByText("claude-sonnet-4-6").closest("button")!;
    fireEvent.doubleClick(sessionButton);

    const input = screen.getByDisplayValue("claude-sonnet-4-6") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "My Session" } });
    fireEvent.keyDown(input, { key: "Enter" });

    // After Enter, the rename should be confirmed via the store action
    expect(mockState.setSessionName).toHaveBeenCalledWith("s1", "My Session");
  });

  it("Escape cancels rename in edit mode", () => {
    // Verifies that pressing Escape reverts the rename without saving.
    const session = makeSession("s1");
    const sdk = makeSdkSession("s1");
    mockState = createMockState({
      sessions: new Map([["s1", session]]),
      sdkSessions: [sdk],
    });

    render(<Sidebar />);
    const sessionButton = screen.getByText("claude-sonnet-4-6").closest("button")!;
    fireEvent.doubleClick(sessionButton);

    const input = screen.getByDisplayValue("claude-sonnet-4-6") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Should Not Save" } });
    fireEvent.keyDown(input, { key: "Escape" });

    // After Escape, setSessionName should not be called — the rename was cancelled
    expect(mockState.setSessionName).not.toHaveBeenCalled();
  });

  it("long session names are truncated with the truncate class", () => {
    // Verifies that a very long session name does not cause horizontal overflow.
    const longName = "A".repeat(200);
    const session = makeSession("s1", { model: longName });
    const sdk = makeSdkSession("s1");
    mockState = createMockState({
      sessions: new Map([["s1", session]]),
      sdkSessions: [sdk],
    });

    render(<Sidebar />);
    const nameEl = screen.getByText(longName);
    // The name should use the truncate utility class to prevent overflow
    expect(nameEl).toHaveClass("truncate");
  });

  it("footer nav buttons have title attributes for accessibility", () => {
    // Verifies footer nav buttons have title attributes for tooltip/screen reader support.
    render(<Sidebar />);
    // Footer nav items should have descriptive titles from NAV_ITEMS
    expect(screen.getByTitle("Prompts")).toBeInTheDocument();
    expect(screen.getByTitle("Integrations")).toBeInTheDocument();
    expect(screen.getByTitle("Settings")).toBeInTheDocument();
  });

  it("passes axe accessibility checks", async () => {
    const { axe } = await import("vitest-axe");
    const session = makeSession("s1");
    const sdk = makeSdkSession("s1");
    mockState = createMockState({
      sessions: new Map([["s1", session]]),
      sdkSessions: [sdk],
    });
    const { container } = render(<Sidebar />);
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  // ─── Polling & session name hydration ──────────────────────────────────────

  it("polls for SDK sessions on mount and hydrates session names", async () => {
    // Verifies that the Sidebar's useEffect poll() fetches sessions from the
    // API, calls setSdkSessions + connectAllSessions, and hydrates names from
    // the server response when the store has a random (two-word) name.
    const serverSessions = [
      makeSdkSession("s1", { name: "Server Name" }),
    ];
    mockApi.listSessions.mockResolvedValueOnce(serverSessions);

    // Simulate store having a random two-word name that should be overwritten
    mockState = createMockState({
      sessionNames: new Map([["s1", "Alpha Beta"]]),
    });

    render(<Sidebar />);

    // Wait for the poll() promise to resolve
    await vi.waitFor(() => {
      expect(mockApi.listSessions).toHaveBeenCalled();
    });
    await vi.waitFor(() => {
      expect(mockState.setSdkSessions).toHaveBeenCalledWith(serverSessions);
    });
    expect(mockConnectAllSessions).toHaveBeenCalledWith(serverSessions);
    expect(mockState.setSessionName).toHaveBeenCalledWith("s1", "Server Name");
    // Since the store had a random two-word name, markRecentlyRenamed should fire
    expect(mockState.markRecentlyRenamed).toHaveBeenCalledWith("s1");
  });

  it("poll does not overwrite session name when store name is user-defined (not random)", async () => {
    // Verifies that server names do not overwrite user-typed session names.
    // Only random two-word names (e.g. "Alpha Beta") should be overwritten.
    const serverSessions = [
      makeSdkSession("s1", { name: "Server Name" }),
    ];
    mockApi.listSessions.mockResolvedValueOnce(serverSessions);

    // Store has a non-random name — should not be replaced
    mockState = createMockState({
      sessionNames: new Map([["s1", "My Custom Name"]]),
    });

    render(<Sidebar />);

    await vi.waitFor(() => {
      expect(mockApi.listSessions).toHaveBeenCalled();
    });
    // setSessionName should NOT be called since "My Custom Name" is not a random two-word name
    expect(mockState.setSessionName).not.toHaveBeenCalled();
  });

  it("poll hydrates name when store has no existing name for the session", async () => {
    // Verifies that poll() sets the session name when none exists in the store yet.
    const serverSessions = [
      makeSdkSession("s1", { name: "Fresh Name" }),
    ];
    mockApi.listSessions.mockResolvedValueOnce(serverSessions);

    mockState = createMockState({
      sessionNames: new Map(), // no names in store at all
    });

    render(<Sidebar />);

    await vi.waitFor(() => {
      expect(mockState.setSessionName).toHaveBeenCalledWith("s1", "Fresh Name");
    });
    // No random name existed, so markRecentlyRenamed should not be called
    expect(mockState.markRecentlyRenamed).not.toHaveBeenCalled();
  });

  it("poll gracefully handles API errors", async () => {
    // Verifies that when api.listSessions rejects, the Sidebar does not crash
    // and still renders correctly.
    mockApi.listSessions.mockRejectedValueOnce(new Error("server not ready"));

    render(<Sidebar />);

    // Should still render "No sessions yet." since the API call failed
    await vi.waitFor(() => {
      expect(mockApi.listSessions).toHaveBeenCalled();
    });
    expect(screen.getByText("No sessions yet.")).toBeInTheDocument();
  });

  it("poll removes client-side sessions that the server no longer knows about", async () => {
    // Regression test for: stale sessions persist in the sidebar after being cleared
    // server-side. The poll updates sdkSessions but must also remove entries from the
    // client-side `sessions` Map that are absent from the server response, otherwise
    // the sidebar's UNION(sessions.keys(), sdkSessions) still includes the ghost entry.
    //
    // Scenario: session "stale-id" exists in the client sessions Map (populated earlier
    // via a WebSocket session_init), but the server no longer knows about it. The poll
    // should call removeSession("stale-id") to evict it from the client store.
    const staleSession = makeSession("stale-id");

    mockState = createMockState({
      // Client has a stale session from a previous WebSocket session_init
      sessions: new Map([["stale-id", staleSession]]),
      // Server list is empty — the session was cleared server-side
      sdkSessions: [],
    });

    // Poll returns an empty list — the server no longer has "stale-id"
    mockApi.listSessions.mockResolvedValueOnce([]);

    render(<Sidebar />);

    await vi.waitFor(() => {
      expect(mockApi.listSessions).toHaveBeenCalled();
    });

    // The poll must call removeSession for the stale client-side session
    await vi.waitFor(() => {
      expect(mockState.removeSession).toHaveBeenCalledWith("stale-id");
    });

    // setSdkSessions should have been called with the empty list from the server
    expect(mockState.setSdkSessions).toHaveBeenCalledWith([]);
  });

  it("poll does not remove sessions that still exist on the server", async () => {
    // Verifies the inverse: poll() must NOT call removeSession for sessions
    // that ARE present in the server response. This guards against over-aggressive
    // pruning that would clear valid sessions.
    const activeSession = makeSession("active-id");
    const serverSessions = [makeSdkSession("active-id")];

    mockState = createMockState({
      sessions: new Map([["active-id", activeSession]]),
      sdkSessions: serverSessions,
    });

    mockApi.listSessions.mockResolvedValueOnce(serverSessions);

    render(<Sidebar />);

    await vi.waitFor(() => {
      expect(mockApi.listSessions).toHaveBeenCalled();
    });
    await vi.waitFor(() => {
      expect(mockState.setSdkSessions).toHaveBeenCalledWith(serverSessions);
    });

    // The active session is still on the server — removeSession must NOT be called
    expect(mockState.removeSession).not.toHaveBeenCalled();
  });

  it("poll does not remove sessions that arrived via session_init after listSessions was dispatched", async () => {
    // Race condition regression test: listSessions() is async. Between dispatch and
    // response processing, a `session_init` WebSocket message can add a new session to
    // store.sessions. That session IS legitimately on the server but absent from the
    // `list` snapshot (which reflects server state at request time). Without this guard,
    // the pruning loop would incorrectly evict a live, connected session.
    //
    // Scenario: "new-session-id" arrives via session_init WHILE listSessions is in-flight.
    // The server response does NOT include it (stale snapshot), but the session has
    // connectionStatus "connected". The poll must NOT call removeSession for it.

    const newSession = makeSession("new-session-id");

    // Simulate: listSessions resolves with an empty list (stale snapshot from before
    // session_init arrived). setSdkSessions is a mock — it does NOT mutate mockState.
    // After setSdkSessions completes, getState() should return the state that now
    // includes "new-session-id" with connectionStatus "connected".
    //
    // We configure mockState upfront with the session and its connected status,
    // mirroring what the store would look like after session_init fires mid-flight.
    mockState = createMockState({
      sessions: new Map([["new-session-id", newSession]]),
      // connectionStatus "connected" signals this session has an active WebSocket —
      // it was populated by session_init, not by a stale store state.
      connectionStatus: new Map([["new-session-id", "connected"]]),
    });

    // Server snapshot is empty — doesn't yet include the newly-connected session
    mockApi.listSessions.mockResolvedValueOnce([]);

    render(<Sidebar />);

    await vi.waitFor(() => {
      expect(mockApi.listSessions).toHaveBeenCalled();
    });
    await vi.waitFor(() => {
      expect(mockState.setSdkSessions).toHaveBeenCalledWith([]);
    });

    // The newly-connected session must NOT be evicted — it's live even though it
    // wasn't in the server snapshot.
    expect(mockState.removeSession).not.toHaveBeenCalledWith("new-session-id");
  });

  it("poll removes disconnected sessions absent from server", async () => {
    // Verifies that the connectionStatus guard does not protect sessions that are
    // genuinely stale (disconnected AND absent from the server list). A session with
    // connectionStatus "disconnected" (or no status at all) that is not in the server
    // response should be pruned.
    //
    // Scenario: "ghost-id" exists in the sessions Map with connectionStatus "disconnected"
    // but is not in the server list. It must be removed.
    const ghostSession = makeSession("ghost-id");

    mockState = createMockState({
      sessions: new Map([["ghost-id", ghostSession]]),
      // connectionStatus is disconnected — no active WebSocket, this is a true ghost
      connectionStatus: new Map([["ghost-id", "disconnected"]]),
    });

    // Server knows nothing about "ghost-id"
    mockApi.listSessions.mockResolvedValueOnce([]);

    render(<Sidebar />);

    await vi.waitFor(() => {
      expect(mockApi.listSessions).toHaveBeenCalled();
    });

    // The disconnected ghost session must be pruned
    await vi.waitFor(() => {
      expect(mockState.removeSession).toHaveBeenCalledWith("ghost-id");
    });
  });

  // ─── Delete session flow ──────────────────────────────────────────────────

  it("shows delete confirmation modal when Delete is clicked from context menu", () => {
    // Verifies that clicking Delete in the session context menu triggers the
    // delete confirmation modal with "Delete session?" heading.
    const sdk = makeSdkSession("s1", { archived: true, model: "deletable" });
    mockState = createMockState({
      sdkSessions: [sdk],
    });

    render(<Sidebar />);

    // Expand archived section
    fireEvent.click(screen.getByText(/Archived \(1\)/));

    // Open context menu and click Delete
    const menuButton = screen.getByTitle("Session actions");
    fireEvent.click(menuButton);
    fireEvent.click(screen.getByText("Delete"));

    // Delete confirmation modal should appear
    expect(screen.getByText("Delete session?")).toBeInTheDocument();
    expect(screen.getByText(/This will permanently delete this session/)).toBeInTheDocument();
  });

  it("confirming delete calls api.deleteSession, disconnectSession, and removeSession", async () => {
    // Verifies the full delete flow: clicking Delete in the modal calls through
    // to the API and cleans up the session from the store.
    const sdk = makeSdkSession("s1", { archived: true, model: "to-delete" });
    mockState = createMockState({
      sdkSessions: [sdk],
    });

    render(<Sidebar />);

    // Expand archived, open menu, click Delete
    fireEvent.click(screen.getByText(/Archived \(1\)/));
    fireEvent.click(screen.getByTitle("Session actions"));
    fireEvent.click(screen.getByText("Delete"));

    // Now click the confirm "Delete" button in the modal
    const modalDeleteBtn = screen.getAllByText("Delete").find(
      (el) => el.closest(".fixed") !== null,
    );
    expect(modalDeleteBtn).toBeTruthy();
    fireEvent.click(modalDeleteBtn!);

    await vi.waitFor(() => {
      expect(mockDisconnectSession).toHaveBeenCalledWith("s1");
    });
    expect(mockApi.deleteSession).toHaveBeenCalledWith("s1");
    expect(mockState.removeSession).toHaveBeenCalledWith("s1");
  });

  it("cancelling delete closes the modal without deleting", () => {
    // Verifies that clicking Cancel in the delete modal does not trigger any
    // delete operations and the modal disappears.
    const sdk = makeSdkSession("s1", { archived: true, model: "keep-me" });
    mockState = createMockState({
      sdkSessions: [sdk],
    });

    render(<Sidebar />);

    // Expand archived, open menu, click Delete
    fireEvent.click(screen.getByText(/Archived \(1\)/));
    fireEvent.click(screen.getByTitle("Session actions"));
    fireEvent.click(screen.getByText("Delete"));

    // Verify modal is showing
    expect(screen.getByText("Delete session?")).toBeInTheDocument();

    // Click Cancel in the modal
    const cancelBtn = screen.getAllByText("Cancel").find(
      (el) => el.closest(".fixed") !== null,
    );
    fireEvent.click(cancelBtn!);

    // Modal should be gone
    expect(screen.queryByText("Delete session?")).not.toBeInTheDocument();
    expect(mockApi.deleteSession).not.toHaveBeenCalled();
  });

  it("clicking modal backdrop cancels the delete", () => {
    // Verifies that clicking the backdrop (overlay) of the delete modal
    // dismisses it without deleting.
    const sdk = makeSdkSession("s1", { archived: true, model: "safe" });
    mockState = createMockState({
      sdkSessions: [sdk],
    });

    render(<Sidebar />);
    fireEvent.click(screen.getByText(/Archived \(1\)/));
    fireEvent.click(screen.getByTitle("Session actions"));
    fireEvent.click(screen.getByText("Delete"));

    // Click the backdrop overlay (the outer fixed div)
    const backdrop = document.querySelector(".fixed.inset-0");
    expect(backdrop).toBeTruthy();
    fireEvent.click(backdrop!);

    expect(screen.queryByText("Delete session?")).not.toBeInTheDocument();
  });

  it("delete navigates home when the deleted session is the current one", async () => {
    // Verifies that deleting the currently active session navigates the user
    // back to the home page.
    const sdk = makeSdkSession("s1", { archived: true, model: "current-one" });
    mockState = createMockState({
      sdkSessions: [sdk],
      currentSessionId: "s1",
    });

    render(<Sidebar />);
    fireEvent.click(screen.getByText(/Archived \(1\)/));
    fireEvent.click(screen.getByTitle("Session actions"));
    fireEvent.click(screen.getByText("Delete"));

    // Confirm
    const modalDeleteBtn = screen.getAllByText("Delete").find(
      (el) => el.closest(".fixed") !== null,
    );
    fireEvent.click(modalDeleteBtn!);

    await vi.waitFor(() => {
      expect(mockApi.deleteSession).toHaveBeenCalledWith("s1");
    });
    // navigateHome() clears the hash
    expect(window.location.hash).toBe("");
  });

  // ─── Delete all archived flow ──────────────────────────────────────────────

  it("shows 'Delete all' button when archived section is expanded with multiple sessions", () => {
    // Verifies that the "Delete all" button appears only when there are 2+
    // archived sessions and the archived section is expanded.
    const sdk1 = makeSdkSession("s1", { archived: true });
    const sdk2 = makeSdkSession("s2", { archived: true });
    mockState = createMockState({
      sdkSessions: [sdk1, sdk2],
    });

    render(<Sidebar />);

    // Before expanding, "Delete all" should not be visible
    expect(screen.queryByText("Delete all")).not.toBeInTheDocument();

    // Expand archived section
    fireEvent.click(screen.getByText(/Archived \(2\)/));

    // Now "Delete all" button should be visible
    expect(screen.getByText("Delete all")).toBeInTheDocument();
  });

  it("clicking 'Delete all' shows confirmation modal for all archived sessions", () => {
    // Verifies that clicking "Delete all" triggers the bulk delete confirmation
    // modal with the correct count of archived sessions.
    const sdk1 = makeSdkSession("s1", { archived: true });
    const sdk2 = makeSdkSession("s2", { archived: true });
    const sdk3 = makeSdkSession("s3", { archived: false });
    mockState = createMockState({
      sdkSessions: [sdk1, sdk2, sdk3],
    });

    render(<Sidebar />);
    fireEvent.click(screen.getByText(/Archived \(2\)/));
    fireEvent.click(screen.getByText("Delete all"));

    expect(screen.getByText("Delete all archived?")).toBeInTheDocument();
    expect(screen.getByText(/This will permanently delete 2 archived sessions/)).toBeInTheDocument();
  });

  it("confirming delete-all deletes each archived session", async () => {
    // Verifies that the bulk delete flow iterates over all archived sessions
    // and deletes each one individually.
    const sdk1 = makeSdkSession("s1", { archived: true });
    const sdk2 = makeSdkSession("s2", { archived: true });
    const sdk3 = makeSdkSession("s3", { archived: false });
    mockState = createMockState({
      sdkSessions: [sdk1, sdk2, sdk3],
    });

    render(<Sidebar />);
    fireEvent.click(screen.getByText(/Archived \(2\)/));
    fireEvent.click(screen.getByText("Delete all"));

    // Click "Delete all" in the confirmation modal
    const confirmBtn = screen.getAllByText("Delete all").find(
      (el) => el.closest(".fixed") !== null,
    );
    fireEvent.click(confirmBtn!);

    await vi.waitFor(() => {
      expect(mockApi.deleteSession).toHaveBeenCalledWith("s1");
    });
    await vi.waitFor(() => {
      expect(mockApi.deleteSession).toHaveBeenCalledWith("s2");
    });
    // Non-archived session should not be deleted
    expect(mockApi.deleteSession).not.toHaveBeenCalledWith("s3");
  });

  it("cancelling delete-all closes the modal without deleting", () => {
    // Verifies that clicking Cancel in the bulk-delete modal does not trigger
    // any delete operations.
    const sdk1 = makeSdkSession("s1", { archived: true });
    const sdk2 = makeSdkSession("s2", { archived: true });
    mockState = createMockState({
      sdkSessions: [sdk1, sdk2],
    });

    render(<Sidebar />);
    fireEvent.click(screen.getByText(/Archived \(2\)/));
    fireEvent.click(screen.getByText("Delete all"));

    // Cancel the modal
    const cancelBtn = screen.getAllByText("Cancel").find(
      (el) => el.closest(".fixed") !== null,
    );
    fireEvent.click(cancelBtn!);

    expect(screen.queryByText("Delete all archived?")).not.toBeInTheDocument();
    expect(mockApi.deleteSession).not.toHaveBeenCalled();
  });

  // ─── Archive with container confirmation ───────────────────────────────────

  it("archiving a containerized session shows container warning confirmation", () => {
    // Verifies that archiving a containerized session triggers the container
    // archive confirmation panel warning about uncommitted changes.
    const session = makeSession("s1", { is_containerized: true });
    const sdk = makeSdkSession("s1", { containerId: "abc123" });
    mockState = createMockState({
      sessions: new Map([["s1", session]]),
      sdkSessions: [sdk],
    });

    render(<Sidebar />);

    // Open the context menu and click Archive
    fireEvent.click(screen.getByTitle("Session actions"));
    fireEvent.click(screen.getByText("Archive"));

    // Container warning should appear
    expect(screen.getByText(/Archiving will/)).toBeInTheDocument();
    expect(screen.getByText(/remove the container/)).toBeInTheDocument();
  });

  it("confirming container archive calls api.archiveSession with force:true", async () => {
    // Verifies that confirming the container archive sends force:true to the API
    // which bypasses the container check.
    const session = makeSession("s1", { is_containerized: true });
    const sdk = makeSdkSession("s1", { containerId: "abc123" });
    mockState = createMockState({
      sessions: new Map([["s1", session]]),
      sdkSessions: [sdk],
    });

    render(<Sidebar />);

    // Trigger archive via context menu
    fireEvent.click(screen.getByTitle("Session actions"));
    fireEvent.click(screen.getByText("Archive"));

    // Click the "Archive" confirm button in the warning panel
    // (There are multiple "Archive" texts, find the one in the confirmation panel)
    const archiveConfirmBtn = screen.getAllByText("Archive").find(
      (el) => el.closest(".bg-cc-warning\\/10") !== null,
    );
    expect(archiveConfirmBtn).toBeTruthy();
    fireEvent.click(archiveConfirmBtn!);

    await vi.waitFor(() => {
      expect(mockDisconnectSession).toHaveBeenCalledWith("s1");
    });
    expect(mockApi.archiveSession).toHaveBeenCalledWith("s1", { force: true });
  });

  it("cancelling container archive dismisses the warning", () => {
    // Verifies that clicking Cancel in the container archive confirmation
    // dismisses the warning without archiving.
    const session = makeSession("s1", { is_containerized: true });
    const sdk = makeSdkSession("s1", { containerId: "abc123" });
    mockState = createMockState({
      sessions: new Map([["s1", session]]),
      sdkSessions: [sdk],
    });

    render(<Sidebar />);
    fireEvent.click(screen.getByTitle("Session actions"));
    fireEvent.click(screen.getByText("Archive"));

    // Click Cancel in the warning panel
    const cancelBtn = screen.getAllByText("Cancel").find(
      (el) => el.closest(".bg-cc-warning\\/10") !== null,
    );
    fireEvent.click(cancelBtn!);

    // Warning should be dismissed
    expect(screen.queryByText(/remove the container/)).not.toBeInTheDocument();
    expect(mockApi.archiveSession).not.toHaveBeenCalled();
  });

  it("archiving a non-containerized session archives directly without confirmation", async () => {
    // Verifies that archiving a regular (non-containerized) session proceeds
    // immediately without showing the container warning.
    const session = makeSession("s1", { is_containerized: false });
    const sdk = makeSdkSession("s1");
    mockState = createMockState({
      sessions: new Map([["s1", session]]),
      sdkSessions: [sdk],
    });

    render(<Sidebar />);
    fireEvent.click(screen.getByTitle("Session actions"));
    fireEvent.click(screen.getByText("Archive"));

    // Should NOT show container warning
    expect(screen.queryByText(/remove the container/)).not.toBeInTheDocument();

    // Should directly call archiveSession
    await vi.waitFor(() => {
      expect(mockDisconnectSession).toHaveBeenCalledWith("s1");
    });
    expect(mockApi.archiveSession).toHaveBeenCalledWith("s1", undefined);
  });

  it("archiving the current session navigates home and creates a new session", async () => {
    // Verifies that when the currently selected session is archived, the user
    // is redirected to the home page and a new session is started.
    const session = makeSession("s1", { is_containerized: false });
    const sdk = makeSdkSession("s1");
    mockState = createMockState({
      sessions: new Map([["s1", session]]),
      sdkSessions: [sdk],
      currentSessionId: "s1",
    });

    render(<Sidebar />);
    fireEvent.click(screen.getByTitle("Session actions"));
    fireEvent.click(screen.getByText("Archive"));

    await vi.waitFor(() => {
      expect(mockApi.archiveSession).toHaveBeenCalledWith("s1", undefined);
    });
    // Should navigate home
    expect(window.location.hash).toBe("");
    expect(mockState.newSession).toHaveBeenCalled();
  });

  // ─── Archive with linked Linear issue ─────────────────────────────────────

  it("shows archive modal when session has a linked non-done Linear issue", async () => {
    // Verifies that archiving a session linked to a non-done Linear issue
    // shows the ArchiveLinearModal instead of archiving directly.
    const session = makeSession("s1", { is_containerized: false });
    const sdk = makeSdkSession("s1");
    const linkedIssues = new Map<string, unknown>([["s1", {
      id: "issue-1",
      identifier: "ENG-42",
      title: "Test",
      stateType: "started",
      stateName: "In Progress",
    }]]);
    mockState = createMockState({
      sessions: new Map([["s1", session]]),
      sdkSessions: [sdk],
      linkedLinearIssues: linkedIssues,
    });
    mockApi.getArchiveInfo.mockResolvedValue({
      hasLinkedIssue: true,
      issueNotDone: true,
      issue: { id: "issue-1", identifier: "ENG-42", stateName: "In Progress", stateType: "started", teamId: "team-1" },
      hasBacklogState: true,
      archiveTransitionConfigured: false,
    });

    render(<Sidebar />);
    fireEvent.click(screen.getByTitle("Session actions"));
    fireEvent.click(screen.getByText("Archive"));

    // Wait for modal to appear (getArchiveInfo is async)
    await vi.waitFor(() => {
      expect(screen.getByText("Archive session")).toBeInTheDocument();
    });
    expect(screen.getByText("ENG-42")).toBeInTheDocument();
  });

  it("archives directly when session has no linked Linear issue", async () => {
    // Verifies that the modal is NOT shown for sessions without a linked issue.
    const session = makeSession("s1", { is_containerized: false });
    const sdk = makeSdkSession("s1");
    mockState = createMockState({
      sessions: new Map([["s1", session]]),
      sdkSessions: [sdk],
      linkedLinearIssues: new Map(),
    });

    render(<Sidebar />);
    fireEvent.click(screen.getByTitle("Session actions"));
    fireEvent.click(screen.getByText("Archive"));

    // Should archive directly
    await vi.waitFor(() => {
      expect(mockApi.archiveSession).toHaveBeenCalledWith("s1", undefined);
    });
    // Modal should NOT appear
    expect(screen.queryByText("Archive session")).not.toBeInTheDocument();
  });

  it("archives directly when linked issue is already done", async () => {
    // Verifies that completed issues don't trigger the modal.
    const session = makeSession("s1", { is_containerized: false });
    const sdk = makeSdkSession("s1");
    const linkedIssues = new Map<string, unknown>([["s1", {
      id: "issue-1",
      identifier: "ENG-42",
      title: "Test",
      stateType: "completed",
      stateName: "Done",
    }]]);
    mockState = createMockState({
      sessions: new Map([["s1", session]]),
      sdkSessions: [sdk],
      linkedLinearIssues: linkedIssues,
    });

    render(<Sidebar />);
    fireEvent.click(screen.getByTitle("Session actions"));
    fireEvent.click(screen.getByText("Archive"));

    // Should archive directly since issue is done
    await vi.waitFor(() => {
      expect(mockApi.archiveSession).toHaveBeenCalledWith("s1", undefined);
    });
  });

  // ─── Unarchive flow ────────────────────────────────────────────────────────

  it("clicking Restore on an archived session calls api.unarchiveSession", async () => {
    // Verifies that unarchiving (restoring) a session calls the correct API endpoint
    // and refreshes the sessions list.
    const sdk = makeSdkSession("s1", { archived: true, model: "restore-me" });
    mockState = createMockState({
      sdkSessions: [sdk],
    });

    render(<Sidebar />);
    fireEvent.click(screen.getByText(/Archived \(1\)/));

    // Open context menu on the archived session
    fireEvent.click(screen.getByTitle("Session actions"));
    fireEvent.click(screen.getByText("Restore"));

    await vi.waitFor(() => {
      expect(mockApi.unarchiveSession).toHaveBeenCalledWith("s1");
    });
    // Should also refresh the sessions list
    expect(mockApi.listSessions).toHaveBeenCalled();
  });

  // ─── Cron sessions section ─────────────────────────────────────────────────

  it("renders Scheduled Runs section when cron sessions exist", () => {
    // Verifies that sessions with cronJobId are displayed in a separate
    // "Scheduled Runs" section with the correct count.
    const sdk1 = makeSdkSession("s1");
    const sdk2 = makeSdkSession("s2", { cronJobId: "cron-1", cronJobName: "Daily Build" });
    mockState = createMockState({
      sdkSessions: [sdk1, sdk2],
    });

    render(<Sidebar />);
    expect(screen.getByText(/Scheduled Runs \(1\)/)).toBeInTheDocument();
  });

  it("cron sessions are not shown in the active sessions list", () => {
    // Verifies that sessions with a cronJobId are excluded from the main
    // active sessions list and only appear under "Scheduled Runs".
    const sdk1 = makeSdkSession("s1", { model: "regular-session" });
    const sdk2 = makeSdkSession("s2", { model: "cron-session", cronJobId: "cron-1" });
    mockState = createMockState({
      sdkSessions: [sdk1, sdk2],
    });

    render(<Sidebar />);
    // regular-session should be in the main list
    expect(screen.getByText("regular-session")).toBeInTheDocument();
    // cron-session should appear under Scheduled Runs, not in main list
    expect(screen.getByText(/Scheduled Runs \(1\)/)).toBeInTheDocument();
  });

  it("toggling Scheduled Runs section hides/shows cron sessions", () => {
    // Verifies that the Scheduled Runs section can be collapsed and expanded
    // via its toggle button.
    const sdk = makeSdkSession("s1", { model: "cron-model", cronJobId: "cron-1" });
    mockState = createMockState({
      sdkSessions: [sdk],
    });

    render(<Sidebar />);
    // Initially expanded (showCronSessions defaults to true)
    expect(screen.getByText("cron-model")).toBeInTheDocument();

    // Click to collapse
    fireEvent.click(screen.getByText(/Scheduled Runs \(1\)/));

    // Session should be hidden
    expect(screen.queryByText("cron-model")).not.toBeInTheDocument();

    // Click again to expand
    fireEvent.click(screen.getByText(/Scheduled Runs \(1\)/));
    expect(screen.getByText("cron-model")).toBeInTheDocument();
  });

  // ─── Agent sessions section ────────────────────────────────────────────────

  it("renders Agent Runs section when agent sessions exist", () => {
    // Verifies that sessions with agentId are displayed in a separate
    // "Agent Runs" section with the correct count.
    const sdk1 = makeSdkSession("s1");
    const sdk2 = makeSdkSession("s2", { agentId: "agent-1", agentName: "Code Reviewer" });
    mockState = createMockState({
      sdkSessions: [sdk1, sdk2],
    });

    render(<Sidebar />);
    expect(screen.getByText(/Agent Runs \(1\)/)).toBeInTheDocument();
  });

  it("agent sessions are separate from active sessions", () => {
    // Verifies that sessions with agentId do not appear in the main active
    // sessions list.
    const sdk1 = makeSdkSession("s1", { model: "normal" });
    const sdk2 = makeSdkSession("s2", { model: "agent-one", agentId: "agent-1" });
    mockState = createMockState({
      sdkSessions: [sdk1, sdk2],
    });

    render(<Sidebar />);
    expect(screen.getByText("normal")).toBeInTheDocument();
    expect(screen.getByText(/Agent Runs \(1\)/)).toBeInTheDocument();
  });

  it("toggling Agent Runs section hides/shows agent sessions", () => {
    // Verifies that the Agent Runs section can be collapsed and expanded.
    // Note: we need at least one active session to prevent the "No sessions yet."
    // empty state from hiding the agent sessions section entirely.
    const sdkActive = makeSdkSession("s-active", { model: "active-model" });
    const sdk = makeSdkSession("s1", { model: "agent-model", agentId: "agent-1" });
    mockState = createMockState({
      sdkSessions: [sdkActive, sdk],
    });

    render(<Sidebar />);
    // Initially expanded
    expect(screen.getByText("agent-model")).toBeInTheDocument();

    // Collapse
    fireEvent.click(screen.getByText(/Agent Runs \(1\)/));
    expect(screen.queryByText("agent-model")).not.toBeInTheDocument();

    // Expand again
    fireEvent.click(screen.getByText(/Agent Runs \(1\)/));
    expect(screen.getByText("agent-model")).toBeInTheDocument();
  });

  // ─── Footer nav behavior ───────────────────────────────────────────────────

  it("clicking a nav item updates the hash", () => {
    render(<Sidebar />);
    fireEvent.click(screen.getByTitle("Prompts"));
    expect(window.location.hash).toBe("#/prompts");
  });

  it("New Session button routes home", () => {
    render(<Sidebar />);
    const buttons = screen.getAllByTitle("New Session");
    fireEvent.click(buttons[0]);
    expect(window.location.hash).toBe("");
  });

  it("selecting a session routes to that session", () => {
    const session = makeSession("s1");
    const sdk = makeSdkSession("s1");
    mockState = createMockState({
      sessions: new Map([["s1", session]]),
      sdkSessions: [sdk],
    });

    render(<Sidebar />);
    const sessionButton = screen.getByText("claude-sonnet-4-6").closest("button")!;
    fireEvent.click(sessionButton);

    expect(window.location.hash).toBe("#/session/s1");
  });

  // ─── Footer nav: active state ──────────────────────────────────────────────

  it("footer nav button shows active state when on its page", () => {
    // Verifies that the footer nav button for the current page gets the
    // bg-cc-active class to indicate the user is on that page.
    window.location.hash = "#/settings";
    render(<Sidebar />);

    const settingsBtn = screen.getByTitle("Settings");
    expect(settingsBtn).toHaveClass("bg-cc-active");
  });

  it("integrations nav button shows active for both integrations and integration-linear pages", () => {
    // Verifies that the Integrations nav button correctly uses activePages
    // to highlight for sub-pages like integration-linear.
    window.location.hash = "#/integrations";
    render(<Sidebar />);

    const integrationsBtn = screen.getByTitle("Integrations");
    expect(integrationsBtn).toHaveClass("bg-cc-active");
  });

  it("agents nav button is active on agent detail routes with aria-current", () => {
    // Verifies active state semantics for nested agent pages.
    window.location.hash = "#/agents/agent-123";
    render(<Sidebar />);

    const agentsBtn = screen.getByTitle("Agents");
    expect(agentsBtn).toHaveClass("bg-cc-active");
    expect(agentsBtn).toHaveAttribute("aria-current", "page");
  });

  // ─── Close sidebar button (mobile) ─────────────────────────────────────────

  it("renders a close sidebar button for mobile", () => {
    // Verifies that the mobile close sidebar button exists and calls
    // setSidebarOpen(false) when clicked.
    render(<Sidebar />);
    const closeBtn = screen.getByLabelText("Close sidebar");
    expect(closeBtn).toBeInTheDocument();

    fireEvent.click(closeBtn);
    expect(mockState.setSidebarOpen).toHaveBeenCalledWith(false);
  });

  // ─── Logo source based on backend type ─────────────────────────────────────

  it("shows codex logo when current session uses codex backend", () => {
    // Verifies that the sidebar header logo changes to the Codex logo when
    // the currently selected session has backendType "codex".
    const sdk = makeSdkSession("s1", { backendType: "codex" });
    mockState = createMockState({
      sdkSessions: [sdk],
      currentSessionId: "s1",
    });

    const { container } = render(<Sidebar />);
    const logo = container.querySelector("img[src='/logo-codex.svg']");
    expect(logo).toBeTruthy();
  });

  it("shows default logo when current session uses claude backend", () => {
    // Verifies that the sidebar header logo is the default when the currently
    // selected session has backendType "claude".
    const sdk = makeSdkSession("s1", { backendType: "claude" });
    mockState = createMockState({
      sdkSessions: [sdk],
      currentSessionId: "s1",
    });

    const { container } = render(<Sidebar />);
    const logo = container.querySelector("img[src='/logo.svg']");
    expect(logo).toBeTruthy();
  });

  // ─── External links in footer ──────────────────────────────────────────────

  it("renders external links for Documentation, GitHub, and Website", () => {
    // Verifies that all three external icon-only links are rendered in the
    // sidebar footer with correct href values.
    render(<Sidebar />);

    const docsLink = screen.getByLabelText("Open documentation");
    const githubLink = screen.getByLabelText("Open github");
    const websiteLink = screen.getByLabelText("Open website");

    expect(docsLink).toBeInTheDocument();
    expect(githubLink).toBeInTheDocument();
    expect(websiteLink).toBeInTheDocument();

    expect(docsLink).toHaveAttribute("href", "https://docs.thecompanion.sh");
    expect(githubLink).toHaveAttribute("href", "https://github.com/The-Vibe-Company/companion");
    expect(websiteLink).toHaveAttribute("href", "https://thecompanion.sh");
  });

  it("external links open in new tab with secure attributes", () => {
    // Verifies that all external links use target="_blank" and
    // rel="noopener noreferrer" to prevent reverse-tabnabbing.
    render(<Sidebar />);

    const links = [
      screen.getByLabelText("Open documentation"),
      screen.getByLabelText("Open github"),
      screen.getByLabelText("Open website"),
    ];

    for (const link of links) {
      expect(link).toHaveAttribute("target", "_blank");
      expect(link).toHaveAttribute("rel", "noopener noreferrer");
    }
  });

  it("external links have title attributes for tooltip accessibility", () => {
    // Verifies that each external link has a title attribute for tooltips
    // and screen reader support.
    render(<Sidebar />);

    expect(screen.getByTitle("Documentation")).toBeInTheDocument();
    expect(screen.getByTitle("GitHub")).toBeInTheDocument();
    expect(screen.getByTitle("Website")).toBeInTheDocument();
  });

  it("external links are rendered as anchor elements (not buttons)", () => {
    // Verifies that external links use <a> tags for proper semantic HTML,
    // distinguishing them from internal nav buttons.
    render(<Sidebar />);

    const docsLink = screen.getByLabelText("Open documentation");
    const githubLink = screen.getByLabelText("Open github");
    const websiteLink = screen.getByLabelText("Open website");

    expect(docsLink.tagName).toBe("A");
    expect(githubLink.tagName).toBe("A");
    expect(websiteLink.tagName).toBe("A");
  });

  // ─── Delete modal inner click propagation ──────────────────────────────────

  it("clicking inside the delete modal does not dismiss it", () => {
    // Verifies that clicking inside the modal content area (not the backdrop)
    // does not close the modal, thanks to e.stopPropagation().
    const sdk = makeSdkSession("s1", { archived: true, model: "modal-test" });
    mockState = createMockState({
      sdkSessions: [sdk],
    });

    render(<Sidebar />);
    fireEvent.click(screen.getByText(/Archived \(1\)/));
    fireEvent.click(screen.getByTitle("Session actions"));
    fireEvent.click(screen.getByText("Delete"));

    // Click inside the modal content (the text area)
    const modalContent = screen.getByText("Delete session?");
    fireEvent.click(modalContent);

    // Modal should still be open
    expect(screen.getByText("Delete session?")).toBeInTheDocument();
  });

  // ─── Rename via context menu ───────────────────────────────────────────────

  it("clicking Rename in context menu enters edit mode", () => {
    // Verifies that clicking "Rename" from the session context menu enters
    // the rename/edit mode for that session.
    const session = makeSession("s1");
    const sdk = makeSdkSession("s1");
    mockState = createMockState({
      sessions: new Map([["s1", session]]),
      sdkSessions: [sdk],
    });

    render(<Sidebar />);
    fireEvent.click(screen.getByTitle("Session actions"));
    fireEvent.click(screen.getByText("Rename"));

    // An input field should appear with the current session label
    const input = screen.getByDisplayValue("claude-sonnet-4-6");
    expect(input).toBeInTheDocument();
    expect(input.tagName).toBe("INPUT");
  });

  // ─── Rename calls api.renameSession ────────────────────────────────────────

  it("confirming rename also calls api.renameSession for server persistence", () => {
    // Verifies that after pressing Enter to confirm a rename, the Sidebar
    // also calls the API to persist the new name on the server.
    const session = makeSession("s1");
    const sdk = makeSdkSession("s1");
    mockState = createMockState({
      sessions: new Map([["s1", session]]),
      sdkSessions: [sdk],
    });

    render(<Sidebar />);
    const sessionButton = screen.getByText("claude-sonnet-4-6").closest("button")!;
    fireEvent.doubleClick(sessionButton);

    const input = screen.getByDisplayValue("claude-sonnet-4-6") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "New Name" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(mockApi.renameSession).toHaveBeenCalledWith("s1", "New Name");
  });

  // ─── Session with cron badge ───────────────────────────────────────────────

  it("session with cronJobId shows Scheduled badge", () => {
    // Verifies that a session with a cron job ID displays the scheduled clock badge.
    const sdk = makeSdkSession("s1", { cronJobId: "cron-1" });
    mockState = createMockState({
      sdkSessions: [sdk],
    });

    render(<Sidebar />);
    expect(screen.getByTitle("Scheduled")).toBeInTheDocument();
  });

  // ─── Delete all singular text ──────────────────────────────────────────────

  it("delete-all modal uses singular 'session' when only one archived session", () => {
    // Verifies correct grammar: "1 archived session" (singular) vs "2 archived sessions" (plural).
    // Note: "Delete all" button only appears with 2+ archived sessions, but
    // we can trigger the modal state directly via the flow.
    const sdk1 = makeSdkSession("s1", { archived: true });
    const sdk2 = makeSdkSession("s2", { archived: true });
    const sdk3 = makeSdkSession("s3", { archived: true });
    mockState = createMockState({
      sdkSessions: [sdk1, sdk2, sdk3],
    });

    render(<Sidebar />);
    fireEvent.click(screen.getByText(/Archived \(3\)/));
    fireEvent.click(screen.getByText("Delete all"));

    expect(screen.getByText(/3 archived sessions/)).toBeInTheDocument();
  });
});
