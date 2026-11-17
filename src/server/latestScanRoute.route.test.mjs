/**
 * R2.8.4 / finding A12, observed at the ROUTE: a database outage and a brand
 * that has never been scanned must not produce the same status code.
 *
 * WHY THIS FILE EXISTS. The first attempt at R2.8.4 fixed the client — the
 * dashboard now branches 404 → first-run state, anything-else → error state —
 * and shipped with four source-level tests that all passed. It was rejected,
 * because no DB failure on this route could actually PRODUCE a non-404 status:
 * getScansForBrand returned [] on error, execution reached `if (!latest)`, and
 * the outage came back as 404 "No scans found for this brand." A brand with 38
 * real scans was told it had never scanned and offered a button to spend scan
 * budget fixing our outage. Assertions over file text could never have caught
 * that. This suite drives the real handler and reads the real status.
 *
 * The premise the finding rests on is itself asserted here rather than
 * assumed: postgrest-js does NOT reject on a transport failure. The client in
 * db.js is built without `throwOnError`, so a refused connection arrives as
 * `{ data: null, error }` — which is why every `catch` around this read used
 * to be dead code. Test 1 proves that envelope directly, against the real
 * @supabase/supabase-js, before any route is involved.
 *
 * Nothing in db.js or the route is stubbed. The only substitution is the
 * global fetch, which stands in for the network: it refuses the DB's address,
 * or answers with a real HTTP response, exactly as a socket would. The module
 * resolution hooks (shared with cronAuth.route.test.mjs) only tell Node which
 * file `@/...` and `next/server` mean.
 *
 * DEPENDENCY NOTE: needs node_modules (`next`, `@supabase/supabase-js`). If
 * the import fails, the first test FAILS LOUDLY rather than skipping — a skip
 * here would hide the exact path this file exists to observe.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

// db.js builds its Supabase client at import time, so these must be set BEFORE
// the route is imported. The host is real-looking but never reached: the stub
// below refuses every request to it, which is how db.js is driven onto its
// genuine failure path without db.js itself being touched.
const DB_HOST = "https://db-for-r284.supabase.test";
process.env.NEXT_PUBLIC_SUPABASE_URL = DB_HOST;
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-key-for-a-host-that-does-not-answer";

register("./cronAuth.route.hooks.mjs", import.meta.url);

let importError = null;
let latestGET = null;
let supabase = null;
let getScansForBrand = null;
let ScansUnavailableError = null;
try {
  const [route, db] = await Promise.all([
    import("../app/api/scans/[brand]/latest/route.js"),
    import("./db.js"),
  ]);
  latestGET = route.GET;
  supabase = db.supabase;
  getScansForBrand = db.getScansForBrand;
  ScansUnavailableError = db.ScansUnavailableError;
} catch (error) {
  importError = error;
}

function requireRoute() {
  assert.equal(
    importError,
    null,
    'Could not import the latest-scan route / db. If this says "Cannot find package", ' +
      `run \`npm install\` — this suite exercises the real modules. Underlying: ${importError?.message}`
  );
  assert.equal(typeof latestGET, "function", "the latest-scan route must export GET");
  assert.ok(supabase, "db.js must have built a Supabase client from the env set above");
  return latestGET;
}

/**
 * A connection the DB refuses. `AbortError` is the one failure postgrest does
 * NOT sit in a retry/backoff loop over, so the read fails at once instead of
 * spending seconds of suite time proving the same thing.
 */
function refusedConnection() {
  return Object.assign(new Error("connection refused by the database"), { name: "AbortError" });
}

/** Requests the DB actually received, so a test can prove it intercepted the real query. */
let dbRequests = [];

/**
 * Run `fn` with every request to the DB answered by `answer(url, init)`.
 * `answer` either throws (transport failure) or returns a real Response.
 */
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

const SCAN_ROW = {
  id: "11111111-2222-3333-4444-555555555555",
  brand: "Italica",
  url: "https://italicatiles.com",
  visibility_pct: 41,
  scanned_at: "2026-09-01T00:00:00.000Z",
  raw_results: { results: [] },
};

function get(brand) {
  return requireRoute()(new Request(`https://aeovis.test/api/scans/${brand}/latest`), {
    params: { brand },
  });
}

// ---------------------------------------------------------------------------
// 1. The premise: postgrest reports, it does not reject.
// ---------------------------------------------------------------------------

test("PREMISE — a refused DB connection reaches the caller as { data: null, error }, not a rejection", async () => {
  requireRoute();

  const envelope = await withDb(DB_UNREACHABLE, () =>
    supabase.from("scans").select("*").ilike("brand", "Italica").order("scanned_at", { ascending: false })
  );

  // If this ever starts rejecting instead, the finding's root cause has moved
  // and the rest of this file needs rereading — so assert it, don't assume it.
  assert.equal(envelope.data, null, "postgrest returns a null data field, not a thrown error");
  assert.ok(envelope.error, "the failure is reported in the error field");
  assert.ok(dbRequests.length > 0, "the stub must actually have intercepted the DB query");
  assert.match(dbRequests[0], /\/scans\b/, "and it must be the scans query");
});

// ---------------------------------------------------------------------------
// 2. db.js's contract.
// ---------------------------------------------------------------------------

test("getScansForBrand THROWS on an unreadable DB — it never fabricates an empty history", async () => {
  requireRoute();

  await assert.rejects(
    () => withDb(DB_UNREACHABLE, () => getScansForBrand("Italica")),
    (err) => {
      assert.ok(err instanceof ScansUnavailableError, `expected ScansUnavailableError, got ${err?.name}`);
      assert.equal(err.code, "db_read_failed");
      return true;
    }
  );
});

test("getScansForBrand returns a real [] only when the DB answered with no rows", async () => {
  requireRoute();
  const scans = await withDb(DB_RETURNS_ROWS([]), () => getScansForBrand("nosuchbrand-zzz"));
  assert.deepEqual(scans, [], "a measured empty is still an empty array");
});

test("with no Supabase credentials, getScansForBrand throws rather than reporting 'never scanned'", async () => {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  try {
    // A distinct URL forces a fresh evaluation of db.js against the env above,
    // so the `!supabase` branch is the real one, not a simulation of it.
    const unconfigured = await import("./db.js?r284-no-credentials");
    assert.equal(unconfigured.supabase, null, "the fixture must really have no client");
    await assert.rejects(
      () => unconfigured.getScansForBrand("Italica"),
      (err) => {
        assert.equal(err.name, "ScansUnavailableError");
        assert.equal(err.code, "db_not_configured");
        return true;
      }
    );
  } finally {
    process.env.NEXT_PUBLIC_SUPABASE_URL = url;
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = key;
  }
});

// ---------------------------------------------------------------------------
// 3. The route. This is the assertion that would have caught the rejection.
// ---------------------------------------------------------------------------

test("THE BUG — DB unreachable answers 5xx, NOT the 404 that renders the first-run state", async () => {
  const response = await withDb(DB_UNREACHABLE, () => get("Italica"));

  assert.notEqual(
    response.status,
    404,
    "404 means 'this brand has never been scanned' — the dashboard renders " +
      "'run your first visibility check' for it. An outage must never say that."
  );
  assert.ok(
    response.status >= 500 && response.status < 600,
    `an unreadable database must be a 5xx, got ${response.status}`
  );

  const body = await response.json();
  assert.doesNotMatch(
    JSON.stringify(body),
    /no scans found/i,
    "the body must not claim the brand has no scans either"
  );
  // The client at src/app/dashboard/[brand]/page.js:67 keys the error state off
  // !res.ok, and R6.4.3 forbids naming infrastructure to an anonymous caller.
  assert.equal(response.ok, false);
  assert.doesNotMatch(
    JSON.stringify(body),
    /supabase|postgres|ENOTFOUND|ECONNREFUSED/i,
    `a public error must not name infrastructure: ${JSON.stringify(body)}`
  );
});

test("a DB that answers HTTP 500 is also a 5xx, not a 404 — same collapse, different failure", async () => {
  const response = await withDb(DB_RETURNS_500, () => get("Italica"));
  assert.notEqual(response.status, 404);
  assert.ok(response.status >= 500, `expected 5xx, got ${response.status}`);
});

test("THE OTHER HALF — a genuine empty result still answers 404, so the two stay distinguishable", async () => {
  const response = await withDb(DB_RETURNS_ROWS([]), () => get("nosuchbrand-zzz"));

  assert.equal(response.status, 404, "a brand the DB confirms has no scans is a real 404");
  const body = await response.json();
  assert.match(body.detail, /no scans found/i);
});

test("a brand WITH scans is unaffected — 200 and the scan payload", async () => {
  const response = await withDb(DB_RETURNS_ROWS([SCAN_ROW]), () => get("Italica"));

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.scan?.id, SCAN_ROW.id);
  assert.equal(body.scan?.brand, "Italica");
});

test("the three outcomes are three distinct statuses — the whole point of the task", async () => {
  const outage = await withDb(DB_UNREACHABLE, () => get("Italica"));
  const empty = await withDb(DB_RETURNS_ROWS([]), () => get("nosuchbrand-zzz"));
  const found = await withDb(DB_RETURNS_ROWS([SCAN_ROW]), () => get("Italica"));

  const statuses = [outage.status, empty.status, found.status];
  assert.equal(
    new Set(statuses).size,
    3,
    `outage / empty / found must not share a status code, got ${statuses.join(", ")}`
  );
  assert.equal(empty.status, 404);
  assert.equal(found.status, 200);
  assert.ok(outage.status >= 500);
});
