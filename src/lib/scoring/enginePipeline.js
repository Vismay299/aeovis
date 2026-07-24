import { brightDataSearch, extractBrightDataAiOverview, extractBrightDataOrganic } from "../engines/brightdata.js";
import { probeChatGpt, isChatGptConfigured } from "../engines/openai.js";
import { probePerplexity, isPerplexityConfigured } from "../engines/perplexity.js";
import { getBrandAliases } from "./aliases.js";
import { isBrandedQuery, resolveQueryIntentTier } from "./aioQueryClassify.js";
import { detectMention, judgeBrandsSymmetric } from "./judge.js";
import { extractBrandDomain } from "./citations.js";
import {
  AIO_CONCURRENCY,
  AIO_ERROR_RATE_LIMIT_PCT,
  AIO_MIN_NON_BRANDED_COVERAGE,
  AIO_MIN_NON_BRANDED_WITH_AIO,
} from "./aioConstants.js";

const CHATGPT_CONCURRENCY = 4;
const PERPLEXITY_CONCURRENCY = 4;

export function domainMatches(candidateDomain, target) {
  if (!candidateDomain || !target) return false;
  return candidateDomain === target || candidateDomain.endsWith("." + target);
}

/**
 * Probes a single query on the Google AIO engine (Bright Data SERP).
 * Returns the same result-row shape as probeQueryOnEngine uses.
 */
async function probeAio(query, brand, brandAliases, brandDomain, competitors, stats) {
  const result = {
    engine: "aio",
    prompt: query.text,
    is_branded_query: isBrandedQuery(query.text, brandAliases),
    topic: query.topic || "General",
    source: query.source || "unknown",
    intent_tier: resolveQueryIntentTier(query),
    answer_present: false,
    aio_present: false, // backward compat
    text: "",
    citations: [],
    references: [],
    brand_mentioned_in_text: false,
    brand_cited: false,
    visible: false,
    competitors_found_in_text: [],
    competitors_cited: [],
    brands: [], // P1.2 — symmetric self+rival mention/position/sentiment (populated below once there's text to judge)
    error: null,
    cost: 0,
  };

  try {
    const data = await brightDataSearch(query.text, { timeout: 60000, aiOverview: true });
    const { text, citations, references } = extractBrightDataAiOverview(data);
    const organic = extractBrightDataOrganic(data);
    result.organic = organic;
    if (brandDomain && organic.length > 0) {
      const brandPos = organic.findIndex(
        (o) => o.domain === brandDomain || o.domain.endsWith("." + brandDomain)
      );
      result.brand_organic_position = brandPos >= 0 ? brandPos + 1 : null;
    }
    result.cost = 0.0015;
    if (stats) stats.cost = (stats.cost || 0) + result.cost;

    const hasText = Boolean(text && text.trim());
    const hasCitations = (citations?.length || 0) > 0 || (references?.length || 0) > 0;

    if (hasText || hasCitations) {
      result.answer_present = true;
      result.aio_present = true;
      result.text = text || "";

      if (citations?.length) result.citations = citations;
      if (references?.length) {
        result.references = references.map((r) => ({
          href: r.href,
          title: r.title || "",
          source: r.source || "",
          domain: extractBrandDomain(r.href),
        }));
      }

      if (hasText) {
        result.brand_mentioned_in_text = detectMention(text, brandAliases);
        result.competitors_found_in_text = findCompetitorsInText(text, competitors);
        result.brands = judgeBrandsSymmetric(text, buildTrackedBrandRoster(brand, brandAliases, competitors));
      }

      if (brandDomain) {
        result.brand_cited = result.references.some(
          (ref) => domainMatches(ref.domain || extractBrandDomain(ref.href), brandDomain)
        );
      }

      result.visible = result.brand_mentioned_in_text || result.brand_cited;
      result.competitors_cited = findCompetitorsCited(result.references, competitors);
    }
  } catch (err) {
    result.error = err.message || String(err);
    console.warn(`[aio] Query failed: "${query.text}" — ${result.error}`);
  }

  return result;
}

/**
 * Probes a single query on a text-matching engine (ChatGPT or Perplexity).
 * These engines always produce an answer (text) unless the API errors.
 */
async function probeTextEngine(engine, query, brand, brandAliases, brandDomain, competitors, stats) {
  const probeFn = engine.probe;
  const engineName = engine.name;

  const result = {
    engine: engineName,
    prompt: query.text,
    is_branded_query: isBrandedQuery(query.text, brandAliases),
    topic: query.topic || "General",
    source: query.source || "unknown",
    intent_tier: resolveQueryIntentTier(query),
    answer_present: false,
    aio_present: false,
    text: "",
    citations: [],
    references: [],
    brand_mentioned_in_text: false,
    brand_cited: false,
    visible: false,
    competitors_found_in_text: [],
    competitors_cited: [],
    brands: [], // P1.2 — see probeAio's field of the same name
    error: null,
    cost: 0,
  };

  const probeResult = await probeFn(query.text, { stats });

  if (probeResult.error) {
    result.error = probeResult.error;
    result.cost = probeResult.cost || 0;
    console.warn(`[${engineName}] Query failed: "${query.text}" — ${probeResult.error}`);
    return result;
  }

  result.cost = probeResult.cost || 0;
  result.text = probeResult.text || "";
  result.citations = probeResult.citations || [];
  result.references = (probeResult.references || []).map((r) => ({
    href: r.href,
    title: r.title || "",
    source: r.source || "",
    domain: extractBrandDomain(r.href),
  }));
  // Text-matching engines always answer unless they errored
  result.answer_present = true;

  if (result.text) {
    result.brand_mentioned_in_text = detectMention(result.text, brandAliases);
    result.competitors_found_in_text = findCompetitorsInText(result.text, competitors);
    result.brands = judgeBrandsSymmetric(result.text, buildTrackedBrandRoster(brand, brandAliases, competitors));
  }

  if (brandDomain) {
    result.brand_cited = result.references.some(
      (ref) => domainMatches(ref.domain || extractBrandDomain(ref.href), brandDomain)
    );
  }

  result.visible = result.brand_mentioned_in_text || result.brand_cited;
  result.competitors_cited = findCompetitorsCited(result.references, competitors);

  return result;
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

/**
 * Builds the tracked-brand roster for P1.2 symmetric judging: the self brand
 * plus every tracked competitor, each with its resolved alias list, for
 * judgeBrandsSymmetric to rank/score in one pass over the answer text.
 * Competitor aliases are resolved exactly the way findCompetitorsInText/
 * findCompetitorsCited already do — getBrandAliases(comp, ""), no website
 * known for a rival — so "tracked" here means the same `competitors` list
 * already threaded through this file (frozen at sourcing time onto the
 * scan's checkpoint), not the richer LLM-discovered competitor set
 * extractCompetitors computes later at finalize time for display.
 */
export function buildTrackedBrandRoster(brand, brandAliases, competitors) {
  const roster = [{ name: brand, aliases: brandAliases, isSelf: true }];
  (competitors || []).forEach((comp) => {
    roster.push({ name: comp, aliases: getBrandAliases(comp, ""), isSelf: false });
  });
  return roster;
}

function findCompetitorsCited(references, competitors) {
  if (!references?.length || !competitors?.length) return [];
  const hits = new Set();
  competitors.forEach((comp) => {
    const aliases = getBrandAliases(comp, "").map((a) => a.toLowerCase());
    for (const ref of references) {
      const domain = ref.domain || extractBrandDomain(ref.href);
      if (!domain) continue;
      const parts = domain.split(".");
      const brandWord = parts[parts.length - 2] || parts[0] || "";
      if (
        aliases.some(
          (a) =>
            a.length >= 3 &&
            (a.includes(".") ? domainMatches(domain, a) : brandWord === a || parts.includes(a))
        )
      ) {
        hits.add(comp);
        break;
      }
    }
  });
  return Array.from(hits);
}

/**
 * Engine-aware summary over a slice of results from one engine.
 * Mirrors summarizeAioResults logic exactly to keep denominators consistent.
 *
 * Exported (P0.2 follow-up de-dup) so src/lib/workers/scanWorker.js can
 * import this directly instead of keeping its own hand-copy — the chunk
 * worker's finalize phase reconstructs per-engine summaries from persisted
 * `raw` rows after a chunked, possibly multi-invocation probe phase, which
 * runMultiEngineScan's own (in-process, single-call) use below can't serve.
 * Keep this the ONLY implementation; a second copy is exactly the drift risk
 * this export closes off.
 */
export function summarizeEngineSlice(results, engineName) {
  const total = results.length;
  const errored = results.filter((r) => r.error).length;
  const withAnswer = results.filter((r) => r.answer_present);
  const branded = results.filter((r) => r.is_branded_query);
  const nonBranded = results.filter((r) => !r.is_branded_query);

  const nonBrandedWithAnswer = nonBranded.filter((r) => r.answer_present);
  const brandedWithAnswer = branded.filter((r) => r.answer_present);

  const visibleNonBranded = nonBrandedWithAnswer.filter((r) => r.visible).length;
  const visibleBranded = brandedWithAnswer.filter((r) => r.visible).length;

  const mentionedNonBranded = nonBrandedWithAnswer.filter((r) => r.brand_mentioned_in_text).length;
  const citedNonBranded = nonBrandedWithAnswer.filter((r) => r.brand_cited).length;

  const rankNotCited = nonBrandedWithAnswer.filter(
    (r) => r.brand_organic_position && r.brand_organic_position <= 10 && !r.visible
  );
  const rank_not_cited_count = rankNotCited.length;

  const coveragePct =
    nonBranded.length > 0
      ? Math.round((nonBrandedWithAnswer.length / nonBranded.length) * 1000) / 10
      : 0;
  const errorRatePct = total > 0 ? Math.round((errored / total) * 1000) / 10 : 0;

  const visibilityPct =
    nonBrandedWithAnswer.length > 0
      ? Math.round((visibleNonBranded / nonBrandedWithAnswer.length) * 1000) / 10
      : 0;

  const presenceRatePct =
    nonBranded.length > 0
      ? Math.round((visibleNonBranded / nonBranded.length) * 1000) / 10
      : 0;

  // Text engines always answer, so coverage is always 100% and error rate is the only gate.
  const dataSourceIssue =
    engineName === "aio"
      ? errorRatePct > AIO_ERROR_RATE_LIMIT_PCT ||
        (nonBranded.length > 0 &&
          nonBrandedWithAnswer.length / nonBranded.length < AIO_MIN_NON_BRANDED_COVERAGE)
      : errorRatePct > 50;

  const insufficientSample =
    engineName === "aio"
      ? nonBrandedWithAnswer.length < AIO_MIN_NON_BRANDED_WITH_AIO
      : nonBrandedWithAnswer.length < 5;

  return {
    engine: engineName,
    total_queries: total,
    branded_queries: branded.length,
    non_branded_queries: nonBranded.length,
    queries_with_answer: withAnswer.length,
    non_branded_with_answer: nonBrandedWithAnswer.length,
    branded_with_answer: brandedWithAnswer.length,
    errored_queries: errored,
    visible_non_branded: visibleNonBranded,
    visible_branded: visibleBranded,
    mentioned_non_branded: mentionedNonBranded,
    cited_non_branded: citedNonBranded,
    rank_not_cited_count,
    coverage_pct: coveragePct,
    error_rate_pct: errorRatePct,
    share_of_ai_pct: visibilityPct,
    visibility_pct: visibilityPct,
    presence_rate_pct: presenceRatePct,
    data_source_issue: dataSourceIssue,
    insufficient_sample: insufficientSample,
  };
}

/**
 * Relative engine weights for the headline index (prompt-set contract,
 * 2026-07-20: 50/50 today, configurable without rework). Weights are
 * RELATIVE — they are renormalized over whichever engines are eligible in a
 * given scan, so aio:1 + perplexity:1 is a 50/50 blend when both report, and
 * 100% of whichever one is alone. Change the blend here (or extend to an env
 * override) — never inline weights at call sites.
 */
export const ENGINE_WEIGHTS = {
  aio: 1,
  chatgpt: 1,
  perplexity: 1,
};

/**
 * Computes the headline "AI Visibility Index" — weighted mean of per-engine
 * share_of_ai across engines that produced ≥5 non-branded answers.
 */
export function computeHeadline(engineSummaries, weights = ENGINE_WEIGHTS) {
  const eligible = engineSummaries.filter(
    (s) => !s.data_source_issue && s.non_branded_with_answer >= 5
  );
  if (eligible.length === 0) {
    return { visibility_index_pct: null, engines_counted: 0 };
  }
  const totalWeight = eligible.reduce(
    (acc, s) => acc + (weights[s.engine] ?? 1),
    0
  );
  const weightedSum = eligible.reduce(
    (acc, s) => acc + s.share_of_ai_pct * (weights[s.engine] ?? 1),
    0
  );
  const mean = Math.round((weightedSum / totalWeight) * 10) / 10;
  return { visibility_index_pct: mean, engines_counted: eligible.length };
}

const ENGINE_REGISTRY = [
  {
    name: "aio",
    label: "Google AIO",
    isConfigured: () => true,
    probe: probeAio,
    concurrency: AIO_CONCURRENCY,
  },
  {
    name: "chatgpt",
    label: "ChatGPT",
    isConfigured: isChatGptConfigured,
    probe: async (query, brand, brandAliases, brandDomain, competitors, stats) =>
      probeTextEngine(
        { name: "chatgpt", probe: probeChatGpt },
        query,
        brand,
        brandAliases,
        brandDomain,
        competitors,
        stats
      ),
    concurrency: CHATGPT_CONCURRENCY,
  },
  {
    name: "perplexity",
    label: "Perplexity",
    isConfigured: isPerplexityConfigured,
    probe: async (query, brand, brandAliases, brandDomain, competitors, stats) =>
      probeTextEngine(
        { name: "perplexity", probe: probePerplexity },
        query,
        brand,
        brandAliases,
        brandDomain,
        competitors,
        stats
      ),
    concurrency: PERPLEXITY_CONCURRENCY,
  },
];

export function resolveEnabledEngines() {
  const envVal = (process.env.ENGINES || "aio").trim();
  const requested = envVal.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);

  const enabled = [];
  const skipped = [];

  for (const name of requested) {
    const def = ENGINE_REGISTRY.find((e) => e.name === name);
    if (!def) {
      console.warn(`[engine-pipeline] Unknown engine "${name}" — skipping`);
      skipped.push(name);
      continue;
    }
    if (!def.isConfigured()) {
      console.warn(`[engine-pipeline] Engine "${name}" not configured (missing API key) — skipping`);
      skipped.push(name);
      continue;
    }
    enabled.push(def);
  }

  if (enabled.length === 0) {
    console.warn("[engine-pipeline] No engines enabled! Defaulting to aio.");
    const aioDef = ENGINE_REGISTRY.find((e) => e.name === "aio");
    return [aioDef];
  }

  return enabled;
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

export async function runMultiEngineScan({ brand, url, competitors = [], queries, stats, onProgress }) {
  const engines = resolveEnabledEngines();
  const brandAliases = getBrandAliases(brand, url);
  const brandDomain = extractBrandDomain(url);

  console.log(
    `[engine-pipeline] Engines enabled: ${engines.map((e) => e.name).join(", ")}`
  );

  const allResults = [];
  const engineSummaries = {};

  let totalCompleted = 0;
  const totalWork = queries.length * engines.length;

  // Run engines sequentially with per-engine concurrency caps
  for (const engine of engines) {
    console.log(
      `[engine-pipeline] Probing ${queries.length} queries on ${engine.name} (concurrency=${engine.concurrency})`
    );

    const engineResults = await runWithConcurrency(queries, engine.concurrency, async (query) => {
      const res = await engine.probe(query, brand, brandAliases, brandDomain, competitors, stats);
      totalCompleted++;
      if (onProgress) onProgress(totalCompleted, totalWork);
      return res;
    });

    allResults.push(...engineResults);
    engineSummaries[engine.name] = summarizeEngineSlice(engineResults, engine.name);

    console.log(
      `[engine-pipeline] ${engine.name}: ${engineSummaries[engine.name].non_branded_with_answer} non-branded with answer, ` +
        `${engineSummaries[engine.name].visible_non_branded} visible, share_of_ai=${engineSummaries[engine.name].share_of_ai_pct}%`
    );
  }

  const headline = computeHeadline(Object.values(engineSummaries));

  return {
    results: allResults,
    engines: engineSummaries,
    headline,
  };
}

export function summarizeEngineResults(scanOutput) {
  const { engines, headline } = scanOutput;

  // The AIO engine summary serves as the backward-compat "summary" object
  const aioSummary = engines.aio || Object.values(engines)[0] || {};

  return {
    results: scanOutput.results,
    summary: {
      // Backward-compat: AIO values
      total_queries: aioSummary.total_queries || 0,
      branded_queries: aioSummary.branded_queries || 0,
      non_branded_queries: aioSummary.non_branded_queries || 0,
      queries_with_aio: aioSummary.queries_with_answer || 0,
      non_branded_with_aio: aioSummary.non_branded_with_answer || 0,
      branded_with_aio: aioSummary.branded_with_answer || 0,
      errored_queries: aioSummary.errored_queries || 0,
      visible_non_branded: aioSummary.visible_non_branded || 0,
      visible_branded: aioSummary.visible_branded || 0,
      mentioned_non_branded: aioSummary.mentioned_non_branded || 0,
      cited_non_branded: aioSummary.cited_non_branded || 0,
      aio_coverage_pct: aioSummary.coverage_pct || 0,
      error_rate_pct: aioSummary.error_rate_pct || 0,
      visibility_pct: aioSummary.visibility_pct || 0,
      share_of_ai_pct: aioSummary.share_of_ai_pct || 0,
      presence_rate_pct: aioSummary.presence_rate_pct || 0,
      branded_visibility_pct: aioSummary.branded_with_answer > 0
        ? Math.round((aioSummary.visible_branded / aioSummary.branded_with_answer) * 1000) / 10
        : 0,
      mention_rate_pct: aioSummary.non_branded_with_answer > 0
        ? Math.round((aioSummary.mentioned_non_branded / aioSummary.non_branded_with_answer) * 1000) / 10
        : 0,
      citation_share_pct: aioSummary.non_branded_with_answer > 0
        ? Math.round((aioSummary.cited_non_branded / aioSummary.non_branded_with_answer) * 1000) / 10
        : 0,
      data_source_issue: aioSummary.data_source_issue || false,
      insufficient_sample: aioSummary.insufficient_sample || false,
      thresholds: {
        error_rate_limit_pct: AIO_ERROR_RATE_LIMIT_PCT,
        min_non_branded_coverage: AIO_MIN_NON_BRANDED_COVERAGE,
        min_non_branded_with_aio: AIO_MIN_NON_BRANDED_WITH_AIO,
      },
    },
    engines,
    headline,
  };
}
