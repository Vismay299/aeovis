/**
 * R6.5.1 — POST /api/scan observed at the ROUTE.
 *
 * This is the money path: every anonymous request here can spend Bright Data,
 * Perplexity and LLM budget. Its refusals were covered only at the predicate
 * level (rateLimit.test.mjs proves the arithmetic; operatorPerimeter.test.mjs
 * proves the decision), and a false predicate is only a refusal if the route
 * turns it into a status code. That step was an inference everywhere except
 * the one live curl in R0.1.4. This removes the inference.
 *
 * NO SCAN IS EVER STARTED by this suite. Every request under test returns
 * BEFORE createScanJob:
 *   - the validation path returns 400 on the first line;
 *   - the rate-limit path is driven by pre-seeding the in-memory counter, so
 *     the request under test is already over the limit when it arrives.
 * A test that spends real vendor budget to prove a refusal would be its own
 * kind of false economy.
 *
 * Harness: the same module-resolution hooks cronAuth.route.test.mjs uses. They
 * only answer "which file is this specifier" for `@/` and `next/server` —
 * nothing is stubbed, and the handler body runs unmodified.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import crypto from "node:crypto";

const SCAN_URL = "https://aeovis.test/api/scan";

// ---------------------------------------------------------------------------
// Environment, fixed BEFORE the route module is imported.
//
// Supabase is cleared deliberately: db.js and db/analytics.js build their
// clients at import time, so with these unset the rate-limit counter falls back
// to `global.memoryRateLimits` — which is exactly the seam this suite needs to
// drive a 429 without a database, and which also guarantees no scan row can be
// written even if a request did get past the gate.
// ---------------------------------------------------------------------------
process.env.NODE_ENV = "production";
delete process.env.NEXT_PUBLIC_SUPABASE_URL;
delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
process.env.SCAN_RATE_LIMIT = "5";
process.env.SCAN_RATE_LIMIT_WINDOW_MS = "3600000";
process.env.SCAN_RATE_LIMIT_SALT = "r651-route-test-salt";

register("./cronAuth.route.hooks.mjs", import.meta.url);

let importError = null;
let POST = null;
try {
  ({ POST } = await import("../app/api/scan/route.js"));
} catch (error) {
  importError = error;
}

function handler() {
  assert.equal(importError, null, `route module failed to import: ${importError?.message}`);
  assert.equal(typeof POST, "function", "POST must be exported");
  return POST;
}

function post(body, headers = {}) {
  return new Request(SCAN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

/** The bucket key rateLimit.js computes, recreated so the counter can be seeded. */
function bucketKey(ip) {
  const salt = process.env.SCAN_RATE_LIMIT_SALT || "";
  return crypto.createHash("sha256").update(`${salt}:${ip}`).digest("hex").slice(0, 32);
}

function windowStart(nowMs, windowMs) {
  return new Date(Math.floor(nowMs / windowMs) * windowMs).toISOString();
}

/** Put the in-memory counter for `ip` at `hits`, so the next request is over. */
function seedCounter(ip, hits) {
  global.memoryRateLimits = global.memoryRateLimits || new Map();
  const key = `${bucketKey(ip)}|${windowStart(Date.now(), 3600000)}`;
  global.memoryRateLimits.set(key, hits);
}

test("the scan route module imports and exports POST", () => {
  handler();
});

test("a request with no brand is refused before anything is spent", async () => {
  const res = await handler()(post({}));
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.match(body.detail, /brand/i);
});

test("a blank brand is refused too, not treated as a brand named ' '", async () => {
  const res = await handler()(post({ brand: "   " }));
  assert.equal(res.status, 400);
});

test("THE MONEY PATH — the 6th scan in an hour from one address returns 429", async () => {
  const ip = "203.0.113.201";
  seedCounter(ip, 5); // five already counted this window, limit is 5

  const res = await handler()(post({ brand: "Acme", url: "https://acme.io" }, { "x-real-ip": ip }));

  assert.equal(res.status, 429, "the sixth request must be refused");
  assert.equal(res.headers.get("x-ratelimit-limit"), "5");
  assert.equal(res.headers.get("x-ratelimit-remaining"), "0");

  const retryAfter = Number(res.headers.get("retry-after"));
  assert.ok(retryAfter > 0 && retryAfter <= 3600, `retry-after must be within the window, got ${retryAfter}`);

  const body = await res.json();
  assert.match(body.detail, /too many/i);
});

test("the limit is env-configurable, observed at the route", async () => {
  const previous = process.env.SCAN_RATE_LIMIT;
  process.env.SCAN_RATE_LIMIT = "2";
  try {
    const ip = "198.51.100.202";
    seedCounter(ip, 2);
    const res = await handler()(post({ brand: "Acme" }, { "x-real-ip": ip }));
    assert.equal(res.status, 429);
    assert.equal(res.headers.get("x-ratelimit-limit"), "2", "the threshold must follow the env var");
  } finally {
    process.env.SCAN_RATE_LIMIT = previous;
  }
});

test("validation runs before the rate limit, so a bad request costs no quota", async () => {
  const ip = "203.0.113.203";
  seedCounter(ip, 0);

  const res = await handler()(post({}, { "x-real-ip": ip }));
  assert.equal(res.status, 400, "no brand is a 400, not a 429");

  // The counter must not have moved: a malformed request is not a scan attempt,
  // and letting it consume quota would let a typo lock a user out for an hour.
  const key = `${bucketKey(ip)}|${windowStart(Date.now(), 3600000)}`;
  assert.equal(global.memoryRateLimits.get(key), 0, "a rejected body must not count against the limit");
});

test("the refusal names no vendor and leaks no internals", async () => {
  const ip = "203.0.113.204";
  seedCounter(ip, 99);
  const res = await handler()(post({ brand: "Acme" }, { "x-real-ip": ip }));
  const body = await res.json();

  // R6.4.3's rule, checked here at the surface a stranger actually sees.
  assert.ok(
    !/bright ?data|serpapi|perplexity|openrouter|supabase/i.test(JSON.stringify(body)),
    `an anonymous refusal must not name infrastructure: ${JSON.stringify(body)}`
  );
});
