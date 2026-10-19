import {draftCheck} from '../repairs/workflow.js';
import {isCurrentCheck} from '../repairs/researchContract.js';
import {
  getContentJob,
  updateContentJob,
  CONTENT_JOB_RUNNING,
  isDeliveredContentJob,
  insertContentItem,
  getContentItem,
  updateContentItem,
  getBrandBrief,
  upsertBrandBrief,
  listLessons,
  insertContentRun,
  finishContentRun,
} from "../db/content.js";
import { getScansForBrand } from "../db.js";
import { acquireLease, renewLease, releaseLease, newLeaseOwner } from "../jobLease.js";
import { stageForBlock, isLegalTransition } from "./stages.js";
import { HEALTHCARE_CXO_BRIEF } from "./briefs/healthcareCxo.js";
import { defaultAgentForBase } from "./agents/model.js";
import { crewMember } from "./agents/crew.js";
import { getBlock, resolvePipeline } from "./agents/blocks.js";
import {
  initTrace,
  markWorking,
  markDone,
  markFailed,
  bumpCycle,
  summarizeCoordinate,
  summarizeResearch,
  summarizeBenchmark,
  summarizeDraft,
  summarizeReview,
  summarizeTransform,
  summarizeFactCheck,
} from "./agents/trace.js";
import { runCoordinate } from "./steps/coordinate.js";
import { runResearch } from "./steps/research.js";
import { runBenchmark } from "./steps/benchmark.js";
import { runDraft } from "./steps/draft.js";
import { runReview } from "./steps/review.js";
import { runTransform } from "./steps/transform.js";
import { runFactCheck } from "./steps/factCheck.js";
import { formatKnowledge } from "./steps/shared.js";
import { listKnowledgeBlocks } from "../db/knowledge.js";
import { makeSelfContinue } from "../selfContinue.js";

/**
 * Content-pipeline background worker. Identical shape to scanWorker.js:
 * fire-and-forget, status writes per step, cron-resumable, fails loud with
 * the step named.
 *
 * States: pending -> coordinating -> researching -> benchmarking ->
 * drafting -> reviewing -> awaiting_approval | failed
 *
 * Guardrails (locked decisions):
 * - Max 2 automatic draft→review cycles, then the item goes to the human
 *   queue regardless, flagged "below_threshold".
 * - A YMYL violation is never auto-revised — straight to the human queue
 *   with the violation named.
 * - CONTENT_MAX_COST_PER_ITEM is a hard per-item stop.
 */

const MAX_DRAFT_REVIEW_CYCLES = 2;

// --- Chunking / self-continue (R3.1.10) -------------------------------------

/** The worker route that accepts `?job_id=` and resumes one named job. */
export const CONTENT_WORKER_PATH = "/api/content/worker";

/**
 * R3.5.7 — thrown by writeJob (and the pre-item ownership check) when the
 * database REFUSES a guarded write: the row has left the worker-owned statuses,
 * so another execution already delivered this job.
 *
 * It is a sentinel, not a failure. The first version of this guard logged the
 * refusal and carried on, on the premise that "there is nothing for this
 * execution to do about it". There is: STOP. The R3.5.7 verifier proved that a
 * refused execution ran on to insertContentItem, whose (job_id, cycle) upsert
 * overwrote the delivered draft — title, body, and an `approved` item's status
 * rewound to `awaiting_approval` — while the job row stayed pristine, so nothing
 * flagged it and startContentJob returned the item as a success. Protecting the
 * job row while destroying the artifact it exists to produce is worse than the
 * bug this task closed, because it is quieter.
 *
 * Caught ONLY by startContentJob's own catch, which turns it into a named
 * refusal with no failure write. It must never escape as an unhandled rejection:
 * the caller is fire-and-forget.
 */
export class JobNoLongerOursError extends Error {
  constructor(jobId, attemptedWrite, detail) {
    super(
      `job ${jobId} is no longer in a worker-owned status — refused ${attemptedWrite}` +
        (detail ? ` (${detail})` : "")
    );
    this.name = "JobNoLongerOursError";
    this.jobId = jobId;
    this.attemptedWrite = attemptedWrite;
    this.detail = detail || null;
  }
}

/**
 * Soft wall-clock budget for ONE INVOCATION, checked only at block boundaries
 * (where a checkpoint has just been persisted).
 *
 * R3.1.14 lowered this from 150_000 and re-based it on the INVOCATION's clock
 * rather than this job's own start. Both changes come from the same production
 * failure (2026-09-18 19:15 UTC): the cron sweep ran four jobs inline inside
 * one 300 s function, so each job's own 150 s budget was measured from a start
 * time that was already minutes into the invocation. Three of the four were
 * killed by `Vercel Runtime Timeout Error: Task timed out after 300 seconds`
 * having never once evaluated over budget — the platform cap arrived first and
 * no hand-off was ever reachable.
 *
 * The sweep now dispatches by fetch (src/app/api/content/worker/route.js), so
 * a job normally gets a whole invocation to itself; the budget is what decides
 * how much of that invocation one chunk may spend before checkpointing. 90 s
 * against `maxDuration = 300`: the check runs AFTER a block, so the remaining
 * 210 s has to absorb one more block that started just under the line (an LLM
 * block is tens of seconds) plus the checkpoint write, the lease release and
 * the hand-off fetch. Lower than the scan chunk's 150 s on purpose — a content
 * block is a much larger single unit than a scan batch, so the overshoot past
 * the line is larger and needs more headroom left behind it.
 */
export const CONTENT_CHUNK_BUDGET_MS = 90_000;

/**
 * R3.1.10 — the reason a content job advanced one function-lifetime per day.
 *
 * THE FINDING (production, 2026-09-16). GET /api/content/worker?batch=1 at
 * 01:00 UTC created six geo_article jobs and ran all six inside that one cron
 * invocation. Every one of them checkpointed and then stopped when the
 * function hit maxDuration — at researching, benchmarking, drafting,
 * reviewing. None reached a content_items row. Nothing resumed them until the
 * NEXT daily tick, because the only resume path was that cron: a six-block
 * pipeline therefore needed six days to produce one draft.
 *
 * THE FIX, mirroring the scan pipeline (R3.1.5 + R3.1.6) rather than inventing
 * anything: on hitting the soft budget above at a block boundary, the
 * invocation releases its lease, fires a fire-and-forget request at
 * CONTENT_WORKER_PATH?job_id=<id> carrying the cron secret and the deployment
 * protection bypass, and returns a CHECKPOINTED verdict instead of an item.
 * The receiving invocation resumes from the checkpoint. The job advances at
 * machine speed.
 *
 * The self-continue is an optimisation and never a guarantee: if it is refused
 * or lost, the job sits checkpointed with a free lease, its heartbeat goes
 * stale after CONTENT_HEARTBEAT_STALE_MS, and the existing daily sweep rescues
 * it exactly as before. That is why handOff() below warns loudly on every
 * failure path but never throws.
 *
 * R3.1.14 — WHY THIS WAS STILL UNREACHABLE IN PRODUCTION. The mechanism above
 * was correct and never fired: the cron sweep kept running every job INLINE in
 * its own invocation, so four pipelines shared one 300 s function and the
 * platform cap always arrived before any of them reached its budget. The sweep
 * now dispatches by fetch (dispatchBySelfContinue in
 * src/app/api/content/worker/route.js), so a job normally has an invocation to
 * itself, and the budget below is measured against that invocation's start.
 */
const contentSelfContinue = makeSelfContinue({
  routePath: CONTENT_WORKER_PATH,
  label: "content-worker",
});

function getCostCap() {
  const cap = Number(process.env.CONTENT_MAX_COST_PER_ITEM);
  return Number.isFinite(cap) && cap > 0 ? cap : 0.15;
}

function assertUnderCostCap(stats, step) {
  const cap = getCostCap();
  if ((stats.cost || 0) + (stats.prior_cost || 0) > cap) {
    throw new Error(
      `Cost cap exceeded after step "${step}": $${stats.cost.toFixed(4)} > $${cap} (CONTENT_MAX_COST_PER_ITEM)`
    );
  }
}

/**
 * Resolve the brand brief for a job: stored brief wins; otherwise seed from
 * the requested preset (first shipped preset: healthcare-cxo) and persist it
 * so Studio's brief editor starts from what the pipeline actually used.
 */
export async function resolveBrief(brand, input, deps = {}) {
  const get = deps.getBrandBrief || getBrandBrief;
  const upsert = deps.upsertBrandBrief || upsertBrandBrief;

  const stored = await get(brand);
  // The request brief must reach EVERY step, including draft and review. It is
  // run-specific, so never persist it over the workspace's durable brand brief.
  const requestFacts = typeof input?.brief === "string" ? input.brief.trim() : "";
  const withRequest = (brief) => requestFacts ? { ...brief, request_facts: requestFacts } : brief;
  const legacyHealthcareSeed = stored?.brief && input?.brand_profile !== "healthcare-cxo" &&
    stored.brief.one_liner === `${brand} — ${HEALTHCARE_CXO_BRIEF.one_liner}` &&
    Object.entries(HEALTHCARE_CXO_BRIEF).every(([key, value]) =>
      key === "one_liner" || JSON.stringify(stored.brief[key]) === JSON.stringify(value)
    );
  // Only replace the exact old automatically seeded preset. A customer-edited
  // healthcare brief (even one field changed) remains their source of truth.
  if (stored?.brief && !legacyHealthcareSeed) return withRequest(stored.brief);

  const preset = input?.brand_profile === "healthcare-cxo"
    ? HEALTHCARE_CXO_BRIEF
    : {
        one_liner: input?.brand_name || brand,
        website: input?.url || "",
        tone_rules: ["Use clear, factual language.", "Do not invent product claims, prices, certifications or customer results."],
      };
  const seeded = { ...preset };
  try {
    await upsert(brand, seeded);
  } catch (err) {
    console.warn("[content-worker] brief seed persist failed:", err.message);
  }
  return withRequest(seeded);
}

/** The agent config a job runs under: its snapshot, else the base default. */
export function resolveAgent(job) {
  if (job?.agent_snapshot && typeof job.agent_snapshot === "object") {
    return job.agent_snapshot;
  }
  return defaultAgentForBase(job?.playbook || "geo_article");
}

/**
 * Job-status string for a block (the coarse status the queue UI shows).
 * The mapping now lives in stages.js as data (T2) — this stays as the thin
 * adapter that supplies the block's kind for the fallback path.
 */
function statusForBlock(slug) {
  return stageForBlock(slug, getBlock(slug)?.kind);
}

function round4(n) {
  return Math.round((n || 0) * 10000) / 10000;
}

// --- Checkpoint helpers (R3.5.1) --------------------------------------------

/**
 * Build a checkpoint snapshot of the pipeline state. Written at every block
 * boundary so a killed worker's completed blocks are not re-paid on rescue.
 *
 * The shape mirrors scanWorker's checkpoint: an opaque JSON blob on the job
 * row that a rescuing execution reads to determine what to skip.
 *
 * `completedBlocks` uses slug-only IDs for Phase A blocks ("coordinate") and
 * cycle-suffixed IDs for Phase B loop blocks ("draft:1", "review:2").  The
 * cycle suffix lets the resumer distinguish draft-pass-1 from draft-pass-2
 * and skip only the ones that actually finished.
 */
function buildCheckpoint(pipeline, ctx, { completedBlocks, cycle, review, revisions }) {
  return {
    pipeline,
    completedBlocks: [...completedBlocks],
    cycle,
    review: review || null,
    revisions: [...(revisions || [])],
    // Context outputs the resumer needs to skip re-computation.
    workOrder: ctx.workOrder || null,
    researchPack: ctx.researchPack || null,
    benchmarkNotes: ctx.benchmarkNotes || null,
    draft: ctx.draft || null,
    factCheck: ctx.factCheck || null,
    critique: ctx.critique || "",
  };
}

/**
 * Run one block inside a ledger row (T3). Captures this block's own spend as
 * the delta of the shared `stats` accumulator across the call, so per-block
 * cost attribution needs no changes in the step modules themselves.
 *
 * The ledger is observability: insert/finish are fail-soft in db/content.js, a
 * null run id is tolerated here, and the cost CAP is still enforced from
 * `stats` by assertUnderCostCap — so a broken ledger can neither fail a job
 * nor let one overspend.
 */
async function withLedger({ jobId, brand, slug, cycle = 1, stats, deps = {} }, fn) {
  const open = deps.insertContentRun || insertContentRun;
  const close = deps.finishContentRun || finishContentRun;

  const run = await open({ job_id: jobId, brand, block: slug, cycle }, deps);
  const costBefore = stats.cost || 0;
  const tokensBefore = stats.tokens || 0;
  const delta = () => ({
    cost: round4((stats.cost || 0) - costBefore),
    tokens: (stats.tokens || 0) - tokensBefore,
  });

  try {
    const out = await fn();
    await close(run?.id, { status: "succeeded", ...delta() }, deps);
    return out;
  } catch (err) {
    await close(run?.id, { status: "failed", ...delta(), error: err.message || "failed" }, deps);
    throw err;
  }
}

/**
 * Run (or resume) one content job for at most one function lifetime.
 *
 * FIVE outcomes, and a caller must be able to tell them apart (standing rule 1):
 *   - a `content_items` row  — the job finished and is awaiting approval;
 *   - `null`                 — the job failed, or was not ours to run (lease);
 *   - `{ checkpointed: true, after, blocks_run, self_continue }` (R3.1.10) —
 *     the job hit its soft chunk budget at a block boundary, persisted a
 *     checkpoint, released its lease and handed itself to a fresh invocation
 *     via CONTENT_WORKER_PATH. Real progress was made and more remains.
 *   - `{ refused: true, reason: "no_longer_ours", job_id, attempted_write, detail }`
 *     (R3.5.7) — the database refused a guarded write mid-run: another execution
 *     delivered the job while this one was working. This run STOPPED before the
 *     item write; the delivered item was not touched.
 *   - `{ refused: true, reason: "already_delivered", job_id, status, item_id }`
 *     (R3.5.7) — the row has an item_id and a status past the worker's hands,
 *     so it already delivered; nothing ran and nothing was spent. A refusal is
 *     a SKIP, not a success and not an exception: the `?job_id=` route reports
 *     it as one.
 *
 * Both live call sites (POST /api/content and the worker route's
 * dispatchWithLease) are fire-and-forget and ignore the return; the shape
 * exists so tests and any future caller cannot read "handed off" as "done".
 */
export async function startContentJob(jobId, deps = {}) {
  const stats = { cost: 0, tokens: 0 };

  const update = deps.updateContentJob || updateContentJob;

  // --- Cost across attempts (R3.3.3) --------------------------------------
  // `stats` is THIS EXECUTION's spend. `cost_total` on the row is the JOB's
  // spend, and a job can be executed more than once: the cron rescues a job
  // whose worker died (db/content.js shouldRescueContentJob → the route's
  // dispatchWithLease) and re-runs the pipeline from the top, paying for every
  // block a second time. Writing `cost_total: stats.cost` reported the LAST
  // attempt and deleted every earlier one, so a job that cost twice looked
  // like it cost once.
  //
  // Two halves, and only both together make the row a sum:
  //   (a) `costBase` — what the row already recorded before this execution
  //       began. Every write below is base + this execution's spend, so a
  //       rescue ADDS to the earlier attempts instead of replacing them. The
  //       written value is absolute rather than a delta, so re-writing it
  //       (every block boundary, plus the terminal write) cannot double-count.
  //   (b) folding as we go — a killed attempt is exactly the case rescues
  //       exist for, and it never reaches a terminal write. Spend recorded
  //       only at the end therefore dies with the process and the "sum" is
  //       short by a whole attempt. Every job write now carries the running
  //       total, so a killed attempt leaves behind what it really spent. The
  //       residual window is one block: spend between a block finishing and
  //       the next status write, which is microseconds.
  //
  // NOT an atomic increment, because the storage layer does not offer one:
  // supabase-js has no `cost_total = cost_total + $1` expression and there is
  // no RPC for content_jobs (the repo's atomic writes — claim_scan_job_attempt,
  // increment_scan_rate_limit — are all SQL functions this table has none of).
  // This is a read-modify-write with the read at attempt start, so a second
  // writer during the attempt would be clobbered. The job lease makes that
  // structurally impossible for two executions of the same job, and
  // reviseContentItem only folds into jobs that have reached
  // awaiting_approval, which is not a rescuable status. A zombie that lost its
  // lease and kept running is the one case that can still lose an update.
  let costBase = null; // null = the row's recorded total is not known yet

  /**
   * The `cost_total` field for a job write: the row's prior total plus what
   * this execution has spent so far. Before the job row is read we do not KNOW
   * the prior total, and writing 0 there would erase the earlier attempts we
   * exist to preserve — so the field is omitted entirely rather than guessed.
   */
  const costFields = () =>
    costBase === null ? {} : { cost_total: round4(costBase + (stats.cost || 0)) };

  // --- Lease: structural single-flight (T1) -------------------------------
  // The cron may have already won the lease and hands its owner id down via
  // deps.leaseOwner; a direct dispatch (POST /api/content) acquires one here.
  // Either way, exactly one execution of this job can be in flight — before
  // this, two overlapping dispatches each ran the full pipeline against one
  // row, each spending up to the per-item cap (D1).
  const leaseOwner = deps.leaseOwner || newLeaseOwner("job");
  const acquire = deps.acquireLease || acquireLease;
  const renew = deps.renewLease || renewLease;
  const release = deps.releaseLease || releaseLease;
  if (!deps.leaseOwner) {
    let won = null;
    try {
      won = await acquire("content_jobs", jobId, leaseOwner, deps);
    } catch (err) {
      // Fail CLOSED: without proven exclusivity we must not spend budget.
      console.error(`[content-worker] lease acquire failed for job ${jobId}:`, err.message);
      return null;
    }
    if (!won) {
      console.log(`[content-worker] job ${jobId} is already leased — skipping duplicate start`);
      return null;
    }
  }

  let trace = initTrace();
  // Last status THIS execution wrote — the `from` side of the transition check.
  let lastStatus = null;

  // Every job update also flushes the live trace so the theater sees each
  // specialist transition in real time, and renews the lease so a job that is
  // genuinely progressing never loses it (L3).
  const writeJob = async (fields) => {
    if (fields.status) {
      // Warn, never throw (L6): inside a fire-and-forget worker an exception
      // here would turn a bookkeeping bug into a lost job. Tests assert
      // legality; production gets a loud line naming the illegal edge.
      if (!isLegalTransition(lastStatus, fields.status)) {
        console.warn(
          `[content-worker] job ${jobId}: illegal transition ` +
            `${lastStatus || "(none)"} → ${fields.status} — see content/stages.js`
        );
      }
      lastStatus = fields.status;
    }
    // costFields() rides on every job write, not just the terminal one — see
    // (b) above: a worker that is killed mid-pipeline still leaves its spend
    // on the row, which is what makes the rescued total a sum.
    //
    // R3.5.7 — EVERY STATUS WRITE IS CONDITIONAL. `ifStatusIn` makes the UPDATE
    // apply only while the row is still in a worker-owned status, so a second
    // execution can no longer write `reviewing`/`drafting` over a row that has
    // reached `awaiting_approval` with an item. The precondition is evaluated
    // by the database inside the same statement (see updateContentJob) — a
    // read-then-write here would leave the race open. Writes with no `status`
    // field (trace/cost/checkpoint flushes) stay unconditional: they cannot
    // rewind a lifecycle.
    const result = await update(
      jobId,
      { ...fields, ...costFields(), agent_trace: trace },
      fields.status ? { ...deps, ifStatusIn: CONTENT_JOB_RUNNING } : deps
    );
    if (result?.refused) {
      // ABORT. The row is no longer ours, so every further step of this
      // execution — above all insertContentItem — would be done to a job
      // someone else already delivered. See JobNoLongerOursError for what
      // "log and continue" cost. The throw is caught by startContentJob's own
      // catch and becomes a named refusal; it is not a lost job, because the
      // job is not lost: it is delivered.
      console.error(
        `[content-worker] job ${jobId}: REFUSED the write of status "${fields.status}" — the row ` +
          `is no longer in a worker-owned status (${CONTENT_JOB_RUNNING.join("|")}). ` +
          `${result.detail}. Stopping this execution before it can touch the delivered item (R3.5.7).`
      );
      throw new JobNoLongerOursError(jobId, `status "${fields.status}"`, result.detail);
    }
    renew("content_jobs", jobId, leaseOwner, deps).catch((err) =>
      console.warn(`[content-worker] lease renew failed for job ${jobId}:`, err.message)
    );
    return result;
  };

  // --- Chunking (R3.1.10) --------------------------------------------------
  // This invocation's own clock. `deps.now` is the soft-budget clock and tests
  // drive it at fake speed; it is deliberately NOT used for heartbeats or
  // leases, which must stay on real time.
  const nowFn = deps.now || Date.now;
  const chunkStartMs = nowFn();
  // R3.1.14 — the budget is measured from the INVOCATION's start, not from
  // this job's start, whenever the caller can tell us when the invocation
  // began (the route passes `invocationStartMs`; see
  // src/app/api/content/worker/route.js). The platform cap applies to the
  // function, so a job that begins 200 s into a 300 s invocation has 100 s of
  // real headroom no matter what its own clock says. With no caller-supplied
  // value this falls back to chunkStartMs — identical to the old behaviour for
  // a job that IS the invocation.
  //
  // One clock, not two: `invocationStartMs` must come from the same clock as
  // `deps.now` (tests drive both at fake speed; production uses Date.now for
  // both).
  const invocationStartMs = Number.isFinite(deps.invocationStartMs)
    ? deps.invocationStartMs
    : chunkStartMs;
  const budgetMs = Number.isFinite(deps.chunkBudgetMs) ? deps.chunkBudgetMs : CONTENT_CHUNK_BUDGET_MS;
  const selfContinue = deps.selfContinue || contentSelfContinue;
  // Blocks THIS invocation actually ran. A hand-off is only legal after real
  // progress, so two invocations can never ping-pong a job forward zero
  // blocks at a time however the budget is configured.
  let blocksRun = 0;
  const overBudget = () => blocksRun > 0 && nowFn() - invocationStartMs >= budgetMs;
  // Set only once handOff has PROVEN the lease is gone, so the `finally` below
  // skips a redundant write — and still retries if handOff's release failed.
  let leaseAlreadyReleased = false;

  /**
   * Hand this job to a fresh invocation and stop working, having just
   * persisted a checkpoint.
   *
   * ORDER MATTERS, and this is the lease-continuity decision (R3.1.10):
   * RELEASE FIRST, then fire. The receiving invocation acquires its own fresh
   * lease through the route's dispatchWithLease; if we still held ours when it
   * arrived it would lose the acquire, report `lease_held`, and the job would
   * stall until our lease expired — turning the fix into a slower version of
   * the bug. Releasing first also means two invocations can never work the
   * same job at once: we do nothing after this point except return, and the
   * `finally` release below is owner-scoped (`.eq("lease_owner", owner)`) so
   * it cannot take the lease away from whoever has it next.
   *
   * If the release fails we STILL fire — the receiver will simply be refused
   * and the daily sweep rescues the job one lease TTL later — but we say so.
   */
  const handOff = async (after) => {
    let released = false;
    try {
      released = await release("content_jobs", jobId, leaseOwner, deps);
    } catch (err) {
      console.error(
        `[content-worker] job ${jobId}: could not release the lease before handing off after ` +
          `"${after}" (${err.message}). The self-continue will be refused as lease_held and this ` +
          `job resumes on the cron sweep after the lease expires.`
      );
    }
    leaseAlreadyReleased = released;
    if (!released) {
      console.warn(
        `[content-worker] job ${jobId}: the lease was not ours to release when handing off after ` +
          `"${after}" — another worker may already hold it. Firing the self-continue anyway; ` +
          `whichever invocation holds the lease is the one that will do the work.`
      );
    }

    const fired = selfContinue(jobId);
    console.log(
      `[content-worker] Job ${jobId} hit its ${budgetMs}ms chunk budget after "${after}" ` +
        `(${blocksRun} block(s) this invocation) — checkpointed and handed off to ` +
        `${CONTENT_WORKER_PATH}?job_id=... self_continue_fired=${fired?.fired === true}` +
        (fired?.reason ? ` reason=${fired.reason}` : "")
    );
    // NOT an item and NOT null: "checkpointed, more work to do" is a third
    // outcome and must not be readable as either success or failure.
    return {
      checkpointed: true,
      job_id: jobId,
      after,
      blocks_run: blocksRun,
      self_continue: fired || { fired: false, reason: "no_verdict" },
    };
  };

  try {
    const job = deps.job || (await (deps.getContentJob || getContentJob)(jobId, deps));
    if (!job) throw new Error(`content job ${jobId} not found`);

    // --- Already delivered? (R3.5.7) ---------------------------------------
    // A job whose status is past the worker's hands (awaiting_approval and
    // everything beyond it — the list is DERIVED in stages.js, never a second
    // copy) AND which carries an item_id has DELIVERED. Re-running it can only
    // duplicate spend and fight its own content_items row, and the write that
    // put it back into a running status is exactly the damage R3.5.6 stopped
    // re-dispatching. Before this check, startContentJob read the row without
    // ever looking at its status and started the pipeline from the top.
    //
    // A FOURTH OUTCOME, deliberately not null and not an item: a refusal is not
    // a failure and not a success (standing rule 1). The route reports it as a
    // named skip.
    if (isDeliveredContentJob(job)) {
      console.warn(
        `[content-worker] job ${jobId}: REFUSING to run — status "${job.status}" with item_id ` +
          `${job.item_id} means it already delivered. Re-running would re-pay for a draft that ` +
          `exists and fight its own item row (R3.5.7).`
      );
      return {
        refused: true,
        reason: "already_delivered",
        job_id: jobId,
        status: job.status,
        item_id: job.item_id,
      };
    }

    // What earlier attempts already spent. From here on every job write adds
    // this execution's spend to it instead of overwriting it.
    const recordedCost = Number(job.cost_total);
    if (job.cost_total != null && !Number.isFinite(recordedCost)) {
      console.warn(
        `[content-worker] job ${jobId}: cost_total is not a number ` +
          `(${typeof job.cost_total}) — this attempt's spend is added to 0 and ` +
          `whatever earlier attempts recorded is NOT represented in the total`
      );
    }
    costBase = Number.isFinite(recordedCost) ? recordedCost : 0;
    if(costBase >= getCostCap())throw new Error("Content item budget exhausted before resume");

    stats.prior_cost=costBase;
    const { brand, playbook, input } = job;
    const agent = resolveAgent(job);
    // Pipelines without a fact-check block deliver an unchecked draft; the
    // exact-version approval gate requires a separate saved-draft check.
    const pipeline = resolvePipeline(agent);
    trace = initTrace(pipeline);

    console.log(
      `[content-worker] Starting job ${jobId}: ${brand} / ${playbook} / agent="${agent.name}" ` +
        `format=${agent.format} pipeline=[${pipeline.join(" → ")}]`
    );

    // Assemble the inherited context every step gets.
    const brief = await resolveBrief(brand, input, deps);
    const lessons = await (deps.listLessons || listLessons)(brand, playbook, {
      activeOnly: true,
    }, deps);
    // R2.8.4: a scan-read failure throws and is caught by this function’s own
    // catch, which marks the job `failed` with the reason and releases the
    // lease. That is the right outcome, not a regression: drafting against
    // `scan: null` would spend the full LLM budget producing content with no
    // gap context, and could not be persisted anyway with the DB down.
    const scans = await (deps.getScansForBrand || getScansForBrand)(brand, deps);
    const scan = scans?.[0] || null;
    const knowledgeBlocks = await (deps.listKnowledgeBlocks || listKnowledgeBlocks)(brand, {
      activeOnly: true,
    }, deps);

    const ctx = {
      brand,
      playbook,
      agent,
      input: input || {},
      brief,
      lessons,
      scan,
      stats,
      critique: "",
      knowledge: formatKnowledge(knowledgeBlocks),
    };

    // --- Checkpoint restore (R3.5.1) ----------------------------------------
    // A rescued job carries a checkpoint written at each block boundary by the
    // prior (killed) execution.  We restore the accumulated context so later
    // blocks can run without re-calling the LLM for earlier ones, and mark the
    // completed blocks in the trace so the theater shows honest history.
    const checkpoint = job.checkpoint || null;
    const completedBlocks = checkpoint
      ? new Set(checkpoint.completedBlocks || [])
      : new Set();
    if (checkpoint) {
      if (checkpoint.workOrder) ctx.workOrder = checkpoint.workOrder;
      if (checkpoint.researchPack) ctx.researchPack = checkpoint.researchPack;
      if (checkpoint.benchmarkNotes) ctx.benchmarkNotes = checkpoint.benchmarkNotes;
      if (checkpoint.draft) ctx.draft = checkpoint.draft;
      if (checkpoint.factCheck) ctx.factCheck = checkpoint.factCheck;
      if (checkpoint.critique) ctx.critique = checkpoint.critique;
      // Populate the trace for every block the prior execution completed.
      for (const blockId of completedBlocks) {
        markDone(trace, blockId.replace(/:\d+$/, ""), "(completed before resume)");
      }
    }

    // Progress: distribute 8→92% across the pipeline's blocks.
    const pctFor = (idx) => 8 + Math.round((idx / pipeline.length) * 84);

    // --- Phase A: context blocks (everything before the Writer) ---
    const draftIdx = pipeline.indexOf("draft");
    for (let i = 0; i < draftIdx; i++) {
      const slug = pipeline[i];

      // R3.5.1 — skip blocks already completed by a prior execution.
      if (completedBlocks.has(slug)) {
        if (checkpoint) {
          console.log(`[content-worker] Job ${jobId}: resuming — block "${slug}" already completed`);
        }
        continue;
      }

      markWorking(trace, slug);
      await writeJob({ status: statusForBlock(slug), progress_pct: pctFor(i) });

      const ledger = { jobId, brand, slug, stats, deps };
      if (slug === "coordinate") {
        ctx.workOrder = await withLedger(ledger, () => runCoordinate(ctx, deps));
        markDone(trace, slug, summarizeCoordinate(ctx.workOrder));
      } else if (slug === "research") {
        ctx.researchPack = await withLedger(ledger, () => runResearch(ctx, deps));
        markDone(trace, slug, summarizeResearch(ctx.researchPack));
      } else if (slug === "benchmark") {
        ctx.benchmarkNotes = await withLedger(ledger, () => runBenchmark(ctx, deps));
        markDone(trace, slug, summarizeBenchmark(ctx.benchmarkNotes, playbook));
      }
      assertUnderCostCap(stats, slug);

      // R3.5.1 — persist checkpoint after each completed block.
      completedBlocks.add(slug);
      blocksRun += 1;
      await writeJob({
        checkpoint: buildCheckpoint(pipeline, ctx, {
          completedBlocks: [...completedBlocks], cycle: 0, review: null, revisions: [],
        }),
      });

      // R3.1.10 — the checkpoint above is durable, so this is a safe place to
      // stop. Returning here runs the `finally` release, which is a no-op
      // after handOff's own release.
      if (overBudget()) return await handOff(slug);
    }

    // Removed context blocks leave honest holes the prompts flag themselves.
    if (!ctx.researchPack) {
      ctx.researchPack = { sources: [], stats: [], quotes: [], paa: [], angles: [], unsupported_subqueries: [] };
    }
    if (!ctx.benchmarkNotes) ctx.benchmarkNotes = { directive: "(no benchmark block in this pipeline)" };

    // --- Phase B: Writer → transforms → checks → Editor (bounded loop) ---
    // Post-draft blocks between the Writer and the Editor:
    const midBlocks = pipeline.slice(draftIdx + 1, pipeline.length - 1);
    const revisions = checkpoint?.revisions ? [...checkpoint.revisions] : [];
    let draft = checkpoint?.draft || null;
    let review = checkpoint?.review || null;
    let factCheck = checkpoint?.factCheck || null;
    let cycles = checkpoint?.cycle || 0;

    // R3.5.1 — determine whether the loop needs to run at all.  If the
    // checkpoint's last cycle already produced a terminal verdict or the
    // revision budget is exhausted, skip the loop entirely.
    let enterLoop = true;
    let midCycleResume = false; // true when draft is done but review isn't for the current cycle
    if (review && completedBlocks.has(`review:${cycles}`)) {
      if (review.verdict === "pass" || review.ymyl_violation) {
        enterLoop = false;
      } else if (cycles >= MAX_DRAFT_REVIEW_CYCLES) {
        enterLoop = false;
      } else {
        // Last review failed, budget remains — archive the revision and advance.
        revisions.push({
          revision: cycles - 1,
          title: draft.title,
          body_md: draft.body_md,
          rubric: review,
          critique: review.critique,
        });
        ctx.critique = review.critique;
      }
    } else if (cycles > 0 && completedBlocks.has(`draft:${cycles}`)) {
      // Draft done but review not — resume at the review step of this cycle.
      midCycleResume = true;
    }

    while (enterLoop && cycles < MAX_DRAFT_REVIEW_CYCLES) {
      if (!midCycleResume) cycles += 1;
      midCycleResume = false; // consumed — subsequent iterations increment normally

      // --- Draft ---
      const draftBlockId = `draft:${cycles}`;
      if (!completedBlocks.has(draftBlockId)) {
        bumpCycle(trace, "draft", cycles);
        markWorking(
          trace,
          "draft",
          cycles === 1 ? crewMember("draft").verb : `Redrafting from the critique (pass ${cycles})`
        );
        await writeJob({ status: "drafting", progress_pct: cycles === 1 ? pctFor(draftIdx) : 84 });
        draft = await withLedger(
          { jobId, brand, slug: "draft", cycle: cycles, stats, deps },
          () => runDraft(ctx, deps)
        );
        assertUnderCostCap(stats, "draft");
        markDone(trace, "draft", summarizeDraft(draft, cycles));
        ctx.draft = draft;
        // R3.5.1 — checkpoint after draft completes.
        completedBlocks.add(draftBlockId);
        blocksRun += 1;
        await writeJob({
          checkpoint: buildCheckpoint(pipeline, ctx, {
            completedBlocks: [...completedBlocks], cycle: cycles, review, revisions,
          }),
        });
        // R3.1.10 — hand off after the draft; the resumer re-enters the loop
        // at this cycle's review step (midCycleResume above).
        if (overBudget()) return await handOff(draftBlockId);
      } else if (checkpoint) {
        console.log(`[content-worker] Job ${jobId}: resuming — draft cycle ${cycles} already completed`);
      }

      // Transforms + fact-check run on the FIRST pass only; a revision cycle
      // goes straight back to the Editor (cost-bounded, documented behavior).
      if (cycles === 1) {
        for (let m = 0; m < midBlocks.length; m++) {
          const slug = midBlocks[m];
          const blockId = `${slug}:1`;

          // R3.5.1 — skip completed mid-blocks.
          if (slug==="fact_check" && !isCurrentCheck(factCheck,draft,ctx.researchPack)) completedBlocks.delete(blockId);
          if (completedBlocks.has(blockId)) {
            if (checkpoint) {
              console.log(`[content-worker] Job ${jobId}: resuming — block "${slug}" already completed`);
            }
            continue;
          }

          const block = getBlock(slug);
          markWorking(trace, slug);
          await writeJob({ status: statusForBlock(slug), progress_pct: pctFor(draftIdx + 1 + m) });

          const midLedger = { jobId, brand, slug, stats, deps };
          if (block.kind === "transform") {
            draft = await withLedger(midLedger, () => runTransform(ctx, slug, deps));
            ctx.draft = draft;
            markDone(trace, slug, summarizeTransform(block, draft));
          } else if (slug === "fact_check") {
            factCheck = await withLedger(midLedger, () => runFactCheck(ctx, deps));
            markDone(trace, slug, summarizeFactCheck(factCheck));
            // The Editor sees the fact-checker's findings.
            ctx.factCheck = factCheck;
          }
          assertUnderCostCap(stats, slug);
          // R3.5.1 — checkpoint after mid-block completes.
          completedBlocks.add(blockId);
          blocksRun += 1;
          await writeJob({
            checkpoint: buildCheckpoint(pipeline, ctx, {
              completedBlocks: [...completedBlocks], cycle: cycles, review, revisions,
            }),
          });
          // R3.1.10 — hand off between transforms/fact-check.
          if (overBudget()) return await handOff(blockId);
        }
      }

      // --- Review ---
      const reviewBlockId = `review:${cycles}`;
      if (!completedBlocks.has(reviewBlockId)) {
        bumpCycle(trace, "review", cycles);
        markWorking(
          trace,
          "review",
          cycles === 1 ? crewMember("review").verb : `Re-scoring the redraft (pass ${cycles})`
        );
        await writeJob({ status: "reviewing", progress_pct: cycles === 1 ? pctFor(pipeline.length - 1) : 92 });
        review = await withLedger(
          { jobId, brand, slug: "review", cycle: cycles, stats, deps },
          () => runReview({ ...ctx, draft }, deps)
        );
        assertUnderCostCap(stats, "review");
        markDone(trace, "review", summarizeReview(review));
        // R3.5.1 — checkpoint after review completes.
        completedBlocks.add(reviewBlockId);
        blocksRun += 1;
        await writeJob({
          checkpoint: buildCheckpoint(pipeline, ctx, {
            completedBlocks: [...completedBlocks], cycle: cycles, review, revisions,
          }),
        });
      } else if (checkpoint) {
        console.log(`[content-worker] Job ${jobId}: resuming — review cycle ${cycles} already completed`);
      }

      if (review.verdict === "pass") break;

      // YMYL can never be auto-revised into a pass — human decides.
      if (review.ymyl_violation) {
        console.warn(
          `[content-worker] Job ${jobId}: YMYL violation flagged — routing to human queue without auto-revision`
        );
        break;
      }

      // R3.1.10 — the ONLY hand-off point after a review, and deliberately
      // below the two terminal-verdict breaks above: a pass or a YMYL flag is
      // one non-LLM insert away from an item, so stopping there would cost a
      // round trip and buy nothing. Here another full draft+review cycle is
      // about to start, which is exactly what does not fit.
      if (cycles < MAX_DRAFT_REVIEW_CYCLES && overBudget()) {
        return await handOff(reviewBlockId);
      }

      if (cycles < MAX_DRAFT_REVIEW_CYCLES) {
        revisions.push({
          revision: cycles - 1,
          title: draft.title,
          body_md: draft.body_md,
          rubric: review,
          critique: review.critique,
        });
        ctx.critique = review.critique;
      }
    }

    // Fold independent fact-check findings into the rubric so the human sees
    // them alongside the Editor's violations.
    const factCheckViolations = (factCheck?.issues || []).map((i) => ({
      rule: `fact_check:${i.kind}`,
      detail: `"${i.claim}" — ${i.problem}`,
      ymyl: false,
    }));

    const belowThreshold = review.verdict !== "pass" || factCheck?.passed === false;
    const rubric = {
      ...review,
      violations: [...(review.violations || []), ...factCheckViolations],
      fact_check: factCheck ? { passed: factCheck.passed, issue_count: factCheck.issues.length } : undefined,
      below_threshold: belowThreshold,
      cycles,
      check: draftCheck(draft,ctx.researchPack,factCheck),
    };

    // R3.5.7 — STILL OURS? The last status write ("reviewing") can be minutes
    // old: the review LLM call and the fact-check sit between it and here. If
    // another execution delivered this job in that window, the upsert below
    // would overwrite the draft a human may already be reading. A guarded
    // write with NO status field asks the database, atomically, whether the row
    // is still in a worker-owned status; a refusal aborts before the item is
    // touched. This narrows the window from minutes to the milliseconds between
    // this statement and the next — it does not close it. What closes it is the
    // lease (single-flight), and this is the backstop for when the lease lapsed.
    //
    // `ownershipProbe: true` is an INERT MARKER: nothing in src/lib/db/content.js
    // reads it. It exists so a test can tell this write from an ordinary trace
    // flush. The mechanism is `ifStatusIn`, and only `ifStatusIn`.
    const stillOurs = await update(
      jobId,
      { ...costFields(), agent_trace: trace },
      { ...deps, ifStatusIn: CONTENT_JOB_RUNNING, ownershipProbe: true }
    );
    if (stillOurs?.refused) {
      console.error(
        `[content-worker] job ${jobId}: the pre-item ownership check was REFUSED — the row left the ` +
          `worker-owned statuses while this execution was reviewing (${stillOurs.detail}). ` +
          `Stopping before the item write (R3.5.7).`
      );
      throw new JobNoLongerOursError(jobId, "the item write", stillOurs.detail);
    }

    // 5. Queue for human approval — the gate is mandatory and terminal.
    const item = await (deps.insertContentItem || insertContentItem)({
      job_id: jobId,
      brand,
      playbook,
      agent_id: job.agent_id || null,
      agent_snapshot: agent,
      title: draft.title,
      body_md: draft.body_md,
      research_pack: ctx.researchPack,
      // The work order rides inside benchmark_notes so the human-feedback
      // revision path (reviseContentItem) can rebuild the draft context.
      benchmark_notes: { ...ctx.benchmarkNotes, work_order: ctx.workOrder },
      rubric,
      cycle: cycles,
      revision: revisions.length,
      revisions,
      target_queries: ctx.workOrder?.target_queries || [],
      status: "awaiting_approval",
    }, deps);

    // cost_total comes from costFields() inside writeJob: base + this
    // execution's spend. Writing `stats.cost` here is what dropped every
    // earlier attempt on the floor.
    await writeJob({
      status: "awaiting_approval",
      progress_pct: 100,
      item_id: item.id,
    });

    console.log(
      `[content-worker] Job ${jobId} queued for approval. verdict=${review.verdict}` +
        ` weighted=${review.weighted_total} ymyl=${review.ymyl_violation}` +
        ` cycles=${cycles} cost=$${(stats.cost || 0).toFixed(4)}` +
        ` job_total=$${round4(costBase + (stats.cost || 0)).toFixed(4)}`
    );

    return item;
  } catch (error) {
    // R3.5.7 — not a failure, and handled BEFORE anything below: no trace is
    // marked failed and NO failure write is attempted, because the row this
    // execution would mark is someone else's delivered job. A FIFTH outcome
    // beside item / null / checkpointed / already_delivered: "stopped, because
    // the job was delivered out from under us". Never null (that reads as a
    // failure to retry) and never an item (that is the fabricated success the
    // verifier caught).
    if (error instanceof JobNoLongerOursError) {
      return {
        refused: true,
        reason: "no_longer_ours",
        job_id: jobId,
        attempted_write: error.attemptedWrite,
        detail: error.detail,
      };
    }
    console.error(`[content-worker] Job ${jobId} failed:`, error);
    // Mark whichever specialist was mid-flight as failed for the theater.
    const active = trace.find((t) => t.status === "working");
    if (active) markFailed(trace, active.step, error.message || "failed");
    // costFields() is empty when the job row was never read (a failure before
    // or at getContentJob): we do not know what the row already holds, and
    // writing 0 would erase an earlier attempt's spend. Omitting the field
    // leaves the recorded total untouched instead of silently zeroing it.
    //
    // R3.5.7 — guarded like every other status write (see writeJob): a late
    // failure must not stamp `failed` over a row that has already reached the
    // human gate. `refused` here means the row was not ours to mark; it is
    // reported, never swallowed.
    const failWrite = await update(jobId, {
      status: "failed",
      progress_pct: 100,
      error_message: error.message || "Unexpected content pipeline error.",
      ...costFields(),
      agent_trace: trace,
    }, { ...deps, ifStatusIn: CONTENT_JOB_RUNNING });
    if (failWrite?.refused) {
      console.error(
        `[content-worker] job ${jobId}: the failure write was REFUSED — the row is no longer in a ` +
          `worker-owned status (${failWrite.detail}). The job row keeps the status it reached; ` +
          `this execution's error was: ${error.message || "failed"}`
      );
    }
    return null;
  } finally {
    // Release on EVERY terminal outcome, success or failure. Without this a
    // job that crashed and needs a retry would sit out the full lease TTL for
    // no reason, and a finished job would look busy to the rescue sweep.
    //
    // R3.1.10 — a hand-off released the lease itself, BEFORE firing the
    // self-continue (see handOff). Re-releasing would be a wasted write; it
    // could not steal the lease back from the receiving invocation (the UPDATE
    // is scoped to our own owner id), but the write is pointless and its
    // failure warning would be misleading. If handOff's release did NOT
    // succeed, this still runs — that is the retry.
    try {
      if (!leaseAlreadyReleased) await release("content_jobs", jobId, leaseOwner, deps);
    } catch (err) {
      console.warn(`[content-worker] lease release failed for job ${jobId}:`, err.message);
    }
  }
}

/**
 * Human-feedback revision: on "request changes", redraft the item with the
 * reviewer's comment as the critique, re-review once, and return it to the
 * approval queue. One cycle only — the human gate re-applies regardless of
 * verdict, so there is nothing for an auto-loop to add here.
 */
export async function reviseContentItem(itemId, comment, deps = {}) {
  const stats = { cost: 0, tokens: 0 };
  const getItem = deps.getContentItem || getContentItem;
  const updateItem = deps.updateContentItem || updateContentItem;

  const item = await getItem(itemId, deps);
  if (!item) throw new Error(`content item ${itemId} not found`);

  const { brand, playbook } = item;
  console.log(`[content-worker] Revising item ${itemId} from human feedback`);

  const brief = await resolveBrief(brand, {}, deps);
  const lessons = await (deps.listLessons || listLessons)(brand, playbook, {
    activeOnly: true,
  }, deps);
  // R2.8.4: this read sits BEFORE the try below, so a scan-read failure
  // propagates to the caller (POST /api/content-items/[id]/decision, which
  // logs it against the item id). Deliberate: it fails before any LLM spend
  // instead of redrafting blind and failing at the write anyway.
  const scans = await (deps.getScansForBrand || getScansForBrand)(brand, deps);

  const benchmarkNotes = { ...(item.benchmark_notes || {}) };
  const workOrder =
    benchmarkNotes.work_order || {
      angle: item.title || "revise per feedback",
      title_hint: item.title || "",
      target_queries: item.target_queries || [],
      fan_out: [],
      sections: [],
      hook_thesis: "",
      post_shape: "",
      notes: "",
    };
  delete benchmarkNotes.work_order;

  const agent = item.agent_snapshot || defaultAgentForBase(playbook);
  const knowledgeBlocks = await (deps.listKnowledgeBlocks || listKnowledgeBlocks)(brand, {
    activeOnly: true,
  }, deps);

  const ctx = {
    brand,
    playbook,
    agent,
    input: {},
    brief,
    lessons,
    scan: scans?.[0] || null,
    stats,
    knowledge: formatKnowledge(knowledgeBlocks),
    workOrder,
    researchPack: item.research_pack,
    benchmarkNotes,
    critique:
      `HUMAN REVIEWER FEEDBACK (verdict: changes_requested) — this outranks ` +
      `every automated critique. Address every point:\n${comment}`,
  };

  // Revision spend is ledgered against the originating job under the next
  // cycle number, so a job's execution history includes human-driven passes.
  const revCycle = (item.revision || 0) + 1;
  const revLedger = (slug) => ({ jobId: item.job_id, brand, slug, cycle: revCycle, stats, deps });

  const originalJob=item.job_id ? await (deps.getContentJob || getContentJob)(item.job_id,deps) : null;
  stats.prior_cost=Number(originalJob?.cost_total || 0);
  assertUnderCostCap(stats,"before human revision");
  try {
    const draft = await withLedger(revLedger("draft"), () => runDraft(ctx, deps));
    assertUnderCostCap(stats, "draft(revision)");
    const factCheck = await withLedger(revLedger("fact_check"),()=>runFactCheck({...ctx,draft},deps));
    assertUnderCostCap(stats,"fact_check(revision)");
    const review = await withLedger(revLedger("review"), () => runReview({ ...ctx, draft, factCheck }, deps));
    review.check=draftCheck(draft,ctx.researchPack,factCheck);
    review.fact_check={passed:factCheck.passed,issues:factCheck.issues};
    review.below_threshold=review.verdict!=="pass" || !factCheck.passed;
    assertUnderCostCap(stats, "review(revision)");

    const revisions = [
      ...(item.revisions || []),
      {
        revision: item.revision || 0,
        title: item.title,
        body_md: item.body_md,
        rubric: item.rubric,
        critique: comment,
        source: "human_feedback",
      },
    ];

    const updated = await updateItem(itemId, {
      title: draft.title,
      body_md: draft.body_md,
      benchmark_notes: { ...benchmarkNotes, work_order: workOrder },
      rubric: {
        ...review,
        below_threshold: review.verdict !== "pass",
        cycles: 1,
        revised_from_feedback: true,
      },
      revision: (item.revision || 0) + 1,
      revisions,
      status: "awaiting_approval",
    }, deps);

    // Fold revision spend into the originating job's total.
    if (item.job_id) {
      try {
        const job = await (deps.getContentJob || getContentJob)(item.job_id, deps);
        const prev = Number(job?.cost_total) || 0;
        await (deps.updateContentJob || updateContentJob)(item.job_id, {
          status: "awaiting_approval",
          cost_total: Math.round((prev + stats.cost) * 10000) / 10000,
        }, deps);
      } catch (err) {
        console.warn("[content-worker] revision cost fold failed:", err.message);
      }
    }

    console.log(
      `[content-worker] Item ${itemId} revised. verdict=${review.verdict} cost=$${stats.cost.toFixed(4)}`
    );
    return updated;
  } catch (error) {
    console.error(`[content-worker] Revision of item ${itemId} failed:`, error);
    // Leave the item visible in the queue with its previous draft rather
    // than losing it — the human can retry or edit manually.
    await updateItem(itemId, { status: "awaiting_approval" }, deps);
    return null;
  }
}
