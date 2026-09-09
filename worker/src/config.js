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
    fallback: null, // computed: worker-<pid>
    why: "identity written onto every claim and heartbeat",
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
  if (field.name === "FLEET_WORKER_ID") return "worker-<pid>";
  if (Array.isArray(field.fallback)) return field.fallback.join(",");
  return String(field.fallback);
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
 * Throws {@link FleetConfigError} listing every problem at once.
 */
export function resolveConfig(env = process.env, { strict = true } = {}) {
  const problems = [];
  const values = {};
  const defaulted = new Set();

  for (const field of CONFIG_FIELDS) {
    const raw = readRaw(env, field);
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

  // Absent-or-blank REQUIRED credentials are what `strict:false` forgives, and
  // nothing else. Their names still travel on `missing` so --selftest can say
  // out loud that it is running on stubs.
  const credentialProblems = problems.filter(
    (p) => p.required && (p.kind === "missing" || p.kind === "blank")
  );
  const missing = credentialProblems.map((p) => p.name);

  const fatal = strict ? problems : problems.filter((p) => !credentialProblems.includes(p));
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

  return {
    supabaseUrl: values.SUPABASE_URL ?? null,
    supabaseKey: values.SUPABASE_SERVICE_ROLE_KEY ?? null,
    /** Which real surfaces this container drives. */
    engines: values.FLEET_ENGINES,
    /** Probe batch size per claim. */
    batchSize: values.FLEET_BATCH_SIZE,
    /** How long a claimed batch stays leased before it can be reaped. */
    leaseMs,
    /** Gap between polls when the queue came back empty. */
    idlePollMs: values.FLEET_IDLE_POLL_MS,
    /** How often an in-flight scan_runs row says it is still alive (R1.2.3). */
    heartbeatMs,
    /** Identity written onto every claim and heartbeat. */
    workerId: values.FLEET_WORKER_ID ?? `worker-${process.pid}`,
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
  ];
  return `config: ${lines.join(" ")}`;
}
