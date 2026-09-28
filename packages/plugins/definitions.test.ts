import { describe, expect, it } from "bun:test";
import {
  appDefinitions,
  featuredComposioToolkits,
  getAppDefinition,
  getAppDefinitionByProvider,
} from "./definitions";

describe("native App definitions", () => {
  it("keeps GitHub as the only native definition, used solely for git credentials", () => {
    expect(appDefinitions.map((definition) => ({
      id: definition.id,
      provider: definition.provider,
      name: definition.name,
      transport: definition.mcp.transport,
      url: definition.mcp.url,
      adapter: definition.oauth.adapter,
      client: definition.oauth.client.kind,
      capabilities: definition.capabilities,
    }))).toEqual([
      {
        id: "io.github.github/github-mcp-server",
        provider: "github",
        name: "GitHub (git access)",
        transport: "http",
        url: "https://api.githubcopilot.com/mcp/",
        adapter: "github",
        client: "environment",
        capabilities: { gitCredentials: true },
      },
    ]);
  });

  it("looks definitions up by id and provider", () => {
    expect(getAppDefinition("io.github.github/github-mcp-server")?.provider).toBe("github");
    expect(getAppDefinitionByProvider("github")?.id).toBe("io.github.github/github-mcp-server");
    expect(getAppDefinitionByProvider("github")?.capabilities.gitCredentials).toBe(true);
    expect(getAppDefinitionByProvider("unknown")).toBeUndefined();
    expect(getAppDefinitionByProvider("linear")).toBeUndefined();
    expect(getAppDefinition("app.linear/linear")).toBeUndefined();
  });

  it("requests git access scopes without repository webhook administration", () => {
    const scopes = getAppDefinitionByProvider("github")?.oauth.scopes;
    expect(scopes).toEqual(["repo", "read:org", "read:user", "user:email"]);
    expect(scopes).not.toContain("admin:repo_hook");
  });

  it("declares deployment configuration keys without reading process environment", () => {
    expect(getAppDefinition("io.github.github/github-mcp-server")?.oauth.client).toEqual({
      kind: "environment",
      clientIdEnv: "COMPANION_MCP_GITHUB_CLIENT_ID",
      clientSecretEnv: "COMPANION_MCP_GITHUB_CLIENT_SECRET",
      tokenEndpointAuthMethod: "client_secret_post",
    });
  });

  it("features a non-empty list of unique lowercase Composio toolkit slugs", () => {
    expect(featuredComposioToolkits.length).toBeGreaterThan(0);
    expect(new Set(featuredComposioToolkits).size).toBe(featuredComposioToolkits.length);
    for (const slug of featuredComposioToolkits) {
      expect(slug).toMatch(/^[a-z0-9_]+$/);
    }
  });
});
