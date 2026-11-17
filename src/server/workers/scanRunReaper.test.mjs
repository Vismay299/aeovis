import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

/**
 * R3.3.2 — the sweep reaps heartbeat-stale runs (finding S12).
 *
 * ACCEPT: "A run with a heartbeat staler than N x TTL closes as failed with
 * reason 'reaped'." So the load-bearing assertions here are:
 *   * the row over the threshold really closes, with the 'reaped' outcome that
 *     migration 011 defines and every reader buckets as failure, and a reason
 *     that starts with the word 'reaped';
 *   * the row UNDER the threshold does not, because a reaper that eats live
 *     work is worse than one that never runs;
 *   * two passes racing the same row produce one reap and one recorded race,
 *     never two reaps and never a corrupted row;
 *   * every pass — including the one that found nothing and the one that could
 *     not look — leaves a distinguishable trace.
 *
 * NO DATABASE. The clock is a number this file chooses and the ledger is the
 * fake below, which re-implements migration 011's refusals (close-once,
 * reason-required, closed vocabulary) so a bug that the SQL would catch is
 * caught here too. What this file therefore CANNOT prove is that production's
 * `close_scan_run` behaves as the fake does; the two guard tests at the bottom
 * read migration 011 itself and fail if the sentences the classifier depends on
 * ever change.
 *
 * The credentials are cleared before the dynamic import for the same reason
 * scanChunkLedger.test.mjs does it: with them loaded, `resolveChunkLedger`
 * would be ENABLED by db.js's real client and the "no ledger" case would open
 * real scan_runs rows on production instead of exercising the refusal.
 */
delete process.env.NEXT_PUBLIC_SUPABASE_URL;
delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

const {
  reapStaleRuns,
  runStaleness,
  classifyReapCloseFailure,
  describeReapPass,
  REAP_STALE_AFTER_MS,
  REAP_TTL_MULTIPLE,
  RUN_HEARTBEAT_TTL_MS,
  REAP_REASON,
  REAP_OUTCOME,
  REAP_MAX_PER_PASS,
  REAP_PASS_REASONS,
  REAP_ROW_VERDICTS,
  REAPER_PHASE,
  CHUNK_RUN_HEARTBEAT_MS,
} = await import("./scanWorker.js");
// R3.3.4 folded the reaper's runner name into the shared vocabulary, so this
// file reads it from the same place every other runner name comes from.
const { RUN_OUTCOMES, RUNNERS, listStaleScanRuns } = await import("../scanRuns.js");
const REAPER_RUNNER = RUNNERS.REAPER;
const { HEARTBEAT_STALE_MS } = await import("../db.js");
const { supabase } = await import("../db.js");

const T0 = Date.parse("2026-09-08T12:00:00.000Z");
const NOW = new Date(T0).toISOString();

/** An open scan_runs row whose last beat was `ageMs` before NOW. */
function openRun(id, ageMs, extra = {}) {
  return {
    id,
    runner: "scan-chunk",
    phase: "probing",
    worker_id: `worker-${id}`,
    scan_job_id: `job-${id}`,
    batch_id: null,
    brand: "acme",
    outcome: null,
    started_at: new Date(T0 - ageMs - 1000).toISOString(),
    heartbeat_at: new Date(T0 - ageMs).toISOString(),
    ended_at: null,
    ...extra,
  };
}

/**
 * A ledger that enforces migration 011's invariants, in particular the one this
 * task's idempotence rests on: a second close RAISES, naming the outcome that
 * won. A fake that let the second close through would let a double-reap pass
 * here and corrupt rows in production.
 */
function makeLedger({ rows = [], failCloseIds = new Set(), missingIds = new Set() } = {}) {
  // The STORE holds the full row; the lister below hands back only the columns
  // the real `select` projects, so a value the reaper reads but never selected
  // shows up as undefined here exactly as it would in production.
  const store = new Map(
    rows.map((r) => [
      r.id,
      { probes_attempted: null, probes_succeeded: null, errors_recovered: null, error: null, detail: null, ...r },
    ])
  );
  const opened = [];
  const closed = [];
  let n = 0;

  const deps = {
    openScanRun: async (fields) => {
      assert.ok(fields.runner && fields.runner.trim(), "open: runner is required");
      assert.ok(fields.phase && fields.phase.trim(), "open: phase is required");
      assert.ok(
        fields.scanJobId || fields.batchId || fields.brand || fields.workerId,
        "open: scan_runs_subject_chk — a row must name a job, batch, brand or worker"
      );
      const row = {
        id: `pass-run-${n++}`,
        runner: fields.runner,
        phase: fields.phase,
        worker_id: fields.workerId ?? null,
        scan_job_id: null,
        brand: null,
        detail: fields.detail ?? null,
        outcome: null,
        reason: null,
        probes_attempted: null,
        probes_succeeded: null,
        errors_recovered: null,
        error: null,
        started_at: NOW,
        heartbeat_at: NOW,
        ended_at: null,
      };
      store.set(row.id, row);
      opened.push(row);
      return {
        id: row.id,
        runner: row.runner,
        phase: row.phase,
        workerId: row.worker_id,
        scanJobId: null,
        batchId: null,
        brand: null,
        outcome: null,
        reason: null,
        probesAttempted: null,
        probesSucceeded: null,
        errorsRecovered: null,
        error: null,
        detail: row.detail,
        startedAt: row.started_at,
        heartbeatAt: row.heartbeat_at,
        endedAt: null,
        open: true,
      };
    },
    closeScanRun: async (fields) => {
      const { runId, outcome, reason } = fields;
      if (failCloseIds.has(runId)) {
        throw new Error(`closeScanRun: connection reset writing run ${runId}`);
      }
      const row = store.get(runId);
      if (!row || missingIds.has(runId)) {
        // Migration 011's wording, via scanRuns.js's throwDbError.
        throw new Error(
          `closeScanRun: close_scan_run: no run ${runId} exists -- refusing to report a close that wrote nothing`
        );
      }
      if (row.ended_at !== null) {
        throw new Error(
          `closeScanRun: close_scan_run: run ${runId} was already closed as "${row.outcome}" at ` +
            `${row.ended_at}; refusing to overwrite it with "${outcome}"`
        );
      }
      assert.ok(
        ["succeeded", "failed", "skipped", "reaped", "noop"].includes(outcome),
        `close: "${outcome}" is outside migration 011's closed vocabulary`
      );
      if (outcome !== "succeeded") {
        assert.ok(String(reason ?? "").trim(), `close: outcome "${outcome}" requires a reason`);
      }
      // COALESCE semantics: a null counter does NOT overwrite what is there.
      const merge = (next, prev) => (next === null || next === undefined ? prev : next);
      row.outcome = outcome;
      row.reason = reason ?? row.reason;
      row.probes_attempted = merge(fields.probesAttempted, row.probes_attempted);
      row.probes_succeeded = merge(fields.probesSucceeded, row.probes_succeeded);
      row.errors_recovered = merge(fields.errorsRecovered, row.errors_recovered);
      row.error = merge(fields.error, row.error);
      row.detail = fields.detail ? { ...(row.detail || {}), ...fields.detail } : row.detail;
      row.ended_at = NOW;
      closed.push({ ...row });
      return {
        id: row.id,
        runner: row.runner,
        phase: row.phase,
        workerId: row.worker_id ?? null,
        scanJobId: row.scan_job_id ?? null,
        batchId: null,
        brand: row.brand ?? null,
        outcome: row.outcome,
        reason: row.reason,
        probesAttempted: row.probes_attempted,
        probesSucceeded: row.probes_succeeded,
        errorsRecovered: row.errors_recovered,
        error: row.error,
        detail: row.detail,
        startedAt: row.started_at,
        heartbeatAt: row.heartbeat_at,
        endedAt: row.ended_at,
        open: false,
      };
    },
  };

  return { store, opened, closed, deps };
}

/** The listing the real query performs, done in memory against `rows`. */
function makeLister(rows) {
  const calls = [];
  return {
    calls,
    listStaleRuns: async ({ cutoffIso, limit, excludeRunId }) => {
      calls.push({ cutoffIso, limit, excludeRunId });
      const cutoff = Date.parse(cutoffIso);
      return rows
        .filter((r) => r.ended_at === null)
        .filter((r) => r.id !== excludeRunId)
        .filter((r) => Date.parse(r.heartbeat_at) < cutoff)
        .sort((a, b) => Date.parse(a.heartbeat_at) - Date.parse(b.heartbeat_at))
        .slice(0, limit + 1);
    },
  };
}

/** Silence the reaper's (deliberately loud) logging inside a case. */
async function quietly(fn) {
  const { log, warn, error } = console;
  console.log = () => {};
  console.warn = () => {};
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.log = log;
    console.warn = warn;
    console.error = error;
  }
}

function findPassRow(ledger) {
  return ledger.closed.find((r) => r.runner === REAPER_RUNNER && r.phase === REAPER_PHASE);
}

// ---------------------------------------------------------------------------
// The threshold, as arithmetic
// ---------------------------------------------------------------------------

test("R3.3.2 — the threshold is N x TTL, and both halves are IMPORTED rather than retyped", () => {
  assert.equal(
    RUN_HEARTBEAT_TTL_MS,
    HEARTBEAT_STALE_MS,
    "the reaper's TTL must BE db.js's HEARTBEAT_STALE_MS. A second definition of 'dead' is a " +
      "second thing to drift from isJobAlive and jobLease's LEASE_TTL_MS."
  );
  assert.equal(REAP_TTL_MULTIPLE, 2);
  assert.equal(REAP_STALE_AFTER_MS, RUN_HEARTBEAT_TTL_MS * REAP_TTL_MULTIPLE);
  assert.equal(REAP_STALE_AFTER_MS, 360_000);
});

test("R3.3.2 — the threshold outlives a whole serverless invocation, which is why 2 and not 1", () => {
  // maxDuration on /api/scan and /api/scan/worker. A web chunk cannot be alive
  // with a heartbeat older than this, because the platform has stopped it.
  const MAX_INVOCATION_MS = 300_000;
  assert.ok(
    REAP_STALE_AFTER_MS > MAX_INVOCATION_MS,
    `the threshold (${REAP_STALE_AFTER_MS}ms) must exceed the 300s maxDuration ceiling, or a live ` +
      `chunk whose heartbeats are all failing can be reaped while it is still working`
  );
  assert.ok(
    RUN_HEARTBEAT_TTL_MS <= MAX_INVOCATION_MS,
    "1 x TTL is INSIDE the invocation ceiling — this is the assertion that says why the multiple " +
      "cannot be 1"
  );
  assert.ok(
    REAP_STALE_AFTER_MS / CHUNK_RUN_HEARTBEAT_MS >= 12,
    "the threshold must be at least a dozen missed beats; one or two missed beats is a slow " +
      "database, not a dead writer"
  );
});

test("R3.3.2 — runStaleness: strictly past the threshold, exactly at it, and just short of it", () => {
  const at = runStaleness(openRun("at", REAP_STALE_AFTER_MS), T0);
  assert.equal(at.stale, false, "exactly at the threshold is NOT yet stale");
  assert.equal(at.staleMs, REAP_STALE_AFTER_MS);
  assert.equal(at.verdict, REAP_ROW_VERDICTS.NOT_STALE);

  const just = runStaleness(openRun("just", REAP_STALE_AFTER_MS + 1), T0);
  assert.equal(just.stale, true, "one millisecond past the threshold IS stale");
  assert.equal(just.verdict, REAP_ROW_VERDICTS.REAPED);

  const under = runStaleness(openRun("under", REAP_STALE_AFTER_MS - 1), T0);
  assert.equal(under.stale, false);
});

test("R3.3.2 — an undateable heartbeat is UNKNOWN staleness, never infinite staleness", () => {
  for (const beat of [null, undefined, "", "not a date"]) {
    const s = runStaleness({ id: "x", heartbeat_at: beat }, T0);
    assert.equal(s.stale, false, `heartbeat_at=${JSON.stringify(beat)} must not be reapable`);
    assert.equal(s.verdict, REAP_ROW_VERDICTS.UNREADABLE_HEARTBEAT);
    assert.equal(s.staleMs, null, "staleness is NOT MEASURED, not 0 and not Infinity (rule 5)");
  }
});

test("R3.3.2 — a heartbeat in the future (clock skew) is not a licence to reap", () => {
  const s = runStaleness(openRun("skewed", -60_000), T0);
  assert.equal(s.stale, false);
  assert.equal(s.staleMs, -60_000, "negative staleness is reported as measured, not clamped to 0");
});

// ---------------------------------------------------------------------------
// The accept criterion
// ---------------------------------------------------------------------------

test("ACCEPT — a run staler than N x TTL closes as 'reaped' (the failure bucket) with a 'reaped' reason", async () => {
  const stale = openRun("stale", REAP_STALE_AFTER_MS + 60_000);
  const ledger = makeLedger({ rows: [stale] });
  const lister = makeLister([stale]);

  const pass = await quietly(() =>
    reapStaleRuns(NOW, { ...ledger.deps, listStaleRuns: lister.listStaleRuns, reaperId: "reaper-1" })
  );

  assert.equal(pass.reaped, 1);
  assert.equal(pass.considered, 1);
  assert.equal(pass.ok, true);
  assert.equal(pass.outcome, RUN_OUTCOMES.SUCCEEDED);

  const row = ledger.store.get("stale");
  assert.equal(row.outcome, "reaped", "migration 011's word for a run a sweep closed");
  assert.equal(row.outcome, REAP_OUTCOME);
  assert.equal(row.outcome, RUN_OUTCOMES.REAPED);
  assert.ok(
    row.reason.startsWith("reaped"),
    `the reason must start with 'reaped' so reason LIKE 'reaped%' finds every one; got ${row.reason}`
  );
  assert.equal(row.reason, REAP_REASON);
  assert.ok(row.ended_at, "a reaped run is CLOSED — ended_at and outcome move together (011's open_chk)");
});

test("ACCEPT — 'reaped' is a failure to every reader: the wire buckets it with failed, never with success", async () => {
  // The mapping lives in src/app/api/scan/worker/route.js and is asserted here
  // by reading it, because this task may not edit that file and a future edit
  // that quietly moved 'reaped' into the processed bucket would turn the reap
  // into a false success on the cron's own response.
  const route = fs.readFileSync(
    path.join(process.cwd(), "src/app/api/scan/worker/route.js"),
    "utf8"
  );
  assert.match(
    route,
    /RUN_OUTCOMES\.SKIPPED\s*\|\|\s*ledger\.outcome === RUN_OUTCOMES\.NOOP\) bucket = "skipped";\s*\n\s*else bucket = "failed";/,
    "classifyChunkResult must still funnel every outcome that is not succeeded/skipped/noop — " +
      "which is exactly 'reaped' and 'failed' — into the failed bucket"
  );
  assert.ok(
    !/RUN_OUTCOMES\.REAPED\) bucket = "processed"/.test(route),
    "'reaped' must never be bucketed as processed"
  );
});

test("R3.3.2 — a run just UNDER the threshold is left alone, and the sparing is counted, not silent", async () => {
  const fresh = openRun("fresh", REAP_STALE_AFTER_MS - 1);
  const ledger = makeLedger({ rows: [fresh] });
  // A deliberately over-eager lister: it hands back a row the cutoff would not
  // have selected, standing in for clock skew between the database and this
  // process. The JS re-check is what must refuse it.
  const pass = await quietly(() =>
    reapStaleRuns(NOW, {
      ...ledger.deps,
      listStaleRuns: async () => [fresh],
      reaperId: "reaper-1",
    })
  );

  assert.equal(pass.reaped, 0, "a live-but-slow run must not be reaped");
  assert.equal(pass.notStale, 1, "and the disagreement must be COUNTED — a skip is not a success");
  assert.equal(pass.considered, 1);
  assert.equal(ledger.store.get("fresh").outcome, null, "the row is still open");
  assert.equal(pass.outcome, RUN_OUTCOMES.NOOP);
  assert.equal(pass.reason, REAP_PASS_REASONS.NOTHING_REAPABLE);
});

test("R3.3.2 — the boundary in one pass: 361s reaped, 360s and 359s spared", async () => {
  const rows = [
    openRun("over", REAP_STALE_AFTER_MS + 1000),
    openRun("exactly", REAP_STALE_AFTER_MS),
    openRun("under", REAP_STALE_AFTER_MS - 1000),
  ];
  const ledger = makeLedger({ rows });
  const pass = await quietly(() =>
    reapStaleRuns(NOW, { ...ledger.deps, listStaleRuns: async () => rows })
  );

  assert.equal(pass.reaped, 1);
  assert.deepEqual(pass.runs.map((r) => r.id), ["over"]);
  assert.equal(ledger.store.get("over").outcome, "reaped");
  assert.equal(ledger.store.get("exactly").outcome, null);
  assert.equal(ledger.store.get("under").outcome, null);
  assert.equal(pass.notStale, 2);
});

// ---------------------------------------------------------------------------
// Idempotence and races
// ---------------------------------------------------------------------------

test("R3.3.2 — re-running the reaper is a no-op: what it closed is no longer a candidate", async () => {
  const rows = [openRun("stale", REAP_STALE_AFTER_MS + 60_000)];
  const ledger = makeLedger({ rows });
  // The lister reads the LIVE store, so the second pass sees the row as closed
  // exactly as the real `ended_at IS NULL` predicate would.
  const live = () => [...ledger.store.values()].filter((r) => r.runner !== REAPER_RUNNER);

  const first = await quietly(() =>
    reapStaleRuns(NOW, {
      ...ledger.deps,
      listStaleRuns: async (args) => makeLister(live()).listStaleRuns(args),
    })
  );
  const second = await quietly(() =>
    reapStaleRuns(NOW, {
      ...ledger.deps,
      listStaleRuns: async (args) => makeLister(live()).listStaleRuns(args),
    })
  );

  assert.equal(first.reaped, 1);
  assert.equal(second.reaped, 0);
  assert.equal(second.considered, 0, "the closed row is not listed again");
  assert.equal(second.reason, REAP_PASS_REASONS.NO_STALE_RUNS);
  assert.equal(ledger.store.get("stale").outcome, "reaped");
});

test("R3.3.2 — two sweepers on the same row: one reap, one recorded race, no double close", async () => {
  const rows = [openRun("contested", REAP_STALE_AFTER_MS + 60_000)];
  const ledger = makeLedger({ rows });
  // Both passes list the row (both read before either wrote), which is the
  // race the SQL's `WHERE ended_at IS NULL` exists to settle.
  const stubbornLister = async () => [{ ...rows[0] }];

  const a = await quietly(() => reapStaleRuns(NOW, { ...ledger.deps, listStaleRuns: stubbornLister }));
  const b = await quietly(() => reapStaleRuns(NOW, { ...ledger.deps, listStaleRuns: stubbornLister }));

  assert.equal(a.reaped, 1, "the first pass wins");
  assert.equal(b.reaped, 0, "the second must not reap it again");
  assert.equal(b.lostRace, 1, "and the loss is recorded, not swallowed");
  assert.equal(b.ok, true, "losing a race is a normal outcome of a concurrent sweep, not a failure");
  assert.equal(b.outcome, RUN_OUTCOMES.NOOP);
  assert.equal(b.reason, REAP_PASS_REASONS.NOTHING_REAPABLE);

  const closes = ledger.closed.filter((r) => r.id === "contested");
  assert.equal(closes.length, 1, "exactly one close reached the ledger");
  assert.equal(ledger.store.get("contested").outcome, "reaped");
  assert.equal(ledger.store.get("contested").reason, REAP_REASON);
});

test("R3.3.2 — a row the listing says is already closed is a race, not a reap", async () => {
  const closedAlready = openRun("done", REAP_STALE_AFTER_MS + 60_000, {
    outcome: "succeeded",
    ended_at: new Date(T0 - 1000).toISOString(),
  });
  const ledger = makeLedger({ rows: [closedAlready] });
  const pass = await quietly(() =>
    reapStaleRuns(NOW, { ...ledger.deps, listStaleRuns: async () => [closedAlready] })
  );

  assert.equal(pass.reaped, 0);
  assert.equal(pass.lostRace, 1);
  assert.equal(
    ledger.store.get("done").outcome,
    "succeeded",
    "a run its writer already accounted for is never relabelled by the sweep"
  );
});

test("R3.3.2 — classifyReapCloseFailure separates a race from a real failure", () => {
  assert.equal(
    classifyReapCloseFailure(
      new Error('closeScanRun: close_scan_run: run abc was already closed as "succeeded" at 2026-01-01')
    ),
    REAP_ROW_VERDICTS.LOST_RACE
  );
  assert.equal(
    classifyReapCloseFailure(
      new Error("closeScanRun: close_scan_run: no run abc exists -- refusing to report a close that wrote nothing")
    ),
    REAP_ROW_VERDICTS.VANISHED
  );
  assert.equal(
    classifyReapCloseFailure(new Error("closeScanRun: connection terminated unexpectedly [57P01]")),
    REAP_ROW_VERDICTS.CLOSE_FAILED,
    "anything unrecognised is a FAILURE, never optimistically filed as a race"
  );
});

test("R3.3.2 — the reaper never reaps its own pass row", async () => {
  const ledger = makeLedger({ rows: [] });
  let excluded = null;
  const pass = await quietly(() =>
    reapStaleRuns(NOW, {
      ...ledger.deps,
      listStaleRuns: async ({ excludeRunId }) => {
        excluded = excludeRunId;
        // The pass's own row, handed back as if the query had matched it, with
        // a heartbeat old enough to qualify. Two guards must stop it.
        return [openRun(excludeRunId, REAP_STALE_AFTER_MS + 60_000)];
      },
    })
  );
  assert.ok(excluded, "the pass's own run id is passed to the listing so the query can exclude it");
  assert.equal(pass.reaped, 0, "and the in-memory guard catches it even if the query does not");
  const passRow = findPassRow(ledger);
  assert.ok(passRow, "the pass still closed its own row itself");
  assert.notEqual(passRow.outcome, "reaped");
});

test("R3.3.6 — listStaleScanRuns applies SQL-side self-exclusion (.neq) when excludeRunId is provided", async () => {
  const calls = [];
  const builder = {
    select(...args) { calls.push({ op: "select", args }); return builder; },
    is(...args) { calls.push({ op: "is", args }); return builder; },
    lt(...args) { calls.push({ op: "lt", args }); return builder; },
    order(...args) { calls.push({ op: "order", args }); return builder; },
    limit(...args) { calls.push({ op: "limit", args }); return builder; },
    neq(...args) { calls.push({ op: "neq", args }); return builder; },
    then(resolve, reject) {
      return Promise.resolve({ data: [], error: null }).then(resolve, reject);
    },
  };
  const client = {
    from(table) {
      calls.push({ op: "from", args: [table] });
      return builder;
    },
  };

  // With excludeRunId: query builder MUST receive .neq("id", excludeRunId)
  await listStaleScanRuns(
    { cutoffIso: new Date(T0 - REAP_STALE_AFTER_MS).toISOString(), limit: 10, excludeRunId: "run-exclude-42" },
    { client }
  );

  const neqCall = calls.find((c) => c.op === "neq");
  assert.ok(neqCall, "query builder must receive neq clause when excludeRunId is provided");
  assert.deepEqual(neqCall.args, ["id", "run-exclude-42"], "neq clause must exclude the given run id on column id");

  // Without excludeRunId: query builder must NOT receive neq
  calls.length = 0;
  await listStaleScanRuns(
    { cutoffIso: new Date(T0 - REAP_STALE_AFTER_MS).toISOString(), limit: 10, excludeRunId: null },
    { client }
  );
  assert.equal(calls.some((c) => c.op === "neq"), false, "query builder must not add neq when excludeRunId is null");
});

test("R3.3.6 — reapStaleRuns passes its own pass run id to the SQL query builder as .neq('id', passRun.id)", async () => {
  const ledger = makeLedger({ rows: [] });
  const calls = [];
  const builder = {
    select(...args) { calls.push({ op: "select", args }); return builder; },
    is(...args) { calls.push({ op: "is", args }); return builder; },
    lt(...args) { calls.push({ op: "lt", args }); return builder; },
    order(...args) { calls.push({ op: "order", args }); return builder; },
    limit(...args) { calls.push({ op: "limit", args }); return builder; },
    neq(...args) { calls.push({ op: "neq", args }); return builder; },
    then(resolve, reject) {
      return Promise.resolve({ data: [], error: null }).then(resolve, reject);
    },
  };
  const client = {
    from(table) {
      calls.push({ op: "from", args: [table] });
      return builder;
    },
  };

  await quietly(() =>
    reapStaleRuns(NOW, {
      ...ledger.deps,
      client,
    })
  );

  const passRow = findPassRow(ledger);
  assert.ok(passRow, "reaper pass opened its own row");
  const neqCall = calls.find((c) => c.op === "neq");
  assert.ok(neqCall, "reaper SQL query builder received .neq clause to self-exclude pass row");
  assert.deepEqual(neqCall.args, ["id", passRow.id], "SQL .neq clause targets passRow.id directly");
});

// ---------------------------------------------------------------------------
// Every pass leaves a trace (rule 1)
// ---------------------------------------------------------------------------

test("R3.3.2 — a reaped row carries who reaped it, when, how stale it was, and the threshold", async () => {
  const stale = openRun("stale", REAP_STALE_AFTER_MS + 45_000);
  const ledger = makeLedger({ rows: [stale] });
  await quietly(() =>
    reapStaleRuns(NOW, {
      ...ledger.deps,
      listStaleRuns: async () => [stale],
      reaperId: "reaper-under-test",
    })
  );

  const row = ledger.store.get("stale");
  assert.equal(row.detail.reaped, true);
  assert.equal(row.detail.reaped_by, "reaper-under-test");
  assert.equal(row.detail.reaped_at, NOW);
  assert.equal(row.detail.stale_ms, REAP_STALE_AFTER_MS + 45_000);
  assert.equal(row.detail.stale_after_ms, REAP_STALE_AFTER_MS);
  assert.equal(row.detail.ttl_ms, RUN_HEARTBEAT_TTL_MS);
  assert.equal(row.detail.last_heartbeat_at, stale.heartbeat_at);
  assert.ok(row.detail.reap_pass_run_id, "the row names the pass that closed it, so both can be joined");
  assert.match(row.error, /reaped by reaper-under-test/);
  assert.match(row.error, /Its writer never closed it/);
});

test("R3.3.2 — a reap NEVER overwrites the dead writer's counters with zeros", async () => {
  const stale = openRun("stale", REAP_STALE_AFTER_MS + 60_000);
  const ledger = makeLedger({ rows: [stale] });
  // What the writer had managed to record before it died.
  ledger.store.get("stale").probes_attempted = 7;
  ledger.store.get("stale").probes_succeeded = 4;

  await quietly(() => reapStaleRuns(NOW, { ...ledger.deps, listStaleRuns: async () => [stale] }));

  const row = ledger.store.get("stale");
  assert.equal(row.probes_attempted, 7, "the reap must not replace a real measurement with 0 (rule 5)");
  assert.equal(row.probes_succeeded, 4);
  assert.equal(row.errors_recovered, null, "and must not invent a count the writer never took");
});

test("R3.3.2 — the PASS files its own row: reaper/reap, measured counts, and no invented probe counters", async () => {
  const rows = [openRun("a", REAP_STALE_AFTER_MS + 1000), openRun("b", REAP_STALE_AFTER_MS + 2000)];
  const ledger = makeLedger({ rows });
  const pass = await quietly(() =>
    reapStaleRuns(NOW, { ...ledger.deps, listStaleRuns: async () => rows, reaperId: "reaper-9" })
  );

  const passRow = findPassRow(ledger);
  assert.ok(passRow, "a sweep that closes other people's rows must leave a row of its own");
  assert.equal(passRow.id, pass.passRunId);
  assert.equal(passRow.worker_id, "reaper-9");
  assert.equal(passRow.outcome, RUN_OUTCOMES.SUCCEEDED);
  assert.equal(passRow.detail.considered, 2);
  assert.equal(passRow.detail.reaped, 2);
  assert.deepEqual(passRow.detail.reaped_run_ids, ["a", "b"]);
  assert.equal(passRow.detail.stale_after_ms, REAP_STALE_AFTER_MS);
  assert.equal(passRow.probes_attempted, null, "a sweep probes nothing; 0 would claim it tried");
  assert.equal(passRow.probes_succeeded, null);
  assert.equal(passRow.errors_recovered, 0, "it DID count absorbed errors, and found none — a measured zero");
});

test("R3.3.2 — a pass that found nothing is a MEASURED zero, and a pass that could not look is not", async () => {
  const ledger = makeLedger({ rows: [] });
  const looked = await quietly(() =>
    reapStaleRuns(NOW, { ...ledger.deps, listStaleRuns: async () => [] })
  );
  assert.equal(looked.considered, 0);
  assert.equal(looked.reaped, 0);
  assert.equal(looked.outcome, RUN_OUTCOMES.NOOP);
  assert.equal(looked.reason, REAP_PASS_REASONS.NO_STALE_RUNS);
  assert.equal(looked.ok, true);
  const passRow = findPassRow(ledger);
  assert.equal(passRow.outcome, RUN_OUTCOMES.NOOP);
  assert.equal(passRow.reason, REAP_PASS_REASONS.NO_STALE_RUNS);

  // ... and the pass that could not look at all.
  assert.equal(
    supabase,
    null,
    "this half is about the path taken when db.js has NO client, and db.js HAS one: the credential " +
      "clearing at the top of this file did not take effect, and this case would hit production"
  );
  const blind = await quietly(() => reapStaleRuns(NOW));
  assert.equal(blind.ok, false);
  assert.equal(blind.reason, REAP_PASS_REASONS.LEDGER_UNAVAILABLE);
  assert.equal(blind.considered, null, "NOT MEASURED — never 0 (rule 1, rule 5)");
  assert.equal(blind.reaped, null);
  assert.equal(blind.runs, null);
  assert.notDeepEqual(
    { c: blind.considered, r: blind.reaped },
    { c: looked.considered, r: looked.reaped },
    "a sweep that could not run must not be readable as a sweep that found nothing"
  );
  assert.match(describeReapPass(blind), /DID NOT RUN/);
  assert.doesNotMatch(describeReapPass(looked), /DID NOT RUN/);
});

test("R3.3.2 — a close that fails for a non-race reason fails the PASS and leaves the row open", async () => {
  const rows = [openRun("broken", REAP_STALE_AFTER_MS + 1000), openRun("fine", REAP_STALE_AFTER_MS + 2000)];
  const ledger = makeLedger({ rows, failCloseIds: new Set(["broken"]) });
  const pass = await quietly(() =>
    reapStaleRuns(NOW, { ...ledger.deps, listStaleRuns: async () => rows })
  );

  assert.equal(pass.reaped, 1, "one bad row does not abort the sweep");
  assert.equal(pass.closeFailed, 1);
  assert.equal(pass.ok, false);
  assert.equal(pass.outcome, RUN_OUTCOMES.FAILED);
  assert.equal(pass.reason, REAP_PASS_REASONS.REAP_FAILED);
  assert.equal(ledger.store.get("broken").outcome, null, "the row it could not close stays OPEN for next time");
  assert.equal(ledger.store.get("fine").outcome, "reaped");

  const passRow = findPassRow(ledger);
  assert.equal(passRow.outcome, RUN_OUTCOMES.FAILED);
  assert.equal(passRow.errors_recovered, 1);
});

test("R3.3.2 — a listing that throws closes the pass FAILED with what it had measured, then rethrows", async () => {
  const ledger = makeLedger({ rows: [] });
  await assert.rejects(
    () =>
      quietly(() =>
        reapStaleRuns(NOW, {
          ...ledger.deps,
          listStaleRuns: async () => {
            const err = new Error("reapStaleRuns: could not list open scan_runs: timeout [57014]");
            err.code = "57014";
            throw err;
          },
        })
      ),
    /could not list open scan_runs/,
    "standing rule 2: the read error propagates with its envelope, never becomes 'zero stale runs'"
  );
  const passRow = findPassRow(ledger);
  assert.equal(passRow.outcome, RUN_OUTCOMES.FAILED);
  assert.equal(passRow.reason, REAP_PASS_REASONS.REAP_FAILED);
  assert.equal(
    passRow.detail.considered,
    null,
    "a pass that died inside the query never counted the open runs — NOT MEASURED, not 0"
  );
});

test("R3.3.2 — hitting the per-pass cap is announced, so a partial sweep never reads as a clean one", async () => {
  const rows = Array.from({ length: 5 }, (_, i) => openRun(`r${i}`, REAP_STALE_AFTER_MS + 1000 * (i + 1)));
  const ledger = makeLedger({ rows });
  const lister = makeLister(rows);
  const pass = await quietly(() =>
    reapStaleRuns(NOW, { ...ledger.deps, listStaleRuns: lister.listStaleRuns, maxPerPass: 2 })
  );

  assert.equal(pass.reaped, 2);
  assert.equal(pass.considered, 2);
  assert.equal(pass.truncated, true, "there were more than this pass could take, and it says so");
  assert.match(describeReapPass(pass), /TRUNCATED/);
  assert.equal(lister.calls[0].limit, 2);

  const second = await quietly(() =>
    reapStaleRuns(NOW, {
      ...ledger.deps,
      listStaleRuns: async (args) =>
        makeLister([...ledger.store.values()].filter((r) => r.runner !== REAPER_RUNNER)).listStaleRuns(args),
      maxPerPass: 2,
    })
  );
  assert.equal(second.reaped, 2, "the next pass picks up where this one stopped");
  assert.equal(second.truncated, true);
});

test("R3.3.2 — oldest heartbeat first, so the most wedged row is never starved by a cap", async () => {
  const rows = [
    openRun("newest", REAP_STALE_AFTER_MS + 1000),
    openRun("oldest", REAP_STALE_AFTER_MS + 900_000),
    openRun("middle", REAP_STALE_AFTER_MS + 60_000),
  ];
  const ledger = makeLedger({ rows });
  const lister = makeLister(rows);
  const pass = await quietly(() =>
    reapStaleRuns(NOW, { ...ledger.deps, listStaleRuns: lister.listStaleRuns, maxPerPass: 1 })
  );
  assert.deepEqual(pass.runs.map((r) => r.id), ["oldest"]);
});

test("R3.3.2 — an undateable open row is counted and left open, not quietly dropped", async () => {
  const weird = { ...openRun("weird", 0), heartbeat_at: "whenever" };
  const ledger = makeLedger({ rows: [weird] });
  const pass = await quietly(() =>
    reapStaleRuns(NOW, { ...ledger.deps, listStaleRuns: async () => [weird] })
  );
  assert.equal(pass.reaped, 0);
  assert.equal(pass.unreadableHeartbeat, 1);
  assert.equal(pass.considered, 1, "it WAS considered — considered and reaped are different numbers");
  assert.equal(ledger.store.get("weird").outcome, null);
});

test("R3.3.2 — a threshold of zero or a nonsense clock is refused outright, never applied", async () => {
  const ledger = makeLedger({ rows: [] });
  await assert.rejects(
    () => reapStaleRuns(NOW, { ...ledger.deps, listStaleRuns: async () => [], staleAfterMs: 0 }),
    /threshold of zero or less reaps every open run/
  );
  await assert.rejects(
    () => reapStaleRuns(NOW, { ...ledger.deps, listStaleRuns: async () => [], staleAfterMs: -1 }),
    /threshold of zero or less/
  );
  await assert.rejects(
    () => reapStaleRuns("not a time", { ...ledger.deps, listStaleRuns: async () => [] }),
    /not a readable instant/
  );
  assert.equal(ledger.opened.length, 0, "nothing was opened and nothing was closed");
});

test("R3.3.2 — the cutoff handed to the query is now minus the threshold, not something else", async () => {
  const ledger = makeLedger({ rows: [] });
  let seen = null;
  await quietly(() =>
    reapStaleRuns(NOW, {
      ...ledger.deps,
      listStaleRuns: async (args) => {
        seen = args;
        return [];
      },
    })
  );
  assert.equal(Date.parse(seen.cutoffIso), T0 - REAP_STALE_AFTER_MS);
  assert.equal(seen.limit, REAP_MAX_PER_PASS);
});

// ---------------------------------------------------------------------------
// Guards: this file has no Postgres, so it checks the SQL it depends on by text
// ---------------------------------------------------------------------------

function migration011() {
  return fs.readFileSync(path.join(process.cwd(), "supabase/migrations/011_scan_runs.sql"), "utf8");
}

test("GUARD — migration 011 still raises the two sentences classifyReapCloseFailure sorts on", () => {
  const sql = migration011();
  assert.match(
    sql,
    /close_scan_run: run % was already closed as "%"/,
    "the race-detection branch matches on 'already closed'. If this RAISE is reworded, every " +
      "lost race is reclassified as a hard failure and the sweep starts reporting itself broken."
  );
  assert.match(
    sql,
    /close_scan_run: no run % exists/,
    "the 'vanished' branch matches on 'no run % exists'"
  );
  assert.match(
    sql,
    /WHERE t\.id = p_run_id\s*\n\s*AND t\.ended_at IS NULL/,
    "the close is conditional on the row still being open — that predicate IS the reaper's " +
      "idempotence, and without it two sweepers would overwrite each other"
  );
});

test("GUARD — 'reaped' is still in the schema's outcome vocabulary and the open index still exists", () => {
  const sql = migration011();
  assert.match(sql, /outcome IN \('succeeded', 'failed', 'skipped', 'reaped', 'noop'\)/);
  assert.match(
    sql,
    /CREATE INDEX IF NOT EXISTS scan_runs_open_idx[\s\S]*?ON scan_runs \(heartbeat_at\)[\s\S]*?WHERE ended_at IS NULL/,
    "the reaper's listing is (ended_at IS NULL, heartbeat_at) and depends on this partial index; " +
      "without it the sweep table-scans all history on every cron tick"
  );
  assert.match(
    sql,
    /CONSTRAINT scan_runs_open_chk CHECK \(\(outcome IS NULL\) = \(ended_at IS NULL\)\)/,
    "reaping sets outcome AND ended_at together because the schema will not store one without the other"
  );
});

// R3.3.4 replaced the guard that used to live here. It asserted the OPPOSITE —
// that src/app/api/scan/worker/route.js did not mention reapStaleRuns — because
// R3.3.2 could not edit that file and wanted the gap recorded rather than
// discovered. The wiring has landed, so the guard is inverted, not deleted: a
// reaper nothing calls is exactly the state this pair of tests exists to catch,
// in whichever direction it happens.
//
// The behaviour of the wiring (a reap that throws cannot fail the scheduler
// tick; the counters reach the body) is asserted against the real functions in
// src/server/scanWorkerRoute.route.test.mjs. This one is a source check because
// the call site itself — not its inputs — is what went missing before.
test("WIRED — the cron sweep calls reapStaleRuns, and the counters reach the response", () => {
  const route = fs.readFileSync(path.join(process.cwd(), "src/app/api/scan/worker/route.js"), "utf8");

  assert.match(
    route,
    /import \{[\s\S]*?\breapStaleRuns\b[\s\S]*?\} from "@\/server\/workers\/scanWorker"/,
    "the route must import the real reaper, not re-implement a sweep of its own"
  );
  assert.match(
    route,
    /reapCounters\(await reap\(nowIso\)\)/,
    "the sweep must actually await a reap pass. Between R3.3.2 and R3.3.4 this function was " +
      "correct, tested and called by nothing, so no stale run was ever closed in production."
  );
  // R6.5.8: the route delegates to executeSweep in _lib/ rather than
  // inlining the sweep. The maintenance function is passed as a dep.
  assert.match(
    route,
    /executeSweep\(/,
    "GET must delegate to executeSweep — a helper nobody calls is the same bug one layer up"
  );
  assert.match(
    route,
    /runSweepMaintenance/,
    "the route must pass runSweepMaintenance to executeSweep — " +
      "reaping in silence would leave the operator reading the same body as a sweep that reaped nothing"
  );
  assert.match(
    route,
    /buildSweepResponse/,
    "the route must pass buildSweepResponse to executeSweep — " +
      "the pass's counters must be handed to the response builder"
  );

  // The isolation, pinned at the source as well as behaviourally: the reap's
  // catch must be its own, not shared with the tick's.
  const maintenance = route.slice(route.indexOf("export async function runSweepMaintenance"));
  // `(?!catch)` matters: without it the lazy scan happily starts at the
  // SCHEDULER's `try {`, runs through the reap call and lands on the
  // scheduler's catch — i.e. it would pass for a reap sharing the tick's
  // try/catch, which is the exact arrangement this asserts against.
  assert.match(
    maintenance,
    /try \{(?:(?!catch)[\s\S])*?reapCounters\(await reap\(nowIso\)\)[\s\S]*?\} catch \(err\) \{[\s\S]*?reapPassThrew\(err\)/,
    "the reap call must sit in a try/catch that answers with reapPassThrew — an uncaught reap " +
      "failure would 500 the whole sweep and throw away the tick that already succeeded"
  );
});

// ---------------------------------------------------------------------------
// R1.2.23 — the fleet's long-lived IDLE row meets this reaper
// ---------------------------------------------------------------------------

/**
 * Until R1.2.23 the fleet opened and closed an idle row inside a single poll,
 * so no fleet row was ever open long enough for this sweep to see it. Now an
 * idle stretch is ONE open row that is heartbeated for as long as the container
 * stays idle, which puts it squarely in this reaper's listing — the predicate in
 * listStaleScanRuns filters on neither `runner` nor `phase`, so an open idle row
 * is exactly as eligible as an open batch row.
 *
 * That is the interaction the ledger flagged when it chose option (b), and these
 * three cases are what make it safe to ship: a beating idle row survives, a
 * silent one is still reaped (an idle fleet must be distinguishable from a dead
 * one, and a dead one must still be CLOSED), and the fleet's configured beat
 * cadence leaves enough margin that the first case is the one that happens.
 */
const { REAP_STALE_AFTER_MS: FLEET_REAP_MIRROR, idleHeartbeatPlan } = await import(
  pathToFileURL(path.join(process.cwd(), "worker/src/lib/runLedger.js")).href
);

/** An open `probe-fleet` / `idle` row, the shape R1.2.23's stretch writes. */
function openIdleFleetRow(id, ageMs) {
  return openRun(id, ageMs, {
    runner: "probe-fleet",
    phase: "idle",
    scan_job_id: null,
    brand: null,
    probes_attempted: 0,
    probes_succeeded: 0,
    errors_recovered: 0,
  });
}

test("R1.2.23 — an OPEN idle fleet row with a fresh heartbeat survives a reap pass", async () => {
  // One beat ago at the fleet's default cadence, plus a whole idle poll of
  // slack: the worst case gap the loop can produce between two beats.
  const beating = openIdleFleetRow("fleet-idle-alive", 30_000 + 10_000);
  const ledger = makeLedger({ rows: [beating] });
  const lister = makeLister([beating]);

  const pass = await quietly(() =>
    reapStaleRuns(NOW, { ...ledger.deps, listStaleRuns: lister.listStaleRuns, reaperId: "reaper-idle-1" })
  );

  assert.equal(pass.reaped, 0, "a fleet that is beating is ALIVE — reaping it would close a live container's row");
  assert.equal(pass.considered, 0, "the listing never even returns it: its heartbeat is inside the cutoff");
  assert.equal(ledger.store.get("fleet-idle-alive").outcome, null, "the idle row is still open for its own fleet to close");
  assert.equal(ledger.store.get("fleet-idle-alive").ended_at, null);
  // And the pass still leaves its own measured-zero row, rather than silence.
  const passRow = findPassRow(ledger);
  assert.equal(passRow.outcome, RUN_OUTCOMES.NOOP);
  assert.equal(passRow.reason, REAP_PASS_REASONS.NO_STALE_RUNS);
});

test("R1.2.23 — the SAME idle row with a stale heartbeat is still reaped: a dead fleet does not stay open forever", async () => {
  const silent = openIdleFleetRow("fleet-idle-dead", REAP_STALE_AFTER_MS + 60_000);
  const ledger = makeLedger({ rows: [silent] });
  const lister = makeLister([silent]);

  const pass = await quietly(() =>
    reapStaleRuns(NOW, { ...ledger.deps, listStaleRuns: lister.listStaleRuns, reaperId: "reaper-idle-2" })
  );

  assert.equal(pass.reaped, 1, "phase='idle' buys no immunity — a row nobody is beating has no writer");
  const row = ledger.store.get("fleet-idle-dead");
  assert.equal(row.outcome, REAP_OUTCOME);
  assert.match(row.reason, /^reaped/);
  assert.equal(row.runner, "probe-fleet", "the reaped row keeps the fleet's own runner, so the loss is attributable");
  assert.equal(row.phase, "idle");
  // The measured zeroes the idle stretch wrote survive the reap (COALESCE): a
  // reaped idle row still says it looked and found nothing, which is the fact
  // R1.2.3 put there and R1.2.23 must not lose.
  assert.equal(row.probes_attempted, 0);
  assert.equal(row.probes_succeeded, 0);
});

test("R1.2.23 — the fleet's idle beat cadence is inside this reaper's threshold, with the margin stated", () => {
  assert.equal(
    FLEET_REAP_MIRROR,
    REAP_STALE_AFTER_MS,
    "worker/ may not import src/, so the fleet carries a COPY of this threshold. If the two ever " +
      "disagree the fleet will believe it is beating fast enough while this sweep closes its live " +
      "idle row every six minutes."
  );

  // The shipped defaults: FLEET_HEARTBEAT_MS=30s, FLEET_IDLE_POLL_MS=10s.
  const plan = idleHeartbeatPlan({ heartbeatMs: 30_000, idlePollMs: 10_000 });
  assert.equal(plan.beatEveryMs, 30_000);
  assert.equal(
    plan.worstCaseGapMs,
    40_000,
    "beats are driven by the poll loop, so the worst gap between two beats is one beat interval " +
      "plus one poll interval"
  );
  assert.equal(plan.staleAfterMs, REAP_STALE_AFTER_MS);
  assert.equal(plan.marginX, 9, "360s / 40s — nine missed beats before this reaper would touch the row");
  assert.equal(plan.safe, true);

  // A row that beat at the worst-case cadence is not stale by this reaper's own
  // arithmetic. Asserted through runStaleness rather than by eye.
  const worst = runStaleness(openIdleFleetRow("worst", plan.worstCaseGapMs), T0);
  assert.equal(worst.stale, false);

  // And the guard bites: the config layer permits FLEET_IDLE_POLL_MS up to 300s
  // and FLEET_HEARTBEAT_MS up to 600s, a combination that CANNOT keep an idle
  // row alive. The fleet must know that at boot rather than discover it as a
  // reaped row every ten minutes.
  const reckless = idleHeartbeatPlan({ heartbeatMs: 600_000, idlePollMs: 300_000 });
  assert.equal(reckless.safe, false);
  assert.ok(reckless.marginX < 1);
  const doomed = runStaleness(openIdleFleetRow("doomed", reckless.worstCaseGapMs), T0);
  assert.equal(doomed.stale, true, "at that cadence the reaper wins the race, which is why boot says so");
});
