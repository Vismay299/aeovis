/**
 * The cron/worker perimeter, extracted so it can be tested and so the two
 * worker routes cannot drift apart.
 *
 * Finding C9: both /api/scan/worker and /api/content/worker carried their own
 * copy of `isAuthorized`, and both FAILED OPEN — with CRON_SECRET unset the
 * gate logged a warning once and then returned true. In production that is an
 * unauthenticated endpoint that resumes arbitrary scan jobs and, with
 * `?batch=1` / the scheduler tick, CREATES new ones, each spending real Bright
 * Data, Perplexity and model budget. A warning nobody reads is not a control.
 *
 * The rule now: outside production a missing secret still allows the call (so
 * local dev and the self-continue fetch work out of the box) and warns; in
 * production a missing secret DENIES. Fail closed where it costs money.
 *
 * "Production" is decided by BOTH NODE_ENV and VERCEL_ENV (R0.1.17). A
 * deployment can claim NODE_ENV=development; it cannot claim its way out of
 * VERCEL_ENV=production, which Vercel sets and a project env var cannot
 * override. Whichever of the two is more dangerous wins.
 *
 * Pure — no next/server import — so both routes share one implementation and
 * every branch is unit-testable without a running server.
 */

import { assessEnvTruth, resolveNodeEnv } from "./operatorPerimeter.js";

/** Why a request was allowed or refused. Returned, not just logged. */
export const CRON_AUTH = Object.freeze({
  OK_SECRET: "ok_secret",
  OK_DEV_NO_SECRET: "ok_dev_no_secret",
  DENY_NO_SECRET_IN_PRODUCTION: "deny_no_secret_in_production",
  DENY_BAD_SECRET: "deny_bad_secret",
});

/**
 * @param {object} args
 * @param {string|undefined} args.secret   process.env.CRON_SECRET
 * @param {string|undefined} args.nodeEnv  process.env.NODE_ENV
 * @param {string|undefined} [args.vercelEnv] process.env.VERCEL_ENV
 * @param {(name: string) => string|null} args.header case-insensitive header getter
 * @param {string|null} [args.querySecret] the `?secret=` query parameter
 * @returns {{authorized: boolean, reason: string}}
 */
export function authorizeCronRequest({
  secret,
  nodeEnv,
  vercelEnv,
  header,
  querySecret = null,
}) {
  const configured = String(secret || "").trim();
  // R0.1.13. This used to be `nodeEnv === "production"`, which meant a
  // deployment whose NODE_ENV was absent, blank or whitespace scored as NOT
  // production and fell straight through to OK_DEV_NO_SECRET — the very
  // unauthenticated, budget-spending worker endpoint this module exists to
  // close (C9), reopened by an environment variable nobody set. Unlike the
  // operator perimeter, whose NODE_ENV Next inlines at build time,
  // isCronAuthorized below reads env.NODE_ENV off a dynamic binding, so an
  // environment that never sets the key reaches this line at RUNTIME.
  //
  // resolveNodeEnv is IMPORTED from operatorPerimeter.js, not copied: R0.1.3
  // hardened the identical shape there, and a second local copy is precisely
  // how two gates drift into disagreeing about what "production" means. It
  // takes an env-shaped object while this gate is handed the bare string,
  // hence the two-key wrapper. An environment that will not say what it is
  // gets treated as the dangerous one.
  //
  // R0.1.17 adds VERCEL_ENV to that wrapper. R0.1.13 only closed the ABSENT
  // NODE_ENV; a deployment with NODE_ENV explicitly set to "development" and no
  // CRON_SECRET still fell through to OK_DEV_NO_SECRET, on real production
  // infrastructure, disclosed by nothing louder than one console.warn. Vercel
  // sets VERCEL_ENV on every deployment and a project env var cannot override
  // it, so it is the signal that catches the lie. Dropping vercelEnv from this
  // call reopens exactly that hole.
  const isProduction =
    resolveNodeEnv({ NODE_ENV: nodeEnv, VERCEL_ENV: vercelEnv }) === "production";

  if (!configured) {
    // THE FLIP (C9). This branch used to `return true` unconditionally.
    if (isProduction) {
      return { authorized: false, reason: CRON_AUTH.DENY_NO_SECRET_IN_PRODUCTION };
    }
    return { authorized: true, reason: CRON_AUTH.OK_DEV_NO_SECRET };
  }

  // No `x-vercel-cron` branch (R0.1.8, finding C9). That header is a plain
  // request header any client can set, so accepting it bypassed the very
  // secret the operator configured. The secret is now the ONLY credential:
  // Vercel attaches `Authorization: Bearer <CRON_SECRET>` to its own cron
  // invocations when CRON_SECRET is set on the project, which the bearer
  // branch below already accepts. An `x-vercel-cron` header is simply
  // ignored — present or not, the request stands or falls on the secret.
  if ((header("authorization") || "") === `Bearer ${configured}`) {
    return { authorized: true, reason: CRON_AUTH.OK_SECRET };
  }
  if (header("x-cron-secret") === configured) {
    return { authorized: true, reason: CRON_AUTH.OK_SECRET };
  }
  if (querySecret === configured) {
    return { authorized: true, reason: CRON_AUTH.OK_SECRET };
  }

  return { authorized: false, reason: CRON_AUTH.DENY_BAD_SECRET };
}

/**
 * Say precisely HOW an environment declined to declare itself. "blank" for a
 * value that is neither unset nor a real string would be its own small lie, and
 * the operator reading this line is already looking for the wrong thing.
 */
function describeUndeclared(value) {
  if (value === undefined) return "unset";
  if (typeof value === "string") return "blank";
  return `not a string (${value === null ? "null" : typeof value})`;
}

/**
 * Route-facing wrapper: reads env and the Request, and warns ONCE per process
 * on the dev no-secret path. `warned` is per-route so each route still gets
 * its own single warning, exactly as before.
 *
 * @param {Request} request
 * @param {URLSearchParams} searchParams
 * @param {{label: string, warned: {value: boolean}, env?: object, logger?: object}} ctx
 */
export function isCronAuthorized(request, searchParams, ctx) {
  const env = ctx.env || process.env;
  const logger = ctx.logger || console;
  const { authorized, reason } = authorizeCronRequest({
    secret: env.CRON_SECRET,
    nodeEnv: env.NODE_ENV,
    // Read off the same dynamic binding as NODE_ENV. Next only inlines the
    // literal `process.env.NODE_ENV` and NEXT_PUBLIC_*, so this arrives from
    // the runtime environment, which is the whole point of consulting it.
    vercelEnv: env.VERCEL_ENV,
    header: (name) => request.headers.get(name),
    querySecret: searchParams.get("secret"),
  });

  if (reason === CRON_AUTH.OK_DEV_NO_SECRET && !ctx.warned.value) {
    ctx.warned.value = true;
    logger.warn(
      `[${ctx.label}] CRON_SECRET is not set — this endpoint is UNAUTHENTICATED in ` +
        `NODE_ENV=${env.NODE_ENV || "undefined"}. It is refused outright in production.`
    );
  }
  if (reason === CRON_AUTH.DENY_NO_SECRET_IN_PRODUCTION) {
    // Name WHY this counted as production. With NODE_ENV absent or blank the
    // bare "in production" reads as a lie to an operator who never set
    // NODE_ENV=production, and sends them hunting the wrong bug. Same for the
    // R0.1.17 case, where the operator DID set NODE_ENV=development and needs
    // to be told that VERCEL_ENV, not NODE_ENV, decided this.
    const truth = assessEnvTruth({ NODE_ENV: env.NODE_ENV, VERCEL_ENV: env.VERCEL_ENV });
    const because = truth.disagrees
      ? `— ${truth.detail}`
      : truth.declaredNodeEnv
        ? "in production"
        : `because NODE_ENV is ${describeUndeclared(env.NODE_ENV)} and an ` +
          `environment that will not say what it is is treated as production (R0.1.13)`;
    logger.error(
      `[${ctx.label}] REFUSING a worker request: CRON_SECRET is not set ${because}. ` +
        `Set it in the deployment's environment — this endpoint spends real vendor budget.`
    );
  }
  return authorized;
}
