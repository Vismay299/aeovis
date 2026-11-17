/**
 * R4.3.3 — re-deriving (or honestly refusing to re-derive) the citation
 * denominator for a HISTORICAL scan, plus the scan -> brand_metrics_daily
 * adaptation that used to live inline in scripts/backfill-analytics.mjs.
 *
 * WHY THIS FILE EXISTS AT ALL
 * ---------------------------
 * R2.2.2 taught `summarizeEngineSlice` that Perplexity's citation list comes
 * from a SECOND call (/search) which fails independently of the answer call, so
 * an answered row whose /search died carries `citations: []` meaning "we could
 * not look", not "we looked and found none". Those rows are excluded from both
 * sides of the citation ratio, and the surviving pool is emitted on the slice as
 * `citation_denominator`. src/shared/analytics/rollup.js then REFUSES to compute a
 * citation share for a perplexity slice that carries no such field, because the
 * only other candidate denominator is the one known to be wrong.
 *
 * That refusal is right, and it made the historical backfill throw: scans
 * written before R2.2.2 have no `citation_denominator` on their stored engine
 * summaries. The throw took the whole scan down — prompt_results and citations
 * included — and the scan was reported as an ERROR, which is not what it is. It
 * is a scan whose citation denominator is, for some slices, genuinely unknown.
 *
 * WHICH HISTORICAL ROWS CAN BE RE-DERIVED — the honest split
 * ----------------------------------------------------------
 * Evidence available for a historical scan is `scans.raw_results`: the stored
 * per-engine summaries (`.engines`) and the full per-probe result array
 * (`.results`, written verbatim by db.js insertScan). There are exactly four
 * cases, and only the last is unknowable:
 *
 *   1. The slice already carries `citation_denominator` (post-R2.2.2 scan).
 *      Nothing to derive — it IS the measurement. -> `slice_carried`.
 *   2. The engine has no independent citation leg (aio, chatgpt — see
 *      CITATION_LEG_INDEPENDENT_ENGINES). Its citations arrive on the same call
 *      as its answer, so every answered row's citation list was necessarily
 *      observed and the answered count IS the denominator, at every vintage.
 *      -> `single_leg_engine`.
 *   3. A multi-leg engine that answered nothing. The pool is empty by
 *      construction whatever the citation legs did. Denominator 0, and 0 here
 *      is a MEASUREMENT ("there were no opportunities"), never an unknown.
 *      -> `empty_answer_pool`.
 *   4. A multi-leg engine with answered rows and no stored denominator. Now it
 *      depends entirely on whether the per-probe rows survived AND carry the
 *      `citations_state` marker:
 *        - every answered non-branded row for that engine carries an explicit
 *          `citations_state` -> recount the pool exactly as summarizeEngineSlice
 *          would have. -> `rederived_from_results`.
 *        - the rows are absent, are a different population than the summary was
 *          computed over, or predate the marker -> THE NUMBER IS GONE.
 *          -> `unrecoverable`.
 *
 * The expectation for the production database is that case 4b is the common
 * one for pre-R2.2.2 multi-engine scans: `citations_state` was introduced BY
 * R2.2.2, in the same commit as `citation_denominator`, so a scan old enough to
 * lack the summary field is old enough to lack the per-row marker too. The two
 * sources fail together by construction. Case 4a is therefore a narrow window
 * (a scan probed after the probe change and summarized before the summary one,
 * or a slice whose summary was rebuilt) and is implemented because it is cheap
 * and because "we did not even look for surviving evidence" is not an honest
 * way to reach "unknowable". THE REPORT AT THE END OF THE BACKFILL IS WHAT
 * SETTLES THE ACTUAL SPLIT ON REAL DATA — no number is asserted here.
 *
 * WHAT IS DELIBERATELY NOT DONE: nothing here re-probes, estimates, or
 * interpolates a denominator, and nothing substitutes the numerator or the
 * answered count for a multi-leg engine. An unknown is recorded as an unknown.
 */

import {
  buildMetricsRows,
  CITATION_LEG_INDEPENDENT_ENGINES,
  UNRECOVERABLE_CITATION_DENOMINATOR,
} from "./rollup.js";
import { CITATIONS_STATE, hasUnverifiedCitations } from "../engines/perplexity.js";

/**
 * How a slice's citation denominator was obtained. Every slice the backfill
 * touches lands on exactly one of these — there is no "other" and no absent
 * outcome, because a slice nobody classified is a slice nobody counted.
 */
export const DENOMINATOR_OUTCOME = Object.freeze({
  /** The stored summary already carried `citation_denominator` (post-R2.2.2). */
  SLICE_CARRIED: "slice_carried",
  /** Single-leg engine: answered count is the denominator by construction. */
  SINGLE_LEG_ENGINE: "single_leg_engine",
  /** Multi-leg engine, nothing answered: a real, measured pool of 0. */
  EMPTY_ANSWER_POOL: "empty_answer_pool",
  /** Recounted from surviving per-probe rows carrying `citations_state`. */
  REDERIVED_FROM_RESULTS: "rederived_from_results",
  /** Genuinely gone. Recorded as unmeasured; never defaulted to a number. */
  UNRECOVERABLE: "unrecoverable",
});

/** WHY an `unrecoverable` slice is unrecoverable. Reported per slice. */
export const UNRECOVERABLE_DETAIL = Object.freeze({
  /** raw_results.results holds no answered non-branded row for this engine. */
  NO_RESULT_ROWS: "no_surviving_result_rows",
  /**
   * Rows exist but are not the population the summary was computed over (their
   * answered non-branded count disagrees with the slice's own). Recounting a
   * different population would produce a confident number for a pool that was
   * never measured, which is the defaulting this whole task exists to prevent.
   */
  ROW_COUNT_MISMATCH: "result_rows_disagree_with_summary",
  /** Rows survived but predate R2.2.2 and carry no `citations_state`. */
  MISSING_CITATIONS_STATE: "result_rows_predate_citations_state",
});

const isMultiLeg = (engine) => CITATION_LEG_INDEPENDENT_ENGINES.includes(engine);

/** v9 `answer_present` / v8.1 `aio_present`, mirroring normalizeResultRow. */
const isAnswered = (row) => !!(row?.answer_present ?? row?.aio_present ?? false);

/** Rows never set `engine` on the v8.1 AIO-only vintage. */
const engineOf = (row) => row?.engine || "aio";

/**
 * Re-derive one engine slice's citation denominator from a historical scan's
 * surviving per-probe rows, or say — with a reason — that it cannot be done.
 *
 * NEVER RETURNS A GUESS. `denominator: null` means unknown and is always
 * accompanied by `outcome: "unrecoverable"` plus a `detail` naming which of the
 * three ways the evidence failed.
 *
 * @param {object}   args
 * @param {string}   args.engine          engine key, e.g. "perplexity".
 * @param {object[]} args.resultRows      raw_results.results (ALL engines; this
 *                                        function filters).
 * @param {number}   args.summaryAnswered the slice's own
 *                                        `non_branded_with_answer`, used both
 *                                        as the single-leg denominator and as
 *                                        the population check for case 4a.
 * @returns {{denominator: number|null, outcome: string, detail: string|null,
 *            observedRows: number}}
 */
export function rederiveCitationDenominator({ engine, resultRows, summaryAnswered }) {
  const answered = Number.isFinite(summaryAnswered) ? summaryAnswered : 0;

  if (!isMultiLeg(engine)) {
    return {
      denominator: answered,
      outcome: DENOMINATOR_OUTCOME.SINGLE_LEG_ENGINE,
      detail: null,
      observedRows: answered,
    };
  }

  if (answered <= 0) {
    // Nothing answered, so nothing could have been cited, whatever happened to
    // the citation legs. A measured zero — distinct from the unknown below.
    return {
      denominator: 0,
      outcome: DENOMINATOR_OUTCOME.EMPTY_ANSWER_POOL,
      detail: null,
      observedRows: 0,
    };
  }

  const pool = (Array.isArray(resultRows) ? resultRows : []).filter(
    (r) => engineOf(r) === engine && !r?.is_branded_query && isAnswered(r)
  );

  if (pool.length === 0) {
    return {
      denominator: null,
      outcome: DENOMINATOR_OUTCOME.UNRECOVERABLE,
      detail: UNRECOVERABLE_DETAIL.NO_RESULT_ROWS,
      observedRows: 0,
    };
  }

  if (pool.length !== answered) {
    return {
      denominator: null,
      outcome: DENOMINATOR_OUTCOME.UNRECOVERABLE,
      detail: UNRECOVERABLE_DETAIL.ROW_COUNT_MISMATCH,
      observedRows: pool.length,
    };
  }

  // The marker must be EXPLICIT on every row. A missing `citations_state` is
  // not "verified by default" — that default is precisely the pre-R2.2.2
  // reading in which a dead search leg counted as a confirmed "not cited".
  const unmarked = pool.filter(
    (r) =>
      r?.citations_state !== CITATIONS_STATE.VERIFIED &&
      r?.citations_state !== CITATIONS_STATE.UNVERIFIED
  );
  if (unmarked.length > 0) {
    return {
      denominator: null,
      outcome: DENOMINATOR_OUTCOME.UNRECOVERABLE,
      detail: UNRECOVERABLE_DETAIL.MISSING_CITATIONS_STATE,
      observedRows: pool.length,
    };
  }

  // Exactly summarizeEngineSlice's citationPool, recounted: answered
  // non-branded rows minus the ones whose citation list was never observed.
  return {
    denominator: pool.filter((r) => !hasUnverifiedCitations(r)).length,
    outcome: DENOMINATOR_OUTCOME.REDERIVED_FROM_RESULTS,
    detail: null,
    observedRows: pool.length,
  };
}

/**
 * Adapts one historical `scans` row to the shared buildMetricsRows contract
 * (src/shared/analytics/rollup.js — the single source of truth for
 * brand_metrics_daily math, also used by the live pipeline's
 * runFinalizePhase). Two raw_results shapes exist across scan history:
 *   - v9 multi-engine (`rawResults.engines`): one row per engine that actually
 *     reported, plus a blended 'all' row using the real cross-engine headline
 *     (computeHeadline in enginePipeline.js) rather than re-deriving a blend.
 *   - v8.1 single-engine AIO-only (`rawResults.summary_stats`): 'aio' and 'all'
 *     rows are identical since AIO is the only engine that ran.
 *   - Neither shape present (malformed row, or predates both pipelines):
 *     contributes no brand_metrics_daily rows. Reported by the caller as
 *     `scansWithNoSummary`, never passed over in silence.
 *
 * R4.3.3 — before handing the engine summaries to buildMetricsRows, each one
 * that lacks `citation_denominator` goes through rederiveCitationDenominator
 * above. A re-derived number is injected onto a COPY of the summary (the stored
 * object is never mutated); a slice that could not be re-derived is left
 * without the field and buildMetricsRows is run in `record` mode, so it writes
 * `citation_denominator: null` + `citation_state_reason:
 * 'citation_denominator_unrecoverable'` instead of throwing.
 *
 * `record` mode is scoped to THIS function — the live finalize path keeps the
 * R2.2.2 throw, because a live slice missing the field is a producer bug and
 * not a historical artifact.
 *
 * @returns {{rows: object[], slices: object[]}} `slices` is one entry per
 *          engine summary considered: `{ engine, outcome, detail, denominator,
 *          observedRows }`. The caller counts them; a slice that produced no
 *          row is still in the list.
 */
export function buildHistoricalMetricsRows({
  scanId,
  rawResults,
  brandKey,
  dateOnly,
  promptResultRows,
}) {
  const raw = rawResults || {};
  const promptSetId = raw.prompt_set_id ?? null;
  const resultRows = Array.isArray(raw.results) ? raw.results : [];
  const slices = [];

  if (raw.engines && typeof raw.engines === "object" && Object.keys(raw.engines).length > 0) {
    const engineSummaries = {};

    for (const [engine, summary] of Object.entries(raw.engines)) {
      const stored = summary?.citation_denominator;
      if (typeof stored === "number" && Number.isFinite(stored)) {
        slices.push({
          engine,
          outcome: DENOMINATOR_OUTCOME.SLICE_CARRIED,
          detail: null,
          denominator: stored,
          observedRows: summary?.non_branded_with_answer ?? 0,
        });
        engineSummaries[engine] = summary;
        continue;
      }

      const derived = rederiveCitationDenominator({
        engine,
        resultRows,
        summaryAnswered: summary?.non_branded_with_answer ?? 0,
      });
      slices.push({ engine, ...derived });

      // Only an actual number is injected. `null` is left OFF the summary on
      // purpose: citationDenominatorOf reads the field with `typeof`, and
      // writing an explicit null would be read as "a denominator of zero" —
      // the unmeasured-becomes-measured-zero coercion this task is about.
      engineSummaries[engine] =
        derived.denominator == null ? summary : { ...summary, citation_denominator: derived.denominator };
    }

    return {
      slices,
      rows: buildMetricsRows({
        isMultiEngine: true,
        brandKey,
        dateOnly,
        scanId,
        promptSetId,
        engineSummaries,
        headline: { visibility_index_pct: raw.visibility_index_pct ?? null },
        promptResultRows,
        onUnrecoverableDenominator: UNRECOVERABLE_CITATION_DENOMINATOR.RECORD,
      }),
    };
  }

  if (raw.summary_stats && typeof raw.summary_stats === "object") {
    // AIO is single-leg at every vintage, so this branch has no unknowable
    // case: the answered count is the denominator. Classified anyway, because
    // an unclassified slice is an uncounted one.
    slices.push({
      engine: "aio",
      outcome: DENOMINATOR_OUTCOME.SINGLE_LEG_ENGINE,
      detail: null,
      denominator: raw.summary_stats.non_branded_with_aio ?? 0,
      observedRows: raw.summary_stats.non_branded_with_aio ?? 0,
    });
    return {
      slices,
      rows: buildMetricsRows({
        isMultiEngine: false,
        brandKey,
        dateOnly,
        scanId,
        promptSetId,
        summary: raw.summary_stats,
        promptResultRows,
        onUnrecoverableDenominator: UNRECOVERABLE_CITATION_DENOMINATOR.RECORD,
      }),
    };
  }

  return { rows: [], slices };
}

/**
 * The tally scripts/backfill-analytics.mjs keeps for the citation denominator,
 * pre-seeded with EVERY outcome and EVERY citation state at 0.
 *
 * Pre-seeding is the point. A counter that only appears once it is non-zero
 * makes "no slice was unrecoverable" and "nobody counted unrecoverable slices"
 * print identically — and this task exists because a measured zero and an
 * unmeasured nothing looked the same. formatCitationDenominatorReport below
 * prints every line even at 0, and says so explicitly when the whole tally is
 * empty.
 */
export function createCitationDenominatorTally() {
  return {
    denominatorOutcomes: {
      [DENOMINATOR_OUTCOME.SLICE_CARRIED]: 0,
      [DENOMINATOR_OUTCOME.SINGLE_LEG_ENGINE]: 0,
      [DENOMINATOR_OUTCOME.EMPTY_ANSWER_POOL]: 0,
      [DENOMINATOR_OUTCOME.REDERIVED_FROM_RESULTS]: 0,
      [DENOMINATOR_OUTCOME.UNRECOVERABLE]: 0,
    },
    metricsRowsByCitationState: { measured: 0, measured_zero: 0, not_assessed: 0, failed: 0 },
    denominatorPreserved: 0,
    unrecoverableSlices: [],
  };
}

/**
 * The auditable half of requirement 3: how many slices re-derived, how many
 * were marked unmeasured, how many already had a value, and how many stored
 * measurements this run refused to overwrite. Returns lines rather than
 * printing, so a test can read them.
 */
export function formatCitationDenominatorReport(tally) {
  const o = tally.denominatorOutcomes || {};
  const totalSlices = Object.values(o).reduce((a, b) => a + b, 0);
  const lines = [
    "Citation denominator (R4.3.3) — engine slices considered: " + totalSlices,
    `  - already on the stored summary: ${o[DENOMINATOR_OUTCOME.SLICE_CARRIED] || 0}`,
    `  - single-leg engine (answered count IS the denominator): ${o[DENOMINATOR_OUTCOME.SINGLE_LEG_ENGINE] || 0}`,
    `  - measured zero (nothing answered, so no opportunities): ${o[DENOMINATOR_OUTCOME.EMPTY_ANSWER_POOL] || 0}`,
    `  - re-derived from surviving prompt rows: ${o[DENOMINATOR_OUTCOME.REDERIVED_FROM_RESULTS] || 0}`,
    `  - UNRECOVERABLE, stored as unmeasured: ${o[DENOMINATOR_OUTCOME.UNRECOVERABLE] || 0}`,
    `  - stored measurements preserved over a fresh unknown: ${tally.denominatorPreserved || 0}`,
  ];

  if (totalSlices === 0) {
    lines.push(
      "  (no engine slice was replayed at all — this run measured nothing, which is " +
        "not the same as finding nothing to do)"
    );
  }

  const byState = tally.metricsRowsByCitationState || {};
  lines.push(
    `brand_metrics_daily rows by citation_state: measured=${byState.measured || 0} ` +
      `measured_zero=${byState.measured_zero || 0} not_assessed=${byState.not_assessed || 0} ` +
      `failed=${byState.failed || 0}`
  );

  const unrecoverable = tally.unrecoverableSlices || [];
  if (unrecoverable.length > 0) {
    lines.push("Unrecoverable citation denominators (citation_share_pct is NULL on these rows, not 0):");
    for (const s of unrecoverable) {
      lines.push(`  - ${s.date} ${s.brand} ${s.engine} (scan ${s.scanId}): ${s.detail}`);
    }
  }

  return lines;
}

/**
 * IDEMPOTENCY, the half that a re-run can get wrong (R4.3.3 requirement 2).
 *
 * Re-running the backfill re-upserts each scan's brand_metrics_daily rows on
 * (brand, date, engine). The row is rebuilt from the same immutable
 * `scans.raw_results`, so every field is deterministic — EXCEPT for one
 * asymmetry: a row whose citation denominator was already established as a
 * real measurement must not be demoted to `unrecoverable` by a later run that
 * happens to see less evidence (a prompt_results wipe mid-run, a raw_results
 * payload edited by hand, or simply this code being re-run against a row the
 * LIVE finalize wrote with a real denominator).
 *
 * A measurement outranks an unknown. So: when the freshly built row says
 * "unrecoverable" and the STORED row for the same (brand, date, engine) is a
 * measurement OF THE SAME SCAN, the stored citation trio is carried forward
 * untouched and the caller counts it as preserved.
 *
 * Scoped to the same `scan_id` deliberately. brand_metrics_daily is keyed by
 * (brand, date, engine), so two scans of one brand on one day share a row;
 * carrying another scan's denominator onto this scan's counts would build a
 * row whose numerator and denominator come from different measurements, which
 * is worse than the demotion it would prevent.
 *
 * Never runs in the other direction: a fresh REAL number always overwrites a
 * stored unknown, which is how a re-run after the evidence is restored heals
 * the row.
 *
 * @param {object} row    the freshly built brand_metrics_daily row.
 * @param {object|null} stored the row currently in the table, or null.
 * @returns {{row: object, preserved: boolean}}
 */
export function preserveMeasuredDenominator(row, stored) {
  const freshIsUnknown = row?.citation_denominator == null;
  const storedIsMeasured =
    stored != null &&
    stored.scan_id === row.scan_id &&
    stored.citation_denominator != null &&
    stored.citation_state != null;

  if (!freshIsUnknown || !storedIsMeasured) return { row, preserved: false };

  return {
    preserved: true,
    row: {
      ...row,
      citation_share_pct: stored.citation_share_pct ?? null,
      citation_denominator: stored.citation_denominator,
      citation_state: stored.citation_state,
      citation_state_reason: stored.citation_state_reason ?? null,
    },
  };
}
