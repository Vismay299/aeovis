import { NextResponse } from "next/server";
import { isCronAuthorized } from "@/lib/cronAuth";
import { supabase } from "@/lib/db";
import { runScanChunk, runSchedulerTick, shouldRescueJob } from "@/lib/workers/scanWorker";

// This route has side effects (it resumes real scans and, via the scheduler
// tick, can create new ones). Without force-dynamic, Next prerenders it
// during `next build` and actually executes the handler.
export const dynamic = "force-dynamic";

// Mirrors the POST /api/scan route: a resumed chunk needs the same headroom.
export const maxDuration = 300;

const MAX_CONCURRENT_RESUMES = 3;

// Boxed so the shared gate can flip it; one warning per process per route.
const warnedNoSecret = { value: false };

/**
 * Cron/worker auth (reviewer D4). This endpoint resumes scans AND — via the
 * scheduler tick — can CREATE new ones, each costing real Bright Data + LLM
 * spend. Unauthenticated it is a free "burn the owner's API budget" button,
 * and the `?job_id=` branch resumes an arbitrary job.
 *
 * When CRON_SECRET is set (production), a caller must present it as
 * `Authorization: Bearer <secret>`, `x-cron-secret: <secret>`, or `?secret=`.
 * Vercel's own cron invocations are also accepted via the `x-vercel-cron`
 * header they inject. When CRON_SECRET is unset the gate FAILS CLOSED in
 * production (401) and allows-with-a-warning everywhere else, so dev and the
 * self-continue fetch keep working. The implementation is shared with
 * /api/content/worker in src/lib/cronAuth.js so the two cannot drift.
 */
function isAuthorized(request, searchParams) {
  return isCronAuthorized(request, searchParams, { label: "worker", warned: warnedNoSecret });
}

export async function GET(request) {
  const { searchParams } = new URL(request.url);

  if (!isAuthorized(request, searchParams)) {
    return NextResponse.json({ detail: "Unauthorized." }, { status: 401 });
  }

  const directJobId = searchParams.get("job_id");

  // Self-continue path (scanWorker.js's fire-and-forget self-continue fetch,
  // fired when a chunk hits its soft time budget with work still remaining):
  // resume THIS SPECIFIC job right now, unconditionally. The staleness sweep
  // below intentionally does NOT cover this case — the chunk that just fired
  // this request also just heartbeated, so isJobAlive would report it fresh
  // and the sweep would (correctly, for its own purpose) skip it.
  if (directJobId) {
    try {
      await runScanChunk(directJobId);
      return NextResponse.json({ processed: 1, job_id: directJobId, mode: "direct-resume" });
    } catch (error) {
      console.error(`[worker] Direct resume of job ${directJobId} failed:`, error);
      return NextResponse.json({ detail: "Internal Server Error" }, { status: 500 });
    }
  }

  if (!supabase) {
    return NextResponse.json({ processed: 0, info: "No Supabase configured. Local in-memory worker runs automatically." });
  }

  try {
    // Retrieve every not-yet-finished job; staleness (not a fixed 5-minute
    // created_at window) decides which ones actually need a rescue kick —
    // a job with a fresh heartbeat is presumed to be actively worked by
    // another invocation (single-flight via isJobAlive, no in-process lock).
    const { data: activeJobs, error } = await supabase
      .from("scan_jobs")
      .select("*")
      .not("status", "in", '("complete","failed")')
      .limit(20);

    if (error) {
      throw error;
    }

    const toResume = (activeJobs || []).filter((job) => shouldRescueJob(job)).slice(0, MAX_CONCURRENT_RESUMES);

    const resumedIds = [];
    for (const job of toResume) {
      // RESUME, never restart: runScanChunk reads job.checkpoint and
      // prompt_results itself — it never re-sources prompts or re-probes an
      // already-persisted (engine, query) pair.
      runScanChunk(job.id).catch(err => {
        console.error(`[cron-worker] Error resuming job ${job.id}:`, err);
      });
      resumedIds.push(job.id);
    }

    // Scheduler tick: enqueue new scans for any brand whose cadence is due
    // and isn't already running.
    let scheduled = [];
    try {
      const tickResult = await runSchedulerTick(new Date().toISOString());
      scheduled = tickResult.started;
    } catch (err) {
      console.error("[worker] Scheduler tick failed:", err);
    }

    return NextResponse.json({ processed: resumedIds.length, job_ids: resumedIds, scheduled });
  } catch (error) {
    console.error("Cron worker route error:", error);
    return NextResponse.json({ detail: "Internal Server Error" }, { status: 500 });
  }
}
