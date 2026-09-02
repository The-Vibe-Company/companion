import { describe, expect, it, vi } from "vitest";
import { recordCompanionCreationMetrics } from "./companionCreationMetrics";

describe("Companion creation metrics", () => {
  it("emits the creation SLO without tenant identity", () => {
    const sink = { count: vi.fn(), distribution: vi.fn() };
    recordCompanionCreationMetrics({ durationMs: 18.5, outcome: "accepted", sink });
    expect(sink.count).toHaveBeenCalledWith(
      "companion.creation.requests", 1, { attributes: { outcome: "accepted" } },
    );
    expect(sink.distribution).toHaveBeenCalledWith(
      "companion.creation.duration", 18.5,
      { unit: "millisecond", attributes: { outcome: "accepted" } },
    );
  });
});
