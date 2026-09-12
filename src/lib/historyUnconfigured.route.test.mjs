/**
 * R2.8.16, the `db_not_configured` half — a deploy with no database credentials
 * must not render the homepage workspace as a brand-new operator's clean page.
 *
 * R2.8.15 made listRecentScans refuse when there is no client, instead of
 * returning []. It could not fix GET /api/history (different file, outside that
 * accept), so the route's own catch answered the refusal with
 * `200 { scans: [], runs: [], activeJobs: [], counts: {} }` — the refusal was
 * visible in the server log and to a direct caller of the function, and nowhere
 * on screen. R2.8.15's own verifier and both reviewers disclosed this; it is the
 * second half of the bug and this file is where it is observed at the route.
 *
 * WHY THIS IS A SEPARATE FILE FROM historyStoreRefusal.route.test.mjs. db.js
 * builds its client at import time from `process.env`, so "no credentials" is a
 * property of the whole process, not of one test. That sibling file needs a
 * client (it drives postgrest's real error envelope through a refused socket);
 * this one needs the absence of one. Two processes, which is what `node --test`
 * gives per file.
 *
 * Nothing is stubbed: there is no client to stub, and no request is made — which
 * is asserted, because a route that reached the network from an unconfigured
 * process would mean the branch under test never ran.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

// Cleared BEFORE the imports below: db.js decides `supabase` at import time.
delete process.env.NEXT_PUBLIC_SUPABASE_URL;
delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;

register("./cronAuth.route.hooks.mjs", import.meta.url);

let importError = null;
let GET = null;
let supabase = null;
let ScansUnavailableError = null;
let listRecentScans = null;
try {
  const [route, db] = await Promise.all([
    import("../app/api/history/route.js"),
    import("./db.js"),
  ]);
  GET = route.GET;
  supabase = db.supabase;
  ScansUnavailableError = db.ScansUnavailableError;
  listRecentScans = db.listRecentScans;
} catch (error) {
  importError = error;
}

function requireUnconfigured() {
  assert.equal(
    importError,
    null,
    'Could not import the history route. If this says "Cannot find package", run `npm install` — ' +
      `this suite exercises the real handler on purpose. Underlying: ${importError?.message}`
  );
  assert.equal(typeof GET, "function", "the history route must export GET");
  assert.equal(
    supabase,
    null,
    "this suite is only meaningful with NO client — the env above must really have been cleared"
  );
}

/** Runs `fn` with any network call turned into a test failure. */
async function withNoNetwork(fn) {
  const realFetch = globalThis.fetch;
  let reached = false;
  globalThis.fetch = async (url) => {
    reached = true;
    throw new Error(`the unconfigured path must not reach the network: ${String(url?.url || url)}`);
  };
  try {
    return await fn();
  } finally {
    globalThis.fetch = realFetch;
    assert.equal(reached, false, "no request may be made from a process with no client");
  }
}

const callRoute = () => GET(new Request("https://aeovis.test/api/history"));

test("premise — listRecentScans really does refuse on this process (R2.8.15 still holds)", async () => {
  requireUnconfigured();
  await withNoNetwork(() =>
    assert.rejects(() => listRecentScans(12), (err) => {
      assert.ok(err instanceof ScansUnavailableError, `got ${err?.name}`);
      assert.equal(err.code, "db_not_configured");
      return true;
    })
  );
});

test("ACCEPT — GET /api/history answers 503 'unreachable', not 200 with an empty workspace", async () => {
  requireUnconfigured();

  const response = await withNoNetwork(callRoute);
  assert.notEqual(
    response.status,
    200,
    "a workspace that was never read must not be reported with a success status"
  );
  assert.equal(response.status, 503, `expected 503, got ${response.status}`);

  const body = await response.json();
  assert.equal(body.store, "unreachable");
  assert.equal(
    body.reason,
    "db_not_configured",
    "the deploy's own fault must be named as such, and with the code the read side already uses"
  );

  // The fabrication itself. Each of these four was the old 200 body.
  assert.equal(body.scans, null, "scans must be null — [] here would be a manufactured measurement");
  assert.equal(body.runs, null);
  assert.equal(body.activeJobs, null);
  assert.equal(body.counts, null, "counts must be null, not {} and certainly not {brands: 0}");
  assert.notDeepEqual(
    body,
    { scans: [], runs: [], activeJobs: [], counts: {} },
    "this exact body is the bug — it is what a real first-run workspace looks like"
  );

  assert.match(
    body.detail,
    /not a workspace with nothing in it/i,
    "the response must say what it means in words, not only in a status code"
  );
});

test("SECURITY — the unconfigured refusal leaks no env var name, no credential and no stack", async () => {
  requireUnconfigured();
  const response = await withNoNetwork(callRoute);
  const text = JSON.stringify(await response.json());

  assert.doesNotMatch(
    text,
    /supabase|SUPABASE|NEXT_PUBLIC|SERVICE_ROLE|anon[_-]?key|postgres/i,
    `a client-facing refusal must not name our infrastructure or its variables: ${text}`
  );
  assert.doesNotMatch(text, /\n\s+at\s/, "no stack trace may travel to the client");
});
