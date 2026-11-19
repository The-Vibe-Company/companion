import { describe, expect, it } from "bun:test";
import { pluginCatalog } from "./catalog";
import {
  appDefinitions,
  getAppDefinition,
  getAppDefinitionByProvider,
} from "./definitions";

describe("declarative App definitions", () => {
  it("holds identity, display, MCP, OAuth and safe runtime metadata for all curated Apps", () => {
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
      { id: "app.linear/linear", provider: "linear", name: "Linear", transport: "http", url: "https://mcp.linear.app/mcp", adapter: "standard", client: "dynamic", capabilities: undefined },
      { id: "io.github.github/github-mcp-server", provider: "github", name: "GitHub", transport: "http", url: "https://api.githubcopilot.com/mcp/", adapter: "github", client: "environment", capabilities: { gitCredentials: true } },
      { id: "com.notion/mcp", provider: "notion", name: "Notion", transport: "http", url: "https://mcp.notion.com/mcp", adapter: "standard", client: "dynamic", capabilities: undefined },
      { id: "build.conductor/mcp", provider: "conductor", name: "Conductor", transport: "http", url: "https://api.conductor.build/mcp", adapter: "standard", client: "dynamic", capabilities: undefined },
      { id: "com.slack/mcp", provider: "slack", name: "Slack", transport: "slack", url: "https://slack.com/api/chat.postMessage", adapter: "slack", client: "environment", capabilities: { bridge: "slack" } },
      { id: "com.google.workspace/gmail", provider: "gmail", name: "Gmail", transport: "http", url: "https://gmailmcp.googleapis.com/mcp/v1", adapter: "gmail", client: "environment", capabilities: { allowedTools: ["create_draft", "get_message", "get_thread", "list_drafts", "list_labels", "search_threads"] } },
      { id: "io.sentry/mcp", provider: "sentry", name: "Sentry", transport: "http", url: "https://mcp.sentry.dev/mcp", adapter: "standard", client: "dynamic", capabilities: undefined },
      { id: "com.railway/mcp", provider: "railway", name: "Railway", transport: "http", url: "https://mcp.railway.com", adapter: "standard", client: "dynamic", capabilities: undefined },
      { id: "app.skillpack/mcp", provider: "skillpack", name: "Skillpack", transport: "http", url: "https://skillpack.app/mcp", adapter: "standard", client: "dynamic", capabilities: undefined },
    ]);
  });

  it("forces Skillpack's consent screen, where the member picks the workspace the connection acts in", () => {
    const skillpack = getAppDefinition("app.skillpack/mcp");
    expect(skillpack?.oauth.authorizationParams).toEqual({ prompt: "consent" });
    expect(skillpack?.oauth.scopes).toEqual(["openid", "offline_access"]);
    expect(skillpack?.oauth.authorizationServer).toBe("https://skillpack.app");
    expect(skillpack?.oauth.allowedOrigins).toEqual(["https://skillpack.app"]);
  });

  it("derives compatibility catalog rows and centralized provider fallbacks", () => {
    expect(pluginCatalog.filter((entry) => entry.kind !== "remote")).toHaveLength(appDefinitions.length);
    expect(pluginCatalog.find((entry) => entry.id === "com.railway/mcp")).toMatchObject({
      provider: "railway",
      name: "Railway",
      transport: "http",
      url: "https://mcp.railway.com",
    });
    expect(getAppDefinition("com.google.workspace/gmail")?.capabilities?.allowedTools).toHaveLength(6);
    expect(getAppDefinitionByProvider("github")?.capabilities?.gitCredentials).toBe(true);
    expect(getAppDefinitionByProvider("unknown")).toBeUndefined();
  });

  it("declares deployment configuration keys without reading process environment", () => {
    expect(getAppDefinition("io.github.github/github-mcp-server")?.oauth.client).toEqual({
      kind: "environment",
      clientIdEnv: "COMPANION_MCP_GITHUB_CLIENT_ID",
      clientSecretEnv: "COMPANION_MCP_GITHUB_CLIENT_SECRET",
      tokenEndpointAuthMethod: "client_secret_post",
    });
    expect(getAppDefinition("com.google.workspace/gmail")?.oauth.client).toMatchObject({
      clientIdEnv: "COMPANION_MCP_GMAIL_CLIENT_ID",
      clientSecretEnv: "COMPANION_MCP_GMAIL_CLIENT_SECRET",
    });
    expect(getAppDefinition("com.slack/mcp")?.oauth.client).toMatchObject({
      clientIdEnv: "COMPANION_MCP_SLACK_CLIENT_ID",
      clientSecretEnv: "COMPANION_MCP_SLACK_CLIENT_SECRET",
    });
  });
});
