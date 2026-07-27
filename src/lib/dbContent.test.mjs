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
  insertContentRun,
  finishContentRun,
  listContentRunsForJob,
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

test("listResumableContentJobs fails soft: a DB error yields no work, never a throw", async () => {
  const { client } = makeMockClient({
    content_jobs: () => ({ data: null, error: new Error("db down") }),
  });
  assert.deepEqual(await listResumableContentJobs(5, { client }), []);
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
