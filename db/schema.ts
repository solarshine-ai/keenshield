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

// One row per site (registrable domain, e.g. "example.com"), shared by every
// Keenshield user. Keenshield's server reads the company's own public pages
// — homepage, terms, privacy, refund, cancellation and pricing — and scores
// the company once every 30 days. Nothing about any visitor is stored here.
export const siteDomainScores = pgTable(
  "site_domain_scores",
  {
    id: serial().primaryKey(),
    domain: text().notNull(),
    score: integer().notNull(),
    riskLevel: text("risk_level").notNull(),
    topReason: text("top_reason").notNull().default(""),
    reasons: jsonb().$type<string[]>().notNull().default([]),
    summary: text().notNull().default(""),
    // The page addresses that were read to make this score.
    pagesChecked: jsonb("pages_checked").$type<string[]>().notNull().default([]),
    scoredAt: timestamp("scored_at").defaultNow().notNull(),
    hits: integer().notNull().default(0)
  },
  (table) => [uniqueIndex("site_domain_scores_domain_idx").on(table.domain)]
);

// Every score Keenshield has ever given, so a score change is never lost.
// A row is added whenever a page score or a site score is created or
// changes; rows are never updated or deleted.
export const scoreHistory = pgTable(
  "score_history",
  {
    id: serial().primaryKey(),
    // The page key (hostname + path) for kind "page", the domain for "site".
    key: text().notNull(),
    kind: text().notNull(), // "page" | "site"
    score: integer().notNull(),
    riskLevel: text("risk_level").notNull(),
    topReason: text("top_reason").notNull().default(""),
    scoredAt: timestamp("scored_at").defaultNow().notNull()
  },
  (table) => [index("score_history_key_idx").on(table.kind, table.key, table.scoredAt)]
);

// People who asked to hear when the extension launches.
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
    // "pro", or null for no subscription. (Rows from the retired Family plan
    // say "family" and are treated as Pro; see lib/entitlements.js.)
    plan: text(),
    // "month" or "year".
    planInterval: text("plan_interval"),
    planActive: boolean("plan_active").notNull().default(false),
    stripeCustomerId: text("stripe_customer_id"),
    stripeSubscriptionId: text("stripe_subscription_id"),
    // $1.99 single scan credits bought and not yet used or refunded. (The
    // column name dates from when these were called document reviews.)
    documentCredits: integer("document_credits").notNull().default(0),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull()
  },
  (table) => [
    index("accounts_stripe_customer_idx").on(table.stripeCustomerId),
    index("accounts_stripe_subscription_idx").on(table.stripeSubscriptionId)
  ]
);

// One row per single scan purchase, so a refund can find and remove
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
