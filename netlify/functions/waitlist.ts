// ============================================================
// KEENSHIELD — netlify/functions/waitlist.ts
//
// Collects emails from the pricing section ("tell me when Pro
// launches") so demand for each plan can be measured before
// payments go live.
// ============================================================

import { db } from "../../db/index.js";
import { waitlist } from "../../db/schema.js";
import { clientIpOf, createRateLimiter, isTrustedOrigin, jsonResponse, readJsonBody, responseHeaders } from "../../lib/gate.js";

const PLANS = ["launch", "pro", "family", "document", "teams"];

const checkRateLimit = createRateLimiter({
  storeName: "keenshield-waitlist-rate-limits",
  maxRequests: 10,
  windowMs: 60 * 60 * 1000
});

export default async (request: Request) => {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: responseHeaders });
  }
  if (request.method !== "POST") {
    return jsonResponse(405, { error: "Method Not Allowed" });
  }

  // Only the website's own pricing form signs people up.
  if (!isTrustedOrigin(request)) {
    return jsonResponse(401, { error: "Unauthorized" });
  }

  if (!(await checkRateLimit(clientIpOf(request)))) {
    return jsonResponse(429, { error: "Too many sign-ups from this connection, please try again later" });
  }

  const { body, error } = await readJsonBody(request, 4 * 1024);
  if (error) return error;

  // Hidden field real visitors never fill in; bots usually do.
  if (typeof body.company === "string" && body.company.trim()) {
    return jsonResponse(200, { ok: true });
  }

  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return jsonResponse(400, { error: "Please enter a valid email address" });
  }

  const plan = PLANS.includes(body.plan) ? body.plan : "launch";

  try {
    // Signing up again just records the latest plan of interest.
    await db
      .insert(waitlist)
      .values({ email, plan })
      .onConflictDoUpdate({ target: waitlist.email, set: { plan } });
  } catch (err) {
    console.error("waitlist: failed to save sign-up:", err);
    return jsonResponse(500, { error: "Couldn't save that right now, please try again" });
  }

  return jsonResponse(200, { ok: true });
};

export const config = {
  path: "/api/waitlist"
};
