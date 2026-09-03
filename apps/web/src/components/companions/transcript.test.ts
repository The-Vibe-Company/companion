import type { CompanionThread, CompanionTranscriptEntry } from "@companion/contracts";
import { describe, expect, it } from "vitest";
import {
  composerHint,
  localDay,
  replyExpected,
  transcriptAuthor,
  transcriptDisplayContent,
  utcDay,
} from "./transcript";

const companionId = "11111111-1111-4111-8111-111111111111";
const turnId = "22222222-2222-4222-8222-222222222222";
const now = "2026-08-12T12:00:00.000Z";

function entry(overrides: Partial<CompanionTranscriptEntry> = {}): CompanionTranscriptEntry {
  return {
    event_id: "msg:1",
    ordinal: 0,
    role: "user",
    content: "Draft the launch note",
    author_id: "user-1",
    author_name: "Ada",
    tool: null,
    decision: null,
    attachments: [],
    reasoning: null,
    routine: null,
    trigger: null,
    turn_id: null,
    queued: false,
    created_at: now,
    ...overrides,
  };
}

function thread(overrides: Partial<CompanionThread> = {}): CompanionThread {
  return {
    companion_id: companionId,
    viewer_id: "user-1",
    access: "owner",
    read_only: false,
    can_send: true,
    entries: [],
    last_message_at: null,
    last_read_ordinal: null,
    ...overrides,
    // Zod's refined input type permits `undefined`; API responses do not.
    active_turn: overrides.active_turn ?? null,
    queued_count: overrides.queued_count ?? 0,
    interrupted_turn: overrides.interrupted_turn ?? null,
  };
}

function activeTurn(
  status: "admitted" | "running" | "needs_input",
  replying = false,
): NonNullable<CompanionThread["active_turn"]> {
  return {
    id: turnId,
    companion_id: companionId,
    client_message_id: "44444444-4444-4444-8444-444444444444",
    status,
    queue_sequence: 1,
    admission_state: "accepted",
    admitted_at: now,
    replying,
    error: null,
    state_changed_at: now,
    settled_at: null,
    created_at: now,
    updated_at: now,
  };
}

function interruptedTurn(): NonNullable<CompanionThread["interrupted_turn"]> {
  return {
    id: turnId,
    companion_id: companionId,
    client_message_id: "44444444-4444-4444-8444-444444444444",
    status: "interrupted",
    queue_sequence: 1,
    replying: false,
    error: {
      code: "dispatch_ambiguous",
      message: "Pi acknowledgement was not confirmed.",
      action: "retry",
    },
    state_changed_at: now,
    settled_at: now,
    created_at: now,
    updated_at: now,
  };
}

function queuedTurn(externalMessage?: string): NonNullable<CompanionThread["queued_turn"]> {
  return {
    id: turnId,
    companion_id: companionId,
    client_message_id: "44444444-4444-4444-8444-444444444444",
    status: "queued",
    queue_sequence: 1,
    admission_state: "pending",
    admitted_at: null,
    replying: false,
    error: null,
    external_block: externalMessage ? {
      classification: "model",
      source: "main",
      message: externalMessage,
    } : null,
    state_changed_at: now,
    settled_at: null,
    created_at: now,
    updated_at: now,
  };
}

describe("transcriptDisplayContent", () => {
  it.each([
    ["Pi ended the turn without a visible reply.", "Luna ended the turn without a visible reply."],
    ["Pi ended the turn without a reply (error).", "Luna ended the turn without a reply (error)."],
    ["Pi ended the turn without a reply (aborted).", "Luna ended the turn without a reply (aborted)."],
    ["Pi did not accept the message: unavailable", "Luna did not accept the message: unavailable"],
  ])("names the Companion in a system note: %s", (content, expected) => {
    expect(transcriptDisplayContent(entry({ role: "system", content }), "Luna")).toBe(expected);
  });

  it("only replaces Pi as a standalone name", () => {
    expect(transcriptDisplayContent(
      entry({
        role: "system",
        content: "Pi stopped; pi.dev, Pipedream, Piñata, and αPi stayed available.",
      }),
      "Luna",
    )).toBe("Luna stopped; pi.dev, Pipedream, Piñata, and αPi stayed available.");
  });

  it("keeps the context-loss disclosure in the Companion's own assistant message", () => {
    const disclosure = "I may have forgotten part of our earlier conversation while recovering.";
    expect(transcriptDisplayContent(entry({ role: "assistant", content: disclosure }), "Luna"))
      .toBe(disclosure);
    expect(transcriptAuthor(entry({ role: "assistant", content: disclosure }), "user-1", "Luna"))
      .toBe("Luna");
  });

  it.each(["user", "assistant", "tool", "decision"] as const)(
    "keeps %s content literal",
    (role) => {
      expect(transcriptDisplayContent(entry({ role, content: "Pi stayed literal." }), "Luna"))
        .toBe("Pi stayed literal.");
    },
  );

  it("inserts a Companion name literally", () => {
    expect(transcriptDisplayContent(entry({ role: "system", content: "Pi stopped." }), "$& Atlas"))
      .toBe("$& Atlas stopped.");
  });
});

describe("transcriptAuthor", () => {
  it("credits the reader's own message to them and a teammate's to its author", () => {
    expect(transcriptAuthor(entry(), "user-1", "Luna")).toBe("You");
    expect(transcriptAuthor(entry(), "user-9", "Luna")).toBe("Ada");
  });

  it("falls back to Member when a shared thread lost the author's name", () => {
    expect(transcriptAuthor(entry({ author_name: null }), "user-9", "Luna")).toBe("Member");
  });

  it("credits a reply to the Companion and leaves run notes unattributed", () => {
    expect(transcriptAuthor(entry({ role: "assistant" }), "user-1", "Luna")).toBe("Luna");
    expect(transcriptAuthor(entry({ role: "system" }), "user-1", "Luna")).toBeNull();
    expect(transcriptAuthor(entry({ role: "decision" }), "user-1", "Luna")).toBeNull();
  });
});

describe("transcript day keys", () => {
  it("names a day the same way whatever clock produced the key", () => {
    expect(utcDay("2026-08-14T23:30:00.000Z")).toBe("2026-08-14");
    expect(localDay("2026-08-14T23:30:00.000Z")).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("replyExpected", () => {
  it("shows replying only from the durable ACKed active-turn projection", () => {
    expect(replyExpected(thread({ active_turn: activeTurn("running", true) }))).toBe(true);
    expect(replyExpected(thread({
      entries: [entry({ role: "assistant" })],
      active_turn: activeTurn("running", true),
    }))).toBe(true);
  });

  it("never infers replying from transcript shape or runtime lifecycle", () => {
    expect(replyExpected(thread({ entries: [entry()] }))).toBe(false);
    expect(replyExpected(thread({ active_turn: activeTurn("admitted") }))).toBe(false);
    expect(replyExpected(null)).toBe(false);
  });

  it("shows replying only for the server-projected positive Pi admission", () => {
    expect(replyExpected(thread({ active_turn: activeTurn("running", true) }))).toBe(true);
    expect(replyExpected(thread({ active_turn: activeTurn("needs_input", false) }))).toBe(false);
    expect(replyExpected(thread({ active_turn: null }))).toBe(false);
  });
});

describe("composerHint", () => {
  it("explains the keys while no durable work is waiting", () => {
    expect(composerHint({ thread: thread(), companionName: "Luna", state: "running" }))
      .toBe("Enter sends. Shift + Enter starts a new line.");
  });

  it("describes active and later ordered turns", () => {
    expect(composerHint({
      thread: thread({ active_turn: activeTurn("admitted"), queued_count: 2 }),
      companionName: "Luna",
      state: "provisioning",
    })).toBe("Luna is starting this turn. 2 later messages are queued.");
    expect(composerHint({
      thread: thread({ active_turn: activeTurn("needs_input"), queued_count: 1 }),
      companionName: "Luna",
      state: "running",
    })).toBe("Answer the request above to continue this turn. 1 later message is queued.");
  });

  it("explains that interruption is terminal while later work stays queued", () => {
    expect(composerHint({
      thread: thread({ interrupted_turn: interruptedTurn(), queued_count: 2 }),
      companionName: "Luna",
      state: "running",
    })).toBe(
      "The interrupted occurrence is terminal and will not be replayed; later work continues automatically."
      + " 2 messages are saved and queued.",
    );
  });

  it("reports saved queued work and lifecycle-only changes without suggesting a retry send", () => {
    expect(composerHint({
      thread: thread({ queued_count: 1 }),
      companionName: "Luna",
      state: "stopped",
    })).toBe("1 message is saved and queued.");
    expect(composerHint({ thread: thread(), companionName: "Luna", state: "stopping" }))
      .toBe("A runtime change is in progress. Messages remain durable and ordered.");
  });

  it("uses durable wake progress without a countdown or ETA", () => {
    expect(composerHint({
      thread: thread({
        queued_count: 1,
        queued_turn: queuedTurn(),
        preparation: { state: "cold", taking_longer_than_expected: false },
      }),
      companionName: "Luna",
      state: "not_created",
    })).toBe("Je me réveille. 1 message is saved and queued.");
    expect(composerHint({
      thread: thread({
        queued_count: 2,
        queued_turn: queuedTurn(),
        preparation: { state: "repairing", taking_longer_than_expected: true },
      }),
      companionName: "Luna",
      state: "running",
    })).toBe("Ça prend plus de temps que prévu. 2 messages are saved and queued.");
  });

  it("surfaces the aggregate external block and keeps background work non-blocking", () => {
    expect(composerHint({
      thread: thread({ queued_count: 1, queued_turn: queuedTurn("The selected model is unavailable.") }),
      companionName: "Luna",
      state: "error",
    })).toBe("External service issue: The selected model is unavailable. 1 message is saved and queued.");
    expect(composerHint({
      thread: thread({ background_busy: true }),
      companionName: "Luna",
      state: "running",
    })).toBe("Background work is running. You can keep messaging.");
  });
});
