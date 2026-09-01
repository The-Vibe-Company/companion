"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent as ReactClipboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import {
  AssistantRuntimeProvider,
  ComposerPrimitive,
  useAuiState,
  useExternalStoreRuntime,
  type AppendMessage,
  type AssistantRuntime,
} from "@assistant-ui/react";
import {
  ArrowUpIcon,
  ChevronRightIcon,
  PaperclipIcon,
  PlusIcon,
  SquareIcon,
  XIcon,
} from "lucide-react";
import type {
  Companion,
  CompanionThread as Thread,
  CompanionTranscriptEntry,
} from "@companion/contracts";
import {
  COMPANION_ATTACHMENT_MAX_BYTES,
  COMPANION_MESSAGE_ATTACHMENT_MAX_COUNT,
  companionMessageEventId,
  declaredCompanionAttachmentContentType,
  sanitizeCompanionAttachmentFilename,
} from "@companion/contracts";
import { Thread as AssistantThread } from "@/components/assistant-ui/thread";
import { cn } from "@/lib/utils";
import { decideCompanionDecision } from "../../lib/companions";
import { AttachmentContext, AttachmentList, readableSize } from "./AttachmentCard";
import { CompanionIcon } from "./CompanionIcon";
import {
  DecisionActionsContext,
  type DecisionAction,
  type DecisionNamedResource,
} from "./decisionActions";
import { DecisionToolCard } from "./DecisionToolCard";
import { ToolRunCard } from "./ToolRunCard";
import { composerHint, localDay, replyExpected, utcDay } from "./transcript";
import {
  COMPANION_DECISION_TOOL_NAME,
  COMPANION_TOOL_NAME,
  attachmentsOf,
  groupTranscriptEntries,
  toThreadMessageLike,
  useStableEntries,
  useStableGroups,
  type TranscriptMessage,
} from "./transcriptMessages";

/**
 * The conversation of one Companion, rendered through assistant-ui.
 *
 * The library owns the transcript mechanics — viewport anchoring, the composer, keys, focus, message
 * parts — and nothing else: the messages come from the control-plane read model this component is
 * handed, sending goes back out through the same callback the rest of Companions uses, and no
 * assistant-ui thread list, cloud, history, or model adapter is wired up. A Viewer gets the
 * transcript with a read-only note where the composer would be, and the runtime has nothing to
 * contact, so reading a thread still cannot reach Box.
 *
 * A Pi turn arrives here as one message whose parts are its reasoning, its reply, and every tool run
 * and permission card it produced. The two cards are registered as tool UIs by name, which is how a
 * permission decision — the one thing in this thread a reader can act on — reaches the control plane
 * from inside a message part.
 */

/**
 * How long after a press its own `click` can still arrive. A browser resolving a tap takes a moment
 * to deliver it, and on a phone it may never come at all; anything later than this is somebody
 * activating the button again.
 */
const PRESS_CLICK_MS = 700;

/** Message metadata by id: who wrote it, whether it opens a passage, whether it is still sending. */
const MessagesContext = createContext<ReadonlyMap<string, TranscriptMessage>>(new Map());

/**
 * What the chrome around the messages is showing. It travels by context because the thread mounts
 * these as components: a new component *identity* on every render would remount the composer, and a
 * remounted composer is a lost draft mid-keystroke.
 */
interface TranscriptChrome {
  companionName: string;
  /** The Companion's cosmetic icon, so the replying trailer can animate the bot itself. */
  companionIcon: Companion["icon"];
  canSend: boolean;
  loading: boolean;
  empty: boolean;
  hasOlderMessages: boolean;
  loadingOlderMessages: boolean;
  onLoadOlderMessages?: () => Promise<void> | void;
  replying: boolean;
  stopping: boolean;
  /** True while an Owner/Editor can stop the turn that currently owns Pi. */
  canStop: boolean;
  hint: string;
  /** Files staged for the next send, in the order they will be staged on the Box. */
  attachments: readonly File[];
  /** One line saying why a file was refused, cleared as soon as another is accepted. */
  attachmentError: string | null;
  onAttach: (files: FileList | readonly File[] | null) => void;
  onRemoveAttachment: (index: number) => void;
  onSendPress: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  onSendClick: (event: ReactMouseEvent<HTMLButtonElement>) => void;
  onStop: () => void;
  onCancelQueued: (turnId: string) => void;
  onOpenRoutineRun?: (routine: NonNullable<CompanionTranscriptEntry["routine"]>) => void;
  expandedRoutineNotifyGroups: ReadonlySet<string>;
  onToggleRoutineNotifyGroup: (eventId: string) => void;
  dequeueingTurnId: string | null;
}

const ChromeContext = createContext<TranscriptChrome | null>(null);

function useChrome(): TranscriptChrome {
  const chrome = useContext(ChromeContext);
  if (!chrome) throw new Error("the Companion thread chrome is only available inside the thread");
  return chrome;
}

function useTranscriptMessage(): TranscriptMessage | undefined {
  const messages = useContext(MessagesContext);
  const id = useAuiState((state) => state.message.id);
  return id ? messages.get(id) : undefined;
}

/** Server markup keeps the stable ISO minute; the local clock takes over on the client. */
function SentAt({ iso }: { iso: string }) {
  const [text, setText] = useState(() => iso.slice(11, 16));
  useEffect(() => setText(new Date(iso).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  })), [iso]);
  return <time dateTime={iso}>{text}</time>;
}

/**
 * A writer keeps the floor across consecutive messages, so the name and the clock appear once per
 * passage and the messages underneath are just the words.
 */
function PassageLead({ message }: { message: TranscriptMessage | undefined }) {
  if (!message?.lead || !message.author) return null;
  return (
    <p className="text-muted-foreground mb-1 flex items-baseline gap-2 text-xs">
      <span className="text-foreground font-medium">{message.author}</span>
      <SentAt iso={message.createdAt} />
    </p>
  );
}

/**
 * The assistant's lead carries the Companion's face beside its name. The face is `still` on
 * purpose: the transcript body has no ambient motion, and the thinking animation belongs to the
 * trailer below the last message, which shares this lead's geometry so the working bot reads as
 * the next passage forming.
 */
function AssistantPassageLead({ message }: { message: TranscriptMessage | undefined }) {
  const { companionIcon } = useChrome();
  if (!message?.lead || !message.author) return null;
  return (
    <p className="text-muted-foreground mb-1 flex items-center gap-2 text-xs">
      <CompanionIcon icon={companionIcon} size={16} state="still" />
      <span className="text-foreground font-medium">{message.author}</span>
      <SentAt iso={message.createdAt} />
    </p>
  );
}

/**
 * One day separator. The key is already the day this message belongs to — the stored one on the
 * server, the reader's own once the client has a clock — and is read back at midday UTC so the round
 * trip cannot shift it. Only the label gets friendlier after mount.
 */
function DaySeparator({ day }: { day: string }) {
  const [text, setText] = useState(day);
  useEffect(() => {
    const at = new Date(`${day}T12:00:00.000Z`);
    const today = new Date();
    const daysApart = Math.round(
      (Date.UTC(today.getFullYear(), today.getMonth(), today.getDate())
        - Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate())) / 86_400_000,
    );
    if (daysApart === 0) setText("Today");
    else if (daysApart === 1) setText("Yesterday");
    else {
      setText(at.toLocaleDateString(undefined, {
        month: "long",
        day: "numeric",
        // oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- legacy pattern predating the incremental anti-slop gate
        ...(daysApart > 300 ? { year: "numeric" } : {}),
        timeZone: "UTC",
      }));
    }
  }, [day]);
  return (
    <p
      data-slot="chat-day-separator"
      className="text-muted-foreground my-1 flex items-center gap-3 text-xs before:h-px before:flex-1 before:bg-(--color-line) after:h-px after:flex-1 after:bg-(--color-line)"
    >
      <time dateTime={day}>{text}</time>
    </p>
  );
}

/**
 * Where this reader left off. It is drawn once, on the first message somebody else wrote after the
 * newest line they had already seen, so returning to a busy thread starts where reading stopped.
 *
 * The accent is on the hairlines and nowhere else. `accent-edge` is an edge token — it is not lifted
 * for the dark theme — and this word is small, so at accent colour it falls under the contrast floor
 * on every preset. The one word this divider exists for stays at full foreground contrast.
 */
function NewSeparator() {
  return (
    <p
      data-slot="chat-new-separator"
      className="text-foreground my-1 flex items-center gap-3 text-xs font-medium before:h-px before:flex-1 before:bg-(--color-accent-line) after:h-px after:flex-1 after:bg-(--color-accent-line)"
    >
      New
    </p>
  );
}

/** Both separators, above whichever message opens the day or the unread run. */
function Separators({ message }: { message: TranscriptMessage | undefined }) {
  if (!message) return null;
  return (
    <>
      {message.startsDay && <DaySeparator day={message.startsDay} />}
      {message.startsNew && <NewSeparator />}
    </>
  );
}

function AssistantFrame({ children }: { children: ReactNode }) {
  const message = useTranscriptMessage();
  const {
    expandedRoutineNotifyGroups,
    onOpenRoutineRun,
    onToggleRoutineNotifyGroup,
  } = useChrome();
  const groupedEntry = message?.entries.find((entry) => entry.routine_notify_group != null);
  const notifyGroup = groupedEntry?.routine_notify_group ?? null;
  const delegation = message?.entries.find((entry) => entry.delegation)?.delegation ?? null;
  const expanded = groupedEntry ? expandedRoutineNotifyGroups.has(groupedEntry.event_id) : false;
  const opensPagedHistory = notifyGroup?.routine_id !== undefined && onOpenRoutineRun !== undefined;
  return (
    <>
      <Separators message={message} />
      <AssistantPassageLead message={message} />
      {delegation && (
        <p className="chat-routine-header">
          From {delegation.companion_name} · {delegation.response_mode}
        </p>
      )}
      {notifyGroup && groupedEntry ? (
        <>
          <button
            type="button"
            className="chat-routine-notify-group"
            aria-expanded={opensPagedHistory ? undefined : expanded}
            onClick={() => opensPagedHistory
              ? onOpenRoutineRun({
                  id: notifyGroup.routine_id ?? null,
                  name: notifyGroup.routine_name,
                  run_id: null,
                })
              : onToggleRoutineNotifyGroup(groupedEntry.event_id)}
          >
            <ChevronRightIcon
              aria-hidden="true"
              className={cn(
                "size-3.5 transition-transform",
                !opensPagedHistory && expanded && "rotate-90",
              )}
            />
            {notifyGroup.routine_name} · {notifyGroup.total_count} updates
          </button>
          {!opensPagedHistory && expanded ? (
            <div className="chat-routine-notify-history">
              {notifyGroup.hidden_entries.map((entry) => entry.routine ? (
                entry.routine.run_id && onOpenRoutineRun ? (
                  <button
                    key={entry.event_id}
                    type="button"
                    className="chat-routine-header chat-routine-header--button"
                    aria-label={`Open ${entry.routine.name} routine run`}
                    onClick={() => onOpenRoutineRun(entry.routine!)}
                  >
                    Routine: {entry.routine.name}
                    <ChevronRightIcon aria-hidden="true" className="size-3.5" />
                  </button>
                ) : (
                  <p key={entry.event_id} className="chat-routine-header">
                    Routine: {entry.routine.name}
                  </p>
                )
              ) : entry.role === "assistant" ? (
                <p key={entry.event_id} className="chat-routine-notify-history__reply">
                  {entry.content}
                </p>
              ) : null)}
            </div>
          ) : null}
        </>
      ) : null}
      {children}
      {/* Files come after the words that introduced them, which is the order they happened in. */}
      {message && <AttachmentList attachments={attachmentsOf(message)} />}
    </>
  );
}

function UserFrame({ children }: { children: ReactNode }) {
  const message = useTranscriptMessage();
  const { canSend, onCancelQueued, onOpenRoutineRun, dequeueingTurnId } = useChrome();
  const routine = message?.entries[0]?.routine ?? null;
  const trigger = message?.entries[0]?.trigger ?? null;
  const delegation = message?.entries[0]?.delegation ?? null;
  const queued = message?.queued === true;
  return (
    <div
      className="flex w-full flex-col items-end"
      aria-busy={message?.sending || queued || undefined}
    >
      <div className="w-full">
        <Separators message={message} />
      </div>
      <PassageLead message={message} />
      {/* Full width on purpose: the bubble inside is capped as a percentage, and a fit-content
          wrapper would make that percentage resolve against the bubble's own text. */}
      <div className={cn("flex w-full flex-col items-end", (message?.sending || queued) && "opacity-60")}>
        {delegation && (
          <p className="chat-routine-header">
            {delegation.direction === "request" ? "Delegated by" : "Response from"} {delegation.companion_name}
            {" · "}{delegation.response_mode}
          </p>
        )}
        {routine ? (
          routine.run_id && onOpenRoutineRun ? (
            <button
              type="button"
              className="chat-routine-header chat-routine-header--button"
              aria-label={`Open ${routine.name} routine run`}
              onClick={() => onOpenRoutineRun(routine)}
            >
              Routine: {routine.name}
              <ChevronRightIcon aria-hidden="true" className="size-3.5" />
            </button>
          ) : <p className="chat-routine-header">Routine: {routine.name}</p>
        ) : trigger ? (
          // A trigger's composed prompt carries an untrusted event payload nobody typed, so it is
          // masked behind the same compact header a routine fire gets.
          <p className="chat-routine-header">Trigger: {trigger.name}</p>
        ) : children}
        {message && <AttachmentList attachments={attachmentsOf(message)} />}
      </div>
      {queued ? (
        <p data-slot="queued-message" className="text-muted-foreground mt-1 flex items-center gap-2 text-xs">
          <span>Queued</span>
          {canSend && message?.turnId ? (
            <button
              type="button"
              className="hover:text-foreground pointer-coarse:size-11 grid size-8 shrink-0 place-items-center rounded-sm"
              aria-label="Remove from queue"
              aria-busy={dequeueingTurnId === message.turnId || undefined}
              disabled={dequeueingTurnId === message.turnId}
              onClick={() => onCancelQueued(message.turnId!)}
            >
              <XIcon className="size-3.5" />
            </button>
          ) : null}
        </p>
      ) : null}
      {queued ? (
        <span className="sr-only" role="status">This message is queued.</span>
      ) : null}
      <UploadStatus message={message} />
    </div>
  );
}

/**
 * An upload can run for up to two minutes, and the only sighted cue is a dimmed bubble. `aria-busy`
 * marks the region as changing; it does not announce anything. A text send acknowledges in under a
 * second, so announcing that would be noise — this speaks only while files are actually in flight.
 */
function UploadStatus({ message }: { message: TranscriptMessage | undefined }) {
  const count = message?.sending ? attachmentsOf(message).length : 0;
  return (
    <span className="sr-only" role="status">
      {count > 0
        ? `Uploading ${count} ${count === 1 ? "file" : "files"} with your message...`
        : ""}
    </span>
  );
}

function HistoryLoader() {
  const { hasOlderMessages, loadingOlderMessages, onLoadOlderMessages } = useChrome();
  const markerRef = useRef<HTMLButtonElement>(null);
  const requestingRef = useRef(false);
  const load = useCallback(async () => {
    if (!hasOlderMessages || loadingOlderMessages || requestingRef.current
      || !onLoadOlderMessages) return;
    const viewport = markerRef.current?.closest<HTMLElement>("[data-slot='aui_thread-viewport']")
      ?? null;
    const previousHeight = viewport?.scrollHeight ?? 0;
    const previousTop = viewport?.scrollTop ?? 0;
    requestingRef.current = true;
    try {
      await onLoadOlderMessages();
      window.requestAnimationFrame(() => {
        if (viewport) viewport.scrollTop = previousTop + viewport.scrollHeight - previousHeight;
      });
    } finally {
      requestingRef.current = false;
    }
  }, [hasOlderMessages, loadingOlderMessages, onLoadOlderMessages]);

  useEffect(() => {
    const marker = markerRef.current;
    if (!marker || !hasOlderMessages || !("IntersectionObserver" in window)) return;
    const viewport = marker.closest<HTMLElement>("[data-slot='aui_thread-viewport']");
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) void load();
    }, { root: viewport, rootMargin: "240px 0px 0px" });
    observer.observe(marker);
    return () => observer.disconnect();
  }, [hasOlderMessages, load]);

  if (!hasOlderMessages) return null;
  return (
    <button
      ref={markerRef}
      type="button"
      className="text-muted-foreground mx-auto rounded-full px-3 py-1 text-xs hover:text-foreground"
      disabled={loadingOlderMessages}
      onClick={() => void load()}
    >
      {loadingOlderMessages ? "Loading earlier messages…" : "Load earlier messages"}
    </button>
  );
}

const TOOL_UIS = {
  [COMPANION_TOOL_NAME]: ToolRunCard,
  [COMPANION_DECISION_TOOL_NAME]: DecisionToolCard,
};

const THREAD_COMPONENTS = {
  HistoryLoader,
  Welcome,
  Trailer,
  Footer,
  UserMessageFrame: UserFrame,
  AssistantMessageFrame: AssistantFrame,
  tools: TOOL_UIS,
};

function appendedText(message: AppendMessage): string {
  return message.content
    .map((part) => part.type === "text" ? part.text : "")
    .join("")
    .trim();
}

/**
 * Decide which dropped, pasted, or picked files this composer will carry, and say why the rest were
 * refused. Every rule here is stated again by the API and by a database constraint; refusing early is
 * how a member finds out before spending an upload on it, not how the bound is enforced.
 */
function acceptAttachments(
  staged: readonly File[],
  incoming: readonly File[],
): { files: File[]; error: string | null } {
  const files = [...staged];
  let error: string | null = null;
  for (const file of incoming) {
    if (files.length >= COMPANION_MESSAGE_ATTACHMENT_MAX_COUNT) {
      error = `A message can carry at most ${COMPANION_MESSAGE_ATTACHMENT_MAX_COUNT} files.`;
      break;
    }
    if (file.size === 0) {
      error = `${file.name} is empty.`;
      continue;
    }
    if (file.size > COMPANION_ATTACHMENT_MAX_BYTES) {
      error = `${file.name} is larger than ${readableSize(COMPANION_ATTACHMENT_MAX_BYTES)}.`;
      continue;
    }
    if (!declaredCompanionAttachmentContentType({ type: file.type, name: file.name })) {
      error = `${file.name} is not an image, PDF, CSV, text, Markdown, or JSON file.`;
      continue;
    }
    files.push(file);
  }
  // A mixed batch still says what it refused: accepting the good files is not a reason to leave
  // someone wondering where the others went.
  // oxlint-disable-next-line anti-slop/no-known-value-widening -- legacy pattern predating the incremental anti-slop gate
  return { files, error };
}

/** A stable identity for one draft, so a resend of the same message reuses its turn id. */
function draftSignature(content: string, files: readonly File[]): string {
  return [content, ...files.map((file) => `${file.name}:${file.size}:${file.lastModified}`)]
    .join("\u0000");
}

/** A failed send keeps its text: restore the draft unless something newer was typed meanwhile. */
function restoreDraft(runtime: AssistantRuntime | null, content: string): void {
  const composer = runtime?.thread.composer;
  if (!composer || composer.getState().text.trim()) return;
  composer.setText(content);
}

export function CompanionTranscript({
  companion,
  thread,
  orgId,
  busy,
  lastReadOrdinal,
  openedThroughOrdinal,
  hasOlderMessages = false,
  loadingOlderMessages = false,
  onLoadOlderMessages,
  skills = [],
  plugins = [],
  models = [],
  onSend,
  onStop,
  onCancelQueued,
  onOpenRoutineRun,
  onThread,
}: {
  companion: Companion;
  thread: Thread | null;
  orgId: string;
  busy: boolean;
  /** This reader's unread watermark as it stood when the thread was opened; null draws no divider. */
  lastReadOrdinal?: number | null;
  /** The newest ordinal the thread held when it was opened, so the divider cannot chase new arrivals. */
  openedThroughOrdinal?: number | null;
  hasOlderMessages?: boolean;
  loadingOlderMessages?: boolean;
  onLoadOlderMessages?: () => Promise<void> | void;
  /** Library skills this reader can already name. Config cards never take labels from Pi. */
  skills?: readonly DecisionNamedResource[];
  /** Connected plugins this reader can already name. */
  plugins?: readonly DecisionNamedResource[];
  /** Provider catalog models this surface already loaded. */
  models?: readonly DecisionNamedResource[];
  onSend: (content: string, clientMessageId: string, files: readonly File[]) => Promise<boolean>;
  /** Stop the active turn. Absent for a Viewer. */
  onStop?: (turnId: string) => Promise<void>;
  /** Remove a queued follow-up. Absent for a Viewer. */
  onCancelQueued?: (turnId: string) => Promise<void>;
  /** Open the private history associated with a routine-origin marker. */
  onOpenRoutineRun?: (routine: NonNullable<CompanionTranscriptEntry["routine"]>) => void;
  /** Replace the thread after a permission card is decided, without a full poll cycle. */
  onThread: (thread: Thread) => void;
}) {
  const canSend = thread ? thread.can_send : companion.access !== "viewer";
  const viewerId = thread?.viewer_id ?? "";
  const runtimeRef = useRef<AssistantRuntime | null>(null);
  const inFlight = useRef(false);
  /**
   * The id of a send whose request did not confirm, held beside the draft it named. The control plane
   * can persist a turn before a response is lost, so minting a fresh id for the restored draft could
   * store the same message twice. Reusing the id keeps one submission one turn. It is cleared the
   * moment a send confirms and only reused for the identical draft, so two different messages are
   * still two turns.
   */
  const pendingSendRef = useRef<{ signature: string; clientMessageId: string } | null>(null);
  /**
   * Files staged for the next send. They are held here rather than in the composer because the
   * composer belongs to assistant-ui and only carries text; a send takes both together, and a
   * refused send hands both back.
   */
  const [attachments, setAttachments] = useState<readonly File[]>([]);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const attachmentsRef = useRef<readonly File[]>([]);
  useEffect(() => {
    attachmentsRef.current = attachments;
  }, [attachments]);
  /**
   * The message this composer just sent, shown before the control plane answers. It already carries
   * the event id the control plane will store it under, so the saved entry replaces it rather than
   * joining it: the sent message cannot appear twice even if a thread read lands first. A refused send
   * drops it and hands the text back to the composer.
   */
  const [outgoing, setOutgoing] = useState<CompanionTranscriptEntry | null>(null);
  const [stopping, setStopping] = useState(false);
  const [dequeueingTurnId, setDequeueingTurnId] = useState<string | null>(null);
  const [expandedRoutineNotifyGroups, setExpandedRoutineNotifyGroups] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const toggleRoutineNotifyGroup = useCallback((eventId: string) => {
    setExpandedRoutineNotifyGroups((current) => {
      const next = new Set(current);
      if (next.has(eventId)) next.delete(eventId);
      else next.add(eventId);
      return next;
    });
  }, []);

  const entries = useMemo(() => {
    const saved = thread?.entries ?? [];
    if (!outgoing || saved.some((entry) => entry.event_id === outgoing.event_id)) return [...saved];
    return [...saved, outgoing];
  }, [outgoing, thread]);
  useEffect(() => {
    if (outgoing && thread?.entries.some((entry) => entry.event_id === outgoing.event_id)) {
      setOutgoing(null);
    }
  }, [outgoing, thread]);
  const stableEntries = useStableEntries(entries);

  /**
   * The server has no clock the browser agrees with, so both renders key the day on the stored one
   * and the reader's own calendar takes over after mount. Swapping it later is what keeps a
   * separator from naming a different date than the timestamps under it.
   */
  const [dayOf, setDayOf] = useState<(iso: string) => string>(() => utcDay);
  useEffect(() => setDayOf(() => localDay), []);

  const grouped = useMemo(
    () => groupTranscriptEntries(stableEntries, {
      viewerId,
      companionName: companion.name,
      sendingEventId: outgoing?.event_id ?? null,
      lastReadOrdinal: lastReadOrdinal ?? null,
      openedThroughOrdinal: openedThroughOrdinal ?? null,
      dayOf,
    }),
    [companion.name, dayOf, lastReadOrdinal, openedThroughOrdinal, outgoing, stableEntries, viewerId],
  );
  const messages = useStableGroups(grouped);
  const messagesById = useMemo(
    () => new Map(messages.map((message) => [message.id, message])),
    [messages],
  );

  const onDecide = useCallback(async (requestId: string, input: DecisionAction) => {
    const next = await decideCompanionDecision(orgId, companion.id, requestId, input);
    onThread(next);
  }, [companion.id, onThread, orgId]);

  const send = useCallback(async (message: AppendMessage) => {
    const content = appendedText(message);
    // The composer blocks a second send while one is in flight; this closes the same door for a
    // programmatic one, so one message is never sent twice.
    if (!content || !canSend || inFlight.current) return;
    inFlight.current = true;
    const files = attachmentsRef.current;
    // One submission, one id: whatever happens to the request, the control plane can only ever store
    // the turn it names once. A draft restored after a send that never confirmed keeps the id its
    // first attempt named, so retrying the same text resolves to the durable turn rather than a
    // second copy of it; anything else is a new message and gets a fresh id. The files count as part
    // of the message, so changing them makes it a different one.
    const signature = draftSignature(content, files);
    const remembered = pendingSendRef.current;
    const clientMessageId = remembered && remembered.signature === signature
      ? remembered.clientMessageId
      : crypto.randomUUID();
    pendingSendRef.current = { signature, clientMessageId };
    setOutgoing({
      event_id: companionMessageEventId(clientMessageId),
      ordinal: Number.MAX_SAFE_INTEGER,
      role: "user",
      content,
      reasoning: null,
      author_id: viewerId,
      author_name: null,
      tool: null,
      decision: null,
      routine: null,
      trigger: null,
      turn_id: null,
      queued: thread?.active_turn != null
        || thread?.interrupted_turn != null
        || (thread?.queued_count ?? 0) > 0
        || companion.runtime.state !== "running",
      // Named, not fetchable: the ids here are local and the bytes are still being uploaded, so the
      // card shows the files as chips until the saved entry replaces this one.
      attachments: files.flatMap((file, position) => {
        const contentType = declaredCompanionAttachmentContentType({
          type: file.type,
          name: file.name,
        });
        // The declared type is only a guess until the server sniffs the bytes, but it is the same
        // guess `acceptAttachments` already accepted, and the name is the one that will be stored --
        // so the chip does not rewrite itself when the saved projection replaces this entry.
        if (!contentType) return [];
        return [{
          id: `pending-${clientMessageId}-${position}`,
          kind: "user_upload" as const,
          content_type: contentType,
          byte_size: file.size,
          filename: sanitizeCompanionAttachmentFilename({
            filename: file.name,
            position,
            contentType,
          }),
          position,
        }];
      }),
      created_at: new Date().toISOString(),
    });
    let saved = false;
    try {
      saved = await onSend(content, clientMessageId, files);
      if (saved) {
        pendingSendRef.current = null;
        // Remove exactly the files this send carried. An upload can take up to two minutes, and a
        // file picked while it was in flight belongs to the next message, not to this one.
        setAttachments((current) => current.filter((file) => !files.includes(file)));
        setAttachmentError(null);
      } else {
        restoreDraft(runtimeRef.current, content);
      }
    } finally {
      inFlight.current = false;
      // A bounded send ACK carries only the turn. Keep the accepted message visible until the
      // thread projection contains its durable event id; a failed send still restores the draft and
      // the files it named, so nothing has to be picked again.
      if (!saved) setOutgoing(null);
    }
  }, [canSend, companion.runtime.state, onSend, thread, viewerId]);

  const onAttach = useCallback((incoming: FileList | readonly File[] | null) => {
    if (!incoming) return;
    const accepted = acceptAttachments(
      attachmentsRef.current,
      // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- invariant checked by the surrounding validation
      Array.from(incoming as ArrayLike<File>),
    );
    setAttachments(accepted.files);
    setAttachmentError(accepted.error);
  }, []);

  const onRemoveAttachment = useCallback((index: number) => {
    setAttachments((current) => current.filter((_, position) => position !== index));
    setAttachmentError(null);
  }, []);

  const runtime = useExternalStoreRuntime({
    messages,
    convertMessage: toThreadMessageLike,
    onNew: send,
    // Sending is the only thing this thread does: no editing, no branching, no regeneration, no
    // cancel, and no run of its own, so the primitives offer none of those controls.
    isDisabled: !canSend,
    isSendDisabled: busy,
  });
  useEffect(() => {
    runtimeRef.current = runtime;
  }, [runtime]);

  /** When a press last sent, so the click that press produces can be told apart from a new one. */
  const pressSentAt = useRef(0);

  /**
   * iOS settles a tap on the composer's own button by blurring the field first: the keyboard starts
   * closing, the visual viewport grows, the thread pinned to it is laid out again, and the `click`
   * meant for this button lands wherever the button used to be — THE-346, a Send that never fired.
   * The press is the whole gesture on a button that neither drags nor holds, so it is where the
   * message goes. Refusing the default keeps focus, and the draft, in the field, which is what keeps
   * the keyboard from closing under the finger to begin with.
   */
  const sendOnPress = useCallback((event: ReactPointerEvent<HTMLButtonElement>) => {
    const composer = runtime.thread.composer;
    if (!composer.getState().canSend) return;
    event.preventDefault();
    pressSentAt.current = Date.now();
    composer.send();
  }, [runtime]);

  /**
   * The primitive sends from `click`, and the browser still delivers one after the press. Refusing
   * the default is how `ComposerPrimitive.Send` is told this one is spoken for: it composes its own
   * handler behind this one and skips it on a prevented event. Only the click belonging to the press
   * is refused — a click from a keyboard activating the focused button, or one the browser delivers
   * long after a press whose own click never arrived, is a fresh Send and goes through.
   */
  const swallowClickAfterPress = useCallback((event: ReactMouseEvent<HTMLButtonElement>) => {
    if (Date.now() - pressSentAt.current > PRESS_CLICK_MS) return;
    pressSentAt.current = 0;
    event.preventDefault();
  }, []);

  const activeTurnId = thread?.active_turn?.id ?? null;
  useEffect(() => {
    if (!activeTurnId) setStopping(false);
  }, [activeTurnId]);

  const stopTurn = useCallback(() => {
    if (!activeTurnId || !onStop || stopping) return;
    setStopping(true);
    void onStop(activeTurnId).then(
      () => document.querySelector<HTMLTextAreaElement>("[data-slot=composer-root] textarea")?.focus(),
      () => setStopping(false),
    );
  }, [activeTurnId, onStop, stopping]);

  const cancelQueued = useCallback((turnId: string) => {
    if (!onCancelQueued || dequeueingTurnId === turnId) return;
    setDequeueingTurnId(turnId);
    void onCancelQueued(turnId).then(
      () => document.querySelector<HTMLTextAreaElement>("[data-slot=composer-root] textarea")?.focus(),
      () => undefined,
    ).finally(() => {
      setDequeueingTurnId((current) => current === turnId ? null : current);
    });
  }, [onCancelQueued, dequeueingTurnId]);

  const replying = replyExpected(thread);
  const loading = thread === null;
  const empty = thread !== null && messages.length === 0;
  const hint = attachments.length > 0
    ? `Add a message to send ${attachments.length === 1 ? "this file" : "these files"}.`
    : composerHint({
      thread,
      companionName: companion.name,
      state: companion.runtime.state,
    });

  const chrome = useMemo<TranscriptChrome>(() => ({
    companionName: companion.name,
    companionIcon: companion.icon,
    canSend,
    loading,
    empty,
    hasOlderMessages,
    loadingOlderMessages,
    onLoadOlderMessages,
    replying,
    stopping,
    canStop: canSend && activeTurnId !== null && onStop !== undefined,
    hint,
    attachments,
    attachmentError,
    onAttach,
    onRemoveAttachment,
    onSendPress: sendOnPress,
    onSendClick: swallowClickAfterPress,
    onStop: stopTurn,
    onCancelQueued: cancelQueued,
    onOpenRoutineRun,
    expandedRoutineNotifyGroups,
    onToggleRoutineNotifyGroup: toggleRoutineNotifyGroup,
    dequeueingTurnId,
  }), [
    attachmentError,
    attachments,
    activeTurnId,
    canSend,
    cancelQueued,
    companion.name,
    companion.icon,
    dequeueingTurnId,
    empty,
    expandedRoutineNotifyGroups,
    hasOlderMessages,
    hint,
    loading,
    loadingOlderMessages,
    onAttach,
    onRemoveAttachment,
    onOpenRoutineRun,
    onLoadOlderMessages,
    onStop,
    replying,
    sendOnPress,
    stopTurn,
    stopping,
    swallowClickAfterPress,
    toggleRoutineNotifyGroup,
  ]);

  const decisions = useMemo(() => ({
    canAct: canSend,
    access: thread?.access ?? companion.access,
    companionId: companion.id,
    companionName: companion.name,
    skills,
    plugins,
    models,
    onDecide,
  }), [canSend, companion.access, companion.id, companion.name, models, onDecide, plugins, skills, thread?.access]);
  const attachmentContext = useMemo(() => ({ companionId: companion.id }), [companion.id]);

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <DecisionActionsContext.Provider value={decisions}>
        <AttachmentContext.Provider value={attachmentContext}>
        <MessagesContext.Provider value={messagesById}>
          <ChromeContext.Provider value={chrome}>
            <AssistantThread
              className="chat-thread min-w-0 flex-1"
              components={THREAD_COMPONENTS}
              viewportProps={{
                role: "log",
                "aria-live": "polite",
                "aria-busy": loading,
              }}
            />
          </ChromeContext.Provider>
        </MessagesContext.Provider>
        </AttachmentContext.Provider>
      </DecisionActionsContext.Provider>
    </AssistantRuntimeProvider>
  );
}

function Welcome() {
  const { canSend, companionName, empty, loading } = useChrome();
  if (loading) {
    return (
      <>
        {/* The skeleton is decorative; the wait itself still has to be announced. */}
        <span className="sr-only" role="status">Loading conversation...</span>
        <div className="grid gap-3" aria-hidden="true">
          <span className="bg-muted h-3 w-2/5 rounded" />
          <span className="bg-muted h-3 w-3/4 rounded" />
          <span className="bg-muted h-3 w-3/5 rounded" />
        </div>
      </>
    );
  }
  if (!empty) return null;
  return (
    <div className="text-muted-foreground max-w-[48ch] text-sm">
      <strong className="text-foreground block text-base">No messages yet</strong>
      <p className="mt-1">
        {canSend
          ? `Send a message to start ${companionName} and get a reply.`
          : "This transcript is read from the control plane, so opening it left the Box asleep."}
      </p>
    </div>
  );
}

/**
 * Pi owes this thread a reply and has not produced one yet.
 *
 * The dots are the decoration; the sentence is the message. A reader who has asked for reduced
 * motion gets three motionless dots, so leaving the words to a screen-reader-only span would tell
 * that reader nothing at all — the sentence is on the page for everyone, and the dots are hidden
 * from assistive technology because they say the same thing again.
 */
function Trailer() {
  const { companionName, companionIcon, replying } = useChrome();
  if (!replying) return null;
  return (
    <p
      data-slot="companion-replying"
      className="text-muted-foreground flex items-center gap-2 text-xs"
    >
      {/* Same geometry as the assistant lead above, so the thinking face sits exactly where the
          reply's own face will land when it arrives. */}
      <CompanionIcon icon={companionIcon} size={16} state="thinking" />
      <span>
        <span className="text-foreground font-medium">{companionName}</span> is replying...
      </span>
    </p>
  );
}

/** Thumbnail chip for a staged image file; manages its own object-URL lifecycle. */
function ComposerImageChip({
  file,
  index,
  onRemove,
  restoreFocusRef,
}: {
  file: File;
  index: number;
  onRemove: (index: number) => void;
  restoreFocusRef: { current: boolean };
}) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    const url = URL.createObjectURL(file);
    setSrc(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);
  return (
    <li
      className="relative shrink-0"
      title={`${file.name} · ${readableSize(file.size)}`}
    >
      <div className="border-border bg-muted h-16 w-16 overflow-hidden rounded-lg border">
        {src ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={src} alt="" className="h-full w-full object-cover" />
        ) : null}
      </div>
      {/* Carries the filename for screen readers (the img is decorative) and textContent checks. */}
      <span className="sr-only">{file.name}</span>
      <button
        type="button"
        onClick={() => {
          restoreFocusRef.current = true;
          onRemove(index);
        }}
        aria-label={`Remove ${file.name}`}
        className="bg-background/90 text-foreground hover:bg-background pointer-coarse:size-9 absolute -right-1 -top-1 grid size-6 place-items-center rounded-full shadow-sm"
      >
        <XIcon className="size-3" />
      </button>
    </li>
  );
}

/** The files staged for the next send, above the field they will be sent from. */
function ComposerAttachments() {
  const { attachments, attachmentError, onRemoveAttachment } = useChrome();
  // Focus has to move after the removal commits, not during the click: at capacity the attach
  // control is still disabled in the render the click happened in, and a disabled button cannot
  // take focus -- which is exactly when a keyboard reader is most likely to be removing a file.
  const restoreFocus = useRef(false);
  useEffect(() => {
    if (!restoreFocus.current) return;
    restoreFocus.current = false;
    document.querySelector<HTMLButtonElement>("[data-slot=composer-attach]")?.focus();
  }, [attachments]);
  if (attachments.length === 0 && !attachmentError) return null;
  return (
    <div className="mb-1.5">
      {/* Announced: a file added by paste or drop has no other confirmation, and the paste handler
          consumes the event so nothing else reports it. */}
      {attachments.length > 0 && (
        <ul
          data-slot="composer-attachments"
          aria-live="polite"
          aria-label={`${attachments.length} file${attachments.length === 1 ? "" : "s"} attached`}
          className="flex flex-wrap gap-1.5"
        >
          {attachments.map((file, index) => {
            // The same file can legitimately be staged twice, so position is part of the identity.
            const key = `${index}:${file.name}:${file.size}:${file.lastModified}`;
            if (file.type.startsWith("image/")) {
              return (
                <ComposerImageChip
                  key={key}
                  file={file}
                  index={index}
                  onRemove={onRemoveAttachment}
                  restoreFocusRef={restoreFocus}
                />
              );
            }
            return (
              <li
                key={key}
                className="border-border bg-card flex min-w-0 items-center gap-1.5 rounded-lg border py-1 pe-1 ps-2 text-xs"
              >
                <PaperclipIcon aria-hidden="true" className="size-3.5 shrink-0" />
                <span className="max-w-40 truncate" title={file.name}>{file.name}</span>
                <span className="text-muted-foreground shrink-0 tabular-nums">
                  {readableSize(file.size)}
                </span>
                <button
                  type="button"
                  onClick={() => {
                    // Removing the last chip unmounts this list, so hand focus to the control that
                    // put the file here rather than dropping the reader onto the document body.
                    restoreFocus.current = true;
                    onRemoveAttachment(index);
                  }}
                  aria-label={`Remove ${file.name}`}
                  className="text-muted-foreground hover:text-foreground hover:bg-muted grid size-6 shrink-0 place-items-center rounded transition-colors"
                >
                  <XIcon className="size-3.5" />
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {/* `alert` rather than `status`: this line mounts in response to the reader's own action, and
          a politely-announced live region that did not exist a moment ago is usually not read. */}
      {attachmentError && (
        <p data-slot="composer-attachment-error" role="alert" className="text-destructive mt-1 text-xs">
          {attachmentError}
        </p>
      )}
    </div>
  );
}

/** The composer, or — for a Viewer — the line that says why there is none. */
function Footer() {
  const {
    attachments,
    canSend,
    companionName,
    hint,
    onAttach,
    onSendPress,
    onSendClick,
    onStop,
    stopping,
    canStop,
  } = useChrome();
  const fileInput = useRef<HTMLInputElement | null>(null);
  const [dragging, setDragging] = useState(false);

  /** When a press last stopped, so the click that press produces is not read as a second Stop. */
  const stopPressedAt = useRef(0);

  /**
   * Stop shares the composer row with Send and so shares THE-346: a tap blurs the field, the
   * keyboard starts closing, the visual viewport grows, the row is laid out again, and the `click`
   * lands where the button used to be. Send was moved onto the press for exactly this; Stop was
   * left on `click` alone, which made it the one control that could not interrupt a wedged turn
   * from a phone — the case where interrupting matters most. Refusing the default keeps focus in
   * the field, which is what stops the keyboard closing under the finger to begin with.
   */
  const stopOnPress = useCallback((event: ReactPointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    stopPressedAt.current = Date.now();
    onStop();
  }, [onStop]);

  /**
   * The browser still delivers a click after the press. Unlike Send there is no primitive handler
   * composed behind this button, so the click must simply not run a second Stop. A click with no
   * recent press — a keyboard activating the focused button — is a real Stop and goes through.
   */
  const stopOnClick = useCallback(() => {
    if (Date.now() - stopPressedAt.current <= PRESS_CLICK_MS) {
      stopPressedAt.current = 0;
      return;
    }
    onStop();
  }, [onStop]);
  const atCapacity = attachments.length >= COMPANION_MESSAGE_ATTACHMENT_MAX_COUNT;

  // A screenshot pasted straight into the field is the shortest path from "look at this" to a sent
  // file, so a paste that carries files is an attach rather than a no-op that drops them.
  const onPaste = useCallback((event: ReactClipboardEvent<HTMLDivElement>) => {
    const files = Array.from(event.clipboardData?.files ?? []);
    if (files.length === 0) return;
    event.preventDefault();
    onAttach(files);
  }, [onAttach]);

  if (!canSend) {
    return (
      <footer className="border-border text-muted-foreground shrink-0 border-t px-(--chat-gutter) py-3 text-xs">
        Viewer access is read-only. Sending, run, and desktop stay with the Owner and Editors.
      </footer>
    );
  }
  return (
    <ComposerPrimitive.Root className="border-border bg-background shrink-0 border-t px-(--chat-gutter) pt-2.5 pb-[max(14px,env(safe-area-inset-bottom,0px))]">
      <div
        data-slot="composer-root"
        className="mx-auto w-full max-w-(--thread-max-width)"
        onPaste={onPaste}
        onDragOver={(event) => {
          if (!event.dataTransfer.types.includes("Files")) return;
          event.preventDefault();
          setDragging(true);
        }}
        // `dragleave` bubbles, so moving the pointer from the composer into the chips, the field,
        // or a button would otherwise clear the highlight and the next `dragover` would set it
        // again -- a blink exactly when it is meant to be a steady "this drop will be accepted".
        onDragLeave={(event) => {
          const next = event.relatedTarget;
          if (next instanceof Node && event.currentTarget.contains(next)) return;
          setDragging(false);
        }}
        onDrop={(event) => {
          setDragging(false);
          if (!event.dataTransfer.files.length) return;
          event.preventDefault();
          onAttach(event.dataTransfer.files);
        }}
      >
        <ComposerAttachments />
        {/* The field and its send control are one object, so the composer reads as one place to type. */}
        <div
          data-slot="composer-field"
          className={cn(
            "border-input focus-within:border-ring bg-card flex items-end gap-2 rounded-2xl border py-1.5 pe-1.5 ps-1.5",
            dragging && "border-ring bg-muted",
          )}
        >
          <input
            ref={fileInput}
            type="file"
            multiple
            hidden
            // The picker offers the same set the API accepts; the bytes still decide the stored type.
            accept="image/png,image/jpeg,image/webp,image/gif,application/pdf,text/csv,text/plain,text/markdown,application/json,.md,.markdown"
            onChange={(event) => {
              onAttach(event.target.files);
              // Clearing the input is what lets the same file be picked twice in a row.
              event.target.value = "";
            }}
          />
          <button
            type="button"
            data-slot="composer-attach"
            onClick={() => fileInput.current?.click()}
            disabled={atCapacity}
            aria-label={atCapacity
              ? `A message can carry at most ${COMPANION_MESSAGE_ATTACHMENT_MAX_COUNT} files`
              : "Attach files"}
            className="text-muted-foreground hover:text-foreground hover:bg-muted disabled:hover:bg-transparent pointer-coarse:size-11 grid size-8 shrink-0 place-items-center self-end rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-50"
          >
            <PlusIcon className="size-4" />
          </button>
          <ComposerPrimitive.Input
            className="text-foreground max-h-42 min-h-8 flex-1 resize-none overscroll-contain bg-transparent py-1 outline-none"
            placeholder={`Message ${companionName}`}
            aria-label={`Message ${companionName}`}
            rows={1}
            // A phone keyboard labels its return key from this hint. Without it a textarea offers
            // `return`, which reads as a new line even though Enter sends here; Shift + Enter is
            // still the new line, on a phone as on a desktop.
            enterKeyHint="send"
            // Escape belongs to the thread, not to the draft: a stray keystroke must never discard
            // text this composer is holding on to.
            cancelOnEscape={false}
          />
          {canStop ? (
            <button
              type="button"
              data-slot="composer-stop"
              className="bg-foreground text-background hover:bg-foreground/90 disabled:bg-muted disabled:text-muted-foreground pointer-coarse:size-11 grid size-8 shrink-0 place-items-center rounded-full transition-colors disabled:cursor-not-allowed"
              aria-label={stopping ? "Stopping" : "Stop"}
              aria-busy={stopping || undefined}
              disabled={stopping}
              onPointerDown={stopOnPress}
              onClick={stopOnClick}
            >
              <SquareIcon className="size-3 fill-current" />
            </button>
          ) : null}
          <ComposerPrimitive.Send
            // THE-346: Send is the control the composer exists for, and a 32px square is not a thumb
            // target. The field grows around it rather than the control shrinking, and a mouse keeps
            // the compact square it points at precisely.
            className="bg-primary text-primary-foreground hover:bg-primary/90 disabled:bg-muted disabled:text-muted-foreground pointer-coarse:size-11 grid size-8 shrink-0 place-items-center rounded-full transition-colors disabled:cursor-not-allowed"
            aria-label="Send message"
            onPointerDown={onSendPress}
            onClick={onSendClick}
          >
            <ArrowUpIcon className="size-4" />
          </ComposerPrimitive.Send>
        </div>
        <p data-slot="composer-hint" className="text-muted-foreground mt-1.5 text-xs">{hint}</p>
      </div>
    </ComposerPrimitive.Root>
  );
}
