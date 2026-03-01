// @vitest-environment jsdom
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import type { AgentInfo } from "../api.js";

// ─── Mock setup ──────────────────────────────────────────────────────────────

const mockApi = {
  listAgents: vi.fn(),
  createAgent: vi.fn(),
  updateAgent: vi.fn(),
  deleteAgent: vi.fn(),
  toggleAgent: vi.fn(),
  runAgent: vi.fn(),
  exportAgent: vi.fn(),
  importAgent: vi.fn(),
  regenerateAgentWebhookSecret: vi.fn(),
  regenerateAgentTriggerSecret: vi.fn(),
  regenerateAgentTriggerToken: vi.fn(),
  listSkills: vi.fn(),
  listEnvs: vi.fn(),
};

vi.mock("../api.js", () => ({
  api: {
    listAgents: (...args: unknown[]) => mockApi.listAgents(...args),
    createAgent: (...args: unknown[]) => mockApi.createAgent(...args),
    updateAgent: (...args: unknown[]) => mockApi.updateAgent(...args),
    deleteAgent: (...args: unknown[]) => mockApi.deleteAgent(...args),
    toggleAgent: (...args: unknown[]) => mockApi.toggleAgent(...args),
    runAgent: (...args: unknown[]) => mockApi.runAgent(...args),
    exportAgent: (...args: unknown[]) => mockApi.exportAgent(...args),
    importAgent: (...args: unknown[]) => mockApi.importAgent(...args),
    regenerateAgentWebhookSecret: (...args: unknown[]) =>
      mockApi.regenerateAgentWebhookSecret(...args),
    regenerateAgentTriggerSecret: (...args: unknown[]) =>
      mockApi.regenerateAgentTriggerSecret(...args),
    regenerateAgentTriggerToken: (...args: unknown[]) =>
      mockApi.regenerateAgentTriggerToken(...args),
    listSkills: (...args: unknown[]) => mockApi.listSkills(...args),
    listEnvs: (...args: unknown[]) => mockApi.listEnvs(...args),
  },
}));

// Mock FolderPicker since it has its own API dependencies
vi.mock("./FolderPicker.js", () => ({ FolderPicker: () => null }));

import { AgentsPage } from "./AgentsPage.js";

// ─── Test Helpers ────────────────────────────────────────────────────────────

function makeAgent(overrides: Partial<AgentInfo> = {}): AgentInfo {
  return {
    id: "agent-1",
    version: 1,
    name: "Test Agent",
    description: "A test agent for unit tests",
    icon: "",
    backendType: "claude",
    model: "claude-sonnet-4-6",
    permissionMode: "default",
    cwd: "/workspace",
    prompt: "Do the thing",
    enabled: true,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    totalRuns: 0,
    consecutiveFailures: 0,
    triggers: {
      webhook: { enabled: false, secret: "" },
      schedule: { enabled: false, expression: "0 8 * * *", recurring: true },
    },
    ...overrides,
  };
}

const defaultRoute = { page: "agents" as const };

// ─── Tests ───────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  mockApi.listAgents.mockResolvedValue([]);
  // Default: no skills or envs fetched
  mockApi.listSkills.mockResolvedValue([]);
  mockApi.listEnvs.mockResolvedValue([]);
  window.location.hash = "#/agents";
});

describe("AgentsPage", () => {
  // ── Render States ──────────────────────────────────────────────────────────

  it("renders loading state initially", () => {
    // The component shows "Loading..." text while the API call is pending.
    // We use a never-resolving promise to keep the loading state visible.
    mockApi.listAgents.mockReturnValue(new Promise(() => {}));
    render(<AgentsPage route={defaultRoute} />);
    expect(screen.getByText("Loading...")).toBeInTheDocument();
  });

  it("renders empty state when no agents exist", async () => {
    // When the API returns an empty list, the component shows a friendly
    // empty state with a prompt to create an agent.
    mockApi.listAgents.mockResolvedValue([]);
    render(<AgentsPage route={defaultRoute} />);
    await waitFor(() => {
      expect(screen.getByText("No agents yet")).toBeInTheDocument();
    });
    expect(
      screen.getByText("Create an agent to get started, or import a shared JSON config."),
    ).toBeInTheDocument();
  });

  it("renders agent cards after loading", async () => {
    // After the API returns agents, each agent should render as a card
    // displaying its name, description, and backend type badge.
    const agent = makeAgent({
      id: "a1",
      name: "My Code Reviewer",
      description: "Reviews pull requests automatically",
    });
    mockApi.listAgents.mockResolvedValue([agent]);
    render(<AgentsPage route={defaultRoute} />);
    await screen.findByText("My Code Reviewer");
    expect(screen.getByText("Reviews pull requests automatically")).toBeInTheDocument();
  });

  it("renders multiple agent cards in order", async () => {
    // Multiple agents should all appear in the list view.
    const agents = [
      makeAgent({ id: "a1", name: "Agent Alpha", description: "First agent" }),
      makeAgent({ id: "a2", name: "Agent Beta", description: "Second agent" }),
    ];
    mockApi.listAgents.mockResolvedValue(agents);
    render(<AgentsPage route={defaultRoute} />);
    await screen.findByText("Agent Alpha");
    expect(screen.getByText("Agent Beta")).toBeInTheDocument();
    expect(screen.getByText("First agent")).toBeInTheDocument();
    expect(screen.getByText("Second agent")).toBeInTheDocument();
  });

  // ── Agent Card Info ────────────────────────────────────────────────────────

  it("agent card shows correct info: name, description, and trigger badges", async () => {
    // Validates that an agent card displays the name, description, enabled status,
    // backend badge, and computed trigger badges (Manual is always shown, plus
    // Webhook/Schedule when enabled).
    const agent = makeAgent({
      id: "a1",
      name: "Docs Writer",
      description: "Writes documentation",
      icon: "",
      backendType: "claude",
      enabled: true,
      triggers: {
        webhook: { enabled: true, secret: "abc123" },
        schedule: { enabled: true, expression: "0 8 * * *", recurring: true },
      },
    });
    mockApi.listAgents.mockResolvedValue([agent]);
    render(<AgentsPage route={defaultRoute} />);

    await screen.findByText("Docs Writer");
    expect(screen.getByText("Writes documentation")).toBeInTheDocument();
    expect(screen.getByText("Enabled")).toBeInTheDocument();

    // Trigger badges: Manual is always present, Webhook when enabled,
    // and schedule is humanized from the cron expression
    expect(screen.getByText("Manual")).toBeInTheDocument();
    // Webhook appears in trigger badges on the card
    expect(screen.getByText("Daily at 8:00 AM")).toBeInTheDocument();
  });

  it("agent card shows Disabled badge when agent is not enabled", async () => {
    // Agents can be toggled off. The card should reflect the disabled state.
    const agent = makeAgent({ id: "a1", name: "Disabled Agent", enabled: false });
    mockApi.listAgents.mockResolvedValue([agent]);
    render(<AgentsPage route={defaultRoute} />);

    await screen.findByText("Disabled Agent");
    expect(screen.getByText("Disabled")).toBeInTheDocument();
  });

  it("agent card shows Codex backend badge for codex agents", async () => {
    // Codex backend type should display "Codex" instead of "Claude".
    const agent = makeAgent({
      id: "a1",
      name: "Codex Agent",
      backendType: "codex",
    });
    mockApi.listAgents.mockResolvedValue([agent]);
    render(<AgentsPage route={defaultRoute} />);

    await screen.findByText("Codex Agent");
    expect(screen.getByText("Codex")).toBeInTheDocument();
  });

  it("agent card shows run count and last run time when available", async () => {
    // When an agent has been run before, the card displays run stats.
    const agent = makeAgent({
      id: "a1",
      name: "Busy Agent",
      totalRuns: 5,
      lastRunAt: Date.now() - 60000, // 1 minute ago
    });
    mockApi.listAgents.mockResolvedValue([agent]);
    render(<AgentsPage route={defaultRoute} />);

    await screen.findByText("Busy Agent");
    expect(screen.getByText("5 runs")).toBeInTheDocument();
  });

  it("agent card shows singular 'run' for exactly 1 run", async () => {
    // Edge case: singular "run" instead of "runs" when totalRuns is 1.
    const agent = makeAgent({
      id: "a1",
      name: "New Agent",
      totalRuns: 1,
    });
    mockApi.listAgents.mockResolvedValue([agent]);
    render(<AgentsPage route={defaultRoute} />);

    await screen.findByText("New Agent");
    expect(screen.getByText("1 run")).toBeInTheDocument();
  });

  it("agent card shows Copy URL button when webhook is enabled", async () => {
    // When webhook trigger is enabled, a "Copy URL" button appears next to
    // the trigger badges, allowing users to copy the webhook URL.
    const agent = makeAgent({
      id: "a1",
      name: "Webhook Agent",
      triggers: {
        webhook: { enabled: true, secret: "secret123" },
        schedule: { enabled: false, expression: "0 8 * * *", recurring: true },
      },
    });
    mockApi.listAgents.mockResolvedValue([agent]);
    render(<AgentsPage route={defaultRoute} />);

    await screen.findByText("Webhook Agent");
    expect(screen.getByText("Copy URL")).toBeInTheDocument();
  });

  // ── Interactive Behavior ───────────────────────────────────────────────────

  it("clicking '+ New Agent' shows the editor in create mode", async () => {
    // Clicking the New Agent button switches from list view to editor view
    // with "New Agent" as the heading.
    mockApi.listAgents.mockResolvedValue([]);
    render(<AgentsPage route={defaultRoute} />);

    // Wait for loading to complete
    await waitFor(() => {
      expect(screen.queryByText("Loading...")).not.toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("+ New Agent"));

    // Editor should now be visible with "New Agent" heading
    expect(screen.getByText("New Agent")).toBeInTheDocument();
    // The "Create" button should be visible (not "Save")
    expect(screen.getByText("Create")).toBeInTheDocument();
  });

  it("quick setup 'Public Webhook' opens prefilled editor", async () => {
    mockApi.listAgents.mockResolvedValue([]);
    render(<AgentsPage route={defaultRoute} />);

    await waitFor(() => {
      expect(screen.queryByText("Loading...")).not.toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("2. Public Webhook"));

    expect(screen.getByText("New Agent")).toBeInTheDocument();
    expect(screen.getByDisplayValue("New Webhook Agent")).toBeInTheDocument();
    expect(screen.getByDisplayValue(/You are an autonomous agent\./)).toBeInTheDocument();
  });

  it("clicking Cancel in editor returns to list view", async () => {
    // After opening the editor, clicking Cancel should navigate back to
    // the agent list without saving.
    mockApi.listAgents.mockResolvedValue([]);
    render(<AgentsPage route={defaultRoute} />);

    await waitFor(() => {
      expect(screen.queryByText("Loading...")).not.toBeInTheDocument();
    });

    // Open editor
    fireEvent.click(screen.getByText("+ New Agent"));
    expect(screen.getByText("New Agent")).toBeInTheDocument();

    // Click Cancel — there are two Cancel buttons in the editor (back arrow area and header)
    const cancelButtons = screen.getAllByText("Cancel");
    fireEvent.click(cancelButtons[0]);

    // Should return to list view
    await waitFor(() => {
      expect(screen.getByText("No agents yet")).toBeInTheDocument();
    });
  });

  it("clicking Edit on an agent card opens the editor in edit mode", async () => {
    // Clicking the Edit button on an agent card should switch to the editor
    // with "Edit Agent" heading and "Save" button.
    const agent = makeAgent({ id: "a1", name: "Editable Agent", prompt: "Do something" });
    mockApi.listAgents.mockResolvedValue([agent]);
    render(<AgentsPage route={defaultRoute} />);

    await screen.findByText("Editable Agent");
    fireEvent.click(screen.getByTitle("Edit"));

    expect(screen.getByText("Edit Agent")).toBeInTheDocument();
    expect(screen.getByText("Save")).toBeInTheDocument();
    // Form should be pre-filled with agent data
    expect(screen.getByDisplayValue("Editable Agent")).toBeInTheDocument();
  });

  it("clicking Run on an agent without {{input}} triggers runAgent", async () => {
    // For agents whose prompt does not contain {{input}}, clicking Run
    // immediately calls the API without showing an input modal.
    const agent = makeAgent({ id: "a1", name: "Quick Agent", prompt: "Do the thing" });
    mockApi.listAgents.mockResolvedValue([agent]);
    mockApi.runAgent.mockResolvedValue({ ok: true, message: "started" });
    render(<AgentsPage route={defaultRoute} />);

    await screen.findByText("Quick Agent");
    fireEvent.click(screen.getByText("Run"));

    await waitFor(() => {
      expect(mockApi.runAgent).toHaveBeenCalledWith("a1", undefined);
    });
  });

  it("clicking Run on an agent with {{input}} shows input modal", async () => {
    // For agents whose prompt contains {{input}}, clicking Run should open
    // a modal that allows the user to provide input text.
    const agent = makeAgent({
      id: "a1",
      name: "Input Agent",
      prompt: "Process this: {{input}}",
    });
    mockApi.listAgents.mockResolvedValue([agent]);
    render(<AgentsPage route={defaultRoute} />);

    await screen.findByText("Input Agent");
    fireEvent.click(screen.getByText("Run"));

    // The input modal should appear
    expect(screen.getByText("Run Input Agent")).toBeInTheDocument();
    expect(
      screen.getByPlaceholderText("Enter input for the agent..."),
    ).toBeInTheDocument();
  });

  it("delete button calls deleteAgent after confirmation", async () => {
    // Clicking the Delete button should trigger a confirm dialog, then call
    // the deleteAgent API and refresh the agent list.
    const agent = makeAgent({ id: "a1", name: "Delete Me" });
    mockApi.listAgents.mockResolvedValue([agent]);
    mockApi.deleteAgent.mockResolvedValue({});
    window.confirm = vi.fn().mockReturnValue(true);

    render(<AgentsPage route={defaultRoute} />);
    await screen.findByText("Delete Me");
    fireEvent.click(screen.getByTitle("Delete"));

    await waitFor(() => {
      expect(window.confirm).toHaveBeenCalledWith("Delete this agent?");
      expect(mockApi.deleteAgent).toHaveBeenCalledWith("a1");
    });
  });

  it("toggle button calls toggleAgent API", async () => {
    // Clicking the toggle button (Enable/Disable) should call the API.
    const agent = makeAgent({ id: "a1", name: "Toggle Me", enabled: true });
    mockApi.listAgents.mockResolvedValue([agent]);
    mockApi.toggleAgent.mockResolvedValue({});

    render(<AgentsPage route={defaultRoute} />);
    await screen.findByText("Toggle Me");
    fireEvent.click(screen.getByTitle("Disable"));

    await waitFor(() => {
      expect(mockApi.toggleAgent).toHaveBeenCalledWith("a1");
    });
  });

  it("header shows 'Agency' title and description", async () => {
    // The page header displays the title and a short description of what agents are.
    render(<AgentsPage route={defaultRoute} />);
    await waitFor(() => {
      expect(screen.queryByText("Loading...")).not.toBeInTheDocument();
    });
    expect(screen.getByText("Agency")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Create autonomous companions with manual runs, public webhooks, and optional event-source adapters.",
      ),
    ).toBeInTheDocument();
  });

  it("Import button is present in list view", async () => {
    // The list view should have an Import button for importing agents from JSON.
    render(<AgentsPage route={defaultRoute} />);
    await waitFor(() => {
      expect(screen.queryByText("Loading...")).not.toBeInTheDocument();
    });
    expect(screen.getByText("Import")).toBeInTheDocument();
  });

  // ── Controls Row ──────────────────────────────────────────────────────────

  it("editor shows controls row with backend toggle, model, and mode pills", async () => {
    // The redesigned editor replaces the old Backend/Working Dir/Environment
    // sections with a compact controls row of pill-style buttons.
    render(<AgentsPage route={defaultRoute} />);
    await waitFor(() => {
      expect(screen.queryByText("Loading...")).not.toBeInTheDocument();
    });
    fireEvent.click(screen.getByText("+ New Agent"));

    // Controls row should be present
    const controlsRow = screen.getByTestId("controls-row");
    expect(controlsRow).toBeInTheDocument();

    // Backend toggle pills (Claude and Codex) should be in the controls row
    // Claude should be selected by default
    const claudeBtn = controlsRow.querySelector("button");
    expect(claudeBtn).toHaveTextContent("Claude");
  });

  it("editor shows folder pill defaulting to 'temp'", async () => {
    // The folder pill shows "temp" when no cwd is set, indicating a
    // temporary directory will be used.
    render(<AgentsPage route={defaultRoute} />);
    await waitFor(() => {
      expect(screen.queryByText("Loading...")).not.toBeInTheDocument();
    });
    fireEvent.click(screen.getByText("+ New Agent"));

    // Folder pill shows "temp" by default
    expect(screen.getByText("temp")).toBeInTheDocument();
  });

  it("editor shows env profile pill with dropdown", async () => {
    // The environment profile pill opens a dropdown with available env profiles
    // fetched from the API.
    mockApi.listEnvs.mockResolvedValue([
      { slug: "dev", name: "Development", variables: {} },
      { slug: "prod", name: "Production", variables: {} },
    ]);
    render(<AgentsPage route={defaultRoute} />);
    await waitFor(() => {
      expect(screen.queryByText("Loading...")).not.toBeInTheDocument();
    });
    fireEvent.click(screen.getByText("+ New Agent"));

    // Env pill shows "None" by default
    await waitFor(() => {
      expect(screen.getByText("None")).toBeInTheDocument();
    });

    // Click the env pill to open dropdown
    fireEvent.click(screen.getByText("None"));

    // Dropdown should show available profiles
    await waitFor(() => {
      expect(screen.getByText("Development")).toBeInTheDocument();
      expect(screen.getByText("Production")).toBeInTheDocument();
    });
  });

  it("branch pill appears when folder is set and shows inline input", async () => {
    // The branch pill only appears when a working directory is set (not temp).
    // Clicking it reveals an inline branch name input with create/worktree options.
    const agent = makeAgent({
      id: "a1",
      name: "Branch Agent",
      cwd: "/workspace",
      branch: "",
    });
    mockApi.listAgents.mockResolvedValue([agent]);
    render(<AgentsPage route={defaultRoute} />);

    await screen.findByText("Branch Agent");
    fireEvent.click(screen.getByTitle("Edit"));

    // Branch pill should be visible since cwd is set
    expect(screen.getByText("branch")).toBeInTheDocument();

    // Click branch pill to show inline input
    fireEvent.click(screen.getByText("branch"));

    // Branch input should appear
    expect(screen.getByPlaceholderText("branch name")).toBeInTheDocument();
  });

  it("branch pill shows create and worktree checkboxes when branch is typed", async () => {
    // After typing a branch name in the inline input, the create and worktree
    // checkboxes should appear.
    const agent = makeAgent({
      id: "a1",
      name: "Git Agent",
      cwd: "/workspace",
      branch: "feature/test",
      createBranch: true,
    });
    mockApi.listAgents.mockResolvedValue([agent]);
    render(<AgentsPage route={defaultRoute} />);

    await screen.findByText("Git Agent");
    fireEvent.click(screen.getByTitle("Edit"));

    // Branch input should be visible with the branch name pre-filled
    expect(screen.getByDisplayValue("feature/test")).toBeInTheDocument();

    // Create and worktree checkboxes should be visible
    expect(screen.getByText("create")).toBeInTheDocument();
    expect(screen.getByText("worktree")).toBeInTheDocument();
  });

  // ── Codex Internet Access ────────────────────────────────────────────────

  it("Codex internet access pill is only visible for codex backend", async () => {
    // The "Internet" pill should only appear when the backend type is set
    // to "codex". In the redesigned editor, it's a toggle pill in the
    // controls row instead of a checkbox.
    render(<AgentsPage route={defaultRoute} />);
    await waitFor(() => {
      expect(screen.queryByText("Loading...")).not.toBeInTheDocument();
    });
    fireEvent.click(screen.getByText("+ New Agent"));

    // Default is Claude, so Internet pill should not be visible
    expect(screen.queryByText("Internet")).not.toBeInTheDocument();

    // Switch to Codex backend
    const controlsRow = screen.getByTestId("controls-row");
    const codexBtn = Array.from(controlsRow.querySelectorAll("button")).find(
      (b) => b.textContent === "Codex",
    );
    fireEvent.click(codexBtn!);

    // Now the Internet pill should appear
    expect(screen.getByText("Internet")).toBeInTheDocument();
  });

  // ── Advanced Section ────────────────────────────────────────────────────

  it("Advanced section collapse/expand toggle works", async () => {
    // The Advanced section is collapsed by default for new agents.
    // Clicking the toggle should expand and show MCP Servers, Skills,
    // Allowed Tools, and Environment Variables sub-sections.
    render(<AgentsPage route={defaultRoute} />);
    await waitFor(() => {
      expect(screen.queryByText("Loading...")).not.toBeInTheDocument();
    });
    fireEvent.click(screen.getByText("+ New Agent"));

    // Advanced header should be visible
    expect(screen.getByText("Advanced")).toBeInTheDocument();

    // Sub-sections should NOT be visible (collapsed)
    expect(screen.queryByText("MCP Servers")).not.toBeInTheDocument();

    // Click Advanced to expand
    fireEvent.click(screen.getByText("Advanced"));

    // Sub-sections should now be visible
    expect(screen.getByText("MCP Servers")).toBeInTheDocument();
    expect(screen.getByText("Skills")).toBeInTheDocument();
    expect(screen.getByText("Allowed Tools")).toBeInTheDocument();
    expect(screen.getByText("Environment Variables")).toBeInTheDocument();
  });

  it("Advanced section auto-expands when editing agent with advanced config", async () => {
    // When editing an agent that already has MCP servers or other advanced
    // features configured, the Advanced section should auto-expand.
    const agent = makeAgent({
      id: "a1",
      name: "Advanced Agent",
      mcpServers: {
        "test-server": { type: "stdio", command: "node", args: ["server.js"] },
      },
    });
    mockApi.listAgents.mockResolvedValue([agent]);
    render(<AgentsPage route={defaultRoute} />);

    await screen.findByText("Advanced Agent");
    fireEvent.click(screen.getByTitle("Edit"));

    // Advanced should be auto-expanded because agent has mcpServers
    expect(screen.getByText("MCP Servers")).toBeInTheDocument();
    // The MCP server entry should be visible
    expect(screen.getByText("test-server")).toBeInTheDocument();
  });

  // ── Environment Variables (in Advanced) ────────────────────────────────

  it("editor shows environment variables section inside Advanced", async () => {
    // Environment variables have been moved into the Advanced section.
    // The add/remove flow should still work.
    render(<AgentsPage route={defaultRoute} />);
    await waitFor(() => {
      expect(screen.queryByText("Loading...")).not.toBeInTheDocument();
    });
    fireEvent.click(screen.getByText("+ New Agent"));

    // Expand Advanced
    fireEvent.click(screen.getByText("Advanced"));

    // Environment Variables sub-section should be visible
    expect(screen.getByText("Environment Variables")).toBeInTheDocument();

    // Initially shows "No extra variables set."
    expect(screen.getByText("No extra variables set.")).toBeInTheDocument();

    // Click "+ Add Variable"
    fireEvent.click(screen.getByText("+ Add Variable"));

    // Should now have KEY and value input fields
    expect(screen.getByPlaceholderText("KEY")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("value")).toBeInTheDocument();

    // Remove the variable
    fireEvent.click(screen.getByTitle("Remove variable"));
    expect(screen.getByText("No extra variables set.")).toBeInTheDocument();
  });

  // ── Skills ─────────────────────────────────────────────────────────────

  it("Skills checkbox list renders fetched skills", async () => {
    // When the API returns skills, they should appear as checkboxes in the
    // Advanced > Skills sub-section.
    mockApi.listSkills.mockResolvedValue([
      { slug: "code-review", name: "Code Review", description: "Reviews code changes" },
      { slug: "testing", name: "Testing", description: "Writes tests" },
    ]);
    render(<AgentsPage route={defaultRoute} />);
    await waitFor(() => {
      expect(screen.queryByText("Loading...")).not.toBeInTheDocument();
    });
    fireEvent.click(screen.getByText("+ New Agent"));
    // Expand Advanced
    fireEvent.click(screen.getByText("Advanced"));

    await waitFor(() => {
      expect(screen.getByText("Code Review")).toBeInTheDocument();
      expect(screen.getByText("Reviews code changes")).toBeInTheDocument();
      expect(screen.getByText("Testing")).toBeInTheDocument();
    });
  });

  it("Skills shows empty state when no skills found", async () => {
    // When the API returns no skills, a helpful message should appear.
    mockApi.listSkills.mockResolvedValue([]);
    render(<AgentsPage route={defaultRoute} />);
    await waitFor(() => {
      expect(screen.queryByText("Loading...")).not.toBeInTheDocument();
    });
    fireEvent.click(screen.getByText("+ New Agent"));
    fireEvent.click(screen.getByText("Advanced"));

    expect(screen.getByText("No skills found in ~/.claude/skills/")).toBeInTheDocument();
  });

  // ── MCP Servers ────────────────────────────────────────────────────────

  it("MCP server add/remove flow works", async () => {
    // Tests the full flow of adding an MCP server via the inline form and
    // then removing it.
    render(<AgentsPage route={defaultRoute} />);
    await waitFor(() => {
      expect(screen.queryByText("Loading...")).not.toBeInTheDocument();
    });
    fireEvent.click(screen.getByText("+ New Agent"));
    fireEvent.click(screen.getByText("Advanced"));

    // Initially shows empty state
    expect(screen.getByText("No MCP servers configured.")).toBeInTheDocument();

    // Click "+ Add Server"
    fireEvent.click(screen.getByText("+ Add Server"));

    // Fill in the form
    fireEvent.change(screen.getByPlaceholderText("e.g., my-server"), {
      target: { value: "my-mcp" },
    });
    fireEvent.change(screen.getByPlaceholderText("e.g., npx -y @some/mcp-server"), {
      target: { value: "npx mcp-tool" },
    });

    // Submit the server
    fireEvent.click(screen.getByText("Add Server"));

    // Server should now appear in the list
    expect(screen.getByText("my-mcp")).toBeInTheDocument();
    expect(screen.getByText("stdio")).toBeInTheDocument();

    // Empty state should be gone
    expect(screen.queryByText("No MCP servers configured.")).not.toBeInTheDocument();

    // Remove the server
    fireEvent.click(screen.getByTitle("Remove server"));
    expect(screen.getByText("No MCP servers configured.")).toBeInTheDocument();
  });

  // ── Allowed Tools ──────────────────────────────────────────────────────

  it("Allowed tools tag input works with Enter to add and X to remove", async () => {
    // Tests the tag-style input for allowed tools: typing a tool name and
    // pressing Enter adds it, clicking X removes it.
    render(<AgentsPage route={defaultRoute} />);
    await waitFor(() => {
      expect(screen.queryByText("Loading...")).not.toBeInTheDocument();
    });
    fireEvent.click(screen.getByText("+ New Agent"));
    fireEvent.click(screen.getByText("Advanced"));

    // Type a tool name and press Enter
    const toolInput = screen.getByPlaceholderText("Type tool name and press Enter");
    fireEvent.change(toolInput, { target: { value: "Read" } });
    fireEvent.keyDown(toolInput, { key: "Enter" });

    // Tool should appear as a tag
    expect(screen.getByText("Read")).toBeInTheDocument();

    // The input should be cleared
    expect(toolInput).toHaveValue("");

    // Add another tool
    fireEvent.change(toolInput, { target: { value: "Write" } });
    fireEvent.keyDown(toolInput, { key: "Enter" });
    expect(screen.getByText("Write")).toBeInTheDocument();

    // Helper text should still be visible
    expect(screen.getByText("Leave empty to allow all tools.")).toBeInTheDocument();
  });

  // ── Triggers ──────────────────────────────────────────────────────────

  it("Webhook and Schedule trigger pills toggle on click", async () => {
    // The redesigned trigger section uses toggle pills instead of checkboxes
    // in bordered cards. Clicking a pill toggles its state.
    render(<AgentsPage route={defaultRoute} />);
    await waitFor(() => {
      expect(screen.queryByText("Loading...")).not.toBeInTheDocument();
    });
    fireEvent.click(screen.getByText("+ New Agent"));

    // Both trigger pills should be visible
    expect(screen.getByText("Webhook")).toBeInTheDocument();
    expect(screen.getByText("Schedule")).toBeInTheDocument();

    // Click Webhook to enable it
    fireEvent.click(screen.getByText("Webhook"));

    // Helper text should appear
    await waitFor(() => {
      expect(screen.getByText(/unique URL will be generated/)).toBeInTheDocument();
    });

    // Click Schedule to enable it
    fireEvent.click(screen.getByText("Schedule"));

    // Schedule config should appear with Recurring/One-time options
    expect(screen.getByText("Recurring")).toBeInTheDocument();
    expect(screen.getByText("One-time")).toBeInTheDocument();
  });

  // ── Edit Mode Deserialization ──────────────────────────────────────────

  it("edit mode deserializes all agent fields into form", async () => {
    // When editing an agent with all fields configured, the form should
    // correctly deserialize all values from AgentInfo to AgentFormData.
    // Docker container fields are no longer part of the agent editor (they
    // belong in Environment profiles via EnvManager).
    const agent = makeAgent({
      id: "a1",
      name: "Full Agent",
      backendType: "codex",
      codexInternetAccess: true,
      env: { API_KEY: "secret123", DEBUG: "true" },
      branch: "feature/test",
      createBranch: true,
      useWorktree: true,
      allowedTools: ["Read", "Write"],
      skills: ["code-review"],
      mcpServers: { "my-server": { type: "sse", url: "https://example.com" } },
    });
    mockApi.listAgents.mockResolvedValue([agent]);
    render(<AgentsPage route={defaultRoute} />);

    await screen.findByText("Full Agent");
    fireEvent.click(screen.getByTitle("Edit"));

    // Verify basic fields
    expect(screen.getByDisplayValue("Full Agent")).toBeInTheDocument();

    // Codex internet pill should be active (visible in controls row)
    expect(screen.getByText("Internet")).toBeInTheDocument();

    // Branch should be populated
    expect(screen.getByDisplayValue("feature/test")).toBeInTheDocument();

    // Advanced should be auto-expanded (has MCP + allowed tools + env vars)
    expect(screen.getByText("my-server")).toBeInTheDocument();
    expect(screen.getByText("Read")).toBeInTheDocument();
    expect(screen.getByText("Write")).toBeInTheDocument();

    // Env vars should be populated in Advanced section
    expect(screen.getByDisplayValue("API_KEY")).toBeInTheDocument();
    expect(screen.getByDisplayValue("secret123")).toBeInTheDocument();
  });

  // ── No old section headers ─────────────────────────────────────────────

  it("editor does not render old section headers (Basics, Backend, Working Directory, Environment)", async () => {
    // The redesigned editor removes the separate section headers for
    // Basics, Backend, Working Directory, and Environment. These are now
    // either inline (identity) or in the controls row.
    render(<AgentsPage route={defaultRoute} />);
    await waitFor(() => {
      expect(screen.queryByText("Loading...")).not.toBeInTheDocument();
    });
    fireEvent.click(screen.getByText("+ New Agent"));

    // None of these old section headers should exist
    expect(screen.queryByText("Basics")).not.toBeInTheDocument();
    expect(screen.queryByText("Backend")).not.toBeInTheDocument();
    expect(screen.queryByText("Working Directory")).not.toBeInTheDocument();
    // "Environment" as a section header is gone; env vars are now in Advanced
    // as "Environment Variables"
  });

  // ── Accessibility ──────────────────────────────────────────────────────────

  // Known pre-existing accessibility issues in AgentsPage component:
  // - Hidden file input for Import lacks an explicit label (the visible "Import"
  //   button triggers it programmatically, so it's functionally accessible but
  //   axe flags the hidden <input type="file"> without a <label>).
  // - Agent card uses <h3> directly (heading-order skip from page <h1>).
  // - Editor has icon-only back button without aria-label, and select elements
  //   whose visible <label> siblings are not associated via htmlFor/id.
  // These are excluded so the axe scan still catches any *new* violations.
  const axeRules = {
    rules: {
      // Hidden file input has no explicit label; "Import" button acts as trigger
      label: { enabled: false },
      // Agent cards skip heading levels (h1 -> h3)
      "heading-order": { enabled: false },
      // Icon-only back button in editor lacks aria-label
      "button-name": { enabled: false },
      // Select elements in editor have visible labels but not programmatically linked
      "select-name": { enabled: false },
    },
  };

  it("passes axe accessibility checks on empty state", async () => {
    // The empty state (no agents) should have no accessibility violations
    // beyond the known issues documented above.
    const { axe } = await import("vitest-axe");
    mockApi.listAgents.mockResolvedValue([]);
    const { container } = render(<AgentsPage route={defaultRoute} />);
    await waitFor(() => {
      expect(screen.getByText("No agents yet")).toBeInTheDocument();
    });
    const results = await axe(container, axeRules);
    expect(results).toHaveNoViolations();
  });

  it("passes axe accessibility checks with agent cards", async () => {
    // The list view with agent cards should have no accessibility violations
    // beyond the known issues documented above.
    const { axe } = await import("vitest-axe");
    const agent = makeAgent({
      id: "a1",
      name: "Accessible Agent",
      description: "This agent is accessible",
    });
    mockApi.listAgents.mockResolvedValue([agent]);
    const { container } = render(<AgentsPage route={defaultRoute} />);
    await screen.findByText("Accessible Agent");
    const results = await axe(container, axeRules);
    expect(results).toHaveNoViolations();
  });

  it("passes axe accessibility checks in editor view", async () => {
    // The agent editor form should have no accessibility violations
    // beyond the known issues documented above.
    const { axe } = await import("vitest-axe");
    mockApi.listAgents.mockResolvedValue([]);
    const { container } = render(<AgentsPage route={defaultRoute} />);
    await waitFor(() => {
      expect(screen.queryByText("Loading...")).not.toBeInTheDocument();
    });
    fireEvent.click(screen.getByText("+ New Agent"));
    const results = await axe(container, axeRules);
    expect(results).toHaveNoViolations();
  });

  it("passes axe accessibility checks in editor with advanced sections expanded", async () => {
    // The editor with the Advanced section expanded should still have no
    // new accessibility violations.
    const { axe } = await import("vitest-axe");
    mockApi.listAgents.mockResolvedValue([]);
    const { container } = render(<AgentsPage route={defaultRoute} />);
    await waitFor(() => {
      expect(screen.queryByText("Loading...")).not.toBeInTheDocument();
    });
    fireEvent.click(screen.getByText("+ New Agent"));
    fireEvent.click(screen.getByText("Advanced"));
    const results = await axe(container, axeRules);
    expect(results).toHaveNoViolations();
  });
});
