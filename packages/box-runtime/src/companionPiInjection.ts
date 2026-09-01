import { createHash } from "node:crypto";
import {
  COMPANION_CONTROL_MCP_SERVER_NAME,
  type CompanionMcpAccount,
} from "@companion/contracts";

export interface CompanionRuntimeSkill {
  slug: string;
  version: string;
  checksum: string;
  archive: Buffer;
}

export interface CompanionMcpAdapterConfig {
  settings: {
    toolPrefix: "mcp";
    hostConfigDiscovery: "off";
    sampling: false;
    elicitation: false;
    oauthDir: string;
  };
  mcpServers: Record<string, CompanionMcpServerConfig>;
}

type CompanionMcpJsonValue =
  | string
  | number
  | boolean
  | null
  | CompanionMcpJsonObject
  | CompanionMcpJsonValue[];

interface CompanionMcpJsonObject {
  [key: string]: CompanionMcpJsonValue;
}

interface CompanionMcpServerConfig extends CompanionMcpJsonObject {}

export interface CompanionMcpAdapterInjection {
  config: CompanionMcpAdapterConfig;
  accounts: CompanionMcpAccountMetadata[];
  gatewayAccounts: CompanionMcpGatewayAccount[];
}

export interface CompanionMcpAccountMetadata {
  id: string;
  label: string;
  adapter_name: string;
  transport: CompanionMcpAccount["transport"];
}

export interface CompanionStagedMcpAccount {
  account: CompanionMcpAccount;
  oauthBroker?: {
    credentialGeneration: string;
    github: boolean;
    slack?: true;
    allowedTools?: readonly string[];
  };
}

export interface CompanionMcpGatewayAccount {
  accountId: string;
  credentialGeneration: string;
  upstreamUrl: string;
  github: boolean;
  slack?: true;
  allowedTools?: string[];
}

function adapterName(account: Pick<CompanionMcpAccount, "id" | "label">): string {
  const label = account.label
    .normalize("NFKD")
    .replace(/[^\p{ASCII}]/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "account";
  const suffix = createHash("sha256").update(account.id).digest("hex").slice(0, 10);
  return `${label}--${suffix}`;
}

function environmentReference(envKey: string): string {
  return `\${${envKey}}`;
}

/**
 * Convert Companion's labeled account contract into pi-mcp-adapter's file contract. Only
 * environment references enter the durable JSON; credential values are inherited from Pi's
 * transient process environment.
 */
export function buildMcpAdapterInjection(
  stagedAccounts: Array<CompanionStagedMcpAccount | CompanionMcpAccount>,
  includeCompanionControl = false,
): CompanionMcpAdapterInjection {
  const mcpServers: Record<string, CompanionMcpServerConfig> = {};
  const metadata: CompanionMcpAccountMetadata[] = [];
  const gatewayAccounts: CompanionMcpGatewayAccount[] = [];

  if (includeCompanionControl) {
    mcpServers[COMPANION_CONTROL_MCP_SERVER_NAME] = {
      lifecycle: "eager",
      directTools: true,
      url: "${COMPANION_MCP_GATEWAY_ORIGIN}/control",
      headers: {},
    };
  }

  for (const candidate of stagedAccounts) {
    const staged: CompanionStagedMcpAccount = "account" in candidate
      ? candidate
      : { account: candidate };
    const account = staged.account;
    const name = adapterName(account);
    const common = {
      lifecycle: account.lifecycle,
      directTools: account.direct_tools,
    };
    if (staged.oauthBroker && account.transport !== "http") {
      throw new Error("OAuth-brokered MCP accounts must use HTTP");
    }
    mcpServers[name] = account.transport === "stdio"
      ? {
          ...common,
          command: account.command,
          args: account.args,
          env: Object.fromEntries(
            Object.entries(account.env).map(([key, envKey]) => [key, environmentReference(envKey)]),
          ),
        }
      : {
          ...common,
          url: staged.oauthBroker
            ? `\${COMPANION_MCP_GATEWAY_ORIGIN}/mcp/${account.id}`
            : account.url,
          headers: staged.oauthBroker
            ? {}
            : Object.fromEntries(
              Object.entries(account.headers).map(([key, envKey]) => [key, environmentReference(envKey)]),
            ),
    };
    if (staged.oauthBroker && account.transport === "http") {
      const gatewayAccount: CompanionMcpGatewayAccount = {
        accountId: account.id,
        credentialGeneration: staged.oauthBroker.credentialGeneration,
        upstreamUrl: account.url,
        github: staged.oauthBroker.github,
      };
      if (staged.oauthBroker.slack) gatewayAccount.slack = true;
      if (staged.oauthBroker.allowedTools) {
        gatewayAccount.allowedTools = [...staged.oauthBroker.allowedTools];
      }
      gatewayAccounts.push(gatewayAccount);
    }
    metadata.push({
      id: account.id,
      label: account.label,
      adapter_name: name,
      transport: account.transport,
    });
  }

  return {
    config: {
      settings: {
        toolPrefix: "mcp",
        hostConfigDiscovery: "off",
        sampling: false,
        elicitation: false,
        oauthDir: "~/.companion/runtime/state/mcp-oauth",
      },
      mcpServers,
    },
    accounts: metadata,
    gatewayAccounts,
  };
}

export function runtimeSkillArchivePath(skill: Pick<CompanionRuntimeSkill, "slug">): string {
  return `.companion/runtime/state/skill-archives/${skill.slug}.tar.gz.b64`;
}

/** Secret-free helpers. A token is requested from the loopback gateway for each command. */
export const COMPANION_GIT_CREDENTIAL_HELPER_PATH = ".companion/bin/git-credential-github";
export const COMPANION_GH_WRAPPER_PATH = ".companion/bin/gh";

export const COMPANION_GIT_CREDENTIAL_HELPER_SOURCE = `#!/bin/sh
# Companion GitHub credential helper. Answers only HTTPS github.com / gist.github.com.
# The OAuth token remains in the broker and this helper's short-lived process.
action="\${1-}"
if [ "$action" != "get" ]; then
  exit 0
fi
protocol=""
host=""
while IFS= read -r line || [ -n "$line" ]; do
  [ -z "$line" ] && break
  case "$line" in
    protocol=https) protocol=https ;;
    host=github.com|host=gist.github.com) host="\${line#host=}" ;;
  esac
done
if [ "$protocol" != "https" ] || [ -z "$host" ] \
  || [ -z "\${COMPANION_MCP_GATEWAY_ORIGIN-}" ] \
  || [ -z "\${COMPANION_GITHUB_MCP_ACCOUNT_ID-}" ]; then
  exit 0
fi
token="$(curl --fail --silent --show-error \
  "$COMPANION_MCP_GATEWAY_ORIGIN/git/$COMPANION_GITHUB_MCP_ACCOUNT_ID")" || exit 1
[ -n "$token" ] || exit 1
printf 'username=x-access-token\\npassword=%s\\n' "$token"
`;

export const COMPANION_GH_WRAPPER_SOURCE = `#!/bin/sh
set -eu
real=""
for candidate in /usr/local/bin/gh /usr/bin/gh /bin/gh; do
  if [ -x "$candidate" ]; then real="$candidate"; break; fi
done
[ -n "$real" ] || { echo 'gh is unavailable' >&2; exit 127; }
if [ -z "\${COMPANION_MCP_GATEWAY_ORIGIN-}" ] \
  || [ -z "\${COMPANION_GITHUB_MCP_ACCOUNT_ID-}" ]; then
  exec "$real" "$@"
fi
token="$(curl --fail --silent --show-error \
  "$COMPANION_MCP_GATEWAY_ORIGIN/git/$COMPANION_GITHUB_MCP_ACCOUNT_ID")" || exit 1
[ -n "$token" ] || exit 1
GH_TOKEN="$token" exec "$real" "$@"
`;

export function companionGitCredentialHelperInstallCommand(): string {
  return `chmod 700 "$HOME/${COMPANION_GIT_CREDENTIAL_HELPER_PATH}"
command -v git >/dev/null 2>&1 || exit 0
git config --global --unset-all credential.helper >/dev/null 2>&1 || true
git config --global credential.helper "$HOME/${COMPANION_GIT_CREDENTIAL_HELPER_PATH}"`;
}
