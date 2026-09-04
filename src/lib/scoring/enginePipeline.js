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
import { ENGINE_LABELS, formatEngineList } from "../engines/deployedEngines.js";

const CHATGPT_CONCURRENCY = 4;
const PERPLEXITY_CONCURRENCY = 4;

/**
 * Minimum non-branded coverage a TEXT engine (chatgpt, perplexity) must reach
 * before its slice is trusted as a complete read.
 *
 * Deliberately far stricter than AIO_MIN_NON_BRANDED_COVERAGE (0.15). That one
 * is loose because a Google SERP carrying no AI Overview is a normal, expected
 * state — absence there is data. A text engine has no such state: since R2.2.1
 * an empty, whitespace-only or null answer is an EMPTY_ANSWER error row with
 * answer_present false, while a genuine refusal ("I don't know") still counts as
 * answered. So anything missing from a text slice is a collection failure, and
 * the only tolerance the gate needs is for transient transport flake.
 *
 * 0.9 leaves room for up to 3 empties in a standard 30-prompt set (29/30 = 96.7%
 * and 27/30 = 90.0% stay clean) while catching the degradation this constant was
 * added for: 4-of-10 empty, which reported coverage_pct 60 with no flag.
 */
export const TEXT_ENGINE_MIN_NON_BRANDED_COVERAGE = 0.9;

/**
 * The error-rate ceiling for a TEXT engine slice. Kept beside the coverage
 * floor so the pair that defines "a text slice is degraded" reads in one place;
 * the value is the one this gate has always used.
 */
export const TEXT_ENGINE_ERROR_RATE_LIMIT_PCT = 50;

/**
 * The health gates for one engine class, in ONE place.
 *
 * The two classes are deliberately different (see the comment above
 * TEXT_ENGINE_MIN_NON_BRANDED_COVERAGE) and must stay different. What must NOT
 * differ is the numbers the flag was computed from and the numbers the banner
 * quotes at the reader. R2.2.6 exists because the scan-level flag was derived
 * from aio alone while the slices were judged per class, so a text-only
 * degradation moved the headline with nothing on screen to explain it. Both
 * summarizeEngineSlice and describeScanDataSourceIssue read this.
 */
export function engineHealthThresholds(engineName) {
  return engineName === "aio"
    ? {
        minNonBrandedCoverage: AIO_MIN_NON_BRANDED_COVERAGE,
        errorRateLimitPct: AIO_ERROR_RATE_LIMIT_PCT,
      }
    : {
        minNonBrandedCoverage: TEXT_ENGINE_MIN_NON_BRANDED_COVERAGE,
        errorRateLimitPct: TEXT_ENGINE_ERROR_RATE_LIMIT_PCT,
      };
}

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

  // A degraded read must not report as clean, on EITHER engine class.
  //
  // This comment used to say "text engines always answer, so coverage is always
  // 100% and error rate is the only gate". R2.2.1 deleted that assumption: an
  // empty, whitespace-only or null answer is now an EMPTY_ANSWER error row with
  // answer_present false, so coverage_pct genuinely drops below 100 for text
  // engines. Error rate alone does not catch it — it only trips above 50%, so a
  // text engine returning nothing for 40% of prompts produced coverage_pct 60,
  // error_rate_pct 40 and NO issue flag. Coverage is gated too, at a threshold
  // chosen for text engines rather than borrowed from aio (see
  // TEXT_ENGINE_MIN_NON_BRANDED_COVERAGE).
  //
  // Both branches require a non-empty denominator: a slice with no non-branded
  // prompts never ran, and never-ran is not a degraded read. The guard is
  // explicit rather than leaning on 0/0 being NaN and NaN < x being false —
  // coverage_pct is reported as 0 for such a slice, so any rewrite of this gate
  // in terms of coverage_pct would flag every empty slice without it.
  // insufficient_sample is what speaks for a slice that never ran.
  const gates = engineHealthThresholds(engineName);
  const dataSourceIssue =
    errorRatePct > gates.errorRateLimitPct ||
    (nonBranded.length > 0 &&
      nonBrandedWithAnswer.length / nonBranded.length < gates.minNonBrandedCoverage);

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
 * The number of non-branded answers a slice must carry before the headline will
 * blend it. Named because describeScanDataSourceIssue has to reproduce the same
 * eligibility test to explain the count it reports.
 */
export const HEADLINE_MIN_NON_BRANDED_ANSWERS = 5;

/**
 * Computes the headline "AI Visibility Index" — weighted mean of per-engine
 * share_of_ai across engines that produced ≥5 non-branded answers.
 */
export function computeHeadline(engineSummaries, weights = ENGINE_WEIGHTS) {
  const eligible = engineSummaries.filter(
    (s) => !s.data_source_issue && s.non_branded_with_answer >= HEADLINE_MIN_NON_BRANDED_ANSWERS
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

/**
 * Why the headline counts the engines it counts — the ONE derivation of the
 * scan-level data source flag, and the words that explain it.
 *
 * R2.2.6 (finding B3). The scan-level flag used to be aioSummary.data_source_issue
 * and nothing else. Once R2.2.5 taught a text slice to raise its own flag, a
 * perplexity engine that stopped answering was correctly dropped from
 * computeHeadline — engines_counted fell from 2 to 1 and visibility_index_pct
 * moved — while the scan-level flag stayed false and the dashboard said
 * nothing. The number moved and the reason was invisible: rule 1, in the shape
 * where the flag exists but is read off the wrong engine.
 *
 * Three states, not two, because "degraded" and "unscoreable" are different
 * facts and collapsing them costs the reader either a score they could have had
 * or an explanation they needed:
 *
 *   "none"     — nothing degraded. Includes the scan that simply has no rows:
 *                a slice that never ran has no non-branded denominator, its own
 *                data_source_issue is false by construction, and insufficient_sample
 *                is what speaks for it. Never-ran is not a degraded read.
 *   "partial"  — at least one engine degraded AND at least one clean engine is
 *                still eligible, so the index is real but blended from fewer
 *                engines. The score stays on screen with the missing engine named.
 *   "critical" — at least one engine degraded and NOTHING eligible is left, so
 *                there is no trustworthy slice to show. This is the state the
 *                dashboard has always blanked the score for.
 *
 * Exactly one severity is returned, so callers render exactly one banner: a
 * scan degraded in both aio and a text engine names both engines in one line
 * rather than stacking two banners.
 *
 * @param {object|Array} engineSummaries  the per-engine slices, as the map
 *   summarizeEngineResults returns or a plain array.
 * THE COUNT IS RECOMPUTED FROM THE SLICES, NOT TAKEN ON TRUST. When slices are
 * present this applies computeHeadline's own eligibility test to them, so the
 * "1 of 2 engines" in the banner is derived from the same rows as the index it
 * is explaining. A stored engines_counted is NOT used for that: normalizeResult
 * defaults it to 0 when the column is absent, and a defaulted 0 read as
 * authoritative would declare an otherwise-healthy scan unscoreable and blank a
 * score we have. It is only echoed back on the legacy path, where there are no
 * slices to recompute from.
 *
 * @param {object} [options]
 * @param {number|null} [options.enginesCounted]  headline.engines_counted when the
 *   caller has it. Echoed on the legacy path only; see above.
 * @param {boolean} [options.fallbackIssue]  the record-level flag, for scans
 *   stored before per-engine slices existed. Only consulted when the slices
 *   cannot answer.
 */
export function describeScanDataSourceIssue(engineSummaries, options = {}) {
  const fallbackIssue = !!options.fallbackIssue;
  const suppliedCount = Number(options.enginesCounted);
  const hasSuppliedCount = Number.isFinite(suppliedCount);

  const slices = (
    Array.isArray(engineSummaries)
      ? engineSummaries.map((slice) => [slice && slice.engine, slice])
      : Object.entries(engineSummaries || {})
  )
    .filter(([, slice]) => slice && typeof slice === "object")
    .map(([key, slice]) => ({ ...slice, engine: slice.engine || key }));

  // A slice with no non-branded denominator never ran. It is not a degraded
  // read and it is not a counted engine either — it is absent, and
  // insufficient_sample is the flag that speaks for it.
  const ran = slices.filter((slice) => Number(slice.non_branded_queries) > 0);

  const legacy = () => ({
    dataSourceIssue: fallbackIssue,
    severity: fallbackIssue ? "critical" : "none",
    degradedEngines: [],
    countedEngines: [],
    enginesCounted: hasSuppliedCount ? suppliedCount : 0,
    enginesRan: ran.length,
    title: fallbackIssue ? "Data source issue — scan incomplete" : null,
    detail: fallbackIssue
      ? "The engines returned no answer for the majority of tracked queries, or the SERP API errored out too often. We are not showing a score rather than misleading you with a false 0%."
      : null,
  });

  if (ran.length === 0) return legacy();

  const degraded = ran.filter((slice) => slice.data_source_issue).map(describeDegradedSlice);
  if (degraded.length === 0) return legacy();

  const counted = ran.filter(
    (slice) =>
      !slice.data_source_issue &&
      Number(slice.non_branded_with_answer) >= HEADLINE_MIN_NON_BRANDED_ANSWERS
  );
  const enginesCounted = counted.length;
  const countedEngines = counted.map((slice) => ({
    engine: slice.engine,
    label: engineDisplayLabel(slice.engine),
  }));

  const severity = enginesCounted > 0 ? "partial" : "critical";
  const degradedNames = formatEngineList(degraded.map((d) => d.label));
  const reasons = degraded.map((d) => `${d.label} ${d.reason}.`).join(" ");

  const title =
    severity === "partial"
      ? `${degradedNames} degraded — the index counts ${enginesCounted} of ${ran.length} engines`
      : `${degradedNames} degraded — no engine left to score`;

  const detail =
    severity === "partial"
      ? `${reasons} A slice that incomplete cannot be trusted, so it is left out of the AI Visibility Index above` +
        (countedEngines.length > 0
          ? ` — the score is ${formatEngineList(countedEngines.map((e) => e.label))} only, `
          : " — the score is blended from ") +
        `${enginesCounted} of the ${ran.length} engines this scan probed. Re-run the scan to bring ${degradedNames} back.`
      : `${reasons} No engine produced a slice complete enough to score, so we are showing no score rather than misleading you with a false 0%.`;

  return {
    dataSourceIssue: true,
    severity,
    degradedEngines: degraded,
    countedEngines,
    enginesCounted,
    enginesRan: ran.length,
    title,
    detail,
  };
}

/** The engine name as prose. Falls back to the raw key rather than inventing one. */
function engineDisplayLabel(name) {
  return ENGINE_LABELS[name] || String(name || "unknown engine");
}

/**
 * Restates one degraded slice in the numbers that condemned it, read from the
 * same engineHealthThresholds the gate used so the banner cannot quote an aio
 * threshold at a text engine.
 *
 * If neither gate reconstructs — a slice flagged by a version of the gate this
 * function does not know, or a stored slice missing its counters — it says so
 * instead of printing an empty reason. A banner with no reason is the thing
 * this task exists to replace.
 */
function describeDegradedSlice(slice) {
  const gates = engineHealthThresholds(slice.engine);
  const minCoveragePct = Math.round(gates.minNonBrandedCoverage * 1000) / 10;
  const nonBranded = Number(slice.non_branded_queries);
  const answered = Number(slice.non_branded_with_answer);
  const errorRatePct = Number(slice.error_rate_pct);

  const reasons = [];
  if (
    Number.isFinite(nonBranded) &&
    nonBranded > 0 &&
    Number.isFinite(answered) &&
    answered / nonBranded < gates.minNonBrandedCoverage
  ) {
    const coveragePct = Math.round((answered / nonBranded) * 1000) / 10;
    reasons.push(
      `answered ${answered} of ${nonBranded} tracked prompts (${coveragePct}%), under the ${minCoveragePct}% this engine needs`
    );
  }
  if (Number.isFinite(errorRatePct) && errorRatePct > gates.errorRateLimitPct) {
    reasons.push(`errored on ${errorRatePct}% of its prompts, over its ${gates.errorRateLimitPct}% limit`);
  }

  return {
    engine: slice.engine,
    label: engineDisplayLabel(slice.engine),
    reason:
      reasons.length > 0
        ? reasons.join(" and ")
        : "was flagged as a degraded read, but this record does not carry the coverage and error numbers that would explain why",
    coverage_pct: Number.isFinite(slice.coverage_pct) ? slice.coverage_pct : null,
    error_rate_pct: Number.isFinite(errorRatePct) ? errorRatePct : null,
    min_coverage_pct: minCoveragePct,
    error_rate_limit_pct: gates.errorRateLimitPct,
  };
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

/**
 * The ways `ENGINES` can ask for an engine and not get one (R3.2.2).
 *
 * These are the reasons `resolveEnabledEngines` used to compute, log to the
 * console and then discard: it pushed them onto a local `skipped` array that no
 * caller ever read. A scan that was asked for three engines and probed one
 * finalized as 'succeeded' with a headline blended over the survivors, and the
 * only trace was a console line nobody joins to a scan.
 *
 * They stay TWO reasons rather than one on purpose. `engine_unknown` is a typo
 * in `ENGINES` (or an engine that was deleted from the registry); the operator
 * fixes it by editing the variable. `engine_not_configured` is a real engine
 * whose API key is missing; the operator fixes it by setting the key. Collapsing
 * them into "engine dropped" loses exactly the part that says what to do.
 *
 * The strings are canonical here, at the layer that discovers the drop, and are
 * re-exported through scanWorker's CHUNK_SKIP_REASONS so `detail.skips` and this
 * vocabulary can never drift apart.
 */
export const ENGINE_RESOLUTION_SKIPS = Object.freeze({
  /** `ENGINES` named something that is not in the registry at all. */
  UNKNOWN: "engine_unknown",
  /** A real engine whose `isConfigured()` says its key is missing. */
  NOT_CONFIGURED: "engine_not_configured",
  /** EVERY requested engine was dropped, so the whole set became the aio default. */
  SET_DEFAULTED: "engine_set_defaulted",
});

/**
 * Which engines this process will actually probe, and what it refused to.
 *
 * @param {object} [options]
 * @param {(kind: string, subject: string) => void} [options.onSkip]
 *   Called once per discarded engine, with a value from ENGINE_RESOLUTION_SKIPS
 *   and the engine name (or, for SET_DEFAULTED, the whole requested set). This
 *   is how the skip set escapes the function instead of dying in a local array;
 *   the return value stays a plain engine array so every existing caller is
 *   unaffected. A caller that passes no recorder gets the old behaviour — the
 *   console warnings — which is deliberate: only the chunk worker has a ledger
 *   row to hang these on.
 */
export function resolveEnabledEngines(options = {}) {
  const onSkip = typeof options.onSkip === "function" ? options.onSkip : null;
  const envVal = (process.env.ENGINES || "aio").trim();
  const requested = envVal.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);

  const enabled = [];

  for (const name of requested) {
    const def = ENGINE_REGISTRY.find((e) => e.name === name);
    if (!def) {
      console.warn(`[engine-pipeline] Unknown engine "${name}" — skipping`);
      if (onSkip) onSkip(ENGINE_RESOLUTION_SKIPS.UNKNOWN, name);
      continue;
    }
    if (!def.isConfigured()) {
      console.warn(`[engine-pipeline] Engine "${name}" not configured (missing API key) — skipping`);
      if (onSkip) onSkip(ENGINE_RESOLUTION_SKIPS.NOT_CONFIGURED, name);
      continue;
    }
    enabled.push(def);
  }

  if (enabled.length === 0) {
    // Substituting a DIFFERENT engine set than the one that was asked for. The
    // scan still runs, so nothing downstream fails — which is precisely why this
    // needs a reason of its own rather than a bare warning. It is the same class
    // as the checkpoint-level ENGINE_SET_FALLBACK, one layer earlier.
    console.warn("[engine-pipeline] No engines enabled! Defaulting to aio.");
    if (onSkip) onSkip(ENGINE_RESOLUTION_SKIPS.SET_DEFAULTED, requested.join(",") || "(empty ENGINES)");
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

  const scanHealth = describeScanDataSourceIssue(engines, {
    enginesCounted: headline ? headline.engines_counted : null,
  });

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
      // R2.2.6: the scan-level flag is every engine's business, not aio's.
      // Reading it off aioSummary alone let a text-only degradation drop the
      // headline from two engines to one with no banner to explain it.
      data_source_issue: scanHealth.dataSourceIssue,
      insufficient_sample: aioSummary.insufficient_sample || false,
      thresholds: {
        error_rate_limit_pct: AIO_ERROR_RATE_LIMIT_PCT,
        min_non_branded_coverage: AIO_MIN_NON_BRANDED_COVERAGE,
        min_non_branded_with_aio: AIO_MIN_NON_BRANDED_WITH_AIO,
      },
    },
    engines,
    headline,
    // The words behind summary.data_source_issue. Recomputable from `engines`
    // by any reader (the dashboard does exactly that for scans stored before
    // this landed), so nothing downstream is required to persist it.
    data_source_status: scanHealth,
  };
}
