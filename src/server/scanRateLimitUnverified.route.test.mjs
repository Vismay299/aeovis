/**
 * R0.1.22 — POST /api/scan on a deployment that cannot verify a client address.
 *
 * The configuration under test is the DEFAULT one for anything that is not
 * Vercel: `VERCEL` unset, `SCAN_RATE_LIMIT_IP_HEADER` unset. In that state every
 * address the limiter can reach — `x-real-ip`, the leftmost `x-forwarded-for` —
 * is a string the caller typed. Before this suite existed the module warned
 * about exactly that ("the per-IP limit is bypassable by rotating that header")
 * and then applied the bypassable limit anyway: measured at the route, 40
 * requests with a rotating `x-real-ip` under SCAN_RATE_LIMIT=5 were never once
 * refused. Each one would have spent Bright Data + Perplexity + LLM budget.
 *
 * The fix is a second counter the request cannot address: a deployment-wide
 * ceiling keyed by a constant. This suite drives the REAL handler with a
 * rotating header and asserts the bucket that refuses it does not move.
 *
 * NO SCAN IS EVER STARTED.
 *   - the ceiling bucket is seeded to its limit before the rotation runs, so
 *     every request in that test is refused before createScanJob;
 *   - the shared no-address bucket is seeded far over, for the same reason the
 *     R0.1.4 spoof suite seeds it: a request whose identity the route fails to
 *     derive must not land in a fresh bucket and get allowed on the way to a
 *     failing assertion;
 *   - Supabase is unset, so the R0.1.21 store guard returns 503 before
 *     createScanJob even for a request the limiter allows;
 *   - and every test asserts global.memoryJobs did not grow.
 *
 * Harness: the same resolution-only hooks the other route suites use. Nothing
 * is stubbed; the handler body runs unmodified.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import crypto from "node:crypto";

const SCAN_URL = "https://aeovis.test/api/scan";
const WINDOW_MS = 3600000;
const LIMIT = 5;

// ---------------------------------------------------------------------------
// Environment, fixed BEFORE the route module is imported.
// ---------------------------------------------------------------------------
process.env.NODE_ENV = "production";
delete process.env.VERCEL;
delete process.env.VERCEL_URL;
delete process.env.SCAN_RATE_LIMIT_IP_HEADER;
delete process.env.SCAN_RATE_LIMIT_UNVERIFIED_CEILING;
delete process.env.NEXT_PUBLIC_SUPABASE_URL;
delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
process.env.SCAN_RATE_LIMIT = String(LIMIT);
process.env.SCAN_RATE_LIMIT_WINDOW_MS = String(WINDOW_MS);
process.env.SCAN_RATE_LIMIT_SALT = "r0122-unverified-salt";

register("./cronAuth.route.hooks.mjs", import.meta.url);

const {
  resolveVercelRuntime,
  resolveDeclaredIpHeader,
  resolveUnverifiedCeiling,
  unverifiedCeilingBucketKey,
  UNVERIFIED_CEILING_MULTIPLIER,
} = await import("./rateLimit.js");

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

const started = () => new Date(Math.floor(Date.now() / WINDOW_MS) * WINDOW_MS).toISOString();
const salt = () => process.env.SCAN_RATE_LIMIT_SALT || "";

/** The counter key rateLimit.js + analytics.js build for an address. */
function counterKey(ip) {
  const bucket = crypto.createHash("sha256").update(`${salt()}:${ip}`).digest("hex").slice(0, 32);
  return `${bucket}|${started()}`;
}

/** The counter key for the bucket no header can move. */
const ceilingKey = () => `${unverifiedCeilingBucketKey({ salt: salt() })}|${started()}`;

function put(key, hits) {
  global.memoryRateLimits = global.memoryRateLimits || new Map();
  global.memoryRateLimits.set(key, hits);
}

const at = (key) => global.memoryRateLimits.get(key);
const memoryJobCount = () => (global.memoryJobs instanceof Map ? global.memoryJobs.size : 0);

// The catch-all identity, over any configured limit before a single test runs.
put(counterKey("unidentified"), 10_000);

/**
 * The premise. Every assertion below is about the UNCONFIGURED deployment; if
 * this environment were on Vercel or had a declared trust header, the suite
 * would be testing a different code path and proving nothing about this one.
 */
test("PREMISE — this is the deployment with no verifiable client address", () => {
  assert.equal(resolveVercelRuntime(process.env).onVercel, false, "VERCEL leaked into this suite");
  assert.equal(
    resolveDeclaredIpHeader(process.env).header,
    null,
    "SCAN_RATE_LIMIT_IP_HEADER leaked into this suite; the configured path is not under test here"
  );
  assert.equal(resolveUnverifiedCeiling(process.env, LIMIT).limit, LIMIT * UNVERIFIED_CEILING_MULTIPLIER);
});

test("THE ROTATION — a rotating x-real-ip does not move the bucket that refuses it", async () => {
  const ceiling = LIMIT * UNVERIFIED_CEILING_MULTIPLIER;
  const forged = Array.from({ length: 8 }, (_, i) => `192.0.2.${100 + i}`);

  // Seeded AT the ceiling, so every request below is refused before
  // createScanJob no matter which identity the route derives.
  put(ceilingKey(), ceiling);
  for (const ip of forged) put(counterKey(ip), 0);
  const jobsBefore = memoryJobCount();

  const statuses = [];
  const details = [];
  for (const ip of forged) {
    const res = await handler()(post({ brand: "Acme", url: "https://acme.io" }, { "x-real-ip": ip }));
    statuses.push(res.status);
    details.push((await res.json()).detail);
  }

  assert.deepEqual(statuses, new Array(forged.length).fill(429), "every rotated request must be refused");

  // THE DISCRIMINATING ASSERTION. Each forged address opened a bucket of its
  // own and that bucket saw exactly ONE request — one of a limit of five. The
  // per-address limit therefore refused nothing here; the refusals came from a
  // bucket the caller has no way to address, and that bucket is where all eight
  // landed. Under the pre-fix module these same eight requests were allowed.
  for (const ip of forged) {
    assert.equal(at(counterKey(ip)), 1, `${ip}: rotation still opens a fresh per-address bucket`);
  }
  assert.equal(
    at(ceilingKey()),
    ceiling + forged.length,
    "every rotated request was counted against the one bucket no header moves"
  );

  // And the refusal does not tell a stranger their own address is over quota
  // when it is the deployment's shared allowance that ran out.
  for (const detail of details) {
    assert.match(detail, /too many/i);
    assert.doesNotMatch(detail, /from this address/i, "a shared refusal must not be reported as a personal one");
  }

  assert.equal(memoryJobCount(), jobsBefore, "a scan was started on the way to this assertion");
});

test("the refusal carries honest headers: the ceiling's own limit, and a Retry-After inside the window", async () => {
  const ceiling = LIMIT * UNVERIFIED_CEILING_MULTIPLIER;
  put(ceilingKey(), ceiling);
  const jobsBefore = memoryJobCount();

  const res = await handler()(post({ brand: "Acme" }, { "x-real-ip": "192.0.2.200" }));
  assert.equal(res.status, 429);
  assert.equal(
    res.headers.get("x-ratelimit-limit"),
    String(ceiling),
    "the reported limit must be the one that actually refused, not the per-address one"
  );
  assert.equal(res.headers.get("x-ratelimit-remaining"), "0");
  const retryAfter = Number(res.headers.get("retry-after"));
  assert.ok(retryAfter > 0 && retryAfter <= WINDOW_MS / 1000, `retry-after must sit inside the window, got ${retryAfter}`);
  assert.equal(memoryJobCount(), jobsBefore);
});

test("the refusal names no vendor and leaks no configuration", async () => {
  put(ceilingKey(), LIMIT * UNVERIFIED_CEILING_MULTIPLIER);
  const res = await handler()(post({ brand: "Acme" }, { "x-real-ip": "192.0.2.201" }));
  const body = JSON.stringify(await res.json());
  assert.ok(
    !/bright ?data|serpapi|perplexity|openrouter|supabase|postgres/i.test(body),
    `an anonymous refusal must not name infrastructure: ${body}`
  );
  // The operator-facing sentence — which header to declare — belongs in the
  // server log, not in a body a stranger reads.
  assert.ok(
    !/SCAN_RATE_LIMIT|x-real-ip|x-forwarded-for|ceiling/i.test(body),
    `the refusal must not describe this deployment's trust configuration: ${body}`
  );
});

test("CONTROL — the ceiling is finite, not a blanket refusal: an unexhausted deployment still serves", async () => {
  // A fresh salt is a fresh set of buckets, so nothing this suite already
  // counted can make this control pass by accident.
  const previous = process.env.SCAN_RATE_LIMIT_SALT;
  process.env.SCAN_RATE_LIMIT_SALT = "r0122-control-salt";
  try {
    put(counterKey("unidentified"), 10_000);
    const jobsBefore = memoryJobCount();

    // Under the ceiling, these are ALLOWED by the limiter — and then refused by
    // the R0.1.21 store guard, which is what makes them safe to send here: no
    // job is created and no vendor call is made.
    for (let i = 0; i < 3; i++) {
      const res = await handler()(post({ brand: "Acme" }, { "x-real-ip": `198.51.100.${i}` }));
      assert.notEqual(res.status, 429, "a deployment inside its ceiling must not refuse everybody");
      assert.equal(res.status, 503, "and with no store configured the R0.1.21 guard is what answers");
    }
    assert.equal(at(ceilingKey()), 3, "the ceiling counts what the deployment was asked to spend");
    assert.equal(memoryJobCount(), jobsBefore, "no job may be created by a 503");
  } finally {
    process.env.SCAN_RATE_LIMIT_SALT = previous;
  }
});

test("CONTROL — one honest caller is still refused on its own address, and told so", async () => {
  // The per-address bucket is kept as a courtesy and still binds first when a
  // single caller is the one over quota. That refusal IS about them, so it
  // keeps the sentence that says so.
  const previous = process.env.SCAN_RATE_LIMIT_SALT;
  process.env.SCAN_RATE_LIMIT_SALT = "r0122-honest-salt";
  try {
    put(counterKey("unidentified"), 10_000);
    const ip = "203.0.113.77";
    put(counterKey(ip), LIMIT);
    const jobsBefore = memoryJobCount();

    const res = await handler()(post({ brand: "Acme" }, { "x-real-ip": ip }));
    assert.equal(res.status, 429);
    assert.equal(res.headers.get("x-ratelimit-limit"), String(LIMIT), "this refusal is the per-address one");
    const body = await res.json();
    assert.match(body.detail, /from this address/i, "and it is honestly reported as personal");
    assert.equal(at(counterKey(ip)), LIMIT + 1);
    assert.equal(memoryJobCount(), jobsBefore);
  } finally {
    process.env.SCAN_RATE_LIMIT_SALT = previous;
  }
});
