import { supabase } from "@/lib/db";

// Private helper module (the `_lib` prefix opts it out of Next.js route
// resolution) shared by the two new P0.3 single-scan endpoints:
// GET /api/scans/by-id/[scanId] and GET /api/scans/[brand]/latest.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isValidScanId(id) {
  return typeof id === "string" && UUID_RE.test(id);
}

/**
 * Fetch one `scans` row by its uuid primary key. Returns null both when the
 * row is absent AND when Supabase isn't configured — same fail-quiet
 * convention as getScansForBrand in src/lib/db.js (which returns [] rather
 * than throwing when `!supabase`), so a dev environment without a DB reads
 * as a clean 404 instead of a 500.
 */
export async function getScanById(scanId) {
  if (!supabase) return null;

  const { data, error } = await supabase
    .from("scans")
    .select("*")
    .eq("id", scanId);
  if (error) throw error;
  return (data && data[0]) || null;
}

/**
 * Shape a raw `scans` row (with its `raw_results` JSONB payload) into the
 * dual-shape record normalizeResult() expects — same transform as
 * enrichScanForClient() in src/app/api/scans/[brand]/route.js. Duplicated
 * here (rather than imported) so that sibling route file — owned outside
 * this package — never needs to change; keep the two in sync by hand if
 * either evolves.
 */
export function enrichScanForClient(scan) {
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
