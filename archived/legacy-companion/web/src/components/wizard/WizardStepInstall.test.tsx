// @vitest-environment jsdom
/**
 * Tests for WizardStepInstall component.
 *
 * Validates:
 * - Connected state rendering (success message, Back/Next buttons)
 * - Not-connected state rendering (Install button, Back button)
 * - OAuth error display
 * - Install button triggers OAuth redirect flow
 * - Error handling when OAuth URL fetch fails
 * - Accessibility (axe scan)
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";

const mockApi = {
  getLinearOAuthAuthorizeUrl: vi.fn(),
};

vi.mock("../../api.js", () => ({
  api: {
    getLinearOAuthAuthorizeUrl: (...args: unknown[]) => mockApi.getLinearOAuthAuthorizeUrl(...args),
  },
}));

import { WizardStepInstall } from "./WizardStepInstall.js";

beforeEach(() => {
  vi.clearAllMocks();
  mockApi.getLinearOAuthAuthorizeUrl.mockResolvedValue({ url: "https://linear.app/oauth/authorize?..." });
});

describe("WizardStepInstall", () => {
  const defaultProps = {
    onNext: vi.fn(),
    onBack: vi.fn(),
    oauthConnected: false,
    oauthError: "",
    stagingId: null as string | null,
    onBeforeRedirect: vi.fn(),
  };

  // ─── Connected State ────────────────────────────────────────────────────────

  it("renders connected state with success message when oauthConnected is true", () => {
    render(<WizardStepInstall {...defaultProps} oauthConnected={true} />);

    expect(screen.getByRole("heading", { name: "Install to Workspace" })).toBeInTheDocument();
    expect(screen.getByText("Connected to Linear")).toBeInTheDocument();
    expect(screen.getByText("Next")).toBeInTheDocument();
    expect(screen.getByText("Back")).toBeInTheDocument();
  });

  it("calls onNext when Next button is clicked in connected state", () => {
    const onNext = vi.fn();
    render(<WizardStepInstall {...defaultProps} oauthConnected={true} onNext={onNext} />);

    fireEvent.click(screen.getByText("Next"));
    expect(onNext).toHaveBeenCalledOnce();
  });

  it("calls onBack when Back button is clicked in connected state", () => {
    const onBack = vi.fn();
    render(<WizardStepInstall {...defaultProps} oauthConnected={true} onBack={onBack} />);

    fireEvent.click(screen.getByText("Back"));
    expect(onBack).toHaveBeenCalledOnce();
  });

  // ─── Not Connected State ─────────────────────────────────────────────────────

  it("renders install button when not connected", () => {
    render(<WizardStepInstall {...defaultProps} />);

    expect(screen.getByRole("heading", { name: "Install to Workspace" })).toBeInTheDocument();
    expect(screen.getByText("Install to Workspace", { selector: "button" })).toBeInTheDocument();
    expect(screen.getByText("Back")).toBeInTheDocument();
    // No Next button when not connected
    expect(screen.queryByText("Next")).not.toBeInTheDocument();
  });

  it("calls onBack when Back button is clicked in not-connected state", () => {
    const onBack = vi.fn();
    render(<WizardStepInstall {...defaultProps} onBack={onBack} />);

    fireEvent.click(screen.getByText("Back"));
    expect(onBack).toHaveBeenCalledOnce();
  });

  // ─── OAuth Error ─────────────────────────────────────────────────────────────

  it("shows OAuth error when oauthError is provided", () => {
    render(<WizardStepInstall {...defaultProps} oauthError="access_denied" />);

    expect(screen.getByText("access_denied")).toBeInTheDocument();
  });

  // ─── Install Flow ────────────────────────────────────────────────────────────

  it("calls onBeforeRedirect and fetches OAuth URL on install click", async () => {
    const onBeforeRedirect = vi.fn();
    // Mock window.open to prevent actual navigation; restore in finally to avoid test pollution
    const originalOpen = window.open;
    window.open = vi.fn();

    try {
      render(<WizardStepInstall {...defaultProps} onBeforeRedirect={onBeforeRedirect} />);

      fireEvent.click(screen.getByText("Install to Workspace", { selector: "button" }));

      // Should show loading state
      expect(screen.getByText("Redirecting...")).toBeInTheDocument();

      await waitFor(() => {
        expect(onBeforeRedirect).toHaveBeenCalledOnce();
      });

      await waitFor(() => {
        expect(mockApi.getLinearOAuthAuthorizeUrl).toHaveBeenCalledWith("/#/agents", undefined);
      });

      await waitFor(() => {
        expect(window.open).toHaveBeenCalledWith("https://linear.app/oauth/authorize?...", "_self");
      });
    } finally {
      window.open = originalOpen;
    }
  });

  it("shows error when OAuth URL fetch fails", async () => {
    mockApi.getLinearOAuthAuthorizeUrl.mockRejectedValue(new Error("Network error"));

    render(<WizardStepInstall {...defaultProps} />);

    fireEvent.click(screen.getByText("Install to Workspace", { selector: "button" }));

    await waitFor(() => {
      expect(screen.getByText("Network error")).toBeInTheDocument();
    });

    // Install button should be re-enabled after error
    expect(screen.getByText("Install to Workspace", { selector: "button" })).not.toBeDisabled();
  });

  // ─── Accessibility ──────────────────────────────────────────────────────────

  it("passes axe accessibility checks (not connected)", async () => {
    const { axe } = await import("vitest-axe");
    const { container } = render(<WizardStepInstall {...defaultProps} />);
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  it("passes axe accessibility checks (connected)", async () => {
    const { axe } = await import("vitest-axe");
    const { container } = render(<WizardStepInstall {...defaultProps} oauthConnected={true} />);
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});
