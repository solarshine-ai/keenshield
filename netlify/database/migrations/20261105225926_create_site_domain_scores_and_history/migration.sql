CREATE TABLE "score_history" (
	"id" serial PRIMARY KEY,
	"key" text NOT NULL,
	"kind" text NOT NULL,
	"score" integer NOT NULL,
	"risk_level" text NOT NULL,
	"top_reason" text DEFAULT '' NOT NULL,
	"scored_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "site_domain_scores" (
	"id" serial PRIMARY KEY,
	"domain" text NOT NULL,
	"score" integer NOT NULL,
	"risk_level" text NOT NULL,
	"top_reason" text DEFAULT '' NOT NULL,
	"reasons" jsonb DEFAULT '[]' NOT NULL,
	"summary" text DEFAULT '' NOT NULL,
	"pages_checked" jsonb DEFAULT '[]' NOT NULL,
	"scored_at" timestamp DEFAULT now() NOT NULL,
	"hits" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE INDEX "score_history_key_idx" ON "score_history" ("kind","key","scored_at");--> statement-breakpoint
CREATE UNIQUE INDEX "site_domain_scores_domain_idx" ON "site_domain_scores" ("domain");