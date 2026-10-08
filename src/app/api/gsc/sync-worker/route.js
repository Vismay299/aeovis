import { NextResponse } from "next/server";
import { supabase } from "@/lib/db.js";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { isCronAuthorized } from "@/lib/cronAuth.js";
import { ingestConnection } from "@/lib/gsc/ingest.js";

export const dynamic = "force-dynamic";

const LEASE_MS = 5 * 60 * 1000; // 5 minutes
const WORKER_ID = `gsc-sync-${process.env.VERCEL_REGION || "local"}-${Date.now()}`;

export async function GET(request) {
  const auth = isCronAuthorized(request);
  if (!auth.ok) {
    return NextResponse.json({ error: auth.message }, { status: 401 });
  }

  const admin = getSupabaseAdmin();
  if (!admin) {
    return NextResponse.json({ error: "Server is not configured." }, { status: 503 });
  }

  try {
    // Find pending sync jobs.
    const { data: pendingJobs, error: listError } = await admin
      .from("gsc_sync_jobs")
      .select("id, brand_key, connection_generation, sync_type")
      .eq("status", "pending")
      .order("created_at", { ascending: true })
      .limit(5);

    if (listError) throw new Error(`Failed to list sync jobs: ${listError.message}`);

    const results = [];
    for (const job of pendingJobs || []) {
      // Claim the job.
      const { data: claimed, error: claimError } = await admin
        .from("gsc_sync_jobs")
        .update({
          status: "running",
          lease_owner: WORKER_ID,
          lease_expires_at: new Date(Date.now() + LEASE_MS).toISOString(),
          started_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq("id", job.id)
        .eq("status", "pending")
        .select()
        .single();

      if (claimError || !claimed) {
        results.push({ job_id: job.id, status: "skipped", reason: "claimed_elsewhere" });
        continue;
      }

      // Get the connection details.
      const { data: conn } = await admin
        .from("gsc_connections")
        .select("*")
        .eq("brand_key", job.brand_key)
        .eq("connection_generation", job.connection_generation)
        .single();

      if (!conn?.enabled) {
        await admin.from("gsc_sync_jobs")
          .update({ status: "failed", error_message: "Connection is no longer active.", updated_at: new Date().toISOString() })
          .eq("id", job.id);
        results.push({ job_id: job.id, status: "failed", reason: "connection_inactive" });
        continue;
      }

      // Run the ingest.
      try {
        const outcome = await ingestConnection(conn, { admin });
        await admin.from("gsc_sync_jobs")
          .update({
            status: outcome.status === "ok" ? "completed" : "failed",
            completed_at: new Date().toISOString(),
            rows_written: outcome.rowsWritten,
            error_message: outcome.error,
            updated_at: new Date().toISOString(),
          })
          .eq("id", job.id);
        results.push({ job_id: job.id, status: outcome.status, rows_written: outcome.rowsWritten });
      } catch (ingestError) {
        await admin.from("gsc_sync_jobs")
          .update({
            status: "failed",
            error_message: String(ingestError.message || "").slice(0, 500),
            updated_at: new Date().toISOString(),
          })
          .eq("id", job.id);
        results.push({ job_id: job.id, status: "failed", error: ingestError.message });
      }
    }

    // Also run the regular incremental ingest for service-account connections.
    const { runGscIngest } = await import("@/lib/gsc/ingest.js");
    const saResult = await runGscIngest({ admin });

    return NextResponse.json({
      worker: WORKER_ID,
      oauth_jobs: results,
      service_account_ingest: saResult,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("[gsc-worker] sync failed:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}