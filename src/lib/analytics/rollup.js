/**
 * Single source of truth for `brand_metrics_daily` rollup math.
 *
 * Both the live scan pipeline (src/lib/workers/scanWorker.js, inside
 * runFinalizePhase) and the historical backfill (scripts/backfill-analytics.mjs)
 * import EVERY function in this module rather than keeping their own copies.
 * Before this module existed the two files hand-duplicated this logic; two
 * hand-kept copies WILL drift, and live-vs-backfilled brand_metrics_daily rows
 * silently diverging is exactly the failure mode this file exists to prevent
 * (plan.md P0.2 adversarial review, FIX B).
 *
 * IST bucketing (toDateOnly / IST_OFFSET_MS) in particular MUST stay identical
 * between the two call sites: a scan finalized at (say) 00:30 IST has to land
 * in the same `brand_metrics_daily.date` bucket whether it was scored live or
 * reconstructed later by the backfill from `scans.raw_results` — a mismatch
 * here would silently split what should be one day's data across two rows.
 */

// India-first product (SERP_GEO defaults to 'in'): bucket brand_metrics_daily
// rows by IST calendar day, not UTC, so a 00:00-05:30 IST scan doesn't fall
// on the previous UTC day's bucket, and two same-IST-day scans don't split
// across buckets.
export const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/** IST calendar-day bucketing. Returns null for an unparseable timestamp. */
export function toDateOnly(ts) {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return null;
  return new Date(d.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/**
 * Distinct-prompt (union-across-engines) counts for the blended 'all' row.
 * Every engine probes the SAME non-branded prompt set, so the 'all' row's
 * prompt counts must represent that set ONCE — a prompt answered on >=1
 * engine counts once — never the per-(prompt x engine) sum (which would
 * report N x engines and never reconcile with the per-prompt
 * visibility_index_pct). Operates directly on persisted `prompt_results` rows
 * (query/answered/mentioned/is_branded_query columns), not raw probe
 * objects. Returns null when there are no non-branded rows at all.
 */
export function unionPromptCounts(promptResultRows) {
  const nb = (promptResultRows || []).filter((r) => !r.is_branded_query);
  if (nb.length === 0) return null;
  const norm = (q) => String(q || "").toLowerCase().trim();
  const total = new Set(nb.map((r) => norm(r.query)));
  const answered = new Set(nb.filter((r) => r.answered).map((r) => norm(r.query)));
  const mentioned = new Set(nb.filter((r) => r.mentioned).map((r) => norm(r.query)));
  return { total: total.size, answered: answered.size, mentioned: mentioned.size };
}

/**
 * P1.2/P1.3 rollup math — sov_pct / sentiment_avg / position_avg — computed
 * from per-(result,brand) judgment rows (self + every tracked rival,
 * attached by enginePipeline.js's judgeBrandsSymmetric at probe time and
 * exploded into a flat rollup-ready array by runFinalizePhase), scoped to
 * the SAME non-branded pool visibility_pct itself is computed over
 * (`is_branded_query` on each row, mirroring unionPromptCounts above).
 *
 * Each row is `{ engine, is_branded_query, name, is_self, mentioned,
 * position, sentiment }` — one row per (answer, tracked brand). Formulas:
 *
 *   sov_pct        = self mentions / ALL tracked-brand mentions (self + rivals)
 *   sentiment_avg  = mean of the self brand's non-null sentiment values
 *   position_avg   = mean of the self brand's non-null position values
 *
 * `engine` scopes to one engine's rows (per-engine brand_metrics_daily
 * rows); pass null/omit for the blended 'all' row, which blends every
 * engine's rows together in one pool (matching how the 'all' row's other
 * fields blend across engines).
 *
 * Historical-safe: `brandJudgmentRows` is `[]`/undefined for backfilled
 * scans (raw_results predates P1.2 and carries no per-brand data) — all
 * three values come back null, the same "no source yet" contract
 * summaryToMetricsRow already falls back to when `brandRollup` is omitted.
 */
export function computeBrandRollups(brandJudgmentRows, { engine = null } = {}) {
  const rows = (brandJudgmentRows || []).filter(
    (r) => !r.is_branded_query && (engine == null || r.engine === engine)
  );
  if (rows.length === 0) {
    return { sov_pct: null, sentiment_avg: null, position_avg: null };
  }

  const selfRows = rows.filter((r) => r.is_self);
  const allMentionedCount = rows.filter((r) => r.mentioned).length;
  const selfMentionedCount = selfRows.filter((r) => r.mentioned).length;
  const sov_pct = allMentionedCount > 0 ? Math.round((selfMentionedCount / allMentionedCount) * 1000) / 10 : null;

  const selfSentiments = selfRows.filter((r) => r.sentiment != null).map((r) => r.sentiment);
  const sentiment_avg =
    selfSentiments.length > 0
      ? Math.round((selfSentiments.reduce((a, b) => a + b, 0) / selfSentiments.length) * 10) / 10
      : null;

  const selfPositions = selfRows.filter((r) => r.position != null).map((r) => r.position);
  const position_avg =
    selfPositions.length > 0
      ? Math.round((selfPositions.reduce((a, b) => a + b, 0) / selfPositions.length) * 10) / 10
      : null;

  return { sov_pct, sentiment_avg, position_avg };
}

/**
 * Builds one engine-scoped brand_metrics_daily row from a per-engine (or
 * top-level backward-compat) summary object. `answeredKey` accounts for the
 * two field names summary objects use for "non-branded queries that got an
 * answer":
 *   - per-engine (enginePipeline.js summarizeEngineSlice output):
 *     `non_branded_with_answer`, and NO citation_share_pct field (computed
 *     here from cited_non_branded/non_branded_with_answer since raw
 *     per-engine slices don't carry it directly).
 *   - v8.1 / backward-compat top-level summary (aioPipeline.js
 *     summarizeAioResults output, used for single-engine scans):
 *     `non_branded_with_aio`, and citation_share_pct IS already present —
 *     preferred over recomputing it.
 *
 * prompts_total/answered/mentioned are scoped to the non-branded pool
 * (non_branded_queries / *_with_answer|aio / mentioned_non_branded) — the
 * same denominators visibility_pct itself is computed over, so the row is
 * internally consistent. Missing fields default to 0 (not null) — a row
 * always reports a real count for a pool it actually measured.
 *
 * `brandRollup` (P1.2/P1.3, optional): `{ sov_pct, sentiment_avg,
 * position_avg }` from computeBrandRollups above. Omitted entirely by every
 * caller that has no per-brand source — e.g. scripts/backfill-analytics.mjs,
 * which reconstructs historical rows with no per-rival position/sentiment to
 * explode — in which case all three stay null, unchanged from before P1.2.
 */
export function summaryToMetricsRow({ brand, date, engine, scanId, promptSetId, summary, answeredKey, brandRollup }) {
  const nonBrandedTotal = summary.non_branded_queries ?? 0;
  const nonBrandedAnswered = summary[answeredKey] ?? 0;
  const mentioned = summary.mentioned_non_branded ?? 0;
  const cited = summary.cited_non_branded ?? 0;
  const visibilityPct = summary.visibility_pct ?? summary.share_of_ai_pct ?? null;
  const citationSharePct =
    summary.citation_share_pct ??
    (nonBrandedAnswered > 0 ? Math.round((cited / nonBrandedAnswered) * 1000) / 10 : null);
  const rollup = brandRollup || {};

  return {
    brand,
    date,
    engine,
    visibility_pct: visibilityPct,
    sov_pct: rollup.sov_pct ?? null,
    sentiment_avg: rollup.sentiment_avg ?? null,
    position_avg: rollup.position_avg ?? null,
    citation_share_pct: citationSharePct,
    prompts_total: nonBrandedTotal,
    prompts_answered: nonBrandedAnswered,
    prompts_mentioned: mentioned,
    scan_id: scanId,
    prompt_set_id: promptSetId ?? null,
  };
}

/**
 * Builds the brand_metrics_daily rows (per-engine + blended 'all') for one
 * scan — live or backfilled:
 *   - Multi-engine: one row per engine via summaryToMetricsRow
 *     (answeredKey: "non_branded_with_answer"), plus a blended 'all' row
 *     whose prompt counts are the UNION across engines (unionPromptCounts)
 *     while its citation_share_pct stays a summed pair-rate (cited
 *     answer-pairs / answer-pairs across engines) — "counts = union, rate =
 *     summed", matching the historical backfill's original split exactly.
 *     Falls back to a single engine's N when per-prompt rows are absent
 *     (union is null).
 *   - Single-engine (aio only): one 'aio' row via summaryToMetricsRow
 *     (answeredKey: "non_branded_with_aio") and an identical 'all' row,
 *     since aio is the only engine that ran.
 *
 * `brandJudgmentRows` (P1.2/P1.3, optional): fed straight into
 * computeBrandRollups for each row built below — per-engine rows get that
 * engine's slice, the blended 'all' row gets the cross-engine blend (no
 * engine filter). Omitted by scripts/backfill-analytics.mjs (no per-brand
 * source for historical scans), in which case every row's sov_pct/
 * sentiment_avg/position_avg stay null exactly as they did before P1.2.
 */
export function buildMetricsRows({
  isMultiEngine,
  brandKey,
  dateOnly,
  scanId,
  promptSetId,
  summary,
  engineSummaries,
  headline,
  promptResultRows,
  brandJudgmentRows,
}) {
  const rows = [];

  if (isMultiEngine) {
    let sumAnswered = 0;
    let sumCited = 0;
    let singleEngineTotal = 0;

    for (const [engineName, s] of Object.entries(engineSummaries || {})) {
      const row = summaryToMetricsRow({
        brand: brandKey,
        date: dateOnly,
        engine: engineName,
        scanId,
        promptSetId,
        summary: s,
        answeredKey: "non_branded_with_answer",
        brandRollup: computeBrandRollups(brandJudgmentRows, { engine: engineName }),
      });
      rows.push(row);
      sumAnswered += row.prompts_answered || 0;
      sumCited += s.cited_non_branded ?? 0;
      // Every engine shares the same prompt set, so any engine's non-branded
      // count is the true per-scan prompt total (use the max as a robust pick).
      singleEngineTotal = Math.max(singleEngineTotal, row.prompts_total || 0);
    }

    const union = unionPromptCounts(promptResultRows);
    const blendedRollup = computeBrandRollups(brandJudgmentRows); // no engine filter -> blends every engine
    rows.push({
      brand: brandKey,
      date: dateOnly,
      engine: "all",
      visibility_pct: headline?.visibility_index_pct ?? null,
      sov_pct: blendedRollup.sov_pct,
      sentiment_avg: blendedRollup.sentiment_avg,
      position_avg: blendedRollup.position_avg,
      citation_share_pct: sumAnswered > 0 ? Math.round((sumCited / sumAnswered) * 1000) / 10 : null,
      prompts_total: union ? union.total : singleEngineTotal,
      prompts_answered: union ? union.answered : null,
      prompts_mentioned: union ? union.mentioned : null,
      scan_id: scanId,
      prompt_set_id: promptSetId ?? null,
    });
  } else {
    const aioRow = summaryToMetricsRow({
      brand: brandKey,
      date: dateOnly,
      engine: "aio",
      scanId,
      promptSetId,
      summary,
      answeredKey: "non_branded_with_aio",
      brandRollup: computeBrandRollups(brandJudgmentRows, { engine: "aio" }),
    });
    rows.push(aioRow, { ...aioRow, engine: "all" });
  }

  return rows;
}
