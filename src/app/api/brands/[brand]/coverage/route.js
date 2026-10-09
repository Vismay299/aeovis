import { NextResponse } from "next/server";
import { getScansForBrand, getScansByDomain, joinScanIdentities } from "@/lib/db";
import { listContentJobs, listContentItems } from "@/lib/db/content";
import { queryUniverseFromScan, rollupCoverage, summarizeCoverage } from "@/lib/content/coverage";

// Same rationale as the sibling gaps/metrics/citations routes (P0.4): a new
// scan or a new approval changes coverage, so never statically cache.
export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

const JOB_SCAN_LIMIT = 200;


/**
 * GET /api/brands/[brand]/coverage — T4 (plan:
 * docs/plans/2026-07-28-agent-control-plane.md).
 *
 * Answers the sentence the GEO product exists to earn: "of the N unbranded
 * prompts we track, M are covered by approved content." Coverage is DERIVED on
 * read — jobs and items are joined onto the latest scan's query universe via
 * `content_jobs.input.query` ↔ `content_items.target_queries`, the same key
 * dailyBatch already dedupes on. Nothing is persisted, so a re-scan or a
 * decision is reflected immediately with no backfill.
 *
 * Brand-keying: this route spans TWO key spaces, which the first version got
 * wrong and a live call caught. The sibling routes (metrics/citations/gaps)
 * read analytics tables keyed by the resolved DOMAIN ("italicatiles.com"), but
 * `scans.brand` and `content_jobs.brand` hold the DISPLAY name ("Italica").
 * Passing the domain straight to getScansForBrand therefore 404'd for a brand
 * that has 30 tracked queries. We accept either form and resolve it below.
 *
 * Query params: `gaps_only=1` restricts the universe to current gap queries.
 *
 * Response 200: { brand, scanned_at, summary, coverage }
 * Response 404: the brand has never been scanned (no scan → no query universe).
 *   A scanned brand with zero approved content is a normal 200 with every row
 *   `uncovered` — that is a starting point, not missing data.
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
    const gapsOnly = searchParams.get("gaps_only") === "1";

    let scans;
    try {
      scans = await getScansForBrand(brandKey);
      // R3.4.3: A brand scanned both ways has one continuous history. Join
      // scheduled scans (keyed by domain) and manual scans (keyed by display name)
      // so neither identity is dropped.
      try {
        const domainScans = await getScansByDomain(brandKey);
        scans = joinScanIdentities(scans, domainScans);
      } catch (err) {
        if (err?.code !== "domain_required") throw err;
      }
    } catch (dbError) {
      console.error(`Error fetching scans for "${brandKey}":`, dbError);
      return NextResponse.json({ error: "Failed to load coverage data." }, { status: 500 });
    }

    const scan = scans?.[0];
    // Jobs and items are keyed by the same display name the scan carries, not
    // by whatever form the caller used.
    const contentKey = scan?.brand || brandKey;

    let jobs;
    let items;
    try {
      [jobs, items] = await Promise.all([
        listContentJobs(contentKey, JOB_SCAN_LIMIT),
        listContentItems(contentKey),
      ]);
    } catch (dbError) {
      console.error(`Error fetching content for "${contentKey}":`, dbError);
      return NextResponse.json({ error: "Failed to load coverage data." }, { status: 500 });
    }

    if (!scan) {
      return NextResponse.json(
        { error: "No scan found for this brand — nothing to measure coverage against." },
        { status: 404 }
      );
    }

    let universe = queryUniverseFromScan(scan);
    if (gapsOnly) universe = universe.filter((q) => q.is_gap);

    const coverage = rollupCoverage({ queries: universe, jobs: jobs || [], items: items || [] });

    return NextResponse.json(
      {
        brand: brandKey,
        scanned_at: scan.scanned_at || null,
        gaps_only: gapsOnly,
        summary: summarizeCoverage(coverage),
        coverage,
      },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    console.error("Error in GET /api/brands/[brand]/coverage:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
