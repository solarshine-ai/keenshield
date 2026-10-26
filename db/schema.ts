import { pgTable, serial, text, timestamp, integer, jsonb, uniqueIndex } from "drizzle-orm/pg-core";

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

// People who asked to hear about launch or a paid plan from the pricing
// section. Payments aren't live yet; this is how demand gets measured first.
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
