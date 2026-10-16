import { normalizeUrl } from "../scoring/citations.js";
import { resolveSerpGeo } from "./serpGeo.js";
import {
  classifyHttpStatus,
  FAILURE_KIND,
  tagHttpFailure,
} from "./httpFailureKind.js";
import {
  GOOGLE_PAYLOAD_PARSER_VERSION,
  SERP_STATE,
  parseGoogleSerp,
} from "./googlePayload.js";

/**
 * Typed Bright Data zone failure (R1.2.7, finding C4).
 *
 * A zone problem is a CONFIGURATION failure, not a probe failure, and the two
 * have to be told apart: one bad zone produces N identical "HTTP 400" rows that
 * read as N flaky queries. Callers that can act on it (check-secrets, the
 * fleet) match on `name`/`reason` rather than on message text; callers that only
 * record it still get a message naming the zone and the consequence.
 *
 * Matched by name as well as by instance because Next can load a module twice
 * (server bundle and route bundle), which makes `instanceof` alone unreliable
 * here -- same reasoning as isLlmUnavailable in src/lib/llmErrors.js.
 */
export class BrightDataZoneError extends Error {
  /**
   * @param {string} message human-readable cause and consequence
   * @param {{reason?: "no_active_zone"|"zone_rejected"|"lookup_failed"|"bad_ttl_config", zone?: string|null, cause?: unknown}} [meta]
   */
  constructor(message, meta = {}) {
    super(message);
    this.name = "BrightDataZoneError";
    /** Machine-readable discriminator; see the union in the param doc. */
    this.reason = meta.reason || "no_active_zone";
    /** The zone the failure is about, when one is known. */
    this.zone = meta.zone ?? null;
    if (meta.cause !== undefined) this.cause = meta.cause;
  }
}

export function isBrightDataZoneError(err) {
  return Boolean(err) && (err instanceof BrightDataZoneError || err.name === "BrightDataZoneError");
}

/**
 * A 200 that carried something other than a usable Google SERP (R04, A10).
 *
 * The audit's reproduced defect is precisely the absence of this type: the
 * retry loop only ran its truncation check while attempts remained, so on the
 * LAST attempt a payload of the wrong shape fell straight through to
 * `normalizeBrightDataResponse` and was returned as though it were a SERP. A
 * downstream parser then read no text and no citations and scored a
 * non-mention — a provider/parse failure wearing a brand-absence costume.
 *
 * `serp_state` and `evidence` are copied off the parser result so the failure
 * is auditable: the reason names which stage rejected it, and the evidence
 * carries the derived payload id, the parser version, the provider request id
 * and the validation errors — enough to reopen the exact payload without it
 * ever being mistaken for an answer.
 *
 * Matched by name as well as instance for the same double-load reason as the
 * zone error above.
 */
export class BrightDataParseError extends Error {
  constructor(message, meta = {}) {
    super(message);
    this.name = "BrightDataParseError";
    this.reason = meta.reason || "malformed";
    this.serp_state = meta.serp_state ?? meta.reason ?? null;
    /**
     * What the parser said about AI Overview PRESENCE, carried on the error.
     *
     * `null` on every failure, and that is the point: a payload that could not
     * be validated must not reach a caller with a readable boolean it could
     * mistake for "no AI Overview was seen". Null here means unknown, never
     * absent — the same rule SERP_STATE applies to the parser result.
     */
    this.aio_present = meta.aio_present ?? null;
    this.evidence = meta.evidence ?? null;
    if (meta.attempts !== undefined) this.attempts = meta.attempts;
    if (meta.cause !== undefined) this.cause = meta.cause;
  }
}

export function isBrightDataParseError(err) {
  return Boolean(err) && (err instanceof BrightDataParseError || err.name === "BrightDataParseError");
}

/**
 * The request was refused or aborted before it could finish inside its budget
 * (R04.4b / R04-19).
 *
 * Distinct from a parse or zone failure because the operator action is
 * different: nothing is broken, the chunk simply ran out of lease. The refusal
 * happens BEFORE dispatch, so a probe that could not finish never spends a
 * request or leaves paid work abandoned.
 */
export class BrightDataDeadlineError extends Error {
  constructor(message, meta = {}) {
    super(message);
    this.name = "BrightDataDeadlineError";
    this.reason = meta.reason || "deadline_exceeded";
    if (meta.remainingMs !== undefined) this.remainingMs = meta.remainingMs;
    if (meta.minDispatchMs !== undefined) this.minDispatchMs = meta.minDispatchMs;
    if (meta.cause !== undefined) this.cause = meta.cause;
  }
}

export function isBrightDataDeadlineError(err) {
  return Boolean(err) && (err instanceof BrightDataDeadlineError || err.name === "BrightDataDeadlineError");
}

/**
 * How long an AUTO-DISCOVERED zone name may be reused before it is re-checked.
 *
 * THE POLICY, and why this number (R1.2.7):
 *
 * The old cache was a bare module-level string with no invalidator. In a Vercel
 * function that is nearly free -- the module reloads every few minutes anyway --
 * but the R1.2 fleet container runs for days, so a zone suspended at 09:00 was
 * still being sent to /request at 17:00, turning one configuration fault into an
 * unbounded run of failed probes that nothing attributed to its cause.
 *
 * Three levers, deliberately COMBINED rather than chosen between, because each
 * covers a case the others miss:
 *
 *  1. THIS TTL bounds staleness by the clock with no cooperation from any
 *     caller. It is the only lever that works for the web app, which never gets
 *     a chance to call an invalidator.
 *  2. `invalidateBrightDataZoneCache()` lets the fleet force a re-check on its
 *     own schedule (e.g. once per poll cycle) without waiting out the TTL.
 *  3. Probe-time rejection (`zoneRejectedError` below) drops the cache the
 *     moment Bright Data itself says the zone is gone -- recovery after ONE
 *     failed probe rather than after one TTL.
 *
 * Five minutes, not per-probe: `get_all_zones` is a real network round trip.
 * Re-listing before every probe would turn one control-plane call per process
 * into one per query (~30 extra calls per scan), and a Bright Data API blip
 * would then take out probes a cached name would have served. Five minutes
 * costs at most 12 calls/hour per container, and is longer than a typical
 * serverless invocation, so the web app's cost profile is unchanged: one lookup
 * per process, exactly as before. Lever 3 is what makes a TTL this long safe --
 * the clock is the backstop, not the primary detector.
 *
 * Override with BRIGHTDATA_ZONE_TTL_MS. 0 means "never cache" (re-check on
 * every resolve), which is a legitimate setting for a debugging session.
 */
export const DEFAULT_BRIGHTDATA_ZONE_TTL_MS = 5 * 60 * 1000;

/**
 * How long the zone-discovery lookup may take (R04.4a).
 *
 * `get_all_zones` used to be an UNBOUNDED fetch: a hung control-plane call
 * blocked the probe forever, and because the SERP request was only issued after
 * the lookup returned, the paid request never happened but neither did anything
 * else. Bounding the lookup means a configuration fetch that hangs fails inside
 * its own deadline (a typed `lookup_failed`) and no SERP dispatch follows, which
 * is what R04-18 pins. Ten seconds: the lookup is a small JSON list and this is
 * longer than a normal round trip while still far inside a scan's lease.
 */
export const DEFAULT_BRIGHTDATA_ZONE_LOOKUP_TIMEOUT_MS = 10 * 1000;

/**
 * The smallest slice of remaining budget a probe will dispatch into (R04.4b).
 *
 * A request started with less than this cannot finish before its deadline, so
 * the honest move is to refuse it (typed `insufficient_time`) rather than leave
 * paid work abandoned and unusable. Only consulted when the caller supplies a
 * deadline; a caller with no deadline is making no such promise.
 */
export const DEFAULT_BRIGHTDATA_MIN_DISPATCH_MS = 1500;

/**
 * The auto-discovery cache: `{ name, at }` or null.
 *
 * Deliberately NOT a bare string. The timestamp IS the policy -- a name with no
 * age attached cannot be expired, which is exactly how the old cache went stale
 * invisibly.
 */
let cachedZone = null;

/**
 * Resolve the TTL, failing loud on a malformed value.
 *
 * A typo'd BRIGHTDATA_ZONE_TTL_MS silently falling back to the default is the
 * same class of lie this task exists to remove: the operator would believe they
 * had set a 30s re-check and get 5 minutes. Unparseable is a configuration
 * error and says so.
 */
export function brightDataZoneTtlMs(env = process.env) {
  const raw = String(env.BRIGHTDATA_ZONE_TTL_MS ?? "").trim();
  if (!raw) return DEFAULT_BRIGHTDATA_ZONE_TTL_MS;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    throw new BrightDataZoneError(
      `BRIGHTDATA_ZONE_TTL_MS="${raw}" is not a non-negative whole number of milliseconds. ` +
        `Refusing to guess: this value decides how long a dead zone keeps being used.`,
      { reason: "bad_ttl_config" }
    );
  }
  return n;
}

/**
 * Drop the auto-discovery cache so the next resolve re-lists zones.
 *
 * Returns the name that was dropped, or null when nothing was cached -- a
 * cleared cache and an already-empty one are different events, and a caller
 * counting invalidations must be able to tell them apart (standing rule 1).
 *
 * Exported for the R1.2 fleet, which can call it once per poll cycle to satisfy
 * "re-checked at least once per poll cycle" without waiting out the TTL. It is a
 * no-op when BRIGHTDATA_SERP_ZONE is set, because that path never caches.
 */
export function invalidateBrightDataZoneCache(reason = "explicit") {
  if (!cachedZone) return null;
  const { name } = cachedZone;
  cachedZone = null;
  console.log(
    `[brightdata] SERP zone cache invalidated (${reason}); was "${name}" -- the next resolve re-lists zones`
  );
  return name;
}

/**
 * Read the cache without touching it: `{ name, ageMs }` or null.
 *
 * For diagnostics and tests -- "nothing cached" must be observably different
 * from "cached and fresh", which a bare boolean or a bare string cannot say.
 */
export function peekBrightDataZoneCache() {
  return cachedZone ? { name: cachedZone.name, ageMs: Date.now() - cachedZone.at } : null;
}

export function getBrightDataApiKey() {
  return (process.env.BRIGHTDATA_API_KEY || "").trim() || null;
}

export async function resolveBrightDataSerpZone(apiKey = getBrightDataApiKey(), options = {}) {
  const configuredZone = (process.env.BRIGHTDATA_SERP_ZONE || "").trim();
  if (configuredZone) return configuredZone;

  const ttlMs = brightDataZoneTtlMs();
  if (cachedZone && Date.now() - cachedZone.at < ttlMs) return cachedZone.name;

  const staleName = cachedZone?.name || null;

  if (!apiKey) {
    // A name that can no longer be re-verified is not an answer. Returning it
    // would be the original bug with extra steps.
    if (staleName) invalidateBrightDataZoneCache("TTL expired and no API key is available to re-verify");
    return null;
  }

  // R04.4a — the lookup runs under its own deadline, capped by whatever is left
  // of the caller's overall budget so a probe near its lease end cannot spend
  // the remainder waiting on a control-plane call.
  //
  // THE TIMER IS ARMED FOR THE WHOLE LOOKUP, NOT JUST THE HEADERS. It used to be
  // cleared in a `finally` that ended the moment `fetch()` resolved, with
  // `await res.json()` sitting BELOW it — so a control plane that sent headers
  // and then stalled its body held the probe open indefinitely: measured on a
  // local server, a 150ms lookup timeout resolved successfully after 616ms
  // against a body delayed by 600ms, and `zoneLookupTimeoutMs` bounded nothing.
  // Fetching, reading, decoding and the abort-to-typed-error conversion are all
  // inside this try for that reason; anything that waits on the network belongs
  // under the timer.
  const lookupTimeoutMs = zoneLookupTimeoutMs(options);
  const controller = new AbortController();
  const timer = lookupTimeoutMs > 0 ? setTimeout(() => controller.abort(), lookupTimeoutMs) : null;

  let zones;
  try {
    const res = await fetch("https://api.brightdata.com/zone/get_all_zones", {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: controller.signal,
    });

    if (!res.ok) {
      // A re-check that could not be COMPLETED is not evidence the zone died, so
      // the cached name is kept -- but its timestamp is NOT refreshed, so the very
      // next call retries the lookup instead of trusting an unverified name for
      // another full TTL. The rejected alternative was a grace window that keeps
      // serving the stale name through an API outage: that is precisely the
      // fail-soft this task removes, and it would hide a dead zone for as long as
      // the control plane stayed unreachable.
      throw new BrightDataZoneError(`Bright Data zone lookup failed: HTTP ${res.status}`, {
        reason: "lookup_failed",
        zone: staleName,
      });
    }

    zones = await res.json();
  } catch (err) {
    // Already typed by the branch above: re-wrapping it would bury the real
    // cause under "BrightDataZoneError: ...".
    if (isBrightDataZoneError(err)) throw err;
    // A lookup that did not COMPLETE is not evidence the zone died, so the
    // cached name is kept (its timestamp untouched) — and the failure is typed
    // so the caller records a configuration error rather than dispatching a
    // SERP request it can no longer justify.
    throw new BrightDataZoneError(
      `Bright Data zone lookup failed: ${err?.name === "AbortError" ? `timed out after ${lookupTimeoutMs}ms` : err?.message || String(err)}`,
      { reason: "lookup_failed", zone: staleName, cause: err }
    );
  } finally {
    if (timer) clearTimeout(timer);
  }

  const activeSerpZone = (zones || []).find(
    (z) => z.type === "serp" && z.status === "active"
  );

  if (!activeSerpZone?.name) {
    // The first sentence of this message is load-bearing: check-secrets surfaces
    // it verbatim to the operator and pins it in a test.
    if (staleName) invalidateBrightDataZoneCache("re-check found no active serp zone");
    throw new BrightDataZoneError(
      "No active Bright Data SERP zone found on this account." +
        (staleName
          ? ` The zone "${staleName}" this process had been using is no longer active; it has been dropped rather than reused.`
          : ""),
      { reason: "no_active_zone", zone: staleName }
    );
  }

  cachedZone = { name: activeSerpZone.name, at: Date.now() };
  if (!staleName) {
    console.log(`[brightdata] Auto-discovered SERP zone: ${cachedZone.name}`);
  } else if (staleName === cachedZone.name) {
    // A re-check that changed nothing still has to be visible, or "the TTL never
    // fired" and "the TTL fired and the zone is fine" look identical in the log.
    console.log(`[brightdata] SERP zone re-checked (TTL ${ttlMs}ms): "${cachedZone.name}" still active`);
  } else {
    console.log(`[brightdata] SERP zone CHANGED on re-check: "${staleName}" -> "${cachedZone.name}"`);
  }
  return cachedZone.name;
}

/**
 * Resolve the lookup deadline: the caller's explicit zone timeout if given,
 * otherwise the default, always capped by what remains of the overall budget.
 */
function zoneLookupTimeoutMs(options = {}) {
  let timeout =
    options.zoneLookupTimeoutMs != null
      ? options.zoneLookupTimeoutMs
      : DEFAULT_BRIGHTDATA_ZONE_LOOKUP_TIMEOUT_MS;
  if (options.deadlineAt != null) {
    const remaining = options.deadlineAt - Date.now();
    if (remaining <= 0) return 0;
    timeout = Math.min(timeout, remaining);
  }
  return timeout;
}

/** Remaining budget in ms for an absolute deadline, or null with no deadline. */
function remainingBudget(deadlineAt) {
  return deadlineAt == null ? null : deadlineAt - Date.now();
}

/**
 * Sleep, but never past the deadline (R04.4a — retry delays are part of the
 * bounded request). A zero-remaining budget returns immediately so the next
 * loop iteration can raise the deadline error rather than the delay swallowing
 * it.
 */
async function delayWithinDeadline(ms, deadlineAt) {
  if (ms <= 0) return;
  const remaining = remainingBudget(deadlineAt);
  const wait = remaining == null ? ms : Math.min(ms, Math.max(0, remaining));
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
}

export async function getBrightDataConfig(options = {}) {
  const apiKey = getBrightDataApiKey();
  if (!apiKey) return null;

  const zone = await resolveBrightDataSerpZone(apiKey, options);
  if (!zone) return null;

  return { apiKey, zone };
}

function normalizeBrightDataResponse(data) {
  if (!data || typeof data !== "object") return data;

  let payload = data;
  if (data.body !== undefined) {
    if (typeof data.body === "string") {
      try {
        payload = data.body ? JSON.parse(data.body) : data;
      } catch {
        payload = data;
      }
    } else {
      payload = data.body;
    }
  }

  return payload || data;
}

/**
 * Bright Data's proxy wraps its own session/routing failures (e.g. a
 * "no ready cookies" session-pool exhaustion for a geo) in an HTTP 200
 * envelope with an empty `body` — not a rate limit, not truncation, just
 * "this attempt got no page". Surface it with its real cause instead of
 * letting downstream code try to double-parse an empty body string.
 */
function proxySessionError(data) {
  const brdError = data?.headers?.["x-brd-error"] || data?.headers?.["x-brd-error-code"];
  const statusCode = data?.status_code;
  const bodyEmpty = data?.body === "" || data?.body === undefined;
  if (brdError && bodyEmpty) return brdError;
  if (statusCode && statusCode >= 400 && bodyEmpty) return `proxy status ${statusCode}`;
  return null;
}

function buildGoogleSearchUrl(query, { geo = resolveSerpGeo(), aiOverview = true } = {}) {
  const params = new URLSearchParams({
    q: query,
    hl: "en",
    gl: geo,
    brd_json: "1",
  });
  if (aiOverview) {
    params.set("brd_ai_overview", "2");
  }
  return `https://www.google.com/search?${params.toString()}`;
}

function isRateLimitResponse(data) {
  // Bright Data quota/rate-limit signals: explicit error messages,
  // 429 status from the zone proxy, or a nil/empty body for rate-limited zones.
  const msg = String(data?.error || data?.message || "").toLowerCase();
  if (msg.includes("rate limit") || msg.includes("too many requests") || msg.includes("quota")) {
    return true;
  }
  if (data?.status_code === 429) return true;
  if (data?.status === "rate_limited") return true;
  return false;
}

/**
 * Bright Data's way of saying "that zone is not usable" (R1.2.7).
 *
 * This is a CONFIGURATION fault wearing a transport fault's clothes: it comes
 * back as an ordinary HTTP 400 / `{error: ...}` body, indistinguishable from a
 * bad query unless the text is read. Left unread it produced N identical failed
 * probes -- the exact shape of the C4 finding -- while the cache kept handing
 * the same dead zone to the next one.
 *
 * Returns the matched detail (trimmed) or null. Null is not "fine": it only
 * means this particular failure was not about the zone.
 *
 * BOTH SIDES OF THIS BOUNDARY ARE PINNED (R1.2.11). R1.2.10 widened the last
 * two patterns with only positive-case tests, which makes a guard that cannot
 * fail: any further widening would have stayed green. The negative corpus --
 * transient and unrelated messages that mention "zone" and must NOT become a
 * permanent zone rejection -- lives in brightdataZone.test.mjs under the
 * R1.2.11 banner, together with the three known over-match MECHANISMS recorded
 * there as tolerated exceptions rather than silently inherited. Narrow or widen
 * anything below and read that block before you decide the failure is the
 * test's fault.
 */
function zoneRejectionDetail(text) {
  const s = String(text || "").trim();
  if (!s) return null;
  const patterns = [
    /zone[ _-]?not[ _-]?found/i,
    /no such zone/i,
    /unknown zone/i,
    /invalid zone/i,
    // R1.2.10: the separator classes here are load-bearing. Bright Data returns
    // machine-readable error CODES as well as prose, which the first pattern
    // already anticipates (`zone_not_found`) -- but these two leaned on `\b`,
    // and an underscore is a word character, so `_suspended` offers no boundary
    // to match. `zone_suspended` therefore fell through to a plain Error: the
    // cache survived and the process kept probing a dead zone for a full TTL,
    // which is the C4 finding arriving through a different door. `(?:\b|_)`
    // keeps the boundary requirement (the state word must still start a token)
    // while accepting the snake_case form.
    /zone[^.,;]{0,40}(?:\b|_)(suspend|disabl|deactivat|expir|delet|not[ _-]?active)/i,
    /\b(suspend|disabl|deactivat|expir|delet)\w*[\s_-]+zone\b/i,
  ];
  return patterns.some((re) => re.test(s)) ? s.slice(0, 200) : null;
}

/**
 * Turn a probe-time zone rejection into a typed error AND drop the cache, so
 * the fleet recovers after one failed probe instead of after one TTL.
 *
 * The row still carries an error and is still counted (R0.1.10): this changes
 * the error's TYPE and the process's next move, never the fact that a failed
 * probe is an errored probe. It must never become a skip with cost 0.0.
 */
function zoneRejectedError(detail, zone) {
  const configured = (process.env.BRIGHTDATA_SERP_ZONE || "").trim();
  const dropped = configured
    ? null
    : invalidateBrightDataZoneCache(`rejected at probe time: ${detail}`);
  const consequence = configured
    ? `BRIGHTDATA_SERP_ZONE is set, so this cannot self-heal -- fix the variable or the zone.`
    : dropped
      ? `The cached zone was dropped; the next resolve re-lists zones and fails as a configuration error if none is active.`
      : `Nothing was cached, so the next resolve lists zones afresh.`;
  return new BrightDataZoneError(
    `Bright Data rejected SERP zone "${zone}": ${detail}. ${consequence}`,
    { reason: "zone_rejected", zone }
  );
}

/**
 * R04.5a — evidence identity for a returned SERP.
 *
 * Attached NON-ENUMERABLY so the return value keeps the SERP's own keys: the
 * audit's A10 read `Object.keys(malformed)` to show a wrong payload came back,
 * and an enumerable metadata field would blur exactly that signal.
 */
function attachBrightDataEvidence(result, meta) {
  if (!result || typeof result !== "object") return result;
  try {
    Object.defineProperty(result, "__brightdata", {
      value: meta,
      enumerable: false,
      configurable: true,
    });
  } catch {
    // A frozen payload keeps its data; evidence still rides the error path.
  }
  return result;
}

/** One attempt's parser result, in the bounded shape the evidence records. */
function evidenceRecord(attempt, parsed) {
  return {
    attempt,
    serp_state: parsed.serp_state,
    evidence_id: parsed.evidence?.evidence_id ?? null,
    parser_version: parsed.parser_version ?? null,
    errors: parsed.errors ?? [],
  };
}

/**
 * Turn a non-valid parser result into the typed error the caller records.
 *
 * `reason` is the parser's own `serp_state`, so a caller can branch on the
 * failure kind without reading the message — and `evidence` carries the
 * validation errors and the derived payload id, so a parse failure is
 * auditable and can never be filed as a brand non-mention (R04-5a).
 */
function parseErrorFrom(parsed) {
  const state = parsed?.serp_state || SERP_STATE.MALFORMED;
  const first = Array.isArray(parsed?.errors) ? parsed.errors[0] : null;
  return new BrightDataParseError(
    `Bright Data returned a payload that is not a usable Google SERP (${state})` +
      (first?.message ? `: ${first.message}` : "."),
    {
      reason: state,
      serp_state: state,
      // Readable off the thrown error rather than only off the evidence blob:
      // "this capture failed to validate, so the AIO state is UNKNOWN" is the
      // contract a caller records, and a caller should not have to know that
      // the parser's aio_present lives one field deeper.
      aio_present: parsed ? parsed.aio_present : null,
      evidence: parsed
        ? {
            ...parsed.evidence,
            parser_version: parsed.parser_version,
            validation_errors: parsed.errors,
          }
        : null,
    }
  );
}

export async function brightDataSearch(query, options = {}) {
  const baseTimeoutMs = options.timeout || 60000;
  const maxAttempts = options.attempts ?? 2;
  const backoffMs = options.backoffMs ?? 3000;
  const deadlineAt =
    options.deadlineAt != null
      ? options.deadlineAt
      : options.deadlineMs != null
        ? Date.now() + options.deadlineMs
        : null;
  const minDispatchMs = options.minDispatchMs ?? DEFAULT_BRIGHTDATA_MIN_DISPATCH_MS;
  const wantAio = options.aiOverview !== false;

  // R04.4b / R04-19 — refuse a probe that cannot finish inside its budget,
  // BEFORE the zone lookup, so neither a control-plane call nor a paid request
  // is started for work that would be abandoned.
  const startRemaining = remainingBudget(deadlineAt);
  if (startRemaining != null && startRemaining < minDispatchMs) {
    throw new BrightDataDeadlineError(
      `Refusing to dispatch a Bright Data SERP probe: ${Math.max(0, startRemaining)}ms of the deadline ` +
        `remains, under the ${minDispatchMs}ms needed to complete one request.`,
      { reason: "insufficient_time", remainingMs: startRemaining, minDispatchMs }
    );
  }

  // The zone lookup is part of the bounded request (R04.4a): it inherits the
  // caller's deadline so a hung control-plane call cannot outlive it.
  const config = await getBrightDataConfig({
    deadlineAt,
    timeoutMs: baseTimeoutMs,
    zoneLookupTimeoutMs: options.zoneLookupTimeoutMs,
  });
  if (!config) {
    throw new Error("Bright Data SERP is not configured (set BRIGHTDATA_API_KEY).");
  }

  const geo = resolveSerpGeo(options.geo);
  const attemptsEvidence = [];

  let lastErr = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const remaining = remainingBudget(deadlineAt);
    if (remaining != null && remaining <= 0) {
      throw new BrightDataDeadlineError(`Bright Data deadline exceeded before attempt ${attempt}.`, {
        reason: "deadline_exceeded",
        remainingMs: remaining,
      });
    }
    // The abort timer covers connection, headers AND the body read (R04-17).
    // The old code cleared it the instant headers arrived, so a body that hung
    // after a successful connection could outlive the deadline entirely.
    const attemptTimeoutMs =
      remaining != null ? Math.max(1, Math.min(baseTimeoutMs, remaining)) : baseTimeoutMs;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), attemptTimeoutMs);

    try {
      const res = await fetch("https://api.brightdata.com/request", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          "Content-Type": "application/json",
          "Accept-Encoding": "identity",
        },
        body: JSON.stringify({
          zone: config.zone,
          url: buildGoogleSearchUrl(query, { geo, aiOverview: wantAio }),
          format: "json",
          country: geo,
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const errText = await res.text();
        // Checked BEFORE the retry branch: retrying a probe against a zone Bright
        // Data has already refused just spends the attempt budget to get the same
        // answer, and delays the re-resolve that can actually fix it.
        const httpZoneErr = zoneRejectionDetail(errText);
        if (httpZoneErr) throw zoneRejectedError(httpZoneErr, config.zone);
        if (classifyHttpStatus(res.status) === FAILURE_KIND.TRANSIENT && attempt < maxAttempts) {
          lastErr = tagHttpFailure(
            new Error(`Bright Data HTTP ${res.status}: ${errText.slice(0, 200)}`),
            res.status
          );
          const delay = res.status === 429 ? backoffMs * attempt * 3 : backoffMs * attempt;
          await delayWithinDeadline(delay, deadlineAt);
          continue;
        }
        throw tagHttpFailure(
          new Error(`Bright Data HTTP ${res.status}: ${errText.slice(0, 200)}`),
          res.status
        );
      }

      // The body is read while the timer is still armed — the R04-17 fix.
      const raw = await res.text();

      // HTML proxy error pages are transient — retry once. An HTML page that is
      // a CAPTCHA / consent / login wall is an ACCESS STATE (R04-12) and is not
      // retried: no answer was produced and none may be substituted.
      const trimmed = raw.trimStart();
      if (trimmed.startsWith("<") || trimmed.startsWith("<!DOCTYPE")) {
        const asHtml = parseGoogleSerp(raw);
        if (asHtml.serp_state === SERP_STATE.ACCESS_STATE) {
          attemptsEvidence.push(evidenceRecord(attempt, asHtml));
          const accessError = parseErrorFrom(asHtml);
          accessError.attempts = attemptsEvidence.slice();
          throw accessError;
        }
        if (attempt < maxAttempts) {
          lastErr = new Error(`Bright Data returned a non-JSON response (${raw.slice(0, 80)}...)`);
          await delayWithinDeadline(backoffMs * attempt * 2, deadlineAt);
          continue;
        }
        throw new Error(`Bright Data returned an HTML proxy page instead of JSON.`);
      }

      let data;
      try {
        data = JSON.parse(raw);
      } catch (parseErr) {
        // Truncated JSON (stream cut mid-response) is transient — retry, but on
        // the LAST attempt it is a typed decode failure carrying evidence
        // identity (R04-10 / R04-16), never a returned pseudo-SERP.
        const asText = parseGoogleSerp(raw);
        attemptsEvidence.push(evidenceRecord(attempt, asText));
        const decodeError = new BrightDataParseError(
          `Bright Data response was not valid JSON: ${parseErr.message}`,
          {
            reason: "json_decode_error",
            serp_state: SERP_STATE.MALFORMED,
            evidence: { ...asText.evidence, validation_errors: asText.errors },
          }
        );
        decodeError.attempts = attemptsEvidence.slice();
        if (attempt < maxAttempts) {
          lastErr = decodeError;
          await delayWithinDeadline(backoffMs * attempt * 2, deadlineAt);
          continue;
        }
        throw decodeError;
      }

      // Rate-limit detection — stop retrying immediately.
      if (isRateLimitResponse(data)) {
        throw new Error(
          `Bright Data rate limit / quota exhausted — ${data.error || data.message || "try again later"}`
        );
      }

      if (data.error || data.status === "error") {
        const message = data.error || data.message || "Bright Data request failed";
        // Bright Data also returns zone faults inside a 200 envelope.
        const bodyZoneErr = zoneRejectionDetail(message);
        if (bodyZoneErr) throw zoneRejectedError(bodyZoneErr, config.zone);
        const asProvider = parseGoogleSerp(data);
        attemptsEvidence.push(evidenceRecord(attempt, asProvider));
        throw parseErrorFrom(asProvider);
      }

      // Proxy-level session failure (e.g. "no_ready_cookies") is a
      // provider-capacity fault, retried, and typed as provider_failure so it
      // can never fall through to normalizeBrightDataResponse (R04-11).
      const sessionErr = proxySessionError(data);
      if (sessionErr) {
        const asProvider = parseGoogleSerp(data);
        attemptsEvidence.push(evidenceRecord(attempt, asProvider));
        const providerError = new BrightDataParseError(
          `Bright Data proxy session error: ${sessionErr}`,
          {
            reason: SERP_STATE.PROVIDER_FAILURE,
            serp_state: SERP_STATE.PROVIDER_FAILURE,
            evidence: { ...asProvider.evidence, validation_errors: asProvider.errors },
          }
        );
        providerError.attempts = attemptsEvidence.slice();
        if (attempt < maxAttempts) {
          lastErr = providerError;
          await delayWithinDeadline(backoffMs * attempt * 2, deadlineAt);
          continue;
        }
        throw providerError;
      }

      // THE SHAPE VALIDATION THAT USED TO BE SKIPPED ON THE LAST ATTEMPT (A10).
      // Every attempt, including the last, satisfies the same contract: a
      // payload that is not a recognisable Google SERP raises a typed parse
      // error and never reaches the normaliser.
      const parsed = parseGoogleSerp(data, { providerRequestId: options.providerRequestId });
      attemptsEvidence.push(evidenceRecord(attempt, parsed));

      if (parsed.serp_state !== SERP_STATE.VALID_SERP) {
        const retryable =
          parsed.serp_state === SERP_STATE.MALFORMED ||
          parsed.serp_state === SERP_STATE.UNKNOWN_SCHEMA ||
          parsed.serp_state === SERP_STATE.PROVIDER_FAILURE;
        const parseError = parseErrorFrom(parsed);
        parseError.attempts = attemptsEvidence.slice();
        if (retryable && attempt < maxAttempts) {
          lastErr = parseError;
          await delayWithinDeadline(backoffMs * attempt * 2, deadlineAt);
          continue;
        }
        throw parseError;
      }

      // R04 — THE VALIDATED PARSE RESULT IS RETURNED, NOT THROWN AWAY.
      //
      // This used to be `return normalizeBrightDataResponse(data)`: the parser
      // had just computed blocks, safety-checked references and per-field
      // quality, and every one of them was dropped on the floor. probeAio then
      // re-derived an overview from the RAW payload through
      // extractBrightDataAiOverview, which reconstructs exactly the unvalidated
      // fields — so a `javascript:` reference the parser had rejected reappeared
      // in the persisted probe row, and no quality ever reached persistence.
      //
      // The transport still hands back the SERP itself, because callers read
      // `organic` / `ai_overview` off it, and the validation rides with it:
      //
      //   `__brightdata` (below, NON-ENUMERABLE) keeps the A10 signal intact —
      //   Object.keys(returned) is still the SERP's own keys.
      //   `serp_validation` (ENUMERABLE, here) is what survives the
      //   JSON.stringify that prompt_results.raw performs. The non-enumerable
      //   copy does not survive it, which is how the evidence identity and the
      //   quality were lost between the probe and the database row.
      const validation = {
        serp_state: parsed.serp_state,
        aio_present: parsed.aio_present,
        parser_version: parsed.parser_version || GOOGLE_PAYLOAD_PARSER_VERSION,
        evidence_id: parsed.evidence?.evidence_id ?? null,
        provider_request_id: parsed.evidence?.provider_request_id ?? null,
        per_field_quality: parsed.per_field_quality,
        citations_verified_empty: parsed.citations_verified_empty,
        text: parsed.text,
        blocks: parsed.blocks,
        citations: parsed.citations,
        references: parsed.references,
        errors: parsed.errors,
      };

      const result = normalizeBrightDataResponse(data);
      if (result && typeof result === "object") {
        try {
          result.serp_validation = validation;
        } catch {
          // A frozen payload keeps its data; the non-enumerable copy below still
          // carries the identity, and the error path is unaffected.
        }
      }
      return attachBrightDataEvidence(result, { ...validation, attempts: attemptsEvidence });
    } catch (err) {
      lastErr = err;

      // A zone fault is not transient and not this loop's to fix: the cache has
      // already been dropped, so the next probe re-resolves. Retrying here would
      // burn the attempt budget on a zone that is gone.
      if (isBrightDataZoneError(err)) throw err;

      // A typed parse error already exhausted its retries or is terminal (an
      // access state, for example); never re-wrap or retry past it.
      if (isBrightDataParseError(err)) throw err;

      // Rate-limit errors are not retryable — throw immediately.
      const msg = (err.message || "").toLowerCase();
      if (msg.includes("rate limit") || msg.includes("quota")) throw err;

      const isAbort = err.name === "AbortError" || /abort/i.test(err.message || "");
      const is5xx = /HTTP 5\d\d/.test(err.message || "");
      const isHtml = /non-JSON response/.test(err.message || "");
      const isJsonErr = /not valid JSON/.test(err.message || "");
      const isTruncation = /truncated/.test(err.message || "");
      if ((isAbort || is5xx || isHtml || isJsonErr || isTruncation) && attempt < maxAttempts) {
        await delayWithinDeadline(backoffMs * attempt, deadlineAt);
        continue;
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr || new Error("Bright Data request failed after retries.");
}

function extractSnippetsFromBlock(block) {
  if (!block) return [];
  if (typeof block === "string") return [block];
  const out = [];
  if (block.snippet) out.push(block.snippet);
  if (block.text) out.push(block.text);
  if (block.header) out.push(block.header);
  if (Array.isArray(block.list)) {
    block.list.forEach((item) => {
      out.push(...extractSnippetsFromBlock(item));
    });
  }
  if (Array.isArray(block.text_blocks)) {
    block.text_blocks.forEach((tb) => {
      out.push(...extractSnippetsFromBlock(tb));
    });
  }
  if (Array.isArray(block.paragraphs)) {
    block.paragraphs.forEach((p) => {
      out.push(...extractSnippetsFromBlock(p));
    });
  }
  return out.filter(Boolean);
}

/**
 * The AI Overview, as the parser validated it when the transport carried a
 * parse result, and reconstructed from the raw payload otherwise.
 *
 * WHY THE VALIDATED BRANCH EXISTS (R04). This function is the ONLY extraction
 * path the AIO engine has: probeAio calls it and copies its text, citations and
 * references straight into the row that is persisted verbatim in
 * prompt_results.raw. Rebuilding the overview from `data.ai_overview` here
 * therefore re-derived the fields the parser had just rejected — with one
 * `javascript:alert(1)` and one https reference, parseGoogleSerp returned one
 * reference and this returned both, so the rejected href was back in the
 * persisted probe row. Reading the parser's verdict HERE is what makes the
 * validated output reach production; recomputing it anywhere downstream would
 * put the hole back.
 *
 * The extended keys (per_field_quality, parser_version, evidence_id) exist only
 * on the validated branch. A caller that hands this function a raw payload
 * still gets exactly the three-key shape it always got — the direct-call
 * contract other suites pin — because there is no validated quality to report
 * for a payload that never went through the parser.
 */
export function extractBrightDataAiOverview(data) {
  const validated = data?.serp_validation;
  if (validated && Array.isArray(validated.blocks)) {
    return {
      text: typeof validated.text === "string" ? validated.text : "",
      citations: Array.isArray(validated.citations) ? validated.citations : [],
      references: (validated.references || []).map((ref) => ({
        href: ref.href,
        title: ref.title || "",
        source: ref.source || "",
      })),
      per_field_quality: validated.per_field_quality,
      citations_verified_empty: validated.citations_verified_empty ?? false,
      aio_present: validated.aio_present,
      serp_state: validated.serp_state,
      parser_version: validated.parser_version,
      evidence_id: validated.evidence_id,
    };
  }

  const ao = data?.ai_overview;
  if (!ao) return { text: "", citations: [], references: [] };

  let text = "";
  const parts = [];

  if (typeof ao === "string") {
    text = ao;
  } else {
    // Primary shape observed from Bright Data: ai_overview.texts (array of blocks)
    if (Array.isArray(ao.texts)) {
      ao.texts.forEach((block) => {
        parts.push(...extractSnippetsFromBlock(block));
      });
    }
    // Fallbacks for other shapes
    if (parts.length === 0 && Array.isArray(ao.text_blocks)) {
      ao.text_blocks.forEach((block) => {
        parts.push(...extractSnippetsFromBlock(block));
      });
    }
    if (parts.length === 0 && Array.isArray(ao.paragraphs)) {
      ao.paragraphs.forEach((p) => {
        parts.push(...extractSnippetsFromBlock(p));
      });
    }
    if (parts.length === 0 && typeof ao.text === "string") parts.push(ao.text);
    if (parts.length === 0 && typeof ao.snippet === "string") parts.push(ao.snippet);

    text = parts.join("\n");
  }

  // References: BrightData uses `href`, `title`, `source` in ai_overview.references
  const refSources = [
    ...(ao.references || []),
    ...(ao.sources || []),
    ...(ao.citations || []),
  ];

  const references = refSources
    .map((ref) => {
      if (typeof ref === "string") return { href: ref, title: "", source: "" };
      const href = ref.href || ref.link || ref.url || "";
      return {
        href,
        title: ref.title || "",
        source: ref.source || "",
      };
    })
    .filter((r) => r.href);

  const citations = [...new Set(references.map((r) => normalizeUrl(r.href)).filter(Boolean))];

  return {
    text: text.trim(),
    citations,
    references,
  };
}

export function extractBrightDataPaa(data) {
  const paa = data?.people_also_ask || [];
  return paa
    .map((item) => item.question || item.text)
    .filter(Boolean);
}

/**
 * Extracts top organic search results from Bright Data SERP response.
 * The data is already unwrapped by normalizeBrightDataResponse so organic
 * sits directly on the object.
 */
export function extractBrightDataOrganic(data) {
  const organic = Array.isArray(data?.organic) ? data.organic : [];
  return organic.slice(0, 10).map((result, i) => ({
    position: result.position || result.rank || i + 1,
    href: result.link || result.href || "",
    domain: (result.domain || "").replace(/^www\./i, ""),
    title: result.title || "",
  }));
}