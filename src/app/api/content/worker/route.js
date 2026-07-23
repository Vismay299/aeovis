import { NextResponse } from "next/server";
import { supabase } from "@/lib/db";
import { listResumableContentJobs } from "@/lib/db/content";
import { startContentJob } from "@/lib/content/contentWorker";
import { createDailyBatchJobs, getDailyBatchSize } from "@/lib/content/dailyBatch";

// Side-effectful (spends real model budget) — must never run at build time.
export const dynamic = "force-dynamic";

/**
 * GET /api/content/worker — cron for the content pipeline. Two jobs:
 *   1. Resume pending/stuck content jobs (mirrors /api/scan/worker).
 *   2. If CONTENT_DAILY_BATCH>0 and ?batch=1 (daily cadence), enqueue up to
 *      n geo_article jobs from the worst gaps of each brand's latest scan.
 *
 * The batch is gated behind an explicit query param so the frequent resume
 * cron doesn't create jobs every few minutes — a separate daily schedule
 * hits `?batch=1`.
 */
export async function GET(request) {
  if (!supabase) {
    return NextResponse.json({
      processed: 0,
      info: "No Supabase configured. Local in-memory worker runs automatically.",
    });
  }

  try {
    const { searchParams } = new URL(request.url);
    const runBatch = searchParams.get("batch") === "1";

    // 1. Resume in-flight jobs.
    const jobs = await listResumableContentJobs(3);
    const startedIds = [];
    for (const job of jobs) {
      startContentJob(job.id).catch((err) => {
        console.error(`[content-cron] Error processing job ${job.id}:`, err);
      });
      startedIds.push(job.id);
    }

    // 2. Daily batch (opt-in).
    const batchCreated = [];
    if (runBatch && getDailyBatchSize() > 0) {
      const { data: brandsRows } = await supabase
        .from("scans")
        .select("brand")
        .order("scanned_at", { ascending: false })
        .limit(200);
      const brands = Array.from(
        new Set((brandsRows || []).map((r) => r.brand).filter(Boolean))
      );
      for (const brand of brands) {
        try {
          const created = await createDailyBatchJobs(brand);
          for (const job of created) {
            batchCreated.push(job.id);
            startContentJob(job.id).catch((err) =>
              console.error(`[content-cron] batch job ${job.id} failed:`, err)
            );
          }
        } catch (err) {
          console.warn(`[content-cron] batch for ${brand} failed:`, err.message);
        }
      }
    }

    return NextResponse.json({
      resumed: startedIds.length,
      resumed_ids: startedIds,
      batch_created: batchCreated.length,
      batch_ids: batchCreated,
    });
  } catch (error) {
    console.error("Content cron worker error:", error);
    return NextResponse.json({ detail: "Internal Server Error" }, { status: 500 });
  }
}
