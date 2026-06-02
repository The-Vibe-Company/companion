// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { axe } from "vitest-axe";
import { StatusBadge } from "./StatusBadge";

describe("StatusBadge", () => {
  // ── Render tests ──────────────────────────────────────────────────────

  it("renders the status text", () => {
    render(<StatusBadge status="running" />);
    expect(screen.getByText("running")).toBeDefined();
  });

  it("renders 'unknown' when no status is provided", () => {
    render(<StatusBadge />);
    expect(screen.getByText("unknown")).toBeDefined();
  });

  it("applies green success styles for 'running' status", () => {
    const { container } = render(<StatusBadge status="running" />);
    const badge = container.firstElementChild as HTMLElement;
    expect(badge.className).toContain("text-cc-success");
  });

  it("applies green success styles for 'started' status", () => {
    const { container } = render(<StatusBadge status="started" />);
    const badge = container.firstElementChild as HTMLElement;
    expect(badge.className).toContain("text-cc-success");
  });

  it("applies muted styles for 'stopped' status", () => {
    const { container } = render(<StatusBadge status="stopped" />);
    const badge = container.firstElementChild as HTMLElement;
    expect(badge.className).toContain("text-cc-muted-fg");
  });

  it("applies warning styles for unknown/provisioning status", () => {
    const { container } = render(<StatusBadge status="provisioning" />);
    const badge = container.firstElementChild as HTMLElement;
    expect(badge.className).toContain("text-cc-warning");
  });

  it("shows pulsing dot for running status", () => {
    const { container } = render(<StatusBadge status="running" />);
    const dot = container.querySelector(".animate-pulse-dot");
    expect(dot).not.toBeNull();
  });

  it("does not show pulsing dot for stopped status", () => {
    const { container } = render(<StatusBadge status="stopped" />);
    const dot = container.querySelector(".animate-pulse-dot");
    expect(dot).toBeNull();
  });

  // ── Accessibility ─────────────────────────────────────────────────────

  it("has no accessibility violations", async () => {
    const { container } = render(<StatusBadge status="running" />);
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});
