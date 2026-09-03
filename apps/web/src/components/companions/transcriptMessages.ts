import { useMemo, useRef } from "react";
import type {
  CompanionAttachment,
  CompanionDecision,
  CompanionToolRun,
  CompanionTranscriptEntry,
} from "@companion/contracts";
import type { ThreadMessageLike } from "@assistant-ui/react";
import { transcriptAuthor, transcriptDisplayContent, utcDay } from "./transcript";

/**
 * The transcript is a flat log of entries — a message, a reply, a tool run, a permission card — and
 * a chat is a column of messages. This module is the translation between them, and it is pure: it
 * takes the control-plane read model and returns what the thread renders, with no React state, no
 * fetching, and no knowledge of how any of it looks.
 *
 * The shape it produces is the one assistant-ui already understands. A turn Pi took is one assistant
 * message whose parts are its reasoning, its reply, and every run and card it produced along the way,
 * in the order they happened — so a turn reads as one thing that happened rather than as five
 * messages from the same speaker, and the hover action bar, the copy, and the message spacing all
 * belong to the turn instead of to its pieces.
 */

/** The tool names the thread registers UIs for. Neither is a tool anyone can call — see below. */
export const COMPANION_TOOL_NAME = "companion_tool";
export const COMPANION_DECISION_TOOL_NAME = "companion_decision";

/** Product-owned copy for an expurgated terminal model failure. No provider detail reaches here. */
export const MODEL_UNAVAILABLE_MESSAGE =
  "The selected model is unavailable. Choose a different model and try again.";

/**
 * How long a writer keeps the floor. Consecutive messages from the same writer inside this window
 * read as one passage, so the transcript names the writer and the clock once per passage instead of
 * repeating both on every line.
 */
const PASSAGE_WINDOW_MS = 15 * 60 * 1000;

/** One rendered message: a member's message, a Pi turn, or a note about the run. */
export interface TranscriptMessage {
  /**
   * The first source entry's event id. A turn's group keeps this id as the turn grows, so the
   * runtime sees one message being extended rather than a new message per projected entry — and an
   * optimistic send keeps the id the control plane will store it under, so the saved entry replaces
   * it instead of joining it.
   */
  id: string;
  role: "user" | "assistant" | "system";
  /** Who wrote it, as it is shown: the reader is "You", Pi is the Companion, a note is neither. */
  author: string | null;
  /** True when this message opens a passage, so it carries the writer and the time. */
  lead: boolean;
  /** True while the control plane has not confirmed this message yet. */
  sending: boolean;
  /** True while this user message is saved and ordered behind other work. */
  queued: boolean;
  /** The durable turn this user message created, when the control plane has named it. */
  turnId: string | null;
  /** The first source entry's timestamp: when the passage this message may open began. */
  createdAt: string;
  /**
   * A note as the reader should see it. The control plane stores what Pi's runtime called itself,
   * but the transcript speaks about the Companion whose thread this is, and follows a rename. Null
   * on everything else: a reply and a tool run stay literal even when they mention Pi themselves.
   */
  displayContent: string | null;
  /**
   * The day this message opens, as `YYYY-MM-DD`, or null when it continues the day above it. Server
   * markup keys it on the stored UTC day so both renders agree; once the client owns the clock the
   * key is the reader's own day, so the separator and the times beneath it name the same date.
   */
  startsDay: string | null;
  /** True on the first message this reader has not caught up on, which is where "New" is drawn. */
  startsNew: boolean;
  /** The entries this message was built from, in transcript order. */
  entries: readonly CompanionTranscriptEntry[];
}

/** A system note that can offer the existing settings model picker as its recovery action. */
export function isModelUnavailableMessage(message: TranscriptMessage | undefined): boolean {
  return message?.role === "system" && message.displayContent === MODEL_UNAVAILABLE_MESSAGE;
}

export interface TranscriptGroupingContext {
  viewerId: string;
  companionName: string;
  /** The message this composer is still sending, named by the event id it will be stored under. */
  sendingEventId?: string | null;
  /**
   * This reader's own unread watermark as it stood when they opened the thread, from the control
   * plane rather than this device. The first message past it that somebody else wrote is where "New"
   * is drawn. Null leaves the thread undivided, which is what a first visit and a thread the reader
   * has caught up on both look like.
   */
  lastReadOrdinal?: number | null;
  /**
   * The highest ordinal the thread held when it was opened. The divider never moves past it, so a
   * reply arriving under the reader's eye does not get announced as something they missed.
   */
  openedThroughOrdinal?: number | null;
  /**
   * How a stored timestamp becomes the day it belongs to. Server markup uses the stored UTC day so
   * both renders agree; the client swaps in the reader's own calendar, because a separator that says
   * one date above a clock that says another is worse than no separator at all.
   */
  dayOf?: (iso: string) => string;
}

/** A tool run and a permission card ride into the thread as tool calls; this is what they carry. */
export interface CompanionToolArgs {
  run: CompanionToolRun;
}

export interface CompanionDecisionArgs {
  decision: CompanionDecision;
}

/** True for the entries a Pi turn is made of, which are the ones that group together. */
function partOfTurn(entry: CompanionTranscriptEntry): boolean {
  return entry.role === "assistant" || entry.role === "tool" || entry.role === "decision";
}

function millis(iso: string): number {
  const parsed = Date.parse(iso);
  return Number.isNaN(parsed) ? 0 : parsed;
}

/**
 * Group a transcript into messages.
 *
 * A member's message is its own message, and so is a note about the run — a refused send, a turn that
 * ended with nothing to show — because neither belongs to a turn. Everything Pi produced between two
 * such interruptions is one turn: a maximal run of replies, tool runs, and permission cards, however
 * they interleave.
 */
export function groupTranscriptEntries(
  entries: readonly CompanionTranscriptEntry[],
  context: TranscriptGroupingContext,
): TranscriptMessage[] {
  const groups: TranscriptMessage[] = [];
  let open: CompanionTranscriptEntry[] | null = null;

  const push = (
    role: TranscriptMessage["role"],
    grouped: readonly CompanionTranscriptEntry[],
  ) => {
    const first = grouped[0]!;
    groups.push({
      id: first.event_id,
      role,
      // The writer is the message's, not its first entry's: a turn that ran a tool before it said
      // anything is still the Companion speaking, and a note about the run is nobody speaking.
      author: role === "assistant"
        ? context.companionName
        : role === "system"
          ? null
          : transcriptAuthor(first, context.viewerId, context.companionName),
      // Filled in below, once every message's writer and clock are known.
      lead: true,
      sending: context.sendingEventId != null
        && grouped.some((entry) => entry.event_id === context.sendingEventId),
      queued: grouped.some((entry) => entry.queued),
      turnId: grouped.find((entry) => entry.turn_id)?.turn_id ?? null,
      createdAt: first.created_at,
      displayContent: role === "system"
        ? transcriptDisplayContent(first, context.companionName)
        : null,
      // Both filled in below, for the same reason `lead` is: they depend on the messages around it.
      startsDay: null,
      startsNew: false,
      entries: grouped,
    });
  };

  for (const entry of entries) {
    if (partOfTurn(entry)) {
      if (open) open.push(entry);
      else open = [entry];
      continue;
    }
    if (open) {
      push("assistant", open);
      open = null;
    }
    push(entry.role === "user" ? "user" : "system", [entry]);
  }
  if (open) push("assistant", open);

  let previous: { author: string | null; role: string; at: number } | null = null;
  // A day boundary and the new-message divider are drawn on what was said, not on what ran or on
  // what the control plane reported: a note about the run is chrome between two turns, so a
  // separator landing on one would cut a reply off from the turn it belongs to.
  let previousDay: string | null = null;
  let newDrawn = false;
  const dayOf = context.dayOf ?? utcDay;

  for (const group of groups) {
    const at = millis(group.createdAt);
    // A note has no writer, so it neither opens nor continues a passage: the writer before it is
    // re-announced after the interruption.
    group.lead = group.author === null
      || previous === null
      || previous.author !== group.author
      || previous.role !== group.role
      || at - previous.at > PASSAGE_WINDOW_MS;
    previous = { author: group.author, role: group.role, at };

    const said = group.role === "user" || group.role === "assistant";
    if (!said) continue;

    const day = dayOf(group.createdAt);
    group.startsDay = day === previousDay ? null : day;
    previousDay = day;

    const first = group.entries[0]!;
    const mine = group.role === "user" && first.author_id === context.viewerId;
    // The first entry inside this message the reader has not seen — not the message's own first
    // entry. A turn is one message however many entries it took, so a watermark can fall in the
    // middle of one; drawing on the turn that contains the boundary keeps the divider rather than
    // losing it, which is the whole point of coming back to a busy thread.
    const unread = context.lastReadOrdinal == null
      ? undefined
      : group.entries.find((entry) => entry.ordinal > context.lastReadOrdinal!);
    // "New" marks where reading stopped, not what has arrived since. A message that lands while the
    // reader is watching is not a backlog, so the divider is bounded to the transcript as it stood
    // when the thread was opened; past that it has already been drawn or was never needed.
    group.startsNew = !mine
      && !newDrawn
      && unread !== undefined
      && (context.openedThroughOrdinal == null || unread.ordinal <= context.openedThroughOrdinal);
    if (group.startsNew) newDrawn = true;
  }
  return groups;
}

type MessagePart = NonNullable<Exclude<ThreadMessageLike["content"], string>>[number];

function partsOf(entry: CompanionTranscriptEntry): MessagePart[] {
  if (entry.tool) {
    return [{
      type: "tool-call",
      // The transcript's own name for the run, not Pi's: an event id is unique inside a thread, so
      // two runs Pi happened to give the same call id still render as two cards.
      toolCallId: entry.event_id,
      toolName: COMPANION_TOOL_NAME,
      args: { run: entry.tool },
      // Empty on purpose. The runtime serialises `args` into a text copy when this is absent, and a
      // visual run's args carry a whole Box screenshot — up to 192 KB that would be stringified
      // again every time another entry joins the turn. Nothing reads the text copy.
      argsText: "",
      // A running chip has no result yet. Everything the card shows is read from the run in `args`,
      // because this thread polls rather than streams: a part is never mid-flight, it is simply the
      // run as the last poll saw it.
      result: entry.tool.status === "running" ? undefined : { status: entry.tool.status },
    }];
  }
  if (entry.decision) {
    return [{
      type: "tool-call",
      toolCallId: entry.event_id,
      toolName: COMPANION_DECISION_TOOL_NAME,
      args: { decision: entry.decision },
      argsText: "",
      result: entry.decision.status === "pending" ? undefined : { status: entry.decision.status },
    }];
  }
  const parts: MessagePart[] = [];
  // Reasoning comes before the reply it produced, which is the order it happened in and the order a
  // reader who opens the disclosure expects to read it. The role is checked here even though the
  // contract and a database constraint both already forbid reasoning anywhere else: the runtime
  // refuses a reasoning part on a member's message by throwing, and that throw would blank the whole
  // conversation rather than the one malformed line.
  if (entry.role === "assistant" && entry.reasoning) {
    parts.push({ type: "reasoning", text: entry.reasoning });
  }
  if (entry.content) parts.push({ type: "text", text: entry.content });
  return parts;
}

/**
 * The files one grouped message carries, in transcript order.
 *
 * They are deliberately not message parts. assistant-ui's user role accepts only text, image, audio,
 * file, and data parts, and the two shapes that could carry a file want its bytes inline — which is
 * exactly what a per-request authorized read route exists to avoid. So the thread renders them from
 * the entries themselves, in the frame around the message, which also keeps one component
 * responsible for both directions.
 */
export function attachmentsOf(group: TranscriptMessage): readonly CompanionAttachment[] {
  return group.entries.flatMap((entry) => entry.attachments);
}

/**
 * One grouped message as assistant-ui reads it. The empty-text fallback is there for a `system`
 * note, which the runtime refuses unless it carries exactly one text part; an assistant message
 * drops empty text again on its way in, and a turn with nothing to show cannot be projected anyway.
 */
export function toThreadMessageLike(group: TranscriptMessage): ThreadMessageLike {
  const content = group.displayContent === null
    ? group.entries.flatMap(partsOf)
    : [{ type: "text" as const, text: group.displayContent }];
  return {
    id: group.id,
    role: group.role,
    content: content.length ? content : [{ type: "text", text: "" }],
    createdAt: new Date(group.createdAt),
  };
}

/**
 * Keep one object per entry across polls. The thread is re-read every couple of seconds and arrives
 * as fresh JSON each time, so without this every message would look new to the runtime and the whole
 * transcript would re-render mid-conversation.
 *
 * The cache is written during render, which is only safe because the comparison below is total: it
 * names every field a poll can move, so a discarded render and a kept one reach the same answer.
 * Anything that starts changing after a row is stored has to be added to it.
 */
export function useStableEntries(
  entries: CompanionTranscriptEntry[],
): CompanionTranscriptEntry[] {
  const seen = useRef(new Map<string, CompanionTranscriptEntry>());
  const previous = useRef<CompanionTranscriptEntry[]>([]);
  return useMemo(() => {
    const next = new Map<string, CompanionTranscriptEntry>();
    const stable = entries.map((entry) => {
      const kept = seen.current.get(entry.event_id);
      const unchanged = kept
        && kept.role === entry.role
        && kept.content === entry.content
        && kept.reasoning === entry.reasoning
        && kept.author_id === entry.author_id
        && kept.author_name === entry.author_name
        // A chip is the one entry that changes after it is stored: it settles, and a visual run then
        // gains its frame. Only those three fields ever move, so comparing them is what keeps a
        // finished run from re-rendering on every poll for the rest of the conversation.
        && kept.tool?.status === entry.tool?.status
        && kept.tool?.detail === entry.tool?.detail
        && kept.tool?.screenshot === entry.tool?.screenshot
        && kept.decision?.status === entry.decision?.status
        && kept.decision?.answer === entry.decision?.answer
        && kept.decision?.decided_by_id === entry.decision?.decided_by_id
        && kept.routine?.id === entry.routine?.id
        && kept.routine?.name === entry.routine?.name
        && kept.trigger?.id === entry.trigger?.id
        && kept.trigger?.name === entry.trigger?.name
        && kept.routine_notify_group?.routine_name === entry.routine_notify_group?.routine_name
        && kept.routine_notify_group?.total_count === entry.routine_notify_group?.total_count
        && kept.routine_notify_group?.hidden_entries.length === entry.routine_notify_group?.hidden_entries.length
        && kept.routine_notify_group?.hidden_entries.every((hidden, index) =>
          hidden.event_id === entry.routine_notify_group?.hidden_entries[index]?.event_id) !== false
        && kept.queued === entry.queued
        && kept.turn_id === entry.turn_id
        // Attachments are written once with the entry and never move afterwards, so identity by
        // count and id is total: an entry that gains a file is a different entry.
        && kept.attachments.length === entry.attachments.length
        && kept.attachments.every((attachment, index) =>
          attachment.id === entry.attachments[index]?.id)
        && kept.created_at === entry.created_at;
      const value = unchanged ? kept : entry;
      next.set(entry.event_id, value);
      return value;
    });
    seen.current = next;
    const same = stable.length === previous.current.length
      && stable.every((entry, index) => entry === previous.current[index]);
    if (same) return previous.current;
    previous.current = stable;
    return stable;
  }, [entries]);
}

/** True when a message is built from exactly the same entry objects, in the same order and state. */
function sameGroup(kept: TranscriptMessage, next: TranscriptMessage): boolean {
  return kept.role === next.role
    && kept.author === next.author
    && kept.lead === next.lead
    && kept.sending === next.sending
    && kept.queued === next.queued
    && kept.turnId === next.turnId
    && kept.createdAt === next.createdAt
    && kept.displayContent === next.displayContent
    && kept.startsDay === next.startsDay
    && kept.startsNew === next.startsNew
    && kept.entries.length === next.entries.length
    && kept.entries.every((entry, index) => entry === next.entries[index]);
}

/**
 * The same trick as `useStableEntries`, one level up. A turn's group is rebuilt on every poll because
 * grouping allocates, so without this the conversion to assistant-ui messages would run again for
 * every turn in the thread whenever any one of them changed.
 */
export function useStableGroups(groups: TranscriptMessage[]): TranscriptMessage[] {
  const seen = useRef(new Map<string, TranscriptMessage>());
  const previous = useRef<TranscriptMessage[]>([]);
  return useMemo(() => {
    const next = new Map<string, TranscriptMessage>();
    const stable = groups.map((group) => {
      const kept = seen.current.get(group.id);
      const value = kept && sameGroup(kept, group) ? kept : group;
      next.set(group.id, value);
      return value;
    });
    seen.current = next;
    const same = stable.length === previous.current.length
      && stable.every((group, index) => group === previous.current[index]);
    if (same) return previous.current;
    previous.current = stable;
    return stable;
  }, [groups]);
}
