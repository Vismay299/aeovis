import { JOB_STAGES } from "./stages.js";
import { normalizeScanRows } from "./steps/shared.js";

/**
 * Query coverage rollup (plan: docs/plans/2026-07-28-agent-control-plane.md, T4).
 *
 * Paperclip's parent/child primitive is `autoAdvanceOnChildrenTerminal`: a
 * parent case advances once every child case is terminal. Their worked example
 * is release → feature → content-piece, which is structurally our
 * scan → gap → article.
 *
 * We cannot copy it literally because gaps are DERIVED, not stored:
 * analytics/gaps.js and dailyBatch.selectGapsForBatch compute them from
 * citations + result_brands on every read, so there is no parent row to
 * advance. The equivalent is to compute the rollup over the join key that DOES
 * exist and is already relied on by dailyBatch's dedupe:
 *
 *   content_jobs.input.query   ↔   content_items.target_queries
 *
 * Everything here is pure — plain arrays in, plain objects out, no DB, no LLM —
 * matching the house convention for analytics modules (see analytics/gaps.js).
 */

/** Highest precedence first: the state a query resolves to when signals conflict. */
export const COVERAGE_PRECEDENCE = [
  "covered",
  "awaiting_approval",
  "in_progress",
  "rejected",
  "uncovered",
];

function queryKey(text) {
  return String(text || "").toLowerCase().trim();
}

/** An item's contribution to its target queries' coverage. */
const ITEM_STATE = {
  approved: "covered",
  awaiting_approval: "awaiting_approval",
  // A revision pass is in flight — work is happening, it is not the human's turn.
  changes_requested: "in_progress",
  draft: "in_progress",
  rejected: "rejected",
};

/**
 * A job's contribution, derived from its stage KIND (T2) rather than a second
 * hardcoded status list — a new working status in JOB_STAGES rolls up correctly
 * with no edit here.
 *
 * `failed` is deliberately NOT "rejected": a crash or a cost-cap stop is an
 * infrastructure outcome, not a human "no". It contributes no state and is
 * surfaced separately as `failed_attempts` so an operator can see that the
 * query was attempted and needs a retry rather than a decision.
 */
function jobState(status) {
  if (status === "failed") return null;
  const stage = JOB_STAGES[status];
  if (!stage) return null;
  if (stage.kind === "open" || stage.kind === "working") return "in_progress";
  if (stage.kind === "review") return "awaiting_approval";
  if (stage.kind === "done") return "covered";
  if (stage.kind === "cancelled") return "rejected";
  return null;
}

function strongest(states) {
  for (const candidate of COVERAGE_PRECEDENCE) {
    if (states.has(candidate)) return candidate;
  }
  return "uncovered";
}

/**
 * The query universe for a brand: every UNBRANDED tracked query in a scan,
 * flagged with whether it is currently a gap.
 *
 * `is_gap` uses the same predicate as dailyBatch.selectGapsForBatch (present in
 * the answer but the brand is not cited) so "gap" means one thing across the
 * product. Branded queries are excluded: the prompt-set contract treats the
 * unbranded set as the measured universe.
 */
export function queryUniverseFromScan(scan) {
  const rows = normalizeScanRows(scan).filter((r) => !r.is_branded_query);
  const byQuery = new Map();
  for (const r of rows) {
    const key = queryKey(r.prompt);
    if (!key) continue;
    const entry = byQuery.get(key) || { query: r.prompt, is_gap: false, engines: [] };
    if (r.present && !r.brand_cited) entry.is_gap = true;
    if (r.engine && !entry.engines.includes(r.engine)) entry.engines.push(r.engine);
    byQuery.set(key, entry);
  }
  return Array.from(byQuery.values());
}

/**
 * Roll jobs + items up onto queries.
 *
 * `queries` accepts plain strings or `{ query, is_gap, engines }` objects, so
 * callers can pass queryUniverseFromScan's output straight through or hand in
 * an arbitrary list.
 */
export function rollupCoverage({ queries = [], jobs = [], items = [] } = {}) {
  const universe = queries.map((q) => (typeof q === "string" ? { query: q } : q));

  // key → { states, items, jobs, failed_attempts }
  const signals = new Map();
  for (const q of universe) {
    const key = queryKey(q.query);
    if (key) signals.set(key, { states: new Set(), items: [], jobs: [], failed_attempts: 0 });
  }

  const bucket = (key) => (key && signals.has(key) ? signals.get(key) : null);

  for (const item of items) {
    const state = ITEM_STATE[item.status];
    for (const target of item.target_queries || []) {
      const b = bucket(queryKey(target));
      if (!b) continue;
      b.items.push({ id: item.id, status: item.status, title: item.title || null });
      if (state) b.states.add(state);
    }
  }

  for (const job of jobs) {
    const b = bucket(queryKey(job.input?.query));
    if (!b) continue;
    if (job.status === "failed") {
      b.failed_attempts += 1;
      continue;
    }
    // A job that already produced an item adds nothing the item hasn't said,
    // and would otherwise re-report a finished job as in_progress.
    if (job.item_id) continue;
    b.jobs.push({ id: job.id, status: job.status });
    const state = jobState(job.status);
    if (state) b.states.add(state);
  }

  return universe.map((q) => {
    const b = signals.get(queryKey(q.query)) || {
      states: new Set(),
      items: [],
      jobs: [],
      failed_attempts: 0,
    };
    return {
      query: q.query,
      is_gap: !!q.is_gap,
      engines: q.engines || [],
      state: strongest(b.states),
      items: b.items,
      jobs: b.jobs,
      failed_attempts: b.failed_attempts,
    };
  });
}

/**
 * Totals for the header line the GEO product is trying to earn:
 * "of the N prompts we track, M are covered by approved content".
 */
export function summarizeCoverage(rows = []) {
  const summary = {
    total: rows.length,
    covered: 0,
    awaiting_approval: 0,
    in_progress: 0,
    rejected: 0,
    uncovered: 0,
    gaps: 0,
    gaps_covered: 0,
    failed_attempts: 0,
    coverage_pct: 0,
    gap_coverage_pct: 0,
  };

  for (const row of rows) {
    summary[row.state] = (summary[row.state] || 0) + 1;
    summary.failed_attempts += row.failed_attempts || 0;
    if (row.is_gap) {
      summary.gaps += 1;
      if (row.state === "covered") summary.gaps_covered += 1;
    }
  }

  summary.coverage_pct = summary.total
    ? Math.round((summary.covered / summary.total) * 100)
    : 0;
  summary.gap_coverage_pct = summary.gaps
    ? Math.round((summary.gaps_covered / summary.gaps) * 100)
    : 0;

  return summary;
}
