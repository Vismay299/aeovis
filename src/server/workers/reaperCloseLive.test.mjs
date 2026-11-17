import test from "node:test";
import assert from "node:assert/strict";

import { armedLiveDbGate, notRunBanner } from "../liveDbGate.js";

/**
 * R3.3.5 — the reaper's idempotence, proven against a REAL Postgres.
 *
 * scanRunReaper.test.mjs exercises reapStaleRuns against a JS fake that
 * re-implements what migration 011's close_scan_run is believed to do, and
 * classifyReapCloseFailure sorts a failed close by TEXT-MATCHING the plpgsql
 * RAISE strings. Neither had ever met the real function. Here:
 *
 *   1. the real close_scan_run, reached through the app's own closeScanRun over
 *      PostgREST, raises on a second close — and the error that actually arrives
 *      in JS is classified lost_race;
 *   2. a close of a run that does not exist is classified vanished, and a
 *      malformed id (a genuine database error) is classified close_failed —
 *      so the text match neither misses a race nor hides a real failure;
 *   3. two real reapStaleRuns passes racing the same stale row close it exactly
 *      once: one pass reaps, the other records lost_race, and a third pass finds
 *      nothing to do.
 *
 * GATED, LOUDLY: with no database configured every case is SKIPPED with its
 * reason and a NOT RUN banner goes to stderr. A skip is not a success.
 *
 * WHAT IT WRITES: only scan_runs, enforced by the armed write guard. Every row
 * carries runner or worker id starting `test-r335` and is deleted afterwards.
 * The listing handed to the reaper is filtered to this file's own row, so a
 * test pass never reaps a real production run.
 *
 * Run: npm run test:live -- src/server/workers/reaperCloseLive.test.mjs
 */

const GATE = await armedLiveDbGate({
  label: "src/server/workers/reaperCloseLive.test.mjs",
  allow: ["scan_runs"],
});
const WRITE_GUARD = GATE.guard;

const TEST_PREFIX = "test-r335";

if (!GATE.enabled) {
  console.error(
    notRunBanner(
      "R3.3.5 LIVE-POSTGRES REAPER IDEMPOTENCE",
      GATE.reason,
      "close_scan_run's double-close refusal and classifyReapCloseFailure's text match are UNVERIFIED in this run."
    )
  );
}

const SUPA_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || null;
const SUPA_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || null;
const opts = !GATE.enabled
  ? { skip: GATE.reason }
  : SUPA_URL && SUPA_KEY
    ? {}
    : { skip: "no Supabase URL/key, so the app's PostgREST close path cannot be exercised" };

const { openScanRun, closeScanRun, listStaleScanRuns } = await import("../scanRuns.js");
const { classifyReapCloseFailure, reapStaleRuns, REAP_ROW_VERDICTS } = await import("./scanWorker.js");

/** Same connection string scripts/setup-supabase.mjs and scanRunsLive.test.mjs build. */
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
  const client = new pg.Client({ connectionString: connectionString(), ssl: { rejectUnauthorized: false } });
  await client.connect();
  return client;
}

async function supabaseClient() {
  const { createClient } = await import("@supabase/supabase-js");
  return createClient(SUPA_URL, SUPA_KEY, { auth: { persistSession: false } });
}

async function cleanup(pgc) {
  await pgc.query(`DELETE FROM scan_runs WHERE runner LIKE $1 OR worker_id LIKE $1`, [`${TEST_PREFIX}%`]);
}

/** The error closeScanRun actually throws, or a failure if it did not throw. */
async function closeError(fields, deps) {
  try {
    await closeScanRun(fields, deps);
  } catch (err) {
    return err;
  }
  assert.fail(`closeScanRun(${JSON.stringify(fields)}) was expected to throw and did not`);
}

test("a second close through the app's closeScanRun RAISES, and the real error is classified lost_race", opts, async () => {
  const supa = await supabaseClient();
  const pgc = await connect();
  try {
    const run = await openScanRun(
      { runner: `${TEST_PREFIX}-double`, phase: "probing", workerId: `${TEST_PREFIX}-double` },
      { client: supa }
    );
    const first = await closeScanRun({ runId: run.id, outcome: "reaped", reason: "heartbeat_stale" }, { client: supa });
    assert.equal(first.outcome, "reaped");

    const err = await closeError({ runId: run.id, outcome: "succeeded" }, { client: supa });
    assert.equal(
      classifyReapCloseFailure(err),
      REAP_ROW_VERDICTS.LOST_RACE,
      `the real double-close error must read as a race, got: ${err.message}`
    );

    const { rows } = await pgc.query(`SELECT outcome, reason FROM scan_runs WHERE id = $1`, [run.id]);
    assert.equal(rows[0].outcome, "reaped", "the first close wins; the second changed nothing");
    assert.equal(rows[0].reason, "heartbeat_stale");
  } finally {
    await cleanup(pgc);
    await pgc.end();
  }
});

test("a close of a run that does not exist is vanished; a malformed id is close_failed, not a race", opts, async () => {
  const supa = await supabaseClient();

  const ghost = await closeError(
    { runId: "00000000-0000-0000-0000-000000000335", outcome: "succeeded" },
    { client: supa }
  );
  assert.equal(classifyReapCloseFailure(ghost), REAP_ROW_VERDICTS.VANISHED, `got: ${ghost.message}`);

  const malformed = await closeError({ runId: "not-a-uuid", outcome: "succeeded" }, { client: supa });
  assert.equal(
    classifyReapCloseFailure(malformed),
    REAP_ROW_VERDICTS.CLOSE_FAILED,
    `a real database error must never be absorbed as a race, got: ${malformed.message}`
  );
});

test("two real reap passes racing one stale row close it exactly once; a third pass has nothing to do", opts, async () => {
  const supa = await supabaseClient();
  const pgc = await connect();
  try {
    const victim = await openScanRun(
      { runner: `${TEST_PREFIX}-victim`, phase: "probing", workerId: `${TEST_PREFIX}-victim` },
      { client: supa }
    );
    // An hour of silence: stale by any threshold the reaper uses.
    await pgc.query(
      `UPDATE scan_runs SET started_at = now() - interval '2 hours', heartbeat_at = now() - interval '1 hour' WHERE id = $1`,
      [victim.id]
    );

    // Both passes LIST before either CLOSES, so the race is certain rather than
    // left to scheduling. The listing is the real query, filtered to this row.
    let release;
    const barrier = new Promise((r) => (release = r));
    let listed = 0;
    const listOnlyVictim = async (args) => {
      const rows = await listStaleScanRuns(args, { client: supa });
      const mine = rows.filter((r) => r.id === victim.id);
      listed += 1;
      if (listed === 2) release();
      await barrier;
      return mine;
    };
    const ledger = {
      openScanRun: (f) => openScanRun(f, { client: supa }),
      heartbeatScanRun: (f) => Promise.resolve(f),
      closeScanRun: (f) => closeScanRun(f, { client: supa }),
    };
    const pass = (n) =>
      reapStaleRuns(new Date().toISOString(), {
        ...ledger,
        client: supa,
        listStaleRuns: listOnlyVictim,
        reaperId: `${TEST_PREFIX}-reaper-${n}`,
      });

    const [a, b] = await Promise.all([pass(1), pass(2)]);
    assert.equal(a.considered, 1);
    assert.equal(b.considered, 1);
    assert.equal(a.reaped + b.reaped, 1, "exactly one pass may close the row");
    assert.equal(a.lostRace + b.lostRace, 1, "the other pass must record the race, not a failure");
    assert.equal(a.closeFailed + b.closeFailed, 0, "a lost race is not a close failure");

    const { rows } = await pgc.query(`SELECT outcome, reason, ended_at IS NOT NULL AS closed FROM scan_runs WHERE id = $1`, [
      victim.id,
    ]);
    assert.equal(rows[0].closed, true);
    assert.equal(rows[0].outcome, "reaped");

    // Re-running is safe by construction: a closed row is no longer a candidate.
    const third = await reapStaleRuns(new Date().toISOString(), {
      ...ledger,
      client: supa,
      listStaleRuns: async (args) =>
        (await listStaleScanRuns(args, { client: supa })).filter((r) => r.id === victim.id),
      reaperId: `${TEST_PREFIX}-reaper-3`,
    });
    assert.equal(third.considered, 0);
    assert.equal(third.reaped, 0);
  } finally {
    await cleanup(pgc);
    await pgc.end();
  }
});

test("GUARD — the write guard was live for this run, and refused nothing", opts, () => {
  assert.equal(WRITE_GUARD.covers.pg, true, "the pg driver was never patched");
  assert.equal(WRITE_GUARD.covers.supabase, true, "the Supabase client prototype was never patched");
  WRITE_GUARD.assertClean();
  assert.ok(
    WRITE_GUARD.writes.some((w) => w.table === "scan_runs"),
    "no scan_runs write was seen at all, so these cases proved nothing"
  );
});
