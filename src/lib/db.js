import { createClient } from "@supabase/supabase-js";

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

export async function insertScan(scanRecord) {
  if (!supabase) {
    console.warn("Supabase credentials missing. Skipping database insert.");
    return;
  }

  // Persist rich Phase 2 data: store full payload (incl. competitors list + used flag + results) in raw_results JSONB for flexibility
  const rawPayload = {
    results: scanRecord.results || [],
    competitors: scanRecord.competitors || [],
    used_dynamic_prompts: !!scanRecord.used_dynamic_prompts,
    platform: scanRecord.platform,
    scoring_version: scanRecord.scoring_version,
    mention_rate_pct: scanRecord.mention_rate_pct,
    judge_stats: scanRecord.judge_stats,
    score_ci_low: scanRecord.score_ci_low,
    score_ci_high: scanRecord.score_ci_high,
    stability: scanRecord.stability,
    prompt_set_id: scanRecord.prompt_set_id,
    prompt_set_hash: scanRecord.prompt_set_hash,
    intent_breakdown: scanRecord.intent_breakdown,
    topic_scores: scanRecord.topic_scores,
    share_of_voice_pct: scanRecord.share_of_voice_pct,
    win_rate_pct: scanRecord.win_rate_pct,
    brand_citation_share_pct: scanRecord.brand_citation_share_pct,
    top_domains: scanRecord.top_domains
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
      ]);
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
        ]);
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
