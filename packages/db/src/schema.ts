/* oxlint-disable anti-slop/no-shape-in-symbol-names, anti-slop/no-unsafe-dictionary-type -- Existing Drizzle schema symbols predate the incremental anti-slop gate. */

import {
  type AnyPgColumn,
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/** JSON object payloads retain their existing open contract at the database boundary. */
interface SchemaJsonObject {}

export const orgRoleEnum = pgEnum("org_role", ["owner", "admin", "developer"]);
export const validationStateEnum = pgEnum("validation_state", ["valid", "validating", "invalid"]);
// A skill's library scope. 'org' = the flat org-wide library (default; visible to every member).
// 'personal' = private to `creator_id` (the owner) — the design's "My Skills". Only the owner sees it,
// even admins do not. Share flips 'personal' → 'org'; there is no reverse transition.
export const skillScopeEnum = pgEnum("skill_scope", ["personal", "org"]);
export const orgKindEnum = pgEnum("org_kind", ["personal", "team"]);
export const companionBoxObservedStateEnum = pgEnum("companion_box_observed_state", [
  "absent", "initializing", "provisioning", "ready", "idle", "running",
  "archiving", "archived", "error", "unknown",
]);
export const companionPiObservedStateEnum = pgEnum("companion_pi_observed_state", [
  "absent", "starting", "idle", "running", "stopped", "error", "unknown",
]);
export const companionRuntimeRetirementStateEnum = pgEnum("companion_runtime_retirement_state", [
  "active", "requested", "pending", "blocked", "retired",
]);
export const companionClientSurfaceEnum = pgEnum("companion_client_surface", [
  "web", "mobile_web", "native_mobile",
]);
export const companionImageStatusEnum = pgEnum("companion_image_status", [
  "requested", "building", "ready", "failed",
]);
export const companionTurnStatusEnum = pgEnum("companion_turn_status", [
  "queued", "starting", "dispatching", "running", "needs_input",
  "succeeded", "failed", "interrupted", "cancelled",
]);
export const companionRoutineSurfaceModeEnum = pgEnum("companion_routine_surface_mode", [
  "relay", "notify",
]);
export const companionNotificationEnvironmentEnum = pgEnum("companion_notification_environment", [
  "sandbox", "production",
]);
export const companionNotificationEventEnum = pgEnum("companion_notification_event", [
  "reply", "input_required", "failed", "interrupted",
]);
export const companionAttemptStatusEnum = pgEnum("companion_attempt_status", [
  "starting", "dispatching", "running", "needs_input",
  "succeeded", "failed", "interrupted", "cancelled",
]);
export const companionDispatchStateEnum = pgEnum("companion_dispatch_state", [
  "pending", "write_intent", "accepted", "rejected", "ambiguous",
]);
export const companionOperationKindEnum = pgEnum("companion_operation_kind", [
  "delete", "stop", "restart_pi", "restart_box", "start", "apply_settings",
]);
export const companionOperationStatusEnum = pgEnum("companion_operation_status", [
  "pending", "running", "succeeded", "failed", "interrupted", "cancelled",
]);
export const companionOperationTriggerEnum = pgEnum("companion_operation_trigger", [
  "turn", "user", "settings", "recovery", "kill_switch",
]);
export const companionRuntimeErrorActionEnum = pgEnum("companion_runtime_error_action", [
  "retry", "cancel", "restart_pi", "restart_box", "switch_model",
  "reconnect_provider", "none",
]);
export const companionRuntimeWorkKindEnum = pgEnum("companion_runtime_work_kind", [
  "operation", "decision", "attempt", "settings", "health",
]);
export const companionV3LaneEnum = pgEnum("companion_v3_lane", ["main", "background"]);
export const companionV3TurnStateEnum = pgEnum("companion_v3_turn_state", [
  "queued", "admitted", "running", "needs_input",
  "succeeded", "failed", "interrupted", "cancelled",
]);
export const companionV3AdmissionStateEnum = pgEnum("companion_v3_admission_state", [
  "pending", "accepted", "ambiguous",
]);
export const companionV3TurnOutcomeEnum = pgEnum("companion_v3_turn_outcome", [
  "succeeded", "failed", "interrupted", "cancelled",
]);
export const companionV3LifecycleIntentEnum = pgEnum("companion_v3_lifecycle_intent", [
  "prepare", "archive", "recycle_pi", "delete",
]);
export const companionDecisionStatusEnum = pgEnum("companion_decision_status", [
  "pending", "allowed", "denied", "answered", "expired", "cancelled",
]);
export const companionDecisionDeliveryStateEnum = pgEnum("companion_decision_delivery_state", [
  "pending", "write_intent", "delivered", "ambiguous", "cancelled",
]);
export const companionDecisionRequestKindEnum = pgEnum("companion_decision_request_kind", [
  "question", "confirmation", "config_proposal", "routine_proposal", "trigger_proposal",
]);
export const companionControlRequestKindEnum = pgEnum("companion_control_request_kind", [
  "model_change", "plugin_connection", "routine_change", "trigger_change", "peer_access",
]);
export const companionControlRequestStatusEnum = pgEnum("companion_control_request_status", [
  "pending", "applying", "applied", "denied", "expired", "cancelled", "failed",
]);
export const companionDelegationDeliveryStatusEnum = pgEnum(
  "companion_delegation_delivery_status",
  ["pending", "delivered", "failed"],
);
export const companionDuplicateCleanupStatusEnum = pgEnum("companion_duplicate_cleanup_status", [
  "pending", "delete_requested", "waiting_deleted", "deleted", "already_deleted", "blocked",
]);
export type CompanionLegacyPurgePhase =
  | "deleting_external"
  | "external_complete"
  | "database_complete";
export type CompanionLegacyPurgeTargetState =
  | "discovered"
  | "requesting"
  | "pending"
  | "processing"
  | "blocked"
  | "completed"
  | "absent";
export const companionProviderAuthMethodEnum = pgEnum("companion_provider_auth_method", [
  "api_key",
  "subscription",
]);
export const companionShareRoleEnum = pgEnum("companion_share_role", ["editor", "viewer"]);
export const companionTranscriptRoleEnum = pgEnum("companion_transcript_role", [
  "user",
  "assistant",
  "system",
  "tool",
  "decision",
]);
export const billingSeatSyncStatusEnum = pgEnum("billing_seat_sync_status", ["synced", "pending", "error"]);
export const invitationStatusEnum = pgEnum("invitation_status", [
  "pending",
  "accepted",
  "revoked",
  "expired",
]);
export const secretAudienceEnum = pgEnum("secret_audience", ["personal", "restricted", "organization"]);
export const skillDatabaseAudienceEnum = pgEnum("skill_database_audience", ["organization", "personal"]);
export const secretBindingSourceEnum = pgEnum("secret_binding_source", ["manual", "suggestion"]);
export const secretSlotStatusEnum = pgEnum("secret_slot_status", [
  "personal",
  "shared",
  "required",
  "optional_missing",
]);
export const githubSyncModeEnum = pgEnum("github_sync_mode", ["all", "selected"]);
export const githubSyncStatusEnum = pgEnum("github_sync_status", [
  "pending",
  "syncing",
  "synced",
  "error",
  "disconnected",
]);
const now = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();

export const user = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const session = pgTable("session", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  token: text("token").notNull().unique(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const account = pgTable("account", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  accountId: text("account_id").notNull(),
  providerId: text("provider_id").notNull(),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
  refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }),
  scope: text("scope"),
  idToken: text("id_token"),
  password: text("password"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const verification = pgTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// Global Agent Auth identity data. These tables intentionally do not carry org_id: a delegated
// agent/host belongs to a Better Auth user and may hold separately constrained grants for multiple
// workspaces. Every business operation still re-enters Core with an exact workspace constraint.
export const agentHost = pgTable(
  "agent_host",
  {
    id: text("id").primaryKey(),
    name: text("name"),
    userId: text("user_id").references(() => user.id, { onDelete: "cascade" }),
    defaultCapabilities: text("default_capabilities"),
    publicKey: text("public_key"),
    kid: text("kid"),
    jwksUrl: text("jwks_url"),
    enrollmentTokenHash: text("enrollment_token_hash"),
    enrollmentTokenExpiresAt: timestamp("enrollment_token_expires_at", { withTimezone: true }),
    status: text("status").notNull().default("active"),
    activatedAt: timestamp("activated_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    remoteJwksDisabled: check("agent_host_remote_jwks_disabled", sql`${t.jwksUrl} is null`),
    byUser: index("agent_host_user_id_idx").on(t.userId),
    byKid: index("agent_host_kid_idx").on(t.kid),
    byEnrollmentTokenHash: index("agent_host_enrollment_token_hash_idx").on(t.enrollmentTokenHash),
    byStatus: index("agent_host_status_idx").on(t.status),
  }),
);

export const agent = pgTable(
  "agent",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    userId: text("user_id").references(() => user.id, { onDelete: "cascade" }),
    hostId: text("host_id")
      .notNull()
      .references(() => agentHost.id, { onDelete: "cascade" }),
    status: text("status").notNull().default("active"),
    mode: text("mode").notNull().default("delegated"),
    publicKey: text("public_key").notNull(),
    kid: text("kid"),
    jwksUrl: text("jwks_url"),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    activatedAt: timestamp("activated_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    metadata: text("metadata"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    remoteJwksDisabled: check("agent_remote_jwks_disabled", sql`${t.jwksUrl} is null`),
    byUser: index("agent_user_id_idx").on(t.userId),
    byHost: index("agent_host_id_idx").on(t.hostId),
    byStatus: index("agent_status_idx").on(t.status),
    byKid: index("agent_kid_idx").on(t.kid),
  }),
);

export const agentCapabilityGrant = pgTable(
  "agent_capability_grant",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id")
      .notNull()
      .references(() => agent.id, { onDelete: "cascade" }),
    capability: text("capability").notNull(),
    deniedBy: text("denied_by").references(() => user.id, { onDelete: "cascade" }),
    grantedBy: text("granted_by").references(() => user.id, { onDelete: "cascade" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    status: text("status").notNull().default("active"),
    reason: text("reason"),
    constraints: text("constraints"),
  },
  (t) => ({
    byAgent: index("agent_capability_grant_agent_id_idx").on(t.agentId),
    byCapability: index("agent_capability_grant_capability_idx").on(t.capability),
    byGrantedBy: index("agent_capability_grant_granted_by_idx").on(t.grantedBy),
    byStatus: index("agent_capability_grant_status_idx").on(t.status),
    onePendingCapability: uniqueIndex("agent_capability_grant_one_pending_capability_idx")
      .on(t.agentId, t.capability)
      .where(sql`${t.status} = 'pending'`),
  }),
);

export const approvalRequest = pgTable(
  "approval_request",
  {
    id: text("id").primaryKey(),
    method: text("method").notNull(),
    agentId: text("agent_id").references(() => agent.id, { onDelete: "cascade" }),
    hostId: text("host_id").references(() => agentHost.id, { onDelete: "cascade" }),
    userId: text("user_id").references(() => user.id, { onDelete: "cascade" }),
    capabilities: text("capabilities"),
    status: text("status").notNull().default("pending"),
    userCodeHash: text("user_code_hash"),
    loginHint: text("login_hint"),
    bindingMessage: text("binding_message"),
    clientNotificationToken: text("client_notification_token"),
    clientNotificationEndpoint: text("client_notification_endpoint"),
    deliveryMode: text("delivery_mode"),
    interval: integer("interval").notNull(),
    lastPolledAt: timestamp("last_polled_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byAgent: index("approval_request_agent_id_idx").on(t.agentId),
    byHost: index("approval_request_host_id_idx").on(t.hostId),
    byUser: index("approval_request_user_id_idx").on(t.userId),
    byStatus: index("approval_request_status_idx").on(t.status),
  }),
);

// Shared PostgreSQL secondary storage used by Agent Auth for atomic rate limits, JTI replay
// protection, and short-lived JWKS/approval values. Raw keys and values are plugin-internal.
export const agentAuthEphemeral = pgTable(
  "agent_auth_ephemeral",
  {
    key: text("key").primaryKey(),
    value: text("value").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ byExpiry: index("agent_auth_ephemeral_expires_at_idx").on(t.expiresAt) }),
);

export const profiles = pgTable("profiles", {
  id: text("id")
    .primaryKey()
    .references(() => user.id, { onDelete: "cascade" }),
  email: text("email").notNull(),
  name: text("name").notNull(),
  initials: text("initials").notNull(),
  handle: text("handle"),
  /** Per-member IANA timezone shared by every first-party client and Companion they operate. */
  timezone: text("timezone"),
  /**
   * Same-origin serve path for a custom uploaded avatar (`/v1/users/{id}/avatar`), or null to fall
   * back to the user's Gravatar / colored initials. Parallels `organizations.logoUrl`; the binary
   * lives in object storage under `users/{id}/avatar`.
   */
  avatarUrl: text("avatar_url"),
  /** Set when the user finishes onboarding (creates/joins an org) or accepts an invite. Null = needs onboarding. */
  onboardedAt: timestamp("onboarded_at", { withTimezone: true }),
  createdAt: now(),
  updatedAt: updatedAt(),
}, (t) => ({
  timezoneCheck: check(
    "profiles_timezone_check",
    sql`${t.timezone} is null or (char_length(${t.timezone}) between 1 and 64 and ${t.timezone} !~ E'[\\n\\r]')`,
  ),
}));

export const organizations = pgTable(
  "organizations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    slug: text("slug").notNull().unique(),
    kind: orgKindEnum("kind").notNull().default("team"),
    /** Verified email domain that grants membership (e.g. "acme.com"); null for personal/unclaimed orgs. */
    domain: text("domain"),
    /** When true, anyone signing up with a matching verified `domain` is auto-added as a member. */
    domainAutoJoin: boolean("domain_auto_join").notNull().default(false),
    /** Brand color (CSS color string) chosen during onboarding; cosmetic. */
    color: text("color"),
    /** Brand logo URL fetched/uploaded during onboarding; cosmetic. */
    logoUrl: text("logo_url"),
    /**
     * The org's own skill-naming policy: a free-text prompt describing how this organization wants
     * skills named and filed. Read by the triage skill and applied per-org. Companion imposes
     * nothing; null means this org has no policy.
     */
    skillNamingPolicy: text("skill_naming_policy"),
    /** Pi provider selected when a new Companion does not explicitly choose one. */
    defaultCompanionProviderId: text("default_companion_provider_id"),
    createdAt: now(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    defaultCompanionProviderIdCheck: check(
      "organizations_default_companion_provider_id_check",
      sql`${t.defaultCompanionProviderId} is null or ${t.defaultCompanionProviderId} ~ '^[a-z][a-z0-9-]{0,62}$'`,
    ),
  }),
);

export const organizationDomains = pgTable(
  "organization_domains",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    domain: text("domain").notNull(),
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: now(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    uniqueOrgDomain: uniqueIndex("organization_domains_org_domain_uq").on(t.orgId, sql`lower(${t.domain})`),
    byDomain: index("organization_domains_domain_idx").on(sql`lower(${t.domain})`),
  }),
);

export const memberships = pgTable(
  "memberships",
  {
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    orgRole: orgRoleEnum("org_role").notNull().default("developer"),
    createdAt: now(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.orgId, t.userId] }),
    byUser: index("memberships_user_idx").on(t.userId),
  }),
);

/**
 * Owner-managed organization for one member's Companions. Sections are roster metadata only:
 * assigning one never changes Companion access, runtime configuration, or Box/Pi state.
 */
export const companionSections = pgTable(
  "companion_sections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    ownerId: text("owner_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    position: integer("position").notNull(),
    createdAt: now(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    uniqueOrgOwnerId: unique("companion_sections_org_owner_id_uq").on(t.orgId, t.ownerId, t.id),
    uniqueOwnerName: uniqueIndex("companion_sections_owner_name_uq")
      .on(t.orgId, t.ownerId, sql`lower(${t.name})`),
    byOwnerPosition: index("companion_sections_owner_position_idx")
      .on(t.orgId, t.ownerId, t.position),
    ownerMembershipFk: foreignKey({
      columns: [t.orgId, t.ownerId],
      foreignColumns: [memberships.orgId, memberships.userId],
      name: "companion_sections_owner_membership_fk",
    }),
    nameBounds: check(
      "companion_sections_name_check",
      sql`char_length(btrim(${t.name})) between 1 and 80 and ${t.name} !~ E'[\\n\\r]'`,
    ),
    positionBounds: check("companion_sections_position_check", sql`${t.position} >= 0`),
  }),
);

/**
 * Durable control-plane projection for one Companion. Runtime sessions and transcripts stay on
 * the Box disk; this row contains only enough metadata to list/open without contacting or waking
 * the Box. Provider credentials and desktop URLs must never be stored here.
 */
export const companions = pgTable(
  "companions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id),
    ownerId: text("owner_id")
      .notNull()
      .references(() => user.id),
    sectionId: uuid("section_id"),
    name: text("name").notNull(),
    /** One short operator-authored line describing the Companion; never a system prompt. */
    persona: text("persona"),
    /**
     * Cosmetic icon indexes (THE-382) into fixed client-side catalogs. Purely presentational:
     * changing them never bumps a settings revision and never contacts Box or Pi.
     */
    iconShape: smallint("icon_shape").notNull().default(1),
    iconMouth: smallint("icon_mouth").notNull().default(1),
    iconAccessory: smallint("icon_accessory").notNull().default(1),
    iconColor: smallint("icon_color").notNull().default(2),
    /** Pi model id selected from the provider's pinned Companion catalog. */
    modelId: text("model_id"),
    /**
     * Exact Skills Hub skill ids this Companion may stage onto its Box. Empty means no library
     * skills; the bundled Companion agent skill may still be injected separately for hub access.
     */
    selectedSkillIds: jsonb("selected_skill_ids").$type<string[]>().notNull().default([]),
    /**
     * Legacy THE-360 flag, pinned true by 0101: Skills Hub access is unconditional and carried by
     * the ephemeral token the runtime mints for each staging. It stays because operation snapshots
     * and projections already read it.
     */
    canWriteSkills: boolean("can_write_skills").notNull().default(true),
    /**
     * Exact companion_mcp_accounts ids this Companion may stage onto its Box. Empty means no
     * member MCP pins beyond whatever the Pi runtime itself requires (the adapter binary only).
     */
    selectedMcpAccountIds: jsonb("selected_mcp_account_ids").$type<string[]>().notNull().default([]),
    providerIds: jsonb("provider_ids").$type<string[]>().notNull().default([]),
    /**
     * Minimum Skill selection revision required before dispatch. Publications do not advance it.
     */
    skillsRevision: integer("skills_revision").notNull().default(1),
    /**
     * Latest selected-Skill content revision available for the next user-initiated Pi stop/recycle.
     * Publications advance this without making an already-installed tree ineligible for dispatch.
     */
    skillsAvailableRevision: integer("skills_available_revision").notNull().default(1),
    createdAt: now(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    uniqueOrgId: unique("companions_org_id_id_uq").on(t.orgId, t.id),
    uniqueOwnerIdentity: unique("companions_org_id_id_owner_id_uq").on(t.orgId, t.id, t.ownerId),
    byOrgUpdated: index("companions_org_updated_idx").on(t.orgId, t.updatedAt),
    bySection: index("companions_section_idx").on(t.orgId, t.sectionId),
    ownerMembershipFk: foreignKey({
      columns: [t.orgId, t.ownerId],
      foreignColumns: [memberships.orgId, memberships.userId],
      name: "companions_owner_membership_fk",
    }),
    sectionFk: foreignKey({
      columns: [t.orgId, t.ownerId, t.sectionId],
      foreignColumns: [companionSections.orgId, companionSections.ownerId, companionSections.id],
      name: "companions_section_fk",
    }).onDelete("restrict"),
    personaLength: check(
      "companions_persona_check",
      sql`${t.persona} is null or char_length(${t.persona}) <= 280`,
    ),
    skillsRevisionBounds: check(
      "companions_skills_revision_check",
      sql`${t.skillsRevision} >= 1 and ${t.skillsAvailableRevision} >= ${t.skillsRevision}`,
    ),
    iconShapeBounds: check(
      "companions_icon_shape_check",
      sql`${t.iconShape} between 0 and 7`,
    ),
    iconMouthBounds: check(
      "companions_icon_mouth_check",
      sql`${t.iconMouth} between 0 and 4`,
    ),
    iconAccessoryBounds: check(
      "companions_icon_accessory_check",
      sql`${t.iconAccessory} between 0 and 6`,
    ),
    iconColorBounds: check(
      "companions_icon_color_check",
      sql`${t.iconColor} between 0 and 10`,
    ),
  }),
);

/** Directed, Owner-approved authority for one Companion to enqueue work on another. */
export const companionPeerGrants = pgTable(
  "companion_peer_grants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    sourceCompanionId: uuid("source_companion_id").notNull(),
    targetCompanionId: uuid("target_companion_id").notNull(),
    grantedById: text("granted_by_id").notNull().references(() => user.id, { onDelete: "restrict" }),
    revokedById: text("revoked_by_id").references(() => user.id, { onDelete: "set null" }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: now(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    directedPair: unique("companion_peer_grants_pair_uq").on(
      t.orgId,
      t.sourceCompanionId,
      t.targetCompanionId,
    ),
    sourceFk: foreignKey({
      columns: [t.orgId, t.sourceCompanionId],
      foreignColumns: [companions.orgId, companions.id],
      name: "companion_peer_grants_source_fk",
    }).onDelete("cascade"),
    targetFk: foreignKey({
      columns: [t.orgId, t.targetCompanionId],
      foreignColumns: [companions.orgId, companions.id],
      name: "companion_peer_grants_target_fk",
    }).onDelete("cascade"),
    noSelf: check(
      "companion_peer_grants_no_self_check",
      sql`${t.sourceCompanionId} <> ${t.targetCompanionId}`,
    ),
  }),
);

/** Short-lived hash-only capability held by the loopback gateway, never by Pi. */
export const companionControlTokens = pgTable(
  "companion_control_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    companionId: uuid("companion_id").notNull(),
    stagedActorId: text("staged_actor_id").notNull(),
    tokenPrefix: text("token_prefix").notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    createdAt: now(),
  },
  (t) => ({
    companionFk: foreignKey({
      columns: [t.orgId, t.companionId],
      foreignColumns: [companions.orgId, companions.id],
      name: "companion_control_tokens_companion_fk",
    }).onDelete("cascade"),
    actorMembershipFk: foreignKey({
      columns: [t.orgId, t.stagedActorId],
      foreignColumns: [memberships.orgId, memberships.userId],
      name: "companion_control_tokens_actor_membership_fk",
    }).onDelete("cascade"),
    expiry: index("companion_control_tokens_expiry_idx").on(t.expiresAt),
  }),
);

/**
 * Scheduled Companion prompts. Cron is stored as text and parsed only in TypeScript; SQL never
 * computes the next fire. `next_fire_at` is NULL exactly when the routine is disabled.
 *
 * `next_fire_at` keeps millisecond precision because the worker claims a routine, carries the
 * instant through a JavaScript `Date`, and hands it back as the fire fence. Microseconds would
 * survive in PostgreSQL but not in the round trip, so the fence would fail closed forever.
 */
export const companionRoutines = pgTable(
  "companion_routines",
  {
    id: uuid("id").primaryKey().notNull(),
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "restrict" }),
    companionId: uuid("companion_id").notNull(),
    name: text("name").notNull(),
    prompt: text("prompt").notNull(),
    cron: text("cron").notNull(),
    timezone: text("timezone").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    nextFireAt: timestamp("next_fire_at", { withTimezone: true, precision: 3 }),
    lastFiredAt: timestamp("last_fired_at", { withTimezone: true }),
    lastErrorCode: text("last_error_code"),
    lastErrorMessage: text("last_error_message"),
    lastErrorAt: timestamp("last_error_at", { withTimezone: true }),
    consecutiveFailures: integer("consecutive_failures").notNull().default(0),
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    claimedBy: text("claimed_by"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    createdAt: now(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    uniqueOrgCompanionId: unique("companion_routines_org_companion_id_uq").on(t.orgId, t.companionId, t.id),
    companionFk: foreignKey({
      columns: [t.orgId, t.companionId],
      foreignColumns: [companions.orgId, companions.id],
      name: "companion_routines_companion_fk",
    }).onDelete("cascade"),
    nameUnique: uniqueIndex("companion_routines_name_uq").on(t.companionId, sql`lower(${t.name})`),
    due: index("companion_routines_due_idx").on(t.nextFireAt).where(sql`${t.enabled} and ${t.nextFireAt} is not null`),
    nameCheck: check("companion_routines_name_check", sql`char_length(btrim(${t.name})) between 1 and 80 and ${t.name} !~ E'[\\n\\r]'`),
    promptCheck: check("companion_routines_prompt_check", sql`char_length(btrim(${t.prompt})) between 1 and 16384`),
    cronCheck: check("companion_routines_cron_check", sql`char_length(${t.cron}) between 1 and 120 and ${t.cron} !~ E'[\\n\\r]'`),
    timezoneCheck: check("companion_routines_timezone_check", sql`char_length(${t.timezone}) between 1 and 64 and ${t.timezone} !~ E'[\\n\\r]'`),
    nextFireCheck: check("companion_routines_next_fire_check", sql`(${t.enabled} and ${t.nextFireAt} is not null) or (not ${t.enabled} and ${t.nextFireAt} is null)`),
    errorCheck: check("companion_routines_error_check", sql`((${t.lastErrorCode} is null) = (${t.lastErrorMessage} is null)) and ((${t.lastErrorCode} is null) = (${t.lastErrorAt} is null)) and (${t.lastErrorCode} is null or ${t.lastErrorCode} ~ '^[a-z][a-z0-9_]{0,63}$') and (${t.lastErrorMessage} is null or (char_length(${t.lastErrorMessage}) <= 500 and ${t.lastErrorMessage} !~ E'[\\n\\r]')) and ${t.consecutiveFailures} >= 0`),
    leaseCheck: check("companion_routines_lease_check", sql`(${t.claimedBy} is null) = (${t.leaseExpiresAt} is null) and (${t.claimedBy} is null or (char_length(${t.claimedBy}) between 1 and 200 and ${t.claimedBy} !~ E'[\\n\\r]'))`),
  }),
);

/**
 * Webhook-fired Companion prompts — the event-driven sibling of `companion_routines`. The secret is
 * a share-token-style URL credential: generated server-side, stored as text, compared with a
 * constant-time check, and shown only to Owner/Editor. No worker claims these; the API fires them
 * synchronously in the webhook request through the same Owner-impersonating enqueue as routines.
 */
export const companionTriggers = pgTable(
  "companion_triggers",
  {
    id: uuid("id").primaryKey().notNull(),
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "restrict" }),
    companionId: uuid("companion_id").notNull(),
    name: text("name").notNull(),
    prompt: text("prompt").notNull(),
    mode: text("mode").notNull().default("relay"),
    provider: text("provider").notNull(),
    providerAccountId: uuid("provider_account_id"),
    secret: text("secret").notNull(),
    target: jsonb("target").$type<Record<string, unknown>>().notNull().default({}),
    remoteHookId: text("remote_hook_id"),
    remoteHookAccountId: uuid("remote_hook_account_id"),
    registrationStatus: text("registration_status").notNull().default("manual"),
    lastRegistrationError: text("last_registration_error"),
    enabled: boolean("enabled").notNull().default(true),
    lastFiredAt: timestamp("last_fired_at", { withTimezone: true }),
    lastErrorCode: text("last_error_code"),
    lastErrorMessage: text("last_error_message"),
    lastErrorAt: timestamp("last_error_at", { withTimezone: true }),
    consecutiveFailures: integer("consecutive_failures").notNull().default(0),
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: now(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    uniqueOrgCompanionId: unique("companion_triggers_org_companion_id_uq").on(t.orgId, t.companionId, t.id),
    companionFk: foreignKey({
      columns: [t.orgId, t.companionId],
      foreignColumns: [companions.orgId, companions.id],
      name: "companion_triggers_companion_fk",
    }).onDelete("cascade"),
    nameUnique: uniqueIndex("companion_triggers_name_uq").on(t.companionId, sql`lower(${t.name})`),
    nameCheck: check("companion_triggers_name_check", sql`char_length(btrim(${t.name})) between 1 and 80 and ${t.name} !~ E'[\\n\\r]'`),
    promptCheck: check("companion_triggers_prompt_check", sql`char_length(btrim(${t.prompt})) between 1 and 16384`),
    modeCheck: check("companion_triggers_mode_check", sql`${t.mode} in ('notify', 'relay')`),
    providerCheck: check("companion_triggers_provider_check", sql`${t.provider} in ('webhook', 'linear', 'github', 'sentry', 'custom')`),
    targetShapeCheck: check("companion_triggers_target_shape_check", sql`jsonb_typeof(${t.target}) = 'object'`),
    registrationStatusCheck: check(
      "companion_triggers_registration_status_check",
      sql`${t.registrationStatus} in ('manual', 'unregistered', 'registered', 'failed')`,
    ),
    secretCheck: check("companion_triggers_secret_check", sql`${t.secret} ~ '^[0-9a-f]{32,128}$'`),
    errorCheck: check("companion_triggers_error_check", sql`((${t.lastErrorCode} is null) = (${t.lastErrorMessage} is null)) and ((${t.lastErrorCode} is null) = (${t.lastErrorAt} is null)) and (${t.lastErrorCode} is null or ${t.lastErrorCode} ~ '^[a-z][a-z0-9_]{0,63}$') and (${t.lastErrorMessage} is null or (char_length(${t.lastErrorMessage}) <= 500 and ${t.lastErrorMessage} !~ E'[\\n\\r]')) and ${t.consecutiveFailures} >= 0`),
  }),
);

/**
 * Global one-shot maintenance ledger for the Runtime v2 cutover. These rows intentionally have no
 * tenant or Companion foreign key: they are inaccessible to application roles and must outlive the
 * legacy ownership rows so a partial provider purge can resume and PR4 can prove completion.
 */
export const companionLegacyPurgeRuns = pgTable(
  "companion_legacy_purge_runs",
  {
    id: text("id").primaryKey().notNull().default("legacy-companion-purge"),
    phase: text("phase").$type<CompanionLegacyPurgePhase>().notNull().default("deleting_external"),
    inventoryHash: text("inventory_hash").notNull(),
    inventory: jsonb("inventory").$type<SchemaJsonObject>().notNull().default({}),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: updatedAt(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => ({
    singleton: check(
      "companion_legacy_purge_runs_singleton_check",
      sql`${t.id} = 'legacy-companion-purge'`,
    ),
    phaseCheck: check(
      "companion_legacy_purge_runs_phase_check",
      sql`${t.phase} in ('deleting_external', 'external_complete', 'database_complete')`,
    ),
    inventoryHashCheck: check(
      "companion_legacy_purge_runs_inventory_hash_check",
      sql`${t.inventoryHash} ~ '^[0-9a-f]{64}$'`,
    ),
    inventoryObject: check(
      "companion_legacy_purge_runs_inventory_check",
      sql`jsonb_typeof(${t.inventory}) = 'object'`,
    ),
    completedState: check(
      "companion_legacy_purge_runs_completed_check",
      sql`(${t.phase} = 'database_complete') = (${t.completedAt} is not null)`,
    ),
  }),
);

export const companionLegacyPurgeTargets = pgTable(
  "companion_legacy_purge_targets",
  {
    boxId: text("box_id").primaryKey(),
    observedName: text("observed_name"),
    evidence: jsonb("evidence").$type<string[]>().notNull().default([]),
    state: text("state").$type<CompanionLegacyPurgeTargetState>().notNull().default("discovered"),
    operationId: text("operation_id"),
    attemptCount: integer("attempt_count").notNull().default(0),
    requestedAt: timestamp("requested_at", { withTimezone: true }),
    lastPolledAt: timestamp("last_polled_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    lastError: text("last_error"),
    createdAt: now(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    operationIdUnique: uniqueIndex("companion_legacy_purge_targets_operation_id_uq")
      .on(t.operationId)
      .where(sql`${t.operationId} is not null`),
    boxIdCheck: check(
      "companion_legacy_purge_targets_box_id_check",
      sql`${t.boxId} ~ '^bx_[23456789abcdefghjkmnpqrstuvwxyz]{8}$'`,
    ),
    evidenceArray: check(
      "companion_legacy_purge_targets_evidence_check",
      sql`jsonb_typeof(${t.evidence}) = 'array'`,
    ),
    stateCheck: check(
      "companion_legacy_purge_targets_state_check",
      sql`${t.state} in ('discovered', 'requesting', 'pending', 'processing', 'blocked', 'completed', 'absent')`,
    ),
    operationIdCheck: check(
      "companion_legacy_purge_targets_operation_id_check",
      sql`${t.operationId} is null or ${t.operationId} ~ '^bdop_[0-9a-f]{32}$'`,
    ),
    operationState: check(
      "companion_legacy_purge_targets_operation_state_check",
      sql`(
        ${t.state} in ('pending', 'processing', 'blocked', 'completed')
        and ${t.operationId} is not null
      ) or (
        ${t.state} in ('discovered', 'requesting', 'absent')
        and ${t.operationId} is null
      )`,
    ),
    attemptCountBounds: check(
      "companion_legacy_purge_targets_attempt_count_check",
      sql`${t.attemptCount} >= 0`,
    ),
    lastErrorCheck: check(
      "companion_legacy_purge_targets_last_error_check",
      sql`${t.lastError} is null or (char_length(${t.lastError}) <= 500 and ${t.lastError} !~ E'[\\n\\r]')`,
    ),
    completedState: check(
      "companion_legacy_purge_targets_completed_check",
      sql`(${t.state} in ('completed', 'absent')) = (${t.completedAt} is not null)`,
    ),
  }),
);

/** Authoritative singleton kill switch for the isolated Runtime v2 role. */
export const companionRuntimeControl = pgTable(
  "companion_runtime_control",
  {
    id: text("id").primaryKey().notNull().default("runtime-v2"),
    enabled: boolean("enabled").notNull().default(false),
    gateEpoch: bigint("gate_epoch", { mode: "number" }).notNull().default(1),
    enabledAt: timestamp("enabled_at", { withTimezone: true }),
    disabledAt: timestamp("disabled_at", { withTimezone: true }).defaultNow(),
    changedBy: text("changed_by"),
    updatedAt: updatedAt(),
  },
  (t) => ({
    singleton: check("companion_runtime_control_singleton_check", sql`${t.id} = 'runtime-v2'`),
    epoch: check("companion_runtime_control_epoch_check", sql`${t.gateEpoch} >= 1`),
    state: check(
      "companion_runtime_control_state_check",
      sql`(${t.enabled} and ${t.enabledAt} is not null and ${t.disabledAt} is null)
        or (not ${t.enabled} and ${t.disabledAt} is not null)`,
    ),
    actor: check(
      "companion_runtime_control_actor_check",
      sql`${t.changedBy} is null or (char_length(${t.changedBy}) between 1 and 200 and ${t.changedBy} !~ E'[\\n\\r]')`,
    ),
  }),
);

// Drizzle resolves table extra-config callbacks after module initialization. The explicit return
// type breaks the deliberate Runtime instance <-> turn inference cycle while keeping both
// composite tenant FKs represented in this schema.
function companionTurnCompositeKeyColumns(): [AnyPgColumn, AnyPgColumn, AnyPgColumn] {
  return [companionTurns.orgId, companionTurns.companionId, companionTurns.id];
}

/** Identifier-only one-Companion/one-Box/one-Pi Runtime v2 projection. */
export const companionImages = pgTable(
  "companion_images",
  {
    /** Full layout identity marker hash (see companionPiLayoutIdentity). */
    digest: text("digest").primaryKey(),
    /** ascii.dev named snapshot the bake publishes. */
    imageName: text("image_name").notNull().unique(),
    status: companionImageStatusEnum("status").notNull().default("requested"),
    parentImageName: text("parent_image_name"),
    buildBoxId: text("build_box_id"),
    buildDeleteIntentAt: timestamp("build_delete_intent_at", { withTimezone: true }),
    buildDeleteOperationId: text("build_delete_operation_id"),
    attemptCount: integer("attempt_count").notNull().default(0),
    lastErrorCode: text("last_error_code"),
    lastErrorMessage: text("last_error_message"),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    claimEpoch: bigint("claim_epoch", { mode: "number" }).notNull().default(0),
    claimActorId: text("claim_actor_id"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    requestedAt: timestamp("requested_at", { withTimezone: true }).notNull().defaultNow(),
    buildingAt: timestamp("building_at", { withTimezone: true }),
    readyAt: timestamp("ready_at", { withTimezone: true }),
    createdAt: now(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    statusCheck: check(
      "companion_images_status_check",
      sql`(${t.status} = 'ready') = (${t.readyAt} is not null)`,
    ),
    errorCheck: check(
      "companion_images_error_check",
      sql`((${t.lastErrorCode} is null) = (${t.lastErrorMessage} is null))
          and (${t.status} <> 'failed' or ${t.lastErrorCode} is not null)
          and (${t.status} <> 'ready' or ${t.lastErrorCode} is null)`,
    ),
    claimCheck: check(
      "companion_images_claim_check",
      sql`(${t.status} = 'building') = (${t.claimActorId} is not null) and ${t.claimEpoch} >= 0`,
    ),
    buildableIdx: index("companion_images_buildable_idx")
      .on(t.nextAttemptAt, t.digest)
      .where(sql`${t.status} in ('requested','failed')`),
  }),
);

export const companionRuntimeInstances = pgTable(
  "companion_runtime_instances",
  {
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "restrict" }),
    companionId: uuid("companion_id").primaryKey().notNull(),
    generation: bigint("generation", { mode: "number" }).notNull().default(1),
    boxId: text("box_id"),
    boxState: companionBoxObservedStateEnum("box_state").notNull().default("absent"),
    piState: companionPiObservedStateEnum("pi_state").notNull().default("absent"),
    piInvocationId: text("pi_invocation_id"),
    diskLayoutVersion: integer("disk_layout_version").notNull().default(0),
    desiredSettingsRevision: bigint("desired_settings_revision", { mode: "number" }).notNull().default(1),
    appliedSettingsRevision: bigint("applied_settings_revision", { mode: "number" }).notNull().default(0),
    appliedSkillsRevision: integer("applied_skills_revision").notNull().default(0),
    appliedSelectedSkillIds: jsonb("applied_selected_skill_ids").$type<string[]>().notNull().default([]),
    appliedSkillRefs: jsonb("applied_skill_refs")
      .$type<Array<{ skill_id: string; current_version_id: string | null }>>()
      .notNull()
      .default([]),
    appliedSkillsDigest: text("applied_skills_digest"),
    skillsUpdateErrorCode: text("skills_update_error_code"),
    skillsUpdateErrorMessage: text("skills_update_error_message"),
    appliedClientSurface: companionClientSurfaceEnum("applied_client_surface"),
    materialClientSurface: companionClientSurfaceEnum("material_client_surface"),
    materialPiInvocationId: text("material_pi_invocation_id"),
    materialExpiresAt: timestamp("material_expires_at", { withTimezone: true }),
    // Hosted direct-transport agent endpoint (0125). The URL is token-free; every credential lives
    // in the masterKey ciphertext, and observed_at is the freshness bound a consumer must judge.
    agentHostedUrl: text("agent_hosted_url"),
    agentTokenCiphertext: text("agent_token_ciphertext"),
    agentObservedAt: timestamp("agent_observed_at", { withTimezone: true }),
    settingsActorId: text("settings_actor_id"),
    settingsCheckpoint: text("settings_checkpoint").notNull().default("pending"),
    settingsCheckpointSequence: bigint("settings_checkpoint_sequence", { mode: "number" }).notNull().default(0),
    settingsClaimEpoch: bigint("settings_claim_epoch", { mode: "number" }),
    settingsClaimActorId: text("settings_claim_actor_id"),
    settingsClaimClientSurface: companionClientSurfaceEnum("settings_claim_client_surface"),
    settingsClaimTurnId: uuid("settings_claim_turn_id"),
    settingsClaimColdStartDeadlineAt: timestamp("settings_claim_cold_start_deadline_at", { withTimezone: true }),
    settingsClaimRevision: bigint("settings_claim_revision", { mode: "number" }),
    settingsClaimSkillsRevision: integer("settings_claim_skills_revision"),
    settingsClaimModelId: text("settings_claim_model_id"),
    settingsClaimPersona: text("settings_claim_persona"),
    settingsClaimCanWriteSkills: boolean("settings_claim_can_write_skills"),
    settingsClaimProviderIds: jsonb("settings_claim_provider_ids").$type<string[]>(),
    settingsClaimSelectedSkillIds: jsonb("settings_claim_selected_skill_ids").$type<string[]>(),
    settingsClaimSkillRefs: jsonb("settings_claim_skill_refs").$type<Array<{ skill_id: string; current_version_id: string | null }>>(),
    settingsClaimSelectedMcpAccountIds: jsonb("settings_claim_selected_mcp_account_ids").$type<string[]>(),
    settingsClaimMaterialClientSurface: companionClientSurfaceEnum("settings_claim_material_client_surface"),
    settingsClaimMaterialStagedAt: timestamp("settings_claim_material_staged_at", { withTimezone: true }),
    settingsClaimMaterialExpiresAt: timestamp("settings_claim_material_expires_at", { withTimezone: true }),
    settingsAvailableAt: timestamp("settings_available_at", { withTimezone: true }).notNull().defaultNow(),
    settingsAttemptCount: integer("settings_attempt_count").notNull().default(0),
    healthCheckpoint: text("health_checkpoint").notNull().default("pending"),
    healthCheckpointSequence: bigint("health_checkpoint_sequence", { mode: "number" }).notNull().default(0),
    healthClaimEpoch: bigint("health_claim_epoch", { mode: "number" }),
    healthDueAt: timestamp("health_due_at", { withTimezone: true }).notNull().defaultNow(),
    nextTurnSequence: bigint("next_turn_sequence", { mode: "number" }).notNull().default(1),
    nextOperationSequence: bigint("next_operation_sequence", { mode: "number" }).notNull().default(1),
    lastHeartbeatAt: timestamp("last_heartbeat_at", { withTimezone: true }),
    boxObservedAt: timestamp("box_observed_at", { withTimezone: true }),
    piObservedAt: timestamp("pi_observed_at", { withTimezone: true }),
    lastObservedAt: timestamp("last_observed_at", { withTimezone: true }),
    retirementState: companionRuntimeRetirementStateEnum("retirement_state").notNull().default("active"),
    retirementRequestedAt: timestamp("retirement_requested_at", { withTimezone: true }),
    retiredAt: timestamp("retired_at", { withTimezone: true }),
    lastWriteEpoch: bigint("last_write_epoch", { mode: "number" }).notNull().default(0),
    lastErrorCode: text("last_error_code"),
    lastErrorMessage: text("last_error_message"),
    lastErrorAction: companionRuntimeErrorActionEnum("last_error_action"),
    /**
     * Current ephemeral Skills Hub token for this Box. Rotated at each staging mint; revoked
     * rows stay in api_tokens until expiry.
     */
    hubTokenId: uuid("hub_token_id").references(() => apiTokens.id, { onDelete: "set null" }),
    /** Current runtime-only MCP token broker capability. Plaintext is returned once at staging. */
    mcpBrokerTokenId: uuid("mcp_broker_token_id"),
    /** Current product-owned Companion control MCP capability. */
    controlTokenId: uuid("control_token_id"),
    createdAt: now(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    uniqueOrgCompanion: unique("companion_runtime_instances_org_companion_uq").on(t.orgId, t.companionId),
    mcpBrokerTokenFk: foreignKey({
      columns: [t.mcpBrokerTokenId],
      foreignColumns: [companionMcpBrokerTokens.id],
      name: "companion_runtime_instances_mcp_broker_token_id_fkey",
    }).onDelete("set null"),
    controlTokenFk: foreignKey({
      columns: [t.controlTokenId],
      foreignColumns: [companionControlTokens.id],
      name: "companion_runtime_instances_control_token_id_fkey",
    }).onDelete("set null"),
    boxIdUnique: uniqueIndex("companion_runtime_instances_box_id_uq").on(t.boxId).where(sql`${t.boxId} is not null`),
    healthDue: index("companion_runtime_instances_health_due_idx")
      .on(t.healthDueAt, t.companionId).where(sql`${t.retirementState} <> 'retired'`),
    companionFk: foreignKey({
      columns: [t.orgId, t.companionId], foreignColumns: [companions.orgId, companions.id],
      name: "companion_runtime_instances_companion_fk",
    }).onDelete("cascade"),
    settingsClaimTurnFk: foreignKey({
      columns: [t.orgId, t.companionId, t.settingsClaimTurnId],
      foreignColumns: companionTurnCompositeKeyColumns(),
      name: "companion_runtime_instances_settings_claim_turn_fk",
    }).onDelete("restrict"),
    generationCheck: check("companion_runtime_instances_generation_check", sql`${t.generation} between 1 and 2147483647`),
    boxIdCheck: check("companion_runtime_instances_box_id_check", sql`${t.boxId} is null or ${t.boxId} ~ '^bx_[23456789abcdefghjkmnpqrstuvwxyz]{8}$'`),
    invocationCheck: check("companion_runtime_instances_pi_invocation_check", sql`${t.piInvocationId} is null or (char_length(${t.piInvocationId}) between 1 and 200 and ${t.piInvocationId} !~ E'[\\n\\r]')`),
    revisionCheck: check("companion_runtime_instances_revision_check", sql`${t.diskLayoutVersion} >= 0 and ${t.desiredSettingsRevision} >= 1 and ${t.appliedSettingsRevision} >= 0 and ${t.appliedSettingsRevision} <= ${t.desiredSettingsRevision} and ${t.appliedSkillsRevision} >= 0 and ((${t.appliedSettingsRevision} = 0) = (${t.appliedClientSurface} is null)) and jsonb_typeof(${t.appliedSelectedSkillIds}) = 'array' and jsonb_typeof(${t.appliedSkillRefs}) = 'array' and (${t.appliedSkillsDigest} is null or ${t.appliedSkillsDigest} ~ '^[0-9a-f]{64}$') and ((${t.skillsUpdateErrorCode} is null) = (${t.skillsUpdateErrorMessage} is null)) and (${t.skillsUpdateErrorCode} is null or ${t.skillsUpdateErrorCode} ~ '^[a-z][a-z0-9_]{0,63}$') and (${t.skillsUpdateErrorMessage} is null or (char_length(${t.skillsUpdateErrorMessage}) <= 500 and ${t.skillsUpdateErrorMessage} !~ E'[\\n\\r]')) and ${t.nextTurnSequence} >= 1 and ${t.nextOperationSequence} >= 1 and ${t.lastWriteEpoch} >= 0`),
    materialSnapshotCheck: check("companion_runtime_instances_material_snapshot_check", sql`
      ((${t.materialClientSurface} is null) = (${t.materialPiInvocationId} is null))
      and (${t.materialClientSurface} is not null or ${t.materialExpiresAt} is null)
      and (${t.materialPiInvocationId} is null or
        (char_length(${t.materialPiInvocationId}) between 1 and 200
          and ${t.materialPiInvocationId} !~ E'[\\n\\r]'))
      and (${t.materialClientSurface} is null or ${t.materialExpiresAt} is not null)
      and ((${t.settingsClaimMaterialClientSurface} is null) = (${t.settingsClaimMaterialStagedAt} is null))
      and (${t.settingsClaimMaterialStagedAt} is null or ${t.settingsClaimMaterialExpiresAt} is not null)
    `),
    agentEndpointCheck: check("companion_runtime_instances_agent_endpoint_check", sql`
      ((${t.agentHostedUrl} is null) = (${t.agentTokenCiphertext} is null))
      and ((${t.agentHostedUrl} is null) = (${t.agentObservedAt} is null))
    `),
    settingsActorCheck: check("companion_runtime_instances_settings_actor_check", sql`
      (${t.settingsActorId} is null or (char_length(${t.settingsActorId}) between 1 and 200 and ${t.settingsActorId} !~ E'[\\n\\r]'))
      and (${t.settingsClaimActorId} is null or (char_length(${t.settingsClaimActorId}) between 1 and 200 and ${t.settingsClaimActorId} !~ E'[\\n\\r]'))
      and ((${t.settingsClaimEpoch} is null) = (${t.settingsClaimActorId} is null))
      and ((${t.settingsClaimEpoch} is null) = (${t.settingsClaimClientSurface} is null))
      and (${t.settingsClaimEpoch} is not null or ${t.settingsClaimTurnId} is null)
      and (${t.settingsClaimTurnId} is not null or ${t.settingsClaimColdStartDeadlineAt} is null)
      and ((${t.settingsClaimEpoch} is null) = (${t.settingsClaimRevision} is null))
      and ((${t.settingsClaimEpoch} is null) = (${t.settingsClaimSkillsRevision} is null))
      and ((${t.settingsClaimEpoch} is null) = (${t.settingsClaimCanWriteSkills} is null))
      and ((${t.settingsClaimEpoch} is null) = (${t.settingsClaimProviderIds} is null))
      and ((${t.settingsClaimEpoch} is null) = (${t.settingsClaimSelectedSkillIds} is null))
      and ((${t.settingsClaimEpoch} is null) = (${t.settingsClaimSkillRefs} is null))
      and ((${t.settingsClaimEpoch} is null) = (${t.settingsClaimSelectedMcpAccountIds} is null))
      and (${t.settingsClaimRevision} is null or ${t.settingsClaimRevision} >= 1)
      and (${t.settingsClaimSkillsRevision} is null or ${t.settingsClaimSkillsRevision} >= 0)
      and (${t.settingsClaimModelId} is null or (${t.settingsClaimEpoch} is not null and char_length(${t.settingsClaimModelId}) between 1 and 200 and ${t.settingsClaimModelId} !~ E'[\\n\\r]'))
      and (${t.settingsClaimPersona} is null or (${t.settingsClaimEpoch} is not null and char_length(${t.settingsClaimPersona}) <= 280))
      and (${t.settingsClaimProviderIds} is null or jsonb_typeof(${t.settingsClaimProviderIds}) = 'array')
      and (${t.settingsClaimSelectedSkillIds} is null or jsonb_typeof(${t.settingsClaimSelectedSkillIds}) = 'array')
      and (${t.settingsClaimSkillRefs} is null or jsonb_typeof(${t.settingsClaimSkillRefs}) = 'array')
      and (${t.settingsClaimSelectedMcpAccountIds} is null or jsonb_typeof(${t.settingsClaimSelectedMcpAccountIds}) = 'array')
    `),
    settingsCheckpointCheck: check("companion_runtime_instances_settings_checkpoint_check", sql`${t.settingsCheckpoint} in ('pending','applying','applied') and ${t.settingsCheckpointSequence} >= 0 and ${t.settingsAttemptCount} >= 0`),
    healthCheckpointCheck: check("companion_runtime_instances_health_checkpoint_check", sql`${t.healthCheckpoint} in ('pending','observing','observed') and ${t.healthCheckpointSequence} >= 0`),
    retirementCheck: check("companion_runtime_instances_retirement_check", sql`(${t.retirementState} = 'active' and ${t.retirementRequestedAt} is null and ${t.retiredAt} is null) or (${t.retirementState} in ('requested','pending','blocked') and ${t.retirementRequestedAt} is not null and ${t.retiredAt} is null) or (${t.retirementState} = 'retired' and ${t.retirementRequestedAt} is not null and ${t.retiredAt} is not null)`),
    errorCheck: check("companion_runtime_instances_error_check", sql`((${t.lastErrorCode} is null) = (${t.lastErrorMessage} is null)) and ((${t.lastErrorCode} is null) = (${t.lastErrorAction} is null)) and (${t.lastErrorCode} is null or ${t.lastErrorCode} ~ '^[a-z][a-z0-9_]{0,63}$') and (${t.lastErrorMessage} is null or (char_length(${t.lastErrorMessage}) <= 500 and ${t.lastErrorMessage} !~ E'[\\n\\r]'))`),
  }),
);

export const companionTurns = pgTable(
  "companion_turns",
  {
    id: uuid("id").primaryKey().notNull().defaultRandom(),
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "restrict" }),
    companionId: uuid("companion_id").notNull(),
    clientMessageId: uuid("client_message_id").notNull(),
    messageEventId: text("message_event_id").notNull(),
    queueSequence: bigint("queue_sequence", { mode: "number" }).notNull(),
    actorId: text("actor_id").notNull(),
    clientSurface: companionClientSurfaceEnum("client_surface").notNull(),
    status: companionTurnStatusEnum("status").notNull().default("queued"),
    /** Terminal interruption cleanup outcome; the original safe error remains intact. */
    resolution: text("resolution"),
    coldStartDeadlineAt: timestamp("cold_start_deadline_at", { withTimezone: true }),
    inactivityDeadlineAt: timestamp("inactivity_deadline_at", { withTimezone: true }),
    absoluteDeadlineAt: timestamp("absolute_deadline_at", { withTimezone: true }),
    stateChangedAt: timestamp("state_changed_at", { withTimezone: true }).notNull().defaultNow(),
    settledAt: timestamp("settled_at", { withTimezone: true }),
    lastErrorCode: text("last_error_code"),
    lastErrorMessage: text("last_error_message"),
    lastErrorAction: companionRuntimeErrorActionEnum("last_error_action"),
    /**
     * Originating routine, if this turn was a scheduled fire. `routine_id` is SET NULL if the
     * routine is deleted; `routine_name` is the snapshot that still labels the transcript.
     */
    routineId: uuid("routine_id").references(() => companionRoutines.id, { onDelete: "set null" }),
    routineName: text("routine_name"),
    /** Immutable routine id snapshot; unlike routine_id it survives routine deletion. */
    routineSnapshotId: uuid("routine_snapshot_id"),
    /** Exact routine-definition generation; prevents a reused UUID from adopting old outcomes. */
    routineSnapshotCreatedAt: timestamp("routine_snapshot_created_at", { withTimezone: true }),
    /** Durable execution-mode pin. Once true, takeover never falls back to the main Pi session. */
    routineIsolated: boolean("routine_isolated").notNull().default(false),
    /** Content-addressed runtime-only main-conversation background pinned before Box contact. */
    routineContextSubstrateId: uuid("routine_context_substrate_id"),
    /** For relay turns, the one surfaced Companion entry the main Pi is asked to answer. */
    routineRelaySourceEventId: text("routine_relay_source_event_id"),
    /**
     * Originating trigger, if this turn was a webhook fire. Same snapshot rules as a routine:
     * `trigger_id` is SET NULL if the trigger is deleted; `trigger_name` still labels the transcript.
     */
    triggerId: uuid("trigger_id").references(() => companionTriggers.id, { onDelete: "set null" }),
    triggerName: text("trigger_name"),
    /** Trigger v2 validates in the isolated lane and pins the configured terminal surface mode. */
    triggerMode: text("trigger_mode"),
    /** Delegation whose request this main-lane turn is executing, if any. */
    delegationId: uuid("delegation_id").references(
      (): AnyPgColumn => companionDelegations.id,
      { onDelete: "set null" },
    ),
    /** Delegation result fed back to this Companion for relay synthesis, if any. */
    delegationReturnId: uuid("delegation_return_id").references(
      (): AnyPgColumn => companionDelegations.id,
      { onDelete: "set null" },
    ),
    /**
     * Set when an Owner/Editor asks to stop an active turn whose prompt may already be on Pi.
     * The executor that holds the lease aborts Pi and settles; the API never contacts Box.
     */
    cancelRequestedAt: timestamp("cancel_requested_at", { withTimezone: true }),
    createdAt: now(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    uniqueOrgCompanionId: unique("companion_turns_org_companion_id_uq").on(t.orgId, t.companionId, t.id),
    clientMessageUnique: unique("companion_turns_client_message_uq").on(t.companionId, t.clientMessageId),
    queueSequenceUnique: unique("companion_turns_queue_sequence_uq").on(t.companionId, t.queueSequence),
    oneActiveMain: uniqueIndex("companion_turns_one_active_main_uq").on(t.companionId).where(sql`${t.status} in ('starting','dispatching','running','needs_input') and ${t.routineSnapshotId} is null`),
    oneActiveRoutine: uniqueIndex("companion_turns_one_active_routine_uq").on(t.companionId).where(sql`${t.status} in ('starting','dispatching','running','needs_input') and ${t.routineSnapshotId} is not null`),
    queued: index("companion_turns_queue_idx").on(t.companionId, t.queueSequence).where(sql`${t.status} = 'queued'`),
    queuedRoutineExpiry: index("companion_turns_queued_routine_expiry_idx").on(t.createdAt, t.queueSequence, t.id).where(sql`${t.status} = 'queued' and (${t.routineSnapshotId} is not null or ${t.routineName} is not null)`),
    deadline: index("companion_turns_deadline_idx").on(t.coldStartDeadlineAt, t.inactivityDeadlineAt, t.absoluteDeadlineAt).where(sql`${t.status} in ('starting','dispatching','running','needs_input')`),
    autoAbandonedMetrics: index("companion_turns_auto_abandoned_metrics_idx")
      .on(t.updatedAt)
      .where(sql`${t.resolution} = 'auto_abandoned'`),
    runtimeInstanceFk: foreignKey({ columns: [t.orgId, t.companionId], foreignColumns: [companionRuntimeInstances.orgId, companionRuntimeInstances.companionId], name: "companion_turns_runtime_instance_fk" }).onDelete("cascade"),
    queueSequenceCheck: check("companion_turns_queue_sequence_check", sql`${t.queueSequence} >= 1`),
    messageEventCheck: check("companion_turns_message_event_check", sql`${t.messageEventId} = 'msg:' || ${t.clientMessageId}::text`),
    actorCheck: check("companion_turns_actor_check", sql`char_length(${t.actorId}) between 1 and 200 and ${t.actorId} !~ E'[\\n\\r]'`),
    deadlineCheck: check("companion_turns_deadline_check", sql`(${t.coldStartDeadlineAt} is null or ${t.coldStartDeadlineAt} >= ${t.createdAt}) and (${t.status} <> 'needs_input' or ${t.inactivityDeadlineAt} is null) and ((${t.status} in ('queued','cancelled') and ${t.inactivityDeadlineAt} is null and ${t.absoluteDeadlineAt} is null) or (${t.status} <> 'queued' and ${t.absoluteDeadlineAt} is not null and (${t.inactivityDeadlineAt} is null or ${t.absoluteDeadlineAt} >= ${t.inactivityDeadlineAt})))`),
    terminalCheck: check("companion_turns_terminal_check", sql`(${t.status} in ('succeeded','failed','interrupted','cancelled')) = (${t.settledAt} is not null)`),
    resolutionCheck: check("companion_turns_resolution_check", sql`${t.resolution} is null or (${t.resolution} = 'auto_abandoned' and ${t.status} = 'interrupted')`),
    interruptedActionCheck: check("companion_turns_interrupted_action_check", sql`${t.status} <> 'interrupted' or ${t.lastErrorAction} = 'none'`),
    errorCheck: check("companion_turns_error_check", sql`((${t.lastErrorCode} is null) = (${t.lastErrorMessage} is null)) and (((${t.lastErrorCode} is null) = (${t.lastErrorAction} is null)) or (${t.status} = 'cancelled' and ${t.routineName} is not null and ${t.lastErrorCode} is not null and ${t.lastErrorAction} = 'none')) and (${t.lastErrorCode} is null or ${t.lastErrorCode} ~ '^[a-z][a-z0-9_]{0,63}$') and (${t.lastErrorMessage} is null or (char_length(${t.lastErrorMessage}) <= 500 and ${t.lastErrorMessage} !~ E'[\\n\\r]')) and (${t.status} not in ('failed','interrupted') or ${t.lastErrorCode} is not null) and (${t.status} not in ('succeeded','cancelled') or ${t.lastErrorCode} is null or (${t.status} = 'cancelled' and ${t.routineName} is not null and ${t.lastErrorAction} = 'none'))`),
    messageEvent: index("companion_turns_message_event_idx").on(t.companionId, t.messageEventId),
    routineOriginCheck: check("companion_turns_routine_origin_check", sql`(${t.routineId} is null or ${t.routineName} is not null) and (${t.routineName} is null or (char_length(${t.routineName}) between 1 and 80 and ${t.routineName} !~ E'[\\n\\r]'))`),
    routineSnapshotCheck: check("companion_turns_routine_snapshot_check", sql`${t.routineSnapshotId} is null or ${t.routineName} is not null or ${t.triggerName} is not null`),
    routineIsolationCheck: check("companion_turns_routine_isolation_check", sql`not ${t.routineIsolated} or (${t.routineSnapshotId} is not null and ${t.routineContextSubstrateId} is not null)`),
    routineRelaySourceCheck: check("companion_turns_routine_relay_source_check", sql`${t.routineRelaySourceEventId} is null or (char_length(${t.routineRelaySourceEventId}) between 1 and 200 and ${t.routineRelaySourceEventId} !~ E'[\n\r]' and ${t.routineName} is null)`),
    routineSnapshot: index("companion_turns_routine_snapshot_idx").on(t.orgId, t.companionId, t.routineSnapshotId, t.queueSequence, t.id).where(sql`${t.routineSnapshotId} is not null`),
    triggerOriginCheck: check("companion_turns_trigger_origin_check", sql`(${t.triggerId} is null or ${t.triggerName} is not null) and (${t.triggerName} is null or (char_length(${t.triggerName}) between 1 and 80 and ${t.triggerName} !~ E'[\\n\\r]')) and (${t.triggerName} is null or ${t.routineId} is null)`),
    triggerModeCheck: check("companion_turns_trigger_mode_check", sql`(${t.triggerName} is null and ${t.triggerMode} is null) or (${t.triggerName} is not null and ${t.triggerMode} in ('notify', 'relay'))`),
  }),
);

/** Dormant Runtime v3 aggregate facts; no production composition root reads these yet. */
export const companionV3Instances = pgTable(
  "companion_v3_instances",
  {
    orgId: uuid("org_id").notNull(),
    companionId: uuid("companion_id").notNull(),
    desiredLifecycle: companionV3LifecycleIntentEnum("desired_lifecycle").notNull().default("prepare"),
    desiredLifecycleRevision: bigint("desired_lifecycle_revision", { mode: "number" }).notNull().default(1),
    desiredLifecycleActorId: text("desired_lifecycle_actor_id"),
    nextMainSequence: bigint("next_main_sequence", { mode: "number" }).notNull().default(1),
    nextBackgroundSequence: bigint("next_background_sequence", { mode: "number" }).notNull().default(1),
    createdAt: now(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.orgId, t.companionId] }),
    companionFk: foreignKey({
      columns: [t.orgId, t.companionId],
      foreignColumns: [companions.orgId, companions.id],
      name: "companion_v3_instances_companion_fk",
    }).onDelete("cascade"),
    revisionCheck: check(
      "companion_v3_instances_revision_check",
      sql`${t.desiredLifecycleRevision} >= 1 and ${t.nextMainSequence} >= 1 and ${t.nextBackgroundSequence} >= 1`,
    ),
    actorCheck: check(
      "companion_v3_instances_actor_check",
      sql`${t.desiredLifecycleActorId} is null or (char_length(${t.desiredLifecycleActorId}) between 1 and 200 and ${t.desiredLifecycleActorId} !~ E'[\n\r]')`,
    ),
  }),
);

/** One Runtime v3 Turn owns command identity, admission facts, activity, outcome, and lane. */
export const companionV3Turns = pgTable(
  "companion_v3_turns",
  {
    id: uuid("id").primaryKey().notNull().defaultRandom(),
    orgId: uuid("org_id").notNull(),
    companionId: uuid("companion_id").notNull(),
    commandId: uuid("command_id").notNull(),
    clientMessageId: uuid("client_message_id").notNull(),
    messageEventId: text("message_event_id").notNull(),
    actorId: text("actor_id").notNull(),
    lane: companionV3LaneEnum("lane").notNull(),
    queueSequence: bigint("queue_sequence", { mode: "number" }).notNull(),
    state: companionV3TurnStateEnum("state").notNull().default("queued"),
    admissionState: companionV3AdmissionStateEnum("admission_state").notNull().default("pending"),
    admittedAt: timestamp("admitted_at", { withTimezone: true }),
    piInvocationId: text("pi_invocation_id"),
    admissionCursor: bigint("admission_cursor", { mode: "number" }),
    activityCursor: bigint("activity_cursor", { mode: "number" }).notNull().default(0),
    lastActivityAt: timestamp("last_activity_at", { withTimezone: true }),
    outcome: companionV3TurnOutcomeEnum("outcome"),
    outcomeCode: text("outcome_code"),
    outcomeMessage: text("outcome_message"),
    settledAt: timestamp("settled_at", { withTimezone: true }),
    createdAt: now(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    uniqueOrgCompanionId: unique("companion_v3_turns_org_companion_id_uq")
      .on(t.orgId, t.companionId, t.id),
    commandUnique: unique("companion_v3_turns_command_uq").on(t.companionId, t.commandId),
    clientMessageUnique: unique("companion_v3_turns_client_message_uq")
      .on(t.companionId, t.clientMessageId),
    laneSequenceUnique: unique("companion_v3_turns_lane_sequence_uq")
      .on(t.companionId, t.lane, t.queueSequence),
    instanceFk: foreignKey({
      columns: [t.orgId, t.companionId],
      foreignColumns: [companionV3Instances.orgId, companionV3Instances.companionId],
      name: "companion_v3_turns_instance_fk",
    }).onDelete("cascade"),
    fifo: index("companion_v3_turns_fifo_idx")
      .on(t.companionId, t.lane, t.queueSequence, t.id)
      .where(sql`${t.state} = 'queued'`),
    sequenceCheck: check("companion_v3_turns_sequence_check", sql`${t.queueSequence} >= 1`),
    messageEventCheck: check(
      "companion_v3_turns_message_event_check",
      sql`${t.messageEventId} = 'msg:' || ${t.clientMessageId}::text`,
    ),
    actorCheck: check(
      "companion_v3_turns_actor_check",
      sql`char_length(${t.actorId}) between 1 and 200 and ${t.actorId} !~ E'[\n\r]'`,
    ),
    invocationCheck: check(
      "companion_v3_turns_invocation_check",
      sql`${t.piInvocationId} is null or (char_length(${t.piInvocationId}) between 1 and 200 and ${t.piInvocationId} !~ E'[\n\r]')`,
    ),
    cursorCheck: check(
      "companion_v3_turns_cursor_check",
      sql`${t.activityCursor} >= 0 and (${t.admissionCursor} is null or ${t.admissionCursor} >= 0)`,
    ),
    admissionCheck: check(
      "companion_v3_turns_admission_check",
      sql`(${t.admissionState} = 'pending' and ${t.admittedAt} is null and ${t.piInvocationId} is null and ${t.admissionCursor} is null) or (${t.admissionState} in ('accepted', 'ambiguous') and ${t.admittedAt} is not null and ${t.piInvocationId} is not null and ${t.admissionCursor} is not null)`,
    ),
    outcomeCheck: check(
      "companion_v3_turns_outcome_check",
      sql`(${t.outcome} is null and ${t.settledAt} is null and ${t.outcomeCode} is null and ${t.outcomeMessage} is null and ${t.state} in ('queued', 'admitted', 'running', 'needs_input')) or (${t.outcome} is not null and ${t.settledAt} is not null and ${t.state}::text = ${t.outcome}::text and ((${t.outcome} in ('failed', 'interrupted') and ${t.outcomeCode} ~ '^[a-z][a-z0-9_]{0,63}$' and char_length(${t.outcomeMessage}) between 1 and 500 and ${t.outcomeMessage} !~ E'[\n\r]') or (${t.outcome} in ('succeeded', 'cancelled') and ${t.outcomeCode} is null and ${t.outcomeMessage} is null)))`,
    ),
  }),
);

/** Retained per-lane rows keep v3 executor epochs monotonic across release and takeover. */
export const companionV3LaneLeases = pgTable(
  "companion_v3_lane_leases",
  {
    orgId: uuid("org_id").notNull(),
    companionId: uuid("companion_id").notNull(),
    lane: companionV3LaneEnum("lane").notNull(),
    claimToken: uuid("claim_token"),
    claimEpoch: bigint("claim_epoch", { mode: "number" }).notNull().default(0),
    executorId: text("executor_id"),
    turnId: uuid("turn_id"),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    renewedAt: timestamp("renewed_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: now(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.orgId, t.companionId, t.lane] }),
    instanceFk: foreignKey({
      columns: [t.orgId, t.companionId],
      foreignColumns: [companionV3Instances.orgId, companionV3Instances.companionId],
      name: "companion_v3_lane_leases_instance_fk",
    }).onDelete("cascade"),
    turnFk: foreignKey({
      columns: [t.orgId, t.companionId, t.turnId],
      foreignColumns: [companionV3Turns.orgId, companionV3Turns.companionId, companionV3Turns.id],
      name: "companion_v3_lane_leases_turn_fk",
    }).onDelete("cascade"),
    expiry: index("companion_v3_lane_leases_expiry_idx")
      .on(t.expiresAt).where(sql`${t.claimToken} is not null`),
    epochCheck: check("companion_v3_lane_leases_epoch_check", sql`${t.claimEpoch} >= 0`),
    executorCheck: check(
      "companion_v3_lane_leases_executor_check",
      sql`${t.executorId} is null or (char_length(${t.executorId}) between 1 and 200 and ${t.executorId} !~ E'[\n\r]')`,
    ),
    claimCheck: check(
      "companion_v3_lane_leases_claim_check",
      sql`(${t.claimToken} is null and ${t.executorId} is null and ${t.turnId} is null and ${t.claimedAt} is null and ${t.renewedAt} is null and ${t.expiresAt} is null) or (${t.claimToken} is not null and ${t.claimEpoch} >= 1 and ${t.executorId} is not null and ${t.turnId} is not null and ${t.claimedAt} is not null and ${t.renewedAt} is not null and ${t.expiresAt} > ${t.renewedAt})`,
    ),
  }),
);

/** Durable asynchronous approval created by the product-owned Companion control MCP. */
export const companionControlRequests = pgTable(
  "companion_control_requests",
  {
    id: uuid("id").primaryKey().notNull(),
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    companionId: uuid("companion_id").notNull(),
    sourceTurnId: uuid("source_turn_id").notNull(),
    sourceAttemptId: uuid("source_attempt_id").notNull(),
    requestedById: text("requested_by_id").notNull(),
    kind: companionControlRequestKindEnum("kind").notNull(),
    action: text("action").notNull(),
    summary: text("summary").notNull(),
    payload: jsonb("payload").$type<SchemaJsonObject>().notNull(),
    requestKey: text("request_key").notNull(),
    requestDigest: text("request_digest").notNull(),
    requiredAccess: text("required_access").notNull().default("editor"),
    status: companionControlRequestStatusEnum("status").notNull().default("pending"),
    decidedById: text("decided_by_id"),
    result: jsonb("result").$type<SchemaJsonObject>(),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    appliedAt: timestamp("applied_at", { withTimezone: true }),
    /** FIFO resume turn created once after an approved change needs Pi to continue. */
    continuationTurnId: uuid("continuation_turn_id"),
    createdAt: now(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    idempotency: unique("companion_control_requests_request_key_uq").on(
      t.companionId,
      t.sourceAttemptId,
      t.requestKey,
    ),
    companionFk: foreignKey({
      columns: [t.orgId, t.companionId],
      foreignColumns: [companions.orgId, companions.id],
      name: "companion_control_requests_companion_fk",
    }).onDelete("cascade"),
    turnFk: foreignKey({
      columns: [t.orgId, t.companionId, t.sourceTurnId],
      foreignColumns: [companionTurns.orgId, companionTurns.companionId, companionTurns.id],
      name: "companion_control_requests_turn_fk",
    }).onDelete("cascade"),
    attemptFk: foreignKey({
      columns: [t.orgId, t.companionId, t.sourceTurnId, t.sourceAttemptId],
      foreignColumns: [
        companionTurnAttempts.orgId,
        companionTurnAttempts.companionId,
        companionTurnAttempts.turnId,
        companionTurnAttempts.id,
      ],
      name: "companion_control_requests_attempt_fk",
    }).onDelete("cascade"),
    pending: index("companion_control_requests_pending_idx")
      .on(t.companionId, t.createdAt)
      .where(sql`${t.status} = 'pending'`),
    actionCheck: check(
      "companion_control_requests_action_check",
      sql`${t.action} ~ '^[a-z][a-z0-9_]{0,79}$'`,
    ),
    summaryCheck: check(
      "companion_control_requests_summary_check",
      sql`char_length(btrim(${t.summary})) between 1 and 300 and ${t.summary} !~ E'[\\n\\r]'`,
    ),
    payloadCheck: check(
      "companion_control_requests_payload_check",
      // A 16,384-character automation prompt plus JSON escaping and draft metadata remains bounded.
      sql`jsonb_typeof(${t.payload}) = 'object' and octet_length(${t.payload}::text) <= 131072`,
    ),
    digestCheck: check(
      "companion_control_requests_digest_check",
      sql`${t.requestDigest} ~ '^[0-9a-f]{64}$'`,
    ),
    accessCheck: check(
      "companion_control_requests_access_check",
      sql`${t.requiredAccess} in ('owner', 'editor')`,
    ),
    resultCheck: check(
      "companion_control_requests_result_check",
      sql`${t.result} is null or (jsonb_typeof(${t.result}) = 'object' and octet_length(${t.result}::text) <= 1048576)`,
    ),
    errorCheck: check(
      "companion_control_requests_error_check",
      sql`((${t.errorCode} is null) = (${t.errorMessage} is null)) and (${t.errorCode} is null or ${t.errorCode} ~ '^[a-z][a-z0-9_]{0,63}$') and (${t.errorMessage} is null or (char_length(${t.errorMessage}) <= 500 and ${t.errorMessage} !~ E'[\\n\\r]'))`,
    ),
  }),
);

/** JSON-RPC identity ledger. Arguments stay digest-only; the bounded response makes retries exact. */
export const companionControlInvocations = pgTable(
  "companion_control_invocations",
  {
    id: uuid("id").primaryKey().notNull(),
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    companionId: uuid("companion_id").notNull(),
    sourceTurnId: uuid("source_turn_id").notNull(),
    sourceAttemptId: uuid("source_attempt_id").notNull(),
    requestKey: text("request_key").notNull(),
    requestDigest: text("request_digest").notNull(),
    result: jsonb("result"),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    createdAt: now(),
  },
  (t) => ({
    idempotency: unique("companion_control_invocations_request_key_uq").on(
      t.companionId,
      t.sourceAttemptId,
      t.requestKey,
    ),
    resultCheck: check(
      "companion_control_invocations_result_check",
      sql`(${t.result} is null) = (${t.finishedAt} is null) and (${t.result} is null or (jsonb_typeof(${t.result}) = 'object' and octet_length(${t.result}::text) <= 1048576))`,
    ),
    digestCheck: check(
      "companion_control_invocations_digest_check",
      sql`${t.requestDigest} ~ '^[0-9a-f]{64}$'`,
    ),
    attemptFk: foreignKey({
      columns: [t.orgId, t.companionId, t.sourceTurnId, t.sourceAttemptId],
      foreignColumns: [
        companionTurnAttempts.orgId,
        companionTurnAttempts.companionId,
        companionTurnAttempts.turnId,
        companionTurnAttempts.id,
      ],
      name: "companion_control_invocations_attempt_fk",
    }).onDelete("cascade"),
  }),
);

/** A Pi recycle requested by the active attempt and enqueued only after that turn settles. */
export const companionDeferredPiRestarts = pgTable(
  "companion_deferred_pi_restarts",
  {
    id: uuid("id").primaryKey().notNull(),
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    companionId: uuid("companion_id").notNull(),
    sourceTurnId: uuid("source_turn_id").notNull(),
    sourceAttemptId: uuid("source_attempt_id").notNull(),
    actorId: text("actor_id").notNull(),
    clientSurface: companionClientSurfaceEnum("client_surface").notNull(),
    status: text("status").notNull().default("pending"),
    operationId: uuid("operation_id"),
    createdAt: now(),
    enqueuedAt: timestamp("enqueued_at", { withTimezone: true }),
  },
  (t) => ({
    companionFk: foreignKey({
      columns: [t.orgId, t.companionId],
      foreignColumns: [companions.orgId, companions.id],
      name: "companion_deferred_pi_restarts_companion_fk",
    }).onDelete("cascade"),
    turnFk: foreignKey({
      columns: [t.orgId, t.companionId, t.sourceTurnId],
      foreignColumns: [companionTurns.orgId, companionTurns.companionId, companionTurns.id],
      name: "companion_deferred_pi_restarts_turn_fk",
    }).onDelete("cascade"),
    attemptFk: foreignKey({
      columns: [t.orgId, t.companionId, t.sourceTurnId, t.sourceAttemptId],
      foreignColumns: [
        companionTurnAttempts.orgId,
        companionTurnAttempts.companionId,
        companionTurnAttempts.turnId,
        companionTurnAttempts.id,
      ],
      name: "companion_deferred_pi_restarts_attempt_fk",
    }).onDelete("cascade"),
    statusCheck: check(
      "companion_deferred_pi_restarts_status_check",
      sql`${t.status} in ('pending', 'enqueued', 'cancelled')`,
    ),
  }),
);

/** One asynchronous question from a source Companion to a target Companion. */
export const companionDelegations = pgTable(
  "companion_delegations",
  {
    id: uuid("id").primaryKey().notNull(),
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    sourceCompanionId: uuid("source_companion_id"),
    sourceCompanionName: text("source_companion_name").notNull(),
    targetCompanionId: uuid("target_companion_id"),
    targetCompanionName: text("target_companion_name").notNull(),
    actorId: text("actor_id").notNull(),
    sourceTurnId: uuid("source_turn_id").notNull(),
    sourceAttemptId: uuid("source_attempt_id").notNull(),
    targetTurnId: uuid("target_turn_id").notNull(),
    rootTurnId: uuid("root_turn_id").notNull(),
    parentDelegationId: uuid("parent_delegation_id").references(
      (): AnyPgColumn => companionDelegations.id,
      { onDelete: "set null" },
    ),
    depth: integer("depth").notNull(),
    responseMode: companionRoutineSurfaceModeEnum("response_mode").notNull(),
    status: companionTurnStatusEnum("status").notNull().default("queued"),
    deliveryStatus: companionDelegationDeliveryStatusEnum("delivery_status").notNull().default("pending"),
    requestKey: text("request_key").notNull(),
    requestDigest: text("request_digest").notNull(),
    sourceResultEventId: text("source_result_event_id"),
    sourceRelayTurnId: uuid("source_relay_turn_id"),
    deliveryErrorCode: text("delivery_error_code"),
    settledAt: timestamp("settled_at", { withTimezone: true }),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    createdAt: now(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    // Migration 0150 additionally owns the composite source/target Companion FKs. PostgreSQL's
    // column-list `ON DELETE SET NULL (companion_id)` keeps the non-null tenant key intact, but
    // Drizzle's FK builder can only null every local column and therefore cannot encode them here.
    idempotency: unique("companion_delegations_request_key_uq").on(
      t.sourceCompanionId,
      t.sourceAttemptId,
      t.requestKey,
    ),
    targetTurn: unique("companion_delegations_target_turn_uq").on(t.targetTurnId),
    root: index("companion_delegations_root_idx").on(t.rootTurnId, t.createdAt),
    depthBounds: check("companion_delegations_depth_check", sql`${t.depth} between 1 and 4`),
    noSelf: check(
      "companion_delegations_no_self_check",
      sql`${t.sourceCompanionId} is null or ${t.targetCompanionId} is null or ${t.sourceCompanionId} <> ${t.targetCompanionId}`,
    ),
    digestCheck: check(
      "companion_delegations_digest_check",
      sql`${t.requestDigest} ~ '^[0-9a-f]{64}$'`,
    ),
    terminalCheck: check(
      "companion_delegations_terminal_check",
      sql`(${t.status} in ('succeeded','failed','interrupted','cancelled')) = (${t.settledAt} is not null)`,
    ),
    deliveryErrorCheck: check(
      "companion_delegations_delivery_error_check",
      sql`${t.deliveryErrorCode} is null or ${t.deliveryErrorCode} ~ '^[a-z][a-z0-9_]{0,63}$'`,
    ),
  }),
);

/** One APNs installation owned by the currently authenticated member in one workspace. */
export const companionNotificationDevices = pgTable(
  "companion_notification_devices",
  {
    id: uuid("id").primaryKey().notNull().defaultRandom(),
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    installationId: uuid("installation_id").notNull(),
    userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
    platform: text("platform").notNull().default("ios"),
    deviceToken: text("device_token").notNull(),
    environment: companionNotificationEnvironmentEnum("environment").notNull(),
    bundleId: text("bundle_id").notNull(),
    disabledAt: timestamp("disabled_at", { withTimezone: true }),
    createdAt: now(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    installationUnique: unique("companion_notification_devices_installation_uq").on(t.installationId),
    tokenUnique: unique("companion_notification_devices_token_uq").on(
      t.environment, t.bundleId, t.deviceToken,
    ),
    membershipFk: foreignKey({
      columns: [t.orgId, t.userId],
      foreignColumns: [memberships.orgId, memberships.userId],
      name: "companion_notification_devices_membership_fk",
    }).onDelete("cascade"),
    platformCheck: check("companion_notification_devices_platform_check", sql`${t.platform} = 'ios'`),
    tokenCheck: check(
      "companion_notification_devices_token_check",
      sql`char_length(${t.deviceToken}) between 64 and 512 and ${t.deviceToken} ~ '^[a-f0-9]+$'`,
    ),
    targetCheck: check(
      "companion_notification_devices_target_check",
      sql`(${t.environment} = 'sandbox' and ${t.bundleId} = 'dev.companion.mobile.dev') or (${t.environment} = 'production' and ${t.bundleId} = 'dev.companion.mobile')`,
    ),
  }),
);

/** Durable per-device APNs delivery intent, created with the transcript/turn state it reports. */
export const companionNotificationDeliveries = pgTable(
  "companion_notification_deliveries",
  {
    id: uuid("id").primaryKey().notNull().defaultRandom(),
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    deviceId: uuid("device_id").notNull().references(() => companionNotificationDevices.id, { onDelete: "cascade" }),
    companionId: uuid("companion_id").notNull().references(() => companions.id, { onDelete: "cascade" }),
    recipientUserId: text("recipient_user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
    eventKey: text("event_key").notNull(),
    event: companionNotificationEventEnum("event").notNull(),
    title: text("title").notNull(),
    body: text("body").notNull(),
    availableAt: timestamp("available_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    attemptCount: integer("attempt_count").notNull().default(0),
    claimToken: uuid("claim_token"),
    claimExpiresAt: timestamp("claim_expires_at", { withTimezone: true }),
    createdAt: now(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    deviceEventUnique: unique("companion_notification_deliveries_device_event_uq").on(
      t.deviceId, t.eventKey,
    ),
    due: index("companion_notification_deliveries_due_idx").on(t.availableAt, t.createdAt),
    expiry: index("companion_notification_deliveries_expiry_idx").on(t.expiresAt),
    membershipFk: foreignKey({
      columns: [t.orgId, t.recipientUserId],
      foreignColumns: [memberships.orgId, memberships.userId],
      name: "companion_notification_deliveries_membership_fk",
    }).onDelete("cascade"),
    companionOrgFk: foreignKey({
      columns: [t.orgId, t.companionId],
      foreignColumns: [companions.orgId, companions.id],
      name: "companion_notification_deliveries_companion_fk",
    }).onDelete("cascade"),
    attemptCheck: check("companion_notification_deliveries_attempt_check", sql`${t.attemptCount} >= 0`),
    contentCheck: check(
      "companion_notification_deliveries_content_check",
      sql`char_length(${t.title}) between 1 and 180 and char_length(${t.body}) between 1 and 180 and ${t.title} !~ E'[\\n\\r]' and ${t.body} !~ E'[\\n\\r]'`,
    ),
    claimCheck: check(
      "companion_notification_deliveries_claim_check",
      sql`(${t.claimToken} is null) = (${t.claimExpiresAt} is null)`,
    ),
  }),
);

export const companionTurnAttempts = pgTable(
  "companion_turn_attempts",
  {
    id: uuid("id").primaryKey().notNull().defaultRandom(),
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "restrict" }),
    companionId: uuid("companion_id").notNull(),
    turnId: uuid("turn_id").notNull(),
    attemptNumber: integer("attempt_number").notNull(),
    retryId: uuid("retry_id"),
    actorId: text("actor_id").notNull(),
    runtimeGeneration: bigint("runtime_generation", { mode: "number" }).notNull(),
    settingsRevision: bigint("settings_revision", { mode: "number" }).notNull(),
    skillsRevision: integer("skills_revision").notNull(),
    modelId: text("model_id"),
    persona: text("persona"),
    canWriteSkills: boolean("can_write_skills").notNull().default(false),
    providerIds: jsonb("provider_ids").$type<string[]>().notNull(),
    providerCredentialRefs: jsonb("provider_credential_refs")
      .$type<Array<{ provider_id: string; credential_generation: string; credential_version: number }>>(),
    selectedSkillIds: jsonb("selected_skill_ids").$type<string[]>().notNull(),
    skillRefs: jsonb("skill_refs")
      .$type<Array<{ skill_id: string; current_version_id: string | null }>>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    selectedMcpAccountIds: jsonb("selected_mcp_account_ids").$type<string[]>().notNull(),
    mcpCredentialRefs: jsonb("mcp_credential_refs")
      .$type<Array<{ account_id: string; credential_generation: string }>>(),
    claimEpoch: bigint("claim_epoch", { mode: "number" }),
    /** Independent serial lane: ordinary main Pi or the one isolated routine Pi. */
    executionLane: text("execution_lane").notNull().default("main"),
    status: companionAttemptStatusEnum("status").notNull().default("starting"),
    checkpoint: text("checkpoint").notNull().default("starting"),
    checkpointSequence: bigint("checkpoint_sequence", { mode: "number" }).notNull().default(0),
    dispatchState: companionDispatchStateEnum("dispatch_state").notNull().default("pending"),
    dispatchCount: integer("dispatch_count").notNull().default(0),
    commandId: uuid("command_id"),
    dispatchStartedAt: timestamp("dispatch_started_at", { withTimezone: true }),
    dispatchAcceptedAt: timestamp("dispatch_accepted_at", { withTimezone: true }),
    piInvocationId: text("pi_invocation_id"),
    eventCursor: bigint("event_cursor", { mode: "bigint" }).notNull().default(0n),
    lastActivityAt: timestamp("last_activity_at", { withTimezone: true }),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    /** Profile timezone pinned on the attempt's first authorized material read. */
    memberTimezone: text("member_timezone"),
    settledAt: timestamp("settled_at", { withTimezone: true }),
    unknownEventCount: integer("unknown_event_count").notNull().default(0),
    malformedEventCount: integer("malformed_event_count").notNull().default(0),
    oversizedEventCount: integer("oversized_event_count").notNull().default(0),
    lastErrorCode: text("last_error_code"),
    lastErrorMessage: text("last_error_message"),
    lastErrorAction: companionRuntimeErrorActionEnum("last_error_action"),
    createdAt: now(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    uniqueOrgCompanionId: unique("companion_turn_attempts_org_companion_id_uq").on(t.orgId, t.companionId, t.id),
    uniqueOrgTurnId: unique("companion_turn_attempts_org_companion_turn_id_uq").on(t.orgId, t.companionId, t.turnId, t.id),
    attemptNumberUnique: unique("companion_turn_attempts_number_uq").on(t.turnId, t.attemptNumber),
    retryUnique: uniqueIndex("companion_turn_attempts_retry_uq").on(t.companionId, t.retryId).where(sql`${t.retryId} is not null`),
    oneActiveLane: uniqueIndex("companion_turn_attempts_one_active_lane_uq").on(t.companionId, t.executionLane).where(sql`${t.status} in ('starting','dispatching','running','needs_input')`),
    invocation: index("companion_turn_attempts_invocation_idx").on(t.companionId, t.piInvocationId).where(sql`${t.piInvocationId} is not null`),
    runtimeInstanceFk: foreignKey({ columns: [t.orgId, t.companionId], foreignColumns: [companionRuntimeInstances.orgId, companionRuntimeInstances.companionId], name: "companion_turn_attempts_runtime_instance_fk" }).onDelete("cascade"),
    turnFk: foreignKey({ columns: [t.orgId, t.companionId, t.turnId], foreignColumns: [companionTurns.orgId, companionTurns.companionId, companionTurns.id], name: "companion_turn_attempts_turn_fk" }).onDelete("cascade"),
    numberCheck: check("companion_turn_attempts_number_check", sql`${t.attemptNumber} >= 1`),
    actorCheck: check("companion_turn_attempts_actor_check", sql`char_length(${t.actorId}) between 1 and 200 and ${t.actorId} !~ E'[\\n\\r]'`),
    runtimeCheck: check("companion_turn_attempts_runtime_check", sql`${t.runtimeGeneration} between 1 and 2147483647 and ${t.settingsRevision} >= 1 and ${t.skillsRevision} >= 1 and (${t.claimEpoch} is null or ${t.claimEpoch} >= 1)`),
    executionLaneCheck: check("companion_turn_attempts_execution_lane_check", sql`${t.executionLane} in ('main','routine')`),
    resourceSnapshotCheck: check("companion_turn_attempts_resource_snapshot_check", sql`(${t.modelId} is null or (char_length(${t.modelId}) between 1 and 200 and ${t.modelId} !~ E'[\\n\\r]')) and (${t.persona} is null or char_length(${t.persona}) <= 280) and jsonb_typeof(${t.providerIds}) = 'array' and jsonb_typeof(${t.selectedSkillIds}) = 'array' and jsonb_typeof(${t.skillRefs}) = 'array' and jsonb_typeof(${t.selectedMcpAccountIds}) = 'array'`),
    credentialSnapshotCheck: check("companion_turn_attempts_credential_snapshot_check", sql`
      (${t.providerCredentialRefs} is null or (jsonb_typeof(${t.providerCredentialRefs}) = 'array' and octet_length(${t.providerCredentialRefs}::text) <= 262144))
      and (${t.mcpCredentialRefs} is null or (jsonb_typeof(${t.mcpCredentialRefs}) = 'array' and octet_length(${t.mcpCredentialRefs}::text) <= 262144))
      and ((${t.providerCredentialRefs} is null) = (${t.mcpCredentialRefs} is null))
      and (${t.dispatchState} <> 'accepted' or ${t.providerCredentialRefs} is not null)
    `),
    checkpointCheck: check("companion_turn_attempts_checkpoint_check", sql`${t.checkpoint} in ('starting','dispatch_write_intent','dispatch_accepted','dispatch_ambiguous','dispatch_rejected','running','needs_input','event_projected','agent_settled','process_exited') and ${t.checkpointSequence} >= 0`),
    dispatchCheck: check("companion_turn_attempts_dispatch_check", sql`${t.dispatchCount} >= 0 and ((${t.dispatchState} = 'pending' and ${t.commandId} is null) or (${t.dispatchState} <> 'pending' and ${t.commandId} is not null)) and (${t.dispatchAcceptedAt} is null or ${t.dispatchState} = 'accepted')`),
    invocationCheck: check("companion_turn_attempts_pi_invocation_check", sql`${t.piInvocationId} is null or (char_length(${t.piInvocationId}) between 1 and 200 and ${t.piInvocationId} !~ E'[\\n\\r]')`),
    memberTimezoneCheck: check("companion_turn_attempts_member_timezone_check", sql`${t.memberTimezone} is null or (char_length(${t.memberTimezone}) between 1 and 64 and ${t.memberTimezone} !~ E'[\\n\\r]')`),
    progressCheck: check("companion_turn_attempts_progress_check", sql`${t.eventCursor} >= 0 and ${t.unknownEventCount} >= 0 and ${t.malformedEventCount} >= 0 and ${t.oversizedEventCount} >= 0`),
    terminalCheck: check("companion_turn_attempts_terminal_check", sql`(${t.status} in ('succeeded','failed','interrupted','cancelled')) = (${t.settledAt} is not null)`),
    terminalProofCheck: check("companion_turn_attempts_terminal_proof_check", sql`(${t.status} <> 'succeeded' or (${t.checkpoint} = 'agent_settled' and ${t.dispatchState} = 'accepted' and ${t.piInvocationId} is not null)) and (${t.dispatchState} <> 'ambiguous' or ${t.status} not in ('succeeded','failed','cancelled')) and (${t.dispatchState} <> 'rejected' or ${t.status} not in ('succeeded','cancelled'))`),
    interruptedActionCheck: check("companion_turn_attempts_interrupted_action_check", sql`${t.status} <> 'interrupted' or ${t.lastErrorAction} = 'none'`),
    errorCheck: check("companion_turn_attempts_error_check", sql`((${t.lastErrorCode} is null) = (${t.lastErrorMessage} is null)) and ((${t.lastErrorCode} is null) = (${t.lastErrorAction} is null)) and (${t.lastErrorCode} is null or ${t.lastErrorCode} ~ '^[a-z][a-z0-9_]{0,63}$') and (${t.lastErrorMessage} is null or (char_length(${t.lastErrorMessage}) <= 500 and ${t.lastErrorMessage} !~ E'[\\n\\r]')) and (${t.status} not in ('failed','interrupted') or ${t.lastErrorCode} is not null) and (${t.status} not in ('succeeded','cancelled') or ${t.lastErrorCode} is null)`),
  }),
);

export const companionOperations = pgTable(
  "companion_operations",
  {
    id: uuid("id").primaryKey().notNull().defaultRandom(),
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "restrict" }),
    companionId: uuid("companion_id").notNull(),
    requestId: uuid("request_id"),
    kind: companionOperationKindEnum("kind").notNull(),
    trigger: companionOperationTriggerEnum("trigger").notNull(),
    status: companionOperationStatusEnum("status").notNull().default("pending"),
    actorId: text("actor_id").notNull(),
    sourceTurnId: uuid("source_turn_id"),
    queueSequence: bigint("queue_sequence", { mode: "number" }).notNull(),
    turnQueueCutoff: bigint("turn_queue_cutoff", { mode: "number" }).notNull(),
    runtimeGeneration: bigint("runtime_generation", { mode: "number" }).notNull(),
    clientSurface: companionClientSurfaceEnum("client_surface"),
    claimEpoch: bigint("claim_epoch", { mode: "number" }),
    /** Durable operation lane; recovery cleanup may run independently from ordinary main work. */
    executionLane: text("execution_lane").notNull().default("main"),
    /** Rolling-only marker for a protocol-5/6 recovery lease that must finish with its old snapshot. */
    legacyRecoverySnapshot: boolean("legacy_recovery_snapshot").notNull().default(false),
    checkpoint: text("checkpoint").notNull().default("pending"),
    checkpointSequence: bigint("checkpoint_sequence", { mode: "number" }).notNull().default(0),
    availableAt: timestamp("available_at", { withTimezone: true }).notNull().defaultNow(),
    attemptCount: integer("attempt_count").notNull().default(0),
    targetSettingsRevision: bigint("target_settings_revision", { mode: "number" }),
    targetSkillsRevision: integer("target_skills_revision"),
    modelId: text("model_id"),
    persona: text("persona"),
    canWriteSkills: boolean("can_write_skills"),
    providerIds: jsonb("provider_ids").$type<string[]>(),
    selectedSkillIds: jsonb("selected_skill_ids").$type<string[]>(),
    skillRefs: jsonb("skill_refs").$type<Array<{ skill_id: string; current_version_id: string | null }>>(),
    skillUpdateSelectedSkillIds: jsonb("skill_update_selected_skill_ids").$type<string[]>(),
    skillUpdateRefs: jsonb("skill_update_refs").$type<Array<{ skill_id: string; current_version_id: string | null }>>(),
    selectedMcpAccountIds: jsonb("selected_mcp_account_ids").$type<string[]>(),
    materialStagedAt: timestamp("material_staged_at", { withTimezone: true }),
    materialExpiresAt: timestamp("material_expires_at", { withTimezone: true }),
    providerOperationId: text("provider_operation_id"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    settledAt: timestamp("settled_at", { withTimezone: true }),
    lastErrorCode: text("last_error_code"),
    lastErrorMessage: text("last_error_message"),
    lastErrorAction: companionRuntimeErrorActionEnum("last_error_action"),
    createdAt: now(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    uniqueOrgCompanionId: unique("companion_operations_org_companion_id_uq").on(t.orgId, t.companionId, t.id),
    requestUnique: unique("companion_operations_request_uq").on(t.companionId, t.requestId),
    queueSequenceUnique: unique("companion_operations_queue_sequence_uq").on(t.companionId, t.queueSequence),
    oneRunning: uniqueIndex("companion_operations_one_running_uq")
      .on(t.companionId, t.executionLane)
      .where(sql`${t.status} = 'running'`),
    oneRecoveryPerTurn: uniqueIndex("companion_operations_one_recovery_per_turn_uq")
      .on(t.companionId, t.sourceTurnId)
      .where(sql`${t.kind} = 'restart_pi' and ${t.trigger} = 'recovery'`),
    pending: index("companion_operations_pending_idx").on(t.availableAt, t.queueSequence, t.companionId).where(sql`${t.status} in ('pending','running')`),
    recoveryMetrics: index("companion_operations_recovery_metrics_idx")
      .on(t.createdAt)
      .where(sql`${t.kind} = 'restart_pi' and ${t.trigger} = 'recovery' and ${t.status} in ('pending','running')`),
    recoveryAttemptMetrics: index("companion_operations_recovery_attempt_metrics_idx")
      .on(t.attemptCount)
      .where(sql`${t.kind} = 'restart_pi' and ${t.trigger} = 'recovery' and ${t.status} in ('pending','running')`),
    providerOperationUnique: uniqueIndex("companion_operations_provider_operation_uq").on(t.providerOperationId).where(sql`${t.providerOperationId} is not null`),
    runtimeInstanceFk: foreignKey({ columns: [t.orgId, t.companionId], foreignColumns: [companionRuntimeInstances.orgId, companionRuntimeInstances.companionId], name: "companion_operations_runtime_instance_fk" }).onDelete("cascade"),
    sourceTurnFk: foreignKey({ columns: [t.orgId, t.companionId, t.sourceTurnId], foreignColumns: [companionTurns.orgId, companionTurns.companionId, companionTurns.id], name: "companion_operations_source_turn_fk" }).onDelete("restrict"),
    queueSequenceCheck: check("companion_operations_queue_sequence_check", sql`${t.queueSequence} >= 1 and ${t.turnQueueCutoff} >= 0`),
    actorCheck: check("companion_operations_actor_check", sql`char_length(${t.actorId}) between 1 and 200 and ${t.actorId} !~ E'[\\n\\r]'`),
    runtimeCheck: check("companion_operations_runtime_check", sql`${t.runtimeGeneration} between 1 and 2147483647 and (${t.claimEpoch} is null or ${t.claimEpoch} >= 1)`),
    executionLaneCheck: check("companion_operations_execution_lane_check", sql`${t.executionLane} in ('main','routine')`),
    legacyRecoverySnapshotCheck: check("companion_operations_legacy_recovery_snapshot_check", sql`not ${t.legacyRecoverySnapshot} or (${t.kind} = 'restart_pi' and ${t.trigger} = 'recovery' and ${t.status} = 'running' and ${t.claimEpoch} is not null)`),
    recoveryLegacyCheckpointCheck: check("companion_operations_recovery_legacy_checkpoint_check", sql`${t.kind} <> 'restart_pi' or ${t.trigger} <> 'recovery' or ${t.checkpoint} <> 'pi_ready' or ${t.legacyRecoverySnapshot}`),
    checkpointCheck: check("companion_operations_checkpoint_check", sql`${t.checkpoint} in ('pending','resolving_box','box_resolved','box_absence_observed','creating_box','box_created','waiting_ready','box_ready_observed','installing_layout','starting_pi','pi_observed','pi_ready','cleanup_complete','stopping_pi','skills_updated','provider_stop_requested','waiting_archived','box_archived','restarting_pi','restarting_box','applying_settings','settings_applied','provider_delete_requested','waiting_deleted','provider_deleted','box_absent','completed') and ${t.checkpointSequence} >= 0 and ${t.attemptCount} >= 0`),
    targetRevisionCheck: check("companion_operations_target_revision_check", sql`(${t.targetSettingsRevision} is null or ${t.targetSettingsRevision} >= 1) and (${t.targetSkillsRevision} is null or ${t.targetSkillsRevision} >= 1) and ((${t.kind} = 'restart_pi' and ${t.trigger} = 'recovery' and ((not ${t.legacyRecoverySnapshot} and ${t.targetSettingsRevision} is null and ${t.targetSkillsRevision} is null) or (${t.legacyRecoverySnapshot} and ${t.targetSettingsRevision} is not null and ${t.targetSkillsRevision} is not null))) or (${t.kind} in ('start','restart_pi','restart_box','apply_settings') and ${t.trigger} <> 'recovery' and ${t.targetSettingsRevision} is not null and ${t.targetSkillsRevision} is not null) or (${t.kind} = 'stop' and ${t.targetSettingsRevision} is null and ${t.targetSkillsRevision} is not null) or (${t.kind} = 'delete' and ${t.targetSettingsRevision} is null and ${t.targetSkillsRevision} is null))`),
    resourceSnapshotCheck: check("companion_operations_resource_snapshot_check", sql`((${t.kind} = 'restart_pi' and ${t.trigger} = 'recovery' and not ${t.legacyRecoverySnapshot} and ${t.clientSurface} is null and ${t.modelId} is null and ${t.persona} is null and ${t.canWriteSkills} is null and ${t.providerIds} is null and ${t.selectedSkillIds} is null and ${t.skillRefs} is null and ${t.skillUpdateSelectedSkillIds} is null and ${t.skillUpdateRefs} is null and ${t.selectedMcpAccountIds} is null and ${t.materialStagedAt} is null and ${t.materialExpiresAt} is null) or (${t.kind} = 'restart_pi' and ${t.trigger} = 'recovery' and ${t.legacyRecoverySnapshot} and ${t.clientSurface} is not null and (${t.modelId} is null or (char_length(${t.modelId}) between 1 and 200 and ${t.modelId} !~ E'[\n\r]')) and (${t.persona} is null or char_length(${t.persona}) <= 280) and ${t.canWriteSkills} is not null and jsonb_typeof(${t.providerIds}) = 'array' and jsonb_typeof(${t.selectedSkillIds}) = 'array' and jsonb_typeof(${t.skillRefs}) = 'array' and jsonb_typeof(${t.skillUpdateSelectedSkillIds}) = 'array' and jsonb_typeof(${t.skillUpdateRefs}) = 'array' and jsonb_typeof(${t.selectedMcpAccountIds}) = 'array') or (${t.kind} = 'start' and ${t.clientSurface} is not null and (${t.modelId} is null or (char_length(${t.modelId}) between 1 and 200 and ${t.modelId} !~ E'[\n\r]')) and (${t.persona} is null or char_length(${t.persona}) <= 280) and ${t.canWriteSkills} is not null and jsonb_typeof(${t.providerIds}) = 'array' and jsonb_typeof(${t.selectedSkillIds}) = 'array' and jsonb_typeof(${t.skillRefs}) = 'array' and ${t.skillUpdateSelectedSkillIds} is null and ${t.skillUpdateRefs} is null and jsonb_typeof(${t.selectedMcpAccountIds}) = 'array') or (${t.kind} in ('restart_pi','restart_box','apply_settings') and ${t.trigger} <> 'recovery' and ${t.clientSurface} is not null and (${t.modelId} is null or (char_length(${t.modelId}) between 1 and 200 and ${t.modelId} !~ E'[\n\r]')) and (${t.persona} is null or char_length(${t.persona}) <= 280) and ${t.canWriteSkills} is not null and jsonb_typeof(${t.providerIds}) = 'array' and jsonb_typeof(${t.selectedSkillIds}) = 'array' and jsonb_typeof(${t.skillRefs}) = 'array' and jsonb_typeof(${t.skillUpdateSelectedSkillIds}) = 'array' and jsonb_typeof(${t.skillUpdateRefs}) = 'array' and jsonb_typeof(${t.selectedMcpAccountIds}) = 'array') or (${t.kind} = 'stop' and ${t.clientSurface} is null and ${t.modelId} is null and ${t.persona} is null and ${t.canWriteSkills} is null and ${t.providerIds} is null and ${t.selectedSkillIds} is null and ${t.skillRefs} is null and jsonb_typeof(${t.skillUpdateSelectedSkillIds}) = 'array' and jsonb_typeof(${t.skillUpdateRefs}) = 'array' and ${t.selectedMcpAccountIds} is null) or (${t.kind} = 'delete' and ${t.clientSurface} is null and ${t.modelId} is null and ${t.persona} is null and ${t.canWriteSkills} is null and ${t.providerIds} is null and ${t.selectedSkillIds} is null and ${t.skillRefs} is null and ${t.skillUpdateSelectedSkillIds} is null and ${t.skillUpdateRefs} is null and ${t.selectedMcpAccountIds} is null))`),
    materialSnapshotCheck: check("companion_operations_material_snapshot_check", sql`
      (${t.materialStagedAt} is not null or ${t.materialExpiresAt} is null)
      and (${t.materialStagedAt} is null or ${t.materialExpiresAt} is not null)
    `),
    providerOperationCheck: check("companion_operations_provider_operation_check", sql`${t.providerOperationId} is null or (char_length(${t.providerOperationId}) between 1 and 200 and ${t.providerOperationId} !~ E'[\\n\\r]')`),
    terminalCheck: check("companion_operations_terminal_check", sql`(${t.status} in ('succeeded','failed','interrupted','cancelled')) = (${t.settledAt} is not null)`),
    terminalProofCheck: check("companion_operations_terminal_proof_check", sql`${t.status} <> 'succeeded' or ((${t.kind} = 'restart_pi' and ${t.trigger} = 'recovery' and ${t.checkpoint} = 'cleanup_complete') or (${t.kind} in ('start','restart_pi','restart_box') and ${t.trigger} <> 'recovery' and ${t.checkpoint} = 'pi_ready') or (${t.kind} = 'stop' and ${t.checkpoint} = 'box_archived') or (${t.kind} = 'apply_settings' and ${t.checkpoint} = 'settings_applied') or (${t.kind} = 'delete' and ${t.checkpoint} in ('provider_deleted','box_absent')))`),
    interruptedActionCheck: check("companion_operations_interrupted_action_check", sql`${t.status} <> 'interrupted' or ${t.lastErrorAction} = 'none'`),
    explicitDestructiveTriggerCheck: check("companion_operations_explicit_destructive_trigger_check", sql`${t.kind} not in ('restart_box','delete') or ${t.trigger} = 'user'`),
    errorCheck: check("companion_operations_error_check", sql`((${t.lastErrorCode} is null) = (${t.lastErrorMessage} is null)) and ((${t.lastErrorCode} is null) = (${t.lastErrorAction} is null)) and (${t.lastErrorCode} is null or ${t.lastErrorCode} ~ '^[a-z][a-z0-9_]{0,63}$') and (${t.lastErrorMessage} is null or (char_length(${t.lastErrorMessage}) <= 500 and ${t.lastErrorMessage} !~ E'[\\n\\r]')) and (${t.status} not in ('failed','interrupted') or ${t.lastErrorCode} is not null) and (${t.status} not in ('succeeded','cancelled') or ${t.lastErrorCode} is null)`),
  }),
);

export const companionDecisionDeliveries = pgTable(
  "companion_decision_deliveries",
  {
    id: uuid("id").primaryKey().notNull().defaultRandom(),
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "restrict" }),
    companionId: uuid("companion_id").notNull(),
    turnId: uuid("turn_id").notNull(),
    attemptId: uuid("attempt_id").notNull(),
    requestKey: text("request_key").notNull(),
    requestKind: companionDecisionRequestKindEnum("request_kind").notNull().default("question"),
    decisionStatus: companionDecisionStatusEnum("decision_status").notNull().default("pending"),
    actorId: text("actor_id"),
    responseText: text("response_text"),
    respondedAt: timestamp("responded_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    deliveryState: companionDecisionDeliveryStateEnum("delivery_state").notNull().default("pending"),
    deliveryCheckpoint: text("delivery_checkpoint").notNull().default("pending"),
    deliveryCheckpointSequence: bigint("delivery_checkpoint_sequence", { mode: "number" }).notNull().default(0),
    deliveryAttemptCount: integer("delivery_attempt_count").notNull().default(0),
    claimEpoch: bigint("claim_epoch", { mode: "number" }),
    commandId: uuid("command_id"),
    deliveryStartedAt: timestamp("delivery_started_at", { withTimezone: true }),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    lastErrorCode: text("last_error_code"),
    lastErrorMessage: text("last_error_message"),
    lastErrorAction: companionRuntimeErrorActionEnum("last_error_action"),
    /**
     * Structured payload Pi proposed for `config_proposal` and `routine_proposal` deliveries. Null
     * on question and confirmation rows. The CHECK compares `request_kind` as text because
     * PostgreSQL cannot read an enum label added earlier in the same migration transaction.
     */
    proposal: jsonb("proposal"),
    createdAt: now(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    uniqueOrgCompanionId: unique("companion_decision_deliveries_org_companion_id_uq").on(t.orgId, t.companionId, t.id),
    requestUnique: unique("companion_decision_deliveries_request_uq").on(t.attemptId, t.requestKey),
    pending: index("companion_decision_deliveries_pending_idx").on(t.createdAt, t.companionId).where(sql`${t.decisionStatus} <> 'pending' and ${t.deliveryState} not in ('delivered','cancelled')`),
    expiry: index("companion_decision_deliveries_expiry_idx").on(t.expiresAt, t.companionId).where(sql`${t.decisionStatus} = 'pending'`),
    runtimeInstanceFk: foreignKey({ columns: [t.orgId, t.companionId], foreignColumns: [companionRuntimeInstances.orgId, companionRuntimeInstances.companionId], name: "companion_decision_deliveries_runtime_instance_fk" }).onDelete("cascade"),
    turnFk: foreignKey({ columns: [t.orgId, t.companionId, t.turnId], foreignColumns: [companionTurns.orgId, companionTurns.companionId, companionTurns.id], name: "companion_decision_deliveries_turn_fk" }).onDelete("cascade"),
    attemptFk: foreignKey({ columns: [t.orgId, t.companionId, t.turnId, t.attemptId], foreignColumns: [companionTurnAttempts.orgId, companionTurnAttempts.companionId, companionTurnAttempts.turnId, companionTurnAttempts.id], name: "companion_decision_deliveries_attempt_fk" }).onDelete("cascade"),
    requestKeyCheck: check("companion_decision_deliveries_request_key_check", sql`char_length(${t.requestKey}) between 1 and 200 and ${t.requestKey} !~ E'[\\n\\r]'`),
    actorCheck: check("companion_decision_deliveries_actor_check", sql`${t.actorId} is null or (char_length(${t.actorId}) between 1 and 200 and ${t.actorId} !~ E'[\\n\\r]')`),
    responseCheck: check("companion_decision_deliveries_response_check", sql`(${t.responseText} is null or octet_length(${t.responseText}) <= 16384) and ((${t.decisionStatus} = 'pending' and ${t.actorId} is null and ${t.responseText} is null and ${t.respondedAt} is null) or (${t.decisionStatus} in ('allowed','denied') and ${t.actorId} is not null and ${t.responseText} is null and ${t.respondedAt} is not null) or (${t.decisionStatus} = 'answered' and ${t.actorId} is not null and ${t.responseText} is not null and ${t.respondedAt} is not null) or (${t.decisionStatus} in ('expired','cancelled') and ${t.responseText} is null and ${t.respondedAt} is not null))`),
    deliveryCheck: check("companion_decision_deliveries_delivery_check", sql`${t.deliveryCheckpoint} in ('pending','write_intent','delivered','ambiguous','cancelled') and ${t.deliveryCheckpointSequence} >= 0 and ${t.deliveryAttemptCount} >= 0 and (${t.claimEpoch} is null or ${t.claimEpoch} >= 1) and ((${t.deliveryState} in ('pending','cancelled') and ${t.commandId} is null) or (${t.deliveryState} in ('write_intent','delivered','ambiguous') and ${t.commandId} is not null)) and ((${t.deliveryState} = 'delivered') = (${t.deliveredAt} is not null))`),
    errorCheck: check("companion_decision_deliveries_error_check", sql`((${t.lastErrorCode} is null) = (${t.lastErrorMessage} is null)) and ((${t.lastErrorCode} is null) = (${t.lastErrorAction} is null)) and (${t.lastErrorCode} is null or ${t.lastErrorCode} ~ '^[a-z][a-z0-9_]{0,63}$') and (${t.lastErrorMessage} is null or (char_length(${t.lastErrorMessage}) <= 500 and ${t.lastErrorMessage} !~ E'[\\n\\r]'))`),
    proposalCheck: check("companion_decision_deliveries_proposal_check", sql`(
      (${t.proposal} is null and ${t.requestKind}::text not in ('config_proposal', 'routine_proposal', 'trigger_proposal'))
      or (
        ${t.requestKind}::text in ('config_proposal', 'routine_proposal', 'trigger_proposal')
        and ${t.proposal} is not null
        and jsonb_typeof(${t.proposal}) = 'object'
        and octet_length(${t.proposal}::text) <= 16384
      )
    )`),
  }),
);

/** Crash-resumable permanent deletion of non-canonical generation-named Boxes. */
export const companionRuntimeDuplicateCleanups = pgTable(
  "companion_runtime_duplicate_cleanups",
  {
    orgId: uuid("org_id").notNull(),
    companionId: uuid("companion_id").notNull(),
    operationId: uuid("operation_id").notNull(),
    boxId: text("box_id").notNull(),
    status: companionDuplicateCleanupStatusEnum("status").notNull().default("pending"),
    providerOperationId: text("provider_operation_id"),
    checkpointSequence: bigint("checkpoint_sequence", { mode: "number" }).notNull().default(0),
    deleteRequestedAt: timestamp("delete_requested_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: now(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    primaryKey: primaryKey({ columns: [t.operationId, t.boxId], name: "companion_runtime_duplicate_cleanups_pk" }),
    uniqueOrgCompanionOperation: unique("companion_runtime_duplicate_cleanups_org_companion_operation_uq")
      .on(t.orgId, t.companionId, t.operationId, t.boxId),
    operationFk: foreignKey({
      columns: [t.orgId, t.companionId, t.operationId],
      foreignColumns: [companionOperations.orgId, companionOperations.companionId, companionOperations.id],
      name: "companion_runtime_duplicate_cleanups_operation_fk",
    }).onDelete("cascade"),
    providerOperationUnique: uniqueIndex("companion_runtime_duplicate_cleanups_provider_operation_uq")
      .on(t.providerOperationId).where(sql`${t.providerOperationId} is not null`),
    pending: index("companion_runtime_duplicate_cleanups_pending_idx")
      .on(t.operationId, t.status, t.boxId)
      .where(sql`${t.status} not in ('deleted','already_deleted','blocked')`),
    boxIdCheck: check("companion_runtime_duplicate_cleanups_box_id_check", sql`${t.boxId} ~ '^bx_[23456789abcdefghjkmnpqrstuvwxyz]{8}$'`),
    providerOperationCheck: check("companion_runtime_duplicate_cleanups_provider_operation_check", sql`${t.providerOperationId} is null or (char_length(${t.providerOperationId}) between 1 and 200 and ${t.providerOperationId} !~ E'[\\n\\r]')`),
    sequenceCheck: check("companion_runtime_duplicate_cleanups_sequence_check", sql`${t.checkpointSequence} >= 0`),
    stateCheck: check("companion_runtime_duplicate_cleanups_state_check", sql`
      (${t.status} = 'pending' and ${t.providerOperationId} is null and ${t.deleteRequestedAt} is null and ${t.completedAt} is null)
      or (${t.status} in ('delete_requested','waiting_deleted') and ${t.providerOperationId} is not null and ${t.deleteRequestedAt} is not null and ${t.completedAt} is null)
      or (${t.status} = 'deleted' and ${t.providerOperationId} is not null and ${t.deleteRequestedAt} is not null and ${t.completedAt} is not null)
      or (${t.status} = 'already_deleted' and ${t.completedAt} is not null)
      or (${t.status} = 'blocked' and ${t.completedAt} is not null)
    `),
  }),
);

/** Typed event identities and digests; raw broker and Pi lines are never persisted. */
export const companionRuntimeEventProjections = pgTable(
  "companion_runtime_event_projections",
  {
    orgId: uuid("org_id").notNull(),
    companionId: uuid("companion_id").notNull(),
    attemptId: uuid("attempt_id").notNull(),
    brokerSequence: bigint("broker_sequence", { mode: "number" }).notNull(),
    piInvocationId: text("pi_invocation_id").notNull(),
    projectionKind: text("projection_kind").notNull(),
    projectionSha256: text("projection_sha256").notNull(),
    createdAt: now(),
  },
  (t) => ({
    primaryKey: primaryKey({ columns: [t.attemptId, t.brokerSequence], name: "companion_runtime_event_projections_pk" }),
    uniqueOrgCompanionAttempt: unique("companion_runtime_event_projections_org_companion_attempt_uq")
      .on(t.orgId, t.companionId, t.attemptId, t.brokerSequence),
    attemptFk: foreignKey({
      columns: [t.orgId, t.companionId, t.attemptId],
      foreignColumns: [companionTurnAttempts.orgId, companionTurnAttempts.companionId, companionTurnAttempts.id],
      name: "companion_runtime_event_projections_attempt_fk",
    }).onDelete("cascade"),
    cursor: index("companion_runtime_event_projections_cursor_idx").on(t.attemptId, t.brokerSequence),
    sequenceCheck: check("companion_runtime_event_projections_sequence_check", sql`${t.brokerSequence} >= 1`),
    invocationCheck: check("companion_runtime_event_projections_invocation_check", sql`char_length(${t.piInvocationId}) between 1 and 200 and ${t.piInvocationId} !~ E'[\\n\\r]'`),
    kindCheck: check("companion_runtime_event_projections_kind_check", sql`${t.projectionKind} in ('assistant','tool','decision','activity','settled','process_exit','compaction','routine_return')`),
    digestCheck: check("companion_runtime_event_projections_digest_check", sql`${t.projectionSha256} ~ '^[0-9a-f]{64}$'`),
  }),
);

/** Short-lived, globally unique HMAC request ids consumed atomically by every runtime replica. */
export const companionRuntimeDesktopRequests = pgTable(
  "companion_runtime_desktop_requests",
  {
    requestId: text("request_id").primaryKey().notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: now(),
  },
  (t) => ({
    expiry: index("companion_runtime_desktop_requests_expiry_idx").on(t.expiresAt),
    requestIdCheck: check("companion_runtime_desktop_requests_id_check", sql`${t.requestId} ~ '^[A-Za-z0-9._:-]{16,128}$'`),
    expiryCheck: check("companion_runtime_desktop_requests_expiry_check", sql`${t.expiresAt} > ${t.createdAt} - interval '5 minutes'`),
  }),
);

export const companionRuntimeLeases = pgTable(
  "companion_runtime_leases",
  {
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "restrict" }),
    companionId: uuid("companion_id").notNull(),
    /** One independently fenced lease for main work and one for the isolated routine lane. */
    lane: text("lane").notNull().default("main"),
    claimToken: uuid("claim_token"),
    claimEpoch: bigint("claim_epoch", { mode: "number" }).notNull().default(0),
    gateEpoch: bigint("gate_epoch", { mode: "number" }),
    executorId: text("executor_id"),
    workKind: companionRuntimeWorkKindEnum("work_kind"),
    workId: uuid("work_id"),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    renewedAt: timestamp("renewed_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: now(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    primary: primaryKey({ columns: [t.companionId, t.lane], name: "companion_runtime_leases_pkey" }),
    uniqueOrgCompanionLane: unique("companion_runtime_leases_org_companion_lane_uq").on(t.orgId, t.companionId, t.lane),
    expiry: index("companion_runtime_leases_expiry_idx").on(t.expiresAt).where(sql`${t.claimToken} is not null`),
    runtimeInstanceFk: foreignKey({ columns: [t.orgId, t.companionId], foreignColumns: [companionRuntimeInstances.orgId, companionRuntimeInstances.companionId], name: "companion_runtime_leases_runtime_instance_fk" }).onDelete("cascade"),
    epochCheck: check("companion_runtime_leases_epoch_check", sql`${t.claimEpoch} >= 0 and (${t.gateEpoch} is null or ${t.gateEpoch} >= 1)`),
    laneCheck: check("companion_runtime_leases_lane_check", sql`${t.lane} in ('main','routine')`),
    executorCheck: check("companion_runtime_leases_executor_check", sql`${t.executorId} is null or (char_length(${t.executorId}) between 1 and 200 and ${t.executorId} !~ E'[\\n\\r]')`),
    claimCheck: check("companion_runtime_leases_claim_check", sql`(${t.claimToken} is null and ${t.gateEpoch} is null and ${t.executorId} is null and ${t.workKind} is null and ${t.workId} is null and ${t.claimedAt} is null and ${t.renewedAt} is null and ${t.expiresAt} is null) or (${t.claimToken} is not null and ${t.claimEpoch} >= 1 and ${t.gateEpoch} is not null and ${t.executorId} is not null and ${t.workKind} is not null and ${t.workId} is not null and ${t.claimedAt} is not null and ${t.renewedAt} is not null and ${t.expiresAt} is not null and ${t.expiresAt} > ${t.renewedAt})`),
  }),
);

/** Optional default access granted to every current member of the Companion's workspace. */
export const companionWorkspaceAccess = pgTable(
  "companion_workspace_access",
  {
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    companionId: uuid("companion_id")
      .primaryKey()
      .references(() => companions.id, { onDelete: "cascade" }),
    ownerId: text("owner_id").notNull(),
    role: companionShareRoleEnum("role").notNull(),
    grantedBy: text("granted_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: now(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    companionOrgFk: foreignKey({
      columns: [t.orgId, t.companionId, t.ownerId],
      foreignColumns: [companions.orgId, companions.id, companions.ownerId],
      name: "companion_workspace_access_companion_fk",
    }),
  }),
);

/**
 * Per-member Companions list preferences (THE-351). Pin, hide, and unread watermarks are private to
 * the member who set them: Viewer and Owner each keep their own roster order and badges. Hide never
 * archives the Companion or its Box; delete remains Owner-only on the Companion row itself.
 */
export const companionMemberState = pgTable(
  "companion_member_state",
  {
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    companionId: uuid("companion_id")
      .notNull()
      .references(() => companions.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    /** When set, the Companion is pinned for this member; earlier pins sort above later ones. */
    pinnedAt: timestamp("pinned_at", { withTimezone: true }),
    /** When true, the Companion is removed from the member's main list without deleting it. */
    hidden: boolean("hidden").notNull().default(false),
    /** When true, new push-notification deliveries are not enqueued for this member. */
    muted: boolean("muted").notNull().default(false),
    /**
     * Highest transcript ordinal this member has read. Null means never opened; unread when the
     * thread's highest ordinal is greater than this watermark (treating null as -1).
     */
    lastReadOrdinal: integer("last_read_ordinal"),
    createdAt: now(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.companionId, t.userId] }),
    companionOrgFk: foreignKey({
      columns: [t.orgId, t.companionId],
      foreignColumns: [companions.orgId, companions.id],
      name: "companion_member_state_companion_fk",
    }),
    membershipFk: foreignKey({
      columns: [t.orgId, t.userId],
      foreignColumns: [memberships.orgId, memberships.userId],
      name: "companion_member_state_membership_fk",
    }).onDelete("cascade"),
    byMember: index("companion_member_state_member_idx").on(t.orgId, t.userId),
    nonnegativeLastRead: check(
      "companion_member_state_last_read_ordinal_check",
      sql`${t.lastReadOrdinal} is null or ${t.lastReadOrdinal} >= 0`,
    ),
  }),
);

/** One durable chat sequence per Companion; Runtime v2 owns delivery and event cursors. */
export const companionThreads = pgTable(
  "companion_threads",
  {
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    companionId: uuid("companion_id")
      .primaryKey()
      .references(() => companions.id, { onDelete: "cascade" }),
    /** Next transcript ordinal to hand out; monotonic, so concurrent sends cannot collide. */
    nextOrdinal: integer("next_ordinal").notNull().default(0),
    /** Monotonic watermark for every change affecting this thread's public projection. */
    projectionSequence: bigint("projection_sequence", { mode: "bigint" }).notNull().default(0n),
    lastMessageAt: timestamp("last_message_at", { withTimezone: true }),
    createdAt: now(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    companionOrgFk: foreignKey({
      columns: [t.orgId, t.companionId],
      foreignColumns: [companions.orgId, companions.id],
      name: "companion_threads_companion_fk",
    }),
    nonnegativeNextOrdinal: check("companion_threads_next_ordinal_check", sql`${t.nextOrdinal} >= 0`),
    nonnegativeProjectionSequence: check(
      "companion_threads_projection_sequence_check",
      sql`${t.projectionSequence} >= 0`,
    ),
  }),
);

/** Latest accepted compaction summaries from the main Pi only; never exposed by member APIs. */
export const companionMainPiCompactions = pgTable(
  "companion_main_pi_compactions",
  {
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    companionId: uuid("companion_id").notNull(),
    piInvocationId: text("pi_invocation_id").notNull(),
    generation: bigint("generation", { mode: "number" }).notNull(),
    eventCursor: bigint("event_cursor", { mode: "number" }).notNull(),
    summary: text("summary").notNull(),
    firstKeptEntryId: text("first_kept_entry_id").notNull(),
    tokensBefore: integer("tokens_before").notNull(),
    estimatedTokensAfter: integer("estimated_tokens_after").notNull(),
    cacheRead: integer("cache_read"),
    cacheWrite: integer("cache_write"),
    sha256: text("sha256").notNull(),
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.orgId, t.companionId, t.piInvocationId, t.generation] }),
    companionOrgFk: foreignKey({
      columns: [t.orgId, t.companionId],
      foreignColumns: [companions.orgId, companions.id],
      name: "companion_main_pi_compactions_companion_fk",
    }).onDelete("cascade"),
    latest: index("companion_main_pi_compactions_latest_idx").on(t.orgId, t.companionId, t.observedAt),
  }),
);

/** Reusable rendered routine backgrounds keyed by their exact LF-normalized bytes. */
export const companionRoutineContextSubstrates = pgTable(
  "companion_routine_context_substrates",
  {
    id: uuid("id").primaryKey().notNull().defaultRandom(),
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    companionId: uuid("companion_id").notNull(),
    summarySha256: text("summary_sha256"),
    builtThroughOrdinal: integer("built_through_ordinal").notNull(),
    content: text("content").notNull(),
    sha256: text("sha256").notNull(),
    createdAt: now(),
  },
  (t) => ({
    companionOrgFk: foreignKey({
      columns: [t.orgId, t.companionId],
      foreignColumns: [companions.orgId, companions.id],
      name: "companion_routine_context_substrates_companion_fk",
    }).onDelete("cascade"),
    digest: unique("companion_routine_context_substrates_digest_uq").on(t.companionId, t.sha256),
    companion: index("companion_routine_context_substrates_companion_idx").on(t.orgId, t.companionId, t.createdAt),
  }),
);

/**
 * One tool run as it is stored, field for field the `companion_tool_run` contract the thread read
 * model returns. Storing the wire shape verbatim means the projection and the reader share it with
 * no translation, and the shape is restated here so the schema keeps no dependency on contracts.
 */
export interface CompanionStoredToolRun {
  call_id: string | null;
  kind: "shell" | "file" | "browse" | "computer" | "subagent" | "tool";
  name: string;
  title: string;
  status: "running" | "ok" | "error" | "timeout";
  detail: string | null;
  /** One downscaled Box desktop frame as a `data:` image URL, or null when none was captured. */
  screenshot: string | null;
}

/**
 * One permission card as stored, field for field the `companion_decision` contract. Wire shape is
 * kept verbatim so projection and readers share it with no translation, and restated here so the
 * schema keeps no dependency on contracts.
 */
export interface CompanionStoredDecision {
  request_id: string;
  kind: "shell" | "file" | "question" | "config";
  name: string;
  title: string;
  detail: string | null;
  status: "pending" | "allowed" | "denied" | "answered" | "expired" | "cancelled";
  answer: string | null;
  decided_by_id: string | null;
  decided_by_name: string | null;
  decided_at: string | null;
  expires_at: string;
  required_access?: "owner" | "editor";
  control_status?: "pending" | "applying" | "applied" | "denied" | "expired" | "cancelled" | "failed" | null;
  proposal: SchemaJsonObject | null;
}

/**
 * Durable, append-oriented transcript projection. Pi remains authoritative while active; browser
 * reads, especially Viewer reads, use this table and therefore never contact or wake Box.
 */
export const companionTranscriptEntries = pgTable(
  "companion_transcript_entries",
  {
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    companionId: uuid("companion_id")
      .notNull()
      .references(() => companions.id, { onDelete: "cascade" }),
    eventId: text("event_id").notNull(),
    ordinal: integer("ordinal").notNull(),
    /** Latest thread projection change that created or touched this entry. */
    projectionSequence: bigint("projection_sequence", { mode: "bigint" }).notNull().default(1n),
    role: companionTranscriptRoleEnum("role").notNull(),
    content: text("content").notNull(),
    /**
     * What Pi thought before the reply this row carries. It is a column on the reply rather than a
     * row of its own so the thinking keeps that reply's ordinal, is read by exactly the readers who
     * may read it, and is removed with the Companion. Null on every other role, and on a reply whose
     * thinking is already its content because the turn produced no text.
     */
    reasoning: text("reasoning"),
    /**
     * The tool run a `tool` entry reports: what Pi ran, how it ended, and — for a run that moved the
     * Box desktop — one frame of that desktop. It lives on the entry rather than in its own table so
     * a run keeps the transcript ordinal that places it between the turns it happened between, and is
     * removed with the Companion the row already cascades from. Null for every other role.
     */
    tool: jsonb("tool").$type<CompanionStoredToolRun>(),
    /**
     * The permission card a `decision` entry reports: what Pi asked to do, whether it was allowed,
     * denied, answered, or expired, and who decided. Null for every other role.
     */
    decision: jsonb("decision").$type<CompanionStoredDecision>(),
    /** Member who sent a user message; null for Pi output and for entries written before sharing. */
    authorId: text("author_id").references(() => user.id, { onDelete: "set null" }),
    /**
     * Execution turn that produced this projection. Nullable for pre-history rows and ordinary
     * compatibility projections; routine/internal readers use it as the durable run association.
     */
    turnId: uuid("turn_id"),
    /**
     * Name of the routine that enqueued this user message, snapshotted so it survives the routine's
     * deletion. `companion_turns` carries the same snapshot, but that table is private to the
     * runtime function owner, and the conversation-list preview is an ordinary API-role read of the
     * transcript. Null on every entry a member or Pi actually wrote.
     */
    routineName: text("routine_name"),
    /**
     * Name of the trigger whose webhook enqueued this user message, snapshotted for the same reason
     * as `routine_name` and masked the same way by every surface outside the thread.
     */
    triggerName: text("trigger_name"),
    /** Trusted request/result metadata for Companion-to-Companion delegation rendering. */
    delegation: jsonb("delegation").$type<SchemaJsonObject>(),
    createdAt: now(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.companionId, t.eventId] }),
    companionOrgFk: foreignKey({
      columns: [t.orgId, t.companionId],
      foreignColumns: [companions.orgId, companions.id],
      name: "companion_transcript_entries_companion_fk",
    }),
    turnFk: foreignKey({
      columns: [t.orgId, t.companionId, t.turnId],
      foreignColumns: [companionTurns.orgId, companionTurns.companionId, companionTurns.id],
      name: "companion_transcript_entries_turn_fk",
    }).onDelete("cascade"),
    turn: index("companion_transcript_entries_turn_idx").on(t.orgId, t.companionId, t.turnId).where(sql`${t.turnId} is not null`),
    ordered: unique("companion_transcript_entries_ordinal_uq").on(t.companionId, t.ordinal),
    projectionSequenceUnique: uniqueIndex("companion_transcript_entries_projection_sequence_uq")
      .on(t.companionId, t.projectionSequence),
    projectionChanges: index("companion_transcript_entries_projection_changes_idx")
      .on(t.orgId, t.companionId, t.projectionSequence),
    nonnegativeOrdinal: check(
      "companion_transcript_entries_ordinal_check",
      sql`${t.ordinal} >= 0`,
    ),
    positiveProjectionSequence: check(
      "companion_transcript_entries_projection_sequence_check",
      sql`${t.projectionSequence} >= 1`,
    ),
    boundedContent: check(
      "companion_transcript_entries_content_check",
      sql`octet_length(${t.content}) <= 1048576`,
    ),
    // A tool run is a tool entry and nothing else, so no reader has to decide what a `system` row
    // carrying a tool payload — or a `tool` row carrying none — was supposed to mean. The role is
    // compared as text because the migration that adds this check also adds the label it names.
    toolRoleOnly: check(
      "companion_transcript_entries_tool_role_check",
      sql`(${t.role}::text = 'tool') = (${t.tool} is not null)`,
    ),
    // One downscaled frame plus its run detail. The cap is the transcript's, not the capture's: a
    // payload larger than this never reached a row, so a stored one is a bug, not a big screenshot.
    boundedTool: check(
      "companion_transcript_entries_tool_size_check",
      sql`${t.tool} is null or octet_length(${t.tool}::text) <= 262144`,
    ),
    decisionRoleOnly: check(
      "companion_transcript_entries_decision_role_check",
      sql`(${t.role}::text = 'decision') = (${t.decision} is not null)`,
    ),
    // Reasoning belongs to a reply and to nothing else, so no reader has to decide what thinking
    // attached to a member's message or a tool run was supposed to mean.
    reasoningRoleOnly: check(
      "companion_transcript_entries_reasoning_role_check",
      sql`${t.reasoning} is null or ${t.role}::text = 'assistant'`,
    ),
    // The contract caps reasoning at 16 000 UTF-16 units, which cannot encode to more than 48 000
    // UTF-8 bytes. Bounding the column there is what makes it a real backstop: a projection that
    // stopped truncating cannot quietly turn every poll into a large read.
    boundedReasoning: check(
      "companion_transcript_entries_reasoning_size_check",
      sql`${t.reasoning} is null or octet_length(${t.reasoning}) <= 48000`,
    ),
    boundedDecision: check(
      "companion_transcript_entries_decision_size_check",
      sql`${t.decision} is null or octet_length(${t.decision}::text) <= 262144`,
    ),
    // Only a member message can have a routine origin, and the name matches the routine's own bound.
    routineOnUserEntries: check(
      "companion_transcript_entries_routine_check",
      sql`${t.routineName} is null or (${t.role}::text = 'user' and char_length(${t.routineName}) between 1 and 80 and ${t.routineName} !~ E'[\n\r]')`,
    ),
    // Same shape for a trigger origin, and a message never carries both origins at once.
    triggerOnUserEntries: check(
      "companion_transcript_entries_trigger_check",
      sql`(${t.triggerName} is null or (${t.role}::text = 'user' and char_length(${t.triggerName}) between 1 and 80 and ${t.triggerName} !~ E'[\n\r]')) and not (${t.routineName} is not null and ${t.triggerName} is not null)`,
    ),
  }),
);

/**
 * Private transcript projected by the isolated routine Pi. It is deliberately separate from the
 * main thread projection: a terminal surface references its one main-thread entry instead of
 * copying the payload into this history. The run id is the routine-origin companion turn id.
 */
export const companionRoutineRunEntries = pgTable(
  "companion_routine_run_entries",
  {
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    companionId: uuid("companion_id").notNull(),
    runId: uuid("run_id").notNull(),
    eventId: text("event_id").notNull(),
    ordinal: integer("ordinal").notNull(),
    role: companionTranscriptRoleEnum("role").notNull(),
    content: text("content").notNull(),
    reasoning: text("reasoning"),
    tool: jsonb("tool").$type<CompanionStoredToolRun>(),
    decision: jsonb("decision").$type<CompanionStoredDecision>(),
    createdAt: now(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.orgId, t.companionId, t.runId, t.eventId] }),
    runFk: foreignKey({
      columns: [t.orgId, t.companionId, t.runId],
      foreignColumns: [companionTurns.orgId, companionTurns.companionId, companionTurns.id],
      name: "companion_routine_run_entries_run_fk",
    }).onDelete("cascade"),
    ordered: unique("companion_routine_run_entries_ordinal_uq").on(
      t.companionId, t.runId, t.ordinal,
    ),
    run: index("companion_routine_run_entries_run_idx").on(
      t.orgId, t.companionId, t.runId, t.ordinal,
    ),
    eventCheck: check(
      "companion_routine_run_entries_event_check",
      sql`char_length(${t.eventId}) between 1 and 200 and ${t.eventId} !~ E'[\\n\\r]'`,
    ),
    ordinalCheck: check(
      "companion_routine_run_entries_ordinal_check",
      sql`${t.ordinal} >= 0`,
    ),
    boundedContent: check(
      "companion_routine_run_entries_content_check",
      sql`octet_length(${t.content}) <= 1048576`,
    ),
    boundedReasoning: check(
      "companion_routine_run_entries_reasoning_check",
      sql`${t.reasoning} is null or octet_length(${t.reasoning}) <= 48000`,
    ),
    reasoningRoleOnly: check(
      "companion_routine_run_entries_reasoning_role_check",
      sql`${t.reasoning} is null or ${t.role}::text = 'assistant'`,
    ),
    toolRoleOnly: check(
      "companion_routine_run_entries_tool_role_check",
      sql`(${t.role}::text = 'tool') = (${t.tool} is not null)`,
    ),
    boundedTool: check(
      "companion_routine_run_entries_tool_size_check",
      sql`${t.tool} is null or octet_length(${t.tool}::text) <= 262144`,
    ),
    decisionRoleOnly: check(
      "companion_routine_run_entries_decision_role_check",
      sql`(${t.role}::text = 'decision') = (${t.decision} is not null)`,
    ),
    boundedDecision: check(
      "companion_routine_run_entries_decision_size_check",
      sql`${t.decision} is null or octet_length(${t.decision}::text) <= 262144`,
    ),
  }),
);

/**
 * Exactly-once terminal surface projection for a routine run. The main entry lives in the ordinary
 * thread and is referenced by event id; only relay mode creates a separate main-Pi turn. No payload
 * column exists here, preventing a second copy of surfaced content in routine history.
 */
export const companionRoutineReturns = pgTable(
  "companion_routine_returns",
  {
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    companionId: uuid("companion_id").notNull(),
    runId: uuid("run_id").notNull(),
    mode: companionRoutineSurfaceModeEnum("mode").notNull(),
    mainEntryEventId: text("main_entry_event_id").notNull(),
    relayTurnId: uuid("relay_turn_id"),
    createdAt: now(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.orgId, t.companionId, t.runId] }),
    runFk: foreignKey({
      columns: [t.orgId, t.companionId, t.runId],
      foreignColumns: [companionTurns.orgId, companionTurns.companionId, companionTurns.id],
      name: "companion_routine_returns_run_fk",
    }).onDelete("cascade"),
    mainEntryFk: foreignKey({
      columns: [t.companionId, t.mainEntryEventId],
      foreignColumns: [companionTranscriptEntries.companionId, companionTranscriptEntries.eventId],
      name: "companion_routine_returns_main_entry_fk",
    }).onDelete("cascade"),
    relayTurnFk: foreignKey({
      columns: [t.orgId, t.companionId, t.relayTurnId],
      foreignColumns: [companionTurns.orgId, companionTurns.companionId, companionTurns.id],
      name: "companion_routine_returns_relay_turn_fk",
    }).onDelete("cascade"),
    mainEntryUnique: unique("companion_routine_returns_main_entry_uq").on(
      t.companionId, t.mainEntryEventId,
    ),
    relayTurnUnique: unique("companion_routine_returns_relay_turn_uq").on(
      t.companionId, t.relayTurnId,
    ),
    modeRelationCheck: check(
      "companion_routine_returns_mode_relation_check",
      sql`(${t.mode}::text = 'relay') = (${t.relayTurnId} is not null)`,
    ),
    mainEntryCheck: check(
      "companion_routine_returns_main_entry_check",
      sql`char_length(${t.mainEntryEventId}) between 1 and 200 and ${t.mainEntryEventId} !~ E'[\\n\\r]'`,
    ),
  }),
);

export const companionAttachmentKindEnum = pgEnum("companion_attachment_kind", [
  "user_upload",
  "pi_output",
]);

/**
 * Files one transcript entry carries.
 *
 * `user_upload` is what a member sent with a message; the runtime stages those read-only on the Box
 * before dispatching the prompt. `pi_output` is an image Pi left in its outbox during a turn, moved
 * here so it can be read the way every other part of the thread is read. Both kinds live in one
 * table so they share one RLS boundary, one purge path, and one projection — but the discriminator
 * is never optional, because a reader must never mistake something Pi produced for something a
 * member vouched for.
 *
 * Bytes live in object storage; this row holds the key. Removing the row is what schedules the
 * object for deletion, so an attachment cannot outlive the entry, the Companion, or the tenant it
 * belongs to.
 */
export const companionMessageAttachments = pgTable(
  "companion_message_attachments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    companionId: uuid("companion_id").notNull(),
    entryEventId: text("entry_event_id").notNull(),
    kind: companionAttachmentKindEnum("kind").notNull(),
    /** Object-storage key. Content-addressed, so a retried upload lands on the same object. */
    storageKey: text("storage_key").notNull(),
    /** Resolved from the stored bytes at upload, never from what a client declared. */
    contentType: text("content_type").notNull(),
    byteSize: integer("byte_size").notNull(),
    sha256: text("sha256").notNull(),
    filename: text("filename").notNull(),
    position: integer("position").notNull(),
    createdAt: now(),
  },
  (t) => ({
    companionOrgFk: foreignKey({
      columns: [t.orgId, t.companionId],
      foreignColumns: [companions.orgId, companions.id],
      name: "companion_message_attachments_companion_fk",
    }),
    entryFk: foreignKey({
      columns: [t.companionId, t.entryEventId],
      foreignColumns: [companionTranscriptEntries.companionId, companionTranscriptEntries.eventId],
      name: "companion_message_attachments_entry_fk",
    }),
    // The unique constraint below is already a btree on exactly these columns in this order, so it
    // serves every lookup an extra index could; a second one would only double write cost.
    orderedPosition: unique("companion_message_attachments_position_uq").on(
      t.companionId,
      t.entryEventId,
      t.position,
    ),
    // Two rows sharing one key would mean two rows owning the same bytes, and purging either would
    // strand the other.
    ownedObject: unique("companion_message_attachments_storage_key_uq").on(t.storageKey),
    storageKeyCheck: check(
      "companion_message_attachments_storage_key_check",
      sql`${t.storageKey} ~ '^[A-Za-z0-9][A-Za-z0-9/._-]*$'
        and char_length(${t.storageKey}) between 1 and 512`,
    ),
    allowedContentType: check(
      "companion_message_attachments_content_type_check",
      sql`${t.contentType} in (
        'image/png', 'image/jpeg', 'image/webp', 'image/gif',
        'application/pdf', 'text/csv', 'text/plain', 'text/markdown', 'application/json'
      )`,
    ),
    // Pi hands back images only; a document stored as a Pi output would mean the harvest read
    // something it was never allowed to read.
    outputImageOnly: check(
      "companion_message_attachments_output_image_check",
      sql`${t.kind}::text <> 'pi_output' or ${t.contentType} in (
        'image/png', 'image/jpeg', 'image/webp', 'image/gif'
      )`,
    ),
    boundedSize: check(
      "companion_message_attachments_byte_size_check",
      sql`${t.byteSize} between 1 and 10485760`,
    ),
    contentDigest: check(
      "companion_message_attachments_sha256_check",
      sql`${t.sha256} ~ '^[0-9a-f]{64}$'`,
    ),
    // The name is interpolated into a Box path and into the prompt suffix naming that path, so the
    // charset leaves nothing to quote, escape, or traverse.
    safeFilename: check(
      "companion_message_attachments_filename_check",
      sql`${t.filename} ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$'`,
    ),
    boundedPosition: check(
      "companion_message_attachments_position_check",
      sql`${t.position} between 0 and 9`,
    ),
    entryEventCheck: check(
      "companion_message_attachments_entry_event_check",
      sql`char_length(${t.entryEventId}) between 1 and 200 and ${t.entryEventId} !~ E'[\\n\\r]'`,
    ),
  }),
);
/**
 * Workspace-level Pi provider credentials. Ciphertext is envelope-encrypted and only decrypted
 * immediately before it is delivered to the selected Companion's Box.
 */
export const companionProviderConnections = pgTable(
  "companion_provider_connections",
  {
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    providerId: text("provider_id").notNull(),
    authMethod: companionProviderAuthMethodEnum("auth_method").notNull(),
    credentialGeneration: uuid("credential_generation").notNull().defaultRandom(),
    credentialVersion: integer("credential_version").notNull().default(1),
    ciphertext: text("ciphertext").notNull(),
    iv: text("iv").notNull(),
    authTag: text("auth_tag").notNull(),
    wrappedDek: text("wrapped_dek").notNull(),
    wrapIv: text("wrap_iv").notNull(),
    wrapAuthTag: text("wrap_auth_tag").notNull(),
    keyId: text("key_id").notNull(),
    connectedBy: text("connected_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: now(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.orgId, t.providerId] }),
    providerIdCheck: check(
      "companion_provider_connections_provider_id_check",
      sql`${t.providerId} ~ '^[a-z][a-z0-9-]{0,62}$'`,
    ),
    credentialVersionCheck: check(
      "companion_provider_connections_credential_version_check",
      sql`${t.credentialVersion} >= 1`,
    ),
  }),
);

/**
 * Member-owned MCP accounts used by web and mobile-web Companions. Transport metadata persists so
 * the Plugins screen is useful without waking Box. Credential payloads are envelope-encrypted and
 * are only decrypted after the Companion runtime authorization guard.
 */
export const companionMcpAccounts = pgTable(
  "companion_mcp_accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    ownerId: text("owner_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    label: text("label").notNull(),
    transport: text("transport").notNull(),
    accountConfig: jsonb("account_config").$type<SchemaJsonObject>().notNull(),
    credentialGeneration: uuid("credential_generation").notNull().defaultRandom(),
    /** Monotonic envelope revision. OAuth refresh keeps the connection generation stable. */
    credentialVersion: integer("credential_version").notNull().default(1),
    ciphertext: text("ciphertext").notNull(),
    iv: text("iv").notNull(),
    authTag: text("auth_tag").notNull(),
    wrappedDek: text("wrapped_dek").notNull(),
    wrapIv: text("wrap_iv").notNull(),
    wrapAuthTag: text("wrap_auth_tag").notNull(),
    keyId: text("key_id").notNull(),
    createdAt: now(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    ownerMembershipFk: foreignKey({
      columns: [t.orgId, t.ownerId],
      foreignColumns: [memberships.orgId, memberships.userId],
      name: "companion_mcp_accounts_owner_membership_fk",
    }).onDelete("cascade"),
    uniqueProviderLabel: uniqueIndex("companion_mcp_accounts_provider_label_uq").on(
      t.orgId,
      t.ownerId,
      t.provider,
      sql`lower(${t.label})`,
    ),
    byOwner: index("companion_mcp_accounts_owner_idx").on(t.orgId, t.ownerId, t.updatedAt),
    providerCheck: check(
      "companion_mcp_accounts_provider_check",
      sql`${t.provider} ~ '^[a-z][a-z0-9-]{0,62}$'`,
    ),
    labelLength: check(
      "companion_mcp_accounts_label_check",
      sql`char_length(${t.label}) between 1 and 40`,
    ),
    transportCheck: check(
      "companion_mcp_accounts_transport_check",
      sql`${t.transport} in ('http', 'stdio')`,
    ),
    credentialVersionCheck: check(
      "companion_mcp_accounts_credential_version_check",
      sql`${t.credentialVersion} >= 1`,
    ),
  }),
);

/**
 * A member-owned provider authority for remote trigger registration. Unlike MCP accounts this is
 * never attached to an individual Companion: every Companion the member can operate may use it.
 * OAuth rows reference the existing MCP credential; API-key rows keep their own write-only
 * envelope. Disconnect is soft so dependent per-Companion triggers retain an actionable state.
 */
export const companionTriggerProviderAccounts = pgTable(
  "companion_trigger_provider_accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    ownerId: text("owner_id").notNull().references(() => user.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    label: text("label").notNull(),
    credentialSource: text("credential_source").notNull(),
    mcpAccountId: uuid("mcp_account_id").references(() => companionMcpAccounts.id, { onDelete: "set null" }),
    credentialGeneration: uuid("credential_generation"),
    ciphertext: text("ciphertext"),
    iv: text("iv"),
    authTag: text("auth_tag"),
    wrappedDek: text("wrapped_dek"),
    wrapIv: text("wrap_iv"),
    wrapAuthTag: text("wrap_auth_tag"),
    keyId: text("key_id"),
    status: text("status").notNull().default("connected"),
    disconnectedAt: timestamp("disconnected_at", { withTimezone: true }),
    createdAt: now(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    ownerMembershipFk: foreignKey({
      columns: [t.orgId, t.ownerId],
      foreignColumns: [memberships.orgId, memberships.userId],
      name: "companion_trigger_provider_accounts_owner_membership_fk",
    }).onDelete("cascade"),
    uniqueProviderLabel: uniqueIndex("companion_trigger_provider_accounts_provider_label_uq").on(
      t.orgId,
      t.ownerId,
      t.provider,
      sql`lower(${t.label})`,
    ),
    byOwner: index("companion_trigger_provider_accounts_owner_idx").on(
      t.orgId,
      t.ownerId,
      t.updatedAt,
    ),
    providerCheck: check(
      "companion_trigger_provider_accounts_provider_check",
      sql`${t.provider} in ('github', 'linear', 'sentry')`,
    ),
    labelCheck: check(
      "companion_trigger_provider_accounts_label_check",
      sql`char_length(${t.label}) between 1 and 40`,
    ),
    statusCheck: check(
      "companion_trigger_provider_accounts_status_check",
      sql`${t.status} in ('connected', 'disconnected')`,
    ),
    credentialCheck: check(
      "companion_trigger_provider_accounts_credential_check",
      sql`(
        ${t.credentialSource} = 'mcp_oauth'
        and ${t.credentialGeneration} is null
        and ${t.ciphertext} is null and ${t.iv} is null and ${t.authTag} is null
        and ${t.wrappedDek} is null and ${t.wrapIv} is null and ${t.wrapAuthTag} is null
        and ${t.keyId} is null
        and (${t.status} = 'disconnected' or ${t.mcpAccountId} is not null)
      ) or (
        ${t.credentialSource} = 'api_key'
        and ${t.mcpAccountId} is null
        and ((${t.status} = 'connected'
          and ${t.credentialGeneration} is not null
          and ${t.ciphertext} is not null and ${t.iv} is not null and ${t.authTag} is not null
          and ${t.wrappedDek} is not null and ${t.wrapIv} is not null and ${t.wrapAuthTag} is not null
          and ${t.keyId} is not null)
        or (${t.status} = 'disconnected'
          and ${t.credentialGeneration} is null
          and ${t.ciphertext} is null and ${t.iv} is null and ${t.authTag} is null
          and ${t.wrappedDek} is null and ${t.wrapIv} is null and ${t.wrapAuthTag} is null
          and ${t.keyId} is null))
      )`,
    ),
    disconnectedCheck: check(
      "companion_trigger_provider_accounts_disconnected_check",
      sql`(${t.status} = 'disconnected') = (${t.disconnectedAt} is not null)`,
    ),
  }),
);

/** Runtime-minted, hash-only capability used by the Box-local MCP credential gateway. */
export const companionMcpBrokerTokens = pgTable(
  "companion_mcp_broker_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    companionId: uuid("companion_id").notNull(),
    actorId: text("actor_id").notNull(),
    tokenPrefix: text("token_prefix").notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    accountRefs: jsonb("account_refs")
      .$type<Array<{ account_id: string; credential_generation: string }>>()
      .notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    createdAt: now(),
  },
  (t) => ({
    companionFk: foreignKey({
      columns: [t.orgId, t.companionId],
      foreignColumns: [companions.orgId, companions.id],
      name: "companion_mcp_broker_tokens_companion_fk",
    }).onDelete("cascade"),
    actorMembershipFk: foreignKey({
      columns: [t.orgId, t.actorId],
      foreignColumns: [memberships.orgId, memberships.userId],
      name: "companion_mcp_broker_tokens_actor_membership_fk",
    }).onDelete("cascade"),
    byExpiry: index("companion_mcp_broker_tokens_expiry_idx").on(t.expiresAt),
    accountRefsCheck: check(
      "companion_mcp_broker_tokens_account_refs_check",
      sql`jsonb_typeof(${t.accountRefs}) = 'array' and jsonb_array_length(${t.accountRefs}) between 1 and 50`,
    ),
  }),
);

export const companionPluginTriggerKeys = pgTable(
  "companion_plugin_trigger_keys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    accountId: uuid("account_id")
      .notNull()
      .references(() => companionMcpAccounts.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    credentialGeneration: uuid("credential_generation").notNull().defaultRandom(),
    ciphertext: text("ciphertext").notNull(),
    iv: text("iv").notNull(),
    authTag: text("auth_tag").notNull(),
    wrappedDek: text("wrapped_dek").notNull(),
    wrapIv: text("wrap_iv").notNull(),
    wrapAuthTag: text("wrap_auth_tag").notNull(),
    keyId: text("key_id").notNull(),
    createdAt: now(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    uniqueOrgProvider: unique("companion_plugin_trigger_keys_org_provider_uq").on(t.orgId, t.provider),
    providerCheck: check(
      "companion_plugin_trigger_keys_provider_check",
      sql`${t.provider} in ('linear')`,
    ),
  }),
);

export const invitations = pgTable(
  "invitations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    orgRole: orgRoleEnum("org_role").notNull().default("developer"),
    token: text("token").notNull().unique(),
    status: invitationStatusEnum("status").notNull().default("pending"),
    createdBy: text("created_by")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    createdAt: now(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => ({
    activeInvite: uniqueIndex("invitations_pending_email_uq").on(t.orgId, t.email).where(sql`${t.status} = 'pending'`),
  }),
);

/**
 * Stripe's raw subscription state, kept separate from the effective Free/Pro decision. One row per
 * organization also acts as the durable seat-sync/Checkout outbox for the billing worker.
 */
export const billingSubscriptions = pgTable(
  "billing_subscriptions",
  {
    orgId: uuid("org_id")
      .primaryKey()
      .references(() => organizations.id, { onDelete: "cascade" }),
    stripeCustomerId: text("stripe_customer_id").unique(),
    stripeSubscriptionId: text("stripe_subscription_id").unique(),
    stripeSubscriptionItemId: text("stripe_subscription_item_id").unique(),
    stripePriceId: text("stripe_price_id"),
    stripeStatus: text("stripe_status"),
    syncedQuantity: integer("synced_quantity"),
    currentPeriodStart: timestamp("current_period_start", { withTimezone: true }),
    currentPeriodEnd: timestamp("current_period_end", { withTimezone: true }),
    cancelAtPeriodEnd: boolean("cancel_at_period_end").notNull().default(false),
    canceledAt: timestamp("canceled_at", { withTimezone: true }),
    graceEndsAt: timestamp("grace_ends_at", { withTimezone: true }),
    lastStripeEventId: text("last_stripe_event_id"),
    lastReconciledAt: timestamp("last_reconciled_at", { withTimezone: true }),
    seatSyncStatus: billingSeatSyncStatusEnum("seat_sync_status").notNull().default("synced"),
    seatSyncRequestedAt: timestamp("seat_sync_requested_at", { withTimezone: true }),
    seatSyncAttempts: integer("seat_sync_attempts").notNull().default(0),
    nextRetryAt: timestamp("next_retry_at", { withTimezone: true }),
    lastError: text("last_error"),
    lastErrorAt: timestamp("last_error_at", { withTimezone: true }),
    checkoutSessionId: text("checkout_session_id").unique(),
    checkoutExpiresAt: timestamp("checkout_expires_at", { withTimezone: true }),
    checkoutGeneration: integer("checkout_generation").notNull().default(0),
    createdAt: now(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    pendingSeatSync: index("billing_subscriptions_pending_idx").on(t.seatSyncStatus, t.nextRetryAt),
    reconcileDue: index("billing_subscriptions_reconcile_idx").on(t.lastReconciledAt),
    positiveQuantity: check("billing_subscriptions_quantity_check", sql`${t.syncedQuantity} is null or ${t.syncedQuantity} >= 1`),
    nonnegativeAttempts: check("billing_subscriptions_attempts_check", sql`${t.seatSyncAttempts} >= 0`),
    nonnegativeCheckoutGeneration: check("billing_subscriptions_checkout_generation_check", sql`${t.checkoutGeneration} >= 0`),
  }),
);

/** Processed Stripe event ids. Events are tenant-bound before insertion; unknown events are logged only. */
export const stripeWebhookEvents = pgTable(
  "stripe_webhook_events",
  {
    eventId: text("event_id").primaryKey(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    eventType: text("event_type").notNull(),
    status: text("status", { enum: ["processing", "processed", "failed"] }).notNull().default("processing"),
    error: text("error"),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
  },
  (t) => ({
    byOrg: index("stripe_webhook_events_org_idx").on(t.orgId, t.receivedAt),
    validStatus: check("stripe_webhook_events_status_check", sql`${t.status} in ('processing', 'processed', 'failed')`),
  }),
);

export const skills = pgTable(
  "skills",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    shareToken: text("share_token")
      .notNull()
      .unique()
      .default(sql`substr(replace(gen_random_uuid()::text,'-',''),1,16)`),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    slug: text("slug").notNull(),
    description: text("description").notNull(),
    /** Mutable display-title override used by explicit rename; version manifests stay immutable. */
    displayName: text("display_name"),
    // `creator_id` records who first published the skill (provenance/Activity, drives the profile
    // join). It is also the OWNER of a personal skill: when `scope = 'personal'` only this user can
    // read/edit/share it. Org skills (`scope = 'org'`) keep the flat model — every member may edit.
    creatorId: text("creator_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    // Library scope. 'org' (default) = flat org-wide library; 'personal' = private to creator_id.
    scope: skillScopeEnum("scope").notNull().default("org"),
    currentVersionId: uuid("current_version_id"),
    /**
     * Immutable version currently exposed by the stable public share link. Null means that the
     * metadata page still exists, but no package may be installed. The database migration adds a
     * composite (org, skill, version) FK so this pointer can never target another skill/tenant.
     */
    publicVersionId: uuid("public_version_id"),
    /** SHA-256 over the exact deterministic ZIP bytes served by the public package route. */
    publicPackageChecksum: text("public_package_checksum"),
    /** Byte length of those exact ZIP transport bytes (not the stored tar.gz size). */
    publicPackageSizeBytes: integer("public_package_size_bytes"),
    /** Time this version/ZIP tuple was explicitly promoted. */
    publicReleasedAt: timestamp("public_released_at", { withTimezone: true }),
    validation: validationStateEnum("validation").notNull().default("valid"),
    validationError: text("validation_error"),
    // Archive (soft-hide) lifecycle: archived skills drop out of the normal lists but stay
    // viewable, restorable, and downloadable while a published version still references them.
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    archivedBy: text("archived_by").references(() => user.id, { onDelete: "set null" }),
    archiveReason: text("archive_reason"),
    createdAt: now(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    uniqueOrgSlug: unique("skills_org_slug_uq").on(t.orgId, t.slug),
    uniqueOrgId: unique("skills_org_id_id_uq").on(t.orgId, t.id),
    byArchived: index("skills_archived_idx").on(t.orgId, t.archivedAt),
    // My-Skills authored-list lookups: (org, scope, creator). Org lists use the slug uq / PK.
    byScope: index("skills_org_scope_creator_idx").on(t.orgId, t.scope, t.creatorId),
    publicReleaseComplete: check(
      "skills_public_release_complete_check",
      sql`(
        ${t.publicVersionId} is null
        and ${t.publicPackageChecksum} is null
        and ${t.publicPackageSizeBytes} is null
        and ${t.publicReleasedAt} is null
      ) or (
        ${t.publicVersionId} is not null
        and ${t.publicPackageChecksum} is not null
        and ${t.publicPackageSizeBytes} is not null
        and ${t.publicReleasedAt} is not null
      )`,
    ),
    publicChecksum: check(
      "skills_public_package_checksum_check",
      sql`${t.publicPackageChecksum} is null or ${t.publicPackageChecksum} ~ '^sha256:[0-9a-f]{64}$'`,
    ),
    publicSize: check(
      "skills_public_package_size_check",
      sql`${t.publicPackageSizeBytes} is null or ${t.publicPackageSizeBytes} >= 0`,
    ),
  }),
);

export const skillVersions = pgTable(
  "skill_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    skillId: uuid("skill_id")
      .notNull()
      .references(() => skills.id, { onDelete: "cascade" }),
    version: text("version").notNull(),
    note: text("note").notNull().default(""),
    frontmatter: text("frontmatter").notNull(),
    // The SKILL.md markdown body (instructions), kept server-side to power full-text search.
    body: text("body").notNull().default(""),
    tools: jsonb("tools").$type<string[]>().notNull().default([]),
    license: text("license"),
    sizeBytes: integer("size_bytes").notNull(),
    checksum: text("checksum").notNull(),
    storagePath: text("storage_path").notNull(),
    validation: validationStateEnum("validation").notNull().default("valid"),
    validationError: text("validation_error"),
    createdBy: text("created_by")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    createdAt: now(),
  },
  (t) => ({
    uniqueSkillVersion: unique("skill_versions_skill_version_uq").on(t.skillId, t.version),
    // Supports org-scoped composite FKs from skill_version_dependencies.
    uniqueOrgId: unique("skill_versions_org_id_id_uq").on(t.orgId, t.id),
    // Pins a version to its owning skill for immutable run snapshots.
    uniqueOrgSkillId: unique("skill_versions_org_skill_id_uq").on(t.orgId, t.skillId, t.id),
    byOrg: index("skill_versions_org_idx").on(t.orgId),
    checksumCheck: check("skill_versions_checksum_check", sql`${t.checksum} ~ '^sha256:[0-9a-f]{64}$'`),
  }),
);

/**
 * Short-lived bearer tickets used for Agent Auth binary package transfers. Plaintext tickets are
 * returned once and never persisted: only their SHA-256 hash lives here.
 * Rows are tenant-owned even though consumption happens through a narrowly-scoped SECURITY
 * DEFINER function before an organization context is known.
 */
export const agentTransferTickets = pgTable(
  "agent_transfer_tickets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    /** Agent Auth agent id. Deliberately not FK-bound to global identity/plugin tables. */
    agentId: text("agent_id").notNull(),
    /** Capability grant id when supplied by Agent Auth; no FK so identity tables stay global. */
    agentGrantId: text("agent_grant_id"),
    action: text("action").notNull(),
    /** Existing target, when one exists. A fresh upload deliberately has no skill id yet. */
    skillId: uuid("skill_id"),
    /** Exact immutable source version for downloads; uploads target a not-yet-created version. */
    skillVersionId: uuid("skill_version_id"),
    /** Stable public token only for public-release downloads. */
    shareToken: text("share_token"),
    /** Path/body binding kept separately so upload tickets can precede creation of the skill row. */
    skillSlug: text("skill_slug").notNull(),
    version: text("version").notNull(),
    /** Exact normalized archive path for a single-file download; null for every package action. */
    filePath: text("file_path"),
    checksum: text("checksum").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    failedAt: timestamp("failed_at", { withTimezone: true }),
    createdAt: now(),
  },
  (t) => ({
    byExpiry: index("agent_transfer_tickets_expiry_idx").on(t.expiresAt),
    byAgent: index("agent_transfer_tickets_agent_idx").on(t.orgId, t.userId, t.agentId, t.createdAt),
    validAction: check(
      "agent_transfer_tickets_action_check",
      sql`${t.action} in ('public_skill_package.download', 'skill_package.download', 'skill_file.download', 'skill_package.upload', 'local_skill.download')`,
    ),
    completeBinding: check(
      "agent_transfer_tickets_binding_check",
      sql`(
        ${t.action} = 'public_skill_package.download'
        and ${t.skillId} is not null
        and ${t.skillVersionId} is not null
        and ${t.shareToken} is not null
        and ${t.filePath} is null
      ) or (
        ${t.action} = 'skill_package.download'
        and ${t.skillId} is not null
        and ${t.skillVersionId} is not null
        and ${t.shareToken} is null
        and ${t.filePath} is null
      ) or (
        ${t.action} = 'skill_file.download'
        and ${t.skillId} is not null
        and ${t.skillVersionId} is not null
        and ${t.shareToken} is null
        and ${t.filePath} is not null
        and btrim(${t.filePath}) <> ''
      ) or (
        ${t.action} = 'skill_package.upload'
        and ${t.skillVersionId} is null
        and ${t.shareToken} is null
        and ${t.filePath} is null
      ) or (
        ${t.action} = 'local_skill.download'
        and ${t.skillId} is null
        and ${t.skillVersionId} is null
        and ${t.shareToken} is null
        and ${t.filePath} is null
      )`,
    ),
    nonnegativeSize: check("agent_transfer_tickets_size_check", sql`${t.sizeBytes} >= 0`),
    checksumCheck: check("agent_transfer_tickets_checksum_check", sql`${t.checksum} ~ '^sha256:[0-9a-f]{64}$'`),
    skillOrgFk: foreignKey({
      columns: [t.orgId, t.skillId],
      foreignColumns: [skills.orgId, skills.id],
      name: "agent_transfer_tickets_skill_org_fk",
    }).onDelete("cascade"),
    versionOrgSkillFk: foreignKey({
      columns: [t.orgId, t.skillId, t.skillVersionId],
      foreignColumns: [skillVersions.orgId, skillVersions.skillId, skillVersions.id],
      name: "agent_transfer_tickets_version_org_skill_fk",
    }).onDelete("cascade"),
  }),
);

/**
 * One required skill→skill dependency edge, declared by a specific source *version*
 * (so each version keeps its exact dependency graph). Dependencies are un-versioned: a row
 * records the declared target *slug* and a resolved target skill id. `dependsOnSkillId` is null
 * when the slug is not published in the workspace (a "missing" dependency). Statuses
 * (satisfied / missing / archived / cycle) are computed live at read time from current skill
 * state — never stored.
 */
export const skillVersionDependencies = pgTable(
  "skill_version_dependencies",
  {
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    // The dependent version that declares this dependency.
    skillVersionId: uuid("skill_version_id").notNull(),
    // The dependent skill (denormalized so "current-version edges" and "used-by" queries stay simple).
    skillId: uuid("skill_id").notNull(),
    // The declared dependency slug — always present, so a missing dependency is representable.
    dependsOnSlug: text("depends_on_slug").notNull(),
    // The resolved target skill, or null when the slug is not published in the workspace.
    dependsOnSkillId: uuid("depends_on_skill_id").references(() => skills.id, { onDelete: "set null" }),
    createdAt: now(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.skillVersionId, t.dependsOnSlug] }),
    bySkill: index("skill_version_deps_skill_idx").on(t.orgId, t.skillId),
    byTarget: index("skill_version_deps_target_idx").on(t.orgId, t.dependsOnSkillId),
    // Org-scoped composite FKs guarantee the row's org matches the rows it references, so a
    // service/seed/import bug can never persist a cross-tenant dependency edge.
    versionOrgFk: foreignKey({
      columns: [t.orgId, t.skillVersionId],
      foreignColumns: [skillVersions.orgId, skillVersions.id],
      name: "skill_version_deps_version_org_fk",
    }).onDelete("cascade"),
    skillOrgFk: foreignKey({
      columns: [t.orgId, t.skillId],
      foreignColumns: [skills.orgId, skills.id],
      name: "skill_version_deps_skill_org_fk",
    }).onDelete("cascade"),
  }),
);

/**
 * The org-wide shared label ("folder") tree. The canonical set of paths plus their per-path
 * appearance (color + icon). A row here is what lets an **empty** folder exist (a path with no
 * assigned skills). `path` is slash-separated kebab segments (`marketing/seo`); intermediate parents
 * are derived in the service by splitting on `/`, not stored explicitly. Org-scoped + RLS-tenanted;
 * any member may create/rename/recolor/delete. The `(org_id, path)` index uses `text_pattern_ops`
 * so prefix `LIKE path || '/%'` lookups (roll-up counts, rename/delete cascade) stay index-friendly.
 */
export const labels = pgTable(
  "labels",
  {
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    path: text("path").notNull(),
    /** Human-facing segment name for this exact path; null falls back to the path leaf. */
    displayName: text("display_name"),
    /** Per-path swatch (CSS color string); null = the default/inherited appearance. */
    color: text("color"),
    /** Per-path icon key (lucide glyph name); null = the default folder icon. */
    icon: text("icon"),
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: now(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.orgId, t.path] }),
    byPath: index("labels_org_path_idx").using("btree", t.orgId, t.path.asc().op("text_pattern_ops")),
  }),
);

/**
 * The assignment edge: a skill is "filed in" N label paths. One row per (skill, path). The path
 * string is stored here directly (no FK to a label id) so a rename is a prefix `UPDATE` and a delete
 * is a prefix `DELETE` across both tables, and roll-up counts need no join. Org-scoped composite FK
 * `(org_id, skill_id) → skills(org_id, id)` cascades on skill/org delete and guarantees the edge's
 * org matches the skill's. `text_pattern_ops` index on `(org_id, path)` for the prefix lookups.
 */
export const skillLabels = pgTable(
  "skill_labels",
  {
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    skillId: uuid("skill_id").notNull(),
    path: text("path").notNull(),
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: now(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.orgId, t.skillId, t.path] }),
    byPath: index("skill_labels_org_path_idx").using("btree", t.orgId, t.path.asc().op("text_pattern_ops")),
    skillOrgFk: foreignKey({
      columns: [t.orgId, t.skillId],
      foreignColumns: [skills.orgId, skills.id],
      name: "skill_labels_skill_org_fk",
    }).onDelete("cascade"),
  }),
);

/**
 * Per-user personal folder tree — the "My Skills" counterpart to {@link labels}. Same shape, but
 * keyed by `(org_id, owner_id, path)` so each user's personal library has its own private folders. A
 * row lets an empty personal folder exist. RLS is user-scoped (org_id AND owner_id) because these
 * rows are private; the service additionally filters `owner_id = actor.id` on every query.
 */
export const personalLabels = pgTable(
  "personal_labels",
  {
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    ownerId: text("owner_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    path: text("path").notNull(),
    displayName: text("display_name"),
    color: text("color"),
    icon: text("icon"),
    createdAt: now(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.orgId, t.ownerId, t.path] }),
    byPath: index("personal_labels_owner_path_idx").using(
      "btree",
      t.orgId,
      t.ownerId,
      t.path.asc().op("text_pattern_ops"),
    ),
  }),
);

/**
 * The personal assignment edge: an authored personal skill is "filed in" N personal paths. One row
 * per (owner, skill, path). Path stored directly so rename = prefix `UPDATE` and delete = prefix
 * `DELETE`. The org-scoped composite FK `(org_id, skill_id) → skills(org_id, id)` guarantees the
 * edge's org matches the skill's and cascades on skill/org delete (e.g. when a shared skill is reaped).
 */
export const personalSkillLabels = pgTable(
  "personal_skill_labels",
  {
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    ownerId: text("owner_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    skillId: uuid("skill_id").notNull(),
    path: text("path").notNull(),
    createdAt: now(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.orgId, t.ownerId, t.skillId, t.path] }),
    byPath: index("personal_skill_labels_owner_path_idx").using(
      "btree",
      t.orgId,
      t.ownerId,
      t.path.asc().op("text_pattern_ops"),
    ),
    skillOrgFk: foreignKey({
      columns: [t.orgId, t.skillId],
      foreignColumns: [skills.orgId, skills.id],
      name: "personal_skill_labels_skill_org_fk",
    }).onDelete("cascade"),
  }),
);

export const skillFilterPreferences = pgTable(
  "skill_filter_preferences",
  {
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    activeFilters: jsonb("active_filters").$type<unknown[]>().notNull().default([]),
    groupBy: text("group_by").notNull().default("folder"),
    sidebarOrder: jsonb("sidebar_order")
      .$type<{ mine: string[]; org: string[] }>()
      .notNull()
      .default({ mine: [], org: [] }),
    createdAt: now(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.orgId, t.userId] }),
    groupByCheck: check("skill_filter_preferences_group_by_check", sql`${t.groupBy} in ('folder', 'none')`),
  }),
);

/**
 * Per-workspace, per-member progress for the dismissible My Skills getting-started checklist.
 * Step timestamps and completion are first-write-wins; dismissal is the only reversible field.
 */
export const gettingStartedStates = pgTable(
  "getting_started_states",
  {
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    companionInstalledAt: timestamp("companion_installed_at", { withTimezone: true }),
    localReviewedAt: timestamp("local_reviewed_at", { withTimezone: true }),
    orgReviewedAt: timestamp("org_reviewed_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    dismissedAt: timestamp("dismissed_at", { withTimezone: true }),
    createdAt: now(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.orgId, t.userId] }),
  }),
);

export const skillComments = pgTable(
  "skill_comments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    skillId: uuid("skill_id")
      .notNull()
      .references(() => skills.id, { onDelete: "cascade" }),
    authorId: text("author_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    body: text("body").notNull(),
    /** Null = root thread; non-null = a reply to that root comment. Single-level nesting only. */
    parentId: uuid("parent_id").references((): AnyPgColumn => skillComments.id, { onDelete: "cascade" }),
    /** Null = global thread; else the skill_versions row this thread is linked to. */
    versionId: uuid("version_id").references(() => skillVersions.id, { onDelete: "set null" }),
    /** Deprecated threads are greyed/struck-through, never deleted. */
    deprecated: boolean("deprecated").notNull().default(false),
    createdAt: now(),
  },
  (t) => ({
    byOrg: index("skill_comments_org_idx").on(t.orgId),
    bySkillParent: index("skill_comments_skill_parent_idx").on(t.skillId, t.parentId),
  }),
);

/**
 * Image attachments on a comment. One row per image, ordered by `position`. The bytes live in
 * object storage (key = `${orgId}/comments/${id}`); only metadata is kept here. Tenant-scoped and
 * cascade-deleted with the parent comment / skill / org.
 */
export const skillCommentImages = pgTable(
  "skill_comment_images",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    commentId: uuid("comment_id")
      .notNull()
      .references(() => skillComments.id, { onDelete: "cascade" }),
    skillId: uuid("skill_id")
      .notNull()
      .references(() => skills.id, { onDelete: "cascade" }),
    storageKey: text("storage_key").notNull(),
    contentType: text("content_type").notNull(),
    byteSize: integer("byte_size").notNull(),
    position: integer("position").notNull().default(0),
    createdAt: now(),
  },
  (t) => ({
    byComment: index("skill_comment_images_comment_idx").on(t.commentId),
    byOrg: index("skill_comment_images_org_idx").on(t.orgId),
  }),
);

/**
 * Personal access tokens for programmatic publish/install over the API. The plaintext
 * `cmp_pat_<hex>` is shown to the caller once; only its sha256 `token_hash` is stored.
 * `scopes` gates capability; tokens expire and can be revoked. Agent-derived rows keep only
 * value-free provenance plus an optional explicit runtime target binding. Companion-sourced
 * rows are ephemeral Skills Hub tokens (not the THE-360 permanent PAT): minted per Box staging with
 * the fixed unconditional scope set, and re-checked on every request against the Companion still
 * existing for the acting member.
 */
export const apiTokens = pgTable(
  "api_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    tokenPrefix: text("token_prefix").notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    scopes: jsonb("scopes").$type<string[]>().notNull().default([]),
    sourceType: text("source_type").notNull().default("human"),
    sourceAgentId: text("source_agent_id"),
    targetWorkspaceId: text("target_workspace_id"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: now(),
  },
  (t) => ({
    byOrgUser: index("api_tokens_org_user_idx").on(t.orgId, t.userId),
    sourceProvenance: check(
      "api_tokens_source_provenance_check",
      sql`(${t.sourceType} = 'human' and ${t.sourceAgentId} is null and ${t.targetWorkspaceId} is null)
        or (${t.sourceType} = 'agent_auth' and ${t.sourceAgentId} is not null)
        or (${t.sourceType} = 'companion' and ${t.sourceAgentId} is not null
          and ${t.targetWorkspaceId} is null
          and ${t.sourceAgentId} ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')`,
    ),
  }),
);

export const auditLog = pgTable("audit_log", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: uuid("org_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  actorId: text("actor_id").references(() => user.id, { onDelete: "set null" }),
  /** Creator-private audit visibility for resources whose admins have no override. */
  privateToUserId: text("private_to_user_id").references(() => user.id, {
    onDelete: "cascade",
  }),
  action: text("action").notNull(),
  targetType: text("target_type").notNull(),
  targetId: text("target_id").notNull(),
  metadata: jsonb("metadata").$type<SchemaJsonObject>().notNull().default({}),
  createdAt: now(),
});

/**
 * Tracks which built-in local helper skills (the "Companion skills" section) a member has installed
 * on their machine, and at which version. The local skill reports here at the end of its install via
 * `POST /v1/local-skills/:key/installed`; the UI compares `installed_version` against the bundled
 * package version to show Not installed / Installed / Update available. One row per member per
 * `skill_key` per workspace.
 */
export const localSkillInstalls = pgTable(
  "local_skill_installs",
  {
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    /** Built-in skill key, e.g. `companion`. */
    skillKey: text("skill_key").notNull(),
    /** Semver the agent reported installing. */
    installedVersion: text("installed_version").notNull(),
    /** Optional free-form source label, e.g. "Claude Code". */
    agentLabel: text("agent_label"),
    /** First time this member reported the skill installed. */
    installedAt: timestamp("installed_at", { withTimezone: true }).notNull().defaultNow(),
    /** Latest report ("last checked" in the UI). */
    lastReportedAt: timestamp("last_reported_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.orgId, t.userId, t.skillKey] }),
    byOrgUser: index("local_skill_installs_org_user_idx").on(t.orgId, t.userId),
  }),
);

/**
 * Tracks which PUBLISHED Skills Hub skills (the `skills` table) a member has installed, and at which
 * version. The assistant reports a confirmed install via `POST /v1/skills/:slug/install`
 * (source = "agent") at the end of the normal install flow; a member can also mark a skill
 * installed / not-installed by hand from the UI (source = "manual", e.g. installed another way, or
 * correcting a false state). `installed_version` is null when a manual mark didn't supply one. The
 * list view compares `installed_version` against the skill's current published version to show
 * Installed / Update available. One row per member per skill per workspace.
 */
export const skillInstalls = pgTable(
  "skill_installs",
  {
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    skillId: uuid("skill_id")
      .notNull()
      .references(() => skills.id, { onDelete: "cascade" }),
    /** Semver the member/agent reported, or null when a manual mark didn't supply one. */
    installedVersion: text("installed_version"),
    /** Optional free-form source label, e.g. "Claude Code". */
    agentLabel: text("agent_label"),
    /** How the install was recorded: "agent" (reported by the assistant) or "manual" (marked by hand). */
    source: text("source", { enum: ["agent", "manual"] }).notNull().default("manual"),
    /** First time this member recorded the skill installed. */
    installedAt: timestamp("installed_at", { withTimezone: true }).notNull().defaultNow(),
    /** Latest report/mark ("last checked"). */
    lastReportedAt: timestamp("last_reported_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.orgId, t.userId, t.skillId] }),
    byOrgUser: index("skill_installs_org_user_idx").on(t.orgId, t.userId),
  }),
);

/** One GitHub App user authorization per workspace. Plaintext OAuth credentials never enter Postgres. */
export const githubConnections = pgTable(
  "github_connections",
  {
    orgId: uuid("org_id")
      .primaryKey()
      .references(() => organizations.id, { onDelete: "cascade" }),
    githubUserId: text("github_user_id").notNull(),
    githubLogin: text("github_login").notNull(),
    githubAvatarUrl: text("github_avatar_url"),
    /** Rotated for every OAuth connect or refresh so stale refreshes cannot overwrite a replacement row. */
    credentialGeneration: uuid("credential_generation").notNull().defaultRandom(),
    credentialVersion: integer("credential_version").notNull().default(1),
    accessCiphertext: text("access_ciphertext").notNull(),
    accessIv: text("access_iv").notNull(),
    accessAuthTag: text("access_auth_tag").notNull(),
    accessWrappedDek: text("access_wrapped_dek").notNull(),
    accessWrapIv: text("access_wrap_iv").notNull(),
    accessWrapAuthTag: text("access_wrap_auth_tag").notNull(),
    accessKeyId: text("access_key_id").notNull(),
    refreshCiphertext: text("refresh_ciphertext"),
    refreshIv: text("refresh_iv"),
    refreshAuthTag: text("refresh_auth_tag"),
    refreshWrappedDek: text("refresh_wrapped_dek"),
    refreshWrapIv: text("refresh_wrap_iv"),
    refreshWrapAuthTag: text("refresh_wrap_auth_tag"),
    refreshKeyId: text("refresh_key_id"),
    accessExpiresAt: timestamp("access_expires_at", { withTimezone: true }),
    refreshExpiresAt: timestamp("refresh_expires_at", { withTimezone: true }),
    connectedBy: text("connected_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: now(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    credentialVersionCheck: check("github_connections_credential_version_check", sql`${t.credentialVersion} >= 1`),
  }),
);

/** A desired-state, one-way Companion → GitHub repository mirror. */
export const githubSyncDestinations = pgTable(
  "github_sync_destinations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    installationId: text("installation_id").notNull(),
    repositoryId: text("repository_id").notNull(),
    owner: text("owner").notNull(),
    name: text("name").notNull(),
    htmlUrl: text("html_url").notNull(),
    defaultBranch: text("default_branch").notNull().default("main"),
    private: boolean("private").notNull().default(true),
    mode: githubSyncModeEnum("mode").notNull().default("all"),
    status: githubSyncStatusEnum("status").notNull().default("pending"),
    desiredRevision: integer("desired_revision").notNull().default(1),
    appliedRevision: integer("applied_revision").notNull().default(0),
    resolvedSkillCount: integer("resolved_skill_count").notNull().default(0),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    lastObservedAt: timestamp("last_observed_at", { withTimezone: true }),
    lastCommitSha: text("last_commit_sha"),
    lastError: text("last_error"),
    attempts: integer("attempts").notNull().default(0),
    nextRetryAt: timestamp("next_retry_at", { withTimezone: true }),
    leaseOwner: text("lease_owner"),
    leaseUntil: timestamp("lease_until", { withTimezone: true }),
    /** Monotonic fencing token incremented on every claim, including claims by the same worker. */
    leaseGeneration: integer("lease_generation").notNull().default(0),
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    updatedBy: text("updated_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: now(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    uniqueOrgId: unique("github_sync_destinations_org_id_id_uq").on(t.orgId, t.id),
    uniqueRepository: unique("github_sync_destinations_repository_uq").on(t.repositoryId),
    due: index("github_sync_destinations_due_idx").on(t.status, t.nextRetryAt, t.leaseUntil),
    revisionCheck: check(
      "github_sync_destinations_revision_check",
      sql`${t.desiredRevision} >= 1 AND ${t.appliedRevision} >= 0 AND ${t.appliedRevision} <= ${t.desiredRevision}`,
    ),
    attemptsCheck: check("github_sync_destinations_attempts_check", sql`${t.attempts} >= 0`),
    leaseGenerationCheck: check(
      "github_sync_destinations_lease_generation_check",
      sql`${t.leaseGeneration} >= 0`,
    ),
  }),
);

/** Explicit roots for selected-mode mirrors. Dependency closure is derived live by the worker. */
export const githubSyncDestinationSkills = pgTable(
  "github_sync_destination_skills",
  {
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    destinationId: uuid("destination_id").notNull(),
    skillId: uuid("skill_id").notNull(),
    createdAt: now(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.orgId, t.destinationId, t.skillId] }),
    destinationFk: foreignKey({
      columns: [t.orgId, t.destinationId],
      foreignColumns: [githubSyncDestinations.orgId, githubSyncDestinations.id],
      name: "github_sync_destination_skills_destination_org_fk",
    }).onDelete("cascade"),
    skillFk: foreignKey({
      columns: [t.orgId, t.skillId],
      foreignColumns: [skills.orgId, skills.id],
      name: "github_sync_destination_skills_skill_org_fk",
    }).onDelete("cascade"),
    bySkill: index("github_sync_destination_skills_skill_idx").on(t.orgId, t.skillId),
  }),
);

export const secrets = pgTable(
  "secrets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    ownerId: text("owner_id").notNull().references(() => user.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    key: text("key").notNull(),
    audience: secretAudienceEnum("audience").notNull().default("personal"),
    currentVersion: integer("current_version").notNull().default(1),
    lastRotatedAt: timestamp("last_rotated_at", { withTimezone: true }).notNull().defaultNow(),
    disabledAt: timestamp("disabled_at", { withTimezone: true }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: now(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    uniqueOrgId: unique("secrets_org_id_id_uq").on(t.orgId, t.id),
    uniqueOrgIdOwner: unique("secrets_org_id_id_owner_uq").on(t.orgId, t.id, t.ownerId),
    byOwner: index("secrets_org_owner_idx").on(t.orgId, t.ownerId),
    byAudience: index("secrets_org_audience_idx").on(t.orgId, t.audience),
    keyCheck: check("secrets_key_check", sql`${t.key} ~ '^[A-Za-z_][A-Za-z0-9_]*$'`),
  }),
);

/** Envelope-encrypted immutable value version. All binary fields are base64 text. */
export const secretVersions = pgTable(
  "secret_versions",
  {
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    secretId: uuid("secret_id").notNull(),
    version: integer("version").notNull(),
    ciphertext: text("ciphertext").notNull(),
    iv: text("iv").notNull(),
    authTag: text("auth_tag").notNull(),
    wrappedDek: text("wrapped_dek").notNull(),
    wrapIv: text("wrap_iv").notNull(),
    wrapAuthTag: text("wrap_auth_tag").notNull(),
    keyId: text("key_id").notNull(),
    createdBy: text("created_by").notNull().references(() => user.id, { onDelete: "cascade" }),
    createdAt: now(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.orgId, t.secretId, t.version] }),
    byOrg: index("secret_versions_org_idx").on(t.orgId),
    positiveVersion: check("secret_versions_positive_check", sql`${t.version} > 0`),
    secretOrgFk: foreignKey({
      columns: [t.orgId, t.secretId],
      foreignColumns: [secrets.orgId, secrets.id],
      name: "secret_versions_secret_org_fk",
    }).onDelete("cascade"),
  }),
);

/** Explicit recipients for a restricted secret. The owner is implicit and never inserted here. */
export const secretRecipients = pgTable(
  "secret_recipients",
  {
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    secretId: uuid("secret_id").notNull(),
    ownerId: text("owner_id").notNull().references(() => user.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
    createdAt: now(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.orgId, t.secretId, t.userId] }),
    byRecipient: index("secret_recipients_org_user_idx").on(t.orgId, t.userId),
    secretOrgFk: foreignKey({
      columns: [t.orgId, t.secretId, t.ownerId],
      foreignColumns: [secrets.orgId, secrets.id, secrets.ownerId],
      name: "secret_recipients_secret_org_fk",
    }).onDelete("cascade"),
    memberOrgFk: foreignKey({
      columns: [t.orgId, t.userId],
      foreignColumns: [memberships.orgId, memberships.userId],
      name: "secret_recipients_member_org_fk",
    }).onDelete("cascade"),
  }),
);

/** Stable slot identity, retained after a slot disappears so bindings can emit tombstones. */
export const skillSecretSlots = pgTable(
  "skill_secret_slots",
  {
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    skillId: uuid("skill_id").notNull(),
    slotId: uuid("slot_id").notNull(),
    firstSeenAt: now(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.orgId, t.skillId, t.slotId] }),
    skillOrgFk: foreignKey({
      columns: [t.orgId, t.skillId],
      foreignColumns: [skills.orgId, skills.id],
      name: "skill_secret_slots_skill_org_fk",
    }).onDelete("cascade"),
  }),
);

/** Versioned presentation of a stable secret slot. */
export const skillVersionSecretSlots = pgTable(
  "skill_version_secret_slots",
  {
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    skillId: uuid("skill_id").notNull(),
    skillVersionId: uuid("skill_version_id").notNull(),
    slotId: uuid("slot_id").notNull(),
    envKey: text("env_key").notNull(),
    description: text("description").notNull().default(""),
    required: boolean("required").notNull().default(true),
    createdAt: now(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.skillVersionId, t.slotId] }),
    bySkillSlot: index("skill_version_secret_slots_skill_idx").on(t.orgId, t.skillId, t.slotId),
    stableSlotFk: foreignKey({
      columns: [t.orgId, t.skillId, t.slotId],
      foreignColumns: [skillSecretSlots.orgId, skillSecretSlots.skillId, skillSecretSlots.slotId],
      name: "skill_version_secret_slots_stable_fk",
    }).onDelete("cascade"),
    versionOrgFk: foreignKey({
      columns: [t.orgId, t.skillVersionId],
      foreignColumns: [skillVersions.orgId, skillVersions.id],
      name: "skill_version_secret_slots_version_org_fk",
    }).onDelete("cascade"),
    envKeyCheck: check("skill_version_secret_slots_key_check", sql`${t.envKey} ~ '^[A-Za-z_][A-Za-z0-9_]*$'`),
  }),
);

/** One personal binding per user + skill + stable slot. Rows are soft-revoked for tombstones. */
export const skillSecretBindings = pgTable(
  "skill_secret_bindings",
  {
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
    skillId: uuid("skill_id").notNull(),
    slotId: uuid("slot_id").notNull(),
    secretId: uuid("secret_id").notNull(),
    projectionId: uuid("projection_id").notNull().defaultRandom(),
    source: secretBindingSourceEnum("source").notNull().default("manual"),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: now(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.orgId, t.userId, t.skillId, t.slotId] }),
    uniqueProjection: unique("skill_secret_bindings_projection_uq").on(t.projectionId),
    bySecret: index("skill_secret_bindings_secret_idx").on(t.orgId, t.secretId),
    memberOrgFk: foreignKey({
      columns: [t.orgId, t.userId],
      foreignColumns: [memberships.orgId, memberships.userId],
      name: "skill_secret_bindings_member_org_fk",
    }).onDelete("cascade"),
    stableSlotFk: foreignKey({
      columns: [t.orgId, t.skillId, t.slotId],
      foreignColumns: [skillSecretSlots.orgId, skillSecretSlots.skillId, skillSecretSlots.slotId],
      name: "skill_secret_bindings_slot_fk",
    }).onDelete("cascade"),
    secretOrgFk: foreignKey({
      columns: [t.orgId, t.secretId],
      foreignColumns: [secrets.orgId, secrets.id],
      name: "skill_secret_bindings_secret_org_fk",
    }).onDelete("cascade"),
  }),
);

/** Workspace suggestion for a slot. Access to the suggested secret is still checked per user. */
export const skillSecretSuggestions = pgTable(
  "skill_secret_suggestions",
  {
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    skillId: uuid("skill_id").notNull(),
    slotId: uuid("slot_id").notNull(),
    secretId: uuid("secret_id").notNull(),
    suggestedBy: text("suggested_by").notNull().references(() => user.id, { onDelete: "cascade" }),
    createdAt: now(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.orgId, t.skillId, t.slotId] }),
    stableSlotFk: foreignKey({
      columns: [t.orgId, t.skillId, t.slotId],
      foreignColumns: [skillSecretSlots.orgId, skillSecretSlots.skillId, skillSecretSlots.slotId],
      name: "skill_secret_suggestions_slot_fk",
    }).onDelete("cascade"),
    secretOrgFk: foreignKey({
      columns: [t.orgId, t.secretId],
      foreignColumns: [secrets.orgId, secrets.id],
      name: "skill_secret_suggestions_secret_org_fk",
    }).onDelete("cascade"),
  }),
);

export const secretRetrievalPlans = pgTable(
  "secret_retrieval_plans",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
    operationId: uuid("operation_id").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    grantedAt: timestamp("granted_at", { withTimezone: true }),
    createdAt: now(),
  },
  (t) => ({
    uniqueOrgId: unique("secret_retrieval_plans_org_id_id_uq").on(t.orgId, t.id),
    uniqueOperation: unique("secret_retrieval_plans_operation_uq").on(t.orgId, t.userId, t.operationId),
    byRateWindow: index("secret_retrieval_plans_rate_idx").on(t.orgId, t.userId, t.createdAt),
    memberOrgFk: foreignKey({
      columns: [t.orgId, t.userId],
      foreignColumns: [memberships.orgId, memberships.userId],
      name: "secret_retrieval_plans_member_org_fk",
    }).onDelete("cascade"),
  }),
);

export const secretRetrievalPlanItems = pgTable(
  "secret_retrieval_plan_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    planId: uuid("plan_id").notNull().references(() => secretRetrievalPlans.id, { onDelete: "cascade" }),
    projectionId: uuid("projection_id").notNull(),
    skill: text("skill").notNull(),
    skillId: uuid("skill_id"),
    skillVersionId: uuid("skill_version_id"),
    skillVersion: text("skill_version"),
    slotId: uuid("slot_id"),
    envKey: text("env_key").notNull(),
    required: boolean("required").notNull().default(true),
    status: secretSlotStatusEnum("status").notNull(),
    secretId: uuid("secret_id"),
    secretVersion: integer("secret_version"),
    secretName: text("secret_name"),
    ownerName: text("owner_name"),
    tombstone: boolean("tombstone").notNull().default(false),
    createdAt: now(),
  },
  (t) => ({
    uniqueProjection: unique("secret_retrieval_plan_items_projection_uq").on(t.planId, t.projectionId),
    byPlan: index("secret_retrieval_plan_items_plan_idx").on(t.orgId, t.planId),
    planOrgFk: foreignKey({
      columns: [t.orgId, t.planId],
      foreignColumns: [secretRetrievalPlans.orgId, secretRetrievalPlans.id],
      name: "secret_retrieval_plan_items_plan_org_fk",
    }).onDelete("cascade"),
    skillVersionOrgFk: foreignKey({
      columns: [t.orgId, t.skillVersionId],
      foreignColumns: [skillVersions.orgId, skillVersions.id],
      name: "secret_retrieval_plan_items_skill_version_org_fk",
    }).onDelete("cascade"),
    secretVersionOrgFk: foreignKey({
      columns: [t.orgId, t.secretId, t.secretVersion],
      foreignColumns: [secretVersions.orgId, secretVersions.secretId, secretVersions.version],
      name: "secret_retrieval_plan_items_secret_version_org_fk",
    }).onDelete("cascade"),
  }),
);

export const secretRetrievalGrants = pgTable(
  "secret_retrieval_grants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
    planId: uuid("plan_id").notNull().references(() => secretRetrievalPlans.id, { onDelete: "cascade" }),
    tokenPrefix: text("token_prefix").notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    redeemedAt: timestamp("redeemed_at", { withTimezone: true }),
    failedAt: timestamp("failed_at", { withTimezone: true }),
    createdAt: now(),
  },
  (t) => ({
    byRateWindow: index("secret_retrieval_grants_rate_idx").on(t.orgId, t.userId, t.createdAt),
    planOrgFk: foreignKey({
      columns: [t.orgId, t.planId],
      foreignColumns: [secretRetrievalPlans.orgId, secretRetrievalPlans.id],
      name: "secret_retrieval_grants_plan_org_fk",
    }).onDelete("cascade"),
    memberOrgFk: foreignKey({
      columns: [t.orgId, t.userId],
      foreignColumns: [memberships.orgId, memberships.userId],
      name: "secret_retrieval_grants_member_org_fk",
    }).onDelete("cascade"),
  }),
);

/** Current database declaration generation for one skill manifest. */
export const skillDatabaseSchemas = pgTable(
  "skill_database_schemas",
  {
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    skillId: uuid("skill_id").notNull(),
    generation: integer("generation").notNull().default(1),
    declarationsChecksum: text("declarations_checksum").notNull(),
    createdAt: now(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.orgId, t.skillId] }),
    skillOrgFk: foreignKey({
      columns: [t.orgId, t.skillId],
      foreignColumns: [skills.orgId, skills.id],
      name: "skill_database_schemas_skill_org_fk",
    }).onDelete("cascade"),
    positiveGeneration: check("skill_database_schemas_generation_check", sql`${t.generation} >= 1`),
  }),
);

export interface SkillDatabaseStoredColumn {
  name: string;
  type: "text" | "integer" | "real" | "boolean" | "json" | "timestamp";
  nullable: boolean;
  default?: string | number | boolean | null;
  retiredAt?: string;
}

/** Projection of the current manifest tables. Retired declarations are retained for lazy files. */
export const skillDatabaseTables = pgTable(
  "skill_database_tables",
  {
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    skillId: uuid("skill_id").notNull(),
    tableName: text("table_name").notNull(),
    audience: skillDatabaseAudienceEnum("audience").notNull(),
    columns: jsonb("columns").$type<SkillDatabaseStoredColumn[]>().notNull(),
    primaryKey: jsonb("primary_key").$type<string[]>().notNull().default([]),
    uniqueConstraints: jsonb("unique_constraints").$type<string[][]>().notNull().default([]),
    retiredAt: timestamp("retired_at", { withTimezone: true }),
    createdAt: now(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.orgId, t.skillId, t.tableName] }),
    schemaFk: foreignKey({
      columns: [t.orgId, t.skillId],
      foreignColumns: [skillDatabaseSchemas.orgId, skillDatabaseSchemas.skillId],
      name: "skill_database_tables_schema_fk",
    }).onDelete("cascade"),
    validName: check(
      "skill_database_tables_name_check",
      sql`${t.tableName} ~ '^[a-z][a-z0-9_]{0,62}$' and ${t.tableName} !~ '^sqlite_'`,
    ),
  }),
);

/** Registry entry for one immutable-addressed SQLite file in object storage. */
export const skillDatabaseRealms = pgTable(
  "skill_database_realms",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    skillId: uuid("skill_id").notNull(),
    audience: skillDatabaseAudienceEnum("audience").notNull(),
    ownerId: text("owner_id"),
    storageKey: text("storage_key").notNull().unique(),
    sizeBytes: integer("size_bytes").notNull().default(0),
    etag: text("etag"),
    schemaGeneration: integer("schema_generation").notNull().default(0),
    lastAccessedAt: timestamp("last_accessed_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: now(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    uniqueOrgRealm: uniqueIndex("skill_database_realms_org_uq")
      .on(t.orgId, t.skillId)
      .where(sql`${t.audience} = 'organization' and ${t.ownerId} is null`),
    uniquePersonalRealm: uniqueIndex("skill_database_realms_personal_uq")
      .on(t.orgId, t.skillId, t.ownerId)
      .where(sql`${t.audience} = 'personal' and ${t.ownerId} is not null`),
    uniqueRealmOwner: unique("skill_database_realms_org_id_id_owner_id_uq")
      .on(t.orgId, t.id, t.ownerId),
    skillOrgFk: foreignKey({
      columns: [t.orgId, t.skillId],
      foreignColumns: [skills.orgId, skills.id],
      name: "skill_database_realms_skill_org_fk",
    }).onDelete("cascade"),
    ownerMembershipFk: foreignKey({
      columns: [t.orgId, t.ownerId],
      foreignColumns: [memberships.orgId, memberships.userId],
      name: "skill_database_realms_owner_membership_fk",
    }).onDelete("cascade"),
    audienceOwner: check(
      "skill_database_realms_audience_owner_check",
      sql`(${t.audience} = 'organization' and ${t.ownerId} is null) or (${t.audience} = 'personal' and ${t.ownerId} is not null)`,
    ),
    nonnegativeSize: check("skill_database_realms_size_check", sql`${t.sizeBytes} >= 0`),
    nonnegativeGeneration: check("skill_database_realms_generation_check", sql`${t.schemaGeneration} >= 0`),
  }),
);

/** Member grants for a complete personal SQLite realm. Owner/Admin roles never override these rows. */
export const skillDatabaseRealmShares = pgTable(
  "skill_database_realm_shares",
  {
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    realmId: uuid("realm_id").notNull(),
    ownerId: text("owner_id").notNull(),
    granteeId: text("grantee_id").notNull(),
    createdAt: now(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.orgId, t.realmId, t.granteeId] }),
    realmOwnerFk: foreignKey({
      columns: [t.orgId, t.realmId, t.ownerId],
      foreignColumns: [skillDatabaseRealms.orgId, skillDatabaseRealms.id, skillDatabaseRealms.ownerId],
      name: "skill_database_realm_shares_realm_owner_fk",
    }).onDelete("cascade"),
    ownerMembershipFk: foreignKey({
      columns: [t.orgId, t.ownerId],
      foreignColumns: [memberships.orgId, memberships.userId],
      name: "skill_database_realm_shares_owner_membership_fk",
    }).onDelete("cascade"),
    granteeMembershipFk: foreignKey({
      columns: [t.orgId, t.granteeId],
      foreignColumns: [memberships.orgId, memberships.userId],
      name: "skill_database_realm_shares_grantee_membership_fk",
    }).onDelete("cascade"),
    differentMembers: check(
      "skill_database_realm_shares_different_members_check",
      sql`${t.ownerId} <> ${t.granteeId}`,
    ),
  }),
);

/** Fixed one-minute counters avoid one audit row per SQL statement. */
export const skillDatabaseRateWindows = pgTable(
  "skill_database_rate_windows",
  {
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull(),
    windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
    queryCount: integer("query_count").notNull().default(1),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.orgId, t.userId, t.windowStart] }),
    memberOrgFk: foreignKey({
      columns: [t.orgId, t.userId],
      foreignColumns: [memberships.orgId, memberships.userId],
      name: "skill_database_rate_windows_member_org_fk",
    }).onDelete("cascade"),
    positiveCount: check("skill_database_rate_windows_count_check", sql`${t.queryCount} >= 1`),
  }),
);

/**
 * Durable object-deletion outbox populated by the realm delete trigger. It intentionally has no
 * organization FK: an organization cascade must leave its object cleanup work behind.
 */
export const skillDatabaseObjectDeletions = pgTable(
  "skill_database_object_deletions",
  {
    storageKey: text("storage_key").primaryKey(),
    orgId: uuid("org_id").notNull(),
    attempts: integer("attempts").notNull().default(0),
    availableAt: timestamp("available_at", { withTimezone: true }).notNull().defaultNow(),
    claimToken: uuid("claim_token"),
    claimExpiresAt: timestamp("claim_expires_at", { withTimezone: true }),
    createdAt: now(),
  },
  (t) => ({
    byAvailability: index("skill_database_object_deletions_available_idx").on(
      t.availableAt,
      t.claimExpiresAt,
    ),
    nonnegativeAttempts: check(
      "skill_database_object_deletions_attempts_check",
      sql`${t.attempts} >= 0`,
    ),
    completeClaim: check(
      "skill_database_object_deletions_claim_check",
      sql`(${t.claimToken} is null and ${t.claimExpiresAt} is null)
        or (${t.claimToken} is not null and ${t.claimExpiresAt} is not null)`,
    ),
  }),
);
