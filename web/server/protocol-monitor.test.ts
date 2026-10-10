import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the logger before importing the module under test
vi.mock("./logger.js", () => ({
  log: {
    warn: vi.fn(),
  },
}));

import { reportProtocolDrift } from "./protocol-monitor.js";
import { log } from "./logger.js";

describe("reportProtocolDrift", () => {
  let seen: Set<string>;

  beforeEach(() => {
    seen = new Set<string>();
    vi.clearAllMocks();
  });

  // --- Normal cases ---

  it("should_log_warning_when_drift_reported_first_time", () => {
    reportProtocolDrift(seen, {
      backend: "claude",
      sessionId: "sess-1",
      direction: "incoming",
      messageKind: "message",
      messageName: "unknown_msg",
    });

    expect(log.warn).toHaveBeenCalledOnce();
    expect(log.warn).toHaveBeenCalledWith(
      "protocol-monitor",
      "Backend protocol drift detected",
      expect.objectContaining({
        backend: "claude",
        sessionId: "sess-1",
        direction: "incoming",
        messageKind: "message",
        messageName: "unknown_msg",
      }),
    );
  });

  it("should_add_key_to_seen_set_when_drift_reported", () => {
    reportProtocolDrift(seen, {
      backend: "claude",
      sessionId: "sess-1",
      direction: "incoming",
      messageKind: "message",
      messageName: "test_msg",
    });

    expect(seen.has("claude:incoming:message:test_msg")).toBe(true);
  });

  it("should_call_emitError_when_provided", () => {
    const emitError = vi.fn();

    reportProtocolDrift(
      seen,
      {
        backend: "claude",
        sessionId: "sess-1",
        direction: "outgoing",
        messageKind: "notification",
        messageName: "weird_notif",
      },
      emitError,
    );

    expect(emitError).toHaveBeenCalledOnce();
    expect(emitError).toHaveBeenCalledWith(
      expect.stringContaining("Claude protocol drift"),
    );
    expect(emitError).toHaveBeenCalledWith(
      expect.stringContaining('unsupported outgoing notification "weird_notif"'),
    );
  });

  it("should_use_codex_label_when_backend_is_codex", () => {
    const emitError = vi.fn();

    reportProtocolDrift(
      seen,
      {
        backend: "codex",
        sessionId: "sess-1",
        direction: "incoming",
        messageKind: "request",
        messageName: "some_req",
      },
      emitError,
    );

    expect(emitError).toHaveBeenCalledWith(
      expect.stringContaining("Codex protocol drift"),
    );
  });

  // --- Deduplication ---

  it("should_skip_log_when_same_drift_already_seen", () => {
    const options = {
      backend: "claude" as const,
      sessionId: "sess-1",
      direction: "incoming" as const,
      messageKind: "message" as const,
      messageName: "dup_msg",
    };

    reportProtocolDrift(seen, options);
    reportProtocolDrift(seen, options);

    // Only called once despite two reports
    expect(log.warn).toHaveBeenCalledOnce();
  });

  it("should_not_call_emitError_when_drift_already_seen", () => {
    const emitError = vi.fn();
    const options = {
      backend: "claude" as const,
      sessionId: "sess-1",
      direction: "incoming" as const,
      messageKind: "message" as const,
      messageName: "dup_msg",
    };

    reportProtocolDrift(seen, options, emitError);
    reportProtocolDrift(seen, options, emitError);

    expect(emitError).toHaveBeenCalledOnce();
  });

  it("should_dedupe_by_backend_direction_kind_name_when_sessionId_differs", () => {
    // Dedupe key does NOT include sessionId, so same drift from different sessions is still deduped
    const base = {
      backend: "claude" as const,
      direction: "incoming" as const,
      messageKind: "message" as const,
      messageName: "same_msg",
    };

    reportProtocolDrift(seen, { ...base, sessionId: "sess-1" });
    reportProtocolDrift(seen, { ...base, sessionId: "sess-2" });

    expect(log.warn).toHaveBeenCalledOnce();
  });

  it("should_log_separately_when_different_message_names", () => {
    const base = {
      backend: "claude" as const,
      sessionId: "sess-1",
      direction: "incoming" as const,
      messageKind: "message" as const,
    };

    reportProtocolDrift(seen, { ...base, messageName: "msg_a" });
    reportProtocolDrift(seen, { ...base, messageName: "msg_b" });

    expect(log.warn).toHaveBeenCalledTimes(2);
  });

  it("should_log_separately_when_different_directions", () => {
    const base = {
      backend: "claude" as const,
      sessionId: "sess-1",
      messageKind: "message" as const,
      messageName: "same",
    };

    reportProtocolDrift(seen, { ...base, direction: "incoming" as const });
    reportProtocolDrift(seen, { ...base, direction: "outgoing" as const });

    expect(log.warn).toHaveBeenCalledTimes(2);
  });

  // --- Optional fields ---

  it("should_include_keys_in_log_when_provided", () => {
    reportProtocolDrift(seen, {
      backend: "claude",
      sessionId: "sess-1",
      direction: "incoming",
      messageKind: "message",
      messageName: "msg",
      keys: ["foo", "bar"],
    });

    expect(log.warn).toHaveBeenCalledWith(
      "protocol-monitor",
      "Backend protocol drift detected",
      expect.objectContaining({ keys: ["foo", "bar"] }),
    );
  });

  it("should_truncate_rawPreview_when_longer_than_240_chars", () => {
    const longRaw = "x".repeat(300);

    reportProtocolDrift(seen, {
      backend: "claude",
      sessionId: "sess-1",
      direction: "incoming",
      messageKind: "message",
      messageName: "msg",
      rawPreview: longRaw,
    });

    const callArgs = vi.mocked(log.warn).mock.calls[0]![2] as Record<string, unknown>;
    const preview = callArgs.rawPreview as string;

    // Truncated to 240 chars + "..."
    expect(preview.length).toBe(243);
    expect(preview.endsWith("...")).toBe(true);
  });

  it("should_not_truncate_rawPreview_when_within_limit", () => {
    const shortRaw = "x".repeat(100);

    reportProtocolDrift(seen, {
      backend: "claude",
      sessionId: "sess-1",
      direction: "incoming",
      messageKind: "message",
      messageName: "msg2",
      rawPreview: shortRaw,
    });

    const callArgs = vi.mocked(log.warn).mock.calls[0]![2] as Record<string, unknown>;
    expect(callArgs.rawPreview).toBe(shortRaw);
  });

  it("should_set_rawPreview_undefined_when_not_provided", () => {
    reportProtocolDrift(seen, {
      backend: "claude",
      sessionId: "sess-1",
      direction: "incoming",
      messageKind: "parse_error",
      messageName: "bad_msg",
    });

    const callArgs = vi.mocked(log.warn).mock.calls[0]![2] as Record<string, unknown>;
    expect(callArgs.rawPreview).toBeUndefined();
  });

  it("should_include_blockedForSafety_when_true", () => {
    reportProtocolDrift(seen, {
      backend: "codex",
      sessionId: "sess-1",
      direction: "incoming",
      messageKind: "message",
      messageName: "blocked",
      blockedForSafety: true,
    });

    const callArgs = vi.mocked(log.warn).mock.calls[0]![2] as Record<string, unknown>;
    expect(callArgs.blockedForSafety).toBe(true);
  });

  // --- Edge cases ---

  it("should_not_call_emitError_when_not_provided", () => {
    // Just verify no error is thrown when emitError is undefined
    expect(() =>
      reportProtocolDrift(seen, {
        backend: "claude",
        sessionId: "sess-1",
        direction: "incoming",
        messageKind: "message",
        messageName: "no_emit",
      }),
    ).not.toThrow();
  });

  it("should_handle_empty_messageName_when_provided", () => {
    reportProtocolDrift(seen, {
      backend: "claude",
      sessionId: "sess-1",
      direction: "incoming",
      messageKind: "message",
      messageName: "",
    });

    expect(seen.has("claude:incoming:message:")).toBe(true);
    expect(log.warn).toHaveBeenCalledOnce();
  });

  it("should_include_companion_update_hint_when_emitError_called", () => {
    const emitError = vi.fn();

    reportProtocolDrift(
      seen,
      {
        backend: "claude",
        sessionId: "sess-1",
        direction: "incoming",
        messageKind: "message",
        messageName: "new_thing",
      },
      emitError,
    );

    expect(emitError).toHaveBeenCalledWith(
      expect.stringContaining("Companion may need an update"),
    );
  });
});
