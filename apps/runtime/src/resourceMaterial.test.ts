import { gzipSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import {
  encryptCompanionMcpRuntimeCredential,
  encryptOpaqueValue,
} from "@companion/core";
import { skillChecksum } from "@companion/skills";

import {
  collectRuntimeCredentialSensitiveValues,
  resolveRuntimeResources,
  RuntimeMaterialError,
} from "./resourceMaterial";

const orgId = "11111111-1111-4111-8111-111111111111";
const accountId = "22222222-2222-4222-8222-222222222222";
const generation = "33333333-3333-4333-8333-333333333333";
const masterKey = Buffer.alloc(32, 41);

describe("runtime material resolution", () => {
  it("collects exact provider and MCP plaintext only for the in-memory projection redactor", () => {
    const providerGeneration = "66666666-6666-4666-8666-666666666666";
    const providerSecret = "opaque-provider-value";
    const nestedProviderSecret = "opaque-nested-provider-value";
    const mcpSecret = "opaque-mcp-value";
    const providerEnvelope = encryptOpaqueValue({
      orgId,
      purpose: "companion-provider-credential",
      subjectId: `anthropic:${providerGeneration}`,
      value: JSON.stringify({
        type: "api_key",
        key: providerSecret,
        future_auth: { opaque: nestedProviderSecret },
      }),
    }, masterKey);
    const mcpEnvelope = encryptCompanionMcpRuntimeCredential({
      orgId,
      accountId,
      credentialGeneration: generation,
      credential: [{ env_key: "MCP_TOKEN", value: mcpSecret }],
    }, masterKey);

    const values = collectRuntimeCredentialSensitiveValues({
      orgId,
      masterKey,
      material: {
        providerMaterial: [{
          provider_id: "anthropic",
          auth_method: "api_key",
          credential_generation: providerGeneration,
          credential_version: 1,
          ...snakeEnvelope(providerEnvelope),
        }],
        skillMaterial: [],
        mcpMaterial: [{
          account_id: accountId,
          credential_generation: generation,
          account_config: {
            id: accountId,
            label: "Example",
            lifecycle: "lazy",
            direct_tools: false,
            transport: "stdio",
            command: "example-mcp",
            args: [],
            env: { TOKEN: "MCP_TOKEN" },
          },
          ...snakeEnvelope(mcpEnvelope),
        }],
      },
    });

    expect(values).toEqual(expect.arrayContaining([
      providerSecret,
      nestedProviderSecret,
      mcpSecret,
    ]));
    expect(values).not.toContain(providerEnvelope.ciphertext);
    expect(values).not.toContain(mcpEnvelope.ciphertext);
  });

  it("does not treat GitHub commit identity as a transcript secret", () => {
    const envelope = encryptCompanionMcpRuntimeCredential({
      orgId,
      accountId,
      credentialGeneration: generation,
      credential: {
        kind: "oauth",
        version: 1,
        serverName: "io.github.github/github-mcp-server",
        accessToken: "gho_secret",
        refreshToken: "refresh-secret",
        accessExpiresAt: "2030-01-01T00:00:00.000Z",
        scope: "repo",
        tokenType: "Bearer",
        tokenEndpoint: "https://github.com/login/oauth/access_token",
        resource: "https://api.githubcopilot.com/mcp/",
        client: {
          clientId: "github-client",
          clientSecret: null,
          tokenEndpointAuthMethod: "client_secret_post",
        },
        githubIdentity: {
          login: "stan",
          name: "Stan Girard",
          email: "stan@users.noreply.github.com",
        },
      },
    }, masterKey);

    const values = collectRuntimeCredentialSensitiveValues({
      orgId,
      masterKey,
      material: {
        providerMaterial: [],
        skillMaterial: [],
        mcpMaterial: [{
          account_id: accountId,
          credential_generation: generation,
          account_config: {
            id: accountId,
            label: "GitHub",
            lifecycle: "lazy",
            direct_tools: false,
            transport: "http",
            url: "https://api.githubcopilot.com/mcp/",
            headers: { Authorization: "GITHUB_MCP_AUTH" },
          },
          ...snakeEnvelope(envelope),
        }],
      },
    });

    expect(values).toEqual(expect.arrayContaining(["gho_secret", "refresh-secret"]));
    expect(values).not.toContain("stan");
    expect(values).not.toContain("Stan Girard");
    expect(values).not.toContain("stan@users.noreply.github.com");
    expect(values).not.toContain("github-client");
  });

  it("verifies Skill bytes and decrypts generation-pinned MCP environment credentials", async () => {
    const canonicalTar = Buffer.from("canonical tar bytes");
    const archive = gzipSync(canonicalTar);
    const envelope = encryptCompanionMcpRuntimeCredential({
      orgId,
      accountId,
      credentialGeneration: generation,
      credential: [{ env_key: "MCP_TOKEN", value: "sensitive-value" }],
    }, masterKey);
    const loadSkillArchive = vi.fn(async () => archive);

    const resources = await resolveRuntimeResources({
      orgId,
      masterKey,
      material: {
        providerMaterial: [],
        skillMaterial: [{
          skill_id: "44444444-4444-4444-8444-444444444444",
          version_id: "55555555-5555-4555-8555-555555555555",
          slug: "example-skill",
          version: "1.2.3",
          // Skill identity hashes the canonical tar, while size_bytes describes stored gzip bytes.
          checksum: skillChecksum(canonicalTar),
          size_bytes: archive.byteLength,
          storage_path: "org/skills/example.tar.gz",
        }],
        mcpMaterial: [{
          account_id: accountId,
          credential_generation: generation,
          account_config: {
            id: accountId,
            label: "Example",
            lifecycle: "lazy",
            direct_tools: false,
            transport: "stdio",
            command: "example-mcp",
            args: [],
            env: { TOKEN: "MCP_TOKEN" },
          },
          ...snakeEnvelope(envelope),
        }],
      },
      loadSkillArchive,
      signal: new AbortController().signal,
    });

    expect(loadSkillArchive).toHaveBeenCalledWith(
      "org/skills/example.tar.gz",
      expect.any(AbortSignal),
    );
    expect(resources.skills).toEqual([{
      slug: "example-skill",
      version: "1.2.3",
      checksum: expect.stringMatching(/^sha256:/),
      archive,
    }]);
    expect(resources.mcpCredentials).toEqual([{ env_key: "MCP_TOKEN", value: "sensitive-value" }]);
  });

  it("keeps OAuth access and refresh tokens out of staged credentials", async () => {
    const stored = {
      kind: "oauth" as const,
      version: 1 as const,
      serverName: "app.linear/linear" as const,
      accessToken: "old-token",
      refreshToken: "refresh-token",
      accessExpiresAt: "2027-01-01T00:00:00.000Z",
      scope: "read write",
      tokenType: "Bearer" as const,
      tokenEndpoint: "https://mcp.linear.app/token",
      resource: "https://mcp.linear.app/mcp",
      client: { clientId: "client", clientSecret: null, tokenEndpointAuthMethod: "none" as const },
    };
    const envelope = encryptCompanionMcpRuntimeCredential({
      orgId,
      accountId,
      credentialGeneration: generation,
      credential: stored,
    }, masterKey);
    const resources = await resolveRuntimeResources({
      orgId,
      masterKey,
      material: {
        providerMaterial: [],
        skillMaterial: [],
        mcpMaterial: [{
          account_id: accountId,
          credential_generation: generation,
          account_config: {
            id: accountId,
            label: "Linear",
            lifecycle: "lazy",
            direct_tools: false,
            transport: "http",
            url: "https://mcp.linear.app/mcp",
            headers: { Authorization: "LINEAR_AUTH" },
          },
          ...snakeEnvelope(envelope),
        }],
      },
      loadSkillArchive: vi.fn(),
      signal: new AbortController().signal,
    });

    expect(resources.mcpCredentials).toEqual([]);
    expect(resources.mcpAccounts).toEqual([{
      account: expect.objectContaining({ id: accountId, url: "https://mcp.linear.app/mcp" }),
      oauthBroker: { credentialGeneration: generation, github: false },
    }]);
    expect(JSON.stringify(resources)).not.toContain("old-token");
    expect(JSON.stringify(resources)).not.toContain("refresh-token");
    expect(resources.extraEnv).toEqual({});
  });

  it("marks Slack OAuth accounts for the product-owned loopback MCP bridge", async () => {
    const envelope = encryptCompanionMcpRuntimeCredential({
      orgId,
      accountId,
      credentialGeneration: generation,
      credential: {
        kind: "oauth",
        version: 1,
        serverName: "com.slack/mcp",
        accessToken: "xoxb-secret",
        refreshToken: "xoxe-refresh",
        accessExpiresAt: "2030-01-01T00:00:00.000Z",
        scope: "chat:write",
        tokenType: "Bearer",
        tokenEndpoint: "https://slack.com/api/oauth.v2.access",
        resource: "https://slack.com/api/chat.postMessage",
        client: {
          clientId: "slack-client",
          clientSecret: null,
          tokenEndpointAuthMethod: "client_secret_basic",
        },
      },
    }, masterKey);
    const resources = await resolveRuntimeResources({
      orgId,
      masterKey,
      material: {
        providerMaterial: [],
        skillMaterial: [],
        mcpMaterial: [{
          account_id: accountId,
          credential_generation: generation,
          account_config: {
            id: accountId,
            label: "Slack work",
            lifecycle: "lazy",
            direct_tools: false,
            transport: "http",
            url: "https://slack.com/api/chat.postMessage",
            headers: { Authorization: "SLACK_AUTH" },
          },
          ...snakeEnvelope(envelope),
        }],
      },
      loadSkillArchive: vi.fn(),
      signal: new AbortController().signal,
    });

    expect(resources.mcpAccounts).toEqual([{
      account: expect.objectContaining({ id: accountId, label: "Slack work" }),
      oauthBroker: { credentialGeneration: generation, github: false, slack: true },
    }]);
    expect(JSON.stringify(resources)).not.toContain("xoxb-secret");
    expect(resources.mcpCredentials).toEqual([]);
  });

  it("stages Gmail OAuth with the read-and-draft tool allow-list", async () => {
    const stored = {
      kind: "oauth" as const,
      version: 1 as const,
      serverName: "com.google.workspace/gmail" as const,
      accessToken: "gmail-access",
      refreshToken: "gmail-refresh",
      accessExpiresAt: "2030-01-01T00:00:00.000Z",
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
    const envelope = encryptCompanionMcpRuntimeCredential({
      orgId,
      accountId,
      credentialGeneration: generation,
      credential: stored,
    }, masterKey);
    const resources = await resolveRuntimeResources({
      orgId,
      masterKey,
      material: {
        providerMaterial: [],
        skillMaterial: [],
        mcpMaterial: [{
          account_id: accountId,
          credential_generation: generation,
          account_config: {
            id: accountId,
            label: "Gmail work",
            lifecycle: "lazy",
            direct_tools: false,
            transport: "http",
            url: "https://gmailmcp.googleapis.com/mcp/v1",
            headers: { Authorization: "GMAIL_MCP_AUTH" },
          },
          ...snakeEnvelope(envelope),
        }],
      },
      loadSkillArchive: vi.fn(),
      signal: new AbortController().signal,
    });

    expect(resources.mcpAccounts).toEqual([{
      account: expect.objectContaining({ id: accountId }),
      oauthBroker: {
        credentialGeneration: generation,
        github: false,
        allowedTools: [
          "create_draft",
          "get_message",
          "get_thread",
          "list_drafts",
          "list_labels",
          "search_threads",
        ],
      },
    }]);
    expect(JSON.stringify(resources)).not.toContain("gmail-access");
    expect(JSON.stringify(resources)).not.toContain("gmail-refresh");
  });

  it("stages GitHub OAuth as a broker account plus token-free Git and gh metadata", async () => {
    const stored = {
      kind: "oauth" as const,
      version: 1 as const,
      serverName: "io.github.github/github-mcp-server" as const,
      accessToken: "gho_secret",
      refreshToken: "refresh-token",
      accessExpiresAt: "2030-01-01T00:00:00.000Z",
      scope: "repo read:user user:email",
      tokenType: "Bearer" as const,
      tokenEndpoint: "https://github.com/login/oauth/access_token",
      resource: "https://api.githubcopilot.com/mcp/",
      client: {
        clientId: "github-client",
        clientSecret: null,
        tokenEndpointAuthMethod: "client_secret_post" as const,
      },
      githubIdentity: {
        login: "stan",
        name: "Stan Girard",
        email: "stan@users.noreply.github.com",
      },
    };
    const envelope = encryptCompanionMcpRuntimeCredential({
      orgId,
      accountId,
      credentialGeneration: generation,
      credential: stored,
    }, masterKey);

    const resources = await resolveRuntimeResources({
      orgId,
      masterKey,
      material: {
        providerMaterial: [],
        skillMaterial: [],
        mcpMaterial: [{
          account_id: accountId,
          credential_generation: generation,
          account_config: {
            id: accountId,
            label: "GitHub work",
            lifecycle: "lazy",
            direct_tools: false,
            transport: "http",
            url: "https://api.githubcopilot.com/mcp/",
            headers: { Authorization: "GITHUB_MCP_AUTH" },
          },
          ...snakeEnvelope(envelope),
        }],
      },
      loadSkillArchive: vi.fn(),
      signal: new AbortController().signal,
    });

    expect(resources.mcpCredentials).toEqual([]);
    expect(resources.mcpAccounts).toEqual([{
      account: expect.objectContaining({ id: accountId }),
      oauthBroker: { credentialGeneration: generation, github: true },
    }]);
    expect(resources.extraEnv).toEqual({
      COMPANION_GITHUB_MCP_ACCOUNT_ID: accountId,
      GIT_TERMINAL_PROMPT: "0",
      GH_PROMPT_DISABLED: "1",
      GIT_AUTHOR_NAME: "Stan Girard",
      GIT_AUTHOR_EMAIL: "stan@users.noreply.github.com",
      GIT_COMMITTER_NAME: "Stan Girard",
      GIT_COMMITTER_EMAIL: "stan@users.noreply.github.com",
    });
  });

  it("does not use an access token to look up missing GitHub identity during staging", async () => {
    const stored = {
      kind: "oauth" as const,
      version: 1 as const,
      serverName: "io.github.github/github-mcp-server" as const,
      accessToken: "gho_secret",
      refreshToken: "refresh-token",
      accessExpiresAt: "2030-01-01T00:00:00.000Z",
      scope: "repo",
      tokenType: "Bearer" as const,
      tokenEndpoint: "https://github.com/login/oauth/access_token",
      resource: "https://api.githubcopilot.com/mcp/",
      client: {
        clientId: "github-client",
        clientSecret: null,
        tokenEndpointAuthMethod: "client_secret_post" as const,
      },
    };
    const envelope = encryptCompanionMcpRuntimeCredential({
      orgId,
      accountId,
      credentialGeneration: generation,
      credential: stored,
    }, masterKey);
    const resources = await resolveRuntimeResources({
      orgId,
      masterKey,
      material: {
        providerMaterial: [],
        skillMaterial: [],
        mcpMaterial: [{
          account_id: accountId,
          credential_generation: generation,
          account_config: {
            id: accountId,
            label: "GitHub work",
            lifecycle: "lazy",
            direct_tools: false,
            transport: "http",
            url: "https://api.githubcopilot.com/mcp/",
            headers: { Authorization: "GITHUB_MCP_AUTH" },
          },
          ...snakeEnvelope(envelope),
        }],
      },
      loadSkillArchive: vi.fn(),
      signal: new AbortController().signal,
    });

    expect(resources.mcpCredentials).toEqual([]);
    expect(resources.extraEnv).toEqual({
      COMPANION_GITHUB_MCP_ACCOUNT_ID: accountId,
      GIT_TERMINAL_PROMPT: "0",
      GH_PROMPT_DISABLED: "1",
    });
  });

  it("still enables token-on-demand Git and gh when GitHub identity is unavailable", async () => {
    const stored = {
      kind: "oauth" as const,
      version: 1 as const,
      serverName: "io.github.github/github-mcp-server" as const,
      accessToken: "gho_secret",
      refreshToken: "refresh-token",
      accessExpiresAt: "2030-01-01T00:00:00.000Z",
      scope: "repo",
      tokenType: "Bearer" as const,
      tokenEndpoint: "https://github.com/login/oauth/access_token",
      resource: "https://api.githubcopilot.com/mcp/",
      client: {
        clientId: "github-client",
        clientSecret: null,
        tokenEndpointAuthMethod: "client_secret_post" as const,
      },
    };
    const envelope = encryptCompanionMcpRuntimeCredential({
      orgId,
      accountId,
      credentialGeneration: generation,
      credential: stored,
    }, masterKey);

    const resources = await resolveRuntimeResources({
      orgId,
      masterKey,
      material: {
        providerMaterial: [],
        skillMaterial: [],
        mcpMaterial: [{
          account_id: accountId,
          credential_generation: generation,
          account_config: {
            id: accountId,
            label: "GitHub work",
            lifecycle: "lazy",
            direct_tools: false,
            transport: "http",
            url: "https://api.githubcopilot.com/mcp/",
            headers: { Authorization: "GITHUB_MCP_AUTH" },
          },
          ...snakeEnvelope(envelope),
        }],
      },
      loadSkillArchive: vi.fn(),
      signal: new AbortController().signal,
    });

    expect(resources.mcpCredentials).toEqual([]);
    expect(resources.extraEnv).toEqual({
      COMPANION_GITHUB_MCP_ACCOUNT_ID: accountId,
      GIT_TERMINAL_PROMPT: "0",
      GH_PROMPT_DISABLED: "1",
    });
  });

  it("does not bind git/gh when two GitHub OAuth accounts are selected", async () => {
    const secondAccountId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const secondGeneration = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    function githubStored(accessToken: string) {
      return {
        kind: "oauth" as const,
        version: 1 as const,
        serverName: "io.github.github/github-mcp-server" as const,
        accessToken,
        refreshToken: "refresh-token",
        accessExpiresAt: "2030-01-01T00:00:00.000Z",
        scope: "repo",
        tokenType: "Bearer" as const,
        tokenEndpoint: "https://github.com/login/oauth/access_token",
        resource: "https://api.githubcopilot.com/mcp/",
        client: {
          clientId: "github-client",
          clientSecret: null,
          tokenEndpointAuthMethod: "client_secret_post" as const,
        },
      };
    }
    const firstEnvelope = encryptCompanionMcpRuntimeCredential({
      orgId,
      accountId,
      credentialGeneration: generation,
      credential: githubStored("gho_personal"),
    }, masterKey);
    const secondEnvelope = encryptCompanionMcpRuntimeCredential({
      orgId,
      accountId: secondAccountId,
      credentialGeneration: secondGeneration,
      credential: githubStored("gho_work"),
    }, masterKey);

    const resources = await resolveRuntimeResources({
      orgId,
      masterKey,
      material: {
        providerMaterial: [],
        skillMaterial: [],
        mcpMaterial: [
          {
            account_id: accountId,
            credential_generation: generation,
            account_config: {
              id: accountId,
              label: "GitHub personal",
              lifecycle: "lazy",
              direct_tools: false,
              transport: "http",
              url: "https://api.githubcopilot.com/mcp/",
              headers: { Authorization: "GITHUB_PERSONAL" },
            },
            ...snakeEnvelope(firstEnvelope),
          },
          {
            account_id: secondAccountId,
            credential_generation: secondGeneration,
            account_config: {
              id: secondAccountId,
              label: "GitHub work",
              lifecycle: "lazy",
              direct_tools: false,
              transport: "http",
              url: "https://api.githubcopilot.com/mcp/",
              headers: { Authorization: "GITHUB_WORK" },
            },
            ...snakeEnvelope(secondEnvelope),
          },
        ],
      },
      loadSkillArchive: vi.fn(),
      signal: new AbortController().signal,
    });

    expect(resources.mcpCredentials).toEqual([]);
    expect(resources.mcpAccounts).toEqual([
      expect.objectContaining({ oauthBroker: { credentialGeneration: generation, github: true } }),
      expect.objectContaining({ oauthBroker: { credentialGeneration: secondGeneration, github: true } }),
    ]);
    expect(resources.extraEnv).toEqual({});
  });

  it("collapses storage and malformed-row details to fixed safe errors", async () => {
    const secretPath = "signed://secret-storage-path?token=never-return";
    const loadSkillArchive = vi.fn(async () => { throw new Error(secretPath); });
    let error: unknown;
    try {
      await resolveRuntimeResources({
        orgId,
        masterKey,
        material: {
          providerMaterial: [],
          mcpMaterial: [],
          skillMaterial: [{
            skill_id: "44444444-4444-4444-8444-444444444444",
            version_id: "55555555-5555-4555-8555-555555555555",
            slug: "example",
            version: "1.0.0",
            checksum: `sha256:${"0".repeat(64)}`,
            size_bytes: 10,
            storage_path: secretPath,
          }],
        },
        loadSkillArchive,
        signal: new AbortController().signal,
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(RuntimeMaterialError);
    expect(String(error)).not.toContain(secretPath);
    expect(loadSkillArchive).toHaveBeenCalledWith(secretPath, expect.any(AbortSignal));
  });

  it("keeps local provider and MCP validation failures terminal", async () => {
    const providerGeneration = "66666666-6666-4666-8666-666666666666";
    const providerEnvelope = encryptOpaqueValue({
      orgId,
      purpose: "companion-provider-credential",
      subjectId: `anthropic:${providerGeneration}`,
      value: JSON.stringify({ type: "api_key", key: "provider-secret" }),
    }, masterKey);
    const mcpEnvelope = encryptCompanionMcpRuntimeCredential({
      orgId,
      accountId,
      credentialGeneration: generation,
      credential: [{ env_key: "MCP_TOKEN", value: "mcp-secret" }],
    }, masterKey);
    const resolve = async (material: Parameters<typeof resolveRuntimeResources>[0]["material"]) =>
      await resolveRuntimeResources({
        orgId,
        masterKey,
        material,
        loadSkillArchive: vi.fn(),
        signal: new AbortController().signal,
      });

    await expect(resolve({
      providerMaterial: [{
        provider_id: "anthropic",
        auth_method: "oauth",
        credential_generation: providerGeneration,
        credential_version: 1,
        ...snakeEnvelope(providerEnvelope),
      }],
      skillMaterial: [],
      mcpMaterial: [],
    })).rejects.toBeInstanceOf(RuntimeMaterialError);

    await expect(resolve({
      providerMaterial: [],
      skillMaterial: [],
      mcpMaterial: [{
        account_id: accountId,
        credential_generation: generation,
        account_config: {
          id: "77777777-7777-4777-8777-777777777777",
          label: "Mismatched account",
          lifecycle: "lazy",
          direct_tools: false,
          transport: "stdio",
          command: "example-mcp",
          args: [],
          env: { TOKEN: "MCP_TOKEN" },
        },
        ...snakeEnvelope(mcpEnvelope),
      }],
    })).rejects.toBeInstanceOf(RuntimeMaterialError);

    await expect(resolve({
      providerMaterial: [],
      skillMaterial: [],
      mcpMaterial: [{
        account_id: accountId,
        credential_generation: generation,
        account_config: { id: accountId, transport: "invalid" },
        ...snakeEnvelope(mcpEnvelope),
      }],
    })).rejects.toBeInstanceOf(RuntimeMaterialError);
  });
});

function snakeEnvelope(envelope: {
  ciphertext: string;
  iv: string;
  authTag: string;
  wrappedDek: string;
  wrapIv: string;
  wrapAuthTag: string;
  keyId: string;
}) {
  return {
    ciphertext: envelope.ciphertext,
    iv: envelope.iv,
    auth_tag: envelope.authTag,
    wrapped_dek: envelope.wrappedDek,
    wrap_iv: envelope.wrapIv,
    wrap_auth_tag: envelope.wrapAuthTag,
    key_id: envelope.keyId,
  };
}
