/**
 * R3.2.3 / finding S13 — the status route reads scan_runs instead of guessing
 * backwards from `scan_jobs.heartbeat_at`.
 *
 * WHAT THIS FILE OBSERVES, AND HOW
 * The REAL exported `GET` handler, driven in-process with a constructed
 * `Request`, against the REAL `@supabase/supabase-js` client. Nothing in `src/`
 * is stubbed or shadowed: the only substitution is at the transport, where
 * `globalThis.fetch` answers PostgREST-shaped JSON for a host that does not
 * exist. So the query the route builds — table, filter, ordering, limit — is
 * asserted as the URL supabase-js actually emits, and the response body is the
 * one Next's own `NextResponse.json` produced.
 *
 * THE BUG, RESTATED. Before this task the route made exactly one DB call
 * (`scan_jobs`) and answered `{status:"probing", progress_pct:62}`. It answered
 * exactly that whether a chunk was beating five seconds ago, or the last chunk
 * had closed FAILED twenty minutes earlier with 12 probes attempted and 0
 * succeeded, or nothing had ever run for the job at all. A poller cannot tell
 * those apart, so it polls until its own 15-minute timeout. "Running",
 * "stalled", "never ran" and "I could not tell" were one answer; test
 * "THE FINDING" below is the one that fails without the fix.
 *
 * THE OTHER HALF OF THIS FILE. `GET /api/scan/<id>/status` is on the operator
 * perimeter's PUBLIC allowlist, so the execution block this task added is
 * served to callers holding no credential at all — while `scan_runs` is an
 * internal table whose `error` column and `detail` jsonb are written from
 * provider errors, PostgREST errors and raw `err.message` text. The SECURITY
 * tests below hold the serialisation boundary: a key allowlist for `detail`, a
 * classified code instead of error text, fixed sentences instead of the
 * database's own words, and one whole-body marker scan that goes red for a
 * channel nobody has thought of yet.
 *
 * The module-resolution hooks (shared with cronAuth.route.test.mjs) only tell
 * Node which file `@/...` and `next/server` mean. No behaviour is substituted.
 *
 * DEPENDENCY NOTE: like the other *.route.test.mjs files this needs
 * node_modules. If the import fails the tests FAIL LOUDLY rather than skipping —
 * a skip here would hide the very path this file exists to observe.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { installLiveWriteGuard } from "./liveWriteGuard.js";

// db.js builds its Supabase client at import time, so these must be set BEFORE
// the route is imported. The host is real-looking and never reached: every
// request to it is answered by the stub below. Set unconditionally so that even
// a run carrying real credentials (`npm run test:live`, `--env-file`) talks to
// the fake, never to production.
const DB_HOST = "https://run-history-route.supabase.test";
process.env.NEXT_PUBLIC_SUPABASE_URL = DB_HOST;
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-key-for-a-host-that-does-not-exist";

register("./cronAuth.route.hooks.mjs", import.meta.url);

/**
 * WHY THIS FILE WIDENS THE LIVE-WRITE GUARD, AND WHY THAT IS NOT A HOLE.
 *
 * A rescue is not a label, it is a call: `runScanChunk(job.id)`. Its first
 * durable act is `open_scan_run` on `scan_runs` (R3.2.1), and the process-wide
 * guard installed by `liveWriteGuardAuto.mjs` refuses that with `allow: []`. So
 * asserting "the rescue really fired" needs one of two things — permit the
 * attempt, or stop testing it and trust a boolean in the JSON.
 *
 * This permits it, and then USES the guard as the instrument: `guard.writes` is
 * the record of every write it let through, so "a stalled job is actually
 * kicked" is asserted against the call the chunk made, not against the flag the
 * route set. `scan_runs` is already in the guard's own `WRITABLE_BY_OPT_IN`.
 *
 * There is no database on the other side of it. `NEXT_PUBLIC_SUPABASE_URL`
 * above is a host that does not resolve, and every request in this file is
 * answered by the in-process stub below, which refuses the RPC with a 500. The
 * widening covers exactly one table for exactly this file; customer tables stay
 * in NEVER_WRITABLE and cannot be named here at all.
 */
const guard = await installLiveWriteGuard({
  label: "R3.2.3 scanStatusRunHistory.route.test.mjs",
  allow: ["scan_runs"],
});

let importError = null;
let route = null;
try {
  route = await import("../app/api/scan/[job_id]/status/route.js");
} catch (error) {
  importError = error;
}

function requireRoute() {
  assert.equal(
    importError,
    null,
    'Could not import the status route. If this says "Cannot find package", run `npm install` — ' +
      `this suite exercises the real module. Underlying: ${importError?.message}`
  );
  assert.equal(typeof route.GET, "function", "the status route must export GET");
  return route;
}

const ROUTE_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../app/api/scan/[job_id]/status/route.js"
);

const JOB_ID = "11111111-1111-4111-8111-111111111111";
const STALE_MS = 3 * 60 * 1000; // HEARTBEAT_STALE_MS, db.js

// ---------------------------------------------------------------------------
// One fetch stub for the whole file, installed at module scope and never
// removed. A rescue is fire-and-forget: `runScanChunk` keeps making DB calls
// after the response has been returned, and a per-test install/restore would
// let those land on a later test's stub (or on the real network). One stub,
// a scenario object it reads, and a call log every test resets.
// ---------------------------------------------------------------------------
const scenario = {
  job: null,
  runs: [],
  /** PostgREST error body to answer the scan_runs SELECT with, instead of rows. */
  runsError: null,
  calls: [],
};

const jsonResponse = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

globalThis.fetch = async (url, init) => {
  const href = String(url);
  const method = init?.method || "GET";
  scenario.calls.push(`${method} ${href.replace(DB_HOST, "")}`);

  if (href.includes("/rest/v1/scan_jobs")) {
    return jsonResponse(scenario.job ? [scenario.job] : []);
  }
  if (href.includes("/rest/v1/scan_runs")) {
    if (scenario.runsError) return jsonResponse(scenario.runsError, 400);
    return jsonResponse(scenario.runs);
  }
  // Everything a rescued chunk tries next (open_scan_run, claims, probes) is
  // refused. runScanChunk's own error handling deals with it and the route's
  // .catch logs it; the test only cares THAT it was attempted.
  return jsonResponse({ message: "refused by the R3.2.3 route test stub", code: "TESTSTUB" }, 500);
};

const iso = (msAgo, now = Date.now()) => new Date(now - msAgo).toISOString();

function makeJob(overrides = {}) {
  return {
    id: JOB_ID,
    brand: "Acme",
    status: "probing",
    progress_pct: 62,
    result_id: null,
    error_message: null,
    created_at: iso(30 * 60 * 1000),
    // Deliberately FRESH, in every scenario below. The old rule read this
    // column; nothing in the new one may. A test whose ledger says "dead" while
    // this says "alive" is the discriminator.
    heartbeat_at: iso(1000),
    run_record: null,
    ...overrides,
  };
}

function makeRun(overrides = {}) {
  return {
    id: "22222222-2222-4222-8222-222222222222",
    runner: "scan-chunk",
    phase: "probing",
    worker_id: "worker-a",
    scan_job_id: JOB_ID,
    batch_id: null,
    brand: "Acme",
    outcome: "succeeded",
    reason: "checkpointed",
    probes_attempted: 10,
    probes_succeeded: 10,
    errors_recovered: 0,
    error: null,
    detail: null,
    started_at: iso(60 * 1000),
    heartbeat_at: iso(30 * 1000),
    ended_at: iso(30 * 1000),
    ...overrides,
  };
}

/**
 * Writes the guard permitted before the current scenario started. A rescue is
 * fire-and-forget, so "did this poll kick a chunk" is measured as "did a new
 * open_scan_run appear after this request", never as a cumulative total.
 */
let writesBefore = 0;

/** Drive the real handler. Returns { status, body, calls }. */
async function ask({ job = makeJob(), runs = [], runsError = null } = {}) {
  requireRoute();
  scenario.job = job;
  scenario.runs = runs;
  scenario.runsError = runsError;
  scenario.calls = [];
  writesBefore = guard.writes.length;
  const response = await route.GET(new Request(`https://aeovis.test/api/scan/${JOB_ID}/status`), {
    params: { job_id: JOB_ID },
  });
  const body = await response.json();
  // The rescue is deliberately NOT awaited by the route, so every scenario
  // waits here for its own fire-and-forget work to land. Without this, one
  // test's kick arrives during the next test's assertions and "no rescue was
  // fired" becomes a race rather than a fact.
  await settle();
  return { status: response.status, body, calls: [...scenario.calls] };
}

/** Let a fire-and-forget rescue reach the ledger (or prove it never does). */
async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 80));
}

/**
 * Did a chunk actually start? Read off the guard's write log — the RPC
 * `runScanChunk` makes before it does anything else — rather than off the
 * `rescue.fired` flag the route itself set.
 */
const rescueAttempted = () =>
  guard.writes
    .slice(writesBefore)
    .some((w) => /open_scan_run/.test(w.operation) && w.table === "scan_runs");

// ---------------------------------------------------------------------------
// The finding
// ---------------------------------------------------------------------------

test("THE FINDING — a dead executor and a live one no longer produce the same answer", async () => {
  const alive = await ask({
    runs: [makeRun({ outcome: null, reason: null, ended_at: null, heartbeat_at: iso(5000) })],
  });
  const dead = await ask({
    runs: [
      makeRun({
        outcome: "failed",
        reason: "error",
        probes_attempted: 12,
        probes_succeeded: 0,
        errors_recovered: 3,
        error: "probe transport died",
        started_at: iso(25 * 60 * 1000),
        heartbeat_at: iso(20 * 60 * 1000),
        ended_at: iso(20 * 60 * 1000),
      }),
    ],
  });

  // Both jobs are "probing" with the same progress and the same fresh
  // scan_jobs.heartbeat_at. That was the WHOLE response before R3.2.3.
  assert.equal(alive.body.status, "probing");
  assert.equal(dead.body.status, "probing");
  assert.equal(alive.body.progress_pct, dead.body.progress_pct);

  assert.notDeepEqual(
    alive.body.execution,
    dead.body.execution,
    "the two must be distinguishable — that is the finding"
  );
  assert.equal(alive.body.execution.executor, "running");
  assert.equal(dead.body.execution.executor, "idle");
  assert.equal(dead.body.execution.last_run.outcome, "failed");
  assert.equal(dead.body.execution.last_run.reason, "error");
  // WHY it failed is public and machine-readable; the chunk's raw err.message
  // is not (this route is anonymously reachable — see the SECURITY block).
  assert.equal(dead.body.execution.last_run.error_code, "error_recorded");
  assert.ok(
    !JSON.stringify(dead.body).includes("probe transport died"),
    "the chunk's raw error text must not reach an anonymous caller"
  );
  assert.equal(dead.body.execution.last_run.probes_attempted, 12);
  assert.equal(dead.body.execution.last_run.probes_succeeded, 0);
  assert.equal(dead.body.execution.last_run.errors_recovered, 3);
});

// ---------------------------------------------------------------------------
// It really reads scan_runs, with the query the index was built for
// ---------------------------------------------------------------------------

test("ROUTE — the poll issues the scan_runs read migration 011 built scan_runs_job_idx for", async () => {
  const { calls } = await ask({ runs: [makeRun()] });
  const read = calls.find((c) => c.includes("/rest/v1/scan_runs"));
  assert.ok(read, `the route must SELECT from scan_runs; it called: ${JSON.stringify(calls)}`);
  const url = decodeURIComponent(read);

  assert.match(url, /scan_job_id=eq\.11111111-1111-4111-8111-111111111111/, "filtered by this job");
  assert.match(url, /order=started_at\.desc/, "newest first — the index's ordering");
  assert.match(
    url,
    /limit=11/,
    "one MORE than RUN_HISTORY_LIMIT, so truncation is measured rather than assumed"
  );
  for (const column of ["outcome", "reason", "probes_attempted", "probes_succeeded", "errors_recovered"]) {
    assert.ok(url.includes(column), `the outcome columns are the point of the read; missing ${column}`);
  }
});

test("ROUTE — a run history longer than the limit reports itself truncated", async () => {
  const runs = Array.from({ length: 11 }, (_, i) =>
    makeRun({ id: `4444444${i}-4444-4444-8444-44444444444${i}`, started_at: iso((i + 1) * 60 * 1000) })
  );
  const { body } = await ask({ runs });
  assert.equal(body.execution.runs.length, 10, "the response carries RUN_HISTORY_LIMIT rows");
  assert.equal(body.execution.runs_returned, 10);
  assert.equal(body.execution.truncated, true, "'I returned 10 and there are more' is not 'there are 10'");
});

// ---------------------------------------------------------------------------
// Four executor states, four different answers
// ---------------------------------------------------------------------------

test("ROUTE — an open run with a fresh beat is 'running', and no rescue is fired", async () => {
  const { body } = await ask({
    runs: [makeRun({ outcome: null, reason: null, ended_at: null, heartbeat_at: iso(5000) })],
  });
  assert.equal(body.execution.executor, "running");
  assert.equal(body.execution.open_run_count, 1);
  assert.equal(body.execution.open_run.worker_id, "worker-a", "the response names WHO is running it");
  assert.equal(body.execution.open_run.open, true);
  assert.equal(body.execution.rescue.fired, false);
  assert.equal(body.execution.rescue.reason, "executor_alive");

  assert.equal(rescueAttempted(), false, "kicking a live chunk only loses a claim");
});

test("ROUTE — an open run whose beat went stale is 'stalled': not running, and not failed either", async () => {
  const { body } = await ask({
    runs: [
      makeRun({
        outcome: null,
        reason: null,
        ended_at: null,
        started_at: iso(30 * 60 * 1000),
        heartbeat_at: iso(STALE_MS + 60 * 1000),
      }),
    ],
  });
  assert.equal(body.execution.executor, "stalled");
  assert.notEqual(body.execution.executor, "running", "a dead writer must not read as an executor");
  assert.notEqual(body.execution.executor, "idle", "an unclosed run is not the same as a finished one");
  assert.equal(body.execution.open_run.outcome, null, "still open: no outcome has been recorded");
  assert.equal(body.execution.rescue.fired, true);
  assert.equal(body.execution.rescue.reason, "no_live_executor");

  assert.equal(rescueAttempted(), true, "a stalled job must actually be kicked, not merely labelled");
});

test("ROUTE — a stale open row that a later run superseded is an orphan, not the job's state", async () => {
  // The exact shape a successful rescue leaves behind: chunk A died without
  // closing (open, stale) and chunk B then ran and checkpointed cleanly.
  // R3.3.2's reaper closes A at 2 x TTL, so this row is visible for minutes
  // while the job is genuinely progressing.
  const { body } = await ask({
    runs: [
      makeRun({
        id: "66666666-6666-4666-8666-666666666666",
        worker_id: "worker-b",
        outcome: "succeeded",
        reason: "checkpointed",
        started_at: iso(60 * 1000),
        heartbeat_at: iso(10 * 1000),
        ended_at: iso(10 * 1000),
      }),
      makeRun({
        id: "77777777-7777-4777-8777-777777777777",
        worker_id: "worker-a",
        outcome: null,
        reason: null,
        ended_at: null,
        started_at: iso(30 * 60 * 1000),
        heartbeat_at: iso(STALE_MS + 60 * 1000),
      }),
    ],
  });

  assert.equal(
    body.execution.executor,
    "idle",
    "a dead predecessor must not be reported as the present state of a progressing job"
  );
  assert.equal(body.execution.open_run_orphaned, true, "…but the unreaped row is not hidden either");
  assert.equal(body.execution.open_run.worker_id, "worker-a", "and it is named");
  assert.equal(body.execution.open_run_count, 1);
  assert.equal(body.execution.last_run.worker_id, "worker-b", "the newest run is the one that explains now");
  assert.equal(body.execution.rescue.fired, false, "chunk B signed off 10s ago; nothing to rescue yet");
  assert.equal(body.execution.rescue.reason, "recent_sign_of_life");
  assert.equal(rescueAttempted(), false);
});

test("ROUTE — a stale open row with NOTHING newer really is stalled", async () => {
  const { body } = await ask({
    runs: [
      makeRun({
        id: "88888888-8888-4888-8888-888888888888",
        outcome: null,
        reason: null,
        ended_at: null,
        started_at: iso(30 * 60 * 1000),
        heartbeat_at: iso(STALE_MS + 60 * 1000),
      }),
      makeRun({
        id: "99999999-9999-4999-8999-999999999999",
        outcome: "succeeded",
        reason: "checkpointed",
        started_at: iso(60 * 60 * 1000),
        heartbeat_at: iso(50 * 60 * 1000),
        ended_at: iso(50 * 60 * 1000),
      }),
    ],
  });
  assert.equal(body.execution.executor, "stalled", "the newest thing that happened is a writer going quiet");
  assert.equal(body.execution.open_run_orphaned, false);
  assert.equal(body.execution.rescue.fired, true);
  assert.equal(rescueAttempted(), true);
});

test("ROUTE — zero rows is 'never_ran', an empty history that says it measured empty", async () => {
  const { body } = await ask({ runs: [] });
  assert.equal(body.execution.executor, "never_ran");
  assert.equal(body.execution.history_known, true, "the read succeeded — this IS a measurement");
  assert.deepEqual(body.execution.runs, [], "measured zero is [], never null");
  assert.equal(body.execution.runs_returned, 0);
  assert.equal(body.execution.last_run, null);
  assert.equal(
    body.execution.quiet_ms,
    null,
    "a job nothing has ever run is not 0ms quiet, it is unmeasured (rule 5)"
  );
  assert.equal(body.execution.rescue.quiet_from, "job_created_at", "measured from the only date it has");
});

test("ROUTE — an unreadable ledger is UNKNOWN, never an empty history, and never a rescue", async () => {
  const measuredEmpty = await ask({ runs: [] });
  const dbMessage = "canceling statement due to statement timeout";
  const { status, body } = await ask({
    runsError: { message: dbMessage, code: "57014" },
  });

  assert.notDeepEqual(
    body.execution,
    measuredEmpty.body.execution,
    "'I looked and there are no runs' and 'I could not look' must not be the same response"
  );

  assert.equal(status, 200);
  assert.equal(body.execution.history_known, false);
  assert.equal(body.execution.executor, "unknown");
  assert.equal(body.execution.unknown_reason, "read_failed");
  // The ADMISSION survives; the database's own words do not. This body is
  // served to anonymous callers, and a PostgREST message routinely names the
  // host, role, schema or policy that refused — which is exactly why the
  // getScanJob branch in the same handler answers a fixed sentence too.
  assert.ok(
    body.execution.unknown_detail && body.execution.unknown_detail.length > 0,
    "an unknown history must still say so in words"
  );
  assert.match(body.execution.unknown_detail, /unknown/i, "…and say 'unknown', not 'empty'");
  assert.ok(
    !JSON.stringify(body).includes(dbMessage),
    "the database's own message must not appear ANYWHERE in a body anonymous callers can read"
  );
  assert.equal(body.execution.runs, null, "null, NOT [] — a failed SELECT is not evidence of no runs");
  assert.equal(body.execution.runs_returned, null, "and not 0 either");
  assert.equal(
    body.execution.truncated,
    null,
    "truncated:false is the claim 'you are seeing all of them'; an unread history cannot make it"
  );
  assert.equal(body.execution.open_run_count, null, "and 0 open runs is a count nobody took");
  assert.equal(body.execution.rescue.fired, false);
  assert.equal(
    body.execution.rescue.reason,
    "run_history_unknown",
    "we did not decline to rescue — we could not tell whether to, and the body says which"
  );

  // The JOB read still succeeded, so the reading it produced is real and must
  // not be downgraded into the transient envelope (which would make the client
  // throw the tick away).
  assert.equal(body.status, "probing");
  assert.equal(body.progress_pct, 62);
  assert.equal(body.transient_error, undefined);

  assert.equal(rescueAttempted(), false, "a rescue decided on no evidence is a guess");
});

test("ROUTE — a half-closed row makes the history unreadable rather than partly reported", async () => {
  // ended_at with no outcome. scan_runs_open_chk forbids it in the database;
  // if one ever reaches JS, normalizeRun refuses it and the route must not
  // silently drop the row and report the rest as the whole history.
  const { body } = await ask({
    runs: [makeRun({ outcome: null, reason: null, ended_at: iso(30 * 1000) }), makeRun()],
  });
  assert.equal(body.execution.history_known, false);
  assert.equal(body.execution.unknown_reason, "row_unreadable");
  assert.equal(body.execution.runs, null);
  assert.equal(body.execution.executor, "unknown");
  assert.equal(body.execution.rescue.fired, false);
});

test("ROUTE — an open run that cannot be dated is neither alive nor dead", async () => {
  const { body } = await ask({
    runs: [makeRun({ outcome: null, reason: null, ended_at: null, heartbeat_at: "not-a-timestamp" })],
  });
  assert.equal(body.execution.history_known, true, "the rows were read");
  assert.equal(body.execution.executor, "unknown", "but staleness is unmeasurable, so the state is not");
  assert.equal(body.execution.unknown_reason, "open_run_heartbeat_unreadable");
  assert.equal(body.execution.rescue.fired, false);

  assert.equal(rescueAttempted(), false, "an undated row is not evidence that its writer died");
});

test("ROUTE — a finished job is never rescued, whatever the ledger says", async () => {
  const { body } = await ask({
    job: makeJob({ status: "complete", progress_pct: 100, result_id: "res-1" }),
    runs: [makeRun({ outcome: null, reason: null, ended_at: null, heartbeat_at: iso(60 * 60 * 1000) })],
  });
  assert.equal(body.execution.rescue.fired, false);
  assert.equal(body.execution.rescue.reason, "job_terminal");
  assert.equal(body.execution.executor, "stalled", "the abandoned row is still reported honestly");

  assert.equal(rescueAttempted(), false);
});

test("ROUTE — a checkpoint that closed seconds ago is left to its own continuation", async () => {
  const { body } = await ask({
    runs: [makeRun({ outcome: "succeeded", reason: "checkpointed", ended_at: iso(4000), heartbeat_at: iso(4000) })],
  });
  assert.equal(body.execution.executor, "idle");
  assert.equal(body.execution.rescue.fired, false);
  assert.equal(
    body.execution.rescue.reason,
    "recent_sign_of_life",
    "selfContinue is already spinning up; a 2s poll must not kick on every tick"
  );
  assert.equal(body.execution.rescue.quiet_from, "last_sign_of_life");
  assert.ok(body.execution.rescue.quiet_ms >= 4000 && body.execution.rescue.quiet_ms < STALE_MS);

  assert.equal(rescueAttempted(), false);
});

// ---------------------------------------------------------------------------
// Standing rule 5 — an unmeasured counter is not a zero
// ---------------------------------------------------------------------------

test("ROUTE — NULL counters arrive as null, never as 0", async () => {
  const { body } = await ask({
    runs: [
      makeRun({
        outcome: "skipped",
        reason: "sourcing_claimed_elsewhere",
        probes_attempted: null,
        probes_succeeded: null,
        errors_recovered: null,
      }),
    ],
  });
  const run = body.execution.last_run;
  assert.equal(run.probes_attempted, null);
  assert.equal(run.probes_succeeded, null);
  assert.equal(run.errors_recovered, null);
  assert.notEqual(run.probes_attempted, 0, "NOT MEASURED must not render as a measured zero");
  assert.equal(run.outcome, "skipped");
  assert.equal(run.reason, "sourcing_claimed_elsewhere", "and the skip still says why");

  // A run that measured zero must look different from one that never counted.
  const measured = await ask({
    runs: [makeRun({ probes_attempted: 0, probes_succeeded: 0, errors_recovered: 0 })],
  });
  assert.equal(measured.body.execution.last_run.probes_attempted, 0);
  assert.notDeepEqual(measured.body.execution.last_run, run);
});

// ---------------------------------------------------------------------------
// The serialisation boundary — this route is ANONYMOUSLY REACHABLE
//
// `isPublicRoute` (asserted below, not assumed) matches GET
// /api/scan/<id>/status, so every string in this body reaches a caller holding
// no credential at all. `scan_runs` is an INTERNAL table: `error` is the
// chunk's raw `err.message`, and `detail.skips[].sample` is assembled from
// provider names and raw provider/DB error text at scanWorker.js's recordSkip
// call sites. These tests are the allowlist's teeth.
//
// Every marker below is obviously fake ON PURPOSE — a test that plants a
// realistic-looking credential to prove it does not leak has already leaked it
// into the repository.
// ---------------------------------------------------------------------------

const MARKERS = Object.freeze({
  runError: "NOT-A-REAL-SECRET-run-error-marker-9f21",
  detailRogueKey: "NOT-A-REAL-SECRET-detail-rogue-marker-9f22",
  skipSample: "NOT-A-REAL-SECRET-skip-sample-marker-9f23",
  detailNested: "NOT-A-REAL-SECRET-detail-nested-marker-9f24",
  postgrest: "NOT-A-REAL-SECRET-postgrest-marker-9f25",
});

test("SECURITY — the perimeter really does let anonymous callers read this body", async () => {
  const { isPublicRoute } = await import("./operatorPerimeter.js");
  assert.equal(
    isPublicRoute("GET", `/api/scan/${JOB_ID}/status`),
    true,
    "if this ever goes false the tests below are stricter than they need to be — which is fine — " +
      "but while it is true, everything this route serialises is public"
  );
});

test("SECURITY — a run's detail crosses the wire through a key allowlist, not whole", async () => {
  const { RUN_DETAIL_PUBLIC_KEYS } = requireRoute();
  const { body } = await ask({
    runs: [
      makeRun({
        outcome: "failed",
        reason: "chunk_failed",
        ended_at: iso(10 * 1000),
        heartbeat_at: iso(10 * 1000),
        detail: {
          // Everything chunkRunOutcome writes today, all of it allowlisted.
          phases_run: ["sourcing", "probing"],
          chunk_reason: "error",
          skips_total: 3,
          schedule_row: "created",
          progress_pct: 62,
          job_status: "probing",
          attempts: 2,
          max_attempts: 5,
          // R3.2.2's skips: the reason and the count are the operator's facts;
          // `sample` is raw provider/DB text and must not cross.
          skips: [
            {
              reason: "probe_error",
              count: 3,
              sample: [`Bright Data 502 for ${MARKERS.skipSample}`],
              sample_truncated: true,
            },
          ],
          // Two shapes no allowlist entry covers. This is the open-endedness
          // the finding named: before the allowlist, ANY key a future writer
          // added became public with no code change at all.
          internal_note: MARKERS.detailRogueKey,
          upstream: { endpoint: MARKERS.detailNested },
        },
      }),
    ],
  });

  const detail = body.execution.last_run.detail;
  assert.deepEqual(
    Object.keys(detail).sort(),
    [...RUN_DETAIL_PUBLIC_KEYS, "skips", "withheld_keys"].sort(),
    "exactly the allowlist, the reduced skips, and the count of what was withheld"
  );

  // The operator's facts survive — a boundary that empties the payload would
  // pass every leak assertion in this file and be useless.
  assert.deepEqual(detail.phases_run, ["sourcing", "probing"]);
  assert.equal(detail.chunk_reason, "error");
  assert.equal(detail.skips_total, 3);
  assert.equal(detail.schedule_row, "created");
  assert.equal(detail.attempts, 2);
  assert.equal(detail.max_attempts, 5);
  assert.deepEqual(
    detail.skips,
    [{ reason: "probe_error", count: 3 }],
    "reason and an exact count, and nothing built from a provider's own words"
  );

  assert.equal(detail.withheld_keys, 2, "and it SAYS how much it kept back, rather than looking whole");

  const text = JSON.stringify(body);
  for (const [name, marker] of Object.entries(MARKERS)) {
    assert.ok(!text.includes(marker), `${name} reached an anonymous caller through execution.*.detail`);
  }
});

test("SECURITY — an allowlisted key carrying an unexpected shape is withheld and counted", async () => {
  const { body } = await ask({
    runs: [
      makeRun({
        detail: {
          // The key is allowlisted; the VALUE is not a scalar or a flat list of
          // them. An allowlist on keys alone would publish this whole object.
          chunk_reason: { nested: MARKERS.detailNested },
          phases_run: [{ phase: MARKERS.detailNested }],
          skips_total: 0,
        },
      }),
    ],
  });
  const detail = body.execution.last_run.detail;
  assert.deepEqual(Object.keys(detail).sort(), ["skips_total", "withheld_keys"]);
  assert.equal(detail.skips_total, 0, "a measured zero still crosses");
  assert.equal(detail.withheld_keys, 2);
  assert.ok(!JSON.stringify(body).includes(MARKERS.detailNested));
});

test("SECURITY — withheld_keys is a measurement: 0 when nothing was kept back, null when uncountable", async () => {
  const clean = await ask({
    runs: [makeRun({ detail: { phases_run: ["probing"], chunk_reason: "checkpointed" } })],
  });
  assert.equal(
    clean.body.execution.last_run.detail.withheld_keys,
    0,
    "'you are seeing all of it' is a claim, and it must be measured rather than implied by absence"
  );

  const scalarDetail = await ask({ runs: [makeRun({ detail: "a bare jsonb string" })] });
  assert.deepEqual(
    scalarDetail.body.execution.last_run.detail,
    { withheld_keys: null },
    "a detail with no keys to allow publishes nothing, and cannot honestly count what it dropped"
  );

  const noDetail = await ask({ runs: [makeRun({ detail: null })] });
  assert.equal(
    noDetail.body.execution.last_run.detail,
    null,
    "no detail recorded stays null — different from 'recorded, all of it withheld'"
  );
});

test("SECURITY — a run's error column is classified, never published", async () => {
  const { runErrorCode, RUN_ERROR_CODES } = requireRoute();

  // The classifier itself, without a database.
  assert.equal(runErrorCode(null), RUN_ERROR_CODES.NONE);
  assert.equal(runErrorCode(undefined), RUN_ERROR_CODES.NONE);
  assert.equal(runErrorCode("   "), RUN_ERROR_CODES.NONE);
  assert.equal(runErrorCode("connect ECONNREFUSED 10.0.0.4:5432"), RUN_ERROR_CODES.RECORDED);
  assert.equal(runErrorCode(42), RUN_ERROR_CODES.UNREADABLE);
  assert.equal(new Set(Object.values(RUN_ERROR_CODES)).size, 3, "a closed vocabulary");

  const recorded = await ask({
    runs: [makeRun({ outcome: "failed", reason: "chunk_failed", error: MARKERS.runError })],
  });
  assert.equal(recorded.body.execution.last_run.error_code, "error_recorded");
  assert.equal(
    recorded.body.execution.last_run.error,
    undefined,
    "the raw text field is gone, not merely nulled — a key that exists is a key someone refills"
  );
  assert.ok(!JSON.stringify(recorded.body).includes(MARKERS.runError));

  const clean = await ask({ runs: [makeRun({ error: null })] });
  assert.equal(
    clean.body.execution.last_run.error_code,
    "none",
    "'this run recorded no error' is a measurement and must not look like 'an error we hid'"
  );
  assert.notEqual(recorded.body.execution.last_run.error_code, clean.body.execution.last_run.error_code);
});

test("SECURITY — REGRESSION GUARD: no planted internal string appears ANYWHERE in the anonymous body", async () => {
  // A WHOLE-BODY scan, deliberately not a per-field assertion. Per-field
  // assertions only cover the channels somebody already thought of; this one
  // goes red for a channel that does not exist yet.
  //
  // OUT OF SCOPE, ON PURPOSE: `job.error_message` is the chunk's raw
  // err.message too, and it was already served to anonymous callers by this
  // route long before R3.2.3 (see the `error_message` field in the response).
  // It is a real defect and it is NOT this task's — so no marker is planted in
  // it here, rather than this guard quietly asserting a channel is closed that
  // is wide open. It needs its own task.
  const planted = [
    {
      what: "scan_runs.error, on the run that explains the present",
      marker: MARKERS.runError,
      ask: {
        runs: [
          makeRun({ outcome: "failed", reason: "chunk_failed", error: MARKERS.runError }),
        ],
      },
      alsoAssert: (body) =>
        assert.equal(body.execution.last_run.error_code, "error_recorded", "…and it still says one happened"),
    },
    {
      what: "scan_runs.error on an OPEN run and on a run that is only in the history list",
      marker: MARKERS.runError,
      ask: {
        runs: [
          makeRun({
            id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            outcome: null,
            reason: null,
            ended_at: null,
            heartbeat_at: iso(5000),
            error: MARKERS.runError,
          }),
          makeRun({ id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", error: MARKERS.runError }),
        ],
      },
      alsoAssert: (body) => {
        assert.equal(body.execution.executor, "running");
        assert.equal(body.execution.runs.length, 2, "both runs are still reported");
      },
    },
    {
      what: "scan_runs.detail — an unmapped key, a nested object and a skip sample",
      marker: MARKERS.detailRogueKey,
      ask: {
        runs: [
          makeRun({
            detail: {
              chunk_reason: "checkpointed",
              deploy: MARKERS.detailRogueKey,
              upstream: { host: MARKERS.detailNested },
              // An ALLOWLISTED key carrying an unexpected shape: the key alone
              // is not enough, the value must be publishable too.
              attempts: { raw: MARKERS.detailNested },
              skips: [{ reason: "probe_error", count: 2, sample: [MARKERS.skipSample] }],
            },
          }),
        ],
      },
      alsoAssert: (body) =>
        assert.equal(body.execution.last_run.detail.chunk_reason, "checkpointed", "…and the useful keys survive"),
    },
    {
      what: "scan_runs.detail holding a bare jsonb string instead of an object",
      marker: MARKERS.detailRogueKey,
      ask: { runs: [makeRun({ detail: MARKERS.detailRogueKey })] },
      alsoAssert: (body) =>
        assert.deepEqual(
          body.execution.last_run.detail,
          { withheld_keys: null },
          "…and the fact that SOMETHING was there is not lost either"
        ),
    },
    {
      what: "the PostgREST error body the ledger read came back with",
      marker: MARKERS.postgrest,
      ask: {
        runsError: {
          message: `permission denied for relation scan_runs at ${MARKERS.postgrest}`,
          details: `role ${MARKERS.postgrest} has no SELECT grant`,
          hint: MARKERS.postgrest,
          code: "42501",
        },
      },
      alsoAssert: (body) =>
        assert.equal(body.execution.unknown_reason, "read_failed", "…and the failure is still named"),
    },
    {
      what: "normalizeRun's own refusal, which quotes the row back",
      marker: MARKERS.detailRogueKey,
      ask: {
        runs: [
          // Half-closed: normalizeRun throws, and its message quotes the row's
          // id verbatim. No run is emitted on this path, so the id can only
          // reach the wire by way of that exception text.
          makeRun({ id: MARKERS.detailRogueKey, outcome: null, reason: null }),
        ],
      },
      alsoAssert: (body) =>
        assert.equal(body.execution.unknown_reason, "row_unreadable", "…and the refusal is still named"),
    },
  ];

  for (const scenario of planted) {
    const { body } = await ask(scenario.ask);
    const text = JSON.stringify(body);
    for (const [name, marker] of Object.entries(MARKERS)) {
      assert.ok(
        !text.includes(marker),
        `LEAK via ${scenario.what}: the ${name} marker reached an anonymous caller.\n` +
          `This route is public (no credential required). Body was: ${text}`
      );
    }
    assert.ok(text.length > 0);
    scenario.alsoAssert(body);
  }
});

// ---------------------------------------------------------------------------
// The two pure decisions, without a database
// ---------------------------------------------------------------------------

test("PURE — summarizeRuns: liveness is the freshest beat, the boundary is strict, and skew is not a licence", () => {
  const { summarizeRuns } = requireRoute();
  const now = Date.parse("2026-09-09T12:00:00.000Z");
  const open = (heartbeatAt) => [
    {
      id: "r1",
      open: true,
      outcome: null,
      endedAt: null,
      heartbeatAt,
      startedAt: new Date(now - 60_000).toISOString(),
    },
  ];

  assert.equal(
    summarizeRuns(open(new Date(now - STALE_MS).toISOString()), now, STALE_MS).executor,
    "running",
    "exactly at the threshold is not yet stale"
  );
  assert.equal(
    summarizeRuns(open(new Date(now - STALE_MS - 1).toISOString()), now, STALE_MS).executor,
    "stalled",
    "one millisecond past it is"
  );
  assert.equal(
    summarizeRuns(open(new Date(now + 60_000).toISOString()), now, STALE_MS).executor,
    "running",
    "a beat in the future is clock skew, not a dead writer"
  );
  assert.equal(summarizeRuns([], now, STALE_MS).executor, "never_ran");
  assert.equal(summarizeRuns(null, now, STALE_MS).executor, "never_ran");

  // Two open rows, and the one that started LAST is the one that went quiet.
  // Liveness is "did anybody beat recently", so the freshest beat decides —
  // taking the newest-started row would report a live job as stalled.
  const racing = [
    {
      id: "started-last-but-silent",
      open: true,
      outcome: null,
      endedAt: null,
      heartbeatAt: new Date(now - STALE_MS - 60_000).toISOString(),
      startedAt: new Date(now - 10 * 60_000).toISOString(),
    },
    {
      id: "started-first-still-beating",
      open: true,
      outcome: null,
      endedAt: null,
      heartbeatAt: new Date(now - 5_000).toISOString(),
      startedAt: new Date(now - 20 * 60_000).toISOString(),
    },
  ];
  const raced = summarizeRuns(racing, now, STALE_MS);
  assert.equal(raced.executor, "running", "somebody beat 5 seconds ago");
  assert.equal(raced.openRun.id, "started-first-still-beating", "and the response names that one");
  assert.equal(raced.openRunCount, 2, "both open rows are still counted");
});

test("PURE — decideRescue: every path names itself, and none of them reads the job's heartbeat", () => {
  const { decideRescue, summarizeRuns } = requireRoute();
  const now = Date.parse("2026-09-09T12:00:00.000Z");
  const job = { status: "probing", created_at: new Date(now - 60 * 60 * 1000).toISOString() };
  // The job's own heartbeat is FRESH in every case here. Under the old rule
  // that alone decided the answer.
  job.heartbeat_at = new Date(now - 1000).toISOString();

  const closed = (endedAt) => [
    { id: "r", open: false, outcome: "succeeded", endedAt, heartbeatAt: endedAt, startedAt: endedAt },
  ];

  const stale = decideRescue({
    job,
    summary: summarizeRuns(closed(new Date(now - STALE_MS - 1).toISOString()), now, STALE_MS),
    historyKnown: true,
    nowMs: now,
    staleAfterMs: STALE_MS,
  });
  assert.equal(stale.rescue, true);
  assert.equal(stale.reason, "no_live_executor");
  assert.equal(stale.quietFrom, "last_sign_of_life");

  const fresh = decideRescue({
    job,
    summary: summarizeRuns(closed(new Date(now - STALE_MS).toISOString()), now, STALE_MS),
    historyKnown: true,
    nowMs: now,
    staleAfterMs: STALE_MS,
  });
  assert.equal(fresh.rescue, false);
  assert.equal(fresh.reason, "recent_sign_of_life");

  const blind = decideRescue({ job, summary: null, historyKnown: false, nowMs: now });
  assert.equal(blind.rescue, false);
  assert.equal(blind.reason, "run_history_unknown");
  assert.equal(blind.quietMs, null, "a decision that was not made reports no measurement");

  const undated = decideRescue({
    job: { status: "probing", created_at: "nonsense" },
    summary: summarizeRuns([], now, STALE_MS),
    historyKnown: true,
    nowMs: now,
    staleAfterMs: STALE_MS,
  });
  assert.equal(undated.rescue, false);
  assert.equal(undated.reason, "job_created_at_unreadable", "an unmeasurable quiet window says so");

  for (const status of ["complete", "failed"]) {
    const done = decideRescue({
      job: { status, created_at: job.created_at },
      summary: summarizeRuns([], now, STALE_MS),
      historyKnown: true,
      nowMs: now,
      staleAfterMs: STALE_MS,
    });
    assert.equal(done.rescue, false);
    assert.equal(done.reason, "job_terminal");
  }
});

// ---------------------------------------------------------------------------
// readRunHistory's own contract
//
// GET re-applies the `known` guard when it builds the response, so a fail-soft
// introduced HERE alone is invisible from the outside. These tests hold the
// inner contract on its own terms, against a client of their own.
// ---------------------------------------------------------------------------

/** A minimal PostgREST-shaped chain that yields whatever it is told to. */
function fakeClient(result) {
  const chain = {
    from: () => chain,
    select: () => chain,
    eq: () => chain,
    order: () => chain,
    limit: () => (typeof result === "function" ? result() : Promise.resolve(result)),
  };
  return chain;
}

test("UNIT — readRunHistory: an unknown history is null, never [] , however it failed", async () => {
  const { readRunHistory } = requireRoute();

  const failures = [
    ["no client at all", await readRunHistory(JOB_ID, null), "no_database_configured"],
    [
      "the SELECT returned an error",
      await readRunHistory(JOB_ID, fakeClient({ data: null, error: { message: "boom", code: "42501" } })),
      "read_failed",
    ],
    [
      "the transport threw",
      await readRunHistory(
        JOB_ID,
        fakeClient(() => Promise.reject(new Error("socket hang up")))
      ),
      "read_failed",
    ],
    [
      "a row is half-closed",
      await readRunHistory(
        JOB_ID,
        fakeClient({ data: [makeRun({ outcome: null, reason: null })], error: null })
      ),
      "row_unreadable",
    ],
  ];

  for (const [label, history, reason] of failures) {
    assert.equal(history.known, false, `${label}: must not claim to know`);
    assert.equal(history.reason, reason, `${label}: must name its cause`);
    assert.equal(history.runs, null, `${label}: runs must be null — [] asserts "this job never ran"`);
    assert.equal(
      history.truncated,
      null,
      `${label}: truncated must be null — false asserts "you are seeing all of them"`
    );
    assert.ok(history.detail && history.detail.length > 0, `${label}: must say so in words too`);
  }
});

test("UNIT — readRunHistory: a successful read is known, normalized and honestly sized", async () => {
  const { readRunHistory, RUN_HISTORY_LIMIT } = requireRoute();

  const empty = await readRunHistory(JOB_ID, fakeClient({ data: [], error: null }));
  assert.equal(empty.known, true);
  assert.deepEqual(empty.runs, [], "a measured empty history IS []");
  assert.equal(empty.truncated, false);
  assert.equal(empty.reason, null);

  const overflowing = await readRunHistory(
    JOB_ID,
    fakeClient({
      data: Array.from({ length: RUN_HISTORY_LIMIT + 1 }, (_, i) =>
        makeRun({ id: `5555555${i}-5555-4555-8555-55555555555${i}` })
      ),
      error: null,
    })
  );
  assert.equal(overflowing.known, true);
  assert.equal(overflowing.runs.length, RUN_HISTORY_LIMIT, "the extra row is the truncation signal, not payload");
  assert.equal(overflowing.truncated, true);
  assert.equal(overflowing.runs[0].probesAttempted, 10, "rows come back through normalizeRun");
});

// ---------------------------------------------------------------------------
// The guess stays removed
// ---------------------------------------------------------------------------

test("GUARD — the route no longer infers liveness from scan_jobs.heartbeat_at", () => {
  const source = readFileSync(ROUTE_PATH, "utf8");
  // Comments explain the removed guess by name, so strip them before looking
  // for the code that would perform it.
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");

  assert.ok(
    !/\bshouldRescueJob\b/.test(code),
    "shouldRescueJob(job) IS the heartbeat guess R3.2.3 removes; the ledger answers this now"
  );
  assert.ok(!/\bisJobAlive\b/.test(code), "isJobAlive reads scan_jobs.heartbeat_at — same guess, one layer down");
  assert.ok(
    !/\bjob\s*\.\s*heartbeat_at\b/.test(code),
    "the job row's heartbeat column must not be read by this route at all"
  );
  assert.ok(/from\s+"@\/lib\/scanRuns"/.test(code), "and the ledger must actually be imported");
  assert.ok(/\.from\("scan_runs"\)/.test(code), "…and actually queried");
});

test("GUARD — every declared reason and state is reachable from the code, not just declared", () => {
  const { EXECUTOR_STATES, RESCUE_REASONS, HISTORY_UNKNOWN_REASONS } = requireRoute();
  const source = readFileSync(ROUTE_PATH, "utf8");
  const { RUN_ERROR_CODES } = requireRoute();
  for (const [group, table] of [
    ["EXECUTOR_STATES", EXECUTOR_STATES],
    ["RESCUE_REASONS", RESCUE_REASONS],
    ["HISTORY_UNKNOWN_REASONS", HISTORY_UNKNOWN_REASONS],
    ["RUN_ERROR_CODES", RUN_ERROR_CODES],
  ]) {
    for (const key of Object.keys(table)) {
      const uses = source.split(`${group}.${key}`).length - 1;
      assert.ok(
        uses >= 1,
        `${group}.${key} is declared but never used to label anything — a vocabulary entry ` +
          `nothing emits is a state the route can never report (used ${uses}x)`
      );
    }
  }
  const values = Object.values(RESCUE_REASONS);
  assert.equal(new Set(values).size, values.length, "two reasons sharing a string cannot be told apart");
});

test("GUARD — the public detail allowlist is pinned, so widening it cannot be a quiet edit", () => {
  const { RUN_DETAIL_PUBLIC_KEYS } = requireRoute();
  // Adding a key here is the dangerous edit in the route (see its comment): it
  // publishes a jsonb field to anonymous callers. Pinning the list means that
  // edit must be made TWICE, once in a file whose diff says "security".
  assert.deepEqual(
    [...RUN_DETAIL_PUBLIC_KEYS].sort(),
    [
      "attempts",
      "chunk_reason",
      "job_status",
      "max_attempts",
      "phases_run",
      "progress_pct",
      "schedule_row",
      "skips_total",
    ],
    "every key here must carry a value from a vocabulary this repo declares — never err.message, " +
      "never a provider's words, never a host or a URL"
  );
  assert.equal(
    new Set(RUN_DETAIL_PUBLIC_KEYS).size,
    RUN_DETAIL_PUBLIC_KEYS.length,
    "a duplicated key hides how long the list really is"
  );
});
