import { describe, it, expect, vi } from "vitest";

/**
 * Tests for Tailscale management routes.
 *
 * Auth middleware is mocked to inject org context.
 */

vi.mock("../middleware/auth.js", () => ({
  requireAuth: vi.fn(async (c: any, next: any) => {
    c.set("auth", {
      userId: "user-1",
      user: { id: "user-1", email: "test@example.com", name: "Test" },
      activeOrganizationId: "org-ts-1",
    });
    await next();
  }),
  requireOrganization: vi.fn(async (c: any, next: any) => {
    c.set("organizationId", "org-ts-1");
    await next();
  }),
}));

const { tailscale } = await import("./tailscale");

describe("tailscale routes", () => {
  describe("POST /enable", () => {
    it("returns 200 with an enabling message", async () => {
      const res = await tailscale.request("/enable", { method: "POST" });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({ message: "Tailscale enabling" });
    });
  });

  describe("POST /disable", () => {
    it("returns 200 with a disabling message", async () => {
      const res = await tailscale.request("/disable", { method: "POST" });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({ message: "Tailscale disabling" });
    });
  });

  describe("GET /status", () => {
    it("returns 200 with disabled status and null hostname", async () => {
      const res = await tailscale.request("/status");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({ enabled: false, hostname: null });
    });
  });
});
