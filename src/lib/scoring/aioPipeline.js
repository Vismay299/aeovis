import { brightDataSearch, extractBrightDataAiOverview } from "../engines/brightdata.js";
import { getBrandAliases } from "./aliases.js";
import { detectMention, extractCitations } from "./judge.js";
import { extractBrandDomain, normalizeUrl } from "./citations.js";

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

const CONCURRENCY = 3;

function domainMatches(candidateDomain, target) {
  if (!candidateDomain || !target) return false;
  return candidateDomain === target || candidateDomain.endsWith("." + target);
}

function isBrandedQuery(queryText, brandAliases) {
  if (!queryText) return false;
  return detectMention(queryText, brandAliases);
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

  try {
    const data = await brightDataSearch(query.text, { timeout: 30000, aiOverview: true });
    const { text, citations, references } = extractBrightDataAiOverview(data);
    result.cost = 0.0015;
    if (stats) stats.cost = (stats.cost || 0) + result.cost;

    if (text) {
      result.aio_present = true;
      result.aio_text = text;
      result.aio_citations = citations;
      result.aio_references = (references || []).map((r) => ({
        href: r.href,
        title: r.title || "",
        source: r.source || "",
        domain: extractBrandDomain(r.href),
      }));

      // Brand detection in text
      result.brand_mentioned_in_text = detectMention(text, brandAliases);

      // Brand cited: check if brand domain appears in AIO citations
      if (brandDomain) {
        result.brand_cited = result.aio_citations.some((c) => {
          const d = extractBrandDomain(c);
          return domainMatches(d, brandDomain);
        });
      }

      result.visible = result.brand_mentioned_in_text || result.brand_cited;

      // Competitor detection
      result.competitors_found_in_text = findCompetitorsInText(text, competitors);
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
  const results = await runWithConcurrency(queries, CONCURRENCY, async (query) => {
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

  const aioCoveragePct = total > 0 ? Math.round((withAio.length / total) * 1000) / 10 : 0.0;
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

  // Determine whether the scan is reliable enough to score.
  // Data source issue if too many API errors OR too few queries produced an AIO.
  const dataSourceIssue =
    errorRatePct > 50 ||
    (nonBranded.length > 0 && nonBrandedWithAio.length / nonBranded.length < 0.30);

  const insufficientSample = nonBrandedWithAio.length < 5;

  return {
    results,
    summary: {
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
      aio_coverage_pct: aioCoveragePct,
      error_rate_pct: errorRatePct,
      visibility_pct: visibilityPct,
      branded_visibility_pct: brandedVisibilityPct,
      mention_rate_pct: mentionRatePct,
      citation_share_pct: citationSharePct,
      data_source_issue: dataSourceIssue,
      insufficient_sample: insufficientSample,
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
