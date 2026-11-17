import { NextResponse } from "next/server";
import { findCustomerBrand, getCustomerContext } from "@/shared/supabase/customer";
import { getSupabaseAdmin } from "@/shared/supabase/admin";
import { disconnectGsc, isGscOAuthConfigured } from "@/server/gsc/oauthFlow";

export const dynamic = "force-dynamic";

async function requireCustomerBrand(request, explicitKey) {
  const context = await getCustomerContext();
  if (context.error === "auth_not_configured") {
    return { response: NextResponse.json({ error: "Customer login is not configured on this deployment." }, { status: 503 }) };
  }
  if (!context.user) return { response: NextResponse.json({ error: "Please sign in to connect Search Console." }, { status: 401 }) };
  if (context.error) return { response: NextResponse.json({ error: "Your workspace access could not be loaded." }, { status: 503 }) };
  const key = explicitKey || new URL(request.url).searchParams.get("brand_key") || context.brands[0]?.brandKey;
  const brand = findCustomerBrand(context.brands, key);
  if (!brand) return { response: NextResponse.json({ error: "That brand is not assigned to your account." }, { status: 404 }) };
  return { context, brand };
}

export async function GET(request) {
  const { context, brand, response } = await requireCustomerBrand(request);
  if (response) return response;
  try {
    const { data, error } = await context.client
      .from("gsc_connections")
      .select("brand_key, site_url, enabled, auth_mode, connected_at, last_attempt_at, last_status, last_error, last_rows_written, last_ingested_through, permission_level, connection_generation")
      .eq("brand_key", brand.brandKey)
      .maybeSingle();
    if (error) throw error;
    return NextResponse.json({
      brand_key: brand.brandKey,
      connected: !!data?.enabled,
      connection: data || null,
      oauth_configured: isGscOAuthConfigured(),
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error(`[customer] GSC status read failed for ${brand.brandKey}:`, error);
    return NextResponse.json({ error: "Could not read the Search Console connection." }, { status: 500 });
  }
}

export async function DELETE(request) {
  let body = {};
  try { body = await request.json(); } catch { /* ok */ }

  const { context, brand, response } = await requireCustomerBrand(request, body?.brand_key);
  if (response) return response;

  if (brand.role !== "owner") {
    return NextResponse.json({ error: "Only workspace owners can disconnect Google Search Console." }, { status: 403 });
  }

  const admin = getSupabaseAdmin();
  if (!admin) {
    return NextResponse.json({ error: "Server is not configured." }, { status: 503 });
  }

  try {
    const result = await disconnectGsc({ brandKey: brand.brandKey, userId: context.user.id, admin });
    return NextResponse.json(result);
  } catch (error) {
    console.error(`[gsc-oauth] disconnect failed for ${brand.brandKey}:`, error);
    return NextResponse.json({ error: "Could not disconnect Google Search Console." }, { status: 500 });
  }
}