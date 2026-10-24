import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
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

  // R6.1.7 — the probe sentinel, and why it is a random nonce.
  //
  // The ordering guard below needs a point in the transcript that means "the
  // database has now actually been asked a question". Every string the RUNNER
  // prints is a self-report: it can be moved, reworded, or printed early, which
  // is precisely the evasion this task exists to close. The sentinel is written
  // by the STUB CLIENT, inside `query()`, at the moment a catalog probe arrives
  // — so its position in stdout is an event the runner cannot relocate without
  // actually issuing the probe.
  //
  // The token is generated per sandbox and never leaves this temp directory, so
  // a sabotaged runner cannot print a convincing sentinel either: it does not
  // know the nonce. (This is a probe marker, not a credential — it authenticates
  // nothing and reaches no network.)
  const probeTokenValue = randomBytes(9).toString("hex");
  writeFileSync(path.join(dir, "probe-token.txt"), probeTokenValue);

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
import { pathToFileURL as __toUrl } from "node:url";
const CATALOG = ${JSON.stringify(catalog)};
const FAIL_ON = ${JSON.stringify(failOn)};
const PROBE_TOKEN = ${JSON.stringify(probeTokenValue)};
// Rows the ledger already holds. Fixing these is how the drift path gets
// exercised without editing a migration on disk under five concurrent agents.
const RECORDED = ${JSON.stringify(recorded)};
export const log = [];
let txn = 0;

/**
 * R6.2.6 — the runner's OWN comment lexer, reused rather than reimplemented.
 *
 * \`semanticSql\` walks the four PostgreSQL contexts a \`--\` can hide in
 * (single-quoted strings, quoted identifiers, nestable slash-star blocks,
 * dollar-quoted bodies), so a header comment cannot be read as a query and a
 * literal containing "--" cannot be truncated into one. A second lexer here
 * would be a second thing to get wrong.
 *
 * It is loaded from \`process.argv[1]\` — the script actually under test —
 * and NOT from a fixed path to scripts/setup-supabase.mjs. Importing a SECOND
 * copy of the runner is fatal: its entrypoint guard sees an argv[1] named
 * setup-supabase.mjs that does not resolve to itself, prints "Refusing to run"
 * and exits 1, which kills every sabotagedRunner test. argv[1] is always the
 * one copy that is allowed to exist.
 *
 * The import is DEFERRED to the first query. The runner imports "pg", so this
 * module is in a cycle with it; awaiting the entry at module scope would
 * deadlock, whereas by the time any query arrives the entry has finished
 * evaluating and the dynamic import resolves from cache.
 */
let stripper = null;
async function loadStripper() {
  if (stripper) return stripper;
  try {
    const mod = await import(__toUrl(process.argv[1]).href);
    stripper = typeof mod.semanticSql === "function" ? mod.semanticSql : () => ({ reliable: false, text: null });
  } catch {
    stripper = () => ({ reliable: false, text: null });
  }
  return stripper;
}

/**
 * The text a probe pattern is allowed to match against: comments removed,
 * whitespace collapsed. If the lexer cannot read the statement it returns
 * { reliable: false, text: null } and we fall back to the RAW text — the safe
 * direction, since an unreadable file must not silently stop being matched.
 * The statement-start anchors and the params check below are the second tooth
 * that covers that fallback.
 */
async function probeText(sql) {
  const semanticSql = await loadStripper();
  const stripped = semanticSql(sql);
  return stripped && stripped.reliable && typeof stripped.text === "string" ? stripped.text : sql;
}

class Client {
  constructor() { this.log = log; }
  async connect() {}
  async end() {}
  async query(text, params) {
    const sql = String(text);
    // Every catalog-probe pattern below matches THIS, never \`sql\`.
    const probe = await probeText(sql);
    // R6.2.6 — the runner's catalog probes are all parameterised. A migration
    // body never is. This is the anchor-independent half of the fix.
    const parameterised = Array.isArray(params) && params.length > 0;
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

    // Catalog probes. The sentinel goes out on stdout IN LINE with the runner's
    // own output — same process, same stream — so the transcript records when
    // the database was really consulted relative to what the runner claimed.
    //
    // R6.2.6 — three things make a pattern here specific enough to NOT match
    // migration SQL, and all three are needed:
    //   1. it matches \`probe\`, i.e. the statement with COMMENTS STRIPPED, so a
    //      header comment quoting the applied-check is not a query;
    //   2. it is ANCHORED at the statement start, so the shape appearing
    //      anywhere inside a migration body cannot trigger it; and
    //   3. it requires \`parameterised\`, because every runner probe binds $1.
    // Before R6.2.6 only the "JOIN pg_namespace, which migration SQL never
    // does" discriminator existed, and a comment defeated it outright.
    if (parameterised && /^SELECT 1 FROM storage\\.buckets WHERE id/.test(probe)) {
      const name = (params && params[0]) || "";
      log.push({ txn, sql: "PROBE", name });
      process.stdout.write("__PROBE " + PROBE_TOKEN + " " + name + "\\n");
      return { rows: CATALOG.includes(name) ? [{ "?column?": 1 }] : [] };
    }
    if (parameterised && /^SELECT to_regclass\\(\\$1\\)/.test(probe)) {
      const name = String((params && params[0]) || "").replace("public.", "");
      log.push({ txn, sql: "PROBE", name });
      process.stdout.write("__PROBE " + PROBE_TOKEN + " " + name + "\\n");
      return { rows: [{ regclass: CATALOG.includes(name) ? name : null }] };
    }
    if (parameterised && /^SELECT 1 FROM pg_proc\\b/.test(probe) && /oidvectortypes/.test(probe) && /JOIN pg_namespace/.test(probe)) {
      const name = (params && params[0]) || "";
      const sig = (params && params[1]) || "";
      const key = sig ? name + "(" + sig + ")" : name;
      // Emit the probe with just the function name, matching the runner's
      // reported format. The signature check is internal; the probe name is
      // what the R6.1.7 ordering guard compares against reported objects.
      log.push({ txn, sql: "PROBE", name });
      process.stdout.write("__PROBE " + PROBE_TOKEN + " " + name + "\\n");
      return { rows: CATALOG.includes(name) || CATALOG.includes(key) ? [{ "?column?": 1 }] : [] };
    }
    if (parameterised && /^SELECT 1 FROM pg_proc\\b/.test(probe) && /JOIN pg_namespace/.test(probe)) {
      const name = (params && params[0]) || "";
      log.push({ txn, sql: "PROBE", name });
      process.stdout.write("__PROBE " + PROBE_TOKEN + " " + name + "\\n");
      return { rows: CATALOG.includes(name) ? [{ "?column?": 1 }] : [] };
    }
    // R6.1.12 — column existence via pg_attribute. The runner's query JOINs
    // pg_class and pg_namespace; migration DO blocks use information_schema.
    if (parameterised && /^SELECT 1 FROM pg_attribute\\b/.test(probe) && /JOIN pg_class/.test(probe) && /JOIN pg_namespace/.test(probe)) {
      const table = (params && params[0]) || "";
      const column = (params && params[1]) || "";
      const name = table + "." + column;
      log.push({ txn, sql: "PROBE", name });
      process.stdout.write("__PROBE " + PROBE_TOKEN + " " + name + "\\n");
      return { rows: CATALOG.includes(name) ? [{ "?column?": 1 }] : [] };
    }
    // R6.1.12 — constraint existence via pg_constraint. The runner's query
    // JOINs pg_namespace; migration DO blocks query pg_constraint directly.
    if (parameterised && /^SELECT 1 FROM pg_constraint\\b/.test(probe) && /JOIN pg_namespace/.test(probe)) {
      const name = (params && params[0]) || "";
      log.push({ txn, sql: "PROBE", name });
      process.stdout.write("__PROBE " + PROBE_TOKEN + " " + name + "\\n");
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

const REAL_RUNNER = path.join(REPO, "scripts/setup-supabase.mjs");

/** The nonce this sandbox's stub stamps on every catalog probe. */
function probeToken(dir) {
  return readFileSync(path.join(dir, "probe-token.txt"), "utf8").trim();
}

/**
 * Run a runner against the sandbox; return exit code and stdout.
 *
 * `script` defaults to the real runner. R6.1.7 passes a deliberately sabotaged
 * COPY of it, to prove the ordering guard below has teeth against a runner that
 * lies about which stage it has reached.
 */
function runRunner(dir, script = REAL_RUNNER) {
  const res = spawnSync(
    process.execPath,
    ["--import", pathToFileUrlString(path.join(dir, "register.mjs")), script],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        // Not a credential and not reachable: no host, no password, nothing to
        // rotate. The stub intercepts `pg` long before anything is dialled.
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

/** Everything 001-023 must leave behind, per the runner's own expectations. */
const FULL_CATALOG = [
"jobs","job_steps","job_periodic","enqueue_job","claim_due_jobs","job_step_begin","job_step_complete","job_step_fail","job_sleep","job_yield","job_progress","job_finish","cancel_job","reconcile_stale_jobs","claim_due_periodic","prune_jobs","jobs_single_active_idx","jobs_tick_http",
"paid_feature_controls","workspace_spend_limits","spend_holds","spend_ledger","reserve_spend","settle_spend","release_spend","expire_spend_holds","f01_expire_due_holds","prune_spend","f01_committed_usd",
"measurement_storage_ready","set_probe_rollout","probe_dispatch_control.brand_allowlist",
"measurement_evidence","measurement_incidents","record_measurement_incident","repair_artifacts","repair_artifact_heads","append_repair_artifact","decide_checked_content","record_verified_publication","repair_content_hash","scans.origin_job_id","scans_origin_job_key","content_check_claims","claim_content_check","finish_content_check","measurement_windows","enqueue_measurement_window","scan_jobs.panel_snapshot","scan_jobs.measurement_context","materialize_scan_report",
  "probe_observations", "probe_attempts", "probe_late_receipts", "probe_reconciliations",
  "provider_dispatch_circuits", "provider_canary_budgets", "probe_dispatch_control",
  "renew_probe_dispatch", "seed_probe_observations", "claim_probe_dispatch", "finish_probe_dispatch", "block_probe_dispatch", "reconcile_probe_dispatch",
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
  // R6.1.12 — 012 now verifies the column directly too.
  "scan_jobs.attempts", "scan_jobs_attempts_idx",
  "claim_scan_job_attempt(uuid, integer)",
  // R6.1.12 — 013 now verifies the columns directly too.
  "brand_metrics_daily.sov_state", "brand_metrics_daily.sov_state_reason",
  "brand_metrics_daily_sov_unverified_idx",
  // 015 (R4.3.3). Same trick for the three citation-denominator columns:
  // brand_metrics_daily.citation_denominator / .citation_state /
  // .citation_state_reason. (014 is deliberately absent from this list and
  // from the runner's verify list -- it ships no index; see the comment on
  // "014_content_job_checkpoints.sql" in scripts/setup-supabase.mjs.)
  "brand_metrics_daily_citation_unverified_idx",
  // 016 (R4.3.1). Crawlability audit history table + index for history queries.
  "crawlability_audits", "crawlability_audits_domain_idx",
  // 016_content_items_natural_key.sql — constraint.
  "content_items_job_id_cycle_key",
  // 017_cost_unmeasured_calls.sql — column.
  "scans.cost_unmeasured_calls",
  // 018_gsc_daily.sql (R4.1.1) — GSC connection + daily query tables.
  "gsc_connections", "gsc_daily", "gsc_daily_brand_date_idx",
  // 019_probe_evidence_bucket.sql (R1.5.1) — storage bucket.
  "probe-evidence",
  // 021_prompt_results_evidence.sql (R1.5.2) — the §3.7 evidence ids, promoted
  // onto prompt_results. Columns, so the catalog probe reads pg_attribute.
  // (020 adds no object of its own: it recreates 016's constraint under the
  // same name, which is already in this list.)
  "prompt_results.evidence_screenshot_id",
  "prompt_results.evidence_dom_id",
  "prompt_results.evidence_har_id",
  "prompt_results.evidence_raw_id",
  "prompt_results.evidence_captured_at",
  // 022_scan_runs_retention.sql (R1.2.23a) — the batched delete the nightly
  // cron calls, and the partial index that makes each batch a range scan.
  // scanRunsRetention.js rpc()s the function by name, so its absence is not a
  // slow prune, it is a prune that fails on the first call.
  "scan_runs_noop_retention_idx",
  "prune_noop_scan_runs",
  // 023_customer_auth_and_tenant_rls.sql — customer tenancy and RLS predicates.
  "customer_brands",
  "customer_brand_memberships",
  "customer_brand_aliases",
  "customer_can_access_brand",
  "customer_can_access_scan",
  "customer_team_invites", "create_customer_workspace", "prevent_last_owner_removal",
  "gsc_oauth_attempts", "gsc_oauth_credentials", "gsc_sync_jobs", "gsc_daily_brand_key_gen_idx",
  "scans.brand_key", "scan_jobs.brand_key", "scan_jobs_one_running_per_workspace",
  "activate_customer_gsc", "disconnect_customer_gsc", "write_gsc_generation",
  "accept_customer_team_invites", "claim_customer_gsc_job", "commit_customer_gsc_page", "enqueue_customer_gsc_syncs", "decide_customer_content",
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

test("R6.1.12 — a catalog missing scan_jobs.attempts but carrying the proxy index EXITS NON-ZERO", () => {
  // The proxy index (scan_jobs_attempts_idx) can exist without the column in
  // the test stub — it is just a name in a list. The column check must catch
  // this case independently of the index.
  const catalog = FULL_CATALOG.filter((n) => n !== "scan_jobs.attempts");
  const dir = withRegister(makeSandbox({ catalog }));
  try {
    const { status, out } = runRunner(dir);
    assert.equal(status, 1, "the column check must catch what the proxy index cannot");
    assert.match(out, /scan_jobs\.attempts/, "the missing column must be named");
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

/**
 * R6.1.7 — THE ANCHOR THE RUNNER CANNOT MOVE.
 *
 * `auditOrdering` above keys on a sentence the runner prints about itself. The
 * R6.1.6 verifier showed what that is worth: two evasions survive it, both
 * reproduced against HEAD, both exit 0 with the whole suite green.
 *
 *   RELOCATED — move the sole "Verifying schema against the catalog" line up to
 *     the connect stage, let the real verify stage announce itself in different
 *     words, and print "Migrations applied successfully." before a single
 *     migration has run. The anchor still appears exactly once, so `occurrences`
 *     is satisfied; the window ends two lines in, so the verdict falls outside
 *     it. Green, over a database nothing has looked at.
 *
 *   STRADDLED — leave the anchor exactly where it is and print the verdict on
 *     the very next line, still before any object is probed. The window ends at
 *     the anchor, so again the verdict is "after the check". Green.
 *
 * The common cause is not `indexOf` versus `lastIndexOf` — it is that the marker
 * for "the database has been consulted" is a string the runner chooses to print.
 * A guard built on that proves the runner is consistent with itself.
 *
 * So this measures from the FIRST CATALOG PROBE THAT ACTUALLY REACHED THE
 * CLIENT: the stub writes `__PROBE <nonce> <name>` from inside `query()`, in the
 * same process and on the same stream, at the moment the probe arrives. To move
 * that marker earlier the runner must genuinely probe the catalog earlier, which
 * is not an evasion — it is the behaviour being asked for.
 *
 * NO PROBE AT ALL IS THE LOUDEST CASE, not a pass: `anchor === -1` leaves the
 * whole transcript inside the window, and callers must additionally assert
 * `probes.length > 0`. A runner that reports 42 objects present without asking
 * the database is the purest form of the self-report defect.
 *
 * The nonce also settles the "verify via the catalog, never a head-probe" rule
 * from docs/PROD_MIGRATIONS.md in the observable direction: these sentinels are
 * emitted ONLY by the `to_regclass` and `pg_proc` branches of the stub. A runner
 * that "verified" 006 by selecting from `content_runs` would produce no sentinel
 * and fail here, and it never calls any of the nine functions the migrations
 * create — one of which, `claim_scan_job_attempt` in 012, marks a scan job
 * failed.
 */
function auditByProbe(stdout, token) {
  const probes = [];
  const re = new RegExp(`__PROBE ${token} (\\S+)`, "g");
  for (let m = re.exec(stdout); m; m = re.exec(stdout)) {
    probes.push({ at: m.index, name: m[1] });
  }
  const anchor = probes.length > 0 ? probes[0].at : -1;
  const before = anchor === -1 ? stdout : stdout.slice(0, anchor);
  const violations = [];
  for (const phrase of VERDICT_PHRASES) {
    const hit = before.match(phrase);
    if (hit) violations.push(hit[0]);
  }
  return { probes, anchor, before, violations };
}

/**
 * Every per-object verdict line the runner printed, with its offset.
 *
 * Same principle one level down: a tick is a claim about one object, and the
 * claim is only worth anything if a probe for THAT NAME reached the client
 * before it was printed.
 */
function reportedObjects(stdout) {
  const out = [];
  const re = /^ +(✓|✗) (table|index|function|column|constraint|bucket) (\S+)$/gm;
  for (let m = re.exec(stdout); m; m = re.exec(stdout)) {
    out.push({ at: m.index, mark: m[1], kind: m[2], name: m[3] });
  }
  return out;
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

      // R6.1.7 — the load-bearing window, measured from the first probe that
      // actually reached the client. This is the assertion that survives a
      // relocated or straddled banner; everything below about the banner is a
      // secondary, cheaper tooth kept because it localises a failure.
      const byProbe = auditByProbe(stdout, probeToken(dir));
      assert.ok(
        byProbe.probes.length > 0,
        `the runner never probed the catalog at all. Whatever it printed about the database is ` +
          `unbacked:\n${stdout}`
      );
      assert.deepEqual(
        byProbe.violations,
        [],
        `${JSON.stringify(byProbe.violations)} was printed before the FIRST CATALOG PROBE reached the ` +
          `database. Moving or rewording the verify banner does not change this, which is the point:\n` +
          `${byProbe.before}`
      );

      const audit = auditOrdering(stdout);
      assert.ok(audit.anchor > 0, `the verification must announce itself on stdout:\n${stdout}`);
      assert.ok(
        audit.anchor < byProbe.anchor,
        `the verify banner must precede the first real probe, not trail it. Banner at ${audit.anchor}, ` +
          `first probe at ${byProbe.anchor}:\n${stdout}`
      );
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
        // R6.1.7: and after the LAST probe, not merely after the banner. A
        // success sentence printed while probes are still arriving is a verdict
        // on a database that has not finished being read.
        assert.ok(
          stdout.indexOf("All expected objects present") > byProbe.probes[byProbe.probes.length - 1].at,
          "the success sentence must follow the last catalog probe, not sit among them"
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

test("R6.1.7 — every ✓ the runner prints is backed by a probe of THAT object, printed earlier", () => {
  const dir = withRegister(makeSandbox({ catalog: FULL_CATALOG }));
  try {
    const { status, stdout } = runRunner(dir);
    assert.equal(status, 0, stdout);

    const reported = reportedObjects(stdout);
    const { probes } = auditByProbe(stdout, probeToken(dir));

    // Counted from the runner's own expectation list rather than hard-coded, so
    // a migration added without expectations does not quietly shrink this test.
    assert.ok(reported.length >= 40, `expected the full object report, got ${reported.length}:\n${stdout}`);
    assert.equal(
      probes.length,
      reported.length,
      `${reported.length} objects were reported on but ${probes.length} probes reached the database. ` +
        `A verdict per object requires a question per object.`
    );

    const unbacked = reported.filter(
      (r) => !probes.some((p) => p.name === r.name && p.at < r.at)
    );
    assert.deepEqual(
      unbacked.map((r) => `${r.kind} ${r.name}`),
      [],
      `these objects were pronounced on without the database being asked about them first:\n${stdout}`
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * R6.1.7 — the sabotage harness.
 *
 * Writes a COPY of the real runner with a named patch applied, next to a copy of
 * the migration set so its own `join(__dirname, "../supabase/migrations")` still
 * resolves, and under the same basename so its entrypoint guard still recognises
 * itself. Nothing in `scripts/` is touched.
 *
 * The `includes` assertion is the important one: a sabotage whose anchor has
 * drifted out of the source silently becomes a no-op, and a teeth test that
 * sabotages nothing passes against the bug it exists to catch.
 */
function sabotagedRunner(dir, patches) {
  const src = readFileSync(REAL_RUNNER, "utf8");
  let out = src;
  for (const [find, replace] of patches) {
    assert.ok(
      out.includes(find),
      `this sabotage no longer applies: ${JSON.stringify(find)} is not in scripts/setup-supabase.mjs. ` +
        `Re-derive it from the current source — do not delete the test, an inapplicable sabotage is a ` +
        `test that proves nothing.`
    );
    out = out.replace(find, () => replace);
  }
  assert.notEqual(out, src, "the sabotage must actually change the runner");

  mkdirSync(path.join(dir, "scripts"), { recursive: true });
  const migs = path.join(dir, "supabase", "migrations");
  mkdirSync(migs, { recursive: true });
  for (const f of readdirSync(path.join(REPO, "supabase/migrations")).filter((n) => n.endsWith(".sql"))) {
    writeFileSync(path.join(migs, f), readFileSync(path.join(REPO, "supabase/migrations", f)));
  }
  const script = path.join(dir, "scripts", "setup-supabase.mjs");
  writeFileSync(script, out);
  return script;
}

const CONNECT_LINE = 'console.log("Connecting to Supabase Postgres...");';
const VERIFY_BANNER_LINE = 'console.log("Verifying schema against the catalog:\\n");';
const PROBE_CALL_LINE = "const exists = await objectExists(client, obj);";
const EARLY_VERDICT = 'process.stdout.write("Migrations applied successfully.\\n");';

/**
 * R6.1.7 — EVASION ONE, executed. The banner moves; the verdict comes first.
 *
 * This is the R6.1.6 verifier's finding as a spawned process rather than a
 * transcript: the sole occurrence of the verify anchor is relocated to the
 * connect stage, the real verify stage announces itself in different words, and
 * "Migrations applied successfully." goes out before `client.connect()`.
 *
 * The assertions come in two halves and BOTH are load-bearing. The banner half
 * asserts the OLD guard is fooled — if that ever stops being true the finding
 * has been fixed elsewhere and this test should be re-derived, not relaxed. The
 * probe half is the new guard, and it must be red.
 */
test("R6.1.7 TEETH — a RELOCATED verify banner fools the banner anchor and not the probe anchor", () => {
  const dir = withRegister(makeSandbox({ catalog: FULL_CATALOG }));
  try {
    const script = sabotagedRunner(dir, [
      [
        CONNECT_LINE,
        CONNECT_LINE +
          '\n  console.log("  step 1/3: Verifying schema against the catalog is deferred until connect completes");' +
          `\n  ${EARLY_VERDICT}`,
      ],
      [VERIFY_BANNER_LINE, 'console.log("Checking each object now:\\n");'],
    ]);
    const { status, stdout } = runRunner(dir, script);

    // The shape of the lie: a clean exit over a verdict nothing backs.
    assert.equal(status, 0, `the sabotage must be a FALSE SUCCESS to be worth testing:\n${stdout}`);
    assert.ok(stdout.includes("Migrations applied successfully."), stdout);

    // Half one — the self-report anchor is fooled. Exactly one anchor, and the
    // verdict sits after it, so the R6.1.6 guard reports a clean run.
    const banner = auditOrdering(stdout);
    assert.equal(banner.occurrences, 1, "the relocated anchor still appears exactly once");
    assert.deepEqual(
      banner.violations,
      [],
      "if the banner guard caught this, the premise of R6.1.7 has changed; re-derive, do not relax"
    );

    // Half two — the probe anchor cannot be moved by rewording anything.
    const byProbe = auditByProbe(stdout, probeToken(dir));
    assert.ok(byProbe.probes.length > 0, "the sabotaged runner still probes, just far too late");
    assert.ok(
      byProbe.violations.some((v) => /successfully/i.test(v)),
      `the early verdict must be caught by the probe anchor; got ${JSON.stringify(byProbe.violations)}`
    );
    assert.ok(
      stdout.indexOf("Migrations applied successfully.") < byProbe.anchor,
      "and it must be caught BECAUSE it was printed before the first probe, not by coincidence"
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * R6.1.7 — EVASION TWO, executed. The banner stays; the verdict straddles it.
 *
 * Nothing is relocated. The verdict is printed on the line after the anchor and
 * before a single object has been probed, so the banner window ends before it
 * and the run reads as verified. The database has still not been asked anything.
 */
test("R6.1.7 TEETH — a verdict STRADDLING the banner and the first probe is caught", () => {
  const dir = withRegister(makeSandbox({ catalog: FULL_CATALOG }));
  try {
    const script = sabotagedRunner(dir, [[VERIFY_BANNER_LINE, `${VERIFY_BANNER_LINE}\n    ${EARLY_VERDICT}`]]);
    const { status, stdout } = runRunner(dir, script);

    assert.equal(status, 0, `the sabotage must be a FALSE SUCCESS to be worth testing:\n${stdout}`);
    assert.ok(stdout.includes("Migrations applied successfully."), stdout);

    const banner = auditOrdering(stdout);
    assert.equal(banner.occurrences, 1, "the anchor was never touched");
    assert.deepEqual(
      banner.violations,
      [],
      "if the banner guard caught this, the premise of R6.1.7 has changed; re-derive, do not relax"
    );

    const byProbe = auditByProbe(stdout, probeToken(dir));
    assert.ok(byProbe.probes.length > 0);
    assert.ok(
      byProbe.violations.some((v) => /successfully/i.test(v)),
      `a verdict between the banner and the first probe must be caught; got ` +
        `${JSON.stringify(byProbe.violations)}`
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * R6.1.7 — the self-report defect in its purest form: a runner that reports on
 * 42 objects without asking the database about any of them.
 *
 * Every string in the transcript is exactly what a healthy run prints, in the
 * right order, and the exit code is 0. The banner guard has nothing to object
 * to, because nothing about the TEXT is wrong. What is wrong is that no question
 * was ever asked, and the only way to see that is to key on the question.
 */
test("R6.1.7 TEETH — a runner that ticks every object without probing anything is caught", () => {
  const dir = withRegister(makeSandbox({ catalog: FULL_CATALOG }));
  try {
    const script = sabotagedRunner(dir, [[PROBE_CALL_LINE, "const exists = true;"]]);
    const { status, stdout } = runRunner(dir, script);

    assert.equal(status, 0, `the sabotage must be a FALSE SUCCESS to be worth testing:\n${stdout}`);
    assert.ok(stdout.includes("All expected objects present."), stdout);

    // The banner guard is entirely satisfied: one anchor, no early verdict, the
    // success sentence in its proper place.
    const banner = auditOrdering(stdout);
    assert.equal(banner.occurrences, 1);
    assert.deepEqual(banner.violations, []);
    assert.ok(stdout.indexOf("All expected objects present") > banner.anchor);

    // The probe guard is not.
    const byProbe = auditByProbe(stdout, probeToken(dir));
    assert.equal(
      byProbe.probes.length,
      0,
      "the sabotage is supposed to remove every catalog probe; if probes survive it is not testing this"
    );

    // THE CONTROL, and it is not optional. "Zero probes" is also what a harness
    // that stopped emitting sentinels would report, and that harness would
    // certify this test green while proving nothing. So: the same sandbox shape,
    // the REAL runner, must produce probes.
    const controlDir = withRegister(makeSandbox({ catalog: FULL_CATALOG }));
    try {
      const control = runRunner(controlDir);
      assert.ok(
        auditByProbe(control.stdout, probeToken(controlDir)).probes.length > 0,
        "the harness itself must be able to observe a probe, or the assertion above is vacuous"
      );
    } finally {
      rmSync(controlDir, { recursive: true, force: true });
    }

    const reported = reportedObjects(stdout);
    assert.ok(reported.length >= 40, `it still claims to have checked everything: ${reported.length}`);
    const backed = reported.filter((r) => byProbe.probes.some((p) => p.name === r.name && p.at < r.at));
    assert.deepEqual(backed, [], "not one of those ticks is backed by a question to the database");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

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

/**
 * R6.2.6 — a migration whose header COMMENT quotes a catalog probe.
 *
 * THE FINDING. The stub above used to recognise a catalog probe by regexing the
 * WHOLE statement text — comments included — for
 * `FROM pg_attribute ... JOIN pg_class ... JOIN pg_namespace`. Migration text is
 * handed to `client.query()` whole, header comment and all, so a migration that
 * merely DOCUMENTED its applied-check in that shape made the stub emit a phantom
 * `__PROBE` from inside the migration-apply loop — i.e. before the verify banner.
 * Five of the twenty-one tests in this file went red with no SQL change at all:
 * both ORDERING scenarios, the "every ✓ is backed by a probe" test, and two of
 * the three R6.1.7 TEETH tests. Reproduced against HEAD 583dfca by prefixing
 * 001_initial_schema.sql with one such comment line.
 *
 * 021_prompt_results_evidence.sql worked around it by rephrasing its documented
 * check against information_schema.columns. That workaround is invisible: the
 * next migration author writes the natural thing and the suite blames them. So
 * the fix is in the stub — comments stripped with the runner's own lexer,
 * patterns anchored at the statement start, probes required to carry params —
 * and this test holds the workaround-free phrasing in a fixture forever.
 *
 * Staged in a sandbox rather than added to supabase/migrations: this is a test
 * fixture, not a schema change, and it must not reach a real database.
 */

/** A verbatim copy of the runner plus the migration set, with extras appended. */
function stagedRunner(dir, extraMigrations = []) {
  mkdirSync(path.join(dir, "scripts"), { recursive: true });
  const migs = path.join(dir, "supabase", "migrations");
  mkdirSync(migs, { recursive: true });
  for (const f of readdirSync(path.join(REPO, "supabase/migrations")).filter((n) => n.endsWith(".sql"))) {
    writeFileSync(path.join(migs, f), readFileSync(path.join(REPO, "supabase/migrations", f)));
  }
  for (const { name, sql } of extraMigrations) writeFileSync(path.join(migs, name), sql);
  const script = path.join(dir, "scripts", "setup-supabase.mjs");
  // Same basename, so the runner's entrypoint guard still recognises itself.
  writeFileSync(script, readFileSync(REAL_RUNNER, "utf8"));
  return script;
}

const COMMENT_PROBE_FIXTURE = "099_comment_quotes_catalog_probe.sql";
const commentProbeSql = readFileSync(
  path.join(REPO, "src/lib/fixtures/migrationsRunner", COMMENT_PROBE_FIXTURE),
  "utf8"
);

test("R6.2.6 — the fixture really does quote the probe shape ONLY inside comments", () => {
  // Without this the test below could pass because the fixture lost its point.
  assert.match(
    commentProbeSql,
    /pg_attribute[\s\S]*JOIN pg_class[\s\S]*JOIN pg_namespace/,
    "the fixture must contain the catalog-probe shape at all"
  );
  const stripped = semanticSql(commentProbeSql);
  assert.ok(stripped.reliable, `the fixture must parse: ${stripped.reason}`);
  assert.ok(
    !/pg_attribute|pg_proc|to_regclass|pg_constraint|storage\.buckets/.test(stripped.text),
    `with comments stripped the fixture must contain no catalog-probe shape at all, or it is ` +
      `testing something else:\n${stripped.text}`
  );
});

test("R6.2.6 — a migration that quotes a catalog probe in a comment emits NO phantom probe", () => {
  const dir = withRegister(makeSandbox({ catalog: FULL_CATALOG }));
  try {
    const script = stagedRunner(dir, [{ name: COMMENT_PROBE_FIXTURE, sql: commentProbeSql }]);
    const { status, stdout, stderr } = runRunner(dir, script);
    assert.equal(status, 0, `the fixture changes no schema expectation, so the run must pass:\n${stdout}${stderr}`);

    const token = probeToken(dir);
    const byProbe = auditByProbe(stdout, token);
    const reported = reportedObjects(stdout);
    assert.ok(byProbe.probes.length > 0, "the harness must still observe real probes");

    // THE ASSERTION. One probe per reported object and not one more. The phantom
    // arrived as an extra, so a count that matches is a count with no phantom in
    // it — and it is checked before the name assertions, because the name the
    // phantom carried ("." — table + "." + column over absent params) is an
    // implementation detail that could change while the defect stays.
    assert.equal(
      byProbe.probes.length,
      reported.length,
      `${byProbe.probes.length} probes reached the database for ${reported.length} reported objects. ` +
        `An extra probe with a migration on disk that contains no SELECT is a comment being ` +
        `executed:\n${stdout}`
    );
    const phantom = byProbe.probes.filter((p) => !reported.some((r) => r.name === p.name));
    assert.deepEqual(
      phantom.map((p) => p.name),
      [],
      `these probes correspond to no object the runner verifies; they came out of a comment:\n${stdout}`
    );

    // And the ordering window is intact: the phantom used to be emitted during
    // the APPLY loop, which put the first probe before the verify banner and is
    // what turned the two ORDERING tests red.
    const banner = auditOrdering(stdout);
    assert.equal(banner.occurrences, 1, stdout);
    assert.ok(
      banner.anchor < byProbe.anchor,
      `the first probe must still follow the verify banner. Banner at ${banner.anchor}, first probe ` +
        `at ${byProbe.anchor} — a probe before the banner is a comment being read as a query:\n${stdout}`
    );
    assert.deepEqual(byProbe.violations, [], byProbe.before);

    // The other half of the accept: the fixture is a real migration and must be
    // applied and ledgered, not skipped to dodge the problem.
    assert.match(
      stdout,
      new RegExp(`${COMMENT_PROBE_FIXTURE.replace(/\./g, "\\.")} \\.\\.\\. ok`),
      `the fixture migration must be applied:\n${stdout}`
    );
    const raw = stdout.match(/__QUERY_LOG__(.*?)__END_LOG__/s)?.[1];
    assert.ok(raw, "the stub must emit its query log");
    const log = JSON.parse(raw);
    const insert = log.find((e) => e.sql === "INSERT_LEDGER" && e.file === COMMENT_PROBE_FIXTURE);
    assert.ok(insert, `the fixture migration must be recorded in the ledger:\n${raw}`);
    const idx = log.indexOf(insert);
    assert.equal(log[idx - 1]?.sql, "MIGRATION", "its body must have been executed, not skipped");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
