import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
/**
 * R3.2.4 — this suite's claim to be hermetic is now enforced, not asserted.
 *
 * The header below used to say "no fetch, no client, no env", and it was only
 * true while NEXT_PUBLIC_SUPABASE_URL / _ANON_KEY were unset in the shell. With
 * credentials loaded — which src/server/liveDbGate.js tells live-test authors to
 * do — the eleven cases that call runScanChunk without ledger deps opened REAL
 * scan_runs rows and one charged a REAL attempt through claim_scan_job_attempt
 * against production scan_jobs.
 *
 * Clearing the credentials before the module graph is evaluated makes db.js's
 * client null however this suite is invoked. The imports have to be dynamic:
 * static ones are hoisted above these two deletes, and scanWorker.js's import
 * of db.js would capture the credentials first.
 */
delete process.env.NEXT_PUBLIC_SUPABASE_URL;
delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

const {
  runScanChunk,
  chunkRunOutcome,
  createChunkTally,
  attemptVerdict,
  maxAttemptsMessage,
  MAX_JOB_ATTEMPTS,
  MAX_ATTEMPTS_MARKER,
  CHUNK_PHASES,
} = await import("./scanWorker.js");
const { RUN_OUTCOMES, RUNNERS } = await import("../scanRuns.js");
const { HEARTBEAT_STALE_MS, supabase } = await import("../db.js");

assert.equal(
  supabase,
  null,
  "db.js still has a client: the credential clearing above did not take effect, and the cases " +
    "below would open real scan_runs rows and charge real scan_jobs attempts"
);

/**
 * R3.3.1 — scan_jobs.attempts and the cap of 3 (finding S12).
 *
 * The failure this covers: /api/scan/worker's sweep re-dispatches every
 * non-terminal job whose heartbeat has gone stale, and nothing counted how many
 * times it had already done so. A job whose worker dies at the same point every
 * time was resumed forever — every cron tick, every day, on real vendor budget.
 *
 * Everything here runs against in-memory fakes. There is NO Supabase client in
 * this suite (R3.2.4 clears the credentials above, whatever the shell holds),
 * so scanWorker's own `supabase` is null and the memory path executes; the RPC path
 * is exercised through an injected `deps.client` whose `rpc` is a local
 * function. Nothing in this file can read or write a live backend: no fetch, no
 * client, no env.
 */

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const MIGRATION = "supabase/migrations/012_scan_job_attempts.sql";

const STALE = () => new Date(Date.now() - HEARTBEAT_STALE_MS - 60_000).toISOString();
const FRESH = () => new Date().toISOString();

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

/** A job store with db.js's contract: updateScanJob stamps heartbeat_at. */
function makeJobs() {
  const jobs = new Map();
  const calls = { updateScanJob: [], selfContinue: [] };

  const seed = (job) => {
    const row = {
      id: job.id || "11111111-1111-4111-8111-111111111111",
      brand: "Acme",
      url: "acme.com",
      industry: "saas",
      competitors: "",
      status: "pending",
      progress_pct: 0,
      checkpoint: null,
      attempts: 0,
      error_message: null,
      heartbeat_at: STALE(),
      ...job,
    };
    jobs.set(row.id, row);
    return row;
  };

  const deps = {
    getScanJob: async (id) => jobs.get(id) || null,
    updateScanJob: async (id, updates) => {
      const job = jobs.get(id) || { id };
      Object.assign(job, updates, { heartbeat_at: FRESH() });
      jobs.set(id, job);
      calls.updateScanJob.push({ id, updates });
      return job;
    },
    claimJobStatus: async (id, fromStatus, toStatus) => {
      const list = Array.isArray(fromStatus) ? fromStatus : [fromStatus];
      const job = jobs.get(id);
      if (!job) return null;
      if (!list.includes(job.status)) return null;
      Object.assign(job, { status: toStatus, heartbeat_at: FRESH() });
      return job;
    },
    selfContinue: (id) => calls.selfContinue.push(id),
  };

  return { jobs, calls, deps, seed };
}

/** The scan_runs ledger, enough of migration 011's constraints to be worth asserting on. */
function makeLedger() {
  const rows = [];
  let n = 0;
  return {
    rows,
    deps: {
      openScanRun: async (fields) => {
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
          error: null,
          ended_at: null,
        };
        rows.push(row);
        return { ...toRun(row), open: true };
      },
      heartbeatScanRun: async ({ runId }) => ({ runId, heartbeatAt: FRESH() }),
      closeScanRun: async (fields) => {
        const row = rows.find((r) => r.id === fields.runId);
        if (!row) throw new Error(`close_scan_run: no run ${fields.runId}`);
        if (row.ended_at) throw new Error(`close_scan_run: run ${row.id} already closed`);
        assert.ok(
          ["succeeded", "failed", "skipped", "reaped", "noop"].includes(fields.outcome),
          `close: "${fields.outcome}" is outside scan_runs_outcome_chk`
        );
        if (fields.outcome !== "succeeded") {
          assert.ok(String(fields.reason ?? "").trim(), "close: a non-success needs a reason");
        }
        row.outcome = fields.outcome;
        row.reason = fields.reason ?? null;
        row.error = fields.error ?? null;
        row.detail = { ...(row.detail || {}), ...(fields.detail || {}) };
        row.ended_at = FRESH();
        return { ...toRun(row), open: false };
      },
    },
  };
}

function toRun(row) {
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
    probesAttempted: null,
    probesSucceeded: null,
    errorsRecovered: null,
    error: row.error,
    detail: row.detail,
    startedAt: FRESH(),
    heartbeatAt: FRESH(),
    endedAt: row.ended_at,
  };
}

const soleRow = (ledger) => {
  assert.equal(ledger.rows.length, 1, `expected exactly one scan_runs row, got ${ledger.rows.length}`);
  return ledger.rows[0];
};

// ---------------------------------------------------------------------------
// The policy, as a pure function
// ---------------------------------------------------------------------------

test("attemptVerdict — three attempts are granted and the fourth is refused", () => {
  assert.deepEqual(attemptVerdict({ attempts: 0 }), {
    granted: true,
    verdict: "granted",
    attempts: 1,
    maxAttempts: 3,
  });
  assert.equal(attemptVerdict({ attempts: 1 }).attempts, 2);
  assert.equal(attemptVerdict({ attempts: 2 }).attempts, 3, "the third attempt still runs");

  const refused = attemptVerdict({ attempts: 3 });
  assert.equal(refused.granted, false);
  assert.equal(refused.verdict, "max_attempts");
  assert.equal(refused.attempts, 3, "the count it died on, not the count it would have been");
});

test("attemptVerdict — a row that has somehow overshot the cap stays refused, never wraps", () => {
  const refused = attemptVerdict({ attempts: 9 });
  assert.equal(refused.granted, false);
  assert.equal(refused.verdict, "max_attempts");
  assert.equal(refused.attempts, 9);
});

test("attemptVerdict — a job with no attempts column yet is on its FIRST attempt, not its last", () => {
  // 012 lands on rows that predate it. Reading a missing counter as "unknown,
  // therefore refuse" would abandon every in-flight scan the moment it applies.
  assert.equal(attemptVerdict({}).attempts, 1);
  assert.equal(attemptVerdict({ attempts: null }).attempts, 1);
  assert.equal(attemptVerdict({ attempts: -4 }).attempts, 1);
  assert.equal(attemptVerdict({ attempts: "2" }).attempts, 1, "a string is not a count");
});

test("attemptVerdict — the cap is a parameter, and a nonsense cap falls back to the constant", () => {
  assert.equal(attemptVerdict({ attempts: 0 }, 1).granted, true);
  assert.equal(attemptVerdict({ attempts: 1 }, 1).granted, false);
  assert.equal(attemptVerdict({ attempts: 3 }, 0).maxAttempts, MAX_JOB_ATTEMPTS, "0 is not a cap");
  assert.equal(attemptVerdict({ attempts: 3 }, null).granted, false);
});

test("maxAttemptsMessage — the terminal state carries a reason a human can read", () => {
  const job = { status: "probing", heartbeat_at: "2026-09-01T00:00:00.000Z", error_message: "brightdata 502" };
  const message = maxAttemptsMessage(job, attemptVerdict({ attempts: 3 }), "2026-09-05T10:00:00.000Z");

  assert.ok(message.startsWith(MAX_ATTEMPTS_MARKER), "the marker is what makes abandonment greppable");
  assert.match(message, /after 3 resume attempt\(s\)/);
  assert.match(message, /cap 3/);
  assert.match(message, /"probing"/, "it must name the status it died in");
  assert.match(message, /brightdata 502/, "the last error it managed to record is not thrown away");
});

// ---------------------------------------------------------------------------
// The ledger mapping
// ---------------------------------------------------------------------------

test("chunkRunOutcome — max_attempts closes FAILED with the counts, never skipped and never succeeded", () => {
  const closed = chunkRunOutcome(
    { ok: false, reason: "max_attempts", attempts: 3, max_attempts: 3, error: "max_attempts: abandoned" },
    createChunkTally()
  );
  assert.equal(closed.outcome, RUN_OUTCOMES.FAILED, "an abandoned customer scan is not a routine skip");
  assert.equal(closed.reason, "max_attempts");
  assert.equal(closed.error, "max_attempts: abandoned");
  assert.equal(closed.detail.attempts, 3);
  assert.equal(closed.detail.max_attempts, 3);
});

test("chunkRunOutcome — an unreported attempt count is NULL in the ledger, never 0", () => {
  const closed = chunkRunOutcome({ ok: false, reason: "max_attempts" }, createChunkTally());
  assert.equal(closed.detail.attempts, null, "'abandoned on attempt 0' would be a lie about the cap");
  assert.equal(closed.detail.max_attempts, null);
});

test("chunkRunOutcome — a claim that could not be made closes FAILED, with the error kept", () => {
  const closed = chunkRunOutcome(
    { ok: false, reason: "attempt_claim_failed", error: 'column "attempts" does not exist [42703]' },
    createChunkTally()
  );
  assert.equal(closed.outcome, RUN_OUTCOMES.FAILED);
  assert.equal(closed.reason, "attempt_claim_failed");
  assert.match(closed.error, /42703/);
});

// ---------------------------------------------------------------------------
// runScanChunk — who pays an attempt, and who does not
// ---------------------------------------------------------------------------

test("a resumed job spends an attempt: the counter is durable, not derived", async () => {
  const backend = makeJobs();
  const job = backend.seed({ status: "generating_prompts", checkpoint: { queries: [] }, heartbeat_at: STALE() });

  const result = await runScanChunk(job.id, backend.deps);

  assert.equal(result.reason, "noop", "the wedge itself is unchanged — only the counting is new");
  assert.equal(job.attempts, 1, "the attempt is persisted on the row, not held in a stack frame");
});

test("a clean hand-off is FREE: a chunk resuming itself on a fresh heartbeat spends nothing", async () => {
  // The self-continue fetch after a checkpoint is a different event from a
  // rescue. Charging it would cap the SIZE of a scan at three slices — a
  // 60-pair scan needs more chunks than that and would die half-probed.
  const backend = makeJobs();
  const job = backend.seed({ status: "generating_prompts", checkpoint: { queries: [] }, heartbeat_at: FRESH() });

  const result = await runScanChunk(job.id, backend.deps);

  assert.equal(result.reason, "noop");
  assert.equal(job.attempts, 0, "a live job's own continuation is not a retry");
});

test("THE CAP — a job resumed three times without finishing is terminal on the fourth, and says why", async () => {
  const backend = makeJobs();
  const job = backend.seed({
    status: "generating_prompts",
    checkpoint: { queries: [] },
    heartbeat_at: STALE(),
  });

  // Three cron ticks. Each one finds the job stale (nothing finished it, and
  // nothing was left alive to mark it failed — the S12 shape) and resumes it.
  for (let tick = 1; tick <= MAX_JOB_ATTEMPTS; tick++) {
    job.heartbeat_at = STALE();
    const result = await runScanChunk(job.id, backend.deps);
    assert.equal(result.reason, "noop", `tick ${tick} must still be allowed to run`);
    assert.equal(job.attempts, tick);
    assert.equal(job.status, "generating_prompts", `tick ${tick} must not be terminal yet`);
  }

  // The fourth is refused.
  job.heartbeat_at = STALE();
  const capped = await runScanChunk(job.id, backend.deps);

  assert.equal(capped.ok, false);
  assert.equal(capped.reason, "max_attempts");
  assert.equal(capped.attempts, 3);
  assert.equal(capped.max_attempts, 3);

  // Terminal, and terminal OUT LOUD: a job that silently stopped being retried
  // would be indistinguishable from one still being worked.
  assert.equal(job.status, "failed");
  assert.equal(job.progress_pct, 100);
  assert.ok(job.error_message.startsWith(MAX_ATTEMPTS_MARKER), job.error_message);
  assert.match(job.error_message, /after 3 resume attempt\(s\)/);
});

test("THE CAP — and it stops being retried: the next sweep finds a finished job and does no work", async () => {
  const backend = makeJobs();
  const job = backend.seed({ status: "generating_prompts", checkpoint: { queries: [] }, attempts: 3 });

  const capped = await runScanChunk(job.id, backend.deps);
  assert.equal(capped.reason, "max_attempts");
  assert.equal(job.status, "failed");

  const writesBefore = backend.calls.updateScanJob.length;

  // shouldRescueJob is false for a failed job, so the sweep never dispatches
  // this again; a direct ?job_id= hit still cannot make it run.
  job.heartbeat_at = STALE();
  const after = await runScanChunk(job.id, backend.deps);

  assert.deepEqual(after, { ok: true, reason: "already_finished", status: "failed" });
  assert.equal(job.attempts, 3, "a terminal job's counter never moves again");
  assert.equal(
    backend.calls.updateScanJob.length,
    writesBefore,
    "and nothing writes to it — the retry loop is over, not merely quieter"
  );
});

test("THE CAP — the abandonment is on the ledger as FAILED, with the attempt it died on", async () => {
  const backend = makeJobs();
  const ledger = makeLedger();
  const job = backend.seed({
    id: "22222222-2222-4222-8222-222222222222",
    status: "probing",
    checkpoint: { queries: [] },
    attempts: 3,
  });

  const result = await runScanChunk(job.id, { ...backend.deps, ...ledger.deps });
  assert.equal(result.reason, "max_attempts");

  const row = soleRow(ledger);
  assert.equal(row.runner, RUNNERS.SCAN_CHUNK);
  assert.equal(row.phase, CHUNK_PHASES.PROBING, "it entered on the probing path, where it kept dying");
  assert.equal(row.outcome, RUN_OUTCOMES.FAILED);
  assert.equal(row.reason, "max_attempts");
  assert.equal(row.detail.attempts, 3);
  assert.equal(row.detail.max_attempts, 3);
  assert.ok(String(row.error).startsWith(MAX_ATTEMPTS_MARKER), row.error);
});

test("progress RESETS the counter, so a long scan is not capped for being long", async () => {
  const backend = makeJobs();
  const queries = [
    { text: "unbranded query one", source: "llm_generated", topic: "General", intent_tier: "informational" },
    { text: "unbranded query two", source: "llm_generated", topic: "General", intent_tier: "informational" },
  ];
  const job = backend.seed({
    id: "33333333-3333-4333-8333-333333333333",
    status: "probing",
    heartbeat_at: STALE(),
    attempts: 2, // two dead resumes already on the clock
    checkpoint: {
      brand: "Acme",
      url: "acme.com",
      competitors: "",
      prompt_key: "acme.com",
      queries,
      engines: ["aio"],
      stats: { cost: 0, tokens: 0 },
    },
  });

  const persisted = [];
  const engine = {
    name: "aio",
    concurrency: 1,
    probe: async (query) => ({
      engine: "aio",
      prompt: query.text,
      answer_present: true,
      brand_mentioned_in_text: false,
      brand_cited: false,
      intent_tier: "informational",
      is_branded_query: false,
      text: "an answer",
      brands: [],
      references: [],
    }),
  };

  const result = await runScanChunk(job.id, {
    ...backend.deps,
    resolveEnabledEngines: () => [engine],
    getCompletedPairsForJob: async () => new Set(),
    upsertPromptResults: async (rows) => {
      persisted.push(...rows);
      return rows;
    },
    chunkBudgetMs: 0, // yield after the first batch, exactly as a long scan does
  });

  assert.equal(result.reason, "checkpointed");
  assert.ok(persisted.length >= 1, "the batch really landed — this is what 'progress' means here");
  assert.equal(
    job.attempts,
    0,
    "durable progress clears the consecutive-failure count; without this a scan whose " +
      "self-continue cannot reach itself dies at three slices despite probing all the way through"
  );
});

test("the reset is written by the batch that landed, in that same UPDATE", async () => {
  // Placement matters: a reset written before anything was persisted would hand
  // a poison job an unlimited supply of attempts.
  const raw = await readFile(new URL("./scanWorker.js", import.meta.url), "utf8");
  // Comments talk about the reset; only the code performs it.
  const src = raw.replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");
  const resets = [...src.matchAll(/attempts: 0/g)];
  assert.equal(resets.length, 1, "there must be exactly one place that clears the counter");
  const window = src.slice(Math.max(0, resets[0].index - 400), resets[0].index + 200);
  assert.match(window, /progress_pct: progressPct/);
  assert.match(window, /checkpoint: workingCheckpoint/);
});

// ---------------------------------------------------------------------------
// The SQL path: migration 012's claim_scan_job_attempt over RPC
// ---------------------------------------------------------------------------

function makeRpcClient(handler) {
  const calls = [];
  return {
    calls,
    client: {
      rpc: async (fn, params) => {
        calls.push({ fn, params });
        return handler(fn, params);
      },
    },
  };
}

test("with a database the claim is ONE atomic RPC, called with the job and the cap", async () => {
  const backend = makeJobs();
  const job = backend.seed({ status: "generating_prompts", checkpoint: { queries: [] }, heartbeat_at: STALE() });
  const rpc = makeRpcClient(() => ({
    data: { granted: true, verdict: "granted", attempts: 2, max_attempts: 3, status: "generating_prompts" },
    error: null,
  }));

  const result = await runScanChunk(job.id, { ...backend.deps, client: rpc.client });

  assert.equal(result.reason, "noop");
  assert.equal(rpc.calls.length, 1, "read-then-increment from JS is a lost update; there is one statement");
  assert.equal(rpc.calls[0].fn, "claim_scan_job_attempt");
  assert.deepEqual(rpc.calls[0].params, { p_job_id: job.id, p_max_attempts: MAX_JOB_ATTEMPTS });
  assert.equal(
    backend.calls.updateScanJob.length,
    0,
    "the SQL owns the increment — JS must not write the counter a second time"
  );
});

test("with a database, the SQL's refusal is obeyed and the chunk does not run", async () => {
  const backend = makeJobs();
  const ledger = makeLedger();
  const probes = [];
  const job = backend.seed({
    id: "44444444-4444-4444-8444-444444444444",
    status: "probing",
    heartbeat_at: STALE(),
    checkpoint: { brand: "Acme", url: "acme.com", competitors: "", prompt_key: "acme.com", queries: [], engines: ["aio"] },
  });
  const rpc = makeRpcClient(() => ({
    data: {
      granted: false,
      verdict: "max_attempts",
      attempts: 3,
      max_attempts: 3,
      status: "failed",
      error_message: `${MAX_ATTEMPTS_MARKER} abandoned at 2026-09-05T10:00:00Z after 3 resume attempt(s) (cap 3).`,
    },
    error: null,
  }));

  const result = await runScanChunk(job.id, {
    ...backend.deps,
    ...ledger.deps,
    client: rpc.client,
    resolveEnabledEngines: () => [
      { name: "aio", concurrency: 1, probe: async (q) => probes.push(q) || {} },
    ],
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "max_attempts");
  assert.equal(result.attempts, 3);
  assert.equal(probes.length, 0, "a refused attempt must not spend a rupee of vendor budget");
  assert.equal(soleRow(ledger).outcome, RUN_OUTCOMES.FAILED);
});

test("a claim that errors REFUSES the chunk and keeps the error envelope", async () => {
  const backend = makeJobs();
  const probes = [];
  const job = backend.seed({
    status: "probing",
    heartbeat_at: STALE(),
    checkpoint: { brand: "Acme", url: "acme.com", competitors: "", prompt_key: "acme.com", queries: [], engines: ["aio"] },
  });
  const rpc = makeRpcClient(() => ({
    data: null,
    error: { message: 'column "attempts" does not exist', code: "42703", hint: "apply migration 012" },
  }));

  const result = await runScanChunk(job.id, {
    ...backend.deps,
    client: rpc.client,
    resolveEnabledEngines: () => [
      { name: "aio", concurrency: 1, probe: async (q) => probes.push(q) || {} },
    ],
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "attempt_claim_failed");
  assert.match(result.error, /42703/, "the PostgREST envelope survives (standing rule 2)");
  assert.match(result.error, /migration 012/);
  assert.equal(probes.length, 0, "the cap is the only thing stopping a poison job; unenforced means it does not run");
});

test("a verdict that does not say `granted` is refused, never assumed", async () => {
  const backend = makeJobs();
  const job = backend.seed({ status: "generating_prompts", checkpoint: { queries: [] }, heartbeat_at: STALE() });
  const rpc = makeRpcClient(() => ({ data: { attempts: 1 }, error: null }));

  const result = await runScanChunk(job.id, { ...backend.deps, client: rpc.client });

  assert.equal(result.reason, "attempt_claim_failed");
  assert.match(result.error, /no verdict/);
});

test("a job that finished under the claim is already_finished, not an abandonment", async () => {
  const backend = makeJobs();
  const job = backend.seed({ status: "probing", heartbeat_at: STALE(), checkpoint: { queries: [] } });
  const rpc = makeRpcClient(() => ({
    data: { granted: false, verdict: "already_finished", attempts: 1, max_attempts: 3, status: "complete" },
    error: null,
  }));

  const result = await runScanChunk(job.id, { ...backend.deps, client: rpc.client });
  assert.deepEqual(result, { ok: true, reason: "already_finished", status: "complete" });
});

test("an unrecognised refusal is a claim failure, never rounded down to 'nothing to do'", async () => {
  const backend = makeJobs();
  const job = backend.seed({ status: "probing", heartbeat_at: STALE(), checkpoint: { queries: [] } });
  const rpc = makeRpcClient(() => ({
    data: { granted: false, verdict: "quarantined", attempts: 1, max_attempts: 3 },
    error: null,
  }));

  const result = await runScanChunk(job.id, { ...backend.deps, client: rpc.client });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "attempt_claim_failed");
  assert.match(result.error, /quarantined/, "the verdict it could not read must be named");
});

test("a job deleted under the claim is not_found, and does not read as a failure of the cap", async () => {
  const backend = makeJobs();
  const job = backend.seed({ status: "probing", heartbeat_at: STALE(), checkpoint: { queries: [] } });
  const rpc = makeRpcClient(() => ({
    data: { granted: false, verdict: "not_found", attempts: null, max_attempts: 3 },
    error: null,
  }));

  const result = await runScanChunk(job.id, { ...backend.deps, client: rpc.client });
  assert.deepEqual(result, { ok: false, reason: "not_found" });
});

// ---------------------------------------------------------------------------
// GUARDS — the migration and the constant are one number
// ---------------------------------------------------------------------------

test("GUARD — migration 012 adds the column, the constraint and the claim, idempotently", async () => {
  const sql = await readFile(path.join(REPO, MIGRATION), "utf8");

  assert.match(
    sql,
    /ALTER TABLE scan_jobs ADD COLUMN IF NOT EXISTS attempts integer NOT NULL DEFAULT 0/,
    "the column, with a default — a NULL counter would compare false against the cap forever"
  );
  assert.match(sql, /CREATE INDEX IF NOT EXISTS scan_jobs_attempts_idx/);
  assert.match(sql, /CREATE OR REPLACE FUNCTION claim_scan_job_attempt/);
  assert.match(sql, /scan_jobs_attempts_chk/, "a negative count would never reach the cap");
  assert.match(sql, /FOR UPDATE/, "the row lock IS the atomicity of the increment");
  assert.match(sql, /SET status\s+= 'failed'/, "beyond the cap the job is terminal");
});

test("GUARD — the SQL cap and MAX_JOB_ATTEMPTS are the same number", async () => {
  const sql = await readFile(path.join(REPO, MIGRATION), "utf8");
  const match = sql.match(/p_max_attempts\s+integer\s+DEFAULT\s+(\d+)/);
  assert.ok(match, "the claim must declare its own default cap");
  assert.equal(
    Number(match[1]),
    MAX_JOB_ATTEMPTS,
    "two copies of the cap that disagree is a job abandoned at a count nobody chose"
  );
  assert.equal(MAX_JOB_ATTEMPTS, 3, "R3.3.1 is a cap of 3");
});

test("GUARD — SQL and JS write the same abandonment marker", async () => {
  const sql = await readFile(path.join(REPO, MIGRATION), "utf8");
  assert.ok(
    sql.includes(`${MAX_ATTEMPTS_MARKER} abandoned at`),
    "both paths write error_message; a marker only one of them uses is a marker that misses half the cases"
  );
});
