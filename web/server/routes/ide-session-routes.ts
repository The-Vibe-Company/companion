// ide-session-routes.ts — POST/DELETE /api/sessions/:id/ide (Task 7).
//
// Implements API-03 (bind) and API-04 (unbind). Delegates to
// wsBridge.bindIde / wsBridge.unbindIde which own the actual mcp_set_servers
// dispatch, state mutation, persistence, and broadcast. This module is only
// the HTTP edge: parse/validate input, map bridge results to HTTP codes.
//
// Registered inline from routes.ts next to the archive routes (~line 1128),
// mirroring the existing register* helper pattern used by other routes
// subdirectory files (fs-routes, env-routes, etc.).

import type { Hono } from "hono";
import { stripAuthToken, type WsBridge } from "../ws-bridge.js";

interface IdeSessionRoutesDeps {
  wsBridge: WsBridge;
}

export function registerIdeSessionRoutes(api: Hono, deps: IdeSessionRoutesDeps): void {
  const { wsBridge } = deps;

  // POST /sessions/:id/ide — bind a session to an IDE port.
  //
  // Body: { port: number } where port must be a finite positive integer
  // present in the current ide-discovery snapshot. Error mapping:
  //   session not found (bridge)  → 404
  //   unknown port     (bridge)   → 400 {error: "unknown port"}
  //   ok                          → 200 {ok: true, binding: <IdeBinding>}
  //
  // The binding object is echoed back so the FE can optimistically update
  // without waiting for the `session_update` broadcast to round-trip.
  api.post("/sessions/:id/ide", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json().catch(() => ({} as { port?: unknown }));
    const port = (body as { port?: unknown }).port;

    // Validate shape BEFORE calling into bridge — keeps error handling
    // tight and avoids leaking internal "unknown port" semantics for
    // what is really a client-side body error.
    if (typeof port !== "number" || !Number.isInteger(port) || port <= 0) {
      return c.json({ error: "port must be a positive integer" }, 400);
    }

    // Check session existence via the bridge (same source of truth that
    // bindIde uses). This produces a 404 distinct from the "unknown port"
    // 400, which the FE relies on for different recovery UI.
    const session = wsBridge.getSession(id);
    if (!session) {
      return c.json({ error: "session not found" }, 404);
    }

    const result = await wsBridge.bindIde(id, port);
    if (!result.ok) {
      if (result.error === "session not found") {
        return c.json({ error: "session not found" }, 404);
      }
      if (result.error === "unknown port") {
        return c.json({ error: "unknown port" }, 400);
      }
      if (result.error === "backend not connected") {
        // 409 Conflict — the session exists but is not in a state where
        // binding is possible (CLI/adapter not attached yet).
        return c.json({ error: "backend not connected" }, 409);
      }
      // Defensive: any future error string from bindIde surfaces as 500
      // rather than being silently mapped to one of the known codes.
      return c.json({ error: result.error }, 500);
    }

    // Re-read binding from session state so the response reflects exactly
    // what was persisted, not a locally-constructed shape.
    //
    // BIND-03 SECURITY: strip `authToken` before shipping the binding to the
    // browser — the token is runtime-only / server-internal.
    const binding = session.state.ideBinding
      ? stripAuthToken(session.state.ideBinding)
      : null;
    return c.json({ ok: true, binding });
  });

  // DELETE /sessions/:id/ide — clear any IDE binding on the session.
  //
  // Idempotent at the HTTP layer too: calling DELETE on a session with no
  // binding still returns 200 {ok:true}. Nonexistent sessions return 404
  // (distinct from "already cleared") so the FE can differentiate bad
  // session ids from successful cleanups.
  //
  // Codex round-2 issue #1: unbindIde now fails with
  // {ok:false, error:"backend not connected"} when a real binding exists
  // but the adapter is detached/disconnected/rejects the send. We surface
  // that as 409 Conflict (same as POST's bind-without-connected-backend
  // branch) so the UI can show the Retry affordance instead of pretending
  // the tear-down succeeded.
  api.delete("/sessions/:id/ide", async (c) => {
    const id = c.req.param("id");
    const session = wsBridge.getSession(id);
    if (!session) {
      return c.json({ error: "session not found" }, 404);
    }
    const result = await wsBridge.unbindIde(id);
    if (!result.ok) {
      if (result.error === "backend not connected") {
        return c.json({ error: "backend not connected" }, 409);
      }
      return c.json({ error: result.error }, 500);
    }
    return c.json({ ok: true });
  });
}
