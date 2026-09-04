/**
 * R3.1.3 — GET /api/scan/worker tells the truth about the chunk it ran.
 *
 * THE FINDING, verbatim from production: a garbage `job_id` answered
 * HTTP 200 `{"processed":1,"job_id":"…","mode":"direct-resume"}`. runScanChunk
 * had returned `{ok:false, reason:"read_failed"}` and the route counted it as
 * one processed job anyway, because line 61 reported `processed: 1`
 * unconditionally. On the route Vercel's cron drives daily, a chunk that did
 * nothing was indistinguishable from one that carried a scan to completion.
 * Standing rule 1: a skip is not a success.
 *
 * WHAT THIS SUITE DOES. It imports the REAL handler from
 * src/app/api/scan/worker/route.js through the same module-resolution hooks
 * cronAuth.route.test.mjs uses (they only answer "which file is this
 * specifier" for `@/` and `next/server` — nothing is stubbed, the handler body
 * and runScanChunk itself run unmodified) and asserts on the real Response.
 *
 * NO SCAN IS EVER STARTED, and no network call is made:
 *   - Supabase env is cleared before the route imports, so db.js's client is
 *     null. Every read/write goes to `global.memoryJobs`, the scan_runs ledger
 *     announces itself disabled, and the sweep path returns at `if (!supabase)`
 *     BEFORE it can list or resume anything.
 *   - Every job_id under test resolves to "no such job", "already finished" or
 *     "cannot read the store". runScanChunk returns from each of those before
 *     entering a work phase, so no prompt is sourced and no engine is probed.
 *
 * WHAT IT CANNOT DRIVE, stated rather than papered over: the `processed`
 * bucket. The only two chunk results that map to it — `complete` and
 * `checkpointed` — require a real probing or finalize phase, i.e. real Bright
 * Data and LLM spend. That branch is covered here at two removes instead: the
 * pure mapping function the route delegates to is asserted directly, and a
 * source guard pins the outcome->bucket line. Everything else in this file is
 * an observed Response.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { readFile } from "node:fs/promises";

const WORKER_URL = "https://aeovis.test/api/scan/worker";
const SECRET = "r313-worker-route-secret";

// ---------------------------------------------------------------------------
// Environment, fixed BEFORE the route module is imported (db.js and
// db/analytics.js build their clients at import time).
// ---------------------------------------------------------------------------
process.env.NODE_ENV = "production";
process.env.CRON_SECRET = SECRET;
delete process.env.NEXT_PUBLIC_SUPABASE_URL;
delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;

register("./cronAuth.route.hooks.mjs", import.meta.url);

let importError = null;
let GET = null;
let chunkRunOutcome = null;
try {
  ({ GET } = await import("../app/api/scan/worker/route.js"));
  ({ chunkRunOutcome } = await import("./workers/scanWorker.js"));
} catch (error) {
  importError = error;
}

function handler() {
  assert.equal(
    importError,
    null,
    "Could not import the worker route. If this says \"Cannot find package 'next'\", run " +
      `\`npm install\` — this suite exercises the real handler on purpose. Underlying: ${importError?.message}`
  );
  assert.equal(typeof GET, "function", "the worker route must export GET");
  return GET;
}

/** An authorized request, so every test below reaches the handler body. */
function authed(query = "") {
  return new Request(`${WORKER_URL}${query}`, { headers: { "x-cron-secret": SECRET } });
}

/** Assert a body does not, in any of its shapes, claim work that did not happen. */
function assertNotASuccess(body, label) {
  assert.notEqual(
    body.processed,
    1,
    `${label}: the response still reports processed:1 for a chunk that did no work — ` +
      `this is the R3.1.3 finding, exactly as production returned it (${JSON.stringify(body)})`
  );
  assert.equal(body.processed, 0, `${label}: processed must be a visible 0, not absent`);
  assert.notEqual(body.outcome, "processed", `${label}: outcome must not read as processed`);
}

test("the worker route module imports and exports GET", () => {
  handler();
});

// ---------------------------------------------------------------------------
// The criterion: a garbage job_id, driven through the real handler.
// ---------------------------------------------------------------------------

test("ROUTE — a garbage job_id is NOT reported as processed", async () => {
  const jobId = "not-a-real-job-id-💥";
  const response = await handler()(authed(`?job_id=${encodeURIComponent(jobId)}`));
  const body = await response.json();

  assertNotASuccess(body, "garbage job_id");
  assert.equal(body.outcome, "skipped");
  assert.equal(body.skipped, 1);
  assert.equal(body.failed, 0);
  assert.equal(body.reason, "not_found", "the reason the chunk gave must survive to the wire");
  assert.equal(body.job_id, jobId);
  assert.equal(body.mode, "direct-resume");

  // 200, deliberately: a job that is not there is a legitimate no-work
  // outcome, and paging an operator for one would be its own false alarm.
  assert.equal(response.status, 200, "an absent job is not a server error");
});

test("ROUTE — a chunk that could not read the job is reported as FAILED, with a 5xx", async () => {
  // The production case in the finding: getScanJob THROWS (there, because
  // Postgres rejects a non-uuid), runScanChunk returns
  // {ok:false, reason:"read_failed"}. Reproduced here by making the store the
  // in-memory getScanJob reads throw — the code under test is untouched, only
  // the data source it reads fails, which is what a DB read failure is.
  const realStore = global.memoryJobs;
  global.memoryJobs = {
    get() {
      throw new Error("simulated transient read failure");
    },
    set() {},
    values() {
      return [];
    },
  };
  try {
    const response = await handler()(authed("?job_id=6e89e308-0000-4000-8000-000000000000"));
    const body = await response.json();

    assertNotASuccess(body, "read_failed");
    assert.equal(body.outcome, "failed");
    assert.equal(body.failed, 1);
    assert.equal(body.skipped, 0);
    assert.equal(body.reason, "read_failed");
    assert.equal(
      response.status,
      500,
      "a chunk that ran and did not finish must not answer 200 — that is how read_failed hid"
    );
  } finally {
    global.memoryJobs = realStore;
  }
});

test("ROUTE — ok:true with no work done is skipped, not processed", async () => {
  // already_finished: the chunk looked, and the job was genuinely already
  // complete. ok is TRUE here, so "count anything ok:true as processed" would
  // pass the two tests above and still be wrong.
  const jobId = "r313-already-complete";
  global.memoryJobs.set(jobId, { id: jobId, brand: "acme", status: "complete" });
  try {
    const response = await handler()(authed(`?job_id=${jobId}`));
    const body = await response.json();

    assertNotASuccess(body, "already_finished");
    assert.equal(body.outcome, "skipped");
    assert.equal(body.skipped, 1);
    assert.equal(body.reason, "already_finished");
    assert.equal(response.status, 200);
  } finally {
    global.memoryJobs.delete(jobId);
  }
});

test("ROUTE — a checkpointed job in a status with no work is skipped, and says which status", async () => {
  const jobId = "r313-nothing-to-do";
  global.memoryJobs.set(jobId, {
    id: jobId,
    brand: "acme",
    status: "awaiting_review",
    checkpoint: { queries: [], engines: [] },
  });
  try {
    const response = await handler()(authed(`?job_id=${jobId}`));
    const body = await response.json();

    assertNotASuccess(body, "noop");
    assert.equal(body.outcome, "skipped");
    assert.equal(
      body.reason,
      "noop_status_awaiting_review",
      "an unexplained noop is exactly what the reason field exists to prevent"
    );
    assert.equal(response.status, 200);
  } finally {
    global.memoryJobs.delete(jobId);
  }
});

// ---------------------------------------------------------------------------
// The other path the cron actually drives: no job_id.
// ---------------------------------------------------------------------------

test("ROUTE — the no-job_id path reports dispatch, never 'processed'", async () => {
  // Vercel's cron calls this route with no query at all. With no Supabase it
  // returns before the sweep, so nothing is listed and nothing is resumed.
  const response = await handler()(authed());
  const body = await response.json();

  assert.equal(response.status, 200, "an idle cron tick is not a failure");
  assert.equal(body.mode, "no-db");
  assert.equal(body.dispatched, 0);
  assert.equal(
    body.processed,
    undefined,
    "this invocation ran no chunk, so it must not report a chunk outcome counter at all"
  );
});

// ---------------------------------------------------------------------------
// The mapping the route delegates to, and the guard that keeps it complete.
// ---------------------------------------------------------------------------

test("MAPPING — every reason runScanChunk can return is known to chunkRunOutcome", async () => {
  handler();
  const src = await readFile(new URL("./workers/scanWorker.js", import.meta.url), "utf8");
  const start = src.indexOf("export async function runScanChunk");
  assert.ok(start > 0, "runScanChunk must be findable in the source");
  const body = src.slice(start);
  const reasons = [...new Set([...body.matchAll(/reason:\s*"([a-z_]+)"/g)].map((m) => m[1]))];
  assert.ok(reasons.length >= 8, `expected the full reason vocabulary, found ${reasons.join(", ")}`);

  for (const reason of reasons) {
    const mapped = chunkRunOutcome({ reason });
    assert.doesNotMatch(
      mapped.reason,
      /^unmapped_chunk_reason/,
      `runScanChunk can return reason "${reason}" and the ledger has no case for it — ` +
        `the worker route buckets on this mapping, so an unmapped reason is a route-level lie too`
    );
  }
});

test("MAPPING — the two working outcomes are the only ones that mean 'processed'", () => {
  handler();
  assert.equal(chunkRunOutcome({ ok: true, reason: "complete" }).outcome, "succeeded");
  assert.equal(chunkRunOutcome({ ok: true, reason: "checkpointed" }).outcome, "succeeded");

  for (const reason of ["not_found", "sourcing_claimed_elsewhere", "finalize_claimed_elsewhere"]) {
    assert.equal(chunkRunOutcome({ reason }).outcome, "skipped", reason);
  }
  for (const reason of ["already_finished", "noop"]) {
    assert.equal(chunkRunOutcome({ reason }).outcome, "noop", reason);
  }
  for (const reason of ["read_failed", "error"]) {
    assert.equal(chunkRunOutcome({ reason }).outcome, "failed", reason);
  }
  // Nothing at all, and something invented: both failed, never rounded up.
  assert.equal(chunkRunOutcome(undefined).outcome, "failed");
  assert.equal(chunkRunOutcome({ ok: true, reason: "brand_new_reason" }).outcome, "failed");
});

test("GUARD — the route counts only a succeeded chunk as processed", async () => {
  const src = await readFile(new URL("../app/api/scan/worker/route.js", import.meta.url), "utf8");
  assert.match(
    src,
    /RUN_OUTCOMES\.SUCCEEDED[\s\S]{0,120}?"processed"/,
    "the processed bucket must be reached only from the SUCCEEDED ledger outcome"
  );
  assert.doesNotMatch(
    src,
    /\{\s*processed:\s*1\s*,/,
    "an unconditional processed:1 is the R3.1.3 defect — the counter must be derived from the result"
  );
});
