import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { readFile } from "node:fs/promises";

/**
 * R2.8.7 — insertScan's cascade 3 wrote the row and reported nothing.
 *
 * R2.2.4 UPDATE — THE CASCADE IS GONE, THIS FILE IS NOT. insertScan no longer
 * retries an insert with fewer columns, so "cascade 3" is now simply the one
 * insert it performs, and the guarantee this file was written to pin — an
 * accepted write is either RETURNED with its row or FAILS LOUDLY, never
 * resolved as a silent null — moved onto that single path with
 * `confirmScanWritten`. Every test below therefore still asserts something
 * live; the ones that used to drive the fall-through now assert that no
 * fall-through happens:
 *   - the legacy-schema server (tests 2/3 pre-R2.2.4) now proves the mismatch
 *     is REFUSED rather than answered with a thinner row (tests 2 and 6);
 *   - the missing-representation case moved onto the modern schema, where it is
 *     now reachable on the ONLY insert (test 4);
 *   - and the file keeps its name because the ledger records R2.8.7's evidence
 *     against these line numbers.
 *
 * THE MECHANISM, and why it is invisible from inside db.js:
 *
 *   postgrest-js/dist/index.mjs:614 — `.select()` is the ONLY call that
 *   appends `Prefer: return=representation`.
 *   postgrest-js/dist/index.mjs:378-385 — `processResponse` starts with
 *   `let data = null` and, for a 201 whose body is empty, runs an EMPTY BLOCK
 *   (`if (body === "") {}`). `data` stays null; `error` stays null.
 *
 * Cascades 1 and 2 call `.select()`. Cascade 3 did not. So on the legacy
 * schema — the ONLY schema on which cascade 3 is ever reached — a row that was
 * genuinely INSERTed came back as `{ data: null, error: null }`, insertScan
 * returned null, and runFinalizePhase's `savedScan?.[0]?.id` read it as "the
 * write produced nothing".
 *
 * THE OUTCOME THIS FILE PINS DOWN. The original finding called it a duplicate
 * `scans` row. The routine outcome is worse and quieter: runFinalizePhase
 * throws "Failed to save scan results", the job is marked FAILED,
 * stampScanIdForJob never runs, and the `scans` row that IS in the table is
 * ORPHANED — no prompt_results.scan_id, no citations, no result_brands, no
 * brand_metrics_daily. The customer is shown a failed scan that succeeded.
 * A DUPLICATE additionally requires a re-dispatch of the same job (the cron
 * sweep will not do it: runScanChunk answers `already_finished` for a failed
 * job and shouldRescueJob returns false for one). Test 4 drives that
 * re-dispatch explicitly rather than pretending it is the common case.
 *
 * NO DATABASE IS TOUCHED, AND NOTHING IS MOCKED EXCEPT THE SOCKET. The client
 * injected below is the REAL PostgrestClient from the installed postgrest-js —
 * the same class `createClient()` builds `supabase.from` on — driven by a
 * `fetch` that never leaves this process and answers the way a PostgREST in
 * front of the pre-scoring_version schema answers. That is deliberate: a
 * hand-rolled stub would be asserting my own model of the bug, and the bug IS
 * the library's response handling. `PostgrestClient` is reached through
 * @supabase/supabase-js's own dependency copy, by path, so this file cannot
 * silently bind to a different version than db.js uses.
 */

// ---------------------------------------------------------------------------
// The library under observation. One constant, used both to READ the source
// (test 1) and to CONSTRUCT the client (tests 2-5) — so a wrong path fails
// both, loudly, instead of quietly proving nothing.
// ---------------------------------------------------------------------------
const POSTGREST_DIST = new URL(
  "../../node_modules/@supabase/postgrest-js/dist/index.mjs",
  import.meta.url
);

let postgrest = null;
let postgrestImportError = null;
try {
  postgrest = await import(POSTGREST_DIST.href);
} catch (err) {
  postgrestImportError = err;
}

function requirePostgrest() {
  assert.equal(
    postgrestImportError,
    null,
    "Could not load the installed @supabase/postgrest-js. Run `npm install`. " +
      `Underlying: ${postgrestImportError?.message}`
  );
  assert.ok(postgrest?.PostgrestClient, "postgrest-js exports no PostgrestClient to drive");
}

// db.js reads NEXT_PUBLIC_SUPABASE_* at import time. They are deliberately NOT
// set here: every call below passes `deps.client` explicitly, so the
// module-level `supabase` binding is never consulted and cannot be a live one.
// (`npm run test:scoring` also preloads liveWriteGuardAuto.mjs, which patches
// SupabaseClient.prototype — a class this file never instantiates. The
// protection here is structural, not borrowed: there is no transport.)
register("./cronAuth.route.hooks.mjs", import.meta.url);

let db = null;
let worker = null;
let importError = null;
try {
  [db, worker] = await Promise.all([import("./db.js"), import("./workers/scanWorker.js")]);
} catch (err) {
  importError = err;
}

function requireModules() {
  assert.equal(
    importError,
    null,
    `Could not import the modules under test — run \`npm install\`. Underlying: ${importError?.message}`
  );
  assert.equal(
    db.supabase,
    null,
    "this suite must run with no ambient Supabase client; every call injects deps.client"
  );
}

// ---------------------------------------------------------------------------
// Two PostgRESTs, differing only in which columns `scans` has.
//
// LEGACY_COLUMNS is 001_initial_schema.sql's `scans` MINUS the five the old
// cascade used to drop — the deployment cascade 3 existed to serve, and the one
// that must now be REFUSED (a database behind its own first migration).
// MODERN_COLUMNS is what 001 actually creates (:12-24) and what every real
// deployment has, so it is where the success and missing-representation paths
// are driven from.
// ---------------------------------------------------------------------------
const LEGACY_COLUMNS = new Set([
  "id",
  "created_at",
  "brand",
  "url",
  "industry",
  "platform",
  "visibility_pct",
  "prompts_tracked",
  "prompts_mentioned",
  "competitors",
  "scanned_at",
  "used_dynamic_prompts",
  "raw_results",
  "competitors_raw",
]);

// The five R2.2.4 refuses to drop, on top of the legacy set.
const CASCADE_DROPPED_COLUMNS = [
  "scoring_version",
  "score_ci_low",
  "score_ci_high",
  "stability",
  "mention_rate_pct",
];

const MODERN_COLUMNS = new Set([...LEGACY_COLUMNS, ...CASCADE_DROPPED_COLUMNS, "query_source"]);

function jsonResponse(status, payload) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * @param {object} [opts]
 * @param {boolean} [opts.stripRepresentation] answer 201 with an EMPTY BODY even
 *   when `Prefer: return=representation` was asked for — a proxy or gateway
 *   that drops the header. The row is still written. This is the case that must
 *   remain distinguishable from a refused write.
 * @param {Set<string>} [opts.columns] the schema this server is in front of.
 */
function fakePostgrest({ stripRepresentation = false, columns = MODERN_COLUMNS } = {}) {
  const rows = []; // the fake `scans` table
  const requests = []; // every request that reached the "server"
  let nextId = 1;

  const fetchImpl = async (url, init = {}) => {
    const headers = new Headers(init.headers || {});
    const sent = init.body ? JSON.parse(init.body) : [];
    const prefer = headers.get("Prefer") || "";
    requests.push({ url: String(url), method: init.method, prefer, rows: sent });

    if (init.method !== "POST") return jsonResponse(200, []);

    // Which columns the insert claims, as PostgREST reads them: postgrest-js
    // puts the union of the rows' keys in the `columns` query param, and
    // JSON.stringify drops the ones whose value is undefined — so the BODY
    // alone under-reports what the statement names. PostgREST validates the
    // `columns` list, which is why cascade 1 is refused by a legacy schema even
    // when `scoring_version` is undefined on the record.
    const declared = new URL(String(url)).searchParams.get("columns");
    const named = declared
      ? declared.split(",").map((c) => c.replace(/^"|"$/g, ""))
      : sent.flatMap((r) => Object.keys(r));
    const unknown = named.filter((k) => !columns.has(k));
    if (unknown.length > 0) {
      // Exactly what PostgREST answers for a column the schema cache lacks.
      return jsonResponse(400, {
        code: "PGRST204",
        message: `Could not find the '${unknown[0]}' column of 'scans' in the schema cache`,
        details: null,
        hint: null,
      });
    }

    // THE WRITE HAPPENS HERE — before any decision about what to answer with.
    const written = sent.map((r) => ({ id: `scan-${nextId++}`, created_at: NOW, ...r }));
    rows.push(...written);

    if (!stripRepresentation && prefer.includes("return=representation")) {
      return jsonResponse(201, written);
    }
    // PostgREST's default for an insert with no representation requested: 201,
    // empty body. postgrest-js turns this into { data: null, error: null }.
    return new Response("", { status: 201 });
  };

  return {
    client: new postgrest.PostgrestClient("http://scans-schema.test", { fetch: fetchImpl }),
    rows,
    requests,
    inserts: () => requests.filter((r) => r.method === "POST"),
  };
}

/** The deployment R2.2.4 must refuse: `scans` without the five columns. */
const legacyPostgrest = (opts = {}) => fakePostgrest({ ...opts, columns: LEGACY_COLUMNS });

const NOW = "2026-09-05T10:00:00.000Z";

const RECORD = Object.freeze({
  brand: "Acme",
  url: "acme.com",
  industry: "saas",
  results: [],
  competitors: [],
  scanned_at: NOW,
});

// ---------------------------------------------------------------------------
// 1. The mechanism, read out of the installed library rather than assumed.
//    If either fact ever stops being true, the reasoning behind the fix (and
//    behind the fake server above) has expired and this says so.
// ---------------------------------------------------------------------------

test("postgrest-js — only .select() asks for the row back, and an empty 201 body leaves data null", async () => {
  const source = await readFile(POSTGREST_DIST, "utf8");

  const representation = [...source.matchAll(/return=representation/g)];
  assert.ok(
    representation.length > 0,
    "postgrest-js no longer mentions return=representation at all — re-derive the fix"
  );
  const selectBody = source.slice(source.indexOf("\tselect(columns) {"));
  assert.match(
    selectBody.slice(0, 600),
    /Prefer["'`]?,\s*["'`]return=representation/,
    "select() must be the call that appends Prefer: return=representation"
  );

  const processResponse = source.slice(source.indexOf("async processResponse(res)"));
  assert.match(
    processResponse.slice(0, 900),
    /let data = null/,
    "processResponse must still default data to null"
  );
  assert.match(
    processResponse.slice(0, 900),
    /if \(body === ""\) \{\}/,
    "the empty-body no-op is the whole bug: a 201 with no body leaves data null AND error null"
  );
});

// ---------------------------------------------------------------------------
// 2. THE ACCEPT CRITERION'S FIRST TEST: drive the insert to SUCCESS and fail if
//    insertScan reports failure. (R2.2.4: the success now happens on the modern
//    schema in ONE request, not on the third attempt against a legacy one.)
// ---------------------------------------------------------------------------

test("insertScan — a success is REPORTED as a success, with the written row", async () => {
  requirePostgrest();
  requireModules();
  const server = fakePostgrest();

  const savedScan = await db.insertScan(RECORD, { client: server.client });

  assert.equal(server.inserts().length, 1, "the write is one insert; there is no retry ladder any more");
  assert.equal(server.rows.length, 1, "exactly one row should have been stored");

  // The regression, asserted as the caller expresses it. runFinalizePhase's
  // line is literally `savedScan?.[0]?.id`; pre-R2.8.7 an insert without
  // `.select()` resolved null and this is undefined for a row that is sitting
  // in the table.
  const id = savedScan?.[0]?.id;
  assert.ok(
    id,
    "insertScan reported nothing for a row it WROTE (the table holds " +
      `${server.rows.length} row(s), id=${server.rows[0]?.id}). runFinalizePhase reads ` +
      "savedScan?.[0]?.id and will throw 'Failed to save scan results' for a scan that succeeded."
  );
  assert.equal(id, server.rows[0].id, "the id returned must be the id of the row that was stored");

  // And the representation was asked for over the wire — not simulated by the
  // test.
  const insert = server.inserts()[0];
  assert.match(insert.prefer || "", /return=representation/);
  assert.match(insert.url, /select=\*/, "select() with no argument names no column");
});

test("insertScan — the insert asks for `select=*`, never a named column", async () => {
  requirePostgrest();
  requireModules();
  const server = fakePostgrest();
  await db.insertScan(RECORD, { client: server.client });

  // Two things at once, both load-bearing:
  //   - the request asks for the row back (pre-R2.8.7 cascade 3's request had
  //     no `select` param at all, which is the bug this file was filed for);
  //   - and it asks for `*`. A `.select("id, scoring_version")` would 42703 on
  //     a deployment missing that column and turn a WORKING insert into a
  //     failing one — the read half of the same schema-coupling R2.2.4 removed
  //     from the write half. `*` cannot name a missing column.
  assert.equal(server.inserts().length, 1, "expected exactly one insert attempt");
  server.inserts().forEach((req, i) => {
    const select = new URL(req.url).searchParams.get("select");
    assert.equal(
      select,
      "*",
      `insert ${i + 1} requested select=${JSON.stringify(select)}. null means it did not ask for ` +
        "the inserted row back at all, and PostgREST will answer 201 with an empty body"
    );
  });
});

// ---------------------------------------------------------------------------
// 3. The other half of the accept: a null that is NOT a failure must still be
//    distinguishable from one that is.
// ---------------------------------------------------------------------------

test("insertScan — a write that cannot be CONFIRMED is not reported as a write that failed", async () => {
  requirePostgrest();
  requireModules();
  // R2.2.4: the modern schema, because that is now where the ONLY insert runs.
  // Pre-R2.2.4 this case was only guarded on cascade 3 — R2.8.9 filed the same
  // hole on cascades 1 and 2, where the guard's throw would have been caught by
  // that cascade's own catch and answered with a SECOND insert. The assertion
  // on insert count below is what pins that shut.
  const server = fakePostgrest({ stripRepresentation: true });

  let resolvedWith;
  let threw = null;
  try {
    resolvedWith = await db.insertScan(RECORD, { client: server.client });
  } catch (err) {
    threw = err;
  }

  assert.equal(server.rows.length, 1, "the row WAS written — that is the premise of this test");
  assert.ok(
    threw,
    `insertScan resolved ${JSON.stringify(resolvedWith)} for a row that was written; a caller ` +
      "reading [0].id cannot tell that from an insert that did nothing"
  );
  assert.ok(threw instanceof db.ScanWriteError, `expected ScanWriteError, got ${threw?.name}`);
  assert.equal(
    threw.code,
    "db_write_unconfirmed",
    "'the database took the row and would not say so' and 'the database refused the row' " +
      "are different facts: the first one means an operator must LOOK before re-running"
  );
  assert.notEqual(threw.code, "db_write_failed");
  assert.match(threw.message, /may already exist/i, "the message must warn against a blind retry");
  assert.equal(
    server.inserts().length,
    1,
    "an unconfirmable write must ABORT, never be answered with another insert: the row is " +
      `already in the table (${server.rows.length} stored) and a second attempt duplicates it`
  );
});

test("insertScan — a genuinely refused insert still reports db_write_failed", async () => {
  requirePostgrest();
  requireModules();
  // Every cascade refused: nothing is written, and the code must say so.
  const refusing = {
    from() {
      const builder = {
        insert: () => builder,
        select: () => builder,
        then: (ok) =>
          ok({ data: null, error: { code: "23502", message: "null value in column \"brand\"" } }),
      };
      return builder;
    },
  };

  await assert.rejects(
    () => db.insertScan(RECORD, { client: refusing }),
    (err) => {
      assert.equal(err.code, "db_write_failed", "a refusal must not be relabelled 'unconfirmed'");
      assert.equal(err.cause?.code, "23502", "the PostgREST envelope must survive");
      return true;
    }
  );
});

// ---------------------------------------------------------------------------
// 4. THE ACCEPT CRITERION'S SECOND TEST, RE-SCOPED to the failure that actually
//    occurs. The filing said "a re-finalize inserts a duplicate"; the routine
//    consequence is an ORPHANED row plus a job that lies about failing, because
//    a falsely-failed job is not re-finalized by anything automatic. Both are
//    driven below: the orphan first (test 4), then the duplicate on the
//    re-dispatch that is genuinely required to produce it (test 5).
// ---------------------------------------------------------------------------

function makeRaw(prompt) {
  return {
    engine: "aio",
    prompt,
    is_branded_query: false,
    topic: "General",
    source: "test",
    intent_tier: "informational",
    answer_present: true,
    aio_present: true,
    text: `Answer about ${prompt}`,
    citations: [],
    references: [],
    brand_mentioned_in_text: true,
    brand_cited: false,
    visible: true,
    competitors_found_in_text: [],
    competitors_cited: [],
    brands: [],
    error: null,
    cost: 0,
  };
}

function seededRows(jobId) {
  return [0, 1, 2].map((i) => ({
    id: `pr-${i}`,
    job_id: jobId,
    brand: "acme.com",
    query: `query ${i}`,
    engine: "aio",
    answered: true,
    mentioned: true,
    brand_cited: false,
    is_branded_query: false,
    scan_id: null,
    created_at: `2026-09-05T09:5${i}:00.000Z`,
    raw: makeRaw(`query ${i}`),
  }));
}

function makeCheckpoint(rows) {
  return {
    brand: "Acme",
    url: "acme.com",
    industry: "saas",
    competitors: [],
    competitors_raw: "",
    prompt_key: "acme.com",
    queries: rows.map((r) => ({ text: r.query })),
    unbranded_texts: rows.map((r) => r.query),
    engines: ["aio"],
    stats: { cost: 0, tokens: 0 },
    sourced_at: NOW,
  };
}

/**
 * Everything runFinalizePhase touches, with the REAL insertScan bound to the
 * legacy server. `stampScanIdForJob` MUTATES the rows the way the real UPDATE
 * does, so a second finalize pass sees what the database would show it.
 */
function finalizeHarness(server, rows) {
  const job = { status: "probing", result_id: null, error_message: null };
  const stamped = [];
  return {
    job,
    stamped,
    deps: {
      getPromptResultsForJob: async () => rows,
      claimJobStatus: async (jobId, from, to) => {
        job.status = to;
        return { id: jobId, status: to };
      },
      updateScanJob: async (jobId, patch) => {
        Object.assign(job, patch);
        return { id: jobId, ...patch };
      },
      insertScan: (record) => db.insertScan(record, { client: server.client }),
      stampScanIdForJob: async (jobId, scanId) => {
        stamped.push(scanId);
        rows.forEach((r) => {
          if (!r.scan_id) r.scan_id = scanId;
        });
        return { promptResults: rows.length, citations: 0 };
      },
      deleteCitationsForJob: async () => 0,
      insertCitations: async (r) => r,
      enrichCitations: async (r) => r,
      deleteResultBrandsForJob: async () => 0,
      insertResultBrands: async (r) => r,
      upsertBrandMetricsDaily: async (r) => r,
      resolveEnabledEngines: () => [{ name: "aio" }],
      extractCompetitors: async () => [],
      getScansByDomain: async () => [],
      getResultBrandsForScan: async () => [],
    },
  };
}

test("finalize — the scan that was written is NOT orphaned", async () => {
  requirePostgrest();
  requireModules();
  const jobId = "job-cascade3-orphan";
  const rows = seededRows(jobId);
  const server = fakePostgrest();
  const h = finalizeHarness(server, rows);

  let finalizeErr = null;
  try {
    await worker.runFinalizePhase(jobId, makeCheckpoint(rows), h.deps);
  } catch (err) {
    finalizeErr = err;
  }

  // Pre-fix this is where it lands: insertScan returned null for the row the
  // server holds, so runFinalizePhase throws and runScanChunk marks the job
  // failed — for a scan that succeeded.
  assert.equal(
    finalizeErr,
    null,
    `finalize failed for a scan whose row IS in the table (${server.rows.length} row(s)): ` +
      `${finalizeErr?.message}`
  );
  assert.equal(server.rows.length, 1, "exactly one scans row should exist");

  // The orphan test proper: every prompt_results row must point at that scan.
  // Without the stamp there are no citations, no result_brands and no
  // brand_metrics_daily rollup for it either — the row exists and nothing can
  // find it.
  assert.deepEqual(h.stamped, [server.rows[0].id], "stampScanIdForJob must have run, with the written id");
  assert.ok(
    rows.every((r) => r.scan_id === server.rows[0].id),
    "prompt_results left with scan_id null — the scans row is orphaned"
  );

  // And the job must not lie to the customer.
  assert.notEqual(h.job.status, "failed");
  assert.equal(h.job.result_id, server.rows[0].id, "the job must carry the scan it actually produced");
});

// ---------------------------------------------------------------------------
// 5. The duplicate, driven honestly. It needs a SECOND dispatch of the same
//    job — the cron sweep will not do this (runScanChunk answers
//    already_finished for a failed job, shouldRescueJob returns false for one),
//    so this models the operator re-running a scan that reported failure.
//    Pre-fix: pass 1 writes row 1 and throws before stamping, so pass 2 finds
//    no stamped scan_id and writes row 2. Post-fix pass 1 stamps, and pass 2
//    reuses that id without inserting anything.
// ---------------------------------------------------------------------------

test("re-dispatch after a finalize — no second scans row is written", async () => {
  requirePostgrest();
  requireModules();
  const jobId = "job-cascade3-redispatch";
  const rows = seededRows(jobId);
  const server = fakePostgrest();
  const h = finalizeHarness(server, rows);
  const checkpoint = makeCheckpoint(rows);

  const errors = [];
  for (const pass of [1, 2]) {
    try {
      // A re-dispatch re-enters at "probing", exactly as the first one did.
      h.job.status = "probing";
      await worker.runFinalizePhase(jobId, checkpoint, h.deps);
    } catch (err) {
      errors.push(`pass ${pass}: ${err.message}`);
    }
  }

  assert.equal(
    server.rows.length,
    1,
    `the same scan was stored ${server.rows.length} times — a re-dispatch after a finalize that ` +
      `reported failure duplicates the customer's row. Errors seen: ${errors.join("; ") || "(none)"}`
  );
  assert.equal(errors.length, 0, `finalize must not report failure at all: ${errors.join("; ")}`);
  assert.deepEqual(
    new Set(h.stamped),
    new Set([server.rows[0].id]),
    "the second pass must reuse the first pass's scan_id, not mint a new one"
  );
});

// ---------------------------------------------------------------------------
// 6. R2.2.4 / finding B10 — THE SCHEMA MISMATCH PATH.
//
//    What the cascade did, in one sentence: a deployment whose `scans` lacked
//    `mention_rate_pct` got a row with mention_rate_pct, stability,
//    score_ci_low, score_ci_high AND scoring_version all NULL, and insertScan
//    returned it as an unqualified success — so the CI band, the stability chip
//    and the mention rate rendered a value that was computed, sent and thrown
//    away as if it had never been measured. A console.warn on a server nobody
//    tails is not a disclosure.
//
//    Every test below fails against the cascade: it stored a row and resolved.
// ---------------------------------------------------------------------------

/** A record whose five cascade-dropped fields all carry real values. */
const FULL_RECORD = Object.freeze({
  ...RECORD,
  scoring_version: "v9",
  score_ci_low: 31.5,
  score_ci_high: 48.25,
  stability: "stable",
  mention_rate_pct: 40,
});

test("R2.2.4 — a schema mismatch THROWS; nothing is written and no column is dropped", async () => {
  requirePostgrest();
  requireModules();
  const server = legacyPostgrest();

  let resolvedWith;
  let threw = null;
  try {
    resolvedWith = await db.insertScan(FULL_RECORD, { client: server.client });
  } catch (err) {
    threw = err;
  }

  assert.ok(
    threw,
    `insertScan resolved ${JSON.stringify(resolvedWith)} against a schema that cannot hold the ` +
      "row it was asked to write. That is the cascade: a thinner row, reported as success"
  );
  assert.ok(threw instanceof db.ScanWriteError, `expected ScanWriteError, got ${threw?.name}`);
  assert.equal(
    threw.code,
    "db_schema_mismatch",
    "the database being behind the code is its own diagnosis — the fix is a migration, not a retry"
  );
  // Standing rule 2: the PostgREST envelope survives, unflattened.
  assert.equal(threw.cause?.code, "PGRST204", "the original error must be reachable via cause");
  assert.match(
    threw.message,
    /scoring_version/,
    "the message must name the column the database is missing"
  );

  // The two facts the cascade destroyed, asserted directly.
  assert.equal(
    server.rows.length,
    0,
    `${server.rows.length} row(s) were stored for a write that was refused — a partial row is ` +
      "exactly what this task removes"
  );
  assert.equal(
    server.inserts().length,
    1,
    `insertScan attempted ${server.inserts().length} inserts. More than one means it is still ` +
      "narrowing the row until the database accepts something"
  );
});

test("R2.2.4 — the five formerly-droppable columns are actually SENT, with their values", async () => {
  requirePostgrest();
  requireModules();
  const server = fakePostgrest();

  await db.insertScan(FULL_RECORD, { client: server.client });

  const insert = server.inserts()[0];
  // What the STATEMENT names, read off the wire the way PostgREST reads it —
  // not off the body, which JSON.stringify would have pruned.
  const declared = new URL(insert.url).searchParams
    .get("columns")
    .split(",")
    .map((c) => c.replace(/^"|"$/g, ""));
  for (const column of CASCADE_DROPPED_COLUMNS) {
    assert.ok(declared.includes(column), `the insert never named ${column}`);
  }

  const stored = server.rows[0];
  assert.equal(stored.scoring_version, "v9");
  assert.equal(stored.score_ci_low, 31.5);
  assert.equal(stored.score_ci_high, 48.25);
  assert.equal(stored.stability, "stable");
  assert.equal(stored.mention_rate_pct, 40);
});

test("R2.2.4 — the columns the cascade dropped are in migration 001, so the drift it served is gone", async () => {
  // The cascade's premise was a deployment older than these columns. They are
  // declared in the FIRST migration — the baseline every deployment starts
  // from — so the only database that can refuse them is one behind its own
  // initial schema, which is an operator emergency and not a shape to
  // accommodate. If this ever stops holding, the reasoning in db.js has expired.
  const sql = await readFile(
    new URL("../../supabase/migrations/001_initial_schema.sql", import.meta.url),
    "utf8"
  );
  const scansTable = sql.slice(
    sql.indexOf("CREATE TABLE IF NOT EXISTS scans"),
    sql.indexOf(");", sql.indexOf("CREATE TABLE IF NOT EXISTS scans"))
  );
  assert.ok(scansTable.length > 0, "001_initial_schema.sql no longer creates `scans`");
  for (const column of CASCADE_DROPPED_COLUMNS) {
    assert.match(
      scansTable,
      new RegExp(`^\\s*${column}\\s`, "m"),
      `${column} is not in the initial \`scans\` schema — re-derive R2.2.4 before trusting it`
    );
  }
});

test("R2.2.4 — finalize over a schema-mismatched database fails LOUDLY and stores nothing", async () => {
  requirePostgrest();
  requireModules();
  const jobId = "job-r224-mismatch";
  const rows = seededRows(jobId);
  const server = legacyPostgrest();
  const h = finalizeHarness(server, rows);

  let finalizeErr = null;
  try {
    await worker.runFinalizePhase(jobId, makeCheckpoint(rows), h.deps);
  } catch (err) {
    finalizeErr = err;
  }

  assert.ok(
    finalizeErr,
    "finalize completed against a database that cannot hold the scan row. Under the cascade this " +
      "job finished 'successfully' with a row missing every scoring column"
  );
  assert.match(
    finalizeErr.message,
    /scoring_version/,
    "the job's error_message is the operator's only view of this: it must name the missing column"
  );
  assert.equal(server.rows.length, 0, "no partial row may be left behind");
  assert.deepEqual(h.stamped, [], "and nothing may be stamped against a scan that does not exist");
  assert.notEqual(h.job.status, "completed");
  assert.equal(h.job.result_id, null, "the job must not carry a result id for a scan never written");
});
