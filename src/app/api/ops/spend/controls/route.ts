import type { SupabaseClient } from "@supabase/supabase-js";
import { AppError, jsonOk, toErrorResponse } from "../../../../../lib/http/errors.ts";
import { getSupabaseAdmin } from "../../../../../lib/supabase/admin.js";

export const dynamic = "force-dynamic";

type OperatorDeps = { getSupabaseAdmin?: () => SupabaseClient | null };

type ControlRow = {
  feature: string;
  enabled: boolean;
  mode: "all" | "allowlist";
  brand_allowlist: string[] | null;
  daily_cap_usd: number | string | null;
  max_call_usd: number | string | null;
  note: string | null;
  updated_at: string;
};

function toUsd(value: number | string | null): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function controlJson(row: ControlRow) {
  return {
    feature: row.feature,
    enabled: row.enabled,
    mode: row.mode,
    brandAllowlist: row.brand_allowlist ?? [],
    dailyCapUsd: toUsd(row.daily_cap_usd),
    maxCallUsd: toUsd(row.max_call_usd),
    note: row.note,
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

export async function GET(_request: Request, deps: OperatorDeps = {}) {
  try {
    const admin = (deps.getSupabaseAdmin ?? getSupabaseAdmin)();
    if (!admin) throw new AppError(503, "storage_unavailable", "Workspace storage is unavailable.");
    const { data, error } = await admin.from("paid_feature_controls").select("*").order("feature");
    if (error) {
      throw new AppError(503, "spend_unavailable", "Spend control is unavailable, so paid work is paused.");
    }
    return jsonOk({ controls: ((data ?? []) as ControlRow[]).map(controlJson) });
  } catch (err) {
    return toErrorResponse(err);
  }
}
