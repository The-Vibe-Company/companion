/* oxlint-disable anti-slop/no-known-value-widening, anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/no-unsafe-dictionary-type, anti-slop/require-safety-comment-for-type-assertion -- Existing PostgreSQL row decoder predates the incremental anti-slop gate. */

import {
  decodeGateStatusRow,
  decodeRuntimeAuthorizationRow,
  decodeRuntimeClaimRow,
  RuntimeRowDecodeError,
  type GateStatus,
  type ClientSurface,
  type DuplicateCleanup,
  type DuplicateCleanupStatus,
  type LeaseFence,
  type RuntimeAuthorization,
  type RuntimeCheckpointInput,
  type RuntimeClaim,
  type RuntimeObservationInput,
  type RuntimeAttachment,
  type RuntimeOutputAttachment,
  type RuntimeSettlementInput,
  type RuntimeConfigCatalog,
  type RuntimeWorkMaterial,
  type RuntimeSkillUpdateMaterial,
} from "./types";
import {
  COMPANION_ATTACHMENT_FILENAME_PATTERN,
  COMPANION_ATTACHMENT_MAX_BYTES,
  COMPANION_ATTACHMENT_MIME_TYPES,
  COMPANION_BUDGETS_BASE,
  COMPANION_MESSAGE_ATTACHMENT_MAX_COUNT,
} from "@companion/contracts";
import type { RuntimePiProjection } from "./piEvents";

export const RUNTIME_LEASE_SECONDS = COMPANION_BUDGETS_BASE.leaseSeconds;

export interface RuntimeRecoveryMetrics {
  pendingCount: number;
  oldestAgeSeconds: number | null;
  autoAbandonedCount: number;
  stalledCount: number;
  maxAttemptCount: number;
}

export interface RuntimeStore {
  ping(): Promise<void>;
  gateStatus(): Promise<GateStatus>;
  /** Aggregate-only recovery telemetry; optional for test doubles and alternate local stores. */
  recoveryMetrics?(): Promise<RuntimeRecoveryMetrics>;
  disable(expectedGateEpoch: bigint, actorId: string): Promise<GateStatus>;
  claimWork(input: {
    executorId: string;
    limit: number;
    leaseSeconds: typeof RUNTIME_LEASE_SECONDS;
    gateEpoch: bigint;
  }): Promise<RuntimeClaim[]>;
  renewAndAuthorize(
    fence: LeaseFence,
    leaseSeconds: typeof RUNTIME_LEASE_SECONDS,
  ): Promise<RuntimeAuthorization | null>;
  checkpoint(fence: LeaseFence, input: RuntimeCheckpointInput): Promise<bigint | null>;
  observeInstance(fence: LeaseFence, input: RuntimeObservationInput): Promise<bigint | null>;
  getMaterial(
    fence: LeaseFence,
    leaseSeconds: typeof RUNTIME_LEASE_SECONDS,
  ): Promise<RuntimeWorkMaterial | null>;
  prepareRoutineRun(fence: LeaseFence): Promise<{
    id: string;
    sha256: string;
    content: string;
  } | false | null>;
  getSkillUpdateMaterial(
    fence: LeaseFence,
    leaseSeconds: typeof RUNTIME_LEASE_SECONDS,
  ): Promise<RuntimeSkillUpdateMaterial | null>;
  commitSkillUpdate(fence: LeaseFence, input: RuntimeSkillUpdateMaterial & {
    skillsDigest: string;
  }): Promise<true | null>;
  recordSkillUpdateError(fence: LeaseFence, input: {
    code: string;
    message: string;
  }): Promise<true | null>;
  getConfigCatalog(
    fence: LeaseFence,
    leaseSeconds: typeof RUNTIME_LEASE_SECONDS,
  ): Promise<RuntimeConfigCatalog | null>;
  mintHubToken(
    fence: LeaseFence,
    leaseSeconds: typeof RUNTIME_LEASE_SECONDS,
  ): Promise<{ token: string; expiresAt: Date } | null>;
  mintMcpBrokerToken(
    fence: LeaseFence,
    leaseSeconds: typeof RUNTIME_LEASE_SECONDS,
  ): Promise<{ token: string; expiresAt: Date } | null>;
  mintControlToken(
    fence: LeaseFence,
    leaseSeconds: typeof RUNTIME_LEASE_SECONDS,
  ): Promise<{ token: string; expiresAt: Date } | null>;
  recordMaterialSnapshot(fence: LeaseFence, input: {
    clientSurface: ClientSurface;
    materialExpiresAt: Date | null;
    /** Ciphertext-only hosted agent endpoint; absent while the direct-transport gate is off. */
    agentEndpoint?: { hostedUrl: string; tokenCiphertext: string } | null;
  }): Promise<true | null>;
  publishMaterialSnapshot(fence: LeaseFence, input: {
    piInvocationId: string;
  }): Promise<true | null>;
  getAttemptTerminalProjection(fence: LeaseFence): Promise<{
    checkpoint: "agent_settled" | "process_exited";
    eventCursor: bigint;
    hasVisibleOutput: boolean;
    /** True once this attempt's outbox harvest committed, so a takeover does not repeat it. */
    outputsHarvested: boolean;
  } | null>;
  /**
   * Record what Pi left in its outbox, atomically with the durable fact that the harvest happened.
   * Returns null when the fence is stale; the caller abandons rather than settling from stale state.
   */
  recordAttemptOutputs(fence: LeaseFence, input: {
    attachments: RuntimeOutputAttachment[];
    activityAt: Date;
  }): Promise<{ recorded: number; hasVisibleOutput: boolean } | null>;
  projectEventBatch(fence: LeaseFence, input: {
    expectedSequence: bigint;
    piInvocationId: string;
    events: RuntimePiProjection[];
    throughCursor: bigint;
    activityAt?: Date;
    unknownEventCount: number;
    malformedEventCount: number;
    oversizedEventCount: number;
  }): Promise<{
    checkpointSequence: bigint;
    eventCursor: bigint;
    hasVisibleOutput: boolean;
    routineReturned: boolean;
  } | null>;
  registerDuplicateCleanups(fence: LeaseFence, boxIds: string[]): Promise<DuplicateCleanup[]>;
  checkpointDuplicateCleanup(fence: LeaseFence, input: {
    boxId: string;
    expectedSequence: bigint;
    nextStatus: DuplicateCleanupStatus;
    providerOperationId?: string;
  }): Promise<DuplicateCleanup | null>;
  settle(fence: LeaseFence, input: RuntimeSettlementInput): Promise<boolean>;
  deferDelete(fence: LeaseFence): Promise<boolean>;
  release(fence: LeaseFence): Promise<boolean>;
}

/** Structural subset of `postgres.Sql`; useful for tests and avoids owning connection lifecycle. */
export type RuntimeSqlRow = RuntimeWorkMaterial["providerMaterial"][number];
type RuntimeSqlValue = RuntimeSqlRow[keyof RuntimeSqlRow];

interface RuntimeEphemeralToken {
  token: string;
  expiresAt: Date;
}

interface RuntimeAttemptTerminalProjection {
  checkpoint: "agent_settled" | "process_exited";
  eventCursor: bigint;
  hasVisibleOutput: boolean;
  outputsHarvested: boolean;
}

export interface RuntimeSqlClient {
  unsafe<T extends RuntimeSqlRow[]>(query: string, parameters?: unknown[]): Promise<T>;
}

export class RuntimeStoreSerializationError extends Error {
  constructor(cause?: unknown) {
    super("Runtime database serialization conflict", cause === undefined ? undefined : { cause });
    this.name = "RuntimeStoreSerializationError";
  }
}

export class RuntimeStoreContractError extends Error {
  constructor() {
    super("Runtime database contract rejected an operation");
    this.name = "RuntimeStoreContractError";
  }
}

export class RuntimeCredentialSnapshotChangedError extends Error {
  constructor() {
    super("Runtime credentials changed after Pi accepted the turn");
    this.name = "RuntimeCredentialSnapshotChangedError";
  }
}

/**
 * The database connection disappeared while invoking a mutating definer. The
 * transaction may have committed even though no result reached this process,
 * so callers must abandon the local fence and let a later claim inspect the
 * durable checkpoint. Retrying or settling from stale in-memory state is not
 * safe.
 */
export class RuntimeStoreIndeterminateError extends Error {
  constructor(cause?: unknown) {
    super(
      "Runtime database mutation outcome is indeterminate",
      cause === undefined ? undefined : { cause },
    );
    this.name = "RuntimeStoreIndeterminateError";
  }
}

function sqlState(error: RuntimeSqlValue): string | undefined {
  const row = objectValue(error);
  return row === null ? undefined : stringValue(row.code) ?? undefined;
}

async function mapped<T>(operation: () => Promise<T>, mutating = false): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (
      error instanceof RuntimeStoreSerializationError
      || error instanceof RuntimeStoreContractError
      || error instanceof RuntimeStoreIndeterminateError
      || error instanceof RuntimeCredentialSnapshotChangedError
      || error instanceof RuntimeRowDecodeError
    ) throw error;
    if (sqlState(error) === "40001") throw new RuntimeStoreSerializationError(error);
    if (sqlState(error) === "22023") throw new RuntimeStoreContractError();
    if (mutating) throw new RuntimeStoreIndeterminateError(error);
    throw error;
  }
}

function one(rows: RuntimeSqlRow[], _name: string): RuntimeSqlRow {
  if (rows.length !== 1 || !rows[0]) throw new RuntimeStoreContractError();
  return rows[0];
}

function nullableBigintResult(rows: RuntimeSqlRow[], key: string): bigint | null {
  const row = one(rows, key);
  const value = stringValue(row[key]);
  if (value === null) return null;
  if (!/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new RuntimeStoreContractError();
  }
  return BigInt(value);
}

function booleanResult(rows: RuntimeSqlRow[], key: string): boolean {
  const value = booleanValue(one(rows, key)[key]);
  if (value === null) throw new RuntimeStoreContractError();
  return value;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MESSAGE_EVENT_ID_PATTERN = /^msg:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const BOX_ID_PATTERN = /^bx_[23456789abcdefghjkmnpqrstuvwxyz]{8}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const ATTACHMENT_STORAGE_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9/._-]{0,511}$/;
/**
 * The decode boundary enforces the contract's own bounds rather than a copy of them: the runtime
 * writes these names into Box paths and into the prompt that tells Pi where to find them, so the
 * check has to be the same rule the API and the database CHECK apply, not a second one that can drift.
 */
const ATTACHMENT_CONTENT_TYPES = new Set<string>(COMPANION_ATTACHMENT_MIME_TYPES);

function stringValue(value: RuntimeSqlValue): string | null {
  const text = String(value);
  return value === text ? text : null;
}

function booleanValue(value: RuntimeSqlValue): boolean | null {
  if (value === true) return true;
  if (value === false) return false;
  return null;
}

function numberValue(value: RuntimeSqlValue): number | null {
  return Number.isSafeInteger(value) ? Number(value) : null;
}

function nonnegativeFiniteNumber(value: RuntimeSqlValue): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function arrayValue(value: RuntimeSqlValue): RuntimeSqlValue[] | null {
  return Array.isArray(value) ? value : null;
}

function objectValue(value: RuntimeSqlValue): RuntimeSqlRow | null {
  if (!value || Array.isArray(value) || Object.prototype.toString.call(value) !== "[object Object]") {
    return null;
  }
  // SAFETY: The object-tag check above excludes primitives and arrays at this SQL JSON boundary.
  return value as RuntimeSqlRow;
}

function nullableText(row: RuntimeSqlRow, key: string): string | null {
  const raw = row[key];
  if (raw === null) return null;
  const value = stringValue(raw);
  if (value === null || /[\r\n]/.test(value) || value.length === 0) {
    throw new RuntimeStoreContractError();
  }
  return value;
}

function nullableUuidText(row: RuntimeSqlRow, key: string): string | null {
  const value = nullableText(row, key);
  if (value !== null && !UUID_PATTERN.test(value)) throw new RuntimeStoreContractError();
  return value;
}

function objectArray(row: RuntimeSqlRow, key: string): RuntimeSqlRow[] {
  const value = arrayValue(row[key]);
  if (value === null) {
    throw new RuntimeStoreContractError();
  }
  const objects: RuntimeSqlRow[] = [];
  for (const entry of value) {
    const object = objectValue(entry);
    if (object === null) throw new RuntimeStoreContractError();
    objects.push(object);
  }
  return objects;
}

/**
 * Decode the staging list. Every bound the database already enforces is re-checked here, because the
 * runtime writes these names into Box paths and into the prompt that tells Pi where to find them:
 * whatever crosses that boundary is validated on this side of it too, not merely trusted.
 */
function decodeAttachments(row: RuntimeSqlRow): RuntimeAttachment[] {
  const value = arrayValue(row.attachments);
  if (value === null || value.length > COMPANION_MESSAGE_ATTACHMENT_MAX_COUNT) {
    throw new RuntimeStoreContractError();
  }
  return value.map((entry, index) => {
    const attachment = objectValue(entry);
    if (attachment === null) throw new RuntimeStoreContractError();
    const id = nullableUuidText(attachment, "id");
    const storageKey = nullableText(attachment, "storage_key");
    const contentType = nullableText(attachment, "content_type");
    const sha256 = nullableText(attachment, "sha256");
    const filename = nullableText(attachment, "filename");
    const byteSize = numberValue(attachment.byte_size);
    const position = numberValue(attachment.position);
    if (
      id === null
      || storageKey === null
      || !ATTACHMENT_STORAGE_KEY_PATTERN.test(storageKey)
      || contentType === null
      || !ATTACHMENT_CONTENT_TYPES.has(contentType)
      || sha256 === null
      || !SHA256_PATTERN.test(sha256)
      || filename === null
      || !COMPANION_ATTACHMENT_FILENAME_PATTERN.test(filename)
      || byteSize === null
      || byteSize < 1
      || byteSize > COMPANION_ATTACHMENT_MAX_BYTES
      || position !== index
    ) throw new RuntimeStoreContractError();
    return {
      id,
      storageKey,
      contentType,
      byteSize,
      sha256,
      filename,
      position: index,
    };
  });
}

/**
 * Decode the hosted agent endpoint columns, enforcing the database's all-or-nothing CHECK on this
 * side of the boundary too: half an endpoint is a contract violation, never a partial credential.
 */
function decodeAgentEndpoint(row: RuntimeSqlRow): RuntimeWorkMaterial["agentEndpoint"] {
  const hostedUrl = nullableText(row, "agent_hosted_url");
  const tokenCiphertext = nullableText(row, "agent_token_ciphertext");
  const observedAt = row.agent_observed_at;
  if (hostedUrl === null && tokenCiphertext === null && observedAt === null) return null;
  if (
    hostedUrl === null
    || hostedUrl.length > 2_048
    || tokenCiphertext === null
    || tokenCiphertext.length > 8_192
    || !(observedAt instanceof Date)
    || !Number.isFinite(observedAt.getTime())
  ) {
    throw new RuntimeStoreContractError();
  }
  return { hostedUrl, tokenCiphertext, observedAt };
}

function decodeMaterial(row: RuntimeSqlRow): RuntimeWorkMaterial {
  const credentialSnapshotMatches = booleanValue(row.credential_snapshot_matches);
  if (credentialSnapshotMatches === null) {
    throw new RuntimeStoreContractError();
  }
  if (!credentialSnapshotMatches) {
    throw new RuntimeCredentialSnapshotChangedError();
  }
  const rawPrompt = row.prompt_text;
  let prompt = rawPrompt === null ? null : stringValue(rawPrompt);
  if (rawPrompt !== null && (prompt === null || prompt.length > 1_000_000)) {
    throw new RuntimeStoreContractError();
  }
  const rawRelaySource = row.relay_source_content;
  const relaySource = rawRelaySource === null ? null : stringValue(rawRelaySource);
  if (rawRelaySource !== null && (relaySource === null || relaySource.length > 16_384)) {
    throw new RuntimeStoreContractError();
  }
  if (relaySource !== null) {
    prompt = `${prompt ?? "Respond to the surfaced routine entry."}\n\n`
      + "--- Surfaced routine entry (main conversation) ---\n"
      + `${relaySource}\n--- End surfaced routine entry ---`;
  }
  const requestKind = row.decision_request_kind;
  if (
    requestKind !== null
    && requestKind !== "question"
    && requestKind !== "confirmation"
    && requestKind !== "config_proposal"
    && requestKind !== "routine_proposal"
    && requestKind !== "trigger_proposal"
  ) {
    throw new RuntimeStoreContractError();
  }
  const rawDecisionPayload = row.decision_response_payload;
  const decisionPayload = rawDecisionPayload === null ? null : objectValue(rawDecisionPayload);
  if (rawDecisionPayload !== null && decisionPayload === null) throw new RuntimeStoreContractError();
  const rawModelInput = row.model_input;
  const modelInput: RuntimeWorkMaterial["modelInput"] = [];
  if (rawModelInput !== null) {
    const modelInputValues = arrayValue(rawModelInput);
    if (modelInputValues === null) throw new RuntimeStoreContractError();
    for (const item of modelInputValues) {
      if (item === "text") modelInput.push("text");
      else if (item === "image") modelInput.push("image");
      else throw new RuntimeStoreContractError();
    }
  }
  const hasVisibleOutput = booleanValue(row.has_visible_output);
  if (hasVisibleOutput === null) throw new RuntimeStoreContractError();
  const messageEventId = nullableText(row, "message_event_id");
  if (messageEventId !== null && !MESSAGE_EVENT_ID_PATTERN.test(messageEventId)) {
    throw new RuntimeStoreContractError();
  }
  const rawTurnStartedAt = row.turn_started_at;
  const turnStartedAt = rawTurnStartedAt === null ? null : rawTurnStartedAt;
  if (
    turnStartedAt !== null
    && (!(turnStartedAt instanceof Date) || !Number.isFinite(turnStartedAt.getTime()))
  ) throw new RuntimeStoreContractError();
  const memberTimezone = nullableText(row, "member_timezone");
  if (memberTimezone !== null) {
    if (memberTimezone.length > 64) throw new RuntimeStoreContractError();
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: memberTimezone }).format(new Date(0));
    } catch {
      throw new RuntimeStoreContractError();
    }
  }
  const routineId = nullableUuidText(row, "routine_snapshot_id");
  const routineName = nullableText(row, "routine_name");
  const triggerName = nullableText(row, "trigger_name");
  const rawTriggerMode = nullableText(row, "trigger_mode");
  const triggerMode = rawTriggerMode === "notify" || rawTriggerMode === "relay"
    ? rawTriggerMode
    : null;
  if ((triggerName === null) !== (triggerMode === null)) throw new RuntimeStoreContractError();
  const routineIsolated = booleanValue(row.routine_isolated);
  if (routineIsolated === null
      || (routineId === null) !== (routineName === null && triggerName === null)) {
    throw new RuntimeStoreContractError();
  }
  const contextId = nullableUuidText(row, "routine_context_id");
  const contextSha256 = nullableText(row, "routine_context_sha256");
  const rawContextContent = row.routine_context_content;
  const contextContent = rawContextContent === null ? null : stringValue(rawContextContent);
  if (
    (contextId === null) !== (contextSha256 === null)
    || (contextId === null) !== (contextContent === null)
    || (contextSha256 !== null && !SHA256_PATTERN.test(contextSha256))
    || (contextContent !== null && Buffer.byteLength(contextContent, "utf8") > 32_768)
    || (routineIsolated && contextId === null)
  ) throw new RuntimeStoreContractError();
  return {
    turnId: nullableUuidText(row, "turn_id"),
    attemptId: nullableUuidText(row, "attempt_id"),
    messageEventId,
    promptText: prompt,
    turnStartedAt,
    memberTimezone,
    routineId,
    routineName,
    triggerName,
    triggerMode,
    routineIsolated,
    routineContext: contextId === null ? null : {
      id: contextId,
      sha256: contextSha256!,
      content: contextContent!,
    },
    decisionRequestKind: requestKind,
    decisionResponsePayload: decisionPayload,
    providerMaterial: objectArray(row, "provider_material"),
    skillMaterial: objectArray(row, "skill_material"),
    mcpMaterial: objectArray(row, "mcp_material"),
    modelInput: rawModelInput === null ? null : modelInput,
    hasVisibleOutput,
    attachments: decodeAttachments(row),
    configCatalog: null,
    boxId: decodeMaterialBoxId(row),
    agentEndpoint: decodeAgentEndpoint(row),
  };
}

function decodeMaterialBoxId(row: RuntimeSqlRow): string | null {
  const boxId = nullableText(row, "box_id");
  if (boxId !== null && !BOX_ID_PATTERN.test(boxId)) throw new RuntimeStoreContractError();
  return boxId;
}

function decodeSkillUpdateMaterial(row: RuntimeSqlRow): RuntimeSkillUpdateMaterial {
  const revision = row.target_skills_revision;
  const requiredRevision = row.required_skills_revision;
  const selected = row.selected_skill_ids;
  const refs = objectArray(row, "skill_refs");
  // SAFETY: Number.isSafeInteger proves both revision values are finite integers before comparison.
  if (
    !Number.isSafeInteger(revision)
    || (revision as number) < 1
    || !Number.isSafeInteger(requiredRevision)
    || (requiredRevision as number) < 1
    || (requiredRevision as number) > (revision as number)
    || !Array.isArray(selected)
    || selected.some((id) => typeof id !== "string" || !UUID_PATTERN.test(id))
  ) throw new RuntimeStoreContractError();
  const skillRefs = refs.map((ref) => {
    const skillId = nullableUuidText(ref, "skill_id");
    const versionId = nullableUuidText(ref, "current_version_id");
    if (skillId === null || versionId === null) throw new RuntimeStoreContractError();
    return { skill_id: skillId, current_version_id: versionId };
  });
  return {
    // SAFETY: The checks above establish the revision bounds and UUID-only selected Skill ids.
    targetSkillsRevision: revision as number,
    requiredSkillsRevision: requiredRevision as number,
    selectedSkillIds: selected as string[],
    skillRefs,
    skillMaterial: objectArray(row, "skill_material"),
  };
}

function decodeConfigCatalog(row: RuntimeSqlRow): RuntimeConfigCatalog {
  const catalog = row.catalog;
  const value = objectValue(catalog);
  if (value === null) throw new RuntimeStoreContractError();
  const companion = value.companion;
  const skills = value.skills;
  const plugins = value.plugins;
  const note = value.note;
  const companionRecord = objectValue(companion);
  const skillValues = arrayValue(skills);
  const pluginValues = arrayValue(plugins);
  const noteText = stringValue(note);
  if (
    companionRecord === null
    || skillValues === null || skillValues.length > 100
    || pluginValues === null || pluginValues.length > 100
    || noteText === null
  ) {
    throw new RuntimeStoreContractError();
  }
  const decodedSkills: RuntimeConfigCatalog["skills"] = [];
  for (const skillValue of skillValues) {
    const skill = objectValue(skillValue);
    const id = skill === null ? null : stringValue(skill.id);
    const slug = skill === null ? null : stringValue(skill.slug);
    const name = skill === null ? null : stringValue(skill.name);
    const description = skill === null ? null : stringValue(skill.description);
    const selected = skill === null ? null : booleanValue(skill.selected);
    if (id === null || slug === null || name === null || description === null || selected === null) {
      throw new RuntimeStoreContractError();
    }
    decodedSkills.push({ id, slug, name, description, selected });
  }
  const decodedPlugins: RuntimeConfigCatalog["plugins"] = [];
  for (const pluginValue of pluginValues) {
    const plugin = objectValue(pluginValue);
    const id = plugin === null ? null : stringValue(plugin.id);
    const label = plugin === null ? null : stringValue(plugin.label);
    const provider = plugin === null ? null : stringValue(plugin.provider);
    const transport = plugin === null ? null : stringValue(plugin.transport);
    const selected = plugin === null ? null : booleanValue(plugin.selected);
    if (id === null || label === null || provider === null || transport === null || selected === null) {
      throw new RuntimeStoreContractError();
    }
    decodedPlugins.push({ id, label, provider, transport, selected });
  }
  return {
    companion: {
      model_id: stringValue(companionRecord.model_id),
      provider_id: stringValue(companionRecord.provider_id),
      persona: stringValue(companionRecord.persona),
    },
    skills: decodedSkills,
    plugins: decodedPlugins,
    note: noteText,
  };
}

function decodeEphemeralToken(
  row: RuntimeSqlRow,
  prefix: "cmp_pat_" | "cmp_mcp_" | "cmp_ctl_",
): RuntimeEphemeralToken {
  const token = row.token;
  const expiresAt = row.expires_at;
  const tokenText = stringValue(token);
  if (
    tokenText === null || !tokenText.startsWith(prefix) || tokenText.length > 80
    || !(expiresAt instanceof Date) || !Number.isFinite(expiresAt.getTime())
  ) {
    throw new RuntimeStoreContractError();
  }
  return { token: tokenText, expiresAt };
}

function decodeAttemptTerminalProjection(row: RuntimeSqlRow): RuntimeAttemptTerminalProjection {
  const checkpoint = row.checkpoint;
  const eventCursor = row.event_cursor;
  const hasVisibleOutput = row.has_visible_output;
  const outputsHarvested = row.outputs_harvested;
  const eventCursorText = stringValue(eventCursor);
  const visible = booleanValue(hasVisibleOutput);
  const harvested = booleanValue(outputsHarvested);
  if (
    (checkpoint !== "agent_settled" && checkpoint !== "process_exited")
    || eventCursorText === null
    || !/^[1-9][0-9]*$/.test(eventCursorText)
    || visible === null
    || harvested === null
  ) throw new RuntimeStoreContractError();
  return { checkpoint, eventCursor: BigInt(eventCursorText), hasVisibleOutput: visible, outputsHarvested: harvested };
}

function duplicateCleanup(row: RuntimeSqlRow): DuplicateCleanup {
  const boxId = row.box_id;
  const status = row.status;
  const sequence = row.checkpoint_sequence;
  const boxIdText = stringValue(boxId);
  const statusText = stringValue(status);
  const sequenceText = stringValue(sequence);
  if (
    boxIdText === null
    || !BOX_ID_PATTERN.test(boxIdText)
    || (
      statusText !== "pending"
      && statusText !== "delete_requested"
      && statusText !== "waiting_deleted"
      && statusText !== "deleted"
      && statusText !== "already_deleted"
      && statusText !== "blocked"
    )
    || sequenceText === null
    || !/^(0|[1-9][0-9]*)$/.test(sequenceText)
  ) throw new RuntimeStoreContractError();
  return {
    boxId: boxIdText,
    status: statusText,
    providerOperationId: nullableText(row, "provider_operation_id"),
    checkpointSequence: BigInt(sequenceText),
  };
}

function fenceParameters(fence: LeaseFence): unknown[] {
  return [
    fence.orgId,
    fence.companionId,
    fence.claimToken,
    fence.claimEpoch.toString(),
    fence.gateEpoch.toString(),
    fence.executorId,
    fence.workKind,
    fence.workId,
  ];
}

const CLAIM_COLUMNS = `
  org_id,
  companion_id,
  claim_token,
  claim_epoch::text AS claim_epoch,
  gate_epoch::text AS gate_epoch,
  work_kind,
  work_id,
  actor_id,
  client_surface,
  runtime_generation::text AS runtime_generation,
  checkpoint,
  checkpoint_sequence::text AS checkpoint_sequence,
  turn_id,
  turn_status,
  attempt_status,
  dispatch_state,
  event_cursor::text AS event_cursor,
  unknown_event_count,
  malformed_event_count,
  oversized_event_count,
  cold_start_deadline_at,
  inactivity_deadline_at,
  absolute_deadline_at,
  operation_kind,
  operation_started_at,
  operation_attempt_count,
  provider_operation_id,
  target_settings_revision::text AS target_settings_revision,
  target_skills_revision,
  decision_status,
  decision_delivery_state`;

const AUTHORIZATION_COLUMNS = `
  authorized,
  denial_code,
  lease_expires_at,
  authorization_actor_id,
  decision_actor_id,
  client_surface,
  runtime_generation::text AS runtime_generation,
  box_id,
  box_state,
  pi_state,
  pi_invocation_id,
  disk_layout_version,
  applied_settings_revision::text AS applied_settings_revision,
  applied_skills_revision,
  model_id,
  persona,
  can_write_skills,
  provider_refs,
  skill_refs,
  mcp_refs,
  desired_settings_revision::text AS desired_settings_revision,
  skills_revision,
  work_checkpoint,
  work_checkpoint_sequence::text AS work_checkpoint_sequence,
  turn_id,
  turn_status,
  attempt_status,
  dispatch_state,
  event_cursor::text AS event_cursor,
  unknown_event_count,
  malformed_event_count,
  oversized_event_count,
  cold_start_deadline_at,
  inactivity_deadline_at,
  absolute_deadline_at,
  operation_kind,
  operation_started_at,
  operation_attempt_count,
  provider_operation_id,
  target_settings_revision::text AS target_settings_revision,
  target_skills_revision,
  decision_status,
  decision_delivery_state,
  decision_request_key,
  decision_response_text,
  command_id,
  command_pi_invocation_id,
  operation_trigger,
  operation_lane,
  source_dispatch_state,
  source_pi_invocation_id`;

/** PostgreSQL implementation whose SQL surface consists only of Runtime v2 definer functions. */
export class PostgresRuntimeStore implements RuntimeStore {
  constructor(private readonly sql: RuntimeSqlClient) {}

  async ping(): Promise<void> {
    await this.gateStatus();
  }

  async gateStatus(): Promise<GateStatus> {
    return await mapped(async () => {
      const rows = await this.sql.unsafe<RuntimeSqlRow[]>(`
        SELECT enabled, gate_epoch::text AS gate_epoch, updated_at
        FROM public.companion_runtime_gate_status()
      `);
      return decodeGateStatusRow(one(rows, "gate status"));
    });
  }

  async recoveryMetrics(): Promise<RuntimeRecoveryMetrics> {
    return await mapped(async () => {
      const rows = await this.sql.unsafe<RuntimeSqlRow[]>(`
        SELECT pending_recovery_count::double precision AS pending_recovery_count,
          oldest_recovery_age_seconds,
          auto_abandoned_count::double precision AS auto_abandoned_count,
          stalled_recovery_count::double precision AS stalled_recovery_count,
          max_recovery_attempt_count::double precision AS max_recovery_attempt_count
        FROM public.companion_runtime_recovery_metrics()
      `);
      const row = one(rows, "recovery metrics");
      const pendingCount = nonnegativeFiniteNumber(row.pending_recovery_count);
      const autoAbandonedCount = nonnegativeFiniteNumber(row.auto_abandoned_count);
      const stalledCount = nonnegativeFiniteNumber(row.stalled_recovery_count);
      const maxAttemptCount = nonnegativeFiniteNumber(row.max_recovery_attempt_count);
      const oldestAgeSeconds = row.oldest_recovery_age_seconds === null
        ? null
        : nonnegativeFiniteNumber(row.oldest_recovery_age_seconds);
      if (pendingCount === null || autoAbandonedCount === null
        || stalledCount === null || maxAttemptCount === null
        || (row.oldest_recovery_age_seconds !== null && oldestAgeSeconds === null)) {
        throw new RuntimeStoreContractError();
      }
      return { pendingCount, oldestAgeSeconds, autoAbandonedCount, stalledCount, maxAttemptCount };
    });
  }

  async disable(expectedGateEpoch: bigint, actorId: string): Promise<GateStatus> {
    return await mapped(async () => {
      const rows = await this.sql.unsafe<RuntimeSqlRow[]>(`
        SELECT enabled, gate_epoch::text AS gate_epoch, updated_at
        FROM public.companion_runtime_disable($1::bigint, $2::text)
      `, [expectedGateEpoch.toString(), actorId]);
      return decodeGateStatusRow(one(rows, "disable"));
    }, true);
  }

  async claimWork(input: {
    executorId: string;
    limit: number;
    leaseSeconds: typeof RUNTIME_LEASE_SECONDS;
    gateEpoch: bigint;
  }): Promise<RuntimeClaim[]> {
    return await mapped(async () => {
      const rows = await this.sql.unsafe<RuntimeSqlRow[]>(`
        SELECT ${CLAIM_COLUMNS}
        FROM public.companion_runtime_claim_work(
          $1::text, $2::integer, $3::integer, $4::bigint, 7::integer, 1::integer
        )
      `, [input.executorId, input.limit, input.leaseSeconds, input.gateEpoch.toString()]);
      return rows.map(decodeRuntimeClaimRow);
    }, true);
  }

  async renewAndAuthorize(
    fence: LeaseFence,
    leaseSeconds: typeof RUNTIME_LEASE_SECONDS,
  ): Promise<RuntimeAuthorization | null> {
    return await mapped(async () => {
      const rows = await this.sql.unsafe<RuntimeSqlRow[]>(`
        SELECT ${AUTHORIZATION_COLUMNS}
        FROM public.companion_runtime_renew_and_authorize_v3(
          $1::uuid, $2::uuid, $3::uuid, $4::bigint, $5::bigint,
          $6::text, $7::public.companion_runtime_work_kind, $8::uuid, $9::integer
        )
      `, [...fenceParameters(fence), leaseSeconds]);
      if (rows.length === 0) return null;
      return decodeRuntimeAuthorizationRow(one(rows, "renew authorization"), fence.workKind);
    }, true);
  }

  async checkpoint(fence: LeaseFence, input: RuntimeCheckpointInput): Promise<bigint | null> {
    return await mapped(async () => {
      const rows = await this.sql.unsafe<RuntimeSqlRow[]>(`
        SELECT public.companion_runtime_checkpoint(
          $1::uuid, $2::uuid, $3::uuid, $4::bigint, $5::bigint,
          $6::text, $7::public.companion_runtime_work_kind, $8::uuid,
          $9::bigint, $10::text, $11::text, $12::uuid, $13::text,
          $14::bigint, $15::timestamptz, $16::integer, $17::integer, $18::integer
        )::text AS next_sequence
      `, [
        ...fenceParameters(fence),
        input.expectedSequence.toString(),
        input.nextCheckpoint,
        input.providerOperationId ?? null,
        input.commandId ?? null,
        input.piInvocationId ?? null,
        input.eventCursor?.toString() ?? null,
        input.activityAt ?? null,
        input.unknownEventCount ?? null,
        input.malformedEventCount ?? null,
        input.oversizedEventCount ?? null,
      ]);
      return nullableBigintResult(rows, "next_sequence");
    }, true);
  }

  async observeInstance(fence: LeaseFence, input: RuntimeObservationInput): Promise<bigint | null> {
    return await mapped(async () => {
      const rows = await this.sql.unsafe<RuntimeSqlRow[]>(`
        SELECT public.companion_runtime_observe_instance(
          $1::uuid, $2::uuid, $3::uuid, $4::bigint, $5::bigint,
          $6::text, $7::public.companion_runtime_work_kind, $8::uuid,
          $9::bigint, $10::bigint, $11::text,
          $12::public.companion_box_observed_state,
          $13::public.companion_pi_observed_state,
          $14::text, $15::integer, $16::bigint, $17::integer, $18::timestamptz
        )::text AS next_sequence
      `, [
        ...fenceParameters(fence),
        input.runtimeGeneration.toString(),
        input.expectedSequence.toString(),
        input.boxId ?? null,
        input.boxState ?? null,
        input.piState ?? null,
        input.piInvocationId ?? null,
        input.diskLayoutVersion ?? null,
        input.appliedSettingsRevision?.toString() ?? null,
        input.appliedSkillsRevision ?? null,
        input.observedAt,
      ]);
      return nullableBigintResult(rows, "next_sequence");
    }, true);
  }

  async getMaterial(
    fence: LeaseFence,
    leaseSeconds: typeof RUNTIME_LEASE_SECONDS,
  ): Promise<RuntimeWorkMaterial | null> {
    return await mapped(async () => {
      const rows = await this.sql.unsafe<RuntimeSqlRow[]>(`
        SELECT material.turn_id, material.attempt_id, material.message_event_id,
               material.prompt_text, material.decision_request_kind,
               material.decision_response_payload, material.provider_material,
               material.skill_material, material.mcp_material, material.model_input,
               material.has_visible_output, material.attachments,
               material.credential_snapshot_matches, material.box_id,
               material.agent_hosted_url, material.agent_token_ciphertext,
               material.agent_observed_at, turn_context.turn_started_at,
               turn_context.member_timezone,
               routine_material.routine_snapshot_id, routine_material.routine_name,
               routine_material.routine_isolated, routine_material.routine_context_id,
               routine_material.routine_context_sha256, routine_material.routine_context_content,
               routine_material.relay_source_content,
               NULL::text AS trigger_name, NULL::text AS trigger_mode
        FROM public.companion_runtime_get_material(
          $1::uuid, $2::uuid, $3::uuid, $4::bigint, $5::bigint,
          $6::text, $7::public.companion_runtime_work_kind, $8::uuid, $9::integer
        ) material
        CROSS JOIN public.companion_runtime_get_turn_context(
          $1::uuid, $2::uuid, $3::uuid, $4::bigint, $5::bigint,
          $6::text, $7::public.companion_runtime_work_kind, $8::uuid, $9::integer
        ) turn_context
        CROSS JOIN public.companion_runtime_get_routine_material(
          $1::uuid, $2::uuid, $3::uuid, $4::bigint, $5::bigint,
          $6::text, $7::public.companion_runtime_work_kind, $8::uuid, $9::integer
        ) routine_material
      `, [...fenceParameters(fence), leaseSeconds]);
      if (rows.length === 0) return null;
      const row = one(rows, "work material");
      if (row.routine_snapshot_id !== null && row.routine_name === null) {
        const triggerRows = await this.sql.unsafe<RuntimeSqlRow[]>(`
          SELECT trigger_name, trigger_mode
          FROM public.companion_runtime_get_trigger_material(
            $1::uuid, $2::uuid, $3::uuid, $4::bigint, $5::bigint,
            $6::text, $7::public.companion_runtime_work_kind, $8::uuid, $9::integer
          )
        `, [...fenceParameters(fence), leaseSeconds]);
        if (triggerRows.length === 0) return null;
        const triggerRow = one(triggerRows, "trigger material");
        row.trigger_name = triggerRow.trigger_name;
        row.trigger_mode = triggerRow.trigger_mode;
      }
      return decodeMaterial(row);
    }, true);
  }

  async prepareRoutineRun(fence: LeaseFence): Promise<{
    id: string;
    sha256: string;
    content: string;
  } | false | null> {
    return await mapped(async () => {
      const rows = await this.sql.unsafe<RuntimeSqlRow[]>(`
        SELECT isolated, context_id, context_sha256, context_content
        FROM public.companion_runtime_prepare_routine_run(
          $1::uuid, $2::uuid, $3::uuid, $4::bigint, $5::bigint,
          $6::text, $7::public.companion_runtime_work_kind, $8::uuid, $9::boolean
        )
      `, [...fenceParameters(fence), true]);
      if (rows.length === 0) return null;
      const row = one(rows, "routine run preparation");
      const isolated = booleanValue(row.isolated);
      if (isolated === null) throw new RuntimeStoreContractError();
      if (!isolated) return false;
      const id = nullableUuidText(row, "context_id");
      const sha256 = nullableText(row, "context_sha256");
      // Context substrates are intentionally structured, multiline text. `nullableText` protects
      // short scalar fields by rejecting CR/LF, so using it here rejects every valid substrate
      // produced by migration 0137 before the runtime can contact the Box.
      const rawContent = row.context_content;
      const content = rawContent === null ? null : stringValue(rawContent);
      if (
        id === null || sha256 === null || !SHA256_PATTERN.test(sha256)
        || content === null || Buffer.byteLength(content, "utf8") > 32_768
      ) throw new RuntimeStoreContractError();
      return { id, sha256, content };
    }, true);
  }

  async getSkillUpdateMaterial(
    fence: LeaseFence,
    leaseSeconds: typeof RUNTIME_LEASE_SECONDS,
  ): Promise<RuntimeSkillUpdateMaterial | null> {
    return await mapped(async () => {
      const rows = await this.sql.unsafe<Record<string, unknown>[]>(`
        SELECT target_skills_revision, required_skills_revision,
               selected_skill_ids, skill_refs, skill_material
        FROM public.companion_runtime_get_skill_update_material(
          $1::uuid, $2::uuid, $3::uuid, $4::bigint, $5::bigint,
          $6::text, $7::public.companion_runtime_work_kind, $8::uuid, $9::integer
        )
      `, [...fenceParameters(fence), leaseSeconds]);
      if (rows.length === 0) return null;
      return decodeSkillUpdateMaterial(one(rows, "Skill update material"));
    }, true);
  }

  async commitSkillUpdate(
    fence: LeaseFence,
    input: RuntimeSkillUpdateMaterial & { skillsDigest: string },
  ): Promise<true | null> {
    return await mapped(async () => {
      const rows = await this.sql.unsafe<Record<string, unknown>[]>(`
        SELECT public.companion_runtime_commit_skill_update(
          $1::uuid, $2::uuid, $3::uuid, $4::bigint, $5::bigint,
          $6::text, $7::public.companion_runtime_work_kind, $8::uuid,
          ${RUNTIME_LEASE_SECONDS}::integer,
          $9::integer, $10::jsonb, $11::jsonb, $12::text
        ) AS committed
      `, [
        ...fenceParameters(fence),
        input.targetSkillsRevision,
        JSON.stringify(input.selectedSkillIds),
        JSON.stringify(input.skillRefs),
        input.skillsDigest,
      ]);
      const value = one(rows, "commit Skill update").committed;
      if (value === null) return null;
      if (value !== true) throw new RuntimeStoreContractError();
      return true;
    }, true);
  }

  async recordSkillUpdateError(
    fence: LeaseFence,
    input: { code: string; message: string },
  ): Promise<true | null> {
    return await mapped(async () => {
      const rows = await this.sql.unsafe<Record<string, unknown>[]>(`
        SELECT public.companion_runtime_record_skill_update_error(
          $1::uuid, $2::uuid, $3::uuid, $4::bigint, $5::bigint,
          $6::text, $7::public.companion_runtime_work_kind, $8::uuid,
          ${RUNTIME_LEASE_SECONDS}::integer,
          $9::text, $10::text
        ) AS recorded
      `, [...fenceParameters(fence), input.code, input.message]);
      const value = one(rows, "record Skill update error").recorded;
      if (value === null) return null;
      if (value !== true) throw new RuntimeStoreContractError();
      return true;
    }, true);
  }

  async getConfigCatalog(
    fence: LeaseFence,
    leaseSeconds: typeof RUNTIME_LEASE_SECONDS,
  ): Promise<RuntimeConfigCatalog | null> {
    return await mapped(async () => {
      const rows = await this.sql.unsafe<RuntimeSqlRow[]>(`
        SELECT catalog
        FROM public.companion_runtime_get_config_catalog(
          $1::uuid, $2::uuid, $3::uuid, $4::bigint, $5::bigint,
          $6::text, $7::public.companion_runtime_work_kind, $8::uuid, $9::integer
        )
      `, [...fenceParameters(fence), leaseSeconds]);
      if (rows.length === 0) return null;
      return decodeConfigCatalog(one(rows, "config catalog"));
    }, true);
  }

  async mintHubToken(
    fence: LeaseFence,
    leaseSeconds: typeof RUNTIME_LEASE_SECONDS,
  ): Promise<{ token: string; expiresAt: Date } | null> {
    return await mapped(async () => {
      const rows = await this.sql.unsafe<RuntimeSqlRow[]>(`
        SELECT token, expires_at
        FROM public.companion_runtime_mint_hub_token(
          $1::uuid, $2::uuid, $3::uuid, $4::bigint, $5::bigint,
          $6::text, $7::public.companion_runtime_work_kind, $8::uuid, $9::integer
        )
      `, [...fenceParameters(fence), leaseSeconds]);
      if (rows.length === 0) return null;
      return decodeEphemeralToken(one(rows, "hub token"), "cmp_pat_");
    }, true);
  }

  async mintMcpBrokerToken(
    fence: LeaseFence,
    leaseSeconds: typeof RUNTIME_LEASE_SECONDS,
  ): Promise<{ token: string; expiresAt: Date } | null> {
    return await mapped(async () => {
      const rows = await this.sql.unsafe<RuntimeSqlRow[]>(`
        SELECT token, expires_at
        FROM public.companion_runtime_mint_mcp_broker_token(
          $1::uuid, $2::uuid, $3::uuid, $4::bigint, $5::bigint,
          $6::text, $7::public.companion_runtime_work_kind, $8::uuid, $9::integer
        )
      `, [...fenceParameters(fence), leaseSeconds]);
      if (rows.length === 0) return null;
      return decodeEphemeralToken(one(rows, "MCP broker token"), "cmp_mcp_");
    }, true);
  }

  async mintControlToken(
    fence: LeaseFence,
    leaseSeconds: typeof RUNTIME_LEASE_SECONDS,
  ): Promise<{ token: string; expiresAt: Date } | null> {
    return await mapped(async () => {
      const rows = await this.sql.unsafe<RuntimeSqlRow[]>(`
        SELECT token, expires_at
        FROM public.companion_runtime_mint_control_token(
          $1::uuid, $2::uuid, $3::uuid, $4::bigint, $5::bigint,
          $6::text, $7::public.companion_runtime_work_kind, $8::uuid, $9::integer
        )
      `, [...fenceParameters(fence), leaseSeconds]);
      if (rows.length === 0) return null;
      return decodeEphemeralToken(one(rows, "control token"), "cmp_ctl_");
    }, true);
  }

  async recordMaterialSnapshot(fence: LeaseFence, input: {
    clientSurface: ClientSurface;
    materialExpiresAt: Date | null;
    agentEndpoint?: { hostedUrl: string; tokenCiphertext: string } | null;
  }): Promise<true | null> {
    return await mapped(async () => {
      const rows = await this.sql.unsafe<RuntimeSqlRow[]>(`
        SELECT public.companion_runtime_record_material_snapshot(
          $1::uuid, $2::uuid, $3::uuid, $4::bigint, $5::bigint,
          $6::text, $7::public.companion_runtime_work_kind, $8::uuid,
          $9::public.companion_client_surface, $10::timestamptz,
          $11::text, $12::text
        ) AS recorded
      `, [
        ...fenceParameters(fence),
        input.clientSurface,
        input.materialExpiresAt,
        input.agentEndpoint?.hostedUrl ?? null,
        input.agentEndpoint?.tokenCiphertext ?? null,
      ]);
      const recorded = one(rows, "record material snapshot").recorded;
      const recordedValue = booleanValue(recorded);
      if (recordedValue === null) throw new RuntimeStoreContractError();
      return recordedValue ? true : null;
    }, true);
  }

  async publishMaterialSnapshot(fence: LeaseFence, input: {
    piInvocationId: string;
  }): Promise<true | null> {
    return await mapped(async () => {
      const rows = await this.sql.unsafe<RuntimeSqlRow[]>(`
        SELECT public.companion_runtime_publish_material_snapshot(
          $1::uuid, $2::uuid, $3::uuid, $4::bigint, $5::bigint,
          $6::text, $7::public.companion_runtime_work_kind, $8::uuid, $9::text
        ) AS published
      `, [...fenceParameters(fence), input.piInvocationId]);
      const published = one(rows, "publish material snapshot").published;
      const publishedValue = booleanValue(published);
      if (publishedValue === null) throw new RuntimeStoreContractError();
      return publishedValue ? true : null;
    }, true);
  }

  async getAttemptTerminalProjection(fence: LeaseFence): Promise<{
    checkpoint: "agent_settled" | "process_exited";
    eventCursor: bigint;
    hasVisibleOutput: boolean;
    outputsHarvested: boolean;
  } | null> {
    return await mapped(async () => {
      const rows = await this.sql.unsafe<RuntimeSqlRow[]>(`
        SELECT checkpoint, event_cursor::text AS event_cursor, has_visible_output, outputs_harvested
        FROM public.companion_runtime_get_attempt_terminal_projection(
          $1::uuid, $2::uuid, $3::uuid, $4::bigint, $5::bigint,
          $6::text, $7::public.companion_runtime_work_kind, $8::uuid
        )
      `, fenceParameters(fence));
      if (rows.length === 0) return null;
      return decodeAttemptTerminalProjection(one(rows, "attempt terminal projection"));
    });
  }

  async recordAttemptOutputs(fence: LeaseFence, input: {
    attachments: RuntimeOutputAttachment[];
    activityAt: Date;
  }): Promise<{ recorded: number; hasVisibleOutput: boolean } | null> {
    return await mapped(async () => {
      // The driver serializes an array parameter to JSON for a jsonb column, exactly as the event
      // projector's batch does. Pre-stringifying it here would arrive as a JSON *string* instead.
      const attachments = input.attachments.map((attachment, position) => ({
        storage_key: attachment.storageKey,
        content_type: attachment.contentType,
        byte_size: attachment.byteSize,
        sha256: attachment.sha256,
        filename: attachment.filename,
        position,
      }));
      const rows = await this.sql.unsafe<RuntimeSqlRow[]>(`
        SELECT recorded, has_visible_output
        FROM public.companion_runtime_record_attempt_outputs(
          $1::uuid, $2::uuid, $3::uuid, $4::bigint, $5::bigint,
          $6::text, $7::public.companion_runtime_work_kind, $8::uuid,
          $9::jsonb, $10::timestamptz
        )
      `, [...fenceParameters(fence), attachments, input.activityAt]);
      if (rows.length === 0) return null;
      const row = one(rows, "attempt outputs");
      const recorded = numberValue(row.recorded);
      const hasVisibleOutput = booleanValue(row.has_visible_output);
      if (recorded === null || recorded < 0 || hasVisibleOutput === null) {
        throw new RuntimeStoreContractError();
      }
      return { recorded, hasVisibleOutput };
    }, true);
  }

  async projectEventBatch(fence: LeaseFence, input: {
    expectedSequence: bigint;
    piInvocationId: string;
    events: RuntimePiProjection[];
    throughCursor: bigint;
    activityAt?: Date;
    unknownEventCount: number;
    malformedEventCount: number;
    oversizedEventCount: number;
  }): Promise<{
    checkpointSequence: bigint;
    eventCursor: bigint;
    hasVisibleOutput: boolean;
    routineReturned: boolean;
  } | null> {
    return await mapped(async () => {
      const events = input.events.map((event) => ({
        ...event,
        sequence: event.sequence.toString(),
      }));
      const rows = await this.sql.unsafe<RuntimeSqlRow[]>(`
        SELECT checkpoint_sequence::text AS checkpoint_sequence,
               event_cursor::text AS event_cursor,
               has_visible_output, routine_returned
        FROM public.companion_runtime_project_event_batch_v2(
          $1::uuid, $2::uuid, $3::uuid, $4::bigint, $5::bigint,
          $6::text, $7::public.companion_runtime_work_kind, $8::uuid,
          $9::bigint, $10::text, $11::jsonb, $12::bigint, $13::timestamptz,
          $14::integer, $15::integer, $16::integer
        )
      `, [
        ...fenceParameters(fence),
        input.expectedSequence.toString(),
        input.piInvocationId,
        events,
        input.throughCursor.toString(),
        input.activityAt ?? null,
        input.unknownEventCount,
        input.malformedEventCount,
        input.oversizedEventCount,
      ]);
      if (rows.length === 0) return null;
      const row = one(rows, "event projection");
      const checkpointSequence = stringValue(row.checkpoint_sequence);
      const eventCursor = stringValue(row.event_cursor);
      const hasVisibleOutput = booleanValue(row.has_visible_output);
      const routineReturned = booleanValue(row.routine_returned);
      if (
        checkpointSequence === null
        || !/^[1-9][0-9]*$/.test(checkpointSequence)
        || eventCursor === null
        || !/^(0|[1-9][0-9]*)$/.test(eventCursor)
        || hasVisibleOutput === null
        || routineReturned === null
      ) throw new RuntimeStoreContractError();
      return {
        checkpointSequence: BigInt(checkpointSequence),
        eventCursor: BigInt(eventCursor),
        hasVisibleOutput,
        routineReturned,
      };
    }, true);
  }

  async registerDuplicateCleanups(
    fence: LeaseFence,
    boxIds: string[],
  ): Promise<DuplicateCleanup[]> {
    return await mapped(async () => {
      const rows = await this.sql.unsafe<RuntimeSqlRow[]>(`
        SELECT box_id, status, provider_operation_id,
               checkpoint_sequence::text AS checkpoint_sequence
        FROM public.companion_runtime_register_duplicate_cleanups(
          $1::uuid, $2::uuid, $3::uuid, $4::bigint, $5::bigint,
          $6::text, $7::public.companion_runtime_work_kind, $8::uuid, $9::text[]
        )
      `, [...fenceParameters(fence), boxIds]);
      return rows.map(duplicateCleanup);
    }, true);
  }

  async checkpointDuplicateCleanup(fence: LeaseFence, input: {
    boxId: string;
    expectedSequence: bigint;
    nextStatus: DuplicateCleanupStatus;
    providerOperationId?: string;
  }): Promise<DuplicateCleanup | null> {
    return await mapped(async () => {
      const rows = await this.sql.unsafe<RuntimeSqlRow[]>(`
        SELECT box_id, status, provider_operation_id,
               checkpoint_sequence::text AS checkpoint_sequence
        FROM public.companion_runtime_checkpoint_duplicate_cleanup(
          $1::uuid, $2::uuid, $3::uuid, $4::bigint, $5::bigint,
          $6::text, $7::public.companion_runtime_work_kind, $8::uuid,
          $9::text, $10::bigint, $11::public.companion_duplicate_cleanup_status, $12::text
        )
      `, [
        ...fenceParameters(fence),
        input.boxId,
        input.expectedSequence.toString(),
        input.nextStatus,
        input.providerOperationId ?? null,
      ]);
      if (rows.length === 0) return null;
      return duplicateCleanup(one(rows, "duplicate cleanup checkpoint"));
    }, true);
  }

  async settle(fence: LeaseFence, input: RuntimeSettlementInput): Promise<boolean> {
    return await mapped(async () => {
      const rows = await this.sql.unsafe<RuntimeSqlRow[]>(`
        SELECT public.companion_runtime_settle(
          $1::uuid, $2::uuid, $3::uuid, $4::bigint, $5::bigint,
          $6::text, $7::public.companion_runtime_work_kind, $8::uuid,
          $9::text, $10::text, $11::text,
          $12::public.companion_runtime_error_action
        ) AS settled
      `, [
        ...fenceParameters(fence),
        input.terminalStatus,
        input.error?.code ?? null,
        input.error?.message ?? null,
        input.error?.action ?? null,
      ]);
      return booleanResult(rows, "settled");
    }, true);
  }

  async release(fence: LeaseFence): Promise<boolean> {
    return await mapped(async () => {
      const rows = await this.sql.unsafe<RuntimeSqlRow[]>(`
        SELECT public.companion_runtime_release_lease(
          $1::uuid, $2::uuid, $3::uuid, $4::bigint, $5::bigint,
          $6::text, $7::public.companion_runtime_work_kind, $8::uuid
        ) AS released
      `, fenceParameters(fence));
      return booleanResult(rows, "released");
    }, true);
  }

  async deferDelete(fence: LeaseFence): Promise<boolean> {
    return await mapped(async () => {
      const rows = await this.sql.unsafe<Record<string, unknown>[]>(`
        SELECT public.companion_runtime_defer_delete(
          $1::uuid, $2::uuid, $3::uuid, $4::bigint, $5::bigint,
          $6::text, $7::public.companion_runtime_work_kind, $8::uuid
        ) AS deferred
      `, fenceParameters(fence));
      return booleanResult(rows, "deferred");
    }, true);
  }
}
