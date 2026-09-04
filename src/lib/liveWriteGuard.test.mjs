import test from "node:test";
import assert from "node:assert/strict";

import {
  installLiveWriteGuard,
  classifyStatement,
  liveWriteRefusals,
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

test("AN UNKNOWN TABLE CANNOT BE OPTED INTO EITHER — widening is a diff, not a call site", async () => {
  await assert.rejects(
    () => installLiveWriteGuard({ label: "self-test/unknown", allow: ["some_new_ledger"] }),
    /not a table a live test may write/
  );
  assert.deepEqual([...WRITABLE_BY_OPT_IN], ["scan_runs", "probe_tasks"]);
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
    for (const fn of ["open_scan_run", "heartbeat_scan_run", "close_scan_run", "claim_probe_tasks"]) {
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

test("uninstall really restores both prototypes", async () => {
  const { default: pg } = await import("pg");
  const { createClient } = await import("@supabase/supabase-js");
  const beforeFrom = (await import("@supabase/supabase-js")).SupabaseClient.prototype.from;
  const beforeQuery = pg.Client.prototype.query;
  const guard = await installLiveWriteGuard({ label: "self-test/restore", allow: ["scan_runs"] });
  guard.uninstall();
  const { SupabaseClient } = await import("@supabase/supabase-js");
  assert.equal(SupabaseClient.prototype.from, beforeFrom);
  assert.equal(pg.Client.prototype.query, beforeQuery);
  assert.ok(typeof createClient === "function");
});

test("SELF-TEST RESIDUE — this file leaves no refusal on the record", () => {
  assert.deepEqual(liveWriteRefusals(), [], "a self-test that provokes refusals must clear its own");
  assert.notEqual(process.exitCode, 1, "…and must not leave the process marked failed");
});
