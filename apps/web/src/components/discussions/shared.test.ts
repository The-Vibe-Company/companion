import { describe, expect, it } from "vitest";
import { groupMessages, stripPreview, timeLabel } from "./shared";

import type { DiscussionMessage } from "@/api";

const base = { role: "assistant", content: "", runId: "run", complete: true, files: [] } satisfies Partial<DiscussionMessage>;
const message = (id: string, createdAt: string, extra: Partial<DiscussionMessage> = {}): DiscussionMessage =>
  ({ ...base, id, sequence: id, companionId: null, createdAt, ...extra });

describe("timeLabel", () => {
  const now = new Date("2026-09-15T14:00:00Z");
  const midnight = new Date(now); midnight.setHours(0, 0, 0, 0);
  const at = (days: number, hour = 10) => new Date(midnight.getTime() - days * 86_400_000 + hour * 3_600_000).toISOString();

  it("reads as a time today, a weekday this week and a date before that", () => {
    expect(timeLabel(at(0), now)).toMatch(/\d[:.]\d\d/);
    expect(timeLabel(at(2), now)).not.toMatch(/\d[:.]\d\d/);
    expect(timeLabel(at(40), now)).not.toMatch(/\d[:.]\d\d/);
  });

  it("distinguishes a date older than a week from the weekday form", () => {
    expect(timeLabel(at(40), now)).not.toBe(timeLabel(at(2), now));
    expect(timeLabel(at(40), now)).toMatch(/\d/);
  });
});

describe("stripPreview", () => {
  it("flattens Markdown into a single readable line", () => {
    expect(stripPreview("## Heading\n\n- **one**\n- two")).toBe("Heading one two");
    expect(stripPreview("See [the brief](https://example.invalid/brief) first")).toBe("See the brief first");
    expect(stripPreview("Before\n```js\nconst a = 1;\n```\nAfter")).toBe("Before After");
    expect(stripPreview("Run `bun test` now")).toBe("Run bun test now");
  });

  it("returns an empty string when there is nothing to show", () => {
    expect(stripPreview("   \n\n  ")).toBe("");
  });
});

describe("groupMessages", () => {
  it("opens each day with a separator", () => {
    const grouped = groupMessages([
      message("1", "2026-09-14T10:00:00Z"),
      message("2", "2026-09-14T10:01:00Z"),
      message("3", "2026-09-15T09:00:00Z"),
    ]);
    expect(grouped.map(item => Boolean(item.day))).toEqual([true, false, true]);
    expect(grouped.map(item => item.header)).toEqual([true, false, true]);
  });

  it("keeps one header per author inside five minutes and starts a new one after", () => {
    const grouped = groupMessages([
      message("1", "2026-09-15T10:00:00Z", { companionId: "ada" }),
      message("2", "2026-09-15T10:02:00Z", { companionId: "ada" }),
      message("3", "2026-09-15T10:03:00Z", { companionId: "june" }),
      message("4", "2026-09-15T10:20:00Z", { companionId: "june" }),
      message("5", "2026-09-15T10:21:00Z", { role: "user" }),
    ]);
    expect(grouped.map(item => item.header)).toEqual([true, false, true, true, true]);
  });
});
