import { NextResponse } from "next/server";
import { supabase, getScanJob, HEARTBEAT_STALE_MS } from "@/lib/db";
import { normalizeRun } from "@/lib/scanRuns";
import { terminalOutcomeFromRecord } from "@/lib/scanOutcome";
import { runScanChunk } from "@/lib/workers/scanWorker";
import { keepAlive } from "@/lib/keepAlive";

export const dynamic = "force-dynamic";
export const revalidate = 0;

// ---------------------------------------------------------------------------
// R3.2.3 (finding S13) — this route reads the run ledger instead of guessing
// backwards from `scan_jobs.heartbeat_at`.
// ---------------------------------------------------------------------------
//
// WHAT IT USED TO DO, AND WHY THAT WAS A GUESS
// The only evidence this route had about execution was one mutable column:
// `scan_jobs.heartbeat_at`, stamped by `updateScanJob` on literally every write,
// including ones that only nudge `progress_pct`. From that single timestamp it
// inferred "is anybody working on this job" via `shouldRescueJob(job)` — and
// then told the client nothing about the answer. So a job whose chunk had died
// twenty minutes ago after closing FAILED with 12 probes attempted and 0
// succeeded produced byte-for-byte the same response as a healthy job mid-probe:
// `{ status: "probing", progress_pct: 62 }`. The poller cannot tell those apart,
// so it does the only thing it can — keep polling until its 15-minute timeout.
// "Unknown", "not finished" and "failed" were one answer.
//
// WHAT IT DOES NOW
// `scan_runs` (migration 011) is an append-only ledger with an open/closed state
// machine the database enforces: `scan_runs_open_chk` makes `outcome IS NULL`
// and `ended_at IS NULL` agree, so a row is either a live execution or a verdict
// on a finished one, never both and never neither. Migration 011 built
// `scan_runs_job_idx (scan_job_id, started_at DESC)` for exactly this read and
// says so — "the status route's read (R3.2.3), which today guesses from
// heartbeat_at instead". This is that reader.
//
// The ledger answers what the heartbeat could not:
//   * an OPEN row is an executor that announced itself, with a worker_id;
//   * a CLOSED row carries an outcome AND a reason;
//   * ZERO rows means nothing has ever run for this job — a measured zero,
//     which is a different fact from "the ledger could not be read".
//
// HEARTBEATS ARE NOT GONE FROM THE UNIVERSE, AND THAT IS NOT A LOOPHOLE
// Deciding whether an OPEN row still has a writer needs a clock: that is what
// `scan_runs.heartbeat_at` is for and what R3.3.2's reaper reads through
// `scan_runs_open_idx`. The difference is not "no timestamps" — it is that the
// timestamp now dates a specific declared execution instead of standing in for
// one. An open row with a stale beat is reported as `stalled`: a third answer,
// distinct from `running` and from the closed outcomes, and it is exactly the
// row R3.3.2 will close as 'reaped'.
//
// TWO COSTS, STATED RATHER THAN DISCOVERED LATER.
//
//  1. One extra indexed SELECT per poll (~every 2s per in-flight scan), plus up
//     to RUN_HISTORY_LIMIT run summaries on the wire. That is the read
//     `scan_runs_job_idx` exists to serve, and the reason `detail` rides only on
//     the two rows that explain the present.
//
//  2. WITH NO SUPABASE CLIENT — local dev, in-memory `scan_jobs` — there is no
//     ledger, so the executor state is `unknown` and this route NO LONGER KICKS
//     A RESCUE AT ALL. That is a deliberate loss, not an oversight: falling back
//     to `scan_jobs.heartbeat_at` when the ledger is unreachable would be the
//     removed guess, kept behind a condition, and it would fire in exactly the
//     situation where nothing can check it. The refusal is visible in the
//     response (`execution.rescue.reason = "run_history_unknown"`) and on
//     stderr. In that mode the chunk kicked by POST /api/scan still runs in the
//     same process, and /api/scan/worker's sweep is unaffected — it is a
//     different call site with its own decision.
//
// The stderr line is emitted on EVERY poll while the ledger is unreadable, so a
// local dev session prints it once per tick. Repetition is the lesser evil: the
// alternative is a degradation that announces itself once and then looks
// exactly like health for the next twelve minutes.
//
// WHAT THE LEDGER MAY SAY OUT LOUD is a separate question from what it knows,
// and this route answers it to ANONYMOUS callers. See "THE SERIALISATION
// BOUNDARY" below before adding a field to the `execution` block.

/**
 * How many recent runs the response carries. A bound, not a total: the query
 * asks for one more than this so `truncated` can be reported honestly, and
 * `runs_returned` is never presented as "how many times this job has run".
 */
export const RUN_HISTORY_LIMIT = 10;

/**
 * What the ledger says is executing right now. Five answers, because the four
 * real states and "I could not look" are five different things.
 */
export const EXECUTOR_STATES = Object.freeze({
  /** An open run whose heartbeat is fresh. Somebody is working on this job. */
  RUNNING: "running",
  /** An open run whose heartbeat has gone stale. Its writer is gone; R3.3.2 reaps it. */
  STALLED: "stalled",
  /** The read succeeded, every run is closed. Between chunks, or finished. */
  IDLE: "idle",
  /** The read succeeded and there are NO rows. Nothing has ever run. Measured zero. */
  NEVER_RAN: "never_ran",
  /** The ledger could not be read, or an open run could not be dated. NOT a state. */
  UNKNOWN: "unknown",
});

/** Why the run history is unknown. Four causes, never collapsed into "no runs". */
export const HISTORY_UNKNOWN_REASONS = Object.freeze({
  /** No Supabase client at all (local dev / in-memory jobs). There is no ledger to read. */
  NO_DATABASE: "no_database_configured",
  /** The SELECT failed. Transient or not, it is not evidence of an empty history. */
  READ_FAILED: "read_failed",
  /** A row came back in a shape `normalizeRun` refuses — e.g. half-closed. */
  ROW_UNREADABLE: "row_unreadable",
  /** An open run whose heartbeat_at cannot be parsed: staleness is unmeasurable. */
  OPEN_RUN_UNDATED: "open_run_heartbeat_unreadable",
});

/**
 * Why the poll-driven rescue did or did not fire. Every path names itself:
 * a rescue that silently does not happen is indistinguishable from a rescue
 * that happened and achieved nothing (standing rule 1).
 */
export const RESCUE_REASONS = Object.freeze({
  /** complete/failed. Nothing to resume. */
  JOB_TERMINAL: "job_terminal",
  /** The ledger could not be read, so "is anybody running this" has no answer. */
  HISTORY_UNKNOWN: "run_history_unknown",
  /** An open run is beating. Kicking would only lose a claim. */
  EXECUTOR_ALIVE: "executor_alive",
  /** No live executor, but something signed on recently. Give it the window. */
  SETTLING: "recent_sign_of_life",
  /** The job carries no usable created_at and has no runs: nothing to measure quiet from. */
  UNDATED_JOB: "job_created_at_unreadable",
  /** Nobody is running this job and nothing has for a full staleness window. */
  NO_LIVE_EXECUTOR: "no_live_executor",
});

// ---------------------------------------------------------------------------
// THE SERIALISATION BOUNDARY (R3.2.3, security re-work)
//
// This route is ANONYMOUSLY REACHABLE. `isPublicRoute` in
// src/lib/operatorPerimeter.js matches `GET /api/scan/<id>/status` in
// PUBLIC_PATTERNS, so no credential of any kind is required to read this body —
// a job_id is an unguessable v4 uuid, but anyone may start a free scan and then
// poll it. Everything below therefore treats `scan_runs` as an INTERNAL table
// being published to the public: a row's columns are written by
// `chunkRunOutcome` from provider errors, DB errors and thrown `Error.message`
// text, none of which was ever written with an anonymous reader in mind.
//
// The rule is an ALLOWLIST, not a denylist, for the same reason the perimeter
// itself is: a denylist of known-bad keys re-opens the moment a writer adds a
// field, and `detail` is a jsonb column any future chunk can put anything in.
//
// Three channels are closed here, and each has a named replacement rather than
// a silent deletion (standing rule 1):
//   * `run.error`   -> `error_code`, a fixed vocabulary. The text itself stays
//                      in `scan_runs.error` and in the chunk's own
//                      `console.error`, where an operator with database or log
//                      access reads it. WHY the run failed is already public
//                      and machine-readable in `reason`.
//   * `run.detail`  -> `RUN_DETAIL_PUBLIC_KEYS` only, with `skips` reduced to
//                      `{reason, count}` (its `sample` strings are built from
//                      provider names and raw provider/DB error text in
//                      scanWorker.js) and a MEASURED count of what was withheld.
//   * `unknown_detail` -> a fixed sentence, matching the sibling refusal in the
//                      `getScanJob` catch below, which already declines to put
//                      a database's own words on the wire and says why.
// ---------------------------------------------------------------------------

/**
 * The `detail` keys an anonymous caller may see, and the ONLY ones.
 *
 * Every entry is a bounded vocabulary written by `chunkRunOutcome`
 * (src/lib/workers/scanWorker.js): phase names, chunk reasons, a schedule-row
 * state, integers. Nothing here is free text assembled from an exception.
 *
 * ADDING TO THIS LIST IS THE DANGEROUS EDIT IN THIS FILE. A key belongs here
 * only if every value it can ever hold comes from a vocabulary this repo
 * declares — not from `err.message`, not from a provider's response body, not
 * from a URL or a host name. If in doubt leave it out: an omitted key is
 * counted in `detail.withheld_keys`, so it is visible rather than lost.
 */
export const RUN_DETAIL_PUBLIC_KEYS = Object.freeze([
  "phases_run",
  "chunk_reason",
  "skips_total",
  "schedule_row",
  "progress_pct",
  "job_status",
  "attempts",
  "max_attempts",
]);

/**
 * What the wire says about a run's `error` column, without saying what it says.
 * Three answers, because "no error was recorded" and "an error was recorded and
 * you are not being shown it" are different facts, and so is "the column held
 * something this route cannot classify".
 */
export const RUN_ERROR_CODES = Object.freeze({
  /** The column is NULL/empty: this run recorded no error text. A measured none. */
  NONE: "none",
  /** The run recorded error text. It is operator-only; `reason` says why it failed. */
  RECORDED: "error_recorded",
  /** The column held something that is not a string. Classified, not published. */
  UNREADABLE: "error_unreadable",
});

/** JSON scalars are the only leaf values an allowlisted key may carry. */
function isWireScalar(value) {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}

/** A scalar, or a flat array of them (`phases_run`). Anything deeper is withheld. */
function isWirePublishable(value) {
  if (isWireScalar(value)) return true;
  return Array.isArray(value) && value.every(isWireScalar);
}

/**
 * Classify a run's error column. Never returns the text.
 *
 * Exported so the classification is testable without a database, and so a guard
 * can assert the vocabulary is closed.
 */
export function runErrorCode(error) {
  if (error === null || error === undefined) return RUN_ERROR_CODES.NONE;
  if (typeof error !== "string") return RUN_ERROR_CODES.UNREADABLE;
  return error.trim() === "" ? RUN_ERROR_CODES.NONE : RUN_ERROR_CODES.RECORDED;
}

/**
 * One run's `detail` jsonb, reduced to what an anonymous caller may see.
 *
 * The count of withheld keys rides along: a filtered object that looks complete
 * is how a reader concludes a chunk recorded nothing when in fact it recorded
 * something this boundary refused to publish. `withheld_keys: 0` is the
 * measured claim "you are seeing all of it"; `null` is "I could not even count".
 */
export function publicRunDetail(detail) {
  // The writer recorded no detail at all. Not the same as "recorded detail,
  // all of it withheld" — that comes back as an object with a count.
  if (detail === null || detail === undefined) return null;

  // jsonb can hold a scalar or an array. Neither has keys to allow, and neither
  // is a shape this route knows how to vet, so nothing of it is published and
  // the count of what was dropped is honestly unmeasurable.
  if (typeof detail !== "object" || Array.isArray(detail)) {
    return { withheld_keys: null };
  }

  const wire = {};
  let withheld = 0;
  for (const [key, value] of Object.entries(detail)) {
    if (key === "skips") {
      // R3.2.2's skip entries are `{reason, count, sample[], sample_truncated}`.
      // `reason` is a declared CHUNK_SKIP_REASONS value and `count` is an
      // integer; `sample` is built from provider names and raw provider/DB
      // error text (scanWorker.js recordSkip call sites) and never crosses.
      if (value === null || value === undefined) {
        // NOT MEASURED — no phase armed the list. Preserved as null, never [].
        wire.skips = null;
      } else if (Array.isArray(value)) {
        wire.skips = value.map((entry) => ({
          reason: entry && typeof entry.reason === "string" ? entry.reason : null,
          // Never `?? 0`: a skip entry that did not carry a count is unknown,
          // and "0 of them" would be a number nobody measured (rule 5).
          count: entry && Number.isInteger(entry.count) ? entry.count : null,
        }));
      } else {
        withheld += 1;
      }
      continue;
    }
    if (!RUN_DETAIL_PUBLIC_KEYS.includes(key) || !isWirePublishable(value)) {
      withheld += 1;
      continue;
    }
    wire[key] = Array.isArray(value) ? [...value] : value;
  }
  wire.withheld_keys = withheld;
  return wire;
}

/** The columns the wire carries. `detail` is fetched but only rides on the two runs that explain the present. */
const RUN_COLUMNS =
  "id,runner,phase,worker_id,scan_job_id,batch_id,brand,outcome,reason," +
  "probes_attempted,probes_succeeded,errors_recovered,error,detail," +
  "started_at,heartbeat_at,ended_at";

/** ms since an ISO timestamp, or null when it cannot be dated. Never 0 for "unknown". */
function msSince(iso, nowMs) {
  if (iso === null || iso === undefined) return null;
  const t = new Date(iso).getTime();
  return Number.isFinite(t) ? nowMs - t : null;
}

/**
 * One run on the wire. Counters pass through `normalizeRun`'s null-preserving
 * read, so "not measured" arrives as null and the renderer owes it an em dash
 * (standing rule 5) — never a 0 that looks like a measurement.
 */
function runSummary(run, { withDetail = false } = {}) {
  const wire = {
    id: run.id,
    runner: run.runner,
    phase: run.phase,
    worker_id: run.workerId,
    outcome: run.outcome,
    reason: run.reason,
    probes_attempted: run.probesAttempted,
    probes_succeeded: run.probesSucceeded,
    errors_recovered: run.errorsRecovered,
    // NOT the chunk's `err.message` (scanWorker.js's catch puts raw exception
    // text in this column). A public body gets the classification; the text is
    // operator-only. `reason` above already carries the machine-readable WHY.
    error_code: runErrorCode(run.error),
    started_at: run.startedAt,
    heartbeat_at: run.heartbeatAt,
    ended_at: run.endedAt,
    open: run.open,
  };
  // The whole history's `detail` on a 2-second poll would multiply the payload
  // by RUN_HISTORY_LIMIT for facts about executions that already ended. The two
  // runs that explain the CURRENT state carry theirs (R3.2.2's skip reasons live
  // in there); the rest are summaries.
  // Allowlisted, never passed through whole: `detail` is an open jsonb column
  // and anything a future writer puts in it would otherwise become public with
  // no code change at all.
  if (withDetail) wire.detail = publicRunDetail(run.detail);
  return wire;
}

/**
 * The ledger's account of this job, as a pure function of its rows.
 *
 * `runs` must be newest-first and already normalized. Returns the executor
 * state plus the newest timestamp anything connected with this job was known to
 * be alive — an open run's beat, or a closed run's ending.
 */
export function summarizeRuns(runs, nowMs, staleAfterMs = HEARTBEAT_STALE_MS) {
  if (!Array.isArray(runs) || runs.length === 0) {
    return {
      executor: EXECUTOR_STATES.NEVER_RAN,
      unknownReason: null,
      openRun: null,
      openRunOrphaned: null,
      lastRun: null,
      openRunCount: 0,
      lastSignOfLife: null,
    };
  }

  const at = (iso) => {
    const t = iso === null || iso === undefined ? NaN : new Date(iso).getTime();
    return Number.isFinite(t) ? t : null;
  };

  const openRuns = runs.filter((r) => r.open);
  const lastRun = runs[0];

  // The open row with the FRESHEST beat, not the one that started last: the
  // question is "is anybody alive", and the best evidence for that is the most
  // recent beat anybody managed. An open row with no readable beat is counted
  // but cannot answer it.
  let openRun = null;
  let openBeatMs = null;
  for (const run of openRuns) {
    const t = at(run.heartbeatAt);
    if (t === null) continue;
    if (openBeatMs === null || t > openBeatMs) {
      openBeatMs = t;
      openRun = run;
    }
  }

  // Newest evidence of life across every row, and separately across the CLOSED
  // ones. A closed run's heartbeat_at is set to its ended_at by close_scan_run,
  // so taking the max of both needs no case analysis and cannot be fooled by a
  // row that ended without a final beat.
  let lastSignMs = null;
  let lastSignIso = null;
  let lastClosedSignMs = null;
  for (const run of runs) {
    for (const iso of [run.heartbeatAt, run.endedAt]) {
      const t = at(iso);
      if (t === null) continue;
      if (lastSignMs === null || t > lastSignMs) {
        lastSignMs = t;
        lastSignIso = iso;
      }
      if (!run.open && (lastClosedSignMs === null || t > lastClosedSignMs)) lastClosedSignMs = t;
    }
  }

  const base = {
    openRun: openRun || openRuns[0] || null,
    lastRun,
    openRunCount: openRuns.length,
    lastSignOfLife: lastSignIso,
  };

  if (openRuns.length === 0) {
    return { ...base, executor: EXECUTOR_STATES.IDLE, unknownReason: null, openRunOrphaned: null };
  }

  if (openRun === null) {
    // Every open row is undated. A row nobody can date is not evidence that its
    // writer died, and it is not evidence that it lives. R3.3.2's reaper refuses
    // to reap one for the same reason; this refuses to call it either state.
    return {
      ...base,
      executor: EXECUTOR_STATES.UNKNOWN,
      unknownReason: HISTORY_UNKNOWN_REASONS.OPEN_RUN_UNDATED,
      openRunOrphaned: null,
    };
  }

  // Strictly greater: exactly at the threshold is not yet stale, matching
  // runStaleness() in scanWorker.js.
  if (nowMs - openBeatMs <= staleAfterMs) {
    return { ...base, executor: EXECUTOR_STATES.RUNNING, unknownReason: null, openRunOrphaned: false };
  }

  // A STALE open row does not by itself mean the job is stalled. A chunk that
  // died without closing leaves its row open forever until R3.3.2's reaper gets
  // to it (2 x TTL), and meanwhile the sweep may already have run a REPLACEMENT
  // chunk that opened, worked and closed cleanly. If a closed run signed off
  // AFTER this row's last beat, the row is an orphan awaiting a reap, not the
  // current state of the job — calling it "stalled" would report a dead
  // predecessor as the present.
  if (lastClosedSignMs !== null && lastClosedSignMs > openBeatMs) {
    return { ...base, executor: EXECUTOR_STATES.IDLE, unknownReason: null, openRunOrphaned: true };
  }
  return { ...base, executor: EXECUTOR_STATES.STALLED, unknownReason: null, openRunOrphaned: false };
}

/**
 * Should this poll kick a chunk? Pure, so the one decision the endpoint makes
 * on the client's behalf is testable without a database.
 *
 * TWO INPUTS, DELIBERATELY SEPARATED. "Is an executor alive" is now answered by
 * the LEDGER — that is the inference this task removes from `heartbeat_at`. "How
 * long to wait before kicking an idle job" is a debounce, not an inference, and
 * it is kept at HEARTBEAT_STALE_MS so the *timing* of the P0.2 poll-driven
 * rescue is unchanged: `createScanJob` stamps `heartbeat_at` at creation and
 * every chunk write restamps it, so the old rule fired one staleness window
 * after the last write, and this one fires one window after the last ledger sign
 * of life. Same clock, evidence instead of a proxy.
 *
 * The quiet window is measured from the job's `created_at` when there are no
 * runs at all — that is not a heartbeat and not a liveness signal, it is the
 * only date a never-executed job has, and it reproduces exactly what the old
 * rule did with the creation-time heartbeat stamp.
 */
export function decideRescue({ job, summary, historyKnown, nowMs, staleAfterMs = HEARTBEAT_STALE_MS }) {
  const undecided = (reason) => ({ rescue: false, reason, quietMs: null, quietFrom: null });

  if (job && (job.status === "complete" || job.status === "failed")) {
    return undecided(RESCUE_REASONS.JOB_TERMINAL);
  }
  if (!historyKnown || !summary) {
    return undecided(RESCUE_REASONS.HISTORY_UNKNOWN);
  }
  if (summary.executor === EXECUTOR_STATES.RUNNING) {
    return undecided(RESCUE_REASONS.EXECUTOR_ALIVE);
  }
  if (summary.executor === EXECUTOR_STATES.UNKNOWN) {
    return undecided(RESCUE_REASONS.HISTORY_UNKNOWN);
  }

  // Which clock this decision ran on is reported, not implied: "3 minutes since
  // the last run ended" and "3 minutes since the job was created and nothing
  // has ever run" are the same number and different facts.
  const fromSign = summary.lastSignOfLife !== null;
  const quietMs = fromSign
    ? msSince(summary.lastSignOfLife, nowMs)
    : msSince(job && job.created_at, nowMs);
  const quietFrom = fromSign ? "last_sign_of_life" : "job_created_at";
  if (quietMs === null) {
    return undecided(RESCUE_REASONS.UNDATED_JOB);
  }
  if (quietMs > staleAfterMs) {
    return { rescue: true, reason: RESCUE_REASONS.NO_LIVE_EXECUTOR, quietMs, quietFrom };
  }
  return { rescue: false, reason: RESCUE_REASONS.SETTLING, quietMs, quietFrom };
}

/**
 * Read this job's run history.
 *
 * NEVER FAILS SOFT INTO AN EMPTY HISTORY. Every way this can fail to produce
 * rows returns `known: false` with a named cause, because `runs: []` is the
 * claim "this job has never run", which is a fact — and one this function is in
 * no position to assert when the SELECT threw. `[]` and `null` are two answers
 * here and must stay two answers all the way to the renderer.
 *
 * `detail` IS PUBLIC TEXT. It is serialised to an anonymous caller as
 * `execution.unknown_detail`, so it is a fixed sentence on every path and the
 * database's own message is written to `console.error` instead. Redacting here
 * rather than at the response keeps the raw string from existing in the
 * returned object at all, so a future caller that forwards `history.detail`
 * somewhere else cannot re-open the channel.
 *
 * Exported for its own tests: GET re-applies the same `known` guard when it
 * builds the response, and a contract enforced twice is a contract that cannot
 * be observed being broken in one place. `deps.client` style injection is not
 * available here — the client is a parameter — so the tests pass their own.
 */
export async function readRunHistory(jobId, client) {
  if (!client) {
    return {
      known: false,
      reason: HISTORY_UNKNOWN_REASONS.NO_DATABASE,
      detail:
        "No Supabase client is configured, so scan_runs cannot be read. This job's execution " +
        "history is unknown — not empty.",
      runs: null,
      truncated: null,
    };
  }

  let rows;
  try {
    const { data, error } = await client
      .from("scan_runs")
      .select(RUN_COLUMNS)
      .eq("scan_job_id", jobId)
      .order("started_at", { ascending: false })
      // One more than we report, so truncation is measured rather than assumed.
      .limit(RUN_HISTORY_LIMIT + 1);
    if (error) throw error;
    rows = data || [];
  } catch (error) {
    // The database's own words go to the LOG, where an operator reads them,
    // and never into the returned `detail` — see the boundary note above and
    // the identical refusal in GET's `getScanJob` catch. A PostgREST error
    // message routinely names hosts, roles, schemas and policies.
    console.error(`[status] scan_runs read failed for job ${jobId}:`, error);
    return {
      known: false,
      reason: HISTORY_UNKNOWN_REASONS.READ_FAILED,
      detail:
        "The run ledger could not be read on this poll, so this job's execution history is " +
        "unknown — not empty. Retry on the next poll.",
      runs: null,
      truncated: null,
    };
  }

  const truncated = rows.length > RUN_HISTORY_LIMIT;
  try {
    // normalizeRun REFUSES a half-closed row (ended with no outcome). One such
    // row makes the whole history unreadable rather than partly reported: a
    // history missing the row that explains everything is worse than an
    // admitted unknown, and dropping it quietly is how a reader learns nothing.
    const runs = rows.slice(0, RUN_HISTORY_LIMIT).map((row) => normalizeRun(row));
    return { known: true, reason: null, detail: null, runs, truncated };
  } catch (error) {
    // Same refusal, and not a theoretical one here: normalizeRun's half-closed
    // message quotes the row's id, outcome and ended_at verbatim.
    console.error(`[status] scan_runs row unreadable for job ${jobId}:`, error);
    return {
      known: false,
      reason: HISTORY_UNKNOWN_REASONS.ROW_UNREADABLE,
      detail:
        "A run ledger row could not be read, so this job's execution history is unknown — not " +
        "empty. The row is on the server log.",
      runs: null,
      truncated: null,
    };
  }
}

export async function GET(request, { params }) {
  params = await params;
  try {
    const { job_id } = params;
    if (!job_id) {
      return NextResponse.json({ detail: "Job ID is required." }, { status: 400 });
    }

    let job;
    try {
      job = await getScanJob(job_id);
    } catch (error) {
      // Transient DB read failure. The client (services/api.js) tolerates up
      // to 5 CONSECUTIVE poll errors before giving up on an otherwise-healthy
      // multi-minute scan, but a hard 500 here would burn one of those for
      // what's often a one-tick blip. Answering 200 instead keeps the poll
      // loop alive for the next tick (2s later) to retry the read; if the DB
      // is genuinely down, every subsequent tick fails this same read and the
      // client's own timeout still bounds how long a user waits. Chosen
      // deliberately over a 503 — documented here per P0.2's "your call" note.
      //
      // R2.8.3 (finding A11): this used to answer `status: "working"`, which
      // claimed a reading it did not have. The client mapped it to stage 0 and
      // rendered `progress_pct: null` as "% complete", rewinding a half-done
      // scan to an empty bar. The status is now "unknown" and says so in three
      // ways the client can act on — status, transient_error, progress_known —
      // and progress_pct stays null (never 0), because we did not measure it.
      console.error(`Transient error reading job ${job_id}:`, error);
      return NextResponse.json(
        {
          status: "unknown",
          progress_pct: null,
          progress_known: false,
          transient_error: true,
          detail: "Job status is temporarily unreadable. Retry on the next poll.",
        },
        { status: 200, headers: { "Cache-Control": "no-store, no-cache, must-revalidate" } }
      );
    }

    if (job?.brand_key) {
      const { getCustomerContext } = await import("@/lib/supabase/customer");
      const context = await getCustomerContext();
      if (context.error || !context.brands.some((brand) => brand.brandKey === job.brand_key)) {
        return NextResponse.json({ detail: "Job not found." }, { status: 404 });
      }
    }

    if (!job) {
      return NextResponse.json({ detail: "Job not found." }, { status: 404 });
    }

    const nowMs = Date.now();
    const history = await readRunHistory(job.id, supabase);
    const summary = history.known ? summarizeRuns(history.runs, nowMs) : null;
    const executor = summary ? summary.executor : EXECUTOR_STATES.UNKNOWN;
    const unknownReason = history.known
      ? summary.unknownReason
      : history.reason;

    // Poll-driven rescue (P0.2): this route is already polled every ~2s by
    // the client, so piggyback the staleness check here instead of relying
    // solely on the cron sweep — a frozen/dropped chunk resumes within one
    // poll tick instead of waiting for the next cron interval. Fire-and-forget:
    // the status response must not wait on the rescued chunk to finish.
    //
    // R3.2.3: the trigger is now the LEDGER's account of who is executing, not
    // `shouldRescueJob(job)`'s reading of `scan_jobs.heartbeat_at`. The verdict —
    // including every reason NOT to fire — rides on the response, because a
    // rescue that quietly did not happen looks exactly like one that happened
    // and achieved nothing.
    const verdict = decideRescue({ job, summary, historyKnown: history.known, nowMs });
    if (verdict.rescue) {
      keepAlive(() => runScanChunk(job.id), { label: `[status-rescue] resume of job ${job.id}` });
    } else if (verdict.reason === RESCUE_REASONS.HISTORY_UNKNOWN) {
      // The one refusal that is not a decision: we did not decline to rescue,
      // we could not tell whether to. Say it out loud on the server too — the
      // body says it to the client, this says it to whoever reads the logs.
      console.warn(
        `[status-rescue] job ${job.id}: NOT rescuing and NOT declining — the run ledger is ` +
          `unreadable (${unknownReason}). Executor state is unknown, not idle.`
      );
    }

    return NextResponse.json(
      {
        id: job.id,
        brand: job.brand,
        status: job.status,
        progress_pct: job.progress_pct,
        result_id: job.result_id,
        error_message: job.error_message,
        created_at: job.created_at,
        run_record: job.run_record,
        // R03.4a — the SAME versioned collection outcome the persisted report,
        // history and export carry, read back through the one shared reader so a
        // status poll and a finished report for the same scan cannot disagree on
        // the outcome or on any counter. `run_record.summary_stats.terminal_outcome`
        // is written once, by the finalizer; this is that record, unchanged.
        //
        // `status` above remains the EXECUTION lifecycle (the worker finished or
        // not). The collection outcome is a separate axis on purpose: A07 was a
        // "complete" execution being read as a successful measurement.
        terminal_outcome: terminalOutcomeFromRecord(job.run_record),
        // R3.2.3 — what the ledger says actually executed.
        //
        // `history_known: false` means this whole block is an admitted absence.
        // It never degrades into an empty history (`runs: []` is the assertion
        // "this job has never run", which a failed SELECT cannot support), and
        // it never turns a real `status`/`progress_pct` reading into a transient
        // error — the job row WAS read, and only the ledger was not.
        //
        // `history_known: true` with `executor: "unknown"` is a third thing
        // again: the rows came back, and an open one could not be dated.
        execution: {
          history_known: history.known,
          unknown_reason: unknownReason,
          // A FIXED sentence, never the database's message: this body is
          // served to anonymous callers (see the serialisation boundary note).
          unknown_detail: history.known ? null : history.detail,
          executor,
          open_run_count: summary ? summary.openRunCount : null,
          runs_returned: history.known ? history.runs.length : null,
          // Guarded on `known` like its neighbours rather than trusting
          // readRunHistory to have nulled it: `truncated: false` is the claim
          // "you are seeing all of them", and an unread history supports no
          // claim about its own size.
          truncated: history.known ? history.truncated : null,
          last_sign_of_life: summary ? summary.lastSignOfLife : null,
          // How long since anything about this job was known to be alive. NULL
          // when nothing ever has been — a job with no runs is not 0ms quiet,
          // it is unmeasured (standing rule 5).
          quiet_ms: summary ? msSince(summary.lastSignOfLife, nowMs) : null,
          open_run: summary && summary.openRun ? runSummary(summary.openRun, { withDetail: true }) : null,
          // True when `open_run` is a row whose writer died and which a LATER
          // run has already superseded: an unreaped leftover, not the executor.
          // Reporting it as the job's state would name a dead predecessor as
          // the present; hiding it would lose the fact that a row is unreaped.
          open_run_orphaned: summary ? summary.openRunOrphaned : null,
          last_run: summary && summary.lastRun ? runSummary(summary.lastRun, { withDetail: true }) : null,
          runs: history.known ? history.runs.map((run) => runSummary(run)) : null,
          rescue: {
            fired: verdict.rescue,
            reason: verdict.reason,
            // The clock this decision actually ran on, and against what.
            quiet_ms: verdict.quietMs,
            quiet_from: verdict.quietFrom,
            stale_after_ms: HEARTBEAT_STALE_MS,
          },
        },
      },
      {
        headers: {
          "Cache-Control": "no-store, no-cache, must-revalidate",
        },
      }
    );
  } catch (error) {
    console.error("Error retrieving job status:", error);
    return NextResponse.json({ detail: "Internal Server Error" }, { status: 500 });
  }
}
