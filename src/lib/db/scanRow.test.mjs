import test from "node:test";
import assert from "node:assert/strict";
import { buildScanBaseRecord } from "./scanRow.js";

test("buildScanBaseRecord - writes scans.competitors from the scan record", () => {
  const row = buildScanBaseRecord({
    brand: "Italica",
    url: "https://italicatiles.com",
    industry: "tiles",
    visibility_pct: 42,
    prompts_tracked: 30,
    prompts_mentioned: 12,
    competitors: [{ name: "Kajaria", source: "discovered" }],
    raw_results: { results: [] },
    scanned_at: "2026-08-29T00:00:00.000Z",
  });
  // The regression: this column exists in migration 001 and was never
  // populated, so every production scan row reads competitors = null.
  assert.deepEqual(row.competitors, [{ name: "Kajaria", source: "discovered" }]);
  assert.equal(row.brand, "Italica");
  assert.equal(row.scanned_at, "2026-08-29T00:00:00.000Z");
});

test("buildScanBaseRecord - a carried-forward roster is written to the column too", () => {
  const row = buildScanBaseRecord({
    competitors: [{ name: "Somany", domain: "", source: "carried_forward" }],
  });
  assert.equal(row.competitors[0].source, "carried_forward");
});

test("buildScanBaseRecord - a missing roster becomes [], and roster_source is what carries the meaning", () => {
  // [] here is NOT a claim that no rivals exist. scanRecord.roster_source
  // (raw_results) is the field that says whether anything was measured; this
  // column is only the roster itself.
  assert.deepEqual(buildScanBaseRecord({}).competitors, []);
});

test("buildScanBaseRecord - carries exactly the migration-001 column set, nothing that could 400 a legacy insert", () => {
  const row = buildScanBaseRecord({ brand: "x" });
  assert.deepEqual(Object.keys(row).sort(), [
    "brand",
    "competitors",
    "industry",
    "prompts_mentioned",
    "prompts_tracked",
    "raw_results",
    "scanned_at",
    "url",
    "visibility_pct",
  ]);
});
