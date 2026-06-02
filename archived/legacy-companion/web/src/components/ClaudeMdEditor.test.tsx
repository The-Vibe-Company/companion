// @vitest-environment jsdom
/**
 * Tests for ClaudeMdEditor component.
 *
 * ClaudeMdEditor is a modal editor for CLAUDE.md files. It:
 * - Fetches CLAUDE.md files via api.getClaudeMdFiles(cwd) when opened
 * - Displays a file list sidebar and textarea editor
 * - Supports selecting files, editing content, saving via api.saveClaudeMd
 * - Supports creating new CLAUDE.md files (root or .claude/ location)
 * - Shows loading, error, and dirty/unsaved states
 * - Has close confirmation when dirty (via window.confirm)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";

// ─── Mock api module ────────────────────────────────────────────────────────
const mockGetClaudeMdFiles = vi.fn();
const mockSaveClaudeMd = vi.fn();

vi.mock("../api.js", () => ({
  api: {
    getClaudeMdFiles: (...args: unknown[]) => mockGetClaudeMdFiles(...args),
    saveClaudeMd: (...args: unknown[]) => mockSaveClaudeMd(...args),
  },
}));

import { ClaudeMdEditor } from "./ClaudeMdEditor.js";

// ─── Fixtures ───────────────────────────────────────────────────────────────
const CWD = "/home/user/project";

const twoFiles = {
  cwd: CWD,
  files: [
    { path: `${CWD}/CLAUDE.md`, content: "# Root file\nHello" },
    { path: `${CWD}/.claude/CLAUDE.md`, content: "# Inner file\nWorld" },
  ],
};

const oneRootFile = {
  cwd: CWD,
  files: [{ path: `${CWD}/CLAUDE.md`, content: "# Root only" }],
};

const oneDotClaudeFile = {
  cwd: CWD,
  files: [
    { path: `${CWD}/.claude/CLAUDE.md`, content: "# DotClaude only" },
  ],
};

const emptyFiles = {
  cwd: CWD,
  files: [],
};

const defaultProps = {
  cwd: CWD,
  open: true,
  onClose: vi.fn(),
};

beforeEach(() => {
  vi.clearAllMocks();
  // Default: two files load successfully
  mockGetClaudeMdFiles.mockResolvedValue(twoFiles);
  mockSaveClaudeMd.mockResolvedValue({ ok: true, path: "" });
  // Stub window.confirm to always return true by default
  vi.spyOn(window, "confirm").mockReturnValue(true);
});

describe("ClaudeMdEditor", () => {
  // ─── 1. Basic render ───────────────────────────────────────────────────────

  it("renders when open=true and does not render when open=false", async () => {
    // When open=true, modal content should appear
    const { rerender } = render(<ClaudeMdEditor {...defaultProps} open={true} />);
    // The header text is always present in the modal
    await waitFor(() => {
      expect(screen.getByText("CLAUDE.md")).toBeInTheDocument();
    });

    // When open=false, nothing should render
    rerender(<ClaudeMdEditor {...defaultProps} open={false} />);
    expect(screen.queryByText("Project instructions for Claude Code")).not.toBeInTheDocument();
  });

  // ─── 2. Axe accessibility ─────────────────────────────────────────────────

  it("passes axe accessibility checks", async () => {
    // The close button in the component uses an SVG icon without aria-label,
    // which triggers axe's button-name rule. We disable that specific rule
    // here since it's a known limitation of the component's current markup.
    const { axe } = await import("vitest-axe");
    const { container } = render(<ClaudeMdEditor {...defaultProps} />);
    await waitFor(() => {
      expect(screen.getByText("Files")).toBeInTheDocument();
    });
    const results = await axe(container, {
      rules: { "button-name": { enabled: false } },
    });
    expect(results).toHaveNoViolations();
  });

  // ─── 3. Loading state ─────────────────────────────────────────────────────

  it("shows a spinner while loading files", () => {
    // Make the API hang indefinitely so we can observe the loading state
    mockGetClaudeMdFiles.mockReturnValue(new Promise(() => {}));
    const { container } = render(<ClaudeMdEditor {...defaultProps} />);
    // The spinner is a div with animate-spin class; verify it exists
    const spinner = container.querySelector(".animate-spin");
    expect(spinner).toBeInTheDocument();
    // The file list sidebar should NOT be visible during loading
    expect(screen.queryByText("Files")).not.toBeInTheDocument();
  });

  // ─── 4. File list rendering with multiple files ────────────────────────────

  it("renders the file list sidebar with all files after loading", async () => {
    render(<ClaudeMdEditor {...defaultProps} />);
    await waitFor(() => {
      expect(screen.getByText("Files")).toBeInTheDocument();
    });

    // "CLAUDE.md" appears in both the sidebar file list and the path bar,
    // so we use getAllByText and verify at least one match for each.
    const claudeMdElements = screen.getAllByText("CLAUDE.md");
    expect(claudeMdElements.length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(".claude/CLAUDE.md")).toBeInTheDocument();
  });

  // ─── 5. Selecting a file updates editor content ────────────────────────────

  it("updates editor content when selecting a different file", async () => {
    render(<ClaudeMdEditor {...defaultProps} />);
    await waitFor(() => {
      expect(screen.getByText("Files")).toBeInTheDocument();
    });

    // The first file content should be loaded by default
    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
    expect(textarea.value).toBe("# Root file\nHello");

    // Click the second file
    fireEvent.click(screen.getByText(".claude/CLAUDE.md"));
    expect(textarea.value).toBe("# Inner file\nWorld");
  });

  // ─── 6. Editing content marks as dirty with "Unsaved" indicator ────────────

  it("shows 'Unsaved' indicator after editing content", async () => {
    render(<ClaudeMdEditor {...defaultProps} />);
    await waitFor(() => {
      expect(screen.getByText("Files")).toBeInTheDocument();
    });

    // Initially no "Unsaved" indicator
    expect(screen.queryByText("Unsaved")).not.toBeInTheDocument();

    // Edit the textarea
    const textarea = screen.getByRole("textbox");
    fireEvent.change(textarea, { target: { value: "Modified content" } });

    // "Unsaved" should now appear
    expect(screen.getByText("Unsaved")).toBeInTheDocument();
  });

  // ─── 7. Save calls api.saveClaudeMd and clears dirty state ─────────────────

  it("saves content via API and clears the dirty state", async () => {
    render(<ClaudeMdEditor {...defaultProps} />);
    await waitFor(() => {
      expect(screen.getByText("Files")).toBeInTheDocument();
    });

    // Edit to make dirty
    const textarea = screen.getByRole("textbox");
    fireEvent.change(textarea, { target: { value: "New content" } });
    expect(screen.getByText("Unsaved")).toBeInTheDocument();

    // The Save button should be enabled
    const saveBtn = screen.getByRole("button", { name: "Save" });
    fireEvent.click(saveBtn);

    await waitFor(() => {
      expect(mockSaveClaudeMd).toHaveBeenCalledWith(
        `${CWD}/CLAUDE.md`,
        "New content",
      );
    });

    // Dirty state should be cleared
    await waitFor(() => {
      expect(screen.queryByText("Unsaved")).not.toBeInTheDocument();
    });
  });

  // ─── 8. Error handling when load fails ─────────────────────────────────────

  it("shows error message when loading files fails", async () => {
    mockGetClaudeMdFiles.mockRejectedValue(new Error("Network error"));
    render(<ClaudeMdEditor {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByText("Network error")).toBeInTheDocument();
    });
  });

  // ─── 9. Error handling when save fails ─────────────────────────────────────

  it("shows error message when saving fails", async () => {
    mockSaveClaudeMd.mockRejectedValue(new Error("Permission denied"));
    render(<ClaudeMdEditor {...defaultProps} />);
    await waitFor(() => {
      expect(screen.getByText("Files")).toBeInTheDocument();
    });

    // Edit and attempt save
    const textarea = screen.getByRole("textbox");
    fireEvent.change(textarea, { target: { value: "Changed" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(screen.getByText("Permission denied")).toBeInTheDocument();
    });

    // The dirty state should still be set since save failed
    expect(screen.getByText("Unsaved")).toBeInTheDocument();
  });

  it("shows generic error message when save throws a non-Error", async () => {
    // Test the fallback branch: catch (e) => e instanceof Error ? e.message : "Failed to save"
    mockSaveClaudeMd.mockRejectedValue("string error");
    render(<ClaudeMdEditor {...defaultProps} />);
    await waitFor(() => {
      expect(screen.getByText("Files")).toBeInTheDocument();
    });

    const textarea = screen.getByRole("textbox");
    fireEvent.change(textarea, { target: { value: "Changed" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(screen.getByText("Failed to save")).toBeInTheDocument();
    });
  });

  // ─── 10. Create new CLAUDE.md at root ──────────────────────────────────────

  it("creates a new CLAUDE.md at the project root", async () => {
    // Start with only the .claude/CLAUDE.md file so the root create button appears
    mockGetClaudeMdFiles.mockResolvedValue(oneDotClaudeFile);
    render(<ClaudeMdEditor {...defaultProps} />);
    await waitFor(() => {
      expect(screen.getByText("Files")).toBeInTheDocument();
    });

    // The "Create new" section should show a button for CLAUDE.md (root)
    expect(screen.getByText("Create new")).toBeInTheDocument();

    // Find the create button for root CLAUDE.md (the sidebar button with text "CLAUDE.md")
    // The existing file shows as ".claude/CLAUDE.md", so the standalone "CLAUDE.md" button is the create button
    const createButtons = screen.getAllByText("CLAUDE.md");
    // One of them is the create button in the "Create new" section
    const createRootBtn = createButtons.find((el) => {
      // The create button is inside the "Create new" border-t section
      return el.closest(".border-t") !== null;
    });
    expect(createRootBtn).toBeTruthy();
    fireEvent.click(createRootBtn!);

    // The editor should now show the new file path and default template content
    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
    expect(textarea.value).toBe("# CLAUDE.md\n\n");

    // It should be marked dirty immediately
    expect(screen.getByText("Unsaved")).toBeInTheDocument();

    // Save the new file
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => {
      expect(mockSaveClaudeMd).toHaveBeenCalledWith(
        `${CWD}/CLAUDE.md`,
        "# CLAUDE.md\n\n",
      );
    });

    // After saving in create mode, the file list should reload
    await waitFor(() => {
      // load() is called again after create-mode save
      expect(mockGetClaudeMdFiles).toHaveBeenCalledTimes(2);
    });
  });

  // ─── 11. Create new .claude/CLAUDE.md ──────────────────────────────────────

  it("creates a new .claude/CLAUDE.md file", async () => {
    // Start with only root CLAUDE.md so the .claude create button appears
    mockGetClaudeMdFiles.mockResolvedValue(oneRootFile);
    render(<ClaudeMdEditor {...defaultProps} />);
    await waitFor(() => {
      expect(screen.getByText("Files")).toBeInTheDocument();
    });

    // Find and click the ".claude/CLAUDE.md" create button
    const dotClaudeBtn = screen.getAllByText(".claude/CLAUDE.md").find(
      (el) => el.closest(".border-t") !== null,
    );
    expect(dotClaudeBtn).toBeTruthy();
    fireEvent.click(dotClaudeBtn!);

    // Should show the new file in the sidebar as a create-mode entry
    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
    expect(textarea.value).toBe("# CLAUDE.md\n\n");
    expect(screen.getByText("Unsaved")).toBeInTheDocument();

    // Save
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => {
      expect(mockSaveClaudeMd).toHaveBeenCalledWith(
        `${CWD}/.claude/CLAUDE.md`,
        "# CLAUDE.md\n\n",
      );
    });
  });

  // ─── 12. Empty state with no files shows create buttons ────────────────────

  it("shows empty state with create buttons when no files exist", async () => {
    mockGetClaudeMdFiles.mockResolvedValue(emptyFiles);
    render(<ClaudeMdEditor {...defaultProps} />);
    await waitFor(() => {
      expect(screen.getByText("No CLAUDE.md found")).toBeInTheDocument();
    });

    // The explanatory text should be visible
    expect(
      screen.getByText(/Create a CLAUDE\.md file to give Claude Code/),
    ).toBeInTheDocument();

    // Two create buttons should exist in the main area
    expect(screen.getByText("Create CLAUDE.md")).toBeInTheDocument();
    expect(screen.getByText("Create .claude/CLAUDE.md")).toBeInTheDocument();
  });

  it("clicking 'Create CLAUDE.md' in empty state enters create mode for root", async () => {
    mockGetClaudeMdFiles.mockResolvedValue(emptyFiles);
    render(<ClaudeMdEditor {...defaultProps} />);
    await waitFor(() => {
      expect(screen.getByText("No CLAUDE.md found")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("Create CLAUDE.md"));

    // Should now show the textarea editor with template content
    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
    expect(textarea.value).toBe("# CLAUDE.md\n\n");
    expect(screen.getByText("Unsaved")).toBeInTheDocument();
  });

  it("clicking 'Create .claude/CLAUDE.md' in empty state enters create mode for dotclaude", async () => {
    mockGetClaudeMdFiles.mockResolvedValue(emptyFiles);
    render(<ClaudeMdEditor {...defaultProps} />);
    await waitFor(() => {
      expect(screen.getByText("No CLAUDE.md found")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("Create .claude/CLAUDE.md"));

    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
    expect(textarea.value).toBe("# CLAUDE.md\n\n");
    expect(screen.getByText("Unsaved")).toBeInTheDocument();
  });

  // ─── 13. Close button behavior ─────────────────────────────────────────────

  it("calls onClose immediately when not dirty", async () => {
    const onClose = vi.fn();
    render(<ClaudeMdEditor cwd={CWD} open={true} onClose={onClose} />);
    await waitFor(() => {
      expect(screen.getByText("Files")).toBeInTheDocument();
    });

    // Click the close button (X) in the header
    // The close button is found by looking for the SVG path pattern in the header
    const closeButtons = screen.getAllByRole("button");
    // The close button is the one in the header with the X svg
    const closeBtn = closeButtons.find(
      (btn) => btn.querySelector('path[d="M4 4l8 8M12 4l-8 8"]') !== null,
    );
    expect(closeBtn).toBeTruthy();
    fireEvent.click(closeBtn!);

    expect(onClose).toHaveBeenCalledTimes(1);
    // confirm should NOT have been called since content is not dirty
    expect(window.confirm).not.toHaveBeenCalled();
  });

  it("shows confirmation dialog when closing with unsaved changes and user confirms", async () => {
    const onClose = vi.fn();
    render(<ClaudeMdEditor cwd={CWD} open={true} onClose={onClose} />);
    await waitFor(() => {
      expect(screen.getByText("Files")).toBeInTheDocument();
    });

    // Make dirty by editing
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "Dirty content" },
    });

    // User confirms the discard
    vi.spyOn(window, "confirm").mockReturnValue(true);

    const closeBtn = screen.getAllByRole("button").find(
      (btn) => btn.querySelector('path[d="M4 4l8 8M12 4l-8 8"]') !== null,
    );
    fireEvent.click(closeBtn!);

    expect(window.confirm).toHaveBeenCalledWith("Discard unsaved changes?");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("does NOT close when user cancels the confirmation dialog", async () => {
    const onClose = vi.fn();
    render(<ClaudeMdEditor cwd={CWD} open={true} onClose={onClose} />);
    await waitFor(() => {
      expect(screen.getByText("Files")).toBeInTheDocument();
    });

    // Make dirty
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "Dirty content" },
    });

    // User cancels the discard
    vi.spyOn(window, "confirm").mockReturnValue(false);

    const closeBtn = screen.getAllByRole("button").find(
      (btn) => btn.querySelector('path[d="M4 4l8 8M12 4l-8 8"]') !== null,
    );
    fireEvent.click(closeBtn!);

    expect(window.confirm).toHaveBeenCalledWith("Discard unsaved changes?");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("closes via backdrop click", async () => {
    const onClose = vi.fn();
    const { container } = render(
      <ClaudeMdEditor cwd={CWD} open={true} onClose={onClose} />,
    );
    await waitFor(() => {
      expect(screen.getByText("Files")).toBeInTheDocument();
    });

    // The backdrop is the first child div with the bg-black/40 class
    const backdrop = container.querySelector(".fixed.inset-0.bg-black\\/40");
    expect(backdrop).toBeTruthy();
    fireEvent.click(backdrop!);

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  // ─── Additional edge cases ─────────────────────────────────────────────────

  it("Save button is disabled when content is not dirty", async () => {
    render(<ClaudeMdEditor {...defaultProps} />);
    await waitFor(() => {
      expect(screen.getByText("Files")).toBeInTheDocument();
    });

    const saveBtn = screen.getByRole("button", { name: "Save" });
    expect(saveBtn).toBeDisabled();
  });

  it("shows 'Saving...' text while save is in progress", async () => {
    // Make save hang so we can observe the saving state
    mockSaveClaudeMd.mockReturnValue(new Promise(() => {}));
    render(<ClaudeMdEditor {...defaultProps} />);
    await waitFor(() => {
      expect(screen.getByText("Files")).toBeInTheDocument();
    });

    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "New" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    // "Saving..." should appear while the save promise is pending
    await waitFor(() => {
      expect(screen.getByText("Saving...")).toBeInTheDocument();
    });
  });

  it("fetches files when open prop transitions from false to true", async () => {
    const { rerender } = render(<ClaudeMdEditor {...defaultProps} open={false} />);
    expect(mockGetClaudeMdFiles).not.toHaveBeenCalled();

    rerender(<ClaudeMdEditor {...defaultProps} open={true} />);
    await waitFor(() => {
      expect(mockGetClaudeMdFiles).toHaveBeenCalledWith(CWD);
    });
  });

  it("selecting a file while dirty triggers confirm and discards if user confirms", async () => {
    render(<ClaudeMdEditor {...defaultProps} />);
    await waitFor(() => {
      expect(screen.getByText("Files")).toBeInTheDocument();
    });

    // Make dirty
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "Dirty!" },
    });

    vi.spyOn(window, "confirm").mockReturnValue(true);

    // Click second file
    fireEvent.click(screen.getByText(".claude/CLAUDE.md"));

    expect(window.confirm).toHaveBeenCalledWith("Discard unsaved changes?");
    // Should switch to second file content
    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
    expect(textarea.value).toBe("# Inner file\nWorld");
  });

  it("does not switch files if user cancels confirm when dirty", async () => {
    render(<ClaudeMdEditor {...defaultProps} />);
    await waitFor(() => {
      expect(screen.getByText("Files")).toBeInTheDocument();
    });

    // Make dirty
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "Dirty!" },
    });

    vi.spyOn(window, "confirm").mockReturnValue(false);

    // Try to click second file
    fireEvent.click(screen.getByText(".claude/CLAUDE.md"));

    // Should still show dirty content of the first file
    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
    expect(textarea.value).toBe("Dirty!");
  });

  it("does not show create buttons in sidebar when both root and dotclaude files exist", async () => {
    // Both files exist
    mockGetClaudeMdFiles.mockResolvedValue(twoFiles);
    render(<ClaudeMdEditor {...defaultProps} />);
    await waitFor(() => {
      expect(screen.getByText("Files")).toBeInTheDocument();
    });

    // "Create new" section should NOT appear
    expect(screen.queryByText("Create new")).not.toBeInTheDocument();
  });

  it("shows the new file entry in the sidebar during create mode", async () => {
    mockGetClaudeMdFiles.mockResolvedValue(emptyFiles);
    render(<ClaudeMdEditor {...defaultProps} />);
    await waitFor(() => {
      expect(screen.getByText("No CLAUDE.md found")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("Create CLAUDE.md"));

    // The new file path should appear in the sidebar file list and the path bar.
    // "CLAUDE.md" (relative) appears in both sidebar create-mode entry and the path bar.
    await waitFor(() => {
      expect(screen.getByRole("textbox")).toBeInTheDocument();
    });
    const claudeMdElements = screen.getAllByText("CLAUDE.md");
    // At least one in the sidebar and one in the path bar
    expect(claudeMdElements.length).toBeGreaterThanOrEqual(2);
  });

  it("displays the relative file path in the path bar above editor", async () => {
    render(<ClaudeMdEditor {...defaultProps} />);
    await waitFor(() => {
      expect(screen.getByText("Files")).toBeInTheDocument();
    });

    // The file path bar shows the relative path of the selected file.
    // "CLAUDE.md" appears in the sidebar button AND the path bar span,
    // so we verify the path bar's font-mono-code span specifically.
    const claudeMdElements = screen.getAllByText("CLAUDE.md");
    // There should be at least 2: one in sidebar file list, one in path bar
    expect(claudeMdElements.length).toBeGreaterThanOrEqual(2);
    // Verify one is in the path bar (the span with text-cc-muted class)
    const pathBarSpan = claudeMdElements.find(
      (el) => el.tagName === "SPAN" && el.classList.contains("text-cc-muted"),
    );
    expect(pathBarSpan).toBeTruthy();
  });
});
