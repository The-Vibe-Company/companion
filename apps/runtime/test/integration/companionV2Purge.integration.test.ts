/**
 * Product promise: the Runtime v2 purge removes every external resource before ownership rows,
 * resumes after a partial failure without repeating completed effects, and leaves reusable Skills
 * Hub, tenant, billing/audit, provider-connection, and MCP data byte-for-byte unchanged.
 *
 * Why integrated: the advisory guards, FORCE RLS maintenance ledger, cascade graph, preservation
 * fingerprint, and final atomic delete exist only in the real PostgreSQL migration history. The
 * object, webhook, snapshot, and Box seams are deterministic fakes because this suite must never
 * contact or purge production providers.
 */
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type {
  BoxDeletionOperation,
  BoxMaintenanceBox,
  BoxPermanentDeletionResult,
} from "@companion/box-runtime";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  acquireCompanionV2PurgeLock,
  assertCompanionV2PurgeLockHeld,
  collectCompanionV2PurgeInventory,
  executeConfirmedCompanionV2Purge,
  runCompanionV2PurgeInvocation,
  type CompanionV2BoxPurgeClient,
  type CompanionV2ObjectStore,
  type CompanionV2TriggerRemover,
} from "../../src/companionV2Purge";

const adminUrl = process.env.DATABASE_MIGRATION_URL ?? process.env.DATABASE_URL;
const apiUrl = process.env.DATABASE_API_URL;
const workerUrl = process.env.DATABASE_WORKER_URL;
const runtimeUrl = process.env.DATABASE_COMPANION_RUNTIME_URL;
if (!adminUrl?.trim() || !apiUrl?.trim() || !workerUrl?.trim() || !runtimeUrl?.trim()) {
  throw new Error("Runtime v2 purge integration requires migration, API, worker, and runtime URLs");
}

const migrationsDir = fileURLToPath(new URL("../../../../packages/db/drizzle/", import.meta.url));
const runtimeGrantsFile = fileURLToPath(
  new URL("../../../../packages/db/runtime-role-grants.sql", import.meta.url),
);
const databaseName = `v2_purge_${randomUUID().replaceAll("-", "")}`;
const adminSql = postgres(adminUrl, { max: 1 });
const upgradeUrl = new URL(adminUrl);
upgradeUrl.pathname = `/${databaseName}`;
upgradeUrl.search = "";
const apiRole = decodeURIComponent(new URL(apiUrl).username);
const workerRole = decodeURIComponent(new URL(workerUrl).username);
const runtimeRole = decodeURIComponent(new URL(runtimeUrl).username);
let databaseCreated = false;
let database: ReturnType<typeof postgres> | undefined;

function databaseRoleUrl(source: string, name: string): string {
  const url = new URL(source);
  url.pathname = `/${name}`;
  url.search = "";
  return url.toString();
}

async function applyMigrationFile(client: ReturnType<typeof postgres>, name: string): Promise<void> {
  const statements = (await readFile(`${migrationsDir}/${name}`, "utf8"))
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter(Boolean);
  await client.begin(async (tx) => {
    for (const statement of statements) await tx.unsafe(statement);
  });
}

async function applyRuntimeGrants(client: ReturnType<typeof postgres>): Promise<void> {
  const source = await readFile(runtimeGrantsFile, "utf8");
  const beginMarker = "-- companion-runtime-grants-begin";
  const endMarker = "-- companion-runtime-grants-end";
  const begin = source.indexOf(beginMarker);
  const end = source.indexOf(endMarker);
  if (begin < 0 || end <= begin) throw new Error("runtime role grant block is missing");
  await client`select set_config('companion.api_role', ${apiRole}, false)`;
  await client`select set_config('companion.worker_role', ${workerRole}, false)`;
  await client`select set_config('companion.companion_runtime_role', ${runtimeRole}, false)`;
  await client`select set_config('companion.retired_runtime_role', '', false)`;
  await client.unsafe(source.slice(begin + beginMarker.length, end).trim());
}

class DisposableBoxProvider implements CompanionV2BoxPurgeClient {
  readonly boxes = new Map<string, BoxMaintenanceBox>([
    ["bx_23456789", {
      id: "bx_23456789",
      name: "Companion 22222222-2222-4222-8222-222222222222 g1",
    }],
    ["bx_3456789a", {
      id: "bx_3456789a",
      name: "Companion 22222222-2222-4222-8222-222222222222 g2",
    }],
    ["bx_456789ab", { id: "bx_456789ab" }],
    ["bx_56789abc", {
      id: "bx_56789abc",
      name: "Companion aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa g1",
    }],
    ["bx_6789abcd", {
      id: "bx_6789abcd",
      name: "Companion bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb g1",
    }],
  ]);
  readonly snapshots = new Set([
    "legacy-companion-snapshot",
    "companion-l14-0123456789ab",
    "provider-only-unrelated-snapshot",
  ]);
  deletionRequests = 0;
  snapshotDeletes = 0;

  async listAllBoxes(): Promise<BoxMaintenanceBox[]> {
    return [...this.boxes.values()];
  }

  async listNamedSnapshots() {
    return [...this.snapshots].map((name) => ({
      name,
      status: "ready" as const,
      sourceBoxId: "bx_23456789",
      createdAt: new Date(0).toISOString(),
    }));
  }

  async deleteNamedSnapshot(input: { name: string }): Promise<"completed"> {
    if (!this.snapshots.delete(input.name)) {
      throw new Error(`unexpected duplicate snapshot DELETE for ${input.name}`);
    }
    this.snapshotDeletes += 1;
    return "completed";
  }

  async requestPermanentDeletion(input: { boxId: string }): Promise<BoxPermanentDeletionResult> {
    this.deletionRequests += 1;
    if (
      !["bx_56789abc", "bx_6789abcd"].includes(input.boxId)
      || !this.boxes.delete(input.boxId)
    ) {
      throw new Error(`unexpected duplicate Box DELETE for ${input.boxId}`);
    }
    return {
      outcome: "accepted",
      operation: {
        id: input.boxId === "bx_56789abc"
          ? "bdop_44444444444444444444444444444444"
          : "bdop_55555555555555555555555555555555",
        targetId: input.boxId,
        status: "pending",
        attemptCount: 0,
        requestedAt: new Date(0).toISOString(),
        completedAt: null,
      },
    };
  }

  async getDeletionOperation(input: {
    operationId: string;
    boxId: string;
  }): Promise<BoxDeletionOperation> {
    this.boxes.delete(input.boxId);
    return {
      id: input.operationId,
      targetId: input.boxId,
      status: "completed",
      attemptCount: 1,
      requestedAt: new Date(0).toISOString(),
      completedAt: new Date(1).toISOString(),
    };
  }
}

class DisposableObjectStore implements CompanionV2ObjectStore {
  readonly keys = new Set(["companion-attachments/orphan/output.png"]);
  removals = 0;
  async listKeys(): Promise<string[]> { return [...this.keys]; }
  async remove(key: string): Promise<"completed"> {
    this.removals += 1;
    this.keys.delete(key);
    return "completed";
  }
}

describe("one-shot Runtime v2 purge on disposable PostgreSQL and provider fixtures", () => {
  beforeAll(async () => {
    await adminSql.unsafe(`create database "${databaseName}"`);
    databaseCreated = true;
    const migrationSql = postgres(upgradeUrl.toString(), { max: 1 });
    try {
      const migrations = (await readdir(migrationsDir))
        .filter((name) => /^\d{4}_.+\.sql$/.test(name))
        .sort();
      const cutover = migrations.findIndex((name) => name.startsWith("0094_"));
      if (cutover < 0) throw new Error("Runtime v2 cutover migration is missing");
      for (const name of migrations.slice(0, cutover)) await applyMigrationFile(migrationSql, name);
      await applyRuntimeGrants(migrationSql);
      for (const name of migrations.slice(cutover)) await applyMigrationFile(migrationSql, name);
      await applyRuntimeGrants(migrationSql);
    } finally {
      await migrationSql.end({ timeout: 1 });
    }
    database = postgres(upgradeUrl.toString(), { max: 1 });
  }, 120_000);

  afterAll(async () => {
    await database?.end({ timeout: 1 });
    if (databaseCreated) await adminSql.unsafe(`drop database if exists "${databaseName}" with (force)`);
    await adminSql.end({ timeout: 1 });
  }, 30_000);

  it("keeps ownership on failure, resumes once, and preserves reusable data exactly", async () => {
    if (!database) throw new Error("disposable purge database was not initialized");
    const orgId = "11111111-1111-4111-8111-111111111111";
    const companionId = "22222222-2222-4222-8222-222222222222";
    const triggerId = "33333333-3333-4333-8333-333333333333";
    const ambiguousTriggerId = "34343434-3434-4434-8434-343434343434";
    const skillId = "44444444-4444-4444-8444-444444444444";
    const secretId = "55555555-5555-4555-8555-555555555555";
    const mcpAccountId = "66666666-6666-4666-8666-666666666666";
    const triggerAccountId = "77777777-7777-4777-8777-777777777777";
    const pluginKeyId = "88888888-8888-4888-8888-888888888888";
    const realmId = "99999999-9999-4999-8999-999999999999";
    await database.unsafe(`
      insert into public."user"(id,name,email,email_verified)
      values ('purge-owner','Owner','purge-owner@example.test',true);
      insert into public.organizations(id,name,slug)
      values ('${orgId}','Purge fixture','purge-fixture');
      insert into public.memberships(org_id,user_id,org_role)
      values ('${orgId}','purge-owner','owner');
      insert into public.companion_provider_connections(
        org_id,provider_id,auth_method,ciphertext,iv,auth_tag,wrapped_dek,wrap_iv,wrap_auth_tag,key_id,connected_by
      ) values ('${orgId}','anthropic','api_key','ciphertext','iv','tag','dek','wiv','wtag','key','purge-owner');
      insert into public.companion_mcp_accounts(
        id,org_id,owner_id,provider,label,transport,account_config,
        ciphertext,iv,auth_tag,wrapped_dek,wrap_iv,wrap_auth_tag,key_id
      ) values (
        '${mcpAccountId}','${orgId}','purge-owner','linear','Linear','http','{}',
        'mcp-ciphertext','mcp-iv','mcp-tag','mcp-dek','mcp-wiv','mcp-wtag','mcp-key'
      );
      insert into public.companion_trigger_provider_accounts(
        id,org_id,owner_id,provider,label,credential_source,credential_generation,
        ciphertext,iv,auth_tag,wrapped_dek,wrap_iv,wrap_auth_tag,key_id
      ) values (
        '${triggerAccountId}','${orgId}','purge-owner','github','GitHub','api_key',
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','trigger-ciphertext','trigger-iv',
        'trigger-tag','trigger-dek','trigger-wiv','trigger-wtag','trigger-key'
      );
      insert into public.companion_plugin_trigger_keys(
        id,org_id,account_id,provider,ciphertext,iv,auth_tag,wrapped_dek,wrap_iv,wrap_auth_tag,key_id
      ) values (
        '${pluginKeyId}','${orgId}','${mcpAccountId}','linear','plugin-ciphertext','plugin-iv',
        'plugin-tag','plugin-dek','plugin-wiv','plugin-wtag','plugin-key'
      );
      insert into public.skills(id,org_id,slug,description,creator_id,scope)
      values ('${skillId}','${orgId}','preserved-skill','Preserved Skill','purge-owner','personal');
      insert into public.secrets(id,org_id,owner_id,name,key,audience)
      values ('${secretId}','${orgId}','purge-owner','Preserved secret','PRESERVED_SECRET','personal');
      insert into public.secret_versions(
        org_id,secret_id,version,ciphertext,iv,auth_tag,wrapped_dek,wrap_iv,wrap_auth_tag,key_id,created_by
      ) values (
        '${orgId}','${secretId}',1,'secret-ciphertext','secret-iv','secret-tag','secret-dek',
        'secret-wiv','secret-wtag','secret-key','purge-owner'
      );
      insert into public.skill_database_schemas(org_id,skill_id,generation,declarations_checksum)
      values ('${orgId}','${skillId}',1,'sha256:${"b".repeat(64)}');
      insert into public.skill_database_tables(org_id,skill_id,table_name,audience,columns)
      values ('${orgId}','${skillId}','items','organization','[]');
      insert into public.skill_database_realms(
        id,org_id,skill_id,audience,storage_key,size_bytes,schema_generation
      ) values ('${realmId}','${orgId}','${skillId}','organization','skilldb/preserved.sqlite',128,1);
      insert into public.billing_subscriptions(org_id,stripe_customer_id,stripe_status,synced_quantity)
      values ('${orgId}','cus_preserved','active',1);
      insert into public.audit_log(org_id,actor_id,action,target_type,target_id,metadata)
      values ('${orgId}','purge-owner','fixture.created','test','preserved','{"safe":true}');
      insert into public.companions(id,org_id,owner_id,name)
      values ('${companionId}','${orgId}','purge-owner','Disposable Companion');
      insert into public.companion_runtime_instances(org_id,companion_id,box_id)
      values ('${orgId}','${companionId}','bx_23456789');
      insert into public.companion_operations(
        id,org_id,companion_id,kind,trigger,status,actor_id,queue_sequence,turn_queue_cutoff,
        runtime_generation,claim_epoch,checkpoint,checkpoint_sequence,attempt_count,
        provider_operation_id,started_at
      ) values (
        'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa','${orgId}','${companionId}',
        'delete','user','running','purge-owner',1,0,1,1,'provider_delete_requested',1,1,
        'bdop_11111111111111111111111111111111',statement_timestamp()
      );
      insert into public.companion_runtime_duplicate_cleanups(
        org_id,companion_id,operation_id,box_id,status,provider_operation_id,
        checkpoint_sequence,delete_requested_at
      ) values (
        '${orgId}','${companionId}','aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa',
        'bx_3456789a','delete_requested','bdop_22222222222222222222222222222222',1,
        statement_timestamp()
      );
      insert into public.companion_images(
        digest,image_name,build_box_id,build_delete_intent_at,build_delete_operation_id
      ) values (
        repeat('a',64),'companion-l14-0123456789ab','bx_456789ab',statement_timestamp(),
        'bdop_33333333333333333333333333333333'
      );
      insert into public.companion_images(digest,image_name)
      values (repeat('b',64),'legacy-companion-snapshot');
      insert into public.companion_triggers(
        id,org_id,companion_id,name,prompt,provider,secret,target,
        registration_status,remote_hook_id,created_by
      ) values (
        '${triggerId}','${orgId}','${companionId}','GitHub','relay','github',repeat('a',32),
        '{"repo":"owner/repo"}','registered','hook-fixture','purge-owner'
      );
      insert into public.companion_triggers(
        id,org_id,companion_id,name,prompt,provider,secret,target,
        registration_status,remote_hook_account_id,created_by
      ) values (
        '${ambiguousTriggerId}','${orgId}','${companionId}','Ambiguous GitHub','relay','github',repeat('b',32),
        '{"repo":"owner/repo"}','failed','${triggerAccountId}','purge-owner'
      );
      insert into public.companion_delegations(
        id,org_id,source_companion_id,source_companion_name,target_companion_id,
        target_companion_name,actor_id,source_turn_id,source_attempt_id,target_turn_id,
        root_turn_id,depth,response_mode,status,delivery_status,request_key,request_digest
      ) values (
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','${orgId}','${companionId}',
        'Disposable Companion',null,'Former target','purge-owner',
        'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',1,'relay','queued','pending',
        'purge-fixture',repeat('c',64)
      );
      insert into public.companion_runtime_desktop_requests(request_id,expires_at)
      values ('desktop-purge-fixture',statement_timestamp() + interval '5 minutes');
    `);

    await expect(database.begin(async (tx) => {
      await tx`
        insert into public.companion_v2_purge_runs(
          id,phase,inventory_hash,inventory,preservation_fingerprint
        ) values (
          'runtime-v2-purge','deleting_external',${"a".repeat(64)},'{}'::jsonb,
          public.companion_v2_purge_preservation_fingerprint()
        )
      `;
      await tx`
        insert into public.companion_v2_purge_targets(
          resource_kind,resource_key,evidence,state,completed_at
        )
        select owned.kind, owned.key, '[]'::jsonb, 'absent', statement_timestamp()
        from (
          select 'box'::text as kind, box_id as key
          from public.companion_runtime_instances where box_id is not null
          union
          select 'box', box_id
          from public.companion_runtime_duplicate_cleanups where box_id is not null
          union
          select 'box', build_box_id from public.companion_images where build_box_id is not null
          union
          select 'snapshot', image_name from public.companion_images
          union
          select 'trigger', id::text from public.companion_triggers
          where remote_hook_id is not null
             or (provider in ('linear','github','sentry') and remote_hook_account_id is not null)
          union
          select 'object', storage_key from public.companion_message_attachments
          union
          select 'object', storage_key from public.skill_database_object_deletions
          where storage_key like 'companion-attachments/%'
        ) owned
        where owned.key <> ${ambiguousTriggerId}
      `;
      await tx`select public.companion_finalize_v2_purge()`;
    })).rejects.toThrow("Runtime v2 ownership lacks confirmed external deletion");

    await expect(database.begin(async (tx) => {
      await tx`
        insert into public.companion_v2_purge_runs(
          id,phase,inventory_hash,inventory,preservation_fingerprint
        ) values (
          'runtime-v2-purge','deleting_external',${"b".repeat(64)},'{}'::jsonb,
          public.companion_v2_purge_preservation_fingerprint()
        )
      `;
      await tx`
        insert into public.companion_v2_purge_targets(
          resource_kind,resource_key,evidence,state,completed_at
        )
        select owned.kind, owned.key, '[]'::jsonb, 'absent', statement_timestamp()
        from (
          select 'box'::text as kind, box_id as key
          from public.companion_runtime_instances where box_id is not null
          union
          select 'box', box_id
          from public.companion_runtime_duplicate_cleanups where box_id is not null
          union
          select 'box', build_box_id from public.companion_images where build_box_id is not null
          union
          select 'snapshot', image_name from public.companion_images
          union
          select 'trigger', id::text from public.companion_triggers
          where remote_hook_id is not null
             or (provider in ('linear','github','sentry') and remote_hook_account_id is not null)
          union
          select 'object', storage_key from public.companion_message_attachments
          union
          select 'object', storage_key from public.skill_database_object_deletions
          where storage_key like 'companion-attachments/%'
        ) owned
      `;
      const [accepted] = await tx<Array<{ result: { remaining_companion_rows: number } }>>`
        select public.companion_finalize_v2_purge() as result
      `;
      expect(accepted?.result.remaining_companion_rows).toBe(0);
      throw new Error("rollback accepted finalizer fixture");
    })).rejects.toThrow("rollback accepted finalizer fixture");

    const boxes = new DisposableBoxProvider();
    const objects = new DisposableObjectStore();
    let triggerAttempts = 0;
    const presentTriggers = new Set([triggerId]);
    const triggerInspections: string[] = [];
    const triggers: CompanionV2TriggerRemover = {
      async inspect(owner) {
        triggerInspections.push(owner.triggerId);
        return presentTriggers.has(owner.triggerId) ? "present" : "absent";
      },
      async remove(owner) {
        triggerAttempts += 1;
        presentTriggers.delete(owner.triggerId);
        return "completed";
      },
    };
    const boxClient = boxes;
    const firstInventory = await collectCompanionV2PurgeInventory({
      client: database, boxClient, objectStore: objects,
    });
    for (const invocation of [{ mode: "report" }, { mode: "dry-run" }] as const) {
      await expect(runCompanionV2PurgeInvocation({
        invocation,
        client: database,
        boxClient,
        objectStore: objects,
        env: {},
        log: () => undefined,
      })).resolves.toMatchObject({ inventory: { hash: firstInventory.hash } });
    }
    await expect(assertCompanionV2PurgeLockHeld(database))
      .rejects.toThrow("advisory lock must be held");
    expect(await acquireCompanionV2PurgeLock(database)).toBe(true);
    const contender = postgres(upgradeUrl.toString(), { max: 1 });
    try {
      const [lock] = await contender<Array<{ locked: boolean }>>`
        select pg_try_advisory_lock(72401, 20260608) as locked
      `;
      expect(lock?.locked).toBe(false);
    } finally {
      await contender.end({ timeout: 1 });
    }
    expect(firstInventory.targets.map((target) => target.kind)).toEqual([
      "box", "box", "box", "box", "box", "object", "snapshot", "snapshot", "trigger", "trigger",
    ]);
    expect(firstInventory.targets).toContainEqual(expect.objectContaining({
      kind: "trigger",
      key: ambiguousTriggerId,
      evidence: expect.arrayContaining(["database:ambiguous-trigger-registration"]),
    }));
    expect(firstInventory.triggerOwners).toContainEqual(expect.objectContaining({
      triggerId: ambiguousTriggerId,
      provider: "github",
      providerAccountId: triggerAccountId,
      remoteHookId: null,
      target: { repo: "owner/repo" },
      callbackPath: `/v1/hooks/triggers/${ambiguousTriggerId}/${"b".repeat(32)}`,
    }));
    expect(firstInventory.targets.filter((target) => target.kind === "box")).toEqual([
      expect.objectContaining({
        key: "bx_23456789",
        operationId: "bdop_11111111111111111111111111111111",
        evidence: expect.arrayContaining(["database:delete-operation", "provider-id:box"]),
      }),
      expect.objectContaining({
        key: "bx_3456789a",
        operationId: "bdop_22222222222222222222222222222222",
        evidence: expect.arrayContaining(["database:duplicate-cleanup", "provider-id:box"]),
      }),
      expect.objectContaining({
        key: "bx_456789ab",
        operationId: "bdop_33333333333333333333333333333333",
        evidence: expect.arrayContaining(["database:image-build-box", "provider-id:box"]),
      }),
      expect.objectContaining({
        key: "bx_56789abc",
        evidence: ["provider-name:companion-generation"],
      }),
      expect.objectContaining({
        key: "bx_6789abcd",
        evidence: ["provider-name:companion-generation"],
      }),
    ]);
    const [ledgerBeforePurge] = await database<Array<{ runs: string; targets: string }>>`
      select
        (select count(*)::text from public.companion_v2_purge_runs) as runs,
        (select count(*)::text from public.companion_v2_purge_targets) as targets
    `;
    expect(ledgerBeforePurge).toEqual({ runs: "0", targets: "0" });
    expect({
      boxDeletes: boxes.deletionRequests,
      snapshotDeletes: boxes.snapshotDeletes,
      objectDeletes: objects.removals,
      triggerAttempts,
    }).toEqual({ boxDeletes: 0, snapshotDeletes: 0, objectDeletes: 0, triggerAttempts: 0 });

    await expect(executeConfirmedCompanionV2Purge({
      client: database,
      boxClient,
      objectStore: objects,
      triggerRemover: triggers,
      initialInventory: firstInventory,
      env: { COMPANION_COMPANIONS_ENABLED: "true" },
    })).rejects.toThrow("must be explicitly set to false");
    const [ledgerAfterFlagGuard] = await database<Array<{ runs: string; targets: string }>>`
      select
        (select count(*)::text from public.companion_v2_purge_runs) as runs,
        (select count(*)::text from public.companion_v2_purge_targets) as targets
    `;
    expect(ledgerAfterFlagGuard).toEqual({ runs: "0", targets: "0" });

    await database`
      update public.companion_runtime_control
      set enabled = true, enabled_at = statement_timestamp(), disabled_at = null
      where id = 'runtime-v2'
    `;
    await expect(executeConfirmedCompanionV2Purge({
      client: database,
      boxClient,
      objectStore: objects,
      triggerRemover: triggers,
      initialInventory: firstInventory,
      env: { COMPANION_COMPANIONS_ENABLED: "false" },
    })).rejects.toThrow("Runtime v2 database gate must be disabled before purge");
    await database`
      update public.companion_runtime_control
      set enabled = false, enabled_at = null, disabled_at = statement_timestamp()
      where id = 'runtime-v2'
    `;
    const [disabledGate] = await database<Array<{ gateEpoch: string }>>`
      select gate_epoch::text as "gateEpoch"
      from public.companion_runtime_control where id = 'runtime-v2'
    `;
    const enabler = postgres(upgradeUrl.toString(), { max: 1 });
    try {
      await enabler`set statement_timeout = 100`;
      await expect(enabler`
        select * from public.companion_runtime_enable(
          ${Number(disabledGate?.gateEpoch)}, 'race-during-purge'
        )
      `).rejects.toMatchObject({ code: "57014" });
    } finally {
      await enabler.end({ timeout: 1 });
    }
    const [stillDisabled] = await database<Array<{ enabled: boolean }>>`
      select enabled from public.companion_runtime_control where id = 'runtime-v2'
    `;
    expect(stillDisabled?.enabled).toBe(false);
    expect({
      boxDeletes: boxes.deletionRequests,
      snapshotDeletes: boxes.snapshotDeletes,
      objectDeletes: objects.removals,
      triggerAttempts,
    }).toEqual({ boxDeletes: 0, snapshotDeletes: 0, objectDeletes: 0, triggerAttempts: 0 });
    const preservedBefore = await database<Array<{ fingerprint: postgres.JSONValue }>>`
      select public.companion_v2_purge_preservation_fingerprint() as fingerprint
    `;
    const [preservedRowsBefore] = await database.unsafe<Array<Record<string, string>>>(
      `select
        (select ciphertext from public.companion_provider_connections where org_id = '${orgId}') as provider,
        (select ciphertext from public.companion_mcp_accounts where id = '${mcpAccountId}') as mcp,
        (select ciphertext from public.companion_trigger_provider_accounts where id = '${triggerAccountId}') as trigger,
        (select ciphertext from public.companion_plugin_trigger_keys where id = '${pluginKeyId}') as plugin,
        (select slug from public.skills where id = '${skillId}') as skill,
        (select ciphertext from public.secret_versions where secret_id = '${secretId}') as secret,
        (select storage_key from public.skill_database_realms where id = '${realmId}') as skill_database,
        (select stripe_customer_id from public.billing_subscriptions where org_id = '${orgId}') as billing,
        (select action from public.audit_log where target_id = 'preserved') as audit`,
    );
    expect(preservedRowsBefore).toEqual({
      provider: "ciphertext",
      mcp: "mcp-ciphertext",
      trigger: "trigger-ciphertext",
      plugin: "plugin-ciphertext",
      skill: "preserved-skill",
      secret: "secret-ciphertext",
      skill_database: "skilldb/preserved.sqlite",
      billing: "cus_preserved",
      audit: "fixture.created",
    });

    await expect(executeConfirmedCompanionV2Purge({
      client: database,
      boxClient,
      objectStore: objects,
      triggerRemover: triggers,
      initialInventory: firstInventory,
      env: { COMPANION_COMPANIONS_ENABLED: "false" },
      beforeExternalEffect: async (target) => {
        if (target.key === "bx_56789abc") throw new Error("crash before Box DELETE");
      },
    })).rejects.toThrow("crash before Box DELETE");
    expect(boxes.deletionRequests).toBe(0);

    const beforeAcceptedInventory = await collectCompanionV2PurgeInventory({
      client: database, boxClient, objectStore: objects,
    });
    await expect(executeConfirmedCompanionV2Purge({
      client: database,
      boxClient,
      objectStore: objects,
      triggerRemover: triggers,
      initialInventory: beforeAcceptedInventory,
      env: { COMPANION_COMPANIONS_ENABLED: "false" },
      afterExternalEffect: async (target) => {
        if (target.key === "bx_56789abc") {
          throw new Error("crash after accepted Box deletion before operation checkpoint");
        }
      },
    })).rejects.toThrow("crash after accepted Box deletion before operation checkpoint");
    expect(boxes.deletionRequests).toBe(1);
    const [boxCrashTarget] = await database<Array<{
      state: string;
      operationId: string | null;
    }>>`
      select state, operation_id as "operationId"
      from public.companion_v2_purge_targets
      where resource_kind = 'box' and resource_key = 'bx_56789abc'
    `;
    expect(boxCrashTarget).toEqual({ state: "requesting", operationId: null });

    const beforeOperationCheckpointCrash = await collectCompanionV2PurgeInventory({
      client: database, boxClient, objectStore: objects,
    });
    await expect(executeConfirmedCompanionV2Purge({
      client: database,
      boxClient,
      objectStore: objects,
      triggerRemover: triggers,
      initialInventory: beforeOperationCheckpointCrash,
      env: { COMPANION_COMPANIONS_ENABLED: "false" },
      afterBoxOperationCheckpoint: async (target) => {
        if (target.key === "bx_6789abcd") {
          throw new Error("crash after durable Box operation checkpoint");
        }
      },
    })).rejects.toThrow("crash after durable Box operation checkpoint");
    const [recordedBoxTarget] = await database<Array<{
      state: string;
      operationId: string | null;
    }>>`
      select state, operation_id as "operationId"
      from public.companion_v2_purge_targets
      where resource_kind = 'box' and resource_key = 'bx_6789abcd'
    `;
    expect(recordedBoxTarget).toEqual({
      state: "requesting",
      operationId: "bdop_55555555555555555555555555555555",
    });

    const beforeObjectCrashInventory = await collectCompanionV2PurgeInventory({
      client: database, boxClient, objectStore: objects,
    });
    await expect(executeConfirmedCompanionV2Purge({
      client: database,
      boxClient,
      objectStore: objects,
      triggerRemover: triggers,
      initialInventory: beforeObjectCrashInventory,
      env: { COMPANION_COMPANIONS_ENABLED: "false" },
      afterExternalEffect: async (target) => {
        if (target.kind === "object") throw new Error("crash after accepted object deletion");
      },
    })).rejects.toThrow("crash after accepted object deletion");
    expect(objects.removals).toBe(1);

    const beforeSnapshotCrashInventory = await collectCompanionV2PurgeInventory({
      client: database, boxClient, objectStore: objects,
    });
    await expect(executeConfirmedCompanionV2Purge({
      client: database,
      boxClient,
      objectStore: objects,
      triggerRemover: triggers,
      initialInventory: beforeSnapshotCrashInventory,
      env: { COMPANION_COMPANIONS_ENABLED: "false" },
      afterExternalEffect: async (target) => {
        if (target.kind === "snapshot") throw new Error("crash after accepted snapshot deletion");
      },
    })).rejects.toThrow("crash after accepted snapshot deletion");
    expect({ objectDeletes: objects.removals, snapshotDeletes: boxes.snapshotDeletes })
      .toEqual({ objectDeletes: 1, snapshotDeletes: 1 });

    const beforeTriggerDeleteInventory = await collectCompanionV2PurgeInventory({
      client: database, boxClient, objectStore: objects,
    });
    await expect(executeConfirmedCompanionV2Purge({
      client: database,
      boxClient,
      objectStore: objects,
      triggerRemover: triggers,
      initialInventory: beforeTriggerDeleteInventory,
      env: { COMPANION_COMPANIONS_ENABLED: "false" },
      beforeExternalEffect: async (target) => {
        if (target.kind === "trigger") throw new Error("crash after trigger discovery before DELETE");
      },
    })).rejects.toThrow("crash after trigger discovery before DELETE");
    expect(triggerAttempts).toBe(0);

    const beforeTriggerInventory = await collectCompanionV2PurgeInventory({
      client: database, boxClient, objectStore: objects,
    });
    await expect(executeConfirmedCompanionV2Purge({
      client: database,
      boxClient,
      objectStore: objects,
      triggerRemover: triggers,
      initialInventory: beforeTriggerInventory,
      env: { COMPANION_COMPANIONS_ENABLED: "false" },
      afterExternalEffect: async (target) => {
        if (target.kind === "trigger") throw new Error("crash after accepted trigger deletion");
      },
    })).rejects.toThrow("crash after accepted trigger deletion");
    for (const roleSource of [apiUrl, workerUrl, runtimeUrl]) {
      const restricted = postgres(databaseRoleUrl(roleSource!, databaseName), { max: 1 });
      try {
        try {
          expect(await restricted`select * from public.companion_v2_purge_runs`).toEqual([]);
        } catch (error) {
          expect(error).toMatchObject({ code: "42501" });
        }
        await expect(restricted`
          insert into public.companion_v2_purge_targets(resource_kind,resource_key,evidence)
          values ('object','forbidden','[]'::jsonb)
        `).rejects.toThrow(/permission denied|row-level security/);
      } finally {
        await restricted.end({ timeout: 1 });
      }
    }
    const [ownedAfterFailure] = await database<Array<{ count: string }>>`
      select count(*)::text as count from public.companions where id = ${companionId}::uuid
    `;
    expect(ownedAfterFailure?.count).toBe("1");
    await database`
      insert into public.audit_log(org_id,actor_id,action,target_type,target_id,metadata)
      values (${orgId}::uuid,'purge-owner','fixture.during_purge','test','preserved-during','{}')
    `;
    const preservedAtFinalization = await database<Array<{ fingerprint: postgres.JSONValue }>>`
      select public.companion_v2_purge_preservation_fingerprint() as fingerprint
    `;
    expect(preservedAtFinalization).not.toEqual(preservedBefore);

    objects.keys.add("companion-attachments/orphan/output.png");
    const contradictedInventory = await collectCompanionV2PurgeInventory({
      client: database, boxClient, objectStore: objects,
    });
    await expect(executeConfirmedCompanionV2Purge({
      client: database,
      boxClient,
      objectStore: objects,
      triggerRemover: triggers,
      initialInventory: contradictedInventory,
      env: { COMPANION_COMPANIONS_ENABLED: "false" },
    })).rejects.toThrow(
      "terminal Runtime v2 purge target remains visible (object:companion-attachments/orphan/output.png)",
    );
    expect(objects.removals).toBe(1);
    const [ownedAfterContradiction] = await database<Array<{ count: string }>>`
      select count(*)::text as count from public.companions where id = ${companionId}::uuid
    `;
    expect(ownedAfterContradiction?.count).toBe("1");
    objects.keys.delete("companion-attachments/orphan/output.png");

    const retryInventory = await collectCompanionV2PurgeInventory({
      client: database, boxClient, objectStore: objects,
    });
    const result = await executeConfirmedCompanionV2Purge({
      client: database,
      boxClient,
      objectStore: objects,
      triggerRemover: triggers,
      initialInventory: retryInventory,
      env: { COMPANION_COMPANIONS_ENABLED: "false" },
    });
    expect(result).toMatchObject({ already_complete: false, companions: 1, remaining_companion_rows: 0 });
    expect({
      boxDeletes: boxes.deletionRequests,
      snapshotDeletes: boxes.snapshotDeletes,
      objectDeletes: objects.removals,
      triggerAttempts,
    }).toEqual({ boxDeletes: 2, snapshotDeletes: 2, objectDeletes: 1, triggerAttempts: 1 });
    expect(triggerInspections).toContain(ambiguousTriggerId);
    expect([...boxes.snapshots]).toEqual(["provider-only-unrelated-snapshot"]);

    const [remaining] = await database<Array<{
      companions: string;
      triggers: string;
      attempts: string;
      delegations: string;
      desktopRequests: string;
    }>>`
      select
        (select count(*)::text from public.companions) as companions,
        (select count(*)::text from public.companion_triggers) as triggers,
        (select count(*)::text from public.companion_turn_attempts) as attempts,
        (select count(*)::text from public.companion_delegations) as delegations,
        (select count(*)::text from public.companion_runtime_desktop_requests) as "desktopRequests"
    `;
    expect(remaining).toEqual({
      companions: "0",
      triggers: "0",
      attempts: "0",
      delegations: "0",
      desktopRequests: "0",
    });
    const preservedAfter = await database<Array<{ fingerprint: postgres.JSONValue }>>`
      select public.companion_v2_purge_preservation_fingerprint() as fingerprint
    `;
    expect(preservedAfter).toEqual(preservedAtFinalization);
    const [preservedRowsAfter] = await database.unsafe<Array<Record<string, string>>>(
      `select
        (select ciphertext from public.companion_provider_connections where org_id = '${orgId}') as provider,
        (select ciphertext from public.companion_mcp_accounts where id = '${mcpAccountId}') as mcp,
        (select ciphertext from public.companion_trigger_provider_accounts where id = '${triggerAccountId}') as trigger,
        (select ciphertext from public.companion_plugin_trigger_keys where id = '${pluginKeyId}') as plugin,
        (select slug from public.skills where id = '${skillId}') as skill,
        (select ciphertext from public.secret_versions where secret_id = '${secretId}') as secret,
        (select storage_key from public.skill_database_realms where id = '${realmId}') as skill_database,
        (select stripe_customer_id from public.billing_subscriptions where org_id = '${orgId}') as billing,
        (select action from public.audit_log where target_id = 'preserved') as audit`,
    );
    expect(preservedRowsAfter).toEqual(preservedRowsBefore);
    await expect(database`
      update public.companion_v2_purge_runs set inventory = '{}'::jsonb
      where id = 'runtime-v2-purge'
    `).rejects.toThrow(/immutable/);
  }, 30_000);
});
