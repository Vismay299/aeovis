/**
 * R2.8.5 — the fail-quiet DB reads R2.8.4 left behind, each observed at the
 * caller that has to report the failure.
 *
 * R2.8.4 removed one shape from getScansForBrand: a read that answers with an
 * empty/benign value when the database could not be asked, so "we could not
 * look" and "there is nothing there" arrive at the caller identically. Three
 * siblings survived it, and this suite drives all three:
 *
 *   1. db.js getScansByDomain — `catch (err) { console.warn(...); return [] }`.
 *      Read by scanWorker's loadPreviousRoster, so an unreadable database
 *      became "this brand has never been scanned" and a scan that COULD have
 *      carried its previous rival roster forward was stamped
 *      roster_source=unavailable instead — a label that claims we looked.
 *   2. api/scans/_lib/scanRow.js getScanById — `if (!supabase) return null`,
 *      which the by-id route turns into 404 "Scan not found." A deploy with no
 *      credentials told every visitor their scan did not exist.
 *   3. api/content/worker/route.js — destructured only `{ data: brandsRows }`
 *      from the brand-list query and dropped `error`, so a total outage
 *      produced HTTP 200 with a fully green cron report.
 *
 * WHAT IS REAL HERE. db.js, scanRow.js, the by-id route handler, scanWorker's
 * runFinalizePhase, rosterContinuity and the content cron's own decision
 * functions all run unmodified, against the real @supabase/supabase-js client
 * db.js builds at import time. The ONLY substitution is `globalThis.fetch`,
 * standing in for the socket: it refuses the DB's address, or answers with a
 * real HTTP response, exactly as a network would. The module-resolution hooks
 * (shared with cronAuth.route.test.mjs) only answer "which file is this
 * specifier" for `@/…` and `next/server`.
 *
 * ONE THING IS NOT DRIVEN END TO END, and it is stated rather than implied: the
 * content cron's GET handler cannot be called in-process with a live client
 * attached, because its first act is `recordCronTick` — a WRITE to
 * system_heartbeats, which src/server/liveWriteGuard.js refuses in every test
 * process (and rightly: that table is customer-visible operational state).
 * So the two decisions the finding is about are exported from the route
 * (brandsForDailyBatch, contentCronReport), the handler has no other copy of
 * them, and they are driven here with the REAL postgrest envelope produced by
 * the REAL query against a refused connection. The wiring between them and the
 * handler body is pinned by a source assertion at the end of this file, which
 * is exactly as much as a source assertion is worth — it cannot prove
 * behaviour, only that the behaviour proven above is the one the route reaches.
 *
 * The `!supabase` half of getScanById needs a process with no credentials at
 * all and lives in src/server/scanByIdUnconfigured.route.test.mjs.
 *
 * DEPENDENCY NOTE: needs node_modules (`next`, `@supabase/supabase-js`). If the
 * import fails the first test FAILS LOUDLY rather than skipping — a skip here
 * would hide the exact paths this file exists to observe.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { readFile } from "node:fs/promises";

// db.js builds its Supabase client at import time, so this must be set BEFORE
// anything is imported. The host is real-looking but never reached: the stub
// below answers every request to it, which is how the real modules are driven
// onto their genuine failure paths without any of them being touched.
const DB_HOST = "https://db-for-r285.supabase.test";
process.env.NEXT_PUBLIC_SUPABASE_URL = DB_HOST;
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-key-for-a-host-that-does-not-answer";
process.env.CONTENT_DAILY_BATCH = "2";

register("./cronAuth.route.hooks.mjs", import.meta.url);

let importError = null;
let db = null;
let byIdGET = null;
let getScanById = null;
let worker = null;
let LlmUnavailableError = null;
let brandsForDailyBatch = null;
let contentCronReport = null;
try {
  const [dbMod, byId, scanRow, workerMod, llmErrors, contentCron] = await Promise.all([
    import("./db.js"),
    import("../app/api/scans/by-id/[scanId]/route.js"),
    import("../app/api/scans/_lib/scanRow.js"),
    import("./workers/scanWorker.js"),
    import("../shared/llmErrors.js"),
    import("../app/api/content/worker/route.js"),
  ]);
  db = dbMod;
  byIdGET = byId.GET;
  getScanById = scanRow.getScanById;
  worker = workerMod;
  LlmUnavailableError = llmErrors.LlmUnavailableError;
  brandsForDailyBatch = contentCron.brandsForDailyBatch;
  contentCronReport = contentCron.contentCronReport;
} catch (error) {
  importError = error;
}

function requireModules() {
  assert.equal(
    importError,
    null,
    'Could not import the modules under test. If this says "Cannot find package", run ' +
      `\`npm install\` — this suite exercises the real ones on purpose. Underlying: ${importError?.message}`
  );
  assert.ok(db?.supabase, "db.js must have built a Supabase client from the env set above");
  assert.equal(typeof byIdGET, "function", "the by-id route must export GET");
  assert.equal(typeof getScanById, "function", "scanRow must export getScanById");
  assert.equal(typeof worker?.runFinalizePhase, "function", "scanWorker must export runFinalizePhase");
  assert.equal(typeof brandsForDailyBatch, "function", "the content cron must export brandsForDailyBatch");
  assert.equal(typeof contentCronReport, "function", "the content cron must export contentCronReport");
}

/**
 * A connection the DB refuses. `AbortError` is the one failure postgrest does
 * NOT sit in a retry/backoff loop over, so the read fails at once instead of
 * spending seconds of suite time proving the same thing.
 */
function refusedConnection() {
  return Object.assign(new Error("connection refused by the database"), { name: "AbortError" });
}

/** Requests the DB actually received, so a test can prove it intercepted a real query. */
let dbRequests = [];

/** Run `fn` with every request to the DB answered by `answer(href, init)`. */
async function withDb(answer, fn) {
  const realFetch = globalThis.fetch;
  dbRequests = [];
  globalThis.fetch = async (url, init) => {
    const href = String(url?.url || url);
    if (href.startsWith(DB_HOST)) {
      dbRequests.push(href);
      return answer(href, init);
    }
    throw new Error(`unexpected fetch in test: ${href}`);
  };
  try {
    return await fn();
  } finally {
    globalThis.fetch = realFetch;
  }
}

const DB_UNREACHABLE = () => {
  throw refusedConnection();
};
const DB_RETURNS_500 = () =>
  new Response(JSON.stringify({ message: "server misconfigured", code: "XX000" }), {
    status: 500,
    headers: { "Content-Type": "application/json" },
  });
const DB_RETURNS_ROWS = (rows) => () =>
  new Response(JSON.stringify(rows), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

const SCAN_ID = "11111111-2222-3333-4444-555555555555";
const PRIOR_SCAN_ID = "99999999-8888-7777-6666-555555555555";
const SCAN_ROW = {
  id: SCAN_ID,
  brand: "Italica",
  url: "https://www.italicatiles.com/tiles",
  visibility_pct: 41,
  scanned_at: "2026-09-01T00:00:00.000Z",
  raw_results: { results: [] },
};

// ---------------------------------------------------------------------------
// 1. db.js — getScansByDomain
// ---------------------------------------------------------------------------

test("SITE 1 — getScansByDomain THROWS on an unreadable DB, it never fabricates 'no history'", async () => {
  requireModules();

  await assert.rejects(
    () => withDb(DB_UNREACHABLE, () => db.getScansByDomain("italicatiles.com")),
    (err) => {
      assert.ok(
        err instanceof db.ScansUnavailableError,
        `expected ScansUnavailableError, got ${err?.name}: ${err?.message}`
      );
      assert.equal(err.code, "db_read_failed");
      assert.ok(err.cause, "the postgrest envelope must survive on `cause` for an operator to read");
      return true;
    }
  );
  assert.ok(dbRequests.length > 0, "the stub must actually have intercepted the scans query");
});

test("SITE 1 — a DB answering HTTP 500 throws too (the same envelope, a different failure)", async () => {
  requireModules();
  await assert.rejects(
    () => withDb(DB_RETURNS_500, () => db.getScansByDomain("italicatiles.com")),
    (err) => err.name === "ScansUnavailableError" && err.code === "db_read_failed"
  );
});

test("SITE 1 — THE OTHER HALF: a DB that answers with no matching rows still returns []", async () => {
  requireModules();

  const none = await withDb(DB_RETURNS_ROWS([]), () => db.getScansByDomain("italicatiles.com"));
  assert.deepEqual(none, [], "a measured empty is still an empty array");

  const otherBrand = await withDb(DB_RETURNS_ROWS([SCAN_ROW]), () =>
    db.getScansByDomain("someone-else.com")
  );
  assert.deepEqual(otherBrand, [], "rows that do not match the host are a real, measured empty");

  const found = await withDb(DB_RETURNS_ROWS([SCAN_ROW]), () =>
    db.getScansByDomain("https://italicatiles.com/")
  );
  assert.equal(found.length, 1, "www/scheme/path variants still resolve to the brand");
  assert.equal(found[0].id, SCAN_ID);
});

// ---------------------------------------------------------------------------
// 2. scanWorker — the caller that read the fabricated empty as "no history".
//
// loadPreviousRoster only runs when rival extraction is already unavailable,
// which is exactly when the previous scan's roster is the only honest one left.
// ---------------------------------------------------------------------------

/** Everything runFinalizePhase touches. No writer here reaches a database. */
function finalizeDeps({ rows, updates, scans, getScansByDomain }) {
  return {
    getPromptResultsForJob: async () => rows,
    claimJobStatus: async (jobId, _from, to) => ({ id: jobId, status: to }),
    updateScanJob: async (jobId, patch) => {
      updates.push(patch);
      return { id: jobId, ...patch };
    },
    insertScan: async (record) => {
      scans.push(record);
      return [{ id: SCAN_ID }];
    },
    stampScanIdForJob: async () => ({ promptResults: rows.length, citations: 0 }),
    deleteCitationsForJob: async () => 0,
    insertCitations: async (r) => r,
    enrichCitations: async (r) => r,
    deleteResultBrandsForJob: async () => 0,
    insertResultBrands: async (r) => r,
    upsertBrandMetricsDaily: async (r) => r,
    resolveEnabledEngines: () => [{ name: "aio" }],
    // The failure that sends finalize looking for a previous roster at all.
    extractCompetitors: async () => {
      throw new LlmUnavailableError("the model is unreachable", { reason: "unavailable" });
    },
    getScansByDomain,
    getResultBrandsForScan: async () => [
      { name: "Rival One", is_self: false },
      { name: "Italica", is_self: true },
    ],
  };
}

function finalizeFixture(getScansByDomain) {
  const rows = [
    {
      id: "pr-1",
      job_id: "job-r285",
      brand: "italicatiles.com",
      query: "best tiles",
      engine: "aio",
      answered: true,
      mentioned: true,
      brand_cited: false,
      is_branded_query: false,
      scan_id: null,
      created_at: "2026-09-01T10:00:00.000Z",
      raw: {
        engine: "aio",
        query: "best tiles",
        is_branded_query: false,
        answer_present: true,
        aio_present: true,
        text: "Italica is a solid pick, though Rival One is popular too.",
        citations: [],
        references: [],
        brand_mentioned_in_text: true,
        brand_cited: false,
        visible: true,
        competitors_found_in_text: [],
        competitors_cited: [],
        brands: [{ name: "Italica", is_self: true, mentioned: true }],
        error: null,
        cost: 0.001,
      },
    },
  ];
  const updates = [];
  const scans = [];
  const checkpoint = {
    brand: "Italica",
    url: "https://www.italicatiles.com/tiles",
    industry: "tiles",
    competitors: [],
    competitors_raw: "",
    prompt_key: "italicatiles.com",
    queries: [{ text: "best tiles" }],
    unbranded_texts: ["best tiles"],
    engines: ["aio"],
    stats: { cost: 0, tokens: 0 },
    sourced_at: "2026-09-01T09:30:00.000Z",
  };
  return {
    rows,
    updates,
    scans,
    checkpoint,
    deps: finalizeDeps({ rows, updates, scans, getScansByDomain }),
  };
}

test("SITE 2 — an unreadable DB FAILS the finalize instead of recording 'no previous roster'", async () => {
  requireModules();

  // The REAL db.js function, with the module's own client, driven by the real
  // postgrest envelope a refused connection produces.
  const fixture = finalizeFixture((domain) => db.getScansByDomain(domain));

  await assert.rejects(
    () =>
      withDb(DB_UNREACHABLE, () =>
        worker.runFinalizePhase("job-r285", fixture.checkpoint, fixture.deps, {})
      ),
    (err) => {
      assert.equal(
        err.name,
        "ScansUnavailableError",
        `the scan-history read failure must reach the chunk, got ${err?.name}: ${err?.message}`
      );
      return true;
    }
  );

  assert.equal(
    fixture.scans.length,
    0,
    "no scan may be stamped from a finalize that could not read the brand's history"
  );
});

test("SITE 2 — THE OTHER HALF: a DB that answers keeps finalize working, roster and all", async () => {
  requireModules();

  // (a) genuinely no earlier scan for this domain -> roster_source=unavailable,
  //     which now means what it says: we looked, and there was nothing.
  const noHistory = finalizeFixture((domain) => db.getScansByDomain(domain));
  const jobA = await withDb(DB_RETURNS_ROWS([]), () =>
    worker.runFinalizePhase("job-r285a", noHistory.checkpoint, noHistory.deps, {})
  );
  assert.equal(jobA.status, "complete");
  assert.equal(jobA.run_record.roster_source, "unavailable");

  // (b) an earlier scan exists -> its roster is carried forward. This is the
  //     outcome the swallowed error used to destroy silently.
  const withHistory = finalizeFixture((domain) => db.getScansByDomain(domain));
  const jobB = await withDb(
    DB_RETURNS_ROWS([{ ...SCAN_ROW, id: PRIOR_SCAN_ID }]),
    () => worker.runFinalizePhase("job-r285b", withHistory.checkpoint, withHistory.deps, {})
  );
  assert.equal(jobB.status, "complete");
  assert.equal(
    jobB.run_record.roster_source,
    "carried_forward",
    "a readable DB with an earlier scan must carry that scan's rivals forward"
  );

  assert.notEqual(
    jobA.run_record.roster_source,
    jobB.run_record.roster_source,
    "'no history' and 'history carried forward' must not collapse into one state"
  );
});

// ---------------------------------------------------------------------------
// 3. getScanById at its route — outage vs. genuinely missing row.
// ---------------------------------------------------------------------------

function getById(scanId) {
  return byIdGET(new Request(`https://aeovis.test/api/scans/by-id/${scanId}`), {
    params: { scanId },
  });
}

test("SITE 3 — DB unreachable answers 5xx, NOT the 404 that means 'this scan does not exist'", async () => {
  requireModules();

  const response = await withDb(DB_UNREACHABLE, () => getById(SCAN_ID));

  assert.notEqual(response.status, 404, "an outage must never say the scan is not there");
  assert.ok(response.status >= 500 && response.status < 600, `expected 5xx, got ${response.status}`);
  const body = await response.json();
  assert.doesNotMatch(
    JSON.stringify(body),
    /supabase|postgres|ENOTFOUND|ECONNREFUSED/i,
    `a public error must not name infrastructure: ${JSON.stringify(body)}`
  );
});

test("SITE 3 — THE OTHER HALF: a DB that answers with no row is still a real 404", async () => {
  requireModules();
  const response = await withDb(DB_RETURNS_ROWS([]), () => getById(SCAN_ID));
  assert.equal(response.status, 404);
  assert.match((await response.json()).detail, /not found/i);
});

test("SITE 3 — a scan that exists is unaffected: 200 and the payload", async () => {
  requireModules();
  const response = await withDb(DB_RETURNS_ROWS([SCAN_ROW]), () => getById(SCAN_ID));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).scan?.id, SCAN_ID);
});

// ---------------------------------------------------------------------------
// 4. The content cron's brand list — the dead batch that reported itself green.
// ---------------------------------------------------------------------------

/** The route's own query, so the envelope under test is postgrest's real one. */
function brandListEnvelope() {
  return db.supabase.from("scans").select("brand").order("scanned_at", { ascending: false }).limit(200);
}

test("SITE 4 — an unreadable brand list is a 5xx that NAMES the dead batch, not a green 200", async () => {
  requireModules();

  const envelope = await withDb(DB_UNREACHABLE, brandListEnvelope);
  assert.equal(envelope.data, null, "premise: postgrest reports the failure, it does not reject");
  assert.ok(envelope.error, "premise: the failure arrives in the error field");

  const { brands, unavailable } = brandsForDailyBatch(envelope);
  assert.deepEqual(brands, [], "there is no brand list to work from");
  assert.ok(unavailable, "and that must be carried, not inferred from the empty list");

  const { status, body } = contentCronReport({ batchUnavailable: unavailable });
  assert.equal(status, 500, "a cron pass whose batch stage never ran must not answer 200");
  assert.equal(body.batch_dispatched, 0);
  assert.ok(body.batch_unavailable, "batch_unavailable is what makes batch_dispatched:0 readable");
  assert.match(
    body.batch_unavailable.detail,
    /did not run/i,
    "the report must say the batch did not run, not merely that nothing was created"
  );
});

test("SITE 4 — THE OTHER HALF: a real empty brand list is a 200 with batch_unavailable null", async () => {
  requireModules();

  const envelope = await withDb(DB_RETURNS_ROWS([]), brandListEnvelope);
  const { brands, unavailable } = brandsForDailyBatch(envelope);
  assert.deepEqual(brands, []);
  assert.equal(unavailable, null, "the DB answered — 'no brands' is a measurement");

  const { status, body } = contentCronReport({ batchUnavailable: unavailable });
  assert.equal(status, 200);
  assert.equal(body.batch_dispatched, 0);
  assert.equal(
    body.batch_unavailable,
    null,
    "null is what distinguishes this zero from the one above — it must be present, not absent"
  );
});

test("SITE 4 — brands are read, de-duplicated and reported when the DB answers", async () => {
  requireModules();

  const envelope = await withDb(
    DB_RETURNS_ROWS([{ brand: "Italica" }, { brand: "Italica" }, { brand: "Acme" }, { brand: null }]),
    brandListEnvelope
  );
  const { brands, unavailable } = brandsForDailyBatch(envelope);
  assert.equal(unavailable, null);
  assert.deepEqual(brands, ["Italica", "Acme"]);
});

test("SITE 4 — the outage report and the healthy report are distinguishable in both fields", async () => {
  requireModules();

  const outage = contentCronReport({
    startedIds: ["job-1"],
    batchUnavailable: { reason: "db_read_failed", detail: "…" },
  });
  const healthy = contentCronReport({ startedIds: ["job-1"] });

  assert.notEqual(outage.status, healthy.status);
  assert.notDeepEqual(outage.body, healthy.body);
  // R3.1.4 — `dispatched`, not `resumed`: these are fire-and-forget kicks, not
  // completed jobs. The count must still survive the outage report.
  assert.equal(
    outage.body.dispatched,
    1,
    "the dispatch half of the pass really happened and must still be reported"
  );
});

// ---------------------------------------------------------------------------
// 5. The wiring the live-write guard stops this file from calling. A source
//    assertion, and worth exactly what one is worth: it cannot prove the
//    handler behaves, only that it reaches the decisions proven above.
// ---------------------------------------------------------------------------

test("SITE 4 — the handler routes its brand list and its status through those two functions", async () => {
  const source = await readFile(
    new URL("../app/api/content/worker/route.js", import.meta.url),
    "utf8"
  );

  assert.match(
    source,
    /const \{ brands, unavailable \} = brandsForDailyBatch\(envelope\)/,
    "the handler must decide the brand list with brandsForDailyBatch, not by destructuring `data` again"
  );
  assert.doesNotMatch(
    source,
    /const \{ data: brandsRows \}/,
    "the error-dropping destructure is the bug — it must not come back"
  );
  assert.match(
    source,
    /const \{ status, body \} = contentCronReport\(/,
    "and it must take its status from contentCronReport"
  );
  assert.match(
    source,
    /NextResponse\.json\(body, \{ status \}\)/,
    "…and actually send that status, rather than computing it and answering 200"
  );
});

test("SITE 5 — the !supabase branch must also use contentCronReport, not answer 200", async () => {
  const source = await readFile(
    new URL("../app/api/content/worker/route.js", import.meta.url),
    "utf8"
  );

  // The !supabase branch must not produce a green 200 — it must route through
  // contentCronReport with a batchUnavailable envelope, the same shape R2.8.5
  // established for an unreadable brand list.
  assert.doesNotMatch(
    source,
    /if \(!supabase\)\s*\{[^}]*return NextResponse\.json\(\{[^}]*processed:\s*0/,
    "the old 'processed: 0' 200 response must be gone"
  );
  assert.doesNotMatch(
    source,
    /if \(!supabase\)\s*\{[^}]*return NextResponse\.json\(\{[^}]*dispatched:\s*0/,
    "the 'dispatched: 0' 200 response must also be gone"
  );
  assert.match(
    source,
    /if \(!supabase\)[\s\S]*contentCronReport\(/,
    "the !supabase branch must route through contentCronReport with a batchUnavailable envelope"
  );
  assert.match(
    source,
    /if \(!supabase\)[\s\S]*db_not_configured/,
    "the reason code must be db_not_configured"
  );
});
