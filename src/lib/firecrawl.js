import { assertPublicUrl, isPolicyRefusal, safeFetch, SsrfBlockedError } from "./ssrfGuard.js";

const apiKey = process.env.FIRECRAWL_API_KEY;

/** The one string that means "there is nothing to summarize" — never used to mask a refusal. */
const NO_CONTENT = "No website content available.";

/**
 * Scrape a website using Firecrawl API (when key is present) and return
 * clean content suitable for LLM prompt generation.
 *
 * Falls back to basic fetch + HTML stripping when no key or on error.
 *
 * SSRF (R3.7.1, finding S17)
 * --------------------------
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
 * degrades to NO_CONTENT with its own distinct log line, exactly as it did
 * before this guard existed, so a customer's mistyped domain does not become a
 * 500. No fetch happens in either case, so that is a logging distinction, not
 * a hole. Ordinary failures (timeout, 404, vendor error) are unchanged.
 *
 * @param {string} url
 * @param {{ lookup?: Function, fetchImpl?: Function }} [deps] injected in tests so
 *        the suite makes no DNS query and no network call.
 * @throws {SsrfBlockedError} when the target is not a public http(s) address.
 */
export async function scrapeForSummary(url, deps = {}) {
  if (!url) {
    return NO_CONTENT;
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
      return NO_CONTENT;
    }
    throw error;
  }
  const normalizedUrl = target.toString();

  const doFetch = deps.fetchImpl || globalThis.fetch;

  // Primary path: Firecrawl (clean markdown + metadata)
  if (apiKey) {
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
        const result = data.data || data; // Firecrawl sometimes wraps differently

        let content = "";

        if (result.metadata?.title) {
          content += `Title: ${result.metadata.title}\n`;
        }
        if (result.metadata?.description) {
          content += `Description: ${result.metadata.description}\n\n`;
        }
        if (result.markdown) {
          content += result.markdown;
        }

        if (content.trim().length > 50) {
          return content.slice(0, 7000);
        }
      } else {
        console.warn(`[Firecrawl] API error ${response.status} for ${normalizedUrl}`);
      }
    } catch (error) {
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
      return cleaned.slice(0, 4000) || NO_CONTENT;
    }
  } catch (error) {
    // A refusal is never swallowed into NO_CONTENT — a redirect into a private
    // range surfaces to the caller instead of looking like an empty website.
    if (isPolicyRefusal(error)) {
      console.error(`[ssrf-guard] refused redirect hop (${error.code}): ${error.message}`);
      throw error;
    }
    if (error instanceof SsrfBlockedError) {
      console.warn(`[ssrf-guard] unusable redirect hop (${error.code}): ${error.message}`);
      return NO_CONTENT;
    }
    console.warn(`[Basic fetch] Failed for ${normalizedUrl}:`, error);
  }

  return NO_CONTENT;
}
