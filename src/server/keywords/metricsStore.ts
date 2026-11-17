// Storage adapter for public.keyword_metrics table
import type { SupabaseClient } from "@supabase/supabase-js";

export type KeywordMetricUpsert = {
  keyword: string;
  location_code: number;
  language_code: string;
  search_volume: number | null;
  cpc: number | null;
  competition: number | null;
  keyword_difficulty: number | null;
  intent: string | null;
  monthly_searches: unknown[];
  source: "labs" | "google_ads" | "labs_ranked";
};

function dedupeMetricsRows(rows: KeywordMetricUpsert[]): KeywordMetricUpsert[] {
  const map = new Map<string, KeywordMetricUpsert>();
  for (const r of rows) {
    const key = `${r.keyword.trim().toLowerCase()}|${r.location_code}|${r.language_code}`;
    map.set(key, { ...r, keyword: r.keyword.trim().toLowerCase() });
  }
  return [...map.values()];
}

function chunkArray<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function upsertKeywordMetrics(
  admin: SupabaseClient,
  rows: KeywordMetricUpsert[],
): Promise<void> {
  if (rows.length === 0) return;

  const deduped = dedupeMetricsRows(rows);
  const chunks = chunkArray(deduped, 500);

  for (const chunk of chunks) {
    let success = false;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const { error } = await admin.rpc("upsert_keyword_metrics", {
          p_rows: chunk,
        });
        if (error) {
          throw error;
        }
        success = true;
        break;
      } catch (err: unknown) {
        if (attempt < 3) {
          await sleep(250);
        } else {
          console.error("[keywords] metrics upsert failed", {
            rows: chunk.length,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }
  }
}
