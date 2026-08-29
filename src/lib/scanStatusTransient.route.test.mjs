/**
 * R2.8.3 / finding A11, observed end to end: real route → real client → the
 * state the scan page renders.
 *
 * scanProgress.test.mjs proves the reducer. That is only half the criterion:
 * the reducer is a fix only if the ENVELOPE the status route really emits on a
 * DB read failure reaches it as "unknown". So this suite:
 *
 *   1. imports the REAL status route handler and makes the DB read genuinely
 *      fail (Supabase is pointed at an unusable address — nothing is stubbed,
 *      db.js throws for the same reason it would in production), and
 *   2. feeds that actual Response into the REAL runScan poll loop, and
 *   3. asserts the page-facing state that comes out: "62% complete" plus a
 *      Reconnecting chip — not "% complete", not 0%, not stage 0.
 *
 * The module-resolution hooks (shared with cronAuth.route.test.mjs) only tell
 * Node which file `@/...` and `next/server` mean. No behaviour is substituted.
 *
 * DEPENDENCY NOTE: like cronAuth.route.test.mjs this needs node_modules
 * (`next`, `@supabase/supabase-js`). If the import fails the first test FAILS
 * LOUDLY rather than skipping — a skip here would hide the very path this file
 * exists to observe.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

import {
  applyScanReading,
  applyScanUnknown,
  beginScanProgress,
  isReconnecting,
  progressLabel,
} from "./scanProgress.js";

// db.js builds its Supabase client at import time, so these must be set BEFORE
// the route is imported. The host is real-looking but never reached: every
// request to it is refused at the socket by the transport stub below, which is
// how db.js is made to take its genuine failure path (`if (error) throw error`)
// without stubbing db.js itself.
const DB_HOST = "https://db-that-refuses.supabase.test";
process.env.NEXT_PUBLIC_SUPABASE_URL = DB_HOST;
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-key-for-a-host-that-does-not-answer";

register("./cronAuth.route.hooks.mjs", import.meta.url);

let importError = null;
let statusGET = null;
let runScan = null;
try {
  const [route, api] = await Promise.all([
    import("../app/api/scan/[job_id]/status/route.js"),
    import("../services/api.js"),
  ]);
  statusGET = route.GET;
  runScan = api.runScan;
} catch (error) {
  importError = error;
}

const JOB_URL = "https://aeovis.test/api/scan/job-42/status";

function requireRoute() {
  assert.equal(
    importError,
    null,
    "Could not import the status route / api client. If this says \"Cannot find package\", " +
      `run \`npm install\` — this suite exercises the real modules. Underlying: ${importError?.message}`
  );
  assert.equal(typeof statusGET, "function", "the status route must export GET");
  assert.equal(typeof runScan, "function", "the api client must export runScan");
  return statusGET;
}

/**
 * A connection the DB refuses. `AbortError` is the one failure postgrest does
 * NOT sit in a retry/backoff loop over, so the read fails at once instead of
 * spending seven seconds of suite time proving the same thing.
 */
function refusedConnection() {
  return Object.assign(new Error("connection refused by the database"), { name: "AbortError" });
}

/**
 * Run `fn` with the DB unreachable. Requests to anything else fall through to
 * `passthrough`, which lets the same stub serve the poll loop's own fetches.
 */
async function withDbUnreachable(fn, passthrough = null) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith(DB_HOST)) throw refusedConnection();
    if (passthrough) return passthrough(url, init);
    throw new Error(`unexpected fetch in test: ${url}`);
  };
  try {
    return await fn();
  } finally {
    globalThis.fetch = realFetch;
  }
}

/** The route's answer to a poll whose DB read genuinely failed. */
async function transientResponse() {
  return requireRoute()(new Request(JOB_URL), { params: { job_id: "job-42" } });
}

test("ROUTE — a failed DB read answers 200 with an explicit UNKNOWN, never a fake reading", async () => {
  const response = await withDbUnreachable(transientResponse);
  assert.equal(response.status, 200, "a 500 here would burn one of the client's 5 retries");

  const body = await response.json();
  assert.equal(body.transient_error, true, "the client must be able to tell this apart");
  assert.equal(body.progress_known, false);
  assert.equal(body.progress_pct, null, "progress must be null — 0 would be a measurement we did not take");
  assert.notEqual(body.progress_pct, 0);
  assert.equal(body.status, "unknown", "it must not claim 'working' — nothing was read");
  assert.ok(
    !["pending", "generating_prompts", "probing", "scoring", "analyzing", "complete", "failed"].includes(
      body.status
    ),
    `an unreadable job must not borrow a real job status, got "${body.status}"`
  );
});

test("A11 END TO END — a transient tick mid-scan renders 'reconnecting' and does not rewind", async () => {
  requireRoute();

  const record = {
    brand: "Acme",
    website: "acme.com",
    visibility_score: 41,
    results: [],
  };

  const ticks = [];
  const serveClient = async (url) => {
    const href = String(url);
    if (href.includes("/status")) {
      ticks.push(href);
      // tick 1: a healthy reading. tick 2: the REAL envelope the route emits
      // when its DB read fails. tick 3: completion.
      if (ticks.length === 1) return Response.json({ status: "probing", progress_pct: 62 });
      if (ticks.length === 2) return transientResponse();
      return Response.json({ status: "complete", run_record: record });
    }
    if (href.includes("/api/scan")) return Response.json({ job_id: "job-42" });
    throw new Error(`unexpected fetch in test: ${href}`);
  };

  // Exactly what src/app/scan/page.js wires up.
  let state = beginScanProgress();
  const seen = [];
  await withDbUnreachable(
    () =>
      runScan(
        { brand: "Acme", website: "acme.com", industry: "", competitors: "" },
        (stage, progressPct) => {
          state = applyScanReading(state, { stage, progressPct });
          seen.push({ ...state });
        },
        (meta) => {
          state = applyScanUnknown(state, meta);
          seen.push({ ...state });
        }
      ),
    serveClient
  );

  const blind = seen.find((s) => isReconnecting(s));
  assert.ok(blind, "the transient tick must reach the page as a reconnecting state, not silently");
  assert.equal(blind.progress, 62, "the bar must hold at the last real reading");
  assert.equal(blind.stage, 2, "the transient envelope must not drag the stage back to 0");
  assert.equal(progressLabel(blind).text, "62% complete");
  assert.equal(progressLabel(blind).chip, "Reconnecting");
  assert.equal(blind.unknownReason, "status_unreadable");

  // Nothing anywhere in the run went backwards, and no state ever rendered the
  // bare "% complete" the finding is about.
  let high = -1;
  for (const s of seen) {
    const value = s.progress === null ? high : s.progress;
    assert.ok(value >= high, `progress rewound from ${high} to ${s.progress}`);
    high = value;
    const label = progressLabel(s);
    assert.ok(
      label.text === "—" || /^\d+% complete$/.test(label.text),
      `progress label must be a number or an em dash, got "${label.text}"`
    );
  }
  assert.equal(state.connection, "live", "a later real reading clears the reconnecting state");
  assert.equal(ticks.length, 3, "the poll loop must survive the transient tick, not abort");
});
