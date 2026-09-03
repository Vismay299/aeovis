import test from "node:test";
import assert from "node:assert/strict";
import { authorizeCronRequest, isCronAuthorized, CRON_AUTH } from "./cronAuth.js";

const SECRET = "s3cr3t-cron-value";

/** Minimal stand-in for the Request/URLSearchParams pair a route hands the gate. */
function req(headers = {}) {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return { headers: { get: (name) => lower[String(name).toLowerCase()] ?? null } };
}
const qs = (obj = {}) => new URLSearchParams(obj);
const silent = { warn: () => {}, error: () => {} };

// ---------------------------------------------------------------------------
// C9 — the fail-open gate. These four are the regression.
// ---------------------------------------------------------------------------

test("PRODUCTION + no CRON_SECRET — DENIED (this used to return true)", () => {
  const out = authorizeCronRequest({
    secret: undefined,
    nodeEnv: "production",
    header: () => null,
  });
  assert.equal(out.authorized, false);
  assert.equal(out.reason, CRON_AUTH.DENY_NO_SECRET_IN_PRODUCTION);
});

test("PRODUCTION + no CRON_SECRET — a forged x-vercel-cron header does not rescue the call", () => {
  const out = authorizeCronRequest({
    secret: "   ",
    nodeEnv: "production",
    header: (n) => (n === "x-vercel-cron" ? "1" : null),
  });
  assert.equal(out.authorized, false, "an empty/whitespace secret must count as unset");
  assert.equal(out.reason, CRON_AUTH.DENY_NO_SECRET_IN_PRODUCTION);
});

// ---------------------------------------------------------------------------
// R0.1.8 / C9 residual — the forgeable x-vercel-cron bypass.
// The test above is NAMED for the forged header but only exercises the
// `!configured` branch, which returns before the header is ever read. These
// are the cases that actually reach the removed bypass: a secret IS
// configured and the caller presents nothing but the spoofable header.
// ---------------------------------------------------------------------------

test("PRODUCTION + CRON_SECRET set — x-vercel-cron alone is refused (the removed bypass)", () => {
  const out = authorizeCronRequest({
    secret: SECRET,
    nodeEnv: "production",
    header: (n) => (String(n).toLowerCase() === "x-vercel-cron" ? "1" : null),
  });
  assert.equal(out.authorized, false, "a client-settable header must not stand in for the secret");
  assert.equal(out.reason, CRON_AUTH.DENY_BAD_SECRET);
});

test("NON-PRODUCTION + CRON_SECRET set — x-vercel-cron alone is refused there too", () => {
  for (const nodeEnv of ["development", "test", undefined]) {
    const out = authorizeCronRequest({
      secret: SECRET,
      nodeEnv,
      header: (n) => (String(n).toLowerCase() === "x-vercel-cron" ? "1" : null),
    });
    assert.equal(out.authorized, false, `NODE_ENV=${nodeEnv} must also refuse the forged header`);
    assert.equal(out.reason, CRON_AUTH.DENY_BAD_SECRET);
  }
});

test("the gate exposes no x-vercel-cron acceptance reason at all", () => {
  assert.equal(
    Object.values(CRON_AUTH).some((v) => String(v).includes("vercel")),
    false,
    "an ok_vercel_cron outcome would mean the bypass came back"
  );
});

test("POSITIVE CONTROL — all three secret paths still pass WITH x-vercel-cron present", () => {
  const cases = [
    { headers: { "x-vercel-cron": "1", authorization: `Bearer ${SECRET}` }, query: null },
    { headers: { "x-vercel-cron": "1", "x-cron-secret": SECRET }, query: null },
    { headers: { "x-vercel-cron": "1" }, query: SECRET },
  ];
  for (const c of cases) {
    const out = authorizeCronRequest({
      secret: SECRET,
      nodeEnv: "production",
      header: (n) => req(c.headers).headers.get(n),
      querySecret: c.query,
    });
    assert.equal(out.authorized, true, `the header must be ignored, not rejected: ${JSON.stringify(c)}`);
    assert.equal(out.reason, CRON_AUTH.OK_SECRET);
  }
});

test("HEADER CASE — a REAL Request with mixed-case names is read correctly", () => {
  // The tests above drive `header` with the local `req()` helper, which
  // lowercases its keys — so they would pass even if the gate depended on
  // exact-case lookup, which real traffic never guarantees. The gate asks for
  // "authorization" and "x-cron-secret" in lowercase; a caller (or Vercel) may
  // send "Authorization" / "X-Cron-Secret". Drive it with the genuine
  // Headers.get the routes hand it, from names as they arrive on the wire.
  const cases = [
    { "X-Vercel-Cron": "1", Authorization: `Bearer ${SECRET}` },
    { "X-Vercel-Cron": "1", "X-Cron-Secret": SECRET },
    { AUTHORIZATION: `Bearer ${SECRET}` },
  ];
  for (const headers of cases) {
    const request = new Request("https://aeovis.test/api/scan/worker", { headers });
    const out = authorizeCronRequest({
      secret: SECRET,
      nodeEnv: "production",
      header: (n) => request.headers.get(n),
    });
    assert.equal(out.authorized, true, `case-insensitive lookup failed for ${JSON.stringify(headers)}`);
    assert.equal(out.reason, CRON_AUTH.OK_SECRET);
  }
  // ...and the forged header keeps failing when it is the only thing sent,
  // however it is capitalised.
  for (const name of ["x-vercel-cron", "X-Vercel-Cron", "X-VERCEL-CRON"]) {
    const request = new Request("https://aeovis.test/api/scan/worker", { headers: { [name]: "1" } });
    const out = authorizeCronRequest({
      secret: SECRET,
      nodeEnv: "production",
      header: (n) => request.headers.get(n),
    });
    assert.equal(out.authorized, false, `${name} must not authenticate anything`);
    assert.equal(out.reason, CRON_AUTH.DENY_BAD_SECRET);
  }
});

test("PRODUCTION + CRON_SECRET set — a MISSING secret is refused", () => {
  const out = authorizeCronRequest({ secret: SECRET, nodeEnv: "production", header: () => null });
  assert.equal(out.authorized, false);
  assert.equal(out.reason, CRON_AUTH.DENY_BAD_SECRET);
});

test("PRODUCTION + CRON_SECRET set — an INCORRECT secret is refused in all three carriers", () => {
  for (const headers of [
    { authorization: "Bearer wrong" },
    { "x-cron-secret": "wrong" },
  ]) {
    const out = authorizeCronRequest({
      secret: SECRET,
      nodeEnv: "production",
      header: (n) => req(headers).headers.get(n),
    });
    assert.equal(out.authorized, false, `${JSON.stringify(headers)} must be refused`);
    assert.equal(out.reason, CRON_AUTH.DENY_BAD_SECRET);
  }
  const viaQuery = authorizeCronRequest({
    secret: SECRET,
    nodeEnv: "production",
    header: () => null,
    querySecret: "wrong",
  });
  assert.equal(viaQuery.authorized, false);
});

// ---------------------------------------------------------------------------
// The paths that must keep working.
// ---------------------------------------------------------------------------

test("PRODUCTION + the correct secret — accepted via bearer, header, or query", () => {
  const cases = [
    { headers: { authorization: `Bearer ${SECRET}` }, query: null },
    { headers: { "x-cron-secret": SECRET }, query: null },
    { headers: {}, query: SECRET },
  ];
  for (const c of cases) {
    const out = authorizeCronRequest({
      secret: SECRET,
      nodeEnv: "production",
      header: (n) => req(c.headers).headers.get(n),
      querySecret: c.query,
    });
    assert.equal(out.authorized, true, JSON.stringify(c));
    assert.equal(out.reason, CRON_AUTH.OK_SECRET);
  }
});

test("DEV + no CRON_SECRET — still allowed, so local dev and self-continue keep working", () => {
  // R0.1.13 removed `undefined` from this list. It used to sit here asserting
  // that an environment which never declared NODE_ENV may run an uncredentialed
  // worker — i.e. this test PINNED the fail-open. An environment must now say
  // what it is out loud to earn the dev allowance; the R0.1.13 block below pins
  // the silence case as a DENY. "local" stands in for any declared
  // non-production value, so this stays a rule and not a whitelist.
  for (const nodeEnv of ["development", "test", "local"]) {
    const out = authorizeCronRequest({ secret: "", nodeEnv, header: () => null });
    assert.equal(out.authorized, true, `NODE_ENV=${nodeEnv}`);
    assert.equal(out.reason, CRON_AUTH.OK_DEV_NO_SECRET);
  }
});

test("isCronAuthorized - the route wrapper returns 'deny' for production with no secret", () => {
  const warned = { value: false };
  const authorized = isCronAuthorized(req(), qs(), {
    label: "worker",
    warned,
    env: { NODE_ENV: "production" },
    logger: silent,
  });
  assert.equal(authorized, false);
  assert.equal(warned.value, false, "the dev warn-once must not fire on the production deny path");
});

test("isCronAuthorized - the dev warning fires exactly once per route", () => {
  const warned = { value: false };
  let warnings = 0;
  const logger = { warn: () => warnings++, error: () => {} };
  const ctx = { label: "worker", warned, env: { NODE_ENV: "development" }, logger };
  assert.equal(isCronAuthorized(req(), qs(), ctx), true);
  assert.equal(isCronAuthorized(req(), qs(), ctx), true);
  assert.equal(warnings, 1);
});

test("isCronAuthorized - reads the ?secret= query parameter", () => {
  const authorized = isCronAuthorized(req(), qs({ secret: SECRET }), {
    label: "worker",
    warned: { value: false },
    env: { NODE_ENV: "production", CRON_SECRET: SECRET },
    logger: silent,
  });
  assert.equal(authorized, true);
});

// ---------------------------------------------------------------------------
// R0.1.13 — the gate must not fail OPEN when NODE_ENV is absent or blank.
//
// `nodeEnv === "production"` scored an undeclared environment as non-prod and
// handed back OK_DEV_NO_SECRET: an unauthenticated worker route that spends
// real Bright Data / Perplexity / model budget, and genuinely reachable
// because isCronAuthorized reads env.NODE_ENV off a DYNAMIC binding at
// runtime (unlike the operator perimeter, whose value Next inlines at build
// time). Every case below returns authorized:true if the fallback is removed.
// ---------------------------------------------------------------------------

/** The three shapes of "this environment will not say what it is". */
const UNDECLARED_ENVS = [
  ["unset", undefined],
  ["blank", ""],
  ["whitespace", "   "],
];

test("UNDECLARED NODE_ENV + no CRON_SECRET — REFUSED, not waved through as dev", () => {
  for (const [label, nodeEnv] of UNDECLARED_ENVS) {
    const out = authorizeCronRequest({ secret: undefined, nodeEnv, header: () => null });
    assert.equal(
      out.authorized,
      false,
      `NODE_ENV ${label} must NOT authorise an uncredentialed worker call`
    );
    assert.equal(
      out.reason,
      CRON_AUTH.DENY_NO_SECRET_IN_PRODUCTION,
      `NODE_ENV ${label} must resolve to production, not to the dev allowance`
    );
  }
});

test("UNDECLARED NODE_ENV — a whitespace-only CRON_SECRET does not rescue it either", () => {
  for (const [label, nodeEnv] of UNDECLARED_ENVS) {
    const out = authorizeCronRequest({ secret: "   ", nodeEnv, header: () => null });
    assert.equal(out.authorized, false, `NODE_ENV ${label} + blank secret`);
    assert.equal(out.reason, CRON_AUTH.DENY_NO_SECRET_IN_PRODUCTION);
  }
});

test("UNDECLARED NODE_ENV — the ROUTE WRAPPER refuses too, and says so out loud", () => {
  // The pure gate is only half the reachability story: both worker routes call
  // isCronAuthorized with no `env`, so this is the shape a real deploy hits.
  const envs = [
    ["key absent from env entirely", {}],
    ["NODE_ENV=''", { NODE_ENV: "" }],
    ["NODE_ENV='   '", { NODE_ENV: "   " }],
  ];
  for (const [label, env] of envs) {
    const warned = { value: false };
    const errors = [];
    const authorized = isCronAuthorized(req(), qs(), {
      label: "worker",
      warned,
      env,
      logger: {
        warn: () => assert.fail(`${label} took the dev warn path — it was allowed`),
        error: (m) => errors.push(m),
      },
    });
    assert.equal(authorized, false, `${label} must be refused`);
    assert.equal(warned.value, false, "the dev warn-once must not fire on a deny");
    assert.equal(errors.length, 1, `${label} must not refuse silently`);
    assert.match(errors[0], /REFUS/i);
    // A silent deny is as hard to operate as a silent allow: the message must
    // name NODE_ENV as the reason, or the operator hunts CRON_SECRET in an
    // environment where NODE_ENV is the actual problem.
    assert.match(
      errors[0],
      /NODE_ENV/,
      `${label}: the log must name why this counted as production`
    );
  }
});

test("UNDECLARED NODE_ENV + a VALID secret — still authorised (the fix must not lock cron out)", () => {
  // Failing closed on an undeclared env must not break Vercel's own scheduled
  // invocation, which authenticates with the bearer secret.
  for (const [label, nodeEnv] of UNDECLARED_ENVS) {
    const out = authorizeCronRequest({
      secret: SECRET,
      nodeEnv,
      header: (n) => req({ authorization: `Bearer ${SECRET}` }).headers.get(n),
    });
    assert.equal(out.authorized, true, `NODE_ENV ${label} + correct bearer must still pass`);
    assert.equal(out.reason, CRON_AUTH.OK_SECRET);
  }
});

test("R0.1.13 — production is decided by the SHARED resolveNodeEnv, not a second local copy", async () => {
  // Two gates each deciding "am I production?" their own way is how
  // operatorPerimeter and cronAuth would drift back apart. cronAuth imports the
  // perimeter's resolver; this pins the import and the agreement.
  const { readFile } = await import("node:fs/promises");
  const src = await readFile(new URL("./cronAuth.js", import.meta.url), "utf8");
  assert.match(
    src,
    /import \{ resolveNodeEnv \} from "\.\/operatorPerimeter\.js"/,
    "cronAuth must reuse operatorPerimeter's resolveNodeEnv, not fork it"
  );
  // Strip comments first — the fix DESCRIBES the old shape in a comment, and a
  // naive scan of the raw file would match that prose instead of live code.
  const code = src
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join("\n");
  assert.doesNotMatch(
    code,
    /nodeEnv === "production"/,
    "the bare equality check is the fail-open shape R0.1.13 removed"
  );
  const { resolveNodeEnv } = await import("./operatorPerimeter.js");
  for (const [label, nodeEnv] of UNDECLARED_ENVS) {
    assert.equal(resolveNodeEnv({ NODE_ENV: nodeEnv }), "production", label);
  }
  assert.equal(resolveNodeEnv({ NODE_ENV: "development" }), "development");
});

test("R0.1.13 must not have cost the dev warn-once (the good example R0.1.14 was filed against)", () => {
  // cronAuth WARNS on the no-secret dev allowance; the operator perimeter does
  // not, which is why R0.1.14 exists. Hardening this gate must not quietly
  // delete the one warning that works.
  const warned = { value: false };
  const warnings = [];
  const ctx = {
    label: "worker",
    warned,
    env: { NODE_ENV: "development" },
    logger: { warn: (m) => warnings.push(m), error: () => assert.fail("explicit dev must not deny") },
  };
  assert.equal(isCronAuthorized(req(), qs(), ctx), true, "explicit development must still allow");
  assert.equal(isCronAuthorized(req(), qs(), ctx), true);
  assert.equal(warnings.length, 1, "still exactly one warning per route");
  assert.match(warnings[0], /UNAUTHENTICATED/);
});

// ---------------------------------------------------------------------------
// Guard: both worker routes must use the shared gate, not a private copy.
// ---------------------------------------------------------------------------

test("GUARD — both worker routes delegate to the shared gate", async () => {
  const { readFile } = await import("node:fs/promises");
  const roots = ["src/app/api/scan/worker/route.js", "src/app/api/content/worker/route.js"];
  for (const rel of roots) {
    const src = await readFile(new URL(`../../${rel}`, import.meta.url), "utf8");
    assert.match(src, /isCronAuthorized/, `${rel} must call the shared gate`);
    assert.doesNotMatch(
      src,
      /const secret = \(process\.env\.CRON_SECRET \|\| ""\)\.trim\(\);/,
      `${rel} still carries a private copy of the gate — that is how the two drifted apart`
    );
  }
});
