/**
 * Tests for the migrateFromAgents() auto-migration in linear-oauth-connections.ts.
 *
 * Validates:
 * - Agents with inline OAuth credentials get migrated to standalone connections
 * - Global settings with OAuth credentials get migrated
 * - Deduplication by oauthClientId (multiple agents sharing the same app)
 * - Agents get updated with oauthConnectionId after migration
 * - No migration when connections already exist
 * - Agents without oauthClientId are skipped
 * - Status correctly derived from accessToken presence
 * - Migrated connections persist to disk
 *
 * Uses the exported `migrateFromAgents(deps)` with injected dependencies
 * instead of relying on `require()` interception.
 */
import { vi, describe, it, expect, beforeEach, afterAll } from "vitest";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  listOAuthConnections,
  createOAuthConnection,
  migrateFromAgents,
  _resetForTest,
} from "./linear-oauth-connections.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

const TEST_DIR = join(tmpdir(), `companion-oauth-migration-test-${Date.now()}`);
const TEST_FILE = join(TEST_DIR, "linear-oauth-connections.json");

const mockUpdateAgent = vi.fn();

function makeDeps(
  agents: Array<Record<string, unknown>> = [],
  settings: Record<string, string> = {},
) {
  return {
    listAgents: () => agents as Array<{ id: string; name: string; triggers?: { linear?: Record<string, unknown> } }>,
    updateAgent: mockUpdateAgent as (id: string, patch: Record<string, unknown>) => void,
    getSettings: () => ({
      linearOAuthClientId: "",
      linearOAuthClientSecret: "",
      linearOAuthWebhookSecret: "",
      linearOAuthAccessToken: "",
      linearOAuthRefreshToken: "",
      ...settings,
    }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  _resetForTest(TEST_FILE);
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true });
  }
  mkdirSync(TEST_DIR, { recursive: true });
});

afterAll(() => {
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true });
  }
});

// =============================================================================
// Tests
// =============================================================================

describe("migrateFromAgents", () => {
  it("migrates agents with inline OAuth credentials to standalone connections", () => {
    const deps = makeDeps([
      {
        id: "agent-1",
        name: "Linear Bot",
        triggers: {
          linear: {
            enabled: true,
            oauthClientId: "inline-cid",
            oauthClientSecret: "inline-csec",
            webhookSecret: "inline-wsec",
            accessToken: "inline-tok",
            refreshToken: "inline-ref",
          },
        },
      },
    ]);

    migrateFromAgents(deps);
    const conns = listOAuthConnections();

    expect(conns).toHaveLength(1);
    expect(conns[0].oauthClientId).toBe("inline-cid");
    expect(conns[0].oauthClientSecret).toBe("inline-csec");
    expect(conns[0].webhookSecret).toBe("inline-wsec");
    expect(conns[0].accessToken).toBe("inline-tok");
    expect(conns[0].status).toBe("connected");
    expect(conns[0].name).toBe("Linear Bot OAuth App");

    // Agent should be updated with oauthConnectionId
    expect(mockUpdateAgent).toHaveBeenCalledWith(
      "agent-1",
      expect.objectContaining({
        triggers: expect.objectContaining({
          linear: expect.objectContaining({
            oauthConnectionId: conns[0].id,
          }),
        }),
      }),
    );
  });

  it("deduplicates by oauthClientId when multiple agents share the same app", () => {
    const deps = makeDeps([
      {
        id: "agent-1",
        name: "Bot A",
        triggers: {
          linear: {
            enabled: true,
            oauthClientId: "shared-cid",
            oauthClientSecret: "csec",
            webhookSecret: "wsec",
            accessToken: "tok",
          },
        },
      },
      {
        id: "agent-2",
        name: "Bot B",
        triggers: {
          linear: {
            enabled: true,
            oauthClientId: "shared-cid", // same clientId
            oauthClientSecret: "csec",
            webhookSecret: "wsec",
            accessToken: "tok",
          },
        },
      },
    ]);

    migrateFromAgents(deps);
    const conns = listOAuthConnections();

    // Should create only one connection (deduplication)
    expect(conns).toHaveLength(1);

    // Both agents should be updated with the same connection ID
    expect(mockUpdateAgent).toHaveBeenCalledTimes(2);
    expect(mockUpdateAgent).toHaveBeenCalledWith("agent-1", expect.anything());
    expect(mockUpdateAgent).toHaveBeenCalledWith("agent-2", expect.anything());
  });

  it("migrates from global settings when no agent credentials exist", () => {
    const deps = makeDeps([], {
      linearOAuthClientId: "settings-cid",
      linearOAuthClientSecret: "settings-csec",
      linearOAuthWebhookSecret: "settings-wsec",
      linearOAuthAccessToken: "settings-tok",
      linearOAuthRefreshToken: "settings-ref",
    });

    migrateFromAgents(deps);
    const conns = listOAuthConnections();

    expect(conns).toHaveLength(1);
    expect(conns[0].name).toBe("Default OAuth App");
    expect(conns[0].oauthClientId).toBe("settings-cid");
    expect(conns[0].status).toBe("connected");
  });

  it("skips migration when connections already exist", () => {
    // Pre-create a connection
    createOAuthConnection({
      name: "Existing",
      oauthClientId: "existing-cid",
      oauthClientSecret: "csec",
      webhookSecret: "wsec",
    });

    const deps = makeDeps([
      {
        id: "agent-1",
        name: "Bot",
        triggers: {
          linear: {
            enabled: true,
            oauthClientId: "new-cid",
            oauthClientSecret: "csec",
          },
        },
      },
    ]);

    migrateFromAgents(deps);
    const conns = listOAuthConnections();

    // Should NOT create additional connections
    expect(conns).toHaveLength(1);
    expect(conns[0].oauthClientId).toBe("existing-cid");
    expect(mockUpdateAgent).not.toHaveBeenCalled();
  });

  it("skips agents without oauthClientId", () => {
    const deps = makeDeps([
      {
        id: "agent-1",
        name: "No OAuth",
        triggers: { linear: { enabled: true } },
      },
    ]);

    migrateFromAgents(deps);
    expect(listOAuthConnections()).toHaveLength(0);
  });

  it("sets status to disconnected when agent has no accessToken", () => {
    const deps = makeDeps([
      {
        id: "agent-1",
        name: "Unconnected Bot",
        triggers: {
          linear: {
            enabled: true,
            oauthClientId: "cid",
            oauthClientSecret: "csec",
          },
        },
      },
    ]);

    migrateFromAgents(deps);
    const conns = listOAuthConnections();

    expect(conns).toHaveLength(1);
    expect(conns[0].status).toBe("disconnected");
  });

  it("persists migrated connections to disk", () => {
    const deps = makeDeps([
      {
        id: "agent-1",
        name: "Persist Test",
        triggers: {
          linear: {
            enabled: true,
            oauthClientId: "persist-cid",
            oauthClientSecret: "csec",
            webhookSecret: "wsec",
          },
        },
      },
    ]);

    migrateFromAgents(deps);
    expect(existsSync(TEST_FILE)).toBe(true);

    // Reload from disk and verify
    _resetForTest(TEST_FILE);
    const conns = listOAuthConnections();
    expect(conns).toHaveLength(1);
    expect(conns[0].oauthClientId).toBe("persist-cid");
  });
});
