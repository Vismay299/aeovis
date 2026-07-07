import { NextResponse } from "next/server";
import { supabase } from "@/lib/db";
import { startScanJob } from "@/lib/workers/scanWorker";

export async function GET(request) {
  if (!supabase) {
    return NextResponse.json({ processed: 0, info: "No Supabase configured. Local in-memory worker runs automatically." });
  }

  try {
    // Retrieve active (incomplete) jobs to process
    const { data: activeJobs, error } = await supabase
      .from("scan_jobs")
      .select("*")
      .not("status", "in", '("complete","failed")')
      .limit(10);

    if (error) {
      throw error;
    }

    const fiveMinutesAgo = Date.now() - 5 * 60 * 1000;
    const pendingOrStuckJobs = (activeJobs || []).filter(job => {
      if (job.status === "pending") return true;
      const createdTime = new Date(job.created_at).getTime();
      return createdTime < fiveMinutesAgo;
    }).slice(0, 3); // Limit to processing 3 parallel jobs max per cron run

    if (pendingOrStuckJobs.length === 0) {
      return NextResponse.json({ processed: 0, message: "No pending or stuck jobs found." });
    }

    const startedIds = [];
    for (const job of pendingOrStuckJobs) {
      startScanJob(
        job.id,
        job.brand,
        job.url || "",
        job.industry || "",
        job.competitors || "",
        job.query_source || "llm_generated",
        job.gsc_queries || []
      ).catch(err => {
        console.error(`[cron-worker] Error processing job ${job.id}:`, err);
      });
      startedIds.push(job.id);
    }

    return NextResponse.json({ processed: startedIds.length, job_ids: startedIds });
  } catch (error) {
    console.error("Cron worker route error:", error);
    return NextResponse.json({ detail: "Internal Server Error" }, { status: 500 });
  }
}
