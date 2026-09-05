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
/** Warn-once latch for a misconfigured trust knob (R0.1.18). Separate from the
 * one above on purpose: a bad declaration must never be swallowed by the latch
 * that a plain untrusted request would have tripped anyway. */
let warnedTrustConfig = false;

/** Test seam: re-arm both warn-once latches. */
export function resetUntrustedSourceWarning() {
  warnedUntrustedSource = false;
  warnedTrustConfig = false;
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

/**
 * NOT VERIFIED HERE: that Vercel really does strip inbound `x-vercel-*`. The
 * claim above is the platform's documented behaviour, and nothing inside a
 * request handler can corroborate it — a request carrying that header looks
 * identical whether the edge wrote it or the caller did. Proving it needs an
 * external probe (send a forged `x-vercel-forwarded-for` at the deployed URL
 * and compare the bucket it lands in), which belongs to a deploy-time check,
 * not to this module. Recorded as an assumption rather than dressed up as a
 * fact, because if it is ever false this file reports `trusted: true`.
 */

/** Values an operator writes to mean yes / no in a boolean env var. */
const TRUTHY_ENV = new Set(["1", "true", "yes", "on"]);
const FALSY_ENV = new Set(["", "0", "false", "no", "off"]);

/**
 * Are we on Vercel — judged by VALUE, not by presence (R0.1.18).
 *
 * `if (env.VERCEL)` made the strings "0" and "false" open the trust gate,
 * because every env var is a string and every non-empty string is truthy. An
 * operator self-hosting who writes `VERCEL=0` to mean "not Vercel" would have
 * silently trusted a header that, off Vercel, nothing strips.
 *
 * An unrecognised value (anything outside the yes/no vocabularies) is treated
 * as NOT on Vercel and warned about: closed is the safe direction, and the
 * operator typed something we cannot honour, so they are told rather than
 * guessed at.
 *
 * `VERCEL_URL` is a hostname, not a flag, so any non-empty value counts —
 * except the yes/no "no" words, which are never a hostname and are far more
 * likely to be the same self-hosting mistake.
 */
export function resolveVercelRuntime(env = process.env) {
  const raw = env.VERCEL == null ? "" : String(env.VERCEL).trim().toLowerCase();
  const byFlag = TRUTHY_ENV.has(raw);
  const warning =
    !byFlag && raw && !FALSY_ENV.has(raw)
      ? `[rate-limit] VERCEL is set to "${String(env.VERCEL)}", which is neither ` +
        `1/true/yes/on nor 0/false/no/off. Treating it as NOT running on Vercel, so ` +
        `${TRUSTED_IP_HEADER} is NOT trusted.`
      : null;

  const url = env.VERCEL_URL == null ? "" : String(env.VERCEL_URL).trim().toLowerCase();
  const byUrl = url !== "" && !FALSY_ENV.has(url);

  return { onVercel: byFlag || byUrl, via: byFlag ? "VERCEL" : byUrl ? "VERCEL_URL" : null, warning };
}

/**
 * Header names SCAN_RATE_LIMIT_IP_HEADER may not declare, and why.
 *
 * The knob exists so an operator can name the one header their proxy
 * OVERWRITES. These names cannot be that header, so declaring one of them does
 * not change which value this module reads — only the label it puts on it. The
 * pre-R0.1.18 code accepted them, which meant a declaration of `x-real-ip`
 * returned the exact same address as no declaration at all, but as
 * `trusted: true` AND with the warning suppressed: strictly worse than leaving
 * the knob unset.
 *
 * `x-forwarded-for` is refused even though some proxies genuinely do overwrite
 * it (nginx with `$remote_addr`), because far more of them APPEND
 * (`proxy_add_x_forwarded_for`) and nothing in the request distinguishes the
 * two — and this module reads the leftmost element, which under an appending
 * proxy is the caller's word. An operator in that position should have their
 * proxy write a header of its own (`cf-connecting-ip`, `x-acme-client-ip`) and
 * declare that.
 */
export const REFUSED_IP_HEADERS = Object.freeze({
  host: "the caller sets it and no proxy replaces it with a client address",
  "x-real-ip": "this module already reads it as an UNTRUSTED fallback; declaring it relabels a guess as a fact",
  "x-forwarded-for": "a chain the caller can prepend to, and the leftmost entry is the caller's word",
  "x-forwarded-host": "a hostname, not a client address, and the caller can set it",
  forwarded: "RFC 7239 syntax this module does not parse, and the caller can set it",
  [TRUSTED_IP_HEADER]: "on Vercel it is already trusted without a declaration; off Vercel nothing strips it",
});

/** RFC 7230 token: what a header name may legally contain. */
const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9a-z]+$/;

/**
 * Read SCAN_RATE_LIMIT_IP_HEADER, refusing a declaration that cannot mean what
 * the knob is for.
 *
 * REFUSED, not merely demoted: a refused declaration falls through to the
 * untrusted fallbacks, so the request still gets `trusted: false` and still
 * trips the untrusted-source warning, AND the refusal itself is warned about.
 * A bad declaration is therefore LOUDER than no declaration, never quieter —
 * which is the property this task exists to restore.
 *
 * It deliberately does not throw. A misconfigured trust knob must not take the
 * free-scan path down: the limit still holds on the fallback identity, which is
 * exactly where an undeclared deployment already sits.
 */
export function resolveDeclaredIpHeader(env = process.env) {
  const raw = (env.SCAN_RATE_LIMIT_IP_HEADER || "").trim();
  if (!raw) return { header: null, warning: null };

  const name = raw.toLowerCase();
  const refuse = (why) => ({
    header: null,
    warning:
      `[rate-limit] SCAN_RATE_LIMIT_IP_HEADER="${raw}" REFUSED: ${why}. ` +
      `The address falls back to an UNTRUSTED source and the per-IP limit stays bypassable. ` +
      `Name the single header your proxy OVERWRITES on every inbound request.`,
  });

  if (!HEADER_NAME.test(name)) return refuse("that is not a single valid HTTP header name");
  // `in`, not Object.hasOwn, on purpose: it also catches `__proto__` and
  // `constructor`, and refusing those is not pedantry. A caller whose header
  // getter is a plain-object lookup rather than a `Headers` (this module only
  // receives a getter, so it cannot know) returns Object.prototype for
  // `__proto__`, which stringifies to a truthy "[object Object]" and would
  // become a TRUSTED identity shared by every such request. Over-refusal here
  // fails closed; Object.hasOwn would open that door. The reason string is
  // looked up with hasOwn so an inherited property cannot be interpolated into
  // the warning as a function body — an operator-facing message that says
  // nothing is the same defect as no message.
  if (name in REFUSED_IP_HEADERS) {
    return refuse(
      Object.hasOwn(REFUSED_IP_HEADERS, name)
        ? REFUSED_IP_HEADERS[name]
        : "that is a property of Object.prototype, not a header any proxy writes"
    );
  }
  return { header: name, warning: null };
}

/**
 * One address, one bucket.
 *
 * Strips a port and IPv6 brackets so `[2001:db8::1]:443` and `2001:db8::1` do
 * not become two budgets for one client. Latent rather than live — Vercel does
 * not put a port on `x-vercel-forwarded-for` — but a self-hosted proxy can, and
 * splitting a bucket per ephemeral port would be a limit of one scan each.
 *
 * NOT full IPv6 canonicalisation: `::1` and `0:0:0:0:0:0:0:1` are the same
 * address and still land in different buckets. Case folding and the port are
 * what a proxy actually varies; expanding the rest would need an IP parser and
 * is not claimed here.
 *
 * An IPv6 ZONE ID (`fe80::1%eth0`) is KEPT, deliberately. A link-local address
 * is only unique within its zone, so dropping it would MERGE two genuinely
 * different peers reached over different interfaces into one bucket and let
 * either throttle the other. The zone is written by the receiving host from its
 * own interface, never by the caller, so keeping it cannot split one client
 * across buckets. Merging is the dangerous direction here; splitting is not
 * available.
 */
export function normaliseAddress(raw) {
  // Folded once, up front: an address is case-insensitive in every form that
  // reaches here (hex in IPv6, DNS labels in a hostname, digits in IPv4). The
  // previous version folded only values containing a colon, so `EXAMPLE.com`
  // and `example.com` were two budgets for one client.
  const value = String(raw ?? "").trim().toLowerCase();
  if (!value) return "";

  const bracketed = /^\[([^\]]+)\](?::\d{1,5})?$/.exec(value);
  if (bracketed) return bracketed[1];

  // Exactly one colon, so a bare IPv6 (which has at least two) is left alone.
  // Not restricted to IPv4: a declared header can carry `proxy.example:8080`,
  // and a port is never part of who the client is.
  const withPort = /^([^:]+):\d{1,5}$/.exec(value);
  if (withPort) return withPort[1];

  return value;
}

export function resolveClientIp({ header, env = process.env }) {
  const read = (name) => normaliseAddress((header(name) || "").split(",")[0]);

  const runtime = resolveVercelRuntime(env);
  const declaration = resolveDeclaredIpHeader(env);
  // Carried in the envelope so the caller can shout about a misconfiguration
  // that would otherwise only be visible as a quietly weaker limit.
  const configWarning = [runtime.warning, declaration.warning].filter(Boolean).join(" ") || null;
  const out = (ip, source, trusted) => ({ ip, source, trusted, configWarning });

  // Either marker, because the cost of getting this wrong is asymmetric: a
  // false negative silently demotes the trusted header back to the spoofable
  // fallback and the limit quietly stops being per-IP. `VERCEL` is the
  // documented one; `VERCEL_URL` is the one scanWorker.js already depends on
  // being present in this deployment, so it is checked as corroboration.
  if (runtime.onVercel) {
    const platform = read(TRUSTED_IP_HEADER);
    if (platform) return out(platform, TRUSTED_IP_HEADER, true);
  }

  if (declaration.header) {
    const value = read(declaration.header);
    if (value) return out(value, declaration.header, true);
  }

  const realIp = read("x-real-ip");
  if (realIp) return out(realIp, "x-real-ip", false);

  const forwarded = read("x-forwarded-for");
  if (forwarded) return out(forwarded, "x-forwarded-for", false);

  // No identifiable client at all: bucket every such request together rather
  // than letting them all through unlimited. A shared bucket throttles; no
  // bucket does nothing.
  return out(null, "none", false);
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

  // A trust knob that was set and could not be honoured is reported first and
  // separately (R0.1.18): the operator believes this limit is per-IP because
  // they configured it to be, so silence here would be the most expensive
  // silence in the module.
  if (identity.configWarning && !warnedTrustConfig) {
    warnedTrustConfig = true;
    logger.warn(identity.configWarning);
  }

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
