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
 * WHAT IT DOES NOT COVER — read this before trusting it
 *   - A test that never installs the guard. Nothing here can reach out and
 *     protect a file that did not opt in; that is why the three live files each
 *     install it at module scope, so the copy-paste template carries it.
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
export const WRITABLE_BY_OPT_IN = Object.freeze(["scan_runs", "probe_tasks"]);

/**
 * The tables the incident actually touched, plus their neighbours: everything a
 * customer's account is made of. These are refused even when a test names them,
 * because there is no version of "a test needs to write to `scans`" that is not
 * a bug in the test. `scans` and `brand_metrics_daily` are first in the list
 * for the obvious reason.
 */
export const NEVER_WRITABLE = Object.freeze([
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
]);

/**
 * The SQL functions that write, and what they write. A `.rpc()` call to a name
 * absent from this map is refused: the guard cannot tell a reporting function
 * from a mutating one, and "we could not tell" must not resolve to "allow".
 */
export const WRITING_FUNCTIONS = Object.freeze({
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
 * Install the guard for one live test file.
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

  const writes = [];
  const restores = [];
  const covers = { supabase: false, pg: false };

  const hint =
    `Declared writable here: ${allowed.size ? [...allowed].join(", ") : "(nothing)"}. ` +
    `If this write is intended and the table is disposable, pass it in ` +
    `installLiveWriteGuard({ allow: [...] }); if it is not intended, the test is missing a stub.`;

  const check = (operation, table, transport) => {
    const name = table == null ? null : String(table).toLowerCase();
    if (name && allowed.has(name)) {
      writes.push({ operation, table: name, transport });
      return;
    }
    throw refuse({ label, operation, table: name, transport, hint });
  };

  // --- 1. PostgREST, at the SupabaseClient prototype -----------------------
  try {
    const mod = await import("@supabase/supabase-js");
    const proto = mod.SupabaseClient?.prototype;
    if (proto) {
      const origFrom = proto.from;
      const origRpc = proto.rpc;
      const origSchema = proto.schema;

      proto.from = function guardedFrom(table) {
        const builder = origFrom.call(this, table);
        return new Proxy(builder, {
          get(target, prop) {
            // Read off the target, not the proxy: these builders use private
            // fields, and a receiver-swapped get would break their brand check.
            const value = target[prop];
            if (typeof prop === "string" && MUTATING_BUILDER_METHODS.includes(prop) && typeof value === "function") {
              return (...args) => {
                check(`${prop}()`, table, "supabase-js");
                return value.apply(target, args);
              };
            }
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
      };

      proto.rpc = function guardedRpc(fn, args, opts) {
        const targets = WRITING_FUNCTIONS[fn];
        if (!targets) {
          // Not "probably a reader". The guard has no way to know, and an
          // unknown function is exactly how a new writer would arrive.
          throw refuse({
            label,
            operation: `rpc ${fn}()`,
            table: null,
            transport: "supabase-js",
            hint:
              `${fn} is not listed in WRITING_FUNCTIONS in src/lib/liveWriteGuard.js, so the guard ` +
              `cannot tell whether it writes. Add it (with the tables it touches) in the same commit. ` +
              hint,
          });
        }
        // Every target checked before any is recorded, so a function that
        // touches an allowed table and a forbidden one is refused entire.
        const forbidden = targets.filter((t) => !allowed.has(t));
        if (forbidden.length > 0) {
          throw refuse({
            label,
            operation: `rpc ${fn}()`,
            table: forbidden.join(", "),
            transport: "supabase-js",
            hint,
          });
        }
        for (const t of targets) check(`rpc ${fn}()`, t, "supabase-js");
        return origRpc.call(this, fn, args, opts);
      };

      if (typeof origSchema === "function") {
        proto.schema = function guardedSchema(name) {
          throw refuse({
            label,
            operation: `schema("${name}")`,
            table: null,
            transport: "supabase-js",
            hint:
              "The guard cannot see through .schema(): it hands back a client whose builders it never " +
              "patched. Use from()/rpc(), or extend the guard before using it. " + hint,
          });
        };
      }

      restores.push(() => {
        proto.from = origFrom;
        proto.rpc = origRpc;
        if (typeof origSchema === "function") proto.schema = origSchema;
      });
      covers.supabase = true;
    } else {
      covers.supabaseWhy = "@supabase/supabase-js exports no SupabaseClient class to patch";
      process.stderr.write(
        `\n LIVE WRITE GUARD (${label}): ${covers.supabaseWhy}. PostgREST writes are UNGUARDED.\n\n`
      );
    }
  } catch (err) {
    if (err instanceof LiveWriteRefused) throw err;
    // A guard that failed to arm is the worst outcome of all: it looks
    // installed and refuses nothing. Say so, loudly, and leave covers.supabase
    // false so the caller's own assertion can fail on it.
    covers.supabaseWhy = String(err?.message || err);
    process.stderr.write(
      `\n LIVE WRITE GUARD (${label}): could NOT patch @supabase/supabase-js — ${covers.supabaseWhy}.\n` +
        ` PostgREST writes in this run are UNGUARDED.\n\n`
    );
  }

  // --- 2. Raw SQL, at the pg Client/Pool prototype -------------------------
  try {
    const { default: pg } = await import("pg");
    for (const ctorName of ["Client", "Pool"]) {
      const proto = pg[ctorName]?.prototype;
      if (!proto || typeof proto.query !== "function") continue;
      const orig = proto.query;
      proto.query = function guardedQuery(config, values, callback) {
        const sql = typeof config === "string" ? config : config && typeof config.text === "string" ? config.text : null;
        let error = null;
        if (sql == null) {
          error = refuse({
            label,
            operation: "query(<no statement text>)",
            table: null,
            transport: `pg.${ctorName}`,
            hint: "The guard could not read the SQL, so it could not classify it. " + hint,
          });
        } else {
          const verdict = classifyStatement(sql);
          if (verdict.kind === "ddl" || verdict.kind === "unknown") {
            error = refuse({
              label,
              operation: `${verdict.kind}: ${verdict.why}`,
              table: null,
              transport: `pg.${ctorName}`,
              hint: hint,
            });
          } else if (verdict.kind === "write") {
            // Decide over the WHOLE statement before recording anything: a
            // statement that writes an allowed table and a forbidden one in the
            // same breath is refused entire, and must not leave a record saying
            // the allowed half happened.
            const forbidden = verdict.tables.filter((t) => !allowed.has(t));
            if (forbidden.length > 0) {
              error = refuse({
                label,
                operation: "sql write",
                table: forbidden.join(", "),
                transport: `pg.${ctorName}`,
                hint,
              });
            } else {
              for (const t of verdict.tables) {
                writes.push({ operation: "sql", table: t, transport: `pg.${ctorName}` });
              }
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
      };
      restores.push(() => {
        proto.query = orig;
      });
      covers.pg = true;
    }
  } catch (err) {
    if (err instanceof LiveWriteRefused) throw err;
    covers.pgWhy = String(err?.message || err);
    process.stderr.write(
      `\n LIVE WRITE GUARD (${label}): could NOT patch pg — ${covers.pgWhy}.\n` +
        ` Raw SQL in this run is UNGUARDED.\n\n`
    );
  }

  return {
    label,
    allowed: [...allowed],
    covers,
    /**
     * Every write the guard PERMITTED, in order. It records the attempt at the
     * moment it was allowed through, not the row count that came back, so it
     * answers "was this guard ever asked to do anything" — which is how a live
     * file tells a clean run from a guard that was never exercised at all.
     */
    get writes() {
      return writes.map((w) => ({ ...w }));
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
    uninstall() {
      while (restores.length) restores.pop()();
    },
  };
}
