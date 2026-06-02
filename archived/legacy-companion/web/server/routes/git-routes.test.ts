import { vi, describe, it, expect, beforeEach } from "vitest";

// ─── Mock git-utils module ─────────────────────────────────────────────────
// Mocked before imports so every `import` of git-utils gets the mock.
vi.mock("../git-utils.js", () => ({
  getRepoInfo: vi.fn(() => null),
  listBranches: vi.fn(() => []),
  listWorktrees: vi.fn(() => []),
  ensureWorktree: vi.fn(() => ({
    worktreePath: "/worktrees/feat",
    branch: "feat",
    actualBranch: "feat",
    isNew: true,
  })),
  gitFetch: vi.fn(() => ({ success: true, output: "" })),
  gitPull: vi.fn(() => ({ success: true, output: "" })),
  removeWorktree: vi.fn(() => ({ removed: true })),
}));

// ─── Mock child_process for the git pull ahead/behind count ────────────────
vi.mock("node:child_process", () => ({
  execSync: vi.fn(() => "0\t0"),
}));

// ─── Mock github-pr module for the PR status route ─────────────────────────
vi.mock("../github-pr.js", () => ({
  isGhAvailable: vi.fn(() => false),
  fetchPRInfoAsync: vi.fn(async () => null),
}));

import { Hono } from "hono";
import * as gitUtils from "../git-utils.js";
import { execSync } from "node:child_process";
import { registerGitRoutes } from "./git-routes.js";
import * as githubPr from "../github-pr.js";

// ─── Helpers ───────────────────────────────────────────────────────────────

/** Build a fresh Hono app with the git routes registered. */
function createApp(prPoller?: Parameters<typeof registerGitRoutes>[1]) {
  const app = new Hono();
  registerGitRoutes(app, prPoller);
  return app;
}

/** Shorthand for POST/DELETE requests with a JSON body. */
function jsonRequest(
  path: string,
  body: Record<string, unknown>,
  method: "POST" | "DELETE" = "POST",
) {
  return new Request(`http://localhost${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

// ─── Test Suite ────────────────────────────────────────────────────────────

let app: Hono;

beforeEach(() => {
  vi.clearAllMocks();
  app = createApp();
});

// ═══════════════════════════════════════════════════════════════════════════
// GET /git/repo-info
// ═══════════════════════════════════════════════════════════════════════════

describe("GET /git/repo-info", () => {
  it("returns 400 when path query parameter is missing", async () => {
    // The route requires a `path` query param; omitting it should yield 400
    const res = await app.request("/git/repo-info");

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("path required");
  });

  it("returns 400 when the path is not a git repository", async () => {
    // getRepoInfo returns null for non-git directories
    vi.mocked(gitUtils.getRepoInfo).mockReturnValue(null);

    const res = await app.request("/git/repo-info?path=/tmp/not-a-repo");

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Not a git repository");
    expect(gitUtils.getRepoInfo).toHaveBeenCalledWith("/tmp/not-a-repo");
  });

  it("returns repo info on success", async () => {
    // When getRepoInfo finds a valid repo it returns a GitRepoInfo object
    const mockInfo = {
      repoRoot: "/home/user/project",
      repoName: "project",
      currentBranch: "main",
      defaultBranch: "main",
      isWorktree: false,
    };
    vi.mocked(gitUtils.getRepoInfo).mockReturnValue(mockInfo);

    const res = await app.request(
      `/git/repo-info?path=${encodeURIComponent("/home/user/project")}`,
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual(mockInfo);
    expect(gitUtils.getRepoInfo).toHaveBeenCalledWith("/home/user/project");
  });

  it("passes the raw path value to getRepoInfo", async () => {
    // Ensure URL-decoded paths are forwarded correctly
    vi.mocked(gitUtils.getRepoInfo).mockReturnValue(null);

    await app.request(
      `/git/repo-info?path=${encodeURIComponent("/path/with spaces/repo")}`,
    );

    expect(gitUtils.getRepoInfo).toHaveBeenCalledWith(
      "/path/with spaces/repo",
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// GET /git/branches
// ═══════════════════════════════════════════════════════════════════════════

describe("GET /git/branches", () => {
  it("returns 400 when repoRoot query parameter is missing", async () => {
    const res = await app.request("/git/branches");

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("repoRoot required");
  });

  it("returns an empty list when there are no branches", async () => {
    vi.mocked(gitUtils.listBranches).mockReturnValue([]);

    const res = await app.request("/git/branches?repoRoot=/repo");

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual([]);
    expect(gitUtils.listBranches).toHaveBeenCalledWith("/repo");
  });

  it("returns branch info on success", async () => {
    const branches = [
      {
        name: "main",
        isCurrent: true,
        isRemote: false,
        worktreePath: null,
        ahead: 0,
        behind: 0,
      },
      {
        name: "feature/login",
        isCurrent: false,
        isRemote: false,
        worktreePath: null,
        ahead: 2,
        behind: 1,
      },
    ];
    vi.mocked(gitUtils.listBranches).mockReturnValue(branches);

    const res = await app.request("/git/branches?repoRoot=/repo");

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual(branches);
  });

  it("returns 500 when listBranches throws an error", async () => {
    // The route wraps listBranches in a try/catch and returns 500 on failure
    vi.mocked(gitUtils.listBranches).mockImplementation(() => {
      throw new Error("fatal: not a git repository");
    });

    const res = await app.request("/git/branches?repoRoot=/bad-path");

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("fatal: not a git repository");
  });

  it("handles non-Error throws gracefully by stringifying", async () => {
    // When a non-Error value is thrown, it should be stringified
    vi.mocked(gitUtils.listBranches).mockImplementation(() => {
      throw "unexpected string error"; // eslint-disable-line no-throw-literal
    });

    const res = await app.request("/git/branches?repoRoot=/bad-path");

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("unexpected string error");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// POST /git/fetch
// ═══════════════════════════════════════════════════════════════════════════

describe("POST /git/fetch", () => {
  it("returns 400 when repoRoot is missing from body", async () => {
    const res = await app.request(jsonRequest("/git/fetch", {}));

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("repoRoot required");
  });

  it("returns fetch result on success", async () => {
    vi.mocked(gitUtils.gitFetch).mockReturnValue({
      success: true,
      output: "From origin\n * branch main -> FETCH_HEAD",
    });

    const res = await app.request(
      jsonRequest("/git/fetch", { repoRoot: "/repo" }),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.output).toContain("FETCH_HEAD");
    expect(gitUtils.gitFetch).toHaveBeenCalledWith("/repo");
  });

  it("returns failure result when gitFetch reports failure", async () => {
    vi.mocked(gitUtils.gitFetch).mockReturnValue({
      success: false,
      output: "fatal: could not read from remote repository",
    });

    const res = await app.request(
      jsonRequest("/git/fetch", { repoRoot: "/repo" }),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.output).toContain("could not read from remote repository");
  });

  it("handles malformed JSON body gracefully", async () => {
    // When the body is not valid JSON, the route catches the parse error
    // and falls through to the missing repoRoot check
    const res = await app.request(
      new Request("http://localhost/git/fetch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not json",
      }),
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("repoRoot required");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// GET /git/worktrees
// ═══════════════════════════════════════════════════════════════════════════

describe("GET /git/worktrees", () => {
  it("returns 400 when repoRoot query parameter is missing", async () => {
    const res = await app.request("/git/worktrees");

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("repoRoot required");
  });

  it("returns an empty list when no worktrees exist", async () => {
    vi.mocked(gitUtils.listWorktrees).mockReturnValue([]);

    const res = await app.request("/git/worktrees?repoRoot=/repo");

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual([]);
    expect(gitUtils.listWorktrees).toHaveBeenCalledWith("/repo");
  });

  it("returns worktree info on success", async () => {
    const worktrees = [
      {
        path: "/repo",
        branch: "main",
        head: "abc123",
        isMainWorktree: true,
        isDirty: false,
      },
      {
        path: "/worktrees/feat",
        branch: "feature/login",
        head: "def456",
        isMainWorktree: false,
        isDirty: true,
      },
    ];
    vi.mocked(gitUtils.listWorktrees).mockReturnValue(worktrees);

    const res = await app.request("/git/worktrees?repoRoot=/repo");

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual(worktrees);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// POST /git/worktree (create/ensure)
// ═══════════════════════════════════════════════════════════════════════════

describe("POST /git/worktree", () => {
  it("returns 400 when repoRoot is missing", async () => {
    const res = await app.request(
      jsonRequest("/git/worktree", { branch: "feat" }),
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("repoRoot and branch required");
  });

  it("returns 400 when branch is missing", async () => {
    const res = await app.request(
      jsonRequest("/git/worktree", { repoRoot: "/repo" }),
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("repoRoot and branch required");
  });

  it("returns 400 when both repoRoot and branch are missing", async () => {
    const res = await app.request(jsonRequest("/git/worktree", {}));

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("repoRoot and branch required");
  });

  it("creates a worktree with minimal required params", async () => {
    const result = {
      worktreePath: "/worktrees/feat",
      branch: "feat",
      actualBranch: "feat",
      isNew: true,
    };
    vi.mocked(gitUtils.ensureWorktree).mockReturnValue(result);

    const res = await app.request(
      jsonRequest("/git/worktree", { repoRoot: "/repo", branch: "feat" }),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual(result);
    expect(gitUtils.ensureWorktree).toHaveBeenCalledWith("/repo", "feat", {
      baseBranch: undefined,
      createBranch: undefined,
    });
  });

  it("passes optional baseBranch and createBranch to ensureWorktree", async () => {
    // The route should forward optional parameters from the request body
    vi.mocked(gitUtils.ensureWorktree).mockReturnValue({
      worktreePath: "/worktrees/new-feat",
      branch: "new-feat",
      actualBranch: "new-feat",
      isNew: true,
    });

    const res = await app.request(
      jsonRequest("/git/worktree", {
        repoRoot: "/repo",
        branch: "new-feat",
        baseBranch: "develop",
        createBranch: true,
      }),
    );

    expect(res.status).toBe(200);
    expect(gitUtils.ensureWorktree).toHaveBeenCalledWith(
      "/repo",
      "new-feat",
      {
        baseBranch: "develop",
        createBranch: true,
      },
    );
  });

  it("returns an existing worktree when isNew is false", async () => {
    // ensureWorktree may return an existing worktree rather than creating a new one
    vi.mocked(gitUtils.ensureWorktree).mockReturnValue({
      worktreePath: "/worktrees/feat",
      branch: "feat",
      actualBranch: "feat",
      isNew: false,
    });

    const res = await app.request(
      jsonRequest("/git/worktree", { repoRoot: "/repo", branch: "feat" }),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.isNew).toBe(false);
  });

  it("handles malformed JSON body gracefully", async () => {
    const res = await app.request(
      new Request("http://localhost/git/worktree", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{{bad json",
      }),
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("repoRoot and branch required");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// DELETE /git/worktree
// ═══════════════════════════════════════════════════════════════════════════

describe("DELETE /git/worktree", () => {
  it("returns 400 when repoRoot is missing", async () => {
    const res = await app.request(
      jsonRequest("/git/worktree", { worktreePath: "/wt" }, "DELETE"),
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("repoRoot and worktreePath required");
  });

  it("returns 400 when worktreePath is missing", async () => {
    const res = await app.request(
      jsonRequest("/git/worktree", { repoRoot: "/repo" }, "DELETE"),
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("repoRoot and worktreePath required");
  });

  it("returns 400 when both repoRoot and worktreePath are missing", async () => {
    const res = await app.request(
      jsonRequest("/git/worktree", {}, "DELETE"),
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("repoRoot and worktreePath required");
  });

  it("removes a worktree without force", async () => {
    vi.mocked(gitUtils.removeWorktree).mockReturnValue({ removed: true });

    const res = await app.request(
      jsonRequest(
        "/git/worktree",
        { repoRoot: "/repo", worktreePath: "/worktrees/feat" },
        "DELETE",
      ),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.removed).toBe(true);
    expect(gitUtils.removeWorktree).toHaveBeenCalledWith(
      "/repo",
      "/worktrees/feat",
      { force: undefined },
    );
  });

  it("passes force option when provided", async () => {
    vi.mocked(gitUtils.removeWorktree).mockReturnValue({ removed: true });

    const res = await app.request(
      jsonRequest(
        "/git/worktree",
        { repoRoot: "/repo", worktreePath: "/worktrees/feat", force: true },
        "DELETE",
      ),
    );

    expect(res.status).toBe(200);
    expect(gitUtils.removeWorktree).toHaveBeenCalledWith(
      "/repo",
      "/worktrees/feat",
      { force: true },
    );
  });

  it("returns failure reason when worktree removal fails", async () => {
    // removeWorktree returns { removed: false, reason: "..." } on failure
    vi.mocked(gitUtils.removeWorktree).mockReturnValue({
      removed: false,
      reason: "worktree is dirty",
    });

    const res = await app.request(
      jsonRequest(
        "/git/worktree",
        { repoRoot: "/repo", worktreePath: "/worktrees/feat" },
        "DELETE",
      ),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.removed).toBe(false);
    expect(body.reason).toBe("worktree is dirty");
  });

  it("handles malformed JSON body gracefully", async () => {
    const res = await app.request(
      new Request("http://localhost/git/worktree", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: "invalid",
      }),
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("repoRoot and worktreePath required");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// POST /git/pull
// ═══════════════════════════════════════════════════════════════════════════

describe("POST /git/pull", () => {
  it("returns 400 when cwd is missing from body", async () => {
    const res = await app.request(jsonRequest("/git/pull", {}));

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("cwd required");
  });

  it("returns pull result with ahead/behind counts on success", async () => {
    // After pulling, the route runs `git rev-list` to get ahead/behind counts
    vi.mocked(gitUtils.gitPull).mockReturnValue({
      success: true,
      output: "Already up to date.",
    });
    vi.mocked(execSync).mockReturnValue("3\t5" as any);

    const res = await app.request(jsonRequest("/git/pull", { cwd: "/repo" }));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.output).toBe("Already up to date.");
    // execSync returns "behind\tahead" — the route parses [behind, ahead]
    expect(body.git_behind).toBe(3);
    expect(body.git_ahead).toBe(5);
    expect(gitUtils.gitPull).toHaveBeenCalledWith("/repo");
    expect(execSync).toHaveBeenCalledWith(
      "git rev-list --left-right --count @{upstream}...HEAD",
      { cwd: "/repo", encoding: "utf-8", timeout: 3000 },
    );
  });

  it("returns zeros for ahead/behind when execSync throws (no upstream)", async () => {
    // When there's no upstream tracking branch, execSync throws and
    // the route silently catches the error and defaults to 0/0
    vi.mocked(gitUtils.gitPull).mockReturnValue({
      success: true,
      output: "Already up to date.",
    });
    vi.mocked(execSync).mockImplementation(() => {
      throw new Error("fatal: no upstream configured");
    });

    const res = await app.request(jsonRequest("/git/pull", { cwd: "/repo" }));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.git_ahead).toBe(0);
    expect(body.git_behind).toBe(0);
  });

  it("returns pull failure result from gitPull", async () => {
    // gitPull itself can report failure (e.g. merge conflicts)
    vi.mocked(gitUtils.gitPull).mockReturnValue({
      success: false,
      output: "CONFLICT (content): Merge conflict in file.txt",
    });
    vi.mocked(execSync).mockReturnValue("0\t0" as any);

    const res = await app.request(jsonRequest("/git/pull", { cwd: "/repo" }));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.output).toContain("CONFLICT");
    // ahead/behind still get computed even when pull fails
    expect(body.git_ahead).toBe(0);
    expect(body.git_behind).toBe(0);
  });

  it("handles tab-separated output with extra whitespace", async () => {
    // Verify the route's split/parse logic handles various whitespace in execSync output
    vi.mocked(gitUtils.gitPull).mockReturnValue({
      success: true,
      output: "",
    });
    vi.mocked(execSync).mockReturnValue("12\t7" as any);

    const res = await app.request(jsonRequest("/git/pull", { cwd: "/repo" }));

    const body = await res.json();
    expect(body.git_behind).toBe(12);
    expect(body.git_ahead).toBe(7);
  });

  it("handles malformed JSON body gracefully", async () => {
    const res = await app.request(
      new Request("http://localhost/git/pull", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "nope",
      }),
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("cwd required");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// GET /git/pr-status
// ═══════════════════════════════════════════════════════════════════════════

describe("GET /git/pr-status", () => {
  it("returns 400 when cwd is missing", async () => {
    const res = await app.request("/git/pr-status?branch=main");

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("cwd and branch required");
  });

  it("returns 400 when branch is missing", async () => {
    const res = await app.request("/git/pr-status?cwd=/repo");

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("cwd and branch required");
  });

  it("returns 400 when both cwd and branch are missing", async () => {
    const res = await app.request("/git/pr-status");

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("cwd and branch required");
  });

  it("returns cached data from prPoller when available", async () => {
    // When a prPoller is provided and has cached data, the route returns
    // it immediately without calling github-pr functions
    const cachedData = {
      available: true,
      pr: {
        number: 42,
        title: "Add feature",
        url: "https://github.com/org/repo/pull/42",
        state: "OPEN" as const,
        isDraft: false,
        reviewDecision: null,
        additions: 10,
        deletions: 5,
        changedFiles: 2,
        checks: [],
        checksSummary: { total: 0, success: 0, failure: 0, pending: 0 },
        reviewThreads: { total: 0, resolved: 0, unresolved: 0 },
      },
    };
    const mockPoller = {
      getCached: vi.fn(() => cachedData),
    };
    const appWithPoller = createApp(mockPoller as any);

    const res = await appWithPoller.request(
      "/git/pr-status?cwd=/repo&branch=feat",
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual(cachedData);
    expect(mockPoller.getCached).toHaveBeenCalledWith("/repo", "feat");
  });

  it("falls through to github-pr when prPoller has no cache", async () => {
    // prPoller.getCached returns null -> route falls through to dynamic import path
    const mockPoller = {
      getCached: vi.fn(() => null),
    };
    const appWithPoller = createApp(mockPoller as any);
    vi.mocked(githubPr.isGhAvailable).mockReturnValue(false);

    const res = await appWithPoller.request(
      "/git/pr-status?cwd=/repo&branch=feat",
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ available: false, pr: null });
    expect(mockPoller.getCached).toHaveBeenCalledWith("/repo", "feat");
  });

  it("returns unavailable when gh CLI is not installed (no prPoller)", async () => {
    // Without a prPoller, the route goes directly to the dynamic import path
    // and isGhAvailable returns false
    vi.mocked(githubPr.isGhAvailable).mockReturnValue(false);

    const res = await app.request("/git/pr-status?cwd=/repo&branch=main");

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.available).toBe(false);
    expect(body.pr).toBeNull();
  });

  it("fetches PR info when gh is available and no poller cache", async () => {
    // When gh is available, the route calls fetchPRInfoAsync and returns the result
    const mockPr = {
      number: 99,
      title: "Fix bug",
      url: "https://github.com/org/repo/pull/99",
      state: "OPEN" as const,
      isDraft: false,
      reviewDecision: "APPROVED" as const,
      additions: 20,
      deletions: 3,
      changedFiles: 1,
      checks: [{ name: "ci", status: "completed", conclusion: "success" }],
      checksSummary: { total: 1, success: 1, failure: 0, pending: 0 },
      reviewThreads: { total: 2, resolved: 2, unresolved: 0 },
    };
    vi.mocked(githubPr.isGhAvailable).mockReturnValue(true);
    vi.mocked(githubPr.fetchPRInfoAsync).mockResolvedValue(mockPr);

    const res = await app.request("/git/pr-status?cwd=/repo&branch=fix-bug");

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.available).toBe(true);
    expect(body.pr).toEqual(mockPr);
    expect(githubPr.fetchPRInfoAsync).toHaveBeenCalledWith(
      "/repo",
      "fix-bug",
    );
  });

  it("returns null PR when fetchPRInfoAsync finds no PR for the branch", async () => {
    // gh is available but there's no PR for this branch
    vi.mocked(githubPr.isGhAvailable).mockReturnValue(true);
    vi.mocked(githubPr.fetchPRInfoAsync).mockResolvedValue(null);

    const res = await app.request(
      "/git/pr-status?cwd=/repo&branch=no-pr-here",
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.available).toBe(true);
    expect(body.pr).toBeNull();
  });

  it("skips prPoller entirely when none is provided", async () => {
    // When registerGitRoutes is called without a prPoller argument,
    // the route goes straight to the github-pr import path
    vi.mocked(githubPr.isGhAvailable).mockReturnValue(true);
    vi.mocked(githubPr.fetchPRInfoAsync).mockResolvedValue(null);

    const res = await app.request(
      "/git/pr-status?cwd=/repo&branch=some-branch",
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.available).toBe(true);
    // Verify github-pr was called (would not be if poller had returned cached)
    expect(githubPr.isGhAvailable).toHaveBeenCalled();
  });
});
