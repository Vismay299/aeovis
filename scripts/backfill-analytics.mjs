#!/usr/bin/env node
/**
 * Backfill historical `scans` rows into the P0.1 normalized analytics schema
 * (migration 005): prompt_results, citations, brand_metrics_daily.
 *
 * Usage:
 *   node --env-file=.env.local scripts/backfill-analytics.mjs
 *   node --env-file=.env.local scripts/backfill-analytics.mjs --dry-run
 *
 * Reads every `scans` row, explodes `raw_results.results` (the per-probe
 * array the live pipeline already produces) into `prompt_results` + one
 * `citations` row per ordered reference, and materializes `brand_metrics_daily`
 * from the scan's existing summary metrics. Never touches `scans` itself.
 *
 * IDEMPOTENT: for every scan, prompt_results/citations are wiped by scan_id
 * and reinserted, and brand_metrics_daily rows are upserted on their natural
 * (brand, date, engine) primary key — safe to re-run any number of times.
 *
 * Two pipeline vintages exist in raw_results.results and are both handled:
 *   - v9 multi-engine (src/lib/scoring/enginePipeline.js): rows carry
 *     `engine`, `answer_present`, `text`, `citations`, `references`.
 *   - v8.1 AIO-only (src/lib/scoring/aioPipeline.js): rows never set `engine`
 *     and use `aio_present`, `aio_text`, `aio_citations`, `aio_references`
 *     instead. This is the exact fallback scanWorker.js itself already uses
 *     for `normalizedForCompetitors` — mirrored here, not invented.
 *
 * KNOWN CONFLICT (flagged, not silently resolved): the work order for this
 * package says "leave job_id null for historical" rows, but migration 005
 * (reproducing plan.md §4 P0.1 exactly) declares `prompt_results.job_id uuid
 * NOT NULL`. Leaving it null is not executable against that schema — every
 * insert would fail its NOT NULL check. Resolution used here: `insertScan`
 * has exactly one call site (src/lib/workers/scanWorker.js, inside
 * `startScanJob(jobId, ...)`), and every successful scan is immediately
 * followed by `updateScanJob(jobId, { result_id: savedScanId, ... })` — so a
 * real `scan_jobs` row with `result_id = scans.id` exists for essentially
 * every historical scan. We look that job up and use ITS id as the
 * historical job_id (real data, not fabricated). A scan with no discoverable
 * job (row deleted, or the db.js D4 memory-poison bug dropped the write)
 * skips prompt_results/citations for that scan only, is counted separately,
 * and is reported at the end — brand_metrics_daily is unaffected since it
 * has no job_id column. See the final backfill report for how many scans (if
 * any) hit this path.
 *
 * NOT populated by this script (no source data at scan time — flagged for P1):
 *   - prompt_results.position, prompt_results.sentiment (P1.1 modules)
 *   - prompt_results.prompt_id (no reliable text→brand_prompts.id join is
 *     specified for this package; left null rather than guessing)
 *   - result_brands (symmetric per-rival judging doesn't exist until P1.2 —
 *     raw_results has no per-rival position/sentiment to explode)
 *   - citations.content_type / domain_type / citation_class (P3 enrichment)
 *   - brand_metrics_daily.sov_pct / sentiment_avg / position_avg (same P1.1/
 *     P1.2 gap as above)
 */

import crypto from "crypto";
import { supabase } from "../src/lib/db.js";
import { resolveBrandKey } from "../src/lib/scoring/brandKey.js";
import { getBrandAliases } from "../src/lib/scoring/aliases.js";
import { detectMention } from "../src/lib/scoring/judge.js";
import { extractBrandDomain } from "../src/lib/scoring/citations.js";
import { toDateOnly, buildMetricsRows } from "../src/lib/analytics/rollup.js";

const DRY_RUN = process.argv.includes("--dry-run");
const PAGE_SIZE = 200;
const INSERT_CHUNK = 500;

function domainMatches(candidateDomain, target) {
  if (!candidateDomain || !target) return false;
  return candidateDomain === target || candidateDomain.endsWith("." + target);
}

/**
 * Normalizes one raw_results.results[] row across both pipeline vintages.
 * See the file header for the v9 vs v8.1 field-name divergence.
 */
function normalizeResultRow(r) {
  return {
    engine: r.engine || "aio",
    answered: r.answer_present ?? r.aio_present ?? false,
    text: r.text ?? r.aio_text ?? "",
    references: r.references ?? r.aio_references ?? [],
    prompt: r.prompt || "",
    is_branded_query: !!r.is_branded_query,
    intent_tier: r.intent_tier || null,
    topic: r.topic || null,
    source: r.source || null,
    brand_cited: !!r.brand_cited,
    error: r.error || null,
    organic: r.organic,
    brand_organic_position: r.brand_organic_position ?? null,
    competitors_found_in_text: r.competitors_found_in_text || [],
    competitors_cited: r.competitors_cited || [],
  };
}

/** Paginated read of every row in `table` via ordered range() pages. */
async function fetchAll(table, columns, orderCols) {
  const rows = [];
  let from = 0;
  for (;;) {
    let query = supabase.from(table).select(columns);
    for (const [col, opts] of orderCols) query = query.order(col, opts);
    const { data, error } = await query.range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(`Failed to read ${table} (offset ${from}): ${error.message}`);
    if (!data || data.length === 0) break;
    rows.push(...data);
    if (data.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }
  return rows;
}

/**
 * Builds a Map<scans.id, scan_jobs.id> from every scan_jobs row that
 * completed with a result_id — the real historical link between a scan and
 * the job that produced it (see the job_id conflict note in the file header).
 * When more than one job improbably points at the same scan, the most
 * recently created job wins (rows are fetched oldest-first, later entries
 * overwrite earlier ones in the Map).
 */
async function buildScanToJobMap() {
  const jobs = await fetchAll(
    "scan_jobs",
    "id, result_id, created_at",
    [["created_at", { ascending: true }], ["id", { ascending: true }]]
  );
  const map = new Map();
  for (const job of jobs) {
    if (job.result_id) map.set(job.result_id, job.id);
  }
  return map;
}

async function fetchAllScans() {
  return fetchAll(
    "scans",
    "id, brand, url, scanned_at, created_at, raw_results",
    [["scanned_at", { ascending: true }], ["id", { ascending: true }]]
  );
}

// When `onConflict` is given, upsert on that key so the backfill honors the same
// idempotency contract as the P0.2 chunk worker (which upserts on
// job_id,engine,query) — a duplicate key never aborts the batch (reviewer D3).
async function chunkedInsert(table, rows, onConflict) {
  for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
    const slice = rows.slice(i, i + INSERT_CHUNK);
    const from = supabase.from(table);
    const { error } = onConflict
      ? await from.upsert(slice, { onConflict })
      : await from.insert(slice);
    if (error) throw new Error(`Insert into ${table} failed (rows ${i}-${i + slice.length}): ${error.message}`);
  }
}

async function deleteForScan(table, scanId) {
  const { error } = await supabase.from(table).delete().eq("scan_id", scanId);
  if (error) throw new Error(`Delete from ${table} for scan_id=${scanId} failed: ${error.message}`);
}

/**
 * Adapts one historical `scans` row to the shared buildMetricsRows contract
 * (src/lib/analytics/rollup.js — the single source of truth for
 * brand_metrics_daily math, also used by the live pipeline's
 * runFinalizePhase). Two raw_results shapes exist across scan history (see
 * file header):
 *   - v9 multi-engine (`rawResults.engines`): one row per engine that
 *     actually reported, plus a blended 'all' row using the real
 *     cross-engine headline (computeHeadline in enginePipeline.js) rather
 *     than re-deriving a blend ourselves.
 *   - v8.1 single-engine AIO-only (`rawResults.summary_stats`): 'aio' and
 *     'all' rows are identical since AIO is the only engine that ran.
 *   - Neither shape present (malformed row, or predates both pipelines):
 *     contributes no brand_metrics_daily rows — brand_metrics_daily has no
 *     job_id column, so this is independent of the job-link gating above.
 */
function buildBackfillMetricsRows(scan, rawResults, brandKey, dateOnly, promptResultRows) {
  const promptSetId = rawResults.prompt_set_id ?? null;

  if (rawResults.engines && typeof rawResults.engines === "object" && Object.keys(rawResults.engines).length > 0) {
    return buildMetricsRows({
      isMultiEngine: true,
      brandKey,
      dateOnly,
      scanId: scan.id,
      promptSetId,
      engineSummaries: rawResults.engines,
      headline: { visibility_index_pct: rawResults.visibility_index_pct ?? null },
      promptResultRows,
    });
  }

  if (rawResults.summary_stats && typeof rawResults.summary_stats === "object") {
    return buildMetricsRows({
      isMultiEngine: false,
      brandKey,
      dateOnly,
      scanId: scan.id,
      promptSetId,
      summary: rawResults.summary_stats,
      promptResultRows,
    });
  }

  return [];
}

async function processScan(scan, scanToJobMap, counters) {
  const rawResults = scan.raw_results || {};
  const resultRows = Array.isArray(rawResults.results) ? rawResults.results : [];

  const brandKey = resolveBrandKey(scan.brand, scan.url);
  if (!brandKey) {
    throw new Error(`Could not resolve a brand key (brand="${scan.brand}", url="${scan.url}")`);
  }

  const scannedAt = scan.scanned_at || scan.created_at;
  const dateOnly = toDateOnly(scannedAt);
  if (!dateOnly) {
    throw new Error("No usable scanned_at/created_at timestamp");
  }

  // job_id is resolved once, up front: it gates BOTH the per-prompt writes and
  // the destructive delete below (never wipe a scan's prior rows when we have no
  // job link to rewrite them from — reviewer D5).
  const jobId = resultRows.length > 0 ? (scanToJobMap.get(scan.id) || null) : null;

  // --- prompt_results + citations ------------------------------------------
  const promptResultRows = [];
  const citationRows = [];

  if (resultRows.length === 0) {
    counters.scansWithNoResults++;
  } else if (!jobId) {
    // prompt_results.job_id is NOT NULL — see the file header conflict note.
    counters.scansMissingJob++;
    console.warn(
      `  [warn] scan ${scan.id}: no scan_jobs row with result_id=${scan.id} — ` +
        `skipping ${resultRows.length} prompt_results/citations rows (brand_metrics_daily still runs)`
    );
  } else {
    const brandAliases = getBrandAliases(scan.brand, scan.url);
    const brandDomain = extractBrandDomain(scan.url);
    // Dedupe on the (job_id, engine, query) upsert key: a duplicate pair within
    // one scan's results would make the upsert "affect a row a second time" and
    // abort the batch (reviewer D3). First occurrence wins.
    const seenPairs = new Set();

    for (const rawRow of resultRows) {
      const r = normalizeResultRow(rawRow);
      if (!r.prompt) continue; // query is NOT NULL — nothing to key this row on

      const pairKey = `${r.engine} ${r.prompt.toLowerCase().trim()}`;
      if (seenPairs.has(pairKey)) continue;
      seenPairs.add(pairKey);

      const id = crypto.randomUUID();
      const mentioned = r.text ? detectMention(r.text, brandAliases) : false;

      promptResultRows.push({
          id,
          job_id: jobId,
          scan_id: scan.id,
          brand: brandKey,
          prompt_id: null, // no text->brand_prompts.id join specified for this package (see header)
          query: r.prompt,
          engine: r.engine,
          answered: r.answered,
          mentioned, // recomputed deterministically via judge.detectMention (cheap, same fn the pipeline uses)
          brand_cited: r.brand_cited, // carried from the stored flag (recompute not requested for this field)
          position: null, // P1.1
          sentiment: null, // P1.1
          intent: r.intent_tier,
          is_branded_query: r.is_branded_query,
          answer_text: r.text || null,
          raw: {
            organic: r.organic ?? null,
            brand_organic_position: r.brand_organic_position,
            error: r.error,
            topic: r.topic,
            source: r.source,
            competitors_found_in_text: r.competitors_found_in_text,
            competitors_cited: r.competitors_cited,
          },
          created_at: scannedAt,
        });

        r.references.forEach((ref, idx) => {
          const url = ref?.href;
          if (!url) return;
          const domain = ref.domain || extractBrandDomain(url);
          if (!domain) return;
          citationRows.push({
            result_id: id,
            job_id: jobId,
            scan_id: scan.id,
            brand: brandKey,
            engine: r.engine,
            url,
            domain,
            rank: idx + 1, // 1-based, matching brand_organic_position's convention
            is_self: domainMatches(domain, brandDomain),
            created_at: scannedAt,
          });
        });
      }
    }

  // --- brand_metrics_daily ---------------------------------------------------
  const metricsRows = buildBackfillMetricsRows(scan, rawResults, brandKey, dateOnly, promptResultRows);
  if (metricsRows.length === 0) counters.scansWithNoSummary++;

  counters.scansProcessed++;
  counters.promptResultRows += promptResultRows.length;
  counters.citationRows += citationRows.length;
  counters.metricsRows += metricsRows.length;

  if (DRY_RUN) return;

  // Per-prompt rows: only touch them when we have a job link to rewrite from —
  // otherwise a re-run would delete a prior good backfill and insert nothing
  // (reviewer D5). Wipe-then-upsert is idempotent, and the upsert key matches
  // the P0.2 chunk worker's (job_id,engine,query) contract (reviewer D3), so a
  // crash between delete and insert just leaves this scan short until the next
  // re-run cleans up and redoes it.
  if (jobId) {
    await deleteForScan("citations", scan.id);
    await deleteForScan("prompt_results", scan.id);
    await chunkedInsert("prompt_results", promptResultRows, "job_id,engine,query");
    await chunkedInsert("citations", citationRows);
  }

  for (const row of metricsRows) {
    const { error } = await supabase.from("brand_metrics_daily").upsert(row, { onConflict: "brand,date,engine" });
    if (error) {
      throw new Error(`Upsert brand_metrics_daily (${row.brand}/${row.date}/${row.engine}) failed: ${error.message}`);
    }
  }
}

async function main() {
  if (!supabase) {
    console.error(
      "Supabase credentials missing (NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY). Aborting."
    );
    process.exit(1);
  }

  console.log(`Backfill analytics — ${DRY_RUN ? "DRY RUN (no writes)" : "LIVE"}\n`);

  const [scans, scanToJobMap] = await Promise.all([fetchAllScans(), buildScanToJobMap()]);
  console.log(`Found ${scans.length} scans, ${scanToJobMap.size} scan_jobs with a result_id.\n`);

  const counters = {
    scansProcessed: 0,
    scansWithNoResults: 0,
    scansMissingJob: 0,
    scansWithNoSummary: 0,
    promptResultRows: 0,
    citationRows: 0,
    metricsRows: 0,
    errors: [],
  };

  for (const scan of scans) {
    try {
      await processScan(scan, scanToJobMap, counters);
    } catch (err) {
      counters.errors.push({ scanId: scan.id, brand: scan.brand, message: err.message });
      console.error(`  [error] scan ${scan.id} (${scan.brand}): ${err.message}`);
    }
  }

  const line = "=".repeat(60);
  console.log(`\n${line}`);
  console.log(`Summary (${DRY_RUN ? "dry run — nothing written" : "live"})`);
  console.log(line);
  console.log(`Scans found:              ${scans.length}`);
  console.log(`Scans processed OK:       ${counters.scansProcessed}`);
  console.log(`  - with 0 raw results:   ${counters.scansWithNoResults}`);
  console.log(`  - missing job_id:       ${counters.scansMissingJob} (prompt_results/citations skipped)`);
  console.log(`  - no summary metrics:   ${counters.scansWithNoSummary} (brand_metrics_daily skipped)`);
  console.log(`prompt_results rows:      ${counters.promptResultRows}`);
  console.log(`citations rows:           ${counters.citationRows}`);
  console.log(`brand_metrics_daily rows: ${counters.metricsRows}`);
  console.log(`Errors:                   ${counters.errors.length}`);
  if (counters.errors.length > 0) {
    console.log("\nErrored scans:");
    for (const e of counters.errors) {
      console.log(`  - ${e.scanId} (${e.brand}): ${e.message}`);
    }
  }

  if (counters.errors.length > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
