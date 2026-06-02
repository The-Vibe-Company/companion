import type { Hono } from "hono";
import {
  listConnections,
  getConnection,
  createConnection,
  updateConnection,
  deleteConnection,
} from "../linear-connections.js";
import { linearCache } from "../linear-cache.js";

/** Mask an API key, showing only the last 4 characters. */
function maskApiKey(key: string): string {
  if (key.length <= 4) return "****";
  return "****" + key.slice(-4);
}

/** Verify a Linear API key by calling the viewer query. Returns workspace info. */
async function verifyLinearApiKey(apiKey: string): Promise<{
  ok: boolean;
  workspaceName?: string;
  workspaceId?: string;
  viewerName?: string;
  viewerEmail?: string;
  error?: string;
}> {
  try {
    const response = await fetch("https://api.linear.app/graphql", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: apiKey,
      },
      body: JSON.stringify({
        query: `
          query CompanionVerifyConnection {
            viewer { id name email }
            organization { id name }
          }
        `,
      }),
    });

    const json = await response.json().catch(() => ({})) as {
      data?: {
        viewer?: { id?: string; name?: string | null; email?: string | null } | null;
        organization?: { id?: string; name?: string | null } | null;
      };
      errors?: Array<{ message?: string }>;
    };

    if (!response.ok || (json.errors && json.errors.length > 0)) {
      const msg = json.errors?.[0]?.message || response.statusText || "Verification failed";
      return { ok: false, error: msg };
    }

    return {
      ok: true,
      workspaceName: json.data?.organization?.name || "",
      workspaceId: json.data?.organization?.id || "",
      viewerName: json.data?.viewer?.name || "",
      viewerEmail: json.data?.viewer?.email || "",
    };
  } catch (e: unknown) {
    return { ok: false, error: e instanceof Error ? e.message : "Verification failed" };
  }
}

export function registerLinearConnectionRoutes(api: Hono): void {
  // ─── List all connections (API keys masked) ────────────────────────

  api.get("/linear/connections", (c) => {
    const conns = listConnections().map((conn) => ({
      id: conn.id,
      name: conn.name,
      apiKeyLast4: maskApiKey(conn.apiKey),
      workspaceName: conn.workspaceName,
      workspaceId: conn.workspaceId,
      viewerName: conn.viewerName,
      viewerEmail: conn.viewerEmail,
      connected: conn.connected,
      autoTransition: conn.autoTransition,
      autoTransitionStateId: conn.autoTransitionStateId,
      autoTransitionStateName: conn.autoTransitionStateName,
      archiveTransition: conn.archiveTransition,
      archiveTransitionStateId: conn.archiveTransitionStateId,
      archiveTransitionStateName: conn.archiveTransitionStateName,
    }));
    return c.json({ connections: conns });
  });

  // ─── Create a new connection (verifies API key) ────────────────────

  api.post("/linear/connections", async (c) => {
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const apiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : "";

    if (!name) return c.json({ error: "name is required" }, 400);
    if (!apiKey) return c.json({ error: "apiKey is required" }, 400);

    // Verify the API key against Linear
    const verification = await verifyLinearApiKey(apiKey);

    // Only persist the connection if verification succeeds
    if (!verification.ok) {
      return c.json({
        connection: null,
        verified: false,
        error: verification.error,
      }, 422);
    }

    const conn = createConnection({ name, apiKey });

    // Update with verification results
    updateConnection(conn.id, {
      connected: true,
      workspaceName: verification.workspaceName || "",
      workspaceId: verification.workspaceId || "",
      viewerName: verification.viewerName || "",
      viewerEmail: verification.viewerEmail || "",
    });

    const updated = getConnection(conn.id)!;
    return c.json({
      connection: {
        id: updated.id,
        name: updated.name,
        apiKeyLast4: maskApiKey(updated.apiKey),
        workspaceName: updated.workspaceName,
        workspaceId: updated.workspaceId,
        viewerName: updated.viewerName,
        viewerEmail: updated.viewerEmail,
        connected: updated.connected,
        autoTransition: updated.autoTransition,
        autoTransitionStateId: updated.autoTransitionStateId,
        autoTransitionStateName: updated.autoTransitionStateName,
        archiveTransition: updated.archiveTransition,
        archiveTransitionStateId: updated.archiveTransitionStateId,
        archiveTransitionStateName: updated.archiveTransitionStateName,
      },
      verified: true,
    }, 201);
  });

  // ─── Update a connection ───────────────────────────────────────────

  api.put("/linear/connections/:id", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;

    const existing = getConnection(id);
    if (!existing) return c.json({ error: "Connection not found" }, 404);

    const patch: Record<string, unknown> = {};
    if (typeof body.name === "string") patch.name = body.name;
    if (typeof body.apiKey === "string" && body.apiKey.trim()) {
      patch.apiKey = body.apiKey.trim();
      // If the API key changed, mark as needing re-verification
      patch.connected = false;
    }
    if (typeof body.autoTransition === "boolean") patch.autoTransition = body.autoTransition;
    if (typeof body.autoTransitionStateId === "string") patch.autoTransitionStateId = body.autoTransitionStateId;
    if (typeof body.autoTransitionStateName === "string") patch.autoTransitionStateName = body.autoTransitionStateName;
    if (typeof body.archiveTransition === "boolean") patch.archiveTransition = body.archiveTransition;
    if (typeof body.archiveTransitionStateId === "string") patch.archiveTransitionStateId = body.archiveTransitionStateId;
    if (typeof body.archiveTransitionStateName === "string") patch.archiveTransitionStateName = body.archiveTransitionStateName;

    const updated = updateConnection(id, patch as Partial<Omit<typeof existing, "id" | "createdAt">>);
    if (!updated) return c.json({ error: "Update failed" }, 500);

    // Invalidate caches for this connection
    linearCache.invalidate(`${id}:`);

    return c.json({
      connection: {
        id: updated.id,
        name: updated.name,
        apiKeyLast4: maskApiKey(updated.apiKey),
        workspaceName: updated.workspaceName,
        workspaceId: updated.workspaceId,
        viewerName: updated.viewerName,
        viewerEmail: updated.viewerEmail,
        connected: updated.connected,
        autoTransition: updated.autoTransition,
        autoTransitionStateId: updated.autoTransitionStateId,
        autoTransitionStateName: updated.autoTransitionStateName,
        archiveTransition: updated.archiveTransition,
        archiveTransitionStateId: updated.archiveTransitionStateId,
        archiveTransitionStateName: updated.archiveTransitionStateName,
      },
    });
  });

  // ─── Delete a connection ───────────────────────────────────────────

  api.delete("/linear/connections/:id", (c) => {
    const id = c.req.param("id");
    const deleted = deleteConnection(id);
    if (!deleted) return c.json({ error: "Connection not found" }, 404);
    // Invalidate caches for this connection
    linearCache.invalidate(`${id}:`);
    return c.json({ ok: true });
  });

  // ─── Re-verify a connection ────────────────────────────────────────

  api.post("/linear/connections/:id/verify", async (c) => {
    const id = c.req.param("id");
    const conn = getConnection(id);
    if (!conn) return c.json({ error: "Connection not found" }, 404);

    const verification = await verifyLinearApiKey(conn.apiKey);
    updateConnection(id, {
      connected: verification.ok,
      workspaceName: verification.ok ? (verification.workspaceName || "") : conn.workspaceName,
      workspaceId: verification.ok ? (verification.workspaceId || "") : conn.workspaceId,
      viewerName: verification.ok ? (verification.viewerName || "") : conn.viewerName,
      viewerEmail: verification.ok ? (verification.viewerEmail || "") : conn.viewerEmail,
    });

    const updated = getConnection(id)!;
    return c.json({
      connection: {
        id: updated.id,
        name: updated.name,
        apiKeyLast4: maskApiKey(updated.apiKey),
        workspaceName: updated.workspaceName,
        workspaceId: updated.workspaceId,
        viewerName: updated.viewerName,
        viewerEmail: updated.viewerEmail,
        connected: updated.connected,
        autoTransition: updated.autoTransition,
        autoTransitionStateId: updated.autoTransitionStateId,
        autoTransitionStateName: updated.autoTransitionStateName,
        archiveTransition: updated.archiveTransition,
        archiveTransitionStateId: updated.archiveTransitionStateId,
        archiveTransitionStateName: updated.archiveTransitionStateName,
      },
      verified: verification.ok,
      error: verification.error,
    });
  });
}
