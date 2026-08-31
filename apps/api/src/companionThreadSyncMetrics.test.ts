import { describe, expect, it, vi } from "vitest";
import type { CompanionThreadWindow } from "@companion/contracts";
import { recordCompanionThreadSyncMetrics } from "./companionThreadSyncMetrics";

describe("Companion thread sync metrics", () => {
  it("emits only numeric bounded shape without tenant or transcript labels", () => {
    const sink = { count: vi.fn(), distribution: vi.fn() };
    const payload = {
      thread: {
        companion_id: "11111111-1111-4111-8111-111111111111",
        viewer_id: "private-viewer",
        access: "owner",
        read_only: false,
        can_send: true,
        active_turn: null,
        queued_count: 0,
        interrupted_turn: null,
        last_message_at: null,
        last_read_ordinal: null,
      },
      entries: [],
      older_cursor: null,
      sync_cursor: "opaque-private-cursor",
      notify_returns: [],
    } satisfies CompanionThreadWindow;

    recordCompanionThreadSyncMetrics({ kind: "window", durationMs: 12.25, payload, sink });

    expect(sink.count).toHaveBeenCalledWith(
      "companion.thread_sync.responses",
      1,
      { attributes: { kind: "window", has_more: false } },
    );
    expect(sink.distribution).toHaveBeenCalledWith(
      "companion.thread_sync.duration",
      12.25,
      expect.objectContaining({ unit: "millisecond" }),
    );
    const serializedCalls = JSON.stringify([
      ...sink.count.mock.calls,
      ...sink.distribution.mock.calls,
    ]);
    expect(serializedCalls).not.toContain("private-viewer");
    expect(serializedCalls).not.toContain("opaque-private-cursor");
    expect(serializedCalls).not.toContain("11111111-1111-4111-8111-111111111111");
  });
});
