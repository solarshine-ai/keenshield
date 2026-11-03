// ============================================================
// KEENSHIELD — netlify/functions/stripe-webhook.ts
//
// Stripe calls this after every billing event. It turns on Pro or
// Family, adds single document review credits, and takes them away
// again on cancellation or refund. The logic lives in
// lib/stripe-webhook.js; this file wires in the real database and
// Stripe API key.
//
// Required environment variables (never hardcode them):
//   STRIPE_WEBHOOK_SECRET — the endpoint's signing secret (whsec_…)
//   STRIPE_SECRET_KEY     — used to read what a checkout bought
// ============================================================

import { billingStore } from "../../db/billing.js";
import { fetchCheckoutLineItems, handleStripeWebhook } from "../../lib/stripe-webhook.js";

export default async (request: Request) => {
  if (request.method !== "POST") {
    return Response.json({ error: "Method Not Allowed" }, { status: 405 });
  }

  // The signature covers the exact bytes Stripe sent, so the body must be
  // read as raw text and never re-serialized before checking it.
  const rawBody = await request.text();

  try {
    const result = await handleStripeWebhook({
      rawBody,
      signatureHeader: request.headers.get("stripe-signature"),
      webhookSecret: process.env.STRIPE_WEBHOOK_SECRET,
      store: billingStore,
      fetchLineItems: (sessionId: string) =>
        fetchCheckoutLineItems(sessionId, { secretKey: process.env.STRIPE_SECRET_KEY })
    });

    // Log and reply with what changed, but not the buyer's email: Stripe keeps
    // webhook responses in its dashboard.
    const { email: _email, ...logged } = result.body as Record<string, unknown>;
    if (logged.applied) console.log("stripe-webhook:", JSON.stringify(logged));

    return Response.json(logged, { status: result.status });
  } catch (err) {
    // Nothing was committed. A non-2xx response makes Stripe retry the event.
    console.error("stripe-webhook: failed to process event:", err);
    return Response.json({ error: "Processing failed" }, { status: 500 });
  }
};

export const config = {
  path: "/api/stripe-webhook"
};
