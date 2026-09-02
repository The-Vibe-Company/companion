import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { ListObjectsV2Command, type ListObjectsV2CommandInput } from "@aws-sdk/client-s3";
import {
  AsciiBoxMaintenanceClient,
  isCompanionRuntimeImageName,
  type BoxRuntimeLifecycleClient,
} from "@companion/box-runtime";
import {
  inspectCompanionTriggerWebhookV2,
  unregisterCompanionTriggerWebhookV2,
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
  processLegacyPurgeTarget,
  type LegacyTargetJournal,
} from "./companionPurge";

export const COMPANION_V2_PURGE_RUN_ID = "runtime-v2-purge";
export const COMPANION_V2_PURGE_LOCK_CLASS_ID = 72_401;
export const COMPANION_V2_PURGE_LOCK_OBJECT_ID = 20_260_608;
const V2_BOX_NAME = /^Companion ([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}) g[1-9][0-9]*$/;

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
}

export interface CompanionV2PurgeJournal {
  markRequesting(target: CompanionV2PurgeTarget): Promise<void>;
  markComplete(
    target: CompanionV2PurgeTarget,
    outcome: "completed" | "absent",
  ): Promise<void>;
  markFailure(target: CompanionV2PurgeTarget, message: string): Promise<void>;
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
    const operationId = target.operationId ?? current?.operationId;
    if (operationId) next.operationId = operationId;
    merged.set(identity, next);
  }
  return [...merged.values()].sort((left, right) =>
    left.kind.localeCompare(right.kind) || left.key.localeCompare(right.key));
}

export async function processCompanionV2PurgeTargets(input: {
  targets: readonly CompanionV2PurgeTarget[];
  journal: CompanionV2PurgeJournal;
  providerPresent?(target: CompanionV2PurgeTarget): boolean | undefined | Promise<boolean | undefined>;
  afterExternalEffect?(target: CompanionV2PurgeTarget): Promise<void>;
  remove(target: CompanionV2PurgeTarget): Promise<"completed" | "absent">;
}): Promise<void> {
  for (const target of input.targets) {
    if (target.state === "completed" || target.state === "absent") continue;
    const present = await input.providerPresent?.(target);
    if (present === false) {
      await input.journal.markComplete(target, "absent");
      continue;
    }
    if (
      target.kind === "box"
      && target.state === "requesting"
      && !target.operationId
      && present === true
    ) {
      throw new Error(
        "Ambiguous Box deletion is still provider-visible; retry after provider reconciliation",
      );
    }
    await input.journal.markRequesting(target);
    try {
      const outcome = await input.remove(target);
      await input.afterExternalEffect?.(target);
      await input.journal.markComplete(target, outcome);
    } catch (error) {
      await input.journal.markFailure(
        target,
        "external removal failed; retry the purge",
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
  const boxRows = await client<Array<{ key: string; evidence: string }>>`
    select box_id as key, 'database:runtime-instance'::text as evidence
    from public.companion_runtime_instances where box_id is not null
    union all
    select box_id, 'database:duplicate-cleanup'
    from public.companion_runtime_duplicate_cleanups where box_id is not null
    union all
    select build_box_id, 'database:image-build-box'
    from public.companion_images where build_box_id is not null
  `;
  targets.push(...boxRows.map((row) => ({ kind: "box" as const, key: row.key, evidence: [row.evidence] })));

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
           trigger.companion_id::text as "companionId", companion.owner_id as "ownerId"
    from public.companion_triggers trigger
    join public.companions companion
      on companion.org_id = trigger.org_id and companion.id = trigger.companion_id
    where trigger.remote_hook_id is not null
    order by trigger.id
  `;
  targets.push(...triggerOwners.map((row) => ({
    kind: "trigger" as const,
    key: row.triggerId,
    evidence: ["database:remote-trigger-registration"],
  })));
  return { rowCounts, targets: mergeCompanionV2PurgeTargets(targets), triggerOwners };
}

function productionObjectStore(): CompanionV2ObjectStore {
  const config = getStorageConfig();
  const client = createStorageClient(config);
  return {
    async listKeys() {
      const keys: string[] = [];
      let continuationToken: string | undefined;
      do {
        const request: ListObjectsV2CommandInput = {
          Bucket: config.bucket,
          Prefix: "companion-attachments/",
        };
        if (continuationToken) request.ContinuationToken = continuationToken;
        const response = await client.send(new ListObjectsV2Command(request));
        for (const item of response.Contents ?? []) {
          if (item.Key) keys.push(item.Key);
        }
        continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;
      } while (continuationToken);
      return keys.sort();
    },
    async remove(key) {
      await deleteStorageObject({ key, client, config });
      return "completed";
    },
  };
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
  for (const box of boxes) {
    if (box.name && V2_BOX_NAME.test(box.name)) {
      providerTargets.push({
        kind: "box",
        key: box.id,
        evidence: ["provider-name:companion-generation"],
      });
    }
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
    targets: targets.map(({ kind, key, evidence }) => ({ kind, key, evidence })),
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
  }>>`
    select resource_kind as kind, resource_key as key, evidence, state,
           operation_id as "operationId"
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
    targets: inventory.targets.map(({ kind, key, evidence }) => ({ kind, key, evidence })),
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
      const evidence = [...new Set([...(previous?.evidence ?? []), ...target.evidence])].sort();
      await tx`
        insert into public.companion_v2_purge_targets (
          resource_kind, resource_key, evidence, state, updated_at
        ) values (
          ${target.kind}, ${target.key}, ${tx.json(evidence)}, 'discovered', statement_timestamp()
        )
        on conflict (resource_kind, resource_key) do update set
          evidence = excluded.evidence, updated_at = excluded.updated_at
      `;
    }
  });
}

function createCompanionV2PurgeJournal(client: CompanionV2PurgeSql): CompanionV2PurgeJournal {
  return {
    async markRequesting(target) {
      await client`
        update public.companion_v2_purge_targets
        set state = 'requesting', attempt_count = attempt_count + 1,
            requested_at = statement_timestamp(), completed_at = null,
            last_error = null, updated_at = statement_timestamp()
        where resource_kind = ${target.kind} and resource_key = ${target.key}
          and state not in ('completed', 'absent')
      `;
    },
    async markComplete(target, outcome) {
      await client`
        update public.companion_v2_purge_targets
        set state = ${outcome}, completed_at = statement_timestamp(),
            last_error = null, updated_at = statement_timestamp()
        where resource_kind = ${target.kind} and resource_key = ${target.key}
      `;
    },
    async markFailure(target, message) {
      await client`
        update public.companion_v2_purge_targets
        set last_error = ${message}, updated_at = statement_timestamp()
        where resource_kind = ${target.kind} and resource_key = ${target.key}
      `;
    },
  };
}

function boxJournal(
  client: CompanionV2PurgeSql,
  onTerminal: (outcome: "completed" | "absent") => void,
): LegacyTargetJournal {
  return {
    async markRequesting() {},
    async markAbsent(boxId) {
      onTerminal("absent");
      await client`
        update public.companion_v2_purge_targets
        set operation_id = null, updated_at = statement_timestamp()
        where resource_kind = 'box' and resource_key = ${boxId}
      `;
    },
    async markOperation(boxId, operation) {
      if (operation.status === "completed") onTerminal("completed");
      await client`
        update public.companion_v2_purge_targets
        set operation_id = ${operation.id}, updated_at = statement_timestamp()
        where resource_kind = 'box' and resource_key = ${boxId}
      `;
    },
    async markError() {},
  };
}

async function removeCompanionV2Target(input: {
  target: CompanionV2PurgeTarget;
  client: CompanionV2PurgeSql;
  boxClient: CompanionV2BoxPurgeClient;
  triggerOwners: CompanionV2DatabaseInventory["triggerOwners"];
  env: NodeJS.ProcessEnv;
  objectStore: CompanionV2ObjectStore;
  triggerRemover?: CompanionV2TriggerRemover;
}): Promise<"completed" | "absent"> {
  if (input.target.kind === "object") {
    return input.objectStore.remove(input.target.key);
  }
  if (input.target.kind === "snapshot") {
    await input.boxClient.deleteNamedSnapshot({ name: input.target.key });
    return "completed";
  }
  if (input.target.kind === "box") {
    let outcome: "completed" | "absent" = "completed";
    await processLegacyPurgeTarget({
      target: {
        boxId: input.target.key,
        observedName: null,
        evidence: input.target.evidence,
        state: input.target.state ?? "discovered",
        operationId: input.target.operationId ?? null,
        attemptCount: 0,
        lastError: null,
      },
      boxClient: input.boxClient,
      journal: boxJournal(input.client, (terminal) => { outcome = terminal; }),
    });
    return outcome;
  }
  const owner = input.triggerOwners.find((item) => item.triggerId === input.target.key);
  if (!owner) return "absent";
  if (input.triggerRemover) return input.triggerRemover.remove(owner);
  const database = createDatabase(input.client);
  return withTenantContextOn(
    database,
    { orgId: owner.orgId, userId: owner.ownerId },
    async (tenantDatabase) => unregisterCompanionTriggerWebhookV2({
      orgId: owner.orgId,
      companionId: owner.companionId,
      triggerId: owner.triggerId,
      webhookBaseUrl: input.env.COMPANION_WEB_URL ?? "http://127.0.0.1:3000",
      masterKey: loadSecretsMasterKey(input.env.COMPANION_SECRETS_MASTER_KEY),
      database: tenantDatabase,
      preserveRegistration: true,
    }),
  );
}

async function inspectCompanionV2Trigger(input: {
  owner: CompanionV2DatabaseInventory["triggerOwners"][number];
  client: CompanionV2PurgeSql;
  env: NodeJS.ProcessEnv;
  triggerRemover?: CompanionV2TriggerRemover;
}): Promise<"present" | "absent"> {
  if (input.triggerRemover) return input.triggerRemover.inspect(input.owner);
  const database = createDatabase(input.client);
  return withTenantContextOn(
    database,
    { orgId: input.owner.orgId, userId: input.owner.ownerId },
    async (tenantDatabase) => inspectCompanionTriggerWebhookV2({
      orgId: input.owner.orgId,
      companionId: input.owner.companionId,
      triggerId: input.owner.triggerId,
      webhookBaseUrl: input.env.COMPANION_WEB_URL ?? "http://127.0.0.1:3000",
      masterKey: loadSecretsMasterKey(input.env.COMPANION_SECRETS_MASTER_KEY),
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

export async function executeConfirmedCompanionV2Purge(input: {
  client: CompanionV2PurgeSql;
  boxClient: CompanionV2BoxPurgeClient;
  initialInventory: CompanionV2PurgeInventory;
  env?: NodeJS.ProcessEnv;
  objectStore?: CompanionV2ObjectStore;
  triggerRemover?: CompanionV2TriggerRemover;
  afterExternalEffect?(target: CompanionV2PurgeTarget): Promise<void>;
}): Promise<CompanionV2PurgeResult> {
  const env = input.env ?? process.env;
  assertCompanionV2PurgeDisabled(env);
  await assertCompanionV2PurgeLockHeld(input.client);
  await assertCompanionV2DatabaseQuiescent(input.client);
  const [existingRun] = await input.client<Array<{ phase: string }>>`
    select phase from public.companion_v2_purge_runs where id = ${COMPANION_V2_PURGE_RUN_ID}
  `;
  if (existingRun?.phase === "database_complete") return { already_complete: true };

  await seedCompanionV2PurgeLedger(input.client, input.initialInventory);
  const targets = await loadCompanionV2PurgeTargets(input.client);
  const journal = createCompanionV2PurgeJournal(input.client);
  const objectStore = input.objectStore ?? productionObjectStore();
  const processing: Parameters<typeof processCompanionV2PurgeTargets>[0] = {
    targets,
    journal,
    providerPresent: async (target) => {
      if (target.kind === "trigger") {
        if (target.state !== "requesting") return true;
        const owner = input.initialInventory.triggerOwners.find(
          (item) => item.triggerId === target.key,
        );
        if (!owner) return false;
        const inspection: Parameters<typeof inspectCompanionV2Trigger>[0] = {
          owner,
          client: input.client,
          env,
        };
        if (input.triggerRemover) inspection.triggerRemover = input.triggerRemover;
        return (await inspectCompanionV2Trigger(inspection)) === "present";
      }
      const providerEvidence = target.kind === "object"
        ? "storage-prefix:companion-attachments"
        : target.kind === "snapshot"
          ? "provider-name:v2-image"
          : "provider-name:companion-generation";
      const discovered = input.initialInventory.targets.find(
        (item) => item.kind === target.kind && item.key === target.key,
      );
      return discovered?.evidence.includes(providerEvidence) ?? false;
    },
    remove: (target) => {
      const removal: Parameters<typeof removeCompanionV2Target>[0] = {
        target,
        client: input.client,
        boxClient: input.boxClient,
        triggerOwners: input.initialInventory.triggerOwners,
        env,
        objectStore,
      };
      if (input.triggerRemover) removal.triggerRemover = input.triggerRemover;
      return removeCompanionV2Target(removal);
    },
  };
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
  afterExternalEffect?(target: CompanionV2PurgeTarget): Promise<void>;
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
    if (input.afterExternalEffect) confirmed.afterExternalEffect = input.afterExternalEffect;
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
