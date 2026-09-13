/**
 * R2.8.14 — the content cron must not answer 200 when Supabase is not
 * configured. A misconfigured deploy gets HTTP 200 with processed:0 from a
 * cron that ran nothing, which a cron monitor reading status codes would
 * report as healthy.
 *
 * WHY THIS IS A SEPARATE FILE. db.js builds its Supabase client at import
 * time from `process.env`, so "no credentials" is a property of the whole
 * process, not of one test. The existing dbReadOutage.route.test.mjs needs
 * a client (it drives postgrest's real error envelope through a refused
 * socket); this one needs the absence of one. Two processes, which is what
 * `node --test` gives per file.
 *
 * WHAT IS REAL HERE. The GET handler from src/app/api/content/worker/route.js
 * runs unmodified, with the real `isCronAuthorized` gate and the real
 * `recordCronTick` (which falls back to a memory map when there is no client).
 * The ONLY substitution is `globalThis.fetch`, which is set to fail any
 * network attempt — a route that reaches the network from an unconfigured
 * process would mean the `!supabase` branch never ran.
 *
 * The response carries the same `batch_unavailable` envelope R2.8.5
 * introduced: `{ reason, detail }` with a non-2xx status. That is the shape
 * the acceptance criteria requires, and `contentCronReport` produces it.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

// Cleared BEFORE the imports below: db.js decides `supabase` at import time.
delete process.env.NEXT_PUBLIC_SUPABASE_URL;
delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;

// The content worker route has an auth gate. CRON_SECRET must be set for
// NODE_ENV=production to pass. The test requests carry this value.
process.env.CRON_SECRET = "test-secret-for-r2814";

register("./cronAuth.route.hooks.mjs", import.meta.url);

let importError = null;
let GET = null;
let supabase = null;
let contentCronReport = null;
try {
  const [routeMod, dbMod, contentCronMod] = await Promise.all([
    import("../app/api/content/worker/route.js"),
    import("./db.js"),
    import("../app/api/content/worker/route.js"),
  ]);
  GET = routeMod.GET;
  supabase = dbMod.supabase;
  contentCronReport = contentCronMod.contentCronReport;
} catch (error) {
  importError = error;
}

function requireUnconfigured() {
  assert.equal(
    importError,
    null,
    'Could not import the content worker route. If this says "Cannot find package", run `npm install` — ' +
      `this suite exercises the real handler on purpose. Underlying: ${importError?.message}`
  );
  assert.equal(typeof GET, "function", "the content worker route must export GET");
  assert.equal(
    supabase,
    null,
    "this suite is only meaningful with NO client — the env above must really have been cleared"
  );
}

/** Fails the test if anything reaches the network; nothing here should. */
async function withNoNetwork(fn) {
  const realFetch = globalThis.fetch;
  let attempts = 0;
  globalThis.fetch = async (url) => {
    attempts++;
    throw new Error(`nothing may reach the network here, but something fetched ${String(url?.url || url)}`);
  };
  try {
    return { value: await fn(), attempts: () => attempts };
  } finally {
    globalThis.fetch = realFetch;
  }
}

/**
 * Build a minimal GET request that passes the cron auth gate.
 * CRON_SECRET is set in env above; the request carries it as a bearer token.
 */
function cronRequest(batch = false) {
  const url = batch
    ? "https://aeovis.test/api/content/worker?batch=1"
    : "https://aeovis.test/api/content/worker";
  return new Request(url, {
    headers: { Authorization: `Bearer ${process.env.CRON_SECRET}` },
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("with no client, the GET handler returns 5xx — not 200 'processed:0'", async () => {
  requireUnconfigured();

  const { value: response, attempts } = await withNoNetwork(() => GET(cronRequest()));

  assert.ok(
    response.status >= 500 && response.status < 600,
    `expected 5xx for an unconfigured deploy, got ${response.status}`
  );
  assert.equal(attempts(), 0, "the refusal must happen before any request is made");
});

test("the response carries the batch_unavailable envelope with reason db_not_configured", async () => {
  requireUnconfigured();

  const { value: response } = await withNoNetwork(() => GET(cronRequest()));
  const body = await response.json();

  assert.ok(body.batch_unavailable, "batch_unavailable must be present");
  assert.equal(
    body.batch_unavailable.reason,
    "db_not_configured",
    "the reason code must identify a misconfiguration, not a transient failure"
  );
  assert.match(
    body.batch_unavailable.detail,
    /not configured/i,
    "the detail must say the system is not configured"
  );
  assert.doesNotMatch(
    JSON.stringify(body),
    /supabase|postgres|ENOTFOUND|ECONNREFUSED/i,
    "the public response must not name infrastructure to an anonymous caller"
  );
});

test("all counters are zero — nothing was processed, and that is stated, not implied", async () => {
  requireUnconfigured();

  const { value: response } = await withNoNetwork(() => GET(cronRequest()));
  const body = await response.json();

  assert.equal(body.dispatched, 0);
  assert.deepEqual(body.dispatched_ids, []);
  assert.equal(body.skipped, 0);
  assert.equal(body.batch_dispatched, 0);
  assert.deepEqual(body.batch_dispatched_ids, []);
  assert.equal(body.batch_failed, 0);
  assert.deepEqual(body.batch_failed_brands, []);
  assert.equal(body.ledger_written, false, "ledger_written must be false — no DB to write to");
});

test("the response is the same shape contentCronReport produces for a DB-read outage", async () => {
  requireUnconfigured();

  // The canonical shape from R2.8.5: contentCronReport with batchUnavailable
  // set produces status 500 and the envelope.
  const canonical = contentCronReport({
    batchUnavailable: {
      reason: "db_read_failed",
      detail: "Could not read the brand list.",
    },
  });
  assert.equal(canonical.status, 500, "premise: contentCronReport returns 500 when batchUnavailable is set");

  // The unconfigured handler must produce the same shape.
  const { value: response } = await withNoNetwork(() => GET(cronRequest()));
  const body = await response.json();

  assert.equal(
    response.status,
    500,
    "the unconfigured deploy must return the same 500 as a DB-read outage"
  );
  assert.equal(typeof body.batch_unavailable, "object", "batch_unavailable must be an object");
  assert.equal(typeof body.batch_unavailable.reason, "string", "reason must be a string");
  assert.equal(typeof body.batch_unavailable.detail, "string", "detail must be a string");
  assert.equal(body.dispatched, 0, "dispatched must be present and 0");
  assert.equal(body.batch_dispatched, 0, "batch_dispatched must be present and 0");
});

test("with ?batch=1, the response is still 5xx — the batch flag does not bypass the check", async () => {
  requireUnconfigured();

  const { value: response } = await withNoNetwork(() => GET(cronRequest(true)));
  const body = await response.json();

  assert.ok(
    response.status >= 500 && response.status < 600,
    `expected 5xx with ?batch=1, got ${response.status}`
  );
  assert.ok(body.batch_unavailable, "batch_unavailable must still be present");
  assert.equal(body.batch_unavailable.reason, "db_not_configured");
});

test("the handler body uses contentCronReport for the !supabase branch (source assertion)", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(
    new URL("../app/api/content/worker/route.js", import.meta.url),
    "utf8"
  );

  // The !supabase branch must route through contentCronReport, not produce a
  // green 200 with its own ad-hoc body.
  assert.match(
    source,
    /if \(!supabase\)[\s\S]*contentCronReport\(/,
    "the !supabase branch must call contentCronReport with a batchUnavailable envelope"
  );
  assert.match(
    source,
    /if \(!supabase\)[\s\S]*db_not_configured/,
    "the reason code must be db_not_configured"
  );
  assert.doesNotMatch(
    source,
    /if \(!supabase\)[\s\S]*return NextResponse\.json\(\{[\s\S]*processed/,
    "the old 'processed: 0' response must not exist"
  );
});
