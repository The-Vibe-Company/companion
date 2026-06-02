import { describe, it, expect, vi } from "vitest";

/**
 * Tests for dashboard routes.
 *
 * Auth middleware is mocked to inject org context. Dashboard metrics
 * are scoped to the active organization.
 */

const MOCK_ORG_ID = "org-dash-1";

vi.mock("../middleware/auth.js", () => ({
  requireAuth: vi.fn(async (c: any, next: any) => {
    c.set("auth", {
      userId: "user-1",
      user: { id: "user-1", email: "test@example.com", name: "Test" },
      activeOrganizationId: MOCK_ORG_ID,
    });
    await next();
  }),
  requireOrganization: vi.fn(async (c: any, next: any) => {
    c.set("organizationId", MOCK_ORG_ID);
    await next();
  }),
}));

const { dashboard } = await import("./dashboard");

describe("dashboard routes", () => {
  describe("GET /usage", () => {
    it("returns 200 with zeroed-out usage metrics scoped to the organization", async () => {
      const res = await dashboard.request("/usage");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({
        organizationId: MOCK_ORG_ID,
        instances: 0,
        uptimeHours: 0,
        agentRuns: 0,
        storageUsedGb: 0,
      });
    });
  });
});
