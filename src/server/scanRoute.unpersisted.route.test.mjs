/**
 * R0.1.21 — POST /api/scan must not return 201 for a job that was never
 * persisted, observed at the REAL route.
 *
 * THE FINDING. `createScanJob` (src/server/db.js) fail-softs to
 * `global.memoryJobs` when there is no Supabase client, and the route returned
 * 201 plus a job id off that map. On a deploy with no credentials — or with
 * credentials that stopped loading — an anonymous stranger got 201 Created for
 * a scan nothing can ever read back, and `runScanChunk` went on to spend real
 * Bright Data + Perplexity + LLM budget on results with nowhere to land.
 * R0.1.4's negative control hit exactly this and billed nothing only because no
 * vendor credentials had loaded either, which its own author called luck.
 *
 * This suite drives that path against the actual handler. The environment below
 * IS the finding's environment: NODE_ENV=production with the Supabase vars
 * unset, which is what a misconfigured deployment looks like from inside the
 * process.
 *
 * NO SCAN IS EVER STARTED. Every request under test returns before
 * createScanJob, and the assertions below check that directly: `global.memoryJobs`
 * must not have grown, so nothing was enqueued and `runScanChunk` was never
 * reached.
 *
 * Harness: the same resolution-only module hooks cronAuth.route.test.mjs and
 * scanRoute.route.test.mjs use. They answer "which file is this specifier" for
 * `@/` and `next/server` and nothing else — no module is stubbed, shadowed or
 * mocked, and the handler body runs unmodified. If this file ever starts
 * substituting behaviour it stops being evidence.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import crypto from "node:crypto";

const SCAN_URL = "https://aeovis.test/api/scan";
const WINDOW_MS = 3600000;

// ---------------------------------------------------------------------------
// Environment, fixed BEFORE the route module is imported. db.js builds its
// client at import time, so these deletions are what make `supabase` null —
// the no-client path this task is about. The rate limit is set generously so
// that the requests under test are refused for the reason under test and not
// incidentally for quota (the one test that WANTS a 429 seeds its own counter).
// ---------------------------------------------------------------------------
process.env.NODE_ENV = "production";
delete process.env.NEXT_PUBLIC_SUPABASE_URL;
delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
delete process.env.SCAN_RATE_LIMIT_IP_HEADER;
delete process.env.VERCEL;
process.env.SCAN_RATE_LIMIT = "500";
process.env.SCAN_RATE_LIMIT_WINDOW_MS = String(WINDOW_MS);
process.env.SCAN_RATE_LIMIT_SALT = "r0121-unpersisted-salt";

register("./cronAuth.route.hooks.mjs", import.meta.url);

let importError = null;
let POST = null;
let supabaseClient = "not-read";
try {
  ({ POST } = await import("../app/api/scan/route.js"));
  ({ supabase: supabaseClient } = await import("./db.js"));
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

/** The counter key rateLimit.js + analytics.js build for an address. */
function counterKey(ip) {
  const salt = process.env.SCAN_RATE_LIMIT_SALT || "";
  const bucket = crypto.createHash("sha256").update(`${salt}:${ip}`).digest("hex").slice(0, 32);
  const started = new Date(Math.floor(Date.now() / WINDOW_MS) * WINDOW_MS).toISOString();
  return `${bucket}|${started}`;
}

function seedCounter(ip, hits) {
  global.memoryRateLimits = global.memoryRateLimits || new Map();
  global.memoryRateLimits.set(counterKey(ip), hits);
}

/** How many jobs the in-memory store holds right now (it may not exist yet). */
function memoryJobCount() {
  return global.memoryJobs instanceof Map ? global.memoryJobs.size : 0;
}

test("the scan route module imports and exports POST", () => {
  handler();
});

/**
 * The premise. Without this the suite could pass vacuously against a
 * fully-configured client that refused for some entirely different reason:
 * every assertion below is only about the no-client path if there is genuinely
 * no client. Named by variable, never by value.
 */
test("PREMISE — db.js built no client, so this is the no-credentials deployment", () => {
  assert.equal(importError, null, `db.js failed to import: ${importError?.message}`);
  assert.equal(
    supabaseClient,
    null,
    "NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY leaked into this suite; " +
      "the no-client path is not under test and the assertions below prove nothing"
  );
});

// ---------------------------------------------------------------------------
// The refusal itself. This is the criterion, observed.
// ---------------------------------------------------------------------------

test("THE MONEY PATH — an anonymous scan with no database is NOT a 201", async () => {
  const before = memoryJobCount();

  const res = await handler()(
    post({ brand: "Acme", url: "https://acme.io" }, { "x-real-ip": "203.0.113.121" })
  );

  assert.notEqual(
    res.status,
    201,
    "the route issued 201 Created for a scan job that was never persisted"
  );
  assert.equal(res.status, 503, `expected 503 Service Unavailable, got ${res.status}`);

  const body = await res.json();
  assert.equal(body.code, "scan_store_unavailable", "the refusal must be machine-legible");
  assert.ok(body.detail, "the refusal must carry a human-readable detail");
  assert.equal(body.job_id, undefined, "a refusal must not hand back a job id");

  // Nothing was enqueued: the guard fires BEFORE createScanJob, so no job
  // reached the memory map and runScanChunk was never called. This is the
  // assertion that says no vendor budget could have been spent.
  assert.equal(
    memoryJobCount(),
    before,
    "a job was created despite the refusal — runScanChunk may have been triggered"
  );
});

test("the 503 is loud and honest: not a 2xx, not a client error", async () => {
  const res = await handler()(post({ brand: "Beta Corp" }, { "x-real-ip": "203.0.113.122" }));
  assert.ok(res.status >= 500, `a broken deployment is not the caller's fault, got ${res.status}`);
  assert.ok(!res.ok, "the response must not read as a success");
});

test("the refusal names no vendor and leaks no infrastructure", async () => {
  const res = await handler()(post({ brand: "Gamma" }, { "x-real-ip": "203.0.113.123" }));
  const body = JSON.stringify(await res.json());
  assert.ok(
    !/bright ?data|serpapi|perplexity|openrouter|supabase|postgres/i.test(body),
    `an anonymous refusal must not name infrastructure: ${body}`
  );
});

// ---------------------------------------------------------------------------
// Controls. Without these, "return 503 from the first line" would pass the
// suite — and would have silently eaten the 400 and 429 that R6.5.1 and R0.1.4
// established on this same handler.
// ---------------------------------------------------------------------------

test("CONTROL — validation still runs first: a missing brand is 400, not 503", async () => {
  const res = await handler()(post({}, { "x-real-ip": "203.0.113.124" }));
  assert.equal(res.status, 400, "the store guard must not swallow the validation path");
});

test("CONTROL — the rate limit still runs first: an over-quota caller is 429, not 503", async () => {
  const ip = "203.0.113.125";
  seedCounter(ip, 500); // at the limit set above
  const res = await handler()(post({ brand: "Acme" }, { "x-real-ip": ip }));
  assert.equal(res.status, 429, "the store guard must not swallow the rate-limit path");
  assert.equal(res.headers.get("x-ratelimit-remaining"), "0");
});
