/**
 * R3.2.7 — planted call sites for the live-write-guard ADOPTION walker in
 * `src/lib/liveWriteGuardAdoption.test.mjs`.
 *
 * WHY THEY LIVE IN THEIR OWN FILE. The walker scans every `*.test.mjs` under
 * `src/` and `worker/src/` for source text that says "this file can reach a
 * real database". A fixture is that text, so holding these strings inside the
 * test file made the test file trip its own detector — pg-driver,
 * supabase-create-client and shared-supabase-client all fired on the fixtures —
 * and the only way to keep it green from there would have been to exempt the
 * guard from itself, one signal at a time. That is the exact failure mode the
 * task warns about: an exemption list is where a file goes to stop being
 * checked. This file is not named `*.test.mjs`, so the walk never opens it, and
 * the guard needs no exemption for its own suite.
 *
 * PROVENANCE. Every BYPASS below is the shape of real code in this repo with
 * the guard removed, and every NEUTRAL is real code copied as-is. The line
 * numbers were taken on 2026-09-13; they drift, the shapes do not.
 */

/**
 * Call sites that CAN reach a real database. Each row is
 * [name, source, expected signal ids]. The expected ids are a floor, not an
 * exact set: a row may trip more than it names.
 *
 * If the detector stops flagging one of these, the walker goes quietly green on
 * a real bypass — which is the whole finding R3.2.7 is about.
 */
export const BYPASS_CALL_SITES = Object.freeze([
  [
    "hand-rolled pg client",
    // src/lib/probeTasksRace.test.mjs:89-92 builds a pg.Client exactly like
    // this. That file DOES arm the guard; this copy is what it looks like when
    // the next author leaves the gate out — and nothing but this walker would
    // notice, because the file imports neither the gate nor db.js.
    'import pg from "pg";\nconst c = new pg.Client({ connectionString: process.env.DATABASE_URL });',
    ["pg-driver", "env:DATABASE_URL"],
  ],
  [
    "dynamic pg import",
    // The form all three live files actually use: `const { default: pg } =
    // await import("pg")`. A detector keyed only on a static import misses it.
    'const { default: pg } = await import("pg");\nconst c = new pg.Pool({});',
    ["pg-driver"],
  ],
  [
    "createClient on ambient credentials",
    // src/lib/scanRunsLive.test.mjs:345-365 without its gate: the URL and key
    // come out of the environment, so the client points at whatever .env.local
    // names — which, per the gate's own instructions, is production.
    'const { createClient } = await import("@supabase/supabase-js");\n' +
      "const supa = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);",
    ["supabase-create-client", "env:SUPABASE_URL", "env:SUPABASE_SERVICE_ROLE_KEY"],
  ],
  [
    "createClient over a multi-line variable argument",
    // The same thing formatted by prettier at 120 columns, which is how it will
    // actually arrive. A single-line regex over the call would miss it.
    "const supa = createClient(\n  url,\n  key,\n);",
    ["supabase-create-client"],
  ],
  [
    "shared client with the credentials left ambient",
    // src/lib/workers/scanChunkLedgerLive.test.mjs:7 imports the shared client
    // this way. Without the credential-clearing the hermetic files do first,
    // the object it gets is a real PostgREST client, and `insert` on `scans` is
    // the write that started all of this (two rows in `scans`, two in
    // `brand_metrics_daily`).
    'import { supabase } from "./db.js";\nawait supabase.from("scans").insert({ x: 1 });',
    ["shared-supabase-client"],
  ],
  [
    "shared client via a dynamic import",
    // The deferred form, used so the credential setup above it runs first —
    // except here there is no credential setup above it.
    'const { supabase } = await import("../db.js");',
    ["shared-supabase-client"],
  ],
  [
    "reads the gate credential by hand instead of asking the gate",
    // The bypass the older META rule in liveWriteGuard.test.mjs cannot see at
    // all: it keys on importing src/lib/liveDbGate.js, and this imports nothing.
    "const url = process.env.DATABASE_URL;\nif (url) { /* … */ }",
    ["env:DATABASE_URL"],
  ],
]);

/**
 * Call sites that CANNOT reach a real database, copied from files that are in
 * the tree today. Flagging any of these would push a hermetic file onto the
 * exemption list and teach the next author that the list is where files go to
 * be quiet.
 */
export const NEUTRAL_CALL_SITES = Object.freeze([
  [
    "a client against a URL written into the source",
    // src/lib/liveWriteGuard.test.mjs:197. A `.invalid` host can never resolve:
    // the guard's own suite needs a client object to provoke refusals on, not a
    // server.
    'createClient("https://guard-self-test.invalid", "nope");',
  ],
  [
    "a prose mention of createClient()",
    // src/lib/insertScanCascade3.test.mjs:54 — a comment, and the no-argument
    // form builds nothing even if it were code.
    "// the same class `createClient()` builds supabase.from on",
  ],
  [
    "the shared client after the endpoint is cleared",
    // src/lib/content/contentWorker.test.mjs:30-40, and the same shape in
    // crewCanvas, scanJobAttempts, scanRunReaper and promptSeedingRecord: clear
    // the credentials BEFORE the module graph is evaluated, then assert db.js
    // handed back null. Hermetic by construction, and it proves it.
    'delete process.env.NEXT_PUBLIC_SUPABASE_URL;\nconst { supabase } = await import("../db.js");\n' +
      "assert.equal(supabase, null);",
  ],
  [
    "the shared client pointed at the file's own stub host",
    // src/lib/latestScanRoute.route.test.mjs:41. It does not clear the endpoint,
    // it OWNS it: db.js builds a real client against a host the file's own stub
    // refuses, which is how the route is driven onto its genuine failure path.
    'process.env.NEXT_PUBLIC_SUPABASE_URL = "https://db-for-r284.supabase.test";\n' +
      'const { supabase } = await import("./db.js");',
  ],
  [
    "a credential the file saves and restores around its own value",
    // src/lib/migrationsRunner.test.mjs:160 hands the runner a stub connection
    // string; reading back a value you just wrote is not reading the real one.
    'process.env.DATABASE_URL = "postgresql://stub/stub";\nconst u = process.env.DATABASE_URL;',
  ],
]);

/**
 * One bypass, used by the case that plants a NUL byte (R6.4.10: a NUL hides a
 * file from a grep-based guard) and the case that converts it to CRLF (R6.4.7:
 * the tree is half CRLF despite .gitattributes). Kept here so those two cases
 * and the corpus above cannot drift apart.
 */
export const CRLF_AND_NUL_PROBE = Object.freeze({
  src: 'import pg from "pg";\nconst c = new pg.Client({ connectionString: process.env.DATABASE_URL });\n',
  signals: Object.freeze(["env:DATABASE_URL", "pg-driver"]),
});
