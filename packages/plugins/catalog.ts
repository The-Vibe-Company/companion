import { anonymousApps, appDefinitions } from "./definitions";

/** Compatibility catalog derived from the declarative App definitions. */
export const pluginCatalog = [...appDefinitions, ...anonymousApps].map((definition) => ({
  id: definition.id,
  provider: definition.provider,
  name: definition.name,
  transport: definition.mcp.transport,
  url: definition.mcp.url,
  capabilities: definition.capabilities,
  ...("kind" in definition ? { kind: definition.kind, description: definition.description } : {}),
}));

export type MachinePlugin = {
  id: string;
  serverId?: string;
  name: string;
  provider: string;
  transport: "http" | "stdio" | "slack";
  url?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  headers?: Record<string, string>;
  redirect?: "error";
  allowedTools?: string[];
  credentialExpiresAt?: number;
  capabilities?: {
    gitCredentials?: true;
    bridge?: "slack";
  };
};
