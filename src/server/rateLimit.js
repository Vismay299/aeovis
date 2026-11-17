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

/**
 * Warn-once latches for an untrusted address source (see checkScanRateLimit),
 * keyed by WHY the address is untrusted rather than one boolean for all of
 * them (R0.1.20).
 *
 * The single boolean was correct while only one thing could be wrong. Now that
 * the platform header is untrusted too (see PLATFORM_IP_HEADER), a Vercel
 * process would spend the one latch on "we do not vouch for the platform
 * header" and then go SILENT if a later request in the same process arrived
 * with no platform header at all and fell back to `x-real-ip` — a strictly
 * worse state, hidden by the warning for a better one. One latch per basis
 * bounds the log at one line per distinct state per process, which is the same
 * property the boolean had, without the swallowing.
 */
const warnedUntrustedBases = new Set();
/** Warn-once latch for a misconfigured trust knob (R0.1.18). Separate from the
 * ones above on purpose: a bad declaration must never be swallowed by the latch
 * that a plain untrusted request would have tripped anyway. */
let warnedTrustConfig = false;
/**
 * Warn-once latches for an EXHAUSTED deployment ceiling, keyed by WHICH ceiling
 * ran out (R0.1.22, split per tier by R0.1.24). Its own latch family for the
 * same reason as the bases above: "this deployment cannot tell its callers
 * apart" and "...and it has now refused everybody" are different incidents, and
 * the second one is the product being down.
 *
 * Per TIER rather than one boolean because a Vercel deployment can reach both:
 * a request carrying the platform header answers to the attested ceiling, and a
 * request arriving without it answers to the unverified one. One boolean would
 * let the first exhaustion silence the report of the second, which is a
 * different outage hidden by the record of an earlier one.
 */
const warnedCeilingsExhausted = new Set();

/** Test seam: re-arm every warn-once latch. */
export function resetUntrustedSourceWarning() {
  warnedUntrustedBases.clear();
  warnedTrustConfig = false;
  warnedCeilingsExhausted.clear();
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
 * PREFERRED BUT NOT VOUCHED FOR (`x-vercel-forwarded-for`, and only when
 * `VERCEL` is set): Vercel is DOCUMENTED to strip inbound `x-vercel-*` headers
 * and write this one itself. It is still read first, because it is the best
 * address available on that platform and demoting it would hand the bucket to
 * a header the caller definitely writes. It is reported `trusted: false`
 * (R0.1.20) because nobody here has proved the strip — see
 * TRUST_RESTORE_CHECK. Off Vercel the header is not read at all, which is why
 * the env gate is not decoration.
 *
 * TRUSTED (`SCAN_RATE_LIMIT_IP_HEADER`): an operator running behind some other
 * proxy names the single header that proxy OVERWRITES. This has to be declared
 * because nothing in the request can tell us it was. This one keeps
 * `trusted: true`: it is a human assertion made out of band, not an assumption
 * this module invented about someone else's edge.
 *
 * UNTRUSTED (`x-real-ip`, then the leftmost `x-forwarded-for` entry): the
 * conventional pair, used only as a fallback, and reported as untrusted rather
 * than passed off as an address. Note that `next start` does not set either one
 * — base-server.js fills `x-forwarded-for` only when it is ABSENT and never
 * touches `x-real-ip` — so on a self-hosted deployment both are purely the
 * caller's words. "Leftmost" is likewise a convention, not a derivation: with
 * no known proxy depth there is no correct element of the chain to pick.
 */
// Named for what it IS — the header the platform is supposed to control — and
// no longer TRUSTED_IP_HEADER, which was a promise this module cannot keep.
export const PLATFORM_IP_HEADER = "x-vercel-forwarded-for";

/**
 * R0.1.20 — the `trusted: true` label is WITHDRAWN from PLATFORM_IP_HEADER.
 *
 * What was never verified: that Vercel really does strip inbound `x-vercel-*`.
 * That is the platform's documented behaviour and nothing inside a request
 * handler can corroborate it — a request carrying that header looks identical
 * whether the edge wrote it or the caller did. If the documentation is ever
 * wrong, or an edge config changes, an anonymous caller forges the header,
 * lands in a bucket of their choosing, and the old envelope asserted
 * `trusted: true` about it while the warn-once (which only fired for UNTRUSTED
 * sources) stayed silent. A spoofable identity carrying a confidence label is
 * worse than no label.
 *
 * So the label is withheld until it is earned, and the request is warned about
 * like any other unvouched-for source. What is NOT changed: the header is still
 * read first on Vercel and the bucket key is byte-identical, so the limit is
 * exactly as strong as it was. Only the claim about it is weaker — which is the
 * direction that fails safe.
 *
 * This is a DEFERRAL, not a verdict on the platform. Grep RESTORE-TRUST-R0.1.20
 * for everything that has to change to take the label back.
 */
export const TRUST_RESTORE_CHECK =
  "RESTORE-TRUST-R0.1.20: a deploy-time check that forges x-vercel-forwarded-for " +
  "against the deployed origin and asserts the rate-limit bucket does not move, " +
  "run where an operator sees the result";

/**
 * WHY an address is or is not vouched for. `trusted: false` on its own cannot
 * tell an operator whether the address came from the platform header we merely
 * have not PROVED or from a header the caller types, and those two are not the
 * same incident.
 */
export const TRUST_BASIS = Object.freeze({
  /** SCAN_RATE_LIMIT_IP_HEADER: an operator declared the header their proxy overwrites. */
  DECLARED: "operator-declared",
  /** PLATFORM_IP_HEADER on Vercel: best available, unproven, RESTORE-TRUST-R0.1.20. */
  PLATFORM_UNPROVEN: "platform-unproven",
  /** x-real-ip / x-forwarded-for: whatever the caller typed. */
  CALLER_SETTABLE: "caller-settable",
  /** No address header at all: one shared bucket. */
  ABSENT: "no-address-header",
});

// ---------------------------------------------------------------------------
// R0.1.22 — what an UNVERIFIED deployment is allowed to spend.
// ---------------------------------------------------------------------------

/**
 * THE DECISION, recorded (R0.1.22).
 *
 * Off Vercel with no `SCAN_RATE_LIMIT_IP_HEADER` declared, every address this
 * module can reach is one the caller types. Until now that state warned and
 * proceeded: the warning was true — "the per-IP limit is bypassable by rotating
 * that header" — and the module carried on applying a per-IP limit anyway. A
 * warning is not a limit. An anonymous caller rotating one header got unlimited
 * free scans, each spending Bright Data + Perplexity + LLM budget.
 *
 * Two honest options were on the table: refuse the scan outright, or apply a
 * limit no header can move. This module takes the SECOND, in two tiers:
 *
 *   1. the per-address bucket stays, as a COURTESY. It is the only thing that
 *      keeps one loud honest client from eating the whole allowance, and it
 *      costs nothing to keep. It is not load-bearing and is not claimed to be.
 *   2. a DEPLOYMENT-WIDE CEILING is enforced alongside it, on a bucket keyed by
 *      a constant. No request header moves it, so rotation buys at most the
 *      ceiling instead of an unbounded number of scans. This is the tier that
 *      actually bounds the money.
 *
 * Why not refuse outright: an anonymous free scan is the product's entire front
 * door, and "no proxy header declared" is the DEFAULT state of a fresh
 * self-hosted deploy. A blanket 503 there turns a misconfiguration into a total
 * outage with no partial credit, while a finite ceiling keeps the door open,
 * bounds the spend, and names the env var that restores a real per-IP limit. The
 * failure mode is honest in both directions: an abusive caller can exhaust the
 * ceiling for everyone, and when they do, the refusal says so instead of
 * claiming the caller's own address was over quota.
 *
 * What this tier deliberately does NOT cover: the Vercel platform header and an
 * operator-declared one. Both are unverifiable assertions rather than
 * caller-settable strings, which is the axis THIS ceiling is about. They are not
 * exempt from a ceiling — R0.1.24 gave them one of their own, see
 * ATTESTED_CEILING_DECISION below — they are exempt from THIS one, whose number
 * is sized for a deployment that cannot tell its callers apart at all.
 */
export const UNVERIFIED_CEILING_DECISION =
  "R0.1.22: where no client-address source exists that the caller cannot set, the per-address " +
  "bucket is kept as a courtesy AND a deployment-wide ceiling is enforced on a bucket no request " +
  "header can move. Rotating a header buys at most the ceiling, never an unbounded number of scans.";

/**
 * The ceiling, when the operator has not named one: a multiple of the per-client
 * limit. Any number here is a policy choice rather than a derivation, so it is
 * named and overridable rather than buried. Five means an unconfigured
 * deployment still serves several distinct honest clients per window, while an
 * attacker's rotation buys 5x the honest budget instead of infinity.
 */
export const UNVERIFIED_CEILING_MULTIPLIER = 5;

/**
 * The subject the ceiling bucket is hashed from.
 *
 * UPPERCASE on purpose, and that is load-bearing: `normaliseAddress` lowercases
 * every address it returns, so no header value a caller can send will ever
 * normalise to this string and collide with the ceiling bucket. A collision
 * would let a caller burn the whole deployment's allowance faster than their own
 * requests should.
 */
export const UNVERIFIED_CEILING_SUBJECT = "R0.1.22-DEPLOYMENT-UNVERIFIED-TOTAL";

/** Which limit produced a verdict. Carried in the envelope so a refusal never
 * has to guess whether it was about this caller or about everybody. */
export const BUCKET_SCOPE = Object.freeze({
  /** This address's own bucket. */
  CLIENT: "client",
  /** The ceiling every unverified caller shares. */
  DEPLOYMENT: "deployment",
});

/**
 * What the ceiling did on THIS request. Three states, not a boolean, because
 * "the ceiling was not spent because the caller was already refused" and "the
 * ceiling counter is broken" are different things and only one of them is a
 * number. Neither of them is zero.
 *
 * R0.1.24 REMOVED a fourth, `NOT_APPLICABLE`. It meant "this identity is under
 * no ceiling at all", and there is no longer such an identity — every trust
 * basis answers to one of the two tiers below. A state that can only ever be a
 * lie is worse than a missing state, so it is gone rather than left unreachable
 * for a future reader to trust.
 */
export const CEILING_STATE = Object.freeze({
  /** Read and counted; `remaining` is a measurement. */
  COUNTED: "counted",
  /** The per-address limit refused this request first, so the shared allowance
   *  was not spent on a request that was never going to start a scan. */
  SKIPPED_REFUSED_EARLIER: "skipped-refused-earlier",
  /** The counter store did not answer. Not a count of zero. */
  UNAVAILABLE: "unavailable",
});

// ---------------------------------------------------------------------------
// R0.1.24 — the two bases R0.1.22 EXEMPTED are bounded too.
// ---------------------------------------------------------------------------

/**
 * THE DECISION, recorded (R0.1.24).
 *
 * R0.1.22 put a deployment-wide ceiling on every basis whose address the caller
 * types, and exempted the two it does not: `DECLARED` (an operator-set
 * SCAN_RATE_LIMIT_IP_HEADER) and `PLATFORM_UNPROVEN` (`x-vercel-forwarded-for`
 * on Vercel). MEASURED against the module at that commit, with the real counter:
 * 60 requests rotating `x-vercel-forwarded-for` under `VERCEL=1` were allowed
 * 60/60, and 60 rotating a declared `cf-connecting-ip` were allowed 60/60, both
 * with `ceiling.state = not-applicable`. The rotating `x-real-ip` control was
 * allowed 25/60. POST /api/scan is ALLOW_PUBLIC in the operator perimeter
 * (src/server/operatorPerimeter.js), so the caller driving those 60 requests holds
 * no credential of any kind, and each allowed request starts a scan that spends
 * scrape + probe + LLM budget. An unbounded anonymous spend path.
 *
 * Both exemptions rest on the same thing: an assertion made OUTSIDE the request
 * that this module cannot check from inside one. Vercel is DOCUMENTED to strip
 * inbound `x-vercel-*`, and nobody here has forged it against the deployed
 * origin (TRUST_RESTORE_CHECK). An operator DECLARES the header their proxy
 * overwrites, and nothing proves their proxy overwrites it — a declaration of a
 * header the proxy merely passes through is forgeable by every caller, and looks
 * identical from here.
 *
 * So: no basis is exempt. Both of those bases get a ceiling OF THEIR OWN — a
 * second bucket, its own subject, its own much larger limit, its own env
 * override — rather than being folded into the unverified ceiling. Two reasons,
 * both about honesty:
 *
 *   1. folding them in would cap a correctly-configured deployment behind
 *      Cloudflare, serving many distinct honest clients, at the same 25 scans
 *      per window as a deployment that cannot tell its callers apart. That is
 *      not a bound on abuse, it is an outage for the configured case, and it
 *      would train operators to raise the knob until it means nothing.
 *   2. the two are different incidents. "The ceiling for addresses we cannot
 *      verify ran out" and "the ceiling for addresses we merely cannot PROVE ran
 *      out" call for different operator action, and a shared bucket would report
 *      them as one.
 *
 * What the attested ceiling is: a catastrophe bound, not a per-IP substitute. It
 * is deliberately far above honest traffic, so in the expected case (the
 * attestation is true) nobody ever meets it, and in the failure case (the header
 * is forgeable) rotation buys that number of scans per window instead of an
 * unbounded number. It does NOT restore trust and does not close
 * RESTORE-TRUST-R0.1.20: the forge-check is still owed, and until it runs this
 * ceiling is the only thing standing between a forgeable header and the budget.
 *
 * The cost, stated: an attacker who CAN forge the attested header can exhaust
 * the shared allowance for every honest caller on the deployment, exactly as
 * R0.1.22 accepted for the unverified tier. That is why the number is large,
 * why exhaustion is announced on its own latch, and why the announcement names
 * the knob that raises it.
 */
export const ATTESTED_CEILING_DECISION =
  "R0.1.24: no trust basis is exempt from a ceiling. An operator-declared header and the Vercel " +
  "platform header are attestations made outside the request that nothing in code can verify, so " +
  "they answer to their own deployment-wide ceiling on a bucket no request header can move — far " +
  "above honest traffic, finite, and separate from the unverified tier's.";

/**
 * WHICH ceiling an identity answers to. Every basis maps to one of these; there
 * is no third value meaning "none".
 */
export const CEILING_TIER = Object.freeze({
  /** The caller typed the address, or there was none: R0.1.22's ceiling. */
  UNVERIFIED: "unverified",
  /** Something outside the request asserted the address: R0.1.24's ceiling. */
  ATTESTED: "attested",
});

/**
 * The bases whose address the caller cannot choose IF the attestation behind
 * them holds: an operator-declared proxy header, and the platform header on
 * Vercel. Everything else — `x-real-ip`, `x-forwarded-for`, and no header at
 * all — is the caller's word, and an unknown basis counts as the caller's word
 * too, because closed is the safe direction.
 */
const ATTESTED_BASES = new Set([TRUST_BASIS.DECLARED, TRUST_BASIS.PLATFORM_UNPROVEN]);

/**
 * Which ceiling tier this identity answers to. Never null: an identity outside
 * every tier would be the unbounded anonymous spend path R0.1.24 closed, so an
 * unclassified basis falls to the STRICTER tier rather than out of the system.
 */
export function ceilingTierFor(identity) {
  return ATTESTED_BASES.has(identity?.trustBasis) ? CEILING_TIER.ATTESTED : CEILING_TIER.UNVERIFIED;
}

/**
 * The attested tier's default, as a multiple of the per-client limit. 40 x 5 =
 * 200 scans per window on a default deployment: a number an honest Vercel
 * deployment at this stage of the product does not reach, and one an attacker
 * rotating a forgeable header reaches in seconds and then stops. Like
 * UNVERIFIED_CEILING_MULTIPLIER it is a policy choice rather than a derivation,
 * so it is named and overridable rather than buried.
 */
export const ATTESTED_CEILING_MULTIPLIER = 40;

/**
 * The subject the attested tier's bucket is hashed from. UPPERCASE for the same
 * load-bearing reason as UNVERIFIED_CEILING_SUBJECT: `normaliseAddress`
 * lowercases every address, so no header value can normalise to this string and
 * collide with the bucket that bounds the whole deployment.
 */
export const ATTESTED_CEILING_SUBJECT = "R0.1.24-DEPLOYMENT-ATTESTED-TOTAL";

/** The subject each tier's bucket is hashed from. */
const CEILING_SUBJECT = Object.freeze({
  [CEILING_TIER.UNVERIFIED]: UNVERIFIED_CEILING_SUBJECT,
  [CEILING_TIER.ATTESTED]: ATTESTED_CEILING_SUBJECT,
});

/** The env var an operator raises to move each tier, named for log copy. */
export const CEILING_KNOB = Object.freeze({
  [CEILING_TIER.UNVERIFIED]: "SCAN_RATE_LIMIT_UNVERIFIED_CEILING",
  [CEILING_TIER.ATTESTED]: "SCAN_RATE_LIMIT_ATTESTED_CEILING",
});

/**
 * How many scans this deployment gets per window, in total, for one tier.
 * The tier's env var overrides; garbage falls back to the derived value rather
 * than to 0 (which would refuse everything) or to infinity.
 *
 * The two env reads are written out LITERALLY, one per branch, and must stay
 * that way: the documentation guard in rateLimit.test.mjs discovers this
 * module's knobs by matching `env.SCAN_RATE_LIMIT*` in this source, so folding
 * these into `env[CEILING_KNOB[tier]]` would hide a live knob from the guard
 * that exists to stop an undocumented one shipping.
 */
export function resolveCeiling(env = process.env, clientLimit = DEFAULTS.limit, tier = CEILING_TIER.UNVERIFIED) {
  const attested = tier === CEILING_TIER.ATTESTED;
  const raw = Number(
    attested ? env.SCAN_RATE_LIMIT_ATTESTED_CEILING : env.SCAN_RATE_LIMIT_UNVERIFIED_CEILING
  );
  const multiplier = attested ? ATTESTED_CEILING_MULTIPLIER : UNVERIFIED_CEILING_MULTIPLIER;
  if (Number.isFinite(raw) && raw > 0) return { tier, limit: Math.floor(raw), declared: true };
  return { tier, limit: clientLimit * multiplier, declared: false };
}

/**
 * The unverified tier, by its R0.1.22 name. Kept because the operator ledger and
 * the tests that pin the R0.1.22 behaviour call it, and because "the ceiling for
 * an unverified deployment" is the thing an operator looks up.
 */
export function resolveUnverifiedCeiling(env = process.env, clientLimit = DEFAULTS.limit) {
  return resolveCeiling(env, clientLimit, CEILING_TIER.UNVERIFIED);
}

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
 * guessed at. "Closed" here means the platform header is not READ at all — it
 * has not been a trusted source since R0.1.20, but off Vercel it is not even an
 * address.
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
        `${PLATFORM_IP_HEADER} is NOT trusted and is not read as the client address at all.`
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
  [PLATFORM_IP_HEADER]:
    "on Vercel this module already reads it without a declaration (and withholds trust from it " +
    "pending RESTORE-TRUST-R0.1.20); off Vercel nothing strips it",
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
  // reaches here (hex in IPv6, DNS labels in a hostname, digits in IPv4).
  const value = String(raw ?? "").trim().toLowerCase();
  if (!value) return "";

  // `[2001:db8::1]:443` and `[2001:db8::1]` are one client. A port is never
  // part of who the client is, and on the caller-settable fallback headers a
  // port that DID count would let one caller mint a fresh budget per port.
  const bracketed = /^\[([^\]]+)\](?::\d{1,5})?$/.exec(value);
  if (bracketed) return bracketed[1];

  // Exactly one colon, so a bare IPv6 (which has at least two) is left alone
  // and a zone ID (`fe80::1%eth0`) survives. Not restricted to IPv4: a declared
  // header can carry `proxy.example:8080`.
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
  const out = (ip, source, trusted, trustBasis) => ({ ip, source, trusted, trustBasis, configWarning });

  // Either marker, because the cost of getting this wrong is asymmetric: a
  // false negative demotes the best address this platform has back to the
  // spoofable fallback and the limit quietly stops being per-IP. `VERCEL` is
  // the documented one; `VERCEL_URL` is the one scanWorker.js already depends
  // on being present in this deployment, so it is checked as corroboration.
  //
  // Read FIRST but labelled `trusted: false` (R0.1.20). Order and label are
  // separate decisions: the ordering picks the address least under the caller's
  // control, the label says whether anyone has PROVED that. Nobody has —
  // RESTORE-TRUST-R0.1.20.
  if (runtime.onVercel) {
    const platform = read(PLATFORM_IP_HEADER);
    if (platform) return out(platform, PLATFORM_IP_HEADER, false, TRUST_BASIS.PLATFORM_UNPROVEN);
  }

  if (declaration.header) {
    const value = read(declaration.header);
    if (value) return out(value, declaration.header, true, TRUST_BASIS.DECLARED);
  }

  const realIp = read("x-real-ip");
  if (realIp) return out(realIp, "x-real-ip", false, TRUST_BASIS.CALLER_SETTABLE);

  const forwarded = read("x-forwarded-for");
  if (forwarded) return out(forwarded, "x-forwarded-for", false, TRUST_BASIS.CALLER_SETTABLE);

  // No identifiable client at all: bucket every such request together rather
  // than letting them all through unlimited. A shared bucket throttles; no
  // bucket does nothing.
  return out(null, "none", false, TRUST_BASIS.ABSENT);
}

/**
 * What to say about an address nobody vouches for. One sentence per BASIS,
 * because "the caller typed this" and "the platform probably wrote this but we
 * never checked" call for different operator action and must not be reported
 * with one message.
 */
export function untrustedSourceWarning(identity, ceilingLimit = null) {
  const declare =
    ` Set SCAN_RATE_LIMIT_IP_HEADER to the single header your proxy OVERWRITES on every inbound request.`;
  // Named when we know it. A message that says "a ceiling" when the number is
  // right there would make an operator go looking for it.
  const ceiling = Number.isFinite(ceilingLimit)
    ? `${ceilingLimit} scans per window`
    : `a fixed number of scans per window`;

  if (identity.trustBasis === TRUST_BASIS.PLATFORM_UNPROVEN) {
    return (
      `[rate-limit] client address taken from ${PLATFORM_IP_HEADER} on a Vercel deployment. ` +
      `The limit IS applied to that address and the bucket is unchanged, but this build does NOT ` +
      `vouch for it: nothing has proved the edge overwrites an inbound copy of that header, so if ` +
      `it does not, a forged one puts the caller in a bucket of their choosing. Reported ` +
      `trusted:false until ${TRUST_RESTORE_CHECK}. Because that is unproven, every caller on this ` +
      `address source also answers to the R0.1.24 attested ceiling of ${ceiling}, deployment-wide ` +
      `— so a forged header buys that many scans per window, not an unbounded number.`
    );
  }

  if (identity.trustBasis === TRUST_BASIS.ABSENT) {
    return (
      `[rate-limit] no client address header on this request: every such caller shares ONE bucket, ` +
      `so the limit is real but not per-IP. This deployment is also under the R0.1.22 ceiling of ` +
      `${ceiling} shared by every caller whose address it cannot verify.` + declare
    );
  }

  return (
    `[rate-limit] client address taken from ${identity.source}, which the caller can set: a limit ` +
    `keyed on it alone is bypassable by rotating that header, so it is NOT the only limit applied ` +
    `here. Every caller whose address this deployment cannot verify also answers to one shared ` +
    `ceiling of ${ceiling} (R0.1.22) — real, and deployment-wide, so one abusive caller can ` +
    `exhaust it for everyone.` + declare
  );
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
  return bucketKeyFor(subject, salt);
}

/** One hash, so the ceiling bucket and an address bucket cannot drift apart. */
function bucketKeyFor(subject, salt) {
  return crypto.createHash("sha256").update(`${salt}:${subject}`).digest("hex").slice(0, 32);
}

/**
 * The bucket every caller in one ceiling tier shares (R0.1.22, R0.1.24). Takes
 * no header, on purpose: that is the whole property. Same salt as the address
 * buckets, so it is still per-deployment, and the same counter table
 * (`scan_rate_limits`, migration 009) — neither tier needs a migration.
 *
 * An unrecognised tier THROWS rather than defaulting to a subject. A typo that
 * silently picked the unverified bucket would let attested traffic spend a
 * stranger's allowance, and one that silently picked a fresh unnamed subject
 * would be a ceiling nobody is counted against.
 */
export function ceilingBucketKey({ tier, salt = "" } = {}) {
  const subject = CEILING_SUBJECT[tier];
  if (!subject) throw new TypeError(`ceilingBucketKey: unknown ceiling tier ${JSON.stringify(tier)}`);
  return bucketKeyFor(subject, salt);
}

/** The R0.1.22 tier's bucket, by its original name. */
export function unverifiedCeilingBucketKey({ salt = "" } = {}) {
  return ceilingBucketKey({ tier: CEILING_TIER.UNVERIFIED, salt });
}

/** The R0.1.24 tier's bucket: an attested but unproven address source. */
export function attestedCeilingBucketKey({ salt = "" } = {}) {
  return ceilingBucketKey({ tier: CEILING_TIER.ATTESTED, salt });
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
 *
 * TWO counters when the address is one the caller could have typed (R0.1.22):
 * this address's bucket, and the ceiling every unverified caller shares. The
 * verdict is the more restrictive of the two, and `limitScope` says which one
 * decided — a refusal that came from the shared ceiling must not be reported to
 * the caller as "your address is over quota", because it is not about them.
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
  const salt = env.SCAN_RATE_LIMIT_SALT || "";
  const bucketKey = clientBucketKey({ header, salt, env });
  const startedAt = windowStart(now, windowMs);

  // EVERY identity is under a ceiling (R0.1.24). Which one depends on the trust
  // basis, and an unclassified basis lands in the stricter tier — there is no
  // branch here that leaves a caller uncounted.
  const tier = ceilingTierFor(identity);
  const ceiling = resolveCeiling(env, limit, tier);
  const ceilingKey = ceilingBucketKey({ tier, salt });
  /**
   * The ceiling's side of the envelope. `remaining` is a number in exactly one
   * state — the one where it was measured. Everywhere else it is null, because
   * a ceiling that did not run has no remaining count and 0 would read as
   * "exhausted".
   */
  const ceilingReport = (state, remaining = null) => ({
    state,
    tier,
    limit: ceiling.limit,
    remaining,
    bucketKey: ceilingKey,
    declared: ceiling.declared,
  });
  const degradedEnvelope = (ceilingState) => ({
    allowed: true,
    degraded: true,
    limit,
    remaining: null,
    retryAfterSec: 0,
    limitScope: null,
    bucketKey,
    source: identity.source,
    trusted: identity.trusted,
    trustBasis: identity.trustBasis,
    clientLimit: limit,
    clientRemaining: null,
    ceiling: ceilingState,
  });

  // A trust knob that was set and could not be honoured is reported first and
  // separately (R0.1.18): the operator believes this limit is per-IP because
  // they configured it to be, so silence here would be the most expensive
  // silence in the module.
  if (identity.configWarning && !warnedTrustConfig) {
    warnedTrustConfig = true;
    logger.warn(identity.configWarning);
  }

  // An address nobody vouches for is announced — once per process PER BASIS,
  // so it lands on every cold start without drowning the log and without one
  // state's warning silencing a different one — and `trusted` is carried out in
  // the envelope so the decision is never read as "this address has had 5
  // scans" when it only means "this claim has".
  //
  // On Vercel this now fires for the platform header too (R0.1.20): one line
  // per process saying the label was withheld, rather than a silent
  // `trusted: true` that nothing has earned.
  if (!identity.trusted && !warnedUntrustedBases.has(identity.trustBasis)) {
    warnedUntrustedBases.add(identity.trustBasis);
    logger.warn(untrustedSourceWarning(identity, ceiling.limit));
  }

  let hits;
  try {
    hits = await increment({ bucketKey, windowStart: startedAt });
  } catch (err) {
    logger.warn(
      `[rate-limit] counter unavailable (${err.message}) — allowing this scan. ` +
        `The one-running-scan-per-brand index still applies.`
    );
    // The ceiling shares that counter, so it did not run either. Reported
    // UNAVAILABLE, never as an absent ceiling: this identity IS under one, and
    // "we did not check" must not read as "there was nothing to check".
    return degradedEnvelope(ceilingReport(CEILING_STATE.UNAVAILABLE));
  }

  if (!Number.isFinite(hits)) {
    logger.warn("[rate-limit] counter returned a non-numeric count — allowing this scan.");
    return degradedEnvelope(ceilingReport(CEILING_STATE.UNAVAILABLE));
  }

  const windowStartMs = Date.parse(startedAt);
  const client = evaluate({ hits, limit, windowMs, nowMs: now, windowStartMs });

  // The tier that actually bounds the money: for a caller-settable address the
  // R0.1.22 ceiling, for an attested one the R0.1.24 ceiling. One of the two
  // always runs.
  //
  // Counted only for a request the per-address tier ALLOWED, deliberately. The
  // ceiling is a bound on scans this deployment would start, and a request its
  // own bucket already refused starts nothing and spends nothing — charging the
  // shared allowance for it would let one caller hammering ONE address take the
  // deployment down for everybody without ever getting a scan. Rotation, which
  // is the attack this ceiling exists for, always passes the per-address tier
  // (every forged address is a fresh bucket), so nothing escapes by this door.
  let deployment = null;
  if (client.allowed) {
    let ceilingHits;
    try {
      ceilingHits = await increment({ bucketKey: ceilingKey, windowStart: startedAt });
    } catch (err) {
      logger.warn(
        `[rate-limit] the ${tier} deployment ceiling counter is unavailable (${err.message}) — ` +
          `allowing this scan. This address is not one this deployment can prove, so nothing but ` +
          `the one-running-scan-per-brand index bounds an anonymous caller until the counter is back.`
      );
      return degradedEnvelope(ceilingReport(CEILING_STATE.UNAVAILABLE));
    }
    if (!Number.isFinite(ceilingHits)) {
      logger.warn(
        `[rate-limit] the ${tier} deployment ceiling counter returned a non-numeric count — ` +
          `allowing this scan and reporting the ceiling as unmeasured, not as zero.`
      );
      return degradedEnvelope(ceilingReport(CEILING_STATE.UNAVAILABLE));
    }
    deployment = evaluate({
      hits: ceilingHits,
      limit: ceiling.limit,
      windowMs,
      nowMs: now,
      windowStartMs,
    });
  }

  // A refusal wins over a remaining count, and this address's own refusal is
  // reported ahead of the shared one: if both are exhausted, "you are over quota"
  // is the more actionable of the two true statements.
  const bindingIsDeployment =
    Boolean(deployment) &&
    client.allowed &&
    (!deployment.allowed || deployment.remaining < client.remaining);
  const binding = bindingIsDeployment ? deployment : client;

  // The product is down for every caller in this tier. One line per process PER
  // TIER, because this is not the same incident as "we cannot verify addresses
  // here" — that one is a configuration, this one is an outage — and the two
  // tiers running out are not the same incident as each other either.
  if (deployment && !deployment.allowed && !warnedCeilingsExhausted.has(tier)) {
    warnedCeilingsExhausted.add(tier);
    logger.warn(
      tier === CEILING_TIER.ATTESTED
        ? `[rate-limit] the R0.1.24 attested deployment ceiling (${ceiling.limit} scans per window, ` +
            `shared by every caller whose address came from ${identity.source} — an assertion made ` +
            `outside the request that nothing in code can verify) is EXHAUSTED: scans on that ` +
            `address source are refused until the window rolls. ${ATTESTED_CEILING_DECISION} ` +
            `If honest traffic reached this, raise SCAN_RATE_LIMIT_ATTESTED_CEILING knowing what it ` +
            `buys. If it did not, that header is being FORGED and this ceiling is the only thing ` +
            `bounding the spend: ${TRUST_RESTORE_CHECK}.`
        : `[rate-limit] the R0.1.22 deployment ceiling (${ceiling.limit} scans per window, shared by ` +
            `every caller whose address this deployment cannot verify) is EXHAUSTED: anonymous scans ` +
            `are refused until the window rolls. ${UNVERIFIED_CEILING_DECISION} ` +
            `Set SCAN_RATE_LIMIT_IP_HEADER to the single header your proxy OVERWRITES to get a real ` +
            `per-IP limit back, or raise SCAN_RATE_LIMIT_UNVERIFIED_CEILING knowing what it buys.`
    );
  }

  return {
    allowed: binding.allowed,
    limit: binding.limit,
    remaining: binding.remaining,
    retryAfterSec: binding.retryAfterSec,
    limitScope: bindingIsDeployment ? BUCKET_SCOPE.DEPLOYMENT : BUCKET_SCOPE.CLIENT,
    degraded: false,
    bucketKey,
    source: identity.source,
    trusted: identity.trusted,
    trustBasis: identity.trustBasis,
    clientLimit: limit,
    clientRemaining: client.remaining,
    ceiling: deployment
      ? ceilingReport(CEILING_STATE.COUNTED, deployment.remaining)
      : ceilingReport(CEILING_STATE.SKIPPED_REFUSED_EARLIER),
  };
}
