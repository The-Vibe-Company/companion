/* oxlint-disable anti-slop/no-conditional-empty-object-spread, anti-slop/no-known-value-widening, anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/no-unsafe-dictionary-type, anti-slop/no-chained-type-assertions, anti-slop/require-safety-comment-for-type-assertion -- This shared legacy service module predates the incremental anti-slop gate; the profile timezone path uses typed Drizzle fields and validated input. */
import { createHash, randomBytes } from "node:crypto";
import { and, asc, count, desc, eq, exists, gt, inArray, isNull, ne, not, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type {
  ApiTokenRow,
  DependencyPlan,
  LocalSkillStatus,
  OrgRole,
  OrgSettingsDomainJoin,
  OrgSettingsInvitation,
  OrgSettingsOrg,
  RenameSkillResult,
  SkillCommentImage,
  SkillCommentRow,
  SkillDependenciesResponse,
  SkillDependencyRow,
  SkillDependencyStatus,
  SkillDependentRow,
  SkillFilterPreferences,
  SkillFilterPreferencesInput,
  SkillListRow,
  SkillModifier,
  SkillPublicPreview,
  SkillPublicVersionResult,
  SkillSharePlan,
  SkillShareTarget,
  SkillVersionRow,
  TokenScope,
  RefreshTokenResponse,
} from "@companion/contracts";
import {
  API_TOKEN_PREFIX,
  COMMENT_IMAGE_MIME_TYPES,
  MAX_COMMENT_IMAGES,
  MAX_COMMENT_IMAGE_BYTES,
  companionManifestSchema,
  expandTokenScopes,
  fallbackCompanionManifest,
  parseAllowedTools,
  parseStoredSkillFrontmatter,
  publishSkillInputSchema,
  renameSkillInputSchema,
  skillFilterPreferencesInputSchema,
  skillFilterPreferencesSchema,
  tokenScopesSchema,
  tokenScopeSchema,
  userAvatarPublicPath,
  type CompanionManifest,
  type PublishSkillInput,
} from "@companion/contracts";
import { gravatarUrl, resolveUserAvatarUrl } from "./avatar";
import { isIanaTimeZone } from "./timezone";

import { compareSemver, isValidSemver } from "@companion/skills";
import { db, schema, type Db } from "@companion/db";
import { initialsFor, slugify } from "@companion/db/ids";
import { listOrgAccessDomains } from "./domainAccess";
import { classifyEmailDomain } from "./email-domains";
import { canManageOrg, canManagePersonalSkill, canManagePublicSkill, canTouchOwner, isLastOwner } from "./authz";
import { disableSecretsForDepartingMember, persistSkillSecretSlots } from "./secrets";
import { persistSkillDatabaseDeclarations } from "./skillDatabases";
import { recordGettingStartedStep } from "./gettingStarted";
import {
  assertOrgSkillMutationEntitled,
  assertPersonalSkillsEntitled,
  assertSkillHistoryEntitled,
  getEntitlements,
  markSeatSyncPending,
} from "./billing";
import {
  authorizePreTenantPublicSkillPackage,
  consumePreTenantSkillTransferTicket,
  consumePreTenantPublicSkillTransferTicket,
  getPreTenantSkillPreview,
  getPreTenantSkillShareTarget,
  issuePreTenantPublicSkillTransferTicket,
  listPreTenantOrganizations,
  lockPreTenantApiTokenForRefresh,
  lockPreTenantInvitation,
  preflightPreTenantAgentTransferTicket,
  preTenantUsersShareOrganization,
  revalidatePreTenantAgentTransferTicket,
  resolvePreTenantApiToken,
  revokePreTenantAgentTransferTickets,
  type PreTenantSkillTransferAction,
} from "./preTenant";

export * from "./secrets";
export * from "./githubSync";

// Org-wide shared label ("folder") services. Re-exported so callers keep importing everything from
// `@companion/core/services`. `labels.ts` imports `getOrgRole`/`ActorContext` from here (both hoisted
// / type-only), so the cycle is load-order safe.
export {
  listLabels,
  createLabel,
  addSublabel,
  assignLabel,
  unassignLabel,
  setLabelColor,
  setLabelIcon,
  renameLabel,
  deleteLabel,
} from "./labels";

// Per-user personal folder ("My Skills") services, mirroring the org-label set. Same load-order
// reasoning as `./labels`: `personalLabels.ts` only imports `getOrgRole`/`ActorContext` (hoisted /
// type-only) plus the pure tree helpers from `./labels`.
export {
  listPersonalLabels,
  createPersonalLabel,
  assignPersonalLabel,
  unassignPersonalLabel,
  setPersonalLabelColor,
  setPersonalLabelIcon,
  renamePersonalLabel,
  deletePersonalLabel,
} from "./personalLabels";

// Domain-driven onboarding services (create/join/context). Re-exported so callers keep importing
// everything from `@companion/core/services`. `onboarding.ts` only imports `uniqueSlug` (a hoisted
// function declaration) and the `ActorContext` type from here, so the cycle is load-order safe.
export * from "./onboarding";
export * from "./gettingStarted";
export {
  addOrgAccessDomain,
  listJoinableOrgsByDomain,
  listOrgAccessDomains,
  normalizeAccessDomain,
  orgAllowsEmailDomain,
  removeOrgAccessDomain,
} from "./domainAccess";

export interface ActorContext {
  id: string;
  email: string;
  name: string;
}

async function enqueueGitHubAfterOrgSkillMutation(database: Db, orgId: string): Promise<void> {
  await database.update(schema.githubSyncDestinations).set({
    desiredRevision: sql`${schema.githubSyncDestinations.desiredRevision} + 1`,
    status: sql`CASE WHEN ${schema.githubSyncDestinations.status} = 'syncing'::github_sync_status THEN 'syncing'::github_sync_status ELSE 'pending'::github_sync_status END`,
    nextRetryAt: null,
    updatedAt: new Date(),
  }).where(and(
    eq(schema.githubSyncDestinations.orgId, orgId),
    sql`${schema.githubSyncDestinations.status} <> 'disconnected'`,
  ));
}

export interface OrgSummary {
  org_id: string;
  name: string;
  slug: string;
  kind: "personal" | "team";
  org_role: OrgRole;
  member_count: number;
  color: string | null;
  logo_url: string | null;
}

export interface OrgSettingsMember {
  userId: string;
  role: OrgRole;
  joined: string;
  pending: boolean;
  inviteId?: string;
  inviteToken?: string;
  name: string;
  email: string;
  initials: string;
  /** Resolved avatar URL (custom upload or Gravatar); null falls back to initials. */
  avatarUrl: string | null;
}

export function uniqueSlug(base: string, suffix: string): string {
  return `${slugify(base)}-${suffix.slice(0, 8).toLowerCase()}`;
}

/**
 * Assert the actor is a member of `orgId`; returns their org role, or throws. Skills are flat —
 * every member may read/write every skill — so the visibility gate for skills collapses to
 * `eq(skills.orgId, orgId)` and membership is the only check. (Role still gates org governance.)
 */
export async function assertMember(database: Db, actor: ActorContext, orgId: string): Promise<OrgRole> {
  const role = await getOrgRole(orgId, actor.id, database);
  if (!role) throw new Error("not a member of this organization");
  return role;
}

/** True when an error is a Postgres unique-constraint violation (SQLSTATE 23505). */
function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "23505";
}

function parseStoredCompanionManifest(frontmatter: string, fallbackSummary: string): CompanionManifest {
  const legacy = parseStoredSkillFrontmatter(frontmatter);
  try {
    const raw = JSON.parse(frontmatter) as { companion?: unknown };
    const parsed = raw.companion ? companionManifestSchema.safeParse(raw.companion) : null;
    if (parsed?.success) {
      return fallbackCompanionManifest({
        summary: fallbackSummary,
        display: {
          ...parsed.data.display,
          description: parsed.data.display.description ?? (parsed.data.notes ? undefined : legacy?.description),
        },
        name: parsed.data.name,
        version: parsed.data.version,
        icon: parsed.data.icon,
        companionSkillId: parsed.data.metadata.companionSkillId,
        changelog: parsed.data.metadata.changelog,
        environment: parsed.data.environment,
        database: parsed.data.database,
        notes: parsed.data.notes,
        requirements: parsed.data.requirements,
        dependencies: parsed.data.dependencies,
        commands: parsed.data.commands,
        checks: parsed.data.checks,
      });
    }
  } catch {
    // Fall back to legacy frontmatter fields below.
  }
  return fallbackCompanionManifest({
    summary: fallbackSummary,
    display: {
      description: legacy?.description,
    },
    requirements: legacy?.requirements ?? [],
  });
}

function skillDisplayWithOverride(
  display: CompanionManifest["display"],
  displayName: string | null | undefined,
): CompanionManifest["display"] {
  return displayName ? { ...display, name: displayName } : display;
}

/**
 * Ensure the user has a `profiles` row. Membership is NOT created here: brand-new users have no
 * org and complete the domain-driven onboarding flow (create or join) instead — see `onboarding.ts`.
 * (The legacy "first user owns the seeded Acme org" bootstrap was removed in favor of onboarding.)
 */
export async function ensureUserBootstrap(actor: ActorContext, database: Db = db): Promise<void> {
  await database
    .insert(schema.profiles)
    .values({
      id: actor.id,
      email: actor.email,
      name: actor.name || actor.email,
      initials: initialsFor(actor.name || actor.email),
      handle: actor.email.split("@")[0] ?? null,
    })
    .onConflictDoNothing();
}

/**
 * Read and update self-service profile data shared by every workspace and first-party client.
 * `profiles` carries no RLS (it is keyed by the auth user id), so these run on the plain `db`
 * handle like `ensureUserBootstrap`. The REST route separately syncs Better Auth when name changes.
 */
export async function getUserTimezone(input: {
  actor: ActorContext;
  database?: Db;
}): Promise<string | null> {
  const database = input.database ?? db;
  await ensureUserBootstrap(input.actor, database);
  const profile = await database.query.profiles.findFirst({
    columns: { timezone: true },
    where: eq(schema.profiles.id, input.actor.id),
  });
  return profile?.timezone ?? null;
}

export async function updateUserProfile(input: {
  actor: ActorContext;
  name?: string;
  timezone?: string;
  database?: Db;
}): Promise<{ id: string; name: string; initials: string; timezone: string | null }> {
  const database = input.database ?? db;
  if (input.name === undefined && input.timezone === undefined) {
    throw new Error("a profile field is required");
  }
  const name = input.name?.trim();
  if (input.name !== undefined && !name) throw new Error("name is required");
  const timezone = input.timezone?.trim();
  if (input.timezone !== undefined && (!timezone || !isIanaTimeZone(timezone))) {
    throw new Error("timezone must be a valid IANA timezone");
  }
  await ensureUserBootstrap(input.actor, database);
  const patch: Partial<typeof schema.profiles.$inferInsert> = { updatedAt: new Date() };
  if (name !== undefined) {
    patch.name = name;
    patch.initials = initialsFor(name);
  }
  if (timezone !== undefined) patch.timezone = timezone;
  const [profile] = await database
    .update(schema.profiles)
    .set(patch)
    .where(eq(schema.profiles.id, input.actor.id))
    .returning({
      id: schema.profiles.id,
      name: schema.profiles.name,
      initials: schema.profiles.initials,
      timezone: schema.profiles.timezone,
    });
  if (!profile) throw new Error("profile not found");
  return profile;
}

export async function listOrgs(actor: ActorContext, database: Db = db): Promise<OrgSummary[]> {
  await ensureUserBootstrap(actor, database);
  const rows = await listPreTenantOrganizations(database, actor.id);
  return rows.map((row) => ({
    ...row,
    member_count: Number(row.member_count),
  }));
}

export async function getOrgRole(orgId: string, userId: string, database: Db = db): Promise<OrgRole | null> {
  const row = await database.query.memberships.findFirst({
    where: and(eq(schema.memberships.orgId, orgId), eq(schema.memberships.userId, userId)),
  });
  return (row?.orgRole as OrgRole | undefined) ?? null;
}

export async function createOrg(input: {
  actor: ActorContext;
  name: string;
  kind: "personal" | "team";
  database?: Db;
}): Promise<{ id: string; slug: string }> {
  const database = input.database ?? db;
  await ensureUserBootstrap(input.actor, database);
  const id = crypto.randomUUID();
  const slug = uniqueSlug(input.name, crypto.randomUUID());
  return database.transaction(async (tx) => {
    await tx.execute(
      sql`select set_config('app.org_id', ${id}, true), set_config('app.user_id', ${input.actor.id}, true)`,
    );
    const [org] = await tx
      .insert(schema.organizations)
      .values({ id, name: input.name, slug, kind: input.kind })
      .returning({ id: schema.organizations.id, slug: schema.organizations.slug });
    if (!org) throw new Error("could not create organization");
    await tx.insert(schema.memberships).values({ orgId: org.id, userId: input.actor.id, orgRole: "owner" });
    return org;
  });
}

/**
 * Rename, re-slug, and/or edit branding for the current organization. Requires an org admin
 * (`canManageOrg`). Domain access is managed separately through `organization_domains`.
 */
export async function updateOrg(input: {
  actor: ActorContext;
  orgId: string;
  name?: string;
  slug?: string;
  color?: string | null;
  logoUrl?: string | null;
  skillNamingPolicy?: string | null;
  database?: Db;
}): Promise<{
  id: string;
  name: string;
  slug: string;
  domain: string | null;
  domainAutoJoin: boolean;
  color: string | null;
  logoUrl: string | null;
  skillNamingPolicy: string | null;
}> {
  const database = input.database ?? db;
  const role = await getOrgRole(input.orgId, input.actor.id, database);
  if (!role || !canManageOrg(role)) throw new Error("not allowed to update this organization");

  const orgRow = await database.query.organizations.findFirst({
    where: eq(schema.organizations.id, input.orgId),
  });
  if (!orgRow) throw new Error("organization not found");

  const patch: {
    name?: string;
    slug?: string;
    color?: string | null;
    logoUrl?: string | null;
    skillNamingPolicy?: string | null;
    updatedAt: Date;
  } = { updatedAt: new Date() };
  if (input.name !== undefined) {
    const name = input.name.trim();
    if (!name) throw new Error("name is required");
    patch.name = name;
  }
  if (input.slug !== undefined) {
    const slug = slugify(input.slug);
    const conflict = await database.query.organizations.findFirst({
      where: and(eq(schema.organizations.slug, slug), ne(schema.organizations.id, input.orgId)),
    });
    if (conflict) throw new Error("that workspace URL is already taken");
    patch.slug = slug;
  }
  if (input.color !== undefined) {
    patch.color = input.color;
  }
  if (input.logoUrl !== undefined) {
    patch.logoUrl = input.logoUrl;
  }
  if (input.skillNamingPolicy !== undefined) {
    // Empty/whitespace clears the policy (no policy for this org).
    const policy = input.skillNamingPolicy?.trim();
    patch.skillNamingPolicy = policy ? policy : null;
  }
  if (
    patch.name === undefined &&
    patch.slug === undefined &&
    patch.color === undefined &&
    patch.logoUrl === undefined &&
    patch.skillNamingPolicy === undefined
  ) {
    throw new Error("nothing to update");
  }

  let row;
  try {
    [row] = await database
      .update(schema.organizations)
      .set(patch)
      .where(eq(schema.organizations.id, input.orgId))
      .returning({
        id: schema.organizations.id,
        name: schema.organizations.name,
        slug: schema.organizations.slug,
        domain: schema.organizations.domain,
        domainAutoJoin: schema.organizations.domainAutoJoin,
        color: schema.organizations.color,
        logoUrl: schema.organizations.logoUrl,
        skillNamingPolicy: schema.organizations.skillNamingPolicy,
      });
  } catch (error) {
    if (isUniqueViolation(error)) throw new Error("that workspace URL is already taken");
    throw error;
  }
  if (!row) throw new Error("organization not found");
  return row;
}

/**
 * Read the org's skill-naming policy (the free-text prompt each org defines for itself). Any member
 * may read it, including via a personal access token — this is what the triage skill calls.
 */
export async function getSkillNamingPolicy(input: {
  actor: ActorContext;
  orgId: string;
  database?: Db;
}): Promise<string | null> {
  const database = input.database ?? db;
  const [row] = await database
    .select({ skillNamingPolicy: schema.organizations.skillNamingPolicy })
    .from(schema.memberships)
    .innerJoin(schema.organizations, eq(schema.organizations.id, schema.memberships.orgId))
    .where(and(eq(schema.memberships.orgId, input.orgId), eq(schema.memberships.userId, input.actor.id)));
  if (!row) throw new Error("not a member of this organization");
  return row.skillNamingPolicy ?? null;
}

export function orgLogoPublicPath(orgId: string): string {
  return `/v1/orgs/${orgId}/logo`;
}

/** Auth-checked serve path for a comment image attachment (carries the session cookie via the proxy). */
export function commentImagePublicPath(slug: string, commentId: string, imageId: string): string {
  return `/v1/skills/${encodeURIComponent(slug)}/comments/${commentId}/images/${imageId}`;
}

/**
 * Persist a hosted workspace logo URL after the binary has been stored. Requires an org admin.
 */
export async function setOrgLogoFromUpload(input: {
  actor: ActorContext;
  orgId: string;
  logoUrl: string;
  database?: Db;
}): Promise<{ id: string; name: string; slug: string; domain: string | null; domainAutoJoin: boolean; color: string | null; logoUrl: string | null }> {
  return updateOrg({ actor: input.actor, orgId: input.orgId, logoUrl: input.logoUrl, database: input.database });
}

/** Read access to a hosted workspace logo binary — any org member. */
export async function getOrgLogoAsset(input: {
  actor: ActorContext;
  orgId: string;
  database?: Db;
}): Promise<void> {
  const database = input.database ?? db;
  const role = await getOrgRole(input.orgId, input.actor.id, database);
  if (!role) throw new Error("not a member of this organization");
}

/**
 * Persist a custom user-avatar marker after its binary has been stored. Self-service: keyed by the
 * actor's own id. Bumping `updatedAt` rotates the `?v=` cache-bust baked into the serve path so every
 * surface re-fetches the new image. `profiles` carries no RLS (keyed by the auth user id), so this
 * runs on the plain `db` handle like `updateUserProfile`.
 */
export async function setUserAvatarFromUpload(input: {
  actor: ActorContext;
  database?: Db;
}): Promise<{ avatarUrl: string }> {
  const database = input.database ?? db;
  await ensureUserBootstrap(input.actor, database);
  const now = new Date();
  const path = userAvatarPublicPath(input.actor.id, now.getTime());
  await database
    .update(schema.profiles)
    .set({ avatarUrl: path, updatedAt: now })
    .where(eq(schema.profiles.id, input.actor.id));
  return { avatarUrl: path };
}

/** Remove a custom avatar, reverting to the user's Gravatar / colored initials. Self-service. */
export async function clearUserAvatar(input: {
  actor: ActorContext;
  database?: Db;
}): Promise<{ avatarUrl: string }> {
  const database = input.database ?? db;
  await ensureUserBootstrap(input.actor, database);
  await database
    .update(schema.profiles)
    .set({ avatarUrl: null, updatedAt: new Date() })
    .where(eq(schema.profiles.id, input.actor.id));
  return { avatarUrl: gravatarUrl(input.actor.email) };
}

/**
 * Authorization gate for reading a hosted user-avatar binary. Kept inside the tenant boundary:
 *  1. The binary is served only while the target's profile still marks a custom avatar, so a
 *     removed avatar cannot be fetched by a stale URL even if its storage object lingered after a
 *     failed best-effort delete.
 *  2. Cross-user reads require the actor to share at least one organization with the target (or be
 *     the target), mirroring the org-logo serve gate — defense-in-depth alongside RLS.
 */
export async function getUserAvatarAsset(input: {
  actor: ActorContext;
  userId: string;
  database?: Db;
}): Promise<void> {
  if (!input.actor?.id) throw new Error("authentication required");
  if (!input.userId) throw new Error("user id is required");
  const database = input.database ?? db;
  const profile = await database.query.profiles.findFirst({
    where: eq(schema.profiles.id, input.userId),
    columns: { avatarUrl: true },
  });
  if (!profile?.avatarUrl) throw new Error("avatar not found");
  if (input.userId === input.actor.id) return;
  if (!(await preTenantUsersShareOrganization(database, input.actor.id, input.userId))) {
    throw new Error("not authorized to view this avatar");
  }
}

/** Resolve the current actor's own avatar URL (custom upload or Gravatar) for `whoami`. */
export async function getMyAvatarUrl(input: {
  actor: ActorContext;
  database?: Db;
}): Promise<string> {
  const database = input.database ?? db;
  const profile = await database.query.profiles
    .findFirst({ where: eq(schema.profiles.id, input.actor.id) })
    .catch(() => null);
  return resolveUserAvatarUrl({
    userId: input.actor.id,
    email: input.actor.email,
    avatarUrl: profile?.avatarUrl ?? null,
    updatedAtEpoch: profile?.updatedAt instanceof Date ? profile.updatedAt.getTime() : 0,
  });
}

export async function getOrgSettings(input: {
  actor: ActorContext;
  orgId: string;
  database?: Db;
}): Promise<{
  org: OrgSettingsOrg;
  domainJoin: OrgSettingsDomainJoin;
  members: OrgSettingsMember[];
  invitations: OrgSettingsInvitation[];
}> {
  const database = input.database ?? db;
  const orgRole = await getOrgRole(input.orgId, input.actor.id, database);
  if (!orgRole) throw new Error("not a member of this organization");

  const { domain: actorDomain, isPersonal: actorDomainIsPersonal } = classifyEmailDomain(input.actor.email);
  const domainJoin: OrgSettingsDomainJoin = { actorDomain, actorDomainIsPersonal };

  const orgRow = await database.query.organizations.findFirst({
    where: eq(schema.organizations.id, input.orgId),
  });
  if (!orgRow) throw new Error("organization not found");
  const org: OrgSettingsOrg = {
    id: orgRow.id,
    name: orgRow.name,
    slug: orgRow.slug,
    kind: orgRow.kind,
    createdAt: orgRow.createdAt.toISOString(),
    domain: orgRow.domain,
    domainAutoJoin: orgRow.domainAutoJoin,
    accessDomains: await listOrgAccessDomains(input.orgId, database),
    color: orgRow.color,
    logoUrl: orgRow.logoUrl,
    skillNamingPolicy: orgRow.skillNamingPolicy,
  };

  const memberRows = await database
    .select({
      userId: schema.memberships.userId,
      role: schema.memberships.orgRole,
      joined: schema.memberships.createdAt,
      name: schema.profiles.name,
      email: schema.profiles.email,
      initials: schema.profiles.initials,
      avatarUrl: schema.profiles.avatarUrl,
      updatedAt: schema.profiles.updatedAt,
    })
    .from(schema.memberships)
    .innerJoin(schema.profiles, eq(schema.profiles.id, schema.memberships.userId))
    .where(eq(schema.memberships.orgId, input.orgId))
    .orderBy(asc(schema.memberships.createdAt));

  const members: OrgSettingsMember[] = memberRows.map((r) => ({
    userId: r.userId,
    role: r.role as OrgRole,
    joined: r.joined.toISOString(),
    pending: false,
    name: r.name,
    email: r.email,
    initials: r.initials,
    avatarUrl: resolveUserAvatarUrl({
      userId: r.userId,
      email: r.email,
      avatarUrl: r.avatarUrl ?? null,
      updatedAtEpoch: r.updatedAt instanceof Date ? r.updatedAt.getTime() : 0,
    }),
  }));

  // Admins additionally see pending invitations: folded into `members[]` (legacy, for the existing
  // Members UI) and surfaced as a clean `invitations[]` for the dedicated Invitations pane.
  const invitations: OrgSettingsInvitation[] = [];
  if (canManageOrg(orgRole)) {
    const inviteRows = await database
      .select({
        id: schema.invitations.id,
        email: schema.invitations.email,
        role: schema.invitations.orgRole,
        token: schema.invitations.token,
        status: schema.invitations.status,
        createdAt: schema.invitations.createdAt,
        expiresAt: schema.invitations.expiresAt,
      })
      .from(schema.invitations)
      .where(and(eq(schema.invitations.orgId, input.orgId), eq(schema.invitations.status, "pending")))
      .orderBy(asc(schema.invitations.createdAt));
    for (const invite of inviteRows) {
      const display = invite.email.split("@")[0] ?? invite.email;
      members.push({
        userId: `invite:${invite.id}`,
        role: invite.role as OrgRole,
        joined: invite.createdAt.toISOString(),
        pending: true,
        inviteId: invite.id,
        inviteToken: invite.token,
        name: display,
        email: invite.email,
        initials: initialsFor(display),
        // No account yet → no custom upload possible; Gravatar (or initials) only.
        avatarUrl: gravatarUrl(invite.email),
      });
      invitations.push({
        id: invite.id,
        email: invite.email,
        role: invite.role as OrgRole,
        token: invite.token,
        status: invite.status,
        createdAt: invite.createdAt.toISOString(),
        expiresAt: invite.expiresAt.toISOString(),
      });
    }
  }

  return { org, domainJoin, members, invitations };
}

export async function revokeInvitation(input: {
  actor: ActorContext;
  orgId: string;
  inviteId: string;
  database?: Db;
}): Promise<void> {
  const database = input.database ?? db;
  const role = await getOrgRole(input.orgId, input.actor.id, database);
  if (!role || !canManageOrg(role)) throw new Error("not allowed to revoke invites");
  await database
    .update(schema.invitations)
    .set({ status: "revoked" })
    .where(and(eq(schema.invitations.orgId, input.orgId), eq(schema.invitations.id, input.inviteId)));
}

async function ownerCount(orgId: string, database: Db): Promise<number> {
  const [row] = await database
    .select({ value: count() })
    .from(schema.memberships)
    .where(and(eq(schema.memberships.orgId, orgId), eq(schema.memberships.orgRole, "owner")));
  return Number(row?.value ?? 0);
}

export async function setMemberRole(input: {
  actor: ActorContext;
  orgId: string;
  userId: string;
  role: OrgRole;
  database?: Db;
}): Promise<void> {
  const database = input.database ?? db;
  const actorRole = await getOrgRole(input.orgId, input.actor.id, database);
  if (!actorRole || !canManageOrg(actorRole)) throw new Error("not allowed to change member roles");
  await database.execute(sql`select pg_advisory_xact_lock(hashtext(${`companion:org-owner:${input.orgId}`}))`);
  const target = await database.query.memberships.findFirst({
    where: and(eq(schema.memberships.orgId, input.orgId), eq(schema.memberships.userId, input.userId)),
  });
  if (!target) throw new Error("member not found");
  const targetRole = target.orgRole as OrgRole;
  if ((targetRole === "owner" || input.role === "owner") && !canTouchOwner(actorRole)) {
    throw new Error("only owners can change owner roles");
  }
  if (isLastOwner(await ownerCount(input.orgId, database), targetRole === "owner") && input.role !== "owner") {
    throw new Error("organization must keep at least one owner");
  }
  await database
    .update(schema.memberships)
    .set({ orgRole: input.role, updatedAt: new Date() })
    .where(and(eq(schema.memberships.orgId, input.orgId), eq(schema.memberships.userId, input.userId)));
}

export async function removeMember(input: {
  actor: ActorContext;
  orgId: string;
  userId: string;
  database?: Db;
}): Promise<void> {
  const database = input.database ?? db;
  await database.transaction(async (transaction) => {
    const tx = transaction as unknown as Db;
    const actorRole = await getOrgRole(input.orgId, input.actor.id, tx);
    if (!actorRole || !canManageOrg(actorRole)) throw new Error("not allowed to remove members");
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`companion:org-owner:${input.orgId}`}))`);
    const target = await tx.query.memberships.findFirst({
      where: and(eq(schema.memberships.orgId, input.orgId), eq(schema.memberships.userId, input.userId)),
    });
    if (!target) throw new Error("member not found");
    const targetRole = target.orgRole as OrgRole;
    if (targetRole === "owner" && !canTouchOwner(actorRole)) throw new Error("only owners can remove owners");
    if (isLastOwner(await ownerCount(input.orgId, tx), targetRole === "owner")) {
      throw new Error("organization must keep at least one owner");
    }
    await disableSecretsForDepartingMember({
      orgId: input.orgId,
      userId: input.userId,
      actorId: input.actor.id,
      database: tx,
    });
    await tx
      .delete(schema.memberships)
      .where(and(eq(schema.memberships.orgId, input.orgId), eq(schema.memberships.userId, input.userId)));
    await markSeatSyncPending(input.orgId, tx);
  });
}

/** Which library a skill read targets. Org skills are flat; personal skills are owner-private. */
export type SkillLibrary = "org" | "mine" | "accessible";

/**
 * The visibility gate for skill reads: org membership + the tenant scope, narrowed by `library`.
 *   * `org`        — the flat org-wide library: `scope = 'org'` (every member, default).
 *   * `mine`       — the caller's "My Skills": their authored personal skills PLUS org skills they have
 *                    installed (surfaced under My Skills).
 *   * `accessible` — single-skill resolution: every org skill PLUS the caller's own personal skills.
 *                    Used by `getSkillBySlug` so a personal skill stays reachable by its owner.
 * Asserts membership and returns the predicate every skill read/write shares.
 */
async function visibleSkillPredicate(
  database: Db,
  actor: ActorContext,
  orgId: string,
  library: SkillLibrary = "org",
) {
  await assertMember(database, actor, orgId);
  const entitlements = await getEntitlements({ orgId, database });
  const orgScope = eq(schema.skills.orgId, orgId);
  if (library === "org") {
    return and(orgScope, eq(schema.skills.scope, "org"));
  }
  if (library === "accessible") {
    if (!entitlements.personalSkills) return and(orgScope, eq(schema.skills.scope, "org"));
    return and(
      orgScope,
      sql`(${schema.skills.scope} = 'org' or ${schema.skills.creatorId} = ${actor.id})`,
    );
  }
  if (!entitlements.personalSkills) {
    return and(
      orgScope,
      eq(schema.skills.scope, "org"),
      exists(
        database
          .select({ one: sql`1` })
          .from(schema.skillInstalls)
          .where(
            and(
              eq(schema.skillInstalls.orgId, orgId),
              eq(schema.skillInstalls.skillId, schema.skills.id),
              eq(schema.skillInstalls.userId, actor.id),
            ),
          ),
      ),
    );
  }
  // `mine`: personal skills I authored, OR org skills I have installed.
  return and(
    orgScope,
    sql`(
      (${schema.skills.scope} = 'personal' and ${schema.skills.creatorId} = ${actor.id})
      or (${schema.skills.scope} = 'org' and exists (
        select 1 from ${schema.skillInstalls} si
        where si.org_id = ${orgId} and si.skill_id = ${schema.skills.id} and si.user_id = ${actor.id}
      ))
    )`,
  );
}

/**
 * The set of skill ids the actor can read (org skills + their own personal skills). Drives the
 * "used by" roll-up so it never leaks a dependent the actor cannot see (e.g. another member's
 * private skill that depends on an org skill).
 */
async function visibleSkillIds(database: Db, actor: ActorContext, orgId: string): Promise<Set<string>> {
  const predicate = await visibleSkillPredicate(database, actor, orgId, "accessible");
  const rows = await database.select({ id: schema.skills.id }).from(schema.skills).where(predicate);
  // Defensive (mocked DBs in tests may return a non-array for this shape) — see loadDepGraph.
  return new Set((Array.isArray(rows) ? rows : []).map((r) => r.id));
}

/**
 * Turn free-text search input into a prefix `to_tsquery` string ("depl kube" → "depl:* & kube:*").
 * Tokenises to `[a-z0-9]` runs so the query can never carry `to_tsquery` operators (which would
 * raise a syntax error). Returns null when the input has no usable term.
 */
export function toPrefixTsQuery(raw: string): string | null {
  const terms = raw.toLowerCase().match(/[a-z0-9]+/g);
  if (!terms || terms.length === 0) return null;
  return terms.map((t) => `${t}:*`).join(" & ");
}

export async function listSkills(input: {
  actor: ActorContext;
  orgId: string;
  /**
   * Which library to read: `org` (flat org-wide, default), `mine` (the caller's "My Skills" —
   * authored personal skills + org skills they installed), or `accessible` (single-skill resolution:
   * org skills + the caller's own personal skills).
   */
  library?: SkillLibrary;
  /** Filter to skills filed under this label path OR any descendant of it. */
  label?: string;
  /** Filter to skills filed under no label at all. */
  nolabel?: boolean;
  /** Return only org skills the caller has recorded as installed. */
  installedOnly?: boolean;
  /** Return ONLY archived skills (the Archived view). Ignored when `includeArchived` is set. */
  archived?: boolean;
  /** Include both archived and live skills (detail / dependency / download resolution). */
  includeArchived?: boolean;
  /**
   * Free-text query. When set, results are filtered to full-text matches across slug, description,
   * tools, and the SKILL.md body, and ordered by relevance (`ts_rank`) instead of recency.
   */
  query?: string;
  /** Cap the number of rows (used by the relevance-ranked search path). */
  limit?: number;
  database?: Db;
}): Promise<SkillListRow[]> {
  const database = input.database ?? db;
  const library: SkillLibrary = input.library ?? "org";
  const baseVisibility = await visibleSkillPredicate(database, input.actor, input.orgId, library);
  const predicates = [baseVisibility];
  // Which folder table backs this library's "filed in" paths: org skills use the shared `skill_labels`;
  // the My-Skills library uses the caller's private `personal_skill_labels`.
  const labelTable = library === "mine" ? schema.personalSkillLabels : schema.skillLabels;
  const labelOwnerScope = library === "mine" ? sql` and sl.owner_id = ${input.actor.id}` : sql``;
  // Archived skills drop out of normal lists; the Archived view shows only them; detail/deps/
  // download resolution includes both so an archived skill stays viewable and downloadable.
  if (!input.includeArchived) {
    predicates.push(input.archived ? not(isNull(schema.skills.archivedAt)) : isNull(schema.skills.archivedAt));
  }
  // Label filter: filed under the exact path OR any descendant (`path/...`). Bound params; `_`/`%`
  // can't appear in a validated kebab path, so no LIKE escaping is needed.
  if (input.label) {
    const labelPrefix = `${input.label}/%`;
    predicates.push(
      sql`exists (select 1 from ${labelTable} sl where sl.org_id = ${input.orgId} and sl.skill_id = ${schema.skills.id}${labelOwnerScope} and (sl.path = ${input.label} or sl.path like ${labelPrefix}))`,
    );
  }
  // "No label" pseudo-filter: skills carrying no assignment at all.
  if (input.nolabel) {
    predicates.push(
      sql`not exists (select 1 from ${labelTable} sl where sl.org_id = ${input.orgId} and sl.skill_id = ${schema.skills.id}${labelOwnerScope})`,
    );
  }
  if (input.installedOnly) {
    predicates.push(
      exists(
        database
          .select({ one: sql`1` })
          .from(schema.skillInstalls)
          .where(
            and(
              eq(schema.skillInstalls.orgId, input.orgId),
              eq(schema.skillInstalls.skillId, schema.skills.id),
              eq(schema.skillInstalls.userId, input.actor.id),
            ),
          ),
      ),
    );
  }

  // Relevance-ranked full-text search. Active only when a non-empty query is supplied, so the default
  // list path (and every hand-rolled fakeDb in the tests) is left untouched. Fields are weighted
  // slug (A) > description (B) > tools (C) > SKILL.md body (D) so the strongest signal wins.
  const doSearch = !!input.query && input.query.trim().length > 0;
  const tsQueryStr = doSearch ? toPrefixTsQuery(input.query!) : null;
  // A query with no usable term (e.g. only punctuation) can never match: return nothing rather than all.
  if (doSearch && !tsQueryStr) return [];
  // The body vector is written exactly as the `skill_versions_body_tsv_idx` GIN index expression
  // (`to_tsvector('simple', body)` — body is NOT NULL) so the `@@` filter below can use that index.
  const bodyTsv = sql`to_tsvector('simple', ${schema.skillVersions.body})`;
  // The remaining fields are short, live on the skills rows, and aren't worth their own index.
  const headTsv = sql`(
    setweight(to_tsvector('simple', coalesce(${schema.skills.slug}, '')), 'A') ||
    setweight(to_tsvector('simple', coalesce(${schema.skills.description}, '')), 'B') ||
    setweight(to_tsvector('simple', coalesce(${schema.skillVersions.tools}::text, '')), 'C')
  )`;
  const tsQuery = sql`to_tsquery('simple', ${tsQueryStr})`;
  // Rank over the full weighted vector (slug A > description B > tools C > body D).
  const searchRank = doSearch ? sql<number>`ts_rank(${headTsv} || setweight(${bodyTsv}, 'D'), ${tsQuery})` : null;
  // Filter with `@@` (short-circuits, and the body branch is index-eligible) rather than `ts_rank > 0`.
  if (doSearch) predicates.push(sql`(${bodyTsv} @@ ${tsQuery} or ${headTsv} @@ ${tsQuery})`);

  // Second `profiles` join, aliased to the uploader of the current version (`skill_versions.created_by`),
  // so we can surface "Last updated by" distinct from the creator without a schema change.
  const updaterProfile = alias(schema.profiles, "updater_profile");
  const publicVersion = alias(schema.skillVersions, "public_version");

  const baseQuery = database
    .select({
      id: schema.skills.id,
      share_token: schema.skills.shareToken,
      org_id: schema.skills.orgId,
      slug: schema.skills.slug,
      description: schema.skills.description,
      display_name: schema.skills.displayName,
      scope: schema.skills.scope,
      validation: schema.skills.validation,
      validation_error: schema.skills.validationError,
      creator_id: schema.skills.creatorId,
      creator_name: schema.profiles.name,
      creator_initials: schema.profiles.initials,
      creator_email: schema.profiles.email,
      creator_avatar_url: schema.profiles.avatarUrl,
      creator_updated_at: schema.profiles.updatedAt,
      // "Last updated by" — the uploader of the current version, joined via `updaterProfile`.
      updater_id: schema.skillVersions.createdBy,
      updater_name: updaterProfile.name,
      updater_initials: updaterProfile.initials,
      updater_email: updaterProfile.email,
      updater_avatar_url: updaterProfile.avatarUrl,
      updater_updated_at: updaterProfile.updatedAt,
      // Correlated array_agg of the skill's label paths, sorted. A RAW sql subquery (NOT a
      // database.select().limit, which breaks the hand-rolled fakeDbs in tests); empty → '{}'.
      // The org library reads org `skill_labels`; My Skills reads the caller's private
      // `personal_skill_labels`; single-skill (`accessible`) resolution picks per row by the
      // skill's scope so an org skill keeps its shared folders and a personal skill its private ones.
      labels:
        library === "mine"
          ? sql<string[]>`coalesce((select array_agg(psl.path order by psl.path) from ${schema.personalSkillLabels} psl where psl.org_id = ${input.orgId} and psl.owner_id = ${input.actor.id} and psl.skill_id = ${schema.skills.id}), '{}')`
          : library === "accessible"
            ? sql<string[]>`case when ${schema.skills.scope} = 'personal' then coalesce((select array_agg(psl.path order by psl.path) from ${schema.personalSkillLabels} psl where psl.org_id = ${input.orgId} and psl.owner_id = ${schema.skills.creatorId} and psl.skill_id = ${schema.skills.id}), '{}') else coalesce((select array_agg(sl.path order by sl.path) from ${schema.skillLabels} sl where sl.org_id = ${input.orgId} and sl.skill_id = ${schema.skills.id}), '{}') end`
            : sql<string[]>`coalesce((select array_agg(sl.path order by sl.path) from ${schema.skillLabels} sl where sl.org_id = ${input.orgId} and sl.skill_id = ${schema.skills.id}), '{}')`,
      current_version: schema.skillVersions.version,
      public_version: publicVersion.version,
      can_manage_public: sql<boolean>`(
        ${schema.skills.scope} = 'org'
        and (
          ${schema.skills.creatorId} = ${input.actor.id}
          or exists (
            select 1 from ${schema.memberships} public_manager
            where public_manager.org_id = ${input.orgId}
              and public_manager.user_id = ${input.actor.id}
              and public_manager.org_role in ('owner', 'admin')
          )
        )
      )`,
      license: schema.skillVersions.license,
      frontmatter: schema.skillVersions.frontmatter,
      checksum: schema.skillVersions.checksum,
      size_bytes: schema.skillVersions.sizeBytes,
      tools: schema.skillVersions.tools,
      installed: exists(
        database
          .select({ one: sql`1` })
          .from(schema.skillInstalls)
          .where(
            and(
              eq(schema.skillInstalls.orgId, input.orgId),
              eq(schema.skillInstalls.skillId, schema.skills.id),
              eq(schema.skillInstalls.userId, input.actor.id),
            ),
          ),
      ),
      archived_at: schema.skills.archivedAt,
      created_at: schema.skills.createdAt,
      updated_at: schema.skills.updatedAt,
    })
    .from(schema.skills)
    .innerJoin(schema.profiles, eq(schema.profiles.id, schema.skills.creatorId))
    .leftJoin(schema.skillVersions, eq(schema.skillVersions.id, schema.skills.currentVersionId))
    .leftJoin(
      publicVersion,
      and(
        eq(publicVersion.orgId, schema.skills.orgId),
        eq(publicVersion.skillId, schema.skills.id),
        eq(publicVersion.id, schema.skills.publicVersionId),
      ),
    )
    .leftJoin(updaterProfile, eq(updaterProfile.id, schema.skillVersions.createdBy))
    .where(and(...predicates));

  // Search path orders by relevance then recency and caps the result count; the default list path keeps
  // its recency-only ordering and never calls `.limit()` (so the fakeDb query mocks stay untouched).
  const rows = await (searchRank
    ? baseQuery.orderBy(desc(searchRank), desc(schema.skills.updatedAt)).limit(input.limit ?? 20)
    : baseQuery.orderBy(desc(schema.skills.updatedAt)));
  const modifiersBySkill = await loadSkillModifiers({
    database,
    orgId: input.orgId,
    skills: rows.map((r) => ({ skillId: r.id, creatorId: r.creator_id })),
  });

  // Dependency counts + warn flag, computed from the org's current-version dependency graph.
  const graph = await loadDepGraph(database, input.orgId);
  // Used-by counts must not leak dependents the actor cannot read — scope to the visibility gate.
  const visibleIds = await visibleSkillIds(database, input.actor, input.orgId);
  // "Referenced by any version" (current or older), matching the archived-download gate; not
  // visibility-scoped, since an install of any referencing version must keep the package fetchable.
  const referencedRows = await database
    .select({
      slug: schema.skillVersionDependencies.dependsOnSlug,
      target_id: schema.skillVersionDependencies.dependsOnSkillId,
    })
    .from(schema.skillVersionDependencies)
    .where(eq(schema.skillVersionDependencies.orgId, input.orgId));
  const referencedIds = new Set(
    (Array.isArray(referencedRows) ? referencedRows : [])
      .map((d) => d.target_id)
      .filter((id): id is string => !!id),
  );
  const referencedSlugs = new Set(
    (Array.isArray(referencedRows) ? referencedRows : [])
      .filter((d) => !d.target_id)
      .map((d) => d.slug),
  );

  // The caller's installed version per skill, for status computation. Scoped to the whole org (not
  // just the displayed rows) so dependency-aware roll-up can see installs outside the current filter/
  // view. A separate query (not a join) keeps the grouped main select simple; guarded for mocked DBs.
  const installBySkill = new Map<string, string | null>();
  const installRows = await database
    .select({
      skill_id: schema.skillInstalls.skillId,
      installed_version: schema.skillInstalls.installedVersion,
    })
    .from(schema.skillInstalls)
    .where(
      and(eq(schema.skillInstalls.orgId, input.orgId), eq(schema.skillInstalls.userId, input.actor.id)),
    );
  for (const row of Array.isArray(installRows) ? installRows : []) {
    installBySkill.set(row.skill_id, row.installed_version);
  }

  // Dependency-aware update detection: a skill is "update" if it is behind its own current version,
  // OR any skill in its dependency closure that the caller has installed is behind. Reinstalling the
  // parent re-pulls its dependency set, so a stale dependency means the parent is effectively stale.
  // Current versions come from the org-wide graph so the result is the same in every filtered view.
  const selfBehind = (id: string): boolean => {
    const installedVersion = installBySkill.get(id);
    const current = graph.byId.get(id)?.currentVersion ?? null;
    if (installedVersion == null || current == null) return false;
    return compareSemver(installedVersion, current) < 0;
  };

  return rows.map((r) => {
    const frontmatter = r.frontmatter ?? "";
    const manifest = parseStoredSkillFrontmatter(frontmatter);
    const summary = r.description ?? manifest?.description ?? r.slug ?? "skill";
    const companion = parseStoredCompanionManifest(frontmatter, summary);
    const display = skillDisplayWithOverride(companion.display, r.display_name);
    const requires = graph.requiresBySkill.get(r.id) ?? [];
    const usedBy = (graph.dependentsByTarget.get(r.id) ?? []).filter((u) => visibleIds.has(u.dependentId));
    const depWarn = requires.some((edge) => depEdgeStatus(graph, r.id, edge) !== "satisfied");
    return {
      id: r.id,
      org_id: r.org_id,
      share_token: r.share_token,
      slug: r.slug,
      description: summary,
      display,
      icon: companion.icon ?? null,
      notes: companion.notes ?? null,
      scope: r.scope ?? "org",
      // `source` is only meaningful in the My-Skills (`mine`) view: 'authored' = a personal skill the
      // caller created; 'installed' = an org skill they installed, surfaced under My Skills. The org
      // and single-skill views leave it null.
      source:
        library === "mine"
          ? (r.scope ?? "org") === "personal"
            ? ("authored" as const)
            : ("installed" as const)
          : null,
      validation: r.validation,
      validation_error: r.validation_error,
      labels: (Array.isArray(r.labels) ? r.labels : []).slice().sort((a, b) => a.localeCompare(b)),
      creator_id: r.creator_id,
      creator_name: r.creator_name,
      creator_initials: r.creator_initials,
      creator_avatar_url: resolveUserAvatarUrl({
        userId: r.creator_id,
        email: r.creator_email ?? "",
        avatarUrl: r.creator_avatar_url ?? null,
        updatedAtEpoch: r.creator_updated_at instanceof Date ? r.creator_updated_at.getTime() : 0,
      }),
      // "Last updated by" = uploader of the current version; fall back to the creator when a skill has
      // no current version (left join → nulls) so the field is never empty.
      updater_id: r.updater_id ?? r.creator_id,
      updater_name: r.updater_name ?? r.creator_name,
      updater_initials: r.updater_initials ?? r.creator_initials,
      updater_avatar_url: r.updater_id
        ? resolveUserAvatarUrl({
            userId: r.updater_id,
            email: r.updater_email ?? "",
            avatarUrl: r.updater_avatar_url ?? null,
            updatedAtEpoch: r.updater_updated_at instanceof Date ? r.updater_updated_at.getTime() : 0,
          })
        : resolveUserAvatarUrl({
            userId: r.creator_id,
            email: r.creator_email ?? "",
            avatarUrl: r.creator_avatar_url ?? null,
            updatedAtEpoch: r.creator_updated_at instanceof Date ? r.creator_updated_at.getTime() : 0,
          }),
      modifiers: modifiersBySkill.get(r.id) ?? [],
      current_version: r.current_version,
      public_version: r.public_version ?? null,
      can_manage_public: Boolean(r.can_manage_public),
      compatibility: manifest?.compatibility ?? null,
      metadata: manifest?.metadata ?? {},
      license: r.license ?? manifest?.license ?? null,
      tools: r.tools?.length ? r.tools : parseAllowedTools(manifest?.["allowed-tools"]),
      requirements: companion.requirements,
      checksum: r.checksum,
      size_bytes: r.size_bytes,
      installed: Boolean(r.installed),
      installed_version: installBySkill.get(r.id) ?? null,
      install_status: (() => {
        const own = computeSkillInstallStatus(
          Boolean(r.installed),
          installBySkill.get(r.id) ?? null,
          r.current_version,
        );
        // Roll up a stale dependency into an "update" hint on the installed parent.
        if (own === "installed" && depGraphClosureHasUpdate(r.id, graph, selfBehind)) {
          return "update";
        }
        return own;
      })(),
      requires_count: requires.length,
      used_by_count: new Set(usedBy.map((u) => u.dependentId)).size,
      dep_warn: depWarn,
      archived: r.archived_at != null,
      referenced: referencedIds.has(r.id) || referencedSlugs.has(r.slug),
      database_table_count: Object.keys(companion.database?.tables ?? {}).length,
      database_available:
        process.env.COMPANION_SKILL_DATABASES_ENABLED?.trim().toLowerCase() === "true"
        && Object.keys(companion.database?.tables ?? {}).length > 0,
      created_at: r.created_at.toISOString(),
      updated_at: r.updated_at.toISOString(),
    };
  }) as SkillListRow[];
}

async function loadSkillModifiers(input: {
  database: Db;
  orgId: string;
  skills: Array<{ skillId: string; creatorId: string }>;
}): Promise<Map<string, SkillModifier[]>> {
  const bySkill = new Map<string, SkillModifier[]>();
  if (input.skills.length === 0) return bySkill;

  const creatorBySkill = new Map(input.skills.map((s) => [s.skillId, s.creatorId]));
  const skillIds = input.skills.map((s) => s.skillId);
  const rows = await input.database
    .select({
      skill_id: schema.skillVersions.skillId,
      user_id: schema.skillVersions.createdBy,
      name: schema.profiles.name,
      initials: schema.profiles.initials,
      email: schema.profiles.email,
      avatar_url: schema.profiles.avatarUrl,
      profile_updated_at: schema.profiles.updatedAt,
      last_published_at: sql<Date>`max(${schema.skillVersions.createdAt})`,
    })
    .from(schema.skillVersions)
    .innerJoin(schema.profiles, eq(schema.profiles.id, schema.skillVersions.createdBy))
    .where(and(eq(schema.skillVersions.orgId, input.orgId), inArray(schema.skillVersions.skillId, skillIds)))
    .groupBy(
      schema.skillVersions.skillId,
      schema.skillVersions.createdBy,
      schema.profiles.id,
      schema.profiles.name,
      schema.profiles.initials,
      schema.profiles.email,
      schema.profiles.avatarUrl,
      schema.profiles.updatedAt,
    )
    .orderBy(desc(sql`max(${schema.skillVersions.createdAt})`));

  if (!Array.isArray(rows)) return bySkill;
  const seenBySkill = new Map<string, Set<string>>();
  for (const row of rows) {
    if (
      typeof row.skill_id !== "string" ||
      typeof row.user_id !== "string" ||
      typeof row.name !== "string" ||
      typeof row.initials !== "string" ||
      typeof row.email !== "string"
    ) {
      continue;
    }
    if (creatorBySkill.get(row.skill_id) === row.user_id) continue;
    let seen = seenBySkill.get(row.skill_id);
    if (!seen) seenBySkill.set(row.skill_id, (seen = new Set()));
    if (seen.has(row.user_id)) continue;
    seen.add(row.user_id);
    const updatedAtEpoch = row.profile_updated_at instanceof Date ? row.profile_updated_at.getTime() : 0;
    const modifier: SkillModifier = {
      user_id: row.user_id,
      name: row.name,
      initials: row.initials,
      avatar_url: resolveUserAvatarUrl({
        userId: row.user_id,
        email: row.email,
        avatarUrl: typeof row.avatar_url === "string" ? row.avatar_url : null,
        updatedAtEpoch,
      }),
    };
    bySkill.set(row.skill_id, [...(bySkill.get(row.skill_id) ?? []), modifier]);
  }
  return bySkill;
}

/**
 * Public, unauthenticated skill-link preview. This intentionally does not take an actor/org: the
 * unguessable token is the bearer for a metadata-only preview. It only resolves live org skills and
 * never returns ids, tenant identifiers, package files, or SKILL.md content.
 */
export async function getSkillPublicPreviewByShareToken(input: {
  token: string;
  database?: Db;
}): Promise<SkillPublicPreview | null> {
  const token = input.token.trim();
  if (!token) return null;
  const database = input.database ?? db;
  const row = await getPreTenantSkillPreview(database, token);
  if (!row) return null;
  const versionDescription = parseStoredSkillFrontmatter(row.frontmatter ?? "")?.description ?? row.description;
  const manifest = parseStoredCompanionManifest(row.frontmatter ?? "", versionDescription);
  const display = skillDisplayWithOverride(manifest.display, row.display_name);
  return {
    display_name: display.name ?? row.slug,
    slug: row.slug,
    description: display.summary ?? versionDescription,
    current_version: row.current_version,
    creator_name: row.creator_name,
    creator_initials: row.creator_initials,
    updated_at: new Date(row.updated_at).toISOString(),
    public_release:
      row.public_version && row.public_checksum && row.public_size_bytes != null && row.public_released_at
        ? {
            version: row.public_version,
            checksum: row.public_checksum,
            size_bytes: Number(row.public_size_bytes),
            released_at: new Date(row.public_released_at).toISOString(),
          }
        : null,
  };
}

export class SkillPublicReleaseNotFoundError extends Error {
  constructor(message = "public skill release not found") {
    super(message);
    this.name = "SkillPublicReleaseNotFoundError";
  }
}

export class SkillPublicReleaseForbiddenError extends Error {
  constructor(message = "you cannot manage this public release") {
    super(message);
    this.name = "SkillPublicReleaseForbiddenError";
  }
}

export class SkillPublicReleaseConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SkillPublicReleaseConflictError";
  }
}

export class SkillPublicReleaseValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SkillPublicReleaseValidationError";
  }
}

async function publicReleaseSkillForActor(input: {
  database: Db;
  actor: ActorContext;
  orgId: string;
  slug: string;
}): Promise<{ skill: typeof schema.skills.$inferSelect; role: OrgRole }> {
  const role = await assertMember(input.database, input.actor, input.orgId);
  const skill = await input.database.query.skills.findFirst({
    where: and(eq(schema.skills.orgId, input.orgId), eq(schema.skills.slug, input.slug)),
  });
  if (!skill || (skill.scope === "personal" && skill.creatorId !== input.actor.id)) {
    throw new SkillPublicReleaseNotFoundError("skill not found");
  }
  if (skill.scope !== "org") {
    throw new SkillPublicReleaseConflictError("share this personal skill with the organization before making it public");
  }
  if (!canManagePublicSkill({ id: input.actor.id, orgRole: role }, skill)) {
    throw new SkillPublicReleaseForbiddenError();
  }
  return { skill, role };
}

/** Pin/promote the current immutable version, guarded by an implicit compare-and-swap. */
export async function setSkillPublicVersion(input: {
  actor: ActorContext;
  orgId: string;
  slug: string;
  version: string;
  /** SHA-256 over the exact deterministic ZIP bytes the public route will serve. */
  packageChecksum: string;
  /** Exact deterministic ZIP byte length. */
  packageSizeBytes: number;
  /** Version observed as current before the caller persisted the content-addressed ZIP snapshot. */
  expectedCurrentVersionId?: string;
  database?: Db;
}): Promise<SkillPublicVersionResult> {
  const database = input.database ?? db;
  if (!/^sha256:[0-9a-f]{64}$/.test(input.packageChecksum)) {
    throw new SkillPublicReleaseValidationError("public package checksum must be a sha256 digest");
  }
  if (!Number.isSafeInteger(input.packageSizeBytes) || input.packageSizeBytes < 0) {
    throw new SkillPublicReleaseValidationError("public package size must be a non-negative integer");
  }
  return database.transaction(async (tx) => {
    const tenantDb = tx as unknown as Db;
    const { skill } = await publicReleaseSkillForActor({ ...input, database: tenantDb });
    if (skill.archivedAt) throw new SkillPublicReleaseConflictError("restore the skill before making a version public");
    const version = await tenantDb.query.skillVersions.findFirst({
      where: and(
        eq(schema.skillVersions.orgId, input.orgId),
        eq(schema.skillVersions.skillId, skill.id),
        eq(schema.skillVersions.version, input.version),
      ),
    });
    if (!version) throw new SkillPublicReleaseNotFoundError("skill version not found");
    if (skill.currentVersionId !== version.id && input.expectedCurrentVersionId === version.id) {
      throw new SkillPublicReleaseConflictError("the current skill version changed concurrently; refresh and try again");
    }
    if (skill.currentVersionId !== version.id) {
      throw new SkillPublicReleaseValidationError("only the current skill version can be made public");
    }
    const versionIdentity = parseStoredSkillFrontmatter(version.frontmatter);
    if (!versionIdentity || versionIdentity.name !== skill.slug) {
      throw new SkillPublicReleaseValidationError(
        `publish a new current version named "${skill.slug}" before making it public`,
      );
    }

    const changed =
      skill.publicVersionId !== version.id ||
      skill.publicPackageChecksum !== input.packageChecksum ||
      skill.publicPackageSizeBytes !== input.packageSizeBytes;
    const expectedPointer = skill.publicVersionId
      ? eq(schema.skills.publicVersionId, skill.publicVersionId)
      : isNull(schema.skills.publicVersionId);
    const expectedChecksum = skill.publicPackageChecksum
      ? eq(schema.skills.publicPackageChecksum, skill.publicPackageChecksum)
      : isNull(schema.skills.publicPackageChecksum);
    const expectedSize = skill.publicPackageSizeBytes != null
      ? eq(schema.skills.publicPackageSizeBytes, skill.publicPackageSizeBytes)
      : isNull(schema.skills.publicPackageSizeBytes);
    const expectedReleasedAt = skill.publicReleasedAt
      ? eq(schema.skills.publicReleasedAt, skill.publicReleasedAt)
      : isNull(schema.skills.publicReleasedAt);
    const [updated] = await tenantDb
      .update(schema.skills)
      .set(
        changed
          ? {
              publicVersionId: version.id,
              publicPackageChecksum: input.packageChecksum,
              publicPackageSizeBytes: input.packageSizeBytes,
              publicReleasedAt: new Date(),
              updatedAt: new Date(),
            }
          // A same-value UPDATE is intentional: it takes the row lock and rechecks the complete
          // observed release state after any concurrent writer, without changing idempotent semantics.
          : { publicVersionId: version.id },
      )
      .where(and(
        eq(schema.skills.orgId, input.orgId),
        eq(schema.skills.id, skill.id),
        eq(schema.skills.slug, skill.slug),
        eq(schema.skills.scope, "org"),
        isNull(schema.skills.archivedAt),
        eq(schema.skills.currentVersionId, version.id),
        expectedPointer,
        expectedChecksum,
        expectedSize,
        expectedReleasedAt,
      ))
      .returning({ id: schema.skills.id });
    if (!updated) {
      throw new SkillPublicReleaseConflictError("the public release changed concurrently; refresh and try again");
    }

    const previousVersion = skill.publicVersionId
      ? await tenantDb.query.skillVersions.findFirst({
          columns: { version: true },
          where: and(
            eq(schema.skillVersions.orgId, input.orgId),
            eq(schema.skillVersions.skillId, skill.id),
            eq(schema.skillVersions.id, skill.publicVersionId),
          ),
        })
      : null;
    await tenantDb.insert(schema.auditLog).values({
      orgId: input.orgId,
      actorId: input.actor.id,
      action: "skill.public_version.set",
      targetType: "skill",
      targetId: skill.id,
      metadata: {
        slug: skill.slug,
        version: version.version,
        previousVersion: previousVersion?.version ?? null,
        packageChecksum: input.packageChecksum,
        packageSizeBytes: input.packageSizeBytes,
        changed,
      },
    });
    return { ok: true as const, public_version: version.version, share_token: skill.shareToken, changed };
  });
}

/** Withdraw package access while retaining the stable link token and the immutable version row. */
export async function clearSkillPublicVersion(input: {
  actor: ActorContext;
  orgId: string;
  slug: string;
  database?: Db;
}): Promise<SkillPublicVersionResult> {
  const database = input.database ?? db;
  return database.transaction(async (tx) => {
    const tenantDb = tx as unknown as Db;
    const { skill } = await publicReleaseSkillForActor({ ...input, database: tenantDb });
    const previousVersion = skill.publicVersionId
      ? await tenantDb.query.skillVersions.findFirst({
          columns: { version: true },
          where: and(
            eq(schema.skillVersions.orgId, input.orgId),
            eq(schema.skillVersions.skillId, skill.id),
            eq(schema.skillVersions.id, skill.publicVersionId),
          ),
        })
      : null;
    const changed = skill.publicVersionId !== null;
    const expectedPointer = skill.publicVersionId
      ? eq(schema.skills.publicVersionId, skill.publicVersionId)
      : isNull(schema.skills.publicVersionId);
    const expectedChecksum = skill.publicPackageChecksum
      ? eq(schema.skills.publicPackageChecksum, skill.publicPackageChecksum)
      : isNull(schema.skills.publicPackageChecksum);
    const expectedSize = skill.publicPackageSizeBytes != null
      ? eq(schema.skills.publicPackageSizeBytes, skill.publicPackageSizeBytes)
      : isNull(schema.skills.publicPackageSizeBytes);
    const expectedReleasedAt = skill.publicReleasedAt
      ? eq(schema.skills.publicReleasedAt, skill.publicReleasedAt)
      : isNull(schema.skills.publicReleasedAt);
    const [updated] = await tenantDb
      .update(schema.skills)
      .set(
        changed
          ? {
              publicVersionId: null,
              publicPackageChecksum: null,
              publicPackageSizeBytes: null,
              publicReleasedAt: null,
              updatedAt: new Date(),
            }
          // Preserve the no-op result while still fencing a promotion that committed after our read.
          : { publicVersionId: null },
      )
      .where(and(
        eq(schema.skills.orgId, input.orgId),
        eq(schema.skills.id, skill.id),
        eq(schema.skills.scope, "org"),
        expectedPointer,
        expectedChecksum,
        expectedSize,
        expectedReleasedAt,
      ))
      .returning({ id: schema.skills.id });
    if (!updated) {
      throw new SkillPublicReleaseConflictError("the public release changed concurrently; refresh and try again");
    }
    await tenantDb.insert(schema.auditLog).values({
      orgId: input.orgId,
      actorId: input.actor.id,
      action: "skill.public_version.clear",
      targetType: "skill",
      targetId: skill.id,
      metadata: { slug: skill.slug, previousVersion: previousVersion?.version ?? null, changed },
    });
    return { ok: true as const, public_version: null, share_token: skill.shareToken, changed };
  });
}

export interface PublicSkillPackageDescriptor {
  orgId: string;
  slug: string;
  version: string;
  checksum: string;
  sizeBytes: number;
}

/** Authorize an exact public package for any verified Better Auth account. */
export async function authorizePublicSkillPackageForSession(input: {
  token: string;
  version: string;
  userId: string;
  database?: Db;
}): Promise<PublicSkillPackageDescriptor | null> {
  const token = input.token.trim();
  const version = input.version.trim();
  if (!token || !version || !input.userId) return null;
  const row = await authorizePreTenantPublicSkillPackage(input.database ?? db, { token, version, userId: input.userId });
  return row
    ? {
        orgId: row.org_id,
        slug: row.slug,
        version: row.version,
        checksum: row.checksum,
        sizeBytes: Number(row.size_bytes),
      }
    : null;
}

/** Authorize an exact public package for a scoped PAT with truthful audit provenance. */
export async function authorizePublicSkillPackageForApiToken(input: {
  token: string;
  version: string;
  userId: string;
  database?: Db;
}): Promise<PublicSkillPackageDescriptor | null> {
  const token = input.token.trim();
  const version = input.version.trim();
  if (!token || !version || !input.userId) return null;
  const row = await authorizePreTenantPublicSkillPackage(input.database ?? db, {
    token,
    version,
    userId: input.userId,
    authKind: "api_token",
  });
  return row
    ? {
        orgId: row.org_id,
        slug: row.slug,
        version: row.version,
        checksum: row.checksum,
        sizeBytes: Number(row.size_bytes),
      }
    : null;
}

export const PUBLIC_SKILL_TRANSFER_TICKET_TTL_MS = 60_000;
export const PUBLIC_SKILL_TRANSFER_TICKET_PREFIX = "cmp_xfer_";

/** Agent Auth integration hook: mint a one-use, hash-at-rest package ticket. */
export async function createPublicSkillTransferTicket(input: {
  token: string;
  version: string;
  userId: string;
  agentId: string;
  agentGrantId?: string | null;
  database?: Db;
}): Promise<{
  ticket: string;
  expires_at: string;
  version: string;
  checksum: string;
  size_bytes: number;
}> {
  const ticket = `${PUBLIC_SKILL_TRANSFER_TICKET_PREFIX}${randomBytes(32).toString("hex")}`;
  const tokenHash = createHash("sha256").update(ticket).digest("hex");
  const expiresAt = new Date(Date.now() + PUBLIC_SKILL_TRANSFER_TICKET_TTL_MS);
  const row = await issuePreTenantPublicSkillTransferTicket(input.database ?? db, {
    token: input.token.trim(),
    version: input.version.trim(),
    userId: input.userId,
    agentId: input.agentId,
    agentGrantId: input.agentGrantId,
    tokenHash,
    expiresAt,
  });
  if (!row) throw new SkillPublicReleaseNotFoundError();
  return {
    ticket,
    expires_at: new Date(row.expires_at).toISOString(),
    version: row.version,
    checksum: row.checksum,
    size_bytes: Number(row.size_bytes),
  };
}

/** Atomically consume a transfer ticket. A null result is intentionally generic. */
export async function consumePublicSkillTransferTicket(input: {
  ticket: string;
  token: string;
  version: string;
  database?: Db;
}): Promise<PublicSkillPackageDescriptor | null> {
  if (!input.ticket.startsWith(PUBLIC_SKILL_TRANSFER_TICKET_PREFIX)) return null;
  const row = await consumePreTenantPublicSkillTransferTicket(input.database ?? db, {
    tokenHash: createHash("sha256").update(input.ticket).digest("hex"),
    token: input.token.trim(),
    version: input.version.trim(),
  });
  return row
    ? {
        orgId: row.org_id,
        slug: row.slug,
        version: row.version,
        checksum: row.checksum,
        sizeBytes: Number(row.size_bytes),
      }
    : null;
}

export type SkillPackageTransferAction = PreTenantSkillTransferAction;

export interface IssuedSkillPackageTransferTicket {
  ticket: string;
  expires_at: string;
  slug: string;
  version: string;
  checksum: string;
  size_bytes: number;
}

function assertSkillTransferPackageMetadata(checksum: string, sizeBytes: number): void {
  if (!/^sha256:[0-9a-f]{64}$/.test(checksum)) {
    throw new Error("transfer package checksum must be a sha256 digest");
  }
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0) {
    throw new Error("transfer package size must be a non-negative integer");
  }
}

async function persistSkillPackageTransferTicket(input: {
  database: Db;
  actor: ActorContext;
  orgId: string;
  agentId: string;
  agentGrantId?: string | null;
  action: SkillPackageTransferAction;
  skillId: string | null;
  skillVersionId: string | null;
  slug: string;
  version: string;
  filePath?: string | null;
  checksum: string;
  sizeBytes: number;
}): Promise<IssuedSkillPackageTransferTicket> {
  assertSkillTransferPackageMetadata(input.checksum, input.sizeBytes);
  if (!input.agentId.trim()) throw new Error("Agent Auth agent id is required");
  const ticket = `${PUBLIC_SKILL_TRANSFER_TICKET_PREFIX}${randomBytes(32).toString("hex")}`;
  const expiresAt = new Date(Date.now() + PUBLIC_SKILL_TRANSFER_TICKET_TTL_MS);
  await input.database.insert(schema.agentTransferTickets).values({
    orgId: input.orgId,
    userId: input.actor.id,
    agentId: input.agentId,
    agentGrantId: input.agentGrantId ?? null,
    action: input.action,
    skillId: input.skillId,
    skillVersionId: input.skillVersionId,
    shareToken: null,
    skillSlug: input.slug,
    version: input.version,
    filePath: input.filePath ?? null,
    checksum: input.checksum,
    sizeBytes: input.sizeBytes,
    tokenHash: createHash("sha256").update(ticket).digest("hex"),
    expiresAt,
  });
  await input.database.insert(schema.auditLog).values({
    orgId: input.orgId,
    actorId: input.actor.id,
    action: "skill.package.ticket_issue",
    targetType: input.action === "local_skill.download" ? "local_skill" : input.skillId ? "skill" : "skill_slug",
    targetId: input.skillId ?? input.slug,
    metadata: {
      operation: input.action,
      slug: input.slug,
      version: input.version,
      agentId: input.agentId,
      grantId: input.agentGrantId ?? null,
      checksum: input.checksum,
      sizeBytes: input.sizeBytes,
    },
  });
  return {
    ticket,
    expires_at: expiresAt.toISOString(),
    slug: input.slug,
    version: input.version,
    checksum: input.checksum,
    size_bytes: input.sizeBytes,
  };
}

/**
 * Mint a one-use ticket for an exact private/org-library package. The caller computes the checksum
 * over the deterministic ZIP transport, while Core independently revalidates membership, personal
 * privacy, archive/history rules, and the immutable source version before persisting the ticket.
 */
export async function createSkillDownloadTransferTicket(input: {
  actor: ActorContext;
  orgId: string;
  slug: string;
  version: string;
  storagePath: string;
  packageChecksum: string;
  packageSizeBytes: number;
  agentId: string;
  agentGrantId?: string | null;
  database?: Db;
}): Promise<IssuedSkillPackageTransferTicket> {
  const database = input.database ?? db;
  const slug = input.slug.trim();
  const version = input.version.trim();
  if (!slug || !version) throw new Error("skill slug and version are required");
  const downloadable = await getDownloadVersion({
    actor: input.actor,
    orgId: input.orgId,
    slug,
    version,
    database,
  });
  if (downloadable.storagePath !== input.storagePath) {
    throw new Error("skill package changed while the transfer ticket was being prepared");
  }
  const skill = await database.query.skills.findFirst({
    columns: { id: true },
    where: and(eq(schema.skills.orgId, input.orgId), eq(schema.skills.slug, slug)),
  });
  if (!skill) throw new Error("skill not found");
  const skillVersion = await database.query.skillVersions.findFirst({
    columns: { id: true },
    where: and(
      eq(schema.skillVersions.orgId, input.orgId),
      eq(schema.skillVersions.skillId, skill.id),
      eq(schema.skillVersions.version, version),
    ),
  });
  if (!skillVersion) throw new Error("version not found");
  return persistSkillPackageTransferTicket({
    database,
    actor: input.actor,
    orgId: input.orgId,
    agentId: input.agentId,
    agentGrantId: input.agentGrantId,
    action: "skill_package.download",
    skillId: skill.id,
    skillVersionId: skillVersion.id,
    slug,
    version,
    filePath: null,
    checksum: input.packageChecksum,
    sizeBytes: input.packageSizeBytes,
  });
}

/**
 * Mint a one-use ticket for one exact previewable file. The API computes the digest over the bytes
 * it inspected; Core independently revalidates actor visibility plus immutable skill/version ids.
 */
export async function createSkillFileDownloadTransferTicket(input: {
  actor: ActorContext;
  orgId: string;
  slug: string;
  version: string;
  filePath: string;
  storagePath: string;
  fileChecksum: string;
  fileSizeBytes: number;
  agentId: string;
  agentGrantId?: string | null;
  database?: Db;
}): Promise<IssuedSkillPackageTransferTicket> {
  const database = input.database ?? db;
  const slug = input.slug.trim();
  const version = input.version.trim();
  const filePath = input.filePath;
  if (!slug || !version) throw new Error("skill slug and version are required");
  if (!filePath || filePath.includes("\0") || filePath.length > 4_096) {
    throw new Error("an exact valid skill file path is required");
  }
  assertSkillTransferPackageMetadata(input.fileChecksum, input.fileSizeBytes);
  const downloadable = await getDownloadVersion({
    actor: input.actor,
    orgId: input.orgId,
    slug,
    version,
    database,
  });
  if (downloadable.storagePath !== input.storagePath) {
    throw new Error("skill package changed while the file transfer ticket was being prepared");
  }
  const skill = await database.query.skills.findFirst({
    columns: { id: true },
    where: and(eq(schema.skills.orgId, input.orgId), eq(schema.skills.slug, slug)),
  });
  if (!skill) throw new Error("skill not found");
  const skillVersion = await database.query.skillVersions.findFirst({
    columns: { id: true },
    where: and(
      eq(schema.skillVersions.orgId, input.orgId),
      eq(schema.skillVersions.skillId, skill.id),
      eq(schema.skillVersions.version, version),
    ),
  });
  if (!skillVersion) throw new Error("version not found");
  return persistSkillPackageTransferTicket({
    database,
    actor: input.actor,
    orgId: input.orgId,
    agentId: input.agentId,
    agentGrantId: input.agentGrantId,
    action: "skill_file.download",
    skillId: skill.id,
    skillVersionId: skillVersion.id,
    slug,
    version,
    filePath,
    checksum: input.fileChecksum,
    sizeBytes: input.fileSizeBytes,
  });
}

/**
 * Mint a ticket bound to the raw HTTP upload bytes and intended slug/version. Existing personal
 * skills remain creator-only; org skills retain their normal any-member publish semantics. The
 * publish route performs the complete Core authorization again after consuming the ticket.
 */
export async function createSkillUploadTransferTicket(input: {
  actor: ActorContext;
  orgId: string;
  slug: string;
  version: string;
  packageChecksum: string;
  packageSizeBytes: number;
  agentId: string;
  agentGrantId?: string | null;
  database?: Db;
}): Promise<IssuedSkillPackageTransferTicket> {
  const database = input.database ?? db;
  await assertMember(database, input.actor, input.orgId);
  const slug = input.slug.trim();
  const version = input.version.trim();
  if (!slug) throw new Error("skill slug is required");
  if (!isValidSemver(version)) throw new Error(`invalid semver: ${version}`);
  assertSkillTransferPackageMetadata(input.packageChecksum, input.packageSizeBytes);
  if (input.packageSizeBytes > 32 * 1024 * 1024) {
    throw new Error("package exceeds the 32 MB upload limit");
  }
  const existing = await database.query.skills.findFirst({
    columns: { id: true, scope: true, creatorId: true, archivedAt: true },
    where: and(eq(schema.skills.orgId, input.orgId), eq(schema.skills.slug, slug)),
  });
  if (existing?.scope === "personal" && existing.creatorId !== input.actor.id) {
    throw new Error("skill not found");
  }
  if (existing?.archivedAt) throw new Error("restore the skill before publishing a new version");
  return persistSkillPackageTransferTicket({
    database,
    actor: input.actor,
    orgId: input.orgId,
    agentId: input.agentId,
    agentGrantId: input.agentGrantId,
    action: "skill_package.upload",
    skillId: existing?.id ?? null,
    skillVersionId: null,
    slug,
    version,
    filePath: null,
    checksum: input.packageChecksum,
    sizeBytes: input.packageSizeBytes,
  });
}

/** Mint a tenant-bound ticket for an exact version of a trusted, server-bundled local skill. */
export async function createLocalSkillDownloadTransferTicket(input: {
  actor: ActorContext;
  orgId: string;
  key: string;
  version: string;
  packageChecksum: string;
  packageSizeBytes: number;
  agentId: string;
  agentGrantId?: string | null;
  database?: Db;
}): Promise<IssuedSkillPackageTransferTicket> {
  const database = input.database ?? db;
  await assertMember(database, input.actor, input.orgId);
  const key = input.key.trim();
  const version = input.version.trim();
  if (!key) throw new Error("local skill key is required");
  if (!isValidSemver(version)) throw new Error(`invalid semver: ${version}`);
  return persistSkillPackageTransferTicket({
    database,
    actor: input.actor,
    orgId: input.orgId,
    agentId: input.agentId,
    agentGrantId: input.agentGrantId,
    action: "local_skill.download",
    skillId: null,
    skillVersionId: null,
    slug: key,
    version,
    filePath: null,
    checksum: input.packageChecksum,
    sizeBytes: input.packageSizeBytes,
  });
}

export interface ConsumedSkillPackageTransferTicket {
  ticketId: string;
  orgId: string;
  actor: ActorContext;
  agentId: string;
  agentGrantId: string | null;
  action: SkillPackageTransferAction;
  expectedSkillId: string | null;
  expectedSkillVersionId: string | null;
  slug: string;
  version: string;
  filePath: string | null;
  checksum: string;
  sizeBytes: number;
}

/** Fail fake or revoked upload tickets before reading a large request body. */
export async function preflightSkillPackageTransferTicket(input: {
  ticket: string;
  action: SkillPackageTransferAction;
  slug: string;
  version: string;
  database?: Db;
}): Promise<boolean> {
  if (!input.ticket.startsWith(PUBLIC_SKILL_TRANSFER_TICKET_PREFIX)) return false;
  return preflightPreTenantAgentTransferTicket(input.database ?? db, {
    tokenHash: createHash("sha256").update(input.ticket).digest("hex"),
    action: input.action,
    slug: input.slug.trim(),
    version: input.version.trim(),
  });
}

/** Atomically consume a private binary ticket; returns no tenant/resource detail on any failure. */
export async function consumeSkillPackageTransferTicket(input: {
  ticket: string;
  action: SkillPackageTransferAction;
  slug: string;
  version: string;
  checksum?: string | null;
  sizeBytes?: number | null;
  filePath?: string | null;
  database?: Db;
}): Promise<ConsumedSkillPackageTransferTicket | null> {
  if (!input.ticket.startsWith(PUBLIC_SKILL_TRANSFER_TICKET_PREFIX)) return null;
  const row = await consumePreTenantSkillTransferTicket(input.database ?? db, {
    tokenHash: createHash("sha256").update(input.ticket).digest("hex"),
    action: input.action,
    slug: input.slug.trim(),
    version: input.version.trim(),
    checksum: input.checksum,
    sizeBytes: input.sizeBytes,
    filePath: input.filePath,
  });
  return row
    ? {
        ticketId: row.ticket_id,
        orgId: row.org_id,
        actor: { id: row.user_id, email: row.user_email, name: row.user_name || row.user_email },
        agentId: row.agent_id,
        agentGrantId: row.agent_grant_id,
        action: row.action,
        expectedSkillId: row.skill_id,
        expectedSkillVersionId: row.skill_version_id,
        slug: row.skill_slug,
        version: row.version,
        filePath: row.file_path ?? null,
        checksum: row.checksum,
        sizeBytes: Number(row.size_bytes),
      }
    : null;
}

/**
 * Final byte-delivery gate for an already-consumed Agent Auth transfer ticket.
 *
 * Object storage and archive conversion happen outside the consume transaction. Resolve the ticket
 * hash again immediately before responding so revocation or expiry during that interval fails closed.
 */
export async function revalidateAgentTransferTicket(input: {
  ticket: string;
  database?: Db;
}): Promise<boolean> {
  if (!input.ticket.startsWith(PUBLIC_SKILL_TRANSFER_TICKET_PREFIX)) return false;
  return revalidatePreTenantAgentTransferTicket(
    input.database ?? db,
    createHash("sha256").update(input.ticket).digest("hex"),
  );
}

/** Revocation hook for Connected agents: invalidates unconsumed tickets immediately. */
export async function revokeAgentTransferTickets(input: {
  userId: string;
  agentId: string;
  agentGrantId?: string | null;
  database?: Db;
}): Promise<number> {
  return revokePreTenantAgentTransferTickets(input.database ?? db, input);
}

/**
 * Authenticated share-link target resolver. Unlike the public preview, this returns the org id so the
 * web app can switch workspaces before opening the slug-keyed detail route. It only resolves when the
 * actor is already a member of the token's org.
 */
export async function getSkillShareTargetByShareToken(input: {
  actor: ActorContext;
  token: string;
  database?: Db;
}): Promise<SkillShareTarget | null> {
  const token = input.token.trim();
  if (!token) return null;
  const database = input.database ?? db;
  const row = await getPreTenantSkillShareTarget(database, token, input.actor.id);
  return row ? { org_id: row.org_id, slug: row.slug } : null;
}

const EMPTY_SKILL_FILTER_PREFERENCES: SkillFilterPreferences = {
  active_filters: [],
  group_by: "folder",
  sidebar_order: { mine: [], org: [] },
};

/**
 * Drop persisted filters that no longer exist. Surviving filter types are passed through; the zod
 * schema validates the result.
 */
function normalizePersistedSkillFilter(value: unknown): unknown | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const filter = value as Record<string, unknown>;
  if (
    filter.type === "scope" ||
    filter.type === "visibility" ||
    filter.type === "owner" ||
    filter.type === "team" ||
    filter.type === "starred"
  ) {
    return null;
  }
  return value;
}

function normalizePersistedSkillPreferences(input: {
  activeFilters: unknown[];
  groupBy?: unknown;
  sidebarOrder?: unknown;
}) {
  const norm = (arr: unknown[]) => arr.map(normalizePersistedSkillFilter).filter((f) => f != null);
  return {
    active_filters: norm(input.activeFilters),
    group_by: input.groupBy ?? "folder",
    sidebar_order: input.sidebarOrder ?? { mine: [], org: [] },
  };
}

export async function getSkillFilterPreferences(input: {
  actor: ActorContext;
  orgId: string;
  database?: Db;
}): Promise<SkillFilterPreferences> {
  const database = input.database ?? db;
  await assertMember(database, input.actor, input.orgId);
  const row = await database.query.skillFilterPreferences.findFirst({
    where: and(
      eq(schema.skillFilterPreferences.orgId, input.orgId),
      eq(schema.skillFilterPreferences.userId, input.actor.id),
    ),
  });
  if (!row) return EMPTY_SKILL_FILTER_PREFERENCES;
  return skillFilterPreferencesSchema.parse(normalizePersistedSkillPreferences(row));
}

export async function setSkillFilterPreferences(input: {
  actor: ActorContext;
  orgId: string;
  preferences: SkillFilterPreferencesInput;
  database?: Db;
}): Promise<SkillFilterPreferences> {
  const database = input.database ?? db;
  await assertMember(database, input.actor, input.orgId);
  const preferences = skillFilterPreferencesInputSchema.parse(input.preferences);
  await database
    .insert(schema.skillFilterPreferences)
    .values({
      orgId: input.orgId,
      userId: input.actor.id,
      activeFilters: preferences.active_filters,
      groupBy: preferences.group_by,
      sidebarOrder: preferences.sidebar_order ?? EMPTY_SKILL_FILTER_PREFERENCES.sidebar_order,
    })
    .onConflictDoUpdate({
      target: [schema.skillFilterPreferences.orgId, schema.skillFilterPreferences.userId],
      set: {
        activeFilters: preferences.active_filters,
        groupBy: preferences.group_by,
        ...(preferences.sidebar_order ? { sidebarOrder: preferences.sidebar_order } : {}),
        updatedAt: new Date(),
      },
    });
  if (!preferences.sidebar_order) {
    return getSkillFilterPreferences({ actor: input.actor, orgId: input.orgId, database });
  }
  return skillFilterPreferencesSchema.parse(preferences);
}

export async function getSkillBySlug(input: {
  actor: ActorContext;
  orgId: string;
  slug: string;
  database?: Db;
}): Promise<SkillListRow | null> {
  const database = input.database ?? db;
  const entitlements = await getEntitlements({ orgId: input.orgId, database });
  if (!entitlements.personalSkills) {
    const hidden = await database.query.skills.findFirst({
      where: and(
        eq(schema.skills.orgId, input.orgId),
        eq(schema.skills.slug, input.slug),
        eq(schema.skills.scope, "personal"),
        eq(schema.skills.creatorId, input.actor.id),
      ),
    });
    if (hidden) await assertPersonalSkillsEntitled({ orgId: input.orgId, database });
  }
  // Resolve by slug across both live and archived skills — archived ones stay viewable. Uses the
  // `accessible` library so an org skill resolves for anyone and a personal skill only for its owner
  // (every single-skill mutation — install/archive/share/dependencies — funnels through here).
  const rows = await listSkills({
    ...input,
    library: "accessible",
    includeArchived: true,
    database,
  });
  return rows.find((r) => r.slug === input.slug) ?? null;
}

/**
 * Resolve a skill by its workspace id (== `companion.json metadata.companionSkillId`). Uses the same
 * `accessible` visibility + archived inclusion as {@link getSkillBySlug}, so personal-skill privacy and
 * archived resolution behave identically — the publish anti-retarget guard relies on this to detect a
 * package whose declared Companion skill id belongs to a different (or another member's) skill.
 */
export async function getSkillById(input: {
  actor: ActorContext;
  orgId: string;
  id: string;
  database?: Db;
}): Promise<SkillListRow | null> {
  const rows = await listSkills({
    actor: input.actor,
    orgId: input.orgId,
    library: "accessible",
    includeArchived: true,
    database: input.database ?? db,
  });
  return rows.find((r) => r.id === input.id) ?? null;
}

async function listAccessibleSkillReferences(input: {
  actor: ActorContext;
  orgId: string;
  database: Db;
}): Promise<Array<{ id: string; slug: string }>> {
  const predicate = await visibleSkillPredicate(input.database, input.actor, input.orgId, "accessible");
  const rows = await input.database
    .select({
      id: schema.skills.id,
      slug: schema.skills.slug,
    })
    .from(schema.skills)
    .where(predicate);
  return Array.isArray(rows) ? rows : [];
}

export interface ResolvedSkillDependency {
  /** Slug declared by the caller/package before any id-backed rename normalization. */
  declaredSlug: string;
  /** Current workspace slug used for preflight, package normalization, and persisted manifests. */
  slug: string;
  /** Stable target id when the dependency currently resolves; null means unresolved/missing. */
  skillId: string | null;
}

export function resolvedDependencySlugs(dependencies: ResolvedSkillDependency[]): string[] {
  return [...new Set(dependencies.map((dependency) => dependency.slug))];
}

export function resolvedDependencyIdMap(dependencies: ResolvedSkillDependency[]): Record<string, string> {
  return Object.fromEntries(
    dependencies
      .filter((dependency): dependency is ResolvedSkillDependency & { skillId: string } => !!dependency.skillId)
      .map((dependency) => [dependency.slug, dependency.skillId] as const),
  );
}

export interface SkillPublishDependencies {
  /** Canonical dependency refs, normalized id-first for renamed skills. */
  references: ResolvedSkillDependency[];
  /** Current dependency slugs used for public plans and persisted manifests. */
  slugs: string[];
  /** companion.json dependency map keyed by current slug and valued by stable skill id. */
  manifestDependencies: Record<string, string>;
}

function skillPublishDependenciesFromResolved(references: ResolvedSkillDependency[]): SkillPublishDependencies {
  return {
    references,
    slugs: resolvedDependencySlugs(references),
    manifestDependencies: resolvedDependencyIdMap(references),
  };
}

export async function resolveDependencyReferences(input: {
  actor: ActorContext;
  orgId: string;
  slugs: string[];
  manifest?: CompanionManifest;
  database?: Db;
}): Promise<ResolvedSkillDependency[]> {
  const database = input.database ?? db;
  if (!input.slugs.length) return [];
  const skills = await listAccessibleSkillReferences({
    actor: input.actor,
    orgId: input.orgId,
    database,
  });
  const byId = new Map(skills.map((skill) => [skill.id, skill] as const));
  const bySlug = new Map(skills.map((skill) => [skill.slug, skill] as const));
  const resolved = new Map<string, ResolvedSkillDependency>();
  for (const slug of input.slugs) {
    const declaredId = input.manifest?.dependencies[slug];
    if (declaredId) {
      const skillById = byId.get(declaredId);
      if (skillById) {
        resolved.set(skillById.slug, { declaredSlug: slug, slug: skillById.slug, skillId: skillById.id });
        continue;
      }
    }

    const skillBySlug = bySlug.get(slug);
    if (declaredId && skillBySlug && skillBySlug.id !== declaredId) {
      throw new Error(`dependency "${slug}" id does not match the workspace skill`);
    }
    resolved.set(slug, { declaredSlug: slug, slug, skillId: skillBySlug?.id ?? null });
  }
  return [...resolved.values()];
}

export async function prepareSkillPublishDependencies(input: {
  actor: ActorContext;
  orgId: string;
  slugs: string[];
  manifest?: CompanionManifest;
  database?: Db;
}): Promise<SkillPublishDependencies> {
  return skillPublishDependenciesFromResolved(await resolveDependencyReferences(input));
}

export async function listSkillVersions(input: {
  actor: ActorContext;
  orgId: string;
  slug: string;
  database?: Db;
}): Promise<SkillVersionRow[]> {
  const database = input.database ?? db;
  const skill = await getSkillBySlug(input);
  if (!skill) throw new Error("skill not found");
  const rows = await database
    .select()
    .from(schema.skillVersions)
    .where(and(eq(schema.skillVersions.orgId, input.orgId), eq(schema.skillVersions.skillId, skill.id)))
    .orderBy(desc(schema.skillVersions.createdAt));
  const entitlements = await getEntitlements({ orgId: input.orgId, database });
  const visibleRows = entitlements.skillHistory ? rows : rows.slice(0, 1);
  // Per-version attribution: resolve the member who published each version (name/initials/avatar).
  const authorById = await loadVersionAuthors(database, visibleRows.map((r) => r.createdBy));
  return visibleRows.map((r) => skillVersionRowFromRecord(r, skill, authorById.get(r.createdBy) ?? null));
}

/** Display fields for a version publisher, with the avatar already resolved (custom or Gravatar). */
type VersionAuthor = { name: string; initials: string; avatarUrl: string };

/**
 * Batch-load the `profiles` of version publishers, keyed by user id. Mirrors `loadCommentImages`'s
 * `Array.isArray` defensiveness so a hand-rolled fakeDb that doesn't implement this extra query
 * degrades to no-author (null display fields) rather than throwing in unrelated suites.
 */
async function loadVersionAuthors(database: Db, userIds: string[]): Promise<Map<string, VersionAuthor>> {
  const byId = new Map<string, VersionAuthor>();
  const ids = [...new Set(userIds)];
  if (ids.length === 0) return byId;
  const rows = await database
    .select({
      id: schema.profiles.id,
      name: schema.profiles.name,
      initials: schema.profiles.initials,
      email: schema.profiles.email,
      avatarUrl: schema.profiles.avatarUrl,
      updatedAt: schema.profiles.updatedAt,
    })
    .from(schema.profiles)
    .where(inArray(schema.profiles.id, ids));
  if (!Array.isArray(rows)) return byId;
  for (const r of rows) {
    byId.set(r.id, {
      name: r.name,
      initials: r.initials,
      avatarUrl: resolveUserAvatarUrl({
        userId: r.id,
        email: r.email,
        avatarUrl: r.avatarUrl ?? null,
        updatedAtEpoch: r.updatedAt instanceof Date ? r.updatedAt.getTime() : 0,
      }),
    });
  }
  return byId;
}

export function skillVersionRowFromRecord(
  r: typeof schema.skillVersions.$inferSelect,
  skill: Pick<SkillListRow, "description">,
  author?: VersionAuthor | null,
): SkillVersionRow {
  const manifest = parseStoredSkillFrontmatter(r.frontmatter);
  const companion = parseStoredCompanionManifest(r.frontmatter, skill.description);
  return {
    id: r.id,
    skill_id: r.skillId,
    version: r.version,
    note: r.note,
    changelog: companion.metadata.changelog.find((entry) => entry.version === r.version) ?? null,
    frontmatter: r.frontmatter,
    tools: r.tools.length ? r.tools : parseAllowedTools(manifest?.["allowed-tools"]),
    license: r.license ?? manifest?.license ?? null,
    compatibility: manifest?.compatibility ?? null,
    metadata: manifest?.metadata ?? {},
    display: companion.display,
    requirements: companion.requirements,
    size_bytes: r.sizeBytes,
    checksum: r.checksum,
    storage_path: r.storagePath,
    validation: r.validation,
    validation_error: r.validationError,
    created_by: r.createdBy,
    created_by_name: author?.name ?? null,
    created_by_initials: author?.initials ?? null,
    created_by_avatar_url: author?.avatarUrl ?? null,
    created_at: r.createdAt.toISOString(),
  };
}

/** Shape a stored `skill_comment_images` row into the API/view-model image (with its serve `url`). */
function toCommentImage(
  slug: string,
  commentId: string,
  img: { id: string; contentType: string; byteSize: number; position: number },
): SkillCommentImage {
  return {
    id: img.id,
    content_type: img.contentType,
    byte_size: img.byteSize,
    position: img.position,
    url: commentImagePublicPath(slug, commentId, img.id),
  };
}

/** Fetch every comment image for the given comment ids, grouped by `comment_id` and ordered. */
async function loadCommentImages(
  database: Db,
  orgId: string,
  slug: string,
  commentIds: string[],
): Promise<Map<string, SkillCommentImage[]>> {
  const byComment = new Map<string, SkillCommentImage[]>();
  if (commentIds.length === 0) return byComment;
  const rows = await database
    .select({
      id: schema.skillCommentImages.id,
      commentId: schema.skillCommentImages.commentId,
      contentType: schema.skillCommentImages.contentType,
      byteSize: schema.skillCommentImages.byteSize,
      position: schema.skillCommentImages.position,
    })
    .from(schema.skillCommentImages)
    .where(
      and(
        eq(schema.skillCommentImages.orgId, orgId),
        inArray(schema.skillCommentImages.commentId, commentIds),
      ),
    )
    // Group key first, then intra-comment order, so each comment's images come out 0..n-1.
    .orderBy(asc(schema.skillCommentImages.commentId), asc(schema.skillCommentImages.position));
  // Defensive against hand-rolled fakeDbs that may not return an array for this extra query.
  if (!Array.isArray(rows)) return byComment;
  for (const r of rows) {
    const list = byComment.get(r.commentId);
    const img = toCommentImage(slug, r.commentId, r);
    if (list) list.push(img);
    else byComment.set(r.commentId, [img]);
  }
  return byComment;
}

export async function listSkillComments(input: {
  actor: ActorContext;
  orgId: string;
  slug: string;
  database?: Db;
}): Promise<SkillCommentRow[]> {
  const database = input.database ?? db;
  const skill = await getSkillBySlug(input);
  if (!skill) throw new Error("skill not found");
  const rows = await database
    .select({
      id: schema.skillComments.id,
      skill_id: schema.skillComments.skillId,
      author_id: schema.skillComments.authorId,
      body: schema.skillComments.body,
      created_at: schema.skillComments.createdAt,
      author_name: schema.profiles.name,
      author_initials: schema.profiles.initials,
      author_email: schema.profiles.email,
      author_avatar_url_raw: schema.profiles.avatarUrl,
      author_updated_at: schema.profiles.updatedAt,
      parent_id: schema.skillComments.parentId,
      version_id: schema.skillComments.versionId,
      version: schema.skillVersions.version,
      deprecated: schema.skillComments.deprecated,
    })
    .from(schema.skillComments)
    .innerJoin(schema.profiles, eq(schema.profiles.id, schema.skillComments.authorId))
    .leftJoin(schema.skillVersions, eq(schema.skillVersions.id, schema.skillComments.versionId))
    .where(and(eq(schema.skillComments.orgId, input.orgId), eq(schema.skillComments.skillId, skill.id)))
    .orderBy(asc(schema.skillComments.createdAt));
  const imagesByComment = await loadCommentImages(
    database,
    input.orgId,
    input.slug,
    rows.map((r) => r.id),
  );
  return rows.map((r) => {
    // Resolve the author avatar server-side and DROP the email (never leak it to the client).
    const { author_email, author_avatar_url_raw, author_updated_at, ...rest } = r;
    return {
      ...rest,
      created_at: r.created_at.toISOString(),
      // A null version_id is always global; otherwise the leftJoin label (null if the version is gone).
      version: r.version_id ? r.version : null,
      author_avatar_url: resolveUserAvatarUrl({
        userId: r.author_id,
        email: author_email ?? "",
        avatarUrl: author_avatar_url_raw ?? null,
        updatedAtEpoch: author_updated_at instanceof Date ? author_updated_at.getTime() : 0,
      }),
      images: imagesByComment.get(r.id) ?? [],
    };
  });
}

/**
 * Validate that a new comment / reply targets an accessible skill and a valid (same-skill) version or
 * parent thread, without writing anything. Returns the resolved skill plus the effective version id
 * and label. Shared by `addComment` and the API multipart path, which validates the target BEFORE
 * uploading any image bytes (so an inaccessible/invalid target never triggers object writes).
 * Cross-skill / cross-tenant integrity is not FK-enforceable, so it is checked here.
 */
export async function assertCommentTarget(input: {
  actor: ActorContext;
  orgId: string;
  slug: string;
  parentId?: string | null;
  versionId?: string | null;
  database?: Db;
}): Promise<{
  skill: NonNullable<Awaited<ReturnType<typeof getSkillBySlug>>>;
  versionId: string | null;
  versionLabel: string | null;
}> {
  const database = input.database ?? db;
  const skill = await getSkillBySlug(input);
  if (!skill) throw new Error("skill not found");

  // A reply inherits its thread context, so any caller-supplied versionId is ignored for replies.
  const versionId = input.parentId ? null : input.versionId ?? null;
  let versionLabel: string | null = null;

  if (versionId) {
    const version = await database.query.skillVersions.findFirst({
      where: and(
        eq(schema.skillVersions.id, versionId),
        eq(schema.skillVersions.orgId, input.orgId),
        eq(schema.skillVersions.skillId, skill.id),
      ),
    });
    if (!version) throw new Error("version does not belong to this skill");
    versionLabel = version.version;
  }

  if (input.parentId) {
    const parent = await database.query.skillComments.findFirst({
      where: and(
        eq(schema.skillComments.id, input.parentId),
        eq(schema.skillComments.orgId, input.orgId),
        eq(schema.skillComments.skillId, skill.id),
      ),
    });
    // Single-level nesting only: a reply must target an existing same-skill root thread.
    if (!parent || parent.parentId !== null) throw new Error("invalid parent comment");
  }

  return { skill, versionId, versionLabel };
}

export async function addComment(input: {
  actor: ActorContext;
  orgId: string;
  slug: string;
  body: string;
  parentId?: string | null;
  versionId?: string | null;
  /** Already-uploaded image attachments (the API stores the bytes in S3 before calling this). */
  images?: Array<{ id: string; storageKey: string; contentType: string; byteSize: number }>;
  database?: Db;
}): Promise<SkillCommentRow> {
  const database = input.database ?? db;
  const { skill, versionId, versionLabel } = await assertCommentTarget(input);

  const attachments = input.images ?? [];

  // Enforce the attachment invariants here, in the canonical write path, so every caller (web, REST,
  // future workers) shares one guard rather than relying on each route handler to re-check.
  if (attachments.length > MAX_COMMENT_IMAGES) {
    throw new Error(`a comment can have at most ${MAX_COMMENT_IMAGES} images`);
  }
  for (const img of attachments) {
    if (!(COMMENT_IMAGE_MIME_TYPES as readonly string[]).includes(img.contentType)) {
      throw new Error("unsupported comment image type");
    }
    if (img.byteSize <= 0 || img.byteSize > MAX_COMMENT_IMAGE_BYTES) {
      throw new Error("comment image exceeds the size limit");
    }
  }

  // Insert the comment and its image metadata atomically: a failed image insert must not leave a
  // text-only comment behind (callers also wrap this in withTenantContext, so the inner tx nests as
  // a savepoint). The bytes are already in object storage; only metadata is persisted here.
  const row = await database.transaction(async (tx) => {
    const [created] = await tx
      .insert(schema.skillComments)
      .values({
        orgId: input.orgId,
        skillId: skill.id,
        authorId: input.actor.id,
        body: input.body,
        parentId: input.parentId ?? null,
        versionId,
      })
      .returning();
    if (!created) throw new Error("could not add comment");
    if (attachments.length) {
      await tx.insert(schema.skillCommentImages).values(
        attachments.map((img, i) => ({
          id: img.id,
          orgId: input.orgId,
          commentId: created.id,
          skillId: skill.id,
          storageKey: img.storageKey,
          contentType: img.contentType,
          byteSize: img.byteSize,
          position: i,
        })),
      );
    }
    return created;
  });

  const images: SkillCommentImage[] = attachments.map((img, i) =>
    toCommentImage(input.slug, row.id, {
      id: img.id,
      contentType: img.contentType,
      byteSize: img.byteSize,
      position: i,
    }),
  );

  return {
    id: row.id,
    skill_id: row.skillId,
    author_id: row.authorId,
    body: row.body,
    created_at: row.createdAt.toISOString(),
    parent_id: row.parentId,
    version_id: row.versionId,
    version: versionLabel,
    deprecated: row.deprecated,
    images,
  };
}

/**
 * Deprecate (or restore) a comment thread. Threads are never deleted — a deprecated thread is
 * greyed/struck-through. Skills are flat: any org member may deprecate/restore any thread (the
 * skill carries no owner). Returns the updated extended row (author display fields + version label).
 */
export async function setCommentDeprecated(input: {
  actor: ActorContext;
  orgId: string;
  slug: string;
  commentId: string;
  deprecated: boolean;
  database?: Db;
}): Promise<SkillCommentRow> {
  const database = input.database ?? db;
  const skill = await getSkillBySlug(input);
  if (!skill) throw new Error("skill not found");

  const comment = await database.query.skillComments.findFirst({
    where: and(
      eq(schema.skillComments.id, input.commentId),
      eq(schema.skillComments.orgId, input.orgId),
      eq(schema.skillComments.skillId, skill.id),
    ),
  });
  if (!comment) throw new Error("comment not found");

  await assertMember(database, input.actor, input.orgId);

  const [updated] = await database
    .update(schema.skillComments)
    .set({ deprecated: input.deprecated })
    .where(and(eq(schema.skillComments.id, comment.id), eq(schema.skillComments.orgId, input.orgId)))
    .returning();
  if (!updated) throw new Error("could not update comment");

  const author = await database.query.profiles.findFirst({
    where: eq(schema.profiles.id, updated.authorId),
  });
  let versionLabel: string | null = null;
  if (updated.versionId) {
    const version = await database.query.skillVersions.findFirst({
      where: eq(schema.skillVersions.id, updated.versionId),
    });
    versionLabel = version?.version ?? null;
  }
  const imagesByComment = await loadCommentImages(database, input.orgId, input.slug, [updated.id]);
  return {
    id: updated.id,
    skill_id: updated.skillId,
    author_id: updated.authorId,
    body: updated.body,
    created_at: updated.createdAt.toISOString(),
    author_name: author?.name ?? null,
    author_initials: author?.initials ?? null,
    parent_id: updated.parentId,
    version_id: updated.versionId,
    version: versionLabel,
    deprecated: updated.deprecated,
    images: imagesByComment.get(updated.id) ?? [],
  };
}

/**
 * Resolve a comment image attachment for serving. Gated by skill visibility (an invisible skill
 * resolves to "skill not found") and scoped to the (org, skill, comment) the image belongs to.
 * Returns the storage key + content type so the API can stream the object.
 */
export async function getCommentImageAsset(input: {
  actor: ActorContext;
  orgId: string;
  slug: string;
  commentId: string;
  imageId: string;
  database?: Db;
}): Promise<{ storageKey: string; contentType: string }> {
  const database = input.database ?? db;
  const skill = await getSkillBySlug(input);
  if (!skill) throw new Error("skill not found");
  const image = await database.query.skillCommentImages.findFirst({
    where: and(
      eq(schema.skillCommentImages.id, input.imageId),
      eq(schema.skillCommentImages.commentId, input.commentId),
      eq(schema.skillCommentImages.orgId, input.orgId),
      eq(schema.skillCommentImages.skillId, skill.id),
    ),
  });
  if (!image) throw new Error("image not found");
  return { storageKey: image.storageKey, contentType: image.contentType };
}

export async function publishSkillVersion(input: {
  actor: ActorContext;
  orgId: string;
  payload: PublishSkillInput;
  archiveKey: string;
  dependencies?: SkillPublishDependencies;
  database?: Db;
}): Promise<{ id: string; version: string }> {
  const database = input.database ?? db;
  const parsedPayload = publishSkillInputSchema.parse({ ...input.payload, storage_path: input.archiveKey });
  const dependencies =
    input.dependencies ??
    (await prepareSkillPublishDependencies({
      actor: input.actor,
      orgId: input.orgId,
      slugs: parsedPayload.dependencies,
      database,
    }));
  const payload = publishSkillInputSchema.parse({
    ...parsedPayload,
    dependencies: dependencies.slugs,
  });
  await assertCanPublishSkillVersion({ actor: input.actor, orgId: input.orgId, payload, database });
  // Required dependencies must resolve (no missing/cycle) before we write anything. Skills are flat,
  // so there is no owner-cover constraint — only existence + cycle checks remain.
  await assertDependenciesResolvable({
    actor: input.actor,
    orgId: input.orgId,
    slug: payload.slug,
    dependencies: payload.dependencies,
    database,
  });

  return database.transaction(async (tx) => {
    const publishPayload = publishSkillInputSchema.parse({ ...payload, storage_path: input.archiveKey });
    return writeSkillVersion({
      actor: input.actor,
      orgId: input.orgId,
      payload: publishPayload,
      archiveKey: input.archiveKey,
      dependencies,
      database: tx as unknown as Db,
    });
  });
}

export async function assertCanPublishSkillVersion(input: {
  actor: ActorContext;
  orgId: string;
  payload: PublishSkillInput;
  database?: Db;
}): Promise<void> {
  const database = input.database ?? db;
  const payload = publishSkillInputSchema.parse(input.payload);
  // Skills are flat: any member may create OR re-publish any skill. Membership is the only gate.
  await assertMember(database, input.actor, input.orgId);

  const existing = await database.query.skills.findFirst({
    where: and(eq(schema.skills.orgId, input.orgId), eq(schema.skills.slug, payload.slug)),
  });
  if (existing?.scope === "personal" && existing.creatorId !== input.actor.id) {
    throw new Error(`a skill named ${payload.slug} already exists in this workspace`);
  }
  const targetScope = existing?.scope ?? payload.scope ?? "org";
  if (targetScope === "personal") {
    await assertPersonalSkillsEntitled({ orgId: input.orgId, database });
  } else {
    await assertOrgSkillMutationEntitled({
      orgId: input.orgId,
      feature: existing ? "org_skill_publish" : "org_skill_create",
      isCreate: !existing,
      database,
    });
  }
  if (existing) {
    // Slugs are workspace-unique across scopes. A non-owner can neither see nor re-publish another
    // member's personal skill, and you cannot publish over a skill of a different scope (Share is the
    // only personal→org transition). Surface a generic name-collision error so a private skill is
    // never revealed.
    if (payload.scope && payload.scope !== existing.scope) {
      throw new Error(`a skill named ${payload.slug} already exists in this workspace`);
    }
    if (payload.skill_id && payload.skill_id !== existing.id) {
      throw new Error("skill_id does not match existing skill");
    }
    const versions = await database
      .select({ version: schema.skillVersions.version })
      .from(schema.skillVersions)
      .where(and(eq(schema.skillVersions.orgId, input.orgId), eq(schema.skillVersions.skillId, existing.id)));
    if (versions.some((v) => v.version === payload.version)) throw new Error("version already exists");
    const latest = versions.map((v) => v.version).sort((a, b) => compareSemver(b, a))[0];
    if (latest && compareSemver(payload.version, latest) <= 0) throw new Error("version must increase monotonically");
  }
}

async function writeSkillVersion(input: {
  actor: ActorContext;
  orgId: string;
  payload: PublishSkillInput;
  archiveKey: string;
  dependencies: SkillPublishDependencies;
  database: Db;
}): Promise<{ id: string; version: string }> {
  const database = input.database;
  const payload = input.payload;
  await assertMember(database, input.actor, input.orgId);
  const existing = await database.query.skills.findFirst({
    where: and(eq(schema.skills.orgId, input.orgId), eq(schema.skills.slug, payload.slug)),
  });
  const targetScope = existing?.scope ?? payload.scope ?? "org";
  if (targetScope === "personal") {
    await assertPersonalSkillsEntitled({ orgId: input.orgId, database });
  } else {
    await assertOrgSkillMutationEntitled({
      orgId: input.orgId,
      feature: existing ? "org_skill_publish" : "org_skill_create",
      isCreate: !existing,
      database,
      lock: true,
    });
  }
  if (existing && payload.skill_id && payload.skill_id !== existing.id) {
    throw new Error("skill_id does not match existing skill");
  }

  // `creator_id` (provenance/Activity) is set only on insert — it never changes on re-publish.
  const [skill] = existing
    ? await database
        .update(schema.skills)
        .set({
          description: payload.description,
          validation: "valid",
          validationError: null,
          updatedAt: new Date(),
        })
        .where(eq(schema.skills.id, existing.id))
        .returning()
    : await database
        .insert(schema.skills)
        .values({
          ...(payload.skill_id ? { id: payload.skill_id } : {}),
          orgId: input.orgId,
          slug: payload.slug,
          description: payload.description,
          creatorId: input.actor.id,
          // First create chooses the library; omitted defaults to 'org' (CLI/bundled-skill behavior).
          // Re-publish (the UPDATE branch above) never changes scope — only Share moves personal→org.
          scope: payload.scope ?? "org",
          validation: "valid",
        })
        .returning();
  if (!skill) throw new Error("could not write skill");

  // Apply the requested label paths on CREATE only (re-publish never re-files an existing skill).
  // Materialize each path + its ancestors so the folder exists in the tree, then add the assignment
  // edges. Org skills file into the shared `labels` / `skill_labels`; a personal skill files into the
  // owner's private `personal_labels` / `personal_skill_labels`. Idempotent inserts.
  if (!existing && payload.labels.length) {
    const paths = [...new Set(payload.labels)];
    const folderPaths = new Set<string>();
    for (const path of paths) {
      const segments = path.split("/");
      for (let i = 1; i <= segments.length; i++) folderPaths.add(segments.slice(0, i).join("/"));
    }
    if ((payload.scope ?? "org") === "personal") {
      for (const path of folderPaths) {
        await database
          .insert(schema.personalLabels)
          .values({ orgId: input.orgId, ownerId: input.actor.id, path })
          .onConflictDoNothing({
            target: [schema.personalLabels.orgId, schema.personalLabels.ownerId, schema.personalLabels.path],
          });
      }
      await database
        .insert(schema.personalSkillLabels)
        .values(paths.map((path) => ({ orgId: input.orgId, ownerId: input.actor.id, skillId: skill.id, path })))
        .onConflictDoNothing({
          target: [
            schema.personalSkillLabels.orgId,
            schema.personalSkillLabels.ownerId,
            schema.personalSkillLabels.skillId,
            schema.personalSkillLabels.path,
          ],
        });
    } else {
      for (const path of folderPaths) {
        await database
          .insert(schema.labels)
          .values({ orgId: input.orgId, path, createdBy: input.actor.id })
          .onConflictDoNothing({ target: [schema.labels.orgId, schema.labels.path] });
      }
      await database
        .insert(schema.skillLabels)
        .values(
          paths.map((path) => ({ orgId: input.orgId, skillId: skill.id, path, createdBy: input.actor.id })),
        )
        .onConflictDoNothing({
          target: [schema.skillLabels.orgId, schema.skillLabels.skillId, schema.skillLabels.path],
        });
    }
  }

  const [version] = await database
    .insert(schema.skillVersions)
    .values({
      orgId: input.orgId,
      skillId: skill.id,
      version: payload.version,
      note: payload.note,
      frontmatter: payload.frontmatter,
      body: payload.body,
      tools: payload.tools,
      license: payload.license ?? null,
      sizeBytes: payload.size_bytes,
      checksum: payload.checksum,
      storagePath: input.archiveKey,
      validation: "valid",
      createdBy: input.actor.id,
    })
    .returning();
  if (!version) throw new Error("could not write skill version");

  await persistSkillSecretSlots({
    orgId: input.orgId,
    skillId: skill.id,
    skillVersionId: version.id,
    frontmatter: payload.frontmatter,
    database,
  });
  await persistSkillDatabaseDeclarations({
    orgId: input.orgId,
    skillId: skill.id,
    frontmatter: payload.frontmatter,
    database,
  });

  await database
    .update(schema.skills)
    .set({ currentVersionId: version.id, updatedAt: new Date() })
    .where(eq(schema.skills.id, skill.id));

  // Persist this version's dependency edges (un-versioned skill→skill links). Resolve each declared
  // slug to a current skill id, scoped to skills the actor can read so an edge can never bind to a
  // hidden skill; an unresolved slug is stored with a null target (a "missing" dep). Gate on the
  // self-filtered set so a self-only declaration never asks Drizzle to insert an empty values array.
  const declaredDeps = [...new Set(payload.dependencies)].filter((slug) => slug !== payload.slug);
  const dependencyIds = input.dependencies.manifestDependencies;
  if (declaredDeps.length) {
    await database.insert(schema.skillVersionDependencies).values(
      declaredDeps.map((slug) => ({
        orgId: input.orgId,
        skillVersionId: version.id,
        skillId: skill.id,
        dependsOnSlug: slug,
        dependsOnSkillId: dependencyIds[slug] ?? null,
      })),
    );
  }

  await database.insert(schema.auditLog).values({
    orgId: input.orgId,
    actorId: input.actor.id,
    action: "skill.publish",
    targetType: "skill",
    targetId: skill.id,
    metadata: { slug: payload.slug, version: payload.version, labels: payload.labels, dependencies: payload.dependencies },
  });
  if (skill.scope === "org") await enqueueGitHubAfterOrgSkillMutation(database, input.orgId);
  return { id: skill.id, version: version.version };
}

export async function createInvitation(input: {
  actor: ActorContext;
  orgId: string;
  email: string;
  role: Exclude<OrgRole, "owner">;
  acknowledgeSeatBilling?: boolean;
  database?: Db;
}): Promise<{ id: string; token: string }> {
  const database = input.database ?? db;
  const role = await getOrgRole(input.orgId, input.actor.id, database);
  if (!role || !canManageOrg(role)) throw new Error("not allowed to invite members");
  const entitlements = await getEntitlements({ orgId: input.orgId, database });
  if (entitlements.billingMode === "stripe" && entitlements.computedPlan === "pro" && !input.acknowledgeSeatBilling) {
    throw new Error("acknowledgeSeatBilling is required because an accepted invitation adds a $10/month prorated seat");
  }
  const token = crypto.randomUUID().replaceAll("-", "");
  const [invite] = await database.insert(schema.invitations).values({
    orgId: input.orgId,
    email: input.email.toLowerCase(),
    orgRole: input.role,
    token,
    createdBy: input.actor.id,
    expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24 * 14),
  }).returning({ id: schema.invitations.id });
  if (!invite) throw new Error("could not create invitation");
  return { id: invite.id, token };
}

export async function acceptInvitation(input: {
  actor: ActorContext;
  token: string;
  database?: Db;
}): Promise<{ orgId: string }> {
  const database = input.database ?? db;
  const orgId = await database.transaction(async (tx) => {
    const invite = await lockPreTenantInvitation({
      database: tx as unknown as Db,
      userId: input.actor.id,
      token: input.token,
    });
    if (!invite) throw new Error("invite not found or expired");
    await tx.execute(
      sql`select set_config('app.org_id', ${invite.orgId}, true), set_config('app.user_id', ${input.actor.id}, true)`,
    );
    await tx
      .insert(schema.memberships)
      .values({ orgId: invite.orgId, userId: input.actor.id, orgRole: invite.orgRole })
      .onConflictDoNothing();
    await tx.update(schema.invitations).set({ status: "accepted" }).where(eq(schema.invitations.id, invite.inviteId));
    // Accepting an invite means the user has joined an org — they skip the onboarding flow.
    await tx
      .update(schema.profiles)
      .set({ onboardedAt: new Date() })
      .where(and(eq(schema.profiles.id, input.actor.id), isNull(schema.profiles.onboardedAt)));
    await markSeatSyncPending(invite.orgId, tx as unknown as Db);
    return invite.orgId;
  });
  return { orgId };
}

export async function getDownloadVersion(input: {
  actor: ActorContext;
  orgId: string;
  slug: string;
  version?: string | null;
  /** Apply public-release creator/Admin/Owner, org-scope, archive, and current-version preflight. */
  forPublicRelease?: boolean;
  database?: Db;
}): Promise<{
  versionId: string;
  isCurrent: boolean;
  storagePath: string;
  version: string;
  checksum: string;
  sizeBytes: number;
  dependencies: string[];
}> {
  const database = input.database ?? db;
  const publicReleaseSkill = input.forPublicRelease
    ? (await publicReleaseSkillForActor({
        actor: input.actor,
        orgId: input.orgId,
        slug: input.slug,
        database,
      })).skill
    : null;
  if (publicReleaseSkill?.archivedAt) {
    throw new SkillPublicReleaseConflictError("restore the skill before making a version public");
  }
  if (publicReleaseSkill) {
    const preparedVersion = await database.query.skillVersions.findFirst({
      where: and(
        eq(schema.skillVersions.orgId, input.orgId),
        eq(schema.skillVersions.skillId, publicReleaseSkill.id),
        input.version
          ? eq(schema.skillVersions.version, input.version)
          : eq(schema.skillVersions.id, publicReleaseSkill.currentVersionId!),
      ),
    });
    if (!preparedVersion) throw new SkillPublicReleaseNotFoundError("skill version not found");
    if (publicReleaseSkill.currentVersionId !== preparedVersion.id) {
      throw new SkillPublicReleaseValidationError("only the current skill version can be made public");
    }
    return {
      versionId: preparedVersion.id,
      isCurrent: true,
      storagePath: preparedVersion.storagePath,
      version: preparedVersion.version,
      checksum: preparedVersion.checksum,
      sizeBytes: preparedVersion.sizeBytes,
      dependencies: [],
    };
  }
  // Archived skills stay downloadable ONLY while a published version still references them — across
  // ALL versions (an old published version may still declare a dependency the current one dropped),
  // so existing installs of that version never break. An unreferenced archived skill is not found.
  const visible = (
    await listSkills({ actor: input.actor, orgId: input.orgId, library: "accessible", includeArchived: true, database })
  ).find((s) => s.slug === input.slug);
  if (!visible) throw new Error("skill not found");
  if (visible.archived) {
    const referenced = await database
      .select({ one: sql<number>`1` })
      .from(schema.skillVersionDependencies)
      .where(
        and(
          eq(schema.skillVersionDependencies.orgId, input.orgId),
          or(
            eq(schema.skillVersionDependencies.dependsOnSkillId, visible.id),
            and(
              isNull(schema.skillVersionDependencies.dependsOnSkillId),
              eq(schema.skillVersionDependencies.dependsOnSlug, visible.slug),
            ),
          ),
        ),
      )
      .limit(1);
    if (referenced.length === 0) throw new Error("skill not found");
  }
  const versions = await listSkillVersions({ ...input, database });
  if (input.version && input.version !== visible.current_version) {
    await assertSkillHistoryEntitled({ orgId: input.orgId, database });
  }
  const row = input.version ? versions.find((v) => v.version === input.version) : versions[0];
  if (!row) throw new Error("version not found");
  const isCurrent = row.version === visible.current_version;
  const depRows = await database
    .select({
      slug: schema.skillVersionDependencies.dependsOnSlug,
      target_id: schema.skillVersionDependencies.dependsOnSkillId,
    })
    .from(schema.skillVersionDependencies)
    .where(
      and(
        eq(schema.skillVersionDependencies.orgId, input.orgId),
        eq(schema.skillVersionDependencies.skillVersionId, row.id),
      ),
    )
    .orderBy(asc(schema.skillVersionDependencies.dependsOnSlug));
  const targetIds = [
    ...new Set(depRows.map((d) => d.target_id).filter((id): id is string => !!id)),
  ];
  const targets = targetIds.length
    ? await database
        .select({ id: schema.skills.id, slug: schema.skills.slug })
        .from(schema.skills)
        .where(and(eq(schema.skills.orgId, input.orgId), inArray(schema.skills.id, targetIds)))
    : [];
  const currentSlugById = new Map((Array.isArray(targets) ? targets : []).map((t) => [t.id, t.slug] as const));
  return {
    versionId: row.id,
    isCurrent,
    storagePath: row.storage_path,
    version: row.version,
    checksum: row.checksum,
    sizeBytes: row.size_bytes,
    dependencies: depRows.map((d) => (d.target_id ? currentSlugById.get(d.target_id) ?? d.slug : d.slug)).sort((a, b) => a.localeCompare(b)),
  };
}

/* ---- Skill dependencies (un-versioned skill→skill links) + archive --------- */

interface DepGraphSkill {
  id: string;
  slug: string;
  scope: "personal" | "org";
  creatorId: string;
  archivedAt: Date | null;
  currentVersionId: string | null;
  /** Current published version string (null when no version), for org-wide update comparisons. */
  currentVersion: string | null;
}

interface DepEdge {
  skillId: string;
  declaredSlug: string;
  displaySlug: string;
  target: DepGraphSkill | null;
  /** Only unresolved legacy slug-only rows can be hydrated when a prospective publish creates slug. */
  legacyMissingSlug: string | null;
}

interface DepGraph {
  byId: Map<string, DepGraphSkill>;
  bySlug: Map<string, DepGraphSkill>;
  /** Current-version outgoing edges per dependent skill id. */
  requiresBySkill: Map<string, DepEdge[]>;
  /** Current-version incoming edges per target skill id. */
  dependentsByTarget: Map<string, { dependentId: string; edge: DepEdge }[]>;
}

function makeDepEdge(graph: Pick<DepGraph, "byId" | "bySlug">, input: {
  skillId: string;
  dependsOnSlug: string;
  dependsOnSkillId?: string | null;
}): DepEdge {
  const target = input.dependsOnSkillId
    ? graph.byId.get(input.dependsOnSkillId) ?? null
    : graph.bySlug.get(input.dependsOnSlug) ?? null;
  return {
    skillId: input.skillId,
    declaredSlug: input.dependsOnSlug,
    displaySlug: target?.slug ?? input.dependsOnSlug,
    target,
    legacyMissingSlug: target || input.dependsOnSkillId ? null : input.dependsOnSlug,
  };
}

/**
 * Load the org's *current-version* dependency graph once: every skill (live + archived) and the
 * dependency edges declared by each skill's current version. Used to derive live statuses
 * (satisfied / missing / archived / cycle) and counts. Skills are flat — no owner/visibility axis.
 */
async function loadDepGraph(database: Db, orgId: string): Promise<DepGraph> {
  const skillRowsRaw = await database
    .select({
      id: schema.skills.id,
      slug: schema.skills.slug,
      scope: schema.skills.scope,
      creatorId: schema.skills.creatorId,
      archivedAt: schema.skills.archivedAt,
      currentVersionId: schema.skills.currentVersionId,
      currentVersion: schema.skillVersions.version,
    })
    .from(schema.skills)
    .leftJoin(schema.skillVersions, eq(schema.skillVersions.id, schema.skills.currentVersionId))
    .where(eq(schema.skills.orgId, orgId));
  // Defensive: enrichment-only loader — never let a malformed result break list/detail reads.
  const skillRows = Array.isArray(skillRowsRaw) ? skillRowsRaw : [];

  const byId = new Map<string, DepGraphSkill>();
  const bySlug = new Map<string, DepGraphSkill>();
  for (const s of skillRows) {
    const entry: DepGraphSkill = {
      id: s.id,
      slug: s.slug,
      scope: s.scope,
      creatorId: s.creatorId,
      archivedAt: s.archivedAt,
      currentVersionId: s.currentVersionId,
      currentVersion: s.currentVersion ?? null,
    };
    byId.set(s.id, entry);
    bySlug.set(s.slug, entry);
  }

  const edgeRowsRaw = await database
    .select({
      skillId: schema.skillVersionDependencies.skillId,
      skillVersionId: schema.skillVersionDependencies.skillVersionId,
      dependsOnSlug: schema.skillVersionDependencies.dependsOnSlug,
      dependsOnSkillId: schema.skillVersionDependencies.dependsOnSkillId,
    })
    .from(schema.skillVersionDependencies)
    .where(eq(schema.skillVersionDependencies.orgId, orgId));
  const edgeRows = Array.isArray(edgeRowsRaw) ? edgeRowsRaw : [];

  const requiresBySkill = new Map<string, DepEdge[]>();
  const dependentsByTarget = new Map<string, { dependentId: string; edge: DepEdge }[]>();
  const graph: DepGraph = { byId, bySlug, requiresBySkill, dependentsByTarget };
  for (const row of edgeRows) {
    // Only the dependent skill's CURRENT version contributes to the live graph.
    const dependent = byId.get(row.skillId);
    if (!dependent || dependent.currentVersionId !== row.skillVersionId) continue;
    const edge = makeDepEdge(graph, {
      skillId: row.skillId,
      dependsOnSlug: row.dependsOnSlug,
      dependsOnSkillId: row.dependsOnSkillId,
    });
    const requires = requiresBySkill.get(row.skillId) ?? [];
    requires.push(edge);
    requiresBySkill.set(row.skillId, requires);
    const target = edge.target;
    if (target) {
      const list = dependentsByTarget.get(target.id) ?? [];
      list.push({ dependentId: row.skillId, edge });
      dependentsByTarget.set(target.id, list);
    }
  }

  return graph;
}

function depEdgeDisplaySlug(edge: DepEdge): string {
  return edge.displaySlug;
}

function hydrateLegacyMissingEdges(graph: DepGraph, slug: string): void {
  const target = graph.bySlug.get(slug);
  if (!target) return;
  for (const [dependentId, edges] of graph.requiresBySkill) {
    for (const edge of edges) {
      if (edge.target || edge.legacyMissingSlug !== slug) continue;
      edge.target = target;
      edge.displaySlug = target.slug;
      const dependents = graph.dependentsByTarget.get(target.id) ?? [];
      if (!dependents.some((ref) => ref.dependentId === dependentId && ref.edge === edge)) {
        dependents.push({ dependentId, edge });
        graph.dependentsByTarget.set(target.id, dependents);
      }
    }
  }
}

/** Precedence for an edge's status given its computed flags (missing → cycle → archived). */
export function dependencyStatusFromFlags(flags: {
  resolved: boolean;
  cycle: boolean;
  archived: boolean;
}): SkillDependencyStatus {
  if (!flags.resolved) return "missing";
  if (flags.cycle) return "cycle";
  if (flags.archived) return "archived";
  return "satisfied";
}

/** Does `fromId` transitively depend on `targetId` over current-version edges? (cycle probe) */
function depReaches(graph: DepGraph, fromId: string, targetId: string, seen: Set<string>): boolean {
  if (fromId === targetId) return true;
  if (seen.has(fromId)) return false;
  seen.add(fromId);
  for (const edge of graph.requiresBySkill.get(fromId) ?? []) {
    const next = edge.target;
    if (next && depReaches(graph, next.id, targetId, seen)) return true;
  }
  return false;
}

/** Compute the live status of one dependency edge declared by `dependentId`. */
function depEdgeStatus(graph: DepGraph, dependentId: string, edge: DepEdge): SkillDependencyStatus {
  const target = edge.target;
  const dependent = graph.byId.get(dependentId);
  return dependencyStatusFromFlags({
    resolved: !!target,
    cycle: !!target && !!dependent && depReaches(graph, target.id, dependentId, new Set()),
    archived: !!target?.archivedAt,
  });
}

function depNote(status: SkillDependencyStatus, targetSlug: string, dependentSlug: string): string | null {
  switch (status) {
    case "missing":
      return "not published to this workspace";
    case "archived":
      return "publisher archived this skill";
    case "cycle":
      return `${targetSlug} already requires ${dependentSlug}`;
    default:
      return null;
  }
}

function shareBlockerMessage(status: SkillDependencyStatus, targetSlug: string, dependentSlug: string): string {
  return depNote(status, targetSlug, dependentSlug) ?? `${targetSlug} is not ready to share`;
}

function addShareBlocker(
  blocked: Map<string, SkillSharePlan["blocked"][number]>,
  slug: string,
  status: SkillDependencyStatus,
  msg: string,
): void {
  if (!blocked.has(slug)) blocked.set(slug, { slug, status, msg });
}

interface ShareMigrationDependency {
  id: string;
  slug: string;
  status: "satisfied";
  note: null;
}

interface ShareMigrationPlan {
  root: DepGraphSkill;
  dependencies: ShareMigrationDependency[];
  blocked: SkillSharePlan["blocked"];
}

function buildShareDependencyClosure(input: {
  graph: DepGraph;
  root: DepGraphSkill;
}): ShareMigrationPlan {
  const dependencies = new Map<string, ShareMigrationDependency>();
  const blocked = new Map<string, SkillSharePlan["blocked"][number]>();
  const visited = new Set<string>();

  const visit = (dependent: DepGraphSkill) => {
    if (visited.has(dependent.id)) return;
    visited.add(dependent.id);

    for (const edge of input.graph.requiresBySkill.get(dependent.id) ?? []) {
      const target = edge.target;
      const displaySlug = depEdgeDisplaySlug(edge);
      if (!target) {
        addShareBlocker(blocked, displaySlug, "missing", "not published to this workspace");
        continue;
      }
      if (target.scope === "personal" && target.creatorId !== input.root.creatorId) {
        addShareBlocker(blocked, displaySlug, "missing", "not published to this workspace");
        continue;
      }

      const status = depEdgeStatus(input.graph, dependent.id, edge);
      if (status !== "satisfied") {
        addShareBlocker(blocked, displaySlug, status, shareBlockerMessage(status, displaySlug, dependent.slug));
        continue;
      }

      if (target.scope === "personal" && target.id !== input.root.id) {
        dependencies.set(target.slug, { id: target.id, slug: target.slug, status: "satisfied", note: null });
        visit(target);
      }
    }
  };

  visit(input.root);
  return {
    root: input.root,
    dependencies: [...dependencies.values()].sort((a, b) => a.slug.localeCompare(b.slug)),
    blocked: [...blocked.values()].sort((a, b) => a.slug.localeCompare(b.slug)),
  };
}

/**
 * Resolve the Requires + Used by graph for one skill (optionally a specific version), with each
 * edge's live status. Invisible personal targets are reported as missing so reads do not leak them.
 */
export async function getSkillDependencies(input: {
  actor: ActorContext;
  orgId: string;
  slug: string;
  version?: string | null;
  database?: Db;
}): Promise<SkillDependenciesResponse> {
  const database = input.database ?? db;
  const skill = await getSkillBySlug(input);
  if (!skill) throw new Error("skill not found");

  const graph = await loadDepGraph(database, input.orgId);
  const visibleBySlug = new Map(
    (
      await listSkills({
        actor: input.actor,
        orgId: input.orgId,
        library: "accessible",
        includeArchived: true,
        database,
      })
    ).map((s) => [s.slug, s] as const),
  );
  const installMeta = (row: SkillListRow | undefined) => ({
    version: row?.current_version ?? null,
    install_status: row?.install_status ?? "none",
    installed_version: row?.installed_version ?? null,
  });

  // Requires: edges declared by the selected (or current) version.
  const versions = await listSkillVersions({ actor: input.actor, orgId: input.orgId, slug: input.slug, database });
  const versionRow = input.version
    ? versions.find((v) => v.version === input.version)
    : versions.find((v) => v.version === skill.current_version) ?? versions[0];
  // A typo'd / stale version is an error, mirroring the download + files endpoints.
  if (input.version && !versionRow) throw new Error("version not found");
  const requiresEdgeRows = versionRow
    ? await database
        .select({
          dependsOnSlug: schema.skillVersionDependencies.dependsOnSlug,
          dependsOnSkillId: schema.skillVersionDependencies.dependsOnSkillId,
        })
        .from(schema.skillVersionDependencies)
        .where(
          and(
            eq(schema.skillVersionDependencies.orgId, input.orgId),
            eq(schema.skillVersionDependencies.skillVersionId, versionRow.id),
          ),
        )
        .orderBy(asc(schema.skillVersionDependencies.dependsOnSlug))
    : [];

  const directTargets: Array<{ target: DepGraphSkill; slug: string }> = [];
  const requires: SkillDependencyRow[] = requiresEdgeRows.map((row) => {
    const edge = makeDepEdge(graph, {
      skillId: skill.id,
      dependsOnSlug: row.dependsOnSlug,
      dependsOnSkillId: row.dependsOnSkillId,
    });
    const target = edge.target;
    const targetRow = target ? visibleBySlug.get(target.slug) : undefined;
    const displaySlug = targetRow?.slug ?? edge.declaredSlug;
    const canOpen = !!targetRow;
    // A target the actor cannot read is reported as "missing" — same no-existence-leak behavior as
    // the publish preflight; the real status is only computed for visible targets.
    const status = canOpen ? depEdgeStatus(graph, skill.id, edge) : "missing";
    if (target && targetRow) directTargets.push({ target, slug: displaySlug });
    return {
      slug: displaySlug,
      status,
      note: depNote(status, displaySlug, skill.slug),
      can_open: canOpen,
      ...installMeta(targetRow),
      depth: 0,
      via: null,
    };
  });

  const directSlugs = new Set(requires.map((row) => row.slug));
  const seen = new Set<string>([skill.id]);
  for (const row of requiresEdgeRows) {
    const edge = makeDepEdge(graph, {
      skillId: skill.id,
      dependsOnSlug: row.dependsOnSlug,
      dependsOnSkillId: row.dependsOnSkillId,
    });
    if (edge.target) seen.add(edge.target.id);
  }

  const queue: Array<{ id: string; slug: string; depth: number }> = [];
  const queued = new Set<string>();
  for (const { target, slug: targetSlug } of directTargets) {
    if (queued.has(target.id) || target.archivedAt || !target.currentVersionId) continue;
    queued.add(target.id);
    queue.push({ id: target.id, slug: targetSlug, depth: 1 });
  }

  const missingTransitive = new Set<string>();
  const transitive: SkillDependencyRow[] = [];
  while (queue.length > 0) {
    const parent = queue.shift()!;
    const parentSkill = graph.byId.get(parent.id);
    if (!parentSkill || parentSkill.archivedAt || !parentSkill.currentVersionId) continue;

    for (const edge of graph.requiresBySkill.get(parent.id) ?? []) {
      const depth = parent.depth + 1;
      const target = edge.target;
      if (!target) {
        if (directSlugs.has(edge.declaredSlug) || missingTransitive.has(edge.declaredSlug)) continue;
        missingTransitive.add(edge.declaredSlug);
        transitive.push({
          slug: edge.declaredSlug,
          status: "missing",
          note: depNote("missing", edge.declaredSlug, parent.slug),
          can_open: false,
          version: null,
          install_status: "none",
          installed_version: null,
          depth,
          via: parent.slug,
        });
        continue;
      }
      if (seen.has(target.id)) continue;
      seen.add(target.id);

      const targetRow = visibleBySlug.get(target.slug);
      if (!targetRow) {
        transitive.push({
          slug: edge.declaredSlug,
          status: "missing",
          note: depNote("missing", edge.declaredSlug, parent.slug),
          can_open: false,
          version: null,
          install_status: "none",
          installed_version: null,
          depth,
          via: parent.slug,
        });
        continue;
      }

      const displaySlug = targetRow.slug;
      const status = depEdgeStatus(graph, parent.id, edge);
      transitive.push({
        slug: displaySlug,
        status,
        note: depNote(status, displaySlug, parent.slug),
        can_open: true,
        ...installMeta(targetRow),
        depth,
        via: parent.slug,
      });

      if (!target.archivedAt && target.currentVersionId) {
        queue.push({ id: target.id, slug: displaySlug, depth });
      }
    }
  }
  transitive.sort((a, b) => a.depth - b.depth || a.slug.localeCompare(b.slug));

  // Used by: other skills whose current version declares this skill as a dependency.
  const usedBy: SkillDependentRow[] = [];
  for (const ref of graph.dependentsByTarget.get(skill.id) ?? []) {
    const dependent = graph.byId.get(ref.dependentId);
    const dependentRow = dependent ? visibleBySlug.get(dependent.slug) : undefined;
    if (!dependent || !dependentRow) continue;
    const status = depEdgeStatus(graph, dependent.id, ref.edge);
    const note = status === "cycle" ? "forms a dependency cycle" : dependent.archivedAt ? "archived dependent" : null;
    usedBy.push({
      slug: dependent.slug,
      status,
      archived: dependent.archivedAt != null,
      note,
      can_open: true,
    });
  }
  usedBy.sort((a, b) => a.slug.localeCompare(b.slug));

  return {
    slug: skill.slug,
    version: versionRow?.version ?? skill.current_version,
    requires,
    transitive,
    used_by: usedBy,
    requires_n: requires.length,
    transitive_n: transitive.length,
    used_by_n: usedBy.length,
    updates_n: [...requires, ...transitive].filter((row) => row.install_status === "update").length,
  };
}

/**
 * Build the dependency preflight for publishing `slug` with `declaredSlugs`: which dependencies are
 * already published, which must be uploaded, which were dropped vs the previous version, which become
 * archival candidates, and which are blocking (missing/cycle).
 */
export async function buildDependencyPlan(input: {
  actor: ActorContext;
  orgId: string;
  slug: string;
  declaredSlugs: string[];
  database?: Db;
}): Promise<DependencyPlan> {
  const database = input.database ?? db;
  const graph = await loadDepGraph(database, input.orgId);
  // Every member can read every skill, so "published in the org" → ready; an unpublished slug →
  // must-upload / missing. `visibleSkillIds` is just the org's full skill-id set.
  const visibleIds = await visibleSkillIds(database, input.actor, input.orgId);
  const isVisible = (s: string) => {
    const t = graph.bySlug.get(s);
    return !!t && visibleIds.has(t.id);
  };
  const declared = [...new Set(input.declaredSlugs)].filter((s) => s !== input.slug);
  const existing = graph.bySlug.get(input.slug);

  const ready = declared.filter((s) => isVisible(s) && !graph.bySlug.get(s)!.archivedAt);
  const upload = declared
    .filter((s) => !isVisible(s))
    .map((s) => ({ slug: s, msg: "declared in the new SKILL.md, not in the registry" }));

  // Previous current version's declared dependencies.
  let prevDeps: Array<{ displaySlug: string; target: DepGraphSkill | null }> = [];
  if (existing?.currentVersionId) {
    const prev = await database
      .select({
        slug: schema.skillVersionDependencies.dependsOnSlug,
        targetId: schema.skillVersionDependencies.dependsOnSkillId,
      })
      .from(schema.skillVersionDependencies)
      .where(
        and(
          eq(schema.skillVersionDependencies.orgId, input.orgId),
          eq(schema.skillVersionDependencies.skillVersionId, existing.currentVersionId),
        ),
      );
    prevDeps = prev.map((p) => {
      const edge = makeDepEdge(graph, {
        skillId: existing.id,
        dependsOnSlug: p.slug,
        dependsOnSkillId: p.targetId,
      });
      return { displaySlug: depEdgeDisplaySlug(edge), target: edge.target };
    });
  }
  const removedDeps = prevDeps.filter((p) => !declared.includes(p.displaySlug));
  const removed = removedDeps.map((p) => p.displaySlug);
  const candidateTargets = [
    ...new Map(
      removedDeps
        .map((p) => p.target)
        .filter((t): t is DepGraphSkill => !!t && !t.archivedAt)
        .map((t) => [t.id, t] as const),
    ).values(),
  ];
  let archive_candidates: DependencyPlan["archive_candidates"] = [];
  if (candidateTargets.length) {
    // Consider ALL published versions' references (not just current-version edges, and org-wide):
    // a dependency still required by any other skill's version — even one the actor cannot see —
    // must NOT be offered for archiving. Excluding this skill's own edges only exposes a boolean
    // ("still used somewhere") about the publisher's own removed dependency, never who uses it.
    const candidateIds = candidateTargets.map((t) => t.id);
    const candidateSlugs = candidateTargets.map((t) => t.slug);
    const refRows = await database
      .select({
        slug: schema.skillVersionDependencies.dependsOnSlug,
        targetId: schema.skillVersionDependencies.dependsOnSkillId,
        skillId: schema.skillVersionDependencies.skillId,
      })
      .from(schema.skillVersionDependencies)
      .where(
        and(
          eq(schema.skillVersionDependencies.orgId, input.orgId),
          or(
            inArray(schema.skillVersionDependencies.dependsOnSkillId, candidateIds),
            and(
              isNull(schema.skillVersionDependencies.dependsOnSkillId),
              inArray(schema.skillVersionDependencies.dependsOnSlug, candidateSlugs),
            ),
          ),
        ),
      );
    const stillReferencedIds = new Set(
      (Array.isArray(refRows) ? refRows : [])
        .filter((r) => r.skillId !== existing?.id)
        .map((r) => r.targetId)
        .filter((id): id is string => !!id),
    );
    const stillReferencedSlugs = new Set(
      (Array.isArray(refRows) ? refRows : [])
        .filter((r) => r.skillId !== existing?.id && !r.targetId)
        .map((r) => r.slug),
    );
    archive_candidates = candidateTargets
      .filter((t) => !stillReferencedIds.has(t.id) && !stillReferencedSlugs.has(t.slug))
      .map((t) => ({ slug: t.slug, reason: "no published skill requires it anymore" }));
  }

  // Blocking check: model the publishing skill as a prospective dependent in the graph.
  const dependent = depGraphDependentFor({ graph, slug: input.slug });
  // Register the prospective skill + its declared edges in the graph so existing edges that declare
  // this slug (including ones currently unresolved/"missing") resolve to it — catching a cycle that
  // publishing this slug would introduce, not just cycles already present.
  graph.bySlug.set(dependent.slug, dependent);
  graph.byId.set(dependent.id, dependent);
  hydrateLegacyMissingEdges(graph, dependent.slug);
  graph.requiresBySkill.set(
    dependent.id,
    declared
      .filter(isVisible)
      .map((s) => makeDepEdge(graph, { skillId: dependent.id, dependsOnSlug: s })),
  );
  const blocked: DependencyPlan["blocked"] = [];
  for (const s of declared) {
    const target = graph.bySlug.get(s);
    // A dependency the actor cannot read is treated as missing — same as a nonexistent slug.
    if (!target || !visibleIds.has(target.id)) {
      blocked.push({ slug: s, status: "missing", msg: "not published to this workspace" });
      continue;
    }
    const edge = makeDepEdge(graph, { skillId: dependent.id, dependsOnSlug: s });
    // Temporarily register the prospective dependent + edge for an accurate cycle probe.
    const status = depEdgeStatusWithDependent(graph, dependent, edge);
    if (status === "cycle") blocked.push({ slug: s, status, msg: `${s} would form a dependency cycle` });
    else if (status === "archived") blocked.push({ slug: s, status, msg: `${s} is archived — restore it or drop the dependency` });
  }

  return { declared, ready, upload, removed, archive_candidates, blocked };
}

/** A prospective dependent (the skill being published), inserted into the graph for status probes. */
function depGraphDependentFor(input: { graph: DepGraph; slug: string }): DepGraphSkill {
  const existing = input.graph.bySlug.get(input.slug);
  return {
    id: existing?.id ?? `prospective:${input.slug}`,
    slug: input.slug,
    scope: existing?.scope ?? "org",
    creatorId: existing?.creatorId ?? "",
    archivedAt: null,
    currentVersionId: existing?.currentVersionId ?? null,
    currentVersion: existing?.currentVersion ?? null,
  };
}

/** Like depEdgeStatus but for a dependent that may not yet be in the graph (publish-time probe). */
function depEdgeStatusWithDependent(graph: DepGraph, dependent: DepGraphSkill, edge: DepEdge): SkillDependencyStatus {
  const target = edge.target;
  return dependencyStatusFromFlags({
    resolved: !!target,
    // Cycle: does the target transitively depend back on this dependent's existing skill id?
    cycle: !!target && graph.byId.has(dependent.id) && depReaches(graph, target.id, dependent.id, new Set()),
    archived: !!target?.archivedAt,
  });
}

/** Carries the dependency plan when a publish is blocked, so the API can surface it to the client. */
export class DependencyPublishError extends Error {
  constructor(public readonly plan: DependencyPlan) {
    super("dependencies must be resolved before publishing");
    this.name = "DependencyPublishError";
  }
}

/** Throw a DependencyPublishError if any declared dependency is missing / cyclic / archived. */
export async function assertDependenciesResolvable(input: {
  actor: ActorContext;
  orgId: string;
  slug: string;
  dependencies: string[];
  database?: Db;
}): Promise<void> {
  if (!input.dependencies.length) return;
  const plan = await buildDependencyPlan({
    actor: input.actor,
    orgId: input.orgId,
    slug: input.slug,
    declaredSlugs: input.dependencies,
    database: input.database,
  });
  if (plan.blocked.length || plan.upload.length) throw new DependencyPublishError(plan);
}

export async function archiveSkill(input: {
  actor: ActorContext;
  orgId: string;
  slug: string;
  reason?: string;
  database?: Db;
}): Promise<{ id: string }> {
  const database = input.database ?? db;
  const skill = await getSkillBySlug(input);
  if (!skill) throw new Error("skill not found");
  await assertCanModifySkillRow({
    actor: input.actor,
    orgId: input.orgId,
    skill: { scope: skill.scope, creatorId: skill.creator_id },
    database,
  });
  await database
    .update(schema.skills)
    .set({ archivedAt: new Date(), archivedBy: input.actor.id, archiveReason: input.reason ?? null, updatedAt: new Date() })
    .where(eq(schema.skills.id, skill.id));
  await database.insert(schema.auditLog).values({
    orgId: input.orgId,
    actorId: input.actor.id,
    action: "skill.archive",
    targetType: "skill",
    targetId: skill.id,
    metadata: { slug: skill.slug, reason: input.reason ?? null },
  });
  if (skill.scope === "org") await enqueueGitHubAfterOrgSkillMutation(database, input.orgId);
  return { id: skill.id };
}

export async function restoreSkill(input: {
  actor: ActorContext;
  orgId: string;
  slug: string;
  database?: Db;
}): Promise<{ id: string }> {
  const database = input.database ?? db;
  const skill = await getSkillBySlug(input);
  if (!skill) throw new Error("skill not found");
  if (skill.scope === "org") {
    await assertOrgSkillMutationEntitled({
      orgId: input.orgId,
      feature: "org_skill_restore",
      isCreate: false,
      database,
    });
  }
  await assertCanModifySkillRow({
    actor: input.actor,
    orgId: input.orgId,
    skill: { scope: skill.scope, creatorId: skill.creator_id },
    database,
  });
  await database
    .update(schema.skills)
    .set({ archivedAt: null, archivedBy: null, archiveReason: null, updatedAt: new Date() })
    .where(eq(schema.skills.id, skill.id));
  await database.insert(schema.auditLog).values({
    orgId: input.orgId,
    actorId: input.actor.id,
    action: "skill.restore",
    targetType: "skill",
    targetId: skill.id,
    metadata: { slug: skill.slug },
  });
  if (skill.scope === "org") await enqueueGitHubAfterOrgSkillMutation(database, input.orgId);
  return { id: skill.id };
}

export async function renameSkill(input: {
  actor: ActorContext;
  orgId: string;
  slug: string;
  newSlug: string;
  title?: string;
  database?: Db;
}): Promise<RenameSkillResult> {
  const database = input.database ?? db;
  const body = renameSkillInputSchema.parse({ newSlug: input.newSlug, title: input.title });
  await assertMember(database, input.actor, input.orgId);
  const skill = await database.query.skills.findFirst({
    where: and(eq(schema.skills.orgId, input.orgId), eq(schema.skills.slug, input.slug)),
  });
  if (!skill) throw new Error("skill not found");
  if (skill.scope === "personal" && skill.creatorId !== input.actor.id) throw new Error("skill not found");
  if (skill.scope === "org") {
    await assertOrgSkillMutationEntitled({
      orgId: input.orgId,
      feature: "org_skill_rename",
      isCreate: false,
      database,
    });
  }
  await assertCanModifySkillRow({
    actor: input.actor,
    orgId: input.orgId,
    skill: { scope: skill.scope, creatorId: skill.creatorId },
    database,
  });
  if (body.newSlug === skill.slug) throw new Error("newSlug must be different from the current slug");
  if (skill.publicVersionId) {
    throw new SkillPublicReleaseConflictError(
      "remove the public release before renaming this skill; then publish and promote a version with the new name",
    );
  }
  const oldSlug = skill.slug;

  return database.transaction(async (txDb) => {
    const tx = txDb as unknown as Db;
    const conflict = await tx.query.skills.findFirst({
      where: and(
        eq(schema.skills.orgId, input.orgId),
        eq(schema.skills.slug, body.newSlug),
        ne(schema.skills.id, skill.id),
      ),
    });
    if (conflict) throw new Error(`a skill named ${body.newSlug} already exists in this workspace`);

    let row: { id: string; slug: string; displayName: string | null } | undefined;
    try {
      // Rename is a registry metadata mutation. Historical version manifests, archive blobs, and
      // checksums remain immutable; agents must publish future updates with the new slug + same id.
      [row] = await tx
        .update(schema.skills)
        .set({
          slug: body.newSlug,
          ...(body.title !== undefined ? { displayName: body.title } : {}),
          updatedAt: new Date(),
        })
        .where(and(
          eq(schema.skills.orgId, input.orgId),
          eq(schema.skills.id, skill.id),
          eq(schema.skills.slug, oldSlug),
          isNull(schema.skills.publicVersionId),
        ))
        .returning({
          id: schema.skills.id,
          slug: schema.skills.slug,
          displayName: schema.skills.displayName,
        });
    } catch (error) {
      if (isUniqueViolation(error)) throw new Error(`a skill named ${body.newSlug} already exists in this workspace`);
      throw error;
    }
    if (!row) {
      const current = await tx.query.skills.findFirst({
        columns: { publicVersionId: true },
        where: and(eq(schema.skills.orgId, input.orgId), eq(schema.skills.id, skill.id)),
      });
      if (current?.publicVersionId) {
        throw new SkillPublicReleaseConflictError(
          "remove the public release before renaming this skill; then publish and promote a version with the new name",
        );
      }
      throw new Error("skill not found");
    }

    await tx.insert(schema.auditLog).values({
      orgId: input.orgId,
      actorId: input.actor.id,
      action: "skill.rename",
      targetType: "skill",
      targetId: skill.id,
      metadata: { old_slug: oldSlug, slug: row.slug, title: body.title ?? null },
    });
    if (skill.scope === "org") await enqueueGitHubAfterOrgSkillMutation(tx, input.orgId);

    return {
      ok: true as const,
      id: row.id,
      old_slug: oldSlug,
      slug: row.slug,
      title: row.displayName ?? null,
    };
  });
}

/**
 * Preview the mandatory private dependency migration for Share. The plan walks the current-version
 * dependency closure from the personal root skill: org dependencies remain as-is, while the owner's
 * personal dependencies are listed for the same one-way move into the org library. Missing, archived,
 * cyclic, or non-owned private targets block the share.
 */
async function buildShareMigrationPlan(input: {
  actor: ActorContext;
  orgId: string;
  slug: string;
  database?: Db;
}): Promise<ShareMigrationPlan> {
  const database = input.database ?? db;
  await assertPersonalSkillsEntitled({ orgId: input.orgId, database, feature: "skill_share" });
  await assertMember(database, input.actor, input.orgId);
  const skill = await database.query.skills.findFirst({
    where: and(eq(schema.skills.orgId, input.orgId), eq(schema.skills.slug, input.slug)),
  });
  if (!skill) throw new Error("skill not found");
  // Preserve personal-skill privacy: a non-owner must see the same result as an unknown slug.
  // Org skills are visible to every member, so they can still return the explicit "not shareable"
  // owner-gate error below.
  if (skill.scope === "personal" && skill.creatorId !== input.actor.id) throw new Error("skill not found");
  if (!canManagePersonalSkill(input.actor.id, { scope: skill.scope, creatorId: skill.creatorId })) {
    throw new Error("only the owner can share a personal skill");
  }

  const graph = await loadDepGraph(database, input.orgId);
  const root = graph.bySlug.get(skill.slug);
  if (!root) throw new Error("skill not found");
  return buildShareDependencyClosure({ graph, root });
}

export async function buildSkillSharePlan(input: {
  actor: ActorContext;
  orgId: string;
  slug: string;
  database?: Db;
}): Promise<SkillSharePlan> {
  const plan = await buildShareMigrationPlan(input);

  return {
    slug: plan.root.slug,
    dependencies: plan.dependencies.map(({ slug, status, note }) => ({ slug, status, note })),
    blocked: plan.blocked,
  };
}

/**
 * Move a personal skill into the org library ("Share to organization"). Owner-only: only the creator
 * of a personal skill may share it. Flips `scope` 'personal' → 'org' for the root skill and all of
 * its owner-private dependency closure, then drops their private folder assignments — org folders
 * apply from here on. The slug is already workspace-unique, so the scope flip can never collide.
 * One-way: there is no un-share endpoint.
 */
export async function shareSkill(input: {
  actor: ActorContext;
  orgId: string;
  slug: string;
  database?: Db;
}): Promise<{ scope: "org"; shared_dependencies: string[] }> {
  const database = input.database ?? db;
  await assertPersonalSkillsEntitled({ orgId: input.orgId, database, feature: "skill_share" });
  const result = await database.transaction(async (txDb) => {
    const tx = txDb as unknown as Db;
    const plan = await buildShareMigrationPlan({ actor: input.actor, orgId: input.orgId, slug: input.slug, database: tx });
    if (plan.blocked.length) throw new Error("share dependencies must be resolved before sharing");

    const migrationIds = [plan.root.id, ...plan.dependencies.map((d) => d.id)];
    const sharedDependencies = plan.dependencies.map((d) => d.slug);

    await tx
      .update(schema.skills)
      .set({ scope: "org", updatedAt: new Date() })
      .where(and(eq(schema.skills.orgId, input.orgId), inArray(schema.skills.id, migrationIds)));
    // Migrated skills leave the personal library: drop private folder assignments (org folders apply now).
    await tx
      .delete(schema.personalSkillLabels)
      .where(
        and(eq(schema.personalSkillLabels.orgId, input.orgId), inArray(schema.personalSkillLabels.skillId, migrationIds)),
      );
    await tx.insert(schema.auditLog).values({
      orgId: input.orgId,
      actorId: input.actor.id,
      action: "skill.share",
      targetType: "skill",
      targetId: plan.root.id,
      metadata: { slug: plan.root.slug, shared_dependencies: sharedDependencies },
    });
    await enqueueGitHubAfterOrgSkillMutation(tx, input.orgId);
    return { scope: "org" as const, shared_dependencies: sharedDependencies };
  });
  return result;
}

/**
 * Shared modify gate for a resolved skill row. Org skills are flat (any member may modify). A personal
 * skill is owner-only — only its creator may archive/restore it. (Callers resolve via `getSkillBySlug`
 * which already hides others' personal skills; this is the explicit defense-in-depth assertion.)
 */
async function assertCanModifySkillRow(input: {
  actor: ActorContext;
  orgId: string;
  skill: { scope: "personal" | "org"; creatorId: string };
  database: Db;
}): Promise<void> {
  await assertMember(input.database, input.actor, input.orgId);
  if (input.skill.scope === "personal") {
    await assertPersonalSkillsEntitled({ orgId: input.orgId, database: input.database });
  }
  if (input.skill.scope === "personal" && input.skill.creatorId !== input.actor.id) {
    throw new Error("only the owner can modify a personal skill");
  }
}

/* ---- Personal access tokens (programmatic publish / install) --------------- */

/** Default lifetime of an issued token (90 days), unless overridden by the caller. */
export const API_TOKEN_TTL_MS = 1000 * 60 * 60 * 24 * 90;
/** Short-lived default and hard ceiling for an Agent Auth-derived child PAT. */
export const AGENT_DELEGATION_TOKEN_TTL_MS = 1000 * 60 * 60 * 24;
export const AGENT_DELEGATION_TOKEN_MAX_TTL_MS = 1000 * 60 * 60 * 24 * 7;

/** Generic public failure for refresh-ineligible credentials; callers must not reveal which rule failed. */
export class ApiTokenRefreshError extends Error {
  constructor() {
    super("token cannot be refreshed");
    this.name = "ApiTokenRefreshError";
  }
}

function hashApiToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

function defaultTokenName(scopes: TokenScope[]): string {
  if (scopes.includes("skills:write")) return "skill publish token";
  if (scopes.includes("skills:read")) return "skill install token";
  if (scopes.includes("public-skills:install")) return "public skill install token";
  return "api token";
}

export interface AgentGrantTokenSnapshot {
  scopes: TokenScope[];
  /** Earliest finite expiry across the source agent and every inherited grant. */
  expiresAt: Date | null;
}

export interface AgentGrantTokenSnapshotRow {
  capability: string;
  constraints: unknown;
  grantExpiresAt: Date | null;
  agentExpiresAt: Date | null;
}

function storedAgentConstraints(value: unknown): Record<string, unknown> | null {
  if (typeof value === "string") {
    try {
      value = JSON.parse(value) as unknown;
    } catch {
      return null;
    }
  }
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function grantHasExactWorkspace(value: unknown, orgId: string): boolean {
  const constraints = storedAgentConstraints(value);
  const workspace = constraints?.workspaceId;
  if (workspace === orgId) return true;
  return Boolean(
    workspace
    && typeof workspace === "object"
    && !Array.isArray(workspace)
    && Object.keys(workspace).length === 1
    && (workspace as { eq?: unknown }).eq === orgId,
  );
}

/**
 * Snapshot every live grant belonging to one authenticated Agent Auth identity. Tenant grants must
 * carry the exact Companion workspace constraint; the instance-wide public install grant is the
 * only exception. No caller-provided scope participates in this conversion.
 */
export async function snapshotAgentApiTokenGrants(input: {
  actor: ActorContext;
  orgId: string;
  agentId: string;
  now?: Date;
  database?: Db;
}): Promise<AgentGrantTokenSnapshot> {
  const database = input.database ?? db;
  const now = input.now ?? new Date();
  const rows = await database
    .select({
      capability: schema.agentCapabilityGrant.capability,
      constraints: schema.agentCapabilityGrant.constraints,
      grantExpiresAt: schema.agentCapabilityGrant.expiresAt,
      agentExpiresAt: schema.agent.expiresAt,
    })
    .from(schema.agentCapabilityGrant)
    .innerJoin(schema.agent, eq(schema.agentCapabilityGrant.agentId, schema.agent.id))
    .leftJoin(schema.agentHost, eq(schema.agent.hostId, schema.agentHost.id))
    .where(and(
      eq(schema.agent.id, input.agentId),
      eq(schema.agent.status, "active"),
      eq(schema.agentCapabilityGrant.status, "active"),
      or(
        eq(schema.agent.userId, input.actor.id),
        and(isNull(schema.agent.userId), eq(schema.agentHost.userId, input.actor.id)),
      ),
    ));

  return deriveAgentApiTokenGrantSnapshot(rows, input.orgId, now);
}

/** Pure grant-to-scope projection used by the DB-backed snapshot and its exhaustive security tests. */
export function deriveAgentApiTokenGrantSnapshot(
  rows: readonly AgentGrantTokenSnapshotRow[],
  orgId: string,
  now = new Date(),
): AgentGrantTokenSnapshot {
  const scopes: TokenScope[] = [];
  const expiries: Date[] = [];
  for (const row of rows) {
    if (row.agentExpiresAt && row.agentExpiresAt.getTime() <= now.getTime()) continue;
    if (row.grantExpiresAt && row.grantExpiresAt.getTime() <= now.getTime()) continue;
    const parsed = tokenScopeSchema.safeParse(row.capability);
    if (!parsed.success) continue;
    if (parsed.data !== "public-skills:install" && !grantHasExactWorkspace(row.constraints, orgId)) {
      continue;
    }
    scopes.push(parsed.data);
    if (row.grantExpiresAt) expiries.push(row.grantExpiresAt);
    if (row.agentExpiresAt) expiries.push(row.agentExpiresAt);
  }
  return {
    scopes: expandTokenScopes(scopes),
    expiresAt: expiries.length
      ? new Date(Math.min(...expiries.map((value) => value.getTime())))
      : null,
  };
}

/**
 * Mint a scoped personal access token. The plaintext `token` is returned exactly once;
 * only its sha256 hash is persisted. Requires the actor to be a member of `orgId`.
 */
export async function issueApiToken(input: {
  actor: ActorContext;
  orgId: string;
  scopes: TokenScope[];
  name?: string;
  ttlMs?: number;
  expiresAt?: Date;
  source?: {
    type: "agent_auth";
    agentId: string;
    targetWorkspaceId?: string;
  };
  database?: Db;
}): Promise<{
  id: string;
  token: string;
  prefix: string;
  scopes: TokenScope[];
  expiresAt: Date;
  targetWorkspaceId: string | null;
}> {
  const database = input.database ?? db;
  if (!input.scopes.length) throw new Error("at least one scope is required");
  if (input.ttlMs !== undefined && input.expiresAt) {
    throw new Error("token lifetime must use either ttlMs or expiresAt");
  }
  if (input.ttlMs !== undefined && (!Number.isFinite(input.ttlMs) || input.ttlMs <= 0 || input.ttlMs > API_TOKEN_TTL_MS)) {
    throw new Error("token lifetime is outside the allowed range");
  }
  const scopes = expandTokenScopes(input.scopes);
  const role = await getOrgRole(input.orgId, input.actor.id, database);
  if (!role) throw new Error("not a member of this organization");
  const secret = randomBytes(24).toString("hex");
  const token = `${API_TOKEN_PREFIX}${secret}`;
  const prefix = token.slice(0, API_TOKEN_PREFIX.length + 6);
  const now = Date.now();
  const expiresAt = input.expiresAt ?? new Date(now + (input.ttlMs ?? API_TOKEN_TTL_MS));
  if (
    !Number.isFinite(expiresAt.getTime())
    || expiresAt.getTime() <= now
    || expiresAt.getTime() > now + API_TOKEN_TTL_MS
  ) {
    throw new Error("token expiration is outside the allowed range");
  }
  const sourceAgentId = input.source
    ? input.source.agentId
    : undefined;
  const targetWorkspaceId = input.source?.type === "agent_auth"
    ? input.source.targetWorkspaceId ?? null
    : null;
  const [row] = await database
    .insert(schema.apiTokens)
    .values({
      orgId: input.orgId,
      userId: input.actor.id,
      name: input.name?.trim() || defaultTokenName(scopes),
      tokenPrefix: prefix,
      tokenHash: hashApiToken(token),
      scopes,
      ...(input.source ? {
        sourceType: input.source.type,
        sourceAgentId,
        targetWorkspaceId,
      } : {}),
      expiresAt,
    })
    .returning({ id: schema.apiTokens.id });
  if (!row) throw new Error("could not issue token");
  if (input.source) {
    await database.insert(schema.auditLog).values({
      orgId: input.orgId,
      actorId: input.actor.id,
      action: "api_token.issue_agent_delegation",
      targetType: "api_token",
      targetId: row.id,
      metadata: {
        sourceType: input.source.type,
        sourceAgentId: sourceAgentId ?? null,
        scopes,
        expiresAt: expiresAt.toISOString(),
        targetWorkspaceId,
      },
    });
  }
  return {
    id: row.id,
    token,
    prefix,
    scopes,
    expiresAt,
    targetWorkspaceId,
  };
}

/**
 * Refresh an expired PAT once during the fixed database-enforced 30-day recovery window.
 *
 * Active tokens are returned as metadata-only `current` responses. For an expired eligible token,
 * the successor keeps the exact name and scopes, while insertion, old-token revocation, and the
 * value-free audit entry commit atomically. The pre-tenant row lock serializes concurrent attempts.
 */
export async function refreshApiToken(rawToken: string, database: Db = db): Promise<RefreshTokenResponse> {
  if (!rawToken.startsWith(API_TOKEN_PREFIX)) throw new ApiTokenRefreshError();
  const tokenHash = hashApiToken(rawToken);

  return database.transaction(async (rawTx) => {
    const tx = rawTx as unknown as Db;
    const candidate = await lockPreTenantApiTokenForRefresh(tx, tokenHash);
    if (!candidate) throw new ApiTokenRefreshError();

    const parsedScopes = tokenScopesSchema.safeParse(candidate.scopes);
    if (!parsedScopes.success) throw new ApiTokenRefreshError();
    const scopes = expandTokenScopes(parsedScopes.data);
    if (!candidate.is_expired) {
      return {
        status: "current" as const,
        scopes,
        expires_at: new Date(candidate.expires_at).toISOString(),
      };
    }

    await tx.execute(
      sql`select set_config('app.org_id', ${candidate.org_id}, true), set_config('app.user_id', ${candidate.user_id}, true)`,
    );
    const secret = randomBytes(24).toString("hex");
    const token = `${API_TOKEN_PREFIX}${secret}`;
    const prefix = token.slice(0, API_TOKEN_PREFIX.length + 6);
    const expiresAt = new Date(Date.now() + API_TOKEN_TTL_MS);
    const [replacement] = await tx
      .insert(schema.apiTokens)
      .values({
        orgId: candidate.org_id,
        userId: candidate.user_id,
        name: candidate.token_name,
        tokenPrefix: prefix,
        tokenHash: hashApiToken(token),
        scopes,
        expiresAt,
      })
      .returning({ id: schema.apiTokens.id });
    if (!replacement) throw new Error("could not issue replacement token");

    await tx
      .update(schema.apiTokens)
      .set({ revokedAt: new Date() })
      .where(and(eq(schema.apiTokens.id, candidate.token_id), isNull(schema.apiTokens.revokedAt)));
    await tx.insert(schema.auditLog).values({
      orgId: candidate.org_id,
      actorId: candidate.user_id,
      action: "api_token.refresh",
      targetType: "api_token",
      targetId: candidate.token_id,
      metadata: { replacementTokenId: replacement.id },
    });

    return {
      status: "rotated" as const,
      id: replacement.id,
      token,
      prefix,
      scopes,
      expires_at: expiresAt.toISOString(),
    };
  });
}

/**
 * List a member's personal access tokens for the settings UI. A developer sees only their own tokens
 * (`where userId = actor.id`); an org admin sees every token in the org — this mirrors the `0005` RLS
 * policy. Rows are mapped to the `apiTokenRowSchema` shape (snake_case, ISO timestamps); the secret
 * (`tokenHash`) is never selected or returned.
 */
export async function listApiTokens(input: {
  actor: ActorContext;
  orgId: string;
  database?: Db;
}): Promise<ApiTokenRow[]> {
  const database = input.database ?? db;
  const role = await getOrgRole(input.orgId, input.actor.id, database);
  if (!role) throw new Error("not a member of this organization");
  // Always scope to the caller's OWN tokens: this backs the personal "Account › API keys" pane,
  // so even an org admin must not see (or be able to revoke from here) other members' keys. The
  // admin's broader revoke capability stays available by token id in `revokeApiToken`.
  // Only active tokens: revoke is a soft delete (revoked_at is set, the row stays), so revoked
  // keys must be filtered out or they reappear in the list masked as if still active.
  const where = and(
    eq(schema.apiTokens.orgId, input.orgId),
    eq(schema.apiTokens.userId, input.actor.id),
    isNull(schema.apiTokens.revokedAt),
  );
  const rows = await database
    .select({
      id: schema.apiTokens.id,
      orgId: schema.apiTokens.orgId,
      userId: schema.apiTokens.userId,
      name: schema.apiTokens.name,
      tokenPrefix: schema.apiTokens.tokenPrefix,
      scopes: schema.apiTokens.scopes,
      expiresAt: schema.apiTokens.expiresAt,
      lastUsedAt: schema.apiTokens.lastUsedAt,
      revokedAt: schema.apiTokens.revokedAt,
      createdAt: schema.apiTokens.createdAt,
    })
    .from(schema.apiTokens)
    .where(where)
    .orderBy(desc(schema.apiTokens.createdAt));
  return rows.map((r) => ({
    id: r.id,
    org_id: r.orgId,
    user_id: r.userId,
    name: r.name,
    prefix: r.tokenPrefix,
    scopes: expandTokenScopes((r.scopes ?? []) as TokenScope[]),
    expires_at: r.expiresAt.toISOString(),
    last_used_at: r.lastUsedAt ? r.lastUsedAt.toISOString() : null,
    revoked_at: r.revokedAt ? r.revokedAt.toISOString() : null,
    created_at: r.createdAt.toISOString(),
  }));
}

/**
 * Resolve a raw `cmp_pat_…` token to an actor + org + scopes, or null if it is unknown,
 * revoked, or expired. Runs on the privileged app connection (the token itself identifies
 * the tenant, so this lookup is intentionally not org-scoped). Best-effort bumps last_used_at.
 */
export async function resolveApiToken(
  rawToken: string,
  database: Db = db,
  targetWorkspaceId: string | null = null,
): Promise<{
  actor: ActorContext;
  orgId: string;
  scopes: TokenScope[];
  sourceType: string;
} | null> {
  if (!rawToken.startsWith(API_TOKEN_PREFIX)) return null;
  const row = await resolvePreTenantApiToken(database, hashApiToken(rawToken), targetWorkspaceId);
  if (!row || row.source_type === "companion") return null;
  return {
    actor: {
      id: row.user_id,
      email: row.email,
      name: row.name,
    },
    orgId: row.org_id,
    scopes: expandTokenScopes((row.scopes ?? []) as TokenScope[]),
    sourceType: row.source_type ?? "human",
  };
}

/** Revoke a token. The owner can revoke their own; org owners/admins can revoke any. */
export async function revokeApiToken(input: {
  actor: ActorContext;
  orgId: string;
  tokenId: string;
  database?: Db;
}): Promise<void> {
  const database = input.database ?? db;
  const row = await database.query.apiTokens.findFirst({
    where: and(eq(schema.apiTokens.id, input.tokenId), eq(schema.apiTokens.orgId, input.orgId)),
  });
  if (!row) throw new Error("token not found");
  if (row.userId !== input.actor.id) {
    const role = await getOrgRole(input.orgId, input.actor.id, database);
    if (!role || !canManageOrg(role)) throw new Error("not allowed to revoke this token");
  }
  await database
    .update(schema.apiTokens)
    .set({ revokedAt: new Date() })
    .where(eq(schema.apiTokens.id, input.tokenId));
}

// --- Local skills (the "Companion skills" section) ------------------------------------------

export interface LocalSkillInstall {
  skillKey: string;
  installedVersion: string;
  agentLabel: string | null;
  installedAt: Date;
  lastReportedAt: Date;
}

/** The caller's install record for a built-in local skill, or null if they never reported one. */
export async function getLocalSkillInstall(input: {
  actor: ActorContext;
  orgId: string;
  skillKey: string;
  database?: Db;
}): Promise<LocalSkillInstall | null> {
  const database = input.database ?? db;
  const row = await database.query.localSkillInstalls.findFirst({
    where: and(
      eq(schema.localSkillInstalls.orgId, input.orgId),
      eq(schema.localSkillInstalls.userId, input.actor.id),
      eq(schema.localSkillInstalls.skillKey, input.skillKey),
    ),
  });
  if (!row) return null;
  return {
    skillKey: row.skillKey,
    installedVersion: row.installedVersion,
    agentLabel: row.agentLabel ?? null,
    installedAt: row.installedAt,
    lastReportedAt: row.lastReportedAt,
  };
}

/**
 * Record (or refresh) the caller's install of a built-in local skill. Idempotent per
 * (org, user, skillKey): the first report sets `installedAt`; later reports update the version,
 * label, and `lastReportedAt`. The local skill calls this at the end of its install flow.
 */
export async function reportLocalSkillInstall(input: {
  actor: ActorContext;
  orgId: string;
  skillKey: string;
  version: string;
  agentLabel?: string | null;
  database?: Db;
}): Promise<LocalSkillInstall> {
  const database = input.database ?? db;
  const now = new Date();
  const agentLabel = input.agentLabel?.trim() ? input.agentLabel.trim() : null;
  const [row] = await database
    .insert(schema.localSkillInstalls)
    .values({
      orgId: input.orgId,
      userId: input.actor.id,
      skillKey: input.skillKey,
      installedVersion: input.version,
      agentLabel,
      installedAt: now,
      lastReportedAt: now,
    })
    .onConflictDoUpdate({
      target: [
        schema.localSkillInstalls.orgId,
        schema.localSkillInstalls.userId,
        schema.localSkillInstalls.skillKey,
      ],
      set: { installedVersion: input.version, agentLabel, lastReportedAt: now },
    })
    .returning();
  if (!row) throw new Error("could not record install");
  await database.insert(schema.auditLog).values({
    orgId: input.orgId,
    actorId: input.actor.id,
    action: "local_skill.install",
    targetType: "local_skill",
    targetId: input.skillKey,
    metadata: { version: input.version, agent: agentLabel },
  });
  if (input.skillKey === "companion") {
    await recordGettingStartedStep({
      actor: input.actor,
      orgId: input.orgId,
      step: "companion_install",
      agent: agentLabel,
      database,
    });
  }
  return {
    skillKey: row.skillKey,
    installedVersion: row.installedVersion,
    agentLabel: row.agentLabel ?? null,
    installedAt: row.installedAt,
    lastReportedAt: row.lastReportedAt,
  };
}

/** Derive install status from the reported version (null = never reported) and the available version. */
export function computeLocalSkillStatus(
  installedVersion: string | null,
  availableVersion: string,
): LocalSkillStatus {
  if (!installedVersion) return "none";
  return compareSemver(installedVersion, availableVersion) < 0 ? "update" : "installed";
}

/**
 * Install status for a PUBLISHED skill row from the caller's point of view. Distinct from
 * `computeLocalSkillStatus` because a manual mark can have a null version: a present-but-version-
 * unknown install is "installed", never "update".
 */
export function computeSkillInstallStatus(
  hasInstall: boolean,
  installedVersion: string | null,
  currentVersion: string | null,
): LocalSkillStatus {
  if (!hasInstall) return "none";
  if (!installedVersion || !currentVersion) return "installed";
  return compareSemver(installedVersion, currentVersion) < 0 ? "update" : "installed";
}

/**
 * Does any skill in `rootId`'s transitive dependency closure satisfy `isBehind`? Installing a skill
 * also installs its dependency set, so a stale dependency makes the parent effectively stale — this
 * rolls that up into an "update available" hint on the parent. Cycle-safe via the visited set.
 */
export function depClosureHasUpdate(
  rootId: string,
  requiresBySkill: Map<string, Array<{ targetId?: string | null; target?: { id: string } | null }>>,
  isBehind: (skillId: string) => boolean,
): boolean {
  const seen = new Set<string>([rootId]);
  const walk = (id: string): boolean => {
    for (const edge of requiresBySkill.get(id) ?? []) {
      const targetId = edge.targetId ?? edge.target?.id ?? null;
      if (!targetId || seen.has(targetId)) continue;
      seen.add(targetId);
      if (isBehind(targetId) || walk(targetId)) return true;
    }
    return false;
  };
  return walk(rootId);
}

function depGraphClosureHasUpdate(
  rootId: string,
  graph: DepGraph,
  isBehind: (skillId: string) => boolean,
): boolean {
  const seen = new Set<string>([rootId]);
  const walk = (id: string): boolean => {
    for (const edge of graph.requiresBySkill.get(id) ?? []) {
      const target = edge.target;
      if (!target || seen.has(target.id)) continue;
      seen.add(target.id);
      if (isBehind(target.id) || walk(target.id)) return true;
    }
    return false;
  };
  return walk(rootId);
}

/**
 * Record (or refresh) the caller's install of a PUBLISHED skill. Idempotent per (org, user, skill):
 * the first call sets `installedAt`; later calls update the version, label, source, and
 * `lastReportedAt`. The assistant calls this at the end of the normal install flow (source "agent");
 * the UI calls it for a manual mark (source "manual"). Visibility-gated via `getSkillBySlug`.
 */
export async function installSkill(input: {
  actor: ActorContext;
  orgId: string;
  slug: string;
  version?: string | null;
  agentLabel?: string | null;
  source?: "agent" | "manual";
  database?: Db;
}): Promise<{ status: LocalSkillStatus; installedVersion: string | null; currentVersion: string | null }> {
  const database = input.database ?? db;
  const skill = await getSkillBySlug(input);
  if (!skill) throw new Error("skill not found");
  // Install records that an org skill is in the caller's My Skills. A personal skill is already there
  // (it is authored, not installed); another member's personal skill is invisible (resolves to null
  // above). So an install only ever targets an org skill.
  if (skill.scope === "personal") {
    throw new Error("personal skills cannot be installed; they already live in My Skills");
  }
  const now = new Date();
  const version = input.version?.trim() ? input.version.trim() : null;
  const agentLabel = input.agentLabel?.trim() ? input.agentLabel.trim() : null;
  const source = input.source ?? "manual";

  // Reject a reported version newer than the current published version (mirrors the local-skill
  // guard): a typo/bogus version must not silently suppress future "update" prompts.
  if (version && skill.current_version && compareSemver(version, skill.current_version) > 0) {
    throw new Error(
      `reported version ${version} is newer than the current published version ${skill.current_version}`,
    );
  }

  await database
    .insert(schema.skillInstalls)
    .values({
      orgId: input.orgId,
      userId: input.actor.id,
      skillId: skill.id,
      installedVersion: version,
      agentLabel,
      source,
      installedAt: now,
      lastReportedAt: now,
    })
    .onConflictDoUpdate({
      target: [schema.skillInstalls.orgId, schema.skillInstalls.userId, schema.skillInstalls.skillId],
      set: { installedVersion: version, agentLabel, source, lastReportedAt: now },
    });

  await database.insert(schema.auditLog).values({
    orgId: input.orgId,
    actorId: input.actor.id,
    action: "skill.install",
    targetType: "skill",
    targetId: skill.id,
    metadata: { slug: skill.slug, version, agent: agentLabel, source },
  });

  // Installing a skill also installs its dependency set, so record each resolved (live) dependency in
  // the closure at its current version. This gives dependency-aware update detection a per-dependency
  // baseline to compare against later. Idempotent; cascades on every report so a reinstall refreshes
  // the dependencies too. No audit row per dependency — the parent install is the user-facing action.
  // The dependency graph is current-version-only, so this only matches reality when the reported
  // install IS the current version (or unknown); reporting an older version may declare a different
  // dependency set, so we skip the cascade rather than record dependencies it might not pull.
  const reflectsCurrentVersion = version === null || version === skill.current_version;
  const graph = reflectsCurrentVersion ? await loadDepGraph(database, input.orgId) : null;
  const closure = new Set<string>();
  const collect = (id: string) => {
    for (const edge of graph!.requiresBySkill.get(id) ?? []) {
      const target = edge.target;
      if (!target || closure.has(target.id)) continue;
      if (target.archivedAt || !target.currentVersionId) continue;
      closure.add(target.id);
      collect(target.id);
    }
  };
  if (graph) collect(skill.id);
  if (closure.size) {
    const versionRowsRaw = await database
      .select({ id: schema.skills.id, version: schema.skillVersions.version })
      .from(schema.skills)
      .innerJoin(schema.skillVersions, eq(schema.skillVersions.id, schema.skills.currentVersionId))
      .where(and(eq(schema.skills.orgId, input.orgId), inArray(schema.skills.id, [...closure])));
    for (const dep of Array.isArray(versionRowsRaw) ? versionRowsRaw : []) {
      if (!dep.version) continue;
      await database
        .insert(schema.skillInstalls)
        .values({
          orgId: input.orgId,
          userId: input.actor.id,
          skillId: dep.id,
          installedVersion: dep.version,
          agentLabel,
          source,
          installedAt: now,
          lastReportedAt: now,
        })
        .onConflictDoUpdate({
          target: [schema.skillInstalls.orgId, schema.skillInstalls.userId, schema.skillInstalls.skillId],
          set: { installedVersion: dep.version, agentLabel, source, lastReportedAt: now },
        });
    }
  }

  return {
    status: computeSkillInstallStatus(true, version, skill.current_version),
    installedVersion: version,
    currentVersion: skill.current_version,
  };
}

/** Mark a PUBLISHED skill NOT installed for the caller (uninstall / correct a false state). Idempotent. */
export async function uninstallSkill(input: {
  actor: ActorContext;
  orgId: string;
  slug: string;
  database?: Db;
}): Promise<void> {
  const database = input.database ?? db;
  const skill = await getSkillBySlug(input);
  if (!skill) throw new Error("skill not found");
  await database
    .delete(schema.skillInstalls)
    .where(
      and(
        eq(schema.skillInstalls.orgId, input.orgId),
        eq(schema.skillInstalls.userId, input.actor.id),
        eq(schema.skillInstalls.skillId, skill.id),
      ),
    );
  await database.insert(schema.auditLog).values({
    orgId: input.orgId,
    actorId: input.actor.id,
    action: "skill.uninstall",
    targetType: "skill",
    targetId: skill.id,
    metadata: { slug: skill.slug },
  });
}
