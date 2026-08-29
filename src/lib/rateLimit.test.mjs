import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  checkScanRateLimit,
  clientBucketKey,
  evaluate,
  resolveRateLimit,
  windowStart,
  DEFAULTS,
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
