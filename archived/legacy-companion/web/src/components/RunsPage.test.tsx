// @vitest-environment jsdom
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import type { AgentExecution } from "../api.js";

// ─── Mock setup ─────────────────────────────────────────────────────────────

const mockApi = {
  listExecutions: vi.fn(),
  listAgents: vi.fn(),
};

vi.mock("../api.js", () => ({
  api: {
    listExecutions: (...args: unknown[]) => mockApi.listExecutions(...args),
    listAgents: (...args: unknown[]) => mockApi.listAgents(...args),
  },
}));

import { RunsPage } from "./RunsPage.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeExecution(overrides: Partial<AgentExecution> = {}): AgentExecution {
  return {
    sessionId: `sess-${Math.random().toString(36).slice(2, 8)}`,
    agentId: "agent-1",
    triggerType: "manual",
    startedAt: Date.now() - 60000,
    ...overrides,
  };
}

function makeAgent(overrides: Partial<{ id: string; name: string; icon: string }> = {}) {
  return {
    id: "agent-1",
    version: 1,
    name: "Test Agent",
    description: "A test agent",
    icon: "bot",
    backendType: "claude",
    model: "claude-sonnet-4-6",
    permissionMode: "default",
    cwd: "/workspace",
    prompt: "Do something",
    enabled: true,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    totalRuns: 0,
    consecutiveFailures: 0,
    triggers: { webhook: { enabled: false, secret: "" } },
    ...overrides,
  };
}

// ─── Test setup ─────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  mockApi.listExecutions.mockResolvedValue({ executions: [], total: 0 });
  mockApi.listAgents.mockResolvedValue([]);
});

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("RunsPage", () => {
  it("shows loading state initially", () => {
    // Never resolve the API call to keep loading state
    mockApi.listExecutions.mockReturnValue(new Promise(() => {}));
    mockApi.listAgents.mockReturnValue(new Promise(() => {}));

    render(<RunsPage />);
    expect(screen.getByText("Loading...")).toBeInTheDocument();
  });

  it("renders the page header", async () => {
    render(<RunsPage />);

    await waitFor(() => {
      expect(screen.queryByText("Loading...")).not.toBeInTheDocument();
    });

    expect(screen.getByText("Runs")).toBeInTheDocument();
    expect(screen.getByText(/Monitor agent executions/)).toBeInTheDocument();
  });

  it("shows empty state when no executions exist", async () => {
    render(<RunsPage />);

    await waitFor(() => {
      expect(screen.getByText("No executions found")).toBeInTheDocument();
    });
  });

  it("renders execution rows with agent names", async () => {
    const exec = makeExecution({ agentId: "agent-1", triggerType: "webhook" });
    mockApi.listExecutions.mockResolvedValue({ executions: [exec], total: 1 });
    mockApi.listAgents.mockResolvedValue([makeAgent({ id: "agent-1", name: "My Bot" })]);

    render(<RunsPage />);

    // Agent name appears both in the table row and agent filter dropdown.
    // Use getAllByText and verify at least one exists in the table.
    await waitFor(() => {
      const matches = screen.getAllByText("My Bot");
      expect(matches.length).toBeGreaterThanOrEqual(1);
    });

    // Trigger type pill — "Webhook" appears in both filters and table; check at least 2
    const webhookElements = screen.getAllByText("Webhook");
    expect(webhookElements.length).toBeGreaterThanOrEqual(2); // filter pill + table row
  });

  it("renders all table column headers", async () => {
    mockApi.listExecutions.mockResolvedValue({
      executions: [makeExecution()],
      total: 1,
    });

    render(<RunsPage />);

    await waitFor(() => {
      expect(screen.getByText("Agent")).toBeInTheDocument();
    });

    expect(screen.getByText("Trigger")).toBeInTheDocument();
    expect(screen.getByText("Status")).toBeInTheDocument();
    expect(screen.getByText("Started")).toBeInTheDocument();
    expect(screen.getByText("Duration")).toBeInTheDocument();
    expect(screen.getByText("Session")).toBeInTheDocument();
  });

  it("shows trigger filter pills", async () => {
    render(<RunsPage />);

    await waitFor(() => {
      expect(screen.queryByText("Loading...")).not.toBeInTheDocument();
    });

    // All trigger filter pills should be present
    expect(screen.getByText("All triggers")).toBeInTheDocument();
    expect(screen.getByText("Manual")).toBeInTheDocument();
    // "Webhook" filter pill
    const webhookPills = screen.getAllByText("Webhook");
    expect(webhookPills.length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("Schedule")).toBeInTheDocument();
    // Linear trigger filter pill (added for Linear Agent SDK)
    expect(screen.getByText("Linear")).toBeInTheDocument();
  });

  it("shows status filter pills", async () => {
    render(<RunsPage />);

    await waitFor(() => {
      expect(screen.queryByText("Loading...")).not.toBeInTheDocument();
    });

    expect(screen.getByText("All statuses")).toBeInTheDocument();
    expect(screen.getByText("Running")).toBeInTheDocument();
    expect(screen.getByText("Success")).toBeInTheDocument();
    expect(screen.getByText("Error")).toBeInTheDocument();
  });

  it("clicking a row opens the detail panel", async () => {
    const exec = makeExecution({
      sessionId: "detail-sess",
      agentId: "agent-1",
      triggerType: "webhook",
      startedAt: Date.now() - 120000,
    });
    mockApi.listExecutions.mockResolvedValue({ executions: [exec], total: 1 });
    mockApi.listAgents.mockResolvedValue([makeAgent({ id: "agent-1", name: "Detail Bot" })]);

    render(<RunsPage />);

    // Wait for table to render. Name appears in both dropdown and table row.
    await waitFor(() => {
      const matches = screen.getAllByText("Detail Bot");
      expect(matches.length).toBeGreaterThanOrEqual(1);
    });

    // Click the agent name inside the table row (find the <span> within <td>)
    const tableCell = screen.getAllByText("Detail Bot").find(
      (el) => el.closest("td") !== null,
    );
    expect(tableCell).toBeDefined();
    fireEvent.click(tableCell!);

    // The detail panel should appear
    await waitFor(() => {
      expect(screen.getByText("Execution Details")).toBeInTheDocument();
    });
  });

  it("clicking Close in the detail panel closes it", async () => {
    const exec = makeExecution({ sessionId: "close-test" });
    mockApi.listExecutions.mockResolvedValue({ executions: [exec], total: 1 });
    mockApi.listAgents.mockResolvedValue([makeAgent()]);

    render(<RunsPage />);

    // Wait for table row to render. Agent name appears in both dropdown and table.
    await waitFor(() => {
      const matches = screen.getAllByText("Test Agent");
      expect(matches.length).toBeGreaterThanOrEqual(1);
    });

    // Click the agent name in the table row
    const tableCell = screen.getAllByText("Test Agent").find(
      (el) => el.closest("td") !== null,
    );
    fireEvent.click(tableCell!);

    await waitFor(() => {
      expect(screen.getByText("Execution Details")).toBeInTheDocument();
    });

    // Click Close
    fireEvent.click(screen.getByText("Close"));

    await waitFor(() => {
      expect(screen.queryByText("Execution Details")).not.toBeInTheDocument();
    });
  });

  it("shows error details in the detail panel when execution has an error", async () => {
    const exec = makeExecution({
      error: "Process exited with code 1",
    });
    mockApi.listExecutions.mockResolvedValue({ executions: [exec], total: 1 });
    mockApi.listAgents.mockResolvedValue([makeAgent()]);

    render(<RunsPage />);

    await waitFor(() => {
      const matches = screen.getAllByText("Test Agent");
      expect(matches.length).toBeGreaterThanOrEqual(1);
    });

    // Click the agent name in the table row
    const tableCell = screen.getAllByText("Test Agent").find(
      (el) => el.closest("td") !== null,
    );
    fireEvent.click(tableCell!);

    await waitFor(() => {
      expect(screen.getByText("Process exited with code 1")).toBeInTheDocument();
    });
  });

  it("displays total execution count", async () => {
    mockApi.listExecutions.mockResolvedValue({ executions: [], total: 42 });

    render(<RunsPage />);

    await waitFor(() => {
      expect(screen.getByText("42 total")).toBeInTheDocument();
    });
  });

  it("passes axe accessibility checks", async () => {
    const { axe } = await import("vitest-axe");
    mockApi.listExecutions.mockResolvedValue({
      executions: [makeExecution({ completedAt: Date.now(), success: true })],
      total: 1,
    });
    mockApi.listAgents.mockResolvedValue([makeAgent()]);

    const { container } = render(<RunsPage />);

    // Wait for loading to complete
    await waitFor(() => {
      expect(screen.queryByText("Loading...")).not.toBeInTheDocument();
    });

    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  it("renders a Linear-triggered execution with correct label and color", async () => {
    // Verify that executions triggered by the Linear Agent SDK display
    // the "Linear" label with violet badge styling in the table row
    const exec = makeExecution({ triggerType: "linear", agentId: "agent-1" });
    mockApi.listExecutions.mockResolvedValue({ executions: [exec], total: 1 });
    mockApi.listAgents.mockResolvedValue([makeAgent({ id: "agent-1", name: "Linear Bot" })]);

    render(<RunsPage />);

    await waitFor(() => {
      // "Linear" appears in both the filter pill and the table row badge
      const linearElements = screen.getAllByText("Linear");
      expect(linearElements.length).toBeGreaterThanOrEqual(2);
    });

    // Find the badge in the table row (inside a <td>) and verify violet styling
    const tableBadge = screen.getAllByText("Linear").find(
      (el) => el.closest("td") !== null,
    );
    expect(tableBadge).toBeDefined();
    expect(tableBadge!.className).toContain("bg-violet-500/10");
  });

  it("has an agent filter dropdown with aria-label", async () => {
    mockApi.listAgents.mockResolvedValue([
      makeAgent({ id: "a1", name: "Agent A" }),
      makeAgent({ id: "a2", name: "Agent B" }),
    ]);

    render(<RunsPage />);

    await waitFor(() => {
      expect(screen.queryByText("Loading...")).not.toBeInTheDocument();
    });

    const select = screen.getByLabelText("Filter by agent");
    expect(select).toBeInTheDocument();
  });
});
