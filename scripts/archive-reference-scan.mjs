#!/usr/bin/env node
/**
 * Archive a completed scan as part of the "before" corpus (R0.4.1).
 *
 * The rebuild changes scoring. Without a frozen record of what the current
 * pipeline produces, "the numbers got better" is an opinion — and the whole
 * point of this rebuild is that a number nobody can check is not a measurement.
 * This script freezes three things per brand, which together make a later scan
 * comparable rather than merely different:
 *
 *   1. the prompt set (by `prompt_set_id`), so a score change cannot be
 *      explained away by the questions having changed;
 *   2. the raw per-prompt results exactly as persisted, not a summary;
 *   3. the headline metrics, so a regression is visible without re-deriving.
 *
 * Reads only. It never starts a scan: a corpus captured from scans run under
 * observation is not a baseline of production behaviour.
 *
 * Usage:
 *   node --env-file=.env.local scripts/archive-reference-scan.mjs <brand-key> [--scan-id <id>]
 *   node --env-file=.env.local scripts/archive-reference-scan.mjs --list
 *
 * Requires live Supabase credentials. See test_reports/baseline-2026-08/README.md.
 */
import fs from "node:fs";
import path from "node:path";

const OUT_DIR = path.resolve(process.cwd(), "test_reports/baseline-2026-08");

function die(msg) {
  console.error(`error: ${msg}`);
  process.exit(1);
}

async function main() {
  const args = process.argv.slice(2);
  const wantsList = args.includes("--list");
  const scanIdFlag = args.indexOf("--scan-id");
  const scanId = scanIdFlag !== -1 ? args[scanIdFlag + 1] : null;
  const brand = args.find((a) => !a.startsWith("--") && a !== scanId);

  if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY) {
    die(
      "Supabase is not configured. This script reads production scans; it cannot " +
        "fabricate a baseline. Set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY."
    );
  }

  const { listRecentScans, getScansByDomain } = await import("../src/lib/db.js");
  const { getPromptResultsForScan } = await import("../src/lib/db/analytics.js");

  if (wantsList) {
    const recent = await listRecentScans(40);
    for (const s of recent) {
      console.log(`${s.id}  ${s.scanned_at}  ${s.brand}  ${s.visibility_pct ?? "—"}%`);
    }
    return;
  }

  if (!brand) die("usage: archive-reference-scan.mjs <brand-key> [--scan-id <id>] | --list");

  const scans = await getScansByDomain(brand);
  if (!scans.length) die(`no scans found for "${brand}". Run --list to see what exists.`);

  const scan = scanId ? scans.find((s) => s.id === scanId) : scans[0];
  if (!scan) die(`scan ${scanId} not found for "${brand}".`);

  const raw = scan.raw_results || {};
  const results = raw.results || [];
  if (!results.length) {
    die(
      `scan ${scan.id} has no per-prompt results. Archiving its summary alone would ` +
        `produce a baseline that cannot be compared prompt-by-prompt — refusing.`
    );
  }

  // The normalized per-prompt rows carry per-engine detail raw_results does not.
  //
  // Keyed on scan.id, NOT scan.job_id: the `scans` table has no job_id column,
  // so the previous `if (scan.job_id)` guard was permanently false and this
  // array was always empty — silently, and about to be frozen into a corpus
  // whose own note says do not regenerate. An empty array here must mean the
  // scan genuinely had no rows, never that the lookup was skipped, so a read
  // failure now stops the archive instead of quietly shrinking it.
  let promptRows = [];
  try {
    promptRows = await getPromptResultsForScan(scan.id);
    if (!promptRows.length) {
      console.warn(
        `[archive] no normalized prompt_results for scan ${scan.id}. Archiving raw ` +
          `results only — recorded as a measured zero, not a skipped read.`
      );
    }
  } catch (err) {
    die(
      `normalized prompt_results could not be read for scan ${scan.id}: ${err.message}. ` +
        `Refusing to freeze a baseline whose per-engine detail is missing for an unknown reason.`
    );
  }

  const record = {
    archived_at: new Date().toISOString(),
    archived_by: "scripts/archive-reference-scan.mjs",
    note:
      "BEFORE corpus for the R0-R6 rebuild. Frozen as-is. Do not regenerate: a " +
      "baseline that moves is not a baseline.",
    brand: scan.brand,
    brand_key: brand,
    url: scan.url,
    industry: scan.industry,
    scan_id: scan.id,
    scanned_at: scan.scanned_at,
    scoring_version: scan.scoring_version ?? raw.scoring_version ?? null,
    prompt_set_id: raw.prompt_set_id ?? null,
    prompt_set_hash: raw.prompt_set_hash ?? null,
    headline: {
      visibility_pct: scan.visibility_pct ?? null,
      share_of_ai_pct: raw.share_of_ai_pct ?? null,
      aio_coverage_pct: raw.aio_coverage_pct ?? null,
      mention_rate_pct: raw.mention_rate_pct ?? null,
      share_of_voice_pct: raw.share_of_voice_pct ?? null,
      prompts_tracked: scan.prompts_tracked ?? null,
      prompts_mentioned: scan.prompts_mentioned ?? null,
      engines_counted: raw.engines_counted ?? null,
      insufficient_sample: raw.insufficient_sample ?? null,
      data_source_issue: raw.data_source_issue ?? null,
      // R0.3.3/R0.3.4 provenance. null on scans taken before those landed —
      // which is exactly what a "before" corpus should show.
      roster_source: raw.roster_source ?? null,
      prompt_source: raw.prompt_source ?? null,
    },
    competitors: raw.competitors ?? [],
    engines: raw.engines ?? null,
    results,
    prompt_results: promptRows,
  };

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const file = path.join(OUT_DIR, `${brand.replace(/[^a-z0-9.-]/gi, "_")}.json`);
  if (fs.existsSync(file)) {
    die(`${path.relative(process.cwd(), file)} already exists. A baseline is frozen — delete it deliberately if you really mean to replace it.`);
  }
  fs.writeFileSync(file, JSON.stringify(record, null, 2) + "\n");

  console.log(`archived ${results.length} prompt results for "${scan.brand}"`);
  console.log(`  scan_id       ${scan.id}`);
  console.log(`  prompt_set_id ${record.prompt_set_id ?? "(none recorded)"}`);
  console.log(`  -> ${path.relative(process.cwd(), file)}`);
}

main().catch((err) => {
  console.error(err.stack || err);
  process.exit(1);
});
