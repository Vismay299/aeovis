import test from "node:test";
import assert from "node:assert/strict";
import {
  createContentJob,
  getContentJob,
  updateContentJob,
  hasActiveContentJobForBrand,
  getContentItem,
  updateContentItem,
  CONTENT_JOB_RUNNING,
  CONTENT_HEARTBEAT_STALE_MS,
  isContentJobAlive,
  shouldRescueContentJob,
  listResumableContentJobs,
  isDeliveredContentJob,
  isRewoundContentJob,
  listRewoundContentJobs,
  healRewoundContentJob,
  insertContentRun,
  finishContentRun,
  listContentRunsForJob,
  ContentReadError,
} from "./db/content.js";

/**
 * P0.0 coverage for the Content OS job store (mirrors db.test.mjs): DB is
 * authoritative and fail-loud whenever a client is configured; the in-memory
 * dev/test path keeps working unchanged when it isn't. Same fake
 * Supabase query-builder approach as db.test.mjs (duplicated rather than
 * shared, matching this repo's per-file self-contained test convention).
 */

// --- fake Supabase client harness -------------------------------------------

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
        is(col, val) {
          state.filters.push(["is", col, val]);
          return builder;
        },
        or(expression) {
          state.filters.push(["or", expression]);
          return builder;
        },
        gt(col, val) {
          state.filters.push(["gt", col, val]);
          return builder;
        },
        // R3.5.7 — listRewoundContentJobs / healRewoundContentJob filter with
        // .not("item_id", "is", null). Recorded like every other filter so a
        // test can assert the guard really reached the statement.
        not(col, op, val) {
          state.filters.push(["not", col, op, val]);
          return builder;
        },
        limit(n) {
          state.limitN = n;
          return builder;
        },
        order(col, opts) {
          (state.orders ||= []).push([col, opts]);
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

// --- content_jobs: hasDb=true fail-loud -------------------------------------

test("createContentJob — hasDb=true: a DB error THROWS, never falls back to memory", async () => {
  const { client } = makeMockClient({
    content_jobs: () => ({ data: null, error: new Error("insert failed") }),
  });
  await assert.rejects(
    () => createContentJob({ brand: "Acme", playbook: "geo_article", input: {} }, { client }),
    /insert failed/
  );
});

test("createContentJob — hasDb=true: inserts content_jobs and returns the DB row, heartbeat_at set", async () => {
  let inserted = null;
  const { client } = makeMockClient({
    content_jobs: (state) => {
      inserted = state.values[0];
      return { data: [{ ...inserted, id: "server-id" }], error: null };
    },
  });
  const job = await createContentJob({ brand: "Acme", playbook: "geo_article", input: { query: "q" } }, { client });
  assert.ok(inserted.created_at);
  assert.ok(inserted.heartbeat_at);
  assert.equal(job.id, "server-id");
  assert.equal(global.memoryContentJobs.has(inserted.id), false);
});

test("getContentJob — hasDb=true: a DB error THROWS, never falls back to memory", async () => {
  const { client } = makeMockClient({
    content_jobs: () => ({ data: null, error: new Error("read timeout") }),
  });
  await assert.rejects(() => getContentJob("id", { client }), /read timeout/);
});

test("updateContentJob — hasDb=true: a DB error THROWS, never falls back to memory", async () => {
  const { client } = makeMockClient({
    content_jobs: () => ({ data: null, error: new Error("connection refused") }),
  });
  await assert.rejects(
    () => updateContentJob("cj-throws-1", { status: "drafting" }, { client }),
    /connection refused/
  );
  assert.equal(global.memoryContentJobs.has("cj-throws-1"), false);
});

test("getContentJob / updateContentJob — hasDb=true: hit the client, never memory", async () => {
  const jobId = "cj-in-both-1";
  global.memoryContentJobs.set(jobId, { id: jobId, status: "STALE-MEMORY-VALUE", brand: "MemoryGhost" });

  const dbRow = { id: jobId, status: "drafting", brand: "RealBrand", progress_pct: 40 };
  const { client, calls } = makeMockClient({
    content_jobs: (state) =>
      state.op === "update"
        ? { data: [{ ...dbRow, ...state.values }], error: null }
        : { data: [dbRow], error: null },
  });

  const fetched = await getContentJob(jobId, { client });
  assert.equal(fetched.brand, "RealBrand");
  assert.notEqual(fetched.status, "STALE-MEMORY-VALUE");

  const updated = await updateContentJob(jobId, { progress_pct: 55 }, { client });
  assert.equal(updated.progress_pct, 55);
  assert.equal(calls.length, 2);

  global.memoryContentJobs.delete(jobId);
});

// --- heartbeat stamping ------------------------------------------------------

test("updateContentJob — stamps heartbeat_at on every call (memory path)", async () => {
  const job = await createContentJob({ brand: "HB", playbook: "geo_article", input: {} }, { client: null });
  assert.ok(job.heartbeat_at, "createContentJob must stamp heartbeat_at");

  await new Promise((r) => setTimeout(r, 5));
  const updated = await updateContentJob(job.id, { progress_pct: 15 }, { client: null });
  assert.ok(updated.heartbeat_at);
  assert.ok(new Date(updated.heartbeat_at).getTime() >= new Date(job.heartbeat_at).getTime());
});

test("updateContentJob — stamps heartbeat_at on every call (DB path)", async () => {
  const captured = [];
  const { client } = makeMockClient({
    content_jobs: (state) => {
      captured.push(state.values);
      return { data: [{ id: "x", ...state.values }], error: null };
    },
  });
  await updateContentJob("x", { progress_pct: 10 }, { client });
  assert.ok(captured[0].heartbeat_at);
  assert.ok(!Number.isNaN(new Date(captured[0].heartbeat_at).getTime()));
});

// --- hasActiveContentJobForBrand: heartbeat with created_at fallback -------

test("hasActiveContentJobForBrand — running + fresh heartbeat_at => true", async () => {
  const { client } = makeMockClient({
    content_jobs: () => ({
      data: [
        {
          id: "1",
          brand: "Acme",
          status: "drafting",
          playbook: "geo_article",
          agent_id: null,
          input: {},
          heartbeat_at: isoMinutesAgo(1),
          created_at: isoMinutesAgo(1),
        },
      ],
      error: null,
    }),
  });
  assert.equal(await hasActiveContentJobForBrand("Acme", "geo_article", { client }), true);
});

test("hasActiveContentJobForBrand — running + stale heartbeat_at => false", async () => {
  const { client } = makeMockClient({
    content_jobs: () => ({
      data: [
        {
          id: "1",
          brand: "Acme",
          status: "drafting",
          playbook: "geo_article",
          agent_id: null,
          input: {},
          heartbeat_at: isoMinutesAgo(25),
          created_at: isoMinutesAgo(25),
        },
      ],
      error: null,
    }),
  });
  assert.equal(await hasActiveContentJobForBrand("Acme", "geo_article", { client }), false);
});

test("hasActiveContentJobForBrand — pre-005 row (no heartbeat_at) falls back to a fresh created_at", async () => {
  const { client } = makeMockClient({
    content_jobs: () => ({
      data: [
        {
          id: "1",
          brand: "Acme",
          status: "drafting",
          playbook: "geo_article",
          agent_id: null,
          input: {},
          heartbeat_at: null,
          created_at: isoMinutesAgo(5),
        },
      ],
      error: null,
    }),
  });
  assert.equal(
    await hasActiveContentJobForBrand("Acme", "geo_article", { client }),
    true,
    "back-compat: fresh created_at still counts when heartbeat_at is absent"
  );
});

test("hasActiveContentJobForBrand — pre-005 row, old created_at, no heartbeat_at => false", async () => {
  const { client } = makeMockClient({
    content_jobs: () => ({
      data: [
        {
          id: "1",
          brand: "Acme",
          status: "drafting",
          playbook: "geo_article",
          agent_id: null,
          input: {},
          heartbeat_at: null,
          created_at: isoMinutesAgo(25),
        },
      ],
      error: null,
    }),
  });
  assert.equal(await hasActiveContentJobForBrand("Acme", "geo_article", { client }), false);
});

test("hasActiveContentJobForBrand — completed job => false even if returned by a misbehaving query", async () => {
  const { client } = makeMockClient({
    content_jobs: () => ({
      data: [
        {
          id: "1",
          brand: "Acme",
          status: "complete",
          playbook: "geo_article",
          agent_id: null,
          input: {},
          heartbeat_at: isoMinutesAgo(0),
          created_at: isoMinutesAgo(0),
        },
      ],
      error: null,
    }),
  });
  assert.equal(await hasActiveContentJobForBrand("Acme", "geo_article", { client }), false);
});

test("hasActiveContentJobForBrand — fails open on a broken duplicate check", async () => {
  const { client } = makeMockClient({
    content_jobs: () => ({ data: null, error: new Error("down") }),
  });
  assert.equal(await hasActiveContentJobForBrand("Acme", "geo_article", { client }), false);
});

test("hasActiveContentJobForBrand — object form blocks only the exact same agent+query combo", async () => {
  const { client } = makeMockClient({
    content_jobs: () => ({
      data: [
        {
          id: "1",
          brand: "Acme",
          status: "drafting",
          playbook: "geo_article",
          agent_id: "agent-A",
          input: { query: "term one" },
          heartbeat_at: isoMinutesAgo(1),
          created_at: isoMinutesAgo(1),
        },
      ],
      error: null,
    }),
  });
  assert.equal(
    await hasActiveContentJobForBrand("Acme", { agentId: "agent-A", query: "term one" }, { client }),
    true
  );
  assert.equal(
    await hasActiveContentJobForBrand("Acme", { agentId: "agent-A", query: "different term" }, { client }),
    false
  );
  assert.equal(
    await hasActiveContentJobForBrand("Acme", { agentId: "agent-B", query: "term one" }, { client }),
    false
  );
});

// --- content_items: hasDb=true fail-loud ------------------------------------

test("updateContentItem — hasDb=true: a DB error THROWS, never falls back to memory", async () => {
  const { client } = makeMockClient({
    content_items: () => ({ data: null, error: new Error("write failed") }),
  });
  await assert.rejects(() => updateContentItem("ci-1", { status: "approved" }, { client }), /write failed/);
});

test("getContentItem — hasDb=true: a DB error THROWS, never falls back to memory", async () => {
  const { client } = makeMockClient({
    content_items: () => ({ data: null, error: new Error("read failed") }),
  });
  await assert.rejects(() => getContentItem("ci-1", { client }), /read failed/);
});

test("getContentItem / updateContentItem — hasDb=true: hit the client, never memory", async () => {
  const id = "ci-in-both-1";
  global.memoryContentItems.set(id, { id, status: "STALE-MEMORY-VALUE" });
  const dbRow = { id, status: "awaiting_approval", brand: "RealBrand" };
  const { client } = makeMockClient({
    content_items: (state) =>
      state.op === "update"
        ? { data: [{ ...dbRow, ...state.values }], error: null }
        : { data: [dbRow], error: null },
  });

  const fetched = await getContentItem(id, { client });
  assert.equal(fetched.status, "awaiting_approval");

  const updated = await updateContentItem(id, { status: "approved" }, { client });
  assert.equal(updated.status, "approved");

  global.memoryContentItems.delete(id);
});

// --- hasDb=false: memory path end-to-end ------------------------------------

test("dev mode (hasDb=false): content job memory lifecycle create -> get -> update -> dedupe", async () => {
  const job = await createContentJob(
    { brand: "DevBrand", playbook: "geo_article", input: { query: "q" } },
    { client: null }
  );
  assert.ok(job.id);
  assert.equal(job.status, "pending");
  assert.ok(job.heartbeat_at);

  const fetched = await getContentJob(job.id, { client: null });
  assert.deepEqual(fetched, job);

  const updated = await updateContentJob(job.id, { status: "drafting", progress_pct: 30 }, { client: null });
  assert.equal(updated.status, "drafting");

  assert.equal(await hasActiveContentJobForBrand("DevBrand", "geo_article", { client: null }), true);
});

test("dev mode (hasDb=false): updateContentItem on an unknown id returns null (no auto-create — legacy semantics)", async () => {
  const result = await updateContentItem("mem-item-does-not-exist", { status: "approved" }, { client: null });
  assert.equal(result, null);
});

test("dev mode (hasDb=false): updateContentItem mutates an existing memory item", async () => {
  const id = "mem-item-2";
  global.memoryContentItems.set(id, { id, status: "draft", brand: "X" });
  const updated = await updateContentItem(id, { status: "awaiting_approval" }, { client: null });
  assert.equal(updated.status, "awaiting_approval");
  assert.ok(updated.updated_at);
  global.memoryContentItems.delete(id);
});

test("CONTENT_JOB_RUNNING is exported with the expected statuses", () => {
  assert.deepEqual(CONTENT_JOB_RUNNING, [
    "pending",
    "coordinating",
    "researching",
    "benchmarking",
    "drafting",
    "reviewing",
  ]);
});

// --- rescue liveness + the D1 regression (T1) --------------------------------

test("isContentJobAlive: fresh heartbeat is alive, stale is not, terminal never is", () => {
  const fresh = { status: "drafting", heartbeat_at: isoMinutesAgo(1) };
  const stale = { status: "drafting", heartbeat_at: isoMinutesAgo(10) };

  assert.equal(isContentJobAlive(fresh), true);
  assert.equal(isContentJobAlive(stale), false);
  assert.equal(isContentJobAlive({ status: "drafting" }), false, "no heartbeat => dead");
  assert.equal(
    isContentJobAlive({ status: "approved", heartbeat_at: isoMinutesAgo(1) }),
    false,
    "a finished job is not 'alive' however recent its heartbeat"
  );
  assert.equal(isContentJobAlive(null), false);
});

test("isContentJobAlive uses a 3-minute window, matching db.js's HEARTBEAT_STALE_MS", () => {
  assert.equal(CONTENT_HEARTBEAT_STALE_MS, 3 * 60 * 1000);
  assert.equal(isContentJobAlive({ status: "drafting", heartbeat_at: isoMinutesAgo(2) }), true);
  assert.equal(isContentJobAlive({ status: "drafting", heartbeat_at: isoMinutesAgo(4) }), false);
});

test("shouldRescueContentJob: only a running job with a stale heartbeat and no live lease", () => {
  const stale = isoMinutesAgo(10);

  assert.equal(
    shouldRescueContentJob({ status: "drafting", heartbeat_at: stale }),
    true,
    "stale + unleased => rescue"
  );
  assert.equal(
    shouldRescueContentJob({ status: "drafting", heartbeat_at: isoMinutesAgo(1) }),
    false,
    "a healthy in-flight job must never be re-picked"
  );
  assert.equal(
    shouldRescueContentJob({ status: "approved", heartbeat_at: stale }),
    false,
    "a terminal job is never rescued"
  );
  assert.equal(
    shouldRescueContentJob({
      status: "drafting",
      heartbeat_at: stale,
      lease_owner: "run_a",
      lease_expires_at: new Date(Date.now() + 60_000).toISOString(),
    }),
    false,
    "a live lease means another worker owns this job"
  );
  assert.equal(
    shouldRescueContentJob({
      status: "drafting",
      heartbeat_at: stale,
      lease_owner: "run_dead",
      lease_expires_at: isoMinutesAgo(5),
    }),
    true,
    "an expired lease does not protect a dead worker's job"
  );
});

test("D1 regression: a fresh PENDING job is NOT resumable just for being pending", async () => {
  // The old implementation returned every `pending` job unconditionally, so a
  // job that POST /api/content had just dispatched was picked up again by the
  // next cron tick and run twice — two executions, two content_items rows, and
  // up to double the per-item cost cap. Liveness now governs both paths.
  const { client } = makeMockClient({
    content_jobs: () => ({
      data: [
        { id: "fresh-pending", status: "pending", heartbeat_at: isoMinutesAgo(0), created_at: isoMinutesAgo(0) },
      ],
      error: null,
    }),
  });

  assert.deepEqual(await listResumableContentJobs(5, { client }), []);
});

test("D1 regression: a job running longer than 5 minutes but heartbeating is NOT resumable", async () => {
  // The old filter was `created_at < now - 5min`, which re-picked healthy
  // long-running jobs. A real geo_article run can exceed five minutes.
  const { client } = makeMockClient({
    content_jobs: () => ({
      data: [
        {
          id: "long-but-healthy",
          status: "drafting",
          created_at: isoMinutesAgo(30),
          heartbeat_at: isoMinutesAgo(1),
        },
      ],
      error: null,
    }),
  });

  assert.deepEqual(await listResumableContentJobs(5, { client }), []);
});

test("listResumableContentJobs returns genuinely dead jobs, capped at the limit", async () => {
  const stale = isoMinutesAgo(10);
  const { client } = makeMockClient({
    content_jobs: () => ({
      data: [
        { id: "dead-1", status: "drafting", heartbeat_at: stale, created_at: stale },
        { id: "alive", status: "drafting", heartbeat_at: isoMinutesAgo(1), created_at: stale },
        { id: "dead-2", status: "researching", heartbeat_at: stale, created_at: stale },
        { id: "dead-3", status: "pending", heartbeat_at: stale, created_at: stale },
      ],
      error: null,
    }),
  });

  const resumable = await listResumableContentJobs(2, { client });
  assert.deepEqual(resumable.map((j) => j.id), ["dead-1", "dead-2"]);
});

test("listResumableContentJobs THROWS on a DB error — it never fabricates 'no work'", async () => {
  const { client } = makeMockClient({
    content_jobs: () => ({ data: null, error: new Error("db down") }),
  });
  await assert.rejects(
    () => listResumableContentJobs(5, { client }),
    (err) => {
      assert.ok(err instanceof ContentReadError, `expected ContentReadError, got ${err?.name}`);
      assert.equal(err.code, "db_read_failed");
      assert.ok(err.cause, "the original error must survive on `cause`");
      return true;
    }
  );
});

test("listResumableContentJobs THROWS when no client is configured — it never returns 'no work'", async () => {
  await assert.rejects(
    () => listResumableContentJobs(5, { client: null }),
    (err) => {
      assert.ok(err instanceof ContentReadError, `expected ContentReadError, got ${err?.name}`);
      assert.equal(err.code, "db_not_configured");
      return true;
    }
  );
});

// --- content_runs ledger (T3) -----------------------------------------------

test("insertContentRun opens a running row; finishContentRun closes it with cost", async () => {
  const run = await insertContentRun(
    { job_id: "job-9", brand: "Acme", block: "draft", cycle: 2 },
    { client: null }
  );

  assert.equal(run.status, "running");
  assert.equal(run.block, "draft");
  assert.equal(run.cycle, 2);
  assert.ok(run.started_at);

  const closed = await finishContentRun(
    run.id,
    { status: "succeeded", cost: 0.0123, tokens: 900 },
    { client: null }
  );
  assert.equal(closed.status, "succeeded");
  assert.equal(closed.cost, 0.0123);
  assert.equal(closed.tokens, 900);
  assert.ok(closed.ended_at);
  assert.ok(closed.duration_ms >= 0, "duration is derived from the row's own started_at");
});

test("finishContentRun records the error on a failed block", async () => {
  const run = await insertContentRun({ job_id: "job-9", brand: "Acme", block: "review" }, { client: null });
  const closed = await finishContentRun(
    run.id,
    { status: "failed", cost: 0.004, error: "schema validation failed" },
    { client: null }
  );
  assert.equal(closed.status, "failed");
  assert.equal(closed.error, "schema validation failed");
});

test("finishContentRun tolerates a null run id — a broken ledger never fails a job", async () => {
  assert.equal(await finishContentRun(null, { status: "succeeded" }, { client: null }), null);
  assert.equal(await finishContentRun("no-such-run", { status: "succeeded" }, { client: null }), null);
});

test("listContentRunsForJob returns one job's runs oldest-first", async () => {
  const a = await insertContentRun({ job_id: "job-A", brand: "Acme", block: "coordinate" }, { client: null });
  await finishContentRun(a.id, { status: "succeeded", cost: 0.001 }, { client: null });
  const b = await insertContentRun({ job_id: "job-A", brand: "Acme", block: "draft" }, { client: null });
  await insertContentRun({ job_id: "job-B", brand: "Acme", block: "draft" }, { client: null });

  const runs = await listContentRunsForJob("job-A", { client: null });
  assert.deepEqual(runs.map((r) => r.block), ["coordinate", "draft"]);
  assert.equal(runs[1].id, b.id);
  assert.equal(
    (await listContentRunsForJob("job-B", { client: null })).length,
    1,
    "runs are scoped to their own job"
  );
});

// --- R2.8.13 — fail-loud reads ------------------------------------------------

test("listContentRunsForJob THROWS on a DB error — it never fabricates 'no runs'", async () => {
  const { client } = makeMockClient({
    content_runs: () => ({ data: null, error: new Error("db unreachable") }),
  });
  await assert.rejects(
    () => listContentRunsForJob("any-job", { client }),
    (err) => {
      assert.ok(err instanceof ContentReadError, `expected ContentReadError, got ${err?.name}`);
      assert.equal(err.code, "db_read_failed");
      assert.ok(err.cause, "the original error must survive on `cause`");
      return true;
    }
  );
});

// --- R3.5.6: a delivered job is never re-dispatched --------------------------
//
// Production, 2026-09-18: job 355b0237 wrote its item at 19:17:51 and reached
// awaiting_approval, yet the 21:57 sweep listed it as resumable, re-ran review
// and failed on the FK. contentWorker's terminal write sets item_id and
// status:"awaiting_approval" in ONE update (contentWorker.js:805-809), and only
// writeJob (:554/:638/:714) ever writes a running status — so a running status
// WITH an item_id can only mean a second execution rewound a delivered job.
// Such a row is refused here so the rescue loop cannot re-pay for a draft that
// already exists.

test("R3.5.6 — a job with an item_id is NOT resumable, whatever its status says", () => {
  const stale = isoMinutesAgo(10);
  for (const status of CONTENT_JOB_RUNNING) {
    assert.equal(
      shouldRescueContentJob({ id: "355b0237", status, heartbeat_at: stale, item_id: "item-1" }),
      false,
      `THE BUG: a delivered job in status "${status}" was re-dispatched`
    );
  }
  assert.equal(
    shouldRescueContentJob({ id: "j9", status: "drafting", heartbeat_at: stale, item_id: null }),
    true,
    "a genuinely dead job with no item is still rescued — the guard must not swallow real work"
  );
});

test("R3.5.6 — listResumableContentJobs drops the rewound job and keeps the real one", async () => {
  const stale = isoMinutesAgo(10);
  const { client } = makeMockClient({
    content_jobs: () => ({
      data: [
        // The 355b0237 shape: delivered at 19:17:51, status rewound to reviewing.
        { id: "355b0237", status: "reviewing", heartbeat_at: stale, created_at: stale, item_id: "item-355" },
        { id: "really-dead", status: "drafting", heartbeat_at: stale, created_at: stale, item_id: null },
      ],
      error: null,
    }),
  });

  const resumable = await listResumableContentJobs(5, { client });
  assert.deepEqual(
    resumable.map((j) => j.id),
    ["really-dead"],
    "a job that already produced an item must not be handed a second invocation"
  );
});

// ---------------------------------------------------------------------------
// R3.5.7 — a worker execution must not rewind a delivered job.
//
// R3.5.6 stopped the sweep RE-DISPATCHING a rewound row. These pin the write
// itself: the status guard is evaluated by the database inside the UPDATE, so a
// second execution cannot put `reviewing` back over `awaiting_approval`, and a
// row that was already damaged heals to the status it had earned.
// ---------------------------------------------------------------------------

test("R3.5.7 GUARD — updateContentJob with ifStatusIn puts the precondition INSIDE the UPDATE", async () => {
  const { client, calls } = makeMockClient({
    content_jobs: () => ({ data: [{ id: "job-1", status: "reviewing" }], error: null }),
  });

  const row = await updateContentJob("job-1", { status: "reviewing" }, { client, ifStatusIn: CONTENT_JOB_RUNNING });

  assert.equal(row.status, "reviewing");
  assert.equal(calls.length, 1, "ONE statement — a read-then-write would leave the race open");
  assert.equal(calls[0].op, "update");
  assert.deepEqual(
    calls[0].filters.find((f) => f[0] === "in"),
    ["in", "status", CONTENT_JOB_RUNNING],
    "the status precondition must travel with the UPDATE, not be checked beforehand"
  );
});

test("R3.5.7 GUARD — a conditional UPDATE that matches no row is a REFUSAL, not a success and not a throw", async () => {
  // Zero rows is what Postgres returns when the row has left the worker-owned
  // statuses — exactly the awaiting_approval row a second execution tried to rewind.
  const { client } = makeMockClient({ content_jobs: () => ({ data: [], error: null }) });

  const res = await updateContentJob("job-1", { status: "reviewing" }, { client, ifStatusIn: CONTENT_JOB_RUNNING });

  assert.equal(res.refused, true);
  assert.equal(res.reason, "status_guard");
  assert.equal(res.attempted_status, "reviewing");
  assert.deepEqual(res.expected_status_in, CONTENT_JOB_RUNNING);
  assert.equal(res.status, undefined, "a refusal must not be readable as the row it failed to write");
});

test("R3.5.7 GUARD — an UNGUARDED write keeps its old behaviour (no ifStatusIn, no status filter)", async () => {
  const { client, calls } = makeMockClient({
    content_jobs: () => ({ data: [{ id: "job-1", cost_total: 0.02 }], error: null }),
  });

  await updateContentJob("job-1", { cost_total: 0.02 }, { client });

  assert.equal(
    calls[0].filters.some((f) => f[0] === "in"),
    false,
    "trace / cost / checkpoint flushes carry no status and must stay unconditional"
  );
});

test("R3.5.7 GUARD — in memory, a delivered job's status and item_id survive a second execution's write", async () => {
  const job = await createContentJob({ brand: "GuardBrand", playbook: "geo_article", input: {} });
  await updateContentJob(job.id, { status: "awaiting_approval", item_id: "item-first" });

  const res = await updateContentJob(job.id, { status: "reviewing" }, { ifStatusIn: CONTENT_JOB_RUNNING });

  assert.equal(res.refused, true, "THE BUG: this write used to apply and rewind the job");
  const after = await getContentJob(job.id);
  assert.equal(after.status, "awaiting_approval", "status untouched");
  assert.equal(after.item_id, "item-first", "item_id untouched");
});

test("R3.5.7 SHAPES — delivered and rewound are different rows, and item_id null is neither", () => {
  // Delivered: past the worker's hands WITH an item. `failed` counts — that is
  // the state production job 355b0237 was left in.
  for (const status of ["awaiting_approval", "approved", "published", "rejected", "failed"]) {
    assert.equal(isDeliveredContentJob({ status, item_id: "i1" }), true, `${status} + item is delivered`);
    assert.equal(isRewoundContentJob({ status, item_id: "i1" }), false, `${status} is not a rewind`);
    assert.equal(isDeliveredContentJob({ status, item_id: null }), false, `${status} without an item delivered nothing`);
  }
  // Rewound: a worker-owned status WITH an item.
  for (const status of CONTENT_JOB_RUNNING) {
    assert.equal(isRewoundContentJob({ status, item_id: "i1" }), true, `${status} + item is the damage shape`);
    assert.equal(isDeliveredContentJob({ status, item_id: "i1" }), false);
    assert.equal(isRewoundContentJob({ status, item_id: null }), false, `${status} without an item is LIVE WORK`);
  }
  assert.equal(isRewoundContentJob(null), false);
  assert.equal(isDeliveredContentJob(undefined), false);
});

test("R3.5.7 HEAL — listRewoundContentJobs asks the database for running status AND a non-null item_id", async () => {
  const { client, calls } = makeMockClient({
    content_jobs: () => ({
      data: [
        { id: "rewound", status: "reviewing", item_id: "item-1" },
        // A row the filter should never return; if a lax database did, the
        // in-process predicate is the second line of defence.
        { id: "live", status: "drafting", item_id: null },
      ],
      error: null,
    }),
  });

  const rows = await listRewoundContentJobs(10, { client });

  assert.deepEqual(rows.map((r) => r.id), ["rewound"], "live work must never be listed for healing");
  assert.deepEqual(calls[0].filters.find((f) => f[0] === "in"), ["in", "status", CONTENT_JOB_RUNNING]);
  assert.deepEqual(calls[0].filters.find((f) => f[0] === "not"), ["not", "item_id", "is", null]);
});

test("R3.5.7 HEAL — an unreadable table THROWS; it is never reported as 'nothing to heal'", async () => {
  const { client } = makeMockClient({
    content_jobs: () => ({ data: null, error: { message: "permission denied for table content_jobs" } }),
  });
  await assert.rejects(() => listRewoundContentJobs(10, { client }), ContentReadError);
});

test("R3.5.7 HEAL — a rewound row heals to awaiting_approval through a doubly-conditional UPDATE", async () => {
  const { client, calls } = makeMockClient({
    content_jobs: () => ({ data: [{ id: "rewound", status: "awaiting_approval" }], error: null }),
  });

  const out = await healRewoundContentJob({ id: "rewound", status: "reviewing", item_id: "item-1" }, { client });

  assert.equal(out.healed, true);
  assert.equal(out.reason, "rewound_after_delivery");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].op, "update");
  assert.equal(calls[0].values.status, "awaiting_approval");
  assert.equal("item_id" in calls[0].values, false, "the heal must never touch item_id — it is the evidence");
  assert.deepEqual(calls[0].filters.find((f) => f[0] === "eq"), ["eq", "id", "rewound"], "one row only");
  assert.deepEqual(calls[0].filters.find((f) => f[0] === "in"), ["in", "status", CONTENT_JOB_RUNNING]);
  assert.deepEqual(calls[0].filters.find((f) => f[0] === "not"), ["not", "item_id", "is", null]);
});

test("R3.5.7 HEAL — a job with NO item is never healed, and the database is not even asked", async () => {
  const { client, calls } = makeMockClient({
    content_jobs: () => {
      throw new Error("the heal must not reach the database for live work");
    },
  });

  const out = await healRewoundContentJob({ id: "live", status: "drafting", item_id: null }, { client });

  assert.equal(out.healed, false);
  assert.equal(out.reason, "not_rewound");
  assert.equal(calls.length, 0, "stamping awaiting_approval on a job with no draft would fabricate a delivery");
});

test("R3.5.7 HEAL — losing the race (someone moved the row first) is reported, not counted as a heal", async () => {
  const { client } = makeMockClient({ content_jobs: () => ({ data: [], error: null }) });
  const out = await healRewoundContentJob({ id: "rewound", status: "reviewing", item_id: "item-1" }, { client });
  assert.equal(out.healed, false);
  assert.equal(out.reason, "no_longer_rewound");
});

test("R3.5.7 HEAL — a failed heal write is reported with its reason, never swallowed", async () => {
  const { client } = makeMockClient({
    content_jobs: () => ({ data: null, error: { message: "deadlock detected" } }),
  });
  const out = await healRewoundContentJob({ id: "rewound", status: "reviewing", item_id: "item-1" }, { client });
  assert.equal(out.healed, false);
  assert.equal(out.reason, "heal_write_failed");
  assert.match(out.detail, /deadlock/);
});


test("rescue filters stale, undelivered, unleased jobs before applying the candidate limit", async () => {
  const nowMs = Date.parse("2026-10-07T12:00:00Z");
  const stale = "2026-10-07T11:00:00Z";
  const rows = Array.from({ length: 30 }, (_, i) => ({
    id: `busy-${i}`, status: "drafting", item_id: null,
    heartbeat_at: "2026-10-07T11:59:00Z", lease_owner: null, lease_expires_at: null,
  }));
  rows.push(
    { id: "delivered", status: "reviewing", item_id: "item-1", heartbeat_at: stale },
    { id: "leased", status: "researching", item_id: null, heartbeat_at: stale,
      lease_owner: "worker", lease_expires_at: "2026-10-07T12:05:00Z" },
    { id: "recover-1", status: "drafting", item_id: null, heartbeat_at: stale, lease_owner: null },
    { id: "recover-2", status: "researching", item_id: null, heartbeat_at: stale,
      lease_owner: "old-worker", lease_expires_at: "2026-10-07T11:05:00Z" }
  );
  const { client } = makeMockClient({ content_jobs: (query) => {
    const selected = rows.filter((row) => query.filters.every(([op, col, value]) => {
      if (op === "in") return value.includes(row[col]);
      if (op === "is") return (row[col] ?? null) === value;
      if (op === "or") return col.split(",").some((clause) => {
        const [field, predicate, ...rest] = clause.split(".");
        if (predicate === "is") return row[field] == null;
        if (row[field] == null) return false;
        const timestamp = Date.parse(rest.join("."));
        return predicate === "lte" ? Date.parse(row[field]) <= timestamp : Date.parse(row[field]) < timestamp;
      });
      throw new Error(`Unexpected filter ${op}`);
    }));
    return { data: selected.slice(0, query.limitN), error: null };
  } });
  assert.deepEqual((await listResumableContentJobs(2, { client, nowMs })).map((row) => row.id),
    ["recover-1", "recover-2"]);
});
