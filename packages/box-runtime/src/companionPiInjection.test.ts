import { describe, expect, it } from "vitest";
import {
  buildMcpAdapterInjection,
  companionGitCredentialHelperInstallCommand,
  COMPANION_GH_WRAPPER_SOURCE,
  COMPANION_GIT_CREDENTIAL_HELPER_PATH,
  COMPANION_GIT_CREDENTIAL_HELPER_SOURCE,
} from "./companionPiInjection";

describe("Pi MCP injection", () => {
  it("keeps labeled accounts distinct and writes only environment references", () => {
    const injected = buildMcpAdapterInjection([
      {
        id: "github-personal",
        label: "GitHub personal",
        transport: "http",
        url: "https://mcp.example.test/github",
        headers: { Authorization: "GITHUB_PERSONAL_TOKEN" },
        lifecycle: "lazy",
        direct_tools: false,
      },
      {
        id: "github-work",
        label: "GitHub work",
        transport: "stdio",
        command: "github-mcp-server",
        args: ["stdio"],
        env: { GITHUB_TOKEN: "GITHUB_WORK_TOKEN" },
        lifecycle: "keep-alive",
        direct_tools: ["search_repositories"],
      },
    ]);

    expect(injected.accounts).toEqual([
      expect.objectContaining({ id: "github-personal", label: "GitHub personal", transport: "http" }),
      expect.objectContaining({ id: "github-work", label: "GitHub work", transport: "stdio" }),
    ]);
    expect(new Set(injected.accounts.map((account) => account.adapter_name)).size).toBe(2);
    const serialized = JSON.stringify(injected.config);
    expect(serialized).toContain("${GITHUB_PERSONAL_TOKEN}");
    expect(serialized).toContain("${GITHUB_WORK_TOKEN}");
    expect(serialized).not.toContain("secret-value");
    expect(injected.config.settings).toMatchObject({
      hostConfigDiscovery: "off",
      sampling: false,
      elicitation: false,
    });
  });

  it("routes OAuth HTTP accounts through the loopback gateway without durable headers", () => {
    const accountId = "11111111-1111-4111-8111-111111111111";
    const credentialGeneration = "22222222-2222-4222-8222-222222222222";
    const injected = buildMcpAdapterInjection([{
      account: {
        id: accountId,
        label: "GitHub",
        transport: "http",
        url: "https://api.githubcopilot.com/mcp/",
        headers: { Authorization: "GITHUB_MCP_AUTH" },
        lifecycle: "lazy",
        direct_tools: false,
      },
      oauthBroker: { credentialGeneration, github: true },
    }]);

    expect(Object.values(injected.config.mcpServers)[0]).toMatchObject({
      url: `\${COMPANION_MCP_GATEWAY_ORIGIN}/mcp/${accountId}`,
      headers: {},
    });
    expect(injected.gatewayAccounts).toEqual([{
      accountId,
      credentialGeneration,
      upstreamUrl: "https://api.githubcopilot.com/mcp/",
      github: true,
    }]);
    expect(JSON.stringify(injected)).not.toContain("GITHUB_MCP_AUTH");
  });

  it("mounts the product-owned control MCP as an eager direct loopback server", () => {
    const injected = buildMcpAdapterInjection([], true);
    expect(injected.config.mcpServers["companion-control"]).toMatchObject({
      url: "${COMPANION_MCP_GATEWAY_ORIGIN}/control",
      lifecycle: "eager",
      directTools: true,
    });
    expect(injected.gatewayAccounts).toEqual([]);
  });

  it("passes a Gmail tool allow-list to the loopback gateway", () => {
    const accountId = "11111111-1111-4111-8111-111111111111";
    const credentialGeneration = "22222222-2222-4222-8222-222222222222";
    const allowedTools = ["search_threads", "get_message", "create_draft"];
    const injected = buildMcpAdapterInjection([{
      account: {
        id: accountId,
        label: "Gmail work",
        transport: "http",
        url: "https://gmailmcp.googleapis.com/mcp/v1",
        headers: { Authorization: "GMAIL_MCP_AUTH" },
        lifecycle: "lazy",
        direct_tools: false,
      },
      oauthBroker: { credentialGeneration, github: false, allowedTools },
    }]);

    expect(injected.gatewayAccounts).toEqual([{
      accountId,
      credentialGeneration,
      upstreamUrl: "https://gmailmcp.googleapis.com/mcp/v1",
      github: false,
      allowedTools,
    }]);
    expect(JSON.stringify(injected)).not.toContain("GMAIL_MCP_AUTH");
  });

  it("installs a GitHub-only credential helper that never embeds a token", () => {
    expect(COMPANION_GIT_CREDENTIAL_HELPER_SOURCE).toContain("protocol=https");
    expect(COMPANION_GIT_CREDENTIAL_HELPER_SOURCE).toContain("host=github.com");
    expect(COMPANION_GIT_CREDENTIAL_HELPER_SOURCE).toContain("host=gist.github.com");
    expect(COMPANION_GIT_CREDENTIAL_HELPER_SOURCE).toContain("$COMPANION_MCP_GATEWAY_ORIGIN/git/");
    expect(COMPANION_GIT_CREDENTIAL_HELPER_SOURCE).not.toContain("GITHUB_TOKEN");
    expect(COMPANION_GH_WRAPPER_SOURCE).toContain('GH_TOKEN="$token" exec');
    expect(COMPANION_GIT_CREDENTIAL_HELPER_SOURCE).not.toMatch(/gho_|ghp_|github_pat_/);
    expect(companionGitCredentialHelperInstallCommand()).toContain(
      COMPANION_GIT_CREDENTIAL_HELPER_PATH,
    );
  });
});
