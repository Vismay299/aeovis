import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

import { liveDbGate, notRunBanner } from "../liveDbGate.js";
import { runScanChunk } from "./scanWorker.js";
import { supabase } from "../db.js";

/**
 * R3.2.1 — the web chunk's scan_runs row, written against a REAL Postgres.
 *
 * WHY THIS FILE EXISTS ALONGSIDE THE HERMETIC ONE
 * `scanChunkLedger.test.mjs` proves the orchestration: one row per execution,
 * the right outcome and reason on every path, measured zero kept distinct from
 * not-measured. It proves all of that against a FAKE ledger that re-implements
 * migration 011's constraints, and a re-implementation agreeing with itself is
 * not evidence about the database. Only a real connection can show that
 * `open_scan_run` / `close_scan_run` exist, that the anon key the Next app holds
 * is allowed to call them, that a NULL counter really lands as NULL rather than
 * as a DEFAULT 0, and that the row shape this file writes satisfies six CHECK
 * constraints it never sees.
 *
 * IT IS GATED, AND THE GATE IS LOUD. CI has no database. An unconfigured run
 * prints a NOT RUN banner to stderr and every case reports as skipped with its
 * reason, because a green suite must not be readable as "the web worker writes
 * a real ledger row". Standing rule 1: a skip is not a success.
 *
 * WHAT IT TOUCHES. `scan_runs` and nothing else. Every row it writes carries a
 * worker_id beginning `test-r321`, and they are deleted at the end (with a
 * final assertion that they are gone). It NEVER starts a real scan: getScanJob,
 * updateScanJob, claimJobStatus, upsertPromptResults and the engine are all
 * fakes, so no scan_jobs / prompt_results / probe_tasks row is read or written
 * and no vendor is called. It is the LEDGER calls that are real.
 */

const TEST_WORKER_PREFIX = "test-r321";
const GATE = liveDbGate();

if (!GATE.enabled) {
  console.error(
    notRunBanner(
      "R3.2.1 LIVE-POSTGRES scan-chunk LEDGER ROW",
      GATE.reason,
      "The web worker's scan_runs write is therefore UNVERIFIED in this run: nothing here " +
        "has shown that open_scan_run/close_scan_run are reachable from the Next app's " +
        "credentials, or that a not-measured counter survives the round trip as NULL."
    )
  );
}

const opts = GATE.enabled ? {} : { skip: GATE.reason };

/** The connection string, built exactly as src/lib/scanRunsLive.test.mjs builds it. */
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

async function cleanup(client) {
  await client.query(`DELETE FROM scan_runs WHERE worker_id LIKE $1`, [`${TEST_WORKER_PREFIX}%`]);
}

/**
 * The chunk writes through the Next app's anon client. If that client is not
 * configured this FAILS rather than skipping: the gate above already decided
 * this run is a live one, and silently proving nothing is the failure mode this
 * whole file exists to close.
 */
function requireAppClient() {
  assert.ok(
    supabase,
    "the live gate is open but db.js has no Supabase client — NEXT_PUBLIC_SUPABASE_URL and " +
      "NEXT_PUBLIC_SUPABASE_ANON_KEY must both be set, or this file proves nothing while passing"
  );
}

/**
 * Everything runScanChunk needs, all fake, so only the ledger is real.
 *
 * THE assert.fail STUBS ARE THE POINT, not padding. An earlier draft of this
 * file stubbed only the reads; the chunk ran through to finalize and the REAL
 * insertScan wrote two rows into `scans` on production, plus their
 * brand_metrics_daily rows. They were deleted, but a test that can do that once
 * can do it again, so every write this file must not perform is now a stub that
 * fails loudly instead of a default that reaches the database.
 */
function fakeJobDeps(job) {
  const forbidden = (name) => async () => {
    assert.fail(
      `${name} was called: this live file may write to scan_runs and NOTHING else. ` +
        `Reaching it means the chunk ran further than the test intended.`
    );
  };
  return {
    getScanJob: async () => job,
    updateScanJob: async (_id, updates) => Object.assign(job, updates),
    claimJobStatus: async () => job,
    getCompletedPairsForJob: async () => new Set(),
    upsertPromptResults: async (rows) => rows,
    getPromptResultsForJob: async () => [],
    selfContinue: () => {},
    // Finalize's writes. None of these may ever run here.
    insertScan: forbidden("insertScan"),
    stampScanIdForJob: forbidden("stampScanIdForJob"),
    insertCitations: forbidden("insertCitations"),
    deleteCitationsForJob: forbidden("deleteCitationsForJob"),
    insertResultBrands: forbidden("insertResultBrands"),
    deleteResultBrandsForJob: forbidden("deleteResultBrandsForJob"),
    upsertBrandMetricsDaily: forbidden("upsertBrandMetricsDaily"),
    extractCompetitors: forbidden("extractCompetitors"),
    enrichCitations: forbidden("enrichCitations"),
    getScansByDomain: forbidden("getScansByDomain"),
    getResultBrandsForScan: forbidden("getResultBrandsForScan"),
    // Sourcing's writes, for the same reason.
    upsertPrompts: forbidden("upsertPrompts"),
    getPromptsForBrand: forbidden("getPromptsForBrand"),
    generateUnbrandedPrompts: forbidden("generateUnbrandedPrompts"),
  };
}

function fakeCheckpoint(queries) {
  return {
    brand: job1Brand,
    url: "example.invalid",
    industry: "saas",
    competitors: [],
    competitors_raw: "",
    prompt_key: "example.invalid",
    queries,
    unbranded_texts: queries.map((q) => q.text),
    engines: ["aio"],
    stats: { cost: 0, tokens: 0 },
    sourced_at: new Date().toISOString(),
  };
}

const job1Brand = "R3.2.1 ledger probe (not a real brand)";

function fakeProbeResult(query, error) {
  return {
    engine: "aio",
    prompt: query.text,
    is_branded_query: false,
    topic: "General",
    source: "test",
    intent_tier: "informational",
    answer_present: !error,
    aio_present: !error,
    text: error ? "" : "an answer",
    citations: [],
    references: [],
    brand_mentioned_in_text: false,
    brand_cited: false,
    visible: false,
    competitors_found_in_text: [],
    competitors_cited: [],
    brands: [],
    error: error ?? null,
    cost: 0,
  };
}

// ---------------------------------------------------------------------------

test("a chunk that declines writes exactly one real row, with NULL counters", opts, async () => {
  requireAppClient();
  const db = await connect();
  try {
    await cleanup(db);
    const jobId = crypto.randomUUID();
    const chunkId = `${TEST_WORKER_PREFIX}-noop-${crypto.randomUUID()}`;

    const job = { id: jobId, brand: job1Brand, status: "complete", checkpoint: null };
    const result = await runScanChunk(jobId, { ...fakeJobDeps(job), chunkId });
    assert.equal(result.reason, "already_finished");

    const { rows } = await db.query(`SELECT * FROM scan_runs WHERE worker_id = $1`, [chunkId]);
    assert.equal(rows.length, 1, "exactly one row per chunk execution");
    const row = rows[0];

    assert.equal(row.runner, "scan-chunk");
    assert.equal(row.phase, "entry");
    assert.equal(row.scan_job_id, jobId);
    assert.equal(row.brand, job1Brand);
    assert.equal(row.outcome, "noop");
    assert.equal(row.reason, "already_finished");
    assert.ok(row.started_at instanceof Date, "timings: started_at is set");
    assert.ok(row.ended_at instanceof Date, "timings: ended_at is set on a closed row");
    assert.ok(row.ended_at >= row.started_at);

    // The load-bearing assertion of this whole file: the database really stores
    // NULL, not a DEFAULT 0. A column that cannot express "unknown" forces every
    // reader above it to lie.
    assert.equal(row.probes_attempted, null, "NOT MEASURED must survive the round trip as NULL");
    assert.equal(row.probes_succeeded, null);
    assert.equal(row.errors_recovered, null);
    assert.equal(row.detail.job_status, "complete");
  } finally {
    await cleanup(db);
    await db.end();
  }
});

test("a probing chunk's measured counters land as real integers, and the row is closed", opts, async () => {
  requireAppClient();
  const db = await connect();
  try {
    await cleanup(db);
    const jobId = crypto.randomUUID();
    const chunkId = `${TEST_WORKER_PREFIX}-probing-${crypto.randomUUID()}`;
    // THREE queries at concurrency two: the first batch covers two of them, so
    // the chunk still has work left when the zero budget trips and it
    // checkpoints instead of falling through into finalize.
    const queries = ["a", "b", "c"].map((k) => ({
      text: `r321 ledger query ${k}`,
      source: "test",
      topic: "General",
      intent_tier: "informational",
    }));
    const job = { id: jobId, brand: job1Brand, status: "probing", checkpoint: fakeCheckpoint(queries) };

    let n = 0;
    const result = await runScanChunk(jobId, {
      ...fakeJobDeps(job),
      chunkId,
      chunkBudgetMs: 0,
      resolveEnabledEngines: () => [
        {
          name: "aio",
          concurrency: 2,
          // One probe fails at the engine level: absorbed, its row still
          // written, so it is an error this chunk RECOVERED from.
          probe: async (q) => fakeProbeResult(q, n++ === 1 ? "upstream 502" : null),
        },
      ],
    });
    assert.equal(result.reason, "checkpointed");

    const { rows } = await db.query(`SELECT * FROM scan_runs WHERE worker_id = $1`, [chunkId]);
    assert.equal(rows.length, 1);
    const row = rows[0];

    assert.equal(row.phase, "probing");
    assert.equal(row.outcome, "succeeded", "the CHUNK finished and handed off");
    assert.equal(row.reason, "checkpointed", "…and the reason says the JOB did not");
    assert.equal(row.probes_attempted, 2);
    assert.equal(row.probes_succeeded, 1);
    assert.equal(row.errors_recovered, 1);
    assert.deepEqual(row.detail.phases_run, ["probing"]);
    assert.ok(row.ended_at, "open xor closed: a run with an outcome must have an end");
  } finally {
    await cleanup(db);
    await db.end();
  }
});

test("the heartbeat really moves while the chunk is in flight", opts, async () => {
  // Without this, every long chunk reads as stale to R3.3.2's sweep and gets
  // reaped while it is working perfectly. It can only be shown from inside the
  // work, against the real row, because the close stamps heartbeat_at itself.
  requireAppClient();
  const db = await connect();
  try {
    await cleanup(db);
    const jobId = crypto.randomUUID();
    const chunkId = `${TEST_WORKER_PREFIX}-beat-${crypto.randomUUID()}`;
    // Two queries at concurrency one, so the zero budget trips after the first
    // (slow) batch and the chunk checkpoints rather than falling into finalize.
    const queries = ["one", "two"].map((k) => ({
      text: `r321 heartbeat query ${k}`,
      source: "test",
      topic: "General",
      intent_tier: "informational",
    }));
    const job = { id: jobId, brand: job1Brand, status: "probing", checkpoint: fakeCheckpoint(queries) };

    let moved = false;
    const result = await runScanChunk(jobId, {
      ...fakeJobDeps(job),
      chunkId,
      chunkBudgetMs: 0,
      runHeartbeatMs: 400,
      resolveEnabledEngines: () => [
        {
          name: "aio",
          concurrency: 1,
          probe: async (q) => {
            const deadline = Date.now() + 8000;
            while (!moved && Date.now() < deadline) {
              await new Promise((r) => setTimeout(r, 300));
              const { rows } = await db.query(
                `SELECT started_at, heartbeat_at, ended_at FROM scan_runs WHERE worker_id = $1`,
                [chunkId]
              );
              if (rows.length === 1) {
                assert.equal(rows[0].ended_at, null, "the run must still be OPEN while the work runs");
                if (rows[0].heartbeat_at > rows[0].started_at) moved = true;
              }
            }
            return fakeProbeResult(q, null);
          },
        },
      ],
    });

    assert.equal(result.reason, "checkpointed", "the chunk must not have run past probing");
    assert.ok(moved, "heartbeat_at never moved off started_at within 8s of in-flight work");
  } finally {
    await cleanup(db);
    await db.end();
  }
});

test("CLEANUP — this file leaves scan_runs exactly as it found it", opts, async () => {
  const db = await connect();
  try {
    await cleanup(db);
    const { rows } = await db.query(`SELECT count(*)::int AS n FROM scan_runs WHERE worker_id LIKE $1`, [
      `${TEST_WORKER_PREFIX}%`,
    ]);
    assert.equal(rows[0].n, 0, "every row this file wrote must be gone");
  } finally {
    await db.end();
  }
});
