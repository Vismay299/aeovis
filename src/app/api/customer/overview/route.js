import { NextResponse } from "next/server";
import { findCustomerBrand, getCustomerContext } from "@/shared/supabase/customer";
import { isFeatureEnabled } from "@/server/features/flags.ts";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

function fail(status, error) {
  return NextResponse.json({ error }, { status, headers: { "Cache-Control": "no-store" } });
}

export async function GET(request) {
  const context = await getCustomerContext();
  if (context.error === "auth_not_configured") return fail(503, "Customer login is not configured on this deployment.");
  if (!context.user) return fail(401, "Please sign in to view your workspace.");
  if (context.error) {
    console.error("[customer] membership lookup failed:", context.cause);
    return fail(503, "Your workspace access could not be loaded. Please try again.");
  }

  const { searchParams } = new URL(request.url);
  const brand = findCustomerBrand(context.brands, searchParams.get("brand_key") || context.brands[0]?.brandKey);
  if (!brand) return fail(404, "That brand is not assigned to your account.");

  try {
    const client = context.client;
    const [scansResult, jobsResult, metricsResult, contentResult] = await Promise.all([
      client.from("scans")
        .select("id, brand, url, scanned_at, created_at, visibility_pct, prompts_tracked, prompts_mentioned, platform")
        .eq("brand_key", brand.brandKey)
        .order("scanned_at", { ascending: false, nullsFirst: false })
        .limit(100),
      client.from("scan_jobs")
        .select("id, brand, url, status, progress_pct, created_at")
        .eq("brand_key", brand.brandKey)
        .order("created_at", { ascending: false })
        .limit(100),
      client.from("brand_metrics_daily")
        .select("date, engine, visibility_pct, sov_pct, citation_share_pct, prompts_total, prompts_answered, prompts_mentioned")
        .eq("brand", brand.brandKey)
        .order("date", { ascending: false })
        .limit(30),
      client.from("content_items")
        .select("id, brand, title, status, updated_at, created_at")
        .eq("brand", brand.brandKey)
        .order("updated_at", { ascending: false })
        .limit(100),
    ]);

    const failed = [scansResult, jobsResult, metricsResult, contentResult].find((result) => result.error);
    if (failed) throw failed.error;

    const scans = (scansResult.data || []).slice(0, 10);
    const jobs = (jobsResult.data || []).slice(0, 10);
    const contentItems = (contentResult.data || []).slice(0, 10);

    return NextResponse.json({
      brand: { brand_key: brand.brandKey, display_name: brand.display_name, website: brand.website },
      latest_scan: scans[0] || null,
      scans,
      scan_jobs: jobs,
      metrics: metricsResult.data || [],
      content_items: contentItems,
      features: {
        prompt_explorer: await isFeatureEnabled("prompt_explorer", brand.brandKey),
      },
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error(`[customer] overview query failed for ${brand.brandKey}:`, error);
    return fail(500, "Could not load your workspace data.");
  }
}
