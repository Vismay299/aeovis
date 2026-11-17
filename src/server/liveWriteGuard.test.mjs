import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import {
  installLiveWriteGuard,
  classifyStatement,
  liveWriteRefusals,
  liveWriteGuardDepth,
  activeLiveWriteGuardLabel,
  LiveWriteRefused,
  NEVER_WRITABLE,
  WRITABLE_BY_OPT_IN,
  WRITING_FUNCTIONS,
  __clearRefusalsForGuardSelfTestOnly,
} from "./liveWriteGuard.js";

/**
 * R3.2.4 — the guard's own tests. Hermetic: no database, no network.
 *
 * The property under test is default-deny. R3.2.1's live file protected itself
 * with a hand-written list of `assert.fail` stubs, one per writer; the failure
 * mode this file exists to close is the next author forgetting a name, because
 * the DEFAULT behind a missing stub is the real function against production —
 * which is exactly how two rows landed in `scans` and two in
 * `brand_metrics_daily`. So the assertions below are all about what happens
 * when a test says NOTHING about a table.
 *
 * Every case that provokes a refusal clears the process-wide record afterwards,
 * because a refusal deliberately sets `process.exitCode = 1` and a self-test
 * must not leave the run marked failed. The last case asserts the residue is
 * gone.
 */

/** Refusals shout on stderr by design; the self-test does not need the noise. */
async function quiet(fn) {
  const orig = process.stderr.write.bind(process.stderr);
  process.stderr.write = () => true;
  try {
    return await fn();
  } finally {
    process.stderr.write = orig;
  }
}

function reset() {
  __clearRefusalsForGuardSelfTestOnly();
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const THIS_FILE = "src/server/liveWriteGuard.test.mjs";

/**
 * Set in every child this file spawns, and read by exactly one case — the one
 * that re-runs this whole file — so the children do not spawn children forever.
 * Nothing else may branch on it: a second reader would be a case that behaves
 * differently in the comparison than in the run being compared, which is the
 * ambient-dependence this task exists to remove.
 */
const RERUN_SENTINEL = "PERCEEV_GUARD_SELFTEST_RERUN";

/**
 * R6.5.7 — run node in a child process, with or without the preload that
 * `npm run test:scoring` uses.
 *
 * WHY A CHILD, AND WHY BOTH INVOCATIONS. Most of what this file asserts is
 * about the state of two PROTOTYPES, and this process's prototypes are already
 * in whatever state its own invocation left them: under
 * `npm run test:scoring` the `--import ./src/server/liveWriteGuardAuto.mjs`
 * preload has installed a policy before the first test runs, so
 * `liveWriteGuardDepth()` starts at 1 and the patches are never torn down; run
 * bare, it starts at 0. Two implementers reported this file as passing alone
 * and failing in the full run, and diagnosed it as sibling test files sharing a
 * worker. That was not the mechanism — `node --test` gives every file its own
 * child process — the preload was. The first repair made the case BRANCH on
 * `liveWriteGuardDepth()`, which turned the flake into something worse: under
 * the invocation CI actually uses, the branch that checks the prototypes are
 * restored never ran at all. Measured before this rework: with
 * `teardownPatch()` in liveWriteGuard.js reduced to a no-op, this file was
 * 23/23 green under `npm run test:scoring` and 3 red bare.
 *
 * So the ambient state stops being something to detect and becomes something to
 * construct: each half of the property is asserted in a child whose invocation
 * this file chose, and both halves therefore run on every invocation of the
 * parent.
 */
function runNode(args, { preload = false } = {}) {
  const argv = preload ? ["--import", "./src/server/liveWriteGuardAuto.mjs", ...args] : args;
  const childEnv = { ...process.env };
  // NODE_OPTIONS can carry an `--import` of its own, which would make "run
  // without the preload" a lie and quietly collapse the two halves of every
  // comparison below into one. Clear it so each half is what it claims.
  childEnv.NODE_OPTIONS = "";
  // The runner sets NODE_TEST_CONTEXT in the process it spawns per test file,
  // and a `node --test` that inherits it declines to run any file at all — it
  // prints "run() is being called recursively" to stderr, collects nothing and
  // still exits 0. That is a green run of an empty suite, so it must not be
  // reachable: dropping the variable makes the child a top-level runner, and
  // the "no test counts at all" assertion below catches it if this ever stops
  // working.
  delete childEnv.NODE_TEST_CONTEXT;
  // EVERY child this file spawns carries the re-run sentinel, set here and
  // nowhere else. One of the cases below re-runs this whole file in a child; if
  // the child did not know it was a re-run it would spawn two more, and each of
  // those two more. Setting it in the one place a child can be created is what
  // makes that unreachable rather than merely unlikely, and the case that
  // depends on it checks a child really sees it before it spawns anything big.
  childEnv[RERUN_SENTINEL] = "1";
  const res = spawnSync(process.execPath, argv, {
    cwd: ROOT,
    encoding: "utf8",
    env: childEnv,
  });
  if (res.error) throw res.error;
  return { status: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

/**
 * Install a guard, uninstall it, and report what happened to the prototypes and
 * to the depth — as data, so the parent can assert an exact expected shape for
 * each invocation instead of asking which one it is in.
 *
 * `patchedDuring*` is the anti-vacuity half: "the prototype is back to what it
 * was" is also true of a guard that never patched anything, and that is the
 * failure this whole module exists to prevent.
 */
const RESTORE_PROBE = `
const pg = (await import("pg")).default;
const { SupabaseClient, createClient } = await import("@supabase/supabase-js");
const {
  installLiveWriteGuard,
  liveWriteGuardDepth,
  LiveWriteRefused,
  __clearRefusalsForGuardSelfTestOnly,
} = await import("./src/server/liveWriteGuard.js");

const beforeFrom = SupabaseClient.prototype.from;
const beforeQuery = pg.Client.prototype.query;
const outer = liveWriteGuardDepth();

const guard = await installLiveWriteGuard({ label: "child/restore", allow: ["scan_runs"] });
const patchedDuringFrom = SupabaseClient.prototype.from !== beforeFrom;
const patchedDuringQuery = pg.Client.prototype.query !== beforeQuery;
const during = liveWriteGuardDepth();
guard.uninstall();

// Is the PROCESS still refusing writes now that this guard is gone? Under the
// preload it must be (an outer policy remains); bare it must not be (nothing is
// installed, and a guard that refuses after uninstall never really uninstalled).
const supa = createClient("https://guard-self-test.invalid", "not-a-real-key", {
  global: { fetch: async () => new Response("[]", { status: 200 }) },
});
let stillArmed = false;
try {
  supa.from("scan_runs").insert({ runner: "x" });
} catch (err) {
  stillArmed = err instanceof LiveWriteRefused;
}
__clearRefusalsForGuardSelfTestOnly();

process.stdout.write(
  "PROBE" +
    JSON.stringify({
      outer,
      during,
      after: liveWriteGuardDepth(),
      patchedDuringFrom,
      patchedDuringQuery,
      fromRestored: SupabaseClient.prototype.from === beforeFrom,
      queryRestored: pg.Client.prototype.query === beforeQuery,
      stillArmed,
    })
);
`;

function restoreProbe({ preload }) {
  const how = preload ? "with the test:scoring preload" : "bare, with no preload";
  const res = runNode(["--input-type=module", "-e", RESTORE_PROBE], { preload });
  assert.equal(
    res.status,
    0,
    `the restore probe (${how}) must exit 0; got ${res.status}\n${res.stdout}\n${res.stderr}`
  );
  const m = res.stdout.match(/PROBE(\{.*\})/s);
  assert.ok(m, `the restore probe (${how}) printed no result; stdout: ${res.stdout} stderr: ${res.stderr}`);
  return JSON.parse(m[1]);
}

async function fakeSupabase() {
  const { createClient } = await import("@supabase/supabase-js");
  // A real SupabaseClient instance so the prototype patch is exercised, with a
  // fetch that can never reach anything. Nothing here is ever awaited, so no
  // request is made even on the paths the guard permits.
  return createClient("https://guard-self-test.invalid", "not-a-real-key", {
    global: { fetch: async () => new Response("[]", { status: 200 }) },
  });
}

// ---------------------------------------------------------------------------
// The default
// ---------------------------------------------------------------------------

test("DEFAULT DENY — a guard that names no table refuses a write to every table", async () => {
  const supa = await fakeSupabase();
  const guard = await installLiveWriteGuard({ label: "self-test/default-deny" });
  try {
    assert.equal(guard.covers.supabase, true, "the supabase-js choke point must actually be patched");
    await quiet(() => {
      for (const table of ["scan_runs", "probe_tasks", "scans", "brand_metrics_daily", "a_table_nobody_named"]) {
        assert.throws(
          () => supa.from(table).insert({ x: 1 }),
          LiveWriteRefused,
          `an undeclared write to ${table} must be refused, not performed`
        );
      }
    });
    // Reads are untouched: the incident was a write, and a harness that also
    // blocked reads would just be turned off.
    assert.doesNotThrow(() => supa.from("scans").select("*"));
    assert.equal(guard.writes.length, 0, "nothing was permitted, so nothing may be recorded as written");
  } finally {
    guard.uninstall();
    reset();
  }
});

test("OPT-IN IS PER TABLE — naming scan_runs does not open probe_tasks", async () => {
  const supa = await fakeSupabase();
  const guard = await installLiveWriteGuard({ label: "self-test/per-table", allow: ["scan_runs"] });
  try {
    assert.doesNotThrow(() => supa.from("scan_runs").insert({ runner: "x" }), "the declared table is writable");
    assert.doesNotThrow(() => supa.from("scan_runs").delete());
    await quiet(() => {
      assert.throws(() => supa.from("probe_tasks").insert({}), LiveWriteRefused);
      assert.throws(() => supa.from("scans").update({}), LiveWriteRefused);
      assert.throws(() => supa.from("brand_metrics_daily").upsert({}), LiveWriteRefused);
    });
    assert.deepEqual(
      guard.writes.map((w) => `${w.table}:${w.operation}`),
      ["scan_runs:insert()", "scan_runs:delete()"],
      "permitted writes are recorded, so a test can tell 'wrote nothing' from 'was never asked to'"
    );
  } finally {
    guard.uninstall();
    reset();
  }
});

test("A REFUSAL CANNOT BE SWALLOWED — it is recorded and it fails the process", async () => {
  const supa = await fakeSupabase();
  const guard = await installLiveWriteGuard({ label: "self-test/unswallowable" });
  try {
    await quiet(() => {
      try {
        // Exactly what insertScan's cascade does with its own failures: catch
        // and carry on. That must not be able to produce a green run.
        supa.from("scans").insert({ brand: "x" });
      } catch {
        /* swallowed, as the app would */
      }
    });
    assert.equal(process.exitCode, 1, "a swallowed refusal must still fail the run");
    const mine = guard.refusals;
    assert.equal(mine.length, 1);
    assert.equal(mine[0].table, "scans");
    assert.match(mine[0].message, /LIVE WRITE REFUSED/);
    assert.match(mine[0].message, /self-test\/unswallowable/, "the refusal must name the test that caused it");
    assert.throws(() => guard.assertClean(), LiveWriteRefused, "assertClean is the cleanup case's assertion");
  } finally {
    guard.uninstall();
    reset();
  }
});

// ---------------------------------------------------------------------------
// What may be opted into at all
// ---------------------------------------------------------------------------

test("CUSTOMER TABLES CANNOT BE OPTED INTO — the allow list refuses them at install", async () => {
  for (const table of ["scans", "brand_metrics_daily", "prompt_results", "citations"]) {
    await assert.rejects(
      () => installLiveWriteGuard({ label: "self-test/never", allow: [table] }),
      /can never be opened for writing/,
      `${table} is customer data; there is no legitimate live test that writes it`
    );
  }
  // And the two tables the incident actually hit are named in the list.
  assert.ok(NEVER_WRITABLE.includes("scans"));
  assert.ok(NEVER_WRITABLE.includes("brand_metrics_daily"));
});

test("EVERY NEVER_WRITABLE TABLE IS REFUSED — at install and at both transports, not just the four in the case above", async () => {
  // R6.5.7. The case above names four tables; this loop exercises the complete
  // data roster, including the customer identity and tenant-isolation tables.
  assert.equal(NEVER_WRITABLE.length, 105, "the roster changed size - see the classification walk below");
  assert.equal(new Set(NEVER_WRITABLE).size, 105, "a duplicated entry hides a missing one");
  assert.ok(Object.isFrozen(NEVER_WRITABLE), "the roster must not be mutable at runtime");
  for (const t of WRITABLE_BY_OPT_IN) {
    assert.ok(!NEVER_WRITABLE.includes(t), `${t} cannot be both writable by opt-in and never writable`);
  }

  const { default: pg } = await import("pg");
  const supa = await fakeSupabase();
  const realQuery = pg.Client.prototype.query;
  pg.Client.prototype.query = function () {
    assert.fail("a NEVER_WRITABLE statement reached the pg driver");
  };
  // The widest policy a test can legitimately hold: everything opt-in allows.
  const guard = await installLiveWriteGuard({
    label: "self-test/never-writable-roster",
    allow: [...WRITABLE_BY_OPT_IN],
  });
  const client = new pg.Client({ connectionString: "postgres://unused" });
  try {
    for (const table of NEVER_WRITABLE) {
      await assert.rejects(
        () => installLiveWriteGuard({ label: "self-test/never-writable-roster", allow: [table] }),
        /can never be opened for writing/,
        `${table} is customer data: naming it in an allow-list must be refused at install`
      );
      await quiet(async () => {
        assert.throws(
          () => supa.from(table).insert({ x: 1 }),
          LiveWriteRefused,
          `a PostgREST insert into ${table} must be refused even under the widest legitimate allow-list`
        );
        await assert.rejects(
          () => client.query(`INSERT INTO ${table} (x) VALUES ($1)`, ["x"]),
          LiveWriteRefused,
          `raw SQL writing ${table} must be refused too — the guard has two transports and a table is only ` +
            `protected if both refuse it`
        );
      });
    }
    assert.equal(guard.writes.length, 0, "not one of the never-writable tables may be recorded as permitted");
    assert.equal(guard.refusals.length, NEVER_WRITABLE.length * 2, "every attempt is on the record, both transports");
  } finally {
    guard.uninstall();
    pg.Client.prototype.query = realQuery;
    reset();
  }
});

test("GUARD — every table this repo creates or reads is classified, so a new one cannot arrive unlisted", async () => {
  // R6.5.7. `NEVER_WRITABLE` is a hand-maintained list, and the failure it
  // cannot survive is the quiet one: migration 014 adds `invoices`, nobody adds
  // it here, and a year later someone puts it in WRITABLE_BY_OPT_IN because it
  // is "not on the never list". So the list is checked against ground truth
  // instead of against a copy of itself — the tables the migrations CREATE, and
  // the tables the app actually names in a `.from("…")` call.
  //
  // Both directions are asserted. A migration table missing from the lists is
  // an unclassified table; a listed name no migration creates is a typo, and a
  // typo in this list protects nothing while looking like it protects
  // something.
  const MIGRATIONS = path.join(ROOT, "supabase/migrations");
  const files = (await readdir(MIGRATIONS)).filter((f) => f.endsWith(".sql")).sort();
  assert.ok(
    files.length >= 13,
    `expected the migration history to be here; found ${files.length} .sql files in supabase/migrations. ` +
      `A walk over no files is not a clean result`
  );

  const created = new Set();
  for (const f of files) {
    // Line comments are stripped first. 016's header wraps "`CREATE TABLE IF
    // NOT\n-- EXISTS`" across two comment lines; the regex below crossed the
    // newline, could not match `-- EXISTS` as `exists`, backtracked, and
    // recorded a table named `if`.
    const sql = (await readFile(path.join(MIGRATIONS, f), "utf8")).replace(/--[^\n]*/g, "");
    for (const m of sql.matchAll(/\bcreate\s+table\s+(?:if\s+not\s+exists\s+)?(?:public\.)?([a-z_][a-z0-9_]*)/gi)) {
      created.add(m[1].toLowerCase());
    }
  }
  assert.ok(created.size >= 22, `expected at least 22 tables in the migration history; found ${created.size}`);

  // The second source: what the application code actually reaches for. A table
  // created outside this repo's migrations — by hand in the dashboard, say —
  // is invisible to the walk above but not to this one.
  async function walk(dir) {
    const out = [];
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      // worker/ is its own npm workspace: a `worker/node_modules` on disk is
      // full of vendors' README examples (`.from("avatars")`, `very_big_table`),
      // none of which is a table this app touches.
      if (e.isDirectory() && e.name === "node_modules") continue;
      if (e.isDirectory()) out.push(...(await walk(full)));
      else if (/\.(mjs|js|jsx)$/.test(e.name) && !/\.test\.mjs$/.test(e.name)) out.push(full);
    }
    return out;
  }
  const sources = [...(await walk(path.join(ROOT, "src"))), ...(await walk(path.join(ROOT, "worker")))];
  assert.ok(sources.length >= 50, `expected to walk the app's source; found ${sources.length} files`);

  const named = new Set();
  for (const file of sources) {
    const src = await readFile(file, "utf8");
    // `Array.from("…")` is not a table read; nothing else in this tree calls
    // `.from()` with a bare lower-case string literal.
    for (const m of src.matchAll(/(?<!Array)\.from\(\s*["'`]([a-z][a-z0-9_]*)["'`]\s*\)/g)) {
      named.add(m[1]);
    }
  }
  assert.ok(named.size >= 18, `expected the app to name at least 18 tables in .from() calls; found ${named.size}`);

  const classified = new Set([...NEVER_WRITABLE, ...WRITABLE_BY_OPT_IN]);
  const groundTruth = new Set([...created, ...named]);

  const unclassified = [...groundTruth].filter((t) => !classified.has(t)).sort();
  assert.deepEqual(
    unclassified,
    [],
    `these tables exist in the schema or are read by the app and appear in neither list in ` +
      `src/server/liveWriteGuard.js. Until one of the lists names it, nothing stops a future test from adding ` +
      `it to WRITABLE_BY_OPT_IN: ${unclassified.join(", ")}`
  );

  const phantom = [...classified].filter((t) => !groundTruth.has(t)).sort();
  assert.deepEqual(
    phantom,
    [],
    `these names are listed in src/server/liveWriteGuard.js but no migration creates them and no source file ` +
      `reads them. A misspelled table name protects nothing while reading as protection: ${phantom.join(", ")}`
  );

  // The two the incident actually hit, named explicitly so no amount of set
  // arithmetic above can end with them unprotected.
  for (const t of ["scans", "brand_metrics_daily"]) {
    assert.ok(NEVER_WRITABLE.includes(t), `${t} is one of the two tables the original incident wrote`);
  }
});

test("AN UNKNOWN TABLE CANNOT BE OPTED INTO EITHER — widening is a diff, not a call site", async () => {
  await assert.rejects(
    () => installLiveWriteGuard({ label: "self-test/unknown", allow: ["some_new_ledger"] }),
    /not a table a live test may write/
  );
  assert.deepEqual([...WRITABLE_BY_OPT_IN].sort(), ["crawlability_audits", "probe_tasks", "scan_runs"]);
});

test("a guard with no label is refused: an anonymous refusal names nobody", async () => {
  await assert.rejects(() => installLiveWriteGuard({ allow: ["scan_runs"] }), /needs a label/);
});

// ---------------------------------------------------------------------------
// RPC: the writes that do not look like writes
// ---------------------------------------------------------------------------

test("RPC — a known writer is checked against the allow list, both ways", async () => {
  const supa = await fakeSupabase();
  const guard = await installLiveWriteGuard({ label: "self-test/rpc", allow: ["scan_runs"] });
  try {
    assert.doesNotThrow(() => supa.rpc("open_scan_run", { p_runner: "x" }));
    await quiet(() => {
      assert.throws(() => supa.rpc("claim_probe_tasks", {}), LiveWriteRefused, "probe_tasks was not declared");
      assert.throws(() => supa.rpc("increment_scan_rate_limit", {}), /can never be opened|did not declare/);
    });
  } finally {
    guard.uninstall();
    reset();
  }
});

test("RPC — a function the guard has never heard of is refused, not assumed to be a reader", async () => {
  const supa = await fakeSupabase();
  const guard = await installLiveWriteGuard({ label: "self-test/rpc-unknown", allow: ["scan_runs"] });
  try {
    await quiet(() => {
      assert.throws(() => supa.rpc("some_function_added_next_month", {}), /not listed in WRITING_FUNCTIONS/);
    });
    // The ledger and queue functions the codebase actually calls are all mapped,
    // so this refusal only ever fires on something genuinely new.
    for (const fn of ["open_scan_run", "heartbeat_scan_run", "close_scan_run", "claim_probe_tasks", "prune_backlink_snapshots"]) {
      assert.ok(WRITING_FUNCTIONS[fn], `${fn} must be mapped to the table it writes`);
    }
  } finally {
    guard.uninstall();
    reset();
  }
});

test("schema() is refused rather than silently unguarded", async () => {
  const supa = await fakeSupabase();
  const guard = await installLiveWriteGuard({ label: "self-test/schema", allow: ["scan_runs"] });
  try {
    await quiet(() => {
      assert.throws(() => supa.schema("public"), /cannot see through \.schema\(\)/);
    });
  } finally {
    guard.uninstall();
    reset();
  }
});

// ---------------------------------------------------------------------------
// Raw SQL
// ---------------------------------------------------------------------------

test("classifyStatement separates reads, writes, control and the unclassifiable", () => {
  const cases = [
    ["SELECT * FROM scans WHERE id = $1", "read", []],
    ["SELECT count(*)::int AS n FROM scan_runs WHERE worker_id LIKE $1", "read", []],
    ["SELECT p.proname FROM pg_proc p WHERE p.proname IN ('close_scan_run')", "read", []],
    ["DELETE FROM scan_runs WHERE runner = $1", "write", ["scan_runs"]],
    ["INSERT INTO probe_tasks (batch_id) SELECT $1::uuid", "write", ["probe_tasks"]],
    ["UPDATE public.scans SET score = 1", "write", ["scans"]],
    // Aliased and ONLY forms: without these the target table is invisible to a
    // naive pattern and the statement reads as a SELECT.
    ["UPDATE scans s SET score = 1 WHERE s.id = $1", "write", ["scans"]],
    ["UPDATE scans AS s SET score = 1", "write", ["scans"]],
    ["UPDATE ONLY scan_runs SET ended_at = now()", "write", ["scan_runs"]],
    ["DELETE FROM ONLY scans WHERE id = $1", "write", ["scans"]],
    ["WITH d AS (SELECT 1) INSERT INTO scans (brand) SELECT 'x'", "write", ["scans"]],
    ["SELECT open_scan_run($1, 'probing', $2) AS r", "write", ["scan_runs"]],
    ["SELECT 1; DELETE FROM scans", "write", ["scans"]],
    ["BEGIN", "control", []],
    ["ROLLBACK", "control", []],
    ["DROP TABLE scans", "ddl", []],
    ["TRUNCATE scan_runs", "ddl", []],
    ["nonsense", "unknown", []],
  ];
  for (const [sql, kind, tables] of cases) {
    const v = classifyStatement(sql);
    assert.equal(v.kind, kind, `${sql} -> ${v.kind} (${v.why})`);
    assert.deepEqual(v.tables.sort(), tables.sort(), sql);
  }
  // A quoted string that looks like SQL is not SQL. Without this, a fixture
  // whose text mentions a table would be misread.
  assert.equal(classifyStatement("SELECT 'delete from scans' AS note").kind, "read");
});

test("pg — the prototype patch refuses an undeclared write and lets a declared one through", async () => {
  const { default: pg } = await import("pg");
  const seen = [];
  const stub = function (config) {
    seen.push(typeof config === "string" ? config : config.text);
    return Promise.resolve({ rows: [] });
  };
  const realQuery = pg.Client.prototype.query;
  // Stand a stub in BEFORE installing, so the guard captures it as the
  // pass-through and no connection is ever needed.
  pg.Client.prototype.query = stub;

  const guard = await installLiveWriteGuard({ label: "self-test/pg", allow: ["scan_runs"] });
  const client = new pg.Client({ connectionString: "postgres://unused" });
  try {
    assert.equal(guard.covers.pg, true, "the pg choke point must actually be patched");

    await client.query("DELETE FROM scan_runs WHERE runner = $1", ["x"]);
    await client.query("SELECT * FROM scans");
    await client.query("BEGIN");
    assert.deepEqual(seen, ["DELETE FROM scan_runs WHERE runner = $1", "SELECT * FROM scans", "BEGIN"]);

    await quiet(async () => {
      await assert.rejects(() => client.query("DELETE FROM scans"), LiveWriteRefused);
      await assert.rejects(() => client.query("INSERT INTO brand_metrics_daily (brand) VALUES ($1)", ["x"]), LiveWriteRefused);
      await assert.rejects(() => client.query("DELETE FROM probe_tasks"), LiveWriteRefused);
      await assert.rejects(() => client.query("DROP TABLE scan_runs"), LiveWriteRefused);
      await assert.rejects(() => client.query("gibberish"), LiveWriteRefused);
    });
    assert.equal(seen.length, 3, "not one refused statement may have reached the driver");

    // A caller that swallows the rejection still cannot make the run green.
    await quiet(() => client.query("DELETE FROM scans").catch(() => {}));
    assert.equal(process.exitCode, 1);
  } finally {
    guard.uninstall();
    pg.Client.prototype.query = realQuery;
    reset();
  }
});

test("uninstall removes exactly one policy, whatever this process started with", async () => {
  // The half of the property that is true under BOTH invocations, so it needs
  // no branch. The prototype half is not: see the case below, which constructs
  // each invocation rather than detecting the one it happens to be in.
  const outer = liveWriteGuardDepth();
  const guard = await installLiveWriteGuard({ label: "self-test/restore", allow: ["scan_runs"] });
  assert.equal(liveWriteGuardDepth(), outer + 1);
  assert.equal(activeLiveWriteGuardLabel(), "self-test/restore");
  guard.uninstall();
  assert.equal(liveWriteGuardDepth(), outer, "uninstall removes exactly one policy");
  assert.notEqual(activeLiveWriteGuardLabel(), "self-test/restore", "…and stands its policy down");
  guard.uninstall();
  assert.equal(liveWriteGuardDepth(), outer, "a second uninstall is a no-op, not a hole in the stack");
});

test("THE LAST UNINSTALL RESTORES BOTH PROTOTYPES — proven in a child with no preload, on every run", () => {
  // The case this replaces asked `liveWriteGuardDepth() === 0` and only checked
  // restoration when the answer was yes. Under `npm run test:scoring` the
  // answer is always no, so the check never ran where it matters: with
  // `teardownPatch()` reduced to a no-op the file stayed 23/23 green under the
  // npm script and went 3 red only when run bare. Constructing the bare
  // invocation here makes the assertion run under both.
  const bare = restoreProbe({ preload: false });

  assert.equal(bare.outer, 0, "a child with no preload must start with no policy installed");
  assert.equal(bare.during, 1, "installing one guard makes the depth one");
  assert.equal(bare.after, 0, "…and uninstalling it takes the depth back to none");

  // Anti-vacuity: "the prototype is back to what it was" is also true of a
  // guard that never patched anything, which is precisely the outcome this
  // module exists to prevent. So assert it WAS patched first.
  assert.equal(bare.patchedDuringFrom, true, "the install must actually replace SupabaseClient.prototype.from");
  assert.equal(bare.patchedDuringQuery, true, "…and pg.Client.prototype.query");

  assert.equal(bare.fromRestored, true, "the last uninstall must put the original from() back");
  assert.equal(bare.queryRestored, true, "…and the original query()");
  assert.equal(
    bare.stillArmed,
    false,
    "with no policy left the process is unguarded — a guard that still refuses after the last uninstall " +
      "never really uninstalled, and the next test file would inherit it"
  );
});

test("AN INNER UNINSTALL DOES NOT DISARM — proven in a child WITH the preload, on every run", () => {
  // The other half, constructed the same way. This is the shape every file in
  // `npm run test:scoring` actually runs in: liveWriteGuardAuto.mjs has a
  // default-deny policy installed before the first test, and a live file's own
  // guard sits on top of it. Uninstalling the inner one must narrow the
  // allow-list back to nothing, never take the patches off the prototypes.
  const preloaded = restoreProbe({ preload: true });

  assert.equal(preloaded.outer, 1, "the preload must have installed exactly one policy before anything ran");
  assert.equal(preloaded.during, 2, "a file's own guard stacks on top of it");
  assert.equal(preloaded.after, 1, "…and uninstalling it leaves the preload's policy standing");

  assert.equal(
    preloaded.patchedDuringFrom,
    false,
    "installs stack, they do not re-patch: a second wrapper would check every write twice"
  );
  assert.equal(preloaded.patchedDuringQuery, false, "…same for pg");

  assert.equal(
    preloaded.stillArmed,
    true,
    "an inner uninstall must not disarm the process while an outer guard is still installed — this is the " +
      "state a live test file leaves behind, and the next write after it must still be refused"
  );
});

test("THE VERDICT DOES NOT DEPEND ON THE INVOCATION — this file is re-run both ways and must agree", (t) => {
  // R6.5.7's acceptance, executed rather than remembered. The two reports that
  // filed this task were "passes alone, fails in the full run"; the assertion
  // that closes it is that the two runs produce the SAME numbers, so neither a
  // future branch on ambient state nor a future dependence on the preload can
  // go unnoticed by whichever way the author happened to run it.
  //
  // The children carry a sentinel so they skip THIS case and do not recurse.
  // Two things keep that from becoming a hole: the pre-flight below refuses to
  // spawn a re-run until a child has been seen to inherit the sentinel, and
  // each re-run must report exactly ONE skipped case — a comparison of two runs
  // that quietly stopped checking things would otherwise agree perfectly.
  if (process.env[RERUN_SENTINEL]) {
    t.skip(`re-run child (${RERUN_SENTINEL} set): the parent is comparing this run against the other invocation`);
    return;
  }

  // Pre-flight: prove a child really sees the sentinel BEFORE spawning two
  // full re-runs. If it did not, each re-run would spawn two more and this case
  // would be a fork bomb rather than a comparison.
  const probe = runNode([
    "--input-type=module",
    "-e",
    `process.stdout.write("SENTINEL=" + (process.env[${JSON.stringify(RERUN_SENTINEL)}] ?? "unset"))`,
  ]);
  assert.equal(
    probe.stdout.trim(),
    "SENTINEL=1",
    `a child process must inherit ${RERUN_SENTINEL}, or the re-runs below would recurse without end`
  );

  const args = ["--test", "--test-reporter=tap", THIS_FILE];
  const runs = {
    bare: runNode(args, { preload: false }),
    preloaded: runNode(args, { preload: true }),
  };

  const counts = {};
  for (const [how, res] of Object.entries(runs)) {
    const tally = {};
    for (const m of res.stdout.matchAll(/^# (tests|pass|fail|skipped) (\d+)$/gm)) tally[m[1]] = Number(m[2]);
    assert.ok(
      tally.tests > 0,
      `the ${how} re-run reported no test counts at all, so there is nothing to compare; ` +
        `exit ${res.status}\n${res.stdout.slice(-2000)}\n${res.stderr.slice(-2000)}`
    );
    assert.equal(tally.fail, 0, `the ${how} re-run failed ${tally.fail} test(s):\n${res.stdout.slice(-4000)}`);
    assert.equal(res.status, 0, `the ${how} re-run exited ${res.status}\n${res.stderr.slice(-2000)}`);
    assert.equal(
      tally.skipped,
      1,
      `the ${how} re-run must skip exactly this case and nothing else; skipping more would mean the ` +
        `comparison below is between two runs that quietly stopped checking things`
    );
    counts[how] = tally;
  }

  // A floor, so a run that collected almost nothing cannot read as agreement.
  assert.ok(
    counts.bare.pass >= 20,
    `expected at least 20 passing cases in a re-run; got ${counts.bare.pass}. If cases were legitimately ` +
      `removed, lower this floor deliberately — do not let it stay above a shrinking suite`
  );
  assert.deepEqual(
    counts.bare,
    counts.preloaded,
    "the same file, run bare and run under the test:scoring preload, must reach the same verdict; a " +
      "difference here is the R6.5.7 finding returning — an assertion whose answer depends on how the " +
      "suite was started is not evidence about the guard"
  );
});

test("NO TEST SCRIPT MAY TURN OFF PROCESS ISOLATION", async () => {
  // The mechanism both reporters GUESSED at: several test files sharing one
  // worker process, so a sibling that installs the guard and does not uninstall
  // it changes what this file sees. It is not what happened — `node --test`
  // gives each file its own child process by default — but it is one
  // `--test-isolation=none` away from being true, of this file and of every
  // other suite that touches module-level state.
  //
  // Asserting the ABSENCE of the opt-out rather than pinning the flag is
  // deliberate: the flag is spelled `--experimental-test-isolation` on Node 22
  // (which CI runs) and `--test-isolation` from Node 23, so pinning either name
  // would break one of them, and `process` is already the default on both.
  const pkg = JSON.parse(await readFile(path.join(ROOT, "package.json"), "utf8"));
  for (const [name, cmd] of Object.entries(pkg.scripts)) {
    if (!/--test\b/.test(cmd)) continue;
    assert.doesNotMatch(
      cmd,
      /--(?:experimental-)?test-isolation[= ]none/,
      `the "${name}" script runs every test file in one shared process. Module-level state then leaks ` +
        `between files — including this module's patched prototypes, whose self-test would stop being ` +
        `evidence about the guard and start being evidence about test ordering`
    );
  }
});

test("INSTALLS STACK — an inner guard widens, and uninstalling it narrows back, without double-patching", async () => {
  const supa = await fakeSupabase();
  const outerDepth = liveWriteGuardDepth();
  // This is the shape `liveWriteGuardAuto.mjs` creates: a default-deny policy
  // underneath, and a live file's own narrower one on top. Before installs
  // stacked, the inner guard's write was checked twice — once against its own
  // allow-list and once against the outer's empty one — so a live file could
  // not widen anything and every declared write was refused by the preload.
  const deny = await installLiveWriteGuard({ label: "self-test/stack-outer" });
  const live = await installLiveWriteGuard({ label: "self-test/stack-inner", allow: ["scan_runs"] });
  try {
    assert.equal(liveWriteGuardDepth(), outerDepth + 2);
    assert.equal(activeLiveWriteGuardLabel(), "self-test/stack-inner");

    assert.doesNotThrow(() => supa.from("scan_runs").insert({ runner: "x" }), "the inner policy is in force");
    assert.equal(live.writes.length, 1, "the write is recorded ONCE, on the policy that permitted it");
    assert.equal(deny.writes.length, 0, "…and not a second time on the policy underneath");

    await quiet(() => {
      assert.throws(() => supa.from("probe_tasks").insert({}), LiveWriteRefused);
    });
    assert.equal(live.refusals.length, 1, "a refusal names the innermost policy, not the preload");
    assert.equal(deny.refusals.length, 0);
    reset();

    // Narrow back: the outer default-deny is what a test sees once the live
    // file's guard is gone. It must NOT disarm the process.
    live.uninstall();
    assert.equal(activeLiveWriteGuardLabel(), "self-test/stack-outer");
    await quiet(() => {
      assert.throws(() => supa.from("scan_runs").insert({ runner: "x" }), LiveWriteRefused);
    });
    assert.equal(deny.refusals.length, 1, "the table the inner guard opened is shut again");
  } finally {
    deny.uninstall();
    reset();
  }
});

test("a displaced patch is RE-ARMED on the next install, never left looking installed", async () => {
  const { default: pg } = await import("pg");
  const outer = await installLiveWriteGuard({ label: "self-test/displaced-outer" });
  const seen = [];
  const displaced = pg.Client.prototype.query;
  // Something else stamps on the prototype — exactly what this file's own pg
  // case does with its stub, and what any library that monkey-patches pg would
  // do. Silently leaving the guard un-armed after that is the failure mode the
  // whole module exists to prevent.
  const stub = function (config) {
    seen.push(typeof config === "string" ? config : config.text);
    return Promise.resolve({ rows: [] });
  };
  pg.Client.prototype.query = stub;
  const inner = await installLiveWriteGuard({ label: "self-test/displaced-inner", allow: ["scan_runs"] });
  const client = new pg.Client({ connectionString: "postgres://unused" });
  try {
    assert.notEqual(pg.Client.prototype.query, stub, "the install must patch OVER the replacement");
    await client.query("DELETE FROM scan_runs WHERE runner = $1", ["x"]);
    assert.deepEqual(seen, ["DELETE FROM scan_runs WHERE runner = $1"], "the declared write reaches the driver");
    await quiet(async () => {
      await assert.rejects(() => client.query("DELETE FROM scans"), LiveWriteRefused);
    });
    assert.equal(seen.length, 1, "the guard re-armed over the replacement instead of standing down");
  } finally {
    inner.uninstall();
    outer.uninstall();
    pg.Client.prototype.query = displaced;
    reset();
  }
});

// ---------------------------------------------------------------------------
// Adoption — the part that made the first cut of this module fail review
// ---------------------------------------------------------------------------

test("THE PRELOAD IS WIRED IN — every test script arms the guard, or this fails", async () => {
  // The mechanism was never the problem: the first version of this file passed
  // and six other suites were writing to production anyway, because arming the
  // guard was a line each author had to remember. The arming now lives in one
  // place, so THAT place needs a tripwire. Delete `--import` from package.json
  // and this case says so; without it the suite would just quietly stop being
  // guarded and every test would still pass.
  const { readFile } = await import("node:fs/promises");
  const path = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));

  for (const script of ["test", "test:scoring", "test:live"]) {
    const cmd = pkg.scripts?.[script];
    assert.ok(cmd, `package.json has no "${script}" script`);
    assert.match(
      cmd,
      /--import[= ]\.\/src\/server\/liveWriteGuardAuto\.mjs/,
      `"${script}" must preload src/server/liveWriteGuardAuto.mjs; without it the write guard is armed only ` +
        `in the files that remember to install it by hand, which is how six suites came to be writing ` +
        `to production scan_jobs, content_jobs, content_runs and content_events`
    );
  }

  // test:live is the one that loads real credentials, so it is the one where a
  // dropped preload writes to production rather than merely going unguarded.
  assert.match(
    pkg.scripts["test:live"],
    /--env-file=\.env\.local/,
    "test:live must load the live credentials it exists to supply"
  );
  assert.match(pkg.scripts["test:live"], /--test\b/, "test:live must actually run the test runner");

  const { access } = await import("node:fs/promises");
  await access(path.join(root, "src/server/liveWriteGuardAuto.mjs"));
});

test("THE DOCUMENTED COMMAND IS THE GUARDED ONE — liveDbGate cannot teach the unguarded invocation", async () => {
  // This is the sentence that made the second cut of R3.2.4 fail review. The
  // gate printed `node --env-file=.env.local --test <file>` — no preload — and
  // that was the ONLY way a live test ever ran, because CI has no DATABASE_URL
  // and every gated case skips there. So the preload guarded 1600 tests that
  // could not write and none of the ones that could. A reason string that names
  // an unguarded command is not documentation, it is an instruction to repeat
  // the incident.
  const { readFile } = await import("node:fs/promises");
  const path = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  const { liveDbGate, LIVE_TEST_COMMAND, LIVE_TEST_COMMAND_RAW } = await import("./liveDbGate.js");

  const shut = liveDbGate({});
  assert.equal(shut.enabled, false);
  assert.ok(
    shut.reason.includes(LIVE_TEST_COMMAND) || shut.reason.includes(LIVE_TEST_COMMAND_RAW),
    "the closed gate must tell the author how to open it, and the command it names must be a guarded one"
  );
  assert.match(
    LIVE_TEST_COMMAND_RAW,
    /--import[= ]\.\/src\/server\/liveWriteGuardAuto\.mjs/,
    "the raw command the gate prints must carry the preload"
  );
  assert.match(LIVE_TEST_COMMAND, /npm run test:live/, "the short command must be the npm script");
  assert.ok(pkg.scripts["test:live"], "…and that script must exist");

  // The old, unguarded invocation must not appear anywhere in the reason.
  assert.doesNotMatch(
    shut.reason,
    /node\s+--env-file=\.env\.local\s+--test/,
    "the gate must never print the invocation that runs a live test with no write guard"
  );
});

/**
 * The static half of the rule "asking the gate about the real environment means
 * arming the guard", applied to one file's source text.
 *
 * It used to be the single regex `/\bliveDbGate\s*\(\s*(?:process\.env\s*)?\)/`
 * — an EMPTY argument or a literal `process.env`, and nothing else. R3.2.10:
 * `liveDbGate({ ...process.env })` matched neither, so an offender that spread
 * the real environment into the gate sat in the tree with this suite green
 * while its write reached a real server. Any argument text that MENTIONS
 * `process.env` is now flagged, however it is wrapped — spread, `Object.assign`,
 * `structuredClone`, or one hand-picked key.
 *
 * A mention is not enough on its own, because the copy can be built on an
 * earlier line — `const env = { ...process.env }; liveDbGate(env)` — and the
 * call then names nothing. So the rule is inverted: the ONLY exempt argument is
 * an object LITERAL that does not mention `process.env`. A bare call, a
 * variable, a function call, a clone: all flagged. That is deliberately
 * conservative, and a file that means it can inline the literal or (better) use
 * `armedLiveDbGate`, which arms the guard and needs no exemption at all.
 *
 * What text cannot see at all: a literal built from real values by hand, e.g.
 * `{ DATABASE_URL: url }` where `url` came from the environment three lines up.
 * That is why this is not the last line of defence — `liveDbGate` compares the
 * gate-opening credentials at runtime against the database they name (host and
 * path, so a changed query string or user does not buy an exemption), and a
 * copy that carries them is refused whatever its source text looks like. Text
 * and value each catch what the other misses. What defeats both is a literal
 * built from a variable that spells the same host differently; that is the
 * documented residual, and `armedLiveDbGate` — which arms the guard first — is
 * the reason no live file has to come near it.
 *
 * @param {string} src a file's source text
 * @returns {string|null} the offending call, or null
 */
function gateCallOnRealEnv(src) {
  for (const m of src.matchAll(/\bliveDbGate\s*\(([^)]*)/g)) {
    const arg = m[1].trim();
    const isOwnLiteral = arg.startsWith("{") && !/\bprocess\.env\b/.test(arg);
    if (!isOwnLiteral) return `liveDbGate(${arg})`;
  }
  return null;
}

test("THE STATIC RULE CATCHES A COPY OF THE REAL ENVIRONMENT — planted offenders, not just live ones", () => {
  // R3.2.10 was proven by planting a file that spread `process.env` into the
  // gate and watching this suite stay 21/21 green while the write landed. The
  // offenders are planted here as source text so the rule is exercised on every
  // run, instead of once by the person who found it.
  const OFFENDERS = [
    "const GATE = liveDbGate();",
    "const GATE = liveDbGate(process.env);",
    "const GATE = liveDbGate({ ...process.env });",
    "const GATE = liveDbGate({...process.env, DATABASE_URL: process.env.DATABASE_URL});",
    "const GATE = liveDbGate(Object.assign({}, process.env));",
    "const GATE = liveDbGate(structuredClone(process.env));",
    "const GATE = liveDbGate({ DATABASE_URL: process.env.DATABASE_URL });",
    // The two-step copy, which mentions nothing at the call site. Flagged
    // because the only exempt argument is an object literal of your own values.
    "const env = { ...process.env };\nconst GATE = liveDbGate(env);",
    "const GATE = liveDbGate(env);",
    "const GATE = liveDbGate(readEnv());",
  ];
  for (const offender of OFFENDERS) {
    assert.ok(
      gateCallOnRealEnv(offender),
      `the rule must flag \`${offender}\` — it hands the gate the real credentials, and a live test that ` +
        `forgets one stub then writes to production`
    );
  }

  // …and the escape hatch survives: an env object of the caller's OWN values
  // opens no database, and src/server/probeQueue.test.mjs plus this file depend on
  // being able to ask the question that way.
  const EXEMPT = [
    "assert.equal(liveDbGate({}).enabled, false);",
    'liveDbGate({ DATABASE_URL: "postgres://x" });',
    'liveDbGate({ SUPABASE_DB_PASSWORD: "p", NEXT_PUBLIC_SUPABASE_URL: "https://x.supabase.co" });',
  ];
  for (const fine of EXEMPT) {
    assert.equal(
      gateCallOnRealEnv(fine),
      null,
      `the rule must not flag \`${fine}\`: it names no real credential, so it opens nothing`
    );
  }

});

test("META — every file that imports the live gate arms the write guard", async () => {
  // The analogue of the assertion at src/server/scanRuns.test.mjs:658, which
  // enforces "a live test must use the SHARED gate". Nothing enforced "…and it
  // must arm the guard", so the three live files were safe only because their
  // authors remembered a second line — the exact "convention the next author
  // has to remember rather than a property of the harness" this task is about.
  //
  // The rule: importing the gate module and asking it about the REAL
  // environment means you are about to run against a real database, and that
  // is only allowed through `armedLiveDbGate`, which installs the default-deny
  // guard before it answers. Asking about an explicit env object of your own
  // values (as the gate's own unit test does) is exempt, because it opens
  // nothing — but a COPY of the real environment is not an explicit env object,
  // it is the real one with a different identity, and it is flagged (R3.2.10).
  const { readFile, readdir } = await import("node:fs/promises");
  const path = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const SRC = path.join(root, "src");

  async function walk(dir) {
    const out = [];
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      // worker/ is its own npm workspace: a `worker/node_modules` on disk is
      // full of vendors' README examples (`.from("avatars")`, `very_big_table`),
      // none of which is a table this app touches.
      if (e.isDirectory() && e.name === "node_modules") continue;
      if (e.isDirectory()) out.push(...(await walk(full)));
      else if (/\.(mjs|js|jsx)$/.test(e.name)) out.push(full);
    }
    return out;
  }

  const files = await walk(SRC);
  const importers = [];
  for (const file of files) {
    const rel = path.relative(root, file).split(path.sep).join("/");
    if (rel === "src/server/liveDbGate.js") continue;
    const src = await readFile(file, "utf8");
    // A real import of the gate module — static or dynamic — not a mention of
    // its name in a comment.
    if (!/(?:from|import\()\s*["'][^"']*liveDbGate\.js["']/.test(src)) continue;
    importers.push({ rel, src });
  }

  assert.ok(
    importers.length >= 4,
    `expected the three live files plus the gate's own unit test to import the gate; found ${importers.length}`
  );

  // This file. It calls `armedLiveDbGate` to TEST it, with explicit env objects
  // and a fake client, and never against a real database — so it belongs in
  // neither column of the inventory below. Named here rather than pattern-
  // matched, so adding a second exemption is a visible act.
  const EXERCISES_THE_GATE_ITSELF = new Set([
    "src/server/liveWriteGuard.test.mjs",
    "src/server/liveWriteGuardAdoption.test.mjs",
  ]);

  const armed = [];
  for (const { rel, src } of importers) {
    const usesArmedGate = /\barmedLiveDbGate\s*\(/.test(src);
    // `liveDbGate()`, `liveDbGate(process.env)`, or any copy of it — see
    // gateCallOnRealEnv above for why the copy forms count (R3.2.10).
    const asksTheRealEnv = gateCallOnRealEnv(src);

    if (usesArmedGate) {
      if (!EXERCISES_THE_GATE_ITSELF.has(rel)) armed.push(rel);
      continue;
    }
    assert.ok(
      !asksTheRealEnv,
      `${rel} calls ${asksTheRealEnv} on the real environment without arming the write guard. ` +
        `A live test that forgets one stub writes to production — use ` +
        `armedLiveDbGate({ label: "${rel}", allow: [...] }), which installs the default-deny guard ` +
        `before it tells you whether the gate is open.`
    );
  }

  // Not merely "nobody broke the rule": the files that DO run live must be
  // named, so an empty list cannot read as a clean result (standing rule 1).
  assert.deepEqual(
    armed.sort(),
    [
      "src/server/probeTasksRace.test.mjs",
      "src/server/scanRunsLive.test.mjs",
      // R3.3.5 — close_scan_run double-close and the reaper race; declares only scan_runs.
      "src/server/workers/reaperCloseLive.test.mjs",
      "src/server/workers/scanChunkLedgerLive.test.mjs",
    ],
    "every live-DB test file, and only those, opens the gate through armedLiveDbGate"
  );
});

test("THE GATE REFUSES TO OPEN UNGUARDED — a live database with no guard armed throws", async () => {
  // The tripwire for the author who copies the old two-line pattern instead of
  // calling armedLiveDbGate. Run in a child process, because this process is
  // guarded (the preload, or this file's own installs) and the property is
  // about a process that is not.
  const { execFileSync } = await import("node:child_process");
  const path = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

  const script =
    'const { liveDbGate } = await import("./src/server/liveDbGate.js");' +
    "try { liveDbGate(); console.log('OPENED-UNGUARDED'); }" +
    " catch (e) { console.log('THREW: ' + e.message.split('.')[0]); }";

  const out = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    env: {
      ...process.env,
      DATABASE_URL: "postgresql://nobody:nobody@127.0.0.1:1/postgres",
      NODE_OPTIONS: "",
    },
  });

  assert.match(
    out,
    /THREW: liveDbGate: a live database is configured and NO live-write guard is armed/,
    `an unguarded process with DATABASE_URL set must refuse to report an open gate; got: ${out.trim()}`
  );
  assert.doesNotMatch(out, /OPENED-UNGUARDED/);
});

test("THE GATE REFUSES A COPY OF THE REAL ENVIRONMENT — the spread that defeated the identity check", async () => {
  // R3.2.10. The check above was `env === process.env`, and the R3.2.4 verifier
  // defeated it by writing `liveDbGate({ ...process.env })`: a copy fails the
  // identity test, the gate opened on an unguarded process, and the write
  // reached a real server, exit 0, green. Measured then, and re-measured before
  // this fix: the bare/literal/alias forms threw, while spread, Object.assign,
  // a two-step copy and a hand-picked DATABASE_URL all OPENED.
  //
  // Same child-process shape as the case above, for the same reason: this
  // process is guarded, and the property is about one that is not.
  const { execFileSync } = await import("node:child_process");
  const path = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

  const FORMS = {
    spread: "liveDbGate({ ...process.env })",
    assign: "liveDbGate(Object.assign({}, process.env))",
    clone: "liveDbGate(structuredClone(process.env))",
    "two-step": "(() => { const env = { ...process.env }; return liveDbGate(env); })()",
    "hand-picked": "liveDbGate({ DATABASE_URL: process.env.DATABASE_URL })",
    alias: "(() => { const env = process.env; return liveDbGate(env); })()",
    // The two that defeated the first cut of this fix, which compared strings:
    // a decorated URL and a different login are a different string and the same
    // production database, so the comparison is on host and path.
    mutated: "liveDbGate({ DATABASE_URL: process.env.DATABASE_URL + '?application_name=x' })",
    "same host, other login": "liveDbGate({ DATABASE_URL: 'postgresql://other:other@127.0.0.1:1/postgres' })",
  };

  for (const [name, call] of Object.entries(FORMS)) {
    const script =
      'const { liveDbGate } = await import("./src/server/liveDbGate.js");' +
      `try { ${call}; console.log('OPENED-UNGUARDED'); }` +
      " catch (e) { console.log('THREW: ' + e.message.split('.')[0]); }";

    const out = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      env: {
        ...process.env,
        DATABASE_URL: "postgresql://nobody:nobody@127.0.0.1:1/postgres",
        NODE_OPTIONS: "",
      },
    });

    assert.match(
      out,
      /THREW: liveDbGate: a live database is configured and NO live-write guard is armed/,
      `the ${name} form of the real environment must be refused like the real environment; got: ${out.trim()}`
    );
    assert.doesNotMatch(out, /OPENED-UNGUARDED/, `the ${name} form opened the gate on an unguarded process`);
  }

  // The escape hatch still works, or probeQueue.test.mjs and this file's own
  // self-tests could not ask the gate anything: an env of the caller's OWN
  // values names no live credential and opens no database.
  const hatch =
    'const { liveDbGate } = await import("./src/server/liveDbGate.js");' +
    "const g = liveDbGate({ DATABASE_URL: 'postgres://someone-elses-value' });" +
    "console.log('EXEMPT enabled=' + g.enabled);";
  const hatchOut = execFileSync(process.execPath, ["--input-type=module", "-e", hatch], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    env: {
      ...process.env,
      DATABASE_URL: "postgresql://nobody:nobody@127.0.0.1:1/postgres",
      NODE_OPTIONS: "",
    },
  });
  assert.match(
    hatchOut,
    /EXEMPT enabled=true/,
    `an explicit env object of the caller's own values must still answer the question without arming: ${hatchOut.trim()}`
  );
});

test("armedLiveDbGate ARMS BEFORE IT ANSWERS, and declares nothing by default", async () => {
  const { armedLiveDbGate } = await import("./liveDbGate.js");
  const depthBefore = liveWriteGuardDepth();

  const gate = await armedLiveDbGate({ label: "self-test/armed-gate", env: {} });
  try {
    assert.equal(liveWriteGuardDepth(), depthBefore + 1, "asking the gate must have installed a guard");
    assert.equal(activeLiveWriteGuardLabel(), "self-test/armed-gate");
    assert.deepEqual(gate.guard.allowed, [], "allow defaults to nothing: a table nobody named is refused");
    assert.equal(gate.enabled, false, "an empty env is a shut gate");
    assert.match(gate.reason, /no live Postgres configured/, "a shut gate hands every case its reason");

    const client = await fakeSupabase();
    await quiet(async () => {
      assert.throws(() => client.from("scan_runs").insert({ x: 1 }), LiveWriteRefused);
    });
  } finally {
    gate.guard.uninstall();
    reset();
  }

  const open = await armedLiveDbGate({
    label: "self-test/armed-gate-open",
    allow: ["scan_runs"],
    env: { DATABASE_URL: "postgresql://nobody@127.0.0.1:1/postgres" },
  });
  try {
    assert.equal(open.enabled, true);
    assert.equal(open.reason, null, "an open gate has nothing to explain");
    assert.deepEqual(open.guard.allowed, ["scan_runs"]);
    assert.equal(open.guard.covers.supabase, true, "an open gate behind a blind guard is not an open gate");
    assert.equal(open.guard.covers.pg, true);
  } finally {
    open.guard.uninstall();
    reset();
  }

  await assert.rejects(
    () => armedLiveDbGate({ allow: ["scan_runs"], env: {} }),
    /needs a label/,
    "a refusal that cannot name its file is not much of a refusal"
  );
});

test("THE PRELOAD'S POLICY DECLARES NOTHING — every table is refused under it", async () => {
  const depthBefore = liveWriteGuardDepth();
  const auto = (await import("./liveWriteGuardAuto.mjs")).default;
  // Under `npm run test:scoring` the module is already loaded and this import
  // is a cache hit that installs nothing; run this file bare and the import
  // installs it here. Tell the two apart rather than uninstalling something
  // that was not ours.
  const installedHere = liveWriteGuardDepth() > depthBefore;
  try {
    assert.deepEqual(auto.allowed, [], "the automatic policy opens no table at all");
    assert.match(auto.label, /^auto:/, "refusals must name the entry file that caused them");
    assert.equal(auto.covers.supabase, true, "…and it must actually be armed, not merely constructed");
    assert.equal(auto.covers.pg, true);
  } finally {
    if (installedHere) auto.uninstall();
  }
});

test("SELF-TEST RESIDUE — this file leaves no refusal on the record", () => {
  assert.deepEqual(liveWriteRefusals(), [], "a self-test that provokes refusals must clear its own");
  assert.notEqual(process.exitCode, 1, "…and must not leave the process marked failed");
});
