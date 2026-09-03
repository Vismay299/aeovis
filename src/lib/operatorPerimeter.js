/**
 * The operator perimeter (R0.1.3, finding S17).
 *
 * Today every /api route is anonymous. POST /api/content starts a paid content
 * pipeline; /api/agents, /api/knowledge, /api/lessons and /api/brand-briefs
 * read and write another business's strategy documents; /api/brands/* returns
 * a customer's measurements. None of it asks who is calling.
 *
 * This is a shared-token choke point, not authentication. It is the seam real
 * per-user auth occupies in Phase Z, and it is deliberately shaped so that
 * swapping the token check for a session check touches one function.
 *
 * The rule is an ALLOWLIST, because a denylist silently fails open for every
 * route added after it. Only the anonymous free-scan flow is public:
 *
 *   POST /api/scan                 start a scan
 *   GET  /api/scan/<id>/status     poll it
 *   GET  /api/scans/...            read the result it produced
 *   GET  /api/industries           the industry picker on the scan form
 *   GET  /api/health               booleans and timestamps only, no customer data
 *
 * Two routes are EXEMPT rather than public: the cron workers carry their own
 * secret gate (src/lib/cronAuth.js) and are called by Vercel cron and by the
 * worker's own self-continue fetch, neither of which holds an operator token.
 * Gating them here would 401 the self-continue call and stall every scan that
 * exceeds one chunk — so they pass through to the gate they already have.
 *
 * What this closes to anonymous callers, on purpose: the whole Content OS UI,
 * the agent control plane, knowledge/lessons, and brand analytics. Those are
 * operator surfaces today; the product's front door is the free scan.
 *
 * Pure — no next/server import, no node:crypto (middleware runs on the Edge
 * runtime) — so every rule below is unit-testable.
 */

/** Exact-match public routes, by method. */
const PUBLIC_EXACT = [
  { method: "POST", path: "/api/scan" },
  { method: "GET", path: "/api/industries" },
  { method: "GET", path: "/api/health" },
];

/** Public route patterns, by method. */
const PUBLIC_PATTERNS = [
  // Poll a scan job you just started.
  { method: "GET", re: /^\/api\/scan\/[^/]+\/status\/?$/ },
  // Read scan results: /api/scans/<brand>, /<brand>/latest, /by-id/<scanId>.
  { method: "GET", re: /^\/api\/scans\/[^?]*$/ },
];

/**
 * Routes that enforce their own auth and must NOT be double-gated here.
 * Adding to this list is the dangerous edit in this file: anything listed
 * must already refuse unauthenticated callers by itself.
 */
const SELF_GATED = [/^\/api\/scan\/worker\/?$/, /^\/api\/content\/worker\/?$/];

/** Non-API paths the middleware never sees (see the matcher in middleware.js). */
export function isApiPath(pathname) {
  return pathname === "/api" || pathname.startsWith("/api/");
}

export function isSelfGated(pathname) {
  return SELF_GATED.some((re) => re.test(pathname));
}

/**
 * True when this request is part of the anonymous free-scan flow.
 * Method-sensitive on purpose: GET /api/scan is a listing, not the public
 * scan-start call, and must stay behind the perimeter.
 */
export function isPublicRoute(method, pathname) {
  const m = String(method || "").toUpperCase();
  const p = pathname.replace(/\/+$/, "") || "/";
  if (PUBLIC_EXACT.some((r) => r.method === m && r.path === p)) return true;
  return PUBLIC_PATTERNS.some((r) => r.method === m && r.re.test(p));
}

/**
 * Constant-time string comparison.
 *
 * Hand-rolled because middleware runs on the Edge runtime, where node:crypto's
 * timingSafeEqual is not available. Length is compared without early return,
 * and every character of the longer string is always visited, so the loop
 * count does not leak the secret's length.
 */
export function timingSafeEquals(a, b) {
  const left = String(a ?? "");
  const right = String(b ?? "");
  const len = Math.max(left.length, right.length);
  let diff = left.length ^ right.length;
  for (let i = 0; i < len; i++) {
    diff |= left.charCodeAt(i % (left.length || 1)) ^ right.charCodeAt(i % (right.length || 1));
  }
  return diff === 0 && left.length === right.length;
}

/** Where an operator token may be carried. */
export function extractOperatorToken({ header, cookie }) {
  const auth = header("authorization") || "";
  if (auth.startsWith("Bearer ")) return auth.slice(7);
  const direct = header("x-operator-token");
  if (direct) return direct;
  return cookie("operator_token") || null;
}

/**
 * Resolve the RUNTIME NODE_ENV for the perimeter.
 *
 * middleware.js must never write the literal `process.env.NODE_ENV`. Next
 * substitutes that exact expression textually at BUILD time for every bundle,
 * the Edge one included (see define-env-plugin.js: "process.env.NODE_ENV":
 * dev ? "development" : "production"), so a perimeter written that way judges
 * "production" by how it was COMPILED, not by how it is RUN. R0.1.1's verifier
 * proved it: a server started with NODE_ENV=development still logged the
 * production refusal.
 *
 * Reading the key off a dynamic binding is not substituted — the same shape
 * isCronAuthorized uses in src/lib/cronAuth.js:76 — and Next's Edge sandbox
 * builds process.env from the real runtime environment
 * (next/dist/server/web/sandbox/context.js, buildEnvironmentVariablesFrom),
 * so the value that arrives here is the one the server was started with.
 *
 * An absent or blank NODE_ENV resolves to "production". Moving this read to
 * runtime must not convert a fail-closed perimeter into a fail-open one: an
 * environment that will not say what it is gets treated as the dangerous one.
 */
export function resolveNodeEnv(env) {
  const raw = String((env && env.NODE_ENV) || "").trim();
  return raw || "production";
}

export const PERIMETER = Object.freeze({
  ALLOW_PUBLIC: "allow_public",
  ALLOW_SELF_GATED: "allow_self_gated",
  ALLOW_OPERATOR: "allow_operator",
  ALLOW_DEV_NO_TOKEN: "allow_dev_no_token",
  DENY_NO_TOKEN_CONFIGURED: "deny_no_token_configured",
  DENY_BAD_TOKEN: "deny_bad_token",
});

/**
 * Disclose the dev allowance, ONCE (R0.1.14, finding S17).
 *
 * `authorizeOperatorRequest` returns ALLOW_DEV_NO_TOKEN whenever
 * OPERATOR_TOKEN is unset and the resolved NODE_ENV is anything other than
 * "production" — so a deployment running with NODE_ENV=development or
 * NODE_ENV=staging serves POST /api/content and GET /api/knowledge to anyone
 * who asks. That rule is deliberate and matches src/lib/cronAuth.js. What was
 * NOT deliberate is that the cron gate SAYS SO on its equivalent branch
 * (CRON_AUTH.OK_DEV_NO_SECRET) while this one said nothing at all — an open
 * perimeter whose only evidence was reading the source. The two gates must
 * disclose alike, so this mirrors isCronAuthorized's warn-once.
 *
 * The once-flag is passed IN rather than held here, for the same reason
 * cronAuth's is: module state in this file would be shared by every test in
 * the process, so the first test to trip it would silence the rest and the
 * assertion would pass while proving nothing. The caller owns the box.
 *
 * Scope of "once": one warning per module instance. In Next's Edge runtime
 * middleware.js is evaluated per ISOLATE, and isolates are created, reused
 * across many requests, then recycled by the platform — so this is once per
 * ISOLATE, not once per deploy. A long-lived isolate warns on its first
 * dev-open request and stays quiet after; a cold start warns again. That is
 * the same guarantee the worker routes already give, and it is deliberately
 * not per-request: a line on every call is a line nobody reads (R6.1.5).
 *
 * Returns whether it actually warned, so a caller — and a test — can tell
 * "suppressed as a repeat" apart from "never reached this branch".
 *
 * @param {object} args
 * @param {string} args.reason   a PERIMETER.* value from authorizeOperatorRequest
 * @param {string} args.nodeEnv  the RESOLVED NODE_ENV (resolveNodeEnv's output)
 * @param {string} args.method
 * @param {string} args.pathname
 * @param {{value: boolean}} args.warned caller-owned once-flag
 * @param {{warn: Function}} [args.logger]
 * @returns {boolean} true only on the call that emitted the warning
 */
export function warnDevPerimeterOpen({ reason, nodeEnv, method, pathname, warned, logger }) {
  if (reason !== PERIMETER.ALLOW_DEV_NO_TOKEN) return false;
  // No silent no-op if the caller forgot the box. A disclosure helper that
  // quietly declines to disclose is the exact bug it exists to prevent.
  if (!warned || typeof warned !== "object") {
    throw new TypeError("warnDevPerimeterOpen requires a caller-owned { value } once-flag");
  }
  if (warned.value) return false;
  warned.value = true;
  (logger || console).warn(
    `[perimeter] OPERATOR_TOKEN is not set — every operator route is UNAUTHENTICATED in ` +
      `NODE_ENV=${nodeEnv}. First seen at ${method} ${pathname}. Operator routes are refused ` +
      `outright in production. This warns once per Edge isolate, not once per request.`
  );
  return true;
}

/**
 * The whole decision.
 *
 * @param {object} args
 * @param {string} args.method
 * @param {string} args.pathname
 * @param {string|undefined} args.operatorToken process.env.OPERATOR_TOKEN
 * @param {string|undefined} args.nodeEnv
 * @param {(name: string) => string|null} args.header
 * @param {(name: string) => string|null} [args.cookie]
 * @returns {{allow: boolean, reason: string}}
 */
export function authorizeOperatorRequest({
  method,
  pathname,
  operatorToken,
  nodeEnv,
  header,
  cookie = () => null,
}) {
  if (isSelfGated(pathname)) return { allow: true, reason: PERIMETER.ALLOW_SELF_GATED };
  if (isPublicRoute(method, pathname)) return { allow: true, reason: PERIMETER.ALLOW_PUBLIC };

  const configured = String(operatorToken || "").trim();
  if (!configured) {
    // Same rule as the cron gate: fail closed where it matters. An
    // unconfigured perimeter in production is an open one.
    if (nodeEnv === "production") {
      return { allow: false, reason: PERIMETER.DENY_NO_TOKEN_CONFIGURED };
    }
    return { allow: true, reason: PERIMETER.ALLOW_DEV_NO_TOKEN };
  }

  const presented = extractOperatorToken({ header, cookie });
  if (presented && timingSafeEquals(presented, configured)) {
    return { allow: true, reason: PERIMETER.ALLOW_OPERATOR };
  }
  return { allow: false, reason: PERIMETER.DENY_BAD_TOKEN };
}
