// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import { AgentIcon, AGENT_ICON_OPTIONS } from "./AgentIcon.js";

describe("AgentIcon", () => {
  // ── Render Tests ──────────────────────────────────────────────────────────

  // Test 1: Default icon renders when no icon prop is provided
  it("renders default bot icon when icon is empty string", () => {
    const { container } = render(<AgentIcon icon="" />);
    const svg = container.querySelector("svg");
    expect(svg).toBeInTheDocument();
    expect(svg).toHaveAttribute("role", "img");
    expect(svg).toHaveAttribute("aria-label", "bot");
  });

  // Test 2: Each known icon option renders an SVG
  it.each(AGENT_ICON_OPTIONS)("renders SVG for icon '%s'", (iconName) => {
    const { container } = render(<AgentIcon icon={iconName} />);
    const svg = container.querySelector("svg");
    expect(svg).toBeInTheDocument();
    expect(svg).toHaveAttribute("role", "img");
    expect(svg).toHaveAttribute("aria-label", iconName);
  });

  // Test 3: Unknown emoji/text value falls back to a <span>
  it("renders a text span for unknown emoji icon values", () => {
    render(<AgentIcon icon="🚀" />);
    expect(screen.getByText("🚀")).toBeInTheDocument();
  });

  // Test 4: Custom className is applied
  it("applies custom className", () => {
    const { container } = render(<AgentIcon icon="bot" className="w-8 h-8" />);
    const svg = container.querySelector("svg");
    expect(svg?.className.baseVal || svg?.getAttribute("class")).toContain("w-8 h-8");
  });

  // Test 5: Default className is w-5 h-5
  it("uses default className w-5 h-5 when none provided", () => {
    const { container } = render(<AgentIcon icon="terminal" />);
    const svg = container.querySelector("svg");
    const cls = svg?.className.baseVal || svg?.getAttribute("class") || "";
    expect(cls).toContain("w-5 h-5");
  });

  // Test 6: shrink-0 class is always added
  it("always includes shrink-0 class", () => {
    const { container } = render(<AgentIcon icon="search" />);
    const svg = container.querySelector("svg");
    const cls = svg?.className.baseVal || svg?.getAttribute("class") || "";
    expect(cls).toContain("shrink-0");
  });

  // ── Prop Variations ───────────────────────────────────────────────────────

  // Test 7: AGENT_ICON_OPTIONS contains expected icons
  it("exports expected icon options", () => {
    expect(AGENT_ICON_OPTIONS).toContain("bot");
    expect(AGENT_ICON_OPTIONS).toContain("terminal");
    expect(AGENT_ICON_OPTIONS).toContain("code");
    expect(AGENT_ICON_OPTIONS).toContain("zap");
    expect(AGENT_ICON_OPTIONS.length).toBe(18);
  });

  // ── Accessibility ─────────────────────────────────────────────────────────

  // Test 8: Accessibility scan — bot icon
  it("passes axe accessibility checks for bot icon", async () => {
    const { axe } = await import("vitest-axe");
    const { container } = render(<AgentIcon icon="bot" />);
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  // Test 9: Accessibility scan — emoji fallback
  it("passes axe accessibility checks for emoji fallback", async () => {
    const { axe } = await import("vitest-axe");
    const { container } = render(<AgentIcon icon="🔧" />);
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  // Test 10: Accessibility scan — empty icon (default)
  it("passes axe accessibility checks for default (empty) icon", async () => {
    const { axe } = await import("vitest-axe");
    const { container } = render(<AgentIcon icon="" />);
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});
