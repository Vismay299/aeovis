import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

import {
  CLAIM_REASONS,
  PROBE_LEASE_TTL_MS,
  PROBE_OUTCOMES,
  claimProbeTasks,
  completeProbeTasks,
  describeClaim,
  enqueueProbeTasks,
  normalizeClaim,
} from "./probeQueue.js";
import { LEASE_TTL_MS } from "./jobLease.js";
// R1.2.13 — the shared claim-lock guard. Imported from the plain module, NOT
// from src/server/probeClaimLock.test.mjs: importing a test file registers its
// tests inside this file's run, where node:test cancels them.
import { assertLockedSelection, SABOTAGED_CLAIM_SQL } from "./probeClaimLock.guard.mjs";

/**
 * R1.2.2 — the parts of the probe_tasks claim that can be proven WITHOUT a
 * database.
 *
 * WHAT THIS FILE DOES NOT PROVE, SAID PLAINLY: it does not prove the race. The
 * accept is "two workers racing for the same batch produce exactly one claim",
 * and that is a property of Postgres row locking. A fake client has no lock
 * manager, so it would agree with any implementation, including a broken one.
 * The race lives in `src/server/probeTasksRace.test.mjs`, runs against a real
 * database, and announces itself loudly when it is skipped.
 *
 * What IS proven here: the empty-vs-contended distinction that standing rule 1
 * turns on, the refusals, the preserved error envelope, the loop's behaviour on
 * each claim outcome, and that the copy of the claim shape inside worker/ has
 * not drifted from this one.
 *
 * These are BEHAVIOURAL. R1.2.1's stub guard asserted only that queue.js
 * contained the text `throw new Error`, which a `return new Array()` would have
 * satisfied while returning an empty batch. Everything below calls the function.
 */

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const WORKER_QUEUE = pathToFileURL(path.join(REPO, "worker/src/lib/queue.js")).href;
const WORKER_INDEX = pathToFileURL(path.join(REPO, "worker/src/index.js")).href;

const workerQueue = await import(WORKER_QUEUE);
const workerIndex = await import(WORKER_INDEX);

/** A claim report exactly as migration 010's `claim_probe_tasks` returns one. */
function report({ tasks = [], outstanding = 0, leased = 0, owner = "w1" } = {}) {
  return {
    owner,
    tasks,
    claimed_count: tasks.length,
    outstanding,
    leased_elsewhere: leased,
    lease_expires_at: "2026-09-03T07:00:00.000Z",
    observed_at: "2026-09-03T06:57:00.000Z",
  };
}

/** A minimal Supabase-shaped double. Records every call; never touches a network. */
function fakeClient({ rpc = {}, insert = {} } = {}) {
  const calls = [];
  return {
    calls,
    async rpc(name, args) {
      calls.push({ kind: "rpc", name, args });
      const handler = rpc[name];
      if (!handler) throw new Error(`fakeClient: no stub for rpc ${name}`);
      return handler(args);
    },
    from(table) {
      return {
        insert(rows) {
          calls.push({ kind: "insert", table, rows });
          return {
            select: async () => (insert.result ? insert.result(rows) : { data: rows, error: null }),
          };
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// The distinction standing rule 1 exists for
// ---------------------------------------------------------------------------

test("normalizeClaim — an empty queue and a fully leased one are different results", () => {
  const empty = normalizeClaim(report({ outstanding: 0 }));
  const contended = normalizeClaim(report({ outstanding: 4, leased: 4 }));

  assert.equal(empty.reason, CLAIM_REASONS.QUEUE_EMPTY);
  assert.equal(contended.reason, CLAIM_REASONS.ALL_LEASED);
  assert.notEqual(empty.reason, contended.reason);

  // Both claimed nothing. If the only observable were the task list they would
  // be identical, which is the false success this shape exists to prevent.
  assert.deepEqual(empty.tasks, []);
  assert.deepEqual(contended.tasks, []);
});

test("describeClaim — the two zeros do not print the same sentence", () => {
  const empty = describeClaim(normalizeClaim(report({ outstanding: 0 })));
  const contended = describeClaim(normalizeClaim(report({ outstanding: 4, leased: 4 })));

  assert.notEqual(empty, contended);
  assert.match(empty, /queue is empty/);
  assert.match(contended, /NOT empty/);
  assert.match(contended, /contention, not idleness/);
  // The contended line must carry the number, or an operator cannot act on it.
  assert.match(contended, /4 outstanding/);
});

test("normalizeClaim — a successful claim is `claimed`, whatever the outstanding count", () => {
  const c = normalizeClaim(report({ tasks: [{ id: "a" }, { id: "b" }], outstanding: 9, leased: 3 }));
  assert.equal(c.reason, CLAIM_REASONS.CLAIMED);
  assert.equal(c.claimedCount, 2);
  assert.equal(c.outstanding, 9);
  assert.match(describeClaim(c), /claimed 2 task\(s\); 9 outstanding/);
});

test("normalizeClaim — a report with no `outstanding` count refuses, it does not read as zero", () => {
  // Standing rule 5: never `?? 0` on a metric. An absent count is unknown, and
  // guessing zero would turn every contended poll into "the queue is empty".
  const broken = report({ outstanding: 0 });
  delete broken.outstanding;
  assert.throws(() => normalizeClaim(broken), /indistinguishable|Refusing to guess/);
  assert.throws(() => normalizeClaim(null), /returned nothing/);
});

// ---------------------------------------------------------------------------
// claimBatch, called — not read
// ---------------------------------------------------------------------------

test("worker claimBatch — with no client it THROWS; it does not return an empty batch", async () => {
  // The R1.2.1 guard checked source text for /throw new Error/ and the absence
  // of the literal "return [];", which `return new Array()` would have passed
  // while silently returning nothing. So: invoke it.
  const config = { workerId: "w1", engines: ["perplexity"], batchSize: 5, leaseMs: 180000 };
  workerQueue.resetQueueClient();
  await assert.rejects(
    () => workerQueue.claimBatch(config, { client: null }),
    /unreachable queue and an empty one/
  );

  // And prove the negative directly: whatever it did, it did not hand back [].
  let returned = "did not return";
  try {
    returned = await workerQueue.claimBatch(config, { client: null });
  } catch {
    /* expected */
  }
  assert.equal(returned, "did not return", "claimBatch must not resolve without a queue");
});

test("worker claimBatch — calls claim_probe_tasks with this worker's identity and limits", async () => {
  const client = fakeClient({
    rpc: { claim_probe_tasks: () => ({ data: report({ tasks: [{ id: "t1" }], outstanding: 3 }), error: null }) },
  });
  const config = { workerId: "fleet-7", engines: ["perplexity", "chatgpt"], batchSize: 4, leaseMs: 120000 };

  const claim = await workerQueue.claimBatch(config, { client });

  assert.equal(client.calls[0].name, "claim_probe_tasks");
  assert.deepEqual(client.calls[0].args, {
    p_owner: "fleet-7",
    p_engines: ["perplexity", "chatgpt"],
    p_limit: 4,
    p_lease_ms: 120000,
    p_batch_id: null,
  });
  assert.equal(claim.reason, CLAIM_REASONS.CLAIMED);
  assert.equal(claim.tasks.length, 1);
});

test("worker claimBatch — an anonymous worker is refused before it can take an unownable lease", async () => {
  const client = fakeClient({ rpc: { claim_probe_tasks: () => ({ data: report(), error: null }) } });
  await assert.rejects(
    () => workerQueue.claimBatch({ workerId: "", engines: [], batchSize: 1, leaseMs: 180000 }, { client }),
    /workerId is required/
  );
  assert.equal(client.calls.length, 0, "it must not even attempt the claim");
});

test("worker claimBatch — a database error keeps its envelope (standing rule 2)", async () => {
  const client = fakeClient({
    rpc: {
      claim_probe_tasks: () => ({
        data: null,
        error: { message: "permission denied for table probe_tasks", code: "42501", details: "d", hint: "h" },
      }),
    },
  });
  await assert.rejects(
    () => workerQueue.claimBatch({ workerId: "w", engines: [], batchSize: 1, leaseMs: 180000 }, { client }),
    (err) => {
      assert.equal(err.code, "42501");
      assert.equal(err.details, "d");
      assert.equal(err.hint, "h");
      assert.ok(err.cause, "the original error must survive as cause");
      assert.match(err.message, /permission denied/);
      return true;
    }
  );
});

test("worker reportBatch — an unknown `applied` count refuses rather than reporting zero written", async () => {
  const config = { workerId: "w", leaseMs: 180000 };
  const client = fakeClient({ rpc: { complete_probe_tasks: () => ({ data: {}, error: null }) } });
  await assert.rejects(
    () => workerQueue.reportBatch([{ id: "t1", outcome: "answered" }], config, { client }),
    /no `applied` count/
  );
});

test("worker reportBatch — refused ids are surfaced, not swallowed", async () => {
  const config = { workerId: "w", leaseMs: 180000 };
  const client = fakeClient({
    rpc: { complete_probe_tasks: () => ({ data: { asked: 3, applied: 1, rejected: ["t2", "t3"] }, error: null }) },
  });
  const res = await workerQueue.reportBatch(
    [
      { id: "t1", outcome: "answered" },
      { id: "t2", outcome: "blocked" },
      { id: "t3", outcome: "timeout" },
    ],
    config,
    { client }
  );
  assert.equal(res.applied, 1);
  assert.deepEqual(res.rejected, ["t2", "t3"]);
  assert.equal(client.calls[0].args.p_results.length, 3);
});

// ---------------------------------------------------------------------------
// The loop
// ---------------------------------------------------------------------------

/**
 * R1.2.3 gave one-shot `runOnce` a second obligation: the pass writes exactly
 * one scan_runs row. The long-lived `start` loop now shares one idle-stretch
 * row across polls (R1.2.23). The real ledger calls need a database, so these loop tests
 * stub them — the LEDGER's own behaviour is proven in src/server/scanRuns.test.mjs
 * (hermetically) and src/server/scanRunsLive.test.mjs (against Postgres). What is
 * asserted here is still what it always was: what the LOOP does.
 */
function ledgerStubs(sink = []) {
  let n = 0;
  return {
    sink,
    openRun: async (fields) => {
      const id = `run-${++n}`;
      sink.push({ kind: "open", id, ...fields });
      return {
        id,
        runner: "probe-fleet",
        phase: fields.phase,
        open: true,
        startedAt: "2026-09-03T06:00:00.000Z",
        heartbeatAt: "2026-09-03T06:00:00.000Z",
      };
    },
    heartbeatRun: async (runId) => {
      sink.push({ kind: "beat", id: runId });
      return { runId, heartbeatAt: "2026-09-03T06:00:30.000Z" };
    },
    closeRun: async (runId, fields) => {
      sink.push({ kind: "close", id: runId, ...fields });
      return {
        id: runId,
        runner: "probe-fleet",
        phase: "probe_batch",
        outcome: fields.outcome,
        reason: fields.reason ?? null,
        probesAttempted: fields.probesAttempted ?? null,
        probesSucceeded: fields.probesSucceeded ?? null,
        errorsRecovered: fields.errorsRecovered ?? null,
        open: false,
      };
    },
  };
}

test("runOnce — an empty queue and a starved fleet return the same 0 but log different lines", async () => {
  const lines = [];
  const origLog = console.log;
  console.log = (m) => lines.push(m);
  try {
    const config = { workerId: "w", engines: [], batchSize: 1, leaseMs: 180000, idlePollMs: 1 };
    const emptyN = await workerIndex.runOnce(config, {
      claimBatch: async () => workerQueue.normalizeClaim(report({ outstanding: 0 })),
      ...ledgerStubs(),
    });
    const starvedN = await workerIndex.runOnce(config, {
      claimBatch: async () => workerQueue.normalizeClaim(report({ outstanding: 12, leased: 12 })),
      ...ledgerStubs(),
    });
    assert.equal(emptyN, 0);
    assert.equal(starvedN, 0);
  } finally {
    console.log = origLog;
  }

  // Only the CLAIM lines: since R1.2.3 each pass also logs its ledger row.
  const claimLines = lines.filter((l) => /claimed \d/.test(l));
  assert.equal(claimLines.length, 2, "every pass must say what it saw, including the empty ones");
  assert.notEqual(claimLines[0], claimLines[1]);
  assert.match(claimLines[0], /queue is empty/);
  assert.match(claimLines[1], /NOT empty/);
});

test("runOnce — a failed probe hands the lease back instead of parking the batch for its TTL", async () => {
  const released = [];
  const config = { workerId: "w", engines: [], batchSize: 2, leaseMs: 180000 };
  const origLog = console.log;
  console.log = () => {};
  try {
    await assert.rejects(
      () =>
        workerIndex.runOnce(config, {
          claimBatch: async () =>
            workerQueue.normalizeClaim(report({ tasks: [{ id: "t1" }, { id: "t2" }], outstanding: 2 })),
          probeBatch: async () => {
            throw new Error("no adapter is built yet (R1.3)");
          },
          releaseBatch: async (ids) => {
            released.push(...ids);
            return ids.length;
          },
          ...ledgerStubs(),
        }),
      /no adapter is built yet/
    );
  } finally {
    console.log = origLog;
  }
  assert.deepEqual(released, ["t1", "t2"], "a batch we cannot finish must go back to the queue");
});

test("runOnce — a short write is announced, not counted as a clean pass", async () => {
  const lines = [];
  const origLog = console.log;
  console.log = (m) => lines.push(m);
  try {
    await workerIndex.runOnce(
      { workerId: "w", engines: [], batchSize: 1, leaseMs: 180000 },
      {
        claimBatch: async () => workerQueue.normalizeClaim(report({ tasks: [{ id: "t1" }], outstanding: 1 })),
        probeBatch: async (batch) => batch.map((t) => ({ id: t.id, outcome: "answered" })),
        reportBatch: async () => ({ asked: 1, applied: 0, rejected: ["t1"] }),
        ...ledgerStubs(),
      }
    );
  } finally {
    console.log = origLog;
  }
  assert.ok(
    lines.some((l) => /WARNING/.test(l) && /no longer held their lease/.test(l)),
    `a refused write must be visible in the log:\n${lines.join("\n")}`
  );
});

// ---------------------------------------------------------------------------
// The producer
// ---------------------------------------------------------------------------

test("enqueueProbeTasks — a failed insert throws with its envelope; it never returns { error }", async () => {
  const client = fakeClient({
    insert: { result: () => ({ data: null, error: { message: "boom", code: "23514", details: "chk" } }) },
  });
  await assert.rejects(
    () =>
      enqueueProbeTasks({ batchId: "b1", engine: "perplexity", queries: ["q"] }, { client }),
    (err) => {
      assert.equal(err.code, "23514");
      assert.ok(err.cause);
      return true;
    }
  );
});

test("enqueueProbeTasks — a partial insert is a failure, not a smaller success", async () => {
  const client = fakeClient({ insert: { result: (rows) => ({ data: rows.slice(0, 1), error: null }) } });
  await assert.rejects(
    () => enqueueProbeTasks({ batchId: "b1", engine: "perplexity", queries: ["a", "b", "c"] }, { client }),
    /asked for 3 task\(s\), the insert returned 1/
  );
});

test("enqueueProbeTasks — enqueuing nothing refuses; an empty queue would read as finished work", async () => {
  const client = fakeClient();
  await assert.rejects(
    () => enqueueProbeTasks({ batchId: "b1", engine: "perplexity", queries: [] }, { client }),
    /no queries to enqueue/
  );
});

test("completeProbeTasks — an outcome outside the closed vocabulary is refused", async () => {
  const client = fakeClient({ rpc: { complete_probe_tasks: () => ({ data: { asked: 1, applied: 1, rejected: [] }, error: null }) } });
  await assert.rejects(
    () => completeProbeTasks({ owner: "w", results: [{ id: "t1", outcome: "not_mentioned" }] }, { client }),
    /is not a probe outcome/
  );
  assert.equal(client.calls.length, 0);
});

test("claimProbeTasks — no client is a refusal, not an empty batch", async () => {
  await assert.rejects(
    () => claimProbeTasks({ owner: "app-1" }, { client: null }),
    /unreachable queue and an empty one/
  );
});

// ---------------------------------------------------------------------------
// The copy inside worker/ must not drift
// ---------------------------------------------------------------------------

test("GUARD — the fleet's copy of the claim shape agrees with the app's", () => {
  // worker/ may not import src/, so `normalizeClaim`, `describeClaim` and
  // CLAIM_REASONS exist twice on purpose. Duplication that is checked is a
  // decision; duplication that is trusted is a bug waiting for a deploy.
  assert.deepEqual(workerQueue.CLAIM_REASONS, CLAIM_REASONS);

  const cases = [
    report({ outstanding: 0 }),
    report({ outstanding: 7, leased: 7 }),
    report({ tasks: [{ id: "a" }], outstanding: 3, leased: 2 }),
  ];
  for (const raw of cases) {
    assert.deepEqual(workerQueue.normalizeClaim(raw), normalizeClaim(raw));
    assert.equal(workerQueue.describeClaim(workerQueue.normalizeClaim(raw)), describeClaim(normalizeClaim(raw)));
  }
});

test("GUARD — the fleet's outcome vocabulary, the app's, and the table's CHECK are one list", async () => {
  const { PROBE_OUTCOMES: workerOutcomes } = await import(
    pathToFileURL(path.join(REPO, "worker/src/lib/probe.js")).href
  );
  assert.deepEqual([...PROBE_OUTCOMES], [...workerOutcomes]);

  const sql = await readFile(path.join(REPO, "supabase/migrations/010_probe_tasks.sql"), "utf8");
  const check = sql.match(/probe_tasks_outcome_chk[\s\S]*?\)\s*\)\s*\n/);
  assert.ok(check, "010 must constrain the outcome column");
  for (const outcome of PROBE_OUTCOMES) {
    assert.ok(
      check[0].includes(`'${outcome}'`),
      `the table CHECK must accept ${outcome}; a vocabulary the database does not know is not closed`
    );
  }
  // And nothing beyond the vocabulary. 'not_mentioned' is the one that matters:
  // decision D2 is that a blocked probe must never become a non-mention.
  const inCheck = [...check[0].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
  assert.deepEqual(inCheck.sort(), [...PROBE_OUTCOMES].sort());
});

// ---------------------------------------------------------------------------
// The migration
// ---------------------------------------------------------------------------

test("GUARD — the claim is settled by the database, not by JS being careful", async () => {
  const sql = await readFile(path.join(REPO, "supabase/migrations/010_probe_tasks.sql"), "utf8");

  // R1.2.13 — this assertion used to be `assert.match(sql, /FOR UPDATE SKIP LOCKED/)`
  // against the WHOLE file, and it could not fail for the reason it existed.
  // Migration 010 names the clause in prose twice (its header, and the comment
  // above claim_probe_tasks), so the COMMENTS ALONE satisfied that regex:
  // deleting the executable clause from the candidate CTE left this file 25/25
  // green. Documentation certifying itself.
  //
  // It is not deleted, because a reader auditing the queue lands HERE, and an
  // absence invites the next person to re-add the same whole-file regex. It
  // delegates instead to the single implementation in probeClaimLock.test.mjs,
  // which strips SQL comments (string-literal aware) before matching, scopes the
  // match to the candidate CTE of claim_probe_tasks, and reports a bare blocking
  // `FOR UPDATE` as its own distinct failure. One implementation, so the two
  // green checks cannot disagree.
  //
  // WHAT THIS PROVES: that the migration's executable SQL says
  // `FOR UPDATE SKIP LOCKED` on the row-choosing SELECT.
  // WHAT IT DOES NOT PROVE: that Postgres locks anything. This is a static
  // assertion on SQL TEXT — there is no database in this environment, and a JS
  // simulation of a lock manager would agree with a broken migration. The
  // behavioural proof is `src/server/probeTasksRace.test.mjs`, which needs a real
  // database and skips LOUDLY and countably when it has none. That skip is an
  // admission, never a pass — see the guard at the foot of this file.
  //
  // Proved not to be a no-op FIRST: if `assertLockedSelection` were ever stubbed
  // out, delegating to it would be a second toothless guard wearing the first
  // one's clothes. The fixture keeps both prose mentions and has lost only the
  // executable clause, which is precisely the state that used to pass here.
  assert.throws(
    () => assertLockedSelection(SABOTAGED_CLAIM_SQL, "fixture"),
    /does not take a row lock/,
    "the delegated guard must reject a claim function that only TALKS about SKIP LOCKED"
  );
  assert.match(
    SABOTAGED_CLAIM_SQL,
    /FOR UPDATE SKIP LOCKED/,
    "and the fixture must still satisfy the OLD whole-file regex, or it is not reproducing the finding"
  );

  assertLockedSelection(sql, "supabase/migrations/010_probe_tasks.sql");

  assert.match(sql, /CREATE TABLE IF NOT EXISTS probe_tasks/);
  assert.match(sql, /lease_owner/);
  assert.match(sql, /lease_expires_at/);

  // Purely additive. Nothing in this migration may alter or drop a pre-existing
  // object; the live database it runs against holds real customer scans.
  assert.ok(!/\bDROP\s+(TABLE|COLUMN|INDEX|FUNCTION)\b/i.test(sql), "010 must not drop anything");
  const alters = [...sql.matchAll(/^\s*ALTER TABLE\s+(\w+)/gim)].map((m) => m[1]);
  assert.deepEqual([...new Set(alters)], ["probe_tasks"], "010 may only alter the table it creates");
});

test("GUARD — a lapsed lease is reclaimable: the claim is not restricted to `pending`", async () => {
  // Regression. The first draft selected candidates with `status = 'pending'`,
  // so a row whose worker died stayed at 'claimed' forever and LEASE_TTL_MS
  // meant nothing. The live expiry test caught it; this keeps it caught.
  const sql = await readFile(path.join(REPO, "supabase/migrations/010_probe_tasks.sql"), "utf8");
  const fn = sql.slice(sql.indexOf("CREATE OR REPLACE FUNCTION claim_probe_tasks"));
  const candidate = fn.slice(fn.indexOf("WITH candidate AS"), fn.indexOf("claimed AS"));
  assert.match(candidate, /status IN \('pending', 'claimed'\)/);
  assert.ok(
    !/t\.status = 'pending'/.test(candidate),
    "a pending-only claim can never reclaim an expired lease"
  );
});

test("GUARD — the queue's TTL is jobLease's TTL, in JS and in SQL", async () => {
  assert.equal(PROBE_LEASE_TTL_MS, LEASE_TTL_MS);
  const sql = await readFile(path.join(REPO, "supabase/migrations/010_probe_tasks.sql"), "utf8");
  assert.ok(
    sql.includes(`p_lease_ms  integer DEFAULT ${LEASE_TTL_MS}`),
    `010's default lease must be ${LEASE_TTL_MS}ms so "this worker is dead" means the same thing on both sides`
  );
});

test("GUARD — 010 is in the migration runner's verify list, functions checked via pg_proc", async () => {
  const runner = await readFile(path.join(REPO, "scripts/setup-supabase.mjs"), "utf8");
  assert.match(runner, /"010_probe_tasks\.sql":/, "an unverified migration lets an incomplete DB report success");
  assert.match(runner, /kind: "function", name: "claim_probe_tasks"/, "the table can exist while the function does not");
});

// ---------------------------------------------------------------------------
// The gate on the live test must be loud
// ---------------------------------------------------------------------------

test("GUARD — the live race test announces itself when it does NOT run", async () => {
  const src = await readFile(path.join(REPO, "src/server/probeTasksRace.test.mjs"), "utf8");
  assert.match(src, /NOT RUN/, "a skipped race must say so; a skip is not a success");
  assert.match(src, /console\.error/, "and it must say so on stderr, where a green run cannot hide it");
  assert.match(src, /skip: GATE\.reason/, "each case must carry the reason it was skipped");

  // The gate itself, exercised — not merely matched in the test file's source.
  // (Imported from src/server/liveDbGate.js rather than from the test file, so
  // this guard does not re-register the nine gated cases as its own subtests.)
  const { liveDbGate, notRunBanner } = await import("./liveDbGate.js");
  assert.equal(liveDbGate({}).enabled, false);
  assert.match(liveDbGate({}).reason, /no live Postgres configured/);
  assert.equal(liveDbGate({ DATABASE_URL: "postgres://x" }).enabled, true);
  assert.equal(
    liveDbGate({ SUPABASE_DB_PASSWORD: "p", NEXT_PUBLIC_SUPABASE_URL: "https://x.supabase.co" }).enabled,
    true
  );
  assert.match(notRunBanner("T", "because", "so X is unproven"), /T: NOT RUN[\s\S]*because[\s\S]*unproven/);
});
