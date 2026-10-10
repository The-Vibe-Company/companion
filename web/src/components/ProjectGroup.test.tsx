// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import { createRef } from "react";
import type { ProjectGroup as ProjectGroupType } from "../utils/project-grouping.js";
import type { SessionItem as SessionItemType } from "../utils/project-grouping.js";

// Mock SessionItem to avoid pulling in its full dependency tree
vi.mock("./SessionItem.js", () => ({
  SessionItem: ({ session, isActive }: { session: SessionItemType; isActive: boolean }) => (
    <div data-testid={`session-${session.id}`} data-active={isActive}>
      {session.id}
    </div>
  ),
}));

import { ProjectGroup } from "./ProjectGroup.js";

// ─── Test Helpers ────────────────────────────────────────────────────────────

function makeSession(overrides: Partial<SessionItemType> = {}): SessionItemType {
  return {
    id: "sess-1",
    model: "claude-sonnet-4-6",
    cwd: "/workspace/project",
    gitBranch: "main",
    isContainerized: false,
    gitAhead: 0,
    gitBehind: 0,
    linesAdded: 0,
    linesRemoved: 0,
    isConnected: true,
    isReconnecting: false,
    status: "idle",
    sdkState: "connected",
    createdAt: Date.now(),
    archived: false,
    backendType: "claude",
    repoRoot: "/workspace/project",
    permCount: 0,
    ...overrides,
  };
}

function makeGroup(overrides: Partial<ProjectGroupType> = {}): ProjectGroupType {
  return {
    key: "project",
    label: "My Project",
    sessions: [makeSession({ id: "s1" }), makeSession({ id: "s2" })],
    runningCount: 0,
    permCount: 0,
    mostRecentActivity: Date.now(),
    ...overrides,
  };
}

function makeProps(overrides: Partial<Parameters<typeof ProjectGroup>[0]> = {}) {
  return {
    group: makeGroup(),
    isCollapsed: false,
    onToggleCollapse: vi.fn(),
    currentSessionId: null,
    sessionNames: new Map<string, string>([["s1", "Session One"], ["s2", "Session Two"]]),
    pendingPermissions: new Map<string, Map<string, unknown>>(),
    recentlyRenamed: new Set<string>(),
    onSelect: vi.fn(),
    onStartRename: vi.fn(),
    onArchive: vi.fn(),
    onUnarchive: vi.fn(),
    onDelete: vi.fn(),
    onClearRecentlyRenamed: vi.fn(),
    editingSessionId: null,
    editingName: "",
    setEditingName: vi.fn(),
    onConfirmRename: vi.fn(),
    onCancelRename: vi.fn(),
    editInputRef: createRef<HTMLInputElement>(),
    isFirst: true,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("ProjectGroup", () => {
  // ── Render Tests ──────────────────────────────────────────────────────────

  // Test 1: Renders group label
  it("renders the group label in uppercase", () => {
    render(<ProjectGroup {...makeProps()} />);
    expect(screen.getByText("My Project")).toBeInTheDocument();
  });

  // Test 2: Renders session count badge
  it("renders the session count badge", () => {
    render(<ProjectGroup {...makeProps()} />);
    expect(screen.getByText("2")).toBeInTheDocument();
  });

  // Test 3: Renders session items when expanded
  it("renders session items when not collapsed", () => {
    render(<ProjectGroup {...makeProps()} />);
    expect(screen.getByTestId("session-s1")).toBeInTheDocument();
    expect(screen.getByTestId("session-s2")).toBeInTheDocument();
  });

  // Test 4: Hides session items when collapsed
  it("hides session items when collapsed", () => {
    render(<ProjectGroup {...makeProps({ isCollapsed: true })} />);
    expect(screen.queryByTestId("session-s1")).not.toBeInTheDocument();
    expect(screen.queryByTestId("session-s2")).not.toBeInTheDocument();
  });

  // Test 5: Shows collapsed preview text
  it("shows collapsed preview with first 2 session names", () => {
    render(<ProjectGroup {...makeProps({ isCollapsed: true })} />);
    expect(screen.getByText("Session One, Session Two")).toBeInTheDocument();
  });

  // Test 6: Collapsed preview shows ellipsis for 3+ sessions
  it("shows ellipsis in collapsed preview when more than 2 sessions", () => {
    const group = makeGroup({
      sessions: [
        makeSession({ id: "s1" }),
        makeSession({ id: "s2" }),
        makeSession({ id: "s3" }),
      ],
    });
    const names = new Map([["s1", "A"], ["s2", "B"], ["s3", "C"]]);
    render(<ProjectGroup {...makeProps({ group, sessionNames: names, isCollapsed: true })} />);
    expect(screen.getByText("A, B, ...")).toBeInTheDocument();
  });

  // ── Status Indicators ─────────────────────────────────────────────────────

  // Test 7: Shows green dot when there are running sessions
  it("shows running status dot when runningCount > 0", () => {
    const group = makeGroup({ runningCount: 2 });
    const { container } = render(<ProjectGroup {...makeProps({ group })} />);
    const dot = container.querySelector(".bg-cc-success");
    expect(dot).toBeInTheDocument();
    expect(dot).toHaveAttribute("title", "2 running");
  });

  // Test 8: Shows warning dot when there are pending permissions
  it("shows permission status dot when permCount > 0", () => {
    const group = makeGroup({ permCount: 1 });
    const { container } = render(<ProjectGroup {...makeProps({ group })} />);
    const dot = container.querySelector(".bg-cc-warning");
    expect(dot).toBeInTheDocument();
    expect(dot).toHaveAttribute("title", "1 waiting");
  });

  // Test 9: No status dots when counts are 0
  it("does not show status dots when no running/perm sessions", () => {
    const { container } = render(<ProjectGroup {...makeProps()} />);
    expect(container.querySelector(".bg-cc-success")).not.toBeInTheDocument();
    expect(container.querySelector(".bg-cc-warning")).not.toBeInTheDocument();
  });

  // ── Interaction ───────────────────────────────────────────────────────────

  // Test 10: Clicking the header calls onToggleCollapse with the group key
  it("clicking header calls onToggleCollapse with group key", () => {
    const props = makeProps();
    render(<ProjectGroup {...props} />);
    const button = screen.getByRole("button");
    fireEvent.click(button);
    expect(props.onToggleCollapse).toHaveBeenCalledWith("project");
  });

  // Test 11: Header button has correct aria-expanded when expanded
  it("has aria-expanded=true when not collapsed", () => {
    render(<ProjectGroup {...makeProps({ isCollapsed: false })} />);
    const button = screen.getByRole("button");
    expect(button).toHaveAttribute("aria-expanded", "true");
  });

  // Test 12: Header button has correct aria-expanded when collapsed
  it("has aria-expanded=false when collapsed", () => {
    render(<ProjectGroup {...makeProps({ isCollapsed: true })} />);
    const button = screen.getByRole("button");
    expect(button).toHaveAttribute("aria-expanded", "false");
  });

  // ── Styling ───────────────────────────────────────────────────────────────

  // Test 13: First group has no top border
  it("first group has no top border separator", () => {
    const { container } = render(<ProjectGroup {...makeProps({ isFirst: true })} />);
    const wrapper = container.firstElementChild;
    expect(wrapper?.className).not.toContain("border-t");
  });

  // Test 14: Non-first group has top border
  it("non-first group has top border separator", () => {
    const { container } = render(<ProjectGroup {...makeProps({ isFirst: false })} />);
    const wrapper = container.firstElementChild;
    expect(wrapper?.className).toContain("border-t");
    expect(wrapper?.className).toContain("mt-3");
  });

  // ── Accessibility ─────────────────────────────────────────────────────────

  // Test 15: Accessibility scan — expanded state
  it("passes axe accessibility checks when expanded", async () => {
    const { axe } = await import("vitest-axe");
    const { container } = render(<ProjectGroup {...makeProps()} />);
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  // Test 16: Accessibility scan — collapsed state
  it("passes axe accessibility checks when collapsed", async () => {
    const { axe } = await import("vitest-axe");
    const { container } = render(<ProjectGroup {...makeProps({ isCollapsed: true })} />);
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});
