import assert from "node:assert/strict";
import test from "node:test";

import {
  clientIpOf,
  isTrustedOrigin,
  jsonResponse,
  readJsonBody,
  tokensMatch
} from "../lib/gate.js";

test("tokensMatch only accepts matching non-empty string tokens", () => {
  assert.equal(tokensMatch("secret", "secret"), true);
  assert.equal(tokensMatch("secret", "different"), false);
  assert.equal(tokensMatch("secret", ""), false);
  assert.equal(tokensMatch(null, "secret"), false);
});

test("isTrustedOrigin accepts configured and same-host origins", () => {
  assert.equal(
    isTrustedOrigin(new Request("https://api.example.test/check", {
      headers: { origin: "https://keenshield.app" }
    })),
    true
  );
  assert.equal(
    isTrustedOrigin(new Request("https://preview.example.test/check", {
      headers: { origin: "https://preview.example.test" }
    })),
    true
  );
  assert.equal(
    isTrustedOrigin(new Request("https://api.example.test/check", {
      headers: { origin: "https://untrusted.example" }
    })),
    false
  );
});

test("jsonResponse returns JSON with the requested status", async () => {
  const response = jsonResponse(201, { ok: true });

  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), { ok: true });
  assert.equal(response.headers.get("content-type"), "application/json");
});

test("clientIpOf returns the forwarded client IP or unknown", () => {
  const request = new Request("https://example.test", {
    headers: { "x-nf-client-connection-ip": "192.0.2.10" }
  });
  assert.equal(clientIpOf(request), "192.0.2.10");
  assert.equal(clientIpOf(new Request("https://example.test")), "unknown");
});

test("readJsonBody parses valid JSON and rejects invalid or oversized input", async () => {
  const parsed = await readJsonBody(new Request("https://example.test", {
    method: "POST",
    body: JSON.stringify({ name: "Keenshield" })
  }), 100);
  assert.deepEqual(parsed, { body: { name: "Keenshield" } });

  const invalid = await readJsonBody(new Request("https://example.test", {
    method: "POST",
    body: "not-json"
  }), 100);
  assert.equal(invalid.error.status, 400);

  const oversized = await readJsonBody(new Request("https://example.test", {
    method: "POST",
    body: "12345"
  }), 4);
  assert.equal(oversized.error.status, 413);
});
