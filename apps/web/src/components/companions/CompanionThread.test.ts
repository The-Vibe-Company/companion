import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Companion, CompanionThread as Thread } from "@companion/contracts";
import { describe, expect, it } from "vitest";
import { CompanionThread, type CompanionContextPanel } from "./CompanionThread";

const companionId = "11111111-1111-4111-8111-111111111111";
const turnId = "22222222-2222-4222-8222-222222222222";
const now = "2026-08-12T12:01:00.000Z";

function activeTurn(
  status: "admitted" | "running" | "needs_input",
  replying = false,
): NonNullable<Thread["active_turn"]> {
  return {
    id: turnId,
    companion_id: companionId,
    client_message_id: "33333333-3333-4333-8333-333333333333",
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

function interruptedTurn(): NonNullable<Thread["interrupted_turn"]> {
  return {
    id: turnId,
    companion_id: companionId,
    client_message_id: "33333333-3333-4333-8333-333333333333",
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

function companion(overrides: Partial<Companion> = {}): Companion {
  return {
    id: companionId,
    name: "Luna",
    persona: "Content marketing assistant",
    model_id: "claude-opus-4-8",
    selected_skill_ids: [],
    can_write_skills: false,
    selected_mcp_account_ids: [],
    owner_id: "user-1",
    access: "owner",
    pinned: false,
    hidden: false,
    unread: false,
    last_message: null,
    runtime: {
      generation: 1,
      state: "running",
      daemon_state: "running",
      replying: false,
      box_id: "bx_23456789",
      provider_ids: ["anthropic"],
      provider_credential_generation: null,
      disk_layout_version: 2,
      desktop_available: false,
      last_error: null,
      skills_revision: 1,
      skills_applied_revision: 1,
      skills_applied_at: null,
      skills_last_error: null,
      last_observed_at: null,
      last_started_at: null,
      last_stopped_at: null,
      lifecycle_intent: "prepare",
    },
    created_at: "2026-08-12T12:00:00.000Z",
    updated_at: "2026-08-12T12:00:00.000Z",
    ...overrides,
  };
}

function thread(overrides: Partial<Thread> = {}): Thread {
  return {
    companion_id: companionId,
    viewer_id: "user-1",
    access: "owner",
    read_only: false,
    can_send: true,
    entries: [
      {
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
        created_at: "2026-08-12T12:01:00.000Z",
      },
      {
        event_id: "pi:0",
        ordinal: 1,
        role: "assistant",
        content: "Here is a first pass at the launch note.",
        author_id: null,
        author_name: null,
        tool: null,
    decision: null,
    attachments: [],
        reasoning: null,
        routine: null,
        trigger: null,
        turn_id: null,
        queued: false,
        created_at: "2026-08-12T12:01:20.000Z",
      },
    ],
    last_message_at: "2026-08-12T12:01:20.000Z",
    last_read_ordinal: null,
    ...overrides,
    active_turn: overrides.active_turn ?? null,
    queued_count: overrides.queued_count ?? 0,
    interrupted_turn: overrides.interrupted_turn ?? null,
  };
}

/** A closed context panel: what these cases render unless one asks for it open. */
function contextPanel(overrides: Partial<CompanionContextPanel> = {}): CompanionContextPanel {
  return {
    open: false,
    desktop: null,
    joining: false,
    error: null,
    onToggle: () => {},
    onJoin: () => {},
    ...overrides,
  };
}

function render(props: {
  companion?: Companion;
  thread?: Thread | null;
  error?: string | null;
  busy?: boolean;
  openingDesktop?: boolean;
  context?: Partial<CompanionContextPanel>;
  lastReadOrdinal?: number | null;
}) {
  return renderToStaticMarkup(React.createElement(CompanionThread, {
    companion: props.companion ?? companion(),
    thread: props.thread === undefined ? thread() : props.thread,
    error: props.error ?? null,
    busy: props.busy ?? false,
    openingDesktop: props.openingDesktop ?? false,
    context: contextPanel(props.context),
    contextSkills: [],
    lastReadOrdinal: props.lastReadOrdinal ?? null,
    onBack: () => {},
    orgId: "org-1",
    onSend: async () => true,
    onSettings: () => {},
    onThread: () => {},
    onDesktop: () => {},
    onCancelTurn: async () => {},
  }));
}

/** What the header reads once the markup is taken out, which is where the chip's state word lives. */
function text(markup: string): string {
  return markup.replace(/<[^>]*>/g, "");
}

/**
 * The markup with only the parts nobody can perceive taken out. Class names and data attributes are
 * the component library talking to itself — one of them says `tooltip` — but an `aria-label`, an
 * `alt`, or a `title` is something a screen-reader user is read out loud, so it stays in scope for
 * any assertion about what this surface offers.
 */
function perceivable(markup: string): string {
  return markup
    .replace(/\s(?:class|style)="[^"]*"/g, "")
    .replace(/\sdata-[\w-]+="[^"]*"/g, "");
}

/** What the chip reports about the compute, which is its accessible name rather than its text. */
function chipLabel(markup: string): string {
  return markup.match(/aria-label="(Box · [^"]*)"/)?.[1] ?? "";
}

const asleep = companion({
  runtime: { ...companion().runtime, state: "stopped", daemon_state: "stopped", box_id: null },
});

const viewerThread = thread({
  viewer_id: "user-9",
  access: "viewer",
  read_only: true,
  can_send: false,
});

describe("CompanionThread", () => {
  it("renders one Companion's conversation with a composer for a runner", () => {
    const markup = render({});

    expect(markup).toContain("Chat with Luna");
    expect(markup).toContain("Draft the launch note");
    expect(markup).toContain("Here is a first pass at the launch note.");
    expect(markup).toContain("Message Luna");
    expect(text(markup)).toContain("Online");
    // The word is what is shown; the compute it reports stays in the accessible name.
    expect(chipLabel(markup)).toContain("Box · online");
  });

  it("keeps runtime tools and Skills out of the thread surface", () => {
    const markup = render({
      thread: thread({
        entries: [
          ...thread().entries,
          {
            event_id: "pi:512",
            ordinal: 2,
            role: "system",
            content: "The run stopped before Pi replied.",
            author_id: null,
            author_name: null,
            tool: null,
    decision: null,
    attachments: [],
            reasoning: null,
            routine: null,
            trigger: null,
            turn_id: null,
            queued: false,
            created_at: "2026-08-12T12:02:00.000Z",
          },
        ],
      }),
    });

    // A note speaks about the Companion whose thread this is, not about Pi's runtime name.
    expect(markup).toContain("The run stopped before Luna replied.");
    expect(markup).not.toContain("The run stopped before Pi replied.");
    // Read from everything a person can perceive — text and accessible names both. Only the class
    // names and data attributes are dropped, because that is the component library talking to
    // itself, and one of them says `tooltip` without offering anyone a Pi tool.
    expect(perceivable(markup)).not.toMatch(/tool|skill|mcp/i);
    // Computer use is the Box desktop and nothing else, reached from the one status chip.
    expect(markup.match(/open the Box desktop/g)).toHaveLength(1);
  });

  it("gives a Viewer the read model without a composer or a wake control", () => {
    const markup = render({
      companion: companion({ ...asleep, access: "viewer" }),
      thread: viewerThread,
    });

    expect(markup).toContain("Draft the launch note");
    expect(markup).toContain("Viewer access is read-only");
    expect(markup).not.toContain("Message Luna");
    expect(markup).not.toContain(">Wake<");
  });

  it("shows a Viewer the Box status as a read-only chip that cannot open a desktop", () => {
    const markup = render({
      companion: companion({ access: "viewer", runtime: { ...companion().runtime, box_id: null } }),
      thread: viewerThread,
    });

    expect(text(markup)).toContain("Online");
    expect(chipLabel(markup)).toBe("Box · online");
    expect(markup).not.toContain("open the Box desktop");
    expect(markup).not.toContain(">Wake<");
  });

  it("offers the Box desktop from the chip only while a runner's Box is already running", () => {
    const running = render({});

    expect(text(running)).toContain("Online");
    expect(running).toContain("open the Box desktop");
    // An asleep Box has no desktop, so the chip stays a status read instead of becoming a start.
    expect(text(render({ companion: asleep }))).toContain("Asleep");
    expect(chipLabel(render({ companion: asleep }))).toBe("Box · asleep");
    expect(render({ companion: asleep })).not.toContain("open the Box desktop");
  });

  it("reports an in-flight desktop handoff on the chip that started it", () => {
    const markup = render({ openingDesktop: true });

    expect(text(markup)).toContain("Opening desktop");
    expect(markup).toContain("disabled");
  });

  it("credits a teammate's message to its author instead of the reader", () => {
    const shared = thread({ viewer_id: "user-9" });

    expect(render({ thread: shared })).toContain(">Ada<");
    expect(render({ thread: shared })).not.toContain(">You<");
    // The reader's own message still reads as their own.
    expect(render({ thread: thread() })).toContain(">You<");
  });

  it("never offers a wake control because sending starts an asleep Companion", () => {
    expect(render({ companion: asleep })).not.toContain(">Wake<");
    expect(render({})).not.toContain(">Wake<");
  });

  it("reports durable queued messages without offering a wake", () => {
    const markup = render({ companion: asleep, thread: thread({ queued_count: 2 }) });

    expect(markup).toContain("2 messages are saved and queued.");
    expect(markup).not.toContain(">Wake<");
  });

  it("keeps the authorized composer available throughout durable cold preparation", () => {
    const markup = render({
      companion: asleep,
      thread: thread({
        queued_count: 1,
        preparation: { state: "cold", taking_longer_than_expected: false },
      }),
    });

    expect(markup).toContain("Je me réveille");
    expect(markup).toContain("Message Luna");
    expect(markup).not.toContain("Retry");
    expect(markup).not.toContain(">Wake<");
  });

  it("reports an active turn from its durable state", () => {
    const waiting = thread({ active_turn: activeTurn("running", true) });
    const running = render({ thread: waiting });

    expect(running).toContain("Luna is working on this turn.");
    // The sentence a reader gets is unchanged; the name merely moved into its own emphasized span,
    // so the durable ACK fact is read as text rather than as one literal text node.
    expect(text(running)).toContain("Luna is replying...");
    // The trailer itself is the thinking blob, not a spinner: same slot, animated bot beside it.
    expect(running).toMatch(
      /data-slot="companion-replying"[^>]*><svg class="companion-icon companion-icon--thinking" width="16"/,
    );
    // The header avatar animates on exactly the same durable signal as the trailer.
    expect(running).toMatch(
      /chat-avatar" aria-hidden="true"><svg class="companion-icon companion-icon--thinking"/,
    );

    const starting = render({
      companion: companion({
        runtime: { ...companion().runtime, state: "provisioning", daemon_state: "starting" },
      }),
      thread: thread({ active_turn: activeTurn("admitted") }),
    });

    expect(text(starting)).toContain("Starting");
    expect(starting).toContain("Luna is starting this turn.");
    // Without a Pi-ACKed attempt the header avatar sits idle instead of pretending to think.
    expect(starting).toMatch(
      /chat-avatar" aria-hidden="true"><svg class="companion-icon companion-icon--idle"/,
    );
  });

  it("keeps a Viewer's footer read-only even while messages are waiting on a wake", () => {
    const markup = render({
      companion: companion({ ...asleep, access: "viewer" }),
      thread: thread({
        viewer_id: "user-9",
        access: "viewer",
        read_only: true,
        can_send: false,
      }),
    });

    expect(markup).toContain("Viewer access is read-only");
    expect(markup).not.toContain("retry delivery");
    expect(markup).not.toContain(">Wake<");
  });

  it("makes terminal continuation explicit without asking a runner to unblock it", () => {
    const markup = render({ thread: thread({ interrupted_turn: interruptedTurn() }) });

    expect(markup).toContain("Turn interrupted");
    expect(markup).toContain("Pi acknowledgement was not confirmed.");
    expect(markup).toContain("External actions may already have succeeded.");
    expect(markup).toContain("Automatic cleanup for this turn continues in the background");
    expect(markup).toContain("will not be replayed");
    expect(markup).toContain("automatically in order");
    expect(markup).not.toContain("Retry turn");
    expect(markup).not.toContain("Cancel turn");
  });

  it("shows the same non-blocking terminal history to a Viewer", () => {
    const markup = render({
      companion: companion({ access: "viewer" }),
      thread: thread({
        viewer_id: "user-9",
        access: "viewer",
        read_only: true,
        can_send: false,
        interrupted_turn: interruptedTurn(),
      }),
    });

    expect(markup).toContain("Automatic cleanup for this turn continues in the background");
    expect(markup).toContain("will not be replayed");
    expect(markup).toContain("automatically in order");
    expect(markup).not.toContain("Retry turn");
    expect(markup).not.toContain("Cancel turn");
  });

  it("explains an Error status to a runner with the reason the API recorded", () => {
    const markup = render({
      companion: companion({
        runtime: {
          ...companion().runtime,
          state: "error",
          daemon_state: "error",
          replying: false,
          last_error: "Box runtime is not configured; set COMPANION_BOX_API_KEY",
        },
      }),
    });

    expect(text(markup)).toContain("Error");
    expect(chipLabel(markup)).toBe("Box · error");
    expect(markup).toContain("Box runtime is not configured; set COMPANION_BOX_API_KEY");
  });

  it("gives a Viewer the generic unavailable line the API redacted for them", () => {
    const markup = render({
      companion: companion({
        access: "viewer",
        pinned: false,
        hidden: false,
        unread: false,
        runtime: {
          ...companion().runtime,
          state: "error",
          daemon_state: "error",
          replying: false,
          box_id: null,
          last_error: "This Companion is unavailable right now.",
        },
      }),
      thread: thread({ viewer_id: "user-9", access: "viewer", read_only: true, can_send: false }),
    });

    expect(markup).toContain("This Companion is unavailable right now.");
    expect(markup).not.toContain("COMPANION_BOX_API_KEY");
    expect(markup).not.toContain(">Wake<");
  });

  it("prefers the failure this request saw over the reason already on the row", () => {
    const markup = render({
      companion: companion({
        runtime: { ...companion().runtime, state: "error", last_error: "Box entered error state" },
      }),
      error: "Box did not become ready before the configured timeout",
    });

    expect(markup).toContain("Box did not become ready before the configured timeout");
    expect(markup).not.toContain("Box entered error state");
  });

  it("shows an empty thread as what to do next rather than a dead surface", () => {
    const markup = render({ thread: thread({ entries: [], last_message_at: null }) });

    expect(markup).toContain("No messages yet");
    expect(markup).toContain("Send a message to start Luna and get a reply.");
  });

  it("announces the wait while the transcript is still loading", () => {
    const markup = render({ thread: null });

    // The skeleton lines are decorative, so the wait needs its own announcement or a reader is told
    // nothing at all until the conversation arrives.
    expect(markup).toContain("Loading conversation...");
    expect(markup).toContain('aria-busy="true"');
  });

  it("keys every turn to its transcript entry so a re-read updates in place", () => {
    const markup = render({});

    // The primitives render one message per entry under the entry's own id, so the two-second thread
    // re-read reconciles the turns that already exist instead of replacing the conversation.
    expect(markup).toContain('data-message-id="msg:1"');
    expect(markup).toContain('data-message-id="pi:0"');
  });

  it("names a writer once per passage instead of on every line", () => {
    const markup = render({
      thread: thread({
        entries: [
          {
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
            created_at: "2026-08-12T12:01:00.000Z",
          },
          {
            event_id: "msg:2",
            ordinal: 1,
            role: "user",
            content: "Keep it under 200 words",
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
            created_at: "2026-08-12T12:01:30.000Z",
          },
        ],
      }),
    });

    expect(markup).toContain("Draft the launch note");
    expect(markup).toContain("Keep it under 200 words");
    expect(markup.match(/>You</g)).toHaveLength(1);
  });

  it("re-announces a writer once the conversation has moved on", () => {
    const markup = render({
      thread: thread({
        entries: [
          ...thread().entries,
          {
            event_id: "msg:9",
            ordinal: 2,
            role: "user",
            content: "One more thing",
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
            created_at: "2026-08-12T12:40:00.000Z",
          },
        ],
      }),
    });

    // Two passages from the reader: the first message and the one that reopens the thread.
    expect(markup.match(/>You</g)).toHaveLength(2);
  });

  it("shows a turn that only produced reasoning as the reply it is", () => {
    const markup = render({
      thread: thread({
        entries: [
          {
            event_id: "pi:184",
            ordinal: 0,
            role: "assistant",
            content: "Checking the changelog before answering.",
            author_id: null,
            author_name: null,
            tool: null,
    decision: null,
    attachments: [],
            reasoning: null,
            routine: null,
            trigger: null,
            turn_id: null,
            queued: false,
            created_at: "2026-08-12T12:01:20.000Z",
          },
        ],
      }),
    });

    expect(markup).toContain("Checking the changelog before answering.");
  });

  it("shows replying only for a durably acknowledged running attempt", () => {
    const awaiting = thread({
      entries: [thread().entries[0]!],
      active_turn: activeTurn("running", true),
    });

    expect(render({ thread: awaiting })).toContain("is replying...");
    // Box state and transcript shape do not override the durable ACK fact.
    expect(render({ companion: asleep, thread: awaiting })).toContain("is replying...");
    expect(render({ thread: thread({ active_turn: activeTurn("admitted") }) }))
      .not.toContain("is replying...");
    expect(render({})).not.toContain("is replying...");
  });

  it("renders a pending shell permission card with Allow / Deny for Owner/Editor", () => {
    const markup = render({
      thread: thread({
        entries: [
          ...thread().entries,
          {
            event_id: "decision:ui-shell",
            ordinal: 2,
            role: "decision",
            content: "Allow shell: bash",
            author_id: null,
            author_name: null,
            tool: null,
            decision: {
              request_id: "ui-shell",
              kind: "shell",
              name: "bash",
              title: "ls -la",
              detail: null,
              status: "pending",
              answer: null,
              decided_by_id: null,
              decided_by_name: null,
              decided_at: null,
              expires_at: "2026-08-12T12:10:00.000Z",
              proposal: null,
            },
            attachments: [],
            reasoning: null,
            routine: null,
            trigger: null,
            turn_id: null,
            queued: false,
            created_at: "2026-08-12T12:05:00.000Z",
          },
        ],
      }),
    });

    expect(markup).toMatch(/data-slot="companion-decision"[^>]*aria-busy="true"/);
    expect(markup).toContain("Allow run a command");
    expect(markup).toContain("ls -la");
    expect(markup).toContain(">Allow<");
    expect(markup).toContain(">Deny<");
  });

  it("shows a resolved permission card without controls, and keeps Viewers from acting on pending ones", () => {
    const resolved = render({
      thread: thread({
        entries: [
          {
            event_id: "decision:ui-file",
            ordinal: 0,
            role: "decision",
            content: "Allow file: write",
            author_id: null,
            author_name: null,
            tool: null,
            decision: {
              request_id: "ui-file",
              kind: "file",
              name: "write",
              title: "notes.md",
              detail: null,
              status: "allowed",
              answer: null,
              decided_by_id: "user-1",
              decided_by_name: "Ada",
              decided_at: "2026-08-12T12:05:30.000Z",
              expires_at: "2026-08-12T12:10:00.000Z",
              proposal: null,
            },
            attachments: [],
            reasoning: null,
            routine: null,
            trigger: null,
            turn_id: null,
            queued: false,
            created_at: "2026-08-12T12:05:00.000Z",
          },
        ],
      }),
    });
    expect(resolved).toContain('data-slot="companion-decision"');
    expect(resolved).not.toContain('aria-busy="true"');
    expect(resolved).toContain("allowed by Ada");
    expect(resolved).not.toContain(">Allow<");
    expect(resolved).not.toContain(">Deny<");

    const viewerPending = render({
      companion: companion({ access: "viewer" }),
      thread: thread({
        access: "viewer",
        read_only: true,
        can_send: false,
        entries: [
          {
            event_id: "decision:ui-q",
            ordinal: 0,
            role: "decision",
            content: "Question: ask_user",
            author_id: null,
            author_name: null,
            tool: null,
            decision: {
              request_id: "ui-q",
              kind: "question",
              name: "ask_user",
              title: "Ship tonight?",
              detail: null,
              status: "pending",
              answer: null,
              decided_by_id: null,
              decided_by_name: null,
              decided_at: null,
              expires_at: "2026-08-12T12:10:00.000Z",
              proposal: null,
            },
            attachments: [],
            reasoning: null,
            routine: null,
            trigger: null,
            turn_id: null,
            queued: false,
            created_at: "2026-08-12T12:05:00.000Z",
          },
        ],
      }),
    });
    expect(viewerPending).toContain("Ship tonight?");
    expect(viewerPending).toContain("Waiting for an Owner or Editor");
    expect(viewerPending).not.toContain(">Allow<");
    expect(viewerPending).not.toContain(">Answer<");
    expect(viewerPending).not.toContain(">Deny<");
  });
});

describe("CompanionThread separators", () => {
  it("parts the transcript by day, once per day the thread was written in", () => {
    const markup = render({
      thread: thread({
        entries: [
          {
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
            created_at: "2026-08-12T12:00:00.000Z",
          },
          {
            event_id: "pi:1",
            ordinal: 1,
            role: "assistant",
            content: "Here it is.",
            author_id: null,
            author_name: null,
            tool: null,
            decision: null,
            attachments: [],
            reasoning: null,
            routine: null,
            trigger: null,
            turn_id: null,
            queued: false,
            created_at: "2026-08-14T09:00:00.000Z",
          },
        ],
      }),
    });

    // Server markup carries the stable stored day; the reader's clock reformats it on the client.
    expect(markup).toContain('<time dateTime="2026-08-12">2026-08-12</time>');
    expect(markup).toContain('<time dateTime="2026-08-14">2026-08-14</time>');
    expect(markup.match(/data-slot="chat-day-separator"/g)).toHaveLength(2);
  });

  it("marks where a returning reader left off, and leaves a caught-up thread whole", () => {
    const entries = thread().entries;

    // The reader had read up to their own message; the reply after it is where they left off.
    const returning = render({ lastReadOrdinal: 0, thread: thread({ entries }) });
    expect(returning).toContain('data-slot="chat-new-separator"');
    expect(returning).toContain(">New<");

    // Nothing has been said since this reader was last here, so there is nothing to divide.
    expect(render({ lastReadOrdinal: 1, thread: thread({ entries }) }))
      .not.toContain('data-slot="chat-new-separator"');
    // Neither is a first visit, which has no watermark to return to.
    expect(render({ thread: thread({ entries }) }))
      .not.toContain('data-slot="chat-new-separator"');
  });
});
