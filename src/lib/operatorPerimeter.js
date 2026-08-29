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

export const PERIMETER = Object.freeze({
  ALLOW_PUBLIC: "allow_public",
  ALLOW_SELF_GATED: "allow_self_gated",
  ALLOW_OPERATOR: "allow_operator",
  ALLOW_DEV_NO_TOKEN: "allow_dev_no_token",
  DENY_NO_TOKEN_CONFIGURED: "deny_no_token_configured",
  DENY_BAD_TOKEN: "deny_bad_token",
});

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
