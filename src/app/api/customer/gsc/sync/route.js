import { NextResponse } from "next/server";
import { findCustomerBrand, getCustomerContext } from "@/lib/supabase/customer";
import { getSupabaseAdmin } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

function fail(status, error) {
  return NextResponse.json({ error }, { status, headers: { "Cache-Control": "no-store" } });
}

export async function POST(request) {
  let body = {};
  try { body = await request.json(); } catch { /* ok */ }

  const context = await getCustomerContext();
  if (context.error === "auth_not_configured") return fail(503, "Customer login is not configured.");
  if (!context.user) return fail(401, "Please sign in.");
  if (context.error) return fail(503, "Could not load your workspace access.");

  const key = body?.brand_key || context.brands[0]?.brandKey;
  const brand = findCustomerBrand(context.brands, key);
  if (!brand) return fail(404, "That brand is not assigned to your account.");
  if (brand.role !== "owner") return fail(403, "Only workspace owners can trigger sync.");

  const admin = getSupabaseAdmin();
  if (!admin) return fail(503, "Server is not configured.");

  try {
    // Check for an existing active connection.
    const { data: conn } = await admin
      .from("gsc_connections")
      .select("connection_generation, enabled")
      .eq("brand_key", brand.brandKey)
      .single();

    if (!conn?.enabled) return fail(409, "No active Google Search Console connection.");

    // Check for an already-running or pending sync job.
    const { data: existingJob } = await admin
      .from("gsc_sync_jobs")
      .select("id, status")
      .eq("brand_key", brand.brandKey)
      .in("status", ["pending", "running"])
      .limit(1);

    if (existingJob?.length) {
      return NextResponse.json({
        queued: false,
        message: "A sync is already in progress.",
        job: existingJob[0],
      });
    }

    // Queue a manual sync job.
    const { data: job, error: jobError } = await admin
      .from("gsc_sync_jobs")
      .insert({
        brand_key: brand.brandKey,
        connection_generation: conn.connection_generation,
        sync_type: "manual",
      })
      .select("id, status, created_at")
      .single();

    if (jobError) throw new Error(`Failed to queue sync: ${jobError.message}`);

    return NextResponse.json({ queued: true, job }, { status: 201 });
  } catch (error) {
    console.error(`[gsc-sync] trigger failed for ${brand.brandKey}:`, error);
    return fail(500, error.message || "Could not start sync.");
  }
}