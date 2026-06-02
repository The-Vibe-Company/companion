// Tests for the Linear OAuth credential migration module.
// Verifies the one-time migration of global Linear OAuth credentials
// from settings.json to the first eligible agent (has linear trigger
// enabled but no per-agent oauthClientId yet).

import { describe, it, expect, vi, beforeEach } from "vitest";

import type { AgentConfig } from "./agent-types.js";

// ─── Mocks ──────────────────────────────────────────────────────────────────

// Mock the agent store: listAgents and updateAgent
vi.mock("./agent-store.js", () => ({
  listAgents: vi.fn(() => []),
  updateAgent: vi.fn(() => null),
}));

// Mock the settings manager: getSettings and updateSettings
vi.mock("./settings-manager.js", () => ({
  getSettings: vi.fn(() => ({
    linearOAuthClientId: "",
    linearOAuthClientSecret: "",
    linearOAuthWebhookSecret: "",
    linearOAuthAccessToken: "",
    linearOAuthRefreshToken: "",
  })),
  updateSettings: vi.fn(),
}));

import { migrateLinearCredentialsToAgents } from "./linear-credential-migration.js";
import * as agentStore from "./agent-store.js";
import { getSettings, updateSettings } from "./settings-manager.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Build a minimal AgentConfig for testing with optional overrides. */
function makeAgent(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    id: "test-agent",
    version: 1,
    name: "Test Agent",
    description: "",
    backendType: "claude",
    model: "claude-sonnet-4-6",
    permissionMode: "default",
    cwd: "/tmp",
    prompt: "do stuff",
    enabled: true,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    totalRuns: 0,
    consecutiveFailures: 0,
    ...overrides,
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
});

describe("migrateLinearCredentialsToAgents", () => {
  // When no global OAuth client ID exists in settings, the function should
  // return early without even querying for agents.
  it("does nothing when no global OAuth credentials exist", () => {
    vi.mocked(getSettings).mockReturnValue({
      linearOAuthClientId: "",
      linearOAuthClientSecret: "",
      linearOAuthWebhookSecret: "",
      linearOAuthAccessToken: "",
      linearOAuthRefreshToken: "",
    } as ReturnType<typeof getSettings>);

    migrateLinearCredentialsToAgents();

    // Should not attempt to list agents when there are no credentials to migrate
    expect(agentStore.listAgents).not.toHaveBeenCalled();
    expect(agentStore.updateAgent).not.toHaveBeenCalled();
    expect(updateSettings).not.toHaveBeenCalled();
  });

  // When global credentials exist but no agent has linear enabled without
  // existing oauthClientId, the function should log a message and return
  // without modifying anything.
  it("does nothing when no eligible agent is found", () => {
    vi.mocked(getSettings).mockReturnValue({
      linearOAuthClientId: "client-id-123",
      linearOAuthClientSecret: "secret-456",
      linearOAuthWebhookSecret: "webhook-789",
      linearOAuthAccessToken: "access-token",
      linearOAuthRefreshToken: "refresh-token",
    } as ReturnType<typeof getSettings>);

    // Agent has linear enabled but already has its own oauthClientId
    const agentWithCreds = makeAgent({
      id: "already-configured",
      name: "Already Configured",
      triggers: {
        linear: {
          enabled: true,
          oauthClientId: "existing-client-id",
        },
      },
    });

    vi.mocked(agentStore.listAgents).mockReturnValue([agentWithCreds]);

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    migrateLinearCredentialsToAgents();

    // Should have listed agents to search for eligible ones
    expect(agentStore.listAgents).toHaveBeenCalled();
    // But should not have updated any agent or cleared settings
    expect(agentStore.updateAgent).not.toHaveBeenCalled();
    expect(updateSettings).not.toHaveBeenCalled();
    // Should log a staging message
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("no Linear agent found to migrate to"),
    );

    consoleSpy.mockRestore();
  });

  // Happy path: global credentials exist and there is exactly one eligible
  // agent (linear enabled, no oauthClientId). The function should copy all
  // credentials to the agent and then clear the global settings.
  it("migrates credentials to the first eligible agent", () => {
    const globalCreds = {
      linearOAuthClientId: "client-id-123",
      linearOAuthClientSecret: "secret-456",
      linearOAuthWebhookSecret: "webhook-789",
      linearOAuthAccessToken: "access-token",
      linearOAuthRefreshToken: "refresh-token",
    };

    vi.mocked(getSettings).mockReturnValue(
      globalCreds as ReturnType<typeof getSettings>,
    );

    const eligibleAgent = makeAgent({
      id: "linear-agent",
      name: "My Linear Agent",
      triggers: {
        linear: {
          enabled: true,
          // No oauthClientId — eligible for migration
        },
      },
    });

    vi.mocked(agentStore.listAgents).mockReturnValue([eligibleAgent]);
    vi.mocked(agentStore.updateAgent).mockReturnValue(eligibleAgent);

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    migrateLinearCredentialsToAgents();

    // Should copy all global credentials to the agent's linear trigger config
    expect(agentStore.updateAgent).toHaveBeenCalledWith("linear-agent", {
      triggers: {
        linear: {
          enabled: true,
          oauthClientId: "client-id-123",
          oauthClientSecret: "secret-456",
          webhookSecret: "webhook-789",
          accessToken: "access-token",
          refreshToken: "refresh-token",
        },
      },
    });

    // Should clear global credentials after successful migration
    expect(updateSettings).toHaveBeenCalledWith({
      linearOAuthClientId: "",
      linearOAuthClientSecret: "",
      linearOAuthWebhookSecret: "",
      linearOAuthAccessToken: "",
      linearOAuthRefreshToken: "",
    });

    // Should log success with agent name and ID
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('Migrated global OAuth credentials to agent "My Linear Agent"'),
    );

    consoleSpy.mockRestore();
  });

  // When multiple agents have linear enabled, but the first one already has
  // its own oauthClientId, the migration should skip it and migrate to the
  // second agent that lacks credentials.
  it("skips agents that already have oauthClientId and migrates to the next eligible one", () => {
    vi.mocked(getSettings).mockReturnValue({
      linearOAuthClientId: "global-client",
      linearOAuthClientSecret: "global-secret",
      linearOAuthWebhookSecret: "global-webhook",
      linearOAuthAccessToken: "global-access",
      linearOAuthRefreshToken: "global-refresh",
    } as ReturnType<typeof getSettings>);

    const agentWithCreds = makeAgent({
      id: "agent-with-creds",
      name: "Agent With Creds",
      triggers: {
        linear: {
          enabled: true,
          oauthClientId: "already-has-one",
        },
      },
    });

    const agentWithoutCreds = makeAgent({
      id: "agent-without-creds",
      name: "Agent Without Creds",
      triggers: {
        linear: {
          enabled: true,
          // No oauthClientId — this one should receive the migration
        },
      },
    });

    vi.mocked(agentStore.listAgents).mockReturnValue([
      agentWithCreds,
      agentWithoutCreds,
    ]);
    vi.mocked(agentStore.updateAgent).mockReturnValue(agentWithoutCreds);

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    migrateLinearCredentialsToAgents();

    // Should migrate to the second agent (the one without existing credentials)
    expect(agentStore.updateAgent).toHaveBeenCalledWith(
      "agent-without-creds",
      expect.objectContaining({
        triggers: expect.objectContaining({
          linear: expect.objectContaining({
            oauthClientId: "global-client",
          }),
        }),
      }),
    );

    // Should clear global settings after migration
    expect(updateSettings).toHaveBeenCalled();

    consoleSpy.mockRestore();
  });

  // An agent exists but its linear trigger is not enabled (enabled: false).
  // It should not be considered eligible for migration.
  it("skips agents without linear trigger enabled", () => {
    vi.mocked(getSettings).mockReturnValue({
      linearOAuthClientId: "client-id",
      linearOAuthClientSecret: "secret",
      linearOAuthWebhookSecret: "webhook",
      linearOAuthAccessToken: "access",
      linearOAuthRefreshToken: "refresh",
    } as ReturnType<typeof getSettings>);

    const disabledLinearAgent = makeAgent({
      id: "disabled-linear",
      name: "Disabled Linear Agent",
      triggers: {
        linear: {
          enabled: false,
          // No oauthClientId, but linear is disabled so it shouldn't qualify
        },
      },
    });

    // Also test an agent with no triggers at all
    const noTriggersAgent = makeAgent({
      id: "no-triggers",
      name: "No Triggers Agent",
      // No triggers property
    });

    vi.mocked(agentStore.listAgents).mockReturnValue([
      disabledLinearAgent,
      noTriggersAgent,
    ]);

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    migrateLinearCredentialsToAgents();

    // Neither agent should receive credentials
    expect(agentStore.updateAgent).not.toHaveBeenCalled();
    expect(updateSettings).not.toHaveBeenCalled();

    // Should log the "no agent found" message
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("no Linear agent found to migrate to"),
    );

    consoleSpy.mockRestore();
  });

  // If updateAgent returns null (store failure), the global credentials
  // must NOT be cleared — otherwise the user's credentials are silently lost.
  it("does NOT clear global credentials when updateAgent fails during migration", () => {
    vi.mocked(getSettings).mockReturnValue({
      linearOAuthClientId: "client-id",
      linearOAuthClientSecret: "secret",
      linearOAuthWebhookSecret: "webhook",
      linearOAuthAccessToken: "access",
      linearOAuthRefreshToken: "refresh",
    } as ReturnType<typeof getSettings>);

    const eligible = makeAgent({
      id: "linear-agent",
      name: "Linear Agent",
      triggers: { linear: { enabled: true } },
    });
    vi.mocked(agentStore.listAgents).mockReturnValue([eligible]);
    // Simulate a store failure
    vi.mocked(agentStore.updateAgent).mockReturnValue(null);

    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    migrateLinearCredentialsToAgents();

    expect(agentStore.updateAgent).toHaveBeenCalled();
    // Credentials must NOT be cleared if the agent write failed
    expect(updateSettings).not.toHaveBeenCalled();
    // Should log an error about the failure
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Failed to write credentials to agent"),
    );

    consoleErrorSpy.mockRestore();
  });
});
