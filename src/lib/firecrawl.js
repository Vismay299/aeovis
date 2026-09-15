import { assertPublicUrl, isPolicyRefusal, safeFetch, SsrfBlockedError } from "./ssrfGuard.js";

/**
 * The sentence this module USED to return in place of site content (R3.7.2,
 * finding B7).
 *
 * It is exported ONLY so the two prompt builders can recognise it and refuse
 * it, and so the tests can assert it never appears in an LLM prompt. Nothing
 * in this file produces it any more: an absence of content is `content: null`
 * plus a state, never an English sentence that reads like a page whose entire
 * body is "No website content available."
 *
 * Do not reintroduce it as a return value. That is the bug.
 */
export const NO_CONTENT_SENTINEL = "No website content available.";

/**
 * How the scrape actually went. Three states, not two, because "we got the
 * clean vendor extraction", "we got something worse than that" and "we got
 * nothing at all" are three different measurements and a prompt built on the
 * second is not the same instrument as a prompt built on the first.
 *
 *   ok          — Firecrawl returned usable content. `content` is a string.
 *   degraded    — content exists, but NOT from the primary path: the crude
 *                 HTML strip of the fallback fetch. `content` is a string.
 *   unavailable — there is no content. `content` is null, never a sentence.
 */
export const SCRAPE_STATE = Object.freeze({
  OK: "ok",
  DEGRADED: "degraded",
  UNAVAILABLE: "unavailable",
});

/** Why a scrape is not `ok`. Machine tokens; `detail` carries the prose. */
export const SCRAPE_REASON = Object.freeze({
  /** No website was supplied at all. Nothing was attempted. */
  NO_URL: "no_url",
  /** The target is unusable input — a typo, an NXDOMAIN. No fetch happened. */
  UNUSABLE_TARGET: "unusable_target",
  /** No FIRECRAWL_API_KEY, so the vendor path was never tried. */
  FIRECRAWL_NOT_CONFIGURED: "firecrawl_not_configured",
  /** Firecrawl answered with a non-2xx (402 no balance, 429, 5xx). */
  FIRECRAWL_HTTP_ERROR: "firecrawl_http_error",
  /** The Firecrawl call threw or timed out. */
  FIRECRAWL_REQUEST_FAILED: "firecrawl_request_failed",
  /** Firecrawl answered 200 but the extraction was too thin to use. */
  FIRECRAWL_THIN_CONTENT: "firecrawl_thin_content",
  /** The fallback fetch answered non-2xx. */
  FALLBACK_HTTP_ERROR: "fallback_http_error",
  /** The fallback fetch threw, timed out, or hit an unusable redirect hop. */
  FALLBACK_REQUEST_FAILED: "fallback_request_failed",
  /** The fallback fetch succeeded and the page had no extractable text. */
  FALLBACK_EMPTY_BODY: "fallback_empty_body",
  /**
   * A caller injected the pre-R3.7.2 string-returning scraper, which carries no
   * state of its own. Content exists, but "how it was obtained" is unknown, and
   * unknown is not `ok`.
   */
  LEGACY_STRING_SCRAPER: "legacy_string_scraper",
  /**
   * A legacy string scraper returned nothing (or the sentinel). We know there
   * is no content; we do NOT know why, and saying `fallback_empty_body` here
   * would claim we fetched the page and found it blank.
   */
  LEGACY_NO_CONTENT: "legacy_scraper_no_content",
});

const MAX_DETAIL_CHARS = 200;

function detailOf(value) {
  const text = value instanceof Error ? value.message || String(value) : String(value ?? "");
  return text.slice(0, MAX_DETAIL_CHARS) || null;
}

/**
 * Build the result envelope.
 *
 * `content` is the ONLY content channel and it is `string | null`. A caller
 * that wants to know whether anything was scraped asks `result.content`, not
 * whether a string happens to equal some sentence.
 */
function result({ content, state, reasons, detail = null, source = null }) {
  const chain = reasons.filter(Boolean);
  return {
    content: content ?? null,
    content_chars: typeof content === "string" ? content.length : 0,
    state,
    /** The single reason that best explains this outcome. Null only when ok. */
    state_reason: state === SCRAPE_STATE.OK ? null : chain[chain.length - 1] || null,
    /** Every degrade encountered, in order. A fallback that also failed shows both. */
    reasons: chain,
    detail,
    /** Where the content actually came from. Null when there is none. */
    source,
    degraded: state !== SCRAPE_STATE.OK,
  };
}

/**
 * Scrape a website and report BOTH what was scraped and how it went.
 *
 * WHAT CHANGED, AND WHY (R3.7.2, finding B7)
 * ------------------------------------------
 * This function used to return a plain string, and returned the literal
 * sentence "No website content available." whenever it had nothing — for an
 * unresolvable host, a 404, a dead socket, an empty page, or a Firecrawl
 * outage. Both callers interpolated that string straight into an LLM prompt
 * under the heading "Website summary:", so the model was told, in English,
 * that the brand's website says "No website content available." — and
 * src/lib/scoring/promptGen.js additionally mined it for SERP seed terms,
 * seeding real Google queries with the words "website", "content" and
 * "available". A total scrape failure was indistinguishable, everywhere
 * downstream, from a site that had been read successfully.
 *
 * Now: content is `string | null`, and every non-ok outcome carries a state
 * and a machine reason that the caller records rather than discards.
 *
 * SSRF (R3.7.1, finding S17) — unchanged by this task
 * --------------------------------------------------
 * `url` is user-controlled and, on the /api/scan path, ANONYMOUSLY supplied —
 * see the header of src/lib/ssrfGuard.js for the full trace. The fallback below
 * fetches it from this server and hands the body back to the caller, so the
 * target is validated BEFORE either fetch, and the fallback goes through
 * safeFetch() so every redirect hop is re-validated too.
 *
 * A POLICY refusal (private/link-local/metadata address, non-http scheme,
 * credentials in the URL) THROWS SsrfBlockedError: "we refused to fetch this"
 * and "the site had nothing" must not look identical to a caller or in the
 * logs. Input that is merely unusable — a typo, an unresolvable name — still
 * degrades, now to state=unavailable/unusable_target with its own distinct log
 * line, so a customer's mistyped domain does not become a 500. No fetch happens
 * in either case, so that is a logging distinction, not a hole.
 *
 * @param {string} url
 * @param {{ lookup?: Function, fetchImpl?: Function, apiKey?: string|null }} [deps]
 *        injected in tests so the suite makes no DNS query and no network call.
 *        `apiKey` is read from the environment at CALL time when not injected,
 *        so a test can exercise both the keyed and the unkeyed path.
 * @returns {Promise<{content: string|null, content_chars: number, state: string,
 *          state_reason: string|null, reasons: string[], detail: string|null,
 *          source: string|null, degraded: boolean}>}
 * @throws {SsrfBlockedError} when the target is not a public http(s) address.
 */
export async function scrapeSite(url, deps = {}) {
  if (!url) {
    return result({
      content: null,
      state: SCRAPE_STATE.UNAVAILABLE,
      reasons: [SCRAPE_REASON.NO_URL],
      detail: "no website was supplied",
    });
  }

  // Throws on anything that is not a public http/https target. Runs before the
  // vendor call as well, so we never disclose an internal hostname to Firecrawl.
  let target;
  try {
    ({ url: target } = await assertPublicUrl(url, deps));
  } catch (error) {
    if (isPolicyRefusal(error)) {
      console.error(`[ssrf-guard] refused scrape target (${error.code}): ${error.message}`);
      throw error;
    }
    if (error instanceof SsrfBlockedError) {
      console.warn(`[ssrf-guard] unusable scrape target (${error.code}): ${error.message}`);
      return result({
        content: null,
        state: SCRAPE_STATE.UNAVAILABLE,
        reasons: [SCRAPE_REASON.UNUSABLE_TARGET],
        detail: detailOf(error),
      });
    }
    throw error;
  }
  const normalizedUrl = target.toString();

  const doFetch = deps.fetchImpl || globalThis.fetch;
  const apiKey =
    Object.prototype.hasOwnProperty.call(deps, "apiKey")
      ? deps.apiKey
      : process.env.FIRECRAWL_API_KEY;

  // Every degrade encountered on the way to whatever we end up with. Ordered,
  // so a result assembled from the fallback still names what the vendor did.
  const reasons = [];
  let detail = null;
  const degrade = (reason, why) => {
    reasons.push(reason);
    detail = detailOf(why);
  };

  // Primary path: Firecrawl (clean markdown + metadata)
  if (!apiKey) {
    // Not an error, but not the primary path either: what comes back below is a
    // regex strip of raw HTML, not a vendor extraction, and a scan built on it
    // must not claim otherwise.
    degrade(SCRAPE_REASON.FIRECRAWL_NOT_CONFIGURED, "FIRECRAWL_API_KEY is not set");
  } else {
    try {
      const response = await doFetch("https://api.firecrawl.dev/v1/scrape", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          url: normalizedUrl,
          formats: ["markdown"],
          onlyMainContent: true,
        }),
        signal: AbortSignal.timeout(20000),
      });

      if (response.ok) {
        const data = await response.json();
        const payload = data.data || data; // Firecrawl sometimes wraps differently

        let content = "";

        if (payload.metadata?.title) {
          content += `Title: ${payload.metadata.title}\n`;
        }
        if (payload.metadata?.description) {
          content += `Description: ${payload.metadata.description}\n\n`;
        }
        if (payload.markdown) {
          content += payload.markdown;
        }

        if (content.trim().length > 50) {
          return result({
            content: content.slice(0, 7000),
            state: SCRAPE_STATE.OK,
            reasons: [],
            source: "firecrawl",
          });
        }
        degrade(
          SCRAPE_REASON.FIRECRAWL_THIN_CONTENT,
          `Firecrawl returned ${content.trim().length} usable chars for ${normalizedUrl}`
        );
        console.warn(
          `[Firecrawl] thin extraction (${content.trim().length} chars) for ${normalizedUrl} — falling back`
        );
      } else {
        degrade(SCRAPE_REASON.FIRECRAWL_HTTP_ERROR, `HTTP ${response.status} from Firecrawl`);
        console.warn(`[Firecrawl] API error ${response.status} for ${normalizedUrl}`);
      }
    } catch (error) {
      degrade(SCRAPE_REASON.FIRECRAWL_REQUEST_FAILED, error);
      console.warn(`[Firecrawl] Request failed for ${normalizedUrl}:`, error.message || error);
      // fall through to basic
    }
  }

  // Fallback: basic fetch + crude HTML strip. THIS is the SSRF surface — it is
  // our own network reaching out to a user-supplied host — so it goes through
  // safeFetch, which re-checks every redirect hop.
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000);

    let res;
    try {
      res = await safeFetch(normalizedUrl, { signal: controller.signal }, deps);
    } finally {
      clearTimeout(timeoutId);
    }

    if (res.ok) {
      const text = await res.text();
      const bodyMatch = text.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
      const bodyText = bodyMatch ? bodyMatch[1] : text;
      const cleaned = bodyText
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      const content = cleaned.slice(0, 4000);
      if (content) {
        // Reached only after a degrade — the vendor path either was not
        // configured or did not produce usable content — so this is never `ok`.
        return result({
          content,
          state: SCRAPE_STATE.DEGRADED,
          reasons,
          detail,
          source: "fallback_fetch",
        });
      }
      // We looked and the page really was empty. That is a MEASURED nothing and
      // it is a different fact from "we never got a response" — hence its own
      // reason rather than a shared empty string.
      degrade(SCRAPE_REASON.FALLBACK_EMPTY_BODY, `${normalizedUrl} returned no extractable text`);
    } else {
      degrade(SCRAPE_REASON.FALLBACK_HTTP_ERROR, `HTTP ${res.status} from ${normalizedUrl}`);
      console.warn(`[Basic fetch] HTTP ${res.status} for ${normalizedUrl}`);
    }
  } catch (error) {
    // A refusal is never swallowed into an empty state — a redirect into a
    // private range surfaces to the caller instead of looking like an empty
    // website.
    if (isPolicyRefusal(error)) {
      console.error(`[ssrf-guard] refused redirect hop (${error.code}): ${error.message}`);
      throw error;
    }
    if (error instanceof SsrfBlockedError) {
      console.warn(`[ssrf-guard] unusable redirect hop (${error.code}): ${error.message}`);
      degrade(SCRAPE_REASON.UNUSABLE_TARGET, error);
      return result({
        content: null,
        state: SCRAPE_STATE.UNAVAILABLE,
        reasons,
        detail,
      });
    }
    degrade(SCRAPE_REASON.FALLBACK_REQUEST_FAILED, error);
    console.warn(`[Basic fetch] Failed for ${normalizedUrl}:`, error);
  }

  return result({
    content: null,
    state: SCRAPE_STATE.UNAVAILABLE,
    reasons,
    detail,
  });
}

/**
 * Coerce whatever a scraper handed back into the R3.7.2 envelope.
 *
 * Exists because several call sites accept an INJECTED scraper (`deps.scrape`,
 * `deps.scrapeForSummary`) and a number of suites still inject the pre-R3.7.2
 * plain-string kind — including ones that return the sentinel verbatim. Rather
 * than trusting the string, every caller funnels it through here, so:
 *
 *   - the sentence is recognised as "there was nothing", never as page copy;
 *   - content that DID come back is marked `degraded`, because a scraper that
 *     reports no state cannot be said to have succeeded cleanly.
 *
 * This is the belt to scrapeSite's braces: the sentinel is no longer produced,
 * AND it is no longer accepted.
 */
export function normalizeScrapeResult(value) {
  if (value && typeof value === "object" && typeof value.state === "string") {
    return value;
  }
  const raw = typeof value === "string" ? value.trim() : "";
  const content = raw === NO_CONTENT_SENTINEL ? "" : raw;
  if (content) {
    return result({
      content,
      state: SCRAPE_STATE.DEGRADED,
      reasons: [SCRAPE_REASON.LEGACY_STRING_SCRAPER],
      detail: "an injected string scraper reported no state of its own",
      source: "legacy_string_scraper",
    });
  }
  return result({
    content: null,
    state: SCRAPE_STATE.UNAVAILABLE,
    reasons: [SCRAPE_REASON.LEGACY_NO_CONTENT],
    detail:
      raw === NO_CONTENT_SENTINEL
        ? "an injected string scraper returned the legacy no-content sentinel"
        : "an injected string scraper returned no content",
  });
}

/**
 * One-line summary of a scrape, in the shape callers record on the scan.
 *
 * Deliberately drops `content` — this is the part that travels into logs, the
 * run ledger and the checkpoint, and the page body has no business there.
 */
export function summarizeScrape(scrape) {
  if (!scrape || typeof scrape !== "object") {
    // Not "ok with no content": we were handed nothing to summarize, and
    // guessing a state here would manufacture the exact false success this
    // task removes.
    return {
      state: SCRAPE_STATE.UNAVAILABLE,
      state_reason: "no_scrape_result",
      reasons: ["no_scrape_result"],
      detail: null,
      source: null,
      // NOT `0`. Zero would claim we measured the content and found none;
      // we were handed no result to measure (standing rule 5).
      content_chars: null,
    };
  }
  return {
    state: scrape.state,
    state_reason: scrape.state_reason ?? null,
    reasons: Array.isArray(scrape.reasons) ? [...scrape.reasons] : [],
    detail: scrape.detail ?? null,
    source: scrape.source ?? null,
    content_chars: Number.isFinite(scrape.content_chars) ? scrape.content_chars : null,
  };
}
