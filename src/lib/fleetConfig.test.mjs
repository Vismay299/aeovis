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

const { resolveConfig, describeConfig, isRequired, CONFIG_FIELDS, FLEET_ENGINES, FleetConfigError } =
  await import(CONFIG_URL);
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
  assert.equal(config.batchSize, 5);
  assert.equal(config.leaseMs, 300_000);
  assert.equal(config.idlePollMs, 10_000);
  assert.equal(config.heartbeatMs, 30_000);
  assert.match(config.workerId, /^worker-\d+$/);
  assert.deepEqual(config.missing, []);
  assert.deepEqual(config.adjustments, []);
});

test("required vs optional is data on the field, not a convention in the prose", () => {
  assert.equal(isRequired("SUPABASE_URL"), true);
  assert.equal(isRequired("SUPABASE_SERVICE_ROLE_KEY"), true);
  for (const name of [
    "FLEET_ENGINES",
    "FLEET_BATCH_SIZE",
    "FLEET_LEASE_MS",
    "FLEET_IDLE_POLL_MS",
    "FLEET_HEARTBEAT_MS",
    "FLEET_WORKER_ID",
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
  const config = resolveConfig({ ...OK, FLEET_LEASE_MS: "30000" });
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
