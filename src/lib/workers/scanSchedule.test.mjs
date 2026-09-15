import test from "node:test";
import assert from "node:assert/strict";
import {
  runScanChunk,
  runSourcingPhase,
  ensureScanScheduleRow,
  chunkRunOutcome,
  createChunkTally,
  SCHEDULE_ROW_STATES,
  CHUNK_SKIP_REASONS,
} from "./scanWorker.js";

/**
 * R3.4.1 (finding S14) — THE BRAND THAT COULD NEVER BECOME DUE.
 *
 * `upsertScanSchedule` used to be called from exactly two places: the scheduler
 * tick (which only ever sees rows `listDueSchedules` already returned, i.e. rows
 * that exist) and the manual schedule editor. So the ONLY way a brand ever got a
 * `scan_schedules` row was a human going and making one. A brand that ran a scan
 * and was never hand-edited had no row, `listDueSchedules` could not return it,
 * and it could never be rescanned — and nothing anywhere said so.
 *
 * R3.4.5 — ATOMIC SINGLE WRITE. The get-then-upsert pattern (read, then write)
 * was replaced by a single INSERT ... ON CONFLICT DO NOTHING. The tests below
 * exercise both the new `ensureScanScheduleRow` (via `runSourcingPhase` and
 * directly) and the `runScanChunk` entry point, to stop a future refactor from
 * silently severing the registration call.
 *
 * These tests drive the REAL `runSourcingPhase` with injected fakes, not the
 * helper alone. A test that only exercised `ensureScanScheduleRow` would prove
 * the registration works while the call site quietly did nothing, which is the
 * same shape of bug in a nicer costume. Four of the six go through the phase.
 */

const JOB = { brand: "Acme", url: "acme.com", industry: "saas", competitors: "RivalA" };

/** The resolveBrandKey() output for JOB — this IS `scan_schedules.brand`. */
const BRAND_KEY = "acme.com";

function pool(n = 10) {
  return Array.from({ length: n }, (_, i) => ({
    text: `unbranded seed ${i}`,
    intent_tier: "informational",
    topic: "General",
    weight: 1,
    enabled: true,
    source: "llm_generated",
    created_at: "2026-07-01T00:00:00Z",
  }));
}

/**
 * Sourcing deps that make the phase deterministic and offline: a full prompt
 * pool (so nothing generates), one branded seed, two engines. `scheduleInsert`
 * overrides the single `insertScanScheduleIfNotExists` call; everything else is
 * fixed.
 */
function sourcingDeps(scheduleInsertOverrides = {}) {
  return {
    promptTarget: 10,
    getPromptsForBrand: async () => pool(),
    upsertPrompts: async () => ({}),
    generateUnbrandedPrompts: async () => {
      throw new Error("must not generate — the pool is already full");
    },
    buildBrandedQueries: () => [
      { text: "acme reviews", source: "branded_seed", topic: "Brand Presence", intent_tier: "branded" },
    ],
    resolveEnabledEngines: () => [{ name: "aio" }, { name: "perplexity" }],
    ...scheduleInsertOverrides,
  };
}

function skipFor(tally, reason) {
  return (tally.skips || []).find((s) => s.reason === reason);
}

// ---------------------------------------------------------------------------
// 1. THE ACCEPT: a brand's first scan creates its scan_schedules row.
// ---------------------------------------------------------------------------

test("runSourcingPhase — a brand with NO schedule row gets one created, on the resolveBrandKey key", async () => {
  const writes = [];
  const tally = createChunkTally();

  const checkpoint = await runSourcingPhase(
    JOB,
    sourcingDeps({
      insertScanScheduleIfNotExists: async (row) => {
        writes.push(row);
        return row; // returning the row signals "inserted"
      },
    }),
    tally
  );

  assert.equal(writes.length, 1, "exactly one registration write — single atomic insert, no read step");
  assert.equal(writes[0].brand, BRAND_KEY, "the row is written under the brand KEY, never the display name");
  assert.equal(
    writes[0].brand,
    checkpoint.prompt_key,
    "scan_schedules.brand and the checkpoint's prompt_key are the SAME key — a scheduled rescan " +
      "re-derives one from the other (see runSchedulerTick's `url: schedule.brand`)"
  );
  assert.equal(writes[0].display_name, "Acme", "the typed name survives as the label, not as the key");

  // The scan itself is untouched by the registration.
  assert.equal(checkpoint.queries.length, 11, "10 unbranded + 1 branded seed — sourcing did its real job too");

  assert.equal(tally.scheduleRow, SCHEDULE_ROW_STATES.CREATED);
  assert.equal(
    chunkRunOutcome({ reason: "complete" }, tally).detail.schedule_row,
    "created",
    "and it reaches the chunk's scan_runs row — a registration nobody can see is the finding, not the fix"
  );
});

test("runSourcingPhase — the created row is OPT-IN: `enabled` is written EXPLICITLY false", async () => {
  const writes = [];
  await runSourcingPhase(
    JOB,
    sourcingDeps({
      insertScanScheduleIfNotExists: async (row) => {
        writes.push(row);
        return row;
      },
    }),
    createChunkTally()
  );

  const row = writes[0];
  // `enabled` must be PRESENT, not merely falsy-by-omission. The DB column
  // defaults to true (005_analytics_platform.sql:88) while the product default
  // is false (the GET fallback in /api/brands/[brand]/schedule + the PUT path's
  // applyInsertDefaults), so an omitted `enabled` here would auto-enrol every
  // brand that ever ran one free scan into recurring rescans.
  assert.ok(
    Object.prototype.hasOwnProperty.call(row, "enabled"),
    "omitting `enabled` takes the DB's `true` default — registering a brand is not consent to rescan it"
  );
  assert.equal(row.enabled, false);
  // …and with enabled=false plus next_run_at=null, listDueSchedules cannot
  // return it: a NULL next_run_at reads as immediately due for ENABLED rows.
  assert.ok(
    Object.prototype.hasOwnProperty.call(row, "next_run_at"),
    "next_run_at is written explicitly for the same reason"
  );
  assert.equal(row.next_run_at, null);
});

// ---------------------------------------------------------------------------
// 2. An existing row is operator-owned state and is never touched.
// ---------------------------------------------------------------------------

test("runSourcingPhase — an EXISTING schedule row is left byte-for-byte alone (atomic insert returns null)", async () => {
  const existing = Object.freeze({
    brand: BRAND_KEY,
    display_name: "Acme (renamed by an operator)",
    cadence: "weekly",
    enabled: true,
    prompt_target: 60,
    geo: "in",
    last_run_at: "2026-08-01T00:00:00.000Z",
    next_run_at: "2026-08-08T00:00:00.000Z",
    updated_at: "2026-08-01T00:00:00.000Z",
  });
  const before = JSON.stringify(existing);
  let insertCalled = false;
  const tally = createChunkTally();

  await runSourcingPhase(
    JOB,
    sourcingDeps({
      // ON CONFLICT DO NOTHING: the insert sees the row exists and returns null.
      insertScanScheduleIfNotExists: async (_row) => {
        insertCalled = true;
        return null; // signals "row already existed, did nothing"
      },
    }),
    tally
  );

  assert.ok(insertCalled, "the insert function WAS called — it just decided not to insert");
  assert.equal(tally.scheduleRow, SCHEDULE_ROW_STATES.EXISTING);
  assert.equal(
    chunkRunOutcome({ reason: "complete" }, tally).detail.schedule_row,
    "existing",
    "'existing' and 'created' are different facts and the ledger keeps them apart"
  );
  assert.deepEqual(tally.skips, [], "leaving a good row alone is not a skip — measured zero, not null");
});

// ---------------------------------------------------------------------------
// 3. A failure is absorbed but NEVER hidden.
// ---------------------------------------------------------------------------

test("runSourcingPhase — a throwing insertScanScheduleIfNotExists does NOT kill the scan, but IS counted and named", async () => {
  const tally = createChunkTally();

  const checkpoint = await runSourcingPhase(
    JOB,
    sourcingDeps({
      insertScanScheduleIfNotExists: async () => {
        throw new Error("insert failed");
      },
    }),
    tally
  );

  // The scan's results are already being paid for and are still worth having.
  assert.equal(checkpoint.queries.length, 11, "the scan continues to a full checkpoint");
  assert.equal(checkpoint.prompt_key, BRAND_KEY);

  // But the brand is still invisible to the scheduler, and that has to show.
  const skip = skipFor(tally, CHUNK_SKIP_REASONS.SCHEDULE_ENSURE_FAILED);
  assert.ok(skip, `no ${CHUNK_SKIP_REASONS.SCHEDULE_ENSURE_FAILED} on the tally; got ${JSON.stringify(tally.skips)}`);
  assert.equal(skip.count, 1);
  assert.match(skip.sample[0], /acme\.com/, "the sample names the brand that failed to register");
  assert.ok(tally.errorsRecovered >= 1, "an absorbed error is a counted error");
  assert.equal(tally.scheduleRow, SCHEDULE_ROW_STATES.FAILED);

  const row = chunkRunOutcome({ reason: "complete" }, tally);
  assert.equal(row.outcome, "succeeded", "the CHUNK succeeded — it produced the scan it was asked for");
  assert.equal(row.detail.schedule_row, "failed", "…and its row still says the registration did not happen");
  assert.ok(
    row.detail.skips.some((s) => s.reason === CHUNK_SKIP_REASONS.SCHEDULE_ENSURE_FAILED),
    "the reason rides detail.skips like every other absorbed skip"
  );
});

// ---------------------------------------------------------------------------
// 4. The helper's own edges + the fourth state: never measured.
// ---------------------------------------------------------------------------

test("ensureScanScheduleRow — no brand key is a NAMED failure, not a silent return", async () => {
  const tally = createChunkTally();
  const state = await ensureScanScheduleRow(
    "",
    "Acme",
    {
      insertScanScheduleIfNotExists: async () => {
        throw new Error("must not be reached — there is no key to look up");
      },
    },
    tally
  );

  assert.equal(state, SCHEDULE_ROW_STATES.FAILED);
  assert.ok(skipFor(tally, CHUNK_SKIP_REASONS.SCHEDULE_ENSURE_FAILED), "a keyless brand registered nothing and says so");
  assert.equal(tally.errorsRecovered, 1);
});

test("chunkRunOutcome — a chunk that never sourced reports schedule_row NULL, not 'existing'", () => {
  const tally = createChunkTally();
  assert.equal(tally.scheduleRow, null, "createChunkTally must not hand out a pre-decided state");

  const row = chunkRunOutcome({ reason: "complete" }, tally);
  assert.equal(
    row.detail.schedule_row,
    null,
    "a chunk that resumed into probing/finalize never touched scan_schedules — 'existing' would be a claim it cannot make"
  );
  assert.notEqual(row.detail.schedule_row, SCHEDULE_ROW_STATES.EXISTING);
});

test("chunkRunOutcome — an unrecognised schedule state passes through VERBATIM, never nulled to 'not measured'", () => {
  const tally = { ...createChunkTally(), scheduleRow: "some_future_state" };
  assert.equal(
    chunkRunOutcome({ reason: "complete" }, tally).detail.schedule_row,
    "some_future_state",
    "a state this file has no name for still happened; rounding it to null is the erasure R3.4.1 is about"
  );
});

// ---------------------------------------------------------------------------
// 5. R3.4.5 — runScanChunk wiring test.
//
//    One case driving the REAL runScanChunk entry point, confirming that the
//    schedule registration is unconditional in the sourcing phase. A future
//    refactor that removes the call or guards it behind a condition would fail
//    this test — the verifier's throwaway harness made this point; this is the
//    durable version.
// ---------------------------------------------------------------------------

test("runScanChunk — a brand's first scan unconditionally registers a scan_schedules row via the real sourcing phase", async () => {
  const scheduleInserts = [];
  let sourcingRan = false;

  // Minimal in-memory backend that satisfies runScanChunk's full path through
  // sourcing + probing + finalize without any network or LLM calls.
  const jobs = new Map();
  const jobId = "test-job-1";
  jobs.set(jobId, {
    id: jobId,
    brand: "Acme",
    url: "acme.com",
    industry: "saas",
    competitors: "RivalA",
    status: "pending",
    progress_pct: 0,
    checkpoint: null,
    heartbeat_at: new Date().toISOString(),
    created_at: new Date().toISOString(),
    result_id: null,
    error_message: null,
    attempts: 0,
  });

  const fakeDeps = {
    getScanJob: async (id) => jobs.get(id) || null,
    updateScanJob: async (id, updates) => {
      const job = jobs.get(id);
      if (job) {
        Object.assign(job, updates, { heartbeat_at: new Date().toISOString() });
      }
      return job;
    },
    claimJobStatus: async (id, fromStatus, toStatus) => {
      const list = Array.isArray(fromStatus) ? fromStatus : [fromStatus];
      const job = jobs.get(id);
      if (!job) return null;
      if (!list.includes(job.status)) return null;
      Object.assign(job, { status: toStatus, heartbeat_at: new Date().toISOString() });
      return job;
    },
    selfContinue: () => {},
    // Prompt sourcing
    promptTarget: 10,
    getPromptsForBrand: async () => pool(),
    upsertPrompts: async () => ({}),
    generateUnbrandedPrompts: async () => {
      throw new Error("must not generate");
    },
    buildBrandedQueries: () => [
      { text: "acme reviews", source: "branded_seed", topic: "Brand Presence", intent_tier: "branded" },
    ],
    resolveEnabledEngines: () => [{ name: "aio" }],
    // Schedule registration — the wiring under test
    insertScanScheduleIfNotExists: async (row) => {
      scheduleInserts.push(row);
      return row; // "inserted"
    },
    // Probe stubs — probing pairs would run but we keep it minimal
    getCompletedPairsForJob: async () => new Set(),
    upsertPromptResults: async () => {},
    // Finalize stubs
    getPromptResultsForJob: async () => [],
    insertScan: async (record) => [{ id: "scan-1", ...record }],
    stampScanIdForJob: async () => {},
    deleteCitationsForJob: async () => {},
    insertCitations: async () => {},
    deleteResultBrandsForJob: async () => {},
    insertResultBrands: async () => {},
    upsertBrandMetricsDaily: async () => {},
    getScansByDomain: async () => [],
    getResultBrandsForScan: async () => [],
    aggregateAioTopDomains: () => [],
    enrichCitations: async (rows) => rows,
    judgeBrandsSymmetric: () => [{ name: "Acme", is_self: true, mentioned: false, position: null, sentiment: null }],
    extractCompetitors: async () => [],
    summarizeEngineResults: ({ results }) => ({
      summary: { visibility_pct: 0, share_of_ai_pct: 0, aio_coverage_pct: 0, presence_rate_pct: 0, mention_rate_pct: 0, visible_non_branded: 0, citation_share_pct: 0, branded_visibility_pct: 0, aio_error_rate_pct: 0, data_source_issue: false, insufficient_sample: false },
      engines: {},
    }),
    computeHeadline: () => ({ visibility_index_pct: 0, engines_counted: 1 }),
    summarizeAioResults: () => ({
      summary: { visibility_pct: 0, share_of_ai_pct: 0, aio_coverage_pct: 0, presence_rate_pct: 0, mention_rate_pct: 0, visible_non_branded: 0, citation_share_pct: 0, branded_visibility_pct: 0, aio_error_rate_pct: 0, data_source_issue: false, insufficient_sample: false },
    }),
    // Ledger disabled (no Supabase client) — acceptable for this wiring test
  };

  const result = await runScanChunk(jobId, fakeDeps);

  // The scan completed (sourcing → probing → finalize, with probe/finalize
  // stubs returning empty results).
  assert.equal(result.ok, true, "the chunk completed successfully");

  // THE KEY ASSERTION: the schedule registration was called unconditionally
  // during the sourcing phase of this real runScanChunk call.
  assert.equal(scheduleInserts.length, 1, "exactly one schedule insert — the registration is unconditional");
  assert.equal(scheduleInserts[0].brand, BRAND_KEY, "written under the brand KEY");
  assert.equal(scheduleInserts[0].enabled, false, "opt-in: enabled is explicitly false");
  assert.equal(scheduleInserts[0].next_run_at, null, "opt-in: next_run_at is explicitly null");
});

test("R3.4.5 — insertScanScheduleIfNotExists: atomic ON CONFLICT DO NOTHING with client", async () => {
  const { insertScanScheduleIfNotExists } = await import("../db/analytics.js");

  let upsertOptions = null;
  let targetTable = null;
  let queryPayload = null;

  const fakeClient = {
    from(table) {
      targetTable = table;
      return {
        upsert(payload, options) {
          queryPayload = payload;
          upsertOptions = options;
          return {
            select() {
              return { data: [{ id: 1, ...payload }], error: null };
            },
          };
        },
      };
    },
  };

  const row = { brand: "test-brand.com", enabled: false, next_run_at: null };
  const res = await insertScanScheduleIfNotExists(row, { client: fakeClient });

  assert.equal(targetTable, "scan_schedules", "targets scan_schedules table");
  assert.deepEqual(
    upsertOptions,
    { onConflict: "brand", ignoreDuplicates: true },
    "enforces atomic ignoreDuplicates on conflict on brand key"
  );
  assert.equal(res.brand, "test-brand.com");

  // Conflict case: data is empty array -> returns null
  const conflictClient = {
    from() {
      return {
        upsert() {
          return {
            select() {
              return { data: [], error: null };
            },
          };
        },
      };
    },
  };
  const conflictRes = await insertScanScheduleIfNotExists(row, { client: conflictClient });
  assert.equal(conflictRes, null, "conflict returns null (no-op, does not throw)");

  // Error case: client throws
  const errorClient = {
    from() {
      return {
        upsert() {
          return {
            select() {
              return { data: null, error: new Error("db connection error") };
            },
          };
        },
      };
    },
  };
  await assert.rejects(
    () => insertScanScheduleIfNotExists(row, { client: errorClient }),
    /db connection error/
  );
});

test("R3.4.5 — insertScanScheduleIfNotExists: memory mode deduplication", async () => {
  const { insertScanScheduleIfNotExists } = await import("../db/analytics.js");
  const brand = "memory-brand-" + Date.now() + ".com";
  const row = { brand, enabled: false, next_run_at: null };

  const first = await insertScanScheduleIfNotExists(row, { client: null });
  assert.ok(first, "first insert in memory mode succeeds");
  assert.equal(first.brand, brand);

  const second = await insertScanScheduleIfNotExists(row, { client: null });
  assert.equal(second, null, "subsequent insert for identical brand returns null without overwriting");
});

