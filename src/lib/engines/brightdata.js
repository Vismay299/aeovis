import { normalizeUrl } from "../scoring/citations.js";
import { resolveSerpGeo } from "./serpGeo.js";

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

export async function resolveBrightDataSerpZone(apiKey = getBrightDataApiKey()) {
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

  const res = await fetch("https://api.brightdata.com/zone/get_all_zones", {
    headers: { Authorization: `Bearer ${apiKey}` },
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

  const zones = await res.json();
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

export async function getBrightDataConfig() {
  const apiKey = getBrightDataApiKey();
  if (!apiKey) return null;

  const zone = await resolveBrightDataSerpZone(apiKey);
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

function isRetryableHttpStatus(status) {
  return status === 429 || status >= 500;
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

function innerBody(data) {
  // Bright Data wraps the Google SERP response inside data.body as a JSON
  // string. Parse it if present so truncation checks operate on the actual
  // SERP object, not the outer string.
  if (!data) return null;
  if (data.body && typeof data.body === "string") {
    try { return JSON.parse(data.body); } catch (_) { return data.body; }
  }
  if (data.body && typeof data.body === "object") return data.body;
  // No body wrapper — the SERP data sits directly on `data` (legacy zone configs).
  return data;
}

function bodyLooksTruncated(body, wantAio) {
  if (!body) return true;
  if (!wantAio) return false;
  // Google always returns at least organic + general for any valid SERP
  // response. If none of the expected sections are present and AI Overview was
  // requested but is missing, the proxy likely truncated the stream.
  const hasOrganic = Array.isArray(body.organic) && body.organic.length > 0;
  const hasGeneral = !!(body.general && body.general.query);
  const hasPaa = Array.isArray(body.people_also_ask) && body.people_also_ask.length > 0;
  const hasAio = !!body.ai_overview;
  return !hasOrganic && !hasGeneral && !hasPaa && !hasAio;
}

export async function brightDataSearch(query, options = {}) {
  const config = await getBrightDataConfig();
  if (!config) {
    throw new Error("Bright Data SERP is not configured (set BRIGHTDATA_API_KEY).");
  }

  const geo = resolveSerpGeo();
  const timeoutMs = options.timeout || 60000;
  const maxAttempts = options.attempts ?? 2;
  const backoffMs = options.backoffMs ?? 3000;

  let lastErr = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
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
          url: buildGoogleSearchUrl(query, {
            geo,
            aiOverview: options.aiOverview !== false,
          }),
          format: "json",
          country: geo,
        }),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!res.ok) {
        const errText = await res.text();
        // Checked BEFORE the retry branch: retrying a probe against a zone Bright
        // Data has already refused just spends the attempt budget to get the same
        // answer, and delays the re-resolve that can actually fix it.
        const httpZoneErr = zoneRejectionDetail(errText);
        if (httpZoneErr) throw zoneRejectedError(httpZoneErr, config.zone);
        if (isRetryableHttpStatus(res.status) && attempt < maxAttempts) {
          lastErr = new Error(`Bright Data HTTP ${res.status}: ${errText.slice(0, 200)}`);
          const delay = res.status === 429 ? backoffMs * attempt * 3 : backoffMs * attempt;
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }
        throw new Error(`Bright Data HTTP ${res.status}: ${errText.slice(0, 200)}`);
      }

      const raw = await res.text();

      // HTML proxy error pages are transient — retry once.
      const trimmed = raw.trimStart();
      if (trimmed.startsWith("<") || trimmed.startsWith("<!DOCTYPE")) {
        if (attempt < maxAttempts) {
          lastErr = new Error(`Bright Data returned a non-JSON response (${raw.slice(0, 80)}...)`);
          await new Promise((r) => setTimeout(r, backoffMs * attempt * 2));
          continue;
        }
        throw new Error(`Bright Data returned an HTML proxy page instead of JSON.`);
      }

      let data;
      try {
        data = JSON.parse(raw);
      } catch (parseErr) {
        // Truncated JSON (stream cut mid-response) is transient — retry.
        if (attempt < maxAttempts) {
          lastErr = new Error(`Bright Data response was not valid JSON: ${parseErr.message}`);
          await new Promise((r) => setTimeout(r, backoffMs * attempt * 2));
          continue;
        }
        throw new Error(`Bright Data response was not valid JSON: ${parseErr.message}`);
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
        throw new Error(message);
      }

      // Proxy-level session failure (e.g. "no_ready_cookies") — retryable,
      // but must not fall through to normalizeBrightDataResponse on an empty body.
      const sessionErr = proxySessionError(data);
      if (sessionErr) {
        if (attempt < maxAttempts) {
          lastErr = new Error(`Bright Data proxy session error: ${sessionErr}`);
          await new Promise((r) => setTimeout(r, backoffMs * attempt * 2));
          continue;
        }
        throw new Error(`Bright Data proxy session error: ${sessionErr}`);
      }

      // Check actual SERP body for truncation (parse inner body first).
      const parsed = innerBody(data);
      const wantAio = options.aiOverview !== false;
      if (bodyLooksTruncated(parsed, wantAio) && attempt < maxAttempts) {
        lastErr = new Error("Bright Data returned a truncated/empty AIO response");
        await new Promise((r) => setTimeout(r, backoffMs * attempt * 3));
        continue;
      }

      return normalizeBrightDataResponse(data);
    } catch (err) {
      clearTimeout(timeoutId);
      lastErr = err;

      // A zone fault is not transient and not this loop's to fix: the cache has
      // already been dropped, so the next probe re-resolves. Retrying here would
      // burn the attempt budget on a zone that is gone.
      if (isBrightDataZoneError(err)) throw err;

      // Rate-limit errors are not retryable — throw immediately.
      const msg = (err.message || "").toLowerCase();
      if (msg.includes("rate limit") || msg.includes("quota")) throw err;

      const isAbort = err.name === "AbortError" || /abort/i.test(err.message || "");
      const is5xx = /HTTP 5\d\d/.test(err.message || "");
      const isHtml = /non-JSON response/.test(err.message || "");
      const isJsonErr = /not valid JSON/.test(err.message || "");
      const isTruncation = /truncated/.test(err.message || "");
      if ((isAbort || is5xx || isHtml || isJsonErr || isTruncation) && attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, backoffMs * attempt));
        continue;
      }
      throw err;
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

export function extractBrightDataAiOverview(data) {
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