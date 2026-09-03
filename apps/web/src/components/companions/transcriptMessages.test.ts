// @vitest-environment happy-dom
/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion, anti-slop/no-runtime-typeof -- Existing tests predate the incremental anti-slop gate. */

/**
 * Product promise:
 * A Companion turn reads as one thing that happened. Everything Pi produced between two
 * interruptions — its reasoning, its replies, its tool runs, its permission cards — is one message
 * in the order it happened, a writer is named once per passage, and a message the composer is still
 * sending is marked as such. Identity survives polling, so a settling chip re-renders its own turn
 * and nothing else.
 *
 * Regression caught:
 * THE-364 replaced `transcriptTurns` with this module. The failures it guards against are a turn
 * fragmenting into one message per entry, a turn changing id as it grows (which remounts it
 * mid-conversation), a passage re-announcing its writer on every line, and the poll-identity caches
 * either never or always invalidating.
 *
 * Why this test is at this level:
 * Grouping is pure — entries in, messages out — so it is provable without a runtime, and the
 * identity caches are hooks, so they are exercised through a probe component rather than by reading
 * their internals.
 *
 * Failure proof:
 * Emitting one message per entry, keying a group by anything but its first entry's event id, or
 * making `sameGroup`/`unchanged` unconditional each fails a case below.
 */

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type {
  CompanionDecision,
  CompanionToolRun,
  CompanionTranscriptEntry,
} from "@companion/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { utcDay } from "./transcript";
import {
  COMPANION_DECISION_TOOL_NAME,
  COMPANION_TOOL_NAME,
  groupTranscriptEntries,
  toThreadMessageLike,
  useStableEntries,
  useStableGroups,
  type TranscriptMessage,
} from "./transcriptMessages";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const context = { viewerId: "user-1", companionName: "Luna" };

let ordinal = 0;

function entry(overrides: Partial<CompanionTranscriptEntry> = {}): CompanionTranscriptEntry {
  return {
    event_id: `pi:${ordinal}`,
    ordinal: ordinal++,
    role: "assistant",
    content: "Two services timed out.",
    reasoning: null,
    routine: null,
    trigger: null,
    turn_id: null,
    queued: false,
    author_id: null,
    author_name: null,
    tool: null,
    decision: null,
    attachments: [],
    created_at: "2026-08-12T12:00:00.000Z",
    ...overrides,
  };
}

function said(content: string, overrides: Partial<CompanionTranscriptEntry> = {}) {
  return entry({
    event_id: `msg:${content}`,
    role: "user",
    content,
    author_id: "user-1",
    ...overrides,
  });
}

function run(overrides: Partial<CompanionToolRun> = {}): CompanionToolRun {
  return {
    call_id: "call_1",
    kind: "shell",
    name: "bash",
    title: "ls -la",
    status: "running",
    detail: null,
    screenshot: null,
    ...overrides,
  };
}

function card(overrides: Partial<CompanionDecision> = {}): CompanionDecision {
  return {
    request_id: "ui-1",
    kind: "shell",
    name: "bash",
    title: "rm -rf build",
    detail: null,
    status: "pending",
    answer: null,
    decided_by_id: null,
    decided_by_name: null,
    decided_at: null,
    expires_at: "2026-08-12T12:05:00.000Z",
    proposal: null,
    ...overrides,
  };
}

/** What the thread would render for these entries: one row per message, parts flattened. */
function rendered(entries: CompanionTranscriptEntry[]) {
  return groupTranscriptEntries(entries, context).map((group) => {
    const message = toThreadMessageLike(group);
    const content = typeof message.content === "string" ? [] : message.content;
    return {
      id: message.id,
      role: message.role,
      parts: content.map((part) => {
        if (part.type === "tool-call") return `${part.type}:${part.toolName}`;
        if (part.type === "text" || part.type === "reasoning") return `${part.type}:${part.text}`;
        return part.type;
      }),
    };
  });
}

describe("grouping a transcript into messages", () => {
  it("keeps a Pi turn's reply, runs, and cards as one message however they interleave", () => {
    const entries = [
      said("Clean the build"),
      entry({ content: "Checking the tree." }),
      entry({ role: "tool", content: "ls -la", tool: run() }),
      entry({ role: "decision", event_id: "decision:ui-1", content: "rm -rf build", decision: card() }),
      entry({ role: "tool", content: "rm -rf build", tool: run({ call_id: "call_2", status: "ok" }) }),
      entry({ content: "Done." }),
      said("Thanks"),
    ];

    expect(rendered(entries)).toEqual([
      { id: "msg:Clean the build", role: "user", parts: ["text:Clean the build"] },
      {
        id: entries[1]!.event_id,
        role: "assistant",
        parts: [
          "text:Checking the tree.",
          `tool-call:${COMPANION_TOOL_NAME}`,
          `tool-call:${COMPANION_DECISION_TOOL_NAME}`,
          `tool-call:${COMPANION_TOOL_NAME}`,
          "text:Done.",
        ],
      },
      { id: "msg:Thanks", role: "user", parts: ["text:Thanks"] },
    ]);
  });

  it("starts a turn on whichever entry Pi produced first", () => {
    // A turn that runs a tool before it says anything is still one turn, named by the run.
    const first = entry({ role: "tool", content: "ls", tool: run() });
    const groups = groupTranscriptEntries([first, entry({ content: "Listed." })], context);

    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ id: first.event_id, role: "assistant", author: "Luna" });
  });

  it("breaks a turn on a note about the run and re-announces the writer after it", () => {
    const entries = [
      entry({ content: "Working on it." }),
      entry({ role: "system", content: "Pi ended the turn without a reply (error)." }),
      entry({ content: "Recovered." }),
    ];

    const groups = groupTranscriptEntries(entries, context);

    expect(groups.map((group) => [group.role, group.author, group.lead])).toEqual([
      ["assistant", "Luna", true],
      ["system", null, true],
      ["assistant", "Luna", true],
    ]);
  });

  it("names each writer once per passage", () => {
    const groups = groupTranscriptEntries([
      said("First", { created_at: "2026-08-12T12:00:00.000Z" }),
      said("Second", { created_at: "2026-08-12T12:01:00.000Z" }),
      said("Much later", { created_at: "2026-08-12T13:00:00.000Z" }),
      said("From a teammate", { author_id: "user-2", author_name: "Ada" }),
    ], context);

    expect(groups.map((group) => [group.author, group.lead])).toEqual([
      ["You", true],
      ["You", false],
      ["You", true],
      ["Ada", true],
    ]);
  });

  it("marks only the message the composer is still sending", () => {
    const groups = groupTranscriptEntries(
      [said("Saved"), said("In flight", { event_id: "msg:pending" })],
      { ...context, sendingEventId: "msg:pending" },
    );

    expect(groups.map((group) => group.sending)).toEqual([false, true]);
  });

  it("marks nothing while no send is in flight", () => {
    // A saved entry is never on its way, and the id it was stored under is the same one the composer
    // named, so an absent id must not read as a match — every message would dim at once.
    const groups = groupTranscriptEntries([said("Saved"), entry({ content: "Answered." })], context);

    expect(groups.every((group) => !group.sending)).toBe(true);
  });

  it("marks a saved follow-up as queued until Pi reaches it", () => {
    const groups = groupTranscriptEntries([
      said("Working"),
      said("Then this", { queued: true, turn_id: "22222222-2222-4222-8222-222222222222" }),
    ], context);

    expect(groups.map((group) => ({ queued: group.queued, turnId: group.turnId }))).toEqual([
      { queued: false, turnId: null },
      { queued: true, turnId: "22222222-2222-4222-8222-222222222222" },
    ]);
  });
});

describe("converting a message for the thread", () => {
  it("renders the stable terminal model error as an in-thread system note", () => {
    const groups = groupTranscriptEntries([entry({
      event_id: "v3:turn:error:17",
      role: "system",
      content: "The selected model is unavailable. Choose a different model and try again.",
    })], context);
    expect(groups[0]?.displayContent).toBe(
      "The selected model is unavailable. Choose a different model and try again.",
    );
    expect(rendered(groups.flatMap((group) => group.entries))).toEqual([{
      id: "v3:turn:error:17",
      role: "system",
      parts: ["text:The selected model is unavailable. Choose a different model and try again."],
    }]);
  });

  it("puts reasoning before the reply it produced", () => {
    const [message] = rendered([entry({ reasoning: "checked the logs", content: "Two timed out." })]);

    expect(message?.parts).toEqual(["reasoning:checked the logs", "text:Two timed out."]);
  });

  it("shows a reply with no reasoning as the reply alone", () => {
    const [message] = rendered([entry({ content: "2025" })]);

    expect(message?.parts).toEqual(["text:2025"]);
  });

  it("carries the run itself, and a result only once the run settled", () => {
    const open = toThreadMessageLike(
      groupTranscriptEntries([entry({ role: "tool", content: "ls", tool: run() })], context)[0]!,
    );
    const settled = toThreadMessageLike(
      groupTranscriptEntries(
        [entry({ role: "tool", content: "ls", tool: run({ status: "ok", detail: "a\nb" }) })],
        context,
      )[0]!,
    );
    const partOf = (message: typeof open) =>
      (typeof message.content === "string" ? [] : message.content)[0]!;

    expect(partOf(open)).toMatchObject({
      type: "tool-call",
      toolName: COMPANION_TOOL_NAME,
      args: { run: { status: "running" } },
      result: undefined,
    });
    expect(partOf(settled)).toMatchObject({
      args: { run: { status: "ok", detail: "a\nb" } },
      result: { status: "ok" },
    });
  });

  it("carries a permission card, and a result only once it was decided", () => {
    const pending = groupTranscriptEntries(
      [entry({ role: "decision", event_id: "decision:ui-1", content: "rm", decision: card() })],
      context,
    )[0]!;
    const decided = groupTranscriptEntries(
      [entry({
        role: "decision",
        event_id: "decision:ui-1",
        content: "rm",
        decision: card({ status: "denied", decided_by_name: "Ada" }),
      })],
      context,
    )[0]!;
    const partOf = (group: TranscriptMessage) => {
      const message = toThreadMessageLike(group);
      return (typeof message.content === "string" ? [] : message.content)[0]!;
    };

    expect(partOf(pending)).toMatchObject({
      type: "tool-call",
      toolCallId: "decision:ui-1",
      toolName: COMPANION_DECISION_TOOL_NAME,
      args: { decision: { status: "pending" } },
      result: undefined,
    });
    expect(partOf(decided)).toMatchObject({
      args: { decision: { status: "denied", decided_by_name: "Ada" } },
      result: { status: "denied" },
    });
  });

  it("gives two runs Pi named identically two cards", () => {
    const message = toThreadMessageLike(groupTranscriptEntries([
      entry({ role: "tool", content: "ls", tool: run() }),
      entry({ role: "tool", content: "pwd", tool: run() }),
    ], context)[0]!);
    const content = typeof message.content === "string" ? [] : message.content;
    const ids = content.map((part) => part.type === "tool-call" ? part.toolCallId : null);

    expect(new Set(ids).size).toBe(2);
  });

  it("keeps an empty turn renderable", () => {
    const [message] = rendered([entry({ content: "" })]);

    expect(message?.parts).toEqual(["text:"]);
  });

  it("refuses to attach reasoning to anything that is not a reply", () => {
    // The contract and a database constraint both forbid this, so it can only arrive from drift or a
    // hand-written row. The runtime answers a reasoning part on a member's message by throwing, and
    // that throw takes the whole conversation down — so the incoherent field is dropped instead.
    const note = rendered([entry({
      role: "system",
      content: "Pi ended the turn without a visible reply.",
      reasoning: "should never be shown",
    })]);
    const member = rendered([said("Ship it", { reasoning: "should never be shown" })]);

    // Renamed on the way out, because a note speaks about the Companion rather than about Pi.
    expect(note[0]?.parts).toEqual(["text:Luna ended the turn without a visible reply."]);
    expect(member[0]?.parts).toEqual(["text:Ship it"]);
  });

  it("keeps the serialised copy of a run's arguments empty", () => {
    // A visual run carries a whole Box screenshot in `args`, and the runtime stringifies `args` into
    // a second copy whenever this is absent — re-doing it for every earlier run each time the turn
    // grows. Nothing in this thread reads that copy.
    const message = toThreadMessageLike(groupTranscriptEntries([
      entry({ role: "tool", content: "click", tool: run({ screenshot: "data:image/png;base64,AAAA" }) }),
    ], context)[0]!);
    const part = (typeof message.content === "string" ? [] : message.content)[0]!;

    expect(part.type === "tool-call" && part.argsText).toBe("");
  });
});

describe("separating a transcript into days and unread", () => {
  // Ported from `transcriptTurns` when grouping moved here: the promises are the same, but they are
  // now drawn on messages rather than on entries, so a separator lands on a turn and never inside it.

  it("opens each day the thread was written in, and only the first message of it", () => {
    const groups = groupTranscriptEntries([
      said("First", { created_at: "2026-08-12T12:00:00.000Z" }),
      entry({ content: "Answered.", created_at: "2026-08-12T12:01:00.000Z" }),
      said("Days later", { created_at: "2026-08-14T09:00:00.000Z" }),
    ], context);

    expect(groups.map((group) => group.startsDay)).toEqual(["2026-08-12", null, "2026-08-14"]);
  });

  it("groups by the reader's own day once the client has a clock", () => {
    // The stored day and the reader's day are different days for most of the world, and a separator
    // naming one date above timestamps that name another is worse than no separator at all.
    const entries = [
      entry({ content: "Late", created_at: "2026-08-14T23:30:00.000Z" }),
      said("Just after", { created_at: "2026-08-15T00:30:00.000Z" }),
    ];

    expect(groupTranscriptEntries(entries, { ...context, dayOf: utcDay })
      .map((group) => group.startsDay)).toEqual(["2026-08-14", "2026-08-15"]);

    // A reader an hour ahead of UTC saw both of those arrive on the same evening.
    const plusOneHour = (iso: string) =>
      new Date(Date.parse(iso) + 3_600_000).toISOString().slice(0, 10);
    expect(groupTranscriptEntries(entries, { ...context, dayOf: plusOneHour })
      .map((group) => group.startsDay)).toEqual(["2026-08-15", null]);
  });

  it("keeps a day boundary off a tool run, which is chrome inside a turn", () => {
    // A run belongs to the turn that performed it, so the day opens on the turn, not on the chip.
    const groups = groupTranscriptEntries([
      entry({ role: "tool", content: "npm test", tool: run({ status: "ok" }), created_at: "2026-08-14T00:00:10.000Z" }),
      entry({ content: "Green.", created_at: "2026-08-14T00:00:20.000Z" }),
    ], context);

    expect(groups).toHaveLength(1);
    expect(groups[0]?.startsDay).toBe("2026-08-14");
  });

  it("draws the new-message divider once, on the first message past the reader's watermark", () => {
    const groups = groupTranscriptEntries([
      entry({ content: "One", ordinal: 0 }),
      said("Two", { ordinal: 1, author_id: "user-9" }),
      entry({ content: "Three", ordinal: 2 }),
    ], { ...context, lastReadOrdinal: 0 });

    expect(groups.map((group) => group.startsNew)).toEqual([false, true, false]);
  });

  it("never divides a thread at this reader's own message", () => {
    const groups = groupTranscriptEntries([
      said("Mine", { ordinal: 1 }),
      entry({ content: "The reply", ordinal: 2 }),
    ], { ...context, lastReadOrdinal: 0 });

    expect(groups.map((group) => group.startsNew)).toEqual([false, true]);
  });

  it("marks where reading stopped, not what arrived while the reader watched", () => {
    const entries = [
      entry({ content: "Seen", ordinal: 1 }),
      said("Newer", { ordinal: 2, author_id: "user-9" }),
    ];

    expect(groupTranscriptEntries(entries, {
      ...context,
      lastReadOrdinal: 1,
      openedThroughOrdinal: 2,
    }).map((group) => group.startsNew)).toEqual([false, true]);

    // The same message, but it arrived after the thread was already open — not a backlog.
    expect(groupTranscriptEntries(entries, {
      ...context,
      lastReadOrdinal: 1,
      openedThroughOrdinal: 1,
    }).some((group) => group.startsNew)).toBe(false);
  });

  it("keeps the divider on a turn the reader's watermark falls inside", () => {
    // A turn is one message however many entries it took, so a watermark can land in the middle of
    // one. Drawing on the turn that contains the boundary is what keeps the divider from vanishing
    // exactly when a returning reader needs it.
    const groups = groupTranscriptEntries([
      entry({ content: "First", ordinal: 0 }),
      entry({ role: "tool", content: "ls", tool: run(), ordinal: 1 }),
      entry({ content: "Second", ordinal: 2 }),
    ], { ...context, lastReadOrdinal: 1 });

    expect(groups).toHaveLength(1);
    expect(groups[0]?.startsNew).toBe(true);
  });

  it("leaves a thread undivided when the reader has caught up, or has never been here", () => {
    const entries = [entry({ content: "Only", ordinal: 3 })];

    expect(groupTranscriptEntries(entries, { ...context, lastReadOrdinal: 3 })
      .some((group) => group.startsNew)).toBe(false);
    // A first visit has no watermark to return to, so the whole thread is simply the thread.
    expect(groupTranscriptEntries(entries, { ...context, lastReadOrdinal: null })
      .some((group) => group.startsNew)).toBe(false);
  });
});

const roots: Root[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
});

/** Render a hook and return a setter that re-runs it with fresh input plus every value it saw. */
function renderHook<In, Out>(hook: (input: In) => Out, initial: In) {
  const seen: Out[] = [];
  let update: (next: In) => void = () => undefined;
  function Probe({ input }: { input: In }) {
    seen.push(hook(input));
    return null;
  }
  function Harness() {
    const [input, setInput] = React.useState(initial);
    update = setInput;
    return React.createElement(Probe, { input });
  }
  const container = document.createElement("div");
  const root = createRoot(container);
  roots.push(root);
  act(() => root.render(React.createElement(Harness)));
  return { seen, update: (next: In) => act(() => update(next)) };
}

describe("holding message identity across polls", () => {
  it("keeps every entry object when a poll returns the same thread", () => {
    const entries = [said("Hello"), entry({ content: "Hi" })];
    const { seen, update } = renderHook(useStableEntries, entries);

    update(entries.map((item) => ({ ...item })));

    expect(seen.at(-1)).toBe(seen[0]);
  });

  it("replaces only the entry a poll actually changed", () => {
    const open = entry({ role: "tool", content: "ls", tool: run() });
    const reply = entry({ content: "Listing." });
    const { seen, update } = renderHook(useStableEntries, [reply, open]);
    const first = seen[0]!;

    update([{ ...reply }, { ...open, tool: run({ status: "ok" }) }]);
    const next = seen.at(-1)!;

    expect(next[0]).toBe(first[0]);
    expect(next[1]).not.toBe(first[1]);
  });

  it("notices a message whose files were replaced by the stored ones", () => {
    // A pending send names files with local `pending-` ids; the saved projection replaces them with
    // fetchable ones. If identity did not move, the thread would keep showing the local chips.
    const pending = entry({
      role: "user",
      content: "Look at this",
      author_id: "user-1",
      attachments: [{
        id: "pending-1-0",
        kind: "user_upload" as const,
        content_type: "image/png" as const,
        byte_size: 12,
        filename: "chart.png",
        position: 0,
        availability: "available" as const,
        expires_at: null,
      }],
    });
    const { seen, update } = renderHook(useStableEntries, [pending]);
    const first = seen[0]![0]!;

    update([{
      ...pending,
      attachments: [{ ...pending.attachments[0]!, id: "7c1f0b52-8a2e-4c3d-9f10-0b1c2d3e4f50" }],
    }]);

    expect(seen.at(-1)![0]).not.toBe(first);
  });

  it("keeps a message whose files did not move", () => {
    const sent = entry({
      role: "user",
      content: "Look at this",
      author_id: "user-1",
      attachments: [{
        id: "7c1f0b52-8a2e-4c3d-9f10-0b1c2d3e4f50",
        kind: "user_upload" as const,
        content_type: "image/png" as const,
        byte_size: 12,
        filename: "chart.png",
        position: 0,
        availability: "available" as const,
        expires_at: "2026-09-11T12:00:00.000Z",
      }],
    });
    const { seen, update } = renderHook(useStableEntries, [sent]);
    const first = seen[0]![0]!;

    update([{ ...sent, attachments: [{ ...sent.attachments[0]! }] }]);

    expect(seen.at(-1)![0]).toBe(first);
  });

  it("notices a follow-up that left the queue", () => {
    const waiting = said("Then this", {
      queued: true,
      turn_id: "22222222-2222-4222-8222-222222222222",
    });
    const { seen, update } = renderHook(useStableEntries, [waiting]);
    const first = seen[0]![0]!;

    update([{ ...waiting, queued: false }]);

    expect(seen.at(-1)![0]).not.toBe(first);
  });

  it("notices a reply that gained its reasoning", () => {
    const reply = entry({ content: "Two timed out." });
    const { seen, update } = renderHook(useStableEntries, [reply]);

    update([{ ...reply, reasoning: "checked the logs" }]);

    expect(seen.at(-1)![0]).not.toBe(seen[0]![0]);
  });

  it("notices a server-projected routine notify group", () => {
    const reply = entry({ content: "Latest." });
    const { seen, update } = renderHook(useStableEntries, [reply]);

    update([{
      ...reply,
      routine_notify_group: {
        routine_name: "Skills Hub",
        total_count: 2,
        hidden_entries: [entry({ event_id: "routine-return:older", content: "Older." })],
      },
    }]);

    expect(seen.at(-1)![0]).not.toBe(seen[0]![0]);
  });

  it("keeps a turn's group while another turn changes around it", () => {
    const older = [said("First"), entry({ content: "Answered." }), said("Second")];
    const open = entry({ role: "tool", content: "ls", tool: run() });
    const groups = (tool: CompanionToolRun) =>
      groupTranscriptEntries([...older, { ...open, tool }], context);
    const { seen, update } = renderHook(useStableGroups, groups(run()));
    const first = seen[0]!;

    update(groups(run({ status: "ok" })));
    const next = seen.at(-1)!;

    expect(next).toHaveLength(4);
    expect(next[0]).toBe(first[0]);
    expect(next[1]).toBe(first[1]);
    expect(next[2]).toBe(first[2]);
    expect(next[3]).not.toBe(first[3]);
  });

  it("keeps a turn's id as the turn grows, so it is extended rather than replaced", () => {
    const reply = entry({ content: "Working." });
    const tool = entry({ role: "tool", content: "ls", tool: run() });
    const before = groupTranscriptEntries([reply], context);
    const after = groupTranscriptEntries([reply, tool], context);

    expect(after[0]!.id).toBe(before[0]!.id);
    // The group is genuinely new, because it now carries a second entry.
    const { seen, update } = renderHook(useStableGroups, before);
    update(after);
    expect(seen.at(-1)![0]).not.toBe(seen[0]![0]);
  });

  it("replaces an optimistic message with the stored entry under the same id", () => {
    const optimistic = said("Ship it", { event_id: "msg:abc", author_name: null });
    const stored = { ...optimistic, author_name: "Ada", ordinal: 7 };

    expect(groupTranscriptEntries([stored], context)[0]!.id)
      .toBe(groupTranscriptEntries([optimistic], { ...context, sendingEventId: "msg:abc" })[0]!.id);
  });
});
