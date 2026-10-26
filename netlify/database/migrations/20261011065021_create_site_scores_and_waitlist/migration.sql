CREATE TABLE "site_scores" (
	"id" serial PRIMARY KEY,
	"page_key" text NOT NULL,
	"hostname" text NOT NULL,
	"content_hash" text NOT NULL,
	"score" integer NOT NULL,
	"risk_level" text NOT NULL,
	"top_reason" text DEFAULT '' NOT NULL,
	"reasons" jsonb DEFAULT '[]' NOT NULL,
	"summary" text DEFAULT '' NOT NULL,
	"model" text NOT NULL,
	"hits" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"scored_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "waitlist" (
	"id" serial PRIMARY KEY,
	"email" text NOT NULL,
	"plan" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "site_scores_page_key_idx" ON "site_scores" ("page_key");--> statement-breakpoint
CREATE UNIQUE INDEX "waitlist_email_idx" ON "waitlist" ("email");