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
  collectCompanionV2PurgeInventory,
  executeConfirmedCompanionV2Purge,
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
  boxPresent = true;
  snapshotPresent = true;
  deletionRequests = 0;
  snapshotDeletes = 0;

  async listAllBoxes(): Promise<BoxMaintenanceBox[]> {
    return this.boxPresent
      ? [{ id: "bx_23456789", name: "Companion 22222222-2222-4222-8222-222222222222 g1" }]
      : [];
  }

  async listNamedSnapshots() {
    return this.snapshotPresent
      ? [{
          name: "companion-l14-0123456789ab",
          status: "ready" as const,
          sourceBoxId: "bx_23456789",
          createdAt: new Date(0).toISOString(),
        }]
      : [];
  }

  async deleteNamedSnapshot(): Promise<void> {
    this.snapshotDeletes += 1;
    this.snapshotPresent = false;
  }

  async requestPermanentDeletion(input: { boxId: string }): Promise<BoxPermanentDeletionResult> {
    this.deletionRequests += 1;
    this.boxPresent = false;
    return { outcome: "absent", boxId: input.boxId };
  }

  async getDeletionOperation(): Promise<BoxDeletionOperation> {
    throw new Error("an absent disposable Box has no operation");
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
      insert into public.audit_log(org_id,actor_id,action,target_type,target_id,metadata)
      values ('${orgId}','purge-owner','fixture.created','test','preserved','{"safe":true}');
      insert into public.companions(id,org_id,owner_id,name)
      values ('${companionId}','${orgId}','purge-owner','Disposable Companion');
      insert into public.companion_runtime_instances(org_id,companion_id,box_id)
      values ('${orgId}','${companionId}','bx_23456789');
      insert into public.companion_images(digest,image_name)
      values (repeat('a',64),'companion-l14-0123456789ab');
      insert into public.companion_triggers(
        id,org_id,companion_id,name,prompt,provider,secret,target,
        registration_status,remote_hook_id,created_by
      ) values (
        '${triggerId}','${orgId}','${companionId}','GitHub','relay','github',repeat('a',32),
        '{"repo":"owner/repo"}','registered','hook-fixture','purge-owner'
      );
    `);

    const boxes = new DisposableBoxProvider();
    const objects = new DisposableObjectStore();
    let triggerAttempts = 0;
    const triggers: CompanionV2TriggerRemover = {
      async remove() {
        triggerAttempts += 1;
        if (triggerAttempts === 1) throw new Error("disposable provider failure");
        return "completed";
      },
    };
    const boxClient = boxes;
    const firstInventory = await collectCompanionV2PurgeInventory({
      client: database, boxClient, objectStore: objects,
    });
    expect(firstInventory.targets.map((target) => target.kind)).toEqual([
      "box", "object", "snapshot", "trigger",
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
    expect({
      boxDeletes: boxes.deletionRequests,
      snapshotDeletes: boxes.snapshotDeletes,
      objectDeletes: objects.removals,
      triggerAttempts,
    }).toEqual({ boxDeletes: 0, snapshotDeletes: 0, objectDeletes: 0, triggerAttempts: 0 });
    const preservedBefore = await database<Array<{ fingerprint: postgres.JSONValue }>>`
      select public.companion_v2_purge_preservation_fingerprint() as fingerprint
    `;

    await expect(executeConfirmedCompanionV2Purge({
      client: database,
      boxClient,
      objectStore: objects,
      triggerRemover: triggers,
      initialInventory: firstInventory,
      env: { COMPANION_COMPANIONS_ENABLED: "false" },
    })).rejects.toThrow("disposable provider failure");
    const [ownedAfterFailure] = await database<Array<{ count: string }>>`
      select count(*)::text as count from public.companions where id = ${companionId}::uuid
    `;
    expect(ownedAfterFailure?.count).toBe("1");

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
    }).toEqual({ boxDeletes: 1, snapshotDeletes: 1, objectDeletes: 1, triggerAttempts: 2 });

    const [remaining] = await database<Array<{ companions: string; triggers: string; attempts: string }>>`
      select
        (select count(*)::text from public.companions) as companions,
        (select count(*)::text from public.companion_triggers) as triggers,
        (select count(*)::text from public.companion_turn_attempts) as attempts
    `;
    expect(remaining).toEqual({ companions: "0", triggers: "0", attempts: "0" });
    const preservedAfter = await database<Array<{ fingerprint: postgres.JSONValue }>>`
      select public.companion_v2_purge_preservation_fingerprint() as fingerprint
    `;
    expect(preservedAfter).toEqual(preservedBefore);
    await expect(database`
      update public.companion_v2_purge_runs set inventory = '{}'::jsonb
      where id = 'runtime-v2-purge'
    `).rejects.toThrow(/immutable/);
  }, 30_000);
});
