// @vitest-environment jsdom
/**
 * Tests for TopBar component.
 *
 * Validates:
 * - Diff badge rendering based on changed files count
 * - Tab cycling with Cmd/Ctrl+J across chat/diff/environment tabs
 * - Active tab visual indicator (underline)
 * - Tab accessibility names
 * - Chat tab re-entry tracking
 * - Axe accessibility scan
 */
import { fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";

vi.mock("../api.js", () => ({
  api: {
    relaunchSession: vi.fn().mockResolvedValue({ ok: true }),
  },
}));

vi.mock("../ws.js", () => ({
  sendToSession: vi.fn(),
}));

interface MockStoreState {
  currentSessionId: string | null;
  cliConnected: Map<string, boolean>;
  sessionStatus: Map<string, "idle" | "running" | "compacting" | null>;
  sessionNames: Map<string, string>;
  sidebarOpen: boolean;
  setSidebarOpen: ReturnType<typeof vi.fn>;
  taskPanelOpen: boolean;
  setTaskPanelOpen: ReturnType<typeof vi.fn>;
  activeTab: "chat" | "diff" | "environment";
  setActiveTab: ReturnType<typeof vi.fn>;
  markChatTabReentry: ReturnType<typeof vi.fn>;
  sessions: Map<string, { cwd?: string; is_containerized?: boolean }>;
  sdkSessions: { sessionId: string; cwd?: string; containerId?: string; model?: string; backendType?: string }[];
  gitChangedFilesCount: Map<string, number>;
  portStatuses: Map<string, unknown[]>;
}

let storeState: MockStoreState;

function resetStore(overrides: Partial<MockStoreState> = {}) {
  storeState = {
    currentSessionId: "s1",
    cliConnected: new Map([["s1", true]]),
    sessionStatus: new Map([["s1", "idle"]]),
    sessionNames: new Map(),
    sidebarOpen: true,
    setSidebarOpen: vi.fn(),
    taskPanelOpen: false,
    setTaskPanelOpen: vi.fn(),
    activeTab: "chat",
    setActiveTab: vi.fn(),
    markChatTabReentry: vi.fn(),
    sessions: new Map([["s1", { cwd: "/repo" }]]),
    sdkSessions: [],
    gitChangedFilesCount: new Map(),
    portStatuses: new Map(),
    ...overrides,
  };
}

vi.mock("../store.js", () => ({
  useStore: Object.assign(
    (selector: (s: MockStoreState) => unknown) => selector(storeState),
    {
      getState: () => ({ ...storeState, setSdkSessions: vi.fn() }),
    },
  ),
}));

import { TopBar } from "./TopBar.js";

beforeEach(() => {
  vi.clearAllMocks();
  resetStore();
  window.localStorage.clear();
});

describe("TopBar", () => {
  it("shows diff badge count only for files within cwd", () => {
    // gitChangedFilesCount is set by DiffPanel after filtering to cwd scope
    resetStore({
      gitChangedFilesCount: new Map([["s1", 2]]),
    });

    render(<TopBar />);
    expect(screen.getByText("2")).toBeInTheDocument();
    expect(screen.queryByText("3")).not.toBeInTheDocument();
  });

  it("uses theme-safe classes for the diff badge in dark mode", () => {
    resetStore({
      gitChangedFilesCount: new Map([["s1", 1]]),
    });
    render(<TopBar />);
    const badge = screen.getByText("1");
    // Badge uses amber Tailwind utilities, not semantic cc-warning token.
    expect(badge.className).toContain("bg-amber-100");
    expect(badge.className).toContain("dark:bg-amber-900/60");
    expect(badge.className).not.toContain("bg-cc-warning");
  });

  it("hides diff badge when no changed files", () => {
    // gitChangedFilesCount not set (or 0) → no badge
    render(<TopBar />);
    expect(screen.queryByText("1")).not.toBeInTheDocument();
  });

  it("keeps terminal session alive when switching back to the session tab", () => {
    // Switching from any tab back to chat should mark re-entry
    resetStore({ activeTab: "diff" });
    render(<TopBar />);

    fireEvent.click(screen.getByRole("button", { name: "Session tab" }));
    expect(storeState.markChatTabReentry).toHaveBeenCalledWith("s1");
    expect(storeState.setActiveTab).toHaveBeenCalledWith("chat");
  });

  it("cycles to the next workspace tab on Cmd/Ctrl+J", () => {
    // Tabs: chat, diff, environment — from chat, Cmd+J goes to diff
    render(<TopBar />);

    fireEvent.keyDown(window, { key: "j", metaKey: true });
    expect(storeState.setActiveTab).toHaveBeenCalledWith("diff");
  });

  it("cycles from diff to environment on Cmd+J", () => {
    // From diff, Cmd+J should go to environment
    resetStore({ activeTab: "diff" });
    render(<TopBar />);

    fireEvent.keyDown(window, { key: "j", metaKey: true });
    expect(storeState.setActiveTab).toHaveBeenCalledWith("environment");
  });

  it("cycles from environment back to chat on Cmd+J", () => {
    // From environment, Cmd+J wraps back to chat
    resetStore({ activeTab: "environment" });
    render(<TopBar />);

    fireEvent.keyDown(window, { key: "j", metaKey: true });
    expect(storeState.setActiveTab).toHaveBeenCalledWith("chat");
  });

  it("marks the active tab with a primary underline indicator", () => {
    // Flat underline tabs: the active tab gets border-cc-primary, inactive tabs get border-transparent.
    resetStore({ activeTab: "diff" });
    render(<TopBar />);

    const diffTab = screen.getByRole("button", { name: "Diffs tab" });
    const chatTab = screen.getByRole("button", { name: "Session tab" });

    expect(diffTab.className).toContain("border-cc-primary");
    expect(diffTab.className).toContain("text-cc-fg");
    expect(chatTab.className).toContain("border-transparent");
    expect(chatTab.className).toContain("text-cc-muted");
  });

  it("tab buttons have accessible names", () => {
    // Verifies all workspace tabs are identifiable by assistive technology.
    // Only 3 tabs remain: Session, Diffs, Environment
    render(<TopBar />);
    expect(screen.getByRole("button", { name: "Session tab" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Diffs tab" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Environment tab" })).toBeInTheDocument();
  });

  it("passes axe accessibility checks", async () => {
    const { axe } = await import("vitest-axe");
    resetStore();
    const { container } = render(<TopBar />);
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});
