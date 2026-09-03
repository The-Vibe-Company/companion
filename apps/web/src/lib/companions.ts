import type {
  Companion,
  CompanionDesktop,
  CompanionLifecycleAccepted,
  CompanionPluginAccount,
  CompanionPluginOAuthStartInput,
  CompanionPluginOAuthStartResponse,
  CompanionProviderConnection,
  CompanionProviderOAuthStartResponse,
  CompanionProvidersResponse,
  CompanionRoutine,
  CompanionRoutineRunDetail,
  CompanionRoutineRunList,
  CompanionShareRole,
  CompanionShares,
  CompanionThread,
  CompanionThreadDeltaResponse,
  CompanionThreadWindow,
  CompanionTranscriptEntry,
  CompanionTrigger,
  CompanionTriggerProviderAccount,
  CancelCompanionTurnAcceptedResponse,
  CreateCompanionRoutineInput,
  CreateCompanionTriggerInput,
  CreateCompanionTriggerProviderAccountInput,
  SendCompanionMessageAcceptedResponse,
  SaveCompanionProviderInput,
  SaveCompanionPluginInput,
  UpdateCompanionInput,
  UpdateCompanionRoutineInput,
  UpdateCompanionTriggerInput,
} from "@companion/contracts";
import {
  COMPANION_LIFECYCLE_IDEMPOTENCY_HEADER,
  type RestartCompanionRuntimeInput,
} from "@companion/contracts/companion-runtime";
import { ApiFetchError, apiFetch } from "./apiClient";
import type {
  CompanionTriggerHistoryDetail,
  CompanionTriggerHistoryDetailOptions,
  CompanionTriggerHistoryListOptions,
  CompanionTriggerHistoryListResponse,
} from "@/components/companions/CompanionTriggerHistoryTypes";

function orgHeaders(orgId: string): HeadersInit {
  return { "x-companion-org": orgId };
}

function lifecycleHeaders(orgId: string, requestId: string): HeadersInit {
  return {
    "x-companion-org": orgId,
    [COMPANION_LIFECYCLE_IDEMPOTENCY_HEADER]: requestId,
  };
}

function isLegacyThreadResponse(
  value: CompanionThreadDeltaResponse | { thread: CompanionThread },
): value is { thread: CompanionThread } {
  return "entries" in value.thread;
}

/** A desktop handoff is the only browser request that waits on a private runtime round trip. */
const DESKTOP_HANDOFF_TIMEOUT_MS = 45_000;

/**
 * Every Companion the caller may read, with each thread's last line projected on. This is the poll
 * behind the conversation list, so it stays on the control-plane read model and never contacts Box.
 */
export async function listCompanions(orgId: string): Promise<Companion[]> {
  const result = await apiFetch<{ companions: Companion[] }>("/v1/companions", {
    headers: orgHeaders(orgId),
  });
  return result.companions;
}

/** Provider/model data is client-loaded so a cold pi.dev refresh cannot block the Companions list
 * route. The API still owns the bounded live-catalog lookup and its bundled fallback. */
export async function listCompanionProviders(orgId: string): Promise<CompanionProvidersResponse> {
  return apiFetch<CompanionProvidersResponse>("/v1/companion-providers", {
    headers: orgHeaders(orgId),
  });
}

export async function createCompanion(
  orgId: string,
  input: {
    name: string;
    persona?: string;
    provider_id: string;
    model_id: string;
    selected_skill_ids?: string[];
    selected_mcp_account_ids?: string[];
    // oxlint-disable-next-line anti-slop/no-shape-in-symbol-names -- icon catalogs use geometric domain terms
    icon?: { shape?: number; mouth?: number; accessory?: number; color?: number };
  },
): Promise<Companion> {
  const result = await apiFetch<{ companion: Companion }>("/v1/companions", {
    method: "POST",
    headers: orgHeaders(orgId),
    body: JSON.stringify(input),
  });
  return result.companion;
}

export async function updateCompanion(
  orgId: string,
  companionId: string,
  input: UpdateCompanionInput,
): Promise<Companion> {
  const result = await apiFetch<{ companion: Companion }>(
    `/v1/companions/${encodeURIComponent(companionId)}`,
    {
      method: "PATCH",
      headers: orgHeaders(orgId),
      body: JSON.stringify(input),
    },
  );
  return result.companion;
}

export async function deleteCompanion(
  orgId: string,
  companionId: string,
  requestId: string,
): Promise<CompanionLifecycleAccepted> {
  const result = await apiFetch<{ lifecycle: CompanionLifecycleAccepted }>(
    `/v1/companions/${encodeURIComponent(companionId)}`,
    {
      method: "DELETE",
      headers: lifecycleHeaders(orgId, requestId),
    },
  );
  return result.lifecycle;
}

export async function updateCompanionMemberState(
  orgId: string,
  companionId: string,
  input: { pinned?: boolean; hidden?: boolean; unread?: boolean },
): Promise<Companion> {
  const result = await apiFetch<{ companion: Companion }>(
    `/v1/companions/${encodeURIComponent(companionId)}/member-state`,
    {
      method: "PATCH",
      headers: orgHeaders(orgId),
      body: JSON.stringify(input),
    },
  );
  return result.companion;
}

export async function duplicateCompanion(
  orgId: string,
  companionId: string,
): Promise<Companion> {
  const result = await apiFetch<{ companion: Companion }>(
    `/v1/companions/${encodeURIComponent(companionId)}/duplicate`,
    {
      method: "POST",
      headers: orgHeaders(orgId),
    },
  );
  return result.companion;
}

export async function saveCompanionPlugin(
  orgId: string,
  input: SaveCompanionPluginInput,
): Promise<CompanionPluginAccount> {
  const result = await apiFetch<{ account: CompanionPluginAccount }>("/v1/companion-plugins", {
    method: "POST",
    headers: orgHeaders(orgId),
    body: JSON.stringify(input),
    // Fail closed before a stuck proxy leaves the dialog spinning.
    signal: AbortSignal.timeout(10_000),
  });
  return result.account;
}

/** Begin a curated MCP OAuth flow; the caller navigates to the returned provider URL. */
export async function startCompanionPluginOAuth(
  orgId: string,
  input: CompanionPluginOAuthStartInput,
): Promise<string> {
  const result = await apiFetch<CompanionPluginOAuthStartResponse>(
    "/v1/companion-plugins/oauth/start",
    {
      method: "POST",
      headers: orgHeaders(orgId),
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(12_000),
    },
  );
  return result.authorization_url;
}

export async function deleteCompanionPlugin(orgId: string, accountId: string): Promise<void> {
  await apiFetch(`/v1/companion-plugins/${encodeURIComponent(accountId)}`, {
    method: "DELETE",
    headers: orgHeaders(orgId),
  });
}

/** Member-wide provider authority used for trigger registration by every Companion. */
export async function listCompanionTriggerProviderAccounts(
  orgId: string,
): Promise<CompanionTriggerProviderAccount[]> {
  const result = await apiFetch<{ accounts: CompanionTriggerProviderAccount[] }>(
    "/v1/companion-trigger-provider-accounts",
    { headers: orgHeaders(orgId) },
  );
  return result.accounts;
}

/** API-key fallback; OAuth remains the primary GitHub and Sentry connection path. */
export async function saveCompanionTriggerProviderAccount(
  orgId: string,
  input: CreateCompanionTriggerProviderAccountInput,
): Promise<CompanionTriggerProviderAccount> {
  const result = await apiFetch<{ account: CompanionTriggerProviderAccount }>(
    "/v1/companion-trigger-provider-accounts",
    {
      method: "POST",
      headers: orgHeaders(orgId),
      body: JSON.stringify(input),
    },
  );
  return result.account;
}

export async function disconnectCompanionTriggerProviderAccount(
  orgId: string,
  accountId: string,
): Promise<CompanionTriggerProviderAccount> {
  const result = await apiFetch<{ account: CompanionTriggerProviderAccount }>(
    `/v1/companion-trigger-provider-accounts/${encodeURIComponent(accountId)}`,
    { method: "DELETE", headers: orgHeaders(orgId) },
  );
  return result.account;
}

export async function saveCompanionProvider(
  orgId: string,
  providerId: string,
  input: SaveCompanionProviderInput,
): Promise<CompanionProviderConnection> {
  const result = await apiFetch<{ connection: CompanionProviderConnection }>(
    `/v1/companion-providers/${encodeURIComponent(providerId)}`,
    {
      method: "PUT",
      headers: orgHeaders(orgId),
      body: JSON.stringify(input),
    },
  );
  return result.connection;
}

export async function startCompanionProviderOAuth(
  orgId: string,
  providerId: "anthropic" | "openai-codex",
): Promise<CompanionProviderOAuthStartResponse> {
  return apiFetch<CompanionProviderOAuthStartResponse>("/v1/companion-providers/oauth/start", {
    method: "POST",
    headers: orgHeaders(orgId),
    body: JSON.stringify({ provider_id: providerId }),
    signal: AbortSignal.timeout(35_000),
  });
}

export async function completeCompanionProviderOAuth(
  orgId: string,
  authorizationCode: string,
): Promise<CompanionProviderConnection> {
  const result = await apiFetch<{ connection: CompanionProviderConnection }>(
    "/v1/companion-providers/oauth/complete",
    {
      method: "POST",
      headers: orgHeaders(orgId),
      body: JSON.stringify({ authorization_code: authorizationCode }),
      signal: AbortSignal.timeout(35_000),
    },
  );
  return result.connection;
}

export async function pollCompanionProviderOAuth(
  orgId: string,
): Promise<
  | { status: "pending" }
  | { status: "connected"; connection: CompanionProviderConnection }
> {
  return apiFetch("/v1/companion-providers/oauth/poll", {
    method: "POST",
    headers: orgHeaders(orgId),
    signal: AbortSignal.timeout(65_000),
  });
}

export async function deleteCompanionProvider(orgId: string, providerId: string): Promise<void> {
  await apiFetch(`/v1/companion-providers/${encodeURIComponent(providerId)}`, {
    method: "DELETE",
    headers: orgHeaders(orgId),
  });
}

export async function setDefaultCompanionProvider(
  orgId: string,
  providerId: string,
): Promise<void> {
  await apiFetch("/v1/companion-providers/default", {
    method: "PUT",
    headers: orgHeaders(orgId),
    body: JSON.stringify({ provider_id: providerId }),
  });
}

export async function setCompanionProvider(
  orgId: string,
  companionId: string,
  providerId: string,
): Promise<Companion> {
  const result = await apiFetch<{ companion: Companion }>(
    `/v1/companions/${encodeURIComponent(companionId)}/provider`,
    {
      method: "PUT",
      headers: orgHeaders(orgId),
      body: JSON.stringify({ provider_id: providerId }),
    },
  );
  return result.companion;
}

export async function getCompanionShares(
  orgId: string,
  companionId: string,
): Promise<CompanionShares> {
  const result = await apiFetch<{ shares: CompanionShares }>(
    `/v1/companions/${encodeURIComponent(companionId)}/shares`,
    { headers: orgHeaders(orgId) },
  );
  return result.shares;
}

export async function setCompanionWorkspaceShare(
  orgId: string,
  companionId: string,
  role: CompanionShareRole | null,
): Promise<CompanionShares> {
  const result = await apiFetch<{ shares: CompanionShares }>(
    `/v1/companions/${encodeURIComponent(companionId)}/shares/workspace`,
    {
      method: "PUT",
      headers: orgHeaders(orgId),
      body: JSON.stringify({ role }),
    },
  );
  return result.shares;
}

export async function getCompanionThread(
  orgId: string,
  companionId: string,
  options: {
    cursor?: string;
    current?: SyncedCompanionThread;
    preserveHistory?: boolean;
  } = {},
): Promise<SyncedCompanionThread> {
  if (!options.cursor) return openCompanionThreadWindow(orgId, companionId);

  const initial = options.current;
  if (!initial) return openCompanionThreadWindow(orgId, companionId);
  let current: SyncedCompanionThread = initial;
  let cursor = options.cursor;
  for (;;) {
    const result = await apiFetch<CompanionThreadDeltaResponse | { thread: CompanionThread }>(
      `/v1/companions/${encodeURIComponent(companionId)}/thread-delta?cursor=${encodeURIComponent(cursor)}`,
      { headers: orgHeaders(orgId) },
    );
    // Rolling-deploy and test compatibility: an old endpoint can still answer one full thread.
    if (isLegacyThreadResponse(result)) return result.thread;

    const previousIds: Set<string> = new Set([
      ...current.entries.map((entry) => entry.event_id),
      ...(current.client_sync?.unseen_event_ids ?? []),
    ]);
    const deletedIds: Set<string> = new Set(result.deleted_event_ids);
    const changedById: Map<string, CompanionTranscriptEntry> = new Map(
      result.changed_entries.map((entry) => [entry.event_id, entry]),
    );
    const retained: CompanionTranscriptEntry[] = result.reset_entries
      ? []
      : current.entries
          .filter((entry) => !deletedIds.has(entry.event_id))
          .map((entry) => changedById.get(entry.event_id) ?? entry);
    const additions: CompanionTranscriptEntry[] = result.changed_entries.filter(
      (entry) => !previousIds.has(entry.event_id),
    );
    const unseenIds = new Set(current.client_sync?.unseen_event_ids ?? []);
    for (const eventId of deletedIds) unseenIds.delete(eventId);
    if (options.preserveHistory) {
      for (const entry of additions) unseenIds.add(entry.event_id);
    } else {
      unseenIds.clear();
    }
    const merged: CompanionTranscriptEntry[] = result.reset_entries
      ? result.changed_entries
      : options.preserveHistory
        ? retained
        : [...retained, ...additions];
    const ordered: CompanionTranscriptEntry[] = merged.sort((left, right) =>
      left.ordinal - right.ordinal
      || (left.event_id < right.event_id ? -1 : left.event_id > right.event_id ? 1 : 0));
    // Once live append growth would evict the page boundary, refresh the bounded bootstrap so its
    // signed older cursor is anchored to the first row that remains mounted. Keeping the stale
    // cursor would skip the evicted interval when the reader later scrolls backwards.
    if (ordered.length > 150 && !options.preserveHistory) {
      return await openCompanionThreadWindow(orgId, companionId);
    }
    const notifyByRun: Map<string, CompanionThreadWindow["notify_returns"][number]> = new Map(
      (current.client_sync?.notify_returns ?? []).map((item) => [item.run_id, item]),
    );
    for (const item of result.notify_returns ?? []) notifyByRun.set(item.run_id, item);
    const nextCursor = result.cursor;
    if (result.has_more && nextCursor === cursor) {
      throw new Error("Companion thread delta cursor did not advance");
    }
    const mountedIds = new Set(ordered.map((entry) => entry.event_id));
    const mountedRunIds = new Set(ordered.flatMap((entry) => entry.routine?.run_id
      ? [entry.routine.run_id]
      : []));
    current = {
      ...result.thread,
      entries: ordered,
      client_sync: {
        cursor: nextCursor,
        older_cursor: current.client_sync?.older_cursor ?? null,
        notify_returns: [...notifyByRun.values()].filter((item) =>
          mountedIds.has(item.main_entry_event_id) || mountedRunIds.has(item.run_id)),
        unseen_new_count: unseenIds.size,
        unseen_event_ids: [...unseenIds],
      },
    };
    cursor = nextCursor;
    if (!result.has_more) return current;
  }
}

export type SyncedCompanionThread = CompanionThread & {
  client_sync?: {
    cursor: string;
    older_cursor: string | null;
    notify_returns: CompanionThreadWindow["notify_returns"];
    unseen_new_count: number;
    unseen_event_ids: string[];
  };
};

/** Group only routine notify pairs present in the mounted pages; durable history stays server-side. */
export function collapseLoadedRoutineNotifyEntries(
  entries: readonly CompanionTranscriptEntry[],
  notifyReturns: CompanionThreadWindow["notify_returns"],
): CompanionTranscriptEntry[] {
  const ordered = [...entries].sort((left, right) =>
    left.ordinal - right.ordinal
    || (left.event_id < right.event_id ? -1 : left.event_id > right.event_id ? 1 : 0));
  const returnedByRun = new Map(notifyReturns.map((item) => [item.run_id, item]));
  const output: CompanionTranscriptEntry[] = [];
  let group: Array<{
    marker: CompanionTranscriptEntry;
    update: CompanionTranscriptEntry;
    routineId: string;
    routineName: string;
  }> = [];
  const flush = () => {
    if (group.length === 0) return;
    if (group.length === 1) {
      output.push(group[0]!.marker, group[0]!.update);
    } else {
      const latest = group.at(-1)!;
      output.push(latest.marker, {
        ...latest.update,
        routine_notify_group: {
          routine_id: latest.routineId,
          routine_name: latest.routineName,
          total_count: group.length,
          hidden_entries: group.slice(0, -1).flatMap((item) => [item.marker, item.update]),
        },
      });
    }
    group = [];
  };

  for (let index = 0; index < ordered.length;) {
    const marker = ordered[index]!;
    const update = ordered[index + 1];
    const runId = marker.routine?.run_id;
    const returned = runId ? returnedByRun.get(runId) : undefined;
    const collapsible = returned !== undefined
      && update !== undefined
      && marker.role === "user"
      && marker.routine?.id === returned.routine_id
      && marker.routine?.name === returned.routine_name
      && marker.attachments.length === 0
      && marker.decision === null
      && update.event_id === returned.main_entry_event_id
      && update.role === "assistant"
      && update.attachments.length === 0
      && update.decision === null;
    if (!collapsible || !update) {
      flush();
      output.push(marker);
      index += 1;
      continue;
    }
    if (group.length > 0 && (
      group[0]!.routineId !== returned.routine_id
      || group[0]!.routineName !== returned.routine_name
    )) flush();
    group.push({
      marker,
      update,
      routineId: returned.routine_id,
      routineName: returned.routine_name,
    });
    index += 2;
  }
  flush();
  return output;
}

async function readCompanionThreadWindow(
  orgId: string,
  companionId: string,
  before?: string,
): Promise<CompanionThreadWindow | { thread: CompanionThread }> {
  const query = new URLSearchParams({ limit: "50" });
  if (before) query.set("before", before);
  try {
    return await apiFetch<CompanionThreadWindow | { thread: CompanionThread }>(
      `/v1/companions/${encodeURIComponent(companionId)}/thread-window?${query.toString()}`,
      { headers: orgHeaders(orgId) },
    );
  } catch (cause) {
    // During a rolling deploy the old API has no window route yet. Only route absence falls back;
    // an authorization, validation, or server failure must keep its real meaning.
    if (!(cause instanceof ApiFetchError) || (cause.status !== 404 && cause.status !== 405)) {
      throw cause;
    }
    return await apiFetch<{ thread: CompanionThread }>(
      `/v1/companions/${encodeURIComponent(companionId)}/thread`,
      { headers: orgHeaders(orgId) },
    );
  }
}

/** Initial bounded bootstrap; the compatibility branch can be removed after old API rollout. */
export async function openCompanionThreadWindow(
  orgId: string,
  companionId: string,
): Promise<SyncedCompanionThread> {
  const window = await readCompanionThreadWindow(orgId, companionId);
  if ("entries" in window) {
    return {
      ...window.thread,
      entries: window.entries,
      client_sync: {
        cursor: window.sync_cursor,
        older_cursor: window.older_cursor,
        notify_returns: window.notify_returns,
        unseen_new_count: 0,
        unseen_event_ids: [],
      },
    };
  }
  return window.thread;
}

/** Fetch one older page without changing the live delta cursor or the server read watermark. */
export async function getOlderCompanionThreadWindow(
  orgId: string,
  companionId: string,
  before: string,
): Promise<SyncedCompanionThread> {
  const window = await readCompanionThreadWindow(orgId, companionId, before);
  if (!("entries" in window)) return window.thread;
  return {
    ...window.thread,
    entries: window.entries,
    client_sync: {
      cursor: window.sync_cursor,
      older_cursor: window.older_cursor,
      notify_returns: window.notify_returns,
      unseen_new_count: 0,
      unseen_event_ids: [],
    },
  };
}

/**
 * Send one message. `clientMessageId` names the turn this send creates, so the control plane stores
 * it once however many times the request reaches it: a resend can only ever resolve to the same turn.
 */
export async function sendCompanionMessage(
  orgId: string,
  companionId: string,
  content: string,
  clientMessageId: string,
  files: readonly File[] = [],
): Promise<SendCompanionMessageAcceptedResponse> {
  const path = `/v1/companions/${encodeURIComponent(companionId)}/messages`;
  if (files.length === 0) {
    return apiFetch<SendCompanionMessageAcceptedResponse>(path, {
      method: "POST",
      headers: orgHeaders(orgId),
      body: JSON.stringify({ content, client_message_id: clientMessageId }),
    });
  }
  // A send carrying files uploads them inside this request, so the accepted turn and the files it
  // names are durable together. That trades the sub-second text ACK for however long the upload
  // takes, which is why the deadline below is the upload's rather than the ordinary one.
  const form = new FormData();
  form.set("content", content);
  form.set("client_message_id", clientMessageId);
  for (const file of files) form.append("file", file, file.name);
  return apiFetch<SendCompanionMessageAcceptedResponse>(
    path,
    { method: "POST", headers: orgHeaders(orgId), body: form },
    { timeoutMs: COMPANION_ATTACHMENT_UPLOAD_TIMEOUT_MS },
  );
}

/** How long a send may spend uploading before the composer gives the draft back. */
const COMPANION_ATTACHMENT_UPLOAD_TIMEOUT_MS = 120_000;

/** Where one stored attachment's bytes are read from. Re-authorized on every single request. */
export function companionAttachmentUrl(companionId: string, attachmentId: string): string {
  return `/v1/companions/${encodeURIComponent(companionId)}/attachments/${encodeURIComponent(attachmentId)}`;
}

/** Stop an active turn or dequeue a follow-up. */
export async function cancelCompanionTurn(
  orgId: string,
  companionId: string,
  turnId: string,
): Promise<CancelCompanionTurnAcceptedResponse> {
  return apiFetch<CancelCompanionTurnAcceptedResponse>(
    `/v1/companions/${encodeURIComponent(companionId)}/turns/${encodeURIComponent(turnId)}/cancel`,
    { method: "POST", headers: orgHeaders(orgId), body: "{}" },
  );
}

/**
 * Allow, Deny, or answer a pending permission card. Owner/Editor only; Viewer is refused by the API.
 */
export async function decideCompanionDecision(
  orgId: string,
  companionId: string,
  requestId: string,
  input: { action: "allow" } | { action: "deny" } | { action: "answer"; answer: string },
): Promise<CompanionThread> {
  const result = await apiFetch<{ thread: CompanionThread }>(
    `/v1/companions/${encodeURIComponent(companionId)}/decisions/${encodeURIComponent(requestId)}`,
    {
      method: "POST",
      headers: orgHeaders(orgId),
      body: JSON.stringify(input),
    },
  );
  return result.thread;
}

/**
 * Runtime read. This is always the PostgreSQL projection, including for Owners and Editors; status
 * polling must never become a Box observation or a wake.
 */
export async function getCompanionRuntime(
  orgId: string,
  companionId: string,
): Promise<Companion> {
  const result = await apiFetch<{ companion: Companion }>(
    `/v1/companions/${encodeURIComponent(companionId)}/runtime`,
    { headers: orgHeaders(orgId) },
  );
  return result.companion;
}

/** Record an explicit v3 lifecycle desire; completion is observed through PostgreSQL projections. */
export async function restartCompanionRuntime(
  orgId: string,
  companionId: string,
  input: RestartCompanionRuntimeInput,
  requestId: string,
): Promise<CompanionLifecycleAccepted> {
  const result = await apiFetch<{ lifecycle: CompanionLifecycleAccepted }>(
    `/v1/companions/${encodeURIComponent(companionId)}/runtime/restart`,
    {
      method: "POST",
      headers: lifecycleHeaders(orgId, requestId),
      body: JSON.stringify(input),
    },
  );
  return result.lifecycle;
}

/**
 * Owner/Editor computer use: one handoff to the Box desktop Lux drives. The request observes a Box
 * that is already running and never resumes one, and the returned URL is used immediately instead of
 * being kept anywhere.
 */
export async function openCompanionDesktop(
  orgId: string,
  companionId: string,
): Promise<CompanionDesktop> {
  return apiFetch<CompanionDesktop>(
    `/v1/companions/${encodeURIComponent(companionId)}/runtime/desktop`,
    { method: "POST", headers: orgHeaders(orgId), body: "{}" },
    { timeoutMs: DESKTOP_HANDOFF_TIMEOUT_MS },
  );
}

export async function listCompanionRoutines(
  orgId: string,
  companionId: string,
): Promise<CompanionRoutine[]> {
  const result = await apiFetch<{ routines: CompanionRoutine[] }>(
    `/v1/companions/${encodeURIComponent(companionId)}/routines`,
    { headers: orgHeaders(orgId) },
  );
  return result.routines;
}

/** Read one routine's newest-first durable run history without contacting or waking its Box. */
export async function listCompanionRoutineRuns(
  orgId: string,
  companionId: string,
  routineId: string,
  input: { limit?: number; cursor?: string } = {},
): Promise<CompanionRoutineRunList> {
  const query = new URLSearchParams({ limit: String(input.limit ?? 20) });
  if (input.cursor) query.set("cursor", input.cursor);
  return apiFetch<CompanionRoutineRunList>(
    `/v1/companions/${encodeURIComponent(companionId)}`
      + `/routines/${encodeURIComponent(routineId)}/runs?${query.toString()}`,
    { headers: orgHeaders(orgId) },
  );
}

/** Read one bounded page of a routine Pi transcript; the surfaced payload stays in main chat. */
export async function readCompanionRoutineRun(
  orgId: string,
  companionId: string,
  runId: string,
  input: { entryLimit?: number; entryCursor?: number } = {},
): Promise<CompanionRoutineRunDetail> {
  const query = new URLSearchParams({ entry_limit: String(input.entryLimit ?? 50) });
  if (input.entryCursor !== undefined) {
    query.set("entry_cursor", String(input.entryCursor));
  }
  const result = await apiFetch<{ run: CompanionRoutineRunDetail }>(
    `/v1/companions/${encodeURIComponent(companionId)}`
      + `/routine-runs/${encodeURIComponent(runId)}?${query.toString()}`,
    { headers: orgHeaders(orgId) },
  );
  return result.run;
}

export async function createCompanionRoutine(
  orgId: string,
  companionId: string,
  input: CreateCompanionRoutineInput,
): Promise<CompanionRoutine> {
  const result = await apiFetch<{ routine: CompanionRoutine }>(
    `/v1/companions/${encodeURIComponent(companionId)}/routines`,
    {
      method: "POST",
      headers: orgHeaders(orgId),
      body: JSON.stringify(input),
    },
  );
  return result.routine;
}

export async function updateCompanionRoutine(
  orgId: string,
  companionId: string,
  routineId: string,
  input: UpdateCompanionRoutineInput,
): Promise<CompanionRoutine> {
  const result = await apiFetch<{ routine: CompanionRoutine }>(
    `/v1/companions/${encodeURIComponent(companionId)}/routines/${encodeURIComponent(routineId)}`,
    {
      method: "PATCH",
      headers: orgHeaders(orgId),
      body: JSON.stringify(input),
    },
  );
  return result.routine;
}

export async function deleteCompanionRoutine(
  orgId: string,
  companionId: string,
  routineId: string,
): Promise<void> {
  await apiFetch(
    `/v1/companions/${encodeURIComponent(companionId)}/routines/${encodeURIComponent(routineId)}`,
    { method: "DELETE", headers: orgHeaders(orgId) },
  );
}

/**
 * Triggers are the event-driven siblings of routines. The list carries each trigger's webhook URL
 * for Owner/Editor readers; a Viewer receives `webhook_url: null` and no secret ever travels bare.
 */
export async function listCompanionTriggers(
  orgId: string,
  companionId: string,
): Promise<CompanionTrigger[]> {
  const result = await apiFetch<{ triggers: CompanionTrigger[] }>(
    `/v1/companions/${encodeURIComponent(companionId)}/triggers`,
    { headers: orgHeaders(orgId) },
  );
  return result.triggers;
}

export async function createCompanionTrigger(
  orgId: string,
  companionId: string,
  input: CreateCompanionTriggerInput,
): Promise<CompanionTrigger> {
  const result = await apiFetch<{ trigger: CompanionTrigger }>(
    `/v1/companions/${encodeURIComponent(companionId)}/triggers`,
    {
      method: "POST",
      headers: orgHeaders(orgId),
      body: JSON.stringify(input),
    },
  );
  return result.trigger;
}

export async function updateCompanionTrigger(
  orgId: string,
  companionId: string,
  triggerId: string,
  input: UpdateCompanionTriggerInput,
): Promise<CompanionTrigger> {
  const result = await apiFetch<{ trigger: CompanionTrigger }>(
    `/v1/companions/${encodeURIComponent(companionId)}/triggers/${encodeURIComponent(triggerId)}`,
    {
      method: "PATCH",
      headers: orgHeaders(orgId),
      body: JSON.stringify(input),
    },
  );
  return result.trigger;
}

export async function deleteCompanionTrigger(
  orgId: string,
  companionId: string,
  triggerId: string,
): Promise<void> {
  await apiFetch(
    `/v1/companions/${encodeURIComponent(companionId)}/triggers/${encodeURIComponent(triggerId)}`,
    { method: "DELETE", headers: orgHeaders(orgId) },
  );
}

/** Invalidate the old webhook URL and mint a new one; the response carries the updated trigger. */
export async function rotateCompanionTriggerSecret(
  orgId: string,
  companionId: string,
  triggerId: string,
): Promise<CompanionTrigger> {
  const result = await apiFetch<{ trigger: CompanionTrigger }>(
    `/v1/companions/${encodeURIComponent(companionId)}/triggers/${encodeURIComponent(triggerId)}/rotate-secret`,
    { method: "POST", headers: orgHeaders(orgId), body: "{}" },
  );
  return result.trigger;
}

/**
 * Ask the API to reconcile a trigger with its provider webhook. The endpoint returns the refreshed
 * trigger projection (rather than a bare `{ registered: true }` acknowledgement), so the row can
 * immediately show registered/failed state and its safe registration error.
 */
export async function retryCompanionTriggerRegistration(
  orgId: string,
  companionId: string,
  triggerId: string,
): Promise<CompanionTrigger> {
  const result = await apiFetch<{ trigger: CompanionTrigger }>(
    `/v1/companions/${encodeURIComponent(companionId)}/triggers/${encodeURIComponent(triggerId)}/registration`,
    { method: "POST", headers: orgHeaders(orgId), body: "{}" },
  );
  return result.trigger;
}

/** Trigger fire history is a control-plane read and never wakes the Companion Box. */
export async function listCompanionTriggerRuns(
  orgId: string,
  companionId: string,
  triggerId: string,
  options: CompanionTriggerHistoryListOptions,
): Promise<CompanionTriggerHistoryListResponse> {
  const params = new URLSearchParams({ limit: String(options.limit) });
  if (options.cursor) params.set("cursor", options.cursor);
  return apiFetch<CompanionTriggerHistoryListResponse>(
    `/v1/companions/${encodeURIComponent(companionId)}/triggers/${encodeURIComponent(triggerId)}/runs?${params.toString()}`,
    { headers: orgHeaders(orgId) },
  );
}

export async function readCompanionTriggerRun(
  orgId: string,
  companionId: string,
  runId: string,
  options: CompanionTriggerHistoryDetailOptions,
): Promise<CompanionTriggerHistoryDetail> {
  const params = new URLSearchParams({ entry_limit: String(options.entryLimit) });
  if (options.entryCursor !== undefined) params.set("entry_cursor", String(options.entryCursor));
  return apiFetch<CompanionTriggerHistoryDetail>(
    `/v1/companions/${encodeURIComponent(companionId)}/trigger-runs/${encodeURIComponent(runId)}?${params.toString()}`,
    { headers: orgHeaders(orgId) },
  );
}
