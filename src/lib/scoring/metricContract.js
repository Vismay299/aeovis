/**
 * R05 — the versioned metric contract: the ONE place that decides what a
 * reported number is, whether it may be a production headline, and whether two
 * numbers may be compared at all.
 *
 * WHY THIS MODULE EXISTS. Three defects (A02–A04) shared one root cause: a
 * ratio, its eligibility test and its comparison rule were each re-derived at the
 * point of display from whatever counts happened to be nearby.
 *
 *   A02 — thirty answers of which ONE named a vendor produced a 100% headline.
 *         The ratio divided by the one eliciting answer while the eligibility
 *         test counted the thirty answered ones, so `insufficient_sample` sat
 *         beside a published 100%. Two denominators, one number.
 *   A03 — a brand cited in an answer it was never named in was removed by the
 *         eliciting filter, so a real citation-only appearance vanished from the
 *         report instead of moving to the metric it belongs to.
 *   A04 — the same thirty answers scored 20% or 100% depending only on whether a
 *         NEVER-MENTIONED rival happened to sit in the tracked roster, because
 *         the roster decided whether that filter engaged at all.
 *
 * THE RULES THIS FILE ENFORCES, and why each is written down:
 *
 *   1. THE GATE APPLIES TO THE METRIC'S ACTUAL DENOMINATOR. A metric carries the
 *      denominator its own numerator was counted over, the distinct prompt IDs
 *      inside it, and the collection completion of the frozen offered surface.
 *      Qualification reads THOSE. A larger answered pool next to the ratio is
 *      exactly how A02 headlined something the measurement could not support.
 *
 *   2. RAW AND QUALIFIED ARE REPORTED SEPARATELY. `value_pct` is the raw measured
 *      ratio, published even when it is too thin to headline — an exploratory
 *      reading is honest. `qualified_pct` is null below the gates and
 *      `qualified_reason` names which gate failed. Standing rule 1 applied to
 *      eligibility: "we measured 1 of 1" and "we can headline this" are different
 *      statements and must not share one field.
 *
 *   3. AN EMPTY OR UNOBSERVED DENOMINATOR IS NOT A ZERO. `0/0` has no value, and
 *      neither has "nobody could look": both are null plus a reason. A measured
 *      zero — a real denominator whose numerator is zero — stays 0.
 *
 * WHAT THIS FILE DOES NOT DO. It does not know what a probe row is. Row → counts
 * extraction lives in enginePipeline.js (per engine slice) and
 * analytics/rollup.js (the durable daily row); both build their metrics THROUGH
 * this module, so a slice, a scans row and a brand_metrics_daily row cannot
 * disagree about what a value means.
 *
 * SELF METRICS ARE ROSTER-INVARIANT BY CONSTRUCTION. Mention, citation and
 * exposure are counted over the declared eligible panel, so adding or removing a
 * tracked rival cannot move them or their denominators (A04). The conditional
 * metrics — share of voice and the conditional vendor share — are the ones whose
 * denominator is "answers that named a vendor"; they carry `conditional: true`
 * and a `roster_version`, so no surface can print one as a self rate.
 */
import { measuredNumberOrNull, ratioPctOrNull } from "./measuredNumber.js";

/**
 * The version of the metric DTO itself — its field names and their meanings.
 * Two rows written under different metric versions are not the same measurement,
 * so bumping this invalidates comparisons (see checkComparability).
 */
export const METRIC_CONTRACT_VERSION = "r05-metric-v1";

/** Versions of the things a value depends on, carried on every metric. */
export const PANEL_POLICY_VERSION = "panel-policy-v1";
export const SURFACE_POLICY_VERSION = "surface-policy-v1";
export const MODEL_POLICY_VERSION = "model-policy-v1";

/**
 * The v1 release thresholds, as product choices rather than observed abilities.
 * Versioned because they are expected to move, and because a stored qualified
 * headline has to stay readable against the policy that qualified it.
 */
export const ELIGIBILITY_POLICY_V1 = Object.freeze({
  version: "eligibility-policy-v1",
  /** Distinct eligible prompt IDs the metric's OWN denominator must hold. */
  minDistinctEligiblePrompts: 20,
  /** Valid observations / planned observations, for the frozen offered surface. */
  minValidCollection: 0.95,
  /**
   * Replicates measure variation; they are not independent prompts. Off, and
   * written down rather than implied, because allowing them would let one
   * repeated question carry a headline on its own.
   */
  replicatesSatisfyMinimum: false,
});

/** Percentages are rounded to one decimal, always by the same two helpers. */
const PCT_DECIMALS = 1;

/** How far a stored percentage may sit from its own counts before it is a contradiction. */
const COUNT_AGREEMENT_TOLERANCE_PCT = 0.05;

/** Counts in an explicitly-empty branch: "nothing was used" is a measurement of it. */
const NONE_USED = 0;

export const METRIC_UNITS = Object.freeze({
  PERCENT: "percent",
  COUNT: "count",
});

/**
 * The metric identities from the audit's metric table, one token each. An enum
 * because a slice, a stored row and an export that invent near-synonyms
 * ("mention_rate" vs "brand_mention_rate") silently stop being comparable.
 */
export const METRIC_IDS = Object.freeze({
  /** Brand mentioned OR cited, over the declared eligible panel. The headline. */
  EXPOSURE: "observed_exposure",
  /** Brand named in the answer TEXT, over the declared eligible panel. */
  MENTION: "brand_mention",
  /** The brand's own domain found in an OBSERVED citation list. */
  CITATION: "owned_citation",
  /** Positively recommended, over the recommendation-eligible answers. */
  RECOMMENDATION: "positive_recommendation",
  /** Our mentions / all vendor mentions, among answers that named a vendor. */
  CONDITIONAL_VENDOR_SHARE: "conditional_vendor_share",
  /** Our mentions / all tracked-brand appearances, with the roster version recorded. */
  SHARE_OF_VOICE: "share_of_voice",
  /** Valid terminal observations / planned observations. */
  COMPLETION: "collection_completion",
  /** SERPs carrying an AI overview / valid SERPs. */
  TRIGGER: "aio_trigger",
});

/** The four states any metric value can be in. */
export const METRIC_STATES = Object.freeze({
  MEASURED: "measured",
  MEASURED_ZERO: "measured_zero",
  NOT_ASSESSED: "not_assessed",
  /** A real reading below the v1 gates: shown raw, never headlined. */
  INSUFFICIENT: "insufficient",
});

/**
 * WHY a metric has no value, or has one that may not be headlined. Machine tokens;
 * `METRIC_REASON_DETAIL` carries the words for the ones a surface shows.
 */
export const METRIC_REASONS = Object.freeze({
  /** The metric's own denominator is empty. Never a 0/0 coercion. */
  NO_ELIGIBLE_OBSERVATIONS: "no_eligible_observations",
  /** Fewer than `minDistinctEligiblePrompts` distinct prompts in that denominator. */
  INSUFFICIENT_DISTINCT_PROMPTS: "insufficient_distinct_eligible_prompts",
  /** Valid collection under `minValidCollection` for the frozen offered surface. */
  INSUFFICIENT_COLLECTION: "insufficient_valid_collection",
  /** No planned/valid collection pair was supplied, so the gate cannot be met. */
  COLLECTION_UNVERIFIED: "valid_collection_unverified",
  /** Counts that cannot be true of each other (a numerator above its denominator). */
  CONTRADICTORY_COUNTS: "contradictory_counts",
  /** A true zero over a real denominator. */
  BRAND_NOT_VISIBLE: "brand_not_visible",
  /** Citation lists were read in full and named us in none of them. */
  BRAND_NOT_CITED: "brand_not_cited",
  /** No citation list was ever observed, so "uncited" is not sayable. */
  CITATION_TELEMETRY_ABSENT: "citation_telemetry_absent",
  /** No recommendation judgment exists for any eligible answer. */
  NO_RECOMMENDATION_JUDGMENT: "no_recommendation_judgment",
  /** Nobody named a vendor, so there is no share of the mentions to take. */
  ELICITING_POOL_EMPTY: "no_eliciting_answer",
  /** The roster carries no rival, so a share of voice has no denominator but itself. */
  SELF_ONLY_ROSTER: "self_only_roster",
  /** Answer text was never captured (a citation-only answer), so no mention reading. */
  TEXT_NOT_OBSERVED: "answer_text_not_observed",
  /** This answer's citation list was never observed (its leg failed). */
  CITATION_LIST_UNOBSERVED: "citation_list_not_observed",
  /** A retried or re-delivered result for a logical observation already counted. */
  DUPLICATE_INGESTION: "duplicate_ingestion",
  /** The record predates the metric contract, so no gate can be established. */
  LEGACY_RECORD: "legacy_metric_record",
  /** The reading has a qualified value but the comparison is still not a delta. */
  INCOMPARABLE: "incompatible_measurement",
});

export const METRIC_REASON_DETAIL = Object.freeze({
  [METRIC_REASONS.NO_ELIGIBLE_OBSERVATIONS]:
    "No answer in this metric's own denominator was measured, so there is no value — which is not the same as a zero.",
  [METRIC_REASONS.INSUFFICIENT_DISTINCT_PROMPTS]:
    "Too few distinct questions sit behind this number for it to be a headline. The raw count is shown as exploratory only.",
  [METRIC_REASONS.INSUFFICIENT_COLLECTION]:
    "Too few of the planned questions were collected for this number to be a headline.",
  [METRIC_REASONS.COLLECTION_UNVERIFIED]:
    "This record does not carry the planned/valid collection pair the headline gate needs.",
  [METRIC_REASONS.CONTRADICTORY_COUNTS]:
    "This record's counts cannot produce the percentage stored beside them.",
  [METRIC_REASONS.BRAND_NOT_VISIBLE]:
    "Measured: the answers named vendors on every count, and never this brand.",
  [METRIC_REASONS.BRAND_NOT_CITED]:
    "Measured: every citation list in the denominator was read, and none cited this brand.",
  [METRIC_REASONS.CITATION_TELEMETRY_ABSENT]:
    "No citation list was observed for this reading, so it is unknown rather than uncited.",
  [METRIC_REASONS.NO_RECOMMENDATION_JUDGMENT]:
    "No answer in this reading carried a recommendation judgment to count.",
  [METRIC_REASONS.ELICITING_POOL_EMPTY]:
    "None of the answers named any vendor, so there is no share of the mentions to take.",
  [METRIC_REASONS.SELF_ONLY_ROSTER]:
    "No rival was tracked, so a share of the mentions has no denominator that is not the numerator.",
  [METRIC_REASONS.TEXT_NOT_OBSERVED]:
    "This answer carried no text (a citation-only answer), so it cannot be counted as a non-mention.",
  [METRIC_REASONS.CITATION_LIST_UNOBSERVED]:
    "This answer's citation list was never observed, so it is not a confirmed non-citation.",
  [METRIC_REASONS.DUPLICATE_INGESTION]:
    "A repeated delivery of a logical observation that was already counted once.",
  [METRIC_REASONS.LEGACY_RECORD]:
    "This reading predates the metric contract, so its eligibility cannot be established.",
  [METRIC_REASONS.INCOMPARABLE]:
    "These two readings are not the same measurement, so a difference between them is not a delta.",
});

/**
 * WHY two measurements may not be compared. One token per dimension, because the
 * operator action differs: a panel change is a panel decision, a market change is
 * a different population, a model-policy change is a different instrument.
 */
export const COMPARISON_BOUNDARIES = Object.freeze({
  PANEL: "panel_version_changed",
  SURFACE: "surface_version_changed",
  MARKET: "market_changed",
  MODEL_POLICY: "model_policy_changed",
  METRIC_VERSION: "metric_version_changed",
  POLICY: "eligibility_policy_changed",
  ENGINE_COHORT: "engine_cohort_changed",
  CONTEXT_INCOMPLETE: "measurement_context_incomplete",
});

const COMPARISON_DIMENSIONS = [
  ["panel_version", COMPARISON_BOUNDARIES.PANEL],
  ["surface_version", COMPARISON_BOUNDARIES.SURFACE],
  ["market", COMPARISON_BOUNDARIES.MARKET],
  ["model_policy_version", COMPARISON_BOUNDARIES.MODEL_POLICY],
  ["metric_version", COMPARISON_BOUNDARIES.METRIC_VERSION],
  ["policy_version", COMPARISON_BOUNDARIES.POLICY],
  ["engine_cohort", COMPARISON_BOUNDARIES.ENGINE_COHORT],
];

const COMPARISON_BOUNDARY_DETAIL = Object.freeze({
  [COMPARISON_BOUNDARIES.PANEL]:
    "The tracked question panel changed between these two readings, so a difference between them is a change of question set, not a change in visibility.",
  [COMPARISON_BOUNDARIES.SURFACE]:
    "The measured surface changed between these two readings. A model API and a consumer surface are different instruments.",
  [COMPARISON_BOUNDARIES.MARKET]:
    "The market or location changed between these two readings, so they do not sample the same population.",
  [COMPARISON_BOUNDARIES.MODEL_POLICY]:
    "The model or collection policy changed between these two readings, so they are different instruments.",
  [COMPARISON_BOUNDARIES.METRIC_VERSION]:
    "The metric definition changed between these two readings, so the two numbers do not mean the same thing.",
  [COMPARISON_BOUNDARIES.POLICY]:
    "The eligibility policy changed between these two readings, so the two qualification states are not the same test.",
  [COMPARISON_BOUNDARIES.ENGINE_COHORT]:
    "The counted engine cohort changed between these two readings. A reweighted blend is a different index, not a movement in this one.",
  [COMPARISON_BOUNDARIES.CONTEXT_INCOMPLETE]:
    "One of these two readings does not carry the measurement identity a comparison would need.",
});

export function describeComparisonBoundary(reason) {
  return (
    COMPARISON_BOUNDARY_DETAIL[reason] ??
    COMPARISON_BOUNDARY_DETAIL[COMPARISON_BOUNDARIES.CONTEXT_INCOMPLETE]
  );
}

// ---------------------------------------------------------------------------
// Measurement identity
// ---------------------------------------------------------------------------

/**
 * The identity of a metric's measurement context: everything a consumer needs in
 * order to know whether a number may be put beside another one, and nothing that
 * varies within one scan. No clock reads — the scoring path must stay
 * deterministic so a replayed scan reproduces the same metric byte for byte.
 */
export function measurementContext({
  panelVersion = PANEL_POLICY_VERSION,
  surfaceVersion = SURFACE_POLICY_VERSION,
  market = null,
  modelPolicyVersion = MODEL_POLICY_VERSION,
  metricVersion = METRIC_CONTRACT_VERSION,
  policyVersion = ELIGIBILITY_POLICY_V1.version,
  rosterVersion = null,
  engineCohort = null,
  window = null,
} = {}) {
  return {
    panel_version: panelVersion,
    surface_version: surfaceVersion,
    market,
    model_policy_version: modelPolicyVersion,
    metric_version: metricVersion,
    policy_version: policyVersion,
    /**
     * The tracked-rival roster this reading was judged against: part of the
     * measurement for the conditional metrics, and null for the self metrics,
     * which are counted over the declared panel and therefore cannot depend on it
     * (A04).
     */
    roster_version: rosterVersion,
    /** The engines a blended index was actually counted over. */
    engine_cohort: normalizeEngineCohort(engineCohort),
    /** The collection window, when the caller has one. */
    window,
  };
}

/**
 * Sorted, de-duplicated, joined — so an unchanged cohort compares equal.
 *
 * Accepts the array a producer has in hand AND the string a persisted context
 * carries: comparing a context against itself must not read its own cohort as
 * "absent", which is the shape that would make every comparison refuse for a
 * reason that has nothing to do with the measurement.
 */
export function normalizeEngineCohort(cohort) {
  const names = (Array.isArray(cohort) ? cohort : String(cohort ?? "").split(","))
    .map((n) => String(n ?? "").trim())
    .filter(Boolean);
  return names.length === 0 ? null : Array.from(new Set(names)).sort().join(",");
}

// ---------------------------------------------------------------------------
// Observation identity and counting
// ---------------------------------------------------------------------------

/**
 * The logical observation key (v1 policy): a repeated delivery of one
 * observation is one observation, however many attempts produced it. Attempts are
 * children of this key, never additions to its denominator.
 */
export function logicalObservationKey(parts = {}) {
  return [
    parts.workspaceId ?? parts.workspace ?? "",
    parts.promptId ?? parts.prompt ?? "",
    parts.panelVersion ?? "",
    parts.surface ?? "",
    parts.market ?? "",
    parts.language ?? "",
    parts.device ?? "",
    parts.sessionPolicy ?? "",
    parts.scheduledTime ?? "",
    parts.replicate ?? "1",
    parts.purpose ?? "scoring",
  ].join("\u0001");
}

/**
 * Collapse a batch of ingestions to one entry per logical observation.
 *
 * An observation carrying no key at all is kept as its own entry: dropping it
 * would silently shrink a denominator, and inventing a shared key would merge two
 * different measurements. The unkeyed rows are reported so a surface can say they
 * exist rather than pretend every row carried an identity.
 */
export function dedupeObservations(observations = [], { keyOf = (o) => o?.key } = {}) {
  const unique = [];
  const seen = new Set();
  let duplicates = 0;
  let unkeyed = 0;
  for (const observation of observations || []) {
    if (!observation) continue;
    const key = keyOf(observation);
    if (key === null || key === undefined || key === "") {
      unkeyed += 1;
      unique.push(observation);
      continue;
    }
    const id = String(key);
    if (seen.has(id)) {
      duplicates += 1;
      continue;
    }
    seen.add(id);
    unique.push(observation);
  }
  return { unique, duplicates, unkeyed, keys: Array.from(seen) };
}

/**
 * The counting half of the contract: what a metric's ACTUAL denominator is, which
 * distinct prompt IDs sit inside it, and how many entries are replicates.
 *
 * An observation is `{ key, promptId, replicate, value, exclusion }`. A `value` of
 * `true` counts numerator and denominator, `false` counts the denominator only,
 * and `null` counts NEITHER — it is an observation this metric could not take (no
 * text captured, no citation list observed). It is recorded as an exclusion with
 * its own reason, so a shrunken denominator is auditable rather than mysterious.
 */
export function reduceObservations(
  observations = [],
  { keyOf, promptIdOf, replicateOf, valueOf, policy = ELIGIBILITY_POLICY_V1 } = {}
) {
  const { unique, duplicates, unkeyed } = dedupeObservations(observations, {
    keyOf: keyOf ?? ((o) => o?.key),
  });

  const promptIds = new Set();
  const replicatePromptIds = new Set();
  const exclusionCounts = new Map();
  let numerator = 0;
  let denominator = 0;
  let replicateObservations = 0;

  for (const observation of unique) {
    const value = valueOf ? valueOf(observation) : observation?.value;
    const promptId = promptIdOf ? promptIdOf(observation) : observation?.promptId;
    const replicate = replicateOf ? replicateOf(observation) : observation?.replicate;

    if (value === null || value === undefined) {
      const reason = observation?.exclusion ?? METRIC_REASONS.TEXT_NOT_OBSERVED;
      const prior = measuredNumberOrNull(exclusionCounts.get(reason));
      exclusionCounts.set(reason, prior === null ? 1 : prior + 1);
      continue;
    }

    denominator += 1;
    if (value) numerator += 1;

    const id = promptId === null || promptId === undefined ? null : String(promptId);
    const replicateIndex = measuredNumberOrNull(replicate);
    const isReplicate = replicateIndex !== null && replicateIndex > 1;
    if (isReplicate) {
      replicateObservations += 1;
      if (id !== null) replicatePromptIds.add(id);
    } else if (id !== null) {
      promptIds.add(id);
    }
  }

  const exclusions = Array.from(exclusionCounts.entries()).map(([reason, count]) => ({
    reason,
    count,
  }));

  return {
    numerator,
    denominator,
    duplicates,
    unkeyed,
    replicateObservations,
    /**
     * Distinct prompts in the denominator. Replicates are not members unless the
     * policy says so — that is the whole of "replicates never satisfy the
     * distinct-prompt minimum".
     */
    eligiblePromptIds: policy.replicatesSatisfyMinimum
      ? Array.from(new Set([...promptIds, ...replicatePromptIds]))
      : Array.from(promptIds),
    replicatePromptIds: Array.from(replicatePromptIds),
    exclusions,
  };
}

// ---------------------------------------------------------------------------
// The metric DTO
// ---------------------------------------------------------------------------

/**
 * Build one metric DTO. Both counts must be the pair the reading was actually
 * counted over, and `eligiblePromptIds` the prompt IDs INSIDE that denominator —
 * not the wider panel beside it. That distinction is A02.
 */
export function createMetric({
  metricId,
  unit = METRIC_UNITS.PERCENT,
  numerator = null,
  denominator = null,
  eligiblePromptIds = [],
  replicateObservations = null,
  duplicateObservations = null,
  unkeyedObservations = null,
  exclusions = [],
  unknownReason = null,
  zeroReason = METRIC_REASONS.BRAND_NOT_VISIBLE,
  conditional = false,
  collection = null,
  context = measurementContext(),
  policy = ELIGIBILITY_POLICY_V1,
}) {
  const num = isCount(numerator);
  const den = isCount(denominator);
  const promptIds = Array.from(new Set((eligiblePromptIds || []).map(String)));
  const distinctEligiblePrompts = promptIds.length;
  const collectionCounts = collectionCountsOf(collection);

  const contradictions = findMetricContradictions({ numerator: num, denominator: den });
  const contradictory = contradictions.some((c) => c.code === "numerator_exceeds_denominator");

  const valuePct = contradictory ? null : ratioPctOrNull(num, den, { decimals: PCT_DECIMALS });
  const { state, reason } = describeRawState({
    valuePct,
    unknownReason,
    zeroReason,
    contradictory,
  });

  const qualification = qualificationOf({
    valuePct,
    state,
    reason,
    distinctEligiblePrompts,
    validCollectionRatio: collectionCounts.ratio,
    policy,
  });

  return {
    metric_id: metricId,
    unit,
    numerator: num,
    denominator: den,
    /** The raw measured ratio — published even when it may not be headlined. */
    value_pct: valuePct,
    state,
    reason,
    /** The value a production headline may publish: null below either gate. */
    qualified: qualification.qualified,
    qualified_pct: qualification.value_pct,
    qualified_state: qualification.state,
    qualified_reason: qualification.reason,
    distinct_eligible_prompts: distinctEligiblePrompts,
    eligible_prompt_ids: promptIds,
    replicate_observations: isCount(replicateObservations),
    duplicate_observations: isCount(duplicateObservations),
    unkeyed_observations: isCount(unkeyedObservations),
    /**
     * True for a metric whose denominator is "answers that named a vendor" or
     * "the tracked roster". Such a value is a distribution among those answers
     * and may never be printed as a self rate.
     */
    conditional,
    exclusions,
    exclusion_reason: exclusions.length > 0 ? exclusions[0].reason : null,
    /** Set when the reading has no value at all, so a null is never bare. */
    unknown_reason: valuePct === null ? reason : null,
    collection: collectionCounts.collection,
    valid_collection_pct: collectionCounts.pct,
    /** Counts that cannot be true of each other, kept rather than resolved. */
    contradictions,
    policy: {
      version: policy.version,
      min_distinct_eligible_prompts: policy.minDistinctEligiblePrompts,
      min_valid_collection: policy.minValidCollection,
      replicates_satisfy_minimum: policy.replicatesSatisfyMinimum,
    },
    context,
  };
}

/** A finite, non-negative count — or null. Never a coercion of an absent count. */
function isCount(value) {
  const n = measuredNumberOrNull(value);
  return n === null || n < 0 ? null : n;
}

function describeRawState({ valuePct, unknownReason, zeroReason, contradictory }) {
  if (contradictory) {
    return { state: METRIC_STATES.NOT_ASSESSED, reason: METRIC_REASONS.CONTRADICTORY_COUNTS };
  }
  if (valuePct === null) {
    // "Name the first thing that was missing": an unobserved measurement (the
    // citation leg never returned) is a different statement from an empty
    // denominator, and it is named first because it is the one that can be fixed
    // by collecting again.
    if (unknownReason) return { state: METRIC_STATES.NOT_ASSESSED, reason: unknownReason };
    return { state: METRIC_STATES.NOT_ASSESSED, reason: METRIC_REASONS.NO_ELIGIBLE_OBSERVATIONS };
  }
  return valuePct === 0
    ? { state: METRIC_STATES.MEASURED_ZERO, reason: zeroReason }
    : { state: METRIC_STATES.MEASURED, reason: null };
}

/** Valid/planned → the completion of the frozen offered surface, or null. */
export function collectionCountsOf(collection) {
  const valid = isCount(collection?.valid);
  const planned = isCount(collection?.planned);
  if (valid === null || planned === null || planned === 0) {
    return { collection: null, ratio: null, pct: null };
  }
  return {
    collection: { valid, planned },
    ratio: valid / planned,
    pct: ratioPctOrNull(valid, planned, { decimals: PCT_DECIMALS }),
  };
}

/**
 * THE GATE. Applied to the metric's own denominator, in one function, for every
 * metric — so a slice, a scans row and a daily rollup row cannot qualify the same
 * reading differently.
 *
 * Ordering is deliberate: a reading with no value at all is NOT_ASSESSED, not
 * INSUFFICIENT. "We could not measure" and "we measured something too thin to
 * headline" send the operator to different places.
 */
export function qualificationOf({
  valuePct,
  state,
  reason,
  distinctEligiblePrompts,
  validCollectionRatio,
  policy = ELIGIBILITY_POLICY_V1,
}) {
  if (valuePct === null) {
    return {
      qualified: false,
      value_pct: null,
      state,
      reason: reason ?? METRIC_REASONS.NO_ELIGIBLE_OBSERVATIONS,
    };
  }
  const distinct = isCount(distinctEligiblePrompts);
  if (distinct === null || distinct < policy.minDistinctEligiblePrompts) {
    return {
      qualified: false,
      value_pct: null,
      state: METRIC_STATES.INSUFFICIENT,
      reason: METRIC_REASONS.INSUFFICIENT_DISTINCT_PROMPTS,
    };
  }
  if (validCollectionRatio === null) {
    return {
      qualified: false,
      value_pct: null,
      state: METRIC_STATES.INSUFFICIENT,
      reason: METRIC_REASONS.COLLECTION_UNVERIFIED,
    };
  }
  if (validCollectionRatio < policy.minValidCollection) {
    return {
      qualified: false,
      value_pct: null,
      state: METRIC_STATES.INSUFFICIENT,
      reason: METRIC_REASONS.INSUFFICIENT_COLLECTION,
    };
  }
  return { qualified: true, value_pct: valuePct, state, reason };
}

/**
 * Re-qualify a stored metric DTO under a given policy. A consumer reading a value
 * written under an older policy needs to know whether it may be headlined NOW,
 * without recomputing counts it may no longer be able to see.
 */
export function qualifyMetric(metric, { policy = ELIGIBILITY_POLICY_V1 } = {}) {
  const { ratio } = collectionCountsOf(metric?.collection);
  return qualificationOf({
    valuePct: measuredNumberOrNull(metric?.value_pct),
    state: metric?.state ?? METRIC_STATES.NOT_ASSESSED,
    reason: metric?.reason ?? null,
    distinctEligiblePrompts: measuredNumberOrNull(metric?.distinct_eligible_prompts),
    validCollectionRatio: ratio,
    policy,
  });
}

// ---------------------------------------------------------------------------
// Contradiction detection
// ---------------------------------------------------------------------------

/**
 * Counts and a percentage that cannot both be true.
 *
 * The flattering direction of such a contradiction is the one a display picks if
 * nobody checks, so this reports it rather than resolving it — see
 * reconcileDisplayedMetric for the display-side rule.
 */
export function findMetricContradictions({
  numerator,
  denominator,
  value_pct: claimedPct,
  unit = METRIC_UNITS.PERCENT,
}) {
  const contradictions = [];
  const num = isCount(numerator);
  const den = isCount(denominator);
  const claimed = measuredNumberOrNull(claimedPct);

  if (num !== null && den !== null && num > den) {
    contradictions.push({
      code: "numerator_exceeds_denominator",
      detail: `${num} counted observations over a denominator of ${den} is not a ratio that can exist.`,
    });
  }
  if (den !== null && den === 0 && claimed !== null) {
    contradictions.push({
      code: "value_over_empty_denominator",
      detail: `A percentage of ${claimed} is stored over an empty denominator, so nothing was divided.`,
    });
  }
  if (unit === METRIC_UNITS.PERCENT && claimed !== null && (claimed < 0 || claimed > 100)) {
    contradictions.push({
      code: "value_out_of_bounds",
      detail: `A percentage of ${claimed} is outside 0-100.`,
    });
  }
  if (num !== null && den !== null && den > 0) {
    const derived = ratioPctOrNull(num, den, { decimals: PCT_DECIMALS });
    if (derived !== null && claimed !== null && Math.abs(derived - claimed) > COUNT_AGREEMENT_TOLERANCE_PCT) {
      contradictions.push({
        code: "value_disagrees_with_counts",
        detail: `The stored percentage ${claimed} is not what its own counts produce (${derived}).`,
      });
    }
  }
  return contradictions;
}

/** `{ valid, contradictions }` for a stored reading, without changing it. */
export function validateMetric(metric) {
  const stored = Array.isArray(metric?.contradictions) ? metric.contradictions : [];
  const contradictions = stored.length > 0
    ? stored.slice()
    : findMetricContradictions({
        numerator: metric?.numerator,
        denominator: metric?.denominator,
        value_pct: metric?.value_pct,
        unit: metric?.unit,
      });
  if (metric?.qualified === true && measuredNumberOrNull(metric?.qualified_pct) === null) {
    contradictions.push({
      code: "qualified_without_value",
      detail: "The reading claims a qualified value and stores none.",
    });
  }
  if (metric?.state === METRIC_STATES.MEASURED && measuredNumberOrNull(metric?.value_pct) === null) {
    contradictions.push({
      code: "measured_without_value",
      detail: "The reading claims a measurement and stores no number.",
    });
  }
  return { valid: contradictions.length === 0, contradictions };
}

/**
 * What a display may print for a stored reading: the counts always win over a
 * percentage they contradict, and the disagreement is reported rather than
 * silently resolved. `value_source` says which of the two was used, so a surface
 * cannot claim it recomputed a number it actually copied.
 */
export function reconcileDisplayedMetric({ numerator, denominator, value_pct: claimedPct }) {
  const contradictions = findMetricContradictions({
    numerator,
    denominator,
    value_pct: claimedPct,
  });
  const countsDerived = ratioPctOrNull(numerator, denominator, { decimals: PCT_DECIMALS });
  const claimed = measuredNumberOrNull(claimedPct);
  const flagged = contradictions.length > 0;
  return {
    flagged,
    contradictions,
    displayed_pct: flagged ? countsDerived : claimed ?? countsDerived,
    value_source: flagged ? "counts" : "stored",
  };
}

// ---------------------------------------------------------------------------
// Uncertainty
// ---------------------------------------------------------------------------

/**
 * The uncertainty method, named and versioned because a confidence interval
 * without its method is not reproducible. Prompt clustering is the default
 * because related questions are correlated: the resampling unit must be the
 * QUESTION, not the answer, or thirty paraphrases of one question read as thirty
 * independent observations of a market.
 */
export const UNCERTAINTY_METHODS = Object.freeze({
  PROMPT_CLUSTER_BOOTSTRAP: "prompt_cluster_bootstrap",
});

/** Seeded PRNG (mulberry32): the same seed must reproduce the same interval. */
function seededRandom(seed) {
  let a = (Number.isFinite(seed) ? seed : 1) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function percentileOf(sorted, p) {
  if (sorted.length === 0) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))));
  return sorted[index];
}

function meanOf(values) {
  if (values.length === 0) return null;
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}

function toPct(value) {
  const n = measuredNumberOrNull(value);
  if (n === null) return null;
  const factor = 10 ** PCT_DECIMALS;
  return Math.round(n * 100 * factor) / factor;
}

/**
 * A 95% interval for a rate whose observations are clustered by prompt.
 *
 * Observations inside one cluster are averaged FIRST, so a question repeated five
 * times contributes one value with one cluster's weight instead of five
 * independent samples; the bootstrap then resamples clusters. `effective_sample`
 * is the cluster count — the honest answer to "how many independent questions
 * does this stand on" — and it is deliberately not the observation count.
 */
export function estimateUncertainty(
  observations = [],
  {
    method = UNCERTAINTY_METHODS.PROMPT_CLUSTER_BOOTSTRAP,
    seed = 1,
    resamples = 2000,
    clusterOf = (o) => o?.promptId ?? o?.cluster ?? null,
  } = {}
) {
  const clusters = new Map();
  let used = 0;
  let positives = 0;
  let replicateObservations = 0;

  for (const observation of observations || []) {
    if (!observation) continue;
    const value = observation.value;
    if (value === null || value === undefined) continue;
    const replicateIndex = measuredNumberOrNull(observation.replicate);
    if (replicateIndex !== null && replicateIndex > 1) replicateObservations += 1;
    const id = String(clusterOf(observation) ?? "");
    const bucket = clusters.get(id) ?? { sum: 0, n: 0 };
    bucket.sum += value ? 1 : 0;
    bucket.n += 1;
    clusters.set(id, bucket);
    used += 1;
    if (value) positives += 1;
  }

  const clusterMeans = Array.from(clusters.values()).map((b) => b.sum / b.n);
  const clusterCount = clusterMeans.length;

  if (clusterCount === 0) {
    // Nothing to resample. Every rate is null rather than 0: no cluster produced
    // a reading, which is not the same as a reading that came out zero.
    return {
      method,
      seed,
      resamples: NONE_USED,
      clusters: NONE_USED,
      observations: NONE_USED,
      replicate_observations: NONE_USED,
      effective_sample: NONE_USED,
      observation_rate_pct: null,
      cluster_rate_pct: null,
      ci_low_pct: null,
      ci_high_pct: null,
    };
  }

  const random = seededRandom(seed);
  const draws = [];
  for (let i = 0; i < resamples; i++) {
    let sum = 0;
    for (let j = 0; j < clusterCount; j++) {
      sum += clusterMeans[Math.floor(random() * clusterCount)];
    }
    draws.push(sum / clusterCount);
  }
  draws.sort((a, b) => a - b);

  return {
    method,
    seed,
    resamples,
    clusters: clusterCount,
    observations: used,
    replicate_observations: replicateObservations,
    /** The resampling unit: independent questions, not deliveries. */
    effective_sample: clusterCount,
    observation_rate_pct: ratioPctOrNull(positives, used, { decimals: PCT_DECIMALS }),
    cluster_rate_pct: toPct(meanOf(clusterMeans)),
    ci_low_pct: toPct(percentileOf(draws, 0.025)),
    ci_high_pct: toPct(percentileOf(draws, 0.975)),
  };
}

// ---------------------------------------------------------------------------
// Comparability
// ---------------------------------------------------------------------------

function dimensionValue(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text === "" ? null : text;
}

/**
 * May a delta be computed between these two contexts at all?
 *
 * Defaults to REFUSING: not only when a dimension differs, but also when either
 * reading does not carry one, because a comparison nobody can verify is exactly
 * the "silently reweighted historical headline" this exists to stop. An engine
 * cohort that changed is its own boundary — a blend renormalized over fewer
 * engines is a different index, not a movement in this one.
 */
export function checkComparability(left, right) {
  const changed = [];
  const a = left?.context ?? left ?? {};
  const b = right?.context ?? right ?? {};

  for (const [field, reason] of COMPARISON_DIMENSIONS) {
    const leftValue = dimensionValue(
      field === "engine_cohort" ? normalizeEngineCohort(a[field]) : a[field]
    );
    const rightValue = dimensionValue(
      field === "engine_cohort" ? normalizeEngineCohort(b[field]) : b[field]
    );
    if (leftValue === null || rightValue === null) {
      changed.push({ dimension: field, reason: COMPARISON_BOUNDARIES.CONTEXT_INCOMPLETE });
      continue;
    }
    if (leftValue !== rightValue) {
      changed.push({ dimension: field, reason, left: leftValue, right: rightValue });
    }
  }

  if (changed.length === 0) {
    return { comparable: true, boundary_reason: null, detail: null, changed: [] };
  }
  const boundaryReason =
    changed.find((c) => c.reason !== COMPARISON_BOUNDARIES.CONTEXT_INCOMPLETE)?.reason ??
    COMPARISON_BOUNDARIES.CONTEXT_INCOMPLETE;
  return {
    comparable: false,
    boundary_reason: boundaryReason,
    detail: describeComparisonBoundary(boundaryReason),
    changed,
  };
}

/**
 * The delta between two qualified values — or the boundary that suppresses it.
 *
 * An unqualified reading produces NO delta even when both sides are comparable:
 * subtracting a raw exploratory ratio from a headlined one is how a thin sample
 * becomes a movement, and the refusal carries its reason.
 */
export function compareMetrics(left, right) {
  const comparability = checkComparability(left, right);
  if (!comparability.comparable) {
    return { comparable: false, delta_pct: null, ...comparability };
  }
  const leftPct = measuredNumberOrNull(left?.qualified_pct);
  const rightPct = measuredNumberOrNull(right?.qualified_pct);
  if (leftPct === null || rightPct === null) {
    return {
      comparable: false,
      delta_pct: null,
      boundary_reason: METRIC_REASONS.INCOMPARABLE,
      detail: METRIC_REASON_DETAIL[METRIC_REASONS.INCOMPARABLE],
      changed: [],
    };
  }
  const factor = 10 ** PCT_DECIMALS;
  return {
    comparable: true,
    boundary_reason: null,
    detail: null,
    changed: [],
    delta_pct: Math.round((leftPct - rightPct) * factor) / factor,
  };
}
