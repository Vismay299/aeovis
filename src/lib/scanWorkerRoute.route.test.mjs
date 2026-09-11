/**
 * R3.1.3 — GET /api/scan/worker tells the truth about the chunk it ran.
 *
 * THE FINDING, verbatim from production: a garbage `job_id` answered
 * HTTP 200 `{"processed":1,"job_id":"…","mode":"direct-resume"}`. runScanChunk
 * had returned `{ok:false, reason:"read_failed"}` and the route counted it as
 * one processed job anyway, because line 61 reported `processed: 1`
 * unconditionally. On the route Vercel's cron drives daily, a chunk that did
 * nothing was indistinguishable from one that carried a scan to completion.
 * Standing rule 1: a skip is not a success.
 *
 * WHAT THIS SUITE DOES. It imports the REAL handler from
 * src/app/api/scan/worker/route.js through the same module-resolution hooks
 * cronAuth.route.test.mjs uses (they only answer "which file is this
 * specifier" for `@/` and `next/server` — nothing is stubbed, the handler body
 * and runScanChunk itself run unmodified) and asserts on the real Response.
 *
 * NO SCAN IS EVER STARTED, and no network call is made:
 *   - Supabase env is cleared before the route imports, so db.js's client is
 *     null. Every read/write goes to `global.memoryJobs`, the scan_runs ledger
 *     announces itself disabled, and the sweep path returns at `if (!supabase)`
 *     BEFORE it can list or resume anything.
 *   - Every job_id under test resolves to "no such job", "already finished" or
 *     "cannot read the store". runScanChunk returns from each of those before
 *     entering a work phase, so no prompt is sourced and no engine is probed.
 *
 * WHAT IT CANNOT DRIVE, stated rather than papered over: the `processed`
 * bucket. The only two chunk results that map to it — `complete` and
 * `checkpointed` — require a real probing or finalize phase, i.e. real Bright
 * Data and LLM spend. That branch is covered here at two removes instead: the
 * pure mapping function the route delegates to is asserted directly, and a
 * source guard pins the outcome->bucket line. Everything else in this file is
 * an observed Response.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { readFile } from "node:fs/promises";

const WORKER_URL = "https://aeovis.test/api/scan/worker";
const SECRET = "r313-worker-route-secret";

// ---------------------------------------------------------------------------
// Environment, fixed BEFORE the route module is imported (db.js and
// db/analytics.js build their clients at import time).
// ---------------------------------------------------------------------------
process.env.NODE_ENV = "production";
process.env.CRON_SECRET = SECRET;
delete process.env.NEXT_PUBLIC_SUPABASE_URL;
delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;

register("./cronAuth.route.hooks.mjs", import.meta.url);

let importError = null;
let GET = null;
let chunkRunOutcome = null;
let classifySchedulerTick = null;
let schedulerTickThrew = null;
let buildSweepResponse = null;
let runSweepMaintenance = null;
let reapCounters = null;
let reapPassThrew = null;
let REAP_WIRE_REASONS = null;
let runSchedulerTick = null;
let reapStaleRuns = null;
let SCHEDULER_SKIP_REASONS = null;
let SCHEDULER_TICK_REASONS = null;
let REAP_PASS_REASONS = null;
let REAP_MAX_PER_PASS = null;
try {
  ({
    GET,
    classifySchedulerTick,
    schedulerTickThrew,
    buildSweepResponse,
    runSweepMaintenance,
    reapCounters,
    reapPassThrew,
    REAP_WIRE_REASONS,
  } = await import("../app/api/scan/worker/route.js"));
  ({
    chunkRunOutcome,
    runSchedulerTick,
    reapStaleRuns,
    SCHEDULER_SKIP_REASONS,
    SCHEDULER_TICK_REASONS,
    REAP_PASS_REASONS,
    REAP_MAX_PER_PASS,
  } = await import("./workers/scanWorker.js"));
} catch (error) {
  importError = error;
}

function handler() {
  assert.equal(
    importError,
    null,
    "Could not import the worker route. If this says \"Cannot find package 'next'\", run " +
      `\`npm install\` — this suite exercises the real handler on purpose. Underlying: ${importError?.message}`
  );
  assert.equal(typeof GET, "function", "the worker route must export GET");
  return GET;
}

/** An authorized request, so every test below reaches the handler body. */
function authed(query = "") {
  return new Request(`${WORKER_URL}${query}`, { headers: { "x-cron-secret": SECRET } });
}

/** Assert a body does not, in any of its shapes, claim work that did not happen. */
function assertNotASuccess(body, label) {
  assert.notEqual(
    body.processed,
    1,
    `${label}: the response still reports processed:1 for a chunk that did no work — ` +
      `this is the R3.1.3 finding, exactly as production returned it (${JSON.stringify(body)})`
  );
  assert.equal(body.processed, 0, `${label}: processed must be a visible 0, not absent`);
  assert.notEqual(body.outcome, "processed", `${label}: outcome must not read as processed`);
}

test("the worker route module imports and exports GET", () => {
  handler();
});

// ---------------------------------------------------------------------------
// The criterion: a garbage job_id, driven through the real handler.
// ---------------------------------------------------------------------------

test("ROUTE — a garbage job_id is NOT reported as processed", async () => {
  const jobId = "not-a-real-job-id-💥";
  const response = await handler()(authed(`?job_id=${encodeURIComponent(jobId)}`));
  const body = await response.json();

  assertNotASuccess(body, "garbage job_id");
  assert.equal(body.outcome, "skipped");
  assert.equal(body.skipped, 1);
  assert.equal(body.failed, 0);
  assert.equal(body.reason, "not_found", "the reason the chunk gave must survive to the wire");
  assert.equal(body.job_id, jobId);
  assert.equal(body.mode, "direct-resume");

  // 200, deliberately: a job that is not there is a legitimate no-work
  // outcome, and paging an operator for one would be its own false alarm.
  assert.equal(response.status, 200, "an absent job is not a server error");
});

test("ROUTE — a chunk that could not read the job is reported as FAILED, with a 5xx", async () => {
  // The production case in the finding: getScanJob THROWS (there, because
  // Postgres rejects a non-uuid), runScanChunk returns
  // {ok:false, reason:"read_failed"}. Reproduced here by making the store the
  // in-memory getScanJob reads throw — the code under test is untouched, only
  // the data source it reads fails, which is what a DB read failure is.
  const realStore = global.memoryJobs;
  global.memoryJobs = {
    get() {
      throw new Error("simulated transient read failure");
    },
    set() {},
    values() {
      return [];
    },
  };
  try {
    const response = await handler()(authed("?job_id=6e89e308-0000-4000-8000-000000000000"));
    const body = await response.json();

    assertNotASuccess(body, "read_failed");
    assert.equal(body.outcome, "failed");
    assert.equal(body.failed, 1);
    assert.equal(body.skipped, 0);
    assert.equal(body.reason, "read_failed");
    assert.equal(
      response.status,
      500,
      "a chunk that ran and did not finish must not answer 200 — that is how read_failed hid"
    );
  } finally {
    global.memoryJobs = realStore;
  }
});

test("ROUTE — ok:true with no work done is skipped, not processed", async () => {
  // already_finished: the chunk looked, and the job was genuinely already
  // complete. ok is TRUE here, so "count anything ok:true as processed" would
  // pass the two tests above and still be wrong.
  const jobId = "r313-already-complete";
  global.memoryJobs.set(jobId, { id: jobId, brand: "acme", status: "complete" });
  try {
    const response = await handler()(authed(`?job_id=${jobId}`));
    const body = await response.json();

    assertNotASuccess(body, "already_finished");
    assert.equal(body.outcome, "skipped");
    assert.equal(body.skipped, 1);
    assert.equal(body.reason, "already_finished");
    assert.equal(response.status, 200);
  } finally {
    global.memoryJobs.delete(jobId);
  }
});

test("ROUTE — a checkpointed job in a status with no work is skipped, and says which status", async () => {
  const jobId = "r313-nothing-to-do";
  global.memoryJobs.set(jobId, {
    id: jobId,
    brand: "acme",
    status: "awaiting_review",
    checkpoint: { queries: [], engines: [] },
  });
  try {
    const response = await handler()(authed(`?job_id=${jobId}`));
    const body = await response.json();

    assertNotASuccess(body, "noop");
    assert.equal(body.outcome, "skipped");
    assert.equal(
      body.reason,
      "noop_status_awaiting_review",
      "an unexplained noop is exactly what the reason field exists to prevent"
    );
    assert.equal(response.status, 200);
  } finally {
    global.memoryJobs.delete(jobId);
  }
});

// ---------------------------------------------------------------------------
// The other path the cron actually drives: no job_id.
// ---------------------------------------------------------------------------

test("ROUTE — the no-job_id path reports dispatch, never 'processed'", async () => {
  // Vercel's cron calls this route with no query at all. With no Supabase it
  // returns before the sweep, so nothing is listed and nothing is resumed.
  const response = await handler()(authed());
  const body = await response.json();

  assert.equal(response.status, 200, "an idle cron tick is not a failure");
  assert.equal(body.mode, "no-db");
  assert.equal(body.dispatched, 0);
  assert.equal(
    body.processed,
    undefined,
    "this invocation ran no chunk, so it must not report a chunk outcome counter at all"
  );
});

// ---------------------------------------------------------------------------
// The mapping the route delegates to, and the guard that keeps it complete.
// ---------------------------------------------------------------------------

test("MAPPING — every reason runScanChunk can return is known to chunkRunOutcome", async () => {
  handler();
  const src = await readFile(new URL("./workers/scanWorker.js", import.meta.url), "utf8");
  const start = src.indexOf("export async function runScanChunk");
  assert.ok(start > 0, "runScanChunk must be findable in the source");
  const body = src.slice(start);
  const reasons = [...new Set([...body.matchAll(/reason:\s*"([a-z_]+)"/g)].map((m) => m[1]))];
  assert.ok(reasons.length >= 8, `expected the full reason vocabulary, found ${reasons.join(", ")}`);

  for (const reason of reasons) {
    const mapped = chunkRunOutcome({ reason });
    assert.doesNotMatch(
      mapped.reason,
      /^unmapped_chunk_reason/,
      `runScanChunk can return reason "${reason}" and the ledger has no case for it — ` +
        `the worker route buckets on this mapping, so an unmapped reason is a route-level lie too`
    );
  }
});

test("MAPPING — the two working outcomes are the only ones that mean 'processed'", () => {
  handler();
  assert.equal(chunkRunOutcome({ ok: true, reason: "complete" }).outcome, "succeeded");
  assert.equal(chunkRunOutcome({ ok: true, reason: "checkpointed" }).outcome, "succeeded");

  for (const reason of ["not_found", "sourcing_claimed_elsewhere", "finalize_claimed_elsewhere"]) {
    assert.equal(chunkRunOutcome({ reason }).outcome, "skipped", reason);
  }
  for (const reason of ["already_finished", "noop"]) {
    assert.equal(chunkRunOutcome({ reason }).outcome, "noop", reason);
  }
  for (const reason of ["read_failed", "error"]) {
    assert.equal(chunkRunOutcome({ reason }).outcome, "failed", reason);
  }
  // Nothing at all, and something invented: both failed, never rounded up.
  assert.equal(chunkRunOutcome(undefined).outcome, "failed");
  assert.equal(chunkRunOutcome({ ok: true, reason: "brand_new_reason" }).outcome, "failed");
});

test("GUARD — the route counts only a succeeded chunk as processed", async () => {
  const src = await readFile(new URL("../app/api/scan/worker/route.js", import.meta.url), "utf8");
  assert.match(
    src,
    /RUN_OUTCOMES\.SUCCEEDED[\s\S]{0,120}?"processed"/,
    "the processed bucket must be reached only from the SUCCEEDED ledger outcome"
  );
  assert.doesNotMatch(
    src,
    /\{\s*processed:\s*1\s*,/,
    "an unconditional processed:1 is the R3.1.3 defect — the counter must be derived from the result"
  );
});

// ---------------------------------------------------------------------------
// R3.2.6 — the SWEEP branch's scheduler report.
//
// THE FINDING. R3.2.2 taught runSchedulerTick to return `{started, skipped}`
// and to file a scan_runs row per declined brand. The route then did
// `scheduled = tickResult.started` and dropped `skipped` on the floor, so a
// tick that found brands due and declined every one of them went onto the wire
// as `scheduled: []` — byte-identical to a tick with nothing due. An operator
// watching the daily cron could not tell a starved scheduler from an idle one.
//
// HOW THIS IS DRIVEN, and what it cannot reach. The sweep branch of GET is
// behind `if (!supabase) return`, and this suite has no Supabase on purpose
// (see the file header: it is what guarantees no scan is ever started and
// nothing is written to a database). So these tests do not go through the HTTP
// handler. They drive the REAL runSchedulerTick — unmodified, with its backend
// injected through the deps it already accepts, exactly as
// scanChunkLedger.test.mjs drives it — and hand its REAL return value to the
// REAL functions the route builds its response body from. What is asserted is
// the object the route passes to NextResponse.json, plus a source guard
// pinning that the route actually routes the whole tick result through them.
// ---------------------------------------------------------------------------

/** A scheduler backend that cannot create a job unless the tick asks it to. */
function schedulerBackend({ due = [], active = new Set() } = {}) {
  const jobs = [];
  let n = 0;
  return {
    jobs,
    deps: {
      listDueSchedules: async () => due,
      hasActiveScanForBrand: async (brand) => active.has(brand),
      createScanJob: async (fields) => {
        const job = { id: `r326-job-${n++}`, ...fields };
        jobs.push(job);
        return job;
      },
      upsertScanSchedule: async () => ({}),
      // Fire-and-forget kick, stubbed to a no-op: a real one would start a scan,
      // which this suite must never do.
      runScanChunk: async () => {},
      schedulerId: "scheduler-r326",
    },
  };
}

function dueSchedule(brand, cadence = "daily", displayName = null) {
  return { brand, display_name: displayName, cadence, enabled: true, next_run_at: null };
}

const TICK_NOW = "2026-09-04T00:00:00.000Z";

/** Run the real tick quietly (its ledger-disabled warnings are not the subject). */
async function tick(backend) {
  const warn = console.warn;
  const error = console.error;
  console.warn = () => {};
  console.error = () => {};
  try {
    return await runSchedulerTick(TICK_NOW, backend.deps);
  } finally {
    console.warn = warn;
    console.error = error;
  }
}

/** The exact body the sweep branch hands to NextResponse.json. */
function sweepBody(scheduler, scheduled) {
  return buildSweepResponse({ activeCount: 0, resumedIds: [], scheduled, scheduler });
}

test("R3.2.6 — a tick that declined EVERY due brand is not reported as an idle tick", async () => {
  handler();

  // Two brands were due. One had its cadence flipped to 'off', one already has
  // a scan running. Neither was scanned, and no job was created.
  const starved = schedulerBackend({
    due: [dueSchedule("off-co.com", "off", "Off Co"), dueSchedule("busy.com", "daily", "Busy Co")],
    active: new Set(["Busy Co"]),
  });
  const starvedTick = await tick(starved);
  assert.equal(starved.jobs.length, 0, "the tick really did decline both — nothing was scanned");
  assert.deepEqual(starvedTick.started, [], "…so `started` is empty, which is what used to hide this");

  const quiet = schedulerBackend({ due: [] });
  const quietTick = await tick(quiet);
  assert.deepEqual(quietTick.started, []);

  const starvedBody = sweepBody(classifySchedulerTick(starvedTick), starvedTick.started);
  const quietBody = sweepBody(classifySchedulerTick(quietTick), quietTick.started);

  // THE CRITERION, stated the way the wire states it. Before R3.2.6 both of
  // these serialized to the same bytes; if they ever do again, this fails.
  assert.notEqual(
    JSON.stringify(starvedBody),
    JSON.stringify(quietBody),
    "a tick that declined every due brand serializes identically to an idle tick — " +
      "this is the R3.2.6 finding, back on the wire"
  );

  assert.equal(starvedBody.scheduler.outcome, "skipped");
  assert.equal(quietBody.scheduler.outcome, "idle");
  assert.notEqual(
    starvedBody.scheduler.outcome,
    quietBody.scheduler.outcome,
    "a starved scheduler and an idle one must not share an outcome"
  );

  // …and the reasons, which is the other half of the accept.
  assert.equal(starvedBody.scheduler.reason, SCHEDULER_TICK_REASONS.ALL_DUE_SKIPPED);
  assert.equal(quietBody.scheduler.reason, SCHEDULER_TICK_REASONS.NO_SCHEDULES_DUE);

  assert.equal(starvedBody.scheduler.due, 2, "two brands were due — the wire says so");
  assert.equal(starvedBody.scheduler.started, 0);
  assert.equal(starvedBody.scheduler.skipped, 2);
  assert.equal(quietBody.scheduler.due, 0, "an idle tick reports a measured zero, not an absent field");

  // Which brands, and why — verbatim from the ledger's own skip vocabulary.
  assert.deepEqual(starvedBody.scheduler.skips, [
    { brand: "Off Co", reason: SCHEDULER_SKIP_REASONS.CADENCE_OFF },
    { brand: "Busy Co", reason: SCHEDULER_SKIP_REASONS.BRAND_ALREADY_ACTIVE },
  ]);
  assert.deepEqual(starvedBody.scheduler.skip_reasons, {
    [SCHEDULER_SKIP_REASONS.CADENCE_OFF]: 1,
    [SCHEDULER_SKIP_REASONS.BRAND_ALREADY_ACTIVE]: 1,
  });
  assert.deepEqual(quietBody.scheduler.skips, [], "nothing was declined, so nothing is named");

  // Still a 200-shaped success: the tick itself did not fail, it declined.
  assert.equal(starvedBody.scheduler_ok, true);
  assert.equal(starvedBody.scheduler_error, null);
  // And the pre-existing field keeps its old meaning for anything reading it.
  assert.deepEqual(starvedBody.scheduled, []);
});

test("R3.2.6 — a tick that started a brand reads as started, and still names the ones it declined", async () => {
  handler();
  const backend = schedulerBackend({
    due: [dueSchedule("go.com", "daily", "Go Co"), dueSchedule("off-co.com", "off", "Off Co")],
  });
  const result = await tick(backend);
  assert.equal(backend.jobs.length, 1, "exactly the one due, enabled brand was scanned");

  const body = sweepBody(classifySchedulerTick(result), result.started);
  assert.equal(body.scheduler.outcome, "started");
  assert.equal(body.scheduler.reason, null, "it started work; there is no decline reason for the tick");
  assert.equal(body.scheduler.due, 2);
  assert.equal(body.scheduler.started, 1);
  assert.equal(
    body.scheduler.skipped,
    1,
    "one brand went unscanned — a partially starved tick must not round up to a clean success"
  );
  assert.deepEqual(body.scheduler.skips, [
    { brand: "Off Co", reason: SCHEDULER_SKIP_REASONS.CADENCE_OFF },
  ]);
  assert.equal(body.scheduled[0].brand, "Go Co");
});

test("R3.2.6 — the three tick states are three different bodies", async () => {
  handler();
  const backends = [
    schedulerBackend({ due: [] }),
    schedulerBackend({ due: [dueSchedule("off-co.com", "off", "Off Co")] }),
    schedulerBackend({ due: [dueSchedule("go.com", "daily", "Go Co")] }),
  ];
  const bodies = [];
  for (const backend of backends) {
    const result = await tick(backend);
    bodies.push(sweepBody(classifySchedulerTick(result), result.started));
  }

  const outcomes = bodies.map((b) => b.scheduler.outcome);
  assert.deepEqual(outcomes, ["idle", "skipped", "started"]);
  assert.equal(new Set(outcomes).size, 3, "nothing due / all declined / started must be three answers");
});

test("R3.2.6 — a tick that threw reports null counts, never a clean zero", () => {
  handler();
  const verdict = schedulerTickThrew(new Error("listDueSchedules exploded"));

  assert.equal(verdict.outcome, "failed");
  assert.equal(verdict.reason, SCHEDULER_TICK_REASONS.TICK_FAILED);
  for (const field of ["due", "started", "skipped", "skips", "skip_reasons"]) {
    assert.equal(
      verdict[field],
      null,
      `${field}: a tick that died mid-list never finished counting — 0 would be a count it never took`
    );
  }

  const body = sweepBody(verdict, null);
  assert.equal(body.scheduler_ok, false);
  assert.equal(body.scheduler_error, "listDueSchedules exploded", "the error still reaches the wire");
  assert.equal(body.scheduled, null, "never `?? []` a measurement that did not happen");
});

test("R3.2.6 — a tick result missing `skipped` fails loud instead of reading as idle", () => {
  handler();
  // The pre-R3.2.2 shape. If runSchedulerTick's contract ever regresses, the
  // route must not quietly report the resulting `{started: []}` as an idle
  // scheduler — that is the exact lie this task removes, one layer down.
  const verdict = classifySchedulerTick({ started: [] });

  assert.equal(verdict.outcome, "failed");
  assert.notEqual(verdict.outcome, "idle");
  assert.match(verdict.reason, /^scheduler_contract_broken:/);
  assert.equal(verdict.skipped, null, "unmeasured, not zero");
  assert.equal(sweepBody(verdict, []).scheduler_ok, false);
});

// ---------------------------------------------------------------------------
// R3.3.4 — the SWEEP branch's stale-run reap.
//
// THE FINDING. R3.3.2 built reapStaleRuns with 28 tests and could not wire it:
// this route belonged to another task that cycle. So the reaper was correct and
// unreached, and every run whose writer died stayed open forever, looking in
// the ledger exactly like work still in flight.
//
// HOW THIS IS DRIVEN. Same constraint as R3.2.6 above: the sweep branch of GET
// is behind `if (!supabase)` and this suite has no Supabase on purpose. So
// these tests drive `runSweepMaintenance` — the real function GET calls, with
// the real try/catch structure — and inject the two passes through the deps it
// accepts. The REAL reapStaleRuns runs in the first test below, against a fake
// ledger that enforces migration 011's close-once rule, so the counters
// asserted here are counters the production function actually produced. The
// call site itself is pinned by source guards, here and in
// src/lib/workers/scanRunReaper.test.mjs.
// ---------------------------------------------------------------------------

const REAP_NOW = "2026-09-08T12:00:00.000Z";

/** An open scan_runs row whose last beat was `ageMs` before REAP_NOW. */
function staleRow(id, ageMs) {
  const t0 = Date.parse(REAP_NOW);
  return {
    id,
    runner: "scan-chunk",
    phase: "probing",
    worker_id: `worker-${id}`,
    scan_job_id: `job-${id}`,
    batch_id: null,
    brand: "acme",
    outcome: null,
    started_at: new Date(t0 - ageMs - 1000).toISOString(),
    heartbeat_at: new Date(t0 - ageMs).toISOString(),
    ended_at: null,
  };
}

/**
 * A ledger the reaper can write to, enforcing the one invariant the sweep's
 * counters depend on: a row closes exactly once, and a second close RAISES with
 * migration 011's own sentence.
 */
function reapLedger() {
  const closed = [];
  const ended = new Set();
  return {
    closed,
    deps: {
      client: null,
      openScanRun: async ({ runner, phase, workerId }) => ({
        id: `pass-${runner}-${closed.length}`,
        runner,
        phase,
        workerId,
        outcome: null,
        open: true,
      }),
      closeScanRun: async ({ runId, outcome, reason }) => {
        if (ended.has(runId)) {
          throw new Error(`close_scan_run: run ${runId} was already closed as "reaped"`);
        }
        ended.add(runId);
        const row = {
          id: runId,
          runner: "scan-chunk",
          phase: "probing",
          outcome,
          reason,
          probesAttempted: null,
          probesSucceeded: null,
          errorsRecovered: null,
          open: false,
        };
        closed.push(row);
        return row;
      },
    },
  };
}

/** Run something whose own logging is not the subject. */
async function quietly(fn) {
  const warn = console.warn;
  const error = console.error;
  const log = console.log;
  console.warn = () => {};
  console.error = () => {};
  console.log = () => {};
  try {
    return await fn();
  } finally {
    console.warn = warn;
    console.error = error;
    console.log = log;
  }
}

/** The sweep's two maintenance passes, driven exactly as GET drives them. */
async function maintenance(deps) {
  return await quietly(() => runSweepMaintenance(REAP_NOW, deps));
}

test("R3.3.4 — the sweep runs the REAL reaper and its counters reach the wire", async () => {
  handler();
  const ledger = reapLedger();
  const rows = [staleRow("wedged-a", 900_000), staleRow("wedged-b", 600_000)];
  const backend = schedulerBackend({ due: [] });

  const { reaped, scheduler } = await maintenance({
    runSchedulerTick: async (now) => await runSchedulerTick(now, backend.deps),
    // The production function, unmodified — only its ledger and its listing are
    // fakes, the same injection points its own 28 tests use.
    reapStaleRuns: async (now) =>
      await reapStaleRuns(now, { ...ledger.deps, listStaleRuns: async () => rows }),
  });

  assert.equal(reaped.ok, true, "the pass closed both rows without a hard failure");
  assert.equal(reaped.considered, 2, "two stale candidates were looked at");
  assert.equal(reaped.reaped, 2, "…and both were actually closed");
  assert.equal(reaped.lost_race, 0, "a measured zero: nothing raced this pass");
  assert.equal(reaped.truncated, false, "the cap was not reached, and the wire says so as a boolean");
  assert.equal(reaped.outcome, "succeeded");
  assert.ok(reaped.pass_run_id, "the pass files a run of its own and names it on the wire");

  // The rows really closed as 'reaped', not as a bare failure.
  const reapedRows = ledger.closed.filter((r) => r.outcome === "reaped");
  assert.deepEqual(reapedRows.map((r) => r.id).sort(), ["wedged-a", "wedged-b"]);
  assert.match(reapedRows[0].reason, /^reaped/);

  // …and it is all on the body the cron reads.
  const body = buildSweepResponse({ activeCount: 0, resumedIds: [], scheduled: [], scheduler, reaped });
  for (const field of ["considered", "reaped", "lost_race", "truncated"]) {
    assert.ok(field in body.reaped, `the wire must carry ${field}`);
  }
  assert.equal(body.reaped.reaped, 2);
  assert.equal(body.scheduler.outcome, "idle", "the tick still reported for itself");
});

test("R3.3.4 — a reap that THROWS cannot fail the scheduler tick", async () => {
  handler();
  // A tick that really starts a brand, and a reaper that dies on its way to the
  // database. Before the wiring existed this could not happen; once it exists,
  // the failure mode to fear is a bookkeeping sweep taking down the cron's
  // actual job — and the sweep's outer try in GET would have answered 500 and
  // thrown away a tick that had already created the scan.
  const backend = schedulerBackend({ due: [dueSchedule("go.com", "daily", "Go Co")] });
  let threw = false;

  const { scheduled, scheduler, reaped } = await maintenance({
    runSchedulerTick: async (now) => await runSchedulerTick(now, backend.deps),
    reapStaleRuns: async () => {
      threw = true;
      throw new Error("scan_runs listing exploded");
    },
  });

  assert.equal(threw, true, "the reaper was genuinely reached — otherwise this proves nothing");
  assert.equal(backend.jobs.length, 1, "the tick still created the job it was due to create");
  assert.equal(scheduler.outcome, "started", "the tick still reports its OWN result");
  assert.equal(scheduler.started, 1);
  assert.equal(scheduled[0].brand, "Go Co");

  const body = buildSweepResponse({ activeCount: 0, resumedIds: [], scheduled, scheduler, reaped });
  assert.equal(body.scheduler_ok, true, "the scheduler did not fail, and must not be reported as failed");
  assert.equal(body.scheduler_error, null);

  // The reap failure is REPORTED, not swallowed: this is the difference between
  // isolating a failure and hiding one.
  assert.equal(body.reaped.ok, false);
  assert.equal(body.reaped.outcome, "failed");
  assert.equal(body.reaped.reason, REAP_PASS_REASONS.REAP_FAILED);
  assert.equal(body.reaped.error, "scan_runs listing exploded", "the message reaches the wire");
  for (const field of ["considered", "reaped", "lost_race", "truncated"]) {
    assert.equal(
      body.reaped[field],
      null,
      `${field}: a pass that died never finished counting — 0 would be a count it never took`
    );
  }
});

test("R3.3.4 — a scheduler tick that throws does not skip the reap", async () => {
  handler();
  // The other direction of the same isolation. A scheduler wedged by one bad
  // schedule row must not leave stale runs open forever — that pairing is how a
  // single fault becomes a permanently unreadable ledger.
  const ledger = reapLedger();
  const { scheduler, reaped } = await maintenance({
    runSchedulerTick: async () => {
      throw new Error("listDueSchedules exploded");
    },
    reapStaleRuns: async (now) =>
      await reapStaleRuns(now, { ...ledger.deps, listStaleRuns: async () => [staleRow("orphan", 900_000)] }),
  });

  assert.equal(scheduler.outcome, "failed");
  assert.equal(reaped.reaped, 1, "the reap ran anyway and closed the orphaned run");
  assert.ok(
    ledger.closed.some((r) => r.id === "orphan" && r.outcome === "reaped"),
    "the row was really closed, not merely counted"
  );
});

test("R3.3.4 — a truncated pass says MORE stale runs remain, never 'the ledger is clean'", async () => {
  handler();
  const ledger = reapLedger();
  const rows = [staleRow("a", 900_000), staleRow("b", 800_000), staleRow("c", 700_000)];
  const { reaped } = await maintenance({
    runSchedulerTick: async () => ({ started: [], skipped: [] }),
    reapStaleRuns: async (now) =>
      await reapStaleRuns(now, {
        ...ledger.deps,
        listStaleRuns: async ({ limit }) => rows.slice(0, limit + 1),
        maxPerPass: 2,
      }),
  });

  assert.equal(reaped.reaped, 2);
  assert.equal(reaped.considered, 2);
  assert.equal(
    reaped.truncated,
    true,
    "the cap was hit and a third row is still open — reporting only `reaped: 2` would read as done"
  );
});

test("R3.3.4 — a reap that could not LOOK reports nulls, never a clean zero", () => {
  handler();
  // The shape reapStaleRuns returns when there is no client and no injected
  // ledger: it could not list a single row. `considered: 0` here would tell an
  // operator the ledger was inspected and found healthy.
  const wire = reapCounters({
    ok: false,
    outcome: null,
    reason: "ledger_unavailable",
    considered: null,
    reaped: null,
    lostRace: null,
    truncated: null,
  });

  assert.equal(wire.ok, false);
  assert.equal(wire.reason, "ledger_unavailable");
  for (const field of ["considered", "reaped", "lost_race", "truncated"]) {
    assert.equal(wire[field], null, `${field} must stay NOT MEASURED`);
  }

  // And the measured-zero pass is a DIFFERENT body, which is the whole point.
  const lookedAndFoundNothing = reapCounters({
    ok: true,
    outcome: "noop",
    reason: "no_stale_runs",
    considered: 0,
    reaped: 0,
    lostRace: 0,
    vanished: 0,
    notStale: 0,
    unreadableHeartbeat: 0,
    closeFailed: 0,
    truncated: false,
    passRunId: "pass-1",
  });
  assert.equal(lookedAndFoundNothing.considered, 0);
  assert.notEqual(
    JSON.stringify(wire),
    JSON.stringify(lookedAndFoundNothing),
    "a sweep that could not look and a sweep that found nothing must not serialize the same"
  );
});

test("R3.3.4 — a sweep body built with no reap pass says so instead of omitting the key", () => {
  handler();
  const body = buildSweepResponse({
    activeCount: 0,
    resumedIds: [],
    scheduled: [],
    scheduler: classifySchedulerTick({ started: [], skipped: [] }),
  });

  assert.ok("reaped" in body, "an absent pass must still produce the key — a missing one reads as fine");
  assert.equal(body.reaped.reason, REAP_WIRE_REASONS.NOT_RUN);
  assert.equal(body.reaped.ok, false);
  assert.equal(body.reaped.considered, null);
});

test("R3.3.4 — an unusable reap result fails loud instead of reading as a clean sweep", () => {
  handler();
  for (const broken of [undefined, null, "done"]) {
    const wire = reapCounters(broken);
    assert.equal(wire.ok, false, `${JSON.stringify(broken)} must not read as a successful pass`);
    assert.match(wire.reason, /^reaper_contract_broken:/);
    assert.equal(wire.reaped, null, "never `?? 0` a count that was never taken");
  }
  // A pass object missing its counters is the same class of defect.
  const partial = reapCounters({ ok: true, outcome: "succeeded" });
  assert.equal(partial.considered, null);
  assert.equal(partial.truncated, null, "a non-boolean truncated is unknown, not false");
});

test("R3.3.4 — reapPassThrew keeps the pass vocabulary, not a word invented at the route", () => {
  handler();
  const wire = reapPassThrew(new Error("boom"));
  assert.equal(wire.reason, REAP_PASS_REASONS.REAP_FAILED);
  assert.equal(wire.error, "boom");
  assert.ok(Number.isInteger(REAP_MAX_PER_PASS) && REAP_MAX_PER_PASS > 0, "the cap is a real bound");
});

test("GUARD — the sweep route hands the WHOLE tick result to the classifier", async () => {
  const src = await readFile(new URL("../app/api/scan/worker/route.js", import.meta.url), "utf8");

  // Anchored on the ASSIGNMENT, not the bare call: `classifySchedulerTick(`
  // alone also matches this module's own `export function` line, so a route
  // that reverted to passing `{started: tickResult.started}` — the exact
  // R3.2.6 defect, one call frame later — would slip through.
  assert.match(
    src,
    /scheduler\s*=\s*classifySchedulerTick\(tickResult\)\s*;/,
    "the sweep branch must classify the WHOLE tick result, not a field or two picked off it — " +
      "picking `started` out of it is the R3.2.6 defect wearing the new function's name"
  );
  assert.match(
    src,
    /NextResponse\.json\(\s*buildSweepResponse\(/,
    "the sweep response must be the tested builder's output, not an inline object literal"
  );
  assert.doesNotMatch(
    src,
    /scheduled\s*=\s*tickResult\.started\s*;/,
    "reading only `tickResult.started` is the R3.2.6 defect — `skipped` must not be dropped"
  );
});
