// @vitest-environment jsdom
/**
 * Tests for WizardStepSelectConnection component.
 *
 * Validates:
 * - Heading and description render
 * - Connections load and display with status badges
 * - Auto-selects single connection
 * - Auto-selects pre-selected connection ID
 * - Empty state with link to OAuth settings
 * - Loading state
 * - Error state when API fails
 * - Connected vs disconnected connection handling (Next disabled for disconnected)
 * - Back/Next button behavior
 * - "Create a new OAuth connection" link
 * - Accessibility (axe scan)
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";

// ─── Mock state ──────────────────────────────────────────────────────────────

const mockApi = {
  listLinearOAuthConnections: vi.fn(),
};

vi.mock("../../api.js", () => ({
  api: {
    listLinearOAuthConnections: (...args: unknown[]) => mockApi.listLinearOAuthConnections(...args),
  },
}));

import { WizardStepSelectConnection } from "./WizardStepSelectConnection.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

const connectedConnection = {
  id: "conn-1",
  name: "Production App",
  oauthClientId: "client-abc",
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
  oauthClientId: "client-xyz",
  status: "disconnected" as const,
  hasAccessToken: false,
  hasClientSecret: true,
  hasWebhookSecret: true,
  createdAt: Date.now(),
  updatedAt: Date.now(),
};

const defaultProps = {
  onNext: vi.fn(),
  onBack: vi.fn(),
};

beforeEach(() => {
  vi.clearAllMocks();
  mockApi.listLinearOAuthConnections.mockResolvedValue({
    connections: [connectedConnection, disconnectedConnection],
  });
});

// =============================================================================
// Tests
// =============================================================================

describe("WizardStepSelectConnection", () => {
  // ─── Basic rendering ──────────────────────────────────────────────────────

  it("renders heading and description", async () => {
    render(<WizardStepSelectConnection {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByText("Select OAuth Connection")).toBeInTheDocument();
    });
    expect(
      screen.getByText("Choose which Linear OAuth app this agent should use for @mention triggers."),
    ).toBeInTheDocument();
  });

  // ─── Accessibility ────────────────────────────────────────────────────────

  it("passes axe accessibility checks", async () => {
    const { axe } = await import("vitest-axe");
    // Wrap in <main> to satisfy the axe "region" landmark rule in isolated test
    render(<main><WizardStepSelectConnection {...defaultProps} /></main>);

    await waitFor(() => {
      expect(screen.getByText("Production App")).toBeInTheDocument();
    });

    const results = await axe(document.body);
    expect(results).toHaveNoViolations();
  });

  // ─── Connection list ──────────────────────────────────────────────────────

  it("displays connections with name and status badges", async () => {
    render(<WizardStepSelectConnection {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByText("Production App")).toBeInTheDocument();
    });

    expect(screen.getByText("Dev App")).toBeInTheDocument();
    expect(screen.getByText("Connected")).toBeInTheDocument();
    expect(screen.getByText("Not installed")).toBeInTheDocument();
  });

  it("shows loading state", () => {
    // Make the API hang
    mockApi.listLinearOAuthConnections.mockReturnValue(new Promise(() => {}));

    render(<WizardStepSelectConnection {...defaultProps} />);

    expect(screen.getByText("Loading connections...")).toBeInTheDocument();
  });

  it("shows error state when API fails", async () => {
    mockApi.listLinearOAuthConnections.mockRejectedValue(new Error("Network error"));

    render(<WizardStepSelectConnection {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByText("Network error")).toBeInTheDocument();
    });
  });

  // ─── Empty state ──────────────────────────────────────────────────────────

  it("shows empty state with link to OAuth settings when no connections", async () => {
    mockApi.listLinearOAuthConnections.mockResolvedValue({ connections: [] });

    render(<WizardStepSelectConnection {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByText("No OAuth connections found.")).toBeInTheDocument();
    });
    expect(screen.getByText("Go to OAuth Settings")).toBeInTheDocument();
    expect(screen.getByText("Go to OAuth Settings").closest("a")).toHaveAttribute(
      "href",
      "#/integrations/linear-oauth",
    );
  });

  // ─── Auto-selection ───────────────────────────────────────────────────────

  it("auto-selects when only one connection exists", async () => {
    // Only one connection
    mockApi.listLinearOAuthConnections.mockResolvedValue({
      connections: [connectedConnection],
    });

    render(<WizardStepSelectConnection {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByText("Production App")).toBeInTheDocument();
    });

    // Next should be enabled (auto-selected connected connection)
    const nextButton = screen.getByText("Next");
    expect(nextButton).not.toBeDisabled();
  });

  it("auto-selects pre-selected connection ID", async () => {
    render(
      <WizardStepSelectConnection {...defaultProps} selectedConnectionId="conn-1" />,
    );

    await waitFor(() => {
      expect(screen.getByText("Production App")).toBeInTheDocument();
    });

    // Next should be enabled (pre-selected connected connection)
    const nextButton = screen.getByText("Next");
    expect(nextButton).not.toBeDisabled();
  });

  // ─── Selection behavior ───────────────────────────────────────────────────

  it("allows selecting a connection by clicking", async () => {
    render(<WizardStepSelectConnection {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByText("Production App")).toBeInTheDocument();
    });

    // Click on the connected connection
    fireEvent.click(screen.getByText("Production App"));

    // Next should be enabled
    const nextButton = screen.getByText("Next");
    expect(nextButton).not.toBeDisabled();
  });

  it("disables Next when a disconnected connection is selected", async () => {
    render(<WizardStepSelectConnection {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByText("Dev App")).toBeInTheDocument();
    });

    // Click on the disconnected connection
    fireEvent.click(screen.getByText("Dev App"));

    // Next should be disabled (disconnected connection)
    const nextButton = screen.getByText("Next");
    expect(nextButton).toBeDisabled();

    // Should show warning about needing to install
    await waitFor(() => {
      expect(
        screen.getByText(/This connection needs to be installed to a workspace first/),
      ).toBeInTheDocument();
    });
  });

  // ─── Navigation ───────────────────────────────────────────────────────────

  it("calls onNext with selected connection ID when Next is clicked", async () => {
    mockApi.listLinearOAuthConnections.mockResolvedValue({
      connections: [connectedConnection],
    });

    render(<WizardStepSelectConnection {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByText("Production App")).toBeInTheDocument();
    });

    // Connection should be auto-selected (only one), click Next
    fireEvent.click(screen.getByText("Next"));

    expect(defaultProps.onNext).toHaveBeenCalledWith("conn-1");
  });

  it("calls onBack when Back is clicked", async () => {
    render(<WizardStepSelectConnection {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByText("Back")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("Back"));

    expect(defaultProps.onBack).toHaveBeenCalledTimes(1);
  });

  it("disables Next when no connection is selected", async () => {
    render(<WizardStepSelectConnection {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByText("Production App")).toBeInTheDocument();
    });

    // No connection selected by default when multiple exist
    const nextButton = screen.getByText("Next");
    expect(nextButton).toBeDisabled();
  });

  // ─── Create new connection link ───────────────────────────────────────────

  it("shows link to create a new OAuth connection", async () => {
    render(<WizardStepSelectConnection {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByText("+ Create a new OAuth connection")).toBeInTheDocument();
    });

    const link = screen.getByText("+ Create a new OAuth connection");
    expect(link.closest("a")).toHaveAttribute("href", "#/integrations/linear-oauth");
  });
});
