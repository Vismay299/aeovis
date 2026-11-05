import test from "node:test";
import assert from "node:assert/strict";
import {
  upsertPromptResults,
  insertCitations,
  insertResultBrands,
  deleteResultBrandsForJob,
  stampScanIdForJob,
  upsertBrandMetricsDaily,
  getPromptResultsForJob,
  getCompletedPairsForJob,
  getPromptMetrics,
  getBrandMetricsSeries,
  getBrandMetricSources,
  getScanSchedule,
  upsertScanSchedule,
  listDueSchedules,
  getCitationsForBrand,
  getResultBrandsForBrand,
} from "./analytics.js";

/**
 * P0.1b coverage: every function here must be DB-authoritative and fail-loud
 * whenever a client is configured, and keep the in-memory dev/test path
 * working when it isn't — same contract as db.test.mjs (P0.0). This file
 * copies that file's mock-query-builder approach (a fake Supabase client
 * whose `.from(table)` returns a chainable, thenable builder) and extends it
 * with the operators this module needs beyond scan_jobs: `.upsert()`,
 * `.gte()`, `.lte()`, `.is()`, `.order()`.
 */

// --- fake Supabase client harness -------------------------------------------

/**
 * Mimics just enough of supabase-js's chainable query builder: `.from(table)`
 * returns a builder whose filter/op methods record themselves and return
 * `this`; awaiting the builder resolves through the per-table handler you
 * provide. `calls` records every operation actually sent to the "client" so
 * tests can assert the DB path (not memory) was used, and inspect things
 * like the exact `onConflict` target passed to `.upsert()`.
 */
function makeMockClient(tableHandlers) {
  const calls = [];
  const client = {
    from(table) {
      const state = {
        table,
        op: null,
        values: null,
        filters: [],
        orderCol: null,
        orderAsc: null,
        limitN: null,
        upsertOpts: null,
      };
      const builder = {
        insert(rows) {
          state.op = "insert";
          state.values = rows;
          return builder;
        },
        update(vals) {
          state.op = "update";
          state.values = vals;
          return builder;
        },
        delete() {
          state.op = "delete";
          return builder;
        },
        upsert(rows, opts) {
          state.op = "upsert";
          state.values = rows;
          state.upsertOpts = opts || null;
          return builder;
        },
        select(cols) {
          if (!state.op) state.op = "select";
          state.selectCols = cols;
          return builder;
        },
        eq(col, val) {
          state.filters.push(["eq", col, val]);
          return builder;
        },
        in(col, vals) {
          state.filters.push(["in", col, vals]);
          return builder;
        },
        gte(col, val) {
          state.filters.push(["gte", col, val]);
          return builder;
        },
        lte(col, val) {
          state.filters.push(["lte", col, val]);
          return builder;
        },
        lt(col, val) {
          // P3a — getCitationsForBrand's exclusive "to" bound (endOfDayIso).
          state.filters.push(["lt", col, val]);
          return builder;
        },
        is(col, val) {
          state.filters.push(["is", col, val]);
          return builder;
        },
        order(col, opts) {
          state.orderCol = col;
          state.orderAsc = !opts || opts.ascending !== false;
          return builder;
        },
        limit(n) {
          state.limitN = n;
          return builder;
        },
        then(resolve, reject) {
          calls.push({
            table: state.table,
            op: state.op,
            filters: [...state.filters],
            values: state.values,
            upsertOpts: state.upsertOpts,
          });
          const handler = tableHandlers[table];
          if (!handler) {
            reject(new Error(`no mock handler for table "${table}"`));
            return;
          }
          Promise.resolve()
            .then(() => handler(state))
            .then(resolve, reject);
        },
      };
      return builder;
    },
  };
  return { client, calls };
}

function matchesFilters(row, filters) {
  return filters.every(([kind, col, val]) => {
    const cell = row[col];
    switch (kind) {
      case "eq":
        return cell === val;
      case "in":
        return Array.isArray(val) && val.includes(cell);
      case "gte":
        return cell != null && cell >= val;
      case "lte":
        return cell != null && cell <= val;
      case "lt":
        return cell != null && cell < val;
      case "is":
        return val === null ? cell == null : cell === val;
      default:
        return true;
    }
  });
}

/**
 * A minimal in-process stand-in for a single Postgres table, driven through
 * the same `state` shape makeMockClient hands to table handlers. Reuses just
 * enough relational semantics (filter matching, upsert-on-conflict, order,
 * select-after-write) to exercise the real hasDb=true code paths without a
 * network call — not a general PostgREST emulator.
 */
function makeFakeTable(initialRows = []) {
  const rows = initialRows.map((r) => ({ ...r }));
  let counter = 0;

  function handler(state) {
    if (state.op === "insert") {
      const inserted = (Array.isArray(state.values) ? state.values : [state.values]).map((v) => ({
        id: v.id || `fake-id-${counter++}`,
        ...v,
      }));
      rows.push(...inserted);
      return { data: inserted, error: null };
    }

    if (state.op === "upsert") {
      const conflictCols = (state.upsertOpts?.onConflict || "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      const values = Array.isArray(state.values) ? state.values : [state.values];
      const out = [];
      for (const v of values) {
        const match = conflictCols.length
          ? rows.find((r) => conflictCols.every((c) => r[c] === v[c]))
          : undefined;
        if (match) {
          Object.assign(match, v);
          out.push(match);
        } else {
          const created = { id: v.id || `fake-id-${counter++}`, ...v };
          rows.push(created);
          out.push(created);
        }
      }
      return { data: out, error: null };
    }

    if (state.op === "update") {
      const matched = rows.filter((r) => matchesFilters(r, state.filters));
      matched.forEach((r) => Object.assign(r, state.values));
      return { data: matched, error: null };
    }

    if (state.op === "delete") {
      const matched = rows.filter((r) => matchesFilters(r, state.filters));
      const matchedIds = new Set(matched.map((r) => r.id));
      for (let i = rows.length - 1; i >= 0; i--) {
        if (matchedIds.has(rows[i].id)) rows.splice(i, 1);
      }
      return { data: matched, error: null };
    }

    // select
    let result = rows.filter((r) => matchesFilters(r, state.filters));
    if (state.orderCol) {
      const col = state.orderCol;
      const asc = state.orderAsc;
      result = [...result].sort((a, b) => {
        if (a[col] < b[col]) return asc ? -1 : 1;
        if (a[col] > b[col]) return asc ? 1 : -1;
        return 0;
      });
    }
    if (state.limitN != null) result = result.slice(0, state.limitN);
    return { data: result, error: null };
  }

  return { handler, rows };
}

// =============================================================================
// prompt_results
// =============================================================================

test("upsertPromptResults — empty array is a no-op (hasDb=true, no network call)", async () => {
  const { client, calls } = makeMockClient({});
  assert.deepEqual(await upsertPromptResults([], { client }), []);
  assert.equal(calls.length, 0);
});

test("upsertPromptResults — empty array is a no-op (hasDb=false, memory untouched)", async () => {
  const before = global.memoryPromptResults.size;
  assert.deepEqual(await upsertPromptResults([], { client: null }), []);
  assert.equal(global.memoryPromptResults.size, before);
});

test("upsertPromptResults — hasDb=true: upserts with onConflict job_id,engine,query and returns rows with ids", async () => {
  const table = makeFakeTable();
  const { client, calls } = makeMockClient({ prompt_results: table.handler });

  const rows = [
    { job_id: "job-1", engine: "aio", query: "best coffee", brand: "acme.com", answered: true },
    { job_id: "job-1", engine: "chatgpt", query: "best coffee", brand: "acme.com", answered: true },
  ];
  const result = await upsertPromptResults(rows, { client });

  assert.equal(result.length, 2);
  assert.ok(result[0].id, "returned rows must carry an id");
  assert.ok(result[1].id);

  const upsertCall = calls.find((c) => c.op === "upsert");
  assert.ok(upsertCall, "must call upsert, not insert");
  assert.deepEqual(upsertCall.upsertOpts, { onConflict: "job_id,engine,query" });
});

test("upsertPromptResults — hasDb=true: re-running a chunk upserts the same row instead of duplicating (D5)", async () => {
  const table = makeFakeTable();
  const { client } = makeMockClient({ prompt_results: table.handler });

  await upsertPromptResults([{ job_id: "job-1", engine: "aio", query: "q1", answered: false }], { client });
  const second = await upsertPromptResults(
    [{ job_id: "job-1", engine: "aio", query: "q1", answered: true }],
    { client }
  );

  assert.equal(table.rows.length, 1, "must not duplicate the row on re-upsert");
  assert.equal(second[0].answered, true);
});

test("upsertPromptResults — hasDb=true: a DB error THROWS, never falls back to memory", async () => {
  const before = global.memoryPromptResults.size;
  const { client } = makeMockClient({
    prompt_results: () => ({ data: null, error: new Error("upsert failed") }),
  });
  await assert.rejects(
    () => upsertPromptResults([{ job_id: "job-x", engine: "aio", query: "q" }], { client }),
    /upsert failed/
  );
  assert.equal(global.memoryPromptResults.size, before, "must not poison the memory map on DB failure");
});

test("upsertPromptResults — hasDb=false: dedupes on (job_id, engine, query) in memory", async () => {
  await upsertPromptResults([{ job_id: "mem-job-1", engine: "aio", query: "q1", answered: false }], {
    client: null,
  });
  const second = await upsertPromptResults(
    [{ job_id: "mem-job-1", engine: "aio", query: "q1", answered: true }],
    { client: null }
  );

  const stored = Array.from(global.memoryPromptResults.values()).filter((r) => r.job_id === "mem-job-1");
  assert.equal(stored.length, 1, "must not duplicate in memory");
  assert.equal(stored[0].answered, true);
  assert.equal(second[0].id, stored[0].id);
});

test("getPromptResultsForJob — hasDb=true: returns all rows for the job, ordered by created_at asc", async () => {
  const table = makeFakeTable([
    { id: "r1", job_id: "job-order", engine: "aio", query: "q1", created_at: "2026-01-01T00:00:02Z" },
    { id: "r2", job_id: "job-order", engine: "aio", query: "q2", created_at: "2026-01-01T00:00:01Z" },
    { id: "r3", job_id: "other", engine: "aio", query: "q3", created_at: "2026-01-01T00:00:00Z" },
  ]);
  const { client } = makeMockClient({ prompt_results: table.handler });
  const rows = await getPromptResultsForJob("job-order", { client });
  assert.deepEqual(rows.map((r) => r.id), ["r2", "r1"]);
});

test("getPromptResultsForJob — hasDb=true: a DB error THROWS", async () => {
  const { client } = makeMockClient({
    prompt_results: () => ({ data: null, error: new Error("select failed") }),
  });
  await assert.rejects(() => getPromptResultsForJob("job-x", { client }), /select failed/);
});

test("getPromptResultsForJob — hasDb=false: memory path filters by job_id", async () => {
  await upsertPromptResults([{ job_id: "mem-get-job", engine: "aio", query: "q1" }], { client: null });
  const rows = await getPromptResultsForJob("mem-get-job", { client: null });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].query, "q1");
});

test("getCompletedPairsForJob — hasDb=true: returns the completed (engine|query) Set, supports resume-skip", async () => {
  const table = makeFakeTable([
    { id: "r1", job_id: "job-resume", engine: "aio", query: "q1" },
    { id: "r2", job_id: "job-resume", engine: "chatgpt", query: "q1" },
    { id: "r3", job_id: "job-resume", engine: "aio", query: "q2" },
    { id: "r4", job_id: "other-job", engine: "aio", query: "q1" }, // different job — must be excluded
  ]);
  const { client } = makeMockClient({ prompt_results: table.handler });

  const completed = await getCompletedPairsForJob("job-resume", { client });
  assert.ok(completed instanceof Set);
  assert.equal(completed.size, 3);
  assert.ok(completed.has("aio|q1"));
  assert.ok(completed.has("chatgpt|q1"));
  assert.ok(completed.has("aio|q2"));

  // Resume-skip: the worklist minus completed pairs is only the unfinished work.
  const worklist = [
    ["aio", "q1"],
    ["chatgpt", "q1"],
    ["aio", "q2"],
    ["chatgpt", "q2"],
    ["perplexity", "q1"],
  ];
  const remaining = worklist.filter(([engine, query]) => !completed.has(`${engine}|${query}`));
  assert.deepEqual(remaining, [
    ["chatgpt", "q2"],
    ["perplexity", "q1"],
  ]);
});

test("getCompletedPairsForJob — hasDb=true: a DB error THROWS", async () => {
  const { client } = makeMockClient({
    prompt_results: () => ({ data: null, error: new Error("select failed") }),
  });
  await assert.rejects(() => getCompletedPairsForJob("job-x", { client }), /select failed/);
});

test("getCompletedPairsForJob — hasDb=false: memory path returns the same Set shape", async () => {
  await upsertPromptResults(
    [
      { job_id: "mem-resume", engine: "aio", query: "q1" },
      { job_id: "mem-resume", engine: "chatgpt", query: "q2" },
    ],
    { client: null }
  );
  const completed = await getCompletedPairsForJob("mem-resume", { client: null });
  assert.equal(completed.size, 2);
  assert.ok(completed.has("aio|q1"));
  assert.ok(completed.has("chatgpt|q2"));
});

// =============================================================================
// getPromptMetrics (P2a) — scan selection (delegates to promptMetrics.js's
// pickScanIds, unit-tested on its own in promptMetrics.test.mjs) + the
// brand/scan_id-scoped row fetch.
// =============================================================================

function seedPromptMetricsTable() {
  return makeFakeTable([
    { id: "pm1", brand: "acme.com", scan_id: "scan-1", engine: "aio", query: "q1", answered: true, mentioned: true, created_at: "2026-07-01T00:00:00.000Z" },
    { id: "pm2", brand: "acme.com", scan_id: "scan-2", engine: "aio", query: "q1", answered: true, mentioned: false, created_at: "2026-07-10T00:00:00.000Z" },
    { id: "pm3", brand: "acme.com", scan_id: "scan-3", engine: "aio", query: "q1", answered: true, mentioned: true, created_at: "2026-07-20T00:00:00.000Z" },
    { id: "pm4", brand: "other.com", scan_id: "scan-9", engine: "aio", query: "q9", answered: true, mentioned: true, created_at: "2026-07-25T00:00:00.000Z" },
  ]);
}

test("getPromptMetrics — hasDb=true: no scanId requested -> picks the two most recent scans for the brand", async () => {
  const table = seedPromptMetricsTable();
  const { client } = makeMockClient({ prompt_results: table.handler });

  const result = await getPromptMetrics("acme.com", {}, { client });
  assert.equal(result.scanId, "scan-3");
  assert.equal(result.prevScanId, "scan-2");
  assert.deepEqual(result.rows.map((r) => r.id).sort(), ["pm2", "pm3"]);
  assert.ok(result.rows.every((r) => r.brand === "acme.com"), "must never leak another brand's rows");
});

test("getPromptMetrics — hasDb=true: a requested scanId resolves its OWN previous scan, not the true latest", async () => {
  const table = seedPromptMetricsTable();
  const { client } = makeMockClient({ prompt_results: table.handler });

  const result = await getPromptMetrics("acme.com", { scanId: "scan-2" }, { client });
  assert.equal(result.scanId, "scan-2");
  assert.equal(result.prevScanId, "scan-1");
  assert.deepEqual(result.rows.map((r) => r.id).sort(), ["pm1", "pm2"]);
});

test("getPromptMetrics — hasDb=true: the brand's OLDEST scan has no previous scan -> prevScanId null, rows scoped to just it", async () => {
  const table = seedPromptMetricsTable();
  const { client } = makeMockClient({ prompt_results: table.handler });

  const result = await getPromptMetrics("acme.com", { scanId: "scan-1" }, { client });
  assert.equal(result.scanId, "scan-1");
  assert.equal(result.prevScanId, null);
  assert.deepEqual(result.rows.map((r) => r.id), ["pm1"]);
});

test("getPromptMetrics — hasDb=true: a brand with zero prompt_results -> nulls + empty rows, no second query fired", async () => {
  const { client, calls } = makeMockClient({ prompt_results: makeFakeTable().handler });

  const result = await getPromptMetrics("never-scanned.com", {}, { client });
  assert.deepEqual(result, { scanId: null, prevScanId: null, rows: [] });
  assert.equal(calls.length, 1, "must not fire a second (wasted) query once the scan-id listing comes back empty");
});

test("getPromptMetrics — hasDb=true: a DB error on the scan-id listing THROWS", async () => {
  const { client } = makeMockClient({
    prompt_results: () => ({ data: null, error: new Error("scan listing failed") }),
  });
  await assert.rejects(() => getPromptMetrics("acme.com", {}, { client }), /scan listing failed/);
});

test("getPromptMetrics — hasDb=true: a DB error on the rows fetch (after scan-id listing succeeds) THROWS", async () => {
  let call = 0;
  const { client } = makeMockClient({
    prompt_results: () => {
      call += 1;
      if (call === 1) {
        return { data: [{ scan_id: "scan-1", created_at: "2026-07-01T00:00:00.000Z" }], error: null };
      }
      return { data: null, error: new Error("rows fetch failed") };
    },
  });
  await assert.rejects(() => getPromptMetrics("acme.com", {}, { client }), /rows fetch failed/);
});

test("getPromptMetrics — hasDb=false: memory path picks latest+previous scan and scopes rows to the brand", async () => {
  await upsertPromptResults(
    [
      { job_id: "mem-pm-j1", brand: "mem-pm.com", scan_id: "mscan-1", engine: "aio", query: "q1", answered: true, mentioned: true, created_at: "2026-07-01T00:00:00.000Z" },
      { job_id: "mem-pm-j2", brand: "mem-pm.com", scan_id: "mscan-2", engine: "aio", query: "q1", answered: true, mentioned: false, created_at: "2026-07-10T00:00:00.000Z" },
      { job_id: "mem-pm-j3", brand: "mem-pm-other.com", scan_id: "mscan-9", engine: "aio", query: "q9", created_at: "2026-07-15T00:00:00.000Z" },
    ],
    { client: null }
  );

  const result = await getPromptMetrics("mem-pm.com", {}, { client: null });
  assert.equal(result.scanId, "mscan-2");
  assert.equal(result.prevScanId, "mscan-1");
  assert.equal(result.rows.length, 2);
  assert.ok(result.rows.every((r) => r.brand === "mem-pm.com"));
});

test("getPromptMetrics — hasDb=false: a brand with zero prompt_results returns nulls and an empty rows array", async () => {
  const result = await getPromptMetrics("mem-pm-empty.com", {}, { client: null });
  assert.deepEqual(result, { scanId: null, prevScanId: null, rows: [] });
});

// =============================================================================
// citations
// =============================================================================

test("insertCitations — empty array is a no-op (hasDb=true and hasDb=false)", async () => {
  const { client, calls } = makeMockClient({});
  assert.deepEqual(await insertCitations([], { client }), []);
  assert.equal(calls.length, 0);
  assert.deepEqual(await insertCitations([], { client: null }), []);
});

test("insertCitations — hasDb=true: bulk inserts and returns rows with ids", async () => {
  const table = makeFakeTable();
  const { client } = makeMockClient({ citations: table.handler });
  const rows = [
    { result_id: "r1", job_id: "job-1", url: "https://a.com/x", domain: "a.com" },
    { result_id: "r1", job_id: "job-1", url: "https://b.com/y", domain: "b.com" },
  ];
  const result = await insertCitations(rows, { client });
  assert.equal(result.length, 2);
  assert.ok(result.every((r) => r.id));
  assert.equal(table.rows.length, 2);
});

test("insertCitations — hasDb=true: a DB error THROWS, never falls back to memory", async () => {
  const before = global.memoryCitations.size;
  const { client } = makeMockClient({
    citations: () => ({ data: null, error: new Error("insert failed") }),
  });
  await assert.rejects(() => insertCitations([{ url: "https://x.com" }], { client }), /insert failed/);
  assert.equal(global.memoryCitations.size, before);
});

test("insertCitations — hasDb=false: stores in memory with generated ids", async () => {
  const result = await insertCitations(
    [{ job_id: "mem-cit", url: "https://x.com", domain: "x.com" }],
    { client: null }
  );
  assert.equal(result.length, 1);
  assert.ok(result[0].id);
  assert.equal(global.memoryCitations.get(result[0].id).domain, "x.com");
});

// =============================================================================
// citations: getCitationsForBrand (P3a)
// =============================================================================

function seedCitationsTable() {
  return makeFakeTable([
    { id: "c1", brand: "acme.com", domain: "a.com", url: "https://a.com/1", created_at: "2026-07-01T00:00:00.000Z" },
    { id: "c2", brand: "acme.com", domain: "b.com", url: "https://b.com/1", created_at: "2026-07-02T12:00:00.000Z" },
    { id: "c3", brand: "acme.com", domain: "c.com", url: "https://c.com/1", created_at: "2026-07-03T23:59:59.000Z" },
    { id: "c4", brand: "other.com", domain: "z.com", url: "https://z.com/1", created_at: "2026-07-02T00:00:00.000Z" },
  ]);
}

test("getCitationsForBrand — hasDb=true: filters by brand, orders most-recent-first", async () => {
  const table = seedCitationsTable();
  const { client } = makeMockClient({ citations: table.handler });

  const rows = await getCitationsForBrand("acme.com", {}, { client });
  assert.deepEqual(rows.map((r) => r.id), ["c3", "c2", "c1"]);
  assert.ok(rows.every((r) => r.brand === "acme.com"));
});

test("getCitationsForBrand — hasDb=true: from/to are inclusive of the WHOLE day on both ends (timestamptz, not a plain date column)", async () => {
  const table = seedCitationsTable();
  const { client } = makeMockClient({ citations: table.handler });

  // to="2026-07-02" must still include c2's 12:00 timestamp AND would include
  // any row up to (but not including) 2026-07-03T00:00:00Z.
  const rows = await getCitationsForBrand("acme.com", { from: "2026-07-02", to: "2026-07-02" }, { client });
  assert.deepEqual(rows.map((r) => r.id), ["c2"]);
});

test("getCitationsForBrand — hasDb=true: to='2026-07-03' includes a row timestamped 23:59:59 that same day", async () => {
  const table = seedCitationsTable();
  const { client } = makeMockClient({ citations: table.handler });
  const rows = await getCitationsForBrand("acme.com", { to: "2026-07-03" }, { client });
  assert.deepEqual(rows.map((r) => r.id).sort(), ["c1", "c2", "c3"]);
});

test("getCitationsForBrand — hasDb=true: respects a caller-supplied limit", async () => {
  const table = seedCitationsTable();
  const { client } = makeMockClient({ citations: table.handler });
  const rows = await getCitationsForBrand("acme.com", { limit: 1 }, { client });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, "c3"); // most recent
});

test("getCitationsForBrand — hasDb=true: a DB error THROWS", async () => {
  const { client } = makeMockClient({
    citations: () => ({ data: null, error: new Error("select failed") }),
  });
  await assert.rejects(() => getCitationsForBrand("x.com", {}, { client }), /select failed/);
});

test("getCitationsForBrand — hasDb=false: memory path applies the same brand + from/to filters", async () => {
  await insertCitations(
    [
      { brand: "mem-cit-brand.com", domain: "a.com", url: "https://a.com/1", created_at: "2026-07-01T00:00:00.000Z" },
      { brand: "mem-cit-brand.com", domain: "b.com", url: "https://b.com/1", created_at: "2026-07-02T12:00:00.000Z" },
      { brand: "mem-cit-other.com", domain: "z.com", url: "https://z.com/1", created_at: "2026-07-02T00:00:00.000Z" },
    ],
    { client: null }
  );
  const rows = await getCitationsForBrand("mem-cit-brand.com", { from: "2026-07-02" }, { client: null });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].domain, "b.com");
});

// =============================================================================
// result_brands
// =============================================================================

test("insertResultBrands — empty array is a no-op", async () => {
  const { client, calls } = makeMockClient({});
  assert.deepEqual(await insertResultBrands([], { client }), []);
  assert.equal(calls.length, 0);
});

test("insertResultBrands — hasDb=true: bulk inserts and returns rows with ids", async () => {
  const table = makeFakeTable();
  const { client } = makeMockClient({ result_brands: table.handler });
  const rows = [
    { result_id: "r1", brand: "acme.com", name: "Acme", is_self: true, mentioned: true },
    { result_id: "r1", brand: "acme.com", name: "Rival Co", is_self: false, mentioned: true },
  ];
  const result = await insertResultBrands(rows, { client });
  assert.equal(result.length, 2);
  assert.ok(result.every((r) => r.id));
});

test("insertResultBrands — hasDb=true: a DB error THROWS, never falls back to memory", async () => {
  const before = global.memoryResultBrands.size;
  const { client } = makeMockClient({
    result_brands: () => ({ data: null, error: new Error("insert failed") }),
  });
  await assert.rejects(() => insertResultBrands([{ brand: "acme.com", name: "Acme" }], { client }), /insert failed/);
  assert.equal(global.memoryResultBrands.size, before);
});

test("insertResultBrands — hasDb=false: stores in memory with generated ids", async () => {
  const result = await insertResultBrands([{ result_id: "r1", brand: "acme.com", name: "Acme" }], {
    client: null,
  });
  assert.ok(result[0].id);
  assert.equal(global.memoryResultBrands.get(result[0].id).name, "Acme");
});

// =============================================================================
// result_brands: deleteResultBrandsForJob (P1.2) — joins through prompt_results
// since result_brands has no job_id column of its own.
// =============================================================================

test("deleteResultBrandsForJob — hasDb=true: deletes only result_brands rows whose result_id belongs to this job's prompt_results", async () => {
  const prTable = makeFakeTable([
    { id: "r1", job_id: "job-rb", engine: "aio", query: "q1" },
    { id: "r2", job_id: "job-rb", engine: "aio", query: "q2" },
    { id: "r3", job_id: "other-job", engine: "aio", query: "q3" },
  ]);
  const rbTable = makeFakeTable([
    { id: "b1", result_id: "r1", name: "Acme" },
    { id: "b2", result_id: "r1", name: "Rival" },
    { id: "b3", result_id: "r2", name: "Acme" },
    { id: "b4", result_id: "r3", name: "Acme" }, // belongs to a different job -> must survive
  ]);
  const { client } = makeMockClient({ prompt_results: prTable.handler, result_brands: rbTable.handler });

  const deletedCount = await deleteResultBrandsForJob("job-rb", { client });

  assert.equal(deletedCount, 3);
  assert.equal(rbTable.rows.length, 1);
  assert.equal(rbTable.rows[0].id, "b4");
});

test("deleteResultBrandsForJob — hasDb=true: no prompt_results rows for the job -> no-op, returns 0, never queries result_brands", async () => {
  const prTable = makeFakeTable([{ id: "r1", job_id: "other-job" }]);
  const { client, calls } = makeMockClient({
    prompt_results: prTable.handler,
    result_brands: () => {
      throw new Error("must not be called when there are no result ids to delete");
    },
  });

  const deletedCount = await deleteResultBrandsForJob("job-empty", { client });
  assert.equal(deletedCount, 0);
  assert.ok(!calls.some((c) => c.table === "result_brands"), "result_brands must never be queried when the job has no prompt_results");
});

test("deleteResultBrandsForJob — hasDb=true: a DB error on the prompt_results lookup THROWS", async () => {
  const { client } = makeMockClient({
    prompt_results: () => ({ data: null, error: new Error("select failed") }),
  });
  await assert.rejects(() => deleteResultBrandsForJob("job-x", { client }), /select failed/);
});

test("deleteResultBrandsForJob — hasDb=true: a DB error on the result_brands delete THROWS", async () => {
  const prTable = makeFakeTable([{ id: "r1", job_id: "job-x" }]);
  const { client } = makeMockClient({
    prompt_results: prTable.handler,
    result_brands: () => ({ data: null, error: new Error("delete failed") }),
  });
  await assert.rejects(() => deleteResultBrandsForJob("job-x", { client }), /delete failed/);
});

test("deleteResultBrandsForJob — hasDb=false: memory mode mirrors the job_id -> result_id join", async () => {
  await upsertPromptResults(
    [
      { job_id: "mem-rb-job", engine: "aio", query: "q1" },
      { job_id: "mem-rb-job", engine: "aio", query: "q2" },
      { job_id: "mem-rb-other", engine: "aio", query: "q3" },
    ],
    { client: null }
  );
  const jobRows = Array.from(global.memoryPromptResults.values()).filter((r) => r.job_id === "mem-rb-job");
  const otherRows = Array.from(global.memoryPromptResults.values()).filter((r) => r.job_id === "mem-rb-other");

  await insertResultBrands(
    [
      { result_id: jobRows[0].id, brand: "acme.com", name: "Acme" },
      { result_id: jobRows[1].id, brand: "acme.com", name: "Rival" },
      { result_id: otherRows[0].id, brand: "acme.com", name: "Acme" }, // different job -> must survive
    ],
    { client: null }
  );

  const before = global.memoryResultBrands.size;
  const deletedCount = await deleteResultBrandsForJob("mem-rb-job", { client: null });
  assert.equal(deletedCount, 2);
  assert.equal(global.memoryResultBrands.size, before - 2);
  assert.ok(
    Array.from(global.memoryResultBrands.values()).some((r) => r.result_id === otherRows[0].id),
    "the other job's result_brands row must be untouched"
  );
});

test("deleteResultBrandsForJob — empty-safe: a job with prompt_results but no result_brands rows returns 0", async () => {
  await upsertPromptResults([{ job_id: "mem-rb-none", engine: "aio", query: "q1" }], { client: null });
  const deletedCount = await deleteResultBrandsForJob("mem-rb-none", { client: null });
  assert.equal(deletedCount, 0);
});

// =============================================================================
// result_brands: getResultBrandsForBrand (P3a — gaps endpoint's join)
// =============================================================================

test("getResultBrandsForBrand — hasDb=true: filters by brand only (no date bounds — see the function's own docstring)", async () => {
  const table = makeFakeTable([
    { id: "rb1", brand: "acme.com", result_id: "r1", name: "Acme", is_self: true, mentioned: true },
    { id: "rb2", brand: "acme.com", result_id: "r1", name: "RivalCo", is_self: false, mentioned: true },
    { id: "rb3", brand: "other.com", result_id: "r9", name: "SomeoneElse", is_self: true, mentioned: true },
  ]);
  const { client } = makeMockClient({ result_brands: table.handler });

  const rows = await getResultBrandsForBrand("acme.com", {}, { client });
  assert.equal(rows.length, 2);
  assert.ok(rows.every((r) => r.brand === "acme.com"));
});

test("getResultBrandsForBrand — hasDb=true: respects a caller-supplied limit", async () => {
  const table = makeFakeTable([
    { id: "rb1", brand: "acme.com", result_id: "r1", name: "Acme" },
    { id: "rb2", brand: "acme.com", result_id: "r2", name: "RivalCo" },
  ]);
  const { client } = makeMockClient({ result_brands: table.handler });
  const rows = await getResultBrandsForBrand("acme.com", { limit: 1 }, { client });
  assert.equal(rows.length, 1);
});

test("getResultBrandsForBrand — hasDb=true: a DB error THROWS", async () => {
  const { client } = makeMockClient({
    result_brands: () => ({ data: null, error: new Error("select failed") }),
  });
  await assert.rejects(() => getResultBrandsForBrand("x.com", {}, { client }), /select failed/);
});

test("getResultBrandsForBrand — hasDb=false: memory path filters by brand only", async () => {
  await insertResultBrands(
    [
      { brand: "mem-rbf-brand.com", result_id: "r1", name: "Acme", is_self: true, mentioned: true },
      { brand: "mem-rbf-other.com", result_id: "r9", name: "SomeoneElse", is_self: true, mentioned: true },
    ],
    { client: null }
  );
  const rows = await getResultBrandsForBrand("mem-rbf-brand.com", {}, { client: null });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, "Acme");
});

// =============================================================================
// finalize: stampScanIdForJob
// =============================================================================

test("stampScanIdForJob — hasDb=true: updates only null-scan_id prompt_results/citations rows for the job", async () => {
  const prTable = makeFakeTable([
    { id: "pr1", job_id: "job-finalize", scan_id: null },
    { id: "pr2", job_id: "job-finalize", scan_id: "already-stamped" },
    { id: "pr3", job_id: "other-job", scan_id: null },
  ]);
  const citTable = makeFakeTable([
    { id: "c1", job_id: "job-finalize", scan_id: null },
    { id: "c2", job_id: "job-finalize", scan_id: "already-stamped" },
    { id: "c3", job_id: "other-job", scan_id: null },
  ]);
  const { client } = makeMockClient({ prompt_results: prTable.handler, citations: citTable.handler });

  const result = await stampScanIdForJob("job-finalize", "scan-99", { client });

  assert.deepEqual(result, { promptResults: 1, citations: 1 });
  assert.equal(prTable.rows.find((r) => r.id === "pr1").scan_id, "scan-99");
  assert.equal(
    prTable.rows.find((r) => r.id === "pr2").scan_id,
    "already-stamped",
    "already-stamped row must be untouched"
  );
  assert.equal(prTable.rows.find((r) => r.id === "pr3").scan_id, null, "different job must be untouched");
  assert.equal(citTable.rows.find((r) => r.id === "c1").scan_id, "scan-99");
  assert.equal(citTable.rows.find((r) => r.id === "c2").scan_id, "already-stamped");
  assert.equal(citTable.rows.find((r) => r.id === "c3").scan_id, null, "different job must be untouched");
});

test("stampScanIdForJob — hasDb=true: a DB error on either table THROWS", async () => {
  const { client } = makeMockClient({
    prompt_results: () => ({ data: null, error: new Error("update failed") }),
    citations: makeFakeTable().handler,
  });
  await assert.rejects(() => stampScanIdForJob("job-x", "scan-x", { client }), /update failed/);
});

test("stampScanIdForJob — hasDb=false: memory mode mirrors the null-only scoping", async () => {
  await upsertPromptResults([{ job_id: "mem-finalize", engine: "aio", query: "q1" }], { client: null });
  await upsertPromptResults([{ job_id: "mem-finalize", engine: "chatgpt", query: "q2" }], { client: null });
  await insertCitations([{ job_id: "mem-finalize", url: "https://x.com", domain: "x.com" }], { client: null });

  // A row that's already stamped (e.g. a retried finalize) must stay untouched.
  const already = Array.from(global.memoryPromptResults.values()).find(
    (r) => r.job_id === "mem-finalize" && r.engine === "chatgpt"
  );
  already.scan_id = "old-scan";

  const result = await stampScanIdForJob("mem-finalize", "new-scan", { client: null });
  assert.equal(result.promptResults, 1, "only the null-scan_id row is stamped");
  assert.equal(result.citations, 1);
  assert.equal(already.scan_id, "old-scan", "already-stamped row must not be overwritten");
});

// =============================================================================
// brand_metrics_daily
// =============================================================================

test("upsertBrandMetricsDaily — empty array is a no-op", async () => {
  const { client, calls } = makeMockClient({});
  assert.deepEqual(await upsertBrandMetricsDaily([], { client }), []);
  assert.equal(calls.length, 0);
});

test("upsertBrandMetricsDaily — hasDb=true: upserts with onConflict brand,date,engine, no duplicate rows", async () => {
  const table = makeFakeTable();
  const { client, calls } = makeMockClient({ brand_metrics_daily: table.handler });

  await upsertBrandMetricsDaily(
    [{ brand: "acme.com", date: "2026-07-01", engine: "all", visibility_pct: 40 }],
    { client }
  );
  await upsertBrandMetricsDaily(
    [{ brand: "acme.com", date: "2026-07-01", engine: "all", visibility_pct: 55 }],
    { client }
  );

  assert.equal(table.rows.length, 1, "same (brand,date,engine) must not duplicate");
  assert.equal(table.rows[0].visibility_pct, 55);
  const upsertCall = calls.find((c) => c.op === "upsert");
  assert.deepEqual(upsertCall.upsertOpts, { onConflict: "brand,date,engine" });
});

test("upsertBrandMetricsDaily — hasDb=true: a DB error THROWS, never falls back to memory", async () => {
  const before = global.memoryBrandMetrics.size;
  const { client } = makeMockClient({
    brand_metrics_daily: () => ({ data: null, error: new Error("conflict") }),
  });
  await assert.rejects(
    () => upsertBrandMetricsDaily([{ brand: "x.com", date: "2026-07-01", engine: "all" }], { client }),
    /conflict/
  );
  assert.equal(global.memoryBrandMetrics.size, before);
});

test("upsertBrandMetricsDaily — hasDb=false: dedupes on (brand, date, engine), engine defaults to 'all'", async () => {
  await upsertBrandMetricsDaily([{ brand: "mem.com", date: "2026-07-01", visibility_pct: 10 }], { client: null });
  await upsertBrandMetricsDaily(
    [{ brand: "mem.com", date: "2026-07-01", engine: "all", visibility_pct: 20 }],
    { client: null }
  );
  const stored = Array.from(global.memoryBrandMetrics.values()).filter((r) => r.brand === "mem.com");
  assert.equal(stored.length, 1);
  assert.equal(stored[0].visibility_pct, 20);
  assert.equal(stored[0].engine, "all");
});

function seedMetricsTable() {
  return makeFakeTable([
    { brand: "acme.com", date: "2026-07-01", engine: "all", visibility_pct: 10 },
    { brand: "acme.com", date: "2026-07-03", engine: "all", visibility_pct: 30 },
    { brand: "acme.com", date: "2026-07-02", engine: "all", visibility_pct: 20 },
    { brand: "acme.com", date: "2026-07-02", engine: "aio", visibility_pct: 25 },
    { brand: "other.com", date: "2026-07-02", engine: "all", visibility_pct: 99 },
  ]);
}

test("getBrandMetricsSeries — hasDb=true: filters by brand + default engine 'all', orders by date asc", async () => {
  const table = seedMetricsTable();
  const { client } = makeMockClient({ brand_metrics_daily: table.handler });

  const series = await getBrandMetricsSeries("acme.com", {}, { client });
  assert.deepEqual(series.map((r) => r.date), ["2026-07-01", "2026-07-02", "2026-07-03"]);
  assert.ok(series.every((r) => r.engine === "all"));
});

test("R05 metric sources batch unique report IDs and project only metric metadata", async()=>{
  const ids=Array.from({length:250},(_,i)=>`00000000-0000-4000-8000-${String(i).padStart(12,'0')}`);
  const projections=[];
  const {client,calls}=makeMockClient({scans:state=>{projections.push(state.selectCols);return {data:state.filters.find(f=>f[0]==='in')[2].map(id=>({id,headline_metric:{metric_id:'observed_exposure'}})),error:null};}});
  const sources=await getBrandMetricSources([...ids,ids[0],null,'invalid-id'],'chatgpt',{client});
  assert.equal(sources.length,250);assert.equal(calls.length,3);
  for(const call of calls){assert.equal(call.table,'scans');assert.ok(call.filters.find(f=>f[0]==='in')[2].length<=100);}
  for(const projection of projections){assert.ok(!projection.includes('*'));assert.match(projection,/headline_metric/);assert.match(projection,/engine_metric/);}
});

test("R05 metric source read failures cannot silently become unqualified legacy history",async()=>{
  const {client}=makeMockClient({scans:()=>({data:null,error:Error('source read failed')})});
  await assert.rejects(()=>getBrandMetricSources(['00000000-0000-4000-8000-000000000001'],'all',{client}),/source read failed/);
  await assert.rejects(()=>getBrandMetricSources([],'invalid',{client}),/Invalid metric source engine/);
});

test("getBrandMetricsSeries — hasDb=true: engine filter picks the per-engine row, not the blended row", async () => {
  const table = seedMetricsTable();
  const { client } = makeMockClient({ brand_metrics_daily: table.handler });

  const series = await getBrandMetricsSeries("acme.com", { engine: "aio" }, { client });
  assert.equal(series.length, 1);
  assert.equal(series[0].visibility_pct, 25);
});

test("getBrandMetricsSeries — hasDb=true: from/to bound the date range inclusively", async () => {
  const table = seedMetricsTable();
  const { client } = makeMockClient({ brand_metrics_daily: table.handler });

  const series = await getBrandMetricsSeries("acme.com", { from: "2026-07-02", to: "2026-07-02" }, { client });
  assert.equal(series.length, 1);
  assert.equal(series[0].date, "2026-07-02");
  assert.equal(series[0].engine, "all");
});

test("getBrandMetricsSeries — hasDb=true: a DB error THROWS", async () => {
  const { client } = makeMockClient({
    brand_metrics_daily: () => ({ data: null, error: new Error("select failed") }),
  });
  await assert.rejects(() => getBrandMetricsSeries("x.com", {}, { client }), /select failed/);
});

test("getBrandMetricsSeries — hasDb=false: memory path applies the same brand/engine/range filters", async () => {
  await upsertBrandMetricsDaily(
    [
      { brand: "mem-series.com", date: "2026-07-01", engine: "all", visibility_pct: 1 },
      { brand: "mem-series.com", date: "2026-07-02", engine: "all", visibility_pct: 2 },
      { brand: "mem-series.com", date: "2026-07-02", engine: "chatgpt", visibility_pct: 9 },
    ],
    { client: null }
  );
  const series = await getBrandMetricsSeries("mem-series.com", { from: "2026-07-02" }, { client: null });
  assert.equal(series.length, 1);
  assert.equal(series[0].date, "2026-07-02");
  assert.equal(series[0].engine, "all");
});

// =============================================================================
// scan_schedules
// =============================================================================

test("getScanSchedule / upsertScanSchedule — hasDb=true: create then update, brand PK, updated_at refreshed", async () => {
  const table = makeFakeTable();
  const { client } = makeMockClient({ scan_schedules: table.handler });

  assert.equal(await getScanSchedule("acme.com", { client }), null);

  const created = await upsertScanSchedule(
    "acme.com",
    { cadence: "72h", enabled: true, prompt_target: 30 },
    { client }
  );
  assert.equal(created.brand, "acme.com");
  assert.equal(created.cadence, "72h");
  assert.ok(created.updated_at);

  const firstUpdatedAt = created.updated_at;
  await new Promise((r) => setTimeout(r, 5));
  const updated = await upsertScanSchedule("acme.com", { prompt_target: 60 }, { client });
  assert.equal(updated.prompt_target, 60);
  assert.equal(updated.cadence, "72h", "unrelated fields survive the upsert");
  assert.ok(new Date(updated.updated_at).getTime() >= new Date(firstUpdatedAt).getTime());

  assert.equal(table.rows.length, 1, "must upsert in place on the brand PK, not duplicate");

  const fetched = await getScanSchedule("acme.com", { client });
  assert.equal(fetched.prompt_target, 60);
});

test("getScanSchedule — hasDb=true: a DB error THROWS", async () => {
  const { client } = makeMockClient({
    scan_schedules: () => ({ data: null, error: new Error("select failed") }),
  });
  await assert.rejects(() => getScanSchedule("x.com", { client }), /select failed/);
});

test("upsertScanSchedule — hasDb=true: a DB error THROWS, never falls back to memory", async () => {
  const before = global.memoryScanSchedules.size;
  const { client } = makeMockClient({
    scan_schedules: () => ({ data: null, error: new Error("upsert failed") }),
  });
  await assert.rejects(() => upsertScanSchedule("x.com", { cadence: "daily" }, { client }), /upsert failed/);
  assert.equal(global.memoryScanSchedules.size, before);
});

test("getScanSchedule / upsertScanSchedule — hasDb=false: memory mirrors create/update/get", async () => {
  assert.equal(await getScanSchedule("mem-sched.com", { client: null }), null);
  await upsertScanSchedule("mem-sched.com", { cadence: "daily", enabled: true }, { client: null });
  const updated = await upsertScanSchedule("mem-sched.com", { enabled: false }, { client: null });
  assert.equal(updated.cadence, "daily", "unrelated fields survive the upsert");
  assert.equal(updated.enabled, false);
  assert.equal((await getScanSchedule("mem-sched.com", { client: null })).enabled, false);
});

test("listDueSchedules — hasDb=true: due/not-due boundary (<=now, null next_run_at, disabled)", async () => {
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const table = makeFakeTable([
    { brand: "due-past.com", managed_by: "operator", enabled: true, next_run_at: new Date(now - 60000).toISOString() },
    { brand: "due-exact.com", managed_by: "operator", enabled: true, next_run_at: nowIso },
    { brand: "due-null.com", managed_by: "operator", enabled: true, next_run_at: null },
    { brand: "not-due-future.com", managed_by: "operator", enabled: true, next_run_at: new Date(now + 60000).toISOString() },
    { brand: "disabled-past.com", managed_by: "operator", enabled: false, next_run_at: new Date(now - 60000).toISOString() },
    { brand: "customer-past.com", managed_by: "customer", enabled: true, next_run_at: new Date(now - 60000).toISOString() },
  ]);
  const { client } = makeMockClient({ scan_schedules: table.handler });

  const due = await listDueSchedules(nowIso, { client });
  const dueBrands = due.map((r) => r.brand).sort();

  assert.deepEqual(dueBrands, ["due-exact.com", "due-null.com", "due-past.com"]);
});

test("listDueSchedules — hasDb=true: the recorded query filters on managed_by = operator", async () => {
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const table = makeFakeTable([
    { brand: "operator-due.com", managed_by: "operator", enabled: true, next_run_at: new Date(now - 60000).toISOString() },
    { brand: "customer-due.com", managed_by: "customer", enabled: true, next_run_at: new Date(now - 60000).toISOString() },
  ]);
  const { client, calls } = makeMockClient({ scan_schedules: table.handler });

  const due = await listDueSchedules(nowIso, { client });

  assert.deepEqual(due.map((r) => r.brand), ["operator-due.com"], "customer-managed rows never reach the legacy scheduler");
  const read = calls.find((c) => c.table === "scan_schedules");
  assert.ok(read, "the schedules table was read");
  assert.ok(
    read.filters.some(([kind, col, val]) => kind === "eq" && col === "managed_by" && val === "operator"),
    "the recorded query includes managed_by = operator",
  );
});

test("listDueSchedules — hasDb=true: a DB error THROWS", async () => {
  const { client } = makeMockClient({
    scan_schedules: () => ({ data: null, error: new Error("read failed") }),
  });
  await assert.rejects(() => listDueSchedules(new Date().toISOString(), { client }), /read failed/);
});

test("listDueSchedules — hasDb=false: memory path applies the same boundary", async () => {
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  await upsertScanSchedule(
    "mem-due.com",
    { enabled: true, next_run_at: new Date(now - 1000).toISOString() },
    { client: null }
  );
  await upsertScanSchedule(
    "mem-not-due.com",
    { enabled: true, next_run_at: new Date(now + 100000).toISOString() },
    { client: null }
  );
  await upsertScanSchedule(
    "mem-disabled.com",
    { enabled: false, next_run_at: new Date(now - 1000).toISOString() },
    { client: null }
  );
  await upsertScanSchedule("mem-never-run.com", { enabled: true, next_run_at: null }, { client: null });

  const due = await listDueSchedules(nowIso, { client: null });
  const dueBrands = due.map((r) => r.brand).sort();
  assert.ok(dueBrands.includes("mem-due.com"));
  assert.ok(dueBrands.includes("mem-never-run.com"));
  assert.ok(!dueBrands.includes("mem-not-due.com"));
  assert.ok(!dueBrands.includes("mem-disabled.com"));
});

// =============================================================================
// full memory-mode lifecycle
// =============================================================================

test("dev mode (hasDb=false): full lifecycle — probe writes, resume-skip, finalize stamp, metrics rollup, schedule", async () => {
  const jobId = "lifecycle-job-1";
  const brand = "lifecycle.com";

  // Chunk 1 writes two (engine,query) pairs.
  const written = await upsertPromptResults(
    [
      { job_id: jobId, brand, engine: "aio", query: "q1", answered: true, mentioned: true },
      { job_id: jobId, brand, engine: "chatgpt", query: "q1", answered: true, mentioned: false },
    ],
    { client: null }
  );
  assert.equal(written.length, 2);
  assert.ok(written.every((r) => r.id));

  await insertCitations(
    [{ result_id: written[0].id, job_id: jobId, brand, url: "https://ref.com/a", domain: "ref.com" }],
    { client: null }
  );
  await insertResultBrands(
    [{ result_id: written[0].id, brand, name: "Lifecycle Co", is_self: true, mentioned: true }],
    { client: null }
  );

  // Resume: chunk 2 sees what's already done and skips it.
  const completed = await getCompletedPairsForJob(jobId, { client: null });
  const worklist = [
    ["aio", "q1"],
    ["chatgpt", "q1"],
    ["aio", "q2"],
  ];
  const remaining = worklist.filter(([e, q]) => !completed.has(`${e}|${q}`));
  assert.deepEqual(remaining, [["aio", "q2"]]);

  await upsertPromptResults(
    [{ job_id: jobId, brand, engine: "aio", query: "q2", answered: true, mentioned: true }],
    { client: null }
  );

  // Finalize: stamp scan_id onto every row still null for this job.
  const stampResult = await stampScanIdForJob(jobId, "scan-lifecycle-1", { client: null });
  assert.equal(stampResult.promptResults, 3);
  assert.equal(stampResult.citations, 1);

  const allResults = await getPromptResultsForJob(jobId, { client: null });
  assert.equal(allResults.length, 3);
  assert.ok(allResults.every((r) => r.scan_id === "scan-lifecycle-1"));

  // Rollup + schedule, as P0.2's finalize step would do.
  await upsertBrandMetricsDaily(
    [{ brand, date: "2026-07-23", engine: "all", visibility_pct: 66.7, prompts_total: 3 }],
    { client: null }
  );
  const series = await getBrandMetricsSeries(brand, {}, { client: null });
  assert.equal(series.length, 1);
  assert.equal(series[0].prompts_total, 3);

  await upsertScanSchedule(brand, { cadence: "72h", enabled: true, prompt_target: 30 }, { client: null });
  const schedule = await getScanSchedule(brand, { client: null });
  assert.equal(schedule.cadence, "72h");
});
