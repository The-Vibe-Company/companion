export const COMPANION_GMAIL_MCP_ALLOWED_TOOLS = [
  "create_draft",
  "get_message",
  "get_thread",
  "list_drafts",
  "list_labels",
  "search_threads",
] as const;

export type AppOAuthAdapterId = "standard" | "github" | "gmail" | "slack";
export type AppTransport = "http" | "slack";

export interface AppEnvironmentOAuthClient {
  kind: "environment";
  clientIdEnv: string;
  clientSecretEnv: string;
  tokenEndpointAuthMethod: "client_secret_post" | "client_secret_basic";
}

export interface AppDynamicOAuthClient {
  kind: "dynamic";
}

export interface AppDefinition {
  id: string;
  provider: string;
  name: string;
  mcp: {
    transport: AppTransport;
    url: string;
  };
  oauth: {
    adapter: AppOAuthAdapterId;
    resourceMetadataUrl: string;
    authorizationServer: string;
    authorizationMetadataUrl?: string;
    authorizationEndpoint?: string;
    tokenEndpoint?: string;
    scopes: readonly string[];
    authorizationParams?: Readonly<Record<string,string>>;
    allowedOrigins: readonly string[];
    client: AppEnvironmentOAuthClient | AppDynamicOAuthClient;
  };
  capabilities?: {
    gitCredentials?: true;
    bridge?: "slack";
    allowedTools?: readonly string[];
  };
}

/** Curated Apps are declared here once; catalog, OAuth, server and runtime projections derive from it. */
const curatedAppDefinitions = [
  {
    id: "app.linear/linear",
    provider: "linear",
    name: "Linear",
    mcp: { transport: "http", url: "https://mcp.linear.app/mcp" },
    oauth: {
      adapter: "standard",
      resourceMetadataUrl: "https://mcp.linear.app/.well-known/oauth-protected-resource/mcp",
      authorizationServer: "https://mcp.linear.app",
      scopes: ["read", "write"],
      allowedOrigins: ["https://mcp.linear.app"],
      client: { kind: "dynamic" },
    },
  },
  {
    id: "io.github.github/github-mcp-server",
    provider: "github",
    name: "GitHub",
    mcp: { transport: "http", url: "https://api.githubcopilot.com/mcp/" },
    oauth: {
      adapter: "github",
      resourceMetadataUrl: "https://api.githubcopilot.com/.well-known/oauth-protected-resource/mcp/",
      authorizationServer: "https://github.com/login/oauth",
      authorizationEndpoint: "https://github.com/login/oauth/authorize",
      tokenEndpoint: "https://github.com/login/oauth/access_token",
      scopes: ["repo", "read:org", "read:user", "user:email", "admin:repo_hook"],
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
  {
    id: "com.notion/mcp",
    provider: "notion",
    name: "Notion",
    mcp: { transport: "http", url: "https://mcp.notion.com/mcp" },
    oauth: {
      adapter: "standard",
      resourceMetadataUrl: "https://mcp.notion.com/.well-known/oauth-protected-resource/mcp",
      authorizationServer: "https://mcp.notion.com",
      scopes: ["default"],
      allowedOrigins: ["https://mcp.notion.com"],
      client: { kind: "dynamic" },
    },
  },
  {
    id: "build.conductor/mcp",
    provider: "conductor",
    name: "Conductor",
    mcp: { transport: "http", url: "https://api.conductor.build/mcp" },
    oauth: {
      adapter: "standard",
      resourceMetadataUrl: "https://api.conductor.build/.well-known/oauth-protected-resource/mcp",
      authorizationServer: "https://api.conductor.build/mcp",
      authorizationMetadataUrl: "https://api.conductor.build/.well-known/oauth-authorization-server/mcp",
      scopes: ["mcp:tools", "offline_access"],
      allowedOrigins: ["https://api.conductor.build"],
      client: { kind: "dynamic" },
    },
  },
  {
    id: "com.slack/mcp",
    provider: "slack",
    name: "Slack",
    mcp: { transport: "slack", url: "https://slack.com/api/chat.postMessage" },
    oauth: {
      adapter: "slack",
      resourceMetadataUrl: "",
      authorizationServer: "https://slack.com",
      authorizationEndpoint: "https://slack.com/oauth/v2/authorize",
      tokenEndpoint: "https://slack.com/api/oauth.v2.access",
      scopes: ["chat:write"],
      allowedOrigins: ["https://slack.com"],
      client: {
        kind: "environment",
        clientIdEnv: "COMPANION_MCP_SLACK_CLIENT_ID",
        clientSecretEnv: "COMPANION_MCP_SLACK_CLIENT_SECRET",
        tokenEndpointAuthMethod: "client_secret_basic",
      },
    },
    capabilities: { bridge: "slack" },
  },
  {
    id: "com.google.workspace/gmail",
    provider: "gmail",
    name: "Gmail",
    mcp: { transport: "http", url: "https://gmailmcp.googleapis.com/mcp/v1" },
    oauth: {
      adapter: "gmail",
      resourceMetadataUrl: "https://gmailmcp.googleapis.com/.well-known/oauth-protected-resource/mcp/v1",
      authorizationServer: "https://accounts.google.com/",
      authorizationMetadataUrl: "https://accounts.google.com/.well-known/oauth-authorization-server",
      scopes: [
        "https://www.googleapis.com/auth/gmail.readonly",
        "https://www.googleapis.com/auth/gmail.compose",
      ],
      allowedOrigins: [
        "https://gmailmcp.googleapis.com",
        "https://accounts.google.com",
        "https://oauth2.googleapis.com",
      ],
      client: {
        kind: "environment",
        clientIdEnv: "COMPANION_MCP_GMAIL_CLIENT_ID",
        clientSecretEnv: "COMPANION_MCP_GMAIL_CLIENT_SECRET",
        tokenEndpointAuthMethod: "client_secret_post",
      },
    },
    capabilities: { allowedTools: COMPANION_GMAIL_MCP_ALLOWED_TOOLS },
  },
  {
    id: "io.sentry/mcp",
    provider: "sentry",
    name: "Sentry",
    mcp: { transport: "http", url: "https://mcp.sentry.dev/mcp" },
    oauth: {
      adapter: "standard",
      resourceMetadataUrl: "https://mcp.sentry.dev/.well-known/oauth-protected-resource/mcp",
      authorizationServer: "https://mcp.sentry.dev",
      scopes: ["org:read", "project:write", "project:admin", "team:write", "event:write"],
      allowedOrigins: ["https://mcp.sentry.dev"],
      client: { kind: "dynamic" },
    },
  },
  {
    id: "com.railway/mcp",
    provider: "railway",
    name: "Railway",
    mcp: { transport: "http", url: "https://mcp.railway.com" },
    oauth: {
      adapter: "standard",
      resourceMetadataUrl: "https://mcp.railway.com/.well-known/oauth-protected-resource",
      authorizationServer: "https://backboard.railway.com",
      authorizationParams: { prompt: "consent" },
      scopes: ["openid", "profile", "email", "offline_access", "workspace:member"],
      allowedOrigins: ["https://mcp.railway.com", "https://backboard.railway.com"],
      client: { kind: "dynamic" },
    },
  },
  {
    id: "app.skillpack/mcp",
    provider: "skillpack",
    name: "Skillpack",
    mcp: { transport: "http", url: "https://skillpack.app/mcp" },
    oauth: {
      adapter: "standard",
      resourceMetadataUrl: "https://skillpack.app/auth/.well-known/oauth-protected-resource",
      // Better Auth publishes the origin as the authorization server and serves its metadata under
      // the `/auth` base path, so the metadata URL is named explicitly rather than derived.
      authorizationServer: "https://skillpack.app",
      authorizationMetadataUrl: "https://skillpack.app/auth/.well-known/oauth-authorization-server",
      // `prompt=consent` is what routes the member to Skillpack's consent screen, where they choose
      // the one workspace this connection may act in. Without it Skillpack would issue a grant with
      // no workspace and every tool call would fail closed.
      authorizationParams: { prompt: "consent" },
      // `offline_access` is what makes Skillpack's token endpoint return a refresh token.
      scopes: ["openid", "offline_access"],
      allowedOrigins: ["https://skillpack.app"],
      client: { kind: "dynamic" },
    },
  },
] as const satisfies readonly AppDefinition[];

export type AppDefinitionId = (typeof curatedAppDefinitions)[number]["id"];
export type AppDefinitions = typeof curatedAppDefinitions;
export type CuratedAppDefinition = AppDefinition & { id: AppDefinitionId };
export const appDefinitions: readonly AppDefinition[] = curatedAppDefinitions;

export const anonymousApps = [{
  id: "ai.parallel/mcp",
  provider: "parallel",
  name: "Parallel Search",
  kind: "remote",
  description: "Search and fetch public web pages. Parallel receives search queries, page URLs, and any context your Companion includes.",
  mcp: {
    transport: "http",
    url: "https://mcp.parallel.ai/mcp",
    headers: { "User-Agent": "companions.build" },
    redirect: "error",
  },
  capabilities: { allowedTools: ["web_search", "web_fetch"] },
}] as const;

export function getAnonymousAppDefinition(id: string) {
  return anonymousApps.find((definition) => definition.id === id);
}

export function getAppDefinition(id: string): CuratedAppDefinition | undefined {
  return appDefinitions.find((definition) => definition.id === id) as CuratedAppDefinition | undefined;
}

/** Compatibility lookup for persisted rows created before server IDs and capabilities were projected. */
export function getAppDefinitionByProvider(provider: string): CuratedAppDefinition | undefined {
  return appDefinitions.find((definition) => definition.provider === provider) as CuratedAppDefinition | undefined;
}
