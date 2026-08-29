import { createClient } from "@supabase/supabase-js";
import crypto from "crypto";
import { buildScanBaseRecord } from "./db/scanRow.js";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

// Avoid throwing if env vars are missing during build phase, but we'll need them at runtime
export const supabase = supabaseUrl && supabaseKey ? createClient(supabaseUrl, supabaseKey) : null;

// Migration SQL:
// ALTER TABLE scans ADD COLUMN scoring_version text;
// ALTER TABLE scans ADD COLUMN score_ci_low numeric;
// ALTER TABLE scans ADD COLUMN score_ci_high numeric;
// ALTER TABLE scans ADD COLUMN stability text;
// ALTER TABLE scans ADD COLUMN mention_rate_pct numeric;
//
// CREATE TABLE scan_jobs (
//   id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
//   brand text NOT NULL,
//   url text,
//   industry text,
//   competitors text,
//   status text NOT NULL,
//   progress_pct integer DEFAULT 0,
//   created_at timestamptz DEFAULT now(),
//   result_id uuid REFERENCES scans(id) ON DELETE SET NULL,
//   error_message text,
//   run_record jsonb,
//   query_source text,
//   gsc_queries jsonb
// );
//
// CREATE TABLE brand_prompts (
//   id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
//   brand text NOT NULL,
//   text text NOT NULL,
//   intent_tier text NOT NULL,
//   topic text,
//   weight numeric DEFAULT 1.0,
//   enabled boolean DEFAULT true,
//   created_at timestamptz DEFAULT now()
// );
// CREATE UNIQUE INDEX brand_prompts_brand_text_idx ON brand_prompts (brand, text);
//
// CREATE TABLE content_events (
//   id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
//   brand text NOT NULL,
//   url text NOT NULL,
//   publish_date timestamptz DEFAULT now(),
//   created_at timestamptz DEFAULT now()
// );
// CREATE UNIQUE INDEX content_events_brand_url_idx ON content_events (brand, url);

export async function insertScan(scanRecord) {
  if (!supabase) {
    console.warn("Supabase credentials missing. Skipping database insert.");
    return;
  }

  // Persist rich scan data in raw_results JSONB for history / normalizeResult
  const rawPayload = {
    results: scanRecord.results || [],
    competitors: scanRecord.competitors || [],
    competitors_raw: scanRecord.competitors_raw,
    // R0.3.3: how this scan's roster was obtained — "extracted",
    // "carried_forward" or "unavailable". Lives in JSONB rather than its own
    // column so it ships without a migration this environment cannot apply;
    // every dashboard surface reads it to decide whether Share of Voice is a
    // measurement or an unassessed state.
    roster_source: scanRecord.roster_source ?? null,
    roster_extraction_offline: scanRecord.roster_extraction_offline ?? null,
    roster_extraction_error: scanRecord.roster_extraction_error ?? null,
    used_dynamic_prompts: !!scanRecord.used_dynamic_prompts,
    platform: scanRecord.platform,
    scoring_version: scanRecord.scoring_version,
    mention_rate_pct: scanRecord.mention_rate_pct,
    judge_stats: scanRecord.judge_stats,
    score_ci_low: scanRecord.score_ci_low,
    score_ci_high: scanRecord.score_ci_high,
    stability: scanRecord.stability,
    sample_size_adequacy: scanRecord.sample_size_adequacy,
    prompt_set_id: scanRecord.prompt_set_id,
    prompt_set_hash: scanRecord.prompt_set_hash,
    intent_breakdown: scanRecord.intent_breakdown,
    topic_scores: scanRecord.topic_scores,
    share_of_voice_pct: scanRecord.share_of_voice_pct,
    win_rate_pct: scanRecord.win_rate_pct,
    brand_citation_share_pct: scanRecord.brand_citation_share_pct,
    branded_visibility_pct: scanRecord.branded_visibility_pct,
    aio_coverage_pct: scanRecord.aio_coverage_pct,
    aio_error_rate_pct: scanRecord.aio_error_rate_pct,
    data_source_issue: scanRecord.data_source_issue,
    insufficient_sample: scanRecord.insufficient_sample,
    summary_stats: scanRecord.summary_stats || null,
    seeds: scanRecord.seeds || [],
    top_domains: scanRecord.top_domains,
    engine_scores: scanRecord.engine_scores,
    cost_by_engine: scanRecord.cost_by_engine,
    // v9 multi-engine: per-engine summaries + headline index. Without these,
    // history reloads silently degrade multi-engine scans to AIO-only.
    engines: scanRecord.engines || null,
    visibility_index_pct: scanRecord.visibility_index_pct ?? null,
    engines_counted: scanRecord.engines_counted ?? 0,
    engines_partial: scanRecord.engines_partial,
    serp_coverage_pct: scanRecord.serp_coverage_pct,
    probe_sources: scanRecord.probe_sources,
    quality_gate_failed: scanRecord.quality_gate_failed,
    probe_failure_rate: scanRecord.probe_failure_rate,
    judge_disagreement_count: scanRecord.judge_disagreement_count,
    control_prompts_passed: scanRecord.control_prompts_passed,
    control_prompts_total: scanRecord.control_prompts_total,
    query_source: scanRecord.query_source,
    content_lift: scanRecord.content_lift || [],
    cost_total: scanRecord.cost_total,
    tokens_used: scanRecord.tokens_used,
  };

  const baseRecord = buildScanBaseRecord({ ...scanRecord, raw_results: rawPayload });

  // Cascade 1: try to insert with all new columns
  try {
    const { data, error } = await supabase
      .from("scans")
      .insert([
        {
          ...baseRecord,
          scoring_version: scanRecord.scoring_version,
          score_ci_low: scanRecord.score_ci_low,
          score_ci_high: scanRecord.score_ci_high,
          stability: scanRecord.stability,
          mention_rate_pct: scanRecord.mention_rate_pct,
        }
      ])
      .select();
    if (error) throw error;
    return data;
  } catch (err) {
    console.warn("Inserting with all columns failed, retrying with only scoring_version:", err.message || err);
    // Cascade 2: try to insert with scoring_version only (Phase 1 schema)
    try {
      const { data, error } = await supabase
        .from("scans")
        .insert([
          {
            ...baseRecord,
            scoring_version: scanRecord.scoring_version,
          }
        ])
        .select();
      if (error) throw error;
      return data;
    } catch (err2) {
      console.warn("Inserting with scoring_version failed, retrying baseRecord only:", err2.message || err2);
      // Cascade 3: try base record only (Legacy schema)
      try {
        const { data, error } = await supabase
          .from("scans")
          .insert([baseRecord]);
        if (error) throw error;
        return data;
      } catch (fallbackErr) {
        console.error("Fallback insert failed:", fallbackErr);
        throw fallbackErr;
      }
    }
  }
}

export async function getScansForBrand(brand) {
  if (!supabase) {
    return [];
  }

  const { data, error } = await supabase
    .from("scans")
    .select("*")
    .ilike("brand", brand)
    .order("scanned_at", { ascending: false });

  if (error) {
    console.error("Error fetching scans from Supabase:", error);
    return [];
  }

  return data;
}

/**
 * Scans for a brand looked up by its DOMAIN rather than its display name.
 *
 * `scans.brand` holds the display name ("Italica") while the analytics tables
 * and every /api/brands/[brand]/* sibling route are keyed by the resolved
 * domain ("italicatiles.com"). A caller holding only the domain key otherwise
 * gets an empty result for a brand that has been scanned 8 times — which is
 * exactly how /api/brands/[brand]/coverage 404'd on its first live call.
 *
 * Matching is done on the scan's own `url` host, in JS rather than SQL, so
 * "https://www.x.com/path", "x.com" and "X.COM" all resolve to one brand.
 * Full rows (raw_results included) — callers need the per-prompt payload.
 */
export async function getScansByDomain(domain, deps = {}) {
  const client = resolveClient(deps);
  if (!client) return [];

  const host = String(domain || "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .split("/")[0];
  if (!host) return [];

  try {
    const { data, error } = await client
      .from("scans")
      .select("*")
      .order("scanned_at", { ascending: false })
      .limit(200);
    if (error) throw error;

    return (data || []).filter((s) => {
      const scanHost = String(s.url || "")
        .trim()
        .toLowerCase()
        .replace(/^https?:\/\//, "")
        .replace(/^www\./, "")
        .split("/")[0];
      return scanHost === host;
    });
  } catch (err) {
    console.warn("[db] getScansByDomain failed:", err.message);
    return [];
  }
}

/**
 * Recent scans collapsed to the latest per brand, for the homepage workspace.
 * Returns lightweight rows (no full raw_results payload beyond what a card
 * needs) so the homepage stays fast.
 */
export async function listRecentScans(limit = 12) {
  if (!supabase) return [];
  try {
    const { data, error } = await supabase
      .from("scans")
      .select("id, brand, url, industry, visibility_pct, scanned_at, raw_results")
      .order("scanned_at", { ascending: false })
      .limit(200);
    if (error) throw error;

    const byBrand = new Map();
    for (const s of data || []) {
      const key = String(s.brand || "").trim().toLowerCase();
      if (!key) continue;
      const raw = s.raw_results || {};
      const engines = raw.engines ? Object.keys(raw.engines) : [];
      const score =
        raw.visibility_index_pct ??
        raw.summary_stats?.share_of_ai_pct ??
        s.visibility_pct ??
        null;
      const existing = byBrand.get(key);
      if (!existing) {
        byBrand.set(key, {
          id: s.id,
          brand: s.brand,
          url: s.url,
          industry: s.industry,
          score: score == null ? null : Math.round(Number(score) * 10) / 10,
          scanned_at: s.scanned_at,
          engines,
          scan_count: 1,
        });
      } else {
        existing.scan_count += 1;
      }
    }
    return Array.from(byBrand.values())
      .sort((a, b) => new Date(b.scanned_at) - new Date(a.scanned_at))
      .slice(0, limit);
  } catch (err) {
    console.warn("[db] listRecentScans failed:", err.message);
    return [];
  }
}

// Global memory store for scan jobs (Next.js hot-reload safe)
global.memoryJobs = global.memoryJobs || new Map();

/**
 * Scan job store — DB-authoritative, fail-loud (P0.0).
 *
 *  - hasDb === true  (Supabase configured): Supabase is the ONLY source of
 *    truth for scan_jobs. Every read/write goes straight to it; a DB error
 *    THROWS instead of silently degrading to the in-memory map. Falling back
 *    used to be a poison pill: one transient DB failure inside createScanJob
 *    tipped a job into memoryJobs, and — because getScanJob/updateScanJob
 *    checked memory first — every later update for that job on that instance
 *    then wrote to memory only. Checkpoints silently stopped persisting, and
 *    a different serverless instance (or the DB-backed status poll) kept
 *    reading stale state forever.
 *  - hasDb === false (no Supabase — local dev, `npm run test:*`): the
 *    in-memory Map is the only store, exactly as before this fix.
 *
 * `deps.client` is test-only injection (defaults to the module-level
 * `supabase`), so every real call site — which never passes `deps` — behaves
 * exactly as `hasDb = !!supabase`.
 */
function resolveClient(deps) {
  return deps && Object.prototype.hasOwnProperty.call(deps, "client") ? deps.client : supabase;
}

/** Worker-active statuses — a job in one of these is still running. */
export const SCAN_JOB_RUNNING = ["pending", "generating_prompts", "probing", "scoring"];

/** A running job with no heartbeat inside this window is presumed dead. */
export const HEARTBEAT_STALE_MS = 3 * 60 * 1000;

/**
 * Canonical liveness check: running status + a heartbeat stamped within
 * HEARTBEAT_STALE_MS. updateScanJob stamps heartbeat_at on every call, so a
 * worker that's genuinely still processing keeps its job "alive"; a crashed
 * or orphaned worker's job goes stale after one heartbeat window — it stops
 * blocking new scans (see hasActiveScanForBrand below) and becomes eligible
 * for rescue/restart. A running-status job with a stale or absent heartbeat
 * is treated as dead. Exported so the worker/status route reuses this exact
 * same staleness definition.
 */
export function isJobAlive(job, nowMs = Date.now()) {
  if (!job || !SCAN_JOB_RUNNING.includes(job.status)) return false;
  const heartbeatMs = new Date(job.heartbeat_at || 0).getTime();
  return Number.isFinite(heartbeatMs) && nowMs - heartbeatMs < HEARTBEAT_STALE_MS;
}

export async function createScanJob({ brand, url, industry, competitors }, deps = {}) {
  const client = resolveClient(deps);
  const hasDb = !!client;

  const jobId = crypto.randomUUID();
  const now = new Date().toISOString();
  const job = {
    id: jobId,
    brand,
    url: url || "",
    industry: industry || "",
    competitors: competitors || "",
    query_source: "hybrid",
    gsc_queries: [],
    status: "pending",
    progress_pct: 0,
    created_at: now,
    heartbeat_at: now,
    result_id: null,
    error_message: null,
    run_record: null
  };

  if (!hasDb) {
    global.memoryJobs.set(jobId, job);
    return job;
  }

  const { data, error } = await client
    .from("scan_jobs")
    .insert([job])
    .select();
  if (error) throw error;
  return data[0];
}

/**
 * True if a scan for this brand is already running. Checks the shared
 * `scan_jobs` table (not just the in-process memory map — on serverless each
 * instance has its own map, so a memory-only check does not prevent two
 * concurrent scans from starting and overloading the Bright Data zone), and
 * only counts a running job as blocking while isJobAlive says its heartbeat
 * is fresh. A crashed job stuck in "probing" cannot block a brand forever.
 */
export async function hasActiveScanForBrand(brand, deps = {}) {
  const client = resolveClient(deps);
  const hasDb = !!client;
  const key = String(brand || "").trim().toLowerCase();
  if (!key) return false;

  if (!hasDb) {
    for (const job of global.memoryJobs.values()) {
      if (String(job.brand || "").trim().toLowerCase() !== key) continue;
      if (isJobAlive(job)) return true;
    }
    return false;
  }

  try {
    const { data, error } = await client
      .from("scan_jobs")
      .select("id, status, heartbeat_at")
      .ilike("brand", key)
      .in("status", SCAN_JOB_RUNNING)
      .limit(20);
    if (error) throw error;
    return (data || []).some((job) => isJobAlive(job));
  } catch (err) {
    // Fail open: a broken duplicate-check must not block all scanning. This
    // is the read-side check only — the writes in this module still throw.
    console.warn("[db] hasActiveScanForBrand check failed, allowing scan:", err.message);
    return false;
  }
}

export async function getScanJob(jobId, deps = {}) {
  const client = resolveClient(deps);
  const hasDb = !!client;

  if (!hasDb) {
    return global.memoryJobs.get(jobId) || null;
  }

  const { data, error } = await client
    .from("scan_jobs")
    .select("*")
    .eq("id", jobId);
  if (error) throw error;
  return data[0] || null;
}

export async function updateScanJob(jobId, updates, deps = {}) {
  const client = resolveClient(deps);
  const hasDb = !!client;
  // Any update means the worker is alive — stamp on every call, including
  // ones that only touch progress_pct or checkpoint.
  const stamped = { ...updates, heartbeat_at: new Date().toISOString() };

  if (!hasDb) {
    const memJob = global.memoryJobs.get(jobId);
    if (memJob) {
      Object.assign(memJob, stamped);
      return memJob;
    }
    const created = { id: jobId, ...stamped };
    global.memoryJobs.set(jobId, created);
    return created;
  }

  const { data, error } = await client
    .from("scan_jobs")
    .update(stamped)
    .eq("id", jobId)
    .select();
  if (error) throw error;
  return data[0];
}

/**
 * Compare-and-set status transition — structural single-flight (P0.2 FIX 2).
 * Flips `status` from `fromStatus` to `toStatus` ONLY if the row's status
 * still equals `fromStatus` at the moment the UPDATE actually runs:
 * `.eq("status", fromStatus)` (or `.in("status", fromStatus)` when an array
 * is passed) is part of the same UPDATE statement as the write, so Postgres'
 * row-level locking makes the check-and-set atomic — of two callers racing
 * this exact statement against the same row, only one's WHERE clause can
 * still match (the loser's UPDATE affects 0 rows). This is how sourcing and
 * finalize (scanWorker.js) claim exclusive ownership of a job phase without
 * a dedicated lock table: only a fixed sequential crash-recovery guard
 * existed before (D3-class bug — see plan.md P0.2), and that only protects
 * against a SEQUENTIAL retry, not two instances genuinely running at once.
 *
 * `fromStatus` may be a single status string or an array of acceptable
 * current statuses (`.in()` instead of `.eq()`) — sourcing can be claimed
 * from either "pending" or "generating_prompts" (fresh start or a resume
 * after an earlier attempt crashed mid-sourcing).
 *
 * Returns the updated row if THIS caller won the transition, else `null` —
 * never throws for a lost race, that's an expected, common outcome. Fail-loud
 * only on a genuine DB error (thrown), matching every other function here: a
 * claim is correctness-critical and must never silently degrade.
 *
 * Memory path (hasDb === false): mirrors updateScanJob's own auto-vivify
 * convenience when the job doesn't exist yet in `global.memoryJobs` — there
 * is exactly one process and one map in that mode, so there is no concurrent
 * caller to lose a race to. When the job DOES already exist, the same
 * fromStatus check applies as the DB path.
 */
export async function claimJobStatus(jobId, fromStatus, toStatus, deps = {}) {
  const client = resolveClient(deps);
  const hasDb = !!client;
  const now = new Date().toISOString();
  const fromList = Array.isArray(fromStatus) ? fromStatus : [fromStatus];

  if (!hasDb) {
    const memJob = global.memoryJobs.get(jobId);
    if (memJob) {
      if (!fromList.includes(memJob.status)) return null;
      Object.assign(memJob, { status: toStatus, heartbeat_at: now });
      return memJob;
    }
    const created = { id: jobId, status: toStatus, heartbeat_at: now };
    global.memoryJobs.set(jobId, created);
    return created;
  }

  let query = client.from("scan_jobs").update({ status: toStatus, heartbeat_at: now }).eq("id", jobId);
  query = Array.isArray(fromStatus) ? query.in("status", fromStatus) : query.eq("status", fromStatus);
  const { data, error } = await query.select();
  if (error) throw error;
  return data && data[0] ? data[0] : null;
}

// Global memory store for content events (Next.js hot-reload safe)
global.memoryContentEvents = global.memoryContentEvents || new Map();

export async function getContentEvents(brand) {
  if (!supabase) {
    const list = Array.from(global.memoryContentEvents.values());
    return list.filter(item => item.brand.toLowerCase() === brand.toLowerCase());
  }

  try {
    const { data, error } = await supabase
      .from("content_events")
      .select("*")
      .eq("brand", brand)
      .order("publish_date", { ascending: false });

    if (error) throw error;
    return data || [];
  } catch (err) {
    console.warn("Failed to fetch content_events from database, checking memory:", err.message);
    const list = Array.from(global.memoryContentEvents.values());
    return list.filter(item => item.brand.toLowerCase() === brand.toLowerCase());
  }
}

export async function insertContentEvent({ brand, url, publishDate }) {
  const id = crypto.randomUUID();
  const event = {
    id,
    brand,
    url,
    publish_date: publishDate || new Date().toISOString(),
    created_at: new Date().toISOString()
  };

  if (!supabase) {
    global.memoryContentEvents.set(id, event);
    return event;
  }

  try {
    const { data, error } = await supabase
      .from("content_events")
      .insert([event])
      .select();

    if (error) throw error;
    return data[0];
  } catch (err) {
    console.warn("Failed to insert content_event to database, falling back to memory:", err.message);
    global.memoryContentEvents.set(id, event);
    return event;
  }
}
