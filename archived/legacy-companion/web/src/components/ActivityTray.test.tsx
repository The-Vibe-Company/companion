// @vitest-environment jsdom
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import type { TaskItem, BackgroundAgentItem } from "../types.js";

// ─── Mock store ─────────────────────────────────────────────────────────────

interface MockStoreState {
  sessionTasks: Map<string, TaskItem[]>;
  sessionBackgroundAgents: Map<string, BackgroundAgentItem[]>;
}

let mockState: MockStoreState;

function resetStore(overrides: Partial<MockStoreState> = {}) {
  mockState = {
    sessionTasks: new Map(),
    sessionBackgroundAgents: new Map(),
    ...overrides,
  };
}

vi.mock("../store.js", () => ({
  useStore: Object.assign(
    (selector: (s: MockStoreState) => unknown) => selector(mockState),
    { getState: () => mockState },
  ),
}));

import { ActivityTray } from "./ActivityTray.js";

beforeEach(() => {
  vi.clearAllMocks();
  resetStore();
});

// ─── Rendering ──────────────────────────────────────────────────────────────

describe("ActivityTray", () => {
  it("renders nothing when there are no tasks or agents", () => {
    const { container } = render(<ActivityTray sessionId="s1" />);
    expect(container.firstChild).toBeNull();
  });

  it("renders pill with task count when tasks exist", () => {
    resetStore({
      sessionTasks: new Map([
        ["s1", [
          { id: "1", subject: "Fix bug", description: "", status: "completed" },
          { id: "2", subject: "Write tests", description: "", status: "in_progress", activeForm: "Writing tests" },
          { id: "3", subject: "Deploy", description: "", status: "pending" },
        ]],
      ]),
    });
    render(<ActivityTray sessionId="s1" />);
    // Should show completed/total count (1/3)
    expect(screen.getByText("1/3")).toBeInTheDocument();
  });

  it("renders pill with running agent count", () => {
    resetStore({
      sessionBackgroundAgents: new Map([
        ["s1", [
          {
            toolUseId: "t1",
            name: "Explore codebase",
            description: "Exploring the codebase",
            agentType: "Explore",
            status: "running",
            startedAt: Date.now() - 5000,
          },
        ]],
      ]),
    });
    render(<ActivityTray sessionId="s1" />);
    expect(screen.getByText("1 agent")).toBeInTheDocument();
  });

  it("shows both agent and task counts with separator", () => {
    resetStore({
      sessionBackgroundAgents: new Map([
        ["s1", [
          { toolUseId: "t1", name: "Research", description: "", agentType: "Explore", status: "running", startedAt: Date.now() },
          { toolUseId: "t2", name: "Build", description: "", agentType: "general-purpose", status: "running", startedAt: Date.now() },
        ]],
      ]),
      sessionTasks: new Map([
        ["s1", [
          { id: "1", subject: "Task A", description: "", status: "completed" },
          { id: "2", subject: "Task B", description: "", status: "pending" },
        ]],
      ]),
    });
    render(<ActivityTray sessionId="s1" />);
    expect(screen.getByText("2 agents")).toBeInTheDocument();
    expect(screen.getByText("1/2")).toBeInTheDocument();
  });

  it("expands panel when pill is clicked", () => {
    resetStore({
      sessionTasks: new Map([
        ["s1", [
          { id: "1", subject: "Fix layout", description: "", status: "in_progress", activeForm: "Fixing layout" },
        ]],
      ]),
    });
    render(<ActivityTray sessionId="s1" />);

    const pill = screen.getByRole("button", { name: /activity/i });
    fireEvent.click(pill);

    // Expanded panel renders with dialog role
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText("Fix layout")).toBeInTheDocument();
  });

  it("shows agent details in expanded panel", () => {
    resetStore({
      sessionBackgroundAgents: new Map([
        ["s1", [
          {
            toolUseId: "t1",
            name: "Explore codebase",
            description: "Searching for patterns",
            agentType: "Explore",
            status: "completed",
            startedAt: Date.now() - 10000,
            completedAt: Date.now(),
            summary: "Found 3 matching files in src/components",
          },
        ]],
      ]),
    });
    render(<ActivityTray sessionId="s1" />);

    const pill = screen.getByRole("button", { name: /activity/i });
    fireEvent.click(pill);

    expect(screen.getByText("Explore codebase")).toBeInTheDocument();
    // Agent type badge is also rendered (CSS uppercase but DOM text matches input)
    const exploreTexts = screen.getAllByText("Explore");
    expect(exploreTexts.length).toBeGreaterThanOrEqual(1);
  });

  it("shows active form text for in-progress tasks", () => {
    resetStore({
      sessionTasks: new Map([
        ["s1", [
          { id: "1", subject: "Run tests", description: "", status: "in_progress", activeForm: "Running test suite" },
        ]],
      ]),
    });
    render(<ActivityTray sessionId="s1" />);

    const pill = screen.getByRole("button", { name: /activity/i });
    fireEvent.click(pill);

    expect(screen.getByText("Run tests")).toBeInTheDocument();
    expect(screen.getByText("Running test suite")).toBeInTheDocument();
  });

  it("closes expanded panel when close button is clicked", () => {
    resetStore({
      sessionTasks: new Map([
        ["s1", [{ id: "1", subject: "Task A", description: "", status: "pending" }]],
      ]),
    });
    render(<ActivityTray sessionId="s1" />);

    // Expand
    fireEvent.click(screen.getByRole("button", { name: /activity/i }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    // Close via the X button
    fireEvent.click(screen.getByRole("button", { name: /close/i }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("shows green pill indicator when all work is done", () => {
    resetStore({
      sessionTasks: new Map([
        ["s1", [
          { id: "1", subject: "Done task", description: "", status: "completed" },
        ]],
      ]),
      sessionBackgroundAgents: new Map([
        ["s1", [
          { toolUseId: "t1", name: "Agent", description: "", agentType: "Explore", status: "completed", startedAt: Date.now() - 5000, completedAt: Date.now() },
        ]],
      ]),
    });
    render(<ActivityTray sessionId="s1" />);
    // Should show "1 done" for agents
    expect(screen.getByText("1 done")).toBeInTheDocument();
  });

  it("shows amber pulsing indicator when work is running", () => {
    resetStore({
      sessionBackgroundAgents: new Map([
        ["s1", [
          { toolUseId: "t1", name: "Agent", description: "", agentType: "Explore", status: "running", startedAt: Date.now() },
        ]],
      ]),
    });
    const { container } = render(<ActivityTray sessionId="s1" />);
    const pingDot = container.querySelector(".animate-ping");
    expect(pingDot).not.toBeNull();
  });
});

// ─── Keyboard navigation (C1 fix) ──────────────────────────────────────────

describe("ActivityTray - keyboard", () => {
  it("closes panel on Escape key", () => {
    resetStore({
      sessionTasks: new Map([
        ["s1", [{ id: "1", subject: "Task", description: "", status: "pending" }]],
      ]),
    });
    render(<ActivityTray sessionId="s1" />);

    // Expand
    fireEvent.click(screen.getByRole("button", { name: /activity/i }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    // Press Escape
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});

// ─── ARIA attributes (H1 fix) ──────────────────────────────────────────────

describe("ActivityTray - ARIA", () => {
  it("pill has aria-expanded and aria-controls", () => {
    resetStore({
      sessionTasks: new Map([
        ["s1", [{ id: "1", subject: "Task", description: "", status: "pending" }]],
      ]),
    });
    render(<ActivityTray sessionId="s1" />);

    const pill = screen.getByRole("button", { name: /activity/i });
    expect(pill).toHaveAttribute("aria-expanded", "false");
    expect(pill).toHaveAttribute("aria-controls", "activity-tray-panel");

    fireEvent.click(pill);
    expect(pill).toHaveAttribute("aria-expanded", "true");
  });

  it("expanded panel has role=dialog and aria-label", () => {
    resetStore({
      sessionTasks: new Map([
        ["s1", [{ id: "1", subject: "Task", description: "", status: "pending" }]],
      ]),
    });
    render(<ActivityTray sessionId="s1" />);

    fireEvent.click(screen.getByRole("button", { name: /activity/i }));
    const panel = screen.getByRole("dialog");
    expect(panel).toHaveAttribute("aria-label", "Activity panel");
    expect(panel).toHaveAttribute("id", "activity-tray-panel");
  });

  it("section headers have heading roles", () => {
    resetStore({
      sessionBackgroundAgents: new Map([
        ["s1", [{ toolUseId: "t1", name: "A", description: "", agentType: "Explore", status: "running", startedAt: Date.now() }]],
      ]),
      sessionTasks: new Map([
        ["s1", [{ id: "1", subject: "T", description: "", status: "pending" }]],
      ]),
    });
    render(<ActivityTray sessionId="s1" />);
    fireEvent.click(screen.getByRole("button", { name: /activity/i }));

    // "Activity" is heading level 3, "Agents" and "Tasks" are level 4
    const headings = screen.getAllByRole("heading");
    expect(headings.length).toBeGreaterThanOrEqual(3);
  });

  it("separator has role=separator", () => {
    resetStore({
      sessionBackgroundAgents: new Map([
        ["s1", [{ toolUseId: "t1", name: "A", description: "", agentType: "Explore", status: "running", startedAt: Date.now() }]],
      ]),
      sessionTasks: new Map([
        ["s1", [{ id: "1", subject: "T", description: "", status: "pending" }]],
      ]),
    });
    render(<ActivityTray sessionId="s1" />);
    fireEvent.click(screen.getByRole("button", { name: /activity/i }));

    expect(screen.getByRole("separator")).toBeInTheDocument();
  });
});

// ─── AgentRow conditional interactivity (H3 fix) ────────────────────────────

describe("ActivityTray - AgentRow", () => {
  it("renders non-clickable div when agent has no summary", () => {
    resetStore({
      sessionBackgroundAgents: new Map([
        ["s1", [{ toolUseId: "t1", name: "Running agent", description: "", agentType: "Explore", status: "running", startedAt: Date.now() }]],
      ]),
    });
    render(<ActivityTray sessionId="s1" />);
    fireEvent.click(screen.getByRole("button", { name: /activity/i }));

    // Agent name should be visible but NOT inside a nested button (only the close and pill buttons exist)
    expect(screen.getByText("Running agent")).toBeInTheDocument();
    // The dialog contains: close button. The pill button is outside dialog.
    // No expand button should exist for an agent without summary.
    const dialogButtons = screen.getByRole("dialog").querySelectorAll("button");
    expect(dialogButtons.length).toBe(1); // only close button
  });

  it("renders clickable button with aria-expanded when agent has summary", () => {
    resetStore({
      sessionBackgroundAgents: new Map([
        ["s1", [{
          toolUseId: "t1",
          name: "Done agent",
          description: "",
          agentType: "Explore",
          status: "completed",
          startedAt: Date.now() - 5000,
          completedAt: Date.now(),
          summary: "Found 3 files",
        }]],
      ]),
    });
    render(<ActivityTray sessionId="s1" />);
    fireEvent.click(screen.getByRole("button", { name: /activity/i }));

    // Now there should be a button for the agent row (close + agent row = 2 buttons in dialog)
    const dialogButtons = screen.getByRole("dialog").querySelectorAll("button");
    expect(dialogButtons.length).toBe(2);

    // The agent row button has aria-expanded
    const agentBtn = dialogButtons[1];
    expect(agentBtn).toHaveAttribute("aria-expanded", "false");
  });
});

// ─── Design tokens (H2 fix) ────────────────────────────────────────────────

describe("ActivityTray - design tokens", () => {
  it("uses cc-warning token for running status instead of amber-400", () => {
    resetStore({
      sessionBackgroundAgents: new Map([
        ["s1", [{ toolUseId: "t1", name: "A", description: "", agentType: "Explore", status: "running", startedAt: Date.now() }]],
      ]),
    });
    const { container } = render(<ActivityTray sessionId="s1" />);
    const html = container.innerHTML;
    // Should use cc-warning tokens, not hard-coded amber
    expect(html).not.toContain("amber-400");
    expect(html).toContain("cc-warning");
  });

  it("uses cc-success token for completed status instead of emerald-400", () => {
    resetStore({
      sessionTasks: new Map([
        ["s1", [{ id: "1", subject: "Done", description: "", status: "completed" }]],
      ]),
      sessionBackgroundAgents: new Map([
        ["s1", [{ toolUseId: "t1", name: "A", description: "", agentType: "Explore", status: "completed", startedAt: Date.now() - 5000, completedAt: Date.now() }]],
      ]),
    });
    const { container } = render(<ActivityTray sessionId="s1" />);
    const html = container.innerHTML;
    expect(html).not.toContain("emerald-400");
    expect(html).toContain("cc-success");
  });
});

// ─── Accessibility ──────────────────────────────────────────────────────────

describe("ActivityTray - axe accessibility", () => {
  it("passes axe scan with tasks and agents", async () => {
    const { axe } = await import("vitest-axe");
    resetStore({
      sessionTasks: new Map([
        ["s1", [
          { id: "1", subject: "Fix bug", description: "", status: "in_progress", activeForm: "Fixing" },
          { id: "2", subject: "Test", description: "", status: "completed" },
        ]],
      ]),
      sessionBackgroundAgents: new Map([
        ["s1", [
          { toolUseId: "t1", name: "Explore", description: "desc", agentType: "Explore", status: "running", startedAt: Date.now() },
        ]],
      ]),
    });
    const { container } = render(<ActivityTray sessionId="s1" />);
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  it("passes axe scan with expanded panel", async () => {
    const { axe } = await import("vitest-axe");
    resetStore({
      sessionTasks: new Map([
        ["s1", [{ id: "1", subject: "Task", description: "", status: "pending" }]],
      ]),
      sessionBackgroundAgents: new Map([
        ["s1", [{ toolUseId: "t1", name: "Agent", description: "", agentType: "Explore", status: "running", startedAt: Date.now() }]],
      ]),
    });
    const { container } = render(<ActivityTray sessionId="s1" />);
    fireEvent.click(screen.getByRole("button", { name: /activity/i }));
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});
