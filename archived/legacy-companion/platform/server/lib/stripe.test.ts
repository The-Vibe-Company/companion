/**
 * Tests for server/lib/stripe.ts — Stripe billing integration.
 *
 * The Stripe constructor is fully mocked so no real API calls are made.
 *
 * Because `PRICE_IDS` is populated at module load time from `process.env`,
 * and the Stripe client uses a lazy singleton (`_stripe`), ALL tests use
 * `vi.resetModules()` + dynamic `import()` to get a fresh module with the
 * correct env vars already set.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ─── Mock Stripe SDK ────────────────────────────────────────────────────────

const mockCheckoutSessionsCreate = vi.fn();
const mockBillingPortalSessionsCreate = vi.fn();
const mockCustomersCreate = vi.fn();
const mockWebhooksConstructEvent = vi.fn();

vi.mock("stripe", () => {
  const MockStripe = vi.fn().mockImplementation(() => ({
    checkout: { sessions: { create: mockCheckoutSessionsCreate } },
    billingPortal: { sessions: { create: mockBillingPortalSessionsCreate } },
    customers: { create: mockCustomersCreate },
    webhooks: { constructEvent: mockWebhooksConstructEvent },
  }));
  return { default: MockStripe };
});

// ─── Env helpers ────────────────────────────────────────────────────────────

const ENV_DEFAULTS = {
  STRIPE_SECRET_KEY: "sk_test_fake_key",
  STRIPE_WEBHOOK_SECRET: "whsec_test_fake_secret",
  STRIPE_PRICE_STARTER: "price_starter_123",
  STRIPE_PRICE_PRO: "price_pro_456",
  STRIPE_PRICE_ENTERPRISE: "price_enterprise_789",
};

/** Snapshot of env vars we touch so we can restore them in afterEach. */
let savedEnv: Record<string, string | undefined> = {};

function setEnvVars(overrides: Partial<typeof ENV_DEFAULTS> = {}) {
  const vars = { ...ENV_DEFAULTS, ...overrides };
  for (const [key, value] of Object.entries(vars)) {
    process.env[key] = value;
  }
}

/** Helper: dynamically import a fresh stripe module with current env vars. */
async function freshImport() {
  vi.resetModules();
  return import("./stripe.js");
}

beforeEach(() => {
  // Save originals so we can restore them after each test.
  savedEnv = {};
  for (const key of Object.keys(ENV_DEFAULTS)) {
    savedEnv[key] = process.env[key];
  }

  setEnvVars();
  vi.clearAllMocks();
});

afterEach(() => {
  // Restore env vars to pre-test state.
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

// ─── Tests ──────────────────────────────────────────────────────────────────
// Every test uses freshImport() so that PRICE_IDS are populated from the
// current process.env values (set in beforeEach).

describe("stripe", () => {
  // ── createCheckoutSession ───────────────────────────────────────────────

  describe("createCheckoutSession", () => {
    it("calls checkout.sessions.create with correct params and returns the session URL", async () => {
      const { createCheckoutSession } = await freshImport();

      mockCheckoutSessionsCreate.mockResolvedValueOnce({
        url: "https://checkout.stripe.com/session_abc",
      });

      const url = await createCheckoutSession({
        customerId: "cus_123",
        plan: "pro",
        successUrl: "https://app.example.com/success",
        cancelUrl: "https://app.example.com/cancel",
      });

      expect(url).toBe("https://checkout.stripe.com/session_abc");
      expect(mockCheckoutSessionsCreate).toHaveBeenCalledOnce();
      expect(mockCheckoutSessionsCreate).toHaveBeenCalledWith({
        mode: "subscription",
        customer: "cus_123",
        customer_email: undefined, // customerId is truthy so email is omitted
        line_items: [{ price: "price_pro_456", quantity: 1 }],
        success_url: "https://app.example.com/success",
        cancel_url: "https://app.example.com/cancel",
        metadata: { plan: "pro" },
      });
    });

    it("passes customer_email when customerId is empty", async () => {
      const { createCheckoutSession } = await freshImport();

      mockCheckoutSessionsCreate.mockResolvedValueOnce({
        url: "https://checkout.stripe.com/session_def",
      });

      await createCheckoutSession({
        customerId: "",
        plan: "starter",
        successUrl: "https://app.example.com/success",
        cancelUrl: "https://app.example.com/cancel",
        customerEmail: "user@example.com",
      });

      expect(mockCheckoutSessionsCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          customer: undefined, // empty string becomes undefined
          customer_email: "user@example.com",
        }),
      );
    });

    it("throws for an unknown plan", async () => {
      const { createCheckoutSession } = await freshImport();

      // PRICE_IDS won't have a key for "nonexistent", so the function should
      // throw before ever calling the Stripe API.
      await expect(
        createCheckoutSession({
          customerId: "cus_123",
          plan: "nonexistent",
          successUrl: "https://app.example.com/success",
          cancelUrl: "https://app.example.com/cancel",
        }),
      ).rejects.toThrow("Unknown plan: nonexistent");

      expect(mockCheckoutSessionsCreate).not.toHaveBeenCalled();
    });

    it("throws when price env var is an empty string", async () => {
      // Even when the plan key exists, an empty/whitespace price ID should
      // be rejected to avoid sending invalid IDs to Stripe.
      delete process.env.STRIPE_PRICE_STARTER;
      const mod = await freshImport();

      await expect(
        mod.createCheckoutSession({
          customerId: "cus_123",
          plan: "starter",
          successUrl: "https://app.example.com/success",
          cancelUrl: "https://app.example.com/cancel",
        }),
      ).rejects.toThrow("Unknown plan: starter");
    });
  });

  // ── createPortalSession ─────────────────────────────────────────────────

  describe("createPortalSession", () => {
    it("calls billingPortal.sessions.create and returns the portal URL", async () => {
      const { createPortalSession } = await freshImport();

      mockBillingPortalSessionsCreate.mockResolvedValueOnce({
        url: "https://billing.stripe.com/portal_xyz",
      });

      const url = await createPortalSession(
        "cus_456",
        "https://app.example.com/settings",
      );

      expect(url).toBe("https://billing.stripe.com/portal_xyz");
      expect(mockBillingPortalSessionsCreate).toHaveBeenCalledOnce();
      expect(mockBillingPortalSessionsCreate).toHaveBeenCalledWith({
        customer: "cus_456",
        return_url: "https://app.example.com/settings",
      });
    });
  });

  // ── createCustomer ──────────────────────────────────────────────────────

  describe("createCustomer", () => {
    it("calls customers.create and returns the new customer ID", async () => {
      const { createCustomer } = await freshImport();

      mockCustomersCreate.mockResolvedValueOnce({ id: "cus_new_789" });

      const id = await createCustomer("new@example.com", "New User");

      expect(id).toBe("cus_new_789");
      expect(mockCustomersCreate).toHaveBeenCalledOnce();
      expect(mockCustomersCreate).toHaveBeenCalledWith({
        email: "new@example.com",
        name: "New User",
      });
    });

    it("works without an optional name", async () => {
      const { createCustomer } = await freshImport();

      mockCustomersCreate.mockResolvedValueOnce({ id: "cus_no_name" });

      const id = await createCustomer("anon@example.com");

      expect(id).toBe("cus_no_name");
      expect(mockCustomersCreate).toHaveBeenCalledWith({
        email: "anon@example.com",
        name: undefined,
      });
    });
  });

  // ── constructWebhookEvent ───────────────────────────────────────────────

  describe("constructWebhookEvent", () => {
    it("calls webhooks.constructEvent with the payload, signature, and webhook secret", async () => {
      const { constructWebhookEvent } = await freshImport();

      const fakeEvent = { id: "evt_123", type: "checkout.session.completed" };
      mockWebhooksConstructEvent.mockReturnValueOnce(fakeEvent);

      const event = constructWebhookEvent(
        '{"raw":"payload"}',
        "sig_header_value",
      );

      expect(event).toEqual(fakeEvent);
      expect(mockWebhooksConstructEvent).toHaveBeenCalledOnce();
      expect(mockWebhooksConstructEvent).toHaveBeenCalledWith(
        '{"raw":"payload"}',
        "sig_header_value",
        "whsec_test_fake_secret", // from ENV_DEFAULTS
      );
    });
  });

  // ── Missing env var error paths ─────────────────────────────────────────

  describe("missing STRIPE_SECRET_KEY", () => {
    it("throws when STRIPE_SECRET_KEY is not set (triggered via createCheckoutSession)", async () => {
      delete process.env.STRIPE_SECRET_KEY;
      const mod = await freshImport();

      await expect(
        mod.createCheckoutSession({
          customerId: "cus_123",
          plan: "starter",
          successUrl: "https://example.com/ok",
          cancelUrl: "https://example.com/cancel",
        }),
      ).rejects.toThrow("STRIPE_SECRET_KEY is not set");
    });
  });

  describe("missing STRIPE_WEBHOOK_SECRET", () => {
    it("throws when STRIPE_WEBHOOK_SECRET is not set (triggered via constructWebhookEvent)", async () => {
      delete process.env.STRIPE_WEBHOOK_SECRET;
      const mod = await freshImport();

      expect(() =>
        mod.constructWebhookEvent('{"data":"test"}', "sig_test"),
      ).toThrow("STRIPE_WEBHOOK_SECRET is not set");
    });
  });
});
