// ============================================================
// KEENSHIELD — lib/entitlements.js
//
// What a person's account row lets them do. Shared by the scanner,
// the account endpoint and the Stripe webhook.
//
// Keenshield sells one plan, Pro, for individuals and businesses, plus
// $1.99 single scan credits.
// ============================================================

export const PAID_PLANS = ["pro"];

// Accounts written before a plan was retired keep working as Pro, so nobody
// who has already paid loses access when the plan leaves the pricing page.
const RETIRED_PLANS = { family: "pro" };

export function normalizeEmail(value) {
  if (typeof value !== "string") return null;
  const email = value.trim().toLowerCase();
  return email && email.length <= 254 && email.includes("@") ? email : null;
}

function currentPlanOf(account) {
  if (!account || !account.planActive) return null;
  const plan = RETIRED_PLANS[account.plan] || account.plan;
  return PAID_PLANS.includes(plan) ? plan : null;
}

// Pro includes unlimited full scans on the website.
export function hasActivePlan(account) {
  return currentPlanOf(account) !== null;
}

// How a website scan past the free allowance would be paid for:
//   "plan"   — included in an active Pro plan
//   "credit" — spends one $1.99 scan credit
//   "none"   — needs Pro or a credit first
export function paidScanAccessFor(account) {
  if (hasActivePlan(account)) return "plan";
  if (account && Number(account.documentCredits) > 0) return "credit";
  return "none";
}

// The public shape of an account, safe to send to the person it belongs to.
export function accountSummary(email, account) {
  const plan = currentPlanOf(account);
  return {
    email,
    plan,
    planInterval: plan ? account.planInterval || null : null,
    scanCredits: account ? Math.max(0, Number(account.documentCredits) || 0) : 0
  };
}
