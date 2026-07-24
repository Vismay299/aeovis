import { NextResponse } from "next/server";
import { getBrandMetricsSeries } from "@/lib/db/analytics";
import { parseEngineParam, parseDateParam, computeVisibilitySummary, MAX_SERIES_ROWS } from "@/lib/brandAnalyticsApi";

// This must always be fresh — a scheduled/manual re-scan lands new
// brand_metrics_daily rows the client needs to see immediately (same reason
// src/app/api/scans/[brand]/route.js forces dynamic).
export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

/**
 * GET /api/brands/[brand]/metrics — plan.md §4 P0.4.
 *
 * Brand-keying contract: the `[brand]` path param is ALREADY a
 * resolveBrandKey() output (the domain, e.g. "snitch.com") — every
 * brand_metrics_daily row is stored under that same key, never the typed
 * display name (see src/lib/scoring/brandKey.js and migration 005). This
 * route uses the decoded param VERBATIM as the lookup key; it never re-runs
 * resolveBrandKey (that function needs a url, which this route doesn't have).
 *
 * Query params (all optional):
 *   from   — ISO date, inclusive lower bound on `date` (omitted = all history)
 *   to     — ISO date, inclusive upper bound on `date`
 *   engine — one of aio | chatgpt | perplexity | all (default "all", the
 *            blended row brand_metrics_daily always carries per plan.md P0.1)
 *
 * Response 200: { brand, engine, series, summary }
 *   series  — brand_metrics_daily rows ordered by date ascending, one row per
 *             day for the requested engine; defensively capped at
 *             MAX_SERIES_ROWS (keeps the most recent rows — no pagination,
 *             per plan.md P0.4: this is a bounded time series, not a list)
 *   summary — { latest_date, latest_visibility_pct, previous_visibility_pct,
 *             delta_visibility_pct } — the Overview trend header's minimum
 *             payload, null-safe when the series has fewer than 2 points
 *
 * Errors: 400 on a missing brand or an invalid engine/from/to; 500 on a DB
 * failure (message never echoes the raw DB/SQL error to the client).
 */
export async function GET(request, { params }) {
  try {
    const { brand } = params || {};
    if (!brand || !decodeURIComponent(brand).trim()) {
      return NextResponse.json({ error: "Brand is required." }, { status: 400 });
    }
    const brandKey = decodeURIComponent(brand);

    const { searchParams } = new URL(request.url);

    const { engine, error: engineError } = parseEngineParam(searchParams.get("engine"));
    if (engineError) {
      return NextResponse.json({ error: engineError }, { status: 400 });
    }

    const { date: from, error: fromError } = parseDateParam(searchParams.get("from"), "from");
    if (fromError) {
      return NextResponse.json({ error: fromError }, { status: 400 });
    }

    const { date: to, error: toError } = parseDateParam(searchParams.get("to"), "to");
    if (toError) {
      return NextResponse.json({ error: toError }, { status: 400 });
    }

    let rows;
    try {
      rows = await getBrandMetricsSeries(brandKey, { from, to, engine });
    } catch (dbError) {
      console.error(`Error fetching brand metrics for "${brandKey}":`, dbError);
      return NextResponse.json({ error: "Failed to load brand metrics." }, { status: 500 });
    }

    // Most-recent-first cap: a trend chart cares about recency over depth,
    // and rows are already ascending, so slice(-N) keeps the tail.
    const capped = (rows || []).slice(-MAX_SERIES_ROWS);

    const series = capped.map((row) => ({
      date: row.date,
      engine: row.engine,
      visibility_pct: row.visibility_pct ?? null,
      sov_pct: row.sov_pct ?? null,
      sentiment_avg: row.sentiment_avg ?? null,
      position_avg: row.position_avg ?? null,
      citation_share_pct: row.citation_share_pct ?? null,
      prompts_total: row.prompts_total ?? null,
      prompts_answered: row.prompts_answered ?? null,
      prompts_mentioned: row.prompts_mentioned ?? null,
      prompt_set_id: row.prompt_set_id ?? null,
    }));

    const summary = computeVisibilitySummary(series);

    return NextResponse.json(
      { brand: brandKey, engine, series, summary },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    console.error("Error in GET /api/brands/[brand]/metrics:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
