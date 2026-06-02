import type { Hono } from "hono";
import {
  listOAuthConnections,
  getOAuthConnection,
  createOAuthConnection,
  updateOAuthConnection,
  deleteOAuthConnection,
  sanitizeOAuthConnection,
} from "../linear-oauth-connections.js";
import * as agentStore from "../agent-store.js";
import * as linearAgent from "../linear-agent.js";
import { getSettings } from "../settings-manager.js";

/** Find agents referencing a given OAuth connection ID (includes disabled agents). */
function findAgentsUsingConnection(connectionId: string) {
  return agentStore.listAgents().filter(
    (a) => a.triggers?.linear?.oauthConnectionId === connectionId,
  );
}

export function registerLinearOAuthConnectionRoutes(api: Hono): void {
  // ─── List all OAuth connections (secrets masked) ─────────────────

  api.get("/linear/oauth-connections", (c) => {
    const conns = listOAuthConnections().map(sanitizeOAuthConnection);
    return c.json({ connections: conns });
  });

  // ─── Create a new OAuth connection ───────────────────────────────

  api.post("/linear/oauth-connections", async (c) => {
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const oauthClientId = typeof body.oauthClientId === "string" ? body.oauthClientId.trim() : "";
    const oauthClientSecret = typeof body.oauthClientSecret === "string" ? body.oauthClientSecret.trim() : "";
    const webhookSecret = typeof body.webhookSecret === "string" ? body.webhookSecret.trim() : "";

    if (!name) return c.json({ error: "name is required" }, 400);
    if (!oauthClientId) return c.json({ error: "oauthClientId is required" }, 400);
    if (!oauthClientSecret) return c.json({ error: "oauthClientSecret is required" }, 400);
    if (!webhookSecret) return c.json({ error: "webhookSecret is required" }, 400);

    // Guard: prevent duplicate oauthClientId — webhook routing uses findByClientId
    const duplicate = listOAuthConnections().find((conn) => conn.oauthClientId === oauthClientId);
    if (duplicate) {
      return c.json({ error: "A connection with this OAuth client ID already exists" }, 409);
    }

    const conn = createOAuthConnection({ name, oauthClientId, oauthClientSecret, webhookSecret });
    return c.json({ connection: sanitizeOAuthConnection(conn) }, 201);
  });

  // ─── Update an OAuth connection ──────────────────────────────────

  api.put("/linear/oauth-connections/:id", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;

    const existing = getOAuthConnection(id);
    if (!existing) return c.json({ error: "OAuth connection not found" }, 404);

    const patch: Record<string, unknown> = {};
    if (typeof body.name === "string") patch.name = body.name;
    if (typeof body.oauthClientId === "string") patch.oauthClientId = body.oauthClientId;
    if (typeof body.oauthClientSecret === "string") patch.oauthClientSecret = body.oauthClientSecret;
    if (typeof body.webhookSecret === "string") patch.webhookSecret = body.webhookSecret;

    // Guard: prevent duplicate oauthClientId on update (same logic as create)
    if (typeof body.oauthClientId === "string") {
      const trimmed = body.oauthClientId.trim();
      if (trimmed && trimmed !== existing.oauthClientId) {
        const duplicate = listOAuthConnections().find((conn) => conn.oauthClientId === trimmed);
        if (duplicate) {
          return c.json({ error: "A connection with this OAuth client ID already exists" }, 409);
        }
      }
    }

    const updated = updateOAuthConnection(id, patch as Partial<Omit<typeof existing, "id" | "createdAt">>);
    if (!updated) return c.json({ error: "Update failed" }, 500);

    return c.json({ connection: sanitizeOAuthConnection(updated) });
  });

  // ─── Delete an OAuth connection ──────────────────────────────────

  api.delete("/linear/oauth-connections/:id", (c) => {
    const id = c.req.param("id");
    const existing = getOAuthConnection(id);
    if (!existing) return c.json({ error: "OAuth connection not found" }, 404);

    // Guard: warn if agents reference this connection
    const referencingAgents = findAgentsUsingConnection(id);
    if (referencingAgents.length > 0) {
      return c.json({
        error: "Cannot delete: agents are using this OAuth connection",
        agents: referencingAgents.map((a) => ({ id: a.id, name: a.name })),
      }, 409);
    }

    deleteOAuthConnection(id);
    return c.json({ ok: true });
  });

  // ─── Get OAuth authorize URL for a connection ────────────────────

  api.get("/linear/oauth-connections/:id/authorize-url", (c) => {
    const id = c.req.param("id");
    const conn = getOAuthConnection(id);
    if (!conn) return c.json({ error: "OAuth connection not found" }, 404);

    const settings = getSettings();
    const baseUrl = settings.publicUrl || `http://localhost:${process.env.PORT || 3456}`;
    const redirectUri = `${baseUrl}/api/linear/oauth/callback`;
    const returnTo = c.req.query("returnTo");
    const safeReturnTo = returnTo && /^\/?#\//.test(returnTo) ? returnTo : undefined;

    const result = linearAgent.getOAuthAuthorizeUrl(conn.oauthClientId, redirectUri, {
      connectionId: id,
      returnTo: safeReturnTo || "/#/integrations/linear-oauth",
    });

    if (!result) {
      return c.json({ error: "Failed to generate authorize URL" }, 500);
    }

    return c.json({ url: result.url });
  });
}
