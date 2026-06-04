/**
 * Typed client for the Companion Console JSON API.
 *
 * Same-origin: every path is under `/api/console` (plus `/api/status`). The
 * client owns the per-process session-token handshake:
 *
 *  - PRODUCTION: the Go server injects the token into the served HTML, both as
 *    `window.__CONSOLE_TOKEN__` and a `<meta name="console-token">` tag.
 *  - DEV: the Vite-served HTML keeps the literal `%%CONSOLE_TOKEN%%` sentinel
 *    (no injection happens through the reverse proxy), so the client falls back
 *    to the dev-only endpoint `GET /api/console/session` once and caches it.
 *
 * The token is sent as `X-Console-Token` on mutating requests (POST/PUT/DELETE)
 * only; GETs are exempt server-side, so they carry no token. Non-2xx responses
 * are surfaced as `ConsoleError` carrying the HTTP status and the server's
 * `{ "error": ... }` message when present.
 */

import type {
  AgentDetail,
  AgentInput,
  AgentSummary,
  ApplyHistoryEntry,
  ApplyResponse,
  LogsResponse,
  OperationStatus,
  PlanOptions,
  PlanResponse,
  StatusSnapshot,
  WorkspaceInfo,
} from "./types";

const API_BASE = "/api/console";

/** The unreplaced sentinel left in dev HTML; treated as "no token present". */
const TOKEN_SENTINEL = "%%CONSOLE_TOKEN%%";

/**
 * Error thrown for any non-2xx console API response. `status` is the HTTP
 * status code; `message` is the server's error string when the body is the
 * standard `{ "error": "..." }` shape, otherwise a generic status message.
 */
export class ConsoleError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ConsoleError";
    this.status = status;
    // Restore prototype chain for instanceof across transpilation targets.
    Object.setPrototypeOf(this, ConsoleError.prototype);
  }
}

/**
 * Reads the injected session token from the page (window global first, then the
 * meta tag), ignoring the unreplaced dev sentinel. Returns null when no real
 * token is embedded — the dev fallback then fetches one.
 */
function tokenFromDocument(): string | null {
  const fromWindow =
    typeof window !== "undefined" ? window.__CONSOLE_TOKEN__ : undefined;
  if (isRealToken(fromWindow)) {
    return fromWindow as string;
  }
  if (typeof document !== "undefined") {
    const meta = document.querySelector<HTMLMetaElement>(
      'meta[name="console-token"]',
    );
    const fromMeta = meta?.content;
    if (isRealToken(fromMeta)) {
      return fromMeta as string;
    }
  }
  return null;
}

function isRealToken(value: string | undefined | null): boolean {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value !== TOKEN_SENTINEL
  );
}

// Cached token promise so the dev `/session` fallback is fetched at most once,
// even under concurrent mutating calls. Stored as a promise (not a value) so
// callers awaiting in parallel share one in-flight request.
let tokenPromise: Promise<string> | null = null;

/**
 * Resolves the session token, caching the result. Prefers the document-injected
 * token (production); otherwise fetches the dev-only `GET /api/console/session`
 * endpoint exactly once. A failure here is surfaced as a ConsoleError so the
 * calling mutation can report "could not obtain a session token".
 */
export function getSessionToken(): Promise<string> {
  const embedded = tokenFromDocument();
  if (embedded) {
    return Promise.resolve(embedded);
  }
  if (!tokenPromise) {
    tokenPromise = (async () => {
      const res = await fetch(`${API_BASE}/session`, {
        headers: { Accept: "application/json" },
      });
      if (!res.ok) {
        // Don't poison the cache on failure: allow a later retry.
        tokenPromise = null;
        throw await toConsoleError(res);
      }
      const data = (await res.json()) as { token?: string };
      const token = data?.token;
      if (!isRealToken(token)) {
        tokenPromise = null;
        throw new ConsoleError(res.status, "console session token unavailable");
      }
      return token as string;
    })();
  }
  return tokenPromise;
}

/**
 * Test/SSR seam: resets the cached token promise. Exported so tests can isolate
 * the dev-fallback path between cases. Not used by application code.
 */
export function __resetTokenCacheForTests(): void {
  tokenPromise = null;
}

/** Builds a ConsoleError from a non-ok Response, reading its error body. */
async function toConsoleError(res: Response): Promise<ConsoleError> {
  let message = `request failed with status ${res.status}`;
  try {
    const text = await res.text();
    if (text) {
      try {
        const parsed = JSON.parse(text) as { error?: string };
        if (parsed && typeof parsed.error === "string" && parsed.error) {
          message = parsed.error;
        } else {
          message = text;
        }
      } catch {
        message = text;
      }
    }
  } catch {
    // Body already consumed or unreadable: keep the generic status message.
  }
  return new ConsoleError(res.status, message);
}

/** Parses a JSON response body, tolerating an empty body as `undefined`. */
async function parseJSON<T>(res: Response): Promise<T> {
  const text = await res.text();
  if (!text) {
    return undefined as T;
  }
  return JSON.parse(text) as T;
}

/** Performs a read-only GET; no token is attached (GETs are server-exempt). */
async function getJSON<T>(path: string): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: "GET",
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    throw await toConsoleError(res);
  }
  return parseJSON<T>(res);
}

type MutateMethod = "POST" | "PUT" | "DELETE";

/**
 * Performs a mutating request, attaching the resolved `X-Console-Token` header.
 * The token is fetched/cached lazily so reads never trigger the handshake.
 */
async function mutateJSON<T>(
  method: MutateMethod,
  path: string,
  body?: unknown,
): Promise<T> {
  const token = await getSessionToken();
  const headers: Record<string, string> = {
    Accept: "application/json",
    "X-Console-Token": token,
  };
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
  }
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    throw await toConsoleError(res);
  }
  return parseJSON<T>(res);
}

// --- Public API surface (imported verbatim by the feature pages) ----------

/** GET /api/console/workspace */
export function getWorkspace(): Promise<WorkspaceInfo> {
  return getJSON<WorkspaceInfo>("/workspace");
}

/** GET /api/console/agents */
export function listAgents(): Promise<AgentSummary[]> {
  return getJSON<AgentSummary[]>("/agents");
}

/** GET /api/console/agents/{id} */
export function getAgent(id: string): Promise<AgentDetail> {
  return getJSON<AgentDetail>(`/agents/${encodeURIComponent(id)}`);
}

/** POST /api/console/agents -> 201 AgentDetail */
export function createAgent(input: AgentInput): Promise<AgentDetail> {
  return mutateJSON<AgentDetail>("POST", "/agents", input);
}

/** PUT /api/console/agents/{id} -> 200 AgentDetail */
export function updateAgent(id: string, input: AgentInput): Promise<AgentDetail> {
  return mutateJSON<AgentDetail>(
    "PUT",
    `/agents/${encodeURIComponent(id)}`,
    input,
  );
}

/** DELETE /api/console/agents/{id} -> 200 AgentDetail (lifecycle="absent") */
export function deleteAgent(id: string): Promise<AgentDetail> {
  return mutateJSON<AgentDetail>("DELETE", `/agents/${encodeURIComponent(id)}`);
}

/**
 * POST /api/console/plan -> PlanResponse. The destroy confirmations default to
 * false, so a plain plan reports protected destructions as blocked. Pass
 * { allowProtectedDestroy, destroyData } to compute (and later apply) a destroy.
 */
export function plan(opts: PlanOptions = {}): Promise<PlanResponse> {
  return mutateJSON<PlanResponse>("POST", "/plan", {
    allow_protected_destroy: opts.allowProtectedDestroy ?? false,
    destroy_data: opts.destroyData ?? false,
  });
}

/** POST /api/console/apply -> 202 ApplyResponse (409 on stale hash / in-flight) */
export function apply(hash: string): Promise<ApplyResponse> {
  return mutateJSON<ApplyResponse>("POST", "/apply", { hash });
}

/** GET /api/console/operations/{id} */
export function getOperation(id: string): Promise<OperationStatus> {
  return getJSON<OperationStatus>(`/operations/${encodeURIComponent(id)}`);
}

/** GET /api/console/applies */
export function listApplies(): Promise<ApplyHistoryEntry[]> {
  return getJSON<ApplyHistoryEntry[]>("/applies");
}

/** GET /api/console/agents/{id}/logs */
export function getAgentLogs(id: string): Promise<LogsResponse> {
  return getJSON<LogsResponse>(`/agents/${encodeURIComponent(id)}/logs`);
}

/** GET /api/status (existing fleet status snapshot; same origin, no /console). */
export function getStatus(): Promise<StatusSnapshot> {
  return fetch("/api/status", {
    method: "GET",
    headers: { Accept: "application/json" },
  }).then(async (res) => {
    if (!res.ok) {
      throw await toConsoleError(res);
    }
    return parseJSON<StatusSnapshot>(res);
  });
}
