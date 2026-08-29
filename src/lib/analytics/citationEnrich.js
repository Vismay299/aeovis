import { llmJson } from "../llm.js";
import { isLlmUnavailable } from "../llmErrors.js";
import { domainMatches } from "../scoring/enginePipeline.js";
import { classifyCitation } from "../scoring/citations.js";

/**
 * Citation enrichment (P3a — plan.md §5 Phase 3): classifies every
 * `citations` row into the three columns migration 005 already reserves for
 * this (`content_type`, `domain_type`, `citation_class`), using EXACTLY the
 * vocabularies documented on the table:
 *
 *   content_type   listicle | comparison | product | social | forum |
 *                  article | homepage | category | alternative | other
 *   domain_type    editorial | corporate | reference | competitor | ugc |
 *                  social | institutional | owned
 *   citation_class earned | owned | social
 *
 * Heuristics run first and resolve the large majority of real citation URLs
 * for free; a small BATCHED free-model LLM call (llmJson — the project's
 * single free-model choke point, src/lib/llm.js) fills in only the
 * content_type values heuristics couldn't confidently resolve.
 * domain_type/citation_class never need the LLM — their heuristics are
 * exhaustive by construction (always end in a definite fallback bucket).
 *
 * Pure + unit-testable: no DB access anywhere in this module. `enrichCitations`
 * is the only async export (it may call the network via llmJson); every
 * classifier is a plain synchronous function.
 */

export const CONTENT_TYPES = [
  "listicle",
  "comparison",
  "product",
  "social",
  "forum",
  "article",
  "homepage",
  "category",
  "alternative",
  "other",
];

export const DOMAIN_TYPES = [
  "editorial",
  "corporate",
  "reference",
  "competitor",
  "ugc",
  "social",
  "institutional",
  "owned",
];

export const CITATION_CLASSES = ["earned", "owned", "social"];

// ---------------------------------------------------------------------------
// URL helpers (mirrors scoring/citations.js's own try/catch-safe parsing —
// duplicated rather than imported since that module only exposes hostname
// extraction, not pathname; kept tiny and local on purpose).
// ---------------------------------------------------------------------------

function parseUrlSafe(urlStr) {
  if (!urlStr || typeof urlStr !== "string") return null;
  try {
    let cleaned = urlStr.trim();
    if (!/^https?:\/\//i.test(cleaned)) cleaned = "http://" + cleaned;
    return new URL(cleaned);
  } catch {
    return null;
  }
}

function safePathname(urlStr) {
  const u = parseUrlSafe(urlStr);
  return u ? u.pathname : "";
}

function safeHost(urlStr) {
  const u = parseUrlSafe(urlStr);
  return u ? u.hostname.toLowerCase().replace(/^www\./, "") : "";
}

function normalizeDomain(d) {
  return String(d || "").trim().toLowerCase().replace(/^www\./, "");
}

function pathDepth(path) {
  return String(path || "")
    .split("/")
    .filter(Boolean).length;
}

function inRegistry(domain, list) {
  return list.some((h) => domainMatches(domain, h));
}

// ---------------------------------------------------------------------------
// content_type heuristics
// ---------------------------------------------------------------------------

const LISTICLE_RE = /\bbest\b|\btop[\s-]?\d+\b|\b\d+\s+best\b/i;
const COMPARISON_RE = /\bvs\b|\bversus\b|\bcompare\b|\bcomparison\b/i;
const ALTERNATIVE_RE = /\balternatives?\b/i;
const CATEGORY_RE = /\/(category|collections)(\/|$)|\/c\//i;
const PRODUCT_RE = /\/(products?|items?)(\/|$)|\/p\//i;
const ARTICLE_RE = /\/(blog|articles?|guides?)(\/|$)|\/how-to/i;

const FORUM_HOSTS = ["reddit.com", "quora.com", "stackexchange.com", "stackoverflow.com"];
const SOCIAL_HOSTS = [
  "youtube.com",
  "youtu.be",
  "twitter.com",
  "x.com",
  "linkedin.com",
  "facebook.com",
  "instagram.com",
  "tiktok.com",
  "pinterest.com",
  "threads.net",
];

function isForumHost(host) {
  if (!host) return false;
  if (inRegistry(host, FORUM_HOSTS)) return true;
  return host.includes("forum");
}

function isSocialHost(host) {
  return inRegistry(host, SOCIAL_HOSTS);
}

/**
 * Heuristic content_type classification — NO LLM. Checked in this exact
 * order (plan.md §5 Phase 3 / the P3a work order):
 *   1. listicle    - "best", "top-N", "N best" (path OR title)
 *   2. comparison  - "vs", "versus", "compare(-ison)"
 *   3. alternative - "alternative(s)"
 *   4. forum       - reddit/quora/stackexchange/stackoverflow, or any host
 *                    containing "forum"
 *   5. social      - youtube/twitter/x/linkedin/facebook/instagram/tiktok/…
 *   6. homepage    - path depth 0 (root)
 *   7. category    - /category, /collections, /c/
 *   8. product     - /product(s), /p/, /item(s)
 *   9. article     - /blog, /article(s), /guide(s), /how-to
 *  10. else -> null (defer to the batched LLM fallback in enrichCitations —
 *      NOT "other" directly, so the LLM gets a real shot at the minority of
 *      URLs these patterns miss; enrichCitations itself falls back to
 *      "other" only if the LLM call also fails/omits a value).
 *
 * Keyword checks (1-3) run against BOTH the path and the title and are
 * checked BEFORE the host/path-shape checks (4-9) — e.g. a YouTube video
 * titled "Top 10 Best CRMs" classifies as "listicle", not "social". This is
 * a deliberate ordering choice (content shape over host), not an oversight.
 */
export function classifyContentType(url, title) {
  const path = safePathname(url).toLowerCase();
  const host = safeHost(url);
  const hay = `${path} ${String(title || "").toLowerCase()}`;

  if (LISTICLE_RE.test(hay)) return "listicle";
  if (COMPARISON_RE.test(hay)) return "comparison";
  if (ALTERNATIVE_RE.test(hay)) return "alternative";
  if (isForumHost(host)) return "forum";
  if (isSocialHost(host)) return "social";
  if (pathDepth(path) === 0) return "homepage";
  if (CATEGORY_RE.test(path)) return "category";
  if (PRODUCT_RE.test(path)) return "product";
  if (ARTICLE_RE.test(path)) return "article";
  return null;
}

// ---------------------------------------------------------------------------
// domain_type heuristics — always resolve (never defer to the LLM): owned /
// competitor first (brand-specific), then a fixed priority of static
// registries, then "corporate" as the exhaustive catch-all.
// ---------------------------------------------------------------------------

// Social media platforms. (Reddit deliberately lives under UGC below, not
// here — see the UGC_DOMAINS comment. A domain can only carry one
// domain_type; this project treats "social" as broadcast/consumer platforms
// and "ugc" as community/Q&A platforms.)
const SOCIAL_DOMAINS = [
  "youtube.com",
  "youtu.be",
  "twitter.com",
  "x.com",
  "linkedin.com",
  "facebook.com",
  "instagram.com",
  "tiktok.com",
  "pinterest.com",
  "threads.net",
];

const UGC_DOMAINS = [
  "reddit.com",
  "quora.com",
  "stackexchange.com",
  "stackoverflow.com",
  "news.ycombinator.com",
  "trustpilot.com",
];

const REFERENCE_DOMAINS = [
  "wikipedia.org",
  "g2.com",
  "capterra.com",
  "gartner.com",
  "trustradius.com",
  "softwareadvice.com",
  "getapp.com",
  "producthunt.com",
  "britannica.com",
  "crunchbase.com",
  "investopedia.com",
];

// Curated news/press — global + India-first (product defaults SERP_GEO='in').
// Non-exhaustive by design; extend as real citation data surfaces gaps.
const EDITORIAL_DOMAINS = [
  "nytimes.com",
  "wsj.com",
  "forbes.com",
  "bloomberg.com",
  "reuters.com",
  "techcrunch.com",
  "theverge.com",
  "wired.com",
  "businessinsider.com",
  "cnbc.com",
  "fastcompany.com",
  "entrepreneur.com",
  "inc.com",
  "mashable.com",
  "engadget.com",
  "huffpost.com",
  "bbc.com",
  "bbc.co.uk",
  "theguardian.com",
  "washingtonpost.com",
  "axios.com",
  "vox.com",
  "cnn.com",
  "timesofindia.indiatimes.com",
  "indiatimes.com",
  "hindustantimes.com",
  "ndtv.com",
  "livemint.com",
  "moneycontrol.com",
  "economictimes.indiatimes.com",
  "business-standard.com",
  "thehindu.com",
  "indianexpress.com",
  "financialexpress.com",
  "yourstory.com",
  "inc42.com",
  "entrackr.com",
];

// ".org majors" (plan.md §5 Phase 3) — a curated allowlist, NOT every .org
// domain (most .org sites are just companies/blogs, not institutions).
const MAJOR_ORG_DOMAINS = [
  "un.org",
  "unesco.org",
  "unicef.org",
  "ieee.org",
  "acm.org",
  "w3.org",
  "ietf.org",
  "mozilla.org",
  "apache.org",
  "redcross.org",
  "npr.org",
  "wwf.org",
  "amnesty.org",
];

function isInstitutionalDomain(d) {
  if (/\.gov(\.[a-z]{2})?$/.test(d)) return true; // .gov, .gov.in, .gov.uk, ...
  if (/\.edu(\.[a-z]{2})?$/.test(d)) return true; // .edu, .edu.in, ...
  if (/\.ac\.[a-z]{2}$/.test(d)) return true; // .ac.in, .ac.uk, ... (academic)
  return inRegistry(d, MAJOR_ORG_DOMAINS);
}

/**
 * Heuristic domain_type classification — always returns a definite value
 * (never null/defers): owned > competitor > social > ugc > reference >
 * institutional > editorial > "corporate" (exhaustive fallback).
 *
 * `brandDomain` / `competitorDomains` are matched via the SAME
 * exact-or-subdomain rule the rest of the pipeline uses for is_self
 * (scoring/enginePipeline.js's domainMatches — candidate===target or
 * candidate.endsWith("."+target)).
 */
export function classifyDomainType(domain, { brandDomain, competitorDomains = [] } = {}) {
  const d = normalizeDomain(domain);
  if (!d) return "corporate";

  const brand = normalizeDomain(brandDomain);
  if (brand && domainMatches(d, brand)) return "owned";

  const competitors = (competitorDomains || []).map(normalizeDomain).filter(Boolean);
  if (competitors.some((c) => domainMatches(d, c))) return "competitor";

  if (inRegistry(d, SOCIAL_DOMAINS)) return "social";
  if (inRegistry(d, UGC_DOMAINS)) return "ugc";
  if (inRegistry(d, REFERENCE_DOMAINS)) return "reference";
  if (isInstitutionalDomain(d)) return "institutional";
  if (inRegistry(d, EDITORIAL_DOMAINS)) return "editorial";

  return "corporate";
}

/**
 * domain_type -> citation_class mapping (pure, total function — every
 * DOMAIN_TYPES value maps to exactly one bucket):
 *   owned            -> owned
 *   social, ugc       -> social
 *   everything else   -> earned  (editorial, corporate, reference,
 *                                 competitor, institutional)
 */
export function classifyCitationClass(domainType) {
  if (domainType === "owned") return "owned";
  if (domainType === "social" || domainType === "ugc") return "social";
  return "earned";
}

// ---------------------------------------------------------------------------
// enrichCitations — batch orchestration: heuristics first, one batched
// free-LLM call over whatever heuristics couldn't resolve, in-process cache.
// ---------------------------------------------------------------------------

// Defensive cap on distinct (domain, path-shape) tuples sent to the LLM in a
// single enrichCitations call — keeps one invocation's prompt bounded even
// against an unusually citation-heavy scan or backfill page. Any tuple past
// the cap simply falls back to "other" (fail-loud-soft, not an error).
const MAX_LLM_BATCH = 60;

// Module-level, in-process, unbounded-lifetime cache: content_type is a
// property of the URL/content itself (not brand-relative, unlike
// domain_type), so it's safe and beneficial to share across every brand and
// every call in this process/lambda instance — the same URL shape appearing
// in a different brand's citations never needs to be re-classified. Tests
// inject their own `deps.cache` (a fresh Map) for isolation — see
// citationEnrich.test.mjs.
const moduleContentTypeCache = new Map();

/**
 * Normalizes a URL path into a coarse "shape" for cache-keying: numeric or
 * hex/uuid-like path segments (ids) collapse to "#" so e.g. /products/111
 * and /products/222 share one cache entry. Best-effort — a handful of real
 * English words made entirely of a-f/hyphen (e.g. "facade", "decade") can
 * false-positive into "#" at 6+ chars; harmless, since content_type is a
 * coarse classification, not a per-URL-unique one.
 */
function pathShape(urlStr) {
  const path = safePathname(urlStr).toLowerCase();
  return path
    .split("/")
    .map((seg) => (seg && (/^\d+$/.test(seg) || /^[0-9a-f-]{6,}$/i.test(seg)) ? "#" : seg))
    .join("/");
}

function cacheKeyFor(domain, urlStr) {
  return `${normalizeDomain(domain)}|${pathShape(urlStr)}`;
}

function normalizeContentType(value) {
  const v = String(value || "").trim().toLowerCase();
  return CONTENT_TYPES.includes(v) ? v : null;
}

function buildContentTypePrompt(items) {
  const numbered = items
    .map((it, i) => `${i}. domain="${it.domain}" path="${it.path}" title="${String(it.title || "").slice(0, 140)}"`)
    .join("\n");
  // NOTE: llmJson sends jsonMode:true, and JSON-mode implementations generally
  // require the response to be a top-level OBJECT — a bare array gets wrapped
  // (or refused), which made every batch fail the Array.isArray check and
  // silently degrade ~20% of URLs to "other". So ask for an object with a
  // single `types` array; coerceTypeList below still accepts a bare array or
  // any other single-array wrapper, for models that ignore the instruction.
  return `Classify each cited URL below by content type.

Allowed values (use EXACTLY one per URL, lowercase): ${CONTENT_TYPES.join(", ")}

URLs:
${numbered}

Return ONLY a JSON object of the form {"types": [...]} where "types" is an array of ${items.length} strings in the SAME order as the input above (index 0 first) — one content type per URL. No prose, no code fences. Example: {"types":["article","product"]}`;
}

/**
 * Coerces an LLM response into the expected array of content-type strings.
 * Accepts a bare array, `{types:[...]}`, or any object whose first
 * array-valued property is the list — models vary in how they wrap JSON-mode
 * output, and a wrapper is not a failure worth discarding a whole batch over.
 */
function coerceTypeList(parsed) {
  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === "object") {
    if (Array.isArray(parsed.types)) return parsed.types;
    const firstArray = Object.values(parsed).find((v) => Array.isArray(v));
    if (firstArray) return firstArray;
  }
  return null;
}

/**
 * Enriches a batch of citation-row-shaped objects with content_type,
 * domain_type, and citation_class. Does NOT mutate its input — returns new
 * row objects (input row spread + the three new fields).
 *
 * @param {Array<{url:string, domain:string, title?:string}>} rows
 * @param {Object} ctx
 * @param {string} [ctx.brandDomain] - the tracked brand's own domain
 * @param {string[]} [ctx.competitorNames] - tracked rival NAMES (not
 *   domains — neither the live pipeline's post-scoring competitor objects
 *   nor a historical scan row carries a resolved competitor domain; see
 *   below). Used to fuzzy-resolve which domains ACTUALLY OBSERVED in this
 *   batch are competitor domains, via the existing name/alias matcher
 *   (scoring/citations.js classifyCitation).
 * @param {string[]} [ctx.competitorDomains] - exact competitor domains, when
 *   a caller happens to have them. Takes priority over competitorNames.
 * @param {number} [ctx.llmTimeoutMs]
 * @param {Object} [ctx.stats] - optional {cost,tokens} accumulator forwarded
 *   to llmJson (see src/lib/llm.js) — omit when the caller has nowhere
 *   meaningful to record it.
 * @param {Object} [deps]
 * @param {Function} [deps.llmJson] - test injection; defaults to the real
 *   free-model choke point (src/lib/llm.js llmJson).
 * @param {Map} [deps.cache] - test injection; defaults to the shared
 *   module-level cache.
 * @returns {Promise<Array>} new row objects with content_type/domain_type/
 *   citation_class added.
 */
export async function enrichCitations(rows, ctx = {}, deps = {}) {
  const list = Array.isArray(rows) ? rows : [];
  if (list.length === 0) return [];

  const llmJsonFn = deps.llmJson || llmJson;
  const cache = deps.cache || moduleContentTypeCache;

  const brandDomain = ctx.brandDomain || "";
  const competitorNames = ctx.competitorNames || [];

  // Resolve competitor DOMAINS for this batch. Prefer exact domains if the
  // caller has them; otherwise fuzzy-match the domains actually observed in
  // this batch against tracked rival NAMES via the existing alias/word
  // matcher (scoring/citations.js classifyCitation) — the only competitor
  // signal available at either call site today (scanWorker.js's
  // competitorObjects and a backfilled scan's raw_results.competitors both
  // carry names, not domains — matchCompetitorsBack strips the domain field
  // once a competitor is scored).
  let competitorDomains = ctx.competitorDomains || [];
  if (competitorDomains.length === 0 && competitorNames.length > 0) {
    const distinctDomains = Array.from(new Set(list.map((r) => r.domain).filter(Boolean)));
    competitorDomains = distinctDomains.filter(
      (d) => classifyCitation(d, "", competitorNames) === "competitor"
    );
  }

  const domainCtx = { brandDomain, competitorDomains };

  const enriched = list.map((row) => {
    const domain_type = classifyDomainType(row.domain, domainCtx);
    const citation_class = classifyCitationClass(domain_type);
    return { ...row, domain_type, citation_class, content_type: null };
  });

  // Heuristic pass + cache lookups; anything still unresolved is queued for
  // ONE batched LLM call, deduped by (domain, path-shape) cache key.
  const unresolvedByKey = new Map(); // key -> { domain, path, title }
  const indicesByKey = new Map(); // key -> [row indices in `enriched`]

  enriched.forEach((row, i) => {
    const heuristic = classifyContentType(row.url, row.title);
    if (heuristic) {
      row.content_type = heuristic;
      return;
    }
    const key = cacheKeyFor(row.domain, row.url);
    if (cache.has(key)) {
      row.content_type = cache.get(key);
      return;
    }
    if (!unresolvedByKey.has(key)) {
      unresolvedByKey.set(key, { domain: row.domain, path: safePathname(row.url), title: row.title || "" });
    }
    const indices = indicesByKey.get(key) || [];
    indices.push(i);
    indicesByKey.set(key, indices);
  });

  if (unresolvedByKey.size > 0) {
    const keys = Array.from(unresolvedByKey.keys()).slice(0, MAX_LLM_BATCH);
    const items = keys.map((k) => unresolvedByKey.get(k));

    try {
      const parsed = await llmJsonFn(buildContentTypePrompt(items), {
        stats: ctx.stats,
        timeout: ctx.llmTimeoutMs || 20000,
      });
      const typeList = coerceTypeList(parsed);
      if (typeList) {
        keys.forEach((key, i) => {
          const value = normalizeContentType(typeList[i]);
          if (value) cache.set(key, value);
        });
      } else {
        console.warn(
          `[citationEnrich] LLM content_type batch returned an unusable shape (${
            parsed === null ? "null" : typeof parsed
          }) for ${keys.length} unresolved URL shape(s) — falling back to "other".`
        );
      }
    } catch (err) {
      // Fail-loud-SOFT by design (project policy): a classification hiccup
      // must never fail an otherwise-successful scan. Logged so a systemic
      // LLM outage stays visible; every affected row still gets a definite
      // (if generic) content_type via the fallback below.
      //
      // This is one of the few callers that legitimately tolerates an
      // LlmUnavailableError (src/lib/llmErrors.js): content_type is a
      // presentational label with a definite "other" fallback, not a metric.
      // It is named separately so a total outage does not read like a
      // per-batch hiccup in the logs.
      const unavailable = isLlmUnavailable(err);
      console.warn(
        `[citationEnrich] LLM content_type batch ${
          unavailable ? `SKIPPED — LLM unavailable (${err.reason})` : "failed"
        } for ${keys.length} unresolved URL shape(s): ${err.message} — all affected rows fall back to "other".`
      );
    }

    // Anything still without a cached value (LLM failed, returned a
    // malformed shape, omitted an index, or got cut by MAX_LLM_BATCH) falls
    // back to "other" — never left null.
    unresolvedByKey.forEach((_item, key) => {
      if (!cache.has(key)) cache.set(key, "other");
      const resolved = cache.get(key);
      (indicesByKey.get(key) || []).forEach((i) => {
        enriched[i].content_type = resolved;
      });
    });
  }

  return enriched;
}
