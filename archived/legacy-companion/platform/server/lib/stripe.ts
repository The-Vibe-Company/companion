/**
 * Stripe integration for billing and subscriptions.
 *
 * Handles checkout sessions, customer portal, and webhook events.
 * Stripe client is lazily initialized to avoid crashing at import time
 * when env vars are not set (e.g. during tests or local dev).
 */

import Stripe from "stripe";

// ─── Env validation ─────────────────────────────────────────────────────────

function getStripeKey(): string {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    throw new Error(
      "STRIPE_SECRET_KEY is not set. Configure it before starting the server.",
    );
  }
  return key;
}

function getWebhookSecret(): string {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    throw new Error(
      "STRIPE_WEBHOOK_SECRET is not set. Configure it to verify webhook signatures.",
    );
  }
  return secret;
}

// Lazy singleton — initialized on first use, not at import time.
let _stripe: Stripe | null = null;
function getStripe(): Stripe {
  if (!_stripe) {
    _stripe = new Stripe(getStripeKey(), {
      apiVersion: "2025-02-24.acacia",
    });
  }
  return _stripe;
}

// ─── Price IDs (configure in Stripe Dashboard) ──────────────────────────────

const PRICE_IDS: Record<string, string> = {
  starter: process.env.STRIPE_PRICE_STARTER || "",
  pro: process.env.STRIPE_PRICE_PRO || "",
  enterprise: process.env.STRIPE_PRICE_ENTERPRISE || "",
};

// ─── Checkout ────────────────────────────────────────────────────────────────

export async function createCheckoutSession(opts: {
  customerId: string;
  plan: string;
  successUrl: string;
  cancelUrl: string;
  customerEmail?: string;
}): Promise<string> {
  const priceId = PRICE_IDS[opts.plan];
  if (!priceId?.trim()) throw new Error(`Unknown plan: ${opts.plan}`);

  const session = await getStripe().checkout.sessions.create({
    mode: "subscription",
    customer: opts.customerId || undefined,
    customer_email: opts.customerId ? undefined : opts.customerEmail,
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: opts.successUrl,
    cancel_url: opts.cancelUrl,
    metadata: { plan: opts.plan },
  });

  return session.url!;
}

// ─── Customer Portal ─────────────────────────────────────────────────────────

export async function createPortalSession(
  stripeCustomerId: string,
  returnUrl: string,
): Promise<string> {
  const session = await getStripe().billingPortal.sessions.create({
    customer: stripeCustomerId,
    return_url: returnUrl,
  });
  return session.url;
}

// ─── Customer ────────────────────────────────────────────────────────────────

export async function createCustomer(
  email: string,
  name?: string,
): Promise<string> {
  const customer = await getStripe().customers.create({ email, name });
  return customer.id;
}

// ─── Webhook verification ────────────────────────────────────────────────────

export function constructWebhookEvent(
  payload: string,
  signature: string,
): Stripe.Event {
  return getStripe().webhooks.constructEvent(
    payload,
    signature,
    getWebhookSecret(),
  );
}

export { getStripe as stripe };
