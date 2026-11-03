import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  classifyCheckout,
  fetchCheckoutLineItems,
  handleStripeWebhook,
  signStripePayload,
  verifyStripeSignature
} from "../lib/stripe-webhook.js";
import { accountSummary, documentAccessFor, hasActivePlan, normalizeEmail } from "../lib/entitlements.js";

const SECRET = "whsec_test_secret_for_unit_tests";
const NOW = 1_800_000_000_000;
const NOW_SECONDS = NOW / 1000;
const silentLog = { error() {}, warn() {}, log() {} };

// In-memory stand-in for db/billing.ts, with the same rules: events are
// recorded once, credit purchases are unique per checkout session, and a
// transaction that throws leaves nothing behind.
function createMemoryStore() {
  const state = { events: new Map(), accounts: new Map(), purchases: [] };

  function account(email) {
    if (!state.accounts.has(email)) {
      state.accounts.set(email, {
        email,
        plan: null,
        planInterval: null,
        planActive: false,
        stripeCustomerId: null,
        stripeSubscriptionId: null,
        documentCredits: 0
      });
    }
    return state.accounts.get(email);
  }

  const ops = {
    async recordEvent(id, type) {
      if (state.events.has(id)) return false;
      state.events.set(id, type);
      return true;
    },
    async grantPlan({ email, plan, interval, customerId, subscriptionId }) {
      Object.assign(account(email), {
        plan,
        planInterval: interval,
        planActive: true,
        stripeCustomerId: customerId,
        stripeSubscriptionId: subscriptionId
      });
    },
    async addDocumentCredits({ email, credits, checkoutSessionId, paymentIntentId }) {
      if (state.purchases.some((p) => p.checkoutSessionId === checkoutSessionId)) return false;
      state.purchases.push({ email, credits, checkoutSessionId, paymentIntentId, refunded: false });
      account(email).documentCredits += credits;
      return true;
    },
    async endPlanBySubscription(subscriptionId) {
      let changed = 0;
      for (const a of state.accounts.values()) {
        if (a.stripeSubscriptionId === subscriptionId && a.planActive) {
          a.planActive = false;
          changed++;
        }
      }
      return changed;
    },
    async endPlanByCustomer(customerId) {
      let changed = 0;
      for (const a of state.accounts.values()) {
        if (a.stripeCustomerId === customerId && a.planActive) {
          a.planActive = false;
          changed++;
        }
      }
      return changed;
    },
    async refundDocumentCredits(paymentIntentId) {
      let removed = 0;
      for (const p of state.purchases) {
        if (p.paymentIntentId === paymentIntentId && !p.refunded) {
          p.refunded = true;
          const a = account(p.email);
          a.documentCredits = Math.max(0, a.documentCredits - p.credits);
          removed += p.credits;
        }
      }
      return removed;
    }
  };

  return {
    state,
    async transaction(fn) {
      const snapshot = structuredClone({
        events: [...state.events],
        accounts: [...state.accounts],
        purchases: state.purchases
      });
      try {
        return await fn(ops);
      } catch (err) {
        state.events = new Map(snapshot.events);
        state.accounts = new Map(snapshot.accounts);
        state.purchases = snapshot.purchases;
        throw err;
      }
    }
  };
}

const LINE_ITEMS = {
  cs_pro_month: [{ quantity: 1, description: "Keenshield Pro", price: { unit_amount: 499, recurring: { interval: "month" } } }],
  cs_pro_year: [{ quantity: 1, description: "Keenshield Pro", price: { unit_amount: 3999, recurring: { interval: "year" } } }],
  cs_family_month: [{ quantity: 1, description: "Keenshield Family", price: { unit_amount: 599, recurring: { interval: "month" } } }],
  cs_family_year: [{ quantity: 1, description: "Keenshield Family", price: { unit_amount: 5999, recurring: { interval: "year" } } }],
  cs_doc: [{ quantity: 1, description: "Single document review", price: { unit_amount: 199, recurring: null } }]
};

function checkoutEvent(id, sessionId, overrides = {}) {
  const isDoc = sessionId.startsWith("cs_doc");
  return {
    id,
    type: "checkout.session.completed",
    data: {
      object: {
        id: sessionId,
        object: "checkout.session",
        mode: isDoc ? "payment" : "subscription",
        payment_status: "paid",
        customer: "cus_123",
        subscription: isDoc ? null : `sub_${sessionId}`,
        payment_intent: isDoc ? `pi_${sessionId}` : null,
        customer_details: { email: "Buyer@Example.com " },
        ...overrides
      }
    }
  };
}

async function deliver(store, event, { secret = SECRET, header, fetchLineItems } = {}) {
  const rawBody = JSON.stringify(event);
  return handleStripeWebhook({
    rawBody,
    signatureHeader: header === undefined ? signStripePayload(rawBody, secret, NOW_SECONDS) : header,
    webhookSecret: SECRET,
    store,
    fetchLineItems: fetchLineItems || (async (sessionId) => LINE_ITEMS[sessionId] || []),
    now: NOW,
    log: silentLog
  });
}

describe("verifyStripeSignature", () => {
  const payload = '{"id":"evt_1"}';

  test("accepts a correctly signed payload", () => {
    const header = signStripePayload(payload, SECRET, NOW_SECONDS);
    assert.deepEqual(verifyStripeSignature(payload, header, SECRET, { now: NOW }), { ok: true });
  });

  test("accepts when any one of several v1 signatures matches (secret rollover)", () => {
    const good = signStripePayload(payload, SECRET, NOW_SECONDS).split(",")[1];
    const header = `t=${NOW_SECONDS},v1=${"0".repeat(64)},${good}`;
    assert.equal(verifyStripeSignature(payload, header, SECRET, { now: NOW }).ok, true);
  });

  test("rejects a missing header", () => {
    assert.equal(verifyStripeSignature(payload, null, SECRET, { now: NOW }).reason, "missing-signature");
    assert.equal(verifyStripeSignature(payload, "", SECRET, { now: NOW }).reason, "missing-signature");
  });

  test("rejects a signature made with a different secret", () => {
    const header = signStripePayload(payload, "whsec_someone_else", NOW_SECONDS);
    assert.equal(verifyStripeSignature(payload, header, SECRET, { now: NOW }).reason, "signature-mismatch");
  });

  test("rejects a body changed after signing", () => {
    const header = signStripePayload(payload, SECRET, NOW_SECONDS);
    assert.equal(verifyStripeSignature('{"id":"evt_2"}', header, SECRET, { now: NOW }).ok, false);
  });

  test("rejects an old timestamp (replay)", () => {
    const header = signStripePayload(payload, SECRET, NOW_SECONDS - 301);
    assert.equal(verifyStripeSignature(payload, header, SECRET, { now: NOW }).reason, "timestamp-out-of-range");
  });

  test("rejects malformed headers without throwing", () => {
    for (const header of ["garbage", "t=abc,v1=xyz", `t=${NOW_SECONDS}`, "v1=abc", `t=${NOW_SECONDS},v1=short`]) {
      assert.equal(verifyStripeSignature(payload, header, SECRET, { now: NOW }).ok, false, header);
    }
  });

  test("never matches when the secret is not configured", () => {
    const header = signStripePayload(payload, "", NOW_SECONDS);
    assert.equal(verifyStripeSignature(payload, header, "", { now: NOW }).reason, "not-configured");
    assert.equal(verifyStripeSignature(payload, header, undefined, { now: NOW }).reason, "not-configured");
  });
});

describe("classifyCheckout", () => {
  test("matches each subscription price to its plan", () => {
    assert.deepEqual(classifyCheckout({ mode: "subscription" }, LINE_ITEMS.cs_pro_month), { kind: "plan", plan: "pro", interval: "month" });
    assert.deepEqual(classifyCheckout({ mode: "subscription" }, LINE_ITEMS.cs_pro_year), { kind: "plan", plan: "pro", interval: "year" });
    assert.deepEqual(classifyCheckout({ mode: "subscription" }, LINE_ITEMS.cs_family_month), { kind: "plan", plan: "family", interval: "month" });
    assert.deepEqual(classifyCheckout({ mode: "subscription" }, LINE_ITEMS.cs_family_year), { kind: "plan", plan: "family", interval: "year" });
  });

  test("falls back to the product name when the price changes", () => {
    const items = [{ description: "", price: { unit_amount: 6999, recurring: { interval: "year" }, product: { name: "Keenshield Family" } } }];
    assert.deepEqual(classifyCheckout({ mode: "subscription" }, items), { kind: "plan", plan: "family", interval: "year" });
  });

  test("returns null for a subscription it can't recognise", () => {
    const items = [{ description: "Something else", price: { unit_amount: 1234, recurring: { interval: "month" } } }];
    assert.equal(classifyCheckout({ mode: "subscription" }, items), null);
  });

  test("a one-time payment is document review credits, one per unit", () => {
    assert.deepEqual(classifyCheckout({ mode: "payment" }, LINE_ITEMS.cs_doc), { kind: "document", credits: 1 });
    assert.deepEqual(classifyCheckout({ mode: "payment" }, [{ quantity: 3, price: { unit_amount: 199 } }]), { kind: "document", credits: 3 });
  });
});

describe("handleStripeWebhook: rejecting bad requests", () => {
  test("rejects an unsigned request and changes nothing", async () => {
    const store = createMemoryStore();
    const result = await deliver(store, checkoutEvent("evt_1", "cs_pro_month"), { header: null });
    assert.equal(result.status, 400);
    assert.equal(store.state.events.size, 0);
    assert.equal(store.state.accounts.size, 0);
  });

  test("rejects a request signed with the wrong secret", async () => {
    const store = createMemoryStore();
    const result = await deliver(store, checkoutEvent("evt_1", "cs_pro_month"), { secret: "whsec_wrong" });
    assert.equal(result.status, 400);
    assert.equal(store.state.accounts.size, 0);
  });

  test("returns 500 when STRIPE_WEBHOOK_SECRET is missing, so Stripe retries", async () => {
    const store = createMemoryStore();
    const rawBody = JSON.stringify(checkoutEvent("evt_1", "cs_pro_month"));
    const result = await handleStripeWebhook({
      rawBody,
      signatureHeader: signStripePayload(rawBody, SECRET, NOW_SECONDS),
      webhookSecret: undefined,
      store,
      fetchLineItems: async () => [],
      now: NOW,
      log: silentLog
    });
    assert.equal(result.status, 500);
    assert.equal(store.state.accounts.size, 0);
  });

  test("acknowledges event types it doesn't handle without touching the database", async () => {
    const store = createMemoryStore();
    const result = await deliver(store, { id: "evt_x", type: "invoice.paid", data: { object: {} } });
    assert.equal(result.status, 200);
    assert.equal(result.body.ignored, true);
    assert.equal(store.state.events.size, 0);
  });
});

describe("handleStripeWebhook: checkout.session.completed", () => {
  for (const [sessionId, plan, interval] of [
    ["cs_pro_month", "pro", "month"],
    ["cs_pro_year", "pro", "year"],
    ["cs_family_month", "family", "month"],
    ["cs_family_year", "family", "year"]
  ]) {
    test(`turns on ${plan} (${interval}) for the buyer's email`, async () => {
      const store = createMemoryStore();
      const result = await deliver(store, checkoutEvent("evt_1", sessionId));
      assert.equal(result.status, 200);

      const account = store.state.accounts.get("buyer@example.com");
      assert.equal(account.plan, plan);
      assert.equal(account.planInterval, interval);
      assert.equal(account.planActive, true);
      assert.equal(account.stripeSubscriptionId, `sub_${sessionId}`);
      assert.equal(hasActivePlan(account), true);
    });
  }

  test("adds one document review credit", async () => {
    const store = createMemoryStore();
    await deliver(store, checkoutEvent("evt_1", "cs_doc"));
    const account = store.state.accounts.get("buyer@example.com");
    assert.equal(account.documentCredits, 1);
    assert.equal(account.planActive, false);
    assert.equal(documentAccessFor(account), "credit");
  });

  test("two separate document purchases add two credits", async () => {
    const store = createMemoryStore();
    await deliver(store, checkoutEvent("evt_1", "cs_doc"));
    await deliver(store, checkoutEvent("evt_2", "cs_doc_2"), {
      fetchLineItems: async () => LINE_ITEMS.cs_doc
    });
    assert.equal(store.state.accounts.get("buyer@example.com").documentCredits, 2);
  });

  test("falls back to customer_email when customer_details has none", async () => {
    const store = createMemoryStore();
    await deliver(store, checkoutEvent("evt_1", "cs_pro_month", { customer_details: null, customer_email: "Other@Example.com" }));
    assert.equal(store.state.accounts.get("other@example.com").plan, "pro");
  });

  test("waits for async payments to settle before granting anything", async () => {
    const store = createMemoryStore();
    const pending = await deliver(store, checkoutEvent("evt_1", "cs_pro_month", { payment_status: "unpaid" }));
    assert.equal(pending.body.pending, true);
    assert.equal(store.state.accounts.size, 0);

    const settled = checkoutEvent("evt_2", "cs_pro_month");
    settled.type = "checkout.session.async_payment_succeeded";
    await deliver(store, settled);
    assert.equal(store.state.accounts.get("buyer@example.com").planActive, true);
  });

  test("an unrecognised product grants nothing but is still acknowledged", async () => {
    const store = createMemoryStore();
    const result = await deliver(store, checkoutEvent("evt_1", "cs_unknown"));
    assert.equal(result.status, 200);
    assert.equal(result.body.reason, "unknown-product");
    assert.equal(store.state.accounts.size, 0);
  });

  test("a failed Stripe API call throws, so nothing is recorded and Stripe retries", async () => {
    const store = createMemoryStore();
    await assert.rejects(
      deliver(store, checkoutEvent("evt_1", "cs_pro_month"), {
        fetchLineItems: async () => {
          throw new Error("Stripe is down");
        }
      })
    );
    assert.equal(store.state.events.size, 0);

    // The retry then goes through normally.
    await deliver(store, checkoutEvent("evt_1", "cs_pro_month"));
    assert.equal(store.state.accounts.get("buyer@example.com").planActive, true);
  });
});

describe("handleStripeWebhook: duplicates", () => {
  test("the same document event delivered twice adds only one credit", async () => {
    const store = createMemoryStore();
    const first = await deliver(store, checkoutEvent("evt_dup", "cs_doc"));
    const second = await deliver(store, checkoutEvent("evt_dup", "cs_doc"));
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal(second.body.duplicate, true);
    assert.equal(store.state.accounts.get("buyer@example.com").documentCredits, 1);
  });

  test("the same checkout under two different event IDs still adds only one credit", async () => {
    const store = createMemoryStore();
    await deliver(store, checkoutEvent("evt_a", "cs_doc"));
    const settled = checkoutEvent("evt_b", "cs_doc");
    settled.type = "checkout.session.async_payment_succeeded";
    await deliver(store, settled);
    assert.equal(store.state.accounts.get("buyer@example.com").documentCredits, 1);
  });

  test("a replayed checkout can't turn a cancelled plan back on", async () => {
    const store = createMemoryStore();
    await deliver(store, checkoutEvent("evt_buy", "cs_pro_month"));
    await deliver(store, { id: "evt_cancel", type: "customer.subscription.deleted", data: { object: { id: "sub_cs_pro_month" } } });
    await deliver(store, checkoutEvent("evt_buy", "cs_pro_month"));
    assert.equal(store.state.accounts.get("buyer@example.com").planActive, false);
  });

  test("a duplicate refund removes the credit only once", async () => {
    const store = createMemoryStore();
    await deliver(store, checkoutEvent("evt_1", "cs_doc"));
    await deliver(store, checkoutEvent("evt_2", "cs_doc_2"), { fetchLineItems: async () => LINE_ITEMS.cs_doc });
    const refund = { id: "evt_refund", type: "charge.refunded", data: { object: { id: "ch_1", refunded: true, payment_intent: "pi_cs_doc", customer: "cus_123" } } };
    await deliver(store, refund);
    await deliver(store, refund);
    assert.equal(store.state.accounts.get("buyer@example.com").documentCredits, 1);
  });
});

describe("handleStripeWebhook: turning access off", () => {
  test("customer.subscription.deleted ends the plan", async () => {
    const store = createMemoryStore();
    await deliver(store, checkoutEvent("evt_1", "cs_family_year"));
    const result = await deliver(store, {
      id: "evt_2",
      type: "customer.subscription.deleted",
      data: { object: { id: "sub_cs_family_year", customer: "cus_123" } }
    });
    assert.equal(result.body.applied, "plan-ended");
    const account = store.state.accounts.get("buyer@example.com");
    assert.equal(account.planActive, false);
    assert.equal(hasActivePlan(account), false);
    assert.equal(documentAccessFor(account), "none");
  });

  test("cancelling one subscription leaves other accounts alone", async () => {
    const store = createMemoryStore();
    await deliver(store, checkoutEvent("evt_1", "cs_pro_month"));
    await deliver(store, checkoutEvent("evt_2", "cs_pro_year", { customer: "cus_456", customer_details: { email: "second@example.com" } }));
    await deliver(store, { id: "evt_3", type: "customer.subscription.deleted", data: { object: { id: "sub_cs_pro_month" } } });
    assert.equal(store.state.accounts.get("buyer@example.com").planActive, false);
    assert.equal(store.state.accounts.get("second@example.com").planActive, true);
  });

  test("a refunded document payment removes its credit", async () => {
    const store = createMemoryStore();
    await deliver(store, checkoutEvent("evt_1", "cs_doc"));
    const result = await deliver(store, {
      id: "evt_2",
      type: "charge.refunded",
      data: { object: { id: "ch_1", refunded: true, payment_intent: "pi_cs_doc", customer: "cus_123" } }
    });
    assert.equal(result.body.applied, "credit-removed");
    assert.equal(store.state.accounts.get("buyer@example.com").documentCredits, 0);
  });

  test("refunding a document credit doesn't touch the buyer's Pro plan", async () => {
    const store = createMemoryStore();
    await deliver(store, checkoutEvent("evt_1", "cs_pro_month"));
    await deliver(store, checkoutEvent("evt_2", "cs_doc"));
    await deliver(store, { id: "evt_3", type: "charge.refunded", data: { object: { refunded: true, payment_intent: "pi_cs_doc", customer: "cus_123" } } });
    const account = store.state.accounts.get("buyer@example.com");
    assert.equal(account.documentCredits, 0);
    assert.equal(account.planActive, true);
  });

  test("a refund for an already-spent credit never goes below zero", async () => {
    const store = createMemoryStore();
    await deliver(store, checkoutEvent("evt_1", "cs_doc"));
    store.state.accounts.get("buyer@example.com").documentCredits = 0; // spent on a review
    await deliver(store, { id: "evt_2", type: "charge.refunded", data: { object: { refunded: true, payment_intent: "pi_cs_doc" } } });
    assert.equal(store.state.accounts.get("buyer@example.com").documentCredits, 0);
  });

  test("a fully refunded subscription payment ends the plan", async () => {
    const store = createMemoryStore();
    await deliver(store, checkoutEvent("evt_1", "cs_pro_year"));
    const result = await deliver(store, {
      id: "evt_2",
      type: "charge.refunded",
      data: { object: { id: "ch_2", refunded: true, payment_intent: "pi_invoice", customer: "cus_123" } }
    });
    assert.equal(result.body.applied, "plan-ended");
    assert.equal(store.state.accounts.get("buyer@example.com").planActive, false);
  });

  test("a partial refund leaves access alone", async () => {
    const store = createMemoryStore();
    await deliver(store, checkoutEvent("evt_1", "cs_pro_year"));
    const result = await deliver(store, {
      id: "evt_2",
      type: "charge.refunded",
      data: { object: { id: "ch_2", refunded: false, amount_refunded: 500, customer: "cus_123" } }
    });
    assert.equal(result.body.reason, "partial-refund");
    assert.equal(store.state.accounts.get("buyer@example.com").planActive, true);
  });
});

describe("fetchCheckoutLineItems", () => {
  test("calls Stripe with the secret key and returns the items", async () => {
    let seen;
    const items = await fetchCheckoutLineItems("cs_123", {
      secretKey: "sk_test_x",
      fetchImpl: async (url, init) => {
        seen = { url, init };
        return new Response(JSON.stringify({ data: LINE_ITEMS.cs_doc }), { status: 200 });
      }
    });
    assert.deepEqual(items, LINE_ITEMS.cs_doc);
    assert.match(seen.url, /^https:\/\/api\.stripe\.com\/v1\/checkout\/sessions\/cs_123\/line_items/);
    assert.equal(seen.init.headers.Authorization, "Bearer sk_test_x");
  });

  test("throws when STRIPE_SECRET_KEY is missing", async () => {
    await assert.rejects(fetchCheckoutLineItems("cs_123", { secretKey: undefined }), /STRIPE_SECRET_KEY/);
  });

  test("throws on a Stripe error so the event is retried", async () => {
    await assert.rejects(
      fetchCheckoutLineItems("cs_123", { secretKey: "sk_test_x", fetchImpl: async () => new Response("{}", { status: 401 }) })
    );
  });
});

describe("entitlements", () => {
  test("normalizeEmail lowercases and trims, and rejects non-emails", () => {
    assert.equal(normalizeEmail("  Ada@Example.COM "), "ada@example.com");
    assert.equal(normalizeEmail(""), null);
    assert.equal(normalizeEmail("no-at-sign"), null);
    assert.equal(normalizeEmail(undefined), null);
  });

  test("an inactive plan gives nothing, even with the plan name still set", () => {
    const account = { plan: "pro", planActive: false, documentCredits: 0 };
    assert.equal(hasActivePlan(account), false);
    assert.equal(documentAccessFor(account), "none");
    assert.equal(accountSummary("a@b.co", account).plan, null);
  });

  test("an active plan includes document reviews without spending credits", () => {
    assert.equal(documentAccessFor({ plan: "family", planActive: true, documentCredits: 2 }), "plan");
  });

  test("signed out or no row means no access", () => {
    assert.equal(documentAccessFor(null), "none");
    assert.deepEqual(accountSummary("a@b.co", null), { email: "a@b.co", plan: null, planInterval: null, documentCredits: 0 });
  });
});
