import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { ListObjectsV2Command, type ListObjectsV2CommandInput } from "@aws-sdk/client-s3";
import {
  AsciiBoxMaintenanceClient,
  BoxRuntimeAdapterError,
  isCompanionRuntimeImageName,
  type BoxRuntimeLifecycleClient,
} from "@companion/box-runtime";
import {
  inspectCompanionTriggerWebhook,
  unregisterCompanionTriggerWebhook,
  loadSecretsMasterKey,
} from "@companion/core";
import { createDatabase, withTenantContextOn } from "@companion/db";
import {
  createStorageClient,
  deleteStorageObject,
  getStorageConfig,
} from "@companion/storage";
import postgres from "postgres";

import {
  type LegacyTargetJournal,
} from "./companionPurge";

export const COMPANION_V2_PURGE_RUN_ID = "runtime-v2-purge";
export const COMPANION_V2_PURGE_LOCK_CLASS_ID = 72_401;
export const COMPANION_V2_PURGE_LOCK_OBJECT_ID = 20_260_608;
const V2_BOX_NAME = /^Companion ([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}) g[1-9][0-9]*$/;
const BOX_DELETE_POLL_INTERVAL_MS = 1_000;
const BOX_DELETE_TIMEOUT_MS = 15 * 60_000;

export type CompanionV2PurgeInvocation =
  | { mode: "report" }
  | { mode: "dry-run" }
  | { mode: "purge" };

export type CompanionV2PurgeTargetKind = "trigger" | "object" | "snapshot" | "box";
export type CompanionV2PurgeTargetState =
  | "discovered"
  | "requesting"
  | "completed"
  | "absent";

export interface CompanionV2PurgeTarget {
  kind: CompanionV2PurgeTargetKind;
  key: string;
  evidence: string[];
  state?: CompanionV2PurgeTargetState;
  operationId?: string | null;
  retryAfter?: string | null;
}

export interface CompanionV2PurgeJournal {
  markRequesting(target: CompanionV2PurgeTarget): Promise<void>;
  markComplete(
    target: CompanionV2PurgeTarget,
    outcome: "completed" | "absent",
  ): Promise<void>;
  markFailure(
    target: CompanionV2PurgeTarget,
    message: string,
    disposition?: "ambiguous" | "retryable",
  ): Promise<void>;
}

export type CompanionV2PurgeSql = ReturnType<typeof postgres>;
export type CompanionV2BoxPurgeClient = Pick<
  BoxRuntimeLifecycleClient,
  "listAllBoxes" | "listNamedSnapshots" | "deleteNamedSnapshot"
    | "requestPermanentDeletion" | "getDeletionOperation"
>;

export interface CompanionV2PurgeResult {
  already_complete: boolean;
  companions?: number;
  companion_tokens?: number;
  object_deletion_rows?: number;
  remaining_companion_rows?: number;
}

export interface CompanionV2DatabaseInventory {
  rowCounts: Record<string, number>;
  targets: CompanionV2PurgeTarget[];
  triggerOwners: Array<{
    triggerId: string;
    orgId: string;
    companionId: string;
    ownerId: string;
    provider: "linear" | "github" | "sentry";
    providerAccountId: string | null;
    remoteHookId: string | null;
    target: {
      repo?: string;
      organization?: string;
      project?: string;
      events?: string[];
    };
  }>;
}

export interface CompanionV2PurgeInventory {
  rowCounts: Record<string, number>;
  targets: CompanionV2PurgeTarget[];
  triggerOwners: CompanionV2DatabaseInventory["triggerOwners"];
  providerCounts: { boxes: number; snapshots: number; objects: number };
  hash: string;
}

export interface CompanionV2ObjectStore {
  listKeys(): Promise<string[]>;
  remove(key: string): Promise<"completed" | "absent">;
}

export interface CompanionV2TriggerRemover {
  inspect(owner: CompanionV2DatabaseInventory["triggerOwners"][number]): Promise<"present" | "absent">;
  remove(owner: CompanionV2DatabaseInventory["triggerOwners"][number]): Promise<"completed" | "absent">;
}

const PURGED_COMPANION_TABLES = [
  "companion_sections",
  "companions",
  "companion_peer_grants",
  "companion_control_tokens",
  "companion_routines",
  "companion_triggers",
  "companion_images",
  "companion_runtime_instances",
  "companion_turns",
  "companion_v3_instances",
  "companion_v3_decisions",
  "companion_v3_turns",
  "companion_v3_lane_leases",
  "companion_control_requests",
  "companion_control_invocations",
  "companion_deferred_pi_restarts",
  "companion_delegations",
  "companion_notification_devices",
  "companion_notification_deliveries",
  "companion_turn_attempts",
  "companion_operations",
  "companion_decision_deliveries",
  "companion_runtime_duplicate_cleanups",
  "companion_runtime_event_projections",
  "companion_runtime_desktop_requests",
  "companion_runtime_leases",
  "companion_workspace_access",
  "companion_member_state",
  "companion_threads",
  "companion_main_pi_compactions",
  "companion_routine_context_substrates",
  "companion_transcript_entries",
  "companion_routine_run_entries",
  "companion_routine_returns",
  "companion_message_attachments",
  "companion_mcp_broker_tokens",
] as const;

export function mergeCompanionV2PurgeTargets(
  targets: readonly CompanionV2PurgeTarget[],
): CompanionV2PurgeTarget[] {
  const merged = new Map<string, CompanionV2PurgeTarget>();
  for (const target of targets) {
    const identity = `${target.kind}:${target.key}`;
    const current = merged.get(identity);
    const next: CompanionV2PurgeTarget = {
      kind: target.kind,
      key: target.key,
      evidence: [...new Set([...(current?.evidence ?? []), ...target.evidence])].sort(),
    };
    const state = target.state ?? current?.state;
    if (state) next.state = state;
    if (
      current?.operationId
      && target.operationId
      && current.operationId !== target.operationId
    ) {
      throw new Error(`Box ${target.key} has conflicting provider deletion operations`);
    }
    const operationId = target.operationId ?? current?.operationId;
    if (operationId) next.operationId = operationId;
    const retryAfter = target.retryAfter ?? current?.retryAfter;
    if (retryAfter) next.retryAfter = retryAfter;
    merged.set(identity, next);
  }
  return [...merged.values()].sort((left, right) =>
    left.kind.localeCompare(right.kind) || left.key.localeCompare(right.key));
}

export async function processCompanionV2PurgeTargets(input: {
  targets: readonly CompanionV2PurgeTarget[];
  journal: CompanionV2PurgeJournal;
  providerPresent(target: CompanionV2PurgeTarget): boolean | Promise<boolean>;
  beforeExternalEffect?(target: CompanionV2PurgeTarget): Promise<void>;
  afterExternalEffect?(target: CompanionV2PurgeTarget): Promise<void>;
  pause?(milliseconds: number): Promise<void>;
  nowMs?: () => number;
  remove(target: CompanionV2PurgeTarget): Promise<"completed" | "absent">;
}): Promise<void> {
  for (const target of input.targets) {
    if (target.state === "completed" || target.state === "absent") continue;
    if (target.retryAfter) {
      const retryAt = Date.parse(target.retryAfter);
      if (!Number.isFinite(retryAt)) throw new Error("purge ledger contains an invalid retry time");
      const delay = Math.max(0, retryAt - (input.nowMs ?? Date.now)());
      if (delay > 0) {
        await (input.pause ?? ((milliseconds) => new Promise((resolve) => {
          setTimeout(resolve, milliseconds);
        })))(delay);
      }
    }
    const present = await input.providerPresent(target);
    if (present === false) {
      await input.journal.markComplete(target, "absent");
      continue;
    }
    await input.journal.markRequesting(target);
    try {
      await input.beforeExternalEffect?.(target);
      const outcome = await input.remove(target);
      if (target.kind !== "box") await input.afterExternalEffect?.(target);
      await input.journal.markComplete(target, outcome);
    } catch (error) {
      const disposition = target.kind === "box"
        && error instanceof BoxRuntimeAdapterError
        && !error.outcomeUnknown
        ? "retryable"
        : "ambiguous";
      await input.journal.markFailure(
        target,
        "external removal failed; retry the purge",
        disposition,
      ).catch(() => undefined);
      throw error;
    }
  }
}

function usage(): string {
  return "usage: node dist/companionV2Purge.js report | purge --dry-run | purge --confirm-delete-all-companions";
}

export function parseCompanionV2PurgeArgs(
  argv: readonly string[],
): CompanionV2PurgeInvocation {
  if (argv.length === 1 && argv[0] === "report") return { mode: "report" };
  if (argv.length === 2 && argv[0] === "purge" && argv[1] === "--dry-run") {
    return { mode: "dry-run" };
  }
  if (
    argv.length === 2
    && argv[0] === "purge"
    && argv[1] === "--confirm-delete-all-companions"
  ) {
    return { mode: "purge" };
  }
  throw new Error(usage());
}

export function companionV2PurgeDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const value = env.DATABASE_MIGRATION_URL?.trim();
  if (!value) throw new Error("DATABASE_MIGRATION_URL is required for the Runtime v2 purge");
  return value;
}

export function assertCompanionV2PurgeDisabled(env: NodeJS.ProcessEnv = process.env): void {
  if (env.COMPANION_COMPANIONS_ENABLED?.trim().toLowerCase() !== "false") {
    throw new Error(
      "COMPANION_COMPANIONS_ENABLED must be explicitly set to false before the Runtime v2 purge",
    );
  }
}

export async function assertCompanionV2DatabaseQuiescent(
  client: CompanionV2PurgeSql,
): Promise<void> {
  const [state] = await client<Array<{
    disabled: boolean;
    runtimeClaims: string;
    v3Claims: string;
  }>>`
    select
      exists (
        select 1 from public.companion_runtime_control
        where id = 'runtime-v2' and enabled = false
      ) as disabled,
      (select count(*)::text from public.companion_runtime_leases
        where claim_token is not null) as "runtimeClaims",
      (select count(*)::text from public.companion_v3_lane_leases
        where claim_token is not null) as "v3Claims"
  `;
  if (!state?.disabled) throw new Error("Runtime v2 database gate must be disabled before purge");
  if (safeCount(state.runtimeClaims) > 0 || safeCount(state.v3Claims) > 0) {
    throw new Error("Runtime leases must be neutral before purge");
  }
}

export async function acquireCompanionV2PurgeLock(
  client: CompanionV2PurgeSql,
): Promise<boolean> {
  const [row] = await client<Array<{ locked: boolean }>>`
    select pg_try_advisory_lock(
      ${COMPANION_V2_PURGE_LOCK_CLASS_ID}, ${COMPANION_V2_PURGE_LOCK_OBJECT_ID}
    ) as locked
  `;
  return row?.locked ?? false;
}

export async function assertCompanionV2PurgeLockHeld(
  client: CompanionV2PurgeSql,
): Promise<void> {
  const [row] = await client<Array<{ held: boolean }>>`
    select exists (
      select 1 from pg_catalog.pg_locks
      where locktype = 'advisory' and pid = pg_backend_pid()
        and classid = ${COMPANION_V2_PURGE_LOCK_CLASS_ID}::oid
        and objid = ${COMPANION_V2_PURGE_LOCK_OBJECT_ID}::oid
    ) as held
  `;
  if (!row?.held) throw new Error("Runtime v2 purge advisory lock must be held");
}

function safeCount(value: string | number | undefined): number {
  const count = Number(value ?? 0);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error("database returned an invalid Runtime v2 purge count");
  }
  return count;
}

export async function inventoryCompanionV2Database(
  client: CompanionV2PurgeSql,
): Promise<CompanionV2DatabaseInventory> {
  const rowCounts: Record<string, number> = {};
  for (const table of PURGED_COMPANION_TABLES) {
    const [row] = await client.unsafe<Array<{ count: string }>>(
      `select count(*)::text as count from public.${table}`,
    );
    rowCounts[table] = safeCount(row?.count);
  }
  const [tokenCount] = await client<Array<{ count: string }>>`
    select count(*)::text as count from public.api_tokens where source_type = 'companion'
  `;
  const [objectOutboxCount] = await client<Array<{ count: string }>>`
    select count(*)::text as count from public.skill_database_object_deletions
    where storage_key like 'companion-attachments/%'
  `;
  rowCounts.companion_api_tokens = safeCount(tokenCount?.count);
  rowCounts.companion_object_deletions = safeCount(objectOutboxCount?.count);

  const targets: CompanionV2PurgeTarget[] = [];
  const boxRows = await client<Array<{
    key: string;
    evidence: string;
    operationId: string | null;
  }>>`
    select box_id as key, 'database:runtime-instance'::text as evidence,
           null::text as "operationId"
    from public.companion_runtime_instances where box_id is not null
    union all
    select instance.box_id, 'database:delete-operation', operation.provider_operation_id
    from public.companion_runtime_instances instance
    join public.companion_operations operation
      on operation.org_id = instance.org_id
     and operation.companion_id = instance.companion_id
    where instance.box_id is not null
      and operation.kind = 'delete'
      and operation.provider_operation_id is not null
    union all
    select box_id, 'database:duplicate-cleanup', provider_operation_id
    from public.companion_runtime_duplicate_cleanups where box_id is not null
    union all
    select build_box_id, 'database:image-build-box', build_delete_operation_id
    from public.companion_images where build_box_id is not null
  `;
  targets.push(...boxRows.map((row) => ({
    kind: "box" as const,
    key: row.key,
    evidence: [row.evidence],
    operationId: row.operationId,
  })));

  const snapshots = await client<Array<{ key: string }>>`
    select image_name as key from public.companion_images
  `;
  targets.push(...snapshots.map((row) => ({
    kind: "snapshot" as const,
    key: row.key,
    evidence: ["database:runtime-image"],
  })));

  const objects = await client<Array<{ key: string; evidence: string }>>`
    select storage_key as key, 'database:attachment'::text as evidence
    from public.companion_message_attachments
    union all
    select storage_key, 'database:object-deletion-outbox'
    from public.skill_database_object_deletions
    where storage_key like 'companion-attachments/%'
  `;
  targets.push(...objects.map((row) => ({
    kind: "object" as const,
    key: row.key,
    evidence: [row.evidence],
  })));

  const triggerOwners = await client<CompanionV2DatabaseInventory["triggerOwners"]>`
    select trigger.id::text as "triggerId", trigger.org_id::text as "orgId",
           trigger.companion_id::text as "companionId", companion.owner_id as "ownerId",
           trigger.provider, coalesce(trigger.remote_hook_account_id, trigger.provider_account_id)::text
             as "providerAccountId",
           trigger.remote_hook_id as "remoteHookId", trigger.target
    from public.companion_triggers trigger
    join public.companions companion
      on companion.org_id = trigger.org_id and companion.id = trigger.companion_id
    where trigger.remote_hook_id is not null
       or (
         trigger.provider in ('linear','github','sentry')
         and coalesce(trigger.remote_hook_account_id, trigger.provider_account_id) is not null
       )
    order by trigger.id
  `;
  targets.push(...triggerOwners.map((row) => ({
    kind: "trigger" as const,
    key: row.triggerId,
    evidence: [row.remoteHookId
      ? "database:remote-trigger-registration"
      : "database:ambiguous-trigger-registration"],
  })));
  return { rowCounts, targets: mergeCompanionV2PurgeTargets(targets), triggerOwners };
}

function productionObjectStore(): CompanionV2ObjectStore {
  const config = getStorageConfig();
  const client = createStorageClient(config);
  return {
    async listKeys() {
      return collectCompanionV2ObjectKeys(async (continuationToken) => {
        const request: ListObjectsV2CommandInput = {
          Bucket: config.bucket,
          Prefix: "companion-attachments/",
        };
        if (continuationToken) request.ContinuationToken = continuationToken;
        return client.send(new ListObjectsV2Command(request));
      });
    },
    async remove(key) {
      await deleteStorageObject({ key, client, config });
      return "completed";
    },
  };
}

export async function collectCompanionV2ObjectKeys(
  listPage: (continuationToken: string | undefined) => Promise<{
    Contents?: Array<{ Key?: string }>;
    IsTruncated?: boolean;
    NextContinuationToken?: string;
  }>,
): Promise<string[]> {
  const keys: string[] = [];
  const seenContinuationTokens = new Set<string>();
  let continuationToken: string | undefined;
  do {
    const response = await listPage(continuationToken);
    for (const item of response.Contents ?? []) {
      if (item.Key) keys.push(item.Key);
    }
    if (response.IsTruncated) {
      const next = response.NextContinuationToken;
      if (!next || seenContinuationTokens.has(next)) {
        throw new Error("object inventory returned invalid pagination");
      }
      seenContinuationTokens.add(next);
      continuationToken = next;
    } else {
      continuationToken = undefined;
    }
  } while (continuationToken);
  return keys.sort();
}

export async function collectCompanionV2PurgeInventory(input: {
  client: CompanionV2PurgeSql;
  boxClient: CompanionV2BoxPurgeClient;
  objectStore?: CompanionV2ObjectStore;
}): Promise<CompanionV2PurgeInventory> {
  const objectStore = input.objectStore ?? productionObjectStore();
  const [database, boxes, snapshots, objectKeys] = await Promise.all([
    inventoryCompanionV2Database(input.client),
    input.boxClient.listAllBoxes(),
    input.boxClient.listNamedSnapshots(),
    objectStore.listKeys(),
  ]);
  const providerTargets: CompanionV2PurgeTarget[] = [];
  const databaseBoxIds = new Set(
    database.targets.filter((target) => target.kind === "box").map((target) => target.key),
  );
  for (const box of boxes) {
    const evidence: string[] = [];
    if (databaseBoxIds.has(box.id)) evidence.push("provider-id:box");
    if (box.name && V2_BOX_NAME.test(box.name)) {
      evidence.push("provider-name:companion-generation");
    }
    if (evidence.length > 0) providerTargets.push({ kind: "box", key: box.id, evidence });
  }
  for (const snapshot of snapshots) {
    if (isCompanionRuntimeImageName(snapshot.name)) {
      providerTargets.push({
        kind: "snapshot",
        key: snapshot.name,
        evidence: ["provider-name:v2-image"],
      });
    }
  }
  providerTargets.push(...objectKeys.map((key) => ({
    kind: "object" as const,
    key,
    evidence: ["storage-prefix:companion-attachments"],
  })));
  const targets = mergeCompanionV2PurgeTargets([...database.targets, ...providerTargets]);
  const inventoryForHash = {
    rowCounts: database.rowCounts,
    targets: targets.map(({ kind, key, evidence, operationId }) => ({
      kind, key, evidence, operationId: operationId ?? null,
    })),
    providerCounts: {
      boxes: boxes.length,
      snapshots: snapshots.length,
      objects: objectKeys.length,
    },
  };
  return {
    ...inventoryForHash,
    triggerOwners: database.triggerOwners,
    hash: createHash("sha256").update(JSON.stringify(inventoryForHash)).digest("hex"),
  };
}

export async function loadCompanionV2PurgeTargets(
  client: CompanionV2PurgeSql,
): Promise<CompanionV2PurgeTarget[]> {
  const rows = await client<Array<{
    kind: CompanionV2PurgeTargetKind;
    key: string;
    evidence: string[];
    state: CompanionV2PurgeTargetState;
    operationId: string | null;
    retryAfter: string | null;
  }>>`
    select resource_kind as kind, resource_key as key, evidence, state,
           operation_id as "operationId", retry_after::text as "retryAfter"
    from public.companion_v2_purge_targets
    order by resource_kind, resource_key
  `;
  return rows;
}

async function seedCompanionV2PurgeLedger(
  client: CompanionV2PurgeSql,
  inventory: CompanionV2PurgeInventory,
): Promise<void> {
  const [fingerprintRow] = await client<Array<{ fingerprint: postgres.JSONValue }>>`
    select public.companion_v2_purge_preservation_fingerprint() as fingerprint
  `;
  if (!fingerprintRow?.fingerprint) throw new Error("Runtime v2 preservation fingerprint is unavailable");
  const existing = new Map((await loadCompanionV2PurgeTargets(client)).map((target) => [
    `${target.kind}:${target.key}`,
    target,
  ]));
  const snapshot = {
    rowCounts: inventory.rowCounts,
    providerCounts: inventory.providerCounts,
    targets: inventory.targets.map(({ kind, key, evidence, operationId }) => ({
      kind, key, evidence, operationId: operationId ?? null,
    })),
  } satisfies postgres.JSONValue;
  const fingerprint = fingerprintRow.fingerprint;

  await client.begin(async (tx) => {
    await tx`
      insert into public.companion_v2_purge_runs (
        id, phase, inventory_hash, inventory, preservation_fingerprint, updated_at
      ) values (
        ${COMPANION_V2_PURGE_RUN_ID}, 'deleting_external', ${inventory.hash},
        ${tx.json(snapshot)}, ${tx.json(fingerprint)}, statement_timestamp()
      )
      on conflict (id) do update set
        inventory_hash = excluded.inventory_hash,
        inventory = excluded.inventory,
        updated_at = excluded.updated_at
      where companion_v2_purge_runs.phase <> 'database_complete'
    `;
    for (const target of inventory.targets) {
      const previous = existing.get(`${target.kind}:${target.key}`);
      if (
        previous?.operationId
        && target.operationId
        && previous.operationId !== target.operationId
      ) {
        throw new Error(`Box ${target.key} has conflicting provider deletion operations`);
      }
      const evidence = [...new Set([...(previous?.evidence ?? []), ...target.evidence])].sort();
      await tx`
        insert into public.companion_v2_purge_targets (
          resource_kind, resource_key, evidence, state, operation_id, updated_at
        ) values (
          ${target.kind}, ${target.key}, ${tx.json(evidence)}, 'discovered',
          ${target.operationId ?? null}, statement_timestamp()
        )
        on conflict (resource_kind, resource_key) do update set
          evidence = excluded.evidence,
          operation_id = coalesce(companion_v2_purge_targets.operation_id, excluded.operation_id),
          updated_at = excluded.updated_at
      `;
    }
  });
}

function createCompanionWithRuntimePurgeJournal(client: CompanionV2PurgeSql): CompanionV2PurgeJournal {
  return {
    async markRequesting(target) {
      await client`
        update public.companion_v2_purge_targets
        set state = 'requesting', attempt_count = attempt_count + 1,
            requested_at = statement_timestamp(), completed_at = null,
            retry_after = null, last_error = null, updated_at = statement_timestamp()
        where resource_kind = ${target.kind} and resource_key = ${target.key}
          and state not in ('completed', 'absent')
      `;
    },
    async markComplete(target, outcome) {
      await client`
        update public.companion_v2_purge_targets
        set state = ${outcome}, completed_at = statement_timestamp(),
            retry_after = null, last_error = null, updated_at = statement_timestamp()
        where resource_kind = ${target.kind} and resource_key = ${target.key}
      `;
    },
    async markFailure(target, message, disposition = "ambiguous") {
      await client`
        update public.companion_v2_purge_targets
        set state = case when ${disposition} = 'retryable' then 'discovered' else state end,
            retry_after = case
              when ${disposition} = 'retryable' then statement_timestamp() + interval '5 seconds'
              else retry_after
            end,
            last_error = ${message}, updated_at = statement_timestamp()
        where resource_kind = ${target.kind} and resource_key = ${target.key}
      `;
    },
  };
}

function boxJournal(client: CompanionV2PurgeSql): LegacyTargetJournal {
  return {
    async markRequesting() {},
    async markAbsent(boxId) {
      await client`
        update public.companion_v2_purge_targets
        set operation_id = null, retry_after = null, updated_at = statement_timestamp()
        where resource_kind = 'box' and resource_key = ${boxId}
      `;
    },
    async markOperation(boxId, operation) {
      await client`
        update public.companion_v2_purge_targets
        set operation_id = ${operation.id}, retry_after = null, updated_at = statement_timestamp()
        where resource_kind = 'box' and resource_key = ${boxId}
      `;
    },
    async markError() {},
  };
}

export async function removeCompanionV2BoxTarget(input: {
  target: CompanionV2PurgeTarget;
  journal: LegacyTargetJournal;
  boxClient: Pick<CompanionV2BoxPurgeClient,
    "listAllBoxes" | "requestPermanentDeletion" | "getDeletionOperation">;
  afterRequestAccepted?(target: CompanionV2PurgeTarget): Promise<void>;
  afterOperationCheckpoint?(target: CompanionV2PurgeTarget): Promise<void>;
}): Promise<"completed" | "absent"> {
  let operationId = input.target.operationId ?? null;
  if (!operationId) {
    const deletion = await input.boxClient.requestPermanentDeletion({ boxId: input.target.key });
    if (deletion.outcome === "absent") {
      await input.journal.markAbsent(input.target.key);
      return "absent";
    }
    await input.afterRequestAccepted?.(input.target);
    operationId = deletion.operation.id;
    await input.journal.markOperation(input.target.key, deletion.operation, false);
    await input.afterOperationCheckpoint?.(input.target);
    if (deletion.operation.status === "completed") return "completed";
    if (!await companionV2BoxPresent(input.boxClient, input.target.key)) return "absent";
  }

  const deadline = Date.now() + BOX_DELETE_TIMEOUT_MS;
  for (;;) {
    if (Date.now() >= deadline) {
      throw new Error("Box deletion operation did not complete before the purge deadline");
    }
    await new Promise<void>((resolve) => { setTimeout(resolve, BOX_DELETE_POLL_INTERVAL_MS); });
    const operation = await input.boxClient.getDeletionOperation({
      operationId,
      boxId: input.target.key,
    });
    await input.journal.markOperation(input.target.key, operation, true);
    if (operation.status === "completed") return "completed";
  }
}

export async function companionV2BoxPresent(
  boxClient: { listAllBoxes(): Promise<readonly { id: string }[] | null> },
  boxId: string,
): Promise<boolean> {
  const boxes = await boxClient.listAllBoxes();
  if (!Array.isArray(boxes)) {
    throw new Error("Box inventory returned a malformed response");
  }
  return boxes.some((box) => box.id === boxId);
}

async function removeCompanionV2Target(input: {
  target: CompanionV2PurgeTarget;
  client: CompanionV2PurgeSql;
  boxClient: CompanionV2BoxPurgeClient;
  triggerOwners: CompanionV2DatabaseInventory["triggerOwners"];
  webhookBaseUrl: string | null;
  env: NodeJS.ProcessEnv;
  loadMasterKey: typeof loadSecretsMasterKey;
  objectStore: CompanionV2ObjectStore;
  triggerRemover?: CompanionV2TriggerRemover;
  afterBoxRequestAccepted?(target: CompanionV2PurgeTarget): Promise<void>;
  afterBoxOperationCheckpoint?(target: CompanionV2PurgeTarget): Promise<void>;
}): Promise<"completed" | "absent"> {
  if (input.target.kind === "object") {
    return input.objectStore.remove(input.target.key);
  }
  if (input.target.kind === "snapshot") {
    return input.boxClient.deleteNamedSnapshot({ name: input.target.key });
  }
  if (input.target.kind === "box") {
    return removeCompanionV2BoxTarget({
      target: input.target,
      journal: boxJournal(input.client),
      boxClient: input.boxClient,
      afterRequestAccepted: input.afterBoxRequestAccepted,
      afterOperationCheckpoint: input.afterBoxOperationCheckpoint,
    });
  }
  const owner = input.triggerOwners.find((item) => item.triggerId === input.target.key);
  if (!owner) return "absent";
  if (input.triggerRemover) return input.triggerRemover.remove(owner);
  if (!input.webhookBaseUrl) {
    throw new Error("COMPANION_WEB_URL is required to reconcile Runtime v2 trigger callbacks");
  }
  const webhookBaseUrl = input.webhookBaseUrl;
  const database = createDatabase(input.client);
  return withTenantContextOn(
    database,
    { orgId: owner.orgId, userId: owner.ownerId },
    async (tenantDatabase) => unregisterCompanionTriggerWebhook({
      orgId: owner.orgId,
      companionId: owner.companionId,
      triggerId: owner.triggerId,
      webhookBaseUrl,
      masterKey: input.loadMasterKey(input.env.COMPANION_SECRETS_MASTER_KEY),
      database: tenantDatabase,
      preserveRegistration: true,
    }),
  );
}

async function inspectCompanionV2Trigger(input: {
  owner: CompanionV2DatabaseInventory["triggerOwners"][number];
  client: CompanionV2PurgeSql;
  env: NodeJS.ProcessEnv;
  webhookBaseUrl: string | null;
  loadMasterKey: typeof loadSecretsMasterKey;
  triggerRemover?: CompanionV2TriggerRemover;
}): Promise<"present" | "absent"> {
  if (input.triggerRemover) return input.triggerRemover.inspect(input.owner);
  if (!input.webhookBaseUrl) {
    throw new Error("COMPANION_WEB_URL is required to reconcile Runtime v2 trigger callbacks");
  }
  const webhookBaseUrl = input.webhookBaseUrl;
  const database = createDatabase(input.client);
  return withTenantContextOn(
    database,
    { orgId: input.owner.orgId, userId: input.owner.ownerId },
    async (tenantDatabase) => inspectCompanionTriggerWebhook({
      orgId: input.owner.orgId,
      companionId: input.owner.companionId,
      triggerId: input.owner.triggerId,
      webhookBaseUrl,
      masterKey: input.loadMasterKey(input.env.COMPANION_SECRETS_MASTER_KEY),
      database: tenantDatabase,
    }),
  );
}

export function printCompanionV2PurgeReport(input: {
  inventory: CompanionV2PurgeInventory;
  mode: CompanionV2PurgeInvocation["mode"] | "purge-complete";
  log?: (message: string) => void;
}): void {
  const log = input.log ?? console.log;
  log(`Runtime v2 purge ${input.mode}: inventory ${input.inventory.hash}`);
  for (const [table, count] of Object.entries(input.inventory.rowCounts).sort()) {
    log(`  database ${table}=${count}`);
  }
  log(
    `  provider boxes=${input.inventory.providerCounts.boxes} `
      + `snapshots=${input.inventory.providerCounts.snapshots} `
      + `objects=${input.inventory.providerCounts.objects}`,
  );
  for (const target of input.inventory.targets) {
    log(`  target ${target.kind}:${target.key} evidence=${target.evidence.join(",")}`);
  }
  log("Preserved data is fingerprinted without plaintext: organizations, users, memberships, Skills, Skill secrets, Skill Databases, billing, audit, encrypted provider connections, and MCP accounts.");
}

function requireCompanionV2TriggerCallbackBase(
  env: NodeJS.ProcessEnv,
  triggerOwners: CompanionV2DatabaseInventory["triggerOwners"],
): string | null {
  if (triggerOwners.length === 0) return null;
  const configured = env.COMPANION_WEB_URL;
  if (!configured || configured !== configured.trim()) {
    throw new Error(
      "COMPANION_WEB_URL must be the exact public HTTP(S) origin before Runtime v2 trigger purge",
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(configured);
  } catch {
    throw new Error(
      "COMPANION_WEB_URL must be the exact public HTTP(S) origin before Runtime v2 trigger purge",
    );
  }
  if (
    !["http:", "https:"].includes(parsed.protocol)
    || parsed.username
    || parsed.password
    || parsed.pathname !== "/"
    || parsed.search
    || parsed.hash
    || (configured !== parsed.origin && configured !== `${parsed.origin}/`)
  ) {
    throw new Error(
      "COMPANION_WEB_URL must be the exact public HTTP(S) origin before Runtime v2 trigger purge",
    );
  }
  return parsed.origin;
}

export async function executeConfirmedCompanionV2Purge(input: {
  client: CompanionV2PurgeSql;
  boxClient: CompanionV2BoxPurgeClient;
  initialInventory: CompanionV2PurgeInventory;
  env?: NodeJS.ProcessEnv;
  objectStore?: CompanionV2ObjectStore;
  triggerRemover?: CompanionV2TriggerRemover;
  loadMasterKey?: typeof loadSecretsMasterKey;
  beforeExternalEffect?(target: CompanionV2PurgeTarget): Promise<void>;
  afterExternalEffect?(target: CompanionV2PurgeTarget): Promise<void>;
  afterBoxOperationCheckpoint?(target: CompanionV2PurgeTarget): Promise<void>;
}): Promise<CompanionV2PurgeResult> {
  const env = input.env ?? process.env;
  assertCompanionV2PurgeDisabled(env);
  await assertCompanionV2PurgeLockHeld(input.client);
  await assertCompanionV2DatabaseQuiescent(input.client);
  const [existingRun] = await input.client<Array<{ phase: string }>>`
    select phase from public.companion_v2_purge_runs where id = ${COMPANION_V2_PURGE_RUN_ID}
  `;
  if (existingRun?.phase === "database_complete") return { already_complete: true };

  // Callback identity is destructive evidence: validate its exact public origin only after the
  // feature flag, migration lock, and lease guards, but before the ledger, master key, provider
  // credentials, or any external effect. Report and dry-run never cross this boundary.
  const webhookBaseUrl = requireCompanionV2TriggerCallbackBase(
    env,
    input.initialInventory.triggerOwners,
  );
  const masterKeyLoader = input.loadMasterKey ?? loadSecretsMasterKey;

  await seedCompanionV2PurgeLedger(input.client, input.initialInventory);
  const targets = await loadCompanionV2PurgeTargets(input.client);
  const journal = createCompanionWithRuntimePurgeJournal(input.client);
  const objectStore = input.objectStore ?? productionObjectStore();
  const providerPresent = async (target: CompanionV2PurgeTarget): Promise<boolean> => {
    if (target.kind === "trigger") {
      const owner = input.initialInventory.triggerOwners.find(
        (item) => item.triggerId === target.key,
      );
      if (!owner) {
        throw new Error(`trigger ${target.key} lacks ownership required for provider reconciliation`);
      }
      const inspection: Parameters<typeof inspectCompanionV2Trigger>[0] = {
        owner,
        client: input.client,
        env,
        webhookBaseUrl,
        loadMasterKey: masterKeyLoader,
      };
      if (input.triggerRemover) inspection.triggerRemover = input.triggerRemover;
      return (await inspectCompanionV2Trigger(inspection)) === "present";
    }
    if (target.kind === "object") {
      return (await objectStore.listKeys()).includes(target.key);
    }
    if (target.kind === "snapshot") {
      return (await input.boxClient.listNamedSnapshots()).some(
        (snapshot) => snapshot.name === target.key,
      );
    }
    // Box documents that an accepted permanent delete disappears from ordinary authenticated
    // reads immediately, before the retained bdop finishes. Presence therefore proves admission
    // did not occur; absence is sufficient to close this purge target without replaying DELETE.
    // https://docs.ascii.dev/box/api/reference/boxes/permanently-delete-box-data.md
    return companionV2BoxPresent(input.boxClient, target.key);
  };
  const processing: Parameters<typeof processCompanionV2PurgeTargets>[0] = {
    targets,
    journal,
    providerPresent,
    remove: (target) => {
      const removal: Parameters<typeof removeCompanionV2Target>[0] = {
        target,
        client: input.client,
        boxClient: input.boxClient,
        triggerOwners: input.initialInventory.triggerOwners,
        webhookBaseUrl,
        env,
        loadMasterKey: masterKeyLoader,
        objectStore,
      };
      if (input.triggerRemover) removal.triggerRemover = input.triggerRemover;
      if (target.kind === "box" && input.afterExternalEffect) {
        removal.afterBoxRequestAccepted = input.afterExternalEffect;
      }
      if (target.kind === "box" && input.afterBoxOperationCheckpoint) {
        removal.afterBoxOperationCheckpoint = input.afterBoxOperationCheckpoint;
      }
      return removeCompanionV2Target(removal);
    },
  };
  if (input.beforeExternalEffect) processing.beforeExternalEffect = input.beforeExternalEffect;
  if (input.afterExternalEffect) processing.afterExternalEffect = input.afterExternalEffect;
  await processCompanionV2PurgeTargets(processing);

  const fresh = await collectCompanionV2PurgeInventory({
    client: input.client,
    boxClient: input.boxClient,
    objectStore,
  });
  await seedCompanionV2PurgeLedger(input.client, fresh);
  const ledger = new Map((await loadCompanionV2PurgeTargets(input.client)).map((target) => [
    `${target.kind}:${target.key}`,
    target,
  ]));
  const unresolved = fresh.targets.filter((target) => {
    const recorded = ledger.get(`${target.kind}:${target.key}`);
    return !recorded || (recorded.state !== "completed" && recorded.state !== "absent");
  });
  if (unresolved.length > 0) {
    throw new Error(`${unresolved.length} Runtime v2 external purge target(s) remain unresolved`);
  }
  for (const target of ledger.values()) {
    if (target.state !== "completed" && target.state !== "absent") continue;
    if (await providerPresent(target)) {
      throw new Error(
        `terminal Runtime v2 purge target remains visible (${target.kind}:${target.key})`,
      );
    }
  }
  const [result] = await input.client<Array<{ result: CompanionV2PurgeResult }>>`
    select public.companion_finalize_v2_purge() as result
  `;
  if (!result?.result) throw new Error("Runtime v2 purge finalizer returned no result");
  return result.result;
}

export async function runCompanionV2PurgeInvocation(input: {
  invocation: CompanionV2PurgeInvocation;
  client: CompanionV2PurgeSql;
  boxClient: CompanionV2BoxPurgeClient;
  env?: NodeJS.ProcessEnv;
  objectStore?: CompanionV2ObjectStore;
  triggerRemover?: CompanionV2TriggerRemover;
  beforeExternalEffect?(target: CompanionV2PurgeTarget): Promise<void>;
  afterExternalEffect?(target: CompanionV2PurgeTarget): Promise<void>;
  afterBoxOperationCheckpoint?(target: CompanionV2PurgeTarget): Promise<void>;
  log?: (message: string) => void;
}): Promise<{ inventory: CompanionV2PurgeInventory; result?: CompanionV2PurgeResult }> {
  const env = input.env ?? process.env;
  if (input.invocation.mode === "purge") assertCompanionV2PurgeDisabled(env);
  const objectStore = input.objectStore ?? productionObjectStore();
  let lockAcquired = false;
  try {
    if (!await acquireCompanionV2PurgeLock(input.client)) {
      throw new Error("another migration or cutover holds the migration lock");
    }
    lockAcquired = true;
    if (input.invocation.mode === "purge") {
      await assertCompanionV2DatabaseQuiescent(input.client);
    }
    const inventory = await collectCompanionV2PurgeInventory({
      client: input.client,
      boxClient: input.boxClient,
      objectStore,
    });
    printCompanionV2PurgeReport({ inventory, mode: input.invocation.mode, log: input.log });
    if (input.invocation.mode !== "purge") {
      (input.log ?? console.log)("No destructive provider request and no database write was made.");
      return { inventory };
    }
    const confirmed: Parameters<typeof executeConfirmedCompanionV2Purge>[0] = {
      client: input.client,
      boxClient: input.boxClient,
      initialInventory: inventory,
      env,
      objectStore,
    };
    if (input.triggerRemover) confirmed.triggerRemover = input.triggerRemover;
    if (input.beforeExternalEffect) confirmed.beforeExternalEffect = input.beforeExternalEffect;
    if (input.afterExternalEffect) confirmed.afterExternalEffect = input.afterExternalEffect;
    if (input.afterBoxOperationCheckpoint) {
      confirmed.afterBoxOperationCheckpoint = input.afterBoxOperationCheckpoint;
    }
    const result = await executeConfirmedCompanionV2Purge(confirmed);
    (input.log ?? console.log)(`Runtime v2 database purge result: ${JSON.stringify(result)}`);
    const finalInventory = await collectCompanionV2PurgeInventory({
      client: input.client,
      boxClient: input.boxClient,
      objectStore,
    });
    const remaining = Object.values(finalInventory.rowCounts).reduce((sum, count) => sum + count, 0);
    if (remaining > 0 || finalInventory.targets.length > 0) {
      throw new Error(
        `Runtime v2 purge final verification failed (targets=${finalInventory.targets.length}, rows=${remaining})`,
      );
    }
    printCompanionV2PurgeReport({
      inventory: finalInventory,
      mode: "purge-complete",
      log: input.log,
    });
    return { inventory: finalInventory, result };
  } finally {
    if (lockAcquired) {
      await input.client`
        select pg_advisory_unlock(
          ${COMPANION_V2_PURGE_LOCK_CLASS_ID}, ${COMPANION_V2_PURGE_LOCK_OBJECT_ID}
        )
      `.catch(() => undefined);
    }
  }
}

function safeCommandFailure(error: Error | null): string {
  if (error) {
    const message = error.message.replace(/[\r\n]+/g, " ").slice(0, 1_000);
    if (/^(usage:|DATABASE_|COMPANION_|Runtime v2|another migration)/.test(message)) {
      return message;
    }
  }
  return "External Runtime v2 purge effect failed; inspect the expurgated ledger and retry";
}

export async function run(
  argv: readonly string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const invocation = parseCompanionV2PurgeArgs(argv);
  if (invocation.mode === "purge") assertCompanionV2PurgeDisabled(env);
  const client = postgres(companionV2PurgeDatabaseUrl(env), { max: 1 });
  const boxClient = new AsciiBoxMaintenanceClient(env);
  const objectStore = productionObjectStore();
  try {
    await runCompanionV2PurgeInvocation({ invocation, client, boxClient, env, objectStore });
  } finally {
    await client.end();
  }
}

const entrypoint = process.argv[1];
if (entrypoint && pathToFileURL(entrypoint).href === import.meta.url) {
  run().catch((cause) => {
    const error = cause instanceof Error ? cause : null;
    console.error("Runtime v2 purge failed");
    console.error(safeCommandFailure(error));
    process.exitCode = 1;
  });
}
