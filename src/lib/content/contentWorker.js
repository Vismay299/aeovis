import {
  getContentJob,
  updateContentJob,
  insertContentItem,
  getContentItem,
  updateContentItem,
  getBrandBrief,
  upsertBrandBrief,
  listLessons,
} from "../db/content.js";
import { getScansForBrand } from "../db.js";
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

function getCostCap() {
  const cap = Number(process.env.CONTENT_MAX_COST_PER_ITEM);
  return Number.isFinite(cap) && cap > 0 ? cap : 0.15;
}

function assertUnderCostCap(stats, step) {
  const cap = getCostCap();
  if ((stats.cost || 0) > cap) {
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
  if (stored?.brief) return stored.brief;

  const preset =
    input?.brand_profile === "healthcare-cxo" || !input?.brand_profile
      ? HEALTHCARE_CXO_BRIEF
      : HEALTHCARE_CXO_BRIEF; // single shipped preset in v1
  const seeded = { ...preset, one_liner: `${brand} — ${preset.one_liner}` };
  try {
    await upsert(brand, seeded);
  } catch (err) {
    console.warn("[content-worker] brief seed persist failed:", err.message);
  }
  return seeded;
}

/** The agent config a job runs under: its snapshot, else the base default. */
export function resolveAgent(job) {
  if (job?.agent_snapshot && typeof job.agent_snapshot === "object") {
    return job.agent_snapshot;
  }
  return defaultAgentForBase(job?.playbook || "geo_article");
}

/** Job-status string for a block (the coarse status the queue UI shows). */
function statusForBlock(slug) {
  const map = {
    coordinate: "coordinating",
    research: "researching",
    benchmark: "benchmarking",
    draft: "drafting",
    review: "reviewing",
    fact_check: "reviewing",
  };
  if (map[slug]) return map[slug];
  const kind = getBlock(slug)?.kind;
  return kind === "transform" ? "drafting" : "reviewing";
}

export async function startContentJob(jobId, deps = {}) {
  const stats = { cost: 0, tokens: 0 };

  const update = deps.updateContentJob || updateContentJob;

  let trace = initTrace();
  // Every job update also flushes the live trace so the theater sees each
  // specialist transition in real time.
  const writeJob = (fields) => update(jobId, { ...fields, agent_trace: trace });

  try {
    const job = deps.job || (await getContentJob(jobId));
    if (!job) throw new Error(`content job ${jobId} not found`);
    const { brand, playbook, input } = job;
    const agent = resolveAgent(job);
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
    });
    const scans = await (deps.getScansForBrand || getScansForBrand)(brand);
    const scan = scans?.[0] || null;
    const knowledgeBlocks = await (deps.listKnowledgeBlocks || listKnowledgeBlocks)(brand, {
      activeOnly: true,
    });

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

    // Progress: distribute 8→92% across the pipeline's blocks.
    const pctFor = (idx) => 8 + Math.round((idx / pipeline.length) * 84);

    // --- Phase A: context blocks (everything before the Writer) ---
    const draftIdx = pipeline.indexOf("draft");
    for (let i = 0; i < draftIdx; i++) {
      const slug = pipeline[i];
      markWorking(trace, slug);
      await writeJob({ status: statusForBlock(slug), progress_pct: pctFor(i) });

      if (slug === "coordinate") {
        ctx.workOrder = await runCoordinate(ctx, deps);
        markDone(trace, slug, summarizeCoordinate(ctx.workOrder));
      } else if (slug === "research") {
        ctx.researchPack = await runResearch(ctx, deps);
        markDone(trace, slug, summarizeResearch(ctx.researchPack));
      } else if (slug === "benchmark") {
        ctx.benchmarkNotes = await runBenchmark(ctx, deps);
        markDone(trace, slug, summarizeBenchmark(ctx.benchmarkNotes, playbook));
      }
      assertUnderCostCap(stats, slug);
    }

    // Removed context blocks leave honest holes the prompts flag themselves.
    if (!ctx.researchPack) {
      ctx.researchPack = { sources: [], stats: [], quotes: [], paa: [], angles: [], unsupported_subqueries: [] };
    }
    if (!ctx.benchmarkNotes) ctx.benchmarkNotes = { directive: "(no benchmark block in this pipeline)" };

    // --- Phase B: Writer → transforms → checks → Editor (bounded loop) ---
    // Post-draft blocks between the Writer and the Editor:
    const midBlocks = pipeline.slice(draftIdx + 1, pipeline.length - 1);
    const revisions = [];
    let draft = null;
    let review = null;
    let factCheck = null;
    let cycles = 0;

    while (cycles < MAX_DRAFT_REVIEW_CYCLES) {
      cycles += 1;

      bumpCycle(trace, "draft", cycles);
      markWorking(
        trace,
        "draft",
        cycles === 1 ? crewMember("draft").verb : `Redrafting from the critique (pass ${cycles})`
      );
      await writeJob({ status: "drafting", progress_pct: cycles === 1 ? pctFor(draftIdx) : 84 });
      draft = await runDraft(ctx, deps);
      assertUnderCostCap(stats, "draft");
      markDone(trace, "draft", summarizeDraft(draft, cycles));
      ctx.draft = draft;

      // Transforms + fact-check run on the FIRST pass only; a revision cycle
      // goes straight back to the Editor (cost-bounded, documented behavior).
      if (cycles === 1) {
        for (let m = 0; m < midBlocks.length; m++) {
          const slug = midBlocks[m];
          const block = getBlock(slug);
          markWorking(trace, slug);
          await writeJob({ status: statusForBlock(slug), progress_pct: pctFor(draftIdx + 1 + m) });

          if (block.kind === "transform") {
            draft = await runTransform(ctx, slug, deps);
            ctx.draft = draft;
            markDone(trace, slug, summarizeTransform(block, draft));
          } else if (slug === "fact_check") {
            factCheck = await runFactCheck(ctx, deps);
            markDone(trace, slug, summarizeFactCheck(factCheck));
            // The Editor sees the fact-checker's findings.
            ctx.factCheck = factCheck;
          }
          assertUnderCostCap(stats, slug);
        }
      }

      bumpCycle(trace, "review", cycles);
      markWorking(
        trace,
        "review",
        cycles === 1 ? crewMember("review").verb : `Re-scoring the redraft (pass ${cycles})`
      );
      await writeJob({ status: "reviewing", progress_pct: cycles === 1 ? pctFor(pipeline.length - 1) : 92 });
      review = await runReview({ ...ctx, draft }, deps);
      assertUnderCostCap(stats, "review");
      markDone(trace, "review", summarizeReview(review));

      if (review.verdict === "pass") break;

      // YMYL can never be auto-revised into a pass — human decides.
      if (review.ymyl_violation) {
        console.warn(
          `[content-worker] Job ${jobId}: YMYL violation flagged — routing to human queue without auto-revision`
        );
        break;
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
    };

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
      revision: revisions.length,
      revisions,
      target_queries: ctx.workOrder.target_queries || [],
      status: "awaiting_approval",
    });

    await writeJob({
      status: "awaiting_approval",
      progress_pct: 100,
      item_id: item.id,
      cost_total: Math.round((stats.cost || 0) * 10000) / 10000,
    });

    console.log(
      `[content-worker] Job ${jobId} queued for approval. verdict=${review.verdict}` +
        ` weighted=${review.weighted_total} ymyl=${review.ymyl_violation}` +
        ` cycles=${cycles} cost=$${(stats.cost || 0).toFixed(4)}`
    );

    return item;
  } catch (error) {
    console.error(`[content-worker] Job ${jobId} failed:`, error);
    // Mark whichever specialist was mid-flight as failed for the theater.
    const active = trace.find((t) => t.status === "working");
    if (active) markFailed(trace, active.step, error.message || "failed");
    await update(jobId, {
      status: "failed",
      progress_pct: 100,
      error_message: error.message || "Unexpected content pipeline error.",
      cost_total: Math.round((stats.cost || 0) * 10000) / 10000,
      agent_trace: trace,
    });
    return null;
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

  const item = await getItem(itemId);
  if (!item) throw new Error(`content item ${itemId} not found`);

  const { brand, playbook } = item;
  console.log(`[content-worker] Revising item ${itemId} from human feedback`);

  const brief = await resolveBrief(brand, {}, deps);
  const lessons = await (deps.listLessons || listLessons)(brand, playbook, {
    activeOnly: true,
  });
  const scans = await (deps.getScansForBrand || getScansForBrand)(brand);

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
  });

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

  try {
    const draft = await runDraft(ctx, deps);
    assertUnderCostCap(stats, "draft(revision)");
    const review = await runReview({ ...ctx, draft }, deps);
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
    });

    // Fold revision spend into the originating job's total.
    if (item.job_id) {
      try {
        const job = await getContentJob(item.job_id);
        const prev = Number(job?.cost_total) || 0;
        await (deps.updateContentJob || updateContentJob)(item.job_id, {
          status: "awaiting_approval",
          cost_total: Math.round((prev + stats.cost) * 10000) / 10000,
        });
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
    await updateItem(itemId, { status: "awaiting_approval" });
    return null;
  }
}
