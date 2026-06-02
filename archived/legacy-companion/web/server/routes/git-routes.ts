import { execSync } from "node:child_process";
import type { Hono } from "hono";
import * as gitUtils from "../git-utils.js";
import type { PRPoller } from "../pr-poller.js";

export function registerGitRoutes(api: Hono, prPoller?: PRPoller): void {
  api.get("/git/repo-info", (c) => {
    const path = c.req.query("path");
    if (!path) return c.json({ error: "path required" }, 400);
    const info = gitUtils.getRepoInfo(path);
    if (!info) return c.json({ error: "Not a git repository" }, 400);
    return c.json(info);
  });

  api.get("/git/branches", (c) => {
    const repoRoot = c.req.query("repoRoot");
    if (!repoRoot) return c.json({ error: "repoRoot required" }, 400);
    try {
      return c.json(gitUtils.listBranches(repoRoot));
    } catch (e: unknown) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
    }
  });

  api.post("/git/fetch", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const { repoRoot } = body;
    if (!repoRoot) return c.json({ error: "repoRoot required" }, 400);
    return c.json(gitUtils.gitFetch(repoRoot));
  });

  api.get("/git/worktrees", (c) => {
    const repoRoot = c.req.query("repoRoot");
    if (!repoRoot) return c.json({ error: "repoRoot required" }, 400);
    return c.json(gitUtils.listWorktrees(repoRoot));
  });

  api.post("/git/worktree", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const { repoRoot, branch, baseBranch, createBranch } = body;
    if (!repoRoot || !branch) return c.json({ error: "repoRoot and branch required" }, 400);
    const result = gitUtils.ensureWorktree(repoRoot, branch, { baseBranch, createBranch });
    return c.json(result);
  });

  api.delete("/git/worktree", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const { repoRoot, worktreePath, force } = body;
    if (!repoRoot || !worktreePath) return c.json({ error: "repoRoot and worktreePath required" }, 400);
    const result = gitUtils.removeWorktree(repoRoot, worktreePath, { force });
    return c.json(result);
  });

  api.post("/git/pull", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const { cwd } = body;
    if (!cwd) return c.json({ error: "cwd required" }, 400);
    const result = gitUtils.gitPull(cwd);
    let git_ahead = 0;
    let git_behind = 0;
    try {
      const counts = execSync(
        "git rev-list --left-right --count @{upstream}...HEAD",
        {
          cwd,
          encoding: "utf-8",
          timeout: 3000,
        },
      ).trim();
      const [behind, ahead] = counts.split(/\s+/).map(Number);
      git_ahead = ahead || 0;
      git_behind = behind || 0;
    } catch {
      // no upstream
    }
    return c.json({ ...result, git_ahead, git_behind });
  });

  api.get("/git/pr-status", async (c) => {
    const cwd = c.req.query("cwd");
    const branch = c.req.query("branch");
    if (!cwd || !branch) return c.json({ error: "cwd and branch required" }, 400);

    if (prPoller) {
      const cached = prPoller.getCached(cwd, branch);
      if (cached) return c.json(cached);
    }

    const { isGhAvailable, fetchPRInfoAsync } = await import("../github-pr.js");
    if (!isGhAvailable()) {
      return c.json({ available: false, pr: null });
    }

    const pr = await fetchPRInfoAsync(cwd, branch);
    return c.json({ available: true, pr });
  });
}
