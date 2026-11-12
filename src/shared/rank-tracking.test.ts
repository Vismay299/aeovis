// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu): src/shared/rank-tracking.test.ts.
import test from "node:test";
import assert from "node:assert/strict";
import {
  buildRankTrackingExport,
  csvChange,
  defaultComparePeriod,
  devicesCount,
  devicesLabel,
  expandDevices,
  pagesToDepth,
  rankSkipReasonMessage,
} from "./rank-tracking.ts";
import type { RankTrackingRow } from "./rank-tracking.ts";

function row(overrides: Partial<RankTrackingRow> = {}): RankTrackingRow {
  const device = { position: null, previousPosition: null, rankingUrl: null, serpFeatures: [], checkedAt: null };
  return {
    trackingKeywordId: "kw-1", keyword: "example query", matchCase: false, pinned: false,
    searchVolume: null, keywordDifficulty: null, cpc: null,
    desktop: { ...device }, mobile: { ...device }, aiQuestion: null, ...overrides,
  };
}

test("rank tracking constants and small helpers have stable semantics", () => {
  assert.equal(defaultComparePeriod("daily"), "1d");
  assert.equal(defaultComparePeriod("monthly"), "30d");
  assert.equal(defaultComparePeriod("manual"), "7d");
  assert.equal(devicesCount("both"), 2);
  assert.equal(devicesLabel("mobile"), "Mobile");
  assert.deepEqual(expandDevices("both"), ["desktop", "mobile"]);
  assert.equal(pagesToDepth(4), 40);
  assert.equal(pagesToDepth(20), 100);
});

test("rank skip messages cover known reasons and use the specified fallback", () => {
  assert.equal(rankSkipReasonMessage("no_keywords"), "No keywords to check. Add keywords to resume scheduled checks.");
  assert.equal(rankSkipReasonMessage("unknown"), "The scheduled check could not start.");
});

test("CSV changes stay numeric when both positions exist", () => {
  assert.equal(csvChange(3, 8), 5);
  assert.equal(csvChange(3, null), "new");
  assert.equal(csvChange(null, 3), "lost");
  assert.equal(csvChange(null, null), "");
});

test("export uses empty cells for not-ranking positions and has an AI Overview column", () => {
  const { headers, rows } = buildRankTrackingExport([
    row({ desktop: { position: null, previousPosition: 8, rankingUrl: null, serpFeatures: [], checkedAt: "2026-01-01T00:00:00Z" }, mobile: { position: 3, previousPosition: 5, rankingUrl: "https://example.com", serpFeatures: ["ai_overview"], checkedAt: "2026-01-01T00:00:00Z" } }),
  ], true, true);
  assert.ok(headers.includes("AI Overview"));
  assert.equal(rows[0][4], "");
  assert.equal(rows[0][5], "lost");
  assert.equal(rows[0][9], 2);
  assert.equal(rows[0][12], "yes");
});
