import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

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

function makeSandbox({ catalog, failOn = null }) {
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
    if (/SELECT filename, checksum FROM schema_migrations/.test(sql)) return { rows: [] };
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

/** Everything 001-010 must leave behind, per the runner's own expectations. */
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

      const verifyAt = stdout.indexOf("Verifying schema against the catalog");
      assert.ok(verifyAt > 0, `the verification must announce itself on stdout:\n${stdout}`);

      const before = stdout.slice(0, verifyAt);
      for (const phrase of VERDICT_PHRASES) {
        const hit = before.match(phrase);
        assert.equal(
          hit,
          null,
          `"${hit?.[0]}" was printed BEFORE the catalog was checked. Nothing may ` +
            `pronounce on the database until the verification has run:\n${before}`
        );
      }

      // Verdicts belong on stdout after the check; stderr is for the failure
      // path, which says INCOMPLETE, not that anything went well.
      for (const phrase of VERDICT_PHRASES) {
        assert.equal(stderr.match(phrase), null, `stderr claimed a verdict:\n${stderr}`);
      }

      if (scenario.status === 0) {
        assert.ok(
          stdout.indexOf("All expected objects present") > verifyAt,
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
