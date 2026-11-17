import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  rederiveCitationDenominator,
  buildHistoricalMetricsRows,
  preserveMeasuredDenominator,
  createCitationDenominatorTally,
  formatCitationDenominatorReport,
  DENOMINATOR_OUTCOME,
  UNRECOVERABLE_DETAIL,
} from "./historicalBackfill.js";
import { CITATION_STATE_REASONS, summaryToMetricsRow } from "./rollup.js";
import { ENGINE_MEASUREMENT_STATE } from "../scoring/enginePipeline.js";
import { upsertBrandMetricsDaily, getBrandMetricsSeries } from "../../server/db/analytics.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

/**
 * R4.3.3 — the historical citation denominator.
 *
 * The finding: R2.2.2 made rollup.js THROW rather than divide a perplexity
 * slice's citations by its answered count, which is right, and which made
 * scripts/backfill-analytics.mjs throw on every pre-R2.2.2 multi-engine scan —
 * taking the scan's prompt_results and citations down with it and reporting a
 * knowable state as an error.
 *
 * What these tests hold in place is the THREE-WAY distinction, because the
 * tempting fixes (`?? 0`, `?? answered`, skip the row) all collapse it:
 *
 *   a real number  — the denominator survived, or was recounted from rows that
 *                    still carry R2.2.2's `citations_state` marker
 *   a real ZERO    — nothing answered, so there were no opportunities. A
 *                    MEASUREMENT, and it must stay visibly different from
 *   an UNKNOWN     — the scan predates the marker, so the number is gone.
 *                    Stored as citation_denominator NULL +
 *                    citation_state_reason 'citation_denominator_unrecoverable'.
 *
 * "Distinguishable end to end" is asserted by writing all three through
 * upsertBrandMetricsDaily and reading them back, not just by inspecting the
 * object the builder returned.
 */

const { MEASURED, MEASURED_ZERO, NOT_ASSESSED } = ENGINE_MEASUREMENT_STATE;

/** One stored probe row as scans.raw_results.results holds it (v9 shape). */
function resultRow(overrides = {}) {
  return {
    engine: "perplexity",
    prompt: "best running shoes",
    is_branded_query: false,
    answer_present: true,
    text: "...",
    references: [],
    ...overrides,
  };
}

/** A pre-R2.2.2 scan: engine summaries with NO citation_denominator, rows with NO citations_state. */
function preR222Scan() {
  return {
    visibility_index_pct: 40,
    engines: {
      aio: {
        non_branded_queries: 10,
        non_branded_with_answer: 8,
        mentioned_non_branded: 4,
        cited_non_branded: 2,
        visibility_pct: 50,
      },
      perplexity: {
        non_branded_queries: 10,
        non_branded_with_answer: 2,
        mentioned_non_branded: 1,
        cited_non_branded: 1,
        visibility_pct: 50,
      },
    },
    results: [
      resultRow({ prompt: "p1" }),
      resultRow({ prompt: "p2" }),
      resultRow({ engine: "aio", prompt: "p1" }),
      resultRow({ engine: "aio", prompt: "p2" }),
    ],
  };
}

// ---------------------------------------------------------------------------
// rederiveCitationDenominator — the four knowable cases and the one that is not
// ---------------------------------------------------------------------------

test("R4.3.3 — a single-leg engine is always derivable: its answered count IS the denominator", () => {
  for (const engine of ["aio", "chatgpt"]) {
    const out = rederiveCitationDenominator({ engine, resultRows: [], summaryAnswered: 7 });
    assert.equal(out.outcome, DENOMINATOR_OUTCOME.SINGLE_LEG_ENGINE);
    assert.equal(out.denominator, 7, "citations arrive on the answer call, so every list was observed");
    assert.equal(out.detail, null);
  }
});

test("R4.3.3 — a multi-leg engine that answered NOTHING is a measured zero, not an unknown", () => {
  const out = rederiveCitationDenominator({
    engine: "perplexity",
    resultRows: [],
    summaryAnswered: 0,
  });
  assert.equal(out.outcome, DENOMINATOR_OUTCOME.EMPTY_ANSWER_POOL);
  assert.equal(out.denominator, 0, "there were no opportunities, and that is a fact we know");
  assert.notEqual(out.denominator, null, "a measured zero must never be reported as unknown either");
});

test("R4.3.3 — surviving rows that carry citations_state ARE re-derivable, and exclude the unverified ones", () => {
  const out = rederiveCitationDenominator({
    engine: "perplexity",
    resultRows: [
      resultRow({ prompt: "p1", citations_state: "verified" }),
      resultRow({ prompt: "p2", citations_state: "verified" }),
      resultRow({ prompt: "p3", citations_state: "unverified" }),
      // Not in the pool: branded, and unanswered.
      resultRow({ prompt: "brand?", is_branded_query: true, citations_state: "verified" }),
      resultRow({ prompt: "p4", answer_present: false, citations_state: "verified" }),
      // Another engine's rows must not leak into this slice's pool.
      resultRow({ engine: "aio", prompt: "p1" }),
    ],
    summaryAnswered: 3,
  });
  assert.equal(out.outcome, DENOMINATOR_OUTCOME.REDERIVED_FROM_RESULTS);
  assert.equal(out.denominator, 2, "the row whose /search died is not evidence of 'not cited'");
  assert.equal(out.observedRows, 3);
});

test("R4.3.3 — rows that predate the citations_state marker are UNRECOVERABLE, not defaulted", () => {
  const out = rederiveCitationDenominator({
    engine: "perplexity",
    resultRows: [resultRow({ prompt: "p1" }), resultRow({ prompt: "p2" })],
    summaryAnswered: 2,
  });
  assert.equal(out.outcome, DENOMINATOR_OUTCOME.UNRECOVERABLE);
  assert.equal(out.detail, UNRECOVERABLE_DETAIL.MISSING_CITATIONS_STATE);
  assert.equal(out.denominator, null);
  assert.notEqual(out.denominator, 0, "0 would claim there were no opportunities — there were 2");
  assert.notEqual(out.denominator, 2, "2 would claim both citation legs were observed — unknown");
});

test("R4.3.3 — one unmarked row among marked ones poisons the whole slice", () => {
  const out = rederiveCitationDenominator({
    engine: "perplexity",
    resultRows: [
      resultRow({ prompt: "p1", citations_state: "verified" }),
      resultRow({ prompt: "p2" }),
    ],
    summaryAnswered: 2,
  });
  assert.equal(out.denominator, null, "a partial recount is a wrong number, not a smaller one");
  assert.equal(out.detail, UNRECOVERABLE_DETAIL.MISSING_CITATIONS_STATE);
});

test("R4.3.3 — no surviving rows for an engine that DID answer is unrecoverable, never zero", () => {
  const out = rederiveCitationDenominator({
    engine: "perplexity",
    resultRows: [resultRow({ engine: "aio", prompt: "p1" })],
    summaryAnswered: 4,
  });
  assert.equal(out.outcome, DENOMINATOR_OUTCOME.UNRECOVERABLE);
  assert.equal(out.detail, UNRECOVERABLE_DETAIL.NO_RESULT_ROWS);
  assert.equal(out.denominator, null, "an empty rows array here means 'we cannot see', not 'nothing answered'");
});

test("R4.3.3 — rows that are a DIFFERENT population than the summary counted are unrecoverable", () => {
  // Three answered rows survive but the slice says it counted five: whatever
  // these rows are, they are not the pool that produced the summary, so
  // recounting them would publish a confident number for a different thing.
  const out = rederiveCitationDenominator({
    engine: "perplexity",
    resultRows: [
      resultRow({ prompt: "p1", citations_state: "verified" }),
      resultRow({ prompt: "p2", citations_state: "verified" }),
      resultRow({ prompt: "p3", citations_state: "verified" }),
    ],
    summaryAnswered: 5,
  });
  assert.equal(out.outcome, DENOMINATOR_OUTCOME.UNRECOVERABLE);
  assert.equal(out.detail, UNRECOVERABLE_DETAIL.ROW_COUNT_MISMATCH);
  assert.equal(out.denominator, null);
});

test("R4.3.3 — every declared outcome and every unrecoverable detail is reachable by real input", () => {
  // A vocabulary with an unreachable token is a lie about the state space
  // (the convention enginePipeline.js's own tests hold). Reached above:
  const reached = new Set([
    DENOMINATOR_OUTCOME.SINGLE_LEG_ENGINE,
    DENOMINATOR_OUTCOME.EMPTY_ANSWER_POOL,
    DENOMINATOR_OUTCOME.REDERIVED_FROM_RESULTS,
    DENOMINATOR_OUTCOME.UNRECOVERABLE,
    // slice_carried is reached by buildHistoricalMetricsRows below.
    DENOMINATOR_OUTCOME.SLICE_CARRIED,
  ]);
  assert.deepEqual([...Object.values(DENOMINATOR_OUTCOME)].filter((o) => !reached.has(o)), []);

  const details = new Set([
    UNRECOVERABLE_DETAIL.MISSING_CITATIONS_STATE,
    UNRECOVERABLE_DETAIL.NO_RESULT_ROWS,
    UNRECOVERABLE_DETAIL.ROW_COUNT_MISMATCH,
  ]);
  assert.deepEqual([...Object.values(UNRECOVERABLE_DETAIL)].filter((d) => !details.has(d)), []);
});

// ---------------------------------------------------------------------------
// buildHistoricalMetricsRows — the acceptance criterion: a pre-R2.2.2 slice
// goes THROUGH the backfill instead of throwing it over
// ---------------------------------------------------------------------------

test("R4.3.3 ACCEPTANCE — a pre-R2.2.2 perplexity slice no longer throws; it records WHY the number is absent", () => {
  const { rows, slices } = buildHistoricalMetricsRows({
    scanId: "scan-pre-r222",
    rawResults: preR222Scan(),
    brandKey: "acme.com",
    dateOnly: "2026-07-24",
    promptResultRows: [],
  });

  const perplexity = rows.find((r) => r.engine === "perplexity");
  assert.equal(perplexity.citation_denominator, null, "unknown is NULL");
  assert.equal(perplexity.citation_share_pct, null, "and no share is invented over it");
  assert.equal(perplexity.citation_state, NOT_ASSESSED);
  assert.equal(perplexity.citation_state_reason, CITATION_STATE_REASONS.DENOMINATOR_UNRECOVERABLE);

  // The knowable engine in the same scan is unaffected — 2 cited of 8 answered.
  const aio = rows.find((r) => r.engine === "aio");
  assert.equal(aio.citation_denominator, 8);
  assert.equal(aio.citation_share_pct, 25);
  assert.equal(aio.citation_state, MEASURED);
  assert.equal(aio.citation_state_reason, null);

  // The blend cannot be honest while one engine's pool is unknown: summing the
  // known pools alone would shrink the denominator and INFLATE the share.
  const all = rows.find((r) => r.engine === "all");
  assert.equal(all.citation_denominator, null);
  assert.equal(all.citation_share_pct, null);
  assert.equal(all.citation_state_reason, CITATION_STATE_REASONS.DENOMINATOR_UNRECOVERABLE);

  const perplexitySlice = slices.find((s) => s.engine === "perplexity");
  assert.equal(perplexitySlice.outcome, DENOMINATOR_OUTCOME.UNRECOVERABLE);
  assert.equal(perplexitySlice.detail, UNRECOVERABLE_DETAIL.MISSING_CITATIONS_STATE);
  assert.equal(slices.length, 2, "every engine slice is classified — none is skipped silently");
});

test("R4.3.3 — a post-R2.2.2 scan is untouched: the stored denominator is used verbatim", () => {
  const raw = preR222Scan();
  raw.engines.perplexity.citation_denominator = 1; // one /search leg survived
  raw.engines.aio.citation_denominator = 8;

  const { rows, slices } = buildHistoricalMetricsRows({
    scanId: "scan-post-r222",
    rawResults: raw,
    brandKey: "acme.com",
    dateOnly: "2026-07-24",
    promptResultRows: [],
  });
  assert.deepEqual(
    slices.map((s) => s.outcome),
    [DENOMINATOR_OUTCOME.SLICE_CARRIED, DENOMINATOR_OUTCOME.SLICE_CARRIED]
  );
  const perplexity = rows.find((r) => r.engine === "perplexity");
  assert.equal(perplexity.citation_denominator, 1);
  assert.equal(perplexity.citation_share_pct, 100, "1 cited of the 1 list we actually read");
  assert.equal(perplexity.citation_state, MEASURED);
  assert.equal(rows.find((r) => r.engine === "all").citation_denominator, 9);
});

test("R4.3.3 — a pre-R2.2.2 slice WITH surviving marked rows is re-derived, not written off", () => {
  const raw = preR222Scan();
  raw.results = [
    resultRow({ prompt: "p1", citations_state: "verified" }),
    resultRow({ prompt: "p2", citations_state: "unverified" }),
    resultRow({ engine: "aio", prompt: "p1" }),
    resultRow({ engine: "aio", prompt: "p2" }),
  ];

  const { rows, slices } = buildHistoricalMetricsRows({
    scanId: "scan-rederivable",
    rawResults: raw,
    brandKey: "acme.com",
    dateOnly: "2026-07-24",
    promptResultRows: [],
  });
  assert.equal(
    slices.find((s) => s.engine === "perplexity").outcome,
    DENOMINATOR_OUTCOME.REDERIVED_FROM_RESULTS
  );
  const perplexity = rows.find((r) => r.engine === "perplexity");
  assert.equal(perplexity.citation_denominator, 1, "one of the two answered rows had an observed list");
  assert.equal(perplexity.citation_share_pct, 100, "1 cited / 1 observed — NOT 1/2 = 50");
  assert.equal(perplexity.citation_state, MEASURED);
});

test("R4.3.3 — the genuine zero: a slice that answered nothing stores 0, and 0 is a measurement", () => {
  const raw = preR222Scan();
  raw.engines.perplexity.non_branded_with_answer = 0;
  raw.engines.perplexity.cited_non_branded = 0;

  const { rows, slices } = buildHistoricalMetricsRows({
    scanId: "scan-zero-pool",
    rawResults: raw,
    brandKey: "acme.com",
    dateOnly: "2026-07-24",
    promptResultRows: [],
  });
  assert.equal(
    slices.find((s) => s.engine === "perplexity").outcome,
    DENOMINATOR_OUTCOME.EMPTY_ANSWER_POOL
  );
  const perplexity = rows.find((r) => r.engine === "perplexity");
  assert.equal(perplexity.citation_denominator, 0, "a counted zero");
  assert.equal(perplexity.citation_state, NOT_ASSESSED);
  assert.equal(perplexity.citation_state_reason, CITATION_STATE_REASONS.NO_OBSERVED_CITATION_POOL);
  assert.equal(perplexity.citation_share_pct, null, "no share over an empty pool — never a 0%");
});

test("R4.3.3 — measured_zero survives: every list read, we are in none, and that is a 0 not an absence", () => {
  const raw = preR222Scan();
  raw.engines.perplexity.citation_denominator = 2;
  raw.engines.perplexity.cited_non_branded = 0;
  raw.engines.aio.cited_non_branded = 0;

  const { rows } = buildHistoricalMetricsRows({
    scanId: "scan-measured-zero",
    rawResults: raw,
    brandKey: "acme.com",
    dateOnly: "2026-07-24",
    promptResultRows: [],
  });
  const perplexity = rows.find((r) => r.engine === "perplexity");
  assert.equal(perplexity.citation_share_pct, 0);
  assert.equal(typeof perplexity.citation_share_pct, "number", "null here would hide a real, bad finding");
  assert.equal(perplexity.citation_state, MEASURED_ZERO);
  assert.equal(perplexity.citation_state_reason, CITATION_STATE_REASONS.BRAND_NOT_CITED);
});

test("R4.3.3 — a v8.1 AIO-only scan has no unknowable case and is still classified", () => {
  const { rows, slices } = buildHistoricalMetricsRows({
    scanId: "scan-v81",
    rawResults: {
      summary_stats: {
        non_branded_queries: 10,
        non_branded_with_aio: 4,
        cited_non_branded: 1,
        visibility_pct: 30,
      },
    },
    brandKey: "acme.com",
    dateOnly: "2026-07-24",
    promptResultRows: [],
  });
  assert.deepEqual(slices.map((s) => s.outcome), [DENOMINATOR_OUTCOME.SINGLE_LEG_ENGINE]);
  for (const row of rows) {
    assert.equal(row.citation_denominator, 4);
    assert.equal(row.citation_share_pct, 25);
    assert.equal(row.citation_state, MEASURED);
  }
});

test("R4.3.3 — a scan with neither shape produces no rows AND no phantom slice", () => {
  const { rows, slices } = buildHistoricalMetricsRows({
    scanId: "scan-malformed",
    rawResults: { results: [] },
    brandKey: "acme.com",
    dateOnly: "2026-07-24",
    promptResultRows: [],
  });
  assert.deepEqual(rows, []);
  assert.deepEqual(slices, [], "the caller counts this as scansWithNoSummary; it is not an unknown denominator");
});

test("R4.3.3 — the stored engine summary object is never mutated by the re-derivation", () => {
  const raw = preR222Scan();
  raw.results = [
    resultRow({ prompt: "p1", citations_state: "verified" }),
    resultRow({ prompt: "p2", citations_state: "verified" }),
    resultRow({ engine: "aio", prompt: "p1" }),
    resultRow({ engine: "aio", prompt: "p2" }),
  ];
  buildHistoricalMetricsRows({
    scanId: "s",
    rawResults: raw,
    brandKey: "acme.com",
    dateOnly: "2026-07-24",
    promptResultRows: [],
  });
  assert.equal(
    "citation_denominator" in raw.engines.perplexity,
    false,
    "a re-derived number is this run's inference, not a fact written back onto the scan"
  );
});

// ---------------------------------------------------------------------------
// The live path keeps R2.2.2's refusal — `record` mode is opt-in, per caller
// ---------------------------------------------------------------------------

test("R4.3.3 — the LIVE path still throws for a perplexity slice with no denominator (R2.2.2 regression guard)", () => {
  assert.throws(
    () =>
      summaryToMetricsRow({
        brand: "acme.com",
        date: "2026-07-24",
        engine: "perplexity",
        scanId: "scan-live",
        promptSetId: null,
        summary: { non_branded_queries: 6, non_branded_with_answer: 4, cited_non_branded: 2 },
        answeredKey: "non_branded_with_answer",
      }),
    /citation_denominator/,
    "a live slice missing the field is a producer bug; only the historical replay may record it"
  );
});

// ---------------------------------------------------------------------------
// Idempotency (requirement 2)
// ---------------------------------------------------------------------------

test("R4.3.3 — building the same scan twice yields identical rows (no double counting)", () => {
  const args = {
    scanId: "scan-idempotent",
    rawResults: preR222Scan(),
    brandKey: "acme.com",
    dateOnly: "2026-07-24",
    promptResultRows: [],
  };
  assert.deepEqual(buildHistoricalMetricsRows(args).rows, buildHistoricalMetricsRows(args).rows);
});

test("R4.3.3 — a re-run must not overwrite a real measurement with an unknown", () => {
  const fresh = {
    brand: "acme.com",
    date: "2026-07-24",
    engine: "perplexity",
    scan_id: "scan-1",
    citation_share_pct: null,
    citation_denominator: null,
    citation_state: NOT_ASSESSED,
    citation_state_reason: CITATION_STATE_REASONS.DENOMINATOR_UNRECOVERABLE,
  };
  const stored = {
    brand: "acme.com",
    date: "2026-07-24",
    engine: "perplexity",
    scan_id: "scan-1",
    citation_share_pct: 50,
    citation_denominator: 4,
    citation_state: MEASURED,
    citation_state_reason: null,
  };

  const kept = preserveMeasuredDenominator(fresh, stored);
  assert.equal(kept.preserved, true);
  assert.equal(kept.row.citation_denominator, 4);
  assert.equal(kept.row.citation_share_pct, 50);
  assert.equal(kept.row.citation_state, MEASURED);

  // A stored MEASURED ZERO pool is also a measurement and is also protected.
  const keptZero = preserveMeasuredDenominator(fresh, {
    ...stored,
    citation_share_pct: null,
    citation_denominator: 0,
    citation_state: NOT_ASSESSED,
    citation_state_reason: CITATION_STATE_REASONS.NO_OBSERVED_CITATION_POOL,
  });
  assert.equal(keptZero.preserved, true);
  assert.equal(keptZero.row.citation_denominator, 0);
  assert.equal(keptZero.row.citation_state_reason, CITATION_STATE_REASONS.NO_OBSERVED_CITATION_POOL);
});

test("R4.3.3 — preservation is scoped to the SAME scan, and never runs the other way", () => {
  const fresh = {
    brand: "acme.com",
    date: "2026-07-24",
    engine: "perplexity",
    scan_id: "scan-2",
    citation_denominator: null,
    citation_state: NOT_ASSESSED,
    citation_state_reason: CITATION_STATE_REASONS.DENOMINATOR_UNRECOVERABLE,
  };
  const otherScan = {
    brand: "acme.com",
    date: "2026-07-24",
    engine: "perplexity",
    scan_id: "scan-1",
    citation_share_pct: 50,
    citation_denominator: 4,
    citation_state: MEASURED,
  };
  const out = preserveMeasuredDenominator(fresh, otherScan);
  assert.equal(out.preserved, false, "another scan's pool over this scan's counts is a Frankenstein row");
  assert.equal(out.row.citation_denominator, null);

  // A pre-015 stored row (state NULL, no denominator) cannot rescue anything.
  assert.equal(
    preserveMeasuredDenominator(fresh, {
      ...otherScan,
      scan_id: "scan-2",
      citation_denominator: null,
      citation_state: null,
    }).preserved,
    false
  );

  // And a fresh REAL number always wins over a stored unknown — that is how a
  // re-run heals a row once the evidence is back.
  const healed = preserveMeasuredDenominator(
    { ...fresh, citation_denominator: 3, citation_share_pct: 33.3, citation_state: MEASURED },
    { ...otherScan, scan_id: "scan-2", citation_denominator: null, citation_state: NOT_ASSESSED }
  );
  assert.equal(healed.preserved, false);
  assert.equal(healed.row.citation_denominator, 3);
});

// ---------------------------------------------------------------------------
// Reporting (requirements 3 and 4): counted, printed, never silently skipped
// ---------------------------------------------------------------------------

test("R4.3.3 — the report states every outcome, including the ones that are zero", () => {
  const tally = createCitationDenominatorTally();
  tally.denominatorOutcomes[DENOMINATOR_OUTCOME.SLICE_CARRIED] = 3;
  tally.denominatorOutcomes[DENOMINATOR_OUTCOME.UNRECOVERABLE] = 2;
  tally.metricsRowsByCitationState.not_assessed = 2;
  tally.denominatorPreserved = 1;
  tally.unrecoverableSlices = [
    { scanId: "s1", brand: "acme.com", date: "2026-07-24", engine: "perplexity", detail: UNRECOVERABLE_DETAIL.MISSING_CITATIONS_STATE },
  ];

  const text = formatCitationDenominatorReport(tally).join("\n");
  assert.match(text, /engine slices considered: 5/);
  assert.match(text, /already on the stored summary: 3/);
  assert.match(text, /re-derived from surviving prompt rows: 0/, "a zero outcome is printed, not omitted");
  assert.match(text, /UNRECOVERABLE, stored as unmeasured: 2/);
  assert.match(text, /preserved over a fresh unknown: 1/);
  assert.match(
    text,
    /perplexity \(scan s1\): result_rows_predate_citations_state/,
    "each one is named with its scan and its reason, not just counted"
  );
});

test("R4.3.3 — a run that classified nothing says so, instead of printing a wall of zeros that looks clean", () => {
  const text = formatCitationDenominatorReport(createCitationDenominatorTally()).join("\n");
  assert.match(text, /engine slices considered: 0/);
  assert.match(text, /no engine slice was replayed at all/);
  assert.match(text, /not the same as finding nothing to do/);
});

// ---------------------------------------------------------------------------
// End to end: the three states must still be three states after a round trip
// ---------------------------------------------------------------------------

test("R4.3.3 — unmeasured and zero stay distinguishable THROUGH storage, not just at write time", async () => {
  const brand = "roundtrip-r433.com";

  const unknown = buildHistoricalMetricsRows({
    scanId: "scan-unknown",
    rawResults: preR222Scan(),
    brandKey: brand,
    dateOnly: "2026-07-24",
    promptResultRows: [],
  }).rows.find((r) => r.engine === "perplexity");

  const zeroRaw = preR222Scan();
  zeroRaw.engines.perplexity.non_branded_with_answer = 0;
  zeroRaw.engines.perplexity.cited_non_branded = 0;
  const zero = buildHistoricalMetricsRows({
    scanId: "scan-zero",
    rawResults: zeroRaw,
    brandKey: brand,
    dateOnly: "2026-07-25",
    promptResultRows: [],
  }).rows.find((r) => r.engine === "perplexity");

  const measuredRaw = preR222Scan();
  measuredRaw.engines.perplexity.citation_denominator = 2;
  const measured = buildHistoricalMetricsRows({
    scanId: "scan-measured",
    rawResults: measuredRaw,
    brandKey: brand,
    dateOnly: "2026-07-26",
    promptResultRows: [],
  }).rows.find((r) => r.engine === "perplexity");

  // `{ client: null }` is the memory transport — the same code path, the same
  // upsert key, no live database (src/server/db/analytics.js).
  await upsertBrandMetricsDaily([unknown, zero, measured], { client: null });
  const series = await getBrandMetricsSeries(brand, { engine: "perplexity" }, { client: null });
  const byDate = Object.fromEntries(series.map((r) => [r.date, r]));

  assert.equal(byDate["2026-07-24"].citation_denominator, null);
  assert.equal(
    byDate["2026-07-24"].citation_state_reason,
    CITATION_STATE_REASONS.DENOMINATOR_UNRECOVERABLE
  );
  assert.equal(byDate["2026-07-25"].citation_denominator, 0);
  assert.equal(
    byDate["2026-07-25"].citation_state_reason,
    CITATION_STATE_REASONS.NO_OBSERVED_CITATION_POOL
  );
  assert.equal(byDate["2026-07-26"].citation_denominator, 2);
  assert.equal(byDate["2026-07-26"].citation_state, MEASURED);

  // The distinction a `?? 0` anywhere in the chain would destroy.
  assert.notEqual(
    byDate["2026-07-24"].citation_denominator,
    byDate["2026-07-25"].citation_denominator,
    "'nobody recorded the pool' must not read the same as 'the pool was empty'"
  );
  assert.notEqual(
    byDate["2026-07-24"].citation_state_reason,
    byDate["2026-07-25"].citation_state_reason
  );
  // Both share NULL, so the REASON is the only thing that tells them apart —
  // which is exactly why the reason is stored and not derived at read time.
  assert.equal(byDate["2026-07-24"].citation_share_pct, null);
  assert.equal(byDate["2026-07-25"].citation_share_pct, null);
});

// ---------------------------------------------------------------------------
// The JS vocabulary and the SQL that has to accept it must not drift
// ---------------------------------------------------------------------------

test("R4.3.3 — migration 015 accepts exactly the reason tokens the code emits", async () => {
  const sql = await readFile(
    path.join(REPO, "supabase/migrations/015_brand_metrics_citation_state.sql"),
    "utf8"
  );
  for (const token of Object.values(CITATION_STATE_REASONS)) {
    assert.match(
      sql,
      new RegExp(`'${token}'`),
      `migration 015 would reject '${token}', which src/shared/analytics/rollup.js writes`
    );
  }
  // The three columns the rollup row now carries must all be added.
  for (const column of ["citation_denominator", "citation_state", "citation_state_reason"]) {
    assert.match(sql, new RegExp(`ADD COLUMN IF NOT EXISTS ${column}\\b`));
  }
  // And the agreement constraint must pin the distinction this task is about:
  // unrecoverable means NULL, never 0.
  assert.match(
    sql,
    /citation_denominator_unrecoverable'\s*\n\s*AND citation_denominator IS NULL/,
    "the storage layer itself must refuse an 'unrecoverable' row that carries a 0"
  );
});
