// @vitest-environment jsdom
/**
 * Tests for the Linear Agent setup wizard integrated into AgentsPage.
 *
 * Validates:
 * - Wizard entry via "Setup Linear Agent" button
 * - Rendering with 4-step indicator (Intro, Connection, Agent, Done)
 * - Accessibility (axe scan)
 * - Step navigation (Next/Back buttons)
 * - Connection selection (step 2) with auto-select for single connection
 * - Agent creation with correct payload (Linear trigger + oauthConnectionId)
 * - Error handling for API failures
 * - Cancel returns to agent list
 * - Finish refreshes agent list
 * - Entry from IntegrationsPage via ?setup=linear hash param
 * - Public URL warning
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";

// ─── Mock state ──────────────────────────────────────────────────────────────

let mockPublicUrl = "";

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
  listSkills: vi.fn(),
  listEnvs: vi.fn(),
  listLinearOAuthConnections: vi.fn(),
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
    regenerateAgentWebhookSecret: (...args: unknown[]) => mockApi.regenerateAgentWebhookSecret(...args),
    listSkills: (...args: unknown[]) => mockApi.listSkills(...args),
    listEnvs: (...args: unknown[]) => mockApi.listEnvs(...args),
    listLinearOAuthConnections: (...args: unknown[]) => mockApi.listLinearOAuthConnections(...args),
  },
}));

vi.mock("../store.js", () => ({
  useStore: (selector: (state: { publicUrl: string }) => unknown) =>
    selector({ publicUrl: mockPublicUrl }),
}));

// Mock FolderPicker to avoid file-system API calls in tests
vi.mock("./FolderPicker.js", () => ({
  FolderPicker: ({ onClose }: { onClose: () => void }) => (
    <div data-testid="folder-picker">
      <button onClick={onClose}>Close Picker</button>
    </div>
  ),
}));

// Mock LinearLogo to avoid SVG import issues
vi.mock("./LinearLogo.js", () => ({
  LinearLogo: ({ className }: { className?: string }) => (
    <span data-testid="linear-logo" className={className} />
  ),
}));

import { AgentsPage } from "./AgentsPage.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

const defaultConnections = {
  connections: [
    { id: "conn-1", name: "My OAuth App", status: "connected" as const },
  ],
};

/**
 * Render AgentsPage and enter the wizard via the setup=linear hash param.
 * The "Setup Linear Agent" button was moved from the page header into the
 * Linear filter empty state, so the hash param is the reliable entry point.
 */
async function renderAndEnterWizard() {
  // Set hash before render so useEffect picks it up on mount
  window.location.hash = "#/agents?setup=linear";
  render(<AgentsPage route={{ page: "agents" }} />);

  // Wait for wizard to load
  await waitFor(() => {
    expect(screen.getByRole("heading", { name: "Linear Agent Setup" })).toBeInTheDocument();
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockPublicUrl = "https://companion.example.com";
  mockApi.listAgents.mockResolvedValue([]);
  mockApi.listSkills.mockResolvedValue([]);
  mockApi.listEnvs.mockResolvedValue([]);
  mockApi.listLinearOAuthConnections.mockResolvedValue(defaultConnections);
  mockApi.createAgent.mockResolvedValue({
    id: "linear-agent",
    name: "Linear Agent",
    triggers: { linear: { enabled: true } },
  });
  window.location.hash = "#/agents";
});

afterEach(() => {
  window.location.hash = "";
});

// =============================================================================
// Tests
// =============================================================================

describe("Linear Agent Wizard in AgentsPage", () => {
  it("renders the wizard with 4-step indicator when Setup Linear Agent is clicked", async () => {
    // Wizard now has 4 steps: Intro, Connection, Agent, Done
    await renderAndEnterWizard();

    // Step indicator should be visible with 4 steps
    expect(screen.getByLabelText(/Step 1/)).toBeInTheDocument();
    expect(screen.getByLabelText(/Step 2/)).toBeInTheDocument();
    expect(screen.getByLabelText(/Step 3/)).toBeInTheDocument();
    expect(screen.getByLabelText(/Step 4/)).toBeInTheDocument();
    // No Step 5 anymore
    expect(screen.queryByLabelText(/Step 5/)).not.toBeInTheDocument();
  });

  it("shows Step 1 by default (intro)", async () => {
    await renderAndEnterWizard();

    // Step 1 content: intro
    expect(screen.getByText("Connect your Linear workspace")).toBeInTheDocument();
  });

  // ─── Accessibility ─────────────────────────────────────────────────────────

  it("passes axe accessibility checks on Step 1", async () => {
    const { axe } = await import("vitest-axe");
    await renderAndEnterWizard();

    const results = await axe(document.body);
    expect(results).toHaveNoViolations();
  });

  // ─── Step Navigation ──────────────────────────────────────────────────────

  it("navigates from Step 1 to Step 2 when Next is clicked", async () => {
    // Step 2 is now "Select OAuth Connection" instead of "Enter OAuth Credentials"
    await renderAndEnterWizard();

    fireEvent.click(screen.getByText("Next"));

    await waitFor(() => {
      expect(screen.getByText("Select OAuth Connection")).toBeInTheDocument();
    });
  });

  it("navigates back from Step 2 to Step 1", async () => {
    await renderAndEnterWizard();

    // Go to step 2
    fireEvent.click(screen.getByText("Next"));
    await waitFor(() => {
      expect(screen.getByText("Select OAuth Connection")).toBeInTheDocument();
    });

    // Go back to step 1
    fireEvent.click(screen.getByText("Back"));
    await waitFor(() => {
      expect(screen.getByText("Connect your Linear workspace")).toBeInTheDocument();
    });
  });

  // ─── Step 2: Connection Selection ──────────────────────────────────────────

  it("shows available OAuth connections in step 2", async () => {
    mockApi.listLinearOAuthConnections.mockResolvedValue({
      connections: [
        { id: "conn-1", name: "My OAuth App", status: "connected" },
        { id: "conn-2", name: "Other App", status: "disconnected" },
      ],
    });

    await renderAndEnterWizard();
    fireEvent.click(screen.getByText("Next"));

    await waitFor(() => {
      expect(screen.getByText("My OAuth App")).toBeInTheDocument();
      expect(screen.getByText("Other App")).toBeInTheDocument();
    });
  });

  it("selects a connection and advances to step 3", async () => {
    await renderAndEnterWizard();

    // Go to step 2
    fireEvent.click(screen.getByText("Next"));
    await waitFor(() => {
      expect(screen.getByText("Select OAuth Connection")).toBeInTheDocument();
    });

    // Connection should be auto-selected (only one)
    // Click Next to advance to step 3
    await waitFor(() => {
      expect(screen.getByText("My OAuth App")).toBeInTheDocument();
    });

    // Find and click the Next button (should be enabled since connection is auto-selected)
    const nextButtons = screen.getAllByText("Next");
    fireEvent.click(nextButtons[nextButtons.length - 1]);

    await waitFor(() => {
      expect(screen.getByText("Configure Your Agent")).toBeInTheDocument();
    });
  });

  it("shows empty state when no OAuth connections exist", async () => {
    mockApi.listLinearOAuthConnections.mockResolvedValue({ connections: [] });

    await renderAndEnterWizard();
    fireEvent.click(screen.getByText("Next"));

    await waitFor(() => {
      expect(screen.getByText("No OAuth connections found.")).toBeInTheDocument();
      expect(screen.getByText("Go to OAuth Settings")).toBeInTheDocument();
    });
  });

  // ─── Step 3: Agent Creation ────────────────────────────────────────────────

  it("creates agent with Linear trigger and oauthConnectionId, advances to step 4", async () => {
    await renderAndEnterWizard();

    // Navigate through to step 3
    fireEvent.click(screen.getByText("Next"));
    await waitFor(() => {
      expect(screen.getByText("My OAuth App")).toBeInTheDocument();
    });
    const nextButtons = screen.getAllByText("Next");
    fireEvent.click(nextButtons[nextButtons.length - 1]);

    await waitFor(() => {
      expect(screen.getByText("Configure Your Agent")).toBeInTheDocument();
    });

    // Default name is "Linear Agent" — just click create
    fireEvent.click(screen.getByText("Create Agent"));

    await waitFor(() => {
      expect(mockApi.createAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "Linear Agent",
          permissionMode: "bypassPermissions",
          triggers: expect.objectContaining({
            linear: { enabled: true, oauthConnectionId: "conn-1" },
          }),
          enabled: true,
        }),
      );
    });

    // Should advance to step 4 (Done)
    await waitFor(() => {
      expect(screen.getByText("Linear Agent is live")).toBeInTheDocument();
    });

    // Summary should show agent name
    expect(screen.getByText(/Agent "Linear Agent" created/)).toBeInTheDocument();
  });

  it("shows error when agent creation fails", async () => {
    mockApi.createAgent.mockRejectedValue(new Error("Agent name already exists"));

    await renderAndEnterWizard();

    // Navigate through to step 3
    fireEvent.click(screen.getByText("Next"));
    await waitFor(() => {
      expect(screen.getByText("My OAuth App")).toBeInTheDocument();
    });
    const nextButtons = screen.getAllByText("Next");
    fireEvent.click(nextButtons[nextButtons.length - 1]);

    await waitFor(() => {
      expect(screen.getByText("Configure Your Agent")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("Create Agent"));

    await waitFor(() => {
      expect(screen.getByText("Agent name already exists")).toBeInTheDocument();
    });

    // Should still be on step 3
    expect(screen.getByText("Configure Your Agent")).toBeInTheDocument();
  });

  // ─── Step 4: Done ─────────────────────────────────────────────────────────

  it("returns to agent list when Go to Agents is clicked", async () => {
    await renderAndEnterWizard();

    // Navigate all the way to step 4
    fireEvent.click(screen.getByText("Next"));
    await waitFor(() => {
      expect(screen.getByText("My OAuth App")).toBeInTheDocument();
    });
    const nextButtons = screen.getAllByText("Next");
    fireEvent.click(nextButtons[nextButtons.length - 1]);
    await waitFor(() => {
      expect(screen.getByText("Configure Your Agent")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText("Create Agent"));
    await waitFor(() => {
      expect(screen.getByText("Linear Agent is live")).toBeInTheDocument();
    });

    // Click finish — should return to agent list view
    fireEvent.click(screen.getByText("Go to Agents"));

    await waitFor(() => {
      // Should be back on the agents list (header visible)
      expect(screen.getByText("Agents")).toBeInTheDocument();
    });
  });

  // ─── Cancel ────────────────────────────────────────────────────────────────

  it("returns to agent list when Cancel is clicked", async () => {
    await renderAndEnterWizard();

    fireEvent.click(screen.getByText("Cancel"));

    // Should be back on the agents list
    await waitFor(() => {
      expect(screen.getByRole("heading", { level: 1, name: "Agents" })).toBeInTheDocument();
    });
  });

  // ─── Public URL warning ────────────────────────────────────────────────────

  it("shows warning when public URL is not configured", async () => {
    mockPublicUrl = "";

    await renderAndEnterWizard();

    // Should show warning about missing public URL
    expect(screen.getByText(/Not set\./)).toBeInTheDocument();
  });

  it("shows green checkmark when public URL is configured", async () => {
    await renderAndEnterWizard();

    expect(screen.getByText("Public URL")).toBeInTheDocument();
  });

  // ─── Entry from IntegrationsPage (hash param) ─────────────────────────────

  it("auto-enters wizard when ?setup=linear is in hash", async () => {
    window.location.hash = "#/agents?setup=linear";

    render(<AgentsPage route={{ page: "agents" }} />);

    // Should auto-enter the wizard
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Linear Agent Setup" })).toBeInTheDocument();
    });
  });
});
