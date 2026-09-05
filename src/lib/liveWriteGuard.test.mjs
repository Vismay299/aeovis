import test from "node:test";
import assert from "node:assert/strict";

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

test("uninstall restores both prototypes — once the LAST guard goes", async () => {
  const { default: pg } = await import("pg");
  const { createClient, SupabaseClient } = await import("@supabase/supabase-js");
  const beforeFrom = SupabaseClient.prototype.from;
  const beforeQuery = pg.Client.prototype.query;

  // `npm run test:scoring` preloads liveWriteGuardAuto.mjs, so there is already
  // a policy on the stack; run this file bare and there is not. Both are
  // legitimate, and the assertion below is different in each, so measure rather
  // than assume — an unconditional "the prototype is clean again" would be
  // wrong under the preload and an unconditional "it is still patched" would be
  // wrong without it.
  const outer = liveWriteGuardDepth();

  const guard = await installLiveWriteGuard({ label: "self-test/restore", allow: ["scan_runs"] });
  assert.equal(liveWriteGuardDepth(), outer + 1);
  guard.uninstall();
  assert.equal(liveWriteGuardDepth(), outer, "uninstall removes exactly one policy");

  if (outer === 0) {
    assert.equal(SupabaseClient.prototype.from, beforeFrom, "the last uninstall restores from()");
    assert.equal(pg.Client.prototype.query, beforeQuery, "…and query()");
  } else {
    // Still ARMED, which is the property that matters — not that the very same
    // function object is back on the prototype. An install may legitimately
    // have re-patched over something that displaced the guard, so identity is
    // the wrong question here; behaviour is the right one.
    const supa = await fakeSupabase();
    await quiet(() => {
      assert.throws(
        () => supa.from("scan_runs").insert({ runner: "x" }),
        LiveWriteRefused,
        "an inner uninstall must not disarm the process while an outer guard is still installed"
      );
    });
    reset();
    assert.notEqual(
      activeLiveWriteGuardLabel(),
      "self-test/restore",
      "and the enclosing guard's policy is in force again"
    );
    assert.ok(beforeFrom && beforeQuery, "both prototypes were patched before this case ran");
  }
  assert.ok(typeof createClient === "function");
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
      /--import[= ]\.\/src\/lib\/liveWriteGuardAuto\.mjs/,
      `"${script}" must preload src/lib/liveWriteGuardAuto.mjs; without it the write guard is armed only ` +
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
  await access(path.join(root, "src/lib/liveWriteGuardAuto.mjs"));
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
    /--import[= ]\.\/src\/lib\/liveWriteGuardAuto\.mjs/,
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

test("META — every file that imports the live gate arms the write guard", async () => {
  // The analogue of the assertion at src/lib/scanRuns.test.mjs:658, which
  // enforces "a live test must use the SHARED gate". Nothing enforced "…and it
  // must arm the guard", so the three live files were safe only because their
  // authors remembered a second line — the exact "convention the next author
  // has to remember rather than a property of the harness" this task is about.
  //
  // The rule: importing the gate module and asking it about the REAL
  // environment means you are about to run against a real database, and that
  // is only allowed through `armedLiveDbGate`, which installs the default-deny
  // guard before it answers. Asking about an explicit env object (as the gate's
  // own unit test does) is exempt, because it opens nothing.
  const { readFile, readdir } = await import("node:fs/promises");
  const path = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const SRC = path.join(root, "src");

  async function walk(dir) {
    const out = [];
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) out.push(...(await walk(full)));
      else if (/\.(mjs|js|jsx)$/.test(e.name)) out.push(full);
    }
    return out;
  }

  const files = await walk(SRC);
  const importers = [];
  for (const file of files) {
    const rel = path.relative(root, file).split(path.sep).join("/");
    if (rel === "src/lib/liveDbGate.js") continue;
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
  const EXERCISES_THE_GATE_ITSELF = new Set(["src/lib/liveWriteGuard.test.mjs"]);

  const armed = [];
  for (const { rel, src } of importers) {
    const usesArmedGate = /\barmedLiveDbGate\s*\(/.test(src);
    // `liveDbGate()` / `liveDbGate(process.env)` — the real environment.
    const asksTheRealEnv = /\bliveDbGate\s*\(\s*(?:process\.env\s*)?\)/.test(src);

    if (usesArmedGate) {
      if (!EXERCISES_THE_GATE_ITSELF.has(rel)) armed.push(rel);
      continue;
    }
    assert.ok(
      !asksTheRealEnv,
      `${rel} calls liveDbGate() on the real environment without arming the write guard. ` +
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
      "src/lib/probeTasksRace.test.mjs",
      "src/lib/scanRunsLive.test.mjs",
      "src/lib/workers/scanChunkLedgerLive.test.mjs",
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
    'const { liveDbGate } = await import("./src/lib/liveDbGate.js");' +
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
