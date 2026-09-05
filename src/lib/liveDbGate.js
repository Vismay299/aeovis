/**
 * The gate on tests that need a real Postgres (R1.2.2), and — since R3.2.4 —
 * the thing that arms the write guard, because opening one without the other is
 * how two rows got written into production `scans`.
 *
 * Its own module rather than a helper inside the test file, so a guard test can
 * import and exercise it without also re-registering the gated cases.
 *
 * WHY A GATE AT ALL, AND WHY IT MUST BE LOUD
 * Some properties cannot be proven without a database. "Two workers racing for
 * the same batch produce exactly one claim" is one: it is a fact about Postgres
 * row locking, and a fake client has no lock manager, so it would agree with a
 * correct implementation and a broken one alike. CI has no database, so those
 * tests must skip there — but a silent skip turns a green suite into a claim
 * nobody checked. This returns the REASON, and the caller is expected to print
 * it where a passing run cannot hide it. Standing rule 1: a skip is not a
 * success.
 *
 * OPENING THE GATE ARMS THE GUARD. THAT IS NOT A CONVENTION.
 * An earlier draft of R3.2.1's live test walked through an open gate into a
 * real `insertScan`, writing two rows into `scans` and two into
 * `brand_metrics_daily` on production. `src/lib/liveWriteGuard.js` refuses
 * undeclared writes, and `src/lib/liveWriteGuardAuto.mjs` arms it for every
 * process started by `npm test` / `npm run test:scoring` / `npm run test:live`
 * — but a live test run as a bare `node --env-file=.env.local --test <file>`
 * gets no preload, and for a while that was the ONLY command this file printed.
 * A new live test written to the house pattern, forgetting one stub, therefore
 * passed GREEN while its INSERT left the process.
 *
 * Two things close that:
 *
 *   1. `armedLiveDbGate()` — the gate live tests must use. It installs the
 *      default-deny write guard BEFORE it reports whether the gate is open, so
 *      there is no ordering in which a test can be pointed at a real database
 *      by this module and not be guarded. It also refuses to report an open
 *      gate when the guard could not actually patch a transport: armed-and-
 *      blind must not read the same as armed.
 *   2. `liveDbGate()` itself throws if it is asked about the REAL environment —
 *      or any copy of it that carries the same credentials (R3.2.10) — when it
 *      finds a live database configured and no guard is armed. That is the
 *      tripwire for the author who copies the old pattern instead of using
 *      `armedLiveDbGate`. It cannot fire in CI (no `DATABASE_URL`, gate shut)
 *      and it cannot fire under the npm scripts (the preload armed it), so the
 *      only run it stops is the unguarded live one — the one that writes.
 *
 * `src/lib/liveWriteGuard.test.mjs` asserts, over the whole tree, that every
 * file importing this module arms the guard. The rule is enforced by a test,
 * not by this comment.
 */

import { installLiveWriteGuard, liveWriteGuardCoverage, liveWriteGuardDepth } from "./liveWriteGuard.js";

/** The invocation that runs one live test file WITH the write guard armed. */
export const LIVE_TEST_COMMAND = "npm run test:live -- <file>";

/** The same thing spelled out, for anyone who would rather not go through npm. */
export const LIVE_TEST_COMMAND_RAW =
  "node --import ./src/lib/liveWriteGuardAuto.mjs --env-file=.env.local --test <file>";

/**
 * @returns {{enabled: boolean, reason: string|null}} `reason` is non-null
 * exactly when the gate is closed, and says what is missing and how to supply it.
 *
 * THROWS when the gate is open on the real environment and no write guard is
 * armed. Pass an explicit env object of your own values (as the gate's own unit
 * tests do) to ask the question without claiming you are about to run against
 * that database.
 *
 * A COPY OF THE REAL ENVIRONMENT IS THE REAL ENVIRONMENT (R3.2.10). This used
 * to test `env === process.env`, and identity is defeated by a spread:
 * `liveDbGate({ ...process.env })` — also `Object.assign({}, process.env)`, a
 * `structuredClone`, or a hand-picked `{ DATABASE_URL: process.env.DATABASE_URL }`
 * — got a copy, failed the identity check, and opened the gate unguarded on a
 * process that could write to production. Measured, not theorised: all four
 * forms opened while the alias form threw. So the check is now on the VALUES.
 * An env whose gate-opening credential names the same database as the real one
 * — compared by host and path, not by string, see `isRealEnvironment` — is
 * treated as the real environment however it was constructed, because it
 * reaches the same database. The escape hatch survives: an env carrying values that are
 * not the live credentials (`{ DATABASE_URL: "postgres://x" }`) opens nothing
 * and is exempt, which is what `src/lib/probeQueue.test.mjs` and the guard's
 * own self-test rely on. `src/lib/liveWriteGuard.test.mjs` enforces the static
 * half of the same rule over the whole tree.
 */
export function liveDbGate(env = process.env) {
  const gate = decide(env);
  if (gate.enabled && isRealEnvironment(env)) requireArmedGuard();
  return gate;
}

/** The variables `decide` opens the gate on — the ones worth impersonating. */
const GATE_CREDENTIALS = ["DATABASE_URL", "SUPABASE_DB_PASSWORD", "NEXT_PUBLIC_SUPABASE_URL"];

/**
 * `process.env` itself, or anything carrying one of its live credentials by
 * value. Copies are the whole point: see the note on `liveDbGate` above.
 *
 * The comparison is on the DATABASE the value names, not the string, because
 * `process.env.DATABASE_URL + "?application_name=x"` is a different string and
 * the same production database — that form opened the gate against an earlier
 * cut of this fix. A URL matches when its host and path match, so changing the
 * user, the password or the query does not buy an exemption. What it still
 * cannot see is a different spelling of the same host (an IP for a DNS name);
 * the static rule in `src/lib/liveWriteGuard.test.mjs` is what stands behind
 * this, and `armedLiveDbGate` needs neither.
 */
function isRealEnvironment(env) {
  if (env === process.env) return true;
  if (!env || typeof env !== "object") return false;
  return GATE_CREDENTIALS.some((key) => {
    const real = process.env[key];
    if (typeof real !== "string" || real === "") return false;
    return namesSameTarget(env[key], real);
  });
}

function namesSameTarget(value, real) {
  if (value === real) return true;
  if (typeof value !== "string" || value === "") return false;
  const a = dbTarget(value);
  return a !== null && a === dbTarget(real);
}

/** `host` + database path, or null for a value that is not a URL (a password). */
function dbTarget(value) {
  try {
    const u = new URL(value);
    return `${u.host.toLowerCase()}${u.pathname.replace(/\/+$/, "")}`;
  } catch {
    return null;
  }
}

function decide(env) {
  if (env.DATABASE_URL) return { enabled: true, reason: null };
  if (env.SUPABASE_DB_PASSWORD && env.NEXT_PUBLIC_SUPABASE_URL) {
    return { enabled: true, reason: null };
  }
  return {
    enabled: false,
    reason:
      "no live Postgres configured (needs DATABASE_URL, or SUPABASE_DB_PASSWORD + " +
      `NEXT_PUBLIC_SUPABASE_URL). Run: ${LIVE_TEST_COMMAND}  (or: ${LIVE_TEST_COMMAND_RAW})`,
  };
}

/**
 * The gate is open, which means a real database is one call away. Refuse to say
 * so unless the default-deny write guard is actually in force.
 */
function requireArmedGuard() {
  if (liveWriteGuardDepth() === 0) {
    throw new Error(
      "liveDbGate: a live database is configured and NO live-write guard is armed. " +
        "An unguarded live test that forgets to stub one writer writes to production — that is R3.2.4, " +
        "and it cost two rows in `scans` and two in `brand_metrics_daily`. " +
        "Use `armedLiveDbGate({ label, allow })` from src/lib/liveDbGate.js instead of `liveDbGate()`, " +
        `or run the file with the guard preloaded: ${LIVE_TEST_COMMAND}  (or: ${LIVE_TEST_COMMAND_RAW}). ` +
        "Handing the gate a COPY of the real environment (`{ ...process.env }`) is not an exemption: it is " +
        "the same credentials and the same database, so it is refused the same way."
    );
  }
  const covers = liveWriteGuardCoverage();
  if (!covers.supabase || !covers.pg) {
    throw new Error(
      "liveDbGate: a live database is configured and the write guard is armed but BLIND " +
        `(supabase=${covers.supabase}, pg=${covers.pg}). Writes over the unpatched transport would not be ` +
        "refused, and a guard that covers nothing must not read the same as a guard that covers everything."
    );
  }
}

/**
 * The gate for a live test file: arms the write guard, then reports the gate.
 *
 * ```js
 * const GATE = await armedLiveDbGate({ label: "src/lib/scanRunsLive.test.mjs", allow: ["scan_runs"] });
 * if (!GATE.enabled) console.error(notRunBanner(TITLE, GATE.reason, CONSEQUENCE));
 * const opts = GATE.enabled ? {} : { skip: GATE.reason };
 * test("…", opts, async () => { … });
 * ```
 *
 * It returns `{ enabled, reason }` and not a ready-made `opts`, because
 * `src/lib/probeQueue.test.mjs` and `src/lib/scanRuns.test.mjs` assert on the
 * literal `skip: GATE.reason` in the live files' source: those two guards exist
 * to stop a live case from being skipped without carrying its reason, and
 * hiding the expression behind a helper would retire them.
 *
 * `allow` defaults to NOTHING, so a live test that names no table can write no
 * table. Widening is a deliberate act that shows up in the diff, and
 * `installLiveWriteGuard` rejects any table on its NEVER_WRITABLE list even
 * when a test asks for it by name.
 *
 * The guard is installed whether or not the gate turns out to be open. A closed
 * gate skips its cases, but the file's module body still runs, and module
 * bodies have written to databases before.
 *
 * @param {object} options
 * @param {string} options.label   the test file, named in every refusal.
 * @param {string[]} [options.allow] tables this file may write. Default: none.
 * @param {object} [options.env]   environment to read. Default: `process.env`.
 * @returns {Promise<{enabled: boolean, reason: string|null, guard: object}>}
 */
export async function armedLiveDbGate({ label, allow = [], env = process.env } = {}) {
  if (!label || typeof label !== "string") {
    throw new Error("armedLiveDbGate needs a label: every refusal has to name the file it came from");
  }
  const guard = await installLiveWriteGuard({ label, allow });

  const gate = decide(env);
  if (gate.enabled && (!guard.covers.supabase || !guard.covers.pg)) {
    throw new Error(
      `armedLiveDbGate(${label}): the gate is OPEN and the guard is BLIND ` +
        `(supabase=${guard.covers.supabase}, pg=${guard.covers.pg}). Refusing to run live tests behind a ` +
        "guard that cannot see one of the two transports; fix the transport rather than proceeding."
    );
  }

  return { enabled: gate.enabled, reason: gate.reason, guard };
}

/** The banner an unconfigured run prints to stderr, naming what went unproven. */
export function notRunBanner(title, reason, consequence) {
  return (
    "\n" +
    "==============================================================\n" +
    ` ${title}: NOT RUN\n` +
    ` reason: ${reason}\n` +
    ` ${consequence}\n` +
    "==============================================================\n"
  );
}
