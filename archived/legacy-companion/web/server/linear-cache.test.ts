import { describe, it, expect, beforeEach, vi } from "vitest";
import { LinearCache } from "./linear-cache.js";

describe("LinearCache", () => {
  let cache: LinearCache;

  beforeEach(() => {
    cache = new LinearCache();
  });

  it("returns fetched data and caches it", async () => {
    const fetcher = vi.fn().mockResolvedValue({ issues: ["a"] });
    const result = await cache.getOrFetch("key1", 5000, fetcher);
    expect(result).toEqual({ issues: ["a"] });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("serves from cache within TTL without calling fetcher again", async () => {
    const fetcher = vi.fn().mockResolvedValue("data");
    await cache.getOrFetch("k", 5000, fetcher);
    const result = await cache.getOrFetch("k", 5000, fetcher);
    expect(result).toBe("data");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("re-fetches after TTL expires", async () => {
    // Use fake timers to test TTL expiration
    vi.useFakeTimers();
    const fetcher = vi.fn()
      .mockResolvedValueOnce("old")
      .mockResolvedValueOnce("new");

    await cache.getOrFetch("k", 100, fetcher);

    // Advance past TTL
    vi.advanceTimersByTime(150);

    const result = await cache.getOrFetch("k", 100, fetcher);
    expect(result).toBe("new");
    expect(fetcher).toHaveBeenCalledTimes(2);

    vi.useRealTimers();
  });

  it("deduplicates concurrent requests — fetcher called only once", async () => {
    // Fetcher that resolves after a small delay to simulate network latency
    let resolvePromise: (v: string) => void;
    const fetcher = vi.fn().mockImplementation(
      () => new Promise<string>((resolve) => { resolvePromise = resolve; }),
    );

    const p1 = cache.getOrFetch("k", 5000, fetcher);
    const p2 = cache.getOrFetch("k", 5000, fetcher);

    // Both should be the same promise, fetcher called only once
    expect(fetcher).toHaveBeenCalledTimes(1);

    resolvePromise!("shared");
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toBe("shared");
    expect(r2).toBe("shared");
  });

  it("invalidates a specific key", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce("v1")
      .mockResolvedValueOnce("v2");

    await cache.getOrFetch("k", 60000, fetcher);
    cache.invalidate("k");

    const result = await cache.getOrFetch("k", 60000, fetcher);
    expect(result).toBe("v2");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("invalidates by prefix", async () => {
    const fetcher1 = vi.fn().mockResolvedValue("a");
    const fetcher2 = vi.fn().mockResolvedValue("b");
    const fetcher3 = vi.fn().mockResolvedValue("c");

    await cache.getOrFetch("issue:123", 60000, fetcher1);
    await cache.getOrFetch("issue:456", 60000, fetcher2);
    await cache.getOrFetch("search:hello", 60000, fetcher3);

    cache.invalidate("issue:");
    expect(cache.size).toBe(1); // only "search:hello" remains
  });

  it("clear() empties the entire cache", async () => {
    await cache.getOrFetch("a", 60000, () => Promise.resolve(1));
    await cache.getOrFetch("b", 60000, () => Promise.resolve(2));
    expect(cache.size).toBe(2);

    cache.clear();
    expect(cache.size).toBe(0);
  });

  it("failed fetch does not poison the cache — allows retry", async () => {
    const fetcher = vi.fn()
      .mockRejectedValueOnce(new Error("network fail"))
      .mockResolvedValueOnce("recovered");

    await expect(cache.getOrFetch("k", 5000, fetcher)).rejects.toThrow("network fail");

    // Retry should call fetcher again, not serve the error
    const result = await cache.getOrFetch("k", 5000, fetcher);
    expect(result).toBe("recovered");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("failed fetch with existing stale data keeps the stale entry for future retry", async () => {
    vi.useFakeTimers();

    const fetcher = vi.fn()
      .mockResolvedValueOnce("stale-data")
      .mockRejectedValueOnce(new Error("refresh failed"))
      .mockResolvedValueOnce("fresh-data");

    // Populate cache
    await cache.getOrFetch("k", 100, fetcher);

    // Expire the entry
    vi.advanceTimersByTime(150);

    // Attempt refresh — fails
    await expect(cache.getOrFetch("k", 100, fetcher)).rejects.toThrow("refresh failed");

    // Next attempt should retry the fetcher, not serve stale data
    const result = await cache.getOrFetch("k", 100, fetcher);
    expect(result).toBe("fresh-data");
    expect(fetcher).toHaveBeenCalledTimes(3);

    vi.useRealTimers();
  });
});
