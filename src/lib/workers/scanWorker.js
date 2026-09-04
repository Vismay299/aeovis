import { DEFAULT_UNBRANDED_TARGET } from "../scoring/promptSetSize.js";
import crypto from "crypto";
import {
  supabase,
  insertScan,
  updateScanJob,
  getScanJob,
  createScanJob,
  hasActiveScanForBrand,
  isJobAlive,
  claimJobStatus,
  getScansByDomain,
} from "../db.js";
import {
  upsertPromptResults,
  insertCitations,
  deleteCitationsForJob,
  insertResultBrands,
  deleteResultBrandsForJob,
  getCompletedPairsForJob,
  getPromptResultsForJob,
  stampScanIdForJob,
  getResultBrandsForScan,
  upsertBrandMetricsDaily,
  listDueSchedules,
  upsertScanSchedule,
} from "../db/analytics.js";
import { generateUnbrandedPrompts } from "../scoring/promptGen.js";
import { extractCompetitors } from "../scoring/competitorExtract.js";
import { resolveCompetitorRoster } from "../scoring/rosterContinuity.js";
import {
  classifyPromptSource,
  PromptSourcingUnavailableError,
} from "../scoring/promptSource.js";
import { isLlmUnavailable } from "../llmErrors.js";
import { summarizeAioResults, aggregateAioTopDomains } from "../scoring/aioPipeline.js";
import {
  summarizeEngineResults,
  resolveEnabledEngines,
  computeHeadline,
  summarizeEngineSlice,
  domainMatches,
  buildTrackedBrandRoster,
} from "../scoring/enginePipeline.js";
import { judgeBrandsSymmetric } from "../scoring/judge.js";
import { toDateOnly, unionPromptCounts, buildMetricsRows } from "../analytics/rollup.js";
import { getPromptsForBrand, upsertPrompts } from "../db/prompts.js";
import { buildBrandedQueries, isBrandedQuery } from "../scoring/aioQueryClassify.js";
import { getBrandAliases } from "../scoring/aliases.js";
import { resolveBrandKey } from "../scoring/brandKey.js";
import { extractBrandDomain } from "../scoring/citations.js";
import { enrichCitations } from "../analytics/citationEnrich.js";
import {
  openScanRun,
  heartbeatScanRun,
  closeScanRun,
  describeRun,
  RUN_OUTCOMES,
  RUNNERS,
} from "../scanRuns.js";

const MAX_SOURCING_ATTEMPTS = 3;
// R2.10.1 — shared with the landing page so the advertised prompt count and
// the count a scan actually tracks cannot drift apart.
// (imported above from ../scoring/promptSetSize.js)

/**
 * Soft per-chunk time budget (P0.2). Governs when a chunk stops STARTING new
 * probe batches and instead checkpoints + self-continues, leaving headroom
 * under the routes' `maxDuration = 300` for the last batch to finish, the
 * checkpoint write, and (on the probing path) the fire-and-forget
 * self-continue fetch.
 *
 * This is deliberately NOT the thing that keeps the job "alive" — heartbeat
 * cadence does that (see runProbingPhase: `updateScanJob` is called after
 * EVERY batch, stamping `heartbeat_at`). A single batch is bounded by the
 * slowest probe in it: Bright Data (aio) probes carry a 60s internal timeout;
 * ChatGPT/Perplexity probes carry a 45s timeout with up to 2 retries + backoff
 * (rare worst case ~140s for one retry-heavy batch). Either way, one batch
 * finishes well inside HEARTBEAT_STALE_MS (180s), so the gap between
 * heartbeats — which is what actually determines staleness — never
 * approaches the 180s ceiling even in a bad-network worst case. 150s here
 * just bounds how many batches accumulate before a chunk voluntarily yields.
 */
export const CHUNK_TIME_BUDGET_MS = 150_000;

// ---------------------------------------------------------------------------
// The scan_runs ledger, from the web chunk's side (R3.2.1)
// ---------------------------------------------------------------------------
//
// One row per CHUNK EXECUTION -- one call of runScanChunk -- opened before the
// work, heartbeated while it is in flight, closed with an outcome, a reason and
// counters that were MEASURED. worker/src/lib/runLedger.js + worker/src/index.js
// are the fleet's copy of this shape (R1.2.3) and this deliberately mirrors them.
//
// WHAT THIS REPLACES. Every early return below already computes a structured
// reason -- "sourcing_claimed_elsewhere", "checkpointed", "noop", "read_failed"
// -- and then throws it away with the stack frame. Afterwards a chunk that ran
// and did nothing, a chunk that never ran, a chunk that died halfway and a chunk
// that declined for a good reason all leave the same evidence: scan_jobs.heartbeat_at
// moved, or it did not. Migration 011's header is the long form of this argument.

/**
 * The phase a chunk ENTERED, written to scan_runs.phase.
 *
 * Migration 011 pre-declared the chunk vocabulary as
 * 'sourcing' | 'probing' | 'scoring' | 'finalize'. This file runs the FINALIZE
 * phase for a job whose STATUS is 'scoring', so those two names are one thing:
 * the column carries 'finalize' (the function that ran) and the job status at
 * entry is kept in `detail.entry_status`, so neither name is lost.
 *
 * 'entry' is the fifth, and it is new here. It is what a chunk was doing when it
 * never reached a work phase at all: the job could not be read, did not exist,
 * or was already finished. Those executions HAPPENED and so they get a row;
 * labelling them 'sourcing' would be a claim about work that never started. 011
 * left `phase` an open vocabulary (unlike `outcome`) precisely so R3.2 could
 * add a name like this without an ALTER on a live table.
 *
 * ONE ROW, ONE PHASE, FOR A CHUNK THAT MAY TRAVERSE THREE. The task is one row
 * per chunk execution, not one per phase, so `phase` is where the chunk STARTED
 * and `detail.phases_run` lists every phase it actually entered. Splitting one
 * chunk into three rows would make a single execution look like three, which is
 * the double-count this ledger must not introduce.
 */
export const CHUNK_PHASES = Object.freeze({
  ENTRY: "entry",
  SOURCING: "sourcing",
  PROBING: "probing",
  FINALIZE: "finalize",
});

/**
 * How often an in-flight chunk says its run is still alive.
 *
 * A chunk is up to CHUNK_TIME_BUDGET_MS (150s) of wall clock and finalize can
 * add more on top. Without this, heartbeat_at would never move off started_at,
 * every long chunk would read as stale, and R3.3.2's sweep would reap runs that
 * are working perfectly. Same cadence and same reasoning as the fleet's
 * FALLBACK_HEARTBEAT_MS.
 */
export const CHUNK_RUN_HEARTBEAT_MS = 30_000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * scan_runs.scan_job_id is a uuid column, and /api/scan/worker takes `job_id`
 * straight off the query string. A malformed id is recorded verbatim in
 * `detail.job_id` instead of being cast: the row still exists and still says
 * which id it was asked about, rather than the whole execution going
 * unrecorded because someone typed a bad one.
 */
function asUuid(value) {
  return typeof value === "string" && UUID_RE.test(value) ? value : null;
}

/**
 * What a chunk MEASURED, as opposed to what it assumed.
 *
 * Every counter starts null -- NOT MEASURED -- and only a phase that genuinely
 * counts arms it to 0. That is what migration 011's nullable counters are for:
 * a chunk that only finalized never attempted a probe, and writing
 * `probes_attempted = 0` there would claim it looked and found none. Standing
 * rule 1, and standing rule 5's "never `?? 0` on a metric" applied before the
 * write rather than after it.
 */
export function createChunkTally() {
  // `skips` is null for the same reason the counters are: NOT MEASURED. A phase
  // that watches for discarded skips arms it to [], and only then does an empty
  // list mean "it looked and there were none". See armSkips/recordSkip.
  return { probesAttempted: null, probesSucceeded: null, errorsRecovered: null, phases: [], skips: null };
}

/**
 * The skip reasons a chunk COMPUTES and used to discard (R3.2.2).
 *
 * Each of these is a place where the chunk decided not to do something it could
 * have done -- an engine it will not probe, a probe that came back empty, a row
 * it could not judge -- and then continued as though nothing had happened. The
 * outcome of the chunk was unaffected, so the ledger recorded a clean
 * 'succeeded' over work that had quietly shrunk. Standing rule 1: a skip is not
 * a success.
 *
 * These are NOT outcomes and they do NOT get rows of their own. R3.2.1's accept
 * is one scan_runs row per chunk EXECUTION, and a verifier proved that
 * `sum(probes_attempted)` counts each probe exactly once across those rows; one
 * row per skip would break both. They ride on the single chunk row, in
 * `detail.skips`, aggregated by reason with an exact count.
 */
export const CHUNK_SKIP_REASONS = Object.freeze({
  /** A checkpoint-frozen engine that no longer resolves against the live registry. */
  ENGINE_NOT_REGISTERED: "engine_not_registered",
  /** NONE of the frozen engines resolve, so the chunk probed today's set instead. */
  ENGINE_SET_FALLBACK: "engine_set_fallback",
  /** A probe returned carrying `error`: the row is still written, the answer is not real. */
  PROBE_ERROR: "probe_error",
  /** The prompt set was used for this scan but could not be persisted for the next one. */
  PROMPT_PERSIST_FAILED: "prompt_persist_failed",
  /** One row kept its probe-time verdict because the full-roster re-judge threw. */
  REJUDGE_FAILED: "rejudge_failed",
  /** One row contributed no result_brands because its roster judging threw. */
  ROSTER_JUDGE_FAILED: "roster_judge_failed",
  /** Citations were inserted unclassified because enrichment threw. */
  CITATION_ENRICH_FAILED: "citation_enrich_failed",
});

/**
 * How many distinct subjects one skip reason keeps. The COUNT is always exact;
 * only the sample is capped, and an entry that dropped subjects says so with
 * `sample_truncated: true` rather than looking like a complete list.
 */
export const SKIP_SAMPLE_MAX = 5;
const SKIP_SUBJECT_MAX_CHARS = 200;

/** "This phase watches for skips" -- turns NOT MEASURED into a measured zero. */
function armSkips(tally) {
  if (!tally || typeof tally !== "object") return;
  if (!Array.isArray(tally.skips)) tally.skips = [];
}

/**
 * Record one discarded skip against the chunk's single run.
 *
 * Aggregated by reason so a 60-pair scan whose engine died cannot write 60
 * detail entries; `count` stays exact either way. A skip with no reason throws:
 * an unexplained skip is the exact thing this task exists to abolish, and
 * silently accepting one here would reintroduce it one level down.
 */
export function recordSkip(tally, reason, subject = null) {
  if (!String(reason ?? "").trim()) {
    throw new Error(
      "recordSkip: a skip with no reason is the discarded fact R3.2.2 exists to keep — name it"
    );
  }
  if (!tally || typeof tally !== "object") return;
  armSkips(tally);
  let entry = tally.skips.find((s) => s.reason === reason);
  if (!entry) {
    entry = { reason, count: 0, sample: [] };
    tally.skips.push(entry);
  }
  entry.count++;
  if (subject !== null && subject !== undefined) {
    const text = String(subject).slice(0, SKIP_SUBJECT_MAX_CHARS);
    if (entry.sample.length < SKIP_SAMPLE_MAX) entry.sample.push(text);
    else entry.sample_truncated = true;
  }
}

/**
 * The skips a chunk recorded, in the shape `detail.skips` carries.
 *
 * Returns null when nothing armed the list: a chunk that never entered a phase
 * that could skip must not report an empty list, because an empty list reads as
 * "nothing was skipped" and that is a claim it is in no position to make.
 * Exported so the honesty property is testable without a database.
 */
export function summarizeSkips(tally = {}) {
  if (!tally || !Array.isArray(tally.skips)) return { skips: null, skips_total: null };
  return {
    skips: tally.skips.map((s) => ({ ...s, sample: [...s.sample] })),
    skips_total: tally.skips.reduce((n, s) => n + s.count, 0),
  };
}

/** "This phase is counting <key>" -- turns NOT MEASURED into a measured zero. */
function armCount(tally, key) {
  if (!tally || typeof tally !== "object") return;
  if (!Number.isInteger(tally[key])) tally[key] = 0;
}

/** Add to a counter, arming it first: you cannot add to "not measured". */
function bumpCount(tally, key, by = 1) {
  if (!tally || typeof tally !== "object") return;
  armCount(tally, key);
  if (Number.isFinite(by) && by > 0) tally[key] += by;
}

/**
 * The three ledger calls this file uses -- or an explicit, announced refusal.
 *
 * WHY A DISABLED MODE EXISTS, AND WHY IT IS NOT A FAIL-SOFT
 * With no Supabase client there is no `scan_jobs` table either: db.js runs the
 * entire persistence layer out of `global.memoryJobs`. A chunk in that mode is
 * a local-dev or test execution, not a production one, and demanding a ledger
 * row from a database that does not exist would stop local dev and prove
 * nothing. So the ledger stands down -- and SAYS SO, loudly, once per chunk,
 * naming exactly what will go unrecorded. A skip that announces nothing is the
 * failure this ledger exists to remove (standing rule 1).
 *
 * When a client DOES exist, a failed open is not swallowed: openScanRun throws
 * and the throw leaves runScanChunk. There is deliberately no "could not open a
 * run, carry on anyway" path -- a chunk that runs unrecorded is a chunk whose
 * absence from the ledger reads as "it never ran" (standing rule 2).
 *
 * deps.openScanRun / heartbeatScanRun / closeScanRun are test injection, the
 * same shape as every other dep in this file.
 */
function resolveChunkLedger(deps = {}) {
  const injected = deps.openScanRun || deps.heartbeatScanRun || deps.closeScanRun;
  if (!injected && !supabase) {
    return { enabled: false, reason: "no Supabase client is configured (in-memory mode)" };
  }
  return {
    enabled: true,
    reason: null,
    open: deps.openScanRun || openScanRun,
    beat: deps.heartbeatScanRun || heartbeatScanRun,
    close: deps.closeScanRun || closeScanRun,
  };
}

/**
 * Open the chunk's run. Returns null ONLY when the ledger is disabled, and that
 * case is announced rather than passed over in silence.
 *
 * A real failure to open propagates: see resolveChunkLedger.
 */
async function openChunkRun(ledger, fields, opts = {}) {
  if (!ledger.enabled) {
    const label = opts.label || "scan-chunk";
    const what = opts.what || "chunk execution";
    const noun = opts.noun || "chunk";
    const subject =
      opts.subject || `job ${(fields.detail && fields.detail.job_id) || fields.scanJobId || "(unknown job)"}`;
    console.warn(
      `[${label}] SCAN_RUNS LEDGER DISABLED (${ledger.reason}) — this ${what} for ` +
        `${subject} will write NO scan_runs row. Its phase, outcome, reason and counters go ` +
        `unrecorded, and its ABSENCE from the ledger must not be read as "the ${noun} never ran": ` +
        `the status read (R3.2.3) and the reaper (R3.3.2) cannot see this execution at all.`
    );
    return null;
  }
  return await ledger.open(fields);
}

/**
 * Close the chunk's run, exactly once.
 *
 * A FAILURE TO CLOSE IS ANNOUNCED, NOT THROWN, and that is not fail-soft: the
 * consequence is the row staying OPEN with a stale heartbeat, which is a visible
 * state R3.3.2 sweeps and closes as 'reaped'. Replacing the chunk's own result
 * with a ledger-write error would be the worse trade -- the fleet's closeOrWarn
 * makes the same call for the same reason.
 */
async function closeChunkRun(ledger, run, fields, { label = "scan-chunk" } = {}) {
  if (!run) return null;
  try {
    const closed = await ledger.close({ runId: run.id, ...fields });
    console.log(`[${label}] ${describeRun(closed)}`);
    return closed;
  } catch (err) {
    console.error(
      `[${label}] WARNING: could not close run ${run.id} (${fields.outcome}/${fields.reason}): ` +
        `${err.message} — it stays OPEN and will be reaped rather than accounted for.`
    );
    return null;
  }
}

/**
 * Beat the run's heartbeat while the chunk is in flight.
 *
 * A failed beat is logged, not thrown, for the same reason as above: the cost of
 * a missed beat is the run going stale and being reaped -- a visible state
 * something else acts on -- and tearing down a live chunk over one UPDATE would
 * be worse. deps.setIntervalFn / deps.clearIntervalFn / deps.runHeartbeatMs are
 * test-only injection.
 */
function startChunkHeartbeat(ledger, run, deps = {}) {
  if (!run || !ledger.enabled) return () => {};
  const every = deps.setIntervalFn || setInterval;
  const cancel = deps.clearIntervalFn || clearInterval;
  const ms = Number.isFinite(deps.runHeartbeatMs) ? deps.runHeartbeatMs : CHUNK_RUN_HEARTBEAT_MS;
  const handle = every(() => {
    Promise.resolve(ledger.beat({ runId: run.id })).catch((err) =>
      console.warn(
        `[scan-chunk] WARNING: heartbeat for run ${run.id} failed: ${err.message} — this run will ` +
          `read as stale and may be reaped while the chunk is still working`
      )
    );
  }, ms);
  // Never hold a serverless invocation open for a heartbeat.
  if (handle && typeof handle.unref === "function") handle.unref();
  return () => cancel(handle);
}

/**
 * Which phase this chunk is about to enter, decided from the job it just read.
 *
 * A job with no checkpoint has not finished sourcing; 'probing' and 'scoring'
 * name themselves. Anything else -- a job that is already finished, or a
 * checkpointed job sitting in a status this chunk has no work for -- never
 * enters a work phase, so it is 'entry', and the run closes 'noop' with the
 * status in its reason rather than being filed under a phase that did not run.
 * A completed job in particular has no checkpoint of its own to read, and
 * calling that 'sourcing' would file a decision to do nothing under the phase
 * that would have done the most.
 */
export function resolveEntryPhase(job) {
  if (!job) return CHUNK_PHASES.ENTRY;
  if (job.status === "complete" || job.status === "failed") return CHUNK_PHASES.ENTRY;
  if (!job.checkpoint) return CHUNK_PHASES.SOURCING;
  if (job.status === "probing") return CHUNK_PHASES.PROBING;
  if (job.status === "scoring") return CHUNK_PHASES.FINALIZE;
  return CHUNK_PHASES.ENTRY;
}

/**
 * runScanChunk's own return value + what it measured -> the close_scan_run call.
 *
 * PURE, and exported, so every branch of the mapping is testable without a
 * database. Two properties matter more than the rest:
 *   1. An unrecognised reason closes as FAILED with the reason spelled out, not
 *      as 'succeeded'. A new early return added to runScanChunk later must show
 *      up in the ledger as an unmapped failure, loudly, rather than being
 *      rounded up to success by a default branch that shrugs.
 *   2. Counters pass through as null when the phase that would have measured
 *      them never ran. Never `?? 0` here.
 */
export function chunkRunOutcome(result, tally = {}) {
  const counts = {
    probesAttempted: Number.isInteger(tally.probesAttempted) ? tally.probesAttempted : null,
    probesSucceeded: Number.isInteger(tally.probesSucceeded) ? tally.probesSucceeded : null,
    errorsRecovered: Number.isInteger(tally.errorsRecovered) ? tally.errorsRecovered : null,
  };
  const detail = {
    phases_run: Array.isArray(tally.phases) ? tally.phases : [],
    chunk_reason: (result && result.reason) || null,
    // R3.2.2. `skips` is null when no phase armed it (NOT MEASURED) and [] with
    // skips_total 0 when a phase looked and found none. Never `?? 0` here: a
    // chunk that never watched for skips must not report zero of them.
    ...summarizeSkips(tally),
  };
  const reason = result && result.reason ? String(result.reason) : null;

  switch (reason) {
    // The chunk carried the job all the way to a saved scan.
    case "complete":
      return { outcome: RUN_OUTCOMES.SUCCEEDED, reason: "complete", ...counts, detail };

    // Hit the soft time budget with work left. The CHUNK succeeded -- it probed,
    // checkpointed and handed off -- even though the JOB is not finished, and
    // 'succeeded' with reason 'checkpointed' is how the ledger says both at once.
    case "checkpointed":
      return {
        outcome: RUN_OUTCOMES.SUCCEEDED,
        reason: "checkpointed",
        ...counts,
        detail: { ...detail, progress_pct: result.progress_pct ?? null },
      };

    // Lost a claim to a concurrent invocation. It DECLINED to run: 'skipped',
    // never 'noop' -- collapsing the two is how a job being fought over comes to
    // look like a job with nothing to do.
    case "sourcing_claimed_elsewhere":
    case "finalize_claimed_elsewhere":
      return { outcome: RUN_OUTCOMES.SKIPPED, reason, ...counts, detail };

    // Asked about a job that is not there. Nothing to measure, nothing to do.
    case "not_found":
      return { outcome: RUN_OUTCOMES.SKIPPED, reason, ...counts, detail };

    // Looked, and the job was genuinely already done: a MEASURED nothing-to-do.
    case "already_finished":
      return {
        outcome: RUN_OUTCOMES.NOOP,
        reason,
        ...counts,
        detail: { ...detail, job_status: result.status ?? null },
      };

    // Checkpointed, but in a status this chunk has no work for. The status goes
    // in the reason: an unexplained noop is what the reason column exists for.
    case "noop":
      return {
        outcome: RUN_OUTCOMES.NOOP,
        reason: `noop_status_${result.status ?? "unknown"}`,
        ...counts,
        detail: { ...detail, job_status: result.status ?? null },
      };

    // Could not even read the job. It ran and did not finish: 'failed'.
    case "read_failed":
      return { outcome: RUN_OUTCOMES.FAILED, reason, error: result.error ?? null, ...counts, detail };

    case "error":
      return {
        outcome: RUN_OUTCOMES.FAILED,
        reason: "chunk_failed",
        error: result.error ?? null,
        ...counts,
        detail,
      };

    default:
      return {
        outcome: RUN_OUTCOMES.FAILED,
        reason: `unmapped_chunk_reason:${reason ?? "none"}`,
        error:
          `runScanChunk returned a reason this ledger has no mapping for (${JSON.stringify(reason)}). ` +
          `Recorded as failed rather than rounded up to success -- add the case.`,
        ...counts,
        detail,
      };
  }
}

const CADENCE_MS = {
  "72h": 72 * 60 * 60 * 1000,
  daily: 24 * 60 * 60 * 1000,
  weekly: 7 * 24 * 60 * 60 * 1000,
};

function queryTextKey(text) {
  return String(text || "").toLowerCase().trim();
}

function mapDbPromptRow(p) {
  return {
    text: p.text,
    source: p.source || "db",
    topic: p.topic || "General",
    intent_tier: p.intent_tier || "informational",
  };
}

/**
 * Tracked-set size. Plan-limit lever: raising it (PROMPT_TARGET env) makes the
 * next scan top up ADDITIVELY — existing prompts and their histories are never
 * regenerated or replaced (prompt-set contract, 2026-07-20).
 */
export function resolvePromptTarget() {
  const raw = Number.parseInt(process.env.PROMPT_TARGET || "", 10);
  if (!Number.isFinite(raw)) return DEFAULT_UNBRANDED_TARGET;
  return Math.min(100, Math.max(10, raw));
}

/**
 * Sources the brand's tracked unbranded prompt set (prompt-set contract):
 *
 *  - Pool is keyed by resolveBrandKey (domain-first) so brand-name casing or
 *    variants can never fragment the set. Legacy pools stored under the typed
 *    brand name are migrated to the key on first read.
 *  - FAIL-LOUD: a DB error while loading the pool aborts the scan. Silently
 *    regenerating prompts would produce a score on the wrong questions and
 *    quietly break score comparability — a failed scan is strictly better.
 *  - Generation runs only when the pool is genuinely short of target
 *    (onboarding, or an additive top-up after the target was raised).
 *  - Reuse path slices deterministically (DB ordering is created_at, id).
 *
 * Returns the full target-sized list plus only the newly generated ones
 * (so the caller persists just the delta). `deps` is test injection only.
 *
 * UNCHANGED from the pre-P0.2 implementation — this is the exact function
 * the resumable chunk worker's sourcing phase (runSourcingPhase, below)
 * calls; its own tests (workers/promptSourcing.test.mjs) must keep passing
 * untouched.
 */
export async function sourceUnbrandedQueries(brand, url, industry, stats, brandAliases, deps = {}) {
  const getPrompts = deps.getPromptsForBrand || getPromptsForBrand;
  const upsert = deps.upsertPrompts || upsertPrompts;
  const generate = deps.generateUnbrandedPrompts || generateUnbrandedPrompts;
  const target = deps.promptTarget || resolvePromptTarget();

  const promptKey = resolveBrandKey(brand, url);

  let dbPrompts;
  try {
    dbPrompts = await getPrompts(promptKey, false, { strict: true });
  } catch (err) {
    throw new Error(
      `Couldn't load the tracked prompt set for this brand (${err.message}). ` +
        `Scan aborted to protect score comparability — please retry.`
    );
  }

  // Legacy migration: older scans stored the pool under the typed brand name.
  // Re-home those rows under the canonical key once, preserving enabled/weight.
  if ((dbPrompts || []).length === 0 && promptKey !== queryTextKey(brand)) {
    let legacyRows;
    try {
      legacyRows = await getPrompts(brand, true, { strict: true });
    } catch (err) {
      throw new Error(
        `Couldn't load the tracked prompt set for this brand (${err.message}). ` +
          `Scan aborted to protect score comparability — please retry.`
      );
    }
    if ((legacyRows || []).length > 0) {
      console.log(
        `[worker] Migrating ${legacyRows.length} legacy prompts from "${brand}" to key "${promptKey}"`
      );
      try {
        await upsert(
          promptKey,
          legacyRows.map((p) => ({
            text: p.text,
            intent_tier: p.intent_tier,
            topic: p.topic,
            weight: p.weight,
            enabled: p.enabled,
            source: p.source,
          }))
        );
        dbPrompts = await getPrompts(promptKey, false, { strict: true });
      } catch (err) {
        throw new Error(
          `Couldn't migrate the tracked prompt set to its new key (${err.message}). ` +
            `Scan aborted to protect score comparability — please retry.`
        );
      }
    }
  }

  // getPromptsForBrand returns every enabled row regardless of tier, and we
  // persist branded seeds alongside the unbranded set. Filter them out here or
  // they leak into the tracked set on the next scan and silently inflate the score.
  const existing = (dbPrompts || [])
    .filter(
      (p) =>
        p.intent_tier !== "branded" &&
        String(p.source || "").toLowerCase() !== "branded_seed" &&
        !isBrandedQuery(p.text, brandAliases)
    )
    .map(mapDbPromptRow);

  if (existing.length >= target) {
    const reused = existing.slice(0, target);
    return {
      queries: reused,
      newlyGenerated: [],
      promptKey,
      ...classifyPromptSource(reused),
    };
  }

  const seen = new Set(existing.map((q) => queryTextKey(q.text)));
  const merged = [...existing];

  let attempts = 0;
  while (merged.length < target && attempts < MAX_SOURCING_ATTEMPTS) {
    attempts++;
    const shortfall = target - merged.length;
    let generated;
    try {
      generated = await generate(brand, url, industry, stats, shortfall);
    } catch (err) {
      // B7: the LLM being off used to end in a silent top-up from the static
      // industry pack, published as a generated set. Abort loudly instead —
      // typed, and naming the stage so an operator is not left guessing which
      // of the scan's LLM calls died.
      if (isLlmUnavailable(err)) throw new PromptSourcingUnavailableError(brand, err);
      throw err;
    }
    for (const q of generated) {
      const key = queryTextKey(q.text);
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(q);
      if (merged.length >= target) break;
    }
  }

  if (merged.length < target) {
    throw new Error(
      `Could only source ${merged.length}/${target} unique unbranded prompts for this scan.`
    );
  }

  const queries = merged.slice(0, target);
  return {
    queries,
    newlyGenerated: merged.slice(existing.length),
    promptKey,
    // Provenance travels with the set: if the static industry pack was used,
    // the scan says so rather than presenting generic questions as generated.
    ...classifyPromptSource(queries),
  };
}

// ---------------------------------------------------------------------------
// Small pure helpers (citations / rollups / scheduling).
//
// summarizeEngineSlice/domainMatches (scoring) and toDateOnly/
// unionPromptCounts/buildMetricsRows (brand_metrics_daily rollup) used to be
// hand-kept copies here — this package originally couldn't modify
// enginePipeline.js or extract a shared rollup module. Both gaps are closed
// now (P0.2 follow-up, FIX A/B): enginePipeline.js and
// src/lib/analytics/rollup.js are the single source of truth for this logic,
// and this file just imports + re-exports them so external callers that
// still import these names from scanWorker.js (esp. scanChunk.test.mjs)
// don't need to change. A second copy of any of this is exactly the drift
// risk closing this gap was meant to prevent — do not reintroduce one.
// ---------------------------------------------------------------------------

export { summarizeEngineSlice, domainMatches, toDateOnly, unionPromptCounts, buildMetricsRows };

function normalizeRosterNameKey(name) {
  return String(name || "").trim().toLowerCase();
}

/**
 * Competitor-judging gap fix (finalize-time roster): the FULL set of
 * competitor NAMES to judge every reconstructed answer against, as the
 * UNION of the checkpoint's user-supplied competitor list and
 * extractCompetitors' discovered `competitorObjects` — deduped by a simple
 * trim+lowercase key, first-seen order preserved (user-supplied names win
 * the roster's display casing over a re-discovered duplicate).
 *
 * `competitorObjects` (extractCompetitors' own output) already folds
 * user-supplied names into its internal merge — in the real pipeline this
 * union is normally a no-op over what's already there. It exists as a
 * defensive backstop, not for the common case: a user-typed competitor must
 * never silently vanish from the judging roster because of an
 * extractCompetitors edge case (a normalizeNameKey collision that drops it,
 * a `deps.extractCompetitors` test override that doesn't echo it back,
 * etc). Competitor objects with a blank/missing `.name` are skipped.
 */
export function unionCompetitorNames(userCompetitors, competitorObjects) {
  const seen = new Set();
  const names = [];
  const add = (raw) => {
    const trimmed = String(raw || "").trim();
    if (!trimmed) return;
    const key = normalizeRosterNameKey(trimmed);
    if (seen.has(key)) return;
    seen.add(key);
    names.push(trimmed);
  };
  (userCompetitors || []).forEach((name) => add(name));
  (competitorObjects || []).forEach((c) => add(c && c.name));
  return names;
}

/** cadence -> next_run_at. Unknown/missing cadence defaults to 72h. */
export function computeNextRunAt(cadence, fromIso) {
  const ms = CADENCE_MS[cadence] ?? CADENCE_MS["72h"];
  const fromMs = new Date(fromIso || Date.now()).getTime();
  return new Date(fromMs + ms).toISOString();
}

/**
 * Single source of truth for "does this job need a rescue kick right now?" —
 * used by BOTH the status route's poll-driven rescue (one job at a time) and
 * the cron worker's sweep (filtering many jobs). A job that's already
 * complete/failed is never rescued (isJobAlive alone isn't enough here: it
 * returns false for ANY non-running status, complete/failed included, which
 * would otherwise make this look due for a “rescue”).
 */
export function shouldRescueJob(job, nowMs = Date.now()) {
  if (!job) return false;
  if (job.status === "complete" || job.status === "failed") return false;
  return !isJobAlive(job, nowMs);
}

/**
 * Best-effort URL for a chunk to fire-and-forget-fetch itself onward after
 * checkpointing (plan.md P0.2 point 2: "the fire-and-forget self-fetch ...
 * is an optimization only — correctness never depends on it"). Poll-driven
 * rescue (status route) and cron resume are the real guarantee; if none of
 * these env vars resolve to anything reachable, the self-continue fetch
 * below simply fails silently and the job resumes on the next poll/cron tick
 * instead.
 */
export function resolveSelfContinueUrl(jobId) {
  const base =
    process.env.NEXT_PUBLIC_APP_URL ||
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "") ||
    `http://localhost:${process.env.PORT || 3000}`;
  if (!base) return null;
  return `${base.replace(/\/$/, "")}/api/scan/worker?job_id=${encodeURIComponent(jobId)}`;
}

function defaultSelfContinue(jobId) {
  const url = resolveSelfContinueUrl(jobId);
  if (!url) return;
  // The worker route is secret-gated when CRON_SECRET is set (reviewer D4), so
  // the self-continue call must authenticate itself or it 401s and the chunk
  // silently stops advancing (poll rescue would still recover it, but slower).
  const secret = (process.env.CRON_SECRET || "").trim();
  const init = secret ? { headers: { "x-cron-secret": secret } } : undefined;
  try {
    fetch(url, init).catch((err) => {
      console.warn(
        `[scan-chunk] Self-continue fetch failed for job ${jobId} (poll/cron rescue will still pick it up): ${err.message}`
      );
    });
  } catch (err) {
    console.warn(`[scan-chunk] Self-continue fetch could not be started for job ${jobId}: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Phase 1 — sourcing (runs once per job, first chunk that has no checkpoint yet)
// ---------------------------------------------------------------------------

/**
 * Resolves the prompt set + branded seeds EXACTLY as the pre-P0.2
 * `startScanJob` did (steps 1 & 1b), then freezes everything a later chunk
 * needs into a checkpoint so resumes never regenerate prompts (prompt-set
 * contract) and never re-resolve which engines are "the" engines for this
 * job even if env vars change mid-scan.
 */
export async function runSourcingPhase(job, deps = {}, tally = {}) {
  // This phase watches for absorbed errors (the prompt-persist failure below),
  // so it declares that measurement even when the count comes out zero. A
  // sourcing pass that swallowed nothing and a chunk that never sourced must
  // not both read as "errors_recovered: 0".
  armCount(tally, "errorsRecovered");
  // …and it watches for the skip that absorbed error IS (R3.2.2). Armed here so
  // a sourcing pass that persisted everything reports `skips_total: 0` — it
  // looked — rather than the null of a chunk that never sourced.
  armSkips(tally);
  const sourceQueries = deps.sourceUnbrandedQueries || sourceUnbrandedQueries;
  const buildBranded = deps.buildBrandedQueries || buildBrandedQueries;
  const upsert = deps.upsertPrompts || upsertPrompts;
  const resolveEngines = deps.resolveEnabledEngines || resolveEnabledEngines;

  const brand = job.brand;
  const url = job.url || "";
  const industry = job.industry || "";
  const competitorsRaw = job.competitors || "";
  const competitors = competitorsRaw
    .split(",")
    .map((c) => c.trim())
    .filter(Boolean);

  const brandAliases = getBrandAliases(brand, url);
  const stats = { cost: 0, tokens: 0 };

  const {
    queries: unbrandedQueries,
    newlyGenerated,
    promptKey,
    prompt_source: promptSource,
    static_pack_prompts: staticPackPrompts,
  } = await sourceQueries(brand, url, industry, stats, brandAliases, deps);

  if (staticPackPrompts > 0) {
    console.warn(
      `[scan-chunk] "${brand}" prompt set includes ${staticPackPrompts}/${unbrandedQueries.length} ` +
        `prompts from the static industry pack — recorded as prompt_source=${promptSource} on the scan. ` +
        `These questions were not chosen for this brand.`
    );
  }

  const brandedQueries = buildBranded(brand, url).filter((q) => {
    const key = queryTextKey(q.text);
    return !unbrandedQueries.some((u) => queryTextKey(u.text) === key);
  });

  const queries = [...unbrandedQueries, ...brandedQueries];

  const toPersist = [...newlyGenerated, ...brandedQueries];
  if (toPersist.length > 0) {
    try {
      await upsert(
        promptKey,
        toPersist.map((q) => ({
          text: q.text,
          intent_tier: q.intent_tier,
          topic: q.topic,
          weight: 1.0,
          source: q.source,
          enabled: true,
        }))
      );
    } catch (err) {
      // Absorbed and continued past: the prompts are still used for this scan,
      // they just are not durable for the next one. Counted AND named — the
      // count says how much was swallowed, the reason says what it was.
      bumpCount(tally, "errorsRecovered");
      recordSkip(tally, CHUNK_SKIP_REASONS.PROMPT_PERSIST_FAILED, err.message);
      console.warn("[scan-chunk] Failed to persist prompts:", err.message);
    }
  }

  console.log(
    `[scan-chunk] Prepared ${queries.length} queries ` +
      `(${unbrandedQueries.length} unbranded, ${brandedQueries.length} brand-presence)`
  );

  const enabledEngineNames = resolveEngines().map((e) => e.name);

  return {
    brand,
    url,
    industry,
    competitors,
    competitors_raw: competitorsRaw,
    prompt_key: promptKey,
    prompt_source: promptSource,
    static_pack_prompts: staticPackPrompts,
    queries,
    unbranded_texts: unbrandedQueries.map((q) => q.text.toLowerCase().trim()),
    engines: enabledEngineNames,
    stats: { cost: stats.cost || 0, tokens: stats.tokens || 0 },
    sourced_at: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Phase 2 — probing (resumable): (engine, query) pairs, skip-completed, batch
// writes + heartbeat after every batch, bail out at the soft time budget.
// ---------------------------------------------------------------------------

export async function runProbingPhase(jobId, checkpoint, deps = {}, chunkStartMs = Date.now(), tally = {}) {
  // This phase is the one that counts probes, so it arms all three counters
  // here rather than on first use. A chunk that entered probing and found every
  // pair already persisted must report a MEASURED zero -- it looked -- and that
  // is a different row from a chunk that never probed at all, whose counters
  // stay NULL. Migration 011's nullable counters exist for exactly this.
  armCount(tally, "probesAttempted");
  armCount(tally, "probesSucceeded");
  armCount(tally, "errorsRecovered");
  // Probing is also where engines get dropped and probes come back empty
  // (R3.2.2), so it declares that watch too: `skips: []` here is "I looked",
  // and it is a different row from the null of a chunk that never probed.
  armSkips(tally);
  const updateJob = deps.updateScanJob || updateScanJob;
  const getCompletedPairs = deps.getCompletedPairsForJob || getCompletedPairsForJob;
  const upsertResults = deps.upsertPromptResults || upsertPromptResults;
  const resolveEngines = deps.resolveEnabledEngines || resolveEnabledEngines;
  const nowFn = deps.now || Date.now;
  const budgetMs = deps.chunkBudgetMs ?? CHUNK_TIME_BUDGET_MS;

  const { brand, url, competitors, queries, prompt_key: promptKey } = checkpoint;
  const brandAliases = getBrandAliases(brand, url);
  const brandDomain = extractBrandDomain(url);

  const allEngineDefs = resolveEngines();
  const frozenNames = checkpoint.engines && checkpoint.engines.length ? checkpoint.engines : null;
  const filtered = frozenNames ? allEngineDefs.filter((e) => frozenNames.includes(e.name)) : allEngineDefs;

  // R3.2.2 — THE ENGINE SKIP, which until now happened in total silence.
  //
  // `engines` is frozen onto the checkpoint at sourcing time so a mid-scan env
  // change cannot re-pick this scan's engines. The consequence nobody recorded:
  // an engine frozen into the checkpoint that no longer resolves against the
  // live registry (its key was pulled, its flag was flipped) is simply not in
  // `filtered`, is never probed, and the scan finalizes with a headline blended
  // over the engines that remain. The scan looked complete, the ledger said
  // 'succeeded', and the fact that a whole engine had been dropped existed only
  // as the difference between two array lengths inside one stack frame.
  const registered = new Set(allEngineDefs.map((e) => e.name));
  for (const name of frozenNames || []) {
    if (registered.has(name)) continue;
    recordSkip(tally, CHUNK_SKIP_REASONS.ENGINE_NOT_REGISTERED, name);
    console.warn(
      `[scan-chunk] Job ${jobId}: engine "${name}" was frozen into this scan's checkpoint but is no ` +
        `longer registered — it will NOT be probed, and this scan's headline is blended over the ` +
        `engines that remain. Recorded on the run as ${CHUNK_SKIP_REASONS.ENGINE_NOT_REGISTERED}.`
    );
  }

  // Defensive fallback only: if none of the checkpoint-frozen engine names
  // resolve against the live registry any more (e.g. env fully reconfigured
  // mid-scan), fall back to whatever's enabled today rather than stalling
  // the job forever on an empty engine list. That fallback silently changes
  // WHICH questions this scan is answered by, so it is recorded as its own
  // reason rather than hiding among the per-engine drops above.
  const engineDefs = filtered.length > 0 ? filtered : allEngineDefs;
  if (frozenNames && filtered.length === 0) {
    recordSkip(tally, CHUNK_SKIP_REASONS.ENGINE_SET_FALLBACK, frozenNames.join(","));
    console.warn(
      `[scan-chunk] Job ${jobId}: NONE of the checkpoint-frozen engines (${frozenNames.join(", ")}) ` +
        `resolve any more — probing today's set (${allEngineDefs.map((e) => e.name).join(", ") || "none"}) ` +
        `instead. This scan is no longer comparable to the set it was started with.`
    );
  }

  const completed = await getCompletedPairs(jobId);
  const totalPairs = Math.max(queries.length * engineDefs.length, 1);
  let doneCount = completed.size;

  const stats = { cost: checkpoint.stats?.cost || 0, tokens: checkpoint.stats?.tokens || 0 };
  let workingCheckpoint = checkpoint;
  let progressPct = Math.min(85, 25 + Math.round((doneCount / totalPairs) * 60));

  for (const engine of engineDefs) {
    const pending = queries.filter((q) => !completed.has(`${engine.name}|${q.text}`));

    for (let i = 0; i < pending.length; i += engine.concurrency) {
      const batch = pending.slice(i, i + engine.concurrency);

      const batchResults = await Promise.all(
        batch.map((query) => engine.probe(query, brand, brandAliases, brandDomain, competitors, stats))
      );

      // ATTEMPTED moves here, before the write: these probes really ran and
      // really cost money, and they stay counted even if the upsert below
      // throws. A probe that came back carrying `error` (enginePipeline sets
      // that field on every engine path) is one this chunk absorbed and
      // continued past -- the row is still written, marked as an error -- which
      // is what errors_recovered means. SUCCEEDED moves only after the write
      // lands, a few lines down: the fleet counts what is durable and so does
      // this, which is also why probes_succeeded can never exceed
      // probes_attempted (migration 011's scan_runs_counts_chk).
      const probeErrors = batchResults.filter((r) => r && r.error).length;
      bumpCount(tally, "probesAttempted", batch.length);
      bumpCount(tally, "errorsRecovered", probeErrors);
      // R3.2.2 — WHY those errors happened, not just how many. errors_recovered
      // is a number; "5 probes were absorbed" and "5 probes were absorbed
      // because Bright Data returned 502" are different facts, and only the
      // first one survived until now. Aggregated by reason (recordSkip), so a
      // whole engine timing out costs one detail entry with an exact count.
      batchResults.forEach((r) => {
        if (r && r.error) recordSkip(tally, CHUNK_SKIP_REASONS.PROBE_ERROR, `${engine.name}: ${r.error}`);
      });

      // Persist prompt_results ONLY — the COMPLETE probe result (including
      // `references`) is stored verbatim in `raw`, so finalize can both
      // reconstruct the exact results array AND materialize citations from
      // it later.
      //
      // Citations are deliberately NOT written here (P0.2 FIX 1). "Pair
      // completed" (getCompletedPairsForJob, above) is defined solely by
      // prompt_results existence, so an instance dying between a
      // prompt_results write and a citations write would silently SKIP the
      // pair on resume and lose its citations forever — and citations has no
      // unique constraint of its own, so a resumed re-run of an uncommitted
      // batch would DUPLICATE them instead. runFinalizePhase now
      // materializes every citation in one idempotent delete-then-reinsert
      // pass, once all of a job's prompt_results rows are durably persisted.
      const rows = batchResults.map((result) => {
        // P1.1: the self brand's own record out of the symmetric roster
        // enginePipeline.js attaches to every probe result (result.brands —
        // self + every tracked competitor, see judgeBrandsSymmetric). Only
        // the self brand's position/sentiment lands on prompt_results itself;
        // the full self+rival matrix is materialized into result_brands at
        // finalize (P1.2, runFinalizePhase below).
        const selfBrand = (result.brands || []).find((b) => b.is_self);
        return {
          job_id: jobId,
          brand: promptKey,
          prompt_id: null,
          query: result.prompt,
          engine: result.engine,
          answered: result.answer_present,
          mentioned: result.brand_mentioned_in_text,
          brand_cited: result.brand_cited,
          position: selfBrand ? selfBrand.position : null, // P1.1 — in-answer rank, null when unlisted
          sentiment: selfBrand ? selfBrand.sentiment : null, // P1.1 — 0-100, null (never 0) when not mentioned
          intent: result.intent_tier,
          is_branded_query: result.is_branded_query,
          answer_text: result.text,
          raw: result,
        };
      });
      await upsertResults(rows);
      bumpCount(tally, "probesSucceeded", batch.length - probeErrors);

      batch.forEach((q) => completed.add(`${engine.name}|${q.text}`));
      doneCount += batch.length;
      progressPct = Math.min(85, 25 + Math.round((doneCount / totalPairs) * 60)); // 25% -> 85%

      // Heartbeat + progress + checkpoint after EVERY batch — this is what
      // keeps the job "alive" (isJobAlive) across a chunk that may itself
      // run for minutes, not the overall chunk time budget.
      workingCheckpoint = { ...workingCheckpoint, stats: { cost: stats.cost || 0, tokens: stats.tokens || 0 } };
      await updateJob(jobId, { progress_pct: progressPct, checkpoint: workingCheckpoint });

      if (doneCount >= totalPairs) {
        return { budgetHit: false, checkpoint: workingCheckpoint, progressPct };
      }
      if (nowFn() - chunkStartMs >= budgetMs) {
        return { budgetHit: true, checkpoint: workingCheckpoint, progressPct };
      }
    }
  }

  return { budgetHit: false, checkpoint: workingCheckpoint, progressPct };
}

// ---------------------------------------------------------------------------
// Phase 3 — finalize (once, after all pairs are persisted): reconstruct
// `results` from `raw`, reuse the exact summarize/headline/competitor/record
// logic, fail-loud on insertScan, roll up brand_metrics_daily.
// ---------------------------------------------------------------------------

/**
 * The window the answers were actually collected in (R2.7.4).
 *
 * min/max of the persisted rows' created_at. Returns nulls rather than
 * guessing when the rows carry no timestamps — a window that silently
 * collapses to the finalize instant is the thing this replaces, so an unknown
 * window must read as unknown, not as "now".
 *
 * @param {Array<{created_at?: string}>} rows
 * @returns {{collected_from: string|null, collected_to: string|null}}
 */
export function collectionWindow(rows) {
  const times = (rows || [])
    .map((r) => r?.created_at)
    .filter(Boolean)
    .map((t) => Date.parse(t))
    .filter((n) => Number.isFinite(n));

  if (!times.length) return { collected_from: null, collected_to: null };

  return {
    collected_from: new Date(Math.min(...times)).toISOString(),
    collected_to: new Date(Math.max(...times)).toISOString(),
  };
}
export async function runFinalizePhase(jobId, checkpoint, deps = {}, tally = {}) {
  const updateJob = deps.updateScanJob || updateScanJob;
  const claimJob = deps.claimJobStatus || claimJobStatus;
  const getResultsForJob = deps.getPromptResultsForJob || getPromptResultsForJob;
  const insertScanFn = deps.insertScan || insertScan;
  const stampScanId = deps.stampScanIdForJob || stampScanIdForJob;
  const deleteCits = deps.deleteCitationsForJob || deleteCitationsForJob;
  const insertCits = deps.insertCitations || insertCitations;
  const deleteRB = deps.deleteResultBrandsForJob || deleteResultBrandsForJob;
  const insertRB = deps.insertResultBrands || insertResultBrands;
  const upsertMetrics = deps.upsertBrandMetricsDaily || upsertBrandMetricsDaily;
  const resolveEngines = deps.resolveEnabledEngines || resolveEnabledEngines;
  const summarizeMulti = deps.summarizeEngineResults || summarizeEngineResults;
  const computeHeadlineFn = deps.computeHeadline || computeHeadline;
  const summarizeAio = deps.summarizeAioResults || summarizeAioResults;
  const extractCompetitorsFn = deps.extractCompetitors || extractCompetitors;
  const getScansByDomainFn = deps.getScansByDomain || getScansByDomain;
  const getResultBrandsForScanFn = deps.getResultBrandsForScan || getResultBrandsForScan;
  const aggregateTopDomainsFn = deps.aggregateAioTopDomains || aggregateAioTopDomains;
  const enrichCitationsFn = deps.enrichCitations || enrichCitations;
  const judgeBrandsSymmetricFn = deps.judgeBrandsSymmetric || judgeBrandsSymmetric;

  // Loaded up front (before the claim below) so `alreadyStamped` can
  // disambiguate the claim's two failure modes — see the comment on the
  // claim itself.
  const allRows = await getResultsForJob(jobId);
  const alreadyStamped = allRows.find((r) => r.scan_id);

  // Structural single-flight (P0.2 FIX 2): claim "probing" -> "scoring"
  // before doing any finalize work, so two instances that both see this job
  // sitting in "probing" can't both reach insertScan and create two `scans`
  // rows (previously only a sequential crash-recovery guard — the
  // `alreadyStamped` reuse below — protected against this, and nothing
  // guarded the window between entering "scoring" and insertScan itself).
  //
  // A lost claim (`claimed` is falsy) is ambiguous on its own between two
  // different situations:
  //   (a) another instance is ACTIVELY finalizing this job right now (it
  //       already claimed "scoring" but hasn't stamped a scan_id yet) — we
  //       must bail, or risk a second insertScan racing it into a duplicate
  //       `scans` row.
  //   (b) this IS the legitimate crash-then-resume case: a PRIOR winner
  //       already claimed "scoring", ran insertScan + stampScanIdForJob,
  //       then died before finishing — the job would be stuck in "scoring"
  //       forever unless something re-enters and completes it, but its
  //       status is no longer "probing" so a plain claim attempt fails.
  // `alreadyStamped` disambiguates the two: only a finalize attempt that
  // reached stampScanIdForJob leaves prompt_results rows with a non-null
  // scan_id, so its presence proves (b), not (a) — skip the claim entirely
  // and fall through to reuse the stamped scan_id further down.
  if (!alreadyStamped) {
    const claimed = await claimJob(jobId, "probing", "scoring");
    if (!claimed) {
      console.warn(`[scan-chunk] Job ${jobId}: lost the finalize claim — another instance owns it.`);
      return null;
    }
  }

  // Past the claim, so this invocation really is doing the finalize work and is
  // therefore the one watching for the errors it absorbs below (re-judge,
  // citation enrichment, per-row roster judging). Armed HERE and not at the top
  // of the function so a chunk that lost the claim reports "not measured"
  // rather than a zero it never looked for.
  armCount(tally, "errorsRecovered");
  // R3.2.2 — and the same arming for the REASONS those absorbed errors carry.
  // Also after the claim: a chunk that lost the finalize claim watched for
  // nothing and must report `skips: null`, not an empty list it never filled.
  armSkips(tally);

  await updateJob(jobId, { status: "scoring", progress_pct: 90 });

  const {
    brand,
    url,
    industry,
    competitors,
    competitors_raw: competitorsRaw,
    unbranded_texts: unbrandedTexts,
    prompt_key: promptKey,
    prompt_source: promptSource,
    static_pack_prompts: staticPackPrompts,
  } = checkpoint;

  const results = allRows.map((r) => r.raw);
  const brandDomain = extractBrandDomain(url);

  const allEngineDefs = resolveEngines();
  const engineNames = checkpoint.engines && checkpoint.engines.length ? checkpoint.engines : allEngineDefs.map((e) => e.name);
  const isMultiEngine = engineNames.length > 1;

  const scannedAt = new Date().toISOString();

  // Same shape-normalization the pre-P0.2 code used, unchanged: both pipeline
  // vintages' field names get reconciled for competitor extraction / top domains.
  const normalizedForCompetitors = results
    .filter((r) => !r.is_branded_query)
    .map((r) => ({
      is_branded_query: false,
      aio_present: r.answer_present || r.aio_present || false,
      aio_text: r.text || r.aio_text || "",
      aio_citations: r.citations || r.aio_citations || [],
      aio_references: r.references || r.aio_references || [],
      visible: r.visible || false,
      engine: r.engine,
    }));

  const stats = { cost: checkpoint.stats?.cost || 0, tokens: checkpoint.stats?.tokens || 0 };

  // Heartbeat immediately before the slow LLM call (P0.2 FIX 2):
  // extractCompetitors can take up to ~75s, and until now finalize had NO
  // heartbeat between entering "scoring" (above) and completing — a
  // legitimately slow finalize could exceed HEARTBEAT_STALE_MS (180s),
  // look dead to isJobAlive, and invite a rescue into a second, concurrent
  // finalize attempt. Heartbeat-only: deliberately no other fields, this
  // call exists purely to keep the job looking alive.
  await updateJob(jobId, {});

  // R0.3.3 — roster continuity. extractCompetitorsFn reaches the LLM; since
  // R0.3.1 an unreachable LLM THROWS LlmUnavailableError rather than
  // returning an empty answer. resolveCompetitorRoster turns that throw into
  // a labelled state (carried_forward / unavailable) and lets every other
  // error propagate, so finalize still dies on a real fault.
  const {
    competitors: competitorObjects,
    roster_source: rosterSource,
    extraction_offline: rosterExtractionOffline,
    extraction_error: rosterExtractionError,
  } = await resolveCompetitorRoster({
    extract: () =>
      extractCompetitorsFn({
        results: normalizedForCompetitors,
        brand,
        brandUrl: url,
        userCompetitors: competitors,
        stats,
        max: 10,
      }),
    // Chronology comes from scans.scanned_at (result_brands has no date
    // column and a random-uuid pk), so the previous scan is resolved first
    // and its id is what the roster lookup is keyed on. `alreadyStamped` is
    // this job's own scan on a crash-recovery re-finalize — never carry a
    // roster forward from ourselves.
    loadPreviousRoster: async () => {
      const priorScans = await getScansByDomainFn(url || promptKey);
      const previous = (priorScans || []).find(
        (row) => row?.id && row.id !== alreadyStamped?.scan_id
      );
      if (!previous) return [];
      return getResultBrandsForScanFn(previous.id);
    },
  });

  const topDomains = aggregateTopDomainsFn(
    normalizedForCompetitors.filter((r) => r.aio_present),
    url,
    competitorObjects.map((c) => c.name)
  );

  console.log(
    `[scan-chunk] Competitors: ${
      competitorObjects
        .map((c) => `${c.name}(${c.visibilityScore == null ? "—" : `${c.visibilityScore}%`}/${c.source})`)
        .join(", ") || `(none — roster_source=${rosterSource})`
    }`
  );

  // ---------------------------------------------------------------------
  // Competitor-judging gap fix: the FINALIZE-TIME tracked-brand roster.
  //
  // buildTrackedBrandRoster at PROBE time (enginePipeline.js's
  // probeAio/probeTextEngine, driven by the `competitors` frozen onto the
  // checkpoint at sourcing) only ever knows the USER-SUPPLIED competitor
  // list — extractCompetitorsFn (just above) hasn't run yet at that point,
  // so a brand scanned with no user-supplied competitors got a probe-time
  // roster of [self] ONLY. Every result_brands row historically inherited
  // that self-only roster, so sov_pct came out self ÷ self = 100% (always,
  // for the common no-user-competitors case) and gap analysis — which needs
  // rival mentions in result_brands (src/lib/analytics/gaps.js) — was always
  // empty. `fullRoster` here is self + every AUTO-DISCOVERED rival too
  // (unionCompetitorNames, defensively unioned with the checkpoint's own
  // user-supplied list — see its docstring), reused below to RE-JUDGE every
  // reconstructed non-branded answer from scratch instead of trusting
  // whatever narrower roster was baked into raw.brands at probe time.
  //
  // Empty-competitor degradation — and the difference that matters. If the
  // extractor RAN and genuinely found nothing (and no user competitors were
  // given), fullRoster is `[self]` alone and sov_pct is a real 100%: nobody
  // else was co-mentioned. If the extractor could not run at all,
  // `rosterSource` above is `carried_forward` or `unavailable` and that same
  // `[self]`-alone shape means NOTHING WAS MEASURED. The two used to be
  // indistinguishable — the old comment here called the second case "an
  // acceptable degradation, not a regression", and that is precisely how a
  // total LLM outage rendered as a confident 100% Share of Voice (A8/A9).
  // `roster_source` travels onto the scan record below so every downstream
  // surface can tell them apart.
  const brandAliases = getBrandAliases(brand, url);
  const rosterCompetitorNames = unionCompetitorNames(competitors, competitorObjects);
  const fullRoster = buildTrackedBrandRoster(brand, brandAliases, rosterCompetitorNames);

  // -------------------------------------------------------------------
  // R2.3.1 — PASS TWO. Re-judge every row against the discovered roster,
  // then summarize. The order used to be the other way round.
  //
  // Probe-time judging only ever knew the competitors the USER typed
  // (enginePipeline.js builds its roster from the checkpoint), so on a scan
  // where nobody typed any, `r.brands` held [self] alone. Three things
  // downstream then failed together, all silently:
  //
  //   - the eliciting gate in summarizeEngineSlice needs at least one
  //     NON-SELF brand somewhere in the slice before it will engage. With a
  //     self-only roster it disables itself and falls back to scoring over
  //     every answered prompt — including the taxonomy and how-to answers
  //     that name no vendor at all, which is the cap the gate exists to lift;
  //   - Share of Voice came out self / self = 100%;
  //   - top rivals had no rivals to rank.
  //
  // The roster is known HERE, one line above, and the answers are already
  // stored verbatim. So judging them again against the full roster costs one
  // pass over rows already in memory and no vendor call. The headline is
  // computed from the re-judged rows below.
  //
  // Per-row failure is contained the same way the result_brands judging
  // below contains it: one row that cannot be judged keeps its probe-time
  // verdict rather than sinking an otherwise-complete finalize.
  let rejudgedRows = 0;
  for (const r of results) {
    const text = r.text || r.aio_text || "";
    if (!text) continue;
    try {
      r.brands = judgeBrandsSymmetricFn(text, fullRoster);
      rejudgedRows++;
    } catch (err) {
      bumpCount(tally, "errorsRecovered");
      recordSkip(tally, CHUNK_SKIP_REASONS.REJUDGE_FAILED, `${r.engine}: ${err.message}`);
      console.warn(
        `[scan-chunk] Job ${jobId}: re-judge failed for a ${r.engine} row — keeping the probe-time verdict: ${err.message}`
      );
    }
  }
  console.log(
    `[scan-chunk] Re-judged ${rejudgedRows}/${results.length} rows against a roster of ${fullRoster.length} (roster_source=${rosterSource})`
  );

  let summary;
  let engineSummaries = null;
  let headline = null;
  let visibilityIndexPct = null;
  let enginesCounted = 0;

  if (isMultiEngine) {
    engineSummaries = {};
    for (const name of engineNames) {
      const sliceResults = results.filter((r) => r.engine === name);
      engineSummaries[name] = summarizeEngineSlice(sliceResults, name);
    }
    headline = computeHeadlineFn(Object.values(engineSummaries));
    const multiSummary = summarizeMulti({ results, engines: engineSummaries, headline });
    summary = multiSummary.summary;
    engineSummaries = multiSummary.engines;
    visibilityIndexPct = headline.visibility_index_pct;
    enginesCounted = headline.engines_counted;
  } else {
    const single = summarizeAio(results);
    summary = single.summary;
  }


  // Hash the unbranded set only (frozen at sourcing time), so prompt-set
  // identity is stable/comparable across scans regardless of branded seeds.
  const promptTexts = [...(unbrandedTexts || [])].sort();
  const prompt_set_hash = crypto.createHash("sha256").update(promptTexts.join("|")).digest("hex");
  const prompt_set_id = prompt_set_hash.slice(0, 16);

  const platform = isMultiEngine ? "multi" : "google_ai_overview";
  const scoringVersion = isMultiEngine ? "v9-multi-engine" : "v8.1-aio-unbranded-plus-presence";

  const scanRecord = {
    brand,
    url,
    industry,
    platform,
    visibility_pct: summary.visibility_pct,
    share_of_ai_pct: summary.share_of_ai_pct,
    aio_coverage_pct: summary.aio_coverage_pct,
    presence_rate_pct: summary.presence_rate_pct,
    mention_rate_pct: summary.mention_rate_pct,
    prompts_tracked: (unbrandedTexts || []).length,
    prompts_mentioned: summary.visible_non_branded,
    competitors: competitorObjects,
    competitors_raw: competitorsRaw,
    // Standing rule 1: a measured zero must look different from never-ran.
    roster_source: rosterSource,
    roster_extraction_offline: rosterExtractionOffline,
    roster_extraction_error: rosterExtractionError,
    results,
    scanned_at: scannedAt,
    // R2.7.4 — the collection window: first to last probe WRITE, not the
    // finalize instant.
    //
    // `scanned_at` is stamped when finalize runs, which on a chunked scan can
    // be hours after the first probe and minutes after the last. Reporting it
    // as "when this was measured" compresses a real window into a point, and
    // the point it picks is the one furthest from most of the evidence. A scan
    // resumed the next morning after a crash looked like a single reading taken
    // that morning. These two come from the persisted rows themselves, so they
    // describe when the answers were actually collected.
    ...collectionWindow(allRows),
    used_dynamic_prompts: true,
    tokens_used: stats.tokens || 0,
    cost_total: stats.cost || 0,
    scoring_version: scoringVersion,
    prompt_set_id,
    prompt_set_hash,
    // B7: where this scan's questions came from. `null` on pre-R0.3.4 scans.
    prompt_source: promptSource ?? null,
    static_pack_prompts: staticPackPrompts ?? null,
    brand_citation_share_pct: summary.citation_share_pct,
    branded_visibility_pct: summary.branded_visibility_pct,
    aio_error_rate_pct: summary.error_rate_pct,
    top_domains: topDomains,
    query_source: "openrouter_unbranded",
    data_source_issue: summary.data_source_issue,
    insufficient_sample: summary.insufficient_sample,
    summary_stats: summary,
  };

  if (isMultiEngine) {
    scanRecord.engines = engineSummaries;
    scanRecord.visibility_index_pct = visibilityIndexPct;
    scanRecord.engines_counted = enginesCounted;
  }

  // Fail-loud, crash-recoverable: if a PREVIOUS finalize attempt already got
  // as far as stamping scan_id onto these rows (stampScanIdForJob is
  // idempotent — only touches scan_id IS NULL rows) but crashed before
  // marking the job complete, reuse that scan_id instead of calling
  // insertScan a second time (which has no natural-key upsert and would
  // create a duplicate `scans` row). Chunking introduces this crash window;
  // the pre-P0.2 single-shot finalize never had one. `alreadyStamped` was
  // already computed above (it's also what let this call skip the claim).
  let savedScanId = alreadyStamped ? alreadyStamped.scan_id : null;

  if (!savedScanId) {
    let insertErr = null;
    try {
      const savedScan = await insertScanFn(scanRecord);
      savedScanId = savedScan?.[0]?.id || null;
    } catch (err) {
      insertErr = err;
    }
    if (!savedScanId) {
      // NEVER mark complete with result_id: null — the pre-P0.2 code
      // (scanWorker.js:375-388 in the run-to-completion version) swallowed
      // this; here it propagates to runScanChunk's outer catch, which marks
      // the job failed with this message.
      throw new Error(
        `Failed to save scan results: ${insertErr ? insertErr.message || String(insertErr) : "insertScan did not return a saved record id."}`
      );
    }
  }

  await stampScanId(jobId, savedScanId);

  // Materialize citations fresh from raw.references (P0.2 FIX 1): citations
  // are no longer written during probing (see runProbingPhase) — they're a
  // finalize-derived artifact, rebuilt from scratch on every finalize pass.
  // delete-then-reinsert mirrors scripts/backfill-analytics.mjs exactly (same
  // rank = index+1, domain fallback, is_self rule), so live and backfilled
  // citation rows are identical in shape, and the delete makes this safe to
  // run any number of times (crash-recovery re-finalize, or the
  // alreadyStamped resume path above) without duplicating rows — citations
  // carries no unique constraint of its own.
  await deleteCits(jobId);
  const citationCandidates = [];
  allRows.forEach((row) => {
    const raw = row.raw || {};
    const references = raw.references || raw.aio_references || [];
    references.forEach((ref, idx) => {
      const href = ref?.href;
      if (!href) return;
      const domain = ref.domain || extractBrandDomain(href);
      if (!domain) return;
      citationCandidates.push({
        result_id: row.id,
        job_id: jobId,
        scan_id: savedScanId,
        brand: promptKey,
        engine: row.engine,
        url: href,
        domain,
        rank: idx + 1,
        is_self: brandDomain ? domainMatches(domain, brandDomain) : false,
        // Classification-only (content_type heuristics can use the
        // reference's title) — NOT a citations column, stripped below
        // before insert.
        title: ref.title || "",
      });
    });
  });

  // P3a: content_type/domain_type/citation_class classification (heuristics
  // + a small batched free-LLM fallback — src/lib/analytics/citationEnrich.js)
  // BEFORE insert. Wrapped defensively: citationEnrich.js is already
  // fail-loud-soft toward the LLM step internally (an LLM hiccup never
  // throws out of enrichCitations), but a genuine bug in the classifier
  // itself must ALSO never fail an otherwise-successful scan — degrade to
  // unenriched (null-classified) rows instead, exactly like pre-P3a
  // behavior, rather than losing the scan.
  let enrichedCitations;
  try {
    enrichedCitations = await enrichCitationsFn(
      citationCandidates,
      { brandDomain, competitorNames: competitorObjects.map((c) => c.name) },
      deps
    );
  } catch (err) {
    bumpCount(tally, "errorsRecovered");
    recordSkip(tally, CHUNK_SKIP_REASONS.CITATION_ENRICH_FAILED, err.message);
    console.warn(
      `[scan-chunk] Citation enrichment failed for job ${jobId} — inserting unenriched rows: ${err.message}`
    );
    enrichedCitations = citationCandidates;
  }
  const citationRows = enrichedCitations.map(({ title, ...row }) => row);
  if (citationRows.length > 0) await insertCits(citationRows);

  // Symmetric per-brand judging (P1.2, competitor-judging gap fix):
  // materialize one result_brands row per (non-branded result, tracked
  // brand) — self + every discovered competitor — by RE-JUDGING each
  // reconstructed answer's text fresh against `fullRoster` (built above),
  // rather than trusting prompt_results.raw.brands. raw.brands (attached by
  // enginePipeline.js's judgeBrandsSymmetric at PROBE time) only ever knew
  // about self + whichever competitors the user typed in — extractCompetitors
  // hasn't run yet at probe time, so an auto-discovered rival was
  // structurally invisible to it. Recomputing here, once, against the full
  // roster is what actually closes that gap; see `fullRoster`'s comment
  // above for the empty-competitor degradation case.
  //
  // Scoped to NON-BRANDED rows only (the same pool sov_pct/visibility_pct
  // are themselves computed over — see computeBrandRollups) — a branded
  // query ("is <brand> good for X") is about the brand itself, not a
  // meaningful place to look for rival mentions. Rows with no answer text
  // (probe error, no aio present, etc) contribute nothing — there is
  // nothing to judge.
  //
  // Same delete-then-reinsert idempotency shape as citations above:
  // result_brands carries no unique constraint of its own, so a naive
  // re-insert on a crash-recovery re-finalize would duplicate every row;
  // deleting this job's rows first (via the prompt_results.job_id ->
  // result_id join, since result_brands has no job_id column of its own —
  // see deleteResultBrandsForJob) makes this safe to run any number of
  // times.
  await deleteRB(jobId);
  const resultBrandRows = [];
  // Rollup-only projection (P1.3, buildMetricsRows below): carries the
  // engine/is_branded_query context computeBrandRollups needs but
  // result_brands itself doesn't store — never sent to the DB.
  const brandJudgmentRows = [];
  allRows.forEach((row) => {
    if (row.is_branded_query) return;
    const text = (row.raw && row.raw.text) || "";
    if (!text) return;

    let brandJudgments;
    try {
      brandJudgments = judgeBrandsSymmetricFn(text, fullRoster);
    } catch (err) {
      // Fail-loud everywhere else in this file; here, one row's judging
      // blowing up must not sink an otherwise-successful finalize — skip
      // just this row's roster judgment and keep going. Counted into
      // errors_recovered: a finalize that "succeeded" after swallowing nine of
      // these is not the same run as one that met none.
      bumpCount(tally, "errorsRecovered");
      recordSkip(tally, CHUNK_SKIP_REASONS.ROSTER_JUDGE_FAILED, `${row.engine}: ${err.message}`);
      console.warn(
        `[scan-chunk] Job ${jobId}: full-roster judging failed for result ${row.id} (${row.engine}) — skipping: ${err.message}`
      );
      return;
    }

    brandJudgments.forEach((bj) => {
      resultBrandRows.push({
        result_id: row.id,
        scan_id: savedScanId,
        brand: promptKey,
        name: bj.name,
        is_self: bj.is_self,
        mentioned: bj.mentioned,
        position: bj.position,
        sentiment: bj.sentiment,
      });
      brandJudgmentRows.push({
        engine: row.engine,
        is_branded_query: row.is_branded_query,
        name: bj.name,
        is_self: bj.is_self,
        mentioned: bj.mentioned,
        position: bj.position,
        sentiment: bj.sentiment,
      });
    });
  });
  if (resultBrandRows.length > 0) await insertRB(resultBrandRows);

  const dateOnly = toDateOnly(scannedAt);
  const metricsRows = buildMetricsRows({
    isMultiEngine,
    brandKey: promptKey,
    dateOnly,
    scanId: savedScanId,
    promptSetId: prompt_set_id,
    summary,
    engineSummaries,
    headline,
    promptResultRows: allRows,
    brandJudgmentRows,
  });
  await upsertMetrics(metricsRows);

  return updateJob(jobId, {
    status: "complete",
    progress_pct: 100,
    result_id: savedScanId,
    run_record: scanRecord,
  });
}

// ---------------------------------------------------------------------------
// Main entry point — advances a job by one time-bounded chunk. Safe to call
// repeatedly (poll rescue / cron resume / self-continue): resumes from
// checkpoint + persisted prompt_results, never reprocesses finished work.
//
// EVERY CALL WRITES EXACTLY ONE scan_runs ROW (R3.2.1), including the calls that
// decline to do any work. One open, one close, on every path — the close is
// funnelled through the single `finish()` below precisely so a later edit cannot
// add an early return that escapes the ledger. The fleet's runOnce has the same
// invariant for the same reason.
//
// ONE ROW PER CHUNK, NOT PER JOB, AND NOT PER PHASE.
//   * Per PHASE would turn one execution into three rows and make a single
//     chunk look like three; `phase` is where this chunk STARTED and
//     detail.phases_run lists everything it entered.
//   * Per JOB is impossible: a scan is deliberately many chunks. A job resumed
//     by the status-poll rescue, by cron or by the self-continue fetch is a
//     SECOND EXECUTION and gets a second row, honestly — same scan_job_id,
//     a fresh worker_id, and its own phase/outcome. That is not double
//     counting: the first row already closed as 'succeeded'/'checkpointed'
//     (it handed off) or, if it died, is still OPEN for R3.3.2 to reap, so
//     summing the ledger counts each chunk's work once and only once.
//   * Where a rescue genuinely races a live chunk, the loser closes as
//     'skipped' with 'sourcing_claimed_elsewhere' / 'finalize_claimed_elsewhere'
//     and counters that are NULL — a row that says "I did nothing", which is
//     the opposite of a duplicate of the work.
//
// A CHUNK THAT DIES LEAVES EVIDENCE. The run is opened before the work and the
// process crashing (or being frozen by the platform) leaves it OPEN with a stale
// heartbeat_at — sweepable, and visibly different from both a clean close and
// from never having run. Nothing here closes a run on the way out of a crash.
// ---------------------------------------------------------------------------

export async function runScanChunk(jobId, deps = {}) {
  const getJob = deps.getScanJob || getScanJob;
  const updateJob = deps.updateScanJob || updateScanJob;
  const claimJob = deps.claimJobStatus || claimJobStatus;
  const selfContinue = deps.selfContinue || defaultSelfContinue;
  const nowFn = deps.now || Date.now;

  const ledger = resolveChunkLedger(deps);
  // Identifies THIS invocation, so two chunks racing over one job are two
  // distinguishable rows rather than an ambiguous pair. scan_jobs has no
  // lease_owner of its own (single-flight here is claimJobStatus plus R0.1.5's
  // unique partial index on scan_jobs(brand) while running), so the ledger's
  // worker_id is minted per call. It also guarantees scan_runs_subject_chk is
  // satisfied even when jobId is not a uuid.
  const chunkId = deps.chunkId || `chunk-${crypto.randomUUID()}`;
  const tally = createChunkTally();

  // The job read comes first because a ledger row cannot name its subject
  // before the subject has been looked up — the fleet opens its run after
  // claimBatch for the same reason. The window this leaves (a crash inside this
  // one SELECT) leaves the scan_job itself untouched and still rescuable, which
  // is the evidence for that case.
  let job = null;
  let readError = null;
  try {
    job = await getJob(jobId);
  } catch (err) {
    // Transient read failure — we don't even have a confirmed job to mark
    // failed, and a retry from the DB is likely to hit the same transient
    // condition. Log, record it, and let the next poll/cron tick try again.
    readError = err;
    console.error(`[scan-chunk] Failed to read job ${jobId}:`, err.message);
  }

  const run = await openChunkRun(ledger, {
    runner: RUNNERS.SCAN_CHUNK,
    phase: resolveEntryPhase(job),
    workerId: chunkId,
    scanJobId: asUuid(jobId),
    brand: (job && job.brand) || null,
    detail: {
      job_id: jobId,
      entry_status: (job && job.status) || null,
      has_checkpoint: Boolean(job && job.checkpoint),
      read_failed: Boolean(readError),
    },
  });

  /** The only close in this function. Every return goes through it. */
  const finish = async (result) => {
    await closeChunkRun(ledger, run, chunkRunOutcome(result, tally));
    return result;
  };

  if (readError) {
    return finish({ ok: false, reason: "read_failed", error: readError.message });
  }

  if (!job) {
    console.warn(`[scan-chunk] Job ${jobId} not found — nothing to resume.`);
    return finish({ ok: false, reason: "not_found" });
  }

  if (job.status === "complete" || job.status === "failed") {
    return finish({ ok: true, reason: "already_finished", status: job.status });
  }

  const chunkStartMs = nowFn();
  // From here on the chunk is working, so the run says so until it stops.
  const stopHeartbeat = startChunkHeartbeat(ledger, run, deps);
  let result;

  // LABELLED so the early exits below can leave the BODY without leaving the
  // FUNCTION. A bare return here would skip finish() and abandon an open
  // ledger row on two of the commonest paths in this file; break chunkBody
  // runs the finally, falls through to the single close, and cannot be
  // forgotten by an edit that adds another early exit.
  chunkBody: try {
    let status = job.status;
    let checkpoint = job.checkpoint || null;

    if (!checkpoint) {
      // No checkpoint yet => sourcing hasn't completed. Covers both a fresh
      // "pending" job and a "generating_prompts" job resumed after a crash
      // mid-sourcing — sourcing has no partial state of its own (it either
      // produces a full checkpoint or it doesn't), so redoing it is safe:
      // sourceUnbrandedQueries reuses the existing DB pool and only tops up
      // via LLM generation if genuinely short.
      //
      // Structural single-flight (P0.2 FIX 2): claim ownership before doing
      // any work. Two instances resuming the same "pending"/
      // "generating_prompts" job (e.g. a slow sourcing pass whose heartbeat
      // went stale, plus a rescue firing on top of it) would otherwise both
      // call sourceUnbrandedQueries concurrently — same class of race as
      // finalize's double insertScan, but here it means two divergent
      // "additional generated prompts" batches instead of two `scans` rows.
      // Only the winner proceeds; the loser returns immediately.
      const claimed = await claimJob(jobId, ["pending", "generating_prompts"], "generating_prompts");
      if (!claimed) {
        result = { ok: true, reason: "sourcing_claimed_elsewhere" };
        break chunkBody;
      }
      await updateJob(jobId, { progress_pct: 10 });
      tally.phases.push(CHUNK_PHASES.SOURCING);
      checkpoint = await runSourcingPhase(job, deps, tally);
      await updateJob(jobId, { status: "probing", progress_pct: 25, checkpoint });
      status = "probing";
    }

    if (status === "probing") {
      tally.phases.push(CHUNK_PHASES.PROBING);
      const outcome = await runProbingPhase(jobId, checkpoint, deps, chunkStartMs, tally);
      checkpoint = outcome.checkpoint;
      if (outcome.budgetHit) {
        selfContinue(jobId);
        result = { ok: true, reason: "checkpointed", progress_pct: outcome.progressPct };
        break chunkBody;
      }
      status = "scoring";
    }

    if (status === "scoring") {
      tally.phases.push(CHUNK_PHASES.FINALIZE);
      const finalJob = await runFinalizePhase(jobId, checkpoint, deps, tally);
      if (!finalJob) {
        // Lost the finalize claim to another instance — it owns completing
        // this job now (see runFinalizePhase's claim comment).
        result = { ok: true, reason: "finalize_claimed_elsewhere" };
        break chunkBody;
      }
      result = { ok: true, reason: "complete", job: finalJob };
      break chunkBody;
    }

    result = { ok: true, reason: "noop", status };
  } catch (err) {
    console.error(`[scan-chunk] Job ${jobId} failed:`, err);
    try {
      await updateJob(jobId, {
        status: "failed",
        progress_pct: 100,
        error_message: err.message || "An unexpected error occurred during the scan.",
      });
    } catch (err2) {
      console.error(`[scan-chunk] Also failed to mark job ${jobId} failed:`, err2.message);
    }
    result = { ok: false, reason: "error", error: err.message };
  } finally {
    // The chunk is no longer in flight, whichever way it left. Stopping the
    // beat before the close is what keeps a heartbeat from racing the close and
    // hitting heartbeat_scan_run's "already closed" exception.
    stopHeartbeat();
  }

  // `result` is set on every path above, including the catch. If a future edit
  // ever leaves it unset, chunkRunOutcome's default branch closes the run as
  // FAILED with 'unmapped_chunk_reason:none' rather than letting an unaccounted
  // execution read as a success.
  return finish(result);
}

// ---------------------------------------------------------------------------
// Scheduler tick — enqueues scans for due, non-active scan_schedules brands.
// Called by the cron worker route after its resume sweep.
//
// R3.2.2 — THE SCHEDULER SKIPS. Two `continue` statements below decided, for a
// named brand, not to run a scan it was due for, and left no trace anywhere:
// not a log line, not a row, not a field in the response. A brand whose
// schedule cadence had been flipped to 'off' and a brand whose previous scan
// was wedged in 'probing' forever both simply stopped being scanned, and the
// only evidence was the absence of new `scans` rows — which is indistinguishable
// from cron never firing at all. Standing rule 1.
//
// WHY THESE GET ROWS OF THEIR OWN AND THE CHUNK'S SKIPS DO NOT. Migration 011's
// header names this case as the reason scan_job_id carries no foreign key: "A
// scheduler skip (R3.2.2) happens precisely because no job was created." There
// is no chunk execution to hang the fact on — nothing ran — so the skip IS the
// execution. It names a brand, which satisfies scan_runs_subject_chk, and its
// counters stay NULL because a decision not to scan measured no probes.
// Cardinality is bounded by the number of due schedules per cron tick.
//
// The tick itself also gets ONE row, phase 'tick', so a cron pass that looked
// and found nothing due is a measured zero rather than a silence. Readers that
// want executions filter `phase = 'tick'`; readers that want the skips filter
// `phase = 'schedule'`, exactly as the fleet's callers filter `phase <> 'idle'`.
// ---------------------------------------------------------------------------

/** The scheduler's two phases in scan_runs.phase. See the block comment above. */
export const SCHEDULER_PHASES = Object.freeze({
  TICK: "tick",
  SCHEDULE: "schedule",
});

/**
 * Why the scheduler declined a due schedule. Closed vocabulary here even though
 * migration 011 leaves `reason` free text: an unexplained skip is what this task
 * abolishes, and a typo'd reason is an unexplained skip wearing a label.
 */
export const SCHEDULER_SKIP_REASONS = Object.freeze({
  /** cadence flipped to 'off' while `enabled` still says true. */
  CADENCE_OFF: "cadence_off",
  /** a scan for this brand is already running — don't pile on. */
  BRAND_ALREADY_ACTIVE: "brand_already_active",
});

/** Why a whole tick closed the way it did. */
export const SCHEDULER_TICK_REASONS = Object.freeze({
  /** It looked and nothing was due. A MEASURED zero, not a silence. */
  NO_SCHEDULES_DUE: "no_schedules_due",
  /** Schedules were due and every one of them was declined. */
  ALL_DUE_SKIPPED: "all_due_skipped",
  /** The tick threw; the error is on the row and then rethrown. */
  TICK_FAILED: "scheduler_tick_failed",
});

const SCHEDULER_LOG = { label: "scheduler", what: "scheduler decision", noun: "scheduler" };

/**
 * One scan_runs row for one declined schedule, opened and closed together.
 *
 * Standing rule 2 applies to the OPEN: if the ledger cannot record the skip the
 * error propagates and the tick fails loudly, rather than the scheduler quietly
 * carrying on declining brands off the record — which is the state this whole
 * function exists to end.
 */
async function recordSchedulerSkip(ledger, { workerId, brand, reason, detail }) {
  const run = await openChunkRun(
    ledger,
    { runner: RUNNERS.SCHEDULER, phase: SCHEDULER_PHASES.SCHEDULE, workerId, brand, detail },
    { ...SCHEDULER_LOG, subject: `brand ${brand}` }
  );
  console.warn(
    `[scheduler] "${brand}" was due and was NOT scanned (${reason}). Recorded as a skipped ` +
      `scan_runs row — no scan job was created, so nothing else would have said so.`
  );
  // Counters stay NULL on purpose: a decision not to scan measured no probes,
  // and 0 here would claim it looked for some.
  await closeChunkRun(ledger, run, { outcome: RUN_OUTCOMES.SKIPPED, reason, detail }, SCHEDULER_LOG);
}

export async function runSchedulerTick(nowIso, deps = {}) {
  const listDue = deps.listDueSchedules || listDueSchedules;
  const hasActive = deps.hasActiveScanForBrand || hasActiveScanForBrand;
  const createJob = deps.createScanJob || createScanJob;
  const upsertSchedule = deps.upsertScanSchedule || upsertScanSchedule;
  const kickChunk = deps.runScanChunk || runScanChunk;

  const ledger = resolveChunkLedger(deps);
  // Identifies THIS tick, so the skip rows it wrote can be joined back to the
  // pass that wrote them (they share no job and no batch).
  const schedulerId = deps.schedulerId || `scheduler-${crypto.randomUUID()}`;

  const tickRun = await openChunkRun(
    ledger,
    {
      runner: RUNNERS.SCHEDULER,
      phase: SCHEDULER_PHASES.TICK,
      workerId: schedulerId,
      detail: { now: nowIso },
    },
    { ...SCHEDULER_LOG, what: "scheduler tick", noun: "tick", subject: `tick at ${nowIso}` }
  );

  const started = [];
  /** Every schedule this tick declined, with the reason it used to discard. */
  const skipped = [];
  let due = [];
  // NOT MEASURED until listDue actually returns. A tick that died inside the
  // query has no idea how many schedules were due, and `due: 0` on its row
  // would be a count it never took — the same lie the nullable counters exist
  // to prevent.
  let dueCount = null;

  try {
    due = await listDue(nowIso);
    dueCount = due.length;

    for (const schedule of due) {
      const brandLabel = schedule.display_name || schedule.brand;

      // Defensive: cadence 'off' should never fire a scan even if `enabled`
      // says otherwise (the two fields are independent columns; the P0.4
      // schedule editor that keeps them in sync doesn't exist yet).
      if (schedule.cadence === "off") {
        skipped.push({ brand: brandLabel, reason: SCHEDULER_SKIP_REASONS.CADENCE_OFF });
        await recordSchedulerSkip(ledger, {
          workerId: schedulerId,
          brand: brandLabel,
          reason: SCHEDULER_SKIP_REASONS.CADENCE_OFF,
          detail: { schedule_key: schedule.brand, cadence: schedule.cadence ?? null, now: nowIso },
        });
        continue;
      }

      if (await hasActive(brandLabel)) {
        // already running — don't pile on
        skipped.push({ brand: brandLabel, reason: SCHEDULER_SKIP_REASONS.BRAND_ALREADY_ACTIVE });
        await recordSchedulerSkip(ledger, {
          workerId: schedulerId,
          brand: brandLabel,
          reason: SCHEDULER_SKIP_REASONS.BRAND_ALREADY_ACTIVE,
          detail: { schedule_key: schedule.brand, cadence: schedule.cadence ?? null, now: nowIso },
        });
        continue;
      }

      const job = await createJob({
        brand: brandLabel,
        // scan_schedules.brand IS the resolveBrandKey() domain key (not a
        // display name) — reused as the `url` input so
        // resolveBrandKey(brandLabel, schedule.brand) re-derives that exact
        // same key. scan_schedules has no url/industry/competitors columns
        // (schema gap, not something P0.2 introduces): a scheduled re-scan
        // reuses the brand's EXISTING tracked prompt pool; industry/competitors
        // only matter if that pool is short, in which case generation falls
        // back to its own industry-pack heuristics with no industry hint.
        url: schedule.brand,
        industry: "",
        competitors: "",
      });

      // Bump the schedule BEFORE the fire-and-forget kick below (reviewer D7).
      // createJob has already durably enqueued the work, so if this instance
      // dies right after — including inside the kick itself — next_run_at must
      // already be advanced, or listDueSchedules keeps finding this schedule
      // "due" on every subsequent tick and piles up a fresh job each time. The
      // job just created is still recoverable on its own via the staleness
      // sweep even when the kick below never lands.
      await upsertSchedule(schedule.brand, {
        last_run_at: nowIso,
        next_run_at: computeNextRunAt(schedule.cadence, nowIso),
      });

      kickChunk(job.id).catch((err) => {
        console.error(`[scheduler] Chunk kick failed for job ${job.id} (brand ${brandLabel}):`, err.message);
      });
      started.push({ brand: brandLabel, job_id: job.id });
    }
  } catch (err) {
    // The tick's own row closes FAILED before the error leaves — a tick that
    // threw halfway through must not be indistinguishable from one that never
    // ran. The error still propagates: this records, it does not absorb.
    await closeChunkRun(
      ledger,
      tickRun,
      {
        outcome: RUN_OUTCOMES.FAILED,
        reason: SCHEDULER_TICK_REASONS.TICK_FAILED,
        error: err.message,
        detail: { due: dueCount, started: started.length, skipped: skipped.length, skips: skipped },
      },
      SCHEDULER_LOG
    );
    throw err;
  }

  // Three different ticks, three different rows. 'succeeded' started something;
  // 'noop' with no_schedules_due looked and found an empty queue; 'noop' with
  // all_due_skipped found work and declined every piece of it — which is the
  // one that used to be invisible, and the one an operator most needs to see.
  const detail = { due: dueCount, started: started.length, skipped: skipped.length, skips: skipped };
  const verdict = started.length
    ? { outcome: RUN_OUTCOMES.SUCCEEDED, reason: null }
    : {
        outcome: RUN_OUTCOMES.NOOP,
        reason: due.length ? SCHEDULER_TICK_REASONS.ALL_DUE_SKIPPED : SCHEDULER_TICK_REASONS.NO_SCHEDULES_DUE,
      };
  await closeChunkRun(ledger, tickRun, { ...verdict, detail }, SCHEDULER_LOG);

  // `skipped` is returned as well as ledgered so the cron route's response can
  // stop reporting an empty `started` as a clean tick (R3.2.3's read).
  return { started, skipped };
}
