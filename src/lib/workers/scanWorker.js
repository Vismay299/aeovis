import crypto from "crypto";
import {
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

const MAX_SOURCING_ATTEMPTS = 3;
const DEFAULT_UNBRANDED_TARGET = 30;

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
export async function runSourcingPhase(job, deps = {}) {
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

export async function runProbingPhase(jobId, checkpoint, deps = {}, chunkStartMs = Date.now()) {
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
  // Defensive fallback only: if none of the checkpoint-frozen engine names
  // resolve against the live registry any more (e.g. env fully reconfigured
  // mid-scan), fall back to whatever's enabled today rather than stalling
  // the job forever on an empty engine list.
  const engineDefs = filtered.length > 0 ? filtered : allEngineDefs;

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

export async function runFinalizePhase(jobId, checkpoint, deps = {}) {
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
      // just this row's roster judgment and keep going.
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
// ---------------------------------------------------------------------------

export async function runScanChunk(jobId, deps = {}) {
  const getJob = deps.getScanJob || getScanJob;
  const updateJob = deps.updateScanJob || updateScanJob;
  const claimJob = deps.claimJobStatus || claimJobStatus;
  const selfContinue = deps.selfContinue || defaultSelfContinue;
  const nowFn = deps.now || Date.now;

  let job;
  try {
    job = await getJob(jobId);
  } catch (err) {
    // Transient read failure — we don't even have a confirmed job to mark
    // failed, and a retry from the DB is likely to hit the same transient
    // condition. Log and let the next poll/cron tick try again.
    console.error(`[scan-chunk] Failed to read job ${jobId}:`, err.message);
    return { ok: false, reason: "read_failed", error: err.message };
  }

  if (!job) {
    console.warn(`[scan-chunk] Job ${jobId} not found — nothing to resume.`);
    return { ok: false, reason: "not_found" };
  }

  if (job.status === "complete" || job.status === "failed") {
    return { ok: true, reason: "already_finished", status: job.status };
  }

  const chunkStartMs = nowFn();

  try {
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
        return { ok: true, reason: "sourcing_claimed_elsewhere" };
      }
      await updateJob(jobId, { progress_pct: 10 });
      checkpoint = await runSourcingPhase(job, deps);
      await updateJob(jobId, { status: "probing", progress_pct: 25, checkpoint });
      status = "probing";
    }

    if (status === "probing") {
      const outcome = await runProbingPhase(jobId, checkpoint, deps, chunkStartMs);
      checkpoint = outcome.checkpoint;
      if (outcome.budgetHit) {
        selfContinue(jobId);
        return { ok: true, reason: "checkpointed", progress_pct: outcome.progressPct };
      }
      status = "scoring";
    }

    if (status === "scoring") {
      const finalJob = await runFinalizePhase(jobId, checkpoint, deps);
      if (!finalJob) {
        // Lost the finalize claim to another instance — it owns completing
        // this job now (see runFinalizePhase's claim comment).
        return { ok: true, reason: "finalize_claimed_elsewhere" };
      }
      return { ok: true, reason: "complete", job: finalJob };
    }

    return { ok: true, reason: "noop", status };
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
    return { ok: false, reason: "error", error: err.message };
  }
}

// ---------------------------------------------------------------------------
// Scheduler tick — enqueues scans for due, non-active scan_schedules brands.
// Called by the cron worker route after its resume sweep.
// ---------------------------------------------------------------------------

export async function runSchedulerTick(nowIso, deps = {}) {
  const listDue = deps.listDueSchedules || listDueSchedules;
  const hasActive = deps.hasActiveScanForBrand || hasActiveScanForBrand;
  const createJob = deps.createScanJob || createScanJob;
  const upsertSchedule = deps.upsertScanSchedule || upsertScanSchedule;
  const kickChunk = deps.runScanChunk || runScanChunk;

  const due = await listDue(nowIso);
  const started = [];

  for (const schedule of due) {
    // Defensive: cadence 'off' should never fire a scan even if `enabled`
    // says otherwise (the two fields are independent columns; the P0.4
    // schedule editor that keeps them in sync doesn't exist yet).
    if (schedule.cadence === "off") continue;

    const brandLabel = schedule.display_name || schedule.brand;
    if (await hasActive(brandLabel)) continue; // already running — don't pile on

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

  return { started };
}
