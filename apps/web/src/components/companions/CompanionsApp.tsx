"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useRouter } from "next/navigation";
import type {
  Companion,
  CompanionDesktop,
  CompanionPluginAccount,
  CompanionProvidersResponse,
  CompanionThread as Thread,
  CompanionTranscriptEntry,
  CompanionTurn,
  CompanionRoutine,
  CompanionTrigger,
  CompanionTriggerProviderAccount,
} from "@companion/contracts";
import {
  COMPANION_PROVIDER_CATALOG,
  companionMessageEventId,
  declaredCompanionAttachmentContentType,
  sanitizeCompanionAttachmentFilename,
} from "@companion/contracts";
import type { OrgVM } from "@/lib/types";
import { ApiFetchError } from "@/lib/apiClient";
import {
  companionProviderSettingsCache,
  type CompanionProviderSettingsCacheSnapshot,
} from "@/lib/companionProviderSettingsCache";
import {
  cancelCompanionTurn,
  collapseLoadedRoutineNotifyEntries,
  deleteCompanion,
  duplicateCompanion,
  getCompanionRuntime,
  getCompanionThread,
  getOlderCompanionThreadWindow,
  listCompanions,
  listCompanionProviders,
  listCompanionRoutines,
  listCompanionTriggerRuns,
  listCompanionTriggers,
  openCompanionDesktop,
  readCompanionTriggerRun,
  sendCompanionMessage,
  setCompanionProvider,
  updateCompanionMemberState,
  type SyncedCompanionThread,
} from "@/lib/companions";
import { Icon } from "../Icon";
import { Dialog } from "../org/primitives";
import { CompanionProvidersDialog } from "./CompanionProvidersDialog";
import { CompanionPlugins } from "./CompanionPlugins";
import { CompanionTriggerProvidersDialog } from "./CompanionTriggerProvidersDialog";
import { CompanionSettings } from "./CompanionSettings";
import type { CompanionContextSkill } from "./CompanionContext";
import { CompanionThread } from "./CompanionThread";
import type { CompanionTriggerHistoryApi } from "./CompanionTriggerHistoryTypes";
import { NewCompanionDialog } from "./NewCompanionDialog";
import { ShareCompanionDialog } from "./ShareCompanionDialog";
import { companionStatus } from "./status";
import { replyExpected } from "./transcript";
import { Onboarding } from "../org/Onboarding";
import { useOrgActions } from "../org/useOrgActions";
import { Sidebar } from "../skills/Sidebar";
import { skillsRouteHref, type SkillsLibrary } from "../skills/route";
import type { TreeRow } from "../skills/sidebarTree";

/** Stable conversations re-read the PostgreSQL projection without keeping the UI noisy. */
const READ_MODEL_POLL_MS = 8_000;
/**
 * Active, queued, interrupted, and lifecycle-transitioning work is projected every three seconds.
 * Every request is PostgreSQL-only; polling never observes or wakes Box.
 */
const PENDING_POLL_MS = 3_000;
/**
 * How often the conversation list re-reads every thread's last line. It is slow on purpose: this is
 * the sidebar, not the open thread, and it is the control-plane read model, so it never contacts or
 * wakes a Box for any Companion — including the ones nobody has opened.
 */
const LIST_POLL_MS = 45_000;

const companionTriggerHistoryApi: CompanionTriggerHistoryApi = {
  listCompanionTriggerRuns,
  readCompanionTriggerRun,
};
/**
 * The list cadence while any Companion in it is working — replying, transitioning, or carrying a
 * pending operation — so sidebar avatars and a requested delete track what is happening without a
 * thread open. Still the same PostgreSQL read model; the faster cadence never touches Box either.
 */
const LIST_ACTIVE_POLL_MS = 8_000;
/**
 * Where a failing open-thread poll backs off to. The surface keeps trying through transient
 * control-plane failures, but not at the fast cadence, which against a dead proxy would be thirty
 * doomed requests a minute.
 */
const MAX_POLL_BACKOFF_MS = 15_000;

/** Polls skip hidden tabs: nobody is reading, so control-plane traffic can wait. */
// SAFETY-free gate: SSR renders nothing, so presence of `document` decides portal use.
// oxlint-disable-next-line anti-slop/no-runtime-typeof -- legacy pattern predating the incremental anti-slop gate
const hasDocument = typeof document !== "undefined";

function pageHidden(): boolean {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- legacy pattern predating the incremental anti-slop gate
  return hasDocument && document.visibilityState === "hidden";
}

export interface CompanionNavigation {
  mineTreeRows: TreeRow[];
  orgTreeRows: TreeRow[];
  mineCount: number;
  orgCount: number;
  installedCount: number;
  installedUpdateCount: number;
  localUpdateCount: number;
  archivedCount: number;
}

/**
 * Keep a preview a response did not carry. Every mutation answers about the settings it just wrote
 * and reports `last_message: null`, so replacing a row wholesale would blank the line the sidebar is
 * showing until the next list poll. The projection only ever arrives from a read, so a null here
 * means "not answered", never "the thread is empty".
 */
function mergeCompanion(previous: Companion, next: Companion): Companion {
  return next.last_message === null && previous.last_message !== null
    ? { ...next, last_message: previous.last_message }
    : next;
}

/** Keep a committed send visible while the PostgreSQL thread poll catches up with its bounded ACK. */
/** What the accepted send carried, so its chips survive the swap to the durable entry. */
function acceptedAttachments(
  files: readonly File[],
  clientMessageId: string,
): CompanionTranscriptEntry["attachments"] {
  return files.flatMap((file, position) => {
    const contentType = declaredCompanionAttachmentContentType({
      type: file.type,
      name: file.name,
    });
    if (!contentType) return [];
    return [{
      id: `pending-${clientMessageId}-${position}`,
      kind: "user_upload" as const,
      content_type: contentType,
      byte_size: file.size,
      filename: sanitizeCompanionAttachmentFilename({ filename: file.name, position, contentType }),
      position,
      availability: "available" as const,
      expires_at: null,
    }];
  });
}

function projectAcceptedMessage(input: {
  thread: Thread;
  turn: CompanionTurn;
  content: string;
  attachments?: CompanionTranscriptEntry["attachments"];
}): Thread {
  const eventId = companionMessageEventId(input.turn.client_message_id);
  const alreadyProjected = input.thread.entries.some((entry) => entry.event_id === eventId);
  const entries = alreadyProjected
    ? input.thread.entries
    : [...input.thread.entries, {
        event_id: eventId,
        ordinal: input.thread.entries.reduce((latest, entry) => Math.max(latest, entry.ordinal), -1) + 1,
        role: "user",
        content: input.content,
        reasoning: null,
        author_id: input.thread.viewer_id,
        author_name: null,
        tool: null,
        decision: null,
        routine: null,
        trigger: null,
        turn_id: input.turn.id,
        queued: input.turn.status === "queued",
        // The 202 carries the turn, not the stored files, so this stands in with what the send
        // carried. Without it the just-sent message loses its chips until the next poll.
        attachments: input.attachments ?? [],
        created_at: input.turn.created_at,
      } satisfies CompanionTranscriptEntry];

  let activeTurn = input.thread.active_turn;
  let interruptedTurn = input.thread.interrupted_turn;
  let queuedCount = input.thread.queued_count;
  if (input.turn.status === "queued") {
    if (!alreadyProjected) queuedCount += 1;
  } else if (["starting", "dispatching", "running", "needs_input"].includes(input.turn.status)) {
    activeTurn = input.turn;
  } else if (input.turn.status === "interrupted") {
    interruptedTurn = input.turn;
  }

  return {
    ...input.thread,
    entries,
    active_turn: activeTurn,
    queued_count: queuedCount,
    interrupted_turn: interruptedTurn,
    last_message_at: alreadyProjected ? input.thread.last_message_at : input.turn.created_at,
  };
}

const CONTEXT_OPEN_KEY = "companions:context-open";

/**
 * Whether the context panel starts open. A wide screen has room for it beside the conversation, so
 * that is the default there; on a narrow one the panel comes over the thread, so it waits to be asked
 * for. An explicit choice, once made, wins over both.
 */
function readContextOpen(): boolean {
  try {
    const stored = window.localStorage.getItem(CONTEXT_OPEN_KEY);
    if (stored === "true") return true;
    if (stored === "false") return false;
    return window.matchMedia("(min-width: 1024px)").matches;
  } catch {
    return false;
  }
}

function writeContextOpen(open: boolean): void {
  try {
    window.localStorage.setItem(CONTEXT_OPEN_KEY, open ? "true" : "false");
  } catch {
    // A device that cannot remember the preference simply asks again next time.
  }
}

function threadUrl(companionId: string | null): void {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- legacy pattern predating the incremental anti-slop gate
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  if (companionId) {
    url.searchParams.set("companion", companionId);
    url.searchParams.delete("view");
  }
  else url.searchParams.delete("companion");
  window.history.replaceState(null, "", `${url.pathname}${url.search}`);
}

export function CompanionsApp({
  orgs,
  currentOrg,
  viewer,
  navigation,
  skills,
  initialCompanions,
  initialProviders,
  initialPlugins,
  initialTriggerProviderAccounts = [],
  initialCompanionId,
  initialSettingsCompanionId,
  initialPluginsOpen = false,
  memberTimezone = null,
}: {
  orgs: OrgVM[];
  currentOrg: OrgVM;
  /** The signed-in reader: whose messages are their own, and whose face the footer row carries. */
  viewer: { id: string; name: string; email: string; initials: string; avatarUrl: string | null };
  navigation: CompanionNavigation;
  /** Every skill this reader can see, so the context panel can name the ones a Companion stages. */
  skills: CompanionContextSkill[];
  initialCompanions: Companion[];
  initialProviders: CompanionProvidersResponse | null;
  initialPlugins: CompanionPluginAccount[];
  initialTriggerProviderAccounts?: CompanionTriggerProviderAccount[];
  initialCompanionId?: string | null;
  initialSettingsCompanionId?: string | null;
  initialPluginsOpen?: boolean;
  /** Stored member zone; null falls back to this browser until the member saves Preferences. */
  memberTimezone?: string | null;
}) {
  const router = useRouter();
  const orgActions = useOrgActions();
  const initialProviderCacheRef = useRef<
    CompanionProviderSettingsCacheSnapshot | null | undefined
  >(undefined);
  if (initialProviderCacheRef.current === undefined) {
    initialProviderCacheRef.current = initialProviders
      ? null
      : companionProviderSettingsCache.read(viewer.id, currentOrg.id);
  }
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [companions, setCompanions] = useState(initialCompanions);
  const [providers, setProviders] = useState<CompanionProvidersResponse | null>(
    initialProviders ?? initialProviderCacheRef.current?.providers ?? null,
  );
  const [providersError, setProvidersError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [managingProviders, setManagingProviders] = useState(false);
  const [pluginsOpen, setPluginsOpen] = useState(initialPluginsOpen && !initialCompanionId);
  const [pluginAccounts, setPluginAccounts] = useState(initialPlugins);
  const [triggerProviderAccounts, setTriggerProviderAccounts] = useState(
    initialTriggerProviderAccounts,
  );
  const [triggerProvidersOpen, setTriggerProvidersOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sharing, setSharing] = useState<Companion | null>(null);
  /** The Companion whose kebab Delete is waiting on the confirm dialog. */
  const [deletingCompanion, setDeletingCompanion] = useState<Companion | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [settingsId, setSettingsId] = useState<string | null>(
    () => initialCompanions.some((item) => item.id === initialSettingsCompanionId)
      ? initialSettingsCompanionId ?? null
      : null,
  );
  const [openedId, setOpenedId] = useState<string | null>(
    () => !initialSettingsCompanionId
      && initialCompanions.some((item) => item.id === initialCompanionId)
      ? initialCompanionId ?? null
      : null,
  );
  const [thread, setThread] = useState<SyncedCompanionThread | null>(null);
  const [loadingOlderThread, setLoadingOlderThread] = useState(false);
  const [threadError, setThreadError] = useState<string | null>(null);
  const [routines, setRoutines] = useState<CompanionRoutine[]>([]);
  const [triggers, setTriggers] = useState<CompanionTrigger[]>([]);
  /**
   * Consecutive open-thread polls that failed. One miss is network weather and changes nothing; from
   * the second the surface says "Reconnecting" beside the chip and the poll cadence backs off, and
   * the first answered poll clears both. Kept separate from `threadError` deliberately: a transcript
   * already on screen is not wrong, so a failed refresh must not cover it with an alert.
   */
  const [threadPollFailures, setThreadPollFailures] = useState(0);
  /** This reader's watermark when the open thread was opened; the "New" divider sits just past it. */
  const [lastReadOrdinal, setLastReadOrdinal] = useState<number | null>(null);
  /** How far the thread went when it was opened, so the divider marks reading rather than arrivals. */
  const [openedThroughOrdinal, setOpenedThroughOrdinal] = useState<number | null>(null);
  /**
   * Why the last desktop handoff opened nothing. It is kept apart from `threadError` because the
   * thread poll clears that one every few seconds, which would erase this answer before
   * anyone could read it and leave a failed handoff looking like nothing happened at all.
   */
  const [desktopError, setDesktopError] = useState<string | null>(null);
  const [sendingCompanionId, setSendingCompanionId] = useState<string | null>(null);
  const [openingDesktop, setOpeningDesktop] = useState(false);
  /**
   * Whether a runner keeps the context panel beside the conversation. It is a preference rather than
   * a property of one Companion, so it survives moving between threads and reloads: an operator who
   * wants the screen and the skills in view wants them for the next Companion too. It starts closed
   * so server markup and the first client paint agree, and the stored preference — open unless it
   * was closed — arrives once the client owns the page.
   */
  const [contextOpen, setContextOpen] = useState(false);
  /**
   * The one join the open panel is showing, and the Companion it was minted for. Box rotates the
   * stream token on every state change, so a desktop is held for exactly as long as the join that
   * minted it is on screen and is never stored: closing the panel, moving to another Companion, and a
   * Box that stops all drop it.
   *
   * The Companion is part of the state rather than assumed, because the panel preference outlives one
   * thread. Without it, opening another Companion would frame the previous one's screen — and its
   * secret-bearing URL — under the new Companion's name until the next mint answered.
   */
  const [contextJoin, setContextJoin] = useState<{
    companionId: string;
    desktop: CompanionDesktop | null;
    error: string | null;
    joining: boolean;
  } | null>(null);
  const threadRequestRef = useRef(0);
  const threadRef = useRef<SyncedCompanionThread | null>(null);
  const historyModeRef = useRef(false);
  /** Whether the open thread has a transcript on screen, for failure handling without dep churn. */
  const threadLoadedRef = useRef(false);
  /** The thread currently on screen, available to async completions without a stale render closure. */
  const openedIdRef = useRef(openedId);
  const providerRequestRef = useRef(0);
  /** The Companion whose read watermark has already been captured for the open thread. */
  const capturedReadRef = useRef<string | null>(null);
  /**
   * Companions written since the list poll now in flight went out. The poll's snapshot is older than
   * those writes, so applying it would put a row back the way it was before a pin, a wake, or a
   * settings save the reader just made, until the next poll 45 seconds later undid it again.
   */
  const writtenRef = useRef(new Set<string>());
  /** Newest panel join, so a slower mint cannot put its stream on screen after a newer one. */
  const contextJoinRef = useRef(0);
  /** Newest runtime read per Companion, so a slower one cannot answer over it. */
  const companionReadRef = useRef(new Map<string, number>());
  /** The current PostgreSQL thread read; duplicate poll ticks skip it, but sends never wait on it. */
  const threadReadRef = useRef<{ companionId: string; requestId: number } | null>(null);
  const rowRefs = useRef(new Map<string, HTMLButtonElement>());
  const movedFocusRef = useRef<string | null>(null);
  /**
   * One request id per Companion, minted on the first confirm and kept across retries, so however
   * many times the delete is asked for the control plane sees exactly one operation.
   */
  const deleteRequestIds = useRef(new Map<string, string>());
  const noop = () => {};

  useLayoutEffect(() => {
    const companionId = movedFocusRef.current;
    if (!companionId) return;
    movedFocusRef.current = null;
    const row = rowRefs.current.get(companionId);
    if (row?.isConnected) row.focus();
    // A hidden row leaves the roster (its Hidden disclosure starts collapsed), so focus falls to
    // the sidebar's create affordance rather than dropping to the document body.
    else document.querySelector<HTMLButtonElement>(".side .cmpnav__add")?.focus();
  }, [companions]);

  const opened = useMemo(
    () => companions.find((companion) => companion.id === openedId) ?? null,
    [companions, openedId],
  );
  const presentedThread = useMemo<Thread | null>(() => thread === null
    ? null
    : {
        ...thread,
        entries: collapseLoadedRoutineNotifyEntries(
          thread.entries,
          thread.client_sync?.notify_returns ?? [],
        ),
      }, [thread]);
  const settingsCompanion = useMemo(
    () => companions.find((companion) => companion.id === settingsId) ?? null,
    [companions, settingsId],
  );
  const canRunOpened = opened !== null && opened.access !== "viewer";
  const openedAwake = opened?.runtime.state === "running";
  // A lifecycle the control plane is still resolving. `error` is not one of these: it is where a
  // failed transition settles, and its reason is already on screen.
  const openedPending = opened?.runtime.state === "provisioning" || opened?.runtime.state === "stopping";
  const sending = sendingCompanionId === openedId;
  const threadWorkPending = thread?.companion_id === openedId
    && (
      thread.active_turn !== null
      || thread.interrupted_turn !== null
      || thread.queued_count > 0
    );

  const providerName = (providerId: string) =>
    (providers?.catalog ?? COMPANION_PROVIDER_CATALOG)
      .find((provider) => provider.id === providerId)?.name ?? providerId;
  const fallbackProvider = providers?.default_provider_id
    ?? providers?.connections[0]?.provider_id
    ?? "";
  const canManageProviders = providers?.can_manage
    ?? (currentOrg.myRole === "owner" || currentOrg.myRole === "admin");
  const updateProviders = useCallback((next: CompanionProvidersResponse) => {
    setProviders(
      companionProviderSettingsCache.updateAfterMutation(viewer.id, currentOrg.id, next),
    );
  }, [currentOrg.id, viewer.id]);
  const loadProviderSettings = useCallback(async () => {
    const requestId = ++providerRequestRef.current;
    setProvidersError(null);
    try {
      const next = await companionProviderSettingsCache.refresh(
        viewer.id,
        currentOrg.id,
        () => listCompanionProviders(currentOrg.id),
      );
      if (requestId === providerRequestRef.current) setProviders(next);
    } catch (cause) {
      if (requestId !== providerRequestRef.current) return;
      setProvidersError(
        cause instanceof Error ? cause.message : "Provider settings could not be loaded.",
      );
    }
  }, [currentOrg.id, viewer.id]);

  const sidebarCompanions = useMemo(
    () => companions.map((companion) => {
      const status = companionStatus(companion.runtime.state);
      return {
        id: companion.id,
        name: companion.name,
        icon: companion.icon,
        status: status.label,
        tone: status.tone,
        // The Pi-ACKed replying fact drives the avatar's thinking animation. The open thread's own
        // fast poll is the freshest carrier of it; every other row reads the roster projection.
        replying: companion.id === openedId && thread?.companion_id === openedId
          ? replyExpected(thread)
          : companion.runtime.replying,
        // A routine's or trigger's prompt is hidden everywhere it could be mistaken for something
        // a member typed, so the list names the origin exactly as the thread header does.
        preview: companion.last_message?.routine_name
          ? `Routine: ${companion.last_message.routine_name}`
          : companion.last_message?.trigger_name
            ? `Trigger: ${companion.last_message.trigger_name}`
            : companion.last_message?.preview ?? null,
        previewAt: companion.last_message?.created_at ?? null,
        // The reader's own watermark, from the control plane. The thread on screen is being read
        // right now, so it is never the one with a dot on it.
        unread: companion.id !== openedId && companion.unread,
        access: companion.access,
        pinned: companion.pinned,
        hidden: companion.hidden,
      };
    }),
    [companions, openedId, thread],
  );

  /**
   * Put one Companion back where it already was. Reads run on a poll, and the roster's order is the
   * server's — pin age, then recency, then name — so re-sorting here on every answer would fight the
   * list poll and make rows jump under the cursor. The preview is merged because a mutation answers
   * about what it just wrote and would otherwise blank the line the conversation list is showing.
   */
  const replaceCompanion = useCallback((next: Companion) => {
    writtenRef.current.add(next.id);
    setCompanions((current) =>
      current.map((item) => item.id === next.id ? mergeCompanion(item, next) : item));
  }, []);

  /**
   * Put one Companion back and let it move. Pin and hide are the writes that change where a row
   * belongs, so this is the only path that re-sorts, and it sorts the way the server does.
   */
  const resortCompanion = useCallback((next: Companion) => {
    writtenRef.current.add(next.id);
    setCompanions((current) => {
      const previous = current.find((item) => item.id === next.id);
      const merged = previous ? mergeCompanion(previous, next) : next;
      const without = current.filter((item) => item.id !== next.id);
      return [merged, ...without].sort((left, right) => {
        if (left.pinned !== right.pinned) return left.pinned ? -1 : 1;
        return Date.parse(right.updated_at) - Date.parse(left.updated_at);
      });
    });
  }, []);

  const applyMemberState = async (
    companion: Companion,
    patch: { pinned?: boolean; hidden?: boolean; unread?: boolean },
  ) => {
    setBusy(true);
    setError(null);
    try {
      const next = await updateCompanionMemberState(currentOrg.id, companion.id, patch);
      if (patch.hidden !== undefined) movedFocusRef.current = companion.id;
      resortCompanion(next);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not update this Companion.");
    } finally {
      setBusy(false);
    }
  };

  const onDuplicate = async (companion: Companion) => {
    setBusy(true);
    setError(null);
    try {
      const cloned = await duplicateCompanion(currentOrg.id, companion.id);
      setCompanions((current) => [cloned, ...current]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not duplicate this Companion.");
    } finally {
      setBusy(false);
    }
  };

  const openCompanion = (companion: Companion) => {
    threadRequestRef.current += 1;
    openedIdRef.current = companion.id;
    setOpenedId(companion.id);
    threadRef.current = null;
    historyModeRef.current = false;
    setThread(null);
    setThreadError(null);
    setRoutines([]);
    setTriggers([]);
    setDesktopError(null);
    setPluginsOpen(false);
    setSettingsId(null);
    threadUrl(companion.id);
    if (companion.unread) {
      setCompanions((current) => current.map((item) =>
        item.id === companion.id ? { ...item, unread: false } : item));
    }
  };

  const closeThread = () => {
    const wasOpen = openedId;
    threadRequestRef.current += 1;
    openedIdRef.current = null;
    setOpenedId(null);
    threadRef.current = null;
    historyModeRef.current = false;
    setThread(null);
    setThreadError(null);
    setRoutines([]);
    setTriggers([]);
    setDesktopError(null);
    threadUrl(null);
    // Leaving the thread unmounts the back button, so focus returns to the row it came from.
    window.requestAnimationFrame(() => {
      (wasOpen ? rowRefs.current.get(wasOpen) : null)?.focus();
    });
  };

  /**
   * The confirmed kebab Delete. The DELETE is a 202 that enqueues durable intent — the row projects
   * Stopping immediately and drops once the runtime confirms and the control plane stops returning
   * it; the fast list cadence tracks that. `CompanionSettings` keeps its own delete flow, which
   * additionally owns the deletion poll for the page that stays on the deleted Companion.
   */
  const confirmDelete = async () => {
    const companion = deletingCompanion;
    if (!companion) return;
    const requestId = deleteRequestIds.current.get(companion.id) ?? crypto.randomUUID();
    deleteRequestIds.current.set(companion.id, requestId);
    setDeleteBusy(true);
    setError(null);
    try {
      await deleteCompanion(currentOrg.id, companion.id, requestId);
      setDeletingCompanion(null);
      if (openedIdRef.current === companion.id) closeThread();
      void refreshCompanion(companion.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "This Companion could not be deleted.");
      setDeletingCompanion(null);
    } finally {
      setDeleteBusy(false);
    }
  };

  const openPlugins = () => {
    setPluginsOpen(true);
    // Plugins is now reachable from the sidebar, so it can be asked for while a thread is open — and
    // the thread wins the render. Leaving the thread open made the entry look dead.
    threadRequestRef.current += 1;
    openedIdRef.current = null;
    setOpenedId(null);
    threadRef.current = null;
    historyModeRef.current = false;
    setThread(null);
    setThreadError(null);
    setRoutines([]);
    setTriggers([]);
    setSettingsId(null);
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- legacy pattern predating the incremental anti-slop gate
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    url.searchParams.delete("companion");
    url.searchParams.set("view", "plugins");
    window.history.replaceState(null, "", `${url.pathname}${url.search}`);
  };

  const closePlugins = () => {
    setPluginsOpen(false);
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- legacy pattern predating the incremental anti-slop gate
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    url.searchParams.delete("view");
    window.history.replaceState(null, "", `${url.pathname}${url.search}`);
  };

  const closeSettings = () => {
    setSettingsId(null);
    router.push("/companions");
  };

  /** One bounded bootstrap or incremental PostgreSQL-only refresh of the open thread. */
  const refreshThread = useCallback(async () => {
    if (!openedId) return;
    const currentRead = threadReadRef.current;
    if (currentRead?.companionId === openedId && currentRead.requestId === threadRequestRef.current) {
      return;
    }
    // The request id is claimed only by the call that actually goes out. A duplicate polling tick
    // must not invalidate the read already in flight, including the payload that carries where this
    // reader left off.
    const requestId = ++threadRequestRef.current;
    threadReadRef.current = { companionId: openedId, requestId };
    try {
      const current = threadRef.current?.companion_id === openedId
        ? threadRef.current
        : null;
      const next = await getCompanionThread(currentOrg.id, openedId, current?.client_sync
        ? {
            cursor: current.client_sync.cursor,
            current,
            preserveHistory: historyModeRef.current,
          }
        : undefined);
      if (next && requestId === threadRequestRef.current) {
        threadRef.current = next;
        setThread(next);
        setThreadError(null);
        setThreadPollFailures(0);
        // The control plane advances this member's watermark as it answers. Opening from the list
        // already cleared the row optimistically; this covers the thread nobody clicked into — a
        // deep link — which would otherwise keep a dot on a thread that is on screen.
        setCompanions((current) => current.map((item) =>
          item.id === openedId && item.unread ? { ...item, unread: false } : item));
      }
    } catch (cause) {
      if (requestId === threadRequestRef.current) {
        // A timeout, a network failure, or a 5xx is connectivity weather: count it toward the
        // reconnect indicator and back the cadence off — whether or not a transcript loaded yet,
        // hammering a dead network at the fast cadence helps nobody. A stable 4xx is a verdict,
        // not weather, and its message must reach the reader instead of an eternal quiet
        // "Reconnecting". With no transcript yet, any failure is also the page's failure.
        const status = cause instanceof ApiFetchError ? cause.status : null;
        const connectivity = status === null || status === 408 || status >= 500;
        if (connectivity) setThreadPollFailures((failures) => failures + 1);
        if (!connectivity || !threadLoadedRef.current) {
          setThreadError(cause instanceof Error ? cause.message : "This thread could not be loaded.");
        }
      }
    } finally {
      if (threadReadRef.current?.requestId === requestId) threadReadRef.current = null;
    }
  }, [currentOrg.id, openedId]);

  useEffect(() => {
    if (!openedId) {
      setRoutines([]);
      setTriggers([]);
      return;
    }
    const companionId = openedId;
    let cancelled = false;
    void listCompanionRoutines(currentOrg.id, companionId).then((next) => {
      if (!cancelled && openedIdRef.current === companionId) {
        setRoutines(Array.isArray(next) ? next : []);
      }
    }).catch(() => {
      if (!cancelled && openedIdRef.current === companionId) setRoutines([]);
    });
    void listCompanionTriggers(currentOrg.id, companionId).then((next) => {
      if (!cancelled && openedIdRef.current === companionId) {
        setTriggers(Array.isArray(next) ? next : []);
      }
    }).catch(() => {
      if (!cancelled && openedIdRef.current === companionId) setTriggers([]);
    });
    return () => {
      cancelled = true;
    };
  }, [currentOrg.id, openedId]);

  // The panel preference is per device, so it can only be read once the client owns the page.
  useEffect(() => setContextOpen(readContextOpen()), []);

  // The live pi.dev catalog may take up to its bounded network timeout on a cold API process. A
  // fresh per-reader/workspace cache avoids that wait on return visits; stale data remains usable
  // while one shared refresh runs in the background.
  useEffect(() => {
    if (initialProviders) {
      companionProviderSettingsCache.set(viewer.id, currentOrg.id, initialProviders);
      return;
    }
    if (!initialProviderCacheRef.current?.fresh) {
      // Another mount may have completed the shared refresh between this render and its effect.
      const latest = companionProviderSettingsCache.read(viewer.id, currentOrg.id);
      if (latest?.fresh) setProviders(latest.providers);
      else void loadProviderSettings();
    }
    return () => {
      providerRequestRef.current += 1;
    };
  }, [currentOrg.id, initialProviders, loadProviderSettings, viewer.id]);

  /**
   * Where this reader left off, taken from the first thread payload after opening: the control plane
   * reports the watermark as it stood before that read advanced it, and that read is also what
   * advances it. So it is captured exactly once per Companion — keyed by id rather than by the value
   * being null, because null is a real answer (a first visit) and a second poll would otherwise
   * capture the watermark the first one had just moved, drawing a divider above a reply the reader
   * is watching arrive. The same key is what re-captures when the sidebar moves to another thread.
   */
  useEffect(() => {
    if (!openedId) {
      capturedReadRef.current = null;
      setLastReadOrdinal(null);
      setOpenedThroughOrdinal(null);
      return;
    }
    if (thread?.companion_id !== openedId || capturedReadRef.current === openedId) return;
    capturedReadRef.current = openedId;
    setLastReadOrdinal(thread.last_read_ordinal);
    setOpenedThroughOrdinal(thread.entries.at(-1)?.ordinal ?? null);
  }, [openedId, thread]);

  /**
   * Whether any Companion in the list is mid-work: replying, in a lifecycle transition, or carrying
   * a durable lifecycle intent such as a requested delete. While one is, the list polls fast so
   * cadence so its avatar and status track the work; a settled roster returns to the slow one.
   */
  const listWorkPending = companions.some((companion) =>
    companion.runtime.replying
    || companion.runtime.state === "provisioning"
    || companion.runtime.state === "stopping"
    || companion.runtime.lifecycle_intent === "recycle_pi"
    || companion.runtime.lifecycle_intent === "delete");

  /**
   * The conversation list re-reads every thread's last line on a slow cadence. It is the
   * control-plane read model — the same list the page was rendered from — so it never contacts a Box
   * and never wakes one, whatever state the Companions in it are in.
   *
   * The open thread does not depend on this: its own PostgreSQL projections are polled separately.
   */
  useEffect(() => {
    const timer = setInterval(() => {
      if (pageHidden()) return;
      writtenRef.current.clear();
      void listCompanions(currentOrg.id)
        .then((latest) => setCompanions((current) => {
          const byId = new Map(current.map((item) => [item.id, item]));
          return latest.map((item) => {
            const previous = byId.get(item.id);
            if (!previous) return item;
            // A row written while this read was out is newer than the read; keep what the write said.
            if (writtenRef.current.has(item.id)) return previous;
            return mergeCompanion(previous, item);
          });
        }))
        // A list that could not be re-read keeps the rows it has; nothing on screen is wrong yet.
        .catch(() => {});
    }, listWorkPending ? LIST_ACTIVE_POLL_MS : LIST_POLL_MS);
    return () => clearInterval(timer);
  }, [currentOrg.id, listWorkPending]);

  useEffect(() => {
    if (!openedId) return;
    void refreshThread();
  }, [openedId, refreshThread]);

  const loadOlderThread = useCallback(async () => {
    if (!openedId || loadingOlderThread) return;
    const current = threadRef.current;
    const before = current?.companion_id === openedId
      ? current.client_sync?.older_cursor
      : null;
    if (!current || !before) return;
    setLoadingOlderThread(true);
    try {
      const page = await getOlderCompanionThreadWindow(currentOrg.id, openedId, before);
      if (openedIdRef.current !== openedId || threadRef.current !== current) return;
      const byId = new Map<string, CompanionTranscriptEntry>();
      for (const entry of [...page.entries, ...current.entries]) byId.set(entry.event_id, entry);
      const combined = [...byId.values()].sort((left, right) =>
        left.ordinal - right.ordinal
        || (left.event_id < right.event_id ? -1 : left.event_id > right.event_id ? 1 : 0));
      const mounted = combined.slice(0, 150);
      const unseenIds = new Set(current.client_sync?.unseen_event_ids ?? []);
      for (const entry of combined.slice(150)) unseenIds.add(entry.event_id);
      const notifyByRun = new Map(
        (current.client_sync?.notify_returns ?? []).map((item) => [item.run_id, item]),
      );
      for (const item of page.client_sync?.notify_returns ?? []) notifyByRun.set(item.run_id, item);
      const mountedIds = new Set(mounted.map((entry) => entry.event_id));
      const mountedRunIds = new Set(mounted.flatMap((entry) => entry.routine?.run_id
        ? [entry.routine.run_id]
        : []));
      const next: SyncedCompanionThread = {
        ...current,
        ...page,
        entries: mounted,
        client_sync: {
          cursor: current.client_sync?.cursor ?? page.client_sync?.cursor ?? "",
          older_cursor: page.client_sync?.older_cursor ?? null,
          notify_returns: [...notifyByRun.values()].filter((item) =>
            mountedIds.has(item.main_entry_event_id) || mountedRunIds.has(item.run_id)),
          unseen_new_count: unseenIds.size,
          unseen_event_ids: [...unseenIds],
        },
      };
      historyModeRef.current = true;
      threadRef.current = next;
      setThread(next);
    } catch (cause) {
      setThreadError(cause instanceof Error ? cause.message : "Earlier messages could not be loaded.");
    } finally {
      setLoadingOlderThread(false);
    }
  }, [currentOrg.id, loadingOlderThread, openedId]);

  const showLatestThread = useCallback(async () => {
    if (!openedId) return;
    historyModeRef.current = false;
    const requestId = ++threadRequestRef.current;
    try {
      const next = await getCompanionThread(currentOrg.id, openedId);
      if (requestId !== threadRequestRef.current) return;
      threadRef.current = next;
      setThread(next);
      setThreadError(null);
    } catch (cause) {
      if (requestId === threadRequestRef.current) {
        setThreadError(cause instanceof Error ? cause.message : "Latest messages could not be loaded.");
      }
    }
  }, [currentOrg.id, openedId]);

  const acceptThreadProjection = useCallback((nextProjection: Thread) => {
    // Mutation endpoints still return the compatibility full projection. Keep only its recent
    // tail, then deliberately discard the old incremental/page cursors: their page boundary may
    // no longer describe these 150 rows. The next poll performs one bounded window bootstrap and
    // restores a matching v2 cursor without ever leaving the full transcript mounted.
    historyModeRef.current = false;
    setThread(() => {
      const next: SyncedCompanionThread = {
        ...nextProjection,
        entries: nextProjection.entries.slice(-150),
        client_sync: undefined,
      };
      threadRef.current = next;
      return next;
    });
  }, []);

  // Whether the transcript on screen belongs to the open thread, readable from async completions.
  useEffect(() => {
    threadLoadedRef.current = thread?.companion_id === openedId;
    threadRef.current = thread?.companion_id === openedId ? thread : null;
  }, [openedId, thread]);

  // Moving to another thread resets the reconnect count: its connection has not failed anything yet.
  useEffect(() => setThreadPollFailures(0), [openedId]);

  useEffect(() => {
    if (!openedId) return;
    const base = sending || openedPending || threadWorkPending
      ? PENDING_POLL_MS
      : READ_MODEL_POLL_MS;
    // Consecutive failures stretch the cadence toward the cap; the first answered poll resets it.
    const interval = Math.min(base * 2 ** Math.min(threadPollFailures, 3), MAX_POLL_BACKOFF_MS);
    const timer = setInterval(() => {
      if (pageHidden()) return;
      void refreshThread();
    }, interval);
    return () => clearInterval(timer);
  }, [
    openedId,
    openedPending,
    refreshThread,
    sending,
    threadPollFailures,
    threadWorkPending,
  ]);

  // Coming back — the tab re-shown, the network back up — revalidates immediately instead of
  // waiting out a backed-off interval, and resets the cadence the failures had stretched.
  useEffect(() => {
    if (!openedId) return;
    const revalidate = () => {
      if (pageHidden()) return;
      setThreadPollFailures(0);
      void refreshThread();
    };
    window.addEventListener("online", revalidate);
    document.addEventListener("visibilitychange", revalidate);
    return () => {
      window.removeEventListener("online", revalidate);
      document.removeEventListener("visibilitychange", revalidate);
    };
  }, [openedId, refreshThread]);

  /**
   * Re-read one Companion from the control-plane projection; a failed read leaves the row alone.
   */
  const refreshCompanion = useCallback(async (companionId: string) => {
    // Reads of one Companion can overlap, and a lifecycle is watched closely enough that they will:
    // an older read that answers late must not put a state the Companion has already left back on
    // screen, which is how a chip that had reached Online would blink back to Starting.
    const readId = (companionReadRef.current.get(companionId) ?? 0) + 1;
    companionReadRef.current.set(companionId, readId);
    try {
      const latest = await getCompanionRuntime(currentOrg.id, companionId);
      if (companionReadRef.current.get(companionId) !== readId) return;
      replaceCompanion(latest);
    } catch {
      // The failure that prompted this read is already on screen; do not replace it with this one.
    }
  }, [currentOrg.id, replaceCompanion]);

  // Keep lifecycle projection current without touching Box. Durable turn work and transitions use
  // the same fast cadence as the thread; stable rows settle back to the quiet read cadence.
  useEffect(() => {
    if (!openedId) return;
    const interval = sending || openedPending || threadWorkPending
      ? PENDING_POLL_MS
      : READ_MODEL_POLL_MS;
    void refreshCompanion(openedId);
    const timer = setInterval(() => {
      if (pageHidden()) return;
      void refreshCompanion(openedId);
    }, interval);
    return () => clearInterval(timer);
  }, [openedId, openedPending, refreshCompanion, sending, threadWorkPending]);

  /** Resolves false when the message never reached the control plane, so the composer keeps its text. */
  const onSend = async (
    content: string,
    clientMessageId: string,
    files: readonly File[] = [],
  ): Promise<boolean> => {
    if (!openedId) return false;
    const companionId = openedId;
    setSendingCompanionId(companionId);
    setThreadError(null);
    try {
      // The composer's message id travels with the request, so one submission is one durable turn
      // however many times the HTTP request itself reaches the control plane. Send is the sole wake.
      const accepted = await sendCompanionMessage(
        currentOrg.id,
        companionId,
        content,
        clientMessageId,
        files,
      );
      if (openedIdRef.current === companionId && accepted?.turn.companion_id === companionId) {
        // The POST is newer than every thread snapshot that started before its 202. Retire those
        // reads before projecting the accepted turn so a slow pre-send GET cannot make the saved
        // message and queue count disappear until the next poll. The next polling tick is free to
        // claim a fresh request id even while the retired read is still unwinding.
        threadRequestRef.current += 1;
        setThread((current) => current?.companion_id === companionId
          ? projectAcceptedMessage({
            thread: current,
            turn: accepted.turn,
            content,
            attachments: acceptedAttachments(files, clientMessageId),
          })
          : current);
      }
      return true;
    } catch (cause) {
      if (openedIdRef.current === companionId) {
        setThreadError(cause instanceof Error ? cause.message : "The message could not be sent.");
      }
      return false;
    } finally {
      setSendingCompanionId((current) => current === companionId ? null : current);
      // A send can schedule a cold start, so re-read its PostgreSQL lifecycle projection now.
      await refreshCompanion(companionId);
    }
  };

  const onCancelTurn = async (turnId: string): Promise<void> => {
    if (!openedId) throw new Error("This Companion is no longer open.");
    const companionId = openedId;
    try {
      const accepted = await cancelCompanionTurn(currentOrg.id, companionId, turnId);
      if (openedIdRef.current !== companionId) return;
      setThreadError(null);
      threadRequestRef.current += 1;
      acceptThreadProjection(accepted.thread);
      void refreshCompanion(companionId);
    } catch (cause) {
      if (openedIdRef.current === companionId) {
        setThreadError(cause instanceof Error ? cause.message : "This turn could not be stopped.");
      }
      throw cause;
    }
  };

  /**
   * Computer use for a runner: one handoff to the Box desktop Lux drives. The Box must already be
   * running, so this never creates or resumes one, and the returned URL opens in its own tab instead
   * of being stored anywhere.
   *
   * A browser only honours a new tab that the click itself asked for, so the tab is claimed on
   * `about:blank` before the handoff request and pointed at the desktop once the URL arrives;
   * anything else closes the claimed tab and leaves the reason on the thread. The claim never asks
   * for the empty URL: a browser may read that as this page and leave a copy of the app behind
   * instead of a tab to hand off. `noopener` cannot be passed as a window feature without losing the
   * handle the handoff needs, so the tab disowns this one only once it is on its way to the desktop:
   * disowning it first can detach the handle, and the handoff then silently never lands.
   */
  const onDesktop = async () => {
    if (!opened || !canRunOpened || !openedAwake) return;
    const tab = window.open("about:blank", "_blank");
    setOpeningDesktop(true);
    setDesktopError(null);
    try {
      const desktop = await openCompanionDesktop(currentOrg.id, opened.id);
      if (desktop.desktop_url && tab) {
        // A refused handoff throws, and the catch below closes the tab and says why rather than
        // leaving a blank tab open as if the desktop had been reached.
        tab.location.replace(desktop.desktop_url);
        try {
          tab.opener = null;
        } catch {
          // A tab already on its way to the desktop may refuse the write; it cannot reach back
          // through a stale handle either way, and the handoff itself has already happened.
        }
        return;
      }
      tab?.close();
      if (!desktop.desktop_url) {
        setDesktopError(desktop.provisioning
          ? "The Box desktop is still starting. Try again in a moment."
          : "This Box has no desktop to open yet.");
        return;
      }
      setDesktopError("This browser blocked the Box desktop tab. Allow pop-ups here, then try again.");
    } catch (cause) {
      tab?.close();
      setDesktopError(cause instanceof Error ? cause.message : "The Box desktop could not be opened.");
    } finally {
      setOpeningDesktop(false);
    }
  };

  /**
   * One join of the context panel's screen: mint this Companion's desktop and show it in the panel.
   * It is the same authorized handoff the desktop tab uses, so it observes a Box that is already
   * running and can never create or resume one — the panel is not a wake, and a Viewer never sees it.
   *
   * The URL is minted for this join alone. It is held in state only while the panel shows it, so
   * nothing here can hand a later join a stream token Box has already rotated away.
   */
  const joinContext = useCallback(async () => {
    if (!openedId || !canRunOpened || !openedAwake) return;
    const companionId = openedId;
    const joinId = ++contextJoinRef.current;
    setContextJoin({ companionId, desktop: null, error: null, joining: true });
    try {
      const minted = await openCompanionDesktop(currentOrg.id, companionId);
      if (contextJoinRef.current !== joinId) return;
      setContextJoin({
        companionId,
        desktop: minted,
        error: minted.desktop_url
          ? null
          : minted.provisioning
            ? "The Box desktop is still starting. Reconnect in a moment."
            : "This Box has no desktop to show yet.",
        joining: false,
      });
    } catch (cause) {
      if (contextJoinRef.current !== joinId) return;
      // The reason is kept on the panel rather than the thread: the thread poll clears its own
      // notice every couple of seconds, which would erase this one before it could be read.
      setContextJoin({
        companionId,
        desktop: null,
        error: cause instanceof Error ? cause.message : "The Box desktop could not be reached.",
        joining: false,
      });
    }
  }, [canRunOpened, currentOrg.id, openedAwake, openedId]);

  /** Whether the panel has a running Box of a runner's to show, which is the only thing it streams. */
  const contextLive = contextOpen && canRunOpened && openedAwake;
  /**
   * The join the panel may show right now, which is only ever the open Companion's. A join belonging
   * to the Companion an operator just left is not shown for the paint before its replacement is
   * minted: a panel that is live with nothing of this Companion's yet is a panel that is connecting.
   */
  const openedContext = contextJoin?.companionId === openedId ? contextJoin : null;

  // Every join mints its own URL: opening the panel, moving to another Companion, and a Box that came
  // back up are each a fresh mint, because Box rotates the stream token on every state change and a
  // kept URL is one that has already stopped working.
  useEffect(() => {
    if (!openedId || !contextLive) return;
    void joinContext();
  }, [contextLive, joinContext, openedId]);

  // A closed panel, a Companion left behind, and a Box that stopped under the stream all leave no
  // desktop: the URL goes with the join it belonged to, and an in-flight mint is disowned.
  useEffect(() => {
    if (contextLive) return;
    contextJoinRef.current += 1;
    setContextJoin(null);
  }, [contextLive]);

  const onCreated = (companion: Companion) => {
    setCompanions((current) => [companion, ...current]);
    setCreating(false);
    setError(null);
    openCompanion(companion);
  };

  const onSetProvider = async (companion: Companion) => {
    if (!fallbackProvider) {
      setError("Connect a provider before configuring this Companion.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const updated = await setCompanionProvider(currentOrg.id, companion.id, fallbackProvider);
      replaceCompanion(updated);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Provider could not be set.");
    } finally {
      setBusy(false);
    }
  };

  const navigateToLabel = (lib: SkillsLibrary, path: string) => {
    router.push(skillsRouteHref({ lib, kind: "label", label: path }));
  };
  const toggleExpanded = (path: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  useEffect(() => {
    if (!mobileSidebarOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setMobileSidebarOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [mobileSidebarOpen]);

  const dialogOpen = sharing !== null
    || creating
    || managingProviders
    || deletingCompanion !== null
    || triggerProvidersOpen;

  useEffect(() => {
    if (!dialogOpen) return;
    const sidebar = document.querySelector<HTMLElement>(".side");
    const sidebarWasInert = sidebar?.inert ?? false;
    if (sidebar) sidebar.inert = true;
    return () => {
      if (sidebar) sidebar.inert = sidebarWasInert;
    };
  }, [dialogOpen]);

  return (
    <div className={"app app--skills companions-app" + (mobileSidebarOpen ? " app--side-open" : "")}>
      <Sidebar
        orgs={orgs}
        currentOrg={currentOrg}
        onSwitchOrg={orgActions.switchOrg}
        onOnboard={orgActions.setOnboarding}
        onOpenSettings={() => router.push("/settings")}
        onWarmSettings={noop}
        mineTreeRows={navigation.mineTreeRows}
        orgTreeRows={navigation.orgTreeRows}
        expanded={expanded}
        onToggleExpand={toggleExpanded}
        selection={null}
        mineCount={navigation.mineCount}
        orgCount={navigation.orgCount}
        installedCount={navigation.installedCount}
        installedUpdateCount={navigation.installedUpdateCount}
        onOpenPalette={() => router.push("/skills")}
        onSelectMineAll={() => router.push(skillsRouteHref({ lib: "mine", kind: "all" }))}
        onSelectOrgAll={() => router.push(skillsRouteHref({ lib: "org", kind: "all" }))}
        onSelectInstalled={() => router.push(skillsRouteHref({ lib: "mine", kind: "installed" }))}
        onSelectLabel={navigateToLabel}
        onCreateLabel={noop}
        onSetLabelColor={noop}
        onSetLabelIcon={noop}
        onRenameLabel={noop}
        onDeleteLabel={noop}
        drag={null}
        hovered={null}
        openPendingPath={null}
        dropDone={null}
        onReparentLabel={noop}
        onLabelStartDrag={noop}
        onSelectLocal={() => router.push(skillsRouteHref({ kind: "local" }))}
        onSelectArchived={() => router.push(skillsRouteHref({ kind: "archived" }))}
        onSelectSecrets={() => router.push("/secrets")}
        companionsEnabled
        mode="companions"
        companions={sidebarCompanions}
        onCreateCompanion={() => {
          if (providers) setCreating(true);
        }}
        createCompanionDisabled={!providers}
        companionMenu={{
          personalWorkspace: currentOrg.kind === "personal",
          busy,
          onSettings: (companionId) => router.push(`/companions/${companionId}/settings`),
          onShare: (companionId) => {
            const companion = companions.find((item) => item.id === companionId);
            if (companion) setSharing(companion);
          },
          onMemberState: async (companionId, patch) => {
            const companion = companions.find((item) => item.id === companionId);
            if (companion) await applyMemberState(companion, patch);
          },
          onDuplicate: async (companionId) => {
            const companion = companions.find((item) => item.id === companionId);
            if (companion) await onDuplicate(companion);
          },
          onDelete: (companionId) => {
            const companion = companions.find((item) => item.id === companionId);
            if (companion && companion.access === "owner") setDeletingCompanion(companion);
          },
        }}
        companionRowRef={(companionId, node) => {
          if (node) rowRefs.current.set(companionId, node);
          else rowRefs.current.delete(companionId);
        }}
        onOpenPlugins={openPlugins}
        pluginsActive={pluginsOpen}
        onOpenProviders={providers && canManageProviders ? () => setManagingProviders(true) : undefined}
        viewer={viewer}
        activeCompanionId={openedId ?? settingsId}
        onSelectCompanion={(companionId) => {
          const companion = companions.find((item) => item.id === companionId);
          if (!companion) return;
          if (settingsCompanion) router.push(`/companions?companion=${companion.id}`);
          else openCompanion(companion);
        }}
        navigationOnly
        localActive={false}
        localUpdateCount={navigation.localUpdateCount}
        archivedActive={false}
        archivedCount={navigation.archivedCount}
        mobileOpen={mobileSidebarOpen}
        onToggleMobile={() => setMobileSidebarOpen((open) => !open)}
        onCloseMobile={() => setMobileSidebarOpen(false)}
      />
      {mobileSidebarOpen && (
        <button
          type="button"
          className="side-scrim"
          aria-label="Close navigation"
          onClick={() => setMobileSidebarOpen(false)}
        />
      )}

      <main
        className={"companions-main"
          + (opened ? " companions-main--chat" : "")
          + (!opened && !settingsCompanion && !pluginsOpen ? " companions-main--home" : "")}
        aria-hidden={mobileSidebarOpen || dialogOpen || undefined}
        inert={mobileSidebarOpen || dialogOpen ? true : undefined}
      >
        {opened ? (
          <>
            {providersError && (
              <div className="companions-thread-notice" role="alert">
                <span>{providersError}</span>
                <button
                  type="button"
                  className="cds-btn cds-btn--secondary cds-btn--sm"
                  onClick={() => void loadProviderSettings()}
                >
                  Retry
                </button>
              </div>
            )}
            {opened.access === "owner" && !opened.runtime.provider_ids.length && fallbackProvider && (
              <div className="companions-thread-notice">
                <span>This Companion has no provider yet.</span>
                <button
                  type="button"
                  className="cds-btn cds-btn--secondary cds-btn--sm"
                  disabled={busy}
                  onClick={() => void onSetProvider(opened)}
                >
                  {busy ? "Setting..." : `Set ${providerName(fallbackProvider)}`}
                </button>
              </div>
            )}
            <CompanionThread
              companion={opened}
              thread={presentedThread}
              orgId={currentOrg.id}
              error={desktopError ?? threadError}
              reconnecting={threadPollFailures >= 2 && thread?.companion_id === openedId}
              busy={sending}
              openingDesktop={openingDesktop}
              context={{
                open: contextOpen,
                desktop: openedContext?.desktop ?? null,
                joining: openedContext?.joining ?? contextLive,
                error: openedContext?.error ?? null,
                onToggle: () => setContextOpen((open) => {
                  writeContextOpen(!open);
                  return !open;
                }),
                onJoin: () => void joinContext(),
              }}
              contextSkills={skills}
              contextRoutines={routines}
              memberTimezone={memberTimezone}
              onRoutinesChange={setRoutines}
              contextTriggers={triggers}
              onTriggersChange={setTriggers}
              contextTriggerAccounts={triggerProviderAccounts}
              onManageTriggerProviders={() => setTriggerProvidersOpen(true)}
              contextTriggerHistoryApi={companionTriggerHistoryApi}
              contextPlugins={pluginAccounts.map((plugin) => ({
                id: plugin.id,
                label: `${plugin.provider} · ${plugin.label}`,
              }))}
              contextModels={(providers?.catalog ?? []).flatMap((provider) =>
                provider.models.map((model) => ({ id: model.id, label: model.name }))
              )}
              lastReadOrdinal={lastReadOrdinal}
              openedThroughOrdinal={openedThroughOrdinal}
              hasOlderMessages={thread?.client_sync?.older_cursor !== null
                && thread?.client_sync?.older_cursor !== undefined}
              loadingOlderMessages={loadingOlderThread}
              onLoadOlderMessages={loadOlderThread}
              unseenNewMessages={thread?.client_sync?.unseen_new_count ?? 0}
              onShowLatestMessages={showLatestThread}
              onBack={closeThread}
              onSend={onSend}
              onSettings={opened.access === "viewer"
                ? null
                : () => router.push(`/companions/${opened.id}/settings`)}
              onChangeModel={opened.access === "viewer"
                ? null
                : () => router.push(`/companions/${opened.id}/settings#companion-model`)}
              onThread={acceptThreadProjection}
              onDesktop={() => void onDesktop()}
              onCancelTurn={onCancelTurn}
            />
          </>
        ) : settingsCompanion && providers ? (
          <>
            {providersError && (
              <div className="companions-thread-notice" role="alert">
                <span>{providersError}</span>
                <button
                  type="button"
                  className="cds-btn cds-btn--secondary cds-btn--sm"
                  onClick={() => void loadProviderSettings()}
                >
                  Retry
                </button>
              </div>
            )}
            <CompanionSettings
              orgId={currentOrg.id}
              companion={settingsCompanion}
              providers={providers}
              onBack={closeSettings}
              onSaved={(updated) => {
                replaceCompanion(updated);
              }}
              onDeleted={(companionId) => {
                setCompanions((current) => current.filter((item) => item.id !== companionId));
                setSettingsId(null);
                router.push("/companions");
              }}
            />
          </>
        ) : settingsCompanion ? (
          <div className="companions-content" role="status">
            <p className="companions-list-empty">
              {providersError ?? "Loading provider settings…"}
            </p>
            {providersError && (
              <button
                type="button"
                className="cds-btn cds-btn--secondary cds-btn--md"
                onClick={() => void loadProviderSettings()}
              >
                Retry
              </button>
            )}
          </div>
        ) : pluginsOpen ? (
          <CompanionPlugins
            orgId={currentOrg.id}
            initialAccounts={pluginAccounts}
            onAccountsChange={(accounts) => {
              setPluginAccounts(accounts);
              // Disconnecting an OAuth MCP account also disconnects its shared trigger authority.
              // Mirror that immediately; a full refresh will load the server projection.
              const remainingIds = new Set(accounts.map((account) => account.id));
              setTriggerProviderAccounts((current) => current.map((account) => (
                account.mcp_account_id && !remainingIds.has(account.mcp_account_id)
                  ? { ...account, status: "disconnected", mcp_account_id: null }
                  : account
              )));
            }}
            onBack={closePlugins}
          />
        ) : (
          <div className="companions-home">
            {error ? <div className="companions-error companions-error--list" role="alert">{error}</div> : null}
            {!providers && !providersError ? (
              <div className="companions-list-notice" role="status">
                Loading provider settings…
              </div>
            ) : null}
            {providersError ? (
              <div className="companions-error companions-error--list" role="alert">
                <span>{providersError}</span>
                <button type="button" className="cds-link" onClick={() => void loadProviderSettings()}>
                  Retry
                </button>
              </div>
            ) : null}
            <div className="companions-home__body">
              <h1 className="companions-home__title">
                Companions
                <span className="companions-home__count tnum">{companions.length}</span>
              </h1>
              <p className="companions-home__desc">
                {companions.length === 0
                  ? "Create a Companion with a name and a connected model provider."
                  : "Pick a Companion in the sidebar to open its thread."}
              </p>
              <div className="companions-home__actions">
                <button
                  type="button"
                  className="btn-primary"
                  disabled={!providers}
                  onClick={() => {
                    if (providers) setCreating(true);
                  }}
                  title={providers ? "New companion" : "Provider settings are loading"}
                >
                  <Icon name="plus" size={14} /> New companion
                </button>
                {companions.length > 0 && (
                  // Only rendered by CSS under the mobile breakpoint, where the roster lives in a
                  // drawer this opens; on a desktop the sidebar is already beside this pane.
                  <button
                    type="button"
                    className="cds-btn cds-btn--secondary cds-btn--md companions-home__browse"
                    onClick={() => setMobileSidebarOpen(true)}
                  >
                    Browse companions
                  </button>
                )}
              </div>
            </div>
          </div>
        )}

      </main>

      {triggerProvidersOpen && (
        <CompanionTriggerProvidersDialog
          orgId={currentOrg.id}
          accounts={triggerProviderAccounts}
          onAccountsChange={setTriggerProviderAccounts}
          onMcpAccountRemoved={(accountId) => {
            setPluginAccounts((current) => current.filter((account) => account.id !== accountId));
          }}
          onClose={() => setTriggerProvidersOpen(false)}
        />
      )}

      {creating && providers && (
        <NewCompanionDialog
          orgId={currentOrg.id}
          providers={providers}
          onCreated={onCreated}
          onConnectProvider={() => {
            setCreating(false);
            setManagingProviders(true);
          }}
          onClose={() => setCreating(false)}
        />
      )}

      {managingProviders && providers && (
        <CompanionProvidersDialog
          orgId={currentOrg.id}
          providers={providers}
          onProviders={updateProviders}
          onClose={() => setManagingProviders(false)}
        />
      )}

      {sharing && (
        <ShareCompanionDialog
          orgId={currentOrg.id}
          companion={sharing}
          onClose={() => setSharing(null)}
        />
      )}

      {deletingCompanion && (
        <Dialog
          icon="trash-2"
          iconDanger
          title={`Delete ${deletingCompanion.name}?`}
          desc="Its Box, thread, and Companion record will be permanently deleted after runtime confirmation. This cannot be undone."
          onClose={() => setDeletingCompanion(null)}
          closeDisabled={deleteBusy}
          className="og-dialog companions-delete-dialog"
          foot={(
            <>
              <button
                type="button"
                className="cds-btn cds-btn--secondary cds-btn--md"
                disabled={deleteBusy}
                onClick={() => setDeletingCompanion(null)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="cds-btn cds-btn--danger cds-btn--md"
                disabled={deleteBusy}
                onClick={() => void confirmDelete()}
              >
                {deleteBusy ? "Deleting..." : "Delete Companion"}
              </button>
            </>
          )}
        />
      )}

      {/* Kebab actions can now fail while a thread, settings, or Plugins hold the main pane, where
          the home pane's inline alert is not on screen; the toast is the same answer, elsewhere. */}
      {error && (opened || settingsCompanion || pluginsOpen) ? (
        <div className="og-toast" role="alert" onClick={() => setError(null)}>
          {error}
        </div>
      ) : null}

      {orgActions.onboarding && (
        <Onboarding
          mode={orgActions.onboarding}
          onMode={orgActions.setOnboarding}
          onCreate={orgActions.createOrg}
          onJoin={orgActions.joinOrg}
          busy={orgActions.busy}
        />
      )}
      {orgActions.error && (
        <div className="og-toast" role="alert" onClick={() => orgActions.setError(null)}>
          {orgActions.error}
        </div>
      )}
    </div>
  );
}
