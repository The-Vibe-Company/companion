import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db, schema, type Db } from "@companion/db";
import {
  decryptCompanionMcpRuntimeCredential,
  encryptCompanionMcpRuntimeCredential,
} from "./companionRuntimeCredentials";
import {
  CompanionPluginOAuthError,
  CompanionPluginOAuthRevokedError,
  refreshCompanionPluginOAuth,
  type CompanionPluginStoredOAuthCredential,
} from "./companionPluginOAuth";
import { resolvePreTenantMcpBrokerToken } from "./preTenant";

const MCP_BROKER_TOKEN = /^cmp_mcp_[0-9a-f]{48}$/;
/** Private Box-broker exchange. These schemas are not part of ordinary Companion CRUD. */
export const companionMcpAccessTokenInputSchema = z.object({
  account_id: z.string().uuid(),
  credential_generation: z.string().uuid(),
  force_refresh: z.boolean().default(false),
}).strict();
export const companionMcpAccessTokenSchema = z.object({
  access_token: z.string().min(1),
  token_type: z.literal("Bearer"),
  expires_at: z.string().datetime().nullable(),
  credential_version: z.number().int().positive(),
}).strict();
export type CompanionMcpAccessToken = z.infer<typeof companionMcpAccessTokenSchema>;

const accountRefsSchema = z.array(z.object({
  account_id: z.string().uuid(),
  credential_generation: z.string().uuid(),
}).strip()).min(1).max(50);
const selectedAccountLockSchema = z.object({ authorized: z.boolean() }).strict();

export class CompanionMcpBrokerAuthorizationError extends Error {
  constructor() {
    super("MCP broker authorization is unavailable");
    this.name = "CompanionMcpBrokerAuthorizationError";
  }
}

export interface CompanionMcpBrokerAuthorization {
  orgId: string;
  companionId: string;
  actorId: string;
  accountRefs: Array<{ account_id: string; credential_generation: string }>;
}

export async function resolveCompanionMcpBrokerAuthorization(
  rawToken: string,
  database: Db = db,
): Promise<CompanionMcpBrokerAuthorization | null> {
  if (!MCP_BROKER_TOKEN.test(rawToken)) return null;
  const tokenHash = createHash("sha256").update(rawToken, "utf8").digest("hex");
  const row = await resolvePreTenantMcpBrokerToken(database, tokenHash);
  if (!row) return null;
  const parsed = accountRefsSchema.safeParse(row.account_refs);
  if (!parsed.success) return null;
  return {
    orgId: row.org_id,
    companionId: row.companion_id,
    actorId: row.actor_id,
    accountRefs: parsed.data,
  };
}

export async function issueCompanionMcpAccessToken(input: {
  authorization: CompanionMcpBrokerAuthorization;
  accountId: string;
  credentialGeneration: string;
  forceRefresh: boolean;
  masterKey: Buffer;
  database: Db;
  now?: () => number;
  refreshOauth?: (
    credential: CompanionPluginStoredOAuthCredential,
  ) => Promise<CompanionPluginStoredOAuthCredential>;
}): Promise<CompanionMcpAccessToken | null> {
  const { database } = input;
  const authorized = input.authorization.accountRefs.some((ref) =>
    ref.account_id === input.accountId
    && ref.credential_generation === input.credentialGeneration);
  if (!authorized) throw new CompanionMcpBrokerAuthorizationError();
  const [observedAccount] = input.forceRefresh
    ? await database
      .select({ credentialVersion: schema.companionMcpAccounts.credentialVersion })
      .from(schema.companionMcpAccounts)
      .where(and(
        eq(schema.companionMcpAccounts.id, input.accountId),
        eq(schema.companionMcpAccounts.orgId, input.authorization.orgId),
        eq(schema.companionMcpAccounts.ownerId, input.authorization.actorId),
        eq(schema.companionMcpAccounts.credentialGeneration, input.credentialGeneration),
      ))
      .limit(1)
    : [null];
  if (input.forceRefresh && !observedAccount) throw new CompanionMcpBrokerAuthorizationError();
  const selectionLockResult = await database.execute(sql`
    select public.companion_api_lock_selected_mcp_account(
      ${input.authorization.orgId}::uuid,
      ${input.authorization.companionId}::uuid,
      ${input.accountId}::uuid
    ) as authorized
  `);
  const selectionLock = selectedAccountLockSchema.safeParse(Array.from(selectionLockResult)[0]);
  if (!selectionLock.success || !selectionLock.data.authorized) {
    throw new CompanionMcpBrokerAuthorizationError();
  }
  const now = input.now ?? Date.now;
  const refreshOauth = input.refreshOauth
    ?? (async (credential) => await refreshCompanionPluginOAuth({ credential }));
  let forceRefresh = input.forceRefresh;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const [row] = await database
      .select()
      .from(schema.companionMcpAccounts)
      .where(and(
        eq(schema.companionMcpAccounts.id, input.accountId),
        eq(schema.companionMcpAccounts.orgId, input.authorization.orgId),
        eq(schema.companionMcpAccounts.ownerId, input.authorization.actorId),
        eq(schema.companionMcpAccounts.credentialGeneration, input.credentialGeneration),
      ))
      .limit(1)
      .for("update");
    if (!row) throw new CompanionMcpBrokerAuthorizationError();
    const decrypted = decryptCompanionMcpRuntimeCredential({
      orgId: input.authorization.orgId,
      accountId: row.id,
      credentialGeneration: row.credentialGeneration,
      envelope: {
        ciphertext: row.ciphertext,
        iv: row.iv,
        authTag: row.authTag,
        wrappedDek: row.wrappedDek,
        wrapIv: row.wrapIv,
        wrapAuthTag: row.wrapAuthTag,
        keyId: row.keyId,
      },
    }, input.masterKey);
    if (decrypted.kind !== "oauth") throw new CompanionMcpBrokerAuthorizationError();
    const expiresAt = decrypted.credential.accessExpiresAt === null
      ? null
      : Date.parse(decrypted.credential.accessExpiresAt);
    const usable = expiresAt === null || Number.isFinite(expiresAt) && expiresAt > now();
    if (
      forceRefresh
      && observedAccount
      && row.credentialVersion > observedAccount.credentialVersion
      && usable
    ) {
      return tokenResponse(decrypted.credential, row.credentialVersion);
    }
    if (!forceRefresh && usable) {
      return tokenResponse(decrypted.credential, row.credentialVersion);
    }

    let refreshed: CompanionPluginStoredOAuthCredential;
    try {
      refreshed = await refreshOauth(decrypted.credential);
    } catch (error) {
      if (
        decrypted.credential.serverName === "com.google.workspace/gmail"
        && error instanceof CompanionPluginOAuthRevokedError
      ) {
        const [deleted] = await database
          .delete(schema.companionMcpAccounts)
          .where(and(
            eq(schema.companionMcpAccounts.id, row.id),
            eq(schema.companionMcpAccounts.orgId, row.orgId),
            eq(schema.companionMcpAccounts.ownerId, row.ownerId),
            eq(schema.companionMcpAccounts.credentialGeneration, row.credentialGeneration),
            eq(schema.companionMcpAccounts.credentialVersion, row.credentialVersion),
          ))
          .returning({ id: schema.companionMcpAccounts.id });
        if (!deleted) throw new CompanionMcpBrokerAuthorizationError();
        // The caller converts this sentinel to the existing expurgated refresh failure only after
        // its tenant transaction commits, so the credential deletion cannot be rolled back.
        return null;
      }
      throw error;
    }
    const refreshedExpiry = refreshed.accessExpiresAt === null
      ? null
      : Date.parse(refreshed.accessExpiresAt);
    if (refreshedExpiry !== null && (!Number.isFinite(refreshedExpiry) || refreshedExpiry <= now())) {
      throw new CompanionPluginOAuthError(
        "The MCP authorization could not be refreshed. Reconnect it in Plugins.",
        "oauth_refresh_failed",
      );
    }
    const envelope = encryptCompanionMcpRuntimeCredential({
      orgId: input.authorization.orgId,
      accountId: row.id,
      credentialGeneration: row.credentialGeneration,
      credential: refreshed,
    }, input.masterKey);
    const [updated] = await database
      .update(schema.companionMcpAccounts)
      .set({
        credentialVersion: row.credentialVersion + 1,
        ciphertext: envelope.ciphertext,
        iv: envelope.iv,
        authTag: envelope.authTag,
        wrappedDek: envelope.wrappedDek,
        wrapIv: envelope.wrapIv,
        wrapAuthTag: envelope.wrapAuthTag,
        keyId: envelope.keyId,
        updatedAt: new Date(now()),
      })
      .where(and(
        eq(schema.companionMcpAccounts.id, row.id),
        eq(schema.companionMcpAccounts.orgId, row.orgId),
        eq(schema.companionMcpAccounts.ownerId, row.ownerId),
        eq(schema.companionMcpAccounts.credentialGeneration, row.credentialGeneration),
        eq(schema.companionMcpAccounts.credentialVersion, row.credentialVersion),
      ))
      .returning({ credentialVersion: schema.companionMcpAccounts.credentialVersion });
    if (updated) return tokenResponse(refreshed, updated.credentialVersion);
    // A concurrent caller already refreshed the same grant. Read its committed value instead of
    // starting another provider refresh and risking rotation of the same refresh token twice.
    forceRefresh = false;
  }
  throw new CompanionMcpBrokerAuthorizationError();
}

function tokenResponse(
  credential: CompanionPluginStoredOAuthCredential,
  credentialVersion: number,
): CompanionMcpAccessToken {
  return {
    access_token: credential.accessToken,
    token_type: "Bearer",
    expires_at: credential.accessExpiresAt,
    credential_version: credentialVersion,
  };
}
