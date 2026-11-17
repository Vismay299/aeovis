/**
 * R0.1.17 — nothing detected a NODE_ENV that lies (finding C9).
 *
 * REPRODUCED against this branch before the fix, by calling the real gates:
 *
 *   authorizeCronRequest({ secret: undefined, nodeEnv: "development" })
 *     -> { authorized: TRUE, reason: "ok_dev_no_secret" }
 *   authorizeOperatorRequest({ ..., operatorToken: "",
 *                              nodeEnv: resolveNodeEnv({ NODE_ENV: "development",
 *                                                        VERCEL_ENV: "production" }) })
 *     -> { allow: TRUE, reason: "allow_dev_no_token" }
 *
 * On a real Vercel production deployment with NODE_ENV overridden to
 * development, that is an unauthenticated worker endpoint that spends vendor
 * budget and an unauthenticated operator API — disclosed by one console.warn
 * per process and nothing else. `rg VERCEL_ENV src/` returned only VERCEL_URL
 * hits in rateLimit/scanWorker: the one signal that catches the lie was
 * consulted nowhere.
 *
 * The rule these tests pin: whichever of NODE_ENV and VERCEL_ENV is more
 * dangerous wins, the disagreement is REPORTED rather than silently resolved,
 * and "we could not cross-check" is a third state, not a pass.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  assessEnvTruth,
  authorizeOperatorRequest,
  resolveNodeEnv,
  ENV_TRUTH,
  PERIMETER,
} from "./operatorPerimeter.js";
import { authorizeCronRequest, isCronAuthorized, CRON_AUTH } from "./cronAuth.js";
import { buildHealthPayload, VENDORS } from "./health.js";

const noHeaders = () => null;

// ---------------------------------------------------------------------------
// The disagreement itself.
// ---------------------------------------------------------------------------

test("R0.1.17 — VERCEL_ENV=production + NODE_ENV=development is a DISAGREEMENT, resolved as production", () => {
  for (const lie of ["development", "test", "staging", "preview", "dev"]) {
    const truth = assessEnvTruth({ NODE_ENV: lie, VERCEL_ENV: "production" });
    assert.equal(truth.verdict, ENV_TRUTH.PRODUCTION_CLAIMS_NON_PRODUCTION, lie);
    assert.equal(truth.disagrees, true, lie);
    assert.equal(truth.effective, "production", `${lie} must not relax any gate`);
    assert.equal(truth.declaredNodeEnv, lie, "the claim is reported, not erased");
    assert.equal(truth.platformEnv, "production");
    assert.match(truth.detail, /VERCEL_ENV=production/);
    assert.match(truth.detail, new RegExp(`NODE_ENV=${lie}`));
  }
});

test("R0.1.17 — VERCEL_ENV is normalised, not string-matched by luck", () => {
  const truth = assessEnvTruth({ NODE_ENV: "development", VERCEL_ENV: "  PRODUCTION  " });
  assert.equal(truth.disagrees, true, "casing and padding must not launder a production platform");
  assert.equal(truth.effective, "production");
});

test("R0.1.17 — agreement is agreement, and preview builds are NOT flagged", () => {
  // NODE_ENV=production on a preview deployment is what every `next build`
  // produces. Flagging it would mark every preview degraded and teach the
  // operator to ignore the field.
  const preview = assessEnvTruth({ NODE_ENV: "production", VERCEL_ENV: "preview" });
  assert.equal(preview.verdict, ENV_TRUTH.AGREED);
  assert.equal(preview.disagrees, false);
  assert.equal(preview.effective, "production");

  const prod = assessEnvTruth({ NODE_ENV: "production", VERCEL_ENV: "production" });
  assert.equal(prod.verdict, ENV_TRUTH.AGREED);
  assert.equal(prod.effective, "production");

  const local = assessEnvTruth({ NODE_ENV: "development", VERCEL_ENV: "development" });
  assert.equal(local.verdict, ENV_TRUTH.AGREED);
  assert.equal(local.effective, "development", "`vercel dev` must stay open, as before");
});

test("R0.1.17 — 'no VERCEL_ENV' is UNAUDITED, a distinct state from a check that passed", () => {
  // Standing rule 1: a cross-check that never ran must not render as one that
  // ran and passed.
  for (const env of [{ NODE_ENV: "development" }, { NODE_ENV: "development", VERCEL_ENV: "" }]) {
    const truth = assessEnvTruth(env);
    assert.equal(truth.verdict, ENV_TRUTH.UNAUDITED);
    assert.notEqual(truth.verdict, ENV_TRUTH.AGREED);
    assert.equal(truth.platformEnv, null);
    assert.equal(truth.disagrees, false);
    assert.equal(truth.effective, "development", "local dev must not become production");
    assert.match(truth.detail, /not cross-checked/);
  }
  // A VERCEL_ENV that is set but is not one of Vercel's three values cannot
  // adjudicate anything, and says so rather than passing for agreement.
  const odd = assessEnvTruth({ NODE_ENV: "development", VERCEL_ENV: "prod" });
  assert.equal(odd.verdict, ENV_TRUTH.PLATFORM_UNRECOGNISED);
  assert.equal(odd.disagrees, false);
  assert.equal(odd.effective, "development");
});

test("R0.1.17 — the undeclared-NODE_ENV rule from R0.1.3/R0.1.13 is unchanged", () => {
  for (const env of [undefined, null, {}, { NODE_ENV: "" }, { NODE_ENV: "   " }]) {
    assert.equal(resolveNodeEnv(env), "production", JSON.stringify(env));
    assert.equal(assessEnvTruth(env).declaredNodeEnv, null);
  }
  assert.equal(resolveNodeEnv({ NODE_ENV: "development" }), "development");
  assert.equal(resolveNodeEnv({ NODE_ENV: "test" }), "test");
});

test("R0.1.17 — a TRUTHY NON-STRING NODE_ENV no longer walks through as non-production", () => {
  // Inherited from R0.1.3's resolver: `String(env.NODE_ENV || "")` turned 5
  // into "5" and {} into "[object Object]", neither of which is "production",
  // so both relaxed every gate. Unreachable via process.env, whose values are
  // always strings — but resolveNodeEnv is exported and takes any object.
  for (const value of [5, true, {}, [], () => {}, null, Object("development")]) {
    assert.equal(
      resolveNodeEnv({ NODE_ENV: value }),
      "production",
      `a non-string NODE_ENV (${typeof value}) must fail closed, not be coerced`
    );
  }
  // ...and the same for the platform signal, so a non-string VERCEL_ENV cannot
  // be coerced into "production" either way round.
  assert.equal(assessEnvTruth({ NODE_ENV: "development", VERCEL_ENV: 1 }).verdict, ENV_TRUTH.UNAUDITED);
  assert.equal(assessEnvTruth({ NODE_ENV: "development", VERCEL_ENV: 1 }).effective, "development");
});

// ---------------------------------------------------------------------------
// THE ACCEPTANCE CRITERION, at the gates: refused, not warned.
// ---------------------------------------------------------------------------

test("R0.1.17 — the cron gate REFUSES a lying production deployment with no CRON_SECRET", () => {
  for (const secret of [undefined, "", "   "]) {
    const out = authorizeCronRequest({
      secret,
      nodeEnv: "development",
      vercelEnv: "production",
      header: noHeaders,
    });
    assert.equal(out.authorized, false, "this returned TRUE before R0.1.17");
    assert.equal(out.reason, CRON_AUTH.DENY_NO_SECRET_IN_PRODUCTION);
  }
});

test("R0.1.17 — the refusal NAMES VERCEL_ENV, so the operator does not hunt NODE_ENV", () => {
  const lines = [];
  const authorized = isCronAuthorized(
    { headers: { get: () => null } },
    new URLSearchParams(),
    {
      label: "scan-worker",
      warned: { value: false },
      env: { NODE_ENV: "development", VERCEL_ENV: "production" },
      logger: {
        warn: () => assert.fail("a refusal must not be logged as a dev allowance"),
        error: (m) => lines.push(m),
      },
    }
  );
  assert.equal(authorized, false);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /REFUSING/);
  assert.match(lines[0], /VERCEL_ENV=production/);
  assert.match(lines[0], /NODE_ENV=development/);
});

test("R0.1.17 — a lying production deployment does NOT relax the operator perimeter", () => {
  // middleware.js calls resolveNodeEnv(process.env) and passes the result
  // straight in, so hardening the resolver is what closes this route without
  // middleware.js changing. If resolveNodeEnv stops consulting VERCEL_ENV,
  // this goes green-to-red immediately.
  const decision = authorizeOperatorRequest({
    method: "POST",
    pathname: "/api/content",
    operatorToken: "",
    nodeEnv: resolveNodeEnv({ NODE_ENV: "development", VERCEL_ENV: "production" }),
    header: noHeaders,
  });
  assert.equal(decision.allow, false, "this returned ALLOW before R0.1.17");
  assert.equal(decision.reason, PERIMETER.DENY_NO_TOKEN_CONFIGURED);
});

test("R0.1.17 — the fix must not lock out a correctly configured deployment", () => {
  // A lying NODE_ENV plus a valid secret is a misconfiguration, not an
  // intrusion: denying it would stall every scan on a live deployment.
  const withSecret = authorizeCronRequest({
    secret: "s3cr3t",
    nodeEnv: "development",
    vercelEnv: "production",
    header: (n) => (n === "authorization" ? "Bearer s3cr3t" : null),
  });
  assert.equal(withSecret.authorized, true);
  assert.equal(withSecret.reason, CRON_AUTH.OK_SECRET);

  // And genuine local dev, where VERCEL_ENV does not exist, is untouched.
  const local = authorizeCronRequest({ secret: undefined, nodeEnv: "development", header: noHeaders });
  assert.equal(local.authorized, true);
  assert.equal(local.reason, CRON_AUTH.OK_DEV_NO_SECRET);
});

// ---------------------------------------------------------------------------
// ...and on the health surface, because a refusal in a request log is not a
// surface an operator ever looks at.
// ---------------------------------------------------------------------------

const okDb = { ok: true, latency_ms: 3, error: null };
const NOW = "2026-09-08T00:00:00.000Z";
// Every vendor credential present, so the ONLY thing that can move `status`
// below is the environment cross-check. Without this the "degraded" assertion
// would pass on missing_required and prove nothing.
const FULL_ENV = Object.fromEntries(VENDORS.flatMap((v) => v.env.map((n) => [n, "set"])));
const health = (env) =>
  buildHealthPayload({ db: okDb, env: { ...FULL_ENV, ...env }, ticks: [], now: NOW });

test("R0.1.17 — /api/health reports the disagreement and DEGRADES on it", () => {
  const payload = health({ NODE_ENV: "development", VERCEL_ENV: "production" });
  assert.equal(payload.environment.node_env, "development");
  assert.equal(payload.environment.vercel_env, "production");
  assert.equal(payload.environment.effective, "production");
  assert.equal(payload.environment.agrees, false);
  assert.equal(payload.environment.verdict, ENV_TRUTH.PRODUCTION_CLAIMS_NON_PRODUCTION);
  assert.match(payload.environment.detail, /VERCEL_ENV=production/);
  assert.equal(payload.status, "degraded", "an environment that lies must not read as ok");
});

test("R0.1.17 — health's `agrees` is tri-state: false is a lie, null is no cross-check", () => {
  const audited = health({ NODE_ENV: "production", VERCEL_ENV: "production" });
  assert.equal(audited.environment.agrees, true);
  assert.equal(audited.environment.verdict, ENV_TRUTH.AGREED);

  const unaudited = health({ NODE_ENV: "development" });
  assert.equal(
    unaudited.environment.agrees,
    null,
    "no VERCEL_ENV means the check never ran; null, never true, never `?? false`"
  );
  assert.equal(unaudited.environment.vercel_env, null);
  assert.equal(unaudited.environment.verdict, ENV_TRUTH.UNAUDITED);

  const nothing = health({});
  assert.equal(nothing.environment.node_env, null, "an undeclared NODE_ENV renders null, not ''");
  assert.equal(nothing.environment.effective, "production");
});

test("R0.1.17 — a healthy deployment is still `ok`, and `down` still outranks the disagreement", () => {
  const fine = health({ NODE_ENV: "production", VERCEL_ENV: "production" });
  assert.equal(fine.status, "ok", "the new check must not degrade every deployment");
  assert.deepEqual(fine.missing_required, [], "and the ok above is not luck");

  const down = buildHealthPayload({
    db: { ok: false, latency_ms: null, error: "unreachable" },
    env: { ...FULL_ENV, NODE_ENV: "development", VERCEL_ENV: "production" },
    ticks: [],
    now: NOW,
  });
  assert.equal(down.status, "down", "a dead database is worse news than a mislabelled env");
});

// ---------------------------------------------------------------------------
// Guards: the wiring is the fix. A gate that computes the truth and then does
// not pass it on is the shape this task exists to close.
// ---------------------------------------------------------------------------

test("GUARD — cronAuth hands VERCEL_ENV to the resolver, and health imports the shared verdict", async () => {
  const { readFile } = await import("node:fs/promises");
  const stripComments = (src) =>
    src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  const cron = stripComments(await readFile(new URL("./cronAuth.js", import.meta.url), "utf8"));
  assert.match(
    cron,
    /VERCEL_ENV:\s*vercelEnv/,
    "authorizeCronRequest must pass VERCEL_ENV to resolveNodeEnv — dropping it reopens C9"
  );
  assert.match(
    cron,
    /vercelEnv:\s*env\.VERCEL_ENV/,
    "isCronAuthorized must read VERCEL_ENV off the runtime env, or the gate never sees it"
  );

  const healthSrc = stripComments(await readFile(new URL("./health.js", import.meta.url), "utf8"));
  assert.match(
    healthSrc,
    /import \{ assessEnvTruth, ENV_TRUTH \} from "\.\/operatorPerimeter\.js"/,
    "health must reuse the perimeter's verdict, not compute a second opinion"
  );
});
