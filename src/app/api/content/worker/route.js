import { NextResponse } from "next/server";
import { supabase } from "@/lib/db";
import { listResumableContentJobs } from "@/lib/db/content";
import { startContentJob } from "@/lib/content/contentWorker";

// Side-effectful (spends real model budget) — must never run at build time.
export const dynamic = "force-dynamic";

/**
 * GET /api/content/worker — cron resume for pending/stuck content jobs.
 * Mirrors /api/scan/worker exactly.
 */
export async function GET() {
  if (!supabase) {
    return NextResponse.json({
      processed: 0,
      info: "No Supabase configured. Local in-memory worker runs automatically.",
    });
  }

  try {
    const jobs = await listResumableContentJobs(3);
    if (jobs.length === 0) {
      return NextResponse.json({ processed: 0, message: "No pending or stuck content jobs." });
    }

    const startedIds = [];
    for (const job of jobs) {
      startContentJob(job.id).catch((err) => {
        console.error(`[content-cron] Error processing job ${job.id}:`, err);
      });
      startedIds.push(job.id);
    }

    return NextResponse.json({ processed: startedIds.length, job_ids: startedIds });
  } catch (error) {
    console.error("Content cron worker error:", error);
    return NextResponse.json({ detail: "Internal Server Error" }, { status: 500 });
  }
}
