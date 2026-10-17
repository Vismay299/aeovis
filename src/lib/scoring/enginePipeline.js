import { brightDataSearch, extractBrightDataAiOverview, extractBrightDataOrganic } from "../engines/brightdata.js";
import { resolveSerpQueryCost } from "../llmPricing.js";
import { probeChatGpt, isChatGptConfigured } from "../engines/openai.js";
import { probePerplexity, isPerplexityConfigured, hasUnverifiedCitations } from "../engines/perplexity.js";
import { probeOpenRouterEngine, isOpenRouterEngineConfigured } from "../engines/openRouterProbe.js";
import { getBrandAliases } from "./aliases.js";
import { isBrandedQuery, resolveQueryIntentTier } from "./aioQueryClassify.js";
import { detectMention, judgeBrandsSymmetric } from "./judge.js";
import { countBrandsElicited } from "./promptQuality.js";
import { extractBrandDomain } from "./citations.js";
import { measuredNumberOrNull, ratioPctOrNull } from "./measuredNumber.js";
import {
  ELIGIBILITY_POLICY_V1,
  METRIC_CONTRACT_VERSION,
  METRIC_IDS,
  METRIC_REASONS,
  METRIC_UNITS,
  compareMetrics,
  createMetric,
  logicalObservationKey,
  measurementContext,
  reduceObservations,
} from "./metricContract.js";
import {
  AIO_CONCURRENCY,
  AIO_ERROR_RATE_LIMIT_PCT,
  AIO_MIN_NON_BRANDED_COVERAGE,
  AIO_MIN_NON_BRANDED_WITH_AIO,
} from "./aioConstants.js";
import { ENGINE_LABELS, formatEngineList } from "../engines/deployedEngines.js";
import { createObservationEnvelope, SEARCH_STATE } from "../provenance.js";

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
async function probeAio(query, brand, brandAliases, brandDomain, competitors, stats, options = {}) {
  const result = {
    engine: "aio",
    measurement_method: "google_serp",
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

  // R3.6.4 — the per-query Bright Data price comes from the price table in
  // src/lib/llmPricing.js, not from a literal restated here (it was one of
  // three copies, alongside aioPipeline.js and serp.js).
  //
  // Resolved OUTSIDE the try for the same reason as aioPipeline's: the catch
  // below turns a throw into an error row with `cost` left at 0, so a pricing
  // refusal raised inside it would read as a query that failed for free.
  const { cost: queryCost } = resolveSerpQueryCost({ provider: "brightdata" });

  try {
    const data = await brightDataSearch(query.text, { timeout: 60000, aiOverview: true, geo: options.geo });
    const {
      text,
      citations,
      references,
      per_field_quality,
      citations_verified_empty,
      parser_version,
      evidence_id,
      serp_state,
    } = extractBrightDataAiOverview(data);
    const organic = extractBrightDataOrganic(data);

    // R04.5a — the validated parse result travels with EVERY observation, not only
    // the ones that carried text or citations. A valid no-AIO row has neither, and
    // that is exactly the row which has to prove it was measured: without the SERP
    // state, the parser version and the captured evidence id, storage cannot tell
    // "there was no Overview" from "we never read one" — A01 at the data layer, and
    // it made the no-AIO rows the least auditable rows in the scan. Absent values
    // are left off rather than defaulted: the raw-payload branch never went through
    // the parser, so it has no quality or evidence to report and a default here
    // would invent one.
    if (serp_state !== undefined) result.serp_state = serp_state;
    if (per_field_quality !== undefined) result.per_field_quality = per_field_quality;
    if (citations_verified_empty !== undefined) result.citations_verified_empty = citations_verified_empty;
    if (parser_version !== undefined) result.parser_version = parser_version;
    if (evidence_id !== undefined) result.evidence_id = evidence_id;
    result.organic = organic;
    if (brandDomain && organic.length > 0) {
      const brandPos = organic.findIndex(
        (o) => o.domain === brandDomain || o.domain.endsWith("." + brandDomain)
      );
      result.brand_organic_position = brandPos >= 0 ? brandPos + 1 : null;
    }
    result.cost = queryCost;
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
export async function probeTextEngine(engine, query, brand, brandAliases, brandDomain, competitors, stats) {
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
    cost: null,
    cost_state: null,
    cost_source: null,
    cost_state_detail: null,
    // R2.2.2 — whether `citations` above is a MEASUREMENT or the absence of
    // one. Distinct from `error`, which speaks only for the ANSWER. A multi-leg
    // engine (Perplexity: /chat/completions for the answer, /search for the
    // citations) can lose one leg and keep the other, and `citations: []` then
    // means "we could not look", not "we looked and found none".
    //
    // null means this engine has no separate citation leg to lose — a ChatGPT
    // row's citations come back on the same call as its answer, so `error`
    // already speaks for both. The real values are copied off the probe below.
    // See CITATIONS_STATE in src/lib/engines/perplexity.js.
    citations_state: null,
    citations_state_reason: null,
    citations_state_detail: null,
  };

  const probeResult = await probeFn(query.text, { stats });
  result.measurement_method = "model_api";
  result.model_used = probeResult.model || probeResult.model_used || null;
  result.requested_model = probeResult.requested_model || probeResult.model || null;
  result.returned_model = probeResult.returned_model || probeResult.model || null;
  result.provider_request_id = probeResult.provider_request_id || null;
  result.search_requests = probeResult.search_requests !== undefined ? probeResult.search_requests : null;
  result.search_used =
    probeResult.search_requests > 0
      ? SEARCH_STATE.OBSERVED_USED
      : (probeResult.search_requests === 0 ? SEARCH_STATE.OBSERVED_NOT_USED : SEARCH_STATE.UNKNOWN);
  result.provenance = createObservationEnvelope({
    surface: engineName,
    gateway: "openrouter",
    method: "model_api",
    requested_model: result.requested_model,
    returned_model: result.returned_model,
    provider_request_id: result.provider_request_id,
    search_requests: result.search_requests,
    cost: probeResult.cost,
    cost_source: probeResult.cost_source,
    cost_state: probeResult.cost_state,
    cost_state_detail: probeResult.cost_state_detail,
  });

  // Copied ONCE, here, before the first return can skip it.
  //
  // The first cut of R2.2.2 was rejected because this function copies fields
  // onto a fixed literal — text/citations/references/cost and nothing else — so
  // probePerplexity setting citations_state on every one of ITS return paths
  // bought nothing: all three fields died on this hop, and a search-leg outage
  // still reached the citation-share denominator as a confirmed "not cited".
  // probePerplexity has exactly one consumer and it is this function.
  //
  // The copy is deliberately BEFORE the branch rather than repeated in each of
  // the three returns below (probe error, EMPTY_ANSWER, success): a fourth
  // return path added later cannot reintroduce the drop by forgetting a line.
  // The error path matters as much as the success one — both legs dead is also
  // an unobserved citation list, not an empty one.
  result.citations_state = probeResult.citations_state ?? null;
  result.citations_state_reason = probeResult.citations_state_reason ?? null;
  result.citations_state_detail = probeResult.citations_state_detail ?? null;

  // R2.2.9 — the citation LIST is copied here for the same reason its STATE is.
  //
  // Carrying `citations_state: "verified"` past the error branch while leaving
  // `citations: []` behind is the worst of the three outcomes: the row claims
  // the citation leg was observed AND that it found nothing, so the citation
  // denominator counts it as a confirmed "the brand was not cited here". On
  // Perplexity the two legs are two calls — a 500 on /chat/completions says
  // nothing about the /search results already in hand.
  //
  // The derived flags come with it. brand_cited/competitors_cited are functions
  // of `references` alone, so deriving them anywhere else would mean shipping
  // measured references next to flags that pretend they were never read.
  // `visible` is recomputed once below, after the answer text is scanned for
  // mentions — the text half of that OR does not exist on this path.
  // R2.9.6 — preserve null cost and propagate cost_state / cost_source / cost_state_detail.
  // Copied once above the error branch, so that unpriced, failed, or unmeasured probes
  // never fabricate a $0 measurement.
  result.cost = probeResult.cost !== undefined ? probeResult.cost : null;
  result.cost_state = probeResult.cost_state ?? null;
  result.cost_source = probeResult.cost_source ?? null;
  result.cost_state_detail = probeResult.cost_state_detail ?? null;
  result.citations = probeResult.citations || [];
  result.references = (probeResult.references || []).map((r) => ({
    href: r.href,
    title: r.title || "",
    source: r.source || "",
    domain: extractBrandDomain(r.href),
  }));

  if (brandDomain) {
    result.brand_cited = result.references.some(
      (ref) => domainMatches(ref.domain || extractBrandDomain(ref.href), brandDomain)
    );
  }
  result.competitors_cited = findCompetitorsCited(result.references, competitors);
  result.visible = result.brand_mentioned_in_text || result.brand_cited;

  if (probeResult.error) {
    result.error = probeResult.error;
    console.warn(`[${engineName}] Query failed: "${query.text}" — ${probeResult.error}`);
    return result;
  }

  result.text = probeResult.text || "";

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

  // brand_cited and competitors_cited were derived above, off these same
  // references, before the error branch — not repeated here. Only `visible`
  // needs the second pass: its other half, brand_mentioned_in_text, is not
  // known until the answer text exists and has been scanned.
  result.visible = result.brand_mentioned_in_text || result.brand_cited;

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
 * What a per-engine slice's score actually IS (R2.1.1, findings A1/S1).
 *
 * `share_of_ai_pct` used to be a number on every path: an engine that errored
 * on every probe, an engine whose answers named no vendor at all, and an engine
 * that was measured and genuinely never named the brand all reported 0. Three
 * different facts, one indistinguishable number, and the dashboard drew the
 * same 0% bar for all of them. Standing rule 1: a measured zero must look
 * different from never-ran.
 *
 * So the number is now null in every state that is not a measurement, and this
 * enum is what says which state that was. Four, not two, because the operator
 * action differs in each case: re-run (failed), fix the prompt set
 * (not_assessed), or do the actual GEO work (measured_zero).
 *
 *   measured      — a real number over a real eliciting pool. `share_of_ai_pct`
 *                   is a number > 0.
 *   measured_zero — a real number, and it is 0. The pool existed, the answers
 *                   named vendors, none of them was us. `share_of_ai_pct` is 0.
 *   not_assessed  — nothing to measure: no rows, no non-branded prompts, or no
 *                   answer that named ANY vendor. There is no number.
 *                   `share_of_ai_pct` is null. (A slice that answered NOTHING
 *                   is `failed`, not this — see ENGINE_STATE_REASONS.)
 *   failed        — the slice ran and is not trustworthy (the same condition as
 *                   `data_source_issue`). Whatever ratio the surviving rows
 *                   imply is a measurement of a broken read, so it is not
 *                   reported. `share_of_ai_pct` is null.
 *
 * The strings `measured` / `not_assessed` are deliberately the same tokens
 * SHARE_STATE already uses in src/components/perceev/charts/shareOfVoice.js, so
 * a surface that renders one state chip vocabulary does not need two.
 */
export const ENGINE_MEASUREMENT_STATE = Object.freeze({
  MEASURED: "measured",
  MEASURED_ZERO: "measured_zero",
  NOT_ASSESSED: "not_assessed",
  FAILED: "failed",
});

/**
 * WHY a slice is in the state it is in. Machine tokens, one per distinguishable
 * cause, in the shape SCRAPE_REASON established: `state` says whether there is
 * a number, `state_reason` says what to do about it.
 *
 * `measured` carries a null reason — nothing needs explaining. Every other
 * state carries exactly one of these, never null.
 */
export const ENGINE_STATE_REASONS = Object.freeze({
  /** No rows at all for this engine. It never ran. */
  NO_RESULTS: "no_results",
  /** Rows exist, but every one is a branded seed — nothing scoreable was probed. */
  NO_NON_BRANDED_PROMPTS: "no_non_branded_prompts",
  //
  // There is deliberately NO "no_answers" reason. A slice with non-branded
  // prompts and zero answers has coverage 0, which is below every engine
  // class's minNonBrandedCoverage (0.15 aio / 0.9 text), so it is already
  // `failed` / `low_coverage` — the truthier reading, because an engine that
  // answered nothing broke rather than merely measured nothing. A reason no
  // input can reach is a lie about the state space; the test file asserts that
  // case lands on low_coverage so this stays true if a gate ever moves.
  //
  /**
   * Answers came back and NONE of them named a single roster vendor, so the
   * denominator is empty. This is a property of the prompt set, not the brand:
   * scoring 0 here would blame a brand for questions that could never mention
   * anybody. See the eliciting-pool comment above.
   */
  EMPTY_ELICITING_POOL: "empty_eliciting_pool",
  /** `data_source_issue`, error-rate arm: the engine errored past its gate. */
  HIGH_ERROR_RATE: "high_error_rate",
  /** `data_source_issue`, coverage arm: too few non-branded prompts answered. */
  LOW_COVERAGE: "low_coverage",
  /** measured_zero: the pool named vendors on every count, and never us. */
  BRAND_NOT_VISIBLE: "brand_not_visible",
});

/** The two states in which `share_of_ai_pct` is a number rather than null. */
const MEASURED_STATES = new Set([
  ENGINE_MEASUREMENT_STATE.MEASURED,
  ENGINE_MEASUREMENT_STATE.MEASURED_ZERO,
]);

/** All four, for telling "a state I do not know" from "a state that is absent". */
const KNOWN_MEASUREMENT_STATES = new Set(Object.values(ENGINE_MEASUREMENT_STATE));

/**
 * True when a per-engine summary carries a real measurement — i.e. its
 * `share_of_ai_pct` may be read as a number. Exported so a consumer asks this
 * question once rather than each re-deriving "is 0 real here".
 *
 * Slices written before R2.1.1 carry no `state` at all. They are treated as
 * measured when the number is finite, which is what they meant: the pre-R2.1.1
 * writer had no way to say anything else.
 */
export function isMeasuredEngineSlice(summary) {
  if (!summary || typeof summary !== "object") return false;
  if (summary.state == null) return Number.isFinite(summary.share_of_ai_pct);
  return MEASURED_STATES.has(summary.state) && Number.isFinite(summary.share_of_ai_pct);
}

/**
 * R2.1.1 (round 2) — THE READ SIDE OF THE NULL.
 *
 * Emitting null was half the job. The two surfaces that render a stored scan's
 * score read the raw column and printed it: Sidebar.jsx printed
 * `{scan.visibility_pct}%`, which with a null renders a bare "%" with nothing
 * in front of it, and DashboardShell's history cards printed
 * `{s.visibility_pct}<small>%</small>` and subtracted one from another. `null -
 * 40` is `-40`, not NaN, so that arithmetic produced a WRONG delta silently
 * rather than an obviously broken one — the worst failure mode available.
 *
 * One reader, used by both, so the two surfaces cannot drift and neither has to
 * re-derive "is this 0 real". The rules are the same ones isMeasuredEngineSlice
 * applies, restated for a stored scan row rather than a live slice:
 *
 *   - the number comes from the row's own column and nowhere else. No fallback
 *     to another field: a score reconstructed from a different source is a
 *     different measurement wearing this one's name.
 *   - a state that is NOT a measured state wins over any number sitting beside
 *     it. If the row says not_assessed, a leftover 0 is not promoted to a fact.
 *   - a row with NO state at all and a finite number is measured. That is the
 *     legacy tolerance: every scan written before R2.1.1 carries a number and no
 *     state, and blanking those would erase real history to fix a new bug.
 *   - a measured 0 is a measurement (standing rule 1) and renders as "0%", with
 *     a chip that says it was measured so it cannot be read as "unknown".
 *   - a 0 with NO state renders as "0%" too (same legacy tolerance) but under a
 *     DIFFERENT chip and sentence: the row recorded no measurement, so the
 *     surface may not say one happened. See ENGINE_UNSTATED_ZERO_LABEL.
 */

/** Where the state lives on a stored row, in the order a reader should try. */
function readScanStateFields(row) {
  const stats = row?.summary_stats || row?.raw_results?.summary_stats || null;
  return {
    // `row.state` first so a caller may pass a summary/slice object directly;
    // the `scans` TABLE has no `state` column (supabase/migrations/001), so on a
    // real row this is always undefined and `summary_stats` is what answers.
    state: row?.state ?? stats?.state ?? null,
    reason: row?.state_reason ?? stats?.state_reason ?? null,
  };
}

/**
 * Reasons a READER can find on a stored row that no slice can ever emit. Kept
 * out of ENGINE_STATE_REASONS deliberately: that enum is the producer's, and
 * engineMeasurementState.test.mjs asserts every token in it is reachable from
 * summarizeEngineSlice. These three are unreachable there by construction.
 */
export const ENGINE_READ_REASONS = Object.freeze({
  /** No number and no state: a row that never recorded why it has no score. */
  NOT_RECORDED: "state_not_recorded",
  /** A `state` token this build does not know. Named, never swallowed. */
  UNRECOGNISED_STATE: "unrecognised_state",
  /** The row claims a measurement and stored no number. A contradiction, shown. */
  MEASURED_WITHOUT_NUMBER: "measured_state_without_number",
  /**
   * R2.1.5 — a 0 with NO state beside it. The number stands (see the legacy
   * tolerance above), but nothing on the row says the 0 was measured, so
   * nothing may be said on its behalf.
   */
  LEGACY_ZERO_UNSTATED: "legacy_zero_unstated",
});

/** One human sentence per reason. Every token above and in ENGINE_STATE_REASONS. */
export const ENGINE_STATE_REASON_DETAIL = Object.freeze({
  [ENGINE_STATE_REASONS.NO_RESULTS]:
    "This engine returned no rows for the scan, so there was nothing to score.",
  [ENGINE_STATE_REASONS.NO_NON_BRANDED_PROMPTS]:
    "Only branded prompts were probed, so no scoreable question was asked.",
  [ENGINE_STATE_REASONS.EMPTY_ELICITING_POOL]:
    "The answers came back and none of them named any vendor, so there was no share to take. This is not a 0% score.",
  [ENGINE_STATE_REASONS.HIGH_ERROR_RATE]:
    "The engine errored on too many prompts for this reading to be trusted.",
  [ENGINE_STATE_REASONS.LOW_COVERAGE]:
    "Too few of the tracked prompts came back answered for this reading to be trusted.",
  [ENGINE_STATE_REASONS.BRAND_NOT_VISIBLE]:
    "Measured: the answers named vendors on every count, and never this brand.",
  [ENGINE_READ_REASONS.NOT_RECORDED]:
    "This reading carries no score, and the scan did not record why.",
  [ENGINE_READ_REASONS.UNRECOGNISED_STATE]:
    "This reading carries a measurement state this build does not recognise.",
  [ENGINE_READ_REASONS.MEASURED_WITHOUT_NUMBER]:
    "This reading says it was measured but stored no number.",
  [ENGINE_READ_REASONS.LEGACY_ZERO_UNSTATED]:
    "This reading stored 0 and no measurement state. The 0 is shown as recorded, " +
    "but nothing on the row says it was measured, so this build cannot tell a real " +
    "zero from one the older pipeline wrote when it had nothing to measure.",
});

export const ENGINE_NOT_MEASURED_LABEL = "Not measured";
export const ENGINE_MEASURED_ZERO_LABEL = "Measured zero";
/**
 * R2.1.5 — the chip for a 0 that carries no state. NOT "Measured zero": a
 * stateless row recorded no measurement fact, and the pre-R2.1.1 pipeline this
 * rebuild is fixing wrote exactly this shape (a bare 0, no state) for a dead
 * engine, an empty eliciting pool and a failed probe alike. Labelling those
 * "Measured zero" states the rebuild's central bug to the user as a finding.
 *
 * KNOWN GAP, stated rather than hidden: this chip is decided by the PRESENCE of
 * `state` on the row, which is the only fact a stored row carries about its own
 * provenance. summarizeEngineResults publishes that pair (:1600) so every
 * multi-engine scan is covered, but scanWorker's single-engine branch summarises
 * through summarizeAioResults (src/lib/scoring/aioPipeline.js:199), which emits
 * no state at all — so on a deployment with exactly one engine enabled, a
 * genuine measured zero written TODAY is stateless and wears this chip. That
 * reads as "this build cannot tell", which is true of such a row, but the fix is
 * for aioPipeline to state its measurement; filed rather than done here, because
 * it is a write-side change outside this task.
 */
export const ENGINE_UNSTATED_ZERO_LABEL = "Unstated zero";
/** What a surface prints where a number would be. Standing rule 5. */
export const NO_MEASUREMENT_TEXT = "—";

/**
 * Read one metric off a stored scan row (or a summary object) and say what it
 * IS: a number, a measured zero, or an absence with a reason.
 *
 * @param {object|null} row  a `scans` row, an enriched row, or a summary object
 * @param {string} key       the metric column, e.g. "visibility_pct"
 * @returns {{
 *   measured: boolean, measuredZero: boolean, pct: number|null, text: string,
 *   state: string|null, reason: string|null, label: string|null,
 *   detail: string|null
 * }}
 */
export function describeScanMeasurement(row, { key = "visibility_pct" } = {}) {
  const raw = row && typeof row === "object" ? row[key] : undefined;
  const pct = Number.isFinite(raw) ? raw : null;
  const { state, reason } = readScanStateFields(row);

  const unmeasured = (r) => ({
    measured: false,
    measuredZero: false,
    pct: null,
    text: NO_MEASUREMENT_TEXT,
    state: state ?? null,
    reason: r,
    label: ENGINE_NOT_MEASURED_LABEL,
    detail: ENGINE_STATE_REASON_DETAIL[r] || ENGINE_STATE_REASON_DETAIL[ENGINE_READ_REASONS.NOT_RECORDED],
  });

  if (state != null && !KNOWN_MEASUREMENT_STATES.has(state)) {
    // Named, not swallowed: the token itself rides in `reason` so an operator
    // can grep for it rather than seeing a generic dash.
    const view = unmeasured(ENGINE_READ_REASONS.UNRECOGNISED_STATE);
    view.detail = `${view.detail} (${String(state)})`;
    return view;
  }
  if (state != null && !MEASURED_STATES.has(state)) {
    return unmeasured(reason || ENGINE_READ_REASONS.NOT_RECORDED);
  }
  if (pct === null) {
    // Either a measured state with no number (a contradiction) or the legacy
    // stateless row with nothing in the column. Different reasons, both absent.
    return unmeasured(
      state != null ? ENGINE_READ_REASONS.MEASURED_WITHOUT_NUMBER : ENGINE_READ_REASONS.NOT_RECORDED
    );
  }

  const measuredZero = pct === 0;
  // R2.1.5 — a 0 with a measured state behind it and a 0 with no state at all
  // are DIFFERENT FACTS and must not share a chip. The state-backed one knows
  // what the answers contained ("vendors on every count, and never this
  // brand"); the stateless legacy one knows only that a 0 was written. Saying
  // the first sentence over the second asserts a measurement nobody recorded —
  // and the pre-R2.1.1 pipeline wrote a bare stateless 0 for a dead engine and
  // an empty eliciting pool too. The NUMBER is unchanged either way: the legacy
  // tolerance was ruled correct and blanking history would erase real readings.
  const zeroIsUnstated = measuredZero && state == null;
  const zeroReason = zeroIsUnstated
    ? ENGINE_READ_REASONS.LEGACY_ZERO_UNSTATED
    : reason || ENGINE_STATE_REASONS.BRAND_NOT_VISIBLE;
  return {
    measured: true,
    measuredZero,
    pct,
    text: `${pct}%`,
    state: state ?? null,
    reason: measuredZero ? zeroReason : null,
    // A real number needs no chip; a zero needs one, or it reads exactly like
    // the absence it must not be confused with — and the chip and the sentence
    // come from the same reason token so the two cannot disagree.
    label: measuredZero
      ? zeroIsUnstated
        ? ENGINE_UNSTATED_ZERO_LABEL
        : ENGINE_MEASURED_ZERO_LABEL
      : null,
    detail: measuredZero
      ? ENGINE_STATE_REASON_DETAIL[zeroReason] ||
        // A state-backed measured_zero carrying a reason token this build does
        // not know still gets words: the STATE said measured_zero, so that
        // sentence is the one the row supports. Never an empty title.
        ENGINE_STATE_REASON_DETAIL[ENGINE_STATE_REASONS.BRAND_NOT_VISIBLE]
      : null,
  };
}

/**
 * Which of the four states this slice is in, and why.
 *
 * ORDER MATTERS and it is not arbitrary. `failed` is tested first: a slice that
 * errored past its gate may ALSO have an empty eliciting pool, and "the engine
 * broke" is the cause the operator acts on — reporting it as "your prompts
 * elicited nothing" would send them to rewrite a prompt set that was fine. The
 * not_assessed reasons then run outermost-first (no rows, no prompts, no
 * vendors named), so the reason names the FIRST thing that was missing rather
 * than the last.
 */
function resolveEngineMeasurementState({
  total,
  nonBrandedCount,
  elicitingCount,
  visibleNonBranded,
  dataSourceIssue,
  errorRatePct,
  gates,
}) {
  const { MEASURED, MEASURED_ZERO, NOT_ASSESSED, FAILED } = ENGINE_MEASUREMENT_STATE;

  if (dataSourceIssue) {
    return {
      state: FAILED,
      state_reason:
        // R2.9.7 — `errorRatePct` is null when the slice ran no queries at all.
        // Such a slice cannot be flagged by the error gate (the caller's
        // `dataSourceIssue` requires a non-null rate), so it can only have got
        // here on coverage; naming the null branch keeps that explicit.
        errorRatePct !== null && errorRatePct > gates.errorRateLimitPct
          ? ENGINE_STATE_REASONS.HIGH_ERROR_RATE
          : ENGINE_STATE_REASONS.LOW_COVERAGE,
    };
  }
  if (total === 0) {
    return { state: NOT_ASSESSED, state_reason: ENGINE_STATE_REASONS.NO_RESULTS };
  }
  if (nonBrandedCount === 0) {
    return { state: NOT_ASSESSED, state_reason: ENGINE_STATE_REASONS.NO_NON_BRANDED_PROMPTS };
  }
  if (elicitingCount === 0) {
    return { state: NOT_ASSESSED, state_reason: ENGINE_STATE_REASONS.EMPTY_ELICITING_POOL };
  }
  if (visibleNonBranded === 0) {
    return { state: MEASURED_ZERO, state_reason: ENGINE_STATE_REASONS.BRAND_NOT_VISIBLE };
  }
  return { state: MEASURED, state_reason: null };
}

// ---------------------------------------------------------------------------
// R05 — the metric contract, applied to a probe row
//
// Everything below turns probe rows into metric DTOs from ./metricContract.js.
// The rules (what a denominator is, when a value may be headlined, when two
// values are comparable) live in that module; what lives here is only the part
// that knows what a probe row looks like.
//
// THE ONE THING TO KEEP IN MIND WHILE READING THIS: a row's `visible` flag is
// "named OR cited", `brand_mentioned_in_text` is the text half alone, and
// `brand_cited` is the citation half alone. Those three are three DIFFERENT
// metrics with three different denominators, and collapsing them is how A03 lost
// a citation-only appearance (it was dropped by a filter that only knew about
// text) and how A04 let a roster change move a self rate (the filter's
// denominator was the roster's business). The denominators here are the declared
// eligible panel for the self metrics and the observed-citation pool for the
// citation metric — never "answers that happened to name a tracked rival".
// ---------------------------------------------------------------------------

/** The prompt ID a row belongs to. Distinct prompt IDs are what the sample gate counts. */
function promptIdentityOf(row) {
  const id = row?.prompt_id ?? row?.promptId ?? row?.query ?? row?.prompt;
  return id === null || id === undefined ? null : String(id);
}

/**
 * The replicate index of a row. Absent means "the one and only observation of
 * this prompt", which is replicate 1 — not a replicate, and therefore eligible to
 * count toward the distinct-prompt minimum.
 */
function replicateIndexOf(row) {
  return measuredNumberOrNull(row?.replicate) ?? 1;
}

/** The logical observation a row is a delivery OF (v1 policy: attempts are children). */
function observationKeyOf(row) {
  return logicalObservationKey({
    promptId: promptIdentityOf(row),
    surface: row?.engine ?? null,
    market: row?.market ?? row?.geo ?? null,
    language: row?.language ?? null,
    replicate: replicateIndexOf(row),
    scheduledTime: row?.scheduled_time ?? row?.scheduledTime ?? null,
    purpose: row?.scoring_purpose ?? "scoring",
  });
}

/**
 * Did this answer carry text at all? A citation-only AIO (references and no
 * overview text) cannot be counted as a NON-mention: nobody read a sentence that
 * failed to name the brand. Such a row is excluded from the mention metric with
 * its reason, rather than counted as absence (R04-06's partial capture).
 */
function hasObservedAnswerText(row) {
  return typeof row?.text === "string" && row.text.trim() !== "";
}

/**
 * The self brand's recommendation reading for one answer, from the label it
 * carries. An explicit relationship label (R08's vocabulary) is preferred over
 * the numeric sentiment, and a numeric sentiment of 50 (neutral) is NOT a
 * positive recommendation — "mentioned" and "recommended" are different
 * measurements, which is the whole point of counting them apart.
 *
 * An unmentioned brand is an observed non-recommendation (`observed: true`,
 * `positive: false`): the answer was read and did not recommend it. A row with no
 * self entry at all is NOT observed, because no judgment ran on it.
 */
const RECOMMENDED_LABELS = new Set(["recommended", "positive", "top_pick", "recommends"]);
const POSITIVE_SENTIMENT_FLOOR = 50;

function selfRecommendationOf(row) {
  const self = (row?.brands || []).find((b) => b && (b.is_self ?? b.isSelf));
  if (!self) return { observed: false, positive: false };

  const explicit = self.relationship ?? self.recommendation ?? null;
  if (explicit !== null && explicit !== undefined && String(explicit).trim() !== "") {
    return { observed: true, positive: RECOMMENDED_LABELS.has(String(explicit).trim().toLowerCase()) };
  }

  const sentiment = measuredNumberOrNull(self.sentiment);
  if (sentiment === null) return { observed: true, positive: false };
  return { observed: true, positive: sentiment > POSITIVE_SENTIMENT_FLOOR };
}

/** The tracked rivals this slice was judged against, sorted so the version is stable. */
function trackedRivalNames(rows) {
  const names = new Set();
  for (const row of rows || []) {
    for (const brand of row?.brands || []) {
      if (brand && !(brand.is_self ?? brand.isSelf) && brand.name) names.add(String(brand.name));
    }
  }
  return Array.from(names).sort();
}

/** First/last collection time the rows carry, or null when they carry none. */
function rowsCollectionWindow(rows) {
  let start = null;
  let end = null;
  for (const row of rows || []) {
    const at = row?.collected_at ?? row?.collectedAt ?? row?.observation_time ?? null;
    if (!at) continue;
    if (start === null || at < start) start = at;
    if (end === null || at > end) end = at;
  }
  return start === null ? null : { start, end };
}

/**
 * One metric from one pool of rows, THROUGH the contract — so the counting, the
 * gate and the reason vocabulary cannot drift between the slice, the stored row
 * and the rollup.
 */
function metricFromRows({
  metricId,
  rows,
  valueOf,
  exclusionOf = null,
  unknownReason = null,
  zeroReason = METRIC_REASONS.BRAND_NOT_VISIBLE,
  conditional = false,
  collection = null,
  context,
  unit = METRIC_UNITS.PERCENT,
  policy = ELIGIBILITY_POLICY_V1,
}) {
  const observations = (rows || []).map((row) => ({
    key: observationKeyOf(row),
    promptId: promptIdentityOf(row),
    replicate: replicateIndexOf(row),
    value: valueOf(row),
    exclusion: exclusionOf ? exclusionOf(row) : null,
  }));

  const counts = reduceObservations(observations, {
    policy,
    promptIdOf: (o) => o.promptId,
    replicateOf: (o) => o.replicate,
    valueOf: (o) => o.value,
  });

  return createMetric({
    metricId,
    unit,
    numerator: counts.numerator,
    denominator: counts.denominator,
    eligiblePromptIds: counts.eligiblePromptIds,
    replicateObservations: counts.replicateObservations,
    duplicateObservations: counts.duplicates,
    unkeyedObservations: counts.unkeyed,
    exclusions: counts.exclusions,
    unknownReason,
    zeroReason,
    conditional,
    collection,
    context,
    policy,
  });
}

/** Distinct prompt IDs across a pool of rows, for a metric counted from totals. */
function distinctPromptIds(rows) {
  const ids = new Set();
  for (const row of rows || []) {
    const id = promptIdentityOf(row);
    if (id !== null) ids.add(id);
  }
  return Array.from(ids);
}

/**
 * The R05 metric set for one engine slice.
 *
 * `panel` is the DECLARED eligible panel — every answered non-branded prompt —
 * and it is the denominator of the self metrics. It is deliberately not
 * `elicitingPool`: that pool is derived from the tracked-rival roster, and using
 * it for a self rate is exactly what made a score move when a never-mentioned
 * rival was added or removed (A04). The conditional metrics keep the eliciting
 * pool, because "when they named someone, how often was it us" is a real question
 * — it is just not the same question as "how often did they name us".
 */
function buildSliceMetrics({
  engineName,
  nonBranded,
  panel,
  elicitingPool,
  selfMentions,
  allMentions,
  hasRivalRoster,
  rivalRoster,
  citationTelemetryObserved,
  policy = ELIGIBILITY_POLICY_V1,
  options = {},
}) {
  const planned = nonBranded.length;
  const collection = { valid: panel.length, planned };
  const window = rowsCollectionWindow(panel);

  const contextFor = (rosterVersion) =>
    measurementContext({
      panelVersion: options.panelVersion ?? options.panel_version ?? null,
      surfaceVersion: options.surfaceVersion ?? options.surface_version ?? null,
      market: options.market ?? null,
      modelPolicyVersion: options.modelPolicyVersion ?? options.model_policy_version ?? null,
      metricVersion: METRIC_CONTRACT_VERSION,
      policyVersion: policy.version,
      rosterVersion,
      engineCohort: [engineName],
      window,
    });

  // The self metrics. No roster version: they are counted over the declared panel
  // and must not depend on which rivals are tracked.
  const selfContext = contextFor(null);
  const conditionalContext = contextFor(hasRivalRoster ? rivalRoster.join("|") : null);
  const elicitingIds = distinctPromptIds(elicitingPool);

  const metrics = {
    [METRIC_IDS.EXPOSURE]: metricFromRows({
      metricId: METRIC_IDS.EXPOSURE,
      rows: panel,
      valueOf: (r) => r.visible === true,
      context: selfContext,
      collection,
      policy,
    }),
    [METRIC_IDS.MENTION]: metricFromRows({
      metricId: METRIC_IDS.MENTION,
      rows: panel,
      valueOf: (r) => (hasObservedAnswerText(r) ? r.brand_mentioned_in_text === true : null),
      exclusionOf: () => METRIC_REASONS.TEXT_NOT_OBSERVED,
      context: selfContext,
      collection,
      policy,
    }),
    [METRIC_IDS.CITATION]: metricFromRows({
      metricId: METRIC_IDS.CITATION,
      rows: panel,
      /**
       * Rows whose citation list was never observed contribute NEITHER side of
       * the ratio: they are excluded with their own reason rather than counted
       * as a confirmed "did not cite us" (the shape R2.2.2 fixed one layer down
       * and R05-12 restates at the metric).
       */
      valueOf: (r) => (hasUnverifiedCitations(r) ? null : r.brand_cited === true),
      exclusionOf: () => METRIC_REASONS.CITATION_LIST_UNOBSERVED,
      zeroReason: METRIC_REASONS.BRAND_NOT_CITED,
      /**
       * Every citation list observed was empty of the brand's domain is a
       * measurement (a real 0). NO list observed at all is not: nobody could
       * look, so the reading is unknown rather than an uncited zero.
       */
      unknownReason:
        panel.length === 0 || citationTelemetryObserved ? null : METRIC_REASONS.CITATION_TELEMETRY_ABSENT,
      context: selfContext,
      collection,
      policy,
    }),
    [METRIC_IDS.RECOMMENDATION]: metricFromRows({
      metricId: METRIC_IDS.RECOMMENDATION,
      rows: panel,
      valueOf: (r) => {
        const reading = selfRecommendationOf(r);
        return reading.observed ? reading.positive : null;
      },
      exclusionOf: () => METRIC_REASONS.NO_RECOMMENDATION_JUDGMENT,
      unknownReason: METRIC_REASONS.NO_RECOMMENDATION_JUDGMENT,
      context: selfContext,
      collection,
      policy,
    }),
    [METRIC_IDS.CONDITIONAL_VENDOR_SHARE]: createMetric({
      metricId: METRIC_IDS.CONDITIONAL_VENDOR_SHARE,
      numerator: allMentions === 0 ? null : selfMentions,
      denominator: allMentions,
      eligiblePromptIds: elicitingIds,
      unknownReason: METRIC_REASONS.ELICITING_POOL_EMPTY,
      conditional: true,
      collection,
      context: conditionalContext,
      policy,
    }),
    [METRIC_IDS.SHARE_OF_VOICE]: createMetric({
      metricId: METRIC_IDS.SHARE_OF_VOICE,
      numerator: hasRivalRoster ? selfMentions : null,
      denominator: allMentions,
      eligiblePromptIds: hasRivalRoster ? elicitingIds : [],
      unknownReason: hasRivalRoster ? METRIC_REASONS.ELICITING_POOL_EMPTY : METRIC_REASONS.SELF_ONLY_ROSTER,
      conditional: true,
      collection,
      context: conditionalContext,
      policy,
    }),
    [METRIC_IDS.COMPLETION]: metricFromRows({
      metricId: METRIC_IDS.COMPLETION,
      rows: nonBranded,
      valueOf: (r) => r.answer_present === true,
      context: selfContext,
      policy,
    }),
  };

  // The AIO trigger rate is only a measurement on a SERP surface: a text engine
  // has no overview to trigger, and reporting its 0% would be a reading nobody
  // took.
  if (engineName === "aio") {
    metrics[METRIC_IDS.TRIGGER] = metricFromRows({
      metricId: METRIC_IDS.TRIGGER,
      rows: panel,
      valueOf: (r) => r.aio_present === true,
      context: selfContext,
      collection,
      policy,
    });
  }

  return metrics;
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
 *
 * @param {object[]} results  the probe rows for this engine.
 * @param {string} engineName  "aio", "chatgpt", "gemini", "perplexity".
 * @param {object} [options]  the R05 measurement identity the metrics are built
 *   under: `{ panelVersion, surfaceVersion, market, modelPolicyVersion }`. Only
 *   the caller knows these, so a field it does not supply stays NULL on the
 *   metric — and a comparison against a reading that lacks one is refused rather
 *   than assumed compatible. Omitting the whole argument is safe: the slice's
 *   legacy fields and its state are unchanged either way.
 */
export function summarizeEngineSlice(results, engineName, options = {}) {
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

  // --- The citation pool: answered rows whose citation list was OBSERVED ----
  //
  // R2.2.2 (finding B2). Perplexity's citations come from a second call
  // (/search) that fails independently of the answer leg. A row whose /search
  // died carries `citations: []` and `error: null` — before the citations_state
  // vocabulary, byte-identical to a healthy /search that genuinely found nothing
  // to cite. Dividing by every answered row therefore scores an OUTAGE as a
  // confirmed "the brand was not cited here", which is a claim the engine never
  // made. Standing rule 1: an unmeasured zero must not look like a measured one.
  //
  // Both sides of the ratio are taken over this pool. The numerator barely
  // changes today — a row with no citations cannot have brand_cited true — but
  // computing them over two different pools is how a future citation source
  // (say, in-answer link annotations surviving a dead /search) would silently
  // produce a share above 100%.
  //
  // hasUnverifiedCitations is a POSITIVE test for the unverified marker, so a
  // single-leg engine (aio, chatgpt) whose rows carry `citations_state: null`
  // or no marker at all is never quietly dropped from its own denominator.
  const citationPool = nonBrandedWithAnswer.filter((r) => !hasUnverifiedCitations(r));
  const citationsUnverifiedCount = nonBrandedWithAnswer.length - citationPool.length;
  const citedNonBranded = citationPool.filter((r) => r.brand_cited).length;

  // An exclusion nobody can see is an exclusion nobody can audit. Says how many
  // rows dropped out and what the denominator became, so a shrunken citation
  // share has a reason in the log next to the numbers that caused it.
  if (citationsUnverifiedCount > 0) {
    console.warn(
      `[${engineName}] ${citationsUnverifiedCount} of ${nonBrandedWithAnswer.length} answered non-branded rows ` +
        `carry an unverified citation list (the citation leg failed). Excluded from the citation-share ` +
        `denominator, which is ${citationPool.length}, not ${nonBrandedWithAnswer.length}. They are not counted ` +
        `as uncited.`
    );
  }

  const rankNotCited = nonBrandedWithAnswer.filter(
    (r) => r.brand_organic_position && r.brand_organic_position <= 10 && !r.visible
  );
  const rank_not_cited_count = rankNotCited.length;

  // R2.9.7 — AN EMPTY DENOMINATOR PRODUCES NO PERCENTAGE. These four ratios all
  // used to end `: 0`, which published a confident reading for a slice that
  // measured nothing: `coverage_pct: 0` says "we answered none of the prompts we
  // asked" when none were asked, and `error_rate_pct: 0` says "nothing errored"
  // for an engine that never ran a query. That second one is the lead this task
  // was filed on — it is the value emitted at the `error_rate_pct` key below,
  // and R2.7.16 had already had to un-fabricate the SAME field one layer down in
  // describeDegradedSlice. The state/state_reason pair emitted with them is what
  // names which kind of nothing it was.
  //
  // A non-empty denominator with a zero numerator still yields 0: "we read 30
  // answers and none named you" is a measurement and must survive.
  const coveragePct = ratioPctOrNull(nonBrandedWithAnswer.length, nonBranded.length);
  const errorRatePct = ratioPctOrNull(errored, total);

  // Denominator is the ELICITING pool, not every answered prompt (see above).
  //
  // R2.9.7 — this one was ALREADY neutralised downstream: an empty eliciting
  // pool resolves to not_assessed and `reportedVisibilityPct` below publishes
  // null regardless. It is routed through the shared helper anyway so the two
  // guards cannot drift apart — if a future state ever reports on an empty
  // pool, the null arrives here rather than a 0 that the state check waved
  // through. MEASURED/MEASURED_ZERO both require elicitingPool.length > 0, so
  // no measured reading is blanked by this.
  const visibilityPct = ratioPctOrNull(visibleNonBranded, elicitingPool.length);

  // What fraction of the prompt set is actually a usable probe? This is a
  // property of the PROMPT SET, not the brand — a low number means the
  // generator produced SEO keywords instead of vendor-selection questions and
  // the scan is measuring almost nothing. Surfaced so it can be alerted on.
  //
  // R2.9.7: null, not 0, with no answered non-branded prompt to judge. "None of
  // this prompt set is a usable probe" is a damning verdict on the generator and
  // it must not be handed out for a slice that produced no answers to look at.
  const elicitationRatePct = ratioPctOrNull(elicitingPool.length, nonBrandedWithAnswer.length);

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
  //
  // R2.9.7 — the OTHER empty denominator on this metric, which the rival-roster
  // guard above does not cover. `allMentions` is 0 exactly when the eliciting
  // pool is empty (countBrandsElicited counts MENTIONED rows, so a non-empty
  // pool implies at least one mention), and that slice is about to be labelled
  // not_assessed / empty_eliciting_pool. Publishing `share_of_voice_pct: 0`
  // alongside that state claims "when the engines named someone it was never
  // you" about answers in which the engines named nobody at all.
  const shareOfVoicePct = !hasRivalRoster ? null : ratioPctOrNull(selfMentions, allMentions);

  const topRivals = Object.entries(rivalMentions)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([name, mentions]) => ({
      name,
      mentions,
      // R2.9.7 — unreachable with an empty denominator (a rival is only in this
      // map because it was mentioned, so allMentions >= mentions >= 1), routed
      // through the helper so no reader has to re-derive that to trust it.
      share_pct: ratioPctOrNull(mentions, allMentions),
    }));

  // R2.9.7 — null with no non-branded prompt asked; see coverage_pct above.
  const presenceRatePct = ratioPctOrNull(visibleNonBranded, nonBranded.length);

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
  //
  // R2.9.7 — `errorRatePct !== null &&` is written out rather than left to
  // `null > n` being false. The behaviour is identical today; the point is that
  // a reader can see the null branch was considered, so the next edit does not
  // "fix" an apparently missing guard by reintroducing a `?? 0`.
  const gates = engineHealthThresholds(engineName);
  const dataSourceIssue =
    (errorRatePct !== null && errorRatePct > gates.errorRateLimitPct) ||
    (nonBranded.length > 0 &&
      nonBrandedWithAnswer.length / nonBranded.length < gates.minNonBrandedCoverage);

  // Sample adequacy is judged on the ELICITING pool — the prompts that can
  // actually produce a mention. 56 answered prompts of which only 16 name any
  // vendor is a sample of 16, and reporting it as adequate is how a score gets
  // presented with false confidence.
  //
  // R05 KEEPS THIS FLAG AND STOPS LETTING IT BE DECORATIVE. It is true here
  // exactly when the metric's ACTUAL conditional denominator is thin, and the
  // contract now refuses to headline a value whose own denominator is under the
  // v1 minimum (see buildSliceMetrics / qualificationOf). The flag itself is
  // unchanged, because two of its consumers (the dashboard chip and
  // summarizeEngineResults' any-engine flag) read it as written.
  const insufficientSample =
    engineName === "aio"
      ? elicitingPool.length < AIO_MIN_NON_BRANDED_WITH_AIO
      : elicitingPool.length < 5;

  // R05 — the versioned metric set. See the comment above it for why the self
  // metrics are counted over the declared panel and the conditional ones over the
  // eliciting pool.
  const metrics = buildSliceMetrics({
    engineName,
    nonBranded,
    panel: nonBrandedWithAnswer,
    elicitingPool,
    selfMentions,
    allMentions,
    hasRivalRoster,
    rivalRoster: trackedRivalNames(nonBrandedWithAnswer),
    citationTelemetryObserved: citationPool.length > 0,
    options,
  });

  // R2.1.1 — say which of the four states this slice is in, and stop reporting
  // a number in the two states where there isn't one. visibilityPct is 0 by
  // construction on an empty denominator (0/0 is guarded above), and that 0 was
  // indistinguishable from a brand genuinely never named. See
  // ENGINE_MEASUREMENT_STATE.
  const { state, state_reason } = resolveEngineMeasurementState({
    total,
    nonBrandedCount: nonBranded.length,
    elicitingCount: elicitingPool.length,
    visibleNonBranded,
    dataSourceIssue,
    errorRatePct,
    gates,
  });
  const reportedVisibilityPct = MEASURED_STATES.has(state) ? visibilityPct : null;

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
    // R2.2.2 — the denominator `cited_non_branded` was ACTUALLY counted over,
    // emitted rather than left to be re-derived. It is NOT
    // `non_branded_with_answer` whenever a citation leg failed, and
    // src/lib/analytics/rollup.js divides cited by answered independently: with
    // only the numerator filtered, that second division would put the outage
    // straight back into citation_share_pct. A consumer must divide by this.
    citation_denominator: citationPool.length,
    // How many answered non-branded rows were excluded for an unobserved
    // citation list. 0 here is a measurement — "every citation list was
    // observed" — and is why the field is always present rather than only when
    // something went wrong.
    citations_unverified_count: citationsUnverifiedCount,
    rank_not_cited_count,
    coverage_pct: coveragePct,
    error_rate_pct: errorRatePct,
    // Null in every non-measured state — NEVER 0 (standing rule 5). The pair
    // below is what tells the reader which state that is; a surface renders the
    // em dash plus the state chip, not `?? 0`.
    share_of_ai_pct: reportedVisibilityPct,
    visibility_pct: reportedVisibilityPct,
    state,
    state_reason,
    presence_rate_pct: presenceRatePct,
    data_source_issue: dataSourceIssue,
    insufficient_sample: insufficientSample,
    // R05 — the versioned metric DTOs, and the version of the contract they were
    // built under. `share_of_ai_pct` above stays the CONDITIONAL index it has
    // always been (self appearances among answers that named a vendor); the
    // unconditional self rates live in `metrics`, where a roster change cannot
    // reach them.
    metric_contract_version: METRIC_CONTRACT_VERSION,
    metrics,
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
  gemini: 1,
  perplexity: 1,
};

/**
 * The number of non-branded answers a slice must carry before the headline will
 * blend it. Named because describeScanDataSourceIssue has to reproduce the same
 * eligibility test to explain the count it reports.
 */
export const HEADLINE_MIN_NON_BRANDED_ANSWERS = 5;

/**
 * The measurement identity a headline was produced under, from whatever the
 * caller knows. Every field may be null, and a null is NOT a default: a
 * comparison against a record that does not carry its panel/surface/market has
 * nothing to compare (see compareHeadlines / checkComparability). Threading the
 * real values in is the caller's job — this function only refuses to invent them.
 */
function headlineContext({ policy, options, cohort }) {
  return measurementContext({
    panelVersion: options?.panelVersion ?? options?.panel_version ?? null,
    surfaceVersion: options?.surfaceVersion ?? options?.surface_version ?? null,
    market: options?.market ?? null,
    modelPolicyVersion: options?.modelPolicyVersion ?? options?.model_policy_version ?? null,
    metricVersion: METRIC_CONTRACT_VERSION,
    policyVersion: policy.version,
    engineCohort: cohort,
  });
}

/**
 * The index metric behind a blended headline: the counted engines' exposure
 * metrics pooled into ONE denominator, with the union of their prompt IDs.
 *
 * Pooling rather than averaging is what makes the gate mean anything: the v1
 * distinct-prompt minimum and 95% collection gate are read off this metric's OWN
 * denominator — the answers the index was actually counted over — and not off the
 * larger pool of answers that happened to come back (A02's defect, exactly).
 */
function headlineMetricFor(eligible, { policy, options, cohort }) {
  const context = headlineContext({ policy, options, cohort });
  const metricSlices = eligible
    .map((s) => s?.metrics?.[METRIC_IDS.EXPOSURE])
    .filter((m) => m && typeof m === "object");

  if (metricSlices.length === 0) {
    /**
     * A slice written before R05 carries no metric DTO, so the denominator, the
     * distinct-prompt count and the collection completion behind its number
     * cannot be established. That is a refusal with a reason — never a silent
     * pass for a historical figure wearing a new gate's name.
     */
    return createMetric({
      metricId: METRIC_IDS.EXPOSURE,
      numerator: null,
      denominator: null,
      unknownReason: METRIC_REASONS.LEGACY_RECORD,
      context,
      policy,
    });
  }

  let numerator = 0;
  let denominator = 0;
  let valid = 0;
  let planned = 0;
  let replicateObservations = 0;
  let duplicateObservations = 0;
  let collectionComplete = true;
  const promptIds = new Set();
  const exclusionCounts = new Map();

  for (const metric of metricSlices) {
    const n = measuredNumberOrNull(metric.numerator);
    const d = measuredNumberOrNull(metric.denominator);
    if (n !== null) numerator += n;
    if (d !== null) denominator += d;

    const replicates = measuredNumberOrNull(metric.replicate_observations);
    if (replicates !== null) replicateObservations += replicates;
    const duplicates = measuredNumberOrNull(metric.duplicate_observations);
    if (duplicates !== null) duplicateObservations += duplicates;

    for (const id of metric.eligible_prompt_ids || []) promptIds.add(String(id));
    for (const exclusion of metric.exclusions || []) {
      const prior = measuredNumberOrNull(exclusionCounts.get(exclusion.reason));
      exclusionCounts.set(exclusion.reason, prior === null ? exclusion.count : prior + exclusion.count);
    }

    const countedValid = measuredNumberOrNull(metric.collection?.valid);
    const countedPlanned = measuredNumberOrNull(metric.collection?.planned);
    if (countedValid === null || countedPlanned === null) collectionComplete = false;
    else {
      valid += countedValid;
      planned += countedPlanned;
    }
  }

  return createMetric({
    metricId: METRIC_IDS.EXPOSURE,
    numerator,
    denominator,
    eligiblePromptIds: Array.from(promptIds),
    replicateObservations,
    duplicateObservations,
    exclusions: Array.from(exclusionCounts.entries()).map(([reason, count]) => ({ reason, count })),
    // One engine that cannot state its planned/valid pair makes the whole gate
    // unverifiable, and an unverifiable gate refuses (COLLECTION_UNVERIFIED)
    // rather than passing on the engines that did report.
    collection: collectionComplete ? { valid, planned } : null,
    context,
    policy,
  });
}

/**
 * The headline object, assembled in ONE place so the raw index and the qualified
 * headline can never be confused for each other.
 *
 * TWO NUMBERS, ON PURPOSE (R05-05). `visibility_index_pct` is the raw exploratory
 * index — what it has always been, still persisted where it always was, still
 * shown as an exploratory reading when the gates are not met. `headline_pct` is
 * the QUALIFIED headline and is null below a gate, with `headline_reason` naming
 * which gate failed. A surface that prints a headline reads the second.
 */
function headlineResult({ index, eligible, excludedEngines, metric }) {
  return {
    visibility_index_pct: index,
    engines_counted: eligible.length,
    counted_engines: eligible.map((s) => s.engine),
    excluded_engines: excludedEngines,
    /** True when the index was blended over fewer engines than ran. */
    reweighted: excludedEngines.length > 0,
    metric_contract_version: METRIC_CONTRACT_VERSION,
    metric,
    qualified: metric.qualified,
    headline_pct: metric.qualified_pct,
    headline_state: metric.qualified_state,
    headline_reason: metric.qualified_reason,
    distinct_eligible_prompts: metric.distinct_eligible_prompts,
    eligible_prompt_ids: metric.eligible_prompt_ids,
    valid_collection_pct: metric.valid_collection_pct,
    collection: metric.collection,
    replicate_observations: metric.replicate_observations,
    policy_version: metric.policy.version,
    context: metric.context,
  };
}

/**
 * Computes the headline "AI Visibility Index" — weighted mean of per-engine
 * share_of_ai across engines that produced ≥5 non-branded answers, plus the R05
 * qualified headline over the same engines.
 *
 * @param {object[]} engineSummaries  per-engine slices (summarizeEngineSlice).
 * @param {object} [weights]  relative engine weights. RENORMALIZED over the
 *   eligible engines, which is why `reweighted` is reported: a blend over fewer
 *   engines is a different index, and a comparison against an older, wider one is
 *   suppressed rather than presented as movement (R05-17).
 * @param {object} [options]  `{ policy, panelVersion, surfaceVersion, market }` —
 *   the measurement identity, threaded from the scan. A missing field stays null
 *   and makes a comparison refuse.
 */
export function computeHeadline(engineSummaries, weights = ENGINE_WEIGHTS, options = {}) {
  const slices = (Array.isArray(engineSummaries) ? engineSummaries : []).filter(
    (s) => s && typeof s === "object"
  );

  const eligible = slices.filter(
    (s) =>
      !s.data_source_issue &&
      s.non_branded_with_answer >= HEADLINE_MIN_NON_BRANDED_ANSWERS &&
      // R2.1.1 — a slice with no measurement is not blended. Without this the
      // null a not_assessed slice now reports would go through `null * weight`
      // as 0 and drag the index down on behalf of an engine that measured
      // nothing: the false zero this task exists to remove, re-entering one
      // layer up. `data_source_issue` does not cover it — a slice can answer 30
      // prompts cleanly and still elicit no vendor at all.
      isMeasuredEngineSlice(s)
  );

  const policy = options.policy ?? ELIGIBILITY_POLICY_V1;

  // Why the blend is narrower than the scan: named, with the slice's own state as
  // the reason, so "the index counts 1 of 2 engines" is explainable from the
  // headline object rather than only from a banner computed elsewhere.
  const excludedEngines = slices
    .filter((s) => measuredNumberOrNull(s.non_branded_queries) > 0 && !eligible.includes(s))
    .map((s) => ({
      engine: s.engine,
      state: s.state ?? null,
      state_reason: s.state_reason ?? null,
    }));

  if (eligible.length === 0) {
    const none = createMetric({
      metricId: METRIC_IDS.EXPOSURE,
      numerator: null,
      denominator: null,
      unknownReason: METRIC_REASONS.NO_ELIGIBLE_OBSERVATIONS,
      context: headlineContext({ policy, options, cohort: [] }),
      policy,
    });
    return headlineResult({ index: null, eligible, excludedEngines, metric: none });
  }

  const totalWeight = eligible.reduce((acc, s) => acc + (weights[s.engine] ?? 1), 0);
  const weightedSum = eligible.reduce(
    (acc, s) => acc + s.share_of_ai_pct * (weights[s.engine] ?? 1),
    0
  );
  const mean = Math.round((weightedSum / totalWeight) * 10) / 10;

  const metric = headlineMetricFor(eligible, {
    policy,
    options,
    cohort: eligible.map((s) => s.engine),
  });

  return headlineResult({ index: mean, eligible, excludedEngines, metric });
}

/**
 * R05.4a — may two readings be compared at all?
 *
 * Accepts a scan summary (or a headline, or a metric DTO) from each side and
 * answers with the contract's verdict: a delta only when panel, surface, market,
 * model policy, eligibility policy, metric version AND the counted engine cohort
 * all match, otherwise `comparable: false` with the specific boundary reason and
 * the sentence that explains it. A changed cohort is its own boundary because a
 * reweighted blend is a different index — presenting it as movement in this one
 * is the "silently comparable historical headline" R05-17 is about.
 *
 * @returns {{comparable: boolean, delta_pct: number|null, boundary_reason: string|null, detail: string|null, changed: object[]}}
 */
export function compareHeadlines(current, previous) {
  return compareMetrics(metricOfReading(current), metricOfReading(previous));
}

/** A summary, a headline or a metric, as the metric DTO the comparison needs. */
function metricOfReading(reading) {
  if (!reading || typeof reading !== "object") return null;
  return reading.metric ?? reading.headline_metric ?? reading;
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
  // R2.9.7 — `Number(options.enginesCounted)` could not tell null from 0:
  // `Number(null) === 0` and `Number.isFinite(0)` is true, so a caller that
  // passed null (summarizeEngineResults does exactly that when there is no
  // headline) was recorded as having SUPPLIED a count of zero. Both paths
  // happen to emit 0 today, so this is a latent fabrication rather than a live
  // one — but services/api.js:687 cites this very expression as the reason its
  // own `enginesCounted ?? 0` is allowed to stay, so leaving it blurred keeps
  // that argument true by accident. The `: 0` fallback below is unchanged and
  // deliberate: it is the documented legacy contract (see the docstring), and
  // turning it null is a consumer-visible change that belongs to whoever owns
  // that contract.
  const suppliedCount = measuredNumberOrNull(options.enginesCounted);
  const hasSuppliedCount = suppliedCount !== null;

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
      Number(slice.non_branded_with_answer) >= HEADLINE_MIN_NON_BRANDED_ANSWERS &&
      // Kept in lockstep with computeHeadline's filter (R2.1.1). The docstring
      // above promises this reproduces the headline's own eligibility test, so
      // the "1 of 2 engines" in the banner is derived from the same rows as the
      // index it explains. Omitting the measured check here would make the
      // banner claim an engine the index did not blend, the instant a
      // not_assessed slice appeared alongside a degraded one.
      isMeasuredEngineSlice(slice)
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
 * The two ways a scan's FROZEN engine set can stop being the set it was frozen
 * with. Named, because they are not the same event and the record must say
 * which one happened (R3.2.5, finding B3).
 */
export const ENGINE_SET_STATES = Object.freeze({
  /**
   * At least one frozen engine stopped resolving. The original work matrix
   * remains intact; if none survive, there is no measured index.
   */
  SHRANK: "shrank",
  /**
   * Persisted rows exist from an engine outside the frozen set. Current
   * dispatch does not create these; older in-flight scans may still carry them.
   */
  REFROZEN: "refrozen",
});

/** Trimmed, de-duplicated, empties dropped. Never invents a name. */
function engineNameList(value) {
  return Array.from(
    new Set(
      (Array.isArray(value) ? value : [])
        .map((n) => String(n ?? "").trim())
        .filter(Boolean)
    )
  );
}

/** `["aio"]` -> `[{ engine: "aio", label: "Google AI Overview" }]`, for a UI that renders names. */
function asEngineRefs(names) {
  return names.map((engine) => ({ engine, label: engineDisplayLabel(engine) }));
}

/**
 * Did this scan's engine set stop being the set it was frozen with, and how?
 *
 * R3.2.5 (finding B3). `checkpoint.engines` is frozen at sourcing time so a
 * mid-scan env change cannot re-pick a running scan's engines. R3.2.2 made the
 * missing frozen engines VISIBLE TO AN OPERATOR in
 * `scan_runs.detail.skips` as `engine_not_registered`. Nothing made them visible to the SCAN. The headline
 * was blended over fewer engines, `scans.engines_counted` dropped, and the scan
 * record carried no reason for either: the number moved and the explanation
 * existed only in a ledger nobody rendering a dashboard reads. That is the same
 * class R2.2.6 closed for a degraded engine, one step earlier — there the
 * engine answered badly, here it is gone.
 *
 * TWO STATES, KEPT APART ON PURPOSE. "Fewer engines than I promised" and "rows
 * from an engine I did not promise" cost the reader different things, and
 * collapsing them would tell someone whose scan is no longer comparable to its
 * own history that it merely counts one engine fewer.
 *
 * NULL ON THE HAPPY PATH. A scan where every frozen engine still resolved
 * carries no marker at all, so the presence of this object is itself the
 * signal and an unchanged scan is not annotated with an "everything is fine"
 * record nobody would read.
 *
 * A SCAN WITH NO FROZEN SET RETURNS NULL TOO, and that is not a swallowed
 * skip: an engine set that was never frozen has nothing to have changed FROM.
 * Every scan since P0.2 freezes one at sourcing; a checkpoint without one
 * predates the freeze, and inventing a baseline for it would report a change
 * that was never promised.
 *
 * @param {object} args
 * @param {string[]|null} args.frozen  the engine names frozen onto the checkpoint.
 * @param {string[]} args.registered   the engine names the live registry resolves NOW.
 * @param {string[]|null} [args.probed]  distinct engine names that actually produced
 *   persisted rows, when the caller has them (finalize does, probing does not).
 *   Evidence, not configuration: rows from an engine that was never frozen prove
 *   a refreeze even if the registry has since recovered. `null` means "I did not
 *   look", which is different from `[]` ("I looked and nothing was probed") and
 *   neither one is allowed to invent a substitution.
 * @param {string[]} [args.priorDropped]  frozen engines an EARLIER chunk already
 *   saw drop. The event is sticky across chunks: an engine that vanished for two
 *   chunks and came back really did stop being probed for those pairs.
 * @param {string[]} [args.priorSubstituted]  the set an earlier chunk fell back to.
 * @returns {null|object} null when nothing changed, else the record the scan carries.
 */
export function describeEngineSetChange({
  frozen,
  registered,
  probed = null,
  priorDropped = [],
  priorSubstituted = [],
} = {}) {
  const frozenNames = engineNameList(frozen);
  if (frozenNames.length === 0) return null;

  const frozenSet = new Set(frozenNames);
  const registeredSet = new Set(engineNameList(registered));

  // Dropped = frozen but not registered now, UNION whatever an earlier chunk
  // already recorded. `priorDropped` is filtered back through the frozen set so
  // a malformed checkpoint cannot add an engine this scan never froze.
  const dropped = engineNameList([
    ...frozenNames.filter((name) => !registeredSet.has(name)),
    ...engineNameList(priorDropped).filter((name) => frozenSet.has(name)),
  ]);
  const droppedSet = new Set(dropped);
  const resolved = frozenNames.filter((name) => !droppedSet.has(name));

  const probedNames = probed === null || probed === undefined ? null : engineNameList(probed);
  const substituted = engineNameList([
    ...(probedNames ? probedNames.filter((name) => !frozenSet.has(name)) : []),
    ...engineNameList(priorSubstituted).filter((name) => !frozenSet.has(name)),
  ]);

  let state;
  if (substituted.length > 0) {
    state = ENGINE_SET_STATES.REFROZEN;
  } else if (dropped.length > 0) {
    state = ENGINE_SET_STATES.SHRANK;
  } else {
    return null;
  }

  const frozenLabels = formatEngineList(frozenNames.map(engineDisplayLabel));
  const droppedLabels = formatEngineList(dropped.map(engineDisplayLabel));
  const resolvedLabels = formatEngineList(resolved.map(engineDisplayLabel));
  const substitutedLabels = substituted.length
    ? formatEngineList(substituted.map(engineDisplayLabel))
    : null;
  const one = dropped.length === 1;

  const title =
    state === ENGINE_SET_STATES.SHRANK
      ? `Engine set shrank mid-scan — ${droppedLabels} stopped resolving`
      : `Engine set was refrozen mid-scan — this scan is not comparable to this brand's earlier scans`;

  const detail =
    state === ENGINE_SET_STATES.SHRANK
      ? `This scan was frozen onto ${frozenLabels} when it started. ${droppedLabels} stopped being ` +
        `registered before it finished, so ${one ? "it was" : "they were"} never probed. ` +
        (resolved.length === 0
          ? `No frozen engine remained, so no AI Visibility Index was measured. `
          : `The index is blended over ${resolved.length} of the ${frozenNames.length} engines ` +
            `this scan was frozen with (${resolvedLabels}), which is why the engines counted fell. `) +
        `Re-run the scan to bring ${droppedLabels} back.`
      : `This scan was frozen onto ${frozenLabels} when it started, and ` +
        `${dropped.length === 0 ? "its frozen engines were still registered" :
          resolved.length === 0 ? "none of those engines still resolved" : `${droppedLabels} stopped resolving`} ` +
        `before it finished. It was answered by ` +
        `${substitutedLabels || "the engine set configured when it finished"} instead. A frozen ` +
        `engine set is what makes two scans of the same brand comparable, so this reading cannot ` +
        `be compared to this brand's history. Re-run the scan for a comparable reading.`;

  return {
    state,
    frozen_engines: asEngineRefs(frozenNames),
    resolved_engines: asEngineRefs(resolved),
    dropped_engines: asEngineRefs(dropped),
    substituted_engines: asEngineRefs(substituted),
    engines_frozen: frozenNames.length,
    engines_resolved: resolved.length,
    title,
    detail,
  };
}

// R2.7.16 introduced `measuredNumberOrNull` at this point in the file; R2.9.7
// moved it (and its empty-denominator sibling `ratioPctOrNull`) to
// ./measuredNumber.js so contentLift.js and the next producer share ONE
// implementation instead of re-hand-rolling the shape per site. The reasoning
// lives in that file's header; src/lib/scoring/metricCoercionGuard.test.mjs is
// the walker that keeps new bare coercions out of this directory.

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
  const nonBranded = measuredNumberOrNull(slice.non_branded_queries);
  const answered = measuredNumberOrNull(slice.non_branded_with_answer);
  const errorRatePct = measuredNumberOrNull(slice.error_rate_pct);

  const reasons = [];
  if (
    nonBranded !== null &&
    nonBranded > 0 &&
    answered !== null &&
    answered / nonBranded < gates.minNonBrandedCoverage
  ) {
    const coveragePct = Math.round((answered / nonBranded) * 1000) / 10;
    reasons.push(
      `answered ${answered} of ${nonBranded} tracked prompts (${coveragePct}%), under the ${minCoveragePct}% this engine needs`
    );
  }
  if (errorRatePct !== null && errorRatePct > gates.errorRateLimitPct) {
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
    error_rate_pct: errorRatePct,
    min_coverage_pct: minCoveragePct,
    error_rate_limit_pct: gates.errorRateLimitPct,
  };
}

const ENGINE_REGISTRY = [
  {
    name: "gemini",
    label: "Gemini",
    isConfigured: () => isOpenRouterEngineConfigured("gemini"),
    probe: async (query, brand, brandAliases, brandDomain, competitors, stats) =>
      probeTextEngine(
        { name: "gemini", probe: async (prompt, options) => {
          const result = await probeOpenRouterEngine({ engine: "gemini", query: prompt, stats: options?.stats });
          const observed = !result.error && (result.search_requests > 0 || result.references.length > 0);
          return {
            ...result,
            citations_state: observed ? "verified" : "unverified",
            citations_state_reason: observed ? null : "web_search_not_used",
            citations_state_detail: observed ? null : "No web-search activity or citation references were returned",
          };
        } },
        query, brand, brandAliases, brandDomain, competitors, stats
      ),
    concurrency: 4,
  },
  {
    name: "aio",
    label: "Google AIO",
    isConfigured: () => !!process.env.BRIGHTDATA_API_KEY,
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
  const envVal = ((options.engines && String(options.engines).trim()) || process.env.ENGINES || "aio").trim();
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

  if (enabled.length === 0 && options.allowFallback !== false) {
    const aioDef = ENGINE_REGISTRY.find((e) => e.name === "aio");
    if (aioDef.isConfigured()) {
      // Substituting a DIFFERENT engine set than the one that was asked for. The
      // scan still runs, so nothing downstream fails — which is precisely why this
      // needs a reason of its own rather than a bare warning. It is the same class
      // as the checkpoint-level ENGINE_SET_FALLBACK, one layer earlier.
      console.warn("[engine-pipeline] No engines enabled! Defaulting to aio.");
      if (onSkip) onSkip(ENGINE_RESOLUTION_SKIPS.SET_DEFAULTED, requested.join(",") || "(empty ENGINES)");
      return [aioDef];
    }
    // Even aio is not configured — no engine can run.
    console.warn("[engine-pipeline] No engines enabled and aio is not configured — scan will have no engine results.");
    return [];
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

  // R2.2.2 — this legacy mirror is a REAL perplexity path: `aioSummary` falls
  // back to the first engine, so a perplexity-only scan computes its
  // scan-level citation_share_pct right here. Divide by the pool whose
  // citations were observed (see citation_denominator in summarizeEngineSlice),
  // never by every answered row.
  //
  // The fallback is for slices written before R2.2.2 only: those were counted
  // over `non_branded_with_answer` and had no concept of an unverified list, so
  // it is what their numerator really was. Every slice this function is called
  // with in the live pipeline comes from summarizeEngineSlice in the same
  // process and always carries the field.
  const citationDenominator = Number.isFinite(aioSummary.citation_denominator)
    ? aioSummary.citation_denominator
    : aioSummary.non_branded_with_answer;

  // R2.7.5 — Scan-level share_of_voice_pct. Unions the underlying mention
  // counts across all engines that assessed a rival roster, rather than
  // averaging per-engine ratios. Preserves the three-way distinction:
  // null = undefined without rivals (or empty eliciting pool),
  // 0 = assessed and nothing mentioned, a number otherwise.
  const slices = Object.values(engines || {}).filter((s) => s && typeof s === "object");
  const anyHasRivalRoster = slices.some(
    (s) => s.share_of_voice_pct !== null || (s.top_rivals && s.top_rivals.length > 0)
  );
  let scanShareOfVoicePct = null;
  if (anyHasRivalRoster) {
    let pooledSelf = 0;
    let pooledAll = 0;
    for (const s of slices) {
      const hasRivals = s.share_of_voice_pct !== null || (s.top_rivals && s.top_rivals.length > 0);
      if (hasRivals) {
        if (Number.isFinite(s.self_mentions)) pooledSelf += s.self_mentions;
        if (Number.isFinite(s.total_brand_mentions)) pooledAll += s.total_brand_mentions;
      }
    }
    scanShareOfVoicePct = ratioPctOrNull(pooledSelf, pooledAll);
  }

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
      // R2.9.7 — `?? null`, not `|| 0`, for the same reason the two lines below
      // stopped being `|| 0` in R2.1.1: these are now nullable at the source.
      // summarizeEngineSlice publishes null for both when the slice has no
      // denominator, and this object is written straight onto the persisted
      // `scans` row by scanWorker (aio_error_rate_pct at scanWorker.js:2115,
      // aio_coverage_pct via db.js:216), so a `|| 0` here would re-fabricate the
      // zero one statement after the producer refused to. `??` rather than `||`
      // because a measured 0% error rate is a real and good result.
      aio_coverage_pct: aioSummary.coverage_pct ?? null,
      error_rate_pct: aioSummary.error_rate_pct ?? null,
      // R2.1.1 — THE SCAN-LEVEL MIRROR OF THE AIO SLICE, AND IT IS LIVE.
      //
      // This function is not a legacy shim. src/lib/workers/scanWorker.js binds
      // it as `summarizeMulti` and writes these two straight onto the persisted
      // `scans` row (scanWorker.js:1962-1963), so whatever they say is what
      // every trend, delta and dashboard reads back forever.
      //
      // The `|| 0` that used to be here was not harmless. Before this task the
      // slice never emitted null, so the operator was dormant — EXCEPT that a
      // 0 published for a slice that measured nothing was already the false
      // zero A1/S1 is about. Once the slice started emitting null it became
      // actively destructive: a degraded aio slice whose survivors implied 100
      // published 100 before and 0 after, i.e. this line CHANGED a persisted
      // number rather than preserving one. Both readings are wrong; null is the
      // only honest one, and `scans.visibility_pct` is `numeric` and nullable
      // (supabase/migrations/001_initial_schema.sql:12), so nothing ever forced
      // a number here.
      //
      // `??`, not `||`: a measured 0 is a real finding and must survive.
      //
      // R2.4.1 — the top-level visibility_pct is the BLENDED headline index,
      // not the AIO slice alone. Before this, a totally failed second engine
      // raised no top-level flag: the score moved (engines_counted fell) while
      // scans.visibility_pct still read AIO's number. The headline is the
      // weighted mean across every eligible engine; it already excludes
      // degraded/not-assessed slices, so it is the honest top-level number.
      visibility_pct: headline?.visibility_index_pct ?? aioSummary.visibility_pct ?? null,
      share_of_ai_pct: aioSummary.share_of_ai_pct ?? null,
      share_of_voice_pct: scanShareOfVoicePct,
      // ...and WHY there is no number, carried up from the slice so a scan-level
      // reader can render the em dash plus a state chip without re-deriving it
      // from `engines.aio`. Null (not "measured") on a slice written before
      // R2.1.1: isMeasuredEngineSlice tolerates a stateless legacy number, but
      // that tolerance is a read-side reading, not a fact to manufacture here.
      // See ENGINE_MEASUREMENT_STATE / ENGINE_STATE_REASONS for the vocabulary.
      state: aioSummary.state ?? null,
      state_reason: aioSummary.state_reason ?? null,
      // R2.9.7 — nullable at the source now; see aio_coverage_pct above.
      presence_rate_pct: aioSummary.presence_rate_pct ?? null,
      // R2.9.7 — these two are DERIVED here rather than copied, so the empty
      // denominator was fabricated by this function itself. `branded_visibility_pct: 0`
      // for a scan that asked no branded prompts is a claim that the engines
      // never named the brand even when asked about it by name — and it is
      // persisted (scanWorker.js:2114). A brand-presence prompt set that ran
      // and found nothing still yields a real 0 through the helper.
      branded_visibility_pct: ratioPctOrNull(
        aioSummary.visible_branded,
        aioSummary.branded_with_answer
      ),
      mention_rate_pct: ratioPctOrNull(
        aioSummary.mentioned_non_branded,
        aioSummary.non_branded_with_answer
      ),
      // Denominator is the observed-citation pool (see above), not every
      // answered row.
      //
      // R2.2.11 — null, NOT 0, when that pool is empty. The else-branch used to
      // publish 0, and scanWorker.js:2000 writes this straight onto
      // `scans.brand_citation_share_pct`, so a scan whose every citation leg
      // died — denominator 0, every answered row unverified — recorded "0% of
      // your answers cite you" forever. That is a confident finding about
      // something nobody could look at, the exact false-zero class R2 exists to
      // close. summaryToMetricsRow in src/lib/analytics/rollup.js (:347) already
      // returned null for the same shape; this branch sat one `?`/`:` away from
      // code that got it right and disagreed with it.
      //
      // A GENUINE measured 0 is untouched and must stay so: denominator > 0
      // with cited_non_branded 0 still yields the number 0, because "we read
      // every citation list and you were in none of them" is a real result.
      // Only the empty denominator becomes null. The comparison also rejects an
      // absent denominator (undefined > 0 is false) rather than coercing it,
      // matching the Number.isFinite idiom above.
      //
      // THE CONSUMER TRACE, WALKED HOP BY HOP AND OPENED AT EVERY HOP. An
      // earlier revision of this comment claimed "ScoreBreakdown renders it
      // through describeMetricValue" — neither identifier exists anywhere in
      // this repo, and the renderer that does exist was at that moment doing
      // exactly what the comment said was not happening. It is recorded here
      // because a false assurance in a source comment is the failure mode this
      // whole phase is about; do not replace this trace with one you have not
      // executed.
      //
      //   scanWorker.js binds this function as `summarizeMulti` and writes
      //     summary.citation_share_pct onto scans.brand_citation_share_pct
      //     (scanWorker.js:2000, via db.js:214) — a persisted value. NOTE: that
      //     column is not declared in any file under supabase/migrations, so
      //     its nullability is asserted nowhere in this repo and is NOT claimed
      //     here. It is written unconditionally today, and was already written
      //     null for other metrics, so a null is not a new shape for it.
      //   api/scans/_lib/scanRow.js:97 reads it as
      //     `raw.brand_citation_share_pct ?? summary_stats?.citation_share_pct
      //      ?? null` — null preserved. api/scans/[brand]/route.js:49 is the
      //     same shape.
      //   services/api.js's normalizer keeps it through the `?? null` chain at
      //     :383 and exposes it at :553 as `brandCitationSharePct`. It did NOT
      //     always: until R2.2.11 it ended `citationSharePct ?? 0` three lines
      //     before that, which killed this null on every scan. Fixed there in
      //     the same commit; see the comment on that line.
      //   components/dashboard/SourcesView.jsx is where it is SEEN, via
      //     DashboardShell's `view === "sources"`. Its describeCitationShare()
      //     renders a null as an em dash, a "Not measured" chip and the reason
      //     — read off `citation_denominator` / `citations_unverified_count` on
      //     the per-engine slices — and a measured number as that number.
      //     Guarded by sourcesCitationShareSurface.test.mjs, which drives a
      //     null through the real component and fails if a digit appears.
      //
      // `git grep brand_citation_share_pct -- src/ scripts/` enumerates every
      // other reader, and each is a `?? null` passthrough (db.js:214 included).
      // If you add one, it owns the em-dash state too.
      citation_share_pct: citationDenominator > 0
        ? Math.round((aioSummary.cited_non_branded / citationDenominator) * 1000) / 10
        : null,
      citation_denominator: citationDenominator,
      // null, never 0, when the slice predates R2.2.2: "no row was excluded"
      // and "this slice could not tell" are different facts (standing rule 5).
      citations_unverified_count: aioSummary.citations_unverified_count ?? null,
      // R2.2.6: the scan-level flag is every engine's business, not aio's.
      // Reading it off aioSummary alone let a text-only degradation drop the
      // headline from two engines to one with no banner to explain it.
      data_source_issue: scanHealth.dataSourceIssue,
      // R2.4.1 — quality flags become ANY-ENGINE flags. Before this, a
      // perplexity slice that never ran (insufficient_sample true) while AIO
      // scored cleanly left the scan-level flag false. The dashboard showed a
      // score with no banner explaining that one engine was absent.
      insufficient_sample: Object.values(engines || {}).some(
        (s) => s && s.insufficient_sample
      ) || false,
      thresholds: {
        error_rate_limit_pct: AIO_ERROR_RATE_LIMIT_PCT,
        min_non_branded_coverage: AIO_MIN_NON_BRANDED_COVERAGE,
        min_non_branded_with_aio: AIO_MIN_NON_BRANDED_WITH_AIO,
      },
      // --- R05 — the versioned metric contract, on the persisted summary -----
      //
      // NOTHING ABOVE THIS LINE CHANGED MEANING, and that is deliberate. Every
      // legacy column keeps the value it had, because history, trend deltas and
      // the engine chips are pinned to them by tests owned outside this repair.
      // What these fields add is the part that was missing: the qualified
      // headline, the metric DTOs it was read from, and the measurement identity a
      // comparison needs. They ride inside `summary_stats`, which scanWorker
      // spreads onto the persisted record verbatim, so the API, the report and an
      // export all read back the SAME object rather than each re-deriving it.
      metric_contract_version: METRIC_CONTRACT_VERSION,
      headline_metric: headline?.metric ?? null,
      /** The qualified headline. Null below the v1 gates, with `headline_reason`. */
      headline_pct: headline?.headline_pct ?? null,
      headline_state: headline?.headline_state ?? null,
      headline_reason: headline?.headline_reason ?? null,
      headline_qualified: headline?.qualified === true,
      /** The raw exploratory index, named so it cannot be mistaken for the above. */
      exploratory_index_pct: headline?.visibility_index_pct ?? null,
      distinct_eligible_prompts: headline?.distinct_eligible_prompts ?? null,
      valid_collection_pct: headline?.valid_collection_pct ?? null,
      counted_engines: headline?.counted_engines ?? [],
      excluded_engines: headline?.excluded_engines ?? [],
      headline_reweighted: headline?.reweighted === true,
      measurement_context: headline?.context ?? null,
      // The primary slice's metric set — the same DTOs the per-engine surfaces
      // render, so a scan-level reader never has to open `engines` to find them.
      metrics: aioSummary.metrics ?? Object.values(engines || {}).find((s) => s?.metrics)?.metrics ?? null,
    },
    engines,
    headline,
    // The words behind summary.data_source_issue. Recomputable from `engines`
    // by any reader (the dashboard does exactly that for scans stored before
    // this landed), so nothing downstream is required to persist it.
    data_source_status: scanHealth,
  };
}
