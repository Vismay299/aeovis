import type { SupabaseClient } from "@supabase/supabase-js";
import { AppError } from "../http/errors.ts";
import type { SubmissionSource } from "../../shared/indexnow.ts";

export type SubmissionHistoryItem = {
  id: string;
  createdAt: string;
  source: SubmissionSource;
  sourceRef: string | null;
  host: string;
  urlCount: number;
  urls: string[];
  status: "submitted" | "failed";
  engine: "bing" | "yandex" | "yep" | null;
  httpStatus: number | null;
  message: string;
};

export async function listSubmissions(
  admin: SupabaseClient,
  ws: { brandKey: string },
  opts?: { source?: SubmissionSource; sourceRef?: string; limit?: number }
): Promise<{ submissions: SubmissionHistoryItem[] }> {
  const limit = Math.max(1, Math.min(opts?.limit ?? 20, 50));

  let query = admin
    .from("indexnow_submissions")
    .select("id, created_at, source, source_ref, host, url_count, urls, status, engine, http_status, message")
    .eq("brand_key", ws.brandKey)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (opts?.source) {
    query = query.eq("source", opts.source);
  }
  if (opts?.sourceRef) {
    query = query.eq("source_ref", opts.sourceRef);
  }

  const { data, error } = await query;
  if (error) {
    throw new AppError(503, "indexnow_unavailable", "IndexNow could not be reached. Please retry.");
  }

  const submissions: SubmissionHistoryItem[] = (data ?? []).map((r) => ({
    id: r.id,
    createdAt: new Date(r.created_at).toISOString(),
    source: r.source as SubmissionSource,
    sourceRef: r.source_ref ?? null,
    host: r.host,
    urlCount: r.url_count,
    urls: (r.urls ?? []).slice(0, 5),
    status: r.status as "submitted" | "failed",
    engine: r.engine as "bing" | "yandex" | "yep" | null,
    httpStatus: r.http_status ?? null,
    message: r.message,
  }));

  return { submissions };
}
