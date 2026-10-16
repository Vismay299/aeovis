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
  // R3.3.2 — the reaper's TTL is IMPORTED, never retyped, so "how long without
  // a heartbeat means dead" has exactly one definition in this codebase.
  HEARTBEAT_STALE_MS,
  claimJobStatus,
  reclaimStaleFinalize,
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
  getScanSchedule,
  upsertScanSchedule,
  insertScanScheduleIfNotExists,
} from "../db/analytics.js";
import { generateUnbrandedPrompts, SEED_STATE } from "../scoring/promptGen.js";
// R3.7.2 — the vocabulary the scrape state is written in. Imported rather than
// retyped as "ok" so this file and firecrawl.js cannot drift apart silently.
import { SCRAPE_STATE } from "../firecrawl.js";
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
  describeEngineSetChange,
  ENGINE_SET_STATES,
  ENGINE_RESOLUTION_SKIPS,
  computeHeadline,
  summarizeEngineSlice,
  domainMatches,
  buildTrackedBrandRoster,
} from "../scoring/enginePipeline.js";
import { judgeBrandsSymmetric } from "../scoring/judge.js";
import { countBrandsElicited } from "../scoring/promptQuality.js";
import { toDateOnly, unionPromptCounts, buildMetricsRows } from "../analytics/rollup.js";
import { getPromptsForBrand, upsertPrompts } from "../db/prompts.js";
import { buildBrandedQueries, isBrandedQuery } from "../scoring/aioQueryClassify.js";
import { getBrandAliases } from "../scoring/aliases.js";
import { resolveBrandKey } from "../scoring/brandKey.js";
import { extractBrandDomain } from "../scoring/citations.js";
import { resolveSerpGeo } from "../engines/serpGeo.js";
import { keepAlive } from "../keepAlive.js";
import { productionAliasBase, warnSelfContinueResponse } from "../selfContinue.js";
import { enrichCitations } from "../analytics/citationEnrich.js";
import {
  openScanRun,
  heartbeatScanRun,
  closeScanRun,
  listStaleScanRuns,
  describeRun,
  RUN_OUTCOMES,
  RUNNERS,
} from "../scanRuns.js";
// R03.3a — the honest terminal collection outcome, derived from the persisted
// rows and never from how many rows the loop processed.
import { deriveScanOutcome, buildScorePlan } from "../scanOutcome.js";

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
  //
  // `scheduleRow` (R3.4.1) is null for the same reason again, and it is a THIRD
  // kind of null: only the sourcing phase registers a brand with the scheduler,
  // so a chunk that resumed straight into probing or finalize never touched
  // `scan_schedules` and must not claim an outcome for it. Once sourcing runs it
  // is one of SCHEDULE_ROW_STATES, never a boolean.
  return {
    probesAttempted: null,
    probesSucceeded: null,
    errorsRecovered: null,
    phases: [],
    skips: null,
    scheduleRow: null,
  };
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
  /**
   * The brand's own website was not read as Firecrawl content, so the prompt
   * set was grounded on less than it looks like (R3.7.2, finding B7).
   *
   * `degraded` (a crude HTML strip stood in for the vendor) and `unavailable`
   * (there was no content at all) both land here — the two are told apart by
   * the `state:state_reason` the sample carries, not by a second reason code.
   */
  WEBSITE_SCRAPE_DEGRADED: "website_scrape_degraded",
  /**
   * The PAA / autocomplete seeding leg did not deliver real Google queries, so
   * the prompt set is grounded in less observed search behaviour than it looks
   * like (R2.2.12, and R2.2.8 which produced the record this reads).
   *
   * NOT a new vocabulary: this is `detail.skips` on the chunk's single
   * scan_runs row, the same channel and the same shape as
   * WEBSITE_SCRAPE_DEGRADED above, with no column and no migration. It needs
   * its own REASON because the alternative is filing a seeding failure under a
   * name that says "website scrape", which would be a false statement about
   * which input went missing. `degraded`, `unavailable`, `not_attempted` and a
   * measured-zero `ok` all land here and are told apart by the
   * `state:state_reason` the sample carries, exactly as the scrape's are.
   */
  PROMPT_SEEDING_DEGRADED: "prompt_seeding_degraded",
  /**
   * The brand was scanned but its `scan_schedules` row could not be written
   * (R3.4.1, finding S14). The scan itself is unaffected; what is lost is the
   * brand's only registration with the scheduler, so without this reason the
   * brand goes back to being one that can never become due and nothing says so.
   */
  SCHEDULE_ENSURE_FAILED: "schedule_ensure_failed",
  /** Per-scan spend cap (SCAN_MAX_COST_PER_SCAN) exceeded. */
  SPEND_CAP_PER_SCAN: "spend_cap_per_scan",
  /** Daily spend cap (SCAN_MAX_COST_PER_DAY) exceeded. */
  SPEND_CAP_PER_DAY: "spend_cap_per_day",

  // The three below happen INSIDE resolveEnabledEngines, one layer earlier than
  // ENGINE_NOT_REGISTERED and before the checkpoint freeze. Their strings are
  // owned by enginePipeline (ENGINE_RESOLUTION_SKIPS) and aliased here rather
  // than retyped, so the resolver's vocabulary and `detail.skips` cannot drift.
  /** `ENGINES` named an engine that is not in the registry at all — a typo, or a removal. */
  ENGINE_UNKNOWN: ENGINE_RESOLUTION_SKIPS.UNKNOWN,
  /** A registered engine dropped because its API key is not set. */
  ENGINE_NOT_CONFIGURED: ENGINE_RESOLUTION_SKIPS.NOT_CONFIGURED,
  /** EVERY engine `ENGINES` asked for was dropped, so the set became the aio default. */
  ENGINE_SET_DEFAULTED: ENGINE_RESOLUTION_SKIPS.SET_DEFAULTED,
  /** A resolver drop this file has no reason for — recorded anyway, never discarded. */
  ENGINE_SKIP_UNMAPPED: "engine_skip_unmapped",
});

// ---------------------------------------------------------------------------
// R3.6.2 — Per-scan and per-day spend caps enforced from the ledger.
//
// The scan path had no cap at all: a scan could burn unbounded vendor budget
// across its probes. These two env vars (USD, parsed as floats) gate new
// spend in the probing loop. Fleet costs are included because the fleet
// writes `cost` into the same `stats` object that the chunk accumulates.
//
// Per-scan: SCAN_MAX_COST_PER_SCAN — checked against `stats.cost` before
//   each probe batch. When exceeded, remaining pairs are skipped with reason
//   `spend_cap_per_scan` and the scan proceeds to finalize with whatever
//   evidence it has.
//
// Per-day: SCAN_MAX_COST_PER_DAY — checked against the sum of `cost_total`
//   on scans created today (same UTC day). Prevents a queue of scans from
//   collectively blowing the daily budget. The query is cheap (one index
//   scan on scans.created_at) and runs once per chunk, before the loop.
//
// Unset or non-positive means "no cap". A cap of 0.00 would halt all spend
// immediately, which is intentional — an operator setting $0 wants silence.
// ---------------------------------------------------------------------------

/**
 * Resolve the per-scan spend cap from the environment. Returns null when
 * unset or non-positive (no cap).
 */
function resolvePerScanCap() {
  const raw = process.env.SCAN_MAX_COST_PER_SCAN;
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * Resolve the per-day spend cap from the environment. Returns null when
 * unset or non-positive (no cap).
 */
function resolvePerDayCap() {
  const raw = process.env.SCAN_MAX_COST_PER_DAY;
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * Sum cost_total on scans created today (UTC). Returns 0 when the DB is
 * not configured or the query fails — a read failure must not halt a scan
 * that hasn't spent anything yet.
 */
async function dailyScanSpendToday(deps = {}) {
  const queryFn = deps.queryScanCostToday || queryScanCostToday;
  try {
    return (await queryFn()) || 0;
  } catch {
    return 0;
  }
}

/**
 * Default implementation: one SQL sum over scans.created_at >= start of
 * today (UTC). Injected via deps for tests.
 */
async function queryScanCostToday() {
  // Lazy-import to avoid circular: this function is only called when a DB
  // client exists (deps.resolveClient returns non-null).
  try {
    const { getSupabaseClient } = await import("../db.js");
    const client = getSupabaseClient();
    if (!client) return 0;
    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    const { data, error } = await client
      .from("scans")
      .select("cost_total")
      .gte("created_at", `${today}T00:00:00Z`);
    if (error) return 0;
    return (data || []).reduce((sum, r) => sum + (Number(r.cost_total) || 0), 0);
  } catch {
    return 0;
  }
}

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
 * Turn one of resolveEnabledEngines' discards into a chunk skip reason (R3.2.2).
 *
 * The resolver reports what it dropped in its OWN vocabulary
 * (ENGINE_RESOLUTION_SKIPS); this is the only place that translates it. The
 * mapping is written out one branch per kind rather than passed through, for two
 * reasons: the guard test can walk it, and a pass-through would let a drop site
 * added to enginePipeline tomorrow land in `detail.skips` under a reason nobody
 * ever declared here.
 *
 * `engine_unknown` and `engine_not_configured` stay separate on purpose. Both
 * mean "this engine will not be probed and the headline is blended over the
 * rest", but the first is fixed by editing `ENGINES` and the second by setting a
 * key — and a single "engine dropped" reason tells an operator that something
 * went missing while withholding the only part that says what to do about it.
 *
 * An UNRECOGNISED kind is still recorded, under ENGINE_SKIP_UNMAPPED and with a
 * console.error. Refusing to record a skip because this file has no name for it
 * would be the exact failure R3.2.2 exists to end, wearing a guard clause.
 */
export function recordEngineResolutionSkip(tally, kind, engineName) {
  if (kind === ENGINE_RESOLUTION_SKIPS.UNKNOWN) {
    recordSkip(tally, CHUNK_SKIP_REASONS.ENGINE_UNKNOWN, engineName);
    return;
  }
  if (kind === ENGINE_RESOLUTION_SKIPS.NOT_CONFIGURED) {
    recordSkip(tally, CHUNK_SKIP_REASONS.ENGINE_NOT_CONFIGURED, engineName);
    return;
  }
  if (kind === ENGINE_RESOLUTION_SKIPS.SET_DEFAULTED) {
    recordSkip(tally, CHUNK_SKIP_REASONS.ENGINE_SET_DEFAULTED, engineName);
    return;
  }
  console.error(
    `[scan-chunk] resolveEnabledEngines reported an engine skip of kind "${kind}" that this file has ` +
      `no reason for — recording it as ${CHUNK_SKIP_REASONS.ENGINE_SKIP_UNMAPPED} so it is at least on ` +
      `the row. Give it a CHUNK_SKIP_REASONS entry.`
  );
  recordSkip(tally, CHUNK_SKIP_REASONS.ENGINE_SKIP_UNMAPPED, `${kind}: ${engineName}`);
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
    // R3.4.1 — what happened to this brand's `scan_schedules` row, in the one
    // place an operator already reads per chunk. 'created' / 'existing' /
    // 'failed' are three different facts (SCHEDULE_ROW_STATES) and null is a
    // fourth: this chunk never sourced, so it registered nothing and says so
    // rather than reporting a state it never reached. An unrecognised string
    // passes through VERBATIM instead of being nulled — a state this file has
    // no name for is still a state that happened, and rounding it to "not
    // measured" is the erasure standing rule 1 exists to stop.
    schedule_row: typeof tally.scheduleRow === "string" && tally.scheduleRow ? tally.scheduleRow : null,
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

    // R3.3.1 — the job has been resumed MAX_JOB_ATTEMPTS times without ever
    // finishing and has just been made terminal. 'failed', never 'skipped': the
    // chunk declined, but what it declined was a customer's scan, and a bucket
    // that reads as a normal decline is how an abandoned scan disappears
    // quietly. The counts go in the detail so the ledger says WHICH attempt was
    // the last one, and `error` carries the message the job now shows.
    case "max_attempts":
      return {
        outcome: RUN_OUTCOMES.FAILED,
        reason: "max_attempts",
        error: result.error ?? null,
        ...counts,
        detail: {
          ...detail,
          // Never `?? 0` here: a claim that did not report its count is unknown,
          // and "abandoned on attempt 0" would be a lie about the cap.
          attempts: Number.isInteger(result.attempts) ? result.attempts : null,
          max_attempts: Number.isInteger(result.max_attempts) ? result.max_attempts : null,
        },
      };

    // The attempt claim itself failed, so the chunk refused to run rather than
    // running uncounted. It ran and did not finish: 'failed'.
    case "attempt_claim_failed":
      return { outcome: RUN_OUTCOMES.FAILED, reason, error: result.error ?? null, ...counts, detail };

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
export function resolvePromptTarget(override) {
  const candidate = override != null ? override : process.env.PROMPT_TARGET;
  const raw = typeof candidate === "number" ? candidate : Number.parseInt(String(candidate || ""), 10);
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

  const promptKey = deps.brandKey || resolveBrandKey(brand, url);

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
  if (!deps.brandKey && (dbPrompts || []).length === 0 && promptKey !== queryTextKey(brand)) {
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

// ---------------------------------------------------------------------------
// R3.3.1 — the attempt cap (finding S12)
// ---------------------------------------------------------------------------
//
// The sweep in /api/scan/worker re-dispatches every non-terminal job whose
// heartbeat has gone stale, and nothing counted how often it had already done
// so. A job whose worker dies at the same point every time — a finalize that
// outruns maxDuration, a container killed mid-probe — was therefore resumed
// forever, every cron tick, every day, spending real vendor budget on an
// execution that has never once finished, while the row sat in 'probing'
// looking like work in progress.
//
// The chunk's own catch already fails a job when the failure is an exception it
// survives to handle. This is for the other kind: the process that never comes
// back to write anything, so the record of that attempt has to be made when the
// NEXT attempt starts.
//
// WHAT IS COUNTED. Resumes of a job whose previous executor went away — NOT
// chunks. A scan is deliberately many chunks (CHUNK_TIME_BUDGET_MS makes a long
// probe set yield and self-continue), so counting every chunk would cap the SIZE
// of a scan at three slices and kill healthy scans. runScanChunk asks for an
// attempt only when shouldRescueJob(job) is true at entry, which is exactly "the
// last executor stopped saying it was alive"; a clean hand-off arrives on a
// heartbeat seconds old and costs nothing.
//
// AND IT IS RESET BY PROGRESS. runProbingPhase writes attempts = 0 in the same
// UPDATE that persists a batch of probe results, so the cap counts CONSECUTIVE
// resumes that achieved nothing. That does not restore the infinite retry:
// progress is monotone and bounded (each (engine, query) pair is probed at most
// once per job), so a job can only reset the counter as many times as it has
// pairs left and must then either finalize or hit the cap.
//
// Migration 012 owns the column, the cap and the terminal write.

/**
 * How many consecutive resumes a job gets before it is abandoned.
 *
 * Must equal `p_max_attempts`'s DEFAULT in supabase/migrations/012_scan_job_attempts.sql;
 * a guard test in scanJobAttempts.test.mjs reads the migration and asserts it.
 */
export const MAX_JOB_ATTEMPTS = 3;

/**
 * The marker every abandonment message starts with, in SQL and in JS alike, so
 * "why did this scan stop" is greppable in one query and one log search rather
 * than being inferred from a status of 'failed' and no explanation.
 */
export const MAX_ATTEMPTS_MARKER = "max_attempts:";

/**
 * The cap decision, as a pure function. Mirrors the two IFs in
 * claim_scan_job_attempt; exported so the policy is testable without a database.
 *
 * A missing/NaN `attempts` counts as 0 — a job that predates the column has
 * genuinely not been resumed since the cap existed, and reading it as "unknown,
 * therefore refuse" would abandon every in-flight scan the moment 012 lands.
 */
export function attemptVerdict(job, maxAttempts = MAX_JOB_ATTEMPTS) {
  const cap = Number.isInteger(maxAttempts) && maxAttempts >= 1 ? maxAttempts : MAX_JOB_ATTEMPTS;
  const prior = Number.isInteger(job && job.attempts) && job.attempts > 0 ? job.attempts : 0;
  if (prior >= cap) {
    return { granted: false, verdict: "max_attempts", attempts: prior, maxAttempts: cap };
  }
  return { granted: true, verdict: "granted", attempts: prior + 1, maxAttempts: cap };
}

/**
 * The sentence an abandoned job carries in `error_message`, for the in-memory
 * path. The SQL builds its own (it knows `now()` and the row it locked); both
 * start with MAX_ATTEMPTS_MARKER and both name the count and the cap, because
 * this string is what /api/scan/[job_id]/status hands the customer's browser.
 */
export function maxAttemptsMessage(job, verdict, nowIso = new Date().toISOString()) {
  const last = String((job && job.error_message) || "").trim();
  return (
    `${MAX_ATTEMPTS_MARKER} abandoned at ${nowIso} after ${verdict.attempts} resume attempt(s) ` +
    `without finishing (cap ${verdict.maxAttempts}). It was last seen in status ` +
    `"${(job && job.status) || "unknown"}" with heartbeat ${(job && job.heartbeat_at) || "never"}.` +
    (last ? ` Last recorded error: ${last}` : "")
  );
}

/** `deps.client` is test-only injection, matching db.js, jobLease.js and scanRuns.js. */
function resolveAttemptClient(deps) {
  return deps && Object.prototype.hasOwnProperty.call(deps, "client") ? deps.client : supabase;
}

/**
 * Take one attempt on `job`, or be refused.
 *
 * WITH A DATABASE this is migration 012's claim_scan_job_attempt: the read, the
 * increment, the cap and the terminal write happen inside one transaction under
 * one row lock, so two rescues racing each other cannot both spend the same
 * attempt and a job can never be both refused and left running.
 *
 * WITHOUT ONE (local dev, `npm run test:scoring` — db.js runs the whole
 * persistence layer out of global.memoryJobs) the same policy runs against the
 * job we already read. That path is read-then-write and therefore not atomic;
 * it is also single-process by construction, which is the same trade jobLease.js
 * and claimJobStatus already make for memory mode.
 *
 * NEVER FAIL-SOFT (standing rule 2). A database error propagates and a verdict
 * that does not say `granted` is refused rather than assumed: the caller must
 * not run a chunk on the strength of a claim that did not answer.
 */
async function claimJobAttempt(jobId, job, deps = {}) {
  const maxAttempts = Number.isInteger(deps.maxJobAttempts) ? deps.maxJobAttempts : MAX_JOB_ATTEMPTS;
  const client = resolveAttemptClient(deps);

  if (client) {
    const { data, error } = await client.rpc("claim_scan_job_attempt", {
      p_job_id: jobId,
      p_max_attempts: maxAttempts,
    });
    if (error) {
      // The envelope survives the rethrow (standing rule 2): a caller debugging
      // "column attempts does not exist" needs the code, not a flattened string.
      const err = new Error(
        `claim_scan_job_attempt: ${error.message || "database error"}` +
          (error.code ? ` [${error.code}]` : "") +
          (error.details ? ` — ${error.details}` : "") +
          (error.hint ? ` (hint: ${error.hint})` : "") +
          ` — if the function or the scan_jobs.attempts column is missing, ` +
          `supabase/migrations/012_scan_job_attempts.sql has not been applied to this database`
      );
      err.code = error.code;
      err.details = error.details;
      err.hint = error.hint;
      err.cause = error;
      throw err;
    }
    if (!data || typeof data.granted !== "boolean") {
      throw new Error(
        `claim_scan_job_attempt returned no verdict for job ${jobId} (${JSON.stringify(data ?? null)}). ` +
          `Refusing to treat an unanswered claim as a granted attempt — that is how a job with no ` +
          `attempts left gets resumed anyway.`
      );
    }
    return {
      granted: data.granted,
      verdict: data.verdict || (data.granted ? "granted" : "refused"),
      // null, not 0: an attempt count the claim did not report is unknown.
      attempts: Number.isInteger(data.attempts) ? data.attempts : null,
      maxAttempts: Number.isInteger(data.max_attempts) ? data.max_attempts : maxAttempts,
      status: data.status || null,
      errorMessage: data.error_message || null,
    };
  }

  const updateJob = deps.updateScanJob || updateScanJob;
  const verdict = attemptVerdict(job, maxAttempts);
  if (!verdict.granted) {
    const message = maxAttemptsMessage(job, verdict);
    await updateJob(jobId, { status: "failed", progress_pct: 100, error_message: message });
    return { ...verdict, status: "failed", errorMessage: message };
  }
  // updateScanJob stamps heartbeat_at on every call, which is what stops a
  // browser polling the status route every two seconds from being handed three
  // attempts in six seconds. The SQL path stamps it for the same reason.
  await updateJob(jobId, { attempts: verdict.attempts });
  return { ...verdict, status: (job && job.status) || null, errorMessage: null };
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
    // R3.1.13: on production the alias, never the SSO-protected deployment URL.
    productionAliasBase(process.env) ||
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "") ||
    `http://localhost:${process.env.PORT || 3000}`;
  if (!base) return null;
  return `${base.replace(/\/$/, "")}/api/scan/worker?job_id=${encodeURIComponent(jobId)}`;
}

/** R3.1.5 — how long a chunk keeps its instance alive for the self-continue request to go out. */
export const SELF_CONTINUE_HOLD_MS = 5000;

/**
 * The headers the self-continue request must carry, and why each one exists.
 *
 * TWO DIFFERENT GATES, and only one of them is this app's:
 *  - `x-cron-secret` authenticates to the WORKER ROUTE (reviewer D4). Without
 *    it the route answers 401 and the chunk stops advancing.
 *  - `x-vercel-protection-bypass` gets PAST DEPLOYMENT PROTECTION, which sits
 *    in front of the function. R3.1.6: with Vercel Authentication on
 *    (ssoProtection `all_except_custom_domains` on this project), a self-fetch
 *    to the deployment URL is answered by an SSO redirect and the next chunk
 *    never starts — observed in production on 2026-09-15, where a scan sat
 *    6 minutes between chunks until a browser poll rescued it. The cron secret
 *    cannot help there: the request never reaches the route that reads it.
 *    Vercel exposes VERCEL_AUTOMATION_BYPASS_SECRET to the deployment when
 *    Protection Bypass for Automation is enabled.
 *
 * Returns `{ init, missingBypass }`. `missingBypass` is true only where it is
 * a real risk — on Vercel, with no bypass secret — so the caller can say so
 * once instead of this function guessing about local dev.
 *
 * @param {object} [env]
 */
export function buildSelfContinueInit(env = process.env) {
  const headers = {};
  const secret = (env.CRON_SECRET || "").trim();
  if (secret) headers["x-cron-secret"] = secret;
  const bypass = (env.VERCEL_AUTOMATION_BYPASS_SECRET || "").trim();
  if (bypass) headers["x-vercel-protection-bypass"] = bypass;
  return {
    init: Object.keys(headers).length ? { headers } : undefined,
    missingBypass: !bypass && !!env.VERCEL,
  };
}

function defaultSelfContinue(jobId) {
  const url = resolveSelfContinueUrl(jobId);
  if (!url) return;
  const { init, missingBypass } = buildSelfContinueInit();
  if (missingBypass) {
    console.warn(
      `[scan-chunk] self-continue for job ${jobId} is going out WITHOUT a protection bypass ` +
        `(VERCEL_AUTOMATION_BYPASS_SECRET is unset). If Deployment Protection is on, this request is ` +
        `refused before it reaches the worker and the scan advances only on a poll or cron rescue.`
    );
  }
  try {
    // R3.1.5: hold the instance just long enough for the request to leave.
    // Waiting for the response would bill this function for the whole next
    // chunk; not waiting at all let a freeze drop the request unsent.
    keepAlive(
      fetch(url, { ...init, redirect: "manual" })
        .then((response) => warnSelfContinueResponse(response, { label: "scan-chunk", jobId }))
        .catch((err) => {
        console.warn(
          `[scan-chunk] Self-continue fetch failed for job ${jobId} (poll/cron rescue will still pick it up): ${err.message}`
        );
      }),
      { label: `[scan-chunk] self-continue for job ${jobId}`, maxMs: SELF_CONTINUE_HOLD_MS }
    );
  } catch (err) {
    console.warn(`[scan-chunk] Self-continue fetch could not be started for job ${jobId}: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Phase 1 — sourcing (runs once per job, first chunk that has no checkpoint yet)
// ---------------------------------------------------------------------------

/**
 * What `ensureScanScheduleRow` did. Three OUTCOMES, never a boolean: "the row
 * was already there" and "we wrote it" and "we could not write it" are three
 * different facts about a brand's registration with the scheduler, and the
 * chunk's ledger row has to keep them apart (standing rule 1).
 *
 * The outcome rides the tally as `scheduleRow` and lands on the chunk's single
 * `scan_runs` row as `detail.schedule_row` (chunkRunOutcome). NOT on the
 * checkpoint: the checkpoint is what a RESUMING chunk reads to redo nothing,
 * and sourcing — the only phase that registers a brand — runs exactly once per
 * job, so a later chunk has no use for this and would only be able to repeat
 * it. `detail.schedule_row: null` on a probing-only chunk is therefore honest
 * ("never sourced"), where a checkpoint field would have to be carried forward
 * as a stale copy of the first chunk's answer.
 */
export const SCHEDULE_ROW_STATES = Object.freeze({
  /** No row existed; this scan wrote the brand's first one. */
  CREATED: "created",
  /** A row was already there and was left EXACTLY as the operator left it. */
  EXISTING: "existing",
  /** The read or the write threw. Counted and named on the run, never silent. */
  FAILED: "failed",
});

/**
 * R3.4.1 (finding S14) — THE BRAND THAT COULD NEVER BECOME DUE.
 *
 * `POST /api/scan` (src/app/api/scan/route.js) is the only path that creates a
 * brand's FIRST scan, and it wrote no `scan_schedules` row. `upsertScanSchedule`
 * was called from exactly two places — `runSchedulerTick` (which only ever sees
 * schedules `listDueSchedules` already returned, i.e. rows that exist) and the
 * manual `PUT /api/brands/[brand]/schedule`. So a brand nobody had hand-edited a
 * schedule for had no row at all, `listDueSchedules` could never return it, and
 * it could never be rescanned. This is the registration.
 *
 * R3.4.5 — ATOMIC SINGLE WRITE. The original implementation used a
 * get-then-upsert pattern: `getScanSchedule` returned null, then
 * `upsertScanSchedule` wrote the row. Between the two calls an operator could
 * PUT `enabled: true` on the brand, and the upsert would clobber it back to
 * `enabled: false` with `next_run_at` null. The fix: a single
 * `INSERT ... ON CONFLICT DO NOTHING` (`insertScanScheduleIfNotExists`), which
 * makes the decision to insert-or-skip atomically in the database. There is no
 * window for a concurrent edit to be lost.
 *
 * OPT-IN, NOT OPT-OUT. `enabled` is written EXPLICITLY false. The DB column
 * default is `true` (supabase/migrations/005_analytics_platform.sql:88) but the
 * PRODUCT default is false — see the GET fallback in
 * src/app/api/brands/[brand]/schedule/route.js's `defaultSchedule` and the
 * `applyInsertDefaults` guard in src/lib/brandAnalyticsApi.js, which exists for
 * this exact reason on the PUT path. Taking the column default here would
 * auto-enrol every brand that ever ran one free scan into recurring paid
 * rescans, and — with `next_run_at` NULL reading as immediately due
 * (`isDueSchedule`) — would fire them on the very next cron tick. Registering a
 * brand is not the same as consenting to rescan it.
 *
 * AN EXISTING ROW IS NEVER TOUCHED. Not `enabled`, not `cadence`, not
 * `next_run_at`, not even `last_run_at`: that row is operator-owned state, and a
 * manual scan silently sliding someone's cadence forward is a worse bug than the
 * one this fixes. Only the scheduler's own run bumps the clock fields
 * (`runSchedulerTick`, below).
 *
 * A FAILURE IS ABSORBED BUT NOT HIDDEN. The scan's own results are already paid
 * for and still worth finishing, so a schedule write that throws does not kill
 * the job — but it is counted (`errors_recovered`) AND named
 * (`SCHEDULE_ENSURE_FAILED`) on the chunk's `scan_runs` row, the same treatment
 * the prompt-persist failure below gets. A brand that quietly failed to register
 * is precisely the state S14 describes, so it must never be indistinguishable
 * from one that registered.
 *
 * @param {string} promptKey resolveBrandKey() output — `scan_schedules.brand`
 *   IS this key, not a display name (see runSchedulerTick's note).
 * @returns {Promise<string>} one of SCHEDULE_ROW_STATES.
 */
export async function ensureScanScheduleRow(promptKey, displayName, deps = {}, tally = {}, nowIso = new Date().toISOString()) {
  const insertIfNotExists = deps.insertScanScheduleIfNotExists || insertScanScheduleIfNotExists;

  if (!promptKey) {
    bumpCount(tally, "errorsRecovered");
    recordSkip(tally, CHUNK_SKIP_REASONS.SCHEDULE_ENSURE_FAILED, "no brand key to register under");
    console.warn("[scan-chunk] No brand key available — this scan registered no scan_schedules row.");
    return SCHEDULE_ROW_STATES.FAILED;
  }

  try {
    // R3.4.5 — Single atomic write. `insertScanScheduleIfNotExists` issues
    // INSERT ... ON CONFLICT DO NOTHING: the database decides insert-vs-skip
    // in one statement with no window for a concurrent operator edit to be
    // clobbered. Returns the inserted row (CREATED) or null (EXISTING).
    const inserted = await insertIfNotExists({
      brand: promptKey,
      display_name: displayName || promptKey,
      // Explicit. See the opt-in note above; this must not fall through to the
      // column default.
      enabled: false,
      // Explicit for the same reason: an unscheduled row must not inherit
      // anything that reads as "due".
      next_run_at: null,
      last_run_at: nowIso,
    });

    if (inserted) {
      console.log(
        `[scan-chunk] Registered scan_schedules row for "${promptKey}" (enabled: false — scheduling is opt-in).`
      );
      return SCHEDULE_ROW_STATES.CREATED;
    }
    return SCHEDULE_ROW_STATES.EXISTING;
  } catch (err) {
    bumpCount(tally, "errorsRecovered");
    recordSkip(tally, CHUNK_SKIP_REASONS.SCHEDULE_ENSURE_FAILED, `${promptKey}: ${err.message}`);
    console.warn(
      `[scan-chunk] Could not register a scan_schedules row for "${promptKey}" (${err.message}) — ` +
        `the scan continues, but this brand is still invisible to the scheduler. ` +
        `Recorded on the run as ${CHUNK_SKIP_REASONS.SCHEDULE_ENSURE_FAILED}.`
    );
    return SCHEDULE_ROW_STATES.FAILED;
  }
}

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
  const promptKey = job.brand_key || resolveBrandKey(brand, url);
  const stats = { cost: 0, tokens: 0 };

  // R3.4.4 — Worker honors per-brand prompt_target, engines and geo from the
  // brand's scan_schedules row, falling back to global env only when absent.
  const getSchedule = deps.getScanSchedule || getScanSchedule;
  let schedule = null;
  if (promptKey) {
    try {
      schedule = await getSchedule(promptKey, deps);
    } catch {
      // transient read failure or unconfigured — fall back to env
    }
  }

  const promptTarget = deps.promptTarget || resolvePromptTarget(schedule?.prompt_target);
  const enginesConfig = schedule?.engines || undefined;
  const geo = resolveSerpGeo(schedule?.geo);

  const {
    queries: unbrandedQueries,
    newlyGenerated,
    prompt_source: promptSource,
    static_pack_prompts: staticPackPrompts,
  } = await sourceQueries(brand, url, industry, stats, brandAliases, { ...deps, promptTarget, brandKey: job.brand_key });

  // R3.4.1 — register the brand with the scheduler. Here and not in
  // POST /api/scan because this is the one place per job where the canonical
  // schedule key already exists: `promptKey` is the resolveBrandKey() output
  // that IS `scan_schedules.brand` (see runSchedulerTick), and it is resolved
  // once, on the first chunk, whatever kicked the job off.
  //
  // The outcome is PUT ON THE TALLY, not dropped. A local `const` nobody read
  // would have made "this brand registered for the first time", "it was already
  // registered" and "we failed to register it" all look identical from outside
  // this stack frame — the same disappearance S14 is about, one level up.
  // chunkRunOutcome writes it to `detail.schedule_row` on this chunk's
  // scan_runs row. The FAILED case is additionally a named skip + an
  // errors_recovered bump (inside the helper), because that one is not merely
  // information: it is work this chunk decided to carry on without.
  tally.scheduleRow = await ensureScanScheduleRow(promptKey, brand, deps, tally);

  // R3.7.2 (finding B7) — THE WEBSITE SCRAPE THAT DEGRADED AND SAID SO ONLY IN A LOG.
  //
  // promptGen/prompts write the scrape's state onto `stats` (the mutable
  // accumulator this phase already threads through the call for cost/tokens).
  // Until this block existed the worker copied only { cost, tokens } out of that
  // object, so `website_scrape` died in this stack frame and the sole surviving
  // trace of "we never actually read the brand's site" was a console.warn — the
  // exact defect B7 names. Recorded here, it rides the chunk's single scan_runs
  // row in `detail.skips` like every other skip; no migration, no new column.
  //
  // ABSENT IS NOT DEGRADED. `stats.website_scrape` is undefined when no scrape
  // was ever attempted — the reuse path in sourceUnbrandedQueries returns a
  // full tracked pool without calling generation at all. Recording a degrade
  // there would assert a measurement that never happened, which is the same
  // class of lie in the opposite direction (standing rule 1). That case stays
  // silent here and is already named by `prompt_source` on the scan.
  const websiteScrape = stats.website_scrape;
  if (websiteScrape && websiteScrape.state !== SCRAPE_STATE.OK) {
    // NOT `?? 0`. summarizeScrape returns content_chars: null when there was no
    // result to measure, and 0 when we fetched and the page was genuinely
    // empty. Those are different facts and the ledger has to keep them apart
    // (standing rule 5), so the unmeasured case says so in words.
    const chars = Number.isFinite(websiteScrape.content_chars)
      ? websiteScrape.content_chars
      : "not_measured";
    recordSkip(
      tally,
      CHUNK_SKIP_REASONS.WEBSITE_SCRAPE_DEGRADED,
      `${websiteScrape.state}:${websiteScrape.state_reason || "unspecified"} chars=${chars}`
    );
    console.warn(
      `[scan-chunk] "${brand}" website scrape is ${websiteScrape.state} ` +
        `(${websiteScrape.state_reason || "unspecified"}) with ${chars} chars of site content — ` +
        `these prompts are grounded on the brand name and industry alone. ` +
        `Recorded on the run as ${CHUNK_SKIP_REASONS.WEBSITE_SCRAPE_DEGRADED}.`
    );
  }

  // R2.2.12 — THE SEEDING VERDICT THAT NEVER LEFT THE PROCESS.
  //
  // R2.2.8 built `stats.prompt_seeding` (state / state_reason / seed_queries /
  // per-leg failures) and said so in its own code comment: it had NO production
  // reader. The block above existed for `stats.website_scrape`, the checkpoint
  // allowlist below carried that field, and the seeding verdict got neither —
  // so a scan grounded in 30 real Google queries and one grounded in zero,
  // because the Bright Data zone was dead, produced identical scan_runs rows
  // and the fact did not survive a resume. This is the reader.
  //
  // ABSENT IS NOT DEGRADED, same as the scrape above: `stats.prompt_seeding` is
  // undefined when generation never ran (the reuse path in
  // sourceUnbrandedQueries returns a full tracked pool), and filing a degrade
  // there would assert a measurement nobody took.
  const promptSeeding = stats.prompt_seeding;
  if (
    promptSeeding &&
    // The SAME predicate promptGen warns on, taken from the source of truth
    // rather than re-derived: not-ok, or ok-but-zero. The second disjunct is why
    // this is not `state !== OK` — every fetch succeeding and Google returning
    // nothing is a MEASURED zero, but the prompt set is ungrounded either way,
    // and `ok:no_seed_queries_returned queries=0` in the sample is what keeps
    // that case readable as a measured zero rather than a failure.
    (promptSeeding.state !== SEED_STATE.OK || promptSeeding.seed_queries === 0)
  ) {
    // NOT `?? 0`. A record from an older checkpoint shape can be missing the
    // count entirely, and "we did not record how many" is not "we got none"
    // (standing rule 5).
    const queries = Number.isFinite(promptSeeding.seed_queries)
      ? promptSeeding.seed_queries
      : "not_measured";
    const attempted = Number.isFinite(promptSeeding.terms_attempted)
      ? promptSeeding.terms_attempted
      : "not_measured";
    const seeded =
      Number.isFinite(promptSeeding.terms_attempted) && Number.isFinite(promptSeeding.terms_unseeded)
        ? promptSeeding.terms_attempted - promptSeeding.terms_unseeded
        : "not_measured";
    recordSkip(
      tally,
      CHUNK_SKIP_REASONS.PROMPT_SEEDING_DEGRADED,
      `${promptSeeding.state}:${promptSeeding.state_reason || "unspecified"} ` +
        `queries=${queries} terms=${seeded}/${attempted}`
    );
    console.warn(
      `[scan-chunk] "${brand}" PAA/autocomplete seeding is ${promptSeeding.state} ` +
        `(${promptSeeding.state_reason || "unspecified"}) with ${queries} real Google queries ` +
        `from ${seeded}/${attempted} seed terms — these prompts are ` +
        `${queries === 0 ? "not" : "only partly"} grounded in observed search behaviour. ` +
        `Recorded on the run as ${CHUNK_SKIP_REASONS.PROMPT_SEEDING_DEGRADED}.`
    );
  }

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

  // R3.2.2 — THE ENGINE SKIP THAT HAPPENS BEFORE THE FREEZE.
  //
  // `engines` on the checkpoint below is the POST-drop list, and it is what
  // every later phase reads. So an engine `ENGINES` asked for and did not get —
  // a name with a typo in it, a key that was never set — is invisible from the
  // instant this line returns: absent from the checkpoint, absent from the probe
  // loop, absent from the finalize slice, and absent from the scan's own
  // engines_counted. runProbingPhase's ENGINE_NOT_REGISTERED check cannot see it
  // either; that check compares the FROZEN names against the registry, and these
  // names never made it into the frozen list.
  //
  // resolveEnabledEngines used to compute exactly this set and push it onto a
  // local array no caller read. It surrenders it now, and here — before the
  // freeze — is the last moment at which recording it is possible at all.
  const enabledEngineNames = resolveEngines({
    engines: enginesConfig,
    onSkip: (kind, engineName) => recordEngineResolutionSkip(tally, kind, engineName),
  }).map((e) => e.name);

  return {
    brand,
    url,
    industry,
    competitors,
    competitors_raw: competitorsRaw,
    prompt_key: promptKey,
    brand_key: job.brand_key || null,
    prompt_source: promptSource,
    static_pack_prompts: staticPackPrompts,
    queries,
    unbranded_texts: unbrandedQueries.map((q) => q.text.toLowerCase().trim()),
    engines: enabledEngineNames,
    geo,
    prompt_target: promptTarget,
    // R3.7.2 — `website_scrape` rides the checkpoint alongside cost/tokens so a
    // chunk that resumes into probing or finalize can still see that this
    // scan's prompts were built without the site. `?? null` is not a metric
    // being defaulted: null here means "sourcing recorded no scrape state",
    // which is a fact, and the field's own content_chars keeps its own
    // null-vs-zero distinction untouched.
    stats: {
      cost: stats.cost || 0,
      tokens: stats.tokens || 0,
      // R3.6.8 — carried through the checkpoint so finalize can persist it.
      cost_unmeasured_calls: stats.cost_unmeasured_calls || 0,
      website_scrape: stats.website_scrape ?? null,
      // R2.2.12 — the seeding verdict rides the same allowlist for the same
      // reason: this object is an allowlist, so a field nobody adds here is a
      // field that dies at the end of this chunk. `?? null` is not a metric
      // being defaulted; null means "sourcing recorded no seeding state", and
      // the record's own seed_queries keeps its own zero-vs-absent distinction.
      prompt_seeding: stats.prompt_seeding ?? null,
    },
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

  const { brand, url, competitors, queries, prompt_key: promptKey, geo: checkpointGeo } = checkpoint;
  const geo = checkpointGeo || resolveSerpGeo();
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

  // R3.2.5 — THE SAME TWO EVENTS, ON THE CHECKPOINT, SO THE SCAN CAN SAY SO.
  //
  // Everything above records these two drops in the run ledger, which is where
  // R3.2.2 left them: an operator reading scan_runs can see them, and the scan
  // record itself still carries nothing. So the headline moved (blended over
  // fewer engines, or over a set the scan was never frozen with),
  // scans.engines_counted fell, and the reason lived in a table no dashboard
  // reads.
  //
  // Recorded HERE and not only at finalize because the event is a MID-RUN one
  // and a chunked scan can outlive it: an engine that vanished during chunk 2
  // and came back by chunk 5 really did stop being probed for chunk 2's pairs,
  // and a finalize-time registry check would find nothing and report a clean
  // scan. Riding the checkpoint makes it sticky across chunks — `priorDropped`
  // below is what an earlier chunk already saw — and the checkpoint is
  // persisted with every probe batch and handed to finalize in-process, so it
  // survives both a resume and a chunk that had no batches left to write.
  //
  // The happy path stays clean: describeEngineSetChange returns null when every
  // frozen engine still resolves, and a null adds NO key to the checkpoint.
  const engineSetChange = describeEngineSetChange({
    frozen: frozenNames,
    registered: allEngineDefs.map((e) => e.name),
    // Probing does not know which rows are persisted; finalize does and passes
    // them. `probed` is deliberately omitted rather than guessed at.
    priorDropped: (checkpoint.engine_set_change?.dropped_engines || []).map((e) => e.engine),
    priorSubstituted: [
      ...(checkpoint.engine_set_change?.substituted_engines || []).map((e) => e.engine),
      // The fallback above IS the substitution: this chunk is about to probe
      // today's set in place of the frozen one.
      ...(frozenNames && filtered.length === 0 ? allEngineDefs.map((e) => e.name) : []),
    ],
  });
  if (engineSetChange) {
    console.warn(
      `[scan-chunk] Job ${jobId}: engine set ${engineSetChange.state} — ${engineSetChange.title}. ` +
        `Carried on the checkpoint so the finalized scan record says so, not just the run ledger.`
    );
  }

  const completed = await getCompletedPairs(jobId);
  const totalPairs = Math.max(queries.length * engineDefs.length, 1);
  let doneCount = completed.size;

  // R3.6.8 — cost_unmeasured_calls carried from the checkpoint so it can be
  // persisted to the scan row, distinguishing a genuinely free run from one
  // where nothing could be priced.
  const stats = {
    cost: checkpoint.stats?.cost || 0,
    tokens: checkpoint.stats?.tokens || 0,
    cost_unmeasured_calls: checkpoint.stats?.cost_unmeasured_calls || 0,
  };
  let workingCheckpoint = engineSetChange
    ? { ...checkpoint, engine_set_change: engineSetChange }
    : checkpoint;
  let progressPct = Math.min(85, 25 + Math.round((doneCount / totalPairs) * 60));

  // R3.6.2 — spend caps resolved once per chunk, before the probe loop.
  const perScanCap = resolvePerScanCap();
  const perDayCap = resolvePerDayCap();
  let dailySpend = perDayCap != null ? await dailyScanSpendToday(deps) : 0;
  let spendCapReached = null; // string reason once a cap halts new spend

  for (const engine of engineDefs) {
    const pending = queries.filter((q) => !completed.has(`${engine.name}|${q.text}`));

    for (let i = 0; i < pending.length; i += engine.concurrency) {
      // R3.6.2 — check spend caps before starting a new batch. Once a cap
      // is reached, every remaining batch in this chunk (and every engine
      // after this one) is skipped — the scan proceeds to finalize with
      // whatever evidence it has.
      if (spendCapReached) {
        recordSkip(tally, spendCapReached, `remaining pairs skipped`);
        break;
      }
      if (perScanCap != null && stats.cost >= perScanCap) {
        spendCapReached = CHUNK_SKIP_REASONS.SPEND_CAP_PER_SCAN;
        console.warn(
          `[scan-chunk] Job ${jobId}: per-scan spend cap $${perScanCap.toFixed(4)} reached ` +
            `(current $${stats.cost.toFixed(4)}). Halting new spend.`
        );
        recordSkip(tally, spendCapReached, `cost=$${stats.cost.toFixed(4)} cap=$${perScanCap.toFixed(4)}`);
        break;
      }
      if (perDayCap != null && dailySpend >= perDayCap) {
        spendCapReached = CHUNK_SKIP_REASONS.SPEND_CAP_PER_DAY;
        console.warn(
          `[scan-chunk] Job ${jobId}: daily spend cap $${perDayCap.toFixed(4)} reached ` +
            `(rolling $${dailySpend.toFixed(4)}). Halting new spend.`
        );
        recordSkip(tally, spendCapReached, `daily=$${dailySpend.toFixed(4)} cap=$${perDayCap.toFixed(4)}`);
        break;
      }

      const batch = pending.slice(i, i + engine.concurrency);

      const batchResults = await Promise.all(
        batch.map((query) => engine.probe(query, brand, brandAliases, brandDomain, competitors, stats, { geo }))
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
      // R3.7.2 — this rebuild used to be a fresh { cost, tokens } literal, which
      // ERASED the sourcing phase's `website_scrape` from the checkpoint on the
      // first persisted batch. Carried forward explicitly; the local `stats`
      // here only ever accumulates probe cost, so the value has to come from the
      // checkpoint it was frozen onto.
      workingCheckpoint = {
        ...workingCheckpoint,
        stats: {
          cost: stats.cost || 0,
          tokens: stats.tokens || 0,
          // R3.6.8 — carried forward for the same reason as website_scrape: the
          // local `stats` here only accumulates probe cost, so the sourcing
          // phase's value has to come from the checkpoint it was frozen onto, or
          // the first persisted batch erases it.
          cost_unmeasured_calls: stats.cost_unmeasured_calls || 0,
          website_scrape: workingCheckpoint.stats?.website_scrape ?? null,
          // R2.2.12 — carried forward for the same reason as website_scrape: the
          // local `stats` here only accumulates probe cost, so the sourcing
          // phase's value has to come from the checkpoint it was frozen onto, or
          // the first persisted batch erases it.
          prompt_seeding: workingCheckpoint.stats?.prompt_seeding ?? null,
        },
      };
      // R3.3.1 — `attempts: 0` rides on the same UPDATE as the batch that just
      // landed, so the attempt cap counts CONSECUTIVE resumes that achieved
      // nothing rather than the number of slices a big scan legitimately takes.
      // It is written here and nowhere else: this is the one place in the job's
      // life where forward progress is DURABLE (the pairs above are persisted
      // and getCompletedPairsForJob will never probe them again), and a reset
      // written anywhere that had not yet persisted anything would hand a poison
      // job an unlimited supply of attempts.
      await updateJob(jobId, { progress_pct: progressPct, checkpoint: workingCheckpoint, attempts: 0 });

      // R3.6.2 — accumulate this batch's spend into the daily tracker so
      // the next cap check reflects the cost just incurred.
      if (perDayCap != null) {
        dailySpend += batchResults.reduce((sum, r) => sum + (r?.cost || 0), 0);
      }

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
      // R3.1.6 — a lost claim has a THIRD case the two above do not cover: the
      // claim holder is DEAD. It flipped the row to "scoring", died before
      // stamping a scan_id, and left a claim with no expiry, so this branch
      // returned null on every rescue forever and the job could never finish.
      // Take the claim over only when its heartbeat has gone stale; a live
      // finalize still wins and this caller still bails.
      const reclaim = deps.reclaimStaleFinalize || reclaimStaleFinalize;
      const takenOver = await reclaim(jobId, deps);
      if (!takenOver) {
        console.warn(`[scan-chunk] Job ${jobId}: lost the finalize claim — another instance owns it.`);
        return null;
      }
      console.warn(
        `[scan-chunk] Job ${jobId}: TOOK OVER a finalize claim whose owner stopped heartbeating ` +
          `(last beat ${takenOver.heartbeat_at ?? "never"}). The previous finalize never stamped a scan_id, ` +
          `so no scan row of its own can be orphaned by this.`
      );
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

  /**
   * The stored answer payloads, each stamped with the identity of the
   * `prompt_results` row it came from (R1.5.3).
   *
   * `r.raw` is the verbatim probe result and stays verbatim — the three added
   * keys are the row's own columns, not fields invented about the answer:
   * `result_id`/`job_id` are how the dashboard addresses the row later, and
   * `evidence_screenshot_id` (migration 021) is how it knows whether a capture
   * exists at all. Without them a scan read back from `scans.raw_results` has no
   * way to reach its own evidence, and the "View evidence" affordance can never
   * appear — it would be dead code by construction.
   *
   * Spread, not mutated: `allRows` is handed on as `promptResultRows` below, and
   * writing into `r.raw` would edit rows other code still reads as stored.
   * `?? null` and not `|| ""`: a row with no capture must stay NULL.
   *
   * A row whose `raw` is not an object is passed through untouched (null stays
   * null): stamping ids onto nothing would turn "this row stored no payload"
   * into an object that later code reads as a result.
   */
  const results = allRows.map((r) => {
    const raw = r?.raw;
    if (!raw || typeof raw !== "object") return raw ?? null;
    return {
      ...raw,
      result_id: r.id ?? null,
      job_id: r.job_id ?? jobId,
      evidence_screenshot_id: r.evidence_screenshot_id ?? null,
    };
  });
  const brandDomain = extractBrandDomain(url);

  const allEngineDefs = resolveEngines();
  let engineNames = checkpoint.engines && checkpoint.engines.length ? checkpoint.engines : allEngineDefs.map((e) => e.name);
  const isMultiEngine = engineNames.length > 1;

  // R3.2.5 — the engine-set verdict this scan is finalized under, recomputed
  // from EVIDENCE rather than trusted from the checkpoint alone.
  //
  // Three inputs, because each catches something the others cannot:
  //   * `frozen` is checkpoint.engines and NOT `engineNames` above — engineNames
  //     falls back to today's registry when nothing was frozen, and a scan that
  //     never froze a set cannot have changed away from one. Passing the
  //     fallback would report every unfrozen scan as refrozen.
  //   * `registered` is the live registry now: a frozen engine still missing at
  //     finalize is the drop that shrank this headline.
  //   * `probed` is the engines that actually produced persisted rows. Rows from
  //     an engine that was never frozen prove a refreeze even if the registry
  //     has since recovered and the checkpoint stamp was lost.
  // Plus what earlier chunks already saw, so a drop that healed before finalize
  // is still on the record.
  const probedEngines = allRows.map((r) => (r && (r.engine || r.raw?.engine)) || null).filter(Boolean);
  const engineSetChange = describeEngineSetChange({
    frozen: checkpoint.engines,
    registered: allEngineDefs.map((e) => e.name),
    probed: probedEngines,
    priorDropped: (checkpoint.engine_set_change?.dropped_engines || []).map((e) => e.engine),
    priorSubstituted: (checkpoint.engine_set_change?.substituted_engines || []).map((e) => e.engine),
  });
  if (engineSetChange) {
    console.warn(
      `[scan-chunk] Job ${jobId}: finalizing a scan whose engine set ${engineSetChange.state}. ` +
        `${engineSetChange.title} — ${engineSetChange.detail}`
    );
  }

  // R3.2.9 — On a refrozen scan, the frozen engine list produced ZERO rows:
  // every probe fell through to today's substituted set. Summarizing over the
  // frozen names yields empty slices and engines_counted=0, which is data loss:
  // the scan says "refrozen" while also reporting zero engines, so a reader
  // concludes the run produced nothing when it actually produced results that
  // finalize threw away. Override engineNames with the engines that actually
  // have rows so the headline reflects real evidence. The engine_set_change
  // marker still records the refreeze and names the frozen baseline, so a
  // reader knows this headline is not comparable to the frozen set.
  if (engineSetChange?.state === ENGINE_SET_STATES.REFROZEN && probedEngines.length > 0) {
    const uniqueProbed = [...new Set(probedEngines)];
    console.warn(
      `[scan-chunk] Job ${jobId}: refrozen scan — summarizing over the ${uniqueProbed.length} engine(s) ` +
        `that actually produced rows (${uniqueProbed.join(", ")}), not the frozen list ` +
        `(${(checkpoint.engines || []).join(", ") || "(none)"}) that produced none.`
    );
    engineNames = uniqueProbed;
  }

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

  // R3.6.8 — cost_unmeasured_calls carried from the checkpoint so it can be
  // persisted to the scan row, distinguishing a genuinely free run from one
  // where nothing could be priced.
  const stats = {
    cost: checkpoint.stats?.cost || 0,
    tokens: checkpoint.stats?.tokens || 0,
    cost_unmeasured_calls: checkpoint.stats?.cost_unmeasured_calls || 0,
  };

  // Heartbeat immediately before the slow LLM call (P0.2 FIX 2):
  // extractCompetitors can take up to ~75s, and until now finalize had NO
  // heartbeat between entering "scoring" (above) and completing — a
  // legitimately slow finalize could exceed HEARTBEAT_STALE_MS (180s),
  // look dead to isJobAlive, and invite a rescue into a second, concurrent
  // finalize attempt. Heartbeat-only: deliberately no other fields, this
  // call exists purely to keep the job looking alive.
  await updateJob(jobId, {});

  // R0.3.3 & R2.3.3 — roster continuity and provenance.
  // extractCompetitorsFn reaches the LLM; since R0.3.1 an unreachable LLM
  // THROWS LlmUnavailableError rather than returning an empty answer.
  // resolveCompetitorRoster turns that throw into a labelled state
  // (carried_forward / unavailable / configured) and records provenance.
  const userCompetitorList = (typeof competitorsRaw === "string" ? competitorsRaw : "")
    .split(/[\n,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const combinedUserCompetitors = Array.from(
    new Set([
      ...(Array.isArray(competitors)
        ? competitors.map((c) => (typeof c === "string" ? c.trim() : c?.name?.trim()))
        : []),
      ...userCompetitorList,
    ].filter(Boolean))
  );

  const {
    competitors: competitorObjects,
    roster_source: rosterSource,
    extraction_offline: rosterExtractionOffline,
    extraction_error: rosterExtractionError,
  } = await resolveCompetitorRoster({
    userCompetitors: combinedUserCompetitors,
    extract: () =>
      extractCompetitorsFn({
        results: normalizedForCompetitors,
        brand,
        brandUrl: url,
        userCompetitors: combinedUserCompetitors,
        stats,
        max: 10,
      }),
    // Chronology comes from scans.scanned_at (result_brands has no date
    // column and a random-uuid pk), so the previous scan is resolved first
    // and its id is what the roster lookup is keyed on. `alreadyStamped` is
    // this job's own scan on a crash-recovery re-finalize — never carry a
    // roster forward from ourselves.
    loadPreviousRoster: async () => {
      // R2.8.5 — this read may now THROW, and that is the point. It only runs
      // when rival extraction was already unavailable, i.e. when the carried
      // -forward roster is the only honest one left. getScansByDomain used to
      // swallow a postgrest error and hand back [], so an unreadable database
      // arrived here as "this brand has never been scanned": the carry-forward
      // was skipped and the scan was stamped roster_source=unavailable, a
      // label that claims we looked for a previous roster and found none.
      // A throw propagates through resolveCompetitorRoster (which deliberately
      // does not catch DB failures — see its docstring) to runScanChunk's
      // catch, which marks the job failed with the message. The probe rows are
      // already persisted, so a resume re-finalizes rather than re-probing.
      const priorScans = await getScansByDomainFn(url || promptKey);
      const scopedScans = (priorScans || []).filter((row) => (row.brand_key || null) === (checkpoint.brand_key || null));
      const previous = (scopedScans || []).find(
        (row) => row?.id && row.id !== alreadyStamped?.scan_id
      );
      if (!previous) return [];
      // R2.3.3: Prefer the non-null competitors column persisted on previous scan
      if (Array.isArray(previous.competitors) && previous.competitors.length > 0) {
        return previous.competitors;
      }
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
  // given), fullRoster is `[self]` alone and sov_pct is null with
  // sov_state 'not_assessed' and sov_state_reason 'self_only_roster'
  // (R4.3.2, rollup.js:172 — a self-only roster has no rival to measure
  // against, so the result is "not assessed", not "100%"). If the extractor
  // could not run at all,
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

  // R2.6.1 — per-prompt brands_elicited. countBrandsElicited counts how many
  // roster vendors the answer actually named (from the re-judged `r.brands`
  // above, not the probe-time snapshot). Attached to every result row so the
  // field is available on the persisted raw and downstream surfaces can read
  // it without re-deriving from result_brands.
  //
  // Array.isArray guard: test mocks may inject an async judgeBrandsSymmetric
  // that returns a Promise rather than an array. The real function is
  // synchronous (judge.js), so this guard is a test-robustness measure, not
  // a production fallback.
  for (const r of results) {
    const brands = Array.isArray(r.brands) ? r.brands : [];
    r.brands_elicited = countBrandsElicited(brands);
  }

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

  // R03.3a — THE TERMINAL COLLECTION OUTCOME, from the persisted rows.
  //
  // The finalizer used to end every scan with `status: "complete"` because it
  // had finished PROCESSING rows — even when every row was an error (A07). The
  // headline above is a scoring artifact; it answers "how did the brand do in
  // the answers we got", not "did we get any answers". This reads the frozen
  // work matrix and the persisted observation rows and answers the second
  // question, so a scan that measured nothing cannot finalize as `complete`.
  //
  // The frozen engine set, not `engineNames` post-fallback: a surface that was
  // planned and then became unavailable must still appear as not-attempted work
  // rather than vanish from the denominator (R03.3b / R03.1b).
  const planEngines = checkpoint.engines && checkpoint.engines.length ? checkpoint.engines : engineNames;
  const scoringRows = allRows.filter((r) => !r.is_branded_query && !r.raw?.is_branded_query);
  const diagnosticRows = allRows.filter((r) => r.is_branded_query || r.raw?.is_branded_query);
  const terminalOutcome = deriveScanOutcome({
    plan: buildScorePlan({ prompts: unbrandedTexts || [], engines: planEngines }),
    rows: scoringRows,
    diagnostics: diagnosticRows,
    blocked: checkpoint.blocked || null,
    engineNames: planEngines,
  });
  console.log(
    `[scan-chunk] Job ${jobId}: collection outcome ${terminalOutcome.outcome} ` +
      `(${terminalOutcome.outcome_reason}) — planned ${terminalOutcome.counts.planned}, ` +
      `valid ${terminalOutcome.counts.valid}, failed ${terminalOutcome.counts.failed}, ` +
      `not-attempted ${terminalOutcome.counts.not_attempted}.`
  );

  // Hash the unbranded set only (frozen at sourcing time), so prompt-set
  // identity is stable/comparable across scans regardless of branded seeds.
  const promptTexts = [...(unbrandedTexts || [])].sort();
  const prompt_set_hash = crypto.createHash("sha256").update(promptTexts.join("|")).digest("hex");
  const prompt_set_id = prompt_set_hash.slice(0, 16);

  const platform = isMultiEngine ? "multi" : "google_ai_overview";
  const scoringVersion = isMultiEngine ? "v9-multi-engine" : "v8.1-aio-unbranded-plus-presence";

  const scanRecord = {
    ...(checkpoint.brand_key ? { brand_key: checkpoint.brand_key } : {}),
    brand,
    url,
    industry,
    platform,
    visibility_pct: summary.visibility_pct,
    share_of_ai_pct: summary.share_of_ai_pct,
    share_of_voice_pct: summary.share_of_voice_pct ?? null,
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
    // R3.6.8 — the count of probes whose cost could not be priced. A run
    // where nothing could be priced has cost_total=0 but cost_unmeasured_calls>0,
    // distinguishable from a genuinely free run where both are 0.
    cost_unmeasured_calls: stats.cost_unmeasured_calls || 0,
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
    // R3.2.5 — why engines_counted fell, ON THE SCAN, not only in the ledger.
    //
    // IT RIDES INSIDE summary_stats DELIBERATELY, and this is not tidiness.
    // insertScan is not a pass-through: db.js's raw_results payload is a fixed
    // allowlist, and a new top-level field on this record would be dropped
    // before the write with nothing logged (see the comment on that allowlist —
    // that is exactly how R2.7.4's collection window was computed correctly and
    // persisted as nothing). `summary_stats` is already on the allowlist and
    // already survives the round trip: db.js stores it, both
    // /api/scans/[brand]/route.js and api/scans/_lib/scanRow.js hand it back to
    // the client verbatim as `scan.summary_stats`. So a UI reads
    // `summary_stats.engine_set_change.state` ("shrank" or "refrozen") and
    // renders `.title` / `.detail`.
    //
    // A spread, not a mutation: `summary` is also the object buildMetricsRows
    // reads below, and a scan-shape field has no business in a metrics row.
    // Omitted entirely when nothing changed, so the key's PRESENCE is the
    // signal and a clean scan carries no marker.
    //
    // R03.3a/R03.4a — terminal_outcome ALWAYS rides here, and here only,
    // because db.js's raw_results allowlist drops any new top-level field
    // (the same trap the engine-set marker above documents). It is the single
    // versioned collection outcome that the status payload, the persisted
    // report, history and export all read back through
    // terminalOutcomeFromRecord, so those surfaces cannot disagree.
    summary_stats: {
      ...summary,
      terminal_outcome: terminalOutcome,
      ...(engineSetChange ? { engine_set_change: engineSetChange } : {}),
    },
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
      //
      // R2.8.10 — the write-error code is preserved in the message so an
      // operator reading scan_jobs.error_message can branch on it: the
      // bracketed code prefix is machine-parseable and distinguishes
      // db_not_configured (fix the environment) from db_write_failed (the
      // database rejected the row) from db_write_unconfirmed (a scans row
      // MAY ALREADY EXIST — look before re-running). Without the code the
      // three outcomes were flattened into prose and indistinguishable on the
      // job row.
      throw new Error(
        `[${insertErr?.code || "scan_write_failed"}] Failed to save scan results: ${insertErr ? insertErr.message || String(insertErr) : "insertScan did not return a saved record id."}`
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

  // R3.3.1 — this chunk is a RESUME of a job whose last executor stopped saying
  // it was alive, so it costs an attempt. A clean hand-off (the self-continue
  // fetch after a checkpoint) arrives on a fresh heartbeat and is free; see the
  // MAX_JOB_ATTEMPTS block above for why counting every chunk would instead cap
  // the size of a scan.
  //
  // shouldRescueJob is called with the WALL CLOCK, deliberately not `nowFn`:
  // deps.now is the chunk's soft TIME BUDGET clock and tests run it at fake
  // epochs, and comparing a fake epoch against a real heartbeat decides a job's
  // liveness by accident.
  if (shouldRescueJob(job)) {
    let attempt;
    try {
      attempt = await claimJobAttempt(jobId, job, deps);
    } catch (err) {
      // The claim is the thing that keeps a poison job from running forever, so
      // a claim that could not be made is a chunk that does not run. Recorded as
      // a failure with the error attached, never waved through.
      console.error(`[scan-chunk] Could not claim an attempt on job ${jobId}:`, err.message);
      return finish({ ok: false, reason: "attempt_claim_failed", error: err.message });
    }

    if (attempt.verdict === "max_attempts") {
      // The claim already wrote the terminal state (status failed, progress 100,
      // error_message starting with MAX_ATTEMPTS_MARKER). Nothing here is
      // allowed to be quiet about it: an abandoned scan that logged nothing is
      // the same silence the cap exists to end.
      console.error(
        `[scan-chunk] Job ${jobId} ABANDONED after ${attempt.attempts ?? "?"} resume attempt(s) ` +
          `(cap ${attempt.maxAttempts}); it is now terminal and will not be resumed again. ` +
          `${attempt.errorMessage || ""}`
      );
      return finish({
        ok: false,
        reason: "max_attempts",
        attempts: attempt.attempts,
        max_attempts: attempt.maxAttempts,
        error: attempt.errorMessage,
      });
    }

    // The row moved between our read and our claim. Both of these are already
    // this function's own vocabulary, so they close the ledger row the same way
    // the equivalent races above it do.
    if (attempt.verdict === "not_found") {
      return finish({ ok: false, reason: "not_found" });
    }
    if (attempt.verdict === "already_finished") {
      return finish({ ok: true, reason: "already_finished", status: attempt.status || job.status });
    }
    if (!attempt.granted) {
      // A refusal this file does not recognise. Filed as a claim failure with
      // the verdict named, never rounded down to "nothing to do" — that is the
      // same shrug chunkRunOutcome's default branch refuses to make.
      return finish({
        ok: false,
        reason: "attempt_claim_failed",
        error:
          `claim_scan_job_attempt refused job ${jobId} with a verdict this chunk has no case for ` +
          `(${JSON.stringify(attempt.verdict)}). Refusing to read it as "nothing to do".`,
      });
    }
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
// R3.4.2 — AND THE CLOCK MOVES. The row above records the decision; it does not
// undo it. A declined schedule kept `next_run_at <= now`, so listDueSchedules
// re-returned it on the next tick and the one after that: the brand was
// declined forever and the only difference the ledger made was that the silence
// became a daily row saying the same thing. `declineSchedule` below advances
// `next_run_at` by an explicit per-reason backoff BEFORE filing the row, so a
// skip is a reschedule and not a permanent verdict. `last_run_at` stays put —
// nothing ran.
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

/**
 * R3.4.2 (finding C5) — HOW FAR A DECLINED SCHEDULE'S CLOCK MOVES.
 *
 * A skip used to leave `next_run_at` exactly where it was, so the schedule was
 * still `next_run_at <= now` on the following tick, and the one after that:
 * `listDueSchedules` re-returned it forever and the scheduler re-declined it
 * forever. The brand was never scanned again and the only outward sign was a
 * skip row repeating verbatim once per cron pass.
 *
 * This is a per-reason table, NOT `computeNextRunAt(schedule.cadence, ...)`,
 * for two reasons that are the same reason:
 *   * `computeNextRunAt` falls back to 72h for any cadence it does not know,
 *     and 'off' is precisely such a cadence. Bumping a cadence:'off' skip
 *     through it would silently invent a 72h cadence for a schedule whose
 *     stated cadence is "never" — a plausible-looking default standing in for
 *     a value nobody supplied.
 *   * 'already being scanned' and 'nobody wants this scanned' deserve
 *     different clocks. The first should come back around soon (the in-flight
 *     scan is somebody else's — a manual run — and this brand has NOT had its
 *     scheduled scan); the second should come back around slowly, but must
 *     still come back, because the enabled=true + cadence='off' contradiction
 *     is an operator-visible defect and one skip row a day is how it stays
 *     visible.
 */
export const SCHEDULER_SKIP_BACKOFF_MS = Object.freeze({
  /** Contradictory row (enabled + cadence 'off'). Re-surface once a day. */
  [SCHEDULER_SKIP_REASONS.CADENCE_OFF]: 24 * 60 * 60 * 1000,
  /** Someone else's scan is in flight. Try again in an hour, not a cadence. */
  [SCHEDULER_SKIP_REASONS.BRAND_ALREADY_ACTIVE]: 60 * 60 * 1000,
});

/**
 * `next_run_at` for a schedule this tick declined.
 *
 * Throws on a reason with no backoff instead of falling back to a default. A
 * reason added to SCHEDULER_SKIP_REASONS tomorrow without an entry here must
 * NOT quietly inherit somebody else's clock — that is how the brand ends up on
 * a cadence no one chose. The throw is caught by runSchedulerTick's own
 * try/catch, which closes the tick FAILED and rethrows: loud, on the record,
 * and impossible to mistake for a tick that had nothing to do.
 */
export function computeSkipNextRunAt(reason, fromIso) {
  const ms = SCHEDULER_SKIP_BACKOFF_MS[reason];
  if (!Number.isFinite(ms)) {
    throw new Error(
      `computeSkipNextRunAt: skip reason "${reason}" has no backoff in SCHEDULER_SKIP_BACKOFF_MS. ` +
        `Refusing to guess one — an unbacked-off skip re-fires on every tick forever (R3.4.2). Add the case.`
    );
  }
  const fromMs = new Date(fromIso || Date.now()).getTime();
  if (!Number.isFinite(fromMs)) {
    throw new Error(
      `computeSkipNextRunAt: cannot advance a declined schedule from an unparseable time (${JSON.stringify(fromIso)}).`
    );
  }
  return new Date(fromMs + ms).toISOString();
}

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
  // The reason goes onto the OPEN detail, not only onto the close. closeChunkRun
  // is deliberately fail-soft — a failed close leaves the row open for the
  // reaper rather than killing the tick — and while `reason` was passed only to
  // the close, that surviving row named the brand it declined and nothing about
  // why. An unexplained skip is precisely what this task abolishes, so the
  // reason has to be durable from the first write.
  const openDetail = { ...(detail || {}), reason };
  const run = await openChunkRun(
    ledger,
    { runner: RUNNERS.SCHEDULER, phase: SCHEDULER_PHASES.SCHEDULE, workerId, brand, detail: openDetail },
    { ...SCHEDULER_LOG, subject: `brand ${brand}` }
  );
  console.warn(
    `[scheduler] "${brand}" was due and was NOT scanned (${reason}). Recorded as a skipped ` +
      `scan_runs row — no scan job was created, so nothing else would have said so.`
  );
  // Counters stay NULL on purpose: a decision not to scan measured no probes,
  // and 0 here would claim it looked for some.
  await closeChunkRun(
    ledger,
    run,
    { outcome: RUN_OUTCOMES.SKIPPED, reason, detail: openDetail },
    SCHEDULER_LOG
  );
}

/**
 * Decline one due schedule: advance its clock, then file the row that says so.
 *
 * ONE function for both `continue` sites on purpose. The two used to be
 * copy-pasted blocks, and a fix applied to one of them is the shape of bug this
 * task is already cleaning up once.
 *
 * ORDER — bump, then record. The skip row's detail states the `next_run_at`
 * that was actually written, so it can only ever be written after the write
 * succeeded. If the bump throws, this throws: the tick's own catch closes the
 * tick FAILED with this brand already in `detail.skips` (it is pushed before
 * the bump) and rethrows. A schedule whose clock could not be advanced is a
 * schedule that will be declined again on every tick forever — the finding —
 * so it fails the tick rather than being absorbed.
 *
 * `last_run_at` is deliberately NOT touched: nothing ran. Stamping it would
 * make a declined brand indistinguishable from a scanned one in every read
 * that uses it as the freshness marker.
 */
async function declineSchedule({ ledger, upsertSchedule, schedule, brandLabel, reason, nowIso, workerId, skipped }) {
  // Computed BEFORE anything is written: an unmapped reason must abort the
  // decline rather than write half of it.
  const nextRunAt = computeSkipNextRunAt(reason, nowIso);

  skipped.push({ brand: brandLabel, reason });

  await upsertSchedule(schedule.brand, { next_run_at: nextRunAt });

  await recordSchedulerSkip(ledger, {
    workerId,
    brand: brandLabel,
    reason,
    detail: {
      schedule_key: schedule.brand,
      cadence: schedule.cadence ?? null,
      now: nowIso,
      // What the clock was, and what it is now. A reader comparing these two
      // can tell a skip that rescheduled the brand from one that did not.
      previous_next_run_at: schedule.next_run_at ?? null,
      next_run_at: nextRunAt,
      backoff_ms: SCHEDULER_SKIP_BACKOFF_MS[reason],
    },
  });
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
      let brandLabel = schedule.display_name;
      if (!brandLabel && (deps.getScansByDomain || getScansByDomain)) {
        try {
          const prevScans = await (deps.getScansByDomain || getScansByDomain)(schedule.brand);
          const withDisplay = prevScans?.find((s) => s.brand && s.brand !== schedule.brand);
          if (withDisplay) {
            brandLabel = withDisplay.brand;
            // R3.4.3: Write display_name back to the schedule row so scheduled and manual
            // scans share one identity continuously.
            await upsertSchedule(schedule.brand, { display_name: brandLabel });
          }
        } catch {
          // Keep brandLabel unset, fall back to schedule.brand below
        }
      }
      if (!brandLabel) brandLabel = schedule.brand;

      // Defensive: cadence 'off' should never fire a scan even if `enabled`
      // says otherwise (the two fields are independent columns; the P0.4
      // schedule editor that keeps them in sync doesn't exist yet).
      if (schedule.cadence === "off") {
        await declineSchedule({
          ledger,
          upsertSchedule,
          schedule,
          brandLabel,
          reason: SCHEDULER_SKIP_REASONS.CADENCE_OFF,
          nowIso,
          workerId: schedulerId,
          skipped,
        });
        continue;
      }

      if (await hasActive(brandLabel)) {
        // already running — don't pile on
        await declineSchedule({
          ledger,
          upsertSchedule,
          schedule,
          brandLabel,
          reason: SCHEDULER_SKIP_REASONS.BRAND_ALREADY_ACTIVE,
          nowIso,
          workerId: schedulerId,
          skipped,
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

      keepAlive(() => kickChunk(job.id), {
        label: `[scheduler] chunk kick for job ${job.id} (brand ${brandLabel})`,
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

// ---------------------------------------------------------------------------
// R3.3.2 — the reaper: open scan_runs rows whose writer never came back
// ---------------------------------------------------------------------------
//
// THE FINDING (S12). Nothing ever closes an open run. `close_scan_run` is
// called by the process that opened the row, so the one case it structurally
// cannot cover is the process that stops existing: a container killed
// mid-probe, an invocation cut off at `maxDuration`, an OOM. Migration 011 says
// this in its own header — "A crashed writer therefore leaves an OPEN row with
// a stale `heartbeat_at`, which is a visible, sweepable state (R3.3.2 closes it
// as 'reaped')" — and then, under WHAT THIS MIGRATION DOES NOT DO, "No reaper.
// `scan_runs_open_idx` makes the sweep cheap, but the policy ... is R3.3.2's".
// This is that policy. Until it runs, `outcome IS NULL` means BOTH "running
// right now" and "died in March", which is standing rule 1's failure in its
// purest form: the wedged row is indistinguishable from live work forever.
//
// WHAT THIS DOES **NOT** TOUCH: scan_jobs. A job whose executor died is already
// handled — the sweep re-dispatches it (shouldRescueJob) and R3.3.1's attempt
// cap makes it terminal after MAX_JOB_ATTEMPTS fruitless resumes. Failing a job
// here on first staleness would delete R3.3.1's retry policy and kill scans
// that are one rescue away from finishing. The LEDGER row is the thing nothing
// closes; that is what is reaped.
//
// ---------------------------------------------------------------------------
// HOW THE THRESHOLD WAS CHOSEN (it is derived, not picked)
// ---------------------------------------------------------------------------
// Three numbers already exist in this codebase and the threshold is built out
// of them rather than beside them:
//
//   30s   CHUNK_RUN_HEARTBEAT_MS — how often an in-flight chunk beats. The
//         fleet's FALLBACK_HEARTBEAT_MS (worker/src/index.js) is the same 30s.
//   180s  HEARTBEAT_STALE_MS (src/lib/db.js), imported above. Six consecutive
//         missed beats. This is ALREADY this project's line for "dead": it is
//         what isJobAlive uses, and jobLease.js's LEASE_TTL_MS is set equal to
//         it precisely "so both notions of dead agree". A fourth notion of dead
//         invented here is a fourth thing to drift.
//   300s  maxDuration on /api/scan and /api/scan/worker. A web chunk cannot
//         outlive it; the platform stops the invocation.
//
// The reaper waits REAP_TTL_MULTIPLE (2) x TTL = 360s. The argument for 2 and
// not 1 is the 300s number: staleness is measured from the LAST BEAT, and while
// a healthy chunk is at most ~30s stale, a chunk whose beats are all failing
// (a database blip — startChunkHeartbeat deliberately logs and continues rather
// than tearing down live work) accumulates staleness from the moment the blip
// starts. That accumulation is bounded by the invocation's own lifetime, so a
// live web chunk's heartbeat can never be more than 300s old. 360 > 300 means a
// row over the threshold cannot be a live web chunk that is merely slow — its
// host is gone. At 1 x TTL (180s) it could still be alive, and reaping it
// destroys real work and hands its probes a run that says they never happened.
//
// THE RESIDUAL RISK, NAMED RATHER THAN WAVED AWAY. The probe fleet is a
// long-running container with no 300s ceiling, so a fleet whose database
// connection is partitioned for over 6 minutes CAN be reaped while alive. That
// case is not silent: `heartbeat_scan_run` RAISES on a closed run, so the fleet
// learns on its next successful beat that something ended its run (011: "The
// writer needs to learn that something else has already closed its run"), and
// its own close then fails loudly rather than overwriting the reap. Raising the
// multiple would trade that for a longer wedge; 2 is the smallest value that is
// provably safe for the serverless writers, which are the ones that die today.

/**
 * The heartbeat TTL a run is measured against. Aliased from db.js on purpose:
 * a run, a job and a lease all mean the same thing by "dead", and the alias is
 * here so a reader of this section does not have to guess which 3 minutes.
 */
export const RUN_HEARTBEAT_TTL_MS = HEARTBEAT_STALE_MS;

/** The N in "staler than N x TTL". See the derivation above. */
export const REAP_TTL_MULTIPLE = 2;

/** 360s. A run whose last beat is older than this is presumed to have no writer. */
export const REAP_STALE_AFTER_MS = RUN_HEARTBEAT_TTL_MS * REAP_TTL_MULTIPLE;

/** What part ran. One pass over the open rows. */
export const REAPER_PHASE = "reap";

/**
 * The outcome a reaped row carries. 'reaped' is migration 011's own word for
 * exactly this state, and every reader already buckets it with failure —
 * src/app/api/scan/worker/route.js's classifyChunkResult maps
 * `reaped -> failed` with the comment "bucketed with failed so a future reap
 * never reads as success". So the run closes as a failure, and it closes as a
 * failure of a KNOWN KIND, which a bare 'failed' would have thrown away.
 */
export const REAP_OUTCOME = RUN_OUTCOMES.REAPED;

/**
 * The reason on every reaped row. Starts with the bare word so
 * `reason LIKE 'reaped%'` finds every one of them in one query, and carries the
 * cause after the colon — the same shape as MAX_ATTEMPTS_MARKER above.
 */
export const REAP_REASON = "reaped:heartbeat_stale";

/**
 * How many rows one pass will close. A bound, not a policy: the pass reports
 * `truncated: true` when it hit the cap, so "I closed 100 and there are more"
 * can never be read as "the ledger is clean now".
 */
export const REAP_MAX_PER_PASS = 100;

/** Why the whole PASS closed the way it did. */
export const REAP_PASS_REASONS = Object.freeze({
  /** It looked and every open run was fresh. A MEASURED zero, not a silence. */
  NO_STALE_RUNS: "no_stale_runs",
  /** Stale rows were listed and none could be reaped (races, or fresh on re-check). */
  NOTHING_REAPABLE: "nothing_reapable",
  /** At least one close failed for a reason that is not a race. */
  REAP_FAILED: "reap_failed",
  /** No client and no injected ledger: the pass could not look at all. */
  LEDGER_UNAVAILABLE: "ledger_unavailable",
});

/** What happened to one candidate row. Every candidate gets exactly one. */
export const REAP_ROW_VERDICTS = Object.freeze({
  /** Closed by this pass. */
  REAPED: "reaped",
  /** Someone else closed it first — the writer came back, or another sweeper won. */
  LOST_RACE: "lost_race",
  /** The row is gone (deleted between the list and the close). */
  VANISHED: "vanished",
  /** Listed as stale, but not stale on re-check against this pass's clock. NOT reaped. */
  NOT_STALE: "not_stale",
  /** heartbeat_at could not be parsed, so staleness is UNKNOWN. NOT reaped. */
  UNREADABLE_HEARTBEAT: "unreadable_heartbeat",
  /** The close failed for a reason that is not a race. Counted, never hidden. */
  CLOSE_FAILED: "close_failed",
});

const REAPER_LOG = { label: "reaper", what: "reap pass", noun: "pass" };

/**
 * Is this run's heartbeat old enough to presume its writer is gone?
 *
 * PURE — no client, no clock of its own — so the one comparison the whole task
 * turns on is testable without a database. Two refusals matter more than the
 * happy path:
 *   * an unparseable/absent heartbeat is UNKNOWN staleness, not infinite
 *     staleness. It is reported (and counted by the caller), never reaped: a
 *     row nobody can date is not evidence that its writer died.
 *   * a heartbeat in the future (skew between the database's now() and the
 *     app's) yields a negative staleness and is not stale. Skew must not become
 *     a licence to close live work.
 * The comparison is strictly `>`: exactly at the threshold is not yet stale.
 */
export function runStaleness(run, nowMs, staleAfterMs = REAP_STALE_AFTER_MS) {
  const beat = run ? run.heartbeat_at ?? run.heartbeatAt ?? null : null;
  const beatMs = beat === null || beat === undefined ? NaN : new Date(beat).getTime();
  if (!Number.isFinite(beatMs)) {
    return {
      stale: false,
      // null, never 0 and never Infinity: this is NOT MEASURED (rule 5).
      staleMs: null,
      verdict: REAP_ROW_VERDICTS.UNREADABLE_HEARTBEAT,
      heartbeatAt: beat,
    };
  }
  const staleMs = nowMs - beatMs;
  const stale = staleMs > staleAfterMs;
  return {
    stale,
    staleMs,
    verdict: stale ? REAP_ROW_VERDICTS.REAPED : REAP_ROW_VERDICTS.NOT_STALE,
    heartbeatAt: beat,
  };
}

/**
 * A failed close, sorted into "someone else got there first" and "this broke".
 *
 * IDEMPOTENCE LIVES HERE. `close_scan_run` updates `WHERE ended_at IS NULL` and
 * RAISES if the row was already closed, so two sweepers racing the same row
 * cannot both close it and cannot corrupt it: the database picks a winner and
 * the loser is told which outcome beat it. That exception is a NORMAL outcome
 * of a concurrent sweep, not a failure — but it must still be counted, or a
 * pass that lost every race would report the same clean zero as a pass that
 * found nothing to do.
 *
 * The two strings come from migration 011's own RAISE statements; a guard test
 * in scanRunReaper.test.mjs reads the migration and fails if either sentence
 * changes, because a silent drift here would reclassify every race as a hard
 * failure (or worse, hide a real one).
 */
export function classifyReapCloseFailure(err) {
  const msg = String((err && err.message) || "");
  if (/already closed/i.test(msg)) return REAP_ROW_VERDICTS.LOST_RACE;
  if (/no run .* exists/i.test(msg)) return REAP_ROW_VERDICTS.VANISHED;
  return REAP_ROW_VERDICTS.CLOSE_FAILED;
}

/**
 * The sentence a reaped row carries in `error`.
 *
 * An operator reading a reaped row must be able to tell it from a row the
 * writer closed and from a row that never existed, without opening this file:
 * who closed it, when, how stale it was, and what the threshold was.
 */
function reapErrorSentence(row, staleness, { reaperId, nowIso, staleAfterMs }) {
  return (
    `reaped by ${reaperId} at ${nowIso}: this run was opened at ${row.started_at ?? "unknown"} ` +
    `and last heartbeat at ${staleness.heartbeatAt ?? "never"} — ${staleness.staleMs}ms ago, past the ` +
    `${staleAfterMs}ms threshold (${REAP_TTL_MULTIPLE} x ${RUN_HEARTBEAT_TTL_MS}ms TTL). ` +
    `Its writer never closed it, so this outcome was written by the sweep and NOT by the process ` +
    `that did the work: read its counters as whatever that process managed to record before it ` +
    `stopped, not as a final account.`
  );
}

/** All counters NOT MEASURED. The shape a refusal returns, so no caller reads a zero. */
function unmeasuredReapPass(fields) {
  return {
    ok: false,
    outcome: null,
    reason: null,
    passRunId: null,
    reaperId: null,
    now: null,
    cutoff: null,
    staleAfterMs: null,
    ttlMs: RUN_HEARTBEAT_TTL_MS,
    ttlMultiple: REAP_TTL_MULTIPLE,
    considered: null,
    reaped: null,
    lostRace: null,
    vanished: null,
    notStale: null,
    unreadableHeartbeat: null,
    closeFailed: null,
    truncated: null,
    runs: null,
    ...fields,
  };
}

/**
 * One sentence for a log. A pass that looked and found nothing and a pass that
 * could not look must not produce the same line — that sentence IS the false
 * success.
 */
export function describeReapPass(pass) {
  if (pass.considered === null) {
    return `reap pass DID NOT RUN (${pass.reason}) — open runs were not counted; this is not "zero stale runs"`;
  }
  return (
    `reap pass ${pass.outcome}${pass.reason ? ` (${pass.reason})` : ""} — ` +
    `${pass.considered} stale candidate(s), ${pass.reaped} reaped, ${pass.lostRace} lost to a race, ` +
    `${pass.vanished} vanished, ${pass.notStale} fresh on re-check, ` +
    `${pass.unreadableHeartbeat} undateable, ${pass.closeFailed} failed to close` +
    (pass.truncated ? ` — TRUNCATED, more stale runs remain open` : "")
  );
}

/**
 * Close every open run whose heartbeat has gone stale, as 'reaped'.
 *
 * THE FOUR THINGS A REAPER GETS WRONG, AND WHERE EACH IS HANDLED:
 *  1. Reaping live-but-slow work. The threshold is derived above (2 x TTL =
 *     360s > the 300s maximum life of a web invocation), the staleness is
 *     RE-CHECKED in JS against this pass's clock rather than trusted from the
 *     query's cutoff, and an undateable heartbeat is never reaped.
 *  2. Failing to reap. That is the bug: one pass takes up to REAP_MAX_PER_PASS
 *     rows, oldest heartbeat first, and says so when there are more.
 *  3. Racing sweepers. The close is `WHERE ended_at IS NULL` in SQL and raises
 *     on a second close, so exactly one pass wins each row; the loser records
 *     `lost_race` and continues. Re-running this function is safe by
 *     construction — nothing it has already closed is a candidate again.
 *  4. Leaving no trace. Every reaped row gets an outcome, a reason, a sentence
 *     in `error` and a detail block naming the sweep, and the PASS ITSELF opens
 *     and closes a scan_runs row of its own with measured counts. A pass that
 *     found nothing closes 'noop'/'no_stale_runs' — a measured zero, which is a
 *     different row from a cron that never ran.
 *
 * Counters on the pass row: probes stay NULL because a sweep probes nothing
 * (0 would claim it tried), and `errors_recovered` counts the exceptions it
 * absorbed and continued past.
 *
 * WIRED BY R3.3.4: `runSweepMaintenance` in src/app/api/scan/worker/route.js
 * calls this once per cron sweep, in a try/catch of its own so a reap that
 * throws cannot take the scheduler tick (or the sweep's 200) down with it. The
 * pass's counters go onto the wire under `reaped`. Between R3.3.2 and R3.3.4
 * this function was correct and unreached, which is why the route's test suite
 * now asserts the call site exists rather than trusting it.
 */
export async function reapStaleRuns(nowIso = new Date().toISOString(), deps = {}) {
  const nowMs = new Date(nowIso).getTime();
  if (!Number.isFinite(nowMs)) {
    throw new Error(
      `reapStaleRuns: "${nowIso}" is not a readable instant. A sweep that cannot say what time it ` +
        `is cannot say what is stale, and guessing would close live runs.`
    );
  }
  const staleAfterMs = Number.isFinite(deps.staleAfterMs) ? deps.staleAfterMs : REAP_STALE_AFTER_MS;
  if (!(staleAfterMs > 0)) {
    throw new Error(
      `reapStaleRuns: staleAfterMs must be a positive number of milliseconds, got ` +
        `${JSON.stringify(deps.staleAfterMs)} — a threshold of zero or less reaps every open run, ` +
        `including the ones running right now.`
    );
  }
  const limit = Number.isInteger(deps.maxPerPass) && deps.maxPerPass > 0 ? deps.maxPerPass : REAP_MAX_PER_PASS;
  const reaperId = deps.reaperId || `reaper-${crypto.randomUUID()}`;
  const cutoffIso = new Date(nowMs - staleAfterMs).toISOString();

  const client = resolveAttemptClient(deps);
  // The real listing lives in scanRuns.js with every other read of the table
  // (R3.3.4). `deps.listStaleRuns` stays the injection point the 28 tests use.
  const listStale = deps.listStaleRuns || (client ? (args) => listStaleScanRuns(args, { client }) : null);
  const ledger = resolveChunkLedger(deps);

  if (!listStale || !ledger.enabled) {
    // NOT a quiet zero. The whole point of the ledger is that absence and
    // emptiness are different, and a reaper that could not look is the caller
    // most likely to be misread as "nothing was wrong".
    console.error(
      `[reaper] REAP PASS DID NOT RUN — no Supabase client is configured, so open scan_runs rows ` +
        `were neither listed nor closed. This is NOT "zero stale runs": any run whose writer died ` +
        `is still open and still indistinguishable from live work. Nothing was measured.`
    );
    return unmeasuredReapPass({ reason: REAP_PASS_REASONS.LEDGER_UNAVAILABLE, reaperId, now: nowIso });
  }

  const passDetail = {
    now: nowIso,
    cutoff: cutoffIso,
    stale_after_ms: staleAfterMs,
    ttl_ms: RUN_HEARTBEAT_TTL_MS,
    ttl_multiple: REAP_TTL_MULTIPLE,
    max_per_pass: limit,
  };

  // Standing rule 2 on the OPEN: if the pass cannot be recorded the error
  // propagates and nothing is reaped. A sweep that closes other people's rows
  // while leaving no row of its own is the least auditable thing in the system.
  const passRun = await openChunkRun(
    ledger,
    { runner: RUNNERS.REAPER, phase: REAPER_PHASE, workerId: reaperId, detail: passDetail },
    { ...REAPER_LOG, subject: `pass at ${nowIso}` }
  );

  const counts = {
    [REAP_ROW_VERDICTS.REAPED]: 0,
    [REAP_ROW_VERDICTS.LOST_RACE]: 0,
    [REAP_ROW_VERDICTS.VANISHED]: 0,
    [REAP_ROW_VERDICTS.NOT_STALE]: 0,
    [REAP_ROW_VERDICTS.UNREADABLE_HEARTBEAT]: 0,
    [REAP_ROW_VERDICTS.CLOSE_FAILED]: 0,
  };
  const reapedRuns = [];
  // NOT MEASURED until the listing returns. A pass that died inside the query
  // has no idea how many rows were stale, and `considered: 0` would be a count
  // it never took.
  let considered = null;
  let truncated = null;

  const summarize = () => ({
    considered,
    truncated,
    reaped: counts[REAP_ROW_VERDICTS.REAPED],
    lost_race: counts[REAP_ROW_VERDICTS.LOST_RACE],
    vanished: counts[REAP_ROW_VERDICTS.VANISHED],
    not_stale: counts[REAP_ROW_VERDICTS.NOT_STALE],
    unreadable_heartbeat: counts[REAP_ROW_VERDICTS.UNREADABLE_HEARTBEAT],
    close_failed: counts[REAP_ROW_VERDICTS.CLOSE_FAILED],
    reaped_run_ids: reapedRuns.map((r) => r.id),
  });
  /** Exceptions absorbed and continued past — races included, since each was a throw. */
  const absorbed = () =>
    counts[REAP_ROW_VERDICTS.LOST_RACE] +
    counts[REAP_ROW_VERDICTS.VANISHED] +
    counts[REAP_ROW_VERDICTS.CLOSE_FAILED];

  try {
    const fetched = await listStale({
      cutoffIso,
      limit,
      // Never reap yourself. The pass's own row is open and fresh, so the
      // staleness re-check below would spare it anyway; excluding it in the
      // query as well means that safety does not depend on a clock.
      excludeRunId: passRun ? passRun.id : null,
      nowIso,
    });
    const rows = Array.isArray(fetched) ? fetched : [];
    truncated = rows.length > limit;
    const candidates = rows.slice(0, limit);
    considered = candidates.length;

    for (const row of candidates) {
      if (passRun && row.id === passRun.id) continue;

      // Belt and braces on the listing: a row that is already closed is a race
      // that was over before it started, not a reap.
      if (row.ended_at != null || row.outcome != null) {
        counts[REAP_ROW_VERDICTS.LOST_RACE] += 1;
        continue;
      }

      const staleness = runStaleness(row, nowMs, staleAfterMs);
      if (staleness.verdict === REAP_ROW_VERDICTS.UNREADABLE_HEARTBEAT) {
        counts[REAP_ROW_VERDICTS.UNREADABLE_HEARTBEAT] += 1;
        console.warn(
          `[reaper] run ${row.id} is open with an UNREADABLE heartbeat ` +
            `(${JSON.stringify(staleness.heartbeatAt)}) — staleness is unknown, so it is NOT reaped. ` +
            `It stays open and is counted, not skipped in silence.`
        );
        continue;
      }
      if (!staleness.stale) {
        // The query said stale, this pass's clock says otherwise. Trust the
        // stricter answer and record the disagreement — it usually means skew
        // between the database's now() and this process's.
        counts[REAP_ROW_VERDICTS.NOT_STALE] += 1;
        console.warn(
          `[reaper] run ${row.id} was listed as stale but its heartbeat is only ${staleness.staleMs}ms ` +
            `old against this pass's clock (threshold ${staleAfterMs}ms) — NOT reaped. Check clock skew ` +
            `between the database and this process.`
        );
        continue;
      }

      try {
        const closed = await ledger.close({
          runId: row.id,
          outcome: REAP_OUTCOME,
          reason: REAP_REASON,
          error: reapErrorSentence(row, staleness, { reaperId, nowIso, staleAfterMs }),
          // Counters are deliberately omitted: NULL does not overwrite what the
          // dead writer had already recorded (close_scan_run COALESCEs), and
          // writing 0 here would replace real measurements with a confident
          // nothing (rule 5).
          detail: {
            reaped: true,
            reaped_at: nowIso,
            reaped_by: reaperId,
            reap_pass_run_id: passRun ? passRun.id : null,
            last_heartbeat_at: staleness.heartbeatAt,
            stale_ms: staleness.staleMs,
            stale_after_ms: staleAfterMs,
            ttl_ms: RUN_HEARTBEAT_TTL_MS,
            ttl_multiple: REAP_TTL_MULTIPLE,
            reaped_runner: row.runner ?? null,
            reaped_phase: row.phase ?? null,
            reaped_worker_id: row.worker_id ?? null,
          },
        });
        counts[REAP_ROW_VERDICTS.REAPED] += 1;
        reapedRuns.push({
          id: row.id,
          runner: row.runner ?? null,
          phase: row.phase ?? null,
          workerId: row.worker_id ?? null,
          scanJobId: row.scan_job_id ?? null,
          brand: row.brand ?? null,
          staleMs: staleness.staleMs,
          heartbeatAt: staleness.heartbeatAt,
        });
        console.warn(
          `[reaper] REAPED run ${row.id} (${row.runner ?? "?"}/${row.phase ?? "?"}, worker ` +
            `${row.worker_id ?? "unknown"}, job ${row.scan_job_id ?? "none"}): no heartbeat for ` +
            `${staleness.staleMs}ms, past ${staleAfterMs}ms. Its writer never came back.` +
            (closed && closed.outcome ? ` Ledger now reads: ${describeRun(closed)}.` : "")
        );
      } catch (err) {
        const verdict = classifyReapCloseFailure(err);
        counts[verdict] += 1;
        if (verdict === REAP_ROW_VERDICTS.CLOSE_FAILED) {
          console.error(
            `[reaper] could not close run ${row.id}: ${err.message} — it stays OPEN and will be ` +
              `retried on the next pass. Counted as a failure, not as a reap.`
          );
        } else {
          console.warn(
            `[reaper] run ${row.id} was ${verdict} before this pass could close it (${err.message}) — ` +
              `another sweeper or its own writer got there first. Not an error; recorded so a pass that ` +
              `lost every race does not read as a pass with nothing to do.`
          );
        }
      }
    }
  } catch (err) {
    // The pass's own row closes FAILED before the error leaves. A sweep that
    // died halfway must not be indistinguishable from one that never ran.
    await closeChunkRun(
      ledger,
      passRun,
      {
        outcome: RUN_OUTCOMES.FAILED,
        reason: REAP_PASS_REASONS.REAP_FAILED,
        error: err.message,
        errorsRecovered: absorbed(),
        detail: { ...passDetail, ...summarize() },
      },
      REAPER_LOG
    );
    throw err;
  }

  let verdict;
  if (counts[REAP_ROW_VERDICTS.CLOSE_FAILED] > 0) {
    verdict = { outcome: RUN_OUTCOMES.FAILED, reason: REAP_PASS_REASONS.REAP_FAILED };
  } else if (considered === 0) {
    // Looked, and every open run was fresh. A MEASURED zero.
    verdict = { outcome: RUN_OUTCOMES.NOOP, reason: REAP_PASS_REASONS.NO_STALE_RUNS };
  } else if (counts[REAP_ROW_VERDICTS.REAPED] === 0) {
    verdict = { outcome: RUN_OUTCOMES.NOOP, reason: REAP_PASS_REASONS.NOTHING_REAPABLE };
  } else {
    verdict = { outcome: RUN_OUTCOMES.SUCCEEDED, reason: null };
  }

  await closeChunkRun(
    ledger,
    passRun,
    {
      ...verdict,
      // Probes stay NULL: a sweep attempts none, and 0 would claim it tried.
      errorsRecovered: absorbed(),
      detail: { ...passDetail, ...summarize() },
    },
    REAPER_LOG
  );

  const pass = {
    ok: counts[REAP_ROW_VERDICTS.CLOSE_FAILED] === 0,
    outcome: verdict.outcome,
    reason: verdict.reason,
    passRunId: passRun ? passRun.id : null,
    reaperId,
    now: nowIso,
    cutoff: cutoffIso,
    staleAfterMs,
    ttlMs: RUN_HEARTBEAT_TTL_MS,
    ttlMultiple: REAP_TTL_MULTIPLE,
    considered,
    reaped: counts[REAP_ROW_VERDICTS.REAPED],
    lostRace: counts[REAP_ROW_VERDICTS.LOST_RACE],
    vanished: counts[REAP_ROW_VERDICTS.VANISHED],
    notStale: counts[REAP_ROW_VERDICTS.NOT_STALE],
    unreadableHeartbeat: counts[REAP_ROW_VERDICTS.UNREADABLE_HEARTBEAT],
    closeFailed: counts[REAP_ROW_VERDICTS.CLOSE_FAILED],
    truncated,
    runs: reapedRuns,
  };
  console.log(`[reaper] ${describeReapPass(pass)}`);
  if (truncated) {
    console.warn(
      `[reaper] this pass stopped at its cap of ${limit} rows and MORE stale runs remain open. ` +
        `Do not read ${pass.reaped} reaped as "the ledger is clean now".`
    );
  }
  return pass;
}
