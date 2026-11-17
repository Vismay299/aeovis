import type { SupabaseClient } from "@supabase/supabase-js";
import { AppError, jsonOk, readJsonBody, toErrorResponse } from "../../../../../../shared/http/errors.ts";
import { getSupabaseAdmin } from "../../../../../../shared/supabase/admin.js";
import { invalidateFeatureFlagCache } from "../../../../../../server/features/flags.ts";
import { isSpendFeature } from "../../../../../../shared/spend/features.ts";
import { spendControlPutSchema } from "../../../../../../shared/spend/spend.contract.ts";

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

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ feature: string }> },
  deps: OperatorDeps = {}
) {
  try {
    const { feature } = await params;
    if (!isSpendFeature(feature)) {
      throw new AppError(404, "unknown_spend_feature", "That paid feature is not registered.");
    }
    const body = spendControlPutSchema(feature).parse(await readJsonBody(request));
    const admin = (deps.getSupabaseAdmin ?? getSupabaseAdmin)();
    if (!admin) throw new AppError(503, "storage_unavailable", "Workspace storage is unavailable.");

    const { data, error } = await admin
      .from("paid_feature_controls")
      .upsert(
        {
          feature,
          enabled: body.enabled,
          mode: body.mode,
          brand_allowlist: body.brandAllowlist,
          daily_cap_usd: body.dailyCapUsd,
          max_call_usd: body.maxCallUsd,
          note: body.note,
          updated_by: "operator",
          updated_at: new Date().toISOString(),
        },
        { onConflict: "feature" }
      )
      .select("*")
      .single();
    if (error) {
      throw new AppError(503, "spend_unavailable", "Spend control is unavailable, so paid work is paused.");
    }

    // The flag cache memoizes this table's answer for 30 s, so a feature just enabled
    // here would otherwise stay off for the rest of the window.
    invalidateFeatureFlagCache();
    console.log("[ops] spend control changed", { feature, enabled: body.enabled });
    return jsonOk(controlJson(data as ControlRow));
  } catch (err) {
    return toErrorResponse(err);
  }
}
