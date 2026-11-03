import { pgTable, serial, text, timestamp, integer, jsonb, uniqueIndex, index, boolean } from "drizzle-orm/pg-core";

// One row per scored page, shared by every Keenshield user. A page is scored
// once and everyone who visits it afterwards gets the stored result, so AI
// cost grows with the number of pages, not the number of users.
//
// Page text is never stored — only a hash of it, used to tell whether the
// page changed since it was last scored.
export const siteScores = pgTable(
  "site_scores",
  {
    id: serial().primaryKey(),
    // Hostname + path, lowercased, with the query string and fragment removed.
    pageKey: text("page_key").notNull(),
    hostname: text().notNull(),
    contentHash: text("content_hash").notNull(),
    score: integer().notNull(),
    riskLevel: text("risk_level").notNull(),
    topReason: text("top_reason").notNull().default(""),
    reasons: jsonb().$type<string[]>().notNull().default([]),
    summary: text().notNull().default(""),
    model: text().notNull(),
    // How many times this stored score has been served — useful for knowing
    // which pages matter most, and later for the score API.
    hits: integer().notNull().default(0),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    scoredAt: timestamp("scored_at").defaultNow().notNull()
  },
  (table) => [uniqueIndex("site_scores_page_key_idx").on(table.pageKey)]
);

// People who asked to hear about launch or a team plan from the pricing
// section.
export const waitlist = pgTable(
  "waitlist",
  {
    id: serial().primaryKey(),
    email: text().notNull(),
    plan: text().notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull()
  },
  (table) => [uniqueIndex("waitlist_email_idx").on(table.email)]
);

// ── Billing ─────────────────────────────────────────────────
// What each person has paid for, keyed by the email they sign in with. The
// Stripe webhook writes these rows; the scanner reads them. A row can exist
// before the person has an account: buying first and signing up later with
// the same email still finds the purchase.
export const accounts = pgTable(
  "accounts",
  {
    // Lowercased, trimmed email. Matches the Netlify Identity user's email.
    email: text().primaryKey(),
    // "pro" or "family", or null for no subscription.
    plan: text(),
    // "month" or "year".
    planInterval: text("plan_interval"),
    planActive: boolean("plan_active").notNull().default(false),
    stripeCustomerId: text("stripe_customer_id"),
    stripeSubscriptionId: text("stripe_subscription_id"),
    // Single document reviews bought and not yet used or refunded.
    documentCredits: integer("document_credits").notNull().default(0),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull()
  },
  (table) => [
    index("accounts_stripe_customer_idx").on(table.stripeCustomerId),
    index("accounts_stripe_subscription_idx").on(table.stripeSubscriptionId)
  ]
);

// One row per single-document purchase, so a refund can find and remove
// exactly the credit that payment bought.
export const creditPurchases = pgTable(
  "credit_purchases",
  {
    id: serial().primaryKey(),
    email: text().notNull(),
    stripeCheckoutSessionId: text("stripe_checkout_session_id").notNull(),
    stripePaymentIntentId: text("stripe_payment_intent_id"),
    credits: integer().notNull().default(1),
    refunded: boolean().notNull().default(false),
    createdAt: timestamp("created_at").defaultNow().notNull()
  },
  (table) => [
    uniqueIndex("credit_purchases_session_idx").on(table.stripeCheckoutSessionId),
    index("credit_purchases_payment_intent_idx").on(table.stripePaymentIntentId)
  ]
);

// Every Stripe event already handled. Stripe can deliver the same event more
// than once; an event ID already in here is acknowledged and skipped.
export const stripeEvents = pgTable("stripe_events", {
  id: text().primaryKey(),
  type: text().notNull(),
  processedAt: timestamp("processed_at").defaultNow().notNull()
});
