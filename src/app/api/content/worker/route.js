import { NextResponse } from "next/server";
import { isCronAuthorized } from "@/lib/cronAuth";
import { recordCronTick } from "@/lib/db/analytics";
import { supabase } from "@/lib/db";
import { listResumableContentJobs } from "@/lib/db/content";
import { acquireLease, newLeaseOwner } from "@/lib/jobLease";
import { startContentJob } from "@/lib/content/contentWorker";
import { createDailyBatchJobs, getDailyBatchSize } from "@/lib/content/dailyBatch";

// Side-effectful (spends real model budget) — must never run at build time.
export const dynamic = "force-dynamic";

// Mirrors /api/scan/worker: a resumed content job runs a full block pipeline
// and needs the same headroom as the route that first started it (D3).
export const maxDuration = 300;

const MAX_CONCURRENT_RESUMES = 3;

// Boxed so the shared gate can flip it; one warning per process per route.
const warnedNoSecret = { value: false };

/**
 * Cron/worker auth — mirrors /api/scan/worker's isAuthorized exactly (D2).
 *
 * This endpoint resumes content jobs AND, with `?batch=1`, CREATES new ones,
 * each spending real model budget against CONTENT_MAX_COST_PER_ITEM.
 * Unauthenticated it is a free "burn the owner's model budget" button — the
 * scan worker was sealed for precisely this reason (reviewer D4) and this route
 * was left open.
 *
 * When CRON_SECRET is set (production), a caller must present it as
 * `Authorization: Bearer <secret>`, `x-cron-secret: <secret>`, or `?secret=`.
 * The secret is the only credential — the client-settable `x-vercel-cron`
 * header no longer grants access (R0.1.8); Vercel's own cron invocations
 * authenticate with the bearer secret. When CRON_SECRET is unset the gate FAILS CLOSED in
 * production (401) and allows-with-a-warning everywhere else. The
 * implementation is shared with /api/scan/worker in src/lib/cronAuth.js so the
 * two cannot drift.
 */
function isAuthorized(request, searchParams) {
  return isCronAuthorized(request, searchParams, { label: "content-cron", warned: warnedNoSecret });
}

/**
 * Take the lease, then dispatch. Returns the lease owner if we won the job,
 * else null. This is the single-flight gate (D1): before this, the cron fired
 * startContentJob() fire-and-forget with no exclusivity, so two overlapping
 * invocations both ran the same job — two executions racing one row, each
 * spending up to the full per-item cap and each inserting a content_items row.
 */
async function dispatchWithLease(jobId, label) {
  const owner = newLeaseOwner("cron");
  let won = null;
  try {
    won = await acquireLease("content_jobs", jobId, owner);
  } catch (err) {
    // Fail CLOSED: if we cannot prove we hold the lease, we must not spend.
    console.error(`[content-cron] lease acquire failed for ${label} ${jobId}:`, err.message);
    return null;
  }
  if (!won) {
    console.log(`[content-cron] ${label} ${jobId} is leased by another worker — skipping`);
    return null;
  }

  startContentJob(jobId, { leaseOwner: owner }).catch((err) => {
    console.error(`[content-cron] Error processing ${label} ${jobId}:`, err);
  });
  return owner;
}

/**
 * GET /api/content/worker — cron for the content pipeline. Two jobs:
 *   1. Rescue content jobs whose worker died (heartbeat stale + lease free).
 *   2. If CONTENT_DAILY_BATCH>0 and ?batch=1 (daily cadence), enqueue up to
 *      n geo_article jobs from the worst gaps of each brand's latest scan.
 *
 * The batch is gated behind an explicit query param so the frequent resume
 * cron doesn't create jobs every few minutes — a separate daily schedule
 * hits `?batch=1`.
 */
export async function GET(request) {
  const { searchParams } = new URL(request.url);

  if (!isAuthorized(request, searchParams)) {
    return NextResponse.json({ detail: "Unauthorized." }, { status: 401 });
  }

  // R0.1.7: record the tick AFTER the auth gate, so a rejected request never
  // makes a dead cron look alive on /api/health. Non-fatal by design.
  await recordCronTick("content-worker");

  if (!supabase) {
    return NextResponse.json({
      processed: 0,
      info: "No Supabase configured. Local in-memory worker runs automatically.",
    });
  }

  try {
    const runBatch = searchParams.get("batch") === "1";

    // 1. Rescue jobs whose worker is presumed dead. A job with a fresh
    //    heartbeat or a live lease is presumed actively worked and skipped.
    const jobs = await listResumableContentJobs(MAX_CONCURRENT_RESUMES);
    const startedIds = [];
    const skippedIds = [];
    for (const job of jobs) {
      const owner = await dispatchWithLease(job.id, "job");
      if (owner) startedIds.push(job.id);
      else skippedIds.push(job.id);
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
            const owner = await dispatchWithLease(job.id, "batch job");
            if (owner) batchCreated.push(job.id);
          }
        } catch (err) {
          console.warn(`[content-cron] batch for ${brand} failed:`, err.message);
        }
      }
    }

    return NextResponse.json({
      resumed: startedIds.length,
      resumed_ids: startedIds,
      skipped_leased: skippedIds.length,
      batch_created: batchCreated.length,
      batch_ids: batchCreated,
    });
  } catch (error) {
    console.error("Content cron worker error:", error);
    return NextResponse.json({ detail: "Internal Server Error" }, { status: 500 });
  }
}
