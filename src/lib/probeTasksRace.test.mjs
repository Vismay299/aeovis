import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

import { armedLiveDbGate, notRunBanner } from "./liveDbGate.js";

/**
 * R1.2.2 — the claim race, against a REAL Postgres.
 *
 * The acceptance criterion is "two workers racing for the same batch produce
 * exactly one claim". That is a statement about Postgres row locking, and a
 * mock cannot make it true or false: an in-process fake has one process, one
 * event loop and no lock manager, so it would pass whatever `claim_probe_tasks`
 * happened to do. This file therefore opens SEPARATE CONNECTIONS and races
 * them. Nothing here is simulated.
 *
 * IT IS GATED, AND THE GATE IS LOUD.
 * CI has no database. Rather than let the suite quietly go green on a race
 * nobody ran, an unconfigured run prints a NOT RUN banner to stderr and every
 * case below is reported as skipped with its reason attached. Standing rule 1:
 * a skip is not a success. `src/lib/probeQueue.test.mjs` covers the parts that
 * CAN be hermetic — the empty/leased distinction, the refusals, the error
 * envelope — and says out loud that it does not cover the race.
 *
 * WHAT IT WRITES. Only `probe_tasks`, a table created by migration 010 that has
 * never held customer data. Every row it inserts carries engine
 * `test-r122-race` and a per-run batch id, and is deleted afterwards.
 *
 * R1.2.8 (finding S29) — WHICH CASE IS THE ATOMICITY PROOF.
 * R1.2.2's verifier stripped `FOR UPDATE SKIP LOCKED` out of the claim function
 * and BOTH six-worker cases still passed. That is not a fluke: six connections
 * through a small local pool tend to serialize, so each racer arrives after the
 * previous one has committed, correctly sees the row as leased, and reports
 * zero — which looks exactly like the lock working. They are SMOKE coverage,
 * renamed below to say so. The proof is the deterministic case, "SKIP LOCKED —
 * a claim held in an open transaction is not handed to a second worker": it
 * holds A's transaction open from a third connection, so the lock is provably
 * held while B tries, and it fails both ways the clause can be broken (a bare
 * FOR UPDATE makes B block; no clause at all lets B steal the row).
 *
 * And because everything here is skipped without a database, the clause is
 * additionally asserted as SQL TEXT, hermetically, in
 * `src/lib/probeClaimLock.test.mjs`. That file states plainly that it tests the
 * migration's text and not Postgres's behaviour. It is the weaker claim; it is
 * the one that can run in CI. Neither substitutes for the other.
 */

const TEST_ENGINE = "test-r122-race";
const NOT_PROBED = "R1.2.2 RACE FIXTURE — never probed, deleted after the run";

/**
 * R3.2.4 — "only probe_tasks" enforced rather than promised, and armed BEFORE
 * the gate is even reported open. Every write this process attempts is checked
 * against that one table and refused otherwise, across both transports, and a
 * refusal fails the run even if it is caught. `armedLiveDbGate` is the only way
 * this file learns whether a database is configured, so there is no ordering in
 * which it can be pointed at one unguarded.
 */
const GATE = await armedLiveDbGate({
  label: "src/lib/probeTasksRace.test.mjs",
  allow: ["probe_tasks"],
});
const WRITE_GUARD = GATE.guard;

if (!GATE.enabled) {
  // Loud, on stderr, before any test result is printed. A suite that goes green
  // must not be readable as "the race was proven". The hermetic coverage in
  // src/lib/probeQueue.test.mjs does NOT substitute: a mock has no lock manager.
  console.error(
    notRunBanner(
      "R1.2.2 LIVE-POSTGRES CLAIM RACE",
      GATE.reason,
      "The claim's atomicity is therefore UNPROVEN in this run."
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

async function connect(n = 1) {
  const { default: pg } = await import("pg");
  const clients = [];
  for (let i = 0; i < n; i++) {
    const c = new pg.Client({
      connectionString: connectionString(),
      ssl: { rejectUnauthorized: false },
    });
    await c.connect();
    clients.push(c);
  }
  return clients;
}

/** Seed `count` fixture tasks in one batch. Returns the batch id. */
async function seed(client, count) {
  const batchId = crypto.randomUUID();
  const queries = Array.from({ length: count }, (_, i) => `${NOT_PROBED} #${i + 1}`);
  await client.query(
    `INSERT INTO probe_tasks (batch_id, engine, query)
     SELECT $1::uuid, $2::text, q FROM unnest($3::text[]) AS q`,
    [batchId, TEST_ENGINE, queries]
  );
  return batchId;
}

async function cleanup(client, batchId) {
  // Belt and braces: by batch, and by the unmistakable fixture engine, so a
  // crashed run cannot leave rows behind for the next one to trip over.
  await client.query(`DELETE FROM probe_tasks WHERE batch_id = $1::uuid`, [batchId]);
  await client.query(`DELETE FROM probe_tasks WHERE engine = $1`, [TEST_ENGINE]);
}

const claim = (client, owner, batchId, { limit = 5, leaseMs = 180000 } = {}) =>
  client
    .query(`SELECT claim_probe_tasks($1, $2::text[], $3, $4, $5::uuid) AS r`, [
      owner,
      [TEST_ENGINE],
      limit,
      leaseMs,
      batchId,
    ])
    .then((res) => res.rows[0].r);

const opts = GATE.enabled ? {} : { skip: GATE.reason };

test("the fixture table exists and is the one migration 010 created", opts, async () => {
  const [c] = await connect(1);
  try {
    const { rows } = await c.query(
      `SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public'
          AND p.proname IN ('claim_probe_tasks','complete_probe_tasks','renew_probe_lease','release_probe_tasks')
        ORDER BY 1`
    );
    // pg_proc, not to_regclass: this project has already shipped a table whose
    // function was missing, and to_regclass cannot see functions.
    assert.deepEqual(
      rows.map((r) => r.proname),
      ["claim_probe_tasks", "complete_probe_tasks", "release_probe_tasks", "renew_probe_lease"]
    );
  } finally {
    await c.end();
  }
});

test("SMOKE (NOT the atomicity proof) — six workers, one task, exactly one claim", opts, async () => {
  // R1.2.8. Renamed from "RACE — ...". This case does NOT prove the claim is
  // atomic and must not be cited as if it did: with FOR UPDATE SKIP LOCKED
  // stripped from migration 010 it still passes, because the six connections
  // serialize and each racer legitimately finds the row already leased. What it
  // does prove is worth keeping — the report shape under real concurrency, and
  // that a loser says "busy" rather than "empty". For the atomicity guarantee
  // see "SKIP LOCKED — a claim held in an open transaction ..." below, and
  // src/lib/probeClaimLock.test.mjs for the hermetic text-level guard.
  const RACERS = 6;
  const clients = await connect(RACERS + 1);
  const seeder = clients[RACERS];
  let batchId;
  try {
    batchId = await seed(seeder, 1);

    // Concurrent as far as this process can make it: six independent
    // connections, all fired before any is awaited. No sequencing, no shared
    // process state. Whether the SERVER interleaves them is not ours to force,
    // which is precisely why this case is smoke and not proof.
    const reports = await Promise.all(
      clients.slice(0, RACERS).map((c, i) => claim(c, `race-worker-${i}`, batchId))
    );

    const winners = reports.filter((r) => r.claimed_count > 0);
    const losers = reports.filter((r) => r.claimed_count === 0);

    assert.equal(winners.length, 1, `exactly one worker may win; ${winners.length} did`);
    assert.equal(winners[0].tasks.length, 1);
    assert.equal(losers.length, RACERS - 1);

    // The losers' refusal must be distinguishable from an empty queue. This is
    // the assertion standing rule 1 exists for: an unbuilt queue, an empty one
    // and a contended one must not produce the same signal.
    for (const l of losers) {
      assert.equal(l.tasks.length, 0);
      assert.ok(
        l.outstanding >= 1,
        `a loser must still see the work outstanding, not an empty queue; saw ${l.outstanding}`
      );
    }

    // And the database agrees: one row, claimed once, by one owner.
    const { rows } = await seeder.query(
      `SELECT status, lease_owner, attempts FROM probe_tasks WHERE batch_id = $1::uuid`,
      [batchId]
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, "claimed");
    assert.equal(rows[0].attempts, 1, "one claim means one attempt, not six");
    assert.equal(rows[0].lease_owner, winners[0].owner);
  } finally {
    if (batchId) await cleanup(seeder, batchId);
    await Promise.all(clients.map((c) => c.end()));
  }
});

test("SMOKE (NOT the atomicity proof) — six workers, six tasks, no double-hand-out", opts, async () => {
  // R1.2.8. Same caveat as the case above: this passed with SKIP LOCKED removed
  // when R1.2.2's verifier tried it. Serialized racers each take a different
  // head of the queue whether or not a lock is held, so "no id was handed out
  // twice" holds either way. Kept as smoke; the proof is two cases down.
  const RACERS = 6;
  const clients = await connect(RACERS + 1);
  const seeder = clients[RACERS];
  let batchId;
  try {
    batchId = await seed(seeder, RACERS);

    // limit 1 each, so all six contend on the same head of the queue.
    const reports = await Promise.all(
      clients.slice(0, RACERS).map((c, i) => claim(c, `spread-worker-${i}`, batchId, { limit: 1 }))
    );

    const claimedIds = reports.flatMap((r) => r.tasks.map((t) => t.id));
    assert.equal(new Set(claimedIds).size, claimedIds.length, "no task may be handed to two workers");

    const { rows } = await seeder.query(
      `SELECT attempts, COUNT(*)::int AS n FROM probe_tasks WHERE batch_id = $1::uuid GROUP BY 1`,
      [batchId]
    );
    for (const r of rows) {
      assert.ok(r.attempts <= 1, `a task was claimed ${r.attempts} times`);
    }
  } finally {
    if (batchId) await cleanup(seeder, batchId);
    await Promise.all(clients.map((c) => c.end()));
  }
});

test("SKIP LOCKED (THE ATOMICITY PROOF) — a claim held in an open transaction is not handed to a second worker", opts, async () => {
  // Deterministic, not probabilistic: worker A claims inside a transaction and
  // does NOT commit, so the row lock is provably held while B tries. This is
  // the case that breaks when the clause does — B steals the row without any
  // lock, and blocks forever on a bare FOR UPDATE.
  const [a, b, seeder] = await connect(3);
  let batchId;
  try {
    batchId = await seed(seeder, 1);

    // R1.2.8. Without this, the FOR-UPDATE-without-SKIP-LOCKED regression does
    // not fail the suite — it HANGS it: B waits on A's uncommitted lock until
    // the whole run is killed, which reads as an infrastructure flake rather
    // than the regression it is. A bounded timeout turns that hang into a named
    // red. Five seconds is far longer than any claim here takes (the queries
    // below are single-row and local) and far shorter than the 3-minute lease.
    await b.query("SET statement_timeout = 5000");

    await a.query("BEGIN");
    const aReport = await claim(a, "holder-A", batchId);
    assert.equal(aReport.claimed_count, 1, "A must win the uncontended claim");

    const bReport = await claim(b, "starved-B", batchId).catch((err) => {
      // Distinguish the two ways the clause can be wrong, in the message.
      if (/statement timeout/i.test(String(err && err.message))) {
        throw new Error(
          "B BLOCKED on the row A holds instead of skipping past it. That is " +
            "FOR UPDATE without SKIP LOCKED in claim_probe_tasks: a contended " +
            "queue stalls the whole fleet behind its slowest holder. " +
            "See supabase/migrations/010_probe_tasks.sql, the candidate CTE."
        );
      }
      throw err;
    });
    assert.equal(
      bReport.claimed_count,
      0,
      "B must not get a row A has locked — a non-zero count here means the " +
        "candidate SELECT takes no row lock at all and the claim can be stolen"
    );
    assert.equal(bReport.tasks.length, 0);
    // B still sees the work: "busy" not "empty".
    assert.ok(bReport.outstanding >= 1, "B must see the task as outstanding, not gone");

    await a.query("COMMIT");

    // After the commit and still inside the lease, B is refused again — and now
    // it can name the holder count, so its log line reads as contention.
    const bAgain = await claim(b, "starved-B", batchId);
    assert.equal(bAgain.claimed_count, 0);
    assert.equal(bAgain.outstanding, 1);
    assert.equal(bAgain.leased_elsewhere, 1, "B must be able to see the task is leased, not gone");
  } finally {
    await a.query("ROLLBACK").catch(() => {});
    if (batchId) await cleanup(seeder, batchId);
    await Promise.all([a.end(), b.end(), seeder.end()]);
  }
});

test("LEASE EXPIRY — a stale claim becomes reclaimable, and not one moment before", opts, async () => {
  const [a, b, seeder] = await connect(3);
  let batchId;
  try {
    batchId = await seed(seeder, 1);

    const first = await claim(a, "crashing-A", batchId, { leaseMs: 1000 });
    assert.equal(first.claimed_count, 1);

    // Before expiry: refused, and refused in a way that says "leased", not "empty".
    const early = await claim(b, "reaper-B", batchId, { leaseMs: 1000 });
    assert.equal(early.claimed_count, 0, "a live lease must not be stealable");
    assert.equal(early.outstanding, 1);
    assert.equal(early.leased_elsewhere, 1);

    // A "crashes": nothing renews the lease. Wait it out.
    await new Promise((r) => setTimeout(r, 1400));

    const late = await claim(b, "reaper-B", batchId, { leaseMs: 60000 });
    assert.equal(late.claimed_count, 1, "an expired lease must be reclaimable");
    assert.equal(late.tasks[0].lease_owner, "reaper-B");
    assert.equal(late.tasks[0].attempts, 2, "the reclaim is a second attempt, and is counted as one");
    // Nothing else is leased elsewhere now — B holds it.
    assert.equal(late.leased_elsewhere, 0);
  } finally {
    if (batchId) await cleanup(seeder, batchId);
    await Promise.all([a.end(), b.end(), seeder.end()]);
  }
});

test("A WORKER'S OWN LIVE LEASE IS NOT RE-HANDED ON THE NEXT POLL", opts, async () => {
  // jobLease treats `lease_owner = me` as free, because re-acquiring your own
  // lease on a resumed job is idempotent. On a queue that would hand a worker
  // the batch it is still probing. This is the divergence, asserted.
  const [a, seeder] = await connect(2);
  let batchId;
  try {
    batchId = await seed(seeder, 1);
    const first = await claim(a, "polling-A", batchId);
    assert.equal(first.claimed_count, 1);

    const second = await claim(a, "polling-A", batchId);
    assert.equal(second.claimed_count, 0, "the same worker must not be re-handed its live batch");
    assert.equal(second.outstanding, 1, "and the task is still outstanding — it is in flight, not gone");

    const { rows } = await seeder.query(
      `SELECT attempts FROM probe_tasks WHERE batch_id = $1::uuid`,
      [batchId]
    );
    assert.equal(rows[0].attempts, 1, "a second poll must not inflate the attempt count");
  } finally {
    if (batchId) await cleanup(seeder, batchId);
    await Promise.all([a.end(), seeder.end()]);
  }
});

test("EMPTY vs LEASED — an empty queue reports differently from a fully leased one", opts, async () => {
  const [a, b, seeder] = await connect(3);
  let batchId;
  try {
    batchId = await seed(seeder, 1);

    const leased = await claim(a, "owner-A", batchId);
    assert.equal(leased.claimed_count, 1);

    const contended = await claim(b, "owner-B", batchId);
    const emptyBatch = await claim(b, "owner-B", crypto.randomUUID());

    // Both claimed nothing. They must not say the same thing.
    assert.equal(contended.claimed_count, 0);
    assert.equal(emptyBatch.claimed_count, 0);
    assert.equal(contended.outstanding, 1);
    assert.equal(emptyBatch.outstanding, 0, "a batch with no tasks really is empty");
    assert.notEqual(
      contended.outstanding,
      emptyBatch.outstanding,
      "contention and emptiness must be distinguishable at the wire, not just in prose"
    );
  } finally {
    if (batchId) await cleanup(seeder, batchId);
    await Promise.all([a.end(), b.end(), seeder.end()]);
  }
});

test("REPORTING — only the lease holder may write an outcome; the rest are named, not dropped", opts, async () => {
  const [a, b, seeder] = await connect(3);
  let batchId;
  try {
    batchId = await seed(seeder, 2);
    const mine = await claim(a, "reporter-A", batchId, { limit: 2 });
    assert.equal(mine.claimed_count, 2);
    const [t1, t2] = mine.tasks;

    // B, who holds nothing, tries to report both.
    const stolen = await b.query(`SELECT complete_probe_tasks($1, $2::jsonb) AS r`, [
      "impostor-B",
      JSON.stringify([
        { id: t1.id, outcome: "answered" },
        { id: t2.id, outcome: "answered" },
      ]),
    ]);
    assert.equal(stolen.rows[0].r.applied, 0, "a non-holder must write nothing");
    assert.equal(stolen.rows[0].r.rejected.length, 2, "and its refused ids must be named");

    // A reports properly: one answered, one blocked.
    const ok = await a.query(`SELECT complete_probe_tasks($1, $2::jsonb) AS r`, [
      "reporter-A",
      JSON.stringify([
        { id: t1.id, outcome: "answered" },
        { id: t2.id, outcome: "blocked", detail: { note: "fixture" } },
      ]),
    ]);
    assert.equal(ok.rows[0].r.applied, 2);
    assert.deepEqual(ok.rows[0].r.rejected, []);

    const { rows } = await seeder.query(
      `SELECT id, status, outcome FROM probe_tasks WHERE batch_id = $1::uuid ORDER BY query`,
      [batchId]
    );
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
    assert.equal(byId[t1.id].status, "done");
    // D2: a blocked probe is NOT completed work. It must never be scorable as
    // a non-mention, and it must not close the task as done either.
    assert.equal(byId[t2.id].status, "failed");
    assert.equal(byId[t2.id].outcome, "blocked");
  } finally {
    if (batchId) await cleanup(seeder, batchId);
    await Promise.all([a.end(), b.end(), seeder.end()]);
  }
});

test("REFUSALS — the claim will not hand out an unownable lease", opts, async () => {
  const [c] = await connect(1);
  try {
    await assert.rejects(
      () => c.query(`SELECT claim_probe_tasks($1, NULL, 1, 180000, NULL) AS r`, [""]),
      /p_owner is required/
    );
    await assert.rejects(
      () => c.query(`SELECT claim_probe_tasks($1, NULL, 0, 180000, NULL) AS r`, ["someone"]),
      /p_limit must be >= 1/
    );
    // The closed outcome vocabulary is enforced by the table, not only by JS.
    await assert.rejects(
      () =>
        c.query(
          `INSERT INTO probe_tasks (batch_id, engine, query, outcome) VALUES (gen_random_uuid(), $1, 'x', 'mentioned')`,
          [TEST_ENGINE]
        ),
      /probe_tasks_outcome_chk/
    );
  } finally {
    await c.query(`DELETE FROM probe_tasks WHERE engine = $1`, [TEST_ENGINE]).catch(() => {});
    await c.end();
  }
});

test("GUARD — the write guard was live for this run, and refused nothing", opts, () => {
  assert.equal(WRITE_GUARD.covers.pg, true, "the pg driver was never patched, so nothing was guarded");
  assert.equal(WRITE_GUARD.covers.supabase, true, "the Supabase client prototype was never patched");
  assert.deepEqual(WRITE_GUARD.allowed, ["probe_tasks"]);
  WRITE_GUARD.assertClean();
  assert.ok(
    WRITE_GUARD.writes.some((w) => w.table === "probe_tasks"),
    "no probe_tasks write was seen at all, so the race cases proved nothing"
  );
});
