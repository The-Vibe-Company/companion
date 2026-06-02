// @vitest-environment jsdom
/**
 * Tests for WizardStepDone component.
 *
 * Validates:
 * - Success header renders with the provided agent name
 * - Status checklist items display correctly (OAuth, agent created, ready)
 * - "Go to Agents" button calls onFinish
 * - "Create Another Agent" progressive disclosure:
 *   - Button appears only when at least one add-another callback is provided
 *   - Clicking it reveals the choice panel with "Same OAuth app" / "Different OAuth app"
 *   - Each choice button calls the correct callback
 * - Button is hidden when neither add-another callback is provided
 * - Next-steps links render with correct hrefs
 * - Accessibility (axe scan)
 */
import { fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";

import { WizardStepDone } from "./WizardStepDone.js";

describe("WizardStepDone", () => {
  const defaultProps = {
    agentName: "My Linear Agent",
    onFinish: vi.fn(),
    onAddAnotherSameApp: vi.fn(),
    onAddAnotherNewApp: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ─── Rendering ──────────────────────────────────────────────────────────────

  it("renders the success header with the agent name", () => {
    render(<WizardStepDone {...defaultProps} />);

    // "Complete" label
    expect(screen.getByText("Complete")).toBeInTheDocument();
    // Heading shows "<agentName> is live"
    expect(screen.getByText("My Linear Agent is live")).toBeInTheDocument();
    // Description text
    expect(
      screen.getByText("Your agent is connected and listening for @mentions in Linear."),
    ).toBeInTheDocument();
  });

  it("renders all three status checklist items", () => {
    render(<WizardStepDone {...defaultProps} />);

    expect(screen.getByText("OAuth app connected")).toBeInTheDocument();
    expect(screen.getByText("Your Linear workspace is linked")).toBeInTheDocument();

    expect(screen.getByText(/Agent "My Linear Agent" created/)).toBeInTheDocument();
    expect(screen.getByText("Linear trigger enabled with full auto permissions")).toBeInTheDocument();

    expect(screen.getByText("Ready for @mentions")).toBeInTheDocument();
    expect(
      screen.getByText("Mention the agent in any issue to trigger a session"),
    ).toBeInTheDocument();
  });

  it("renders next-steps section with correct links", () => {
    render(<WizardStepDone {...defaultProps} />);

    expect(screen.getByText("Next steps")).toBeInTheDocument();

    const agentsLink = screen.getByRole("link", { name: "Agents page" });
    expect(agentsLink).toHaveAttribute("href", "#/agents");

    const settingsLink = screen.getByRole("link", { name: "OAuth Settings" });
    expect(settingsLink).toHaveAttribute("href", "#/integrations/linear-oauth");
  });

  // ─── Go to Agents Button ─────────────────────────────────────────────────────

  it("calls onFinish when 'Go to Agents' button is clicked", () => {
    const onFinish = vi.fn();
    render(<WizardStepDone {...defaultProps} onFinish={onFinish} />);

    fireEvent.click(screen.getByText("Go to Agents"));
    expect(onFinish).toHaveBeenCalledOnce();
  });

  // ─── Create Another Agent: Progressive Disclosure ─────────────────────────────

  it("shows 'Create Another Agent' button when callbacks are provided", () => {
    render(<WizardStepDone {...defaultProps} />);

    expect(screen.getByText("+ Create Another Agent")).toBeInTheDocument();
    // Choice panel should NOT be visible yet
    expect(screen.queryByText("Same OAuth app")).not.toBeInTheDocument();
    expect(screen.queryByText("Different OAuth app")).not.toBeInTheDocument();
  });

  it("reveals choice panel when 'Create Another Agent' is clicked", () => {
    render(<WizardStepDone {...defaultProps} />);

    fireEvent.click(screen.getByText("+ Create Another Agent"));

    // The trigger button should be hidden now (progressive disclosure replaces it)
    expect(screen.queryByText("+ Create Another Agent")).not.toBeInTheDocument();

    // Choice panel heading and description
    expect(screen.getByText("Create another agent")).toBeInTheDocument();
    expect(
      screen.getByText("Reuse the same OAuth connection or set up a new one?"),
    ).toBeInTheDocument();

    // Both choice buttons visible
    expect(screen.getByText("Same OAuth app")).toBeInTheDocument();
    expect(screen.getByText("Different OAuth app")).toBeInTheDocument();
  });

  it("calls onAddAnotherSameApp when 'Same OAuth app' is clicked", () => {
    const onAddAnotherSameApp = vi.fn();
    render(
      <WizardStepDone
        {...defaultProps}
        onAddAnotherSameApp={onAddAnotherSameApp}
      />,
    );

    // Open the choice panel
    fireEvent.click(screen.getByText("+ Create Another Agent"));
    // Click "Same OAuth app"
    fireEvent.click(screen.getByText("Same OAuth app"));

    expect(onAddAnotherSameApp).toHaveBeenCalledOnce();
  });

  it("calls onAddAnotherNewApp when 'Different OAuth app' is clicked", () => {
    const onAddAnotherNewApp = vi.fn();
    render(
      <WizardStepDone
        {...defaultProps}
        onAddAnotherNewApp={onAddAnotherNewApp}
      />,
    );

    // Open the choice panel
    fireEvent.click(screen.getByText("+ Create Another Agent"));
    // Click "Different OAuth app"
    fireEvent.click(screen.getByText("Different OAuth app"));

    expect(onAddAnotherNewApp).toHaveBeenCalledOnce();
  });

  // ─── Partial Callbacks ────────────────────────────────────────────────────────

  it("shows only 'Same OAuth app' when onAddAnotherNewApp is undefined", () => {
    render(
      <WizardStepDone
        agentName="Agent X"
        onFinish={vi.fn()}
        onAddAnotherSameApp={vi.fn()}
      />,
    );

    // Trigger button should still appear since one callback is provided
    fireEvent.click(screen.getByText("+ Create Another Agent"));

    expect(screen.getByText("Same OAuth app")).toBeInTheDocument();
    expect(screen.queryByText("Different OAuth app")).not.toBeInTheDocument();
  });

  it("shows only 'Different OAuth app' when onAddAnotherSameApp is undefined", () => {
    render(
      <WizardStepDone
        agentName="Agent Y"
        onFinish={vi.fn()}
        onAddAnotherNewApp={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByText("+ Create Another Agent"));

    expect(screen.queryByText("Same OAuth app")).not.toBeInTheDocument();
    expect(screen.getByText("Different OAuth app")).toBeInTheDocument();
  });

  // ─── No Callbacks ─────────────────────────────────────────────────────────────

  it("does not show 'Create Another Agent' when both callbacks are undefined", () => {
    render(
      <WizardStepDone
        agentName="Solo Agent"
        onFinish={vi.fn()}
      />,
    );

    // Neither the trigger button nor the choice panel should appear
    expect(screen.queryByText("+ Create Another Agent")).not.toBeInTheDocument();
    expect(screen.queryByText("Same OAuth app")).not.toBeInTheDocument();
    expect(screen.queryByText("Different OAuth app")).not.toBeInTheDocument();

    // "Go to Agents" should still be present
    expect(screen.getByText("Go to Agents")).toBeInTheDocument();
  });

  // ─── Accessibility ──────────────────────────────────────────────────────────

  it("passes axe accessibility checks (default state)", async () => {
    const { axe } = await import("vitest-axe");
    const { container } = render(<WizardStepDone {...defaultProps} />);
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  it("passes axe accessibility checks (choice panel expanded)", async () => {
    const { axe } = await import("vitest-axe");
    const { container } = render(<WizardStepDone {...defaultProps} />);

    fireEvent.click(screen.getByText("+ Create Another Agent"));

    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  it("passes axe accessibility checks (no add-another callbacks)", async () => {
    const { axe } = await import("vitest-axe");
    const { container } = render(
      <WizardStepDone agentName="Solo Agent" onFinish={vi.fn()} />,
    );
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});
