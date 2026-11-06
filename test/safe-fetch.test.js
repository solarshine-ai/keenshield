import assert from "node:assert/strict";
import http from "node:http";
import { Readable } from "node:stream";
import { describe, test } from "node:test";

import {
  MAX_PAGE_BYTES,
  USER_AGENT,
  checkFetchTarget,
  fetchOnce,
  guardedLookup,
  isBlockedAddress,
  isPublicHostname,
  readLimited,
  safeFetchPage
} from "../lib/safe-fetch.js";

describe("isBlockedAddress", () => {
  test("blocks loopback, private, link-local, metadata and reserved addresses", () => {
    for (const ip of [
      "127.0.0.1", "127.8.9.10", "10.0.0.5", "172.16.0.1", "172.31.255.255", "192.168.1.1",
      "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "255.255.255.255", "198.18.0.1",
      "::1", "::", "fe80::1", "fc00::1", "fd12:3456::1", "ff02::1",
      "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:10.0.0.1", "64:ff9b::192.168.0.1", "[::1]"
    ]) {
      assert.equal(isBlockedAddress(ip), true, ip);
    }
  });

  test("allows ordinary public addresses", () => {
    for (const ip of ["93.184.216.34", "8.8.8.8", "172.32.0.1", "2606:4700:4700::1111", "::ffff:8.8.8.8"]) {
      assert.equal(isBlockedAddress(ip), false, ip);
    }
  });

  test("treats anything that isn't an IP address as blocked", () => {
    assert.equal(isBlockedAddress("example.com"), true);
    assert.equal(isBlockedAddress(""), true);
    assert.equal(isBlockedAddress(undefined), true);
  });
});

describe("isPublicHostname", () => {
  test("accepts ordinary public names", () => {
    for (const host of ["example.com", "www.example.co.uk", "shop.example.store", "xn--bcher-kva.com"]) {
      assert.equal(isPublicHostname(host), true, host);
    }
  });

  test("rejects IPs, localhost, single labels and internal names", () => {
    for (const host of [
      "127.0.0.1", "10.0.0.1", "[::1]", "::1", "localhost", "foo.localhost", "intranet",
      "printer.local", "db.internal", "nas.lan", "router.home", "app.corp", "x.home.arpa",
      "1.1.1.1.in-addr.arpa", "site.test", "my.example", "abc.onion", "host.123", ""
    ]) {
      assert.equal(isPublicHostname(host), false, host);
    }
  });
});

describe("checkFetchTarget", () => {
  test("allows http and https on default ports", () => {
    assert.equal(checkFetchTarget("https://example.com/terms")?.href, "https://example.com/terms");
    assert.equal(checkFetchTarget("http://example.com/")?.href, "http://example.com/");
  });

  test("refuses other schemes, credentials, odd ports, IPs and localhost", () => {
    for (const target of [
      "ftp://example.com/", "file:///etc/passwd", "javascript:alert(1)", "gopher://example.com/",
      "https://user:pw@example.com/", "https://example.com:8443/", "http://example.com:22/",
      "http://127.0.0.1/", "http://2130706433/", "http://0x7f000001/", "http://0177.0.0.1/",
      "http://[::1]/", "http://[::ffff:127.0.0.1]/", "http://169.254.169.254/latest/meta-data/",
      "http://localhost/", "http://localhost./", "http://metadata.google.internal/", "not a url"
    ]) {
      assert.equal(checkFetchTarget(target), null, target);
    }
  });
});

describe("guardedLookup", () => {
  const run = (answers, options = {}) => new Promise((resolve) => {
    guardedLookup(async () => answers)("public.example.com", options, (err, address, family) => resolve({ err, address, family }));
  });

  test("refuses a public name that resolves to a private address", async () => {
    for (const answers of [
      [{ address: "127.0.0.1", family: 4 }],
      [{ address: "10.1.2.3", family: 4 }],
      [{ address: "169.254.169.254", family: 4 }],
      [{ address: "::1", family: 6 }],
      // One bad answer among good ones is enough to refuse.
      [{ address: "93.184.216.34", family: 4 }, { address: "192.168.0.10", family: 4 }]
    ]) {
      const { err } = await run(answers);
      assert.equal(err?.code, "EBLOCKED", JSON.stringify(answers));
    }
  });

  test("passes public answers through, in both callback styles", async () => {
    const single = await run([{ address: "93.184.216.34", family: 4 }]);
    assert.equal(single.err, null);
    assert.equal(single.address, "93.184.216.34");
    assert.equal(single.family, 4);

    const all = await run([{ address: "93.184.216.34", family: 4 }], { all: true });
    assert.deepEqual(all.address, [{ address: "93.184.216.34", family: 4 }]);
  });
});

describe("readLimited", () => {
  test("stops at the byte limit", async () => {
    const big = Readable.from([Buffer.alloc(150 * 1024, 97), Buffer.alloc(150 * 1024, 98)]);
    const { buffer, truncated } = await readLimited(big, MAX_PAGE_BYTES);
    assert.equal(buffer.length, 200 * 1024);
    assert.equal(truncated, true);
  });

  test("reads short bodies whole", async () => {
    const { buffer, truncated } = await readLimited(Readable.from([Buffer.from("hello")]), MAX_PAGE_BYTES);
    assert.equal(buffer.toString(), "hello");
    assert.equal(truncated, false);
  });
});

describe("fetchOnce against a real socket", () => {
  test("never connects when the name resolves to a loopback address", async () => {
    let connections = 0;
    const server = http.createServer((_req, res) => res.end("secret"));
    server.on("connection", () => connections++);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address();
    try {
      await assert.rejects(
        fetchOnce(new URL(`http://public.example.com:${port}/`), { resolve: async () => [{ address: "127.0.0.1", family: 4 }] }),
        (err) => err.code === "EBLOCKED"
      );
      assert.equal(connections, 0);
    } finally {
      server.close();
    }
  });
});

describe("safeFetchPage", () => {
  const ok = (body = "<html>hi</html>") => ({ status: 200, location: null, contentType: "text/html", body });
  const redirect = (location) => ({ status: 301, location, contentType: "", body: null });

  test("refuses blocked starting addresses without making a request", async () => {
    let calls = 0;
    const fetchOnce = async () => { calls++; return ok(); };
    for (const target of ["http://127.0.0.1/", "http://localhost/", "http://10.0.0.1/", "http://[::1]/", "file:///etc/passwd"]) {
      const res = await safeFetchPage(target, { fetchOnce });
      assert.deepEqual(res, { ok: false, reason: "blocked-url" }, target);
    }
    assert.equal(calls, 0);
  });

  test("follows up to 3 redirects and no more", async () => {
    const chain = (hops) => {
      let n = 0;
      return async () => (n++ < hops ? redirect(`/hop-${n}`) : ok());
    };
    const three = await safeFetchPage("https://example.com/", { fetchOnce: chain(3) });
    assert.equal(three.ok, true);
    assert.equal(three.url, "https://example.com/hop-3");

    const four = await safeFetchPage("https://example.com/", { fetchOnce: chain(4) });
    assert.deepEqual(four, { ok: false, reason: "too-many-redirects" });
  });

  test("refuses a redirect into a private address", async () => {
    for (const location of ["http://127.0.0.1/admin", "http://localhost:8080/", "http://169.254.169.254/latest/", "http://[::1]/", "file:///etc/passwd"]) {
      const urls = [];
      const fetchOnce = async (url) => { urls.push(url.href); return redirect(location); };
      const res = await safeFetchPage("https://example.com/", { fetchOnce });
      assert.deepEqual(res, { ok: false, reason: "blocked-redirect" }, location);
      assert.deepEqual(urls, ["https://example.com/"]);
    }
  });

  test("reports a DNS answer pointing at a private address as blocked", async () => {
    const fetchOnce = async () => { throw Object.assign(new Error("blocked"), { code: "EBLOCKED" }); };
    assert.deepEqual(await safeFetchPage("https://example.com/", { fetchOnce }), { ok: false, reason: "blocked-address" });
  });

  test("gives up after the timeout", async () => {
    const fetchOnce = (_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new Error("aborted")));
    });
    assert.deepEqual(await safeFetchPage("https://example.com/", { fetchOnce, timeoutMs: 20 }), { ok: false, reason: "timeout" });
  });

  test("skips missing pages and non-text responses", async () => {
    assert.deepEqual(
      await safeFetchPage("https://example.com/terms", { fetchOnce: async () => ({ status: 404, location: null, contentType: "text/html", body: null }) }),
      { ok: false, reason: "status-404" }
    );
    assert.deepEqual(
      await safeFetchPage("https://example.com/x.pdf", { fetchOnce: async () => ({ status: 200, location: null, contentType: "application/pdf", body: null }) }),
      { ok: false, reason: "not-text" }
    );
  });

  test("identifies itself as KeenShieldBot", () => {
    assert.equal(USER_AGENT, "KeenShieldBot/1.0 (+https://keenshield.app)");
  });
});
