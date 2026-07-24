/**
 * Per-prompt metrics aggregation (P2a — docs/plans/plan.md §4 P0.4 line 309:
 * `GET /api/brands/[brand]/prompts/metrics?scan|range`, and §5 Phase 2's
 * "Prompt metrics table"). Pure + unit-testable (see promptMetrics.test.mjs):
 * every function here operates on plain `prompt_results` rows already
 * fetched from the DB (src/lib/db/analytics.js's getPromptMetrics) — no DB
 * access, no LLM, fully deterministic. Mirrors the gaps.js / rollup.js /
 * chartMath.js convention of keeping grouping/scoring math out of the route
 * file and out of the component.
 */

function round1(n) {
  return Math.round(n * 10) / 10;
}

/**
 * Lowercased/trimmed match key for joining the same logical prompt across
 * two different scans (mirrors rollup.js's unionPromptCounts `norm`) — a
 * prompt's text can pick up incidental casing/whitespace drift between scans
 * without becoming "a different prompt" for delta purposes. The row's
 * ORIGINAL (non-normalized) query text is always what's returned for display.
 */
function normQuery(q) {
  return String(q || "").toLowerCase().trim();
}

/** Mean of only the non-null/finite values, or null when there are none — never 0. */
function meanOrNull(values) {
  const nums = (values || []).filter((v) => v != null && Number.isFinite(v));
  if (nums.length === 0) return null;
  return round1(nums.reduce((a, b) => a + b, 0) / nums.length);
}

/**
 * mentioned / answered * 100 for one prompt's engine rows — deliberately
 * mirrors src/lib/scoring/enginePipeline.js's own `visibilityPct` formula
 * (visibleNonBranded / nonBrandedWithAnswer.length) so "visibility" means the
 * same thing at the per-prompt level as it does at the whole-scan level.
 * 0 (never null) when no engine answered this prompt at all, matching that
 * same source's `: 0` fallback — an honest "no signal" reads as 0%, and the
 * accompanying `answered_count: 0` tells the full story alongside it.
 */
function computeVisibilityPct(groupRows) {
  const answered = (groupRows || []).filter((r) => r.answered === true);
  if (answered.length === 0) return 0;
  const mentioned = answered.filter((r) => r.mentioned === true).length;
  return round1((mentioned / answered.length) * 100);
}

/**
 * Groups prompt_results rows by normalized query text, preserving first-seen
 * order and the FIRST row's original (non-normalized) query text for display.
 * @returns {Map<string, {query: string, rows: object[]}>}
 */
function groupByQuery(rows) {
  const groups = new Map();
  for (const row of rows || []) {
    if (!row) continue;
    const key = normQuery(row.query);
    if (!key) continue; // defensive — schema requires query NOT NULL
    const bucket = groups.get(key);
    if (bucket) {
      bucket.rows.push(row);
    } else {
      groups.set(key, { query: row.query, rows: [row] });
    }
  }
  return groups;
}

/**
 * Picks the target ("latest", or a caller-specified) scan id and the
 * `range`-th-previous one from a brand's distinct scan_ids, already ordered
 * most-recent-first (src/lib/db/analytics.js's listBrandScanIds). Pure so
 * the scan-selection rule is unit-testable without a DB.
 *
 * - No scans at all -> `{ scanId: null, prevScanId: null }`.
 * - No `scanId` requested -> target is the most recent scan (index 0).
 * - `scanId` requested but not found in THIS brand's own list (wrong brand,
 *   typo, a scan that belongs to someone else) -> echoed back verbatim as
 *   the target with `prevScanId: null` — there's nothing of this brand's to
 *   diff against, so the caller ends up with an honest empty result instead
 *   of a thrown error.
 * - `range` (default 1) counts scans back from the target for the "previous"
 *   comparison point — `range: 2` compares against two scans ago instead of
 *   the immediately-prior one. Running off the start of the list ->
 *   `prevScanId: null` (no scan that far back yet).
 *
 * @param {string[]} scanIdsDesc distinct scan ids, most-recent-first
 * @param {{scanId?: string|null, range?: number}} [options]
 * @returns {{scanId: string|null, prevScanId: string|null}}
 */
export function pickScanIds(scanIdsDesc, { scanId: requestedScanId, range = 1 } = {}) {
  const ids = Array.isArray(scanIdsDesc) ? scanIdsDesc : [];
  if (ids.length === 0) return { scanId: null, prevScanId: null };

  const idx = requestedScanId ? ids.indexOf(requestedScanId) : 0;
  if (requestedScanId && idx === -1) {
    return { scanId: requestedScanId, prevScanId: null };
  }

  const step = Number.isInteger(range) && range > 0 ? range : 1;
  return { scanId: ids[idx], prevScanId: ids[idx + step] ?? null };
}

/**
 * Collapses per-(query,engine) prompt_results rows into one row per prompt
 * for the target scan (P2a: GET /api/brands/[brand]/prompts/metrics).
 * `rows` is the UNION of the target scan's rows AND the previous scan's rows
 * (src/lib/db/analytics.js's getPromptMetrics fetches exactly that pair) —
 * this function splits them back apart by `scan_id`, groups each side by
 * (normalized) query text, and joins the two on query text to compute each
 * prompt's `delta_visibility_pct`.
 *
 * Null handling (P2a spec — never fake a measurement):
 *   - `sentiment_avg` / `position_avg` are the mean of only the NON-NULL
 *     values across this prompt's engine rows for the target scan; a prompt
 *     where every engine row has sentiment/position === null (pre-P1.1
 *     historical scans never computed either, and an engine that never
 *     mentioned the brand never gets one either) reports null here too —
 *     NEVER 0. See meanOrNull.
 *   - `delta_visibility_pct` is null whenever there's no previous scan, or
 *     the previous scan has no row for this same query (a brand-new or
 *     edited prompt) — never a fabricated 0.
 *   - `visibility_pct` itself is never null (0 when nothing answered),
 *     mirroring enginePipeline.js's own visibilityPct convention — see
 *     computeVisibilityPct.
 *
 * @param {object[]} rows raw prompt_results rows for the target + previous scan
 * @param {{scanId?: string|null, prevScanId?: string|null}} [options] when
 *   `scanId` is omitted every row is treated as belonging to the target scan
 *   (lets a caller pass already-scoped rows straight through, e.g. tests).
 * @returns {object[]} one row per prompt, in first-seen order:
 *   `{ query, engines, engine_breakdown, visibility_pct,
 *      delta_visibility_pct, sentiment_avg, position_avg, intent,
 *      is_branded_query, answered_count, mentioned_count }`
 */
export function groupPromptRows(rows, { scanId, prevScanId } = {}) {
  const safeRows = Array.isArray(rows) ? rows : [];
  const currentRows = scanId ? safeRows.filter((r) => r && r.scan_id === scanId) : safeRows;
  const prevRows = prevScanId ? safeRows.filter((r) => r && r.scan_id === prevScanId) : [];

  const prevVisibilityByQuery = new Map();
  for (const [key, { rows: prevGroupRows }] of groupByQuery(prevRows)) {
    prevVisibilityByQuery.set(key, computeVisibilityPct(prevGroupRows));
  }

  const out = [];
  for (const [key, { query, rows: groupRows }] of groupByQuery(currentRows)) {
    const answeredRows = groupRows.filter((r) => r.answered === true);
    const mentionedCount = groupRows.filter((r) => r.mentioned === true).length;
    const visibilityPct = computeVisibilityPct(groupRows);
    const prevVisibilityPct = prevVisibilityByQuery.has(key) ? prevVisibilityByQuery.get(key) : null;
    const intentRow = groupRows.find((r) => r.intent != null);

    out.push({
      query,
      engines: answeredRows.map((r) => r.engine),
      engine_breakdown: groupRows.map((r) => ({
        engine: r.engine,
        answered: r.answered === true,
        mentioned: r.mentioned === true,
      })),
      visibility_pct: visibilityPct,
      delta_visibility_pct: prevVisibilityPct != null ? round1(visibilityPct - prevVisibilityPct) : null,
      sentiment_avg: meanOrNull(groupRows.map((r) => r.sentiment)),
      position_avg: meanOrNull(groupRows.map((r) => r.position)),
      intent: intentRow ? intentRow.intent : null,
      is_branded_query: groupRows.some((r) => !!r.is_branded_query),
      answered_count: answeredRows.length,
      mentioned_count: mentionedCount,
    });
  }

  return out;
}
