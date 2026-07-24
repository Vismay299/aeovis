import { NextResponse } from "next/server";
import { getPromptMetrics } from "@/lib/db/analytics";
import { groupPromptRows } from "@/lib/analytics/promptMetrics";

// Same rationale as the sibling metrics/citations/gaps routes (P0.4): a new
// scan can change every row in this table, so never statically cache.
export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

function requireBrandKey(params) {
  const { brand } = params || {};
  if (!brand) return { brandKey: null, error: "Brand is required." };
  const brandKey = decodeURIComponent(brand);
  if (!brandKey.trim()) return { brandKey: null, error: "Brand is required." };
  return { brandKey, error: null };
}

/**
 * Validates the optional `range` query param: how many scans back from the
 * target scan counts as "the previous scan" for delta purposes (default 1 —
 * the immediately-prior scan). Absent/empty is valid (defaults to 1).
 */
function parseRangeParam(raw) {
  if (raw == null || raw === "") return { range: 1, error: null };
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    return { range: null, error: "range must be a positive integer." };
  }
  return { range: n, error: null };
}

/**
 * GET /api/brands/[brand]/prompts/metrics?scan=<id>&range=<n> — P2a
 * (docs/plans/plan.md §4 P0.4 line 309 / §5 Phase 2 "Prompt metrics table").
 *
 * Brand-keying contract: identical to every sibling /api/brands/[brand]/*
 * analytics route — `[brand]` is ALREADY a resolveBrandKey() output (see
 * src/lib/scoring/brandKey.js), used verbatim (decoded) as the
 * prompt_results.brand lookup key, never re-resolved here.
 *
 * Query params (both optional):
 *   scan  — a specific scan id to aggregate, instead of the brand's latest.
 *   range — how many scans back from the target scan is "the previous scan"
 *           for `delta_visibility_pct` (default 1: the immediately-prior
 *           scan). Positive integer.
 *
 * Aggregation: raw prompt_results rows for the target (+ previous) scan are
 * fetched via src/lib/db/analytics.js's getPromptMetrics, then collapsed
 * from one-row-per-(query,engine) to one-row-per-query by the pure
 * groupPromptRows (src/lib/analytics/promptMetrics.js — independently
 * unit-tested, see promptMetrics.test.mjs) — kept out of this file so the
 * grouping/null-handling/delta math is testable without booting Next.js.
 *
 * Response 200: `{ brand, scan_id, prev_scan_id, prompts: [...] }`. A brand
 * with NO prompt_results yet (never scanned under this key, and no `scan`
 * was requested) is a 200 with `scan_id: null, prev_scan_id: null,
 * prompts: []` — an honest EMPTY STATE for the dashboard to render, never a
 * crash (P2a spec) — a brand simply hasn't been scanned yet, not an error.
 * Response 404: a `scan` id was explicitly requested and it does not belong
 * to this brand at all (wrong brand, typo, someone else's scan) — a
 * specific-resource lookup that legitimately doesn't exist, unlike the
 * empty-collection case above. Detected via `rows.length === 0` after a
 * requested `scan`: getPromptMetrics only ever resolves a scan id that
 * came from THIS brand's own scan_id list, so any row for it is guaranteed
 * to exist when it truly belongs to the brand (see that function's
 * docstring) — an empty result for a requested id is unambiguous.
 * Other errors: 400 on a missing brand or an invalid `range`; 500 on a DB
 * failure (message never echoes the raw DB error to the client).
 */
export async function GET(request, { params }) {
  try {
    const { brandKey, error: brandError } = requireBrandKey(params);
    if (brandError) {
      return NextResponse.json({ error: brandError }, { status: 400 });
    }

    const { searchParams } = new URL(request.url);
    const scanParam = searchParams.get("scan");
    const { range, error: rangeError } = parseRangeParam(searchParams.get("range"));
    if (rangeError) {
      return NextResponse.json({ error: rangeError }, { status: 400 });
    }

    let scanId;
    let prevScanId;
    let rows;
    try {
      ({ scanId, prevScanId, rows } = await getPromptMetrics(brandKey, { scanId: scanParam || null, range }));
    } catch (dbError) {
      console.error(`Error fetching prompt metrics for "${brandKey}":`, dbError);
      return NextResponse.json({ error: "Failed to load prompt metrics." }, { status: 500 });
    }

    if (scanParam && (rows || []).length === 0) {
      return NextResponse.json({ error: "Scan not found for this brand." }, { status: 404 });
    }

    const prompts = groupPromptRows(rows, { scanId, prevScanId });

    return NextResponse.json(
      { brand: brandKey, scan_id: scanId, prev_scan_id: prevScanId, prompts },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    console.error("Error in GET /api/brands/[brand]/prompts/metrics:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
