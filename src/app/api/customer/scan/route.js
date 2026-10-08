import { NextResponse } from "next/server";
import { findCustomerBrand, getCustomerContext } from "@/lib/supabase/customer";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { createScanJob, hasActiveScanForBrand } from "@/lib/db";
import { DuplicateScanError } from "@/lib/duplicateScan";
import { keepAlive } from "@/lib/keepAlive";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

function fail(status, error) {
  return NextResponse.json({ error }, { status, headers: { "Cache-Control": "no-store" } });
}

export async function POST(request) {
  const context = await getCustomerContext();
  if (context.error === "auth_not_configured") return fail(503, "Customer login is not configured.");
  if (!context.user) return fail(401, "Please sign in to start a scan.");
  if (context.error) return fail(503, "Could not load your workspace access.");

  let body = {};
  try { body = await request.json(); } catch { /* ok */ }

  const key = body?.brand_key || context.brands[0]?.brandKey;
  const brand = findCustomerBrand(context.brands, key);
  if (!brand) return fail(404, "That brand is not assigned to your account.");

  // Use the workspace's website as the scan URL.
  const url = brand.website || "";
  const industry = (body?.industry || "").trim();
  const competitors = (body?.competitors || "").trim();

  // Check for duplicate active scan.
  const hasActive = await hasActiveScanForBrand(brand.display_name);
  if (hasActive) {
    return fail(409, "A scan is already running for this workspace. Please wait for it to complete.");
  }

  try {
    const job = await createScanJob({
      brand: brand.display_name,
      url,
      industry,
      competitors,
    });

    // Fire off the first chunk asynchronously.
    const { runScanChunk } = await import("@/lib/workers/scanWorker");
    keepAlive(() => runScanChunk(job.id));

    return NextResponse.json({
      job_id: job.id,
      brand: brand.display_name,
      status: "pending",
    }, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof DuplicateScanError) {
      return fail(409, "A scan is already running for this workspace.");
    }
    console.error(`[customer] scan creation failed for ${brand.brandKey}:`, error);
    return fail(500, "Could not start the scan. Please retry.");
  }
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

  const admin = getSupabaseAdmin();
  if (!admin) return fail(503, "Server is not configured.");

  try {
    const { data: scans, error } = await admin
      .from("scans")
      .select("id, brand, url, scanned_at, created_at, visibility_pct, prompts_tracked, prompts_mentioned, platform, raw_results")
      .ilike("brand", brand.display_name)
      .order("scanned_at", { ascending: false, nullsFirst: false })
      .limit(20);

    if (error) throw error;

    // Also get scan jobs.
    const { data: jobs } = await admin
      .from("scan_jobs")
      .select("id, brand, url, status, progress_pct, created_at, error_message")
      .ilike("brand", brand.display_name)
      .order("created_at", { ascending: false })
      .limit(10);

    return NextResponse.json({
      brand_key: brand.brandKey,
      scans: scans || [],
      jobs: jobs || [],
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error(`[customer] scan list failed for ${brand.brandKey}:`, error);
    return fail(500, "Could not load scans.");
  }
}