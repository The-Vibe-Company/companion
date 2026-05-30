import type { SdkSessionInfo } from "./types.js";
import type { ContentBlock } from "./types.js";
import { captureEvent, captureException } from "./analytics.js";

const BASE = "/api";
const AUTH_STORAGE_KEY = "companion_auth_token";

function getAuthHeaders(): Record<string, string> {
  if (typeof window === "undefined") return {};
  const token = localStorage.getItem(AUTH_STORAGE_KEY);
  if (!token) return {};
  return { Authorization: `Bearer ${token}` };
}

function handle401(status: number): void {
  if (status === 401 && typeof window !== "undefined") {
    localStorage.removeItem(AUTH_STORAGE_KEY);
    // Dynamic import to avoid circular dependency
    import("./store.js").then(({ useStore }) => {
      useStore.getState().logout();
    }).catch(() => {});
  }
}

function nowMs(): number {
  if (typeof performance !== "undefined" && typeof performance.now === "function") {
    return performance.now();
  }
  return Date.now();
}

function trackApiSuccess(method: string, path: string, durationMs: number, status: number): void {
  captureEvent("api_request_succeeded", {
    method,
    path,
    status,
    duration_ms: Math.round(durationMs),
  });
}

function trackApiFailure(
  method: string,
  path: string,
  durationMs: number,
  error: unknown,
  status?: number,
): void {
  captureEvent("api_request_failed", {
    method,
    path,
    status,
    duration_ms: Math.round(durationMs),
    error: error instanceof Error ? error.message : String(error),
  });
  captureException(error, { method, path, status });
}

/**
 * Expected-cancellation errors that must NOT be reported to analytics /
 * Sentry. Abortable GETs (IdePicker cleanup, superseded requests) reject
 * with an AbortError — that is normal UX, not a failure.
 *
 * Browsers produce a DOMException with `.name === "AbortError"`; node /
 * jsdom produces a plain Error with the same `.name`. Both paths are
 * covered by the name check.
 *
 * cubic PR #652 round-3 (P2). Regression tests: Abort-01 / Abort-02 in api.test.ts.
 */
function isAbortError(error: unknown): boolean {
  if (typeof DOMException !== "undefined" && error instanceof DOMException) {
    return error.name === "AbortError";
  }
  return error instanceof Error && error.name === "AbortError";
}

async function post<T = unknown>(path: string, body?: object): Promise<T> {
  const startedAt = nowMs();
  let failureTracked = false;
  try {
    const res = await fetch(`${BASE}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...getAuthHeaders() },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      handle401(res.status);
      const err = await res.json().catch(() => ({ error: res.statusText }));
      const apiError = new Error(err.error || res.statusText);
      trackApiFailure("POST", path, nowMs() - startedAt, apiError, res.status);
      failureTracked = true;
      throw apiError;
    }
    trackApiSuccess("POST", path, nowMs() - startedAt, res.status);
    return res.json();
  } catch (error) {
    if (!failureTracked && !isAbortError(error)) {
      trackApiFailure("POST", path, nowMs() - startedAt, error);
    }
    throw error;
  }
}

async function get<T = unknown>(path: string, signal?: AbortSignal): Promise<T> {
  const startedAt = nowMs();
  let failureTracked = false;
  try {
    const res = await fetch(`${BASE}${path}`, {
      headers: { ...getAuthHeaders() },
      signal,
    });
    if (!res.ok) {
      handle401(res.status);
      const err = await res.json().catch(() => ({ error: res.statusText }));
      const apiError = new Error(err.error || res.statusText);
      trackApiFailure("GET", path, nowMs() - startedAt, apiError, res.status);
      failureTracked = true;
      throw apiError;
    }
    trackApiSuccess("GET", path, nowMs() - startedAt, res.status);
    return res.json();
  } catch (error) {
    if (!failureTracked && !isAbortError(error)) {
      trackApiFailure("GET", path, nowMs() - startedAt, error);
    }
    throw error;
  }
}

async function put<T = unknown>(path: string, body?: object): Promise<T> {
  const startedAt = nowMs();
  let failureTracked = false;
  try {
    const res = await fetch(`${BASE}${path}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...getAuthHeaders() },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      handle401(res.status);
      const err = await res.json().catch(() => ({ error: res.statusText }));
      const apiError = new Error(err.error || res.statusText);
      trackApiFailure("PUT", path, nowMs() - startedAt, apiError, res.status);
      failureTracked = true;
      throw apiError;
    }
    trackApiSuccess("PUT", path, nowMs() - startedAt, res.status);
    return res.json();
  } catch (error) {
    if (!failureTracked && !isAbortError(error)) {
      trackApiFailure("PUT", path, nowMs() - startedAt, error);
    }
    throw error;
  }
}

async function patch<T = unknown>(path: string, body?: object): Promise<T> {
  const startedAt = nowMs();
  let failureTracked = false;
  try {
    const res = await fetch(`${BASE}${path}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...getAuthHeaders() },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      handle401(res.status);
      const err = await res.json().catch(() => ({ error: res.statusText }));
      const apiError = new Error(err.error || res.statusText);
      trackApiFailure("PATCH", path, nowMs() - startedAt, apiError, res.status);
      failureTracked = true;
      throw apiError;
    }
    trackApiSuccess("PATCH", path, nowMs() - startedAt, res.status);
    return res.json();
  } catch (error) {
    if (!failureTracked && !isAbortError(error)) {
      trackApiFailure("PATCH", path, nowMs() - startedAt, error);
    }
    throw error;
  }
}

async function del<T = unknown>(path: string, body?: object): Promise<T> {
  const startedAt = nowMs();
  let failureTracked = false;
  try {
    const res = await fetch(`${BASE}${path}`, {
      method: "DELETE",
      headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...getAuthHeaders() },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      handle401(res.status);
      const err = await res.json().catch(() => ({ error: res.statusText }));
      const apiError = new Error(err.error || res.statusText);
      trackApiFailure("DELETE", path, nowMs() - startedAt, apiError, res.status);
      failureTracked = true;
      throw apiError;
    }
    trackApiSuccess("DELETE", path, nowMs() - startedAt, res.status);
    return res.json();
  } catch (error) {
    if (!failureTracked && !isAbortError(error)) {
      trackApiFailure("DELETE", path, nowMs() - startedAt, error);
    }
    throw error;
  }
}

export interface ContainerCreateOpts {
  image?: string;
  ports?: number[];
  volumes?: string[];
  env?: Record<string, string>;
}

export interface ContainerStatus {
  available: boolean;
  version: string | null;
}

export interface CloudProviderPlan {
  provider: "modal";
  sessionId: string;
  image: string;
  cwd: string;
  mappedPorts: Array<{ containerPort: number; hostPort: number }>;
  commandPreview: string;
}

export interface CreateSessionOpts {
  model?: string;
  permissionMode?: string;
  cwd?: string;
  claudeBinary?: string;
  codexBinary?: string;
  codexInternetAccess?: boolean;
  allowedTools?: string[];
  envSlug?: string;
  branch?: string;
  createBranch?: boolean;
  useWorktree?: boolean;
  backend?: "claude" | "codex";
  sandboxEnabled?: boolean;
  sandboxSlug?: string;
  container?: ContainerCreateOpts;
  resumeSessionAt?: string;
  forkSession?: boolean;
  linearConnectionId?: string;
  linearIssue?: {
    identifier: string;
    title: string;
    stateName: string;
    teamName: string;
    url: string;
  };
}

export interface BackendInfo {
  id: string;
  name: string;
  available: boolean;
}

export interface BackendModelInfo {
  value: string;
  label: string;
  description: string;
}

export interface ClaudeDiscoveredSession {
  sessionId: string;
  cwd: string;
  gitBranch?: string;
  slug?: string;
  lastActivityAt: number;
  sourceFile: string;
}

export interface ClaudeSessionHistoryMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  contentBlocks?: ContentBlock[];
  timestamp: number;
  model?: string;
  stopReason?: string | null;
}

export interface ClaudeSessionHistoryPage {
  sourceFile: string;
  messages: ClaudeSessionHistoryMessage[];
  nextCursor: number;
  hasMore: boolean;
  totalMessages: number;
}

export interface GitRepoInfo {
  repoRoot: string;
  repoName: string;
  currentBranch: string;
  defaultBranch: string;
  isWorktree: boolean;
}

export interface GitBranchInfo {
  name: string;
  isCurrent: boolean;
  isRemote: boolean;
  worktreePath: string | null;
  ahead: number;
  behind: number;
}

export interface GitWorktreeInfo {
  path: string;
  branch: string;
  head: string;
  isMainWorktree: boolean;
  isDirty: boolean;
}

export interface WorktreeCreateResult {
  worktreePath: string;
  branch: string;
  isNew: boolean;
}

export interface CompanionEnv {
  name: string;
  slug: string;
  variables: Record<string, string>;
  createdAt: number;
  updatedAt: number;
}

export interface CompanionSandbox {
  name: string;
  slug: string;
  initScript?: string;
  createdAt: number;
  updatedAt: number;
}

export interface ImagePullState {
  image: string;
  status: "idle" | "pulling" | "ready" | "error";
  progress: string[];
  error?: string;
  startedAt?: number;
  completedAt?: number;
}

export interface DirEntry {
  name: string;
  path: string;
}

export interface DirListResult {
  path: string;
  dirs: DirEntry[];
  home: string;
  error?: string;
}

export interface TreeNode {
  name: string;
  path: string;
  type: "file" | "directory";
  children?: TreeNode[];
}

export interface UpdateInfo {
  currentVersion: string;
  latestVersion: string | null;
  updateAvailable: boolean;
  isServiceMode: boolean;
  updateInProgress: boolean;
  lastChecked: number;
  channel: "stable" | "prerelease";
}

export interface UsageLimits {
  five_hour: { utilization: number; resets_at: string | null } | null;
  seven_day: { utilization: number; resets_at: string | null } | null;
  extra_usage: {
    is_enabled: boolean;
    monthly_limit: number;
    used_credits: number;
    utilization: number | null;
  } | null;
}

export interface EditorStartResult {
  available: boolean;
  installed: boolean;
  mode: "host" | "container";
  url?: string;
  message?: string;
}

export interface BrowserStartResult {
  available: boolean;
  mode: "host" | "container";
  url?: string;
  message?: string;
}

/** Keep in sync with web/server/tailscale-manager.ts TailscaleStatus */
export interface TailscaleStatus {
  installed: boolean;
  binaryPath: string | null;
  connected: boolean;
  dnsName: string | null;
  funnelActive: boolean;
  funnelUrl: string | null;
  error: string | null;
  needsOperatorMode?: boolean;
  warning?: string;
}

export interface AppSettings {
  anthropicApiKeyConfigured: boolean;
  anthropicModel: string;
  claudeCodeOAuthTokenConfigured: boolean;
  openaiApiKeyConfigured: boolean;
  codexDeviceAuthConfigured: boolean;
  onboardingCompleted: boolean;
  linearApiKeyConfigured: boolean;
  linearConnectionCount: number;
  linearAutoTransition: boolean;
  linearAutoTransitionStateName: string;
  linearArchiveTransition: boolean;
  linearArchiveTransitionStateName: string;
  linearOAuthConfigured: boolean;
  linearOAuthCredentialsSaved: boolean;
  aiValidationEnabled: boolean;
  aiValidationAutoApprove: boolean;
  aiValidationAutoDeny: boolean;
  publicUrl: string;
  updateChannel: "stable" | "prerelease";
  dockerAutoUpdate: boolean;
}

export interface LinearOAuthConnectionSummary {
  id: string;
  name: string;
  oauthClientId: string;
  status: "connected" | "disconnected";
  hasAccessToken: boolean;
  hasClientSecret: boolean;
  hasWebhookSecret: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface LinearConnectionSummary {
  id: string;
  name: string;
  apiKeyLast4: string;
  workspaceName: string;
  workspaceId: string;
  viewerName: string;
  viewerEmail: string;
  connected: boolean;
  autoTransition: boolean;
  autoTransitionStateId: string;
  autoTransitionStateName: string;
  archiveTransition: boolean;
  archiveTransitionStateId: string;
  archiveTransitionStateName: string;
}

export interface ArchiveInfo {
  hasLinkedIssue: boolean;
  issueNotDone: boolean;
  issue?: {
    id: string;
    identifier: string;
    stateName: string;
    stateType: string;
    teamId: string;
  };
  hasBacklogState?: boolean;
  archiveTransitionConfigured?: boolean;
  archiveTransitionStateName?: string;
}

export interface LinearWorkflowState {
  id: string;
  name: string;
  type: string;
}

export interface LinearTeamStates {
  id: string;
  key: string;
  name: string;
  states: LinearWorkflowState[];
}

export interface LinearIssue {
  id: string;
  identifier: string;
  title: string;
  description: string;
  url: string;
  branchName: string;
  priorityLabel: string;
  stateName: string;
  stateType: string;
  teamName: string;
  teamKey: string;
  teamId: string;
  assigneeName?: string;
  updatedAt?: string;
  connectionId?: string;
}

export interface LinearConnectionInfo {
  connected: boolean;
  viewerId: string;
  viewerName: string;
  viewerEmail: string;
  teamName: string;
  teamKey: string;
}

export interface LinearComment {
  id: string;
  body: string;
  createdAt: string;
  userName: string;
  userAvatarUrl?: string | null;
}

export interface LinearIssueDetail {
  issue: LinearIssue | null;
  comments?: LinearComment[];
  assignee?: { name: string; avatarUrl?: string | null } | null;
  labels?: { id: string; name: string; color: string }[];
}

export interface LinearProject {
  id: string;
  name: string;
  state: string;
}

export interface LinearProjectMapping {
  repoRoot: string;
  projectId: string;
  projectName: string;
  createdAt: number;
  updatedAt: number;
}

export interface CreateLinearIssueInput {
  title: string;
  description?: string;
  teamId: string;
  priority?: number;
  projectId?: string;
  assigneeId?: string;
  stateId?: string;
  connectionId?: string;
}

export interface GitHubPRInfo {
  number: number;
  title: string;
  url: string;
  state: "OPEN" | "CLOSED" | "MERGED";
  isDraft: boolean;
  reviewDecision: "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | null;
  additions: number;
  deletions: number;
  changedFiles: number;
  checks: { name: string; status: string; conclusion: string | null }[];
  checksSummary: { total: number; success: number; failure: number; pending: number };
  reviewThreads: { total: number; resolved: number; unresolved: number };
}

export interface PRStatusResponse {
  available: boolean;
  pr: GitHubPRInfo | null;
}

export interface CronJobInfo {
  id: string;
  name: string;
  prompt: string;
  schedule: string;
  recurring: boolean;
  backendType: "claude" | "codex";
  model: string;
  cwd: string;
  envSlug?: string;
  enabled: boolean;
  permissionMode: string;
  codexInternetAccess?: boolean;
  createdAt: number;
  updatedAt: number;
  lastRunAt?: number;
  lastSessionId?: string;
  consecutiveFailures: number;
  totalRuns: number;
  nextRunAt?: number | null;
}

export interface CronJobExecution {
  sessionId: string;
  jobId: string;
  startedAt: number;
  completedAt?: number;
  success?: boolean;
  error?: string;
  costUsd?: number;
}

export interface McpServerConfigAgent {
  type: "stdio" | "sse" | "http";
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
}

export interface AgentInfo {
  id: string;
  version: 1;
  name: string;
  description: string;
  icon?: string;
  backendType: "claude" | "codex";
  model: string;
  permissionMode: string;
  cwd: string;
  envSlug?: string;
  env?: Record<string, string>;
  allowedTools?: string[];
  codexInternetAccess?: boolean;
  prompt: string;
  mcpServers?: Record<string, McpServerConfigAgent>;
  skills?: string[];
  container?: {
    image?: string;
    ports?: number[];
    volumes?: string[];
    initScript?: string;
  };
  branch?: string;
  createBranch?: boolean;
  useWorktree?: boolean;
  triggers?: {
    webhook?: {
      enabled: boolean;
      secret: string;
    };
    schedule?: {
      enabled: boolean;
      expression: string;
      recurring: boolean;
    };
    /** Linear Agent Interaction SDK trigger (per-agent OAuth app) */
    linear?: {
      enabled: boolean;
      /** Reference to a LinearOAuthConnection by ID (new model) */
      oauthConnectionId?: string;
      /** Resolved name of the referenced OAuth connection */
      oauthConnectionName?: string;
      /** Resolved status of the referenced OAuth connection */
      oauthConnectionStatus?: string;
      /** @deprecated OAuth app client ID (legacy inline model) */
      oauthClientId?: string;
      /** Whether the agent has an access token (OAuth connected) */
      hasAccessToken?: boolean;
      /** Whether the agent has a client secret configured */
      hasClientSecret?: boolean;
      /** Whether the agent has a webhook secret configured */
      hasWebhookSecret?: boolean;
    };
  };
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
  lastRunAt?: number;
  lastSessionId?: string;
  totalRuns: number;
  consecutiveFailures: number;
  nextRunAt?: number | null;
}

export interface AgentExecution {
  sessionId: string;
  agentId: string;
  triggerType: "manual" | "webhook" | "schedule" | "linear";
  startedAt: number;
  completedAt?: number;
  success?: boolean;
  error?: string;
}

export interface ExecutionListResult {
  executions: AgentExecution[];
  total: number;
}

/** Portable export format (no internal tracking fields) */
export type AgentExport = Omit<
  AgentInfo,
  "id" | "createdAt" | "updatedAt" | "totalRuns" | "consecutiveFailures" | "lastRunAt" | "lastSessionId" | "enabled" | "nextRunAt"
>;

export interface SavedPrompt {
  id: string;
  name: string;
  content: string;
  scope: "global" | "project";
  projectPath?: string;
  projectPaths?: string[];
  createdAt: number;
  updatedAt: number;
}

// ─── Claude Config Browser ──────────────────────────────────────────────────

export interface ClaudeConfigResponse {
  project: {
    root: string;
    claudeMd: { path: string; content: string }[];
    settings: { path: string; content: string } | null;
    settingsLocal: { path: string; content: string } | null;
    commands: { name: string; path: string }[];
  };
  user: {
    root: string;
    claudeMd: { path: string; content: string } | null;
    skills: { slug: string; name: string; description: string; path: string }[];
    agents: { name: string; path: string }[];
    settings: { path: string; content: string } | null;
    commands: { name: string; path: string }[];
  };
}

// ─── SSE Session Creation ────────────────────────────────────────────────────

export interface CreationProgressEvent {
  step: string;
  label: string;
  status: "in_progress" | "done" | "error";
  detail?: string;
}

export interface CreateSessionStreamResult {
  sessionId: string;
  state: string;
  cwd: string;
  backendType?: "claude" | "codex";
  resumeSessionAt?: string;
  forkSession?: boolean;
}

/**
 * Create a session with real-time progress streaming via SSE.
 * Uses fetch + ReadableStream (EventSource is GET-only, this is POST).
 */
export async function createSessionStream(
  opts: CreateSessionOpts | undefined,
  onProgress: (progress: CreationProgressEvent) => void,
): Promise<CreateSessionStreamResult> {
  const res = await fetch(`${BASE}/sessions/create-stream`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...getAuthHeaders() },
    body: JSON.stringify(opts ?? {}),
  });

  if (!res.ok || !res.body) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error((err as { error?: string }).error || res.statusText);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let result: CreateSessionStreamResult | null = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // Parse SSE events: split on double newlines
    const chunks = buffer.split("\n\n");
    buffer = chunks.pop() || "";

    for (const chunk of chunks) {
      if (!chunk.trim()) continue;
      let eventType = "";
      let data = "";
      for (const line of chunk.split("\n")) {
        if (line.startsWith("event:")) eventType = line.slice(6).trim();
        else if (line.startsWith("data:")) data = line.slice(5).trim();
      }
      if (!data) continue;

      const parsed = JSON.parse(data);
      if (eventType === "progress") {
        onProgress(parsed as CreationProgressEvent);
      } else if (eventType === "done") {
        result = parsed as CreateSessionStreamResult;
      } else if (eventType === "error") {
        throw new Error((parsed as { error: string }).error || "Session creation failed");
      }
    }
  }

  if (!result) {
    throw new Error("Stream ended without session creation result");
  }

  return result;
}

/**
 * Verify an auth token with the server.
 * This does NOT use the auth header helpers since it's called before auth is established.
 */
/**
 * Attempt auto-authentication for localhost users.
 * The server returns the token if the request comes from 127.0.0.1/::1.
 * No auth header needed — this is a pre-auth endpoint.
 */
export async function autoAuth(): Promise<string | null> {
  try {
    const res = await fetch(`${BASE}/auth/auto`);
    if (res.ok) {
      const data = await res.json() as { ok: boolean; token?: string };
      if (data.ok && data.token) return data.token;
    }
    return null;
  } catch {
    return null;
  }
}

// ─── IDE integration (Task 9 — STATE-02) ─────────────────────────────────────
//
// `AvailableIde` mirrors the server wire shape for `GET /api/ide/available`
// (see `web/server/routes/system-routes.ts`). `authToken` is deliberately
// stripped server-side (BIND-03) and therefore NOT on this client type.
// It is defined inline here (not in types.ts) because it's strictly a REST
// wire shape, matching the existing convention for response DTOs like
// `ClaudeDiscoveredSession`, `LinearIssue`, etc. `IdeBinding` — which IS
// persisted as part of `SessionState` — continues to live in types.ts.
export interface AvailableIde {
  port: number;
  ideName: string;
  workspaceFolders: string[];
  transport: "ws-ide" | "sse-ide";
  lockfilePath: string;
  lockfileMtime: number;
}

/**
 * List all currently-discovered IDEs. When `cwd` is passed, the server
 * ranks candidates by longest-prefix workspace match (see MATCH-01/02);
 * otherwise results are ordered by lockfile mtime desc.
 *
 * Throws on non-2xx — the IdePicker treats that as "unable to load" and
 * renders a retry affordance.
 */
export async function getAvailableIdes(
  cwd?: string,
  signal?: AbortSignal,
): Promise<AvailableIde[]> {
  const qs = cwd ? `?cwd=${encodeURIComponent(cwd)}` : "";
  return get<AvailableIde[]>(`/ide/available${qs}`, signal);
}

/**
 * Bind the given session to an IDE discovered on `port`.
 *
 * Uses a raw fetch (not the shared `post` helper) because 400 / 404
 * responses here are EXPECTED UX states — "port no longer available",
 * "session vanished between discovery and pick" — and must NOT throw.
 * Any other transport error still throws.
 */
export async function bindIde(
  sessionId: string,
  port: number,
): Promise<
  | { ok: true; binding: import("./types.js").IdeBinding }
  | { ok: false; error: string }
> {
  const path = `/sessions/${encodeURIComponent(sessionId)}/ide`;
  const startedAt = nowMs();
  try {
    const res = await fetch(`${BASE}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...getAuthHeaders() },
      body: JSON.stringify({ port }),
    });
    if (res.ok) {
      trackApiSuccess("POST", path, nowMs() - startedAt, res.status);
      const body = (await res.json()) as {
        ok: true;
        binding: import("./types.js").IdeBinding;
      };
      return body;
    }
    // 401 still triggers global auth reset before we return a soft failure.
    handle401(res.status);
    const err = await res
      .json()
      .catch(() => ({ error: res.statusText } as { error?: string }));
    const message = err.error || res.statusText;
    // Report the failure to analytics as a soft failure (we don't throw).
    trackApiFailure("POST", path, nowMs() - startedAt, new Error(message), res.status);
    return { ok: false, error: message };
  } catch (error) {
    // Transport-level failure (network, JSON parse on success path, etc.).
    // Skip AbortError — cancellations are expected UX, not failures.
    if (!isAbortError(error)) {
      trackApiFailure("POST", path, nowMs() - startedAt, error);
    }
    throw error;
  }
}

/**
 * Clear any IDE binding on a session. Idempotent at the server, but 404
 * (session truly gone) DOES throw — callers should distinguish "already
 * cleared" (200) from "no such session".
 */
export async function unbindIde(
  sessionId: string,
): Promise<{ ok: true }> {
  return del<{ ok: true }>(`/sessions/${encodeURIComponent(sessionId)}/ide`);
}

export async function verifyAuthToken(token: string): Promise<boolean> {
  try {
    const res = await fetch(`${BASE}/auth/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
    if (res.ok) {
      const data = await res.json();
      return !!(data as { ok?: boolean }).ok;
    }
    return false;
  } catch {
    return false;
  }
}

export const api = {
  // Auth
  getAuthQr: () =>
    get<{ qrCodes: { label: string; url: string; qrDataUrl: string }[] }>("/auth/qr"),
  getAuthToken: () =>
    get<{ token: string }>("/auth/token"),
  regenerateAuthToken: () =>
    post<{ token: string }>("/auth/regenerate"),

  createSession: (opts?: CreateSessionOpts) =>
    post<{ sessionId: string; state: string; cwd: string }>(
      "/sessions/create",
      opts,
    ),

  listSessions: () => get<SdkSessionInfo[]>("/sessions"),
  discoverClaudeSessions: (limit = 200) =>
    get<{ sessions: ClaudeDiscoveredSession[] }>(
      `/claude/sessions/discover?limit=${encodeURIComponent(String(limit))}`,
    ),
  getClaudeSessionHistory: (sessionId: string, opts?: { cursor?: number; limit?: number }) => {
    const cursor = Math.max(0, Math.floor(opts?.cursor ?? 0));
    const limit = Math.max(1, Math.floor(opts?.limit ?? 40));
    return get<ClaudeSessionHistoryPage>(
      `/claude/sessions/${encodeURIComponent(sessionId)}/history?cursor=${encodeURIComponent(String(cursor))}&limit=${encodeURIComponent(String(limit))}`,
    );
  },

  killSession: (sessionId: string) =>
    post(`/sessions/${encodeURIComponent(sessionId)}/kill`),

  deleteSession: (sessionId: string) =>
    del(`/sessions/${encodeURIComponent(sessionId)}`),

  relaunchSession: (sessionId: string) =>
    post(`/sessions/${encodeURIComponent(sessionId)}/relaunch`),

  archiveSession: (sessionId: string, opts?: { force?: boolean; linearTransition?: "none" | "backlog" | "configured" }) =>
    post(`/sessions/${encodeURIComponent(sessionId)}/archive`, opts),

  getArchiveInfo: (sessionId: string) =>
    get<ArchiveInfo>(`/sessions/${encodeURIComponent(sessionId)}/archive-info`),

  unarchiveSession: (sessionId: string) =>
    post(`/sessions/${encodeURIComponent(sessionId)}/unarchive`),

  renameSession: (sessionId: string, name: string) =>
    patch<{ ok: boolean; name: string }>(
      `/sessions/${encodeURIComponent(sessionId)}/name`,
      { name },
    ),

  listDirs: (path?: string) =>
    get<DirListResult>(
      `/fs/list${path ? `?path=${encodeURIComponent(path)}` : ""}`,
    ),

  getHome: () => get<{ home: string; cwd: string }>("/fs/home"),

  // Environments
  listEnvs: () => get<CompanionEnv[]>("/envs"),
  getEnv: (slug: string) =>
    get<CompanionEnv>(`/envs/${encodeURIComponent(slug)}`),
  createEnv: (name: string, variables: Record<string, string>) =>
    post<CompanionEnv>("/envs", { name, variables }),
  updateEnv: (
    slug: string,
    data: {
      name?: string;
      variables?: Record<string, string>;
    },
  ) => put<CompanionEnv>(`/envs/${encodeURIComponent(slug)}`, data),
  deleteEnv: (slug: string) => del(`/envs/${encodeURIComponent(slug)}`),

  // Sandboxes
  listSandboxes: () => get<CompanionSandbox[]>("/sandboxes"),
  getSandbox: (slug: string) =>
    get<CompanionSandbox>(`/sandboxes/${encodeURIComponent(slug)}`),
  createSandbox: (name: string, opts?: { initScript?: string }) =>
    post<CompanionSandbox>("/sandboxes", { name, ...opts }),
  updateSandbox: (
    slug: string,
    data: {
      name?: string;
      initScript?: string;
    },
  ) => put<CompanionSandbox>(`/sandboxes/${encodeURIComponent(slug)}`, data),
  deleteSandbox: (slug: string) => del(`/sandboxes/${encodeURIComponent(slug)}`),
  testInitScript: (slug: string, cwd: string, initScript?: string) =>
    post<{ success: boolean; exitCode: number; output: string }>(
      `/sandboxes/${encodeURIComponent(slug)}/test-init`,
      { cwd, initScript },
    ),

  buildBaseImage: () =>
    post<{ ok: boolean; tag: string }>("/docker/build-base"),
  getBaseImageStatus: () =>
    get<{ exists: boolean; tag: string }>("/docker/base-image"),

  // Settings
  getSettings: () => get<AppSettings>("/settings"),
  updateSettings: (data: {
    anthropicApiKey?: string;
    anthropicModel?: string;
    claudeCodeOAuthToken?: string;
    openaiApiKey?: string;
    onboardingCompleted?: boolean;
    linearApiKey?: string;
    linearAutoTransition?: boolean;
    linearAutoTransitionStateId?: string;
    linearAutoTransitionStateName?: string;
    linearArchiveTransition?: boolean;
    linearArchiveTransitionStateId?: string;
    linearArchiveTransitionStateName?: string;
    linearOAuthClientId?: string;
    linearOAuthClientSecret?: string;
    linearOAuthWebhookSecret?: string;
    publicUrl?: string;
    updateChannel?: "stable" | "prerelease";
    dockerAutoUpdate?: boolean;
  }) => put<AppSettings>("/settings", data),
  verifyAnthropicKey: (apiKey: string) =>
    post<{ valid: boolean; error?: string }>("/settings/anthropic/verify", { apiKey }),

  // Tailscale
  getTailscaleStatus: () => get<TailscaleStatus>("/tailscale/status"),
  startTailscaleFunnel: () => post<TailscaleStatus>("/tailscale/funnel/start"),
  stopTailscaleFunnel: () => post<TailscaleStatus>("/tailscale/funnel/stop"),

  // Linear connections CRUD
  listLinearConnections: () =>
    get<{ connections: LinearConnectionSummary[] }>("/linear/connections"),
  createLinearConnection: (data: { name: string; apiKey: string }) =>
    post<{ connection: LinearConnectionSummary; verified: boolean; error?: string }>(
      "/linear/connections",
      data,
    ),
  updateLinearConnection: (id: string, data: Record<string, unknown>) =>
    put<{ connection: LinearConnectionSummary }>(`/linear/connections/${encodeURIComponent(id)}`, data),
  deleteLinearConnection: (id: string) =>
    del<{ ok: boolean }>(`/linear/connections/${encodeURIComponent(id)}`),
  verifyLinearConnection: (id: string) =>
    post<{ connection: LinearConnectionSummary; verified: boolean; error?: string }>(
      `/linear/connections/${encodeURIComponent(id)}/verify`,
      {},
    ),

  searchLinearIssues: (query: string, limit = 8, connectionId?: string) =>
    get<{ issues: LinearIssue[] }>(
      `/linear/issues?query=${encodeURIComponent(query)}&limit=${encodeURIComponent(String(limit))}${connectionId ? `&connectionId=${encodeURIComponent(connectionId)}` : ""}`,
    ),
  getLinearConnection: (connectionId?: string) =>
    get<LinearConnectionInfo>(`/linear/connection${connectionId ? `?connectionId=${encodeURIComponent(connectionId)}` : ""}`),
  getLinearStates: (connectionId?: string) =>
    get<{ teams: LinearTeamStates[] }>(`/linear/states${connectionId ? `?connectionId=${encodeURIComponent(connectionId)}` : ""}`),
  transitionLinearIssue: (issueId: string, connectionId?: string) =>
    post<{ ok: boolean; skipped: boolean }>(
      `/linear/issues/${encodeURIComponent(issueId)}/transition${connectionId ? `?connectionId=${encodeURIComponent(connectionId)}` : ""}`,
      {},
    ),
  listLinearProjects: (connectionId?: string) =>
    get<{ projects: LinearProject[] }>(`/linear/projects${connectionId ? `?connectionId=${encodeURIComponent(connectionId)}` : ""}`),
  getLinearProjectIssues: (projectId: string, limit = 15, connectionId?: string) =>
    get<{ issues: LinearIssue[] }>(
      `/linear/project-issues?projectId=${encodeURIComponent(projectId)}&limit=${encodeURIComponent(String(limit))}${connectionId ? `&connectionId=${encodeURIComponent(connectionId)}` : ""}`,
    ),
  getLinearProjectMapping: (repoRoot: string) =>
    get<{ mapping: LinearProjectMapping | null }>(
      `/linear/project-mappings?repoRoot=${encodeURIComponent(repoRoot)}`,
    ),
  upsertLinearProjectMapping: (data: {
    repoRoot: string;
    projectId: string;
    projectName: string;
  }) => put<{ mapping: LinearProjectMapping }>("/linear/project-mappings", data),
  removeLinearProjectMapping: (repoRoot: string) =>
    del<{ ok: boolean }>("/linear/project-mappings", { repoRoot }),

  // Linear issue <-> session association
  linkLinearIssue: (sessionId: string, issue: LinearIssue, connectionId?: string) =>
    put<{ ok: boolean }>(`/sessions/${encodeURIComponent(sessionId)}/linear-issue`, {
      ...issue,
      ...(connectionId !== undefined ? { connectionId } : {}),
    }),
  unlinkLinearIssue: (sessionId: string) =>
    del<{ ok: boolean }>(`/sessions/${encodeURIComponent(sessionId)}/linear-issue`),
  getLinkedLinearIssue: (sessionId: string, refresh = false) =>
    get<LinearIssueDetail>(
      `/sessions/${encodeURIComponent(sessionId)}/linear-issue${refresh ? "?refresh=true" : ""}`,
    ),
  createLinearIssue: (input: CreateLinearIssueInput) =>
    post<{ ok: boolean; issue: LinearIssue }>("/linear/issues", input),
  addLinearComment: (issueId: string, body: string, connectionId?: string) =>
    post<{ ok: boolean; comment: LinearComment }>(
      `/linear/issues/${encodeURIComponent(issueId)}/comments`,
      { body, connectionId },
    ),

  // Git operations
  getRepoInfo: (path: string) =>
    get<GitRepoInfo>(`/git/repo-info?path=${encodeURIComponent(path)}`),
  listBranches: (repoRoot: string) =>
    get<GitBranchInfo[]>(
      `/git/branches?repoRoot=${encodeURIComponent(repoRoot)}`,
    ),
  gitFetch: (repoRoot: string) =>
    post<{ success: boolean; output: string }>("/git/fetch", { repoRoot }),
  gitPull: (cwd: string) =>
    post<{
      success: boolean;
      output: string;
      git_ahead: number;
      git_behind: number;
    }>("/git/pull", { cwd }),

  // Git worktrees
  listWorktrees: (repoRoot: string) =>
    get<GitWorktreeInfo[]>(
      `/git/worktrees?repoRoot=${encodeURIComponent(repoRoot)}`,
    ),
  createWorktree: (
    repoRoot: string,
    branch: string,
    opts?: { baseBranch?: string; createBranch?: boolean },
  ) =>
    post<WorktreeCreateResult>("/git/worktree", {
      repoRoot,
      branch,
      ...opts,
    }),
  removeWorktree: (repoRoot: string, worktreePath: string, force?: boolean) =>
    del("/git/worktree", { repoRoot, worktreePath, force }),

  // GitHub PR status
  getPRStatus: (cwd: string, branch: string) =>
    get<PRStatusResponse>(
      `/git/pr-status?cwd=${encodeURIComponent(cwd)}&branch=${encodeURIComponent(branch)}`,
    ),

  // Backends
  getBackends: () => get<BackendInfo[]>("/backends"),
  getBackendModels: (backendId: string) =>
    get<BackendModelInfo[]>(`/backends/${encodeURIComponent(backendId)}/models`),

  // Containers
  getContainerStatus: () => get<ContainerStatus>("/containers/status"),
  getContainerImages: () => get<string[]>("/containers/images"),

  // Image pull manager
  getImageStatus: (tag: string) =>
    get<ImagePullState>(`/images/${encodeURIComponent(tag)}/status`),
  pullImage: (tag: string) =>
    post<{ ok: boolean; state: ImagePullState }>(`/images/${encodeURIComponent(tag)}/pull`),
  getCloudProviderPlan: (provider: "modal", cwd: string, sessionId: string) =>
    get<CloudProviderPlan>(
      `/cloud/providers/${encodeURIComponent(provider)}/plan?cwd=${encodeURIComponent(cwd)}&sessionId=${encodeURIComponent(sessionId)}`,
    ),

  // Editor
  startEditor: (sessionId: string) =>
    post<EditorStartResult>(
      `/sessions/${encodeURIComponent(sessionId)}/editor/start`,
    ),

  // Browser preview
  startBrowser: (sessionId: string, url?: string) =>
    post<BrowserStartResult>(
      `/sessions/${encodeURIComponent(sessionId)}/browser/start`,
      url ? { url } : undefined,
    ),
  navigateBrowser: (sessionId: string, url: string) =>
    post<{ ok?: boolean; error?: string }>(
      `/sessions/${encodeURIComponent(sessionId)}/browser/navigate`,
      { url },
    ),

  // Editor filesystem
  getFileTree: (path: string) =>
    get<{ path: string; tree: TreeNode[] }>(
      `/fs/tree?path=${encodeURIComponent(path)}`,
    ),
  readFile: (path: string) =>
    get<{ path: string; content: string }>(
      `/fs/read?path=${encodeURIComponent(path)}`,
    ),
  getFileBlob: async (path: string): Promise<string> => {
    const res = await fetch(`${BASE}/fs/raw?path=${encodeURIComponent(path)}`, {
      headers: { ...getAuthHeaders() },
    });
    if (!res.ok) {
      handle401(res.status);
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error((err as { error?: string }).error || res.statusText);
    }
    const blob = await res.blob();
    return URL.createObjectURL(blob);
  },
  writeFile: (path: string, content: string) =>
    put<{ ok: boolean; path: string }>("/fs/write", { path, content }),
  getFileDiff: (path: string, base?: "last-commit" | "default-branch") =>
    get<{ path: string; diff: string }>(
      `/fs/diff?path=${encodeURIComponent(path)}${base ? `&base=${encodeURIComponent(base)}` : ""}`,
    ),
  getChangedFiles: (cwd: string, base?: "last-commit" | "default-branch") =>
    get<{ files: Array<{ path: string; status: string }> }>(
      `/fs/changed-files?cwd=${encodeURIComponent(cwd)}${base ? `&base=${encodeURIComponent(base)}` : ""}`,
    ),
  getClaudeMdFiles: (cwd: string) =>
    get<{ cwd: string; files: { path: string; content: string }[] }>(
      `/fs/claude-md?cwd=${encodeURIComponent(cwd)}`,
    ),
  saveClaudeMd: (path: string, content: string) =>
    put<{ ok: boolean; path: string }>("/fs/claude-md", { path, content }),
  getClaudeConfig: (cwd: string) =>
    get<ClaudeConfigResponse>(`/fs/claude-config?cwd=${encodeURIComponent(cwd)}`),

  // Usage limits
  getUsageLimits: () => get<UsageLimits>("/usage-limits"),
  getSessionUsageLimits: (sessionId: string) =>
    get<UsageLimits>(`/sessions/${encodeURIComponent(sessionId)}/usage-limits`),

  // Terminal
  spawnTerminal: (cwd: string, cols?: number, rows?: number, opts?: { containerId?: string }) =>
    post<{ terminalId: string }>("/terminal/spawn", { cwd, cols, rows, containerId: opts?.containerId }),
  killTerminal: (terminalId: string) =>
    post<{ ok: boolean }>("/terminal/kill", { terminalId }),
  getTerminal: (terminalId?: string) =>
    get<{ active: boolean; terminalId?: string; cwd?: string }>(
      terminalId
        ? `/terminal?terminalId=${encodeURIComponent(terminalId)}`
        : "/terminal",
    ),

  // Update checking
  checkForUpdate: () => get<UpdateInfo>("/update-check"),
  forceCheckForUpdate: () => post<UpdateInfo>("/update-check"),
  triggerUpdate: () =>
    post<{ ok: boolean; message: string }>("/update"),

  // Cron jobs
  listCronJobs: () => get<CronJobInfo[]>("/cron/jobs"),
  getCronJob: (id: string) => get<CronJobInfo>(`/cron/jobs/${encodeURIComponent(id)}`),
  createCronJob: (data: Partial<CronJobInfo>) => post<CronJobInfo>("/cron/jobs", data),
  updateCronJob: (id: string, data: Partial<CronJobInfo>) =>
    put<CronJobInfo>(`/cron/jobs/${encodeURIComponent(id)}`, data),
  deleteCronJob: (id: string) => del(`/cron/jobs/${encodeURIComponent(id)}`),
  toggleCronJob: (id: string) => post<CronJobInfo>(`/cron/jobs/${encodeURIComponent(id)}/toggle`),
  runCronJob: (id: string) => post(`/cron/jobs/${encodeURIComponent(id)}/run`),
  getCronJobExecutions: (id: string) =>
    get<CronJobExecution[]>(`/cron/jobs/${encodeURIComponent(id)}/executions`),

  // Background process management
  killProcess: (sessionId: string, taskId: string) =>
    post<{ ok: boolean; taskId: string }>(
      `/sessions/${encodeURIComponent(sessionId)}/processes/${encodeURIComponent(taskId)}/kill`,
    ),
  killAllProcesses: (sessionId: string, taskIds: string[]) =>
    post<{ ok: boolean; results: { taskId: string; ok: boolean; error?: string }[] }>(
      `/sessions/${encodeURIComponent(sessionId)}/processes/kill-all`,
      { taskIds },
    ),

  // System dev process scanning
  getSystemProcesses: (sessionId: string) =>
    get<{ ok: boolean; processes: { pid: number; command: string; fullCommand: string; ports: number[]; cwd?: string; startedAt?: number }[] }>(
      `/sessions/${encodeURIComponent(sessionId)}/processes/system`,
    ),
  killSystemProcess: (sessionId: string, pid: number) =>
    post<{ ok: boolean; pid: number }>(
      `/sessions/${encodeURIComponent(sessionId)}/processes/system/${pid}/kill`,
    ),

  // Agents
  listAgents: () => get<AgentInfo[]>("/agents"),
  getAgent: (id: string) => get<AgentInfo>(`/agents/${encodeURIComponent(id)}`),
  createAgent: (data: Partial<AgentInfo> & { stagingId?: string; cloneFromAgentId?: string }) =>
    post<AgentInfo>("/agents", data),
  updateAgent: (id: string, data: Partial<AgentInfo>) =>
    put<AgentInfo>(`/agents/${encodeURIComponent(id)}`, data),
  deleteAgent: (id: string) => del(`/agents/${encodeURIComponent(id)}`),
  toggleAgent: (id: string) => post<AgentInfo>(`/agents/${encodeURIComponent(id)}/toggle`),
  runAgent: (id: string, input?: string) =>
    post<{ ok: boolean; message: string }>(`/agents/${encodeURIComponent(id)}/run`, { input }),
  getAgentExecutions: (id: string) =>
    get<AgentExecution[]>(`/agents/${encodeURIComponent(id)}/executions`),
  importAgent: (data: AgentExport) => post<AgentInfo>("/agents/import", data),
  exportAgent: (id: string) => get<AgentExport>(`/agents/${encodeURIComponent(id)}/export`),
  regenerateAgentWebhookSecret: (id: string) =>
    post<AgentInfo>(`/agents/${encodeURIComponent(id)}/regenerate-secret`),

  // Executions (cross-agent, for Runs view)
  listExecutions: (opts?: { agentId?: string; triggerType?: string; status?: string; limit?: number; offset?: number }) => {
    const params = new URLSearchParams();
    if (opts?.agentId) params.set("agentId", opts.agentId);
    if (opts?.triggerType) params.set("triggerType", opts.triggerType);
    if (opts?.status) params.set("status", opts.status);
    if (opts?.limit) params.set("limit", String(opts.limit));
    if (opts?.offset) params.set("offset", String(opts.offset));
    const qs = params.toString();
    return get<ExecutionListResult>(`/executions${qs ? `?${qs}` : ""}`);
  },

  // Linear OAuth (Agent Interaction SDK)
  getLinearOAuthStatus: (stagingId?: string) => {
    const params = new URLSearchParams();
    if (stagingId) params.set("stagingId", stagingId);
    const qs = params.toString();
    return get<{ configured: boolean; hasClientId: boolean; hasClientSecret: boolean; hasWebhookSecret: boolean; hasAccessToken: boolean }>(
      `/linear/oauth/status${qs ? `?${qs}` : ""}`,
    );
  },
  getLinearOAuthAuthorizeUrl: (returnTo?: string, stagingId?: string) => {
    const params = new URLSearchParams();
    if (returnTo) params.set("returnTo", returnTo);
    if (stagingId) params.set("stagingId", stagingId);
    const qs = params.toString();
    return get<{ url: string }>(`/linear/oauth/authorize-url${qs ? `?${qs}` : ""}`);
  },
  disconnectLinearOAuth: () =>
    post<{ ok: boolean }>("/linear/oauth/disconnect"),

  // Linear OAuth staging slots (per-wizard credential storage)
  createLinearStaging: (creds: { clientId: string; clientSecret: string; webhookSecret: string }) =>
    post<{ stagingId: string }>("/linear/oauth/staging", creds),
  getLinearStagingStatus: (id: string) =>
    get<{ exists: boolean; hasAccessToken: boolean; hasClientId: boolean; hasClientSecret: boolean }>(`/linear/oauth/staging/${encodeURIComponent(id)}/status`),
  deleteLinearStaging: (id: string) =>
    del(`/linear/oauth/staging/${encodeURIComponent(id)}`),

  // Linear OAuth connections (standalone OAuth app management)
  listLinearOAuthConnections: () =>
    get<{ connections: LinearOAuthConnectionSummary[] }>("/linear/oauth-connections"),
  createLinearOAuthConnection: (data: { name: string; oauthClientId: string; oauthClientSecret: string; webhookSecret: string }) =>
    post<{ connection: LinearOAuthConnectionSummary }>("/linear/oauth-connections", data),
  updateLinearOAuthConnection: (id: string, data: Record<string, unknown>) =>
    put<{ connection: LinearOAuthConnectionSummary }>(`/linear/oauth-connections/${encodeURIComponent(id)}`, data),
  deleteLinearOAuthConnection: (id: string) =>
    del<{ ok: boolean }>(`/linear/oauth-connections/${encodeURIComponent(id)}`),
  getLinearOAuthConnectionAuthorizeUrl: (id: string, returnTo?: string) =>
    get<{ url: string }>(`/linear/oauth-connections/${encodeURIComponent(id)}/authorize-url${returnTo ? `?returnTo=${encodeURIComponent(returnTo)}` : ""}`),

  // Skills
  listSkills: () =>
    get<{ slug: string; name: string; description: string; path: string }[]>("/skills"),

  // Cross-session messaging
  sendSessionMessage: (sessionId: string, content: string) =>
    post<{ ok: boolean }>(`/sessions/${encodeURIComponent(sessionId)}/message`, { content }),

  // Saved prompts
  listPrompts: (cwd?: string, scope?: "global" | "project" | "all") => {
    const params = new URLSearchParams();
    if (cwd) params.set("cwd", cwd);
    if (scope) params.set("scope", scope);
    const query = params.toString();
    return get<SavedPrompt[]>(`/prompts${query ? `?${query}` : ""}`);
  },
  createPrompt: (data: { name: string; content: string; scope: "global" | "project"; cwd?: string; projectPaths?: string[] }) =>
    post<SavedPrompt>("/prompts", data),
  updatePrompt: (id: string, data: { name?: string; content?: string; scope?: "global" | "project"; projectPaths?: string[] }) =>
    put<SavedPrompt>(`/prompts/${encodeURIComponent(id)}`, data),
  deletePrompt: (id: string) =>
    del<{ ok: boolean }>(`/prompts/${encodeURIComponent(id)}`),
};
