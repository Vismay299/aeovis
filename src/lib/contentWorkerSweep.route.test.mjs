/**
 * R3.1.4 — the content worker sweep distinguishes dispatched from completed,
 * and the in-memory path says so plainly.
 *
 * THE FINDING. The content worker sweep reported dispatched (fire-and-forget)
 * jobs as `resumed`, which collapsed two facts: a job we kicked off and a job
 * we chose not to kick off both rode the same wire as "resumed". The scan
 * worker sweep (R3.1.3) already fixed this class of defect with `dispatched`,
 * `processed`, `skipped`, `failed` — the content worker should follow the
 * same vocabulary rather than diverge.
 *
 * SECOND FINDING. The `!supabase` early return used `processed: 0`, which is
 * the scan worker's word for "a chunk ran and did no work". Nothing ran at
 * all — the correct word is `dispatched: 0`, and `ledger_written: false`
 * says plainly that no scan_runs row was recorded, so an empty ledger can
 * never be mistaken for an idle system.
 *
 * HOW THIS IS DRIVEN. Same pattern as scanWorkerRoute.route.test.mjs: the
 * real handler is imported via the module-resolution hooks (cronAuth.route
 * .hooks.mjs), called with a real Request, and the Response is observed.
 * No Supabase is configured, so the sweep returns at `if (!supabase)`.
 * The pure mapping function (contentCronReport) is driven directly for the
 * batch vocabulary tests.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { readFile } from "node:fs/promises";

const WORKER_URL = "https://aeovis.test/api/content/worker";
const SECRET = "r314-content-worker-secret";

// ---------------------------------------------------------------------------
// Environment, fixed BEFORE the route module is imported.
// ---------------------------------------------------------------------------
process.env.NODE_ENV = "production";
process.env.CRON_SECRET = SECRET;
delete process.env.NEXT_PUBLIC_SUPABASE_URL;
delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;

register("./cronAuth.route.hooks.mjs", import.meta.url);

let importError = null;
let GET = null;
let contentCronReport = null;
let brandsForDailyBatch = null;
try {
  ({
    GET,
    contentCronReport,
    brandsForDailyBatch,
  } = await import("../app/api/content/worker/route.js"));
} catch (error) {
  importError = error;
}

function handler() {
  assert.equal(
    importError,
    null,
    'Could not import the content worker route. If this says "Cannot find package", run ' +
      `\`npm install\` — this suite exercises the real handler on purpose. Underlying: ${importError?.message}`
  );
  assert.equal(typeof GET, "function", "the content worker route must export GET");
  return GET;
}

/** An authorized request, so every test below reaches the handler body. */
function authed(query = "") {
  return new Request(`${WORKER_URL}${query}`, { headers: { "x-cron-secret": SECRET } });
}

// ---------------------------------------------------------------------------
// 1. The `!supabase` early return uses `dispatched`, not `processed`, and
//    says plainly that no ledger row was written.
//
//    R2.8.14 routes this path through contentCronReport with batchUnavailable,
//    which returns 500 (a cron that ran nothing must not answer 200). R3.1.4
//    adds `ledger_written: false` so an empty scan_runs table can never be
//    mistaken for an idle system.
// ---------------------------------------------------------------------------

test("ROUTE — the !supabase path uses dispatched vocabulary and says no ledger was written", async () => {
  handler();
  const response = await handler()(authed());
  const body = await response.json();

  // R2.8.14: 500 because the batch stage could not run (no Supabase).
  assert.equal(response.status, 500, "an unconfigured deploy must not answer 200 — the cron monitor would see it as healthy");
  assert.equal(body.dispatched, 0, "measured zero, not absent");
  assert.equal(body.skipped, 0, "measured zero, not absent");
  assert.equal(body.batch_dispatched, 0, "measured zero, not absent");
  assert.equal(body.batch_failed, 0, "measured zero, not absent");

  // R3.1.4 — ledger_written: false says plainly that no scan_runs row was written.
  assert.equal(body.ledger_written, false,
    "no Supabase means no scan_runs row was written — the response must say so"
  );

  // batch_unavailable explains WHY the batch did not run.
  assert.ok(body.batch_unavailable, "batch_unavailable is what makes batch_dispatched:0 readable");
  assert.match(body.batch_unavailable.detail, /not configured/i,
    "the detail must explain the situation to an operator"
  );

  // The old vocabulary must not appear.
  assert.equal(body.processed, undefined,
    "this invocation ran no content job, so it must not report a chunk outcome counter at all"
  );
  assert.equal(body.resumed, undefined, "the word `resumed` must not appear — use `dispatched`");
  assert.equal(body.skipped_leased, undefined, "the word `skipped_leased` must not appear — use `skipped`");
});

// ---------------------------------------------------------------------------
// 2. contentCronReport's vocabulary: dispatched, not resumed.
// ---------------------------------------------------------------------------

test("REPORT — contentCronReport uses `dispatched` and `skipped`, not `resumed` and `skipped_leased`", () => {
  handler();
  const { body } = contentCronReport({
    startedIds: ["job-a", "job-b"],
    skippedIds: ["job-c"],
  });

  // The new vocabulary
  assert.equal(body.dispatched, 2, "two jobs were dispatched (fire-and-forget)");
  assert.deepEqual(body.dispatched_ids, ["job-a", "job-b"]);
  assert.equal(body.skipped, 1, "one job was skipped (leased by another worker)");

  // The old vocabulary must not exist
  assert.equal(body.resumed, undefined, "the word `resumed` must not appear — it counted dispatched as done");
  assert.equal(body.resumed_ids, undefined, "the word `resumed_ids` must not appear");
  assert.equal(body.skipped_leased, undefined, "the word `skipped_leased` must not appear — use `skipped`");
});

test("REPORT — contentCronReport uses `batch_dispatched` and `batch_dispatched_ids`, not `batch_created` and `batch_ids`", () => {
  handler();
  const { body } = contentCronReport({
    startedIds: [],
    skippedIds: [],
    batchCreated: ["batch-job-1", "batch-job-2"],
    batchFailed: [{ brand: "acme.com", reason: "error" }],
  });

  // The new vocabulary
  assert.equal(body.batch_dispatched, 2, "two batch jobs were dispatched (fire-and-forget)");
  assert.deepEqual(body.batch_dispatched_ids, ["batch-job-1", "batch-job-2"]);
  assert.equal(body.batch_failed, 1);

  // The old vocabulary must not exist
  assert.equal(body.batch_created, undefined,
    "the word `batch_created` must not appear — it counted dispatched as done"
  );
  assert.equal(body.batch_ids, undefined, "the word `batch_ids` must not appear — use `batch_dispatched_ids`");
});

test("REPORT — the two sides of the report are both present and distinguishable", () => {
  handler();
  const { body } = contentCronReport({
    startedIds: ["resumed-job"],
    skippedIds: ["skipped-job"],
    batchCreated: ["batch-job"],
    batchFailed: [{ brand: "fail.com", reason: "error" }],
  });

  assert.equal(body.dispatched, 1, "one resume-side job dispatched");
  assert.equal(body.skipped, 1, "one resume-side job skipped");
  assert.equal(body.batch_dispatched, 1, "one batch-side job dispatched");
  assert.equal(body.batch_failed, 1, "one batch-side brand failed");
  // All four counters must coexist — they are four different facts.
  // The values CAN be equal (both 1 here); what matters is that each counter
  // is a separate field, tracking a separate category of work.
  const keys = ["dispatched", "skipped", "batch_dispatched", "batch_failed"];
  for (const key of keys) {
    assert.ok(key in body, `the report must carry '${key}'`);
  }
});

test("REPORT — a healthy pass with nothing to do reports measured zeros", () => {
  handler();
  const { status, body } = contentCronReport({});

  assert.equal(status, 200);
  assert.equal(body.dispatched, 0, "measured zero, not absent");
  assert.equal(body.skipped, 0, "measured zero, not absent");
  assert.equal(body.batch_dispatched, 0, "measured zero, not absent");
  assert.equal(body.batch_failed, 0, "measured zero, not absent");
  assert.equal(body.batch_unavailable, null, "null means the brand list was readable and empty");
});

// ---------------------------------------------------------------------------
// 3. Source guard: the handler uses the new vocabulary.
// ---------------------------------------------------------------------------

test("GUARD — the content worker route uses contentCronReport for its response", async () => {
  const source = await readFile(
    new URL("../app/api/content/worker/route.js", import.meta.url),
    "utf8"
  );

  // The handler must call contentCronReport, not inline the response shape.
  assert.match(
    source,
    /const \{ status, body \} = contentCronReport\(/,
    "the handler must take its status from contentCronReport"
  );
  assert.match(
    source,
    /NextResponse\.json\(\{ \.\.\.body, ledger_written: false \}, \{ status \}\)/,
    "the no-db path must spread contentCronReport's body and add ledger_written: false"
  );

  // The old vocabulary must not appear in the route body at all.
  assert.doesNotMatch(
    source,
    /resumed:\s*startedIds\.length/,
    "the route must not report `resumed` — use `dispatched`"
  );
  assert.doesNotMatch(
    source,
    /skipped_leased/,
    "the route must not report `skipped_leased` — use `skipped`"
  );
  assert.doesNotMatch(
    source,
    /batch_created:\s*batchCreated\.length/,
    "the route must not report `batch_created` — use `batch_dispatched`"
  );

  // ledger_written: false must be present in the no-db path.
  assert.match(
    source,
    /ledger_written:\s*false/,
    "the no-db path must say plainly that no ledger row was written"
  );
});

// ---------------------------------------------------------------------------
// 4. The in-memory response carries batch_unavailable so the 500 is readable.
// ---------------------------------------------------------------------------

test("ROUTE — the !supabase path carries batch_unavailable so the 500 means 'not configured', not 'batch failed'", async () => {
  handler();
  const response = await handler()(authed());
  const body = await response.json();

  assert.equal(response.status, 500);
  assert.ok(body.batch_unavailable, "batch_unavailable is the reason for the 500");
  assert.equal(body.batch_unavailable.reason, "db_not_configured");
  // And R3.1.4's ledger_written sits alongside it so the empty ledger is explained.
  assert.equal(body.ledger_written, false);
});
