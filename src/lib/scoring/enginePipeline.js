import { brightDataSearch, extractBrightDataAiOverview, extractBrightDataOrganic } from "../engines/brightdata.js";
import { probeChatGpt, isChatGptConfigured } from "../engines/openai.js";
import { probePerplexity, isPerplexityConfigured } from "../engines/perplexity.js";
import { getBrandAliases } from "./aliases.js";
import { isBrandedQuery, resolveQueryIntentTier } from "./aioQueryClassify.js";
import { detectMention, judgeBrandsSymmetric } from "./judge.js";
import { countBrandsElicited } from "./promptQuality.js";
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
 * A probe that succeeded at the transport level but carried nothing back.
 *
 * Exported so the four-state outcome vocabulary (R2.1) and the surfaces that
 * render provenance can recognise this case by identity rather than by
 * string-matching a log line.
 */
export const EMPTY_ANSWER = "empty_answer";

/**
 * Probes a single query on a text-matching engine (ChatGPT or Perplexity).
 *
 * These engines USUALLY produce text, but not always: a 200 can carry an empty
 * body, and that is an error row rather than an answered one (R2.2.1). The
 * previous wording here — "always produce an answer unless the API errors" —
 * was the assumption that made the bug invisible.
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

  // R2.2.1 — answer_present is decided AFTER the text check, never before it.
  //
  // This used to read "text-matching engines always answer unless they errored"
  // and set answer_present = true unconditionally. A 200 carrying an empty body
  // therefore became an ANSWERED NON-MENTION: text "", so no mention detection
  // ran, so visible stayed false — a zero in the numerator and a one in the
  // denominator at summarizeEngineSlice, both fabricated. The engine never said
  // the brand was absent. It said nothing at all, and those are different
  // claims. A skip is not a success and an empty answer is not a non-mention.
  //
  // The predicate matches probeAio's at :64-69 deliberately: an answer counts
  // if it has text OR citations, so the two engine paths cannot disagree about
  // what "answered" means while feeding the same rate.
  const hasText = Boolean(result.text && result.text.trim());
  const hasCitations = result.citations.length > 0 || result.references.length > 0;

  if (!hasText && !hasCitations) {
    result.error = EMPTY_ANSWER;
    result.answer_present = false;
    console.warn(
      `[${engineName}] Empty answer: "${query.text}" — the call succeeded but returned ` +
        `no text and no citations. Typed as an error, not as a non-mention.`
    );
    return result;
  }

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

  // --- The eliciting pool: prompts whose answer named ANY roster vendor -----
  //
  // A brand cannot be mentioned in an answer that names nobody. Scoring over
  // every answered prompt therefore divides by impossibility: on the Italica
  // scan, 40 of 56 answered unbranded prompts ("how to calculate tiles needed
  // for room", "how much do vitrified tiles cost per sqft") returned taxonomy
  // and how-to answers naming zero vendors, permanently capping the achievable
  // score at 16/56 before the brand's real visibility was ever measured.
  //
  // `r.brands` is judgeBrandsSymmetric's output (P1.2), already computed for
  // every result — so this costs nothing extra and cannot drift from the
  // mention data the score itself uses.
  //
  // FALLBACK — the roster must contain RIVALS for this filter to mean anything.
  //
  // Competitors are discovered in runFinalizePhase, AFTER probing, so during a
  // live scan `r.brands` holds only the self brand. With a self-only roster
  // "did this answer name any vendor" degenerates into "did this answer name
  // US", which makes the eliciting pool identical to the numerator and forces
  // the score to 0/0 or a meaningless 100%. A live Italica scan reproduced
  // exactly that: aio eliciting_queries=0 -> visibility 0, and perplexity
  // 1 eliciting / 1 visible -> visibility_pct 100 for a brand with essentially
  // no presence. Far worse than the bug this filter exists to fix.
  //
  // So: apply the filter only when at least one NON-SELF roster brand is
  // present anywhere in the slice. Otherwise keep the previous denominator —
  // absence of a rival roster is absence of evidence, not evidence that
  // nothing was elicited.
  const hasRivalRoster = nonBrandedWithAnswer.some(
    (r) => Array.isArray(r.brands) && r.brands.some((b) => b && !(b.is_self ?? b.isSelf))
  );
  const elicitingPool = hasRivalRoster
    ? nonBrandedWithAnswer.filter((r) => countBrandsElicited(r.brands) >= 1)
    : nonBrandedWithAnswer;
  const deadPrompts = nonBrandedWithAnswer.length - elicitingPool.length;

  const visibleNonBranded = elicitingPool.filter((r) => r.visible).length;
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

  // Denominator is the ELICITING pool, not every answered prompt (see above).
  const visibilityPct =
    elicitingPool.length > 0
      ? Math.round((visibleNonBranded / elicitingPool.length) * 1000) / 10
      : 0;

  // What fraction of the prompt set is actually a usable probe? This is a
  // property of the PROMPT SET, not the brand — a low number means the
  // generator produced SEO keywords instead of vendor-selection questions and
  // the scan is measuring almost nothing. Surfaced so it can be alerted on.
  const elicitationRatePct =
    nonBrandedWithAnswer.length > 0
      ? Math.round((elicitingPool.length / nonBrandedWithAnswer.length) * 1000) / 10
      : 0;

  // --- Share of Voice over the eliciting pool ------------------------------
  // Presence answers "how often do they name me". SOV answers "when they name
  // someone, how often is it me" — the question a brand with a low score
  // actually needs answered, and the one that names who is winning instead.
  let selfMentions = 0;
  let allMentions = 0;
  const rivalMentions = {};
  for (const r of elicitingPool) {
    for (const b of r.brands || []) {
      if (!b || !b.mentioned) continue;
      allMentions += 1;
      if (b.is_self ?? b.isSelf) selfMentions += 1;
      else if (b.name) rivalMentions[b.name] = (rivalMentions[b.name] || 0) + 1;
    }
  }
  // SOV is UNDEFINED without rivals, not 0 and not 100. With a self-only
  // roster the only brand counted is us, so every mention is ours and the
  // ratio is 100% by construction — a live scan reported exactly that
  // (1/1 = 100%) for a brand with one mention in thirty answers. Null makes
  // the dashboard say "not available" instead of printing a flattering lie.
  const shareOfVoicePct = !hasRivalRoster
    ? null
    : allMentions > 0
      ? Math.round((selfMentions / allMentions) * 1000) / 10
      : 0;

  const topRivals = Object.entries(rivalMentions)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([name, mentions]) => ({
      name,
      mentions,
      share_pct: allMentions > 0 ? Math.round((mentions / allMentions) * 1000) / 10 : 0,
    }));

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

  // Sample adequacy is judged on the ELICITING pool — the prompts that can
  // actually produce a mention. 56 answered prompts of which only 16 name any
  // vendor is a sample of 16, and reporting it as adequate is how a score gets
  // presented with false confidence.
  const insufficientSample =
    engineName === "aio"
      ? elicitingPool.length < AIO_MIN_NON_BRANDED_WITH_AIO
      : elicitingPool.length < 5;

  return {
    engine: engineName,
    total_queries: total,
    branded_queries: branded.length,
    non_branded_queries: nonBranded.length,
    queries_with_answer: withAnswer.length,
    non_branded_with_answer: nonBrandedWithAnswer.length,
    branded_with_answer: brandedWithAnswer.length,
    errored_queries: errored,
    // Prompt-set health (see elicitationRatePct above).
    eliciting_queries: elicitingPool.length,
    dead_prompts: deadPrompts,
    elicitation_rate_pct: elicitationRatePct,
    // Share of Voice + who is winning instead.
    share_of_voice_pct: shareOfVoicePct,
    self_mentions: selfMentions,
    total_brand_mentions: allMentions,
    top_rivals: topRivals,
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
