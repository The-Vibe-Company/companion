import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { getCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import {
  companionAttachmentKey,
  deleteStorageObject,
  getSkillArchive,
  isStoragePreconditionFailure,
  putSkillArchive,
} from "@companion/storage";
import {
  COMPANION_PLUGIN_OAUTH_SERVERS,
  CompanionNotFoundError,
  CompanionDeleteForbiddenError,
  CompanionDuplicateForbiddenError,
  CompanionPluginConflictError,
  CompanionPluginOAuthError,
  CompanionProviderOAuthError,
  COMPANION_PROVIDER_OAUTH_TTL_MS,
  beginAnthropicProviderOAuth,
  beginOpenAICodexProviderOAuth,
  beginCompanionPluginOAuth,
  completeAnthropicProviderOAuth,
  completeCompanionPluginOAuth,
  decryptOpaqueValue,
  encryptOpaqueValue,
  loadSecretsMasterKey,
  type OpaqueCiphertext,
  CompanionProviderError,
  CompanionProviderForbiddenError,
  CompanionRuntimeForbiddenError,
  CompanionRuntimeTransitionError,
  CompanionRoutineInvalidError,
  CompanionRoutineDecisionUpdateError,
  CompanionRoutineNotFoundError,
  CompanionRoutineRunNotFoundError,
  CompanionTriggerDecisionUpdateError,
  CompanionTriggerNotFoundError,
  CompanionTriggerRunNotFoundError,
  CompanionDecisionConflictError,
  CompanionDecisionNotFoundError,
  CompanionShareForbiddenError,
  CompanionSettingsForbiddenError,
  CompanionSkillSelectionError,
  CompanionPluginSelectionError,
  CompanionWriteSkillsForbiddenError,
  companionsAvailableToUser,
  companionsEnabled,
  companionCatalogModel,
  getCompanionProviderCatalog,
  answerCompanionConfigDecisionV2,
  answerCompanionDecisionV2,
  answerCompanionRoutineDecisionV2,
  answerCompanionTriggerDecisionV2,
  cancelCompanionTurnV2,
  buildCompanionRosterSync,
  buildCompanionThreadDelta,
  buildCompanionThreadSequenceCursor,
  validateCompanionSyncCursor,
  classifyCompanionTriggerFireError,
  composeTriggerPrompt,
  createCompanionV2,
  createCompanionRoutineV2,
  createCompanionTriggerV2,
  createCompanionTranscriptionSession,
  transcribeCompanionAudio,
  deleteCompanionRoutineV2,
  deleteCompanionTriggerV2,
  duplicateCompanionV2,
  enqueueCompanionOperationV2,
  enqueueCompanionTurnV2,
  extractTriggerDeliveryId,
  failCompanionTriggerFire,
  fireCompanionTrigger,
  getCompanionDecisionV2,
  getCompanionRoutineRunV2,
  getCompanionTriggerRunV2,
  getCompanionTriggerForWebhook,
  getCompanion,
  getCompanionV2,
  listCompanionsV2,
  listCompanionRoutinesV2,
  listCompanionRoutineRunsV2,
  listCompanionTriggerRunsV2,
  listCompanionTriggersV2,
  readCompanionAttachmentV2,
  readCompanionThreadChangesV2,
  readCompanionThreadProjectionSequenceV2,
  readCompanionThreadSequenceCursor,
  readCompanionThreadWindowCursor,
  readCompanionThreadWindowV2,
  readCompanionThreadV2,
  syncCompanionThreadV2,
  rotateCompanionTriggerSecretV2,
  registerCompanionTriggerWebhookV2,
  unregisterCompanionTriggerWebhookV2,
  setCompanionWorkspaceShareV2,
  setCompanionProviderV2,
  triggerFireMessageId,
  updateCompanionMemberStateV2,
  updateCompanionRoutineV2,
  updateCompanionTriggerV2,
  updateCompanionV2,
  deleteCompanionPlugin,
  deleteCompanionProvider,
  listCompanionShares,
  listCompanionProviders,
  listCompanionPlugins,
  pollOpenAICodexProviderOAuth,
  saveCompanionProvider,
  saveCompanionPlugin,
  saveCompanionOAuthPlugin,
  disconnectCompanionTriggerProviderAccount,
  ensureOAuthCompanionTriggerProviderAccount,
  listCompanionTriggerProviderAccounts,
  saveCompanionTriggerProviderAccount,
  setDefaultCompanionProvider,
  CompanionMcpBrokerAuthorizationError,
  companionMcpAccessTokenInputSchema,
  companionMcpAccessTokenSchema,
  issueCompanionMcpAccessToken,
  resolveCompanionMcpBrokerAuthorization,
  resolveCompanionControlAuthorization,
  CompanionControlAuthorizationError,
  getCompanionControlRequest,
  decideCompanionControlRequest,
  finishCompanionControlRequest,
  enqueueCompanionControlContinuation,
  grantCompanionPeerAccess,
  listCompanionControlPeers,
  revokeCompanionPeerAccess,
  updateCompanionControlPlugin,
  registerCompanionNotificationDevice,
  unregisterCompanionNotificationDevice,
  listCompanionSections,
  createCompanionSection,
  updateCompanionSection,
  deleteCompanionSection,
  reorderCompanionSections,
  assignCompanionSection,
} from "@companion/core";
import {
  COMPANION_ATTACHMENT_MAX_BYTES,
  COMPANION_MESSAGE_ATTACHMENT_MAX_COUNT,
  COMPANION_TRANSCRIPTION_AUDIO_CONTENT_TYPE,
  COMPANION_TRANSCRIPTION_AUDIO_MAX_BYTES,
  type CompanionAttachmentUpload,
  type CompanionControlJsonValue,
  type CompanionTrigger,
  type CompanionRuntimeSafeError,
  type CompanionThread,
  type CompanionThreadMetadata,
  type CompanionThreadWindow,
  type CompanionTurn,
  type SendCompanionMessageInput,
  companionTranscriptionSchema,
  companionTranscriptionSessionSchema,
  createCompanionTranscriptionSessionInputSchema,
  createCompanionInputSchema,
  createCompanionRoutineInputSchema,
  companionRoutineRunListQuerySchema,
  companionRoutineRunDetailQuerySchema,
  companionTriggerRunListQuerySchema,
  companionTriggerRunDetailQuerySchema,
  companionControlRequestSchema,
  companionRequestRoutineChangeInputSchema,
  companionRequestTriggerChangeInputSchema,
  redactCompanionControlTrigger,
  companionRoutineDraftSchema,
  companionTriggerDraftSchema,
  createCompanionTriggerInputSchema,
  createCompanionTriggerProviderAccountInputSchema,
  declaredCompanionAttachmentContentType,
  isCompanionAttachmentImage,
  sanitizeCompanionAttachmentFilename,
  sniffCompanionAttachmentMime,
  cancelCompanionTurnInputSchema,
  companionClientSurfaceSchema,
  companionProviderIdSchema,
  companionProviderOAuthCompleteInputSchema,
  companionProviderOAuthStartInputSchema,
  companionPluginOAuthStartInputSchema,
  decideCompanionDecisionInputSchema,
  saveCompanionProviderInputSchema,
  sendCompanionMessageInputSchema,
  setCompanionProviderInputSchema,
  setCompanionWorkspaceShareInputSchema,
  setDefaultCompanionProviderInputSchema,
  companionSyncQuerySchema,
  companionThreadDeltaResponseSchema,
  companionThreadWindowQuerySchema,
  companionThreadWindowSchema,
  startCompanionRuntimeInputSchema,
  saveCompanionPluginInputSchema,
  updateCompanionInputSchema,
  updateCompanionMemberStateInputSchema,
  updateCompanionRoutineInputSchema,
  updateCompanionTriggerInputSchema,
  createCompanionSectionInputSchema,
  updateCompanionSectionInputSchema,
  reorderCompanionSectionsInputSchema,
  assignCompanionSectionInputSchema,
} from "@companion/contracts";
import {
  notificationDeviceRegistrationSchema,
  notificationInstallationIdSchema,
} from "@companion/contracts/notifications";
import {
  COMPANION_OPERATION_IDEMPOTENCY_HEADER,
  companionOperationRequestIdSchema,
  restartCompanionRuntimeInputSchema,
} from "@companion/contracts/companion-runtime";
import { db, withTenantContext, type Db } from "@companion/db";
import {
  actorFromContext,
  AuthenticationRequiredError,
  bearerFromHeader,
  jsonError,
  orgIdFromContext,
  type ApiVariables,
} from "./context";
import { mintCompanionDesktop, RuntimeDesktopClientError } from "./runtimeDesktopClient";
import { createCompanionTranscriptionDiagnostics } from "./companionTranscriptionDiagnostics";
import { executeCompanionControlMcp } from "./companionControlMcp";
import { recordCompanionThreadSyncMetrics } from "./companionThreadSyncMetrics";

const companionIdSchema = z.string().uuid();

const COMPANION_PLUGIN_OAUTH_FLOW_PURPOSE = "companion-mcp-oauth-flow";
const COMPANION_PLUGIN_OAUTH_TTL_MS = 10 * 60_000;
const COMPANION_PROVIDER_OAUTH_FLOW_PURPOSE = "companion-provider-oauth-flow";
const COMPANION_PROVIDER_OAUTH_COOKIE = "companion_provider_oauth";

type CompanionUpdatePatch = Parameters<typeof updateCompanionV2>[0]["patch"];
type CompanionMessageFormInput = {
  content: string;
  client_message_id: string | undefined;
  client_surface?: SendCompanionMessageInput["client_surface"];
};

interface CompanionCreatedStorageObject {
  key: string;
  etag?: string;
}

interface CompanionStorageDeleteInput {
  key: string;
  ifMatch?: string;
}

function defaultCompanionRouteDependencies() {
  return {
    actorFromContext,
    jsonError,
    orgIdFromContext,
    withTenantContext,
    putSkillArchive,
    getSkillArchive,
    deleteStorageObject,
    mintCompanionDesktop,
    answerCompanionConfigDecisionV2,
    answerCompanionDecisionV2,
    readCompanionAttachmentV2,
    cancelCompanionTurnV2,
    createCompanionV2,
    duplicateCompanionV2,
    enqueueCompanionOperationV2,
    enqueueCompanionTurnV2,
    getCompanionDecisionV2,
    getCompanion,
    getCompanionV2,
    listCompanionsV2,
    listCompanionRoutinesV2,
    listCompanionRoutineRunsV2,
    getCompanionRoutineRunV2,
    createCompanionRoutineV2,
    updateCompanionRoutineV2,
    deleteCompanionRoutineV2,
    createCompanionTranscriptionSession,
    transcribeCompanionAudio,
    answerCompanionRoutineDecisionV2,
    listCompanionTriggersV2,
    listCompanionTriggerProviderAccounts,
    listCompanionTriggerRunsV2,
    getCompanionTriggerRunV2,
    createCompanionTriggerV2,
    updateCompanionTriggerV2,
    deleteCompanionTriggerV2,
    rotateCompanionTriggerSecretV2,
    answerCompanionTriggerDecisionV2,
    registerCompanionTriggerWebhookV2,
    unregisterCompanionTriggerWebhookV2,
    disconnectCompanionTriggerProviderAccount,
    ensureOAuthCompanionTriggerProviderAccount,
    saveCompanionTriggerProviderAccount,
    getCompanionTriggerForWebhook,
    fireCompanionTrigger,
    failCompanionTriggerFire,
    readCompanionThreadV2,
    readCompanionThreadChangesV2,
    readCompanionThreadProjectionSequenceV2,
    readCompanionThreadWindowV2,
    syncCompanionThreadV2,
    setCompanionProviderV2,
    setCompanionWorkspaceShareV2,
    updateCompanionMemberStateV2,
    updateCompanionV2,
    resolveCompanionMcpBrokerAuthorization,
    resolveCompanionControlAuthorization,
    getCompanionControlRequest,
    decideCompanionControlRequest,
    finishCompanionControlRequest,
    enqueueCompanionControlContinuation,
    grantCompanionPeerAccess,
    listCompanionControlPeers,
    revokeCompanionPeerAccess,
    updateCompanionControlPlugin,
    issueCompanionMcpAccessToken,
    registerCompanionNotificationDevice,
    unregisterCompanionNotificationDevice,
    listCompanionSections,
    createCompanionSection,
    updateCompanionSection,
    deleteCompanionSection,
    reorderCompanionSections,
    assignCompanionSection,
  };
}

type CompanionRouteDependencies = Partial<ReturnType<typeof defaultCompanionRouteDependencies>>;

const VIEWER_RUNTIME_ERROR: CompanionRuntimeSafeError = {
  code: "runtime_unavailable",
  message: "Companion runtime needs attention.",
  action: "none",
};

/**
 * A Viewer can follow durable progress, but runtime diagnostics and their recovery hints belong to
 * the Owner/Editor operating boundary. Keep the same turn shape so polling remains stable while
 * replacing both the turn-level and attempt-level error with one non-actionable projection.
 */
function projectTurnForHttp(
  turn: CompanionTurn | null,
  viewer: boolean,
): CompanionTurn | null {
  if (!viewer || turn === null) return turn;
  return {
    ...turn,
    error: turn.error === null ? null : { ...VIEWER_RUNTIME_ERROR },
    latest_attempt: turn.latest_attempt === null
      ? null
      : {
          ...turn.latest_attempt,
          error: turn.latest_attempt.error === null
            ? null
            : { ...VIEWER_RUNTIME_ERROR },
        },
  };
}

function projectThreadMetadataForHttp(
  thread: CompanionThreadMetadata,
  transcriptionAvailable: boolean,
): CompanionThreadMetadata {
  const viewer = thread.access === "viewer";
  return {
    ...thread,
    transcription_available: transcriptionAvailable,
    active_turn: projectTurnForHttp(thread.active_turn, viewer),
    interrupted_turn: projectTurnForHttp(thread.interrupted_turn, viewer),
  };
}

function projectThreadForHttp(
  thread: CompanionThread,
  transcriptionAvailable: boolean,
): CompanionThread {
  return {
    ...projectThreadMetadataForHttp(thread, transcriptionAvailable),
    entries: thread.entries,
  };
}

function projectThreadWindowForHttp(
  window: CompanionThreadWindow,
  transcriptionAvailable: boolean,
): CompanionThreadWindow {
  return {
    ...window,
    thread: projectThreadMetadataForHttp(window.thread, transcriptionAvailable),
  };
}

type CompanionPluginOAuthState = {
  orgId: string;
  userId: string;
  nonce: string;
  expiresAt: number;
  companionId?: string;
  controlRequestId?: string;
};

type CompanionPluginOAuthFlowEnvelope = {
  label: string;
  flow: Awaited<ReturnType<typeof beginCompanionPluginOAuth>>["flow"];
};

function companionPluginOAuthRedirectUri(env: NodeJS.ProcessEnv): string {
  const base = env.COMPANION_WEB_URL ?? "http://127.0.0.1:3000";
  return new URL("/v1/companion-plugins/oauth/callback", base).toString();
}

/** Base an external service posts trigger webhooks to; same resolution as the OAuth callback. */
function companionWebhookBaseUrl(env: NodeJS.ProcessEnv): string {
  return env.COMPANION_WEB_URL ?? "http://127.0.0.1:3000";
}

function triggerRegistrationErrorCode<T>(error: T): string | null {
  const parsed = z.object({ code: z.string() }).passthrough().safeParse(error);
  return parsed.success ? parsed.data.code : null;
}

/**
 * Only providers with an adapter and enough delivery metadata are auto-wired. The default
 * webhook provider and custom/unknown delivery hints remain valid trigger definitions with no
 * remote registration side effect.
 */
function supportsAutomaticTriggerRegistration(trigger: CompanionTrigger): boolean {
  return trigger.provider === "linear" || trigger.provider === "github" || trigger.provider === "sentry";
}

function isOptionalTriggerRegistrationFailure<T>(error: T): boolean {
  return ["provider_unwired"].includes(
    triggerRegistrationErrorCode(error) ?? "",
  );
}

function triggerIdFromDecisionResult<T>(result: T): string | null {
  const stringResult = z.string().safeParse(result);
  if (stringResult.success) return stringResult.data;
  const parsed = z.object({
    trigger_id: z.string().uuid().nullable().optional(),
    id: z.string().uuid().nullable().optional(),
  }).passthrough().safeParse(result);
  if (!parsed.success) return null;
  return parsed.data.trigger_id ?? parsed.data.id ?? null;
}

function companionPluginOAuthCookieName(nonce: string): string {
  return `companion_mcp_oauth_${nonce.replaceAll("-", "")}`;
}

function signCompanionPluginOAuthState(
  payload: CompanionPluginOAuthState,
  masterKey: Buffer,
): string {
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signature = createHmac("sha256", masterKey).update(encoded).digest("base64url");
  return `${encoded}.${signature}`;
}

function verifyCompanionPluginOAuthState(
  value: string,
  masterKey: Buffer,
): CompanionPluginOAuthState {
  const [encoded, signature] = value.split(".");
  if (!encoded || !signature) throw new Error("invalid OAuth state");
  const expected = createHmac("sha256", masterKey).update(encoded).digest();
  const actual = Buffer.from(signature, "base64url");
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    throw new Error("invalid OAuth state");
  }
  // SAFETY: The state was signed above with the deployment master key; the decoded value is only
  // accepted after the required identity and expiry fields are checked below.
  const parsed = JSON.parse(
    Buffer.from(encoded, "base64url").toString("utf8"),
  ) as CompanionPluginOAuthState;
  if (
    !parsed.orgId
    || !parsed.userId
    || !parsed.nonce
    || parsed.expiresAt < Date.now()
    || ((parsed.companionId === undefined) !== (parsed.controlRequestId === undefined))
  ) {
    throw new Error("expired OAuth state");
  }
  return parsed;
}

function encodeCompanionPluginOAuthFlow(input: {
  orgId: string;
  nonce: string;
  value: unknown;
  masterKey: Buffer;
}): string {
  const encrypted = encryptOpaqueValue({
    orgId: input.orgId,
    purpose: COMPANION_PLUGIN_OAUTH_FLOW_PURPOSE,
    subjectId: input.nonce,
    value: JSON.stringify(input.value),
  }, input.masterKey);
  return Buffer.from(JSON.stringify(encrypted), "utf8").toString("base64url");
}

function decodeCompanionPluginOAuthFlow(input: {
  orgId: string;
  nonce: string;
  value: string;
  masterKey: Buffer;
}): CompanionPluginOAuthFlowEnvelope {
  // SAFETY: This ciphertext is produced by encodeCompanionPluginOAuthFlow and is authenticated by
  // decryptOpaqueValue before the decrypted flow is parsed.
  const encrypted = JSON.parse(
    Buffer.from(input.value, "base64url").toString("utf8"),
  ) as OpaqueCiphertext;
  const plaintext = decryptOpaqueValue({
    orgId: input.orgId,
    purpose: COMPANION_PLUGIN_OAUTH_FLOW_PURPOSE,
    subjectId: input.nonce,
    ...encrypted,
  }, input.masterKey);
  // SAFETY: The decrypted payload is the exact envelope written by the paired encoder above.
  return JSON.parse(plaintext) as CompanionPluginOAuthFlowEnvelope;
}

type CompanionProviderOAuthCookie = {
  orgId: string;
  nonce: string;
  encrypted: OpaqueCiphertext;
};

type CompanionProviderOAuthPending = {
  userId: string;
  flow:
    | ReturnType<typeof beginAnthropicProviderOAuth>["flow"]
    | Awaited<ReturnType<typeof beginOpenAICodexProviderOAuth>>["flow"];
};

type CompanionProviderOAuthDecoded = {
  orgId: string;
} & CompanionProviderOAuthPending;

function encodeCompanionProviderOAuthFlow(input: {
  orgId: string;
  userId: string;
  flow:
    | ReturnType<typeof beginAnthropicProviderOAuth>["flow"]
    | Awaited<ReturnType<typeof beginOpenAICodexProviderOAuth>>["flow"];
  masterKey: Buffer;
}): string {
  const nonce = randomUUID();
  const encrypted = encryptOpaqueValue({
    orgId: input.orgId,
    purpose: COMPANION_PROVIDER_OAUTH_FLOW_PURPOSE,
    subjectId: nonce,
    value: JSON.stringify({ userId: input.userId, flow: input.flow }),
  }, input.masterKey);
  return Buffer.from(JSON.stringify({ orgId: input.orgId, nonce, encrypted }), "utf8")
    .toString("base64url");
}

function decodeCompanionProviderOAuthFlow(input: {
  value: string;
  masterKey: Buffer;
}): CompanionProviderOAuthDecoded {
  // SAFETY: The cookie is signed/encrypted by encodeCompanionProviderOAuthFlow and its fields are
  // consumed only after decryption and the pending-flow checks below.
  const cookie = JSON.parse(
    Buffer.from(input.value, "base64url").toString("utf8"),
  ) as CompanionProviderOAuthCookie;
  const plaintext = decryptOpaqueValue({
    orgId: cookie.orgId,
    purpose: COMPANION_PROVIDER_OAUTH_FLOW_PURPOSE,
    subjectId: cookie.nonce,
    ...cookie.encrypted,
  }, input.masterKey);
  // SAFETY: The plaintext is authenticated by decryptOpaqueValue and was written by the paired
  // provider-flow encoder with this exact pending payload shape.
  const pending = JSON.parse(plaintext) as CompanionProviderOAuthPending;
  if (!pending.userId || !pending.flow || pending.flow.expiresAt < Date.now()) {
    throw new CompanionProviderOAuthError("oauth_expired", "Provider sign-in expired. Start again.");
  }
  return { orgId: cookie.orgId, ...pending };
}

class CompanionAccessForbiddenError extends Error {
  constructor() {
    super("Companions access is not available for this user");
    this.name = "CompanionAccessForbiddenError";
  }
}

const databaseErrorSchema = z.object({
  code: z.string().optional(),
  cause: z.unknown().optional(),
}).passthrough();

function databaseErrorCode<T>(error: T): string | null {
  const seen = new Set<object>();
  let current: unknown = error;
  while (current !== null && current !== undefined) {
    const parsed = databaseErrorSchema.safeParse(current);
    if (!parsed.success || seen.has(parsed.data)) break;
    seen.add(parsed.data);
    if (parsed.data.code) return parsed.data.code;
    current = parsed.data.cause;
  }
  return null;
}
function errorStatus<T>(error: T): number {
  if (error instanceof CompanionRoutineDecisionUpdateError
      || error instanceof CompanionTriggerDecisionUpdateError) {
    return error.httpStatus;
  }
  const databaseCode = databaseErrorCode(error);
  if (databaseCode === "42501") return 403;
  if (databaseCode === "P0002" || databaseCode === "02000") return 404;
  if (["23505", "40001", "55000"].includes(databaseCode ?? "")) return 409;
  if (error instanceof AuthenticationRequiredError) return 401;
  if (error instanceof CompanionAccessForbiddenError) return 403;
  if (error instanceof CompanionNotFoundError) return 404;
  if (error instanceof CompanionDecisionNotFoundError) return 404;
  if (error instanceof CompanionRoutineNotFoundError) return 404;
  if (error instanceof CompanionRoutineRunNotFoundError) return 404;
  if (error instanceof CompanionTriggerNotFoundError) return 404;
  if (error instanceof CompanionTriggerRunNotFoundError) return 404;
  if (error instanceof CompanionRoutineInvalidError) return 400;
  if (error instanceof CompanionDecisionConflictError) return 409;
  if (error instanceof CompanionRuntimeForbiddenError) return 403;
  if (error instanceof CompanionSettingsForbiddenError) return 403;
  if (error instanceof CompanionSkillSelectionError) return 400;
  if (error instanceof CompanionPluginSelectionError) return 400;
  if (error instanceof CompanionWriteSkillsForbiddenError) return 403;
  if (error instanceof CompanionDeleteForbiddenError) return 403;
  if (error instanceof CompanionDuplicateForbiddenError) return 403;
  if (error instanceof CompanionProviderForbiddenError) return 403;
  if (error instanceof CompanionShareForbiddenError) return 403;
  if (error instanceof CompanionProviderError) return 422;
  if (error instanceof CompanionRuntimeTransitionError) return 409;
  if (error instanceof CompanionPluginConflictError) return 409;
  if (error instanceof CompanionPluginOAuthError) {
    if (error.code === "oauth_not_supported") return 400;
    if (error.code === "oauth_not_configured") return 503;
    return 502;
  }
  if (error instanceof CompanionProviderOAuthError) {
    return error.code === "oauth_unavailable" ? 502 : 400;
  }
  if (error instanceof RuntimeDesktopClientError) {
    if (error.code === "not_configured") return 503;
    if (error.code === "forbidden") return 403;
    return 502;
  }
  if (error instanceof z.ZodError) return 400;
  return 400;
}

type ProposalDecisionMutation = "decision" | "routine" | "trigger";

function proposalDecisionDatabaseFailure(error: Error): boolean {
  if (error instanceof CompanionRoutineDecisionUpdateError
      || error instanceof CompanionTriggerDecisionUpdateError) return true;
  // Routine schedule validation and decision-domain errors expose short application codes too.
  // They must retain the normal route status/message rather than being mistaken for SQLSTATEs.
  if (error instanceof CompanionRoutineInvalidError
      || error instanceof CompanionDecisionConflictError
      || error instanceof CompanionDecisionNotFoundError
      || error instanceof z.ZodError) return false;
  const code = databaseErrorCode(error);
  if (code !== null && /^[0-9A-Z]{5}$/.test(code)) return true;
  // Keep lightweight route doubles and driver errors without a SQLSTATE bounded as well. The
  // normal validation/domain errors do not use these database-specific terms.
  return error instanceof Error
    && /failed query|database|postgres|sql|query|connection/i.test(error.message);
}

function proposalDecisionFailureResponse(
  c: Context,
  mutation: ProposalDecisionMutation,
  error: Error,
): Response {
  const custom = mutation === "routine"
    ? error instanceof CompanionRoutineDecisionUpdateError ? error : null
    : error instanceof CompanionTriggerDecisionUpdateError ? error : null;
  const code = databaseErrorCode(error);
  const status = custom?.httpStatus
    ?? (code === "42501"
      ? 403
      : code === "P0002" || code === "02000"
        ? 404
        : code === "23505" || code === "40001" || code === "55000"
          ? 409
          : code === "22023" || code === "P0001"
            ? 400
            : 500);
  const stableCode = mutation === "routine"
    ? "routine_update_failed"
    : mutation === "trigger"
      ? "trigger_update_failed"
      : "decision_update_failed";
  const message = mutation === "routine"
    ? "Unable to apply the routine proposal. Please try again."
    : mutation === "trigger"
      ? "Unable to apply the trigger proposal. Please try again."
      : "Unable to apply the decision. Please try again.";
  // SAFETY: the finite status calculation above only produces Hono-supported HTTP status codes.
  return c.json({ ok: false, error: message, code: stableCode }, status as never);
}

function routeError<T>(c: Context, error: T): Response {
  if (error instanceof CompanionProviderError) {
    const providerError = {
      ok: false,
      error: error.message,
      code: error.code,
      provider_id: error.providerId,
    };
    const status = errorStatus(error);
    // SAFETY: errorStatus only returns the status codes accepted by Hono; its numeric return type
    // cannot express that finite union to the framework's generic response overload.
    return c.json(providerError, status as never);
  }
  return jsonError(c, error, errorStatus(error));
}

function notificationDeviceRouteError<T>(c: Context, error: T): Response {
  const status = errorStatus(error);
  // Device-registration failures can originate in a database driver whose diagnostic contains
  // bound parameters. Keep this boundary deliberately opaque so an APNs token is never reflected
  // to the client or forwarded to server-error telemetry.
  // SAFETY: errorStatus returns only HTTP status values supported by Hono's response overload.
  return c.json({ error: "Notification device request failed" }, status as never);
}

/**
 * The largest multipart send body the API will read. It is the attachment budget plus room for the
 * form's own framing, so a request that would only be refused later is refused before it is buffered.
 */
const COMPANION_MESSAGE_UPLOAD_LIMIT_BYTES = 64 * 1024 * 1024;

/**
 * True for a failure raised by the object-storage client rather than by this route's own validation.
 * The AWS SDK stamps `$metadata` on every error it produces, which is what distinguishes it from a
 * `ZodError`, a domain error, or a database error.
 */
function isStorageFailure<T>(error: T): boolean {
  return z.object({ $metadata: z.object({}).passthrough() }).passthrough().safeParse(error).success;
}

/** One text field of a multipart send, or null when the part is absent or is a file. */
function formField(form: FormData, name: string): string | undefined {
  const value = form.get(name);
  const parsed = z.string().safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

export function registerCompanionRoutes(
  app: Hono<{ Variables: ApiVariables }>,
  env: NodeJS.ProcessEnv = process.env,
  dependencies: CompanionRouteDependencies = {},
): void {
  if (!companionsEnabled(env)) return;
  const transcriptionApiKey = env.COMPANION_GEMINI_TRANSCRIPTION_API_KEY?.trim() ?? "";
  const transcriptionAvailable = transcriptionApiKey.length > 0;

  const {
    actorFromContext,
    jsonError,
    orgIdFromContext,
    withTenantContext,
    putSkillArchive,
    getSkillArchive,
    deleteStorageObject,
    mintCompanionDesktop,
    answerCompanionConfigDecisionV2,
    answerCompanionDecisionV2,
    readCompanionAttachmentV2,
    cancelCompanionTurnV2,
    createCompanionV2,
    duplicateCompanionV2,
    enqueueCompanionOperationV2,
    enqueueCompanionTurnV2,
    getCompanionDecisionV2,
    getCompanion,
    getCompanionV2,
    listCompanionsV2,
    listCompanionRoutinesV2,
    listCompanionRoutineRunsV2,
    getCompanionRoutineRunV2,
    createCompanionRoutineV2,
    updateCompanionRoutineV2,
    deleteCompanionRoutineV2,
    createCompanionTranscriptionSession,
    transcribeCompanionAudio,
    answerCompanionRoutineDecisionV2,
    listCompanionTriggersV2,
    listCompanionTriggerProviderAccounts,
    listCompanionTriggerRunsV2,
    getCompanionTriggerRunV2,
    createCompanionTriggerV2,
    updateCompanionTriggerV2,
    deleteCompanionTriggerV2,
    rotateCompanionTriggerSecretV2,
    answerCompanionTriggerDecisionV2,
    registerCompanionTriggerWebhookV2,
    unregisterCompanionTriggerWebhookV2,
    disconnectCompanionTriggerProviderAccount,
    ensureOAuthCompanionTriggerProviderAccount,
    saveCompanionTriggerProviderAccount,
    readCompanionThreadChangesV2,
    readCompanionThreadProjectionSequenceV2,
    readCompanionThreadWindowV2,
    readCompanionThreadV2,
    syncCompanionThreadV2,
    setCompanionProviderV2,
    setCompanionWorkspaceShareV2,
    updateCompanionMemberStateV2,
    updateCompanionV2,
    resolveCompanionMcpBrokerAuthorization,
    resolveCompanionControlAuthorization,
    getCompanionControlRequest,
    decideCompanionControlRequest,
    finishCompanionControlRequest,
    enqueueCompanionControlContinuation,
    grantCompanionPeerAccess,
    listCompanionControlPeers,
    revokeCompanionPeerAccess,
    updateCompanionControlPlugin,
    issueCompanionMcpAccessToken,
    registerCompanionNotificationDevice,
    unregisterCompanionNotificationDevice,
    listCompanionSections,
    createCompanionSection,
    updateCompanionSection,
    deleteCompanionSection,
    reorderCompanionSections,
    assignCompanionSection,
  } = { ...defaultCompanionRouteDependencies(), ...dependencies };

  async function refreshCompanionTrigger(input: {
    orgId: string;
    companionId: string;
    triggerId: string;
    database: Db;
    fallback: CompanionTrigger;
  }): Promise<CompanionTrigger> {
    const triggers = await listCompanionTriggersV2({
      orgId: input.orgId,
      companionId: input.companionId,
      database: input.database,
      webhookBaseUrl: companionWebhookBaseUrl(env),
    });
    return triggers.find((trigger) => trigger.id === input.triggerId) ?? input.fallback;
  }

  async function autoRegisterCompanionTrigger(input: {
    orgId: string;
    companionId: string;
    trigger: CompanionTrigger;
    database: Db;
  }): Promise<CompanionTrigger> {
    const trigger = input.trigger;
    if (!supportsAutomaticTriggerRegistration(trigger)) return trigger;
    if (trigger.registration_status === "registered" && trigger.remote_hook_id) return trigger;

    let registration: Awaited<ReturnType<typeof registerCompanionTriggerWebhookV2>>;
    try {
      registration = await registerCompanionTriggerWebhookV2({
        orgId: input.orgId,
        companionId: input.companionId,
        triggerId: trigger.id,
        webhookBaseUrl: companionWebhookBaseUrl(env),
        masterKey: loadSecretsMasterKey(env.COMPANION_SECRETS_MASTER_KEY),
        database: input.database,
      });
    } catch (error) {
      // A missing target/account is a valid manually-managed trigger. Provider/auth failures are
      // surfaced by the registration helper when it can persist a failed lifecycle state.
      if (isOptionalTriggerRegistrationFailure(error)) return trigger;
      throw error;
    }

    if (registration.status === "manual") return trigger;
    return refreshCompanionTrigger({
      orgId: input.orgId,
      companionId: input.companionId,
      triggerId: trigger.id,
      database: input.database,
      fallback: {
        ...trigger,
        registration_status: registration.status,
        remote_hook_id: registration.status === "registered"
          ? registration.remote_hook_id
          : trigger.remote_hook_id ?? null,
        last_registration_error: registration.status === "failed"
          ? registration.error
          : trigger.last_registration_error ?? null,
      },
    });
  }

  async function unregisterCompanionTriggerIfWired(input: {
    orgId: string;
    companionId: string;
    trigger: CompanionTrigger;
    database: Db;
  }): Promise<void> {
    const trigger = input.trigger;
    if (!supportsAutomaticTriggerRegistration(trigger)) return;
    if (trigger.registration_status !== "registered" && !trigger.remote_hook_id) return;
    await unregisterCompanionTriggerWebhookV2({
      orgId: input.orgId,
      companionId: input.companionId,
      triggerId: trigger.id,
      webhookBaseUrl: companionWebhookBaseUrl(env),
      masterKey: loadSecretsMasterKey(env.COMPANION_SECRETS_MASTER_KEY),
      database: input.database,
    });
  }

  async function applyControlRequest(input: {
    actor: ReturnType<typeof actorFromContext>;
    orgId: string;
    companionId: string;
    request: Awaited<ReturnType<typeof getCompanionControlRequest>> & {};
    database: Db;
  }): Promise<Record<string, CompanionControlJsonValue>> {
    const request = companionControlRequestSchema.parse(input.request);
    if (request.kind === "model_change") {
      const body = z.object({ model_id: z.string().trim().min(1).max(200) }).strict()
        .parse(request.payload);
      const companion = await updateCompanionV2({
        actor: input.actor,
        orgId: input.orgId,
        companionId: input.companionId,
        patch: { model_id: body.model_id },
        database: input.database,
      });
      return { companion_id: companion.id, model_id: companion.model_id, apply_pending: true };
    }
    if (request.kind === "plugin_connection") {
      const body = z.object({
        provider: z.string().trim().min(1).max(80),
        reason: z.string().max(280).optional(),
      }).strict().parse(request.payload);
      return {
        provider: body.provider,
        oauth_required: true,
        oauth_start_path: "/v1/companion-plugins/oauth/start",
        companion_id: input.companionId,
      };
    }
    if (request.kind === "peer_access") {
      const body = z.object({
        target_companion_id: z.string().uuid(),
        target_name: z.string().trim().min(1).max(120),
      }).strict().parse(request.payload);
      const grant = await grantCompanionPeerAccess({
        orgId: input.orgId,
        sourceCompanionId: input.companionId,
        targetCompanionId: body.target_companion_id,
        targetName: body.target_name,
        database: input.database,
      });
      return { grant };
    }
    if (request.kind === "routine_change") {
      const body = companionRequestRoutineChangeInputSchema.parse(request.payload);
      if (body.action === "create") {
        const draft = companionRoutineDraftSchema.parse(body.draft);
        const routine = await createCompanionRoutineV2({
          orgId: input.orgId,
          companionId: input.companionId,
          id: request.id,
          ...draft,
          database: input.database,
        });
        return { routine };
      }
      if (!body.routine_id) throw new Error("routine id is required");
      if (body.action === "delete") {
        await deleteCompanionRoutineV2({
          orgId: input.orgId,
          companionId: input.companionId,
          routineId: body.routine_id,
          database: input.database,
        });
        return { routine_id: body.routine_id, deleted: true };
      }
      const routine = await updateCompanionRoutineV2({
        orgId: input.orgId,
        companionId: input.companionId,
        routineId: body.routine_id,
        ...(body.action === "enable" ? { enabled: true }
          : body.action === "disable" ? { enabled: false }
            : body.draft ?? {}),
        database: input.database,
      });
      return { routine };
    }
    const body = companionRequestTriggerChangeInputSchema.parse(request.payload);
    if (body.action === "create") {
      const draft = companionTriggerDraftSchema.parse(body.draft);
      const created = await createCompanionTriggerV2({
        orgId: input.orgId,
        companionId: input.companionId,
        id: request.id,
        name: draft.name,
        prompt: draft.prompt,
        mode: draft.mode,
        provider: draft.provider,
        providerAccountId: draft.provider_account_id,
        target: draft.target ?? null,
        enabled: draft.enabled,
        database: input.database,
        webhookBaseUrl: companionWebhookBaseUrl(env),
      });
      return { trigger: redactCompanionControlTrigger(await autoRegisterCompanionTrigger({
        orgId: input.orgId,
        companionId: input.companionId,
        trigger: created,
        database: input.database,
      })) };
    }
    if (!body.trigger_id) throw new Error("trigger id is required");
    const current = (await listCompanionTriggersV2({
      orgId: input.orgId,
      companionId: input.companionId,
      database: input.database,
      webhookBaseUrl: companionWebhookBaseUrl(env),
    })).find((candidate) => candidate.id === body.trigger_id);
    if (body.action === "delete") {
      if (current) await unregisterCompanionTriggerIfWired({
        orgId: input.orgId,
        companionId: input.companionId,
        trigger: current,
        database: input.database,
      });
      await deleteCompanionTriggerV2({
        orgId: input.orgId,
        companionId: input.companionId,
        triggerId: body.trigger_id,
        database: input.database,
      });
      return { trigger_id: body.trigger_id, deleted: true };
    }
    if (body.action === "rotate_secret") {
      const trigger = await rotateCompanionTriggerSecretV2({
        orgId: input.orgId,
        companionId: input.companionId,
        triggerId: body.trigger_id,
        webhookBaseUrl: companionWebhookBaseUrl(env),
        database: input.database,
      });
      return { trigger: redactCompanionControlTrigger(trigger) };
    }
    const registrationChanged = body.action === "update"
      && body.draft !== undefined
      && (body.draft.provider !== undefined
        || body.draft.target !== undefined
        || body.draft.provider_account_id !== undefined);
    if (registrationChanged && current) await unregisterCompanionTriggerIfWired({
      orgId: input.orgId,
      companionId: input.companionId,
      trigger: current,
      database: input.database,
    });
    const updated = await updateCompanionTriggerV2({
      orgId: input.orgId,
      companionId: input.companionId,
      triggerId: body.trigger_id,
      ...(body.action === "enable" ? { enabled: true }
        : body.action === "disable" ? { enabled: false }
          : {
              ...body.draft,
              providerAccountId: body.draft?.provider_account_id,
              target: body.draft?.target,
            }),
      database: input.database,
      webhookBaseUrl: companionWebhookBaseUrl(env),
    });
    return { trigger: redactCompanionControlTrigger(await autoRegisterCompanionTrigger({
      orgId: input.orgId,
      companionId: input.companionId,
      trigger: updated,
      database: input.database,
    })) };
  }

  async function tenant<T>(
    c: Context<{ Variables: ApiVariables }>,
    fn: (input: {
      actor: ReturnType<typeof actorFromContext>;
      orgId: string;
      database: Db;
    }) => Promise<T>,
  ): Promise<T> {
    const actor = actorFromContext(c);
    if (!companionsAvailableToUser(actor.email, env)) {
      throw new CompanionAccessForbiddenError();
    }
    const orgId = await orgIdFromContext(c);
    return withTenantContext({ orgId, userId: actor.id }, (database) =>
      fn({ actor, orgId, database }));
  }

  app.post("/v1/runtime/mcp-access-token", async (c) => {
    try {
      const bearer = bearerFromHeader(c.req.header("authorization"));
      if (!bearer) throw new CompanionMcpBrokerAuthorizationError();
      const authorization = await resolveCompanionMcpBrokerAuthorization(bearer);
      if (!authorization) throw new CompanionMcpBrokerAuthorizationError();
      const body = companionMcpAccessTokenInputSchema.parse(await c.req.json());
      const result = await withTenantContext({
        orgId: authorization.orgId,
        userId: authorization.actorId,
      }, async (database) => await issueCompanionMcpAccessToken({
        authorization,
        accountId: body.account_id,
        credentialGeneration: body.credential_generation,
        forceRefresh: body.force_refresh,
        masterKey: loadSecretsMasterKey(env.COMPANION_SECRETS_MASTER_KEY),
        database,
      }));
      if (result === null) {
        throw new CompanionPluginOAuthError(
          "The MCP authorization could not be refreshed. Reconnect it in Plugins.",
          "oauth_refresh_failed",
        );
      }
      c.header("Cache-Control", "private, no-store");
      c.header("Pragma", "no-cache");
      return c.json(companionMcpAccessTokenSchema.parse(result));
    } catch (error) {
      c.header("Cache-Control", "private, no-store");
      if (error instanceof CompanionMcpBrokerAuthorizationError) {
        return c.json({ error: "MCP authorization is unavailable" }, 401);
      }
      if (error instanceof CompanionPluginOAuthError) {
        return c.json({ error: "MCP authorization could not be refreshed" }, 503);
      }
      return c.json({ error: "MCP authorization is unavailable" }, 400);
    }
  });

  app.post("/v1/runtime/companion-control", async (c) => {
    try {
      const bearer = bearerFromHeader(c.req.header("authorization"));
      if (!bearer) throw new CompanionControlAuthorizationError();
      const authorization = await resolveCompanionControlAuthorization(bearer);
      if (!authorization) throw new CompanionControlAuthorizationError();
      const raw = await c.req.json();
      const result = await withTenantContext({
        orgId: authorization.orgId,
        userId: authorization.actorId,
      }, async (database) => await executeCompanionControlMcp({ raw, authorization, database }));
      c.header("Cache-Control", "private, no-store");
      c.header("Pragma", "no-cache");
      return c.json(result);
    } catch (error) {
      c.header("Cache-Control", "private, no-store");
      if (error instanceof CompanionControlAuthorizationError) {
        return c.json({ error: "Companion control authorization is unavailable" }, 401);
      }
      return c.json({ error: "Companion control request is unavailable" }, 400);
    }
  });

  app.put("/v1/notification-devices/:installationId", async (c) => {
    try {
      const installationId = notificationInstallationIdSchema.parse(c.req.param("installationId"));
      const registration = notificationDeviceRegistrationSchema.parse(await c.req.json());
      await tenant(c, ({ orgId, database }) => registerCompanionNotificationDevice({
        orgId,
        installationId,
        registration,
        database,
      }));
      return c.body(null, 204);
    } catch (error) {
      return notificationDeviceRouteError(c, error);
    }
  });

  app.delete("/v1/notification-devices/:installationId", async (c) => {
    try {
      const installationId = notificationInstallationIdSchema.parse(c.req.param("installationId"));
      await tenant(c, ({ orgId, database }) => unregisterCompanionNotificationDevice({
        orgId,
        installationId,
        database,
      }));
      return c.body(null, 204);
    } catch (error) {
      return notificationDeviceRouteError(c, error);
    }
  });

  app.get("/v1/companion-sections", async (c) => {
    try {
      const sections = await tenant(c, ({ actor, orgId, database }) =>
        listCompanionSections({ actor, orgId, database }));
      c.header("Cache-Control", "private, no-store");
      return c.json({ sections });
    } catch (error) {
      return routeError(c, error);
    }
  });

  app.post("/v1/companion-sections", async (c) => {
    try {
      const body = createCompanionSectionInputSchema.parse(await c.req.json());
      const section = await tenant(c, ({ actor, orgId, database }) =>
        createCompanionSection({ actor, orgId, name: body.name, database }));
      return c.json({ section }, 201);
    } catch (error) {
      return routeError(c, error);
    }
  });

  app.patch("/v1/companion-sections/:id", async (c) => {
    try {
      const sectionId = companionIdSchema.parse(c.req.param("id"));
      const body = updateCompanionSectionInputSchema.parse(await c.req.json());
      const section = await tenant(c, ({ actor, orgId, database }) =>
        updateCompanionSection({ actor, orgId, sectionId, name: body.name, database }));
      return c.json({ section });
    } catch (error) {
      return routeError(c, error);
    }
  });

  app.delete("/v1/companion-sections/:id", async (c) => {
    try {
      const sectionId = companionIdSchema.parse(c.req.param("id"));
      const unassignedCount = await tenant(c, ({ actor, orgId, database }) =>
        deleteCompanionSection({ actor, orgId, sectionId, database }));
      return c.json({ ok: true, unassigned_count: unassignedCount });
    } catch (error) {
      return routeError(c, error);
    }
  });

  app.put("/v1/companion-sections/reorder", async (c) => {
    try {
      const body = reorderCompanionSectionsInputSchema.parse(await c.req.json());
      const sections = await tenant(c, ({ actor, orgId, database }) =>
        reorderCompanionSections({ actor, orgId, sectionIds: body.section_ids, database }));
      return c.json({ sections });
    } catch (error) {
      return routeError(c, error);
    }
  });

  app.put("/v1/companions/:id/section", async (c) => {
    try {
      const companionId = companionIdSchema.parse(c.req.param("id"));
      const body = assignCompanionSectionInputSchema.parse(await c.req.json());
      const companion = await tenant(c, ({ actor, orgId, database }) =>
        assignCompanionSection({
          actor,
          orgId,
          companionId,
          sectionId: body.section_id,
          database,
        }));
      return c.json({ companion });
    } catch (error) {
      return routeError(c, error);
    }
  });

  app.get("/v1/companions", async (c) => {
    try {
      // `preview=false` answers with the roster and nothing anyone said. It is for a caller that
      // needs names and attachments — the Skills page asking which Companions stage a skill — and
      // keeps chat text off a surface that displays none of it.
      const withLastMessage = c.req.query("preview") !== "false";
      const companions = await tenant(c, ({ actor, orgId, database }) =>
        listCompanionsV2({ actor, orgId, withLastMessage, database }));
      // The list carries each thread's last line now, so it is chat text and must not sit in a disk
      // cache after the session that read it, the way every other sensitive read here is treated.
      c.header("Cache-Control", "private, no-store");
      return c.json({ companions });
    } catch (error) {
      return jsonError(c, error, errorStatus(error));
    }
  });

  app.get("/v1/companions/sync", async (c) => {
    try {
      const query = companionSyncQuerySchema.parse({ cursor: c.req.query("cursor") });
      const sync = await tenant(c, async ({ actor, orgId, database }) => {
        if (query.cursor) {
          validateCompanionSyncCursor({
            cursor: query.cursor,
            kind: "roster",
            orgId,
            actorId: actor.id,
          });
        }
        const [companions, sections] = await Promise.all([
          listCompanionsV2({ actor, orgId, withLastMessage: true, database }),
          listCompanionSections({ actor, orgId, database }),
        ]);
        return buildCompanionRosterSync({
          orgId,
          actorId: actor.id,
          companions,
          sections,
          cursor: query.cursor,
        });
      });
      c.header("Cache-Control", "private, no-store");
      return c.json(sync);
    } catch (error) {
      return routeError(c, error);
    }
  });

  app.post("/v1/companions", async (c) => {
    try {
      const body = createCompanionInputSchema.parse(await c.req.json());
      const companion = await tenant(c, ({ actor, orgId, database }) =>
        createCompanionV2({
          actor,
          orgId,
          name: body.name,
          persona: body.persona,
          providerId: body.provider_id,
          modelId: body.model_id,
          selectedSkillIds: body.selected_skill_ids,
          selectedMcpAccountIds: body.selected_mcp_account_ids,
          icon: body.icon,
          database,
        }));
      return c.json({ companion }, 201);
    } catch (error) {
      return routeError(c, error);
    }
  });

  app.post(
    "/v1/companions/:id/transcription-sessions",
    async (c, next) => {
      try {
        actorFromContext(c);
      } catch (error) {
        return routeError(c, error);
      }
      await next();
    },
    bodyLimit({
      maxSize: 1024,
      onError: (c) => jsonError(c, "transcription session request exceeds the 1 KB limit", 413),
    }),
    async (c) => {
      c.header("Cache-Control", "private, no-store");
      c.header("Pragma", "no-cache");
      const transcriptionDiagnostics = createCompanionTranscriptionDiagnostics();
      try {
        const companionId = companionIdSchema.parse(c.req.param("id"));
        const rawBody = await c.req.text();
        createCompanionTranscriptionSessionInputSchema.parse(
          rawBody.trim().length === 0 ? {} : JSON.parse(rawBody),
        );
        const session = await tenant(c, async ({ actor, orgId, database }) => {
          const companion = await getCompanion({ actor, orgId, companionId, database });
          if (companion.access === "viewer") throw new CompanionRuntimeForbiddenError();
          return await createCompanionTranscriptionSession({
            actor,
            orgId,
            companionId,
            companion,
            apiKey: transcriptionApiKey,
            database,
            fetchImpl: transcriptionDiagnostics.fetchImpl,
          });
        });
        return c.json(companionTranscriptionSessionSchema.parse(session));
      } catch (error) {
        transcriptionDiagnostics.reportInvalidResponse();
        return routeError(c, error);
      }
    },
  );

  app.post(
    "/v1/companions/:id/transcriptions",
    async (c, next) => {
      try {
        actorFromContext(c);
        const companionId = companionIdSchema.parse(c.req.param("id"));
        await tenant(c, async ({ actor, orgId, database }) => {
          const companion = await getCompanion({ actor, orgId, companionId, database });
          if (companion.access === "viewer") throw new CompanionRuntimeForbiddenError();
        });
      } catch (error) {
        return routeError(c, error);
      }
      await next();
    },
    bodyLimit({
      maxSize: COMPANION_TRANSCRIPTION_AUDIO_MAX_BYTES + 128 * 1024,
      onError: (c) => jsonError(c, "voice recording exceeds the 8 MB limit", 413),
    }),
    async (c) => {
      c.header("Cache-Control", "private, no-store");
      c.header("Pragma", "no-cache");
      const transcriptionDiagnostics = createCompanionTranscriptionDiagnostics();
      try {
        const companionId = companionIdSchema.parse(c.req.param("id"));
        if (!(c.req.header("content-type") ?? "").includes("multipart/form-data")) {
          return jsonError(c, "voice transcription requires multipart audio", 400);
        }
        const form = await c.req.formData();
        const audioParts = form.getAll("audio");
        if ([...form.keys()].some((key) => key !== "audio")
          || audioParts.length !== 1
          || !(audioParts[0] instanceof File)) {
          return jsonError(c, "voice transcription requires exactly one audio file", 400);
        }
        const file = audioParts[0];
        if (file.type !== COMPANION_TRANSCRIPTION_AUDIO_CONTENT_TYPE
          || file.size === 0
          || file.size > COMPANION_TRANSCRIPTION_AUDIO_MAX_BYTES) {
          return jsonError(c, "voice recording is missing or unsupported", 400);
        }
        const audio = Buffer.from(await file.arrayBuffer());
        if (audio.length < 12 || audio.subarray(4, 8).toString("ascii") !== "ftyp") {
          return jsonError(c, "voice recording is missing or unsupported", 400);
        }
        const transcription = await tenant(c, async ({ actor, orgId, database }) => {
          const companion = await getCompanion({ actor, orgId, companionId, database });
          if (companion.access === "viewer") throw new CompanionRuntimeForbiddenError();
          return await transcribeCompanionAudio({
            actor,
            orgId,
            companionId,
            companion,
            audio,
            contentType: COMPANION_TRANSCRIPTION_AUDIO_CONTENT_TYPE,
            apiKey: transcriptionApiKey,
            database,
            fetchImpl: transcriptionDiagnostics.fetchImpl,
          });
        });
        return c.json(companionTranscriptionSchema.parse(transcription));
      } catch (error) {
        transcriptionDiagnostics.reportInvalidResponse();
        return routeError(c, error);
      }
    },
  );

  app.get("/v1/companion-providers", async (c) => {
    try {
      const providers = await tenant(c, ({ actor, orgId, database }) =>
        listCompanionProviders({ actor, orgId, database }));
      return c.json(providers);
    } catch (error) {
      return routeError(c, error);
    }
  });

  app.post("/v1/companion-providers/oauth/start", async (c) => {
    try {
      const body = companionProviderOAuthStartInputSchema.parse(await c.req.json());
      const context = await tenant(c, async ({ actor, orgId, database }) => {
        const providers = await listCompanionProviders({ actor, orgId, database });
        if (!providers.can_manage) throw new CompanionProviderForbiddenError();
        return { actor, orgId };
      });
      const masterKey = loadSecretsMasterKey(env.COMPANION_SECRETS_MASTER_KEY);
      const storePendingFlow = (
        flow: Parameters<typeof encodeCompanionProviderOAuthFlow>[0]["flow"],
      ) => {
        setCookie(c, COMPANION_PROVIDER_OAUTH_COOKIE, encodeCompanionProviderOAuthFlow({
          orgId: context.orgId,
          userId: context.actor.id,
          flow,
          masterKey,
        }), {
          path: "/v1/companion-providers/oauth",
          httpOnly: true,
          sameSite: "Lax",
          secure: env.NODE_ENV === "production",
          maxAge: COMPANION_PROVIDER_OAUTH_TTL_MS / 1000,
        });
      };
      if (body.provider_id === "anthropic") {
        const started = beginAnthropicProviderOAuth();
        storePendingFlow(started.flow);
        return c.json({
          flow: "authorization_code",
          provider_id: "anthropic",
          authorization_url: started.authorizationUrl,
        });
      }
      const started = await beginOpenAICodexProviderOAuth();
      storePendingFlow(started.flow);
      return c.json({
        flow: "device_code",
        provider_id: "openai-codex",
        verification_url: started.verificationUrl,
        user_code: started.userCode,
        poll_interval_seconds: started.pollIntervalSeconds,
        expires_at: new Date(started.flow.expiresAt).toISOString(),
      });
    } catch (error) {
      return routeError(c, error);
    }
  });

  app.post("/v1/companion-providers/oauth/complete", async (c) => {
    try {
      const body = companionProviderOAuthCompleteInputSchema.parse(await c.req.json());
      const context = await tenant(c, async ({ actor, orgId, database }) => {
        const providers = await listCompanionProviders({ actor, orgId, database });
        if (!providers.can_manage) throw new CompanionProviderForbiddenError();
        return { actor, orgId };
      });
      const masterKey = loadSecretsMasterKey(env.COMPANION_SECRETS_MASTER_KEY);
      const cookie = getCookie(c, COMPANION_PROVIDER_OAUTH_COOKIE);
      if (!cookie) {
        throw new CompanionProviderOAuthError("oauth_expired", "Provider sign-in expired. Start again.");
      }
      const pending = decodeCompanionProviderOAuthFlow({ value: cookie, masterKey });
      if (
        pending.userId !== context.actor.id
        || pending.orgId !== context.orgId
        || pending.flow.providerId !== "anthropic"
      ) {
        throw new CompanionProviderOAuthError("oauth_invalid", "Provider sign-in does not match this workspace.");
      }
      const credential = await completeAnthropicProviderOAuth({
        flow: pending.flow,
        authorizationInput: body.authorization_code,
      });
      const connection = await withTenantContext(
        { orgId: context.orgId, userId: context.actor.id },
        (database) => saveCompanionProvider({
          actor: context.actor,
          orgId: context.orgId,
          providerId: "anthropic",
          authMethod: "subscription",
          credential,
          masterKey,
          database,
        }),
      );
      setCookie(c, COMPANION_PROVIDER_OAUTH_COOKIE, "", {
        path: "/v1/companion-providers/oauth",
        maxAge: 0,
        httpOnly: true,
        sameSite: "Lax",
        secure: env.NODE_ENV === "production",
      });
      return c.json({ connection });
    } catch (error) {
      return routeError(c, error);
    }
  });

  app.post("/v1/companion-providers/oauth/poll", async (c) => {
    let clearCookieOnFailure = false;
    try {
      const context = await tenant(c, async ({ actor, orgId, database }) => {
        const providers = await listCompanionProviders({ actor, orgId, database });
        if (!providers.can_manage) throw new CompanionProviderForbiddenError();
        return { actor, orgId };
      });
      clearCookieOnFailure = true;
      const masterKey = loadSecretsMasterKey(env.COMPANION_SECRETS_MASTER_KEY);
      const cookie = getCookie(c, COMPANION_PROVIDER_OAUTH_COOKIE);
      if (!cookie) {
        throw new CompanionProviderOAuthError("oauth_expired", "Provider sign-in expired. Start again.");
      }
      const pending = decodeCompanionProviderOAuthFlow({ value: cookie, masterKey });
      if (
        pending.userId !== context.actor.id
        || pending.orgId !== context.orgId
        || pending.flow.providerId !== "openai-codex"
      ) {
        throw new CompanionProviderOAuthError("oauth_invalid", "Provider sign-in does not match this workspace.");
      }
      const result = await pollOpenAICodexProviderOAuth({ flow: pending.flow });
      if (result.status === "pending") return c.json({ status: "pending" }, 202);
      const connection = await withTenantContext(
        { orgId: context.orgId, userId: context.actor.id },
        (database) => saveCompanionProvider({
          actor: context.actor,
          orgId: context.orgId,
          providerId: "openai-codex",
          authMethod: "subscription",
          credential: result.credential,
          masterKey,
          database,
        }),
      );
      setCookie(c, COMPANION_PROVIDER_OAUTH_COOKIE, "", {
        path: "/v1/companion-providers/oauth",
        maxAge: 0,
        httpOnly: true,
        sameSite: "Lax",
        secure: env.NODE_ENV === "production",
      });
      return c.json({ status: "connected", connection });
    } catch (error) {
      if (
        clearCookieOnFailure
        && (!(error instanceof CompanionProviderOAuthError) || error.code !== "oauth_unavailable")
      ) {
        setCookie(c, COMPANION_PROVIDER_OAUTH_COOKIE, "", {
          path: "/v1/companion-providers/oauth",
          maxAge: 0,
          httpOnly: true,
          sameSite: "Lax",
          secure: env.NODE_ENV === "production",
        });
      }
      return routeError(c, error);
    }
  });

  app.get("/v1/companion-plugins", async (c) => {
    try {
      const accounts = await tenant(c, ({ actor, orgId, database }) =>
        listCompanionPlugins({ actor, orgId, database }));
      return c.json({ accounts });
    } catch (error) {
      return routeError(c, error);
    }
  });

  app.post("/v1/companion-plugins", async (c) => {
    try {
      const body = saveCompanionPluginInputSchema.parse(await c.req.json());
      const account = await tenant(c, ({ actor, orgId, database }) =>
        saveCompanionPlugin({ actor, orgId, plugin: body, database }));
      return c.json({ account }, 201);
    } catch (error) {
      return routeError(c, error);
    }
  });

  app.post("/v1/companion-plugins/trigger-key", async (c) => {
    try {
      const body = z.object({
        provider: z.literal("linear"),
        credential: z.string().min(1).max(256),
      }).parse(await c.req.json());
      const account = await tenant(c, ({ actor, orgId, database }) =>
        saveCompanionTriggerProviderAccount({
          actor,
          orgId,
          account: { provider: body.provider, label: "Linear", credential: body.credential },
          masterKey: loadSecretsMasterKey(env.COMPANION_SECRETS_MASTER_KEY),
          database,
        }));
      return c.json({ stored: true, account });
    } catch (error) {
      return routeError(c, error);
    }
  });

  app.post("/v1/companion-plugins/oauth/start", async (c) => {
    try {
      const body = companionPluginOAuthStartInputSchema.parse(await c.req.json());
      const catalog = COMPANION_PLUGIN_OAUTH_SERVERS[body.server_name];
      const context = await tenant(c, async ({ actor, orgId, database }) => {
        if (body.companion_id && body.control_request_id) {
          const [companion, request] = await Promise.all([
            getCompanionV2({ actor, orgId, companionId: body.companion_id, database }),
            getCompanionControlRequest({
              orgId,
              companionId: body.companion_id,
              requestId: body.control_request_id,
              database,
            }),
          ]);
          if (companion.access === "viewer"
            || request?.kind !== "plugin_connection"
            || request.status !== "applied"
            || request.payload.provider !== catalog.provider) {
            throw new CompanionAccessForbiddenError();
          }
        }
        return {
          actor,
          orgId,
          accounts: await listCompanionPlugins({ actor, orgId, database }),
        };
      });
      if (context.accounts.some((account) =>
        account.provider === catalog.provider
        && account.label.toLocaleLowerCase("en-US") === body.label.toLocaleLowerCase("en-US"))) {
        throw new CompanionPluginConflictError();
      }
      const masterKey = loadSecretsMasterKey(env.COMPANION_SECRETS_MASTER_KEY);
      const nonce = randomUUID();
      const oauthState = {
        orgId: context.orgId,
        userId: context.actor.id,
        nonce,
        expiresAt: Date.now() + COMPANION_PLUGIN_OAUTH_TTL_MS,
        companionId: body.companion_id,
        controlRequestId: body.control_request_id,
      };
      const state = signCompanionPluginOAuthState(oauthState, masterKey);
      const redirectUri = companionPluginOAuthRedirectUri(env);
      const started = await beginCompanionPluginOAuth({
        serverName: body.server_name,
        redirectUri,
        state,
        env,
      });
      setCookie(c, companionPluginOAuthCookieName(nonce), encodeCompanionPluginOAuthFlow({
        orgId: context.orgId,
        nonce,
        value: { label: body.label, flow: started.flow },
        masterKey,
      }), {
        path: "/v1/companion-plugins/oauth/callback",
        httpOnly: true,
        sameSite: "Lax",
        secure: env.NODE_ENV === "production",
        maxAge: COMPANION_PLUGIN_OAUTH_TTL_MS / 1000,
      });
      return c.json({ authorization_url: started.authorizationUrl });
    } catch (error) {
      return routeError(c, error);
    }
  });

  app.get("/v1/companion-plugins/oauth/callback", async (c) => {
    const web = env.COMPANION_WEB_URL ?? "http://127.0.0.1:3000";
    let cookieName: string | null = null;
    try {
      const actor = actorFromContext(c);
      if (!companionsAvailableToUser(actor.email, env)) {
        throw new CompanionAccessForbiddenError();
      }
      const masterKey = loadSecretsMasterKey(env.COMPANION_SECRETS_MASTER_KEY);
      const state = verifyCompanionPluginOAuthState(c.req.query("state") ?? "", masterKey);
      cookieName = companionPluginOAuthCookieName(state.nonce);
      if (actor.id !== state.userId) throw new Error("OAuth authorization session does not match");
      const cookie = getCookie(c, cookieName);
      if (!cookie) throw new Error("OAuth authorization session expired");
      if (c.req.query("error")) throw new Error("OAuth authorization was denied");
      const pending = decodeCompanionPluginOAuthFlow({
        orgId: state.orgId,
        nonce: state.nonce,
        value: cookie,
        masterKey,
      });
      const code = c.req.query("code");
      if (!code) throw new Error("OAuth provider did not return an authorization code");
      const credential = await completeCompanionPluginOAuth({
        flow: pending.flow,
        code,
        redirectUri: companionPluginOAuthRedirectUri(env),
      });
      await withTenantContext(
        { orgId: state.orgId, userId: actor.id },
        async (database) => {
          const mcpAccount = await saveCompanionOAuthPlugin({
            actor,
            orgId: state.orgId,
            provider: pending.flow.provider,
            label: pending.label,
            remoteUrl: pending.flow.remoteUrl,
            credential,
            masterKey,
            database,
          });
          await ensureOAuthCompanionTriggerProviderAccount({
            actor,
            orgId: state.orgId,
            mcpAccountId: mcpAccount.id,
            provider: pending.flow.provider,
            label: pending.label,
            database,
          });
          if (state.companionId && state.controlRequestId) {
            await updateCompanionControlPlugin({
              actor,
              orgId: state.orgId,
              companionId: state.companionId,
              accountId: mcpAccount.id,
              selected: true,
              database,
            });
            await enqueueCompanionControlContinuation({
              orgId: state.orgId,
              companionId: state.companionId,
              requestId: state.controlRequestId,
              content: `${pending.flow.provider} is now connected and attached. Continue the task using the newly available plugin.`,
              database,
            });
          }
        },
      );
      setCookie(c, "companion_org", state.orgId, {
        path: "/",
        sameSite: "Lax",
        secure: env.NODE_ENV === "production",
      });
      const target = new URL("/companions", web);
      target.searchParams.set("view", "plugins");
      target.searchParams.set("oauth", "connected");
      target.searchParams.set("provider", pending.flow.provider);
      setCookie(c, cookieName, "", {
        path: "/v1/companion-plugins/oauth/callback",
        maxAge: 0,
        httpOnly: true,
        sameSite: "Lax",
        secure: env.NODE_ENV === "production",
      });
      return c.redirect(target.toString(), 303);
    } catch (error) {
      if (cookieName) {
        setCookie(c, cookieName, "", {
          path: "/v1/companion-plugins/oauth/callback",
          maxAge: 0,
          httpOnly: true,
          sameSite: "Lax",
          secure: env.NODE_ENV === "production",
        });
      }
      const target = new URL("/companions", web);
      target.searchParams.set("view", "plugins");
      target.searchParams.set(
        "oauth_error",
        error instanceof CompanionPluginConflictError ? "duplicate_label" : "authorization_failed",
      );
      return c.redirect(target.toString(), 303);
    }
  });

  app.delete("/v1/companion-plugins/:id", async (c) => {
    try {
      const accountId = companionIdSchema.parse(c.req.param("id"));
      await tenant(c, ({ actor, orgId, database }) =>
        deleteCompanionPlugin({ actor, orgId, accountId, database }));
      return c.json({ ok: true });
    } catch (error) {
      return routeError(c, error);
    }
  });

  app.get("/v1/companion-trigger-provider-accounts", async (c) => {
    try {
      const accounts = await tenant(c, ({ actor, orgId, database }) =>
        listCompanionTriggerProviderAccounts({ actor, orgId, database }));
      c.header("Cache-Control", "private, no-store");
      return c.json({ accounts });
    } catch (error) {
      return routeError(c, error);
    }
  });

  app.post("/v1/companion-trigger-provider-accounts", async (c) => {
    try {
      const body = createCompanionTriggerProviderAccountInputSchema.parse(await c.req.json());
      const account = await tenant(c, ({ actor, orgId, database }) =>
        saveCompanionTriggerProviderAccount({
          actor,
          orgId,
          account: body,
          masterKey: loadSecretsMasterKey(env.COMPANION_SECRETS_MASTER_KEY),
          database,
        }));
      c.header("Cache-Control", "private, no-store");
      return c.json({ account }, 201);
    } catch (error) {
      return routeError(c, error);
    }
  });

  app.delete("/v1/companion-trigger-provider-accounts/:id", async (c) => {
    try {
      const accountId = companionIdSchema.parse(c.req.param("id"));
      const account = await tenant(c, ({ actor, orgId, database }) =>
        disconnectCompanionTriggerProviderAccount({ actor, orgId, accountId, database }));
      c.header("Cache-Control", "private, no-store");
      return c.json({ account });
    } catch (error) {
      return routeError(c, error);
    }
  });

  app.put("/v1/companion-providers/default", async (c) => {
    try {
      const body = setDefaultCompanionProviderInputSchema.parse(await c.req.json());
      await tenant(c, ({ actor, orgId, database }) =>
        setDefaultCompanionProvider({
          actor,
          orgId,
          providerId: body.provider_id,
          database,
        }));
      return c.json({ ok: true });
    } catch (error) {
      return routeError(c, error);
    }
  });

  app.put("/v1/companion-providers/:provider", async (c) => {
    try {
      const providerId = companionProviderIdSchema.parse(c.req.param("provider"));
      const body = saveCompanionProviderInputSchema.parse(await c.req.json());
      const connection = await tenant(c, ({ actor, orgId, database }) =>
        saveCompanionProvider({
          actor,
          orgId,
          providerId,
          authMethod: body.auth_method,
          credential: body.credential,
          database,
        }));
      return c.json({ connection });
    } catch (error) {
      return routeError(c, error);
    }
  });

  app.delete("/v1/companion-providers/:provider", async (c) => {
    try {
      const providerId = companionProviderIdSchema.parse(c.req.param("provider"));
      await tenant(c, ({ actor, orgId, database }) =>
        deleteCompanionProvider({ actor, orgId, providerId, database }));
      return c.json({ ok: true });
    } catch (error) {
      return routeError(c, error);
    }
  });

  app.get("/v1/companions/:id", async (c) => {
    try {
      const companionId = companionIdSchema.parse(c.req.param("id"));
      const companion = await tenant(c, ({ actor, orgId, database }) =>
        getCompanionV2({ actor, orgId, companionId, withLastMessage: true, database }));
      c.header("Cache-Control", "private, no-store");
      return c.json({ companion });
    } catch (error) {
      return routeError(c, error);
    }
  });

  app.patch("/v1/companions/:id/member-state", async (c) => {
    try {
      const companionId = companionIdSchema.parse(c.req.param("id"));
      const patch = updateCompanionMemberStateInputSchema.parse(await c.req.json());
      const companion = await tenant(c, ({ actor, orgId, database }) =>
        updateCompanionMemberStateV2({ actor, orgId, companionId, patch, database }));
      return c.json({ companion });
    } catch (error) {
      return routeError(c, error);
    }
  });

  app.post("/v1/companions/:id/duplicate", async (c) => {
    try {
      const companionId = companionIdSchema.parse(c.req.param("id"));
      const companion = await tenant(c, ({ actor, orgId, database }) =>
        duplicateCompanionV2({ actor, orgId, companionId, database }));
      return c.json({ companion }, 201);
    } catch (error) {
      return routeError(c, error);
    }
  });

  app.patch("/v1/companions/:id", async (c) => {
    try {
      const companionId = companionIdSchema.parse(c.req.param("id"));
      const body = updateCompanionInputSchema.parse(await c.req.json());
      const patch: CompanionUpdatePatch = {};
      if (body.name !== undefined) patch.name = body.name;
      if (body.persona !== undefined) patch.persona = body.persona;
      if (body.provider_id !== undefined) patch.provider_id = body.provider_id;
      if (body.model_id !== undefined) patch.model_id = body.model_id;
      if (body.selected_skill_ids !== undefined) patch.selected_skill_ids = body.selected_skill_ids;
      if (body.selected_mcp_account_ids !== undefined) {
        patch.selected_mcp_account_ids = body.selected_mcp_account_ids;
      }
      if (body.icon !== undefined) patch.icon = body.icon;
      const companion = await tenant(c, ({ actor, orgId, database }) =>
        updateCompanionV2({ actor, orgId, companionId, patch, database }));
      return c.json({ companion });
    } catch (error) {
      return routeError(c, error);
    }
  });

  app.get("/v1/companions/:id/routines", async (c) => {
    try {
      const companionId = companionIdSchema.parse(c.req.param("id"));
      const routines = await tenant(c, ({ orgId, database }) =>
        listCompanionRoutinesV2({ orgId, companionId, database }));
      c.header("Cache-Control", "private, no-store");
      return c.json({ routines });
    } catch (error) {
      return routeError(c, error);
    }
  });

  app.get("/v1/companions/:id/routines/:routineId/runs", async (c) => {
    try {
      const companionId = companionIdSchema.parse(c.req.param("id"));
      const routineId = companionIdSchema.parse(c.req.param("routineId"));
      const query = companionRoutineRunListQuerySchema.parse({
        limit: c.req.query("limit"),
        cursor: c.req.query("cursor"),
      });
      const history = await tenant(c, ({ orgId, database }) =>
        listCompanionRoutineRunsV2({
          orgId,
          companionId,
          routineId,
          limit: query.limit,
          cursor: query.cursor,
          database,
        }));
      c.header("Cache-Control", "private, no-store");
      return c.json(history);
    } catch (error) {
      return routeError(c, error);
    }
  });

  app.get("/v1/companions/:id/routine-runs/:runId", async (c) => {
    try {
      const companionId = companionIdSchema.parse(c.req.param("id"));
      const runId = companionIdSchema.parse(c.req.param("runId"));
      const query = companionRoutineRunDetailQuerySchema.parse({
        entry_limit: c.req.query("entry_limit"),
        entry_cursor: c.req.query("entry_cursor"),
      });
      const run = await tenant(c, ({ orgId, database }) =>
        getCompanionRoutineRunV2({
          orgId,
          companionId,
          runId,
          entryLimit: query.entry_limit,
          entryCursor: query.entry_cursor,
          database,
        }));
      c.header("Cache-Control", "private, no-store");
      return c.json({ run });
    } catch (error) {
      return routeError(c, error);
    }
  });

  app.post("/v1/companions/:id/routines", async (c) => {
    try {
      const companionId = companionIdSchema.parse(c.req.param("id"));
      const body = createCompanionRoutineInputSchema.parse(await c.req.json());
      const routine = await tenant(c, ({ orgId, database }) =>
        createCompanionRoutineV2({
          orgId,
          companionId,
          id: body.id,
          name: body.name,
          prompt: body.prompt,
          cron: body.cron,
          timezone: body.timezone,
          enabled: body.enabled,
          database,
        }));
      return c.json({ routine }, 201);
    } catch (error) {
      return routeError(c, error);
    }
  });

  app.patch("/v1/companions/:id/routines/:routineId", async (c) => {
    try {
      const companionId = companionIdSchema.parse(c.req.param("id"));
      const routineId = companionIdSchema.parse(c.req.param("routineId"));
      const body = updateCompanionRoutineInputSchema.parse(await c.req.json());
      const routine = await tenant(c, ({ orgId, database }) =>
        updateCompanionRoutineV2({
          orgId,
          companionId,
          routineId,
          name: body.name,
          prompt: body.prompt,
          cron: body.cron,
          timezone: body.timezone,
          enabled: body.enabled,
          database,
        }));
      return c.json({ routine });
    } catch (error) {
      return routeError(c, error);
    }
  });

  app.delete("/v1/companions/:id/routines/:routineId", async (c) => {
    try {
      const companionId = companionIdSchema.parse(c.req.param("id"));
      const routineId = companionIdSchema.parse(c.req.param("routineId"));
      await tenant(c, ({ orgId, database }) =>
        deleteCompanionRoutineV2({ orgId, companionId, routineId, database }));
      return c.body(null, 204);
    } catch (error) {
      return routeError(c, error);
    }
  });

  app.get("/v1/companions/:id/triggers", async (c) => {
    try {
      const companionId = companionIdSchema.parse(c.req.param("id"));
      const triggers = await tenant(c, ({ orgId, database }) =>
        listCompanionTriggersV2({
          orgId,
          companionId,
          database,
          webhookBaseUrl: companionWebhookBaseUrl(env),
        }));
      // Each Owner/Editor row embeds the webhook secret in its URL; never let it touch a disk cache.
      c.header("Cache-Control", "private, no-store");
      return c.json({ triggers });
    } catch (error) {
      return routeError(c, error);
    }
  });

  app.get("/v1/companions/:id/triggers/:triggerId/runs", async (c) => {
    try {
      const companionId = companionIdSchema.parse(c.req.param("id"));
      const triggerId = companionIdSchema.parse(c.req.param("triggerId"));
      const query = companionTriggerRunListQuerySchema.parse({
        limit: c.req.query("limit"),
        cursor: c.req.query("cursor"),
      });
      const history = await tenant(c, ({ orgId, database }) =>
        listCompanionTriggerRunsV2({
          orgId,
          companionId,
          triggerId,
          limit: query.limit,
          cursor: query.cursor,
          database,
        }));
      c.header("Cache-Control", "private, no-store");
      return c.json(history);
    } catch (error) {
      return routeError(c, error);
    }
  });

  app.get("/v1/companions/:id/trigger-runs/:runId", async (c) => {
    try {
      const companionId = companionIdSchema.parse(c.req.param("id"));
      const runId = companionIdSchema.parse(c.req.param("runId"));
      const query = companionTriggerRunDetailQuerySchema.parse({
        entry_limit: c.req.query("entry_limit"),
        entry_cursor: c.req.query("entry_cursor"),
      });
      const run = await tenant(c, ({ orgId, database }) =>
        getCompanionTriggerRunV2({
          orgId,
          companionId,
          runId,
          entryLimit: query.entry_limit,
          entryCursor: query.entry_cursor,
          database,
        }));
      c.header("Cache-Control", "private, no-store");
      return c.json({ run });
    } catch (error) {
      return routeError(c, error);
    }
  });

  app.post("/v1/companions/:id/triggers", async (c) => {
    try {
      const companionId = companionIdSchema.parse(c.req.param("id"));
      const body = createCompanionTriggerInputSchema.parse(await c.req.json());
      const trigger = await tenant(c, async ({ orgId, database }) => {
        const created = await createCompanionTriggerV2({
          orgId,
          companionId,
          id: body.id,
          name: body.name,
          prompt: body.prompt,
          mode: body.mode,
          provider: body.provider,
          providerAccountId: body.provider_account_id,
          target: body.target ?? null,
          enabled: body.enabled,
          database,
          webhookBaseUrl: companionWebhookBaseUrl(env),
        });
        return autoRegisterCompanionTrigger({ orgId, companionId, trigger: created, database });
      });
      return c.json({ trigger }, 201);
    } catch (error) {
      return routeError(c, error);
    }
  });

  app.patch("/v1/companions/:id/triggers/:triggerId", async (c) => {
    try {
      const companionId = companionIdSchema.parse(c.req.param("id"));
      const triggerId = companionIdSchema.parse(c.req.param("triggerId"));
      const body = updateCompanionTriggerInputSchema.parse(await c.req.json());
      const trigger = await tenant(c, async ({ orgId, database }) => {
        // Provider/target/account changes invalidate an existing remote hook. Remove that hook
        // before changing the durable definition so a stale external callback cannot survive an
        // edit that appears successful locally.
        const registrationChanged = body.provider !== undefined
          || body.target !== undefined
          || body.provider_account_id !== undefined;
        if (registrationChanged) {
          const current = (await listCompanionTriggersV2({
            orgId,
            companionId,
            database,
            webhookBaseUrl: companionWebhookBaseUrl(env),
          })).find((candidate) => candidate.id === triggerId);
          if (current) {
            await unregisterCompanionTriggerIfWired({
              orgId,
              companionId,
              trigger: current,
              database,
            });
          }
        }
        const updated = await updateCompanionTriggerV2({
          orgId,
          companionId,
          triggerId,
          name: body.name,
          prompt: body.prompt,
          mode: body.mode,
          provider: body.provider,
          providerAccountId: body.provider_account_id,
          target: body.target === undefined ? undefined : body.target ?? null,
          enabled: body.enabled,
          database,
          webhookBaseUrl: companionWebhookBaseUrl(env),
        });
        return autoRegisterCompanionTrigger({ orgId, companionId, trigger: updated, database });
      });
      return c.json({ trigger });
    } catch (error) {
      return routeError(c, error);
    }
  });

  app.delete("/v1/companions/:id/triggers/:triggerId", async (c) => {
    try {
      const companionId = companionIdSchema.parse(c.req.param("id"));
      const triggerId = companionIdSchema.parse(c.req.param("triggerId"));
      await tenant(c, async ({ orgId, database }) => {
        const current = (await listCompanionTriggersV2({
          orgId,
          companionId,
          database,
          webhookBaseUrl: companionWebhookBaseUrl(env),
        })).find((candidate) => candidate.id === triggerId);
        if (current) {
          await unregisterCompanionTriggerIfWired({
            orgId,
            companionId,
            trigger: current,
            database,
          });
        }
        await deleteCompanionTriggerV2({ orgId, companionId, triggerId, database });
      });
      return c.body(null, 204);
    } catch (error) {
      return routeError(c, error);
    }
  });

  app.post("/v1/companions/:id/triggers/:triggerId/rotate-secret", async (c) => {
    try {
      const companionId = companionIdSchema.parse(c.req.param("id"));
      const triggerId = companionIdSchema.parse(c.req.param("triggerId"));
      const trigger = await tenant(c, async ({ orgId, database }) => {
        const current = (await listCompanionTriggersV2({
          orgId, companionId, database, webhookBaseUrl: companionWebhookBaseUrl(env),
        })).find((candidate) => candidate.id === triggerId);
        if (current) {
          await unregisterCompanionTriggerIfWired({ orgId, companionId, trigger: current, database });
        }
        const rotated = await rotateCompanionTriggerSecretV2({
          orgId,
          companionId,
          triggerId,
          database,
          webhookBaseUrl: companionWebhookBaseUrl(env),
        });
        return autoRegisterCompanionTrigger({ orgId, companionId, trigger: rotated, database });
      });
      return c.json({ trigger });
    } catch (error) {
      return routeError(c, error);
    }
  });

  app.post("/v1/companions/:id/triggers/:triggerId/registration", async (c) => {
    try {
      const companionId = companionIdSchema.parse(c.req.param("id"));
      const triggerId = companionIdSchema.parse(c.req.param("triggerId"));
      const trigger = await tenant(c, async ({ orgId, database }) => {
        const current = (await listCompanionTriggersV2({
          orgId, companionId, database, webhookBaseUrl: companionWebhookBaseUrl(env),
        })).find((candidate) => candidate.id === triggerId);
        if (!current) throw new CompanionTriggerNotFoundError();
        return autoRegisterCompanionTrigger({ orgId, companionId, trigger: current, database });
      });
      return c.json({ trigger });
    } catch (error) {
      return routeError(c, error);
    }
  });

  app.delete("/v1/companions/:id/triggers/:triggerId/registration", async (c) => {
    try {
      const companionId = companionIdSchema.parse(c.req.param("id"));
      const triggerId = companionIdSchema.parse(c.req.param("triggerId"));
      await tenant(c, ({ orgId, database }) =>
        unregisterCompanionTriggerWebhookV2({
          orgId,
          companionId,
          triggerId,
          webhookBaseUrl: companionWebhookBaseUrl(env),
          masterKey: loadSecretsMasterKey(env.COMPANION_SECRETS_MASTER_KEY),
          database,
        }));
      return c.body(null, 204);
    } catch (error) {
      return routeError(c, error);
    }
  });

  app.delete("/v1/companions/:id", async (c) => {
    try {
      const companionId = companionIdSchema.parse(c.req.param("id"));
      const requestId = companionOperationRequestIdSchema.parse(
        c.req.header(COMPANION_OPERATION_IDEMPOTENCY_HEADER),
      );
      const accepted = await tenant(c, ({ orgId, database }) =>
        enqueueCompanionOperationV2({
          orgId,
          companionId,
          requestId,
          kind: "delete",
          clientSurface: "web",
          database,
        }));
      return c.json({ operation: accepted.operation }, 202);
    } catch (error) {
      return routeError(c, error);
    }
  });

  app.put("/v1/companions/:id/provider", async (c) => {
    try {
      const companionId = companionIdSchema.parse(c.req.param("id"));
      const body = setCompanionProviderInputSchema.parse(await c.req.json());
      const companion = await tenant(c, ({ actor, orgId, database }) =>
        setCompanionProviderV2({
          actor,
          orgId,
          companionId,
          providerId: body.provider_id,
          database,
        }));
      return c.json({ companion });
    } catch (error) {
      return routeError(c, error);
    }
  });

  app.get("/v1/companions/:id/shares", async (c) => {
    try {
      const companionId = companionIdSchema.parse(c.req.param("id"));
      const shares = await tenant(c, ({ actor, orgId, database }) =>
        listCompanionShares({ actor, orgId, companionId, database }));
      return c.json({ shares });
    } catch (error) {
      return routeError(c, error);
    }
  });

  app.put("/v1/companions/:id/shares/workspace", async (c) => {
    try {
      const companionId = companionIdSchema.parse(c.req.param("id"));
      const body = setCompanionWorkspaceShareInputSchema.parse(await c.req.json());
      const shares = await tenant(c, ({ actor, orgId, database }) =>
        setCompanionWorkspaceShareV2({ actor, orgId, companionId, role: body.role, database }));
      return c.json({ shares });
    } catch (error) {
      return routeError(c, error);
    }
  });

  app.get("/v1/companions/:id/thread", async (c) => {
    try {
      const companionId = companionIdSchema.parse(c.req.param("id"));
      const thread = await tenant(c, ({ actor, orgId, database }) =>
        readCompanionThreadV2({ actor, orgId, companionId, database }));
      c.header("Cache-Control", "private, no-store");
      return c.json({ thread: projectThreadForHttp(thread, transcriptionAvailable) });
    } catch (error) {
      return routeError(c, error);
    }
  });

  app.get("/v1/companions/:id/thread-window", async (c) => {
    const startedAt = performance.now();
    try {
      const companionId = companionIdSchema.parse(c.req.param("id"));
      const query = companionThreadWindowQuerySchema.parse({
        before: c.req.query("before"),
        limit: c.req.query("limit"),
      });
      const window = await tenant(c, async ({ actor, orgId, database }) => {
        const beforeOrdinal = query.before
          ? readCompanionThreadWindowCursor({
              cursor: query.before,
              orgId,
              actorId: actor.id,
              companionId,
            })
          : null;
        return projectThreadWindowForHttp(
          await readCompanionThreadWindowV2({
            actor,
            orgId,
            companionId,
            beforeOrdinal,
            limit: query.limit,
            database,
          }),
          transcriptionAvailable,
        );
      });
      c.header("Cache-Control", "private, no-store");
      const payload = companionThreadWindowSchema.parse(window);
      recordCompanionThreadSyncMetrics({
        kind: "window",
        durationMs: performance.now() - startedAt,
        payload,
      });
      return c.json(payload);
    } catch (error) {
      return routeError(c, error);
    }
  });

  app.get("/v1/companions/:id/thread-delta", async (c) => {
    const startedAt = performance.now();
    try {
      const companionId = companionIdSchema.parse(c.req.param("id"));
      const query = companionSyncQuerySchema.parse({ cursor: c.req.query("cursor") });
      const delta = await tenant(c, async ({ actor, orgId, database }) => {
        if (query.cursor) {
          const sequence = readCompanionThreadSequenceCursor({
            cursor: query.cursor,
            orgId,
            actorId: actor.id,
            companionId,
          });
          if (sequence !== null) {
            const incremental = await readCompanionThreadChangesV2({
              actor,
              orgId,
              companionId,
              afterSequence: sequence,
              database,
            });
            return companionThreadDeltaResponseSchema.parse({
              ...incremental,
              thread: projectThreadMetadataForHttp(
                incremental.thread,
                transcriptionAvailable,
              ),
            });
          }

          // A v1 cursor receives exactly one legacy comparison. Capture the new sequence first:
          // writes racing the full projection are therefore picked up by the next v2 delta.
          const baseline = await readCompanionThreadProjectionSequenceV2({
            actor,
            orgId,
            companionId,
            database,
          });
          const thread = await syncCompanionThreadV2({ actor, orgId, companionId, database });
          const legacy = buildCompanionThreadDelta({
            orgId,
            actorId: actor.id,
            companionId,
            thread: projectThreadForHttp(thread, transcriptionAvailable),
            cursor: query.cursor,
          });
          return companionThreadDeltaResponseSchema.parse({
            ...legacy,
            cursor: buildCompanionThreadSequenceCursor({
              orgId,
              actorId: actor.id,
              companionId,
              sequence: baseline,
            }),
            has_more: false,
          });
        }
        const thread = await syncCompanionThreadV2({ actor, orgId, companionId, database });
        return buildCompanionThreadDelta({
          orgId,
          actorId: actor.id,
          companionId,
          thread: projectThreadForHttp(thread, transcriptionAvailable),
          cursor: query.cursor,
        });
      });
      c.header("Cache-Control", "private, no-store");
      recordCompanionThreadSyncMetrics({
        kind: "delta",
        durationMs: performance.now() - startedAt,
        payload: delta,
      });
      return c.json(delta);
    } catch (error) {
      return routeError(c, error);
    }
  });

  app.post(
    "/v1/companions/:id/messages",
    // Authenticate and, for a multipart send, authorize the Companion before the body-reading limit
    // middleware runs. A chunked request carries no Content-Length, so that middleware buffers the
    // entire body before it can measure it -- authorizing afterwards would let any authenticated
    // caller cost this process 64 MB of heap per in-flight request against a Companion they cannot
    // even see. A text-only send skips the extra read entirely.
    async (c, next) => {
      try {
        actorFromContext(c);
        if ((c.req.header("content-type") ?? "").includes("multipart/form-data")) {
          const companionId = companionIdSchema.parse(c.req.param("id"));
          const companion = await tenant(c, ({ actor, orgId, database }) =>
            getCompanionV2({ actor, orgId, companionId, database }));
          if (companion.access === "viewer") throw new CompanionRuntimeForbiddenError();
        }
      } catch (error) {
        return routeError(c, error);
      }
      await next();
    },
    // Five files at ten megabytes each, plus multipart overhead. A text-only send is orders of
    // magnitude under this and takes the JSON branch below.
    bodyLimit({
      maxSize: COMPANION_MESSAGE_UPLOAD_LIMIT_BYTES,
      onError: (c) => jsonError(c, "message exceeds the 64 MB upload limit", 413),
    }),
    async (c) => {
      const createdKeys: CompanionCreatedStorageObject[] = [];
      try {
        const companionId = companionIdSchema.parse(c.req.param("id"));
        const contentType = c.req.header("content-type") ?? "";
        let attachments: CompanionAttachmentUpload[] = [];
        let body: SendCompanionMessageInput;

        if (contentType.includes("multipart/form-data")) {
          // Access was already decided by the middleware above, before the body was read. Resolve
          // the tenant again here for the key prefix; it is a cheap header/session read.
          const authorized = { orgId: await orgIdFromContext(c) };

          const form = await c.req.formData();
          const formInput: CompanionMessageFormInput = {
            content: formField(form, "content") ?? "",
            client_message_id: formField(form, "client_message_id"),
          };
          const clientSurface = formField(form, "client_surface");
          if (clientSurface) {
            const parsedSurface = companionClientSurfaceSchema.safeParse(clientSurface);
            if (!parsedSurface.success) throw parsedSurface.error;
            formInput.client_surface = parsedSurface.data;
          }
          body = sendCompanionMessageInputSchema.parse(formInput);
          const files = form.getAll("file")
            .filter((part): part is Exclude<typeof part, string> => part instanceof File);
          if (files.length > COMPANION_MESSAGE_ATTACHMENT_MAX_COUNT) {
            throw new Error(
              `a message carries at most ${COMPANION_MESSAGE_ATTACHMENT_MAX_COUNT} attachments`,
            );
          }

          // Object writes happen outside any database transaction: a slow upload must not hold a
          // pooled connection open, and the enqueue below only persists metadata.
          for (const [position, file] of files.entries()) {
            if (file.size === 0) throw new Error("an attached file is empty");
            if (file.size > COMPANION_ATTACHMENT_MAX_BYTES) {
              throw new Error("each attachment must be 10 MB or smaller");
            }
            const bytes = Buffer.from(await file.arrayBuffer());
            // The stored type comes from the bytes, never from the declared MIME or the extension,
            // so a disguised file is refused before it is stored or staged for Pi to read.
            const resolved = sniffCompanionAttachmentMime(
              bytes,
              declaredCompanionAttachmentContentType({ type: file.type, name: file.name }),
            );
            if (!resolved) {
              throw new Error("attachments must be PNG, JPEG, WebP, GIF, PDF, CSV, text, Markdown, or JSON");
            }
            const sha256 = createHash("sha256").update(bytes).digest("hex");
            const key = companionAttachmentKey({
              kind: "message",
              orgId: authorized.orgId,
              companionId,
              clientMessageId: body.client_message_id,
              position,
              sha256,
            });
            try {
              const etag = await putSkillArchive({
                key,
                body: bytes,
                contentType: resolved,
                preventOverwrite: true,
              });
              // Remember the exact version this request wrote. If a concurrent request for the same
              // client_message_id adopts this key and commits a row for it, the delete below no
              // longer matches and is refused rather than stranding that row.
              const created: CompanionCreatedStorageObject = { key };
              if (etag) created.etag = etag;
              createdKeys.push(created);
            } catch (error) {
              // The object already exists. Because the key is the digest of these exact bytes, it
              // holds the same content -- almost always this request's own replay, whose turn is
              // already accepted. Adopt it, and never schedule it for cleanup: deleting it would
              // destroy the live bytes of an accepted message.
              if (!isStoragePreconditionFailure(error)) throw error;
            }
            attachments.push({
              storage_key: key,
              content_type: resolved,
              byte_size: bytes.length,
              sha256,
              filename: sanitizeCompanionAttachmentFilename({
                filename: file.name,
                position,
                contentType: resolved,
              }),
              position,
            });
          }
        } else {
          body = sendCompanionMessageInputSchema.parse(await c.req.json());
        }

        const accepted = await tenant(c, async ({ actor, orgId, database }) => {
          const { turn } = await enqueueCompanionTurnV2({
            actor,
            orgId,
            companionId,
            clientMessageId: body.client_message_id,
            content: body.content,
            clientSurface: body.client_surface,
            attachments,
            database,
          });
          return { turn };
        });
        c.header("Cache-Control", "private, no-store");
        return c.json(accepted, 202);
      } catch (error) {
        // The turn did not persist, so objects this request created belong to nothing.
        //
        // Two independent rules keep this from destroying an accepted message's bytes, because the
        // key is the digest of the content and is therefore identical to the key an accepted turn
        // already owns. First, the PUT above is create-only, so a key that already existed is never
        // in `createdKeys`. Second -- in case a self-hosted object store ignores the conditional
        // header -- a replay conflict is never cleaned up at all: that error means a turn with this
        // client_message_id is already accepted, and these are its files.
        if (databaseErrorCode(error) !== "23505") {
          await Promise.allSettled(createdKeys.map((created) => {
            const deletion: CompanionStorageDeleteInput = { key: created.key };
            if (created.etag) deletion.ifMatch = created.etag;
            return deleteStorageObject(deletion);
          }));
        }
        // An object-storage failure names the bucket, and a connection failure names the internal
        // endpoint. Neither belongs in a reply to a member, so a storage fault answers with a fixed
        // line while the underlying error stays in this process's logs.
        if (isStorageFailure(error)) {
          return c.json({ ok: false, error: "the attachments could not be stored" }, 502);
        }
        return routeError(c, error);
      }
    },
  );

  /**
   * Serve one attachment to a reader who may read the thread. This is a PostgreSQL-plus-object-storage
   * read: it never wakes, observes, or otherwise contacts the Box, so a Viewer opening a thread costs
   * a sleeping Companion nothing.
   */
  app.get("/v1/companions/:id/attachments/:attachmentId", async (c) => {
    try {
      const companionId = companionIdSchema.parse(c.req.param("id"));
      const attachmentId = companionIdSchema.parse(c.req.param("attachmentId"));
      const asset = await tenant(c, ({ actor, orgId, database }) =>
        readCompanionAttachmentV2({ actor, orgId, companionId, attachmentId, database }));
      const bytes = await getSkillArchive({ key: asset.storageKey });
      return new Response(bytes, {
        headers: {
          "Content-Type": asset.contentType,
          // Access is re-decided on every request, so a cached copy must not outlive the access that
          // fetched it. An image still renders; it is simply revalidated.
          "Cache-Control": "private, no-cache",
          // User-uploaded and Pi-produced bytes alike: never let a browser sniff them into a type
          // that could execute.
          "X-Content-Type-Options": "nosniff",
          // An image belongs inline in the thread; anything else is a file the reader asked for.
          "Content-Disposition": isCompanionAttachmentImage(asset.contentType)
            ? `inline; filename="${asset.filename}"`
            : `attachment; filename="${asset.filename}"`,
        },
      });
    } catch (error) {
      // An unreadable thread, an unknown attachment, and a cross-tenant id are deliberately
      // indistinguishable to the request that asked for the bytes. The message is fixed rather than
      // the underlying one: object-storage errors name the storage key and the internal endpoint,
      // neither of which a reader may learn.
      return c.json(
        { ok: false, error: "attachment not found" },
        errorStatus(error) === 403 ? 403 : 404,
      );
    }
  });

  app.get("/v1/companions/:id/peer-grants", async (c) => {
    try {
      const companionId = companionIdSchema.parse(c.req.param("id"));
      const grants = await tenant(c, async ({ orgId, database }) =>
        (await listCompanionControlPeers({ orgId, companionId, database }))
          .filter((peer) => peer.grant_active));
      return c.json({ grants });
    } catch (error) {
      return routeError(c, error);
    }
  });

  app.delete("/v1/companions/:id/peer-grants/:targetId", async (c) => {
    try {
      const companionId = companionIdSchema.parse(c.req.param("id"));
      const targetId = companionIdSchema.parse(c.req.param("targetId"));
      const revoked = await tenant(c, ({ orgId, database }) => revokeCompanionPeerAccess({
        orgId,
        sourceCompanionId: companionId,
        targetCompanionId: targetId,
        database,
      }));
      return c.json({ revoked });
    } catch (error) {
      return routeError(c, error);
    }
  });

  app.post("/v1/companions/:id/decisions/:requestId", async (c) => {
    let proposalDecisionMutation: ProposalDecisionMutation | null = null;
    try {
      const companionId = companionIdSchema.parse(c.req.param("id"));
      const requestId = z.string().min(1).max(200).parse(c.req.param("requestId"));
      const body = decideCompanionDecisionInputSchema.parse(await c.req.json());
      const thread = await tenant(c, async ({ actor, orgId, database }) => {
        const controlId = z.string().uuid().safeParse(requestId);
        const controlRequest = controlId.success
          ? await getCompanionControlRequest({
              orgId,
              companionId,
              requestId: controlId.data,
              database,
            })
          : null;
        if (controlRequest) {
          if (body.action === "answer") {
            throw new Error("Companion control requests cannot be answered with free text");
          }
          const decided = await decideCompanionControlRequest({
            orgId,
            companionId,
            requestId: controlRequest.id,
            action: body.action,
            database,
          });
          let completed = decided;
          if (body.action === "allow" && completed.status === "applying") {
            try {
              const result = await applyControlRequest({
                actor,
                orgId,
                companionId,
                request: decided,
                database,
              });
              completed = await finishCompanionControlRequest({
                orgId,
                companionId,
                requestId: decided.id,
                result,
                database,
              });
            } catch {
              completed = await finishCompanionControlRequest({
                orgId,
                companionId,
                requestId: decided.id,
                error: {
                  code: "control_apply_failed",
                  message: "The approved Companion change could not be applied.",
                },
                database,
              });
            }
          }
          if (body.action === "allow" && completed.status === "applied"
              && (completed.kind === "model_change" || completed.kind === "peer_access")) {
            await enqueueCompanionControlContinuation({
              orgId,
              companionId,
              requestId: completed.id,
              content: completed.kind === "model_change"
                ? "The requested model change was approved and applied. Continue with the updated model configuration."
                : "The requested peer access was approved. Continue the task with the new delegation permission.",
              database,
            });
          }
          return projectThreadForHttp(
            await readCompanionThreadV2({ actor, orgId, companionId, database }),
            transcriptionAvailable,
          );
        }
        const pending = await getCompanionDecisionV2({
          orgId,
          companionId,
          requestId,
          database,
        });
        // Denial is fail-closed. If the runtime expiry/cancellation sweep won the row lock just
        // before this request, the requested negative outcome is already durable and should be
        // reported as success instead of surfacing a database conflict to a stale client card.
        if (
          body.action === "deny"
          && ["denied", "expired", "cancelled"].includes(pending.decisionStatus)
        ) {
          return projectThreadForHttp(
            await readCompanionThreadV2({ actor, orgId, companionId, database }),
            transcriptionAvailable,
          );
        }
        if (pending.requestKind === "config_proposal") {
          if (body.action === "answer") {
            throw new Error("Companion config proposals cannot be answered with free text");
          }
          if (
            body.action === "allow"
            && pending.proposal?.kind === "config"
            && pending.proposal.model_id
          ) {
            const companion = await getCompanionV2({ actor, orgId, companionId, database });
            const providerId = companion.runtime.provider_ids[0];
            const modelId = providerId
              ? companionCatalogModel(
                await getCompanionProviderCatalog(),
                providerId,
                pending.proposal.model_id,
              )
              : undefined;
            if (!modelId) {
              throw new CompanionProviderError(
                "provider_model_invalid",
                "The selected model is not available for this provider.",
                providerId ?? null,
              );
            }
          }
          await answerCompanionConfigDecisionV2({
            orgId,
            companionId,
            requestId,
            decision: body.action,
            database,
          });
        } else if (pending.requestKind === "routine_proposal") {
          if (body.action === "answer") {
            throw new Error("Companion routine proposals cannot be answered with free text");
          }
          proposalDecisionMutation = "routine";
          await answerCompanionRoutineDecisionV2({
            orgId,
            companionId,
            requestId,
            decision: body.action,
            database,
          });
        } else if (pending.requestKind === "trigger_proposal") {
          if (body.action === "answer") {
            throw new Error("Companion trigger proposals cannot be answered with free text");
          }
          proposalDecisionMutation = "trigger";
          const decisionResult = await answerCompanionTriggerDecisionV2({
            orgId,
            companionId,
            requestId,
            decision: body.action,
            database,
          });
          const triggerId = triggerIdFromDecisionResult(decisionResult);
          if (body.action === "allow" && triggerId) {
            const created = (await listCompanionTriggersV2({
              orgId,
              companionId,
              database,
              webhookBaseUrl: companionWebhookBaseUrl(env),
            })).find((candidate) => candidate.id === triggerId);
            if (created) {
              await autoRegisterCompanionTrigger({ orgId, companionId, trigger: created, database });
            }
          }
        } else {
          await answerCompanionDecisionV2({
            orgId,
            companionId,
            requestId,
            decision: body.action,
            text: body.action === "answer" ? body.answer : undefined,
            database,
          });
        }
        return projectThreadForHttp(
          await readCompanionThreadV2({ actor, orgId, companionId, database }),
          transcriptionAvailable,
        );
      });
      proposalDecisionMutation = null;
      return c.json({ thread }, 202);
    } catch (error) {
      if (error instanceof Error
          && proposalDecisionDatabaseFailure(error)) {
        // A failed preflight cannot reveal the proposal kind safely, but it is still a decision
        // request. Keep that response bounded with a generic code until the kind is known.
        return proposalDecisionFailureResponse(c, proposalDecisionMutation ?? "decision", error);
      }
      return routeError(c, error);
    }
  });

  app.post("/v1/companions/:id/turns/:turnId/cancel", async (c) => {
    try {
      const companionId = companionIdSchema.parse(c.req.param("id"));
      const turnId = companionIdSchema.parse(c.req.param("turnId"));
      cancelCompanionTurnInputSchema.parse(await c.req.json().catch(() => ({})));
      const accepted = await tenant(c, async ({ actor, orgId, database }) => {
        const turn = await cancelCompanionTurnV2({ orgId, companionId, turnId, database });
        const thread = await readCompanionThreadV2({ actor, orgId, companionId, database });
        return { turn, thread: projectThreadForHttp(thread, transcriptionAvailable) };
      });
      return c.json(accepted, 202);
    } catch (error) {
      return routeError(c, error);
    }
  });

  app.get("/v1/companions/:id/runtime", async (c) => {
    try {
      const companionId = companionIdSchema.parse(c.req.param("id"));
      const companion = await tenant(c, ({ actor, orgId, database }) =>
        getCompanionV2({ actor, orgId, companionId, withLastMessage: true, database }));
      c.header("Cache-Control", "private, no-store");
      return c.json({ companion });
    } catch (error) {
      return routeError(c, error);
    }
  });

  async function enqueueLifecycle(
    c: Context<{ Variables: ApiVariables }>,
    companionId: string,
    requestId: string,
    kind: "start" | "stop" | "restart_pi" | "restart_box",
    clientSurface: "web" | "mobile_web" | "native_mobile" = "web",
  ) {
    return tenant(c, ({ orgId, database }) => enqueueCompanionOperationV2({
      orgId,
      companionId,
      requestId,
      kind,
      clientSurface,
      database,
    }));
  }

  app.post("/v1/companions/:id/runtime/start", async (c) => {
    try {
      const companionId = companionIdSchema.parse(c.req.param("id"));
      const body = startCompanionRuntimeInputSchema.parse(await c.req.json().catch(() => ({})));
      const requestId = companionOperationRequestIdSchema.parse(
        c.req.header(COMPANION_OPERATION_IDEMPOTENCY_HEADER),
      );
      const accepted = await enqueueLifecycle(c, companionId, requestId, "start", body.client_surface);
      return c.json({ operation: accepted.operation }, 202);
    } catch (error) {
      return routeError(c, error);
    }
  });

  app.post("/v1/companions/:id/runtime/restart", async (c) => {
    try {
      const companionId = companionIdSchema.parse(c.req.param("id"));
      const body = restartCompanionRuntimeInputSchema.parse(await c.req.json());
      const requestId = companionOperationRequestIdSchema.parse(
        c.req.header(COMPANION_OPERATION_IDEMPOTENCY_HEADER),
      );
      const accepted = await enqueueLifecycle(
        c,
        companionId,
        requestId,
        body.target === "pi" ? "restart_pi" : "restart_box",
      );
      return c.json({ operation: accepted.operation }, 202);
    } catch (error) {
      return routeError(c, error);
    }
  });

  app.post("/v1/companions/:id/runtime/stop", async (c) => {
    try {
      const companionId = companionIdSchema.parse(c.req.param("id"));
      const requestId = companionOperationRequestIdSchema.parse(
        c.req.header(COMPANION_OPERATION_IDEMPOTENCY_HEADER),
      );
      const accepted = await enqueueLifecycle(c, companionId, requestId, "stop");
      return c.json({ operation: accepted.operation }, 202);
    } catch (error) {
      return routeError(c, error);
    }
  });

  app.post("/v1/companions/:id/runtime/desktop", async (c) => {
    try {
      const companionId = companionIdSchema.parse(c.req.param("id"));
      const resolved = await tenant(c, async ({ actor, orgId, database }) => ({
        actor,
        orgId,
        companion: await getCompanionV2({ actor, orgId, companionId, database }),
      }));
      if (resolved.companion.access === "viewer") throw new CompanionRuntimeForbiddenError();
      const desktop = await mintCompanionDesktop({
        env,
        actorId: resolved.actor.id,
        orgId: resolved.orgId,
        companionId,
      });
      c.header("Cache-Control", "private, no-store");
      return c.json(desktop);
    } catch (error) {
      return routeError(c, error);
    }
  });

}

/**
 * Inbound trigger webhooks. Registered before CORS and `attachSession`: an external service posts
 * here with no session and no origin of ours, and the per-trigger secret in the path is the whole
 * authentication. Every response is a fixed sentence — never the payload, the secret, or a provider
 * error — and the URL itself is never logged because it contains the secret.
 */
export function registerCompanionTriggerWebhookRoutes(
  app: Hono<{ Variables: ApiVariables }>,
  env: NodeJS.ProcessEnv = process.env,
  dependencies: CompanionRouteDependencies = {},
): void {
  if (!companionsEnabled(env)) return;

  const {
    jsonError,
    getCompanionTriggerForWebhook,
    fireCompanionTrigger,
    failCompanionTriggerFire,
  } = { ...defaultCompanionRouteDependencies(), ...dependencies };

  app.post(
    "/v1/hooks/triggers/:triggerId/:secret",
    bodyLimit({
      maxSize: 1024 * 1024,
      onError: (c) => jsonError(c, "trigger payload exceeds the 1 MB limit", 413),
    }),
    async (c) => {
      const triggerId = c.req.param("triggerId");
      // An unknown id and a malformed id are indistinguishable on purpose.
      if (!companionIdSchema.safeParse(triggerId).success) {
        return jsonError(c, "unknown trigger", 404);
      }
      const rawBody = await c.req.text();
      let row: Awaited<ReturnType<typeof getCompanionTriggerForWebhook>>;
      try {
        // The fire/lookup functions are SECURITY DEFINER and set their own GUCs, so this pre-session
        // path uses the plain API connection, exactly like the Stripe webhook — no tenant context.
        row = await getCompanionTriggerForWebhook({ triggerId, database: db });
      } catch {
        return c.json({ ok: false, error: "trigger fire failed" }, 500);
      }
      if (!row) return jsonError(c, "unknown trigger", 404);
      const presented = Buffer.from(c.req.param("secret") ?? "", "utf8");
      const expected = Buffer.from(row.secret, "utf8");
      if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) {
        return jsonError(c, "invalid trigger secret", 401);
      }
      const deliveryId = extractTriggerDeliveryId(c.req.raw.headers, rawBody);
      const clientMessageId = triggerFireMessageId({ triggerId, deliveryId });
      const content = composeTriggerPrompt(row.prompt, rawBody);
      try {
        const fired = await fireCompanionTrigger({
          orgId: row.orgId,
          triggerId,
          clientMessageId,
          content,
          database: db,
        });
        return c.json({ received: true, outcome: fired.outcome, replayed: fired.replayed });
      } catch (error) {
        // Same delivery id with a different payload is a conflicting intent, never a silent replay.
        if (databaseErrorCode(error) === "23505") {
          return c.json(
            { ok: false, error: "a different payload already used this delivery id" },
            409,
          );
        }
        const classified = classifyCompanionTriggerFireError(error);
        try {
          await failCompanionTriggerFire({
            orgId: row.orgId,
            triggerId,
            errorCode: classified.code,
            errorMessage: classified.message,
            database: db,
          });
        } catch {
          // Bookkeeping is best-effort; the caller still learns only that the fire failed.
        }
        return c.json({ ok: false, error: "trigger fire failed" }, 500);
      }
    },
  );
}
