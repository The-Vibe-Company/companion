// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { axe } from "vitest-axe";
import { EmptyState } from "./EmptyState";

describe("EmptyState", () => {
  // ── Render tests ──────────────────────────────────────────────────────

  it("renders the empty state heading", () => {
    render(<EmptyState onInstanceCreated={vi.fn()} />);
    expect(screen.getByText("No instances yet")).toBeDefined();
  });

  it("renders a descriptive message", () => {
    render(<EmptyState onInstanceCreated={vi.fn()} />);
    expect(
      screen.getByText(/Create your first Companion instance/),
    ).toBeDefined();
  });

  it("renders a Create Instance button", () => {
    render(<EmptyState onInstanceCreated={vi.fn()} />);
    expect(screen.getByText("Create Instance")).toBeDefined();
  });

  // ── Interaction tests ─────────────────────────────────────────────────

  it("opens create modal when the button is clicked", () => {
    render(<EmptyState onInstanceCreated={vi.fn()} />);
    const button = screen.getByText("Create Instance");
    fireEvent.click(button);
    // Modal should now be visible with "Create Instance" heading
    expect(screen.getByRole("dialog")).toBeDefined();
  });

  // ── Accessibility ─────────────────────────────────────────────────────

  it("has no accessibility violations", async () => {
    const { container } = render(<EmptyState onInstanceCreated={vi.fn()} />);
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});
