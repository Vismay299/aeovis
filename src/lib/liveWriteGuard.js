/**
 * R3.2.4 — the write guard for live-database tests. Default deny.
 *
 * WHY THIS EXISTS
 * While R3.2.1 was being built, an earlier draft of its live test stubbed only
 * the READ side of the scan chunk. The chunk therefore ran all the way through
 * to finalize and the REAL `insertScan` wrote two rows into `scans` plus two
 * into `brand_metrics_daily` on the production database. The rows were deleted
 * and the restoration was confirmed twice, but the shape of the mistake is what
 * matters: a live harness that stubs reads LOOKS finished, and the write path
 * only announces itself by writing.
 *
 * R3.2.1's fix was a hand-written list of `assert.fail` stubs, one per writer
 * the chunk might reach. That works, and it is still there, but it is a
 * CONVENTION the next author has to remember: forget one name and the default
 * is the real function against production. R0.1.4's negative control came to
 * the same edge from the other side — it returned 201 and started an in-memory
 * scan, and was saved only by no credentials being loaded under `node --test`,
 * which its author called luck rather than design.
 *
 * This module turns that convention into a property of the harness. A live test
 * installs the guard and names, per table, the writes it intends to perform.
 * Every other write is refused before it reaches the network: a test that
 * forgets a stub fails, loudly, instead of writing.
 *
 * WHAT IT PATCHES (the choke points)
 *   1. `SupabaseClient.prototype.from` / `.rpc` / `.schema`. The whole app
 *      reaches Postgres over PostgREST through one shared client
 *      (`src/lib/db.js` exports `supabase`, and every deps-taking module in
 *      src/lib falls back to it). Patching the PROTOTYPE rather than that one
 *      instance also covers clients a test builds for itself with
 *      `createClient(...)`, and clients created after the guard is installed.
 *      This sits BELOW the deps layer on purpose: stubbing `deps.insertScan`
 *      only protects code paths that take deps, and a module that imports
 *      `supabase` directly walks straight past a deps stub.
 *   2. `pg.Client.prototype.query` / `pg.Pool.prototype.query`. The live tests
 *      talk to Postgres directly for the assertions PostgREST cannot make.
 *      Patching the prototype covers clients that already exist, so a test does
 *      not have to route its connections through a helper to be guarded.
 *
 * HOW IT IS ADOPTED — every test file, not the ones that remembered
 * The first cut of this module was installed by hand at module scope in the
 * three live-DB test files. That made "refuses writes by default" true only of
 * the files that opted in, which is the same luck-not-design the incident was
 * about: six other suites were attempting real production writes and were
 * saved only by `NEXT_PUBLIC_SUPABASE_*` happening to be unset in the shell.
 * So the guard is now armed from TWO directions, and a live test is covered by
 * both:
 *
 *   - `src/lib/liveWriteGuardAuto.mjs`, preloaded with `node --import` in the
 *     `test`, `test:scoring` and `test:live` scripts, arms EVERY test process.
 *     The default policy it installs allows nothing at all.
 *   - `armedLiveDbGate()` in `src/lib/liveDbGate.js` arms it from inside the
 *     gate. That is what closes the hole the preload could not: a live test run
 *     as a bare `node --env-file=.env.local --test <file>` gets no preload, and
 *     that was the only command the gate used to print. Asking the gate whether
 *     a live database is configured is now the same act as arming the guard,
 *     and the bare `liveDbGate()` throws if it finds a database and no guard.
 *
 * A test that needs to write a disposable table names it — via
 * `armedLiveDbGate({ allow: [...] })`, or by installing its own guard ON TOP of
 * the preload's (see the stack below).
 *
 * INSTALLS STACK, THEY DO NOT RE-PATCH. The prototypes are patched exactly
 * once, on the first install; every later install pushes a POLICY and the
 * patch consults the innermost one. That is what makes the automatic install
 * idempotent: a live file can widen its own allow-list without its writes
 * being checked twice — once against its own list and once against the
 * preload's empty one — which is what stacked prototype wrappers would do.
 *
 * WHAT IT DOES NOT COVER — read this before trusting it
 *   - A test run by something other than the `test` / `test:scoring` /
 *     `test:live` scripts, e.g. a bare `node --test path/to/file.mjs` without
 *     the `--import`, IF it never touches `src/lib/liveDbGate.js`. A file that
 *     goes through the gate is covered however it is invoked, because the gate
 *     arms the guard itself; a file that reaches a database without asking the
 *     gate — by reading `DATABASE_URL` or `NEXT_PUBLIC_SUPABASE_URL` by hand —
 *     is outside both mechanisms. `liveWriteGuard.test.mjs` asserts over the
 *     whole tree that every importer of the gate arms the guard; it cannot
 *     assert anything about a file that avoids the gate entirely.
 *     A file that ASKS the gate used to be able to escape the same way, which
 *     is not what this bullet said: until R3.2.10 both halves keyed on
 *     `env === process.env`, so `liveDbGate({ ...process.env })` handed over a
 *     copy, failed the identity check, opened the gate on an unguarded process
 *     and wrote. That form is now flagged statically by the tree walk and
 *     refused at runtime by comparing the gate-opening credentials by value —
 *     but the runtime check knows only the three variables the gate opens on,
 *     so a future credential must be added to `GATE_CREDENTIALS` in
 *     `src/lib/liveDbGate.js` in the same commit as the gate rule that reads it.
 *   - `supabase.storage`, `supabase.functions.invoke`, and realtime. None of
 *     them is used by this codebase; if that changes, extend this file.
 *   - A `SELECT` that calls a writing SQL function this file has never heard of.
 *     Known writers are listed in WRITING_FUNCTIONS below and are checked; an
 *     unknown function reached through `.rpc()` is refused, but one buried in
 *     hand-written SQL is not detectable from the statement text.
 *   - A raw `fetch()` to the PostgREST endpoint, or any other client library.
 *   - Writes from OUTSIDE this process: the fleet in `worker/`, a Next server
 *     running alongside, a psql session.
 *
 * A REFUSAL CANNOT BE SWALLOWED. Several writers in db.js catch their own
 * errors and carry on, so a thrown refusal alone could still end in a green
 * run. Every refusal is therefore also recorded, printed to stderr, and sets
 * `process.exitCode = 1` with an exit-time summary. Standing rule 1: a code
 * path that quietly did nothing must say so, and the inverse — a code path that
 * tried to do something forbidden — must not be able to go quiet either.
 */

/**
 * Tables a live test may write, and only by naming them. Both are throwaway
 * ledger/queue tables introduced by migrations 010 and 011; neither has ever
 * held customer data, and both are routinely emptied.
 *
 * ADDING TO THIS LIST IS A DELIBERATE ACT. If a future migration adds another
 * genuinely disposable table, add it here in the same commit as the test that
 * needs it, so the widening shows up in the diff instead of in the database.
 */
export const WRITABLE_BY_OPT_IN = Object.freeze(["scan_runs", "probe_tasks", "crawlability_audits"]);

/**
 * The tables the incident actually touched, plus their neighbours: everything a
 * customer's account is made of. These are refused even when a test names them,
 * because there is no version of "a test needs to write to `scans`" that is not
 * a bug in the test. `scans` and `brand_metrics_daily` are first in the list
 * for the obvious reason.
 */
export const NEVER_WRITABLE = Object.freeze([
  "measurement_evidence","measurement_incidents","repair_artifacts","repair_artifact_heads","content_check_claims","measurement_windows",
  "probe_observations", "probe_attempts", "probe_late_receipts", "probe_reconciliations",
  "provider_dispatch_circuits", "provider_canary_budgets", "probe_dispatch_control",
  "scans",
  "brand_metrics_daily",
  "scan_jobs",
  "prompt_results",
  "citations",
  "result_brands",
  "brand_prompts",
  "brand_briefs",
  "scan_schedules",
  "scan_rate_limits",
  // F01 phase 2 — migration 041: the spend guard's control rows, caps, holds
  // and ledger. A test that needs a spend ledger row gets it from the memory
  // store, not from the production table.
  "paid_feature_controls", "workspace_spend_limits",
  "spend_holds", "spend_ledger",
  // F01 phase 3 — migration 040: the job runner's queue, step memo and periodic
  // slots. A test that needs a claimed job gets it from the memory store, not
  // from the production table.
  "jobs", "job_steps", "job_periodic",
  // F01 phase 4 — migration 042: the provider cache. A test that needs a
  // cached row gets it from the memory store, not from the production table.
  "provider_cache",
  "system_heartbeats",
  "knowledge_blocks",
  "topics",
  "content_items",
  "content_jobs",
  "content_runs",
  "content_agents",
  "content_events",
  "content_feedback",
  "content_lessons",
  // R4.1.1 — a customer's own Search Console data.
  "gsc_connections",
  "gsc_daily",
  // Customer identity and tenant membership: tests must never create or alter
  // a real account's isolation boundary, even with an explicit opt-in.
  "customer_brands",
  "customer_brand_memberships",
  "customer_brand_aliases",
  "customer_team_invites",
  "gsc_oauth_attempts",
  "gsc_oauth_credentials",
  "gsc_sync_jobs",
  // F26 — per-user analytics consent. Written only via service role after requireUser.
  "user_privacy_choices",
]);

/**
 * The SQL functions that write, and what they write. A `.rpc()` call to a name
 * absent from this map is refused: the guard cannot tell a reporting function
 * from a mutating one, and "we could not tell" must not resolve to "allow".
 */
export const WRITING_FUNCTIONS = Object.freeze({
  set_probe_rollout:["probe_dispatch_control"],
  record_measurement_incident:["measurement_incidents"],append_repair_artifact:["repair_artifacts","repair_artifact_heads"],
  decide_checked_content:["content_items","content_feedback","content_jobs"],record_verified_publication:["content_items","content_jobs","content_events","repair_artifacts"],
  claim_content_check:["content_check_claims"],finish_content_check:["content_check_claims","content_items","content_jobs"],
  enqueue_measurement_window:["measurement_windows","scan_jobs","scan_schedules"],materialize_scan_report:["scan_jobs","prompt_results","citations","result_brands","brand_metrics_daily"],
  create_customer_workspace: ["customer_brands", "customer_brand_memberships"],
  activate_customer_gsc: ["gsc_oauth_credentials", "gsc_connections", "gsc_sync_jobs", "gsc_oauth_attempts"],
  disconnect_customer_gsc: ["gsc_oauth_credentials", "gsc_connections", "gsc_sync_jobs", "gsc_oauth_attempts"],
  write_gsc_generation: ["gsc_daily"],
  accept_customer_team_invites: ["customer_brand_memberships", "customer_team_invites"],
  claim_customer_gsc_job: ["gsc_sync_jobs"],
  prune_expired_gsc_oauth_attempts: ["gsc_oauth_attempts"],
  open_scan_run: ["scan_runs"],
  heartbeat_scan_run: ["scan_runs"],
  close_scan_run: ["scan_runs"],
  claim_probe_tasks: ["probe_tasks"],
  complete_probe_tasks: ["probe_tasks"],
  renew_probe_lease: ["probe_tasks"],
  release_probe_tasks: ["probe_tasks"],
  increment_scan_rate_limit: ["scan_rate_limits"],
  // R3.3.1. It writes scan_jobs, which is NEVER_WRITABLE, so this entry does
  // not permit anything — it makes the refusal name the table instead of
  // reporting an unrecognised function, which is a different bug to chase.
  claim_scan_job_attempt: ["scan_jobs"],
});

/** PostgREST builder methods that mutate. `select` is deliberately absent. */
const MUTATING_BUILDER_METHODS = ["insert", "upsert", "update", "delete"];

/** Statements that touch no rows and are safe to let through unexamined. */
const CONTROL_STATEMENTS = new Set([
  "begin",
  "start",
  "commit",
  "rollback",
  "savepoint",
  "release",
  "set",
  "show",
  "explain",
  "discard",
  "deallocate",
  "listen",
  "unlisten",
]);

/** Every refusal this process has seen, across all guards. Never cleared. */
const REFUSALS = [];
let exitHookInstalled = false;

export class LiveWriteRefused extends Error {
  constructor(message, detail) {
    super(message);
    this.name = "LiveWriteRefused";
    this.detail = detail;
  }
}

/** What the process has refused so far. Read-only copy. */
export function liveWriteRefusals() {
  return REFUSALS.map((r) => ({ ...r }));
}

/**
 * ONLY the guard's own test may call this. It exists because that test has to
 * provoke refusals to prove they happen, and a self-test must not leave the
 * process marked failed. The name is deliberately unusable by accident: if you
 * are reaching for it in a live test, the refusal you are trying to erase is a
 * real one.
 */
export function __clearRefusalsForGuardSelfTestOnly() {
  REFUSALS.length = 0;
  process.exitCode = 0;
}

function installExitHook() {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.on("exit", () => {
    if (REFUSALS.length === 0) return;
    const lines = REFUSALS.map(
      (r) => `  - ${r.label}: ${r.operation} on ${r.table ?? "(unknown table)"} via ${r.transport}`
    );
    process.stderr.write(
      "\n==============================================================\n" +
        ` LIVE WRITE GUARD REFUSED ${REFUSALS.length} WRITE(S)\n` +
        lines.join("\n") +
        "\n This run is marked FAILED even if the calling code caught the error.\n" +
        " A refused write means a live test reached a writer it never stubbed.\n" +
        "==============================================================\n"
    );
  });
}

/**
 * Record and announce. Returns the error so callers can `throw` it, but the
 * record and the non-zero exit code have already happened by then: swallowing
 * the throw does not un-fail the run.
 */
function refuse({ label, operation, table, transport, hint }) {
  installExitHook();
  const where = table ? `\`${table}\`` : "an unidentified table";
  const message =
    `LIVE WRITE REFUSED: ${operation} on ${where} (${transport}). ` +
    `The test "${label}" did not declare this table as writable. ` +
    hint;
  const record = { label, operation, table: table ?? null, transport, message, at: new Date().toISOString() };
  REFUSALS.push(record);
  process.exitCode = 1;
  process.stderr.write(
    "\n==============================================================\n" +
      " LIVE WRITE REFUSED\n" +
      ` ${message}\n` +
      "==============================================================\n"
  );
  return new LiveWriteRefused(message, record);
}

// ---------------------------------------------------------------------------
// SQL classification (the pg transport)
// ---------------------------------------------------------------------------

const IDENT = String.raw`(?:"[^"]+"|[A-Za-z_][A-Za-z_0-9$]*)`;
const QUALIFIED = String.raw`(?:${IDENT}\s*\.\s*)?(${IDENT})`;

/** Comments, string literals and dollar-quoted bodies out; whitespace flattened. */
function normalizeSql(sql) {
  return String(sql)
    .replace(/--[^\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\$([A-Za-z_]*)\$[\s\S]*?\$\1\$/g, " '' ")
    .replace(/'(?:''|[^'])*'/g, " '' ")
    .replace(/\s+/g, " ")
    .trim();
}

function bareIdent(raw) {
  return raw.replace(/^"|"$/g, "").toLowerCase();
}

/**
 * @returns {{kind: "control"|"read"|"write"|"ddl"|"unknown", tables: string[], why: string}}
 *
 * Deliberately conservative in one direction only: anything it cannot classify
 * comes back `unknown`, and the caller refuses `unknown`.
 */
export function classifyStatement(sql) {
  const text = normalizeSql(sql);
  if (!text) return { kind: "unknown", tables: [], why: "empty statement" };

  const head = text.split(/[\s(;]/, 1)[0].toLowerCase();

  // DDL and bulk loaders are never a live test's business, whatever tables they
  // name. `truncate` is here rather than below so that no allow-list entry can
  // ever authorise emptying a table wholesale. The patterns are deliberately
  // specific (keyword + object keyword) rather than a bare word scan, so a
  // column called `comment` or `copy` in a plain SELECT is not a false alarm.
  const ddl = [
    /\b(?:create|alter|drop)\s+(?:or\s+replace\s+)?(?:unique\s+)?(?:materialized\s+)?(?:table|index|function|procedure|view|schema|type|trigger|policy|sequence|extension|role|database|publication)\b/i,
    new RegExp(String.raw`\btruncate\s+(?:table\s+)?${QUALIFIED}`, "i"),
    /\b(?:grant|revoke)\s+/i,
    new RegExp(String.raw`\bcopy\s+${QUALIFIED}\s*(?:\(|from|to)\b`, "i"),
    /\breindex\b|\bvacuum\b|\bcluster\s+/i,
  ];
  for (const re of ddl) {
    if (re.test(text)) return { kind: "ddl", tables: [], why: `schema or bulk statement (${head})` };
  }

  const tables = new Set();
  const patterns = [
    new RegExp(String.raw`\binsert\s+into\s+${QUALIFIED}`, "gi"),
    // The optional alias matters: `UPDATE scans s SET ...` would otherwise miss
    // the target-table pattern entirely and fall through as a read.
    new RegExp(String.raw`\bupdate\s+(?:only\s+)?${QUALIFIED}(?:\s+(?:as\s+)?${IDENT})?\s+set\b`, "gi"),
    new RegExp(String.raw`\bdelete\s+from\s+(?:only\s+)?${QUALIFIED}`, "gi"),
    new RegExp(String.raw`\bmerge\s+into\s+${QUALIFIED}`, "gi"),
  ];
  for (const re of patterns) {
    for (const m of text.matchAll(re)) tables.add(bareIdent(m[1]));
  }
  for (const [fn, targets] of Object.entries(WRITING_FUNCTIONS)) {
    if (new RegExp(String.raw`\b${fn}\s*\(`, "i").test(text)) {
      for (const t of targets) tables.add(t);
    }
  }

  if (tables.size > 0) {
    return { kind: "write", tables: [...tables], why: `writes ${[...tables].join(", ")}` };
  }
  if (CONTROL_STATEMENTS.has(head)) return { kind: "control", tables: [], why: head };
  if (head === "select" || head === "with" || head === "values" || head === "table") {
    return { kind: "read", tables: [], why: "no write clause found" };
  }
  return { kind: "unknown", tables: [], why: `unrecognised statement head "${head}"` };
}


// ---------------------------------------------------------------------------
// The guard
// ---------------------------------------------------------------------------

/**
 * The stack of installed policies, innermost (most recently installed) last.
 * The prototype patches consult only the innermost one, so the automatic
 * install from `liveWriteGuardAuto.mjs` (which allows nothing) sits harmlessly
 * underneath a live file's own narrower install instead of double-checking
 * every write against two different allow-lists.
 */
const POLICIES = [];

/**
 * The single set of prototype patches, or null when nothing is installed.
 * Patching is done once and torn down once, however many policies stack on it.
 */
let PATCH = null;

function activePolicy() {
  return POLICIES.length > 0 ? POLICIES[POLICIES.length - 1] : null;
}

/** How many guards are currently installed. 0 means the prototypes are clean. */
export function liveWriteGuardDepth() {
  return POLICIES.length;
}

/** The label of the guard whose allow-list is currently in force, or null. */
export function activeLiveWriteGuardLabel() {
  return activePolicy()?.label ?? null;
}

/**
 * Which transports the installed patch actually covers. Both false when nothing
 * is installed. A caller about to point a test at a real database uses this to
 * tell "armed" from "armed and blind" — the two must never read the same
 * (standing rule 1).
 */
export function liveWriteGuardCoverage() {
  return PATCH ? { ...PATCH.covers } : { supabase: false, pg: false };
}

function policyHint(policy) {
  const declared = policy && policy.allowed.size ? [...policy.allowed].join(", ") : "(nothing)";
  return (
    `Declared writable here: ${declared}. ` +
    `If this write is intended and the table is disposable, pass it in ` +
    `installLiveWriteGuard({ allow: [...] }); if it is not intended, the test is missing a stub. ` +
    `The guard is armed for every test process by src/lib/liveWriteGuardAuto.mjs.`
  );
}

let orphanWarned = false;

/**
 * Refuse on behalf of whichever policy is in force. Returns the error so the
 * caller can throw it; the record and the non-zero exit code have already
 * happened, so catching the throw does not un-fail the run.
 */
function refuseHere({ operation, table, transport, hint }) {
  const policy = activePolicy();
  return refuse({
    label: policy?.label ?? "(no live write guard active)",
    operation,
    table,
    transport,
    hint: hint ?? policyHint(policy),
  });
}

/**
 * The one decision point for a write that names a table.
 *
 * Returns true when the write may proceed. A refusal is thrown, never returned:
 * "we could not tell" and "nobody said yes" both end here.
 */
function checkWrite(operation, table, transport) {
  const policy = activePolicy();
  if (!policy) {
    // Can't happen through the prototypes — they are unpatched the moment the
    // last policy is removed — but a stale reference to a patched function
    // could still land here. Say so rather than silently permitting.
    if (!orphanWarned) {
      orphanWarned = true;
      process.stderr.write(
        `\n LIVE WRITE GUARD: ${operation} on ${table ?? "(unknown table)"} reached a patch with no policy ` +
          `installed; it was NOT checked. This is a bug in liveWriteGuard.js.\n\n`
      );
    }
    return true;
  }
  const name = table == null ? null : String(table).toLowerCase();
  if (name && policy.allowed.has(name)) {
    policy.writes.push({ operation, table: name, transport });
    return true;
  }
  throw refuseHere({ operation, table: name, transport });
}

/**
 * Patch `owner[key]`, remembering what was there. Re-patches if something has
 * since replaced our function on the prototype: a guard that was displaced and
 * quietly stopped guarding is the worst outcome this file has.
 */
function patchOnce(record, owner, key, make) {
  const current = owner[key];
  if (record && record.patched === current) return record;
  const original = current;
  const patched = make(original);
  owner[key] = patched;
  return { owner, key, original, patched };
}

async function ensurePatched() {
  if (!PATCH) PATCH = { covers: { supabase: false, pg: false }, records: new Map() };
  const covers = PATCH.covers;
  const records = PATCH.records;

  // --- 1. PostgREST, at the SupabaseClient prototype -----------------------
  try {
    const mod = await import("@supabase/supabase-js");
    const proto = mod.SupabaseClient?.prototype;
    if (proto) {
      records.set(
        "supabase.from",
        patchOnce(records.get("supabase.from"), proto, "from", (origFrom) =>
          function guardedFrom(table) {
            const builder = origFrom.call(this, table);
            return new Proxy(builder, {
              get(target, prop) {
                // Read off the target, not the proxy: these builders use private
                // fields, and a receiver-swapped get would break their brand check.
                const value = target[prop];
                if (typeof prop === "string" && MUTATING_BUILDER_METHODS.includes(prop) && typeof value === "function") {
                  return (...args) => {
                    checkWrite(`${prop}()`, table, "supabase-js");
                    return value.apply(target, args);
                  };
                }
                return typeof value === "function" ? value.bind(target) : value;
              },
            });
          }
        )
      );

      records.set(
        "supabase.rpc",
        patchOnce(records.get("supabase.rpc"), proto, "rpc", (origRpc) =>
          function guardedRpc(fn, args, opts) {
            const targets = WRITING_FUNCTIONS[fn];
            if (!targets) {
              // Not "probably a reader". The guard has no way to know, and an
              // unknown function is exactly how a new writer would arrive.
              throw refuseHere({
                operation: `rpc ${fn}()`,
                table: null,
                transport: "supabase-js",
                hint:
                  `${fn} is not listed in WRITING_FUNCTIONS in src/lib/liveWriteGuard.js, so the guard ` +
                  `cannot tell whether it writes. Add it (with the tables it touches) in the same commit. ` +
                  policyHint(activePolicy()),
              });
            }
            // Every target checked before any is recorded, so a function that
            // touches an allowed table and a forbidden one is refused entire.
            const allowed = activePolicy()?.allowed ?? new Set();
            const forbidden = targets.filter((t) => !allowed.has(t));
            if (forbidden.length > 0) {
              throw refuseHere({
                operation: `rpc ${fn}()`,
                table: forbidden.join(", "),
                transport: "supabase-js",
              });
            }
            for (const t of targets) checkWrite(`rpc ${fn}()`, t, "supabase-js");
            return origRpc.call(this, fn, args, opts);
          }
        )
      );

      if (typeof proto.schema === "function") {
        records.set(
          "supabase.schema",
          patchOnce(records.get("supabase.schema"), proto, "schema", () =>
            function guardedSchema(name) {
              throw refuseHere({
                operation: `schema("${name}")`,
                table: null,
                transport: "supabase-js",
                hint:
                  "The guard cannot see through .schema(): it hands back a client whose builders it never " +
                  "patched. Use from()/rpc(), or extend the guard before using it. " +
                  policyHint(activePolicy()),
              });
            }
          )
        );
      }
      covers.supabase = true;
    } else {
      covers.supabaseWhy = "@supabase/supabase-js exports no SupabaseClient class to patch";
      process.stderr.write(`\n LIVE WRITE GUARD: ${covers.supabaseWhy}. PostgREST writes are UNGUARDED.\n\n`);
    }
  } catch (err) {
    if (err instanceof LiveWriteRefused) throw err;
    // A guard that failed to arm is the worst outcome of all: it looks
    // installed and refuses nothing. Say so, loudly, and leave covers.supabase
    // false so the caller's own assertion can fail on it.
    covers.supabaseWhy = String(err?.message || err);
    process.stderr.write(
      `\n LIVE WRITE GUARD: could NOT patch @supabase/supabase-js — ${covers.supabaseWhy}.\n` +
        ` PostgREST writes in this run are UNGUARDED.\n\n`
    );
  }

  // --- 2. Raw SQL, at the pg Client/Pool prototype -------------------------
  try {
    const { default: pg } = await import("pg");
    for (const ctorName of ["Client", "Pool"]) {
      const proto = pg[ctorName]?.prototype;
      if (!proto || typeof proto.query !== "function") continue;
      records.set(
        `pg.${ctorName}.query`,
        patchOnce(records.get(`pg.${ctorName}.query`), proto, "query", (orig) =>
          function guardedQuery(config, values, callback) {
            const sql =
              typeof config === "string" ? config : config && typeof config.text === "string" ? config.text : null;
            let error = null;
            if (sql == null) {
              error = refuseHere({
                operation: "query(<no statement text>)",
                table: null,
                transport: `pg.${ctorName}`,
                hint: "The guard could not read the SQL, so it could not classify it. " + policyHint(activePolicy()),
              });
            } else {
              const verdict = classifyStatement(sql);
              if (verdict.kind === "ddl" || verdict.kind === "unknown") {
                error = refuseHere({
                  operation: `${verdict.kind}: ${verdict.why}`,
                  table: null,
                  transport: `pg.${ctorName}`,
                });
              } else if (verdict.kind === "write") {
                // Decide over the WHOLE statement before recording anything: a
                // statement that writes an allowed table and a forbidden one in
                // the same breath is refused entire, and must not leave a record
                // saying the allowed half happened.
                const allowed = activePolicy()?.allowed ?? new Set();
                const forbidden = verdict.tables.filter((t) => !allowed.has(t));
                if (forbidden.length > 0) {
                  error = refuseHere({
                    operation: "sql write",
                    table: forbidden.join(", "),
                    transport: `pg.${ctorName}`,
                  });
                } else {
                  for (const t of verdict.tables) checkWrite("sql", t, `pg.${ctorName}`);
                }
              }
            }
            if (error) {
              // A rejected promise rather than a synchronous throw, so a caller
              // doing `.catch(() => {})` still behaves. The refusal is already
              // recorded and the exit code already non-zero, so the catch cannot
              // hide it.
              const cb = typeof values === "function" ? values : callback;
              if (typeof cb === "function") return cb(error);
              return Promise.reject(error);
            }
            return orig.call(this, config, values, callback);
          }
        )
      );
      covers.pg = true;
    }
  } catch (err) {
    if (err instanceof LiveWriteRefused) throw err;
    covers.pgWhy = String(err?.message || err);
    process.stderr.write(
      `\n LIVE WRITE GUARD: could NOT patch pg — ${covers.pgWhy}.\n Raw SQL in this run is UNGUARDED.\n\n`
    );
  }

  return PATCH;
}

function teardownPatch() {
  if (!PATCH) return;
  for (const record of PATCH.records.values()) {
    // Only restore what is still ours; if something replaced our patch we would
    // otherwise clobber it.
    if (record.owner[record.key] === record.patched) record.owner[record.key] = record.original;
  }
  PATCH = null;
}

/**
 * Install the guard for one live test file.
 *
 * Safe to call when a guard is already installed — the outer one keeps its own
 * allow-list, this one's is in force until it is uninstalled. That is how a
 * live file widens the default-deny policy that `liveWriteGuardAuto.mjs`
 * installs into every test process.
 *
 * @param {object} options
 * @param {string} options.label   which test file this is, named in every refusal.
 * @param {string[]} [options.allow] tables this file may write. DEFAULT: none.
 * @returns {Promise<object>} handle with `uninstall()`, `refusals`, `writes`,
 *   `covers` (what actually got patched) and `assertClean()`.
 */
export async function installLiveWriteGuard({ label, allow = [] } = {}) {
  if (!label || typeof label !== "string") {
    throw new Error("installLiveWriteGuard needs a label: every refusal has to name the file it came from");
  }
  const allowed = new Set();
  for (const t of allow) {
    const name = String(t).toLowerCase();
    if (NEVER_WRITABLE.includes(name)) {
      throw new Error(
        `installLiveWriteGuard: "${name}" is customer data and can never be opened for writing by a test. ` +
          `Writing two rows into scans and two into brand_metrics_daily is the incident this guard exists for.`
      );
    }
    if (!WRITABLE_BY_OPT_IN.includes(name)) {
      throw new Error(
        `installLiveWriteGuard: "${name}" is not a table a live test may write. Writable by opt-in: ` +
          `${WRITABLE_BY_OPT_IN.join(", ")}. If "${name}" is genuinely disposable, add it to ` +
          `WRITABLE_BY_OPT_IN in src/lib/liveWriteGuard.js in the same commit as the test that needs it.`
      );
    }
    allowed.add(name);
  }

  const policy = { label, allowed, writes: [] };
  POLICIES.push(policy);

  let patch;
  try {
    patch = await ensurePatched();
  } catch (err) {
    POLICIES.splice(POLICIES.indexOf(policy), 1);
    if (POLICIES.length === 0) teardownPatch();
    throw err;
  }

  return {
    label,
    allowed: [...allowed],
    covers: patch.covers,
    /**
     * Every write the guard PERMITTED under this policy, in order. It records
     * the attempt at the moment it was allowed through, not the row count that
     * came back, so it answers "was this guard ever asked to do anything" —
     * which is how a live file tells a clean run from a guard that was never
     * exercised at all.
     */
    get writes() {
      return policy.writes.map((w) => ({ ...w }));
    },
    get refusals() {
      return REFUSALS.filter((r) => r.label === label).map((r) => ({ ...r }));
    },
    /** For a CLEANUP case: this file refused nothing, so nothing went unnoticed. */
    assertClean() {
      const mine = REFUSALS.filter((r) => r.label === label);
      if (mine.length > 0) {
        throw new LiveWriteRefused(
          `${label} attempted ${mine.length} forbidden write(s): ` + mine.map((r) => r.message).join(" | "),
          mine
        );
      }
    },
    /**
     * Remove this policy. The prototypes are only restored when the LAST policy
     * goes: under the automatic install there is always one underneath, so an
     * inner uninstall narrows the allow-list back to nothing rather than
     * disarming the process.
     */
    uninstall() {
      const at = POLICIES.indexOf(policy);
      if (at === -1) return;
      POLICIES.splice(at, 1);
      if (POLICIES.length === 0) teardownPatch();
    },
  };
}
