/**
 * R3.1.10 — the self-continue mechanism, parameterised by worker route.
 *
 * A background worker on a serverless host gets ONE function lifetime per
 * invocation. A pipeline longer than that lifetime therefore advances exactly
 * one lifetime per external tick, and if the only external tick is a daily
 * cron, a five-stage pipeline needs five days. The scan pipeline solved this
 * in R3.1.5/R3.1.6: a chunk that hits a soft time budget persists a
 * checkpoint, fires a fire-and-forget request back at its OWN route naming the
 * job, and returns without waiting. The next invocation picks up where the
 * checkpoint left off, and the whole job advances at machine speed instead of
 * cron speed.
 *
 * This module is that mechanism with the route path lifted out, so the content
 * worker can use it without copying it. `src/lib/workers/scanWorker.js` still
 * carries its own copy (resolveSelfContinueUrl / buildSelfContinueInit /
 * defaultSelfContinue); migrating it onto this module is a follow-up — it was
 * held by another worker when this landed and could not be edited here.
 *
 * CORRECTNESS NEVER DEPENDS ON THE SELF-CONTINUE. It is an optimisation: if
 * the fetch is refused, mis-addressed, or never sent, the job is still
 * checkpointed and still rescuable by the cron sweep one heartbeat window
 * later. That is why every failure below is a warning and not a throw — but it
 * IS a warning, every time, because a self-continue that silently never
 * arrives is exactly the "code path that quietly did nothing" the standing
 * rules forbid.
 */

import { keepAlive } from "./keepAlive.js";

/**
 * How long a handing-off invocation keeps its instance alive for the outgoing
 * request to leave. Waiting for the RESPONSE would bill this invocation for
 * the whole next chunk; not waiting at all let a freeze drop the request
 * unsent. Same value and same reasoning as scanWorker's SELF_CONTINUE_HOLD_MS.
 */
export const SELF_CONTINUE_HOLD_MS = 5000;

/**
 * R3.1.13 — on a PRODUCTION deployment, the base URL a worker calls itself on
 * must be the production alias (`VERCEL_PROJECT_PRODUCTION_URL`, e.g.
 * `aeo-vis.vercel.app`), never the per-deployment URL in `VERCEL_URL`.
 *
 * Observed 2026-09-18 against the live project: the deployment URL answers
 * `302 -> vercel.com/sso-api` (Vercel Authentication, "all except custom
 * domains"), while the production alias reaches the route and answers its own
 * `401` to an unauthenticated call. With no Protection Bypass secret created on
 * the project, every self-continue aimed at `VERCEL_URL` died at the SSO wall
 * and the job waited for the daily cron — which is exactly the failure R3.1.6
 * and R3.1.10 were built to remove. `VERCEL_PROJECT_PRODUCTION_URL` is a system
 * variable Vercel injects into every deployment, so this needs no operator
 * action. It is honoured only when `VERCEL_ENV === "production"`: a preview
 * deployment must not hand its job to the production code.
 *
 * @param {object} env
 * @returns {string} an `https://` base, or "" when not on a production deployment
 */
export function productionAliasBase(env = process.env) {
  if (env.VERCEL_ENV !== "production") return "";
  const host = (env.VERCEL_PROJECT_PRODUCTION_URL || "").trim();
  return host ? `https://${host}` : "";
}

/**
 * Best-effort absolute URL for a worker route to call itself on.
 *
 * Identical resolution order to scanWorker's copy: NEXT_PUBLIC_APP_URL, then
 * the production alias (production deployments only, see productionAliasBase),
 * then the Vercel deployment URL, then localhost. The localhost fallback means this
 * effectively always resolves; the null guard stays so a caller passing a
 * stripped env object gets an explicit "no" rather than a malformed URL, and
 * makeSelfContinue below warns instead of failing silently in that case.
 *
 * @param {string} routePath e.g. "/api/content/worker"
 * @param {string} jobId
 * @param {object} [env]
 */
export function resolveSelfContinueUrl(routePath, jobId, env = process.env) {
  const base =
    env.NEXT_PUBLIC_APP_URL ||
    productionAliasBase(env) ||
    (env.VERCEL_URL ? `https://${env.VERCEL_URL}` : "") ||
    `http://localhost:${env.PORT || 3000}`;
  if (!base) return null;
  return `${base.replace(/\/$/, "")}${routePath}?job_id=${encodeURIComponent(jobId)}`;
}

/**
 * The headers the self-continue request must carry, and why each one exists.
 *
 * TWO DIFFERENT GATES, and only one of them is this app's:
 *  - `x-cron-secret` authenticates to the WORKER ROUTE (src/lib/cronAuth.js,
 *    shared by /api/scan/worker and /api/content/worker). Without it the route
 *    answers 401 and the job stops advancing.
 *  - `x-vercel-protection-bypass` gets PAST DEPLOYMENT PROTECTION, which sits
 *    in FRONT of the function. R3.1.6: with Vercel Authentication on, a
 *    self-fetch to the deployment URL is answered by an SSO redirect and the
 *    next chunk never starts — observed in production 2026-09-15. The cron
 *    secret cannot help there: the request never reaches the route that reads
 *    it. Vercel injects VERCEL_AUTOMATION_BYPASS_SECRET into the deployment
 *    once "Protection Bypass for Automation" is enabled on the project; it is
 *    a platform toggle, NOT an operator-set variable, which is why it is
 *    absent from .env.example.
 *
 * Returns `{ init, missingBypass }`. `missingBypass` is true only where it is
 * a real risk — on Vercel, with no bypass secret — so the caller can say so
 * once instead of this function guessing about local dev.
 *
 * @param {object} [env]
 */
export function buildSelfContinueInit(env = process.env) {
  const headers = {};
  const secret = (env.CRON_SECRET || "").trim();
  if (secret) headers["x-cron-secret"] = secret;
  const bypass = (env.VERCEL_AUTOMATION_BYPASS_SECRET || "").trim();
  if (bypass) headers["x-vercel-protection-bypass"] = bypass;
  return {
    init: Object.keys(headers).length ? { headers } : undefined,
    missingBypass: !bypass && !!env.VERCEL,
  };
}

/** Report HTTP refusals without logging URLs, credentials or response bodies. */
export function warnSelfContinueResponse(response, { label, jobId, logger = console } = {}) {
  if (response?.ok === false) {
    logger.warn(
      `[${label}] self-continue for job ${jobId} was refused with HTTP ${response.status} ` +
        `(the cron sweep will still pick it up). Check worker authentication, deployment ` +
        `protection and the target origin. Redirects are not followed.`
    );
  }
}

/**
 * Build the fire-and-forget self-continue function for one worker route.
 *
 * @param {object} opts
 * @param {string} opts.routePath the worker route that accepts `?job_id=`
 * @param {string} opts.label log prefix, e.g. "content-worker"
 * @param {typeof fetch} [opts.fetchImpl] injected by tests
 * @param {typeof keepAlive} [opts.keepAliveImpl] injected by tests
 * @param {object} [opts.env] injected by tests
 * @param {{warn: Function}} [opts.logger]
 * @returns {(jobId: string) => {fired: boolean, reason: string|null}}
 */
export function makeSelfContinue({
  routePath,
  label,
  fetchImpl,
  keepAliveImpl,
  env,
  logger = console,
} = {}) {
  return function selfContinue(jobId) {
    const environment = env || process.env;
    const doFetch = fetchImpl || fetch;
    const hold = keepAliveImpl || keepAlive;

    const url = resolveSelfContinueUrl(routePath, jobId, environment);
    if (!url) {
      // Not silent: a job that will now wait for the cron has to say so.
      logger.warn(
        `[${label}] self-continue for job ${jobId} was NOT sent — no base URL resolved ` +
          `(NEXT_PUBLIC_APP_URL / VERCEL_URL / PORT all empty). The job is checkpointed and ` +
          `advances on the next cron sweep instead.`
      );
      return { fired: false, reason: "no_url" };
    }

    const { init, missingBypass } = buildSelfContinueInit(environment);
    if (missingBypass) {
      logger.warn(
        `[${label}] self-continue for job ${jobId} is going out WITHOUT a protection bypass ` +
          `(VERCEL_AUTOMATION_BYPASS_SECRET is unset). If Deployment Protection is on, this request is ` +
          `refused before it reaches the worker and the job advances only on a cron rescue.`
      );
    }

    try {
      hold(
        Promise.resolve(doFetch(url, { ...init, redirect: "manual" }))
          .then((response) => warnSelfContinueResponse(response, { label, jobId, logger }))
          .catch((err) => {
            logger.warn(
              `[${label}] self-continue fetch failed for job ${jobId} ` +
                `(the cron sweep will still pick it up): ${err.message}`
            );
          }),
        { label: `[${label}] self-continue for job ${jobId}`, maxMs: SELF_CONTINUE_HOLD_MS }
      );
    } catch (err) {
      logger.warn(
        `[${label}] self-continue fetch could not be started for job ${jobId} ` +
          `(the cron sweep will still pick it up): ${err.message}`
      );
      return { fired: false, reason: "fetch_start_failed" };
    }

    return { fired: true, reason: null };
  };
}
