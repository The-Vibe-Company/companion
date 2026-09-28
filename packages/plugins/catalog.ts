import { appDefinitions } from "./definitions";

/** Native entries only; Composio toolkits are listed by the server from Composio. */
export const pluginCatalog = appDefinitions.map((definition) => ({
  id: definition.id,
  provider: definition.provider,
  name: definition.name,
  description: definition.description,
  kind: "native" as const,
  capabilities: definition.capabilities,
}));

export type MachinePlugin = {
  id: string;
  serverId?: string;
  name: string;
  provider: string;
  /** `composio` connections carry no credential; the server executes their tools. */
  transport: "http" | "stdio" | "composio";
  toolkit?: string;
  url?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  headers?: Record<string, string>;
  allowedTools?: string[];
  credentialExpiresAt?: number;
  capabilities?: {
    gitCredentials?: true;
  };
};
