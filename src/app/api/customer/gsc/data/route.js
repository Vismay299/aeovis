import { NextResponse } from "next/server";
import { findCustomerBrand, getCustomerContext } from "@/lib/supabase/customer";
import { getSupabaseAdmin } from "@/lib/supabase/admin";

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

  const days = Math.min(parseInt(searchParams.get("days") || "30", 10) || 30, 90);
  const limit = Math.min(parseInt(searchParams.get("limit") || "100", 10) || 100, 1000);
  const offset = Math.max(parseInt(searchParams.get("offset") || "0", 10) || 0, 0);

  const admin = getSupabaseAdmin();
  if (!admin) return fail(503, "Server is not configured.");

  try {
    // Get the active connection and generation.
    const { data: conn } = await admin
      .from("gsc_connections")
      .select("connection_generation, enabled, site_url, last_ingested_through")
      .eq("brand_key", brand.brandKey)
      .single();

    if (!conn?.enabled) {
      return NextResponse.json({
        brand_key: brand.brandKey,
        connected: false,
        data: [],
        totals: null,
      });
    }

    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate - days);
    const cutoff = cutoffDate.toISOString().slice(0, 10);

    // Query gsc_daily scoped by brand_key and generation.
    const { data: rows, error } = await admin
      .from("gsc_daily")
      .select("date, query, clicks, impressions, ctr, position")
      .eq("brand_key", brand.brandKey)
      .eq("connection_generation", conn.connection_generation)
      .gte("date", cutoff)
      .order("date", { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) throw new Error(`Failed to read GSC data: ${error.message}`);

    // Compute totals from the returned rows.
    const totals = (rows || []).reduce(
      (acc, r) => {
        acc.clicks += r.clicks || 0;
        acc.impressions += r.impressions || 0;
        return acc;
      },
      { clicks: 0, impressions: 0 }
    );
    if (totals.impressions > 0) {
      totals.ctr = totals.clicks / totals.impressions;
    }
    // Note: average position from query-dimension data omits anonymized queries.
    // Label as query-data totals, not property totals.
    const positions = (rows || []).filter((r) => r.position > 0);
    totals.avg_position = positions.length > 0
      ? positions.reduce((s, r) => s + r.position, 0) / positions.length
      : null;
    totals.note = "Query totals exclude anonymized queries. Average position is from available query data only.";

    return NextResponse.json({
      brand_key: brand.brandKey,
      connected: true,
      property: conn.site_url,
      data_through: conn.last_ingested_through,
      days,
      data: rows || [],
      totals,
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error(`[gsc-data] read failed for ${brand.brandKey}:`, error);
    return fail(500, error.message || "Could not read GSC data.");
  }
}