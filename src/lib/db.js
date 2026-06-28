import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

// Avoid throwing if env vars are missing during build phase, but we'll need them at runtime
const supabase = supabaseUrl && supabaseKey ? createClient(supabaseUrl, supabaseKey) : null;

export async function insertScan(scanRecord) {
  if (!supabase) {
    console.warn("Supabase credentials missing. Skipping database insert.");
    return;
  }

  const { data, error } = await supabase
    .from("scans")
    .insert([
      {
        brand: scanRecord.brand,
        url: scanRecord.url,
        industry: scanRecord.industry,
        visibility_pct: scanRecord.visibility_pct,
        prompts_tracked: scanRecord.prompts_tracked,
        prompts_mentioned: scanRecord.prompts_mentioned,
        raw_results: scanRecord.results,
        scanned_at: scanRecord.scanned_at,
      }
    ]);

  if (error) {
    console.error("Error inserting into Supabase:", error);
    throw error;
  }

  return data;
}
