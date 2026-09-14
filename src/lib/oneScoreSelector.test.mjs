import test from "node:test";
import assert from "node:assert/strict";

/**
 * R2.4.2 — ONE GATE-HONOURING SCORE SELECTOR.
 *
 * All four surfaces that render a stored scan's score — hero, history cards,
 * sidebar and homepage — call describeScanMeasurement (or the raw scan row is
 * carried through listRecentScans so that they CAN). A null measurement
 * renders an em dash, never a bare percent sign.
 *
 * WHAT THIS FILE PROVES:
 *   1. listRecentScans returns objects that carry `visibility_pct` and
 *      `raw_results`, so any surface that receives them can call
 *      describeScanMeasurement(row) and get the correct measurement state.
 *   2. describeScanMeasurement on a listRecentScans row produces the same
 *      result as on the original DB row (no data loss in the aggregation).
 *   3. A null measurement renders "—" (em dash), never a bare "%".
 *   4. The home-brand-card in HomeDashboard uses describeScanMeasurement —
 *      proved by source-text guard.
 *   5. DashboardShell's hero calls describeScanMeasurement on the raw scan —
 *      proved by source-text guard.
 */

import { describeScanMeasurement, NO_MEASUREMENT_TEXT } from "../lib/scoring/enginePipeline.js";

// ---------------------------------------------------------------------------
// 1. listRecentScans output shape — unit test against the function logic.
// ---------------------------------------------------------------------------

/**
 * Simulate what listRecentScans does to a DB row.  The function aggregates by
 * brand (keeping the most-recent row), so we replicate that logic here to
 * prove the shape carries through without needing a live Supabase instance.
 */
function simulateListRecentScans(rows) {
  const byBrand = new Map();
  for (const s of rows) {
    const key = String(s.brand || "").trim().toLowerCase();
    if (!key) continue;
    const raw = s.raw_results || {};
    const engines = raw.engines ? Object.keys(raw.engines) : [];
    const score =
      raw.visibility_index_pct ??
      raw.summary_stats?.share_of_ai_pct ??
      s.visibility_pct ??
      null;
    const existing = byBrand.get(key);
    if (!existing) {
      byBrand.set(key, {
        id: s.id,
        brand: s.brand,
        url: s.url,
        industry: s.industry,
        score: score == null ? null : Math.round(Number(score) * 10) / 10,
        visibility_pct: s.visibility_pct,
        raw_results: raw,
        scanned_at: s.scanned_at,
        engines,
        scan_count: 1,
      });
    } else {
      existing.scan_count += 1;
    }
  }
  return Array.from(byBrand.values());
}

/** A minimal scan row shaped like what Supabase returns. */
function makeScanRow(overrides = {}) {
  return {
    id: "test-row",
    brand: "Acme",
    url: "acme.com",
    industry: "tech",
    visibility_pct: 42,
    scanned_at: "2026-09-01T10:00:00Z",
    raw_results: {
      engines: { aio: {} },
      summary_stats: { state: "measured", visibility_pct: 42 },
      visibility_index_pct: 42,
    },
    ...overrides,
  };
}

test("R2.4.2 — listRecentScans output carries visibility_pct for describeScanMeasurement", () => {
  const row = makeScanRow();
  const [result] = simulateListRecentScans([row]);

  assert.equal(result.visibility_pct, 42, "visibility_pct must pass through");
  assert.ok(result.raw_results, "raw_results must pass through");
  assert.equal(result.score, 42, "the legacy score field is still present for backward compat");
});

test("R2.4.2 — listRecentScans output carries state info via raw_results.summary_stats", () => {
  const row = makeScanRow({
    visibility_pct: null,
    raw_results: {
      engines: { aio: {} },
      summary_stats: { state: "not_assessed", state_reason: "empty_eliciting_pool" },
    },
  });
  const [result] = simulateListRecentScans([row]);

  // describeScanMeasurement on the listRecentScans output must see the state
  const m = describeScanMeasurement(result);
  assert.equal(m.measured, false, "a not_assessed scan must be unmeasured");
  assert.equal(m.text, NO_MEASUREMENT_TEXT, "an unmeasured scan must render an em dash");
  assert.ok(!m.text.includes("%"), "the em dash must never be accompanied by a bare percent sign");
});

test("R2.4.2 — describeScanMeasurement on listRecentScans output matches the original row", () => {
  const row = makeScanRow({ visibility_pct: 37 });
  const [aggregated] = simulateListRecentScans([row]);

  const fromOriginal = describeScanMeasurement(row);
  const fromAggregated = describeScanMeasurement(aggregated);

  assert.equal(fromAggregated.measured, fromOriginal.measured, "measured flag must match");
  assert.equal(fromAggregated.pct, fromOriginal.pct, "pct must match");
  assert.equal(fromAggregated.text, fromOriginal.text, "text must match");
  assert.equal(fromAggregated.state, fromOriginal.state, "state must match");
});

test("R2.4.2 — a null visibility_pct renders em dash, never a bare percent sign", () => {
  const row = makeScanRow({ visibility_pct: null });
  const [result] = simulateListRecentScans([row]);
  const m = describeScanMeasurement(result);

  assert.equal(m.text, "—", "null score must render as em dash");
  assert.ok(!m.text.includes("%"), "must not include a percent sign");
  assert.equal(m.measured, false, "must be flagged as unmeasured");
});

test("R2.4.2 — a measured zero still renders 0%, not a dash (standing rule 1)", () => {
  const row = makeScanRow({
    visibility_pct: 0,
    raw_results: {
      engines: { aio: {} },
      summary_stats: { state: "measured_zero" },
    },
  });
  const [result] = simulateListRecentScans([row]);
  const m = describeScanMeasurement(result);

  assert.equal(m.measured, true, "a measured zero IS measured");
  assert.equal(m.pct, 0, "the number is 0");
  assert.equal(m.text, "0%", "renders as 0%, not a dash");
});

// ---------------------------------------------------------------------------
// 2. Source-text guards — prove the surfaces CALL the selector.
// ---------------------------------------------------------------------------

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

test("R2.4.2 — HomeDashboard imports and calls describeScanMeasurement", async () => {
  const source = await readFile(
    path.join(HERE, "..", "components", "home", "HomeDashboard.jsx"),
    "utf8"
  );
  assert.match(
    source,
    /import\s*\{[^}]*describeScanMeasurement[^}]*\}\s*from\s*["']@\/lib\/scoring\/enginePipeline["']/,
    "HomeDashboard must import describeScanMeasurement from enginePipeline"
  );
  assert.match(
    source,
    /describeScanMeasurement\(/,
    "HomeDashboard must call describeScanMeasurement"
  );
  // The old direct s.score rendering must be gone
  assert.ok(
    !source.includes("s.score ==") && !source.includes("s.score==="),
    "HomeDashboard must not read s.score directly — it must use the shared selector"
  );
});

test("R2.4.2 — DashboardShell calls describeScanMeasurement on the raw scan", async () => {
  const source = await readFile(
    path.join(HERE, "..", "components", "dashboard", "DashboardShell.jsx"),
    "utf8"
  );
  // The hero must call describeScanMeasurement(scan) — the raw DB row
  assert.match(
    source,
    /describeScanMeasurement\(scan\)/,
    "DashboardShell must call describeScanMeasurement(scan) on the raw scan row"
  );
  // The heroMeasurement must be used in the isNotAssessed gate
  assert.match(
    source,
    /heroMeasurement.*!.*\.measured/,
    "heroMeasurement.measured must gate the isNotAssessed check"
  );
});

test("R2.4.2 — listRecentScans in db.js carries visibility_pct and raw_results", async () => {
  const source = await readFile(
    path.join(HERE, "..", "lib", "db.js"),
    "utf8"
  );
  // Find the listRecentScans function and check it includes the new fields
  const fnStart = source.indexOf("export async function listRecentScans");
  assert.notEqual(fnStart, -1, "listRecentScans must exist in db.js");
  // Search a generous window — the function is ~60 lines
  const fnBody = source.slice(fnStart, fnStart + 4000);

  assert.match(
    fnBody,
    /visibility_pct:\s*s\.visibility_pct/,
    "listRecentScans must carry visibility_pct in its output"
  );
  assert.match(
    fnBody,
    /raw_results:\s*raw/,
    "listRecentScans must carry raw_results in its output"
  );
});
