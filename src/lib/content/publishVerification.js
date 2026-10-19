import {verifyBodyMatch,contentHash,canonicalPage} from '../repairs/workflow.js';
/**
 * R5.2.2 — explicit publish step with URL verification.
 *
 * The operator pastes the real live URL; this module verifies it resolves and
 * the content matches before the stage flips to PUBLISHED.
 *
 * Verification has two gates:
 *   1. The URL must resolve and return HTTP 200 (via SSRF-guarded fetch).
 *   2. The page's <title> must contain the item's title (case-insensitive).
 *      This is a basic-content match, not a cryptographic one — the point is
 *      to catch "operator pasted the wrong URL" rather than to prove exact
 *      authorship. A page whose title has been editorially trimmed will still
 *      pass if the core title text is present.
 *
 * Both gates use safeFetch() for SSRF protection. A private or blocked URL
 * fails loud rather than silently succeeding.
 */

import { safeFetch, normalizeTargetUrl } from "../ssrfGuard.js";

const FETCH_TIMEOUT_MS = 10000;
const USER_AGENT = "Mozilla/5.0 (compatible; PerceevPublishVerify/1.0; +https://perceev.ai)";

/**
 * Extract a <title> from raw HTML. Returns null when no title tag is found.
 * Intentionally simple — no parser, no DOM — because the match is a basic
 * content check, not a precision comparison.
 *
 * @param {string} html
 * @returns {string|null}
 */
export function extractTitle(html) {
  if (typeof html !== "string") return null;
  // Match <title>...</title> with optional whitespace/newlines, case-insensitive
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (!match || !match[1]) return null;
  return match[1].replace(/\s+/g, " ").trim() || null;
}

/**
 * Whether `pageTitle` contains the item's `itemTitle` as a substring,
 * after normalizing whitespace and case.
 *
 * @param {string} itemTitle
 * @param {string} pageTitle
 * @returns {boolean}
 */
export function titleMatches(itemTitle, pageTitle) {
  if (!itemTitle || !pageTitle) return false;
  const normalize = (s) => s.toLowerCase().replace(/\s+/g, " ").trim();
  return normalize(pageTitle).includes(normalize(itemTitle));
}

/**
 * Verify that a published URL resolves and its content matches the item.
 *
 * @param {{ url: string, itemTitle?: string, fetchImpl?: Function }} args
 * @returns {Promise<{ ok: boolean, status?: number, title_found?: string|null,
 *   error?: string, detail?: string }>}
 *   ok: true — verification passed; the URL is live and the content matches.
 *   ok: false — one of the gates failed; error explains which.
 */
export async function verifyPublishUrl({ url, itemTitle, itemBody, allowedDomains, fetchImpl } = {}) {
  if (!url || typeof url !== "string") {
    return { ok: false, error: "missing_url", detail: "A URL is required to publish." };
  }

  // Gate 0: normalize the URL
  let normalizedUrl;
  try {
    const parsed = normalizeTargetUrl(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      return { ok: false, error: "invalid_scheme", detail: "Only HTTP/HTTPS URLs are accepted." };
    }
    normalizedUrl = parsed.href;
  } catch (err) {
    return { ok: false, error: "invalid_url", detail: `The URL could not be parsed: ${err.message}` };
  }

  const domainAllowed=value=>!allowedDomains || allowedDomains.some(domain=>new URL(value).hostname===domain || new URL(value).hostname.endsWith(`.${domain}`));
  if(!domainAllowed(normalizedUrl))return {ok:false,error:"unapproved_publication_domain",detail:"Approve the publishing domain before verification."};
  // Gate 1: the URL must resolve with HTTP 200
  let response;
  try {
    response = await safeFetch(
      normalizedUrl,
      {
        headers: { "User-Agent": USER_AGENT },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        redirect: "follow",
      },
      { fetchImpl }
    );
  } catch (err) {
    const timedOut = err?.name === "TimeoutError" || err?.name === "AbortError";
    return {
      ok: false,
      error: timedOut ? "timeout" : "fetch_failed",
      detail: `The URL could not be reached: ${err.message || "unknown error"}.`,
    };
  }

  if (!response || !response.ok) {
    const status = response?.status ?? 0;
    return {
      ok: false,
      status,
      error: "not_ok",
      detail: `The URL returned HTTP ${status} — expected 200.`,
    };
  }

  if(itemBody!==undefined){
    const finalUrl=response.url || normalizedUrl;
    if(!domainAllowed(finalUrl))return {ok:false,error:"unapproved_redirect_domain",detail:"The final publishing domain is not approved."};
    let html;try {html=await response.text();} catch{return {ok:false,error:"body_read_failed",detail:"The live page body could not be verified."};}
    if(html.length>2_000_000)return {ok:false,error:"body_too_large",detail:"The page exceeds the verification limit."};
    const match=verifyBodyMatch(itemBody,html);
    const canonical=html.match(/<link\b[^>]*rel=["']canonical["'][^>]*href=["']([^"']+)/i)?.[1];
    return {ok:match.matched,matched:match.matched,error:match.reason,detail:match.matched?null:"The published body does not match the approved draft.",
      ...match,status:response.status,content_hash:contentHash(itemTitle,itemBody),page_hash:contentHash('',html),
      final_url:canonicalPage(finalUrl),canonical_url:canonical?canonicalPage(new URL(canonical,finalUrl).href):null,
      title_found:extractTitle(html),verified_at:new Date().toISOString(),
      indexing:null,noindex:/noindex/i.test(response.headers?.get?.("x-robots-tag")||'') || /<meta[^>]+(?:name=["']robots["'][^>]*content=["'][^"']*noindex|content=["'][^"']*noindex[^>]*name=["']robots)/i.test(html)};
  }

  // Gate 2 (optional): content match when an item title is provided
  let titleFound = null;
  if (itemTitle) {
    try {
      const html = await response.text();
      titleFound = extractTitle(html);

      if (!titleFound) {
        return {
          ok: false,
          status: response.status,
          title_found: null,
          error: "no_title",
          detail: "The page has no <title> tag, so we cannot verify the content matches.",
        };
      }

      if (!titleMatches(itemTitle, titleFound)) {
        return {
          ok: false,
          status: response.status,
          title_found: titleFound,
          error: "title_mismatch",
          detail: `The page title is "${titleFound}" but the item title is "${itemTitle}". ` +
            "If the page is correct, update the item title and try again.",
        };
      }
    } catch (err) {
      // Body read failure — the URL resolved but we couldn't verify content.
      // Pass the URL through with a warning rather than failing entirely.
      console.error("[publish-verify] failed to read response body:", err.message);
      return {
        ok: false,
        status: response.status,
        error: "body_read_failed",
        detail: "The URL resolved but we could not read its content to verify the match.",
      };
    }
  }

  return {
    ok: true,
    status: response.status,
    title_found: titleFound,
  };
}
