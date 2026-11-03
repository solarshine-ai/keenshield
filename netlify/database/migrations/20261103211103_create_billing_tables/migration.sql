CREATE TABLE "accounts" (
	"email" text PRIMARY KEY,
	"plan" text,
	"plan_interval" text,
	"plan_active" boolean DEFAULT false NOT NULL,
	"stripe_customer_id" text,
	"stripe_subscription_id" text,
	"document_credits" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "credit_purchases" (
	"id" serial PRIMARY KEY,
	"email" text NOT NULL,
	"stripe_checkout_session_id" text NOT NULL,
	"stripe_payment_intent_id" text,
	"credits" integer DEFAULT 1 NOT NULL,
	"refunded" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stripe_events" (
	"id" text PRIMARY KEY,
	"type" text NOT NULL,
	"processed_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "accounts_stripe_customer_idx" ON "accounts" ("stripe_customer_id");--> statement-breakpoint
CREATE INDEX "accounts_stripe_subscription_idx" ON "accounts" ("stripe_subscription_id");--> statement-breakpoint
CREATE UNIQUE INDEX "credit_purchases_session_idx" ON "credit_purchases" ("stripe_checkout_session_id");--> statement-breakpoint
CREATE INDEX "credit_purchases_payment_intent_idx" ON "credit_purchases" ("stripe_payment_intent_id");