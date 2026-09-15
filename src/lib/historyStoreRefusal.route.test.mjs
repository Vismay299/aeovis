/**
 * R2.8.16 — the last fail-quiet read in db.js, and the route that relaundered
 * its refusal into the exact fabrication the refusal was written to prevent.
 *
 * TWO HALVES OF ONE BUG, both driven here.
 *
 *  1. db.js listRecentScans wrapped its whole body in
 *     `try { … } catch (err) { console.warn(…); return [] }`. R2.8.15 fixed the
 *     `!supabase` line above it (db_not_configured), but a database that
 *     ANSWERED WITH AN ERROR — unreachable host, HTTP 5xx, revoked key — still
 *     came back as the same `[]` a database with no rows returns. That is the
 *     db_read_failed shape R2.8.5 already fixed in getScansForBrand and
 *     getScansByDomain.
 *  2. GET /api/history caught the refusal and answered
 *     `200 { scans: [], runs: [], activeJobs: [], counts: {} }`, which is
 *     byte-for-byte a brand-new operator's real empty workspace. Fixing (1)
 *     without (2) changes nothing a user can see: the route is the homepage
 *     workspace, so the failure mode was an operator with scans looking at an
 *     empty product and no error.
 *
 * WHAT IS REAL HERE. db.js, src/lib/db/content.js, src/lib/historyStoreState.js
 * and the GET handler in src/app/api/history/route.js all run unmodified,
 * against the real @supabase/supabase-js client db.js builds at import time.
 * The ONLY substitution is `globalThis.fetch`, standing in for the socket: it
 * refuses the DB's address or answers with a real HTTP response, exactly as a
 * network would. The module-resolution hooks (shared with cronAuth.route.test.mjs)
 * only answer "which file is this specifier" for `@/…` and `next/server`.
 *
 * The db_not_configured half needs a process with no credentials at all and so
 * lives in its own file: src/lib/historyUnconfigured.route.test.mjs.
 *
 * The surface that renders the distinction (src/components/home/HomeDashboard.jsx)
 * is driven through historyLoadState, which is the whole of its decision; the
 * two assertions at the end that read the .jsx are source assertions and are
 * worth exactly what a source assertion is worth — they cannot prove the
 * component renders, only that the decision proven above is the one it reaches
 * and that the outage branch returns before the clean-page branch. Worth less
 * still, and said out loud: HomeDashboard is currently mounted on no page and is
 * the only caller of /api/history, so this half of the fix is the honest shape
 * waiting for a surface, not a repaired screen. The route's 503 is real today.
 *
 * DEPENDENCY NOTE: needs node_modules (`next`, `@supabase/supabase-js`). If the
 * import fails the first test FAILS LOUDLY rather than skipping — a skip here
 * would hide the exact path this file exists to observe.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { readFile } from "node:fs/promises";

// db.js builds its Supabase client at import time, so this must be set BEFORE
// anything is imported. The host is real-looking but never reached: the stub
// below answers every request to it.
const DB_HOST = "https://db-for-r2816.supabase.test";
process.env.NEXT_PUBLIC_SUPABASE_URL = DB_HOST;
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-key-for-a-host-that-does-not-answer";

register("./cronAuth.route.hooks.mjs", import.meta.url);

let importError = null;
let db = null;
let historyGET = null;
let historyLoadState = null;
let historyStoreUnreachable = null;
try {
  const [dbMod, routeMod, stateMod] = await Promise.all([
    import("./db.js"),
    import("../app/api/history/route.js"),
    import("./historyStoreState.js"),
  ]);
  db = dbMod;
  historyGET = routeMod.GET;
  historyLoadState = stateMod.historyLoadState;
  historyStoreUnreachable = stateMod.historyStoreUnreachable;
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
  assert.equal(typeof historyGET, "function", "the history route must export GET");
  assert.equal(typeof historyLoadState, "function", "historyStoreState must export historyLoadState");
  assert.equal(
    typeof historyStoreUnreachable,
    "function",
    "historyStoreState must export historyStoreUnreachable"
  );
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

const json = (payload, status = 200) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });

/** Every table the route touches answers 200 with rows; `scans` is the variable. */
const TABLE_ANSWERS = (scanRows) => (href) => {
  if (href.includes("/rest/v1/scans")) return json(scanRows);
  if (href.includes("/rest/v1/content_items")) return json([]);
  if (href.includes("/rest/v1/content_jobs")) return json([]);
  throw new Error(`the route queried an unexpected table: ${href}`);
};

/** The scans table alone fails; the content tables answer normally. */
const SCANS_FAIL = (failure) => (href) => {
  if (href.includes("/rest/v1/scans")) return failure();
  if (href.includes("/rest/v1/content_items")) return json([]);
  if (href.includes("/rest/v1/content_jobs")) return json([]);
  throw new Error(`the route queried an unexpected table: ${href}`);
};

const UNREACHABLE = () => {
  throw refusedConnection();
};
const HTTP_500 = () => json({ message: "server misconfigured", code: "XX000" }, 500);
const HTTP_401 = () => json({ message: "JWT expired", code: "PGRST301" }, 401);

const SCAN_ROW = {
  id: "11111111-2222-3333-4444-555555555555",
  brand: "Italica",
  url: "https://www.italicatiles.com/tiles",
  industry: "tiles",
  visibility_pct: 41,
  scanned_at: "2026-09-01T00:00:00.000Z",
  raw_results: { engines: { aio: {} }, visibility_index_pct: 41 },
};

const callRoute = () => historyGET(new Request("https://aeovis.test/api/history"));

// ---------------------------------------------------------------------------
// HALF 1 — db.js listRecentScans. The catch that turned an answering-with-error
// database into an operator with no brands.
// ---------------------------------------------------------------------------

/**
 * The enumerated corpus of ways a database can answer with an error. Emptying
 * this array must FAIL the suite, not quietly green it — see the guard below.
 */
const DB_FAILURES = [
  ["connection refused", UNREACHABLE],
  ["HTTP 500 from postgrest", HTTP_500],
  ["HTTP 401, a revoked or expired key", HTTP_401],
];

test("VACUITY GUARD — the failure corpus is non-empty, so the loops below really ran", () => {
  assert.ok(
    DB_FAILURES.length >= 3,
    "an empty or near-empty DB_FAILURES would make every loop in this file pass by " +
      `iterating nothing; got ${DB_FAILURES.length}`
  );
});

test("HALF 1 — listRecentScans THROWS db_read_failed; it never answers [] for a failed read", async () => {
  requireModules();
  assert.ok(DB_FAILURES.length > 0, "the corpus must not be empty");

  let driven = 0;
  for (const [label, failure] of DB_FAILURES) {
    let returned = "did not return";
    await assert.rejects(
      () =>
        withDb(SCANS_FAIL(failure), async () => {
          returned = await db.listRecentScans(12);
        }),
      (err) => {
        assert.ok(
          err instanceof db.ScansUnavailableError,
          `${label}: expected ScansUnavailableError, got ${err?.name}: ${err?.message}`
        );
        assert.equal(
          err.code,
          "db_read_failed",
          `${label}: a database that answered with an error is db_read_failed, not ` +
            "db_not_configured and not a third vocabulary"
        );
        assert.ok(err.cause, `${label}: the postgrest envelope must survive on \`cause\``);
        return true;
      },
      label
    );
    assert.equal(returned, "did not return", `${label}: nothing may be returned from a failed read`);
    assert.ok(dbRequests.length > 0, `${label}: the stub must actually have intercepted the query`);
    driven += 1;
  }
  assert.equal(driven, DB_FAILURES.length, "every failure in the corpus must have been driven");
});

test("HALF 1 — THE OTHER HALF: a DB that answers with no rows still returns a measured []", async () => {
  requireModules();

  const none = await withDb(TABLE_ANSWERS([]), () => db.listRecentScans(12));
  assert.deepEqual(none, [], "the DB answered — 'no brands' is a measurement, and it is []");

  const one = await withDb(TABLE_ANSWERS([SCAN_ROW]), () => db.listRecentScans(12));
  assert.equal(one.length, 1);
  assert.equal(one[0].brand, "Italica");
  assert.equal(one[0].score, 41, "the row-collapsing loop must be untouched by this fix");
});

test("HALF 1 — the read stays bounded in the QUERY, not in JS after the fetch", async () => {
  requireModules();
  await withDb(TABLE_ANSWERS([]), () => db.listRecentScans(12));
  const scansQuery = dbRequests.find((h) => h.includes("/rest/v1/scans"));
  assert.ok(scansQuery, "the scans query must have been made");
  assert.match(
    scansQuery,
    /limit=200/,
    "the row cap must travel to the database — an unbounded read behind a route is a " +
      `DoS amplifier, not a style choice: ${scansQuery}`
  );
});

// ---------------------------------------------------------------------------
// HALF 2 — GET /api/history. The handler that turned the refusal above back
// into an empty workspace, on screen, at 200.
// ---------------------------------------------------------------------------

test("ACCEPT — a refusal reaches the response as an unreachable store, never as 200-with-empty", async () => {
  requireModules();
  assert.ok(DB_FAILURES.length > 0, "the corpus must not be empty");

  let driven = 0;
  for (const [label, failure] of DB_FAILURES) {
    const response = await withDb(SCANS_FAIL(failure), callRoute);
    const body = await response.json();

    assert.notEqual(
      response.status,
      200,
      `${label}: a read that did not happen must not be reported as a successful one`
    );
    assert.equal(response.status, 503, `${label}: expected 503, got ${response.status}`);
    assert.equal(body.store, "unreachable", `${label}: the store field must say which`);
    assert.equal(
      body.reason,
      "db_read_failed",
      `${label}: the refusing error's own code must survive to the response`
    );

    // The heart of it: no empty collection anywhere, because an unmeasured value
    // must not be shaped like a measured zero.
    for (const key of ["scans", "runs", "activeJobs"]) {
      assert.equal(body[key], null, `${label}: ${key} must be null, never [] — [] is a measurement`);
      assert.ok(!Array.isArray(body[key]), `${label}: ${key} must not be an array`);
    }
    assert.equal(body.counts, null, `${label}: counts must be null, never {} and never {brands: 0}`);
    assert.ok(
      !("brands" in (body.counts || {})),
      `${label}: no count may be stated from a read that did not happen`
    );
    assert.match(body.detail, /not a workspace with nothing in it/i, `${label}: it must say so in words`);

    driven += 1;
  }
  assert.equal(driven, DB_FAILURES.length, "every failure in the corpus must have reached the route");
});

test("ACCEPT — THE OTHER HALF: a genuinely empty workspace is a 200 the client can tell apart", async () => {
  requireModules();

  const emptyRes = await withDb(TABLE_ANSWERS([]), callRoute);
  const empty = await emptyRes.json();
  assert.equal(emptyRes.status, 200, "the DB answered — this is a real first run");
  assert.equal(empty.store, "ok");
  assert.equal(empty.reason, null);
  assert.deepEqual(empty.scans, [], "a measured empty is [], and it is allowed to be");
  assert.equal(empty.counts.brands, 0, "zero brands is a measurement here, so it is stated");

  const outageRes = await withDb(SCANS_FAIL(UNREACHABLE), callRoute);
  const outage = await outageRes.json();

  assert.notEqual(
    outageRes.status,
    emptyRes.status,
    "the two must not share a status — that shared 200 was the bug"
  );
  assert.notEqual(outage.store, empty.store, "…and not a store verdict either");
  assert.notDeepEqual(outage, empty, "the two bodies must be distinguishable without guessing");
});

test("ACCEPT — a populated workspace is unaffected: 200, the brand, and its counts", async () => {
  requireModules();
  const response = await withDb(TABLE_ANSWERS([SCAN_ROW]), callRoute);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.store, "ok");
  assert.equal(body.scans.length, 1);
  assert.equal(body.scans[0].brand, "Italica");
  assert.equal(body.counts.brands, 1);
});

test("SECURITY — the refusal names no infrastructure, no upstream body and no credential", async () => {
  requireModules();
  assert.ok(DB_FAILURES.length > 0, "the corpus must not be empty");

  for (const [label, failure] of DB_FAILURES) {
    const response = await withDb(SCANS_FAIL(failure), callRoute);
    const text = JSON.stringify(await response.json());
    assert.doesNotMatch(
      text,
      /supabase|postgres|postgrest|PGRST|XX000|JWT|anon-key|ENOTFOUND|ECONNREFUSED|AbortError/i,
      `${label}: a client-facing error must not echo infrastructure or the upstream body: ${text}`
    );
    assert.ok(
      !text.includes(DB_HOST),
      `${label}: the database host must never appear in a response body`
    );
    assert.doesNotMatch(text, /\n\s+at\s/, `${label}: no stack trace may travel to the client`);
  }
});

test("the envelope builder mints no new vocabulary — it passes the error's own code through", () => {
  requireModules();

  for (const code of ["db_read_failed", "db_not_configured", "domain_required"]) {
    const { status, body } = historyStoreUnreachable(
      new db.ScansUnavailableError("refused", { code })
    );
    assert.equal(status, 503);
    assert.equal(body.reason, code, "the reason must be the code the read side already uses");
  }

  // A thrown value with no code at all must not be given a made-up one.
  const { body } = historyStoreUnreachable(new TypeError("something else broke"));
  assert.equal(body.reason, "unknown", "an uncoded failure is 'unknown', not a guessed db_* code");
  assert.equal(body.store, "unreachable", "…and it is still an outage, not an empty workspace");
  assert.equal(body.scans, null);
});

// ---------------------------------------------------------------------------
// HALF 2b — the surface. historyLoadState is the whole of HomeDashboard's
// decision, so it is driven; the wiring is pinned by source below.
// ---------------------------------------------------------------------------

test("SURFACE — only an ok response that says store:'ok' renders the workspace", () => {
  requireModules();

  const good = historyLoadState({ ok: true, status: 200, body: { store: "ok", scans: [] } });
  assert.equal(good.outage, null, "a store that answered is not an outage");
  assert.deepEqual(good.data.scans, [], "…and its measured empty reaches the strip");

  const cases = [
    ["the 503 refusal", { ok: false, status: 503, body: { store: "unreachable", reason: "db_read_failed" } }, "db_read_failed"],
    ["an unconfigured deploy", { ok: false, status: 503, body: { store: "unreachable", reason: "db_not_configured" } }, "db_not_configured"],
    ["an unparseable body", { ok: false, status: 503, body: null }, "http_503"],
    ["the OLD 200-with-empty envelope", { ok: true, status: 200, body: { scans: [], runs: [], activeJobs: [], counts: {} } }, "http_200"],
    ["a request that never completed", null, "request_failed"],
  ];
  assert.ok(cases.length >= 5, "this table must not be empty — an empty one would prove nothing");

  for (const [label, input, reason] of cases) {
    const out = historyLoadState(input);
    assert.equal(out.data, null, `${label}: nothing unmeasured may reach the strip as data`);
    assert.ok(out.outage, `${label}: this must be reported as an outage`);
    assert.equal(out.outage.reason, reason, `${label}: the reason must be readable`);
  }
});

test("SURFACE — the component reads `store` and returns its outage BEFORE the clean page", async () => {
  const src = await readFile(new URL("../components/home/HomeDashboard.jsx", import.meta.url), "utf8");

  assert.match(
    src,
    /historyLoadState\(/,
    "the component must take its verdict from historyLoadState, not re-derive it"
  );
  assert.doesNotMatch(
    src,
    /if\s*\(res\.ok\)\s*setData\(/,
    "`if (res.ok) setData(await res.json())` is the bug — it keeps a 200 refusal as data"
  );

  const outageAt = src.indexOf("if (outage)");
  const cleanPageAt = src.indexOf("if (scans.length === 0");
  assert.ok(outageAt > 0, "the outage branch must exist");
  assert.ok(cleanPageAt > 0, "the clean first-run page must still exist");
  assert.ok(
    outageAt < cleanPageAt,
    "the outage branch must return BEFORE the clean page, or an unreadable store falls " +
      "through to 'you have never scanned anything'"
  );
  assert.match(
    src,
    /data-testid="home-dashboard-unavailable"/,
    "the outage state needs its own testid, distinct from home-dashboard"
  );

  // And it must not state a number it did not measure while doing so.
  const outageBlock = src.slice(outageAt, cleanPageAt);
  assert.doesNotMatch(
    outageBlock,
    /counts\.|scans\.length|\?\?\s*0/,
    `the outage branch must state no count derived from the read it just disowned: ${outageBlock}`
  );
});
