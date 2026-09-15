/**
 * R0.1.24 — POST /api/scan on the deployment that actually ships: Vercel, where
 * the client address comes from `x-vercel-forwarded-for`.
 *
 * R0.1.22 put a deployment-wide ceiling on every address a caller can type and
 * EXEMPTED two bases it could not: the platform header here, and an
 * operator-declared one. Measured at the module before this suite existed, with
 * `VERCEL=1` and `SCAN_RATE_LIMIT=5`: 60 requests rotating
 * `x-vercel-forwarded-for` were allowed 60/60, every one of them reporting
 * `ceiling.state = "not-applicable"`. Vercel is DOCUMENTED to strip an inbound
 * copy of that header and nobody has forged it against the deployed origin to
 * confirm (RESTORE-TRUST-R0.1.20), so "unforgeable" was an assumption, and an
 * assumption is not a ceiling.
 *
 * The caller in that measurement holds NO credential: the first test below
 * asserts POST /api/scan is public in the operator perimeter, which is what makes
 * this an anonymous spend path rather than an operator one. Each allowed request
 * reaches `createScanJob` and then `runScanChunk`, which spends scrape + probe +
 * LLM budget.
 *
 * This suite drives the REAL handler with a rotating platform header and asserts
 * the refusal comes from a bucket the request cannot address — and that it comes
 * BEFORE the money: the limiter is checked at the top of POST, and `createScanJob`
 * / `runScanChunk` are 50 lines further down behind the 429 return.
 *
 * NO SCAN IS EVER STARTED.
 *   - the attested ceiling bucket is seeded to its limit before the rotation, so
 *     every request in that test is refused before createScanJob;
 *   - the shared no-address bucket is seeded far over, so a request whose
 *     identity the route fails to derive cannot land in a fresh bucket and be
 *     allowed on the way to a failing assertion;
 *   - Supabase is unset, so the R0.1.21 store guard answers 503 before
 *     createScanJob even for a request the limiter allows;
 *   - and every test asserts global.memoryJobs did not grow.
 *
 * Harness: the same resolution-only hooks the other route suites use. Nothing is
 * stubbed; the handler body runs unmodified.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import crypto from "node:crypto";

const SCAN_URL = "https://aeovis.test/api/scan";
const WINDOW_MS = 3600000;
const LIMIT = 5;
const CEILING = 20;

// ---------------------------------------------------------------------------
// Environment, fixed BEFORE the route module is imported.
// ---------------------------------------------------------------------------
process.env.NODE_ENV = "production";
process.env.VERCEL = "1";
delete process.env.SCAN_RATE_LIMIT_IP_HEADER;
delete process.env.SCAN_RATE_LIMIT_UNVERIFIED_CEILING;
delete process.env.NEXT_PUBLIC_SUPABASE_URL;
delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
process.env.SCAN_RATE_LIMIT = String(LIMIT);
process.env.SCAN_RATE_LIMIT_WINDOW_MS = String(WINDOW_MS);
process.env.SCAN_RATE_LIMIT_SALT = "r0124-attested-salt";
process.env.SCAN_RATE_LIMIT_ATTESTED_CEILING = String(CEILING);

register("./cronAuth.route.hooks.mjs", import.meta.url);

const {
  PLATFORM_IP_HEADER,
  resolveVercelRuntime,
  resolveClientIp,
  attestedCeilingBucketKey,
  ceilingTierFor,
  resolveCeiling,
  CEILING_TIER,
  TRUST_BASIS,
} = await import("./rateLimit.js");
const { isPublicRoute } = await import("./operatorPerimeter.js");

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

/** The counter key for the bucket no header can move on this tier. */
const ceilingKey = () => `${attestedCeilingBucketKey({ salt: salt() })}|${started()}`;

function put(key, hits) {
  global.memoryRateLimits = global.memoryRateLimits || new Map();
  global.memoryRateLimits.set(key, hits);
}

const at = (key) => global.memoryRateLimits.get(key);
const memoryJobCount = () => (global.memoryJobs instanceof Map ? global.memoryJobs.size : 0);

// The catch-all identity, over any configured limit before a single test runs.
put(counterKey("unidentified"), 10_000);

/**
 * The premise, in three parts. Every assertion below is about an ANONYMOUS
 * caller on Vercel whose address came from the platform header; if any of these
 * were false the suite would be exercising a different path and proving nothing
 * about this one.
 */
test("PREMISE — an unauthenticated caller reaches this route, and the platform header is its identity", () => {
  assert.equal(
    isPublicRoute("POST", "/api/scan"),
    true,
    "if this route ever stops being public, the spend path is no longer anonymous and this suite is " +
      "measuring the wrong threat"
  );
  assert.equal(resolveVercelRuntime(process.env).onVercel, true, "VERCEL did not reach this suite");
  const identity = resolveClientIp({
    header: (name) => ({ [PLATFORM_IP_HEADER]: "203.0.113.7" })[String(name).toLowerCase()] ?? null,
    env: process.env,
  });
  assert.equal(identity.trustBasis, TRUST_BASIS.PLATFORM_UNPROVEN);
  assert.equal(identity.trusted, false, "R0.1.20: the platform header is read, not vouched for");
  assert.equal(ceilingTierFor(identity), CEILING_TIER.ATTESTED);
  assert.equal(resolveCeiling(process.env, LIMIT, CEILING_TIER.ATTESTED).limit, CEILING);
});

test("THE ROTATION — a rotating platform header does not move the bucket that refuses it", async () => {
  const forged = Array.from({ length: 8 }, (_, i) => `192.0.2.${100 + i}`);

  // Seeded AT the ceiling, so every request below is refused before
  // createScanJob no matter which identity the route derives.
  put(ceilingKey(), CEILING);
  for (const ip of forged) put(counterKey(ip), 0);
  const jobsBefore = memoryJobCount();

  const statuses = [];
  const details = [];
  for (const ip of forged) {
    const res = await handler()(
      post({ brand: "Acme", url: "https://acme.io" }, { [PLATFORM_IP_HEADER]: ip })
    );
    statuses.push(res.status);
    details.push((await res.json()).detail);
  }

  assert.deepEqual(statuses, new Array(forged.length).fill(429), "every rotated request must be refused");

  // THE DISCRIMINATING ASSERTION. Each forged address opened a bucket of its own
  // that saw exactly ONE request, one of a limit of five, so the per-address
  // limit refused nothing here. All eight refusals came from a bucket the caller
  // has no way to address. Under the pre-R0.1.24 module these same eight
  // requests were allowed and eight scans would have started.
  for (const ip of forged) {
    assert.equal(at(counterKey(ip)), 1, `${ip}: rotation still opens a fresh per-address bucket`);
  }
  assert.equal(
    at(ceilingKey()),
    CEILING + forged.length,
    "every rotated request was counted against the one bucket no header moves"
  );

  // The refusal does not tell a stranger their own address is over quota when it
  // is the deployment's shared allowance that ran out.
  for (const detail of details) {
    assert.match(detail, /too many/i);
    assert.doesNotMatch(detail, /from this address/i, "a shared refusal must not be reported as a personal one");
  }

  assert.equal(memoryJobCount(), jobsBefore, "a scan was started on the way to this assertion");
});

test("the refusal carries the ceiling's own limit and a Retry-After inside the window", async () => {
  put(ceilingKey(), CEILING);
  const jobsBefore = memoryJobCount();

  const res = await handler()(post({ brand: "Acme" }, { [PLATFORM_IP_HEADER]: "192.0.2.200" }));
  assert.equal(res.status, 429);
  assert.equal(
    res.headers.get("x-ratelimit-limit"),
    String(CEILING),
    "the reported limit must be the one that actually refused, not the per-address one"
  );
  assert.equal(res.headers.get("x-ratelimit-remaining"), "0");
  const retryAfter = Number(res.headers.get("retry-after"));
  assert.ok(retryAfter > 0 && retryAfter <= WINDOW_MS / 1000, `retry-after must sit inside the window, got ${retryAfter}`);
  assert.equal(memoryJobCount(), jobsBefore);
});

test("the refusal names no vendor and leaks no configuration", async () => {
  put(ceilingKey(), CEILING);
  const res = await handler()(post({ brand: "Acme" }, { [PLATFORM_IP_HEADER]: "192.0.2.201" }));
  const body = JSON.stringify(await res.json());
  assert.ok(
    !/bright ?data|serpapi|perplexity|openrouter|supabase|postgres|vercel/i.test(body),
    `an anonymous refusal must not name infrastructure: ${body}`
  );
  assert.ok(
    !/SCAN_RATE_LIMIT|x-vercel|ceiling/i.test(body),
    `the refusal must not describe this deployment's trust configuration: ${body}`
  );
});

test("CONTROL — the ceiling is finite, not a blanket refusal: an unexhausted deployment still serves", async () => {
  // A fresh salt is a fresh set of buckets, so nothing this suite already
  // counted can make this control pass by accident.
  const previous = process.env.SCAN_RATE_LIMIT_SALT;
  process.env.SCAN_RATE_LIMIT_SALT = "r0124-control-salt";
  try {
    put(counterKey("unidentified"), 10_000);
    const jobsBefore = memoryJobCount();

    // Under the ceiling, these are ALLOWED by the limiter — and then refused by
    // the R0.1.21 store guard, which is what makes them safe to send here: no
    // job is created and no vendor call is made.
    for (let i = 0; i < 3; i++) {
      const res = await handler()(post({ brand: "Acme" }, { [PLATFORM_IP_HEADER]: `198.51.100.${i}` }));
      assert.notEqual(res.status, 429, "a deployment inside its ceiling must not refuse everybody");
      assert.equal(res.status, 503, "and with no store configured the R0.1.21 guard is what answers");
    }
    assert.equal(at(ceilingKey()), 3, "the ceiling counts what the deployment was asked to spend");
    assert.equal(memoryJobCount(), jobsBefore, "no job may be created by a 503");
  } finally {
    process.env.SCAN_RATE_LIMIT_SALT = previous;
  }
});

test("CONTROL — one honest platform-supplied caller is still refused on its own address, and told so", async () => {
  // The per-address bucket is kept and still binds first when a single caller is
  // the one over quota. That refusal IS about them, so it keeps the sentence
  // that says so — the attested ceiling must not have turned every refusal into
  // the anonymous one.
  const previous = process.env.SCAN_RATE_LIMIT_SALT;
  process.env.SCAN_RATE_LIMIT_SALT = "r0124-honest-salt";
  try {
    put(counterKey("unidentified"), 10_000);
    const ip = "203.0.113.77";
    put(counterKey(ip), LIMIT);
    const jobsBefore = memoryJobCount();

    const res = await handler()(post({ brand: "Acme" }, { [PLATFORM_IP_HEADER]: ip }));
    assert.equal(res.status, 429);
    assert.equal(res.headers.get("x-ratelimit-limit"), String(LIMIT), "this refusal is the per-address one");
    const body = await res.json();
    assert.match(body.detail, /from this address/i, "and it is honestly reported as personal");
    assert.equal(at(counterKey(ip)), LIMIT + 1);
    assert.equal(
      at(ceilingKey()),
      undefined,
      "a request its own bucket refused must not spend the shared allowance"
    );
    assert.equal(memoryJobCount(), jobsBefore);
  } finally {
    process.env.SCAN_RATE_LIMIT_SALT = previous;
  }
});

test("GUARD — the limiter runs BEFORE the two lines that spend money", async () => {
  // The neighbouring failure mode for a ceiling: enforced after the spend. This
  // is a source-order check on the real handler, and it is the only assertion in
  // this file that can see the ordering, because every test above is refused and
  // therefore never reaches either call.
  const { readFile } = await import("node:fs/promises");
  const src = await readFile(new URL("../app/api/scan/route.js", import.meta.url), "utf8");
  const limiter = src.indexOf("checkScanRateLimit");
  const refusal = src.indexOf("status: 429");
  const createJob = src.indexOf("createScanJob({");
  const worker = src.indexOf("runScanChunk(job.id)");
  assert.ok(limiter !== -1 && refusal !== -1 && createJob !== -1 && worker !== -1, "the handler changed shape");
  assert.ok(limiter < refusal, "the refusal must be decided by the limiter, not after it");
  assert.ok(
    refusal < createJob && createJob < worker,
    "a ceiling enforced after createScanJob or runScanChunk would bound nothing: the money is already spent"
  );
});
