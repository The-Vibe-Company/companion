// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { axe } from "vitest-axe";
import { CreateInstanceModal } from "./CreateInstanceModal";

// Mock the API module
const mockCreateInstanceStream = vi.fn();
const mockGetStatus = vi.fn();
vi.mock("@/lib/api", () => ({
  api: {
    createInstanceStream: (...args: any[]) => mockCreateInstanceStream(...args),
    getStatus: (...args: any[]) => mockGetStatus(...args),
  },
}));

const mockOnClose = vi.fn();
const mockOnCreated = vi.fn();

describe("CreateInstanceModal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetStatus.mockResolvedValue({
      service: "companion-cloud",
      version: "0.1.0",
      status: "ok",
      provisioning: {
        provider: "hetzner",
        regions: [
          { value: "iad", label: "US East (ASH)" },
          { value: "cdg", label: "Europe (FSN)" },
        ],
      },
    });
  });

  // ── Render tests ──────────────────────────────────────────────────────

  it("renders the modal with Create Instance heading", () => {
    render(<CreateInstanceModal onClose={mockOnClose} onInstanceCreated={mockOnCreated} />);
    // Both the heading and the button contain "Create Instance", so use getAllByText
    const elements = screen.getAllByText("Create Instance");
    expect(elements.length).toBeGreaterThanOrEqual(2); // heading + button
    // The heading is an h2 element
    const heading = elements.find((el) => el.tagName === "H2");
    expect(heading).toBeDefined();
  });

  it("renders plan selection buttons", () => {
    render(<CreateInstanceModal onClose={mockOnClose} onInstanceCreated={mockOnCreated} />);
    expect(screen.getByText("starter")).toBeDefined();
    expect(screen.getByText("pro")).toBeDefined();
    expect(screen.getByText("enterprise")).toBeDefined();
  });

  it("renders region selector", () => {
    render(<CreateInstanceModal onClose={mockOnClose} onInstanceCreated={mockOnCreated} />);
    expect(screen.getByText("Region")).toBeDefined();
  });

  it("renders ownership type selection", () => {
    render(<CreateInstanceModal onClose={mockOnClose} onInstanceCreated={mockOnCreated} />);
    expect(screen.getByText("shared")).toBeDefined();
    expect(screen.getByText("personal")).toBeDefined();
  });

  it("has dialog role and aria-modal", () => {
    render(<CreateInstanceModal onClose={mockOnClose} onInstanceCreated={mockOnCreated} />);
    const dialog = screen.getByRole("dialog");
    expect(dialog).toBeDefined();
    expect(dialog.getAttribute("aria-modal")).toBe("true");
  });

  // ── Interaction tests ─────────────────────────────────────────────────

  it("calls onClose when X button is clicked", () => {
    render(<CreateInstanceModal onClose={mockOnClose} onInstanceCreated={mockOnCreated} />);
    // The X button is the close button next to the heading
    const closeButtons = screen.getByRole("dialog").querySelectorAll("button");
    // Find the X button (it's the one in the header, not the create button)
    const xButton = Array.from(closeButtons).find(
      (btn) => !btn.textContent?.includes("Create") &&
               !btn.textContent?.includes("starter") &&
               !btn.textContent?.includes("pro") &&
               !btn.textContent?.includes("enterprise") &&
               !btn.textContent?.includes("shared") &&
               !btn.textContent?.includes("personal"),
    );
    if (xButton) fireEvent.click(xButton);
    expect(mockOnClose).toHaveBeenCalledTimes(1);
  });

  it("starts streaming when Create Instance button is clicked", async () => {
    // Simulate a successful SSE stream
    mockCreateInstanceStream.mockImplementation(async (_data: any, onProgress: any) => {
      onProgress({ step: "ensuring_app", label: "Creating server", status: "in_progress" });
      onProgress({ step: "ensuring_app", label: "Creating server", status: "done" });
      return { instance: { id: "inst-new" } };
    });

    render(<CreateInstanceModal onClose={mockOnClose} onInstanceCreated={mockOnCreated} />);

    // Find and click the Create Instance button (the main action button)
    const allButtons = screen.getByRole("dialog").querySelectorAll("button");
    const createBtn = Array.from(allButtons).find(
      (btn) => btn.textContent === "Create Instance",
    );
    expect(createBtn).toBeDefined();
    fireEvent.click(createBtn!);

    // Wait for the streaming to complete
    await waitFor(() => {
      expect(mockOnCreated).toHaveBeenCalledTimes(1);
      expect(mockOnClose).toHaveBeenCalledTimes(1);
    });
  });

  it("shows progress steps during streaming", async () => {
    // Mock that resolves after we can check the UI
    let resolveStream: (value: any) => void;
    mockCreateInstanceStream.mockImplementation(async (_data: any, onProgress: any) => {
      onProgress({ step: "creating_volume", label: "Creating storage volume", status: "in_progress" });
      // Return a promise that we control
      return new Promise((resolve) => { resolveStream = resolve; });
    });

    render(<CreateInstanceModal onClose={mockOnClose} onInstanceCreated={mockOnCreated} />);

    const allButtons = screen.getByRole("dialog").querySelectorAll("button");
    const createBtn = Array.from(allButtons).find(
      (btn) => btn.textContent === "Create Instance",
    );
    fireEvent.click(createBtn!);

    // Wait for the progress step to appear
    await waitFor(() => {
      expect(screen.getByText("Creating storage volume")).toBeDefined();
    });

    // Title should change to "Provisioning Instance"
    expect(screen.getByText("Provisioning Instance")).toBeDefined();

    // Clean up by resolving the stream
    resolveStream!({ instance: { id: "inst-1" } });
  });

  it("shows error message when streaming fails", async () => {
    mockCreateInstanceStream.mockRejectedValue(new Error("Network failure"));

    render(<CreateInstanceModal onClose={mockOnClose} onInstanceCreated={mockOnCreated} />);

    const allButtons = screen.getByRole("dialog").querySelectorAll("button");
    const createBtn = Array.from(allButtons).find(
      (btn) => btn.textContent === "Create Instance",
    );
    fireEvent.click(createBtn!);

    await waitFor(() => {
      expect(screen.getByText("Network failure")).toBeDefined();
    });

    // Dismiss button should appear
    expect(screen.getByText("Dismiss")).toBeDefined();
  });

  // ── Accessibility ─────────────────────────────────────────────────────

  it("has no accessibility violations", async () => {
    const { container } = render(
      <CreateInstanceModal onClose={mockOnClose} onInstanceCreated={mockOnCreated} />,
    );
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});
