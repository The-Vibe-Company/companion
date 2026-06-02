// ─── Linear Agent Interaction SDK Client ──────────────────────────────────────
// Handles OAuth token management, webhook signature verification, and GraphQL
// mutations for the Linear Agent Interaction SDK (agent sessions, activities).
//
// This module is parameterized — all functions accept credentials as arguments
// rather than reading from global settings. Callers are responsible for
// providing the correct LinearOAuthCredentials for the agent being operated on.
// Token refresh is handled transparently on 401.

import { createHmac, timingSafeEqual, randomBytes } from "node:crypto";

/** OAuth credentials for a specific Linear agent. */
export interface LinearOAuthCredentials {
  clientId: string;
  clientSecret: string;
  webhookSecret: string;
  accessToken: string;
  refreshToken: string;
}

// ─── OAuth state management (CSRF protection) ───────────────────────────────
// Short-lived nonces for the OAuth authorization flow. Each nonce expires after 10 minutes.
const oauthStateNonces = new Map<string, number>();
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes

/** Generate a random state nonce for OAuth CSRF protection.
 *  Optionally encodes a `stagingId` (for per-wizard staging slots), a
 *  `connectionId` (for OAuth connection management), and a `returnTo` path
 *  so the OAuth callback can redirect back to the originating page.
 *
 *  State format: `{nonce}` or `{nonce}:{segments}` where segments are
 *  colon-separated. A segment starting with `sid=` is the staging ID;
 *  `cid=` is the connection ID; anything else is a returnTo path. */
export function generateOAuthState(options?: { stagingId?: string; connectionId?: string; returnTo?: string }): string {
  // Prune expired nonces
  const now = Date.now();
  for (const [nonce, expiresAt] of oauthStateNonces) {
    if (expiresAt < now) oauthStateNonces.delete(nonce);
  }
  const nonce = randomBytes(24).toString("hex");
  oauthStateNonces.set(nonce, now + OAUTH_STATE_TTL_MS);

  const parts = [nonce];
  if (options?.stagingId) parts.push(`sid=${options.stagingId}`);
  if (options?.connectionId) parts.push(`cid=${options.connectionId}`);
  if (options?.returnTo) parts.push(encodeURIComponent(options.returnTo));
  return parts.join(":");
}

/** Validate and consume an OAuth state nonce.
 *  Returns validity, an optional `stagingId`, `connectionId`, and `returnTo` path. */
export function validateOAuthState(state: string | null | undefined): { valid: boolean; stagingId?: string; connectionId?: string; returnTo?: string } {
  if (!state) return { valid: false };

  const parts = state.split(":");
  const nonce = parts[0];

  let stagingId: string | undefined;
  let connectionId: string | undefined;
  let returnTo: string | undefined;

  // Parse remaining segments after the nonce
  for (let i = 1; i < parts.length; i++) {
    const segment = parts[i];
    if (segment.startsWith("sid=")) {
      stagingId = segment.slice(4);
    } else if (segment.startsWith("cid=")) {
      connectionId = segment.slice(4);
    } else if (!returnTo) {
      // First non-sid/cid segment is returnTo (may need reassembly if returnTo itself contained encoded colons)
      returnTo = decodeURIComponent(parts.slice(i).filter(s => !s.startsWith("sid=") && !s.startsWith("cid=")).join(":"));
      break;
    }
  }

  const expiresAt = oauthStateNonces.get(nonce);
  if (!expiresAt) return { valid: false };
  oauthStateNonces.delete(nonce); // consume — single use
  return Date.now() < expiresAt ? { valid: true, stagingId, connectionId, returnTo } : { valid: false };
}

// ─── Types ──────────────────────────────────────────────────────────────────

export type AgentActivityType = "thought" | "action" | "elicitation" | "response" | "error";

export interface ThoughtContent {
  type: "thought";
  body: string;
  ephemeral?: boolean;
}

export interface ActionContent {
  type: "action";
  action: string;
  parameter?: string;
  result?: string;
  ephemeral?: boolean;
}

export interface ElicitationContent {
  type: "elicitation";
  body: string;
}

export interface ResponseContent {
  type: "response";
  body: string;
}

export interface ErrorContent {
  type: "error";
  body: string;
}

export type AgentActivityContent =
  | ThoughtContent
  | ActionContent
  | ElicitationContent
  | ResponseContent
  | ErrorContent;

export interface AgentPlanItem {
  content: string;
  status: "pending" | "inProgress" | "completed" | "canceled";
}

/** The agent session object nested inside the webhook payload. */
export interface AgentSessionData {
  id: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  creatorId?: string;
  issueId?: string;
  commentId?: string;
  url?: string;
  externalUrls?: Array<{ label: string; url: string }>;
  summary?: string | null;
  plan?: unknown;
  context?: unknown[];
  creator?: {
    id: string;
    name: string;
    email?: string;
    url?: string;
  };
  comment?: {
    id: string;
    body: string;
    userId: string;
    issueId: string;
  };
  issue?: {
    id: string;
    title: string;
    identifier: string;
    url: string;
    description?: string;
    teamId?: string;
    team?: {
      id: string;
      key: string;
      name: string;
    };
  };
}

export interface AgentSessionEventPayload {
  action: "created" | "prompted";
  type: "AgentSessionEvent";
  createdAt?: string;
  organizationId?: string;
  oauthClientId?: string;
  appUserId?: string;
  /** The agent session — contains id, issue, comment, creator, etc. */
  agentSession?: AgentSessionData;
  /** Rich XML prompt context provided by Linear */
  promptContext?: string;
  /** Previous comments in the thread */
  previousComments?: Array<{
    id: string;
    body: string;
    userId: string;
    issueId: string;
  }>;
  /** Agent guidance configured in Linear */
  guidance?: string | null;
  /** Present on "prompted" events — the user's follow-up activity */
  agentActivity?: {
    id?: string;
    /** Nested content with type and body */
    content?: {
      type?: string;
      body?: string;
    };
    /** Direct body (legacy/alternative format) */
    body?: string;
    sourceCommentId?: string;
    userId?: string;
    user?: {
      id: string;
      name: string;
      email?: string;
    };
  };
  webhookTimestamp?: number;
  webhookId?: string;
}

// ─── GraphQL helper ───────────────────────────────────────────────────────────

/** Guard against concurrent 401s triggering multiple simultaneous refresh requests.
 *  Keyed by clientId so each agent's refresh is coalesced independently. */
const refreshPromises = new Map<string, Promise<string | null>>();

/** Get a refreshed token, coalescing concurrent refresh requests into a single call per agent. */
async function getRefreshedToken(
  creds: LinearOAuthCredentials,
  onTokensRefreshed?: (tokens: { accessToken: string; refreshToken: string }) => void,
): Promise<string | null> {
  const key = creds.clientId;
  if (!refreshPromises.has(key)) {
    const promise = refreshAccessToken(creds, onTokensRefreshed).finally(() => {
      refreshPromises.delete(key);
    });
    refreshPromises.set(key, promise);
  }
  return refreshPromises.get(key)!;
}

/** Execute a GraphQL query against the Linear API with automatic token refresh. */
export async function linearGraphQL<T = unknown>(
  creds: LinearOAuthCredentials,
  query: string,
  variables?: Record<string, unknown>,
  onTokensRefreshed?: (tokens: { accessToken: string; refreshToken: string }) => void,
): Promise<{ data?: T; errors?: Array<{ message: string }> }> {
  let token = creds.accessToken;

  if (!token) {
    throw new Error("Linear OAuth not configured — no access token");
  }

  let response = await fetchGraphQL(token, query, variables);

  // Auto-refresh on 401 — coalesced to prevent concurrent refresh races
  if (response.status === 401 && creds.refreshToken) {
    const refreshed = await getRefreshedToken(creds, onTokensRefreshed);
    if (refreshed) {
      token = refreshed;
      response = await fetchGraphQL(token, query, variables);
    }
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Linear API error ${response.status}: ${text.slice(0, 200)}`);
  }

  return response.json() as Promise<{ data?: T; errors?: Array<{ message: string }> }>;
}

async function fetchGraphQL(
  token: string,
  query: string,
  variables?: Record<string, unknown>,
): Promise<Response> {
  return fetch("https://api.linear.app/graphql", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ query, variables }),
  });
}

// ─── Token management ─────────────────────────────────────────────────────────

/** Refresh the OAuth access token using the refresh token. Returns the new token or null. */
export async function refreshAccessToken(
  creds: LinearOAuthCredentials,
  onTokensRefreshed?: (tokens: { accessToken: string; refreshToken: string }) => void,
): Promise<string | null> {
  const { clientId, clientSecret, refreshToken } = creds;

  if (!clientId || !clientSecret || !refreshToken) {
    return null;
  }

  try {
    const response = await fetch("https://api.linear.app/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: clientId,
        client_secret: clientSecret,
      }),
    });

    if (!response.ok) {
      console.error("[linear-agent] Token refresh failed:", response.status);
      return null;
    }

    const data = await response.json() as {
      access_token: string;
      refresh_token?: string;
      expires_in: number;
    };

    // Notify caller of refreshed tokens so they can persist them
    onTokensRefreshed?.({
      accessToken: data.access_token,
      refreshToken: data.refresh_token || refreshToken,
    });

    console.log("[linear-agent] OAuth token refreshed successfully");
    return data.access_token;
  } catch (err) {
    console.error("[linear-agent] Token refresh error:", err);
    return null;
  }
}

/** Exchange an authorization code for tokens (used during OAuth callback). */
export async function exchangeCodeForTokens(
  creds: Pick<LinearOAuthCredentials, "clientId" | "clientSecret">,
  code: string,
  redirectUri: string,
): Promise<{ accessToken: string; refreshToken: string } | null> {
  const { clientId: linearOAuthClientId, clientSecret: linearOAuthClientSecret } = creds;

  if (!linearOAuthClientId || !linearOAuthClientSecret) {
    return null;
  }

  try {
    const response = await fetch("https://api.linear.app/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        client_id: linearOAuthClientId,
        client_secret: linearOAuthClientSecret,
      }),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      console.error("[linear-agent] Token exchange failed:", response.status, text);
      return null;
    }

    const data = await response.json() as {
      access_token: string;
      refresh_token: string;
      expires_in: number;
      scope: string;
    };

    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
    };
  } catch (err) {
    console.error("[linear-agent] Token exchange error:", err);
    return null;
  }
}

// ─── Webhook verification ─────────────────────────────────────────────────────

/** Verify a Linear webhook signature using HMAC-SHA256. */
export function verifyWebhookSignature(webhookSecret: string, body: string, signature: string | null): boolean {
  const secret = webhookSecret;

  if (!secret || !signature) return false;

  // Validate signature is a valid 64-char hex string (SHA-256 output)
  if (!/^[0-9a-f]{64}$/i.test(signature)) return false;

  const computed = createHmac("sha256", secret).update(body).digest("hex");
  return timingSafeEqual(Buffer.from(computed, "hex"), Buffer.from(signature, "hex"));
}

// ─── Agent Activities ─────────────────────────────────────────────────────────

/** Post an agent activity to a Linear agent session. */
export async function postActivity(
  creds: LinearOAuthCredentials,
  agentSessionId: string,
  content: AgentActivityContent,
  onTokensRefreshed?: (tokens: { accessToken: string; refreshToken: string }) => void,
): Promise<void> {
  const result = await linearGraphQL<{ agentActivityCreate?: { success: boolean } }>(
    creds,
    `mutation CompanionAgentActivity($input: AgentActivityCreateInput!) {
      agentActivityCreate(input: $input) { success }
    }`,
    { input: { agentSessionId, content } },
    onTokensRefreshed,
  );

  if (result.errors?.length) {
    console.error("[linear-agent] Activity creation failed:", result.errors[0].message);
  }
}

/** Update the external URLs on an agent session (links back to Companion). */
export async function updateSessionUrls(
  creds: LinearOAuthCredentials,
  agentSessionId: string,
  urls: Array<{ label: string; url: string }>,
  onTokensRefreshed?: (tokens: { accessToken: string; refreshToken: string }) => void,
): Promise<void> {
  const result = await linearGraphQL<{ agentSessionUpdate?: { success: boolean } }>(
    creds,
    `mutation CompanionAgentSessionUpdate($id: String!, $input: AgentSessionUpdateInput!) {
      agentSessionUpdate(id: $id, input: $input) { success }
    }`,
    { id: agentSessionId, input: { externalUrls: urls } },
    onTokensRefreshed,
  );

  if (result.errors?.length) {
    console.error("[linear-agent] Session URL update failed:", result.errors[0].message);
  }
}

/** Update the plan (checklist) on an agent session. */
export async function updateSessionPlan(
  creds: LinearOAuthCredentials,
  agentSessionId: string,
  plan: AgentPlanItem[],
  onTokensRefreshed?: (tokens: { accessToken: string; refreshToken: string }) => void,
): Promise<void> {
  const result = await linearGraphQL<{ agentSessionUpdate?: { success: boolean } }>(
    creds,
    `mutation CompanionAgentPlanUpdate($id: String!, $input: AgentSessionUpdateInput!) {
      agentSessionUpdate(id: $id, input: $input) { success }
    }`,
    { id: agentSessionId, input: { plan } },
    onTokensRefreshed,
  );

  if (result.errors?.length) {
    console.error("[linear-agent] Session plan update failed:", result.errors[0].message);
  }
}

/** Check if Linear OAuth is fully configured (has client credentials + access token). */
export function isLinearOAuthConfigured(creds: Partial<LinearOAuthCredentials>): boolean {
  return !!((creds.clientId || "").trim() && (creds.clientSecret || "").trim() && (creds.accessToken || "").trim());
}

/** Get the OAuth authorization URL for installing the app with actor=app.
 *  Pass `returnTo` to redirect back to a specific page after the OAuth callback.
 *  Pass `stagingId` to associate the OAuth flow with a specific staging slot.
 *  Pass `connectionId` to store tokens directly in an OAuth connection. */
export function getOAuthAuthorizeUrl(clientId: string, redirectUri: string, options?: { returnTo?: string; stagingId?: string; connectionId?: string }): { url: string; state: string } | null {
  if (!clientId) return null;

  const state = generateOAuthState({ stagingId: options?.stagingId, connectionId: options?.connectionId, returnTo: options?.returnTo });
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "read,write,issues:create,comments:create,app:mentionable",
    actor: "app",
    state,
  });

  return { url: `https://linear.app/oauth/authorize?${params.toString()}`, state };
}
