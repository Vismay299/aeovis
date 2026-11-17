import { NextResponse } from "next/server";
import { getCitationsForBrand } from "@/server/db/analytics";
import { parseDateParam } from "@/shared/brandAnalyticsApi";
import { parseGroupParam, aggregateCitations } from "@/shared/analytics/citationStats";

// Citation rows land continuously (every finalized scan materializes a fresh
// batch — see runFinalizePhase) — never statically cache, same rationale as
// the sibling metrics/schedule routes (P0.4).
export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

// "Primary" is whichever dimension the caller asked to see in full (`group`);
// the other dimension is still returned (useful context for a UI that shows
// both panes at once) but capped smaller. content_types has no separate cap
// — it's at most CONTENT_TYPES.length (10) rows by construction.
const PRIMARY_CAP = 50;
const SECONDARY_CAP = 10;

/**
 * GET /api/brands/[brand]/citations?from&to&group=domain|url|type — P3a
 * (plan.md §4 P0.4 / §5 Phase 3).
 *
 * Brand-keying contract: identical to /api/brands/[brand]/metrics — the
 * `[brand]` path param is ALREADY a resolveBrandKey() output (the domain,
 * e.g. "snitch.com"); used verbatim (decoded) as the citations.brand lookup
 * key, never re-resolved here.
 *
 * Query params (all optional):
 *   from, to — ISO date, inclusive bounds on citations.created_at (a full
 *              calendar day on each end — see getCitationsForBrand /
 *              endOfDayIso in src/server/db/analytics.js)
 *   group    — which of domains/urls is returned IN FULL (capped at 50
 *              rows); the other is still included, capped at 10. Default
 *              "domain".
 *
 * Response 200: { brand, from, to, group, totals, domains, urls, content_types }
 *   totals         — { citations, distinct_domains, distinct_urls } over the window
 *   domains        — top domains: { domain, domain_type, citation_class,
 *                    is_self, count, share_pct }
 *   urls           — top urls: { url, domain, domain_type, content_type,
 *                    is_self, count, share_pct }
 *   content_types  — full distribution with per-type leaders: { content_type,
 *                    count, share_pct, leader_url, leader_domain, leader_count }
 *
 * Response 404: this brand has NEVER had a single citation recorded (checked
 *   only when NEITHER from nor to was given — an empty result for a
 *   SPECIFIC date range is a normal 200 with zeroed totals, not "not found").
 * Errors: 400 on a missing brand or an invalid group/from/to; 500 on a DB
 *   failure (message never echoes the raw DB error to the client).
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

    const { group, error: groupError } = parseGroupParam(searchParams.get("group"));
    if (groupError) {
      return NextResponse.json({ error: groupError }, { status: 400 });
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
      rows = await getCitationsForBrand(brandKey, { from, to });
    } catch (dbError) {
      console.error(`Error fetching citations for "${brandKey}":`, dbError);
      return NextResponse.json({ error: "Failed to load citations." }, { status: 500 });
    }

    if ((rows || []).length === 0 && !from && !to) {
      return NextResponse.json({ error: "No citation data found for this brand." }, { status: 404 });
    }

    const { totals, domains, urls, content_types } = aggregateCitations(rows);

    const domainsCap = group === "domain" ? PRIMARY_CAP : SECONDARY_CAP;
    const urlsCap = group === "url" ? PRIMARY_CAP : SECONDARY_CAP;

    return NextResponse.json(
      {
        brand: brandKey,
        from: from || null,
        to: to || null,
        group,
        totals,
        domains: domains.slice(0, domainsCap),
        urls: urls.slice(0, urlsCap),
        content_types,
      },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    console.error("Error in GET /api/brands/[brand]/citations:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
