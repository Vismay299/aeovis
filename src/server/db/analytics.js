import crypto from "crypto";
import { supabase } from "../db.js";
import { pickScanIds } from "../../shared/analytics/promptMetrics.js";

/**
 * DB access layer for the analytics platform (migration 005 —
 * supabase/migrations/005_analytics_platform.sql): prompt_results,
 * result_brands, citations, brand_metrics_daily, scan_schedules.
 *
 * DB-authoritative + fail-loud everywhere (P0.0 pattern — mirrors db.js's
 * scan_jobs and content.js's content_jobs): when Supabase is configured it
 * is the ONLY source of truth for every function below. A DB error THROWS
 * instead of silently degrading to the in-memory maps — one transient DB
 * failure must surface as a caller-visible error, never a quiet drop into a
 * per-instance memory map that a different serverless instance (or the next
 * poll/cron tick) can't see. The in-memory maps exist ONLY for the fully
 * -Supabase-less dev/test path (hasDb === false, decided once per call).
 *
 * `deps.client` is test-only injection (defaults to the module-level
 * `supabase` from db.js via resolveClient below), so every real call site —
 * which never passes `deps` — behaves exactly as `hasDb = !!supabase`.
 *
 * All `brand` arguments are already resolveBrandKey() output (see
 * scoring/brandKey.js) — every table in migration 005 stores that key, never
 * the typed display name, so this module never re-normalizes it; brand is
 * stored and queried as an opaque exact-match string throughout.
 */

function resolveClient(deps) {
  return deps && Object.prototype.hasOwnProperty.call(deps, "client") ? deps.client : supabase;
}

// Global memory stores (Next.js hot-reload safe), dev/test path only.
// prompt_results / citations / result_brands are keyed by their synthetic
// uuid `id` (mirrors memoryJobs / memoryContentItems); brand_metrics_daily
// and scan_schedules are keyed by their real DB conflict target so an upsert
// in memory mode dedupes exactly the way a live `ON CONFLICT` would.
global.memoryPromptResults = global.memoryPromptResults || new Map();
global.memoryCitations = global.memoryCitations || new Map();
global.memoryResultBrands = global.memoryResultBrands || new Map();
global.memoryBrandMetrics = global.memoryBrandMetrics || new Map();
global.memoryScanSchedules = global.memoryScanSchedules || new Map();

// ---------------------------------------------------------------------------
// prompt_results
// ---------------------------------------------------------------------------

function promptResultConflictKey(row) {
  return `${row.job_id}|${row.engine}|${row.query}`;
}

/**
 * Bulk upsert into prompt_results on (job_id, engine, query) — the same
 * UNIQUE constraint the migration defines for chunk idempotency (D5): a
 * re-run of a chunk (poll rescue or cron resume, P0.2) upserts the same rows
 * instead of duplicating them.
 *
 * Rows may omit `id` — the DB (or the memory map, in dev) assigns one — but
 * this always returns the full rows WITH ids, because the chunk worker
 * writes citations/result_brands immediately after this call and those rows
 * reference prompt_results.id.
 */
export async function upsertPromptResults(rows, deps = {}) {
  const client = resolveClient(deps);
  const hasDb = !!client;

  if (!rows || rows.length === 0) return [];

  if (!hasDb) {
    // Index existing rows by conflict key once so in-batch duplicates (not
    // expected in practice, but stay correct) resolve the same way a real
    // upsert would: last write in the batch wins.
    const byKey = new Map();
    for (const stored of global.memoryPromptResults.values()) {
      byKey.set(promptResultConflictKey(stored), stored);
    }
    const out = [];
    for (const row of rows) {
      const key = promptResultConflictKey(row);
      const existing = byKey.get(key);
      if (existing) {
        Object.assign(existing, row);
        out.push(existing);
      } else {
        const record = { created_at: new Date().toISOString(), ...row, id: row.id || crypto.randomUUID() };
        global.memoryPromptResults.set(record.id, record);
        byKey.set(key, record);
        out.push(record);
      }
    }
    return out;
  }

  const { data, error } = await client
    .from("prompt_results")
    .upsert(rows, { onConflict: "job_id,engine,query" })
    .select();
  if (error) throw error;
  return data || [];
}

/** All prompt_results rows for a job — reconstructs the results array at finalize. */
export async function getPromptResultsForJob(jobId, deps = {}) {
  const client = resolveClient(deps);
  const hasDb = !!client;

  if (!hasDb) {
    return Array.from(global.memoryPromptResults.values())
      .filter((r) => r.job_id === jobId)
      .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  }

  const { data, error } = await client
    .from("prompt_results")
    .select("*")
    .eq("job_id", jobId)
    .order("created_at", { ascending: true });
  if (error) throw error;
  return data || [];
}

/**
 * All prompt_results rows for a finished SCAN.
 *
 * The archive script needs this because `scans` has no job_id column at all —
 * the link runs the other way, prompt_results carrying scan_id once
 * stampScanIdForJob has run at finalize. Looking the rows up by a column that
 * does not exist returned undefined, which a truthiness guard read as "no job"
 * and skipped silently, writing an empty array that looked like a measured zero.
 */
export async function getPromptResultsForScan(scanId, deps = {}) {
  const client = resolveClient(deps);

  if (!client) {
    return Array.from(global.memoryPromptResults.values())
      .filter((r) => r.scan_id === scanId)
      .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  }

  const { data, error } = await client
    .from("prompt_results")
    .select("*")
    .eq("scan_id", scanId)
    .order("created_at", { ascending: true });
  if (error) throw error;
  return data || [];
}

/**
 * Set of `"engine|query"` pairs already persisted for a job, from a
 * lightweight column-limited select. The chunk worker (P0.2) diffs its
 * (engine, query) worklist against this set on resume so it skips pairs a
 * previous chunk already finished instead of re-probing them.
 */
export async function getCompletedPairsForJob(jobId, deps = {}) {
  const client = resolveClient(deps);
  const hasDb = !!client;

  if (!hasDb) {
    const pairs = new Set();
    for (const row of global.memoryPromptResults.values()) {
      if (row.job_id === jobId) pairs.add(`${row.engine}|${row.query}`);
    }
    return pairs;
  }

  const { data, error } = await client
    .from("prompt_results")
    .select("job_id, engine, query")
    .eq("job_id", jobId);
  if (error) throw error;
  return new Set((data || []).map((r) => `${r.engine}|${r.query}`));
}

/**
 * Distinct prompt_results scan_ids for a brand, most-recent-first by
 * created_at — same "column-limited select, dedupe client-side" shape as
 * getCompletedPairsForJob above. A row with scan_id === null (a chunk still
 * mid-flight, not yet finalize-stamped — see stampScanIdForJob) is never "a
 * scan" from this brand's point of view and is excluded, so getPromptMetrics
 * below only ever picks finalized scans as "latest"/"previous".
 */
async function listBrandScanIds(brand, deps) {
  const client = resolveClient(deps);
  const hasDb = !!client;

  if (!hasDb) {
    const rows = Array.from(global.memoryPromptResults.values())
      .filter((r) => r.brand === brand && r.scan_id != null)
      .sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
    const seen = new Set();
    const ids = [];
    for (const r of rows) {
      if (!seen.has(r.scan_id)) {
        seen.add(r.scan_id);
        ids.push(r.scan_id);
      }
    }
    return ids;
  }

  const { data, error } = await client
    .from("prompt_results")
    .select("scan_id, created_at")
    .eq("brand", brand)
    .order("created_at", { ascending: false });
  if (error) throw error;

  const seen = new Set();
  const ids = [];
  for (const row of data || []) {
    if (row.scan_id != null && !seen.has(row.scan_id)) {
      seen.add(row.scan_id);
      ids.push(row.scan_id);
    }
  }
  return ids;
}

/**
 * Per-prompt metrics source rows for a brand's LATEST scan (default) or a
 * caller-specified `scanId`, plus the same brand's `range`-th-previous scan
 * (default range=1: the scan immediately before) — P2a:
 * GET /api/brands/[brand]/prompts/metrics. Returns raw prompt_results rows
 * for BOTH scans (the grouping/delta math happens in
 * src/shared/analytics/promptMetrics.js's groupPromptRows, kept pure and
 * independently unit-testable — see promptMetrics.test.mjs) plus the two
 * resolved scan ids, via the pure pickScanIds helper from that same module.
 *
 * A `scanId` that doesn't belong to this brand at all (wrong brand, typo, a
 * scan that belongs to someone else) resolves to itself with
 * `prevScanId: null` and an empty `rows` (nothing matches the
 * brand+scan_id filter) — an honest empty result, not a thrown error. A
 * brand with NO scans yet returns `{ scanId: null, prevScanId: null, rows: [] }`
 * without ever querying prompt_results a second time.
 */
export async function getPromptMetrics(brand, { scanId: requestedScanId, range = 1 } = {}, deps = {}) {
  const scanIdsDesc = await listBrandScanIds(brand, deps);
  const { scanId, prevScanId } = pickScanIds(scanIdsDesc, { scanId: requestedScanId, range });

  if (!scanId) {
    return { scanId: null, prevScanId: null, rows: [] };
  }

  const client = resolveClient(deps);
  const hasDb = !!client;
  const wantedScanIds = prevScanId ? [scanId, prevScanId] : [scanId];

  if (!hasDb) {
    const rows = Array.from(global.memoryPromptResults.values()).filter(
      (r) => r.brand === brand && wantedScanIds.includes(r.scan_id)
    );
    return { scanId, prevScanId, rows };
  }

  const { data, error } = await client
    .from("prompt_results")
    .select("*")
    .eq("brand", brand)
    .in("scan_id", wantedScanIds);
  if (error) throw error;

  return { scanId, prevScanId, rows: data || [] };
}

// ---------------------------------------------------------------------------
// citations
// ---------------------------------------------------------------------------

/** Bulk insert into citations. Empty-safe (no-op on []). */
export async function insertCitations(rows, deps = {}) {
  const client = resolveClient(deps);
  const hasDb = !!client;

  if (!rows || rows.length === 0) return [];

  if (!hasDb) {
    const out = [];
    for (const row of rows) {
      const record = { created_at: new Date().toISOString(), ...row, id: row.id || crypto.randomUUID() };
      global.memoryCitations.set(record.id, record);
      out.push(record);
    }
    return out;
  }

  const { data, error } = await client.from("citations").insert(rows).select();
  if (error) throw error;
  return data || [];
}

/**
 * Deletes every citations row for a job. citations carries no unique
 * constraint of its own (D-class gap fixed at the call-site instead — see
 * runFinalizePhase, P0.2 FIX 1): citations are now materialized fresh from
 * prompt_results.raw.references at finalize time, once, from scratch, on
 * every finalize attempt — including a crash-recovery re-finalize. Calling
 * this immediately before rematerializing is what makes that idempotent: a
 * plain re-insert without it would duplicate every row on a second pass.
 * Empty-safe (no-op, returns 0, if the job has no citations yet).
 */
export async function deleteCitationsForJob(jobId, deps = {}) {
  const client = resolveClient(deps);
  const hasDb = !!client;

  if (!hasDb) {
    let deleted = 0;
    for (const [id, row] of global.memoryCitations.entries()) {
      if (row.job_id === jobId) {
        global.memoryCitations.delete(id);
        deleted += 1;
      }
    }
    return deleted;
  }

  const { data, error } = await client.from("citations").delete().eq("job_id", jobId).select();
  if (error) throw error;
  return (data || []).length;
}

const DEFAULT_CITATIONS_LIMIT = 5000;

/**
 * dateOnly ("YYYY-MM-DD") -> ISO instant at the START of the FOLLOWING day
 * (UTC). citations.created_at is a timestamptz (unlike brand_metrics_daily's
 * plain `date` column, which getBrandMetricsSeries compares directly), so an
 * inclusive "to" bound needs this: `.lt(created_at, thisValue)` includes
 * every row created anywhere during `dateOnly` itself.
 */
function endOfDayIso(dateOnly) {
  const d = new Date(`${dateOnly}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString();
}

/**
 * citations rows for a brand (P3a — src-of-truth read for
 * GET /api/brands/[brand]/citations, and half of the gaps endpoint's join).
 * `from`/`to` are optional inclusive YYYY-MM-DD bounds on `created_at` (see
 * endOfDayIso for why `to` needs day-rollover). Ordered most-recent-first,
 * capped defensively at `limit` (per-brand citation volume today is in the
 * low hundreds — the P0.1 backfill's 3,667 rows are spread across every
 * brand — so 5000 is headroom, not a real pagination boundary yet).
 */
export async function getCitationsForBrand(brand, { from, to, limit = DEFAULT_CITATIONS_LIMIT } = {}, deps = {}) {
  const client = resolveClient(deps);
  const hasDb = !!client;

  if (!hasDb) {
    let rows = Array.from(global.memoryCitations.values()).filter((r) => r.brand === brand);
    if (from) rows = rows.filter((r) => (r.created_at || "") >= from);
    if (to) {
      const bound = endOfDayIso(to);
      rows = rows.filter((r) => (r.created_at || "") < bound);
    }
    rows.sort((a, b) => (b.created_at || "").localeCompare(a.created_at || ""));
    return rows.slice(0, limit);
  }

  let query = client.from("citations").select("*").eq("brand", brand);
  if (from) query = query.gte("created_at", from);
  if (to) query = query.lt("created_at", endOfDayIso(to));
  const { data, error } = await query.order("created_at", { ascending: false }).limit(limit);
  if (error) throw error;
  return data || [];
}

// ---------------------------------------------------------------------------
// result_brands
// ---------------------------------------------------------------------------

/**
 * Bulk insert into result_brands (symmetric per-answer mentions: self AND
 * every tracked rival). Not written by anything until P1.2 scoring lands;
 * empty-safe now.
 */
export async function insertResultBrands(rows, deps = {}) {
  const client = resolveClient(deps);
  const hasDb = !!client;

  if (!rows || rows.length === 0) return [];

  if (!hasDb) {
    const out = [];
    for (const row of rows) {
      const record = { ...row, id: row.id || crypto.randomUUID() };
      global.memoryResultBrands.set(record.id, record);
      out.push(record);
    }
    return out;
  }

  const { data, error } = await client.from("result_brands").insert(rows).select();
  if (error) throw error;
  return data || [];
}

/**
 * Deletes every result_brands row belonging to a job (P1.2). result_brands
 * has no `job_id` column of its own (only `result_id`/`scan_id` — see the
 * migration and stampScanIdForJob's comment below), so this joins through
 * prompt_results instead: look up the job's result ids, then delete every
 * result_brands row whose `result_id` is one of them.
 *
 * Mirrors deleteCitationsForJob's role exactly: called immediately before a
 * fresh symmetric-judging materialization pass in runFinalizePhase, so a
 * crash-recovery re-finalize deletes-then-reinserts instead of duplicating
 * every row (result_brands carries no unique constraint of its own).
 * Empty-safe (no-op, returns 0) when the job has no prompt_results rows yet.
 */
export async function deleteResultBrandsForJob(jobId, deps = {}) {
  const client = resolveClient(deps);
  const hasDb = !!client;

  if (!hasDb) {
    const resultIds = new Set(
      Array.from(global.memoryPromptResults.values())
        .filter((r) => r.job_id === jobId)
        .map((r) => r.id)
    );
    let deleted = 0;
    for (const [id, row] of global.memoryResultBrands.entries()) {
      if (resultIds.has(row.result_id)) {
        global.memoryResultBrands.delete(id);
        deleted += 1;
      }
    }
    return deleted;
  }

  const { data: prRows, error: prError } = await client
    .from("prompt_results")
    .select("id")
    .eq("job_id", jobId);
  if (prError) throw prError;

  const resultIds = (prRows || []).map((r) => r.id);
  if (resultIds.length === 0) return 0;

  const { data, error } = await client
    .from("result_brands")
    .delete()
    .in("result_id", resultIds)
    .select();
  if (error) throw error;
  return (data || []).length;
}

const DEFAULT_RESULT_BRANDS_LIMIT = 5000;

/**
 * result_brands rows for a brand (P3a — the other half of the gaps
 * endpoint's join, alongside getCitationsForBrand). result_brands carries no
 * created_at/date column of its own (migration 005), and the gaps endpoint's
 * contract reads full history rather than a date window (see its route's
 * docstring) — so unlike getCitationsForBrand this takes no from/to, only a
 * defensive cap.
 */
export async function getResultBrandsForBrand(brand, { limit = DEFAULT_RESULT_BRANDS_LIMIT } = {}, deps = {}) {
  const client = resolveClient(deps);
  const hasDb = !!client;

  if (!hasDb) {
    return Array.from(global.memoryResultBrands.values())
      .filter((r) => r.brand === brand)
      .slice(0, limit);
  }

  const { data, error } = await client
    .from("result_brands")
    .select("*")
    .eq("brand", brand)
    .order("id", { ascending: true })
    .limit(limit);
  if (error) throw error;
  return data || [];
}

/**
 * Every result_brands row belonging to ONE scan (R0.3.3 roster continuity).
 *
 * Used by finalize to recover the last roster a scan actually measured, so a
 * scan whose rival extractor was unreachable can carry that roster forward
 * under an explicit `carried_forward` label instead of silently reporting an
 * empty rival set (which is what made Share of Voice read a false 100%).
 *
 * Deliberately keyed on scan_id, not on brand: result_brands carries no
 * created_at column, and its `id` is a random uuid, so rows for a brand
 * cannot be ordered chronologically from this table alone. The caller
 * establishes chronology from `scans.scanned_at` and passes the winning
 * scan_id in.
 */
export async function getResultBrandsForScan(scanId, deps = {}) {
  if (!scanId) return [];
  const client = resolveClient(deps);

  if (!client) {
    return Array.from(global.memoryResultBrands.values()).filter((r) => r.scan_id === scanId);
  }

  const { data, error } = await client.from("result_brands").select("*").eq("scan_id", scanId);
  if (error) throw error;
  return data || [];
}

// ---------------------------------------------------------------------------
// scan rate limit (migration 009)
// ---------------------------------------------------------------------------

global.memoryRateLimits = global.memoryRateLimits || new Map();

/**
 * Atomically add one to a rate-limit bucket and return the resulting count
 * (R0.1.4). Atomic because two concurrent requests must not both read the
 * same pre-increment value and both proceed.
 *
 * Postgres has no PostgREST verb for "upsert and return count+1", so this
 * uses the `increment_scan_rate_limit` function created in migration 009.
 * Throws on failure — checkScanRateLimit decides what a broken counter means,
 * and it says so out loud rather than silently allowing.
 */
export async function incrementScanRateLimit({ bucketKey, windowStart }, deps = {}) {
  const client = resolveClient(deps);

  if (!client) {
    const key = `${bucketKey}|${windowStart}`;
    const next = (global.memoryRateLimits.get(key) || 0) + 1;
    global.memoryRateLimits.set(key, next);
    return next;
  }

  const { data, error } = await client.rpc("increment_scan_rate_limit", {
    p_bucket_key: bucketKey,
    p_window_start: windowStart,
  });
  if (error) throw error;
  return Number(data);
}

// ---------------------------------------------------------------------------
// system heartbeats (migration 008) — "did the cron actually fire?"
// ---------------------------------------------------------------------------

/**
 * Record that a named scheduled job ran. Called by the worker routes AFTER
 * their auth gate, so a rejected request never looks like a healthy tick.
 *
 * Deliberately non-fatal: a heartbeat write failing must not fail the worker
 * run it is only observing. It IS logged, so a systematically broken
 * heartbeat does not become invisible.
 *
 * R3.1.7: When no data store is configured, returns null and does NOT write
 * to an in-memory map. A tick recorded with no data store must never be read
 * back as a measured tick.
 */
export async function recordCronTick(name, detail = null, deps = {}) {
  const client = resolveClient(deps);
  if (!client) {
    console.warn(`[heartbeat] no Supabase client — cannot record "${name}" cron tick`);
    return null;
  }
  const row = { name, last_tick_at: new Date().toISOString(), detail };
  const { error } = await client.from("system_heartbeats").upsert([row], { onConflict: "name" });
  if (error) {
    console.warn(`[heartbeat] could not record the "${name}" tick: ${error.message}`);
    return null;
  }
  return row;
}

/** Every recorded ticker, for /api/health. */
export async function getCronTicks(deps = {}) {
  const client = resolveClient(deps);
  if (!client) return [];
  const { data, error } = await client.from("system_heartbeats").select("*");
  if (error) throw error;
  return data || [];
}

// ---------------------------------------------------------------------------
// finalize: stamp scan_id
// ---------------------------------------------------------------------------

/**
 * Finalize step (D3): the `scans` row (and its id) only exists once scoring
 * completes at the end of a job, so every prompt_results/citations row
 * written during chunked probing is written with `scan_id = null` and gets
 * stamped here in a single pass. Only touches rows still unstamped
 * (`scan_id IS NULL`) for this job, so re-running finalize after a partial
 * failure never re-touches rows an earlier attempt already stamped.
 *
 * result_brands has no `job_id` column (only `result_id`/`scan_id`), so it is
 * out of scope here — not stamped by job_id at all. P1.2 writes result_brands
 * rows directly (via insertResultBrands, deleted-and-rewritten each finalize
 * pass by deleteResultBrandsForJob) with `scan_id` already resolved at
 * construction time, after this stamping step has already run — so there's
 * never a null-scan_id result_brands row to backfill here.
 */
export async function stampScanIdForJob(jobId, scanId, deps = {}) {
  const client = resolveClient(deps);
  const hasDb = !!client;

  if (!hasDb) {
    let promptResults = 0;
    for (const row of global.memoryPromptResults.values()) {
      if (row.job_id === jobId && row.scan_id == null) {
        row.scan_id = scanId;
        promptResults += 1;
      }
    }
    let citations = 0;
    for (const row of global.memoryCitations.values()) {
      if (row.job_id === jobId && row.scan_id == null) {
        row.scan_id = scanId;
        citations += 1;
      }
    }
    return { promptResults, citations };
  }

  const { data: prData, error: prError } = await client
    .from("prompt_results")
    .update({ scan_id: scanId })
    .eq("job_id", jobId)
    .is("scan_id", null)
    .select();
  if (prError) throw prError;

  const { data: citData, error: citError } = await client
    .from("citations")
    .update({ scan_id: scanId })
    .eq("job_id", jobId)
    .is("scan_id", null)
    .select();
  if (citError) throw citError;

  return { promptResults: (prData || []).length, citations: (citData || []).length };
}

// ---------------------------------------------------------------------------
// brand_metrics_daily
// ---------------------------------------------------------------------------

function brandMetricKey(row) {
  return `${row.brand}|${row.date}|${row.engine ?? "all"}`;
}

/**
 * Bulk upsert into brand_metrics_daily on (brand, date, engine) — the
 * table's PK. `engine` defaults to "all" (the blended/all-engines row) to
 * match the column's own DB default when a row omits it. Empty-safe.
 */
export async function upsertBrandMetricsDaily(rows, deps = {}) {
  const client = resolveClient(deps);
  const hasDb = !!client;

  if (!rows || rows.length === 0) return [];

  if (!hasDb) {
    const out = [];
    for (const row of rows) {
      const withEngine = { engine: "all", ...row };
      const key = brandMetricKey(withEngine);
      const existing = global.memoryBrandMetrics.get(key);
      const merged = existing ? { ...existing, ...withEngine } : withEngine;
      global.memoryBrandMetrics.set(key, merged);
      out.push(merged);
    }
    return out;
  }

  const { data, error } = await client
    .from("brand_metrics_daily")
    .upsert(rows, { onConflict: "brand,date,engine" })
    .select();
  if (error) throw error;
  return data || [];
}

/**
 * brand_metrics_daily series for a brand — powers every P0.4 trend chart.
 * `engine` is a literal filter (defaults to "all", the blended row), not a
 * wildcard: the table stores one row per tracked engine PLUS one blended
 * "all" row per day, so callers ask for exactly the series they want to
 * plot. `from`/`to` are optional inclusive bounds on `date` (YYYY-MM-DD).
 * Always ordered by date ascending (chart-ready).
 */
export async function getBrandMetricsSeries(brand, { from, to, engine = "all" } = {}, deps = {}) {
  const client = resolveClient(deps);
  const hasDb = !!client;

  if (!hasDb) {
    return Array.from(global.memoryBrandMetrics.values())
      .filter((r) => {
        if (r.brand !== brand) return false;
        if ((r.engine ?? "all") !== engine) return false;
        if (from && r.date < from) return false;
        if (to && r.date > to) return false;
        return true;
      })
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  }

  let query = client.from("brand_metrics_daily").select("*").eq("brand", brand).eq("engine", engine);
  if (from) query = query.gte("date", from);
  if (to) query = query.lte("date", to);
  const { data, error } = await query.order("date", { ascending: true });
  if (error) throw error;
  return data || [];
}

// Fetch only measurement metadata, never answer text or raw provider payloads.
// scan_id was historically nullable and has no foreign key: missing sources
// therefore remain explicitly legacy/unknown rather than being synthesized.
export async function getBrandMetricSources(scanIds, engine = "all", deps = {}) {
  if (!["all", "aio", "chatgpt", "gemini", "perplexity"].includes(engine))
    throw Error("Invalid metric source engine");
  const ids = [...new Set((scanIds || []).filter(id => typeof id === "string" &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id)))];
  if (!ids.length) return [];
  const client = resolveClient(deps);
  // Memory mode keeps no durable reports, so every point stays legacy/unknown.
  if (!client) return [];
  const projection = "id,headline_metric:raw_results->summary_stats->headline_metric" +
    (engine === "all" ? "" : `,engine_metric:raw_results->engines->${engine}->metrics->observed_exposure`);
  const batches = [];
  for (let i = 0; i < ids.length; i += 100) batches.push(ids.slice(i, i + 100));
  const results = await Promise.all(batches.map(async batch => {
    const {data,error} = await client.from("scans").select(projection).in("id",batch);
    if(error) throw error;
    return data || [];
  }));
  return results.flat();
}

// ---------------------------------------------------------------------------
// scan_schedules
// ---------------------------------------------------------------------------

/** One schedule row for a brand, or null if none exists yet. */
export async function getScanSchedule(brand, deps = {}) {
  const client = resolveClient(deps);
  const hasDb = !!client;

  if (!hasDb) {
    return global.memoryScanSchedules.get(brand) || null;
  }

  const { data, error } = await client.from("scan_schedules").select("*").eq("brand", brand);
  if (error) throw error;
  return data[0] || null;
}

/**
 * R3.4.5 — Insert a new scan_schedules row only if one does not already exist.
 *
 * Atomic: the decision to insert or skip is made by the database in a single
 * statement (INSERT ... ON CONFLICT DO NOTHING), so there is no window where
 * a concurrent operator edit can be clobbered by a stale write.
 *
 * Returns the inserted row if a new row was created, or null if one already
 * existed (conflict). Null is NOT a failure — the caller distinguishes
 * "already there" from "failed" by catching exceptions.
 */
export async function insertScanScheduleIfNotExists(row, deps = {}) {
  const client = resolveClient(deps);

  if (!client) {
    // Memory mode: same contract as Supabase's ON CONFLICT DO NOTHING.
    const existing = global.memoryScanSchedules.get(row.brand);
    if (existing) return null;
    const stamped = { ...row, updated_at: new Date().toISOString() };
    global.memoryScanSchedules.set(row.brand, stamped);
    return stamped;
  }

  const { data, error } = await client
    .from("scan_schedules")
    .upsert(row, { onConflict: "brand", ignoreDuplicates: true })
    .select();
  if (error) throw error;
  // ignoreDuplicates: true → INSERT ... ON CONFLICT DO NOTHING.
  // On conflict, `data` is an empty array; on insert, it contains the row.
  return data && data.length > 0 ? data[0] : null;
}

/**
 * Upsert on the `brand` PK. Always stamps `updated_at = now` — both the
 * schedule editor (P0.4) and the cron tick (P0.2, after each scheduled run)
 * call this, and every write should move the freshness marker regardless of
 * which fields changed.
 */
export async function upsertScanSchedule(brand, updates, deps = {}) {
  const client = resolveClient(deps);
  const hasDb = !!client;
  const stamped = { ...updates, brand, updated_at: new Date().toISOString() };

  if (!hasDb) {
    const existing = global.memoryScanSchedules.get(brand);
    const merged = existing ? { ...existing, ...stamped } : { ...stamped };
    global.memoryScanSchedules.set(brand, merged);
    return merged;
  }

  const { data, error } = await client
    .from("scan_schedules")
    .upsert(stamped, { onConflict: "brand" })
    .select();
  if (error) throw error;
  return data[0];
}

function isDueSchedule(row, nowMs) {
  if (!row || !row.enabled) return false;
  // F10: customer-managed rows run through start/block_customer_window, never the
  // legacy cron. Filtered here (not in the query) so both branches agree and the
  // read still works before migration 085 adds the column.
  if (row.managed_by === "customer") return false;
  if (!row.next_run_at) return true;
  const nextRunMs = new Date(row.next_run_at).getTime();
  return Number.isFinite(nextRunMs) && nextRunMs <= nowMs;
}

/**
 * Enabled schedules due for a run: `next_run_at <= now` OR `next_run_at IS
 * NULL` (a schedule that has never run — e.g. right after creation — is due
 * immediately). Filters client-side after a single `enabled = true` fetch
 * rather than building an OR-filter string, since scan_schedules is
 * brand-cardinality (small), not scan-cardinality. For the cron scheduler
 * tick (P0.2).
 */
export async function listDueSchedules(nowIso, deps = {}) {
  const client = resolveClient(deps);
  const hasDb = !!client;
  const nowMs = new Date(nowIso || Date.now()).getTime();

  if (!hasDb) {
    return Array.from(global.memoryScanSchedules.values()).filter((row) => isDueSchedule(row, nowMs));
  }

  const { data, error } = await client.from("scan_schedules").select("*").eq("enabled", true);
  if (error) throw error;
  return (data || []).filter((row) => isDueSchedule(row, nowMs));
}
