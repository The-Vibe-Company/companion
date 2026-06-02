import { describe, it, expect } from "vitest";
import {
  formatTokenCount,
  formatElapsed,
  formatResetTime,
  formatCodexResetTime,
  formatWindowDuration,
} from "./format.js";

describe("formatTokenCount", () => {
  it("returns plain number for values under 1000", () => {
    expect(formatTokenCount(0)).toBe("0");
    expect(formatTokenCount(500)).toBe("500");
    expect(formatTokenCount(999)).toBe("999");
  });

  it("formats with 'k' suffix for values >= 1000", () => {
    expect(formatTokenCount(1000)).toBe("1.0k");
    expect(formatTokenCount(1500)).toBe("1.5k");
    expect(formatTokenCount(50_000)).toBe("50.0k");
    expect(formatTokenCount(999_999)).toBe("1000.0k");
  });

  it("formats with 'M' suffix for values >= 1,000,000", () => {
    expect(formatTokenCount(1_000_000)).toBe("1.0M");
    expect(formatTokenCount(2_500_000)).toBe("2.5M");
    expect(formatTokenCount(10_000_000)).toBe("10.0M");
  });
});

describe("formatElapsed", () => {
  it("formats sub-minute durations as seconds", () => {
    expect(formatElapsed(0)).toBe("0s");
    expect(formatElapsed(5000)).toBe("5s");
    expect(formatElapsed(59_999)).toBe("59s");
  });

  it("formats durations >= 60s as minutes and seconds", () => {
    expect(formatElapsed(60_000)).toBe("1m 0s");
    expect(formatElapsed(150_000)).toBe("2m 30s");
    expect(formatElapsed(3_600_000)).toBe("60m 0s");
  });
});

describe("formatResetTime", () => {
  it("returns 'now' for past timestamps", () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    expect(formatResetTime(past)).toBe("now");
  });

  it("returns minutes only when under 1 hour", () => {
    const future = new Date(Date.now() + 30 * 60_000).toISOString();
    expect(formatResetTime(future)).toMatch(/^\d+m$/);
  });

  it("returns hours and minutes when under 1 day", () => {
    const future = new Date(Date.now() + 2 * 3_600_000 + 15 * 60_000).toISOString();
    expect(formatResetTime(future)).toMatch(/^\d+h\d+m$/);
  });

  it("returns days, hours, and minutes for multi-day durations", () => {
    const future = new Date(Date.now() + 2 * 86_400_000 + 3 * 3_600_000).toISOString();
    expect(formatResetTime(future)).toMatch(/^\d+d \d+h\d+m$/);
  });

  it("returns 'N/A' for invalid input", () => {
    expect(formatResetTime("not-a-date")).toBe("N/A");
  });
});

describe("formatCodexResetTime", () => {
  it("returns 'now' for past timestamps", () => {
    expect(formatCodexResetTime(Date.now() - 1000)).toBe("now");
  });

  it("returns minutes only when under 1 hour", () => {
    expect(formatCodexResetTime(Date.now() + 30 * 60_000)).toMatch(/^\d+m$/);
  });

  it("returns hours and minutes when under 1 day", () => {
    const result = formatCodexResetTime(Date.now() + 3 * 3_600_000 + 10 * 60_000);
    expect(result).toMatch(/^\d+h\d+m$/);
  });

  it("returns days and hours for multi-day durations", () => {
    const result = formatCodexResetTime(Date.now() + 2 * 86_400_000 + 5 * 3_600_000);
    expect(result).toMatch(/^\d+d \d+h$/);
  });

  it("accepts epoch-seconds input for future timestamps", () => {
    // Compatibility coverage: codex rate-limit payloads may still be second-based.
    const futureSeconds = Math.floor((Date.now() + 45 * 60_000) / 1000);
    expect(formatCodexResetTime(futureSeconds)).toMatch(/^\d+m$/);
  });

});

describe("formatWindowDuration", () => {
  it("returns minutes for short durations", () => {
    expect(formatWindowDuration(30)).toBe("30m");
    expect(formatWindowDuration(59)).toBe("59m");
  });

  it("returns hours for durations >= 60 minutes", () => {
    expect(formatWindowDuration(60)).toBe("1h");
    expect(formatWindowDuration(120)).toBe("2h");
    expect(formatWindowDuration(90)).toBe("2h"); // rounds
  });

  it("returns days for durations >= 1440 minutes", () => {
    expect(formatWindowDuration(1440)).toBe("1d");
    expect(formatWindowDuration(2880)).toBe("2d");
  });
});
