import { execSync } from "node:child_process";
import { resolve } from "node:path";
import type { SessionState } from "./session-types.js";
import { containerManager } from "./container-manager.js";

function shellEscapeSingle(value: string): string {
  return value.replace(/'/g, "'\\''");
}

function runGitCommand(sessionId: string, state: SessionState, command: string): string {
  if (state.is_containerized) {
    const container = containerManager.getContainer(sessionId);
    if (container?.containerId) {
      const containerCwd = container.containerCwd || "/workspace";
      const inner = `cd '${shellEscapeSingle(containerCwd)}' && ${command}`;
      const dockerCmd = `docker exec ${container.containerId} sh -lc ${JSON.stringify(inner)}`;
      return execSync(dockerCmd, { encoding: "utf-8", timeout: 3000 }).trim();
    }
    throw new Error("container not tracked");
  }

  return execSync(command, {
    cwd: state.cwd,
    encoding: "utf-8",
    timeout: 3000,
  }).trim();
}

function mapContainerPathToHost(sessionId: string, state: SessionState, pathValue: string): string {
  if (!state.is_containerized || !pathValue) return pathValue;
  const container = containerManager.getContainer(sessionId);
  const containerCwd = (container?.containerCwd || "/workspace").replace(/\/+$/, "") || "/";
  const hostCwd = (container?.hostCwd || state.cwd || "").replace(/\/+$/, "") || "/";

  if (pathValue === containerCwd) return hostCwd;
  if (containerCwd !== "/" && pathValue.startsWith(`${containerCwd}/`)) {
    return `${hostCwd}${pathValue.slice(containerCwd.length)}`;
  }
  return pathValue;
}

export function resolveSessionGitInfo(sessionId: string, state: SessionState): void {
  if (!state.cwd) return;
  const wasContainerized = state.is_containerized;
  const previous = {
    git_branch: state.git_branch,
    is_worktree: state.is_worktree,
    repo_root: state.repo_root,
    git_ahead: state.git_ahead,
    git_behind: state.git_behind,
  };
  try {
    state.git_branch = runGitCommand(sessionId, state, "git rev-parse --abbrev-ref HEAD 2>/dev/null");

    try {
      const gitDir = runGitCommand(sessionId, state, "git rev-parse --git-dir 2>/dev/null");
      state.is_worktree = gitDir.includes("/worktrees/");
    } catch {
      state.is_worktree = false;
    }

    try {
      if (state.is_worktree) {
        const commonDir = runGitCommand(sessionId, state, "git rev-parse --git-common-dir 2>/dev/null");
        state.repo_root = resolve(state.cwd, commonDir, "..");
      } else {
        state.repo_root = runGitCommand(sessionId, state, "git rev-parse --show-toplevel 2>/dev/null");
      }
      state.repo_root = mapContainerPathToHost(sessionId, state, state.repo_root);
    } catch {
      // Ignore repo root resolution failures
    }

    try {
      const counts = runGitCommand(
        sessionId,
        state,
        "git rev-list --left-right --count @{upstream}...HEAD 2>/dev/null",
      );
      const [behind, ahead] = counts.split(/\s+/).map(Number);
      state.git_ahead = ahead || 0;
      state.git_behind = behind || 0;
    } catch {
      state.git_ahead = 0;
      state.git_behind = 0;
    }
  } catch (error) {
    if (state.is_containerized && error instanceof Error && error.message === "container not tracked") {
      state.git_branch = previous.git_branch;
      state.is_worktree = previous.is_worktree;
      state.repo_root = previous.repo_root;
      state.git_ahead = previous.git_ahead;
      state.git_behind = previous.git_behind;
      state.is_containerized = wasContainerized;
      return;
    }
    state.git_branch = "";
    state.is_worktree = false;
    state.repo_root = "";
    state.git_ahead = 0;
    state.git_behind = 0;
  }
  state.is_containerized = wasContainerized;
}
