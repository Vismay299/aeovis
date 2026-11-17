import { supabase, ScansUnavailableError } from "@/server/db";
import { terminalOutcomeFromRecord } from "@/shared/scanOutcome";

// Private helper module (the `_lib` prefix opts it out of Next.js route
// resolution) shared by the two new P0.3 single-scan endpoints:
// GET /api/scans/by-id/[scanId] and GET /api/scans/[brand]/latest.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isValidScanId(id) {
  return typeof id === "string" && UUID_RE.test(id);
}

/**
 * Fetch one `scans` row by its uuid primary key. A postgrest error is
 * rethrown, so a DB outage reaches the route's catch as a 500 rather than a
 * 404 — the distinction R2.8.4 is about.
 *
 * NOW THE SAME CONVENTION AS getScansForBrand (R2.8.5). This used to `return
 * null` when `!supabase`, which the by-id route turns into 404 "Scan not
 * found." — so a deploy with no Supabase credentials told every visitor of
 * /dashboard/[brand]/[scanId] that their scan did not exist, when the truth is
 * that nothing was ever asked. There is no memory fallback for scans
 * (insertScan refuses without a client), so no scan could exist to find:
 * `null` there was a statement about the environment dressed up as a statement
 * about the row. It throws ScansUnavailableError with code `db_not_configured`
 * instead, and the route's existing catch returns a 500.
 *
 * `null` now has exactly one meaning left: the database answered and holds no
 * row with this id — a genuine 404.
 *
 * @throws {ScansUnavailableError} db_not_configured
 * @throws {object} the raw postgrest error envelope, when the DB answered with one
 */
export async function getScanById(scanId) {
  if (!supabase) {
    throw new ScansUnavailableError(
      "Supabase is not configured — this scan cannot be read.",
      { code: "db_not_configured" }
    );
  }

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
    share_of_voice_pct:
      scan.share_of_voice_pct ??
      raw.share_of_voice_pct ??
      summary_stats?.share_of_voice_pct ??
      null,
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
    // R03.4a — the versioned terminal collection outcome, read through the same
    // shared reader the status endpoint uses. A historical row that predates the
    // vocabulary reads as `legacy` with null counts, never a fabricated 100%.
    terminal_outcome: terminalOutcomeFromRecord(scan),
    query_source: scan.query_source ?? raw.query_source ?? null,
    seeds: raw.seeds ?? [],
  };
}
