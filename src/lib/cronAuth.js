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
 * Pure — no next/server import — so both routes share one implementation and
 * every branch is unit-testable without a running server.
 */

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
 * @param {(name: string) => string|null} args.header case-insensitive header getter
 * @param {string|null} [args.querySecret] the `?secret=` query parameter
 * @returns {{authorized: boolean, reason: string}}
 */
export function authorizeCronRequest({ secret, nodeEnv, header, querySecret = null }) {
  const configured = String(secret || "").trim();
  const isProduction = nodeEnv === "production";

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
    logger.error(
      `[${ctx.label}] REFUSING a worker request: CRON_SECRET is not set in production. ` +
        `Set it in the deployment's environment — this endpoint spends real vendor budget.`
    );
  }
  return authorized;
}
