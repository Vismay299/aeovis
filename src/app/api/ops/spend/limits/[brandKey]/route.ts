import type { SupabaseClient } from "@supabase/supabase-js";
import { AppError, jsonOk, readJsonBody, toErrorResponse } from "../../../../../../lib/http/errors.ts";
import { getSupabaseAdmin } from "../../../../../../lib/supabase/admin.js";
import { brandKeyParamSchema, spendLimitsPutSchema } from "../../../../../../lib/spend/spend.contract.ts";

export const dynamic = "force-dynamic";

type OperatorDeps = { getSupabaseAdmin?: () => SupabaseClient | null };

type LimitRow = {
  brand_key: string;
  daily_cap_usd: number | string | null;
  monthly_cap_usd: number | string | null;
  updated_at: string;
};

const SPEND_UNAVAILABLE = "Spend control is unavailable, so paid work is paused.";

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
    // The path key is a URL segment, so it is bounded before the body is read
    // and before any database call: a zod failure becomes 400 invalid_request.
    const { brandKey: pathBrandKey } = await params;
    const brandKey = brandKeyParamSchema.parse(pathBrandKey);
    const body = spendLimitsPutSchema.parse(await readJsonBody(request));
    const admin = (deps.getSupabaseAdmin ?? getSupabaseAdmin)();
    if (!admin) throw new AppError(503, "storage_unavailable", "Workspace storage is unavailable.");

    // A limit row has a foreign key to customer_brands, so an unknown workspace
    // must be a 404 rather than the 503 outage an upsert error would become.
    const { data: brand, error: brandError } = await admin
      .from("customer_brands")
      .select("brand_key")
      .eq("brand_key", brandKey)
      .maybeSingle();
    if (brandError) {
      throw new AppError(503, "spend_unavailable", SPEND_UNAVAILABLE);
    }
    if (!brand) {
      throw new AppError(404, "workspace_not_found", "Workspace not found.");
    }

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
      // 23503 is a foreign-key violation: the brand disappeared between the
      // check above and this write, which is the same 404 to the caller.
      if ((error as { code?: string }).code === "23503") {
        throw new AppError(404, "workspace_not_found", "Workspace not found.");
      }
      throw new AppError(503, "spend_unavailable", SPEND_UNAVAILABLE);
    }
    return jsonOk(limitJson(data as LimitRow));
  } catch (err) {
    return toErrorResponse(err);
  }
}
