// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { ContextWindowBar } from "./ContextWindowBar.js";

interface MockStoreState {
  sessions: Map<string, { context_used_percent?: number }>;
}

let storeState: MockStoreState;

function resetStore(overrides: Partial<MockStoreState> = {}) {
  storeState = {
    sessions: new Map(),
    ...overrides,
  };
}

vi.mock("../store.js", () => ({
  useStore: Object.assign(
    (selector: (s: MockStoreState) => unknown) => selector(storeState),
    { getState: () => storeState },
  ),
}));

beforeEach(() => {
  vi.clearAllMocks();
  resetStore();
});

describe("ContextWindowBar", () => {
  it("renders nothing when context percent is 0", () => {
    resetStore({
      sessions: new Map([["s1", { context_used_percent: 0 }]]),
    });
    const { container } = render(<ContextWindowBar sessionId="s1" />);
    expect(container.innerHTML).toBe("");
  });

  it("renders nothing when session does not exist", () => {
    const { container } = render(<ContextWindowBar sessionId="nonexistent" />);
    expect(container.innerHTML).toBe("");
  });

  it("renders the bar and percentage when context is in use", () => {
    resetStore({
      sessions: new Map([["s1", { context_used_percent: 42 }]]),
    });
    render(<ContextWindowBar sessionId="s1" />);
    expect(screen.getByText("42%")).toBeInTheDocument();
    expect(screen.getByRole("meter")).toBeInTheDocument();
  });

  it("shows correct aria attributes on the meter", () => {
    resetStore({
      sessions: new Map([["s1", { context_used_percent: 65 }]]),
    });
    render(<ContextWindowBar sessionId="s1" />);
    const meter = screen.getByRole("meter");
    expect(meter).toHaveAttribute("aria-valuenow", "65");
    expect(meter).toHaveAttribute("aria-valuemin", "0");
    expect(meter).toHaveAttribute("aria-valuemax", "100");
    expect(meter).toHaveAttribute("aria-label", "Context window usage — elevated");
  });

  it("uses normal level color for low usage", () => {
    resetStore({
      sessions: new Map([["s1", { context_used_percent: 30 }]]),
    });
    render(<ContextWindowBar sessionId="s1" />);
    const meter = screen.getByRole("meter");
    const fill = meter.firstElementChild as HTMLElement;
    expect(fill.className).toContain("bg-cc-primary");
    expect(meter).toHaveAttribute("aria-label", "Context window usage — normal");
  });

  it("uses warning color for elevated usage (>50%)", () => {
    resetStore({
      sessions: new Map([["s1", { context_used_percent: 65 }]]),
    });
    render(<ContextWindowBar sessionId="s1" />);
    const meter = screen.getByRole("meter");
    const fill = meter.firstElementChild as HTMLElement;
    expect(fill.className).toContain("bg-cc-warning");
  });

  it("uses error color for critical usage (>80%)", () => {
    resetStore({
      sessions: new Map([["s1", { context_used_percent: 92 }]]),
    });
    render(<ContextWindowBar sessionId="s1" />);
    const meter = screen.getByRole("meter");
    const fill = meter.firstElementChild as HTMLElement;
    expect(fill.className).toContain("bg-cc-error");
    expect(meter).toHaveAttribute("aria-label", "Context window usage — critical");
  });

  it("clamps percentage display at 100", () => {
    resetStore({
      sessions: new Map([["s1", { context_used_percent: 120 }]]),
    });
    render(<ContextWindowBar sessionId="s1" />);
    expect(screen.getByText("100%")).toBeInTheDocument();
    const meter = screen.getByRole("meter");
    expect(meter).toHaveAttribute("aria-valuenow", "100");
  });

  it("passes axe accessibility checks", async () => {
    const { axe } = await import("vitest-axe");
    resetStore({
      sessions: new Map([["s1", { context_used_percent: 55 }]]),
    });
    const { container } = render(<ContextWindowBar sessionId="s1" />);
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});
