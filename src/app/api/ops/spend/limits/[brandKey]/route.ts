import type { SupabaseClient } from "@supabase/supabase-js";
import { AppError, jsonOk, readJsonBody, toErrorResponse } from "../../../../../../lib/http/errors.ts";
import { getSupabaseAdmin } from "../../../../../../lib/supabase/admin.js";
import { spendLimitsPutSchema } from "../../../../../../lib/spend/spend.contract.ts";

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

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ brandKey: string }> },
  deps: OperatorDeps = {}
) {
  try {
    const { brandKey } = await params;
    const body = spendLimitsPutSchema.parse(await readJsonBody(request));
    const admin = (deps.getSupabaseAdmin ?? getSupabaseAdmin)();
    if (!admin) throw new AppError(503, "storage_unavailable", "Workspace storage is unavailable.");

    const { data, error } = await admin
      .from("workspace_spend_limits")
      .upsert(
        {
          brand_key: brandKey,
          daily_cap_usd: body.dailyCapUsd,
          monthly_cap_usd: body.monthlyCapUsd,
          updated_by: "operator",
          updated_at: new Date().toISOString(),
        },
        { onConflict: "brand_key" }
      )
      .select("*")
      .single();
    if (error) {
      throw new AppError(503, "spend_unavailable", "Spend control is unavailable, so paid work is paused.");
    }
    return jsonOk(limitJson(data as LimitRow));
  } catch (err) {
    return toErrorResponse(err);
  }
}
