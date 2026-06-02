// @vitest-environment jsdom
import { render, screen, fireEvent } from "@testing-library/react";
import "vitest-axe/extend-expect";
import { ToolTurnSummary } from "./ToolTurnSummary.js";
import type { ToolActivityEntry } from "../store/tasks-slice.js";

// ─── Fixtures ────────────────────────────────────────────────────────────────

function makeEntry(overrides: Partial<ToolActivityEntry> & { toolUseId: string }): ToolActivityEntry {
  return {
    toolName: "Bash",
    preview: "echo hello",
    startedAt: 1000,
    completedAt: 2500,
    elapsedSeconds: 1.5,
    isError: false,
    ...overrides,
  };
}

// ─── Empty entries ────────────────────────────────────────────────────────────

describe("ToolTurnSummary - empty entries", () => {
  it("returns null (renders nothing) when entries array is empty", () => {
    // The component explicitly guards: if (entries.length === 0) return null.
    // Nothing should be rendered at all.
    const { container } = render(<ToolTurnSummary entries={[]} />);
    expect(container.firstChild).toBeNull();
  });
});

// ─── Collapsed summary ────────────────────────────────────────────────────────

describe("ToolTurnSummary - collapsed state", () => {
  it("renders tool count and total elapsed time in the summary line", () => {
    // Collapsed summary must show the count and the sum of elapsedSeconds.
    // totalTime = 1.5 + 2.0 = 3.5s → displayed as "3.5s"
    const entries = [
      makeEntry({ toolUseId: "tu-1", elapsedSeconds: 1.5 }),
      makeEntry({ toolUseId: "tu-2", toolName: "Read", elapsedSeconds: 2.0 }),
    ];
    render(<ToolTurnSummary entries={entries} />);

    expect(screen.getByText(/2 tools/)).toBeTruthy();
    expect(screen.getByText("3.5s")).toBeTruthy();
  });

  it("uses singular 'tool' when only one entry is present", () => {
    // Grammar: "1 tool" not "1 tools"
    const entries = [makeEntry({ toolUseId: "tu-1", elapsedSeconds: 0.8 })];
    render(<ToolTurnSummary entries={entries} />);

    // getByText on exact text relies on the element; use regex to be flexible.
    expect(screen.getByText(/1 tool(?!s)/)).toBeTruthy();
  });

  it("shows error count when one or more entries have isError=true", () => {
    // Error badge must display "1 error" when exactly one entry has isError.
    const entries = [
      makeEntry({ toolUseId: "tu-ok", elapsedSeconds: 0.5, isError: false }),
      makeEntry({ toolUseId: "tu-err", elapsedSeconds: 0.3, isError: true }),
    ];
    render(<ToolTurnSummary entries={entries} />);

    expect(screen.getByText(/1 error/)).toBeTruthy();
  });

  it("uses plural 'errors' when more than one entry has isError=true", () => {
    // Grammar: "2 errors" not "2 error"
    const entries = [
      makeEntry({ toolUseId: "tu-e1", elapsedSeconds: 0.2, isError: true }),
      makeEntry({ toolUseId: "tu-e2", elapsedSeconds: 0.3, isError: true }),
    ];
    render(<ToolTurnSummary entries={entries} />);

    expect(screen.getByText(/2 errors/)).toBeTruthy();
  });

  it("shows running count when entries have no completedAt timestamp", () => {
    // An entry without completedAt is considered still running.
    // The summary should show "1 running".
    const entries = [
      makeEntry({ toolUseId: "tu-done", elapsedSeconds: 1.0, completedAt: 2000 }),
      makeEntry({ toolUseId: "tu-run", elapsedSeconds: 0.0, completedAt: undefined }),
    ];
    render(<ToolTurnSummary entries={entries} />);

    expect(screen.getByText(/1 running/)).toBeTruthy();
  });

  it("does not show error or running badges when all tools succeeded", () => {
    // A clean turn with no errors and no in-progress tools should show only count + time.
    const entries = [
      makeEntry({ toolUseId: "tu-a", elapsedSeconds: 0.4, isError: false, completedAt: 500 }),
    ];
    render(<ToolTurnSummary entries={entries} />);

    expect(screen.queryByText(/error/i)).toBeNull();
    expect(screen.queryByText(/running/i)).toBeNull();
  });

  it("is collapsed by default (per-tool rows are not visible)", () => {
    // The expanded detail section should not be rendered in the initial collapsed state.
    // We verify by checking that the specific elapsed time for an entry is NOT shown
    // (those only appear in the expanded ToolActivityRow list).
    const entries = [
      makeEntry({ toolUseId: "tu-1", toolName: "Bash", elapsedSeconds: 4.2 }),
    ];
    render(<ToolTurnSummary entries={entries} />);

    // The summary "4.2s" might appear in the summary line itself (totalTime = 4.2)
    // but ToolActivityRow would render a separate "4.2s" element; when collapsed there
    // is only the single summary span, so querying by getAllByText lets us count.
    // The summary line shows the total (4.2s) but no per-row breakdown.
    const buttons = screen.getAllByRole("button");
    // Exactly one toggle button should exist (no row-level buttons)
    expect(buttons.length).toBe(1);
    // aria-expanded starts as false
    expect(buttons[0].getAttribute("aria-expanded")).toBe("false");
  });
});

// ─── Expanded state ───────────────────────────────────────────────────────────

describe("ToolTurnSummary - expanded state", () => {
  it("expands to show per-tool rows when the summary button is clicked", () => {
    // Clicking the toggle button should reveal ToolActivityRow entries.
    // Each row shows the human-readable tool label and elapsed time.
    const entries = [
      makeEntry({ toolUseId: "tu-1", toolName: "Bash", elapsedSeconds: 1.2, preview: "ls /" }),
      makeEntry({ toolUseId: "tu-2", toolName: "Read", elapsedSeconds: 0.5, preview: "/src/index.ts" }),
    ];
    render(<ToolTurnSummary entries={entries} />);

    const button = screen.getByRole("button");
    fireEvent.click(button);

    // aria-expanded should now be true
    expect(button.getAttribute("aria-expanded")).toBe("true");

    // ToolActivityRow renders the tool label (via getToolLabel) and elapsed time
    // Bash → "Terminal", Read → "Read File"
    expect(screen.getByText("Terminal")).toBeTruthy();
    expect(screen.getByText("Read File")).toBeTruthy();

    // Elapsed time is shown in each row as "Xs" strings
    expect(screen.getByText("1.2s")).toBeTruthy();
    expect(screen.getByText("0.5s")).toBeTruthy();
  });

  it("collapses back when the button is clicked a second time", () => {
    // Second click should re-collapse: per-tool rows disappear.
    const entries = [
      makeEntry({ toolUseId: "tu-1", toolName: "Bash", elapsedSeconds: 1.0 }),
    ];
    render(<ToolTurnSummary entries={entries} />);

    const button = screen.getByRole("button");

    // Expand
    fireEvent.click(button);
    expect(button.getAttribute("aria-expanded")).toBe("true");

    // Collapse
    fireEvent.click(button);
    expect(button.getAttribute("aria-expanded")).toBe("false");

    // After collapse, there should be only the single toggle button again
    expect(screen.getAllByRole("button").length).toBe(1);
  });

  it("renders one row per entry in the expanded detail list", () => {
    // Each entry in the array should produce exactly one ToolActivityRow.
    // We verify by counting the unique elapsed-time spans rendered by rows.
    const entries = [
      makeEntry({ toolUseId: "tu-1", toolName: "Bash", elapsedSeconds: 0.1 }),
      makeEntry({ toolUseId: "tu-2", toolName: "Read", elapsedSeconds: 0.2 }),
      makeEntry({ toolUseId: "tu-3", toolName: "Write", elapsedSeconds: 0.3 }),
    ];
    render(<ToolTurnSummary entries={entries} />);

    fireEvent.click(screen.getByRole("button"));

    // Each row shows its own elapsed time (0.1s, 0.2s, 0.3s)
    expect(screen.getByText("0.1s")).toBeTruthy();
    expect(screen.getByText("0.2s")).toBeTruthy();
    expect(screen.getByText("0.3s")).toBeTruthy();
  });

  it("shows tool labels derived from tool names in expanded rows", () => {
    // getToolLabel maps canonical tool names to human-readable labels.
    // Verify the label is present for each row after expansion.
    const entries = [
      makeEntry({ toolUseId: "tu-bash", toolName: "Bash", elapsedSeconds: 0.5 }),
      makeEntry({ toolUseId: "tu-grep", toolName: "Grep", elapsedSeconds: 0.3 }),
    ];
    render(<ToolTurnSummary entries={entries} />);

    fireEvent.click(screen.getByRole("button"));

    // Bash → "Terminal", Grep → "Search Content" (based on ToolBlock.getToolLabel)
    expect(screen.getByText("Terminal")).toBeTruthy();
    expect(screen.getByText("Search Content")).toBeTruthy();
  });
});

// ─── Accessibility ────────────────────────────────────────────────────────────

describe("ToolTurnSummary - accessibility", () => {
  it("passes axe accessibility scan in collapsed state", async () => {
    // The collapsed toggle button must have a descriptive aria-label and
    // the correct aria-expanded=false attribute, satisfying WCAG requirements.
    const { axe } = await import("vitest-axe");
    const entries = [
      makeEntry({ toolUseId: "tu-1", elapsedSeconds: 1.0 }),
      makeEntry({ toolUseId: "tu-2", elapsedSeconds: 0.5, isError: true }),
    ];
    const { container } = render(<ToolTurnSummary entries={entries} />);

    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  it("passes axe accessibility scan in expanded state", async () => {
    // After expansion the detail list renders additional DOM; verify it
    // also satisfies axe rules (no missing labels, contrast issues, etc.).
    const { axe } = await import("vitest-axe");
    const entries = [
      makeEntry({ toolUseId: "tu-1", toolName: "Bash", elapsedSeconds: 1.0 }),
      makeEntry({ toolUseId: "tu-2", toolName: "Read", elapsedSeconds: 0.5 }),
    ];
    const { container } = render(<ToolTurnSummary entries={entries} />);

    // Expand the details
    fireEvent.click(screen.getByRole("button"));

    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});
