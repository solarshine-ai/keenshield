import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  EXTENSION_FREE_SCANS,
  FREE_TEXT_LIMIT,
  FULL_TEXT_LIMIT,
  WEBSITE_FREE_SCANS,
  freeScansLeft,
  nextScanCountState,
  returnedScanCountState,
  safeClientId,
  websiteScanKey
} from "../lib/free-scans.js";

describe("allowances", () => {
  test("the website gives 3 free scans and the extension 5", () => {
    assert.equal(WEBSITE_FREE_SCANS, 3);
    assert.equal(EXTENSION_FREE_SCANS, 5);
  });

  test("a free scan reads 8,000 characters and a full scan 60,000", () => {
    assert.equal(FREE_TEXT_LIMIT, 8000);
    assert.equal(FULL_TEXT_LIMIT, 60000);
  });
});

describe("nextScanCountState", () => {
  test("allows exactly the limit, then refuses", () => {
    let record = null;
    for (let i = 1; i <= WEBSITE_FREE_SCANS; i++) {
      const next = nextScanCountState(record, WEBSITE_FREE_SCANS);
      assert.equal(next.allowed, true);
      assert.equal(next.used, i);
      record = next.record;
    }
    const over = nextScanCountState(record, WEBSITE_FREE_SCANS);
    assert.equal(over.allowed, false);
    assert.equal(over.used, WEBSITE_FREE_SCANS);
  });

  test("treats a missing or corrupt record as unused", () => {
    for (const record of [null, undefined, {}, { count: "2" }, { count: -4 }]) {
      assert.deepEqual(nextScanCountState(record, 3), { allowed: true, used: 1, record: { count: 1 } });
    }
  });
});

describe("returnedScanCountState", () => {
  test("hands one scan back and never goes below zero", () => {
    assert.deepEqual(returnedScanCountState({ count: 3 }), { count: 2 });
    assert.deepEqual(returnedScanCountState({ count: 0 }), { count: 0 });
    assert.deepEqual(returnedScanCountState(null), { count: 0 });
  });
});

describe("freeScansLeft", () => {
  test("counts down to zero", () => {
    assert.equal(freeScansLeft(null, 3), 3);
    assert.equal(freeScansLeft({ count: 2 }, 3), 1);
    assert.equal(freeScansLeft({ count: 7 }, 3), 0);
  });
});

describe("websiteScanKey", () => {
  test("a signed-in account wins over the browser", () => {
    const signedIn = websiteScanKey({ email: "ada@example.com", browserId: "b1", ip: "1.2.3.4" });
    assert.match(signedIn, /^web-account:[0-9a-f]{40}$/);
    assert.equal(signedIn, websiteScanKey({ email: "ada@example.com", browserId: "b2" }));
    assert.ok(!signedIn.includes("ada"), "no email in the key");
  });

  test("signed-out visitors are counted per browser", () => {
    assert.equal(websiteScanKey({ browserId: "abc-123" }), "web-browser:abc-123");
    assert.notEqual(websiteScanKey({ browserId: "abc-123" }), websiteScanKey({ browserId: "def-456" }));
  });

  test("leaving the browser ID out falls back to the network address", () => {
    const key = websiteScanKey({ ip: "1.2.3.4" });
    assert.match(key, /^web-ip:[0-9a-f]{40}$/);
    assert.equal(key, websiteScanKey({ browserId: "   ", ip: "1.2.3.4" }));
  });

  test("a website key can never collide with an extension install ID", () => {
    const installId = safeClientId("web-browser:abc");
    assert.ok(!installId.includes(":"));
    assert.notEqual(installId, websiteScanKey({ browserId: "abc" }));
  });
});

describe("safeClientId", () => {
  test("keeps blob-safe characters and caps the length", () => {
    assert.equal(safeClientId(" a/b c "), "a_b_c");
    assert.equal(safeClientId("x".repeat(200)).length, 100);
    assert.equal(safeClientId(""), null);
    assert.equal(safeClientId(42), null);
  });
});
