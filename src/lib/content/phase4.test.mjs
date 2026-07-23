import { test } from "node:test";
import assert from "node:assert/strict";
import { selectGapsForBatch, createDailyBatchJobs } from "./dailyBatch.js";
import { computeReportKpis } from "./weeklyReport.js";

// --- daily batch gap selection --------------------------------------------

function scanWith(rows) {
  return { scanned_at: "2026-07-23T00:00:00Z", raw_results: { results: rows } };
}

const ROWS = [
  // rank-not-cited: visible but not cited → highest priority
  { prompt: "best diagnostics chain india", engine: "aio", answer_present: true, visible: true, brand_cited: false, is_branded_query: false, references: [{ href: "https://a.com" }] },
  // absent with many competitor citations
  { prompt: "corporate health checkup cost", engine: "aio", answer_present: true, visible: false, brand_cited: false, is_branded_query: false, references: [{ href: "https://x.com" }, { href: "https://y.com" }, { href: "https://z.com" }] },
  // absent with few citations
  { prompt: "home collection pricing", engine: "aio", answer_present: true, visible: false, brand_cited: false, is_branded_query: false, references: [{ href: "https://p.com" }] },
  // already cited → not a gap
  { prompt: "ncr diagnostics", engine: "aio", answer_present: true, visible: true, brand_cited: true, is_branded_query: false, references: [] },
  // branded → excluded
  { prompt: "acme diagnostics reviews", engine: "aio", answer_present: true, visible: false, brand_cited: false, is_branded_query: true, references: [] },
];

test("selectGapsForBatch ranks rank-not-cited first, then by competitor citations", () => {
  const gaps = selectGapsForBatch(scanWith(ROWS), { limit: 3 });
  assert.equal(gaps.length, 3);
  assert.equal(gaps[0].query, "best diagnostics chain india"); // rank_not_cited
  assert.equal(gaps[0].rank_not_cited, true);
  assert.equal(gaps[1].query, "corporate health checkup cost"); // most competitor citations
  assert.equal(gaps[2].query, "home collection pricing");
});

test("selectGapsForBatch excludes cited and branded queries", () => {
  const gaps = selectGapsForBatch(scanWith(ROWS), { limit: 10 });
  const queries = gaps.map((g) => g.query);
  assert.ok(!queries.includes("ncr diagnostics"));
  assert.ok(!queries.includes("acme diagnostics reviews"));
});

test("selectGapsForBatch skips already-targeted queries", () => {
  const already = new Set(["best diagnostics chain india"]);
  const gaps = selectGapsForBatch(scanWith(ROWS), { alreadyTargeted: already, limit: 3 });
  assert.ok(!gaps.some((g) => g.query === "best diagnostics chain india"));
});

test("createDailyBatchJobs dedupes against existing items and respects batch size", async () => {
  const created = [];
  const deps = {
    batchSize: 2,
    getScansForBrand: async () => [scanWith(ROWS)],
    listContentItems: async () => [
      { target_queries: ["corporate health checkup cost"], status: "approved" },
    ],
    listContentJobs: async () => [],
    createContentJob: async (job) => {
      const rec = { id: `job-${created.length}`, ...job };
      created.push(rec);
      return rec;
    },
  };

  const jobs = await createDailyBatchJobs("Acme", deps);
  assert.equal(jobs.length, 2);
  const queries = jobs.map((j) => j.input.query);
  assert.ok(!queries.includes("corporate health checkup cost"), "targeted query is skipped");
  assert.ok(queries.includes("best diagnostics chain india"));
  assert.equal(jobs[0].input.source, "daily_batch");
  assert.equal(jobs[0].playbook, "geo_article");
});

test("createDailyBatchJobs skips a brand with a live geo job (no pile-up)", async () => {
  const deps = {
    batchSize: 2,
    getScansForBrand: async () => [scanWith(ROWS)],
    listContentItems: async () => [],
    listContentJobs: async () => [{ playbook: "geo_article", status: "drafting", input: {} }],
    createContentJob: async () => { throw new Error("should not create"); },
  };
  const jobs = await createDailyBatchJobs("Acme", deps);
  assert.deepEqual(jobs, []);
});

test("createDailyBatchJobs is a no-op when batch size is 0 (default off)", async () => {
  const deps = {
    batchSize: 0,
    getScansForBrand: async () => { throw new Error("should not read scans"); },
  };
  const jobs = await createDailyBatchJobs("Acme", deps);
  assert.deepEqual(jobs, []);
});

// --- weekly report KPI math (deterministic, code-owned) --------------------

function scanMetrics(share, coverage, citation, index, engines) {
  return {
    scanned_at: arguments[5],
    visibility_pct: index,
    prompts_tracked: 30,
    raw_results: {
      visibility_index_pct: index,
      summary_stats: { share_of_ai_pct: share, aio_coverage_pct: coverage, citation_share_pct: citation },
      engines,
    },
  };
}

test("computeReportKpis computes three KPIs with week-over-week deltas", () => {
  const current = scanMetrics(40, 70, 12, 38, { aio: { share_of_ai_pct: 42 }, chatgpt: { share_of_ai_pct: 34 } }, "2026-07-23T00:00:00Z");
  const previous = scanMetrics(30, 65, 8, 30, { aio: { share_of_ai_pct: 30 }, chatgpt: { share_of_ai_pct: 30 } }, "2026-07-16T00:00:00Z");

  const kpis = computeReportKpis([current, previous]);
  assert.equal(kpis.kpis.length, 3);

  const idx = kpis.kpis.find((k) => k.key === "visibility_index");
  assert.equal(idx.value, 38);
  assert.equal(idx.delta, 8); // 38 - 30

  const cov = kpis.kpis.find((k) => k.key === "aio_coverage");
  assert.equal(cov.delta, 5); // 70 - 65

  const aio = kpis.per_engine.find((e) => e.engine === "aio");
  assert.equal(aio.value, 42);
  assert.equal(aio.delta, 12);
});

test("computeReportKpis returns null deltas with only one scan", () => {
  const only = scanMetrics(40, 70, 12, 38, { aio: { share_of_ai_pct: 42 } }, "2026-07-23T00:00:00Z");
  const kpis = computeReportKpis([only]);
  assert.equal(kpis.previous, null);
  assert.equal(kpis.kpis[0].delta, null);
});

test("computeReportKpis returns null with no scans", () => {
  assert.equal(computeReportKpis([]), null);
});
