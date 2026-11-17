/**
 * R0.1.4 — the per-IP scan limit is keyed on an address the CALLER CANNOT SET,
 * observed at the real POST /api/scan handler.
 *
 * R6.5.1 already proved the route turns "over the limit" into a 429. What it
 * could not prove is that "one IP" means an IP at all. Before this suite's
 * change, `clientBucketKey` read `x-real-ip` first, unconditionally — and
 * `x-real-ip` is a request header like any other. Measured against the module:
 * 25 requests carrying a rotating `x-real-ip` were allowed 25 times under a
 * limit of 5, including when `x-vercel-forwarded-for` named a single real
 * client the whole time. A limit that a `curl -H` defeats is not a limit.
 *
 * NO SCAN IS EVER STARTED. Every bucket the route could possibly derive from
 * the request under test — the trusted one AND both spoofed ones — is seeded
 * to the limit first, so the handler returns 429 before createScanJob no
 * matter which identity it picks. The assertion that discriminates is which
 * counter moved, not whether the request was refused. A test that could spend
 * vendor budget on the way to failing is not a safe test.
 *
 * Harness: the same resolution-only hooks as scanRoute.route.test.mjs.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import crypto from "node:crypto";

const SCAN_URL = "https://aeovis.test/api/scan";
const WINDOW_MS = 3600000;

// ---------------------------------------------------------------------------
// Environment, fixed BEFORE the route module is imported.
//
// VERCEL=1 because that is the deployment this repo ships to (vercel.json) and
// it is the gate on trusting `x-vercel-forwarded-for`: Vercel strips inbound
// `x-vercel-*` headers and writes that one itself, so off Vercel it would be as
// forgeable as the rest and must NOT be trusted.
//
// Supabase is cleared for the same reason R6.5.1 clears it: the counter falls
// back to `global.memoryRateLimits`, which is the seam this suite seeds, and no
// scan row can be written even if a request somehow got past the gate.
// ---------------------------------------------------------------------------
process.env.NODE_ENV = "production";
process.env.VERCEL = "1";
delete process.env.NEXT_PUBLIC_SUPABASE_URL;
delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
delete process.env.SCAN_RATE_LIMIT_IP_HEADER;
process.env.SCAN_RATE_LIMIT = "5";
process.env.SCAN_RATE_LIMIT_WINDOW_MS = String(WINDOW_MS);
process.env.SCAN_RATE_LIMIT_SALT = "r014-spoof-salt";

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

/** The counter key rateLimit.js + analytics.js build for an address. */
function counterKey(ip) {
  const salt = process.env.SCAN_RATE_LIMIT_SALT || "";
  const bucket = crypto.createHash("sha256").update(`${salt}:${ip}`).digest("hex").slice(0, 32);
  const started = new Date(Math.floor(Date.now() / WINDOW_MS) * WINDOW_MS).toISOString();
  return `${bucket}|${started}`;
}

function seed(ip, hits) {
  global.memoryRateLimits = global.memoryRateLimits || new Map();
  global.memoryRateLimits.set(counterKey(ip), hits);
}

const hits = (ip) => global.memoryRateLimits.get(counterKey(ip));

// The catch-all identity, put over any configured limit before a single test
// runs. Without it, a request whose address the route FAILS to derive falls
// into the shared "unidentified" bucket with a fresh count — and a fresh count
// means allowed, means createScanJob, means real vendor spend on the way to a
// failing assertion. Verified: with the pre-fix module in place and this line
// removed, the money-path test returned 201 and started a scan. The seed is
// what makes this suite safe to run against a BROKEN implementation, which is
// the only condition under which it matters.
seed("unidentified", 10_000);

test("THE SPOOF — a forged x-real-ip does not buy a fresh bucket", async () => {
  const real = "203.0.113.99"; // what Vercel says the client is
  const forgedRealIp = "192.0.2.77"; // what the client claims it is
  const forgedForwarded = "198.51.100.77"; // and its second claim

  // Every candidate identity is already at the limit, so this request is
  // refused whichever one the route picks. No scan can start from here.
  seed(real, 5);
  seed(forgedRealIp, 5);
  seed(forgedForwarded, 5);

  const res = await handler()(
    post(
      { brand: "Acme", url: "https://acme.io" },
      {
        "x-vercel-forwarded-for": real,
        "x-real-ip": forgedRealIp,
        "x-forwarded-for": `${forgedForwarded}, 10.0.0.1`,
      }
    )
  );

  assert.equal(res.status, 429);

  // The discriminating assertion: the request was counted against the address
  // Vercel supplied, not against either address the caller asserted.
  assert.equal(hits(real), 6, "the request must count against the platform-supplied client address");
  assert.equal(hits(forgedRealIp), 5, "a forged x-real-ip must not open a bucket of its own");
  assert.equal(hits(forgedForwarded), 5, "nor a forged x-forwarded-for");
});

test("THE MONEY PATH — the 6th scan in an hour from one trusted address returns 429", async () => {
  const ip = "203.0.113.150";
  seed(ip, 5);

  const res = await handler()(
    post({ brand: "Acme", url: "https://acme.io" }, { "x-vercel-forwarded-for": ip })
  );

  assert.equal(res.status, 429, "the sixth request in the window must be refused");
  assert.equal(res.headers.get("x-ratelimit-limit"), "5");
  assert.equal(res.headers.get("x-ratelimit-remaining"), "0");

  const retryAfter = Number(res.headers.get("retry-after"));
  assert.ok(retryAfter > 0 && retryAfter <= 3600, `retry-after must sit inside the window, got ${retryAfter}`);

  // ...and it was THIS address's sixth, not the shared bucket's. Without this
  // the refusal would also be satisfied by the safety seed above.
  assert.equal(hits(ip), 6, "the request must be counted against the platform-supplied address");
});

test("the limit still follows SCAN_RATE_LIMIT when the address is the trusted one", async () => {
  const previous = process.env.SCAN_RATE_LIMIT;
  process.env.SCAN_RATE_LIMIT = "2";
  try {
    const ip = "203.0.113.151";
    seed(ip, 2);
    const res = await handler()(post({ brand: "Acme" }, { "x-vercel-forwarded-for": ip }));
    assert.equal(res.status, 429);
    assert.equal(res.headers.get("x-ratelimit-limit"), "2", "the threshold must move with the env var");
    assert.equal(hits(ip), 3, "the third request from this address is the one that was refused");
  } finally {
    process.env.SCAN_RATE_LIMIT = previous;
  }
});

test("a request with no address at all is still counted, in a shared bucket", async () => {
  // Seeded over the limit so the refusal is guaranteed and nothing starts.
  seed("unidentified", 5);
  const res = await handler()(post({ brand: "Acme" }));
  assert.equal(res.status, 429, "no identifiable client must not mean no limit");
  assert.equal(hits("unidentified"), 6);
});
