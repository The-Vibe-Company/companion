// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { axe } from "vitest-axe";
import { InstanceCard } from "./InstanceCard";

// Mock the API module to avoid real network calls
vi.mock("@/lib/api", () => ({
  api: {
    stopInstance: vi.fn(() => Promise.resolve()),
    startInstance: vi.fn(() => Promise.resolve()),
    deleteInstance: vi.fn(() => Promise.resolve()),
  },
}));

const mockOnAction = vi.fn();

const runningInstance = {
  id: "inst-1",
  hostname: "my-instance.example.com",
  machineStatus: "started",
  region: "iad",
  ownerType: "shared",
};

const stoppedInstance = {
  id: "inst-2",
  hostname: "stopped-instance.example.com",
  machineStatus: "stopped",
  region: "cdg",
  ownerType: "personal",
};

describe("InstanceCard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── Render tests ──────────────────────────────────────────────────────

  it("renders the instance hostname", () => {
    render(<InstanceCard instance={runningInstance} onActionComplete={mockOnAction} />);
    expect(screen.getByText("my-instance.example.com")).toBeDefined();
  });

  it("renders the region", () => {
    render(<InstanceCard instance={runningInstance} onActionComplete={mockOnAction} />);
    expect(screen.getByText("iad")).toBeDefined();
  });

  it("renders the owner type badge", () => {
    render(<InstanceCard instance={runningInstance} onActionComplete={mockOnAction} />);
    expect(screen.getByText("shared")).toBeDefined();
  });

  it("shows Open and Stop buttons for running instances", () => {
    render(<InstanceCard instance={runningInstance} onActionComplete={mockOnAction} />);
    expect(screen.getByText("Open")).toBeDefined();
    expect(screen.getByText("Stop")).toBeDefined();
  });

  it("shows Start button for stopped instances", () => {
    render(<InstanceCard instance={stoppedInstance} onActionComplete={mockOnAction} />);
    expect(screen.getByText("Start")).toBeDefined();
  });

  it("always shows Delete button", () => {
    render(<InstanceCard instance={runningInstance} onActionComplete={mockOnAction} />);
    expect(screen.getByText("Delete")).toBeDefined();
  });

  it("falls back to truncated ID when hostname is missing", () => {
    const noHostname = { ...runningInstance, hostname: null, id: "abcdefgh-1234-5678" };
    render(<InstanceCard instance={noHostname} onActionComplete={mockOnAction} />);
    expect(screen.getByText("abcdefgh")).toBeDefined();
  });

  // ── Interaction tests ─────────────────────────────────────────────────

  it("calls onActionComplete after a successful stop action", async () => {
    render(<InstanceCard instance={runningInstance} onActionComplete={mockOnAction} />);
    fireEvent.click(screen.getByText("Stop"));
    await waitFor(() => expect(mockOnAction).toHaveBeenCalledTimes(1));
  });

  it("prompts for confirmation before delete", () => {
    // Mock window.confirm to return false (user cancels)
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    render(<InstanceCard instance={runningInstance} onActionComplete={mockOnAction} />);
    fireEvent.click(screen.getByText("Delete"));
    expect(confirmSpy).toHaveBeenCalledWith("Delete this instance permanently?");
    expect(mockOnAction).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  // ── Accessibility ─────────────────────────────────────────────────────

  it("has no accessibility violations for running instance", async () => {
    const { container } = render(
      <InstanceCard instance={runningInstance} onActionComplete={mockOnAction} />,
    );
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  it("has no accessibility violations for stopped instance", async () => {
    const { container } = render(
      <InstanceCard instance={stoppedInstance} onActionComplete={mockOnAction} />,
    );
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});
