/**
 * R4.3.1 — persist crawlability audit results and retrieve history.
 *
 * Every call to GET /api/brands/[brand]/crawlability produces a full audit
 * payload. This module stores it so the system can:
 *   1. Show audit history (when was the last audit, what changed).
 *   2. Detect changes between runs (bots that moved from open→blocked, etc.).
 *
 * The same "db_not_configured" / "db_write_failed" contract as db.js: when
 * Supabase is not configured, functions that WRITE throw rather than silently
 * skip (standing rule 2). READ functions degrade gracefully — returning empty
 * arrays — because a missing history is not a fatal error; it just means
 * "no previous audit to compare against".
 */

import { supabase } from "../db.js";

/**
 * @param {{}} [deps] test injection; deps.client overrides the module client
 */
function resolveClient(deps) {
  return deps?.client ?? supabase;
}

/**
 * The shape of one audit row as stored in crawlability_audits.
 *
 * @typedef {Object} CrawlabilityAuditRow
 * @property {string}  id
 * @property {string}  domain
 * @property {string}  test_path
 * @property {string}  audited_at     (ISO timestamp)
 * @property {boolean} fetched_ok
 * @property {string|null} robots_txt_status
 * @property {boolean} robots_malformed
 * @property {string|null} fetch_error
 * @property {boolean|null} llms_txt_present
 * @property {{ open: number, partial: number, blocked: number, total: number }} summary
 * @property {Array<{ name: string, status: string, [key: string]: any }>} bots
 * @property {Object|null} diff
 */

/**
 * Save a crawlability audit result.
 *
 * Uses an upsert keyed on (domain, minute-truncated audited_at) so rapid
 * refreshes within the same minute overwrite rather than duplicate. The first
 * audit for a domain+path has no diff; the diff is computed and attached by
 * the caller (crawlabilityChanges.js) before this function is called.
 *
 * @param {Object} audit
 * @param {string} audit.domain
 * @param {string} [audit.testPath="/"]
 * @param {boolean} audit.fetched_ok
 * @param {string|null} [audit.robots_txt_status]
 * @param {boolean} [audit.robots_malformed]
 * @param {string|null} [audit.fetch_error]
 * @param {boolean|null} [audit.llms_txt_present]
 * @param {{ open: number, partial: number, blocked: number, total: number }} audit.summary
 * @param {Array} [audit.bots]
 * @param {Object|null} [audit.diff]
 * @param {{}} [deps]
 * @returns {Promise<CrawlabilityAuditRow>} the saved row
 * @throws {Error} db_not_configured | db_write_failed | db_write_unconfirmed
 */
export async function saveCrawlabilityAudit(audit, deps = {}) {
  const client = resolveClient(deps);
  if (!client) {
    throw new Error(
      "Supabase is not configured — crawlability audit could not be saved. " +
        "This is a refusal, not an empty result."
    );
  }

  const now = new Date();
  const minuteBucket = new Date(now);
  minuteBucket.setSeconds(0, 0);

  const row = {
    domain: String(audit.domain || "").toLowerCase().trim(),
    test_path: audit.testPath || "/",
    audited_at: now.toISOString(),
    fetched_ok: !!audit.fetched_ok,
    robots_txt_status: audit.robots_txt_status || null,
    robots_malformed: !!audit.robots_malformed,
    fetch_error: audit.fetch_error || null,
    llms_txt_present: audit.llms_txt_present ?? null,
    summary: audit.summary || { open: 0, partial: 0, blocked: 0, total: 0 },
    bots: audit.bots || [],
    diff: audit.diff || null,
  };

  // Upsert on the unique constraint (domain, minute-truncated timestamp).
  // If an audit already exists for this domain in the current minute, update it.
  const { data, error } = await client
    .from("crawlability_audits")
    .upsert(row, {
      onConflict: "domain,date_trunc('minute', audited_at)",
      ignoreDuplicates: false,
    })
    .select()
    .single();

  if (error) {
    throw new Error(`Failed to save crawlability audit: ${error.message}`, {
      cause: error,
    });
  }

  if (!data) {
    throw new Error(
      "crawlability audit row was written but could not be confirmed (no data returned). " +
        "This is a refusal, not an empty result."
    );
  }

  return data;
}

/**
 * Fetch the most recent N audit records for a domain, ordered newest-first.
 *
 * @param {string} domain
 * @param {number} [limit=10]
 * @param {{}} [deps]
 * @returns {Promise<CrawlabilityAuditRow[]>}
 */
export async function getAuditHistory(domain, limit = 10, deps = {}) {
  const client = resolveClient(deps);
  if (!client) return [];

  const normalizedDomain = String(domain || "").toLowerCase().trim();

  const { data, error } = await client
    .from("crawlability_audits")
    .select("*")
    .eq("domain", normalizedDomain)
    .order("audited_at", { ascending: false })
    .limit(limit);

  if (error) {
    console.error(`[crawlability-db] failed to fetch audit history for "${normalizedDomain}":`, error);
    return [];
  }

  return data || [];
}

/**
 * Fetch the most recent audit for a domain, or null if none exist.
 *
 * @param {string} domain
 * @param {{}} [deps]
 * @returns {Promise<CrawlabilityAuditRow|null>}
 */
export async function getLatestAudit(domain, deps = {}) {
  const history = await getAuditHistory(domain, 1, deps);
  return history.length > 0 ? history[0] : null;
}
