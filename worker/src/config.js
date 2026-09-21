/**
 * Fleet configuration, read once at boot — and VALIDATED once at boot (R1.2.6).
 *
 * Deliberately its own file with no imports from the web app: the whole point
 * of this workspace (R1.2.1) is that the fleet runs on a container host that
 * has never heard of Next. Anything shared with `src/` gets COPIED here rather
 * than imported, and the guard test enforces that.
 *
 * WHY VALIDATION IS NOT OPTIONAL HERE
 * The first cut of this file read every FLEET_* variable through a helper that
 * fell back to a default when the value would not parse and clamped it into
 * range when it would. `FLEET_BATCH_SIZE=abc` became 5. `FLEET_BATCH_SIZE=9999`
 * became 50. `FLEET_IDLE_POLL_MS=banana` became 10000. `FLEET_ENGINES=,` became
 * an empty engine filter, which the claim converts to "every engine" — the
 * opposite of what a per-surface container was configured for. Every one of
 * those booted, logged a healthy start line, and then behaved as though the
 * resulting number had been chosen on purpose.
 *
 * That is how a dead surface starts reporting confident zeros: nobody typed the
 * value the fleet is running on, so nobody can be wrong about it. A config the
 * operator got wrong must stop the container at boot, name the variable, and
 * say what was wrong with it — never degrade quietly and never mid-probe.
 *
 * WHAT IS NOT ECHOED
 * `SUPABASE_SERVICE_ROLE_KEY` is marked `secret` below and its VALUE never
 * appears in an error message, a log line, or `describeConfig`. Validation
 * errors are the classic place a credential leaks into a container log, because
 * "what was wrong with it" is so nearly "here is what you set". The spec makes
 * the distinction data rather than discipline.
 */

// node:os only. A Node builtin is not "the web app": the isolation rule
// (R1.2.1) forbids importing from `src/`, not from the platform.
import os from "node:os";

/**
 * The consumer surfaces this fleet has (or will have) an adapter for.
 *
 * Frozen and CHECKED, because `FLEET_ENGINES=gogle` is not a harmless typo: the
 * claim filters `probe_tasks` by engine, so a misspelt surface claims nothing,
 * forever, while every pass writes a perfectly truthful `queue_empty` idle row.
 * An operator reading that ledger sees an idle fleet, not a misconfigured one.
 * Refusing at boot is the only place the two are still distinguishable.
 *
 * `chatgpt` is here before its adapter (R1.4) on purpose: this list is the
 * vocabulary of what may be REQUESTED, and R1.3/R1.4 land the adapters behind
 * it. `probeBatch` still refuses out loud for a surface it cannot yet drive.
 */
export const FLEET_ENGINES = Object.freeze(["perplexity", "chatgpt"]);

/**
 * §3.2 of `docs/contracts/politeness-budget.md`, as data — the ONE code
 * representation of the per-surface politeness budget for the surfaces this
 * fleet drives.
 *
 * Keyed by the fleet's own engine id, because that is what `FLEET_ENGINES`
 * names and what `probe_tasks.engine` stores, so a claimed task indexes its
 * budget directly. `surface` carries the contract row's name so the two can be
 * matched by eye.
 *
 * WHY ONLY TWO OF §3.2's FIVE ROWS ARE HERE. The other three rows
 * (`api.perplexity.ai`, `api.openai.com`, Bright Data → Google SERP) are driven
 * by `src/`, not by this fleet, and their concurrency ALREADY has a code
 * representation: `AIO_CONCURRENCY` in `src/lib/scoring/aioConstants.js` and
 * `CHATGPT_CONCURRENCY` / `PERPLEXITY_CONCURRENCY` in
 * `src/lib/scoring/enginePipeline.js`. Copying them here would give those
 * numbers TWO representations that nothing keeps in step — which is the defect
 * this table exists to prevent, not a fix for it. Those three constants are
 * still hard-coded, still unreadable from the environment, and the contract's
 * §5.4 and §6 V3 say so out loud. This table does not pretend otherwise.
 *
 * EVERY NUMBER HERE WAS CHOSEN, NOT MEASURED (contract §8). No block rate, no
 * rate-limit threshold and no probe duration has been observed for either
 * surface. They are a bound on our behaviour, not a model of the vendor's.
 */
export const SURFACE_BUDGETS = Object.freeze({
  perplexity: Object.freeze({
    surface: "perplexity.ai",
    /** `engine-surface-matrix.md` row this came from. */
    matrixRow: 4,
    maxConcurrency: 1,
    ceilingWhy:
      "A logged-out consumer UI is a claim to be one person, and two simultaneous " +
      "requests from one session is the cheapest possible contradiction of it (§3.3).",
    probeDelayMinMs: 20_000,
    probeDelayMaxMs: 45_000,
    dailyCap: 400,
  }),
  chatgpt: Object.freeze({
    surface: "chatgpt.com",
    matrixRow: 5,
    maxConcurrency: 1,
    ceilingWhy:
      "A logged-out consumer UI is a claim to be one person, and two simultaneous " +
      "requests from one session is the cheapest possible contradiction of it (§3.3).",
    probeDelayMinMs: 30_000,
    probeDelayMaxMs: 90_000,
    dailyCap: 200,
  }),
});

/**
 * Which engines in the vocabulary have a budget row and which do not.
 *
 * Exported so a test asserts the coverage rather than a comment claiming it: an
 * engine added to {@link FLEET_ENGINES} without a §3.2 row would otherwise be
 * probed at whatever rate falls out of `FLEET_BATCH_SIZE`, which is the
 * accident the whole contract exists to replace with a decision.
 */
export function surfaceBudgetCoverage() {
  return {
    covered: FLEET_ENGINES.filter((e) => Boolean(SURFACE_BUDGETS[e])),
    uncovered: FLEET_ENGINES.filter((e) => !SURFACE_BUDGETS[e]),
  };
}

/**
 * Every variable the fleet reads, with `required` stated rather than implied.
 *
 * REQUIRED means the fleet cannot do its job without it and must refuse to
 * start. Only the two Supabase values qualify: with no queue to read, a worker
 * polls nothing forever and reports itself perfectly healthy.
 *
 * OPTIONAL means an ABSENT variable takes the stated default, which is a real
 * decision made here and documented in worker/README.md. Optional does NOT mean
 * lenient: a variable that is PRESENT is a value someone typed, so blank,
 * unparseable and out-of-range are all refusals for optional fields too. The
 * rejected alternative was to keep clamping — "0 < 1, so use 1" — which turns
 * `FLEET_BATCH_SIZE=0` (probably a disable attempt) into a running fleet whose
 * batch size nobody chose.
 */
export const CONFIG_FIELDS = Object.freeze([
  Object.freeze({
    name: "SUPABASE_URL",
    required: true,
    kind: "url",
    alsoAccepts: Object.freeze(["NEXT_PUBLIC_SUPABASE_URL"]),
    why: "the probe_tasks queue to read",
  }),
  Object.freeze({
    name: "SUPABASE_SERVICE_ROLE_KEY",
    required: true,
    kind: "text",
    secret: true,
    alsoAccepts: Object.freeze(["NEXT_PUBLIC_SUPABASE_ANON_KEY"]),
    why: "credentials for that queue",
  }),
  Object.freeze({
    name: "FLEET_ALLOW_PRODUCTION_DB",
    required: false,
    kind: "boolean",
    alsoAccepts: Object.freeze(["FLEET_ARM_PRODUCTION_DB"]),
    fallback: false,
    why: "explicit arming flag required to run the fleet against the production database (R1.2.12)",
  }),
  Object.freeze({
    name: "FLEET_ENGINES",
    required: false,
    kind: "enumList",
    vocabulary: FLEET_ENGINES,
    fallback: Object.freeze(["perplexity"]),
    why: "which real surfaces this container drives",
  }),
  Object.freeze({
    name: "FLEET_BATCH_SIZE",
    required: false,
    kind: "int",
    min: 1,
    max: 50,
    fallback: 5,
    why: "tasks claimed per poll",
  }),
  Object.freeze({
    name: "FLEET_LEASE_MS",
    required: false,
    kind: "int",
    min: 30_000,
    max: 3_600_000,
    fallback: 300_000,
    why: "how long a claim is held before it can be reaped",
  }),
  Object.freeze({
    name: "FLEET_IDLE_POLL_MS",
    required: false,
    kind: "int",
    min: 1_000,
    max: 300_000,
    fallback: 10_000,
    why: "gap between polls when the queue was empty",
  }),
  Object.freeze({
    name: "FLEET_HEARTBEAT_MS",
    required: false,
    kind: "int",
    min: 5_000,
    max: 600_000,
    fallback: 30_000,
    why: "how often an in-flight run says it is alive",
  }),
  Object.freeze({
    name: "FLEET_WORKER_ID",
    required: false,
    kind: "text",
    fallback: null, // computed: worker-<hostname>-<pid> (R1.2.22)
    why: "identity written onto every claim and heartbeat",
  }),

  /* ------------------------------------------------------------------ *
   * The politeness budget (R1.1.5 §5.2).
   *
   * Four of these have NO scalar default: absent means "each surface takes
   * its own row in SURFACE_BUDGETS", and a value that IS set overrides every
   * surface this container drives. `fallback: null` therefore means "no
   * override", never "zero" — the resolved number is always a real one from
   * the table, and `fallbackText` is what the blank-value message offers.
   * ------------------------------------------------------------------ */
  Object.freeze({
    name: "FLEET_MAX_CONCURRENCY",
    required: false,
    kind: "int",
    min: 1,
    max: 2,
    fallback: null,
    fallbackText: "each surface's own ceiling (1 for both surfaces the fleet drives today)",
    why: "in-flight probes of one surface, per egress IP",
  }),
  Object.freeze({
    name: "FLEET_PROBE_DELAY_MIN_MS",
    required: false,
    kind: "int",
    min: 0,
    max: 600_000,
    fallback: null,
    fallbackText: "each surface's own window (perplexity.ai 20000, chatgpt.com 30000)",
    why: "lower bound of the random inter-probe delay",
  }),
  Object.freeze({
    name: "FLEET_PROBE_DELAY_MAX_MS",
    required: false,
    kind: "int",
    min: 0,
    max: 600_000,
    fallback: null,
    fallbackText: "each surface's own window (perplexity.ai 45000, chatgpt.com 90000)",
    why: "upper bound of the random inter-probe delay; must exceed the lower bound",
  }),
  Object.freeze({
    name: "FLEET_DAILY_CAP",
    required: false,
    kind: "int",
    min: 1,
    max: 100_000,
    fallback: null,
    fallbackText: "each surface's own cap (perplexity.ai 400, chatgpt.com 200)",
    why: "probe attempts against one surface per UTC day",
  }),
  Object.freeze({
    name: "FLEET_CANARY_INTERVAL_MS",
    required: false,
    kind: "int",
    min: 300_000,
    max: 86_400_000,
    fallback: 3_600_000,
    why: "gap between canary probes of one surface",
  }),
  /**
   * §5.2's boot-time check is stated as
   * `FLEET_BATCH_SIZE × (FLEET_PROBE_DELAY_MAX_MS + a probe's own timeout)`,
   * and "a probe's own timeout" had NO representation anywhere in the tree:
   * `probeBatch` throws before it can time out, so the fleet has never had one.
   * The alternative was a bare constant in this file, which is the hard-coded
   * term the second half of R1.1.5's accept exists to remove — so it is a
   * field like the rest: operator-visible, range-checked, printed at boot.
   * 60,000 ms is CHOSEN, not measured; §3.2's arithmetic assumes a UI probe
   * takes ~30 s, and a timeout is a ceiling rather than a typical duration.
   */
  Object.freeze({
    name: "FLEET_PROBE_TIMEOUT_MS",
    required: false,
    kind: "int",
    min: 5_000,
    max: 600_000,
    fallback: 60_000,
    why: "how long one probe may run before it is abandoned",
  }),
]);

/** Quick lookup, so a caller can ask whether a field is required without a scan. */
const FIELD_BY_NAME = new Map(CONFIG_FIELDS.map((f) => [f.name, f]));

/** Is this variable required to start? Exported so tests assert the choice, not the prose. */
export function isRequired(name) {
  const field = FIELD_BY_NAME.get(name);
  if (!field) throw new Error(`isRequired: ${name} is not a fleet configuration variable`);
  return field.required;
}

/**
 * A boot refusal carrying every problem found, not just the first.
 *
 * ALL PROBLEMS AT ONCE is the whole ergonomic point. A validator that threw on
 * the first bad variable makes an operator with five wrong values redeploy five
 * times, and the fifth deploy is where someone gives up and deletes the check.
 *
 * `.missing` keeps the names of absent REQUIRED variables on their own, because
 * that is R1.2.6's acceptance criterion: starting without a required var exits
 * non-zero with the missing names listed.
 */
export class FleetConfigError extends Error {
  constructor(problems) {
    // Blank counts as missing here on purpose: `SUPABASE_URL=""` supplies no
    // queue, and an operator scanning for "which variable did I not supply"
    // must find it in the same list as the one they forgot entirely.
    const missing = problems
      .filter((p) => p.required && (p.kind === "missing" || p.kind === "blank"))
      .map((p) => p.name);
    super(
      `The fleet refuses to start: ${problems.length} configuration problem(s).\n` +
        problems.map((p) => `  - ${p.message}`).join("\n") +
        (missing.length
          ? `\nRequired variable(s) missing or blank: ${missing.join(", ")}. ` +
            `A worker with no queue to read would poll nothing forever and report itself healthy.`
          : "")
    );
    this.name = "FleetConfigError";
    this.problems = problems;
    this.missing = missing;
  }
}

/** Raw lookup across a field's primary name and its accepted aliases. */
function readRaw(env, field) {
  for (const name of [field.name, ...(field.alsoAccepts || [])]) {
    const value = env[name];
    if (value !== undefined && value !== null) return { source: name, value: String(value) };
  }
  return { source: field.name, value: undefined };
}

/**
 * Parse one field. Returns `{ value }` or `{ problem }` — never both, and never
 * a fallback standing in for a value the operator actually set.
 */
function parseField(field, raw) {
  const { name, why } = field;
  const present = raw.value !== undefined;
  const trimmed = present ? raw.value.trim() : "";

  if (!present) {
    if (field.required) {
      const alts = field.alsoAccepts || [];
      return {
        problem: {
          name,
          kind: "missing",
          message:
            `${name} is not set, and it is required (${why})` +
            (alts.length ? ` — ${alts.join(" or ")} is also accepted` : ""),
        },
      };
    }
    return { value: field.fallback, defaulted: true };
  }

  // BLANK IS NOT ABSENT. Someone wrote `FLEET_BATCH_SIZE=` and meant something
  // by it; guessing which default they meant is the failure mode this task
  // exists to remove. The message says how to ask for the default explicitly.
  if (trimmed === "") {
    return {
      problem: {
        name,
        kind: "blank",
        message: field.required
          ? `${raw.source} is set but blank, and it is required (${why})`
          : `${raw.source} is set but blank. Blank is not the same as unset: remove the ` +
            `variable to accept the default (${describeFallback(field)}), or give it a value.`,
      },
    };
  }

  if (field.kind === "boolean") {
    const lower = trimmed.toLowerCase();
    if (lower === "true" || lower === "1" || lower === "yes") return { value: true };
    if (lower === "false" || lower === "0" || lower === "no") return { value: false };
    return {
      problem: {
        name,
        kind: "unparseable",
        message: `${name}="${trimmed}" is not a boolean (${why}); expected true or false`,
      },
    };
  }

  if (field.kind === "int") {
    // /^[+-]?\d+$/ and not parseInt: parseInt("5x") is 5 and parseInt("5.9") is
    // 5, so both would have run on a number nobody typed.
    if (!/^[+-]?\d+$/.test(trimmed)) {
      return {
        problem: {
          name,
          kind: "unparseable",
          message: `${name}="${trimmed}" is not a whole number (${why}); expected an integer between ${field.min} and ${field.max}`,
        },
      };
    }
    const n = Number(trimmed);
    if (!Number.isSafeInteger(n)) {
      return {
        problem: {
          name,
          kind: "unparseable",
          message: `${name}="${trimmed}" is too large to be a safe integer (${why})`,
        },
      };
    }
    if (n < field.min || n > field.max) {
      // NOT CLAMPED. A clamp answers "what should I run on?" with a number the
      // operator never chose, and then the container looks configured.
      return {
        problem: {
          name,
          kind: "out_of_range",
          message: `${name}=${n} is out of range (${why}); it must be between ${field.min} and ${field.max}`,
        },
      };
    }
    return { value: n };
  }

  if (field.kind === "enumList") {
    const items = trimmed
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    if (!items.length) {
      return {
        problem: {
          name,
          kind: "empty_list",
          message:
            `${name}="${trimmed}" names no engines. An empty engine filter is not "no engines": ` +
            `the claim reads it as EVERY engine, so this container would claim surfaces it was ` +
            `not configured for. Known engines: ${field.vocabulary.join(", ")}.`,
        },
      };
    }
    const unknown = items.filter((e) => !field.vocabulary.includes(e));
    if (unknown.length) {
      return {
        problem: {
          name,
          kind: "unknown_value",
          message:
            `${name} names unknown engine(s): ${unknown.join(", ")}. Known engines: ` +
            `${field.vocabulary.join(", ")}. A misspelt engine claims nothing forever while ` +
            `every pass logs an honest "queue is empty" — an idle fleet and a misconfigured ` +
            `one would be indistinguishable from that point on.`,
        },
      };
    }
    const seen = new Set();
    const deduped = items.filter((e) => (seen.has(e) ? false : (seen.add(e), true)));
    return { value: Object.freeze(deduped) };
  }

  // kind: "text" / "url"
  if (field.kind === "url") {
    let parsed;
    try {
      parsed = new URL(trimmed);
    } catch {
      return {
        problem: {
          name,
          kind: "unparseable",
          // The URL is not a credential, but it is quoted rather than
          // interpolated bare so a value with spaces is legible.
          message: `${raw.source}="${trimmed}" is not a URL (${why})`,
        },
      };
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return {
        problem: {
          name,
          kind: "unparseable",
          message: `${raw.source}="${trimmed}" is not an http(s) URL (${why})`,
        },
      };
    }
    return { value: trimmed };
  }

  return { value: trimmed };
}

/** Human text for a field's default, used only in messages. */
function describeFallback(field) {
  if (field.name === "FLEET_WORKER_ID") return "worker-<hostname>-<pid>";
  // A per-surface field has no scalar default, and "null" is not an answer an
  // operator can act on.
  if (field.fallbackText) return field.fallbackText;
  if (Array.isArray(field.fallback)) return field.fallback.join(",");
  return String(field.fallback);
}

/**
 * Extract a comparable target from a URL string, or null if not a URL.
 *
 * Returns only the hostname — NOT the pathname — because the worker compares
 * across protocol families: an HTTPS Supabase URL (`https://host/path`) and a
 * PostgreSQL connection string (`postgresql://...host:5432/dbname`) name the
 * same server but carry different pathnames (the API path vs the database
 * name). Including the pathname would make them never match.
 *
 * Shape derived from src/lib/liveDbGate.js:dbTarget per worker isolation
 * (R1.2.1), narrowed to hostname-only for the cross-protocol case.
 */
function dbTarget(value) {
  try {
    const u = new URL(value);
    return u.hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Compare two database targets by host and path (ignoring credentials, query params, etc.).
 * Shape copied from src/lib/liveDbGate.js:namesSameTarget.
 */
function namesSameTarget(value, real) {
  if (value === real) return true;
  if (typeof value !== "string" || value === "" || typeof real !== "string" || real === "") return false;
  const a = dbTarget(value);
  return a !== null && a === dbTarget(real);
}

/**
 * Checks whether the production arming flag is explicitly set.
 * Supports FLEET_ALLOW_PRODUCTION_DB and FLEET_ARM_PRODUCTION_DB.
 */
function isArmedForProduction(env) {
  if (!env || typeof env !== "object") return false;
  const v = env.FLEET_ALLOW_PRODUCTION_DB ?? env.FLEET_ARM_PRODUCTION_DB;
  if (v === true || v === 1) return true;
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    return s === "true" || s === "1" || s === "yes";
  }
  return false;
}

/**
 * Longest host label kept in a computed worker id.
 *
 * `probe_tasks.lease_owner` and `scan_runs.worker_id` are both unconstrained
 * `text` (supabase/migrations/010_probe_tasks.sql:43, 011_scan_runs.sql:93), so
 * nothing in the database truncates for us — which is precisely why this file
 * bounds it. A 300-character hostname would travel through every claim, renew,
 * complete and heartbeat RPC and into every log line. 63 is the DNS label limit
 * and therefore the longest a real Kubernetes pod name can be, so the bound
 * never cuts a legitimate id.
 */
const WORKER_ID_HOST_MAX = 63;

/**
 * Reduce a hostname to the characters an owner string is safe to carry.
 *
 * Kept deliberately narrow — lowercase letters, digits, `.`, `_` and `-` — which
 * is a superset of what a Kubernetes pod name can contain and a subset of what
 * survives a log line, a JSON payload and a SQL string literal unchanged. Every
 * other character (spaces, slashes, quotes, control bytes, unicode) collapses to
 * a single `-`, so a hostile or merely odd hostname becomes ugly, never unsafe
 * and never an exception.
 *
 * Returns "" when nothing usable is left, so the caller can say so rather than
 * emit `worker--7`.
 */
function sanitiseHostLabel(raw) {
  if (typeof raw !== "string") return "";
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, WORKER_ID_HOST_MAX)
    .replace(/[-.]+$/g, "");
}

/**
 * The worker identity used when `FLEET_WORKER_ID` is not set: `worker-<host>-<pid>`.
 *
 * WHY NOT THE PID ALONE (R1.2.22). The previous default was `worker-${pid}`.
 * Under tini in a container the node process is always pid 7, so every pod,
 * every restart and every replica wrote `scan_runs.worker_id = "worker-7"` and
 * claimed `probe_tasks` under that one owner string — 126 production rows on
 * 2026-09-19, all identical. A ledger row could not be traced to a pod, and two
 * replicas sharing an owner string defeats the lease: a renew or release scoped
 * to the owner cannot tell them apart, which is the one thing the lease exists
 * to do. `worker/k8s/fleet.yaml` sets FLEET_WORKER_ID from the pod name, but the
 * ratified host (docs/decisions/2026-09-05-worker-host.md) deploys through the
 * Zeabur UI from the Dockerfile and never applies that manifest, so the DEFAULT
 * is what actually runs in production. It has to be unique on its own.
 *
 * The hostname is the pod name under Kubernetes and unique per pod. The pid stays
 * as a suffix for the bare-metal case where several workers share one host.
 *
 * When the hostname is unusable — `os.hostname()` threw, or sanitised away to
 * nothing — the id says `unknown-host` out loud rather than silently degrading
 * back to a pid-only string that looks deliberate. Two pods would still collide
 * there, so the id must make that visible in the ledger.
 */
export function defaultWorkerId(hostname, pid = process.pid) {
  const host = sanitiseHostLabel(hostname);
  return `worker-${host || "unknown-host"}-${pid}`;
}

/** `os.hostname()` without letting a platform failure stop the boot. */
function safeHostname() {
  try {
    return os.hostname();
  } catch {
    return "";
  }
}

/**
 * Resolve and validate the fleet's configuration.
 *
 * `strict` decides ONLY what a missing credential means — it does not turn
 * validation off. Booting the real fleet without Supabase is fatal (it would
 * poll nothing forever and look healthy doing it), so `start()` demands it;
 * `--selftest` does not, because proving the workspace starts standalone must
 * not require a database. A malformed FLEET_* value is wrong either way, and
 * `--selftest` is exactly where an operator should find out.
 *
 * `hostname` and `pid` are injected the same way `env` is — passed in, defaulted
 * to the real thing, and never read from the platform behind the caller's back
 * once given. They exist so a test can pin the computed `workerId` (R1.2.22)
 * without depending on the machine running the suite.
 *
 * Throws {@link FleetConfigError} listing every problem at once.
 */
export function resolveConfig(env = process.env, { strict = true, hostname, pid } = {}) {
  const problems = [];
  const values = {};
  const defaulted = new Set();
  const rawSources = {};

  for (const field of CONFIG_FIELDS) {
    const raw = readRaw(env, field);
    rawSources[field.name] = raw.source;
    const result = parseField(field, raw);
    if (result.problem) {
      // Tagged centrally so the error can separate "a credential the fleet
      // cannot run without" from "a tuning value someone mistyped" without
      // reaching back into the field table.
      problems.push({ ...result.problem, required: field.required });
      continue;
    }
    values[field.name] = result.value;
    if (result.defaulted) defaulted.add(field.name);
  }

  // --- R1.2.12: Production Database Protection Guard ---
  // A worker process refuses to start against the production database unless
  // explicitly armed, in the same shape liveDbGate uses for tests.
  const isArmed = Boolean(values.FLEET_ALLOW_PRODUCTION_DB) || isArmedForProduction(env);
  const resolvedUrl = values.SUPABASE_URL;

  if (resolvedUrl) {
    const inheritedAppCreds =
      rawSources.SUPABASE_URL === "NEXT_PUBLIC_SUPABASE_URL" ||
      rawSources.SUPABASE_SERVICE_ROLE_KEY === "NEXT_PUBLIC_SUPABASE_ANON_KEY";

    // Only inspect the env that was PASSED in, never peek at process.env
    // behind the caller's back. Tests pass a clean env and must not be
    // affected by NODE_ENV or credentials on the developer's machine.
    // A real worker process passes process.env itself, so those values
    // are visible through `env` when they matter.
    const matchesAppTarget =
      namesSameTarget(resolvedUrl, env.NEXT_PUBLIC_SUPABASE_URL) ||
      namesSameTarget(resolvedUrl, env.DATABASE_URL);

    const matchesExplicitProd =
      namesSameTarget(resolvedUrl, env.PRODUCTION_SUPABASE_URL);

    const isProductionEnv = env.NODE_ENV === "production";

    const isProductionTarget = inheritedAppCreds || matchesAppTarget || matchesExplicitProd || isProductionEnv;

    if (isProductionTarget && !isArmed) {
      problems.push({
        name: "SUPABASE_URL",
        required: true,
        kind: "production_refusal",
        message:
          `the fleet refuses to start against the production database without explicit arming (R1.2.12). ` +
          `The target database (${resolvedUrl}) matches application database credentials or was inherited ` +
          `from ${rawSources.SUPABASE_URL}. A laptop worker must use an isolated dev Supabase instance ` +
          `(see docs/runbooks/fleet-dev.md), or set FLEET_ALLOW_PRODUCTION_DB=true ` +
          `(or FLEET_ARM_PRODUCTION_DB=true) to explicitly arm production writes.`,
      });
      // R1.2.17: When unarmed against production, strip production credentials completely.
      // A process must NEVER hold live production credentials while reporting itself unarmed.
      values.SUPABASE_URL = null;
      values.SUPABASE_SERVICE_ROLE_KEY = null;
    }
  }

  // Absent-or-blank REQUIRED credentials are what `strict:false` forgives, and
  // nothing else. Their names still travel on `missing` so --selftest can say
  // out loud that it is running on stubs.
  const credentialProblems = problems.filter(
    (p) => p.required && (p.kind === "missing" || p.kind === "blank")
  );
  const missing = credentialProblems.map((p) => p.name);

  const fatal = strict
    ? problems
    : problems.filter((p) => !credentialProblems.includes(p) && p.kind !== "production_refusal");
  if (fatal.length) throw new FleetConfigError(fatal);

  const leaseMs = values.FLEET_LEASE_MS;
  const requestedHeartbeat = values.FLEET_HEARTBEAT_MS;
  const heartbeatCeiling = Math.floor(leaseMs / 2);

  /**
   * The heartbeat must beat at least twice per lease, and that is a correctness
   * bound rather than a preference: a run whose heartbeat has stopped moving is
   * how R3.3.2's sweep decides a container died, so a heartbeat slower than the
   * lease would have the fleet declared dead mid-probe.
   *
   * WHO WINS DEPENDS ON WHO CHOSE. If the operator set FLEET_HEARTBEAT_MS and
   * it conflicts with the FLEET_LEASE_MS they also set, that is two deliberate
   * values that cannot both hold — refuse, and name both. The previous silent
   * `Math.min` answered that conflict by discarding one of them. If the
   * heartbeat is merely the DEFAULT and a short lease squeezes it, nobody chose
   * 30s, so narrowing it is legitimate — but it is recorded in `adjustments`
   * and printed at boot rather than happening invisibly.
   */
  const adjustments = [];
  let heartbeatMs = requestedHeartbeat;
  if (requestedHeartbeat > heartbeatCeiling) {
    if (defaulted.has("FLEET_HEARTBEAT_MS")) {
      heartbeatMs = heartbeatCeiling;
      adjustments.push(
        `FLEET_HEARTBEAT_MS was not set; its default ${requestedHeartbeat}ms exceeds half of ` +
          `FLEET_LEASE_MS (${leaseMs}ms), so it is running at ${heartbeatMs}ms — a run must beat ` +
          `at least twice per lease or the stale sweep reaps a container that is still working.`
      );
    } else {
      throw new FleetConfigError([
        {
          name: "FLEET_HEARTBEAT_MS",
          required: false,
          kind: "conflict",
          message:
            `FLEET_HEARTBEAT_MS=${requestedHeartbeat} is more than half of FLEET_LEASE_MS=${leaseMs}. ` +
            `A run must beat at least twice per lease, or R3.3.2's stale sweep reaps a container ` +
            `that is still probing. Set FLEET_HEARTBEAT_MS to ${heartbeatCeiling} or less, or ` +
            `raise FLEET_LEASE_MS to ${requestedHeartbeat * 2} or more.`,
        },
      ]);
    }
  }

  /* ------------------------------------------------------------------ *
   * The politeness budget, resolved per surface (R1.1.5 §5.2).
   *
   * Every conflict found here is collected and thrown together, for the same
   * reason parse problems are: an operator with two wrong values must not have
   * to redeploy twice to find the second one.
   * ------------------------------------------------------------------ */
  const engines = values.FLEET_ENGINES;
  const probeTimeoutMs = values.FLEET_PROBE_TIMEOUT_MS;
  const conflicts = [];
  const budgets = {};

  /** Says whether a resolved number came from the operator or from §3.2. */
  const origin = (name, surface) =>
    values[name] === null || values[name] === undefined ? `the ${surface} default` : `${name}`;

  /** The largest FLEET_BATCH_SIZE that still fits inside one lease, and who bounds it. */
  let leaseCeiling = null;
  let leaseCeilingSurface = null;
  let leaseCeilingDelayMaxMs = null;

  for (const engine of engines) {
    const base = SURFACE_BUDGETS[engine];
    if (!base) {
      // Unreachable while FLEET_ENGINES and SURFACE_BUDGETS agree — asserted by
      // surfaceBudgetCoverage() in the suite — and a refusal rather than a
      // permissive default, because a surface with no budget would be probed at
      // whatever rate falls out of FLEET_BATCH_SIZE. That is the accident §1 of
      // the contract exists to replace with a decision.
      conflicts.push({
        name: "FLEET_ENGINES",
        required: false,
        kind: "conflict",
        message:
          `FLEET_ENGINES names "${engine}", which has no politeness budget in SURFACE_BUDGETS ` +
          `(worker/src/config.js). A surface with no budget must not be probed: add its §3.2 ` +
          `row to that table, or remove "${engine}" from FLEET_ENGINES.`,
      });
      continue;
    }

    // CONCURRENCY. The 1–2 range is the contract's; the per-surface ceiling is
    // §3.3's normative rule held as data, so raising a UI surface to 2 is a
    // conflict between two values the operator set, not a silent clamp.
    const requestedConcurrency = values.FLEET_MAX_CONCURRENCY;
    const maxConcurrency = requestedConcurrency ?? base.maxConcurrency;
    if (requestedConcurrency != null && requestedConcurrency > base.maxConcurrency) {
      conflicts.push({
        name: "FLEET_MAX_CONCURRENCY",
        required: false,
        kind: "conflict",
        message:
          `FLEET_MAX_CONCURRENCY=${requestedConcurrency} exceeds the ceiling of ` +
          `${base.maxConcurrency} for ${base.surface}, which FLEET_ENGINES also selects. ` +
          `${base.ceilingWhy} Set FLEET_MAX_CONCURRENCY to ${base.maxConcurrency} or less, or ` +
          `remove "${engine}" from FLEET_ENGINES.`,
      });
    }

    // DELAY WINDOW. Strictly greater, because a zero-width window is a FIXED
    // delay: perfectly periodic, trivially distinguishable from a human, and it
    // synchronises every container that started at the same moment (§3.4).
    const probeDelayMinMs = values.FLEET_PROBE_DELAY_MIN_MS ?? base.probeDelayMinMs;
    const probeDelayMaxMs = values.FLEET_PROBE_DELAY_MAX_MS ?? base.probeDelayMaxMs;
    const windowOk = probeDelayMaxMs > probeDelayMinMs;
    if (!windowOk) {
      conflicts.push({
        name: "FLEET_PROBE_DELAY_MAX_MS",
        required: false,
        kind: "conflict",
        message:
          `the inter-probe delay window for ${base.surface} is ` +
          `[${probeDelayMinMs}, ${probeDelayMaxMs}]ms, and the maximum must be strictly ` +
          `greater than the minimum. Minimum from ${origin("FLEET_PROBE_DELAY_MIN_MS", base.surface)}, ` +
          `maximum from ${origin("FLEET_PROBE_DELAY_MAX_MS", base.surface)}. A zero-width window ` +
          `is a fixed delay, which is a signature rather than pacing.`,
      });
    }

    budgets[engine] = Object.freeze({
      surface: base.surface,
      maxConcurrency,
      probeDelayMinMs,
      probeDelayMaxMs,
      dailyCap: values.FLEET_DAILY_CAP ?? base.dailyCap,
      /**
       * FALSE, and it is a fact rather than a placeholder. §3.5's cap is
       * fleet-wide; an environment variable checked in-process gives N
       * containers N × the cap, and no shared counter exists to check instead
       * (§5.3). Printed at boot so the number cannot be mistaken for a limit.
       */
      dailyCapEnforced: false,
    });

    // THE LEASE ARITHMETIC (§5.2). A batch that outlives its lease has its
    // results refused by complete_probe_tasks, so the requests were made and
    // the work is spent for nothing — contract §6, V6.
    if (windowOk) {
      const fits = Math.floor(leaseMs / (probeDelayMaxMs + probeTimeoutMs));
      // On a tie the slower surface is named, because it is the one that binds
      // first when the operator raises the lease.
      const tighter =
        leaseCeiling === null ||
        fits < leaseCeiling ||
        (fits === leaseCeiling && probeDelayMaxMs > leaseCeilingDelayMaxMs);
      if (tighter) {
        leaseCeiling = fits;
        leaseCeilingSurface = base.surface;
        leaseCeilingDelayMaxMs = probeDelayMaxMs;
      }
    }
  }

  let batchSize = values.FLEET_BATCH_SIZE;
  if (leaseCeiling !== null && leaseCeiling < 1) {
    // No batch size can fit, so there is nothing to narrow: one paced probe
    // already outlives the lease.
    conflicts.push({
      name: "FLEET_LEASE_MS",
      required: false,
      kind: "conflict",
      message:
        `a single ${leaseCeilingSurface} probe can take up to ` +
        `${leaseCeilingDelayMaxMs} + ${probeTimeoutMs}ms ` +
        `(inter-probe delay + FLEET_PROBE_TIMEOUT_MS), which already exceeds ` +
        `FLEET_LEASE_MS=${leaseMs}. The lease would lapse mid-batch and complete_probe_tasks ` +
        `would refuse the results, so the probe would be made and thrown away. Raise ` +
        `FLEET_LEASE_MS, or lower FLEET_PROBE_DELAY_MAX_MS / FLEET_PROBE_TIMEOUT_MS.`,
    });
  } else if (leaseCeiling !== null && batchSize > leaseCeiling) {
    const arithmetic =
      `FLEET_BATCH_SIZE × (delay max + FLEET_PROBE_TIMEOUT_MS) must not exceed ` +
      `FLEET_LEASE_MS=${leaseMs}; ${leaseCeilingSurface} allows at most ${leaseCeiling}`;
    if (defaulted.has("FLEET_BATCH_SIZE")) {
      // Same rule as the heartbeat above: nobody chose 5, so narrowing it is
      // legitimate — and it is the THROUGHPUT term that gives way, never the
      // politeness term, because a delay narrowed to fit a lease is a budget
      // that quietly stops being a budget.
      adjustments.push(
        `FLEET_BATCH_SIZE was not set; its default ${batchSize} does not fit one lease once ` +
          `${leaseCeilingSurface}'s inter-probe delay is paid, so it is running at ` +
          `${leaseCeiling} — ${arithmetic}. A batch that outlives its lease has its results ` +
          `refused and its requests wasted (contract §6, V6).`
      );
      batchSize = leaseCeiling;
    } else {
      conflicts.push({
        name: "FLEET_BATCH_SIZE",
        required: false,
        kind: "conflict",
        message:
          `FLEET_BATCH_SIZE=${batchSize} cannot be probed within FLEET_LEASE_MS=${leaseMs} at ` +
          `${leaseCeilingSurface}'s pace: ${arithmetic}. The lease would lapse mid-batch and ` +
          `complete_probe_tasks would refuse the results, so the requests would be made and ` +
          `thrown away. Set FLEET_BATCH_SIZE to ${leaseCeiling} or less, or raise FLEET_LEASE_MS.`,
      });
    }
  }

  if (conflicts.length) throw new FleetConfigError(conflicts);

  return {
    supabaseUrl: values.SUPABASE_URL ?? null,
    supabaseKey: values.SUPABASE_SERVICE_ROLE_KEY ?? null,
    /** Whether production database access is explicitly armed (R1.2.12). */
    allowProductionDb: isArmed,
    /** Which real surfaces this container drives. */
    engines,
    /** Probe batch size per claim, never larger than one lease can pay for. */
    batchSize,
    /** How long a claimed batch stays leased before it can be reaped. */
    leaseMs,
    /** Gap between polls when the queue came back empty. */
    idlePollMs: values.FLEET_IDLE_POLL_MS,
    /** How often an in-flight scan_runs row says it is still alive (R1.2.3). */
    heartbeatMs,
    /** Identity written onto every claim and heartbeat. */
    workerId:
      values.FLEET_WORKER_ID ??
      defaultWorkerId(hostname === undefined ? safeHostname() : hostname, pid === undefined ? process.pid : pid),
    /**
     * The politeness budget for each surface this container drives, keyed by
     * engine id: `{ surface, maxConcurrency, probeDelayMinMs, probeDelayMaxMs,
     * dailyCap, dailyCapEnforced }`. Frozen, and never empty — an engine with
     * no budget refuses the boot above.
     */
    budgets: Object.freeze(budgets),
    /** How long one probe may run before it is abandoned (a term in the lease check). */
    probeTimeoutMs,
    /** Gap between canary probes of one surface (contract §4.3). */
    canaryIntervalMs: values.FLEET_CANARY_INTERVAL_MS,
    /**
     * FALSE, deliberately and visibly. The budget above is resolved, validated
     * and logged, but NOTHING applies it to a probe yet: `probeBatch` has no
     * adapter (R1.3/R1.4), so there is no loop to limit, no sleep to jitter and
     * no counter to cap. The one part that IS enforced today is the boot-time
     * lease arithmetic, which bounds `batchSize` above. Flip this when the
     * probe loop reads `budgets`, and not before — a config that looks applied
     * and is not is exactly the shape this contract was written against.
     */
    budgetsEnforced: false,
    /** Set by --selftest; the loop exits after one pass instead of running forever. */
    once: false,
    /** Absent required credentials, non-empty only when `strict:false`. */
    missing,
    /** Values narrowed from a DEFAULT (never from an operator's choice). Announced at boot. */
    adjustments,
  };
}

/**
 * One line per resolved value for the boot log, secrets named and never shown.
 *
 * Printed at start so the container's own log records what it is running on. A
 * config nobody can read after the fact is one nobody can be wrong about.
 */
export function describeConfig(config) {
  const lines = [
    `supabaseUrl=${config.supabaseUrl ? "set" : "MISSING"}`,
    `supabaseKey=${config.supabaseKey ? "set" : "MISSING"}`, // never the value
    `engines=${config.engines.join(",")}`,
    `batchSize=${config.batchSize}`,
    `leaseMs=${config.leaseMs}`,
    `idlePollMs=${config.idlePollMs}`,
    `heartbeatMs=${config.heartbeatMs}`,
    `workerId=${config.workerId}`,
    `probeTimeoutMs=${config.probeTimeoutMs}`,
    `canaryIntervalMs=${config.canaryIntervalMs}`,
    `allowProductionDb=${Boolean(config.allowProductionDb)}`,
  ];

  // One line per surface, because a budget printed as a single number for a
  // container that drives two surfaces is a budget nobody can check.
  const budgetLines = Object.entries(config.budgets || {}).map(
    ([engine, b]) =>
      `config: budget ${engine} (${b.surface}): concurrency=${b.maxConcurrency} ` +
      `delay=${b.probeDelayMinMs}-${b.probeDelayMaxMs}ms dailyCap=${b.dailyCap}` +
      (b.dailyCapEnforced
        ? ""
        : " (cap NOT ENFORCED: it is fleet-wide and no shared counter exists)")
  );

  // A resolved number that nothing acts on must not read as a number in force.
  const footer = config.budgetsEnforced
    ? []
    : [
        `config: the budget above is VALIDATED, NOT APPLIED — no probe is paced by it yet ` +
          `(probeBatch has no adapter). The lease arithmetic that bounds batchSize IS enforced.`,
      ];

  return [`config: ${lines.join(" ")}`, ...budgetLines, ...footer].join("\n");
}
