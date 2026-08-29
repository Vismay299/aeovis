import crypto from "crypto";

/**
 * Per-IP rate limit for the anonymous free scan (R0.1.4, finding S17).
 *
 * POST /api/scan has no cap of any kind: one anonymous caller can start
 * unlimited scans, each spending real Bright Data + Perplexity + LLM budget.
 * This is a fixed-window counter in Postgres — no new infrastructure, because
 * the whole point of the task is a limit that ships today rather than a
 * Redis dependency that ships later.
 *
 * Fixed window, not a sliding one, on purpose: a fixed window is one row and
 * one atomic increment, and its worst case (up to 2x the limit across a
 * window boundary) is irrelevant at this magnitude. Say what it is rather
 * than implying precision it does not have.
 */

export const DEFAULTS = Object.freeze({
  /** Scans allowed per window, per client. */
  limit: 5,
  /** Window length. */
  windowMs: 60 * 60 * 1000,
});

/** Reads the env overrides named in the task's acceptance criteria. */
export function resolveRateLimit(env = process.env) {
  const limit = Number(env.SCAN_RATE_LIMIT);
  const windowMs = Number(env.SCAN_RATE_LIMIT_WINDOW_MS);
  return {
    limit: Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : DEFAULTS.limit,
    windowMs:
      Number.isFinite(windowMs) && windowMs > 0 ? Math.floor(windowMs) : DEFAULTS.windowMs,
  };
}

/**
 * The client's identity, hashed.
 *
 * Hashed because this table is a rate-limit ledger, not a visitor log: it has
 * no retention policy and no purpose that needs the raw address. The salt is
 * per-deployment so buckets are not comparable across deployments.
 *
 * Header order matters. `x-forwarded-for` is a client-settable header
 * everywhere except behind a proxy that overwrites it; on Vercel the LEFTMOST
 * entry is the real client and the platform rewrites the header, so it is
 * trustworthy there. `x-real-ip` is preferred when present because Vercel
 * sets it directly.
 */
export function clientBucketKey({ header, salt = "" }) {
  const realIp = (header("x-real-ip") || "").trim();
  const forwarded = (header("x-forwarded-for") || "").split(",")[0].trim();
  const ip = realIp || forwarded;
  // No identifiable client at all: bucket every such request together rather
  // than letting them all through unlimited. A shared bucket throttles; no
  // bucket does nothing.
  const subject = ip || "unidentified";
  return crypto.createHash("sha256").update(`${salt}:${subject}`).digest("hex").slice(0, 32);
}

/** Start of the fixed window containing `nowMs`, as an ISO string. */
export function windowStart(nowMs, windowMs) {
  return new Date(Math.floor(nowMs / windowMs) * windowMs).toISOString();
}

/**
 * Decide from a current count. Pure, so the arithmetic is testable apart from
 * the storage.
 *
 * @returns {{allowed: boolean, limit: number, remaining: number, retryAfterSec: number}}
 */
export function evaluate({ hits, limit, windowMs, nowMs, windowStartMs }) {
  const allowed = hits <= limit;
  const resetMs = windowStartMs + windowMs;
  return {
    allowed,
    limit,
    remaining: Math.max(0, limit - hits),
    retryAfterSec: Math.max(1, Math.ceil((resetMs - nowMs) / 1000)),
  };
}

/**
 * Count this request and say whether it is allowed.
 *
 * `increment` is injected so the DB round trip is a seam: it must atomically
 * add one to (bucket_key, window_start) and return the resulting count. The
 * increment happens BEFORE the decision so two concurrent requests cannot
 * both read "4 so far" and both proceed.
 *
 * FAIL-OPEN, deliberately and narrowly: if the counter store is unreachable
 * the scan proceeds, because a broken rate limiter must not take the product
 * down. That IS a fail-soft, so it is loud — it returns `degraded: true` and
 * the caller logs it. The duplicate-scan seal (R0.1.5) is what actually
 * bounds the damage in that window: one running scan per brand still holds,
 * because that one is enforced by the database.
 */
export async function checkScanRateLimit({
  header,
  increment,
  env = process.env,
  now = Date.now(),
  logger = console,
}) {
  const { limit, windowMs } = resolveRateLimit(env);
  const bucketKey = clientBucketKey({ header, salt: env.SCAN_RATE_LIMIT_SALT || "" });
  const startedAt = windowStart(now, windowMs);

  let hits;
  try {
    hits = await increment({ bucketKey, windowStart: startedAt });
  } catch (err) {
    logger.warn(
      `[rate-limit] counter unavailable (${err.message}) — allowing this scan. ` +
        `The one-running-scan-per-brand index still applies.`
    );
    return { allowed: true, degraded: true, limit, remaining: null, retryAfterSec: 0, bucketKey };
  }

  if (!Number.isFinite(hits)) {
    logger.warn("[rate-limit] counter returned a non-numeric count — allowing this scan.");
    return { allowed: true, degraded: true, limit, remaining: null, retryAfterSec: 0, bucketKey };
  }

  return {
    ...evaluate({ hits, limit, windowMs, nowMs: now, windowStartMs: Date.parse(startedAt) }),
    degraded: false,
    bucketKey,
  };
}
