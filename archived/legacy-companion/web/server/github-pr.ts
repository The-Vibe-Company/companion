import { execFileSync, execSync } from "node:child_process";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface GitHubCheckStatus {
  name: string;
  status: string;
  conclusion: string | null;
}

export interface GitHubPRInfo {
  number: number;
  title: string;
  url: string;
  state: "OPEN" | "CLOSED" | "MERGED";
  isDraft: boolean;
  reviewDecision: "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | null;
  additions: number;
  deletions: number;
  changedFiles: number;
  checks: GitHubCheckStatus[];
  checksSummary: {
    total: number;
    success: number;
    failure: number;
    pending: number;
  };
  reviewThreads: {
    total: number;
    resolved: number;
    unresolved: number;
  };
}

export interface PRStatusResponse {
  available: boolean;
  pr: GitHubPRInfo | null;
}

// ─── gh CLI Detection ────────────────────────────────────────────────────────

let _ghAvailable: boolean | null = null;

export function isGhAvailable(): boolean {
  if (_ghAvailable !== null) return _ghAvailable;
  try {
    execSync("which gh", { stdio: "pipe", timeout: 5_000 });
    _ghAvailable = true;
  } catch {
    _ghAvailable = false;
  }
  return _ghAvailable;
}

// Exported for testing
export function _resetGhAvailable() {
  _ghAvailable = null;
}

// ─── Repo Slug Resolution ────────────────────────────────────────────────────

const repoSlugCache = new Map<string, { slug: string | null; timestamp: number }>();
const REPO_SLUG_TTL = 5 * 60_000; // 5 minutes

function getRepoSlug(cwd: string): string | null {
  const cached = repoSlugCache.get(cwd);
  if (cached && Date.now() - cached.timestamp < REPO_SLUG_TTL) {
    return cached.slug;
  }
  try {
    const slug = execSync("gh repo view --json nameWithOwner --jq .nameWithOwner", {
      cwd,
      stdio: "pipe",
      timeout: 10_000,
    })
      .toString()
      .trim();
    const result = slug || null;
    repoSlugCache.set(cwd, { slug: result, timestamp: Date.now() });
    return result;
  } catch {
    repoSlugCache.set(cwd, { slug: null, timestamp: Date.now() });
    return null;
  }
}

async function getRepoSlugAsync(cwd: string): Promise<string | null> {
  const cached = repoSlugCache.get(cwd);
  if (cached && Date.now() - cached.timestamp < REPO_SLUG_TTL) {
    return cached.slug;
  }
  try {
    const proc = Bun.spawn(
      ["gh", "repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"],
      { cwd, stdout: "pipe", stderr: "pipe" },
    );
    const timeout = setTimeout(() => proc.kill(), 10_000);
    const exitCode = await proc.exited;
    clearTimeout(timeout);
    if (exitCode !== 0) {
      repoSlugCache.set(cwd, { slug: null, timestamp: Date.now() });
      return null;
    }
    const slug = (await new Response(proc.stdout).text()).trim();
    const result = slug || null;
    repoSlugCache.set(cwd, { slug: result, timestamp: Date.now() });
    return result;
  } catch {
    repoSlugCache.set(cwd, { slug: null, timestamp: Date.now() });
    return null;
  }
}

// ─── PR Data Cache ───────────────────────────────────────────────────────────

const prCache = new Map<string, { data: GitHubPRInfo | null; timestamp: number; ttl: number }>();
const PR_CACHE_TTL = 30_000; // 30 seconds (default / legacy)

// Exported for testing
export function _clearCaches() {
  prCache.clear();
  repoSlugCache.clear();
  _ghAvailable = null;
}

// ─── Adaptive TTL ───────────────────────────────────────────────────────────

/** Compute polling interval based on PR state. */
export function computeAdaptiveTTL(pr: GitHubPRInfo | null): number {
  if (!pr) return 60_000; // No PR found — check again in 60s

  // Merged or closed — terminal state, rarely changes
  if (pr.state === "MERGED" || pr.state === "CLOSED") return 300_000; // 5 minutes

  // CI actively running (pending checks) — user is watching
  if (pr.checksSummary.pending > 0) return 10_000; // 10 seconds

  // CI failed — user likely pushing fixes
  if (pr.checksSummary.failure > 0) return 30_000; // 30 seconds

  // Changes requested — moderate frequency
  if (pr.reviewDecision === "CHANGES_REQUESTED") return 30_000; // 30 seconds

  // Approved, all checks passed — stable
  if (pr.reviewDecision === "APPROVED" && pr.checksSummary.pending === 0) return 120_000; // 2 minutes

  // Review pending, checks passed — waiting on human reviewer
  if (pr.reviewDecision === "REVIEW_REQUIRED" || pr.reviewDecision === null) return 45_000; // 45 seconds

  // Default fallback
  return 30_000;
}

// ─── GraphQL Query ───────────────────────────────────────────────────────────

const PR_QUERY = `
query($owner: String!, $name: String!, $branch: String!) {
  repository(owner: $owner, name: $name) {
    pullRequests(headRefName: $branch, first: 5, orderBy: {field: UPDATED_AT, direction: DESC}, states: [OPEN, MERGED]) {
      nodes {
        number
        title
        url
        state
        isDraft
        isCrossRepository
        reviewDecision
        additions
        deletions
        changedFiles
        reviewThreads(first: 100) {
          totalCount
          nodes {
            isResolved
          }
        }
        commits(last: 1) {
          nodes {
            commit {
              statusCheckRollup {
                contexts(first: 50) {
                  nodes {
                    __typename
                    ... on CheckRun {
                      name
                      status
                      conclusion
                    }
                    ... on StatusContext {
                      context
                      state
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
}`;

// ─── Response Parsing ────────────────────────────────────────────────────────

interface GraphQLCheckRunNode {
  __typename: "CheckRun";
  name: string;
  status: string;
  conclusion: string | null;
}

interface GraphQLStatusContextNode {
  __typename: "StatusContext";
  context: string;
  state: string;
}

type GraphQLContextNode = GraphQLCheckRunNode | GraphQLStatusContextNode;

export function parseGraphQLResponse(data: unknown): GitHubPRInfo | null {
  try {
    const repo = (data as any)?.data?.repository;
    const nodes = repo?.pullRequests?.nodes;
    if (!nodes || nodes.length === 0) return null;

    // Filter out cross-repository (fork) PRs — we only want same-repo PRs
    const sameRepoPRs = nodes.filter((n: any) => !n.isCrossRepository);
    if (sameRepoPRs.length === 0) return null;

    const pr = sameRepoPRs[0];

    // Normalize checks
    const rawContexts: GraphQLContextNode[] =
      pr.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts?.nodes ?? [];

    const checks: GitHubCheckStatus[] = rawContexts.map((node) => {
      if (node.__typename === "CheckRun") {
        return {
          name: node.name,
          status: node.status,
          conclusion: node.conclusion,
        };
      }
      // StatusContext
      return {
        name: node.context,
        status: node.state === "PENDING" ? "IN_PROGRESS" : "COMPLETED",
        conclusion: node.state === "SUCCESS" ? "SUCCESS" : (node.state === "FAILURE" || node.state === "ERROR") ? "FAILURE" : null,
      };
    });

    // Compute summary
    let success = 0;
    let failure = 0;
    let pending = 0;
    for (const check of checks) {
      if (check.conclusion === "SUCCESS" || check.conclusion === "NEUTRAL" || check.conclusion === "SKIPPED") {
        success++;
      } else if (check.conclusion === "FAILURE" || check.conclusion === "CANCELLED" || check.conclusion === "TIMED_OUT") {
        failure++;
      } else {
        pending++;
      }
    }

    // Compute review threads
    const threadNodes: { isResolved: boolean }[] = pr.reviewThreads?.nodes ?? [];
    const resolved = threadNodes.filter((t) => t.isResolved).length;
    const unresolved = threadNodes.filter((t) => !t.isResolved).length;

    return {
      number: pr.number,
      title: pr.title,
      url: pr.url,
      state: pr.state,
      isDraft: pr.isDraft ?? false,
      reviewDecision: pr.reviewDecision || null,
      additions: pr.additions ?? 0,
      deletions: pr.deletions ?? 0,
      changedFiles: pr.changedFiles ?? 0,
      checks,
      checksSummary: { total: checks.length, success, failure, pending },
      reviewThreads: {
        total: pr.reviewThreads?.totalCount ?? 0,
        resolved,
        unresolved,
      },
    };
  } catch {
    return null;
  }
}

// ─── Main Fetch Function (sync — legacy, used by tests) ─────────────────────

export async function fetchPRInfo(cwd: string, branch: string): Promise<GitHubPRInfo | null> {
  if (!isGhAvailable()) return null;

  const cacheKey = `${cwd}:${branch}`;
  const cached = prCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < cached.ttl) {
    return cached.data;
  }

  const slug = getRepoSlug(cwd);
  if (!slug) {
    prCache.set(cacheKey, { data: null, timestamp: Date.now(), ttl: PR_CACHE_TTL });
    return null;
  }

  const [owner, name] = slug.split("/");
  if (!owner || !name) return null;

  try {
    const result = execFileSync(
      "gh",
      ["api", "graphql", "-f", `query=${PR_QUERY}`, "-f", `owner=${owner}`, "-f", `name=${name}`, "-f", `branch=${branch}`],
      { cwd, stdio: "pipe", timeout: 15_000 },
    )
      .toString()
      .trim();

    const parsed = JSON.parse(result);
    const prInfo = parseGraphQLResponse(parsed);
    const ttl = computeAdaptiveTTL(prInfo);
    prCache.set(cacheKey, { data: prInfo, timestamp: Date.now(), ttl });
    return prInfo;
  } catch {
    prCache.set(cacheKey, { data: null, timestamp: Date.now(), ttl: PR_CACHE_TTL });
    return null;
  }
}

// ─── Async Fetch Function (non-blocking, uses Bun.spawn) ────────────────────

export async function fetchPRInfoAsync(cwd: string, branch: string): Promise<GitHubPRInfo | null> {
  if (!isGhAvailable()) return null;

  const cacheKey = `${cwd}:${branch}`;
  const cached = prCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < cached.ttl) {
    return cached.data;
  }

  const slug = await getRepoSlugAsync(cwd);
  if (!slug) {
    prCache.set(cacheKey, { data: null, timestamp: Date.now(), ttl: 60_000 });
    return null;
  }

  const [owner, name] = slug.split("/");
  if (!owner || !name) return null;

  try {
    const proc = Bun.spawn(
      ["gh", "api", "graphql", "-f", `query=${PR_QUERY}`, "-f", `owner=${owner}`, "-f", `name=${name}`, "-f", `branch=${branch}`],
      { cwd, stdout: "pipe", stderr: "pipe" },
    );
    const timeout = setTimeout(() => proc.kill(), 15_000);
    const exitCode = await proc.exited;
    clearTimeout(timeout);

    if (exitCode !== 0) {
      prCache.set(cacheKey, { data: null, timestamp: Date.now(), ttl: PR_CACHE_TTL });
      return null;
    }

    const stdout = (await new Response(proc.stdout).text()).trim();
    const parsed = JSON.parse(stdout);
    const prInfo = parseGraphQLResponse(parsed);
    const ttl = computeAdaptiveTTL(prInfo);
    prCache.set(cacheKey, { data: prInfo, timestamp: Date.now(), ttl });
    return prInfo;
  } catch {
    prCache.set(cacheKey, { data: null, timestamp: Date.now(), ttl: PR_CACHE_TTL });
    return null;
  }
}
