import { describe, it, expect, vi } from "vitest";

/**
 * Tests for billing routes.
 *
 * Auth middleware is mocked to inject org context. The Stripe webhook handler
 * does NOT require auth (uses Stripe signature verification instead).
 */

const MOCK_ORG_ID = "org-billing-1";

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

const { billing, stripeWebhook } = await import("./billing");

describe("billing routes", () => {
  describe("POST /checkout", () => {
    it("returns 200 with a Stripe checkout URL and organization context", async () => {
      const res = await billing.request("/checkout", { method: "POST" });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.url).toContain("checkout.stripe.com");
      expect(body.organizationId).toBe(MOCK_ORG_ID);
    });
  });

  describe("POST /portal", () => {
    it("returns 200 with a Stripe billing portal URL and organization context", async () => {
      const res = await billing.request("/portal", { method: "POST" });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.url).toContain("billing.stripe.com");
      expect(body.organizationId).toBe(MOCK_ORG_ID);
    });
  });
});

describe("stripeWebhook routes", () => {
  // Webhook routes do NOT use auth middleware — they verify via Stripe signature.
  describe("POST /stripe", () => {
    it("returns 200 with { received: true }", async () => {
      const res = await stripeWebhook.request("/stripe", { method: "POST" });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({ received: true });
    });
  });
});
