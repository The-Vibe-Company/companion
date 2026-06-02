import { fetchPRInfoAsync, computeAdaptiveTTL, type GitHubPRInfo } from "./github-pr.js";
import type { WsBridge } from "./ws-bridge.js";

// ─── Types ───────────────────────────────────────────────────────────────────

interface WatchedPR {
  cwd: string;
  branch: string;
  /** Sessions interested in this PR (same cwd:branch may be shared) */
  sessionIds: Set<string>;
  lastData: GitHubPRInfo | null;
  timer: ReturnType<typeof setTimeout> | null;
  lastFetchTime: number;
  currentInterval: number;
  fetching: boolean;
}

// ─── PR Poller ───────────────────────────────────────────────────────────────

/**
 * Server-side poller that fetches GitHub PR status at adaptive intervals
 * and pushes updates to browsers via WebSocket.
 *
 * One timer per unique cwd:branch — shared across sessions on the same branch.
 */
export class PRPoller {
  private watched = new Map<string, WatchedPR>();
  private wsBridge: WsBridge;
  /** Reverse index: sessionId → cwd:branch key (a session can only watch one PR at a time) */
  private sessionToKey = new Map<string, string>();

  constructor(wsBridge: WsBridge) {
    this.wsBridge = wsBridge;
  }

  /**
   * Start watching a PR for a session.
   * Returns cached data immediately if available.
   * Triggers an async fetch if cache is stale or missing.
   */
  watch(sessionId: string, cwd: string, branch: string): GitHubPRInfo | null {
    const key = `${cwd}:${branch}`;

    // If this session was watching a different PR, unregister from the old one
    const prevKey = this.sessionToKey.get(sessionId);
    if (prevKey && prevKey !== key) {
      this.unwatchKey(sessionId, prevKey);
    }
    this.sessionToKey.set(sessionId, key);

    const existing = this.watched.get(key);
    if (existing) {
      existing.sessionIds.add(sessionId);
      // If cache is stale, trigger a refresh
      if (Date.now() - existing.lastFetchTime > existing.currentInterval) {
        this.fetchAndBroadcast(key);
      }
      return existing.lastData;
    }

    // New watch — create entry and fetch immediately
    const entry: WatchedPR = {
      cwd,
      branch,
      sessionIds: new Set([sessionId]),
      lastData: null,
      timer: null,
      lastFetchTime: 0,
      currentInterval: 10_000, // start aggressive for fast initial load
      fetching: false,
    };
    this.watched.set(key, entry);
    this.fetchAndBroadcast(key);

    return null;
  }

  /** Stop watching for a specific session. */
  unwatch(sessionId: string): void {
    const key = this.sessionToKey.get(sessionId);
    if (!key) return;
    this.sessionToKey.delete(sessionId);
    this.unwatchKey(sessionId, key);
  }

  /** Get current cached data for a cwd:branch pair (for REST fallback). */
  getCached(cwd: string, branch: string): { available: boolean; pr: GitHubPRInfo | null } | null {
    const key = `${cwd}:${branch}`;
    const entry = this.watched.get(key);
    if (!entry) return null;
    return { available: true, pr: entry.lastData };
  }

  /** Stop all timers (for testing / cleanup). */
  destroy(): void {
    for (const entry of this.watched.values()) {
      if (entry.timer) clearTimeout(entry.timer);
    }
    this.watched.clear();
    this.sessionToKey.clear();
  }

  // ─── Internal ──────────────────────────────────────────────────────────

  private unwatchKey(sessionId: string, key: string): void {
    const entry = this.watched.get(key);
    if (!entry) return;
    entry.sessionIds.delete(sessionId);
    if (entry.sessionIds.size === 0) {
      if (entry.timer) clearTimeout(entry.timer);
      this.watched.delete(key);
    }
  }

  private async fetchAndBroadcast(key: string): Promise<void> {
    const entry = this.watched.get(key);
    if (!entry) return;

    // Prevent concurrent fetches for the same key
    if (entry.fetching) return;
    entry.fetching = true;

    // Clear existing timer (will be rescheduled after fetch)
    if (entry.timer) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }

    try {
      const prInfo = await fetchPRInfoAsync(entry.cwd, entry.branch);
      // Re-check entry still exists (may have been unwatched during async fetch)
      const current = this.watched.get(key);
      if (!current) return;

      current.lastData = prInfo;
      current.lastFetchTime = Date.now();
      current.currentInterval = computeAdaptiveTTL(prInfo);

      // Push to all sessions watching this PR
      for (const sessionId of current.sessionIds) {
        this.wsBridge.broadcastToSession(sessionId, {
          type: "pr_status_update",
          pr: prInfo,
          available: true,
        });
      }
    } catch {
      // On error, use a moderate interval
      const current = this.watched.get(key);
      if (current) {
        current.currentInterval = 30_000;
      }
    } finally {
      const current = this.watched.get(key);
      if (current) {
        current.fetching = false;
        // Schedule next fetch
        current.timer = setTimeout(() => this.fetchAndBroadcast(key), current.currentInterval);
      }
    }
  }
}
