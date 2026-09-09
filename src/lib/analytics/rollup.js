/**
 * Single source of truth for `brand_metrics_daily` rollup math.
 *
 * Both the live scan pipeline (src/lib/workers/scanWorker.js, inside
 * runFinalizePhase) and the historical backfill (scripts/backfill-analytics.mjs)
 * import EVERY function in this module rather than keeping their own copies.
 * Before this module existed the two files hand-duplicated this logic; two
 * hand-kept copies WILL drift, and live-vs-backfilled brand_metrics_daily rows
 * silently diverging is exactly the failure mode this file exists to prevent
 * (plan.md P0.2 adversarial review, FIX B).
 *
 * IST bucketing (toDateOnly / IST_OFFSET_MS) in particular MUST stay identical
 * between the two call sites: a scan finalized at (say) 00:30 IST has to land
 * in the same `brand_metrics_daily.date` bucket whether it was scored live or
 * reconstructed later by the backfill from `scans.raw_results` — a mismatch
 * here would silently split what should be one day's data across two rows.
 */

import { ENGINE_MEASUREMENT_STATE, ENGINE_STATE_REASONS } from "../scoring/enginePipeline.js";

/**
 * R4.3.2 — the WHY behind a null (or a zero) `sov_pct`, in the frozen
 * vocabulary R2.1.1 established. This is deliberately NOT a third state enum:
 * the states are `ENGINE_MEASUREMENT_STATE` verbatim (the same four tokens
 * `SHARE_STATE` in src/components/perceev/charts/shareOfVoice.js renders), and
 * the reasons are `ENGINE_STATE_REASONS` verbatim plus exactly one this
 * producer can reach and computeEngineSummary cannot name.
 *
 * SELF_ONLY_ROSTER is that one. computeEngineSummary handles the same
 * condition with a bare `!hasRivalRoster -> null` and no token, so there is no
 * existing string to reuse; adding it here rather than there keeps the reason
 * reachable-by-construction (enginePipeline's own test asserts every reason it
 * declares is reached by a slice in that file).
 *
 * Which reason goes with which state, for the rollup:
 *   NO_RESULTS           -> not_assessed. No judgment rows for this slice at
 *                           all (the backfill's contract: raw_results predates
 *                           P1.2 and carries no per-brand data).
 *   SELF_ONLY_ROSTER     -> not_assessed. Rows exist, but every tracked brand
 *                           in them IS US. See computeBrandRollups.
 *   EMPTY_ELICITING_POOL -> not_assessed. A rival roster existed and NOBODY —
 *                           self or rival — was mentioned. Empty denominator.
 *   BRAND_NOT_VISIBLE    -> measured_zero. Rivals were named, we never were.
 *                           sov_pct is a real 0.
 *   (null)               -> measured. sov_pct is a real number.
 */
export const SOV_STATE_REASONS = Object.freeze({
  ...ENGINE_STATE_REASONS,
  /**
   * The tracked-brand roster carried no non-self brand, so "share of the
   * mentions" has no denominator that is not the numerator. Not 0, not 100 —
   * undefined.
   */
  SELF_ONLY_ROSTER: "self_only_roster",
});

// India-first product (SERP_GEO defaults to 'in'): bucket brand_metrics_daily
// rows by IST calendar day, not UTC, so a 00:00-05:30 IST scan doesn't fall
// on the previous UTC day's bucket, and two same-IST-day scans don't split
// across buckets.
export const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/** IST calendar-day bucketing. Returns null for an unparseable timestamp. */
export function toDateOnly(ts) {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return null;
  return new Date(d.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/**
 * Distinct-prompt (union-across-engines) counts for the blended 'all' row.
 * Every engine probes the SAME non-branded prompt set, so the 'all' row's
 * prompt counts must represent that set ONCE — a prompt answered on >=1
 * engine counts once — never the per-(prompt x engine) sum (which would
 * report N x engines and never reconcile with the per-prompt
 * visibility_index_pct). Operates directly on persisted `prompt_results` rows
 * (query/answered/mentioned/is_branded_query columns), not raw probe
 * objects. Returns null when there are no non-branded rows at all.
 */
export function unionPromptCounts(promptResultRows) {
  const nb = (promptResultRows || []).filter((r) => !r.is_branded_query);
  if (nb.length === 0) return null;
  const norm = (q) => String(q || "").toLowerCase().trim();
  const total = new Set(nb.map((r) => norm(r.query)));
  const answered = new Set(nb.filter((r) => r.answered).map((r) => norm(r.query)));
  const mentioned = new Set(nb.filter((r) => r.mentioned).map((r) => norm(r.query)));
  return { total: total.size, answered: answered.size, mentioned: mentioned.size };
}

/**
 * P1.2/P1.3 rollup math — sov_pct / sentiment_avg / position_avg — computed
 * from per-(result,brand) judgment rows (self + every tracked rival,
 * attached by enginePipeline.js's judgeBrandsSymmetric at probe time and
 * exploded into a flat rollup-ready array by runFinalizePhase), scoped to
 * the SAME non-branded pool visibility_pct itself is computed over
 * (`is_branded_query` on each row, mirroring unionPromptCounts above).
 *
 * Each row is `{ engine, is_branded_query, name, is_self, mentioned,
 * position, sentiment }` — one row per (answer, tracked brand). Formulas:
 *
 *   sov_pct        = self mentions / ALL tracked-brand mentions (self + rivals)
 *   sentiment_avg  = mean of the self brand's non-null sentiment values
 *   position_avg   = mean of the self brand's non-null position values
 *
 * R4.3.2 — SOV IS UNDEFINED WITHOUT RIVALS, AND THIS FUNCTION USED TO SAY 100.
 *
 * The formula above only means anything when the roster contains somebody who
 * is not us. With a self-only roster every tracked-brand mention is a self
 * mention by construction, so `selfMentionedCount === allMentionedCount` and
 * the ratio is exactly 1 — a stored, durable, exportable "100% share of voice"
 * for a brand that was measured against nobody. That is not a measurement, it
 * is a tautology, and it is the common case rather than an edge one: the
 * probe-time roster is `[self]` alone whenever no competitor was user-supplied
 * (see the finalize-time roster comment in scanWorker.js), and the finalize
 * roster is `[self]` alone again whenever competitor extraction returns
 * nothing OR is offline.
 *
 * computeEngineSummary (src/lib/scoring/enginePipeline.js) already refuses this
 * number — `!hasRivalRoster -> share_of_voice_pct = null` — and R2.7.1 made the
 * dashboard donut refuse to render one. This producer feeds a DIFFERENT
 * surface (brand_metrics_daily and GET /api/brands/[brand]/metrics), so
 * neither fix reached it and the two disagreed: the dashboard said "not
 * available", the stored daily row said 100. The stored one is the worse lie —
 * it is durable, and it is what a trend chart and any exported report read.
 *
 * So `sov_pct` is now null in that state, and `sov_state`/`sov_state_reason`
 * say WHICH state it is, in the R2.1.1 vocabulary (see SOV_STATE_REASONS).
 * Crucially this preserves the distinction the scoring path already makes: a
 * roster WITH rivals in which we were never mentioned is `measured_zero` with
 * `sov_pct: 0` — a real, actionable measurement — and stays visibly different
 * from `not_assessed`, where there is no number at all.
 *
 * Ordering note (mirroring resolveEngineMeasurementState): the roster check
 * runs BEFORE the empty-denominator check, so the reason names the first thing
 * that was missing. A self-only roster in which nobody was mentioned is a
 * roster problem, not a prompt-set problem, and sending the operator to rewrite
 * their prompts would be the wrong instruction.
 *
 * `engine` scopes to one engine's rows (per-engine brand_metrics_daily
 * rows); pass null/omit for the blended 'all' row, which blends every
 * engine's rows together in one pool (matching how the 'all' row's other
 * fields blend across engines).
 *
 * Historical-safe: `brandJudgmentRows` is `[]`/undefined for backfilled
 * scans (raw_results predates P1.2 and carries no per-brand data) — all
 * three values come back null, the same "no source yet" contract
 * summaryToMetricsRow already falls back to when `brandRollup` is omitted.
 */
export function computeBrandRollups(brandJudgmentRows, { engine = null } = {}) {
  const rows = (brandJudgmentRows || []).filter(
    (r) => !r.is_branded_query && (engine == null || r.engine === engine)
  );
  if (rows.length === 0) {
    return {
      sov_pct: null,
      sov_state: ENGINE_MEASUREMENT_STATE.NOT_ASSESSED,
      sov_state_reason: SOV_STATE_REASONS.NO_RESULTS,
      sentiment_avg: null,
      position_avg: null,
    };
  }

  const selfRows = rows.filter((r) => r.is_self);
  const allMentionedCount = rows.filter((r) => r.mentioned).length;
  const selfMentionedCount = selfRows.filter((r) => r.mentioned).length;

  // A rival is any tracked brand in this slice that is not us. Judged on the
  // roster (every judged row), NOT on who happened to be mentioned: a rival
  // that was tracked and never named is a real denominator contribution of 0,
  // which is what makes a 100 honest. A roster with nobody but us is what
  // makes it a tautology.
  const hasRivalRoster = rows.some((r) => !r.is_self);

  let sov_pct = null;
  let sov_state = ENGINE_MEASUREMENT_STATE.NOT_ASSESSED;
  let sov_state_reason = null;
  if (!hasRivalRoster) {
    sov_state_reason = SOV_STATE_REASONS.SELF_ONLY_ROSTER;
  } else if (allMentionedCount === 0) {
    sov_state_reason = SOV_STATE_REASONS.EMPTY_ELICITING_POOL;
  } else if (selfMentionedCount === 0) {
    // Rivals were named on every count and we never were. That is a real
    // measurement and its value is 0 — never null, never rounded away.
    sov_pct = 0;
    sov_state = ENGINE_MEASUREMENT_STATE.MEASURED_ZERO;
    sov_state_reason = SOV_STATE_REASONS.BRAND_NOT_VISIBLE;
  } else {
    sov_pct = Math.round((selfMentionedCount / allMentionedCount) * 1000) / 10;
    sov_state = ENGINE_MEASUREMENT_STATE.MEASURED;
  }

  const selfSentiments = selfRows.filter((r) => r.sentiment != null).map((r) => r.sentiment);
  const sentiment_avg =
    selfSentiments.length > 0
      ? Math.round((selfSentiments.reduce((a, b) => a + b, 0) / selfSentiments.length) * 10) / 10
      : null;

  const selfPositions = selfRows.filter((r) => r.position != null).map((r) => r.position);
  const position_avg =
    selfPositions.length > 0
      ? Math.round((selfPositions.reduce((a, b) => a + b, 0) / selfPositions.length) * 10) / 10
      : null;

  return { sov_pct, sov_state, sov_state_reason, sentiment_avg, position_avg };
}

/**
 * R4.3.2 — `{ sov_state, sov_state_reason }` for a brandRollup, coping with the
 * two callers that do not carry one.
 *
 *   - `brandRollup` OMITTED ENTIRELY (scripts/backfill-analytics.mjs: historical
 *     raw_results predate P1.2 and hold no per-brand data). That is not
 *     "measured nothing", it is "never ran" — not_assessed / no_results. It is
 *     never an ABSENT state, because an absent state is the empty-looks-clean
 *     hole this field exists to close.
 *   - A rollup-shaped object from BEFORE this change, carrying a number and no
 *     state. Read exactly as isMeasuredEngineSlice reads a pre-R2.1.1 slice: a
 *     finite number meant `measured` (or `measured_zero` at 0), because the old
 *     writer had no way to say anything else. NOTE this is a compatibility
 *     reading of an in-process object, NOT a claim about historical DB rows —
 *     those are exactly the rows migration 013 re-derives, because a stored
 *     pre-R4.3.2 100 may well be the tautology.
 */
function resolveSovState(rollup) {
  const { MEASURED, MEASURED_ZERO, NOT_ASSESSED } = ENGINE_MEASUREMENT_STATE;
  if (rollup?.sov_state != null) {
    return { sov_state: rollup.sov_state, sov_state_reason: rollup.sov_state_reason ?? null };
  }
  if (Number.isFinite(rollup?.sov_pct)) {
    return rollup.sov_pct === 0
      ? { sov_state: MEASURED_ZERO, sov_state_reason: SOV_STATE_REASONS.BRAND_NOT_VISIBLE }
      : { sov_state: MEASURED, sov_state_reason: null };
  }
  return { sov_state: NOT_ASSESSED, sov_state_reason: SOV_STATE_REASONS.NO_RESULTS };
}

/**
 * The pool `cited_non_branded` was actually counted over (R2.2.2, finding B2).
 *
 * A Perplexity probe is two independent calls: the answer (/chat/completions)
 * and the citation list (/search). When the citation leg dies the row still
 * answers, so it stays in `non_branded_with_answer` — but its `citations: []`
 * is "we could not look", not "we looked and found none". summarizeEngineSlice
 * therefore excludes those rows from BOTH sides of the citation ratio and emits
 * the surviving pool as `citation_denominator`.
 *
 * This function exists because THIS FILE divides `cited_non_branded` by
 * `non_branded_with_answer` on its own, independently of that slice. Filtering
 * only the slice's numerator would have let the same outage back into
 * citation_share_pct one layer down, which is the shape the whole finding is
 * about.
 *
 * FAILS LOUD, DOES NOT DEFAULT, on the one engine where the two numbers can
 * legitimately differ. A perplexity slice with answered rows and no
 * `citation_denominator` cannot be turned into a citation share by anyone: the
 * only other candidate denominator is the one that is known to be wrong. `?? 0`
 * or `?? answered` here would silently restore a false "not cited" for an
 * engine outage — standing rule 1. Every slice summarizeEngineSlice produces
 * carries the field, so the live path cannot reach this throw; a slice that
 * lacks it predates R2.2.2 and must be re-derived from its prompt_results rows
 * rather than defaulted. (Consequence, flagged deliberately:
 * scripts/backfill-analytics.mjs will now throw rather than emit a wrong number
 * when it replays a pre-R2.2.2 multi-engine scan that has a perplexity slice.)
 *
 * Every other engine is single-leg: its citations arrive on the same call as
 * its answer, so an answered row's citation list was necessarily observed and
 * `non_branded_with_answer` IS the denominator. Same for a pre-R2.2.2 aio or
 * chatgpt slice, which is why they fall back rather than throw.
 */
function citationDenominatorOf({ engine, summary, answered }) {
  // `typeof`, not `Number(...)`: Number(null) is 0, which is finite, so a slice
  // carrying an explicit null would have been read as "a denominator of zero"
  // and quietly produced a null share instead of reaching the throw below.
  const explicit = summary?.citation_denominator;
  if (typeof explicit === "number" && Number.isFinite(explicit)) return explicit;

  if (engine === "perplexity" && answered > 0) {
    throw new Error(
      `summaryToMetricsRow: the perplexity slice carries no citation_denominator, so its ` +
        `citation share cannot be computed. Perplexity's citation leg (/search) fails ` +
        `independently of its answer leg, so non_branded_with_answer (${answered}) is not a ` +
        `citation denominator — dividing by it reports an unobserved citation list as a ` +
        `confirmed "not cited" (R2.2.2, finding B2). Slices from summarizeEngineSlice always ` +
        `carry the field; one that does not predates R2.2.2 and must be re-derived from its ` +
        `prompt_results rows, not defaulted.`
    );
  }

  return answered;
}

/**
 * Builds one engine-scoped brand_metrics_daily row from a per-engine (or
 * top-level backward-compat) summary object. `answeredKey` accounts for the
 * two field names summary objects use for "non-branded queries that got an
 * answer":
 *   - per-engine (enginePipeline.js summarizeEngineSlice output):
 *     `non_branded_with_answer`, and NO citation_share_pct field (computed
 *     here from cited_non_branded over citationDenominatorOf — which is the
 *     slice's `citation_denominator`, NOT its answered count, since R2.2.2).
 *   - v8.1 / backward-compat top-level summary (aioPipeline.js
 *     summarizeAioResults output, used for single-engine scans):
 *     `non_branded_with_aio`, and citation_share_pct IS already present —
 *     preferred over recomputing it.
 *
 * prompts_total/answered/mentioned are scoped to the non-branded pool
 * (non_branded_queries / *_with_answer|aio / mentioned_non_branded) — the
 * same denominators visibility_pct itself is computed over, so the row is
 * internally consistent. Missing fields default to 0 (not null) — a row
 * always reports a real count for a pool it actually measured. The citation
 * denominator is the ONE exception and deliberately so: see
 * citationDenominatorOf.
 *
 * `brandRollup` (P1.2/P1.3, optional): `{ sov_pct, sentiment_avg,
 * position_avg }` from computeBrandRollups above. Omitted entirely by every
 * caller that has no per-brand source — e.g. scripts/backfill-analytics.mjs,
 * which reconstructs historical rows with no per-rival position/sentiment to
 * explode — in which case all three stay null, unchanged from before P1.2, and
 * `sov_state`/`sov_state_reason` (R4.3.2) record that as not_assessed /
 * no_results rather than leaving the row silent about why its share is empty.
 */
export function summaryToMetricsRow({ brand, date, engine, scanId, promptSetId, summary, answeredKey, brandRollup }) {
  const nonBrandedTotal = summary.non_branded_queries ?? 0;
  const nonBrandedAnswered = summary[answeredKey] ?? 0;
  const mentioned = summary.mentioned_non_branded ?? 0;
  const cited = summary.cited_non_branded ?? 0;
  const visibilityPct = summary.visibility_pct ?? summary.share_of_ai_pct ?? null;
  const citationDenominator = citationDenominatorOf({ engine, summary, answered: nonBrandedAnswered });
  // R2.2.11 — the DENOMINATOR decides whether there is a share at all, and it
  // decides FIRST. This used to read `summary.citation_share_pct ?? (computed)`,
  // which is the same expression with the guard on the wrong side of the `??`:
  // an upstream 0 published over an empty pool was preferred over this
  // function's own, correct, null. `0 ?? x` is 0, so the pre-existing
  // false-zero producers laundered straight through onto
  // brand_metrics_daily.citation_share_pct — the scan-level mirror in
  // enginePipeline.js (fixed in the same commit) and summarizeAioResults in
  // scoring/aioPipeline.js:231, which still emits 0.0 for an empty
  // non_branded_with_aio and is a v8.1 summary this function is fed directly by
  // buildMetricsRows's single-engine branch and by scripts/backfill-analytics.mjs.
  //
  // With an empty denominator there is nothing any upstream could have divided,
  // so a number claimed for it is not a measurement whoever computed it. With a
  // non-empty one the preference is unchanged: a summary that already carries
  // its own citation_share_pct (the v8.1 top-level shape) wins over recomputing
  // it, exactly as before.
  const citationSharePct =
    citationDenominator > 0
      ? summary.citation_share_pct ?? Math.round((cited / citationDenominator) * 1000) / 10
      : null;
  const rollup = brandRollup || {};

  return {
    brand,
    date,
    engine,
    visibility_pct: visibilityPct,
    sov_pct: rollup.sov_pct ?? null,
    // R4.3.2 — the state travels onto the durable row, because a null sov_pct
    // with no reason is the same "empty state that looks clean" the number was.
    ...resolveSovState(rollup),
    sentiment_avg: rollup.sentiment_avg ?? null,
    position_avg: rollup.position_avg ?? null,
    citation_share_pct: citationSharePct,
    prompts_total: nonBrandedTotal,
    prompts_answered: nonBrandedAnswered,
    prompts_mentioned: mentioned,
    scan_id: scanId,
    prompt_set_id: promptSetId ?? null,
  };
}

/**
 * Builds the brand_metrics_daily rows (per-engine + blended 'all') for one
 * scan — live or backfilled:
 *   - Multi-engine: one row per engine via summaryToMetricsRow
 *     (answeredKey: "non_branded_with_answer"), plus a blended 'all' row
 *     whose prompt counts are the UNION across engines (unionPromptCounts)
 *     while its citation_share_pct stays a summed pair-rate (cited
 *     answer-pairs / answer-pairs across engines) — "counts = union, rate =
 *     summed", matching the historical backfill's original split exactly.
 *     Falls back to a single engine's N when per-prompt rows are absent
 *     (union is null).
 *   - Single-engine (aio only): one 'aio' row via summaryToMetricsRow
 *     (answeredKey: "non_branded_with_aio") and an identical 'all' row,
 *     since aio is the only engine that ran.
 *
 * `brandJudgmentRows` (P1.2/P1.3, optional): fed straight into
 * computeBrandRollups for each row built below — per-engine rows get that
 * engine's slice, the blended 'all' row gets the cross-engine blend (no
 * engine filter). Omitted by scripts/backfill-analytics.mjs (no per-brand
 * source for historical scans), in which case every row's sov_pct/
 * sentiment_avg/position_avg stay null exactly as they did before P1.2 — but
 * every row now also carries `sov_state`/`sov_state_reason` (R4.3.2) saying
 * WHICH kind of empty that is, and a self-only roster yields a null share on
 * every row rather than a 100 on all of them.
 */
export function buildMetricsRows({
  isMultiEngine,
  brandKey,
  dateOnly,
  scanId,
  promptSetId,
  summary,
  engineSummaries,
  headline,
  promptResultRows,
  brandJudgmentRows,
}) {
  const rows = [];

  if (isMultiEngine) {
    let sumCited = 0;
    // R2.2.2 — the blended row's citation denominator is summed from each
    // engine's OBSERVED-citation pool, not from the answered counts. Blending
    // perplexity's already-filtered numerator over its unfiltered answered
    // count is the same false "not cited" one level up. For every engine
    // without a failable citation leg this is still exactly its answered count,
    // so the blended rate is unchanged for aio/chatgpt-only scans.
    let sumCitationDenominator = 0;
    let singleEngineTotal = 0;

    for (const [engineName, s] of Object.entries(engineSummaries || {})) {
      const row = summaryToMetricsRow({
        brand: brandKey,
        date: dateOnly,
        engine: engineName,
        scanId,
        promptSetId,
        summary: s,
        answeredKey: "non_branded_with_answer",
        brandRollup: computeBrandRollups(brandJudgmentRows, { engine: engineName }),
      });
      rows.push(row);
      sumCited += s.cited_non_branded ?? 0;
      sumCitationDenominator += citationDenominatorOf({
        engine: engineName,
        summary: s,
        answered: row.prompts_answered || 0,
      });
      // Every engine shares the same prompt set, so any engine's non-branded
      // count is the true per-scan prompt total (use the max as a robust pick).
      singleEngineTotal = Math.max(singleEngineTotal, row.prompts_total || 0);
    }

    const union = unionPromptCounts(promptResultRows);
    const blendedRollup = computeBrandRollups(brandJudgmentRows); // no engine filter -> blends every engine
    rows.push({
      brand: brandKey,
      date: dateOnly,
      engine: "all",
      visibility_pct: headline?.visibility_index_pct ?? null,
      sov_pct: blendedRollup.sov_pct,
      // R4.3.2 — the blended row states its own case. It is NOT the union of
      // the per-engine states: the roster is a per-scan fact, so a self-only
      // roster makes every row here not_assessed together, and a rival roster
      // makes the blend measurable even where one engine's slice was not.
      ...resolveSovState(blendedRollup),
      sentiment_avg: blendedRollup.sentiment_avg,
      position_avg: blendedRollup.position_avg,
      citation_share_pct:
        sumCitationDenominator > 0 ? Math.round((sumCited / sumCitationDenominator) * 1000) / 10 : null,
      prompts_total: union ? union.total : singleEngineTotal,
      prompts_answered: union ? union.answered : null,
      prompts_mentioned: union ? union.mentioned : null,
      scan_id: scanId,
      prompt_set_id: promptSetId ?? null,
    });
  } else {
    const aioRow = summaryToMetricsRow({
      brand: brandKey,
      date: dateOnly,
      engine: "aio",
      scanId,
      promptSetId,
      summary,
      answeredKey: "non_branded_with_aio",
      brandRollup: computeBrandRollups(brandJudgmentRows, { engine: "aio" }),
    });
    rows.push(aioRow, { ...aioRow, engine: "all" });
  }

  return rows;
}
