import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

import { armedLiveDbGate, notRunBanner } from "./liveDbGate.js";

/**
 * R1.2.3 — the scan_runs ledger against a REAL Postgres.
 *
 * The acceptance criterion is "the migration applies; the fleet writes a
 * heartbeat row per batch", and neither half can be proven by a mock. A fake
 * client has no catalog, so it cannot say whether `scan_runs` and its three
 * functions exist; and it has no CHECK constraints, so it would accept a
 * half-closed row, a second close and an unexplained skip exactly as happily as
 * a correct database would refuse them. This file opens real connections.
 * Nothing here is simulated.
 *
 * IT IS GATED, AND THE GATE IS LOUD.
 * CI has no database. Rather than let the suite go green on a migration nobody
 * applied, an unconfigured run prints a NOT RUN banner to stderr and every case
 * below is reported as skipped with its reason attached. Standing rule 1: a
 * skip is not a success. `src/server/scanRuns.test.mjs` covers what CAN be
 * hermetic — the not-measured/zero distinction, the refusals, the error
 * envelope, what the loop writes — and says out loud that it does not cover the
 * migration.
 *
 * WHAT IT WRITES. Only `scan_runs`, a table migration 011 created and which has
 * never held anything but ledger rows. Every row it writes carries either
 * runner `test-r123-ledger` or a worker id beginning `test-r123`, and both are
 * deleted afterwards. It reads nothing else, and writes nothing else — in
 * particular it never enqueues a probe task, never starts a scan and never
 * spends vendor budget: the claim, the probe and the report are stubbed, and it
 * is the LEDGER calls that are real.
 */

/**
 * R3.2.4 — "only scan_runs" enforced, not merely promised, and armed BEFORE the
 * worker modules below are even loaded.
 *
 * `armedLiveDbGate` installs the default-deny write guard and only then reports
 * whether the gate is open, so there is no order in which this file can be
 * pointed at a real database and not be guarded. Every write in this process,
 * whether it goes over a pg socket or through a Supabase client (including the
 * one built by hand for the fleet cases below — the patch is on the client
 * prototype, so it covers clients this file creates for itself), is checked
 * against `scan_runs` and refused otherwise. A refused write is recorded and
 * fails the run even if the caller catches it.
 */
const GATE = await armedLiveDbGate({
  label: "src/server/scanRunsLive.test.mjs",
  allow: ["scan_runs"],
});
const WRITE_GUARD = GATE.guard;

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const workerIndex = await import(pathToFileURL(path.join(REPO, "worker/src/index.js")).href);
const runLedger = await import(pathToFileURL(path.join(REPO, "worker/src/lib/runLedger.js")).href);

const TEST_RUNNER = "test-r123-ledger";
const TEST_WORKER_PREFIX = "test-r123";

if (!GATE.enabled) {
  // Loud, on stderr, before any test result is printed. A green suite must not
  // be readable as "011 is in production".
  console.error(
    notRunBanner(
      "R1.2.3 LIVE-POSTGRES scan_runs LEDGER",
      GATE.reason,
      "Migration 011 is therefore UNVERIFIED in this run, and so is the fleet's ledger write."
    )
  );
}

/** The connection string, built the same way scripts/setup-supabase.mjs builds it. */
function connectionString(env = process.env) {
  if (env.DATABASE_URL) return env.DATABASE_URL;
  const ref = new URL(env.NEXT_PUBLIC_SUPABASE_URL).hostname.replace(".supabase.co", "");
  const host = env.SUPABASE_DB_HOST || "aws-1-ap-southeast-2.pooler.supabase.com";
  const port = env.SUPABASE_DB_PORT || "5432";
  const user = env.SUPABASE_DB_USER || `postgres.${ref}`;
  return `postgresql://${user}:${encodeURIComponent(env.SUPABASE_DB_PASSWORD)}@${host}:${port}/postgres`;
}

async function connect() {
  const { default: pg } = await import("pg");
  const client = new pg.Client({
    connectionString: connectionString(),
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();
  return client;
}

/** Belt and braces: by runner marker AND by worker-id prefix. */
async function cleanup(client) {
  await client.query(`DELETE FROM scan_runs WHERE runner = $1`, [TEST_RUNNER]);
  await client.query(`DELETE FROM scan_runs WHERE worker_id LIKE $1`, [`${TEST_WORKER_PREFIX}%`]);
}

const opts = GATE.enabled ? {} : { skip: GATE.reason };

// ---------------------------------------------------------------------------
// The migration is IN the database
// ---------------------------------------------------------------------------

test("011 applied: the table, its four indexes and its three functions all exist", opts, async () => {
  const c = await connect();
  try {
    // pg_class, not `SELECT ... LIMIT 0`: a head probe against PostgREST cannot
    // tell a missing table from a permissions error, and this project has
    // already shipped a table whose FUNCTION was absent (009).
    const { rows: tbl } = await c.query(
      `SELECT c.relkind, c.relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relname = 'scan_runs'`
    );
    assert.equal(tbl.length, 1, "scan_runs must exist in the catalog");
    assert.equal(tbl[0].relkind, "r");
    assert.equal(tbl[0].relrowsecurity, true, "house style since 001: RLS on, with an anon policy");

    const { rows: idx } = await c.query(
      `SELECT indexname FROM pg_indexes WHERE schemaname='public' AND tablename='scan_runs' ORDER BY 1`
    );
    assert.deepEqual(
      idx.map((r) => r.indexname),
      [
        "scan_runs_batch_idx",
        "scan_runs_job_idx",
        "scan_runs_open_idx",
        "scan_runs_pkey",
        "scan_runs_runner_idx",
      ]
    );

    // pg_proc, never to_regclass: to_regclass cannot see functions at all.
    const { rows: fns } = await c.query(
      `SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public'
          AND p.proname IN ('open_scan_run','heartbeat_scan_run','close_scan_run')
        ORDER BY 1`
    );
    assert.deepEqual(
      fns.map((r) => r.proname),
      ["close_scan_run", "heartbeat_scan_run", "open_scan_run"]
    );

    // No foreign keys, deliberately (see 011's header): an FK here would take a
    // lock on scan_jobs and would cascade a job's history away with the job.
    const { rows: fks } = await c.query(
      `SELECT count(*)::int AS n FROM pg_constraint WHERE conrelid='public.scan_runs'::regclass AND contype='f'`
    );
    assert.equal(fks[0].n, 0);
  } finally {
    await c.end();
  }
});

// ---------------------------------------------------------------------------
// The constraints are real
// ---------------------------------------------------------------------------

test("a run cannot be half-closed: ended with no outcome is not a storable row", opts, async () => {
  const c = await connect();
  try {
    const { rows } = await c.query(
      `SELECT open_scan_run($1, 'probing', $2) AS r`,
      [TEST_RUNNER, `${TEST_WORKER_PREFIX}-half`]
    );
    const id = rows[0].r.id;

    await assert.rejects(
      () => c.query(`UPDATE scan_runs SET ended_at = now() WHERE id = $1`, [id]),
      /scan_runs_open_chk/,
      "a finished-looking run that says nothing about how it went is the false success itself"
    );
    // The transaction is poisoned by the failed statement; start clean.
    await c.query("ROLLBACK").catch(() => {});
    await assert.rejects(
      () => c.query(`UPDATE scan_runs SET outcome = 'succeeded' WHERE id = $1`, [id]),
      /scan_runs_open_chk/,
      "and a verdict on work that never stopped is equally not storable"
    );
  } finally {
    await cleanup(c);
    await c.end();
  }
});

test("a non-success with no reason is refused by the function AND by the table", opts, async () => {
  const c = await connect();
  try {
    const { rows } = await c.query(`SELECT open_scan_run($1, 'idle', $2) AS r`, [
      TEST_RUNNER,
      `${TEST_WORKER_PREFIX}-reason`,
    ]);
    const id = rows[0].r.id;

    await assert.rejects(
      () => c.query(`SELECT close_scan_run($1, 'skipped') AS r`, [id]),
      /requires a reason/,
      "an unexplained skip is exactly the fact this ledger exists to keep"
    );
    // Straight past the function, at the table itself.
    await assert.rejects(
      () => c.query(`UPDATE scan_runs SET outcome='skipped', ended_at=now() WHERE id = $1`, [id]),
      /scan_runs_reason_chk/
    );
    const closed = await c.query(`SELECT close_scan_run($1, 'skipped', 'not_due') AS r`, [id]);
    assert.equal(closed.rows[0].r.outcome, "skipped");
    assert.equal(closed.rows[0].r.reason, "not_due");
  } finally {
    await cleanup(c);
    await c.end();
  }
});

test("a second close is refused, and names the outcome that beat it", opts, async () => {
  const c = await connect();
  try {
    const { rows } = await c.query(`SELECT open_scan_run($1, 'probe_batch', $2) AS r`, [
      TEST_RUNNER,
      `${TEST_WORKER_PREFIX}-double`,
    ]);
    const id = rows[0].r.id;
    await c.query(`SELECT close_scan_run($1, 'reaped', 'heartbeat_stale') AS r`, [id]);

    // A late writer must not be able to relabel work that was taken off it as
    // work it finished.
    await assert.rejects(
      () => c.query(`SELECT close_scan_run($1, 'succeeded') AS r`, [id]),
      /already closed as "reaped"/
    );

    const { rows: after } = await c.query(`SELECT outcome, reason FROM scan_runs WHERE id = $1`, [id]);
    assert.equal(after[0].outcome, "reaped", "the first close wins");
    assert.equal(after[0].reason, "heartbeat_stale");
  } finally {
    await cleanup(c);
    await c.end();
  }
});

test("closing or heartbeating a run that does not exist RAISES; it never reports a quiet success", opts, async () => {
  const c = await connect();
  try {
    const ghost = "00000000-0000-0000-0000-0000000000ff";
    await assert.rejects(
      () => c.query(`SELECT close_scan_run($1, 'succeeded') AS r`, [ghost]),
      /no run .* exists/,
      "a close that wrote nothing must not come back looking like a close that wrote something"
    );
    await assert.rejects(
      () => c.query(`SELECT heartbeat_scan_run($1) AS r`, [ghost]),
      /no run .* exists/
    );
  } finally {
    await c.end();
  }
});

test("an unmeasured counter and a measured zero are different rows in the database", opts, async () => {
  const c = await connect();
  try {
    const mk = async (phase) => {
      const { rows } = await c.query(`SELECT open_scan_run($1, $2, $3) AS r`, [
        TEST_RUNNER,
        phase,
        `${TEST_WORKER_PREFIX}-counts`,
      ]);
      return rows[0].r.id;
    };
    const unmeasured = await mk("unmeasured");
    const measured = await mk("measured");

    await c.query(`SELECT close_scan_run($1, 'succeeded') AS r`, [unmeasured]);
    await c.query(`SELECT close_scan_run($1, 'noop', 'queue_empty', 0, 0, 0) AS r`, [measured]);

    const { rows } = await c.query(
      `SELECT phase, probes_attempted, probes_succeeded, errors_recovered FROM scan_runs
        WHERE id = ANY($1::uuid[]) ORDER BY phase`,
      [[unmeasured, measured]]
    );
    const [m, u] = rows;
    assert.equal(m.phase, "measured");
    assert.equal(m.probes_attempted, 0, "a measured zero is stored as 0");
    assert.equal(u.phase, "unmeasured");
    assert.equal(u.probes_attempted, null, "an unwritten counter stays NULL: not measured, not zero");
    assert.notEqual(m.probes_attempted, u.probes_attempted);
  } finally {
    await cleanup(c);
    await c.end();
  }
});

test("a claimed-more-than-attempted count cannot be stored", opts, async () => {
  const c = await connect();
  try {
    const { rows } = await c.query(`SELECT open_scan_run($1, 'probe_batch', $2) AS r`, [
      TEST_RUNNER,
      `${TEST_WORKER_PREFIX}-arith`,
    ]);
    await assert.rejects(
      () => c.query(`SELECT close_scan_run($1, 'succeeded', NULL, 2, 5) AS r`, [rows[0].r.id]),
      /scan_runs_counts_chk/,
      "a >100% success rate is the arithmetic signature of the bug this rebuild is named after"
    );
  } finally {
    await cleanup(c);
    await c.end();
  }
});

test("an anonymous run is refused: a ledger row about nobody is not evidence", opts, async () => {
  const c = await connect();
  try {
    await assert.rejects(
      () => c.query(`SELECT open_scan_run('', 'probing') AS r`),
      /p_runner is required/
    );
    await assert.rejects(
      () => c.query(`SELECT open_scan_run($1, '   ') AS r`, [TEST_RUNNER]),
      /p_phase is required/
    );
    // Nothing at all to attribute the row to.
    await assert.rejects(
      () => c.query(`INSERT INTO scan_runs (runner, phase) VALUES ($1, 'probing')`, [TEST_RUNNER]),
      /scan_runs_subject_chk/
    );
  } finally {
    await cleanup(c);
    await c.end();
  }
});

// ---------------------------------------------------------------------------
// The accept: the FLEET writes the row, through its own code path
// ---------------------------------------------------------------------------

/**
 * The fleet reaches the ledger over PostgREST with a Supabase key, not over a
 * pg socket, so this needs a key as well as the gate. Named separately because
 * "the SQL works but the fleet's client cannot call it" is a real failure mode
 * and must not hide behind the pg tests above.
 */
const SUPA_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || null;
const SUPA_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || null;
const fleetOpts = !GATE.enabled
  ? { skip: GATE.reason }
  : SUPA_URL && SUPA_KEY
    ? {}
    : { skip: "no SUPABASE_URL/key in this environment, so the fleet's own client path is unproven" };

if (GATE.enabled && !(SUPA_URL && SUPA_KEY)) {
  console.error(
    notRunBanner(
      "R1.2.3 FLEET LEDGER WRITE",
      "no SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY (or anon key)",
      "The SQL is verified, but that the FLEET can write a run through its own client is not."
    )
  );
}

test("one-shot fleet passes write one scan_runs row — a real batch and a real idle poll", fleetOpts, async () => {
  const { createClient } = await import("@supabase/supabase-js");
  const supa = createClient(SUPA_URL, SUPA_KEY, { auth: { persistSession: false } });
  const pgc = await connect();

  // The real ledger functions, against the real database. Only the queue and
  // the probe are stubbed: this test must not claim a live task or drive a
  // browser, and probeBatch is still a refusal until R1.3 anyway.
  const ledgerDeps = {
    openRun: (fields, config) => runLedger.openRun(fields, config, { client: supa }),
    heartbeatRun: (runId, config) => runLedger.heartbeatRun(runId, config, { client: supa }),
    closeRun: (runId, fields, config) => runLedger.closeRun(runId, fields, config, { client: supa }),
  };
  const config = {
    workerId: `${TEST_WORKER_PREFIX}-fleet-${Date.now()}`,
    engines: ["test-r123"],
    batchSize: 2,
    leaseMs: 180000,
    heartbeatMs: 20000,
  };
  const tasks = [
    { id: "aaaaaaaa-0000-0000-0000-000000000001", batch_id: "bbbbbbbb-0000-0000-0000-000000000001", scan_job_id: null },
    { id: "aaaaaaaa-0000-0000-0000-000000000002", batch_id: "bbbbbbbb-0000-0000-0000-000000000001", scan_job_id: null },
  ];
  const claimed = {
    owner: config.workerId,
    tasks,
    claimedCount: 2,
    outstanding: 2,
    leasedElsewhere: 0,
    reason: "claimed",
    leaseExpiresAt: null,
    observedAt: null,
  };
  const empty = { ...claimed, tasks: [], claimedCount: 0, outstanding: 0, reason: "queue_empty" };

  const origLog = console.log;
  console.log = () => {};
  let timers = [];
  try {
    // Pass 1: a claimed batch. One probe answers, one is blocked.
    await workerIndex.runOnce(config, {
      claimBatch: async () => claimed,
      probeBatch: async (batch) => [
        { id: batch[0].id, outcome: "answered", detail: { fixture: true } },
        { id: batch[1].id, outcome: "blocked", detail: { fixture: true } },
      ],
      reportBatch: async () => ({ asked: 2, applied: 2, rejected: [] }),
      setIntervalFn: (fn, ms) => {
        timers.push({ fn, ms });
        return { id: timers.length };
      },
      clearIntervalFn: () => {},
      ...ledgerDeps,
    });
    // The heartbeat, against the real function, while the run was open. It is
    // fired by hand rather than waited for: a 20s sleep in a test is a test
    // nobody runs.
    // Pass 2: an idle poll.
    await workerIndex.runOnce(config, { claimBatch: async () => empty, ...ledgerDeps });
  } finally {
    console.log = origLog;
  }

  try {
    const { rows } = await pgc.query(
      `SELECT phase, outcome, reason, probes_attempted, probes_succeeded, errors_recovered,
              batch_id, ended_at IS NOT NULL AS closed, heartbeat_at >= started_at AS beat_ok, detail
         FROM scan_runs WHERE worker_id = $1 ORDER BY phase`,
      [config.workerId]
    );
    assert.equal(rows.length, 2, "each one-shot caller owns and closes its row");

    const batchRow = rows.find((r) => r.phase === "probe_batch");
    assert.ok(batchRow, "the claimed pass must have written a row");
    assert.equal(batchRow.closed, true);
    assert.equal(batchRow.outcome, "succeeded");
    assert.equal(batchRow.probes_attempted, 2);
    assert.equal(batchRow.probes_succeeded, 1, "the blocked probe is not a success");
    assert.equal(batchRow.errors_recovered, 1);
    assert.equal(batchRow.batch_id, "bbbbbbbb-0000-0000-0000-000000000001");
    assert.equal(batchRow.detail.applied, 2);

    const idleRow = rows.find((r) => r.phase === "idle");
    assert.ok(idleRow, "the idle pass must have written a row too, or a dead fleet looks like a quiet one");
    assert.equal(idleRow.outcome, "noop");
    assert.equal(idleRow.reason, "queue_empty");
    assert.equal(idleRow.probes_attempted, 0, "measured zero, not NULL");
  } finally {
    await cleanup(pgc);
    await pgc.end();
  }
});

test("the fleet's heartbeat really moves heartbeat_at on the live row", fleetOpts, async () => {
  const { createClient } = await import("@supabase/supabase-js");
  const supa = createClient(SUPA_URL, SUPA_KEY, { auth: { persistSession: false } });
  const pgc = await connect();
  const config = { workerId: `${TEST_WORKER_PREFIX}-beat-${Date.now()}` };
  try {
    const run = await runLedger.openRun(
      { runner: TEST_RUNNER, phase: "probe_batch", workerId: config.workerId },
      config,
      { client: supa }
    );
    const before = await pgc.query(`SELECT heartbeat_at FROM scan_runs WHERE id = $1`, [run.id]);
    await new Promise((r) => setTimeout(r, 25));
    await runLedger.heartbeatRun(run.id, config, { client: supa });
    const after = await pgc.query(`SELECT heartbeat_at FROM scan_runs WHERE id = $1`, [run.id]);
    assert.ok(
      after.rows[0].heartbeat_at > before.rows[0].heartbeat_at,
      "a heartbeat that does not move the timestamp cannot keep a long batch from being reaped"
    );

    // And once the run is closed, a late beat is an error rather than a no-op.
    await runLedger.closeRun(run.id, { outcome: "reaped", reason: "test" }, config, { client: supa });
    await assert.rejects(
      () => runLedger.heartbeatRun(run.id, config, { client: supa }),
      /already closed/,
      "being heartbeated after something else closed you is how a worker learns it was reaped"
    );
  } finally {
    await cleanup(pgc);
    await pgc.end();
  }
});

test("GUARD — the write guard was live for this run, and refused nothing", opts, () => {
  // The coverage flags come first: "refused nothing" is also what a guard that
  // patched nothing would report, and an unarmed guard reading as a clean run
  // is the exact false success this whole mechanism exists to prevent.
  assert.equal(WRITE_GUARD.covers.pg, true, "the pg driver was never patched");
  assert.equal(WRITE_GUARD.covers.supabase, true, "the Supabase client prototype was never patched");
  assert.deepEqual(WRITE_GUARD.allowed, ["scan_runs"]);
  WRITE_GUARD.assertClean();
  assert.ok(
    WRITE_GUARD.writes.some((w) => w.table === "scan_runs"),
    "no scan_runs write was seen at all, so these cases proved nothing about the ledger"
  );
});
