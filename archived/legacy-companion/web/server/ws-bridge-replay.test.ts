import { describe, it, expect } from "vitest";
import { isHistoryBackedEvent } from "./ws-bridge-replay.js";
import type { ReplayableBrowserIncomingMessage } from "./session-types.js";

describe("isHistoryBackedEvent", () => {
  it("treats persisted system_event subtypes as history-backed", () => {
    // compact_boundary is persisted in messageHistory, so replay fallback can
    // safely skip it and rely on message_history payload.
    const msg: ReplayableBrowserIncomingMessage = {
      type: "system_event",
      event: {
        subtype: "compact_boundary",
        compact_metadata: { trigger: "auto", pre_tokens: 1234 },
        uuid: "u1",
        session_id: "s1",
      },
      timestamp: 1000,
    };

    expect(isHistoryBackedEvent(msg)).toBe(true);
  });

  it("treats hook_progress as transient (not history-backed)", () => {
    // hook_progress is intentionally not persisted to avoid history bloat,
    // so replay fallback must keep sending missed events from the buffer.
    const msg: ReplayableBrowserIncomingMessage = {
      type: "system_event",
      event: {
        subtype: "hook_progress",
        hook_id: "hk-1",
        hook_name: "lint",
        hook_event: "post_tool_use",
        stdout: "running",
        stderr: "",
        output: "running",
        uuid: "u2",
        session_id: "s1",
      },
      timestamp: 1001,
    };

    expect(isHistoryBackedEvent(msg)).toBe(false);
  });
});
