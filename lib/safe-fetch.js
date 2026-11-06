// ============================================================
// KEENSHIELD — lib/safe-fetch.js
//
// The only way Keenshield's server fetches someone else's web
// page. It reads a company's public pages to score the company,
// so it must never be steerable into Keenshield's own network
// or anyone else's private one.
//
// Rules, every one enforced on every hop of a redirect chain:
//   - http or https only, default ports only, no user:pass@
//   - public hostnames only: no IP addresses, localhost, or
//     internal names (.local, .internal, .lan, …)
//   - the hostname's DNS answers are checked too, at connect
//     time, so a public name pointing at a private address is
//     refused (this also defeats DNS rebinding)
//   - at most 3 redirects, 8 seconds per page in total
//   - at most 200 KB read per page
//   - identifies itself as KeenShieldBot
// ============================================================

import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import zlib from "node:zlib";

export const USER_AGENT = "KeenShieldBot/1.0 (+https://keenshield.app)";
export const MAX_REDIRECTS = 3;
export const FETCH_TIMEOUT_MS = 8000;
export const MAX_PAGE_BYTES = 200 * 1024;

// -----------------------------------------------------------
// Addresses
// -----------------------------------------------------------

const blocked = new net.BlockList();
for (const [prefix, bits] of [
  ["0.0.0.0", 8], // "this network"
  ["10.0.0.0", 8], // private
  ["100.64.0.0", 10], // carrier-grade NAT
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local, cloud metadata (169.254.169.254)
  ["172.16.0.0", 12], // private
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // documentation
  ["192.88.99.0", 24], // 6to4 relay
  ["192.168.0.0", 16], // private
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // documentation
  ["203.0.113.0", 24], // documentation
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4] // reserved, broadcast
]) {
  blocked.addSubnet(prefix, bits, "ipv4");
}
for (const [prefix, bits] of [
  ["::", 128], // unspecified
  ["::1", 128], // loopback
  ["::", 96], // IPv4-compatible (deprecated)
  ["100::", 64], // discard
  ["2001::", 32], // Teredo
  ["2001:db8::", 32], // documentation
  ["2002::", 16], // 6to4
  ["fc00::", 7], // unique local
  ["fe80::", 10], // link-local
  ["fec0::", 10], // site-local (deprecated)
  ["ff00::", 8] // multicast
]) {
  blocked.addSubnet(prefix, bits, "ipv6");
}

// IPv6 forms that carry an IPv4 address inside them: ::ffff:a.b.c.d (mapped)
// and 64:ff9b::a.b.c.d (NAT64). The embedded IPv4 address is what counts.
function embeddedIpv4(address) {
  const lower = address.toLowerCase();
  const dotted = lower.match(/^(?:::ffff:|64:ff9b::)(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (dotted) return dotted[1];
  const hex = lower.match(/^(?:::ffff:|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hex) {
    const hi = parseInt(hex[1], 16);
    const lo = parseInt(hex[2], 16);
    return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  }
  return null;
}

// True for any address Keenshield's server must never connect to. Anything
// that doesn't parse as an IP address is treated as blocked.
export function isBlockedAddress(address) {
  const ip = String(address || "").replace(/^\[|\]$/g, "").split("%")[0];
  const family = net.isIP(ip);
  if (family === 4) return blocked.check(ip, "ipv4");
  if (family === 6) {
    const v4 = embeddedIpv4(ip);
    if (v4) return isBlockedAddress(v4);
    return blocked.check(ip, "ipv6");
  }
  return true;
}

// -----------------------------------------------------------
// Hostnames and URLs
// -----------------------------------------------------------

// Names that only mean something inside a private network, or are reserved
// and never public.
const INTERNAL_SUFFIXES = [
  "localhost", "local", "localdomain", "internal", "intranet", "lan", "home", "corp",
  "private", "priv", "test", "example", "invalid", "onion", "arpa", "home.arpa"
];

export function isPublicHostname(hostname) {
  const host = String(hostname || "").toLowerCase().replace(/\.$/, "");
  if (!host || host.length > 253) return false;
  if (host.startsWith("[") || net.isIP(host)) return false;

  const labels = host.split(".");
  if (labels.length < 2) return false;
  if (!labels.every((label) => /^[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?$/.test(label))) return false;

  // A real top-level domain is letters (or punycode). An all-number last label
  // means the "name" is really an address written some other way.
  const tld = labels[labels.length - 1];
  if (!/^(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/.test(tld)) return false;

  return !INTERNAL_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

// Returns the parsed URL if Keenshield may fetch it, otherwise null.
export function checkFetchTarget(value) {
  let url;
  try {
    url = value instanceof URL ? new URL(value.href) : new URL(String(value));
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.username || url.password) return null;
  // Default ports only. Odd ports are how internal services usually get reached.
  if (url.port !== "") return null;
  if (!isPublicHostname(url.hostname)) return null;
  url.hash = "";
  return url;
}

// -----------------------------------------------------------
// DNS, checked at connect time
// -----------------------------------------------------------

function defaultResolve(hostname) {
  return dns.promises.lookup(hostname, { all: true, verbatim: true });
}

// A drop-in `lookup` for http.request. It resolves the name itself and
// refuses the connection if ANY answer is a blocked address, so the address
// that was checked is exactly the address connected to.
export function guardedLookup(resolve = defaultResolve) {
  return (hostname, options, callback) => {
    if (typeof options === "function") {
      callback = options;
      options = {};
    }
    Promise.resolve()
      .then(() => resolve(hostname))
      .then((answers) => {
        const list = (Array.isArray(answers) ? answers : [answers])
          .map((a) => (typeof a === "string" ? { address: a, family: net.isIP(a) } : a))
          .filter((a) => a && a.address);
        if (!list.length) throw Object.assign(new Error(`No address for ${hostname}`), { code: "ENOTFOUND" });
        if (list.some((a) => isBlockedAddress(a.address))) {
          throw Object.assign(new Error(`Refusing to connect to a private address for ${hostname}`), { code: "EBLOCKED" });
        }
        const wanted = options && options.family ? list.filter((a) => a.family === options.family) : list;
        const usable = wanted.length ? wanted : list;
        if (options && options.all) callback(null, usable);
        else callback(null, usable[0].address, usable[0].family);
      })
      .catch((err) => callback(err));
  };
}

// -----------------------------------------------------------
// Reading a response
// -----------------------------------------------------------

// Reads a stream until it ends or `maxBytes` have arrived, whichever comes
// first. Returns the bytes read and whether it stopped early.
export function readLimited(stream, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let done = false;
    const finish = (truncated) => {
      if (done) return;
      done = true;
      resolve({ buffer: Buffer.concat(chunks, size), truncated });
    };
    stream.on("data", (chunk) => {
      if (done) return;
      const room = maxBytes - size;
      if (chunk.length >= room) {
        chunks.push(chunk.subarray(0, room));
        size += room;
        finish(true);
        stream.destroy();
        return;
      }
      chunks.push(chunk);
      size += chunk.length;
    });
    stream.on("end", () => finish(false));
    stream.on("close", () => finish(false));
    stream.on("error", (err) => {
      if (done) return;
      done = true;
      reject(err);
    });
  });
}

const TEXT_TYPES = /^(text\/html|application\/xhtml\+xml|text\/plain)\b/i;

function decodeBody(buffer, contentType) {
  const charset = /charset=["']?([\w-]+)/i.exec(contentType || "")?.[1];
  try {
    return new TextDecoder(charset || "utf-8").decode(buffer);
  } catch {
    return new TextDecoder("utf-8").decode(buffer);
  }
}

function decompressor(encoding) {
  switch ((encoding || "").toLowerCase().trim()) {
    case "":
    case "identity":
      return null;
    case "gzip":
    case "x-gzip":
      return zlib.createGunzip();
    case "deflate":
      return zlib.createInflate();
    case "br":
      return zlib.createBrotliDecompress();
    default:
      return undefined; // unsupported
  }
}

// One request, no redirects followed. Resolves to
// { status, location, contentType, body } — `body` is null for non-text responses.
export function fetchOnce(url, { signal, resolve, maxBytes = MAX_PAGE_BYTES } = {}) {
  const transport = url.protocol === "https:" ? https : http;
  return new Promise((done, fail) => {
    const req = transport.request(url, {
      method: "GET",
      signal,
      lookup: guardedLookup(resolve),
      agent: false,
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "text/html,application/xhtml+xml,text/plain;q=0.8",
        "Accept-Encoding": "gzip, deflate, br",
        "Accept-Language": "en"
      }
    }, (res) => {
      const status = res.statusCode || 0;
      const location = typeof res.headers.location === "string" ? res.headers.location : null;
      const contentType = String(res.headers["content-type"] || "");

      if (status < 200 || status >= 300 || !TEXT_TYPES.test(contentType)) {
        res.destroy();
        done({ status, location, contentType, body: null });
        return;
      }

      const unzip = decompressor(res.headers["content-encoding"]);
      if (unzip === undefined) {
        res.destroy();
        done({ status, location, contentType, body: null });
        return;
      }
      const stream = unzip ? res.pipe(unzip) : res;
      readLimited(stream, maxBytes)
        .then(({ buffer, truncated }) => {
          if (truncated) res.destroy();
          done({ status, location, contentType, body: decodeBody(buffer, contentType) });
        })
        .catch(fail);
    });
    req.on("error", fail);
    req.end();
  });
}

// Fetches one public page, following at most 3 redirects, each one checked
// against the same rules. Never throws: resolves to
//   { ok: true, url, status, contentType, body }   or   { ok: false, reason }.
//
// `fetchOnce` and `resolve` can be swapped out in tests.
export async function safeFetchPage(input, options = {}) {
  const {
    fetchOnce: requestOnce = fetchOnce,
    resolve,
    timeoutMs = FETCH_TIMEOUT_MS,
    maxBytes = MAX_PAGE_BYTES,
    maxRedirects = MAX_REDIRECTS
  } = options;

  let url = checkFetchTarget(input);
  if (!url) return { ok: false, reason: "blocked-url" };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    for (let redirects = 0; ; redirects++) {
      const res = await requestOnce(url, { signal: controller.signal, resolve, maxBytes });

      if (res.status >= 300 && res.status < 400) {
        if (!res.location) return { ok: false, reason: "bad-redirect" };
        if (redirects >= maxRedirects) return { ok: false, reason: "too-many-redirects" };
        let next;
        try {
          next = new URL(res.location, url);
        } catch {
          return { ok: false, reason: "bad-redirect" };
        }
        url = checkFetchTarget(next);
        if (!url) return { ok: false, reason: "blocked-redirect" };
        continue;
      }

      if (res.status < 200 || res.status >= 300) return { ok: false, reason: `status-${res.status}` };
      if (res.body == null) return { ok: false, reason: "not-text" };
      return { ok: true, url: url.href, status: res.status, contentType: res.contentType, body: res.body };
    }
  } catch (err) {
    if (controller.signal.aborted) return { ok: false, reason: "timeout" };
    return { ok: false, reason: err && err.code === "EBLOCKED" ? "blocked-address" : "network-error" };
  } finally {
    clearTimeout(timer);
  }
}
