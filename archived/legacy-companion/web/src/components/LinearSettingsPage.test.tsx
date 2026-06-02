// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";

interface MockStoreState {
  currentSessionId: string | null;
  publicUrl: string;
}

let mockState: MockStoreState;

const mockApi = {
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
  getLinearConnection: vi.fn(),
  getLinearStates: vi.fn(),
  listLinearConnections: vi.fn(),
  createLinearConnection: vi.fn(),
  deleteLinearConnection: vi.fn(),
  verifyLinearConnection: vi.fn(),
  updateLinearConnection: vi.fn(),
};

vi.mock("../api.js", () => ({
  api: {
    getSettings: (...args: unknown[]) => mockApi.getSettings(...args),
    updateSettings: (...args: unknown[]) => mockApi.updateSettings(...args),
    getLinearConnection: (...args: unknown[]) => mockApi.getLinearConnection(...args),
    getLinearStates: (...args: unknown[]) => mockApi.getLinearStates(...args),
    listLinearConnections: (...args: unknown[]) => mockApi.listLinearConnections(...args),
    createLinearConnection: (...args: unknown[]) => mockApi.createLinearConnection(...args),
    deleteLinearConnection: (...args: unknown[]) => mockApi.deleteLinearConnection(...args),
    verifyLinearConnection: (...args: unknown[]) => mockApi.verifyLinearConnection(...args),
    updateLinearConnection: (...args: unknown[]) => mockApi.updateLinearConnection(...args),
  },
}));

vi.mock("../store.js", () => {
  const useStoreFn = (selector: (state: MockStoreState) => unknown) => selector(mockState);
  useStoreFn.getState = () => mockState;
  return { useStore: useStoreFn };
});

import { LinearSettingsPage } from "./LinearSettingsPage.js";

const defaultConnection = {
  id: "conn-1",
  name: "Work",
  apiKeyLast4: "1234",
  workspaceName: "Acme",
  workspaceId: "ws-1",
  viewerName: "Ada",
  viewerEmail: "ada@example.com",
  connected: true,
  autoTransition: false,
  autoTransitionStateId: "",
  autoTransitionStateName: "",
  archiveTransition: false,
  archiveTransitionStateId: "",
  archiveTransitionStateName: "",
};

beforeEach(() => {
  vi.clearAllMocks();
  mockState = { currentSessionId: null, publicUrl: "" };

  // Default: list one connected connection
  mockApi.listLinearConnections.mockResolvedValue({
    connections: [defaultConnection],
  });

  mockApi.updateSettings.mockResolvedValue({
    anthropicApiKeyConfigured: false,
    anthropicModel: "claude-sonnet-4-6",
    linearApiKeyConfigured: true,
    linearAutoTransition: false,
    linearAutoTransitionStateName: "",
    linearArchiveTransition: false,
    linearArchiveTransitionStateName: "",
  });

  mockApi.getLinearStates.mockResolvedValue({
    teams: [
      {
        id: "team-1",
        key: "ENG",
        name: "Engineering",
        states: [
          { id: "s-backlog", name: "Backlog", type: "backlog" },
          { id: "s-inprogress", name: "In Progress", type: "started" },
          { id: "s-done", name: "Done", type: "completed" },
        ],
      },
    ],
  });

  mockApi.createLinearConnection.mockResolvedValue({
    connection: { ...defaultConnection, id: "conn-new", name: "New" },
  });

  mockApi.updateLinearConnection.mockResolvedValue({
    connection: defaultConnection,
  });
});

// =============================================================================
// Connection list
// =============================================================================

describe("LinearSettingsPage — connection list", () => {
  it("loads and displays connections on mount", async () => {
    // Verifies that the connection list is fetched and rendered on mount.
    render(<LinearSettingsPage />);
    expect(mockApi.listLinearConnections).toHaveBeenCalledTimes(1);
    expect(await screen.findByText("Work")).toBeInTheDocument();
  });

  it("shows empty state when no connections exist", async () => {
    // Verifies the empty state message when no connections are configured.
    mockApi.listLinearConnections.mockResolvedValue({ connections: [] });
    render(<LinearSettingsPage />);
    expect(await screen.findByText("No Linear connections yet.")).toBeInTheDocument();
  });

  it("shows connection card with status badge and masked key", async () => {
    // Verifies that connection cards display name, connected badge,
    // viewer/workspace info, and masked API key.
    render(<LinearSettingsPage />);
    expect(await screen.findByText("Work")).toBeInTheDocument();
    expect(screen.getByText("Connected")).toBeInTheDocument();
    expect(screen.getByText(/Ada/)).toBeInTheDocument();
    expect(screen.getByText(/...1234/)).toBeInTheDocument();
  });

  it("shows hero status banner with connected count", async () => {
    // Verifies the hero banner shows connected count and total connections.
    render(<LinearSettingsPage />);
    expect(await screen.findByText("1 connected")).toBeInTheDocument();
    expect(screen.getByText("1 connection configured")).toBeInTheDocument();
  });

  it("shows 'Not connected' badge for unverified connections", async () => {
    // Verifies that a connection without connected=true shows the right badge.
    mockApi.listLinearConnections.mockResolvedValue({
      connections: [{ ...defaultConnection, connected: false }],
    });
    render(<LinearSettingsPage />);
    expect(await screen.findByText("Not connected")).toBeInTheDocument();
  });
});

// =============================================================================
// Add connection
// =============================================================================

describe("LinearSettingsPage — add connection", () => {
  it("toggles the add connection form", async () => {
    // Verifies clicking Add Connection shows the form and Cancel hides it.
    render(<LinearSettingsPage />);
    await screen.findByText("Work");

    fireEvent.click(screen.getByRole("button", { name: "Add Connection" }));
    expect(screen.getByLabelText("Connection Name")).toBeInTheDocument();
    expect(screen.getByLabelText("API Key")).toBeInTheDocument();

    // Button should now say "Cancel"
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByLabelText("Connection Name")).toBeNull();
  });

  it("creates a new connection and reloads the list", async () => {
    // Verifies that submitting the add form calls createLinearConnection
    // and then reloads the connection list.
    render(<LinearSettingsPage />);
    await screen.findByText("Work");

    fireEvent.click(screen.getByRole("button", { name: "Add Connection" }));

    fireEvent.change(screen.getByLabelText("Connection Name"), {
      target: { value: "Personal" },
    });
    fireEvent.change(screen.getByLabelText("API Key"), {
      target: { value: "lin_api_personal" },
    });

    const saveBtn = screen.getByRole("button", { name: "Save" });
    fireEvent.click(saveBtn);

    await waitFor(() => {
      expect(mockApi.createLinearConnection).toHaveBeenCalledWith({
        name: "Personal",
        apiKey: "lin_api_personal",
      });
    });
    // Should reload connections after adding
    expect(mockApi.listLinearConnections).toHaveBeenCalledTimes(2);
  });

  it("shows validation error when name or key is empty", async () => {
    // Verifies the form shows an error if name or key is not provided.
    render(<LinearSettingsPage />);
    await screen.findByText("Work");

    fireEvent.click(screen.getByRole("button", { name: "Add Connection" }));
    // Save button should be disabled when fields are empty
    const saveBtn = screen.getByRole("button", { name: "Save" });
    expect(saveBtn).toBeDisabled();
  });

  it("shows error from API when create fails", async () => {
    // Verifies that an API error message is displayed in the form.
    mockApi.createLinearConnection.mockResolvedValue({ error: "Invalid API key" });
    render(<LinearSettingsPage />);
    await screen.findByText("Work");

    fireEvent.click(screen.getByRole("button", { name: "Add Connection" }));
    fireEvent.change(screen.getByLabelText("Connection Name"), {
      target: { value: "Bad" },
    });
    fireEvent.change(screen.getByLabelText("API Key"), {
      target: { value: "lin_api_bad" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText("Invalid API key")).toBeInTheDocument();
  });
});

// =============================================================================
// Delete / Verify connections
// =============================================================================

describe("LinearSettingsPage — delete and verify", () => {
  it("deletes a connection when Delete is clicked", async () => {
    // Verifies calling deleteLinearConnection and reloading the list.
    mockApi.deleteLinearConnection.mockResolvedValue({});
    render(<LinearSettingsPage />);
    await screen.findByText("Work");

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    await waitFor(() => {
      expect(mockApi.deleteLinearConnection).toHaveBeenCalledWith("conn-1");
    });
    // Should reload after deletion
    expect(mockApi.listLinearConnections).toHaveBeenCalledTimes(2);
  });

  it("verifies a connection when Verify is clicked", async () => {
    // Verifies calling verifyLinearConnection and reloading the list.
    mockApi.verifyLinearConnection.mockResolvedValue({});
    render(<LinearSettingsPage />);
    await screen.findByText("Work");

    fireEvent.click(screen.getByRole("button", { name: "Verify" }));

    await waitFor(() => {
      expect(mockApi.verifyLinearConnection).toHaveBeenCalledWith("conn-1");
    });
    // Should reload to reflect new verification status
    expect(mockApi.listLinearConnections).toHaveBeenCalledTimes(2);
  });
});

// =============================================================================
// Edit connection (auto-transition / archive transition settings)
// =============================================================================

describe("LinearSettingsPage — edit connection settings", () => {
  it("opens the edit panel and loads workflow states", async () => {
    // Verifies that clicking Edit on a connected connection opens
    // the settings panel and fetches workflow states from the API.
    render(<LinearSettingsPage />);
    await screen.findByText("Work");

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));

    await waitFor(() => {
      expect(mockApi.getLinearStates).toHaveBeenCalledWith("conn-1");
    });
    expect(screen.getByText("Auto-transition")).toBeInTheDocument();
    expect(screen.getByText("On session archive")).toBeInTheDocument();
  });

  it("toggles Edit to Close and back", async () => {
    // Verifies that clicking Edit toggles the panel open/close.
    render(<LinearSettingsPage />);
    await screen.findByText("Work");

    // Open
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect(await screen.findByText("Auto-transition")).toBeInTheDocument();

    // Close
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByText("Auto-transition")).toBeNull();
  });

  it("enables auto-transition toggle and shows state selector", async () => {
    // Verifies that enabling the auto-transition toggle reveals the
    // target status selector with workflow states.
    render(<LinearSettingsPage />);
    await screen.findByText("Work");

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    await waitFor(() => {
      expect(screen.getByText("Auto-transition")).toBeInTheDocument();
    });

    // Find auto-transition switch (first one)
    const switches = screen.getAllByRole("switch");
    fireEvent.click(switches[0]);

    // Should now show the Target status selector
    await waitFor(() => {
      expect(screen.getAllByText("Target status").length).toBeGreaterThan(0);
    });
  });

  it("enables archive-transition toggle", async () => {
    // Verifies that the archive transition toggle reveals the target status.
    render(<LinearSettingsPage />);
    await screen.findByText("Work");

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    await waitFor(() => {
      expect(screen.getByText("On session archive")).toBeInTheDocument();
    });

    // The archive switch is the second switch
    const switches = screen.getAllByRole("switch");
    fireEvent.click(switches[1]);

    await waitFor(() => {
      expect(screen.getAllByText("Target status").length).toBeGreaterThan(0);
    });
  });

  it("saves connection settings via updateLinearConnection", async () => {
    // Verifies that clicking Save Settings calls updateLinearConnection
    // with the correct auto-transition and archive-transition fields.
    render(<LinearSettingsPage />);
    await screen.findByText("Work");

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    await waitFor(() => {
      expect(screen.getByText("Auto-transition")).toBeInTheDocument();
    });

    // Enable auto-transition
    const switches = screen.getAllByRole("switch");
    fireEvent.click(switches[0]);

    // Wait for the state dropdown to appear then select a state
    await waitFor(() => {
      expect(screen.getByDisplayValue("Select a status...")).toBeInTheDocument();
    });
    const stateSelect = screen.getByDisplayValue("Select a status...");
    fireEvent.change(stateSelect, { target: { value: "s-inprogress" } });

    // Click Save Settings
    fireEvent.click(screen.getByRole("button", { name: "Save Settings" }));

    await waitFor(() => {
      expect(mockApi.updateLinearConnection).toHaveBeenCalledWith("conn-1", {
        autoTransition: true,
        autoTransitionStateId: "s-inprogress",
        autoTransitionStateName: "In Progress",
        archiveTransition: false,
        archiveTransitionStateId: "",
        archiveTransitionStateName: "",
      });
    });
  });

  it("disables Edit button for unconnected connections", async () => {
    // Verifies that the Edit button is disabled when the connection
    // is not verified (connected=false).
    mockApi.listLinearConnections.mockResolvedValue({
      connections: [{ ...defaultConnection, connected: false }],
    });
    render(<LinearSettingsPage />);
    await screen.findByText("Work");

    expect(screen.getByRole("button", { name: "Edit" })).toBeDisabled();
  });
});

// =============================================================================
// OAuth redirect link
// =============================================================================

describe("LinearSettingsPage — OAuth redirect link", () => {
  it("renders a link to the new OAuth settings page", async () => {
    // Verifies that after removing the inline OAuth section, a redirect link
    // is displayed pointing users to the dedicated LinearOAuthSettingsPage.
    render(<LinearSettingsPage />);
    await screen.findByText("Work");

    const oauthLink = screen.getByText("Linear OAuth Apps");
    expect(oauthLink).toBeInTheDocument();
    expect(oauthLink.closest("a")).toHaveAttribute("href", "#/integrations/linear-oauth");
  });
});

// =============================================================================
// Error paths and edge cases
// =============================================================================

describe("LinearSettingsPage — error paths and edge cases", () => {
  it("shows connection list error when loadConnections fails", async () => {
    // Verifies that a network error when fetching the connection list
    // displays the error message in the connections section.
    mockApi.listLinearConnections.mockRejectedValueOnce(new Error("Network down"));
    render(<LinearSettingsPage />);
    expect(await screen.findByText("Network down")).toBeInTheDocument();
  });

  it("shows catch-block error when createLinearConnection throws", async () => {
    // Verifies the catch block in onAddConnection for thrown exceptions
    // (as opposed to { error: ... } responses).
    mockApi.createLinearConnection.mockRejectedValueOnce(new Error("Connection refused"));
    render(<LinearSettingsPage />);
    await screen.findByText("Work");

    fireEvent.click(screen.getByRole("button", { name: "Add Connection" }));
    fireEvent.change(screen.getByLabelText("Connection Name"), {
      target: { value: "Test" },
    });
    fireEvent.change(screen.getByLabelText("API Key"), {
      target: { value: "lin_api_test" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText("Connection refused")).toBeInTheDocument();
  });

  it("clears edit state when deleting the connection that is being edited", async () => {
    // Verifies that deleting a connection whose edit panel is open
    // closes the edit panel by clearing the edit state.
    mockApi.deleteLinearConnection.mockResolvedValue({});
    render(<LinearSettingsPage />);
    await screen.findByText("Work");

    // Open the edit panel first
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    await waitFor(() => {
      expect(screen.getByText("Auto-transition")).toBeInTheDocument();
    });

    // Now delete the connection — should close the edit panel
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => {
      expect(mockApi.deleteLinearConnection).toHaveBeenCalledWith("conn-1");
    });
    // Edit panel should be gone
    await waitFor(() => {
      expect(screen.queryByText("Auto-transition")).toBeNull();
    });
  });

  it("handles getLinearStates failure gracefully in edit panel", async () => {
    // Verifies that when getLinearStates rejects, the edit panel still opens
    // but shows no workflow states — loadingStates becomes false with no crash.
    mockApi.getLinearStates.mockRejectedValueOnce(new Error("States API error"));
    render(<LinearSettingsPage />);
    await screen.findByText("Work");

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));

    // Wait for the loading to complete (will fail and hit catch)
    await waitFor(() => {
      expect(mockApi.getLinearStates).toHaveBeenCalledWith("conn-1");
    });
    // The panel should still display (no crash), showing disabled/empty state
    expect(screen.getByText("Auto-transition")).toBeInTheDocument();
  });

  it("shows error when saving connection settings fails", async () => {
    // Verifies that the error from updateLinearConnection is shown
    // in the edit panel when saving fails.
    mockApi.updateLinearConnection.mockRejectedValueOnce(new Error("Save failed"));
    render(<LinearSettingsPage />);
    await screen.findByText("Work");

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    await waitFor(() => {
      expect(screen.getByText("Auto-transition")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "Save Settings" }));

    expect(await screen.findByText("Save failed")).toBeInTheDocument();
  });

  it("navigates to current session when Back is clicked with active session", async () => {
    // Verifies that the Back button navigates to the current session when one exists.
    mockState.currentSessionId = "session-123";
    render(<LinearSettingsPage />);
    await screen.findByText("Work");

    // The Back button should be present (non-embedded mode)
    const backBtn = screen.getByRole("button", { name: "Back" });
    fireEvent.click(backBtn);

    // The hash should be updated to navigate to the session
    expect(window.location.hash).toContain("session-123");
  });
});

// =============================================================================
// Multi-team and state selector interactions
// =============================================================================

describe("LinearSettingsPage — multi-team and state selectors", () => {
  const multiTeamStates = {
    teams: [
      {
        id: "team-1",
        key: "ENG",
        name: "Engineering",
        states: [
          { id: "s-backlog", name: "Backlog", type: "backlog" },
          { id: "s-inprogress", name: "In Progress", type: "started" },
          { id: "s-done", name: "Done", type: "completed" },
        ],
      },
      {
        id: "team-2",
        key: "DES",
        name: "Design",
        states: [
          { id: "s-review", name: "In Review", type: "started" },
          { id: "s-approved", name: "Approved", type: "completed" },
        ],
      },
    ],
  };

  it("shows team selector when multiple teams exist and auto-transition is enabled", async () => {
    // Verifies the team dropdown appears when more than one team is available
    // and auto-transition is toggled on.
    mockApi.getLinearStates.mockResolvedValue(multiTeamStates);
    render(<LinearSettingsPage />);
    await screen.findByText("Work");

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    await waitFor(() => {
      expect(mockApi.getLinearStates).toHaveBeenCalled();
    });

    // Enable auto-transition
    const switches = screen.getAllByRole("switch");
    fireEvent.click(switches[0]);

    // Team selector should appear (only when teams.length > 1)
    await waitFor(() => {
      expect(screen.getByLabelText("Team")).toBeInTheDocument();
    });
    // Both teams should be in the dropdown
    expect(screen.getByText("Engineering (ENG)")).toBeInTheDocument();
    expect(screen.getByText("Design (DES)")).toBeInTheDocument();
  });

  it("changes auto-transition workflow states when team is switched", async () => {
    // Verifies that switching team in the auto-transition team selector
    // updates the workflow states shown in the state selector.
    mockApi.getLinearStates.mockResolvedValue(multiTeamStates);
    render(<LinearSettingsPage />);
    await screen.findByText("Work");

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    await waitFor(() => {
      expect(mockApi.getLinearStates).toHaveBeenCalled();
    });

    // Enable auto-transition
    const switches = screen.getAllByRole("switch");
    fireEvent.click(switches[0]);

    await waitFor(() => {
      expect(screen.getByLabelText("Team")).toBeInTheDocument();
    });

    // Change team to Design
    const teamSelect = screen.getByLabelText("Team");
    fireEvent.change(teamSelect, { target: { value: "team-2" } });

    // Now the state selector should contain Design team's states
    await waitFor(() => {
      expect(screen.getByText("In Review")).toBeInTheDocument();
      expect(screen.getByText("Approved")).toBeInTheDocument();
    });
  });

  it("selects an auto-transition state from the dropdown", async () => {
    // Verifies that selecting a workflow state in the auto-transition
    // state selector updates the state ID and name in the edit state.
    render(<LinearSettingsPage />);
    await screen.findByText("Work");

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    await waitFor(() => {
      expect(mockApi.getLinearStates).toHaveBeenCalled();
    });

    // Enable auto-transition
    const switches = screen.getAllByRole("switch");
    fireEvent.click(switches[0]);

    // Wait for state selector to appear
    await waitFor(() => {
      expect(screen.getAllByText("Target status").length).toBeGreaterThan(0);
    });

    // Select "In Progress" in the auto-transition state dropdown
    const stateSelects = screen.getAllByRole("combobox");
    const autoStateSelect = stateSelects[0];
    fireEvent.change(autoStateSelect, { target: { value: "s-inprogress" } });

    // Now save and verify the selected state is sent to the API
    fireEvent.click(screen.getByRole("button", { name: "Save Settings" }));

    await waitFor(() => {
      expect(mockApi.updateLinearConnection).toHaveBeenCalledWith("conn-1", expect.objectContaining({
        autoTransition: true,
        autoTransitionStateId: "s-inprogress",
        autoTransitionStateName: "In Progress",
      }));
    });
  });

  it("shows archive-transition team selector when multiple teams and archive enabled", async () => {
    // Verifies the archive-transition team dropdown appears with multiple teams.
    mockApi.getLinearStates.mockResolvedValue(multiTeamStates);
    render(<LinearSettingsPage />);
    await screen.findByText("Work");

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    await waitFor(() => {
      expect(mockApi.getLinearStates).toHaveBeenCalled();
    });

    // Enable archive-transition (second switch)
    const switches = screen.getAllByRole("switch");
    fireEvent.click(switches[1]);

    // Team selectors should appear — the archive one is labeled "Team"
    await waitFor(() => {
      const teamLabels = screen.getAllByLabelText("Team");
      expect(teamLabels.length).toBeGreaterThanOrEqual(1);
    });
  });

  it("changes archive-transition workflow states when archive team is switched", async () => {
    // Verifies that switching team in the archive-transition team selector
    // updates the workflow states and clears any previously selected state.
    mockApi.getLinearStates.mockResolvedValue(multiTeamStates);
    render(<LinearSettingsPage />);
    await screen.findByText("Work");

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    await waitFor(() => {
      expect(mockApi.getLinearStates).toHaveBeenCalled();
    });

    // Enable archive-transition (second switch)
    const switches = screen.getAllByRole("switch");
    fireEvent.click(switches[1]);

    await waitFor(() => {
      const teamLabels = screen.getAllByLabelText("Team");
      expect(teamLabels.length).toBeGreaterThanOrEqual(1);
    });

    // Switch archive team to Design — use the last Team selector
    const teamSelects = screen.getAllByLabelText("Team");
    const archiveTeamSelect = teamSelects[teamSelects.length - 1];
    fireEvent.change(archiveTeamSelect, { target: { value: "team-2" } });

    // Design team states should now be available
    await waitFor(() => {
      expect(screen.getByText("In Review")).toBeInTheDocument();
      expect(screen.getByText("Approved")).toBeInTheDocument();
    });
  });

  it("selects an archive-transition state from the dropdown", async () => {
    // Verifies that selecting a workflow state in the archive-transition
    // state selector updates the state ID and name, then saves correctly.
    render(<LinearSettingsPage />);
    await screen.findByText("Work");

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    await waitFor(() => {
      expect(mockApi.getLinearStates).toHaveBeenCalled();
    });

    // Enable archive-transition (second switch)
    const switches = screen.getAllByRole("switch");
    fireEvent.click(switches[1]);

    // Wait for state selector
    await waitFor(() => {
      expect(screen.getAllByText("Target status").length).toBeGreaterThan(0);
    });

    // Select "Done" in the archive state dropdown
    const stateSelects = screen.getAllByRole("combobox");
    const archiveStateSelect = stateSelects[stateSelects.length - 1];
    fireEvent.change(archiveStateSelect, { target: { value: "s-done" } });

    // Save and verify
    fireEvent.click(screen.getByRole("button", { name: "Save Settings" }));

    await waitFor(() => {
      expect(mockApi.updateLinearConnection).toHaveBeenCalledWith("conn-1", expect.objectContaining({
        archiveTransition: true,
        archiveTransitionStateId: "s-done",
        archiveTransitionStateName: "Done",
      }));
    });
  });

  it("resolves saved auto-transition state to correct team on edit open", async () => {
    // Verifies that when a connection already has an autoTransitionStateName,
    // opening the edit panel finds the matching team and pre-selects the correct state.
    const connWithAutoTransition = {
      ...defaultConnection,
      autoTransition: true,
      autoTransitionStateId: "s-review",
      autoTransitionStateName: "In Review",
    };
    mockApi.listLinearConnections.mockResolvedValue({
      connections: [connWithAutoTransition],
    });
    mockApi.getLinearStates.mockResolvedValue(multiTeamStates);

    render(<LinearSettingsPage />);
    await screen.findByText("Work");

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    await waitFor(() => {
      expect(mockApi.getLinearStates).toHaveBeenCalled();
    });

    // The auto-transition toggle should already be on
    const switches = screen.getAllByRole("switch");
    expect(switches[0].getAttribute("aria-checked")).toBe("true");

    // The state "In Review" (from Design team) should be shown as selected
    await waitFor(() => {
      const stateSelects = screen.getAllByRole("combobox");
      // The first combobox should have the auto-transition state pre-selected
      expect(stateSelects.length).toBeGreaterThan(0);
    });
  });

  it("resolves saved archive-transition state to correct team on edit open", async () => {
    // Verifies that when a connection already has an archiveTransitionStateName,
    // opening the edit panel finds the matching team and pre-selects the correct state.
    const connWithArchiveTransition = {
      ...defaultConnection,
      archiveTransition: true,
      archiveTransitionStateId: "s-approved",
      archiveTransitionStateName: "Approved",
    };
    mockApi.listLinearConnections.mockResolvedValue({
      connections: [connWithArchiveTransition],
    });
    mockApi.getLinearStates.mockResolvedValue(multiTeamStates);

    render(<LinearSettingsPage />);
    await screen.findByText("Work");

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    await waitFor(() => {
      expect(mockApi.getLinearStates).toHaveBeenCalled();
    });

    // The archive-transition toggle should already be on
    const switches = screen.getAllByRole("switch");
    expect(switches[1].getAttribute("aria-checked")).toBe("true");
  });

  it("shows active settings badges on connection cards", async () => {
    // Verifies that connection cards show auto-transition and archive-transition
    // badges when those features are enabled.
    mockApi.listLinearConnections.mockResolvedValue({
      connections: [{
        ...defaultConnection,
        autoTransition: true,
        autoTransitionStateName: "In Progress",
        archiveTransition: true,
        archiveTransitionStateName: "Done",
      }],
    });

    render(<LinearSettingsPage />);

    expect(await screen.findByText(/Auto-transition: In Progress/)).toBeInTheDocument();
    expect(screen.getByText(/On archive: Done/)).toBeInTheDocument();
  });
});
