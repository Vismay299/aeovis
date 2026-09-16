import { createClient } from "@supabase/supabase-js";
import crypto from "crypto";

// Lazy init so scripts that load .env after import still work, and serverless
// cold starts always read the latest env.
let _supabase = undefined; // undefined = not tried yet

/** @returns {import("@supabase/supabase-js").SupabaseClient | null} */
export function getSupabase() {
  if (_supabase !== undefined) return _supabase;
  const supabaseUrl = (process.env.NEXT_PUBLIC_SUPABASE_URL || "").trim();
  const supabaseKey = (process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "").trim();
  if (!supabaseUrl || !supabaseKey) {
    _supabase = null;
    return null;
  }
  _supabase = createClient(supabaseUrl, supabaseKey);
  return _supabase;
}

/** @deprecated Prefer getSupabase() — kept for call sites that check truthiness carefully */
export const supabase = {
  get client() {
    return getSupabase();
  },
};

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
  if (!getSupabase()) {
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
    const { data, error } = await getSupabase()
      .from("scans")
      .insert([
        {
          ...baseRecord,
          scoring_version: scanRecord.scoring_version,
          score_ci_low: scanRecord.score_ci_low,
          score_ci_high: scanRecord.score_ci_high,
          stability: scanRecord.stability,
          mention_rate_pct: scanRecord.mention_rate_pct,
        },
      ])
      .select();
    if (error) throw error;
    return data;
  } catch (err) {
    console.warn("Inserting with all columns failed, retrying with only scoring_version:", err.message || err);
    // Cascade 2: try to insert with scoring_version only (Phase 1 schema)
    try {
      const { data, error } = await getSupabase()
        .from("scans")
        .insert([
          {
            ...baseRecord,
            scoring_version: scanRecord.scoring_version,
          },
        ])
        .select();
      if (error) throw error;
      return data;
    } catch (err2) {
      console.warn("Inserting with scoring_version failed, retrying baseRecord only:", err2.message || err2);
      // Cascade 3: try base record only (Legacy schema)
      try {
        const { data, error } = await getSupabase()
          .from("scans")
          .insert([baseRecord])
          .select();
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
  if (!getSupabase()) {
    return [];
  }
  
  const { data, error } = await getSupabase()
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

  if (!getSupabase()) {
    global.memoryJobs.set(jobId, job);
    return job;
  }

  try {
    const { data, error } = await getSupabase()
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

export async function getScanJob(jobId) {
  // Prefer Supabase when configured — never let a stale memory entry block DB reads.
  if (getSupabase()) {
    try {
      const { data, error } = await getSupabase()
        .from("scan_jobs")
        .select("*")
        .eq("id", jobId);
      if (error) throw error;
      if (data?.[0]) return data[0];
    } catch (err) {
      console.warn("Failed to get scan_job from database, checking memory:", err.message);
    }
  }
  return global.memoryJobs.get(jobId) || null;
}

export async function updateScanJob(jobId, updates) {
  // Mirror to memory for local/dev fallback
  const memJob = global.memoryJobs.get(jobId);
  if (memJob) {
    Object.assign(memJob, updates);
  }

  if (!getSupabase()) {
    if (!memJob) {
      global.memoryJobs.set(jobId, { id: jobId, ...updates });
    }
    return global.memoryJobs.get(jobId);
  }

  try {
    const { data, error } = await getSupabase()
      .from("scan_jobs")
      .update(updates)
      .eq("id", jobId)
      .select();
    if (error) throw error;
    if (data?.[0] && memJob) Object.assign(memJob, data[0]);
    return data?.[0] || memJob || { id: jobId, ...updates };
  } catch (err) {
    console.warn("Failed to update scan_job in database, updated memory:", err.message);
    if (!memJob) {
      global.memoryJobs.set(jobId, { id: jobId, ...updates });
    }
    return global.memoryJobs.get(jobId);
  }
}

// Global memory store for content events (Next.js hot-reload safe)
global.memoryContentEvents = global.memoryContentEvents || new Map();

export async function getContentEvents(brand) {
  if (!getSupabase()) {
    const list = Array.from(global.memoryContentEvents.values());
    return list.filter(item => item.brand.toLowerCase() === brand.toLowerCase());
  }

  try {
    const { data, error } = await getSupabase()
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

  if (!getSupabase()) {
    global.memoryContentEvents.set(id, event);
    return event;
  }

  try {
    const { data, error } = await getSupabase()
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
