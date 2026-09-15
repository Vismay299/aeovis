/**
 * The probe-fleet ingest credential (R1.2.4). Fail closed, everywhere.
 *
 * WHY THIS IS NOT src/lib/cronAuth.js
 * `isCronAuthorized` deliberately ALLOWS a missing secret outside production
 * ("so local dev and the self-continue fetch work out of the box") and only
 * denies when the resolved environment is production. That trade exists because
 * a Vercel cron and the scan worker's own self-continue `fetch` must keep
 * working on a laptop. This route has neither caller: the only client is the
 * probe fleet in `worker/`, which is a separate deployment with its own
 * environment, and nothing in `src/` calls it. So there is no dev path to
 * preserve and no reason to accept an unconfigured gate in ANY environment —
 * R1.2.4's detail says "worker token, fail-closed", and a gate that opens when
 * `NODE_ENV` says the word "development" is not that.
 *
 * The consequence, stated so it cannot surprise anyone: with
 * `PROBE_INGEST_TOKEN` unset, this endpoint answers 401 to everything,
 * including on a developer's machine. That is the intended state of an ingest
 * route that writes to `prompt_results`, the table every score is computed from.
 *
 * WHY A DEDICATED VARIABLE AND NOT `CRON_SECRET`
 * `CRON_SECRET` is carried by Vercel's cron scheduler and by our own
 * self-continue fetch. Handing the same value to a third-party container host so
 * it can POST measurements would make one credential the key to both the ingest
 * route and two endpoints that spend vendor budget, and would mean rotating it
 * requires a coordinated redeploy of two systems. The fleet gets its own.
 *
 * WHY THERE IS NO `?secret=` CARRIER
 * `isCronAuthorized` accepts one because Vercel's own tooling and a hand-typed
 * curl both need it. A query parameter lands in access logs, proxy logs and
 * browser history; the fleet is code and can set a header. Two carriers, both
 * headers, and nothing else.
 *
 * Pure — no `next/server`, no Next-specific import — so every branch below is
 * unit-testable and the route is a thin shell over it.
 */
import crypto from "node:crypto";

/** Why a request was allowed or refused. Returned, never only logged. */
export const INGEST_AUTH = Object.freeze({
  OK: "ok",
  /** No token in the environment. THE FAIL-CLOSED BRANCH — denies in every environment. */
  DENY_NO_TOKEN_CONFIGURED: "deny_no_token_configured",
  /** A token is configured but is too short to be a credential. */
  DENY_TOKEN_TOO_SHORT: "deny_token_too_short",
  /** Nothing was presented. */
  DENY_NO_CREDENTIAL: "deny_no_credential",
  /** Something was presented and it is not the token. */
  DENY_BAD_CREDENTIAL: "deny_bad_credential",
});

/**
 * The floor a configured token must clear. `scripts/check-secrets.mjs` applies
 * 16 to `CRON_SECRET`, which a human sometimes types into a curl; this token is
 * only ever set by an operator and read by a container, so a longer floor costs
 * nothing. A value below it is treated as a MISCONFIGURATION and refused —
 * never accepted as "well, they set something".
 */
export const MIN_TOKEN_LENGTH = 24;

/** The two header carriers, in the order they are consulted. */
export function extractIngestToken(header) {
  const auth = header("authorization");
  if (typeof auth === "string" && auth.startsWith("Bearer ")) {
    const presented = auth.slice(7);
    // A bare "Bearer " with nothing after it is not a credential. Returning ""
    // here rather than falling through keeps the two carriers independent: a
    // caller that sent an empty bearer gets DENY_NO_CREDENTIAL, not a silent
    // second chance on the other header.
    if (presented !== "") return presented;
  }
  const direct = header("x-probe-ingest-token");
  if (typeof direct === "string" && direct !== "") return direct;
  return null;
}

/**
 * Constant-time comparison of two secrets of unknown length.
 *
 * `crypto.timingSafeEqual` THROWS on unequal lengths, so comparing the raw
 * strings would both leak the configured length through the error path and turn
 * a wrong-length guess into a 500. Hashing both sides first makes every
 * comparison 32 bytes against 32 bytes: one code path, one duration, no length
 * signal. `===` would return on the first differing byte and is exactly the
 * comparison this function exists not to be.
 */
export function timingSafeMatch(presented, configured) {
  if (typeof presented !== "string" || typeof configured !== "string") return false;
  if (presented === "" || configured === "") return false;
  const a = crypto.createHash("sha256").update(presented, "utf8").digest();
  const b = crypto.createHash("sha256").update(configured, "utf8").digest();
  return crypto.timingSafeEqual(a, b);
}

/**
 * The whole decision. No environment argument: there is no environment in which
 * an unconfigured token opens this route, which is the point.
 *
 * @param {object} args
 * @param {unknown} args.token  process.env.PROBE_INGEST_TOKEN
 * @param {(name: string) => string|null} args.header case-insensitive header getter
 * @returns {{authorized: boolean, reason: string}}
 */
export function authorizeIngestRequest({ token, header }) {
  const configured = typeof token === "string" ? token.trim() : "";

  // FAIL CLOSED. `undefined` on both sides must never compare equal, which is
  // why this branch precedes the comparison instead of relying on it: an
  // absent env var and an absent header are the classic pair that a bare
  // equality check waves through.
  if (configured === "") {
    return { authorized: false, reason: INGEST_AUTH.DENY_NO_TOKEN_CONFIGURED };
  }
  if (configured.length < MIN_TOKEN_LENGTH) {
    return { authorized: false, reason: INGEST_AUTH.DENY_TOKEN_TOO_SHORT };
  }

  const presented = extractIngestToken(header);
  if (presented === null) {
    return { authorized: false, reason: INGEST_AUTH.DENY_NO_CREDENTIAL };
  }
  if (timingSafeMatch(presented, configured)) {
    return { authorized: true, reason: INGEST_AUTH.OK };
  }
  return { authorized: false, reason: INGEST_AUTH.DENY_BAD_CREDENTIAL };
}

/** The refusal reasons an operator has to act on, as opposed to a caller. */
const MISCONFIGURED = new Set([
  INGEST_AUTH.DENY_NO_TOKEN_CONFIGURED,
  INGEST_AUTH.DENY_TOKEN_TOO_SHORT,
]);

/**
 * Route-facing wrapper. Reads the environment at REQUEST time — never at module
 * scope — so the value that decides is the one the deployment is running on, and
 * announces a misconfiguration once per process.
 *
 * The 401 body says nothing about whether a token is configured: this endpoint
 * is reachable by anyone and "no ingest token configured" is a free hint. The
 * operator's copy goes to the log, where it names the variable and never its
 * value.
 *
 * @param {Request} request
 * @param {{warned: {value: boolean}, env?: object, logger?: object}} ctx
 * @returns {{authorized: boolean, reason: string}}
 */
export function checkIngestAuth(request, ctx) {
  const env = ctx.env || process.env;
  const logger = ctx.logger || console;
  const decision = authorizeIngestRequest({
    token: env.PROBE_INGEST_TOKEN,
    header: (name) => request.headers.get(name),
  });

  if (MISCONFIGURED.has(decision.reason) && !ctx.warned.value) {
    ctx.warned.value = true;
    logger.error(
      `[probe-ingest] REFUSING every request: PROBE_INGEST_TOKEN is ` +
        `${
          decision.reason === INGEST_AUTH.DENY_NO_TOKEN_CONFIGURED
            ? "not set"
            : `shorter than ${MIN_TOKEN_LENGTH} characters`
        }. ` +
        `POST /api/internal/probe-results writes into prompt_results, which every score is ` +
        `computed from, so it fails closed in every environment — set the variable in this ` +
        `deployment's environment and in the fleet's. This warns once per process.`
    );
  }

  return decision;
}
