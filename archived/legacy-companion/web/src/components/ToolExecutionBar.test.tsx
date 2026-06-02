// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { ToolExecutionBar } from "./ToolExecutionBar.js";

// ─── Empty state ─────────────────────────────────────────────────────────────

describe("ToolExecutionBar - empty tools array", () => {
  it("renders nothing when tools array is empty", () => {
    // The component returns null when there are no active tools, so no DOM
    // node should be present in the container at all.
    const { container } = render(<ToolExecutionBar tools={[]} />);
    expect(container.firstChild).toBeNull();
  });
});

// ─── Single tool rendering ───────────────────────────────────────────────────

describe("ToolExecutionBar - single tool", () => {
  it("renders the human-readable label for a known tool name", () => {
    // getToolLabel("Bash") returns "Terminal", so that label should appear in
    // the DOM rather than the raw tool name "Bash".
    render(<ToolExecutionBar tools={[{ toolName: "Bash", elapsedSeconds: 3 }]} />);
    expect(screen.getByText("Terminal")).toBeTruthy();
  });

  it("renders the elapsed seconds with 's' suffix", () => {
    // The elapsed counter is displayed as a plain number followed by 's' in a
    // separate <span> with tabular-nums styling.
    render(<ToolExecutionBar tools={[{ toolName: "Read", elapsedSeconds: 7 }]} />);
    expect(screen.getByText("7s")).toBeTruthy();
  });

  it("renders the human-readable label for a Read tool", () => {
    // getToolLabel("Read") returns "Read File"
    render(<ToolExecutionBar tools={[{ toolName: "Read", elapsedSeconds: 1 }]} />);
    expect(screen.getByText("Read File")).toBeTruthy();
  });

  it("falls back to the raw tool name for unknown tools", () => {
    // For tools not in the mapping, getToolLabel returns the original name.
    render(<ToolExecutionBar tools={[{ toolName: "CustomTool", elapsedSeconds: 2 }]} />);
    expect(screen.getByText("CustomTool")).toBeTruthy();
  });
});

// ─── Multiple tools rendering ────────────────────────────────────────────────

describe("ToolExecutionBar - multiple tools", () => {
  it("renders all tools when multiple are provided", () => {
    // Each entry in the tools array should produce its own label + elapsed display.
    render(
      <ToolExecutionBar
        tools={[
          { toolName: "Bash", elapsedSeconds: 1 },
          { toolName: "Read", elapsedSeconds: 5 },
          { toolName: "Grep", elapsedSeconds: 2 },
        ]}
      />
    );

    expect(screen.getByText("Terminal")).toBeTruthy();
    expect(screen.getByText("Read File")).toBeTruthy();
    expect(screen.getByText("Search Content")).toBeTruthy();
  });

  it("renders the correct elapsed seconds for each tool independently", () => {
    // Each tool's elapsed counter must match its own elapsedSeconds value and
    // not bleed across to other entries.
    render(
      <ToolExecutionBar
        tools={[
          { toolName: "Bash", elapsedSeconds: 10 },
          { toolName: "Write", elapsedSeconds: 42 },
        ]}
      />
    );

    expect(screen.getByText("10s")).toBeTruthy();
    expect(screen.getByText("42s")).toBeTruthy();
  });

  it("renders zero elapsed seconds correctly", () => {
    // Edge case: elapsedSeconds of 0 should display as "0s" without being
    // suppressed by a falsy check.
    render(<ToolExecutionBar tools={[{ toolName: "Bash", elapsedSeconds: 0 }]} />);
    expect(screen.getByText("0s")).toBeTruthy();
  });
});

// ─── ARIA attributes ─────────────────────────────────────────────────────────

describe("ToolExecutionBar - ARIA attributes", () => {
  it("has role='status' on the container", () => {
    // role="status" marks the bar as a live region so screen readers announce
    // tool execution updates without requiring user focus.
    render(<ToolExecutionBar tools={[{ toolName: "Bash", elapsedSeconds: 1 }]} />);
    const statusEl = screen.getByRole("status");
    expect(statusEl).toBeTruthy();
  });

  it("has aria-label '1 tool running' for a single tool", () => {
    // The singular form must be used when exactly one tool is active.
    render(<ToolExecutionBar tools={[{ toolName: "Bash", elapsedSeconds: 1 }]} />);
    const statusEl = screen.getByRole("status");
    expect(statusEl.getAttribute("aria-label")).toBe("1 tool running");
  });

  it("has aria-label '2 tools running' for two tools", () => {
    // The plural form must be used when more than one tool is active.
    render(
      <ToolExecutionBar
        tools={[
          { toolName: "Bash", elapsedSeconds: 1 },
          { toolName: "Read", elapsedSeconds: 2 },
        ]}
      />
    );
    const statusEl = screen.getByRole("status");
    expect(statusEl.getAttribute("aria-label")).toBe("2 tools running");
  });

  it("updates aria-label count to reflect the actual number of tools", () => {
    // Verify the count embedded in the aria-label matches tools.length generically.
    render(
      <ToolExecutionBar
        tools={[
          { toolName: "Bash", elapsedSeconds: 1 },
          { toolName: "Read", elapsedSeconds: 2 },
          { toolName: "Grep", elapsedSeconds: 3 },
        ]}
      />
    );
    const statusEl = screen.getByRole("status");
    expect(statusEl.getAttribute("aria-label")).toBe("3 tools running");
  });
});

// ─── Accessibility (axe) ─────────────────────────────────────────────────────

describe("ToolExecutionBar - axe accessibility", () => {
  it("passes axe scan with a single tool", async () => {
    // No axe violations should be reported for the standard single-tool case.
    const { axe } = await import("vitest-axe");
    const { container } = render(
      <ToolExecutionBar tools={[{ toolName: "Bash", elapsedSeconds: 5 }]} />
    );
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  it("passes axe scan with multiple tools", async () => {
    // Validate accessibility when multiple tools are displayed simultaneously.
    const { axe } = await import("vitest-axe");
    const { container } = render(
      <ToolExecutionBar
        tools={[
          { toolName: "Read", elapsedSeconds: 1 },
          { toolName: "Grep", elapsedSeconds: 3 },
          { toolName: "Write", elapsedSeconds: 7 },
        ]}
      />
    );
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});
