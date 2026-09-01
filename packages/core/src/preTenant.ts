import { sql } from "drizzle-orm";
import type { Db } from "@companion/db";
import type { OrgRole } from "@companion/contracts";

/**
 * Narrow PostgreSQL RPCs for lookups that necessarily happen before an organization can be selected.
 *
 * The application login is deliberately NOBYPASSRLS. Calling tenant tables directly without
 * `app.org_id` would therefore return no rows for login, PAT/share/invite discovery or billing work
 * discovery. Each function below delegates only the minimum cross-tenant lookup to a SECURITY
 * DEFINER function installed by migration 0034. Bootstrap writes use an explicit tenant context and
 * ordinary RLS policies.
 */

type PreTenantQueryResult = Awaited<ReturnType<Db["execute"]>>;

function resultRows<T>(result: PreTenantQueryResult): T[] {
  // SAFETY: Each caller supplies the row contract for its fixed SQL function, and postgres-js
  // yields exactly those rows through the Drizzle execute result.
  return Array.from(result) as T[];
}

export interface PreTenantOrganizationRow {
  org_id: string;
  name: string;
  slug: string;
  kind: "personal" | "team";
  org_role: OrgRole;
  color: string | null;
  logo_url: string | null;
  member_count: number | string;
}

export async function listPreTenantOrganizations(database: Db, userId: string): Promise<PreTenantOrganizationRow[]> {
  const result = await database.execute(sql`
    select * from companion_list_user_orgs(${userId})
  `);
  return resultRows<PreTenantOrganizationRow>(result);
}

export async function preTenantUsersShareOrganization(
  database: Db,
  actorId: string,
  targetId: string,
): Promise<boolean> {
  const result = await database.execute(sql`
    select companion_users_share_org(${actorId}, ${targetId}) as shared
  `);
  return resultRows<{ shared: boolean }>(result)[0]?.shared ?? false;
}

export interface PreTenantJoinableOrganizationRow {
  org_id: string;
  name: string;
  domain: string;
  member_count: number | string;
}

export async function listPreTenantJoinableOrganizations(
  database: Db,
  userId: string,
): Promise<PreTenantJoinableOrganizationRow[]> {
  const result = await database.execute(sql`
    select * from companion_list_joinable_orgs(${userId})
  `);
  return resultRows<PreTenantJoinableOrganizationRow>(result);
}

export async function lockPreTenantInvitation(input: {
  database: Db;
  userId: string;
  token: string;
}): Promise<{ inviteId: string; orgId: string; orgRole: OrgRole } | null> {
  const result = await input.database.execute(sql`
    select
      invitation."invite_id"::text as "inviteId",
      invitation."org_id"::text as "orgId",
      invitation."org_role" as "orgRole"
    from companion_lock_invitation_for_actor(
      ${input.userId},
      ${input.token}
    ) as invitation
  `);
  return resultRows<{ inviteId: string; orgId: string; orgRole: OrgRole }>(result)[0] ?? null;
}

export interface PreTenantApiTokenRow {
  org_id: string;
  user_id: string;
  scopes: unknown;
  email: string;
  name: string;
  source_type: string;
  source_agent_id: string | null;
}

export async function resolvePreTenantApiToken(
  database: Db,
  tokenHash: string,
  targetWorkspaceId: string | null = null,
): Promise<PreTenantApiTokenRow | null> {
  const result = await database.execute(sql`
    select * from companion_resolve_api_token(${tokenHash}, ${targetWorkspaceId})
  `);
  return resultRows<PreTenantApiTokenRow>(result)[0] ?? null;
}

export interface PreTenantMcpBrokerTokenRow {
  org_id: string;
  companion_id: string;
  actor_id: string;
  account_refs: unknown;
}

/** Resolve only the hash-only runtime MCP capability before its tenant is known. */
export async function resolvePreTenantMcpBrokerToken(
  database: Db,
  tokenHash: string,
): Promise<PreTenantMcpBrokerTokenRow | null> {
  const result = await database.execute(sql`
    select * from companion_resolve_mcp_broker_token(${tokenHash})
  `);
  return resultRows<PreTenantMcpBrokerTokenRow>(result)[0] ?? null;
}

export interface PreTenantCompanionControlTokenRow {
  org_id: string;
  companion_id: string;
  actor_id: string;
  turn_id: string;
  attempt_id: string;
}

/** Resolve the loopback-only Companion control capability against the active acknowledged attempt. */
export async function resolvePreTenantCompanionControlToken(
  database: Db,
  tokenHash: string,
): Promise<PreTenantCompanionControlTokenRow | null> {
  const result = await database.execute(sql`
    select * from companion_resolve_control_token(${tokenHash})
  `);
  return resultRows<PreTenantCompanionControlTokenRow>(result)[0] ?? null;
}

export interface PreTenantRefreshableApiTokenRow {
  token_id: string;
  org_id: string;
  user_id: string;
  token_name: string;
  scopes: unknown;
  expires_at: string;
  is_expired: boolean;
}

/**
 * Lock a PAT for the dedicated refresh flow before a tenant is known.
 *
 * The SECURITY DEFINER function applies the fixed 30-day recovery window, rejects revoked tokens
 * and departed users, and never returns the token hash. Its row lock remains held by the caller's
 * transaction so only one concurrent request can replace an expired token.
 */
export async function lockPreTenantApiTokenForRefresh(
  database: Db,
  tokenHash: string,
): Promise<PreTenantRefreshableApiTokenRow | null> {
  const result = await database.execute(sql`
    select * from companion_lock_api_token_for_refresh(${tokenHash})
  `);
  return resultRows<PreTenantRefreshableApiTokenRow>(result)[0] ?? null;
}

export interface PreTenantSkillPreviewRow {
  slug: string;
  display_name: string | null;
  description: string;
  creator_name: string;
  creator_initials: string;
  current_version: string;
  frontmatter: string;
  updated_at: string;
  public_version: string | null;
  public_checksum: string | null;
  public_size_bytes: number | null;
  public_released_at: string | null;
}

export async function getPreTenantSkillPreview(
  database: Db,
  token: string,
): Promise<PreTenantSkillPreviewRow | null> {
  const result = await database.execute(sql`
    select * from companion_public_skill_preview(${token})
  `);
  return resultRows<PreTenantSkillPreviewRow>(result)[0] ?? null;
}

/** Exact immutable public package resolved before a tenant context is known. */
export interface PreTenantPublicSkillPackageRow {
  org_id: string;
  skill_id: string;
  skill_version_id: string;
  slug: string;
  version: string;
  storage_path: string;
  checksum: string;
  size_bytes: number;
}

/** Authorization also writes the tenant-owned audit entry inside the DB function. */
export async function authorizePreTenantPublicSkillPackage(
  database: Db,
  input: { token: string; version: string; userId: string; authKind?: "session" | "api_token" },
): Promise<PreTenantPublicSkillPackageRow | null> {
  const result = input.authKind === "api_token"
    ? await database.execute(sql`
        select * from companion_authorize_public_skill_package(
          ${input.token}, ${input.version}, ${input.userId}, 'api_token'
        )
      `)
    : await database.execute(sql`
        select * from companion_authorize_public_skill_package(${input.token}, ${input.version}, ${input.userId})
      `);
  return resultRows<PreTenantPublicSkillPackageRow>(result)[0] ?? null;
}

export interface PreTenantIssuedTransferTicketRow {
  ticket_id: string;
  org_id: string;
  skill_id: string;
  skill_version_id: string;
  version: string;
  checksum: string;
  size_bytes: number;
  expires_at: string;
}

/**
 * Persist only the hash of an Agent Auth transfer ticket. The caller has already authenticated and
 * authorized the delegated user/agent; the DB function revalidates the exact live public release.
 */
export async function issuePreTenantPublicSkillTransferTicket(
  database: Db,
  input: {
    token: string;
    version: string;
    userId: string;
    agentId: string;
    agentGrantId?: string | null;
    tokenHash: string;
    expiresAt: Date;
  },
): Promise<PreTenantIssuedTransferTicketRow | null> {
  const result = await database.execute(sql`
    select * from companion_issue_public_skill_transfer_ticket(
      ${input.token}, ${input.version}, ${input.userId}, ${input.agentId},
      ${input.agentGrantId ?? null}, ${input.tokenHash},
      ${input.expiresAt.toISOString()}::timestamp with time zone
    )
  `);
  return resultRows<PreTenantIssuedTransferTicketRow>(result)[0] ?? null;
}

export interface PreTenantConsumedTransferTicketRow extends PreTenantPublicSkillPackageRow {
  user_id: string;
  agent_id: string;
  agent_grant_id: string | null;
}

/** Atomically claim a one-use ticket and revalidate release/checksum/size at consumption time. */
export async function consumePreTenantPublicSkillTransferTicket(
  database: Db,
  input: { tokenHash: string; token: string; version: string },
): Promise<PreTenantConsumedTransferTicketRow | null> {
  const result = await database.execute(sql`
    select * from companion_consume_public_skill_transfer_ticket(
      ${input.tokenHash}, ${input.token}, ${input.version}
    )
  `);
  return resultRows<PreTenantConsumedTransferTicketRow>(result)[0] ?? null;
}

export type PreTenantSkillTransferAction =
  | "skill_package.download"
  | "skill_file.download"
  | "skill_package.upload"
  | "local_skill.download";

export interface PreTenantConsumedSkillTransferTicketRow {
  ticket_id: string;
  org_id: string;
  user_id: string;
  user_email: string;
  user_name: string;
  agent_id: string;
  agent_grant_id: string | null;
  action: PreTenantSkillTransferAction;
  skill_id: string | null;
  skill_version_id: string | null;
  skill_slug: string;
  version: string;
  file_path: string | null;
  checksum: string;
  size_bytes: number;
  expires_at: string;
}

/**
 * Atomically claim a private skill package/file transfer ticket before a tenant is known. The database function
 * checks the exact request binding and live membership; callers must still re-enter Core under the
 * returned tenant/user context to revalidate resource-level visibility or publish authorization.
 */
export async function consumePreTenantSkillTransferTicket(
  database: Db,
  input: {
    tokenHash: string;
    action: PreTenantSkillTransferAction;
    slug: string;
    version: string;
    checksum?: string | null;
    sizeBytes?: number | null;
    filePath?: string | null;
  },
): Promise<PreTenantConsumedSkillTransferTicketRow | null> {
  const result = await database.execute(sql`
    select * from companion_consume_agent_transfer_ticket(
      ${input.tokenHash}, ${input.action}, ${input.slug}, ${input.version},
      ${input.checksum ?? null}, ${input.sizeBytes ?? null}, ${input.filePath ?? null}
    )
  `);
  return resultRows<PreTenantConsumedSkillTransferTicketRow>(result)[0] ?? null;
}

/** Check a ticket's cheap mutable bindings before accepting a large upload body. */
export async function preflightPreTenantAgentTransferTicket(
  database: Db,
  input: {
    tokenHash: string;
    action: PreTenantSkillTransferAction;
    slug: string;
    version: string;
  },
): Promise<boolean> {
  const result = await database.execute(sql`
    select companion_preflight_agent_transfer_ticket(
      ${input.tokenHash}, ${input.action}, ${input.slug}, ${input.version}
    ) as "authorized"
  `);
  return resultRows<{ authorized: boolean }>(result)[0]?.authorized ?? false;
}

/** Revoke every unconsumed ticket for an Agent Auth agent, or only one capability grant. */
export async function revokePreTenantAgentTransferTickets(
  database: Db,
  input: { userId: string; agentId: string; agentGrantId?: string | null },
): Promise<number> {
  const result = await database.execute(sql`
    select companion_revoke_agent_transfer_tickets(
      ${input.userId}, ${input.agentId}, ${input.agentGrantId ?? null}
    ) as "count"
  `);
  return Number(resultRows<{ count: number | string }>(result)[0]?.count ?? 0);
}

/** Recheck the live Agent Auth identity behind an already-consumed transfer ticket. */
export async function revalidatePreTenantAgentTransferTicket(
  database: Db,
  tokenHash: string,
): Promise<boolean> {
  const result = await database.execute(sql`
    select companion_revalidate_agent_transfer_ticket(${tokenHash}) as "authorized"
  `);
  return resultRows<{ authorized: boolean }>(result)[0]?.authorized ?? false;
}

export async function getPreTenantSkillShareTarget(
  database: Db,
  token: string,
  userId: string,
): Promise<{ org_id: string; slug: string } | null> {
  const result = await database.execute(sql`
    select target."org_id"::text as "org_id", target."slug"
    from companion_skill_share_target(${token}, ${userId}) as target
  `);
  return resultRows<{ org_id: string; slug: string }>(result)[0] ?? null;
}

export async function resolvePreTenantBillingOrganization(
  database: Db,
  input: { subscriptionId?: string | null; customerId?: string | null },
): Promise<string | null> {
  const result = await database.execute(sql`
    select companion_billing_org_for_stripe_event(
      ${input.subscriptionId ?? null},
      ${input.customerId ?? null}
    )::text as "orgId"
  `);
  return resultRows<{ orgId: string | null }>(result)[0]?.orgId ?? null;
}

export async function listPreTenantBillingSyncCandidates(
  database: Db,
  input: { now: Date; full: boolean; limit: number },
): Promise<string[]> {
  const result = await database.execute(sql`
    select candidate."org_id"::text as "orgId"
    from companion_list_billing_sync_candidates(
      ${input.now.toISOString()}::timestamptz,
      ${input.full},
      ${input.limit}
    ) as candidate
  `);
  return resultRows<{ orgId: string }>(result).map((row) => row.orgId);
}
