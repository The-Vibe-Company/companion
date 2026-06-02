import { Hono } from "hono";
import {
  requireAuth,
  requireOrganization,
  type AuthEnv,
} from "../middleware/auth.js";

/**
 * Dashboard routes for usage metrics and account info.
 *
 * All metrics are scoped to the active organization.
 *
 * GET /dashboard/usage — Usage metrics for billing display
 */

const dashboard = new Hono<AuthEnv>();

// Dashboard routes require auth + active organization.
dashboard.use("/*", requireAuth, requireOrganization);

dashboard.get("/usage", async (c) => {
  const orgId = c.get("organizationId");
  // TODO: Aggregate usage from instances WHERE organizationId = orgId:
  // - Instance uptime hours
  // - Agent execution count
  // - Storage used
  return c.json({
    organizationId: orgId,
    instances: 0,
    uptimeHours: 0,
    agentRuns: 0,
    storageUsedGb: 0,
  });
});

export { dashboard };
