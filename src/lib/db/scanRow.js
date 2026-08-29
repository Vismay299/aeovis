/**
 * Shapes the `scans` row insertScan writes.
 *
 * Extracted from db.js so it can be unit-tested: db.js imports the Supabase
 * SDK at module scope, which makes every assertion about the row it builds
 * impossible to run without a live client. The bug this file exists to catch
 * is exactly that kind: `scans.competitors` has existed as a column since
 * migration 001 and was never written, so every scan in production has a null
 * competitor roster on the row while the real value hid inside
 * `raw_results.competitors` (R0.3.3 / known-open "scans.competitors always
 * null").
 *
 * Pure. No imports, no I/O.
 */

/**
 * The column set present in EVERY deployment (migration 001), used by all
 * three of insertScan's schema-fallback cascades.
 *
 * @param {object} scanRecord
 */
export function buildScanBaseRecord(scanRecord) {
  return {
    brand: scanRecord.brand,
    url: scanRecord.url,
    industry: scanRecord.industry,
    visibility_pct: scanRecord.visibility_pct,
    prompts_tracked: scanRecord.prompts_tracked,
    prompts_mentioned: scanRecord.prompts_mentioned,
    // migration 001 line 15: `competitors jsonb`. Written here, not just into
    // raw_results, so a SQL reader sees the roster without unpacking JSONB.
    // Never `?? []` this from a null roster — see the note below.
    competitors: scanRecord.competitors || [],
    raw_results: scanRecord.raw_results,
    scanned_at: scanRecord.scanned_at,
  };
}
