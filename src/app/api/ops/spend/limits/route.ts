import type { SupabaseClient } from "@supabase/supabase-js";
import { AppError, jsonOk, toErrorResponse } from "../../../../../lib/http/errors.ts";
import { getSupabaseAdmin } from "../../../../../lib/supabase/admin.js";
import { spendLimitsQuery } from "../../../../../lib/spend/spend.contract.ts";

export const dynamic = "force-dynamic";

type OperatorDeps = { getSupabaseAdmin?: () => SupabaseClient | null };

type LimitRow = {
  brand_key: string;
  daily_cap_usd: number | string | null;
  monthly_cap_usd: number | string | null;
  updated_at: string;
};

function toUsd(value: number | string | null): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function limitJson(row: LimitRow) {
  return {
    brandKey: row.brand_key,
    dailyCapUsd: toUsd(row.daily_cap_usd),
    monthlyCapUsd: toUsd(row.monthly_cap_usd),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

export async function GET(request: Request, deps: OperatorDeps = {}) {
  try {
    const query = spendLimitsQuery.parse(Object.fromEntries(new URL(request.url).searchParams));
    const admin = (deps.getSupabaseAdmin ?? getSupabaseAdmin)();
    if (!admin) throw new AppError(503, "storage_unavailable", "Workspace storage is unavailable.");

    const base = admin.from("workspace_spend_limits").select("*");
    const { data, error } = query.brand_key
      ? await base.eq("brand_key", query.brand_key).order("brand_key")
      : await base.order("brand_key");
    if (error) {
      throw new AppError(503, "spend_unavailable", "Spend control is unavailable, so paid work is paused.");
    }
    return jsonOk({ limits: ((data ?? []) as LimitRow[]).map(limitJson) });
  } catch (err) {
    return toErrorResponse(err);
  }
}
