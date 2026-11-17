import { NextResponse } from "next/server";
import { findCustomerBrand, getCustomerContext } from "@/shared/supabase/customer";
import { getSupabaseAdmin } from "@/shared/supabase/admin";
import { listOAuthProperties } from "@/server/gsc/oauthFlow";

export const dynamic = "force-dynamic";

function fail(status, error) {
  return NextResponse.json({ error }, { status, headers: { "Cache-Control": "no-store" } });
}

export async function GET(request) {
  const context = await getCustomerContext();
  if (context.error === "auth_not_configured") return fail(503, "Customer login is not configured.");
  if (!context.user) return fail(401, "Please sign in.");
  if (context.error) return fail(503, "Could not load your workspace access.");

  const { searchParams } = new URL(request.url);
  const key = searchParams.get("brand_key") || context.brands[0]?.brandKey;
  const brand = findCustomerBrand(context.brands, key);
  if (!brand) return fail(404, "That brand is not assigned to your account.");

  if (brand.role !== "owner") return fail(403, "Only workspace owners can choose Google properties.");

  const admin = getSupabaseAdmin();
  if (!admin) return fail(503, "Server is not configured.");

  try {
    const properties = await listOAuthProperties({ brandKey: brand.brandKey, admin, attemptId: searchParams.get("attempt_id"), userId: context.user.id });
    return NextResponse.json({
      brand_key: brand.brandKey,
      properties,
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error(`[gsc-oauth] property list failed for ${brand.brandKey}:`, error);
    return fail(502, error.message || "Could not list Google Search Console properties.");
  }
}