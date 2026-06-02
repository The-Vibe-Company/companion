import { Hono } from "hono";
import {
  requireAuth,
  requireOrganization,
  type AuthEnv,
} from "../middleware/auth.js";

/**
 * Tailscale management routes.
 *
 * Requires auth + active organization. Instance ownership is verified
 * before allowing Tailscale operations.
 *
 * POST /instances/:id/tailscale/enable   — Enable Tailscale on instance
 * POST /instances/:id/tailscale/disable  — Disable Tailscale on instance
 * GET  /instances/:id/tailscale/status   — Get Tailscale connection status
 */

const tailscale = new Hono<AuthEnv>();

// Tailscale routes require auth + active organization.
tailscale.use("/*", requireAuth, requireOrganization);

tailscale.post("/enable", async (c) => {
  // TODO: Verify instance ownership, accept tailscale auth key, store encrypted, restart
  return c.json({ message: "Tailscale enabling" });
});

tailscale.post("/disable", async (c) => {
  // TODO: Verify instance ownership, remove tailscale config, restart
  return c.json({ message: "Tailscale disabling" });
});

tailscale.get("/status", async (c) => {
  // TODO: Verify instance ownership, query instance for tailscale status
  return c.json({ enabled: false, hostname: null });
});

export { tailscale };
