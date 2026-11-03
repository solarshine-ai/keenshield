// ============================================================
// KEENSHIELD — lib/entitlements.js
//
// What a person's account row lets them do. Shared by the scanner,
// the account endpoint and the Stripe webhook.
// ============================================================

export const PAID_PLANS = ["pro", "family"];

export function normalizeEmail(value) {
  if (typeof value !== "string") return null;
  const email = value.trim().toLowerCase();
  return email && email.length <= 254 && email.includes("@") ? email : null;
}

// Pro and Family both include unlimited deep scans and document reviews.
export function hasActivePlan(account) {
  return Boolean(account && account.planActive && PAID_PLANS.includes(account.plan));
}

// How a document review would be paid for:
//   "plan"   — included in an active Pro or Family plan
//   "credit" — spends one single-review credit
//   "none"   — needs a plan or a credit first
export function documentAccessFor(account) {
  if (hasActivePlan(account)) return "plan";
  if (account && Number(account.documentCredits) > 0) return "credit";
  return "none";
}

// The public shape of an account, safe to send to the person it belongs to.
export function accountSummary(email, account) {
  return {
    email,
    plan: hasActivePlan(account) ? account.plan : null,
    planInterval: hasActivePlan(account) ? account.planInterval || null : null,
    documentCredits: account ? Math.max(0, Number(account.documentCredits) || 0) : 0
  };
}
