import { NextResponse } from "next/server";
import { getScansForBrand } from "@/lib/db";

/** Shape DB rows for normalizeResult: summary_stats, flat metrics, and results. */
function enrichScanForClient(scan) {
  const raw = scan.raw_results || {};
  const results = raw.results || scan.results || [];
  const used =
    scan.used_dynamic_prompts ??
    raw.used_dynamic_prompts ??
    raw.usedDynamicPrompts;

  const summary_stats =
    raw.summary_stats ||
    (scan.visibility_pct != null
      ? {
          visibility_pct: Number(scan.visibility_pct),
          mention_rate_pct:
            scan.mention_rate_pct ?? raw.mention_rate_pct ?? null,
          non_branded_queries: scan.prompts_tracked ?? null,
          visible_non_branded: scan.prompts_mentioned ?? null,
          aio_coverage_pct: raw.aio_coverage_pct ?? null,
          citation_share_pct:
            raw.brand_citation_share_pct ?? raw.citation_share_pct ?? null,
          branded_visibility_pct: raw.branded_visibility_pct ?? null,
          error_rate_pct: raw.aio_error_rate_pct ?? raw.error_rate_pct ?? null,
          data_source_issue: raw.data_source_issue ?? false,
          insufficient_sample: raw.insufficient_sample ?? false,
        }
      : null);

  return {
    ...scan,
    website: scan.url,
    used_dynamic_prompts: !!used,
    competitor_count: Array.isArray(raw.competitors)
      ? raw.competitors.length
      : scan.competitors?.length || 0,
    competitors: scan.competitors ?? raw.competitors ?? [],
    results,
    summary_stats,
    aio_coverage_pct:
      raw.aio_coverage_pct ?? summary_stats?.aio_coverage_pct ?? null,
    brand_citation_share_pct:
      raw.brand_citation_share_pct ??
      summary_stats?.citation_share_pct ??
      null,
    branded_visibility_pct:
      raw.branded_visibility_pct ??
      summary_stats?.branded_visibility_pct ??
      null,
    aio_error_rate_pct:
      raw.aio_error_rate_pct ?? summary_stats?.error_rate_pct ?? null,
    data_source_issue:
      raw.data_source_issue ?? summary_stats?.data_source_issue ?? false,
    insufficient_sample:
      raw.insufficient_sample ?? summary_stats?.insufficient_sample ?? false,
    query_source: scan.query_source ?? raw.query_source ?? null,
    seeds: raw.seeds ?? [],
  };
}

export async function GET(request, { params }) {
  try {
    const { brand } = params;
    if (!brand) {
      return NextResponse.json({ detail: "Brand is required." }, { status: 400 });
    }

    const scans = await getScansForBrand(brand);
    const normalized = (scans || []).map(enrichScanForClient);
    return NextResponse.json({ scans: normalized });
  } catch (error) {
    console.error("Error fetching scan history:", error);
    return NextResponse.json({ detail: "Internal Server Error" }, { status: 500 });
  }
}
