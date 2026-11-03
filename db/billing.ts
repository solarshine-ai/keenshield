// ============================================================
// KEENSHIELD — db/billing.ts
//
// Database side of billing: the operations the Stripe webhook applies
// (inside one transaction per event) and the lookups the scanner makes.
// ============================================================

import { and, eq, gt, sql } from "drizzle-orm";
import { db } from "./index.js";
import { accounts, creditPurchases, stripeEvents } from "./schema.js";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Executor = typeof db | Tx;

export type Account = typeof accounts.$inferSelect;

function billingOps(tx: Executor) {
  return {
    async recordEvent(id: string, type: string) {
      const rows = await tx
        .insert(stripeEvents)
        .values({ id, type })
        .onConflictDoNothing({ target: stripeEvents.id })
        .returning({ id: stripeEvents.id });
      return rows.length > 0;
    },

    async grantPlan(input: {
      email: string;
      plan: string;
      interval: string;
      customerId: string | null;
      subscriptionId: string | null;
    }) {
      const values = {
        plan: input.plan,
        planInterval: input.interval,
        planActive: true,
        stripeCustomerId: input.customerId,
        stripeSubscriptionId: input.subscriptionId,
        updatedAt: new Date()
      };
      await tx
        .insert(accounts)
        .values({ email: input.email, ...values })
        .onConflictDoUpdate({ target: accounts.email, set: values });
    },

    async addDocumentCredits(input: {
      email: string;
      credits: number;
      checkoutSessionId: string;
      paymentIntentId: string | null;
    }) {
      // The purchase row is unique per checkout session, so the same checkout
      // can never add its credit twice, even under two different event IDs.
      const inserted = await tx
        .insert(creditPurchases)
        .values({
          email: input.email,
          stripeCheckoutSessionId: input.checkoutSessionId,
          stripePaymentIntentId: input.paymentIntentId,
          credits: input.credits
        })
        .onConflictDoNothing({ target: creditPurchases.stripeCheckoutSessionId })
        .returning({ id: creditPurchases.id });
      if (inserted.length === 0) return false;

      await tx
        .insert(accounts)
        .values({ email: input.email, documentCredits: input.credits })
        .onConflictDoUpdate({
          target: accounts.email,
          set: {
            documentCredits: sql`${accounts.documentCredits} + ${input.credits}`,
            updatedAt: new Date()
          }
        });
      return true;
    },

    async endPlanBySubscription(subscriptionId: string) {
      const rows = await tx
        .update(accounts)
        .set({ planActive: false, updatedAt: new Date() })
        .where(and(eq(accounts.stripeSubscriptionId, subscriptionId), eq(accounts.planActive, true)))
        .returning({ email: accounts.email });
      return rows.length;
    },

    async refundDocumentCredits(paymentIntentId: string) {
      const refunded = await tx
        .update(creditPurchases)
        .set({ refunded: true })
        .where(and(eq(creditPurchases.stripePaymentIntentId, paymentIntentId), eq(creditPurchases.refunded, false)))
        .returning({ email: creditPurchases.email, credits: creditPurchases.credits });

      let removed = 0;
      for (const purchase of refunded) {
        // A credit already spent can't be taken back, so this stops at zero.
        await tx
          .update(accounts)
          .set({
            documentCredits: sql`greatest(${accounts.documentCredits} - ${purchase.credits}, 0)`,
            updatedAt: new Date()
          })
          .where(eq(accounts.email, purchase.email));
        removed += purchase.credits;
      }
      return removed;
    }
  };
}

export type BillingOps = ReturnType<typeof billingOps>;

export const billingStore = {
  transaction<T>(fn: (ops: BillingOps) => Promise<T>): Promise<T> {
    return db.transaction((tx) => fn(billingOps(tx)));
  }
};

export async function getAccount(email: string): Promise<Account | null> {
  const [row] = await db.select().from(accounts).where(eq(accounts.email, email)).limit(1);
  return row ?? null;
}

// Spends one document credit if there is one. Returns the credits left, or
// null when there was none to spend. One statement, so two reviews started at
// once can't both spend the same last credit.
export async function spendDocumentCredit(email: string): Promise<number | null> {
  const [row] = await db
    .update(accounts)
    .set({ documentCredits: sql`${accounts.documentCredits} - 1`, updatedAt: new Date() })
    .where(and(eq(accounts.email, email), gt(accounts.documentCredits, 0)))
    .returning({ documentCredits: accounts.documentCredits });
  return row ? row.documentCredits : null;
}

// Gives back a credit spent on a review that then failed.
export async function returnDocumentCredit(email: string): Promise<void> {
  await db
    .update(accounts)
    .set({ documentCredits: sql`${accounts.documentCredits} + 1`, updatedAt: new Date() })
    .where(eq(accounts.email, email));
}
