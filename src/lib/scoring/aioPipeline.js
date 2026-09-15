import { brightDataSearch, extractBrightDataAiOverview, extractBrightDataOrganic } from "../engines/brightdata.js";
import { resolveSerpQueryCost } from "../llmPricing.js";
import { getBrandAliases } from "./aliases.js";
import {
  AIO_CONCURRENCY,
  AIO_ERROR_RATE_LIMIT_PCT,
  AIO_MIN_NON_BRANDED_COVERAGE,
  AIO_MIN_NON_BRANDED_WITH_AIO,
} from "./aioConstants.js";
import { isBrandedQuery, resolveQueryIntentTier } from "./aioQueryClassify.js";
import { detectMention } from "./judge.js";
import { extractBrandDomain } from "./citations.js";
import { countBrandsElicited } from "./promptQuality.js";
import { ratioPctOrNull } from "./measuredNumber.js";

/**
 * AIO-Only Probing Pipeline
 *
 * Single source of truth: Google AI Overview via BrightData SERP API.
 *
 * For each query we produce:
 *  - aio_present (boolean)
 *  - aio_text (string) — the raw text of Google's AI Overview
 *  - aio_citations (array of { href, title, source, domain })
 *  - brand_mentioned_in_text (boolean)
 *  - brand_cited (boolean)  — brand domain appears in AIO references
 *  - visible (boolean)      — either mentioned or cited
 *  - competitors_found_in_text (string[])
 *  - competitors_cited (string[])
 *  - is_branded_query (boolean) — the query contains a brand alias
 *  - error (string|null)    — set when the API errored for this query
 */

function domainMatches(candidateDomain, target) {
  if (!candidateDomain || !target) return false;
  return candidateDomain === target || candidateDomain.endsWith("." + target);
}

function findCompetitorsInText(text, competitors) {
  if (!text || !competitors?.length) return [];
  const hits = new Set();
  competitors.forEach((comp) => {
    const aliases = getBrandAliases(comp, "");
    if (detectMention(text, aliases)) hits.add(comp);
  });
  return Array.from(hits);
}

function findCompetitorsCited(citations, competitors) {
  if (!citations?.length || !competitors?.length) return [];
  const hits = new Set();
  competitors.forEach((comp) => {
    const aliases = getBrandAliases(comp, "").map((a) => a.toLowerCase());
    for (const c of citations) {
      const domain = extractBrandDomain(c);
      if (!domain) continue;
      const parts = domain.split(".");
      const brandWord = parts[parts.length - 2] || parts[0] || "";
      // Match by alias inclusion in domain OR direct brand-word match
      if (
        aliases.some((a) =>
          a.length >= 3 &&
          (a.includes(".")
            ? domainMatches(domain, a)
            : brandWord === a || parts.includes(a))
        )
      ) {
        hits.add(comp);
        break;
      }
    }
  });
  return Array.from(hits);
}

async function probeQueryOnce(query, brand, brandAliases, brandDomain, competitors, stats) {
  const result = {
    prompt: query.text,
    is_branded_query: isBrandedQuery(query.text, brandAliases),
    topic: query.topic || "General",
    source: query.source || "unknown",
    // Own-name panel only — never set "branded" just because the text contains an alias
    intent_tier: resolveQueryIntentTier(query),
    aio_present: false,
    aio_text: "",
    aio_citations: [],
    aio_references: [],
    brand_mentioned_in_text: false,
    brand_cited: false,
    visible: false,
    competitors_found_in_text: [],
    competitors_cited: [],
    error: null,
    cost: 0.0,
  };

  // R3.6.4 — one Bright Data query costs whatever the price table in
  // src/lib/llmPricing.js says it costs; this file used to restate the number
  // itself, as did enginePipeline.js and serp.js, and three copies of a price
  // drift independently.
  //
  // Resolved OUTSIDE the try on purpose. The catch below records a throw as a
  // per-query error row and leaves `cost` at 0, so a pricing refusal raised in
  // there would arrive downstream as a query that failed for free. The price
  // is a configuration fact, identical for all 30 queries: if it cannot be
  // established, the right blast radius is the scan, not one row.
  const { cost: queryCost } = resolveSerpQueryCost({ provider: "brightdata" });

  try {
    // Bright Data SERP responses for AI Overview average ~45-50s; a 30s
    // timeout aborts the majority of otherwise-successful queries and inflates
    // the error rate. Use 60s (matches brightdata.js default) so real responses
    // land. Retries are handled inside brightDataSearch.
    const data = await brightDataSearch(query.text, { timeout: 60000, aiOverview: true });
    const { text, citations, references } = extractBrightDataAiOverview(data);
    const organic = extractBrightDataOrganic(data);
    result.organic = organic;
    result.organic_position = organic.map((o) => o.domain);
    if (brandDomain && organic.length > 0) {
      const brandPos = organic.findIndex((o) =>
        o.domain === brandDomain || o.domain.endsWith("." + brandDomain)
      );
      result.brand_organic_position = brandPos >= 0 ? brandPos + 1 : null;
    }
    result.cost = queryCost;
    if (stats) stats.cost = (stats.cost || 0) + result.cost;

    const hasText = Boolean(text && text.trim());
    const hasCitations =
      (citations?.length || 0) > 0 || (references?.length || 0) > 0;

    if (hasText || hasCitations) {
      result.aio_present = true;
      result.aio_text = text || "";

      if (citations?.length) {
        result.aio_citations = citations;
      }
      if (references?.length) {
        result.aio_references = references.map((r) => ({
          href: r.href,
          title: r.title || "",
          source: r.source || "",
          domain: extractBrandDomain(r.href),
        }));
      }

      if (hasText) {
        result.brand_mentioned_in_text = detectMention(text, brandAliases);
        result.competitors_found_in_text = findCompetitorsInText(text, competitors);
      }

      // Brand cited: check citations even when overview text is empty
      if (brandDomain) {
        result.brand_cited = result.aio_citations.some((c) => {
          const d = extractBrandDomain(c);
          return domainMatches(d, brandDomain);
        });
      }

      result.visible = result.brand_mentioned_in_text || result.brand_cited;
      result.competitors_cited = findCompetitorsCited(result.aio_citations, competitors);
    }
  } catch (err) {
    result.error = err.message || String(err);
    console.warn(`[aio] Query failed: "${query.text}" — ${result.error}`);
  }

  return result;
}

async function runWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let idx = 0;
  async function next() {
    while (idx < items.length) {
      const current = idx++;
      results[current] = await worker(items[current], current);
    }
  }
  const runners = Array.from({ length: Math.min(limit, items.length) }, () => next());
  await Promise.all(runners);
  return results;
}

export async function runAioScan({ brand, url, competitors = [], queries, stats, onProgress }) {
  const brandAliases = getBrandAliases(brand, url);
  const brandDomain = extractBrandDomain(url);

  let completed = 0;
  const results = await runWithConcurrency(queries, AIO_CONCURRENCY, async (query) => {
    const res = await probeQueryOnce(query, brand, brandAliases, brandDomain, competitors, stats);
    completed++;
    if (onProgress) onProgress(completed, queries.length);
    return res;
  });

  return summarizeAioResults(results);
}

export function summarizeAioResults(results) {
  const total = results.length;
  const errored = results.filter((r) => r.error).length;
  const withAio = results.filter((r) => r.aio_present);
  const branded = results.filter((r) => r.is_branded_query);
  const nonBranded = results.filter((r) => !r.is_branded_query);

  const nonBrandedWithAio = nonBranded.filter((r) => r.aio_present);
  const brandedWithAio = branded.filter((r) => r.aio_present);

  const visibleNonBranded = nonBrandedWithAio.filter((r) => r.visible).length;
  const visibleBranded = brandedWithAio.filter((r) => r.visible).length;

  const mentionedNonBranded = nonBrandedWithAio.filter((r) => r.brand_mentioned_in_text).length;
  const citedNonBranded = nonBrandedWithAio.filter((r) => r.brand_cited).length;

  // Organic rank-not-cited: non-branded rows where brand is in top 10 organic
  // but was NOT visible in the AI Overview (ranks on Google but not in AIO).
  const rankNotCited = nonBrandedWithAio.filter(
    (r) => r.brand_organic_position && r.brand_organic_position <= 10 && !r.visible
  );
  const rank_not_cited_count = rankNotCited.length;

  // coverage is non-branded only
  const aioCoveragePct =
    nonBranded.length > 0
      ? Math.round((nonBrandedWithAio.length / nonBranded.length) * 1000) / 10
      : 0.0;
  const errorRatePct = total > 0 ? Math.round((errored / total) * 1000) / 10 : 0.0;

  const visibilityPct =
    nonBrandedWithAio.length > 0
      ? Math.round((visibleNonBranded / nonBrandedWithAio.length) * 1000) / 10
      : 0.0;

  const brandedVisibilityPct =
    brandedWithAio.length > 0
      ? Math.round((visibleBranded / brandedWithAio.length) * 1000) / 10
      : 0.0;

  const mentionRatePct =
    nonBrandedWithAio.length > 0
      ? Math.round((mentionedNonBranded / nonBrandedWithAio.length) * 1000) / 10
      : 0.0;

  const citationSharePct =
    nonBrandedWithAio.length > 0
      ? Math.round((citedNonBranded / nonBrandedWithAio.length) * 1000) / 10
      : 0.0;

  // presence_rate_pct = visible ÷ total non-branded queries (denominator = 30,
  // not queries_with_aio) — a second, stricter view of the same "visible" count.
  const presenceRatePct =
    nonBranded.length > 0
      ? Math.round((visibleNonBranded / nonBranded.length) * 1000) / 10
      : 0.0;

  // Determine whether the scan is reliable enough to score.
  // Data source issue if too many API errors OR too few queries produced an AIO.
  const dataSourceIssue =
    errorRatePct > AIO_ERROR_RATE_LIMIT_PCT ||
    (nonBranded.length > 0 &&
      nonBrandedWithAio.length / nonBranded.length < AIO_MIN_NON_BRANDED_COVERAGE);

  const insufficientSample = nonBrandedWithAio.length < AIO_MIN_NON_BRANDED_WITH_AIO;

  // R2.7.5 — share_of_voice_pct over the eliciting pool for AIO-only scans.
  // Preserves the three-way distinction:
  // null = undefined without rivals (or empty eliciting pool),
  // 0 = assessed and nothing mentioned, a number otherwise.
  const hasRivalRoster = nonBrandedWithAio.some(
    (r) => Array.isArray(r.brands) && r.brands.some((b) => b && !(b.is_self ?? b.isSelf))
  );
  const elicitingPool = hasRivalRoster
    ? nonBrandedWithAio.filter((r) => countBrandsElicited(r.brands) >= 1)
    : nonBrandedWithAio;

  let selfMentions = 0;
  let allMentions = 0;
  for (const r of elicitingPool) {
    const brands = Array.isArray(r.brands) ? r.brands : [];
    for (const b of brands) {
      if (!b || !b.mentioned) continue;
      allMentions += 1;
      if (b.is_self ?? b.isSelf) selfMentions += 1;
    }
  }
  const shareOfVoicePct = !hasRivalRoster ? null : ratioPctOrNull(selfMentions, allMentions);

  // Scoring contract — three consistently-defined numbers, never mixed:
  //   visibility_pct / share_of_ai_pct (HERO) = visible ÷ queries_with_aio (non-branded)
  //   aio_coverage_pct                        = queries_with_aio ÷ 30 (non-branded)
  //   presence_rate_pct                       = visible ÷ 30 (non-branded)
  return {
    results,
    summary: {
      share_of_voice_pct: shareOfVoicePct,
      total_queries: total,
      branded_queries: branded.length,
      non_branded_queries: nonBranded.length,
      queries_with_aio: withAio.length,
      non_branded_with_aio: nonBrandedWithAio.length,
      branded_with_aio: brandedWithAio.length,
      errored_queries: errored,
      visible_non_branded: visibleNonBranded,
      visible_branded: visibleBranded,
      mentioned_non_branded: mentionedNonBranded,
      cited_non_branded: citedNonBranded,
      rank_not_cited_count,
      aio_coverage_pct: aioCoveragePct,
      error_rate_pct: errorRatePct,
      visibility_pct: visibilityPct,
      share_of_ai_pct: visibilityPct,
      presence_rate_pct: presenceRatePct,
      branded_visibility_pct: brandedVisibilityPct,
      mention_rate_pct: mentionRatePct,
      citation_share_pct: citationSharePct,
      data_source_issue: dataSourceIssue,
      insufficient_sample: insufficientSample,
      thresholds: {
        error_rate_limit_pct: AIO_ERROR_RATE_LIMIT_PCT,
        min_non_branded_coverage: AIO_MIN_NON_BRANDED_COVERAGE,
        min_non_branded_with_aio: AIO_MIN_NON_BRANDED_WITH_AIO,
      },
    },
  };
}

// Aggregate top cited domains across all AIO results
export function aggregateAioTopDomains(results, brandUrl, competitors = []) {
  if (!results?.length) return [];
  const brandDomain = extractBrandDomain(brandUrl);

  const counts = {};
  results.forEach((r) => {
    const seen = new Set();
    (r.aio_references || []).forEach((ref) => {
      const domain = ref.domain || extractBrandDomain(ref.href);
      if (!domain || seen.has(domain)) return;
      seen.add(domain);
      counts[domain] = (counts[domain] || 0) + 1;
    });
  });

  const compAliases = new Map();
  competitors.forEach((comp) => {
    compAliases.set(
      comp,
      getBrandAliases(comp, "").map((a) => a.toLowerCase())
    );
  });

  return Object.entries(counts)
    .map(([domain, count]) => {
      let type = "third_party";
      if (brandDomain && domainMatches(domain, brandDomain)) type = "brand";
      else {
        const parts = domain.split(".");
        const brandWord = parts[parts.length - 2] || parts[0] || "";
        for (const [comp, aliases] of compAliases) {
          if (
            aliases.some((a) =>
              a.length >= 3 &&
              (a.includes(".")
                ? domainMatches(domain, a)
                : brandWord === a || parts.includes(a))
            )
          ) {
            type = "competitor";
            break;
          }
        }
      }
      return { domain, count, type };
    })
    .sort((a, b) => b.count - a.count || a.domain.localeCompare(b.domain))
    .slice(0, 15);
}

// Compute per-competitor visibility in the same non-branded AIO pool
export function computeCompetitorAioMetrics(results, competitors) {
  const nonBrandedWithAio = results.filter((r) => !r.is_branded_query && r.aio_present);
  const denom = nonBrandedWithAio.length || 1;

  return competitors.map((comp) => {
    const mentions = nonBrandedWithAio.filter((r) =>
      (r.competitors_found_in_text || []).includes(comp)
    ).length;
    const citations = nonBrandedWithAio.filter((r) =>
      (r.competitors_cited || []).includes(comp)
    ).length;
    const visible = nonBrandedWithAio.filter(
      (r) =>
        (r.competitors_found_in_text || []).includes(comp) ||
        (r.competitors_cited || []).includes(comp)
    ).length;

    // How often did the competitor appear while the tracked brand was absent?
    const userAbsentCount = nonBrandedWithAio.filter(
      (r) =>
        !r.visible &&
        ((r.competitors_found_in_text || []).includes(comp) ||
          (r.competitors_cited || []).includes(comp))
    ).length;

    return {
      name: comp,
      mentions,
      citations,
      prompts: visible,
      userAbsent: userAbsentCount > 0,
      visibilityScore: Math.round((visible / denom) * 1000) / 10,
      citationShare: Math.round((citations / denom) * 1000) / 10,
    };
  });
}
