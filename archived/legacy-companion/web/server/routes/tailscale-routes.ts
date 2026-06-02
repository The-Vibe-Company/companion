import type { Hono } from "hono";
import { getTailscaleStatus, startFunnel, stopFunnel } from "../tailscale-manager.js";

export function registerTailscaleRoutes(api: Hono, port: number): void {
  api.get("/tailscale/status", async (c) => {
    const status = await getTailscaleStatus(port);
    return c.json(status);
  });

  // Always return 200 — the `error` and `needsOperatorMode` fields in the body
  // signal failures. This lets the frontend receive the full structured status
  // instead of the generic post() helper throwing and losing context.
  api.post("/tailscale/funnel/start", async (c) => {
    const status = await startFunnel(port);
    return c.json(status);
  });

  api.post("/tailscale/funnel/stop", async (c) => {
    const status = await stopFunnel(port);
    return c.json(status);
  });
}
