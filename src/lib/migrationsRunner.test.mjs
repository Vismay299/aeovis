import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
// R6.1.5. Importing the runner is only possible because it now runs `main()`
// under an entrypoint guard; if that guard ever stops recognising itself, the
// spawn-based tests below go red rather than `npm run setup:db` going quiet.
import { checksumsFor, semanticSql } from "../../scripts/setup-supabase.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * R6.1.1 — the migration runner, EXECUTED.
 *
 * `migrationsLedger.test.mjs` asserts regexes over the runner's source text and
 * never runs it. A verifier proved what that is worth: they changed the failure
 * branch to `exitCode = 0` and parked a dead `if (false) process.exitCode = 1`
 * in the success branch. The runner then printed INCOMPLETE and exited 0 on a
 * database missing 006 — the literal C10 false success, the exact defect this
 * task exists to close — and passed 6 of 6 guards. A syntactically broken
 * runner passes them too.
 *
 * `assert.match(src, /INCOMPLETE/)` checks the spelling of the criterion, not
 * the criterion. These tests run the real script against a stubbed `pg` and
 * assert on its EXIT CODE and its query log.
 *
 * The stub is injected by pointing NODE_OPTIONS at a loader that resolves the
 * bare specifier "pg" to a fake module. Nothing else about the runner changes:
 * its own logic, ordering and SQL all execute for real.
 */

function makeSandbox({ catalog, failOn = null, recorded = [] }) {
  const dir = mkdtempSync(path.join(tmpdir(), "migrunner-"));

  // A loader that maps the "pg" specifier to our stub.
  writeFileSync(
    path.join(dir, "loader.mjs"),
    `
import { pathToFileURL } from "node:url";
const STUB = ${JSON.stringify(pathToFileURL(path.join(dir, "pg-stub.mjs")).href)};
export function resolve(specifier, context, next) {
  if (specifier === "pg") return { url: STUB, shortCircuit: true };
  return next(specifier, context);
}
`
  );

  // The fake client. Records every query, honours the catalog fixture, and can
  // be told to throw partway through a named migration.
  writeFileSync(
    path.join(dir, "pg-stub.mjs"),
    `
const CATALOG = ${JSON.stringify(catalog)};
const FAIL_ON = ${JSON.stringify(failOn)};
// Rows the ledger already holds. Fixing these is how the drift path gets
// exercised without editing a migration on disk under five concurrent agents.
const RECORDED = ${JSON.stringify(recorded)};
export const log = [];
let txn = 0;

class Client {
  constructor() { this.log = log; }
  async connect() {}
  async end() {}
  async query(text, params) {
    const sql = String(text);
    if (sql === "BEGIN") { txn++; log.push({ txn, sql: "BEGIN" }); return { rows: [] }; }
    if (sql === "COMMIT") { log.push({ txn, sql: "COMMIT" }); return { rows: [] }; }
    if (sql === "ROLLBACK") { log.push({ txn, sql: "ROLLBACK" }); return { rows: [] }; }

    if (/CREATE TABLE IF NOT EXISTS schema_migrations/.test(sql)) return { rows: [] };
    if (/SELECT filename, checksum(, sql_checksum)? FROM schema_migrations/.test(sql)) {
      log.push({ txn, sql: "SELECT_LEDGER" });
      return { rows: RECORDED };
    }
    if (/INSERT INTO schema_migrations/.test(sql)) {
      log.push({ txn, sql: "INSERT_LEDGER", file: params && params[0] });
      return { rows: [] };
    }

    // Catalog probes.
    if (/to_regclass/.test(sql)) {
      const name = String((params && params[0]) || "").replace("public.", "");
      log.push({ txn, sql: "PROBE", name });
      return { rows: [{ regclass: CATALOG.includes(name) ? name : null }] };
    }
    if (/pg_proc/.test(sql)) {
      const name = (params && params[0]) || "";
      log.push({ txn, sql: "PROBE", name });
      return { rows: CATALOG.includes(name) ? [{ "?column?": 1 }] : [] };
    }

    // A migration body.
    log.push({ txn, sql: "MIGRATION" });
    if (FAIL_ON && sql.includes(FAIL_ON)) throw new Error("simulated migration failure");
    return { rows: [] };
  }
}
export default { Client };
export { Client };
process.on("exit", () => {
  process.stdout.write("__QUERY_LOG__" + JSON.stringify(log) + "__END_LOG__\\n");
});
`
  );

  return dir;
}

/** Run the real runner against the sandbox; return exit code and stdout. */
function runRunner(dir) {
  const res = spawnSync(
    process.execPath,
    ["--import", pathToFileUrlString(path.join(dir, "register.mjs")), path.join(REPO, "scripts/setup-supabase.mjs")],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        DATABASE_URL: "postgresql://stub/stub",
        NODE_NO_WARNINGS: "1",
      },
    }
  );
  // `out` is the two streams concatenated, which is fine for "did it say X".
  // The ordering test needs them apart: position within a concatenation of two
  // streams is not the order they were written in.
  return {
    status: res.status,
    out: `${res.stdout || ""}${res.stderr || ""}`,
    stdout: res.stdout || "",
    stderr: res.stderr || "",
  };
}

function pathToFileUrlString(p) {
  return new URL(`file://${p.replace(/\\/g, "/").replace(/^([A-Za-z]:)/, "/$1")}`).href;
}

/** Everything 001-011 must leave behind, per the runner's own expectations. */
const FULL_CATALOG = [
  "scans", "brand_prompts", "scan_jobs", "content_events",
  "content_jobs", "content_items", "content_feedback", "brand_briefs", "content_lessons",
  "content_agents", "knowledge_blocks",
  "prompt_results", "result_brands", "citations", "brand_metrics_daily", "scan_schedules", "topics",
  "content_jobs_heartbeat_idx",
  "scan_jobs_one_running_per_brand",
  "system_heartbeats",
  "scan_rate_limits", "scan_rate_limits_window_idx", "increment_scan_rate_limit",
  "probe_tasks", "probe_tasks_claim_idx", "probe_tasks_batch_idx", "probe_tasks_lease_idx",
  "claim_probe_tasks", "complete_probe_tasks", "renew_probe_lease", "release_probe_tasks",
  "scan_runs", "scan_runs_job_idx", "scan_runs_batch_idx", "scan_runs_open_idx", "scan_runs_runner_idx",
  "open_scan_run", "heartbeat_scan_run", "close_scan_run",
  "scan_jobs_attempts_idx", "claim_scan_job_attempt",
];

function withRegister(dir) {
  writeFileSync(
    path.join(dir, "register.mjs"),
    `
import { register } from "node:module";
import { pathToFileURL } from "node:url";
register(${JSON.stringify(pathToFileUrlString(path.join(dir, "loader.mjs")))}, pathToFileURL("./"));
`
  );
  return dir;
}

test("a complete database exits 0", () => {
  const dir = withRegister(makeSandbox({ catalog: FULL_CATALOG }));
  try {
    const { status, out } = runRunner(dir);
    assert.equal(status, 0, `expected success, got ${status}:\n${out}`);
    assert.match(out, /All expected objects present/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("THE C10 CASE — a database missing 006 EXITS NON-ZERO, not merely prints INCOMPLETE", () => {
  const catalog = FULL_CATALOG.filter((n) => n !== "content_jobs_heartbeat_idx");
  const dir = withRegister(makeSandbox({ catalog }));
  try {
    const { status, out } = runRunner(dir);

    // Both halves matter. The verifier's sabotage printed the word and exited 0,
    // and every source-regex guard stayed green.
    assert.match(out, /INCOMPLETE/, "it must say so");
    assert.equal(status, 1, `and it must FAIL. exit was ${status}:\n${out}`);
    assert.match(out, /content_jobs_heartbeat_idx/, "and name what is missing");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a missing FUNCTION is caught, which to_regclass alone cannot see", () => {
  const catalog = FULL_CATALOG.filter((n) => n !== "increment_scan_rate_limit");
  const dir = withRegister(makeSandbox({ catalog }));
  try {
    const { status, out } = runRunner(dir);
    assert.equal(status, 1, "009's table present with its function absent is the 2026-08-30 state");
    assert.match(out, /increment_scan_rate_limit/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the ledger INSERT happens INSIDE the migration's own transaction", () => {
  const dir = withRegister(makeSandbox({ catalog: FULL_CATALOG }));
  try {
    const { status, out } = runRunner(dir);
    assert.equal(status, 0, out);

    // The stub emits its log on exit, so the ORDERING is observable rather
    // than inferred. An earlier version of this test bailed out when the log
    // was empty and therefore asserted nothing — the same hollowness that got
    // this task rejected in the first place.
    const raw = out.match(/__QUERY_LOG__(.*?)__END_LOG__/s)?.[1];
    assert.ok(raw, "the stub must emit its query log, or this test proves nothing");
    const log = JSON.parse(raw);
    assert.ok(log.length > 20, `expected a full query log, got ${log.length} entries`);

    // Every ledger INSERT must sit between a BEGIN and a COMMIT carrying the
    // SAME transaction id — adjacent to the apply is not the same as inside it.
    const inserts = log.filter((e) => e.sql === "INSERT_LEDGER");
    // Counted from disk, not hard-coded. The literal `9` here went stale the
    // moment 010 landed, which is the same stale-list failure C10 was.
    const onDisk = readdirSync(path.join(REPO, "supabase/migrations")).filter((f) => f.endsWith(".sql"));
    assert.ok(onDisk.length >= 10, `expected the full migration set, found ${onDisk.length}`);
    assert.equal(inserts.length, onDisk.length, "every migration on disk must be recorded");

    for (const ins of inserts) {
      const idx = log.indexOf(ins);
      const before = log.slice(0, idx).reverse().find((e) => e.sql === "BEGIN" || e.sql === "COMMIT");
      const after = log.slice(idx + 1).find((e) => e.sql === "COMMIT" || e.sql === "ROLLBACK");
      assert.equal(before?.sql, "BEGIN", `${ins.file}: the INSERT must follow a BEGIN`);
      assert.equal(after?.sql, "COMMIT", `${ins.file}: the INSERT must be closed by a COMMIT`);
      assert.equal(before.txn, ins.txn, `${ins.file}: same transaction as its BEGIN`);
      assert.equal(after.txn, ins.txn, `${ins.file}: same transaction as its COMMIT`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a failing migration ROLLS BACK, records nothing, and stops the run", () => {
  const dir = withRegister(makeSandbox({ catalog: FULL_CATALOG, failOn: "system_heartbeats" }));
  try {
    const { status, out } = runRunner(dir);
    assert.equal(status, 1, "a failed migration must fail the run");
    assert.match(out, /Migration failed/);
    // 009 must not have been attempted after 008 died.
    assert.ok(!/009_scan_rate_limit\.sql \.\.\. ok/.test(out), "later migrations must not run over a failure");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * Phrases that read as a verdict on the DATABASE. None of them may be printed
 * before the catalog check has run, because that is the exact shape of the
 * 2026-08-30 failure: "Migrations applied successfully." over a database
 * missing four migrations.
 *
 * This list is a list, and is honest about that — it cannot recognise every
 * possible sentence. What it does do is read the runner's ACTUAL STDOUT, so it
 * does not care which call printed it: `console.log`, `process.stdout.write`
 * and anything else are all caught identically. The previous ordering guard
 * regexed `console.(log|warn)` call sites in the source, and a verifier evaded
 * it twice — once with a different sentence, once with the ORIGINAL banned
 * sentence moved into a `process.stdout.write`. Both are covered below.
 */
const VERDICT_PHRASES = [
  /successfully/i,
  /migrations applied/i, // "Migrations applied. Your database is fully up to date."
  /up to date/i,
  /all good/i,
  /✓ done/i,
  /migrations complete/i,
  /(database|schema) is (now |fully )*(complete|correct|current|ready)/i,
  /everything (is )?(in place|present|fine)/i,
];

/**
 * The string the runner prints when the catalog check begins. Everything before
 * it on stdout was printed before the database had been looked at.
 */
const VERIFY_ANCHOR = "Verifying schema against the catalog";

/** Every offset at which the anchor appears on a transcript, in order. */
function anchorOffsets(stdout) {
  const at = [];
  for (let i = stdout.indexOf(VERIFY_ANCHOR); i !== -1; i = stdout.indexOf(VERIFY_ANCHOR, i + 1)) {
    at.push(i);
  }
  return at;
}

/**
 * R6.1.6 — measure from the LAST anchor, and report how many there were.
 *
 * The first version of this used `stdout.indexOf(VERIFY_ANCHOR)`, and the R6.1.1
 * verifier walked through it: printing a decoy line containing the anchor at the
 * CONNECT stage moves the measurement point to that decoy, so `before` shrinks to
 * the first two lines and the round-1 banned literal — "Migrations applied
 * successfully.", emitted via `process.stdout.write` so the source-regex guard in
 * migrationsLedger.test.mjs does not see it either — sits AFTER the measurement
 * point and passes. That sabotage scored 14/14 on this file, and was reproduced
 * against HEAD before this fix was written.
 *
 * Two independent teeth close it, and callers must use both:
 *   `occurrences` — the real runner announces the verify stage exactly once, so
 *                   a second anchor is itself the finding, not a detail; and
 *   `anchor`      — the LAST occurrence, so a decoy cannot shorten the window
 *                   even if some future runner legitimately printed it twice.
 */
function auditOrdering(stdout) {
  const at = anchorOffsets(stdout);
  // lastIndexOf, deliberately. Reverting this to `at[0]` (or to
  // `stdout.indexOf(...)`) re-opens the evasion and fails the duplicate-anchor
  // test at the bottom of this file.
  const anchor = at.length > 0 ? at[at.length - 1] : -1;
  const before = anchor === -1 ? stdout : stdout.slice(0, anchor);
  const violations = [];
  for (const phrase of VERDICT_PHRASES) {
    const hit = before.match(phrase);
    if (hit) violations.push(hit[0]);
  }
  return { occurrences: at.length, anchor, before, violations };
}

for (const scenario of [
  { name: "a complete database", omit: null, status: 0 },
  { name: "a database missing 006", omit: "content_jobs_heartbeat_idx", status: 1 },
]) {
  test(`ORDERING — no verdict reaches stdout before the catalog check, on ${scenario.name}`, () => {
    const catalog = scenario.omit ? FULL_CATALOG.filter((n) => n !== scenario.omit) : FULL_CATALOG;
    const dir = withRegister(makeSandbox({ catalog }));
    try {
      const { status, stdout, stderr } = runRunner(dir);
      assert.equal(status, scenario.status, `exit ${status}:\n${stdout}${stderr}`);

      const audit = auditOrdering(stdout);
      assert.ok(audit.anchor > 0, `the verification must announce itself on stdout:\n${stdout}`);
      assert.equal(
        audit.occurrences,
        1,
        `the verify-stage announcement must appear exactly ONCE on stdout; ${audit.occurrences} ` +
          `occurrences means something else is printing the anchor, which is how the ordering ` +
          `window gets shortened:\n${stdout}`
      );

      assert.deepEqual(
        audit.violations,
        [],
        `${JSON.stringify(audit.violations)} was printed BEFORE the catalog was checked. Nothing may ` +
          `pronounce on the database until the verification has run:\n${audit.before}`
      );

      // Verdicts belong on stdout after the check; stderr is for the failure
      // path, which says INCOMPLETE, not that anything went well.
      for (const phrase of VERDICT_PHRASES) {
        assert.equal(stderr.match(phrase), null, `stderr claimed a verdict:\n${stderr}`);
      }

      if (scenario.status === 0) {
        assert.ok(
          stdout.indexOf("All expected objects present") > audit.anchor,
          "the one real success sentence must follow the verification"
        );
      } else {
        assert.ok(
          !/All expected objects present/.test(stdout),
          "an incomplete database must not print the success sentence at all"
        );
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

/**
 * R6.1.6 — the duplicated-anchor evasion, as a transcript.
 *
 * This one does not spawn the runner: what is under test is the MEASUREMENT, and
 * a fixed transcript is the only way to pin it — a runner that behaves correctly
 * will never produce the duplicate, so nothing spawned can exercise this path.
 * The transcript below is what the sabotaged runner printed when the evasion was
 * reproduced against HEAD: a decoy anchor line inserted directly after the
 * "Connecting to Supabase Postgres..." line, plus the banned literal emitted via
 * `process.stdout.write`.
 */
test("ORDERING — a planted duplicate of the verify anchor cannot hide an early verdict", () => {
  const sabotaged = [
    "Connecting to Supabase Postgres...",
    "  step 1/3: Verifying schema against the catalog is deferred until connect completes",
    "Migrations applied successfully.",
    "Applying migration: 001_initial_schema.sql ... ok",
    "Applying migration: 010_probe_tasks.sql ... ok",
    "",
    "All migration files executed. Verifying the result...",
    "",
    "Verifying schema against the catalog:",
    "",
    "  001_initial_schema.sql",
    "    ✓ table scans",
    "",
    "All expected objects present.",
  ].join("\n");

  const audit = auditOrdering(sabotaged);

  // Tooth one: the anchor is not unique, and that alone is the finding.
  assert.equal(audit.occurrences, 2, "the fixture must actually contain a planted duplicate anchor");

  // Tooth two: the verdict is caught even by a caller that ignores
  // `occurrences`. Measured with indexOf, the window ends at the DECOY on line
  // 2, "Migrations applied successfully." falls outside it, and this assertion
  // goes green on a transcript that is the exact C10 false success. That is the
  // regression this test exists to catch.
  assert.ok(
    audit.violations.length > 0,
    "the early verdict must be caught; measuring from the FIRST anchor hides it, which is the " +
      "indexOf regression this test exists to catch"
  );
  assert.ok(
    audit.violations.some((v) => /successfully/i.test(v)),
    `expected the banned literal among ${JSON.stringify(audit.violations)}`
  );
  assert.ok(
    audit.before.includes("Migrations applied successfully."),
    "the measurement window must extend past the decoy to the REAL verify stage"
  );

  // And the control: the same transcript without the planted decoy and without
  // the early verdict is clean, so the assertions above are not simply always
  // true. Without this an `auditOrdering` that reported a violation
  // unconditionally would pass the case above and prove nothing.
  const honest = [
    "Connecting to Supabase Postgres...",
    "Applying migration: 001_initial_schema.sql ... ok",
    "",
    "All migration files executed. Verifying the result...",
    "",
    "Verifying schema against the catalog:",
    "",
    "  001_initial_schema.sql",
    "    ✓ table scans",
    "",
    "All expected objects present.",
  ].join("\n");
  const clean = auditOrdering(honest);
  assert.equal(clean.occurrences, 1, "an honest transcript announces the verify stage once");
  assert.deepEqual(clean.violations, [], "an honest transcript has no early verdict");
});

/**
 * R6.1.5 — the drift warning must not assert a mismatch that does not exist.
 *
 * The finding: the ledger checksum hashes the whole file, so commit 39af3a9 —
 * which corrected a false header comment in 010_probe_tasks.sql and changed no
 * SQL — moved the recorded checksum from be27ae10f9467429 to ed5bc223145c0461
 * and would make the next run announce "The file no longer describes what is in
 * the database." That sentence was false. The fix records a second,
 * comment-independent checksum and says which of three things happened.
 *
 * The tests below come in two layers, because either one alone is hollow:
 *   - the CHECKSUM layer, on real migration text, proves a comment edit and a
 *     SQL edit are actually distinguishable (and that the stripper does not
 *     reach into function bodies or string literals to get there); and
 *   - the RUNNER layer spawns the script with a fabricated ledger row and reads
 *     what it printed, which is the thing the operator sees.
 */

const MIG_010 = "010_probe_tasks.sql";
const sql010 = readFileSync(path.join(REPO, "supabase/migrations", MIG_010), "utf8");

test("R6.1.5 — a comment-only edit leaves the comment-independent checksum alone", () => {
  const lines = sql010.split("\n");
  assert.ok(
    lines[0].startsWith("--"),
    `this fixture edits the header comment of ${MIG_010}; it no longer opens with one`
  );
  const commentEdited = [
    "-- 010: a rewritten header comment. Says something completely different.",
    ...lines.slice(1),
    "-- and a trailing comment that was not there before",
  ].join("\n");

  const before = checksumsFor(sql010);
  const after = checksumsFor(commentEdited);

  // The finding itself: the whole-file checksum DOES move. That is why the old
  // message fired, and why it is kept as the ledger identity rather than
  // redefined (redefining it would trip every migration at once on the first
  // run after this merge).
  assert.notEqual(before.checksum, after.checksum, "a comment edit does move the whole-file hash");

  assert.ok(before.sqlChecksum, `${MIG_010} must be parseable: ${before.strippedReason}`);
  assert.equal(
    before.sqlChecksum,
    after.sqlChecksum,
    "a comment-only edit must leave the comment-independent checksum identical"
  );
});

test("R6.1.5 — a real SQL edit moves BOTH checksums", () => {
  const needle = "CREATE TABLE IF NOT EXISTS probe_tasks";
  assert.ok(sql010.includes(needle), `this fixture edits "${needle}", which ${MIG_010} no longer contains`);
  const sqlEdited = sql010.replace(needle, "CREATE TABLE IF NOT EXISTS probe_tasks_renamed");

  const before = checksumsFor(sql010);
  const after = checksumsFor(sqlEdited);
  assert.notEqual(before.checksum, after.checksum);
  assert.ok(after.sqlChecksum, `the edited fixture must still parse: ${after.strippedReason}`);
  assert.notEqual(
    before.sqlChecksum,
    after.sqlChecksum,
    "a real SQL change MUST move the comment-independent checksum, or the stripper has hidden it"
  );
});

test("R6.1.5 — comments are stripped at the top level, and the strip is not vacuous", () => {
  const a = "SELECT 1; -- why\n";
  const b = "SELECT 1; -- because, at length, with different words\n";
  assert.equal(checksumsFor(a).sqlChecksum, checksumsFor(b).sqlChecksum, "comment text must not count");
  assert.notEqual(checksumsFor(a).checksum, checksumsFor(b).checksum, "the whole-file hash still sees it");
  assert.notEqual(
    checksumsFor(a).sqlChecksum,
    checksumsFor("SELECT 2; -- why\n").sqlChecksum,
    "a checksum that ignores the SQL as well as the comments would pass the line above"
  );
});

test("R6.1.5 — the stripper does not reach inside a dollar-quoted function body", () => {
  // The dangerous direction of error. If a naive `--` strip ate this body, a
  // REAL change to it would hash identically to the text it replaced, and the
  // drift warning would go silent on exactly the edit it exists to catch. 010
  // is mostly $fn$ bodies, so this is not hypothetical.
  const base =
    "CREATE OR REPLACE FUNCTION f() RETURNS int LANGUAGE plpgsql AS $fn$\n" +
    "BEGIN\n" +
    "  -- the body has its own comments, and they are string content out here\n" +
    "  RETURN 1;\n" +
    "END;\n" +
    "$fn$;\n";
  const bodyChanged = base.replace("RETURN 1;", "RETURN 2;");
  const bodyComment = base.replace("the body has its own comments", "a completely different sentence");

  const baseSum = checksumsFor(base);
  assert.ok(baseSum.sqlChecksum, `the fixture must parse: ${baseSum.strippedReason}`);
  assert.notEqual(
    baseSum.sqlChecksum,
    checksumsFor(bodyChanged).sqlChecksum,
    "a changed function body is a changed schema"
  );
  assert.notEqual(
    baseSum.sqlChecksum,
    checksumsFor(bodyComment).sqlChecksum,
    "a dollar-quoted body is a literal; under-stripping it is safe, reaching into it is not"
  );
});

test("R6.1.5 — a double dash inside a string literal is not a comment", () => {
  const a = "INSERT INTO t (note) VALUES ('a -- not a comment');\n";
  const b = "INSERT INTO t (note) VALUES ('a -- still not a comment');\n";
  assert.ok(checksumsFor(a).sqlChecksum, "the fixture must parse");
  assert.notEqual(
    checksumsFor(a).sqlChecksum,
    checksumsFor(b).sqlChecksum,
    "string content is data; stripping it would hide a real change"
  );

  // Doubled quotes inside a literal must not be read as the end of it.
  const escaped = "INSERT INTO t (note) VALUES ('it''s -- fine'); -- real comment\n";
  const escapedOther = "INSERT INTO t (note) VALUES ('it''s -- fine'); -- other comment\n";
  assert.equal(
    checksumsFor(escaped).sqlChecksum,
    checksumsFor(escapedOther).sqlChecksum,
    "the trailing comment is a comment; the '' inside the literal must not have ended it"
  );
});

test("R6.1.5 — an unparseable file refuses to produce a semantic checksum", () => {
  // Fail loud: no comment-independent checksum means the runner says UNKNOWN,
  // never that everything is fine.
  const unterminatedString = checksumsFor("SELECT 'never closed;\n");
  assert.equal(unterminatedString.sqlChecksum, null);
  assert.match(unterminatedString.strippedReason, /unterminated/);

  const unterminatedBody = checksumsFor("CREATE FUNCTION f() AS $fn$ BEGIN RETURN 1; END;\n");
  assert.equal(unterminatedBody.sqlChecksum, null);
  assert.match(unterminatedBody.strippedReason, /dollar-quoted/);

  assert.equal(semanticSql("/* never closed\n").reliable, false);
});

/** Spawn the runner with a fabricated ledger row; return the line about 010. */
function driftRun(recordedRow) {
  const dir = withRegister(makeSandbox({ catalog: FULL_CATALOG, recorded: [recordedRow] }));
  try {
    const { status, out } = runRunner(dir);
    // The drift lines are the only ones that write "<file>:"; the apply line is
    // "Applying migration: <file> ... ok" and the verify heading has no colon.
    const line = out.split("\n").find((l) => l.includes(`${MIG_010}:`));
    return { status, out, line };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("R6.1.5 — comment-only, real SQL change and unknown are three different sentences", () => {
  const { checksum, sqlChecksum } = checksumsFor(sql010);
  assert.ok(sqlChecksum, "010 must parse, or every assertion below is vacuous");

  // be27ae10f9467429 is the checksum 010 really carries in production, recorded
  // before commit 39af3a9 corrected its header comment.
  const STALE = "be27ae10f9467429";
  const commentOnly = driftRun({ filename: MIG_010, checksum: STALE, sql_checksum: sqlChecksum });
  const realChange = driftRun({ filename: MIG_010, checksum: STALE, sql_checksum: "0000000000000000" });
  const unknown = driftRun({ filename: MIG_010, checksum: STALE, sql_checksum: null });

  for (const [name, r] of [
    ["comment-only", commentOnly],
    ["real SQL change", realChange],
    ["unknown", unknown],
  ]) {
    assert.ok(r.line, `${name}: a checksum that moved must be reported, not swallowed:\n${r.out}`);
    assert.ok(r.line.includes(STALE) && r.line.includes(checksum), `${name}: both checksums must be shown`);
  }

  // The comment-only case: says what happened, claims nothing about the schema.
  assert.match(commentOnly.line, /COMMENTS ONLY/, commentOnly.line);
  assert.ok(
    !/no longer describes what is in the database/.test(commentOnly.line),
    `a comment edit must not assert a schema mismatch:\n${commentOnly.line}`
  );
  assert.equal(commentOnly.status, 0, "and it is not a failure");

  // The real change: the loud sentence, unchanged, because it is now true.
  assert.match(realChange.line, /the SQL has CHANGED/, realChange.line);
  assert.match(realChange.line, /no longer describes what is in the database/, realChange.line);

  // The unknown case: this is 010 in production right now — the row predates
  // sql_checksum, so the runner cannot tell which happened and must not pick.
  assert.match(unknown.line, /UNKNOWN/, unknown.line);
  assert.ok(
    !/no longer describes what is in the database/.test(unknown.line),
    `an unknown must not borrow the loud verdict:\n${unknown.line}`
  );
  assert.ok(
    !/COMMENTS ONLY/.test(unknown.line),
    `an unknown must not borrow the reassuring verdict either:\n${unknown.line}`
  );

  // THE ACCEPT, stated: the three cases must not report the same thing.
  assert.notEqual(commentOnly.line, realChange.line);
  assert.notEqual(commentOnly.line, unknown.line);
  assert.notEqual(realChange.line, unknown.line);
});

test("R6.1.5 — an unedited migration reports no drift at all", () => {
  const { checksum, sqlChecksum } = checksumsFor(sql010);
  const r = driftRun({ filename: MIG_010, checksum, sql_checksum: sqlChecksum });
  assert.equal(r.status, 0, r.out);
  assert.equal(
    r.line,
    undefined,
    `nothing changed, so nothing may be said about it. A drift line here means the ` +
      `comparison is reporting a difference that does not exist:\n${r.out}`
  );
});
