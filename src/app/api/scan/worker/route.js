import { NextResponse } from "next/server";
import { waitUntil } from "@vercel/functions";
import { getSupabase } from "@/lib/db";
import { startScanJob } from "@/lib/workers/scanWorker";

// Never prerender — this route must not run during `next build`.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
// Hobby plan max is 60s; scans are resumed via cron / client status polls.
export const maxDuration = 60;

export async function GET(request) {
  // Guard against accidental static generation / build-time execution
  if (process.env.NEXT_PHASE === "phase-production-build") {
    return NextResponse.json({ processed: 0, info: "Skipped during build." });
  }

  if (!getSupabase()) {
    return NextResponse.json({
      processed: 0,
      info: "No Supabase configured. Local in-memory worker runs automatically.",
    });
  }

  try {
    const { data: activeJobs, error } = await getSupabase()
      .from("scan_jobs")
      .select("*")
      .not("status", "in", '("complete","failed")')
      .order("created_at", { ascending: true })
      .limit(10);

    if (error) {
      throw error;
    }

    const twoMinutesAgo = Date.now() - 2 * 60 * 1000;
    const pendingOrStuckJobs = (activeJobs || [])
      .filter((job) => {
        if (job.status === "pending") return true;
        // Resume anything still open after 2 minutes without completion
        const createdTime = new Date(job.created_at).getTime();
        return createdTime < twoMinutesAgo;
      })
      .slice(0, 1);

    if (pendingOrStuckJobs.length === 0) {
      return NextResponse.json({
        processed: 0,
        message: "No pending or stuck jobs found.",
      });
    }

    const startedIds = [];
    for (const job of pendingOrStuckJobs) {
      const work = startScanJob(
        job.id,
        job.brand,
        job.url || "",
        job.industry || "",
        job.competitors || ""
      ).catch((err) => {
        console.error(`[cron-worker] Error processing job ${job.id}:`, err);
      });
      try {
        waitUntil(work);
      } catch {
        // Fall back to await so local/dev still makes progress
        await work;
      }
      startedIds.push(job.id);
    }

    return NextResponse.json({ processed: startedIds.length, job_ids: startedIds });
  } catch (error) {
    console.error("Cron worker route error:", error);
    return NextResponse.json({ detail: "Internal Server Error" }, { status: 500 });
  }
}
