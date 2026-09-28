export type AppOAuthAdapterId = "github";
export type AppTransport = "http";

export interface AppEnvironmentOAuthClient {
  kind: "environment";
  clientIdEnv: string;
  clientSecretEnv: string;
  tokenEndpointAuthMethod: "client_secret_post" | "client_secret_basic";
}

export interface AppDefinition {
  id: string;
  provider: string;
  name: string;
  description: string;
  mcp: {
    transport: AppTransport;
    url: string;
  };
  oauth: {
    adapter: AppOAuthAdapterId;
    resourceMetadataUrl: string;
    authorizationServer: string;
    authorizationEndpoint?: string;
    tokenEndpoint?: string;
    scopes: readonly string[];
    allowedOrigins: readonly string[];
    client: AppEnvironmentOAuthClient;
  };
  capabilities: {
    /** Serves `git` on the agent computer; never exposed as agent tools. Third-party tools come from Composio. */
    gitCredentials: true;
  };
}

/** Native OAuth is kept only where a credential must reach the agent computer itself. */
const nativeAppDefinitions = [
  {
    id: "io.github.github/github-mcp-server",
    provider: "github",
    name: "GitHub (git access)",
    description: "Lets git clone and push from the Companion computer.",
    mcp: { transport: "http", url: "https://api.githubcopilot.com/mcp/" },
    oauth: {
      adapter: "github",
      resourceMetadataUrl: "https://api.githubcopilot.com/.well-known/oauth-protected-resource/mcp/",
      authorizationServer: "https://github.com/login/oauth",
      authorizationEndpoint: "https://github.com/login/oauth/authorize",
      tokenEndpoint: "https://github.com/login/oauth/access_token",
      scopes: ["repo", "read:org", "read:user", "user:email"],
      allowedOrigins: ["https://api.githubcopilot.com", "https://github.com"],
      client: {
        kind: "environment",
        clientIdEnv: "COMPANION_MCP_GITHUB_CLIENT_ID",
        clientSecretEnv: "COMPANION_MCP_GITHUB_CLIENT_SECRET",
        tokenEndpointAuthMethod: "client_secret_post",
      },
    },
    capabilities: { gitCredentials: true },
  },
] as const satisfies readonly AppDefinition[];

export type AppDefinitionId = (typeof nativeAppDefinitions)[number]["id"];
export type CuratedAppDefinition = AppDefinition & { id: AppDefinitionId };
export const appDefinitions: readonly AppDefinition[] = nativeAppDefinitions;

export function getAppDefinition(id: string): CuratedAppDefinition | undefined {
  return appDefinitions.find((definition) => definition.id === id) as CuratedAppDefinition | undefined;
}

/** Compatibility lookup for persisted rows created before server IDs and capabilities were projected. */
export function getAppDefinitionByProvider(provider: string): CuratedAppDefinition | undefined {
  return appDefinitions.find((definition) => definition.provider === provider) as CuratedAppDefinition | undefined;
}

/** Featured Composio toolkits shown before a search. Any Composio toolkit can be connected. */
export const featuredComposioToolkits = [
  "gmail", "googlecalendar", "github", "linear", "notion", "slack", "googledrive", "googlesheets", "jira", "sentry", "hubspot", "outlook",
] as const;
