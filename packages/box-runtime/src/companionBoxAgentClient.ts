/* oxlint-disable anti-slop/no-known-value-widening, anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/no-unsafe-dictionary-type, anti-slop/require-safety-comment-for-type-assertion -- The client sits on a JSON wire boundary: agent HTTP bodies and thrown fetch values arrive untyped and are narrowed here before use. */

import { createHash } from "node:crypto";

import {
  COMPANION_BOX_AGENT_BROKER_RPC_TIMEOUT_MS,
  COMPANION_BOX_AGENT_LONG_POLL_CAP_MS,
  sanitizePiUnitState,
} from "./companionBoxAgentCore";
import {
  parseCompanionPiAckEventsData,
  parseCompanionPiBrokerEventPageData,
  parseCompanionPiBrokerStateData,
  type CompanionPiBrokerEventPage,
  type CompanionPiBrokerState,
  type CompanionPiControlDispatch,
  type CompanionPiExtensionUiDispatch,
  type CompanionPiPromptDispatch,
  type CompanionAttachmentFile,
  type CompanionStagedAttachment,
  type CompanionOutboxEntry,
  type CompanionOutboxFile,
} from "./boxCompanionRuntime";
import { companionPiDispatchFingerprint } from "./companionPiBrokerCore";

/**
 * Decrypted credentials of one registered Box agent endpoint. `hostedUrl` is the token-free
 * locator; the proxy token gates the provider's `host <port>` proxy and the bearer authenticates
 * at the agent itself. None of the three may appear in any log, error, or persisted value.
 */
export interface CompanionBoxAgentEndpointCredentials {
  hostedUrl: string;
  proxyToken: string;
  bearerToken: string;
}

/** Stable failure taxonomy for the direct channel; drives the per-call exec fallback decision. */
export type CompanionBoxAgentFailureCode =
  | "agent_unreachable"
  | "agent_timeout"
  | "agent_aborted"
  | "agent_auth_failed"
  | "agent_rate_limited"
  | "agent_http_error"
  | "agent_broker_unavailable"
  | "agent_broker_failed"
  | "agent_protocol";

/**
 * One failed direct agent request. The message is a fixed expurgated string per stable code; the
 * hosted URL, tokens, response bodies, and header values never enter it.
 */
export class CompanionBoxAgentRequestError extends Error {
  readonly stableCode: CompanionBoxAgentFailureCode;
  readonly status: number | null;

  constructor(stableCode: CompanionBoxAgentFailureCode, status: number | null = null) {
    super(`Companion box agent request failed: ${stableCode}`);
    this.name = "CompanionBoxAgentRequestError";
    this.stableCode = stableCode;
    this.status = status;
  }
}

/** Local health view of one agent, mapped from `GET /v1/health`. */
export interface CompanionBoxAgentHealthView {
  agentVersion: number;
  piUnit: string;
  brokerSocketReady: boolean;
  layoutMarker: string | null;
}

/** Bounded direct calls: state reads answer fast or fail fast; long-polls add the server wait. */
export const COMPANION_BOX_AGENT_STATE_TIMEOUT_MS = 5_000;
/** Server-side long-poll wait the runtime requests; below the agent/proxy 25 s response cap. */
export const COMPANION_BOX_AGENT_EVENT_WAIT_MS = 20_000;
const EVENT_TIMEOUT_MARGIN_MS = 10_000;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_RAW_RESPONSE_BYTES = 10 * 1024 * 1024;
const MAX_REDIRECTS = 2;

export interface CompanionBoxAgentClientOptions {
  endpoint: CompanionBoxAgentEndpointCredentials;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  stateTimeoutMs?: number;
}

/**
 * HTTPS client for the on-box Companion agent behind the provider's hosted proxy. It exposes only
 * the broker protocol and bounded attachment/outbox operations—never arbitrary exec, filesystem
 * paths, credentials, or lifecycle control. Every structured response is validated by the same
 * parsers as the exec transport, so a malformed direct answer fails with equivalent semantics.
 */
export class CompanionBoxAgentClient {
  readonly #endpoint: CompanionBoxAgentEndpointCredentials;
  readonly #fetch: typeof fetch;
  readonly #stateTimeoutMs: number;
  readonly #brokerTimeoutMs: number;

  constructor(options: CompanionBoxAgentClientOptions) {
    this.#endpoint = options.endpoint;
    this.#fetch = options.fetchImpl ?? fetch;
    this.#stateTimeoutMs = options.stateTimeoutMs ?? COMPANION_BOX_AGENT_STATE_TIMEOUT_MS;
    this.#brokerTimeoutMs = Math.max(
      this.#stateTimeoutMs,
      COMPANION_BOX_AGENT_BROKER_RPC_TIMEOUT_MS + 2_000,
    );
  }

  async health(signal?: AbortSignal): Promise<CompanionBoxAgentHealthView> {
    const body = await this.#requestJson({
      method: "GET",
      path: "/v1/health",
      timeoutMs: this.#stateTimeoutMs,
      signal,
    });
    const agentVersion = body.agentVersion;
    const piUnit = body.piUnit;
    const brokerSocketReady = body.brokerSocketReady;
    const layoutMarker = body.layoutMarker;
    if (
      typeof agentVersion !== "number"
      || !Number.isSafeInteger(agentVersion)
      || typeof piUnit !== "string"
      || typeof brokerSocketReady !== "boolean"
      || (layoutMarker !== null && typeof layoutMarker !== "string")
    ) {
      throw new CompanionBoxAgentRequestError("agent_protocol");
    }
    return {
      agentVersion,
      piUnit: sanitizePiUnitState(piUnit),
      brokerSocketReady,
      layoutMarker: layoutMarker === null ? null : layoutMarker.slice(0, 1_024),
    };
  }

  async brokerState(signal?: AbortSignal): Promise<CompanionPiBrokerState> {
    const body = await this.#requestJson({
      method: "GET",
      path: "/v1/broker/state",
      timeoutMs: this.#stateTimeoutMs,
      signal,
    });
    return parseBody(() => parseCompanionPiBrokerStateData(body));
  }

  async readEvents(input: {
    after: number;
    limit?: number;
    waitMs?: number;
    signal?: AbortSignal;
  }): Promise<CompanionPiBrokerEventPage> {
    const waitMs = Math.min(
      Math.max(input.waitMs ?? COMPANION_BOX_AGENT_EVENT_WAIT_MS, 0),
      COMPANION_BOX_AGENT_LONG_POLL_CAP_MS,
    );
    const query: Array<[string, string]> = [
      ["after", String(input.after)],
      ["wait_ms", String(waitMs)],
    ];
    if (input.limit !== undefined) query.push(["limit", String(input.limit)]);
    const body = await this.#requestJson({
      method: "GET",
      path: "/v1/events",
      query,
      timeoutMs: waitMs + EVENT_TIMEOUT_MARGIN_MS,
      signal: input.signal,
    });
    return parseBody(() => parseCompanionPiBrokerEventPageData(body, input.after));
  }

  async ackEvents(input: {
    through: number;
    signal?: AbortSignal;
  }): Promise<{ acknowledgedCursor: number }> {
    const body = await this.#requestJson({
      method: "POST",
      path: "/v1/ack",
      body: { through: input.through },
      timeoutMs: this.#stateTimeoutMs,
      signal: input.signal,
    });
    return parseBody(() => parseCompanionPiAckEventsData(body));
  }

  async prompt(input: {
    commandId: string;
    attemptId: string;
    expectedInvocationId: string;
    message: string;
    signal?: AbortSignal;
  }): Promise<CompanionPiPromptDispatch> {
    const body = await this.#requestJson({
      method: "POST",
      path: "/v1/prompt",
      body: {
        commandId: input.commandId,
        attemptId: input.attemptId,
        expectedInvocationId: input.expectedInvocationId,
        message: input.message,
      },
      timeoutMs: this.#brokerTimeoutMs,
      signal: input.signal,
      acceptBrokerFailure: true,
    });
    return promptDispatch(body, input.attemptId);
  }

  async dispatchStatus(input: {
    commandId: string;
    attemptId: string;
    expectedInvocationId: string;
    message: string;
    signal?: AbortSignal;
  }): Promise<{ status: "absent" } | { status: "accepted"; dispatch: CompanionPiPromptDispatch }> {
    const body = await this.#requestJson({
      method: "GET",
      path: "/v1/dispatch/status",
      query: [["attempt_id", input.attemptId], ["command_id", input.commandId]],
      timeoutMs: this.#brokerTimeoutMs,
      signal: input.signal,
      acceptBrokerFailure: true,
    });
    if (body.status === "absent") return { status: "absent" };
    const expectedFingerprint = companionPiDispatchFingerprint({
      attemptId: input.attemptId,
      expectedInvocationId: input.expectedInvocationId,
      message: input.message,
      requiredInput: ["text"],
      clearOutbox: true,
    });
    if (body.status !== "accepted" || body.fingerprint !== expectedFingerprint) {
      throw new CompanionBoxAgentRequestError("agent_protocol", 200);
    }
    const dispatch = promptDispatch(body, input.attemptId);
    if (dispatch.outcome !== "accepted") throw new CompanionBoxAgentRequestError("agent_protocol", 200);
    return { status: "accepted", dispatch };
  }

  async abort(input: {
    commandId: string;
    attemptId: string;
    signal?: AbortSignal;
  }): Promise<CompanionPiControlDispatch> {
    const body = await this.#requestJson({
      method: "POST",
      path: "/v1/abort",
      body: { commandId: input.commandId, attemptId: input.attemptId },
      timeoutMs: this.#brokerTimeoutMs,
      signal: input.signal,
      acceptBrokerFailure: true,
    });
    return controlDispatch(body, input.attemptId, "pi_ack_ambiguous");
  }

  async decision(input: {
    commandId: string;
    attemptId: string;
    response: object;
    signal?: AbortSignal;
  }): Promise<CompanionPiExtensionUiDispatch> {
    const body = await this.#requestJson({
      method: "POST",
      path: "/v1/decision",
      body: { commandId: input.commandId, attemptId: input.attemptId, response: input.response },
      timeoutMs: this.#brokerTimeoutMs,
      signal: input.signal,
      acceptBrokerFailure: true,
    });
    return controlDispatch(body, input.attemptId, "decision_delivery_ambiguous");
  }

  async stageAttachments(input: {
    messageId: string;
    files: CompanionAttachmentFile[];
    signal?: AbortSignal;
  }): Promise<CompanionStagedAttachment[]> {
    const manifest = [];
    for (const file of input.files) {
      const sha256 = await sha256Hex(file.bytes);
      await this.#requestJson({
        method: "PUT",
        path: "/v1/files",
        query: [
          ["message_id", input.messageId],
          ["position", String(file.position)],
          ["sha256", sha256],
        ],
        rawBody: file.bytes,
        timeoutMs: 30_000,
        signal: input.signal,
      });
      manifest.push({
        position: file.position,
        filename: file.filename,
        contentType: file.contentType,
        byteSize: file.bytes.byteLength,
        sha256,
      });
    }
    const body = await this.#requestJson({
      method: "POST",
      path: `/v1/attachments/${input.messageId}`,
      body: { files: manifest },
      timeoutMs: 30_000,
      signal: input.signal,
    });
    return stagedAttachments(body, input.messageId, manifest);
  }

  async clearOutbox(signal?: AbortSignal): Promise<void> {
    const body = await this.#requestJson({
      method: "POST",
      path: "/v1/outbox/clear",
      body: {},
      timeoutMs: this.#stateTimeoutMs,
      signal,
    });
    if (body.cleared !== true) throw new CompanionBoxAgentRequestError("agent_protocol", 200);
  }

  async listOutbox(input: {
    deadlineAt?: Date;
    signal?: AbortSignal;
  } = {}): Promise<CompanionOutboxEntry[]> {
    const body = await this.#requestJson({
      method: "GET",
      path: "/v1/outbox",
      timeoutMs: boundedTimeoutMs(this.#stateTimeoutMs, input.deadlineAt),
      signal: input.signal,
    });
    return outboxEntries(body.entries);
  }

  async readOutboxFile(input: {
    entry: CompanionOutboxEntry;
    deadlineAt?: Date;
    signal?: AbortSignal;
  }): Promise<CompanionOutboxFile> {
    const response = await this.#requestResponse({
      method: "GET",
      path: "/v1/outbox/file",
      query: [["name", input.entry.encodedName]],
      timeoutMs: boundedTimeoutMs(30_000, input.deadlineAt),
      signal: input.signal,
    });
    let bytes: Buffer;
    try {
      bytes = Buffer.from(await response.arrayBuffer());
    } catch (error) {
      throw this.#transportError(error, input.signal);
    }
    if (bytes.byteLength > MAX_RAW_RESPONSE_BYTES
      || bytes.byteLength !== input.entry.byteSize
      || await sha256Hex(bytes) !== input.entry.sha256) {
      throw new CompanionBoxAgentRequestError("agent_protocol", response.status);
    }
    return { entry: input.entry, bytes };
  }

  async #requestJson(input: {
    method: "GET" | "POST" | "PUT";
    path: string;
    query?: ReadonlyArray<readonly [string, string]>;
    body?: Record<string, unknown>;
    rawBody?: Uint8Array;
    timeoutMs: number;
    signal?: AbortSignal;
    acceptBrokerFailure?: boolean;
  }): Promise<Record<string, unknown>> {
    const response = await this.#requestResponse(input);
    let text: string;
    try {
      text = await response.text();
    } catch (error) {
      throw this.#transportError(error, input.signal);
    }
    if (text.length > MAX_RESPONSE_BYTES) {
      throw new CompanionBoxAgentRequestError("agent_protocol", response.status);
    }
    let parsed: unknown;
    try {
      // SAFETY: JSON.parse returns any; widening to unknown forces the narrowing below.
      parsed = JSON.parse(text) as unknown;
    } catch {
      throw new CompanionBoxAgentRequestError("agent_protocol", response.status);
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new CompanionBoxAgentRequestError("agent_protocol", response.status);
    }
    // SAFETY: The guard above excludes null, arrays, and primitives; a plain JSON object remains.
    return parsed as Record<string, unknown>;
  }

  async #requestResponse(input: {
    method: "GET" | "POST" | "PUT";
    path: string;
    query?: ReadonlyArray<readonly [string, string]>;
    body?: Record<string, unknown>;
    rawBody?: Uint8Array;
    timeoutMs: number;
    signal?: AbortSignal;
    acceptBrokerFailure?: boolean;
  }): Promise<Response> {
    input.signal?.throwIfAborted();
    const timeout = AbortSignal.timeout(input.timeoutMs);
    const signal = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout;
    let url = this.#url(input.path, input.query);
    let response: Response | null = null;
    // The provider proxy may answer the first exchange with a redirect before honoring `_token` on
    // the path directly. Follow it manually so the bearer header and the token survive the hop, and
    // never leave the endpoint's origin.
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      response = await this.#send({
        method: input.method,
        url,
        body: input.body,
        rawBody: input.rawBody,
        signal,
        callerSignal: input.signal,
      });
      if (response.status < 300 || response.status >= 400) break;
      const location = response.headers.get("location");
      // Redirect bodies are irrelevant; cancel so the connection is reusable.
      await response.body?.cancel().catch(() => undefined);
      const next = location === null ? null : this.#sameOriginRedirect(url, location);
      if (next === null || hop === MAX_REDIRECTS) {
        throw new CompanionBoxAgentRequestError("agent_http_error", response.status);
      }
      url = next;
      response = null;
    }
    if (response === null) throw new CompanionBoxAgentRequestError("agent_unreachable");
    if (!response.ok && !(input.acceptBrokerFailure && response.status === 502)) {
      const status = response.status;
      await response.body?.cancel().catch(() => undefined);
      if (status === 401 || status === 403) {
        throw new CompanionBoxAgentRequestError("agent_auth_failed", status);
      }
      if (status === 429) throw new CompanionBoxAgentRequestError("agent_rate_limited", status);
      if (status === 503) {
        throw new CompanionBoxAgentRequestError("agent_broker_unavailable", status);
      }
      if (status === 502) throw new CompanionBoxAgentRequestError("agent_broker_failed", status);
      throw new CompanionBoxAgentRequestError("agent_http_error", status);
    }
    return response;
  }

  async #send(input: {
    method: "GET" | "POST" | "PUT";
    url: URL;
    body?: Record<string, unknown>;
    rawBody?: Uint8Array;
    /** The composed caller+timeout signal handed to fetch. */
    signal: AbortSignal;
    /** The caller's own signal, kept apart so a timeout is never misread as a caller abort. */
    callerSignal?: AbortSignal;
  }): Promise<Response> {
    const headers = new Headers({ authorization: `Bearer ${this.#endpoint.bearerToken}` });
    const requestInit: RequestInit = {
      method: input.method,
      redirect: "manual",
      signal: input.signal,
      headers,
    };
    if (input.body !== undefined) {
      headers.set("content-type", "application/json");
      requestInit.body = JSON.stringify(input.body);
    } else if (input.rawBody !== undefined) {
      headers.set("content-type", "application/octet-stream");
      requestInit.body = Buffer.from(input.rawBody);
    }
    try {
      return await this.#fetch(input.url, requestInit);
    } catch (error) {
      throw this.#transportError(error, input.callerSignal);
    }
  }

  #transportError(error: unknown, callerSignal?: AbortSignal): Error {
    // A caller abort (lease loss, kill switch, shutdown) must surface as the caller's abort reason,
    // not be reclassified as an endpoint failure the facade would mark suspect.
    if (callerSignal?.aborted) {
      return callerSignal.reason instanceof Error
        ? callerSignal.reason
        : new CompanionBoxAgentRequestError("agent_aborted");
    }
    // Node surfaces the timeout abort as a `TimeoutError`/`AbortError`-named exception whose
    // concrete class varies across fetch internals; the name is the stable classifier.
    if (
      error instanceof Error
      && (error.name === "TimeoutError" || error.name === "AbortError")
    ) {
      return new CompanionBoxAgentRequestError("agent_timeout");
    }
    return new CompanionBoxAgentRequestError("agent_unreachable");
  }

  #url(path: string, query?: ReadonlyArray<readonly [string, string]>): URL {
    const url = new URL(`${this.#endpoint.hostedUrl}${path}`);
    url.searchParams.set("_token", this.#endpoint.proxyToken);
    for (const [key, value] of query ?? []) {
      url.searchParams.set(key, value);
    }
    return url;
  }

  #sameOriginRedirect(from: URL, location: string): URL | null {
    let next: URL;
    try {
      next = new URL(location, from);
    } catch {
      return null;
    }
    if (next.origin !== from.origin) return null;
    // Re-carry the proxy token: the gate's redirect target may drop the query string.
    if (!next.searchParams.get("_token")) {
      next.searchParams.set("_token", this.#endpoint.proxyToken);
    }
    return next;
  }
}

function promptDispatch(body: Record<string, unknown>, attemptId: string): CompanionPiPromptDispatch {
  if (
    body.piAcknowledged === true
    && body.attemptId === attemptId
    && typeof body.responseAttemptId === "string"
    && body.responseAttemptId.length > 0
    && typeof body.invocationId === "string"
    && body.invocationId.length > 0
    && Number.isSafeInteger(body.initialCursor)
    && Number(body.initialCursor) >= 0
    && body.clearOutbox === true
  ) {
    return {
      outcome: "accepted",
      attemptId,
      responseAttemptId: body.responseAttemptId,
      invocationId: body.invocationId,
      initialCursor: Number(body.initialCursor),
    };
  }
  return brokerFailure(body, "pi_ack_ambiguous");
}

function controlDispatch(
  body: Record<string, unknown>,
  attemptId: string,
  fallbackCode: string,
): CompanionPiControlDispatch {
  if (
    typeof body.invocationId === "string"
    && body.invocationId.length > 0
    && (
      body.aborted === false
      || (body.attemptId === attemptId && (body.delivered === true || body.aborted === true))
    )
  ) {
    return { outcome: "accepted", attemptId, invocationId: body.invocationId };
  }
  return brokerFailure(body, fallbackCode);
}

function brokerFailure(
  body: Record<string, unknown>,
  fallbackCode: string,
): { outcome: "refused" | "ambiguous"; code: string; message: string } {
  const error = body.error;
  if (error === null || typeof error !== "object" || Array.isArray(error)) {
    return { outcome: "ambiguous", code: fallbackCode, message: "Pi acknowledgement is unavailable" };
  }
  const record = error as Record<string, unknown>;
  const ambiguous = record.ambiguous === true;
  return {
    outcome: ambiguous ? "ambiguous" : "refused",
    code: typeof record.code === "string" && record.code.length > 0 ? record.code.slice(0, 64) : fallbackCode,
    message: typeof record.message === "string" && record.message.length > 0
      ? record.message.slice(0, 500)
      : "Pi acknowledgement is unavailable",
  };
}

function boundedTimeoutMs(ceilingMs: number, deadlineAt: Date | undefined): number {
  if (deadlineAt === undefined) return ceilingMs;
  return Math.max(1, Math.min(ceilingMs, deadlineAt.getTime() - Date.now()));
}

function parseBody<T>(parse: () => T): T {
  try {
    return parse();
  } catch {
    // The shared parser proves shape; a direct payload it rejects is an agent protocol failure the
    // facade answers with an exec fallback rather than a provider-shaped 502.
    throw new CompanionBoxAgentRequestError("agent_protocol", 200);
  }
}

function sha256Hex(bytes: Uint8Array): Promise<string> {
  return Promise.resolve(createHash("sha256").update(bytes).digest("hex"));
}

function stagedAttachments(
  body: Record<string, unknown>,
  messageId: string,
  expected: Array<{
    position: number;
    filename: string;
    contentType: string;
    byteSize: number;
    sha256: string;
  }>,
): CompanionStagedAttachment[] {
  if (!Array.isArray(body.files) || body.files.length !== expected.length) {
    throw new CompanionBoxAgentRequestError("agent_protocol", 200);
  }
  return body.files.map((value, index) => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new CompanionBoxAgentRequestError("agent_protocol", 200);
    }
    const record = value as Record<string, unknown>;
    const file = expected[index]!;
    const path = `~/attachments/${messageId}/${file.position}-${file.filename}`;
    if (
      record.position !== file.position
      || record.filename !== file.filename
      || record.contentType !== file.contentType
      || record.byteSize !== file.byteSize
      || record.sha256 !== file.sha256
      || record.path !== path
    ) throw new CompanionBoxAgentRequestError("agent_protocol", 200);
    return {
      position: file.position,
      filename: file.filename,
      contentType: file.contentType,
      byteSize: file.byteSize,
      path,
    };
  });
}

function outboxEntries(value: unknown): CompanionOutboxEntry[] {
  if (!Array.isArray(value)) throw new CompanionBoxAgentRequestError("agent_protocol", 200);
  return value.map((entry) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new CompanionBoxAgentRequestError("agent_protocol", 200);
    }
    const record = entry as Record<string, unknown>;
    if (
      typeof record.name !== "string" || record.name.length === 0 || record.name.length > 255
      || typeof record.encodedName !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(record.encodedName)
      || !Number.isSafeInteger(record.byteSize) || Number(record.byteSize) < 0
      || typeof record.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(record.sha256)
    ) throw new CompanionBoxAgentRequestError("agent_protocol", 200);
    return {
      name: record.name,
      encodedName: record.encodedName,
      byteSize: Number(record.byteSize),
      sha256: record.sha256,
    };
  });
}
