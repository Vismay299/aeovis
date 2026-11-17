import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/shared/supabase/admin";
import { isCronAuthorized } from "@/server/cronAuth.js";
import { processGscSyncJob, wakeGscWorker } from "@/server/gsc/syncJobs.js";
import crypto from "node:crypto";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const warnedNoSecret = { value: false };


export async function GET(request) {
  const WORKER_ID = crypto.randomUUID();
  if (!isCronAuthorized(request, new URL(request.url).searchParams, { label: "gsc-sync", warned: warnedNoSecret })) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  const admin = getSupabaseAdmin();
  if (!admin) {
    return NextResponse.json({ error: "Server is not configured." }, { status: 503 });
  }

  try {
    const { error: pruneError } = await admin.rpc("prune_expired_gsc_oauth_attempts");
    if (pruneError) throw new Error("Could not prune expired Google authorizations.");
    const { error: enqueueError } = await admin.rpc("enqueue_customer_gsc_syncs");
    if (enqueueError) throw new Error("Could not schedule incremental Google syncs.");
    // Find pending sync jobs.
    const { data: pendingJobs, error: listError } = await admin
      .from("gsc_sync_jobs")
      .select("id, brand_key, connection_generation, sync_type")
      .or(`status.eq.pending,and(status.eq.running,lease_expires_at.lt.${new Date().toISOString()})`)
      .order("created_at", { ascending: true })
      .limit(5);

    if (listError) throw new Error(`Failed to list sync jobs: ${listError.message}`);

    const results = [];
    for (const job of pendingJobs || []) {
      // Claim the job.
      const { data: claims, error: claimError } = await admin.rpc("claim_customer_gsc_job", {
        p_job_id: job.id, p_worker: WORKER_ID,
      });
      const claimed = claims?.[0];

      if (claimError || !claimed) {
        results.push({ job_id: job.id, status: "skipped", reason: "claimed_elsewhere" });
        continue;
      }

      // Get the connection details.
      const { data: conn, error: connError } = await admin
        .from("gsc_connections")
        .select("*")
        .eq("brand_key", job.brand_key)
        .eq("connection_generation", job.connection_generation)
        .single();

      if (connError && connError.code !== "PGRST116") throw new Error("Could not read GSC connection.");
      if (!conn?.enabled) {
        await admin.from("gsc_sync_jobs")
          .update({ status: "failed", error_message: "Connection is no longer active.", updated_at: new Date().toISOString() })
          .eq("id", job.id).eq("status", "running").eq("lease_owner", WORKER_ID);
        results.push({ job_id: job.id, status: "failed", reason: "connection_inactive" });
        continue;
      }

      // Run the ingest.
      try {
        const outcome = await processGscSyncJob(claimed, conn, { admin, workerId: WORKER_ID });
        results.push({ job_id: job.id, ...outcome });
      } catch (ingestError) {
        await admin.from("gsc_sync_jobs")
          .update({
            status: claimed.attempts < claimed.max_attempts ? "pending" : "failed",
            lease_owner: null, lease_expires_at: null,
            error_message: String(ingestError.message || "").slice(0, 500),
            updated_at: new Date().toISOString(),
          })
          .eq("id", job.id).eq("status", "running").eq("lease_owner", WORKER_ID);
        results.push({ job_id: job.id, status: "failed", error: ingestError.message });
      }
    }

    const continuation = results.find((r) => r.status === "pending");
    if (continuation) wakeGscWorker(continuation.job_id);
    return NextResponse.json({
      worker: WORKER_ID,
      oauth_jobs: results,

      timestamp: new Date().toISOString(),
    }, { status: results.some((r) => r.status === "failed") ? 500 : 200 });
  } catch (error) {
    console.error("[gsc-worker] sync failed:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}