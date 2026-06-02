import { describe, it, expect, vi, afterEach } from "vitest";
import { timeAgo } from "./time-ago.js";

describe("timeAgo", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function mockNow(now: number) {
    vi.useFakeTimers();
    vi.setSystemTime(now);
  }

  const BASE = 1700000000000;

  it("returns 'just now' for timestamps less than 1 minute ago", () => {
    mockNow(BASE);
    expect(timeAgo(BASE)).toBe("just now");
    expect(timeAgo(BASE - 30_000)).toBe("just now"); // 30 seconds ago
    expect(timeAgo(BASE - 59_999)).toBe("just now"); // just under 1 minute
  });

  it("returns minutes for timestamps 1-59 minutes ago", () => {
    mockNow(BASE);
    expect(timeAgo(BASE - 60_000)).toBe("1m ago");
    expect(timeAgo(BASE - 5 * 60_000)).toBe("5m ago");
    expect(timeAgo(BASE - 59 * 60_000)).toBe("59m ago");
  });

  it("returns hours for timestamps 1-23 hours ago", () => {
    mockNow(BASE);
    expect(timeAgo(BASE - 60 * 60_000)).toBe("1h ago");
    expect(timeAgo(BASE - 3 * 60 * 60_000)).toBe("3h ago");
    expect(timeAgo(BASE - 23 * 60 * 60_000)).toBe("23h ago");
  });

  it("returns days for timestamps 24+ hours ago", () => {
    mockNow(BASE);
    expect(timeAgo(BASE - 24 * 60 * 60_000)).toBe("1d ago");
    expect(timeAgo(BASE - 7 * 24 * 60 * 60_000)).toBe("7d ago");
    expect(timeAgo(BASE - 30 * 24 * 60 * 60_000)).toBe("30d ago");
  });

  it("handles future timestamps gracefully (returns 'just now')", () => {
    mockNow(BASE);
    // A future timestamp results in negative diff, Math.floor gives -1, which is < 1
    expect(timeAgo(BASE + 60_000)).toBe("just now");
  });
});
