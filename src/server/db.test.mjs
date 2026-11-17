import test from "node:test";
import assert from "node:assert/strict";
import {
  createScanJob,
  getScanJob,
  updateScanJob,
  claimJobStatus,
  hasActiveScanForBrand,
  isJobAlive,
  HEARTBEAT_STALE_MS,
  SCAN_JOB_RUNNING,
} from "./db.js";

/**
 * P0.0 coverage: the scan job store must be DB-authoritative and fail-loud
 * whenever a client is configured, and must keep the in-memory dev/test path
 * working exactly as before when it isn't. A fake Supabase query-builder
 * (below) stands in for a live DB so the hasDb=true branch is testable
 * without touching a real database.
 */

// --- fake Supabase client harness -------------------------------------------

/**
 * Mimics just enough of supabase-js's chainable query builder for these
 * tests: `.from(table)` returns a builder whose filter/op methods record
 * themselves and return `this`; awaiting the builder (via `.then`) resolves
 * through the per-table handler you provide. `calls` records every
 * operation actually sent to the "client" so tests can assert the DB path
 * (not memory) was used.
 */
function makeMockClient(tableHandlers) {
  const calls = [];
  const client = {
    from(table) {
      const state = { table, op: null, values: null, filters: [], limitN: null };
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
        select(cols) {
          if (!state.op) state.op = "select";
          state.selectCols = cols;
          return builder;
        },
        eq(col, val) {
          state.filters.push(["eq", col, val]);
          return builder;
        },
        ilike(col, val) {
          state.filters.push(["ilike", col, val]);
          return builder;
        },
        in(col, vals) {
          state.filters.push(["in", col, vals]);
          return builder;
        },
        gt(col, val) {
          state.filters.push(["gt", col, val]);
          return builder;
        },
        limit(n) {
          state.limitN = n;
          return builder;
        },
        then(resolve, reject) {
          calls.push({ table: state.table, op: state.op, filters: state.filters, values: state.values });
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

function isoMinutesAgo(mins) {
  return new Date(Date.now() - mins * 60 * 1000).toISOString();
}

// --- hasDb=true: fail-loud (never falls back to memory) --------------------

test("createScanJob — hasDb=true: a DB error THROWS, never falls back to memory", async () => {
  const { client } = makeMockClient({
    scan_jobs: () => ({ data: null, error: new Error("insert failed") }),
  });
  await assert.rejects(
    () => createScanJob({ brand: "Acme", url: "acme.com", industry: "saas", competitors: "" }, { client }),
    /insert failed/
  );
});

test("createScanJob — hasDb=true: inserts scan_jobs and returns the DB row (not the local draft)", async () => {
  let inserted = null;
  const { client, calls } = makeMockClient({
    scan_jobs: (state) => {
      inserted = state.values[0];
      return { data: [{ ...inserted, id: "server-assigned-id" }], error: null };
    },
  });

  const job = await createScanJob({ brand: "Acme", url: "acme.com", industry: "saas", competitors: "" }, { client });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].op, "insert");
  assert.ok(inserted.created_at, "creation payload must set created_at");
  assert.ok(inserted.heartbeat_at, "creation payload must set heartbeat_at");
  assert.equal(job.id, "server-assigned-id", "must return the DB-assigned row, not the local draft");
  assert.equal(global.memoryJobs.has(inserted.id), false, "must not also write to memory");
});

test("getScanJob — hasDb=true: a DB error THROWS, never falls back to memory", async () => {
  const { client } = makeMockClient({
    scan_jobs: () => ({ data: null, error: new Error("read timeout") }),
  });
  await assert.rejects(() => getScanJob("some-id", { client }), /read timeout/);
});

test("updateScanJob — hasDb=true: a DB error THROWS, never falls back to memory", async () => {
  const { calls, client } = makeMockClient({
    scan_jobs: () => ({ data: null, error: new Error("connection refused") }),
  });

  await assert.rejects(
    () => updateScanJob("job-throws-1", { status: "probing" }, { client }),
    /connection refused/
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0].table, "scan_jobs");
  assert.equal(global.memoryJobs.has("job-throws-1"), false, "must not poison the memory map on DB failure");
});

test("getScanJob / updateScanJob — hasDb=true: hit the client, never memory (even for an id that exists in memory)", async () => {
  const jobId = "job-in-both-1";
  // Poison the memory map on purpose to prove the DB path ignores it entirely.
  global.memoryJobs.set(jobId, { id: jobId, status: "STALE-MEMORY-VALUE", brand: "MemoryGhost" });

  const dbRow = { id: jobId, status: "probing", brand: "RealBrand", progress_pct: 40 };
  const { client, calls } = makeMockClient({
    scan_jobs: (state) =>
      state.op === "update"
        ? { data: [{ ...dbRow, ...state.values }], error: null }
        : { data: [dbRow], error: null },
  });

  const fetched = await getScanJob(jobId, { client });
  assert.equal(fetched.brand, "RealBrand");
  assert.notEqual(fetched.status, "STALE-MEMORY-VALUE");

  const updated = await updateScanJob(jobId, { progress_pct: 55 }, { client });
  assert.equal(updated.progress_pct, 55);

  assert.equal(calls.length, 2);
  assert.ok(calls.every((c) => c.table === "scan_jobs"));

  global.memoryJobs.delete(jobId);
});

// --- heartbeat stamping ------------------------------------------------------

test("updateScanJob — stamps heartbeat_at on every call (hasDb=false, memory path)", async () => {
  const job = await createScanJob({ brand: "HeartbeatBrand", url: "hb.com" }, { client: null });
  const before = job.heartbeat_at;
  assert.ok(before, "createScanJob must stamp heartbeat_at");

  await new Promise((r) => setTimeout(r, 5));
  const updated = await updateScanJob(job.id, { progress_pct: 20 }, { client: null });
  assert.ok(updated.heartbeat_at);
  assert.ok(
    new Date(updated.heartbeat_at).getTime() >= new Date(before).getTime(),
    "heartbeat_at must advance on update"
  );
});

test("updateScanJob — stamps heartbeat_at on every call (hasDb=true), including checkpoint-only updates", async () => {
  const captured = [];
  const { client } = makeMockClient({
    scan_jobs: (state) => {
      captured.push(state.values);
      return { data: [{ id: "x", ...state.values }], error: null };
    },
  });

  await updateScanJob("x", { checkpoint: { probed: 12 } }, { client });

  assert.ok(captured[0].heartbeat_at, "the update payload sent to the DB must include heartbeat_at");
  assert.ok(!Number.isNaN(new Date(captured[0].heartbeat_at).getTime()));
  assert.deepEqual(captured[0].checkpoint, { probed: 12 }, "checkpoint must pass through untouched");
});

// --- claimJobStatus: structural single-flight (P0.2 FIX 2) -----------------

test("claimJobStatus — hasDb=true: only the first caller transitioning from the expected status wins; the second gets null", async () => {
  // A minimal stand-in for the real compare-and-set: the update only
  // "sees" a row while the eq("status", fromStatus) filter still matches
  // the row's CURRENT status at the moment this handler runs — exactly how
  // a real `UPDATE ... WHERE status = $1` behaves against concurrent callers.
  let currentStatus = "probing";
  const { client, calls } = makeMockClient({
    scan_jobs: (state) => {
      const statusFilter = state.filters.find(([op, col]) => op === "eq" && col === "status");
      if (statusFilter && statusFilter[2] !== currentStatus) {
        return { data: [], error: null }; // lost the race — 0 rows matched
      }
      currentStatus = state.values.status;
      return { data: [{ id: "job-1", status: currentStatus, heartbeat_at: state.values.heartbeat_at }], error: null };
    },
  });

  const first = await claimJobStatus("job-1", "probing", "scoring", { client });
  const second = await claimJobStatus("job-1", "probing", "scoring", { client });

  assert.ok(first, "first caller must win the claim");
  assert.equal(first.status, "scoring");
  assert.equal(second, null, "second caller must lose the claim — status already moved on");
  assert.equal(calls.length, 2);
  assert.ok(calls.every((c) => c.op === "update"), "a claim is an update, not a select-then-branch");
});

test("claimJobStatus — hasDb=true: fromStatus as an array uses .in() (sourcing claims from pending OR generating_prompts)", async () => {
  const { client, calls } = makeMockClient({
    scan_jobs: () => ({ data: [{ id: "job-2", status: "generating_prompts" }], error: null }),
  });

  const result = await claimJobStatus("job-2", ["pending", "generating_prompts"], "generating_prompts", { client });

  assert.ok(result);
  assert.equal(result.status, "generating_prompts");
  const inFilter = calls[0].filters.find(([op]) => op === "in");
  assert.deepEqual(inFilter, ["in", "status", ["pending", "generating_prompts"]]);
  const idFilter = calls[0].filters.find(([op, col]) => op === "eq" && col === "id");
  assert.deepEqual(idFilter, ["eq", "id", "job-2"]);
});

test("claimJobStatus — hasDb=true: no row matches (wrong id, or status already moved on) => null, not an error", async () => {
  const { client } = makeMockClient({
    scan_jobs: () => ({ data: [], error: null }),
  });
  assert.equal(await claimJobStatus("job-missing", "probing", "scoring", { client }), null);
});

test("claimJobStatus — hasDb=true: a DB error THROWS, never returns null silently", async () => {
  const { client } = makeMockClient({
    scan_jobs: () => ({ data: null, error: new Error("connection refused") }),
  });
  await assert.rejects(() => claimJobStatus("job-3", "probing", "scoring", { client }), /connection refused/);
});

test("claimJobStatus — hasDb=true: stamps heartbeat_at on a winning claim", async () => {
  const captured = [];
  const { client } = makeMockClient({
    scan_jobs: (state) => {
      captured.push(state.values);
      return { data: [{ id: "job-4", ...state.values }], error: null };
    },
  });
  await claimJobStatus("job-4", "probing", "scoring", { client });
  assert.ok(captured[0].heartbeat_at);
  assert.ok(!Number.isNaN(new Date(captured[0].heartbeat_at).getTime()));
});

test("claimJobStatus — hasDb=false (memory): only the first caller transitioning from the expected status wins", async () => {
  const job = await createScanJob({ brand: "ClaimBrand", url: "claim.com" }, { client: null });
  await updateScanJob(job.id, { status: "probing" }, { client: null });

  const first = await claimJobStatus(job.id, "probing", "scoring", { client: null });
  const second = await claimJobStatus(job.id, "probing", "scoring", { client: null });

  assert.ok(first, "first caller must win");
  assert.equal(first.status, "scoring");
  assert.equal(second, null, "second caller must lose — status is no longer 'probing'");
});

test("claimJobStatus — hasDb=false (memory): fromStatus as an array matches either status", async () => {
  const job = await createScanJob({ brand: "ClaimArrayBrand", url: "claim-array.com" }, { client: null });
  await updateScanJob(job.id, { status: "generating_prompts" }, { client: null });

  const claimed = await claimJobStatus(job.id, ["pending", "generating_prompts"], "generating_prompts", { client: null });
  assert.ok(claimed);
  assert.equal(claimed.status, "generating_prompts");
});

test("claimJobStatus — hasDb=false (memory): wrong current status => null", async () => {
  const job = await createScanJob({ brand: "ClaimWrongBrand", url: "claim-wrong.com" }, { client: null });
  await updateScanJob(job.id, { status: "complete" }, { client: null });

  assert.equal(await claimJobStatus(job.id, "probing", "scoring", { client: null }), null);
});

// --- hasActiveScanForBrand: heartbeat staleness (hasDb=true) ----------------

test("hasActiveScanForBrand — running job + fresh heartbeat => true", async () => {
  const { client } = makeMockClient({
    scan_jobs: () => ({
      data: [{ id: "1", status: "probing", heartbeat_at: isoMinutesAgo(1) }],
      error: null,
    }),
  });
  assert.equal(await hasActiveScanForBrand("Acme", { client }), true);
});

test("hasActiveScanForBrand — running job + stale heartbeat => false (rescuable)", async () => {
  const { client } = makeMockClient({
    scan_jobs: () => ({
      data: [{ id: "1", status: "probing", heartbeat_at: isoMinutesAgo(10) }],
      error: null,
    }),
  });
  assert.equal(await hasActiveScanForBrand("Acme", { client }), false);
});

test("hasActiveScanForBrand — running status with absent heartbeat => false (treated as dead)", async () => {
  const { client } = makeMockClient({
    scan_jobs: () => ({
      data: [{ id: "1", status: "probing", heartbeat_at: null }],
      error: null,
    }),
  });
  assert.equal(await hasActiveScanForBrand("Acme", { client }), false);
});

test("hasActiveScanForBrand — completed job => false even if returned by a misbehaving query", async () => {
  const { client } = makeMockClient({
    scan_jobs: () => ({
      data: [{ id: "1", status: "complete", heartbeat_at: isoMinutesAgo(0) }],
      error: null,
    }),
  });
  assert.equal(await hasActiveScanForBrand("Acme", { client }), false);
});

test("hasActiveScanForBrand — fails open on a broken duplicate check (read-side only)", async () => {
  const { client } = makeMockClient({
    scan_jobs: () => ({ data: null, error: new Error("read replica down") }),
  });
  assert.equal(await hasActiveScanForBrand("Acme", { client }), false);
});

// --- hasActiveScanForBrand: hasDb=false (memory) ----------------------------

test("hasActiveScanForBrand — hasDb=false: memory path applies the same heartbeat rule", async () => {
  const job = await createScanJob({ brand: "MemBrand", url: "mem.com" }, { client: null });
  await updateScanJob(job.id, { status: "probing" }, { client: null }); // fresh heartbeat
  assert.equal(await hasActiveScanForBrand("MemBrand", { client: null }), true);

  // Make it stale by hand (simulates a crashed worker that stopped heartbeating).
  global.memoryJobs.get(job.id).heartbeat_at = isoMinutesAgo(10);
  assert.equal(await hasActiveScanForBrand("MemBrand", { client: null }), false);
});

test("hasActiveScanForBrand — hasDb=false: a completed job in memory does not block", async () => {
  const job = await createScanJob({ brand: "CompleteBrand", url: "c.com" }, { client: null });
  await updateScanJob(job.id, { status: "complete" }, { client: null });
  assert.equal(await hasActiveScanForBrand("CompleteBrand", { client: null }), false);
});

// --- isJobAlive staleness boundary -------------------------------------------

test("isJobAlive — status + heartbeat boundary", () => {
  const now = Date.now();

  assert.equal(
    isJobAlive({ status: "probing", heartbeat_at: new Date(now - 1000).toISOString() }, now),
    true,
    "one second old is alive"
  );
  assert.equal(
    isJobAlive({ status: "probing", heartbeat_at: new Date(now - HEARTBEAT_STALE_MS + 1000).toISOString() }, now),
    true,
    "just inside the window is alive"
  );
  assert.equal(
    isJobAlive({ status: "probing", heartbeat_at: new Date(now - HEARTBEAT_STALE_MS - 1000).toISOString() }, now),
    false,
    "just outside the window is dead"
  );
  assert.equal(
    isJobAlive({ status: "complete", heartbeat_at: new Date(now).toISOString() }, now),
    false,
    "non-running status is never alive"
  );
  assert.equal(isJobAlive(null, now), false, "no job is never alive");
  assert.equal(isJobAlive({ status: "probing" }, now), false, "no heartbeat_at at all => dead");
});

test("SCAN_JOB_RUNNING / HEARTBEAT_STALE_MS are exported with the documented values", () => {
  assert.deepEqual(SCAN_JOB_RUNNING, ["pending", "generating_prompts", "probing", "scoring"]);
  assert.equal(HEARTBEAT_STALE_MS, 3 * 60 * 1000);
});

// --- hasDb=false: full memory lifecycle -------------------------------------

test("dev mode (hasDb=false): full memory lifecycle create -> get -> update -> get", async () => {
  const job = await createScanJob(
    { brand: "DevBrand", url: "dev.com", industry: "saas", competitors: "A, B" },
    { client: null }
  );
  assert.ok(job.id);
  assert.equal(job.status, "pending");
  assert.equal(job.progress_pct, 0);
  assert.ok(job.heartbeat_at);
  assert.ok(job.created_at);

  const fetched = await getScanJob(job.id, { client: null });
  assert.deepEqual(fetched, job);

  const updated = await updateScanJob(job.id, { status: "probing", progress_pct: 40 }, { client: null });
  assert.equal(updated.status, "probing");
  assert.equal(updated.progress_pct, 40);

  const fetchedAgain = await getScanJob(job.id, { client: null });
  assert.equal(fetchedAgain.status, "probing");
  assert.equal(fetchedAgain.progress_pct, 40);
});

test("dev mode (hasDb=false): getScanJob returns null for an unknown id", async () => {
  assert.equal(await getScanJob("does-not-exist-xyz", { client: null }), null);
});

test("dev mode (hasDb=false): updateScanJob on an unknown id creates a minimal record (unchanged legacy behavior)", async () => {
  const created = await updateScanJob("brand-new-unseen-id", { status: "pending" }, { client: null });
  assert.equal(created.id, "brand-new-unseen-id");
  assert.equal(created.status, "pending");
  assert.ok(created.heartbeat_at);
  global.memoryJobs.delete("brand-new-unseen-id");
});


test("customer scan creation persists its workspace independently of the display name", async () => {
  let inserted;
  const { client } = makeMockClient({ scan_jobs: (state) => {
    inserted = state.values[0];
    return { data: [inserted], error: null };
  } });
  const job = await createScanJob({ brand: "%", url: "https://same.example", brandKey: "workspace-a" }, { client });
  assert.equal(job.brand_key, "workspace-a");
  assert.equal(inserted.brand, "%");
  assert.equal(inserted.brand_key, "workspace-a");
});
