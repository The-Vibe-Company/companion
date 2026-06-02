/**
 * Tests for linear-oauth-connection-routes.ts — Hono route handlers
 * for Linear OAuth connection CRUD.
 *
 * Validates:
 * - GET /linear/oauth-connections — list connections (secrets masked)
 * - POST /linear/oauth-connections — create with validation
 * - PUT /linear/oauth-connections/:id — update fields
 * - DELETE /linear/oauth-connections/:id — delete with agent guard (409)
 * - GET /linear/oauth-connections/:id/authorize-url — generate OAuth URL
 * - 404 responses for non-existent connections
 */
import { vi, describe, it, expect, beforeEach } from "vitest";

// ─── Mock linear-oauth-connections module ────────────────────────────────────

const mockConnection = {
  id: "conn-1",
  name: "Test App",
  oauthClientId: "client-123",
  oauthClientSecret: "secret-456",
  webhookSecret: "webhook-789",
  accessToken: "tok-abc",
  refreshToken: "ref-xyz",
  status: "connected" as const,
  createdAt: 1000,
  updatedAt: 2000,
};

vi.mock("../linear-oauth-connections.js", () => ({
  listOAuthConnections: vi.fn(() => []),
  getOAuthConnection: vi.fn(() => null),
  createOAuthConnection: vi.fn(),
  updateOAuthConnection: vi.fn(),
  deleteOAuthConnection: vi.fn(() => false),
  sanitizeOAuthConnection: vi.fn((conn: Record<string, unknown>) => ({
    id: conn.id,
    name: conn.name,
    oauthClientId: conn.oauthClientId,
    status: conn.status,
    hasAccessToken: !!conn.accessToken,
    hasClientSecret: !!conn.oauthClientSecret,
    hasWebhookSecret: !!conn.webhookSecret,
    createdAt: conn.createdAt,
    updatedAt: conn.updatedAt,
  })),
}));

// ─── Mock agent-store module ─────────────────────────────────────────────────

vi.mock("../agent-store.js", () => ({
  listAgents: vi.fn(() => []),
}));

// ─── Mock settings-manager module ────────────────────────────────────────────

vi.mock("../settings-manager.js", () => ({
  getSettings: vi.fn(() => ({
    publicUrl: "https://companion.example.com",
  })),
}));

// ─── Mock linear-agent module ────────────────────────────────────────────────

vi.mock("../linear-agent.js", () => ({
  getOAuthAuthorizeUrl: vi.fn(() => ({
    url: "https://linear.app/oauth/authorize?client_id=test",
  })),
}));

import { Hono } from "hono";
import {
  listOAuthConnections,
  getOAuthConnection,
  createOAuthConnection,
  updateOAuthConnection,
  deleteOAuthConnection,
} from "../linear-oauth-connections.js";
import * as agentStore from "../agent-store.js";
import * as linearAgent from "../linear-agent.js";
import { registerLinearOAuthConnectionRoutes } from "./linear-oauth-connection-routes.js";

// ─── Setup ──────────────────────────────────────────────────────────────────

let app: Hono;

beforeEach(() => {
  vi.clearAllMocks();
  app = new Hono();
  registerLinearOAuthConnectionRoutes(app);
});

// ─── Helpers ────────────────────────────────────────────────────────────────

function GET(path: string) {
  return app.request(path, { method: "GET" });
}

function POST(path: string, body: Record<string, unknown>) {
  return app.request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function PUT(path: string, body: Record<string, unknown>) {
  return app.request(path, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function DELETE(path: string) {
  return app.request(path, { method: "DELETE" });
}

// =============================================================================
// Tests
// =============================================================================

describe("linear-oauth-connection-routes", () => {
  // ─── GET /linear/oauth-connections ──────────────────────────────────────

  describe("GET /linear/oauth-connections", () => {
    it("returns empty list when no connections exist", async () => {
      const res = await GET("/linear/oauth-connections");
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.connections).toEqual([]);
    });

    it("returns sanitized connections list", async () => {
      vi.mocked(listOAuthConnections).mockReturnValue([mockConnection]);

      const res = await GET("/linear/oauth-connections");
      expect(res.status).toBe(200);
      const json = await res.json();

      expect(json.connections).toHaveLength(1);
      expect(json.connections[0].name).toBe("Test App");
      expect(json.connections[0].oauthClientId).toBe("client-123");
      // Secrets should be masked (boolean flags instead)
      expect(json.connections[0].hasAccessToken).toBe(true);
      expect(json.connections[0].oauthClientSecret).toBeUndefined();
    });
  });

  // ─── POST /linear/oauth-connections ─────────────────────────────────────

  describe("POST /linear/oauth-connections", () => {
    it("creates a connection with valid body", async () => {
      vi.mocked(createOAuthConnection).mockReturnValue({ ...mockConnection, id: "new-conn" });

      const res = await POST("/linear/oauth-connections", {
        name: "New App",
        oauthClientId: "new-cid",
        oauthClientSecret: "new-csec",
        webhookSecret: "new-wsec",
      });

      expect(res.status).toBe(201);
      const json = await res.json();
      expect(json.connection).toBeDefined();
      expect(createOAuthConnection).toHaveBeenCalledWith({
        name: "New App",
        oauthClientId: "new-cid",
        oauthClientSecret: "new-csec",
        webhookSecret: "new-wsec",
      });
    });

    it("returns 400 when name is missing", async () => {
      const res = await POST("/linear/oauth-connections", {
        oauthClientId: "cid",
        oauthClientSecret: "csec",
        webhookSecret: "wsec",
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toBe("name is required");
    });

    it("returns 400 when oauthClientId is missing", async () => {
      const res = await POST("/linear/oauth-connections", {
        name: "App",
        oauthClientSecret: "csec",
        webhookSecret: "wsec",
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toBe("oauthClientId is required");
    });

    it("returns 400 when oauthClientSecret is missing", async () => {
      const res = await POST("/linear/oauth-connections", {
        name: "App",
        oauthClientId: "cid",
        webhookSecret: "wsec",
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toBe("oauthClientSecret is required");
    });

    it("returns 400 when webhookSecret is missing", async () => {
      const res = await POST("/linear/oauth-connections", {
        name: "App",
        oauthClientId: "cid",
        oauthClientSecret: "csec",
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toBe("webhookSecret is required");
    });

    it("returns 409 when oauthClientId already exists", async () => {
      // Simulate existing connection with same client ID
      vi.mocked(listOAuthConnections).mockReturnValue([mockConnection]);

      const res = await POST("/linear/oauth-connections", {
        name: "Duplicate",
        oauthClientId: "client-123", // same as mockConnection
        oauthClientSecret: "csec",
        webhookSecret: "wsec",
      });

      expect(res.status).toBe(409);
      const json = await res.json();
      expect(json.error).toBe("A connection with this OAuth client ID already exists");
      expect(createOAuthConnection).not.toHaveBeenCalled();
    });

    it("trims whitespace-only fields and returns 400", async () => {
      const res = await POST("/linear/oauth-connections", {
        name: "   ",
        oauthClientId: "cid",
        oauthClientSecret: "csec",
        webhookSecret: "wsec",
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toBe("name is required");
    });
  });

  // ─── PUT /linear/oauth-connections/:id ──────────────────────────────────

  describe("PUT /linear/oauth-connections/:id", () => {
    it("updates a connection", async () => {
      vi.mocked(getOAuthConnection).mockReturnValue(mockConnection);
      vi.mocked(updateOAuthConnection).mockReturnValue({
        ...mockConnection,
        name: "Updated App",
      });

      const res = await PUT("/linear/oauth-connections/conn-1", {
        name: "Updated App",
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.connection.name).toBe("Updated App");
      expect(updateOAuthConnection).toHaveBeenCalledWith("conn-1", { name: "Updated App" });
    });

    it("returns 404 for non-existent connection", async () => {
      vi.mocked(getOAuthConnection).mockReturnValue(null);

      const res = await PUT("/linear/oauth-connections/nope", { name: "x" });
      expect(res.status).toBe(404);
      const json = await res.json();
      expect(json.error).toBe("OAuth connection not found");
    });

    it("returns 409 when updating oauthClientId to one that already exists", async () => {
      vi.mocked(getOAuthConnection).mockReturnValue(mockConnection);
      // Another connection already uses this clientId
      vi.mocked(listOAuthConnections).mockReturnValue([
        { ...mockConnection, id: "conn-other", oauthClientId: "existing-cid" },
      ]);

      const res = await PUT("/linear/oauth-connections/conn-1", { oauthClientId: "existing-cid" });
      expect(res.status).toBe(409);
      const json = await res.json();
      expect(json.error).toContain("already exists");
      // Should NOT call updateOAuthConnection
      expect(updateOAuthConnection).not.toHaveBeenCalled();
    });

    it("allows updating oauthClientId to the same value (no-op duplicate)", async () => {
      vi.mocked(getOAuthConnection).mockReturnValue(mockConnection);
      vi.mocked(updateOAuthConnection).mockReturnValue({ ...mockConnection, updatedAt: 9999 });

      // Updating to the same clientId the connection already has should be allowed
      const res = await PUT("/linear/oauth-connections/conn-1", { oauthClientId: mockConnection.oauthClientId });
      expect(res.status).toBe(200);
      expect(updateOAuthConnection).toHaveBeenCalled();
    });

    it("returns 500 when update fails", async () => {
      vi.mocked(getOAuthConnection).mockReturnValue(mockConnection);
      vi.mocked(updateOAuthConnection).mockReturnValue(null);

      const res = await PUT("/linear/oauth-connections/conn-1", { name: "x" });
      expect(res.status).toBe(500);
      const json = await res.json();
      expect(json.error).toBe("Update failed");
    });
  });

  // ─── DELETE /linear/oauth-connections/:id ───────────────────────────────

  describe("DELETE /linear/oauth-connections/:id", () => {
    it("deletes a connection with no referencing agents", async () => {
      vi.mocked(getOAuthConnection).mockReturnValue(mockConnection);
      vi.mocked(agentStore.listAgents).mockReturnValue([]);
      vi.mocked(deleteOAuthConnection).mockReturnValue(true);

      const res = await DELETE("/linear/oauth-connections/conn-1");
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(deleteOAuthConnection).toHaveBeenCalledWith("conn-1");
    });

    it("returns 404 for non-existent connection", async () => {
      vi.mocked(getOAuthConnection).mockReturnValue(null);

      const res = await DELETE("/linear/oauth-connections/nope");
      expect(res.status).toBe(404);
    });

    it("returns 409 when agents reference the connection (even disabled ones)", async () => {
      // Disabled agent that references this connection — guard should still catch it
      vi.mocked(getOAuthConnection).mockReturnValue(mockConnection);
      vi.mocked(agentStore.listAgents).mockReturnValue([
        {
          id: "agent-1",
          name: "Linear Bot",
          enabled: false,
          triggers: {
            linear: {
              enabled: false,
              oauthConnectionId: "conn-1",
            },
          },
        },
      ] as ReturnType<typeof agentStore.listAgents>);

      const res = await DELETE("/linear/oauth-connections/conn-1");
      expect(res.status).toBe(409);
      const json = await res.json();
      expect(json.error).toContain("agents are using this OAuth connection");
      expect(json.agents).toHaveLength(1);
      expect(json.agents[0].name).toBe("Linear Bot");
      // deleteOAuthConnection should NOT have been called
      expect(deleteOAuthConnection).not.toHaveBeenCalled();
    });
  });

  // ─── GET /linear/oauth-connections/:id/authorize-url ───────────────────

  describe("GET /linear/oauth-connections/:id/authorize-url", () => {
    it("returns authorize URL for valid connection", async () => {
      vi.mocked(getOAuthConnection).mockReturnValue(mockConnection);

      const res = await GET("/linear/oauth-connections/conn-1/authorize-url?returnTo=/%23/integrations/linear-oauth");
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.url).toBe("https://linear.app/oauth/authorize?client_id=test");

      // Verify the correct args were passed to getOAuthAuthorizeUrl
      expect(linearAgent.getOAuthAuthorizeUrl).toHaveBeenCalledWith(
        "client-123",
        "https://companion.example.com/api/linear/oauth/callback",
        expect.objectContaining({
          connectionId: "conn-1",
        }),
      );
    });

    it("returns 404 for non-existent connection", async () => {
      vi.mocked(getOAuthConnection).mockReturnValue(null);

      const res = await GET("/linear/oauth-connections/nope/authorize-url");
      expect(res.status).toBe(404);
    });

    it("returns 500 when authorize URL generation fails", async () => {
      vi.mocked(getOAuthConnection).mockReturnValue(mockConnection);
      vi.mocked(linearAgent.getOAuthAuthorizeUrl).mockReturnValue(null as unknown as ReturnType<typeof linearAgent.getOAuthAuthorizeUrl>);

      const res = await GET("/linear/oauth-connections/conn-1/authorize-url");
      expect(res.status).toBe(500);
      const json = await res.json();
      expect(json.error).toBe("Failed to generate authorize URL");
    });
  });
});
