import { test } from "node:test";
import assert from "node:assert/strict";
import { selectGapsForBatch, createDailyBatchJobs } from "./dailyBatch.js";
import { computeReportKpis, generateWeeklyReport, checkReportQuota, recordReportGeneration, REPORT_QUOTA_PER_DAY } from "./weeklyReport.js";

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

// --- R3.6.3 — weekly report quota per brand per day -----------------------

test("R3.6.3 — checkReportQuota returns 0 for a brand that has not generated today", () => {
  const count = checkReportQuota("Acme", { now: "2026-09-14T12:00:00Z" });
  assert.equal(count, 0);
});

test("R3.6.3 — recordReportGeneration increments the counter", () => {
  const brand = `R363-counter-${Date.now()}`;
  const now = "2026-09-14T12:00:00Z";
  assert.equal(checkReportQuota(brand, { now }), 0);
  recordReportGeneration(brand, { now });
  assert.equal(checkReportQuota(brand, { now }), 1);
  recordReportGeneration(brand, { now });
  assert.equal(checkReportQuota(brand, { now }), 2);
});

test("R3.6.3 — quota is per brand (different brands do not interfere)", () => {
  const now = "2026-09-14T15:00:00Z";
  const brandA = `R363-brandA-${Date.now()}`;
  const brandB = `R363-brandB-${Date.now()}`;
  recordReportGeneration(brandA, { now });
  assert.equal(checkReportQuota(brandA, { now }), 1);
  assert.equal(checkReportQuota(brandB, { now }), 0);
});

test("R3.6.3 — quota resets on a new day", () => {
  const brand = `R363-newday-${Date.now()}`;
  recordReportGeneration(brand, { now: "2026-09-14T23:59:59Z" });
  assert.equal(checkReportQuota(brand, { now: "2026-09-14T23:59:59Z" }), 1);
  // Next day — fresh quota
  assert.equal(checkReportQuota(brand, { now: "2026-09-15T00:00:00Z" }), 0);
});

test("R3.6.3 — generateWeeklyReport enforces the quota and returns quota_exceeded", async () => {
  const brand = `R363-enforce-${Date.now()}`;
  const now = "2026-09-14T12:00:00Z";

  // Burn the quota
  recordReportGeneration(brand, { now });

  const report = await generateWeeklyReport(brand, {
    now,
    getScansForBrand: async () => [{ scanned_at: "2026-09-14", raw_results: {} }],
  });

  assert.equal(report.quota_exceeded, true, "the response must flag the quota exceeded");
  assert.ok(report.error.includes("quota"), "the error message must mention quota");
  assert.equal(report.brand, brand);
});

test("R3.6.3 — generateWeeklyReport records a generation on success", async () => {
  const brand = `R363-record-${Date.now()}`;
  const now = "2026-09-14T12:00:00Z";

  assert.equal(checkReportQuota(brand, { now }), 0);

  await generateWeeklyReport(brand, {
    now,
    getScansForBrand: async () => [scanMetrics(40, 70, 12, 38, { aio: { share_of_ai_pct: 42 } }, "2026-09-14T00:00:00Z")],
    listContentItems: async () => [],
    llm: async () => ({ headline: "test", summary: "test", top_movers: [], priorities: [] }),
  });

  assert.equal(checkReportQuota(brand, { now }), 1, "a successful generation must consume the quota");
});

test("R3.6.3 — generateWeeklyReport does NOT consume quota on LLM failure", async () => {
  const brand = `R363-llm-fail-${Date.now()}`;
  const now = "2026-09-14T12:00:00Z";

  try {
    await generateWeeklyReport(brand, {
      now,
      getScansForBrand: async () => [scanMetrics(40, 70, 12, 38, { aio: { share_of_ai_pct: 42 } }, "2026-09-14T00:00:00Z")],
      listContentItems: async () => [],
      llm: async () => { throw new Error("LLM unavailable"); },
    });
  } catch {
    // expected
  }

  assert.equal(
    checkReportQuota(brand, { now }),
    0,
    "a failed generation must not consume the quota — the brand can retry"
  );
});

test("R3.6.3 — REPORT_QUOTA_PER_DAY is 1", () => {
  assert.equal(REPORT_QUOTA_PER_DAY, 1, "one report per brand per day");
});

test("R3.6.3 — custom deps.checkReportQuota overrides the in-memory check", async () => {
  const brand = "R363-custom-deps";
  const now = "2026-09-14T12:00:00Z";
  let checked = false;

  const report = await generateWeeklyReport(brand, {
    now,
    checkReportQuota: () => { checked = true; return 999; },
    getScansForBrand: async () => [{ scanned_at: "2026-09-14", raw_results: {} }],
  });

  assert.equal(checked, true, "the custom check must be called");
  assert.equal(report.quota_exceeded, true, "999 is over quota");
});

// R3.5.7 — a REWOUND job (running status + item_id) already delivered; nothing
// is working it. Counting it as live blocked the brand's whole daily batch until
// an operator cleared the row by hand.

test("R3.5.7 — a rewound geo job (running status WITH an item_id) does NOT block the brand's batch", async () => {
  const created = [];
  const deps = {
    batchSize: 2,
    getScansForBrand: async () => [scanWith(ROWS)],
    listContentItems: async () => [],
    listContentJobs: async () => [
      { id: "355b0237", playbook: "geo_article", status: "reviewing", item_id: "item-355", input: {} },
    ],
    createContentJob: async (job) => {
      const rec = { id: `job-${created.length}`, ...job };
      created.push(rec);
      return rec;
    },
  };

  const jobs = await createDailyBatchJobs("Acme", deps);

  assert.equal(jobs.length, 2, "THE BUG: one damaged row silenced this brand's batch indefinitely");
});

test("R3.5.7 — a genuinely live geo job (no item yet) STILL blocks, even beside a rewound one", async () => {
  const deps = {
    batchSize: 2,
    getScansForBrand: async () => [scanWith(ROWS)],
    listContentItems: async () => [],
    listContentJobs: async () => [
      { id: "rewound", playbook: "geo_article", status: "reviewing", item_id: "item-1", input: {} },
      { id: "live", playbook: "geo_article", status: "drafting", item_id: null, input: {} },
    ],
    createContentJob: async () => {
      throw new Error("should not create — the no-pile-up rule must survive the R3.5.7 carve-out");
    },
  };

  assert.deepEqual(await createDailyBatchJobs("Acme", deps), []);
});

