/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/no-unsafe-dictionary-type, anti-slop/require-safety-comment-for-type-assertion -- Existing API boundary decoding predates the incremental anti-slop gate. */

import { eq, sql } from "drizzle-orm";
import { z } from "zod";

import type {
  Companion,
  CompanionAccess,
  CompanionAttachmentUpload,
  CompanionClientSurface,
  CompanionOperation,
  CompanionOperationKind,
  CompanionShareRole,
  CompanionThread,
  CompanionThreadDeltaResponse,
  CompanionThreadMetadata,
  CompanionThreadWindow,
  CompanionTranscriptEntry,
  CompanionTurn,
  CompanionRoutineNotifyReturn,
} from "@companion/contracts";
import {
  COMPANION_THREAD_DELTA_MAX_CHANGES,
  companionAttachmentUploadSchema,
  companionDecisionProposalSchema,
  companionOperationSchema,
  companionRoutineNotifyReturnSchema,
  companionSelectedMcpAccountIdsSchema,
  companionSelectedSkillIdsSchema,
  companionThreadDeltaResponseSchema,
  companionThreadWindowSchema,
  companionTranscriptEntrySchema,
  companionTurnSchema,
  type CompanionDecisionProposal,
} from "@companion/contracts";
import { schema, type Db } from "@companion/db";

import type { ActorContext } from "./services";
import {
  CompanionDecisionNotFoundError,
  CompanionDuplicateForbiddenError,
  CompanionProviderError,
  CompanionRuntimeTransitionError,
  CompanionSettingsForbiddenError,
  getCompanion,
  listCompanionShares,
  listCompanions,
} from "./companions";
import { companionCatalogModel, getCompanionProviderCatalog } from "./companionProviderCatalog";
import { COMPANION_SKILLS_SYNC_ERROR_VIEWER_MESSAGE } from "./companionRuntimeErrors";
import {
  buildCompanionThreadSequenceCursor,
  buildCompanionThreadWindowCursor,
} from "./companionSync";

function rows<T>(result: unknown): T[] {
  return Array.from(result as Iterable<T>);
}

function hasDatabaseErrorCode(error: unknown, expected: string): boolean {
  const seen = new Set<unknown>();
  let current = error;
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    if ("code" in current && current.code === expected) return true;
    current = "cause" in current ? current.cause : null;
  }
  return false;
}

function integer(value: number | string | bigint | null | undefined): number {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  return 0;
}

function positiveInteger(value: number | string | bigint | null | undefined): number {
  const parsed = integer(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error("Companion runtime generation is invalid");
  }
  return parsed;
}

function iso(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

type RuntimeReadRow = {
  access_role: CompanionAccess;
  generation: number | string | bigint;
  selected_skill_ids: unknown;
  selected_mcp_account_ids: unknown;
  box_id: string | null;
  box_state: "absent" | "initializing" | "provisioning" | "ready" | "idle" | "running"
    | "archiving" | "archived" | "error" | "unknown";
  pi_state: "absent" | "starting" | "idle" | "running" | "stopped" | "error" | "unknown";
  pi_invocation_id: string | null;
  disk_layout_version: number | string;
  desired_settings_revision: number | string | bigint;
  applied_settings_revision: number | string | bigint;
  applied_skills_revision: number | string;
  skills_available_revision: number | string;
  skills_update_error_message: string | null;
  retirement_state: "active" | "requested" | "pending" | "blocked" | "retired";
  last_error_code: string | null;
  last_error_message: string | null;
  last_error_action: string | null;
  active_turn: unknown;
  queued_count: number | string;
  interrupted_turn: unknown;
  latest_operation: unknown;
  is_replying: boolean;
  last_observed_at?: Date | string | null;
};

export type CompanionRuntimeApiProjection = RuntimeReadRow;

function parseTurn(value: unknown): CompanionTurn | null {
  if (value === null || value === undefined) return null;
  return companionTurnSchema.parse(value);
}

function parseOperation(value: unknown): CompanionOperation | null {
  if (value === null || value === undefined) return null;
  return companionOperationSchema.parse(value);
}

function projectedOperation(
  operation: CompanionOperation | null,
  viewer: boolean,
): Companion["runtime"]["latest_operation"] {
  if (!operation) return null;
  return {
    id: operation.id,
    source_turn_id: operation.source_turn_id,
    kind: operation.kind,
    status: operation.status,
    error: operation.error
      ? viewer
        ? {
            code: "runtime_unavailable",
            message: "Companion runtime needs attention.",
            action: "none",
          }
        : operation.error
      : null,
  };
}

function projectedRuntimeState(
  row: RuntimeReadRow,
  latestOperation: CompanionOperation | null,
): Companion["runtime"]["state"] {
  const lifecycleFailed = latestOperation?.status === "failed"
    || latestOperation?.status === "interrupted";

  if (row.retirement_state === "retired") return "stopped";
  if (["requested", "pending", "blocked"].includes(row.retirement_state)) return "stopping";

  if (latestOperation && ["pending", "running"].includes(latestOperation.status)) {
    if (["delete", "stop", "restart_box"].includes(latestOperation.kind)) return "stopping";
    return "provisioning";
  }

  if (
    row.box_state === "error"
    || row.pi_state === "error"
  ) return "error";

  if (row.box_state === "absent") {
    if (latestOperation?.status === "failed" || latestOperation?.status === "interrupted") {
      return "error";
    }
    return latestOperation?.kind === "stop" && latestOperation.status === "succeeded"
      ? "stopped"
      : "not_created";
  }
  if (row.box_state === "archived") return "stopped";
  if (row.box_state === "archiving") return "stopping";
  if (row.box_state === "initializing" || row.box_state === "provisioning") {
    return lifecycleFailed ? "error" : "provisioning";
  }
  if (["ready", "idle", "running"].includes(row.box_state)) {
    if (row.pi_state === "starting" || row.pi_state === "absent") {
      return lifecycleFailed ? "error" : "provisioning";
    }
    return "running";
  }
  return row.last_error_code
      || lifecycleFailed
    ? "error"
    : "not_created";
}

function projectedDaemonState(row: RuntimeReadRow): Companion["runtime"]["daemon_state"] {
  switch (row.pi_state) {
    case "starting": return "starting";
    case "idle":
    case "running": return "running";
    case "absent":
    case "stopped": return "stopped";
    case "error": return "error";
    default: return "unknown";
  }
}

export function projectCompanionRuntimeV2(
  companion: Companion,
  row: RuntimeReadRow,
): Companion {
  const latestOperation = parseOperation(row.latest_operation);
  const lastObservedAt = iso(row.last_observed_at) ?? companion.runtime.last_observed_at;
  const runnableBox = ["ready", "idle", "running"].includes(row.box_state);
  const runtimeState = projectedRuntimeState(row, latestOperation);
  const operationError = latestOperation
    && ["failed", "interrupted"].includes(latestOperation.status)
    ? latestOperation.error
    : null;
  const runtimeError = runtimeState === "error"
    ? row.last_error_message ?? operationError?.message
    : null;
  const skillsError = row.skills_update_error_message ?? companion.runtime.skills_last_error;
  return {
    ...companion,
    selected_skill_ids: companionSelectedSkillIdsSchema.parse(row.selected_skill_ids),
    selected_mcp_account_ids: companionSelectedMcpAccountIdsSchema.parse(
      row.selected_mcp_account_ids,
    ),
    runtime: {
      ...companion.runtime,
      generation: positiveInteger(row.generation),
      state: runtimeState,
      daemon_state: projectedDaemonState(row),
      replying: row.is_replying === true,
      box_id: row.access_role === "viewer" ? null : row.box_id,
      disk_layout_version: integer(row.disk_layout_version),
      desktop_available: row.access_role !== "viewer" && row.box_id !== null && runnableBox,
      last_error: runtimeError
        ? row.access_role === "viewer"
          ? "Companion runtime needs attention."
          : runtimeError
        : null,
      skills_applied_revision: integer(row.applied_skills_revision),
      skills_revision: integer(row.skills_available_revision),
      // Runtime v2 deliberately stores the monotonic revision, not an approximate timestamp. The
      // UI can say "up to date" without mislabeling a later health observation as the apply time.
      skills_applied_at: null,
      skills_last_error: skillsError
        ? row.access_role === "viewer"
          ? COMPANION_SKILLS_SYNC_ERROR_VIEWER_MESSAGE
          : skillsError
        : null,
      last_observed_at: lastObservedAt,
      latest_operation: projectedOperation(latestOperation, row.access_role === "viewer"),
    },
  };
}

export async function readCompanionRuntimeV2(input: {
  orgId: string;
  companionId: string;
  database: Db;
}): Promise<RuntimeReadRow> {
  const result = await input.database.execute(sql`
    select * from public.companion_api_read_runtime(
      ${input.orgId}::uuid, ${input.companionId}::uuid
    )
  `);
  const syncResult = await input.database.execute(sql`
    select * from public.companion_api_read_skill_sync(
      ${input.orgId}::uuid, ${input.companionId}::uuid
    )
  `);
  const [runtime] = rows<Omit<RuntimeReadRow,
    "skills_available_revision" | "skills_update_error_message">>(result);
  const [sync] = rows<Pick<RuntimeReadRow,
    "skills_available_revision" | "skills_update_error_message">>(syncResult);
  const row = runtime && sync ? { ...runtime, ...sync } : null;
  if (!row) throw new Error("companion runtime projection is unavailable");
  return row;
}

export async function getCompanionV2(input: {
  actor: ActorContext;
  orgId: string;
  companionId: string;
  withLastMessage?: boolean;
  database: Db;
}): Promise<Companion> {
  const companion = await getCompanion(input);
  const runtime = await readCompanionRuntimeV2(input);
  return projectCompanionRuntimeV2(companion, runtime);
}

export async function listCompanionsV2(input: {
  actor: ActorContext;
  orgId: string;
  withLastMessage?: boolean;
  database: Db;
}): Promise<Companion[]> {
  const companions = await listCompanions(input);
  if (companions.length === 0) return [];
  const result = await input.database.execute(sql`
    select * from public.companion_api_list_runtime(${input.orgId}::uuid)
  `);
  const syncResult = await input.database.execute(sql`
    select * from public.companion_api_list_skill_sync(${input.orgId}::uuid)
  `);
  const syncs = new Map(rows<Pick<RuntimeReadRow,
    "skills_available_revision" | "skills_update_error_message"> & { companion_id: string }>(
      syncResult,
    ).map((sync) => [sync.companion_id, sync] as const));
  const runtimes = new Map(rows<Omit<RuntimeReadRow,
    "skills_available_revision" | "skills_update_error_message"> & { companion_id: string }>(
      result,
    ).map((runtime) => [runtime.companion_id, runtime] as const));
  return companions.map((companion) => {
    const runtime = runtimes.get(companion.id);
    const sync = syncs.get(companion.id);
    if (!runtime || !sync) throw new Error("companion runtime projection is unavailable");
    return projectCompanionRuntimeV2(companion, { ...runtime, ...sync });
  });
}

export async function createCompanionV2(input: {
  actor: ActorContext;
  orgId: string;
  name: string;
  persona?: string;
  providerId?: string;
  modelId?: string;
  selectedSkillIds?: string[];
  selectedMcpAccountIds?: string[];
  /* Icon field names mirror the contracts catalog; "shape" is the domain term. */
  // oxlint-disable-next-line anti-slop/no-shape-in-symbol-names
  icon?: { shape?: number; mouth?: number; accessory?: number; color?: number };
  sourceCompanionId?: string;
  database: Db;
}): Promise<Companion> {
  const org = await input.database.query.organizations.findFirst({
    where: eq(schema.organizations.id, input.orgId),
    columns: { defaultCompanionProviderId: true },
  });
  const providerId = input.providerId ?? org?.defaultCompanionProviderId ?? null;
  if (!providerId) {
    throw new CompanionProviderError(
      "provider_not_configured",
      "Choose a connected provider before creating this Companion.",
    );
  }
  const modelId = companionCatalogModel(
    await getCompanionProviderCatalog(),
    providerId,
    input.modelId,
  );
  if (!modelId) {
    throw new CompanionProviderError(
      "provider_model_invalid",
      "The selected model is not available for this provider.",
      providerId,
    );
  }
  // Skills Hub access is unconditional, and the legacy flag is pinned true to match the token the
  // Box receives. Nobody chooses this per Companion any more.
  // Icon catalogs are geometric; "shape" is the domain term.
  /* oxlint-disable anti-slop/no-shape-in-symbol-names */
  const result = await input.database.execute(sql`
    select * from public.companion_api_create_companion(
      ${input.orgId}::uuid,
      ${input.name}::text,
      ${input.persona ?? null}::text,
      ${providerId}::text,
      ${modelId}::text,
      ${JSON.stringify(input.selectedSkillIds ?? [])}::jsonb,
      true::boolean,
      ${JSON.stringify(input.selectedMcpAccountIds ?? [])}::jsonb,
      ${input.sourceCompanionId ?? null}::uuid,
      ${input.icon?.shape ?? 1}::smallint,
      ${input.icon?.mouth ?? 1}::smallint,
      ${input.icon?.accessory ?? 1}::smallint,
      ${input.icon?.color ?? 2}::smallint
    )
  `);
  /* oxlint-enable anti-slop/no-shape-in-symbol-names */
  const [created] = rows<{ companion_id: string }>(result);
  if (!created) throw new Error("failed to create Companion runtime projection");
  return getCompanionV2({ ...input, companionId: created.companion_id });
}

export async function updateCompanionV2(input: {
  actor: ActorContext;
  orgId: string;
  companionId: string;
  patch: Record<string, unknown>;
  database: Db;
}): Promise<Companion> {
  const patch = { ...input.patch };
  if ("provider_id" in patch || "model_id" in patch) {
    const current = await getCompanionV2(input);
    if (current.access === "viewer") throw new CompanionSettingsForbiddenError();
    const currentProviderId = current.runtime.provider_ids[0];
    const providerId = typeof patch.provider_id === "string" ? patch.provider_id : currentProviderId;
    const providerChanged = typeof patch.provider_id === "string" && patch.provider_id !== currentProviderId;
    const requestedModel = typeof patch.model_id === "string"
      ? patch.model_id
      : providerChanged || !current.model_id
        ? undefined
        : current.model_id;
    const modelId = providerId
      ? companionCatalogModel(await getCompanionProviderCatalog(), providerId, requestedModel)
      : undefined;
    if (!providerId || !modelId) {
      throw new CompanionProviderError(
        "provider_model_invalid",
        "The selected model is not available for this provider.",
        providerId ?? null,
      );
    }
    patch.model_id = modelId;
  }
  await input.database.execute(sql`
    select * from public.companion_api_update_companion(
      ${input.orgId}::uuid,
      ${input.companionId}::uuid,
      ${JSON.stringify(patch)}::jsonb
    )
  `);
  return getCompanionV2(input);
}

export async function setCompanionProviderV2(input: {
  actor: ActorContext;
  orgId: string;
  companionId: string;
  providerId: string;
  database: Db;
}): Promise<Companion> {
  const current = await getCompanionV2(input);
  if (current.access !== "owner") throw new CompanionSettingsForbiddenError();
  if (current.runtime.provider_ids.length > 0) {
    throw new CompanionRuntimeTransitionError(
      "this Companion already has a provider; create another Companion to use a different one",
    );
  }
  const modelId = companionCatalogModel(
    await getCompanionProviderCatalog(),
    input.providerId,
  );
  if (!modelId) {
    throw new CompanionProviderError(
      "provider_model_invalid",
      "The selected provider has no available model.",
      input.providerId,
    );
  }
  try {
    await input.database.execute(sql`
      select * from public.companion_api_set_initial_provider(
        ${input.orgId}::uuid,
        ${input.companionId}::uuid,
        ${input.providerId}::text,
        ${modelId}::text
      )
    `);
  } catch (error) {
    if (hasDatabaseErrorCode(error, "55000")) {
      throw new CompanionRuntimeTransitionError(
        "this Companion can no longer accept an initial provider; reload its settings",
      );
    }
    throw error;
  }
  return getCompanionV2(input);
}

export async function duplicateCompanionV2(input: {
  actor: ActorContext;
  orgId: string;
  companionId: string;
  database: Db;
}): Promise<Companion> {
  const source = await getCompanionV2(input);
  if (source.access !== "owner") throw new CompanionDuplicateForbiddenError();
  const providerId = source.runtime.provider_ids[0];
  if (!providerId || !source.model_id) {
    throw new CompanionProviderError(
      "provider_not_configured",
      "This Companion needs a connected provider and model before it can be duplicated.",
      providerId ?? null,
    );
  }
  const suffix = " copy";
  const cloned = await createCompanionV2({
    actor: input.actor,
    orgId: input.orgId,
    name: `${source.name.slice(0, 120 - suffix.length).trimEnd()}${suffix}`,
    persona: source.persona ?? undefined,
    providerId,
    modelId: source.model_id,
    selectedSkillIds: source.selected_skill_ids,
    selectedMcpAccountIds: source.selected_mcp_account_ids,
    icon: source.icon,
    sourceCompanionId: source.id,
    database: input.database,
  });
  if (source.section_id) {
    await input.database.execute(sql`
      select public.companion_api_assign_section(
        ${input.orgId}::uuid, ${cloned.id}::uuid, ${source.section_id}::uuid
      )
    `);
    return getCompanionV2({ ...input, companionId: cloned.id });
  }
  return cloned;
}

export async function updateCompanionMemberStateV2(input: {
  actor: ActorContext;
  orgId: string;
  companionId: string;
  patch: { pinned?: boolean; hidden?: boolean; muted?: boolean; unread?: boolean };
  database: Db;
}): Promise<Companion> {
  await input.database.execute(sql`
    select * from public.companion_api_update_member_state_v2(
      ${input.orgId}::uuid,
      ${input.companionId}::uuid,
      ${input.patch.pinned ?? null}::boolean,
      ${input.patch.hidden ?? null}::boolean,
      ${input.patch.muted ?? null}::boolean,
      ${input.patch.unread ?? null}::boolean
    )
  `);
  return getCompanionV2(input);
}

export async function setCompanionWorkspaceShareV2(input: {
  actor: ActorContext;
  orgId: string;
  companionId: string;
  role: CompanionShareRole | null;
  database: Db;
}) {
  await input.database.execute(sql`
    select * from public.companion_api_set_workspace_access(
      ${input.orgId}::uuid,
      ${input.companionId}::uuid,
      ${input.role ?? null}::companion_share_role
    )
  `);
  return listCompanionShares(input);
}

type ThreadReadRow = {
  access_role: CompanionAccess;
  entries: unknown;
  active_turn: unknown;
  queued_count: number | string;
  interrupted_turn: unknown;
  last_message_at: Date | string | null;
  previous_last_read_ordinal: number | string | null;
  hidden_routine_relay_turn_ids: unknown;
  routine_notify_returns: unknown;
};

export type RoutineNotifyReturn = CompanionRoutineNotifyReturn;

type RoutineNotifyUnit = {
  marker: CompanionTranscriptEntry;
  update: CompanionTranscriptEntry;
  routineId: string;
  routineName: string;
};

/**
 * Collapse only complete, adjacent marker/update pairs that the routine-history projection proves
 * are terminal `notify` returns. Storage stays untouched: every earlier entry moves under the
 * latest update in exact ordinal order, where first-party clients can disclose it inline.
 */
export function collapseRoutineNotifyEntries(
  entries: readonly CompanionTranscriptEntry[],
  notifyReturns: readonly RoutineNotifyReturn[],
): CompanionTranscriptEntry[] {
  // PostgreSQL projections historically ordered only by ordinal. Normalize ties before interpreting
  // marker/update adjacency so legacy duplicate ordinals cannot change grouping between reads.
  const orderedEntries = [...entries].sort((left, right) =>
    left.ordinal - right.ordinal
    || (left.event_id < right.event_id ? -1 : left.event_id > right.event_id ? 1 : 0));
  const notifyByRun = new Map(notifyReturns.map((returned) => [returned.run_id, returned]));
  const collapsed: CompanionTranscriptEntry[] = [];
  let open: RoutineNotifyUnit[] = [];

  const flush = () => {
    if (open.length === 0) return;
    if (open.length === 1) {
      collapsed.push(open[0]!.marker, open[0]!.update);
      open = [];
      return;
    }
    const latest = open.at(-1)!;
    collapsed.push(latest.marker, {
      ...latest.update,
      routine_notify_group: {
        routine_id: latest.routineId,
        routine_name: latest.routineName,
        total_count: open.length,
        hidden_entries: open.slice(0, -1).flatMap((unit) => [unit.marker, unit.update]),
      },
    });
    open = [];
  };

  for (let index = 0; index < orderedEntries.length;) {
    const marker = orderedEntries[index]!;
    const update = orderedEntries[index + 1];
    const runId = marker.routine?.run_id ?? null;
    const returned = runId ? notifyByRun.get(runId) : undefined;
    const collapsible = returned !== undefined
      && marker.role === "user"
      && marker.routine?.id === returned.routine_id
      && marker.routine?.name === returned.routine_name
      && marker.attachments.length === 0
      && marker.decision === null
      && update?.event_id === returned.main_entry_event_id
      && update.role === "assistant"
      && update.attachments.length === 0
      && update.decision === null;

    if (!collapsible || !update) {
      flush();
      collapsed.push(marker);
      index += 1;
      continue;
    }

    if (open.length > 0 && (
      open[0]!.routineId !== returned.routine_id
      || open[0]!.routineName !== returned.routine_name
    )) flush();
    open.push({
      marker,
      update,
      routineId: returned.routine_id,
      routineName: returned.routine_name,
    });
    index += 2;
  }
  flush();
  return collapsed;
}

async function readCompanionThreadProjection(input: {
  actor: ActorContext;
  orgId: string;
  companionId: string;
  database: Db;
  markRead: boolean;
}): Promise<CompanionThread> {
  const result = input.markRead
    ? await input.database.execute(sql`
      select thread_read.*,
        public.companion_api_routine_hidden_relay_turns(
          ${input.orgId}::uuid, ${input.companionId}::uuid
        ) as hidden_routine_relay_turn_ids,
        public.companion_api_routine_notify_returns(
          ${input.orgId}::uuid, ${input.companionId}::uuid
        ) as routine_notify_returns
      from public.companion_api_read_thread(
        ${input.orgId}::uuid, ${input.companionId}::uuid
      ) thread_read
    `)
    : await input.database.execute(sql`
      select thread_read.*,
        public.companion_api_routine_hidden_relay_turns(
          ${input.orgId}::uuid, ${input.companionId}::uuid
        ) as hidden_routine_relay_turn_ids,
        public.companion_api_routine_notify_returns(
          ${input.orgId}::uuid, ${input.companionId}::uuid
        ) as routine_notify_returns
      from public.companion_api_sync_thread(
        ${input.orgId}::uuid, ${input.companionId}::uuid
      ) thread_read
    `);
  const [row] = rows<ThreadReadRow>(result);
  if (!row) throw new Error("companion thread projection is unavailable");
  const hiddenRoutineRelayTurnIds = new Set(z.array(z.string().uuid()).parse(
    row.hidden_routine_relay_turn_ids,
  ));
  const visibleEntries = (z.array(companionTranscriptEntrySchema).parse(row.entries) as CompanionTranscriptEntry[])
    .filter((entry) => entry.turn_id === null || !hiddenRoutineRelayTurnIds.has(entry.turn_id))
    .map((entry) => entry.routine !== null && entry.turn_id !== null
      ? { ...entry, routine: { ...entry.routine, run_id: entry.turn_id } }
      : entry);
  const notifyReturns = z.array(companionRoutineNotifyReturnSchema).parse(
    row.routine_notify_returns,
  );
  const entries = collapseRoutineNotifyEntries(visibleEntries, notifyReturns);
  const activeTurn = parseTurn(row.active_turn);
  const interruptedTurn = parseTurn(row.interrupted_turn);
  const queuedCount = integer(row.queued_count);
  return {
    companion_id: input.companionId,
    viewer_id: input.actor.id,
    access: row.access_role,
    read_only: row.access_role === "viewer",
    can_send: row.access_role !== "viewer",
    entries,
    active_turn: activeTurn?.status === "interrupted" ? null : activeTurn,
    queued_count: queuedCount,
    interrupted_turn: interruptedTurn?.status === "interrupted" ? interruptedTurn : null,
    last_message_at: iso(row.last_message_at),
    last_read_ordinal: row.previous_last_read_ordinal === null
      ? null
      : integer(row.previous_last_read_ordinal),
  };
}

/** Opening the thread advances this member's unread watermark. */
export async function readCompanionThreadV2(input: {
  actor: ActorContext;
  orgId: string;
  companionId: string;
  database: Db;
}): Promise<CompanionThread> {
  return readCompanionThreadProjection({ ...input, markRead: true });
}

/** Background delta reads preserve unread state while returning the identical projection shape. */
export async function syncCompanionThreadV2(input: {
  actor: ActorContext;
  orgId: string;
  companionId: string;
  database: Db;
}): Promise<CompanionThread> {
  return readCompanionThreadProjection({ ...input, markRead: false });
}

type ThreadWindowReadRow = {
  access_role: CompanionAccess;
  entries: unknown;
  active_turn: unknown;
  queued_count: number | string;
  interrupted_turn: unknown;
  last_message_at: Date | string | null;
  previous_last_read_ordinal: number | string | null;
  older_before_ordinal: number | string | null;
  sync_sequence: number | string | bigint;
  routine_notify_returns: unknown;
};

type ThreadChangesReadRow = {
  access_role: CompanionAccess;
  changed_entries: unknown;
  deleted_event_ids: unknown;
  active_turn: unknown;
  queued_count: number | string;
  interrupted_turn: unknown;
  last_message_at: Date | string | null;
  last_read_ordinal: number | string | null;
  next_sequence: number | string | bigint;
  has_more: boolean;
  routine_notify_returns: unknown;
};

function bigintValue(value: number | string | bigint): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return BigInt(value);
  }
  if (typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value)) {
    return BigInt(value);
  }
  throw new Error("Companion thread projection sequence is invalid");
}

function companionThreadMetadata(input: {
  actor: ActorContext;
  companionId: string;
  row: Pick<ThreadWindowReadRow,
    | "access_role"
    | "active_turn"
    | "queued_count"
    | "interrupted_turn"
    | "last_message_at"
    | "previous_last_read_ordinal">;
}): CompanionThreadMetadata {
  const activeTurn = parseTurn(input.row.active_turn);
  const interruptedTurn = parseTurn(input.row.interrupted_turn);
  return {
    companion_id: input.companionId,
    viewer_id: input.actor.id,
    access: input.row.access_role,
    read_only: input.row.access_role === "viewer",
    can_send: input.row.access_role !== "viewer",
    active_turn: activeTurn?.status === "interrupted" ? null : activeTurn,
    queued_count: integer(input.row.queued_count),
    interrupted_turn: interruptedTurn?.status === "interrupted" ? interruptedTurn : null,
    last_message_at: iso(input.row.last_message_at),
    last_read_ordinal: input.row.previous_last_read_ordinal === null
      ? null
      : integer(input.row.previous_last_read_ordinal),
  };
}

/** Open one bounded recent/history window. Only the initial window advances this viewer's watermark. */
export async function readCompanionThreadWindowV2(input: {
  actor: ActorContext;
  orgId: string;
  companionId: string;
  beforeOrdinal: number | null;
  limit: number;
  database: Db;
}): Promise<CompanionThreadWindow> {
  const result = await input.database.execute(sql`
    select * from public.companion_api_read_thread_window(
      ${input.orgId}::uuid,
      ${input.companionId}::uuid,
      ${input.beforeOrdinal}::integer,
      ${input.limit}::integer,
      ${input.beforeOrdinal === null}::boolean
    )
  `);
  const [row] = rows<ThreadWindowReadRow>(result);
  if (!row) throw new Error("Companion thread window projection is unavailable");
  const entries = z.array(companionTranscriptEntrySchema).parse(row.entries);
  const sequence = bigintValue(row.sync_sequence);
  return companionThreadWindowSchema.parse({
    thread: companionThreadMetadata({ actor: input.actor, companionId: input.companionId, row }),
    entries,
    older_cursor: row.older_before_ordinal === null
      ? null
      : buildCompanionThreadWindowCursor({
          orgId: input.orgId,
          actorId: input.actor.id,
          companionId: input.companionId,
          beforeOrdinal: integer(row.older_before_ordinal),
        }),
    sync_cursor: buildCompanionThreadSequenceCursor({
      orgId: input.orgId,
      actorId: input.actor.id,
      companionId: input.companionId,
      sequence,
    }),
    notify_returns: z.array(companionRoutineNotifyReturnSchema).parse(
      row.routine_notify_returns,
    ),
  });
}

/** Read at most 200 changed projections without aggregating the unchanged transcript. */
export async function readCompanionThreadChangesV2(input: {
  actor: ActorContext;
  orgId: string;
  companionId: string;
  afterSequence: bigint;
  database: Db;
}): Promise<CompanionThreadDeltaResponse> {
  const result = await input.database.execute(sql`
    select * from public.companion_api_read_thread_changes(
      ${input.orgId}::uuid,
      ${input.companionId}::uuid,
      ${input.afterSequence.toString()}::bigint,
      ${COMPANION_THREAD_DELTA_MAX_CHANGES}::integer
    )
  `);
  const [row] = rows<ThreadChangesReadRow>(result);
  if (!row) throw new Error("Companion thread changes projection is unavailable");
  const sequence = bigintValue(row.next_sequence);
  return companionThreadDeltaResponseSchema.parse({
    cursor: buildCompanionThreadSequenceCursor({
      orgId: input.orgId,
      actorId: input.actor.id,
      companionId: input.companionId,
      sequence,
    }),
    reset_entries: false,
    changed_entries: z.array(companionTranscriptEntrySchema).parse(row.changed_entries),
    deleted_event_ids: z.array(z.string().min(1).max(200)).parse(row.deleted_event_ids),
    thread: companionThreadMetadata({
      actor: input.actor,
      companionId: input.companionId,
      row: {
        ...row,
        previous_last_read_ordinal: row.last_read_ordinal,
      },
    }),
    has_more: row.has_more,
    notify_returns: z.array(companionRoutineNotifyReturnSchema).parse(
      row.routine_notify_returns,
    ),
  });
}

/** Capture the sequence before a legacy full comparison so a concurrent write cannot be skipped. */
export async function readCompanionThreadProjectionSequenceV2(input: {
  actor: ActorContext;
  orgId: string;
  companionId: string;
  database: Db;
}): Promise<bigint> {
  const result = await input.database.execute(sql`
    select public.companion_api_read_thread_projection_sequence(
      ${input.orgId}::uuid,
      ${input.companionId}::uuid
    ) as projection_sequence
  `);
  const [row] = rows<{ projection_sequence: number | string | bigint }>(result);
  if (!row) throw new Error("Companion thread projection sequence is unavailable");
  return bigintValue(row.projection_sequence);
}

export async function enqueueCompanionTurnV2(input: {
  actor: ActorContext;
  orgId: string;
  companionId: string;
  clientMessageId: string;
  content: string;
  clientSurface: CompanionClientSurface;
  /**
   * Files already stored in object storage under their content address. They land in the same
   * transaction as the message and the turn, so a claimable turn always finds every file the runtime
   * has to stage. A replay compares them by content, not by row id or key, which is what makes
   * re-uploading identical bytes the same intent rather than a conflict.
   */
  attachments?: CompanionAttachmentUpload[];
  database: Db;
}): Promise<{ turn: CompanionTurn; operation: CompanionOperation | null; replayed: boolean }> {
  const attachments = (input.attachments ?? []).map((attachment) =>
    companionAttachmentUploadSchema.parse(attachment));
  const result = await input.database.execute(sql`
    select * from public.companion_api_enqueue_turn(
      ${input.orgId}::uuid,
      ${input.companionId}::uuid,
      ${input.clientMessageId}::uuid,
      ${input.content},
      ${input.clientSurface}::companion_client_surface,
      ${JSON.stringify(attachments)}::jsonb
    )
  `);
  const [row] = rows<{ turn: unknown; operation: unknown; replayed: boolean }>(result);
  if (!row) throw new Error("failed to enqueue Companion turn");
  return {
    turn: companionTurnSchema.parse(row.turn),
    operation: parseOperation(row.operation),
    replayed: row.replayed,
  };
}

export interface CompanionAttachmentAsset {
  storageKey: string;
  contentType: string;
  byteSize: number;
  filename: string;
  kind: "user_upload" | "pi_output";
}

/**
 * Resolve one attachment's stored bytes for a reader who may read its thread.
 *
 * Access is decided on this call and no other: nothing signed or long-lived is ever handed out, so a
 * reader who loses access stops being able to fetch the file at the next request rather than at the
 * next cache expiry. The storage key never leaves the server.
 */
export async function readCompanionAttachmentV2(input: {
  actor: ActorContext;
  orgId: string;
  companionId: string;
  attachmentId: string;
  database: Db;
}): Promise<CompanionAttachmentAsset> {
  const result = await input.database.execute(sql`
    select * from public.companion_api_read_attachment(
      ${input.orgId}::uuid,
      ${input.companionId}::uuid,
      ${input.attachmentId}::uuid
    )
  `);
  const [row] = rows<{
    storage_key: string;
    content_type: string;
    byte_size: number | string;
    filename: string;
    kind: "user_upload" | "pi_output";
  }>(result);
  if (!row) throw new Error("companion attachment is unavailable");
  return {
    storageKey: row.storage_key,
    contentType: row.content_type,
    byteSize: integer(row.byte_size),
    filename: row.filename,
    kind: row.kind,
  };
}

export async function enqueueCompanionOperationV2(input: {
  orgId: string;
  companionId: string;
  requestId: string;
  kind: CompanionOperationKind;
  clientSurface: CompanionClientSurface;
  database: Db;
}): Promise<{ operation: CompanionOperation; replayed: boolean }> {
  const result = await input.database.execute(sql`
    select * from public.companion_api_enqueue_operation(
      ${input.orgId}::uuid,
      ${input.companionId}::uuid,
      ${input.requestId}::uuid,
      ${input.kind}::companion_operation_kind,
      ${input.clientSurface}::companion_client_surface
    )
  `);
  const [row] = rows<{ operation: unknown; replayed: boolean }>(result);
  if (!row) throw new Error("failed to enqueue Companion operation");
  return { operation: companionOperationSchema.parse(row.operation), replayed: row.replayed };
}

export async function answerCompanionDecisionV2(input: {
  orgId: string;
  companionId: string;
  requestId: string;
  decision: string;
  optionId?: string;
  text?: string;
  database: Db;
}): Promise<void> {
  await input.database.execute(sql`
    select * from public.companion_api_answer_decision(
      ${input.orgId}::uuid,
      ${input.companionId}::uuid,
      ${input.requestId},
      ${input.decision},
      ${input.optionId ?? input.text ?? null}
    )
  `);
}

export type CompanionDecisionRecord = {
  requestKey: string;
  requestKind: string;
  decisionStatus: string;
  proposal: CompanionDecisionProposal | null;
  expiresAt: string;
};

export async function getCompanionDecisionV2(input: {
  orgId: string;
  companionId: string;
  requestId: string;
  database: Db;
}): Promise<CompanionDecisionRecord> {
  const result = await input.database.execute(sql`
    select request_key, request_kind::text as request_kind,
      decision_status::text as decision_status, proposal, expires_at
    from public.companion_api_get_decision(
      ${input.orgId}::uuid,
      ${input.companionId}::uuid,
      ${input.requestId}
    )
  `);
  const [row] = rows<{
    request_key: string;
    request_kind: string;
    decision_status: string;
    proposal: unknown;
    expires_at: Date | string;
  }>(result);
  if (!row) throw new CompanionDecisionNotFoundError();
  return {
    requestKey: row.request_key,
    requestKind: row.request_kind,
    decisionStatus: row.decision_status,
    proposal: row.proposal == null ? null : companionDecisionProposalSchema.parse(row.proposal),
    expiresAt: iso(row.expires_at) ?? new Date(row.expires_at).toISOString(),
  };
}

export async function answerCompanionConfigDecisionV2(input: {
  orgId: string;
  companionId: string;
  requestId: string;
  decision: "allow" | "deny";
  database: Db;
}): Promise<void> {
  await input.database.execute(sql`
    select * from public.companion_api_answer_config_decision(
      ${input.orgId}::uuid,
      ${input.companionId}::uuid,
      ${input.requestId},
      ${input.decision}
    )
  `);
}

export async function cancelCompanionTurnV2(input: {
  orgId: string;
  companionId: string;
  turnId: string;
  database: Db;
}): Promise<CompanionTurn> {
  const result = await input.database.execute(sql`
    select * from public.companion_api_cancel_turn(
      ${input.orgId}::uuid,
      ${input.companionId}::uuid,
      ${input.turnId}::uuid
    )
  `);
  const [row] = rows<{ turn: unknown }>(result);
  if (!row) throw new Error("failed to cancel Companion turn");
  return companionTurnSchema.parse(row.turn);
}

export async function bumpCompanionSkillAvailableRevisionV2(input: {
  orgId: string;
  skillId: string;
  database: Db;
}): Promise<number> {
  const result = await input.database.execute(sql`
    select public.companion_api_bump_skill_revision(
      ${input.orgId}::uuid,
      ${input.skillId}::uuid
    ) as changed
  `);
  return integer(rows<{ changed: number | string }>(result)[0]?.changed);
}

export async function bumpCompanionSkillRevisionV2(input: {
  orgId: string;
  skillId: string;
  database: Db;
}): Promise<number> {
  const result = await input.database.execute(sql`
    select public.companion_api_require_skill_revision(
      ${input.orgId}::uuid, ${input.skillId}::uuid
    ) as changed
  `);
  return integer(rows<{ changed: number | string }>(result)[0]?.changed);
}
