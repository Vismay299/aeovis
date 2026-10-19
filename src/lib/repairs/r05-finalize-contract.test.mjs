import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { transform } from "sucrase";
import { runFinalizePhase } from "../workers/scanWorker.js";
import { makeMemoryScanBackend } from "../demo/memoryScanBackend.js";
import { normalizeResult } from "../../services/api.js";
import { describeScanMeasurement } from "../scoring/enginePipeline.js";
import { computeReportKpis } from "../content/weeklyReport.js";
import { scoreTier } from "../../utils/format.js";
import { METRIC_IDS } from "../scoring/metricContract.js";

async function finalize({ planned = 30, valid = planned, mentioned = valid, duplicate = false, engines = ["chatgpt", "perplexity"] } = {}) {
  const backend = makeMemoryScanBackend();
  const queries = Array.from({ length: planned }, (_, i) => `question ${i}`);
  const checkpoint = { brand: "Acme", url: "acme.example", industry: "test", competitors: [],
    prompt_key: "acme.example", unbranded_texts: queries, engines, stats: {}, geo: "in", model_policy_version: "test-v1" };
  const rows = engines.flatMap((engine) => queries.slice(0, valid).map((query, i) => ({
    id: `${engine}-${i}`, job_id: "test-job", query, engine, answered: true,
    raw: { engine, prompt: query, answer_present: true, aio_present: engine === "aio",
      text: i < mentioned ? "Acme is a useful choice." : "Rival is a useful choice.",
      visible: i < mentioned, brand_mentioned_in_text: i < mentioned, brand_cited: false, references: [], brands: [], error: null },
  })));
  await backend.deps.upsertPromptResults(rows);
  const job = await runFinalizePhase("test-job", checkpoint, {
    ...backend.deps, extractCompetitors: async () => [{ name: "Rival" }],
    resolveEnabledEngines: () => engines.map((name) => ({ name })),
    ...(duplicate ? { getPromptResultsForJob: async () => [...rows, rows[0]] } : {}),
  });
  const record = JSON.parse(JSON.stringify(job.run_record));
  // Model the separate scans table columns and JSONB payload, then serialize
  // again for the API/download. No reader shares the worker's object reference.
  const stored = JSON.parse(JSON.stringify({ brand: "Acme", url: "acme.example", scanned_at: record.scanned_at,
    visibility_pct: record.visibility_pct, raw_results: record }));
  return { record, stored, daily: backend.brandMetrics };
}

for (const valid of [20, 28, 29]) {
  test(`frozen 30-prompt plan with ${valid} rows preserves collection and the 95% gate`, async () => {
    const { record } = await finalize({ valid, duplicate: true });
    for (const engine of ["chatgpt", "perplexity"]) {
      const metric = record.engines[engine].metrics[METRIC_IDS.EXPOSURE];
      assert.deepEqual(metric.collection, { valid, planned: 30 });
      assert.equal(metric.qualified, valid === 29);
      assert.equal(metric.denominator, valid);
    }
    assert.deepEqual(record.summary_stats.headline_metric.collection, { valid: valid * 2, planned: 60 });
    assert.equal(record.summary_stats.headline_qualified, valid === 29);
    assert.equal(record.summary_stats.terminal_outcome.counts.valid, valid * 2);
  });
}

test("R05-24 — finalizer, stored JSON, API, rendered hero and export preserve the same qualified contract", async () => {
  const source = await readFile(new URL("../../components/dashboard/ScoreBand.jsx", import.meta.url), "utf8");
  const compiled = transform(source, { transforms: ["jsx", "imports"] }).code;
  const module = { exports: {} };
  new Function("module", "exports", "React", compiled)(module, module.exports, React);
  const ScoreBand = module.exports.ScoreBand;
  for (const fixture of [
    { planned: 30, valid: 30, mentioned: 0, expected: 0 },
    { planned: 30, valid: 0, expected: null },
    { planned: 30, valid: 30, mentioned: 15, expected: 50 },
    { planned: 6, valid: 6, mentioned: 6, expected: null },
    { planned: 30, valid: 20, mentioned: 20, expected: null },
    { planned: 30, valid: 30, mentioned: 15, engines: ["aio"], expected: 50 },
  ]) {
    const { record, stored, daily } = await finalize(fixture);
    const api = JSON.parse(JSON.stringify(stored));
    const normalized = normalizeResult(api);
    const machineExport = JSON.parse(JSON.stringify(stored));
    const exportedMetric = machineExport.raw_results.summary_stats.headline_metric;
    const report = computeReportKpis([stored]);
    assert.deepEqual(normalized.headlineMetric, record.summary_stats.headline_metric);
    assert.deepEqual(exportedMetric, stored.raw_results.summary_stats.headline_metric);
    assert.equal(machineExport.visibility_pct, fixture.expected);
    assert.equal(normalized.visibilityScore, fixture.expected);
    assert.equal(record.visibility_pct, fixture.expected);
    assert.equal(describeScanMeasurement(stored).pct, fixture.expected);
    assert.equal(report.kpis[0].value, fixture.expected);
    assert.equal(daily.find((row) => row.engine === "all").visibility_pct, fixture.expected);
    const html = renderToStaticMarkup(React.createElement(ScoreBand, {
      score: normalized.headlinePct, tier: scoreTier(normalized.headlinePct), engineChips: [], stats: [],
    }));
    if (fixture.expected === null) {
      assert.match(html, /—/);
      assert.doesNotMatch(html, /chip--good|chip--warn|chip--crit/);
    } else assert.ok(html.includes(String(fixture.expected)));
    assert.equal(exportedMetric.unit, "percent");
    assert.equal(exportedMetric.context.metric_version, "r05-metric-v1");
  }
});
