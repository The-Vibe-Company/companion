import type {
  CompanionRuntimeState,
  CompanionThread,
  CompanionTranscriptEntry,
} from "@companion/contracts";

/**
 * Present a control-plane note in the Companion's product vocabulary. Historical notes store Pi's
 * runtime name, but the transcript speaks about the Companion the reader opened and follows its
 * current name after a rename. Only system notes cross this boundary: replies and tool output stay
 * literal, even when they mention Pi themselves.
 */
export function transcriptDisplayContent(
  entry: CompanionTranscriptEntry,
  companionName: string,
): string {
  if (entry.role !== "system") return entry.content;
  return entry.content.replace(
    /(^|[^\p{L}\p{M}\p{N}\p{Pc}])Pi(?=$|[^\p{L}\p{M}\p{N}\p{Pc}])/gu,
    (_match, prefix: string) => `${prefix}${companionName}`,
  );
}

/**
 * Who wrote this entry. A thread shared with Editors has several writers, so only the reader's own
 * messages say "You"; a teammate's message keeps their name. A system note and a tool run have no
 * writer: they report what happened to the run rather than something anyone said.
 */
export function transcriptAuthor(
  entry: CompanionTranscriptEntry,
  viewerId: string,
  companionName: string,
): string | null {
  if (entry.role === "assistant") return companionName;
  if (entry.role === "system" || entry.role === "tool" || entry.role === "decision") return null;
  if (entry.author_id === viewerId) return "You";
  return entry.author_name ?? "Member";
}

/** The stored day, which is the one both renders can agree on before the client has its clock. */
export function utcDay(iso: string): string {
  return iso.slice(0, 10);
}

/** The reader's own day, as the same `YYYY-MM-DD` key so the separator label formats identically. */
export function localDay(iso: string): string {
  const at = new Date(iso);
  const month = `${at.getMonth() + 1}`.padStart(2, "0");
  const dayOfMonth = `${at.getDate()}`.padStart(2, "0");
  return `${at.getFullYear()}-${month}-${dayOfMonth}`;
}

/**
 * Whether Pi is durably replying. The API computes this only after the active attempt's positive
 * ACK and clears it at settlement; transcript shape and Box state are never substitutes for it.
 */
export function replyExpected(thread: CompanionThread | null): boolean {
  return thread?.active_turn?.replying === true;
}

/**
 * What the composer says under itself. Turn state comes from PostgreSQL, so the footer can explain
 * ordered work without inferring anything from a transcript tail or observing Box.
 */
export function composerHint(input: {
  thread: CompanionThread | null;
  companionName: string;
  state: CompanionRuntimeState;
}): string {
  const interrupted = input.thread?.interrupted_turn;
  const queued = input.thread?.queued_count ?? 0;
  if (interrupted) {
    const waiting = queued > 0
      ? ` ${queued} message${queued === 1 ? " is" : "s are"} saved and queued.`
      : " New messages remain available.";
    return `The interrupted occurrence is terminal and will not be replayed; later work continues automatically.${waiting}`;
  }

  const active = input.thread?.active_turn;
  if (active) {
    const queuedSuffix = queued > 0
      ? ` ${queued} later message${queued === 1 ? " is" : "s are"} queued.`
      : "";
    if (active.status === "needs_input") {
      return `Answer the request above to continue this turn.${queuedSuffix}`;
    }
    if (active.status === "admitted" && input.state === "provisioning") {
      return `${input.companionName} is starting this turn.${queuedSuffix}`;
    }
    return `${input.companionName} is working on this turn.${queuedSuffix}`;
  }

  if (queued > 0) {
    const queueSuffix = `${queued} message${queued === 1 ? " is" : "s are"} saved and queued.`;
    const externalBlock = input.thread?.queued_turn?.external_block;
    if (externalBlock) {
      return `External service issue: ${externalBlock.message} ${queueSuffix}`;
    }
    if (input.thread?.preparation?.taking_longer_than_expected === true) {
      return `Ça prend plus de temps que prévu. ${queueSuffix}`;
    }
    if (input.thread?.preparation) {
      return `Je me réveille. ${queueSuffix}`;
    }
    return queueSuffix;
  }
  if (input.thread?.background_busy === true) {
    return "Background work is running. You can keep messaging.";
  }
  if (input.state === "provisioning" || input.state === "stopping") {
    return "A runtime change is in progress. Messages remain durable and ordered.";
  }
  return "Enter sends. Shift + Enter starts a new line.";
}
