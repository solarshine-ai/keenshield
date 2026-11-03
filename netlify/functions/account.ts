// ============================================================
// KEENSHIELD — netlify/functions/account.ts
//
// Tells the signed-in person what they have: their plan and how many
// single document review credits are left. The website uses it to
// show account status and whether a document review is available.
// ============================================================

import { getUser } from "@netlify/identity";
import { getAccount } from "../../db/billing.js";
import { accountSummary, normalizeEmail } from "../../lib/entitlements.js";

export default async (request: Request) => {
  if (request.method !== "GET") {
    return Response.json({ error: "Method Not Allowed" }, { status: 405 });
  }

  const user = await getUser();
  const email = normalizeEmail(user?.email);
  if (!email) {
    return Response.json({ error: "Not signed in" }, { status: 401, headers: { "Cache-Control": "no-store" } });
  }

  try {
    const account = await getAccount(email);
    return Response.json(accountSummary(email, account), { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    console.error("account: lookup failed:", err);
    return Response.json({ error: "Couldn't load your account right now" }, { status: 500 });
  }
};

export const config = {
  path: "/api/account"
};
