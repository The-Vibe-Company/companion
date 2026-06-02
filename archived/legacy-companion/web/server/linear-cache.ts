/**
 * Server-side TTL cache for Linear API responses.
 *
 * Prevents hitting Linear's 5000 requests/hour rate limit by caching
 * read-only GraphQL responses with configurable TTLs. Concurrent identical
 * requests are deduplicated — only one fetch is made and all callers share
 * the same promise.
 */

interface CacheEntry<T = unknown> {
  data: T;
  timestamp: number;
  pending?: Promise<T>;
}

const MAX_ENTRIES = 500;
const EVICT_AGE_MS = 5 * 60 * 1000; // 5 minutes — sweep threshold

export class LinearCache {
  private store = new Map<string, CacheEntry>();

  /**
   * Return cached data if fresh, otherwise execute `fetcher` and cache the result.
   * Concurrent calls with the same key share a single in-flight request.
   */
  async getOrFetch<T>(key: string, ttlMs: number, fetcher: () => Promise<T>): Promise<T> {
    const existing = this.store.get(key) as CacheEntry<T> | undefined;

    // Serve from cache if still fresh
    if (existing && !existing.pending && Date.now() - existing.timestamp < ttlMs) {
      return existing.data;
    }

    // Deduplicate: if a fetch is already in flight for this key, piggyback on it
    if (existing?.pending) {
      return existing.pending;
    }

    const pending = fetcher()
      .then((data) => {
        this.store.set(key, { data, timestamp: Date.now() });
        this.maybeEvict();
        return data;
      })
      .catch((err) => {
        // On failure, remove the pending promise so the next call can retry.
        // If we have stale data, keep it around (callers won't use it because
        // timestamp is old, but a future getOrFetch will retry the fetch).
        const entry = this.store.get(key);
        if (entry?.pending === pending) {
          delete entry.pending;
          // If there was never any cached data, remove the entry entirely
          if (entry.timestamp === 0) {
            this.store.delete(key);
          }
        }
        throw err;
      });

    // Store the in-flight promise
    if (existing) {
      existing.pending = pending;
    } else {
      this.store.set(key, { data: undefined as T, timestamp: 0, pending });
    }

    return pending;
  }

  /** Invalidate a specific key, or all keys that start with `keyOrPrefix`. */
  invalidate(keyOrPrefix: string): void {
    // Exact match first
    if (this.store.has(keyOrPrefix)) {
      this.store.delete(keyOrPrefix);
      return;
    }
    // Prefix match
    for (const k of this.store.keys()) {
      if (k.startsWith(keyOrPrefix)) {
        this.store.delete(k);
      }
    }
  }

  /** Clear the entire cache (e.g. when the Linear API key changes). */
  clear(): void {
    this.store.clear();
  }

  /** Current number of cached entries. */
  get size(): number {
    return this.store.size;
  }

  /** Sweep stale entries when the store grows too large. */
  private maybeEvict(): void {
    if (this.store.size <= MAX_ENTRIES) return;
    const now = Date.now();
    for (const [k, entry] of this.store) {
      if (now - entry.timestamp > EVICT_AGE_MS && !entry.pending) {
        this.store.delete(k);
      }
    }
  }
}

/** Singleton cache instance used across all Linear route handlers. */
export const linearCache = new LinearCache();

/** Reset for test isolation — clears all cached data. */
export function _resetForTest(): void {
  linearCache.clear();
}
