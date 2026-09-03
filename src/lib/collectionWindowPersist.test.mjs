import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { readFile } from "node:fs/promises";

/**
 * R2.7.4 — the collection window has to SURVIVE THE WRITE.
 *
 * collectionWindow.test.mjs proves the two pure helpers: the min/max over the
 * persisted rows' created_at, and the "over 42 min" formatter. That is half a
 * criterion. The window shipped once with both helpers correct and green, and
 * `collectedFrom` was still null on 100% of records — because insertScan is an
 * ALLOWLIST, not a pass-through. runFinalizePhase spread collected_from /
 * collected_to onto the scan record, db.js's rawPayload never named them, and
 * the two fields were dropped before the insert with nothing logged. Deleting
 * the spread, the rawPayload keys, or normalizeResult's mapping each left the
 * whole suite green.
 *
 * So this file walks the ONE hop the helper tests cannot see, end to end and by
 * execution:
 *
 *   probe rows (created_at) -> runFinalizePhase -> the REAL insertScan ->
 *   the row actually handed to supabase.from("scans").insert() ->
 *   the REAL enrichScanForClient (the /api/scans/by-id and /latest transform) ->
 *   the REAL normalizeResult -> result.collectedFrom / result.collectedTo
 *
 * Nothing in that chain is reimplemented here. The only substitution is the
 * transport: supabase.from is swapped for a recorder so the row can be captured
 * instead of sent, which is precisely the assertion — what the row CONTAINS.
 *
 * The render half (DashboardShell's chip) is a .jsx module that node:test
 * cannot import or render — no JSX transform in this runner, same constraint
 * documented in scoring/rosterOfflineSurfaces.test.mjs. The rendering DECISION
 * is formatCollectionWindow, unit-tested in collectionWindow.test.mjs
 * (including that it returns null for unparseable input); the source guard at
 * the bottom of this file proves the component actually consults it rather than
 * re-deriving the rule from the raw strings, which is the bug it had.
 */

// db.js builds its Supabase client at import time, so these must be set BEFORE
// it is imported — hence the dynamic imports below rather than static ones,
// which would be hoisted above these assignments. The host is never contacted:
// supabase.from is replaced by a recorder in every test that inserts, and no
// request leaves this process.
process.env.NEXT_PUBLIC_SUPABASE_URL = "https://collection-window.supabase.test";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-key-for-a-client-that-is-never-called";

// Only tells Node which file `@/lib/db` means — the same jsconfig alias the
// bundler resolves. Substitutes no behaviour. See the hook file's header.
register("./cronAuth.route.hooks.mjs", import.meta.url);

let importError = null;
let db = null;
let worker = null;
let apiClient = null;
let routeScanRow = null;
try {
  [db, worker, apiClient, routeScanRow] = await Promise.all([
    import("./db.js"),
    import("./workers/scanWorker.js"),
    import("../services/api.js"),
    import("../app/api/scans/_lib/scanRow.js"),
  ]);
} catch (error) {
  importError = error;
}

function requireModules() {
  assert.equal(
    importError,
    null,
    "Could not import the real modules under test. If this says \"Cannot find package\", " +
      `run \`npm install\` — this suite exercises the shipped code paths. Underlying: ${importError?.message}`
  );
  // A null client makes insertScan return undefined after a console.warn. That
  // is a legitimate dev-mode path, but here it would turn every assertion below
  // into a vacuous pass, so it fails loudly instead of quietly proving nothing.
  assert.ok(
    db.supabase,
    "db.supabase must be a live client object for this suite to observe the insert; " +
      "the env vars above are set before the import for exactly this reason"
  );
}

// ---------------------------------------------------------------------------
// Transport recorder: capture the row instead of sending it.
// ---------------------------------------------------------------------------

/**
 * Swap supabase.from for a chainable recorder. insertScan's cascade 1 does
 * `.insert([row]).select()` and awaits; this resolves that with a
 * server-assigned id, so the function takes its normal success path and the
 * captured row is exactly what would have gone over the wire.
 */
function recordInserts() {
  const captured = [];
  const original = db.supabase.from;
  db.supabase.from = (table) => {
    const builder = {
      insert(rows) {
        captured.push({ table, rows });
        return builder;
      },
      select() {
        return builder;
      },
      then(resolve) {
        resolve({ data: [{ id: "scan-under-test" }], error: null });
      },
    };
    return builder;
  };
  return {
    captured,
    scanRow() {
      assert.equal(captured.length, 1, "expected exactly one insert (cascade 1 succeeded)");
      assert.equal(captured[0].table, "scans");
      return captured[0].rows[0];
    },
    restore() {
      db.supabase.from = original;
    },
  };
}

const FROM = "2026-08-30T09:33:00.000Z";
const TO = "2026-08-30T10:15:00.000Z"; // 42 minutes later

// ---------------------------------------------------------------------------
// 1. The persist hop: db.js's allowlist is the only way into the stored row.
// ---------------------------------------------------------------------------

test("insertScan — the row handed to supabase carries the collection window", async () => {
  requireModules();
  const rec = recordInserts();
  try {
    await db.insertScan({
      brand: "Acme",
      url: "acme.com",
      industry: "saas",
      visibility_pct: 40,
      prompts_tracked: 6,
      prompts_mentioned: 2,
      competitors: [],
      results: [],
      scanned_at: "2026-08-30T11:30:00.000Z",
      collected_from: FROM,
      collected_to: TO,
    });

    const row = rec.scanRow();
    // The regression this exists to catch: insertScan is an allowlist. A field
    // the caller sets and rawPayload never names is discarded here, silently.
    assert.equal(
      row.raw_results.collected_from,
      FROM,
      "collected_from must be named in db.js's rawPayload — an unnamed field is dropped before the write"
    );
    assert.equal(row.raw_results.collected_to, TO);
  } finally {
    rec.restore();
  }
});

test("insertScan — an unknown window persists as an EXPLICIT null, not an absent key", async () => {
  requireModules();
  const rec = recordInserts();
  try {
    // A scan whose prompt_results carried no usable timestamps. Standing rule
    // 1: "we looked and there was no window" must not be indistinguishable
    // from a pre-R2.7.4 row that was never asked the question. The key being
    // present with a null value is what carries that difference.
    await db.insertScan({ brand: "Acme", url: "acme.com", results: [], competitors: [] });

    const raw = rec.scanRow().raw_results;
    assert.ok("collected_from" in raw, "the key must be written even when the window is unknown");
    assert.ok("collected_to" in raw);
    assert.equal(raw.collected_from, null);
    assert.equal(raw.collected_to, null);
  } finally {
    rec.restore();
  }
});

test("SCHEMA CASCADE — the window survives the legacy-schema fallback, because it rides in raw_results", async () => {
  requireModules();
  // Why JSONB and not two new timestamptz columns. insertScan retries three
  // times against progressively older schemas, and cascades 2 and 3 drop the
  // newer columns behind a console.warn — so a deployment where a migration
  // had not landed would lose a COLUMN-borne window in silence, which is the
  // same class of failure this task exists to remove. raw_results is part of
  // buildScanBaseRecord, which every cascade sends, so the window is carried
  // by all three. Cascade 1 is failed here the way a missing column fails it.
  const captured = [];
  const original = db.supabase.from;
  let attempt = 0;
  db.supabase.from = (table) => {
    const builder = {
      insert(rows) {
        captured.push({ table, rows });
        return builder;
      },
      select() {
        return builder;
      },
      then(resolve) {
        attempt++;
        resolve(
          attempt < 3
            ? { data: null, error: new Error("PGRST204: column does not exist") }
            : { data: [{ id: "scan-legacy-schema" }], error: null }
        );
      },
    };
    return builder;
  };

  try {
    await db.insertScan({
      brand: "Acme",
      url: "acme.com",
      results: [],
      competitors: [],
      scanned_at: "2026-08-30T11:30:00.000Z",
      collected_from: FROM,
      collected_to: TO,
    });
  } finally {
    db.supabase.from = original;
  }

  assert.equal(captured.length, 3, "all three cascades must have been attempted");
  const legacyRow = captured[2].rows[0];
  assert.equal(legacyRow.raw_results.collected_from, FROM);
  assert.equal(legacyRow.raw_results.collected_to, TO);
});
// ---------------------------------------------------------------------------
// 2. Finalize -> the real insertScan: the window computed from the probe
//    WRITES reaches the stored row, and is not the finalize instant.
// ---------------------------------------------------------------------------

function makeRaw(engine, prompt) {
  return {
    engine,
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
    cost: 0.001,
  };
}

/**
 * The prompt_results rows a completed probing phase leaves behind, with
 * deliberately out-of-order created_at values spanning FROM..TO.
 */
function seededRows(jobId) {
  const stamps = [
    "2026-08-30T09:51:00.000Z",
    FROM, // earliest, deliberately not first in the array
    "2026-08-30T10:07:00.000Z",
    TO, // latest
  ];
  return stamps.map((created_at, i) => ({
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
    created_at,
    raw: makeRaw("aio", `query ${i}`),
  }));
}

/**
 * Everything runFinalizePhase touches except insertScan, which is the REAL one
 * from db.js so the allowlist is genuinely traversed.
 */
function finalizeDeps(rows, updates) {
  return {
    getPromptResultsForJob: async () => rows,
    claimJobStatus: async (jobId, _from, to) => ({ id: jobId, status: to }),
    updateScanJob: async (jobId, patch) => {
      updates.push(patch);
      return { id: jobId, ...patch };
    },
    insertScan: db.insertScan,
    stampScanIdForJob: async () => ({ promptResults: rows.length, citations: 0 }),
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
  };
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
    sourced_at: "2026-08-30T09:30:00.000Z",
  };
}

test("runFinalizePhase -> insertScan — the first and last probe WRITE reach the stored row", async () => {
  requireModules();
  const jobId = "job-collection-window";
  const rows = seededRows(jobId);
  const updates = [];
  const rec = recordInserts();
  try {
    await worker.runFinalizePhase(jobId, makeCheckpoint(rows), finalizeDeps(rows, updates));

    const row = rec.scanRow();
    assert.equal(
      row.raw_results.collected_from,
      FROM,
      "the earliest prompt_results.created_at must survive finalize AND the insert"
    );
    assert.equal(row.raw_results.collected_to, TO);

    // The whole point of the field: scanned_at is stamped when finalize runs,
    // which is now, not when the answers were collected. If these ever coincide
    // the window has silently collapsed back to the finalize instant.
    assert.ok(row.scanned_at, "the row must still carry scanned_at");
    assert.notEqual(row.scanned_at, row.raw_results.collected_to);
    assert.ok(
      Date.parse(row.scanned_at) > Date.parse(row.raw_results.collected_to),
      "finalize runs after the last probe write, so scanned_at must be later than collected_to"
    );
  } finally {
    rec.restore();
  }
});

test("runFinalizePhase -> insertScan — rows with no timestamps store null, never the clock", async () => {
  requireModules();
  const jobId = "job-collection-window-unknown";
  const rows = seededRows(jobId).map(({ created_at, ...rest }) => rest);
  const updates = [];
  const rec = recordInserts();
  try {
    await worker.runFinalizePhase(jobId, makeCheckpoint(rows), finalizeDeps(rows, updates));

    const raw = rec.scanRow().raw_results;
    // C1/C2's load-bearing property, asserted where it actually lands: an
    // unknown window must reach the database as unknown. A `new Date()`
    // fallback anywhere in this chain would make a record of entirely unknown
    // collection age look like one collected during the finalize run.
    assert.equal(raw.collected_from, null);
    assert.equal(raw.collected_to, null);
  } finally {
    rec.restore();
  }
});

// ---------------------------------------------------------------------------
// 3. Round trip: the stored row -> the real read path -> a non-null
//    result.collectedFrom. This is the hop nothing exercised.
// ---------------------------------------------------------------------------

test("ROUND TRIP — finalize -> insertScan row -> enrichScanForClient -> normalizeResult yields a non-null window", async () => {
  requireModules();
  const jobId = "job-collection-window-roundtrip";
  const rows = seededRows(jobId);
  const updates = [];
  const rec = recordInserts();
  let insertedRow;
  try {
    await worker.runFinalizePhase(jobId, makeCheckpoint(rows), finalizeDeps(rows, updates));
    insertedRow = rec.scanRow();
  } finally {
    rec.restore();
  }

  // What getScanById's `select("*")` reads back: the row as written, plus the
  // server-assigned id. Postgres round-trips a jsonb payload verbatim, so this
  // is the stored row, not a hand-built fixture.
  const dbRow = { id: "scan-under-test", ...insertedRow };

  const enriched = routeScanRow.enrichScanForClient(dbRow);
  const result = apiClient.normalizeResult(enriched, "Acme", "acme.com");

  assert.equal(
    result.collectedFrom,
    FROM,
    "normalizeResult must map raw_results.collected_from onto collectedFrom — the dashboard reads only this"
  );
  assert.equal(result.collectedTo, TO);

  // Distinct from the headline timestamp, which is the whole reason the window
  // exists. If normalizeResult ever falls back to scanned_at, this fails.
  assert.ok(result.scanTimestamp, "scanTimestamp must still be populated");
  assert.notEqual(result.collectedFrom, result.scanTimestamp);

  // And the chip the dashboard would render from it — the accept criterion's
  // "as a window", computed by the same call DashboardShell makes.
  const { formatCollectionWindow } = await import("../utils/format.js");
  assert.equal(formatCollectionWindow(result.collectedFrom, result.collectedTo), "over 42 min");
});

test("ROUND TRIP — a scan with no collection window reads back as null, not as the scan time", async () => {
  requireModules();
  const rec = recordInserts();
  let insertedRow;
  try {
    await db.insertScan({
      brand: "Acme",
      url: "acme.com",
      results: [],
      competitors: [],
      scanned_at: "2026-08-30T11:30:00.000Z",
    });
    insertedRow = rec.scanRow();
  } finally {
    rec.restore();
  }

  const result = apiClient.normalizeResult(
    routeScanRow.enrichScanForClient({ id: "scan-no-window", ...insertedRow }),
    "Acme",
    "acme.com"
  );
  assert.equal(result.collectedFrom, null);
  assert.equal(result.collectedTo, null);
  assert.equal(result.scanTimestamp, "2026-08-30T11:30:00.000Z", "the headline timestamp is unaffected");
});

// ---------------------------------------------------------------------------
// 4. The render decision. DashboardShell.jsx cannot be imported by this runner
//    (no JSX transform — same reason scoring/rosterOfflineSurfaces.test.mjs
//    reads its three surfaces as source). This is a SOURCE guard, not a render:
//    it proves the component defers the whole decision to
//    formatCollectionWindow, whose null-on-unparseable behaviour is unit-tested
//    in collectionWindow.test.mjs.
// ---------------------------------------------------------------------------

const SHELL = new URL("../components/dashboard/DashboardShell.jsx", import.meta.url);

test("MALFORMED WINDOW — DashboardShell guards the chip on the formatted label, not on the raw strings", async () => {
  const src = await readFile(SHELL, "utf8");

  assert.match(
    src,
    /const collectionWindowLabel = formatCollectionWindow\(result\.collectedFrom, result\.collectedTo\)/,
    "the chip's rendering decision must be resolved once, from formatCollectionWindow"
  );
  assert.match(
    src,
    /\{collectionWindowLabel && \(/,
    "the chip must be gated on the formatted label being non-null"
  );
  assert.match(
    src,
    /collected \{collectionWindowLabel\}/,
    "the chip must render the same label it was gated on, so guard and text cannot disagree"
  );

  // The defect: guarding on truthiness of the two raw strings passes for
  // `collectedFrom: "garbage"`, which formatCollectionWindow refuses to format
  // — so the chip rendered as the bare word "collected", titled
  // "Answers collected — → —". An unreadable window must be omitted exactly
  // like a half-known one.
  assert.doesNotMatch(
    src,
    /result\.collectedFrom && result\.collectedTo/,
    "raw-string truthiness must not gate the collection-window chip or its title"
  );
});
