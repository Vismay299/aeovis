import test from "node:test";
import assert from "node:assert/strict";
import {
  IST_OFFSET_MS,
  toDateOnly,
  unionPromptCounts,
  computeBrandRollups,
  summaryToMetricsRow,
  buildMetricsRows,
} from "./rollup.js";

/**
 * Coverage for the single source of truth behind brand_metrics_daily rows —
 * shared by the live pipeline (src/lib/workers/scanWorker.js, which just
 * imports + re-exports these names) and the historical backfill
 * (scripts/backfill-analytics.mjs, via its buildBackfillMetricsRows
 * adapter). This file is the one place the rollup MATH itself is exercised;
 * src/lib/workers/scanChunk.test.mjs continues to cover the orchestration
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

test("computeBrandRollups — returns all-null when there are no rows (historical/backfill path, no per-brand source)", () => {
  assert.deepEqual(computeBrandRollups([]), { sov_pct: null, sentiment_avg: null, position_avg: null });
  assert.deepEqual(computeBrandRollups(undefined), { sov_pct: null, sentiment_avg: null, position_avg: null });
});

test("computeBrandRollups — sov_pct is null when nobody (self or rival) was ever mentioned, never a divide-by-zero", () => {
  const rows = [
    brandRow({ is_self: true, mentioned: false }),
    brandRow({ name: "Rival", is_self: false, mentioned: false }),
  ];
  const result = computeBrandRollups(rows);
  assert.equal(result.sov_pct, null);
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
