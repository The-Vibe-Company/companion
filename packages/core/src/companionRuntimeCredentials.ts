/* oxlint-disable anti-slop/no-unsafe-dictionary-type, anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof, anti-slop/no-unknown-returns, anti-slop/require-safety-comment-for-type-assertion, anti-slop/no-chained-type-assertions, anti-slop/no-conditional-empty-object-spread -- This established encrypted-credential decoder validates every decrypted field before returning it; THE-528 changes only its runtime-contract wording. */
import {
  companionMcpCredentialSchema,
  type CompanionMcpCredential,
} from "@companion/contracts";
import {
  COMPANION_PLUGIN_OAUTH_SERVERS,
  parseCompanionPluginGithubIdentity,
  type CompanionPluginStoredOAuthCredential,
} from "./companionPluginOAuth";
import {
  decryptOpaqueValue,
  encryptOpaqueValue,
  type OpaqueCiphertext,
} from "./secretsCrypto";

const PROVIDER_CREDENTIAL_PURPOSE = "companion-provider-credential";
const MCP_CREDENTIAL_PURPOSE = "companion-mcp-credential";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PROVIDER_ID = /^[a-z][a-z0-9-]{0,62}$/;

export const COMPANION_MCP_OAUTH_REFRESH_SKEW_MS = 5 * 60_000;

export class CompanionRuntimeCredentialError extends Error {
  constructor(readonly code: "provider_auth_invalid" | "mcp_auth_invalid") {
    super(code === "provider_auth_invalid"
      ? "Companion provider authentication is invalid."
      : "Companion MCP authentication is invalid.");
    this.name = "CompanionRuntimeCredentialError";
  }
}

export type CompanionRuntimeProviderCredential =
  | ({ type: "api_key"; key: string } & Record<string, unknown>)
  | ({ type: "oauth"; access: string } & Record<string, unknown>);

export type CompanionRuntimeMcpCredential =
  | { kind: "environment"; credentials: CompanionMcpCredential[] }
  | { kind: "oauth"; credential: CompanionPluginStoredOAuthCredential };

interface RuntimeEncryptedCredentialInput {
  orgId: string;
  credentialGeneration: string;
  envelope: OpaqueCiphertext;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function assertUuid(value: string): void {
  if (!UUID.test(value)) throw new Error("invalid credential identity");
}

function parseJsonCredential(input: {
  orgId: string;
  purpose: string;
  subjectId: string;
  envelope: OpaqueCiphertext;
  masterKey: Buffer;
}): unknown {
  return JSON.parse(decryptOpaqueValue({
    orgId: input.orgId,
    purpose: input.purpose,
    subjectId: input.subjectId,
    ...input.envelope,
  }, input.masterKey)) as unknown;
}

/**
 * Decrypt one provider envelope already authorized and generation-pinned by Runtime v3 SQL.
 * Failures expose only a stable local error; neither ciphertext nor plaintext enters the message.
 */
export function decryptCompanionProviderRuntimeCredential(
  input: RuntimeEncryptedCredentialInput & { providerId: string },
  masterKey: Buffer,
): CompanionRuntimeProviderCredential {
  try {
    if (!PROVIDER_ID.test(input.providerId)) throw new Error("invalid provider identity");
    assertUuid(input.credentialGeneration);
    const parsed = parseJsonCredential({
      orgId: input.orgId,
      purpose: PROVIDER_CREDENTIAL_PURPOSE,
      subjectId: `${input.providerId}:${input.credentialGeneration}`,
      envelope: input.envelope,
      masterKey,
    });
    if (!isRecord(parsed)) throw new Error("invalid provider credential");
    if (parsed.type === "api_key" && typeof parsed.key === "string" && parsed.key.length > 0) {
      return parsed as CompanionRuntimeProviderCredential;
    }
    if (parsed.type === "oauth" && typeof parsed.access === "string" && parsed.access.length > 0) {
      return parsed as CompanionRuntimeProviderCredential;
    }
    throw new Error("invalid provider credential");
  } catch {
    throw new CompanionRuntimeCredentialError("provider_auth_invalid");
  }
}

function parseStoredOauth(value: unknown): CompanionPluginStoredOAuthCredential {
  if (!isRecord(value)
    || value.kind !== "oauth"
    || value.version !== 1
    || typeof value.serverName !== "string"
    || !(value.serverName in COMPANION_PLUGIN_OAUTH_SERVERS)
    || typeof value.accessToken !== "string"
    || value.accessToken.length === 0
    || (value.refreshToken !== null && typeof value.refreshToken !== "string")
    || (value.accessExpiresAt !== null && typeof value.accessExpiresAt !== "string")
    || (value.scope !== null && typeof value.scope !== "string")
    || value.tokenType !== "Bearer"
    || typeof value.tokenEndpoint !== "string"
    || value.tokenEndpoint.length === 0
    || typeof value.resource !== "string"
    || value.resource.length === 0
    || !isRecord(value.client)
    || typeof value.client.clientId !== "string"
    || value.client.clientId.length === 0
    || (value.client.clientSecret !== null && typeof value.client.clientSecret !== "string")
    || !["none", "client_secret_post", "client_secret_basic"].includes(
      String(value.client.tokenEndpointAuthMethod),
    )) {
    throw new Error("invalid MCP OAuth credential");
  }
  if (value.accessExpiresAt !== null && !Number.isFinite(Date.parse(value.accessExpiresAt))) {
    throw new Error("invalid MCP OAuth expiry");
  }
  const server = COMPANION_PLUGIN_OAUTH_SERVERS[
    value.serverName as keyof typeof COMPANION_PLUGIN_OAUTH_SERVERS
  ];
  const tokenEndpoint = pinnedRuntimeUrl(value.tokenEndpoint, server.allowedOrigins);
  const resource = pinnedRuntimeUrl(value.resource, server.allowedOrigins);
  if (resource !== new URL(server.remoteUrl).toString()) {
    throw new Error("invalid MCP OAuth resource");
  }
  const githubIdentity = value.serverName === "io.github.github/github-mcp-server"
    ? parseGithubIdentityLenient(value.githubIdentity)
    : undefined;
  return {
    kind: "oauth",
    version: 1,
    serverName: value.serverName,
    accessToken: value.accessToken,
    refreshToken: value.refreshToken,
    accessExpiresAt: value.accessExpiresAt,
    scope: value.scope,
    tokenType: value.tokenType,
    tokenEndpoint,
    resource,
    client: value.client,
    ...(githubIdentity ? { githubIdentity } : {}),
  } as unknown as CompanionPluginStoredOAuthCredential;
}

function parseGithubIdentityLenient(
  value: unknown,
): ReturnType<typeof parseCompanionPluginGithubIdentity> {
  try {
    return parseCompanionPluginGithubIdentity(value);
  } catch {
    return undefined;
  }
}

function pinnedRuntimeUrl(value: string, allowedOrigins: readonly string[]): string {
  const url = new URL(value);
  if (
    url.protocol !== "https:"
    || url.username
    || url.password
    || !allowedOrigins.includes(url.origin)
  ) {
    throw new Error("invalid MCP OAuth endpoint");
  }
  return url.toString();
}

function validateMcpCredentialValue(value: unknown): CompanionRuntimeMcpCredential {
  if (Array.isArray(value)) {
    if (value.length > 20) throw new Error("too many MCP credentials");
    return {
      kind: "environment",
      credentials: value.map((entry) => companionMcpCredentialSchema.parse(entry)),
    };
  }
  return { kind: "oauth", credential: parseStoredOauth(value) };
}

/** Decrypt and validate one generation-pinned MCP credential without touching PostgreSQL. */
export function decryptCompanionMcpRuntimeCredential(
  input: RuntimeEncryptedCredentialInput & { accountId: string },
  masterKey: Buffer,
): CompanionRuntimeMcpCredential {
  try {
    assertUuid(input.accountId);
    assertUuid(input.credentialGeneration);
    const parsed = parseJsonCredential({
      orgId: input.orgId,
      purpose: MCP_CREDENTIAL_PURPOSE,
      subjectId: `${input.accountId}:${input.credentialGeneration}`,
      envelope: input.envelope,
      masterKey,
    });
    return validateMcpCredentialValue(parsed);
  } catch {
    throw new CompanionRuntimeCredentialError("mcp_auth_invalid");
  }
}

/**
 * Prepare a refreshed MCP OAuth envelope for the lease-fenced generation CAS. The caller persists
 * it only through the narrow Runtime v3 function and must discard it if that CAS loses.
 */
export function encryptCompanionMcpRuntimeCredential(input: {
  orgId: string;
  accountId: string;
  credentialGeneration: string;
  credential: CompanionPluginStoredOAuthCredential | CompanionMcpCredential[];
}, masterKey: Buffer): OpaqueCiphertext {
  try {
    assertUuid(input.accountId);
    assertUuid(input.credentialGeneration);
    const validated = validateMcpCredentialValue(input.credential);
    const value = validated.kind === "oauth" ? validated.credential : validated.credentials;
    return encryptOpaqueValue({
      orgId: input.orgId,
      purpose: MCP_CREDENTIAL_PURPOSE,
      subjectId: `${input.accountId}:${input.credentialGeneration}`,
      value: JSON.stringify(value),
    }, masterKey);
  } catch (error) {
    if (error instanceof CompanionRuntimeCredentialError) throw error;
    throw new CompanionRuntimeCredentialError("mcp_auth_invalid");
  }
}
