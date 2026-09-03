/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/no-unsafe-dictionary-type, anti-slop/require-safety-comment-for-type-assertion -- Predates the incremental anti-slop gate; file reawakened by an unrelated budget/reliability edit, existing debt not rewritten here. */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import {
  DESKTOP_REQUEST_PATH,
  DESKTOP_REQUEST_ID_HEADER,
  DESKTOP_SIGNATURE_HEADER,
  DESKTOP_TIMESTAMP_HEADER,
  verifyDesktopRequest,
} from "@companion/companion-runtime/runtime-support";

const DEFAULT_BODY_LIMIT_BYTES = 4 * 1024;
// Widened from 1s so a single slow DB ping does not flap /healthz (and trip a restart) when the
// connection is merely busy rather than down.
const DEFAULT_HEALTH_PING_TIMEOUT_MS = 2_500;

// The sweep-fresh window tolerates a few missed sweeps before declaring the claim loop stalled, so a
// GC pause or a backed-off recovery sweep does not flip the endpoint unhealthy. A floor of 15s keeps
// it stable even when the sweep interval is very short.
const MIN_SWEEP_FRESH_WINDOW_MS = 15_000;
const SWEEP_FRESH_WINDOW_MULTIPLE = 5;

export interface RuntimeSchedulerHealthSnapshot {
  claimLoopAlive: boolean;
  fatal: boolean;
  lastSweepStartedAt: Date | null;
  lastSweepCompletedAt: Date | null;
  claimLoopErrorAt: Date | null;
  activeCount: number;
}

/** Read-only image builder liveness surfaced on /healthz. Present only when the product is enabled. */
export interface RuntimeImageHealthSnapshot {
  loopAlive: boolean;
  status: string | null;
  lastErrorCode: string | null;
  coldFallbackCount: number;
}

export interface RuntimeHealthPort {
  ping(): Promise<void>;
  snapshot(): RuntimeSchedulerHealthSnapshot;
  /** Optional: absent when Companions are disabled and no builder runs. */
  image?(): RuntimeImageHealthSnapshot;
}

export interface RuntimeDesktopMint {
  url: string | null;
  provisioning: boolean;
  transport: "vnc" | "webrtc" | null;
}

export interface RuntimeDesktopPort {
  /** Must perform SQL Owner/Editor reauthorization before it creates or calls a Box client. */
  authorizeAndMint(input: {
    orgId: string;
    companionId: string;
    actorId: string;
    signal: AbortSignal;
  }): Promise<RuntimeDesktopMint | null>;
}

export interface RuntimeDesktopReplayPort {
  /** Atomically consumes one authenticated request id in shared durable storage. */
  consume(input: {
    requestId: string;
    timestamp: number;
    maxSkewSeconds: number;
  }): Promise<boolean>;
}

export interface RuntimeHttpServerOptions {
  host: string;
  port: number;
  sweepIntervalMs: number;
  /** Public, non-secret immutable deployment identifier; "unknown" is explicit misconfiguration. */
  releaseId: string;
  /** Null only while the product kill switch is active; desktop then fails closed with 503. */
  desktopHmacSecret: Uint8Array | null;
  desktopMaxSkewSeconds: number;
  health: RuntimeHealthPort;
  desktop: RuntimeDesktopPort;
  desktopReplay: RuntimeDesktopReplayPort;
  now?: () => number;
  bodyLimitBytes?: number;
  healthPingTimeoutMs?: number;
}

export interface RuntimeHttpServer {
  readonly nodeServer: Server;
  readonly baseUrl: string;
  listen(): Promise<void>;
  close(): Promise<void>;
}

export function createRuntimeHttpServer(options: RuntimeHttpServerOptions): RuntimeHttpServer {
  const now = options.now ?? Date.now;
  const bodyLimitBytes = positiveInteger(
    options.bodyLimitBytes ?? DEFAULT_BODY_LIMIT_BYTES,
    "bodyLimitBytes",
  );
  const healthPingTimeoutMs = positiveInteger(
    options.healthPingTimeoutMs ?? DEFAULT_HEALTH_PING_TIMEOUT_MS,
    "healthPingTimeoutMs",
  );
  const shutdown = new AbortController();
  let listening = false;

  const server = createServer((request, response) => {
    void route(request, response).catch(() => {
      if (!response.headersSent && !response.destroyed) {
        sendJson(response, 500, { error: "runtime_request_failed" });
      } else if (!response.destroyed) {
        response.end();
      }
    });
  });

  async function route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", "http://runtime.invalid");
    if (request.method === "GET" && url.pathname === "/healthz" && url.search === "") {
      await healthResponse(response);
      return;
    }
    if (url.pathname === DESKTOP_REQUEST_PATH && url.search === "") {
      if (request.method !== "POST") {
        response.setHeader("Allow", "POST");
        sendJson(response, 405, { error: "method_not_allowed" });
        return;
      }
      await desktopResponse(request, response, url.pathname);
      return;
    }
    sendJson(response, 404, { error: "not_found" });
  }

  async function healthResponse(response: ServerResponse): Promise<void> {
    let snapshot: RuntimeSchedulerHealthSnapshot;
    try {
      snapshot = options.health.snapshot();
    } catch {
      snapshot = emptyUnhealthySnapshot();
    }
    const database = await settlesBefore(options.health.ping(), healthPingTimeoutMs);
    const completedAt = validDate(snapshot.lastSweepCompletedAt);
    const errorAt = validDate(snapshot.claimLoopErrorAt);
    const elapsed = completedAt ? now() - completedAt.getTime() : Number.POSITIVE_INFINITY;
    const sweepFreshWindow = Math.max(
      options.sweepIntervalMs * SWEEP_FRESH_WINDOW_MULTIPLE,
      MIN_SWEEP_FRESH_WINDOW_MS,
    );
    const sweepFresh = elapsed >= 0 && elapsed <= sweepFreshWindow;
    const unrecoveredClaimError = errorAt !== null
      && (completedAt === null || errorAt.getTime() >= completedAt.getTime());
    const activeCount = Number.isSafeInteger(snapshot.activeCount) && snapshot.activeCount >= 0
      ? snapshot.activeCount
      : 0;
    const claimLoop = snapshot.claimLoopAlive && !snapshot.fatal && !unrecoveredClaimError;
    // Image builder liveness (when present) is a hard health gate: a dead loop means every create
    // silently cold-installs. A `failed` digest is only informational — creates still succeed via the
    // loud cold-install fallback — so it never flips health on its own.
    let image: RuntimeImageHealthSnapshot | null = null;
    try {
      image = options.health.image?.() ?? null;
    } catch {
      image = null;
    }
    const imageBuilderAlive = image === null || image.loopAlive;
    const healthy = database && claimLoop && sweepFresh && imageBuilderAlive;
    // Undefined values are dropped by JSON.stringify, so image fields simply vanish when no builder
    // runs — no conditional object spread, and the disabled-product response shape is unchanged.
    sendJson(response, healthy ? 200 : 503, {
      status: healthy ? "ok" : "unhealthy",
      checks: {
        database,
        claim_loop: claimLoop,
        sweep_fresh: sweepFresh,
        image_builder: image === null ? undefined : imageBuilderAlive,
      },
      last_sweep_started_at: isoOrNull(snapshot.lastSweepStartedAt),
      last_sweep_completed_at: isoOrNull(snapshot.lastSweepCompletedAt),
      claim_loop_error_at: isoOrNull(snapshot.claimLoopErrorAt),
      active_count: activeCount,
      release_id: options.releaseId,
      image: image === null ? undefined : {
        status: image.status,
        last_error_code: image.lastErrorCode,
        cold_fallback_count: image.coldFallbackCount,
      },
    });
  }

  async function desktopResponse(
    request: IncomingMessage,
    response: ServerResponse,
    pathname: string,
  ): Promise<void> {
    if (shutdown.signal.aborted) {
      sendJson(response, 503, { error: "runtime_stopping" });
      return;
    }
    if (options.desktopHmacSecret === null) {
      request.resume();
      sendJson(response, 503, { error: "desktop_not_configured" });
      return;
    }
    if (!request.headers["content-type"]?.toLowerCase().startsWith("application/json")) {
      request.resume();
      sendJson(response, 415, { error: "content_type_required" });
      return;
    }
    const length = Number(request.headers["content-length"] ?? 0);
    if (Number.isFinite(length) && length > bodyLimitBytes) {
      request.resume();
      sendJson(response, 413, { error: "request_too_large" });
      return;
    }
    let rawBody: Buffer;
    try {
      rawBody = await readBody(request, bodyLimitBytes);
    } catch (error) {
      if (error instanceof RequestTooLargeError) {
        sendJson(response, 413, { error: "request_too_large" });
        return;
      }
      throw error;
    }
    const timestampHeader = oneHeader(request, DESKTOP_TIMESTAMP_HEADER);
    const signature = oneHeader(request, DESKTOP_SIGNATURE_HEADER);
    const requestId = oneHeader(request, DESKTOP_REQUEST_ID_HEADER);
    const timestamp = timestampHeader !== null && /^(0|[1-9][0-9]*)$/.test(timestampHeader)
      ? Number(timestampHeader)
      : Number.NaN;
    if (
      !signature
      || !requestId
      || !Number.isSafeInteger(timestamp)
      || !verifyDesktopRequest({
        method: request.method ?? "",
        pathname,
        timestamp,
        requestId,
        rawBody,
        signature,
        nowMs: now(),
        maxSkewSeconds: options.desktopMaxSkewSeconds,
      }, options.desktopHmacSecret)
    ) {
      sendJson(response, 401, { error: "invalid_runtime_signature" });
      return;
    }
    let consumed: boolean;
    try {
      consumed = await options.desktopReplay.consume({
        requestId,
        timestamp,
        maxSkewSeconds: options.desktopMaxSkewSeconds,
      });
    } catch {
      sendJson(response, 503, { error: "desktop_unavailable" });
      return;
    }
    if (!consumed) {
      sendJson(response, 401, { error: "invalid_runtime_signature" });
      return;
    }
    const input = desktopInput(rawBody);
    if (!input) {
      sendJson(response, 400, { error: "invalid_request" });
      return;
    }
    let desktop: RuntimeDesktopMint | null;
    try {
      desktop = await options.desktop.authorizeAndMint({ ...input, signal: shutdown.signal });
    } catch {
      // In particular, never surface or log a provider error that may contain a minted URL.
      sendJson(response, 503, { error: "desktop_unavailable" });
      return;
    }
    if (!desktop) {
      sendJson(response, 403, { error: "desktop_forbidden" });
      return;
    }
    if (!validDesktopMint(desktop)) {
      sendJson(response, 503, { error: "desktop_unavailable" });
      return;
    }
    sendJson(response, 200, {
      desktop_url: desktop.url,
      provisioning: desktop.provisioning,
      automation: "lux",
      transport: desktop.transport,
    });
  }

  return {
    nodeServer: server,
    get baseUrl(): string {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("runtime server is not listening");
      const host = address.family === "IPv6" ? `[${address.address}]` : address.address;
      return `http://${host}:${address.port}`;
    },
    async listen(): Promise<void> {
      if (listening) return;
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error): void => {
          server.off("listening", onListening);
          reject(error);
        };
        const onListening = (): void => {
          server.off("error", onError);
          listening = true;
          resolve();
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(options.port, options.host);
      });
    },
    async close(): Promise<void> {
      if (shutdown.signal.aborted) return;
      shutdown.abort(new Error("runtime server is stopping"));
      if (!listening) return;
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
      listening = false;
    },
  };
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const payload = Buffer.from(`${JSON.stringify(body)}\n`, "utf8");
  response.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": payload.byteLength,
  });
  response.end(payload);
}

async function readBody(request: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  let tooLarge = false;
  for await (const chunk of request) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += value.byteLength;
    if (bytes > limit) {
      tooLarge = true;
      continue;
    }
    chunks.push(value);
  }
  if (tooLarge) throw new RequestTooLargeError();
  return Buffer.concat(chunks, bytes);
}

function desktopInput(rawBody: Buffer): {
  orgId: string;
  companionId: string;
  actorId: string;
} | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.toString("utf8")) as unknown;
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const value = parsed as Record<string, unknown>;
  const keys = Object.keys(value).sort();
  if (keys.join(",") !== "actorId,companionId,orgId") return null;
  if (!isUuid(value.orgId) || !isUuid(value.companionId) || !safeActorId(value.actorId)) return null;
  return { orgId: value.orgId, companionId: value.companionId, actorId: value.actorId };
}

function validDesktopMint(value: RuntimeDesktopMint): boolean {
  if (typeof value.provisioning !== "boolean") return false;
  if (value.transport !== null && value.transport !== "vnc" && value.transport !== "webrtc") {
    return false;
  }
  if (value.url === null) return value.transport === null;
  if (value.transport === null) return false;
  try {
    const url = new URL(value.url);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

function isUuid(value: unknown): value is string {
  return typeof value === "string"
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function safeActorId(value: unknown): value is string {
  return typeof value === "string"
    && value.length >= 1
    && value.length <= 200
    && !/[\r\n]/.test(value);
}

function oneHeader(request: IncomingMessage, name: string): string | null {
  const value = request.headers[name];
  return typeof value === "string" && value.length <= 512 ? value : null;
}

function validDate(value: Date | null): Date | null {
  return value instanceof Date && Number.isFinite(value.getTime()) ? value : null;
}

function isoOrNull(value: Date | null): string | null {
  return validDate(value)?.toISOString() ?? null;
}

function emptyUnhealthySnapshot(): RuntimeSchedulerHealthSnapshot {
  return {
    claimLoopAlive: false,
    fatal: true,
    lastSweepStartedAt: null,
    lastSweepCompletedAt: null,
    claimLoopErrorAt: null,
    activeCount: 0,
  };
}

async function settlesBefore(promise: Promise<void>, timeoutMs: number): Promise<boolean> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise.then(() => true, () => false),
      new Promise<boolean>((resolve) => {
        timeout = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be positive`);
  return value;
}

class RequestTooLargeError extends Error {}

export function runtimeServerAddress(server: Server): AddressInfo | null {
  const address = server.address();
  return address && typeof address !== "string" ? address : null;
}
