import { NextResponse } from "next/server";
import { isCronAuthorized } from "@/server/cronAuth";
import { recordCronTick } from "@/server/db/analytics";
import { supabase } from "@/server/db";
import {
  listResumableContentJobs,
  listRewoundContentJobs,
  healRewoundContentJob,
  getContentJob,
  isRewoundContentJob,
  isDeliveredContentJob,
} from "@/server/db/content";
import { acquireLease, newLeaseOwner } from "@/server/jobLease";
import { startContentJob, CONTENT_WORKER_PATH } from "@/shared/content/contentWorker";
import { createDailyBatchJobs, getDailyBatchSize } from "@/shared/content/dailyBatch";
import { keepAlive } from "@/server/keepAlive";
import { makeSelfContinue } from "@/server/selfContinue";

// Side-effectful (spends real model budget) — must never run at build time.
export const dynamic = "force-dynamic";

// Mirrors /api/scan/worker: a resumed content job runs a full block pipeline
// and needs the same headroom as the route that first started it (D3).
export const maxDuration = 300;

const MAX_CONCURRENT_RESUMES = 3;

/**
 * R3.5.7 — how many rewound rows one sweep repairs. Each heal is a single
 * conditional UPDATE (no model spend, no pipeline), so this is bounded only to
 * keep one pass's work predictable; a larger backlog is healed over the next
 * few ticks and `healed` in the response shows the progress.
 */
const MAX_REWOUND_HEALS = 20;

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
 * implementation is shared with /api/scan/worker in src/server/cronAuth.js so the
 * two cannot drift.
 */
function isAuthorized(request, searchParams) {
  return isCronAuthorized(request, searchParams, { label: "content-cron", warned: warnedNoSecret });
}

/**
 * The sweep's own self-continue: one request per job at this same route's
 * `?job_id=` branch. Labelled `content-cron` so its warnings are readable
 * apart from the worker's own hand-off (`content-worker`).
 */
const cronSelfContinue = makeSelfContinue({
  routePath: CONTENT_WORKER_PATH,
  label: "content-cron",
});

/**
 * R3.1.14 — dispatch one job by FETCH, giving it its own invocation and its
 * own 300 s. This is what the cron sweep and the daily batch now use; only the
 * `?job_id=` branch below still runs a job in-process, because that branch IS
 * the per-job invocation this function creates.
 *
 * THE FINDING (production, 2026-09-18 19:15 UTC). The sweep dispatched four
 * jobs through dispatchWithLease, each one `keepAlive(() => startContentJob())`
 * INSIDE the sweep's single invocation. One finished; the other three were
 * killed mid-block by `Vercel Runtime Timeout Error: Task timed out after 300
 * seconds`, with no hand-off line in the logs and only ONE request to this
 * route for the whole pass. Four pipelines sharing one function lifetime slow
 * each other down until the platform cap arrives before any per-job budget
 * does, which made R3.1.10's hand-off unreachable in practice rather than
 * merely rare.
 *
 * THE LEASE — and this is the design decision, of the two that were open:
 * THE SWEEP DOES NOT ACQUIRE. It fires the request and the RECEIVING
 * invocation takes the lease through dispatchWithLease, exactly as it already
 * does for a self-continue fired by contentWorker's handOff (which releases
 * first, then fires, for this same reason). Acquiring here and firing anyway
 * would hand the receiver a lease it cannot take: its own acquire would return
 * `lease_held` and the job would sit until our lease expired — a slower
 * version of the bug. Acquiring, releasing and then firing was rejected as two
 * extra writes buying nothing: the receiver's conditional UPDATE is the
 * single-flight authority either way (D1 is preserved, it just happens one hop
 * later), and a job already being worked simply answers `lease_held` there.
 *
 * WHAT `ok` MEANS HERE: "the hand-off request left this process", not "the job
 * ran" and not "we hold the lease". A fetch that could not be started is a
 * failure and is reported as one (`self_continue_failed`) — a sweep that fired
 * nothing must never read as a sweep that dispatched everything.
 */
export function dispatchBySelfContinue(jobId, label, deps = {}) {
  const fire = deps.selfContinue ?? cronSelfContinue;
  let fired = null;
  try {
    fired = fire(jobId);
  } catch (err) {
    console.error(`[content-cron] self-continue for ${label} ${jobId} threw:`, err.message);
    return {
      ok: false,
      owner: null,
      reason: "self_continue_failed",
      error: err,
      selfContinue: { fired: false, reason: "threw" },
    };
  }
  if (!fired || fired.fired !== true) {
    const reason = fired?.reason || "unknown";
    console.warn(
      `[content-cron] ${label} ${jobId} was NOT handed off — the self-continue fetch could not ` +
        `be sent (${reason}). The job is untouched and the next sweep will try again.`
    );
    return {
      ok: false,
      owner: null,
      reason: "self_continue_failed",
      error: new Error(`self-continue not fired: ${reason}`),
      selfContinue: fired || { fired: false, reason },
    };
  }
  console.log(
    `[content-cron] ${label} ${jobId} handed off to ${CONTENT_WORKER_PATH}?job_id=... ` +
      `self_continue_fired=true`
  );
  return { ok: true, owner: null, reason: null, error: null, selfContinue: fired };
}

/**
 * R3.5.7 — may this `?job_id=` request start the job at all?
 *
 * startContentJob refuses a delivered job itself (it is the authority, and it
 * also covers POST /api/content), but it runs fire-and-forget under keepAlive,
 * so its verdict can never reach this response. The same two predicates are
 * therefore evaluated HERE, on the row the request names, so the branch can
 * report a REFUSAL — a named skip, neither `dispatched: 1` nor a 500.
 *
 * ITS OWN SEAM, deliberately NOT inside dispatchWithLease: that function's
 * contract is "take the lease and run", and R3.1.11 pins it by counting the
 * statements its injected client receives. A read smuggled in there would both
 * blur that contract and break that count.
 *
 * THREE verdicts, because a check that could not run must never look like a
 * check that passed (standing rule 1):
 *   - `{ check: "ok" }`          — the row was read and may be resumed.
 *   - `{ check: "refused" }`     — it already delivered; do not dispatch.
 *   - `{ check: "unavailable" }` — the row could not be read. We DISPATCH
 *     anyway (exactly the behaviour before this task) because a transient read
 *     failure must not strand a job; startContentJob re-checks on its own read
 *     and refuses there. The response says the check did not run.
 */
export async function deliveryPrecheck(jobId, deps = {}) {
  try {
    const job = await (deps.getContentJob ?? getContentJob)(jobId, { client: deps.client ?? null });
    // Both shapes are refused: a row that reached the human gate carrying an
    // item (delivered), and a row already rewound back into a running status
    // (the R3.5.6 damage — production's re-dispatch loop came in through here).
    if (isDeliveredContentJob(job) || isRewoundContentJob(job)) {
      const detail =
        `job is "${job.status}" with item_id ${job.item_id} — it already delivered an item, so ` +
        `running it again would re-pay for a draft that exists and fight its own item row`;
      console.warn(`[content-cron] direct resume of job ${jobId} REFUSED: ${detail}`);
      return { check: "refused", reason: "already_delivered", detail };
    }
    return { check: "ok", reason: null, detail: null };
  } catch (err) {
    console.warn(
      `[content-cron] job ${jobId}: could not read the row to check whether it already delivered ` +
        `(${err.message}) — dispatching anyway; startContentJob re-checks on its own read.`
    );
    return {
      check: "unavailable",
      reason: null,
      detail: `delivery check did not run: ${err.message || "read failed"}`,
    };
  }
}

/**
 * Take the lease, then run the job IN THIS INVOCATION. Returns the lease owner
 * if we won the job, else null. This is the single-flight gate (D1): before
 * this, the cron fired startContentJob() fire-and-forget with no exclusivity,
 * so two overlapping invocations both ran the same job — two executions racing
 * one row, each spending up to the full per-item cap and each inserting a
 * content_items row.
 *
 * R3.1.14 — THE ONLY CALLER LEFT IS THE `?job_id=` BRANCH. The sweep and the
 * daily batch dispatch through dispatchBySelfContinue above instead, so that
 * each job gets an invocation of its own. Running inline is correct here and
 * only here: this request already IS one job's invocation, and it must not
 * fire another request at itself.
 */
export async function dispatchWithLease(jobId, label, deps = {}) {
  const acquire = deps.acquireLease ?? acquireLease;
  const start = deps.startContentJob ?? startContentJob;
  const makeOwner = deps.newLeaseOwner ?? newLeaseOwner;

  const owner = makeOwner("cron");
  let won = null;
  try {
    // R3.1.11 — `deps` is forwarded. acquireLease reads its client from
    // `deps.client` / `deps.supabase` (src/server/jobLease.js resolveClient) and
    // its clock from `deps.nowMs`; without this argument an injected client
    // never reached the lease UPDATE, so the real single-flight gate could only
    // ever be tested by stubbing itself out. Real callers pass none of these
    // keys and get the module-level client exactly as before.
    won = await acquire("content_jobs", jobId, owner, deps);
  } catch (err) {
    // Fail CLOSED: if we cannot prove we hold the lease, we must not spend.
    console.error(`[content-cron] lease acquire failed for ${label} ${jobId}:`, err.message);
    return { ok: false, owner: null, reason: "lease_acquire_failed", error: err };
  }
  if (!won) {
    console.log(`[content-cron] ${label} ${jobId} is leased by another worker — skipping`);
    return { ok: false, owner: null, reason: "lease_held", error: null };
  }

  // `invocationStartMs` is this invocation's own clock, handed to the worker so
  // its chunk budget is measured against the function's remaining life rather
  // than against the moment this particular job happened to start (R3.1.14).
  keepAlive(() => start(jobId, { leaseOwner: owner, invocationStartMs: deps.invocationStartMs }), {
    label: `[content-cron] ${label} ${jobId}`,
    waitUntil: deps.waitUntil,
  });
  return { ok: true, owner, reason: null, error: null };
}

/**
 * R3.1.10 — the report for a `?job_id=` direct resume (the self-continue's
 * receiving end). A separate shape from contentCronReport because it answers a
 * different question: not "what did this sweep do" but "did this ONE named job
 * get picked up".
 *
 * STATUS CODES, same reasoning as the scan worker's direct-resume branch:
 *   - 200 `dispatched: 1`  — we took the lease and the job is running.
 *   - 200 `dispatched: 0, reason: "lease_held"` — someone else is already
 *     working it. Normal and not an error: the self-continue may simply have
 *     raced a cron sweep. 5xx-ing here would page an operator for a healthy
 *     outcome.
 *   - 500 `dispatched: 0, reason: "lease_acquire_failed"` — the lease UPDATE
 *     itself failed, which is a database fault and the same class of event the
 *     sweep reports through `batch_unavailable`.
 *
 * Nothing retries on this status: the self-continue fetch in contentWorker.js
 * is fire-and-forget and never reads the response, and Vercel's crons do not
 * use `?job_id=` at all — so a 500 here can neither loop nor trip the cron.
 *
 * `ledger_written` mirrors R3.1.4: it says plainly whether a content_runs row
 * could have been written, so an empty ledger is never read as an idle system.
 */
export function contentDirectResumeReport({
  jobId,
  ok = false,
  reason = null,
  detail = null,
  ledgerWritten = false,
  deliveryCheck = "ok",
} = {}) {
  return {
    // R3.5.7 — `already_delivered` is a 200 SKIP: nothing ran, nothing failed,
    // and the row is not lost (the sweep heals it). A 5xx here would page an
    // operator for the system correctly refusing to double-pay.
    status: reason === "lease_acquire_failed" ? 500 : 200,
    body: {
      mode: "direct-resume",
      job_id: jobId,
      dispatched: ok ? 1 : 0,
      dispatched_ids: ok ? [jobId] : [],
      skipped: ok ? 0 : 1,
      skips: ok ? [] : [{ id: jobId, reason: reason || "unknown", detail }],
      reason: ok ? null : reason || "unknown",
      detail,
      ledger_written: ledgerWritten,
      // "ok" | "refused" | "unavailable" — see deliveryPrecheck. A check that
      // could not run must not read as one that passed.
      delivery_check: deliveryCheck,
    },
  };
}

/**
 * The daily batch's brand list, decided from the RAW postgrest envelope.
 *
 * R2.8.5, the same class of read R2.8.4 removed from getScansForBrand. The
 * caller below used to destructure only `data` and drop `error` on the floor.
 * The Supabase client is built without `throwOnError`, so a refused connection,
 * a DNS failure or a 5xx all arrive as `{ data: null, error }` — `rows || []`
 * then made the brand list empty, the per-brand loop never ran, the per-brand
 * catch (and the `batch_failed` counter it feeds, added by R2.8.4) never fired,
 * and the route answered HTTP 200 with a fully green report. A total outage was
 * indistinguishable from "every brand is already up to date": a dead batch that
 * reports itself healthy, which is what standing rule 1 forbids.
 *
 * Unlike ONE brand's failure — kept as degradation at the call site, since one
 * brand must not abort the whole pass — an unreadable brand list means the batch
 * stage did nothing for ANY brand, so it becomes a 5xx (see contentCronReport).
 *
 * Exported because the handler itself cannot be driven in-process with a live
 * client attached: its first act is `recordCronTick`, a WRITE, and the
 * live-write guard (src/server/liveWriteGuard.js) refuses every write in a test
 * process. This is the real decision, not a copy of it — the handler has no
 * other version of these lines. See src/server/dbReadOutage.route.test.mjs.
 *
 * @param {{data: Array|null, error: object|null}} envelope postgrest's own reply
 * @returns {{brands: string[], unavailable: {reason: string, detail: string}|null}}
 */
export function brandsForDailyBatch({ data, error } = {}) {
  if (error) {
    return {
      brands: [],
      unavailable: {
        reason: error.code || "db_read_failed",
        detail: "Could not read the brand list — the daily batch did not run for ANY brand.",
      },
    };
  }
  return {
    brands: Array.from(new Set((data || []).map((r) => r && r.brand).filter(Boolean))),
    unavailable: null,
  };
}

/**
 * The cron's report of its own pass, and the status that carries it.
 *
 * R3.1.4 — DISPATCHED, NOT RESUMED / DONE. The content worker sweep fires off
 * content jobs fire-and-forget (via `dispatchWithLease` when this was written;
 * via `dispatchBySelfContinue` since R3.1.14), the same shape the scan worker
 * sweep uses. Before this fix the report called the dispatched
 * count `resumed` and the skipped-lease count, which collapsed two
 * facts: a job we kicked off and a job we chose not to kick off both rode the
 * same wire as "resumed". Now it follows the scan worker's vocabulary:
 *   - `dispatched` — fire-and-forget jobs we kicked off
 *   - `skipped` — jobs we chose not to kick off (leased by another worker)
 *   - `batch_dispatched` / `batch_dispatched_ids` — daily-batch jobs kicked off
 *   - `batch_failed` — brands where the batch creation itself failed
 *
 * `batch_unavailable` is ALWAYS present so `batch_dispatched: 0` can be read
 * at all: null means the brand list was read and there was nothing to create
 * (a measured zero), an object means it could not be read (never ran). The
 * status is 5xx in the second case — a cron whose batch stage did nothing
 * must not answer 200, or the platform's own failure alerting never sees it.
 *
 * The dispatched counts survive either way: they really did happen, and an
 * operator needs to see which half of the pass worked.
 *
 * R3.1.14 — WHAT `dispatched` NOW MEANS. The sweep no longer runs jobs in its
 * own invocation; it fires one `?job_id=` request per job. So `dispatched`
 * counts HAND-OFFS FIRED, not pipelines running, and the report says so twice:
 * `dispatch_mode: "self_continue"` names the mechanism, and `self_continue`
 * carries the per-job verdict `{ id, fired, reason }` so a pass where every
 * fetch failed cannot be read as a pass that dispatched everything.
 */
export function contentCronReport({
  startedIds = [],
  skippedIds = [],
  batchCreated = [],
  batchDispatched = batchCreated,
  batchSkipped = [],
  batchFailed = [],
  batchUnavailable = null,
  selfContinue = [],
  healed = [],
  healFailed = [],
  healUnavailable = null,
  dispatchMode = "self_continue",
} = {}) {
  const normalizedSkipped = (skippedIds || []).map((s) =>
    typeof s === "string"
      ? { id: s, reason: "lease_held", detail: null }
      : { id: s?.id ?? null, reason: s?.reason ?? "lease_held", detail: s?.detail ?? null }
  );
  const skippedReasons = {};
  for (const s of normalizedSkipped) {
    const r = s.reason || "unknown";
    skippedReasons[r] = (skippedReasons[r] || 0) + 1;
  }

  const normalizedBatchSkipped = (batchSkipped || []).map((s) =>
    typeof s === "string"
      ? { id: s, reason: "lease_held", detail: null }
      : { id: s?.id ?? null, reason: s?.reason ?? "lease_held", detail: s?.detail ?? null }
  );

  return {
    status: batchUnavailable ? 500 : 200,
    body: {
      dispatched: startedIds.length,
      dispatched_ids: startedIds,
      skipped: normalizedSkipped.length,
      skipped_ids: normalizedSkipped.map((s) => s.id).filter(Boolean),
      skips: normalizedSkipped,
      skipped_reasons: skippedReasons,
      batch_dispatched: batchDispatched.length,
      batch_dispatched_ids: batchDispatched,
      batch_skipped: normalizedBatchSkipped.length,
      batch_skipped_ids: normalizedBatchSkipped.map((s) => s.id).filter(Boolean),
      batch_failed: batchFailed.length,
      batch_failed_brands: batchFailed,
      batch_unavailable: batchUnavailable,
      // R3.5.7 — the repair stage, IN THE ENVELOPE and not only in console.warn.
      // `healed` carries one `{ id, reason, detail }` per row put back to
      // awaiting_approval; `heal_failed` the ones that could not be; and
      // `heal_unavailable` is ALWAYS present so `healed: []` can be read at all
      // — null means the damaged-row query ran and found nothing (a measured
      // zero), an object means it could not run (never looked).
      healed,
      healed_count: healed.length,
      healed_ids: healed.map((h) => h && h.id).filter(Boolean),
      heal_failed: healFailed,
      heal_unavailable: healUnavailable,
      dispatch_mode: dispatchMode,
      self_continue: selfContinue,
    },
  };
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
export async function GET(request, contextOrDeps = {}, maybeDeps = {}) {
  const deps =
    maybeDeps && Object.keys(maybeDeps).length > 0
      ? maybeDeps
      : contextOrDeps && !contextOrDeps.params
      ? contextOrDeps
      : {};

  const { searchParams } = new URL(request.url);

  // R3.1.14 — when THIS invocation began. Handed to startContentJob so the
  // chunk budget is measured against the function's remaining life. Tests may
  // supply it to drive the budget at fake speed.
  const invocationStartMs = Number.isFinite(deps.invocationStartMs)
    ? deps.invocationStartMs
    : Date.now();
  const dispatchDeps = { ...deps, invocationStartMs };

  if (!isAuthorized(request, searchParams)) {
    return NextResponse.json({ detail: "Unauthorized." }, { status: 401 });
  }

  // R0.1.7: record the tick AFTER the auth gate, so a rejected request never
  // makes a dead cron look alive on /api/health. Non-fatal by design.
  if (deps.recordCronTick) await deps.recordCronTick("content-worker");
  else await recordCronTick("content-worker");

  // One resolution of the data client for the whole handler: `deps.supabase`
  // may legitimately be null (a test asserting the unconfigured path), so the
  // check is `!== undefined`, not `??`.
  const client =
    deps.supabase !== undefined ? deps.supabase : deps.client !== undefined ? deps.client : supabase;

  // ---------------------------------------------------------------------
  // R3.1.10 — self-continue path. contentWorker.js fires this at itself when
  // an invocation hits its soft chunk budget with work still to do: resume
  // THIS SPECIFIC job right now, UNCONDITIONALLY.
  //
  // The staleness sweep below deliberately does not cover this case and must
  // not be consulted. shouldRescueContentJob (src/server/db/content.js) requires
  // a STALE heartbeat, and the invocation that fired this request heartbeated
  // on its very last write — so the sweep would report the job alive and skip
  // it, correctly for its own purpose and fatally for this one. The lease is
  // still the single-flight authority: the handing-off invocation released it
  // before firing, so dispatchWithLease's conditional UPDATE decides whether
  // this request or a concurrent sweep does the work, never both.
  //
  // R3.1.14 — THE SWEEP NOW FIRES AT THIS BRANCH TOO, and it is the only place
  // a content job runs in-process. The sweep takes no lease at all, so the
  // acquire below is the single-flight gate for EVERY dispatch, cron and
  // hand-off alike. This branch must never fire a self-continue of its own:
  // this request already is the job's invocation, and a request that answered
  // itself with another request would never do any work.
  // ---------------------------------------------------------------------
  const directJobId = searchParams.get("job_id");
  if (directJobId) {
    try {
      // R3.5.7 — refuse an already-delivered row before taking a lease or
      // spending anything, and report the refusal as a named skip.
      const precheck = await (deps.deliveryPrecheck ?? deliveryPrecheck)(directJobId, {
        ...deps,
        client,
      });
      if (precheck.check === "refused") {
        const { status, body } = contentDirectResumeReport({
          jobId: directJobId,
          ok: false,
          reason: precheck.reason,
          detail: precheck.detail,
          ledgerWritten: !!client,
          deliveryCheck: precheck.check,
        });
        return NextResponse.json(body, { status });
      }

      const res = await dispatchWithLease(directJobId, "direct resume", dispatchDeps);
      const { status, body } = contentDirectResumeReport({
        jobId: directJobId,
        ok: res.ok,
        reason: res.reason,
        detail: res.error?.message || precheck.detail || null,
        ledgerWritten: !!client,
        deliveryCheck: precheck.check,
      });
      if (!res.ok) {
        console.warn(
          `[content-cron] direct resume of job ${directJobId} did not dispatch: ${res.reason}`
        );
      }
      return NextResponse.json(body, { status });
    } catch (error) {
      console.error(`[content-cron] Direct resume of job ${directJobId} failed:`, error);
      const { body } = contentDirectResumeReport({
        jobId: directJobId,
        ok: false,
        reason: "exception",
        detail: error.message || "error",
        ledgerWritten: !!client,
      });
      return NextResponse.json({ ...body, detail: "Internal Server Error" }, { status: 500 });
    }
  }

  // R2.8.14: an unconfigured deploy must not answer 200 from a cron that ran
  // nothing — a cron monitor watching status codes would report the system
  // healthy. Reuses the batch_unavailable envelope from R2.8.5 so all
  // fail-quiet DB-read outages share one shape and one reason vocabulary.
  //
  // R3.1.4 — `ledger_written: false` says plainly that no content_runs row was
  // recorded, so an empty ledger can never be mistaken for an idle system.
  if (!supabase) {
    if (!deps.supabase && !deps.client) {
      const { status, body } = contentCronReport({
        batchUnavailable: {
          reason: "db_not_configured",
          detail:
            "The data store is not configured — the content cron cannot resume jobs or create batches.",
        },
        // `healed: []` here must not read as "no damaged rows": nothing looked.
        healUnavailable: {
          reason: "db_not_configured",
          detail:
            "The data store is not configured — rewound content jobs could not be looked for, " +
            "let alone healed.",
        },
      });
      return NextResponse.json({ ...body, ledger_written: false }, { status });
    }
  }

  try {
    const runBatch = searchParams.get("batch") === "1";

    // 1. Rescue jobs whose worker is presumed dead. A job with a fresh
    //    heartbeat or a live lease is presumed actively worked and skipped.
    const listResumable = deps.listResumableContentJobs ?? listResumableContentJobs;
    const jobs = await listResumable(MAX_CONCURRENT_RESUMES);
    const startedIds = [];
    const skippedIds = [];
    /** Per-job hand-off verdicts, so `dispatched: n` is auditable job by job. */
    const selfContinueResults = [];
    let batchUnavailable = null;
    for (const job of jobs) {
      // R3.1.14 — BY FETCH, NOT INLINE. Each job gets its own invocation and
      // its own 300 s; this sweep only fires the request. See
      // dispatchBySelfContinue for the lease reasoning.
      const res = dispatchBySelfContinue(job.id, "job", deps);
      selfContinueResults.push({ id: job.id, ...(res.selfContinue || { fired: false, reason: "unknown" }) });
      if (res.ok) {
        startedIds.push(job.id);
      } else {
        skippedIds.push({
          id: job.id,
          reason: res.reason,
          detail: res.error?.message || null,
        });
        // A hand-off that could not be fired is the sweep doing nothing for
        // that job. It carries the same 5xx as an unreadable brand list: a
        // cron pass that dispatched nothing must not answer 200.
        if (res.reason === "self_continue_failed" && !batchUnavailable) {
          batchUnavailable = {
            reason: "self_continue_failed",
            detail: `Could not fire the self-continue for job ${job.id}: ${res.error?.message || "error"}`,
          };
        }
      }
    }

    // ------------------------------------------------------------------
    // 1b. R3.5.7 — SELF-HEAL the rewound rows, before the batch stage below.
    //
    // A row in a running status that already carries an item_id delivered and
    // was then rewound by a second execution. R3.5.6 stopped re-dispatching
    // such a row, which also removed it from the resume list above
    // (shouldRescueContentJob refuses it), so nothing was left to REPAIR it: it
    // stayed stale + running forever and blocked its brand's daily batch until
    // an operator cleared it by hand.
    //
    // ORDER: before the batch, so a brand whose only "live" geo_article job is
    // a rewound row gets its batch in the SAME pass (createDailyBatchJobs also
    // ignores item_id rows, so the two fixes do not depend on each other).
    //
    // A row with item_id NULL is never healed — see healRewoundContentJob.
    const healed = [];
    const healFailed = [];
    let healUnavailable = null;
    try {
      const listRewound = deps.listRewoundContentJobs ?? listRewoundContentJobs;
      const heal = deps.healRewoundContentJob ?? healRewoundContentJob;
      const rewound = await listRewound(MAX_REWOUND_HEALS, { client });
      for (const job of rewound) {
        const outcome = await heal(job, { client });
        if (outcome.healed) healed.push(outcome);
        else healFailed.push(outcome);
      }
      if (rewound.length) {
        console.warn(
          `[content-cron] ${rewound.length} rewound content job(s) found (running status WITH an ` +
            `item_id): ${healed.length} healed to awaiting_approval, ${healFailed.length} not.`
        );
      }
    } catch (err) {
      // A read that could not be performed must never look like "nothing to
      // heal" (standing rule 1). The sweep itself did run, so the status stays
      // 200 and this field is what says the repair stage did not.
      healUnavailable = {
        reason: err.code || "heal_read_failed",
        detail: `Could not look for rewound content jobs: ${err.message || "unknown error"}`,
      };
      console.error("[content-cron] could not look for rewound content jobs:", err.message);
    }

    // 2. Daily batch (opt-in).
    const batchDispatched = [];
    // Kept as a measured zero on the wire. R3.1.14 removed the only way it
    // could be non-empty (the sweep's lease acquire, whose `lease_held` was a
    // benign skip); the counter stays so the batch reconciliation
    // dispatched + skipped + failed = created still reads, and so a consumer
    // of this field does not see it vanish.
    const batchSkipped = [];
    const batchFailed = [];
    const getBatchSize = deps.getDailyBatchSize ?? getDailyBatchSize;
    const batchSize = deps.brands || deps.createDailyBatchJobs ? (getBatchSize() || 5) : getBatchSize();
    if (runBatch && batchSize > 0) {
      const envelope = deps.envelope || (await client
        .from("scans")
        .select("brand")
        .order("scanned_at", { ascending: false })
        .limit(200));

      const { brands, unavailable } = brandsForDailyBatch(envelope);
      const batchBrands = deps.brands || brands;
      batchUnavailable = unavailable || batchUnavailable;
      if (unavailable) {
        console.error(
          "[content-cron] could not read the brand list for the daily batch:",
          envelope.error?.message || envelope.error
        );
      }

      const createDailyBatch = deps.createDailyBatchJobs ?? createDailyBatchJobs;
      for (const brand of batchBrands) {
        try {
          const created = await createDailyBatch(brand);
          for (const job of created) {
            // R3.1.14 — a freshly created batch job is handed off by fetch too,
            // so `?batch=1` no longer tries to run n pipelines in one function.
            const res = dispatchBySelfContinue(job.id, "batch job", deps);
            selfContinueResults.push({
              id: job.id,
              ...(res.selfContinue || { fired: false, reason: "unknown" }),
            });
            if (res.ok) {
              batchDispatched.push(job.id);
            } else {
              // There is no `lease_held` outcome on this path any more — the
              // sweep takes no lease. A created job that was not handed off is
              // a failure, never a benign skip: it exists, it cost a write, and
              // nothing is running it this pass.
              batchFailed.push({
                id: job.id,
                reason: res.reason,
                detail: res.error?.message || null,
              });
              if (!batchUnavailable) {
                batchUnavailable = {
                  reason: res.reason || "self_continue_failed",
                  detail: `Could not fire the self-continue for batch job ${job.id}: ${res.error?.message || "error"}`,
                };
              }
            }
          }
        } catch (err) {
          console.warn(`[content-cron] batch for ${brand} failed:`, err.message);
          batchFailed.push({ brand, reason: err.code || err.name || "error" });
        }
      }
    }

    const { status, body } = contentCronReport({
      startedIds,
      skippedIds,
      batchCreated: batchDispatched,
      batchDispatched,
      batchSkipped,
      batchFailed,
      batchUnavailable,
      selfContinue: selfContinueResults,
      healed,
      healFailed,
      healUnavailable,
    });
    return NextResponse.json(body, { status });
  } catch (error) {
    console.error("Content cron worker error:", error);
    return NextResponse.json({ detail: "Internal Server Error" }, { status: 500 });
  }
}
