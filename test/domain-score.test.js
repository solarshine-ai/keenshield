import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  CANDIDATE_PATHS,
  DAILY_DOMAIN_SCORING_LIMIT,
  MAX_PAGES_PER_SITE,
  SITE_SCORE_MAX_AGE_MS,
  chooseCandidatePaths,
  collectSitePages,
  createDailyLimit,
  createDomainClaims,
  historyRowFor,
  htmlToText,
  lookupSiteScore,
  registrableDomain
} from "../lib/domain-score.js";

// A tiny in-memory stand-in for a Netlify Blobs store, with the same
// conditional-write (ETag) behaviour.
function fakeStore() {
  const data = new Map();
  let version = 0;
  return {
    data,
    broken: false,
    async getWithMetadata(key) {
      if (this.broken) throw new Error("blobs down");
      const entry = data.get(key);
      return entry ? { data: JSON.parse(entry.value), etag: entry.etag, metadata: {} } : null;
    },
    async setJSON(key, value, options = {}) {
      if (this.broken) throw new Error("blobs down");
      const current = data.get(key);
      if (options.onlyIfNew && current) return { modified: false };
      if (options.onlyIfMatch && (!current || current.etag !== options.onlyIfMatch)) return { modified: false };
      const etag = `"${++version}"`;
      data.set(key, { value: JSON.stringify(value), etag });
      return { modified: true, etag };
    }
  };
}

const NOW = Date.parse("2026-11-05T12:00:00Z");

describe("registrableDomain", () => {
  test("reduces a hostname to the site it belongs to", () => {
    assert.equal(registrableDomain("www.example.com"), "example.com");
    assert.equal(registrableDomain("shop.checkout.example.com"), "example.com");
    assert.equal(registrableDomain("www.amazon.co.uk"), "amazon.co.uk");
    assert.equal(registrableDomain("example.com."), "example.com");
    assert.equal(registrableDomain("192.168.1.1"), "192.168.1.1");
  });

  test("keeps each customer of a shared host separate", () => {
    assert.equal(registrableDomain("my-store.myshopify.com"), "my-store.myshopify.com");
    assert.equal(registrableDomain("www.someone.github.io"), "someone.github.io");
  });
});

describe("htmlToText", () => {
  test("drops scripts, styles and tags, and decodes entities", () => {
    const html = `<html><head><title>T</title><style>.a{}</style></head><body><script>alert(1)</script><h1>Terms &amp; Conditions</h1><p>Auto&#8209;renews&nbsp;monthly</p></body></html>`;
    const text = htmlToText(html);
    assert.match(text, /Terms & Conditions/);
    assert.match(text, /Auto‑renews monthly/);
    assert.doesNotMatch(text, /alert|\.a\{\}/);
  });
});

describe("chooseCandidatePaths", () => {
  test("reads linked policy pages first and never more than the page limit", () => {
    const html = `<a href="/pricing">Pricing</a> <a href="https://www.example.com/privacy/">Privacy</a> <a href="https://other.com/terms">x</a>`;
    const paths = chooseCandidatePaths(html, "https://www.example.com/");
    assert.deepEqual(paths.slice(0, 2), ["/privacy", "/pricing"]);
    assert.equal(paths.length, MAX_PAGES_PER_SITE - 1);
    assert.ok(paths.every((p) => CANDIDATE_PATHS.includes(p)));
  });
});

describe("collectSitePages", () => {
  test("reads the homepage plus pages that exist, at most 6 requests", async () => {
    const requested = [];
    const pages = {
      "https://example.com/": { url: "https://www.example.com/", body: `<title>Example</title><p>Welcome</p><a href="/refund-policy">Refunds</a>` },
      "https://www.example.com/refund-policy": { url: "https://www.example.com/refund-policy", body: "<p>No refunds after 7 days.</p>" },
      "https://www.example.com/terms": { url: "https://www.example.com/terms", body: "<p>Arbitration applies.</p>" }
    };
    const fetchPage = async (url) => {
      requested.push(url);
      const page = pages[url];
      return page ? { ok: true, ...page } : { ok: false, reason: "status-404" };
    };
    const result = await collectSitePages("example.com", { fetchPage });
    assert.ok(requested.length <= MAX_PAGES_PER_SITE);
    assert.equal(requested[0], "https://example.com/");
    assert.equal(requested[1], "https://www.example.com/refund-policy");
    assert.deepEqual(result.map((p) => p.url), [
      "https://www.example.com/",
      "https://www.example.com/refund-policy",
      "https://www.example.com/terms"
    ]);
    assert.equal(result[0].title, "Example");
  });

  test("ignores soft-404s that repeat the homepage, and off-site redirects", async () => {
    const fetchPage = async (url) => {
      if (url.endsWith("/legal")) return { ok: true, url: "https://elsewhere.com/legal", body: "<p>Other company</p>" };
      return { ok: true, url, body: "<p>Same homepage everywhere</p>" };
    };
    const result = await collectSitePages("example.com", { fetchPage });
    assert.deepEqual(result.map((p) => p.url), ["https://example.com/"]);
  });

  test("returns nothing when the site can't be read", async () => {
    let calls = 0;
    const result = await collectSitePages("example.com", { fetchPage: async () => { calls++; return { ok: false, reason: "timeout" }; } });
    assert.deepEqual(result, []);
    assert.equal(calls, 2); // https://example.com/ then https://www.example.com/
  });
});

describe("daily limit", () => {
  test("allows 200 new domain scorings per day, then refuses", async () => {
    assert.equal(DAILY_DOMAIN_SCORING_LIMIT, 200);
    const store = fakeStore();
    const limit = createDailyLimit({ store, now: () => NOW });
    for (let i = 0; i < 200; i++) assert.equal(await limit.reserve(), true, `slot ${i + 1}`);
    assert.equal(await limit.reached(), true);
    assert.equal(await limit.reserve(), false);
  });

  test("starts again the next UTC day", async () => {
    const store = fakeStore();
    let now = NOW;
    const limit = createDailyLimit({ store, limit: 2, now: () => now });
    assert.equal(await limit.reserve(), true);
    assert.equal(await limit.reserve(), true);
    assert.equal(await limit.reserve(), false);
    now += 24 * 60 * 60 * 1000;
    assert.equal(await limit.reached(), false);
    assert.equal(await limit.reserve(), true);
  });

  test("simultaneous reservations can't overshoot the limit", async () => {
    const store = fakeStore();
    const limit = createDailyLimit({ store, limit: 5, now: () => NOW, attempts: 50 });
    const results = await Promise.all(Array.from({ length: 20 }, () => limit.reserve()));
    assert.equal(results.filter(Boolean).length, 5);
  });

  test("fails closed when the counter store is unavailable", async () => {
    const store = fakeStore();
    store.broken = true;
    const limit = createDailyLimit({ store, now: () => NOW });
    assert.equal(await limit.reached(), true);
    assert.equal(await limit.reserve(), false);
  });
});

describe("domain claims", () => {
  test("only one request a day may score a domain", async () => {
    const store = fakeStore();
    let now = NOW;
    const claim = createDomainClaims({ store, now: () => now });
    assert.equal(await claim("example.com"), true);
    assert.equal(await claim("example.com"), false);
    assert.equal(await claim("other.com"), true);
    now += 24 * 60 * 60 * 1000;
    assert.equal(await claim("example.com"), true);
  });
});

describe("historyRowFor", () => {
  const next = { score: 6, riskLevel: "yellow", topReason: "Auto-renews yearly.", scoredAt: new Date(NOW) };

  test("adds a row when a score is first created", () => {
    assert.deepEqual(historyRowFor({ key: "example.com", kind: "site", previous: null, next }), {
      key: "example.com", kind: "site", score: 6, riskLevel: "yellow", topReason: "Auto-renews yearly.", scoredAt: new Date(NOW)
    });
  });

  test("adds a row when the score or its reason changes", () => {
    const prev = { score: 3, riskLevel: "green", topReason: "Routine terms." };
    assert.equal(historyRowFor({ key: "example.com/checkout", kind: "page", previous: prev, next })?.score, 6);
    assert.ok(historyRowFor({ key: "k", kind: "page", previous: { ...next, topReason: "Different." }, next }));
  });

  test("adds nothing when a re-score says the same thing", () => {
    assert.equal(historyRowFor({ key: "example.com", kind: "site", previous: { ...next }, next }), null);
  });

  test("only accepts page or site", () => {
    assert.throws(() => historyRowFor({ key: "k", kind: "user", previous: null, next }));
  });
});

describe("lookupSiteScore", () => {
  function deps(overrides = {}) {
    const store = fakeStore();
    const calls = { fetch: [], score: 0, saved: [], history: [], touched: 0 };
    const base = {
      now: () => NOW,
      load: async () => null,
      touch: async () => { calls.touched++; },
      save: async (row, previous) => {
        calls.saved.push(row);
        const h = historyRowFor({ key: row.domain, kind: "site", previous, next: row });
        if (h) calls.history.push(h);
      },
      limit: createDailyLimit({ store, now: () => NOW }),
      claim: createDomainClaims({ store, now: () => NOW }),
      fetchPage: async (url) => {
        calls.fetch.push(url);
        return url === "https://example.com/" ? { ok: true, url, body: "<p>We sell lamps. Subscriptions auto-renew.</p>" } : { ok: false };
      },
      score: async () => { calls.score++; return { score: 5, reasons: ["Subscriptions renew automatically."], summary: "A lamp shop." }; }
    };
    return { deps: { ...base, ...overrides }, calls, store };
  }

  test("scores a new domain from its own pages and records history", async () => {
    const { deps: d, calls } = deps();
    const { site, source } = await lookupSiteScore("example.com", d);
    assert.equal(source, "fresh");
    assert.equal(site.score, 5);
    assert.equal(site.riskLevel, "yellow");
    assert.equal(site.topReason, "Subscriptions renew automatically.");
    assert.deepEqual(site.pagesChecked, ["https://example.com/"]);
    assert.equal(calls.score, 1);
    assert.equal(calls.saved.length, 1);
    assert.equal(calls.history.length, 1);
    assert.equal(calls.history[0].kind, "site");
  });

  test("reuses a score younger than 30 days without fetching or AI", async () => {
    const stored = { domain: "example.com", score: 2, reasons: [], summary: "", scoredAt: new Date(NOW - SITE_SCORE_MAX_AGE_MS + 60_000), hits: 4 };
    const { deps: d, calls } = deps({ load: async () => stored });
    const { site, source } = await lookupSiteScore("example.com", d);
    assert.equal(source, "cached");
    assert.equal(site, stored);
    assert.equal(calls.fetch.length, 0);
    assert.equal(calls.score, 0);
    assert.equal(calls.touched, 1);
  });

  test("re-scores a score older than 30 days, and history keeps both", async () => {
    const stored = { domain: "example.com", score: 2, riskLevel: "green", topReason: "Routine.", reasons: ["Routine."], summary: "", scoredAt: new Date(NOW - SITE_SCORE_MAX_AGE_MS - 1) };
    const { deps: d, calls } = deps({ load: async () => stored });
    const { site, source } = await lookupSiteScore("example.com", d);
    assert.equal(source, "fresh");
    assert.equal(site.score, 5);
    assert.equal(calls.history.length, 1);
    assert.equal(calls.history[0].score, 5);
  });

  test("never scores IPs, localhost or internal names", async () => {
    for (const domain of ["127.0.0.1", "localhost", "printer.local", "10.0.0.1"]) {
      const { deps: d, calls } = deps();
      const { site, source } = await lookupSiteScore(domain, d);
      assert.equal(site, null);
      assert.equal(source, "skipped");
      assert.equal(calls.fetch.length, 0, domain);
    }
  });

  test("over the daily limit: no fetching, no AI, address checks only", async () => {
    const { deps: d, calls, store } = deps();
    store.data.set("scorings/2026-11-05", { value: JSON.stringify({ count: 200 }), etag: '"x"' });
    const { site, source } = await lookupSiteScore("example.com", d);
    assert.equal(site, null);
    assert.equal(source, "limited");
    assert.equal(calls.fetch.length, 0);
    assert.equal(calls.score, 0);
  });

  test("an unreadable site falls back without spending a daily slot", async () => {
    const { deps: d, calls, store } = deps({ fetchPage: async () => ({ ok: false, reason: "timeout" }) });
    const { site, source } = await lookupSiteScore("example.com", d);
    assert.equal(site, null);
    assert.equal(source, "unreachable");
    assert.equal(calls.score, 0);
    assert.equal(store.data.has("scorings/2026-11-05"), false);
  });

  test("an unreadable site keeps its old score rather than losing it", async () => {
    const stored = { domain: "example.com", score: 4, reasons: [], summary: "", scoredAt: new Date(NOW - SITE_SCORE_MAX_AGE_MS - 1) };
    const { deps: d } = deps({ load: async () => stored, fetchPage: async () => ({ ok: false }) });
    const { site, source } = await lookupSiteScore("example.com", d);
    assert.equal(site, stored);
    assert.equal(source, "stale");
  });

  test("a second request the same day doesn't score the domain again", async () => {
    const { deps: d, calls } = deps();
    await lookupSiteScore("example.com", d);
    const again = await lookupSiteScore("example.com", d); // load() still returns null here
    assert.equal(again.source, "skipped");
    assert.equal(calls.score, 1);
  });

  test("never throws, even when storage and AI fail", async () => {
    const { deps: d } = deps({
      score: async () => { throw new Error("AI down"); },
      save: async () => { throw new Error("db down"); }
    });
    const { site, source } = await lookupSiteScore("example.com", d);
    assert.equal(site, null);
    assert.equal(source, "unreachable");

    const broken = deps({ load: async () => { throw new Error("db down"); } });
    assert.deepEqual(await lookupSiteScore("example.com", broken.deps), { site: null, source: "skipped" });
  });
});
