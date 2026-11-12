// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu): src/client/features/rank-tracking/RankTrackingFilters.test.ts.
import test from "node:test";
import assert from "node:assert/strict";
import {
  applyDomainListFilters,
  applyFilters,
  countActiveFilters,
  EMPTY_DOMAIN_LIST_FILTERS,
  EMPTY_FILTERS,
} from "./rank-tracking-filters.ts";
import type { RankTrackingRow } from "./rank-tracking.ts";

function row(keyword: string, desktop: Partial<RankTrackingRow["desktop"]>, mobile: Partial<RankTrackingRow["mobile"]>): RankTrackingRow {
  const defaults = { position: null, previousPosition: null, rankingUrl: null, serpFeatures: [], checkedAt: null };
  return {
    trackingKeywordId: keyword, keyword, matchCase: false, pinned: false,
    searchVolume: null, keywordDifficulty: null, cpc: null, aiQuestion: null,
    desktop: { ...defaults, ...desktop }, mobile: { ...defaults, ...mobile },
  };
}

test("domain list filters combine domain, device, and country with AND semantics", () => {
  const configs = [
    { domain: "alpha.example.com", devices: "mobile" as const, locationCode: 2840 },
    { domain: "alpha.example.com", devices: "desktop" as const, locationCode: 2250 },
    { domain: "alpha.example.com", devices: "mobile" as const, locationCode: 2250 },
  ];
  assert.deepEqual(applyDomainListFilters(configs, { ...EMPTY_DOMAIN_LIST_FILTERS, query: "alpha", device: "mobile", locationCode: "2250" }), [configs[2]]);
});

test("AI Overview filter checks the selected visible device and excludes never-checked rows", () => {
  const rows = [
    row("shown", { checkedAt: "2026-01-01", serpFeatures: [] }, { checkedAt: "2026-01-01", serpFeatures: ["ai_overview"] }),
    row("not seen", { checkedAt: "2026-01-01", serpFeatures: ["ai_overview"] }, { checkedAt: "2026-01-01", serpFeatures: [] }),
    row("not checked", { checkedAt: null, serpFeatures: [] }, { checkedAt: null, serpFeatures: [] }),
  ];
  assert.deepEqual(applyFilters(rows, { ...EMPTY_FILTERS, aiOverview: "shown" }, "mobile").map((item) => item.keyword), ["shown"]);
  assert.deepEqual(applyFilters(rows, { ...EMPTY_FILTERS, aiOverview: "not_seen" }, "mobile").map((item) => item.keyword), ["not seen"]);
  assert.equal(countActiveFilters({ ...EMPTY_FILTERS, aiOverview: "shown" }), 1);
});

test("position and metric ranges preserve zero and exclude unknown values", () => {
  const rows = [row("zero", { position: 5 }, { position: 7 }), row("unknown", {}, {})];
  rows[0].searchVolume = 0;
  assert.deepEqual(applyFilters(rows, { ...EMPTY_FILTERS, minVolume: "0", maxDesktopPos: "10" }).map((item) => item.keyword), ["zero"]);
});
