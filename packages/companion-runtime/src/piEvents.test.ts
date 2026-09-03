import { describe, expect, it } from "vitest";
import {
  PiJournalCorrelationError,
  PiProjectionSecurityError,
  PiJournalValidationError,
  classifyPiJournalPage,
  validateBrokerCounters,
  validatePiJournalRead,
} from "./piEvents";
import { createRuntimeVisibleTextRedactor } from "./projectionRedaction";
import { ATTEMPT_ID, PI_INVOCATION_ID } from "./test/fixtures";

// The snapshot serializer renders bigints as decimal text without a runtime typeof gate. The
// named JSON-value contract keeps the BigInt branch dispatching through the prototype without a
// cast or an `unknown` boundary.
type SnapshotValue = string | number | boolean | null | bigint | SnapshotValue[] | { [key: string]: SnapshotValue };
function bigintAwareReplacer(_key: string, value: SnapshotValue): SnapshotValue {
  return Object.prototype.toString.call(value) === "[object BigInt]"
    ? BigInt.prototype.toString.call(value)
    : value;
}

function classifyEvents(events: Array<{ [key: string]: SnapshotValue }>, after = 0n) {
  const rows = events.map((event, index) => ({
    sequence: Number(after) + index + 1,
    invocationId: PI_INVOCATION_ID,
    attemptId: ATTEMPT_ID,
    kind: "pi_event",
    event,
  }));
  return classifyPiJournalPage(validatePiJournalRead({
    value: {
      events: rows,
      nextCursor: Number(after) + rows.length,
      acknowledgedCursor: Number(after),
      hasMore: false,
    },
    after,
    attemptId: ATTEMPT_ID,
    invocationId: PI_INVOCATION_ID,
  }));
}

describe("Pi journal validation and projection", () => {
  it("projects accepted compaction metadata and routine terminal calls without generic tool cards", () => {
    const page = validatePiJournalRead({
      value: {
        events: [
          {
            sequence: 1,
            invocationId: PI_INVOCATION_ID,
            attemptId: ATTEMPT_ID,
            kind: "pi_event",
            event: {
              type: "compaction_end",
              aborted: false,
              willRetry: false,
              result: {
                summary: "Pinned compacted context",
                firstKeptEntryId: "entry-7",
                tokensBefore: 5_000,
                estimatedTokensAfter: 900,
                usage: { cacheRead: 400, cacheWrite: 20 },
              },
            },
          },
          {
            sequence: 2,
            invocationId: PI_INVOCATION_ID,
            attemptId: ATTEMPT_ID,
            kind: "pi_event",
            event: {
              type: "tool_execution_start",
              toolName: "surface_to_main",
              toolCallId: "return-1",
              args: { mode: "relay", message: "Please answer this result." },
            },
          },
        ],
        nextCursor: 2,
        acknowledgedCursor: 0,
        hasMore: false,
      },
      after: 0n,
      attemptId: ATTEMPT_ID,
      invocationId: PI_INVOCATION_ID,
    });

    expect(classifyPiJournalPage(page).projections).toEqual([
      {
        sequence: 1n,
        type: "compaction",
        summary: "Pinned compacted context",
        first_kept_entry_id: "entry-7",
        tokens_before: 5_000,
        estimated_tokens_after: 900,
        cache_read: 400,
        cache_write: 20,
      },
      {
        sequence: 2n,
        type: "routine_return",
        call_id: "return-1",
        mode: "relay",
        message: "Please answer this result.",
      },
    ]);
  });

  it("omits a compaction whose entire summary is removed by redaction", () => {
    const page = validatePiJournalRead({
      value: {
        events: [{
          sequence: 1,
          invocationId: PI_INVOCATION_ID,
          attemptId: ATTEMPT_ID,
          kind: "pi_event",
          event: {
            type: "compaction_end",
            aborted: false,
            willRetry: false,
            result: {
              summary: "remove-everything",
              firstKeptEntryId: "entry-7",
              tokensBefore: 5_000,
              estimatedTokensAfter: 900,
            },
          },
        }],
        nextCursor: 1,
        acknowledgedCursor: 0,
        hasMore: false,
      },
      after: 0n,
      attemptId: ATTEMPT_ID,
      invocationId: PI_INVOCATION_ID,
    });

    expect(classifyPiJournalPage(page, new Date(), () => "").projections).toEqual([]);
  });

  it("counts unknown events, projects process exit, and never treats it as settlement", () => {
    const page = validatePiJournalRead({
      value: {
        events: [
          {
            sequence: 1,
            invocationId: PI_INVOCATION_ID,
            attemptId: ATTEMPT_ID,
            kind: "pi_event",
            event: { type: "future_event", secret: "must not be projected" },
          },
          {
            sequence: 2,
            invocationId: PI_INVOCATION_ID,
            attemptId: ATTEMPT_ID,
            kind: "pi_process_exit",
            exit: { code: 137, signal: "SIGKILL" },
          },
        ],
        nextCursor: 2,
        acknowledgedCursor: 0,
        hasMore: false,
      },
      after: 0n,
      attemptId: ATTEMPT_ID,
      invocationId: PI_INVOCATION_ID,
    });

    const classified = classifyPiJournalPage(page);

    expect(classified.unknownEvents).toBe(1);
    expect(classified.settled).toBe(false);
    expect(classified.processExit).toEqual({ code: 137, signal: "SIGKILL" });
    expect(classified.projections).toEqual([
      { sequence: 2n, type: "process_exit", code: 137, signal: "SIGKILL" },
    ]);
    expect(JSON.stringify(classified.projections, bigintAwareReplacer)).not.toContain("must not be projected");
  });

  it("requires exact attempt and invocation correlation", () => {
    expect(() => validatePiJournalRead({
      value: {
        events: [{
          sequence: 1,
          invocationId: PI_INVOCATION_ID,
          attemptId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          kind: "pi_event",
          event: { type: "agent_settled" },
        }],
        nextCursor: 1,
        acknowledgedCursor: 0,
        hasMore: false,
      },
      after: 0n,
      attemptId: ATTEMPT_ID,
      invocationId: PI_INVOCATION_ID,
    })).toThrow(PiJournalCorrelationError);
  });

  it("ignores an unsupported settlement shape", () => {
    const page = validatePiJournalRead({
      value: {
        events: [{
          sequence: 1,
          invocationId: PI_INVOCATION_ID,
          attemptId: ATTEMPT_ID,
          kind: "pi_event",
          event: { type: "agent_settled", extra: true },
        }],
        nextCursor: 1,
        acknowledgedCursor: 0,
        hasMore: false,
      },
      after: 0n,
      attemptId: ATTEMPT_ID,
      invocationId: PI_INVOCATION_ID,
    });

    const classified = classifyPiJournalPage(page);
    expect(classified.settled).toBe(false);
    expect(classified.unknownEvents).toBe(1);
    expect(classified.projections).toEqual([]);
  });

  it("validates all broker rejection counters without retaining rejected lines", () => {
    expect(validateBrokerCounters({
      malformedLines: 2,
      oversizedLines: 3,
      unterminatedLines: 4,
      unknownEvents: 5,
      unboundEvents: 6,
      orphanResponses: 7,
      rawLine: "not part of the returned value",
    })).toEqual({
      malformedLines: 2,
      oversizedLines: 3,
      unterminatedLines: 4,
      unknownEvents: 5,
      unboundEvents: 6,
      orphanResponses: 7,
    });
  });

  it.each([
    {
      name: "more than 256 records",
      value: {
        events: Array.from({ length: 257 }, (_value, index) => ({
          sequence: index + 1,
          invocationId: PI_INVOCATION_ID,
          attemptId: ATTEMPT_ID,
          kind: "pi_event",
          event: { type: "turn_start" },
        })),
        nextCursor: 257,
        acknowledgedCursor: 0,
        hasMore: true,
      },
      after: 0n,
    },
    {
      name: "an ACK ahead of the durable cursor",
      value: {
        events: [],
        nextCursor: 4,
        acknowledgedCursor: 4,
        hasMore: false,
      },
      after: 3n,
    },
    {
      name: "an empty page that skips the requested cursor",
      value: {
        events: [],
        nextCursor: 2,
        acknowledgedCursor: 0,
        hasMore: false,
      },
      after: 1n,
    },
    {
      name: "a partial page whose next cursor is not its final record",
      value: {
        events: [{
          sequence: 2,
          invocationId: PI_INVOCATION_ID,
          attemptId: ATTEMPT_ID,
          kind: "pi_event",
          event: { type: "turn_start" },
        }],
        nextCursor: 3,
        acknowledgedCursor: 1,
        hasMore: true,
      },
      after: 1n,
    },
  ])("rejects $name", ({ value, after }) => {
    expect(() => validatePiJournalRead({
      value,
      after,
      attemptId: ATTEMPT_ID,
      invocationId: PI_INVOCATION_ID,
    })).toThrow(PiJournalValidationError);
  });

  it("keeps opaque tool and decision ids out of DB entry keys", () => {
    const page = validatePiJournalRead({
      value: {
        events: [
          {
            sequence: 1,
            invocationId: PI_INVOCATION_ID,
            attemptId: ATTEMPT_ID,
            kind: "pi_event",
            event: {
              type: "tool_execution_start",
              toolCallId: "provider call/id with spaces?",
              toolName: "shell",
              args: { command: "true" },
            },
          },
          {
            sequence: 2,
            invocationId: PI_INVOCATION_ID,
            attemptId: ATTEMPT_ID,
            kind: "pi_event",
            event: {
              type: "extension_ui_request",
              id: "provider request/id with spaces?",
              method: "confirm",
              title: "companion:shell:approve",
              message: "Approve?",
            },
          },
        ],
        nextCursor: 2,
        acknowledgedCursor: 0,
        hasMore: false,
      },
      after: 0n,
      attemptId: ATTEMPT_ID,
      invocationId: PI_INVOCATION_ID,
    });

    const classified = classifyPiJournalPage(page);

    expect(classified.projections).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "tool", entry_key: "tool:1" }),
      expect.objectContaining({
        type: "decision",
        entry_key: "decision:2",
        request_key: "provider request/id with spaces?",
      }),
    ]));
  });

  it("projects only the final assistant answer, never text beside an intermediate tool call", () => {
    const page = validatePiJournalRead({
      value: {
        events: [
          {
            sequence: 1,
            invocationId: PI_INVOCATION_ID,
            attemptId: ATTEMPT_ID,
            kind: "pi_event",
            event: {
              type: "message_end",
              message: {
                role: "assistant",
                content: [
                  { type: "text", text: "I’ll inspect that now." },
                  { type: "toolCall", id: "call-1", name: "read", arguments: { path: "README.md" } },
                ],
              },
            },
          },
          {
            sequence: 2,
            invocationId: PI_INVOCATION_ID,
            attemptId: ATTEMPT_ID,
            kind: "pi_event",
            event: {
              type: "tool_execution_start",
              toolCallId: "call-1",
              toolName: "read",
              args: { path: "README.md" },
            },
          },
          {
            sequence: 3,
            invocationId: PI_INVOCATION_ID,
            attemptId: ATTEMPT_ID,
            kind: "pi_event",
            event: {
              type: "message_end",
              message: {
                role: "assistant",
                content: [{ type: "text", text: "Done" }],
              },
            },
          },
        ],
        nextCursor: 3,
        acknowledgedCursor: 0,
        hasMore: false,
      },
      after: 0n,
      attemptId: ATTEMPT_ID,
      invocationId: PI_INVOCATION_ID,
    });

    const projections = classifyPiJournalPage(page).projections;

    expect(projections.filter((projection) => projection.type === "assistant")).toEqual([
      expect.objectContaining({ type: "assistant", content: "Done" }),
    ]);
    expect(projections).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "tool" }),
    ]));
    expect(JSON.stringify(projections, bigintAwareReplacer)).not.toContain("inspect that now");
  });

  it("keeps message_end primary while retaining documented terminal fallback candidates", () => {
    const classified = classifyEvents([
      {
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: "Primary answer" }] },
      },
      {
        type: "turn_end",
        message: { role: "assistant", content: [{ type: "text", text: "Turn copy" }] },
      },
      {
        type: "agent_end",
        messages: [{ role: "assistant", content: [{ type: "text", text: "Agent copy" }] }],
      },
      { type: "agent_settled" },
    ]);

    expect(classified.projections.filter((item) => item.type === "assistant")).toEqual([
      expect.objectContaining({ content: "Primary answer" }),
    ]);
    expect(classified.assistantFallbacks).toEqual([
      { sequence: 2n, source: "turn_end", content: "Turn copy" },
      { sequence: 3n, source: "agent_end", content: "Agent copy" },
    ]);
    expect(classified.settled).toBe(true);
  });

  it("retains turn_end.message as the preferred usable terminal fallback", () => {
    const classified = classifyEvents([
      {
        type: "turn_end",
        message: { role: "assistant", content: [{ type: "text", text: "Recovered answer" }] },
      },
      { type: "agent_settled" },
    ]);

    expect(classified.assistantFallbacks).toEqual([
      { sequence: 1n, source: "turn_end", content: "Recovered answer" },
    ]);
  });

  it("retains only the final usable assistant from agent_end.messages", () => {
    const classified = classifyEvents([
      {
        type: "agent_end",
        messages: [
          { role: "assistant", content: [{ type: "text", text: "Earlier answer" }] },
          { role: "tool", content: [{ type: "text", text: "Tool narration" }] },
          { role: "assistant", content: [{ type: "text", text: "Final answer" }] },
        ],
      },
      { type: "agent_settled" },
    ]);

    expect(classified.assistantFallbacks).toEqual([
      { sequence: 1n, source: "agent_end", content: "Final answer" },
    ]);
    expect(JSON.stringify(classified.assistantFallbacks, bigintAwareReplacer))
      .not.toContain("Tool narration");
  });

  it("never retains user, tool-only, or assistant tool-call narration as a fallback", () => {
    const classified = classifyEvents([
      { type: "turn_end", message: { role: "user", content: "User copy" } },
      {
        type: "agent_end",
        messages: [
          { role: "tool", content: [{ type: "text", text: "Tool result" }] },
          {
            role: "assistant",
            content: [
              { type: "text", text: "I will call a tool" },
              { type: "toolCall", name: "read", arguments: { path: "README.md" } },
            ],
          },
        ],
      },
      { type: "agent_settled" },
    ]);

    expect(classified.assistantFallbacks).toEqual([]);
    expect(classified.projections).toEqual([{ sequence: 3n, type: "settled" }]);
  });

  it("classifies terminal candidates deterministically across page boundaries and re-reads", () => {
    const first = classifyEvents([{
      type: "turn_end",
      message: { role: "assistant", content: [{ type: "text", text: "Page one" }] },
    }]);
    const replayed = classifyEvents([{
      type: "turn_end",
      message: { role: "assistant", content: [{ type: "text", text: "Page one" }] },
    }]);
    const second = classifyEvents([{ type: "agent_settled" }], 1n);

    expect(replayed.assistantFallbacks).toEqual(first.assistantFallbacks);
    expect(first).toMatchObject({ throughCursor: 1n, settled: false });
    expect(second).toMatchObject({ throughCursor: 2n, settled: true });
  });

  it("keeps agent_settled terminal and result-free when no documented envelope is usable", () => {
    const classified = classifyEvents([
      { type: "agent_end", messages: [{ role: "assistant", content: [] }] },
      { type: "agent_settled" },
    ]);

    expect(classified.assistantFallbacks).toEqual([]);
    expect(classified.settled).toBe(true);
    expect(classified.projections).toEqual([{ sequence: 2n, type: "settled" }]);
  });

  it("redacts exact credentials from disclosed tool arguments and results", () => {
    const opaqueSecret = "mF9xOpaqueCredentialValue";
    const page = validatePiJournalRead({
      value: {
        events: [
          {
            sequence: 1,
            invocationId: PI_INVOCATION_ID,
            attemptId: ATTEMPT_ID,
            kind: "pi_event",
            event: {
              type: "message_end",
              message: {
                role: "assistant",
                content: [
                  { type: "text", text: `Result ${opaqueSecret} Bearer abc.def https://s3.example/a?X-Amz-Signature=secret` },
                  { type: "thinking", thinking: `credential=${opaqueSecret}` },
                ],
              },
            },
          },
          {
            sequence: 2,
            invocationId: PI_INVOCATION_ID,
            attemptId: ATTEMPT_ID,
            kind: "pi_event",
            event: {
              type: "tool_execution_start",
              toolCallId: "raw-provider-call-id",
              toolName: "shell",
              args: { command: `cat auth.json && echo ${opaqueSecret}` },
            },
          },
          {
            sequence: 3,
            invocationId: PI_INVOCATION_ID,
            attemptId: ATTEMPT_ID,
            kind: "pi_event",
            event: {
              type: "tool_execution_end",
              toolCallId: "raw-provider-call-id",
              toolName: "shell",
              result: { stdout: `TOKEN=${opaqueSecret}` },
            },
          },
          {
            sequence: 4,
            invocationId: PI_INVOCATION_ID,
            attemptId: ATTEMPT_ID,
            kind: "pi_event",
            event: {
              type: "extension_ui_request",
              id: "request-1",
              method: "confirm",
              title: "companion:shell:approve",
              message: `Approve use of ${opaqueSecret}?`,
            },
          },
        ],
        nextCursor: 4,
        acknowledgedCursor: 0,
        hasMore: false,
      },
      after: 0n,
      attemptId: ATTEMPT_ID,
      invocationId: PI_INVOCATION_ID,
    });

    const classified = classifyPiJournalPage(
      page,
      new Date("2026-08-16T12:00:00.000Z"),
      createRuntimeVisibleTextRedactor([opaqueSecret]),
    );
    const serialized = JSON.stringify(classified.projections, bigintAwareReplacer);
    const tools = classified.projections.filter((projection) => projection.type === "tool");

    expect(serialized).not.toContain(opaqueSecret);
    expect(serialized).not.toContain("raw-provider-call-id");
    expect(serialized).toContain("auth.json");
    expect(serialized).not.toContain("X-Amz-Signature");
    expect(tools).toHaveLength(2);
    expect(tools[0]).toMatchObject({
      tool: {
        call_id: expect.stringMatching(/^sha256:[0-9a-f]{32}$/),
        kind: "shell",
        name: "shell",
        title: "cat auth.json && echo",
        detail: expect.stringContaining("command"),
      },
    });
    expect(tools[1]?.tool.call_id).toBe(tools[0]?.tool.call_id);
  });

  it("redacts complete Authorization and multi-value Cookie headers from Pi projections", () => {
    const page = validatePiJournalRead({
      value: {
        events: [{
          sequence: 1,
          invocationId: PI_INVOCATION_ID,
          attemptId: ATTEMPT_ID,
          kind: "pi_event",
          event: {
            type: "message_end",
            message: {
              role: "assistant",
              content: [{
                type: "text",
                text: "Authorization: Basic dXNlcjpwYXNzL3dpdGg9cHVuY3Q=\nCookie: session=opaque-session; refresh=opaque-refresh, final=private",
              }],
            },
          },
        }],
        nextCursor: 1,
        acknowledgedCursor: 0,
        hasMore: false,
      },
      after: 0n,
      attemptId: ATTEMPT_ID,
      invocationId: PI_INVOCATION_ID,
    });

    const classified = classifyPiJournalPage(page);
    const serialized = JSON.stringify(classified.projections, bigintAwareReplacer);
    expect(serialized).toContain("Authorization [redacted]");
    expect(serialized).toContain("Cookie [redacted]");
    expect(serialized).not.toContain("dXNlcj");
    expect(serialized).not.toContain("opaque-session");
    expect(serialized).not.toContain("private");
  });

  it.each([
    ["webfetch", "browse"],
    ["execute", "shell"],
    ["str_replace_editor", "file"],
  ] as const)("uses the canonical tool catalog for %s", (toolName, kind) => {
    const page = validatePiJournalRead({
      value: {
        events: [{
          sequence: 1,
          invocationId: PI_INVOCATION_ID,
          attemptId: ATTEMPT_ID,
          kind: "pi_event",
          event: { type: "tool_execution_start", toolName, toolCallId: "call-1" },
        }],
        nextCursor: 1,
        acknowledgedCursor: 0,
        hasMore: false,
      },
      after: 0n,
      attemptId: ATTEMPT_ID,
      invocationId: PI_INVOCATION_ID,
    });

    expect(classifyPiJournalPage(page).projections[0]).toMatchObject({
      type: "tool",
      tool: { kind },
    });
  });

  it("does not reintroduce exact secrets through synthetic redaction markers", () => {
    const page = validatePiJournalRead({
      value: {
        events: [{
          sequence: 1,
          invocationId: PI_INVOCATION_ID,
          attemptId: ATTEMPT_ID,
          kind: "pi_event",
          event: {
            type: "message_end",
            message: {
              role: "assistant",
              content: "credential Bearer abc [credential removed]",
            },
          },
        }],
        nextCursor: 1,
        acknowledgedCursor: 0,
        hasMore: false,
      },
      after: 0n,
      attemptId: ATTEMPT_ID,
      invocationId: PI_INVOCATION_ID,
    });

    const classified = classifyPiJournalPage(
      page,
      new Date(),
      createRuntimeVisibleTextRedactor(["credential", "redacted"]),
    );
    const serialized = JSON.stringify(classified.projections, bigintAwareReplacer);
    expect(serialized).not.toContain("credential");
    expect(serialized).not.toContain("redacted");
  });

  it("redacts quoted OAuth JSON fields even when their values have no known token shape", () => {
    const page = validatePiJournalRead({
      value: {
        events: [{
          sequence: 1,
          invocationId: PI_INVOCATION_ID,
          attemptId: ATTEMPT_ID,
          kind: "pi_event",
          event: {
            type: "message_end",
            message: {
              role: "assistant",
              content: '{"access_token":"plain-opaque-access","clientSecret":"plain-opaque-client"}',
            },
          },
        }],
        nextCursor: 1,
        acknowledgedCursor: 0,
        hasMore: false,
      },
      after: 0n,
      attemptId: ATTEMPT_ID,
      invocationId: PI_INVOCATION_ID,
    });

    const serialized = JSON.stringify(
      classifyPiJournalPage(page).projections,
      bigintAwareReplacer,
    );
    expect(serialized).not.toContain("plain-opaque");
    expect(serialized).toContain("[redacted]");
  });

  it("refuses to persist a decision request id that contains credential material", () => {
    const secret = "opaque-decision-secret";
    const page = validatePiJournalRead({
      value: {
        events: [{
          sequence: 1,
          invocationId: PI_INVOCATION_ID,
          attemptId: ATTEMPT_ID,
          kind: "pi_event",
          event: {
            type: "extension_ui_request",
            id: secret,
            method: "confirm",
            title: "companion:shell:approve",
            message: "Approve?",
          },
        }],
        nextCursor: 1,
        acknowledgedCursor: 0,
        hasMore: false,
      },
      after: 0n,
      attemptId: ATTEMPT_ID,
      invocationId: PI_INVOCATION_ID,
    });

    expect(() => classifyPiJournalPage(
      page,
      new Date(),
      createRuntimeVisibleTextRedactor([secret]),
    )).toThrow(PiProjectionSecurityError);
  });

  it("refuses an oversized decision id before credential redaction can see only a prefix", () => {
    const secret = "s".repeat(240);
    const page = validatePiJournalRead({
      value: {
        events: [{
          sequence: 1,
          invocationId: PI_INVOCATION_ID,
          attemptId: ATTEMPT_ID,
          kind: "pi_event",
          event: {
            type: "extension_ui_request",
            id: secret,
            method: "confirm",
            title: "companion:shell:approve",
            message: "Approve?",
          },
        }],
        nextCursor: 1,
        acknowledgedCursor: 0,
        hasMore: false,
      },
      after: 0n,
      attemptId: ATTEMPT_ID,
      invocationId: PI_INVOCATION_ID,
    });

    expect(() => classifyPiJournalPage(
      page,
      new Date(),
      createRuntimeVisibleTextRedactor([secret]),
    )).toThrow(PiProjectionSecurityError);
  });

  it("refuses a decision id equal to the exact-redaction marker", () => {
    const secret = "[credential removed]";
    const page = validatePiJournalRead({
      value: {
        events: [{
          sequence: 1,
          invocationId: PI_INVOCATION_ID,
          attemptId: ATTEMPT_ID,
          kind: "pi_event",
          event: {
            type: "extension_ui_request",
            id: secret,
            method: "confirm",
            title: "companion:shell:approve",
            message: "Approve?",
          },
        }],
        nextCursor: 1,
        acknowledgedCursor: 0,
        hasMore: false,
      },
      after: 0n,
      attemptId: ATTEMPT_ID,
      invocationId: PI_INVOCATION_ID,
    });

    expect(() => classifyPiJournalPage(
      page,
      new Date(),
      createRuntimeVisibleTextRedactor([secret]),
    )).toThrow(PiProjectionSecurityError);
  });

  it("projects a valid config proposal and ignores malformed, oversized, redacted, or mis-method ones", () => {
    const proposal = {
      kind: "config" as const,
      add_skill_ids: ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"],
    };
    const summary = "Add the search skill";
    const now = new Date("2026-08-18T12:00:00.000Z");
    const secret = "opaque-config-secret";
    const validMessage = JSON.stringify({ summary, proposal });
    const page = validatePiJournalRead({
      value: {
        events: [
          {
            sequence: 1,
            invocationId: PI_INVOCATION_ID,
            attemptId: ATTEMPT_ID,
            kind: "pi_event",
            event: {
              type: "extension_ui_request",
              id: "config-1",
              method: "confirm",
              title: "companion:config:propose_config",
              message: validMessage,
            },
          },
          {
            sequence: 2,
            invocationId: PI_INVOCATION_ID,
            attemptId: ATTEMPT_ID,
            kind: "pi_event",
            event: {
              type: "extension_ui_request",
              id: "config-bad-json",
              method: "confirm",
              title: "companion:config:propose_config",
              message: "{not-json",
            },
          },
          {
            sequence: 3,
            invocationId: PI_INVOCATION_ID,
            attemptId: ATTEMPT_ID,
            kind: "pi_event",
            event: {
              type: "extension_ui_request",
              id: "config-wrong-method",
              method: "input",
              title: "companion:config:propose_config",
              message: validMessage,
            },
          },
          {
            sequence: 4,
            invocationId: PI_INVOCATION_ID,
            attemptId: ATTEMPT_ID,
            kind: "pi_event",
            event: {
              type: "extension_ui_request",
              id: "config-mixed",
              method: "confirm",
              title: "companion:config:propose_config",
              message: JSON.stringify({
                summary,
                proposal: { kind: "config", add_skill_ids: proposal.add_skill_ids, connect_plugin: { server_name: "linear" } },
              }),
            },
          },
          {
            sequence: 5,
            invocationId: PI_INVOCATION_ID,
            attemptId: ATTEMPT_ID,
            kind: "pi_event",
            event: {
              type: "extension_ui_request",
              id: "config-secret",
              method: "confirm",
              title: "companion:config:propose_config",
              message: JSON.stringify({
                summary: `Add ${secret}`,
                proposal,
              }),
            },
          },
          {
            sequence: 6,
            invocationId: PI_INVOCATION_ID,
            attemptId: ATTEMPT_ID,
            kind: "pi_event",
            event: {
              type: "extension_ui_request",
              id: "config-hub",
              method: "confirm",
              title: "companion:config:propose_config",
              message: JSON.stringify({
                summary,
                proposal: { kind: "config", add_skill_ids: proposal.add_skill_ids, can_write_skills: true },
              }),
            },
          },
        ],
        nextCursor: 6,
        acknowledgedCursor: 0,
        hasMore: false,
      },
      after: 0n,
      attemptId: ATTEMPT_ID,
      invocationId: PI_INVOCATION_ID,
    });

    const classified = classifyPiJournalPage(
      page,
      now,
      createRuntimeVisibleTextRedactor([secret]),
    );

    expect(classified.unknownEvents).toBe(5);
    expect(classified.needsInput).toBe(true);
    expect(classified.projections).toEqual([
      expect.objectContaining({
        type: "decision",
        entry_key: "decision:1",
        request_key: "config-1",
        request_kind: "config_proposal",
        content: summary,
        proposal,
        decision: expect.objectContaining({
          kind: "config",
          name: "config",
          title: summary,
          status: "pending",
          proposal,
        }),
      }),
    ]);
    const serialized = JSON.stringify(classified.projections, bigintAwareReplacer);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain("can_write_skills");
  });

  it("projects a valid routine proposal and ignores malformed, redacted, or mis-method ones", () => {
    const proposal = {
      kind: "routine" as const,
      name: "Standup",
      prompt: "Write the standup.",
      cron: "0 9 * * 1-5",
      timezone: "UTC",
    };
    const summary = "Schedule Standup each weekday at 9am";
    const now = new Date("2026-08-19T12:00:00.000Z");
    const secret = "opaque-routine-secret";
    const validMessage = JSON.stringify({ summary, proposal });
    const page = validatePiJournalRead({
      value: {
        events: [
          {
            sequence: 1,
            invocationId: PI_INVOCATION_ID,
            attemptId: ATTEMPT_ID,
            kind: "pi_event",
            event: {
              type: "extension_ui_request",
              id: "routine-1",
              method: "confirm",
              title: "companion:routine:Standup",
              message: validMessage,
            },
          },
          {
            sequence: 2,
            invocationId: PI_INVOCATION_ID,
            attemptId: ATTEMPT_ID,
            kind: "pi_event",
            event: {
              type: "extension_ui_request",
              id: "routine-malformed",
              method: "confirm",
              title: "companion:routine:Standup",
              message: "{not json",
            },
          },
          {
            sequence: 3,
            invocationId: PI_INVOCATION_ID,
            attemptId: ATTEMPT_ID,
            kind: "pi_event",
            event: {
              type: "extension_ui_request",
              id: "routine-wrong-method",
              method: "input",
              title: "companion:routine:Standup",
              message: validMessage,
            },
          },
          {
            sequence: 4,
            invocationId: PI_INVOCATION_ID,
            attemptId: ATTEMPT_ID,
            kind: "pi_event",
            event: {
              type: "extension_ui_request",
              id: "routine-secret",
              method: "confirm",
              title: "companion:routine:Standup",
              message: JSON.stringify({
                summary: `Schedule ${secret}`,
                proposal,
              }),
            },
          },
        ],
        nextCursor: 4,
        acknowledgedCursor: 0,
        hasMore: false,
      },
      after: 0n,
      attemptId: ATTEMPT_ID,
      invocationId: PI_INVOCATION_ID,
    });

    const classified = classifyPiJournalPage(
      page,
      now,
      createRuntimeVisibleTextRedactor([secret]),
    );

    expect(classified.unknownEvents).toBe(3);
    expect(classified.needsInput).toBe(true);
    expect(classified.projections).toEqual([
      expect.objectContaining({
        type: "decision",
        entry_key: "decision:1",
        request_key: "routine-1",
        request_kind: "routine_proposal",
        content: summary,
        proposal,
        expires_at: "2026-08-19T12:10:00.000Z",
        decision: expect.objectContaining({
          kind: "routine",
          name: "routine",
          title: summary,
          status: "pending",
          proposal,
          expires_at: "2026-08-19T12:10:00.000Z",
        }),
      }),
    ]);
    const serialized = JSON.stringify(classified.projections, bigintAwareReplacer);
    expect(serialized).not.toContain(secret);
  });

  it("projects a valid trigger proposal and ignores malformed, redacted, or mis-method ones", () => {
    const proposal = {
      kind: "trigger" as const,
      name: "ci-failed",
      prompt: "Investigate the failing build.",
      mode: "relay" as const,
      provider: "github" as const,
      target: { repo: "acme/ci", events: ["push"] },
    };
    const summary = "Fire ci-failed on github webhook events";
    const now = new Date("2026-08-19T12:00:00.000Z");
    const secret = "opaque-trigger-secret";
    const validMessage = JSON.stringify({ summary, proposal });
    const page = validatePiJournalRead({
      value: {
        events: [
          {
            sequence: 1,
            invocationId: PI_INVOCATION_ID,
            attemptId: ATTEMPT_ID,
            kind: "pi_event",
            event: {
              type: "extension_ui_request",
              id: "trigger-1",
              method: "confirm",
              title: "companion:trigger:ci-failed",
              message: validMessage,
            },
          },
          {
            sequence: 2,
            invocationId: PI_INVOCATION_ID,
            attemptId: ATTEMPT_ID,
            kind: "pi_event",
            event: {
              type: "extension_ui_request",
              id: "trigger-malformed",
              method: "confirm",
              title: "companion:trigger:ci-failed",
              message: "{not json",
            },
          },
          {
            sequence: 3,
            invocationId: PI_INVOCATION_ID,
            attemptId: ATTEMPT_ID,
            kind: "pi_event",
            event: {
              type: "extension_ui_request",
              id: "trigger-wrong-method",
              method: "input",
              title: "companion:trigger:ci-failed",
              message: validMessage,
            },
          },
          {
            sequence: 4,
            invocationId: PI_INVOCATION_ID,
            attemptId: ATTEMPT_ID,
            kind: "pi_event",
            event: {
              type: "extension_ui_request",
              id: "trigger-secret",
              method: "confirm",
              title: "companion:trigger:ci-failed",
              message: JSON.stringify({
                summary: `Fire ${secret}`,
                proposal,
              }),
            },
          },
        ],
        nextCursor: 4,
        acknowledgedCursor: 0,
        hasMore: false,
      },
      after: 0n,
      attemptId: ATTEMPT_ID,
      invocationId: PI_INVOCATION_ID,
    });

    const classified = classifyPiJournalPage(
      page,
      now,
      createRuntimeVisibleTextRedactor([secret]),
    );

    expect(classified.unknownEvents).toBe(3);
    expect(classified.needsInput).toBe(true);
    expect(classified.projections).toEqual([
      expect.objectContaining({
        type: "decision",
        entry_key: "decision:1",
        request_key: "trigger-1",
        request_kind: "trigger_proposal",
        content: summary,
        proposal,
        decision: expect.objectContaining({
          kind: "trigger",
          name: "trigger",
          title: summary,
          status: "pending",
          proposal,
        }),
      }),
    ]);
    const serialized = JSON.stringify(classified.projections, bigintAwareReplacer);
    expect(serialized).not.toContain(secret);
  });
});

type JsonFixture = string | number | boolean | null | { [key: string]: JsonFixture } | JsonFixture[];

describe("tool run payload projection", () => {
  function classify(
    events: JsonFixture[],
    redact = createRuntimeVisibleTextRedactor([]),
  ) {
    const page = validatePiJournalRead({
      value: {
        events: events.map((event, index) => ({
          sequence: index + 1,
          invocationId: PI_INVOCATION_ID,
          attemptId: ATTEMPT_ID,
          kind: "pi_event",
          event,
        })),
        nextCursor: events.length,
        acknowledgedCursor: 0,
        hasMore: false,
      },
      after: 0n,
      attemptId: ATTEMPT_ID,
      invocationId: PI_INVOCATION_ID,
    });
    return classifyPiJournalPage(page, new Date("2026-08-27T08:00:00.000Z"), redact);
  }

  const informativeToolEvents: Array<{ payloadContract: string; event: JsonFixture }> = [
    {
      payloadContract: "Pi RPC args object",
      event: {
        type: "tool_execution_start",
        toolCallId: "call-pi",
        toolName: "bash",
        args: { command: "pnpm test --filter companion-runtime" },
      },
    },
    {
      payloadContract: "OpenAI-compatible nested serialized arguments",
      event: {
        type: "tool_execution_start",
        toolCall: {
          id: "call-openai",
          function: {
            name: "bash",
            arguments: "{\"command\":\"pnpm test --filter companion-runtime\"}",
          },
        },
      },
    },
  ];

  it.each(informativeToolEvents)(
    "projects an informative card from $payloadContract",
    ({ event }) => {
      const [projection] = classify([event]).projections.filter((item) => item.type === "tool");

      expect(projection).toMatchObject({
        content: "pnpm test --filter companion-runtime",
        tool: {
          kind: "shell",
          name: "bash",
          title: "pnpm test --filter companion-runtime",
          status: "running",
        },
      });
      expect(projection?.tool.detail).toContain("command");
      expect(projection?.tool.detail).toContain("pnpm test --filter companion-runtime");
    },
  );

  it("projects the result excerpt without losing the command title", () => {
    const tools = classify([
      {
        type: "tool_execution_start",
        toolCallId: "call-glm",
        toolName: "bash",
        args: { command: "printf 'glm fixture\\n'" },
      },
      {
        type: "tool_execution_end",
        toolCallId: "call-glm",
        toolName: "bash",
        result: { content: [{ type: "text", text: "glm fixture\n" }] },
        isError: false,
      },
    ]).projections.filter((item) => item.type === "tool");

    expect(tools[0]?.tool).toMatchObject({
      title: "printf 'glm fixture\\n'",
      detail: expect.stringContaining("command"),
    });
    expect(tools[1]?.tool).toMatchObject({
      title: "",
      status: "ok",
      detail: "Result\nglm fixture",
    });
  });

  it("redacts before applying the 16k disclosure cap", () => {
    const secret = `${"s".repeat(15_900)}-opaque-credential`;
    const [projection] = classify([{
      type: "tool_execution_start",
      toolCallId: "call-long",
      toolName: "bash",
      args: { command: `printf safe && printf ${secret}`, extra: "x".repeat(20_000) },
    }], createRuntimeVisibleTextRedactor([secret])).projections
      .filter((item) => item.type === "tool");
    const serialized = JSON.stringify(projection, bigintAwareReplacer);

    expect(serialized).not.toContain(secret);
    expect(projection?.tool.detail?.length).toBeLessThanOrEqual(16_000);
    expect(projection?.tool.detail).toContain("[truncated]");
  });

  it("redacts structured values before JSON escaping can disguise an exact credential", () => {
    const secret = "quote\"\\credential";
    const [projection] = classify([{
      type: "tool_execution_start",
      toolCallId: "call-escaped-secret",
      toolName: "bash",
      args: { command: `printf safe ${secret}`, [secret]: "also-secret-key" },
    }], createRuntimeVisibleTextRedactor([secret])).projections
      .filter((item) => item.type === "tool");
    const serialized = JSON.stringify(projection, bigintAwareReplacer);
    const escapedSecret = JSON.stringify(secret).slice(1, -1);

    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain(escapedSecret);
    expect(projection?.tool.title).toBe("printf safe");
    expect(projection?.tool.detail).not.toContain("also-secret-key");
  });

  it("preserves edge whitespace until exact credential redaction", () => {
    const secret = "  padded credential  ";
    const [projection] = classify([{
      type: "tool_execution_start",
      toolCallId: "call-padded-secret",
      toolName: "bash",
      args: { command: secret },
    }], createRuntimeVisibleTextRedactor([secret])).projections
      .filter((item) => item.type === "tool");
    const serialized = JSON.stringify(projection, bigintAwareReplacer);

    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain("padded credential");
    expect(projection?.tool.title).toBe("Shell command");
  });

  it("fails closed on credentials hidden in malformed JSON-escaped arguments", () => {
    const secret = "quote\"\\credential";
    const escapedSecret = JSON.stringify(secret).slice(1, -1);
    const [projection] = classify([{
      type: "tool_execution_start",
      toolCall: {
        id: "call-malformed-secret",
        function: {
          name: "bash",
          arguments: `{"command":"${escapedSecret}`,
        },
      },
    }], createRuntimeVisibleTextRedactor([secret])).projections
      .filter((item) => item.type === "tool");
    const serialized = JSON.stringify(projection, bigintAwareReplacer);

    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain(escapedSecret);
    expect(projection?.tool).toMatchObject({ title: "Shell command", detail: null });
  });

  it("fails closed when nested JSON escaping exceeds the bounded decoding work", () => {
    const secret = "deep\"\\credential";
    let deeplyEscaped = secret;
    for (let depth = 0; depth < 12; depth += 1) {
      deeplyEscaped = JSON.stringify(deeplyEscaped).slice(1, -1);
    }
    const [projection] = classify([{
      type: "tool_execution_start",
      toolCall: {
        id: "call-deeply-escaped-secret",
        function: { name: "bash", arguments: `{"command":"${deeplyEscaped}` },
      },
    }], createRuntimeVisibleTextRedactor([secret])).projections
      .filter((item) => item.type === "tool");
    const serialized = JSON.stringify(projection, bigintAwareReplacer);

    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain(deeplyEscaped);
    expect(projection?.tool).toMatchObject({ title: "Shell command", detail: null });
  });

  it("replaces PostgreSQL-invalid NULs and lone surrogates in tool metadata", () => {
    const tools = classify([
      {
        type: "tool_execution_start",
        toolCallId: "call-invalid-unicode",
        toolName: "bash\u0000\ud800",
        args: { command: "printf\u0000safe\ud800" },
      },
      {
        type: "tool_execution_update",
        toolCallId: "call-invalid-unicode",
        toolName: "bash\u0000\ud800",
        partialOutput: "progress\u0000\udc00",
      },
      {
        type: "tool_execution_end",
        toolCallId: "call-invalid-unicode",
        toolName: "bash\u0000\ud800",
        result: { content: [{ type: "text", text: "done\u0000\ud800" }] },
      },
    ]).projections.filter((item) => item.type === "tool");
    const serialized = JSON.stringify(tools, bigintAwareReplacer);

    expect(serialized).not.toContain("\\u0000");
    expect(serialized).not.toContain("\\ud800");
    expect(serialized).not.toContain("\\udc00");
    expect(serialized).toContain("�");
  });

  it("redacts a provider tool name before applying its 120-character bound", () => {
    const secret = `${"provider-secret".repeat(20)}-tail`;
    const [projection] = classify([{
      type: "tool_execution_start",
      toolCallId: "call-secret-name",
      toolName: secret,
      args: { command: "printf safe" },
    }], createRuntimeVisibleTextRedactor([secret])).projections
      .filter((item) => item.type === "tool");
    const serialized = JSON.stringify(projection, bigintAwareReplacer);

    expect(serialized).not.toContain(secret.slice(0, 120));
    expect(projection?.tool.name).toBe("tool");
  });

  it("bounds traversal of deeply nested provider arguments", () => {
    let nested: JsonFixture = "too deep to become a headline";
    for (let depth = 0; depth < 4_000; depth += 1) nested = { nested };
    const event = {
      type: "tool_execution_start",
      toolCallId: "call-deep",
      toolName: "bash",
      args: nested,
    } satisfies JsonFixture;

    expect(() => classify([event])).not.toThrow();
    const [projection] = classify([event]).projections.filter((item) => item.type === "tool");

    expect(projection?.tool.title).toBe("Shell command");
    expect(projection?.tool.detail?.length).toBeLessThanOrEqual(16_000);
  });
});

describe("delegated subagent runs", () => {
  const secret = "mF9xOpaqueCredentialValue";

  // The fixture events are exactly the pi_event payloads these projections consume; the wrapper
  // fields the journal validator expects are added by classify itself.
  function classify(events: JsonFixture[]) {
    const page = validatePiJournalRead({
      value: {
        events: events.map((event, index) => ({
          sequence: index + 1,
          invocationId: PI_INVOCATION_ID,
          attemptId: ATTEMPT_ID,
          kind: "pi_event",
          event,
        })),
        nextCursor: events.length,
        acknowledgedCursor: 0,
        hasMore: false,
      },
      after: 0n,
      attemptId: ATTEMPT_ID,
      invocationId: PI_INVOCATION_ID,
    });
    return classifyPiJournalPage(
      page,
      new Date("2026-08-19T12:00:00.000Z"),
      createRuntimeVisibleTextRedactor([secret]),
    );
  }

  it("names the agent and its task when a run starts, and follows it to its result", () => {
    const classified = classify([
      {
        type: "tool_execution_start",
        toolCallId: "call-1",
        toolName: "run_subagent",
        args: { agent: "researcher", task: "Read the changelog\nand summarize it" },
      },
      {
        type: "tool_execution_update",
        toolCallId: "call-1",
        toolName: "run_subagent",
        partialOutput: "reading CHANGELOG.md",
      },
      {
        type: "tool_execution_end",
        toolCallId: "call-1",
        toolName: "run_subagent",
      },
    ]);
    const tools = classified.projections.filter((projection) => projection.type === "tool");

    expect(tools[0]).toMatchObject({
      content: "researcher: Read the changelog",
      tool: {
        kind: "subagent",
        name: "subagent",
        title: "researcher: Read the changelog",
        status: "running",
        detail: "Read the changelog\nand summarize it",
      },
    });
    // Progress and settlement carry only what changed. Empty title and null detail are the
    // inherit sentinels the projection reads as "keep what the card already says".
    expect(tools[1]).toMatchObject({
      content: "",
      tool: { title: "", status: "running", detail: "reading CHANGELOG.md" },
    });
    expect(tools[2]).toMatchObject({
      content: "",
      tool: { title: "", status: "ok", detail: null },
    });
    // Every one of them settles the same card.
    expect(new Set(tools.map((tool) => tool.tool.call_id)).size).toBe(1);
  });

  it("reads progress from the shape Pi actually sends", () => {
    // The contract fixture for a running tool is
    // `partialResult: { content: [{ type: "text", text }] }` — see
    // packages/box-sim/fixtures/pi/official-events.jsonl. Reading only the flat string spellings is
    // how a progress line becomes no progress at all, silently: the card would just never move.
    const classified = classify([
      {
        type: "tool_execution_start",
        toolCallId: "call-1",
        toolName: "subagent",
        args: { agent: "researcher", task: "read the changelog" },
      },
      {
        type: "tool_execution_update",
        toolCallId: "call-1",
        toolName: "subagent",
        args: { agent: "researcher" },
        partialResult: {
          content: [{ type: "text", text: "# Example" }, { type: "image", data: "ignored" }],
          details: { truncation: null, fullOutputPath: null },
        },
      },
    ]);
    const tools = classified.projections.filter((projection) => projection.type === "tool");

    expect(tools).toHaveLength(2);
    expect(tools[1]).toMatchObject({
      tool: { status: "running", title: "", detail: "# Example" },
    });
  });

  it("keeps a failed delegation showing what it was doing", () => {
    const classified = classify([
      {
        type: "tool_execution_start",
        toolCallId: "call-1",
        toolName: "subagent",
        args: { agent: "deployer", task: "ship the release" },
      },
      {
        type: "tool_execution_end",
        toolCallId: "call-1",
        toolName: "subagent",
        isError: true,
      },
    ]);
    const tools = classified.projections.filter((projection) => projection.type === "tool");

    // The failure is the moment a reader most needs the headline and the last progress, so the
    // settlement carries a status and nothing else.
    expect(tools[1]).toMatchObject({
      content: "",
      tool: { status: "error", title: "", detail: null },
    });
  });

  it("accepts every argument spelling, and keeps a runaway agent name to one bounded line", () => {
    for (const container of ["args", "arguments", "input", "toolInput"]) {
      for (const agentKey of ["agent", "agent_name", "agentName", "name"]) {
        for (const taskKey of ["task", "prompt", "description", "instructions"]) {
          const classified = classify([{
            type: "tool_execution_start",
            toolCallId: "call-1",
            toolName: "subagent",
            [container]: { [agentKey]: "researcher", [taskKey]: "read the changelog" },
          }]);
          expect(classified.projections[0]).toMatchObject({
            content: "researcher: read the changelog",
          });
        }
      }
    }

    const wild = classify([{
      type: "tool_execution_start",
      toolCallId: "call-1",
      toolName: "subagent",
      args: { agent: `${"n".repeat(400)}\nsecond line`, task: "do the thing" },
    }]);
    const [title] = wild.projections
      .filter((projection) => projection.type === "tool")
      .map((projection) => projection.tool.title);

    // A name is a name: one line, bounded, and it cannot push the task out of the headline.
    expect(title).toBe(`${"n".repeat(120)}: do the thing`);

    // The name is cut like every other persisted string here, so it cannot end mid-emoji and take
    // the whole event batch down with it.
    const astral = classify([{
      type: "tool_execution_start",
      toolCallId: "call-1",
      toolName: "subagent",
      args: { agent: `${"n".repeat(119)}🙂 rest`, task: "do the thing" },
    }]);
    const [astralTitle] = astral.projections
      .filter((projection) => projection.type === "tool")
      .map((projection) => projection.tool.title);

    expect(astralTitle).toBe(`${"n".repeat(119)}: do the thing`);
  });

  it("keeps the task when a progress line is nothing but a credential", () => {
    const classified = classify([
      {
        type: "tool_execution_start",
        toolCallId: "call-1",
        toolName: "subagent",
        args: { agent: "deployer", task: "ship the release" },
      },
      {
        type: "tool_execution_update",
        toolCallId: "call-1",
        toolName: "subagent",
        partialResult: { content: [{ type: "text", text: secret }] },
      },
    ]);

    // An empty detail is not the inherit sentinel: projecting one would replace the task with
    // nothing and close the disclosure for good. Nothing to show means nothing to project.
    expect(classified.projections).toEqual([
      expect.objectContaining({ type: "tool" }),
      expect.objectContaining({ type: "activity", event_type: "tool_execution_update" }),
    ]);
  });

  it("never persists half of a credential that a cut would hide from the redactor", () => {
    const long = `${"z".repeat(200)}-OPAQUE-CREDENTIAL-VALUE`;
    const classified = classifyPiJournalPage(
      validatePiJournalRead({
        value: {
          events: [{
            sequence: 1,
            invocationId: PI_INVOCATION_ID,
            attemptId: ATTEMPT_ID,
            kind: "pi_event",
            event: {
              type: "tool_execution_start",
              toolCallId: "call-1",
              toolName: "subagent",
              args: { agent: long, task: `deploy with ${long}` },
            },
          }],
          nextCursor: 1,
          acknowledgedCursor: 0,
          hasMore: false,
        },
        after: 0n,
        attemptId: ATTEMPT_ID,
        invocationId: PI_INVOCATION_ID,
      }),
      new Date("2026-08-19T12:00:00.000Z"),
      createRuntimeVisibleTextRedactor([long]),
    );
    const serialized = JSON.stringify(classified.projections, bigintAwareReplacer);

    // The agent name is cut at 120 characters. Cutting before redacting would leave the first 120
    // characters of the credential in the title, matching nothing the redactor could remove.
    expect(serialized).not.toContain("zzzzzzzz");
  });

  it("redacts the task and the progress it shows, and bounds both", () => {
    const classified = classify([
      {
        type: "tool_execution_start",
        toolCallId: "call-1",
        toolName: "subagent",
        args: { agent: "deployer", task: `Deploy with ${secret}\n${"x".repeat(9_000)}` },
      },
      {
        type: "tool_execution_update",
        toolCallId: "call-1",
        toolName: "subagent",
        output: `${"y".repeat(9_000)}\nlast line with ${secret}`,
      },
    ]);
    const tools = classified.projections.filter((projection) => projection.type === "tool");
    const serialized = JSON.stringify(classified.projections, bigintAwareReplacer);

    expect(serialized).not.toContain(secret);
    expect(tools[0]?.tool.title.length).toBeLessThanOrEqual(300);
    expect(tools[0]?.tool.detail?.length).toBeLessThanOrEqual(8_000);
    // Progress is read from its end, so a long stream keeps its newest lines rather than its first.
    expect(tools[1]?.tool.detail?.length).toBeLessThanOrEqual(8_000);
    expect(tools[1]?.tool.detail).toContain("last line with");
    expect(tools[1]?.tool.detail?.startsWith("[truncated]")).toBe(true);
  });

  it("never cuts an emoji in half, which PostgreSQL would refuse for the whole batch", () => {
    // A lone surrogate is not text jsonb accepts, and the same journal page is re-read on every
    // retry, so one split emoji would stall the turn rather than lose a character.
    const classified = classify([
      {
        type: "tool_execution_start",
        toolCallId: "call-1",
        toolName: "subagent",
        args: { agent: "researcher", task: `${"a".repeat(7_988)}🙂 tail` },
      },
      {
        type: "tool_execution_update",
        toolCallId: "call-1",
        toolName: "subagent",
        partialResult: { content: [{ type: "text", text: `head 🙂${"b".repeat(7_988)}` }] },
      },
    ]);

    for (const projection of classified.projections) {
      if (projection.type !== "tool") continue;
      const detail = projection.tool.detail ?? "";
      expect(JSON.parse(JSON.stringify(detail))).toBe(detail);
      for (let index = 0; index < detail.length; index += 1) {
        const code = detail.charCodeAt(index);
        const isHigh = code >= 0xd800 && code <= 0xdbff;
        const isLow = code >= 0xdc00 && code <= 0xdfff;
        if (isHigh) expect(detail.charCodeAt(index + 1)).toBeGreaterThanOrEqual(0xdc00);
        if (isLow) expect(detail.charCodeAt(index - 1)).toBeGreaterThanOrEqual(0xd800);
      }
    }
  });

  it("still shows a run whose arguments say nothing, and stays activity with nothing to show", () => {
    const classified = classify([
      { type: "tool_execution_start", toolCallId: "call-1", toolName: "subagent" },
      { type: "tool_execution_update", toolCallId: "call-1", toolName: "subagent" },
      {
        type: "tool_execution_update",
        toolCallId: "call-1",
        toolName: "subagent",
        partialOutput: { not: "text" },
      },
      // No call id is no card to merge into: one row per progress line would bury the thread.
      { type: "tool_execution_update", toolName: "subagent", partialOutput: "still working" },
    ]);

    expect(classified.projections).toEqual([
      expect.objectContaining({
        type: "tool",
        content: "Subagent run",
        tool: expect.objectContaining({ title: "Subagent run", detail: null }),
      }),
      // An update with no readable text is what it has always been: activity that keeps the turn
      // alive, and no change to the card.
      expect.objectContaining({ type: "activity", event_type: "tool_execution_update" }),
      expect.objectContaining({ type: "activity", event_type: "tool_execution_update" }),
      expect.objectContaining({ type: "activity", event_type: "tool_execution_update" }),
    ]);
    expect(classified.activity).toBe(true);
  });

  it("redacts and bounds the arguments and progress of an ordinary tool", () => {
    const classified = classify([
      {
        type: "tool_execution_start",
        toolCallId: "call-1",
        toolName: "bash",
        args: { command: `echo ${secret}`, task: "Read the changelog" },
      },
      {
        type: "tool_execution_update",
        toolCallId: "call-1",
        toolName: "bash",
        partialOutput: `TOKEN=${secret}`,
      },
      { type: "tool_execution_end", toolCallId: "call-1", toolName: "bash" },
    ]);
    const tools = classified.projections.filter((projection) => projection.type === "tool");
    const serialized = JSON.stringify(classified.projections, bigintAwareReplacer);

    expect(serialized).not.toContain(secret);
    expect(serialized).toContain("Read the changelog");
    expect(tools).toHaveLength(3);
    expect(tools[0]?.tool).toMatchObject({
      name: "bash",
      title: "echo",
      detail: expect.stringContaining("Read the changelog"),
    });
    expect(tools[1]?.tool).toMatchObject({ title: "", detail: "Result\nTOKEN=" });
    expect(tools[2]?.tool).toMatchObject({ title: "", status: "ok", detail: null });
  });
});
