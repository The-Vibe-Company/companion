// @vitest-environment jsdom
/**
 * Tests for WizardStepAgent component.
 *
 * Validates:
 * - Default rendering with pre-filled values
 * - Agent creation with correct API payload
 * - Validation: empty name and empty prompt
 * - Error handling when API call fails
 * - Backend toggle (claude ↔ codex)
 * - FolderPicker integration
 * - Back button navigation
 * - Accessibility (axe scan)
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";

const mockApi = {
  createAgent: vi.fn(),
};

vi.mock("../../api.js", () => ({
  api: {
    createAgent: (...args: unknown[]) => mockApi.createAgent(...args),
  },
}));

// Mock FolderPicker to avoid file-system API calls
vi.mock("../FolderPicker.js", () => ({
  FolderPicker: ({ onSelect, onClose }: { onSelect: (path: string) => void; onClose: () => void }) => (
    <div data-testid="folder-picker">
      <button onClick={() => onSelect("/home/user/project")}>Select Folder</button>
      <button onClick={onClose}>Close Picker</button>
    </div>
  ),
}));

import { WizardStepAgent } from "./WizardStepAgent.js";

beforeEach(() => {
  vi.clearAllMocks();
  mockApi.createAgent.mockResolvedValue({
    id: "agent-123",
    name: "Linear Agent",
  });
});

describe("WizardStepAgent", () => {
  const defaultProps = {
    onNext: vi.fn(),
    onBack: vi.fn(),
    oauthConnectionId: null as string | null,
    stagingId: null as string | null,
    cloneFromAgentId: null as string | null,
  };

  // ─── Rendering ──────────────────────────────────────────────────────────────

  it("renders with default values", () => {
    render(<WizardStepAgent {...defaultProps} />);

    expect(screen.getByRole("heading", { name: "Configure Your Agent" })).toBeInTheDocument();
    expect(screen.getByLabelText("Agent Name")).toHaveValue("Linear Agent");
    expect(screen.getByText("Linear Agent trigger enabled")).toBeInTheDocument();
    expect(screen.getByText("Create Agent")).toBeInTheDocument();
    expect(screen.getByText("Back")).toBeInTheDocument();
    // Claude backend selected by default
    expect(screen.getByText("Claude Code")).toBeInTheDocument();
    expect(screen.getByText("Codex")).toBeInTheDocument();
  });

  // ─── Agent Creation ─────────────────────────────────────────────────────────

  it("creates agent with correct payload", async () => {
    const onNext = vi.fn();
    render(<WizardStepAgent {...defaultProps} onNext={onNext} />);

    fireEvent.click(screen.getByText("Create Agent"));

    await waitFor(() => {
      expect(mockApi.createAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "Linear Agent",
          backendType: "claude",
          permissionMode: "bypassPermissions",
          triggers: expect.objectContaining({
            linear: { enabled: true },
          }),
          enabled: true,
        }),
      );
    });

    await waitFor(() => {
      expect(onNext).toHaveBeenCalledWith("agent-123", "Linear Agent");
    });
  });

  it("creates agent with custom name", async () => {
    const onNext = vi.fn();
    mockApi.createAgent.mockResolvedValue({ id: "agent-456", name: "My Custom Agent" });

    render(<WizardStepAgent {...defaultProps} onNext={onNext} />);

    fireEvent.change(screen.getByLabelText("Agent Name"), { target: { value: "My Custom Agent" } });
    fireEvent.click(screen.getByText("Create Agent"));

    await waitFor(() => {
      expect(mockApi.createAgent).toHaveBeenCalledWith(
        expect.objectContaining({ name: "My Custom Agent" }),
      );
    });

    await waitFor(() => {
      expect(onNext).toHaveBeenCalledWith("agent-456", "My Custom Agent");
    });
  });

  // ─── Validation ─────────────────────────────────────────────────────────────

  it("shows error when name is empty", async () => {
    render(<WizardStepAgent {...defaultProps} />);

    // Clear the name
    fireEvent.change(screen.getByLabelText("Agent Name"), { target: { value: "" } });
    fireEvent.click(screen.getByText("Create Agent"));

    expect(screen.getByText("Agent name is required.")).toBeInTheDocument();
    expect(mockApi.createAgent).not.toHaveBeenCalled();
  });

  it("shows error when prompt is empty", async () => {
    render(<WizardStepAgent {...defaultProps} />);

    // Clear the prompt
    fireEvent.change(screen.getByLabelText("Prompt"), { target: { value: "" } });
    fireEvent.click(screen.getByText("Create Agent"));

    expect(screen.getByText("Agent prompt is required.")).toBeInTheDocument();
    expect(mockApi.createAgent).not.toHaveBeenCalled();
  });

  // ─── Error Handling ─────────────────────────────────────────────────────────

  it("shows error when API call fails", async () => {
    mockApi.createAgent.mockRejectedValue(new Error("Agent name already exists"));

    render(<WizardStepAgent {...defaultProps} />);

    fireEvent.click(screen.getByText("Create Agent"));

    await waitFor(() => {
      expect(screen.getByText("Agent name already exists")).toBeInTheDocument();
    });

    // Button should be re-enabled after error
    expect(screen.getByText("Create Agent")).not.toBeDisabled();
  });

  // ─── Backend Toggle ─────────────────────────────────────────────────────────

  it("toggles backend between claude and codex", async () => {
    render(<WizardStepAgent {...defaultProps} />);

    // Switch to Codex
    fireEvent.click(screen.getByText("Codex"));

    fireEvent.click(screen.getByText("Create Agent"));

    await waitFor(() => {
      expect(mockApi.createAgent).toHaveBeenCalledWith(
        expect.objectContaining({ backendType: "codex" }),
      );
    });
  });

  // ─── Back Button ────────────────────────────────────────────────────────────

  it("calls onBack when Back button is clicked", () => {
    const onBack = vi.fn();
    render(<WizardStepAgent {...defaultProps} onBack={onBack} />);

    fireEvent.click(screen.getByText("Back"));
    expect(onBack).toHaveBeenCalledOnce();
  });

  // ─── FolderPicker ───────────────────────────────────────────────────────────

  it("opens and uses folder picker to set working directory", async () => {
    render(<WizardStepAgent {...defaultProps} />);

    // Default shows "Temp directory"
    expect(screen.getByText("Temp directory")).toBeInTheDocument();

    // Click working directory button to open picker
    fireEvent.click(screen.getByText("Temp directory"));

    // Picker should appear
    expect(screen.getByTestId("folder-picker")).toBeInTheDocument();

    // Select a folder
    fireEvent.click(screen.getByText("Select Folder"));

    // Picker should close and show selected folder name
    expect(screen.queryByTestId("folder-picker")).not.toBeInTheDocument();
    expect(screen.getByText("project")).toBeInTheDocument();
  });

  it("clears working directory via the clear button", async () => {
    render(<WizardStepAgent {...defaultProps} />);

    // Open picker and select a folder
    fireEvent.click(screen.getByText("Temp directory"));
    fireEvent.click(screen.getByText("Select Folder"));

    // Should show the folder name now
    expect(screen.getByText("project")).toBeInTheDocument();

    // The clear button is an SVG inside the CWD button; find it by its parent structure
    // The clear icon is the second svg inside the working directory button area
    const cwdButton = screen.getByText("project").closest("button")!;
    const clearIcon = cwdButton.querySelector("svg:last-of-type")!;
    fireEvent.click(clearIcon);

    // Should revert to "Temp directory"
    expect(screen.getByText("Temp directory")).toBeInTheDocument();
  });

  it("closes folder picker without selecting", () => {
    render(<WizardStepAgent {...defaultProps} />);

    fireEvent.click(screen.getByText("Temp directory"));
    expect(screen.getByTestId("folder-picker")).toBeInTheDocument();

    fireEvent.click(screen.getByText("Close Picker"));
    expect(screen.queryByTestId("folder-picker")).not.toBeInTheDocument();

    // Should still show Temp directory
    expect(screen.getByText("Temp directory")).toBeInTheDocument();
  });

  // ─── Accessibility ──────────────────────────────────────────────────────────

  it("passes axe accessibility checks", async () => {
    const { axe } = await import("vitest-axe");
    const { container } = render(<WizardStepAgent {...defaultProps} />);
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});
