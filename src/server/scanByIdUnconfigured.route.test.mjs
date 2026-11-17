/**
 * R2.8.5, the `!supabase` half of getScanById — a deploy with no database
 * credentials must not tell a visitor that their scan does not exist.
 *
 * THE FINDING. src/app/api/scans/_lib/scanRow.js opened with
 * `if (!supabase) return null`, and GET /api/scans/by-id/[scanId] turns null
 * into 404 "Scan not found." So on a misconfigured deploy every
 * /dashboard/[brand]/[scanId] answered 404: a statement about the environment,
 * dressed up as a statement about the row. Nothing could ever be found there —
 * insertScan refuses without a client and there is no memory fallback for
 * scans — so the 404 was not even a defensible degradation. Its own comment
 * cited the pre-R2.8.4 getScansForBrand as house style, which is how the shape
 * would have spread.
 *
 * WHY THIS IS A SEPARATE FILE FROM dbReadOutage.route.test.mjs. db.js builds
 * its client at import time from `process.env`, so "no credentials" is a
 * property of the whole process, not of one test. That sibling file needs a
 * client (it drives postgrest's real error envelope through a refused socket);
 * this one needs the absence of one. Two processes, which is what `node --test`
 * gives per file.
 *
 * Nothing is stubbed here at all: there is no client to stub, and no fetch is
 * made — which is itself asserted below, since a route that reaches the network
 * from an unconfigured process would mean the branch under test never ran.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

// Cleared BEFORE the imports below: db.js decides `supabase` at import time.
delete process.env.NEXT_PUBLIC_SUPABASE_URL;
delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;

register("./cronAuth.route.hooks.mjs", import.meta.url);

const SCAN_ID = "11111111-2222-3333-4444-555555555555";

let importError = null;
let GET = null;
let getScanById = null;
let supabase = null;
try {
  const [route, scanRow, db] = await Promise.all([
    import("../app/api/scans/by-id/[scanId]/route.js"),
    import("../app/api/scans/_lib/scanRow.js"),
    import("./db.js"),
  ]);
  GET = route.GET;
  getScanById = scanRow.getScanById;
  supabase = db.supabase;
} catch (error) {
  importError = error;
}

function requireUnconfigured() {
  assert.equal(
    importError,
    null,
    'Could not import the by-id route. If this says "Cannot find package", run `npm install` — ' +
      `this suite exercises the real handler on purpose. Underlying: ${importError?.message}`
  );
  assert.equal(typeof GET, "function", "the by-id route must export GET");
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

test("with no client, getScanById REFUSES — it does not report the scan as absent", async () => {
  requireUnconfigured();

  await assert.rejects(
    () => getScanById(SCAN_ID),
    (err) => {
      assert.equal(err.name, "ScansUnavailableError", `got ${err?.name}: ${err?.message}`);
      assert.equal(
        err.code,
        "db_not_configured",
        "the code is what lets an operator tell a misconfigured deploy from a broken one"
      );
      return true;
    }
  );
});

test("THE ROUTE — an unconfigured deploy answers 5xx, never 404 'Scan not found.'", async () => {
  requireUnconfigured();

  const { value: response, attempts } = await withNoNetwork(() =>
    GET(new Request(`https://aeovis.test/api/scans/by-id/${SCAN_ID}`), { params: { scanId: SCAN_ID } })
  );

  assert.notEqual(
    response.status,
    404,
    "404 means 'this scan does not exist'. Nothing was asked, so nothing may be denied."
  );
  assert.ok(response.status >= 500 && response.status < 600, `expected 5xx, got ${response.status}`);

  const body = await response.json();
  assert.doesNotMatch(
    JSON.stringify(body),
    /not found/i,
    `the body must not claim the scan is missing either: ${JSON.stringify(body)}`
  );
  assert.doesNotMatch(
    JSON.stringify(body),
    /supabase|postgres/i,
    "and it must not name infrastructure to an anonymous caller (R6.4.3)"
  );
  assert.equal(attempts(), 0, "the refusal must happen before any request is made");
});

test("the input validation in front of it is unchanged — a malformed id is still a 400", async () => {
  requireUnconfigured();

  const { value: response } = await withNoNetwork(() =>
    GET(new Request("https://aeovis.test/api/scans/by-id/not-a-uuid"), { params: { scanId: "not-a-uuid" } })
  );
  assert.equal(
    response.status,
    400,
    "a bad id is the caller's error and must not be laundered into the 500 above"
  );
});
