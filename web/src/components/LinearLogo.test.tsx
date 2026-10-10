// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import "@testing-library/jest-dom";
import { LinearLogo } from "./LinearLogo.js";

describe("LinearLogo", () => {
  // ── Render Tests ──────────────────────────────────────────────────────────

  // Test 1: Renders an SVG element
  it("renders an SVG element", () => {
    const { container } = render(<LinearLogo />);
    const svg = container.querySelector("svg");
    expect(svg).toBeInTheDocument();
    expect(svg).toHaveAttribute("viewBox", "0 0 100 104");
  });

  // Test 2: SVG is aria-hidden for decorative use
  it("is aria-hidden since it is decorative", () => {
    const { container } = render(<LinearLogo />);
    const svg = container.querySelector("svg");
    expect(svg).toHaveAttribute("aria-hidden", "true");
  });

  // Test 3: Contains exactly 4 path elements (the Linear logo geometry)
  it("contains 4 path elements forming the logo", () => {
    const { container } = render(<LinearLogo />);
    const paths = container.querySelectorAll("path");
    expect(paths.length).toBe(4);
  });

  // Test 4: All paths use currentColor for fill
  it("all paths use currentColor fill", () => {
    const { container } = render(<LinearLogo />);
    const paths = container.querySelectorAll("path");
    paths.forEach((path) => {
      expect(path).toHaveAttribute("fill", "currentColor");
    });
  });

  // ── Prop Variations ───────────────────────────────────────────────────────

  // Test 5: Applies custom className
  it("applies custom className to SVG", () => {
    const { container } = render(<LinearLogo className="w-4 h-4 text-blue-500" />);
    const svg = container.querySelector("svg");
    expect(svg).toHaveClass("w-4", "h-4", "text-blue-500");
  });

  // Test 6: No className when not provided
  it("renders without className when not provided", () => {
    const { container } = render(<LinearLogo />);
    const svg = container.querySelector("svg");
    // className should be undefined/empty, not crash
    expect(svg).toBeInTheDocument();
  });

  // ── Accessibility ─────────────────────────────────────────────────────────

  // Test 7: Accessibility scan — default
  it("passes axe accessibility checks", async () => {
    const { axe } = await import("vitest-axe");
    const { container } = render(<LinearLogo />);
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  // Test 8: Accessibility scan — with className
  it("passes axe accessibility checks with className", async () => {
    const { axe } = await import("vitest-axe");
    const { container } = render(<LinearLogo className="w-6 h-6" />);
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});
