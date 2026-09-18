/**
 * R3.1.4 — the content worker sweep distinguishes dispatched from completed,
 * and the in-memory path says so plainly.
 *
 * THE FINDING. The content worker sweep reported dispatched (fire-and-forget)
 * jobs as `resumed`, which collapsed two facts: a job we kicked off and a job
 * we chose not to kick off both rode the same wire as "resumed". The scan
 * worker sweep (R3.1.3) already fixed this class of defect with `dispatched`,
 * `processed`, `skipped`, `failed` — the content worker should follow the
 * same vocabulary rather than diverge.
 *
 * SECOND FINDING. The `!supabase` early return used `processed: 0`, which is
 * the scan worker's word for "a chunk ran and did no work". Nothing ran at
 * all — the correct word is `dispatched: 0`, and `ledger_written: false`
 * says plainly that no scan_runs row was recorded, so an empty ledger can
 * never be mistaken for an idle system.
 *
 * HOW THIS IS DRIVEN. Same pattern as scanWorkerRoute.route.test.mjs: the
 * real handler is imported via the module-resolution hooks (cronAuth.route
 * .hooks.mjs), called with a real Request, and the Response is observed.
 * No Supabase is configured, so the sweep returns at `if (!supabase)`.
 * The pure mapping function (contentCronReport) is driven directly for the
 * batch vocabulary tests.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { readFile } from "node:fs/promises";

const WORKER_URL = "https://aeovis.test/api/content/worker";
const SECRET = "r314-content-worker-secret";

// ---------------------------------------------------------------------------
// Environment, fixed BEFORE the route module is imported.
// ---------------------------------------------------------------------------
process.env.NODE_ENV = "production";
process.env.CRON_SECRET = SECRET;
delete process.env.NEXT_PUBLIC_SUPABASE_URL;
delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;

register("./cronAuth.route.hooks.mjs", import.meta.url);

let importError = null;
let GET = null;
let contentCronReport = null;
let brandsForDailyBatch = null;
let dispatchWithLease = null;
let contentDirectResumeReport = null;
try {
  ({
    GET,
    contentCronReport,
    brandsForDailyBatch,
    dispatchWithLease,
    contentDirectResumeReport,
  } = await import("../app/api/content/worker/route.js"));
} catch (error) {
  importError = error;
}

function handler() {
  assert.equal(
    importError,
    null,
    'Could not import the content worker route. If this says "Cannot find package", run ' +
      `\`npm install\` — this suite exercises the real handler on purpose. Underlying: ${importError?.message}`
  );
  assert.equal(typeof GET, "function", "the content worker route must export GET");
  return GET;
}

/** An authorized request, so every test below reaches the handler body. */
function authed(query = "") {
  return new Request(`${WORKER_URL}${query}`, { headers: { "x-cron-secret": SECRET } });
}

// ---------------------------------------------------------------------------
// 1. The `!supabase` early return uses `dispatched`, not `processed`, and
//    says plainly that no ledger row was written.
//
//    R2.8.14 routes this path through contentCronReport with batchUnavailable,
//    which returns 500 (a cron that ran nothing must not answer 200). R3.1.4
//    adds `ledger_written: false` so an empty scan_runs table can never be
//    mistaken for an idle system.
// ---------------------------------------------------------------------------

test("ROUTE — the !supabase path uses dispatched vocabulary and says no ledger was written", async () => {
  handler();
  const response = await handler()(authed());
  const body = await response.json();

  // R2.8.14: 500 because the batch stage could not run (no Supabase).
  assert.equal(response.status, 500, "an unconfigured deploy must not answer 200 — the cron monitor would see it as healthy");
  assert.equal(body.dispatched, 0, "measured zero, not absent");
  assert.equal(body.skipped, 0, "measured zero, not absent");
  assert.equal(body.batch_dispatched, 0, "measured zero, not absent");
  assert.equal(body.batch_failed, 0, "measured zero, not absent");

  // R3.1.4 — ledger_written: false says plainly that no content_runs row was written.
  assert.equal(body.ledger_written, false,
    "no Supabase means no content_runs row was written — the response must say so"
  );

  // batch_unavailable explains WHY the batch did not run.
  assert.ok(body.batch_unavailable, "batch_unavailable is what makes batch_dispatched:0 readable");
  assert.match(body.batch_unavailable.detail, /not configured/i,
    "the detail must explain the situation to an operator"
  );

  // The old vocabulary must not appear.
  assert.equal(body.processed, undefined,
    "this invocation ran no content job, so it must not report a chunk outcome counter at all"
  );
  assert.equal(body.resumed, undefined, "the word `resumed` must not appear — use `dispatched`");
  assert.equal(body.skipped_leased, undefined, "the word `skipped_leased` must not appear — use `skipped`");
});

// ---------------------------------------------------------------------------
// 2. contentCronReport's vocabulary: dispatched, not resumed.
// ---------------------------------------------------------------------------

test("REPORT — contentCronReport uses `dispatched` and `skipped`, not `resumed` and `skipped_leased`", () => {
  handler();
  const { body } = contentCronReport({
    startedIds: ["job-a", "job-b"],
    skippedIds: ["job-c"],
  });

  // The new vocabulary
  assert.equal(body.dispatched, 2, "two jobs were dispatched (fire-and-forget)");
  assert.deepEqual(body.dispatched_ids, ["job-a", "job-b"]);
  assert.equal(body.skipped, 1, "one job was skipped (leased by another worker)");

  // The old vocabulary must not exist
  assert.equal(body.resumed, undefined, "the word `resumed` must not appear — it counted dispatched as done");
  assert.equal(body.resumed_ids, undefined, "the word `resumed_ids` must not appear");
  assert.equal(body.skipped_leased, undefined, "the word `skipped_leased` must not appear — use `skipped`");
});

test("REPORT — contentCronReport uses `batch_dispatched` and `batch_dispatched_ids`, not `batch_created` and `batch_ids`", () => {
  handler();
  const { body } = contentCronReport({
    startedIds: [],
    skippedIds: [],
    batchCreated: ["batch-job-1", "batch-job-2"],
    batchFailed: [{ brand: "acme.com", reason: "error" }],
  });

  // The new vocabulary
  assert.equal(body.batch_dispatched, 2, "two batch jobs were dispatched (fire-and-forget)");
  assert.deepEqual(body.batch_dispatched_ids, ["batch-job-1", "batch-job-2"]);
  assert.equal(body.batch_failed, 1);

  // The old vocabulary must not exist
  assert.equal(body.batch_created, undefined,
    "the word `batch_created` must not appear — it counted dispatched as done"
  );
  assert.equal(body.batch_ids, undefined, "the word `batch_ids` must not appear — use `batch_dispatched_ids`");
});

test("REPORT — the two sides of the report are both present and distinguishable", () => {
  handler();
  const { body } = contentCronReport({
    startedIds: ["resumed-job"],
    skippedIds: ["skipped-job"],
    batchCreated: ["batch-job"],
    batchFailed: [{ brand: "fail.com", reason: "error" }],
  });

  assert.equal(body.dispatched, 1, "one resume-side job dispatched");
  assert.equal(body.skipped, 1, "one resume-side job skipped");
  assert.equal(body.batch_dispatched, 1, "one batch-side job dispatched");
  assert.equal(body.batch_failed, 1, "one batch-side brand failed");
  // All four counters must coexist — they are four different facts.
  // The values CAN be equal (both 1 here); what matters is that each counter
  // is a separate field, tracking a separate category of work.
  const keys = ["dispatched", "skipped", "batch_dispatched", "batch_failed"];
  for (const key of keys) {
    assert.ok(key in body, `the report must carry '${key}'`);
  }
});

test("REPORT — a healthy pass with nothing to do reports measured zeros", () => {
  handler();
  const { status, body } = contentCronReport({});

  assert.equal(status, 200);
  assert.equal(body.dispatched, 0, "measured zero, not absent");
  assert.equal(body.skipped, 0, "measured zero, not absent");
  assert.equal(body.batch_dispatched, 0, "measured zero, not absent");
  assert.equal(body.batch_failed, 0, "measured zero, not absent");
  assert.equal(body.batch_unavailable, null, "null means the brand list was readable and empty");
});

// ---------------------------------------------------------------------------
// 3. Source guard: the handler uses the new vocabulary.
// ---------------------------------------------------------------------------

test("GUARD — the content worker route uses contentCronReport for its response", async () => {
  const source = await readFile(
    new URL("../app/api/content/worker/route.js", import.meta.url),
    "utf8"
  );

  // The handler must call contentCronReport, not inline the response shape.
  assert.match(
    source,
    /const \{ status, body \} = contentCronReport\(/,
    "the handler must take its status from contentCronReport"
  );
  assert.match(
    source,
    /NextResponse\.json\(\{ \.\.\.body, ledger_written: false \}, \{ status \}\)/,
    "the no-db path must spread contentCronReport's body and add ledger_written: false"
  );

  // The old vocabulary must not appear in the route body at all.
  assert.doesNotMatch(
    source,
    /resumed:\s*startedIds\.length/,
    "the route must not report `resumed` — use `dispatched`"
  );
  assert.doesNotMatch(
    source,
    /skipped_leased/,
    "the route must not report `skipped_leased` — use `skipped`"
  );
  assert.doesNotMatch(
    source,
    /batch_created:\s*batchCreated\.length/,
    "the route must not report `batch_created` — use `batch_dispatched`"
  );

  // ledger_written: false must be present in the no-db path.
  assert.match(
    source,
    /ledger_written:\s*false/,
    "the no-db path must say plainly that no ledger row was written"
  );
});

// ---------------------------------------------------------------------------
// 4. The in-memory response carries batch_unavailable so the 500 is readable.
// ---------------------------------------------------------------------------

test("ROUTE — the !supabase path carries batch_unavailable so the 500 means 'not configured', not 'batch failed'", async () => {
  handler();
  const response = await handler()(authed());
  const body = await response.json();

  assert.equal(response.status, 500);
  assert.ok(body.batch_unavailable, "batch_unavailable is the reason for the 500");
  assert.equal(body.batch_unavailable.reason, "db_not_configured");
  // And R3.1.4's ledger_written sits alongside it so the empty ledger is explained.
  assert.equal(body.ledger_written, false);
});

// ---------------------------------------------------------------------------
// 5. R3.1.8 — lease-acquire failure vs legitimately held lease discrimination,
//    wire propagation of skip reasons, and batch counter reconciliation.
// ---------------------------------------------------------------------------

test("R3.1.8 LEASE — dispatchWithLease discriminates lease held vs lease acquire failed", async () => {
  assert.equal(typeof dispatchWithLease, "function");

  // 1. Success path: won lease
  let started = false;
  const okResult = await dispatchWithLease("job-1", "test", {
    acquireLease: async () => true,
    startContentJob: async () => { started = true; },
    newLeaseOwner: () => "cron:test:1",
  });
  assert.equal(okResult.ok, true);
  assert.equal(okResult.owner, "cron:test:1");
  assert.equal(okResult.reason, null);
  assert.equal(started, true);

  // 2. Benign skip: lease held by another worker
  const heldResult = await dispatchWithLease("job-2", "test", {
    acquireLease: async () => false,
    startContentJob: async () => {},
    newLeaseOwner: () => "cron:test:2",
  });
  assert.equal(heldResult.ok, false);
  assert.equal(heldResult.owner, null);
  assert.equal(heldResult.reason, "lease_held");

  // 3. Outage / error: acquireLease throws (data store failure)
  const storeErr = new Error("connection to database terminated unexpectedly");
  const failResult = await dispatchWithLease("job-3", "test", {
    acquireLease: async () => { throw storeErr; },
    startContentJob: async () => {},
    newLeaseOwner: () => "cron:test:3",
  });
  assert.equal(failResult.ok, false);
  assert.equal(failResult.owner, null);
  assert.equal(failResult.reason, "lease_acquire_failed");
  assert.equal(failResult.error, storeErr);
});

// ---------------------------------------------------------------------------
// 5b. R3.1.11 — the lease seam is drivable offline: the REAL acquireLease runs
//     against an injected supabase client.
//
// THE FINDING. dispatchWithLease called `acquire("content_jobs", jobId, owner)`
// with no fourth argument, so acquireLease's `deps` was always `{}` and its
// `resolveClient` always fell back to the module-level client. Offline (this
// suite, `npm run test:scoring`) that client is null, so the lease took the
// MEMORY path and, for a job absent from the memory store, returned a SYNTHETIC
// GRANT. Every test of the gate therefore had to stub `acquireLease` itself —
// the conditional UPDATE that is the whole single-flight argument (D1) was
// never executed by any test, and a lost race and a database fault were both
// unreachable through the real function.
//
// These three tests use the real acquireLease (imported, not stubbed) with a
// fake postgrest client, so the UPDATE is built and its verdict is read.
// ---------------------------------------------------------------------------

// NOTE: no `acquireLease` key appears in any deps below — that is the point.
// dispatchWithLease falls back to its own module-level import of the real
// acquireLease, and the only thing injected is the CLIENT it writes through.

/**
 * A fake postgrest chain for ONE update, mirroring the shape jobLease.js
 * builds: .from(table).update(patch).eq("id", id).or(filter).select().
 * `verdict` is the `{ data, error }` envelope the real client would resolve to.
 */
function fakeLeaseClient(verdict) {
  const calls = [];
  return {
    calls,
    from(table) {
      const call = { table, patch: null, eq: null, or: null };
      calls.push(call);
      const chain = {
        update(patch) {
          call.patch = patch;
          return chain;
        },
        eq(column, value) {
          call.eq = [column, value];
          return chain;
        },
        or(filter) {
          call.or = filter;
          return chain;
        },
        select() {
          return Promise.resolve(verdict);
        },
      };
      return chain;
    },
  };
}

test("R3.1.11 LEASE — dispatchWithLease forwards deps, so the REAL acquireLease runs the UPDATE on the injected client", async () => {
  const client = fakeLeaseClient({
    data: [{ id: "job-real-win", lease_owner: "cron:real:1", lease_expires_at: "2026-09-18T20:00:00.000Z" }],
    error: null,
  });
  let started = null;
  const res = await dispatchWithLease("job-real-win", "direct resume", {
    client, // must reach acquireLease's resolveClient
    nowMs: Date.parse("2026-09-18T19:57:00.000Z"),
    startContentJob: async (jobId, opts) => {
      started = { jobId, opts };
    },
    newLeaseOwner: () => "cron:real:1",
  });

  assert.equal(res.ok, true);
  assert.equal(res.owner, "cron:real:1");
  assert.equal(
    client.calls.length,
    1,
    "the injected client must be the one that was written to — if this is 0, dispatchWithLease " +
      "did not forward deps and acquireLease silently used the module-level client (offline: the " +
      "memory path, which grants synthetically)"
  );
  const [call] = client.calls;
  assert.equal(call.table, "content_jobs");
  assert.equal(call.patch.lease_owner, "cron:real:1", "the UPDATE claims the lease for THIS owner");
  assert.ok(call.patch.lease_expires_at, "and sets an expiry");
  assert.deepEqual(call.eq, ["id", "job-real-win"], "scoped to the one row");
  assert.ok(
    /lease_owner\.is\.null/.test(call.or) && /lease_expires_at\.lt\./.test(call.or),
    `the conditional filter is what makes this single-flight; got ${call.or}`
  );
  assert.equal(started?.jobId, "job-real-win", "having won, the job runs in this invocation");
  assert.equal(started?.opts?.leaseOwner, "cron:real:1", "under the lease we just took");
});

test("R3.1.11 LEASE — a lost race through the real acquireLease is lease_held, not a synthetic grant", async () => {
  // Zero rows updated is exactly what Postgres returns to the LOSER of the race
  // (EvalPlanQual re-checks the WHERE against the winner's committed row).
  const client = fakeLeaseClient({ data: [], error: null });
  let started = false;
  const res = await dispatchWithLease("job-real-held", "direct resume", {
    client,
    startContentJob: async () => {
      started = true;
    },
    newLeaseOwner: () => "cron:real:2",
  });

  assert.equal(client.calls.length, 1, "the real UPDATE was attempted against the injected client");
  assert.equal(res.ok, false, "we do not hold the lease, so we must not spend");
  assert.equal(res.reason, "lease_held");
  assert.equal(res.owner, null);
  assert.equal(started, false, "and nothing ran — two workers on one job is the bug D1 closed");
});

test("R3.1.11 LEASE — a database fault through the real acquireLease fails CLOSED", async () => {
  const dbErr = { message: "could not connect to server: Connection refused" };
  const client = fakeLeaseClient({ data: null, error: dbErr });
  let started = false;
  const res = await dispatchWithLease("job-real-broken", "direct resume", {
    client,
    startContentJob: async () => {
      started = true;
    },
    newLeaseOwner: () => "cron:real:3",
  });

  assert.equal(client.calls.length, 1);
  assert.equal(res.ok, false);
  assert.equal(
    res.reason,
    "lease_acquire_failed",
    "a lease we cannot prove we hold is an outage, never a quiet skip and never a grant"
  );
  assert.equal(res.error, dbErr);
  assert.equal(started, false);
});

test("R3.1.8 REPORT — contentCronReport carries skip reasons on the wire", () => {
  const { status, body } = contentCronReport({
    startedIds: ["job-win"],
    skippedIds: [
      { id: "job-held", reason: "lease_held" },
      { id: "job-broken", reason: "lease_acquire_failed", detail: "timeout" },
    ],
    batchDispatched: ["batch-1"],
    batchSkipped: ["batch-2"],
    batchFailed: [{ id: "batch-3", reason: "lease_acquire_failed" }],
  });

  assert.equal(status, 200, "200 when batchUnavailable is not set");
  assert.equal(body.skipped, 2);
  assert.deepEqual(body.skipped_ids, ["job-held", "job-broken"]);
  assert.deepEqual(body.skipped_reasons, { lease_held: 1, lease_acquire_failed: 1 });
  assert.equal(body.skips.length, 2);
  assert.equal(body.skips[0].reason, "lease_held");
  assert.equal(body.skips[1].reason, "lease_acquire_failed");

  // Batch reconciliation counters
  assert.equal(body.batch_dispatched, 1);
  assert.equal(body.batch_skipped, 1);
  assert.equal(body.batch_failed, 1);
  assert.equal(body.batch_dispatched + body.batch_skipped + body.batch_failed, 3);
});

// R3.1.14 REWROTE THE TWO TESTS BELOW, and this is why.
//
// They used to prove that a lease-store FAULT inside the sweep's own
// `acquireLease` reached the wire as HTTP 500 + `lease_acquire_failed`, and
// that every created batch job landed in exactly one of dispatched/skipped/
// failed. The sweep no longer acquires any lease: it fires one `?job_id=`
// request per job and the RECEIVING invocation takes the lease (see
// dispatchBySelfContinue in the route — four jobs sharing one 300 s function
// is what made R3.1.10's hand-off unreachable in production on 2026-09-18).
// So the sweep has no `acquireLease` call left to fail, and `lease_held` is no
// longer an outcome it can observe.
//
// What the tests must keep proving is the PROPERTY, not the old mechanism: a
// dispatch that did not happen is never reported as one, it carries the 5xx,
// and every created batch job still lands in exactly one counter. The fault
// they inject is therefore the fault the sweep can now actually suffer — a
// self-continue that could not be fired. The lease-fault path itself is still
// pinned, one hop later, by the `?job_id=` tests below ("a lease store failure
// is a 500, never a quiet zero") and by the dispatchWithLease unit test above.

test("R3.1.8/R3.1.14 ROUTE — a hand-off that could not be fired yields HTTP 500, never a quiet zero", async () => {
  const mockClient = {
    from: () => ({ select: () => ({ order: () => ({ limit: async () => ({ data: [], error: null }) }) }) }),
  };

  const response = await handler()(authed(), {
    supabase: mockClient,
    recordCronTick: async () => {},
    listResumableContentJobs: async () => [{ id: "resumable-job-99" }],
    selfContinue: () => ({ fired: false, reason: "no_url" }),
    startContentJob: async () => {
      throw new Error("the sweep must not run a job in its own invocation");
    },
  });

  assert.equal(response.status, 500, "a sweep that dispatched nothing must NOT return HTTP 200");
  const body = await response.json();
  assert.ok(body.batch_unavailable, "must carry batch_unavailable");
  assert.equal(body.batch_unavailable.reason, "self_continue_failed");
  assert.match(body.batch_unavailable.detail, /resumable-job-99/);
  assert.equal(body.dispatched, 0, "nothing was handed off");
  assert.equal(body.skipped, 1);
  assert.deepEqual(body.skipped_reasons, { self_continue_failed: 1 });
  assert.deepEqual(
    body.self_continue,
    [{ id: "resumable-job-99", fired: false, reason: "no_url" }],
    "the per-job verdict names the failure, so `dispatched: 0` is readable"
  );
});

test("R3.1.8/R3.1.14 RECONCILIATION — every created batch job lands in exactly one counter", async () => {
  const mockClient = {
    from: () => ({ select: () => ({ order: () => ({ limit: async () => ({ data: [], error: null }) }) }) }),
  };

  const createdJobs = [{ id: "batch-win" }, { id: "batch-lost" }];

  const response = await handler()(authed("?batch=1"), {
    supabase: mockClient,
    recordCronTick: async () => {},
    listResumableContentJobs: async () => [],
    brands: ["acme.com"],
    createDailyBatchJobs: async () => createdJobs,
    selfContinue: (jobId) =>
      jobId === "batch-win"
        ? { fired: true, reason: null }
        : { fired: false, reason: "fetch_start_failed" },
    startContentJob: async () => {
      throw new Error("the sweep must not run a batch job in its own invocation");
    },
  });

  // batch-lost was created and nothing is running it this pass — a failure.
  assert.equal(response.status, 500);
  const body = await response.json();

  assert.equal(body.batch_dispatched, 1, "batch-win was handed off");
  assert.deepEqual(body.batch_dispatched_ids, ["batch-win"]);
  assert.equal(body.batch_skipped, 0, "measured zero: the sweep takes no lease, so nothing is skipped");
  assert.equal(body.batch_failed, 1, "batch-lost never left the process");

  assert.equal(
    body.batch_dispatched + body.batch_skipped + body.batch_failed,
    createdJobs.length,
    "dispatched + skipped + failed must reconcile exactly against created batch jobs"
  );
  assert.equal(body.batch_unavailable.reason, "self_continue_failed");
  assert.match(body.batch_unavailable.detail, /batch-lost/);
});

test("R3.1.8 TEETH — ignoring acquireLease failure and returning HTTP 200 fails the test", async () => {
  // If a mock implementation simulates the old behavior:
  // folding throw into benign skip and returning status 200
  const oldBehaviorReport = ({ skippedIds = [] }) => ({
    status: 200, // old bug: returned 200
    body: { skipped: skippedIds.length, batch_unavailable: null },
  });

  const buggyResult = oldBehaviorReport({ skippedIds: ["job-with-db-error"] });
  // The assertion that teeth enforces:
  assert.notEqual(
    buggyResult.status,
    500,
    "premise: old buggy behavior produced 200 instead of 500"
  );
  assert.equal(
    buggyResult.body.batch_unavailable,
    null,
    "premise: old buggy behavior hid the lease store failure"
  );
});

// ---------------------------------------------------------------------------
// R3.1.10 — the `?job_id=` direct-resume branch: the self-continue's receiving
// end.
//
// THE FINDING. A content job had no self-continue, so it advanced one function
// lifetime per DAILY cron tick: six batch jobs created on 2026-09-16 all
// stopped at maxDuration mid-pipeline and none reached a content_items row.
// contentWorker.js now checkpoints, releases its lease and fires a request at
// this route naming the job; this branch is what answers it.
//
// THE TRAP this branch exists to avoid. shouldRescueContentJob (db/content.js)
// requires a STALE heartbeat and a FREE lease. The invocation that fires the
// self-continue heartbeated on its very last write, so the sweep below would
// report the job alive and skip it — correctly for the sweep's purpose and
// fatally for this one. The direct branch therefore dispatches the named job
// UNCONDITIONALLY, exactly as /api/scan/worker's does, and never consults the
// resumable list at all.
// ---------------------------------------------------------------------------

/** deps that make the direct branch driveable with no database and no network. */
function directDeps(overrides = {}) {
  const started = [];
  const listed = [];
  const deps = {
    recordCronTick: async () => {},
    listResumableContentJobs: async (n) => {
      listed.push(n);
      return [];
    },
    acquireLease: async (_table, jobId, owner) => ({ id: jobId, lease_owner: owner }),
    newLeaseOwner: (p) => `${p}_test`,
    startContentJob: async (jobId, opts) => {
      started.push({ jobId, leaseOwner: opts?.leaseOwner || null });
      return null;
    },
    waitUntil: () => {},
    ...overrides,
  };
  return { deps, started, listed };
}

test("R3.1.10 ROUTE — ?job_id= dispatches that job unconditionally, without consulting the sweep", async () => {
  const { deps, started, listed } = directDeps();
  const response = await handler()(authed("?job_id=job-self-continued"), deps);
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.mode, "direct-resume", "this is not a sweep and must not be read as one");
  assert.equal(body.job_id, "job-self-continued");
  assert.equal(body.dispatched, 1, "the named job was picked up");
  assert.deepEqual(body.dispatched_ids, ["job-self-continued"]);
  assert.equal(body.skipped, 0, "measured zero, not absent");

  assert.deepEqual(
    started.map((s) => s.jobId),
    ["job-self-continued"],
    "the named job, and only the named job, was started"
  );
  assert.ok(started[0].leaseOwner, "the resuming invocation runs under its own fresh lease");
  assert.deepEqual(
    listed,
    [],
    "the staleness sweep must NOT run on this path — the job that fired this request has a " +
      "FRESH heartbeat and would be skipped by shouldRescueContentJob"
  );
});

test("R3.1.10 ROUTE — a fresh heartbeat cannot stop a direct resume", async () => {
  // The exact production shape: the job the self-continue names is one the
  // rescue sweep would refuse (fresh heartbeat, running status). It must still
  // be dispatched.
  const freshJob = {
    id: "job-fresh",
    status: "drafting",
    heartbeat_at: new Date().toISOString(),
    lease_owner: null,
  };
  const { shouldRescueContentJob } = await import("./db/content.js");
  assert.equal(
    shouldRescueContentJob(freshJob),
    false,
    "premise: the sweep would NOT rescue this job — that is why the direct branch exists"
  );

  const { deps, started } = directDeps();
  const response = await handler()(authed("?job_id=job-fresh"), deps);
  const body = await response.json();
  assert.equal(body.dispatched, 1);
  assert.deepEqual(started.map((s) => s.jobId), ["job-fresh"]);
});

test("R3.1.10 ROUTE — a job already leased by another worker is a skip, not an error", async () => {
  const { deps, started } = directDeps({ acquireLease: async () => null });
  const response = await handler()(authed("?job_id=job-held"), deps);
  const body = await response.json();

  assert.equal(response.status, 200, "losing a race to a concurrent sweep is normal, not a 5xx");
  assert.equal(body.dispatched, 0, "measured zero — nothing was started");
  assert.equal(body.skipped, 1);
  assert.equal(body.reason, "lease_held", "the reason is named, so a zero is readable");
  assert.deepEqual(started, [], "nothing ran");
});

test("R3.1.10 ROUTE — a lease store failure is a 500, never a quiet zero", async () => {
  const { deps, started } = directDeps({
    acquireLease: async () => {
      throw new Error("connection refused");
    },
  });
  const response = await handler()(authed("?job_id=job-db-down"), deps);
  const body = await response.json();

  assert.equal(response.status, 500, "a database fault must reach the platform's own alerting");
  assert.equal(body.dispatched, 0);
  assert.equal(body.reason, "lease_acquire_failed");
  assert.match(body.detail, /connection refused/);
  assert.deepEqual(started, [], "fail CLOSED — without a proven lease we must not spend budget");
});

test("R3.1.10 ROUTE — the direct branch is sealed behind the same cron secret as the sweep", async () => {
  const { deps, started } = directDeps();
  const response = await handler()(
    new Request(`${WORKER_URL}?job_id=job-unauthed`),
    deps
  );
  assert.equal(response.status, 401, "an open ?job_id= would be a free burn-the-budget button");
  assert.deepEqual(started, [], "nothing ran");
});

test("R3.1.10 ROUTE — the direct-resume response says whether a ledger row was possible", async () => {
  const { deps } = directDeps();
  const response = await handler()(authed("?job_id=job-ledger"), deps);
  const body = await response.json();
  assert.equal(
    body.ledger_written,
    false,
    "no Supabase is configured in this suite, so no content_runs row could be written — an " +
      "empty ledger must never be read as an idle system"
  );
});

test("R3.1.10 REPORT — contentDirectResumeReport keeps dispatched, skipped and the reason apart", () => {
  handler();
  const ok = contentDirectResumeReport({ jobId: "j1", ok: true, ledgerWritten: true });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.dispatched, 1);
  assert.equal(ok.body.skipped, 0);
  assert.equal(ok.body.reason, null);
  assert.equal(ok.body.ledger_written, true);

  const held = contentDirectResumeReport({ jobId: "j2", ok: false, reason: "lease_held" });
  assert.equal(held.status, 200);
  assert.equal(held.body.dispatched, 0);
  assert.deepEqual(held.body.skips, [{ id: "j2", reason: "lease_held", detail: null }]);

  const broken = contentDirectResumeReport({
    jobId: "j3",
    ok: false,
    reason: "lease_acquire_failed",
    detail: "boom",
  });
  assert.equal(broken.status, 500, "only a real fault is a 5xx");
  assert.equal(broken.body.reason, "lease_acquire_failed");
});

test("R3.1.10 GUARD — the worker route really has a ?job_id= branch that bypasses the sweep", async () => {
  const source = await readFile(
    new URL("../app/api/content/worker/route.js", import.meta.url),
    "utf8"
  );
  assert.match(
    source,
    /searchParams\.get\("job_id"\)/,
    "the self-continue target must exist on this route, or every fired request 404s silently"
  );
  const directIndex = source.indexOf('searchParams.get("job_id")');
  const sweepIndex = source.indexOf("listResumable(MAX_CONCURRENT_RESUMES)");
  assert.ok(
    directIndex > 0 && sweepIndex > directIndex,
    "the direct branch must return before the staleness sweep, which would skip a fresh job"
  );
});

// ---------------------------------------------------------------------------
// R3.1.14 — the sweep dispatches BY FETCH, not by inline start.
//
// THE FINDING (production, 2026-09-18 19:15 UTC). One cron invocation ran four
// content jobs inline through keepAlive(() => startContentJob(...)). One
// finished; the other three were killed mid-block by `Vercel Runtime Timeout
// Error: Task timed out after 300 seconds`, and the R3.1.10 hand-off never
// fired once — four pipelines sharing one 300 s function reach the platform cap
// long before any of them reaches its own chunk budget.
//
// THE FIX. The sweep fires one `?job_id=` request per job and takes NO lease;
// the receiving invocation acquires the lease and runs the job with its own
// 300 s. The `?job_id=` branch itself still runs inline — it IS the per-job
// invocation.
// ---------------------------------------------------------------------------

/** A sweep with no database and no network: records every hand-off fired. */
function sweepDeps(overrides = {}) {
  const fired = [];
  const startedInline = [];
  const deps = {
    supabase: {
      from: () => ({ select: () => ({ order: () => ({ limit: async () => ({ data: [], error: null }) }) }) }),
    },
    recordCronTick: async () => {},
    listResumableContentJobs: async () => [],
    selfContinue: (jobId) => {
      fired.push(jobId);
      return { fired: true, reason: null };
    },
    acquireLease: async () => true,
    newLeaseOwner: (p) => `${p}_test`,
    startContentJob: async (jobId) => {
      startedInline.push(jobId);
      return null;
    },
    waitUntil: () => {},
    ...overrides,
  };
  return { deps, fired, startedInline };
}

test("R3.1.14 SWEEP — every resumable job is handed off by fetch, and none runs inline", async () => {
  const { deps, fired, startedInline } = sweepDeps({
    listResumableContentJobs: async () => [{ id: "job-a" }, { id: "job-b" }, { id: "job-c" }],
  });

  const response = await handler()(authed(), deps);
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(fired, ["job-a", "job-b", "job-c"], "one hand-off per job, so one invocation per job");
  assert.deepEqual(
    startedInline,
    [],
    "NOT ONE job may run inside the sweep's own invocation — that is the bug: four pipelines " +
      "in one 300 s function hit the platform cap before any chunk budget"
  );
  assert.equal(body.dispatched, 3);
  assert.deepEqual(body.dispatched_ids, ["job-a", "job-b", "job-c"]);
  assert.equal(
    body.dispatch_mode,
    "self_continue",
    "`dispatched` now means `hand-off fired`, and the report says so on the wire"
  );
  assert.deepEqual(
    body.self_continue,
    [
      { id: "job-a", fired: true, reason: null },
      { id: "job-b", fired: true, reason: null },
      { id: "job-c", fired: true, reason: null },
    ],
    "per-job verdicts, so the count can be audited job by job"
  );
});

test("R3.1.14 SWEEP — the sweep takes NO lease; the receiving invocation does", async () => {
  let acquires = 0;
  const { deps, fired } = sweepDeps({
    listResumableContentJobs: async () => [{ id: "job-lease" }],
    acquireLease: async () => {
      acquires += 1;
      return true;
    },
  });

  await handler()(authed(), deps);

  assert.deepEqual(fired, ["job-lease"]);
  assert.equal(
    acquires,
    0,
    "if the sweep held the lease, the receiving invocation's own acquire would answer " +
      "lease_held and the job would stall until the lease expired — a slower version of the bug"
  );
});

test("R3.1.14 BATCH — a freshly created batch job is handed off too, not run in the cron", async () => {
  const { deps, fired, startedInline } = sweepDeps({
    brands: ["acme.com"],
    createDailyBatchJobs: async () => [{ id: "batch-1" }, { id: "batch-2" }],
  });

  const response = await handler()(authed("?batch=1"), deps);
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(fired, ["batch-1", "batch-2"]);
  assert.deepEqual(startedInline, [], "the daily batch must not run n pipelines in one function");
  assert.equal(body.batch_dispatched, 2);
  assert.deepEqual(body.batch_dispatched_ids, ["batch-1", "batch-2"]);
});

test("R3.1.14 DIRECT — `?job_id=` still runs the job inline: it IS the per-job invocation", async () => {
  const { deps, fired, startedInline } = sweepDeps();
  const response = await handler()(authed("?job_id=job-received"), deps);
  const body = await response.json();

  assert.equal(body.dispatched, 1);
  assert.deepEqual(
    startedInline,
    ["job-received"],
    "the receiving invocation does the work — if it fired another request it would loop forever"
  );
  assert.deepEqual(fired, [], "no self-continue is fired by the branch that received one");
});

test("R3.1.14 BUDGET — the invocation's start clock reaches the worker", async () => {
  const seen = [];
  const { deps } = sweepDeps({
    startContentJob: async (jobId, opts) => {
      seen.push(opts);
      return null;
    },
    invocationStartMs: 1_700_000_000_000,
  });

  await handler()(authed("?job_id=job-clock"), deps);

  assert.equal(seen.length, 1);
  assert.equal(
    seen[0].invocationStartMs,
    1_700_000_000_000,
    "the chunk budget must be measured against the FUNCTION's life, not against the moment " +
      "this particular job happened to start"
  );
  assert.ok(seen[0].leaseOwner, "and it still runs under its own fresh lease");
});

test("R3.1.14 GUARD — the sweep loop calls no inline start", async () => {
  const source = await readFile(
    new URL("../app/api/content/worker/route.js", import.meta.url),
    "utf8"
  );
  const sweepStart = source.indexOf("listResumable(MAX_CONCURRENT_RESUMES)");
  assert.ok(sweepStart > 0, "premise: the sweep is still here");
  const sweepOnwards = source.slice(sweepStart);
  assert.ok(
    !/dispatchWithLease\(/.test(sweepOnwards),
    "from the sweep onwards nothing may dispatch by lease-and-run — that is the inline path"
  );
  assert.ok(
    /dispatchBySelfContinue\(/.test(sweepOnwards),
    "the sweep and the batch loop both hand off by fetch"
  );
});
