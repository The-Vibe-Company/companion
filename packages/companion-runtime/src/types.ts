/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/no-unsafe-dictionary-type, anti-slop/require-safety-comment-for-type-assertion -- Existing runtime boundary decoders predate the incremental anti-slop gate. */

import {
  COMPANION_BUDGETS,
  companionMcpAccountSchema,
  type CompanionMcpAccount,
} from "@companion/contracts";

export const WORK_KINDS = ["operation", "decision", "attempt", "settings", "health"] as const;
export type WorkKind = (typeof WORK_KINDS)[number];

export const CLIENT_SURFACES = ["web", "mobile_web", "native_mobile"] as const;
export type ClientSurface = (typeof CLIENT_SURFACES)[number];

/** Maximum two-hour turn deadline plus five minutes of staging/dispatch reserve. */
export const COMPANION_RUNTIME_MATERIAL_MIN_TTL_MS = COMPANION_BUDGETS.materialMinTtlMs;

export const TURN_STATUSES = [
  "queued",
  "starting",
  "dispatching",
  "running",
  "needs_input",
  "succeeded",
  "failed",
  "interrupted",
  "cancelled",
] as const;
export type TurnStatus = (typeof TURN_STATUSES)[number];
export type AttemptStatus = Exclude<TurnStatus, "queued">;

export const DISPATCH_STATES = [
  "pending",
  "write_intent",
  "accepted",
  "rejected",
  "ambiguous",
] as const;
export type DispatchState = (typeof DISPATCH_STATES)[number];

export const OPERATION_KINDS = [
  "delete",
  "stop",
  "restart_pi",
  "restart_box",
  "start",
  "apply_settings",
] as const;
export type OperationKind = (typeof OPERATION_KINDS)[number];

export const OPERATION_TRIGGERS = [
  "turn",
  "user",
  "settings",
  "recovery",
  "kill_switch",
] as const;
export type OperationTrigger = (typeof OPERATION_TRIGGERS)[number];

export const OPERATION_LANES = ["main", "routine"] as const;
export type OperationLane = (typeof OPERATION_LANES)[number];

export const DECISION_STATUSES = [
  "pending",
  "allowed",
  "denied",
  "answered",
  "expired",
  "cancelled",
] as const;
export type DecisionStatus = (typeof DECISION_STATUSES)[number];

export const DECISION_DELIVERY_STATES = [
  "pending",
  "write_intent",
  "delivered",
  "ambiguous",
  "cancelled",
] as const;
export type DecisionDeliveryState = (typeof DECISION_DELIVERY_STATES)[number];

export const BOX_OBSERVED_STATES = [
  "absent",
  "initializing",
  "provisioning",
  "ready",
  "idle",
  "running",
  "archiving",
  "archived",
  "error",
  "unknown",
] as const;
export type BoxObservedState = (typeof BOX_OBSERVED_STATES)[number];

export const PI_OBSERVED_STATES = [
  "absent",
  "starting",
  "idle",
  "running",
  "stopped",
  "error",
  "unknown",
] as const;
export type PiObservedState = (typeof PI_OBSERVED_STATES)[number];

export const ERROR_ACTIONS = [
  "retry",
  "cancel",
  "restart_pi",
  "restart_box",
  "switch_model",
  "reconnect_provider",
  "none",
] as const;
export type ErrorAction = (typeof ERROR_ACTIONS)[number];

export interface GateStatus {
  enabled: boolean;
  gateEpoch: bigint;
  updatedAt: Date;
}

export interface LeaseFence {
  orgId: string;
  companionId: string;
  claimToken: string;
  claimEpoch: bigint;
  gateEpoch: bigint;
  executorId: string;
  workKind: WorkKind;
  workId: string;
}

export interface RuntimeClaimBase extends Omit<LeaseFence, "executorId"> {
  actorId: string | null;
  clientSurface: ClientSurface | null;
  runtimeGeneration: bigint;
  checkpoint: string;
  checkpointSequence: bigint;
  turnId: string | null;
  turnStatus: TurnStatus | null;
  attemptStatus: AttemptStatus | null;
  dispatchState: DispatchState | null;
  eventCursor: bigint | null;
  unknownEventCount: number | null;
  malformedEventCount: number | null;
  oversizedEventCount: number | null;
  coldStartDeadlineAt: Date | null;
  inactivityDeadlineAt: Date | null;
  absoluteDeadlineAt: Date | null;
  operationKind: OperationKind | null;
  operationStartedAt: Date | null;
  operationAttemptCount: number | null;
  providerOperationId: string | null;
  targetSettingsRevision: bigint | null;
  targetSkillsRevision: number | null;
  decisionStatus: DecisionStatus | null;
  decisionDeliveryState: DecisionDeliveryState | null;
}

export type OperationRuntimeClaim =
  | (RuntimeClaimBase & {
    workKind: "operation";
    actorId: string;
    clientSurface: ClientSurface;
    operationKind: "start" | "restart_pi" | "restart_box" | "apply_settings";
    operationStartedAt: Date;
    operationAttemptCount: number;
    targetSettingsRevision: bigint;
    targetSkillsRevision: number | null;
  })
  | (RuntimeClaimBase & {
    workKind: "operation";
    actorId: string;
    clientSurface: null;
    operationKind: "restart_pi";
    operationStartedAt: Date;
    operationAttemptCount: number;
    targetSettingsRevision: null;
    targetSkillsRevision: null;
  })
  | (RuntimeClaimBase & {
    workKind: "operation";
    actorId: string;
    clientSurface: null;
    operationKind: "stop";
    operationStartedAt: Date;
    operationAttemptCount: number;
    targetSettingsRevision: null;
    targetSkillsRevision: number;
  })
  | (RuntimeClaimBase & {
    workKind: "operation";
    actorId: string;
    clientSurface: null;
    operationKind: "delete";
    operationStartedAt: Date;
    operationAttemptCount: number;
    targetSettingsRevision: null;
    targetSkillsRevision: null;
  });

export type DecisionRuntimeClaim = RuntimeClaimBase & {
  workKind: "decision";
  turnId: string;
  decisionStatus: DecisionStatus;
  decisionDeliveryState: DecisionDeliveryState;
};

export type AttemptRuntimeClaim = RuntimeClaimBase & {
  workKind: "attempt";
  actorId: string;
  clientSurface: ClientSurface;
  turnId: string;
  attemptStatus: AttemptStatus;
  dispatchState: DispatchState;
  eventCursor: bigint;
  unknownEventCount: number;
  malformedEventCount: number;
  oversizedEventCount: number;
  absoluteDeadlineAt: Date;
};

export type SettingsRuntimeClaim = RuntimeClaimBase & {
  workKind: "settings";
  actorId: string;
  clientSurface: ClientSurface;
  targetSettingsRevision: bigint;
  targetSkillsRevision: number;
};

export type HealthRuntimeClaim = RuntimeClaimBase & {
  workKind: "health";
  actorId: null;
  clientSurface: null;
  turnId: null;
  operationKind: null;
};

export type RuntimeClaim =
  | OperationRuntimeClaim
  | DecisionRuntimeClaim
  | AttemptRuntimeClaim
  | SettingsRuntimeClaim
  | HealthRuntimeClaim;

export interface ProviderRef {
  provider_id: string;
  credential_generation: string;
  credential_version: number;
}

export interface SkillRef {
  skill_id: string;
  current_version_id: string | null;
}

export interface McpRef {
  account_id: string;
  credential_generation: string;
}

export interface RuntimeV3McpRef extends McpRef {
  credential_version: number;
}

interface RuntimeV3EncryptedMaterial {
  credential_generation: string;
  credential_version: number;
  ciphertext: string;
  iv: string;
  auth_tag: string;
  wrapped_dek: string;
  wrap_iv: string;
  wrap_auth_tag: string;
  key_id: string;
}

export interface RuntimeV3ProviderMaterial extends RuntimeV3EncryptedMaterial {
  provider_id: string;
  auth_method: string;
}

export interface RuntimeV3SkillMaterial {
  skill_id: string;
  slug: string;
  version_id: string;
  version: string;
  checksum: string;
  size_bytes: number;
  storage_path: string;
}

export interface RuntimeV3McpMaterial extends RuntimeV3EncryptedMaterial {
  account_id: string;
  owner_id: string;
  provider: string;
  label: string;
  transport: string;
  account_config: CompanionMcpAccount;
}

export interface RuntimeV3PreparationSnapshot {
  providerRefs: ProviderRef[];
  skillRefs: SkillRef[];
  mcpRefs: RuntimeV3McpRef[];
  providerMaterial: RuntimeV3ProviderMaterial[];
  skillMaterial: RuntimeV3SkillMaterial[];
  mcpMaterial: RuntimeV3McpMaterial[];
  configCatalog: RuntimeConfigCatalog | null;
}

export interface RuntimeAuthorization {
  authorized: boolean;
  denialCode: string | null;
  leaseExpiresAt: Date;
  authorizationActorId: string | null;
  decisionActorId: string | null;
  clientSurface: ClientSurface | null;
  runtimeGeneration: bigint | null;
  boxId: string | null;
  boxState: BoxObservedState | null;
  piState: PiObservedState | null;
  /** Current main Companion Pi instance identity used for ordinary runtime broker operations. */
  piInvocationId: string | null;
  diskLayoutVersion: number | null;
  appliedSettingsRevision: bigint | null;
  appliedSkillsRevision: number | null;
  modelId: string | null;
  persona: string | null;
  canWriteSkills: boolean | null;
  providerRefs: ProviderRef[];
  skillRefs: SkillRef[];
  mcpRefs: McpRef[];
  desiredSettingsRevision: bigint | null;
  skillsRevision: number | null;
  workCheckpoint: string;
  workCheckpointSequence: bigint;
  turnId: string | null;
  turnStatus: TurnStatus | null;
  attemptStatus: AttemptStatus | null;
  dispatchState: DispatchState | null;
  eventCursor: bigint | null;
  unknownEventCount: number | null;
  malformedEventCount: number | null;
  oversizedEventCount: number | null;
  coldStartDeadlineAt: Date | null;
  inactivityDeadlineAt: Date | null;
  absoluteDeadlineAt: Date | null;
  operationKind: OperationKind | null;
  operationStartedAt: Date | null;
  operationAttemptCount: number | null;
  operationTrigger: OperationTrigger | null;
  operationLane: OperationLane | null;
  sourceDispatchState: DispatchState | null;
  sourcePiInvocationId: string | null;
  providerOperationId: string | null;
  targetSettingsRevision: bigint | null;
  targetSkillsRevision: number | null;
  decisionStatus: DecisionStatus | null;
  decisionDeliveryState: DecisionDeliveryState | null;
  decisionRequestKey: string | null;
  decisionResponseText: string | null;
  /** Persisted prompt/decision write identity, exposed so takeover can resolve broker state. */
  commandId: string | null;
  /** Isolated routine/command Pi invocation pinned atomically with the prompt write intent. */
  commandPiInvocationId: string | null;
}

export interface RuntimeCheckpointInput {
  expectedSequence: bigint;
  nextCheckpoint: string;
  providerOperationId?: string;
  commandId?: string;
  piInvocationId?: string;
  eventCursor?: bigint;
  activityAt?: Date;
  unknownEventCount?: number;
  malformedEventCount?: number;
  oversizedEventCount?: number;
}

export interface RuntimeObservationInput {
  runtimeGeneration: bigint;
  expectedSequence: bigint;
  boxId?: string;
  boxState?: BoxObservedState;
  piState?: PiObservedState;
  piInvocationId?: string;
  diskLayoutVersion?: number;
  appliedSettingsRevision?: bigint;
  appliedSkillsRevision?: number;
  observedAt: Date;
}

export type RuntimeTerminalStatus = "succeeded" | "failed" | "interrupted" | "cancelled";

export interface SafeRuntimeError {
  code: string;
  message: string;
  action: ErrorAction;
}

export interface RuntimeSettlementInput {
  terminalStatus: RuntimeTerminalStatus;
  error?: SafeRuntimeError;
}

export type DecisionRequestKind =
  | "question"
  | "confirmation"
  | "config_proposal"
  | "routine_proposal"
  | "trigger_proposal";
export type ModelInputCapability = "text" | "image";

/**
 * One file a claimed turn has to stage on the Box before its prompt is dispatched.
 *
 * The storage key travels because only apps/runtime holds object-storage credentials, and the digest
 * travels with it so the bytes that come back can be proven to be the bytes the control plane
 * accepted. Neither ever reaches a browser, a prompt, or an error message.
 */
export interface RuntimeAttachment {
  id: string;
  storageKey: string;
  contentType: string;
  byteSize: number;
  sha256: string;
  filename: string;
  position: number;
}

/** Sensitive values remain opaque to this package and are never included in errors or health. */
export interface RuntimeConfigCatalogSkill {
  id: string;
  slug: string;
  name: string;
  description: string;
  selected: boolean;
}

export interface RuntimeConfigCatalogPlugin {
  id: string;
  label: string;
  provider: string;
  transport: string;
  selected: boolean;
}

export interface RuntimeConfigCatalog {
  companion: {
    model_id: string | null;
    provider_id: string | null;
    persona: string | null;
  };
  skills: RuntimeConfigCatalogSkill[];
  plugins: RuntimeConfigCatalogPlugin[];
  note: string;
}

export interface RuntimeWorkMaterial {
  turnId: string | null;
  attemptId: string | null;
  messageEventId: string | null;
  promptText: string | null;
  /** Durable attempt start used to make the per-turn time suffix byte-stable across recovery. */
  turnStartedAt: Date | null;
  /** Stored member IANA timezone; UTC is supplied by the database only when the profile is unset. */
  memberTimezone: string | null;
  /** Scheduled routine snapshot identity; distinct from the turn id that identifies this run. */
  routineId: string | null;
  routineName: string | null;
  /** Trigger identity and the only allowed terminal surface mode for isolated validation runs. */
  triggerName: string | null;
  triggerMode: "notify" | "relay" | null;
  /** Once true, takeover must keep using the run-scoped session even if the deploy gate is off. */
  routineIsolated: boolean;
  /** Immutable runtime-only main-conversation background pinned before first Box contact. */
  routineContext: {
    id: string;
    sha256: string;
    content: string;
  } | null;
  decisionRequestKind: DecisionRequestKind | null;
  decisionResponsePayload: Record<string, unknown> | null;
  providerMaterial: Record<string, unknown>[];
  skillMaterial: Record<string, unknown>[];
  mcpMaterial: Record<string, unknown>[];
  modelInput: ModelInputCapability[] | null;
  hasVisibleOutput: boolean;
  /** Files the member sent with this turn's message, in stable order. Empty for every other work kind. */
  attachments: RuntimeAttachment[];
  /** Credential-free snapshot of what this Companion could select, or null when it is not staged. */
  configCatalog: RuntimeConfigCatalog | null;
  /** The instance's current Box, when one exists. Read-only companion to {@link agentEndpoint}. */
  boxId: string | null;
  /**
   * The hosted direct-transport agent endpoint staging registered for this Box, or null when none
   * was registered. Only ciphertext crosses this boundary: the proxy and bearer tokens are
   * masterKey-encrypted by apps/runtime, and `observedAt` carries the freshness the runtime judges
   * before trusting the URL for a direct call.
   */
  agentEndpoint: {
    hostedUrl: string;
    tokenCiphertext: string;
    observedAt: Date;
  } | null;
}

/** Credential-free immutable Skill snapshot captured by a user Pi-shutdown operation. */
export interface RuntimeSkillUpdateMaterial {
  targetSkillsRevision: number;
  requiredSkillsRevision: number;
  selectedSkillIds: string[];
  skillRefs: SkillRef[];
  skillMaterial: RuntimeWorkMaterial["skillMaterial"];
}

/**
 * One image harvested from Pi's outbox and already stored under its content address, as the control
 * plane is asked to record it. It carries no id: the row does not exist until this is recorded.
 */
export interface RuntimeOutputAttachment {
  storageKey: string;
  contentType: string;
  byteSize: number;
  sha256: string;
  filename: string;
  /** Object-store upload completion, which alone anchors the immutable retention deadline. */
  uploadedAt: Date;
}

export const DUPLICATE_CLEANUP_STATUSES = [
  "pending",
  "delete_requested",
  "waiting_deleted",
  "deleted",
  "already_deleted",
  "blocked",
] as const;
export type DuplicateCleanupStatus = (typeof DUPLICATE_CLEANUP_STATUSES)[number];

export interface DuplicateCleanup {
  boxId: string;
  status: DuplicateCleanupStatus;
  providerOperationId: string | null;
  checkpointSequence: bigint;
}

export interface McpOauthEnvelope {
  ciphertext: string;
  iv: string;
  authTag: string;
  wrappedDek: string;
  wrapIv: string;
  wrapAuthTag: string;
  keyId: string;
}

export interface McpOauthCasResult {
  updated: boolean;
  credentialGeneration: string;
}

export class RuntimeRowDecodeError extends Error {
  readonly stableCode = "runtime_row_decode_failed";
  readonly action = "retry" as const;

  constructor(readonly field: string, detail = "invalid runtime database row") {
    super(detail);
    this.name = "RuntimeRowDecodeError";
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const BOX_ID = /^bx_[23456789abcdefghjkmnpqrstuvwxyz]{8}$/;
const STABLE_TEXT = /^[a-z][a-z0-9_]{0,63}$/;

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RuntimeRowDecodeError("row");
  }
  return value as Record<string, unknown>;
}

function requiredString(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  if (typeof value !== "string" || value.length === 0 || value.includes("\n") || value.includes("\r")) {
    throw new RuntimeRowDecodeError(key);
  }
  return value;
}

function nullableString(row: Record<string, unknown>, key: string): string | null {
  if (row[key] === null || row[key] === undefined) return null;
  return requiredString(row, key);
}

function uuid(row: Record<string, unknown>, key: string): string {
  const value = requiredString(row, key);
  if (!UUID.test(value)) throw new RuntimeRowDecodeError(key);
  return value;
}

function nullableUuid(row: Record<string, unknown>, key: string): string | null {
  if (row[key] === null || row[key] === undefined) return null;
  return uuid(row, key);
}

function bigintText(row: Record<string, unknown>, key: string): bigint {
  const value = row[key];
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new RuntimeRowDecodeError(key, "runtime bigint was not selected as text");
  }
  return BigInt(value);
}

function nullableBigintText(row: Record<string, unknown>, key: string): bigint | null {
  if (row[key] === null || row[key] === undefined) return null;
  return bigintText(row, key);
}

function integer(row: Record<string, unknown>, key: string): number {
  const value = row[key];
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new RuntimeRowDecodeError(key);
  return value as number;
}

function nullableInteger(row: Record<string, unknown>, key: string): number | null {
  if (row[key] === null || row[key] === undefined) return null;
  return integer(row, key);
}

function boolean(row: Record<string, unknown>, key: string): boolean {
  if (typeof row[key] !== "boolean") throw new RuntimeRowDecodeError(key);
  return row[key] as boolean;
}

function nullableBoolean(row: Record<string, unknown>, key: string): boolean | null {
  if (row[key] === null || row[key] === undefined) return null;
  return boolean(row, key);
}

function date(row: Record<string, unknown>, key: string): Date {
  const value = row[key];
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new RuntimeRowDecodeError(key);
  return value;
}

function nullableDate(row: Record<string, unknown>, key: string): Date | null {
  if (row[key] === null || row[key] === undefined) return null;
  return date(row, key);
}

function enumeration<T extends string>(
  row: Record<string, unknown>,
  key: string,
  values: readonly T[],
): T {
  const value = row[key];
  if (typeof value !== "string" || !values.includes(value as T)) throw new RuntimeRowDecodeError(key);
  return value as T;
}

function nullableEnumeration<T extends string>(
  row: Record<string, unknown>,
  key: string,
  values: readonly T[],
): T | null {
  if (row[key] === null || row[key] === undefined) return null;
  return enumeration(row, key, values);
}

function jsonArray(row: Record<string, unknown>, key: string): unknown[] {
  const value = row[key];
  if (!Array.isArray(value)) throw new RuntimeRowDecodeError(key);
  return value;
}

function providerRefs(row: Record<string, unknown>): ProviderRef[] {
  return jsonArray(row, "provider_refs").map((entry) => {
    const value = record(entry);
    return {
      provider_id: requiredString(value, "provider_id"),
      credential_generation: requiredString(value, "credential_generation"),
      credential_version: integer(value, "credential_version"),
    };
  });
}

function skillRefs(row: Record<string, unknown>): SkillRef[] {
  return jsonArray(row, "skill_refs").map((entry) => {
    const value = record(entry);
    return {
      skill_id: requiredString(value, "skill_id"),
      current_version_id: nullableString(value, "current_version_id"),
    };
  });
}

function mcpRefs(row: Record<string, unknown>): McpRef[] {
  return jsonArray(row, "mcp_refs").map((entry) => {
    const value = record(entry);
    return {
      account_id: requiredString(value, "account_id"),
      credential_generation: requiredString(value, "credential_generation"),
    };
  });
}

function positiveInteger(row: Record<string, unknown>, key: string): number {
  const value = integer(row, key);
  if (value < 1) throw new RuntimeRowDecodeError(key);
  return value;
}

function encryptedRuntimeV3Material(
  row: Record<string, unknown>,
): RuntimeV3EncryptedMaterial {
  return {
    credential_generation: requiredString(row, "credential_generation"),
    credential_version: positiveInteger(row, "credential_version"),
    ciphertext: requiredString(row, "ciphertext"),
    iv: requiredString(row, "iv"),
    auth_tag: requiredString(row, "auth_tag"),
    wrapped_dek: requiredString(row, "wrapped_dek"),
    wrap_iv: requiredString(row, "wrap_iv"),
    wrap_auth_tag: requiredString(row, "wrap_auth_tag"),
    key_id: requiredString(row, "key_id"),
  };
}

/** Decode the JSONB snapshot before it enters the Runtime v3 preparation claim. */
export function decodeRuntimeV3PreparationSnapshot(
  value: unknown,
): RuntimeV3PreparationSnapshot {
  const row = record(value);
  return {
    providerRefs: providerRefs(row),
    skillRefs: skillRefs(row),
    mcpRefs: jsonArray(row, "mcp_refs").map((entry) => {
      const ref = record(entry);
      return {
        account_id: requiredString(ref, "account_id"),
        credential_generation: requiredString(ref, "credential_generation"),
        credential_version: positiveInteger(ref, "credential_version"),
      };
    }),
    providerMaterial: jsonArray(row, "provider_material").map((entry) => {
      const material = record(entry);
      return {
        provider_id: requiredString(material, "provider_id"),
        auth_method: requiredString(material, "auth_method"),
        ...encryptedRuntimeV3Material(material),
      };
    }),
    skillMaterial: jsonArray(row, "skill_material").map((entry) => {
      const material = record(entry);
      return {
        skill_id: requiredString(material, "skill_id"),
        slug: requiredString(material, "slug"),
        version_id: requiredString(material, "version_id"),
        version: requiredString(material, "version"),
        checksum: requiredString(material, "checksum"),
        size_bytes: positiveInteger(material, "size_bytes"),
        storage_path: requiredString(material, "storage_path"),
      };
    }),
    mcpMaterial: jsonArray(row, "mcp_material").map((entry) => {
      const material = record(entry);
      const accountConfig = companionMcpAccountSchema.safeParse(material.account_config);
      if (!accountConfig.success) throw new RuntimeRowDecodeError("account_config");
      return {
        account_id: requiredString(material, "account_id"),
        owner_id: requiredString(material, "owner_id"),
        provider: requiredString(material, "provider"),
        label: requiredString(material, "label"),
        transport: requiredString(material, "transport"),
        account_config: accountConfig.data,
        ...encryptedRuntimeV3Material(material),
      };
    }),
    configCatalog: decodeRuntimeV3ConfigCatalog(row),
  };
}

function decodeRuntimeV3ConfigCatalog(
  row: Record<string, unknown>,
): RuntimeConfigCatalog | null {
  if (row.config_catalog === null) return null;
  const catalog = record(row.config_catalog);
  const companion = record(catalog.companion);
  return {
    companion: {
      model_id: nullableString(companion, "model_id"),
      provider_id: nullableString(companion, "provider_id"),
      persona: nullableString(companion, "persona"),
    },
    skills: jsonArray(catalog, "skills").map((entry) => {
      const skill = record(entry);
      return {
        id: requiredString(skill, "id"),
        slug: requiredString(skill, "slug"),
        name: requiredString(skill, "name"),
        description: requiredString(skill, "description"),
        selected: boolean(skill, "selected"),
      };
    }),
    plugins: jsonArray(catalog, "plugins").map((entry) => {
      const plugin = record(entry);
      return {
        id: requiredString(plugin, "id"),
        label: requiredString(plugin, "label"),
        provider: requiredString(plugin, "provider"),
        transport: requiredString(plugin, "transport"),
        selected: boolean(plugin, "selected"),
      };
    }),
    note: requiredString(catalog, "note"),
  };
}

export function decodeGateStatusRow(value: unknown): GateStatus {
  const row = record(value);
  return {
    enabled: boolean(row, "enabled"),
    gateEpoch: bigintText(row, "gate_epoch"),
    updatedAt: date(row, "updated_at"),
  };
}

export function decodeRuntimeClaimRow(value: unknown): RuntimeClaim {
  const row = record(value);
  const workKind = enumeration(row, "work_kind", WORK_KINDS);
  const base: RuntimeClaimBase = {
    orgId: uuid(row, "org_id"),
    companionId: uuid(row, "companion_id"),
    claimToken: uuid(row, "claim_token"),
    claimEpoch: bigintText(row, "claim_epoch"),
    gateEpoch: bigintText(row, "gate_epoch"),
    workKind,
    workId: uuid(row, "work_id"),
    actorId: nullableString(row, "actor_id"),
    clientSurface: nullableEnumeration(row, "client_surface", CLIENT_SURFACES),
    runtimeGeneration: bigintText(row, "runtime_generation"),
    checkpoint: requiredString(row, "checkpoint"),
    checkpointSequence: bigintText(row, "checkpoint_sequence"),
    turnId: nullableUuid(row, "turn_id"),
    turnStatus: nullableEnumeration(row, "turn_status", TURN_STATUSES),
    attemptStatus: nullableEnumeration(row, "attempt_status", TURN_STATUSES.filter((s) => s !== "queued") as AttemptStatus[]),
    dispatchState: nullableEnumeration(row, "dispatch_state", DISPATCH_STATES),
    eventCursor: nullableBigintText(row, "event_cursor"),
    unknownEventCount: nullableInteger(row, "unknown_event_count"),
    malformedEventCount: nullableInteger(row, "malformed_event_count"),
    oversizedEventCount: nullableInteger(row, "oversized_event_count"),
    coldStartDeadlineAt: nullableDate(row, "cold_start_deadline_at"),
    inactivityDeadlineAt: nullableDate(row, "inactivity_deadline_at"),
    absoluteDeadlineAt: nullableDate(row, "absolute_deadline_at"),
    operationKind: nullableEnumeration(row, "operation_kind", OPERATION_KINDS),
    operationStartedAt: nullableDate(row, "operation_started_at"),
    operationAttemptCount: nullableInteger(row, "operation_attempt_count"),
    providerOperationId: nullableString(row, "provider_operation_id"),
    targetSettingsRevision: nullableBigintText(row, "target_settings_revision"),
    targetSkillsRevision: nullableInteger(row, "target_skills_revision"),
    decisionStatus: nullableEnumeration(row, "decision_status", DECISION_STATUSES),
    decisionDeliveryState: nullableEnumeration(row, "decision_delivery_state", DECISION_DELIVERY_STATES),
  };

  switch (workKind) {
    case "operation":
      if (
        !base.actorId
        || !base.operationKind
        || !base.operationStartedAt
        || base.operationAttemptCount === null
      ) {
        throw new RuntimeRowDecodeError("operation", "operation claim has an impossible nullable shape");
      }
      if (base.operationKind === "restart_pi"
        && base.clientSurface === null
        && base.targetSettingsRevision === null
        && base.targetSkillsRevision === null) {
        return base as OperationRuntimeClaim;
      }
      if (base.operationKind === "stop") {
        if (
          base.clientSurface !== null
          || base.targetSettingsRevision !== null
          || base.targetSkillsRevision === null
        ) {
          throw new RuntimeRowDecodeError("operation", "control operation contains resource snapshot data");
        }
      } else if (base.operationKind === "delete") {
        if (
          base.clientSurface !== null
          || base.targetSettingsRevision !== null
          || base.targetSkillsRevision !== null
        ) throw new RuntimeRowDecodeError("operation", "delete operation contains resource data");
      } else if (
        base.clientSurface === null
        || base.targetSettingsRevision === null
        || base.targetSkillsRevision === null
      ) {
        throw new RuntimeRowDecodeError("operation", "resource operation lacks its captured snapshot");
      }
      return base as OperationRuntimeClaim;
    case "decision":
      if (!base.turnId || !base.decisionStatus || !base.decisionDeliveryState) {
        throw new RuntimeRowDecodeError("decision", "decision claim has an impossible nullable shape");
      }
      return base as DecisionRuntimeClaim;
    case "attempt":
      if (
        !base.actorId
        || !base.clientSurface
        || !base.turnId
        || !base.attemptStatus
        || !base.dispatchState
        || base.eventCursor === null
        || base.unknownEventCount === null
        || base.malformedEventCount === null
        || base.oversizedEventCount === null
        || !base.absoluteDeadlineAt
      ) {
        throw new RuntimeRowDecodeError("attempt", "attempt claim has an impossible nullable shape");
      }
      return base as AttemptRuntimeClaim;
    case "settings":
      if (
        !base.actorId
        || !base.clientSurface
        || base.targetSettingsRevision === null
        || base.targetSkillsRevision === null
      ) {
        throw new RuntimeRowDecodeError("settings", "settings claim has an impossible nullable shape");
      }
      return base as SettingsRuntimeClaim;
    case "health":
      if (base.actorId !== null || base.clientSurface !== null || base.turnId !== null || base.operationKind !== null) {
        throw new RuntimeRowDecodeError("health", "health claim contains actor or work payload data");
      }
      return base as HealthRuntimeClaim;
  }
}

export function decodeRuntimeAuthorizationRow(
  value: unknown,
  expectedWorkKind: WorkKind,
): RuntimeAuthorization {
  const row = record(value);
  const authorization: RuntimeAuthorization = {
    authorized: boolean(row, "authorized"),
    denialCode: nullableString(row, "denial_code"),
    leaseExpiresAt: date(row, "lease_expires_at"),
    authorizationActorId: nullableString(row, "authorization_actor_id"),
    decisionActorId: nullableString(row, "decision_actor_id"),
    clientSurface: nullableEnumeration(row, "client_surface", CLIENT_SURFACES),
    runtimeGeneration: nullableBigintText(row, "runtime_generation"),
    boxId: nullableString(row, "box_id"),
    boxState: nullableEnumeration(row, "box_state", BOX_OBSERVED_STATES),
    piState: nullableEnumeration(row, "pi_state", PI_OBSERVED_STATES),
    piInvocationId: nullableString(row, "pi_invocation_id"),
    diskLayoutVersion: nullableInteger(row, "disk_layout_version"),
    appliedSettingsRevision: nullableBigintText(row, "applied_settings_revision"),
    appliedSkillsRevision: nullableInteger(row, "applied_skills_revision"),
    modelId: nullableString(row, "model_id"),
    persona: nullableString(row, "persona"),
    canWriteSkills: nullableBoolean(row, "can_write_skills"),
    providerRefs: providerRefs(row),
    skillRefs: skillRefs(row),
    mcpRefs: mcpRefs(row),
    desiredSettingsRevision: nullableBigintText(row, "desired_settings_revision"),
    skillsRevision: nullableInteger(row, "skills_revision"),
    workCheckpoint: requiredString(row, "work_checkpoint"),
    workCheckpointSequence: bigintText(row, "work_checkpoint_sequence"),
    turnId: nullableUuid(row, "turn_id"),
    turnStatus: nullableEnumeration(row, "turn_status", TURN_STATUSES),
    attemptStatus: nullableEnumeration(row, "attempt_status", TURN_STATUSES.filter((s) => s !== "queued") as AttemptStatus[]),
    dispatchState: nullableEnumeration(row, "dispatch_state", DISPATCH_STATES),
    eventCursor: nullableBigintText(row, "event_cursor"),
    unknownEventCount: nullableInteger(row, "unknown_event_count"),
    malformedEventCount: nullableInteger(row, "malformed_event_count"),
    oversizedEventCount: nullableInteger(row, "oversized_event_count"),
    coldStartDeadlineAt: nullableDate(row, "cold_start_deadline_at"),
    inactivityDeadlineAt: nullableDate(row, "inactivity_deadline_at"),
    absoluteDeadlineAt: nullableDate(row, "absolute_deadline_at"),
    operationKind: nullableEnumeration(row, "operation_kind", OPERATION_KINDS),
    operationStartedAt: nullableDate(row, "operation_started_at"),
    operationAttemptCount: nullableInteger(row, "operation_attempt_count"),
    operationTrigger: nullableEnumeration(row, "operation_trigger", OPERATION_TRIGGERS),
    operationLane: nullableEnumeration(row, "operation_lane", OPERATION_LANES),
    sourceDispatchState: nullableEnumeration(row, "source_dispatch_state", DISPATCH_STATES),
    sourcePiInvocationId: nullableString(row, "source_pi_invocation_id"),
    providerOperationId: nullableString(row, "provider_operation_id"),
    targetSettingsRevision: nullableBigintText(row, "target_settings_revision"),
    targetSkillsRevision: nullableInteger(row, "target_skills_revision"),
    decisionStatus: nullableEnumeration(row, "decision_status", DECISION_STATUSES),
    decisionDeliveryState: nullableEnumeration(row, "decision_delivery_state", DECISION_DELIVERY_STATES),
    decisionRequestKey: nullableString(row, "decision_request_key"),
    decisionResponseText: nullableString(row, "decision_response_text"),
    commandId: nullableUuid(row, "command_id"),
    commandPiInvocationId: nullableString(row, "command_pi_invocation_id"),
  };

  if (authorization.boxId !== null && !BOX_ID.test(authorization.boxId)) {
    throw new RuntimeRowDecodeError("box_id");
  }
  if (authorization.authorized === (authorization.denialCode !== null)) {
    throw new RuntimeRowDecodeError("denial_code", "authorization discriminator is inconsistent");
  }
  if (authorization.denialCode !== null && !STABLE_TEXT.test(authorization.denialCode)) {
    throw new RuntimeRowDecodeError("denial_code");
  }
  if (!STABLE_TEXT.test(authorization.workCheckpoint)) {
    throw new RuntimeRowDecodeError("work_checkpoint");
  }
  if (expectedWorkKind === "health") {
    if (
      authorization.authorizationActorId !== null
      || authorization.decisionActorId !== null
      || authorization.clientSurface !== null
      || authorization.providerRefs.length > 0
      || authorization.skillRefs.length > 0
      || authorization.mcpRefs.length > 0
    ) {
      throw new RuntimeRowDecodeError("health", "health authorization contains actor or resource data");
    }
  }
  if (authorization.authorized) {
    if (authorization.runtimeGeneration === null) {
      throw new RuntimeRowDecodeError("runtime_generation");
    }
    const recoveryCleanup = expectedWorkKind === "operation"
      && authorization.operationKind === "restart_pi"
      && authorization.operationTrigger === "recovery";
    const resourceBearing = expectedWorkKind === "attempt"
      || expectedWorkKind === "decision"
      || expectedWorkKind === "settings"
      || (expectedWorkKind === "operation"
        && authorization.operationKind !== null
        && ["start", "restart_pi", "restart_box", "apply_settings"].includes(authorization.operationKind)
        && !recoveryCleanup);
    if (
      resourceBearing
      && (
        authorization.modelId === null
        || authorization.desiredSettingsRevision === null
        || authorization.skillsRevision === null
      )
    ) {
      throw new RuntimeRowDecodeError("resources", "authorized resource work lacks model or revisions");
    }
    switch (expectedWorkKind) {
      case "operation": {
        if (
          authorization.operationKind === null
          || authorization.operationStartedAt === null
          || authorization.operationAttemptCount === null
        ) {
          throw new RuntimeRowDecodeError("operation", "authorized operation lacks its durable identity");
        }
        if (recoveryCleanup) {
          if (
            authorization.operationLane === null
            || authorization.turnId === null
            || authorization.turnStatus !== "interrupted"
            || authorization.clientSurface !== null
            || authorization.authorizationActorId !== null
            || authorization.modelId !== null
            || authorization.desiredSettingsRevision !== null
            || authorization.skillsRevision !== null
            || authorization.providerRefs.length > 0
            || authorization.skillRefs.length > 0
            || authorization.mcpRefs.length > 0
          ) {
            throw new RuntimeRowDecodeError(
              "operation",
              "authorized recovery cleanup contains actor or resource data",
            );
          }
          break;
        }
        if (authorization.authorizationActorId === null) {
          throw new RuntimeRowDecodeError("operation", "authorized operation lacks its actor");
        }
        const resourceOperation = ["start", "restart_pi", "restart_box", "apply_settings"]
          .includes(authorization.operationKind);
        if (resourceOperation) {
          if (
            authorization.clientSurface === null
            || authorization.targetSettingsRevision === null
            || authorization.targetSkillsRevision === null
          ) {
            throw new RuntimeRowDecodeError("operation", "authorized operation lacks its captured snapshot");
          }
        } else if (authorization.operationKind === "stop") {
          if (
            authorization.clientSurface !== null
            || authorization.targetSettingsRevision !== null
            || authorization.targetSkillsRevision === null
          ) throw new RuntimeRowDecodeError("operation", "authorized stop lacks its Skill snapshot");
        } else if (
          authorization.clientSurface !== null
          || authorization.targetSettingsRevision !== null
          || authorization.targetSkillsRevision !== null
        ) {
          throw new RuntimeRowDecodeError("operation", "control operation contains resource snapshot data");
        }
        break;
      }
      case "attempt":
        if (
          authorization.authorizationActorId === null
          || authorization.clientSurface === null
          || authorization.turnId === null
          || authorization.turnStatus === null
          || authorization.attemptStatus === null
          || authorization.dispatchState === null
          || authorization.eventCursor === null
          || authorization.unknownEventCount === null
          || authorization.malformedEventCount === null
          || authorization.oversizedEventCount === null
          || authorization.absoluteDeadlineAt === null
          || authorization.operationKind !== null
        ) {
          throw new RuntimeRowDecodeError("attempt", "authorized attempt has an impossible nullable shape");
        }
        break;
      case "decision":
        if (
          authorization.authorizationActorId === null
          || authorization.clientSurface === null
          || authorization.turnId === null
          || authorization.turnStatus === null
          || authorization.attemptStatus === null
          || authorization.dispatchState === null
          || authorization.eventCursor === null
          || authorization.unknownEventCount === null
          || authorization.malformedEventCount === null
          || authorization.oversizedEventCount === null
          || authorization.absoluteDeadlineAt === null
          || authorization.decisionStatus === null
          || authorization.decisionDeliveryState === null
          || authorization.decisionRequestKey === null
          || authorization.operationKind !== null
        ) {
          throw new RuntimeRowDecodeError("decision", "authorized decision has an impossible nullable shape");
        }
        break;
      case "settings":
        if (
          authorization.authorizationActorId === null
          || authorization.clientSurface === null
          || authorization.operationKind !== null
        ) {
          throw new RuntimeRowDecodeError("settings", "authorized settings work has an impossible nullable shape");
        }
        break;
      case "health":
        break;
    }
  }
  return authorization;
}
