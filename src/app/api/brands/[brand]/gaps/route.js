import { NextResponse } from "next/server";
import { getCitationsForBrand, getResultBrandsForBrand } from "@/lib/db/analytics";
import { joinCitationsWithResultBrands, computeDomainGaps, computeUrlGaps } from "@/lib/analytics/gaps";

// Same rationale as the sibling metrics/citations routes (P0.4): a new scan
// can change the gap table, so never statically cache.
export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

const VALID_LEVELS = ["domain", "url"];
const GAPS_CAP = 100;

function parseLevelParam(raw) {
  if (raw == null || raw === "") return { level: "domain", error: null };
  const normalized = String(raw).trim().toLowerCase();
  if (!VALID_LEVELS.includes(normalized)) {
    return { level: null, error: `level must be one of: ${VALID_LEVELS.join(", ")}` };
  }
  return { level: normalized, error: null };
}

/**
 * GET /api/brands/[brand]/gaps?level=domain|url — P3a (plan.md §4 P0.4 /
 * §5 Phase 3).
 *
 * Brand-keying contract: identical to /api/brands/[brand]/metrics and
 * .../citations — `[brand]` is ALREADY a resolveBrandKey() output, used
 * verbatim as the citations.brand / result_brands.brand lookup key.
 *
 * No from/to here (unlike .../citations): gap analysis reads the brand's
 * FULL citation + result_brands history — a domain that only ever showed a
 * rival-not-you pattern three months ago is still a real, actionable gap;
 * see src/lib/analytics/gaps.js for the full gap_score formula.
 *
 * Query params: level — "domain" (default) or "url" granularity.
 *
 * Response 200: { brand, level, count, gaps } — gaps sorted gap_score desc
 *   (computeDomainGaps/computeUrlGaps's own tie-break), capped at 100 rows.
 * Response 404: this brand has NO citations AND NO result_brands rows at
 *   all — it has never actually been scanned. Zero COMPUTED gaps (a brand
 *   cited everywhere its rivals are) is a normal 200 with `gaps: []`, not a
 *   404 — "no gaps" is a good outcome, not a missing-data one.
 * Errors: 400 on a missing brand or an invalid level; 500 on a DB failure
 *   (message never echoes the raw DB error to the client).
 */
export async function GET(request, { params }) {
  params = await params;
  try {
    const { brand } = params || {};
    if (!brand || !decodeURIComponent(brand).trim()) {
      return NextResponse.json({ error: "Brand is required." }, { status: 400 });
    }
    const brandKey = decodeURIComponent(brand);

    const { searchParams } = new URL(request.url);
    const { level, error: levelError } = parseLevelParam(searchParams.get("level"));
    if (levelError) {
      return NextResponse.json({ error: levelError }, { status: 400 });
    }

    let citations;
    let resultBrands;
    try {
      [citations, resultBrands] = await Promise.all([
        getCitationsForBrand(brandKey, {}),
        getResultBrandsForBrand(brandKey, {}),
      ]);
    } catch (dbError) {
      console.error(`Error fetching gap data for "${brandKey}":`, dbError);
      return NextResponse.json({ error: "Failed to load gap data." }, { status: 500 });
    }

    if ((citations || []).length === 0 && (resultBrands || []).length === 0) {
      return NextResponse.json({ error: "No analytics data found for this brand." }, { status: 404 });
    }

    const joined = joinCitationsWithResultBrands(citations, resultBrands);
    const computeFn = level === "url" ? computeUrlGaps : computeDomainGaps;
    const gaps = computeFn(joined, { selfBrandKey: brandKey }).slice(0, GAPS_CAP);

    return NextResponse.json(
      { brand: brandKey, level, count: gaps.length, gaps },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    console.error("Error in GET /api/brands/[brand]/gaps:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
