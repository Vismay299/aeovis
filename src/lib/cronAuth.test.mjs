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
  for (const nodeEnv of ["development", "test", undefined]) {
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
