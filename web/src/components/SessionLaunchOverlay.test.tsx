// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import { SessionLaunchOverlay } from "./SessionLaunchOverlay.js";
import type { CreationProgressEvent } from "../api.js";

// ─── Test Helpers ────────────────────────────────────────────────────────────

function makeStep(overrides: Partial<CreationProgressEvent> = {}): CreationProgressEvent {
  return {
    step: "step-1",
    label: "Starting session",
    status: "in_progress",
    ...overrides,
  };
}

describe("SessionLaunchOverlay", () => {
  // ── Render Tests ──────────────────────────────────────────────────────────

  // Test 1: Renders "Preparing..." when no steps exist
  it("shows 'Preparing...' when steps array is empty", () => {
    render(<SessionLaunchOverlay steps={[]} />);
    expect(screen.getByText("Preparing...")).toBeInTheDocument();
  });

  // Test 2: Shows current in-progress step label as subtitle
  // The label appears twice: once in the subtitle <p> and once in the step list <span>
  it("shows the current in-progress step label as subtitle", () => {
    const steps = [makeStep({ label: "Pulling image", status: "in_progress" })];
    const { container } = render(<SessionLaunchOverlay steps={steps} />);
    const subtitle = container.querySelector("p.text-sm.font-medium");
    expect(subtitle).toHaveTextContent("Pulling image");
  });

  // Test 3: Shows "Launching session..." when all steps are done
  it("shows 'Launching session...' when all steps are done", () => {
    const steps = [
      makeStep({ step: "s1", label: "Step 1", status: "done" }),
      makeStep({ step: "s2", label: "Step 2", status: "done" }),
    ];
    render(<SessionLaunchOverlay steps={steps} />);
    expect(screen.getByText("Launching session...")).toBeInTheDocument();
  });

  // Test 4: Shows "Something went wrong" on error
  it("shows 'Something went wrong' when a step has error status", () => {
    const steps = [makeStep({ status: "error", label: "Failed step" })];
    render(<SessionLaunchOverlay steps={steps} />);
    expect(screen.getByText("Something went wrong")).toBeInTheDocument();
  });

  // Test 5: Shows error detail string
  it("displays error detail string when provided", () => {
    render(<SessionLaunchOverlay steps={[]} error="Connection refused" />);
    expect(screen.getByText("Connection refused")).toBeInTheDocument();
  });

  // Test 6: Renders all step labels in the step list
  // "Connecting" appears twice (subtitle + step list), so we use getAllByText
  it("renders all step labels in the step list", () => {
    const steps = [
      makeStep({ step: "s1", label: "Initializing", status: "done" }),
      makeStep({ step: "s2", label: "Connecting", status: "in_progress" }),
    ];
    render(<SessionLaunchOverlay steps={steps} />);
    expect(screen.getByText("Initializing")).toBeInTheDocument();
    // "Connecting" appears in both the subtitle and step list
    const connectingElements = screen.getAllByText("Connecting");
    expect(connectingElements.length).toBe(2);
  });

  // Test 7: Shows step detail for in-progress steps
  it("shows step detail for in-progress steps", () => {
    const steps = [
      makeStep({ step: "s1", label: "Pulling", status: "in_progress", detail: "node:20-slim" }),
    ];
    render(<SessionLaunchOverlay steps={steps} />);
    expect(screen.getByText("node:20-slim")).toBeInTheDocument();
  });

  // Test 8: Does not show step detail for done steps
  it("does not show step detail for done steps", () => {
    const steps = [
      makeStep({ step: "s1", label: "Pulling", status: "done", detail: "node:20-slim" }),
    ];
    render(<SessionLaunchOverlay steps={steps} />);
    expect(screen.queryByText("node:20-slim")).not.toBeInTheDocument();
  });

  // ── Logo Variations ───────────────────────────────────────────────────────

  // Test 9: Uses Claude logo by default
  it("uses /logo.svg for claude backend", () => {
    const { container } = render(<SessionLaunchOverlay steps={[]} backend="claude" />);
    const img = container.querySelector("img");
    expect(img).toHaveAttribute("src", "/logo.svg");
  });

  // Test 10: Uses Codex logo for codex backend
  it("uses /logo-codex.svg for codex backend", () => {
    const { container } = render(<SessionLaunchOverlay steps={[]} backend="codex" />);
    const img = container.querySelector("img");
    expect(img).toHaveAttribute("src", "/logo-codex.svg");
  });

  // ── Cancel/Dismiss Button ─────────────────────────────────────────────────

  // Test 11: Shows Cancel button when in progress with onCancel
  it("shows 'Cancel' button when in progress and onCancel is provided", () => {
    const steps = [makeStep({ status: "in_progress" })];
    render(<SessionLaunchOverlay steps={steps} onCancel={() => {}} />);
    expect(screen.getByText("Cancel")).toBeInTheDocument();
  });

  // Test 12: Shows Dismiss button on error with onCancel
  it("shows 'Dismiss' button when there is an error and onCancel is provided", () => {
    const steps = [makeStep({ status: "error" })];
    render(<SessionLaunchOverlay steps={steps} onCancel={() => {}} />);
    expect(screen.getByText("Dismiss")).toBeInTheDocument();
  });

  // Test 13: Cancel button not shown without onCancel
  it("does not show cancel/dismiss button without onCancel prop", () => {
    const steps = [makeStep({ status: "in_progress" })];
    render(<SessionLaunchOverlay steps={steps} />);
    expect(screen.queryByText("Cancel")).not.toBeInTheDocument();
  });

  // Test 14: Clicking Cancel calls onCancel
  it("clicking Cancel calls onCancel", () => {
    const onCancel = vi.fn();
    const steps = [makeStep({ status: "in_progress" })];
    render(<SessionLaunchOverlay steps={steps} onCancel={onCancel} />);
    fireEvent.click(screen.getByText("Cancel"));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  // ── Progress Bar ──────────────────────────────────────────────────────────

  // Test 15: Progress bar is rendered when steps exist and no error
  it("renders progress bar when steps exist and no error", () => {
    const steps = [
      makeStep({ step: "s1", status: "done" }),
      makeStep({ step: "s2", status: "in_progress" }),
    ];
    const { container } = render(<SessionLaunchOverlay steps={steps} />);
    // Progress bar is the last absolute-positioned div at bottom
    const progressBar = container.querySelector(".absolute.bottom-0");
    expect(progressBar).toBeInTheDocument();
  });

  // Test 16: No progress bar when there is an error
  it("does not render progress bar when there is an error", () => {
    const steps = [makeStep({ step: "s1", status: "error" })];
    const { container } = render(<SessionLaunchOverlay steps={steps} />);
    const progressBar = container.querySelector(".absolute.bottom-0");
    expect(progressBar).not.toBeInTheDocument();
  });

  // ── Accessibility ─────────────────────────────────────────────────────────

  // Test 17: Accessibility scan — in progress state
  it("passes axe accessibility checks during progress", async () => {
    const { axe } = await import("vitest-axe");
    const steps = [
      makeStep({ step: "s1", label: "Pulling image", status: "done" }),
      makeStep({ step: "s2", label: "Starting container", status: "in_progress" }),
    ];
    const { container } = render(
      <SessionLaunchOverlay steps={steps} backend="claude" onCancel={() => {}} />,
    );
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  // Test 18: Accessibility scan — error state
  it("passes axe accessibility checks in error state", async () => {
    const { axe } = await import("vitest-axe");
    const steps = [makeStep({ step: "s1", label: "Failed", status: "error" })];
    const { container } = render(
      <SessionLaunchOverlay steps={steps} error="Timeout" onCancel={() => {}} />,
    );
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  // Test 19: Accessibility scan — all done state
  it("passes axe accessibility checks when all steps done", async () => {
    const { axe } = await import("vitest-axe");
    const steps = [
      makeStep({ step: "s1", label: "Step 1", status: "done" }),
      makeStep({ step: "s2", label: "Step 2", status: "done" }),
    ];
    const { container } = render(<SessionLaunchOverlay steps={steps} />);
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});
