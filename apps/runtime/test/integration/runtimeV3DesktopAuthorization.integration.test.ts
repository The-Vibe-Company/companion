/**
 * Product promise: desktop access observes only an already-prepared, active Runtime v3 Box after
 * reauthorizing the exact Owner/Editor and every selected personal resource.
 *
 * Why integrated: the regression was a deployed SECURITY DEFINER function that referenced columns
 * removed by the v3 contraction. Only replaying the real migration history into PostgreSQL proves
 * that the current function executes, retains split-role grants, and fails closed on current rows.
 * Sensitivity: restoring any retired v2 column read throws at the first authorization call; dropping
 * an actor, revision, lifecycle, preparation, tenant, or resource predicate makes its named case
 * authorize unexpectedly.
 */
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const adminUrl = process.env.DATABASE_MIGRATION_URL ?? process.env.DATABASE_URL;
if (!adminUrl?.trim()) {
  throw new Error("Runtime v3 desktop authorization integration requires a disposable PostgreSQL URL");
}

const migrationsDir = fileURLToPath(new URL("../../../../packages/db/drizzle/", import.meta.url));
const grantsFile = fileURLToPath(
  new URL("../../../../packages/db/runtime-role-grants.sql", import.meta.url),
);
const suffix = randomUUID().replaceAll("-", "").slice(0, 16);
const databaseName = `v3_desktop_${suffix}`;
const apiRole = `v3_desktop_api_${suffix}`;
const workerRole = `v3_desktop_worker_${suffix}`;
const runtimeRole = `v3_desktop_runtime_${suffix}`;
const rolePassword = `desktop-${suffix}`;
const ids = {
  org: randomUUID(),
  otherOrg: randomUUID(),
  owner: `v3-desktop-owner-${suffix}`,
  editor: `v3-desktop-editor-${suffix}`,
  viewer: `v3-desktop-viewer-${suffix}`,
  outsider: `v3-desktop-outsider-${suffix}`,
  otherOrgMember: `v3-desktop-other-org-${suffix}`,
  ownerCompanion: randomUUID(),
  editorCompanion: randomUUID(),
  ownerSkill: randomUUID(),
  ownerSkillVersion: randomUUID(),
  editorMcpAccount: randomUUID(),
};
const adminSql = postgres(adminUrl, { max: 1 });
const databaseUrl = new URL(adminUrl);
databaseUrl.pathname = `/${databaseName}`;
databaseUrl.search = "";
const runtimeUrl = new URL(databaseUrl);
runtimeUrl.username = runtimeRole;
runtimeUrl.password = rolePassword;
let database: ReturnType<typeof postgres> | undefined;
let runtime: ReturnType<typeof postgres> | undefined;

interface AuthorizationRow {
  authorized: boolean;
  denialCode: string | null;
  boxId: string | null;
  boxState: string | null;
  runtimeGeneration: string | null;
}

async function applyMigrationFile(client: ReturnType<typeof postgres>, name: string): Promise<void> {
  const statements = (await readFile(`${migrationsDir}/${name}`, "utf8"))
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter(Boolean);
  await client.begin(async (transaction) => {
    for (const statement of statements) await transaction.unsafe(statement);
  });
}

async function applyRuntimeGrants(client: ReturnType<typeof postgres>): Promise<void> {
  const source = await readFile(grantsFile, "utf8");
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

async function prepareCompanion(input: {
  companionId: string;
  actorId: string;
  boxId: string;
  selectedMcpAccountIds?: string[];
}): Promise<void> {
  const selectedMcpAccountIds = input.selectedMcpAccountIds ?? [];
  await database!`
    insert into public.companions(
      id, org_id, owner_id, name, model_id, provider_ids, selected_mcp_account_ids
    ) values (
      ${input.companionId}::uuid, ${ids.org}::uuid, ${ids.owner}, 'Desktop fixture',
      'claude-test', '["anthropic"]'::jsonb, ${database!.json(selectedMcpAccountIds)}
    )
  `;
  await database!`
    insert into public.companion_v3_instances(
      org_id, companion_id, desired_lifecycle_actor_id, desired_settings_revision,
      lifecycle_state, preparation_checkpoint, box_id, box_ready_at, staging_completed_at,
      pi_invocation_id, prepared_at, preparation_actor_id, preparation_settings_revision,
      preparation_skills_revision, preparation_model_id, preparation_provider_refs,
      preparation_skill_refs, preparation_mcp_refs, prepared_disk_layout_version,
      prepared_skills_digest, prepared_material_expires_at
    ) values (
      ${ids.org}::uuid, ${input.companionId}::uuid, ${input.actorId}, 1, 'active', 'prepared',
      ${input.boxId}, now() - interval '3 seconds', now() - interval '2 seconds',
      ${`pi-${input.companionId}`}, now() - interval '1 second', ${input.actorId}, 1, 1,
      'claude-test',
      (select jsonb_agg(jsonb_build_object(
        'provider_id', connection.provider_id,
        'credential_generation', connection.credential_generation,
        'credential_version', connection.credential_version
      ) order by connection.provider_id)
      from public.companion_provider_connections connection
      where connection.org_id=${ids.org}::uuid and connection.provider_id='anthropic'),
      '[]'::jsonb,
      (select coalesce(jsonb_agg(jsonb_build_object(
        'account_id', account.id,
        'credential_generation', account.credential_generation,
        'credential_version', account.credential_version
      ) order by account.id), '[]'::jsonb)
      from public.companion_mcp_accounts account
      where account.org_id=${ids.org}::uuid
        and account.id::text in (select jsonb_array_elements_text(${database!.json(selectedMcpAccountIds)}))),
      14, ${"a".repeat(64)}, now() + interval '6 hours'
    )
  `;
}

async function restorePrepared(input: {
  companionId: string;
  actorId: string;
  skillsRevision?: number;
  skillRefs?: postgres.JSONValue[];
  mcpRefs?: postgres.JSONValue[];
}): Promise<void> {
  await database!`
    update public.companion_v3_instances instance set
      desired_lifecycle='prepare', lifecycle_state='active', preparation_checkpoint='prepared',
      box_ready_at=coalesce(instance.box_ready_at, now() - interval '3 seconds'),
      staging_completed_at=now() - interval '2 seconds',
      pi_invocation_id=coalesce(instance.pi_invocation_id, ${`pi-${input.companionId}`}),
      prepared_at=now() - interval '1 second', preparation_actor_id=${input.actorId},
      preparation_settings_revision=instance.desired_settings_revision,
      preparation_skills_revision=${input.skillsRevision ?? 1},
      pi_recycle_checkpoint=null, recycle_pi_invocation_id=null, recovery_turn_id=null,
      preparation_model_id='claude-test',
      preparation_provider_refs=(select jsonb_agg(jsonb_build_object(
        'provider_id', connection.provider_id,
        'credential_generation', connection.credential_generation,
        'credential_version', connection.credential_version
      ) order by connection.provider_id)
      from public.companion_provider_connections connection
      where connection.org_id=${ids.org}::uuid and connection.provider_id='anthropic'),
      preparation_skill_refs=${database!.json(input.skillRefs ?? [])},
      preparation_mcp_refs=${database!.json(input.mcpRefs ?? [])},
      prepared_disk_layout_version=14, prepared_skills_digest=${"a".repeat(64)},
      prepared_material_expires_at=now() + interval '6 hours'
    where instance.org_id=${ids.org}::uuid and instance.companion_id=${input.companionId}::uuid
  `;
}

async function authorize(orgId: string, companionId: string, actorId: string) {
  const rows = await runtime!<AuthorizationRow[]>`
    select authorized, denial_code as "denialCode", box_id as "boxId",
      box_state::text as "boxState", runtime_generation::text as "runtimeGeneration"
    from public.companion_runtime_authorize_desktop(
      ${orgId}::uuid, ${companionId}::uuid, ${actorId}
    )
  `;
  expect(rows).toHaveLength(1);
  return rows[0]!;
}

beforeAll(async () => {
  await adminSql.unsafe(`
    create role ${apiRole} login password '${rolePassword}' nosuperuser nobypassrls noinherit;
    create role ${workerRole} login password '${rolePassword}' nosuperuser nobypassrls noinherit;
    create role ${runtimeRole} login password '${rolePassword}' nosuperuser nobypassrls noinherit;
  `);
  await adminSql.unsafe(`create database "${databaseName}"`);
  database = postgres(databaseUrl.toString(), { max: 1 });
  const migrations = (await readdir(migrationsDir))
    .filter((name) => /^\d{4}_.+\.sql$/.test(name))
    .sort();
  const cutoverIndex = migrations.findIndex((name) => name.startsWith("0094_"));
  if (cutoverIndex < 0) throw new Error("Runtime v2 cutover migration is missing");
  for (const migration of migrations.slice(0, cutoverIndex)) {
    await applyMigrationFile(database, migration);
  }
  await applyRuntimeGrants(database);
  for (const migration of migrations.slice(cutoverIndex)) {
    await applyMigrationFile(database, migration);
  }
  await applyRuntimeGrants(database);

  for (const [actorId, name] of [
    [ids.owner, "Owner"], [ids.editor, "Editor"], [ids.viewer, "Viewer"],
    [ids.outsider, "Outsider"], [ids.otherOrgMember, "Other org member"],
  ] as const) {
    await database`
      insert into public."user"(id, name, email, email_verified)
      values (${actorId}, ${name}, ${`${actorId}@example.test`}, true)
    `;
  }
  await database`
    insert into public.organizations(id, name, slug, kind) values
      (${ids.org}::uuid, 'Desktop org', ${`desktop-${suffix}`}, 'team'),
      (${ids.otherOrg}::uuid, 'Other org', ${`desktop-other-${suffix}`}, 'team')
  `;
  await database`
    insert into public.memberships(org_id, user_id, org_role) values
      (${ids.org}::uuid, ${ids.owner}, 'owner'),
      (${ids.org}::uuid, ${ids.editor}, 'developer'),
      (${ids.org}::uuid, ${ids.viewer}, 'developer'),
      (${ids.otherOrg}::uuid, ${ids.otherOrgMember}, 'owner')
  `;
  await database`
    insert into public.companion_provider_connections(
      org_id, provider_id, auth_method, ciphertext, iv, auth_tag, wrapped_dek,
      wrap_iv, wrap_auth_tag, key_id, connected_by
    ) values (
      ${ids.org}::uuid, 'anthropic', 'api_key', 'ciphertext', 'iv', 'tag', 'dek',
      'wrap-iv', 'wrap-tag', 'key', ${ids.owner}
    )
  `;
  await database`
    insert into public.companion_mcp_accounts(
      id, org_id, owner_id, provider, label, transport, account_config, ciphertext,
      iv, auth_tag, wrapped_dek, wrap_iv, wrap_auth_tag, key_id
    ) values (
      ${ids.editorMcpAccount}::uuid, ${ids.org}::uuid, ${ids.editor}, 'linear', 'work',
      'http', '{}'::jsonb, 'ciphertext', 'iv', 'tag', 'dek', 'wrap-iv', 'wrap-tag', 'key'
    )
  `;
  await database`
    insert into public.skills(id, org_id, slug, display_name, description, creator_id, scope)
    values (${ids.ownerSkill}::uuid, ${ids.org}::uuid, ${`desktop-owner-${suffix}`},
      'Owner desktop Skill', 'Personal authorization fixture', ${ids.owner}, 'personal')
  `;
  await database`
    insert into public.skill_versions(
      id, org_id, skill_id, version, frontmatter, tools, size_bytes,
      checksum, storage_path, validation, created_by
    ) values (
      ${ids.ownerSkillVersion}::uuid, ${ids.org}::uuid, ${ids.ownerSkill}::uuid, '1.0.0',
      'name: owner-desktop-skill', '[]'::jsonb, 42, ${`sha256:${"b".repeat(64)}`},
      ${`skills/${ids.ownerSkillVersion}.tar.gz`}, 'valid', ${ids.owner}
    )
  `;
  await database`update public.skills set current_version_id=${ids.ownerSkillVersion}::uuid
    where org_id=${ids.org}::uuid and id=${ids.ownerSkill}::uuid`;
  await prepareCompanion({
    companionId: ids.ownerCompanion,
    actorId: ids.owner,
    boxId: "bx_23456789",
  });
  await prepareCompanion({
    companionId: ids.editorCompanion,
    actorId: ids.editor,
    boxId: "bx_3456789a",
    selectedMcpAccountIds: [ids.editorMcpAccount],
  });
  await database`
    insert into public.companion_workspace_access(
      org_id, companion_id, owner_id, role, granted_by
    ) values
      (${ids.org}::uuid, ${ids.editorCompanion}::uuid, ${ids.owner}, 'editor', ${ids.owner}),
      (${ids.org}::uuid, ${ids.ownerCompanion}::uuid, ${ids.owner}, 'viewer', ${ids.owner})
  `;
  await database`
    update public.companion_runtime_control set enabled=true, enabled_at=now(), disabled_at=null
    where id='runtime-v3'
  `;
  runtime = postgres(runtimeUrl.toString(), { max: 1 });
}, 30_000);

afterAll(async () => {
  if (runtime) await runtime.end({ timeout: 1 });
  if (database) await database.end({ timeout: 1 });
  await adminSql.unsafe(`drop database if exists "${databaseName}" with (force)`);
  await adminSql.unsafe(`drop role if exists ${apiRole}, ${workerRole}, ${runtimeRole}`);
  await adminSql.end({ timeout: 1 });
});

describe("Runtime v3 desktop authorization migration", () => {
  it("authorizes only the actor-bound prepared Owner or Editor with v3 compatibility values", async () => {
    await expect(authorize(ids.org, ids.ownerCompanion, ids.owner)).resolves.toEqual({
      authorized: true,
      denialCode: null,
      boxId: "bx_23456789",
      boxState: "ready",
      runtimeGeneration: "1",
    });
    await expect(authorize(ids.org, ids.editorCompanion, ids.editor)).resolves.toEqual({
      authorized: true,
      denialCode: null,
      boxId: "bx_3456789a",
      boxState: "ready",
      runtimeGeneration: "1",
    });
  });

  it("fails closed without SQL exceptions for viewer, nonmember, cross-tenant, and revoked access", async () => {
    for (const [orgId, companionId, actorId] of [
      [ids.org, ids.ownerCompanion, ids.viewer],
      [ids.org, ids.ownerCompanion, ids.outsider],
      [ids.otherOrg, ids.ownerCompanion, ids.otherOrgMember],
    ] as const) {
      await expect(authorize(orgId, companionId, actorId)).resolves.toMatchObject({
        authorized: false,
        boxId: null,
      });
    }

    await database!`delete from public.companion_workspace_access
      where org_id=${ids.org}::uuid and companion_id=${ids.editorCompanion}::uuid`;
    await expect(authorize(ids.org, ids.editorCompanion, ids.editor)).resolves.toMatchObject({
      authorized: false,
      denialCode: "not_authorized",
    });
    await database!`insert into public.companion_workspace_access(
      org_id,companion_id,owner_id,role,granted_by
    ) values(
      ${ids.org}::uuid,${ids.editorCompanion}::uuid,${ids.owner},'editor',${ids.owner}
    )`;

  });

  it("fails an Editor's access to an Owner's selected personal Skill closed", async () => {
    await database!`update public.companions set
      selected_skill_ids=jsonb_build_array(${ids.ownerSkill}::text)
      where org_id=${ids.org}::uuid and id=${ids.editorCompanion}::uuid`;
    await restorePrepared({
      companionId: ids.editorCompanion,
      actorId: ids.editor,
      skillRefs: [{ skill_id: ids.ownerSkill, current_version_id: ids.ownerSkillVersion }],
    });
    await expect(authorize(ids.org, ids.editorCompanion, ids.editor)).resolves.toMatchObject({
      authorized: false,
      denialCode: "resource_access_revoked",
    });
    await database!`update public.companions set selected_skill_ids='[]'::jsonb
      where org_id=${ids.org}::uuid and id=${ids.editorCompanion}::uuid`;
    await restorePrepared({ companionId: ids.editorCompanion, actorId: ids.editor });
  });

  it("fails stale settings, required Skills, and revoked selected resources closed", async () => {
    await database!`update public.companion_v3_instances set desired_settings_revision=2
      where org_id=${ids.org}::uuid and companion_id=${ids.ownerCompanion}::uuid`;
    await expect(authorize(ids.org, ids.ownerCompanion, ids.owner)).resolves.toMatchObject({
      authorized: false,
      denialCode: "settings_not_applied",
    });

    await database!`update public.companion_v3_instances set desired_settings_revision=1
      where org_id=${ids.org}::uuid and companion_id=${ids.ownerCompanion}::uuid`;
    await database!`update public.companions set skills_revision=2, skills_available_revision=2
      where org_id=${ids.org}::uuid and id=${ids.ownerCompanion}::uuid`;
    await restorePrepared({ companionId: ids.ownerCompanion, actorId: ids.owner, skillsRevision: 1 });
    await expect(authorize(ids.org, ids.ownerCompanion, ids.owner)).resolves.toMatchObject({
      authorized: false,
      denialCode: "settings_not_applied",
    });

    const [mcpRef] = await database!<Array<{ ref: postgres.JSONValue }>>`
      select jsonb_build_object('account_id', account.id,
        'credential_generation', account.credential_generation,
        'credential_version', account.credential_version) as ref
      from public.companion_mcp_accounts account
      where account.id=${ids.editorMcpAccount}::uuid
    `;
    await database!`delete from public.companion_mcp_accounts
      where id=${ids.editorMcpAccount}::uuid`;
    await restorePrepared({
      companionId: ids.editorCompanion,
      actorId: ids.editor,
      mcpRefs: [mcpRef!.ref],
    });
    await expect(authorize(ids.org, ids.editorCompanion, ids.editor)).resolves.toMatchObject({
      authorized: false,
      denialCode: "resource_access_revoked",
    });
  });

  it("accepts a prepared Skills revision newer than the minimum required revision", async () => {
    await database!`update public.companions set skills_revision=1, skills_available_revision=2
      where org_id=${ids.org}::uuid and id=${ids.ownerCompanion}::uuid`;
    await restorePrepared({ companionId: ids.ownerCompanion, actorId: ids.owner, skillsRevision: 2 });
    await expect(authorize(ids.org, ids.ownerCompanion, ids.owner)).resolves.toMatchObject({
      authorized: true,
      boxState: "ready",
      runtimeGeneration: "1",
    });
  });

  it("fails a revoked prepared Editor membership closed", async () => {
    await database!`delete from public.memberships
      where org_id=${ids.org}::uuid and user_id=${ids.editor}`;
    await expect(authorize(ids.org, ids.editorCompanion, ids.editor)).resolves.toMatchObject({
      authorized: false,
      denialCode: "not_authorized",
    });
    await database!`insert into public.memberships(org_id,user_id,org_role)
      values(${ids.org}::uuid,${ids.editor},'developer')`;
  });

  it.each([
    ["unprepared", "prepare", "active", "box_ready"],
    ["archived", "archive", "archived", "prepared"],
    ["deleting", "delete", "delete_pending", "prepared"],
  ] as const)("fails a %s Box closed", async (_label, intent, lifecycleState, checkpoint) => {
    await restorePrepared({ companionId: ids.ownerCompanion, actorId: ids.owner, skillsRevision: 2 });
    if (checkpoint === "box_ready") {
      await database!`select public.companion_v3_invalidate_preparation(
        ${ids.org}::uuid, ${ids.ownerCompanion}::uuid)`;
    }
    await database!`update public.companion_v3_instances set
      desired_lifecycle=${intent}::public.companion_v3_lifecycle_intent,
      lifecycle_state=${lifecycleState}::public.companion_v3_lifecycle_state
      where org_id=${ids.org}::uuid and companion_id=${ids.ownerCompanion}::uuid`;
    await expect(authorize(ids.org, ids.ownerCompanion, ids.owner)).resolves.toMatchObject({
      authorized: false,
      denialCode: "box_unavailable",
      boxId: null,
    });
  });

  it("fails a Box undergoing Pi recycle closed", async () => {
    await restorePrepared({ companionId: ids.ownerCompanion, actorId: ids.owner, skillsRevision: 2 });
    await database!`update public.companion_v3_instances set
      pi_recycle_checkpoint='ready', recycle_pi_invocation_id=pi_invocation_id,
      recovery_turn_id=${randomUUID()}::uuid
      where org_id=${ids.org}::uuid and companion_id=${ids.ownerCompanion}::uuid`;
    await expect(authorize(ids.org, ids.ownerCompanion, ids.owner)).resolves.toMatchObject({
      authorized: false,
      denialCode: "box_unavailable",
      boxId: null,
    });
  });

  it("fails a Box with expired prepared material closed", async () => {
    await restorePrepared({ companionId: ids.ownerCompanion, actorId: ids.owner, skillsRevision: 2 });
    await database!`update public.companion_v3_instances set
      prepared_material_expires_at=now() - interval '1 second'
      where org_id=${ids.org}::uuid and companion_id=${ids.ownerCompanion}::uuid`;
    await expect(authorize(ids.org, ids.ownerCompanion, ids.owner)).resolves.toMatchObject({
      authorized: false,
      denialCode: "box_unavailable",
      boxId: null,
    });
  });
});
