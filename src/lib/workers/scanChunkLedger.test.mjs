import test from "node:test";
import assert from "node:assert/strict";
import {
  runScanChunk,
  runSourcingPhase,
  runProbingPhase,
  chunkRunOutcome,
  createChunkTally,
  resolveEntryPhase,
  CHUNK_PHASES,
  CHUNK_RUN_HEARTBEAT_MS,
  CHUNK_TIME_BUDGET_MS,
} from "./scanWorker.js";
import { RUN_OUTCOMES, RUNNERS } from "../scanRuns.js";

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
