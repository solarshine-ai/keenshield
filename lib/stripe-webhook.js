// ============================================================
// KEENSHIELD — lib/stripe-webhook.js
//
// Everything the Stripe webhook decides, kept free of Netlify and
// database specifics so it can be tested directly:
//
//   - verifying Stripe's signature on the raw request body
//   - working out what a checkout bought (Pro, Family, or a single
//     document review credit)
//   - turning each event into changes to what a person has access to,
//     exactly once per event
//
// The function in netlify/functions/stripe-webhook.ts supplies the
// real database (db/billing.ts) and Stripe API calls.
// ============================================================

import { createHmac, timingSafeEqual } from "node:crypto";
import { normalizeEmail } from "./entitlements.js";

// Prices on the Stripe payment links, in cents. A subscription is matched to
// a plan by its price and billing interval first, then by product name, so a
// renamed product or a changed price still lands on the right plan as long as
// one of the two lines up.
export const SUBSCRIPTION_PLANS = [
  { plan: "pro", interval: "month", amount: 499 },
  { plan: "pro", interval: "year", amount: 3999 },
  { plan: "family", interval: "month", amount: 599 },
  { plan: "family", interval: "year", amount: 5999 }
];

export const DOCUMENT_REVIEW_AMOUNT = 199;

// Stripe's own default. Older signed payloads are refused so a captured
// request can't be replayed later.
const SIGNATURE_TOLERANCE_SECONDS = 300;

export const HANDLED_EVENTS = [
  "checkout.session.completed",
  "checkout.session.async_payment_succeeded",
  "customer.subscription.deleted",
  "charge.refunded"
];

// -----------------------------------------------------------
// Signature
//
// Stripe signs `${timestamp}.${rawBody}` with HMAC-SHA256 using the
// endpoint's signing secret and sends it as
//   Stripe-Signature: t=1700000000,v1=<hex>[,v1=<hex>...]
// Several v1 values appear while a secret is being rolled; any one
// matching is enough.
// -----------------------------------------------------------
export function verifyStripeSignature(payload, header, secret, options = {}) {
  const toleranceSeconds = options.toleranceSeconds ?? SIGNATURE_TOLERANCE_SECONDS;
  const nowSeconds = Math.floor((options.now ?? Date.now()) / 1000);

  if (typeof secret !== "string" || !secret) return { ok: false, reason: "not-configured" };
  if (typeof header !== "string" || !header) return { ok: false, reason: "missing-signature" };
  if (typeof payload !== "string") return { ok: false, reason: "invalid-payload" };

  let timestamp = null;
  const signatures = [];
  for (const part of header.split(",")) {
    const separator = part.indexOf("=");
    if (separator === -1) continue;
    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (key === "t") timestamp = value;
    if (key === "v1" && value) signatures.push(value);
  }

  if (!timestamp || !/^\d+$/.test(timestamp) || signatures.length === 0) {
    return { ok: false, reason: "malformed-signature" };
  }

  if (Math.abs(nowSeconds - Number(timestamp)) > toleranceSeconds) {
    return { ok: false, reason: "timestamp-out-of-range" };
  }

  const expected = Buffer.from(
    createHmac("sha256", secret).update(`${timestamp}.${payload}`, "utf8").digest("hex"),
    "utf8"
  );

  const matched = signatures.some((signature) => {
    const provided = Buffer.from(signature, "utf8");
    return provided.length === expected.length && timingSafeEqual(provided, expected);
  });

  return matched ? { ok: true } : { ok: false, reason: "signature-mismatch" };
}

// Builds a valid Stripe-Signature header. Used by the tests, and handy for
// sending yourself a signed test event.
export function signStripePayload(payload, secret, timestampSeconds = Math.floor(Date.now() / 1000)) {
  const signature = createHmac("sha256", secret).update(`${timestampSeconds}.${payload}`, "utf8").digest("hex");
  return `t=${timestampSeconds},v1=${signature}`;
}

// -----------------------------------------------------------
// What did this checkout buy?
// -----------------------------------------------------------
function productNameOf(item) {
  const product = item && item.price && item.price.product;
  const productName = product && typeof product === "object" ? product.name : "";
  return `${item.description || ""} ${productName || ""}`.toLowerCase();
}

export function classifySubscriptionItem(item) {
  const price = (item && item.price) || {};
  const interval = price.recurring && price.recurring.interval;
  if (interval !== "month" && interval !== "year") return null;

  const byPrice = SUBSCRIPTION_PLANS.find(
    (entry) => entry.amount === price.unit_amount && entry.interval === interval
  );
  if (byPrice) return { plan: byPrice.plan, interval };

  const name = productNameOf(item);
  if (/\bfamily\b/.test(name)) return { plan: "family", interval };
  if (/\bpro\b/.test(name)) return { plan: "pro", interval };
  return null;
}

// Returns one of:
//   { kind: "plan", plan: "pro" | "family", interval: "month" | "year" }
//   { kind: "document", credits: n }
//   null when it can't be matched
export function classifyCheckout(session, lineItems) {
  const items = Array.isArray(lineItems) ? lineItems : [];

  if (session.mode === "subscription") {
    // Family outranks Pro if a checkout somehow carries both.
    const matches = items.map(classifySubscriptionItem).filter(Boolean);
    const match = matches.find((m) => m.plan === "family") || matches[0];
    return match ? { kind: "plan", ...match } : null;
  }

  if (session.mode === "payment") {
    // The only one-time purchase Keenshield sells is the single document
    // review, so every unit bought is one credit.
    const credits = items.reduce((sum, item) => sum + (Number(item.quantity) > 0 ? Number(item.quantity) : 1), 0);
    return { kind: "document", credits: credits || 1 };
  }

  return null;
}

function idOf(value) {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && typeof value.id === "string") return value.id;
  return null;
}

// -----------------------------------------------------------
// Stripe API
// -----------------------------------------------------------
export async function fetchCheckoutLineItems(sessionId, { secretKey, fetchImpl = fetch } = {}) {
  if (!secretKey) throw new Error("STRIPE_SECRET_KEY is not set");

  const url =
    `https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sessionId)}/line_items` +
    `?limit=100&expand%5B%5D=data.price.product`;
  const response = await fetchImpl(url, { headers: { Authorization: `Bearer ${secretKey}` } });

  if (!response.ok) {
    throw new Error(`Stripe line items request failed with status ${response.status}`);
  }

  const data = await response.json();
  return Array.isArray(data && data.data) ? data.data : [];
}

// -----------------------------------------------------------
// The handler
//
// `store.transaction(fn)` runs fn with a set of operations inside one
// database transaction:
//   recordEvent(id, type)            -> true if new, false if already seen
//   grantPlan({ email, plan, interval, customerId, subscriptionId })
//   addDocumentCredits({ email, credits, checkoutSessionId, paymentIntentId }) -> true if added
//   endPlanBySubscription(subscriptionId) -> number of accounts changed
//   endPlanByCustomer(customerId)         -> number of accounts changed
//   refundDocumentCredits(paymentIntentId) -> number of credits removed
//
// Recording the event and applying its effect commit together, so a crash
// halfway leaves neither behind and Stripe's retry does the whole thing.
// -----------------------------------------------------------
export async function handleStripeWebhook({
  rawBody,
  signatureHeader,
  webhookSecret,
  store,
  fetchLineItems,
  now,
  log = console
}) {
  if (!webhookSecret) {
    log.error("stripe-webhook: STRIPE_WEBHOOK_SECRET is not set");
    // 500 so Stripe keeps retrying until the secret is configured.
    return { status: 500, body: { error: "Webhook not configured" } };
  }

  const verification = verifyStripeSignature(rawBody, signatureHeader, webhookSecret, { now });
  if (!verification.ok) {
    log.warn(`stripe-webhook: rejected request (${verification.reason})`);
    return { status: 400, body: { error: "Invalid signature" } };
  }

  let event;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return { status: 400, body: { error: "Invalid JSON" } };
  }

  if (!event || typeof event.id !== "string" || typeof event.type !== "string") {
    return { status: 400, body: { error: "Invalid event" } };
  }

  if (!HANDLED_EVENTS.includes(event.type)) {
    return { status: 200, body: { received: true, ignored: true } };
  }

  const object = (event.data && event.data.object) || {};

  // Anything that needs Stripe's API happens before the transaction opens, so
  // a slow or failing API call never holds a database transaction.
  let purchase = null;
  if (event.type.startsWith("checkout.session.")) {
    const paid = object.payment_status === "paid" || object.payment_status === "no_payment_required";
    if (!paid) {
      // Bank debits and similar settle later; Stripe then sends
      // checkout.session.async_payment_succeeded, which grants access.
      return { status: 200, body: { received: true, pending: true } };
    }
    const lineItems = await fetchLineItems(object.id);
    purchase = classifyCheckout(object, lineItems);
  }

  const outcome = await store.transaction(async (tx) => {
    if (!(await tx.recordEvent(event.id, event.type))) {
      return { duplicate: true };
    }

    switch (event.type) {
      case "checkout.session.completed":
      case "checkout.session.async_payment_succeeded": {
        const email = normalizeEmail(
          (object.customer_details && object.customer_details.email) || object.customer_email
        );
        if (!email) {
          log.error(`stripe-webhook: checkout ${object.id} (event ${event.id}) has no buyer email; grant it by hand`);
          return { applied: "none", reason: "no-email" };
        }
        if (!purchase) {
          log.error(`stripe-webhook: checkout ${object.id} (event ${event.id}) did not match a Keenshield plan; grant it by hand`);
          return { applied: "none", reason: "unknown-product" };
        }

        if (purchase.kind === "plan") {
          await tx.grantPlan({
            email,
            plan: purchase.plan,
            interval: purchase.interval,
            customerId: idOf(object.customer),
            subscriptionId: idOf(object.subscription)
          });
          return { applied: "plan", email, plan: purchase.plan, interval: purchase.interval };
        }

        const added = await tx.addDocumentCredits({
          email,
          credits: purchase.credits,
          checkoutSessionId: object.id,
          paymentIntentId: idOf(object.payment_intent)
        });
        return { applied: added ? "credit" : "none", email, credits: purchase.credits };
      }

      case "customer.subscription.deleted": {
        const changed = await tx.endPlanBySubscription(object.id);
        return { applied: changed ? "plan-ended" : "none" };
      }

      case "charge.refunded": {
        // Stripe sends this for partial refunds too. Access only goes away when
        // the whole charge has been refunded.
        if (object.refunded !== true) {
          return { applied: "none", reason: "partial-refund" };
        }

        // A refunded single-document payment removes that credit. Any other
        // fully refunded charge from a subscriber (a Pro or Family payment)
        // ends their plan.
        const paymentIntentId = idOf(object.payment_intent);
        const removed = paymentIntentId ? await tx.refundDocumentCredits(paymentIntentId) : 0;
        if (removed) return { applied: "credit-removed", credits: removed };

        const customerId = idOf(object.customer);
        const changed = customerId ? await tx.endPlanByCustomer(customerId) : 0;
        return { applied: changed ? "plan-ended" : "none" };
      }
    }

    return { applied: "none" };
  });

  if (outcome.duplicate) {
    return { status: 200, body: { received: true, duplicate: true } };
  }

  return { status: 200, body: { received: true, ...outcome } };
}
