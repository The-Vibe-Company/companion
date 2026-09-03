import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CompanionPluginOAuthRevokedError,
  CompanionNotFoundError,
  CompanionPluginConflictError,
  createCompanionWithRuntime,
  deleteCompanionPlugin,
  issueCompanionMcpAccessToken,
  listCompanionPlugins,
  saveCompanionProvider,
  saveCompanionOAuthPlugin,
  saveCompanionPlugin,
} from "@companion/core";
import { schema, withTenantContext } from "@companion/db";
import {
  createIntegrationFixture,
  integrationDb,
  integrationSql,
  type IntegrationFixture,
} from "./testDatabase";

/** MCP connections are member-private control-plane records; plaintext only crosses the write. */
describe("member-private Companion MCP connections", () => {
  let fixture: IntegrationFixture;
  const masterKey = Buffer.alloc(32, 17);

  beforeEach(async () => {
    fixture = await createIntegrationFixture();
  });

  afterEach(async () => {
    await integrationDb.delete(schema.companions).where(eq(schema.companions.orgId, fixture.orgA));
    await fixture.cleanup();
  });

  afterAll(async () => {
    await integrationSql.end();
  });

  it("stores a credential encrypted and never returns it from create or list", async () => {
    const plaintext = "Bearer plugin-secret-value";
    const account = await saveCompanionPlugin({
      actor: fixture.developer,
      orgId: fixture.orgA,
      plugin: {
        provider: "github",
        label: "work",
        transport: "http",
        url: "https://mcp.example.test/github",
        args: [],
        credential_name: "Authorization",
        credential_value: plaintext,
      },
      masterKey,
      database: integrationDb,
    });

    expect(account).toMatchObject({
      provider: "github",
      label: "work",
      transport: "http",
      connected: true,
    });
    expect(JSON.stringify(account)).not.toContain(plaintext);

    const stored = await integrationDb.query.companionMcpAccounts.findFirst({
      where: and(
        eq(schema.companionMcpAccounts.orgId, fixture.orgA),
        eq(schema.companionMcpAccounts.id, account.id),
      ),
    });
    expect(stored).toBeDefined();
    expect(stored?.ciphertext).not.toBe(plaintext);
    expect(JSON.stringify(stored)).not.toContain(plaintext);
    expect(JSON.stringify(stored?.accountConfig)).toContain("COMPANION_MCP_");

    const listed = await listCompanionPlugins({
      actor: fixture.developer,
      orgId: fixture.orgA,
      database: integrationDb,
    });
    expect(listed).toEqual([expect.objectContaining({ id: account.id, label: "work" })]);
    expect(JSON.stringify(listed)).not.toContain(plaintext);
  });

  it("stores a labeled Gmail OAuth account without exposing either token", async () => {
    const account = await saveCompanionOAuthPlugin({
      actor: fixture.developer,
      orgId: fixture.orgA,
      provider: "gmail",
      label: "work",
      remoteUrl: "https://gmailmcp.googleapis.com/mcp/v1",
      credential: {
        kind: "oauth",
        version: 1,
        serverName: "com.google.workspace/gmail",
        accessToken: "gmail-access-secret",
        refreshToken: "gmail-refresh-secret",
        accessExpiresAt: "2030-01-01T00:00:00.000Z",
        scope: "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.compose",
        tokenType: "Bearer",
        tokenEndpoint: "https://oauth2.googleapis.com/token",
        resource: "https://gmailmcp.googleapis.com/mcp/v1",
        client: {
          clientId: "gmail-client",
          clientSecret: null,
          tokenEndpointAuthMethod: "client_secret_post",
        },
      },
      masterKey,
      database: integrationDb,
    });

    expect(account).toMatchObject({ provider: "gmail", label: "work", connected: true });
    const listed = await listCompanionPlugins({
      actor: fixture.developer,
      orgId: fixture.orgA,
      database: integrationDb,
    });
    expect(listed).toEqual([expect.objectContaining({ id: account.id, provider: "gmail" })]);
    expect(JSON.stringify([account, listed])).not.toContain("gmail-access-secret");
    expect(JSON.stringify([account, listed])).not.toContain("gmail-refresh-secret");

    const stored = await integrationDb.query.companionMcpAccounts.findFirst({
      where: eq(schema.companionMcpAccounts.id, account.id),
    });
    expect(stored?.accountConfig).toMatchObject({
      transport: "http",
      url: "https://gmailmcp.googleapis.com/mcp/v1",
    });
    expect(JSON.stringify(stored)).not.toContain("gmail-access-secret");
    expect(JSON.stringify(stored)).not.toContain("gmail-refresh-secret");
  });

  it("commits exact Gmail credential deletion after Google confirms invalid_grant", async () => {
    await saveCompanionProvider({
      actor: fixture.owner,
      orgId: fixture.orgA,
      providerId: "anthropic",
      authMethod: "api_key",
      credential: "integration-provider-secret",
      masterKey,
      database: integrationDb,
    });
    const target = await saveCompanionOAuthPlugin({
      actor: fixture.owner,
      orgId: fixture.orgA,
      provider: "gmail",
      label: "revoked",
      remoteUrl: "https://gmailmcp.googleapis.com/mcp/v1",
      credential: gmailCredential("expired-access", "revoked-refresh"),
      masterKey,
      database: integrationDb,
    });
    const retained = await saveCompanionOAuthPlugin({
      actor: fixture.owner,
      orgId: fixture.orgA,
      provider: "gmail",
      label: "retained",
      remoteUrl: "https://gmailmcp.googleapis.com/mcp/v1",
      credential: gmailCredential("retained-access", "retained-refresh"),
      masterKey,
      database: integrationDb,
    });
    const companion = await withTenantContext({
      orgId: fixture.orgA,
      userId: fixture.owner.id,
    }, async (database) => await createCompanionWithRuntime({
      actor: fixture.owner,
      orgId: fixture.orgA,
      name: "Revocation verifier",
      providerId: "anthropic",
      modelId: "claude-opus-4-8",
      selectedMcpAccountIds: [target.id],
      database,
    }));
    const targetRow = await integrationDb.query.companionMcpAccounts.findFirst({
      where: eq(schema.companionMcpAccounts.id, target.id),
    });
    expect(targetRow).toBeDefined();

    const outcome = await withTenantContext({
      orgId: fixture.orgA,
      userId: fixture.owner.id,
    }, async (database) => await issueCompanionMcpAccessToken({
      authorization: {
        orgId: fixture.orgA,
        companionId: companion.id,
        actorId: fixture.owner.id,
        accountRefs: [{
          account_id: target.id,
          credential_generation: targetRow!.credentialGeneration,
        }],
      },
      accountId: target.id,
      credentialGeneration: targetRow!.credentialGeneration,
      forceRefresh: true,
      masterKey,
      database,
      refreshOauth: async () => { throw new CompanionPluginOAuthRevokedError(); },
    }));

    expect(outcome).toBeNull();
    expect(await integrationDb.query.companionMcpAccounts.findFirst({
      where: eq(schema.companionMcpAccounts.id, target.id),
    })).toBeUndefined();
    expect(await integrationDb.query.companionMcpAccounts.findFirst({
      where: eq(schema.companionMcpAccounts.id, retained.id),
    })).toBeDefined();
  });

  it("keeps connections private from admins and cross-tenant actors", async () => {
    const account = await saveCompanionPlugin({
      actor: fixture.developer,
      orgId: fixture.orgA,
      plugin: {
        provider: "github",
        label: "private",
        transport: "http",
        url: "https://mcp.example.test/private",
        args: [],
      },
      masterKey,
      database: integrationDb,
    });

    await expect(listCompanionPlugins({
      actor: fixture.admin,
      orgId: fixture.orgA,
      database: integrationDb,
    })).resolves.toEqual([]);
    await expect(listCompanionPlugins({
      actor: fixture.outsider,
      orgId: fixture.orgA,
      database: integrationDb,
    })).rejects.toThrow("not a member");

    await expect(deleteCompanionPlugin({
      actor: fixture.admin,
      orgId: fixture.orgA,
      accountId: account.id,
      database: integrationDb,
    })).rejects.toBeInstanceOf(CompanionNotFoundError);
    await expect(deleteCompanionPlugin({
      actor: fixture.outsider,
      orgId: fixture.orgA,
      accountId: account.id,
      database: integrationDb,
    })).rejects.toThrow("not a member");

    expect(await integrationDb.query.companionMcpAccounts.findFirst({
      where: eq(schema.companionMcpAccounts.id, account.id),
    })).toBeDefined();
  });

  it("rejects case-insensitive label collisions and lets the owner delete the account", async () => {
    const account = await saveCompanionPlugin({
      actor: fixture.developer,
      orgId: fixture.orgA,
      plugin: {
        provider: "github",
        label: "work",
        transport: "stdio",
        command: "github-mcp",
        args: ["serve"],
      },
      masterKey,
      database: integrationDb,
    });

    await expect(saveCompanionPlugin({
      actor: fixture.developer,
      orgId: fixture.orgA,
      plugin: {
        provider: "github",
        label: "WORK",
        transport: "http",
        url: "https://mcp.example.test/duplicate",
        args: [],
      },
      masterKey,
      database: integrationDb,
    })).rejects.toBeInstanceOf(CompanionPluginConflictError);

    await deleteCompanionPlugin({
      actor: fixture.developer,
      orgId: fixture.orgA,
      accountId: account.id,
      database: integrationDb,
    });
    await expect(listCompanionPlugins({
      actor: fixture.developer,
      orgId: fixture.orgA,
      database: integrationDb,
    })).resolves.toEqual([]);
    expect(await integrationDb.query.companionMcpAccounts.findFirst({
      where: eq(schema.companionMcpAccounts.id, account.id),
    })).toBeUndefined();
  });
});

function gmailCredential(accessToken: string, refreshToken: string) {
  return {
    kind: "oauth" as const,
    version: 1 as const,
    serverName: "com.google.workspace/gmail" as const,
    accessToken,
    refreshToken,
    accessExpiresAt: "2020-01-01T00:00:00.000Z",
    scope: "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.compose",
    tokenType: "Bearer" as const,
    tokenEndpoint: "https://oauth2.googleapis.com/token",
    resource: "https://gmailmcp.googleapis.com/mcp/v1",
    client: {
      clientId: "gmail-client",
      clientSecret: null,
      tokenEndpointAuthMethod: "client_secret_post" as const,
    },
  };
}
