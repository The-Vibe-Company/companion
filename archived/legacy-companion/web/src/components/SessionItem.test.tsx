// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen, act } from "@testing-library/react";
import "@testing-library/jest-dom";
import type { ComponentProps } from "react";
import { SessionItem } from "./SessionItem.js";
import type { SessionItem as SessionItemType } from "../utils/project-grouping.js";

function makeSession(overrides: Partial<SessionItemType> = {}): SessionItemType {
  return {
    id: "session-1",
    model: "claude-sonnet-4-6",
    cwd: "/workspace/app",
    gitBranch: "",
    isContainerized: false,
    gitAhead: 0,
    gitBehind: 0,
    linesAdded: 0,
    linesRemoved: 0,
    isConnected: true,
    isReconnecting: false,
    status: "running",
    sdkState: "connected",
    createdAt: Date.now(),
    archived: false,
    permCount: 0,
    backendType: "claude",
    repoRoot: "/workspace/app",
    cronJobId: undefined,
    ...overrides,
  };
}

function buildProps(overrides: Partial<ComponentProps<typeof SessionItem>> = {}): ComponentProps<typeof SessionItem> {
  return {
    session: makeSession(),
    isActive: false,
    isArchived: false,
    sessionName: undefined,
    permCount: 0,
    isRecentlyRenamed: false,
    onSelect: vi.fn(),
    onStartRename: vi.fn(),
    onArchive: vi.fn(),
    onUnarchive: vi.fn(),
    onDelete: vi.fn(),
    onClearRecentlyRenamed: vi.fn(),
    editingSessionId: null,
    editingName: "",
    setEditingName: vi.fn(),
    onConfirmRename: vi.fn(),
    onCancelRename: vi.fn(),
    editInputRef: { current: null },
    ...overrides,
  };
}

describe("SessionItem", () => {
  it("renders the session label and cwd", () => {
    // Validates the primary row content users rely on to identify sessions.
    render(<SessionItem {...buildProps()} />);

    expect(screen.getByText("claude-sonnet-4-6")).toBeInTheDocument();
    expect(screen.getByText("/workspace/app")).toBeInTheDocument();
  });

  it("renders the Docker logo asset when session is containerized", () => {
    // Regression guard for THE-195: keep using the transparent Docker logo asset.
    render(<SessionItem {...buildProps({ session: makeSession({ isContainerized: true }) })} />);

    expect(screen.getByTitle("Docker")).toBeInTheDocument();
    const dockerLogo = screen.getByAltText("Docker logo");
    expect(dockerLogo).toHaveAttribute("src", "/logo-docker.svg");
  });

  it("enters rename flow on double-click", () => {
    // Confirms the interaction contract used by Sidebar for inline rename.
    const onStartRename = vi.fn();
    render(<SessionItem {...buildProps({ onStartRename })} />);

    fireEvent.doubleClick(screen.getByRole("button", { name: /claude-sonnet-4-6/i }));

    expect(onStartRename).toHaveBeenCalledWith("session-1", "claude-sonnet-4-6");
  });

  it("passes axe accessibility checks", async () => {
    const { axe } = await import("vitest-axe");
    const { container } = render(<SessionItem {...buildProps()} />);

    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  // --- Status dot rendering ---

  it("shows running status dot when session is running and connected", () => {
    // Ensures the animated success dot appears for actively running sessions.
    const { container } = render(<SessionItem {...buildProps()} />);
    expect(container.querySelector(".bg-cc-success")).toBeTruthy();
  });

  it("shows awaiting status dot when session has pending permissions", () => {
    // Verifies the warning dot appears when permissions need approval.
    const { container } = render(
      <SessionItem {...buildProps({ session: makeSession({ permCount: 2 }), permCount: 2 })} />,
    );
    expect(container.querySelector(".bg-cc-warning")).toBeTruthy();
  });

  it("shows idle status dot when connected but not running", () => {
    // Idle sessions should show a muted dot.
    const { container } = render(
      <SessionItem {...buildProps({ session: makeSession({ status: "idle" }) })} />,
    );
    expect(container.querySelector(".bg-cc-muted\\/40")).toBeTruthy();
  });

  it("shows exited status dot when not connected", () => {
    // Disconnected sessions show an outlined ring instead of a filled dot.
    const { container } = render(
      <SessionItem {...buildProps({ session: makeSession({ isConnected: false }) })} />,
    );
    expect(container.querySelector(".border-cc-muted\\/25")).toBeTruthy();
  });

  // --- Backend badge ---

  it("shows Codex badge for codex backend type", () => {
    // The CX badge distinguishes Codex sessions from Claude Code.
    render(<SessionItem {...buildProps({ session: makeSession({ backendType: "codex" }) })} />);
    expect(screen.getByText("CX")).toBeInTheDocument();
  });

  it("shows CC badge for claude backend type", () => {
    render(<SessionItem {...buildProps()} />);
    expect(screen.getByText("CC")).toBeInTheDocument();
  });

  // --- Cron badge ---

  it("shows scheduled badge when session has a cronJobId", () => {
    render(<SessionItem {...buildProps({ session: makeSession({ cronJobId: "cron-123" }) })} />);
    expect(screen.getByTitle("Scheduled")).toBeInTheDocument();
  });

  // --- Active state styling ---

  it("applies active background class when isActive is true", () => {
    // The active session should have a visually distinct background.
    const { container } = render(<SessionItem {...buildProps({ isActive: true })} />);
    const btn = container.querySelector("button");
    expect(btn?.className).toContain("bg-cc-active");
  });

  // --- F2 shortcut ---

  it("triggers rename on F2 keypress", () => {
    // F2 is a standard shortcut for rename in file managers.
    const onStartRename = vi.fn();
    render(<SessionItem {...buildProps({ onStartRename })} />);

    const btn = screen.getByRole("button", { name: /claude-sonnet-4-6/i });
    fireEvent.keyDown(btn, { key: "F2" });

    expect(onStartRename).toHaveBeenCalledWith("session-1", "claude-sonnet-4-6");
  });

  // --- Editing mode ---

  it("shows input when in editing mode and handles Enter to confirm", () => {
    // Editing mode replaces the label with an input; Enter confirms the rename.
    const onConfirmRename = vi.fn();
    render(
      <SessionItem
        {...buildProps({
          editingSessionId: "session-1",
          editingName: "new name",
          onConfirmRename,
        })}
      />,
    );

    const input = screen.getByDisplayValue("new name");
    expect(input).toBeInTheDocument();

    fireEvent.keyDown(input, { key: "Enter" });
    expect(onConfirmRename).toHaveBeenCalled();
  });

  it("handles Escape in editing mode to cancel rename", () => {
    // Escape aborts the rename without saving changes.
    const onCancelRename = vi.fn();
    render(
      <SessionItem
        {...buildProps({
          editingSessionId: "session-1",
          editingName: "new name",
          onCancelRename,
        })}
      />,
    );

    const input = screen.getByDisplayValue("new name");
    fireEvent.keyDown(input, { key: "Escape" });
    expect(onCancelRename).toHaveBeenCalled();
  });

  it("calls setEditingName on input change", () => {
    // Verifies two-way binding of the editing input.
    const setEditingName = vi.fn();
    render(
      <SessionItem
        {...buildProps({
          editingSessionId: "session-1",
          editingName: "old",
          setEditingName,
        })}
      />,
    );

    fireEvent.change(screen.getByDisplayValue("old"), { target: { value: "new" } });
    expect(setEditingName).toHaveBeenCalledWith("new");
  });

  // --- Context menu ---

  it("opens and closes context menu via three-dot button", () => {
    // The menu toggle should show/hide the dropdown.
    render(<SessionItem {...buildProps()} />);

    const menuBtn = screen.getByTitle("Session actions");
    fireEvent.click(menuBtn);

    expect(screen.getByRole("menu")).toBeInTheDocument();
    expect(screen.getByText("Rename")).toBeInTheDocument();
    expect(screen.getByText("Archive")).toBeInTheDocument();
  });

  it("shows Restore and Delete for archived sessions", () => {
    // Archived items have a different menu: Restore + Delete instead of Rename + Archive.
    render(<SessionItem {...buildProps({ isArchived: true })} />);

    fireEvent.click(screen.getByTitle("Session actions"));

    expect(screen.getByText("Restore")).toBeInTheDocument();
    expect(screen.getByText("Delete")).toBeInTheDocument();
    expect(screen.queryByText("Rename")).not.toBeInTheDocument();
  });

  it("calls onArchive when Archive menu item is clicked", () => {
    // Verifies the archive action wiring in the context menu.
    const onArchive = vi.fn();
    render(<SessionItem {...buildProps({ onArchive })} />);

    fireEvent.click(screen.getByTitle("Session actions"));
    fireEvent.click(screen.getByText("Archive"));

    expect(onArchive).toHaveBeenCalled();
  });

  it("calls onUnarchive when Restore menu item is clicked", () => {
    const onUnarchive = vi.fn();
    render(<SessionItem {...buildProps({ isArchived: true, onUnarchive })} />);

    fireEvent.click(screen.getByTitle("Session actions"));
    fireEvent.click(screen.getByText("Restore"));

    expect(onUnarchive).toHaveBeenCalled();
  });

  it("calls onDelete when Delete menu item is clicked", () => {
    const onDelete = vi.fn();
    render(<SessionItem {...buildProps({ isArchived: true, onDelete })} />);

    fireEvent.click(screen.getByTitle("Session actions"));
    fireEvent.click(screen.getByText("Delete"));

    expect(onDelete).toHaveBeenCalled();
  });

  it("calls onStartRename when Rename menu item is clicked", () => {
    const onStartRename = vi.fn();
    render(<SessionItem {...buildProps({ onStartRename })} />);

    fireEvent.click(screen.getByTitle("Session actions"));
    fireEvent.click(screen.getByText("Rename"));

    expect(onStartRename).toHaveBeenCalledWith("session-1", "claude-sonnet-4-6");
  });

  // --- Keyboard navigation in menu ---

  it("closes menu on Escape key", () => {
    // Per ARIA menu pattern, Escape must dismiss the menu.
    render(<SessionItem {...buildProps()} />);

    fireEvent.click(screen.getByTitle("Session actions"));
    expect(screen.getByRole("menu")).toBeInTheDocument();

    act(() => {
      fireEvent.keyDown(document, { key: "Escape" });
    });

    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("closes menu on Tab key per ARIA authoring practices", () => {
    // Tab must close the menu and return focus to trigger (Greptile feedback).
    render(<SessionItem {...buildProps()} />);

    fireEvent.click(screen.getByTitle("Session actions"));
    expect(screen.getByRole("menu")).toBeInTheDocument();

    act(() => {
      fireEvent.keyDown(document, { key: "Tab" });
    });

    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  // --- Label fallback ---

  it("falls back to short ID when no session name or model", () => {
    // When sessionName and model are absent, the 8-char session ID prefix is shown.
    render(
      <SessionItem
        {...buildProps({
          session: makeSession({ id: "abcdef1234567890", model: "" }),
          sessionName: undefined,
        })}
      />,
    );

    expect(screen.getByText("abcdef12")).toBeInTheDocument();
  });

  it("prefers sessionName over model", () => {
    // An explicit session name takes priority over the model name.
    render(<SessionItem {...buildProps({ sessionName: "My Custom Name" })} />);
    expect(screen.getByText("My Custom Name")).toBeInTheDocument();
  });

  // --- Archive hover button ---

  it("shows archive hover button for non-archived sessions", () => {
    // The quick-archive button appears on hover for active sessions.
    render(<SessionItem {...buildProps()} />);
    expect(screen.getByTitle("Archive")).toBeInTheDocument();
  });

  it("hides archive hover button for archived sessions", () => {
    // Archived sessions shouldn't show the archive shortcut button.
    render(<SessionItem {...buildProps({ isArchived: true })} />);
    expect(screen.queryByTitle("Archive")).not.toBeInTheDocument();
  });

  // --- Recently renamed animation ---

  it("applies name-appear animation for recently renamed sessions", () => {
    // The label gets a reveal animation after being renamed.
    const { container } = render(
      <SessionItem {...buildProps({ isRecentlyRenamed: true })} />,
    );

    const label = container.querySelector(".animate-name-appear");
    expect(label).toBeTruthy();
  });

  // --- Archived forces exited status ---

  it("forces exited status when isArchived is true regardless of session state", () => {
    // Archived sessions always show as exited even if technically connected.
    const { container } = render(
      <SessionItem
        {...buildProps({
          isArchived: true,
          session: makeSession({ isConnected: true, status: "running" }),
        })}
      />,
    );
    // Should show exited dot (border only, no fill)
    expect(container.querySelector(".border-cc-muted\\/25")).toBeTruthy();
  });

  // --- Click outside closes menu ---

  it("closes menu when clicking outside", () => {
    // Clicking outside the menu and button should dismiss the dropdown.
    const { container } = render(<SessionItem {...buildProps()} />);

    fireEvent.click(screen.getByTitle("Session actions"));
    expect(screen.getByRole("menu")).toBeInTheDocument();

    // Click on the root container (outside menu and button)
    act(() => {
      fireEvent.mouseDown(container);
    });

    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  // --- onSelect click ---

  it("calls onSelect when session button is clicked", () => {
    // Single click navigates to the session.
    const onSelect = vi.fn();
    render(<SessionItem {...buildProps({ onSelect })} />);

    fireEvent.click(screen.getByRole("button", { name: /claude-sonnet-4-6/i }));

    expect(onSelect).toHaveBeenCalledWith("session-1");
  });

  // --- Archive hover button fires callback ---

  it("calls onArchive when archive hover button is clicked", () => {
    // The quick-archive button in the hover area should fire the callback.
    const onArchive = vi.fn();
    render(<SessionItem {...buildProps({ onArchive })} />);

    fireEvent.click(screen.getByTitle("Archive"));

    expect(onArchive).toHaveBeenCalled();
  });

  // --- Editing input onBlur ---

  it("calls onConfirmRename on input blur", () => {
    // Blurring the rename input should confirm the rename.
    const onConfirmRename = vi.fn();
    render(
      <SessionItem
        {...buildProps({
          editingSessionId: "session-1",
          editingName: "test",
          onConfirmRename,
        })}
      />,
    );

    fireEvent.blur(screen.getByDisplayValue("test"));
    expect(onConfirmRename).toHaveBeenCalled();
  });

  // --- Arrow key navigation in menu ---

  it("navigates menu items with ArrowDown when focus is inside menu", () => {
    // ArrowDown should move focus to the next menu item.
    render(<SessionItem {...buildProps()} />);

    fireEvent.click(screen.getByTitle("Session actions"));
    const menu = screen.getByRole("menu");
    const items = menu.querySelectorAll("[role='menuitem']");

    // Focus the first item
    act(() => {
      (items[0] as HTMLElement).focus();
    });

    act(() => {
      fireEvent.keyDown(document, { key: "ArrowDown" });
    });

    // Focus should move to the second item
    expect(document.activeElement).toBe(items[1]);
  });

  it("navigates menu items with ArrowUp when focus is inside menu", () => {
    // ArrowUp should move focus to the previous menu item.
    render(<SessionItem {...buildProps()} />);

    fireEvent.click(screen.getByTitle("Session actions"));
    const menu = screen.getByRole("menu");
    const items = menu.querySelectorAll("[role='menuitem']");

    // Focus the second item
    act(() => {
      (items[1] as HTMLElement).focus();
    });

    act(() => {
      fireEvent.keyDown(document, { key: "ArrowUp" });
    });

    // Focus should move back to the first item
    expect(document.activeElement).toBe(items[0]);
  });

  // --- Menu toggle closes on second click ---

  it("closes menu on second click of the three-dot button", () => {
    // Clicking the menu button again should toggle the menu closed.
    render(<SessionItem {...buildProps()} />);

    const menuBtn = screen.getByTitle("Session actions");
    fireEvent.click(menuBtn);
    expect(screen.getByRole("menu")).toBeInTheDocument();

    fireEvent.click(menuBtn);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  // --- Compacting status treated as running ---

  it("shows running dot when session status is compacting and connected", () => {
    // Compacting is functionally a running state from the user's perspective.
    const { container } = render(
      <SessionItem {...buildProps({ session: makeSession({ status: "compacting" }) })} />,
    );
    expect(container.querySelector(".bg-cc-success")).toBeTruthy();
  });
});
