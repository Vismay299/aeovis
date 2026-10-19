import { NextResponse } from "next/server";
import { findCustomerBrand, getCustomerContext } from "@/lib/supabase/customer";
import { getSupabaseAdmin } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

function fail(status, error) {
  return NextResponse.json({ error }, { status, headers: { "Cache-Control": "no-store" } });
}

export async function GET(request, { params }) {
  params = await params;
  const scanId = params?.scan_id;
  if (!scanId) return fail(400, "scan_id is required.");

  const context = await getCustomerContext();
  if (context.error === "auth_not_configured") return fail(503, "Customer login is not configured.");
  if (!context.user) return fail(401, "Please sign in.");
  if (context.error) return fail(503, "Could not load your workspace access.");

  const admin = getSupabaseAdmin();
  if (!admin) return fail(503, "Server is not configured.");

  try {
    const { data: scan, error } = await admin
      .from("scans")
      .select("*")
      .eq("id", scanId)
      .single();

    if (error || !scan) return fail(404, "Scan not found.");

    // Verify the scan belongs to one of the user's workspaces.
    const ownsBrand = context.brands.some((b) => b.brandKey === scan.brand_key);
    if (!ownsBrand) return fail(404, "Scan not found.");

    // Get prompt results for this scan.
    const { data: results, error: resultsError } = await admin
      .from("prompt_results")
      .select("id, query, engine, answer_text, answered, mentioned, brand_cited, position, sentiment, raw, created_at")
      .eq("scan_id", scanId)
      .order("created_at", { ascending: true });

    if (resultsError) throw resultsError;

    return NextResponse.json({
      scan: {
        id: scan.id,
        brand: scan.brand,
        url: scan.url,
        scanned_at: scan.scanned_at,
        created_at: scan.created_at,
        visibility_pct: scan.visibility_pct,
        summary_stats: scan.raw_results?.summary_stats ?? null,
        prompts_tracked: scan.prompts_tracked,
        prompts_mentioned: scan.prompts_mentioned,
        platform: scan.platform,
        engines: scan.raw_results?.engines || null,
        engine_scores: scan.raw_results?.engine_scores || null,
        competitors: scan.raw_results?.competitors || [],
        share_of_voice_pct: scan.raw_results?.share_of_voice_pct ?? null,
        win_rate_pct: scan.raw_results?.win_rate_pct ?? null,
        brand_citation_share_pct: scan.raw_results?.brand_citation_share_pct ?? null,
      },
      results: results || [],
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error(`[customer] scan report failed for ${scanId}:`, error);
    return fail(500, "Could not load the scan report.");
  }
}
