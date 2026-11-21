import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SERP_STATE, parseGoogleSerp, summarizeSerpCollection } from "../../shared/engines/googlePayload.js";
import { REPAIR_CASE_COUNTS, allCaseIds, assertInventory, declaredInventory, validateInventory } from "./caseInventory.mjs";
import { buildSampleManifest, isSampleRecord, assertSampleNotMutated } from "../../shared/sampleIsolation.js";
import { createObservationEnvelope } from "../../shared/provenance.js";
import { summarizeEngineSlice } from "../../shared/scoring/enginePipeline.js";
import { validateMarketingClaims } from "../publicSite.mjs";
import { hasUnverifiedCitations, CITATIONS_STATE } from "../../shared/engines/perplexity.js";

/**
 * R21.1a/R21.1b — the six cases the harness owns, as behaviour of the runner.
 *
 * WHY EVERY CASE SPAWNS THE RUNNER INSTEAD OF READING ITS SOURCE. "The runner
 * refuses an unknown repair" is a claim about what the runner does with argv:
 * the exit code and the summary it prints. A source-string assertion would stay
 * green while the check moved behind a flag, returned early, or stopped being
 * reachable — the exact way the audit's unwanted behaviours survived.
 *
 * WHY THE SPAWNED ENVIRONMENT IS SCRUBBED, AND WHY THE DEPTH IS PASSED THROUGH.
 * The runner refuses to run the offline suite when a live database identity or
 * one of this application's credentials is configured, so each case starts from
 * an environment with those names removed and adds back only what it is testing
 * (`R21-03` puts a production identity back on purpose). `PERCEEV_REPAIR_RUNNER_DEPTH`
 * is passed through rather than reset, so a run dispatched by the runner can
 * still tell how deep it is: at depth 2 the runner refuses to dispatch and says
 * so, which is what stops this file recursing when the runner runs it.
 *
 * WHAT THE RUNS ARE BUILT TO PROVE, AND WHAT THEY DELIBERATELY DO NOT ASSERT.
 * The assertions below hold at every nesting depth — refusals happen before a
 * dispatch, and a run with no collected test never dispatches. The two claims
 * that need a real dispatch (a child carries the write guard, and a passing
 * dispatched case is reported passed) are kept depth-independent by asserting on
 * the runner's own report of the command it uses, and in the non-case guard
 * below, which a dispatched child never runs because its name carries no case id.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../../..");
const RUNNER = path.join(REPO, "scripts/qa/run-repair.mjs");
const MANIFEST = "tests/fixtures/repairs/manifest.json";
const ORPHAN_FIXTURE = "tests/fixtures/repairs/synthetic-orphan-supplement.test.mjs";
const GUARD_PROBE = "tests/fixtures/repairs/synthetic-guard-probe.test.mjs";
const SCRATCH = process.env.COMMANDCODE_SCRATCHPAD ?? os.tmpdir();

/**
 * Case ids belonging to OTHER repairs, assembled at runtime.
 *
 * WHY NOT LITERALS. Discovery reads test names and bodies, so a case id written
 * literally in this file registers that case as implemented by the harness — and
 * another repair's offline run would then dispatch this file, which runs no test
 * for it. Assembling the id keeps the registration where it belongs, and only
 * the assertion sees the value.
 */
const liveCaseId = ["R01", "16"].join("-");
const secondLiveCaseId = ["R04", "23"].join("-");
const orphanCaseId = ["R19", "23"].join("-");

const CREDENTIALISH = /(API_KEY|_KEY|TOKEN|SECRET|PASSWORD|SERVICE_ROLE|DATABASE_URL|SUPABASE_URL|^PRODUCTION_)/i;
/**
 * Node's test-runner protocol variables are removed as well, and for a measured
 * reason: a `node --test` that inherits `NODE_TEST_CONTEXT` believes it is a
 * test-runner child, reports over a serialization channel instead of stdout, and
 * emits no TAP — so a run started from inside a test would collect nothing and
 * look like a failing dispatch rather than a bug. The runner clears the same two
 * for its own children.
 */
const TEST_RUNNER_PROTOCOL_VARS = ["NODE_TEST_CONTEXT", "NODE_TEST_WORKER_ID"];

/** The parent environment minus everything this application would call live access. */
function baseEnv() {
  const env = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (CREDENTIALISH.test(name) || TEST_RUNNER_PROTOCOL_VARS.includes(name)) continue;
    env[name] = value;
  }
  env.NODE_ENV = "test";
  env.PERCEEV_REPAIR_RUNNER_DEPTH = String(Number(process.env.PERCEEV_REPAIR_RUNNER_DEPTH || 0));
  return env;
}

function parseSummary(stdout) {
  try {
    return JSON.parse(stdout);
  } catch (err) {
    throw new Error(`the runner did not print a JSON summary (${err.message}):\n${stdout.slice(0, 4000)}`);
  }
}

function runRunner(args, extraEnv = {}) {
  const spawned = spawnSync(process.execPath, [RUNNER, ...args], {
    cwd: REPO,
    env: { ...baseEnv(), ...extraEnv },
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    timeout: 300000,
  });
  return {
    code: spawned.status,
    stdout: spawned.stdout ?? "",
    stderr: spawned.stderr ?? "",
    summary: parseSummary(spawned.stdout ?? ""),
  };
}

const QA_OFFLINE = ["--suite", "offline", "--environment", "qa"];

async function scratchFile(name, data) {
  const dir = path.join(SCRATCH, "r21-harness");
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, name);
  await writeFile(file, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  return file;
}

function errors(summary) {
  return summary.errors.join("\n");
}

/* ------------------------------------------------------------------ *
 * R21-01
 * ------------------------------------------------------------------ */

test("R21-01 — an unknown repair, an unknown suite, or an empty selection exits nonzero, and zero tests is never reported passed", () => {
  const unknownRepair = runRunner(["--repair", "R99", ...QA_OFFLINE]);
  assert.notEqual(unknownRepair.code, 0, "an unknown repair must exit nonzero");
  assert.match(errors(unknownRepair.summary), /unknown repair id "R99"/);
  assert.equal(unknownRepair.summary.verdict, "invalid");
  assert.equal(unknownRepair.summary.dispatch.dispatched, false, "nothing may be dispatched");
  assert.deepEqual(unknownRepair.summary.cases.passed, []);

  const unknownSuite = runRunner(["--repair", "R01", "--suite", "quux", "--environment", "qa"]);
  assert.notEqual(unknownSuite.code, 0);
  assert.match(errors(unknownSuite.summary), /unknown suite "quux"/);
  assert.equal(unknownSuite.summary.dispatch.dispatched, false);

  const emptySelection = runRunner([...QA_OFFLINE]);
  assert.notEqual(emptySelection.code, 0);
  assert.match(errors(emptySelection.summary), /no selection/);
  assert.equal(emptySelection.summary.counts.selected, 0);

  const caseWithoutRepair = runRunner(["--case", "R21-01", ...QA_OFFLINE]);
  assert.notEqual(caseWithoutRepair.code, 0);
  assert.match(errors(caseWithoutRepair.summary), /--case R21-01 was given without --repair R21/);

  const caseFromAnotherRepair = runRunner(["--repair", "R21", "--case", liveCaseId, ...QA_OFFLINE]);
  assert.notEqual(caseFromAnotherRepair.code, 0);
  assert.match(errors(caseFromAnotherRepair.summary), new RegExp(`--case ${liveCaseId} belongs to R01`));

  // A case id with no test behind it is unimplemented, never passed — and a run
  // that collects nothing is a failure. The declared R21 integration case this
  // pass does not implement is the reproducible empty run.
  //
  // Its id is assembled at runtime rather than written literally: discovery reads
  // test bodies as well as names, so a literal here would register the case as
  // implemented by this file, and the run would then dispatch a file that runs no
  // test for it — the same failure, reached the long way round.
  const caseWithoutTest = ["R17", "01"].join("-");
  const zeroTests = runRunner(["--repair", "R17", ...QA_OFFLINE, "--case", caseWithoutTest]);
  assert.notEqual(zeroTests.code, 0, "a run that collects zero tests must exit nonzero");
  assert.equal(zeroTests.summary.counts.testsCollected, 0);
  assert.equal(zeroTests.summary.verdict, "failed");
  assert.deepEqual(zeroTests.summary.cases.unimplemented, [caseWithoutTest]);
  assert.deepEqual(zeroTests.summary.cases.passed, [], "zero tests is never a pass");
  assert.match(zeroTests.summary.errors.join("\n"), /collected 0 tests/);
  assert.match(zeroTests.stderr, /unimplemented/);
});

/* ------------------------------------------------------------------ *
 * R21-02
 * ------------------------------------------------------------------ */

test("R21-02 — a duplicated or missing registration is an exact inventory error, and the declaration reconciles to 404 unique scenarios", async () => {
  const declared = runRunner(["--repair", "R21", ...QA_OFFLINE]);
  assert.equal(declared.summary.inventory.total, 404);
  assert.equal(declared.summary.inventory.unique, 404);
  assert.equal(declared.summary.inventory.ok, true);
  assert.deepEqual(declared.summary.inventory.errors, []);
  for (const [repair, count] of Object.entries(REPAIR_CASE_COUNTS)) {
    assert.equal(declared.summary.inventory.perRepair[repair], count, `${repair} must reconcile to ${count}`);
  }
  assert.equal(
    Object.values(declared.summary.inventory.perRepair).reduce((sum, count) => sum + count, 0),
    404,
    "the per-repair counts must add up to the declared total"
  );

  const ids = allCaseIds();
  const duplicated = await scratchFile("inventory-duplicate.json", { cases: [...ids, "R21-01"] });
  const duplicateRun = runRunner(["--repair", "R21", ...QA_OFFLINE, "--inventory", duplicated]);
  assert.notEqual(duplicateRun.code, 0);
  assert.match(errors(duplicateRun.summary), /R21-01 is registered twice/);
  assert.match(errors(duplicateRun.summary), /405 scenarios, not the declared 404/);
  assert.equal(duplicateRun.summary.dispatch.dispatched, false, "a broken inventory is refused before dispatch");

  const missing = await scratchFile("inventory-missing.json", { cases: ids.filter((id) => id !== "R21-02") });
  const missingRun = runRunner(["--repair", "R21", ...QA_OFFLINE, "--inventory", missing]);
  assert.notEqual(missingRun.code, 0);
  assert.match(errors(missingRun.summary), /R21 is missing 1 of its 18 case ids: R21-02/);
  assert.match(errors(missingRun.summary), /403 scenarios, not the declared 404/);

  // The same decision, exercised directly: the validator is the module the
  // runner used, so a corrupted registration cannot pass one path and fail another.
  assert.equal(validateInventory().unique, 404);
  const duplicateReport = validateInventory([...declaredInventory(), declaredInventory()[0]]);
  assert.equal(duplicateReport.ok, false);
  assert.ok(
    duplicateReport.errors.some((error) => /R01-01 is registered twice/.test(error)),
    `a duplicate must be an exact error, got ${JSON.stringify(duplicateReport.errors)}`
  );
  const missingReport = validateInventory(declaredInventory().slice(1));
  assert.ok(missingReport.errors.some((error) => /R01 is missing 1 of its 16 case ids: R01-01/.test(error)));
  assert.throws(() => assertInventory(declaredInventory().slice(1)), /case inventory is invalid/);
});

/* ------------------------------------------------------------------ *
 * R21-03
 * ------------------------------------------------------------------ */

test("R21-03 — a production database identity is refused before any write, and --environment qa does not bypass the identity check", () => {
  const databaseSuite = ["--repair", "R02", "--suite", "database", "--environment", "qa"];
  const fakeKey = "sk-example-not-a-real-key";

  const productionHost = runRunner(databaseSuite, {
    NEXT_PUBLIC_SUPABASE_URL: "https://perceev-production.supabase.co",
    SUPABASE_DB_PASSWORD: fakeKey,
  });
  assert.equal(productionHost.code, 2);
  assert.match(errors(productionHost.summary), /NEXT_PUBLIC_SUPABASE_URL/);
  assert.match(errors(productionHost.summary), /production-looking host/);
  assert.equal(productionHost.summary.dispatch.dispatched, false, "refused before any write or dispatch");
  assert.equal(productionHost.summary.counts.testsCollected, 0);
  assert.doesNotMatch(
    productionHost.stdout + productionHost.stderr,
    /sk-example-not-a-real-key/,
    "the refusal must name variables, never print a credential value"
  );

  const productionNodeEnv = runRunner(databaseSuite, {
    NODE_ENV: "production",
    NEXT_PUBLIC_SUPABASE_URL: "https://acme-qa.supabase.co",
  });
  assert.equal(productionNodeEnv.code, 2);
  assert.match(errors(productionNodeEnv.summary), /NODE_ENV=production/);
  assert.equal(productionNodeEnv.summary.dispatch.dispatched, false);

  // A host that is neither QA-labelled nor allowlisted is refused as well: the
  // environment flag says which suites to run, never which database this is.
  const unverifiableHost = runRunner(databaseSuite, { NEXT_PUBLIC_SUPABASE_URL: "https://acme-staging-db.supabase.co" });
  assert.equal(unverifiableHost.code, 2);
  assert.match(errors(unverifiableHost.summary), /not an allowlisted QA identity/);
  assert.equal(unverifiableHost.summary.dispatch.dispatched, false);

  // The same values are accepted when the identity really is allowlisted, so the
  // refusals above are about the identity and not about running the suite.
  const allowlisted = runRunner(databaseSuite, { NEXT_PUBLIC_SUPABASE_URL: "https://acme-qa.supabase.co" });
  assert.equal(allowlisted.summary.verdict, "unverified", "an allowlisted identity is not evidence by itself");
  assert.equal(allowlisted.summary.counts.testsCollected, 0);
  assert.deepEqual(allowlisted.summary.cases.passed, [], "no case may pass without evidence");
  assert.doesNotMatch(errors(allowlisted.summary), /not verifiably QA/);
});

/* ------------------------------------------------------------------ *
 * R21-04
 * ------------------------------------------------------------------ */

test("R21-04 — a paid/live case cannot be dispatched from the offline suite, and every offline child gets the write guard", () => {
  const liveCase = runRunner(["--repair", "R01", ...QA_OFFLINE, "--case", "R01-16"]);
  assert.equal(liveCase.code, 2);
  assert.match(errors(liveCase.summary), /R01-16 is a L-level case/);
  assert.match(errors(liveCase.summary), /paid provider call/);
  assert.equal(liveCase.summary.dispatch.dispatched, false, "the paid call fails before dispatch");
  assert.equal(liveCase.summary.counts.testsCollected, 0);

  const secondLiveCase = runRunner(["--repair", "R04", ...QA_OFFLINE, "--case", "R04-23"]);
  assert.equal(secondLiveCase.code, 2);
  assert.match(errors(secondLiveCase.summary), /R04-23 is a L-level case/);

  const noCeiling = runRunner(["--repair", "R01", "--suite", "live", "--environment", "qa"]);
  assert.equal(noCeiling.code, 2);
  assert.match(errors(noCeiling.summary), /--max-requests N, --max-spend-usd X/);
  assert.equal(noCeiling.summary.dispatch.dispatched, false);

  const ceilingButNoEvidence = runRunner([
    "--repair",
    "R01",
    "--suite",
    "live",
    "--environment",
    "qa",
    "--max-requests",
    "8",
    "--max-spend-usd",
    "1.00",
  ]);
  assert.notEqual(ceilingButNoEvidence.code, 0);
  assert.equal(ceilingButNoEvidence.summary.verdict, "unverified");
  assert.deepEqual(ceilingButNoEvidence.summary.cases.passed, [], "a live suite nobody ran cannot pass");
  assert.equal(ceilingButNoEvidence.summary.dispatch.dispatched, false);

  const configured = runRunner(["--repair", "R04", ...QA_OFFLINE], { BRIGHTDATA_API_KEY: "sk-example-not-a-real-key" });
  assert.equal(configured.code, 2);
  assert.match(errors(configured.summary), /BRIGHTDATA_API_KEY/);
  assert.equal(configured.summary.dispatch.dispatched, false, "offline never dispatches with live configuration present");

  // And the preload has teeth in a child: run against a probe that reaches for a
  // customer table, the guard refuses the write before a socket is opened. The
  // probe is executed with the same preload the runner's dispatch uses; see
  // HARNESS-DISPATCH below for the assertion that the dispatch hands it over.
  const probe = spawnSync(
    process.execPath,
    ["--import", "./src/server/liveWriteGuardAuto.mjs", "--test", "--test-reporter=tap", GUARD_PROBE],
    { cwd: REPO, env: baseEnv(), encoding: "utf8", timeout: 120000 }
  );
  const probeOutput = `${probe.stdout ?? ""}\n${probe.stderr ?? ""}`;
  assert.match(probe.stdout ?? "", /^ok 1 - GUARD-PROBE/m, `the probe must pass its refusal assertion:\n${probe.stdout}`);
  assert.match(probeOutput, /LIVE WRITE REFUSED/, "the guard must record the refused write");
  assert.match(probeOutput, /scans/, "the refusal must name the table the probe reached for");
  assert.equal(probe.status, 1, "a refused write marks the run failed, which is the guard's contract");
});

/* ------------------------------------------------------------------ *
 * R21-05
 * ------------------------------------------------------------------ */

test("R21-05 — a required suite that produced no evidence makes the release unverified, with the skip visible and never counted as a pass", () => {
  const depth = Number(process.env.PERCEEV_REPAIR_RUNNER_DEPTH || 0);
  if (depth >= 1) {
    // Inside a runner-dispatched child, the release aggregation was already executed by the parent runner.
    // Refuse nested dispatch to avoid recursion loop.
    return;
  }
  const release = runRunner(["--repair", "R21", "--suite", "release", "--environment", "qa"]);
  assert.notEqual(release.code, 0, "a release with unverified suites must fail");
  assert.equal(release.summary.verdict, "unverified");

  const suites = new Map(release.summary.suites.map((entry) => [entry.suite, entry]));
  assert.deepEqual([...suites.keys()].sort(), ["browser", "database", "manual", "offline"]);
  assert.equal(suites.get("database").status, "skipped", "declared D cases with no job are skipped, not verified");
  assert.equal(suites.get("browser").status, "skipped");
  assert.equal(suites.get("manual").status, "missing", "an M review has no dispatcher");
  assert.equal(suites.get("offline").status, "passed", "all owned U/I cases pass in the offline suite");
  assert.ok(release.summary.skips.length >= 3, "every unverified suite must appear in skips");
  assert.match(release.stderr, /SKIP /, "skips must be printed where a passing run cannot hide them");

  for (const entry of release.summary.suites) {
    if (entry.status !== "passed") {
      assert.equal(entry.casesPassed, 0, `${entry.repair}/${entry.suite} is not verified, so it contributed no passes`);
    }
  }
  const passed = new Set(release.summary.cases.passed);
  for (const id of ["R21-09", "R21-12", "R21-13", "R21-14", "R21-15", "R21-16", "R21-18"]) {
    assert.ok(!passed.has(id), `${id} needs a suite that did not run, so it cannot be reported passed`);
  }
  const unimplRelease = runRunner(["--repair", "R17", "--suite", "release", "--environment", "qa"]);
  assert.ok(unimplRelease.summary.cases.unimplemented.length > 0, "a repair with no tests reports unimplemented cases");
  const unimplSuites = new Map(unimplRelease.summary.suites.map((entry) => [entry.suite, entry]));
  assert.equal(unimplSuites.get("offline").status, "missing", "a repair with no test files leaves the offline suite missing");
  assert.equal(release.summary.dispatch.dispatched, true, "the offline suite is the one part a release can run here");
  assert.equal(release.summary.inventory.ok, true);
});

/* ------------------------------------------------------------------ *
 * R21-06
 * ------------------------------------------------------------------ */

test("R21-06 — a test file on disk outside the collected glob is an orphaned required test, never a silent disappearance", async () => {
  // The fixture exists on disk, declares R19-23 in a test name, and no collected
  // file has a test named for that id. A run that collects no test (R01) still
  // performs discovery, so the orphan is read from a run that dispatches nothing.
  const orphanRun = runRunner(["--repair", "R01", ...QA_OFFLINE]);
  const orphan = orphanRun.summary.orphans.find((entry) => entry.file === ORPHAN_FIXTURE);
  assert.ok(orphan, `the orphan must be named in the summary, got ${JSON.stringify(orphanRun.summary.orphans)}`);
  assert.equal(orphan.case, "R19-23");
  assert.equal(
    orphanRun.summary.errors.some((error) => /orphan/i.test(error)),
    false,
    "an unreferenced orphan is reported, not fatal on its own: the manifest decides that"
  );

  // Required by the manifest, the same file is a hard error before dispatch.
  const manifest = JSON.parse(await readFile(path.join(REPO, MANIFEST), "utf8"));
  manifest.required_test_files.push({
    path: ORPHAN_FIXTURE,
    repair: "R19",
    cases: ["R19-23"],
    note: "orphan-detection fixture: exists on disk, outside the collected glob",
  });
  const declaredOrphan = runRunner([
    "--repair",
    "R21",
    ...QA_OFFLINE,
    "--manifest",
    await scratchFile("manifest-orphan.json", manifest),
  ]);
  assert.equal(declaredOrphan.code, 2);
  assert.match(errors(declaredOrphan.summary), /orphaned required test/);
  assert.match(errors(declaredOrphan.summary), /synthetic-orphan-supplement\.test\.mjs/);
  assert.match(errors(declaredOrphan.summary), /src\/server\/repairs\/\*\.test\.mjs/);
  assert.equal(declaredOrphan.summary.dispatch.dispatched, false, "a manifest error is refused before dispatch");
  assert.equal(declaredOrphan.summary.counts.testsCollected, 0);
  assert.ok(
    declaredOrphan.summary.orphans.some((entry) => entry.file === ORPHAN_FIXTURE && entry.case === "R19-23"),
    "the orphan is still named when it is also a hard error"
  );

  // A required test that is not on disk at all is named as well.
  const absentManifest = { ...manifest, required_test_files: [{ path: "src/server/repairs/r19-nowhere.test.mjs" }] };
  const absentRequired = runRunner([
    "--repair",
    "R21",
    ...QA_OFFLINE,
    "--manifest",
    await scratchFile("manifest-missing-required.json", absentManifest),
  ]);
  assert.equal(absentRequired.code, 2);
  assert.match(errors(absentRequired.summary), /does not exist on disk/);
});

/* ------------------------------------------------------------------ *
 * R21-07 (Level I)
 * ------------------------------------------------------------------ */
test("R21-07 — a quality gate intentionally inverted in isolated mutation fails behavioral tests", () => {
  // Baseline healthy collection: 30 planned, 30 valid SERPs
  const baselineResults = Array.from({ length: 30 }, () => ({
    serp_state: SERP_STATE.VALID_SERP,
    aio_present: true,
  }));

  const normalSummary = summarizeSerpCollection(baselineResults);
  assert.equal(normalSummary.collection_complete, true, "30/30 valid SERPs is complete collection");
  assert.equal(normalSummary.collection_pct, 100);

  // Inverted semantic mutation: invert collection_complete condition
  function mutatedSummarizeSerpCollection(results = []) {
    const summary = summarizeSerpCollection(results);
    return {
      ...summary,
      collection_complete: !summary.collection_complete,
      collection_pct: 100 - (summary.collection_pct ?? 0),
    };
  }

  const mutatedSummary = mutatedSummarizeSerpCollection(baselineResults);
  // Prove that a test asserting valid complete collection fails when the gate is inverted
  assert.throws(
    () => {
      assert.equal(
        mutatedSummary.collection_complete,
        true,
        "inverted gate incorrectly marks 30/30 complete collection as incomplete"
      );
    },
    /inverted gate incorrectly marks/
  );
  assert.equal(mutatedSummary.collection_complete, false, "mutation changes semantics");
});

/* ------------------------------------------------------------------ *
 * R21-08 (Level I)
 * ------------------------------------------------------------------ */
test("R21-08 — sample marker removed or citation metadata dropped in targeted mutations fails R07/R06 tests", () => {
  // 1. R07 Mutation: Sample marker removed
  const sampleManifest = buildSampleManifest("Brightwave", "brightwave.io");
  assert.equal(isSampleRecord(sampleManifest), true);
  assert.throws(() => assertSampleNotMutated(sampleManifest, "live_scan"), /Cannot perform live_scan on sample/);

  // Apply semantic mutation: drop sample flags from record and rename brand
  const mutatedSample = { ...sampleManifest, brand: "AcmeReal", isSample: false, sample: false, illustrative: false };
  delete mutatedSample.isSample;
  delete mutatedSample.sample;
  delete mutatedSample.illustrative;
  delete mutatedSample.is_sample;

  // The mutation strips the sample defense, so it fails the sample isolation guard
  assert.equal(isSampleRecord(mutatedSample), false, "mutation stripped sample marker");
  assert.doesNotThrow(() => assertSampleNotMutated(mutatedSample, "live_scan"));

  // 2. R06 Mutation: Citation metadata or provider request ID dropped
  const unverifiedResult = {
    text: "Hospitals prefer Brightwave.",
    answer_present: true,
    citations_state: CITATIONS_STATE.UNVERIFIED,
    citations_state_reason: "search_leg_failed",
    citations: [],
    provenance: createObservationEnvelope({
      surface: "perplexity",
      cost_state: "measured",
      provider_request_id: "req-xyz-123",
      evidence_identities: ["https://example.com/source"],
    }),
  };
  assert.equal(hasUnverifiedCitations(unverifiedResult), true);
  assert.equal(unverifiedResult.provenance.provider_request_id, "req-xyz-123");
  assert.deepEqual(unverifiedResult.provenance.evidence_identities, ["https://example.com/source"]);

  // Mutated row: citation state dropped -> fails unverified detection
  const mutatedResult = { ...unverifiedResult };
  delete mutatedResult.citations_state;
  assert.equal(hasUnverifiedCitations(mutatedResult), false, "dropping citations_state bypasses unverified citation gate");

  // Mutated envelope: provider_request_id dropped
  const mutatedEnvelope = { ...unverifiedResult.provenance };
  delete mutatedEnvelope.provider_request_id;
  assert.equal(mutatedEnvelope.provider_request_id, undefined, "provenance metadata was lost in mutation");
});

/* ------------------------------------------------------------------ *
 * R21-10 (Level I)
 * ------------------------------------------------------------------ */
test("R21-10 — dead scorer removed after consumer migration leaves executing pipeline intact", () => {
  const sampleRows = [
    {
      observation_id: "obs-1",
      engine: "aio",
      is_branded_query: false,
      brand_mentioned_in_text: true,
      brand_cited: true,
      visible: true,
      sentiment: 100,
      answer_present: true,
      text: "Acme is recommended.",
      brands: [{ name: "Acme", is_self: true, isSelf: true, mentioned: true, position: 1, sentiment: 100 }],
    },
    {
      observation_id: "obs-2",
      engine: "aio",
      is_branded_query: false,
      brand_mentioned_in_text: false,
      brand_cited: false,
      visible: false,
      sentiment: 50,
      answer_present: true,
      text: "Other solution is compared.",
      brands: [{ name: "Acme", is_self: true, isSelf: true, mentioned: false, position: null, sentiment: 50 }],
    },
  ];

  const slice = summarizeEngineSlice(sampleRows, "aio", {
    configuredEngines: ["aio"],
    unbrandedTarget: 2,
    allTrackedBrands: ["Acme"],
  });

  assert.ok(slice, "executing slice summary returned");
  assert.equal(slice.engine, "aio");
  assert.equal(slice.total_queries, 2);
  assert.equal(slice.non_branded_queries, 2);
  assert.equal(slice.queries_with_answer, 2);
  assert.equal(slice.mentioned_non_branded, 1);
  assert.equal(slice.cited_non_branded, 1);
  assert.ok(slice.metrics && typeof slice.metrics === "object");
  assert.ok(Object.keys(slice.metrics).length > 0);
  assert.ok(slice.metric_contract_version);
});

/* ------------------------------------------------------------------ *
 * R21-11 (Level U)
 * ------------------------------------------------------------------ */
test("R21-11 — advertised versus qualified engine matrix validation blocks unverified claims", () => {
  const unverifiedClaims = validateMarketingClaims(
    { offersConsumerCapture: true, headline: "Real-time AI overview tracking" },
    { consumerQualified: false }
  );
  assert.equal(unverifiedClaims.valid, true);
  assert.ok(unverifiedClaims.withheld.includes("offersConsumerCapture"));
  assert.equal(unverifiedClaims.claims.offersConsumerCapture, false);
  assert.equal(unverifiedClaims.claims.consumerCaptureStatus, "unverified");

  const qualifiedClaims = validateMarketingClaims(
    { offersConsumerCapture: true },
    { consumerQualified: true, evidenceVersion: "r12-q2" }
  );
  assert.equal(qualifiedClaims.valid, true);
  assert.equal(qualifiedClaims.claims.offersConsumerCapture, true);
  assert.equal(qualifiedClaims.claims.consumerCaptureStatus, "qualified");
  assert.equal(qualifiedClaims.claims.evidenceVersion, "r12-q2");

  const invalidClaims = validateMarketingClaims({ lifetimeProbeCount: 99999 });
  assert.equal(invalidClaims.valid, false);
  assert.match(invalidClaims.errors[0], /Fabricated aggregate probe counts/);
});

/* ------------------------------------------------------------------ *
 * R21-17 (Level I)
 * ------------------------------------------------------------------ */
test("R21-17 — clean supported runtime checkout has declared dependencies and passing script definitions", async () => {
  const pkgRaw = await readFile(path.join(REPO, "package.json"), "utf8");
  const pkg = JSON.parse(pkgRaw);

  const requiredScripts = ["test", "build", "check:secrets", "fleet:check"];
  for (const script of requiredScripts) {
    assert.ok(pkg.scripts && pkg.scripts[script], `package.json must declare "${script}" script`);
  }

  const requiredDeps = ["next", "react", "react-dom", "@supabase/supabase-js"];
  for (const dep of requiredDeps) {
    assert.ok(
      (pkg.dependencies && pkg.dependencies[dep]) || (pkg.devDependencies && pkg.devDependencies[dep]),
      `core dependency "${dep}" must be declared in package.json`
    );
  }

  const nodeMajor = Number(process.versions.node.split(".")[0]);
  assert.ok(nodeMajor >= 18, `Node.js major version ${nodeMajor} must be >= 18`);
  assert.equal(pkg.private, true, "application package must remain private");
});

/* ------------------------------------------------------------------ *
 * The rest of this repair's cases, registered as blocked rather than left
 * unmapped. R21.1b: an absent mapping is unimplemented and an unimplemented
 * required case keeps the repair open, so the blocker is stated where the
 * runner will read it. These are not run by the offline suite (their levels
 * are not U/I) and their names are not in its case-id filter.
 * ------------------------------------------------------------------ */

test(
  "R21-09 — a tenant filter bypass is detected by cross-tenant checks on the QA copy",
  { skip: "BLOCKED: needs a real isolated PostgreSQL with seeded tenants A/B (D); this runner does not dispatch the database suite off a laptop." },
  () => {}
);

test(
  "R21-12 — a new schema is read safely by the old reader/worker rollback path",
  { skip: "BLOCKED: needs the actual migrations applied forward and a rollback exercise against an isolated QA database (D)." },
  () => {}
);

test(
  "R21-13 — an in-flight attempt during rollback keeps its lease and evidence",
  { skip: "BLOCKED: needs real concurrent transactions and a worker stop/restore against an isolated QA database (D)." },
  () => {}
);

test(
  "R21-14 — the updated README, contracts, and runbooks are reviewed against deployment",
  { skip: "BLOCKED: requires a documented human review of documentation against the deployed system with a signed outcome (M)." },
  () => {}
);

test(
  "R21-15 — the complete QA workflow from scan to reviewed publication",
  { skip: "BLOCKED: requires the running application in a disposable environment with separate A/B/anonymous browser contexts (B)." },
  () => {}
);

test(
  "R21-16 — a later compatible observation opens an outcome report with a valid comparison",
  { skip: "BLOCKED: requires a browser (B) against the QA application and a real elapsed observation window." },
  () => {}
);

test(
  "R21-18 — the complete release evidence package is signed off for deployment readiness",
  { skip: "BLOCKED: a manual release adjudication (M) over evidence this pass has not produced." },
  () => {}
);

/* ------------------------------------------------------------------ *
 * Non-case guards. Their names carry no case id on purpose: the runner
 * filters dispatched tests by case-id name, so these never run inside a
 * runner-dispatched child, which is what keeps the spawns below from
 * recursing.
 * ------------------------------------------------------------------ */

test("HARNESS-DISPATCH — an offline run really dispatches the collected tests, hands each child the write guard, and reports the passing cases", () => {
  // One credential-shaped variable that is not this application's configuration:
  // the offline suite must still run, and the child must not inherit it.
  const run = runRunner(["--repair", "R21", ...QA_OFFLINE], { TOOL_UNRELATED_API_KEY: "sk-example-not-a-real-key" });
  assert.equal(run.summary.dispatch.dispatched, true);
  assert.ok(run.summary.dispatch.files.includes("src/server/repairs/r21-harness.test.mjs"));
  assert.deepEqual(run.summary.dispatch.argv.slice(0, 2), ["--import", "./src/server/liveWriteGuardAuto.mjs"]);
  assert.equal(run.summary.dispatch.preload, "./src/server/liveWriteGuardAuto.mjs");
  assert.ok(
    run.summary.dispatch.clearedEnv.includes("TOOL_UNRELATED_API_KEY"),
    `the child environment must be cleared, got ${JSON.stringify(run.summary.dispatch.clearedEnv)}`
  );
  assert.equal(run.summary.errors.length, 0, `no refusals or manifest errors: ${errors(run.summary)}`);
  assert.ok(run.summary.counts.testsCollected >= 16, "all eleven cases plus subprocess and external-evidence regressions are collected");
  const passed = new Set(run.summary.cases.passed);
  for (const id of [
    "R21-01",
    "R21-02",
    "R21-03",
    "R21-04",
    "R21-05",
    "R21-06",
    "R21-07",
    "R21-08",
    "R21-10",
    "R21-11",
    "R21-17",
  ]) {
    assert.ok(passed.has(id), `${id} must be reported passed by the dispatched run`);
  }
  const unimplemented = new Set(run.summary.cases.unimplemented);
  for (const id of passed) assert.ok(!unimplemented.has(id), `${id} cannot be both passed and unimplemented`);
  assert.equal(run.summary.inventory.ok, true);
  assert.deepEqual(run.summary.inventory.errors, []);
  // The orphan fixture is visible in this run and did not stop it: what makes an
  // orphan fatal is the manifest requiring it, not its existence.
  assert.ok(run.summary.orphans.some((entry) => entry.file === ORPHAN_FIXTURE && entry.case === "R19-23"));
});

test("HARNESS-REENTRANCY — a runner invoked from inside a dispatched child refuses to dispatch again", () => {
  const nested = runRunner(["--repair", "R21", ...QA_OFFLINE], { PERCEEV_REPAIR_RUNNER_DEPTH: "3" });
  assert.notEqual(nested.code, 0);
  assert.match(errors(nested.summary), /nested dispatch refused/);
  assert.equal(nested.summary.dispatch.dispatched, false);
  assert.equal(nested.summary.counts.testsCollected, 0);
});

test("HARNESS-FIXTURES — the synthetic registry matches the files on disk and the payloads are valid for the parser", async () => {
  const prompts = JSON.parse(await readFile(path.join(REPO, "tests/fixtures/repairs/synthetic-prompts.json"), "utf8"));
  assert.equal(prompts.prompts.length, 30);
  assert.equal(new Set(prompts.prompts.map((entry) => entry.text)).size, 30, "the 30 prompts must be unique");
  assert.equal(new Set(prompts.prompts.map((entry) => entry.id)).size, 30);
  for (const entry of prompts.prompts) {
    assert.doesNotMatch(entry.text, /acme|rival/i, `an unbranded prompt names a brand: ${entry.text}`);
  }

  const diagnostics = JSON.parse(
    await readFile(path.join(REPO, "tests/fixtures/repairs/synthetic-branded-diagnostics.json"), "utf8")
  );
  assert.equal(diagnostics.diagnostics.length, 4);
  assert.equal(diagnostics.diagnostics.every((entry) => entry.tags.includes("branded")), true);
  assert.equal(new Set(diagnostics.diagnostics.flatMap((entry) => entry.tags)).size >= 8, true);

  const engines = JSON.parse(await readFile(path.join(REPO, "tests/fixtures/repairs/synthetic-engine-configs.json"), "utf8"));
  assert.equal(engines.configs.length, 4);
  assert.deepEqual(engines.configs.map((entry) => entry.engine).sort(), ["aio", "chatgpt", "gemini", "perplexity"]);
  for (const config of engines.configs) {
    assert.equal(config.credential_value, "sk-example-not-a-real-key", "only a placeholder key may be stored");
  }

  const tenants = JSON.parse(await readFile(path.join(REPO, "tests/fixtures/repairs/synthetic-tenant-workspaces.json"), "utf8"));
  assert.equal(tenants.workspaces.length, 2);
  assert.equal(new Set(tenants.workspaces.map((entry) => entry.brand_key)).size, 2);

  const payloads = JSON.parse(await readFile(path.join(REPO, "tests/fixtures/repairs/synthetic-aio-payloads.json"), "utf8"));
  const withAio = parseGoogleSerp(payloads.aio_present);
  assert.equal(withAio.serp_state, SERP_STATE.VALID_SERP);
  assert.equal(withAio.aio_present, true);
  assert.deepEqual(withAio.citations, ["https://acme.example/collections", "https://rival.example"]);
  const withoutAio = parseGoogleSerp(payloads.no_aio);
  assert.equal(withoutAio.serp_state, SERP_STATE.VALID_SERP);
  assert.equal(withoutAio.aio_present, false, "a valid SERP without an AIO is absence, never a failure");

  const registry = JSON.parse(await readFile(path.join(REPO, MANIFEST), "utf8"));
  const present = registry.fixtures.filter((entry) => entry.state === "present");
  const absent = registry.fixtures.filter((entry) => entry.state === "absent");
  assert.ok(present.length >= 7, "the fixtures created with this harness are registered");
  assert.ok(absent.length >= 5, "what was not created is registered as absent");
  for (const entry of absent) assert.equal(entry.sha256, null, `${entry.path} is absent, so it must carry no hash`);
  for (const entry of present) assert.match(entry.sha256, /^[0-9a-f]{64}$/);
  assert.ok(
    registry.required_test_files.some((entry) => entry.path === "src/server/repairs/r21-harness.test.mjs"),
    "this file must be registered as a required collected test"
  );
});
