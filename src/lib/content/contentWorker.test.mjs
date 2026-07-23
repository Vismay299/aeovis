import { test } from "node:test";
import assert from "node:assert/strict";
import { startContentJob, reviseContentItem } from "./contentWorker.js";

/**
 * End-to-end pipeline tests against a scripted fake LLM — zero live calls.
 * Verifies the plan's guardrails: revision-loop caps, YMYL routing,
 * lessons injection, cost cap, and the awaiting_approval terminal state.
 */

// --- fixtures --------------------------------------------------------------

const LI_WORK_ORDER = {
  angle: "COOs misread home-collection economics",
  title_hint: "home-collection-margin-trap",
  hook_thesis: "Home collection grows topline and shrinks margin at once",
  post_shape: "data_point",
  target_queries: [],
  fan_out: [],
  sections: [],
  notes: "needs a cost-per-visit figure",
};

const RESEARCH_PACK = {
  sources: [
    { url: "https://example.com/report", title: "Diagnostics Report", type: "cited_page", key_points: ["logistics costs"] },
  ],
  stats: [{ stat: "18-22% of order value goes to logistics", source_url: "https://example.com/report" }],
  quotes: [],
  paa: [],
  angles: ["cost-per-visit framing"],
  unsupported_subqueries: [],
};

const LI_DRAFT = {
  title: "home-collection-margin-trap",
  body_md:
    "18% of every home-collection order goes to logistics.\n\n" +
    "Most diagnostics COOs can quote reagent costs to the rupee. Almost none can quote that number. " +
    "Home collection is the fastest-growing order line for every chain that offers it, and the only one " +
    "where costs scale per order, not per batch. Phlebotomist time, travel, cold-chain handling: none of it amortizes. " +
    "Treat home collection as its own P&L with its own pricing floor.\n\nWhat does your cost-per-visit come to?",
  meta_description: "",
  levers_used: ["data_point"],
};

const LI_REVIEW_PASS = {
  scores: {
    facts_vs_research: 0.9,
    hook_strength: 0.85,
    persona_fit: 0.85,
    format_checklist: 0.9,
    ymyl_compliance: 1.0,
  },
  verdict: "pass",
  ymyl_violation: false,
  violations: [],
  critique: "",
};

const LI_REVIEW_FAIL = {
  scores: {
    facts_vs_research: 0.9,
    hook_strength: 0.4,
    persona_fit: 0.85,
    format_checklist: 0.9,
    ymyl_compliance: 1.0,
  },
  verdict: "fail",
  ymyl_violation: false,
  violations: [{ rule: "hook_strength", detail: "opener is generic", ymyl: false }],
  critique: "1. Open with the 18% figure, not the anecdote.",
};

const LI_REVIEW_YMYL = {
  scores: {
    facts_vs_research: 0.9,
    hook_strength: 0.9,
    persona_fit: 0.9,
    format_checklist: 0.9,
    ymyl_compliance: 0.0,
  },
  verdict: "fail",
  ymyl_violation: true,
  violations: [
    { rule: "ymyl_compliance", detail: "claims early screening halves mortality without a clinical source", ymyl: true },
  ],
  critique: "",
};

// --- harness ---------------------------------------------------------------

function makeFakeLlm(responses, { costPerCall = 0.005 } = {}) {
  const prompts = [];
  const queue = [...responses];
  const llm = async (prompt, options = {}) => {
    prompts.push(prompt);
    if (options.stats) options.stats.cost = (options.stats.cost || 0) + costPerCall;
    if (queue.length === 0) throw new Error("fake llm exhausted — test script too short");
    return queue.shift();
  };
  return { llm, prompts };
}

function makeDeps(llm, { lessons = [] } = {}) {
  const jobUpdates = [];
  const items = [];
  const deps = {
    llm,
    scrape: async () => "No website content available.",
    job: {
      id: "job-1",
      brand: "TestDiag",
      playbook: "linkedin_post",
      status: "pending",
      input: { type: "topic", topic: "home collection economics", brand_profile: "healthcare-cxo" },
    },
    updateContentJob: async (jobId, updates) => {
      jobUpdates.push({ jobId, ...updates });
      return { id: jobId, ...updates };
    },
    insertContentItem: async (item) => {
      const record = { id: "item-1", ...item };
      items.push(record);
      return record;
    },
    listLessons: async () => lessons,
    getScansForBrand: async () => [],
    getBrandBrief: async () => null,
    upsertBrandBrief: async () => ({}),
  };
  return { deps, jobUpdates, items };
}

// linkedin_post call order: coordinate, research, draft, review (benchmark is static)

// --- tests -----------------------------------------------------------------

test("happy path: job runs to awaiting_approval with a pass rubric", async () => {
  const { llm } = makeFakeLlm([LI_WORK_ORDER, RESEARCH_PACK, LI_DRAFT, LI_REVIEW_PASS]);
  const { deps, jobUpdates, items } = makeDeps(llm);

  const item = await startContentJob("job-1", deps);

  assert.ok(item, "item should be created");
  assert.equal(items.length, 1);
  assert.equal(items[0].status, "awaiting_approval");
  assert.equal(items[0].rubric.verdict, "pass");
  assert.equal(items[0].rubric.below_threshold, false);
  assert.equal(items[0].revision, 0);

  const statuses = jobUpdates.map((u) => u.status).filter(Boolean);
  assert.deepEqual(statuses, [
    "coordinating",
    "researching",
    "benchmarking",
    "drafting",
    "reviewing",
    "awaiting_approval",
  ]);
  const final = jobUpdates[jobUpdates.length - 1];
  assert.equal(final.item_id, "item-1");
  assert.ok(final.cost_total > 0);
});

test("revision loop: fail → critique-driven redraft → pass, prior draft archived", async () => {
  const { llm, prompts } = makeFakeLlm([
    LI_WORK_ORDER,
    RESEARCH_PACK,
    LI_DRAFT,
    LI_REVIEW_FAIL,
    { ...LI_DRAFT, title: "redrafted" },
    LI_REVIEW_PASS,
  ]);
  const { deps, items } = makeDeps(llm);

  const item = await startContentJob("job-1", deps);

  assert.ok(item);
  assert.equal(items[0].rubric.verdict, "pass");
  assert.equal(items[0].revision, 1);
  assert.equal(items[0].revisions.length, 1);
  assert.equal(items[0].revisions[0].critique, LI_REVIEW_FAIL.critique);
  assert.equal(items[0].title, "redrafted");

  // The redraft prompt must carry the reviewer critique.
  const redraftPrompt = prompts[4];
  assert.ok(redraftPrompt.includes("Open with the 18% figure"));
});

test("revision cap: two fails → queued anyway, flagged below_threshold", async () => {
  const { llm } = makeFakeLlm([
    LI_WORK_ORDER,
    RESEARCH_PACK,
    LI_DRAFT,
    LI_REVIEW_FAIL,
    LI_DRAFT,
    LI_REVIEW_FAIL,
  ]);
  const { deps, items, jobUpdates } = makeDeps(llm);

  const item = await startContentJob("job-1", deps);

  assert.ok(item, "below-threshold items still reach the human queue");
  assert.equal(items[0].status, "awaiting_approval");
  assert.equal(items[0].rubric.below_threshold, true);
  assert.equal(items[0].rubric.cycles, 2);
  assert.equal(jobUpdates[jobUpdates.length - 1].status, "awaiting_approval");
});

test("YMYL violation: never auto-revised — one cycle, straight to human, flagged", async () => {
  const { llm, prompts } = makeFakeLlm([
    LI_WORK_ORDER,
    RESEARCH_PACK,
    LI_DRAFT,
    LI_REVIEW_YMYL,
  ]);
  const { deps, items } = makeDeps(llm);

  const item = await startContentJob("job-1", deps);

  assert.ok(item);
  assert.equal(prompts.length, 4, "no redraft LLM calls after a YMYL violation");
  assert.equal(items[0].rubric.cycles, 1);
  assert.equal(items[0].rubric.ymyl_violation, true);
  assert.equal(items[0].rubric.below_threshold, true);
  assert.ok(items[0].rubric.violations.some((v) => v.ymyl));
});

test("lessons are injected into coordinate and draft prompts", async () => {
  const { llm, prompts } = makeFakeLlm([LI_WORK_ORDER, RESEARCH_PACK, LI_DRAFT, LI_REVIEW_PASS]);
  const lesson = "Use named, city-specific Indian examples as evidence wherever possible.";
  const { deps } = makeDeps(llm, { lessons: [{ lesson, active: true }] });

  await startContentJob("job-1", deps);

  assert.ok(prompts[0].includes(lesson), "coordinate prompt carries the lesson");
  assert.ok(prompts[2].includes(lesson), "draft prompt carries the lesson");
});

test("cost cap: job fails with the cap named once spend crosses it", async () => {
  const { llm } = makeFakeLlm([LI_WORK_ORDER, RESEARCH_PACK, LI_DRAFT, LI_REVIEW_PASS], {
    costPerCall: 0.2, // over the 0.15 default after one call
  });
  const { deps, jobUpdates, items } = makeDeps(llm);

  const item = await startContentJob("job-1", deps);

  assert.equal(item, null);
  assert.equal(items.length, 0, "no item is queued after a cost-cap abort");
  const final = jobUpdates[jobUpdates.length - 1];
  assert.equal(final.status, "failed");
  assert.ok(final.error_message.includes("Cost cap exceeded"));
});

test("reviseContentItem: human comment drives a redraft back to the queue", async () => {
  const { llm, prompts } = makeFakeLlm([
    { ...LI_DRAFT, title: "revised-after-feedback" },
    LI_REVIEW_PASS,
  ]);

  const storedItem = {
    id: "item-1",
    job_id: "job-1",
    brand: "TestDiag",
    playbook: "linkedin_post",
    title: "original",
    body_md: LI_DRAFT.body_md,
    research_pack: RESEARCH_PACK,
    benchmark_notes: { pack: { hook_patterns: [] }, work_order: LI_WORK_ORDER },
    rubric: { verdict: "pass" },
    revision: 0,
    revisions: [],
    target_queries: [],
    status: "changes_requested",
  };

  const itemUpdates = [];
  const deps = {
    llm,
    scrape: async () => "No website content available.",
    getContentItem: async () => storedItem,
    updateContentItem: async (id, updates) => {
      itemUpdates.push({ id, ...updates });
      return { ...storedItem, ...updates };
    },
    updateContentJob: async () => ({}),
    listLessons: async () => [],
    getScansForBrand: async () => [],
    getBrandBrief: async () => null,
    upsertBrandBrief: async () => ({}),
  };

  const updated = await reviseContentItem("item-1", "cut the salesy ending", deps);

  assert.ok(updated);
  assert.equal(prompts.length, 2, "one draft + one review, no auto-loop");
  assert.ok(prompts[0].includes("HUMAN REVIEWER FEEDBACK"));
  assert.ok(prompts[0].includes("cut the salesy ending"));

  const final = itemUpdates[itemUpdates.length - 1];
  assert.equal(final.title, "revised-after-feedback");
  assert.equal(final.status, "awaiting_approval");
  assert.equal(final.revision, 1);
  assert.equal(final.revisions.length, 1);
  assert.equal(final.revisions[0].source, "human_feedback");
  assert.equal(final.rubric.revised_from_feedback, true);
});

test("invalid step output: retried once, then the job fails with the step named", async () => {
  const { llm, prompts } = makeFakeLlm([
    { angle: "" }, // invalid work order
    { angle: "" }, // still invalid on the correction retry
  ]);
  const { deps, jobUpdates } = makeDeps(llm);

  const item = await startContentJob("job-1", deps);

  assert.equal(item, null);
  assert.equal(prompts.length, 2, "exactly one correction retry");
  assert.ok(prompts[1].includes("INVALID"), "retry prompt names the validation errors");
  const final = jobUpdates[jobUpdates.length - 1];
  assert.equal(final.status, "failed");
  assert.ok(final.error_message.includes('Step "coordinate"'));
});
