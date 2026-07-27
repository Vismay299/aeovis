import { test } from "node:test";
import assert from "node:assert/strict";
import { startContentJob, reviseContentItem } from "./contentWorker.js";
import { isLegalTransition } from "./stages.js";

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

test("custom agent: listicle format flows into prompts and the trace fills live", async () => {
  const GEO_WORK_ORDER = {
    angle: "Ranked diagnostics chains for corporates",
    title_hint: "top diagnostics chains",
    target_queries: ["best diagnostics chain for corporates india"],
    fan_out: ["what to evaluate", "top chains", "pricing", "coverage"],
    sections: [{ h2: "Which chain is best?", sub_query: "top chains", evidence_note: "table" }],
    notes: "",
  };
  const GEO_DRAFT = {
    title: "Top 7 Diagnostics Chains for Corporate Health Programs in India",
    body_md: "## 1. Thyrocare\n" + "x ".repeat(900) + "\n## 2. Dr Lal PathLabs\nmore text here",
    meta_description: "The 7 best diagnostics chains for corporate health checkups in India, ranked.",
    levers_used: ["listicle"],
  };
  const GEO_REVIEW_PASS = {
    scores: {
      facts_vs_research: 0.9,
      citation_validity: 0.85,
      authority_specificity: 0.85,
      brand_voice: 0.8,
      channel_checklist: 0.9,
      ymyl_compliance: 1.0,
    },
    verdict: "pass",
    ymyl_violation: false,
    violations: [],
    critique: "",
  };

  const { llm, prompts } = makeFakeLlm([GEO_WORK_ORDER, RESEARCH_PACK, {
    // benchmark (geo path is an LLM call)
    format_distribution: { listicle: 70, comparison: 30 },
    dominant_format: "listicle",
    directive: "Build a ranked listicle.",
    earned_placement: false,
    engine_divergence: "none observed",
    structural_notes: [],
  }, GEO_DRAFT, GEO_REVIEW_PASS]);

  const listicleAgent = {
    name: "Listicle Writer",
    emoji: "🔢",
    base: "geo_article",
    format: "listicle",
    channel: "website",
    length_hint: "800 words",
    format_config: { items: 7, ranked: true },
    design_rules: ["No fluff intros"],
    custom_instructions: "End with a pricing caveat.",
    rubric_emphasis: { authority_specificity: 1.5 },
  };

  const jobUpdates = [];
  const items = [];
  const deps = {
    llm,
    scrape: async () => "No website content available.",
    job: {
      id: "job-1",
      brand: "TestDiag",
      playbook: "geo_article",
      status: "pending",
      input: { type: "gap", query: "best diagnostics chain for corporates india" },
      agent_id: "agent-1",
      agent_snapshot: listicleAgent,
    },
    updateContentJob: async (jobId, updates) => {
      jobUpdates.push({ jobId, ...updates });
      return { id: jobId, ...updates };
    },
    insertContentItem: async (item) => {
      const rec = { id: "item-1", ...item };
      items.push(rec);
      return rec;
    },
    listLessons: async () => [],
    getScansForBrand: async () => [],
    getBrandBrief: async () => null,
    upsertBrandBrief: async () => ({}),
  };

  const item = await startContentJob("job-1", deps);
  assert.ok(item);

  // The listicle format directive reached the draft prompt.
  const draftPrompt = prompts[3];
  assert.ok(draftPrompt.includes("ranked listicle"), "format structure in draft prompt");
  assert.ok(draftPrompt.includes("items=7"), "format config in draft prompt");
  assert.ok(draftPrompt.includes("End with a pricing caveat"), "custom instructions in draft prompt");

  // The agent snapshot is stamped on the item for provenance.
  assert.equal(items[0].agent_snapshot.format, "listicle");
  assert.equal(items[0].agent_id, "agent-1");

  // The live trace was written and completed for every specialist.
  const withTrace = jobUpdates.filter((u) => Array.isArray(u.agent_trace));
  assert.ok(withTrace.length >= 5, "trace written on each step");
  const finalTrace = withTrace[withTrace.length - 1].agent_trace;
  assert.deepEqual(
    finalTrace.map((t) => t.step),
    ["coordinate", "research", "benchmark", "draft", "review"]
  );
  assert.ok(finalTrace.every((t) => t.status === "done"), "all specialists done");
  assert.ok(finalTrace[0].summary.includes("Angle"), "strategist reported its summary");
  assert.ok(/\d+ words/.test(finalTrace[3].summary), "writer reported word count");
});

test("failed job marks the mid-flight specialist as failed in the trace", async () => {
  // research throws (scrape ok but llm returns invalid pack twice)
  const { llm } = makeFakeLlm([
    {
      angle: "a",
      title_hint: "t",
      hook_thesis: "Home collection inverts margins",
      post_shape: "data_point",
      target_queries: [],
      fan_out: [],
      sections: [],
    },
    { sources: [] }, // invalid research pack (no sources)
    { sources: [] }, // still invalid on retry
  ]);
  const jobUpdates = [];
  const deps = {
    llm,
    scrape: async () => "No website content available.",
    job: { id: "job-1", brand: "TestDiag", playbook: "linkedin_post", status: "pending", input: {} },
    updateContentJob: async (jobId, updates) => {
      jobUpdates.push({ jobId, ...updates });
      return { id: jobId, ...updates };
    },
    insertContentItem: async (i) => ({ id: "item-1", ...i }),
    listLessons: async () => [],
    getScansForBrand: async () => [],
    getBrandBrief: async () => null,
    upsertBrandBrief: async () => ({}),
  };

  const item = await startContentJob("job-1", deps);
  assert.equal(item, null);
  const final = jobUpdates[jobUpdates.length - 1];
  assert.equal(final.status, "failed");
  const research = final.agent_trace.find((t) => t.step === "research");
  assert.equal(research.status, "failed");
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

// --- control plane: stage transitions (T2) + run ledger (T3) -----------------

/** deps plus a capturing ledger, so per-block accounting can be asserted. */
function makeLedgerDeps(llm, opts = {}) {
  const base = makeDeps(llm, opts);
  const runs = [];
  base.deps.insertContentRun = async ({ job_id, brand, block, cycle }) => {
    const run = { id: `run-${runs.length + 1}`, job_id, brand, block, cycle, status: "running" };
    runs.push(run);
    return run;
  };
  base.deps.finishContentRun = async (runId, patch) => {
    const run = runs.find((r) => r.id === runId);
    if (run) Object.assign(run, patch);
    return run || null;
  };
  return { ...base, runs };
}

test("every job status the worker writes is a legal stage transition", async () => {
  const { llm } = makeFakeLlm([LI_WORK_ORDER, RESEARCH_PACK, LI_DRAFT, LI_REVIEW_PASS]);
  const { deps, jobUpdates } = makeDeps(llm);

  await startContentJob("job-1", deps);

  const statuses = jobUpdates.map((u) => u.status).filter(Boolean);
  let previous = null;
  for (const status of statuses) {
    assert.ok(
      isLegalTransition(previous, status),
      `illegal transition ${previous} → ${status} (see content/stages.js)`
    );
    previous = status;
  }
});

test("the revision loop's repeated statuses are still legal transitions", async () => {
  const { llm } = makeFakeLlm([
    LI_WORK_ORDER,
    RESEARCH_PACK,
    LI_DRAFT,
    LI_REVIEW_FAIL,
    { ...LI_DRAFT, title: "redrafted" },
    LI_REVIEW_PASS,
  ]);
  const { deps, jobUpdates } = makeDeps(llm);

  await startContentJob("job-1", deps);

  const statuses = jobUpdates.map((u) => u.status).filter(Boolean);
  // drafting → reviewing → drafting → reviewing: the loop revisits statuses.
  assert.ok(statuses.filter((s) => s === "drafting").length >= 2);
  let previous = null;
  for (const status of statuses) {
    assert.ok(isLegalTransition(previous, status), `illegal transition ${previous} → ${status}`);
    previous = status;
  }
});

test("ledger: one row per executed block, each closed with its own cost", async () => {
  const { llm } = makeFakeLlm([LI_WORK_ORDER, RESEARCH_PACK, LI_DRAFT, LI_REVIEW_PASS], 0.01);
  const { deps, runs } = makeLedgerDeps(llm);

  await startContentJob("job-1", deps);

  assert.deepEqual(
    runs.map((r) => r.block),
    ["coordinate", "research", "benchmark", "draft", "review"],
    "every block in the resolved pipeline gets a ledger row"
  );
  for (const run of runs) {
    assert.equal(run.status, "succeeded", `${run.block} should have closed successfully`);
    assert.equal(run.job_id, "job-1");
    assert.equal(run.brand, "TestDiag");
  }

  // benchmark is static for linkedin_post — it makes no LLM call, so its own
  // cost must be exactly 0. This is the point of per-block attribution: a free
  // block and a paid one are distinguishable.
  const byBlock = Object.fromEntries(runs.map((r) => [r.block, r]));
  assert.equal(byBlock.benchmark.cost, 0, "a block that spends nothing records 0");
  for (const block of ["coordinate", "research", "draft", "review"]) {
    assert.ok(byBlock[block].cost > 0, `${block} calls the LLM and must record its spend`);
  }
});

test("ledger: per-block cost sums to the job total — attribution is complete (D4)", async () => {
  const perCall = 0.01;
  const { llm } = makeFakeLlm([LI_WORK_ORDER, RESEARCH_PACK, LI_DRAFT, LI_REVIEW_PASS], perCall);
  const { deps, runs, jobUpdates } = makeLedgerDeps(llm);

  await startContentJob("job-1", deps);

  const ledgerTotal = runs.reduce((sum, r) => sum + r.cost, 0);
  const jobTotal = jobUpdates[jobUpdates.length - 1].cost_total;
  assert.ok(
    Math.abs(ledgerTotal - jobTotal) < 1e-6,
    `ledger total ${ledgerTotal} should equal job total ${jobTotal}`
  );
});

test("ledger: the revision loop records each pass under its own cycle number", async () => {
  const { llm } = makeFakeLlm([
    LI_WORK_ORDER,
    RESEARCH_PACK,
    LI_DRAFT,
    LI_REVIEW_FAIL,
    { ...LI_DRAFT, title: "redrafted" },
    LI_REVIEW_PASS,
  ]);
  const { deps, runs } = makeLedgerDeps(llm);

  await startContentJob("job-1", deps);

  const drafts = runs.filter((r) => r.block === "draft");
  const reviews = runs.filter((r) => r.block === "review");
  assert.deepEqual(drafts.map((r) => r.cycle), [1, 2]);
  assert.deepEqual(reviews.map((r) => r.cycle), [1, 2]);
});

test("ledger: a failing block is closed as failed with the error text", async () => {
  const { llm } = makeFakeLlm([LI_WORK_ORDER]); // research exhausts the queue
  const { deps, runs } = makeLedgerDeps(llm);

  const item = await startContentJob("job-1", deps);

  assert.equal(item, null, "the job still fails loudly");
  const research = runs.find((r) => r.block === "research");
  assert.ok(research, "the failing block still opened a ledger row");
  assert.equal(research.status, "failed");
  assert.ok(research.error, "the failure reason is recorded");
  assert.equal(runs.find((r) => r.block === "coordinate").status, "succeeded");
});

test("ledger: a broken ledger never breaks the pipeline", async () => {
  const { llm } = makeFakeLlm([LI_WORK_ORDER, RESEARCH_PACK, LI_DRAFT, LI_REVIEW_PASS]);
  const { deps, items } = makeDeps(llm);
  // db/content.js is fail-soft and returns null; prove the worker tolerates it.
  deps.insertContentRun = async () => null;
  deps.finishContentRun = async () => null;

  const item = await startContentJob("job-1", deps);

  assert.ok(item, "the job must still produce an item");
  assert.equal(items[0].status, "awaiting_approval");
});
