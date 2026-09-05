import test from "node:test";
import assert from "node:assert/strict";
import {
  VALID_ENGINES,
  VALID_CADENCES,
  MAX_SERIES_ROWS,
  parseEngineParam,
  parseDateParam,
  computeVisibilitySummary,
  computeNextRunAt,
  validateScheduleBody,
  applyInsertDefaults,
  applyNextRunAt,
} from "./brandAnalyticsApi.js";

/**
 * P0.4 coverage: the pure param-parsing/validation/derivation helpers behind
 * the brand analytics API routes (GET /metrics, GET|PUT /schedule). No DB,
 * no Next.js — these are plain functions exercised directly.
 */

// ---------------------------------------------------------------------------
// parseEngineParam
// ---------------------------------------------------------------------------

test("parseEngineParam — absent/empty defaults to 'all'", () => {
  assert.deepEqual(parseEngineParam(null), { engine: "all", error: null });
  assert.deepEqual(parseEngineParam(undefined), { engine: "all", error: null });
  assert.deepEqual(parseEngineParam(""), { engine: "all", error: null });
});

test("parseEngineParam — accepts every value in VALID_ENGINES, case/whitespace insensitive", () => {
  for (const engine of VALID_ENGINES) {
    assert.deepEqual(parseEngineParam(engine), { engine, error: null });
    assert.deepEqual(parseEngineParam(`  ${engine.toUpperCase()}  `), { engine, error: null });
  }
});

test("parseEngineParam — rejects unknown engine with a listing error message", () => {
  const { engine, error } = parseEngineParam("bing");
  assert.equal(engine, null);
  assert.match(error, /engine must be one of/);
  for (const e of VALID_ENGINES) assert.ok(error.includes(e));
});

// ---------------------------------------------------------------------------
// parseDateParam
// ---------------------------------------------------------------------------

test("parseDateParam — absent/empty means no bound", () => {
  assert.deepEqual(parseDateParam(null, "from"), { date: null, error: null });
  assert.deepEqual(parseDateParam("", "to"), { date: null, error: null });
});

test("parseDateParam — plain YYYY-MM-DD round-trips exactly", () => {
  assert.deepEqual(parseDateParam("2026-07-01", "from"), { date: "2026-07-01", error: null });
});

test("parseDateParam — full ISO datetime truncates to its UTC calendar date", () => {
  assert.deepEqual(parseDateParam("2026-07-01T10:30:00.000Z", "to"), { date: "2026-07-01", error: null });
});

test("parseDateParam — invalid date string errors with the param label", () => {
  const { date, error } = parseDateParam("not-a-date", "from");
  assert.equal(date, null);
  assert.match(error, /^from must be a valid ISO date\.$/);
});

// ---------------------------------------------------------------------------
// computeVisibilitySummary
// ---------------------------------------------------------------------------

test("computeVisibilitySummary — empty series is all-null", () => {
  assert.deepEqual(computeVisibilitySummary([]), {
    latest_date: null,
    latest_visibility_pct: null,
    previous_visibility_pct: null,
    delta_visibility_pct: null,
  });
  assert.deepEqual(computeVisibilitySummary(undefined), {
    latest_date: null,
    latest_visibility_pct: null,
    previous_visibility_pct: null,
    delta_visibility_pct: null,
  });
});

test("computeVisibilitySummary — single point: latest set, previous/delta null", () => {
  const out = computeVisibilitySummary([{ date: "2026-07-01", visibility_pct: 42 }]);
  assert.deepEqual(out, {
    latest_date: "2026-07-01",
    latest_visibility_pct: 42,
    previous_visibility_pct: null,
    delta_visibility_pct: null,
  });
});

test("computeVisibilitySummary — two points: delta is latest minus previous, rounded to 1 decimal", () => {
  const out = computeVisibilitySummary([
    { date: "2026-07-01", visibility_pct: 40.05 },
    { date: "2026-07-02", visibility_pct: 46.37 },
  ]);
  assert.equal(out.latest_date, "2026-07-02");
  assert.equal(out.latest_visibility_pct, 46.37);
  assert.equal(out.previous_visibility_pct, 40.05);
  assert.equal(out.delta_visibility_pct, 6.3); // 46.37 - 40.05 = 6.32 -> rounds to 6.3
});

test("computeVisibilitySummary — only the last two points count when series is longer", () => {
  const out = computeVisibilitySummary([
    { date: "2026-06-01", visibility_pct: 0 },
    { date: "2026-07-01", visibility_pct: 40 },
    { date: "2026-07-02", visibility_pct: 50 },
  ]);
  assert.equal(out.previous_visibility_pct, 40);
  assert.equal(out.delta_visibility_pct, 10);
});

test("computeVisibilitySummary — null visibility_pct on either point makes delta null, not latest", () => {
  const latestNull = computeVisibilitySummary([
    { date: "2026-07-01", visibility_pct: 40 },
    { date: "2026-07-02", visibility_pct: null },
  ]);
  assert.equal(latestNull.latest_visibility_pct, null);
  assert.equal(latestNull.previous_visibility_pct, 40);
  assert.equal(latestNull.delta_visibility_pct, null);

  const previousNull = computeVisibilitySummary([
    { date: "2026-07-01", visibility_pct: null },
    { date: "2026-07-02", visibility_pct: 40 },
  ]);
  assert.equal(previousNull.latest_visibility_pct, 40);
  assert.equal(previousNull.delta_visibility_pct, null);
});

test("computeVisibilitySummary — a REAL null-interleaved series never yields NaN or a 0 delta (R2.1.1/R4.3.2 null-series check)", () => {
  // R2.1.1 made rollup.js write brand_metrics_daily.visibility_pct = null for a
  // not_assessed/failed engine where it previously wrote 0, and R4.3.2 does the
  // same to sov_pct for a self-only roster. Neither had been exercised against
  // a series that actually contains nulls, and a null reaching the subtraction
  // below would produce either NaN (null - 40) or, worse, a plausible-looking
  // number (40 - null === 40). This is the guard for that: no arithmetic runs
  // unless BOTH points are real, so a gap reads as "no delta", never as a move.
  const series = [
    { date: "2026-07-01", visibility_pct: 40 },
    { date: "2026-07-02", visibility_pct: null }, // engine failed that day
    { date: "2026-07-03", visibility_pct: null }, // and again
    { date: "2026-07-04", visibility_pct: 0 }, // measured_zero -- a real number
  ];
  const out = computeVisibilitySummary(series);
  assert.equal(out.latest_visibility_pct, 0, "a measured zero is still a number and still the latest point");
  assert.equal(out.previous_visibility_pct, null);
  assert.equal(out.delta_visibility_pct, null, "no delta across a gap -- never NaN, never a fabricated move");
  assert.ok(!Number.isNaN(out.delta_visibility_pct));

  // And the all-null series: latest is null, nothing is invented for it.
  const allNull = computeVisibilitySummary([
    { date: "2026-07-01", visibility_pct: null },
    { date: "2026-07-02", visibility_pct: null },
    { date: "2026-07-03", visibility_pct: null },
  ]);
  assert.equal(allNull.latest_visibility_pct, null);
  assert.equal(allNull.delta_visibility_pct, null);
  assert.notEqual(allNull.delta_visibility_pct, 0, "an unmeasured stretch is not a flat line");
});

// ---------------------------------------------------------------------------
// computeNextRunAt
// ---------------------------------------------------------------------------

test("computeNextRunAt — 72h/daily/weekly offsets", () => {
  const from = "2026-07-24T00:00:00.000Z";
  const fromMs = new Date(from).getTime();
  assert.equal(computeNextRunAt("72h", from), new Date(fromMs + 72 * 3600 * 1000).toISOString());
  assert.equal(computeNextRunAt("daily", from), new Date(fromMs + 24 * 3600 * 1000).toISOString());
  assert.equal(computeNextRunAt("weekly", from), new Date(fromMs + 7 * 24 * 3600 * 1000).toISOString());
});

test("computeNextRunAt — unknown/missing cadence defaults to 72h (matches scanWorker.js's fallback)", () => {
  const from = "2026-07-24T00:00:00.000Z";
  assert.equal(computeNextRunAt("bogus", from), computeNextRunAt("72h", from));
  assert.equal(computeNextRunAt(undefined, from), computeNextRunAt("72h", from));
});

test("computeNextRunAt — 'off' is null, the one deliberate divergence from scanWorker.js's copy", () => {
  assert.equal(computeNextRunAt("off", "2026-07-24T00:00:00.000Z"), null);
});

test("computeNextRunAt — defaults `fromIso` to now when omitted", () => {
  const before = Date.now();
  const result = computeNextRunAt("daily", undefined);
  const resultMs = new Date(result).getTime();
  assert.ok(resultMs >= before + 24 * 3600 * 1000);
  assert.ok(resultMs <= Date.now() + 24 * 3600 * 1000 + 1000);
});

// ---------------------------------------------------------------------------
// validateScheduleBody
// ---------------------------------------------------------------------------

test("validateScheduleBody — empty object is a valid no-op update", () => {
  assert.deepEqual(validateScheduleBody({}), { error: null, updates: {} });
});

test("validateScheduleBody — rejects non-object bodies", () => {
  for (const bad of [null, undefined, "x", 5, ["a"]]) {
    const { error, updates } = validateScheduleBody(bad);
    assert.match(error, /Request body must be a JSON object\./);
    assert.equal(updates, null);
  }
});

test("validateScheduleBody — cadence must be one of the four allowed values", () => {
  for (const cadence of VALID_CADENCES) {
    assert.deepEqual(validateScheduleBody({ cadence }), { error: null, updates: { cadence } });
  }
  const { error, updates } = validateScheduleBody({ cadence: "hourly" });
  assert.match(error, /cadence must be one of/);
  assert.equal(updates, null);
});

test("validateScheduleBody — enabled must be boolean", () => {
  assert.deepEqual(validateScheduleBody({ enabled: true }), { error: null, updates: { enabled: true } });
  assert.deepEqual(validateScheduleBody({ enabled: false }), { error: null, updates: { enabled: false } });
  const { error, updates } = validateScheduleBody({ enabled: "true" });
  assert.match(error, /enabled must be a boolean\./);
  assert.equal(updates, null);
});

test("validateScheduleBody — prompt_target must be an integer in [10, 100]", () => {
  assert.deepEqual(validateScheduleBody({ prompt_target: 10 }), { error: null, updates: { prompt_target: 10 } });
  assert.deepEqual(validateScheduleBody({ prompt_target: 100 }), { error: null, updates: { prompt_target: 100 } });
  assert.deepEqual(validateScheduleBody({ prompt_target: 30 }), { error: null, updates: { prompt_target: 30 } });

  for (const bad of [9, 101, 30.5, "30", null]) {
    const { error, updates } = validateScheduleBody({ prompt_target: bad });
    assert.match(error, /prompt_target must be an integer between 10 and 100\./);
    assert.equal(updates, null);
  }
});

test("validateScheduleBody — geo must be a non-empty string, trimmed + lowercased", () => {
  assert.deepEqual(validateScheduleBody({ geo: " IN " }), { error: null, updates: { geo: "in" } });
  for (const bad of ["", "   ", 5, null]) {
    const { error, updates } = validateScheduleBody({ geo: bad });
    assert.match(error, /geo must be a non-empty string\./);
    assert.equal(updates, null);
  }
});

test("validateScheduleBody — engines accepts a string or an array of strings, normalizes to a comma-joined string", () => {
  assert.deepEqual(validateScheduleBody({ engines: "aio,chatgpt" }), {
    error: null,
    updates: { engines: "aio,chatgpt" },
  });
  assert.deepEqual(validateScheduleBody({ engines: ["aio", " chatgpt "] }), {
    error: null,
    updates: { engines: "aio,chatgpt" },
  });
  for (const bad of ["", "   ", [], [""], [1, 2], 5, null]) {
    const { error, updates } = validateScheduleBody({ engines: bad });
    assert.match(error, /engines must be a non-empty string or an array of non-empty strings\./);
    assert.equal(updates, null);
  }
});

test("validateScheduleBody — multiple valid fields combine into one updates object", () => {
  const { error, updates } = validateScheduleBody({ cadence: "daily", prompt_target: 50, enabled: true });
  assert.equal(error, null);
  assert.deepEqual(updates, { cadence: "daily", prompt_target: 50, enabled: true });
});

test("validateScheduleBody — first invalid field short-circuits before later fields are read", () => {
  const { error, updates } = validateScheduleBody({ cadence: "bogus", prompt_target: 999 });
  assert.match(error, /cadence must be one of/);
  assert.equal(updates, null);
});

// ---------------------------------------------------------------------------
// applyInsertDefaults
// ---------------------------------------------------------------------------

test("applyInsertDefaults — leaves updates untouched when a schedule already exists", () => {
  const updates = { prompt_target: 50 };
  const out = applyInsertDefaults(updates, { brand: "acme.com", enabled: true });
  assert.equal(out, updates);
});

test("applyInsertDefaults — leaves updates untouched when the caller explicitly set enabled", () => {
  const updates = { enabled: true };
  const out = applyInsertDefaults(updates, null);
  assert.equal(out, updates);
});

test("applyInsertDefaults — defaults enabled:false on first-ever write when enabled wasn't specified", () => {
  const out = applyInsertDefaults({ prompt_target: 50 }, null);
  assert.deepEqual(out, { prompt_target: 50, enabled: false });
});

// ---------------------------------------------------------------------------
// applyNextRunAt
// ---------------------------------------------------------------------------

test("applyNextRunAt — cadence change recomputes next_run_at from the new cadence", () => {
  const nowIso = "2026-07-24T00:00:00.000Z";
  const out = applyNextRunAt({ cadence: "daily" }, { cadence: "72h" }, nowIso);
  assert.equal(out.next_run_at, computeNextRunAt("daily", nowIso));
});

test("applyNextRunAt — cadence:'off' clears next_run_at to null even if also enabling", () => {
  const nowIso = "2026-07-24T00:00:00.000Z";
  const out = applyNextRunAt({ cadence: "off", enabled: true }, { cadence: "72h" }, nowIso);
  assert.equal(out.next_run_at, null);
});

test("applyNextRunAt — enabling without a cadence change falls back to the existing cadence", () => {
  const nowIso = "2026-07-24T00:00:00.000Z";
  const out = applyNextRunAt({ enabled: true }, { cadence: "weekly" }, nowIso);
  assert.equal(out.next_run_at, computeNextRunAt("weekly", nowIso));
});

test("applyNextRunAt — enabling with no existing schedule falls back to the 72h default", () => {
  const nowIso = "2026-07-24T00:00:00.000Z";
  const out = applyNextRunAt({ enabled: true }, null, nowIso);
  assert.equal(out.next_run_at, computeNextRunAt("72h", nowIso));
});

test("applyNextRunAt — disabling alone (no cadence change) leaves next_run_at untouched", () => {
  const updates = { enabled: false };
  const out = applyNextRunAt(updates, { cadence: "72h", next_run_at: "2026-08-01T00:00:00.000Z" });
  assert.equal(out, updates);
  assert.equal(Object.prototype.hasOwnProperty.call(out, "next_run_at"), false);
});

test("applyNextRunAt — unrelated field changes (prompt_target/geo/engines) leave next_run_at untouched", () => {
  const updates = { prompt_target: 60 };
  const out = applyNextRunAt(updates, { cadence: "72h" });
  assert.equal(out, updates);
});
