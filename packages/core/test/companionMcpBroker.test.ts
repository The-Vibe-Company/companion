import { describe, expect, it, vi } from "vitest";
import type { Db } from "@companion/db";

import {
  CompanionMcpBrokerAuthorizationError,
  issueCompanionMcpAccessToken,
  resolveCompanionMcpBrokerAuthorization,
} from "../src/companionMcpBroker";
import {
  decryptCompanionMcpRuntimeCredential,
  encryptCompanionMcpRuntimeCredential,
} from "../src/companionRuntimeCredentials";
import {
  CompanionPluginOAuthError,
  CompanionPluginOAuthRevokedError,
  type CompanionPluginStoredOAuthCredential,
} from "../src/companionPluginOAuth";

const orgId = "11111111-1111-4111-8111-111111111111";
const companionId = "22222222-2222-4222-8222-222222222222";
const actorId = "actor-1";
const accountId = "33333333-3333-4333-8333-333333333333";
const credentialGeneration = "44444444-4444-4444-8444-444444444444";
const masterKey = Buffer.alloc(32, 59);
const nowMs = Date.parse("2027-01-01T00:00:00.000Z");

type TestValue = string | number | boolean | null | TestRecord | TestValue[];

interface TestRecord {
  [key: string]: TestValue;
}

const authorization = {
  orgId,
  companionId,
  actorId,
  accountRefs: [{ account_id: accountId, credential_generation: credentialGeneration }],
};

describe("Companion MCP access-token broker", () => {
  it("projects Runtime v3 preparation references without rejecting their version fence", async () => {
    const database = databaseReturning([{
      org_id: orgId,
      companion_id: companionId,
      actor_id: actorId,
      account_refs: [{
        account_id: accountId,
        credential_generation: credentialGeneration,
        credential_version: 7,
      }],
    }]);

    await expect(resolveCompanionMcpBrokerAuthorization(
      `cmp_mcp_${"a".repeat(48)}`,
      database,
    )).resolves.toEqual(authorization);
  });

  it("rejects an account removed from the Companion's current selection", async () => {
    const refreshOauth = vi.fn();
    const database = fakeDatabase({ rows: [accountRow(oauth("access", nowMs + 1_000))], selected: [] });

    await expect(issueCompanionMcpAccessToken({
      authorization,
      accountId,
      credentialGeneration,
      forceRefresh: false,
      masterKey,
      database,
      refreshOauth,
      now: () => nowMs,
    })).rejects.toBeInstanceOf(CompanionMcpBrokerAuthorizationError);
    expect(refreshOauth).not.toHaveBeenCalled();
  });

  it("rejects the old capability identity after account deletion or reconnect", async () => {
    const refreshOauth = vi.fn();
    const database = fakeDatabase({ rows: [] });

    await expect(issueCompanionMcpAccessToken({
      authorization,
      accountId,
      credentialGeneration,
      forceRefresh: true,
      masterKey,
      database,
      refreshOauth,
      now: () => nowMs,
    })).rejects.toBeInstanceOf(CompanionMcpBrokerAuthorizationError);
    expect(refreshOauth).not.toHaveBeenCalled();
  });

  it("returns every positive access-token duration, including no expiry, without staging refresh", async () => {
    for (const expiresAt of [null, nowMs + 1_000, nowMs + 30_000, nowMs + 15 * 60_000, nowMs + 126 * 60_000]) {
      const refreshOauth = vi.fn();
      const database = fakeDatabase({ rows: [accountRow(oauth("access", expiresAt))] });
      await expect(issueCompanionMcpAccessToken({
        authorization,
        accountId,
        credentialGeneration,
        forceRefresh: false,
        masterKey,
        database,
        refreshOauth,
        now: () => nowMs,
      })).resolves.toEqual({
        access_token: "access",
        token_type: "Bearer",
        expires_at: expiresAt === null ? null : new Date(expiresAt).toISOString(),
        credential_version: 1,
      });
      expect(refreshOauth).not.toHaveBeenCalled();
    }
  });

  it("rotates the encrypted refresh token with a stable generation and incremented CAS version", async () => {
    const stored = oauth("expired", nowMs - 1, "refresh-1");
    const refreshed = oauth("fresh", nowMs + 30_000, "refresh-2");
    const updates: TestRecord[] = [];
    const database = fakeDatabase({
      rows: [accountRow(stored)],
      updateResults: [[{ credentialVersion: 2 }]],
      updates,
    });

    await expect(issueCompanionMcpAccessToken({
      authorization,
      accountId,
      credentialGeneration,
      forceRefresh: false,
      masterKey,
      database,
      refreshOauth: vi.fn(async () => refreshed),
      now: () => nowMs,
    })).resolves.toMatchObject({ access_token: "fresh", credential_version: 2 });

    expect(updates).toHaveLength(1);
    expect(updates[0]?.credentialVersion).toBe(2);
    expect(JSON.stringify(updates[0])).not.toContain("fresh");
    expect(JSON.stringify(updates[0])).not.toContain("refresh-2");
    const decrypted = decryptCompanionMcpRuntimeCredential({
      orgId,
      accountId,
      credentialGeneration,
      envelope: camelEnvelope(updates[0] ?? {}),
    }, masterKey);
    expect(decrypted).toMatchObject({
      kind: "oauth",
      credential: { accessToken: "fresh", refreshToken: "refresh-2" },
    });
  });

  it("loses a CAS race safely and reads the winner without refreshing twice", async () => {
    const refreshOauth = vi.fn(async () => oauth("loser-token", nowMs + 30_000, "loser-refresh"));
    const database = fakeDatabase({
      rows: [
        accountRow(oauth("expired", nowMs - 1, "shared-refresh")),
        accountRow(oauth("winner-token", nowMs + 30_000, "winner-refresh"), 2),
      ],
      updateResults: [[]],
    });

    await expect(issueCompanionMcpAccessToken({
      authorization,
      accountId,
      credentialGeneration,
      forceRefresh: true,
      masterKey,
      database,
      refreshOauth,
      now: () => nowMs,
    })).resolves.toMatchObject({ access_token: "winner-token", credential_version: 2 });
    expect(refreshOauth).toHaveBeenCalledOnce();
  });

  it("reuses a row-lock winner for a concurrent forced refresh", async () => {
    const refreshOauth = vi.fn();
    const database = fakeDatabase({
      rows: [accountRow(oauth("winner-token", nowMs + 30_000, "winner-refresh"), 2)],
      observedCredentialVersion: 1,
    });

    await expect(issueCompanionMcpAccessToken({
      authorization,
      accountId,
      credentialGeneration,
      forceRefresh: true,
      masterKey,
      database,
      refreshOauth,
      now: () => nowMs,
    })).resolves.toMatchObject({ access_token: "winner-token", credential_version: 2 });
    expect(refreshOauth).not.toHaveBeenCalled();
  });

  it("fails only when the provider cannot renew a truly unusable grant", async () => {
    const database = fakeDatabase({ rows: [accountRow(oauth("expired", nowMs - 1, null))] });
    const providerError = new CompanionPluginOAuthError(
      "The MCP authorization could not be refreshed. Reconnect it in Plugins.",
      "oauth_refresh_failed",
    );
    await expect(issueCompanionMcpAccessToken({
      authorization,
      accountId,
      credentialGeneration,
      forceRefresh: false,
      masterKey,
      database,
      refreshOauth: vi.fn(async () => { throw providerError; }),
      now: () => nowMs,
    })).rejects.toBe(providerError);
  });

  it("deletes a Gmail credential only after Google confirms invalid_grant", async () => {
    const rows = [accountRow(gmailOauth("expired", nowMs - 1))];
    const deletions: TestRecord[] = [];
    const database = fakeDatabase({ rows, deletions });

    await expect(issueCompanionMcpAccessToken({
      authorization,
      accountId,
      credentialGeneration,
      forceRefresh: false,
      masterKey,
      database,
      refreshOauth: vi.fn(async () => { throw new CompanionPluginOAuthRevokedError(); }),
      now: () => nowMs,
    })).resolves.toBeNull();

    expect(deletions).toEqual([{ id: accountId }]);
    expect(rows).toHaveLength(0);
  });

  it("retains a Gmail credential after an unconfirmed refresh failure", async () => {
    const rows = [accountRow(gmailOauth("expired", nowMs - 1))];
    const deletions: TestRecord[] = [];
    const database = fakeDatabase({ rows, deletions });
    const providerError = new CompanionPluginOAuthError(
      "The MCP authorization could not be refreshed. Reconnect it in Plugins.",
      "oauth_refresh_failed",
    );

    await expect(issueCompanionMcpAccessToken({
      authorization,
      accountId,
      credentialGeneration,
      forceRefresh: false,
      masterKey,
      database,
      refreshOauth: vi.fn(async () => { throw providerError; }),
      now: () => nowMs,
    })).rejects.toBe(providerError);

    expect(deletions).toEqual([]);
    expect(rows).toHaveLength(1);
  });
});

function databaseReturning(rows: unknown[]): Db {
  // SAFETY: this authorization projection exercises only `database.execute`.
  const database: Db = Object.create(null);
  Object.defineProperty(database, "execute", {
    value: vi.fn(async () => rows),
  });
  return database;
}

function oauth(
  accessToken: string,
  expiresAt: number | null,
  refreshToken: string | null = "refresh",
): CompanionPluginStoredOAuthCredential {
  return {
    kind: "oauth",
    version: 1,
    serverName: "app.linear/linear",
    accessToken,
    refreshToken,
    accessExpiresAt: expiresAt === null ? null : new Date(expiresAt).toISOString(),
    scope: "read write",
    tokenType: "Bearer",
    tokenEndpoint: "https://mcp.linear.app/token",
    resource: "https://mcp.linear.app/mcp",
    client: { clientId: "client", clientSecret: null, tokenEndpointAuthMethod: "none" },
  };
}

function gmailOauth(accessToken: string, expiresAt: number): CompanionPluginStoredOAuthCredential {
  return {
    ...oauth(accessToken, expiresAt),
    serverName: "com.google.workspace/gmail",
    scope: "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.compose",
    tokenEndpoint: "https://oauth2.googleapis.com/token",
    resource: "https://gmailmcp.googleapis.com/mcp/v1",
    client: {
      clientId: "gmail-client",
      clientSecret: "gmail-secret",
      tokenEndpointAuthMethod: "client_secret_post",
    },
  };
}

function accountRow(credential: CompanionPluginStoredOAuthCredential, credentialVersion = 1) {
  const envelope = encryptCompanionMcpRuntimeCredential({
    orgId,
    accountId,
    credentialGeneration,
    credential,
  }, masterKey);
  return {
    id: accountId,
    orgId,
    ownerId: actorId,
    provider: "linear",
    label: "Linear",
    transport: "http",
    accountConfig: {},
    credentialGeneration,
    credentialVersion,
    ...envelope,
    createdAt: new Date(nowMs),
    updatedAt: new Date(nowMs),
  };
}

interface FakeDatabaseInput {
  rows: ReturnType<typeof accountRow>[];
  selected?: string[];
  observedCredentialVersion?: number;
  updateResults?: Array<Array<{ credentialVersion: number }>>;
  updates?: TestRecord[];
  deletions?: TestRecord[];
}

interface FakeSelectProjection {
  credentialVersion?: object;
}

function buildFakeDatabase(input: FakeDatabaseInput) {
  let readIndex = 0;
  let updateIndex = 0;
  const database = {
    execute: vi.fn(async () => [{
      authorized: (input.selected ?? [accountId]).includes(accountId),
    }]),
    select: vi.fn((projection?: FakeSelectProjection) => {
      const credentialVersionProjection = Boolean(projection?.credentialVersion);
      return {
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn(() => {
              if (credentialVersionProjection) {
                const credentialVersion = input.observedCredentialVersion
                  ?? input.rows[0]?.credentialVersion;
                return Promise.resolve(credentialVersion === undefined ? [] : [{ credentialVersion }]);
              }
              return {
                for: vi.fn(async () => [input.rows[Math.min(readIndex++, input.rows.length - 1)]]),
              };
            }),
          })),
        })),
      };
    }),
    update: vi.fn(() => ({
      set: vi.fn((values: TestRecord) => {
        input.updates?.push(values);
        return {
          where: vi.fn(() => ({
            returning: vi.fn(async () => input.updateResults?.[updateIndex++] ?? [{ credentialVersion: 2 }]),
          })),
        };
      }),
    })),
    delete: vi.fn(() => ({
      where: vi.fn(() => ({
        returning: vi.fn(async () => {
          const [deleted] = input.rows.splice(0, 1);
          if (deleted) input.deletions?.push({ id: deleted.id });
          return deleted ? [{ id: deleted.id }] : [];
        }),
      })),
    })),
  };
  return database;
}

type FakeDatabaseImplementation = ReturnType<typeof buildFakeDatabase>;

function fakeDatabase(input: FakeDatabaseInput): Db;
function fakeDatabase(input: FakeDatabaseInput): Db | FakeDatabaseImplementation {
  return buildFakeDatabase(input);
}

function camelEnvelope(value: TestRecord) {
  return {
    ciphertext: String(value.ciphertext),
    iv: String(value.iv),
    authTag: String(value.authTag),
    wrappedDek: String(value.wrappedDek),
    wrapIv: String(value.wrapIv),
    wrapAuthTag: String(value.wrapAuthTag),
    keyId: String(value.keyId),
  };
}
