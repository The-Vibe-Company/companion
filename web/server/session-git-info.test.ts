import { describe, it, expect, vi, beforeEach } from "vitest";

// Hoist mocks before any imports
const mockExecSync = vi.hoisted(() => vi.fn());
const mockGetContainer = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
  execSync: mockExecSync,
}));

vi.mock("./container-manager.js", () => ({
  containerManager: {
    getContainer: mockGetContainer,
  },
}));

import { resolveSessionGitInfo } from "./session-git-info.js";
import type { SessionState } from "./session-types.js";

/** Helper to create a minimal SessionState for testing. */
function makeState(overrides: Partial<SessionState> = {}): SessionState {
  return {
    session_id: "test-session",
    model: "claude-4",
    cwd: "/home/user/project",
    tools: [],
    permissionMode: "default",
    claude_code_version: "1.0.0",
    mcp_servers: [],
    agents: [],
    slash_commands: [],
    skills: [],
    total_cost_usd: 0,
    num_turns: 0,
    context_used_percent: 0,
    is_compacting: false,
    git_branch: "",
    is_worktree: false,
    is_containerized: false,
    repo_root: "",
    git_ahead: 0,
    git_behind: 0,
    total_lines_added: 0,
    total_lines_removed: 0,
    ...overrides,
  };
}

describe("resolveSessionGitInfo", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // --- Normal cases ---

  it("should_set_git_branch_when_in_git_repo", () => {
    // Mock git commands in order of invocation:
    // 1. git rev-parse --abbrev-ref HEAD
    // 2. git rev-parse --git-dir
    // 3. git rev-parse --show-toplevel
    // 4. git rev-list --left-right --count
    mockExecSync
      .mockReturnValueOnce("  main  ")  // branch (with whitespace to verify trim)
      .mockReturnValueOnce("  .git  ")  // git-dir
      .mockReturnValueOnce("  /home/user/project  ")  // toplevel
      .mockReturnValueOnce("  2\t3  ");  // behind=2, ahead=3

    const state = makeState();
    resolveSessionGitInfo("sess-1", state);

    expect(state.git_branch).toBe("main");
    expect(state.is_worktree).toBe(false);
    expect(state.repo_root).toBe("/home/user/project");
    expect(state.git_ahead).toBe(3);
    expect(state.git_behind).toBe(2);
  });

  it("should_detect_worktree_when_git_dir_contains_worktrees", () => {
    mockExecSync
      .mockReturnValueOnce("feature-branch")  // branch
      .mockReturnValueOnce("/home/user/project/.git/worktrees/feature")  // git-dir
      .mockReturnValueOnce("../../.git")  // git-common-dir (for worktree)
      .mockReturnValueOnce("0\t0");  // ahead/behind

    const state = makeState();
    resolveSessionGitInfo("sess-1", state);

    expect(state.is_worktree).toBe(true);
  });

  it("should_set_ahead_behind_to_zero_when_no_upstream", () => {
    mockExecSync
      .mockReturnValueOnce("main")  // branch
      .mockReturnValueOnce(".git")  // git-dir
      .mockReturnValueOnce("/repo")  // toplevel
      .mockImplementationOnce(() => { throw new Error("no upstream"); });  // rev-list fails

    const state = makeState();
    resolveSessionGitInfo("sess-1", state);

    expect(state.git_ahead).toBe(0);
    expect(state.git_behind).toBe(0);
  });

  // --- No cwd ---

  it("should_return_early_when_cwd_is_empty", () => {
    const state = makeState({ cwd: "" });
    resolveSessionGitInfo("sess-1", state);

    expect(mockExecSync).not.toHaveBeenCalled();
  });

  // --- Not a git repo ---

  it("should_clear_git_state_when_not_in_git_repo", () => {
    // The first git command (rev-parse --abbrev-ref HEAD) fails
    mockExecSync.mockImplementation(() => {
      throw new Error("fatal: not a git repository");
    });

    const state = makeState({
      git_branch: "old-branch",
      is_worktree: true,
      repo_root: "/old/root",
      git_ahead: 5,
      git_behind: 3,
    });
    resolveSessionGitInfo("sess-1", state);

    expect(state.git_branch).toBe("");
    expect(state.is_worktree).toBe(false);
    expect(state.repo_root).toBe("");
    expect(state.git_ahead).toBe(0);
    expect(state.git_behind).toBe(0);
  });

  // --- Container support ---

  it("should_run_git_via_docker_exec_when_containerized", () => {
    mockGetContainer.mockReturnValue({
      containerId: "abc123",
      containerCwd: "/workspace",
      hostCwd: "/home/user/project",
    });

    mockExecSync
      .mockReturnValueOnce("develop")  // branch
      .mockReturnValueOnce(".git")  // git-dir
      .mockReturnValueOnce("/workspace")  // toplevel
      .mockReturnValueOnce("0\t1");  // ahead/behind

    const state = makeState({ is_containerized: true });
    resolveSessionGitInfo("sess-1", state);

    // Verify docker exec was used
    expect(mockExecSync.mock.calls[0]![0]).toContain("docker exec");
    expect(mockExecSync.mock.calls[0]![0]).toContain("abc123");
    expect(state.git_branch).toBe("develop");
  });

  it("should_map_container_path_to_host_when_containerized", () => {
    mockGetContainer.mockReturnValue({
      containerId: "abc123",
      containerCwd: "/workspace",
      hostCwd: "/home/user/project",
    });

    mockExecSync
      .mockReturnValueOnce("main")  // branch
      .mockReturnValueOnce(".git")  // git-dir (not worktree)
      .mockReturnValueOnce("/workspace")  // toplevel = container path
      .mockReturnValueOnce("0\t0");

    const state = makeState({ is_containerized: true });
    resolveSessionGitInfo("sess-1", state);

    // repo_root should be mapped from /workspace to host path
    expect(state.repo_root).toBe("/home/user/project");
  });

  it("should_map_container_subpath_to_host_when_containerized", () => {
    mockGetContainer.mockReturnValue({
      containerId: "abc123",
      containerCwd: "/workspace",
      hostCwd: "/home/user/project",
    });

    mockExecSync
      .mockReturnValueOnce("main")
      .mockReturnValueOnce(".git")
      .mockReturnValueOnce("/workspace/sub/dir")  // subpath under container cwd
      .mockReturnValueOnce("0\t0");

    const state = makeState({ is_containerized: true });
    resolveSessionGitInfo("sess-1", state);

    expect(state.repo_root).toBe("/home/user/project/sub/dir");
  });

  it("should_restore_previous_state_when_container_not_tracked", () => {
    // No container registered = getContainer returns undefined
    mockGetContainer.mockReturnValue(undefined);

    const state = makeState({
      is_containerized: true,
      git_branch: "saved-branch",
      is_worktree: true,
      repo_root: "/saved/root",
      git_ahead: 7,
      git_behind: 2,
    });

    resolveSessionGitInfo("sess-1", state);

    // State should be restored to previous values
    expect(state.git_branch).toBe("saved-branch");
    expect(state.is_worktree).toBe(true);
    expect(state.repo_root).toBe("/saved/root");
    expect(state.git_ahead).toBe(7);
    expect(state.git_behind).toBe(2);
    expect(state.is_containerized).toBe(true);
  });

  it("should_preserve_is_containerized_when_resolving_succeeds", () => {
    mockGetContainer.mockReturnValue({
      containerId: "abc123",
      containerCwd: "/workspace",
      hostCwd: "/host",
    });

    mockExecSync
      .mockReturnValueOnce("main")
      .mockReturnValueOnce(".git")
      .mockReturnValueOnce("/workspace")
      .mockReturnValueOnce("0\t0");

    const state = makeState({ is_containerized: true });
    resolveSessionGitInfo("sess-1", state);

    expect(state.is_containerized).toBe(true);
  });

  it("should_preserve_is_containerized_when_git_fails_in_non_container", () => {
    mockExecSync.mockImplementation(() => {
      throw new Error("not a git repo");
    });

    const state = makeState({ is_containerized: false });
    resolveSessionGitInfo("sess-1", state);

    expect(state.is_containerized).toBe(false);
  });

  // --- Edge cases ---

  it("should_handle_git_dir_failure_gracefully_when_branch_succeeds", () => {
    mockExecSync
      .mockReturnValueOnce("main")  // branch succeeds
      .mockImplementationOnce(() => { throw new Error("git-dir failed"); })  // git-dir fails
      .mockReturnValueOnce("/repo")  // toplevel (called because is_worktree defaults to false from catch)
      .mockReturnValueOnce("1\t0");

    const state = makeState();
    resolveSessionGitInfo("sess-1", state);

    expect(state.git_branch).toBe("main");
    expect(state.is_worktree).toBe(false);
  });

  it("should_handle_toplevel_failure_gracefully_when_other_commands_succeed", () => {
    mockExecSync
      .mockReturnValueOnce("main")
      .mockReturnValueOnce(".git")
      .mockImplementationOnce(() => { throw new Error("toplevel failed"); })  // toplevel fails
      .mockReturnValueOnce("0\t0");

    const state = makeState({ repo_root: "/old/root" });
    resolveSessionGitInfo("sess-1", state);

    expect(state.git_branch).toBe("main");
    // repo_root should remain unchanged since the try/catch ignores the error
    expect(state.repo_root).toBe("/old/root");
  });

  it("should_escape_single_quotes_in_container_cwd_when_running_docker_exec", () => {
    mockGetContainer.mockReturnValue({
      containerId: "abc123",
      containerCwd: "/work/it's here",
      hostCwd: "/host",
    });

    mockExecSync
      .mockReturnValueOnce("main")
      .mockReturnValueOnce(".git")
      .mockReturnValueOnce("/work/it's here")
      .mockReturnValueOnce("0\t0");

    const state = makeState({ is_containerized: true });
    resolveSessionGitInfo("sess-1", state);

    // The docker command should contain the shell-escaped single quote pattern.
    // shellEscapeSingle replaces ' with '\'' (end-quote, escaped-quote, start-quote).
    const firstCall = mockExecSync.mock.calls[0]![0] as string;
    // Verify the raw quote was NOT passed through unescaped
    expect(firstCall).not.toContain("it's here");
    // Verify escape sequence is present: ' is replaced with '\'' (quote, backslash, quote, quote)
    expect(firstCall).toMatch(/it'\\\\''s here/);
  });

  it("should_use_local_exec_when_not_containerized", () => {
    mockExecSync
      .mockReturnValueOnce("main")
      .mockReturnValueOnce(".git")
      .mockReturnValueOnce("/repo")
      .mockReturnValueOnce("0\t0");

    const state = makeState({ cwd: "/my/project" });
    resolveSessionGitInfo("sess-1", state);

    // First call should NOT contain "docker exec"
    const firstCall = mockExecSync.mock.calls[0]![0] as string;
    expect(firstCall).not.toContain("docker exec");

    // Should use cwd option
    expect(mockExecSync.mock.calls[0]![1]).toEqual(
      expect.objectContaining({ cwd: "/my/project" }),
    );
  });

  it("should_handle_NaN_in_ahead_behind_counts_when_git_returns_unexpected", () => {
    mockExecSync
      .mockReturnValueOnce("main")
      .mockReturnValueOnce(".git")
      .mockReturnValueOnce("/repo")
      .mockReturnValueOnce("abc\tdef");  // non-numeric counts

    const state = makeState();
    resolveSessionGitInfo("sess-1", state);

    // NaN || 0 = 0 due to the `|| 0` fallback in the source
    expect(state.git_ahead).toBe(0);
    expect(state.git_behind).toBe(0);
  });

  it("should_default_container_cwd_to_workspace_when_not_set", () => {
    mockGetContainer.mockReturnValue({
      containerId: "abc123",
      // containerCwd and hostCwd not set
    });

    mockExecSync
      .mockReturnValueOnce("main")
      .mockReturnValueOnce(".git")
      .mockReturnValueOnce("/workspace")
      .mockReturnValueOnce("0\t0");

    const state = makeState({ is_containerized: true });
    resolveSessionGitInfo("sess-1", state);

    // Should default to /workspace in the docker command
    const firstCall = mockExecSync.mock.calls[0]![0] as string;
    expect(firstCall).toContain("/workspace");
  });
});
