// §6.5 / §6.3.7 — the two customer job routes, driven through their real
// handlers over a real (in-memory) job store.
//
// The routes run unmodified; `requireWorkspace` is injected because there is no
// session in a unit test, and the store is the module's own MemoryJobStore so
// `getJobStatus`, `cancelJob` and the route's ownership check are the shipped
// code rather than a copy of it.
//
// The two 404s are asserted to be byte-identical: another workspace's job and a
// system job must not be distinguishable from a job that does not exist.
//
// Hooks: src/lib/customerRoutes.test.hooks.mjs, the same resolver the customer
// route tests use. It maps only module specifiers; nothing under test is
// replaced.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("../customerRoutes.test.hooks.mjs", import.meta.url);

const statusRoute = await import("../../app/api/customer/jobs/[jobId]/route.ts");
const cancelRoute = await import("../../app/api/customer/jobs/[jobId]/cancel/route.ts");
const { createMemoryJobStore } = await import("./memoryStore.ts");
const { jobCancelResponse, jobStatusResponse } = await import("./jobs.contract.ts");
const { AppError } = await import("../http/errors.ts");

const WORKSPACE = "workspace-a";
const OTHER_WORKSPACE = "workspace-b";
const OWN = "5b0d6f6e-9a8b-4a45-9a51-0e7e8f1c2d3a";
const FOREIGN = "9a7c1e2d-3b4f-4a56-8c9d-0e1f2a3b4c5d";
const SYSTEM = "1f2e3d4c-5b6a-4798-8c7d-6e5f4a3b2c1d";
const FINISHED = "c1d2e3f4-a5b6-4c7d-8e9f-0a1b2c3d4e5f";
const MISSING = "deadbeef-0000-4000-8000-000000000000";

const NOT_FOUND = { error: "This job does not exist in this workspace.", code: "job_not_found" };

/** §6.2's zod mapping: the offending field is named in `details.issues[]`. */
function assertInvalid(body, path) {
  assert.equal(body.code, "invalid_request");
  assert.equal(body.error, "The request was not valid.");
  assert.ok(body.details.issues.length > 0, "the failing field is named");
  assert.ok(
    body.details.issues.some((issue) => issue.path === path || String(issue.message).includes(path)),
    `expected an issue naming ${path}, got ${JSON.stringify(body.details.issues)}`
  );
}

const ENQUEUE = {
  brandKey: WORKSPACE,
  payload: {},
  trigger: "manual",
  dedupeKey: null,
  singleActiveKey: null,
  runAt: null,
  createdBy: null,
  deadlineSeconds: 86_400,
  maxInvocations: null,
};

/**
 * A live workspace for `requireWorkspace`, honouring the `brand_key` the route
 * passes through. A key that is not this member's workspace is a 404 from the
 * same function, exactly as the real one answers.
 */
function workspaceStub() {
  return async (request, opts = {}) => {
    const key = opts.brandKey ?? WORKSPACE;
    if (key !== WORKSPACE) throw new AppError(404, "workspace_not_found", "Workspace not found.");
    return {
      user: { id: "user-a", email: "a@example.test" },
      brandKey: WORKSPACE,
      brand: {
        brandKey: WORKSPACE,
        role: "owner",
        display_name: "QA Workspace",
        website: "https://workspace-a.example",
        website_host: "workspace-a.example",
        aliases: [],
        is_active: true,
      },
      role: "owner",
      admin: {},
    };
  };
}

/** One job per interesting row, in a store the test owns. */
async function fixture() {
  const store = createMemoryJobStore();

  const own = await store.enqueue({ ...ENQUEUE, kind: "keywords.research" });
  const foreign = await store.enqueue({ ...ENQUEUE, kind: "keywords.research", brandKey: OTHER_WORKSPACE });
  const system = await store.enqueue({ ...ENQUEUE, kind: "jobs.retention", brandKey: null, trigger: "system" });
  const finished = await store.enqueue({ ...ENQUEUE, kind: "keywords.research" });
  await store.claimDue("owner-1", 10, 300, finished.jobId);
  await store.finish({
    jobId: finished.jobId,
    owner: "owner-1",
    status: "completed",
    result: { keywords: 3 },
    errorCode: null,
    errorMessage: null,
  });

  // A running job with progress, the §6.3.5 example: the shape test's subject.
  await store.claimDue("owner-1", 10, 300, own.jobId);
  await store.progress(own.jobId, "owner-1", 3, 10, "Fetching keyword ideas", 300);

  return {
    store,
    ids: { own: own.jobId, foreign: foreign.jobId, system: system.jobId, finished: finished.jobId },
  };
}

function getJob(jobId, search = "", deps = {}) {
  return statusRoute.GET(
    new Request(`https://aeovis.test/api/customer/jobs/${jobId}${search}`),
    { params: Promise.resolve({ jobId }) },
    { requireWorkspace: workspaceStub(), ...deps }
  );
}

function cancelJob(jobId, body = undefined, init = {}, deps = {}) {
  return cancelRoute.POST(
    new Request(`https://aeovis.test/api/customer/jobs/${jobId}/cancel`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      ...init,
      ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
    }),
    { params: Promise.resolve({ jobId }) },
    { requireWorkspace: workspaceStub(), ...deps }
  );
}

async function read(response) {
  return {
    status: response.status,
    cacheControl: response.headers.get("cache-control"),
    body: await response.json(),
  };
}

test("GET /api/customer/jobs/[jobId] answers §6.5's shape for the workspace's own job", async () => {
  const { store, ids } = await fixture();
  const row = await store.getJob(ids.own);
  const { status, cacheControl, body } = await read(await getJob(ids.own, "", { store }));

  assert.equal(status, 200);
  assert.equal(cacheControl, "no-store");
  assert.deepEqual(body, {
    jobId: ids.own,
    kind: "keywords.research",
    trigger: "manual",
    status: "running",
    progress: { done: 3, total: 10, label: "Fetching keyword ideas" },
    pollAfterSeconds: 5,
    result: null,
    error: null,
    createdAt: row.created_at,
    finishedAt: null,
  });

  const parsed = jobStatusResponse.safeParse(body);
  assert.equal(parsed.success, true, parsed.success ? "" : JSON.stringify(parsed.error.issues));
});

test("GET /api/customer/jobs/[jobId] composes a terminal job with its result and pollAfterSeconds null", async () => {
  const { store, ids } = await fixture();
  const { status, body } = await read(await getJob(ids.finished, "", { store }));

  assert.equal(status, 200);
  assert.equal(body.status, "completed");
  assert.deepEqual(body.result, { keywords: 3 });
  assert.equal(body.error, null);
  assert.equal(body.pollAfterSeconds, null, "a terminal job is never polled again");
  assert.equal(jobStatusResponse.safeParse(body).success, true);
});

test("GET /api/customer/jobs/[jobId] normalises the Postgres timestamps PostgREST really sends", async () => {
  const { store, ids } = await fixture();
  // PostgREST renders timestamptz as `+00:00` with a microsecond fraction;
  // jobStatusResponse's z.iso.datetime() accepts only a `Z` instant.
  const postgrest = {
    ...store,
    getJob: async (jobId) => {
      const row = await store.getJob(jobId);
      if (!row) return row;
      return { ...row, created_at: "2026-10-21T09:00:00.123456+00:00", finished_at: "2026-10-21T09:04:00+00:00" };
    },
  };

  const { status, body } = await read(await getJob(ids.own, "", { store: postgrest }));
  assert.equal(status, 200);
  assert.equal(body.createdAt, "2026-10-21T09:00:00.123Z");
  assert.equal(body.finishedAt, "2026-10-21T09:04:00.000Z");

  const parsed = jobStatusResponse.safeParse(body);
  assert.equal(parsed.success, true, parsed.success ? "" : JSON.stringify(parsed.error.issues));
});

test("another workspace's job and a system job answer the same 404 as a job that does not exist", async () => {
  const { store, ids } = await fixture();
  const foreign = await read(await getJob(ids.foreign, "", { store }));
  const system = await read(await getJob(ids.system, "", { store }));
  const missing = await read(await getJob(MISSING, "", { store }));

  assert.equal(foreign.status, 404);
  assert.deepEqual(foreign.body, NOT_FOUND);
  assert.equal(system.status, 404);
  assert.deepEqual(system.body, NOT_FOUND);
  assert.equal(missing.status, 404);
  assert.deepEqual(
    missing.body,
    foreign.body,
    "a job id outside the workspace must not be distinguishable from one that never existed"
  );
  assert.deepEqual(system.body, foreign.body, "a system job must not be disclosed either");
});

test("GET /api/customer/jobs/[jobId] answers 400 invalid_request for a malformed uuid", async () => {
  const { store } = await fixture();
  const { status, body } = await read(await getJob("not-a-uuid", "", { store }));

  assert.equal(status, 400);
  assertInvalid(body, "jobId");
});

test("GET /api/customer/jobs/[jobId] rejects an unknown query field and honours brand_key", async () => {
  const { store, ids } = await fixture();

  const unknown = await read(await getJob(ids.own, "?limit=5", { store }));
  assert.equal(unknown.status, 400);
  assertInvalid(unknown.body, "limit");

  const otherBrand = await read(await getJob(ids.own, `?brand_key=${OTHER_WORKSPACE}`, { store }));
  assert.equal(otherBrand.status, 404);
  assert.deepEqual(otherBrand.body, { error: "Workspace not found.", code: "workspace_not_found" });
});

test("POST .../cancel cancels a queued job immediately and repeating returns the current status", async () => {
  const { store, ids } = await fixture();
  const other = await store.enqueue({ ...ENQUEUE, kind: "keywords.research", singleActiveKey: null });

  const first = await read(await cancelJob(other.jobId, undefined, {}, { store }));
  assert.equal(first.status, 200);
  assert.equal(first.cacheControl, "no-store");
  assert.deepEqual(first.body, { jobId: other.jobId, status: "cancelled" });
  assert.equal(jobCancelResponse.safeParse(first.body).success, true);

  const repeat = await read(await cancelJob(other.jobId, {}, {}, { store }));
  assert.equal(repeat.status, 200);
  assert.deepEqual(repeat.body, { jobId: other.jobId, status: "cancelled" });

  const row = await store.getJob(other.jobId);
  assert.equal(row.status, "cancelled");
  assert.equal(row.error_code, "cancelled", "a cancelled row records why");
  assert.deepEqual(ids.own.length > 0, true);
});

test("POST .../cancel requests cancellation of a running job and repeats idempotently", async () => {
  const { store, ids } = await fixture();
  const before = (await store.getJob(ids.own)).cancel_requested_at;

  const first = await read(await cancelJob(ids.own, { brand_key: WORKSPACE }, {}, { store }));
  assert.equal(first.status, 200);
  assert.deepEqual(first.body, { jobId: ids.own, status: "cancel_requested" });
  const afterFirst = await store.getJob(ids.own);
  assert.equal(afterFirst.status, "running", "a live lease leaves the status to the runner");
  assert.ok(afterFirst.cancel_requested_at, "the request is recorded for the runner to see");
  assert.notEqual(afterFirst.cancel_requested_at, before);

  const repeat = await read(await cancelJob(ids.own, undefined, {}, { store }));
  assert.equal(repeat.status, 200);
  assert.deepEqual(repeat.body, { jobId: ids.own, status: "cancel_requested" });
  assert.equal(
    (await store.getJob(ids.own)).cancel_requested_at,
    afterFirst.cancel_requested_at,
    "a repeat keeps the first request's timestamp"
  );
});

test("POST .../cancel of a finished job returns its own terminal status", async () => {
  const { store, ids } = await fixture();
  const { status, body } = await read(await cancelJob(ids.finished, undefined, {}, { store }));

  assert.equal(status, 200);
  assert.deepEqual(body, { jobId: ids.finished, status: "completed" });
});

test("POST .../cancel answers 404 job_not_found for another workspace's job and leaves it alone", async () => {
  const { store, ids } = await fixture();
  const before = await store.getJob(ids.foreign);

  const foreign = await read(await cancelJob(ids.foreign, undefined, {}, { store }));
  assert.equal(foreign.status, 404);
  assert.deepEqual(foreign.body, NOT_FOUND);

  const system = await read(await cancelJob(ids.system, undefined, {}, { store }));
  assert.equal(system.status, 404);
  assert.deepEqual(system.body, NOT_FOUND);

  assert.deepEqual(await store.getJob(ids.foreign), before, "a foreign job must not be touched");
  assert.equal((await store.getJob(ids.system)).status, "queued");
});

test("POST .../cancel answers 400 invalid_request for a malformed uuid or an unknown body field", async () => {
  const { store } = await fixture();

  const badId = await read(await cancelJob("not-a-uuid", undefined, {}, { store }));
  assert.equal(badId.status, 400);
  assertInvalid(badId.body, "jobId");

  const badField = await read(await cancelJob(OWN, { surprise: true }, {}, { store }));
  assert.equal(badField.status, 400);
  assertInvalid(badField.body, "surprise");
});

test("POST .../cancel answers 400 invalid_json for a body that is not JSON", async () => {
  const { store, ids } = await fixture();
  const { status, body } = await read(await cancelJob(ids.own, "{not json", {}, { store }));

  assert.equal(status, 400);
  assert.equal(body.code, "invalid_json");
  assert.equal((await store.getJob(ids.own)).cancel_requested_at, null, "a malformed body changes nothing");
});
