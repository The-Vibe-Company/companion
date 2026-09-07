/* oxlint-disable anti-slop/no-conditional-empty-object-spread, anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/require-safety-comment-for-type-assertion -- Hosted Companion removal preserves the existing Skills Hub implementation; these patterns predate this change. */
import { getCookie } from "hono/cookie";
import type { Context } from "hono";
import { companionCapabilityAllows, type TokenScope } from "@companion/contracts";
import { auth, authenticateAgentRequest, type AgentCapabilityName } from "@companion/auth";
import {
  ensureUserBootstrap,
  listOrgs,
  resolveApiToken,
  type ActorContext,
} from "@companion/core/services";
import {
  EntitlementDeniedError,
} from "@companion/core";
import { captureServerError } from "./sentry";

export interface ApiVariables {
  user: typeof auth.$Infer.Session.user | null;
  session: typeof auth.$Infer.Session.session | null;
  /** Set when the request authenticated with a `cmp_pat_…` bearer token instead of a cookie session. */
  tokenActor: ActorContext | null;
  tokenOrgId: string | null;
  tokenScopes: TokenScope[] | null;
  tokenSourceType: string | null;
  programmaticAuthKind: "pat" | "agent" | null;
  agentId: string | null;
  agentCapability: AgentCapabilityName | null;
  agentSession: Awaited<ReturnType<typeof authenticateAgentRequest>> extends infer Result
    ? NonNullable<Result> extends { session: infer Session } ? Session | null : null
    : null;
}

function responseSetCookies(headers: Headers | undefined): string[] {
  if (!headers) return [];
  const cookieHeaders = headers as Headers & { getSetCookie?: () => string[] };
  const cookies = cookieHeaders.getSetCookie?.();
  if (cookies?.length) return cookies;
  const cookie = headers.get("set-cookie");
  return cookie ? [cookie] : [];
}

/** Extract a bearer credential from an `Authorization` header, if present. */
export function bearerFromHeader(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1]!.trim() : null;
}

export async function attachSession(c: Context<{ Variables: ApiVariables }>, next: () => Promise<void>) {
  // Better Auth can refresh a rolling session while reading it. Request the response headers as well
  // as the session and append every Set-Cookie to the public API response; otherwise only the database
  // expiry moves and the browser keeps the original cookie deadline.
  const sessionResult = (await auth.api.getSession({
    headers: c.req.raw.headers,
    query: {
      // Server Components cannot attach an upstream Set-Cookie to their rendered response. They
      // mark their internal API calls so only a same-origin browser request consumes the daily
      // rolling refresh and receives the renewed cookie.
      disableRefresh: c.req.header("x-companion-disable-session-refresh") === "1",
    },
    returnHeaders: true,
  })) as unknown;
  // Keep compatibility with lightweight test doubles that return the session value directly.
  const returned =
    sessionResult && typeof sessionResult === "object" && "response" in sessionResult
      ? (sessionResult as { response: typeof auth.$Infer.Session | null; headers?: Headers })
      : { response: sessionResult as typeof auth.$Infer.Session | null, headers: undefined };
  const session = returned.response;
  c.set("user", session?.user ?? null);
  c.set("session", session?.session ?? null);
  c.set("tokenActor", null);
  c.set("tokenOrgId", null);
  c.set("tokenScopes", null);
  c.set("tokenSourceType", null);
  c.set("programmaticAuthKind", null);
  c.set("agentId", null);
  c.set("agentCapability", null);
  c.set("agentSession", null);
  if (session?.user) {
    await ensureUserBootstrap({
      id: session.user.id,
      email: session.user.email,
      name: session.user.name || session.user.email,
    });
  } else {
    // No cookie session — try a personal access token (programmatic publish/install).
    const bearer = bearerFromHeader(c.req.header("authorization"));
    if (bearer) {
      const resolved = await resolveApiToken(
        bearer,
        undefined,
        c.req.header("x-companion-delegation-target")?.trim() || null,
      );
      if (resolved) {
        c.set("tokenActor", resolved.actor);
        c.set("tokenOrgId", resolved.orgId);
        c.set("tokenScopes", resolved.scopes);
        c.set("tokenSourceType", resolved.sourceType);
        c.set("programmaticAuthKind", "pat");
      } else {
        const workspaceId =
          c.req.header("x-companion-workspace-id") ?? c.req.header("x-companion-org") ?? null;
        const agent = await authenticateAgentRequest({
          headers: c.req.raw.headers,
          method: c.req.method,
          pathname: c.req.path,
          workspaceId,
        });
        if (agent) {
          c.set("tokenActor", agent.actor);
          c.set("tokenOrgId", agent.workspaceId);
          c.set("tokenScopes", [agent.capability]);
          c.set("programmaticAuthKind", "agent");
          c.set("agentId", agent.session.agentId);
          c.set("agentCapability", agent.capability);
          c.set("agentSession", agent.session);
        }
      }
    }
  }
  const sessionCookies = responseSetCookies(returned.headers);
  await next();
  if (sessionCookies.length) {
    // A downstream auth handler can deliberately replace the same cookie (for example, signing in
    // with a stale token). Rebuild the response so read-time refresh/cleanup cookies come first and
    // route mutation cookies remain last; prepared Hono headers set before `next()` are overwritten
    // when a handler returns its own Response.
    const routeCookies = responseSetCookies(c.res.headers);
    c.res.headers.delete("set-cookie");
    for (const cookie of sessionCookies) c.res.headers.append("set-cookie", cookie);
    for (const cookie of routeCookies) c.res.headers.append("set-cookie", cookie);
  }
}

/**
 * Resolve the actor. Personal access tokens are opt-in (`allowToken`): by default a token-authed
 * request is rejected, so a scoped PAT can only reach the few endpoints that explicitly allow it
 * (the skills read/write surfaces) and never the org/team/member management endpoints.
 */
export function actorFromContext(
  c: Context<{ Variables: ApiVariables }>,
  allowToken = false,
): ActorContext {
  const user = c.get("user");
  if (user) return { id: user.id, email: user.email, name: user.name || user.email };
  const tokenActor = c.get("tokenActor");
  if (tokenActor) {
    if (!allowToken) throw new Error("personal access tokens are not allowed on this endpoint");
    return tokenActor;
  }
  throw new AuthenticationRequiredError();
}

export class AuthenticationRequiredError extends Error {
  constructor() {
    super("not authenticated");
    this.name = "AuthenticationRequiredError";
  }
}

/** True when the request is authenticated by a personal access token rather than a cookie session. */
export function isTokenRequest(c: Context<{ Variables: ApiVariables }>): boolean {
  return c.get("programmaticAuthKind") === "pat";
}

/** True only for a validated delegated-agent JWT (never for a PAT). */
export function isAgentRequest(c: Context<{ Variables: ApiVariables }>): boolean {
  return c.get("programmaticAuthKind") === "agent";
}

/**
 * Gate a capability for token-authed requests. Cookie sessions (a signed-in human) implicitly
 * hold every scope; a `cmp_pat_…` token must carry the requested scope.
 */
export async function requireScope(c: Context<{ Variables: ApiVariables }>, scope: TokenScope): Promise<void> {
  const scopes = c.get("tokenScopes");
  if (scopes === null) {
    // cookie session → full access
  } else if (!scopes.some((granted) =>
    granted === scope
    || (
      granted !== "public-skills:install"
      && scope !== "public-skills:install"
      && companionCapabilityAllows(granted, scope)
    )
  )) {
    throw new Error(`token is missing the ${scope} scope`);
  }
}

export async function orgIdFromContext(c: Context<{ Variables: ApiVariables }>): Promise<string> {
  // A token is bound to a single org — that binding wins over any header/cookie hint.
  const tokenOrgId = c.get("tokenOrgId");
  if (tokenOrgId) return tokenOrgId;
  const actor = actorFromContext(c);
  const header = c.req.header("x-companion-org");
  const cookie = getCookie(c, "companion_org");
  const wanted = header || cookie || null;
  const orgs = await listOrgs(actor);
  if (wanted && !orgs.some((o) => o.org_id === wanted)) {
    throw new Error("selected organization is not available to the current user");
  }
  const current = wanted ? orgs.find((o) => o.org_id === wanted) : orgs[0];
  if (!current) throw new Error("no organization selected");
  return current.org_id;
}

export function jsonError(c: Context, error: unknown, status = 400): Response {
  if (error instanceof EntitlementDeniedError) {
    return c.json(error.body, 403);
  }
  const message = error instanceof Error ? error.message : String(error);
  const code = error && typeof error === "object" && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
  if (status >= 500) captureServerError(error);
  return c.json({ ok: false, error: message, ...(code ? { code } : {}) }, status as never);
}
