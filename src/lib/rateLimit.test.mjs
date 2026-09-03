import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  checkScanRateLimit,
  clientBucketKey,
  evaluate,
  resolveClientIp,
  resetUntrustedSourceWarning,
  resolveRateLimit,
  windowStart,
  DEFAULTS,
  TRUSTED_IP_HEADER,
} from "./rateLimit.js";

const HOUR = 60 * 60 * 1000;
const T0 = Date.parse("2026-08-29T12:00:00.000Z");
const headers = (h = {}) => (name) => h[String(name).toLowerCase()] ?? null;
const silent = { warn: () => {} };

/** In-memory stand-in for migration 009's atomic increment. */
function counter() {
  const store = new Map();
  const fn = async ({ bucketKey, windowStart }) => {
    const key = `${bucketKey}|${windowStart}`;
    const next = (store.get(key) || 0) + 1;
    store.set(key, next);
    return next;
  };
  fn.store = store;
  return fn;
}

test("ACCEPT CRITERION — the 6th scan in an hour from one IP is refused", async () => {
  const increment = counter();
  const header = headers({ "x-real-ip": "203.0.113.9" });
  const verdicts = [];
  for (let i = 0; i < 6; i++) {
    verdicts.push(await checkScanRateLimit({ header, increment, env: {}, now: T0 + i * 1000, logger: silent }));
  }
  assert.deepEqual(
    verdicts.map((v) => v.allowed),
    [true, true, true, true, true, false],
    "five allowed, the sixth refused"
  );
  assert.equal(verdicts[4].remaining, 0);
  assert.equal(verdicts[5].limit, DEFAULTS.limit);
  assert.ok(verdicts[5].retryAfterSec > 0, "a refusal must say when to come back");
});

test("ACCEPT CRITERION — the limit is configurable by env", async () => {
  const increment = counter();
  const header = headers({ "x-real-ip": "203.0.113.9" });
  const env = { SCAN_RATE_LIMIT: "2" };
  const v = [];
  for (let i = 0; i < 3; i++) {
    v.push(await checkScanRateLimit({ header, increment, env, now: T0, logger: silent }));
  }
  assert.deepEqual(v.map((x) => x.allowed), [true, true, false]);
  assert.equal(v[2].limit, 2);
});

test("resolveRateLimit - garbage env values fall back to the defaults, never to 0", () => {
  // A limit of 0 would refuse every scan; a negative window would divide by a
  // negative. Both are worse than the default.
  for (const bad of [{}, { SCAN_RATE_LIMIT: "abc" }, { SCAN_RATE_LIMIT: "0" }, { SCAN_RATE_LIMIT: "-3" }]) {
    assert.equal(resolveRateLimit(bad).limit, DEFAULTS.limit, JSON.stringify(bad));
  }
  assert.equal(resolveRateLimit({ SCAN_RATE_LIMIT_WINDOW_MS: "0" }).windowMs, DEFAULTS.windowMs);
  assert.equal(resolveRateLimit({ SCAN_RATE_LIMIT: "12" }).limit, 12);
});

test("a different IP gets its own budget", async () => {
  const increment = counter();
  const env = { SCAN_RATE_LIMIT: "1" };
  const a = await checkScanRateLimit({ header: headers({ "x-real-ip": "1.1.1.1" }), increment, env, now: T0, logger: silent });
  const b = await checkScanRateLimit({ header: headers({ "x-real-ip": "2.2.2.2" }), increment, env, now: T0, logger: silent });
  assert.equal(a.allowed, true);
  assert.equal(b.allowed, true, "a second client must not inherit the first's count");
  assert.notEqual(a.bucketKey, b.bucketKey);
});

test("the window rolls: a refused client is allowed again in the next window", async () => {
  const increment = counter();
  const header = headers({ "x-real-ip": "203.0.113.9" });
  const env = { SCAN_RATE_LIMIT: "1" };
  assert.equal((await checkScanRateLimit({ header, increment, env, now: T0, logger: silent })).allowed, true);
  assert.equal((await checkScanRateLimit({ header, increment, env, now: T0 + 60_000, logger: silent })).allowed, false);
  assert.equal(
    (await checkScanRateLimit({ header, increment, env, now: T0 + HOUR, logger: silent })).allowed,
    true,
    "the next fixed window is a fresh budget"
  );
});

test("clientBucketKey - the raw IP is never the key, and never appears in it", () => {
  const key = clientBucketKey({ header: headers({ "x-real-ip": "203.0.113.9" }), salt: "s" });
  assert.doesNotMatch(key, /203\.0\.113\.9/);
  assert.match(key, /^[0-9a-f]{32}$/);
});

test("clientBucketKey - x-real-ip wins, then the LEFTMOST x-forwarded-for entry", () => {
  const salt = "s";
  const viaReal = clientBucketKey({ header: headers({ "x-real-ip": "9.9.9.9", "x-forwarded-for": "1.1.1.1" }), salt });
  const expected = clientBucketKey({ header: headers({ "x-real-ip": "9.9.9.9" }), salt });
  assert.equal(viaReal, expected);

  const viaFwd = clientBucketKey({ header: headers({ "x-forwarded-for": "5.5.5.5, 10.0.0.1, 10.0.0.2" }), salt });
  assert.equal(viaFwd, clientBucketKey({ header: headers({ "x-real-ip": "5.5.5.5" }), salt }));
});

test("clientBucketKey - an unidentifiable client is throttled in a shared bucket, not waved through", async () => {
  const increment = counter();
  const env = { SCAN_RATE_LIMIT: "1" };
  const header = headers({});
  assert.equal((await checkScanRateLimit({ header, increment, env, now: T0, logger: silent })).allowed, true);
  assert.equal(
    (await checkScanRateLimit({ header, increment, env, now: T0, logger: silent })).allowed,
    false,
    "no bucket at all would mean no limit at all"
  );
});

// ---------------------------------------------------------------------------
// R0.1.4 — "per IP" has to mean an IP, not a header the caller writes.
//
// Reproduced before the trust ordering existed, driving this module with the
// real in-memory counter: 25 requests carrying a ROTATING x-real-ip were
// allowed 25 times under SCAN_RATE_LIMIT=5, and so were 25 with a rotating
// x-forwarded-for. The counter was never wrong; the identity was.
// ---------------------------------------------------------------------------

test("THE BYPASS — rotating a client-settable header no longer buys fresh buckets", async () => {
  const increment = counter();
  const env = { SCAN_RATE_LIMIT: "5", VERCEL: "1", SCAN_RATE_LIMIT_SALT: "s" };
  let allowed = 0;
  for (let i = 0; i < 25; i++) {
    const verdict = await checkScanRateLimit({
      // One real client per Vercel; twenty-five different stories from the caller.
      header: headers({ [TRUSTED_IP_HEADER]: "203.0.113.9", "x-real-ip": `192.0.2.${i + 20}` }),
      increment,
      env,
      now: T0,
      logger: silent,
    });
    if (verdict.allowed) allowed++;
  }
  assert.equal(allowed, 5, "the spoofer must get the same five scans as an honest caller, not 25");
});

test("resolveClientIp - the platform header is trusted ONLY when running on Vercel", () => {
  const header = headers({ [TRUSTED_IP_HEADER]: "203.0.113.9" });

  const onVercel = resolveClientIp({ header, env: { VERCEL: "1" } });
  assert.equal(onVercel.ip, "203.0.113.9");
  assert.equal(onVercel.source, TRUSTED_IP_HEADER);
  assert.equal(onVercel.trusted, true);

  // Off Vercel nothing strips inbound x-vercel-*, so the same header is just
  // another claim — and is ignored rather than quietly promoted.
  const offVercel = resolveClientIp({ header, env: {} });
  assert.equal(offVercel.ip, null, "an unenforced x-vercel-* header must not become an identity");
  assert.equal(offVercel.trusted, false);
});

test("resolveClientIp - the trusted header outranks both headers a caller can set", () => {
  const out = resolveClientIp({
    header: headers({
      [TRUSTED_IP_HEADER]: "203.0.113.9",
      "x-real-ip": "192.0.2.1",
      "x-forwarded-for": "198.51.100.1, 10.0.0.1",
    }),
    env: { VERCEL: "1" },
  });
  assert.equal(out.ip, "203.0.113.9");
});

test("resolveClientIp - an operator can declare the header their own proxy overwrites", () => {
  const out = resolveClientIp({
    header: headers({ "cf-connecting-ip": "203.0.113.9", "x-real-ip": "192.0.2.1" }),
    env: { SCAN_RATE_LIMIT_IP_HEADER: "CF-Connecting-IP" },
  });
  assert.equal(out.ip, "203.0.113.9");
  assert.equal(out.source, "cf-connecting-ip");
  assert.equal(out.trusted, true);
});

test("resolveClientIp - the conventional fallbacks still work, and admit they are guesses", () => {
  const viaReal = resolveClientIp({ header: headers({ "x-real-ip": "203.0.113.9" }), env: {} });
  assert.equal(viaReal.ip, "203.0.113.9");
  assert.equal(viaReal.trusted, false, "x-real-ip is whatever the caller typed");

  const viaFwd = resolveClientIp({ header: headers({ "x-forwarded-for": "5.5.5.5, 10.0.0.1" }), env: {} });
  assert.equal(viaFwd.ip, "5.5.5.5", "the leftmost entry, by convention");
  assert.equal(viaFwd.trusted, false);

  const none = resolveClientIp({ header: headers({}), env: {} });
  assert.equal(none.source, "none");
  assert.equal(none.trusted, false);
});

test("an untrusted address source is announced, not assumed away", async () => {
  resetUntrustedSourceWarning();
  let warned = "";
  const out = await checkScanRateLimit({
    header: headers({ "x-real-ip": "203.0.113.9" }),
    increment: counter(),
    env: {},
    now: T0,
    logger: { warn: (m) => (warned = m) },
  });
  assert.equal(out.trusted, false, "the envelope must carry how much the address is worth");
  assert.equal(out.source, "x-real-ip");
  assert.match(warned, /bypassable by rotating/, "a limit that a header defeats must say so");

  // Once per process: a per-request warning is a log nobody reads.
  let second = "";
  await checkScanRateLimit({
    header: headers({ "x-real-ip": "203.0.113.9" }),
    increment: counter(),
    env: {},
    now: T0,
    logger: { warn: (m) => (second = m) },
  });
  assert.equal(second, "");
});

test("a trusted address source warns about nothing and says so in the envelope", async () => {
  resetUntrustedSourceWarning();
  let warned = "";
  const out = await checkScanRateLimit({
    header: headers({ [TRUSTED_IP_HEADER]: "203.0.113.9" }),
    increment: counter(),
    env: { VERCEL: "1" },
    now: T0,
    logger: { warn: (m) => (warned = m) },
  });
  assert.equal(out.trusted, true);
  assert.equal(out.source, TRUSTED_IP_HEADER);
  assert.equal(warned, "");
});

test("a salt change separates buckets across deployments", () => {
  const h = headers({ "x-real-ip": "203.0.113.9" });
  assert.notEqual(clientBucketKey({ header: h, salt: "a" }), clientBucketKey({ header: h, salt: "b" }));
});

test("windowStart - buckets align to the window, not to the request time", () => {
  assert.equal(windowStart(Date.parse("2026-08-29T12:37:41.000Z"), HOUR), "2026-08-29T12:00:00.000Z");
  assert.equal(windowStart(Date.parse("2026-08-29T12:00:00.000Z"), HOUR), "2026-08-29T12:00:00.000Z");
});

test("evaluate - retryAfter counts down to the window edge and is never 0", () => {
  const startedAt = T0;
  const near = evaluate({ hits: 9, limit: 5, windowMs: HOUR, nowMs: startedAt + HOUR - 10, windowStartMs: startedAt });
  assert.equal(near.allowed, false);
  assert.ok(near.retryAfterSec >= 1, "a Retry-After of 0 tells a client to retry immediately");
});

test("a broken counter FAILS OPEN but says so — it never silently allows", async () => {
  let warned = "";
  const out = await checkScanRateLimit({
    header: headers({ "x-real-ip": "1.1.1.1" }),
    increment: async () => {
      throw new Error("supabase unreachable");
    },
    env: {},
    now: T0,
    logger: { warn: (m) => (warned = m) },
  });
  assert.equal(out.allowed, true, "a broken limiter must not take the product down");
  assert.equal(out.degraded, true, "...but the degrade must be visible, not silent");
  assert.equal(out.remaining, null, "never report a fabricated remaining count");
  assert.match(warned, /counter unavailable/);
  assert.match(warned, /one-running-scan-per-brand/, "the log must name what still bounds the damage");
});

test("a counter returning nonsense is treated as broken, not as a count", async () => {
  const out = await checkScanRateLimit({
    header: headers({ "x-real-ip": "1.1.1.1" }),
    increment: async () => null,
    env: {},
    now: T0,
    logger: silent,
  });
  assert.equal(out.degraded, true);
  assert.equal(out.allowed, true);
});

test("GUARD — POST /api/scan counts the request and returns 429 with Retry-After", async () => {
  const src = await readFile(new URL("../app/api/scan/route.js", import.meta.url), "utf8");
  assert.match(src, /checkScanRateLimit/, "the route must use the tested limiter");
  assert.match(src, /status: 429/);
  assert.match(src, /"Retry-After"/);
  const rate = src.indexOf("checkScanRateLimit");
  const duplicate = src.indexOf("hasActiveScanForBrand(brand)");
  assert.ok(
    rate !== -1 && duplicate !== -1 && rate < duplicate,
    "count before the duplicate check, or a caller can probe an already-scanning brand for free"
  );
});

test("GUARD — migration 009 increments atomically in one statement", async () => {
  const sql = await readFile(new URL("../../supabase/migrations/009_scan_rate_limit.sql", import.meta.url), "utf8");
  assert.match(sql, /CREATE TABLE IF NOT EXISTS scan_rate_limits/);
  assert.match(sql, /PRIMARY KEY \(bucket_key, window_start\)/);
  assert.match(
    sql,
    /ON CONFLICT \(bucket_key, window_start\)[\s\S]*RETURNING hits/,
    "read-then-write would reintroduce the TOCTOU migration 007 just closed"
  );
});
