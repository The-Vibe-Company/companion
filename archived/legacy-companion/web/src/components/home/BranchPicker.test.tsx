// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";

const mockListBranches = vi.fn();
const mockGitFetch = vi.fn();

vi.mock("../../api.js", () => ({
  api: {
    listBranches: (...args: unknown[]) => mockListBranches(...args),
    gitFetch: (...args: unknown[]) => mockGitFetch(...args),
  },
}));

import { BranchPicker } from "./BranchPicker.js";

const defaultGitRepoInfo = {
  repoRoot: "/repo",
  repoName: "my-repo",
  currentBranch: "main",
  defaultBranch: "main",
  isWorktree: false,
};

const sampleBranches = [
  { name: "main", isCurrent: true, isRemote: false, worktreePath: null, ahead: 0, behind: 0 },
  { name: "feature/login", isCurrent: false, isRemote: false, worktreePath: null, ahead: 2, behind: 0 },
  { name: "origin/main", isCurrent: false, isRemote: true, worktreePath: null, ahead: 0, behind: 0 },
];

beforeEach(() => {
  vi.clearAllMocks();
  mockListBranches.mockResolvedValue(sampleBranches);
  mockGitFetch.mockResolvedValue({ ok: true });
});

describe("BranchPicker keyboard navigation", () => {
  it("renders nothing when repository info is unavailable", async () => {
    // Without git metadata, the picker should stay hidden and report no branches.
    const onBranchesLoaded = vi.fn();
    const { container } = render(
      <BranchPicker
        cwd="/repo"
        gitRepoInfo={null}
        selectedBranch=""
        isNewBranch={false}
        useWorktree={false}
        onBranchChange={vi.fn()}
        onWorktreeChange={vi.fn()}
        onBranchesLoaded={onBranchesLoaded}
      />,
    );

    expect(container.firstChild).toBeNull();
    await waitFor(() => {
      expect(onBranchesLoaded).toHaveBeenCalledWith([]);
    });
  });

  it("opens dropdown on button click and shows branches", async () => {
    // Verifies the dropdown opens and renders branch list after click.
    const onBranchChange = vi.fn();
    render(
      <BranchPicker
        cwd="/repo"
        gitRepoInfo={defaultGitRepoInfo}
        selectedBranch="main"
        isNewBranch={false}
        useWorktree={false}
        onBranchChange={onBranchChange}
        onWorktreeChange={vi.fn()}
        onBranchesLoaded={vi.fn()}
      />,
    );

    const trigger = screen.getByText("main").closest("button")!;
    fireEvent.click(trigger);

    await waitFor(() => {
      expect(screen.getByPlaceholderText("Filter or create branch...")).toBeInTheDocument();
    });
  });

  it("Escape closes the dropdown from the filter input", async () => {
    // Verifies pressing Escape in the filter input closes the dropdown.
    render(
      <BranchPicker
        cwd="/repo"
        gitRepoInfo={defaultGitRepoInfo}
        selectedBranch="main"
        isNewBranch={false}
        useWorktree={false}
        onBranchChange={vi.fn()}
        onWorktreeChange={vi.fn()}
        onBranchesLoaded={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByText("main").closest("button")!);
    await waitFor(() => {
      expect(screen.getByPlaceholderText("Filter or create branch...")).toBeInTheDocument();
    });

    const filterInput = screen.getByPlaceholderText("Filter or create branch...");
    fireEvent.keyDown(filterInput, { key: "Escape" });

    // Dropdown should be closed — filter input should no longer be visible
    expect(screen.queryByPlaceholderText("Filter or create branch...")).not.toBeInTheDocument();
  });

  it("filter input narrows the branch list", async () => {
    // Verifies that typing in the filter input narrows the branch list.
    render(
      <BranchPicker
        cwd="/repo"
        gitRepoInfo={defaultGitRepoInfo}
        selectedBranch="main"
        isNewBranch={false}
        useWorktree={false}
        onBranchChange={vi.fn()}
        onWorktreeChange={vi.fn()}
        onBranchesLoaded={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByText("main").closest("button")!);
    await waitFor(() => {
      expect(screen.getByPlaceholderText("Filter or create branch...")).toBeInTheDocument();
    });

    const filterInput = screen.getByPlaceholderText("Filter or create branch...");
    fireEvent.change(filterInput, { target: { value: "feature" } });

    // Only the feature branch should be visible
    expect(screen.getByText("feature/login")).toBeInTheDocument();
    expect(screen.queryByText("origin/main")).not.toBeInTheDocument();
  });

  it("selecting a branch calls onBranchChange and closes dropdown", async () => {
    // Verifies clicking a branch option calls the callback and closes the menu.
    const onBranchChange = vi.fn();
    render(
      <BranchPicker
        cwd="/repo"
        gitRepoInfo={defaultGitRepoInfo}
        selectedBranch="main"
        isNewBranch={false}
        useWorktree={false}
        onBranchChange={onBranchChange}
        onWorktreeChange={vi.fn()}
        onBranchesLoaded={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByText("main").closest("button")!);
    await waitFor(() => {
      expect(screen.getByText("feature/login")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("feature/login"));
    expect(onBranchChange).toHaveBeenCalledWith("feature/login", false);
    // Dropdown should close after selection
    expect(screen.queryByPlaceholderText("Filter or create branch...")).not.toBeInTheDocument();
  });

  it("shows 'Create' option when filter doesn't match any branch", async () => {
    // Verifies the "Create new branch" option appears for non-matching filter text.
    render(
      <BranchPicker
        cwd="/repo"
        gitRepoInfo={defaultGitRepoInfo}
        selectedBranch="main"
        isNewBranch={false}
        useWorktree={false}
        onBranchChange={vi.fn()}
        onWorktreeChange={vi.fn()}
        onBranchesLoaded={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByText("main").closest("button")!);
    await waitFor(() => {
      expect(screen.getByPlaceholderText("Filter or create branch...")).toBeInTheDocument();
    });

    fireEvent.change(screen.getByPlaceholderText("Filter or create branch..."), {
      target: { value: "my-new-branch" },
    });

    expect(screen.getByText("my-new-branch")).toBeInTheDocument();
    expect(screen.getByText("Create")).toBeInTheDocument();
  });

  it("creates a new branch from trimmed filter text", async () => {
    // Verifies "Create" action passes trimmed input and marks branch as new.
    const onBranchChange = vi.fn();
    render(
      <BranchPicker
        cwd="/repo"
        gitRepoInfo={defaultGitRepoInfo}
        selectedBranch="main"
        isNewBranch={false}
        useWorktree={false}
        onBranchChange={onBranchChange}
        onWorktreeChange={vi.fn()}
        onBranchesLoaded={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByText("main").closest("button")!);
    await waitFor(() => {
      expect(screen.getByPlaceholderText("Filter or create branch...")).toBeInTheDocument();
    });

    fireEvent.change(screen.getByPlaceholderText("Filter or create branch..."), {
      target: { value: "  my-new-branch  " },
    });

    fireEvent.click(screen.getByText("Create").closest("button")!);
    expect(onBranchChange).toHaveBeenCalledWith("my-new-branch", true);
  });

  it("exposes repo title and new-branch state on trigger", () => {
    // Validates metadata attributes used for UX hints and state tagging.
    render(
      <BranchPicker
        cwd="/repo"
        gitRepoInfo={defaultGitRepoInfo}
        selectedBranch="feature/new"
        isNewBranch={true}
        useWorktree={false}
        onBranchChange={vi.fn()}
        onWorktreeChange={vi.fn()}
        onBranchesLoaded={vi.fn()}
      />,
    );

    const trigger = screen.getByText("feature/new").closest("button")!;
    expect(trigger).toHaveAttribute("title", "Repository: /repo");
    expect(trigger).toHaveAttribute("data-is-new-branch", "true");
  });

  it("calls onWorktreeChange when toggling worktree", () => {
    // Ensures worktree toggle continues to emit state changes to parent form.
    const onWorktreeChange = vi.fn();
    render(
      <BranchPicker
        cwd="/repo"
        gitRepoInfo={defaultGitRepoInfo}
        selectedBranch="main"
        isNewBranch={false}
        useWorktree={false}
        onBranchChange={vi.fn()}
        onWorktreeChange={onWorktreeChange}
        onBranchesLoaded={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByText("Worktree").closest("button")!);
    expect(onWorktreeChange).toHaveBeenCalledWith(true);
  });

  it("reports empty branch list when branch loading fails", async () => {
    // Covers failure branch in initial list fetch and parent callback behavior.
    mockListBranches.mockRejectedValueOnce(new Error("network"));
    const onBranchesLoaded = vi.fn();
    render(
      <BranchPicker
        cwd="/repo"
        gitRepoInfo={defaultGitRepoInfo}
        selectedBranch="main"
        isNewBranch={false}
        useWorktree={false}
        onBranchChange={vi.fn()}
        onWorktreeChange={vi.fn()}
        onBranchesLoaded={onBranchesLoaded}
      />,
    );

    await waitFor(() => {
      expect(onBranchesLoaded).toHaveBeenCalledWith([]);
    });
  });

  it("trigger button has aria-expanded attribute", async () => {
    // Verifies the dropdown trigger communicates open/closed state to assistive tech.
    render(
      <BranchPicker
        cwd="/repo"
        gitRepoInfo={defaultGitRepoInfo}
        selectedBranch="main"
        isNewBranch={false}
        useWorktree={false}
        onBranchChange={vi.fn()}
        onWorktreeChange={vi.fn()}
        onBranchesLoaded={vi.fn()}
      />,
    );

    const trigger = screen.getByText("main").closest("button")!;
    expect(trigger).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(trigger);
    await waitFor(() => {
      expect(trigger).toHaveAttribute("aria-expanded", "true");
    });
  });

  it("passes axe accessibility checks", async () => {
    const { axe } = await import("vitest-axe");
    const { container } = render(
      <BranchPicker
        cwd="/repo"
        gitRepoInfo={defaultGitRepoInfo}
        selectedBranch="main"
        isNewBranch={false}
        useWorktree={false}
        onBranchChange={vi.fn()}
        onWorktreeChange={vi.fn()}
        onBranchesLoaded={vi.fn()}
      />,
    );
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});
