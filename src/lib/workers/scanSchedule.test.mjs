import test from "node:test";
import assert from "node:assert/strict";
import {
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
 * pool (so nothing generates), one branded seed, two engines. `schedules`
 * overrides the two scan_schedules calls; everything else is fixed.
 */
function sourcingDeps(schedules = {}) {
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
    ...schedules,
  };
}

function skipFor(tally, reason) {
  return (tally.skips || []).find((s) => s.reason === reason);
}

// ---------------------------------------------------------------------------
// 1. THE ACCEPT: a brand's first scan creates its scan_schedules row.
// ---------------------------------------------------------------------------

test("runSourcingPhase — a brand with NO schedule row gets one created, on the resolveBrandKey key", async () => {
  const reads = [];
  const writes = [];
  const tally = createChunkTally();

  const checkpoint = await runSourcingPhase(
    JOB,
    sourcingDeps({
      getScanSchedule: async (brand) => {
        reads.push(brand);
        return null; // first scan ever for this brand
      },
      upsertScanSchedule: async (brand, updates) => {
        writes.push({ brand, updates });
        return { brand, ...updates };
      },
    }),
    tally
  );

  assert.deepEqual(reads, [BRAND_KEY], "the row is looked up under the brand KEY, never the display name");
  assert.equal(writes.length, 1, "exactly one registration write");
  assert.equal(writes[0].brand, BRAND_KEY);
  assert.equal(
    writes[0].brand,
    checkpoint.prompt_key,
    "scan_schedules.brand and the checkpoint's prompt_key are the SAME key — a scheduled rescan " +
      "re-derives one from the other (see runSchedulerTick's `url: schedule.brand`)"
  );
  assert.equal(writes[0].updates.display_name, "Acme", "the typed name survives as the label, not as the key");

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
      getScanSchedule: async () => null,
      upsertScanSchedule: async (brand, updates) => {
        writes.push(updates);
        return { brand, ...updates };
      },
    }),
    createChunkTally()
  );

  const updates = writes[0];
  // `enabled` must be PRESENT, not merely falsy-by-omission. The DB column
  // defaults to true (005_analytics_platform.sql:88) while the product default
  // is false (the GET fallback in /api/brands/[brand]/schedule + the PUT path's
  // applyInsertDefaults), so an omitted `enabled` here would auto-enrol every
  // brand that ever ran one free scan into recurring rescans.
  assert.ok(
    Object.prototype.hasOwnProperty.call(updates, "enabled"),
    "omitting `enabled` takes the DB's `true` default — registering a brand is not consent to rescan it"
  );
  assert.equal(updates.enabled, false);
  // …and with enabled=false plus next_run_at=null, listDueSchedules cannot
  // return it: a NULL next_run_at reads as immediately due for ENABLED rows.
  assert.ok(
    Object.prototype.hasOwnProperty.call(updates, "next_run_at"),
    "next_run_at is written explicitly for the same reason"
  );
  assert.equal(updates.next_run_at, null);
});

// ---------------------------------------------------------------------------
// 2. An existing row is operator-owned state and is never touched.
// ---------------------------------------------------------------------------

test("runSourcingPhase — an EXISTING schedule row is left byte-for-byte alone", async () => {
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
  const writes = [];
  const tally = createChunkTally();

  await runSourcingPhase(
    JOB,
    sourcingDeps({
      getScanSchedule: async () => existing,
      upsertScanSchedule: async (brand, updates) => {
        writes.push({ brand, updates });
        return {};
      },
    }),
    tally
  );

  assert.deepEqual(
    writes,
    [],
    "not one write. A manual scan sliding someone's cadence/next_run_at forward is a WORSE bug than the one this fixes"
  );
  assert.equal(JSON.stringify(existing), before, "and the row object itself is unchanged, field for field");
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

for (const [label, deps] of [
  [
    "getScanSchedule",
    {
      getScanSchedule: async () => {
        throw new Error("select failed");
      },
      upsertScanSchedule: async () => {
        throw new Error("must not be reached — the read already failed");
      },
    },
  ],
  [
    "upsertScanSchedule",
    {
      getScanSchedule: async () => null,
      upsertScanSchedule: async () => {
        throw new Error("upsert failed");
      },
    },
  ],
]) {
  test(`runSourcingPhase — a throwing ${label} does NOT kill the scan, but IS counted and named`, async () => {
    const tally = createChunkTally();

    const checkpoint = await runSourcingPhase(JOB, sourcingDeps(deps), tally);

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
}

// ---------------------------------------------------------------------------
// 4. The helper's own edges + the fourth state: never measured.
// ---------------------------------------------------------------------------

test("ensureScanScheduleRow — no brand key is a NAMED failure, not a silent return", async () => {
  const tally = createChunkTally();
  const state = await ensureScanScheduleRow(
    "",
    "Acme",
    {
      getScanSchedule: async () => {
        throw new Error("must not be reached — there is no key to look up");
      },
      upsertScanSchedule: async () => {
        throw new Error("must not be reached");
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
