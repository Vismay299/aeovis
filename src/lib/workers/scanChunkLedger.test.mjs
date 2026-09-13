import test from "node:test";
import assert from "node:assert/strict";

/**
 * R3.2.4 — the two "no ledger client" cases below MAKE that condition instead
 * of hoping for it.
 *
 * `resolveChunkLedger` disables the ledger when no ledger dep is injected AND
 * db.js has no client. There is no "client: off" dep to pass, so both cases
 * used to state their dependency on an unset NEXT_PUBLIC_SUPABASE_* in a
 * comment and trust the shell. With credentials loaded — which
 * src/lib/liveDbGate.js tells live-test authors to do — the ledger was ENABLED
 * and those two cases opened REAL `scan_runs` rows on production instead of
 * exercising the disabled branch at all.
 *
 * Clearing the credentials before the module graph is evaluated makes db.js's
 * client null however this suite is invoked. The imports must be dynamic:
 * static ones are hoisted above these two `delete`s, and scanWorker.js's
 * import of db.js would capture the credentials first.
 */
delete process.env.NEXT_PUBLIC_SUPABASE_URL;
delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

const {
  runScanChunk,
  runSourcingPhase,
  runProbingPhase,
  chunkRunOutcome,
  createChunkTally,
  resolveEntryPhase,
  CHUNK_PHASES,
  CHUNK_RUN_HEARTBEAT_MS,
  CHUNK_TIME_BUDGET_MS,
} = await import("./scanWorker.js");
const { RUN_OUTCOMES, RUNNERS } = await import("../scanRuns.js");
const { supabase } = await import("../db.js");

/**
 * Asserts the mechanism above worked, not the environment. If this ever fires,
 * the case that calls it would have written a real scan_runs row — so it fires
 * BEFORE the call, and nothing reaches the database.
 */
function requireNoDbClient(what) {
  assert.equal(
    supabase,
    null,
    `${what} is about the path taken when db.js has NO Supabase client, and db.js HAS one: the ` +
      `credential clearing at the top of this file did not take effect. With a client, ` +
      `resolveChunkLedger enables the ledger and this case would write a real scan_runs row.`
  );
}

/**
 * R3.2.1 — one scan_runs row per CHUNK EXECUTION, from the web worker's side.
 *
 * The accept criterion is "every chunk execution writes exactly one row
 * carrying phase, timings, outcome, reason, probes and errors recovered", and
 * the whole point of the row is that it distinguishes cases that used to be
 * indistinguishable. So the assertions here are mostly about DIFFERENCE:
 *   * a chunk that measured zero probes vs a chunk that never probed —
 *     0 vs null, never both 0;
 *   * a chunk that declined ('skipped') vs one that ran and found nothing
 *     ('noop');
 *   * a chunk that died vs one that finished — an OPEN row vs a closed one.
 *
 * WHAT THIS FILE CANNOT PROVE. It has no Postgres, so it cannot show that
 * migration 011's CHECK constraints refuse the dishonest rows, nor that the
 * three RPCs exist in production. `makeLedger` below re-implements those
 * constraints so a violation still fails here, but a re-implementation agreeing
 * with itself is not evidence about the database:
 * `src/lib/workers/scanChunkLedgerLive.test.mjs` is the half that opens a real
 * connection, and it is gated and loud when it does not run.
 */

// ---------------------------------------------------------------------------
// A fake ledger that enforces migration 011's invariants
// ---------------------------------------------------------------------------

/**
 * Mirrors open_scan_run / heartbeat_scan_run / close_scan_run, including the
 * refusals: a closed run cannot be heartbeated, a run cannot be closed twice, a
 * non-'succeeded' outcome must carry a reason, counters are integers or NULL,
 * succeeded never exceeds attempted, and a row must name SOMETHING.
 *
 * The refusals matter more than the happy path here — a fake that accepted a
 * second close would let a double-close bug pass this file and fail in prod.
 */
function makeLedger({ failClose = false } = {}) {
  const rows = [];
  let n = 0;

  return {
    rows,
    deps: {
      openScanRun: async (fields) => {
        assert.ok(fields.runner && fields.runner.trim(), "open: runner is required");
        assert.ok(fields.phase && fields.phase.trim(), "open: phase is required");
        assert.ok(
          fields.scanJobId || fields.batchId || fields.brand || fields.workerId,
          "open: scan_runs_subject_chk — a row must name a job, batch, brand or worker"
        );
        const row = {
          id: `run-${n++}`,
          runner: fields.runner,
          phase: fields.phase,
          worker_id: fields.workerId ?? null,
          scan_job_id: fields.scanJobId ?? null,
          brand: fields.brand ?? null,
          detail: fields.detail ?? null,
          outcome: null,
          reason: null,
          probes_attempted: null,
          probes_succeeded: null,
          errors_recovered: null,
          error: null,
          started_at: new Date().toISOString(),
          heartbeat_at: new Date().toISOString(),
          ended_at: null,
          beats: 0,
        };
        rows.push(row);
        return {
          id: row.id,
          runner: row.runner,
          phase: row.phase,
          workerId: row.worker_id,
          scanJobId: row.scan_job_id,
          batchId: null,
          brand: row.brand,
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

      heartbeatScanRun: async ({ runId }) => {
        const row = rows.find((r) => r.id === runId);
        if (!row) throw new Error(`heartbeat_scan_run: no run ${runId} exists`);
        if (row.ended_at) throw new Error(`heartbeat_scan_run: run ${runId} is already closed`);
        row.beats++;
        row.heartbeat_at = new Date().toISOString();
        return { runId, heartbeatAt: row.heartbeat_at };
      },

      closeScanRun: async (fields) => {
        if (failClose) throw new Error("close_scan_run: simulated ledger write failure");
        const row = rows.find((r) => r.id === fields.runId);
        if (!row) throw new Error(`close_scan_run: no run ${fields.runId} exists`);
        if (row.ended_at) {
          throw new Error(
            `close_scan_run: run ${row.id} was already closed as "${row.outcome}"; refusing to overwrite`
          );
        }
        assert.ok(
          ["succeeded", "failed", "skipped", "reaped", "noop"].includes(fields.outcome),
          `close: "${fields.outcome}" is outside scan_runs_outcome_chk`
        );
        if (fields.outcome !== "succeeded") {
          assert.ok(
            String(fields.reason ?? "").trim(),
            `close: outcome "${fields.outcome}" requires a reason (scan_runs_reason_chk)`
          );
        }
        for (const k of ["probesAttempted", "probesSucceeded", "errorsRecovered"]) {
          const v = fields[k] ?? null;
          assert.ok(
            v === null || (Number.isInteger(v) && v >= 0),
            `close: ${k} must be a non-negative integer or null, got ${JSON.stringify(v)}`
          );
        }
        if (fields.probesAttempted != null && fields.probesSucceeded != null) {
          assert.ok(
            fields.probesSucceeded <= fields.probesAttempted,
            "close: probes_succeeded may never exceed probes_attempted (scan_runs_counts_chk)"
          );
        }
        row.outcome = fields.outcome;
        row.reason = fields.reason ?? null;
        row.probes_attempted = fields.probesAttempted ?? null;
        row.probes_succeeded = fields.probesSucceeded ?? null;
        row.errors_recovered = fields.errorsRecovered ?? null;
        row.error = fields.error ?? null;
        row.detail = { ...(row.detail || {}), ...(fields.detail || {}) };
        row.ended_at = new Date().toISOString();
        row.heartbeat_at = row.ended_at;
        return {
          id: row.id,
          runner: row.runner,
          phase: row.phase,
          workerId: row.worker_id,
          scanJobId: row.scan_job_id,
          batchId: null,
          brand: row.brand,
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
    },
  };
}

// ---------------------------------------------------------------------------
// A minimal job/analytics backend — only what these paths touch
// ---------------------------------------------------------------------------

function makeBackend() {
  const jobs = new Map();
  const promptResults = [];
  const scans = [];
  const calls = { selfContinue: [], insertScan: [] };
  let n = 0;

  const deps = {
    // R3.2.4 — `client: null` is scanWorker.js's test-only injection
    // (resolveAttemptClient) and it is what makes this backend hermetic. Without
    // it, `claimJobAttempt` falls through to db.js's shared client and calls the
    // REAL `claim_scan_job_attempt()` RPC, which writes `scan_jobs.attempts` on
    // whatever database the shell is pointed at: 24 such calls in this file
    // reached production the moment `--env-file=.env.local` was used, which is
    // exactly what src/lib/liveDbGate.js tells live-test authors to do. Passing
    // null is a declaration, not a coincidence: this file exercises the
    // in-memory attempt policy on purpose.
    client: null,
    getScanJob: async (id) => jobs.get(id) || null,
    updateScanJob: async (id, updates) => {
      const job = jobs.get(id) || { id };
      Object.assign(job, updates, { heartbeat_at: new Date().toISOString() });
      jobs.set(id, job);
      return job;
    },
    claimJobStatus: async (id, fromStatus, toStatus) => {
      const list = Array.isArray(fromStatus) ? fromStatus : [fromStatus];
      const job = jobs.get(id);
      if (!job) return null;
      if (!list.includes(job.status)) return null;
      job.status = toStatus;
      return job;
    },
    getCompletedPairsForJob: async (id) => {
      const set = new Set();
      promptResults.filter((r) => r.job_id === id).forEach((r) => set.add(`${r.engine}|${r.query}`));
      return set;
    },
    upsertPromptResults: async (rows) => {
      rows.forEach((row) => promptResults.push({ id: `pr-${n++}`, scan_id: null, created_at: new Date().toISOString(), ...row }));
      return rows;
    },
    getPromptResultsForJob: async (id) => promptResults.filter((r) => r.job_id === id),
    stampScanIdForJob: async (id, scanId) => {
      promptResults.forEach((r) => {
        if (r.job_id === id && r.scan_id == null) r.scan_id = scanId;
      });
      return { promptResults: 1, citations: 0 };
    },
    insertScan: async (record) => {
      calls.insertScan.push(record);
      const id = `scan-${n++}`;
      scans.push({ id, ...record });
      return [{ id }];
    },
    getScansByDomain: async () => [],
    getResultBrandsForScan: async () => [],
    deleteCitationsForJob: async () => 0,
    insertCitations: async (rows) => rows,
    enrichCitations: async (rows) => rows,
    deleteResultBrandsForJob: async () => 0,
    insertResultBrands: async (rows) => rows,
    upsertBrandMetricsDaily: async (rows) => rows,
    extractCompetitors: async () => [],
    selfContinue: (id) => calls.selfContinue.push(id),
    // Nothing here may hold a real timer: an unref'd interval is still an
    // interval, and the suite must not depend on wall clock.
    setIntervalFn: () => null,
    clearIntervalFn: () => {},
  };

  const seed = (job) => {
    const row = {
      id: job.id,
      brand: "Acme",
      url: "acme.com",
      industry: "saas",
      competitors: "",
      status: "pending",
      progress_pct: 0,
      checkpoint: null,
      ...job,
    };
    jobs.set(row.id, row);
    return row;
  };

  return { jobs, promptResults, scans, calls, deps, seed };
}

function makeQueries(count) {
  return Array.from({ length: count }, (_, i) => ({
    text: `unbranded query number ${i}`,
    source: "llm_generated",
    topic: "General",
    intent_tier: "informational",
  }));
}

function makeCheckpoint(queries, engines = ["aio"]) {
  return {
    brand: "Acme",
    url: "acme.com",
    industry: "saas",
    competitors: [],
    competitors_raw: "",
    prompt_key: "acme.com",
    prompt_source: "tracked_pool",
    static_pack_prompts: 0,
    queries,
    unbranded_texts: queries.map((q) => q.text),
    engines,
    stats: { cost: 0, tokens: 0 },
    sourced_at: new Date().toISOString(),
  };
}

function probeResult(engine, query, { error = null } = {}) {
  return {
    engine,
    prompt: query.text,
    is_branded_query: false,
    topic: "General",
    source: "test",
    intent_tier: "informational",
    answer_present: !error,
    aio_present: !error,
    text: error ? "" : `An answer about ${query.text}`,
    citations: [],
    references: [],
    brand_mentioned_in_text: false,
    brand_cited: false,
    visible: false,
    competitors_found_in_text: [],
    competitors_cited: [],
    brands: [],
    error,
    cost: 0,
  };
}

/** The one row this chunk wrote, asserted to be exactly one. */
function soleRow(ledger) {
  assert.equal(ledger.rows.length, 1, `exactly one scan_runs row per chunk, got ${ledger.rows.length}`);
  return ledger.rows[0];
}

// ---------------------------------------------------------------------------
// chunkRunOutcome — the pure mapping, every branch
// ---------------------------------------------------------------------------

test("chunkRunOutcome — a fresh tally reports every counter as NOT MEASURED, never 0", () => {
  const tally = createChunkTally();
  assert.equal(tally.probesAttempted, null);
  assert.equal(tally.probesSucceeded, null);
  assert.equal(tally.errorsRecovered, null);

  const closed = chunkRunOutcome({ ok: true, reason: "complete" }, tally);
  assert.equal(closed.probesAttempted, null, "a chunk that never probed must not claim it probed none");
  assert.equal(closed.probesSucceeded, null);
  assert.equal(closed.errorsRecovered, null);
});

test("chunkRunOutcome — a MEASURED zero survives the mapping as 0, not as null", () => {
  const closed = chunkRunOutcome(
    { ok: true, reason: "complete" },
    { probesAttempted: 0, probesSucceeded: 0, errorsRecovered: 0, phases: ["probing"] }
  );
  assert.equal(closed.probesAttempted, 0);
  assert.equal(closed.probesSucceeded, 0);
  assert.equal(closed.errorsRecovered, 0);
  assert.deepEqual(closed.detail.phases_run, ["probing"]);
});

test("chunkRunOutcome — every reason runScanChunk returns maps to an outcome + reason", () => {
  const cases = [
    [{ reason: "complete" }, RUN_OUTCOMES.SUCCEEDED, "complete"],
    [{ reason: "checkpointed", progress_pct: 40 }, RUN_OUTCOMES.SUCCEEDED, "checkpointed"],
    [{ reason: "sourcing_claimed_elsewhere" }, RUN_OUTCOMES.SKIPPED, "sourcing_claimed_elsewhere"],
    [{ reason: "finalize_claimed_elsewhere" }, RUN_OUTCOMES.SKIPPED, "finalize_claimed_elsewhere"],
    [{ reason: "not_found" }, RUN_OUTCOMES.SKIPPED, "not_found"],
    [{ reason: "already_finished", status: "complete" }, RUN_OUTCOMES.NOOP, "already_finished"],
    [{ reason: "noop", status: "generating_prompts" }, RUN_OUTCOMES.NOOP, "noop_status_generating_prompts"],
    [{ reason: "read_failed", error: "connection refused" }, RUN_OUTCOMES.FAILED, "read_failed"],
    [{ reason: "error", error: "boom" }, RUN_OUTCOMES.FAILED, "chunk_failed"],
  ];
  for (const [result, outcome, reason] of cases) {
    const closed = chunkRunOutcome(result, createChunkTally());
    assert.equal(closed.outcome, outcome, `${result.reason} -> outcome`);
    assert.equal(closed.reason, reason, `${result.reason} -> reason`);
  }
});

test("chunkRunOutcome — 'skipped' and 'noop' never collapse into one another", () => {
  const declined = chunkRunOutcome({ reason: "sourcing_claimed_elsewhere" }, createChunkTally());
  const nothingToDo = chunkRunOutcome({ reason: "already_finished", status: "complete" }, createChunkTally());
  assert.equal(declined.outcome, RUN_OUTCOMES.SKIPPED, "losing a claim is a DECISION not to run");
  assert.equal(nothingToDo.outcome, RUN_OUTCOMES.NOOP, "an already-finished job is a MEASURED nothing-to-do");
  assert.notEqual(declined.outcome, nothingToDo.outcome);
});

test("chunkRunOutcome — an unmapped reason closes FAILED, never rounded up to succeeded", () => {
  const closed = chunkRunOutcome({ ok: true, reason: "some_future_early_return" }, createChunkTally());
  assert.equal(closed.outcome, RUN_OUTCOMES.FAILED);
  assert.match(closed.reason, /^unmapped_chunk_reason:some_future_early_return$/);
  assert.match(closed.error, /no mapping for/);

  const missing = chunkRunOutcome(undefined, createChunkTally());
  assert.equal(missing.outcome, RUN_OUTCOMES.FAILED);
  assert.equal(missing.reason, "unmapped_chunk_reason:none");
});

test("GUARD — every reason literal runScanChunk can return is mapped by chunkRunOutcome", async () => {
  // Read the source rather than trusting the list above to stay complete: a new
  // early return added to runScanChunk must either be mapped here or fail this
  // test, because the default branch would otherwise file it as a failure
  // forever without anyone noticing the mapping was never written.
  const { readFile } = await import("node:fs/promises");
  const src = await readFile(new URL("./scanWorker.js", import.meta.url), "utf8");
  const body = src.slice(src.indexOf("export async function runScanChunk"));
  const reasons = [...body.matchAll(/reason: "([a-z_]+)"/g)].map((m) => m[1]);
  assert.ok(reasons.length >= 8, `expected to find runScanChunk's reasons, found ${reasons.length}`);
  for (const reason of new Set(reasons)) {
    const closed = chunkRunOutcome({ reason, status: "probing" }, createChunkTally());
    assert.ok(
      !closed.reason.startsWith("unmapped_chunk_reason"),
      `runScanChunk can return reason "${reason}" but chunkRunOutcome has no case for it`
    );
  }
});

test("resolveEntryPhase — the phase a chunk enters, and 'entry' when it enters none", () => {
  assert.equal(resolveEntryPhase(null), CHUNK_PHASES.ENTRY);
  assert.equal(resolveEntryPhase({ status: "pending", checkpoint: null }), CHUNK_PHASES.SOURCING);
  // A finished job has no checkpoint either, but it is not about to source
  // anything: filing it under 'sourcing' would name the phase that would have
  // done the most work as the phase of a chunk that did none.
  assert.equal(resolveEntryPhase({ status: "complete", checkpoint: null }), CHUNK_PHASES.ENTRY);
  assert.equal(resolveEntryPhase({ status: "failed", checkpoint: null }), CHUNK_PHASES.ENTRY);
  assert.equal(resolveEntryPhase({ status: "probing", checkpoint: {} }), CHUNK_PHASES.PROBING);
  assert.equal(resolveEntryPhase({ status: "scoring", checkpoint: {} }), CHUNK_PHASES.FINALIZE);
  assert.equal(resolveEntryPhase({ status: "generating_prompts", checkpoint: {} }), CHUNK_PHASES.ENTRY);
});

test("CHUNK_RUN_HEARTBEAT_MS beats several times inside one chunk budget", () => {
  // A run whose heartbeat cannot move within the chunk's own budget would read
  // as stale to R3.3.2's sweep while the chunk was working perfectly.
  assert.ok(CHUNK_RUN_HEARTBEAT_MS * 3 <= CHUNK_TIME_BUDGET_MS);
});

// ---------------------------------------------------------------------------
// runScanChunk — one row per execution, on every path
// ---------------------------------------------------------------------------

test("runScanChunk — an unreadable job still writes a row: failed / read_failed", async () => {
  const ledger = makeLedger();
  const result = await runScanChunk("11111111-1111-4111-8111-111111111111", {
    ...ledger.deps,
    getScanJob: async () => {
      throw new Error("connection refused");
    },
  });

  assert.equal(result.reason, "read_failed");
  const row = soleRow(ledger);
  assert.equal(row.runner, RUNNERS.SCAN_CHUNK);
  assert.equal(row.phase, CHUNK_PHASES.ENTRY, "it never entered a work phase — do not label it 'sourcing'");
  assert.equal(row.outcome, RUN_OUTCOMES.FAILED);
  assert.equal(row.reason, "read_failed");
  assert.equal(row.error, "connection refused");
  assert.equal(row.probes_attempted, null, "nothing was measured, so nothing may read as zero");
  assert.equal(row.errors_recovered, null);
  assert.ok(row.started_at && row.ended_at, "timings: a closed row has both");
});

test("runScanChunk — a job id that is not a uuid is still recorded, in detail.job_id", async () => {
  const ledger = makeLedger();
  await runScanChunk("not-a-uuid", { ...ledger.deps, getScanJob: async () => null });

  const row = soleRow(ledger);
  assert.equal(row.scan_job_id, null, "a non-uuid must not be forced into a uuid column");
  assert.equal(row.detail.job_id, "not-a-uuid", "but the row must still say what it was asked about");
  assert.ok(row.worker_id, "worker_id keeps scan_runs_subject_chk satisfiable");
  assert.equal(row.outcome, RUN_OUTCOMES.SKIPPED);
  assert.equal(row.reason, "not_found");
});

test("runScanChunk — an already-finished job writes a NOOP row, not a skip and not a success", async () => {
  const ledger = makeLedger();
  const backend = makeBackend();
  const job = backend.seed({ id: "22222222-2222-4222-8222-222222222222", status: "complete" });

  const result = await runScanChunk(job.id, { ...backend.deps, ...ledger.deps });

  assert.equal(result.reason, "already_finished");
  const row = soleRow(ledger);
  assert.equal(row.phase, CHUNK_PHASES.ENTRY, "it entered no work phase");
  assert.equal(row.outcome, RUN_OUTCOMES.NOOP);
  assert.equal(row.reason, "already_finished");
  assert.equal(row.detail.job_status, "complete");
  assert.equal(row.brand, "Acme");
  assert.equal(row.scan_job_id, job.id);
});

test("runScanChunk — losing the sourcing claim writes SKIPPED with the reason that used to be thrown away", async () => {
  const ledger = makeLedger();
  const backend = makeBackend();
  const job = backend.seed({ id: "33333333-3333-4333-8333-333333333333", status: "pending" });

  const result = await runScanChunk(job.id, {
    ...backend.deps,
    ...ledger.deps,
    claimJobStatus: async () => null,
  });

  assert.equal(result.reason, "sourcing_claimed_elsewhere");
  const row = soleRow(ledger);
  assert.equal(row.phase, CHUNK_PHASES.SOURCING, "it entered on the sourcing path");
  assert.equal(row.outcome, RUN_OUTCOMES.SKIPPED);
  assert.equal(row.reason, "sourcing_claimed_elsewhere");
  assert.deepEqual(row.detail.phases_run, [], "it declined before entering any phase");
  assert.equal(row.probes_attempted, null);
  assert.equal(row.errors_recovered, null, "a chunk that ran nothing measured nothing");
});

test("runScanChunk — a checkpointed job in an unworkable status writes NOOP with the status in its reason", async () => {
  const ledger = makeLedger();
  const backend = makeBackend();
  const job = backend.seed({
    id: "44444444-4444-4444-8444-444444444444",
    status: "generating_prompts",
    checkpoint: makeCheckpoint(makeQueries(1)),
  });

  const result = await runScanChunk(job.id, { ...backend.deps, ...ledger.deps });

  assert.equal(result.reason, "noop");
  const row = soleRow(ledger);
  assert.equal(row.outcome, RUN_OUTCOMES.NOOP);
  assert.equal(row.reason, "noop_status_generating_prompts", "an unexplained noop is what the reason column forbids");
});

test("runScanChunk — a probing chunk counts probes it MEASURED: attempted, succeeded, errors recovered", async () => {
  const ledger = makeLedger();
  const backend = makeBackend();
  const queries = makeQueries(4);
  const job = backend.seed({
    id: "55555555-5555-4555-8555-555555555555",
    status: "probing",
    checkpoint: makeCheckpoint(queries),
  });

  // One of the four probes comes back carrying `error` — absorbed, its row
  // still written, and therefore an error this chunk RECOVERED from.
  let seen = 0;
  const engine = {
    name: "aio",
    concurrency: 4,
    probe: async (query) => probeResult("aio", query, { error: seen++ === 2 ? "upstream 502" : null }),
  };

  const result = await runScanChunk(job.id, {
    ...backend.deps,
    ...ledger.deps,
    resolveEnabledEngines: () => [engine],
    extractCompetitors: async () => [],
  });

  assert.equal(result.reason, "complete");
  const row = soleRow(ledger);
  assert.equal(row.phase, CHUNK_PHASES.PROBING);
  assert.equal(row.outcome, RUN_OUTCOMES.SUCCEEDED);
  assert.equal(row.reason, "complete");
  assert.equal(row.probes_attempted, 4);
  assert.equal(row.probes_succeeded, 3);
  assert.equal(row.errors_recovered, 1, "a run that succeeded after swallowing one failure is not a clean run");
  assert.deepEqual(row.detail.phases_run, [CHUNK_PHASES.PROBING, CHUNK_PHASES.FINALIZE]);
});

test("runScanChunk — a chunk with every pair already probed reports a MEASURED zero, not 'not measured'", async () => {
  const ledger = makeLedger();
  const backend = makeBackend();
  const queries = makeQueries(2);
  const job = backend.seed({
    id: "66666666-6666-4666-8666-666666666666",
    status: "probing",
    checkpoint: makeCheckpoint(queries),
  });
  queries.forEach((q) =>
    backend.promptResults.push({ job_id: job.id, engine: "aio", query: q.text, raw: probeResult("aio", q) })
  );

  const result = await runScanChunk(job.id, {
    ...backend.deps,
    ...ledger.deps,
    resolveEnabledEngines: () => [
      { name: "aio", concurrency: 2, probe: async () => assert.fail("nothing left to probe") },
    ],
    extractCompetitors: async () => [],
  });

  assert.equal(result.reason, "complete");
  const row = soleRow(ledger);
  assert.equal(row.probes_attempted, 0, "it entered probing and looked — that is a measured zero");
  assert.equal(row.probes_succeeded, 0);
  assert.notEqual(row.probes_attempted, null, "0 and null are different rows and must stay different");
});

test("runScanChunk — a finalize-only chunk leaves the probe counters NULL: it never probed", async () => {
  const ledger = makeLedger();
  const backend = makeBackend();
  const queries = makeQueries(2);
  const job = backend.seed({
    id: "77777777-7777-4777-8777-777777777777",
    status: "scoring",
    checkpoint: makeCheckpoint(queries),
  });
  // Already stamped: the legitimate crash-then-resume case, where a prior
  // finalize reached stampScanIdForJob and died. This chunk re-enters at
  // "scoring" and finishes the job without probing anything.
  queries.forEach((q) =>
    backend.promptResults.push({
      id: `pr-${q.text}`,
      job_id: job.id,
      engine: "aio",
      query: q.text,
      scan_id: "scan-from-a-prior-chunk",
      raw: probeResult("aio", q),
    })
  );

  const result = await runScanChunk(job.id, {
    ...backend.deps,
    ...ledger.deps,
    resolveEnabledEngines: () => [{ name: "aio", concurrency: 2, probe: async () => assert.fail("no probing here") }],
    extractCompetitors: async () => [],
  });

  assert.equal(result.reason, "complete");
  const row = soleRow(ledger);
  assert.equal(row.phase, CHUNK_PHASES.FINALIZE);
  assert.equal(row.probes_attempted, null, "NOT MEASURED — this chunk never entered probing");
  assert.equal(row.probes_succeeded, null);
  assert.equal(row.errors_recovered, 0, "finalize DID watch for absorbed errors and found none");
  assert.deepEqual(row.detail.phases_run, [CHUNK_PHASES.FINALIZE]);
});

test("runScanChunk — hitting the time budget closes SUCCEEDED/checkpointed with the probes it did land", async () => {
  const ledger = makeLedger();
  const backend = makeBackend();
  const queries = makeQueries(6);
  const job = backend.seed({
    id: "88888888-8888-4888-8888-888888888888",
    status: "probing",
    checkpoint: makeCheckpoint(queries),
  });

  const result = await runScanChunk(job.id, {
    ...backend.deps,
    ...ledger.deps,
    resolveEnabledEngines: () => [
      { name: "aio", concurrency: 1, probe: async (q) => probeResult("aio", q) },
    ],
    chunkBudgetMs: 0,
  });

  assert.equal(result.reason, "checkpointed");
  const row = soleRow(ledger);
  assert.equal(row.outcome, RUN_OUTCOMES.SUCCEEDED, "the CHUNK finished its work and handed off");
  assert.equal(row.reason, "checkpointed", "…and the reason says the JOB did not");
  assert.equal(row.probes_attempted, 1);
  assert.equal(row.probes_succeeded, 1);
  assert.equal(row.detail.progress_pct, result.progress_pct);
  assert.equal(backend.calls.selfContinue.length, 1);
});

test("runScanChunk — a chunk that throws closes FAILED with the error, and the job is marked failed", async () => {
  const ledger = makeLedger();
  const backend = makeBackend();
  const queries = makeQueries(2);
  const job = backend.seed({
    id: "99999999-9999-4999-8999-999999999999",
    status: "probing",
    checkpoint: makeCheckpoint(queries),
  });

  const result = await runScanChunk(job.id, {
    ...backend.deps,
    ...ledger.deps,
    resolveEnabledEngines: () => [
      { name: "aio", concurrency: 2, probe: async (q) => probeResult("aio", q) },
    ],
    upsertPromptResults: async () => {
      throw new Error("prompt_results write refused");
    },
  });

  assert.equal(result.ok, false);
  const row = soleRow(ledger);
  assert.equal(row.outcome, RUN_OUTCOMES.FAILED);
  assert.equal(row.reason, "chunk_failed");
  assert.match(row.error, /prompt_results write refused/);
  assert.equal(row.probes_attempted, 2, "the probes really ran and really cost money — they stay counted");
  assert.equal(row.probes_succeeded, 0, "nothing landed durably, so nothing succeeded");
  assert.equal(job.status, "failed");
});

test("runScanChunk — a run whose CLOSE fails stays OPEN for the reaper and says so, loudly", async () => {
  const ledger = makeLedger({ failClose: true });
  const backend = makeBackend();
  const job = backend.seed({ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", status: "complete" });

  const errors = [];
  const realError = console.error;
  console.error = (...args) => errors.push(args.join(" "));
  try {
    await runScanChunk(job.id, { ...backend.deps, ...ledger.deps });
  } finally {
    console.error = realError;
  }

  const row = soleRow(ledger);
  assert.equal(row.ended_at, null, "an unclosed run must stay OPEN — that is the reapable state");
  assert.equal(row.outcome, null);
  assert.ok(
    errors.some((line) => /could not close run/.test(line) && /stays OPEN/.test(line)),
    `a failed close must announce itself; got: ${JSON.stringify(errors)}`
  );
});

test("runScanChunk — the run is OPEN while the work is in flight, so a chunk that dies leaves evidence", async () => {
  // The row cannot be opened after the fact by a process that no longer exists,
  // so the only thing that makes a dead chunk visible is that its row was
  // already there, already OPEN, while it was working. That is what this
  // inspects: mid-probe, from inside the probe itself.
  const ledger = makeLedger();
  const backend = makeBackend();
  const job = backend.seed({
    id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    status: "probing",
    checkpoint: makeCheckpoint(makeQueries(1)),
  });

  let inFlight = null;
  await runScanChunk(job.id, {
    ...backend.deps,
    ...ledger.deps,
    extractCompetitors: async () => [],
    resolveEnabledEngines: () => [
      {
        name: "aio",
        concurrency: 1,
        probe: async (q) => {
          // If the process vanished HERE, this is the state that survives.
          inFlight = { ...ledger.rows[0] };
          return probeResult("aio", q);
        },
      },
    ],
  });

  assert.ok(inFlight, "the probe must have run");
  assert.ok(inFlight.started_at, "the row already existed, with a start time, before the work");
  assert.equal(inFlight.ended_at, null, "and it was OPEN — the state R3.3.2 sweeps and closes as 'reaped'");
  assert.equal(inFlight.outcome, null, "an open run says nothing about how it went, which is honest");
  assert.equal(soleRow(ledger).ended_at !== null, true, "the surviving chunk did close it");
});

// ---------------------------------------------------------------------------
// Rescue and re-entry: two chunks, two rows, never two accounts of one chunk
// ---------------------------------------------------------------------------

test("runScanChunk — a rescued scan is two CHUNKS in the ledger, not two accounts of one", async () => {
  const ledger = makeLedger();
  const backend = makeBackend();
  const queries = makeQueries(4);
  const job = backend.seed({
    id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    status: "probing",
    checkpoint: makeCheckpoint(queries),
  });

  const engineDeps = {
    ...backend.deps,
    ...ledger.deps,
    resolveEnabledEngines: () => [
      { name: "aio", concurrency: 1, probe: async (q) => probeResult("aio", q) },
    ],
    extractCompetitors: async () => [],
  };

  const first = await runScanChunk(job.id, { ...engineDeps, chunkBudgetMs: 0 });
  assert.equal(first.reason, "checkpointed");
  const second = await runScanChunk(job.id, engineDeps);
  assert.equal(second.reason, "complete");

  assert.equal(ledger.rows.length, 2, "two executions, two rows");
  const [a, b] = ledger.rows;
  assert.notEqual(a.worker_id, b.worker_id, "each invocation is identifiable on its own");
  assert.equal(a.scan_job_id, b.scan_job_id, "…and both are tied to the same scan job");
  assert.ok(a.ended_at && b.ended_at, "neither is left open");

  // The point of the design: summing the ledger counts each probe once. A
  // second row that re-reported the first chunk's probes would be the double
  // count this task had to avoid.
  const attempted = ledger.rows.reduce((n, r) => n + r.probes_attempted, 0);
  assert.equal(attempted, queries.length, "every pair counted exactly once across the two rows");
});

test("runScanChunk — a rescue that races a live chunk records a SKIP, never a duplicate of the work", async () => {
  // Two invocations over one job at the same instant: the status-poll rescue
  // firing on top of a chunk that is still finalizing. Exactly one may finish
  // the job; the other must leave a row that says it did nothing, because a
  // second row reporting the same work is the double count this task had to
  // avoid.
  const ledger = makeLedger();
  const backend = makeBackend();
  const queries = makeQueries(2);
  const job = backend.seed({
    id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    status: "probing",
    checkpoint: makeCheckpoint(queries),
  });
  queries.forEach((q) =>
    backend.promptResults.push({
      id: `pr-${q.text}`,
      job_id: job.id,
      engine: "aio",
      query: q.text,
      scan_id: null,
      raw: probeResult("aio", q),
    })
  );

  const deps = {
    ...backend.deps,
    ...ledger.deps,
    extractCompetitors: async () => [],
    resolveEnabledEngines: () => [
      { name: "aio", concurrency: 2, probe: async () => assert.fail("every pair is already persisted") },
    ],
  };

  const results = await Promise.all([runScanChunk(job.id, deps), runScanChunk(job.id, deps)]);
  const reasons = results.map((r) => r.reason).sort();
  assert.deepEqual(reasons, ["complete", "finalize_claimed_elsewhere"]);

  assert.equal(ledger.rows.length, 2, "two executions, two rows");
  const skipped = ledger.rows.find((r) => r.outcome === RUN_OUTCOMES.SKIPPED);
  const succeeded = ledger.rows.find((r) => r.outcome === RUN_OUTCOMES.SUCCEEDED);
  assert.ok(skipped && succeeded, "one skip, one success — never two successes over one finalize");
  assert.equal(skipped.reason, "finalize_claimed_elsewhere");
  // Both chunks really did enter probing and really did find every pair already
  // persisted, so both report a MEASURED zero there. What separates them is the
  // outcome: only one of them finalized, and only its row claims to have.
  assert.equal(skipped.probes_attempted, 0);
  assert.equal(succeeded.probes_attempted, 0);
  assert.deepEqual(skipped.detail.phases_run, ["probing", "finalize"]);
  assert.equal(backend.calls.insertScan.length, 1, "and only one scan row was ever written");
});

test("runScanChunk — the ledger is never closed twice for one chunk", async () => {
  // makeLedger's closeScanRun raises on a second close, exactly as
  // close_scan_run does. If any path in runScanChunk closed twice, this throws.
  const ledger = makeLedger();
  const backend = makeBackend();
  const job = backend.seed({ id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", status: "failed" });

  await runScanChunk(job.id, { ...backend.deps, ...ledger.deps });
  const row = soleRow(ledger);
  assert.ok(row.ended_at);
});

// ---------------------------------------------------------------------------
// No ledger configured: the skip announces itself
// ---------------------------------------------------------------------------

test("runScanChunk — with no ledger client the chunk still runs, and SAYS what goes unrecorded", async () => {
  // `npm run test:scoring` has no Supabase credentials, so db.js's client is
  // null and this is the path every other test in the suite takes. A silent
  // pass here would be a suite that reports green on a ledger nobody wrote.
  requireNoDbClient("this case");
  const backend = makeBackend();
  const job = backend.seed({ id: "ffffffff-ffff-4fff-8fff-ffffffffffff", status: "complete" });

  const warnings = [];
  const realWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(" "));
  let result;
  try {
    result = await runScanChunk(job.id, backend.deps); // no ledger deps injected
  } finally {
    console.warn = realWarn;
  }

  assert.equal(result.reason, "already_finished", "the chunk still does its job");
  const banner = warnings.find((w) => w.includes("SCAN_RUNS LEDGER DISABLED"));
  assert.ok(banner, `a disabled ledger must announce itself; got: ${JSON.stringify(warnings)}`);
  assert.match(banner, /no Supabase client is configured/);
  assert.match(banner, /NO scan_runs row/);
  assert.match(banner, /must not be read as "the chunk never ran"/);
});

// ---------------------------------------------------------------------------
// The phases' own measurements, exercised directly
// ---------------------------------------------------------------------------

test("runProbingPhase — arms its counters on entry, so 'probed nothing' differs from 'never probed'", async () => {
  const backend = makeBackend();
  const queries = makeQueries(2);
  const jobId = "probe-direct";
  queries.forEach((q) =>
    backend.promptResults.push({ job_id: jobId, engine: "aio", query: q.text, raw: probeResult("aio", q) })
  );

  const tally = createChunkTally();
  await runProbingPhase(
    jobId,
    makeCheckpoint(queries),
    { ...backend.deps, resolveEnabledEngines: () => [{ name: "aio", concurrency: 2, probe: async () => assert.fail("nothing to probe") }] },
    Date.now(),
    tally
  );

  assert.equal(tally.probesAttempted, 0);
  assert.equal(tally.probesSucceeded, 0);
  assert.equal(tally.errorsRecovered, 0);
});

test("runSourcingPhase — a swallowed prompt-persist failure is COUNTED, not only logged", async () => {
  const tally = createChunkTally();
  const warn = console.warn;
  console.warn = () => {};
  try {
    await runSourcingPhase(
      { brand: "Acme", url: "acme.com", industry: "saas", competitors: "" },
      {
        promptTarget: 4,
        getPromptsForBrand: async () => [],
        generateUnbrandedPrompts: async () =>
          makeQueries(4).map((q) => ({ ...q, weight: 1, enabled: true })),
        upsertPrompts: async () => {
          throw new Error("brand_prompts write refused");
        },
        buildBrandedQueries: () => [],
        resolveEnabledEngines: () => [{ name: "aio" }],
      },
      tally
    );
  } finally {
    console.warn = warn;
  }

  assert.equal(tally.errorsRecovered, 1, "the chunk continued past this error; the ledger must show it did");
});

// ===========================================================================
// R3.2.2 — every discarded skip reason becomes a ledger row
// ===========================================================================
//
// R3.2.1 gave a chunk ONE row carrying its outcome. What still vanished was
// every decision INSIDE that row: an engine that could not be probed, a probe
// that came back empty, a row that could not be judged, and — worst, because it
// left no trace at all — a due brand the scheduler declined to scan.
//
// Two levels, deliberately, and the tests below hold both:
//   * IN-CHUNK skips ride on the chunk's single row, in `detail.skips`,
//     aggregated by reason with an exact count. One row per skip would break
//     R3.2.1's accept and the `sum(probes_attempted) === queries.length`
//     property a verifier proved; the last two tests here re-prove both.
//   * SCHEDULER skips get rows of their OWN, because no chunk ran for them to
//     ride on. Migration 011's header names exactly this case as the reason
//     scan_job_id carries no foreign key.
//
// And the arming rule from R3.2.1 extends to skips: `skips: null` means the
// chunk never watched for any, `skips: []` with `skips_total: 0` means it
// watched and found none. Those are different rows.

// R3.2.4: dynamic, like the imports at the top of this file. A static import
// anywhere in the file is hoisted above the credential clearing there, which
// would let scanWorker.js -> db.js capture a live client after all.
const {
  runSchedulerTick,
  runFinalizePhase,
  recordSkip,
  recordEngineResolutionSkip,
  summarizeSkips,
  CHUNK_SKIP_REASONS,
  SCHEDULER_PHASES,
  SCHEDULER_SKIP_REASONS,
  SCHEDULER_TICK_REASONS,
  SKIP_SAMPLE_MAX,
} = await import("./scanWorker.js");
const { ENGINE_RESOLUTION_SKIPS } = await import("../scoring/enginePipeline.js");

/** The one skip entry for `reason` on a closed row, or undefined. */
function skipEntry(row, reason) {
  return ((row.detail && row.detail.skips) || []).find((s) => s.reason === reason);
}

/** A scheduler backend: schedules in, jobs out, nothing else. */
function makeSchedulerBackend({ due = [], active = new Set() } = {}) {
  const jobs = [];
  const schedules = [];
  const kicked = [];
  let n = 0;
  return {
    jobs,
    schedules,
    kicked,
    deps: {
      listDueSchedules: async () => due,
      hasActiveScanForBrand: async (brand) => active.has(brand),
      createScanJob: async (fields) => {
        const job = { id: `job-${n++}`, ...fields };
        jobs.push(job);
        return job;
      },
      upsertScanSchedule: async (key, fields) => {
        schedules.push({ key, ...fields });
        return fields;
      },
      runScanChunk: async (id) => {
        kicked.push(id);
      },
      schedulerId: "scheduler-under-test",
    },
  };
}

function schedule(brand, cadence = "daily", displayName = null) {
  return { brand, display_name: displayName, cadence, enabled: true, next_run_at: null };
}

/** Rows the scheduler wrote for one phase. */
function rowsInPhase(ledger, phase) {
  return ledger.rows.filter((r) => r.phase === phase);
}

// ---------------------------------------------------------------------------
// summarizeSkips — the arming rule, pure
// ---------------------------------------------------------------------------

test("summarizeSkips — a tally nothing armed reports NOT MEASURED, never an empty list", () => {
  const tally = createChunkTally();
  assert.equal(tally.skips, null, "createChunkTally must not hand out a pre-armed empty list");
  const { skips, skips_total } = summarizeSkips(tally);
  assert.equal(skips, null, "[] would claim 'nothing was skipped' — a claim this chunk cannot make");
  assert.equal(skips_total, null, "and 0 would be that same claim as a number");
});

test("summarizeSkips — an armed-but-clean tally is a MEASURED zero, distinct from never armed", () => {
  const { skips, skips_total } = summarizeSkips({ skips: [] });
  assert.deepEqual(skips, []);
  assert.equal(skips_total, 0);
  assert.notEqual(skips_total, summarizeSkips(createChunkTally()).skips_total);
});

test("chunkRunOutcome — carries skips onto detail, null when nothing measured them", () => {
  const never = chunkRunOutcome({ reason: "complete" }, createChunkTally());
  assert.equal(never.detail.skips, null);
  assert.equal(never.detail.skips_total, null);

  const measured = chunkRunOutcome(
    { reason: "complete" },
    { phases: ["probing"], skips: [{ reason: "probe_error", count: 3, sample: ["aio: 502"] }] }
  );
  assert.equal(measured.detail.skips_total, 3, "the count is exact even when the sample is not");
  assert.equal(measured.detail.skips[0].reason, "probe_error");
});

// ---------------------------------------------------------------------------
// CLASS 1 — scheduler skips: their own rows, because no job was ever created
// ---------------------------------------------------------------------------

test("runSchedulerTick — a cadence:'off' schedule writes a SKIPPED row naming the brand", async () => {
  const ledger = makeLedger();
  const backend = makeSchedulerBackend({ due: [schedule("off-co.com", "off", "Off Co")] });

  const result = await runSchedulerTick("2026-09-04T00:00:00.000Z", { ...backend.deps, ...ledger.deps });

  assert.equal(backend.jobs.length, 0, "it really did decline to scan");
  assert.deepEqual(result.skipped, [{ brand: "Off Co", reason: SCHEDULER_SKIP_REASONS.CADENCE_OFF }]);

  const skips = rowsInPhase(ledger, SCHEDULER_PHASES.SCHEDULE);
  assert.equal(skips.length, 1, "the decision not to scan IS the execution, so it gets the row");
  assert.equal(skips[0].runner, RUNNERS.SCHEDULER);
  assert.equal(skips[0].outcome, RUN_OUTCOMES.SKIPPED);
  assert.equal(skips[0].reason, SCHEDULER_SKIP_REASONS.CADENCE_OFF);
  assert.equal(skips[0].brand, "Off Co", "scan_runs_subject_chk is satisfied by the brand alone");
  assert.equal(skips[0].scan_job_id, null, "no job was created — that is the whole point of the row");
  assert.equal(skips[0].detail.schedule_key, "off-co.com");
  assert.ok(skips[0].ended_at, "opened and closed together; it leaves nothing open");
});

test("runSchedulerTick — a brand with a scan already running writes SKIPPED/brand_already_active", async () => {
  const ledger = makeLedger();
  const backend = makeSchedulerBackend({
    due: [schedule("busy.com", "daily", "Busy Co")],
    active: new Set(["Busy Co"]),
  });

  const result = await runSchedulerTick("2026-09-04T00:00:00.000Z", { ...backend.deps, ...ledger.deps });

  assert.equal(backend.jobs.length, 0);
  assert.equal(result.skipped[0].reason, SCHEDULER_SKIP_REASONS.BRAND_ALREADY_ACTIVE);

  const [row] = rowsInPhase(ledger, SCHEDULER_PHASES.SCHEDULE);
  assert.equal(row.outcome, RUN_OUTCOMES.SKIPPED);
  assert.equal(row.reason, SCHEDULER_SKIP_REASONS.BRAND_ALREADY_ACTIVE);
  assert.notEqual(
    row.reason,
    SCHEDULER_SKIP_REASONS.CADENCE_OFF,
    "'nobody wants this scanned' and 'it is already being scanned' are different facts"
  );
});

test("runSchedulerTick — a skip row names its reason at OPEN, so a failed close still explains it", async () => {
  // The close is deliberately fail-soft (closeChunkRun warns rather than
  // throws), which used to leave a durable row saying WHICH brand was declined
  // and nothing about WHY: `reason` was only ever passed to the close. An
  // unexplained skip is the exact thing R3.2.2 abolishes, so the reason goes on
  // the open detail too.
  const ledger = makeLedger({ failClose: true });
  const backend = makeSchedulerBackend({ due: [schedule("off-co.com", "off", "Off Co")] });

  const err = console.error;
  console.error = () => {};
  try {
    await runSchedulerTick("2026-09-04T00:00:00.000Z", { ...backend.deps, ...ledger.deps });
  } finally {
    console.error = err;
  }

  const [row] = rowsInPhase(ledger, SCHEDULER_PHASES.SCHEDULE);
  assert.equal(row.ended_at, null, "the close really did fail; the row is the open one");
  assert.equal(row.reason, null, "…so the reason column is empty — that is the gap");
  assert.equal(
    row.detail.reason,
    SCHEDULER_SKIP_REASONS.CADENCE_OFF,
    "an open skip row must still say why the brand was declined, not only which brand"
  );
});

test("runSchedulerTick — a scheduler skip measures no probes, so its counters stay NULL", async () => {
  const ledger = makeLedger();
  const backend = makeSchedulerBackend({ due: [schedule("off-co.com", "off", "Off Co")] });
  await runSchedulerTick("2026-09-04T00:00:00.000Z", { ...backend.deps, ...ledger.deps });

  for (const row of ledger.rows) {
    assert.equal(
      row.probes_attempted,
      null,
      `${row.phase}: a scheduler row reporting 0 probes would claim it looked for some`
    );
    assert.equal(row.probes_succeeded, null);
    assert.equal(row.errors_recovered, null);
  }
});

test("runSchedulerTick — an empty due list is a MEASURED zero (noop/no_schedules_due), not a silence", async () => {
  const ledger = makeLedger();
  const backend = makeSchedulerBackend({ due: [] });

  const result = await runSchedulerTick("2026-09-04T00:00:00.000Z", { ...backend.deps, ...ledger.deps });

  assert.deepEqual(result.started, []);
  const ticks = rowsInPhase(ledger, SCHEDULER_PHASES.TICK);
  assert.equal(ticks.length, 1, "exactly one row per tick");
  assert.equal(ticks[0].outcome, RUN_OUTCOMES.NOOP);
  assert.equal(ticks[0].reason, SCHEDULER_TICK_REASONS.NO_SCHEDULES_DUE);
  assert.equal(ticks[0].detail.due, 0);
  assert.equal(
    rowsInPhase(ledger, SCHEDULER_PHASES.SCHEDULE).length,
    0,
    "nothing was declined, so nothing is filed as declined"
  );
});

test("runSchedulerTick — 'nothing was due' and 'everything due was declined' are different rows", async () => {
  const quiet = makeLedger();
  await runSchedulerTick("2026-09-04T00:00:00.000Z", {
    ...makeSchedulerBackend({ due: [] }).deps,
    ...quiet.deps,
  });

  const starved = makeLedger();
  await runSchedulerTick("2026-09-04T00:00:00.000Z", {
    ...makeSchedulerBackend({
      due: [schedule("a.com", "off", "A Co"), schedule("b.com", "daily", "B Co")],
      active: new Set(["B Co"]),
    }).deps,
    ...starved.deps,
  });

  const quietTick = rowsInPhase(quiet, SCHEDULER_PHASES.TICK)[0];
  const starvedTick = rowsInPhase(starved, SCHEDULER_PHASES.TICK)[0];

  assert.equal(quietTick.reason, SCHEDULER_TICK_REASONS.NO_SCHEDULES_DUE);
  assert.equal(starvedTick.reason, SCHEDULER_TICK_REASONS.ALL_DUE_SKIPPED);
  assert.notEqual(
    quietTick.reason,
    starvedTick.reason,
    "two brands going unscanned must not read the same as an idle scheduler"
  );
  assert.equal(starvedTick.detail.due, 2);
  assert.equal(starvedTick.detail.skipped, 2);
  assert.equal(rowsInPhase(starved, SCHEDULER_PHASES.SCHEDULE).length, 2, "one row per declined brand");
  assert.deepEqual(
    rowsInPhase(starved, SCHEDULER_PHASES.SCHEDULE)
      .map((r) => r.reason)
      .sort(),
    [SCHEDULER_SKIP_REASONS.BRAND_ALREADY_ACTIVE, SCHEDULER_SKIP_REASONS.CADENCE_OFF]
  );
});

test("runSchedulerTick — a tick that started work closes SUCCEEDED and files no skip for it", async () => {
  const ledger = makeLedger();
  const backend = makeSchedulerBackend({
    due: [schedule("go.com", "daily", "Go Co"), schedule("off.com", "off", "Off Co")],
  });

  const result = await runSchedulerTick("2026-09-04T00:00:00.000Z", { ...backend.deps, ...ledger.deps });

  assert.equal(result.started.length, 1, "the working path is untouched by the ledger");
  assert.equal(backend.kicked.length, 1);
  const tick = rowsInPhase(ledger, SCHEDULER_PHASES.TICK)[0];
  assert.equal(tick.outcome, RUN_OUTCOMES.SUCCEEDED);
  assert.equal(tick.detail.started, 1);
  assert.equal(tick.detail.skipped, 1);
  const skips = rowsInPhase(ledger, SCHEDULER_PHASES.SCHEDULE);
  assert.equal(skips.length, 1);
  assert.equal(skips[0].brand, "Off Co", "only the declined brand gets a skip row");
  assert.ok(
    ledger.rows.every((r) => r.worker_id === "scheduler-under-test"),
    "the tick and its skips share a worker_id so they can be joined back together"
  );
});

test("runSchedulerTick — a tick that throws closes FAILED and still rethrows", async () => {
  const ledger = makeLedger();
  const backend = makeSchedulerBackend({ due: [schedule("boom.com", "daily", "Boom Co")] });

  await assert.rejects(
    () =>
      runSchedulerTick("2026-09-04T00:00:00.000Z", {
        ...backend.deps,
        ...ledger.deps,
        createScanJob: async () => {
          throw new Error("scan_jobs insert refused");
        },
      }),
    /scan_jobs insert refused/,
    "recording the failure must not swallow it"
  );

  const tick = rowsInPhase(ledger, SCHEDULER_PHASES.TICK)[0];
  assert.equal(tick.outcome, RUN_OUTCOMES.FAILED);
  assert.equal(tick.reason, SCHEDULER_TICK_REASONS.TICK_FAILED);
  assert.match(tick.error, /scan_jobs insert refused/);
  assert.ok(tick.ended_at, "a tick that died halfway is closed FAILED, not left looking un-run");
});

test("runSchedulerTick — a tick that died inside listDueSchedules reports due as NOT MEASURED", async () => {
  // It never got the list, so it has no idea how many were due. `due: 0` there
  // would be a count it never took — the same lie the nullable counters ban.
  const ledger = makeLedger();
  await assert.rejects(() =>
    runSchedulerTick("2026-09-04T00:00:00.000Z", {
      ...makeSchedulerBackend().deps,
      ...ledger.deps,
      listDueSchedules: async () => {
        throw new Error("scan_schedules read refused");
      },
    })
  );

  const tick = rowsInPhase(ledger, SCHEDULER_PHASES.TICK)[0];
  assert.equal(tick.outcome, RUN_OUTCOMES.FAILED);
  assert.equal(tick.detail.due, null, "0 would claim it looked and found nothing due");
  assert.equal(tick.detail.skipped, 0, "…while the skips it DID take are a real measured zero");
});

test("runSchedulerTick — with no ledger client, the declined brand is still ANNOUNCED", async () => {
  // The suite has no Supabase credentials, so this is the path production takes
  // when the client is missing. A silent decline here is the original bug.
  requireNoDbClient("this case");
  const backend = makeSchedulerBackend({ due: [schedule("off.com", "off", "Off Co")] });
  const warnings = [];
  const realWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(" "));
  try {
    await runSchedulerTick("2026-09-04T00:00:00.000Z", backend.deps);
  } finally {
    console.warn = realWarn;
  }

  assert.ok(
    warnings.some((w) => /"Off Co" was due and was NOT scanned \(cadence_off\)/.test(w)),
    `the skip must name the brand and the reason; got ${JSON.stringify(warnings)}`
  );
  assert.ok(
    warnings.some((w) => w.includes("SCAN_RUNS LEDGER DISABLED")),
    "and the disabled ledger must still announce what goes unrecorded"
  );
});

// ---------------------------------------------------------------------------
// CLASS 2 — engine skips: an engine frozen into the scan that is gone today
// ---------------------------------------------------------------------------

test("runScanChunk — an engine frozen into the checkpoint but no longer registered is recorded, not dropped", async () => {
  const ledger = makeLedger();
  const backend = makeBackend();
  const queries = makeQueries(2);
  const job = backend.seed({
    id: "10101010-1010-4010-8010-101010101010",
    status: "probing",
    // Two engines were frozen at sourcing time…
    checkpoint: makeCheckpoint(queries, ["aio", "perplexity"]),
  });

  const warn = console.warn;
  console.warn = () => {};
  let result;
  try {
    result = await runScanChunk(job.id, {
      ...backend.deps,
      ...ledger.deps,
      // …and only one of them resolves today: perplexity's key was pulled.
      resolveEnabledEngines: () => [
        { name: "aio", concurrency: 2, probe: async (q) => probeResult("aio", q) },
      ],
      extractCompetitors: async () => [],
    });
  } finally {
    console.warn = warn;
  }

  assert.equal(result.reason, "complete", "the scan still finishes — that is exactly why this was invisible");
  const row = soleRow(ledger);
  assert.equal(row.outcome, RUN_OUTCOMES.SUCCEEDED);

  const skip = skipEntry(row, CHUNK_SKIP_REASONS.ENGINE_NOT_REGISTERED);
  assert.ok(skip, "a whole engine going unprobed must not be invisible under a 'succeeded' row");
  assert.equal(skip.count, 1);
  assert.deepEqual(skip.sample, ["perplexity"], "and the row must say WHICH engine");
  assert.equal(row.detail.skips_total, 1);
  assert.equal(row.probes_attempted, 2, "only the surviving engine's pairs were attempted");
});

test("runScanChunk — when NO frozen engine resolves, the silent substitution is its own reason", async () => {
  const ledger = makeLedger();
  const backend = makeBackend();
  const queries = makeQueries(1);
  const job = backend.seed({
    id: "20202020-2020-4020-8020-202020202020",
    status: "probing",
    checkpoint: makeCheckpoint(queries, ["perplexity", "chatgpt"]),
  });

  const warn = console.warn;
  console.warn = () => {};
  try {
    await runScanChunk(job.id, {
      ...backend.deps,
      ...ledger.deps,
      resolveEnabledEngines: () => [
        { name: "aio", concurrency: 1, probe: async (q) => probeResult("aio", q) },
      ],
      extractCompetitors: async () => [],
    });
  } finally {
    console.warn = warn;
  }

  const row = soleRow(ledger);
  const fallback = skipEntry(row, CHUNK_SKIP_REASONS.ENGINE_SET_FALLBACK);
  assert.ok(fallback, "answering the scan with a different engine set is a decision, not a detail");
  assert.deepEqual(fallback.sample, ["perplexity,chatgpt"]);
  assert.equal(
    skipEntry(row, CHUNK_SKIP_REASONS.ENGINE_NOT_REGISTERED).count,
    2,
    "…and each individual engine that went missing is still counted"
  );
});

// ---------------------------------------------------------------------------
// CLASS 2b — engine skips that happen INSIDE resolveEnabledEngines
// ---------------------------------------------------------------------------
//
// The two tests above cover the engine that was frozen into a checkpoint and is
// gone today. They cannot cover the EARLIER drop, and that is exactly why it
// stayed invisible: `checkpoint.engines` is built from resolveEnabledEngines'
// return value, i.e. the POST-drop list, so by the time anything downstream can
// look, the engines that `ENGINES` asked for and did not get are no longer
// mentioned anywhere. resolveEnabledEngines pushed them onto a local array that
// no caller read.
//
// These tests therefore use the REAL resolveEnabledEngines (no dep stub) driven
// by the real `ENGINES` variable, because a stubbed resolver cannot drop
// anything and would prove nothing.

/** Swap ENGINES and the engine keys, run fn, put everything back. */
async function withEngineEnv({ engines, openaiKey, perplexityKey, brightdataKey }, fn) {
  const saved = {
    ENGINES: process.env.ENGINES,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    PERPLEXITY_API_KEY: process.env.PERPLEXITY_API_KEY,
    BRIGHTDATA_API_KEY: process.env.BRIGHTDATA_API_KEY,
  };
  const apply = (key, value) => {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  };
  const warn = console.warn;
  apply("ENGINES", engines);
  apply("OPENAI_API_KEY", openaiKey);
  apply("PERPLEXITY_API_KEY", perplexityKey);
  apply("BRIGHTDATA_API_KEY", brightdataKey);
  console.warn = () => {};
  try {
    return await fn();
  } finally {
    console.warn = warn;
    for (const [key, value] of Object.entries(saved)) apply(key, value);
  }
}

/** Sourcing deps that generate `count` fixed queries and persist nothing. */
function sourcingDeps(queries) {
  return {
    promptTarget: queries.length,
    getPromptsForBrand: async () => [],
    generateUnbrandedPrompts: async () => queries.map((q) => ({ ...q, weight: 1, enabled: true })),
    upsertPrompts: async () => queries,
    buildBrandedQueries: () => [],
  };
}

test("runSourcingPhase — a typo in ENGINES and a missing API key are DIFFERENT recorded reasons", async () => {
  const queries = makeQueries(2);
  const tally = createChunkTally();

  const checkpoint = await withEngineEnv(
    // "notanengine" is a typo; "chatgpt" is real but has no key.
    { engines: "aio,chatgpt,notanengine", openaiKey: undefined, brightdataKey: "test-key" },
    () =>
      runSourcingPhase(
        { brand: "Acme", url: "acme.com", industry: "saas", competitors: "" },
        sourcingDeps(queries), // deliberately NO resolveEnabledEngines stub
        tally
      )
  );

  const unknown = tally.skips.find((s) => s.reason === CHUNK_SKIP_REASONS.ENGINE_UNKNOWN);
  assert.ok(unknown, "an engine ENGINES named that does not exist must not vanish into a console line");
  assert.deepEqual(unknown.sample, ["notanengine"], "and the row must name it");

  const unconfigured = tally.skips.find((s) => s.reason === CHUNK_SKIP_REASONS.ENGINE_NOT_CONFIGURED);
  assert.ok(unconfigured, "an engine dropped for a missing key must not vanish either");
  assert.deepEqual(unconfigured.sample, ["chatgpt"]);

  // The whole reason these are two codes: the operator fixes a typo by editing
  // ENGINES and a missing key by setting the key. One "engine dropped" reason
  // would tell them a drop happened and nothing about which to do.
  assert.notEqual(
    CHUNK_SKIP_REASONS.ENGINE_UNKNOWN,
    CHUNK_SKIP_REASONS.ENGINE_NOT_CONFIGURED,
    "collapsing these two loses the only actionable part of the record"
  );

  // …and this is why the recording has to happen HERE. The checkpoint keeps only
  // the survivors, so after this line the dropped names exist nowhere.
  assert.deepEqual(checkpoint.engines, ["aio"], "the frozen set cannot reveal what was dropped");
  assert.equal(summarizeSkips(tally).skips_total, 2);
});

test("runSourcingPhase — the default-to-aio substitution is a decision, with its own reason", async () => {
  const queries = makeQueries(1);
  const tally = createChunkTally();

  const checkpoint = await withEngineEnv(
    { engines: "chatgpt,perplexity", openaiKey: undefined, perplexityKey: undefined, brightdataKey: "test-key" },
    () =>
      runSourcingPhase(
        { brand: "Acme", url: "acme.com", industry: "saas", competitors: "" },
        sourcingDeps(queries),
        tally
      )
  );

  // Nobody asked for aio. The scan runs on it anyway and finalizes clean, which
  // is precisely why a bare console.warn was not enough.
  assert.deepEqual(checkpoint.engines, ["aio"]);
  const defaulted = tally.skips.find((s) => s.reason === CHUNK_SKIP_REASONS.ENGINE_SET_DEFAULTED);
  assert.ok(defaulted, "answering a scan with an engine set nobody requested is a recordable decision");
  assert.equal(defaulted.count, 1, "announced once, not once per dropped engine");
  assert.deepEqual(defaulted.sample, ["chatgpt,perplexity"], "and it names the set that was asked for");

  // Distinct from the checkpoint-level fallback, which is a different failure at
  // a different time: that one substitutes for a FROZEN set mid-scan.
  assert.notEqual(CHUNK_SKIP_REASONS.ENGINE_SET_DEFAULTED, CHUNK_SKIP_REASONS.ENGINE_SET_FALLBACK);
  assert.equal(tally.skips.find((s) => s.reason === CHUNK_SKIP_REASONS.ENGINE_NOT_CONFIGURED).count, 2);
});

test("runSourcingPhase — a clean ENGINES set records no engine skips at all", async () => {
  const queries = makeQueries(1);
  const tally = createChunkTally();

  await withEngineEnv({ engines: "aio", brightdataKey: "test-key" }, () =>
    runSourcingPhase(
      { brand: "Acme", url: "acme.com", industry: "saas", competitors: "" },
      sourcingDeps(queries),
      tally
    )
  );

  // MEASURED zero, not silence: sourcing arms the watch, so [] here means "it
  // looked and every requested engine resolved".
  assert.deepEqual(tally.skips, [], "a clean resolve must not manufacture skips");
  assert.equal(summarizeSkips(tally).skips_total, 0);
});

test("runScanChunk — the engines ENGINES asked for and did not get are on the CLOSED row", async () => {
  const ledger = makeLedger();
  const backend = makeBackend();
  const queries = makeQueries(2);
  const job = backend.seed({ id: "40404040-4040-4040-8040-404040404040", status: "pending" });

  // Every (aio, query) pair is already persisted, so probing has nothing to do
  // and the REAL aio probe — which would reach the network — is never called.
  queries.forEach((q) =>
    backend.promptResults.push({
      job_id: job.id,
      engine: "aio",
      query: q.text,
      created_at: new Date().toISOString(),
      raw: probeResult("aio", q),
    })
  );

  const result = await withEngineEnv({ engines: "aio,chatgpt,notanengine", openaiKey: undefined, brightdataKey: "test-key" }, () =>
    runScanChunk(job.id, {
      ...backend.deps,
      ...ledger.deps,
      ...sourcingDeps(queries),
      extractCompetitors: async () => [],
      // NOTE: no resolveEnabledEngines stub — this chunk resolves for real.
    })
  );

  assert.equal(result.reason, "complete", "the scan still finishes — that is why this was invisible");
  const row = soleRow(ledger);
  assert.equal(row.outcome, RUN_OUTCOMES.SUCCEEDED, "and it still succeeds; the row must say what it lost");

  const unknown = skipEntry(row, CHUNK_SKIP_REASONS.ENGINE_UNKNOWN);
  assert.ok(unknown, `no engine_unknown on the closed row; got ${JSON.stringify(row.detail.skips)}`);
  assert.equal(unknown.count, 1);
  assert.deepEqual(unknown.sample, ["notanengine"]);

  const unconfigured = skipEntry(row, CHUNK_SKIP_REASONS.ENGINE_NOT_CONFIGURED);
  assert.ok(unconfigured, `no engine_not_configured on the closed row; got ${JSON.stringify(row.detail.skips)}`);
  assert.equal(unconfigured.count, 1);
  assert.deepEqual(unconfigured.sample, ["chatgpt"]);

  assert.ok(row.detail.skips_total >= 2, "the count is exact and includes both");
  assert.deepEqual(
    backend.jobs.get(job.id).checkpoint.engines,
    ["aio"],
    "sanity: the scan really did run on one engine after being asked for three"
  );
});

// ---------------------------------------------------------------------------
// CLASS 3 — batch decisions: probes that came back carrying an error
// ---------------------------------------------------------------------------

test("runScanChunk — a probe that errored records WHY, not only that errors_recovered went up", async () => {
  const ledger = makeLedger();
  const backend = makeBackend();
  const queries = makeQueries(4);
  const job = backend.seed({
    id: "30303030-3030-4030-8030-303030303030",
    status: "probing",
    checkpoint: makeCheckpoint(queries),
  });

  let seen = 0;
  const result = await runScanChunk(job.id, {
    ...backend.deps,
    ...ledger.deps,
    resolveEnabledEngines: () => [
      {
        name: "aio",
        concurrency: 4,
        probe: async (q) => probeResult("aio", q, { error: seen++ < 2 ? "upstream 502" : null }),
      },
    ],
    extractCompetitors: async () => [],
  });

  assert.equal(result.reason, "complete");
  const row = soleRow(ledger);
  assert.equal(row.errors_recovered, 2, "R3.2.1's count is unchanged…");
  const skip = skipEntry(row, CHUNK_SKIP_REASONS.PROBE_ERROR);
  assert.equal(skip.count, 2, "…and R3.2.2 adds the reason behind it");
  assert.ok(
    skip.sample.every((s) => s.includes("aio: upstream 502")),
    `the sample must carry the engine and the error; got ${JSON.stringify(skip.sample)}`
  );
});

test("runScanChunk — a clean probing chunk reports skips_total 0: it LOOKED and found none", async () => {
  const ledger = makeLedger();
  const backend = makeBackend();
  const job = backend.seed({
    id: "40404040-4040-4040-8040-404040404040",
    status: "probing",
    checkpoint: makeCheckpoint(makeQueries(2)),
  });

  await runScanChunk(job.id, {
    ...backend.deps,
    ...ledger.deps,
    resolveEnabledEngines: () => [{ name: "aio", concurrency: 2, probe: async (q) => probeResult("aio", q) }],
    extractCompetitors: async () => [],
  });

  const row = soleRow(ledger);
  assert.deepEqual(row.detail.skips, [], "armed and empty");
  assert.equal(row.detail.skips_total, 0);
  assert.notEqual(row.detail.skips_total, null, "0 and 'not measured' are different rows and must stay different");
});

test("runScanChunk — a chunk that entered no phase reports skips as NOT MEASURED", async () => {
  const ledger = makeLedger();
  const backend = makeBackend();
  const job = backend.seed({ id: "50505050-5050-4050-8050-505050505050", status: "complete" });

  await runScanChunk(job.id, { ...backend.deps, ...ledger.deps });

  const row = soleRow(ledger);
  assert.equal(row.outcome, RUN_OUTCOMES.NOOP);
  assert.equal(row.detail.skips, null, "it never watched for a skip, so it may not report zero of them");
  assert.equal(row.detail.skips_total, null);
});

test("runScanChunk — losing the sourcing claim leaves skips NOT MEASURED, like its counters", async () => {
  const ledger = makeLedger();
  const backend = makeBackend();
  const job = backend.seed({ id: "60606060-6060-4060-8060-606060606060", status: "pending" });

  await runScanChunk(job.id, { ...backend.deps, ...ledger.deps, claimJobStatus: async () => null });

  const row = soleRow(ledger);
  assert.equal(row.outcome, RUN_OUTCOMES.SKIPPED);
  assert.equal(row.detail.skips, null, "a chunk that declined before entering a phase measured nothing at all");
});

// ---------------------------------------------------------------------------
// CLASS 4 — finalize's per-row absorptions, which kept a 'succeeded' clean
// ---------------------------------------------------------------------------

test("runFinalizePhase — a row that could not be judged names its reason on the run", async () => {
  const backend = makeBackend();
  const queries = makeQueries(2);
  const jobId = "finalize-judge";
  backend.seed({ id: jobId, status: "probing" });
  queries.forEach((q, i) =>
    backend.promptResults.push({
      id: `pr-${i}`,
      job_id: jobId,
      engine: "aio",
      query: q.text,
      is_branded_query: false,
      scan_id: null,
      raw: probeResult("aio", q),
    })
  );

  const tally = createChunkTally();
  const warn = console.warn;
  console.warn = () => {};
  try {
    await runFinalizePhase(
      jobId,
      makeCheckpoint(queries),
      {
        ...backend.deps,
        resolveEnabledEngines: () => [{ name: "aio", concurrency: 2 }],
        extractCompetitors: async () => [],
        judgeBrandsSymmetric: () => {
          throw new Error("judge exploded");
        },
        enrichCitations: async () => {
          throw new Error("enricher exploded");
        },
      },
      tally
    );
  } finally {
    console.warn = warn;
  }

  const byReason = Object.fromEntries(tally.skips.map((s) => [s.reason, s]));
  assert.ok(byReason[CHUNK_SKIP_REASONS.REJUDGE_FAILED], "a kept-probe-time verdict is a skipped re-judge");
  assert.equal(byReason[CHUNK_SKIP_REASONS.REJUDGE_FAILED].count, 2);
  assert.ok(byReason[CHUNK_SKIP_REASONS.ROSTER_JUDGE_FAILED], "a row that produced no result_brands is a skip");
  assert.ok(byReason[CHUNK_SKIP_REASONS.CITATION_ENRICH_FAILED], "unclassified citations are a degraded write");
  assert.equal(byReason[CHUNK_SKIP_REASONS.CITATION_ENRICH_FAILED].count, 1);
  assert.equal(
    tally.errorsRecovered,
    5,
    "the counter and the reasons must agree: 2 re-judges + 2 roster judges + 1 enrich"
  );
  assert.equal(summarizeSkips(tally).skips_total, tally.errorsRecovered);
});

test("runSourcingPhase — the swallowed prompt-persist failure now carries its reason too", async () => {
  const tally = createChunkTally();
  const warn = console.warn;
  console.warn = () => {};
  try {
    await runSourcingPhase(
      { brand: "Acme", url: "acme.com", industry: "saas", competitors: "" },
      {
        promptTarget: 2,
        getPromptsForBrand: async () => [],
        generateUnbrandedPrompts: async () => makeQueries(2).map((q) => ({ ...q, weight: 1, enabled: true })),
        upsertPrompts: async () => {
          throw new Error("brand_prompts write refused");
        },
        buildBrandedQueries: () => [],
        resolveEnabledEngines: () => [{ name: "aio" }],
      },
      tally
    );
  } finally {
    console.warn = warn;
  }

  const skip = tally.skips.find((s) => s.reason === CHUNK_SKIP_REASONS.PROMPT_PERSIST_FAILED);
  assert.ok(skip, "next scan's prompt set silently failing to persist is a skip, not a success");
  assert.match(skip.sample[0], /brand_prompts write refused/);
});

// ---------------------------------------------------------------------------
// Aggregation: the count is exact even when the sample is not
// ---------------------------------------------------------------------------

test("recordSkip — many skips of one reason stay ONE entry, with an exact count and an honest sample", async () => {
  const ledger = makeLedger();
  const backend = makeBackend();
  const n = SKIP_SAMPLE_MAX + 4;
  const queries = makeQueries(n);
  const job = backend.seed({
    id: "70707070-7070-4070-8070-707070707070",
    status: "probing",
    checkpoint: makeCheckpoint(queries),
  });

  let i = 0;
  await runScanChunk(job.id, {
    ...backend.deps,
    ...ledger.deps,
    resolveEnabledEngines: () => [
      { name: "aio", concurrency: n, probe: async (q) => probeResult("aio", q, { error: `boom ${i++}` }) },
    ],
    extractCompetitors: async () => [],
  });

  const row = soleRow(ledger);
  const skip = skipEntry(row, CHUNK_SKIP_REASONS.PROBE_ERROR);
  assert.equal(skip.count, n, "the count is exact — a truncated sample must never truncate the count");
  assert.equal(skip.sample.length, SKIP_SAMPLE_MAX, "the sample is bounded so one bad engine cannot bloat the row");
  assert.equal(skip.sample_truncated, true, "…and a bounded sample must SAY it is bounded, not look complete");
  assert.equal(row.errors_recovered, n);
});

// ---------------------------------------------------------------------------
// R3.2.1's invariants, re-proved against the new writes
// ---------------------------------------------------------------------------

test("R3.2.1 STILL HOLDS — skips ride on the chunk's ONE row; they never become rows of their own", async () => {
  const ledger = makeLedger();
  const backend = makeBackend();
  const queries = makeQueries(3);
  const job = backend.seed({
    id: "80808080-8080-4080-8080-808080808080",
    status: "probing",
    checkpoint: makeCheckpoint(queries, ["aio", "perplexity"]),
  });

  const warn = console.warn;
  console.warn = () => {};
  try {
    await runScanChunk(job.id, {
      ...backend.deps,
      ...ledger.deps,
      resolveEnabledEngines: () => [
        { name: "aio", concurrency: 3, probe: async (q) => probeResult("aio", q, { error: "upstream 502" }) },
      ],
      extractCompetitors: async () => [],
    });
  } finally {
    console.warn = warn;
  }

  // One dropped engine + three errored probes = four recorded skips, one row.
  const row = soleRow(ledger);
  assert.equal(row.detail.skips_total, 4);
  assert.equal(ledger.rows.length, 1, "one row per chunk EXECUTION — R3.2.2 may not multiply rows");
});

test("R3.2.1 STILL HOLDS — sum(probes_attempted) counts each probe exactly once across a rescue", async () => {
  const ledger = makeLedger();
  const backend = makeBackend();
  const queries = makeQueries(4);
  const job = backend.seed({
    id: "90909090-9090-4090-8090-909090909090",
    status: "probing",
    checkpoint: makeCheckpoint(queries),
  });

  const engineDeps = {
    ...backend.deps,
    ...ledger.deps,
    resolveEnabledEngines: () => [
      { name: "aio", concurrency: 1, probe: async (q) => probeResult("aio", q, { error: "upstream 502" }) },
    ],
    extractCompetitors: async () => [],
  };

  await runScanChunk(job.id, { ...engineDeps, chunkBudgetMs: 0 });
  await runScanChunk(job.id, engineDeps);

  const attempted = ledger.rows.reduce((n, r) => n + r.probes_attempted, 0);
  assert.equal(attempted, queries.length, "the skip rows R3.2.2 adds must not re-count any probe");
  const skipTotal = ledger.rows.reduce((n, r) => n + r.detail.skips_total, 0);
  assert.equal(skipTotal, queries.length, "each errored probe is recorded once, on the row that ran it");
});

test("runScanChunk — a chunk that stops at the budget still reports skips_total 0: PROBING armed the watch", async () => {
  // Deliberately a chunk that never reaches finalize. Without this case the
  // probing arm is untestable: finalize arms the same list a few lines later,
  // so a chunk that runs both would look armed either way.
  const ledger = makeLedger();
  const backend = makeBackend();
  const job = backend.seed({
    id: "a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1",
    status: "probing",
    checkpoint: makeCheckpoint(makeQueries(4)),
  });

  const result = await runScanChunk(job.id, {
    ...backend.deps,
    ...ledger.deps,
    resolveEnabledEngines: () => [{ name: "aio", concurrency: 1, probe: async (q) => probeResult("aio", q) }],
    chunkBudgetMs: 0,
  });

  assert.equal(result.reason, "checkpointed", "it stopped inside probing, before finalize");
  const row = soleRow(ledger);
  assert.deepEqual(row.detail.phases_run, [CHUNK_PHASES.PROBING]);
  assert.equal(row.detail.skips_total, 0, "probing LOOKED for skips and found none — a measured zero");
  assert.notEqual(row.detail.skips_total, null);
});

test("each phase arms the skip watch on entry, so 'found none' never reads as 'never looked'", async () => {
  // Called directly, one phase at a time, because inside runScanChunk the
  // phases run back to back and any one of them arming would mask the rest.
  const backend = makeBackend();
  const queries = makeQueries(1);

  const sourcing = createChunkTally();
  await runSourcingPhase(
    { brand: "Acme", url: "acme.com", industry: "saas", competitors: "" },
    {
      promptTarget: 1,
      getPromptsForBrand: async () => [],
      generateUnbrandedPrompts: async () => queries.map((q) => ({ ...q, weight: 1, enabled: true })),
      upsertPrompts: async () => [],
      buildBrandedQueries: () => [],
      resolveEnabledEngines: () => [{ name: "aio" }],
    },
    sourcing
  );
  assert.deepEqual(sourcing.skips, [], "sourcing watches for the prompt-persist skip");

  const probing = createChunkTally();
  await runProbingPhase(
    "arm-probing",
    makeCheckpoint(queries),
    {
      ...backend.deps,
      resolveEnabledEngines: () => [{ name: "aio", concurrency: 1, probe: async (q) => probeResult("aio", q) }],
    },
    Date.now(),
    probing
  );
  assert.deepEqual(probing.skips, [], "probing watches for dropped engines and errored probes");

  const finalize = createChunkTally();
  const jobId = "arm-finalize";
  backend.seed({ id: jobId, status: "probing" });
  backend.promptResults.push({
    id: "pr-arm",
    job_id: jobId,
    engine: "aio",
    query: queries[0].text,
    is_branded_query: false,
    scan_id: null,
    raw: probeResult("aio", queries[0]),
  });
  await runFinalizePhase(
    jobId,
    makeCheckpoint(queries),
    { ...backend.deps, resolveEnabledEngines: () => [{ name: "aio", concurrency: 1 }], extractCompetitors: async () => [] },
    finalize
  );
  assert.deepEqual(finalize.skips, [], "finalize watches for the absorbed judge/enrich failures");

  // …and the chunk that entered none of them still says NOT MEASURED.
  assert.equal(createChunkTally().skips, null);
});

test("recordSkip — REFUSES a skip with no reason; it does not file an anonymous one", () => {
  // The whole task is "an unexplained skip must not exist". Accepting one here
  // would recreate it a level down: an entry that says something was skipped
  // and cannot say what for, which a reader rounds off to noise.
  const tally = createChunkTally();
  for (const bad of [undefined, null, "", "   "]) {
    assert.throws(
      () => recordSkip(tally, bad, "some subject"),
      /a skip with no reason/,
      `recordSkip must refuse ${JSON.stringify(bad)}`
    );
  }
  assert.equal(tally.skips, null, "and a refused skip must not arm the watch as a side effect");
});

// ===========================================================================
// CLASS 5 — R3.7.2: the website scrape that degraded and told only the log
// ===========================================================================
//
// Finding B7. The brand's own site is what grounds the unbranded prompt set. If
// Firecrawl is out of balance, or the site refuses the connection, the scrape
// degrades to a crude HTML strip or produces nothing at all — and the scan runs
// on, generates prompts from the brand name and industry alone, and finalizes
// with a headline that looks exactly like a scan that read the whole site.
//
// R3.7.2's first half stopped the sentinel string reaching a prompt and gave the
// scrape a state. Its second half is these tests: that state has to land ON THE
// SCAN. A console.warn was the ORIGINAL defect, so a differently-worded
// console.warn would have changed the wording of the failure and not the
// failure. The durable trace is `detail.skips` on the chunk's scan_runs row.
//
// Three cases have to stay apart, and every assertion below exists to hold one
// pair of them open:
//   * degraded/unavailable  — we looked at the site and did not get it;
//   * ok                    — we looked and got it (records NOTHING, so the
//                             reason cannot become always-on wallpaper);
//   * no scrape at all      — the tracked pool was reused, generation never ran,
//                             so there is no measurement to report either way.
// And inside the first: content_chars 0 ("we fetched, the page was blank") is
// not content_chars null ("we were handed no result to measure").

// R3.2.4: dynamic for the same reason as the imports above.
const { SCRAPE_STATE } = await import("../firecrawl.js");

/** What promptGen writes onto `stats` when the vendor 402s and the strip stands in. */
const DEGRADED_SCRAPE = Object.freeze({
  state: SCRAPE_STATE.DEGRADED,
  state_reason: "firecrawl_http_error",
  reasons: ["firecrawl_http_error"],
  detail: "402",
  source: "fallback_fetch",
  content_chars: 812,
});

/**
 * Sourcing deps whose GENERATION step writes `websiteScrape` onto the stats
 * accumulator — which is exactly, and only, what promptGen does with the object
 * it is handed. Pass `undefined` for "generation never touched it".
 */
function scrapingSourcingDeps(queries, websiteScrape) {
  return {
    ...sourcingDeps(queries),
    resolveEnabledEngines: () => [{ name: "aio" }],
    generateUnbrandedPrompts: async (brand, url, industry, stats) => {
      if (websiteScrape !== undefined) stats.website_scrape = websiteScrape;
      return queries.map((q) => ({ ...q, weight: 1, enabled: true }));
    },
  };
}

/** runSourcingPhase with console.warn muted, returning [checkpoint, tally]. */
async function sourceQuietly(deps) {
  const tally = createChunkTally();
  const warn = console.warn;
  console.warn = () => {};
  try {
    const checkpoint = await runSourcingPhase(
      { brand: "Acme", url: "acme.com", industry: "saas", competitors: "" },
      deps,
      tally
    );
    return [checkpoint, tally];
  } finally {
    console.warn = warn;
  }
}

test("runSourcingPhase — a degraded website scrape is RECORDED, not only warned about", async () => {
  const queries = makeQueries(2);
  const [checkpoint, tally] = await sourceQuietly(scrapingSourcingDeps(queries, DEGRADED_SCRAPE));

  const skip = tally.skips.find((s) => s.reason === CHUNK_SKIP_REASONS.WEBSITE_SCRAPE_DEGRADED);
  assert.ok(
    skip,
    "the site was never read and the prompt set says otherwise — a console line is not a record of that"
  );
  assert.equal(skip.count, 1);
  assert.ok(
    skip.sample[0].includes("firecrawl_http_error"),
    `the row must carry the state_reason, not just "something degraded"; got ${JSON.stringify(skip.sample)}`
  );
  assert.ok(
    skip.sample[0].includes(SCRAPE_STATE.DEGRADED),
    "…and the state, because degraded and unavailable are different outcomes"
  );
  assert.ok(skip.sample[0].includes("812"), "…and how much content we actually had");

  // The scan is otherwise entirely normal. That is precisely why this was
  // invisible: nothing else about the chunk looks different.
  assert.equal(checkpoint.queries.length, 2);
});

test("runSourcingPhase — a healthy scrape records NOTHING, so the reason is not always-on", async () => {
  const queries = makeQueries(2);
  const [, tally] = await sourceQuietly(
    scrapingSourcingDeps(queries, {
      state: SCRAPE_STATE.OK,
      state_reason: null,
      reasons: [],
      detail: null,
      source: "firecrawl",
      content_chars: 41230,
    })
  );

  assert.deepEqual(
    tally.skips,
    [],
    "a reason recorded on every scan is a reason nobody reads — MEASURED zero, and empty"
  );
  assert.equal(summarizeSkips(tally).skips_total, 0);
});

test("runSourcingPhase — a scan that never scraped is NOT reported as a degrade", async () => {
  // sourceUnbrandedQueries returns straight out of the tracked pool when it is
  // already at target, so generation — and therefore the scrape — never runs.
  // `stats.website_scrape` is then absent, and a bare `state !== "ok"` test
  // would file a degrade for a measurement that was never taken: the same lie
  // as reporting 0 for something nobody counted, pointing the other way.
  const queries = makeQueries(2);
  const [, tally] = await sourceQuietly(scrapingSourcingDeps(queries, undefined));

  assert.deepEqual(
    tally.skips,
    [],
    "no scrape was attempted; claiming one degraded would invent a measurement"
  );
});

test("runSourcingPhase — a measured-zero scrape and an UNMEASURED one read differently", async () => {
  const base = { state: SCRAPE_STATE.UNAVAILABLE, reasons: [], detail: null, source: null };

  const [, measured] = await sourceQuietly(
    scrapingSourcingDeps(makeQueries(1), {
      ...base,
      state_reason: "fallback_empty_body",
      content_chars: 0, // we fetched the page and it was blank
    })
  );
  const [, unmeasured] = await sourceQuietly(
    scrapingSourcingDeps(makeQueries(1), {
      ...base,
      state_reason: "no_scrape_result",
      content_chars: null, // there was no result to measure at all
    })
  );

  const zero = measured.skips.find((s) => s.reason === CHUNK_SKIP_REASONS.WEBSITE_SCRAPE_DEGRADED).sample[0];
  const none = unmeasured.skips.find((s) => s.reason === CHUNK_SKIP_REASONS.WEBSITE_SCRAPE_DEGRADED).sample[0];

  assert.ok(zero.includes("chars=0"), `a blank page is a measured zero; got ${zero}`);
  assert.ok(
    none.includes("not_measured"),
    `an unmeasured scrape must not be written down as 0 chars (standing rule 5); got ${none}`
  );
  assert.notEqual(zero, none, "collapsing these two is exactly the `?? 0` this rule forbids");
});

test("runScanChunk — the degrade is on the CLOSED scan_runs row, under a SUCCEEDED outcome", async () => {
  const ledger = makeLedger();
  const backend = makeBackend();
  const queries = makeQueries(2);
  const job = backend.seed({ id: "70707070-7070-4070-8070-707070707070", status: "pending" });

  const warn = console.warn;
  console.warn = () => {};
  let result;
  try {
    result = await runScanChunk(job.id, {
      ...backend.deps,
      ...ledger.deps,
      ...scrapingSourcingDeps(queries, DEGRADED_SCRAPE),
      resolveEnabledEngines: () => [
        { name: "aio", concurrency: 2, probe: async (q) => probeResult("aio", q) },
      ],
      extractCompetitors: async () => [],
    });
  } finally {
    console.warn = warn;
  }

  assert.equal(result.reason, "complete", "the scan finishes clean — that is why this needed a row");
  const row = soleRow(ledger);
  assert.equal(row.outcome, RUN_OUTCOMES.SUCCEEDED, "and it SUCCEEDS; the row must still say what it lost");

  const skip = skipEntry(row, CHUNK_SKIP_REASONS.WEBSITE_SCRAPE_DEGRADED);
  assert.ok(
    skip,
    `no website_scrape_degraded on the closed row; got ${JSON.stringify(row.detail && row.detail.skips)}`
  );
  assert.equal(skip.count, 1);
  assert.ok(
    skip.sample[0].includes("firecrawl_http_error"),
    `the durable row must carry the state_reason; got ${JSON.stringify(skip.sample)}`
  );
  assert.ok(row.detail.skips_total >= 1);
});

test("runScanChunk — a chunk whose scrape was healthy closes with no degrade on the row", async () => {
  const ledger = makeLedger();
  const backend = makeBackend();
  const queries = makeQueries(2);
  const job = backend.seed({ id: "80808080-8080-4080-8080-808080808080", status: "pending" });

  await runScanChunk(job.id, {
    ...backend.deps,
    ...ledger.deps,
    ...scrapingSourcingDeps(queries, {
      state: SCRAPE_STATE.OK,
      state_reason: null,
      reasons: [],
      detail: null,
      source: "firecrawl",
      content_chars: 41230,
    }),
    resolveEnabledEngines: () => [
      { name: "aio", concurrency: 2, probe: async (q) => probeResult("aio", q) },
    ],
    extractCompetitors: async () => [],
  });

  const row = soleRow(ledger);
  assert.equal(
    skipEntry(row, CHUNK_SKIP_REASONS.WEBSITE_SCRAPE_DEGRADED),
    undefined,
    "a healthy read must leave the row clean, or the reason means nothing when it appears"
  );
  assert.deepEqual(row.detail.skips, [], "…and it is a MEASURED empty, not a null");
});

test("runSourcingPhase — the scrape state is frozen onto the checkpoint, so a resume can still see it", async () => {
  const [checkpoint] = await sourceQuietly(scrapingSourcingDeps(makeQueries(2), DEGRADED_SCRAPE));
  assert.deepEqual(
    checkpoint.stats.website_scrape,
    DEGRADED_SCRAPE,
    "the checkpoint used to keep only { cost, tokens }, which dropped this on the floor"
  );
  assert.equal(checkpoint.stats.cost, 0, "and cost/tokens are unchanged alongside it");
});

test("runProbingPhase — the per-batch checkpoint rebuild does not ERASE the scrape state", async () => {
  // The rebuild after every persisted batch was a fresh { cost, tokens }
  // literal. It therefore deleted the sourcing phase's website_scrape from the
  // checkpoint on the first batch — so the fact survived sourcing and died at
  // the first resume boundary, which is the only boundary that matters.
  const backend = makeBackend();
  const queries = makeQueries(2);
  const jobId = "90909090-9090-4090-8090-909090909090";
  backend.seed({ id: jobId, status: "probing" });

  const checkpoint = {
    ...makeCheckpoint(queries),
    stats: { cost: 0, tokens: 0, website_scrape: DEGRADED_SCRAPE },
  };

  const outcome = await runProbingPhase(
    jobId,
    checkpoint,
    {
      ...backend.deps,
      resolveEnabledEngines: () => [
        { name: "aio", concurrency: 2, probe: async (q) => probeResult("aio", q) },
      ],
    },
    Date.now(),
    createChunkTally()
  );

  assert.deepEqual(outcome.checkpoint.stats.website_scrape, DEGRADED_SCRAPE);
  assert.deepEqual(
    backend.jobs.get(jobId).checkpoint.stats.website_scrape,
    DEGRADED_SCRAPE,
    "and the checkpoint actually PERSISTED to scan_jobs keeps it, which is what a resume reads"
  );
});

// ---------------------------------------------------------------------------
// GUARD — a reason constant nobody records is a site that went unledgered
// ---------------------------------------------------------------------------

test("GUARD — every declared skip reason is actually recorded somewhere in scanWorker.js", async () => {
  // The failure mode this catches: someone adds a reason to the vocabulary,
  // means to wire it, and never does. The constant then looks like coverage
  // that does not exist — the same shape of false success as the skips
  // themselves.
  const { readFile } = await import("node:fs/promises");
  const src = await readFile(new URL("./scanWorker.js", import.meta.url), "utf8");

  for (const [key, value] of Object.entries(CHUNK_SKIP_REASONS)) {
    // The reason may be passed directly as CHUNK_SKIP_REASONS.KEY or indirectly
    // via a variable that was assigned from CHUNK_SKIP_REASONS.KEY earlier in the
    // same function scope. Check for both patterns.
    const directPattern = new RegExp(`recordSkip\\([^;]*?CHUNK_SKIP_REASONS\\.${key}\\b`, "s");
    const indirectPattern = new RegExp(`CHUNK_SKIP_REASONS\\.${key}\\s*=`, "s");
    assert.ok(
      directPattern.test(src) || indirectPattern.test(src),
      `CHUNK_SKIP_REASONS.${key} ("${value}") is declared but never passed to recordSkip — ` +
        `a reason nobody records is a skip site that is still invisible`
    );
  }
  for (const [key, value] of Object.entries(SCHEDULER_SKIP_REASONS)) {
    assert.match(
      src,
      new RegExp(`reason: SCHEDULER_SKIP_REASONS\\.${key}\\b`),
      `SCHEDULER_SKIP_REASONS.${key} ("${value}") is declared but never used to close a run`
    );
  }
});

test("GUARD — every way resolveEnabledEngines can drop an engine has a reason of its own", async () => {
  // The loop above proves each DECLARED reason is recorded. This proves the
  // other direction for the engine layer: each way the resolver can discard an
  // engine has a distinct chunk reason mapped to it. Without this, a fourth drop
  // site could be added to enginePipeline and arrive at the ledger under
  // ENGINE_SKIP_UNMAPPED — recorded, but not named.
  const kinds = Object.values(ENGINE_RESOLUTION_SKIPS);
  assert.ok(kinds.length >= 3, "the resolver has three discard sites: unknown, keyless, whole-set default");

  const mapped = new Set();
  for (const kind of kinds) {
    const tally = createChunkTally();
    recordEngineResolutionSkip(tally, kind, "somengine");
    assert.equal(tally.skips.length, 1, `kind "${kind}" recorded nothing`);
    const reason = tally.skips[0].reason;
    assert.notEqual(
      reason,
      CHUNK_SKIP_REASONS.ENGINE_SKIP_UNMAPPED,
      `resolveEnabledEngines can emit "${kind}" and scanWorker has no reason for it — ` +
        `add one to CHUNK_SKIP_REASONS rather than letting it land as unmapped`
    );
    assert.ok(!mapped.has(reason), `two resolver kinds share the reason "${reason}" — that collapses a distinction`);
    mapped.add(reason);
    assert.deepEqual(tally.skips[0].sample, ["somengine"], "the subject must be the engine name");
  }

  // And the catch-all itself still records rather than dropping, so an unmapped
  // kind is visible in the ledger instead of silently discarded.
  const stray = createChunkTally();
  recordEngineResolutionSkip(stray, "a_kind_from_the_future", "somengine");
  assert.equal(stray.skips[0].reason, CHUNK_SKIP_REASONS.ENGINE_SKIP_UNMAPPED);
});
