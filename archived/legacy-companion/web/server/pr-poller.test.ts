import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ─── Mocks ──────────────────────────────────────────────────────────────────

const mockFetchPRInfoAsync = vi.hoisted(() => vi.fn());
const mockComputeAdaptiveTTL = vi.hoisted(() => vi.fn());

vi.mock("./github-pr.js", () => ({
  fetchPRInfoAsync: mockFetchPRInfoAsync,
  computeAdaptiveTTL: mockComputeAdaptiveTTL,
}));

import { PRPoller } from "./pr-poller.js";
import type { GitHubPRInfo } from "./github-pr.js";

function makeMockBridge() {
  return {
    broadcastToSession: vi.fn(),
  } as any;
}

function makePR(overrides?: Partial<GitHubPRInfo>): GitHubPRInfo {
  return {
    number: 42,
    title: "test pr",
    url: "https://github.com/org/repo/pull/42",
    state: "OPEN",
    isDraft: false,
    reviewDecision: null,
    additions: 10,
    deletions: 5,
    changedFiles: 2,
    checks: [],
    checksSummary: { total: 0, success: 0, failure: 0, pending: 0 },
    reviewThreads: { total: 0, resolved: 0, unresolved: 0 },
    ...overrides,
  };
}

/** Flush microtasks so async callbacks in the poller can settle. */
async function flushMicrotasks() {
  await new Promise((r) => setTimeout(r, 0));
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("PRPoller", () => {
  let poller: PRPoller;
  let bridge: ReturnType<typeof makeMockBridge>;

  beforeEach(() => {
    mockFetchPRInfoAsync.mockReset();
    mockComputeAdaptiveTTL.mockReset();
    mockComputeAdaptiveTTL.mockReturnValue(30_000);
    bridge = makeMockBridge();
    poller = new PRPoller(bridge);
  });

  afterEach(() => {
    poller.destroy();
  });

  it("returns null on initial watch (no cached data)", () => {
    mockFetchPRInfoAsync.mockResolvedValue(null);
    const result = poller.watch("s1", "/repo", "main");
    expect(result).toBeNull();
  });

  it("fetches and broadcasts PR data after watch", async () => {
    const pr = makePR();
    mockFetchPRInfoAsync.mockResolvedValue(pr);

    poller.watch("s1", "/repo", "feat/test");

    // Let the async fetch settle
    await flushMicrotasks();

    expect(mockFetchPRInfoAsync).toHaveBeenCalledWith("/repo", "feat/test");
    expect(bridge.broadcastToSession).toHaveBeenCalledWith("s1", {
      type: "pr_status_update",
      pr,
      available: true,
    });
  });

  it("shares one timer across multiple sessions watching the same branch", async () => {
    const pr = makePR();
    mockFetchPRInfoAsync.mockResolvedValue(pr);

    poller.watch("s1", "/repo", "main");
    poller.watch("s2", "/repo", "main");

    await flushMicrotasks();

    // Should only have fetched once (shared timer)
    expect(mockFetchPRInfoAsync).toHaveBeenCalledTimes(1);
    // But should broadcast to both sessions
    expect(bridge.broadcastToSession).toHaveBeenCalledWith("s1", expect.objectContaining({ type: "pr_status_update" }));
    expect(bridge.broadcastToSession).toHaveBeenCalledWith("s2", expect.objectContaining({ type: "pr_status_update" }));
  });

  it("returns cached data on subsequent watch calls", async () => {
    const pr = makePR();
    mockFetchPRInfoAsync.mockResolvedValue(pr);

    poller.watch("s1", "/repo", "main");
    await flushMicrotasks();

    // Second session watches the same branch — should get cached data
    const cached = poller.watch("s2", "/repo", "main");
    expect(cached).toEqual(pr);
  });

  it("cleans up when last session unwatches", async () => {
    mockFetchPRInfoAsync.mockResolvedValue(makePR());

    poller.watch("s1", "/repo", "main");
    poller.watch("s2", "/repo", "main");
    await flushMicrotasks();

    poller.unwatch("s1");
    // Still one session watching — cache should remain
    expect(poller.getCached("/repo", "main")).not.toBeNull();

    poller.unwatch("s2");
    // No sessions left — should be cleaned up
    expect(poller.getCached("/repo", "main")).toBeNull();
  });

  it("getCached returns null for unknown branches", () => {
    expect(poller.getCached("/repo", "nonexistent")).toBeNull();
  });

  it("uses computeAdaptiveTTL for scheduling", async () => {
    const pr = makePR({ checksSummary: { total: 3, success: 1, failure: 0, pending: 2 } });
    mockFetchPRInfoAsync.mockResolvedValue(pr);
    mockComputeAdaptiveTTL.mockReturnValue(10_000);

    poller.watch("s1", "/repo", "feat/ci");
    await flushMicrotasks();

    expect(mockComputeAdaptiveTTL).toHaveBeenCalledWith(pr);
  });

  it("handles session switching branches (unwatches old, watches new)", async () => {
    mockFetchPRInfoAsync.mockResolvedValue(makePR());

    poller.watch("s1", "/repo", "branch-a");
    await flushMicrotasks();

    // Same session now watches a different branch
    poller.watch("s1", "/repo", "branch-b");
    await flushMicrotasks();

    // Old branch should have been cleaned up (only session was s1)
    expect(poller.getCached("/repo", "branch-a")).toBeNull();
    expect(poller.getCached("/repo", "branch-b")).not.toBeNull();
  });

  it("handles fetch errors gracefully", async () => {
    mockFetchPRInfoAsync.mockRejectedValue(new Error("network error"));

    poller.watch("s1", "/repo", "main");
    await flushMicrotasks();

    // Should not throw, should not broadcast (no data on error)
    expect(bridge.broadcastToSession).not.toHaveBeenCalled();
  });

  it("prevents concurrent fetches for the same key", async () => {
    // Create a fetch that takes time to resolve
    let resolveFirst: (value: GitHubPRInfo) => void;
    mockFetchPRInfoAsync.mockReturnValueOnce(
      new Promise<GitHubPRInfo>((r) => { resolveFirst = r; }),
    );

    poller.watch("s1", "/repo", "main");
    // Try to trigger another fetch immediately (e.g., from a second session)
    poller.watch("s2", "/repo", "main");

    // Only one fetch should have started
    expect(mockFetchPRInfoAsync).toHaveBeenCalledTimes(1);

    // Resolve the first fetch
    resolveFirst!(makePR());
    await flushMicrotasks();

    // Now broadcast should have gone to both sessions
    expect(bridge.broadcastToSession).toHaveBeenCalledTimes(2);
  });
});
