// @vitest-environment jsdom
/**
 * Tests for LinearOAuthSettingsPage component.
 *
 * Validates:
 * - Page heading and subheading render
 * - Connection list loads and displays with status badges
 * - Empty state when no connections exist
 * - Add Connection form toggle, validation, and submission
 * - Delete connection with two-click confirmation flow
 * - Reconnect / Manage button calls authorize URL API with status-aware labeling
 * - OAuth success/error banners from URL hash params
 * - Agents using each connection are displayed
 * - Back button navigation (home vs session)
 * - Back button hidden when embedded
 * - Accessibility (axe scan)
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";

// ─── Mock state ──────────────────────────────────────────────────────────────

interface MockStoreState {
  currentSessionId: string | null;
}

let mockState: MockStoreState;

const mockApi = {
  listLinearOAuthConnections: vi.fn(),
  createLinearOAuthConnection: vi.fn(),
  deleteLinearOAuthConnection: vi.fn(),
  getLinearOAuthConnectionAuthorizeUrl: vi.fn(),
  listAgents: vi.fn(),
};

vi.mock("../api.js", () => ({
  api: {
    listLinearOAuthConnections: (...args: unknown[]) => mockApi.listLinearOAuthConnections(...args),
    createLinearOAuthConnection: (...args: unknown[]) => mockApi.createLinearOAuthConnection(...args),
    deleteLinearOAuthConnection: (...args: unknown[]) => mockApi.deleteLinearOAuthConnection(...args),
    getLinearOAuthConnectionAuthorizeUrl: (...args: unknown[]) =>
      mockApi.getLinearOAuthConnectionAuthorizeUrl(...args),
    listAgents: (...args: unknown[]) => mockApi.listAgents(...args),
  },
}));

vi.mock("../store.js", () => {
  const useStoreFn = (selector: (state: MockStoreState) => unknown) => selector(mockState);
  useStoreFn.getState = () => mockState;
  return { useStore: useStoreFn };
});

const mockNavigateHome = vi.fn();
const mockNavigateToSession = vi.fn();
vi.mock("../utils/routing.js", () => ({
  navigateHome: (...args: unknown[]) => mockNavigateHome(...args),
  navigateToSession: (...args: unknown[]) => mockNavigateToSession(...args),
}));

// Mock LinearLogo to avoid SVG import issues
vi.mock("./LinearLogo.js", () => ({
  LinearLogo: ({ className }: { className?: string }) => (
    <span data-testid="linear-logo" className={className} />
  ),
}));

import { LinearOAuthSettingsPage } from "./LinearOAuthSettingsPage.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

const connectedConnection = {
  id: "conn-1",
  name: "Production App",
  oauthClientId: "client-id-abc123",
  status: "connected" as const,
  hasAccessToken: true,
  hasClientSecret: true,
  hasWebhookSecret: true,
  createdAt: Date.now(),
  updatedAt: Date.now(),
};

const disconnectedConnection = {
  id: "conn-2",
  name: "Dev App",
  oauthClientId: "client-id-xyz789",
  status: "disconnected" as const,
  hasAccessToken: false,
  hasClientSecret: true,
  hasWebhookSecret: true,
  createdAt: Date.now(),
  updatedAt: Date.now(),
};

beforeEach(() => {
  vi.clearAllMocks();
  mockState = { currentSessionId: null };
  mockApi.listLinearOAuthConnections.mockResolvedValue({
    connections: [connectedConnection, disconnectedConnection],
  });
  mockApi.listAgents.mockResolvedValue([]);
  mockApi.createLinearOAuthConnection.mockResolvedValue({
    connection: { ...connectedConnection, id: "conn-new", name: "New App" },
  });
  mockApi.deleteLinearOAuthConnection.mockResolvedValue({});
  mockApi.getLinearOAuthConnectionAuthorizeUrl.mockResolvedValue({
    url: "https://linear.app/oauth/authorize?client_id=test",
  });
  window.location.hash = "#/integrations/linear-oauth";
});

afterEach(() => {
  window.location.hash = "";
});

// =============================================================================
// Tests
// =============================================================================

describe("LinearOAuthSettingsPage", () => {
  // ─── Basic rendering ──────────────────────────────────────────────────────

  it("renders page heading and subheading", async () => {
    render(<LinearOAuthSettingsPage />);

    await waitFor(() => {
      expect(screen.getByRole("heading", { level: 1, name: "Linear OAuth Apps" })).toBeInTheDocument();
    });
    expect(
      screen.getByText("Manage OAuth app connections for Linear agent integrations."),
    ).toBeInTheDocument();
  });

  it("renders the hero banner with status summary", async () => {
    render(<LinearOAuthSettingsPage />);

    await waitFor(() => {
      expect(screen.getByText("1 connected")).toBeInTheDocument();
    });
    expect(screen.getByText("2 connections configured")).toBeInTheDocument();
  });

  // ─── Accessibility ────────────────────────────────────────────────────────

  it("passes axe accessibility checks", async () => {
    const { axe } = await import("vitest-axe");
    // Wrap in <main> to satisfy the axe "region" landmark rule in isolated test
    render(<main><LinearOAuthSettingsPage /></main>);

    await waitFor(() => {
      expect(screen.getByText("Production App")).toBeInTheDocument();
    });

    const results = await axe(document.body);
    expect(results).toHaveNoViolations();
  });

  // ─── Connection list ──────────────────────────────────────────────────────

  it("displays connections with name, status badge, and client ID", async () => {
    render(<LinearOAuthSettingsPage />);

    // Wait for connections to load
    await waitFor(() => {
      expect(screen.getByText("Production App")).toBeInTheDocument();
    });

    // Connected badge
    expect(screen.getByText("Connected")).toBeInTheDocument();
    // Disconnected badge
    expect(screen.getByText("Disconnected")).toBeInTheDocument();
    // Dev App name
    expect(screen.getByText("Dev App")).toBeInTheDocument();
    // Client IDs (truncated)
    expect(screen.getByText(/Client ID: client-id-abc123/)).toBeInTheDocument();
    expect(
      screen.getByText("Ready to receive @mentions and post updates back to Linear."),
    ).toBeInTheDocument();
    expect(
      screen.getByText("This app may already be installed in Linear, but Companion no longer has a valid OAuth token. Reconnect it to restore agent replies."),
    ).toBeInTheDocument();
  });

  it("shows loading state initially", () => {
    // Make the API call hang indefinitely
    mockApi.listLinearOAuthConnections.mockReturnValue(new Promise(() => {}));

    render(<LinearOAuthSettingsPage />);

    expect(screen.getByText("Loading connections...")).toBeInTheDocument();
  });

  it("shows empty state when no connections exist", async () => {
    mockApi.listLinearOAuthConnections.mockResolvedValue({ connections: [] });

    render(<LinearOAuthSettingsPage />);

    await waitFor(() => {
      expect(screen.getByText("No OAuth connections yet.")).toBeInTheDocument();
    });
    expect(
      screen.getByText("Add your first OAuth app connection to enable Linear agent integrations."),
    ).toBeInTheDocument();
  });

  it("shows error when loading connections fails", async () => {
    mockApi.listLinearOAuthConnections.mockRejectedValue(new Error("Network error"));

    render(<LinearOAuthSettingsPage />);

    await waitFor(() => {
      expect(screen.getByText("Network error")).toBeInTheDocument();
    });
  });

  // ─── Agents using connections ─────────────────────────────────────────────

  it("shows agents using each connection", async () => {
    // Agent that references conn-1
    mockApi.listAgents.mockResolvedValue([
      {
        id: "agent-1",
        name: "My Linear Bot",
        triggers: { linear: { enabled: true, oauthConnectionId: "conn-1" } },
      },
    ]);

    render(<LinearOAuthSettingsPage />);

    await waitFor(() => {
      expect(screen.getByText("Agent: My Linear Bot")).toBeInTheDocument();
    });
  });

  // ─── Add connection form ──────────────────────────────────────────────────

  it("toggles Add Connection form when button is clicked", async () => {
    render(<LinearOAuthSettingsPage />);

    await waitFor(() => {
      expect(screen.getByText("Add Connection")).toBeInTheDocument();
    });

    // Click "Add Connection" to show form
    fireEvent.click(screen.getByText("Add Connection"));

    // Form fields should appear
    expect(screen.getByLabelText("Connection Name")).toBeInTheDocument();
    expect(screen.getByLabelText("OAuth Client ID")).toBeInTheDocument();
    expect(screen.getByLabelText("OAuth Client Secret")).toBeInTheDocument();
    expect(screen.getByLabelText("Webhook Secret")).toBeInTheDocument();

    // Button text changes to "Cancel"
    expect(screen.getByText("Cancel")).toBeInTheDocument();

    // Click "Cancel" to hide form
    fireEvent.click(screen.getByText("Cancel"));
    expect(screen.queryByLabelText("Connection Name")).not.toBeInTheDocument();
  });

  it("submits form and creates a new connection", async () => {
    render(<LinearOAuthSettingsPage />);

    await waitFor(() => {
      expect(screen.getByText("Add Connection")).toBeInTheDocument();
    });

    // Open form
    fireEvent.click(screen.getByText("Add Connection"));

    // Fill in all fields
    fireEvent.change(screen.getByLabelText("Connection Name"), {
      target: { value: "New App" },
    });
    fireEvent.change(screen.getByLabelText("OAuth Client ID"), {
      target: { value: "new-client-id" },
    });
    fireEvent.change(screen.getByLabelText("OAuth Client Secret"), {
      target: { value: "new-client-secret" },
    });
    fireEvent.change(screen.getByLabelText("Webhook Secret"), {
      target: { value: "new-webhook-secret" },
    });

    // Submit
    fireEvent.click(screen.getByText("Save"));

    await waitFor(() => {
      expect(mockApi.createLinearOAuthConnection).toHaveBeenCalledWith({
        name: "New App",
        oauthClientId: "new-client-id",
        oauthClientSecret: "new-client-secret",
        webhookSecret: "new-webhook-secret",
      });
    });

    // Form should close and connections should reload
    await waitFor(() => {
      expect(screen.queryByLabelText("Connection Name")).not.toBeInTheDocument();
    });
  });

  it("shows validation error when form fields are empty", async () => {
    render(<LinearOAuthSettingsPage />);

    await waitFor(() => {
      expect(screen.getByText("Add Connection")).toBeInTheDocument();
    });

    // Open form
    fireEvent.click(screen.getByText("Add Connection"));

    // Save button should be disabled when fields are empty
    const saveButton = screen.getByText("Save");
    expect(saveButton).toBeDisabled();
  });

  it("shows API error when connection creation fails", async () => {
    mockApi.createLinearOAuthConnection.mockRejectedValue(new Error("Duplicate client ID"));

    render(<LinearOAuthSettingsPage />);

    await waitFor(() => {
      expect(screen.getByText("Add Connection")).toBeInTheDocument();
    });

    // Open form and fill in all fields
    fireEvent.click(screen.getByText("Add Connection"));
    fireEvent.change(screen.getByLabelText("Connection Name"), {
      target: { value: "App" },
    });
    fireEvent.change(screen.getByLabelText("OAuth Client ID"), {
      target: { value: "cid" },
    });
    fireEvent.change(screen.getByLabelText("OAuth Client Secret"), {
      target: { value: "csec" },
    });
    fireEvent.change(screen.getByLabelText("Webhook Secret"), {
      target: { value: "wsec" },
    });

    fireEvent.click(screen.getByText("Save"));

    await waitFor(() => {
      expect(screen.getByText("Duplicate client ID")).toBeInTheDocument();
    });
  });

  // ─── Delete connection ────────────────────────────────────────────────────

  it("requires two clicks to delete (confirmation flow)", async () => {
    render(<LinearOAuthSettingsPage />);

    await waitFor(() => {
      expect(screen.getByText("Production App")).toBeInTheDocument();
    });

    // Find all Delete buttons — there should be two (one per connection)
    const deleteButtons = screen.getAllByText("Delete");
    expect(deleteButtons.length).toBe(2);

    // First click on first Delete button → changes to "Confirm Delete"
    fireEvent.click(deleteButtons[0]);

    await waitFor(() => {
      expect(screen.getByText("Confirm Delete")).toBeInTheDocument();
    });

    // Second click (Confirm Delete) → triggers actual deletion
    fireEvent.click(screen.getByText("Confirm Delete"));

    await waitFor(() => {
      expect(mockApi.deleteLinearOAuthConnection).toHaveBeenCalledWith("conn-1");
    });
  });

  it("shows delete API error when deletion is blocked", async () => {
    mockApi.deleteLinearOAuthConnection.mockRejectedValue(
      new Error("Cannot delete: agents are using this OAuth connection"),
    );

    render(<LinearOAuthSettingsPage />);

    await waitFor(() => {
      expect(screen.getByText("Production App")).toBeInTheDocument();
    });

    const deleteButtons = screen.getAllByText("Delete");
    fireEvent.click(deleteButtons[0]);
    fireEvent.click(screen.getByText("Confirm Delete"));

    await waitFor(() => {
      expect(
        screen.getByText("Cannot delete: agents are using this OAuth connection"),
      ).toBeInTheDocument();
    });
  });

  // ─── Reconnect / Manage actions ───────────────────────────────────────────

  it("shows status-aware action labels", async () => {
    render(<LinearOAuthSettingsPage />);

    await waitFor(() => {
      expect(screen.getByText("Production App")).toBeInTheDocument();
    });

    expect(screen.getByText("Manage in Linear")).toBeInTheDocument();
    expect(screen.getByText("Reconnect to Workspace")).toBeInTheDocument();
  });

  it("calls authorize URL API when Reconnect to Workspace is clicked", async () => {
    // Mock window.open to prevent actual navigation
    const originalOpen = window.open;
    window.open = vi.fn();

    render(<LinearOAuthSettingsPage />);

    await waitFor(() => {
      expect(screen.getByText("Production App")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("Reconnect to Workspace"));

    await waitFor(() => {
      expect(mockApi.getLinearOAuthConnectionAuthorizeUrl).toHaveBeenCalledWith(
        "conn-2",
        "/#/integrations/linear-oauth",
      );
    });

    expect(window.open).toHaveBeenCalledWith(
      "https://linear.app/oauth/authorize?client_id=test",
      "_self",
    );

    window.open = originalOpen;
  });

  it("calls authorize URL API when Manage in Linear is clicked", async () => {
    const originalOpen = window.open;
    window.open = vi.fn();

    render(<LinearOAuthSettingsPage />);

    await waitFor(() => {
      expect(screen.getByText("Manage in Linear")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("Manage in Linear"));

    await waitFor(() => {
      expect(mockApi.getLinearOAuthConnectionAuthorizeUrl).toHaveBeenCalledWith(
        "conn-1",
        "/#/integrations/linear-oauth",
      );
    });

    expect(window.open).toHaveBeenCalledWith(
      "https://linear.app/oauth/authorize?client_id=test",
      "_self",
    );

    window.open = originalOpen;
  });

  // ─── OAuth return banners ─────────────────────────────────────────────────

  it("shows success banner when oauth_success=true is in URL hash", async () => {
    window.location.hash = "#/integrations/linear-oauth?oauth_success=true";

    render(<LinearOAuthSettingsPage />);

    await waitFor(() => {
      expect(
        screen.getByText("OAuth app connected to workspace successfully!"),
      ).toBeInTheDocument();
    });
  });

  it("shows error banner when oauth_error is in URL hash", async () => {
    window.location.hash = "#/integrations/linear-oauth?oauth_error=access_denied";

    render(<LinearOAuthSettingsPage />);

    await waitFor(() => {
      expect(screen.getByText("access_denied")).toBeInTheDocument();
    });
  });

  // ─── Navigation ───────────────────────────────────────────────────────────

  it("renders Integrations button that navigates to integrations page", async () => {
    render(<LinearOAuthSettingsPage />);

    await waitFor(() => {
      expect(screen.getByText("Integrations")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("Integrations"));

    expect(window.location.hash).toBe("#/integrations");
  });

  it("renders Back button when not embedded and navigates home when no session", async () => {
    mockState = { currentSessionId: null };
    render(<LinearOAuthSettingsPage />);

    await waitFor(() => {
      expect(screen.getByText("Back")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("Back"));

    expect(mockNavigateHome).toHaveBeenCalledTimes(1);
    expect(mockNavigateToSession).not.toHaveBeenCalled();
  });

  it("Back button navigates to session when currentSessionId is set", async () => {
    mockState = { currentSessionId: "session-abc" };
    render(<LinearOAuthSettingsPage />);

    await waitFor(() => {
      expect(screen.getByText("Back")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("Back"));

    expect(mockNavigateToSession).toHaveBeenCalledWith("session-abc");
    expect(mockNavigateHome).not.toHaveBeenCalled();
  });

  it("does not render Back button when embedded", async () => {
    render(<LinearOAuthSettingsPage embedded />);

    await waitFor(() => {
      expect(screen.getByText("Production App")).toBeInTheDocument();
    });

    expect(screen.queryByText("Back")).not.toBeInTheDocument();
  });

  // ─── Ticket settings link ─────────────────────────────────────────────────

  it("renders link to Linear Tickets Settings", async () => {
    render(<LinearOAuthSettingsPage />);

    await waitFor(() => {
      expect(screen.getByText("Linear Tickets Settings")).toBeInTheDocument();
    });

    const link = screen.getByText("Linear Tickets Settings");
    expect(link.closest("a")).toHaveAttribute("href", "#/settings/linear");
  });
});
