// ============================================================
// KEENSHIELD — lib/free-scans.js
//
// Free scan allowances, kept free of Netlify specifics so they can be
// tested directly.
//
//   - The extension gets 5 free scans per install (`installId`).
//   - The website gets 3 free scans per signed-in account, or per
//     browser (`browserId`) for signed-out visitors.
//
// After the website's free scans, a scan needs Pro or a $1.99 scan
// credit. Counts never reset on their own.
// ============================================================

import { createHash } from "node:crypto";

export const EXTENSION_FREE_SCANS = 5;
export const WEBSITE_FREE_SCANS = 3;

// How much text one scan reads. A free scan reads a page or a short
// agreement; Pro and a paid scan credit read a whole lease or contract.
export const FREE_TEXT_LIMIT = 8000;
export const FULL_TEXT_LIMIT = 60000;

// Install and browser IDs come from the request body, so they are
// attacker-controlled. Normalize to the characters blob keys allow before
// they are used as one.
export function safeClientId(value) {
  if (typeof value !== "string") return null;
  const safe = value.trim().replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100);
  return safe || null;
}

function hashOf(value) {
  return createHash("sha256").update(value).digest("hex").slice(0, 40);
}

// The key a website scan is counted under. A signed-in account always wins,
// so the 3 free scans follow the person across browsers. Signed-out
// visitors are counted per browser, and a caller with neither falls back to
// its network address so leaving the ID out can't skip the count. Emails and
// addresses are hashed so no personal data ends up in a key.
//
// Keys contain ":", which `safeClientId` never lets through, so a website
// key can never collide with an extension install ID.
export function websiteScanKey({ email, browserId, ip }) {
  if (email) return `web-account:${hashOf(email)}`;
  const id = safeClientId(browserId);
  if (id) return `web-browser:${id}`;
  return `web-ip:${hashOf(String(ip || "unknown"))}`;
}

export function usedScansOf(record) {
  return record && typeof record.count === "number" && record.count > 0 ? Math.floor(record.count) : 0;
}

// Given the stored count, decide whether one more free scan is allowed and
// what the count becomes. `used` is the count after this scan when allowed,
// or the already-spent total when over the limit.
export function nextScanCountState(record, limit) {
  const used = usedScansOf(record);
  if (used >= limit) {
    return { allowed: false, used, record: { count: used } };
  }
  return { allowed: true, used: used + 1, record: { count: used + 1 } };
}

// Hands back a free scan that then failed to produce a result.
export function returnedScanCountState(record) {
  return { count: Math.max(0, usedScansOf(record) - 1) };
}

export function freeScansLeft(record, limit) {
  return Math.max(0, limit - usedScansOf(record));
}
