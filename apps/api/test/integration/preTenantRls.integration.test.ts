/**
 * Product promise:
 * Companion runs with a NOBYPASSRLS login and exposes only narrow identity-discovery operations
 * before an organization is selected.
 *
 * Regression caught:
 * Deployments previously needed an owner/superuser connection for login, PAT, invite, share, avatar,
 * billing, and domain discovery paths.
 *
 * Why this test is integrated:
 * The boundary depends on real PostgreSQL role attributes, grants, forced RLS, and definer functions.
 *
 * Failure proof:
 * Removing a required narrow grant or allowing direct tenant-table visibility must fail this suite.
 */
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { postgresAgentAuthStorage } from "@companion/auth";
import { extractRuntimeRoleGrantBlock, resolveRuntimeRoleGrantsFile } from "../../src/migrate";

const databaseUrl = process.env.DATABASE_MIGRATION_URL
  ?? process.env.DATABASE_URL;
if (!databaseUrl?.trim()) {
  throw new Error("pre-tenant RLS integration tests require an explicit disposable DATABASE_URL");
}

describe("pre-tenant PostgreSQL RLS boundary", () => {
  const sql = postgres(databaseUrl, { max: 4 });
  const suffix = randomUUID();
  const orgA = randomUUID();
  const orgB = randomUUID();
  const skillId = randomUUID();
  const versionId = randomUUID();
  const owner = {
    id: `pre-tenant-owner-${suffix}`,
    email: `owner-${suffix}@acme.test`,
  };
  const colleague = {
    id: `pre-tenant-colleague-${suffix}`,
    email: `colleague-${suffix}@acme.test`,
  };
  const outsider = {
    id: `pre-tenant-outsider-${suffix}`,
    email: `outsider-${suffix}@other.test`,
  };
  const roleSuffix = suffix.replaceAll("-", "").slice(0, 16);
  const apiRole = `companion_pretenant_api_${roleSuffix}`;
  const workerRole = `companion_pretenant_worker_${roleSuffix}`;
  const companionRuntimeRole = `companion_pretenant_runtime_${roleSuffix}`;
  const processRoles = [apiRole, workerRole, companionRuntimeRole];
  const rlsPassword = `pretenant-${suffix}`;
  const rlsUrl = new URL(databaseUrl);
  rlsUrl.username = apiRole;
  rlsUrl.password = rlsPassword;
  let runtimeRoleSql: ReturnType<typeof postgres> | undefined;
  const invitationToken = `invite-${suffix}`;
  const apiTokenHash = `hash-${suffix}`;
  const expiredRefreshHash = `expired-refresh-${suffix}`;
  const staleRefreshHash = `stale-refresh-${suffix}`;
  const revokedRefreshHash = `revoked-refresh-${suffix}`;
  const shareToken = `share-${suffix}`;

  async function withRuntimeRole<T>(fn: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> {
    if (!runtimeRoleSql) throw new Error("pre-tenant runtime role is not initialized");
    const result = await runtimeRoleSql.begin(fn);
    // SAFETY: postgres.begin preserves the callback's generic result but its declaration widens it.
    return result as T;
  }

  beforeAll(async () => {
    await sql`
      insert into "user" (id, name, email, email_verified)
      values
        (${owner.id}, 'Pre-tenant Owner', ${owner.email}, true),
        (${colleague.id}, 'Pre-tenant Colleague', ${colleague.email}, true),
        (${outsider.id}, 'Pre-tenant Outsider', ${outsider.email}, true)
    `;
    await sql`
      insert into profiles (id, email, name, initials, avatar_url)
      values
        (${owner.id}, ${owner.email}, 'Pre-tenant Owner', 'PO', '/v1/users/owner/avatar'),
        (${colleague.id}, ${colleague.email}, 'Pre-tenant Colleague', 'PC', '/v1/users/colleague/avatar'),
        (${outsider.id}, ${outsider.email}, 'Pre-tenant Outsider', 'PX', '/v1/users/outsider/avatar')
    `;
    await sql`
      insert into organizations (id, name, slug, kind)
      values
        (${orgA}::uuid, 'Pre-tenant A', ${`pre-tenant-a-${suffix}`}, 'team'),
        (${orgB}::uuid, 'Pre-tenant B', ${`pre-tenant-b-${suffix}`}, 'team')
    `;
    await sql`
      insert into memberships (org_id, user_id, org_role)
      values
        (${orgA}::uuid, ${owner.id}, 'owner'),
        (${orgA}::uuid, ${colleague.id}, 'developer'),
        (${orgB}::uuid, ${outsider.id}, 'owner')
    `;
    await sql`
      insert into organization_domains (org_id, domain, created_by)
      values (${orgB}::uuid, 'acme.test', ${outsider.id})
    `;
    await sql`
      insert into billing_subscriptions
        (org_id, stripe_customer_id, stripe_subscription_id, stripe_subscription_item_id,
         stripe_status, synced_quantity, seat_sync_status, seat_sync_requested_at, next_retry_at, last_reconciled_at)
      values
        (${orgA}::uuid, ${`cus-a-${suffix}`}, ${`sub-a-${suffix}`}, ${`item-a-${suffix}`},
         'active', 1, 'pending', clock_timestamp() - interval '1 minute', clock_timestamp() - interval '1 second', null),
        (${orgB}::uuid, ${`cus-b-${suffix}`}, ${`sub-b-${suffix}`}, ${`item-b-${suffix}`},
         'active', 1, 'synced', null, null, clock_timestamp())
    `;
    await sql`
      insert into invitations (org_id, email, org_role, token, created_by, expires_at)
      values (
        ${orgB}::uuid,
        ${owner.email},
        'developer',
        ${invitationToken},
        ${outsider.id},
        clock_timestamp() + interval '1 day'
      )
    `;
    await sql`
      insert into api_tokens (org_id, user_id, name, token_prefix, token_hash, scopes, expires_at)
      values
        (
          ${orgA}::uuid,
          ${owner.id},
          'Pre-tenant API token',
          'cmp_pat_test',
          ${apiTokenHash},
          '["skills:read"]'::jsonb,
          clock_timestamp() + interval '1 day'
        ),
        (
          ${orgA}::uuid,
          ${owner.id},
          'Expired refreshable token',
          'cmp_pat_expire',
          ${expiredRefreshHash},
          '["skills:read","skills:write"]'::jsonb,
          clock_timestamp() - interval '1 day'
        ),
        (
          ${orgA}::uuid,
          ${owner.id},
          'Too-old token',
          'cmp_pat_stale',
          ${staleRefreshHash},
          '["skills:read"]'::jsonb,
          clock_timestamp() - interval '31 days'
        ),
        (
          ${orgA}::uuid,
          ${owner.id},
          'Revoked token',
          'cmp_pat_revoke',
          ${revokedRefreshHash},
          '["skills:read"]'::jsonb,
          clock_timestamp() - interval '1 day'
        )
    `;
    await sql`update api_tokens set revoked_at = clock_timestamp() where token_hash = ${revokedRefreshHash}`;
    await sql`
      insert into skills (id, org_id, slug, display_name, description, creator_id, scope, share_token)
      values (
        ${skillId}::uuid,
        ${orgA}::uuid,
        ${`pre-tenant-skill-${suffix}`},
        'Public SQL preview',
        'Public metadata only',
        ${owner.id},
        'org',
        ${shareToken}
      )
    `;
    await sql`
      insert into skill_versions
        (id, org_id, skill_id, version, frontmatter, body, size_bytes, checksum, storage_path, created_by)
      values (
        ${versionId}::uuid,
        ${orgA}::uuid,
        ${skillId}::uuid,
        '1.0.0',
        '{}',
        '',
        1,
        ${`sha256:${"a".repeat(64)}`},
        ${`${orgA}/pre-tenant/1.0.0.tar.gz`},
        ${owner.id}
      )
    `;
    await sql`
      update skills
      set current_version_id = ${versionId}::uuid,
          public_version_id = ${versionId}::uuid,
          public_package_checksum = ${`sha256:${"b".repeat(64)}`},
          public_package_size_bytes = 987,
          public_released_at = clock_timestamp()
      where org_id = ${orgA}::uuid and id = ${skillId}::uuid
    `;
    await sql`
      insert into agent_host (id, name, user_id, public_key, status)
      values
        ('host-agent-pretenant', 'Public pre-tenant host', ${outsider.id}, 'host-public-key', 'active'),
        ('host-agent-private-pretenant', 'Private pre-tenant host', ${owner.id}, 'host-private-key', 'active')
    `;
    await sql`
      insert into agent (id, name, user_id, host_id, status, mode, public_key)
      values
        ('agent-pretenant', 'Public pre-tenant agent', ${outsider.id}, 'host-agent-pretenant', 'active', 'delegated', 'agent-public-key'),
        ('agent-private-pretenant', 'Private pre-tenant agent', ${owner.id}, 'host-agent-private-pretenant', 'active', 'delegated', 'agent-private-key')
    `;
    await sql`
      insert into agent_capability_grant (id, agent_id, capability, granted_by, status, constraints)
      values
        ('grant-pretenant', 'agent-pretenant', 'public-skills:install', ${outsider.id}, 'active', null),
        (
          'grant-private-pretenant', 'agent-private-pretenant', 'skills:read', ${owner.id}, 'active',
          ${JSON.stringify({ workspaceId: { eq: orgA } })}
        )
    `;
    await sql.unsafe(`create role ${apiRole} login password '${rlsPassword}' nosuperuser nobypassrls noinherit`);
    await sql.unsafe(`create role ${workerRole} login nosuperuser nobypassrls noinherit`);
    await sql.unsafe(`create role ${companionRuntimeRole} login nosuperuser nobypassrls noinherit`);
    const grantsFile = await resolveRuntimeRoleGrantsFile();
    const grantBlock = extractRuntimeRoleGrantBlock(await readFile(grantsFile, "utf8"));
    await sql.begin(async (tx) => {
      await tx`select set_config('companion.api_role', ${apiRole}, true)`;
      await tx`select set_config('companion.worker_role', ${workerRole}, true)`;
      await tx`select set_config('companion.companion_runtime_role', ${companionRuntimeRole}, true)`;
      await tx.unsafe(grantBlock);
    });
    runtimeRoleSql = postgres(rlsUrl.toString(), { max: 4 });
  });

  afterAll(async () => {
    await runtimeRoleSql?.end({ timeout: 1 });
    await sql`delete from organizations where id in (${orgA}::uuid, ${orgB}::uuid)`;
    await sql`delete from "user" where id in (${owner.id}, ${colleague.id}, ${outsider.id})`;
    for (const role of processRoles) await sql.unsafe(`drop owned by ${role}`);
    for (const role of processRoles) await sql.unsafe(`drop role ${role}`);
    await sql.end();
  });

  it("uses a non-privileged role and keeps tenant tables invisible without GUCs", async () => {
    const attributes = await sql<{
      superuser: boolean;
      bypassRls: boolean;
      inherit: boolean;
      canLogin: boolean;
    }[]>`
      select
        rolsuper as superuser,
        rolbypassrls as "bypassRls",
        rolinherit as inherit,
        rolcanlogin as "canLogin"
      from pg_roles
      where rolname = any(${processRoles}::text[])
      order by rolname
    `;
    expect(attributes).toEqual(processRoles.map(() => ({
      superuser: false,
      bypassRls: false,
      inherit: false,
      canLogin: true,
    })));

    const result = await withRuntimeRole(async (tx) => {
      const context = await tx<{ orgId: string | null; userId: string | null }[]>`
        select
          current_setting('app.org_id', true) as "orgId",
          current_setting('app.user_id', true) as "userId"
      `;
      const counts = await tx<{
        organizations: number;
        memberships: number;
        invitations: number;
        apiTokens: number;
        skills: number;
        billing: number;
      }[]>`
        select
          (select count(*)::int from organizations) as organizations,
          (select count(*)::int from memberships) as memberships,
          (select count(*)::int from invitations) as invitations,
          (select count(*)::int from api_tokens) as "apiTokens",
          (select count(*)::int from skills) as skills,
          (select count(*)::int from billing_subscriptions) as billing
      `;
      return { context: context[0], counts: counts[0] };
    });

    expect(result).toEqual({
      context: { orgId: null, userId: null },
      counts: { organizations: 0, memberships: 0, invitations: 0, apiTokens: 0, skills: 0, billing: 0 },
    });
  });

  it("keeps API, worker, and runtime capabilities mutually exclusive", async () => {
    const [capabilities] = await sql<{
      apiOwnsApi: boolean;
      apiOwnsWorker: boolean;
      apiOwnsRuntime: boolean;
      workerOwnsApi: boolean;
      workerOwnsWorker: boolean;
      workerOwnsRuntime: boolean;
      runtimeOwnsApi: boolean;
      runtimeOwnsWorker: boolean;
      runtimeOwnsRuntime: boolean;
      apiReadsPrivateRuntime: boolean;
      workerReadsPrivateRuntime: boolean;
      runtimeReadsPrivateRuntime: boolean;
      apiReadsAuth: boolean;
      workerReadsAuth: boolean;
      runtimeReadsAuth: boolean;
    }[]>`
      select
        has_function_privilege(${apiRole}, 'public.companion_list_user_orgs(text)', 'EXECUTE') as "apiOwnsApi",
        has_function_privilege(${apiRole}, 'public.companion_claim_github_sync_destinations(text,integer,integer)', 'EXECUTE') as "apiOwnsWorker",
        has_function_privilege(${apiRole}, 'public.companion_runtime_get_material(uuid,uuid,uuid,bigint,bigint,text,public.companion_runtime_work_kind,uuid,integer)', 'EXECUTE') as "apiOwnsRuntime",
        has_function_privilege(${workerRole}, 'public.companion_list_user_orgs(text)', 'EXECUTE') as "workerOwnsApi",
        has_function_privilege(${workerRole}, 'public.companion_claim_github_sync_destinations(text,integer,integer)', 'EXECUTE') as "workerOwnsWorker",
        has_function_privilege(${workerRole}, 'public.companion_runtime_get_material(uuid,uuid,uuid,bigint,bigint,text,public.companion_runtime_work_kind,uuid,integer)', 'EXECUTE') as "workerOwnsRuntime",
        has_function_privilege(${companionRuntimeRole}, 'public.companion_list_user_orgs(text)', 'EXECUTE') as "runtimeOwnsApi",
        has_function_privilege(${companionRuntimeRole}, 'public.companion_claim_github_sync_destinations(text,integer,integer)', 'EXECUTE') as "runtimeOwnsWorker",
        has_function_privilege(${companionRuntimeRole}, 'public.companion_v3_runtime_claim_lifecycle(text,integer,integer)', 'EXECUTE') as "runtimeOwnsRuntime",
        has_table_privilege(${apiRole}, 'public.companion_turns', 'SELECT') as "apiReadsPrivateRuntime",
        has_table_privilege(${workerRole}, 'public.companion_turns', 'SELECT') as "workerReadsPrivateRuntime",
        has_table_privilege(${companionRuntimeRole}, 'public.companion_turns', 'SELECT') as "runtimeReadsPrivateRuntime",
        has_table_privilege(${apiRole}, 'public.user', 'SELECT') as "apiReadsAuth",
        has_table_privilege(${workerRole}, 'public.user', 'SELECT') as "workerReadsAuth",
        has_table_privilege(${companionRuntimeRole}, 'public.user', 'SELECT') as "runtimeReadsAuth"
    `;

    expect(capabilities).toEqual({
      apiOwnsApi: true,
      apiOwnsWorker: false,
      apiOwnsRuntime: false,
      workerOwnsApi: false,
      workerOwnsWorker: true,
      workerOwnsRuntime: false,
      runtimeOwnsApi: false,
      runtimeOwnsWorker: false,
      runtimeOwnsRuntime: true,
      apiReadsPrivateRuntime: false,
      workerReadsPrivateRuntime: false,
      runtimeReadsPrivateRuntime: false,
      apiReadsAuth: true,
      workerReadsAuth: false,
      runtimeReadsAuth: false,
    });
  });

  it("discovers only the actor's organizations and matching joinable domain", async () => {
    const result = await withRuntimeRole(async (tx) => {
      const organizations = await tx<{ orgId: string; name: string; role: string; memberCount: number }[]>`
        select
          org_id::text as "orgId",
          name,
          org_role::text as role,
          member_count::int as "memberCount"
        from companion_list_user_orgs(${owner.id})
      `;
      const joinable = await tx<{ orgId: string; name: string; domain: string; memberCount: number }[]>`
        select
          org_id::text as "orgId",
          name,
          domain,
          member_count::int as "memberCount"
        from companion_list_joinable_orgs(${owner.id})
      `;
      return { organizations, joinable };
    });

    expect(result.organizations).toEqual([
      { orgId: orgA, name: "Pre-tenant A", role: "owner", memberCount: 2 },
    ]);
    expect(result.joinable).toEqual([
      { orgId: orgB, name: "Pre-tenant B", domain: "acme.test", memberCount: 1 },
    ]);
  });

  it("locks a valid invitation while hiding wrong actors and unknown tokens identically", async () => {
    const result = await withRuntimeRole(async (tx) => {
      const valid = await tx<{ orgId: string; role: string }[]>`
        select org_id::text as "orgId", org_role::text as role
        from companion_lock_invitation_for_actor(${owner.id}, ${invitationToken})
      `;
      const wrongActor = await tx<{ orgId: string }[]>`
        select org_id::text as "orgId"
        from companion_lock_invitation_for_actor(${colleague.id}, ${invitationToken})
      `;
      const unknownToken = await tx<{ orgId: string }[]>`
        select org_id::text as "orgId"
        from companion_lock_invitation_for_actor(${owner.id}, ${`missing-${suffix}`})
      `;
      return { valid, wrongActor, unknownToken };
    });

    expect(result.valid).toEqual([{ orgId: orgB, role: "developer" }]);
    expect(result.wrongActor).toEqual([]);
    expect(result.unknownToken).toEqual(result.wrongActor);
  });

  it("resolves an active PAT and updates last_used_at without exposing the hash", async () => {
    const before = await sql<{ used: boolean }[]>`
      select last_used_at is not null as used from api_tokens where token_hash = ${apiTokenHash}
    `;
    expect(before).toEqual([{ used: false }]);

    const resolved = await withRuntimeRole(async (tx) => {
      const legacy = await tx<{
        orgId: string;
        userId: string;
        email: string;
        name: string;
        scopes: string[];
      }[]>`
        select
          org_id::text as "orgId",
          user_id as "userId",
          email,
          name,
          scopes
        from companion_resolve_api_token(${apiTokenHash})
      `;
      const targetAware = await tx<{
        orgId: string;
        userId: string;
        email: string;
        name: string;
        scopes: string[];
      }[]>`
        select
          org_id::text as "orgId",
          user_id as "userId",
          email,
          name,
          scopes
        from companion_resolve_api_token(${apiTokenHash}, null)
      `;
      return { legacy, targetAware };
    });

    const expected = [{
      orgId: orgA,
      userId: owner.id,
      email: owner.email,
      name: "Pre-tenant Owner",
      scopes: ["skills:read"],
    }];
    expect(resolved.legacy).toEqual(expected);
    expect(resolved.targetAware).toEqual(expected);
    expect(JSON.stringify(resolved)).not.toContain(apiTokenHash);
    const after = await sql<{ used: boolean }[]>`
      select last_used_at is not null as used from api_tokens where token_hash = ${apiTokenHash}
    `;
    expect(after).toEqual([{ used: true }]);
  });

  it("exposes only refresh-eligible PAT metadata through the narrow pre-tenant lock", async () => {
    const result = await withRuntimeRole(async (tx) => {
      const active = await tx<{ tokenName: string; expired: boolean; scopes: string[] }[]>`
        select token_name as "tokenName", is_expired as expired, scopes
        from companion_lock_api_token_for_refresh(${apiTokenHash})
      `;
      const expired = await tx<{ tokenName: string; expired: boolean; scopes: string[] }[]>`
        select token_name as "tokenName", is_expired as expired, scopes
        from companion_lock_api_token_for_refresh(${expiredRefreshHash})
      `;
      const stale = await tx`
        select * from companion_lock_api_token_for_refresh(${staleRefreshHash})
      `;
      const revoked = await tx`
        select * from companion_lock_api_token_for_refresh(${revokedRefreshHash})
      `;
      const unknown = await tx`
        select * from companion_lock_api_token_for_refresh(${`unknown-${suffix}`})
      `;
      return { active, expired, stale, revoked, unknown };
    });

    expect(result.active).toEqual([{ tokenName: "Pre-tenant API token", expired: false, scopes: ["skills:read"] }]);
    expect(result.expired).toEqual([
      { tokenName: "Expired refreshable token", expired: true, scopes: ["skills:read", "skills:write"] },
    ]);
    expect(result.stale).toEqual([]);
    expect(result.revoked).toEqual([]);
    expect(result.unknown).toEqual(result.stale);
    expect(JSON.stringify(result)).not.toContain(expiredRefreshHash);
  });

  it("serves the narrow public preview and resolves a share target only for members", async () => {
    const result = await withRuntimeRole(async (tx) => {
      const preview = await tx<{
        slug: string;
        displayName: string | null;
        description: string;
        creatorName: string;
        creatorInitials: string;
        version: string;
      }[]>`
        select
          slug,
          display_name as "displayName",
          description,
          creator_name as "creatorName",
          creator_initials as "creatorInitials",
          current_version as version
        from companion_public_skill_preview(${shareToken})
      `;
      const memberTarget = await tx<{ orgId: string; slug: string }[]>`
        select org_id::text as "orgId", slug
        from companion_skill_share_target(${shareToken}, ${owner.id})
      `;
      const outsiderTarget = await tx<{ orgId: string; slug: string }[]>`
        select org_id::text as "orgId", slug
        from companion_skill_share_target(${shareToken}, ${outsider.id})
      `;
      return { preview, memberTarget, outsiderTarget };
    });

    expect(result.preview).toEqual([{
      slug: `pre-tenant-skill-${suffix}`,
      displayName: "Public SQL preview",
      description: "Public metadata only",
      creatorName: "Pre-tenant Owner",
      creatorInitials: "PO",
      version: "1.0.0",
    }]);
    expect(result.memberTarget).toEqual([{ orgId: orgA, slug: `pre-tenant-skill-${suffix}` }]);
    expect(result.outsiderTarget).toEqual([]);
  });

  it("authorizes exact public ZIP bytes and consumes delegated transfer tickets once without a tenant GUC", async () => {
    const ticketHash = "c".repeat(64);
    const result = await withRuntimeRole(async (tx) => {
      const sessionPackage = await tx<{ version: string; checksum: string; sizeBytes: number }[]>`
        select version, checksum, size_bytes::int as "sizeBytes"
        from companion_authorize_public_skill_package(${shareToken}, '1.0.0', ${outsider.id})
      `;
      const apiTokenPackage = await tx<{ version: string; checksum: string; sizeBytes: number }[]>`
        select version, checksum, size_bytes::int as "sizeBytes"
        from companion_authorize_public_skill_package(
          ${shareToken}, '1.0.0', ${outsider.id}, 'api_token'
        )
      `;
      const wrongVersion = await tx`
        select * from companion_authorize_public_skill_package(${shareToken}, '0.9.0', ${outsider.id})
      `;
      const issued = await tx<{ checksum: string; sizeBytes: number }[]>`
        select checksum, size_bytes::int as "sizeBytes"
        from companion_issue_public_skill_transfer_ticket(
          ${shareToken}, '1.0.0', ${outsider.id}, 'agent-pretenant', 'grant-pretenant',
          ${ticketHash}, clock_timestamp() + interval '30 seconds'
        )
      `;
      const first = await tx<{ version: string; checksum: string; sizeBytes: number }[]>`
        select version, checksum, size_bytes::int as "sizeBytes"
        from companion_consume_public_skill_transfer_ticket(${ticketHash}, ${shareToken}, '1.0.0')
      `;
      const replay = await tx`
        select * from companion_consume_public_skill_transfer_ticket(${ticketHash}, ${shareToken}, '1.0.0')
      `;
      const directlyVisible = await tx<{ count: number }[]>`
        select count(*)::int as count from agent_transfer_tickets
      `;
      return { sessionPackage, apiTokenPackage, wrongVersion, issued, first, replay, directlyVisible };
    });

    const transport = { version: "1.0.0", checksum: `sha256:${"b".repeat(64)}`, sizeBytes: 987 };
    expect(result.sessionPackage).toEqual([transport]);
    expect(result.apiTokenPackage).toEqual([transport]);
    expect(result.wrongVersion).toEqual([]);
    expect(result.issued).toEqual([{ checksum: transport.checksum, sizeBytes: 987 }]);
    expect(result.first).toEqual([transport]);
    expect(result.replay).toEqual([]);
    expect(result.directlyVisible).toEqual([{ count: 0 }]);

    const authorizationAudits = await sql<{ auth: string }[]>`
      select metadata->>'auth' as auth
      from audit_log
      where org_id = ${orgA}
        and actor_id = ${outsider.id}
        and action = 'skill.public_package.download_authorized'
    `;
    expect(authorizationAudits).toEqual(expect.arrayContaining([
      { auth: "session" },
      { auth: "api_token" },
    ]));
  });

  it("consumes a tenant skill transfer ticket through the narrow runtime grant and still hides its row", async () => {
    const ticketHash = "d".repeat(64);
    const checksum = `sha256:${"e".repeat(64)}`;
    await sql`
      insert into agent_transfer_tickets (
        org_id, user_id, agent_id, agent_grant_id, action, skill_id, skill_version_id,
        skill_slug, version, checksum, size_bytes, token_hash, expires_at
      ) values (
        ${orgA}::uuid, ${owner.id}, 'agent-private-pretenant', 'grant-private-pretenant',
        'skill_package.download', ${skillId}::uuid, ${versionId}::uuid,
        ${`pre-tenant-skill-${suffix}`}, '1.0.0', ${checksum}, 654,
        ${ticketHash}, clock_timestamp() + interval '30 seconds'
      )
    `;

    const result = await withRuntimeRole(async (tx) => {
      const first = await tx<{
        orgId: string;
        userId: string;
        action: string;
        slug: string;
        version: string;
        checksum: string;
        sizeBytes: number;
      }[]>`
        select org_id::text as "orgId", user_id as "userId", action,
               skill_slug as slug, version, checksum, size_bytes::int as "sizeBytes"
        from companion_consume_agent_transfer_ticket(
          ${ticketHash}, 'skill_package.download', ${`pre-tenant-skill-${suffix}`},
          '1.0.0', null, null
        )
      `;
      const replay = await tx`
        select * from companion_consume_agent_transfer_ticket(
          ${ticketHash}, 'skill_package.download', ${`pre-tenant-skill-${suffix}`},
          '1.0.0', null, null
        )
      `;
      const directlyVisible = await tx<{ count: number }[]>`
        select count(*)::int as count from agent_transfer_tickets where token_hash = ${ticketHash}
      `;
      return { first, replay, directlyVisible };
    });

    expect(result.first).toEqual([{
      orgId: orgA,
      userId: owner.id,
      action: "skill_package.download",
      slug: `pre-tenant-skill-${suffix}`,
      version: "1.0.0",
      checksum,
      sizeBytes: 654,
    }]);
    expect(result.replay).toEqual([]);
    expect(result.directlyVisible).toEqual([{ count: 0 }]);
  });

  it("atomically rejects a concurrent replay claim for the same Agent Auth JTI", async () => {
    const key = `agent-auth:jti:integration-${suffix}`;
    const claims = await Promise.allSettled([
      postgresAgentAuthStorage.set(key, "1", 60),
      postgresAgentAuthStorage.set(key, "1", 60),
    ]);
    expect(claims.map((claim) => claim.status).sort()).toEqual(["fulfilled", "rejected"]);
    await postgresAgentAuthStorage.delete(key);
  });

  it("removes the retired skill star storage", async () => {
    const [row] = await sql<{ tableName: string | null }[]>`
      select to_regclass('public.skill_stars')::text as "tableName"
    `;
    expect(row).toEqual({ tableName: null });
  });

  it("reveals only whether two users share an organization for avatar authorization", async () => {
    const result = await withRuntimeRole(async (tx) => tx<{
      shared: boolean;
      isolated: boolean;
      self: boolean;
    }[]>`
      select
        companion_users_share_org(${owner.id}, ${colleague.id}) as shared,
        companion_users_share_org(${owner.id}, ${outsider.id}) as isolated,
        companion_users_share_org(${owner.id}, ${owner.id}) as self
    `);

    expect(result).toEqual([{ shared: true, isolated: false, self: true }]);
  });

  it("resolves Stripe tenant correlation and scans due billing work without a tenant GUC", async () => {
    const apiResult = await withRuntimeRole(async (tx) => {
      const bySubscription = await tx<{ orgId: string | null }[]>`
        select companion_billing_org_for_stripe_event(${`sub-a-${suffix}`}, null)::text as "orgId"
      `;
      const byCustomer = await tx<{ orgId: string | null }[]>`
        select companion_billing_org_for_stripe_event(null, ${`cus-b-${suffix}`})::text as "orgId"
      `;
      const unknown = await tx<{ orgId: string | null }[]>`
        select companion_billing_org_for_stripe_event(${`missing-${suffix}`}, null)::text as "orgId"
      `;
      return { bySubscription, byCustomer, unknown };
    });
    const candidates = await sql.begin(async (tx) => {
      await tx.unsafe(`set local role ${workerRole}`);
      return tx<{ orgId: string }[]>`
        select org_id::text as "orgId"
        from companion_list_billing_sync_candidates(clock_timestamp(), false, 10)
      `;
    });

    expect({ ...apiResult, candidates }).toEqual({
      bySubscription: [{ orgId: orgA }],
      byCustomer: [{ orgId: orgB }],
      unknown: [{ orgId: null }],
      candidates: [{ orgId: orgA }],
    });
  });
});
