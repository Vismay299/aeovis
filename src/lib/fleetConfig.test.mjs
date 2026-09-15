import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { pathToFileURL, fileURLToPath } from "node:url";

/**
 * R1.2.6 — the fleet's configuration is validated at boot, or the fleet does
 * not boot.
 *
 * WHY THIS FILE LIVES IN THE MAIN SUITE. `worker/` has its own package.json and
 * its own `npm test`, and CI does not run it — the same reasoning that put
 * src/lib/workerIsolation.test.mjs here. A boot check that only fires when
 * somebody remembers to `npm --prefix worker test` is not a check. The import
 * direction is legal: the app may read the worker, never the reverse.
 *
 * WHAT WAS BROKEN. resolveConfig read every FLEET_* variable through a helper
 * that returned a default when the value would not parse and clamped it when it
 * would. Observed before the fix, all booting silently:
 *
 *   FLEET_BATCH_SIZE=abc     -> batchSize 5
 *   FLEET_BATCH_SIZE=9999    -> batchSize 50
 *   FLEET_BATCH_SIZE=0       -> batchSize 1
 *   FLEET_BATCH_SIZE=5.9     -> batchSize 5
 *   FLEET_IDLE_POLL_MS=banana-> idlePollMs 10000
 *   FLEET_ENGINES=","        -> engines []   (the claim reads [] as EVERY engine)
 *   FLEET_ENGINES=gogle      -> engines ["gogle"], which claims nothing forever
 *   SUPABASE_URL="   "       -> passed the required check on a blank string
 *
 * Each one is a number or a surface list nobody chose, running as though it had
 * been chosen. Every case below is one of those, inverted.
 */

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const CONFIG_URL = pathToFileURL(path.join(REPO, "worker/src/config.js")).href;
const INDEX_URL = pathToFileURL(path.join(REPO, "worker/src/index.js")).href;

const {
  resolveConfig,
  describeConfig,
  isRequired,
  CONFIG_FIELDS,
  FLEET_ENGINES,
  FleetConfigError,
  SURFACE_BUDGETS,
  surfaceBudgetCoverage,
} = await import(CONFIG_URL);
const { bootConfig } = await import(INDEX_URL);

/** A minimal env that resolves cleanly, so each case varies exactly one thing. */
const OK = Object.freeze({
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "sk-EXAMPLE-NOT-A-REAL-KEY",
});

/** Resolve and return the thrown FleetConfigError, or fail. */
function refusal(env, opts) {
  try {
    const config = resolveConfig(env, opts);
    assert.fail(
      `expected a boot refusal, but the fleet started on ` +
        `engines=${config.engines.join(",")} batchSize=${config.batchSize} ` +
        `idlePollMs=${config.idlePollMs} leaseMs=${config.leaseMs}`
    );
  } catch (err) {
    assert.ok(
      err instanceof FleetConfigError,
      `expected FleetConfigError, got ${err.name}: ${err.message}`
    );
    return err;
  }
}

/* ------------------------------------------------------------------ *
 * The acceptance criterion, exercised as a real process.
 * ------------------------------------------------------------------ */

test("ACCEPT — starting the fleet without a required var exits non-zero and lists the missing names", async () => {
  const run = promisify(execFile);
  const env = { ...process.env };
  // Both the primary names and the aliases resolveConfig accepts; leaving an
  // alias set would make the fleet boot and prove nothing.
  for (const name of [
    "SUPABASE_URL",
    "SUPABASE_SERVICE_ROLE_KEY",
    "NEXT_PUBLIC_SUPABASE_URL",
    "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  ]) {
    delete env[name];
  }

  let failed = null;
  try {
    await run(process.execPath, [path.join(REPO, "worker/src/index.js")], { env, timeout: 30_000 });
  } catch (err) {
    failed = err;
  }

  assert.ok(failed, "the fleet started with no queue to read — it must refuse");
  assert.equal(failed.code, 1, "a refused boot must exit non-zero");

  const out = `${failed.stderr || ""}${failed.stdout || ""}`;
  assert.match(out, /SUPABASE_URL/, "the missing variable must be named");
  assert.match(out, /SUPABASE_SERVICE_ROLE_KEY/, "the missing variable must be named");
  assert.match(
    out,
    /required variable\(s\) missing or blank/i,
    "the names must be listed as missing, not merely mentioned"
  );
  // A stack trace is not a message. The pre-fix boot threw synchronously outside
  // the entry point's catch and died with ERR_UNHANDLED / a raw trace instead.
  assert.doesNotMatch(out, /at resolveConfig/, "an operator must get a message, not a stack trace");
});

test("ACCEPT — the boot path reports every missing required name, without a process", () => {
  const booted = bootConfig({}, { strict: true });
  assert.equal(booted.config, null);
  assert.equal(booted.exitCode, 1);
  assert.match(booted.errorText, /SUPABASE_URL/);
  assert.match(booted.errorText, /SUPABASE_SERVICE_ROLE_KEY/);

  const err = refusal({});
  assert.deepEqual(err.missing, ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]);
});

test("a required variable that is present but BLANK is missing, not satisfied", () => {
  // The pre-fix check was `env.SUPABASE_URL || ...`, so "   " was truthy and the
  // fleet booted pointed at a whitespace URL.
  const err = refusal({ ...OK, SUPABASE_URL: "   " });
  assert.deepEqual(err.missing, ["SUPABASE_URL"]);
  assert.match(err.message, /SUPABASE_URL is set but blank/);
});

test("a required variable that is not a URL refuses", () => {
  const err = refusal({ ...OK, SUPABASE_URL: "not-a-url" });
  assert.match(err.message, /SUPABASE_URL.*is not a URL/s);
});

/* ------------------------------------------------------------------ *
 * Optional fields: absent takes the default, present-and-wrong refuses.
 * ------------------------------------------------------------------ */

test("absent optional variables take their documented defaults", () => {
  const config = resolveConfig({ ...OK });
  assert.deepEqual([...config.engines], ["perplexity"]);
  assert.equal(config.leaseMs, 300_000);
  assert.equal(config.idlePollMs, 10_000);
  assert.equal(config.heartbeatMs, 30_000);
  assert.equal(config.probeTimeoutMs, 60_000);
  assert.equal(config.canaryIntervalMs, 3_600_000);
  assert.match(config.workerId, /^worker-\d+$/);
  assert.deepEqual(config.missing, []);

  // FLEET_BATCH_SIZE's documented default is 5 and it is NOT what the fleet
  // runs on once the politeness budget exists: 5 × (45s max delay + 60s probe
  // timeout) is 525s against a 300s lease, so the batch would outlive its lease
  // and complete_probe_tasks would refuse every result (contract §6, V6). The
  // default is narrowed to what one lease pays for, and the narrowing is
  // announced — the same rule the heartbeat already follows. Nobody typed 5, so
  // nothing an operator chose was discarded.
  assert.equal(config.batchSize, 2);
  assert.equal(config.adjustments.length, 1);
  assert.match(config.adjustments[0], /FLEET_BATCH_SIZE was not set/);
  assert.match(config.adjustments[0], /perplexity\.ai/);
});

test("required vs optional is data on the field, not a convention in the prose", () => {
  assert.equal(isRequired("SUPABASE_URL"), true);
  assert.equal(isRequired("SUPABASE_SERVICE_ROLE_KEY"), true);
  for (const name of [
    "FLEET_ALLOW_PRODUCTION_DB",
    "FLEET_ENGINES",
    "FLEET_BATCH_SIZE",
    "FLEET_LEASE_MS",
    "FLEET_IDLE_POLL_MS",
    "FLEET_HEARTBEAT_MS",
    "FLEET_WORKER_ID",
    "FLEET_MAX_CONCURRENCY",
    "FLEET_PROBE_DELAY_MIN_MS",
    "FLEET_PROBE_DELAY_MAX_MS",
    "FLEET_DAILY_CAP",
    "FLEET_CANARY_INTERVAL_MS",
    "FLEET_PROBE_TIMEOUT_MS",
  ]) {
    assert.equal(isRequired(name), false, `${name} must be optional`);
  }
  // Every field states the choice explicitly; an undeclared `required` would
  // read as false by accident.
  for (const field of CONFIG_FIELDS) {
    assert.equal(typeof field.required, "boolean", `${field.name} must declare required`);
  }
  assert.throws(() => isRequired("FLEET_NOT_A_VARIABLE"), /not a fleet configuration variable/);
});

for (const [name, raw] of [
  ["FLEET_BATCH_SIZE", "abc"],
  ["FLEET_LEASE_MS", "abc"],
  ["FLEET_IDLE_POLL_MS", "banana"],
  ["FLEET_HEARTBEAT_MS", "soon"],
]) {
  test(`${name}="${raw}" refuses instead of falling back to the default`, () => {
    const err = refusal({ ...OK, [name]: raw });
    assert.equal(err.problems.length, 1);
    assert.equal(err.problems[0].name, name);
    assert.equal(err.problems[0].kind, "unparseable");
    assert.match(err.message, new RegExp(`${name}="${raw}" is not a whole number`));
  });
}

test("a number with a trailing tail is not a number — parseInt('5x') would have said 5", () => {
  const err = refusal({ ...OK, FLEET_BATCH_SIZE: "5x" });
  assert.equal(err.problems[0].kind, "unparseable");
});

test("a decimal is not a whole number — parseInt('5.9') would have said 5", () => {
  const err = refusal({ ...OK, FLEET_BATCH_SIZE: "5.9" });
  assert.equal(err.problems[0].kind, "unparseable");
});

for (const [name, raw, low, high] of [
  ["FLEET_BATCH_SIZE", "9999", 1, 50],
  ["FLEET_BATCH_SIZE", "0", 1, 50],
  ["FLEET_BATCH_SIZE", "-3", 1, 50],
  ["FLEET_LEASE_MS", "1", 30_000, 3_600_000],
  ["FLEET_IDLE_POLL_MS", "999999999", 1_000, 300_000],
]) {
  test(`${name}=${raw} refuses instead of being clamped into [${low}, ${high}]`, () => {
    const err = refusal({ ...OK, [name]: raw });
    assert.equal(err.problems[0].kind, "out_of_range");
    assert.match(err.message, new RegExp(`${name}=${raw.replace("-", "\\-")} is out of range`));
    assert.match(err.message, new RegExp(`between ${low} and ${high}`));
  });
}

test("an optional variable set to blank refuses, and says how to ask for the default", () => {
  // Blank is not absent. Someone wrote `FLEET_BATCH_SIZE=` and meant something;
  // guessing which default they meant is the whole failure mode.
  const err = refusal({ ...OK, FLEET_BATCH_SIZE: "" });
  assert.equal(err.problems[0].kind, "blank");
  assert.match(err.message, /FLEET_BATCH_SIZE is set but blank/);
  assert.match(err.message, /remove the variable to accept the default \(5\)/);
});

test("FLEET_WORKER_ID set to whitespace refuses rather than becoming an unownable lease", () => {
  const err = refusal({ ...OK, FLEET_WORKER_ID: "   " });
  assert.equal(err.problems[0].name, "FLEET_WORKER_ID");
  assert.equal(err.problems[0].kind, "blank");
});

/* ------------------------------------------------------------------ *
 * The engine list — the case that manufactures a confident zero.
 * ------------------------------------------------------------------ */

test("FLEET_ENGINES naming an unknown surface refuses at boot", () => {
  const err = refusal({ ...OK, FLEET_ENGINES: "gogle" });
  assert.equal(err.problems[0].kind, "unknown_value");
  assert.match(err.message, /unknown engine\(s\): gogle/);
  assert.match(err.message, /perplexity/, "the known vocabulary must be offered");
});

test("one misspelt engine among several still refuses — a partial list is not a pass", () => {
  const err = refusal({ ...OK, FLEET_ENGINES: "perplexity,chatgtp" });
  assert.match(err.message, /unknown engine\(s\): chatgtp/);
});

test('FLEET_ENGINES="," refuses: an empty filter is read downstream as EVERY engine', () => {
  // worker/src/lib/queue.js: `p_engines: config.engines.length ? config.engines : null`,
  // and NULL means "no engine filter" in claim_probe_tasks. So the pre-fix
  // empty list did not mean "claim nothing" — it meant "claim everything".
  const err = refusal({ ...OK, FLEET_ENGINES: "," });
  assert.equal(err.problems[0].kind, "empty_list");
  assert.match(err.message, /names no engines/);
});

test("a known engine list resolves, lowercased and de-duplicated", () => {
  const config = resolveConfig({ ...OK, FLEET_ENGINES: " Perplexity , chatgpt ,perplexity" });
  assert.deepEqual([...config.engines], ["perplexity", "chatgpt"]);
});

test("the engine vocabulary is closed", () => {
  assert.ok(Object.isFrozen(FLEET_ENGINES));
  assert.ok(FLEET_ENGINES.includes("perplexity"));
  assert.ok(FLEET_ENGINES.includes("chatgpt"));
});

/* ------------------------------------------------------------------ *
 * The heartbeat/lease bound.
 * ------------------------------------------------------------------ */

test("an explicitly set heartbeat slower than half the lease refuses, naming both variables", () => {
  // The pre-fix Math.min silently discarded one of two values the operator set.
  const err = refusal({ ...OK, FLEET_LEASE_MS: "60000", FLEET_HEARTBEAT_MS: "50000" });
  assert.equal(err.problems[0].kind, "conflict");
  assert.match(err.message, /FLEET_HEARTBEAT_MS=50000/);
  assert.match(err.message, /FLEET_LEASE_MS=60000/);
});

test("the DEFAULT heartbeat may be narrowed by a short lease, but the narrowing is announced", () => {
  // The pacing overrides are here so this stays a test about the HEARTBEAT. A
  // 30s lease cannot hold one probe at perplexity.ai's default 45s delay plus
  // the 60s probe timeout, so the budget's lease check would refuse the boot
  // before the heartbeat rule was ever reached. Fast pacing keeps five probes
  // inside the 30s lease and leaves the batch size alone.
  const config = resolveConfig({
    ...OK,
    FLEET_LEASE_MS: "30000",
    FLEET_PROBE_DELAY_MIN_MS: "0",
    FLEET_PROBE_DELAY_MAX_MS: "1000",
    FLEET_PROBE_TIMEOUT_MS: "5000",
  });
  assert.equal(config.batchSize, 5, "the batch must not be narrowed as well, or this proves two things");
  assert.equal(config.heartbeatMs, 15_000);
  assert.equal(config.adjustments.length, 1, "a silent narrowing is the thing this task removes");
  assert.match(config.adjustments[0], /FLEET_HEARTBEAT_MS was not set/);
  assert.match(config.adjustments[0], /15000/);
});

test("a heartbeat the operator set that fits the lease is left exactly alone", () => {
  const config = resolveConfig({ ...OK, FLEET_LEASE_MS: "600000", FLEET_HEARTBEAT_MS: "60000" });
  assert.equal(config.heartbeatMs, 60_000);
  assert.deepEqual(config.adjustments, []);
});

/* ------------------------------------------------------------------ *
 * Reporting: all problems at once, and never a secret.
 * ------------------------------------------------------------------ */

test("every problem is reported in one refusal, not one redeploy at a time", () => {
  const err = refusal({
    SUPABASE_SERVICE_ROLE_KEY: "sk-EXAMPLE-NOT-A-REAL-KEY",
    FLEET_ENGINES: "gogle",
    FLEET_BATCH_SIZE: "abc",
    FLEET_IDLE_POLL_MS: "0",
    FLEET_WORKER_ID: "  ",
  });
  assert.equal(err.problems.length, 5, `expected 5 problems, got: ${err.problems.map((p) => p.name).join(", ")}`);
  assert.deepEqual(
    err.problems.map((p) => p.name).sort(),
    ["FLEET_BATCH_SIZE", "FLEET_ENGINES", "FLEET_IDLE_POLL_MS", "FLEET_WORKER_ID", "SUPABASE_URL"]
  );
});

test("no refusal or log line ever contains the value of a secret variable", () => {
  const SENTINEL = "sk-EXAMPLE-NOT-A-REAL-KEY";
  // Force a refusal while the secret is set, and check the whole message.
  const err = refusal({ ...OK, SUPABASE_SERVICE_ROLE_KEY: SENTINEL, FLEET_BATCH_SIZE: "abc" });
  assert.doesNotMatch(err.message, /sk-EXAMPLE/, "a validation error must never echo a credential");
  assert.equal(bootConfig({ ...OK, SUPABASE_SERVICE_ROLE_KEY: SENTINEL, FLEET_BATCH_SIZE: "abc" }).errorText.includes(SENTINEL), false);

  const config = resolveConfig({ ...OK, SUPABASE_SERVICE_ROLE_KEY: SENTINEL });
  const line = describeConfig(config);
  assert.equal(line.includes(SENTINEL), false, "the boot log must not print the key");
  assert.match(line, /supabaseKey=set/, "it must still say whether the key is present");

  // The field carries the rule as data, so a new secret cannot be added by
  // someone who has not read this test.
  const key = CONFIG_FIELDS.find((f) => f.name === "SUPABASE_SERVICE_ROLE_KEY");
  assert.equal(key.secret, true);
});

/* ------------------------------------------------------------------ *
 * strict:false forgives credentials, and nothing else.
 * ------------------------------------------------------------------ */

test("strict:false forgives the missing credentials and says so on `missing`", () => {
  const config = resolveConfig({}, { strict: false });
  assert.deepEqual(config.missing, ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]);
  assert.equal(config.supabaseUrl, null);
  assert.equal(config.supabaseKey, null);
});

test("strict:false is not validation:false — a malformed FLEET_* value still refuses", () => {
  // --selftest is precisely where an operator should discover a typo, and a
  // relaxed mode that skipped the rest of the checks would make `npm run check`
  // green on a config the real boot rejects.
  const err = refusal({ FLEET_BATCH_SIZE: "abc" }, { strict: false });
  assert.equal(err.problems.length, 1);
  assert.equal(err.problems[0].name, "FLEET_BATCH_SIZE");
});

/* ------------------------------------------------------------------ *
 * The politeness budget (R1.1.5, docs/contracts/politeness-budget.md §5.2).
 *
 * The accept's second clause is "the fleet reads them from config rather than
 * hard-coding", and §5.1 makes that checkable with four tests: one module owns
 * the number, a named variable overrides it, an out-of-range override refuses
 * at boot, and the resolved value is printed at start-up. Each is below.
 * ------------------------------------------------------------------ */

test("§3.2's per-surface numbers have exactly ONE representation, and it is a frozen table", () => {
  assert.ok(Object.isFrozen(SURFACE_BUDGETS));
  for (const [engine, row] of Object.entries(SURFACE_BUDGETS)) {
    assert.ok(Object.isFrozen(row), `${engine}'s budget row must be frozen`);
  }
  // The contract's numbers, asserted as the contract states them. A table that
  // drifts from §3.2 is worse than no table.
  assert.deepEqual(
    { ...SURFACE_BUDGETS.perplexity, ceilingWhy: undefined },
    {
      surface: "perplexity.ai",
      matrixRow: 4,
      maxConcurrency: 1,
      ceilingWhy: undefined,
      probeDelayMinMs: 20_000,
      probeDelayMaxMs: 45_000,
      dailyCap: 400,
    }
  );
  assert.deepEqual(
    { ...SURFACE_BUDGETS.chatgpt, ceilingWhy: undefined },
    {
      surface: "chatgpt.com",
      matrixRow: 5,
      maxConcurrency: 1,
      ceilingWhy: undefined,
      probeDelayMinMs: 30_000,
      probeDelayMaxMs: 90_000,
      dailyCap: 200,
    }
  );
});

test("every engine the fleet may be pointed at has a budget row", () => {
  // An engine in the vocabulary with no budget would be probed at whatever rate
  // falls out of FLEET_BATCH_SIZE — throttling as an accident, which is the one
  // thing the contract exists to replace.
  assert.deepEqual(surfaceBudgetCoverage().uncovered, []);
  assert.deepEqual(surfaceBudgetCoverage().covered.sort(), [...FLEET_ENGINES].sort());
});

test("with no override, each surface resolves its own §3.2 budget", () => {
  const config = resolveConfig({ ...OK, FLEET_ENGINES: "perplexity,chatgpt" });
  assert.deepEqual(Object.keys(config.budgets), ["perplexity", "chatgpt"]);
  assert.equal(config.budgets.perplexity.probeDelayMinMs, 20_000);
  assert.equal(config.budgets.perplexity.probeDelayMaxMs, 45_000);
  assert.equal(config.budgets.perplexity.dailyCap, 400);
  assert.equal(config.budgets.chatgpt.probeDelayMaxMs, 90_000);
  assert.equal(config.budgets.chatgpt.dailyCap, 200);
  assert.equal(config.budgets.chatgpt.maxConcurrency, 1);
});

test("a valid override replaces the table value for every surface this container drives", () => {
  const config = resolveConfig({
    ...OK,
    FLEET_ENGINES: "perplexity,chatgpt",
    FLEET_LEASE_MS: "600000",
    FLEET_BATCH_SIZE: "1",
    FLEET_PROBE_DELAY_MIN_MS: "5000",
    FLEET_PROBE_DELAY_MAX_MS: "9000",
    FLEET_DAILY_CAP: "50",
    FLEET_MAX_CONCURRENCY: "1",
    FLEET_CANARY_INTERVAL_MS: "1800000",
    FLEET_PROBE_TIMEOUT_MS: "20000",
  });
  for (const engine of ["perplexity", "chatgpt"]) {
    assert.equal(config.budgets[engine].probeDelayMinMs, 5_000);
    assert.equal(config.budgets[engine].probeDelayMaxMs, 9_000);
    assert.equal(config.budgets[engine].dailyCap, 50);
  }
  assert.equal(config.canaryIntervalMs, 1_800_000);
  assert.equal(config.probeTimeoutMs, 20_000);
  assert.deepEqual(config.adjustments, []);
});

for (const [name, raw, low, high] of [
  ["FLEET_MAX_CONCURRENCY", "3", 1, 2],
  ["FLEET_MAX_CONCURRENCY", "0", 1, 2],
  ["FLEET_PROBE_DELAY_MIN_MS", "-1", 0, 600_000],
  ["FLEET_PROBE_DELAY_MAX_MS", "600001", 0, 600_000],
  ["FLEET_DAILY_CAP", "0", 1, 100_000],
  ["FLEET_CANARY_INTERVAL_MS", "60000", 300_000, 86_400_000],
  ["FLEET_PROBE_TIMEOUT_MS", "1000", 5_000, 600_000],
]) {
  test(`${name}=${raw} refuses at boot instead of being clamped into [${low}, ${high}]`, () => {
    const err = refusal({ ...OK, [name]: raw });
    assert.equal(err.problems[0].name, name);
    assert.equal(err.problems[0].kind, "out_of_range");
    assert.match(err.message, new RegExp(`between ${low} and ${high}`));
  });
}

test("an unparseable budget value refuses rather than falling back to the surface default", () => {
  const err = refusal({ ...OK, FLEET_DAILY_CAP: "lots" });
  assert.equal(err.problems[0].kind, "unparseable");
});

test("a blank per-surface override says the default is per-surface, not 'null'", () => {
  const err = refusal({ ...OK, FLEET_PROBE_DELAY_MAX_MS: "" });
  assert.equal(err.problems[0].kind, "blank");
  assert.match(err.message, /perplexity\.ai 45000/, "a default of 'null' is not an answer");
});

test("CONFLICT — a concurrency above a logged-out UI's ceiling refuses, naming the surface", () => {
  // 2 is inside FLEET_MAX_CONCURRENCY's own 1–2 range, and still wrong here:
  // §3.3 caps a logged-out consumer UI at 1, and that ceiling lives in the
  // budget table rather than in a second copy of the rule.
  const err = refusal({ ...OK, FLEET_MAX_CONCURRENCY: "2" });
  assert.equal(err.problems[0].kind, "conflict");
  assert.equal(err.problems[0].name, "FLEET_MAX_CONCURRENCY");
  assert.match(err.message, /perplexity\.ai/);
  assert.match(err.message, /FLEET_MAX_CONCURRENCY=2/);
});

test("CONFLICT — a delay window whose max is not above its min refuses", () => {
  // Equal bounds are a FIXED delay, and a fixed delay is a signature: perfectly
  // periodic, and it synchronises every container that started together (§3.4).
  const err = refusal({ ...OK, FLEET_PROBE_DELAY_MIN_MS: "9000", FLEET_PROBE_DELAY_MAX_MS: "9000" });
  assert.equal(err.problems[0].kind, "conflict");
  assert.match(err.message, /strictly\s+greater/);

  // Setting only the minimum, above the surface's own maximum, is the case an
  // operator actually hits: one variable typed, one inherited from §3.2.
  const inverted = refusal({ ...OK, FLEET_PROBE_DELAY_MIN_MS: "50000" });
  assert.equal(inverted.problems[0].kind, "conflict");
  // It must say which bound the operator set and which came from the table.
  assert.match(inverted.message, /FLEET_PROBE_DELAY_MIN_MS/);
  assert.match(inverted.message, /the perplexity\.ai default/);
});

test("CONFLICT — a batch the operator set that cannot fit one lease refuses, naming both", () => {
  const err = refusal({ ...OK, FLEET_BATCH_SIZE: "5" });
  assert.equal(err.problems[0].kind, "conflict");
  assert.equal(err.problems[0].name, "FLEET_BATCH_SIZE");
  assert.match(err.message, /FLEET_LEASE_MS=300000/);
  assert.match(err.message, /at most 2/);
  // Why it matters, not just that it is wrong: the requests get made and the
  // results get refused.
  assert.match(err.message, /complete_probe_tasks would refuse/);
});

test("CONFLICT — a lease too short for even ONE paced probe refuses outright", () => {
  // Nothing to narrow here: batch size 1 already outlives the lease.
  const err = refusal({ ...OK, FLEET_LEASE_MS: "30000", FLEET_BATCH_SIZE: "1" });
  assert.equal(err.problems[0].kind, "conflict");
  assert.equal(err.problems[0].name, "FLEET_LEASE_MS");
  assert.match(err.message, /single perplexity\.ai probe/);
});

test("the slowest surface a container drives sets the batch ceiling", () => {
  // chatgpt.com's 90s max delay binds before perplexity.ai's 45s does, and the
  // message must name the one that actually bound.
  const err = refusal({
    ...OK,
    FLEET_ENGINES: "perplexity,chatgpt",
    FLEET_LEASE_MS: "600000",
    FLEET_BATCH_SIZE: "5",
  });
  assert.equal(err.problems[0].kind, "conflict");
  assert.match(err.message, /chatgpt\.com/);
  assert.match(err.message, /at most 4/); // floor(600000 / (90000 + 60000))
});

test("all budget conflicts are reported in one refusal, not one redeploy at a time", () => {
  const err = refusal({
    ...OK,
    FLEET_MAX_CONCURRENCY: "2",
    FLEET_PROBE_DELAY_MIN_MS: "50000",
    FLEET_PROBE_DELAY_MAX_MS: "50000",
  });
  assert.deepEqual(
    err.problems.map((p) => p.name).sort(),
    ["FLEET_MAX_CONCURRENCY", "FLEET_PROBE_DELAY_MAX_MS"]
  );
});

test("the resolved budget is printed at start-up, and the cap says it is not enforced", () => {
  const line = describeConfig(resolveConfig({ ...OK, FLEET_ENGINES: "perplexity,chatgpt" }));
  assert.match(line, /budget perplexity \(perplexity\.ai\): concurrency=1 delay=20000-45000ms dailyCap=400/);
  assert.match(line, /budget chatgpt \(chatgpt\.com\): concurrency=1 delay=30000-90000ms dailyCap=200/);
  assert.match(line, /probeTimeoutMs=60000/);
  assert.match(line, /canaryIntervalMs=3600000/);
  // §3.5's cap is fleet-wide and no shared counter exists (§5.3). A number
  // printed as though it were in force is the failure this repo keeps paying
  // for, so the boot log types it.
  assert.match(line, /cap NOT ENFORCED/);
});

test("a budget nothing applies must say so rather than read as a budget in force", () => {
  const config = resolveConfig({ ...OK });
  assert.equal(config.budgetsEnforced, false, "flip this only when probeBatch reads config.budgets");
  assert.match(describeConfig(config), /VALIDATED, NOT APPLIED/);
});

/* ------------------------------------------------------------------ *
 * The documentation is part of the contract.
 * ------------------------------------------------------------------ */

test("GUARD — every configuration variable is documented in worker/README.md", async () => {
  const readme = await readFile(path.join(REPO, "worker/README.md"), "utf8");
  for (const field of CONFIG_FIELDS) {
    assert.match(
      readme,
      new RegExp(`\`${field.name}\``),
      `${field.name} is read at boot but not documented in worker/README.md`
    );
  }
  for (const engine of FLEET_ENGINES) {
    assert.match(readme, new RegExp(engine), `the engine vocabulary must name ${engine}`);
  }
});

test("GUARD — every budget variable is discoverable in .env.example", async () => {
  // §5.1's second test: a number an operator cannot find is not configuration.
  // Scoped to the budget fields on purpose — the other six FLEET_* variables
  // are absent from .env.example too, and that gap is recorded against R1.1.3
  // rather than fixed here.
  const example = await readFile(path.join(REPO, ".env.example"), "utf8");
  for (const name of [
    "FLEET_MAX_CONCURRENCY",
    "FLEET_PROBE_DELAY_MIN_MS",
    "FLEET_PROBE_DELAY_MAX_MS",
    "FLEET_DAILY_CAP",
    "FLEET_CANARY_INTERVAL_MS",
    "FLEET_PROBE_TIMEOUT_MS",
  ]) {
    assert.ok(
      CONFIG_FIELDS.some((f) => f.name === name),
      `${name} is guarded here but is not a configuration field`
    );
    assert.match(example, new RegExp(name), `${name} is read at boot but absent from .env.example`);
  }
});

/* ------------------------------------------------------------------ *
 * R1.2.12 — Production database refusal guard for laptop workers.
 *
 * A worker process refuses to start against the production database unless
 * explicitly armed, in the same shape liveDbGate uses for tests.
 * ------------------------------------------------------------------ */

test("R1.2.12 — worker refuses to boot when app production values are present without explicit arming", () => {
  const prodAppEnv = {
    NEXT_PUBLIC_SUPABASE_URL: "https://production-app.supabase.co",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "ey-anon-token-123",
  };
  const err = refusal(prodAppEnv);
  assert.equal(err.problems[0].name, "SUPABASE_URL");
  assert.equal(err.problems[0].kind, "production_refusal");
  assert.match(err.message, /refuses to start against the production database without explicit arming/);
});

test("R1.2.12 — worker refuses when SUPABASE_URL targets the same host as NEXT_PUBLIC_SUPABASE_URL", () => {
  const matchingEnv = {
    SUPABASE_URL: "https://production-app.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "sk-service-key-123",
    NEXT_PUBLIC_SUPABASE_URL: "https://production-app.supabase.co",
  };
  const err = refusal(matchingEnv);
  assert.equal(err.problems[0].kind, "production_refusal");
  assert.match(err.message, /matches application database credentials/);
});

test("R1.2.12 — worker refuses when SUPABASE_URL targets the same host as DATABASE_URL", () => {
  const matchingEnv = {
    SUPABASE_URL: "https://prod-db.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "sk-service-key-123",
    DATABASE_URL: "postgresql://postgres:secret@prod-db.supabase.co:5432/postgres",
  };
  const err = refusal(matchingEnv);
  assert.equal(err.problems[0].kind, "production_refusal");
  assert.match(err.message, /matches application database credentials/);
});

test("R1.2.12 — worker starts when explicitly armed with FLEET_ALLOW_PRODUCTION_DB=true", () => {
  const armedEnv = {
    NEXT_PUBLIC_SUPABASE_URL: "https://production-app.supabase.co",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "ey-anon-token-123",
    FLEET_ALLOW_PRODUCTION_DB: "true",
  };
  const config = resolveConfig(armedEnv);
  assert.equal(config.supabaseUrl, "https://production-app.supabase.co");
  assert.equal(config.allowProductionDb, true);
  assert.match(describeConfig(config), /allowProductionDb=true/);
});

test("R1.2.12 — worker starts when explicitly armed with FLEET_ARM_PRODUCTION_DB alias", () => {
  const armedEnv = {
    NEXT_PUBLIC_SUPABASE_URL: "https://production-app.supabase.co",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "ey-anon-token-123",
    FLEET_ARM_PRODUCTION_DB: "true",
  };
  const config = resolveConfig(armedEnv);
  assert.equal(config.supabaseUrl, "https://production-app.supabase.co");
  assert.equal(config.allowProductionDb, true);
});

test("R1.2.12 — worker starts without arming when SUPABASE_URL points to a distinct dev database", () => {
  const devEnv = {
    SUPABASE_URL: "https://dev-project.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "sk-dev-service-key-123",
    NEXT_PUBLIC_SUPABASE_URL: "https://production-app.supabase.co",
  };
  const config = resolveConfig(devEnv);
  assert.equal(config.supabaseUrl, "https://dev-project.supabase.co");
  assert.equal(config.allowProductionDb, false);
});

test("R1.2.12 ACCEPT — starting worker process via CLI with app production values exits non-zero with refusal", async () => {
  const run = promisify(execFile);
  const env = {
    ...process.env,
    NEXT_PUBLIC_SUPABASE_URL: "https://prod-cluster.supabase.co",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-key-abc",
  };
  // Delete explicit worker keys and arming flags so it inherits the app values
  delete env.SUPABASE_URL;
  delete env.SUPABASE_SERVICE_ROLE_KEY;
  delete env.FLEET_ALLOW_PRODUCTION_DB;
  delete env.FLEET_ARM_PRODUCTION_DB;
  delete env.ARM_LIVE_DB;

  let failed = null;
  try {
    await run(process.execPath, [path.join(REPO, "worker/src/index.js")], { env, timeout: 30_000 });
  } catch (err) {
    failed = err;
  }

  assert.ok(failed, "worker must exit non-zero when inheriting app production values");
  assert.equal(failed.code, 1, "exit code must be 1 on boot refusal");
  assert.match(
    failed.stderr,
    /fatal: the fleet refuses to start/,
    "stderr must announce boot refusal"
  );
  assert.match(
    failed.stderr,
    /refuses to start against the production database without explicit arming/,
    "stderr must name the production refusal guard"
  );
  assert.match(
    failed.stderr,
    /FLEET_ALLOW_PRODUCTION_DB=true/,
    "stderr must instruct how to explicitly arm if intended"
  );
});

test("R1.2.12 GUARD — all fleet credentials and configuration variables are discoverable in .env.example", async () => {
  const example = await readFile(path.join(REPO, ".env.example"), "utf8");
  const fleetVars = [
    "SUPABASE_URL",
    "SUPABASE_SERVICE_ROLE_KEY",
    "FLEET_ALLOW_PRODUCTION_DB",
    "FLEET_ENGINES",
    "FLEET_BATCH_SIZE",
    "FLEET_LEASE_MS",
    "FLEET_IDLE_POLL_MS",
    "FLEET_HEARTBEAT_MS",
    "FLEET_WORKER_ID",
    "FLEET_MAX_CONCURRENCY",
    "FLEET_PROBE_DELAY_MIN_MS",
    "FLEET_PROBE_DELAY_MAX_MS",
    "FLEET_DAILY_CAP",
    "FLEET_CANARY_INTERVAL_MS",
    "FLEET_PROBE_TIMEOUT_MS",
  ];

  for (const name of fleetVars) {
    assert.ok(
      CONFIG_FIELDS.some((f) => f.name === name),
      `${name} is guarded here but is not a configuration field in CONFIG_FIELDS`
    );
    assert.match(example, new RegExp(name), `${name} is read at boot but absent from .env.example`);
  }
});

test("R1.2.18 — fleet:dev script loads .env.local before .env.fleet.local", async () => {
  const pkgJson = JSON.parse(await readFile(path.join(REPO, "package.json"), "utf8"));
  const script = pkgJson.scripts["fleet:dev"];
  assert.ok(script, "fleet:dev script must exist in package.json");

  const idxApp = script.indexOf("--env-file-if-exists=.env.local");
  const idxFleet = script.indexOf("--env-file-if-exists=.env.fleet.local");

  assert.ok(idxApp !== -1, "fleet:dev must specify --env-file-if-exists=.env.local");
  assert.ok(idxFleet !== -1, "fleet:dev must specify --env-file-if-exists=.env.fleet.local");
  assert.ok(
    idxApp < idxFleet,
    "fleet:dev must load .env.local first and .env.fleet.local second so fleet credentials win"
  );
});

test("R1.2.18 — Node --env-file precedence verifies later files override earlier ones", async () => {
  const os = await import("node:os");
  const fs = await import("node:fs/promises");
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "fleet-env-test-"));

  try {
    const file1 = path.join(tmpDir, "base.env");
    const file2 = path.join(tmpDir, "override.env");

    await fs.writeFile(file1, "FLEET_TEST_FLAG_R1218=base_value\n", "utf8");
    await fs.writeFile(file2, "FLEET_TEST_FLAG_R1218=override_value\n", "utf8");

    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execFileAsync = promisify(execFile);

    const { stdout } = await execFileAsync(
      process.execPath,
      [
        `--env-file=${file1}`,
        `--env-file=${file2}`,
        "-e",
        "console.log(process.env.FLEET_TEST_FLAG_R1218)",
      ],
      { encoding: "utf8" }
    );

    assert.equal(stdout.trim(), "override_value", "later --env-file flag must override earlier flag");
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("R1.2.18 — PRODUCTION_SUPABASE_URL is discoverable in .env.example", async () => {
  const example = await readFile(path.join(REPO, ".env.example"), "utf8");
  assert.match(
    example,
    /PRODUCTION_SUPABASE_URL=/,
    "PRODUCTION_SUPABASE_URL placeholder must be documented in .env.example"
  );
});

test("R1.2.17 — ARM_LIVE_DB is dropped and does not arm production", () => {
  const err = refusal({
    SUPABASE_URL: "https://prod.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "prod-key",
    NEXT_PUBLIC_SUPABASE_URL: "https://prod.supabase.co",
    ARM_LIVE_DB: "true",
  });
  assert.ok(err, "ARM_LIVE_DB must not arm production");
  assert.equal(err.problems[0].kind, "production_refusal");
});

test("R1.2.17 — non-strict config resolution nulls out production credentials when unarmed", () => {
  const cfg = resolveConfig(
    {
      SUPABASE_URL: "https://prod.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "prod-key",
      NEXT_PUBLIC_SUPABASE_URL: "https://prod.supabase.co",
    },
    { strict: false }
  );

  assert.equal(cfg.supabaseUrl, null, "supabaseUrl must be nulled out when unarmed against production");
  assert.equal(cfg.supabaseKey, null, "supabaseKey must be nulled out when unarmed against production");
  assert.equal(cfg.allowProductionDb, false);
});

test("R1.2.17 — selftest in production-carrying shell runs safely with nulled credentials", () => {
  const booted = bootConfig(
    {
      SUPABASE_URL: "https://prod.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "prod-key",
      NEXT_PUBLIC_SUPABASE_URL: "https://prod.supabase.co",
    },
    { strict: false }
  );

  assert.ok(booted.config, "selftest boots with non-strict config");
  assert.equal(booted.config.supabaseUrl, null, "selftest config must never carry production url");
  assert.equal(booted.config.supabaseKey, null, "selftest config must never carry production key");
});


