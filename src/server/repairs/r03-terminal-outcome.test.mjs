/**
 * R03 — make terminal scan outcomes reflect collection quality (finding A07).
 *
 * WHAT THIS FILE PROVES, AND HOW.
 * Every case below drives the REAL `deriveScanOutcome` / `terminalOutcomeFromRecord`
 * in `src/shared/scanOutcome.js`, and R03-18 additionally drives the real report
 * adapter (`enrichScanForClient`) so "one vocabulary on every surface" is
 * observed rather than asserted about a copy. Nothing reaches a network, a
 * provider or a database: the rows are plain objects and the persistence is the
 * in-memory `supabase: null` path the rest of the suite runs on.
 *
 * A07, restated: a scan whose every question/engine pair failed finalized as
 * `complete`. The corrected behaviour is the terminal rule in `deriveScanOutcome`
 * — `valid === 0` ⇒ `failed`, never `complete` — and the equation
 * `planned = answered + valid_no_aio + failed + not_attempted`.
 *
 * FIVE CASES ARE BLOCKED, not skipped for convenience: R03-09/R03-10 need a
 * real PostgreSQL (transactions, concurrent commits), and R03-14/R03-15/R03-16
 * need a browser process. They are registered with an explicit reason so a green
 * run cannot be read as "all 18 passed".
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  SCAN_OUTCOME_VERSION,
  COLLECTION_OUTCOMES,
  DISPOSITIONS,
  OUTCOME_REASONS,
  BLOCK_REASONS,
  AIO_TRIGGER_REASONS,
  buildScorePlan,
  buildWorkMatrix,
  classifyObservation,
  deriveScanOutcome,
  legacyTerminalOutcome,
  terminalOutcomeFromRecord,
} from "../../shared/scanOutcome.js";
import { runProbingPhase } from "../workers/scanWorker.js";
import { scanCompletionNotice } from "../../shared/scanCompletion.js";
import { normalizeResult } from "../../shared/api.js";

test("R03-14: completed execution retains collection quality through normalization and completion notices", () => {
  for (const [outcome, tone] of [["complete", "success"], ["partial", "warn"], ["failed", "error"], ["blocked", "error"], ["legacy", "info"]]) {
    const terminal = { ...legacyTerminalOutcome(), outcome };
    const normalized = normalizeResult({ brand: "Acme", results: [], summary_stats: { terminal_outcome: terminal } }, "Acme", "https://acme.example");
    assert.equal(normalized.terminal_outcome.outcome, outcome);
    assert.equal(scanCompletionNotice(normalized).tone, tone);
    assert.equal(scanCompletionNotice(normalizeResult(normalized)).tone, tone);
    assert.equal(scanCompletionNotice({ terminal_outcome: terminal }).tone, tone);
  }
  assert.equal(scanCompletionNotice({}).tone, "info");
});

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const STATUS_ROUTE = path.join(REPO, "src/app/api/scan/[job_id]/status/route.js");
const REPORT_LIB = path.join(REPO, "src/app/api/scans/_lib/scanRow.js");
const HISTORY_ROUTE = path.join(REPO, "src/app/api/scans/[brand]/route.js");

// ---------------------------------------------------------------------------
// Fixtures — plain persisted-observation shapes
// ---------------------------------------------------------------------------

function prompts(n) {
  return Array.from({ length: n }, (_, i) => ({ text: `question ${i}` }));
}

function answeredRow(engine, query, { aio = false } = {}) {
  return {
    engine,
    query,
    answered: true,
    raw: { engine, prompt: query, answer_present: true, aio_present: aio },
  };
}

/** A valid SERP the assistant answered WITHOUT an AI overview — still a measurement. */
function noAioRow(engine, query) {
  return {
    engine,
    query,
    answered: false,
    raw: { engine, prompt: query, answer_present: false, aio_present: false },
  };
}

/** A persisted failure: the row exists, it carries an error, and it is not a non-mention. */
function failedRow(engine, query, error = "HTTP 401 credential rejection") {
  return {
    engine,
    query,
    answered: false,
    raw: { engine, prompt: query, error },
  };
}

/** The equation every closed scan must satisfy. */
function assertEquation(outcome) {
  const c = outcome.counts;
  assert.equal(outcome.equation.holds, true, `equation must hold: ${outcome.equation.expression}`);
  assert.equal(
    c.planned,
    c.answered + c.valid_no_aio + c.failed + c.not_attempted,
    `planned must equal the four exclusive dispositions (${outcome.equation.expression})`
  );
}

// ---------------------------------------------------------------------------
// R03-01 … R03-08 — the classification cases
// ---------------------------------------------------------------------------

test("R03-01 — thirty answered observations classify complete with 30 planned/valid/answered", () => {
  const plan = buildScorePlan({ prompts: prompts(30), engines: ["aio"] });
  const rows = plan.map((p) => answeredRow(p.engine, p.query, { aio: true }));
  const outcome = deriveScanOutcome({ plan, rows });

  assert.equal(outcome.outcome, COLLECTION_OUTCOMES.COMPLETE);
  assert.equal(outcome.outcome_reason, OUTCOME_REASONS.FULL_VALID_COLLECTION);
  assert.equal(outcome.counts.planned, 30);
  assert.equal(outcome.counts.valid, 30);
  assert.equal(outcome.counts.answered, 30);
  assert.equal(outcome.counts.failed, 0);
  assert.equal(outcome.counts.not_attempted, 0);
  assert.equal(outcome.metrics.collection_completion_pct, 100);
  assertEquation(outcome);

  // Production alignment: sourcing lowercases/trims `unbranded_texts`, but a
  // persisted row carries the query text as the adapter returned it. A raw key
  // comparison would read this healthy scan as not-attempted; it must not.
  const mixedPlan = buildScorePlan({ prompts: [{ text: "Buyer Question One" }], engines: ["aio"] });
  const mixed = deriveScanOutcome({ plan: mixedPlan, rows: [answeredRow("aio", "buyer question one", { aio: true })] });
  assert.equal(mixed.outcome, COLLECTION_OUTCOMES.COMPLETE);
  assert.equal(mixed.counts.valid, 1, "plan text and persisted row differing only by case are one observation");
  assert.equal(mixed.counts.not_attempted, 0);
});

test("R03-02 — thirty valid no-AIO SERPs are complete collection with a zero trigger rate", () => {
  const plan = buildScorePlan({ prompts: prompts(30), engines: ["aio"] });
  const rows = plan.map((p) => noAioRow(p.engine, p.query));
  const outcome = deriveScanOutcome({ plan, rows });

  assert.equal(outcome.outcome, COLLECTION_OUTCOMES.COMPLETE, "no-AIO is valid collection, not failure (A01)");
  assert.equal(outcome.counts.valid_no_aio, 30);
  assert.equal(outcome.counts.valid, 30);
  assert.equal(outcome.metrics.aio_trigger.valid_serps, 30, "the trigger denominator is the Google surface's valid SERPs");
  assert.equal(outcome.metrics.aio_trigger.aio_present, 0);
  assert.equal(outcome.metrics.aio_trigger.trigger_rate_pct, 0, "a measured zero trigger, not unknown");
  assert.equal(outcome.metrics.aio_trigger.available, true, "a measured zero is AVAILABLE — it is not the same fact as unknown");
  assert.equal(outcome.metrics.aio_trigger.reason, null, "a measured zero needs no unavailability reason");
  assert.equal(
    outcome.metrics.aio_trigger.conditional_headline,
    null,
    "there is no conditional AIO headline to qualify at a zero trigger rate"
  );
  assertEquation(outcome);
});

test("R03-03 — 120 failed pairs and no answer can never be complete", () => {
  const plan = buildScorePlan({ prompts: prompts(120), engines: ["aio"] });
  const rows = plan.map((p) => failedRow(p.engine, p.query));
  const outcome = deriveScanOutcome({ plan, rows });

  assert.equal(outcome.outcome, COLLECTION_OUTCOMES.FAILED, "A07 — all-error is failed, not complete");
  assert.notEqual(outcome.outcome, COLLECTION_OUTCOMES.COMPLETE);
  assert.equal(outcome.outcome_reason, OUTCOME_REASONS.NO_USABLE_COLLECTION);
  assert.equal(outcome.counts.valid, 0, "usable count is zero");
  assert.equal(outcome.counts.answered, 0);
  assert.equal(outcome.counts.failed, 120);
  assert.equal(outcome.metrics.collection_completion_pct, 0, "0% collected is honest here — there WAS a denominator");
  assertEquation(outcome);
});

test("R03-04 — 119 valid plus one exhausted failure is partial, with the gap still visible", () => {
  const plan = buildScorePlan({ prompts: prompts(120), engines: ["aio"] });
  const rows = plan.map((p, i) =>
    i === 0 ? failedRow(p.engine, p.query, "deadline exceeded") : answeredRow(p.engine, p.query, { aio: true })
  );
  const outcome = deriveScanOutcome({ plan, rows });

  assert.equal(outcome.outcome, COLLECTION_OUTCOMES.PARTIAL);
  assert.equal(outcome.outcome_reason, OUTCOME_REASONS.MIXED_USABLE_FAILING);
  assert.equal(outcome.counts.planned, 120);
  assert.equal(outcome.counts.valid, 119);
  assert.equal(outcome.counts.failed, 1);
  assert.equal(outcome.counts.not_attempted, 0);
  assert.equal(outcome.metrics.collection_completion_pct, 99.2, "the incomplete coverage is not rounded up to 100");
  assertEquation(outcome);
});

test("R03-05 — a permanent failure before the rest of the dispatch is blocked with not-attempted work kept", () => {
  const plan = buildScorePlan({ prompts: prompts(120), engines: ["aio"] });
  const rows = plan.slice(0, 30).map((p) => answeredRow(p.engine, p.query, { aio: true }));
  const outcome = deriveScanOutcome({
    plan,
    rows,
    blocked: { reason: BLOCK_REASONS.PERMANENT_PROVIDER_FAILURE, detail: "shared gateway rejected the key" },
  });

  assert.equal(outcome.outcome, COLLECTION_OUTCOMES.BLOCKED);
  assert.equal(outcome.outcome_reason, OUTCOME_REASONS.BLOCKED_BEFORE_COMPLETION);
  assert.equal(outcome.blocked.reason, BLOCK_REASONS.PERMANENT_PROVIDER_FAILURE);
  assert.equal(outcome.counts.not_attempted, 90, "the 90 never-dispatched pairs are explicit, not erased");
  assert.equal(outcome.counts.planned, 120, "planned work is never shrunk to flatter a stop");
  assertEquation(outcome);
});

test("R03-06 — 30 unbranded plus four diagnostics across four engines keeps 120 scoring and 16 diagnostics distinct", () => {
  const engines = ["aio", "chatgpt", "gemini", "perplexity"];
  const matrix = buildWorkMatrix({
    prompts: prompts(30),
    engines,
    diagnosticBrands: ["Acme", "Acme pricing", "Acme vs Rival", "is Acme good"],
  });

  assert.equal(matrix.scoring.length, 120, "30 unbranded x 4 engines");
  assert.equal(matrix.diagnostics.length, 16, "4 branded diagnostics x 4 engines");

  const outcome = deriveScanOutcome({ plan: matrix.scoring, rows: [], diagnostics: matrix.diagnostics });
  assert.equal(outcome.counts.planned, 120, "diagnostics do not inflate the scoring denominator");
  assert.equal(outcome.counts.diagnostics, 16, "diagnostics are counted, but separately");
  assert.notEqual(outcome.counts.planned, matrix.scoring.length + matrix.diagnostics.length, "the two pools are not summed");

  // FINDING P2 — the AIO trigger population is the Google surface ONLY. Every
  // engine answers here (Google with an AI Overview, the three text models
  // without), so a scan-wide denominator would read 30/120 and dilute a real
  // 100% Google trigger; collection completion must stay whole-plan.
  const everyEngineValid = matrix.scoring.map((p) =>
    p.engine === "aio" ? answeredRow(p.engine, p.query, { aio: true }) : answeredRow(p.engine, p.query)
  );
  const mixed = deriveScanOutcome({ plan: matrix.scoring, rows: everyEngineValid, engineNames: engines });
  assert.equal(mixed.counts.valid, 120, "collection completion is still measured over the whole four-engine plan");
  assert.equal(mixed.metrics.collection_completion_pct, 100);
  assert.equal(mixed.metrics.aio_trigger.valid_serps, 30, "only the 30 Google SERPs are the trigger denominator, not all 120 valid rows");
  assert.equal(mixed.metrics.aio_trigger.aio_present, 30);
  assert.equal(mixed.metrics.aio_trigger.trigger_rate_pct, 100, "30/30 Google AIO -> 100%, not diluted by the text engines");
  assert.equal(mixed.metrics.aio_trigger.available, true);
  assert.equal(mixed.metrics.aio_trigger.reason, null);
  assert.equal(mixed.metrics.aio_trigger.surfaces.aio.valid_serps, 30, "the per-surface breakdown names the Google surface explicitly");
  assert.equal(mixed.metrics.aio_trigger.surfaces.aio.trigger_rate_pct, 100);
  assertEquation(mixed);

  // The reviewer's exact reproduction: two prompts x four engines, every call
  // valid, both Google SERPs carrying AIO. The old code published valid_serps:8,
  // aio_present:2, trigger_rate_pct:25 for a Google trigger that is really 2/2.
  const reproPlan = buildScorePlan({ prompts: prompts(2), engines });
  const reproRows = reproPlan.map((p) =>
    p.engine === "aio" ? answeredRow(p.engine, p.query, { aio: true }) : answeredRow(p.engine, p.query)
  );
  const repro = deriveScanOutcome({ plan: reproPlan, rows: reproRows, engineNames: engines });
  assert.equal(repro.counts.valid, 8, "the whole-plan population really is 8 valid observations");
  assert.equal(repro.metrics.aio_trigger.valid_serps, 2, "…but the Google trigger denominator is 2");
  assert.equal(repro.metrics.aio_trigger.aio_present, 2);
  assert.equal(repro.metrics.aio_trigger.trigger_rate_pct, 100, "2/2 = 100%, not the old 25%");
  assert.notEqual(repro.metrics.aio_trigger.trigger_rate_pct, 25);

  // A text-model-only plan has NO Google surface at all: the trigger is
  // UNAVAILABLE with a reason, never a measured zero.
  const textPlan = buildScorePlan({ prompts: prompts(30), engines: ["chatgpt", "perplexity", "gemini"] });
  const textOnly = deriveScanOutcome({ plan: textPlan, rows: textPlan.map((p) => answeredRow(p.engine, p.query)) });
  assert.equal(textOnly.counts.valid, 90, "the text engines collected validly");
  assert.equal(textOnly.metrics.aio_trigger.valid_serps, 0);
  assert.equal(textOnly.metrics.aio_trigger.trigger_rate_pct, null, "no Google surface -> null, never 0");
  assert.notEqual(textOnly.metrics.aio_trigger.trigger_rate_pct, 0);
  assert.equal(textOnly.metrics.aio_trigger.available, false, "unavailable is distinct from a measured zero");
  assert.equal(textOnly.metrics.aio_trigger.reason, AIO_TRIGGER_REASONS.SURFACE_NOT_PLANNED);
  assert.deepEqual(textOnly.metrics.aio_trigger.surfaces, {}, "no Google surface means no per-surface entry");
});

test("R03-07 — a duplicate observation counts once in planned/valid while attempts may rise", () => {
  const plan = buildScorePlan({ prompts: prompts(30), engines: ["aio"] });
  const once = plan.map((p) => answeredRow(p.engine, p.query, { aio: true }));
  const withDuplicate = [...once, once[0]]; // the same pair delivered twice
  const outcome = deriveScanOutcome({ plan, rows: withDuplicate });

  assert.equal(outcome.counts.planned, 30);
  assert.equal(outcome.counts.valid, 30, "the repeated pair is one logical observation");
  assert.equal(outcome.counts.scoring_attempts, 31, "…but the attempt is counted");
  assert.equal(outcome.outcome, COLLECTION_OUTCOMES.COMPLETE);
  assertEquation(outcome);
});

test("R03-08 — zero planned prompts is an invalid/no-work state, with no percentage and no divide-by-zero", () => {
  const outcome = deriveScanOutcome({ plan: [], rows: [] });

  assert.equal(outcome.outcome, COLLECTION_OUTCOMES.INVALID);
  assert.equal(outcome.outcome_reason, OUTCOME_REASONS.ZERO_PLANNED_WORK);
  assert.equal(outcome.counts.planned, 0);
  assert.equal(
    outcome.metrics.collection_completion_pct,
    null,
    "no denominator means no percentage — never 0%, never 100%"
  );
  assert.notEqual(outcome.outcome, COLLECTION_OUTCOMES.COMPLETE);
  assertEquation(outcome);
});

// ---------------------------------------------------------------------------
// R03-11 … R03-13, R03-17 — integration-shaped cases on the shared derivation
// ---------------------------------------------------------------------------

test("R03-11 — a frozen engine that loses its configuration is blocked/not-attempted, with no substitute surface", () => {
  const frozen = ["aio", "chatgpt", "gemini", "perplexity"];
  const plan = buildScorePlan({ prompts: prompts(10), engines: frozen });
  // gemini produced ZERO rows: its configuration vanished mid-scan. The other
  // three answered everything they were asked.
  const rows = plan
    .filter((p) => p.engine !== "gemini")
    .map((p) => answeredRow(p.engine, p.query, { aio: p.engine === "aio" }));

  const outcome = deriveScanOutcome({
    plan,
    rows,
    blocked: { reason: BLOCK_REASONS.ENGINE_NOT_REGISTERED, detail: "gemini: credential removed" },
    engineNames: frozen,
  });

  assert.equal(outcome.outcome, COLLECTION_OUTCOMES.BLOCKED);
  const gemini = outcome.engines.find((e) => e.name === "gemini");
  assert.equal(gemini.state, DISPOSITIONS.NOT_ATTEMPTED, "the frozen engine is retained as not-attempted");
  assert.equal(gemini.not_attempted, 10);
  assert.equal(gemini.valid, 0);
  assert.deepEqual(
    outcome.engines.map((e) => e.name),
    frozen,
    "no silent substitute surface: the report names only the engines this scan was frozen with"
  );
  assert.ok(
    !outcome.engines.some((e) => !frozen.includes(e.name)),
    "an engine that was never part of the scan must not appear"
  );
});

test("R03-11 — the worker never dispatches a newly enabled surface when every frozen surface disappears", async () => {
  let dispatches = 0;
  const checkpoint = {
    brand: "Example",
    url: "https://example.com",
    competitors: [],
    queries: [{ text: "question 0" }],
    engines: ["gemini"],
  };
  const result = await runProbingPhase("frozen-surface-job", checkpoint, {
    resolveEnabledEngines: () => [{
      name: "chatgpt",
      concurrency: 1,
      probe: async () => { dispatches += 1; throw new Error("unexpected substituted dispatch"); },
    }],
    getCompletedPairsForJob: async () => new Set(),
    updateScanJob: async () => {},
  });
  assert.equal(dispatches, 0);
  assert.equal(result.budgetHit, false);
  assert.equal(result.checkpoint.engine_set_change.state, "shrank");
  assert.equal(result.checkpoint.blocked.reason, BLOCK_REASONS.ENGINE_NOT_REGISTERED);
  assert.deepEqual(result.checkpoint.engines, ["gemini"]);
});

test("R03-12 — one engine healthy and three failing yields partial, keeping all four engines and their outcomes", () => {
  const engines = ["aio", "chatgpt", "gemini", "perplexity"];
  const plan = buildScorePlan({ prompts: prompts(10), engines });
  const rows = plan.map((p) =>
    p.engine === "aio" ? answeredRow(p.engine, p.query, { aio: true }) : failedRow(p.engine, p.query)
  );

  const outcome = deriveScanOutcome({ plan, rows, engineNames: engines });

  assert.equal(outcome.outcome, COLLECTION_OUTCOMES.PARTIAL);
  assert.equal(outcome.engines.length, 4, "every engine in the frozen set is retained");
  const byName = Object.fromEntries(outcome.engines.map((e) => [e.name, e]));
  assert.equal(byName.aio.state, COLLECTION_OUTCOMES.COMPLETE);
  assert.equal(byName.aio.valid, 10);
  for (const name of ["chatgpt", "gemini", "perplexity"]) {
    assert.equal(byName[name].state, COLLECTION_OUTCOMES.FAILED, `${name} failed in full`);
    assert.equal(byName[name].valid, 0);
    assert.equal(byName[name].failed, 10);
  }
  assertEquation(outcome);
});

test("R03-13 — a legacy record lacking the matrix reads as legacy/unknown, with no fabricated 100% collection", () => {
  // A pre-vocabulary `scans` row: metrics exist but no work matrix does.
  const legacyScan = {
    id: "11111111-1111-4111-8111-111111111111",
    brand: "Acme",
    url: "acme.com",
    raw_results: { summary_stats: { visibility_pct: 43, mention_rate_pct: 20 } },
  };
  const outcome = terminalOutcomeFromRecord(legacyScan);

  assert.equal(outcome.outcome, COLLECTION_OUTCOMES.LEGACY);
  assert.equal(outcome.outcome_reason, OUTCOME_REASONS.LEGACY_MATRIX_MISSING);
  assert.equal(outcome.counts.planned, null, "planned is UNKNOWN, not 30");
  assert.equal(outcome.counts.valid, null);
  assert.equal(
    outcome.metrics.collection_completion_pct,
    null,
    "no modern completion percentage is invented for a record whose quality cannot be reconstructed"
  );
  assert.notEqual(outcome.metrics.collection_completion_pct, 100);
  // And the derivation itself, on a record with no rows and no plan, says the same.
  const emptyLegacy = legacyTerminalOutcome();
  assert.equal(emptyLegacy.outcome, COLLECTION_OUTCOMES.LEGACY);
  assert.equal(emptyLegacy.counts.valid, null);
});

test("R03-17 — a spend cap reached between batches makes the skipped work not-attempted, with no measured non-mentions", () => {
  const plan = buildScorePlan({ prompts: prompts(120), engines: ["aio"] });
  const rows = plan.slice(0, 60).map((p) => answeredRow(p.engine, p.query, { aio: true }));
  const outcome = deriveScanOutcome({
    plan,
    rows,
    blocked: { reason: BLOCK_REASONS.SPEND_CAP_PER_SCAN, detail: "cost cap reached" },
  });

  assert.equal(outcome.outcome, COLLECTION_OUTCOMES.BLOCKED);
  assert.equal(outcome.blocked.reason, BLOCK_REASONS.SPEND_CAP_PER_SCAN);
  assert.equal(outcome.counts.not_attempted, 60, "the capped remainder is not-attempted, not a measured result");
  assert.equal(outcome.counts.failed, 0, "a pair we never called is not a failure");
  assert.equal(
    outcome.metrics.mention_measured,
    false,
    "no mentions were measured for the skipped pairs — a cap is never a measured non-mention"
  );
  assertEquation(outcome);
});

// ---------------------------------------------------------------------------
// R03-18 — one versioned vocabulary on the status payload and the report
// ---------------------------------------------------------------------------

test("R03-18 — the status endpoint and the final report for one scan return one versioned vocabulary and identical counters", async () => {
  const engines = ["aio", "chatgpt"];
  const plan = buildScorePlan({ prompts: prompts(5), engines });
  const rows = plan.map((p) =>
    p.engine === "aio" ? answeredRow(p.engine, p.query, { aio: true }) : failedRow(p.engine, p.query)
  );
  const derived = deriveScanOutcome({ plan, rows, engineNames: engines });

  // The one persisted record the finalizer writes: the SAME object on the scan
  // row's summary_stats and on the job's run_record. The report side below is
  // read from a JSON round trip of it, because that is what the scans row
  // actually is by the time an adapter sees it — PostgREST returns decoded JSON,
  // not the object the finalizer held. Handing both readers the same reference
  // would make the comparison below true by construction, and it would stop
  // catching the drift it exists to catch (a dropped key survives a shared
  // reference and does not survive a round trip).
  const summaryStats = { terminal_outcome: derived };
  const job = { id: "job-1", status: "complete", run_record: { summary_stats: summaryStats } };
  const scanRow = {
    id: "scan-1",
    brand: "Acme",
    raw_results: JSON.parse(JSON.stringify({ summary_stats: summaryStats })),
  };

  // Status endpoint reads job.run_record; the report/history adapters read the
  // scans row. Both go through the same reader.
  const statusSide = terminalOutcomeFromRecord(job.run_record);
  const reportSide = terminalOutcomeFromRecord(scanRow);

  assert.equal(statusSide.version, SCAN_OUTCOME_VERSION);
  assert.equal(reportSide.version, SCAN_OUTCOME_VERSION, "both surfaces carry the same version");
  assert.deepEqual(reportSide, statusSide, "one vocabulary, identical counters — diagnostics included");
  assert.equal(statusSide.outcome, COLLECTION_OUTCOMES.PARTIAL);
  assert.deepEqual(statusSide.counts, reportSide.counts);

  // FINDING P2 persisted/API agreement: the Google-only AIO trigger (5 valid aio
  // SERPs, 5 with AIO; the 5 chatgpt failures are NOT in this denominator) must
  // survive the persistence round trip identically on both surfaces.
  assert.equal(reportSide.metrics.aio_trigger.valid_serps, 5, "the trigger denominator is the Google surface, and it persists");
  assert.equal(reportSide.metrics.aio_trigger.aio_present, 5);
  assert.equal(reportSide.metrics.aio_trigger.trigger_rate_pct, 100);
  assert.equal(reportSide.metrics.aio_trigger.available, true);
  assert.deepEqual(reportSide.metrics.aio_trigger, statusSide.metrics.aio_trigger);
  assert.equal(reportSide.metrics.aio_trigger.surfaces.aio.valid_serps, 5, "the per-surface map survives the wire projection too");

  // And the code actually shares the reader rather than reimplementing it: a
  // re-derived copy is exactly how the two surfaces drift apart over time.
  for (const [label, file] of [
    ["status route", STATUS_ROUTE],
    ["report adapter", REPORT_LIB],
    ["history route", HISTORY_ROUTE],
  ]) {
    const source = await readFile(file, "utf8");
    assert.match(
      source,
      /from\s+["']@\/shared\/scanOutcome["']/,
      `${label} must import the shared terminal-outcome vocabulary`
    );
    assert.match(
      source,
      /terminalOutcomeFromRecord\(/,
      `${label} must read the outcome through terminalOutcomeFromRecord, not rebuild it`
    );
  }
});

// ---------------------------------------------------------------------------
// The classification primitive, on its own
// ---------------------------------------------------------------------------

test("R03 — classifyObservation: no error + no answer is valid_no_aio; an error is failed; never a non-mention", () => {
  assert.equal(classifyObservation(noAioRow("aio", "q")).disposition, DISPOSITIONS.VALID_NO_AIO);
  assert.equal(classifyObservation(answeredRow("aio", "q")).disposition, DISPOSITIONS.ANSWERED);
  const failed = classifyObservation(failedRow("aio", "q"));
  assert.equal(failed.disposition, DISPOSITIONS.FAILED);
  assert.equal(failed.reason, "credential_rejection");
  assert.equal(classifyObservation(null).disposition, DISPOSITIONS.FAILED, "an unreadable row is failed, not dropped");
});

// ---------------------------------------------------------------------------
// BLOCKED — database and browser cases, with their reasons
// ---------------------------------------------------------------------------

test("R03-09 — two finalizers racing the same completed work commit one report", { skip: "BLOCKED: requires a real PostgreSQL with concurrent transactions (D); no database in this pass." }, () => {});

test("R03-10 — a crash during citation/rollup materialization resumes finalize without duplicates", { skip: "BLOCKED: requires a real PostgreSQL committed-storage reconstruction (D); no database in this pass." }, () => {});

test("R03-14 — an all-error report shows failure and retry conditions, with no success celebration", { skip: "BLOCKED: requires a browser (B) to observe the completion screen; no browser automation in this pass." }, () => {});

test("R03-15 — a partial report shows every planned question and export totals agree", { skip: "BLOCKED: requires a browser (B) to compare screen and download; no browser automation in this pass." }, () => {});

test("R03-16 — a durable terminal outcome loads after the polling tab closes", { skip: "BLOCKED: requires a browser (B) to close/reopen the client process; no browser automation in this pass." }, () => {});
