import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  checkScanRateLimit,
  clientBucketKey,
  evaluate,
  normaliseAddress,
  resolveClientIp,
  resetUntrustedSourceWarning,
  resolveDeclaredIpHeader,
  resolveRateLimit,
  resolveVercelRuntime,
  untrustedSourceWarning,
  windowStart,
  DEFAULTS,
  REFUSED_IP_HEADERS,
  PLATFORM_IP_HEADER,
  TRUST_BASIS,
  TRUST_RESTORE_CHECK,
  BUCKET_SCOPE,
  CEILING_STATE,
  UNVERIFIED_CEILING_DECISION,
  UNVERIFIED_CEILING_MULTIPLIER,
  UNVERIFIED_CEILING_SUBJECT,
  resolveUnverifiedCeiling,
  unverifiedCeilingBucketKey,
  ATTESTED_CEILING_DECISION,
  ATTESTED_CEILING_MULTIPLIER,
  ATTESTED_CEILING_SUBJECT,
  CEILING_TIER,
  attestedCeilingBucketKey,
  ceilingBucketKey,
  ceilingTierFor,
  resolveCeiling,
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

// A test that reads its expectation back out of the module under test cannot
// fail. Every constant this file leans on is therefore pinned to a literal
// once, here, and used symbolically everywhere else. Both of these were
// measured to survive mutation before this test existed: retargeting
// PLATFORM_IP_HEADER to "x-acme-ip" left the suite 28/28 green even though the
// module would then be reading its identity out of a header nobody vetted, and
// cutting DEFAULTS.windowMs to five minutes left it green too, under a test
// whose own name promises "in an hour".
test("GUARD — the constants this suite asserts against are pinned, not read back", () => {
  assert.equal(PLATFORM_IP_HEADER, "x-vercel-forwarded-for");
  assert.deepEqual({ ...DEFAULTS }, { limit: 5, windowMs: HOUR });
  // R0.1.22: the ceiling arithmetic below is written against these two literals.
  // Measured: with the multiplier read back out of the module instead, cutting
  // it to 1 left the ceiling suite green while the deployment's whole allowance
  // silently became five scans an hour.
  assert.equal(UNVERIFIED_CEILING_MULTIPLIER, 5);
  assert.equal(UNVERIFIED_CEILING_SUBJECT, "R0.1.22-DEPLOYMENT-UNVERIFIED-TOTAL");
  // R0.1.24, pinned for the same reason: with the multiplier read back out of
  // the module, raising it to 1e9 would leave the attested-ceiling suite green
  // while the bound it asserts became indistinguishable from no bound at all.
  assert.equal(ATTESTED_CEILING_MULTIPLIER, 40);
  assert.equal(ATTESTED_CEILING_SUBJECT, "R0.1.24-DEPLOYMENT-ATTESTED-TOTAL");
  assert.deepEqual({ ...CEILING_TIER }, { UNVERIFIED: "unverified", ATTESTED: "attested" });
});

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
      header: headers({ [PLATFORM_IP_HEADER]: "203.0.113.9", "x-real-ip": `192.0.2.${i + 20}` }),
      increment,
      env,
      now: T0,
      logger: silent,
    });
    if (verdict.allowed) allowed++;
  }
  assert.equal(allowed, 5, "the spoofer must get the same five scans as an honest caller, not 25");
});

test("resolveClientIp - the platform header is READ only when running on Vercel", () => {
  const header = headers({ [PLATFORM_IP_HEADER]: "203.0.113.9" });

  const onVercel = resolveClientIp({ header, env: { VERCEL: "1" } });
  assert.equal(onVercel.ip, "203.0.113.9");
  assert.equal(onVercel.source, PLATFORM_IP_HEADER);
  // R0.1.20: read, and still the highest-precedence source, but NOT vouched for.
  assert.equal(onVercel.trusted, false);
  assert.equal(onVercel.trustBasis, TRUST_BASIS.PLATFORM_UNPROVEN);

  // Off Vercel nothing strips inbound x-vercel-*, so the same header is just
  // another claim — and is ignored rather than quietly promoted.
  const offVercel = resolveClientIp({ header, env: {} });
  assert.equal(offVercel.ip, null, "an unenforced x-vercel-* header must not become an identity");
  assert.equal(offVercel.trusted, false);
  assert.equal(offVercel.trustBasis, TRUST_BASIS.ABSENT, "off Vercel it is not an address at all");
});

test("resolveClientIp - the platform header outranks both headers a caller can set", () => {
  const out = resolveClientIp({
    header: headers({
      [PLATFORM_IP_HEADER]: "203.0.113.9",
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
  assert.equal(out.trusted, true, "an out-of-band human assertion is the one thing still vouched for");
  assert.equal(out.trustBasis, TRUST_BASIS.DECLARED);
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
  // The DECLARED header is now the only trusted source (R0.1.20), so it is the
  // only one that may pass in silence.
  resetUntrustedSourceWarning();
  let warned = "";
  const out = await checkScanRateLimit({
    header: headers({ "cf-connecting-ip": "203.0.113.9" }),
    increment: counter(),
    env: { SCAN_RATE_LIMIT_IP_HEADER: "cf-connecting-ip" },
    now: T0,
    logger: { warn: (m) => (warned = m) },
  });
  assert.equal(out.trusted, true);
  assert.equal(out.trustBasis, TRUST_BASIS.DECLARED);
  assert.equal(out.source, "cf-connecting-ip");
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

// ---------------------------------------------------------------------------
// R0.1.18 — the trust knob's own footguns.
//
// All three reproduced against the pre-fix module, driving it directly:
//   SCAN_RATE_LIMIT_IP_HEADER=x-real-ip -> {trusted:true}, and the warn-once
//     never fired: a bad declaration was QUIETER than no declaration.
//   VERCEL=0                            -> {trusted:true} on a header that,
//     off Vercel, nothing strips.
//   .env.example                        -> no mention of the knob at all.
// ---------------------------------------------------------------------------

test("BAD DECLARATION — a forgeable header name is refused and never buys trust", () => {
  // The SET is pinned LITERALLY before anything iterates it. The loop below
  // derives its cases from the module under test, so on its own it can only
  // check the names that are still there: measured, deleting `host` from
  // REFUSED_IP_HEADERS left the suite 28/28 green while resolveClientIp went
  // back to {ip:"evil.example", source:"host", trusted:true, configWarning:null}
  // — the original footgun, restored in silence. Five of the six entries could
  // be deleted that way. This assertion fails on the deletion; the loop still
  // fails on a behaviour change. Adding a name is a deliberate edit here too.
  assert.deepEqual(Object.keys(REFUSED_IP_HEADERS).sort(), [
    "forwarded",
    "host",
    "x-forwarded-for",
    "x-forwarded-host",
    "x-real-ip",
    "x-vercel-forwarded-for",
  ]);

  // The declaration cannot change WHICH value is read here — only the label.
  for (const name of Object.keys(REFUSED_IP_HEADERS)) {
    const out = resolveClientIp({
      header: headers({ [name]: "192.0.2.7", "x-real-ip": "192.0.2.7" }),
      env: { SCAN_RATE_LIMIT_IP_HEADER: name },
    });
    assert.equal(out.trusted, false, `${name} must not be promoted to a trusted source`);
    assert.ok(
      ["x-real-ip", "x-forwarded-for", "none"].includes(out.source),
      `${name} must fall through to an untrusted fallback, got source=${out.source}`
    );
    assert.match(out.configWarning ?? "", /REFUSED/, `${name} must be reported as refused`);
    assert.match(out.configWarning ?? "", /OVERWRITES/, "the refusal must say what a valid header looks like");
  }

  // Case and whitespace do not launder a refused name.
  assert.equal(resolveDeclaredIpHeader({ SCAN_RATE_LIMIT_IP_HEADER: "  X-Real-IP  " }).header, null);
  // Nor does a value that is not a single header name at all.
  assert.match(
    resolveDeclaredIpHeader({ SCAN_RATE_LIMIT_IP_HEADER: "x-client-ip, x-real-ip" }).warning,
    /not a single valid HTTP header name/
  );
  // A genuine declaration still works — the knob is narrowed, not removed.
  assert.equal(resolveDeclaredIpHeader({ SCAN_RATE_LIMIT_IP_HEADER: "CF-Connecting-IP" }).header, "cf-connecting-ip");
});

test("BAD DECLARATION — is LOUDER than no declaration, never quieter", async () => {
  const run = async (env) => {
    resetUntrustedSourceWarning();
    const said = [];
    const out = await checkScanRateLimit({
      header: headers({ "x-real-ip": "203.0.113.9" }),
      increment: counter(),
      env,
      now: T0,
      logger: { warn: (m) => said.push(m) },
    });
    return { out, said };
  };

  const undeclared = await run({});
  const declared = await run({ SCAN_RATE_LIMIT_IP_HEADER: "x-real-ip" });

  assert.equal(declared.out.trusted, false, "the pre-fix module returned trusted:true here");
  assert.ok(
    declared.said.length > undeclared.said.length,
    "a misconfigured trust knob must warn MORE than an unset one, not silence it"
  );
  assert.match(declared.said.join("\n"), /SCAN_RATE_LIMIT_IP_HEADER="x-real-ip" REFUSED/);
  assert.match(declared.said.join("\n"), /bypassable by rotating/, "the untrusted-source warning must still fire");

  // Once per process, like the other one — but on its own latch, so it is not
  // swallowed by a warning some earlier request already spent.
  const repeat = [];
  await checkScanRateLimit({
    header: headers({ "x-real-ip": "203.0.113.9" }),
    increment: counter(),
    env: { SCAN_RATE_LIMIT_IP_HEADER: "x-real-ip" },
    now: T0,
    logger: { warn: (m) => repeat.push(m) },
  });
  assert.deepEqual(repeat, []);
});

test("VERCEL=0 — the platform gate is judged by value, not by presence", () => {
  const header = headers({ [PLATFORM_IP_HEADER]: "203.0.113.9" });

  for (const value of ["0", "false", "no", "off", "", " 0 ", "FALSE"]) {
    const out = resolveClientIp({ header, env: { VERCEL: value } });
    assert.equal(out.trusted, false, `VERCEL=${JSON.stringify(value)} must not open the gate`);
    assert.equal(out.ip, null, "off Vercel the x-vercel-* header is nobody's address");
  }
  // Since R0.1.20 the gate decides whether the header is READ, not whether it
  // is trusted — nothing opens the trust gate for this header any more.
  for (const value of ["1", "true", "TRUE", "yes", "on", " 1 "]) {
    const out = resolveClientIp({ header, env: { VERCEL: value } });
    assert.equal(out.ip, "203.0.113.9", `VERCEL=${JSON.stringify(value)} must open it`);
    assert.equal(out.source, PLATFORM_IP_HEADER);
    assert.equal(out.trusted, false, "read is not the same as vouched for");
    assert.equal(out.trustBasis, TRUST_BASIS.PLATFORM_UNPROVEN);
  }
});

test("VERCEL=<unrecognised> fails closed AND says what it did with the value", async () => {
  const runtime = resolveVercelRuntime({ VERCEL: "maybe" });
  assert.equal(runtime.onVercel, false, "closed is the safe direction for an ambiguous flag");
  assert.match(runtime.warning, /VERCEL is set to "maybe"/);
  assert.match(runtime.warning, /NOT trusted/);

  resetUntrustedSourceWarning();
  const said = [];
  const out = await checkScanRateLimit({
    header: headers({ [PLATFORM_IP_HEADER]: "203.0.113.9", "x-real-ip": "192.0.2.1" }),
    increment: counter(),
    env: { VERCEL: "maybe" },
    now: T0,
    logger: { warn: (m) => said.push(m) },
  });
  assert.equal(out.trusted, false);
  assert.match(said.join("\n"), /VERCEL is set to "maybe"/, "an ignored setting is not a silent one");

  // VERCEL_URL is a hostname, not a flag: any hostname counts, the no-words do not.
  assert.equal(resolveVercelRuntime({ VERCEL_URL: "aeovis.vercel.app" }).onVercel, true);
  assert.equal(resolveVercelRuntime({ VERCEL_URL: "0" }).onVercel, false);
  assert.equal(resolveVercelRuntime({ VERCEL_URL: "" }).onVercel, false);
  assert.equal(resolveVercelRuntime({}).onVercel, false);
});

test("an address carrying a port is ONE bucket, not one per port", () => {
  assert.equal(normaliseAddress("[2001:db8::1]:443"), "2001:db8::1");
  assert.equal(normaliseAddress("[2001:DB8::1]"), "2001:db8::1");
  assert.equal(normaliseAddress("2001:DB8::1"), "2001:db8::1");
  assert.equal(normaliseAddress("203.0.113.9:51514"), "203.0.113.9");
  assert.equal(normaliseAddress("203.0.113.9"), "203.0.113.9");

  const salt = "s";
  const key = (v) => clientBucketKey({ header: headers({ "x-real-ip": v }), salt });
  assert.equal(key("[2001:db8::1]:443"), key("2001:db8::1"), "an ephemeral port must not mint a fresh budget");
  assert.equal(key("203.0.113.9:51514"), key("203.0.113.9"));
  assert.notEqual(key("2001:db8::2"), key("2001:db8::1"), "distinct addresses stay distinct");
});

test("normaliseAddress - a port and letter case are stripped from a hostname too, and a zone ID is KEPT", () => {
  // Not live in the Vercel config — a hostname only reaches here through a
  // custom SCAN_RATE_LIMIT_IP_HEADER, since host and x-forwarded-host are
  // refused — but the split it caused was real: "EXAMPLE.com:80",
  // "example.com:80" and "example.com" were three budgets for one client.
  assert.equal(normaliseAddress("EXAMPLE.com:80"), "example.com");
  assert.equal(normaliseAddress("EXAMPLE.com"), "example.com");
  assert.equal(normaliseAddress("proxy.internal:8080"), "proxy.internal");

  // The zone ID stays, on purpose. A link-local address is unique only within
  // its zone, so merging fe80::1%eth0 with fe80::1%eth1 would put two different
  // peers in one bucket and let either throttle the other. The zone is written
  // by the receiving host, never by the caller, so it cannot split one client.
  assert.equal(normaliseAddress("fe80::1%eth0"), "fe80::1%eth0");
  assert.notEqual(normaliseAddress("fe80::1%eth0"), normaliseAddress("fe80::1%eth1"));

  // A bare IPv6 has more than one colon and must not lose its last group.
  assert.equal(normaliseAddress("2001:db8::443"), "2001:db8::443");
});

test("BAD DECLARATION — an Object.prototype name is refused, and the refusal says something true", () => {
  // `name in REFUSED_IP_HEADERS` walks the prototype chain, so these two are
  // refused as well. That over-refusal is kept: this module is handed a header
  // GETTER and cannot know it is a Headers rather than a plain-object lookup,
  // and on a plain object h["__proto__"] is Object.prototype, which stringifies
  // to a truthy "[object object]" and would become a TRUSTED shared identity.
  for (const name of ["__proto__", "constructor"]) {
    const out = resolveDeclaredIpHeader({ SCAN_RATE_LIMIT_IP_HEADER: name });
    assert.equal(out.header, null, `${name} must not be honoured as a declared header`);
    assert.match(out.warning, /REFUSED/);
    assert.match(out.warning, /Object\.prototype/, "the reason must be a sentence, not an inherited value");
    assert.doesNotMatch(out.warning, /native code|\[object Object\]/, `${name} interpolated an inherited value into the operator's warning`);
  }
});

// ---------------------------------------------------------------------------
// R0.1.20 — the trusted:true label is WITHDRAWN from x-vercel-forwarded-for.
//
// Nothing inside a request handler can tell whether Vercel's edge wrote that
// header or the caller forged it, so the old `trusted: true` was an assumption
// wearing a fact's clothes — and because the warn-once fired only for UNTRUSTED
// sources, a spoofed identity would have travelled with a confidence label and
// no log line at all. The label is withheld until the deploy-time forgery check
// named in TRUST_RESTORE_CHECK exists and runs. The limit itself is untouched:
// the header is still read FIRST and the bucket key is byte-identical.
// ---------------------------------------------------------------------------

test("WITHDRAWN — the platform header is never trusted:true, in EVERY envelope shape", async () => {
  const header = headers({ [PLATFORM_IP_HEADER]: "203.0.113.9" });
  const env = { VERCEL: "1" };
  const shapes = {
    normal: counter(),
    thrown: async () => {
      throw new Error("supabase unreachable");
    },
    nonNumeric: async () => null,
  };

  for (const [name, increment] of Object.entries(shapes)) {
    resetUntrustedSourceWarning();
    const out = await checkScanRateLimit({ header, increment, env, now: T0, logger: silent });
    assert.equal(out.source, PLATFORM_IP_HEADER, `${name}: the header is still the address we read`);
    assert.equal(out.trusted, false, `${name}: an unproven label must not travel with the verdict`);
    assert.equal(out.trustBasis, TRUST_BASIS.PLATFORM_UNPROVEN, `${name}: and it must say WHY`);
  }
});

test("WITHDRAWN — the downgrade is announced, and names what would restore it", async () => {
  resetUntrustedSourceWarning();
  const said = [];
  await checkScanRateLimit({
    header: headers({ [PLATFORM_IP_HEADER]: "203.0.113.9" }),
    increment: counter(),
    env: { VERCEL: "1" },
    now: T0,
    logger: { warn: (m) => said.push(m) },
  });
  const log = said.join("\n");
  assert.match(log, /does NOT\s+vouch for it/, "a withheld label that says nothing is the defect, not the fix");
  assert.match(log, /RESTORE-TRUST-R0\.1\.20/, "the deferral must be greppable from the log line");
  assert.match(log, /forges x-vercel-forwarded-for/, "the operator must learn what check earns it back");
  assert.match(log, /limit IS applied/, "and must not read as 'the limit is off'");
  assert.doesNotMatch(
    log,
    /bypassable by rotating/,
    "this is not the caller-settable incident and must not be reported as one"
  );

  // Once per process, like every other warning here.
  const repeat = [];
  await checkScanRateLimit({
    header: headers({ [PLATFORM_IP_HEADER]: "203.0.113.9" }),
    increment: counter(),
    env: { VERCEL: "1" },
    now: T0,
    logger: { warn: (m) => repeat.push(m) },
  });
  assert.deepEqual(repeat, [], "one line per cold start, not one per request");
});

test("WITHDRAWN — the platform warning does not swallow a WORSE state later in the process", async () => {
  // The single boolean latch would have: the platform line is spent first, and
  // a later request that fell all the way back to x-real-ip — strictly worse —
  // would have passed in silence.
  resetUntrustedSourceWarning();
  const env = { VERCEL: "1" };
  const first = [];
  await checkScanRateLimit({
    header: headers({ [PLATFORM_IP_HEADER]: "203.0.113.9" }),
    increment: counter(),
    env,
    now: T0,
    logger: { warn: (m) => first.push(m) },
  });
  assert.match(first.join("\n"), /RESTORE-TRUST-R0\.1\.20/);

  const second = [];
  await checkScanRateLimit({
    header: headers({ "x-real-ip": "192.0.2.5" }),
    increment: counter(),
    env,
    now: T0,
    logger: { warn: (m) => second.push(m) },
  });
  assert.match(
    second.join("\n"),
    /bypassable by rotating/,
    "a caller-settable address must still be announced after a platform-unproven one"
  );

  const third = [];
  await checkScanRateLimit({
    header: headers({}),
    increment: counter(),
    env,
    now: T0,
    logger: { warn: (m) => third.push(m) },
  });
  assert.match(third.join("\n"), /shares ONE bucket/, "so must the no-header state");

  // Still bounded: one line per distinct basis, not one per request.
  const fourth = [];
  for (const h of [{ [PLATFORM_IP_HEADER]: "203.0.113.9" }, { "x-real-ip": "192.0.2.5" }, {}]) {
    await checkScanRateLimit({
      header: headers(h),
      increment: counter(),
      env,
      now: T0,
      logger: { warn: (m) => fourth.push(m) },
    });
  }
  assert.deepEqual(fourth, [], "three bases warned, three lines, and then quiet");
});

test("WITHDRAWN — withdrawing the label does not move the bucket or weaken the limit", async () => {
  // The dangerous way to "withdraw trust" is to stop reading the header, which
  // hands the bucket to x-real-ip — a header the caller definitely writes. The
  // key is pinned to a literal so that regression cannot pass quietly: it is
  // sha256("s:203.0.113.9") truncated to 32 hex chars, the same value the
  // pre-withdrawal module produced.
  const salt = "s";
  const key = clientBucketKey({
    header: headers({ [PLATFORM_IP_HEADER]: "203.0.113.9", "x-real-ip": "192.0.2.9" }),
    salt,
    env: { VERCEL: "1" },
  });
  assert.equal(key, "958b1683863195837a4ec6c8ad4cb824", "the bucket must be the platform address, unchanged");

  // And the limit still bites on that address.
  const increment = counter();
  const env = { VERCEL: "1", SCAN_RATE_LIMIT: "5", SCAN_RATE_LIMIT_SALT: salt };
  const verdicts = [];
  for (let i = 0; i < 6; i++) {
    verdicts.push(
      await checkScanRateLimit({
        header: headers({ [PLATFORM_IP_HEADER]: "203.0.113.9" }),
        increment,
        env,
        now: T0 + i * 1000,
        logger: silent,
      })
    );
  }
  assert.deepEqual(
    verdicts.map((v) => v.allowed),
    [true, true, true, true, true, false],
    "an untrusted-but-limited address is the goal; an unlimited one would be a worse bug"
  );
});

test("GUARD — the restore condition is a named, greppable constant, not a comment", async () => {
  assert.match(TRUST_RESTORE_CHECK, /^RESTORE-TRUST-R0\.1\.20:/);
  assert.match(TRUST_RESTORE_CHECK, /deployed origin/);
  assert.match(TRUST_RESTORE_CHECK, /bucket does not move/);
  assert.equal(TRUST_BASIS.PLATFORM_UNPROVEN, "platform-unproven");

  // untrustedSourceWarning is the operator's copy of all this; a basis it does
  // not recognise must never fall through to the platform sentence.
  const generic = untrustedSourceWarning({ source: "x-real-ip", trustBasis: TRUST_BASIS.CALLER_SETTABLE });
  assert.doesNotMatch(generic, /RESTORE-TRUST/);

  // The withdrawal is recorded where a reader of the module will find it.
  const src = await readFile(new URL("./rateLimit.js", import.meta.url), "utf8");
  assert.match(src, /RESTORE-TRUST-R0\.1\.20/);
  assert.doesNotMatch(
    src,
    /export const TRUSTED_IP_HEADER/,
    "the constant naming this header must not promise trust the module does not extend"
  );
});

// ---------------------------------------------------------------------------
// R6.2.4 — the documentation guard covers the knobs as a SET, not one by name.
//
// The previous version of this guard asserted that .env.example mentions
// SCAN_RATE_LIMIT_IP_HEADER and nothing else. It was green for the whole life of
// SCAN_RATE_LIMIT_UNVERIFIED_CEILING (R0.1.22), which appeared in neither
// .env.example nor the operator ledger — the single lever over a ceiling that
// can refuse every anonymous scan, and the guard could not see it, because a
// guard that names one variable only ever protects that variable.
//
// So the list is DERIVED from the module's own source instead of typed here: any
// new `env.SCAN_RATE_LIMIT_*` read joins the set the moment it is written, and
// an undocumented knob cannot ship green.
// ---------------------------------------------------------------------------

/**
 * Every rate-limit env var `rateLimit.js` actually READS, discovered from its
 * text. Reads only — a name that appears solely in prose or in a log string is
 * not a knob, and `env.NAME` also catches `process.env.NAME`.
 */
function rateLimitKnobsReadBy(src) {
  const found = [...src.matchAll(/\benv\.(SCAN_RATE_LIMIT[A-Z0-9_]*)/g)].map((m) => m[1]);
  return [...new Set(found)].sort();
}

/**
 * Does `text` document exactly this name, rather than a longer one that merely
 * starts with it? Load-bearing: without the right-hand boundary a file
 * containing only `SCAN_RATE_LIMIT_SALT` would make `SCAN_RATE_LIMIT` look
 * documented, and the shortest name in the set is a prefix of every other one.
 */
function documentsExactName(text, name) {
  return new RegExp(`${name}(?![A-Z0-9_])`).test(text);
}

test("GUARD — every SCAN_RATE_LIMIT_* knob the module reads is documented for operators", async () => {
  const src = await readFile(new URL("./rateLimit.js", import.meta.url), "utf8");
  const knobs = rateLimitKnobsReadBy(src);

  // Anti-vacuity, and not hypothetical: if the extractor matched nothing, every
  // loop below would iterate zero times and this test would pass while the
  // deployment documented no knob at all. An empty set is not a clean one.
  assert.ok(
    knobs.length >= 6,
    `the knob extractor found ${knobs.length} (${knobs.join(", ") || "none"}); it read 6 when this ` +
      `floor was last raised (R0.1.24 added SCAN_RATE_LIMIT_ATTESTED_CEILING), so either the regex ` +
      `has stopped matching the module or a knob was removed — lower this floor deliberately, never ` +
      `to make a red test green`
  );
  for (const required of [
    "SCAN_RATE_LIMIT",
    "SCAN_RATE_LIMIT_IP_HEADER",
    "SCAN_RATE_LIMIT_UNVERIFIED_CEILING",
    // R0.1.24. Named here as well as counted, because the extractor reads
    // LITERAL `env.NAME` text: if resolveCeiling is ever "simplified" into a
    // dynamic `env[CEILING_KNOB[tier]]` lookup, the count above still passes
    // while a live lever over anonymous scan capacity vanishes from the guard.
    "SCAN_RATE_LIMIT_ATTESTED_CEILING",
  ]) {
    assert.ok(
      knobs.includes(required),
      `${required} is read by rateLimit.js but the extractor did not find it — the derivation is ` +
        `broken, and a broken derivation makes this whole guard vacuous`
    );
  }

  const example = await readFile(new URL("../../.env.example", import.meta.url), "utf8");
  assert.deepEqual(
    knobs.filter((k) => !documentsExactName(example, k)),
    [],
    "a knob documented only in a JSDoc is undocumented: .env.example is where an operator looks"
  );

  // The same set, in the file an operator reads before touching a deployment.
  const ledger = await readFile(new URL("../../docs/OPERATOR_LEDGER.md", import.meta.url), "utf8");
  assert.deepEqual(
    knobs.filter((k) => !documentsExactName(ledger, k)),
    [],
    "docs/OPERATOR_LEDGER.md § B lists what is environment-shaped and easy to get silently wrong; " +
      "a lever over anonymous scan capacity belongs in it"
  );
});

test("GUARD — .env.example says what each of the three dangerous knobs actually does", async () => {
  const example = await readFile(new URL("../../.env.example", import.meta.url), "utf8");
  // Naming a knob is not documenting it. These are the facts an operator gets
  // wrong: which header qualifies, and that neither ceiling has an off switch.
  assert.match(example, /OVERWRITES/, "the whole point of the trust knob is a header the proxy overwrites");
  assert.match(example, /REFUSED/, "the operator must learn that a forgeable name is rejected");
  assert.match(
    example,
    /UNVERIFIED_CEILING_MULTIPLIER/,
    "the ceiling's default is derived, not literal; name the symbol so the operator can grep for it"
  );
  // R0.1.24, same rule for the second tier: the default is derived from a named
  // symbol, and an operator who reads only this file must learn WHY a deployment
  // with a declared or platform header has a ceiling at all.
  assert.match(
    example,
    /ATTESTED_CEILING_MULTIPLIER/,
    "the attested ceiling's default is derived too; name the symbol the operator can grep for"
  );
  assert.match(
    example,
    /catastrophe bound/,
    "the attested ceiling must not read as a per-IP limit — an operator who thinks it is one will " +
      "size it like one and hand back the unbounded path R0.1.24 closed"
  );
  // Tolerant of the comment wrapping, intolerant of the sentence disappearing.
  assert.match(
    example,
    /0 does not mean(?:\s|#)+"off"/,
    "SCAN_RATE_LIMIT_UNVERIFIED_CEILING=0 is ignored, not an off switch — an operator who believes " +
      "otherwise thinks they disabled a limit that is still on"
  );
});

test("GUARD — R0.1.23: .env.example and docs/OPERATOR_LEDGER.md describe Vercel header as untrusted-pending-proof", async () => {
  const example = await readFile(new URL("../../.env.example", import.meta.url), "utf8");
  const ledger = await readFile(new URL("../../docs/OPERATOR_LEDGER.md", import.meta.url), "utf8");

  assert.match(example, /untrusted-pending-proof/, ".env.example must describe Vercel header as untrusted-pending-proof");
  assert.match(example, /RESTORE-TRUST-R0.1.20/, ".env.example must point at RESTORE-TRUST-R0.1.20");
  assert.doesNotMatch(example, /x-vercel-forwarded-for is trusted/i, ".env.example must never claim x-vercel-forwarded-for is trusted");
  assert.doesNotMatch(example, /On Vercel you do not need this/i, ".env.example must not tell the operator they do not need the knob on Vercel");

  assert.match(ledger, /untrusted-pending-proof/, "docs/OPERATOR_LEDGER.md must describe Vercel header as untrusted-pending-proof");
  assert.match(ledger, /RESTORE-TRUST-R0.1.20/, "docs/OPERATOR_LEDGER.md must point at RESTORE-TRUST-R0.1.20");
  assert.doesNotMatch(ledger, /On Vercel you do not need it/i, "docs/OPERATOR_LEDGER.md must not tell the operator they do not need a trusted header on Vercel");
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

// ---------------------------------------------------------------------------
// R0.1.22 — an unverified deployment stops warning and starts limiting.
//
// Reproduced against the module at HEAD before this block existed, driving it
// with the real in-memory counter and env {} (off Vercel, no declared header):
// 100 requests carrying a ROTATING x-real-ip were allowed 100 times under
// SCAN_RATE_LIMIT=5. The module said so out loud — "the per-IP limit is
// bypassable by rotating that header" — and then applied the bypassable limit
// anyway. A warning is not a limit.
//
// The decision (recorded at UNVERIFIED_CEILING_DECISION): keep the per-address
// bucket as a courtesy, and enforce a deployment-wide ceiling on a bucket keyed
// by a constant, which no header moves.
// ---------------------------------------------------------------------------

/** Drive N requests with a DIFFERENT client-settable address each time. */
async function rotate(count, { env, headerFor, increment = counter(), logger = silent }) {
  const verdicts = [];
  for (let i = 0; i < count; i++) {
    verdicts.push(
      await checkScanRateLimit({ header: headers(headerFor(i)), increment, env, now: T0, logger })
    );
  }
  return verdicts;
}

test("THE ROTATION — 100 forged x-real-ip values buy the ceiling, not 100 scans", async () => {
  resetUntrustedSourceWarning();
  const env = { SCAN_RATE_LIMIT: "5", SCAN_RATE_LIMIT_SALT: "s" };
  const verdicts = await rotate(100, { env, headerFor: (i) => ({ "x-real-ip": `192.0.2.${i}` }) });

  const allowed = verdicts.filter((v) => v.allowed).length;
  assert.equal(allowed, 5 * UNVERIFIED_CEILING_MULTIPLIER, "the pre-fix module allowed all 100");

  // The discriminating assertion: every one of those requests had a FRESH
  // per-address bucket (its own count was 1 of 5), so the refusals cannot have
  // come from the per-address limit. Only a bucket no header moves explains them.
  for (const v of verdicts) {
    assert.equal(v.clientRemaining, 4, "each rotated address really did open its own bucket");
  }
  const refused = verdicts.filter((v) => !v.allowed);
  assert.equal(refused[0].limitScope, BUCKET_SCOPE.DEPLOYMENT, "and the refusal says which limit bound");
  assert.equal(refused[0].remaining, 0);
  assert.equal(refused[0].limit, 25, "the reported limit is the one that actually refused");
  assert.ok(refused[0].retryAfterSec > 0, "a refusal must say when to come back");
});

test("THE ROTATION — x-forwarded-for and a mixed rotation are bounded by the same ceiling", async () => {
  resetUntrustedSourceWarning();
  const env = { SCAN_RATE_LIMIT: "5", SCAN_RATE_LIMIT_SALT: "s" };
  const increment = counter();
  // Alternating the header the caller rotates must not buy two allowances: both
  // land on the one ceiling bucket.
  const verdicts = await rotate(60, {
    env,
    increment,
    headerFor: (i) =>
      i % 2 ? { "x-forwarded-for": `198.51.100.${i}, 10.0.0.1` } : { "x-real-ip": `192.0.2.${i}` },
  });
  assert.equal(verdicts.filter((v) => v.allowed).length, 25, "one ceiling, not one per header name");
});

test("the ceiling is a real bucket in the counter, and it is the one that moved", async () => {
  const env = { SCAN_RATE_LIMIT: "5", SCAN_RATE_LIMIT_SALT: "s" };
  const increment = counter();
  await rotate(10, { env, increment, headerFor: (i) => ({ "x-real-ip": `192.0.2.${i}` }) });

  const ceilingKey = unverifiedCeilingBucketKey({ salt: "s" });
  const started = windowStart(T0, HOUR);
  assert.equal(increment.store.get(`${ceilingKey}|${started}`), 10, "every rotated request was counted here");

  // ...and each forged address opened a bucket that only ever saw one request.
  for (let i = 0; i < 10; i++) {
    const key = clientBucketKey({ header: headers({ "x-real-ip": `192.0.2.${i}` }), salt: "s", env });
    assert.equal(increment.store.get(`${key}|${started}`), 1);
  }
});

test("the ceiling bucket is not reachable from any header a caller can send", () => {
  // UPPERCASE by design: normaliseAddress lowercases every address it returns,
  // so a caller who names the ceiling subject cannot collide with it and burn
  // the deployment's allowance faster than their own requests should.
  const salt = "s";
  const ceilingKey = unverifiedCeilingBucketKey({ salt });
  for (const value of [
    UNVERIFIED_CEILING_SUBJECT,
    UNVERIFIED_CEILING_SUBJECT.toLowerCase(),
    `${UNVERIFIED_CEILING_SUBJECT}:443`,
  ]) {
    for (const name of ["x-real-ip", "x-forwarded-for", "cf-connecting-ip"]) {
      const key = clientBucketKey({
        header: headers({ [name]: value }),
        salt,
        env: { SCAN_RATE_LIMIT_IP_HEADER: "cf-connecting-ip" },
      });
      assert.notEqual(key, ceilingKey, `${name}: ${value} must not land in the ceiling bucket`);
    }
  }
});

test("a CONFIGURED deployment keeps a real per-IP limit — the R0.1.24 ceiling is far above it", async () => {
  // The property R0.1.22 bought with the exemption, and which R0.1.24 must not
  // cost: a header the operator declares their proxy OVERWRITES names 100
  // distinct clients, and all 100 are served. The attested ceiling is a
  // catastrophe bound (40 x 5 = 200 here), not a per-IP substitute, so honest
  // traffic never meets it — but it IS counted, and reported as counted.
  resetUntrustedSourceWarning();
  const env = {
    SCAN_RATE_LIMIT: "5",
    SCAN_RATE_LIMIT_SALT: "s",
    SCAN_RATE_LIMIT_IP_HEADER: "cf-connecting-ip",
  };
  const verdicts = await rotate(100, { env, headerFor: (i) => ({ "cf-connecting-ip": `192.0.2.${i}` }) });
  assert.equal(
    verdicts.filter((v) => v.allowed).length,
    100,
    "a header the operator declares their proxy OVERWRITES names 100 clients, not one spoofer"
  );
  assert.equal(verdicts[99].ceiling.state, CEILING_STATE.COUNTED, "the ceiling ran...");
  assert.equal(verdicts[99].ceiling.tier, CEILING_TIER.ATTESTED, "...and it is the attested one");
  assert.equal(verdicts[99].ceiling.limit, 5 * ATTESTED_CEILING_MULTIPLIER);
  assert.equal(verdicts[99].ceiling.remaining, 100, "a measurement, so the operator can see the headroom");
  assert.equal(verdicts[99].limitScope, BUCKET_SCOPE.CLIENT);
  assert.equal(ceilingTierFor({ trustBasis: TRUST_BASIS.DECLARED }), CEILING_TIER.ATTESTED);
});

test("R0.1.20 IS PRESERVED — the platform header's bucket is unchanged, and now it has a ceiling", async () => {
  // R0.1.22 exempted this basis because the axis it cared about was
  // caller-SETTABILITY. R0.1.24 adds the axis that was missing: the header is
  // unproven (trusted:false, RESTORE-TRUST-R0.1.20), so if the edge does NOT
  // strip an inbound copy, rotating it was unbounded — measured 60/60 allowed.
  // What R0.1.20 settled is still settled: the address is read first, the bucket
  // key is unchanged, and 100 distinct platform-supplied clients are all served.
  resetUntrustedSourceWarning();
  const env = { SCAN_RATE_LIMIT: "5", SCAN_RATE_LIMIT_SALT: "s", VERCEL: "1" };
  const verdicts = await rotate(100, { env, headerFor: (i) => ({ [PLATFORM_IP_HEADER]: `192.0.2.${i}` }) });
  assert.equal(verdicts.filter((v) => v.allowed).length, 100);
  assert.equal(verdicts[0].ceiling.state, CEILING_STATE.COUNTED);
  assert.equal(verdicts[0].ceiling.tier, CEILING_TIER.ATTESTED);
  assert.equal(ceilingTierFor({ trustBasis: TRUST_BASIS.PLATFORM_UNPROVEN }), CEILING_TIER.ATTESTED);

  // But OFF Vercel the same header is nobody's address at all: the caller lands
  // in the shared no-address bucket, which the per-address limit of 5 closes
  // long before the ceiling of 25 does. Rotation buys 5, not 100.
  resetUntrustedSourceWarning();
  const off = await rotate(30, {
    env: { SCAN_RATE_LIMIT: "5", SCAN_RATE_LIMIT_SALT: "s" },
    headerFor: (i) => ({ [PLATFORM_IP_HEADER]: `192.0.2.${i}` }),
  });
  assert.equal(off.filter((v) => v.allowed).length, 5, "off Vercel that header buys nothing");
  assert.equal(off[0].trustBasis, TRUST_BASIS.ABSENT, "it is not an address, so it is not a bucket");
  assert.equal(off[0].ceiling.state, CEILING_STATE.COUNTED, "and the ceiling is watching that bucket too");
});

test("the no-header caller is under the unverified ceiling, and an unknown basis fails closed", () => {
  assert.equal(ceilingTierFor({ trustBasis: TRUST_BASIS.ABSENT }), CEILING_TIER.UNVERIFIED);
  assert.equal(ceilingTierFor({ trustBasis: TRUST_BASIS.CALLER_SETTABLE }), CEILING_TIER.UNVERIFIED);
  assert.equal(
    ceilingTierFor({}),
    CEILING_TIER.UNVERIFIED,
    "a basis nobody classified must land in the STRICTER tier, never outside both"
  );
  assert.equal(ceilingTierFor(undefined), CEILING_TIER.UNVERIFIED);
  assert.equal(ceilingTierFor({ trustBasis: "some-basis-invented-next-year" }), CEILING_TIER.UNVERIFIED);
});

test("the ceiling is env-configurable, and garbage falls back to the derived value, never to 0", async () => {
  assert.equal(resolveUnverifiedCeiling({}, 5).limit, 25);
  assert.equal(resolveUnverifiedCeiling({}, 5).declared, false);
  assert.equal(resolveUnverifiedCeiling({ SCAN_RATE_LIMIT_UNVERIFIED_CEILING: "3" }, 5).limit, 3);
  assert.equal(resolveUnverifiedCeiling({ SCAN_RATE_LIMIT_UNVERIFIED_CEILING: "3" }, 5).declared, true);
  for (const bad of ["0", "-1", "abc", ""]) {
    assert.equal(
      resolveUnverifiedCeiling({ SCAN_RATE_LIMIT_UNVERIFIED_CEILING: bad }, 5).limit,
      25,
      `SCAN_RATE_LIMIT_UNVERIFIED_CEILING=${JSON.stringify(bad)} must not refuse every scan`
    );
  }

  resetUntrustedSourceWarning();
  const verdicts = await rotate(10, {
    env: { SCAN_RATE_LIMIT: "5", SCAN_RATE_LIMIT_UNVERIFIED_CEILING: "3" },
    headerFor: (i) => ({ "x-real-ip": `192.0.2.${i}` }),
  });
  assert.equal(verdicts.filter((v) => v.allowed).length, 3, "the declared ceiling is the one enforced");
  assert.equal(verdicts[9].ceiling.declared, true);
});

test("the envelope reports the SMALLER of the two remainings, never the flattering one", async () => {
  resetUntrustedSourceWarning();
  const env = { SCAN_RATE_LIMIT: "5", SCAN_RATE_LIMIT_UNVERIFIED_CEILING: "6", SCAN_RATE_LIMIT_SALT: "s" };
  const increment = counter();
  // One honest caller, five requests. Its own bucket allows five; the ceiling
  // allows six. The fifth has 0 left of its own and 1 of the ceiling.
  const header = headers({ "x-real-ip": "203.0.113.9" });
  const v = [];
  for (let i = 0; i < 5; i++) {
    v.push(await checkScanRateLimit({ header, increment, env, now: T0, logger: silent }));
  }
  assert.equal(v[4].remaining, 0, "the address's own budget is the binding one here");
  assert.equal(v[4].limitScope, BUCKET_SCOPE.CLIENT);
  assert.equal(v[4].ceiling.remaining, 1, "and the ceiling's own count is still reported");
  assert.equal(v[4].clientRemaining, 0);

  // A second address exhausts what is left of the ceiling: this refusal is NOT
  // about the caller's own address, and must not be reported as if it were.
  const other = headers({ "x-real-ip": "203.0.113.10" });
  const sixth = await checkScanRateLimit({ header: other, increment, env, now: T0, logger: silent });
  assert.equal(sixth.allowed, true, "the sixth is the last one the ceiling permits");
  const seventh = await checkScanRateLimit({ header: other, increment, env, now: T0, logger: silent });
  assert.equal(seventh.allowed, false);
  assert.equal(seventh.limitScope, BUCKET_SCOPE.DEPLOYMENT, "a shared refusal must say it is shared");
  assert.equal(seventh.clientRemaining, 3, "this caller's own budget was nowhere near spent");
  assert.equal(seventh.remaining, 0);
  assert.equal(seventh.limit, 6);
});

test("a request the per-address limit already refused does not spend the shared allowance", async () => {
  // Otherwise one caller hammering ONE address — who never gets a scan after
  // their fifth — could burn the whole deployment's ceiling and take the
  // product down for everybody else, at zero cost and with no vendor spend to
  // show for it. The ceiling bounds scans this deployment would START.
  resetUntrustedSourceWarning();
  const env = { SCAN_RATE_LIMIT: "2", SCAN_RATE_LIMIT_UNVERIFIED_CEILING: "10", SCAN_RATE_LIMIT_SALT: "s" };
  const increment = counter();
  const header = headers({ "x-real-ip": "203.0.113.66" });
  const verdicts = [];
  for (let i = 0; i < 12; i++) {
    verdicts.push(await checkScanRateLimit({ header, increment, env, now: T0, logger: silent }));
  }
  assert.equal(verdicts.filter((v) => v.allowed).length, 2, "their own bucket is what refuses them");

  const started = windowStart(T0, HOUR);
  assert.equal(
    increment.store.get(`${unverifiedCeilingBucketKey({ salt: "s" })}|${started}`),
    2,
    "ten refused requests must not have been charged to the shared ceiling"
  );
  assert.equal(verdicts[11].ceiling.state, CEILING_STATE.SKIPPED_REFUSED_EARLIER);
  assert.equal(verdicts[11].ceiling.remaining, null, "a ceiling that was not read has no remaining count");
  assert.equal(verdicts[11].ceiling.limit, 10, "...but the ceiling it is under is still named");
  assert.equal(verdicts[11].limitScope, BUCKET_SCOPE.CLIENT);

  // The deployment is still open for everybody else, which is the whole point.
  const other = await checkScanRateLimit({
    header: headers({ "x-real-ip": "203.0.113.67" }),
    increment,
    env,
    now: T0,
    logger: silent,
  });
  assert.equal(other.allowed, true, "one abusive address must not close the door on the next caller");
  assert.equal(other.ceiling.remaining, 7);
});

test("an EXHAUSTED ceiling is announced once, on its own latch, and names the way out", async () => {
  resetUntrustedSourceWarning();
  const said = [];
  await rotate(4, {
    env: { SCAN_RATE_LIMIT: "5", SCAN_RATE_LIMIT_UNVERIFIED_CEILING: "2" },
    headerFor: (i) => ({ "x-real-ip": `192.0.2.${i}` }),
    logger: { warn: (m) => said.push(m) },
  });
  const log = said.join("\n");
  assert.match(log, /ceiling \(2 scans per window/, "the operator must learn the number that refused");
  assert.match(log, /EXHAUSTED/);
  assert.match(log, /SCAN_RATE_LIMIT_IP_HEADER/, "and how to get a real per-IP limit back");
  assert.match(log, /SCAN_RATE_LIMIT_UNVERIFIED_CEILING/, "and the knob that raises it");
  assert.equal(
    said.filter((m) => /EXHAUSTED/.test(m)).length,
    1,
    "one line per process, not one per refused request"
  );

  // It is its OWN latch: the caller-settable warning was spent on the first
  // request and must not have silenced this one.
  assert.match(log, /bypassable by rotating/);
});

test("a broken ceiling counter FAILS OPEN but says so, and reports UNMEASURED, not 0", async () => {
  resetUntrustedSourceWarning();
  const said = [];
  const clientCounter = counter();
  const out = await checkScanRateLimit({
    header: headers({ "x-real-ip": "203.0.113.9" }),
    increment: async ({ bucketKey, windowStart: ws }) =>
      bucketKey === unverifiedCeilingBucketKey({ salt: "s" })
        ? Promise.reject(new Error("supabase unreachable"))
        : clientCounter({ bucketKey, windowStart: ws }),
    env: { SCAN_RATE_LIMIT: "5", SCAN_RATE_LIMIT_SALT: "s" },
    now: T0,
    logger: { warn: (m) => said.push(m) },
  });
  assert.equal(out.allowed, true, "a broken limiter must not take the product down");
  assert.equal(out.degraded, true, "...but the degrade must be visible, not silent");
  assert.equal(out.ceiling.state, CEILING_STATE.UNAVAILABLE, "it was supposed to run and did not — that is not a count of 0");
  assert.equal(out.ceiling.limit, 25, "the ceiling it failed to enforce is still named");
  assert.equal(out.ceiling.remaining, null, "never report a fabricated remaining count");
  assert.match(said.join("\n"), /ceiling counter is unavailable/);
  assert.match(said.join("\n"), /one-running-scan-per-brand/, "the log must name what still bounds the damage");

  // A non-numeric count is the same incident, not a zero.
  resetUntrustedSourceWarning();
  const nonNumeric = await checkScanRateLimit({
    header: headers({ "x-real-ip": "203.0.113.9" }),
    increment: async ({ bucketKey }) =>
      bucketKey === unverifiedCeilingBucketKey({ salt: "s" }) ? null : 1,
    env: { SCAN_RATE_LIMIT: "5", SCAN_RATE_LIMIT_SALT: "s" },
    now: T0,
    logger: silent,
  });
  assert.equal(nonNumeric.degraded, true);
  assert.equal(nonNumeric.ceiling.state, CEILING_STATE.UNAVAILABLE);
  assert.equal(nonNumeric.ceiling.remaining, null);
});

test("the unverified state is announced with the ceiling named, not as a bare complaint", async () => {
  resetUntrustedSourceWarning();
  const said = [];
  await checkScanRateLimit({
    header: headers({ "x-real-ip": "203.0.113.9" }),
    increment: counter(),
    env: { SCAN_RATE_LIMIT: "5" },
    now: T0,
    logger: { warn: (m) => said.push(m) },
  });
  assert.match(said.join("\n"), /ceiling of 25 scans per window/, "the warning must name the limit that binds");
  assert.match(said.join("\n"), /exhaust it for everyone/, "and the cost of the choice");

  // The no-address caller hears about it too — that bucket is shared as well.
  resetUntrustedSourceWarning();
  const none = [];
  await checkScanRateLimit({
    header: headers({}),
    increment: counter(),
    env: { SCAN_RATE_LIMIT: "5" },
    now: T0,
    logger: { warn: (m) => none.push(m) },
  });
  assert.match(none.join("\n"), /shares ONE bucket/);
  assert.match(none.join("\n"), /ceiling of 25 scans per window/);

  // Called without a ceiling to name, the sentence must not grow a hole.
  const bare = untrustedSourceWarning({ source: "x-real-ip", trustBasis: TRUST_BASIS.CALLER_SETTABLE });
  assert.doesNotMatch(bare, /undefined|null|NaN/, "a message with a hole in it is not a message");
});

test("GUARD — the R0.1.22 decision is recorded in the module, not only in a ledger", async () => {
  assert.match(UNVERIFIED_CEILING_DECISION, /^R0\.1\.22:/);
  assert.match(UNVERIFIED_CEILING_DECISION, /deployment-wide ceiling/);
  assert.match(UNVERIFIED_CEILING_DECISION, /no request header can move/);

  const src = await readFile(new URL("./rateLimit.js", import.meta.url), "utf8");
  assert.match(src, /R0\.1\.22/);
  assert.match(src, /Two honest options were on the table/, "the rejected option must be recorded too");
});

test("GUARD — POST /api/scan does not call a shared refusal an address's own", async () => {
  const src = await readFile(new URL("../app/api/scan/route.js", import.meta.url), "utf8");
  assert.match(src, /limitScope/, "the route must read which limit refused");
  assert.match(src, /BUCKET_SCOPE\.CLIENT/, "and must key the per-address copy off the explicit scope");
  assert.match(src, /Too many scans right now/, "a shared refusal needs its own sentence");
});

// ---------------------------------------------------------------------------
// R0.1.24 — the two bases R0.1.22 EXEMPTED are bounded too.
//
// Reproduced against the module at HEAD before this block existed, with the real
// in-memory counter and SCAN_RATE_LIMIT=5:
//
//   60 rotating x-vercel-forwarded-for, VERCEL=1        -> 60/60 allowed
//   60 rotating a declared cf-connecting-ip             -> 60/60 allowed
//   60 rotating x-real-ip (the R0.1.22 control)         -> 25/60 allowed
//
// Both exempt paths reported ceiling.state = "not-applicable" while allowing
// every request. POST /api/scan is ALLOW_PUBLIC in the operator perimeter, so the
// caller driving those 60 requests holds no credential, and every allowed request
// starts a scan that spends scrape + probe + LLM budget.
//
// The decision (recorded at ATTESTED_CEILING_DECISION): a ceiling of their own —
// separate bucket, far larger number, its own env lever — so a correctly
// configured deployment is not capped at the unverified tier's 25/hour while a
// forged header still buys a finite number of scans instead of infinity.
// ---------------------------------------------------------------------------

/** The env in which x-vercel-forwarded-for is the address (PLATFORM_UNPROVEN). */
const onVercel = (extra = {}) => ({ SCAN_RATE_LIMIT: "5", SCAN_RATE_LIMIT_SALT: "s", VERCEL: "1", ...extra });
/** The env in which a declared header is the address (DECLARED). */
const withDeclaredHeader = (extra = {}) => ({
  SCAN_RATE_LIMIT: "5",
  SCAN_RATE_LIMIT_SALT: "s",
  SCAN_RATE_LIMIT_IP_HEADER: "cf-connecting-ip",
  ...extra,
});

test("THE ROTATION — 60 forged platform headers buy the attested ceiling, not 60 scans", async () => {
  resetUntrustedSourceWarning();
  const env = onVercel({ SCAN_RATE_LIMIT_ATTESTED_CEILING: "20" });
  const increment = counter();
  const verdicts = await rotate(60, {
    env,
    increment,
    headerFor: (i) => ({ [PLATFORM_IP_HEADER]: `192.0.2.${i}` }),
  });

  assert.equal(
    verdicts.filter((v) => v.allowed).length,
    20,
    "the pre-R0.1.24 module allowed all 60 — measured, not assumed"
  );

  // THE DISCRIMINATING ASSERTION. Every one of those 60 requests opened a
  // per-address bucket that saw exactly ONE request out of a limit of five, so
  // the per-address tier refused nothing here. The refusals can only have come
  // from a bucket no request header addresses.
  const started = windowStart(T0, HOUR);
  for (const v of verdicts) assert.equal(v.clientRemaining, 4, "each forged address really opened its own bucket");
  for (let i = 0; i < 60; i++) {
    const key = clientBucketKey({ header: headers({ [PLATFORM_IP_HEADER]: `192.0.2.${i}` }), salt: "s", env });
    assert.equal(increment.store.get(`${key}|${started}`), 1);
  }
  assert.equal(
    increment.store.get(`${attestedCeilingBucketKey({ salt: "s" })}|${started}`),
    60,
    "every rotated request was counted against the attested bucket"
  );

  const refused = verdicts.filter((v) => !v.allowed);
  assert.equal(refused.length, 40);
  assert.equal(refused[0].limitScope, BUCKET_SCOPE.DEPLOYMENT, "a shared refusal must say it is shared");
  assert.equal(refused[0].limit, 20, "the reported limit is the one that actually refused");
  assert.equal(refused[0].remaining, 0);
  assert.ok(refused[0].retryAfterSec > 0, "a refusal must say when to come back");
  assert.equal(refused[0].ceiling.tier, CEILING_TIER.ATTESTED);
  assert.equal(refused[0].ceiling.declared, true, "this run's ceiling came from the env lever");
});

test("THE ROTATION — 60 forged DECLARED headers buy the attested ceiling, not 60 scans", async () => {
  // The operator's declaration is an assertion about someone else's proxy. If
  // that proxy passes the header through instead of overwriting it, this is the
  // same rotation as above with a different header name, and it measured 60/60.
  resetUntrustedSourceWarning();
  const env = withDeclaredHeader({ SCAN_RATE_LIMIT_ATTESTED_CEILING: "20" });
  const increment = counter();
  const verdicts = await rotate(60, {
    env,
    increment,
    headerFor: (i) => ({ "cf-connecting-ip": `192.0.2.${i}` }),
  });

  assert.equal(verdicts.filter((v) => v.allowed).length, 20);
  for (const v of verdicts) {
    assert.equal(v.clientRemaining, 4);
    assert.equal(v.trustBasis, TRUST_BASIS.DECLARED, "this rotation must be exercising the declared basis");
  }
  const started = windowStart(T0, HOUR);
  assert.equal(increment.store.get(`${attestedCeilingBucketKey({ salt: "s" })}|${started}`), 60);
  assert.equal(verdicts[59].limitScope, BUCKET_SCOPE.DEPLOYMENT);
  assert.equal(verdicts[59].ceiling.tier, CEILING_TIER.ATTESTED);
});

test("THE DEFAULT is finite too — the 201st rotated request on an unconfigured Vercel deploy is refused", async () => {
  // The configuration that actually ships: no SCAN_RATE_LIMIT_ATTESTED_CEILING,
  // so the ceiling derives as 40 x 5 = 200. N+1 through the real limiter.
  resetUntrustedSourceWarning();
  const env = onVercel();
  const increment = counter();
  const verdicts = await rotate(201, {
    env,
    increment,
    headerFor: (i) => ({ [PLATFORM_IP_HEADER]: `198.51.100.${i}` }),
  });

  assert.equal(verdicts.filter((v) => v.allowed).length, 200, "the derived default is the one enforced");
  assert.equal(verdicts[199].allowed, true, "the 200th is the last one the deployment permits");
  assert.equal(verdicts[200].allowed, false, "and the 201st is refused");
  assert.equal(verdicts[200].limitScope, BUCKET_SCOPE.DEPLOYMENT);
  assert.equal(verdicts[200].limit, 5 * ATTESTED_CEILING_MULTIPLIER);
  assert.equal(verdicts[200].ceiling.declared, false, "derived, and reported as derived");
  assert.equal(verdicts[0].ceiling.remaining, 199, "a measurement, never a fabricated 0");
});

test("NO BASIS IS EXEMPT — every trust basis lands in a tier and is counted", async () => {
  // The shape of the R0.1.24 bug: a basis that reaches the limiter and answers to
  // no ceiling. This walks all four and asserts each was COUNTED against a real
  // bucket. The literal 4 is the anti-vacuity: a fifth basis added later cannot
  // slip through unclassified while this test keeps passing.
  assert.equal(Object.values(TRUST_BASIS).length, 4, "a new trust basis must be classified into a tier here");
  const cases = [
    {
      basis: TRUST_BASIS.PLATFORM_UNPROVEN,
      tier: CEILING_TIER.ATTESTED,
      env: onVercel(),
      h: { [PLATFORM_IP_HEADER]: "203.0.113.1" },
    },
    {
      basis: TRUST_BASIS.DECLARED,
      tier: CEILING_TIER.ATTESTED,
      env: withDeclaredHeader(),
      h: { "cf-connecting-ip": "203.0.113.2" },
    },
    {
      basis: TRUST_BASIS.CALLER_SETTABLE,
      tier: CEILING_TIER.UNVERIFIED,
      env: { SCAN_RATE_LIMIT: "5" },
      h: { "x-real-ip": "203.0.113.3" },
    },
    { basis: TRUST_BASIS.ABSENT, tier: CEILING_TIER.UNVERIFIED, env: { SCAN_RATE_LIMIT: "5" }, h: {} },
  ];

  for (const { basis, tier, env, h } of cases) {
    resetUntrustedSourceWarning();
    const out = await checkScanRateLimit({
      header: headers(h),
      increment: counter(),
      env,
      now: T0,
      logger: silent,
    });
    assert.equal(out.trustBasis, basis, `this case must exercise ${basis}`);
    assert.equal(out.ceiling.tier, tier, `${basis} must answer to the ${tier} ceiling`);
    assert.equal(out.ceiling.state, CEILING_STATE.COUNTED, `${basis} must be COUNTED, not exempt`);
    assert.ok(Number.isFinite(out.ceiling.limit) && out.ceiling.limit > 0, `${basis}: a ceiling must be a number`);
    assert.ok(out.ceiling.bucketKey, `${basis}: a ceiling must name the bucket it counted in`);
    assert.equal(typeof out.ceiling.remaining, "number", `${basis}: a counted ceiling reports a measurement`);
  }

  // And the state that meant "no ceiling here" is gone, rather than left
  // unreachable for a future reader to believe.
  assert.equal(CEILING_STATE.NOT_APPLICABLE, undefined, "a ceiling state nothing can produce is a lie");
});

test("the two tiers are separate buckets — neither can spend the other allowance", async () => {
  resetUntrustedSourceWarning();
  const increment = counter();
  const started = windowStart(T0, HOUR);
  const salt = "s";

  // Exhaust the unverified tier with a rotation, off Vercel.
  await rotate(30, {
    env: { SCAN_RATE_LIMIT: "5", SCAN_RATE_LIMIT_SALT: salt },
    increment,
    headerFor: (i) => ({ "x-real-ip": `192.0.2.${i}` }),
  });
  assert.equal(increment.store.get(`${unverifiedCeilingBucketKey({ salt })}|${started}`), 30);
  assert.equal(
    increment.store.get(`${attestedCeilingBucketKey({ salt })}|${started}`),
    undefined,
    "unverified traffic must not be charged to the attested tier"
  );

  // The attested tier is untouched by that: a platform-supplied caller is served.
  resetUntrustedSourceWarning();
  const out = await checkScanRateLimit({
    header: headers({ [PLATFORM_IP_HEADER]: "203.0.113.44" }),
    increment,
    env: onVercel(),
    now: T0,
    logger: silent,
  });
  assert.equal(out.allowed, true, "an exhausted unverified ceiling must not refuse the attested tier");
  assert.equal(out.ceiling.tier, CEILING_TIER.ATTESTED);
  assert.equal(out.ceiling.remaining, 5 * ATTESTED_CEILING_MULTIPLIER - 1);
  assert.notEqual(unverifiedCeilingBucketKey({ salt }), attestedCeilingBucketKey({ salt }));
});

test("the attested ceiling bucket is not reachable from any header a caller can send", () => {
  // Same UPPERCASE property as the R0.1.22 subject: normaliseAddress lowercases
  // every address, so no header value collides with the bucket that bounds the
  // whole deployment.
  const salt = "s";
  const target = attestedCeilingBucketKey({ salt });
  for (const value of [
    ATTESTED_CEILING_SUBJECT,
    ATTESTED_CEILING_SUBJECT.toLowerCase(),
    `${ATTESTED_CEILING_SUBJECT}:443`,
    `[${ATTESTED_CEILING_SUBJECT}]`,
  ]) {
    for (const name of [PLATFORM_IP_HEADER, "cf-connecting-ip", "x-real-ip", "x-forwarded-for"]) {
      const key = clientBucketKey({
        header: headers({ [name]: value }),
        salt,
        env: { VERCEL: "1", SCAN_RATE_LIMIT_IP_HEADER: "cf-connecting-ip" },
      });
      assert.notEqual(key, target, `${name}: ${value} must not land in the attested ceiling bucket`);
    }
  }

  // And an unknown tier cannot silently become a bucket of its own.
  assert.throws(() => ceilingBucketKey({ tier: "typo", salt }), /unknown ceiling tier/);
  assert.throws(() => ceilingBucketKey({ salt }), /unknown ceiling tier/);
});

test("an EXHAUSTED attested ceiling is announced once, on a latch of its own, and names the way out", async () => {
  resetUntrustedSourceWarning();
  const said = [];
  await rotate(4, {
    env: onVercel({ SCAN_RATE_LIMIT_ATTESTED_CEILING: "2" }),
    headerFor: (i) => ({ [PLATFORM_IP_HEADER]: `192.0.2.${i}` }),
    logger: { warn: (m) => said.push(m) },
  });
  const log = said.join("\n");
  assert.match(log, /attested deployment ceiling \(2 scans per window/, "name the number that refused");
  assert.match(log, /EXHAUSTED/);
  assert.match(log, /SCAN_RATE_LIMIT_ATTESTED_CEILING/, "and the knob that raises it");
  assert.match(log, /FORGED/, "and the other explanation, which is the security incident");
  assert.match(log, /RESTORE-TRUST-R0\.1\.20/, "and the check that would settle which one it is");
  assert.doesNotMatch(
    log,
    /Set SCAN_RATE_LIMIT_IP_HEADER to the single header/,
    "the unverified tier advice is wrong here: this deployment HAS an address source"
  );
  assert.equal(said.filter((m) => /EXHAUSTED/.test(m)).length, 1, "one line per process, not one per refusal");

  // Its own latch: exhausting the OTHER tier in the same process must still be
  // reported. One boolean for both would hide the second outage behind the first.
  const more = [];
  await rotate(4, {
    env: { SCAN_RATE_LIMIT: "5", SCAN_RATE_LIMIT_UNVERIFIED_CEILING: "2" },
    headerFor: (i) => ({ "x-real-ip": `192.0.2.${i}` }),
    logger: { warn: (m) => more.push(m) },
  });
  const second = more.filter((m) => /EXHAUSTED/.test(m));
  assert.equal(second.length, 1, "the unverified tier running out is a different incident, not a repeat");
  assert.match(second[0], /R0\.1\.22 deployment ceiling/);
});

test("the attested ceiling is env-configurable, and garbage falls back to the derived value, never to 0", async () => {
  const attested = CEILING_TIER.ATTESTED;
  assert.equal(resolveCeiling({}, 5, attested).limit, 200);
  assert.equal(resolveCeiling({}, 5, attested).declared, false);
  assert.equal(resolveCeiling({ SCAN_RATE_LIMIT_ATTESTED_CEILING: "7" }, 5, attested).limit, 7);
  assert.equal(resolveCeiling({ SCAN_RATE_LIMIT_ATTESTED_CEILING: "7" }, 5, attested).declared, true);
  for (const bad of ["0", "-1", "abc", "", "  "]) {
    assert.equal(
      resolveCeiling({ SCAN_RATE_LIMIT_ATTESTED_CEILING: bad }, 5, attested).limit,
      200,
      `SCAN_RATE_LIMIT_ATTESTED_CEILING=${JSON.stringify(bad)} must not refuse every scan`
    );
  }

  // The two knobs move the two tiers independently — a crossed wire here would
  // let one deployment-wide number be raised by the wrong variable.
  const env = { SCAN_RATE_LIMIT_UNVERIFIED_CEILING: "3", SCAN_RATE_LIMIT_ATTESTED_CEILING: "9" };
  assert.equal(resolveCeiling(env, 5, CEILING_TIER.UNVERIFIED).limit, 3);
  assert.equal(resolveCeiling(env, 5, attested).limit, 9);
  assert.equal(resolveUnverifiedCeiling(env, 5).limit, 3, "the R0.1.22 name still reads the R0.1.22 knob");
  assert.equal(resolveCeiling(env, 5).tier, CEILING_TIER.UNVERIFIED, "the default tier is the stricter one");
});

test("GUARD — the R0.1.24 decision is recorded in the module, not only in a ledger", async () => {
  assert.match(ATTESTED_CEILING_DECISION, /^R0\.1\.24:/);
  assert.match(ATTESTED_CEILING_DECISION, /no trust basis is exempt/);
  assert.match(ATTESTED_CEILING_DECISION, /no request header can move/);

  const src = await readFile(new URL("./rateLimit.js", import.meta.url), "utf8");
  assert.match(src, /60\/60/, "the measurement that justified this must be in the source, not only in a ledger");
  assert.match(
    src,
    /catastrophe bound/,
    "the rejected option — folding both bases into the 25/hour tier — must be recorded with its reason"
  );
  assert.doesNotMatch(
    src,
    /export function ceilingApplies/,
    "a predicate that answers whether a ceiling applies is a predicate that can answer no"
  );
});
