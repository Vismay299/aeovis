import { NextResponse } from "next/server";
import { isCronAuthorized } from "@/lib/cronAuth";
import { recordCronTick } from "@/lib/db/analytics";
import { supabase } from "@/lib/db";
import {
  REAP_PASS_REASONS,
  SCHEDULER_TICK_REASONS,
  chunkRunOutcome,
  reapStaleRuns,
  runScanChunk,
  runSchedulerTick,
  shouldRescueJob,
} from "@/lib/workers/scanWorker";
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

/**
 * R3.2.6 — the scheduler branch of the sweep, in the same three words.
 *
 * THE FINDING. R3.2.2 taught `runSchedulerTick` to return `{started, skipped}`
 * and to write a scan_runs row per declined brand, so the LEDGER can tell an
 * idle cron from a starved one. This route then did `scheduled =
 * tickResult.started` and threw `skipped` away, so on the wire a tick that
 * found four due brands and declined every one of them was byte-identical to a
 * tick with nothing due: `scheduled: []` either way. Standing rule 1 — a skip
 * is not a success, and an empty state is not a clean one.
 *
 * The distinction the wire has to carry is THREE-way, not two:
 *   started — at least one due brand got a job. (ledger: succeeded)
 *   skipped — brands were due and every one was declined. (ledger: noop /
 *             all_due_skipped) This is the starved scheduler, and it is the
 *             state that used to be invisible.
 *   idle    — the tick looked and nothing was due. (ledger: noop /
 *             no_schedules_due) A measured zero, not a silence.
 * plus `failed` when the tick threw, which already had `scheduler_ok: false`.
 *
 * As in classifyChunkResult above, the reasons are NOT re-invented here: they
 * are `SCHEDULER_TICK_REASONS`, the exact strings runSchedulerTick closes its
 * own tick row with, so the wire and the ledger cannot disagree about the same
 * pass. The per-brand decline reasons (`cadence_off`, `brand_already_active`)
 * travel verbatim from the ledger rows, named per brand in `skips` and tallied
 * in `skip_reasons` — an operator reading the cron response can see WHICH
 * brands are starving and WHY without opening the database.
 */
export const SCHEDULER_OUTCOMES = Object.freeze({
  STARTED: "started",
  ALL_DUE_SKIPPED: "skipped",
  IDLE: "idle",
  FAILED: "failed",
});

/** `{cadence_off: 2, brand_already_active: 1}` from the skip list. */
function tallySkipReasons(skips) {
  const tally = {};
  for (const skip of skips) {
    // A skip that arrived without a reason is exactly the unexplained skip
    // R3.2.2 abolished. It gets a visible bucket rather than being dropped.
    const reason = String(skip?.reason ?? "").trim() || "unnamed_skip_reason";
    tally[reason] = (tally[reason] || 0) + 1;
  }
  return tally;
}

/**
 * Turn a runSchedulerTick result into the wire's scheduler verdict.
 *
 * `due` is derived, not guessed: runSchedulerTick puts every schedule it
 * listed into exactly one of `started` or `skipped` before it returns, so the
 * sum IS the due count. If the tick throws it never returns here at all — that
 * path is schedulerTickThrew() below, where every count is null because a tick
 * that died mid-list never finished counting.
 */
export function classifySchedulerTick(tickResult) {
  const started = tickResult?.started;
  const skipped = tickResult?.skipped;

  // Never round a missing measurement down to a clean zero. If runSchedulerTick
  // ever stops returning both arrays, that is a broken contract and it says so
  // loudly instead of reporting an idle scheduler (rule 1, and the reason
  // R3.2.2's `skipped` exists at all).
  if (!Array.isArray(started) || !Array.isArray(skipped)) {
    return {
      outcome: SCHEDULER_OUTCOMES.FAILED,
      reason: `scheduler_contract_broken:started=${typeof started},skipped=${typeof skipped}`,
      ledger_outcome: RUN_OUTCOMES.FAILED,
      due: null,
      started: null,
      skipped: null,
      skips: null,
      skip_reasons: null,
    };
  }

  let outcome;
  let reason;
  let ledgerOutcome;
  if (started.length > 0) {
    // Started something. `skips` is still reported: a tick that started one
    // brand and declined nine is not a healthy tick, and rounding it to
    // "started" with no detail would hide nine starving brands.
    outcome = SCHEDULER_OUTCOMES.STARTED;
    reason = null;
    ledgerOutcome = RUN_OUTCOMES.SUCCEEDED;
  } else if (skipped.length > 0) {
    outcome = SCHEDULER_OUTCOMES.ALL_DUE_SKIPPED;
    reason = SCHEDULER_TICK_REASONS.ALL_DUE_SKIPPED;
    ledgerOutcome = RUN_OUTCOMES.NOOP;
  } else {
    outcome = SCHEDULER_OUTCOMES.IDLE;
    reason = SCHEDULER_TICK_REASONS.NO_SCHEDULES_DUE;
    ledgerOutcome = RUN_OUTCOMES.NOOP;
  }

  return {
    outcome,
    reason,
    ledger_outcome: ledgerOutcome,
    due: started.length + skipped.length,
    started: started.length,
    skipped: skipped.length,
    skips: skipped.map((skip) => ({
      brand: skip?.brand ?? null,
      reason: skip?.reason ?? null,
    })),
    skip_reasons: tallySkipReasons(skipped),
  };
}

/** The verdict for a tick that threw: nothing was measured, so nothing is 0. */
export function schedulerTickThrew(error) {
  return {
    outcome: SCHEDULER_OUTCOMES.FAILED,
    reason: SCHEDULER_TICK_REASONS.TICK_FAILED,
    ledger_outcome: RUN_OUTCOMES.FAILED,
    due: null,
    started: null,
    skipped: null,
    skips: null,
    skip_reasons: null,
    error: error?.message || String(error),
  };
}

/**
 * R3.3.4 — the stale-run reaper, on the wire.
 *
 * THE FINDING. R3.3.2 built `reapStaleRuns` — 28 tests, a fake clock, nine
 * proven sabotages — and could not wire it, because this file belonged to
 * another task that cycle. So every run whose writer died (a killed serverless
 * invocation, a crashed fleet container) stayed OPEN forever: indistinguishable
 * in the ledger from work still in flight, and never closed by anything. The
 * reaper was correct and unreached, which is the most expensive kind of
 * correct.
 *
 * `reap_not_run` exists for the same reason `scheduled: null` does. If the
 * sweep ever stops handing a pass to buildSweepResponse, the wire says so with
 * every counter null rather than dropping the key, because an absent `reaped`
 * would read to an operator exactly like a clean sweep.
 */
export const REAP_WIRE_REASONS = Object.freeze({
  /** buildSweepResponse was called without a pass at all. Not "nothing was stale". */
  NOT_RUN: "reap_not_run",
});

/** A counter on its way out: unknown stays null. Never `?? 0` (rule 5). */
function reapCount(value) {
  return Number.isFinite(value) ? value : null;
}

/** The all-null reap report. Every refusal below returns this shape, filled in. */
function unmeasuredReapWire(fields) {
  return {
    ok: false,
    outcome: null,
    reason: null,
    error: null,
    considered: null,
    reaped: null,
    lost_race: null,
    vanished: null,
    not_stale: null,
    unreadable_heartbeat: null,
    close_failed: null,
    truncated: null,
    pass_run_id: null,
    ...fields,
  };
}

/**
 * Turn a reapStaleRuns pass into the wire's reap report.
 *
 * The counters are copied, never recomputed: `considered` is how many stale
 * candidates the pass looked at and `reaped` is how many it actually closed,
 * and those are different numbers on every pass that lost a race or found a
 * row fresh on re-check. `truncated` is the one an operator must not miss — it
 * means "I hit my cap and MORE stale runs are still open", so `reaped: 100`
 * cannot be read as "the ledger is clean now".
 *
 * A pass that could not look (no Supabase client) arrives here with
 * `considered: null` and leaves with it: that is NOT MEASURED, and rounding it
 * to 0 would report a healthy ledger nobody inspected.
 */
export function reapCounters(pass) {
  if (!pass || typeof pass !== "object") {
    return unmeasuredReapWire({ reason: `reaper_contract_broken:${pass === null ? "null" : typeof pass}` });
  }
  return {
    ok: pass.ok === true,
    outcome: pass.outcome ?? null,
    reason: pass.reason ?? null,
    error: null,
    considered: reapCount(pass.considered),
    reaped: reapCount(pass.reaped),
    lost_race: reapCount(pass.lostRace),
    vanished: reapCount(pass.vanished),
    not_stale: reapCount(pass.notStale),
    unreadable_heartbeat: reapCount(pass.unreadableHeartbeat),
    close_failed: reapCount(pass.closeFailed),
    truncated: typeof pass.truncated === "boolean" ? pass.truncated : null,
    pass_run_id: pass.passRunId ?? null,
  };
}

/**
 * The report for a reap that threw: nothing was measured, so nothing is 0.
 *
 * `reap_failed` is the pass's own vocabulary, not a word invented here —
 * reapStaleRuns closes its pass row with exactly that reason before it
 * rethrows, so the wire and the ledger name the same event the same way.
 */
export function reapPassThrew(error) {
  return unmeasuredReapWire({
    outcome: RUN_OUTCOMES.FAILED,
    reason: REAP_PASS_REASONS.REAP_FAILED,
    error: error?.message || String(error),
  });
}

/**
 * The whole sweep body, in one place so the response the cron actually reads
 * can be driven by a test. The sweep branch cannot be reached through the HTTP
 * handler in a test (it requires a live Supabase, and this suite deliberately
 * has none — see the header of scanWorkerRoute.route.test.mjs), so the body is
 * built here rather than inline in GET and asserted directly.
 */
export function buildSweepResponse({ activeCount, resumedIds, scheduled, scheduler, reaped = null }) {
  return {
    mode: "sweep",
    dispatched: resumedIds.length,
    job_ids: resumedIds,
    active: activeCount,
    scheduled,
    scheduler_ok: scheduler.outcome !== SCHEDULER_OUTCOMES.FAILED,
    scheduler_error: scheduler.outcome === SCHEDULER_OUTCOMES.FAILED ? scheduler.error ?? scheduler.reason : null,
    scheduler,
    // An absent pass is reported as an unmeasured one, never omitted: a missing
    // `reaped` key looks like a quiet success to everything downstream.
    reaped: reaped || unmeasuredReapWire({ reason: REAP_WIRE_REASONS.NOT_RUN }),
  };
}

/**
 * The two maintenance passes the cron sweep runs after it has dispatched its
 * chunks: the scheduler tick, then the stale-run reap.
 *
 * WHY THIS IS A FUNCTION AND NOT INLINE IN GET. The sweep branch of GET is
 * behind `if (!supabase)` and the route suite deliberately has no Supabase, so
 * nothing inside that branch could ever be exercised by a test. Lifting the
 * two passes here — unchanged — makes the isolation below a proven property
 * rather than a comment: scanWorkerRoute.route.test.mjs drives this function
 * with a reaper that throws and asserts the tick's result survives intact.
 *
 * TWO try/catch BLOCKS, IN SEQUENCE, ON PURPOSE:
 *   * a tick that throws must not skip the reap — a scheduler broken by one bad
 *     schedule row would otherwise wedge the ledger open indefinitely;
 *   * a reap that throws must not fail the tick, must not lose the jobs the
 *     sweep already dispatched, and must not turn a working cron into a 500.
 *     The failure is REPORTED (`reaped.ok: false`, every counter null, the
 *     message on the wire), never swallowed.
 * The tick runs first because starting due scans is the cron's actual job; the
 * reap is bookkeeping over rows that have already been stale for six minutes,
 * and one more tick of latency on it costs nothing.
 */
export async function runSweepMaintenance(nowIso, deps = {}) {
  const tick = deps.runSchedulerTick || runSchedulerTick;
  const reap = deps.reapStaleRuns || reapStaleRuns;

  // A failed tick used to leave `scheduled: []` — the same answer as "no
  // brand was due", which is the daily-cron version of the bug this route is
  // about. `scheduled: null` plus `scheduler_ok: false` keeps the two apart
  // (rule 1, and never `?? 0` on a measurement that did not happen).
  //
  // R3.2.6: `tickResult.skipped` is no longer dropped on the floor. The whole
  // result goes to classifySchedulerTick, so "nothing was due" and "every due
  // brand was declined" stop being the same `scheduled: []` on the wire.
  let scheduled = [];
  let scheduler;
  try {
    const tickResult = await tick(nowIso);
    scheduler = classifySchedulerTick(tickResult);
    scheduled = Array.isArray(tickResult?.started) ? tickResult.started : null;
    if (scheduler.outcome === SCHEDULER_OUTCOMES.ALL_DUE_SKIPPED) {
      console.warn(
        `[worker] Scheduler tick declined every one of ${scheduler.due} due brand(s): ` +
          `${JSON.stringify(scheduler.skip_reasons)}. This is a STARVED scheduler, not an idle one.`
      );
    } else if (scheduler.outcome === SCHEDULER_OUTCOMES.FAILED) {
      console.error(`[worker] Scheduler tick returned an unusable result: ${scheduler.reason}`);
    }
  } catch (err) {
    console.error("[worker] Scheduler tick failed:", err);
    scheduled = null;
    scheduler = schedulerTickThrew(err);
  }

  let reaped;
  try {
    reaped = reapCounters(await reap(nowIso));
    if (reaped.truncated) {
      console.warn(
        `[worker] The reap pass hit its cap after ${reaped.reaped} row(s) and MORE stale runs are ` +
          `still open. Do not read this sweep as "the ledger is clean now".`
      );
    } else if (reaped.considered === null) {
      console.error(
        `[worker] The reap pass did not measure anything (${reaped.reason}). No open run was ` +
          `inspected, which is NOT the same as no run being stale.`
      );
    }
  } catch (err) {
    // Isolated from the tick above and from the sweep's own try in GET: the
    // chunks were already dispatched and the tick already ran, and losing that
    // report to a bookkeeping failure would be a worse lie than the failure.
    console.error("[worker] Stale-run reap failed:", err);
    reaped = reapPassThrew(err);
  }

  return { scheduled, scheduler, reaped };
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

    // The two maintenance passes, each in its own try/catch inside
    // runSweepMaintenance: the scheduler tick (enqueue new scans for any brand
    // whose cadence is due and isn't already running) and then R3.3.4's
    // stale-run reap. Neither can fail the other, and neither can fail this
    // response: the sweep above is the cron's actual job and it succeeded, so
    // this stays a 200 with both outcomes reported honestly in the body.
    const { scheduled, scheduler, reaped } = await runSweepMaintenance(new Date().toISOString());

    // The sweep DISPATCHES chunks (fire-and-forget, above) and never awaits
    // them, so it cannot say processed/skipped/failed for any of them — each
    // chunk files its own scan_runs row. Reporting `dispatched` says exactly
    // what this response knows. `active` makes an idle tick legible: 0 active
    // jobs and 0 dispatched is a healthy quiet day, and it no longer looks the
    // same as 20 active jobs none of which we managed to kick.
    return NextResponse.json(
      buildSweepResponse({
        activeCount: (activeJobs || []).length,
        resumedIds,
        scheduled,
        scheduler,
        reaped,
      })
    );
  } catch (error) {
    console.error("Cron worker route error:", error);
    return NextResponse.json({ detail: "Internal Server Error" }, { status: 500 });
  }
}
