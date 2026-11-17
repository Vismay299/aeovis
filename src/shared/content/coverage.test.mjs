import test from "node:test";
import assert from "node:assert/strict";
import {
  rollupCoverage,
  summarizeCoverage,
  queryUniverseFromScan,
  COVERAGE_PRECEDENCE,
} from "./coverage.js";

/**
 * Query coverage rollup (T4). Pure in, pure out — every case below is plain
 * arrays, no DB, matching analytics/gaps.js's test style.
 */

const Q = ["best crm for clinics", "how to pick an ehr", "top telehealth vendors"];

function item(id, status, queries, title = null) {
  return { id, status, target_queries: queries, title };
}
function job(id, status, query, extra = {}) {
  return { id, status, input: { query }, ...extra };
}

// --- state derivation -------------------------------------------------------

test("an approved item covers its target queries", () => {
  const rows = rollupCoverage({
    queries: Q,
    items: [item("i1", "approved", [Q[0]], "CRM guide")],
  });
  assert.equal(rows[0].state, "covered");
  assert.deepEqual(rows[0].items, [{ id: "i1", status: "approved", title: "CRM guide" }]);
  assert.equal(rows[1].state, "uncovered");
  assert.equal(rows[2].state, "uncovered");
});

test("an item at the gate reads awaiting_approval; a revision in flight reads in_progress", () => {
  const rows = rollupCoverage({
    queries: Q,
    items: [
      item("i1", "awaiting_approval", [Q[0]]),
      item("i2", "changes_requested", [Q[1]]),
      item("i3", "draft", [Q[2]]),
    ],
  });
  assert.equal(rows[0].state, "awaiting_approval");
  assert.equal(rows[1].state, "in_progress");
  assert.equal(rows[2].state, "in_progress");
});

test("a live job with no item yet reads in_progress", () => {
  const rows = rollupCoverage({
    queries: Q,
    jobs: [job("j1", "drafting", Q[0]), job("j2", "pending", Q[1])],
  });
  assert.equal(rows[0].state, "in_progress");
  assert.equal(rows[1].state, "in_progress");
  assert.deepEqual(rows[0].jobs, [{ id: "j1", status: "drafting" }]);
});

test("a rejected item reads rejected, not uncovered — the attempt is visible", () => {
  const rows = rollupCoverage({ queries: Q, items: [item("i1", "rejected", [Q[0]])] });
  assert.equal(rows[0].state, "rejected");
});

// --- the failure/rejection distinction --------------------------------------

test("a FAILED job counts as an attempt, never as a rejection", () => {
  const rows = rollupCoverage({ queries: Q, jobs: [job("j1", "failed", Q[0])] });

  // A crash or a cost-cap stop is an infrastructure outcome, not a human "no":
  // it must not read as "we decided against this query".
  assert.equal(rows[0].state, "uncovered");
  assert.equal(rows[0].failed_attempts, 1);
  assert.deepEqual(rows[0].jobs, [], "a failed job is not reported as in-flight work");
});

test("failed attempts accumulate and are summarised separately", () => {
  const rows = rollupCoverage({
    queries: Q,
    jobs: [job("j1", "failed", Q[0]), job("j2", "failed", Q[0])],
  });
  assert.equal(rows[0].failed_attempts, 2);
  assert.equal(summarizeCoverage(rows).failed_attempts, 2);
});

// --- precedence -------------------------------------------------------------

test("precedence: covered beats every weaker signal on the same query", () => {
  const rows = rollupCoverage({
    queries: [Q[0]],
    items: [item("i1", "rejected", [Q[0]]), item("i2", "approved", [Q[0]])],
    jobs: [job("j1", "drafting", Q[0])],
  });
  assert.equal(rows[0].state, "covered");
});

test("precedence: the gate beats in-flight work, which beats a past rejection", () => {
  assert.equal(
    rollupCoverage({
      queries: [Q[0]],
      items: [item("i1", "awaiting_approval", [Q[0]]), item("i2", "draft", [Q[0]])],
    })[0].state,
    "awaiting_approval"
  );
  assert.equal(
    rollupCoverage({
      queries: [Q[0]],
      items: [item("i1", "rejected", [Q[0]])],
      jobs: [job("j1", "drafting", Q[0])],
    })[0].state,
    "in_progress"
  );
});

test("COVERAGE_PRECEDENCE is ordered strongest-first and ends at uncovered", () => {
  assert.equal(COVERAGE_PRECEDENCE[0], "covered");
  assert.equal(COVERAGE_PRECEDENCE[COVERAGE_PRECEDENCE.length - 1], "uncovered");
});

// --- join hygiene -----------------------------------------------------------

test("a job that already produced an item does not double-report as in_progress", () => {
  const rows = rollupCoverage({
    queries: [Q[0]],
    items: [item("i1", "approved", [Q[0]])],
    jobs: [job("j1", "awaiting_approval", Q[0], { item_id: "i1" })],
  });
  assert.equal(rows[0].state, "covered");
  assert.deepEqual(rows[0].jobs, [], "the item already speaks for this job");
});

test("the join is case- and whitespace-insensitive on both sides", () => {
  const rows = rollupCoverage({
    queries: ["Best CRM For Clinics"],
    items: [item("i1", "approved", ["  best crm for clinics  "])],
  });
  assert.equal(rows[0].state, "covered");
  assert.equal(rows[0].query, "Best CRM For Clinics", "the caller's casing is preserved in output");
});

test("jobs and items for queries outside the universe are ignored", () => {
  const rows = rollupCoverage({
    queries: [Q[0]],
    items: [item("i1", "approved", ["something we do not track"])],
    jobs: [job("j1", "drafting", "also untracked")],
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].state, "uncovered");
});

test("an item targeting several queries covers all of them", () => {
  const rows = rollupCoverage({
    queries: Q,
    items: [item("i1", "approved", [Q[0], Q[2]])],
  });
  assert.deepEqual(
    rows.map((r) => r.state),
    ["covered", "uncovered", "covered"]
  );
});

test("empty input is a valid empty rollup, not a crash", () => {
  assert.deepEqual(rollupCoverage(), []);
  assert.deepEqual(rollupCoverage({}), []);
  assert.equal(summarizeCoverage().total, 0);
  assert.equal(summarizeCoverage([]).coverage_pct, 0);
});

// --- summary ----------------------------------------------------------------

test("summarizeCoverage totals each state and computes overall coverage", () => {
  const rows = rollupCoverage({
    queries: [Q[0], Q[1], Q[2], "fourth query"],
    items: [
      item("i1", "approved", [Q[0]]),
      item("i2", "awaiting_approval", [Q[1]]),
      item("i3", "rejected", [Q[2]]),
    ],
  });
  const s = summarizeCoverage(rows);

  assert.equal(s.total, 4);
  assert.equal(s.covered, 1);
  assert.equal(s.awaiting_approval, 1);
  assert.equal(s.rejected, 1);
  assert.equal(s.uncovered, 1);
  assert.equal(s.coverage_pct, 25);
});

test("summarizeCoverage tracks gap coverage separately from overall coverage", () => {
  const rows = rollupCoverage({
    queries: [
      { query: Q[0], is_gap: true },
      { query: Q[1], is_gap: true },
      { query: Q[2], is_gap: false },
    ],
    items: [item("i1", "approved", [Q[0]]), item("i2", "approved", [Q[2]])],
  });
  const s = summarizeCoverage(rows);

  assert.equal(s.total, 3);
  assert.equal(s.covered, 2);
  assert.equal(s.coverage_pct, 67);
  assert.equal(s.gaps, 2);
  assert.equal(s.gaps_covered, 1, "only one of the two gap queries has approved content");
  assert.equal(s.gap_coverage_pct, 50);
});

// --- scan → universe --------------------------------------------------------

const SCAN = {
  results: [
    { prompt: Q[0], engine: "aio", answer_present: true, brand_cited: false, visible: true },
    { prompt: Q[0], engine: "chatgpt", answer_present: true, brand_cited: false },
    { prompt: Q[1], engine: "aio", answer_present: true, brand_cited: true },
    { prompt: "acme pricing", engine: "aio", answer_present: true, is_branded_query: true },
    { prompt: "", engine: "aio", answer_present: true },
  ],
};

test("queryUniverseFromScan dedupes by query, keeps engines, drops branded and blank", () => {
  const universe = queryUniverseFromScan(SCAN);

  assert.deepEqual(
    universe.map((u) => u.query),
    [Q[0], Q[1]],
    "branded and empty prompts are excluded"
  );
  assert.deepEqual(universe[0].engines, ["aio", "chatgpt"], "one row per query, engines merged");
});

test("queryUniverseFromScan flags a query as a gap when present but not cited", () => {
  const universe = queryUniverseFromScan(SCAN);
  assert.equal(universe[0].is_gap, true, "present + not cited => gap");
  assert.equal(universe[1].is_gap, false, "cited => not a gap");
});

test("queryUniverseFromScan handles a missing or empty scan", () => {
  assert.deepEqual(queryUniverseFromScan(null), []);
  assert.deepEqual(queryUniverseFromScan({}), []);
  assert.deepEqual(queryUniverseFromScan({ raw_results: { results: [] } }), []);
});

test("the universe feeds straight into the rollup", () => {
  const universe = queryUniverseFromScan(SCAN);
  const rows = rollupCoverage({
    queries: universe,
    items: [item("i1", "approved", [Q[0]])],
  });
  assert.equal(rows[0].state, "covered");
  assert.equal(rows[0].is_gap, true);
  assert.deepEqual(rows[0].engines, ["aio", "chatgpt"]);
  assert.equal(summarizeCoverage(rows).gap_coverage_pct, 100);
});
