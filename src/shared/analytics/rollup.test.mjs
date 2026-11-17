import test from "node:test";
import assert from "node:assert/strict";
import {
  IST_OFFSET_MS,
  toDateOnly,
  unionPromptCounts,
  computeBrandRollups,
  summaryToMetricsRow,
  buildMetricsRows,
  SOV_STATE_REASONS,
} from "./rollup.js";
import { ENGINE_MEASUREMENT_STATE, ENGINE_STATE_REASONS } from "../scoring/enginePipeline.js";

/**
 * Coverage for the single source of truth behind brand_metrics_daily rows —
 * shared by the live pipeline (src/server/workers/scanWorker.js, which just
 * imports + re-exports these names) and the historical backfill
 * (scripts/backfill-analytics.mjs, via its buildBackfillMetricsRows
 * adapter). This file is the one place the rollup MATH itself is exercised;
 * src/server/workers/scanChunk.test.mjs continues to cover the orchestration
 * that calls into it (runFinalizePhase, etc.) untouched.
 */

test("IST_OFFSET_MS — is exactly +5:30 (India-first product, SERP_GEO defaults to 'in')", () => {
  assert.equal(IST_OFFSET_MS, 5.5 * 60 * 60 * 1000);
});

// ---------------------------------------------------------------------------
// toDateOnly — IST calendar-day bucketing
// ---------------------------------------------------------------------------

test("toDateOnly — a 00:30 IST timestamp buckets to that IST day, not the previous UTC day", () => {
  // 2026-07-23T19:00:00Z + 5:30 = 2026-07-24T00:30 IST -> must bucket as
  // 2026-07-24, even though the UTC calendar day is still 2026-07-23.
  assert.equal(toDateOnly("2026-07-23T19:00:00.000Z"), "2026-07-24");
});

test("toDateOnly — a UTC-morning timestamp (still the same IST day) buckets unchanged", () => {
  assert.equal(toDateOnly("2026-07-23T10:00:00.000Z"), "2026-07-23");
});

test("toDateOnly — returns null for an unparseable timestamp", () => {
  assert.equal(toDateOnly("not-a-date"), null);
});

// ---------------------------------------------------------------------------
// unionPromptCounts
// ---------------------------------------------------------------------------

test("unionPromptCounts — dedupes a prompt probed by N engines to 1", () => {
  const rows = [
    { query: "Best CRM tools", engine: "aio", answered: true, mentioned: true, is_branded_query: false },
    { query: "Best CRM tools", engine: "chatgpt", answered: true, mentioned: false, is_branded_query: false },
    { query: "Best CRM tools", engine: "perplexity", answered: true, mentioned: true, is_branded_query: false },
    { query: "another prompt", engine: "aio", answered: false, mentioned: false, is_branded_query: false },
  ];
  const result = unionPromptCounts(rows);
  assert.equal(result.total, 2, "3 engine-probes of the same prompt + 1 other prompt -> 2 distinct prompts");
  assert.equal(result.answered, 1, "'Best CRM tools' answered on >=1 engine, 'another prompt' was not");
  assert.equal(result.mentioned, 1, "'Best CRM tools' mentioned on >=1 engine (aio/perplexity), 'another prompt' never");
});

test("unionPromptCounts — is case/whitespace-insensitive and excludes branded rows", () => {
  const rows = [
    { query: "  Best CRM Tools  ", engine: "aio", answered: true, mentioned: true, is_branded_query: false },
    { query: "best crm tools", engine: "chatgpt", answered: true, mentioned: false, is_branded_query: false },
    { query: "Acme brand query", engine: "aio", answered: true, mentioned: true, is_branded_query: true },
  ];
  const result = unionPromptCounts(rows);
  assert.equal(result.total, 1, "differently-cased/whitespaced text normalizes to the same prompt; branded row excluded");
});

test("unionPromptCounts — returns null when every row is branded or there are no rows", () => {
  assert.equal(
    unionPromptCounts([{ query: "q", engine: "aio", answered: true, mentioned: true, is_branded_query: true }]),
    null
  );
  assert.equal(unionPromptCounts([]), null);
  assert.equal(unionPromptCounts(undefined), null);
});

// ---------------------------------------------------------------------------
// computeBrandRollups (P1.2/P1.3) — sov_pct / sentiment_avg / position_avg
// ---------------------------------------------------------------------------

function brandRow(overrides = {}) {
  return {
    engine: "aio",
    is_branded_query: false,
    name: "Acme",
    is_self: true,
    mentioned: true,
    position: null,
    sentiment: null,
    ...overrides,
  };
}

test("computeBrandRollups — sov_pct is self mentions divided by ALL tracked-brand mentions (self + rivals)", () => {
  const rows = [
    brandRow({ name: "Acme", is_self: true, mentioned: true }),
    brandRow({ name: "Rival A", is_self: false, mentioned: false }),
    brandRow({ name: "Acme", is_self: true, mentioned: true }),
    brandRow({ name: "Rival A", is_self: false, mentioned: true }),
  ];
  const result = computeBrandRollups(rows);
  // self mentioned 2/2 answers; rival mentioned 1/2 -> 3 total tracked-brand mentions, 2 self.
  assert.equal(result.sov_pct, Math.round((2 / 3) * 1000) / 10);
});

test("computeBrandRollups — sentiment_avg/position_avg are the mean of the SELF brand's non-null values only", () => {
  const rows = [
    brandRow({ name: "Acme", is_self: true, mentioned: true, position: 1, sentiment: 100 }),
    brandRow({ name: "Rival A", is_self: false, mentioned: true, position: 1, sentiment: 0 }), // must not leak into self's average
    brandRow({ name: "Acme", is_self: true, mentioned: true, position: 2, sentiment: 0 }),
  ];
  const result = computeBrandRollups(rows);
  assert.equal(result.sentiment_avg, 50, "mean of self's [100, 0], rival's 0 excluded");
  assert.equal(result.position_avg, 1.5, "mean of self's [1, 2]");
});

test("computeBrandRollups — a brand's null position/sentiment (not mentioned) is excluded from the mean, not treated as 0", () => {
  const rows = [
    brandRow({ is_self: true, mentioned: true, position: 4, sentiment: 100 }),
    brandRow({ is_self: true, mentioned: false, position: null, sentiment: null }), // absent answer -- must not drag the average toward 0
  ];
  const result = computeBrandRollups(rows);
  assert.equal(result.sentiment_avg, 100, "the null entry must be excluded, not averaged in as 0");
  assert.equal(result.position_avg, 4);
});

test("computeBrandRollups — excludes branded-query rows, same pool visibility_pct is computed over", () => {
  const rows = [
    brandRow({ is_self: true, mentioned: true, position: 1, sentiment: 100, is_branded_query: false }),
    brandRow({ is_self: true, mentioned: true, position: 99, sentiment: 0, is_branded_query: true }), // must not count
  ];
  const result = computeBrandRollups(rows);
  assert.equal(result.position_avg, 1);
  assert.equal(result.sentiment_avg, 100);
});

test("computeBrandRollups — engine filter scopes to one engine; omitting it blends every engine (for the 'all' row)", () => {
  const rows = [
    brandRow({ engine: "aio", is_self: true, mentioned: true, position: 1, sentiment: 100 }),
    brandRow({ engine: "chatgpt", is_self: true, mentioned: true, position: 3, sentiment: 0 }),
  ];
  const aioOnly = computeBrandRollups(rows, { engine: "aio" });
  assert.equal(aioOnly.position_avg, 1);
  assert.equal(aioOnly.sentiment_avg, 100);

  const blended = computeBrandRollups(rows); // no engine filter
  assert.equal(blended.position_avg, 2, "mean of [1, 3] across both engines");
  assert.equal(blended.sentiment_avg, 50, "mean of [100, 0] across both engines");
});

test("computeBrandRollups — returns all-null when there are no rows (historical/backfill path, no per-brand source), and SAYS it was not assessed", () => {
  const expected = {
    sov_pct: null,
    // R4.3.2: an empty result is not a clean one. "No judgment rows at all" is
    // never-ran, and the row has to carry that rather than a bare null.
    sov_state: ENGINE_MEASUREMENT_STATE.NOT_ASSESSED,
    sov_state_reason: SOV_STATE_REASONS.NO_RESULTS,
    sentiment_avg: null,
    position_avg: null,
  };
  assert.deepEqual(computeBrandRollups([]), expected);
  assert.deepEqual(computeBrandRollups(undefined), expected);
});

test("computeBrandRollups — sov_pct is null when nobody (self or rival) was ever mentioned, never a divide-by-zero", () => {
  const rows = [
    brandRow({ is_self: true, mentioned: false }),
    brandRow({ name: "Rival", is_self: false, mentioned: false }),
  ];
  const result = computeBrandRollups(rows);
  assert.equal(result.sov_pct, null);
  // The roster was fine; it is the answers that named nobody. That is a
  // prompt-set problem, and the reason has to point at the prompt set.
  assert.equal(result.sov_state, ENGINE_MEASUREMENT_STATE.NOT_ASSESSED);
  assert.equal(result.sov_state_reason, SOV_STATE_REASONS.EMPTY_ELICITING_POOL);
});

// ---------------------------------------------------------------------------
// R4.3.2 — a self-only roster is a tautology, not a 100% share of voice.
//
// This is the canonical false success of this codebase and it survived two
// earlier fixes: enginePipeline.js stopped emitting a self-only
// share_of_voice_pct, and R2.7.1 stopped the dashboard donut rendering one,
// but neither touched THIS producer, which is the one that writes the durable
// brand_metrics_daily row a trend chart and any export will read.
// ---------------------------------------------------------------------------

test("computeBrandRollups — a self-only roster yields NO share, not 100 (R4.3.2, the tautology)", () => {
  const rows = [
    brandRow({ name: "Acme", is_self: true, mentioned: true }),
    brandRow({ name: "Acme", is_self: true, mentioned: true }),
    brandRow({ name: "Acme", is_self: true, mentioned: false }),
  ];
  const result = computeBrandRollups(rows);
  assert.notEqual(
    result.sov_pct,
    100,
    "self / self is 1 by construction -- storing it as 100% is a lie about a measurement that never happened"
  );
  assert.equal(result.sov_pct, null, "undefined, and therefore null -- not 0 and not 100");
  assert.equal(result.sov_state, ENGINE_MEASUREMENT_STATE.NOT_ASSESSED);
  assert.equal(
    result.sov_state_reason,
    SOV_STATE_REASONS.SELF_ONLY_ROSTER,
    "the reason must name the ROSTER -- sending the operator to rewrite their prompt set would be the wrong instruction"
  );
});

test("computeBrandRollups — self-only AND nobody mentioned: the reason still names the roster, the outer failure", () => {
  const rows = [brandRow({ is_self: true, mentioned: false }), brandRow({ is_self: true, mentioned: false })];
  const result = computeBrandRollups(rows);
  assert.equal(result.sov_pct, null);
  assert.equal(result.sov_state_reason, SOV_STATE_REASONS.SELF_ONLY_ROSTER);
});

test("computeBrandRollups — a rival that was TRACKED but never mentioned still makes 100 an honest measurement", () => {
  // The distinction the fix turns on: a rival in the roster contributes a real
  // 0 to the denominator, so "every mention was ours" is a finding. A rival
  // that was never tracked contributes nothing, so it is not.
  const rows = [
    brandRow({ name: "Acme", is_self: true, mentioned: true }),
    brandRow({ name: "RivalCo", is_self: false, mentioned: false }),
  ];
  const result = computeBrandRollups(rows);
  assert.equal(result.sov_pct, 100);
  assert.equal(result.sov_state, ENGINE_MEASUREMENT_STATE.MEASURED);
  assert.equal(result.sov_state_reason, null, "measured carries no reason -- nothing needs explaining");
});

test("computeBrandRollups — rivals named and we never were is measured_zero with a real 0, never null (standing rule 1)", () => {
  const rows = [
    brandRow({ name: "Acme", is_self: true, mentioned: false }),
    brandRow({ name: "RivalCo", is_self: false, mentioned: true }),
    brandRow({ name: "OtherCo", is_self: false, mentioned: true }),
  ];
  const result = computeBrandRollups(rows);
  assert.equal(result.sov_pct, 0, "a measured zero is a finding and must stay a number");
  assert.equal(result.sov_state, ENGINE_MEASUREMENT_STATE.MEASURED_ZERO);
  assert.equal(result.sov_state_reason, SOV_STATE_REASONS.BRAND_NOT_VISIBLE);
  assert.notEqual(
    result.sov_state,
    ENGINE_MEASUREMENT_STATE.NOT_ASSESSED,
    "measured-zero must not collapse into not-assessed -- that is the distinction the whole vocabulary exists for"
  );
});

test("computeBrandRollups — the roster is judged PER ENGINE, so one engine's missing rivals cannot borrow another's", () => {
  const rows = [
    // aio was judged against a rival; chatgpt's slice carries only us.
    brandRow({ engine: "aio", name: "Acme", is_self: true, mentioned: true }),
    brandRow({ engine: "aio", name: "RivalCo", is_self: false, mentioned: true }),
    brandRow({ engine: "chatgpt", name: "Acme", is_self: true, mentioned: true }),
  ];
  assert.equal(computeBrandRollups(rows, { engine: "aio" }).sov_pct, 50);
  const chatgpt = computeBrandRollups(rows, { engine: "chatgpt" });
  assert.equal(chatgpt.sov_pct, null);
  assert.equal(chatgpt.sov_state_reason, SOV_STATE_REASONS.SELF_ONLY_ROSTER);
  // The blend sees the rival, so it is measurable even though one slice was not.
  assert.equal(computeBrandRollups(rows).sov_pct, Math.round((2 / 3) * 1000) / 10);
});

test("computeBrandRollups — a self-only roster does NOT suppress sentiment_avg/position_avg (they need no rival)", () => {
  // Scope guard: SOV is undefined without rivals; the self brand's own
  // sentiment and position are not, and blanking them would be a second bug.
  const rows = [
    brandRow({ is_self: true, mentioned: true, position: 2, sentiment: 100 }),
    brandRow({ is_self: true, mentioned: true, position: 4, sentiment: 50 }),
  ];
  const result = computeBrandRollups(rows);
  assert.equal(result.sov_pct, null);
  assert.equal(result.sentiment_avg, 75);
  assert.equal(result.position_avg, 3);
});

test("computeBrandRollups — the state vocabulary is R2.1.1's, not a third one invented here", () => {
  // If someone adds a fifth state token, this fails before it reaches a chart.
  const reachable = [
    computeBrandRollups([]),
    computeBrandRollups([brandRow({ is_self: true, mentioned: true })]),
    computeBrandRollups([brandRow({ is_self: true, mentioned: true }), brandRow({ name: "R", is_self: false, mentioned: true })]),
    computeBrandRollups([brandRow({ is_self: true, mentioned: false }), brandRow({ name: "R", is_self: false, mentioned: true })]),
    computeBrandRollups([brandRow({ is_self: true, mentioned: false }), brandRow({ name: "R", is_self: false, mentioned: false })]),
  ];
  const known = new Set(Object.values(ENGINE_MEASUREMENT_STATE));
  const knownReasons = new Set(Object.values(SOV_STATE_REASONS));
  for (const r of reachable) {
    assert.ok(known.has(r.sov_state), `${r.sov_state} is not an ENGINE_MEASUREMENT_STATE`);
    assert.ok(
      r.sov_state_reason === null || knownReasons.has(r.sov_state_reason),
      `${r.sov_state_reason} is not a SOV_STATE_REASONS token`
    );
    // Standing rule 5, at the producer: a number exists in exactly the two
    // measured states and in neither of the others.
    const isMeasured = r.sov_state === ENGINE_MEASUREMENT_STATE.MEASURED || r.sov_state === ENGINE_MEASUREMENT_STATE.MEASURED_ZERO;
    assert.equal(Number.isFinite(r.sov_pct), isMeasured, `${r.sov_state} must ${isMeasured ? "" : "not "}carry a number`);
  }
  // And SOV_STATE_REASONS really is ENGINE_STATE_REASONS plus one, not a fork.
  for (const [key, value] of Object.entries(ENGINE_STATE_REASONS)) {
    assert.equal(SOV_STATE_REASONS[key], value, `SOV_STATE_REASONS.${key} diverged from ENGINE_STATE_REASONS`);
  }
});

// ---------------------------------------------------------------------------
// summaryToMetricsRow — including the `?? 0` decision (FIX B)
// ---------------------------------------------------------------------------

test("summaryToMetricsRow — prompts_total/prompts_mentioned default to 0 (not null) when absent from summary", () => {
  const row = summaryToMetricsRow({
    brand: "acme.com",
    date: "2026-07-24",
    engine: "aio",
    scanId: "scan-1",
    promptSetId: "ps-1",
    summary: { non_branded_with_answer: 5 }, // non_branded_queries / mentioned_non_branded deliberately absent
    answeredKey: "non_branded_with_answer",
  });
  assert.equal(row.prompts_total, 0, "matches the backfill's ?? 0 default (not the pre-fix worker's ?? null)");
  assert.equal(row.prompts_mentioned, 0);
  assert.equal(row.prompts_answered, 5);
});

test("summaryToMetricsRow — computes citation_share_pct from cited/answered when the summary doesn't carry it directly", () => {
  const row = summaryToMetricsRow({
    brand: "acme.com",
    date: "2026-07-24",
    engine: "aio",
    scanId: "scan-1",
    promptSetId: null,
    summary: { non_branded_with_answer: 8, cited_non_branded: 2 },
    answeredKey: "non_branded_with_answer",
  });
  assert.equal(row.citation_share_pct, 25, "2/8 = 25%");
});

test("summaryToMetricsRow — prefers an explicit citation_share_pct on the summary over recomputing it", () => {
  const row = summaryToMetricsRow({
    brand: "acme.com",
    date: "2026-07-24",
    engine: "aio",
    scanId: "scan-1",
    promptSetId: null,
    summary: { non_branded_with_answer: 8, cited_non_branded: 2, citation_share_pct: 99.9 },
    answeredKey: "non_branded_with_answer",
  });
  assert.equal(row.citation_share_pct, 99.9);
});

test("summaryToMetricsRow — sov_pct/sentiment_avg/position_avg are null when brandRollup is omitted (backfill's contract — no per-brand source)", () => {
  const row = summaryToMetricsRow({
    brand: "acme.com",
    date: "2026-07-24",
    engine: "aio",
    scanId: "scan-1",
    promptSetId: null,
    summary: { non_branded_with_answer: 3 },
    answeredKey: "non_branded_with_answer",
  });
  assert.equal(row.sov_pct, null);
  assert.equal(row.sentiment_avg, null);
  assert.equal(row.position_avg, null);
});

test("summaryToMetricsRow — a supplied brandRollup (P1.2/P1.3) populates sov_pct/sentiment_avg/position_avg", () => {
  const row = summaryToMetricsRow({
    brand: "acme.com",
    date: "2026-07-24",
    engine: "aio",
    scanId: "scan-1",
    promptSetId: null,
    summary: { non_branded_with_answer: 3 },
    answeredKey: "non_branded_with_answer",
    brandRollup: { sov_pct: 66.7, sentiment_avg: 75, position_avg: 1.5 },
  });
  assert.equal(row.sov_pct, 66.7);
  assert.equal(row.sentiment_avg, 75);
  assert.equal(row.position_avg, 1.5);
});

test("summaryToMetricsRow — a brandRollup with only some fields set (e.g. sov_pct null because nobody was mentioned) leaves just those null", () => {
  const row = summaryToMetricsRow({
    brand: "acme.com",
    date: "2026-07-24",
    engine: "aio",
    scanId: "scan-1",
    promptSetId: null,
    summary: { non_branded_with_answer: 3 },
    answeredKey: "non_branded_with_answer",
    brandRollup: { sov_pct: null, sentiment_avg: 40, position_avg: null },
  });
  assert.equal(row.sov_pct, null);
  assert.equal(row.sentiment_avg, 40);
  assert.equal(row.position_avg, null);
});

// ---------------------------------------------------------------------------
// buildMetricsRows — multi-engine and single-engine
// ---------------------------------------------------------------------------

test("buildMetricsRows — multi-engine: the blended 'all' row uses UNION counts, not the per-engine sum", () => {
  const engineSummaries = {
    aio: {
      non_branded_queries: 10,
      non_branded_with_answer: 8,
      mentioned_non_branded: 3,
      cited_non_branded: 2,
      visibility_pct: 37.5,
      share_of_ai_pct: 37.5,
    },
    chatgpt: {
      non_branded_queries: 10,
      non_branded_with_answer: 10,
      mentioned_non_branded: 6,
      cited_non_branded: 4,
      visibility_pct: 60,
      share_of_ai_pct: 60,
    },
  };
  // Same prompt set probed by both engines: q1 and q2 each appear twice
  // (once per engine) in the persisted prompt_results rows.
  const promptResultRows = [
    { query: "q1", engine: "aio", answered: true, mentioned: true, is_branded_query: false },
    { query: "q1", engine: "chatgpt", answered: true, mentioned: false, is_branded_query: false },
    { query: "q2", engine: "aio", answered: false, mentioned: false, is_branded_query: false },
    { query: "q2", engine: "chatgpt", answered: true, mentioned: true, is_branded_query: false },
  ];
  const headline = { visibility_index_pct: 48.75, engines_counted: 2 };

  const rows = buildMetricsRows({
    isMultiEngine: true,
    brandKey: "acme.com",
    dateOnly: "2026-07-24",
    scanId: "scan-1",
    promptSetId: "abc123",
    summary: {},
    engineSummaries,
    headline,
    promptResultRows,
  });

  assert.equal(rows.length, 3, "aio + chatgpt + blended all");
  const allRow = rows.find((r) => r.engine === "all");

  // The per-engine SUM would be 4 (2 rows x 2 engines each); union must
  // instead report the 2 distinct prompts actually tracked.
  assert.equal(allRow.prompts_total, 2, "union across engines, not the per-engine sum");
  assert.equal(allRow.prompts_answered, 2, "q1 answered on aio, q2 answered on chatgpt -> both count once");
  assert.equal(allRow.prompts_mentioned, 2, "q1 mentioned on aio, q2 mentioned on chatgpt -> both count once");
  assert.equal(allRow.visibility_pct, 48.75, "the 'all' row's visibility comes from the real headline blend");
  // sum-based rate (not union): sumCited=6, sumAnswered=18 across the two engine rows above.
  assert.equal(allRow.citation_share_pct, Math.round((6 / 18) * 1000) / 10);
});

test("buildMetricsRows — multi-engine: per-engine rows carry their own visibility/citation numbers", () => {
  const engineSummaries = {
    aio: {
      non_branded_queries: 10,
      non_branded_with_answer: 8,
      mentioned_non_branded: 3,
      cited_non_branded: 2,
      visibility_pct: 37.5,
      share_of_ai_pct: 37.5,
    },
    chatgpt: {
      non_branded_queries: 10,
      non_branded_with_answer: 10,
      mentioned_non_branded: 6,
      cited_non_branded: 4,
      visibility_pct: 60,
      share_of_ai_pct: 60,
    },
  };
  const rows = buildMetricsRows({
    isMultiEngine: true,
    brandKey: "acme.com",
    dateOnly: "2026-07-24",
    scanId: "scan-1",
    promptSetId: "abc123",
    summary: {},
    engineSummaries,
    headline: { visibility_index_pct: 48.75 },
    promptResultRows: [],
  });

  const aioRow = rows.find((r) => r.engine === "aio");
  const chatgptRow = rows.find((r) => r.engine === "chatgpt");

  assert.equal(aioRow.visibility_pct, 37.5);
  assert.equal(aioRow.prompts_total, 10);
  assert.equal(aioRow.prompts_answered, 8);
  assert.equal(aioRow.prompts_mentioned, 3);
  assert.equal(aioRow.citation_share_pct, Math.round((2 / 8) * 1000) / 10);
  assert.equal(aioRow.sov_pct, null);
  assert.equal(aioRow.sentiment_avg, null);
  assert.equal(aioRow.position_avg, null);

  assert.equal(chatgptRow.visibility_pct, 60);
  assert.equal(chatgptRow.citation_share_pct, Math.round((4 / 10) * 1000) / 10);

  rows.forEach((r) => {
    assert.equal(r.prompt_set_id, "abc123");
    assert.equal(r.scan_id, "scan-1");
    assert.equal(r.date, "2026-07-24");
    assert.equal(r.brand, "acme.com");
  });
});

test("buildMetricsRows — single engine (aio only): 'aio' and 'all' rows are identical apart from the engine label", () => {
  const summary = {
    non_branded_queries: 20,
    non_branded_with_aio: 18,
    mentioned_non_branded: 9,
    visibility_pct: 50,
    share_of_ai_pct: 50,
    citation_share_pct: 22.2,
  };
  const rows = buildMetricsRows({
    isMultiEngine: false,
    brandKey: "acme.com",
    dateOnly: "2026-07-24",
    scanId: "scan-2",
    promptSetId: "xyz",
    summary,
    engineSummaries: null,
    headline: null,
    promptResultRows: [],
  });

  assert.equal(rows.length, 2);
  const aio = rows.find((r) => r.engine === "aio");
  const all = rows.find((r) => r.engine === "all");
  assert.equal(aio.prompts_total, 20);
  assert.equal(aio.prompts_answered, 18);
  assert.equal(aio.prompts_mentioned, 9);
  assert.equal(aio.citation_share_pct, 22.2);
  assert.deepEqual(
    { ...all, engine: "x" },
    { ...aio, engine: "x" },
    "aio and all rows must be identical apart from the engine label"
  );
});

test("buildMetricsRows — single engine: prompts_total/prompts_mentioned default to 0 when the summary omits them", () => {
  const rows = buildMetricsRows({
    isMultiEngine: false,
    brandKey: "acme.com",
    dateOnly: "2026-07-24",
    scanId: "scan-3",
    promptSetId: null,
    summary: { non_branded_with_aio: 4 },
    engineSummaries: null,
    headline: null,
    promptResultRows: [],
  });
  const aio = rows.find((r) => r.engine === "aio");
  assert.equal(aio.prompts_total, 0);
  assert.equal(aio.prompts_mentioned, 0);
  assert.equal(aio.prompts_answered, 4);
});

test("buildMetricsRows — multi-engine: falls back to a single engine's N when promptResultRows is empty (no union data)", () => {
  const engineSummaries = {
    aio: { non_branded_queries: 15, non_branded_with_answer: 12, mentioned_non_branded: 5, cited_non_branded: 3 },
  };
  const rows = buildMetricsRows({
    isMultiEngine: true,
    brandKey: "acme.com",
    dateOnly: "2026-07-24",
    scanId: "scan-4",
    promptSetId: null,
    summary: {},
    engineSummaries,
    headline: { visibility_index_pct: 41.7 },
    promptResultRows: [], // no per-prompt rows -> unionPromptCounts returns null
  });
  const allRow = rows.find((r) => r.engine === "all");
  assert.equal(allRow.prompts_total, 15, "falls back to the (single) engine's non_branded_queries");
  assert.equal(allRow.prompts_answered, null, "no union data available");
  assert.equal(allRow.prompts_mentioned, null);
});

// ---------------------------------------------------------------------------
// buildMetricsRows + brandJudgmentRows (P1.2/P1.3) — sov/sentiment/position
// wiring, and the historical/backfill omission contract.
// ---------------------------------------------------------------------------

test("buildMetricsRows — multi-engine: each per-engine row gets THAT engine's brand rollup; the blended 'all' row blends across every engine", () => {
  const engineSummaries = {
    aio: { non_branded_queries: 10, non_branded_with_answer: 8, mentioned_non_branded: 3, cited_non_branded: 2, visibility_pct: 37.5, share_of_ai_pct: 37.5 },
    chatgpt: { non_branded_queries: 10, non_branded_with_answer: 10, mentioned_non_branded: 6, cited_non_branded: 4, visibility_pct: 60, share_of_ai_pct: 60 },
  };
  const brandJudgmentRows = [
    // aio: self mentioned+position1+sentiment100, rival not mentioned -> sov 1/1
    { engine: "aio", is_branded_query: false, name: "acme.com", is_self: true, mentioned: true, position: 1, sentiment: 100 },
    { engine: "aio", is_branded_query: false, name: "RivalCo", is_self: false, mentioned: false, position: null, sentiment: null },
    // chatgpt: self mentioned+position3+sentiment0, rival mentioned -> sov 1/2
    { engine: "chatgpt", is_branded_query: false, name: "acme.com", is_self: true, mentioned: true, position: 3, sentiment: 0 },
    { engine: "chatgpt", is_branded_query: false, name: "RivalCo", is_self: false, mentioned: true, position: 1, sentiment: 50 },
    // branded row on either engine must never leak into any of this.
    { engine: "aio", is_branded_query: true, name: "acme.com", is_self: true, mentioned: true, position: 99, sentiment: 0 },
  ];

  const rows = buildMetricsRows({
    isMultiEngine: true,
    brandKey: "acme.com",
    dateOnly: "2026-07-24",
    scanId: "scan-1",
    promptSetId: "abc123",
    summary: {},
    engineSummaries,
    headline: { visibility_index_pct: 48.75 },
    promptResultRows: [],
    brandJudgmentRows,
  });

  const aioRow = rows.find((r) => r.engine === "aio");
  const chatgptRow = rows.find((r) => r.engine === "chatgpt");
  const allRow = rows.find((r) => r.engine === "all");

  assert.equal(aioRow.sov_pct, 100, "aio: self mentioned, rival not -> 1/1");
  assert.equal(aioRow.sentiment_avg, 100);
  assert.equal(aioRow.position_avg, 1);

  assert.equal(chatgptRow.sov_pct, 50, "chatgpt: self + rival both mentioned -> 1/2");
  assert.equal(chatgptRow.sentiment_avg, 0);
  assert.equal(chatgptRow.position_avg, 3);

  // Blended 'all': self mentioned 2/2 answers, rival 1/2 -> 3 total mentions, 2 self -> sov 66.7.
  assert.equal(allRow.sov_pct, Math.round((2 / 3) * 1000) / 10);
  assert.equal(allRow.sentiment_avg, 50, "mean of self's [100, 0] across both engines");
  assert.equal(allRow.position_avg, 2, "mean of self's [1, 3] across both engines");
});

test("buildMetricsRows — single engine (aio only): 'aio' and 'all' rows carry the same computed brand rollup", () => {
  const summary = {
    non_branded_queries: 20,
    non_branded_with_aio: 18,
    mentioned_non_branded: 9,
    visibility_pct: 50,
    share_of_ai_pct: 50,
    citation_share_pct: 22.2,
  };
  const brandJudgmentRows = [
    { engine: "aio", is_branded_query: false, name: "acme.com", is_self: true, mentioned: true, position: 2, sentiment: 100 },
    { engine: "aio", is_branded_query: false, name: "RivalCo", is_self: false, mentioned: true, position: 1, sentiment: 50 },
  ];
  const rows = buildMetricsRows({
    isMultiEngine: false,
    brandKey: "acme.com",
    dateOnly: "2026-07-24",
    scanId: "scan-2",
    promptSetId: "xyz",
    summary,
    engineSummaries: null,
    headline: null,
    promptResultRows: [],
    brandJudgmentRows,
  });

  const aio = rows.find((r) => r.engine === "aio");
  const all = rows.find((r) => r.engine === "all");
  assert.equal(aio.sov_pct, 50, "self + rival both mentioned -> 1/2");
  assert.equal(aio.sentiment_avg, 100);
  assert.equal(aio.position_avg, 2);
  assert.deepEqual(
    { ...all, engine: "x" },
    { ...aio, engine: "x" },
    "aio and all rows (including sov/sentiment/position) must be identical apart from the engine label"
  );
});

test("buildMetricsRows — brandJudgmentRows omitted entirely (scripts/backfill-analytics.mjs's contract): sov/sentiment/position stay null on every row, everything else unaffected", () => {
  const engineSummaries = {
    aio: { non_branded_queries: 10, non_branded_with_answer: 8, mentioned_non_branded: 3, cited_non_branded: 2, visibility_pct: 37.5, share_of_ai_pct: 37.5 },
  };
  const rows = buildMetricsRows({
    isMultiEngine: true,
    brandKey: "acme.com",
    dateOnly: "2026-07-24",
    scanId: "scan-backfill",
    promptSetId: "abc123",
    summary: {},
    engineSummaries,
    headline: { visibility_index_pct: 37.5 },
    promptResultRows: [],
    // brandJudgmentRows deliberately omitted, matching buildBackfillMetricsRows
    // in scripts/backfill-analytics.mjs (no per-brand source for historical scans).
  });

  rows.forEach((r) => {
    assert.equal(r.sov_pct, null);
    assert.equal(r.sentiment_avg, null);
    assert.equal(r.position_avg, null);
  });
  const aioRow = rows.find((r) => r.engine === "aio");
  assert.equal(aioRow.visibility_pct, 37.5, "unrelated fields are computed exactly as before P1.2/P1.3");
});

test("buildMetricsRows — single-engine (v8.1 vintage) with brandJudgmentRows omitted: sov/sentiment/position stay null too (backfill's OTHER call shape)", () => {
  // Mirrors buildBackfillMetricsRows' second branch exactly (rawResults.summary_stats
  // present, no rawResults.engines) -- the v8.1 AIO-only historical scans.
  const summary = {
    non_branded_queries: 20,
    non_branded_with_aio: 18,
    mentioned_non_branded: 9,
    visibility_pct: 50,
    share_of_ai_pct: 50,
    citation_share_pct: 22.2,
  };
  const rows = buildMetricsRows({
    isMultiEngine: false,
    brandKey: "acme.com",
    dateOnly: "2026-07-24",
    scanId: "scan-backfill-v8",
    promptSetId: "xyz",
    summary,
    engineSummaries: null,
    headline: null,
    promptResultRows: [],
    // brandJudgmentRows omitted, matching buildBackfillMetricsRows' v8.1 branch.
  });
  rows.forEach((r) => {
    assert.equal(r.sov_pct, null);
    assert.equal(r.sentiment_avg, null);
    assert.equal(r.position_avg, null);
  });
  assert.equal(rows.find((r) => r.engine === "aio").visibility_pct, 50);
});

// ---------------------------------------------------------------------------
// R4.3.2 — the state has to survive onto the DURABLE ROW, not just the rollup.
// brand_metrics_daily is what a trend chart and any export read, and
// upsertBrandMetricsDaily passes these objects to the DB verbatim.
// ---------------------------------------------------------------------------

test("summaryToMetricsRow — brandRollup omitted (the backfill's contract) stamps not_assessed/no_results, never an absent state", () => {
  const row = summaryToMetricsRow({
    brand: "acme.com",
    date: "2026-07-24",
    engine: "aio",
    scanId: "scan-1",
    promptSetId: null,
    summary: { non_branded_with_answer: 3 },
    answeredKey: "non_branded_with_answer",
  });
  assert.equal(row.sov_pct, null);
  assert.equal(row.sov_state, ENGINE_MEASUREMENT_STATE.NOT_ASSESSED);
  assert.equal(row.sov_state_reason, SOV_STATE_REASONS.NO_RESULTS);
});

test("summaryToMetricsRow — a self-only-roster rollup writes a null sov_pct and the roster reason onto the row", () => {
  const row = summaryToMetricsRow({
    brand: "acme.com",
    date: "2026-07-24",
    engine: "aio",
    scanId: "scan-1",
    promptSetId: null,
    summary: { non_branded_with_answer: 3 },
    answeredKey: "non_branded_with_answer",
    brandRollup: computeBrandRollups(
      [{ engine: "aio", is_branded_query: false, name: "Acme", is_self: true, mentioned: true }],
      { engine: "aio" }
    ),
  });
  assert.equal(row.sov_pct, null, "a durable 100 here is the worst version of the lie");
  assert.equal(row.sov_state, ENGINE_MEASUREMENT_STATE.NOT_ASSESSED);
  assert.equal(row.sov_state_reason, SOV_STATE_REASONS.SELF_ONLY_ROSTER);
});

test("summaryToMetricsRow — a pre-R4.3.2 rollup object (number, no state) is read as measured, not as not_assessed", () => {
  // Compatibility with an in-process object only. Historical DB rows are NOT
  // read this way -- migration 013 re-derives those, because a stored 100 may
  // be the tautology.
  const measured = summaryToMetricsRow({
    brand: "acme.com", date: "2026-07-24", engine: "aio", scanId: "s", promptSetId: null,
    summary: { non_branded_with_answer: 3 }, answeredKey: "non_branded_with_answer",
    brandRollup: { sov_pct: 66.7, sentiment_avg: 75, position_avg: 1.5 },
  });
  assert.equal(measured.sov_pct, 66.7);
  assert.equal(measured.sov_state, ENGINE_MEASUREMENT_STATE.MEASURED);
  assert.equal(measured.sov_state_reason, null);

  const zero = summaryToMetricsRow({
    brand: "acme.com", date: "2026-07-24", engine: "aio", scanId: "s", promptSetId: null,
    summary: { non_branded_with_answer: 3 }, answeredKey: "non_branded_with_answer",
    brandRollup: { sov_pct: 0, sentiment_avg: null, position_avg: null },
  });
  assert.equal(zero.sov_state, ENGINE_MEASUREMENT_STATE.MEASURED_ZERO, "a legacy 0 is a measurement, exactly as it always was");
  assert.equal(zero.sov_pct, 0);
});

test("buildMetricsRows — a self-only roster writes NO 100 on any row, per-engine or blended (R4.3.2 acceptance)", () => {
  const engineSummaries = {
    aio: { non_branded_queries: 10, non_branded_with_answer: 8, citation_denominator: 8, mentioned_non_branded: 4, cited_non_branded: 2, visibility_pct: 50 },
    chatgpt: { non_branded_queries: 10, non_branded_with_answer: 9, citation_denominator: 9, mentioned_non_branded: 3, cited_non_branded: 1, visibility_pct: 33.3 },
  };
  // Exactly the shape a live scan produces when nobody supplied a competitor
  // and extractCompetitors returned nothing (or was down): every judged row is
  // the brand itself.
  const brandJudgmentRows = [
    { engine: "aio", is_branded_query: false, name: "acme.com", is_self: true, mentioned: true, position: 1, sentiment: 100 },
    { engine: "aio", is_branded_query: false, name: "acme.com", is_self: true, mentioned: true, position: 2, sentiment: 50 },
    { engine: "chatgpt", is_branded_query: false, name: "acme.com", is_self: true, mentioned: true, position: 1, sentiment: 100 },
  ];

  const rows = buildMetricsRows({
    isMultiEngine: true,
    brandKey: "acme.com",
    dateOnly: "2026-07-24",
    scanId: "scan-self-only",
    promptSetId: "abc123",
    summary: {},
    engineSummaries,
    headline: { visibility_index_pct: 41.7 },
    promptResultRows: [],
    brandJudgmentRows,
  });

  assert.equal(rows.length, 3, "aio, chatgpt, all");
  for (const r of rows) {
    assert.notEqual(r.sov_pct, 100, `${r.engine} row still stores the self-only 100%`);
    assert.equal(r.sov_pct, null, `${r.engine} row must store no share at all`);
    assert.equal(r.sov_state, ENGINE_MEASUREMENT_STATE.NOT_ASSESSED, `${r.engine} row`);
    assert.equal(r.sov_state_reason, SOV_STATE_REASONS.SELF_ONLY_ROSTER, `${r.engine} row`);
  }
  // Everything else on the row is untouched -- visibility is a different
  // measurement with a different denominator and this fix does not reach it.
  assert.equal(rows.find((r) => r.engine === "aio").visibility_pct, 50);
  assert.equal(rows.find((r) => r.engine === "all").visibility_pct, 41.7);
  assert.equal(rows.find((r) => r.engine === "aio").sentiment_avg, 75);
});

test("buildMetricsRows — a roster WITH a rival still writes real numbers and marks them measured", () => {
  const engineSummaries = {
    aio: { non_branded_queries: 10, non_branded_with_answer: 8, citation_denominator: 8, mentioned_non_branded: 4, cited_non_branded: 2, visibility_pct: 50 },
  };
  const rows = buildMetricsRows({
    isMultiEngine: true,
    brandKey: "acme.com",
    dateOnly: "2026-07-24",
    scanId: "scan-with-rival",
    promptSetId: "abc123",
    summary: {},
    engineSummaries,
    headline: { visibility_index_pct: 50 },
    promptResultRows: [],
    brandJudgmentRows: [
      { engine: "aio", is_branded_query: false, name: "acme.com", is_self: true, mentioned: true, position: 1, sentiment: 100 },
      { engine: "aio", is_branded_query: false, name: "RivalCo", is_self: false, mentioned: true, position: 2, sentiment: 50 },
    ],
  });
  for (const r of rows) {
    assert.equal(r.sov_pct, 50, `${r.engine} row`);
    assert.equal(r.sov_state, ENGINE_MEASUREMENT_STATE.MEASURED, `${r.engine} row`);
    assert.equal(r.sov_state_reason, null, `${r.engine} row`);
  }
});

test("buildMetricsRows — every row carries a state, so nothing lands in brand_metrics_daily with a silent null share", () => {
  // The DB CHECK in supabase/migrations/013_brand_metrics_sov_state.sql
  // enforces the same agreement; this asserts the producer never has to rely
  // on it. Both call shapes -- multi-engine and the single-engine v8.1 one.
  const shapes = [
    buildMetricsRows({
      isMultiEngine: true, brandKey: "acme.com", dateOnly: "2026-07-24", scanId: "s1", promptSetId: null,
      summary: {},
      engineSummaries: { aio: { non_branded_queries: 4, non_branded_with_answer: 4, citation_denominator: 4 } },
      headline: null, promptResultRows: [],
    }),
    buildMetricsRows({
      isMultiEngine: false, brandKey: "acme.com", dateOnly: "2026-07-24", scanId: "s2", promptSetId: null,
      summary: { non_branded_queries: 4, non_branded_with_aio: 4 },
      engineSummaries: null, headline: null, promptResultRows: [],
      brandJudgmentRows: [{ engine: "aio", is_branded_query: false, name: "Acme", is_self: true, mentioned: true }],
    }),
  ].flat();
  for (const r of shapes) {
    assert.ok(r.sov_state != null, `${r.engine} row has no sov_state`);
    const isMeasured =
      r.sov_state === ENGINE_MEASUREMENT_STATE.MEASURED || r.sov_state === ENGINE_MEASUREMENT_STATE.MEASURED_ZERO;
    assert.equal(Number.isFinite(r.sov_pct), isMeasured, `${r.engine}: sov_pct and sov_state disagree`);
    assert.equal(
      r.sov_state_reason == null,
      r.sov_state === ENGINE_MEASUREMENT_STATE.MEASURED,
      `${r.engine}: only 'measured' may carry a null reason`
    );
  }
});
