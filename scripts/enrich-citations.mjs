#!/usr/bin/env node
/**
 * Backfills P3a citation enrichment (content_type/domain_type/citation_class)
 * onto the 3,667 existing `citations` rows the P0.1 backfill created with all
 * three columns NULL (scripts/backfill-analytics.mjs's own header flags this
 * exact gap: "citations.content_type / domain_type / citation_class (P3
 * enrichment)").
 *
 * Usage:
 *   node --env-file=.env.local scripts/enrich-citations.mjs
 *   node --env-file=.env.local scripts/enrich-citations.mjs --dry-run
 *
 * Do NOT run this against the live DB — author only; the orchestrator runs
 * it (per the work order for this package).
 *
 * Pages through `citations` WHERE content_type IS NULL (any of the three
 * columns being null is the same "never enriched" signal — enrichCitations
 * always writes all three together, see src/shared/analytics/citationEnrich.js)
 * and classifies each page via that SAME module the live scan pipeline uses
 * at finalize (src/server/workers/scanWorker.js runFinalizePhase), then updates
 * rows in chunks.
 *
 * IDEMPOTENT: a live run only ever selects rows still missing content_type —
 * already-enriched rows are excluded by the WHERE clause itself, so a
 * partial run (crash, Ctrl-C, a rate-limited LLM batch) simply picks up
 * exactly where it left off on the next invocation. Never touches any other
 * column, and never touches `citations` rows that already have a
 * content_type (re-running is a no-op once every row is enriched).
 *
 * Pagination: LIVE mode always re-queries `.range(0, PAGE_SIZE-1)` against
 * the live "WHERE content_type IS NULL" set (never an incrementing offset —
 * since writes shrink that set as the run progresses, an incrementing offset
 * would silently SKIP rows). DRY RUN never writes, so the set never shrinks;
 * it uses an incrementing offset instead so it can walk the WHOLE backlog
 * without looping on the same first page forever.
 *
 * Competitor context: citations carries no competitor-domain column of its
 * own — see citationEnrich.js's competitorNames -> competitorDomains fuzzy
 * resolution. Each row's `scan_id` is used to look up THAT scan's saved
 * competitor roster (scans.raw_results.competitors[].name — the same
 * user+LLM-discovered list runFinalizePhase attaches to result_brands) so
 * "competitor" domain_type classification works for backfilled rows exactly
 * like it does for live ones. Every citations row (live or backfilled)
 * always carries a non-null scan_id (backfill-analytics.mjs sets it
 * directly; runFinalizePhase resolves savedScanId before building citation
 * rows), so this join is total, not best-effort.
 *
 * Brand domain: citations.brand is resolveBrandKey() output, which IS the
 * brand's domain for every scan created through the normal onboarding flow
 * (src/shared/scoring/brandKey.js — falls back to a normalized display name
 * only when no URL was ever given, a rare legacy edge case). Used directly
 * as `brandDomain` for domain_type classification — no extra lookup needed.
 *
 * Free model ONLY (src/server/llm.js llmJson, via citationEnrich.js) for the
 * small batched LLM fallback — same choke point + cost policy the live
 * pipeline uses. Heuristics resolve the majority of rows with zero LLM cost;
 * enrichCitations batches at most one LLM call per (page x distinct scan_id
 * with unresolved rows) — see citationEnrich.js's own "ONE batched call per
 * invocation" contract.
 *
 * Per-row classification failures never abort the run: enrichCitations is
 * itself fail-loud-soft toward the LLM step (never throws on an LLM hiccup —
 * it falls back to "other" and logs instead). A throw out of enrichCitations
 * here would mean something structural broke; that scan-group's rows are
 * counted as errors and the script moves on to the next group/page rather
 * than aborting the whole backfill. A DB update failure for one row/chunk is
 * likewise caught, logged, and counted, never fatal to the run.
 */

import { supabase } from "../src/server/db.js";
import { enrichCitations } from "../src/shared/analytics/citationEnrich.js";

const DRY_RUN = process.argv.includes("--dry-run");
const PAGE_SIZE = 200;
const UPDATE_CHUNK = 50;

/** Small cardinality today (one row per historical scan) — paginated anyway so this never silently truncates as scan volume grows. */
async function fetchAllScanCompetitors() {
  const map = new Map(); // scan_id -> [competitor names]
  let from = 0;
  for (;;) {
    const { data, error } = await supabase.from("scans").select("id, raw_results").range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(`Failed to read scans (offset ${from}): ${error.message}`);
    if (!data || data.length === 0) break;
    for (const scan of data) {
      const competitors = scan.raw_results?.competitors;
      if (Array.isArray(competitors)) {
        map.set(
          scan.id,
          competitors.map((c) => (typeof c === "string" ? c : c?.name)).filter(Boolean)
        );
      }
    }
    if (data.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }
  return map;
}

/**
 * One page of unenriched citations. LIVE mode always asks for the CURRENT
 * first PAGE_SIZE unenriched rows (offset 0) — see the file header for why.
 * DRY RUN walks forward via `offset` so it can see the whole backlog.
 */
async function fetchUnenrichedPage(offset) {
  const from = DRY_RUN ? offset : 0;
  const { data, error } = await supabase
    .from("citations")
    .select("id, brand, url, domain, scan_id")
    .is("content_type", null)
    .order("created_at", { ascending: true })
    .order("id", { ascending: true })
    .range(from, from + PAGE_SIZE - 1);
  if (error) throw new Error(`Failed to read citations (offset ${from}): ${error.message}`);
  return data || [];
}

async function updateChunk(rows) {
  // PostgREST has no "update many rows to different values in one call" verb
  // — one UPDATE per row, chunked with Promise.allSettled so one row's
  // failure never blocks the rest of the chunk (per-batch error tolerance).
  const settled = await Promise.allSettled(
    rows.map(async (row) => {
      const { error } = await supabase
        .from("citations")
        .update({ content_type: row.content_type, domain_type: row.domain_type, citation_class: row.citation_class })
        .eq("id", row.id);
      if (error) throw new Error(error.message);
    })
  );
  let ok = 0;
  const errors = [];
  settled.forEach((r, i) => {
    if (r.status === "fulfilled") ok++;
    else errors.push({ id: rows[i].id, message: r.reason?.message || String(r.reason) });
  });
  return { ok, errors };
}

async function main() {
  if (!supabase) {
    console.error(
      "Supabase credentials missing (NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY). Aborting."
    );
    process.exit(1);
  }

  console.log(`Citation enrichment backfill — ${DRY_RUN ? "DRY RUN (no writes)" : "LIVE"}\n`);

  const scanCompetitors = await fetchAllScanCompetitors();
  console.log(`Loaded competitor rosters for ${scanCompetitors.size} scan(s).\n`);

  const counters = { pages: 0, scanned: 0, enriched: 0, skipped: 0, errors: 0 };
  let offset = 0;

  for (;;) {
    const page = await fetchUnenrichedPage(offset);
    if (page.length === 0) break;
    counters.pages++;
    counters.scanned += page.length;

    const toClassify = [];
    for (const row of page) {
      if (!row.url || !row.domain) {
        counters.skipped++; // defensive — url/domain are NOT NULL columns, shouldn't happen in practice
        continue;
      }
      toClassify.push(row);
    }

    // Group by scan_id so each distinct competitor roster is resolved once
    // per page, not once per row (enrichCitations already dedupes its own
    // LLM batch by domain+path-shape internally, on top of this).
    const byScan = new Map();
    for (const row of toClassify) {
      const key = row.scan_id || "none";
      if (!byScan.has(key)) byScan.set(key, []);
      byScan.get(key).push(row);
    }

    const enrichedRows = [];
    for (const [scanId, rows] of byScan) {
      const brandDomain = rows[0].brand || "";
      const competitorNames = scanCompetitors.get(scanId) || [];
      try {
        const out = await enrichCitations(
          rows.map((r) => ({ url: r.url, domain: r.domain, title: "" })), // no title column on citations — see header
          { brandDomain, competitorNames }
        );
        out.forEach((enriched, i) => enrichedRows.push({ id: rows[i].id, ...enriched }));
      } catch (err) {
        console.error(`  [error] scan ${scanId}: ${err.message}`);
        counters.errors += rows.length;
      }
    }

    if (DRY_RUN) {
      counters.enriched += enrichedRows.length;
    } else if (enrichedRows.length > 0) {
      for (let i = 0; i < enrichedRows.length; i += UPDATE_CHUNK) {
        const slice = enrichedRows.slice(i, i + UPDATE_CHUNK);
        const { ok, errors } = await updateChunk(slice);
        counters.enriched += ok;
        counters.errors += errors.length;
        errors.forEach((e) => console.error(`  [error] citation ${e.id}: ${e.message}`));
      }
    }

    console.log(
      `  page ${counters.pages}: ${page.length} scanned, ${enrichedRows.length} classified` +
        (DRY_RUN ? " (dry run — not written)" : "")
    );

    offset += page.length;
    if (page.length < PAGE_SIZE) break; // last page
  }

  const line = "=".repeat(60);
  console.log(`\n${line}`);
  console.log(`Summary (${DRY_RUN ? "dry run — nothing written" : "live"})`);
  console.log(line);
  console.log(`Pages processed: ${counters.pages}`);
  console.log(`Rows scanned:    ${counters.scanned}`);
  console.log(`Rows enriched:   ${counters.enriched}`);
  console.log(`Rows skipped:    ${counters.skipped}`);
  console.log(`Rows errored:    ${counters.errors}`);

  if (counters.errors > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
