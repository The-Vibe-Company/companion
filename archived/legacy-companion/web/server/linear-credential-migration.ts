// Linear OAuth Credential Migration
// One-time migration: copies global Linear OAuth credentials from settings.json
// to the first Linear agent that doesn't have per-agent credentials.
// This runs on server startup to handle the transition from global to per-agent storage.

import * as agentStore from "./agent-store.js";
import { getSettings, updateSettings } from "./settings-manager.js";

/** Migrate global Linear OAuth credentials to the first eligible agent.
 *  This is a one-time operation: once credentials are moved, global fields are cleared. */
export function migrateLinearCredentialsToAgents(): void {
  const settings = getSettings();

  // Nothing to migrate if no global OAuth client ID
  if (!settings.linearOAuthClientId.trim()) return;

  const agents = agentStore.listAgents();
  const linearAgent = agents.find(
    (a) => a.triggers?.linear?.enabled && !a.triggers.linear.oauthClientId
  );

  if (!linearAgent) {
    console.log(
      "[linear-migration] Global OAuth credentials exist but no Linear agent found to migrate to. Credentials will remain in global settings as staging."
    );
    return;
  }

  // Copy credentials to the agent
  const triggers = linearAgent.triggers!;
  const updated = agentStore.updateAgent(linearAgent.id, {
    triggers: {
      ...triggers,
      linear: {
        enabled: true,
        ...triggers.linear,
        oauthClientId: settings.linearOAuthClientId,
        oauthClientSecret: settings.linearOAuthClientSecret,
        webhookSecret: settings.linearOAuthWebhookSecret,
        accessToken: settings.linearOAuthAccessToken,
        refreshToken: settings.linearOAuthRefreshToken,
      },
    },
  });

  // Only clear global credentials after a confirmed successful write
  if (!updated) {
    console.error("[linear-migration] Failed to write credentials to agent — global credentials preserved");
    return;
  }

  updateSettings({
    linearOAuthClientId: "",
    linearOAuthClientSecret: "",
    linearOAuthWebhookSecret: "",
    linearOAuthAccessToken: "",
    linearOAuthRefreshToken: "",
  });

  console.log(
    `[linear-migration] Migrated global OAuth credentials to agent "${linearAgent.name}" (${linearAgent.id})`
  );
}
