import { createClient } from "@supabase/supabase-js";
import crypto from "crypto";

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

  const baseRecord = {
    brand: scanRecord.brand,
    url: scanRecord.url,
    industry: scanRecord.industry,
    visibility_pct: scanRecord.visibility_pct,
    prompts_tracked: scanRecord.prompts_tracked,
    prompts_mentioned: scanRecord.prompts_mentioned,
    raw_results: rawPayload,
    scanned_at: scanRecord.scanned_at,
  };

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

// Global memory store for scan jobs (Next.js hot-reload safe)
global.memoryJobs = global.memoryJobs || new Map();
export async function createScanJob({ brand, url, industry, competitors }) {
  const jobId = crypto.randomUUID();
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
    created_at: new Date().toISOString(),
    result_id: null,
    error_message: null,
    run_record: null
  };

  if (!supabase) {
    global.memoryJobs.set(jobId, job);
    return job;
  }

  try {
    const { data, error } = await supabase
      .from("scan_jobs")
      .insert([job])
      .select();
    if (error) throw error;
    return data[0];
  } catch (err) {
    console.warn("Failed to insert scan_job to database, falling back to memory:", err.message);
    global.memoryJobs.set(jobId, job);
    return job;
  }
}

/**
 * True if a scan for this brand is already running. Checks the shared
 * `scan_jobs` table, not just the in-process memory map — on serverless each
 * instance has its own map, so a memory-only check does not prevent two
 * concurrent scans from starting and overloading the Bright Data zone.
 *
 * Jobs older than STALE_JOB_MS are ignored so a crashed job stuck in
 * "probing" cannot block a brand forever.
 */
const STALE_JOB_MS = 15 * 60 * 1000;

export async function hasActiveScanForBrand(brand) {
  const RUNNING = ["pending", "generating_prompts", "probing", "scoring"];
  const key = String(brand || "").trim().toLowerCase();
  if (!key) return false;

  const cutoffMs = Date.now() - STALE_JOB_MS;

  // In-memory first: covers local dev and Supabase-less runs.
  for (const job of global.memoryJobs.values()) {
    if (String(job.brand || "").trim().toLowerCase() !== key) continue;
    if (!RUNNING.includes(job.status)) continue;
    const created = new Date(job.created_at || 0).getTime();
    if (Number.isFinite(created) && created < cutoffMs) continue; // stale
    return true;
  }

  if (!supabase) return false;

  try {
    const { data, error } = await supabase
      .from("scan_jobs")
      .select("id")
      .ilike("brand", key)
      .in("status", RUNNING)
      .gt("created_at", new Date(cutoffMs).toISOString())
      .limit(1);
    if (error) throw error;
    return (data || []).length > 0;
  } catch (err) {
    // Fail open: a broken duplicate-check must not block all scanning.
    console.warn("[db] hasActiveScanForBrand check failed, allowing scan:", err.message);
    return false;
  }
}

export async function getScanJob(jobId) {
  if (!supabase || global.memoryJobs.has(jobId)) {
    return global.memoryJobs.get(jobId) || null;
  }

  try {
    const { data, error } = await supabase
      .from("scan_jobs")
      .select("*")
      .eq("id", jobId);
    if (error) throw error;
    return data[0] || global.memoryJobs.get(jobId) || null;
  } catch (err) {
    console.warn("Failed to get scan_job from database, checking memory:", err.message);
    return global.memoryJobs.get(jobId) || null;
  }
}

export async function updateScanJob(jobId, updates) {
  // Always update in memory as fallback/mirror
  const memJob = global.memoryJobs.get(jobId);
  if (memJob) {
    Object.assign(memJob, updates);
  }

  if (!supabase || global.memoryJobs.has(jobId)) {
    if (!memJob) {
      const fallbackJob = { id: jobId, ...updates };
      global.memoryJobs.set(jobId, fallbackJob);
    }
    return memJob || global.memoryJobs.get(jobId);
  }

  try {
    const { data, error } = await supabase
      .from("scan_jobs")
      .update(updates)
      .eq("id", jobId)
      .select();
    if (error) throw error;
    return data[0];
  } catch (err) {
    console.warn("Failed to update scan_job in database, updated memory:", err.message);
    if (memJob) return memJob;
    const updated = { id: jobId, ...updates };
    global.memoryJobs.set(jobId, updated);
    return updated;
  }
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
