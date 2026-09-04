import { NextResponse } from "next/server";
import { isCronAuthorized } from "@/lib/cronAuth";
import { recordCronTick } from "@/lib/db/analytics";
import { supabase } from "@/lib/db";
import { chunkRunOutcome, runScanChunk, runSchedulerTick, shouldRescueJob } from "@/lib/workers/scanWorker";
import { RUN_OUTCOMES } from "@/lib/scanRuns";

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
 * The secret is the only credential — the client-settable `x-vercel-cron`
 * header no longer grants access (R0.1.8); Vercel's own cron invocations
 * authenticate with the bearer secret. When CRON_SECRET is unset the gate FAILS CLOSED in
 * production (401) and allows-with-a-warning everywhere else, so dev and the
 * self-continue fetch keep working. The implementation is shared with
 * /api/content/worker in src/lib/cronAuth.js so the two cannot drift.
 */
function isAuthorized(request, searchParams) {
  return isCronAuthorized(request, searchParams, { label: "worker", warned: warnedNoSecret });
}

/**
 * R3.1.3 — what runScanChunk actually did, in the three words the wire needs.
 *
 * The old code answered `{processed: 1}` for every direct resume, including the
 * ones where runScanChunk returned `{ok:false, reason:"read_failed"}` after
 * failing to even read the job. A chunk that did nothing was indistinguishable
 * from one that carried a scan to completion, on the route the cron drives
 * daily. Standing rule 1: a skip is not a success.
 *
 * The mapping is NOT re-derived here. `chunkRunOutcome` is the pure function
 * that already turns a chunk result into the scan_runs ledger row (succeeded /
 * skipped / noop / failed), so the response and the ledger cannot disagree
 * about the same execution, and a reason added to runScanChunk later lands in
 * exactly one place. Its default branch closes an unrecognised reason as
 * FAILED with `unmapped_chunk_reason:<x>` rather than rounding up to success,
 * which is the behaviour this route wants too.
 *
 * Ledger outcome -> wire bucket, and why:
 *   succeeded (complete, checkpointed)                  -> processed
 *       The chunk did the work it was asked to do. `checkpointed` counts: it
 *       probed, saved a checkpoint and handed off; the JOB is unfinished but
 *       the CHUNK worked.
 *   skipped (not_found, sourcing_claimed_elsewhere,     -> skipped
 *            finalize_claimed_elsewhere)
 *       It declined to run, or there was nothing there to run. Legitimate, and
 *       not work: `not_found` in particular is `ok:false` and must never be
 *       counted as processed.
 *   noop (already_finished, noop_status_*)              -> skipped
 *       A measured nothing-to-do. The ledger keeps noop and skipped apart on
 *       purpose (a starved fleet must not read as an idle one); the wire has
 *       three buckets, and both mean "this chunk performed no work", with the
 *       ledger reason carried through in `reason` so the distinction survives.
 *   failed (read_failed, chunk_failed, unmapped_*)      -> failed
 *       It ran and did not finish. `read_failed` is the production case in the
 *       finding.
 *   reaped                                              -> failed
 *       Not reachable from chunkRunOutcome today; bucketed with failed so a
 *       future reap never reads as success.
 */
function classifyChunkResult(result) {
  const ledger = chunkRunOutcome(result);
  const reason = ledger.reason || null;

  let bucket;
  if (ledger.outcome === RUN_OUTCOMES.SUCCEEDED) bucket = "processed";
  else if (ledger.outcome === RUN_OUTCOMES.SKIPPED || ledger.outcome === RUN_OUTCOMES.NOOP) bucket = "skipped";
  else bucket = "failed";

  // Belt and braces on the exact sentence this task exists for: a result that
  // said ok:false can never leave here as processed, whatever the mapping
  // above decides. If the two ever disagree that is itself a defect, so it
  // fails loud with the contradiction named rather than picking a side quietly.
  if (bucket === "processed" && !(result && result.ok === true)) {
    return {
      outcome: "failed",
      reason: `inconsistent_ok_false:${reason ?? "none"}`,
      ledger_outcome: ledger.outcome,
    };
  }

  return { outcome: bucket, reason, ledger_outcome: ledger.outcome };
}

/** The wire body for one directly-resumed chunk. Counters, so 0 is visible. */
function chunkResponseBody(jobId, verdict) {
  return {
    mode: "direct-resume",
    job_id: jobId,
    outcome: verdict.outcome,
    reason: verdict.reason,
    ledger_outcome: verdict.ledger_outcome,
    processed: verdict.outcome === "processed" ? 1 : 0,
    skipped: verdict.outcome === "skipped" ? 1 : 0,
    failed: verdict.outcome === "failed" ? 1 : 0,
  };
}

export async function GET(request) {
  const { searchParams } = new URL(request.url);

  if (!isAuthorized(request, searchParams)) {
    return NextResponse.json({ detail: "Unauthorized." }, { status: 401 });
  }

  // R0.1.7: record the tick AFTER the auth gate, so a rejected request never
  // makes a dead cron look alive on /api/health. Non-fatal by design.
  await recordCronTick("scan-worker");

  const directJobId = searchParams.get("job_id");

  // Self-continue path (scanWorker.js's fire-and-forget self-continue fetch,
  // fired when a chunk hits its soft time budget with work still remaining):
  // resume THIS SPECIFIC job right now, unconditionally. The staleness sweep
  // below intentionally does NOT cover this case — the chunk that just fired
  // this request also just heartbeated, so isJobAlive would report it fresh
  // and the sweep would (correctly, for its own purpose) skip it.
  if (directJobId) {
    try {
      const verdict = classifyChunkResult(await runScanChunk(directJobId));
      const body = chunkResponseBody(directJobId, verdict);

      // STATUS CODE (R3.1.3). 200 for processed AND for skipped: an absent
      // job, a job already finished, or a claim lost to a concurrent
      // invocation are all normal, and 5xx-ing on them would page an operator
      // for nothing while telling the cron's own health signal a lie in the
      // other direction. `failed` is a 5xx: it is the same class of event as
      // the exception below — a chunk that ran and did not finish, usually a
      // database read that failed — and answering 200 to it is what let a
      // read_failed hide behind {processed: 1} in production. The two paths
      // agree deliberately: since openScanRun began throwing on a total DB
      // outage, that outage arrives HERE as an exception and as `read_failed`
      // when only the job read fails, and both now answer 500 with counters.
      // Nothing retries on this status (the self-continue fetch in
      // scanWorker.js is fire-and-forget and never reads the response), and
      // Vercel's cron does not use ?job_id= at all — it drives the sweep
      // below — so a 500 here cannot loop or trip the daily cron.
      if (verdict.outcome === "failed") {
        console.error(
          `[worker] Direct resume of job ${directJobId} did not succeed: ${verdict.reason}`
        );
        return NextResponse.json({ ...body, detail: "Scan chunk failed." }, { status: 500 });
      }

      return NextResponse.json(body);
    } catch (error) {
      console.error(`[worker] Direct resume of job ${directJobId} failed:`, error);
      return NextResponse.json(
        {
          mode: "direct-resume",
          job_id: directJobId,
          outcome: "failed",
          reason: "exception",
          processed: 0,
          skipped: 0,
          failed: 1,
          detail: "Internal Server Error",
        },
        { status: 500 }
      );
    }
  }

  if (!supabase) {
    // `dispatched`, not `processed`: this invocation ran no chunk at all. Same
    // word as the sweep below, and deliberately NOT the direct path's
    // `processed: 0`, which means "a chunk ran and did no work".
    return NextResponse.json({
      mode: "no-db",
      dispatched: 0,
      info: "No Supabase configured. Local in-memory worker runs automatically.",
    });
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
    //
    // A failed tick used to leave `scheduled: []` — the same answer as "no
    // brand was due", which is the daily-cron version of the bug this task is
    // about. `scheduled: null` plus `scheduler_ok: false` keeps the two apart
    // (rule 1, and never `?? 0` on a measurement that did not happen). Still
    // 200: the sweep above is the cron's actual job and it succeeded.
    let scheduled = [];
    let schedulerOk = true;
    let schedulerError = null;
    try {
      const tickResult = await runSchedulerTick(new Date().toISOString());
      scheduled = tickResult.started;
    } catch (err) {
      console.error("[worker] Scheduler tick failed:", err);
      scheduled = null;
      schedulerOk = false;
      schedulerError = err?.message || String(err);
    }

    // The sweep DISPATCHES chunks (fire-and-forget, above) and never awaits
    // them, so it cannot say processed/skipped/failed for any of them — each
    // chunk files its own scan_runs row. Reporting `dispatched` says exactly
    // what this response knows. `active` makes an idle tick legible: 0 active
    // jobs and 0 dispatched is a healthy quiet day, and it no longer looks the
    // same as 20 active jobs none of which we managed to kick.
    return NextResponse.json({
      mode: "sweep",
      dispatched: resumedIds.length,
      job_ids: resumedIds,
      active: (activeJobs || []).length,
      scheduled,
      scheduler_ok: schedulerOk,
      scheduler_error: schedulerError,
    });
  } catch (error) {
    console.error("Cron worker route error:", error);
    return NextResponse.json({ detail: "Internal Server Error" }, { status: 500 });
  }
}
