import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import {
  getAppDefinition,
  type AppDefinitionId,
  type CuratedAppDefinition,
} from "./definitions";
import { getAppOAuthAdapter } from "./oauth-adapters";
// Adapted from The Vibe Company's Companion OAuth provider contracts (MIT).
export type CompanionPluginOAuthServerName = AppDefinitionId;

export type OAuthFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
const OAUTH_TIMEOUT_MS = 10_000;

/** One decoded JSON value from an OAuth provider response; parsed at the fetch boundary. */
export type CompanionPluginOAuthJsonValue =
  | string
  | number
  | boolean
  | null
  | CompanionPluginOAuthJsonValue[]
  | { [key: string]: CompanionPluginOAuthJsonValue };

const jsonStringSchema = z.string();
const jsonObjectSchema = z.record(z.string(), z.unknown());

export interface CompanionPluginOAuthClient {
  clientId: string;
  /** Always null once persisted: the deployment secret is read from the environment per request. */
  clientSecret: string | null;
  tokenEndpointAuthMethod: "none" | "client_secret_post" | "client_secret_basic";
}

export interface CompanionPluginOAuthFlow {
  serverName: CompanionPluginOAuthServerName;
  provider: string;
  remoteUrl: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  resource: string;
  scope: string;
  /** Null only for an adapter without PKCE; GitHub always uses PKCE. */
  codeVerifier: string | null;
  client: CompanionPluginOAuthClient;
}

export interface CompanionPluginOAuthTokens {
  accessToken: string;
  refreshToken: string | null;
  accessExpiresAt: string | null;
  scope: string | null;
  tokenType: "Bearer";
}

export interface CompanionPluginGithubIdentity {
  login: string;
  name: string;
  email: string;
}

export interface CompanionPluginStoredOAuthCredential extends CompanionPluginOAuthTokens {
  kind: "oauth";
  version: 1;
  serverName: CompanionPluginOAuthServerName;
  tokenEndpoint: string;
  resource: string;
  client: CompanionPluginOAuthClient;
  /** Present for GitHub so the Box can commit as this account without another OAuth. */
  githubIdentity?: CompanionPluginGithubIdentity;
}

export class CompanionPluginOAuthError extends Error {
  readonly stableCode: string | undefined;
  readonly action = "retry" as const;

  constructor(
    message: string,
    readonly code:
      | "oauth_not_supported"
      | "oauth_not_configured"
      | "oauth_discovery_failed"
      | "oauth_exchange_failed"
      | "oauth_refresh_failed",
  ) {
    super(message);
    this.name = "CompanionPluginOAuthError";
    this.stableCode = code === "oauth_refresh_failed"
      ? "mcp_oauth_refresh_failed"
      : undefined;
  }
}

/** The stored refresh grant is known to be invalid; the member must reconnect. */
export class CompanionPluginOAuthRevokedError extends CompanionPluginOAuthError {
  constructor() {
    super(
      "The MCP authorization has been revoked. Reconnect it in Apps.",
      "oauth_refresh_failed",
    );
    this.name = "CompanionPluginOAuthRevokedError";
  }
}

function isRecord<T>(value: T): value is T & Record<string, CompanionPluginOAuthJsonValue> {
  return Boolean(value) && jsonObjectSchema.safeParse(value).success;
}

function requiredString(
  value: CompanionPluginOAuthJsonValue | undefined,
  error: CompanionPluginOAuthError,
): string {
  const parsed = jsonStringSchema.safeParse(value);
  if (!parsed.success || !parsed.data.trim()) throw error;
  return parsed.data.trim();
}

function allowedUrl(
  value: CompanionPluginOAuthJsonValue | undefined,
  origins: readonly string[],
  error: CompanionPluginOAuthError,
): string {
  const raw = requiredString(value, error);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw error;
  }
  if (url.protocol !== "https:" || url.username || url.password || !origins.includes(url.origin)) {
    throw error;
  }
  return url.toString();
}

async function oauthJson(
  url: string,
  init: RequestInit,
  fetchImpl: OAuthFetch,
  failure: CompanionPluginOAuthError,
  signal?: AbortSignal,
): Promise<Record<string, CompanionPluginOAuthJsonValue>> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      ...init,
      redirect: "error",
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(OAUTH_TIMEOUT_MS)])
        : AbortSignal.timeout(OAUTH_TIMEOUT_MS),
      headers: {
        accept: "application/json",
        ...init.headers,
      },
    });
  } catch (error) {
    if (signal?.aborted) throw signal.reason ?? error;
    throw failure;
  }
  if (!response.ok) throw failure;
  // SAFETY: a parsed JSON body is always a JSON value; null is the transport-failure fallback.
  const value = await response.json().catch((cause: unknown) => {
    if (signal?.aborted) throw signal.reason ?? cause;
    return null;
  }) as CompanionPluginOAuthJsonValue;
  if (signal?.aborted) throw signal.reason ?? failure;
  if (!isRecord(value)) throw failure;
  return value;
}

function codeVerifier(): string {
  return randomBytes(32).toString("base64url");
}

export function companionPluginOAuthCodeChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

function environmentClient(
  definition: CuratedAppDefinition,
  env: NodeJS.ProcessEnv,
): CompanionPluginOAuthClient {
  const configured = definition.oauth.client;
  const clientId = env[configured.clientIdEnv]?.trim();
  const clientSecret = env[configured.clientSecretEnv]?.trim();
  if (!clientId || !clientSecret) {
    throw new CompanionPluginOAuthError(
      `${definition.name} MCP OAuth is not configured.`,
      "oauth_not_configured",
    );
  }
  return { clientId, clientSecret, tokenEndpointAuthMethod: configured.tokenEndpointAuthMethod };
}

/**
 * Start OAuth for one native App. Protected-resource metadata is verified against the pinned remote
 * and authorization server; the authorization and token endpoints come only from the definition.
 */
export async function beginCompanionPluginOAuth(input: {
  serverName: string;
  redirectUri: string;
  state: string;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: OAuthFetch;
}): Promise<{ authorizationUrl: string; flow: CompanionPluginOAuthFlow }> {
  const definition = getAppDefinition(input.serverName);
  if (!definition) {
    throw new CompanionPluginOAuthError(
      "This catalog server does not support Companion OAuth.",
      "oauth_not_supported",
    );
  }
  const serverName = definition.id;
  const server = definition.oauth;
  const adapter = getAppOAuthAdapter(server.adapter);
  const fetchImpl = input.fetchImpl ?? fetch;
  const discoveryFailure = new CompanionPluginOAuthError(
    "The MCP server's OAuth metadata could not be verified.",
    "oauth_discovery_failed",
  );
  const resourceMetadata = await oauthJson(
    server.resourceMetadataUrl,
    { method: "GET" },
    fetchImpl,
    discoveryFailure,
  );
  const validatedResource = allowedUrl(resourceMetadata.resource, server.allowedOrigins, discoveryFailure);
  if (validatedResource !== new URL(definition.mcp.url).toString()) throw discoveryFailure;
  // OAuth resource identifiers are exact strings; URL validation must not add a slash.
  const resource = resourceMetadata.resource as string;
  const authorizationServers = resourceMetadata.authorization_servers;
  if (
    !Array.isArray(authorizationServers)
    || !authorizationServers.some((value) => value === server.authorizationServer)
  ) {
    throw discoveryFailure;
  }
  if (!server.authorizationEndpoint || !server.tokenEndpoint) throw discoveryFailure;
  const authorizationEndpoint = server.authorizationEndpoint;
  const tokenEndpoint = server.tokenEndpoint;
  const client = environmentClient(definition, input.env ?? process.env);

  const verifier = adapter.pkce ? codeVerifier() : null;
  const scope = server.scopes.join(adapter.scopeSeparator);
  const flow: CompanionPluginOAuthFlow = {
    serverName,
    provider: definition.provider,
    remoteUrl: definition.mcp.url,
    authorizationEndpoint,
    tokenEndpoint,
    resource,
    scope,
    codeVerifier: verifier,
    client,
  };
  const authorizationUrl = new URL(authorizationEndpoint);
  authorizationUrl.searchParams.set("response_type", "code");
  authorizationUrl.searchParams.set("client_id", client.clientId);
  authorizationUrl.searchParams.set("redirect_uri", input.redirectUri);
  authorizationUrl.searchParams.set("state", input.state);
  if (verifier !== null) {
    authorizationUrl.searchParams.set("code_challenge", companionPluginOAuthCodeChallenge(verifier));
    authorizationUrl.searchParams.set("code_challenge_method", "S256");
  }
  authorizationUrl.searchParams.set("scope", scope);
  if (adapter.resourceIndicator) {
    authorizationUrl.searchParams.set("resource", resource);
  }
  return { authorizationUrl: authorizationUrl.toString(), flow };
}

interface ClientAuthenticationHeaders {
  authorization?: string;
}

function clientAuthentication(
  client: CompanionPluginOAuthClient,
  body: URLSearchParams,
): ClientAuthenticationHeaders {
  if (client.tokenEndpointAuthMethod === "client_secret_basic") {
    return {
      authorization: `Basic ${Buffer.from(`${client.clientId}:${client.clientSecret}`).toString("base64")}`,
    };
  }
  body.set("client_id", client.clientId);
  if (!client.clientSecret || client.tokenEndpointAuthMethod === "none") return {};
  body.set("client_secret", client.clientSecret);
  return {};
}

function parseTokens(
  raw: Record<string, CompanionPluginOAuthJsonValue>,
  failure: CompanionPluginOAuthError,
  previousRefreshToken: string | null = null,
  previousScope: string | null = null,
  acceptedTokenTypes: readonly string[] = ["bearer"],
): CompanionPluginOAuthTokens {
  const accessToken = requiredString(raw.access_token, failure);
  if (/[\r\n\0]/.test(accessToken)) throw failure;
  const tokenTypeParsed = jsonStringSchema.safeParse(raw.token_type);
  const tokenType = tokenTypeParsed.success ? tokenTypeParsed.data : "Bearer";
  if (!acceptedTokenTypes.includes(tokenType.toLocaleLowerCase("en-US"))) throw failure;
  const refreshTokenParsed = jsonStringSchema.safeParse(raw.refresh_token);
  const refreshToken = refreshTokenParsed.success && refreshTokenParsed.data
    ? refreshTokenParsed.data
    : previousRefreshToken;
  if (refreshToken && /[\r\n\0]/.test(refreshToken)) throw failure;
  const expiresInParsed = z.number().safeParse(raw.expires_in);
  const expiresIn = expiresInParsed.success ? Math.max(0, expiresInParsed.data) : null;
  return {
    accessToken,
    refreshToken,
    accessExpiresAt: expiresIn === null
      ? null
      : new Date(Date.now() + expiresIn * 1000).toISOString(),
    // SAFETY: safeParse above proved raw.scope is a string.
    scope: jsonStringSchema.safeParse(raw.scope).success ? raw.scope as string : previousScope,
    tokenType: "Bearer",
  };
}

function requiredAppDefinition(serverName: CompanionPluginOAuthServerName): CuratedAppDefinition {
  const definition = getAppDefinition(serverName);
  if (!definition) throw new Error("invalid curated App definition");
  return definition;
}

/** Exchange an authorization code without ever returning provider response bodies in errors. */
export async function completeCompanionPluginOAuth(input: {
  flow: CompanionPluginOAuthFlow;
  code: string;
  redirectUri: string;
  fetchImpl?: OAuthFetch;
}): Promise<CompanionPluginStoredOAuthCredential> {
  const definition = requiredAppDefinition(input.flow.serverName);
  const adapter = getAppOAuthAdapter(definition.oauth.adapter);
  const failure = new CompanionPluginOAuthError(
    "The MCP authorization code could not be exchanged.",
    "oauth_exchange_failed",
  );
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: input.code,
    redirect_uri: input.redirectUri,
  });
  if (input.flow.codeVerifier !== null) body.set("code_verifier", input.flow.codeVerifier);
  if (adapter.resourceIndicator) {
    body.set("resource", input.flow.resource);
  }
  const authentication = clientAuthentication(input.flow.client, body);
  const raw = await oauthJson(
    input.flow.tokenEndpoint,
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", ...authentication },
      body,
    },
    input.fetchImpl ?? fetch,
    failure,
  );
  const tokens = parseTokens(
    raw,
    new CompanionPluginOAuthError(
      "The MCP server did not return a usable OAuth credential.",
      "oauth_exchange_failed",
    ),
    null,
    null,
    adapter.acceptedTokenTypes,
  );
  const githubIdentity = adapter.enrichCredential === "github-identity"
    ? await githubUserIdentity({
      accessToken: tokens.accessToken,
      fetchImpl: input.fetchImpl,
    }) ?? undefined
    : undefined;
  const credential: CompanionPluginStoredOAuthCredential = {
    kind: "oauth",
    version: 1,
    ...tokens,
    serverName: input.flow.serverName,
    tokenEndpoint: input.flow.tokenEndpoint,
    resource: input.flow.resource,
    // Deployment OAuth client secrets never belong in each member account envelope.
    client: { ...input.flow.client, clientSecret: null },
  };
  if (githubIdentity) credential.githubIdentity = githubIdentity;
  return credential;
}

/** Refresh one stored OAuth grant. The old refresh token survives providers that rotate only access. */
export async function refreshCompanionPluginOAuth(input: {
  credential: CompanionPluginStoredOAuthCredential;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: OAuthFetch;
  signal?: AbortSignal;
}): Promise<CompanionPluginStoredOAuthCredential> {
  const definition = requiredAppDefinition(input.credential.serverName);
  const adapter = getAppOAuthAdapter(definition.oauth.adapter);
  if (!input.credential.refreshToken) {
    throw new CompanionPluginOAuthError(
      "The MCP authorization has expired. Reconnect it in Apps.",
      "oauth_refresh_failed",
    );
  }
  const failure = new CompanionPluginOAuthError(
    "The MCP authorization could not be refreshed. Reconnect it in Apps.",
    "oauth_refresh_failed",
  );
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: input.credential.refreshToken,
  });
  if (adapter.resourceIndicator) {
    body.set("resource", input.credential.resource);
  }
  let client: CompanionPluginOAuthClient;
  try {
    client = environmentClient(definition, input.env ?? process.env);
  } catch {
    throw failure;
  }
  if (client.clientId !== input.credential.client.clientId) throw failure;
  const authentication = clientAuthentication(client, body);
  const raw = await oauthJson(
    input.credential.tokenEndpoint,
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", ...authentication },
      body,
    },
    input.fetchImpl ?? fetch,
    failure,
    input.signal,
  );
  const tokens = parseTokens(
    raw,
    failure,
    input.credential.refreshToken,
    input.credential.scope,
    adapter.acceptedTokenTypes,
  );
  const githubIdentity = adapter.enrichCredential === "github-identity"
    ? await githubUserIdentity({
      accessToken: tokens.accessToken,
      fetchImpl: input.fetchImpl,
      signal: input.signal,
    }) ?? input.credential.githubIdentity
    : input.credential.githubIdentity;
  const refreshed: CompanionPluginStoredOAuthCredential = {
    ...input.credential,
    ...tokens,
  };
  if (githubIdentity) refreshed.githubIdentity = githubIdentity;
  return refreshed;
}

const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;

export function parseCompanionPluginGithubIdentity<T>(
  value: T,
): CompanionPluginGithubIdentity | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) {
    throw new Error("invalid GitHub identity");
  }
  const loginParsed = jsonStringSchema.safeParse(value.login);
  if (!loginParsed.success || !GITHUB_LOGIN.test(loginParsed.data)) {
    throw new Error("invalid GitHub identity");
  }
  const nameParsed = jsonStringSchema.safeParse(value.name);
  const name = nameParsed.success ? gitIdentityLine(nameParsed.data, 200) : null;
  const emailParsed = jsonStringSchema.safeParse(value.email);
  const email = emailParsed.success ? gitIdentityLine(emailParsed.data, 200) : null;
  if (!email || !email.includes("@") || email.includes(" ")) {
    throw new Error("invalid GitHub identity");
  }
  return {
    login: loginParsed.data,
    name: name ?? loginParsed.data,
    email,
  };
}

function gitIdentityLine(value: string, max: number): string | null {
  const trimmed = value.replace(/[\r\n\0"]/g, " ").replace(/\s+/g, " ").trim();
  if (!trimmed || trimmed.length > max) return null;
  return trimmed;
}

/**
 * Best-effort GitHub commit identity. A missing or malformed profile must not fail the OAuth grant:
 * clone/push still work from the token, and `git commit` can use noreply once login is known.
 */
export async function githubUserIdentity(input: {
  accessToken: string;
  fetchImpl?: OAuthFetch;
  signal?: AbortSignal;
}): Promise<CompanionPluginGithubIdentity | null> {
  try {
    const fetchImpl = input.fetchImpl ?? fetch;
    const response = await fetchImpl("https://api.github.com/user", {
      method: "GET",
      redirect: "error",
      signal: input.signal
        ? AbortSignal.any([input.signal, AbortSignal.timeout(OAUTH_TIMEOUT_MS)])
        : AbortSignal.timeout(OAUTH_TIMEOUT_MS),
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${input.accessToken}`,
        "user-agent": "companion",
        "x-github-api-version": "2022-11-28",
      },
    });
    if (!response.ok) return null;
    // SAFETY: a parsed JSON body is always a JSON value; null is the transport-failure fallback.
    const raw = await response.json().catch(() => null) as CompanionPluginOAuthJsonValue;
    if (!isRecord(raw)) return null;
    const loginParsed = jsonStringSchema.safeParse(raw.login);
    if (!loginParsed.success || !GITHUB_LOGIN.test(loginParsed.data)) {
      return null;
    }
    const login = loginParsed.data;
    const nameParsed = jsonStringSchema.safeParse(raw.name);
    const name = nameParsed.success ? gitIdentityLine(nameParsed.data, 200) : null;
    return {
      login,
      name: name ?? login,
      email: `${login}@users.noreply.github.com`,
    };
  } catch (error) {
    if (input.signal?.aborted) throw input.signal.reason ?? error;
    return null;
  }
}
