// ============================================================
// KEENSHIELD — lib/gate.js
//
// Who may call Keenshield's endpoints, and how fast. Shared by
// every function so the scanner, the shield score and the
// waitlist all apply the same rules.
// ============================================================

import { getStore } from "@netlify/blobs";
import { createHash, timingSafeEqual } from "node:crypto";

export const responseHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, x-keenshield-secret, x-keenshield-owner-token",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Max-Age": "86400",
  "Vary": "Origin",
  "Content-Type": "application/json"
};

export function jsonResponse(statusCode, body, extraHeaders) {
  return new Response(JSON.stringify(body), {
    status: statusCode,
    headers: extraHeaders ? { ...responseHeaders, ...extraHeaders } : responseHeaders
  });
}

// Requests from Keenshield's own site are let through without the shared
// secret; everything else — the Chrome extension included — must send
// `x-keenshield-secret`.
//
// This is a soft speed bump, not real security: any non-browser client can send
// whatever Origin header it likes. It exists so the public page keeps working
// without shipping the secret to the browser, not to stop a determined caller.
const TRUSTED_ORIGINS = [
  "https://keenshield.netlify.app",
  "https://keenshield.app",
  "https://www.keenshield.app"
];

// Compare a configured secret against a caller-supplied one without leaking
// length or content through timing. Both sides are hashed first so the digests
// are always the same size and `timingSafeEqual` can never throw on mismatched
// lengths. An empty or missing value on either side never matches.
export function tokensMatch(expected, provided) {
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

export function isTrustedOrigin(request) {
  const origin = originOf(request.headers.get("origin"));
  if (!origin) return false;

  if (TRUSTED_ORIGINS.some((trusted) => originOf(trusted) === origin)) return true;

  // Same-origin as whatever host is serving this function, which covers deploy
  // previews and `netlify dev` without hardcoding their URLs.
  return originOf(request.url) === origin;
}

// -----------------------------------------------------------
// Owner bypass
//
// A single private token, held only by the project owner, that lifts every
// limit. It may arrive either as the `x-keenshield-owner-token` header or as
// `userToken` in the request body.
//
// NEVER put this value in frontend code or the Chrome extension's bundled
// config — both ship to users. It belongs in the KEENSHIELD_OWNER_TOKEN
// environment variable and in requests the owner makes by hand.
//
// If KEENSHIELD_OWNER_TOKEN is unset, nobody is the owner. A missing variable
// must never read as a match.
// -----------------------------------------------------------
const OWNER_TOKEN_HEADER = "x-keenshield-owner-token";

export function isOwnerRequest(request, body) {
  const ownerToken = process.env.KEENSHIELD_OWNER_TOKEN;
  if (!ownerToken) return false;

  const fromHeader = request.headers.get(OWNER_TOKEN_HEADER);
  const fromBody = body && typeof body.userToken === "string" ? body.userToken : null;

  return tokensMatch(ownerToken, fromHeader) || tokensMatch(ownerToken, fromBody);
}

// Keenshield's own Chrome extension, recognized by its extension ID. Chrome
// sends `Origin: chrome-extension://<id>` on the extension's requests, so the
// extension needs no secret bundled in its source (which ships to every user
// and, in this repo, is public). List IDs comma-separated in
// KEENSHIELD_EXTENSION_IDS — the Web Store ID, plus a local unpacked build's
// ID while developing. Like the trusted-origin rule, this is a speed bump: a
// non-browser client can fake the header. The rate limits are the real cap.
function isKeenshieldExtension(request) {
  const origin = (request.headers.get("origin") || "").toLowerCase();
  const match = origin.match(/^chrome-extension:\/\/([a-p]{32})$/);
  if (!match) return false;

  const allowed = (process.env.KEENSHIELD_EXTENSION_IDS || "")
    .split(",")
    .map((id) => id.trim().toLowerCase())
    .filter(Boolean);
  return allowed.includes(match[1]);
}

// Admission gate. Keenshield's own site is exempt by origin, its extension by
// extension ID, the owner by token, and every other caller must present the
// shared secret.
export function isAdmitted(request, isOwner) {
  if (isOwner || isTrustedOrigin(request) || isKeenshieldExtension(request)) return true;
  return tokensMatch(process.env.KEENSHIELD_SHARED_SECRET, request.headers.get("x-keenshield-secret"));
}

// -----------------------------------------------------------
// Per-IP rate limiting
//
// A rolling window per caller IP, tracked in a Netlify Blobs store so the
// count is shared across every function instance and survives cold starts.
// Each endpoint gets its own store and budget: the shield score is called on
// ordinary browsing and needs far more headroom than a deep scan.
// -----------------------------------------------------------
export function clientIpOf(request) {
  const ip = request.headers.get("x-nf-client-connection-ip");
  if (!ip) return "unknown";
  // Blob keys allow a limited character set; keep it conservative.
  return ip.trim().replace(/[^a-zA-Z0-9.:_-]/g, "_").slice(0, 100) || "unknown";
}

// Returns an async `(key) => boolean` that is true while `key` is under
// `maxRequests` within the rolling `windowMs`.
export function createRateLimiter({ storeName, maxRequests, windowMs }) {
  // Fallback only. If Netlify Blobs is unavailable, counts live in this map.
  // NOTE: it resets on every cold start and is not shared between instances,
  // so it is a materially weaker guarantee than Blobs. It is a deliberate
  // fail-open: an outage degrades limiting rather than taking Keenshield down.
  const inMemory = new Map();

  function next(record, now) {
    if (!record || typeof record.count !== "number" || typeof record.windowStart !== "number"
        || now - record.windowStart >= windowMs) {
      return { allowed: true, record: { count: 1, windowStart: now } };
    }

    if (record.count >= maxRequests) {
      return { allowed: false, record };
    }

    return { allowed: true, record: { count: record.count + 1, windowStart: record.windowStart } };
  }

  return async function check(key) {
    const now = Date.now();

    try {
      // Strong consistency: a counter read immediately after a write must not be
      // stale, otherwise the limit is trivially bypassed by rapid-fire requests.
      const store = getStore({ name: storeName, consistency: "strong" });
      const result = next(await store.get(key, { type: "json" }), now);
      if (result.allowed) await store.setJSON(key, result.record);
      return result.allowed;
    } catch (err) {
      console.error(`Rate limit store ${storeName} unavailable, falling back to in-memory counter:`, err);
      const result = next(inMemory.get(key), now);
      if (result.allowed) inMemory.set(key, result.record);
      return result.allowed;
    }
  };
}

// Reads and parses a JSON body, refusing anything over `maxBytes`. Returns
// { body } or { error: Response }.
export async function readJsonBody(request, maxBytes) {
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    return { error: jsonResponse(413, { error: "Payload too large" }) };
  }

  try {
    const raw = await request.text();
    if (raw.length > maxBytes) return { error: jsonResponse(413, { error: "Payload too large" }) };
    const body = JSON.parse(raw || "{}");
    if (!body || typeof body !== "object") return { error: jsonResponse(400, { error: "Invalid JSON" }) };
    return { body };
  } catch {
    return { error: jsonResponse(400, { error: "Invalid JSON" }) };
  }
}
