import test from "node:test";
import assert from "node:assert/strict";

/**
 * R3.4.2 (finding C5) — A SKIPPED BRAND'S CLOCK NEVER MOVED.
 *
 * R3.2.2 gave every scheduler skip a `scan_runs` row, so the decision stopped
 * being invisible. It did not stop the decision from being PERMANENT. Both
 * `continue` statements in `runSchedulerTick` left `next_run_at` exactly where
 * they found it — at or before `now` — so `listDueSchedules` returned the same
 * schedule on the next tick, and the next, forever. The brand was never
 * scanned again; the ledger just repeated itself once per cron pass.
 *
 * Reproduced before the fix: a tick over one due `cadence:'off'` schedule and a
 * tick over one `brand_already_active` schedule each performed ZERO
 * `upsertScanSchedule` calls, and the stored row's `next_run_at` was
 * byte-identical afterwards.
 *
 * The first two cases below drive the REAL in-memory `listDueSchedules` /
 * `upsertScanSchedule` from db/analytics.js rather than a hand-rolled fake, so
 * "it is no longer due" is decided by the same due-filter production uses, not
 * by a test asserting its own opinion back to itself.
 */

// The dynamic-import dance from scanChunkLedger.test.mjs: a static import is
// hoisted above these deletes, and scanWorker.js -> db.js would capture a live
// client. With no client, db/analytics.js uses its in-memory maps and
// resolveChunkLedger reports the ledger disabled unless one is injected.
delete process.env.NEXT_PUBLIC_SUPABASE_URL;
delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

const {
  runSchedulerTick,
  computeSkipNextRunAt,
  computeNextRunAt,
  SCHEDULER_SKIP_REASONS,
  SCHEDULER_SKIP_BACKOFF_MS,
  SCHEDULER_PHASES,
  SCHEDULER_TICK_REASONS,
} = await import("./scanWorker.js");
const { listDueSchedules, upsertScanSchedule, getScanSchedule } = await import("../db/analytics.js");
const { supabase } = await import("../db.js");
const { RUN_OUTCOMES, RUNNERS } = await import("../scanRuns.js");

assert.equal(supabase, null, "these cases must run against the in-memory store, never a live project");

const NOW = "2026-09-04T00:00:00.000Z";
const HOUR = 60 * 60 * 1000;

function plus(iso, ms) {
  return new Date(new Date(iso).getTime() + ms).toISOString();
}

/** Quiet the scheduler's (deliberate) warn/error noise for one call. */
async function quiet(fn) {
  const { warn, error } = console;
  console.warn = () => {};
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.warn = warn;
    console.error = error;
  }
}

/** A minimal scan_runs fake — enough to hold phase/outcome/reason/detail. */
function makeLedger({ failUpsert = false } = {}) {
  const rows = [];
  const calls = [];
  let n = 0;
  return {
    rows,
    calls,
    schedule: (phase) => rows.filter((r) => r.phase === phase),
    deps: {
      openScanRun: async (fields) => {
        calls.push(`open:${fields.phase}`);
        const row = {
          id: `run-${n++}`,
          runner: fields.runner,
          phase: fields.phase,
          brand: fields.brand ?? null,
          scan_job_id: fields.scanJobId ?? null,
          detail: fields.detail ?? null,
          outcome: null,
          reason: null,
          error: null,
          ended_at: null,
        };
        rows.push(row);
        return { id: row.id, phase: row.phase, brand: row.brand, open: true };
      },
      heartbeatScanRun: async () => ({}),
      closeScanRun: async (fields) => {
        const row = rows.find((r) => r.id === fields.runId);
        if (!row) throw new Error(`close: no run ${fields.runId}`);
        row.outcome = fields.outcome;
        row.reason = fields.reason ?? null;
        row.error = fields.error ?? null;
        row.detail = { ...(row.detail || {}), ...(fields.detail || {}) };
        row.ended_at = new Date().toISOString();
        return { id: row.id, open: false };
      },
    },
    // deliberately separate: some cases want a ledger AND a throwing upsert
    failUpsert,
  };
}

/** Job/kick deps that never touch a network or a DB. */
function jobDeps({ active = new Set(), upsertScanSchedule: upsert } = {}) {
  const jobs = [];
  const kicked = [];
  const scheduleWrites = [];
  let n = 0;
  return {
    jobs,
    kicked,
    scheduleWrites,
    deps: {
      hasActiveScanForBrand: async (brand) => active.has(brand),
      createScanJob: async (fields) => {
        const job = { id: `job-${n++}`, ...fields };
        jobs.push(job);
        return job;
      },
      upsertScanSchedule:
        upsert ||
        (async (key, updates) => {
          scheduleWrites.push({ key, updates });
          return { brand: key, ...updates };
        }),
      runScanChunk: async (id) => {
        kicked.push(id);
      },
      schedulerId: "scheduler-r342",
    },
  };
}

/** Seed the REAL in-memory scan_schedules store with one row. */
async function seedRealSchedule(row) {
  global.memoryScanSchedules.clear();
  await upsertScanSchedule(row.brand, row);
  return row.brand;
}

// ---------------------------------------------------------------------------
// 1. THE ACCEPT, end to end, against the real due-filter.
// ---------------------------------------------------------------------------

test("runSchedulerTick — a cadence:'off' skip advances next_run_at, so the same schedule is NOT due again on the next tick", async () => {
  const key = await seedRealSchedule({
    brand: "off-co.com",
    display_name: "Off Co",
    cadence: "off",
    enabled: true,
    next_run_at: null, // NULL reads as "due right now" for an enabled row
  });
  const backend = jobDeps({ upsertScanSchedule });

  assert.equal((await listDueSchedules(NOW)).length, 1, "precondition: the store really does call it due");

  const result = await quiet(() =>
    runSchedulerTick(NOW, { ...backend.deps, listDueSchedules, upsertScanSchedule })
  );

  assert.equal(backend.jobs.length, 0, "it still declines to scan — this task changes the clock, not the verdict");
  assert.equal(result.skipped.length, 1);
  assert.equal(result.skipped[0].reason, SCHEDULER_SKIP_REASONS.CADENCE_OFF);

  const stored = await getScanSchedule(key);
  assert.equal(
    stored.next_run_at,
    plus(NOW, SCHEDULER_SKIP_BACKOFF_MS[SCHEDULER_SKIP_REASONS.CADENCE_OFF]),
    "the declined schedule's clock must move forward by the cadence_off backoff"
  );
  assert.deepEqual(
    await listDueSchedules(NOW),
    [],
    "and the real due-filter must no longer return it — a skip that leaves the row due re-fires forever (C5)"
  );

  // …but it comes BACK. enabled=true + cadence='off' is a contradictory row and
  // burying it forever would trade one silence for another.
  const later = await listDueSchedules(plus(NOW, SCHEDULER_SKIP_BACKOFF_MS[SCHEDULER_SKIP_REASONS.CADENCE_OFF]));
  assert.equal(later.length, 1, "the backoff is a reschedule, not a burial");
});

test("runSchedulerTick — a brand_already_active skip advances next_run_at and comes back within the hour", async () => {
  const key = await seedRealSchedule({
    brand: "busy.com",
    display_name: "Busy Co",
    cadence: "daily",
    enabled: true,
    next_run_at: "2026-09-03T00:00:00.000Z", // overdue by a day
  });
  const backend = jobDeps({ active: new Set(["Busy Co"]), upsertScanSchedule });

  const result = await quiet(() =>
    runSchedulerTick(NOW, { ...backend.deps, listDueSchedules, upsertScanSchedule })
  );

  assert.equal(backend.jobs.length, 0, "it did not pile a second scan onto a brand already scanning");
  assert.equal(result.skipped[0].reason, SCHEDULER_SKIP_REASONS.BRAND_ALREADY_ACTIVE);

  const stored = await getScanSchedule(key);
  assert.equal(stored.next_run_at, plus(NOW, HOUR), "an in-flight scan is a short wait, not a lost cadence");
  assert.deepEqual(await listDueSchedules(NOW), [], "no longer due right now");
  assert.equal(
    (await listDueSchedules(plus(NOW, HOUR))).length,
    1,
    "due again an hour later — the brand still has not had its SCHEDULED scan"
  );
});

// ---------------------------------------------------------------------------
// 2. What a skip must NOT write.
// ---------------------------------------------------------------------------

test("runSchedulerTick — a skip bumps next_run_at ONLY: last_run_at, cadence and enabled are untouched", async () => {
  const key = await seedRealSchedule({
    brand: "off-co.com",
    display_name: "Off Co",
    cadence: "off",
    enabled: true,
    prompt_target: 60,
    last_run_at: "2026-08-01T00:00:00.000Z",
    next_run_at: null,
  });
  const backend = jobDeps({ upsertScanSchedule });

  await quiet(() => runSchedulerTick(NOW, { ...backend.deps, listDueSchedules, upsertScanSchedule }));

  const stored = await getScanSchedule(key);
  assert.equal(
    stored.last_run_at,
    "2026-08-01T00:00:00.000Z",
    "nothing ran, so the freshness marker must not move — a declined brand must not read as a scanned one"
  );
  assert.equal(stored.cadence, "off", "the scheduler does not get to rewrite operator intent to make its own life easier");
  assert.equal(stored.enabled, true, "…nor to silently unsubscribe the brand");
  assert.equal(stored.prompt_target, 60, "the column-scoped upsert must not blank the rest of the row");
});

test("runSchedulerTick — the bump is keyed on scan_schedules.brand (the domain key), never the display name", async () => {
  const backend = jobDeps();
  await quiet(() =>
    runSchedulerTick(NOW, {
      ...backend.deps,
      listDueSchedules: async () => [
        { brand: "off-co.com", display_name: "Off Co", cadence: "off", enabled: true, next_run_at: null },
      ],
    })
  );

  assert.equal(backend.scheduleWrites.length, 1, "exactly one write for one declined schedule");
  assert.equal(backend.scheduleWrites[0].key, "off-co.com");
  assert.notEqual(backend.scheduleWrites[0].key, "Off Co", "a display-name key would create a second, orphan row");
  assert.deepEqual(
    Object.keys(backend.scheduleWrites[0].updates),
    ["next_run_at"],
    "a skip writes one column. Anything else here is a fact the scheduler is in no position to assert"
  );
});

// ---------------------------------------------------------------------------
// 3. The skip row records the bump it actually made.
// ---------------------------------------------------------------------------

test("runSchedulerTick — the skip row states the clock it moved, before and after", async () => {
  const ledger = makeLedger();
  const backend = jobDeps({ active: new Set(["Busy Co"]) });

  await quiet(() =>
    runSchedulerTick(NOW, {
      ...backend.deps,
      ...ledger.deps,
      listDueSchedules: async () => [
        {
          brand: "busy.com",
          display_name: "Busy Co",
          cadence: "daily",
          enabled: true,
          next_run_at: "2026-09-03T00:00:00.000Z",
        },
      ],
    })
  );

  const [row] = ledger.schedule(SCHEDULER_PHASES.SCHEDULE);
  assert.ok(row, "the R3.2.2 skip row is still written");
  assert.equal(row.runner, RUNNERS.SCHEDULER);
  assert.equal(row.outcome, RUN_OUTCOMES.SKIPPED);
  assert.equal(row.reason, SCHEDULER_SKIP_REASONS.BRAND_ALREADY_ACTIVE);
  assert.equal(row.brand, "Busy Co");
  assert.equal(row.detail.previous_next_run_at, "2026-09-03T00:00:00.000Z");
  assert.equal(row.detail.next_run_at, plus(NOW, HOUR));
  assert.equal(row.detail.backoff_ms, HOUR);
  assert.notEqual(
    row.detail.next_run_at,
    row.detail.previous_next_run_at,
    "a skip row whose two clocks match is the finding: the brand was declined and left due"
  );
});

test("runSchedulerTick — the clock is advanced BEFORE the skip row is opened", async () => {
  // The row's detail asserts the next_run_at that was WRITTEN. Filing it first
  // would let a failed bump leave behind a row claiming a reschedule that never
  // happened — the same false-success shape this phase keeps deleting.
  const ledger = makeLedger();
  const order = [];
  const backend = jobDeps({
    upsertScanSchedule: async () => {
      order.push("upsertScanSchedule");
      return {};
    },
  });

  await quiet(() =>
    runSchedulerTick(NOW, {
      ...backend.deps,
      openScanRun: async (fields) => {
        if (fields.phase === SCHEDULER_PHASES.SCHEDULE) order.push("openSkipRow");
        return ledger.deps.openScanRun(fields);
      },
      heartbeatScanRun: ledger.deps.heartbeatScanRun,
      closeScanRun: ledger.deps.closeScanRun,
      listDueSchedules: async () => [
        { brand: "off-co.com", display_name: "Off Co", cadence: "off", enabled: true, next_run_at: null },
      ],
    })
  );

  assert.deepEqual(order, ["upsertScanSchedule", "openSkipRow"]);
});

// ---------------------------------------------------------------------------
// 4. A bump that cannot be written fails the tick. It is never absorbed.
// ---------------------------------------------------------------------------

test("runSchedulerTick — an upsert that throws on a skip FAILS the tick loudly and files no skip row claiming otherwise", async () => {
  const ledger = makeLedger();
  const backend = jobDeps({
    upsertScanSchedule: async () => {
      throw new Error("scan_schedules upsert refused");
    },
  });

  await quiet(async () => {
    await assert.rejects(
      () =>
        runSchedulerTick(NOW, {
          ...backend.deps,
          ...ledger.deps,
          listDueSchedules: async () => [
            { brand: "off-co.com", display_name: "Off Co", cadence: "off", enabled: true, next_run_at: null },
          ],
        }),
      /scan_schedules upsert refused/,
      "a schedule whose clock could not move will be declined again forever; that must not be swallowed"
    );
  });

  const [tick] = ledger.schedule(SCHEDULER_PHASES.TICK);
  assert.equal(tick.outcome, RUN_OUTCOMES.FAILED);
  assert.equal(tick.reason, SCHEDULER_TICK_REASONS.TICK_FAILED);
  assert.match(tick.error, /scan_schedules upsert refused/);
  assert.deepEqual(
    tick.detail.skips,
    [{ brand: "Off Co", reason: SCHEDULER_SKIP_REASONS.CADENCE_OFF }],
    "the brand is named on the failed tick's row, so the decision is not lost with the bump"
  );
  assert.equal(
    ledger.schedule(SCHEDULER_PHASES.SCHEDULE).length,
    0,
    "no skip row: its detail would have claimed a next_run_at that was never written"
  );
});

// ---------------------------------------------------------------------------
// 5. The backoff table refuses to guess.
// ---------------------------------------------------------------------------

test("computeSkipNextRunAt — a reason with no backoff throws instead of inheriting a default", () => {
  assert.throws(
    () => computeSkipNextRunAt("some_future_reason", NOW),
    /no backoff in SCHEDULER_SKIP_BACKOFF_MS/,
    "a new skip reason must not quietly pick up somebody else's clock"
  );
  assert.throws(() => computeSkipNextRunAt(undefined, NOW), /no backoff/);
});

test("computeSkipNextRunAt — an unparseable `from` throws rather than producing an Invalid Date", () => {
  assert.throws(() => computeSkipNextRunAt(SCHEDULER_SKIP_REASONS.CADENCE_OFF, "not-a-time"), /unparseable time/);
});

test("SCHEDULER_SKIP_BACKOFF_MS — every reason in the closed vocabulary has a positive backoff", () => {
  for (const reason of Object.values(SCHEDULER_SKIP_REASONS)) {
    const ms = SCHEDULER_SKIP_BACKOFF_MS[reason];
    assert.ok(
      Number.isFinite(ms) && ms > 0,
      `skip reason "${reason}" has no usable backoff — it would be declined on every tick forever`
    );
    // …and it really does move the clock past `now`, which is the only property
    // listDueSchedules cares about.
    assert.ok(new Date(computeSkipNextRunAt(reason, NOW)).getTime() > new Date(NOW).getTime());
  }
});

test("SCHEDULER_SKIP_BACKOFF_MS — cadence_off does NOT borrow computeNextRunAt's 72h fallback", () => {
  // computeNextRunAt("off", ...) silently returns now+72h, because 'off' is not
  // in CADENCE_MS. Routing a cadence:'off' skip through it would invent a 72h
  // cadence for a schedule whose stated cadence is "never".
  assert.notEqual(
    computeSkipNextRunAt(SCHEDULER_SKIP_REASONS.CADENCE_OFF, NOW),
    computeNextRunAt("off", NOW),
    "the backoff must be a declared choice, not an unknown-cadence fallback"
  );
  assert.ok(
    SCHEDULER_SKIP_BACKOFF_MS[SCHEDULER_SKIP_REASONS.BRAND_ALREADY_ACTIVE] <
      SCHEDULER_SKIP_BACKOFF_MS[SCHEDULER_SKIP_REASONS.CADENCE_OFF],
    "'already scanning' must come back sooner than 'nobody wants this scanned'"
  );
});

// ---------------------------------------------------------------------------
// 6. The started path is untouched.
// ---------------------------------------------------------------------------

test("runSchedulerTick — a started brand still gets last_run_at + a cadence bump; a skipped one in the same tick gets neither", async () => {
  const backend = jobDeps({ active: new Set(["Busy Co"]) });

  const result = await quiet(() =>
    runSchedulerTick(NOW, {
      ...backend.deps,
      listDueSchedules: async () => [
        { brand: "go.com", display_name: "Go Co", cadence: "daily", enabled: true, next_run_at: null },
        { brand: "busy.com", display_name: "Busy Co", cadence: "daily", enabled: true, next_run_at: null },
      ],
    })
  );

  assert.equal(result.started.length, 1);
  assert.equal(result.skipped.length, 1);

  const wrote = Object.fromEntries(backend.scheduleWrites.map((w) => [w.key, w.updates]));
  assert.equal(wrote["go.com"].last_run_at, NOW, "a scan really ran for this one");
  assert.equal(wrote["go.com"].next_run_at, computeNextRunAt("daily", NOW), "…so it moves by its own cadence");
  assert.equal(wrote["busy.com"].last_run_at, undefined, "nothing ran for this one");
  assert.equal(wrote["busy.com"].next_run_at, plus(NOW, HOUR), "…and it moves by the skip backoff instead");
  assert.notEqual(
    wrote["busy.com"].next_run_at,
    wrote["go.com"].next_run_at,
    "a declined brand and a scanned brand must not end up on the same clock"
  );
});
