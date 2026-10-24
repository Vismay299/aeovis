import type { SupabaseClient } from "@supabase/supabase-js";
import { AppError, jsonOk, toErrorResponse } from "../../../../lib/http/errors.ts";
import { jobsListQuery } from "../../../../lib/jobs/jobs.contract.ts";
import { getSupabaseAdmin } from "../../../../lib/supabase/admin.js";

export const dynamic = "force-dynamic";

type OperatorDeps = { getSupabaseAdmin?: () => SupabaseClient | null };

type JobListRow = {
  id: string;
  kind: string;
  brand_key: string | null;
  trigger: "manual" | "scheduled" | "baseline" | "system";
  status: string;
  progress_done: number | null;
  progress_total: number | null;
  progress_label: string | null;
  payload: unknown;
  created_at: string;
  finished_at: string | null;
};

const COLUMNS =
  "id, kind, brand_key, trigger, status, progress_done, progress_total, progress_label, payload, created_at, finished_at";

function progressOf(row: JobListRow) {
  if (row.progress_done === null || row.progress_total === null) return null;
  return {
    done: row.progress_done,
    total: row.progress_total,
    ...(row.progress_label ? { label: row.progress_label } : {}),
  };
}

/** Payload keys only: an operator sees that a job carried something, never what. */
function payloadKeysOf(payload: unknown): string[] {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return [];
  return Object.keys(payload as Record<string, unknown>);
}

export async function GET(request: Request, deps: OperatorDeps = {}): Promise<Response> {
  try {
    const query = jobsListQuery.parse(Object.fromEntries(new URL(request.url).searchParams));
    const admin = (deps.getSupabaseAdmin ?? getSupabaseAdmin)();
    if (!admin) throw new AppError(503, "storage_unavailable", "Workspace storage is unavailable.");

    let builder = admin.from("jobs").select(COLUMNS);
    if (query.status !== undefined) builder = builder.eq("status", query.status);
    if (query.kind !== undefined) builder = builder.eq("kind", query.kind);
    if (query.brand_key !== undefined) builder = builder.eq("brand_key", query.brand_key);
    const { data, error } = await builder.order("created_at", { ascending: false }).limit(query.limit);
    if (error) throw new AppError(503, "storage_unavailable", "Workspace storage is unavailable.");

    return jsonOk({
      jobs: ((data ?? []) as JobListRow[]).map((row) => ({
        jobId: row.id,
        kind: row.kind,
        brandKey: row.brand_key,
        trigger: row.trigger,
        status: row.status,
        progress: progressOf(row),
        createdAt: new Date(row.created_at).toISOString(),
        finishedAt: row.finished_at === null ? null : new Date(row.finished_at).toISOString(),
        payloadKeys: payloadKeysOf(row.payload),
      })),
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
