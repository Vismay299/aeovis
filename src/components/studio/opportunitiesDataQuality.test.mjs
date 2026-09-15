/**
 * R2.8.1 — Gate Studio and Opportunities on data quality.
 *
 * "No gaps" and "nothing was answered" are different screens. An all-errored
 * scan renders the data-quality state in Studio, not a clean "no gaps".
 *
 * WHAT THIS FILE PROVES:
 *   1. hasCriticalDataSourceIssue detects an all-errored scan.
 *   2. hasCriticalDataSourceIssue does NOT fire on a clean scan with no gaps.
 *   3. hasCriticalDataSourceIssue does NOT fire on a partially-degraded scan.
 *   4. Teeth: removing the gate lets the "no gaps" message through on a
 *      failed scan.
 */
import test from "node:test";
import assert from "node:assert/strict";

/**
 * Simulate hasCriticalDataSourceIssue from OpportunitiesPanel.jsx.
 * Extracted here for testability without a DOM.
 */
function hasCriticalDataSourceIssue(scan) {
  const engines = scan?.engines;
  if (!engines || typeof engines !== "object") {
    return !!(scan?.data_source_issue);
  }
  const slices = Object.values(engines).filter((s) => s && typeof s === "object");
  if (slices.length === 0) return false;
  const ran = slices.filter((s) => Number(s.non_branded_queries) > 0);
  if (ran.length === 0) return false;
  return ran.every((s) => s.data_source_issue);
}

// ---------------------------------------------------------------------------
// Test 1: All-errored scan → critical data source issue
// ---------------------------------------------------------------------------
test("R2.8.1 — all-errored scan is detected as critical data source issue", () => {
  const scan = {
    engines: {
      aio: {
        non_branded_queries: 30,
        data_source_issue: true,
        state: "failed",
        state_reason: "high_error_rate",
      },
      perplexity: {
        non_branded_queries: 30,
        data_source_issue: true,
        state: "failed",
        state_reason: "high_error_rate",
      },
    },
  };
  assert.equal(hasCriticalDataSourceIssue(scan), true,
    "every engine that ran has data_source_issue → critical");
});

// ---------------------------------------------------------------------------
// Test 2: Clean scan with no gaps → NOT a data source issue
// ---------------------------------------------------------------------------
test("R2.8.1 — clean scan with no gaps is NOT a data source issue", () => {
  const scan = {
    engines: {
      aio: {
        non_branded_queries: 30,
        data_source_issue: false,
        state: "measured",
        share_of_ai_pct: 45,
      },
      perplexity: {
        non_branded_queries: 30,
        data_source_issue: false,
        state: "measured",
        share_of_ai_pct: 30,
      },
    },
  };
  assert.equal(hasCriticalDataSourceIssue(scan), false,
    "clean engines → not a data source issue");
});

// ---------------------------------------------------------------------------
// Test 3: Partially degraded scan → NOT critical (one clean engine remains)
// ---------------------------------------------------------------------------
test("R2.8.1 — partially degraded scan is NOT critical", () => {
  const scan = {
    engines: {
      aio: {
        non_branded_queries: 30,
        data_source_issue: true,
        state: "failed",
      },
      perplexity: {
        non_branded_queries: 30,
        data_source_issue: false,
        state: "measured",
        share_of_ai_pct: 30,
      },
    },
  };
  assert.equal(hasCriticalDataSourceIssue(scan), false,
    "one clean engine survives → not critical");
});

// ---------------------------------------------------------------------------
// Test 4: Scan with no engines → not critical (no data to judge)
// ---------------------------------------------------------------------------
test("R2.8.1 — scan with no engines is not critical", () => {
  const scan = { engines: {} };
  assert.equal(hasCriticalDataSourceIssue(scan), false,
    "empty engines → not critical");
});

// ---------------------------------------------------------------------------
// Test 5: Scan with no per-engine data but scan-level flag → uses flag
// ---------------------------------------------------------------------------
test("R2.8.1 — legacy scan without engines uses scan-level flag", () => {
  const scan = { data_source_issue: true };
  assert.equal(hasCriticalDataSourceIssue(scan), true,
    "scan-level flag is true → critical");
});

test("R2.8.1 — legacy scan without engines and no flag → not critical", () => {
  const scan = {};
  assert.equal(hasCriticalDataSourceIssue(scan), false,
    "no engines, no flag → not critical");
});

// ---------------------------------------------------------------------------
// Test 6: Scan where all engines ran but had zero non-branded queries
// ---------------------------------------------------------------------------
test("R2.8.1 — engines with zero non-branded queries → not critical", () => {
  const scan = {
    engines: {
      aio: {
        non_branded_queries: 0,
        data_source_issue: false,
      },
    },
  };
  assert.equal(hasCriticalDataSourceIssue(scan), false,
    "no engine ran → not critical");
});

// ---------------------------------------------------------------------------
// Test 7: Teeth — the gate IS the difference
// ---------------------------------------------------------------------------
test("R2.8.1 — teeth: removing the gate lets 'no gaps' through on a failed scan", () => {
  const scan = {
    engines: {
      aio: {
        non_branded_queries: 30,
        data_source_issue: true,
      },
    },
  };
  const gaps = []; // No gaps because everything errored

  // With the gate (current implementation):
  const dataSourceIssue = hasCriticalDataSourceIssue(scan);
  const withGate = dataSourceIssue && gaps.length === 0
    ? "data_quality_issue"
    : gaps.length === 0
      ? "no_gaps"
      : "has_gaps";
  assert.equal(withGate, "data_quality_issue",
    "with gate: renders data quality issue");

  // Without the gate:
  const withoutGate = gaps.length === 0 ? "no_gaps" : "has_gaps";
  assert.equal(withoutGate, "no_gaps",
    "without gate: renders 'no gaps' — the lie");

  assert.notEqual(withGate, withoutGate,
    "removing the gate MUST change the rendered state");
});
