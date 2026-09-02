/**
 * Product promise: upgrading a Runtime v3 Companion that was already Prepared by protocol 3 must
 * converge it back to staging instead of rejecting the THE-516 proof constraint.
 *
 * Why integrated: PostgreSQL validates CHECK constraints against existing rows while applying the
 * migration; a schema snapshot or unit fake cannot reproduce the 0163 -> 0165 ordering failure.
 */
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const databaseUrl = process.env.DATABASE_MIGRATION_URL ?? process.env.DATABASE_URL;
if (!databaseUrl?.trim()) {
  throw new Error("Runtime v3 preparation migration test requires a disposable PostgreSQL URL");
}

const migrationsDir = fileURLToPath(new URL("../../../../packages/db/drizzle/", import.meta.url));
const grantsFile = fileURLToPath(
  new URL("../../../../packages/db/runtime-role-grants.sql", import.meta.url),
);
const suffix = randomUUID().replaceAll("-", "").slice(0, 16);
const databaseName = `v3_complete_prepare_${suffix}`;
const apiRole = `v3_prepare_api_${suffix}`;
const workerRole = `v3_prepare_worker_${suffix}`;
const runtimeRole = `v3_prepare_runtime_${suffix}`;
const actorId = `v3-prepare-owner-${suffix}`;
const orgId = randomUUID();
const companionId = randomUUID();
const skillId = randomUUID();
const skillVersionId = randomUUID();
const nextSkillVersionId = randomUUID();
const mcpAccountId = randomUUID();
const adminSql = postgres(databaseUrl, { max: 1 });
const upgradeUrl = new URL(databaseUrl);
upgradeUrl.pathname = `/${databaseName}`;
upgradeUrl.search = "";
let upgradeSql: ReturnType<typeof postgres>;

async function applyMigrationFile(name: string): Promise<void> {
  const source = await readFile(`${migrationsDir}/${name}`, "utf8");
  const statements = source
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter(Boolean);
  await upgradeSql.begin(async (transaction) => {
    for (const statement of statements) await transaction.unsafe(statement);
  });
}

async function applySplitGrants(): Promise<void> {
  const source = await readFile(grantsFile, "utf8");
  const beginMarker = "-- companion-runtime-grants-begin";
  const endMarker = "-- companion-runtime-grants-end";
  const begin = source.indexOf(beginMarker);
  const end = source.indexOf(endMarker);
  if (begin < 0 || end <= begin) throw new Error("runtime grant hook markers are missing");
  const connection = await upgradeSql.reserve();
  try {
    await connection`select set_config('companion.api_role', ${apiRole}, false)`;
    await connection`select set_config('companion.worker_role', ${workerRole}, false)`;
    await connection`select set_config('companion.companion_runtime_role', ${runtimeRole}, false)`;
    await connection`select set_config('companion.retired_runtime_role', '', false)`;
    const historicalGrants = source.slice(begin + beginMarker.length, end).trim()
      .split("\n")
      .filter((line) => !line.includes("companion_v3_runtime_claim_preparation")
        && !line.includes("companion_v3_runtime_checkpoint_preparation")
        && !line.includes("companion_v3_runtime_defer_preparation")
        && !line.includes("companion_v3_runtime_reauthorize_preparation")
        && !line.includes("companion_v3_runtime_mint_preparation_credentials"))
      .join("\n");
    await connection.unsafe(historicalGrants);
  } finally {
    connection.release();
  }
}

describe("0165 complete preparation migration", () => {
  beforeAll(async () => {
    await adminSql.unsafe(`
      create role ${apiRole} login nosuperuser nobypassrls noinherit;
      create role ${workerRole} login nosuperuser nobypassrls noinherit;
      create role ${runtimeRole} login nosuperuser nobypassrls noinherit;
    `);
    await adminSql.unsafe(`create database "${databaseName}"`);
    upgradeSql = postgres(upgradeUrl.toString(), { max: 1 });

    const migrations = (await readdir(migrationsDir))
      .filter((name) => /^\d{4}_.+\.sql$/.test(name)
        && name < "0164_runtime_images_optional_accelerators.sql")
      .sort();
    const cutoverIndex = migrations.findIndex((name) => name.startsWith("0094_"));
    if (cutoverIndex < 0) throw new Error("Runtime v2 cutover migration is missing");
    for (const migration of migrations.slice(0, cutoverIndex)) await applyMigrationFile(migration);
    await applySplitGrants();
    for (const migration of migrations.slice(cutoverIndex)) await applyMigrationFile(migration);
    await applySplitGrants();

    await upgradeSql`
      insert into public."user" (id, name, email, email_verified)
      values (${actorId}, 'Prepared Owner', ${`${actorId}@example.test`}, true)
    `;
    await upgradeSql`
      insert into public.organizations (id, name, slug, kind)
      values (${orgId}::uuid, 'Prepared Upgrade', ${`prepared-${suffix}`}, 'team')
    `;
    await upgradeSql`
      insert into public.memberships (org_id, user_id, org_role)
      values (${orgId}::uuid, ${actorId}, 'owner')
    `;
    await upgradeSql`
      insert into public.companions (id, org_id, owner_id, name, model_id)
      values (${companionId}::uuid, ${orgId}::uuid, ${actorId}, 'Prepared Companion', 'fixture-model')
    `;
    await upgradeSql`
      insert into public.companion_provider_connections(
        org_id, provider_id, auth_method, ciphertext, iv, auth_tag,
        wrapped_dek, wrap_iv, wrap_auth_tag, key_id, connected_by
      ) values (
        ${orgId}::uuid, 'anthropic', 'api_key', 'ciphertext', 'iv', 'tag',
        'dek', 'wiv', 'wtag', 'key', ${actorId}
      )
    `;
    await upgradeSql`
      insert into public.skills(id, org_id, slug, display_name, description, creator_id, scope)
      values (${skillId}::uuid, ${orgId}::uuid, ${`prepared-skill-${suffix}`},
        'Prepared Skill', 'Prepared migration fixture', ${actorId}, 'personal')
    `;
    await upgradeSql`
      insert into public.skill_versions(
        id, org_id, skill_id, version, frontmatter, tools, size_bytes,
        checksum, storage_path, validation, created_by
      ) values (
        ${skillVersionId}::uuid, ${orgId}::uuid, ${skillId}::uuid, '1.0.0',
        'name: prepared-skill', '[]'::jsonb, 42, ${`sha256:${"a".repeat(64)}`},
        ${`skills/${skillVersionId}.tar.gz`}, 'valid', ${actorId}
      )
    `;
    await upgradeSql`
      update public.skills set current_version_id = ${skillVersionId}::uuid
      where org_id = ${orgId}::uuid and id = ${skillId}::uuid
    `;
    await upgradeSql`
      insert into public.companion_mcp_accounts(
        id, org_id, owner_id, provider, label, transport, account_config,
        ciphertext, iv, auth_tag, wrapped_dek, wrap_iv, wrap_auth_tag, key_id
      ) values (
        ${mcpAccountId}::uuid, ${orgId}::uuid, ${actorId}, 'linear', 'Linear', 'http', '{}',
        'mcp-ciphertext', 'mcp-iv', 'mcp-tag', 'mcp-dek', 'mcp-wiv', 'mcp-wtag', 'mcp-key'
      )
    `;
    await upgradeSql`
      update public.companions set provider_ids = '["anthropic"]'::jsonb,
        selected_skill_ids = ${upgradeSql.json([skillId])},
        selected_mcp_account_ids = ${upgradeSql.json([mcpAccountId])}
      where org_id = ${orgId}::uuid and id = ${companionId}::uuid
    `;
    await upgradeSql`
      insert into public.companion_runtime_instances(
        org_id, companion_id, box_id, box_state, pi_state, pi_invocation_id,
        disk_layout_version, applied_settings_revision, applied_skills_revision,
        applied_client_surface, health_due_at
      ) values (
        ${orgId}::uuid, ${companionId}::uuid, 'bx_23456789', 'ready', 'idle',
        'pi-protocol-3', 14, 1, 1, 'web', now() + interval '1 day'
      )
    `;
    await upgradeSql`
      insert into public.companion_v3_instances(
        org_id, companion_id, desired_lifecycle_actor_id, preparation_checkpoint,
        box_id, box_ready_at, staging_completed_at, pi_invocation_id, prepared_at
      ) values (
        ${orgId}::uuid, ${companionId}::uuid, ${actorId}, 'prepared',
        'bx_23456789', now() - interval '3 seconds', now() - interval '2 seconds',
        'pi-protocol-3', now() - interval '1 second'
      )
    `;
    await upgradeSql`
      insert into public.companion_v3_lane_leases(org_id, companion_id, lane)
      values (${orgId}::uuid, ${companionId}::uuid, 'main'),
        (${orgId}::uuid, ${companionId}::uuid, 'background')
    `;
    await upgradeSql`
      insert into public.companion_threads(org_id, companion_id)
      values (${orgId}::uuid, ${companionId}::uuid)
    `;

    await applyMigrationFile("0164_runtime_images_optional_accelerators.sql");
    await applyMigrationFile("0165_companion_runtime_v3_complete_preparation.sql");
    await upgradeSql`update public.companion_runtime_control set enabled = true,
      enabled_at = coalesce(enabled_at, now()), disabled_at = null where id = 'runtime-v2'`;
  }, 30_000);

  afterAll(async () => {
    if (upgradeSql) await upgradeSql.end({ timeout: 1 });
    await adminSql.unsafe(`drop database if exists "${databaseName}" with (force)`);
    await adminSql.unsafe(`drop role if exists ${apiRole}, ${workerRole}, ${runtimeRole}`);
    await adminSql.end({ timeout: 1 });
  });

  it("resets a protocol-3 Prepared row before validating the complete proof constraint", async () => {
    const [row] = await upgradeSql<Array<{
      checkpoint: string;
      boxId: string | null;
      stagingCompletedAt: Date | null;
      piInvocationId: string | null;
      preparedAt: Date | null;
      proofVersion: number | null;
      constraintValidated: boolean;
    }>>`
      select instance.preparation_checkpoint as checkpoint, instance.box_id as "boxId",
        instance.staging_completed_at as "stagingCompletedAt",
        instance.pi_invocation_id as "piInvocationId", instance.prepared_at as "preparedAt",
        instance.prepared_disk_layout_version as "proofVersion", constraint_row.convalidated as "constraintValidated"
      from public.companion_v3_instances instance
      cross join pg_catalog.pg_constraint constraint_row
      where instance.org_id = ${orgId}::uuid and instance.companion_id = ${companionId}::uuid
        and constraint_row.conname = 'companion_v3_instances_preparation_check'
        and constraint_row.conrelid = 'public.companion_v3_instances'::regclass
    `;
    expect(row).toEqual({
      checkpoint: "box_ready",
      boxId: "bx_23456789",
      stagingCompletedAt: null,
      piInvocationId: null,
      preparedAt: null,
      proofVersion: null,
      constraintValidated: true,
    });
  });

  it("rejects expired warm material, restages it, and admits only the new proof", async () => {
    await markPrepared(new Date(Date.now() - 1_000));
    const clientMessageId = randomUUID();
    await upgradeSql.begin(async (transaction) => {
      await transaction`select set_config('app.org_id', ${orgId}, true)`;
      await transaction`select set_config('app.user_id', ${actorId}, true)`;
      await transaction`select * from public.companion_v3_api_enqueue_warm_turn(
        ${orgId}::uuid, ${companionId}::uuid, ${clientMessageId}::uuid, 'expiry boundary'
      )`;
    });

    const expiredWarm = await upgradeSql`
      select * from public.companion_v3_runtime_claim_warm('expired-warm', 'main', 30, 3)
    `;
    expect(expiredWarm).toEqual([]);
    await expectPreparationCheckpoint("box_ready");

    const [stagingClaim] = await upgradeSql<Array<PreparationClaim>>`
      select claim_token as "claimToken", claim_epoch::text as "claimEpoch",
        gate_epoch::text as "gateEpoch", checkpoint, authorized
      from public.companion_v3_runtime_claim_preparation('restage-expired', 90, 4)
    `;
    expect(stagingClaim).toMatchObject({ checkpoint: "box_ready", authorized: true });
    await checkpointPreparation(stagingClaim!, "box_ready", "staged", {
      diskLayoutVersion: 14,
      settingsRevision: 1,
      skillsRevision: 1,
      skillsDigest: "b".repeat(64),
      materialExpiresAt: new Date(Date.now() + 6 * 60 * 60 * 1_000),
    });

    const [activationClaim] = await upgradeSql<Array<PreparationClaim>>`
      select claim_token as "claimToken", claim_epoch::text as "claimEpoch",
        gate_epoch::text as "gateEpoch", checkpoint, authorized
      from public.companion_v3_runtime_claim_preparation('activate-restaged', 90, 4)
    `;
    expect(activationClaim).toMatchObject({ checkpoint: "staged", authorized: true });
    await checkpointPreparation(activationClaim!, "staged", "prepared", {
      piInvocationId: "pi-restaged",
    });

    const admitted = await upgradeSql<Array<{ turnId: string }>>`
      select turn_id as "turnId"
      from public.companion_v3_runtime_claim_warm('fresh-warm', 'main', 30, 3)
    `;
    expect(admitted).toHaveLength(1);
    await upgradeSql`update public.companion_v3_lane_leases set claim_token = null,
      gate_epoch = null, executor_id = null, turn_id = null, claimed_at = null,
      renewed_at = null, expires_at = null where org_id = ${orgId}::uuid
        and companion_id = ${companionId}::uuid and lane = 'main'`;
  });

  it("binds rotated MCP and control capabilities to the resolver-owned runtime row", async () => {
    await upgradeSql`delete from public.companion_v3_turns
      where org_id = ${orgId}::uuid and companion_id = ${companionId}::uuid`;
    await upgradeSql`update public.companion_v3_instances set
      preparation_checkpoint = 'box_ready', staging_completed_at = null,
      pi_invocation_id = null, prepared_at = null, preparation_actor_id = null,
      preparation_settings_revision = null, preparation_skills_revision = null,
      preparation_model_id = null, preparation_provider_refs = null,
      preparation_skill_refs = null, preparation_mcp_refs = null,
      prepared_disk_layout_version = null, prepared_skills_digest = null,
      prepared_material_expires_at = null, preparation_available_at = now()
      where org_id = ${orgId}::uuid and companion_id = ${companionId}::uuid`;
    const [claim] = await upgradeSql<Array<PreparationClaim>>`
      select claim_token as "claimToken", claim_epoch::text as "claimEpoch",
        gate_epoch::text as "gateEpoch", checkpoint, authorized
      from public.companion_v3_runtime_claim_preparation('mint-capabilities', 90, 4)
    `;
    expect(claim).toMatchObject({ checkpoint: "box_ready", authorized: true });
    const first = await mintPreparationCredentials(claim!);
    const second = await mintPreparationCredentials(claim!);

    const turnId = randomUUID();
    const attemptId = randomUUID();
    const legacyMessageId = randomUUID();
    await upgradeSql`
      insert into public.companion_turns(
        id, org_id, companion_id, client_message_id, message_event_id, queue_sequence,
        actor_id, client_surface, status, inactivity_deadline_at, absolute_deadline_at
      ) values (
        ${turnId}::uuid, ${orgId}::uuid, ${companionId}::uuid, ${legacyMessageId}::uuid,
        ${`msg:${legacyMessageId}`}, 1, ${actorId}, 'web', 'running',
        now() + interval '10 minutes', now() + interval '2 hours'
      )
    `;
    await upgradeSql`
      insert into public.companion_turn_attempts(
        id, org_id, companion_id, turn_id, attempt_number, actor_id,
        runtime_generation, settings_revision, skills_revision, model_id,
        provider_ids, selected_skill_ids, selected_mcp_account_ids,
        provider_credential_refs, mcp_credential_refs, status, checkpoint,
        dispatch_state, command_id, last_activity_at
      ) values (
        ${attemptId}::uuid, ${orgId}::uuid, ${companionId}::uuid, ${turnId}::uuid,
        1, ${actorId}, 1, 1, 1, 'fixture-model', '["anthropic"]'::jsonb,
        ${upgradeSql.json([skillId])}, ${upgradeSql.json([mcpAccountId])},
        '[]'::jsonb, '[]'::jsonb, 'running', 'running', 'accepted',
        ${randomUUID()}::uuid, now()
      )
    `;

    expect(await resolveMcp(first.mcpBrokerToken)).toEqual([]);
    expect(await resolveControl(first.controlToken)).toEqual([]);
    expect(await resolveMcp(second.mcpBrokerToken)).toEqual([
      expect.objectContaining({ companionId, actorId }),
    ]);
    expect(await resolveControl(second.controlToken)).toEqual([
      expect.objectContaining({ companionId, actorId, turnId, attemptId }),
    ]);
    const [bindings] = await upgradeSql<Array<{
      v3Mcp: string | null; runtimeMcp: string | null;
      v3Control: string | null; runtimeControl: string | null;
    }>>`
      select v3.mcp_broker_token_id as "v3Mcp", runtime.mcp_broker_token_id as "runtimeMcp",
        v3.control_token_id as "v3Control", runtime.control_token_id as "runtimeControl"
      from public.companion_v3_instances v3 join public.companion_runtime_instances runtime
        on runtime.org_id = v3.org_id and runtime.companion_id = v3.companion_id
      where v3.org_id = ${orgId}::uuid and v3.companion_id = ${companionId}::uuid
    `;
    expect(bindings?.v3Mcp).toBe(bindings?.runtimeMcp);
    expect(bindings?.v3Control).toBe(bindings?.runtimeControl);
  });

  it("invalidates update and delete events for every selected resource table", async () => {
    await markPrepared(new Date(Date.now() + 6 * 60 * 60 * 1_000));
    await upgradeSql`update public.companion_provider_connections
      set credential_version = credential_version + 1
      where org_id = ${orgId}::uuid and provider_id = 'anthropic'`;
    await expectPreparationCheckpoint("box_ready");

    await markPrepared(new Date(Date.now() + 6 * 60 * 60 * 1_000));
    await upgradeSql`update public.companion_mcp_accounts set label = 'Linear updated'
      where org_id = ${orgId}::uuid and id = ${mcpAccountId}::uuid`;
    await expectPreparationCheckpoint("box_ready");

    await upgradeSql`
      insert into public.skill_versions(
        id, org_id, skill_id, version, frontmatter, tools, size_bytes,
        checksum, storage_path, validation, created_by
      ) values (
        ${nextSkillVersionId}::uuid, ${orgId}::uuid, ${skillId}::uuid, '1.0.1',
        'name: prepared-skill', '[]'::jsonb, 43, ${`sha256:${"c".repeat(64)}`},
        ${`skills/${nextSkillVersionId}.tar.gz`}, 'valid', ${actorId}
      )
    `;
    await markPrepared(new Date(Date.now() + 6 * 60 * 60 * 1_000));
    await upgradeSql`update public.skills set current_version_id = ${nextSkillVersionId}::uuid
      where org_id = ${orgId}::uuid and id = ${skillId}::uuid`;
    await expectPreparationCheckpoint("box_ready");

    await markPrepared(new Date(Date.now() + 6 * 60 * 60 * 1_000));
    await upgradeSql`delete from public.companion_provider_connections
      where org_id = ${orgId}::uuid and provider_id = 'anthropic'`;
    await expectPreparationCheckpoint("box_ready");
    await markPrepared(new Date(Date.now() + 6 * 60 * 60 * 1_000));
    await upgradeSql`delete from public.companion_mcp_accounts
      where org_id = ${orgId}::uuid and id = ${mcpAccountId}::uuid`;
    await expectPreparationCheckpoint("box_ready");
    await markPrepared(new Date(Date.now() + 6 * 60 * 60 * 1_000));
    await upgradeSql`delete from public.skills
      where org_id = ${orgId}::uuid and id = ${skillId}::uuid`;
    await expectPreparationCheckpoint("box_ready");
  });
});

interface PreparationClaim {
  claimToken: string;
  claimEpoch: string;
  gateEpoch: string;
  checkpoint: string;
  authorized: boolean;
}

async function markPrepared(materialExpiresAt: Date): Promise<void> {
  await upgradeSql`update public.companion_v3_instances instance set
    preparation_checkpoint = 'prepared', box_ready_at = now() - interval '3 seconds',
    staging_completed_at = now() - interval '2 seconds', prepared_at = now() - interval '1 second',
    pi_invocation_id = 'pi-complete-proof', preparation_actor_id = ${actorId},
    preparation_settings_revision = 1, preparation_skills_revision = 1,
    preparation_model_id = 'fixture-model',
    preparation_provider_refs = '[]'::jsonb, preparation_skill_refs = '[]'::jsonb,
    preparation_mcp_refs = '[]'::jsonb, prepared_disk_layout_version = 14,
    prepared_skills_digest = ${"d".repeat(64)},
    prepared_material_expires_at = ${materialExpiresAt}, preparation_claim_token = null,
    preparation_gate_epoch = null, preparation_executor_id = null,
    preparation_claimed_at = null, preparation_expires_at = null,
    preparation_available_at = now()
    where instance.org_id = ${orgId}::uuid and instance.companion_id = ${companionId}::uuid`;
}

async function expectPreparationCheckpoint(expected: string): Promise<void> {
  const [row] = await upgradeSql<Array<{ checkpoint: string }>>`
    select preparation_checkpoint as checkpoint from public.companion_v3_instances
    where org_id = ${orgId}::uuid and companion_id = ${companionId}::uuid
  `;
  expect(row?.checkpoint).toBe(expected);
}

async function checkpointPreparation(
  claim: PreparationClaim,
  expected: "box_ready" | "staged",
  next: "staged" | "prepared",
  proof: {
    piInvocationId?: string;
    diskLayoutVersion?: number;
    settingsRevision?: number;
    skillsRevision?: number;
    skillsDigest?: string;
    materialExpiresAt?: Date;
  },
): Promise<void> {
  const [row] = await upgradeSql<Array<{ checkpointed: boolean }>>`
    select public.companion_v3_runtime_checkpoint_preparation(
      ${orgId}::uuid, ${companionId}::uuid, ${claim.claimToken}::uuid,
      ${claim.claimEpoch}::bigint, ${claim.gateEpoch}::bigint, ${expected}, ${next},
      null, ${proof.piInvocationId ?? null}, ${proof.diskLayoutVersion ?? null},
      ${proof.settingsRevision ?? null}::bigint, ${proof.skillsRevision ?? null},
      ${proof.skillsDigest ?? null}, ${proof.materialExpiresAt ?? null}, 4
    ) as checkpointed
  `;
  expect(row?.checkpointed).toBe(true);
}

async function mintPreparationCredentials(claim: PreparationClaim): Promise<{
  mcpBrokerToken: string;
  controlToken: string;
}> {
  const [row] = await upgradeSql<Array<{
    mcpBrokerToken: string | null;
    controlToken: string;
  }>>`
    select mcp_broker_token as "mcpBrokerToken", control_token as "controlToken"
    from public.companion_v3_runtime_mint_preparation_credentials(
      ${orgId}::uuid, ${companionId}::uuid, ${claim.claimToken}::uuid,
      ${claim.claimEpoch}::bigint, ${claim.gateEpoch}::bigint,
      'mint-capabilities', 90, 4
    )
  `;
  if (!row?.mcpBrokerToken) throw new Error("MCP preparation capability was not minted");
  return { mcpBrokerToken: row.mcpBrokerToken, controlToken: row.controlToken };
}

async function resolveMcp(token: string): Promise<Array<{ companionId: string; actorId: string }>> {
  return await upgradeSql`
    select companion_id as "companionId", actor_id as "actorId"
    from public.companion_resolve_mcp_broker_token(
      encode(sha256(convert_to(${token}, 'UTF8')), 'hex')
    )
  `;
}

async function resolveControl(token: string): Promise<Array<{
  companionId: string; actorId: string; turnId: string; attemptId: string;
}>> {
  return await upgradeSql`
    select companion_id as "companionId", actor_id as "actorId",
      turn_id as "turnId", attempt_id as "attemptId"
    from public.companion_resolve_control_token(
      encode(sha256(convert_to(${token}, 'UTF8')), 'hex')
    )
  `;
}
