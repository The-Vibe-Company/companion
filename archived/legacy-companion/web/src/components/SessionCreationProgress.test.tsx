// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { SessionCreationProgress } from "./SessionCreationProgress.js";
import type { CreationProgressEvent } from "../types.js";

// ─── Rendering ─────────────────────────────────────────────────────────────

describe("SessionCreationProgress", () => {
  it("renders nothing when steps array is empty", () => {
    const { container } = render(<SessionCreationProgress steps={[]} />);
    expect(container.innerHTML).toBe("");
  });

  it("renders each step label", () => {
    const steps: CreationProgressEvent[] = [
      { step: "resolving_env", label: "Resolving environment...", status: "done" },
      { step: "launching_cli", label: "Launching Claude Code...", status: "in_progress" },
    ];
    render(<SessionCreationProgress steps={steps} />);
    expect(screen.getByText("Resolving environment...")).toBeDefined();
    expect(screen.getByText("Launching Claude Code...")).toBeDefined();
  });

  it("shows spinner for in_progress steps (via animate-spin class)", () => {
    const steps: CreationProgressEvent[] = [
      { step: "pulling_image", label: "Pulling Docker image...", status: "in_progress" },
    ];
    const { container } = render(<SessionCreationProgress steps={steps} />);
    // The spinner element has the animate-spin class
    const spinner = container.querySelector(".animate-spin");
    expect(spinner).not.toBeNull();
  });

  it("shows checkmark SVG for done steps", () => {
    const steps: CreationProgressEvent[] = [
      { step: "resolving_env", label: "Resolved", status: "done" },
    ];
    const { container } = render(<SessionCreationProgress steps={steps} />);
    // Done steps have a green checkmark SVG with the cc-success class
    const svg = container.querySelector(".text-cc-success");
    expect(svg).not.toBeNull();
  });

  it("shows X SVG for error steps", () => {
    const steps: CreationProgressEvent[] = [
      { step: "building_image", label: "Build failed", status: "error" },
    ];
    const { container } = render(<SessionCreationProgress steps={steps} />);
    // Error steps have a red X SVG with the cc-error class
    const svg = container.querySelector(".text-cc-error");
    expect(svg).not.toBeNull();
  });

  it("displays error message box when error prop is set", () => {
    const steps: CreationProgressEvent[] = [
      { step: "pulling_image", label: "Pull failed", status: "error" },
    ];
    render(
      <SessionCreationProgress
        steps={steps}
        error="Connection timed out after 30s"
      />,
    );
    expect(screen.getByText("Connection timed out after 30s")).toBeDefined();
  });

  it("does not show error box when error prop is absent", () => {
    const steps: CreationProgressEvent[] = [
      { step: "resolving_env", label: "Done", status: "done" },
    ];
    const { container } = render(<SessionCreationProgress steps={steps} />);
    // Error box has a specific bg class; should not be present
    const errorBox = container.querySelector(".bg-cc-error\\/5");
    expect(errorBox).toBeNull();
  });

  it("applies bold style to in_progress labels and muted style to done labels", () => {
    const steps: CreationProgressEvent[] = [
      { step: "resolving_env", label: "Done step", status: "done" },
      { step: "launching_cli", label: "Active step", status: "in_progress" },
    ];
    render(<SessionCreationProgress steps={steps} />);
    const doneLabel = screen.getByText("Done step");
    const activeLabel = screen.getByText("Active step");
    // Done labels have text-cc-muted, active labels have font-medium
    expect(doneLabel.className).toContain("text-cc-muted");
    expect(activeLabel.className).toContain("font-medium");
  });

  it("renders multiple steps in correct order", () => {
    // Verifies steps appear in the order provided (container session flow)
    const steps: CreationProgressEvent[] = [
      { step: "resolving_env", label: "Step 1", status: "done" },
      { step: "pulling_image", label: "Step 2", status: "done" },
      { step: "creating_container", label: "Step 3", status: "in_progress" },
    ];
    const { container } = render(<SessionCreationProgress steps={steps} />);
    const labels = Array.from(container.querySelectorAll("span.text-sm")).map(
      (el) => el.textContent,
    );
    expect(labels).toEqual(["Step 1", "Step 2", "Step 3"]);
  });
});
