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

/** Warn-once latch for an untrusted address source (see checkScanRateLimit). */
let warnedUntrustedSource = false;

/** Test seam: re-arm the warn-once latch. */
export function resetUntrustedSourceWarning() {
  warnedUntrustedSource = false;
}

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
 * Which header actually names the client, and whether anything but the client
 * decided its value.
 *
 * This is the whole per-IP claim. A bucket key derived from a header the
 * caller sets is not a per-IP limit at all: rotate the header and every
 * request lands in a fresh bucket. Measured against this module before the
 * trust ordering below existed, 25 requests carrying a rotating `x-real-ip`
 * were allowed 25 times under a limit of 5.
 *
 * TRUSTED (`x-vercel-forwarded-for`, and only when `VERCEL` is set): Vercel
 * strips inbound `x-vercel-*` headers and writes this one itself, so a caller
 * cannot forge it. Off Vercel the same header IS forgeable, which is why the
 * env gate is not decoration.
 *
 * TRUSTED (`SCAN_RATE_LIMIT_IP_HEADER`): an operator running behind some other
 * proxy names the single header that proxy OVERWRITES. This has to be declared
 * because nothing in the request can tell us it was.
 *
 * UNTRUSTED (`x-real-ip`, then the leftmost `x-forwarded-for` entry): the
 * conventional pair, used only as a fallback, and reported as untrusted rather
 * than passed off as an address. Note that `next start` does not set either one
 * — base-server.js fills `x-forwarded-for` only when it is ABSENT and never
 * touches `x-real-ip` — so on a self-hosted deployment both are purely the
 * caller's words. "Leftmost" is likewise a convention, not a derivation: with
 * no known proxy depth there is no correct element of the chain to pick.
 */
export const TRUSTED_IP_HEADER = "x-vercel-forwarded-for";

export function resolveClientIp({ header, env = process.env }) {
  const read = (name) => (header(name) || "").split(",")[0].trim();

  // Either marker, because the cost of getting this wrong is asymmetric: a
  // false negative silently demotes the trusted header back to the spoofable
  // fallback and the limit quietly stops being per-IP. `VERCEL` is the
  // documented one; `VERCEL_URL` is the one scanWorker.js already depends on
  // being present in this deployment, so it is checked as corroboration.
  if (env.VERCEL || env.VERCEL_URL) {
    const platform = read(TRUSTED_IP_HEADER);
    if (platform) return { ip: platform, source: TRUSTED_IP_HEADER, trusted: true };
  }

  const declared = (env.SCAN_RATE_LIMIT_IP_HEADER || "").trim().toLowerCase();
  if (declared) {
    const value = read(declared);
    if (value) return { ip: value, source: declared, trusted: true };
  }

  const realIp = read("x-real-ip");
  if (realIp) return { ip: realIp, source: "x-real-ip", trusted: false };

  const forwarded = read("x-forwarded-for");
  if (forwarded) return { ip: forwarded, source: "x-forwarded-for", trusted: false };

  // No identifiable client at all: bucket every such request together rather
  // than letting them all through unlimited. A shared bucket throttles; no
  // bucket does nothing.
  return { ip: null, source: "none", trusted: false };
}

/**
 * The client's identity, hashed.
 *
 * Hashed because this table is a rate-limit ledger, not a visitor log: it has
 * no retention policy and no purpose that needs the raw address. The salt is
 * per-deployment so buckets are not comparable across deployments.
 */
export function clientBucketKey({ header, salt = "", env = process.env }) {
  const subject = resolveClientIp({ header, env }).ip || "unidentified";
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
  const identity = resolveClientIp({ header, env });
  const bucketKey = clientBucketKey({ header, salt: env.SCAN_RATE_LIMIT_SALT || "", env });
  const startedAt = windowStart(now, windowMs);

  // A limit keyed on a header the caller writes is not a limit. Say so — once
  // per process, so it lands on every cold start without drowning the log —
  // and carry `trusted` out in the envelope so the decision is never read as
  // "this address has had 5 scans" when it only means "this claim has".
  if (!identity.trusted && !warnedUntrustedSource) {
    warnedUntrustedSource = true;
    logger.warn(
      (identity.source === "none"
        ? `[rate-limit] no client address header on this request: every such caller shares ONE bucket, ` +
          `so the limit is real but not per-IP.`
        : `[rate-limit] client address taken from ${identity.source}, which the caller can set: ` +
          `the per-IP limit is bypassable by rotating that header.`) +
        ` Set SCAN_RATE_LIMIT_IP_HEADER to the header your proxy OVERWRITES, or deploy behind Vercel ` +
        `where ${TRUSTED_IP_HEADER} is trusted.`
    );
  }

  let hits;
  try {
    hits = await increment({ bucketKey, windowStart: startedAt });
  } catch (err) {
    logger.warn(
      `[rate-limit] counter unavailable (${err.message}) — allowing this scan. ` +
        `The one-running-scan-per-brand index still applies.`
    );
    return {
      allowed: true,
      degraded: true,
      limit,
      remaining: null,
      retryAfterSec: 0,
      bucketKey,
      source: identity.source,
      trusted: identity.trusted,
    };
  }

  if (!Number.isFinite(hits)) {
    logger.warn("[rate-limit] counter returned a non-numeric count — allowing this scan.");
    return {
      allowed: true,
      degraded: true,
      limit,
      remaining: null,
      retryAfterSec: 0,
      bucketKey,
      source: identity.source,
      trusted: identity.trusted,
    };
  }

  return {
    ...evaluate({ hits, limit, windowMs, nowMs: now, windowStartMs: Date.parse(startedAt) }),
    degraded: false,
    bucketKey,
    source: identity.source,
    trusted: identity.trusted,
  };
}
