import { Hono } from "hono";
import {
  requireAuth,
  requireOrganization,
  type AuthEnv,
} from "../middleware/auth.js";

/**
 * Billing routes for Stripe integration.
 *
 * Billing is scoped to the active organization — each organization has its
 * own Stripe customer and subscription via the organizationBilling table.
 *
 * POST /billing/checkout  — Create Stripe Checkout Session for the org
 * POST /billing/portal    — Create Stripe Customer Portal link for the org
 * POST /webhooks/stripe   — Handle Stripe webhook events (no auth, uses Stripe signature)
 */

const billing = new Hono<AuthEnv>();

// Billing routes require auth + active organization.
billing.use("/*", requireAuth, requireOrganization);

billing.post("/checkout", async (c) => {
  const orgId = c.get("organizationId");
  // TODO: Look up organizationBilling by orgId, create Stripe Checkout
  return c.json({ url: "https://checkout.stripe.com/...", organizationId: orgId });
});

billing.post("/portal", async (c) => {
  const orgId = c.get("organizationId");
  // TODO: Look up organizationBilling.stripeCustomerId by orgId, create portal session
  return c.json({ url: "https://billing.stripe.com/...", organizationId: orgId });
});

export { billing };

// ─── Stripe Webhook Handler ──────────────────────────────────────────────────
// Webhooks do NOT require auth — they use Stripe's webhook signature for verification.

export const stripeWebhook = new Hono();

stripeWebhook.post("/stripe", async (c) => {
  // TODO: Verify Stripe signature, handle events:
  // - checkout.session.completed → provision instance for the org
  // - invoice.paid → keep active
  // - invoice.payment_failed → grace period
  // - customer.subscription.deleted → schedule destruction
  return c.json({ received: true });
});
