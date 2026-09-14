// ============================================================
// KEENSHIELD — netlify/functions/keenshield-scan.js
//
// Anthropic credentials are injected by Netlify AI Gateway and
// remain server-side; they are never exposed to the extension.
//
// The Chrome extension's background.js calls THIS endpoint.
// This function calls Claude, then returns a clean verdict.
// ============================================================

import { getStore } from "@netlify/blobs";
import { createHash, timingSafeEqual } from "node:crypto";

const responseHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, x-keenshield-secret, x-keenshield-owner-token",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Max-Age": "86400",
  "Vary": "Origin",
  "Content-Type": "application/json"
};

// Requests from Keenshield's own site are let through without the shared
// secret; everything else — the Chrome extension included — must send
// `x-keenshield-secret`.
//
// This is a soft speed bump, not real security: any non-browser client can send
// whatever Origin header it likes. It exists so the public page keeps working
// without shipping the secret to the browser, not to stop a determined caller.
const TRUSTED_ORIGINS = ["https://keenshield.netlify.app"];

// Compare a configured secret against a caller-supplied one without leaking
// length or content through timing. Both sides are hashed first so the digests
// are always the same size and `timingSafeEqual` can never throw on mismatched
// lengths. An empty or missing value on either side never matches.
function tokensMatch(expected, provided) {
  if (typeof expected !== "string" || typeof provided !== "string") return false;
  if (!expected || !provided) return false;

  return timingSafeEqual(
    createHash("sha256").update(expected).digest(),
    createHash("sha256").update(provided).digest()
  );
}

function originOf(value) {
  try {
    return new URL(value).origin.toLowerCase();
  } catch {
    return null;
  }
}

function isTrustedOrigin(request) {
  const origin = originOf(request.headers.get("origin"));
  if (!origin) return false;

  if (TRUSTED_ORIGINS.some((trusted) => originOf(trusted) === origin)) return true;

  // Same-origin as whatever host is serving this function, which covers deploy
  // previews and `netlify dev` without hardcoding their URLs.
  return originOf(request.url) === origin;
}

// -----------------------------------------------------------
// Per-IP rate limiting
//
// A rolling window per caller IP, tracked in a Netlify Blobs store so the
// count is shared across every function instance and survives cold starts.
// This sits ON TOP of the origin exemption and the shared secret: trusted
// origins and secret-bearing callers are rate limited too.
// -----------------------------------------------------------
const RATE_LIMIT_MAX_REQUESTS = 20;
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 60 minutes
const RATE_LIMIT_STORE_NAME = "keenshield-rate-limits";

// Fallback only. If Netlify Blobs is unavailable (e.g. running outside a
// Netlify environment), counts live in this module-scoped map instead.
// NOTE: this in-memory counter resets on every cold start and is not shared
// between concurrent function instances, so it is a materially weaker
// guarantee than Blobs — a caller can exceed the limit by spreading requests
// across instances or waiting for a recycle. It exists so the endpoint stays
// available, not to be relied on for enforcement.
const inMemoryRateLimits = new Map();

function clientIpOf(request) {
  const ip = request.headers.get("x-nf-client-connection-ip");
  if (!ip) return "unknown";
  // Blob keys allow a limited character set; keep it conservative.
  return ip.trim().replace(/[^a-zA-Z0-9.:_-]/g, "_").slice(0, 100) || "unknown";
}

// Given the stored record, decide whether this request is allowed and what the
// record should become. Shared by both the Blobs and in-memory paths.
function nextRateLimitState(record, now) {
  if (!record || typeof record.count !== "number" || typeof record.windowStart !== "number"
      || now - record.windowStart >= RATE_LIMIT_WINDOW_MS) {
    return { allowed: true, record: { count: 1, windowStart: now } };
  }

  if (record.count >= RATE_LIMIT_MAX_REQUESTS) {
    return { allowed: false, record };
  }

  return { allowed: true, record: { count: record.count + 1, windowStart: record.windowStart } };
}

async function checkRateLimit(ip) {
  const now = Date.now();

  try {
    // Strong consistency: a counter read immediately after a write must not be
    // stale, otherwise the limit is trivially bypassed by rapid-fire requests.
    const store = getStore({ name: RATE_LIMIT_STORE_NAME, consistency: "strong" });
    const record = await store.get(ip, { type: "json" });
    const next = nextRateLimitState(record, now);

    if (next.allowed) {
      await store.setJSON(ip, next.record);
    }

    return next.allowed;
  } catch (err) {
    console.error("Rate limit store unavailable, falling back to in-memory counter:", err);

    const next = nextRateLimitState(inMemoryRateLimits.get(ip), now);
    if (next.allowed) {
      inMemoryRateLimits.set(ip, next.record);
    }

    return next.allowed;
  }
}

// -----------------------------------------------------------
// Per-install free scan limit
//
// Separate concern from the per-IP rate limiter above: that one caps how FAST
// anyone can hit the endpoint, this one caps how MANY free scans a single
// extension install ever gets. Both apply independently — passing one says
// nothing about the other.
//
// There is no time window here. The count only ever goes up, so once an
// install has spent its free scans it stays over the limit until a paid tier
// exists to lift it.
//
// Keenshield's own site sends no installId (it has no install concept yet), so
// it is not metered by this at all.
// -----------------------------------------------------------
const FREE_SCAN_LIMIT = 5;
const SCAN_COUNT_STORE_NAME = "keenshield-scan-counts";

// Fallback only, mirroring the rate limiter: if Netlify Blobs is unavailable
// the counts live in this module-scoped map instead.
// NOTE: this is materially weaker than Blobs. It resets on every cold start and
// is not shared between instances, so an install could keep scanning for free
// while Blobs is down. That is a deliberate fail-open — a Blobs outage degrades
// metering rather than taking scanning offline for every user.
const inMemoryScanCounts = new Map();

// The installId is attacker-controlled (it comes from the request body), so
// normalize it to the conservative character set blob keys allow before it is
// ever used as one.
function installIdOf(body) {
  const value = body && body.installId;
  if (typeof value !== "string") return null;

  const safe = value.trim().replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100);
  return safe || null;
}

// Given the stored count, decide whether this scan is allowed and what the
// count should become. Shared by both the Blobs and in-memory paths.
function nextScanCountState(record) {
  const used = record && typeof record.count === "number" && record.count > 0 ? record.count : 0;

  if (used >= FREE_SCAN_LIMIT) {
    return { allowed: false, used, record: { count: used } };
  }

  return { allowed: true, used: used + 1, record: { count: used + 1 } };
}

// Returns { allowed, used }. `used` is the scan count after this request when
// allowed, or the already-spent total when the install is over the limit.
async function checkFreeScanLimit(installId) {
  try {
    // Strong consistency, same reasoning as the rate limiter: a count read
    // immediately after a write must not be stale or the limit is trivially
    // bypassed by firing scans in quick succession.
    const store = getStore({ name: SCAN_COUNT_STORE_NAME, consistency: "strong" });
    const record = await store.get(installId, { type: "json" });
    const next = nextScanCountState(record);

    if (next.allowed) {
      await store.setJSON(installId, next.record);
    }

    return { allowed: next.allowed, used: next.used };
  } catch (err) {
    console.error("Scan count store unavailable, falling back to in-memory counter:", err);

    const next = nextScanCountState(inMemoryScanCounts.get(installId));
    if (next.allowed) {
      inMemoryScanCounts.set(installId, next.record);
    }

    return { allowed: next.allowed, used: next.used };
  }
}

// -----------------------------------------------------------
// Owner bypass
//
// A single private token, held only by the project owner, that lifts BOTH
// limits above: the per-IP rate limit and the per-install free scan limit.
// This is what fills the `userToken` slot the handler always accepted and
// ignored — but only for the owner. There is still no general paid tier.
//
// The token may arrive either as the `x-keenshield-owner-token` header or as
// `userToken` in the request body, so the extension, curl, and any local
// tooling can all use it without a bespoke shape.
//
// Holding it also satisfies the shared-secret gate, since a caller who can
// prove they are the owner is by definition allowed to call the endpoint.
//
// NEVER put this value in frontend code or the Chrome extension's bundled
// config — both ship to users. It belongs in the KEENSHIELD_OWNER_TOKEN
// environment variable and in requests the owner makes by hand.
//
// If KEENSHIELD_OWNER_TOKEN is unset, nobody is the owner and every caller is
// metered normally. That is the safe default: a missing variable must never
// read as a match.
// -----------------------------------------------------------
const OWNER_TOKEN_HEADER = "x-keenshield-owner-token";

function isOwnerRequest(request, body) {
  const ownerToken = process.env.KEENSHIELD_OWNER_TOKEN;
  if (!ownerToken) return false;

  const fromHeader = request.headers.get(OWNER_TOKEN_HEADER);
  const fromBody = body && typeof body.userToken === "string" ? body.userToken : null;

  return tokensMatch(ownerToken, fromHeader) || tokensMatch(ownerToken, fromBody);
}

// The body has to be parsed before the limits now, because the owner token can
// arrive inside it. Reading an already-received body is cheap next to the
// Anthropic call the limits exist to protect, but an unbounded body is not, so
// cap it first. Page text is truncated to 8k characters downstream anyway, so
// this ceiling is generous.
const MAX_BODY_BYTES = 512 * 1024;

function jsonResponse(statusCode, body, extraHeaders) {
  return new Response(JSON.stringify(body), {
    status: statusCode,
    headers: extraHeaders ? { ...responseHeaders, ...extraHeaders } : responseHeaders
  });
}

export default async function (request) {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: responseHeaders });
  }

  if (request.method !== "POST") {
    return jsonResponse(405, { error: "Method Not Allowed" });
  }

  // Reject an oversized body before buffering or parsing it. Everything below
  // needs the parsed body, so this is the one cheap check that can run first.
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    return jsonResponse(413, { error: "Payload too large" });
  }

  let body;
  try {
    const rawBody = await request.text();
    if (rawBody.length > MAX_BODY_BYTES) {
      return jsonResponse(413, { error: "Payload too large" });
    }
    body = JSON.parse(rawBody || "{}");
  } catch {
    return jsonResponse(400, { error: "Invalid JSON" });
  }

  // Settled once, up front: the owner skips the secret gate and both limits.
  const isOwner = isOwnerRequest(request, body);

  // Shared-secret gate. Keenshield's own site is exempt by origin, the owner is
  // exempt by token, and every other caller must present the shared secret.
  if (!isOwner && !isTrustedOrigin(request)) {
    const sharedSecret = process.env.KEENSHIELD_SHARED_SECRET;
    const providedSecret = request.headers.get("x-keenshield-secret");
    if (!tokensMatch(sharedSecret, providedSecret)) {
      return jsonResponse(401, { error: "Unauthorized" });
    }
  }

  // Per-IP rate limit. Applies to every caller that got past the gate above,
  // including trusted origins and secret-bearing callers, and runs before
  // Anthropic is called so a throttled request costs nothing. The owner is
  // skipped entirely — and skipped before the counter is touched, so owner
  // traffic does not spend the quota of the IP it shares with anyone else.
  if (!isOwner && !(await checkRateLimit(clientIpOf(request)))) {
    return jsonResponse(429, { error: "Rate limit exceeded, please try again later" });
  }

  const { url, title, text } = body;

  if (!text || typeof text !== "string") {
    return jsonResponse(400, { error: "Missing page text" });
  }

  // Per-install free scan limit. Only extension installs send an installId;
  // requests without one (Keenshield's own site) skip this entirely, and so
  // does the owner. Runs before Anthropic is called so an over-limit scan
  // costs nothing.
  //
  // Checking `isOwner` before calling means an owner scan never increments the
  // stored count either, so switching the owner token off again leaves the
  // install's free scans exactly where they were.
  const installId = installIdOf(body);
  if (!isOwner && installId) {
    const { allowed, used } = await checkFreeScanLimit(installId);
    if (!allowed) {
      return jsonResponse(402, { error: "Free scan limit reached", scansUsed: used });
    }
  }

  // -----------------------------------------------------------
  // TODO (paid-tier metering): the owner bypass above is a single
  // private token, not a paid tier. Once real accounts exist, this
  // is where a subscriber's userToken should be verified so that it
  // lifts FREE_SCAN_LIMIT the same way — per account, revocable,
  // and without sharing one secret between every paying user.
  // -----------------------------------------------------------

  const anthropicApiKey = process.env.ANTHROPIC_API_KEY;
  const anthropicBaseUrl = process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com";
  if (!anthropicApiKey) {
    return jsonResponse(500, { error: "Server misconfigured" });
  }

  const systemPrompt = `You are Keenshield's fine-print and scam analyzer. You read website text — terms of service, checkout pages, sign-up flows, contracts — and flag what an ordinary consumer would likely miss or regret agreeing to.

You are NOT a lawyer and must not give legal advice. You explain what a clause likely means in plain English and why it matters practically.

Look for things like: auto-renewal traps, hard-to-cancel subscriptions, forced arbitration clauses, hidden fees, data-sharing/selling language, unusually broad liability waivers, requests for payment via gift card or wire transfer (classic scam signal), urgency/pressure tactics, requests for sensitive info (SSN, full card number) on pages that don't need it, and mismatched or suspicious company identity.

Respond ONLY with valid JSON in exactly this shape, nothing else — no markdown fences, no preamble:
{
  "risk_level": "green" | "yellow" | "red",
  "flags": ["short flag 1", "short flag 2"],
  "summary": "2-3 sentence plain-English explanation a non-lawyer can understand"
}

risk_level guide:
- green: nothing concerning found
- yellow: normal-but-worth-knowing terms (e.g. auto-renewal, arbitration clause) — not a scam, just read before agreeing
- red: signs of a likely scam or seriously predatory terms (e.g. gift-card payment demands, fake urgency, requests for sensitive data that don't belong on this kind of page)

If the page has nothing relevant (no contract, no checkout, no sign-up), return risk_level "green" with an empty flags array and a summary saying nothing concerning was found.`;

  const userPrompt = `Page title: ${title || "(unknown)"}
Page URL: ${url || "(unknown)"}

Page text:
"""
${text.slice(0, 8000)}
"""`;

  try {
    const response = await fetch(`${anthropicBaseUrl.replace(/\/$/, "")}/v1/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": anthropicApiKey,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 500,
        system: systemPrompt,
        messages: [{ role: "user", content: userPrompt }]
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error("Anthropic API error:", errText);
      return jsonResponse(502, { error: "AI analysis failed" });
    }

    const data = await response.json();
    const textBlock = (data.content || []).find((b) => b.type === "text");
    const raw = textBlock ? textBlock.text : "";

    let parsed;
    try {
      const cleaned = raw.replace(/```json|```/g, "").trim();
      parsed = JSON.parse(cleaned);
    } catch {
      console.error("Failed to parse model output:", raw);
      return jsonResponse(200, {
        risk_level: "unknown",
        flags: [],
        summary: "Keenshield had trouble reading this page clearly. Proceed with normal caution."
      });
    }

    // Guard against unexpected shapes before handing back to the extension.
    const riskLevel = ["green", "yellow", "red"].includes(parsed.risk_level) ? parsed.risk_level : "unknown";
    const safeResult = {
      score: { green: 2, yellow: 5, red: 9, unknown: 5 }[riskLevel],
      risk_level: riskLevel,
      flags: Array.isArray(parsed.flags) ? parsed.flags.slice(0, 8) : [],
      summary: typeof parsed.summary === "string" ? parsed.summary.slice(0, 600) : ""
    };

    return jsonResponse(200, safeResult, isOwner ? { "x-keenshield-limits": "bypassed" } : undefined);
  } catch (err) {
    console.error("Keenshield scan error:", err);
    return jsonResponse(500, { error: "Internal error" });
  }
}
