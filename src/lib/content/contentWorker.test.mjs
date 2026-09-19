import { test } from "node:test";
import assert from "node:assert/strict";

/**
 * End-to-end pipeline tests against a scripted fake LLM — zero live calls.
 * Verifies the plan's guardrails: revision-loop caps, YMYL routing,
 * lessons injection, cost cap, and the awaiting_approval terminal state.
 *
 * R3.2.4 — "zero live calls" now includes the database, and by construction.
 *
 * `makeDeps` below stubs `updateContentJob`, but `startContentJob` also takes a
 * lease (`acquireLease("content_jobs", ...)`), renews it on EVERY job update
 * (`renewLease`), releases it at the end, and opens a row in `content_runs` per
 * block (`insertContentRun`). None of those four resolves a client from the
 * deps this file passes; they use db.js's module-level one, built at import
 * time from NEXT_PUBLIC_SUPABASE_URL / _ANON_KEY. With credentials loaded —
 * which is what src/lib/liveDbGate.js tells live-test authors to do — this
 * file issued 16 real `UPDATE content_jobs` and 2 real `INSERT INTO
 * content_runs` against production, on job ids that exist only here, and said
 * nothing about it: the lease renew is fire-and-forget with a `.catch`, and
 * db/content.js's ledger writes are fail-soft on purpose. It stayed green
 * either way, which is precisely the failure R3.2.4 exists for.
 *
 * Clearing the credentials before the module graph is evaluated makes db.js's
 * client null however the suite is invoked, so the memory lease this file
 * actually means to exercise is the one it gets. The imports must be dynamic:
 * static imports are hoisted above these two `delete`s and db.js would capture
 * the credentials first.
 */
delete process.env.NEXT_PUBLIC_SUPABASE_URL;
delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

const { startContentJob, reviseContentItem } = await import("./contentWorker.js");
const { isLegalTransition } = await import("./stages.js");
const { supabase } = await import("../db.js");

assert.equal(
  supabase,
  null,
  "db.js still has a client: the credential clearing above did not take effect, and this file's " +
    "lease and content_runs writes would land on production"
);

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

// --- cost accumulates across attempts (R3.3.3) ------------------------------
//
// A content job can be EXECUTED more than once: the cron rescues a job whose
// worker died and startContentJob re-runs the pipeline from the top, paying
// for every block again. `stats` is per-execution, so writing
// `cost_total: stats.cost` reported the last attempt and deleted the earlier
// ones. These tests run two attempts against ONE row and assert the sum.

const COST_PER_CALL = 0.01;

/**
 * An LLM that dies on its Nth call the way a killed worker does: the promise
 * never settles, so the caller never resumes and never reaches a terminal
 * write. The hanging call adds NO cost — it never returned.
 */
function makeDyingLlm(responses, { hangAtCall }) {
  const queue = [...responses];
  let calls = 0;
  const llm = async (prompt, options = {}) => {
    calls += 1;
    if (calls === hangAtCall) return new Promise(() => {});
    if (options.stats) options.stats.cost = (options.stats.cost || 0) + COST_PER_CALL;
    if (queue.length === 0) throw new Error("fake llm exhausted — test script too short");
    return queue.shift();
  };
  return { llm, callCount: () => calls };
}

/**
 * One mutable content_jobs row plus deps that write to it, mirroring
 * db/content.js's memory path (Object.assign onto the stored row). Both
 * attempts read and write the SAME row, which is what makes this a rescue
 * rather than two unrelated jobs.
 */
function makeRescueRow() {
  const jobRow = {
    id: "job-rescued",
    brand: "TestDiag",
    playbook: "linkedin_post",
    status: "pending",
    input: { type: "topic", topic: "home collection economics", brand_profile: "healthcare-cxo" },
    cost_total: 0,
  };
  const jobUpdates = [];
  const items = [];
  const baseDeps = {
    scrape: async () => "No website content available.",
    // `leaseOwner` is how the cron's dispatchWithLease hands a won lease down
    // (api/content/worker/route.js) — the real rescue path.
    leaseOwner: "cron_test_owner",
    updateContentJob: async (jobId, updates) => {
      jobUpdates.push({ jobId, ...updates });
      Object.assign(jobRow, updates);
      return { ...jobRow };
    },
    insertContentItem: async (item) => {
      const record = { id: `item-${items.length + 1}`, ...item };
      items.push(record);
      return record;
    },
    listLessons: async () => [],
    getScansForBrand: async () => [],
    getBrandBrief: async () => null,
    upsertBrandBrief: async () => ({}),
  };
  return { jobRow, jobUpdates, items, baseDeps };
}

async function waitUntil(predicate, label) {
  for (let i = 0; i < 500; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assert.fail(`timed out waiting for: ${label}`);
}

test("rescue: cost_total is the SUM across attempts, not the last attempt", async () => {
  const { jobRow, baseDeps, items } = makeRescueRow();

  // Attempt 1 — dies inside the Writer (call 3: coordinate, research, draft;
  // benchmark is static for linkedin_post). It never reaches a terminal write,
  // exactly like a worker killed by the platform timeout.
  const dying = makeDyingLlm([LI_WORK_ORDER, RESEARCH_PACK], { hangAtCall: 3 });
  startContentJob("job-rescued", { ...baseDeps, job: jobRow, llm: dying.llm });
  await waitUntil(() => jobRow.status === "drafting", "attempt 1 to reach the Writer");
  await waitUntil(() => dying.callCount() === 3, "attempt 1 to die mid-draft");

  const spentByAttempt1 = jobRow.cost_total;
  assert.equal(
    spentByAttempt1,
    2 * COST_PER_CALL,
    "a killed attempt must leave its spend on the row — if this is 0 the spend " +
      "was only written at the terminal write and died with the process"
  );
  assert.notEqual(jobRow.status, "failed", "a killed attempt writes no terminal status");

  // Attempt 2 — the rescue.  The checkpoint written by attempt 1 lets the
  // worker skip coordinate, research, and benchmark — only draft + review
  // are paid again (R3.5.1).
  const { llm } = makeFakeLlm([LI_DRAFT, LI_REVIEW_PASS], {
    costPerCall: COST_PER_CALL,
  });
  const item = await startContentJob("job-rescued", { ...baseDeps, job: jobRow, llm });

  assert.ok(item, "the rescue completes the job");
  assert.equal(items.length, 1);
  assert.equal(jobRow.status, "awaiting_approval");

  const spentByAttempt2 = 2 * COST_PER_CALL; // draft + review only (R3.5.1 skips completed blocks)
  assert.equal(
    jobRow.cost_total,
    Math.round((spentByAttempt1 + spentByAttempt2) * 10000) / 10000,
    "the job cost both attempts and the row must say so"
  );
  assert.notEqual(
    jobRow.cost_total,
    spentByAttempt2,
    "cost_total is the last attempt's spend — the earlier attempt was overwritten"
  );
});

test("rescue: a second attempt that FAILS still adds its spend to the total", async () => {
  const { jobRow, baseDeps, jobUpdates } = makeRescueRow();

  const dying = makeDyingLlm([LI_WORK_ORDER, RESEARCH_PACK], { hangAtCall: 3 });
  startContentJob("job-rescued", { ...baseDeps, job: jobRow, llm: dying.llm });
  await waitUntil(() => jobRow.status === "drafting", "attempt 1 to reach the Writer");
  await waitUntil(() => dying.callCount() === 3, "attempt 1 to die mid-draft");
  const afterAttempt1 = jobRow.cost_total;
  assert.equal(afterAttempt1, 2 * COST_PER_CALL);

  // Attempt 2 burns two calls on an invalid work order, then fails loudly.
  const { llm } = makeFakeLlm([{ angle: "" }, { angle: "" }], { costPerCall: COST_PER_CALL });
  const item = await startContentJob("job-rescued", { ...baseDeps, job: jobRow, llm });

  assert.equal(item, null);
  const final = jobUpdates[jobUpdates.length - 1];
  assert.equal(final.status, "failed");
  assert.equal(
    jobRow.cost_total,
    4 * COST_PER_CALL,
    "a failed rescue spent real money — the failure write must add it, not replace the total"
  );
});

test("one attempt writes cost_total many times and never double-counts itself", async () => {
  const { jobRow, baseDeps, jobUpdates } = makeRescueRow();
  jobRow.cost_total = 0.02; // an earlier attempt's recorded spend

  const { llm } = makeFakeLlm([LI_WORK_ORDER, RESEARCH_PACK, LI_DRAFT, LI_REVIEW_PASS], {
    costPerCall: COST_PER_CALL,
  });
  await startContentJob("job-rescued", { ...baseDeps, job: jobRow, llm });

  // Every job write carries the running total (that is what survives a kill),
  // so the value written must be ABSOLUTE — base + this attempt's spend — and
  // never an increment applied once per write.
  const written = jobUpdates.map((u) => u.cost_total);
  assert.ok(written.length >= 6, "the pipeline writes the job row several times");
  assert.ok(
    written.every((c) => typeof c === "number"),
    "every job write carries the total"
  );
  for (let i = 1; i < written.length; i++) {
    assert.ok(written[i] >= written[i - 1], "the recorded total never goes backwards");
  }
  assert.equal(written[0], 0.02, "the first write preserves what earlier attempts recorded");
  assert.equal(
    jobRow.cost_total,
    0.06,
    "0.02 already recorded + 4 calls at 0.01 — anything higher is a double count"
  );
});

test("a failure before the job row is read leaves cost_total alone, never 0", async () => {
  const jobUpdates = [];
  // No `deps.job`: getContentJob is not injectable, the memory store has no
  // such row, so the worker throws "not found" before it can learn what the
  // row already recorded. Writing 0 there would erase an earlier attempt.
  const item = await startContentJob("job-that-does-not-exist", {
    leaseOwner: "cron_test_owner",
    llm: async () => assert.fail("no LLM call may happen before the job is read"),
    updateContentJob: async (jobId, updates) => {
      jobUpdates.push({ jobId, ...updates });
      return { id: jobId, ...updates };
    },
  });

  assert.equal(item, null);
  const final = jobUpdates[jobUpdates.length - 1];
  assert.equal(final.status, "failed");
  assert.ok(final.error_message.includes("not found"));
  assert.ok(
    !("cost_total" in final),
    "an unknown prior total must be omitted, not written as a measured 0"
  );
});

// --- R3.5.1: per-block checkpoints ------------------------------------------

/**
 * A job with a checkpoint skips completed Phase A blocks and restores the
 * accumulated context (workOrder, researchPack, benchmarkNotes) so later
 * blocks can run without re-calling the LLM for earlier ones.
 */
test("checkpoint: Phase A blocks completed before a kill are skipped on rescue", async () => {
  const { llm } = makeFakeLlm([LI_DRAFT, LI_REVIEW_PASS]);
  const { deps, jobUpdates } = makeDeps(llm);

  // Simulate a rescued job that already completed coordinate + research + benchmark.
  deps.job = {
    id: "job-cp-1",
    brand: "TestDiag",
    playbook: "linkedin_post",
    status: "researching", // last written status before the kill
    input: { type: "topic", topic: "home collection economics" },
    cost_total: 0.02,
    checkpoint: {
      pipeline: ["coordinate", "research", "benchmark", "draft", "review"],
      completedBlocks: ["coordinate", "research", "benchmark"],
      cycle: 0,
      review: null,
      revisions: [],
      workOrder: LI_WORK_ORDER,
      researchPack: RESEARCH_PACK,
      benchmarkNotes: { pack: {} },
      draft: null,
      factCheck: null,
      critique: "",
    },
  };

  const item = await startContentJob("job-cp-1", deps);
  assert.ok(item, "the rescued job produces an item");
  assert.equal(item.status, "awaiting_approval");

  // Only draft + review should have run — no extra LLM calls for context blocks.
  const statuses = jobUpdates.map((u) => u.status).filter(Boolean);
  assert.ok(!statuses.includes("coordinating"), "coordinate was skipped");
  assert.ok(!statuses.includes("researching"), "research was skipped");
  assert.ok(!statuses.includes("benchmarking"), "benchmark was skipped");
  assert.ok(statuses.includes("drafting"), "draft ran");
  assert.ok(statuses.includes("reviewing"), "review ran");
});

/**
 * A checkpoint written by Phase A blocks is persisted on every writeJob call.
 * The job row's checkpoint field should grow as blocks complete.
 */
test("checkpoint: every Phase A block boundary writes a checkpoint to the job row", async () => {
  const { llm } = makeFakeLlm([LI_WORK_ORDER, RESEARCH_PACK, LI_DRAFT, LI_REVIEW_PASS]);
  const { deps, jobUpdates } = makeDeps(llm);

  await startContentJob("job-cp-2", deps);

  // Collect every writeJob call that included a checkpoint field.
  const checkpointWrites = jobUpdates.filter((u) => u.checkpoint);
  assert.ok(checkpointWrites.length >= 4, "at least 4 checkpoint writes (coordinate, research, benchmark, draft)");

  // The first checkpoint should have only coordinate completed.
  const firstCp = checkpointWrites[0].checkpoint;
  assert.deepEqual(firstCp.completedBlocks, ["coordinate"]);
  assert.ok(firstCp.workOrder, "workOrder is captured in the checkpoint");

  // The final checkpoint before terminal should have all blocks completed.
  const lastCp = checkpointWrites[checkpointWrites.length - 1].checkpoint;
  assert.ok(lastCp.completedBlocks.includes("coordinate"), "coordinate done");
  assert.ok(lastCp.completedBlocks.includes("research"), "research done");
  assert.ok(lastCp.completedBlocks.includes("benchmark"), "benchmark done");
});

/**
 * Phase B (the draft-review loop) checkpoints cycle-suffixed block IDs
 * (e.g. "draft:1", "review:1") so each sub-step is independently resumable.
 */
test("checkpoint: Phase B loop writes cycle-suffixed block IDs", async () => {
  const { llm } = makeFakeLlm([LI_WORK_ORDER, RESEARCH_PACK, LI_DRAFT, LI_REVIEW_PASS]);
  const { deps, jobUpdates } = makeDeps(llm);

  await startContentJob("job-cp-3", deps);

  const checkpointWrites = jobUpdates.filter((u) => u.checkpoint);
  // Find the draft:1 and review:1 entries.
  const draftCheckpoint = checkpointWrites.find(
    (w) => w.checkpoint.completedBlocks.includes("draft:1")
  );
  const reviewCheckpoint = checkpointWrites.find(
    (w) => w.checkpoint.completedBlocks.includes("review:1")
  );
  assert.ok(draftCheckpoint, "draft:1 checkpoint was written");
  assert.ok(reviewCheckpoint, "review:1 checkpoint was written");
  assert.equal(draftCheckpoint.checkpoint.cycle, 1);
  assert.equal(reviewCheckpoint.checkpoint.cycle, 1);
});

/**
 * A job killed mid-draft-review-loop (after draft passes but before review)
 * resumes at the review step on rescue, skipping the already-paid draft.
 */
test("checkpoint: resume mid-loop skips completed draft, runs only review", async () => {
  const { llm } = makeFakeLlm([LI_REVIEW_PASS]);
  const { deps, jobUpdates, items } = makeDeps(llm);

  deps.job = {
    id: "job-cp-4",
    brand: "TestDiag",
    playbook: "linkedin_post",
    status: "drafting",
    input: { type: "topic", topic: "home collection economics" },
    cost_total: 0.03,
    checkpoint: {
      pipeline: ["coordinate", "research", "benchmark", "draft", "review"],
      completedBlocks: ["coordinate", "research", "benchmark", "draft:1"],
      cycle: 1,
      review: null,
      revisions: [],
      workOrder: LI_WORK_ORDER,
      researchPack: RESEARCH_PACK,
      benchmarkNotes: { pack: {} },
      draft: LI_DRAFT,
      factCheck: null,
      critique: "",
    },
  };

  const item = await startContentJob("job-cp-4", deps);
  assert.ok(item);
  assert.equal(item.status, "awaiting_approval");

  // The only LLM call should have been the review — draft was skipped.
  const statuses = jobUpdates.map((u) => u.status).filter(Boolean);
  assert.ok(!statuses.includes("drafting"), "draft was skipped via checkpoint");
  assert.ok(statuses.includes("reviewing"), "review ran");
});

/**
 * A job whose checkpoint says the review passed (verdict=pass) does not
 * re-enter the loop — it goes straight to the terminal write.
 */
test("checkpoint: a rescued job whose loop already passed skips the entire loop", async () => {
  const { deps, jobUpdates, items } = makeDeps(async () => assert.fail("no LLM calls expected"));

  deps.job = {
    id: "job-cp-5",
    brand: "TestDiag",
    playbook: "linkedin_post",
    status: "reviewing",
    input: { type: "topic", topic: "home collection economics" },
    cost_total: 0.04,
    checkpoint: {
      pipeline: ["coordinate", "research", "benchmark", "draft", "review"],
      completedBlocks: ["coordinate", "research", "benchmark", "draft:1", "review:1"],
      cycle: 1,
      review: LI_REVIEW_PASS,
      revisions: [],
      workOrder: LI_WORK_ORDER,
      researchPack: RESEARCH_PACK,
      benchmarkNotes: { pack: {} },
      draft: LI_DRAFT,
      factCheck: null,
      critique: "",
    },
  };

  const item = await startContentJob("job-cp-5", deps);
  assert.ok(item, "the item is created from the checkpointed draft");
  assert.equal(item.status, "awaiting_approval");
  assert.equal(item.title, LI_DRAFT.title);
  // No LLM calls — the loop was already resolved.
});

/**
 * When a checkpoint says the last review failed and the revision budget is
 * exhausted (cycles = MAX_DRAFT_REVIEW_CYCLES), the loop is not re-entered.
 */
test("checkpoint: rescued job with exhausted revision budget skips the loop", async () => {
  const { deps, items } = makeDeps(async () => assert.fail("no LLM calls expected"));

  const exhaustedReview = { ...LI_REVIEW_FAIL, verdict: "fail" };
  deps.job = {
    id: "job-cp-6",
    brand: "TestDiag",
    playbook: "linkedin_post",
    status: "reviewing",
    input: {},
    cost_total: 0.05,
    checkpoint: {
      pipeline: ["coordinate", "research", "benchmark", "draft", "review"],
      completedBlocks: ["coordinate", "research", "benchmark", "draft:1", "review:1", "draft:2", "review:2"],
      cycle: 2,
      review: exhaustedReview,
      revisions: [
        { revision: 0, title: "v1", body_md: "old", rubric: LI_REVIEW_FAIL, critique: "fix hook" },
      ],
      workOrder: LI_WORK_ORDER,
      researchPack: RESEARCH_PACK,
      benchmarkNotes: { pack: {} },
      draft: LI_DRAFT,
      factCheck: null,
      critique: "fix hook",
    },
  };

  const item = await startContentJob("job-cp-6", deps);
  assert.ok(item, "item created with below-threshold flag");
  assert.equal(items[0].rubric.below_threshold, true);
  assert.equal(items[0].rubric.cycles, 2);
});

/**
 * A rescue after a failed review (non-YMYL, budget remains) starts a new
 * cycle.  The checkpoint's revisions and critique are carried forward.
 */
test("checkpoint: rescue after failed review starts next cycle with carried context", async () => {
  const revisedDraft = { ...LI_DRAFT, title: "revised-v2" };
  const { llm, prompts } = makeFakeLlm([revisedDraft, LI_REVIEW_PASS]);
  const { deps, items } = makeDeps(llm);

  deps.job = {
    id: "job-cp-7",
    brand: "TestDiag",
    playbook: "linkedin_post",
    status: "reviewing",
    input: {},
    cost_total: 0.04,
    checkpoint: {
      pipeline: ["coordinate", "research", "benchmark", "draft", "review"],
      completedBlocks: ["coordinate", "research", "benchmark", "draft:1", "review:1"],
      cycle: 1,
      review: LI_REVIEW_FAIL,
      revisions: [],
      workOrder: LI_WORK_ORDER,
      researchPack: RESEARCH_PACK,
      benchmarkNotes: { pack: {} },
      draft: LI_DRAFT,
      factCheck: null,
      critique: "",
    },
  };

  const item = await startContentJob("job-cp-7", deps);
  assert.ok(item);
  assert.equal(items[0].title, "revised-v2");
  assert.equal(items[0].rubric.cycles, 2);

  // The redraft prompt should carry the critique from the failed review.
  const redraftPrompt = prompts[0]; // only 2 LLM calls: draft + review
  assert.ok(redraftPrompt.includes("Open with the 18% figure"), "critique carried into the redraft prompt");
});

/**
 * A job with no checkpoint (fresh start) behaves exactly as before.
 */
test("checkpoint: a job with no checkpoint starts from the beginning", async () => {
  const { llm } = makeFakeLlm([LI_WORK_ORDER, RESEARCH_PACK, LI_DRAFT, LI_REVIEW_PASS]);
  const { deps, jobUpdates, items } = makeDeps(llm);

  // No checkpoint field on the job.
  await startContentJob("job-cp-8", deps);

  const statuses = jobUpdates.map((u) => u.status).filter(Boolean);
  assert.deepEqual(statuses, [
    "coordinating",
    "researching",
    "benchmarking",
    "drafting",
    "reviewing",
    "awaiting_approval",
  ]);
  assert.equal(items.length, 1);
});

/**
 * The trace shows completed blocks from the checkpoint as "done" so the
 * theater displays honest history for a rescued job.
 */
test("checkpoint: skipped blocks are marked done in the trace", async () => {
  const { llm } = makeFakeLlm([LI_DRAFT, LI_REVIEW_PASS]);
  const { deps, jobUpdates } = makeDeps(llm);

  deps.job = {
    id: "job-cp-9",
    brand: "TestDiag",
    playbook: "linkedin_post",
    status: "researching",
    input: {},
    cost_total: 0.02,
    checkpoint: {
      pipeline: ["coordinate", "research", "benchmark", "draft", "review"],
      completedBlocks: ["coordinate", "research", "benchmark"],
      cycle: 0,
      review: null,
      revisions: [],
      workOrder: LI_WORK_ORDER,
      researchPack: RESEARCH_PACK,
      benchmarkNotes: { pack: {} },
    },
  };

  await startContentJob("job-cp-9", deps);

  const withTrace = jobUpdates.filter((u) => Array.isArray(u.agent_trace));
  const finalTrace = withTrace[withTrace.length - 1].agent_trace;

  // Skipped blocks should be marked as done (restored from checkpoint).
  const coordEntry = finalTrace.find((t) => t.step === "coordinate");
  const researchEntry = finalTrace.find((t) => t.step === "research");
  assert.equal(coordEntry.status, "done", "coordinate marked done from checkpoint");
  assert.ok(coordEntry.summary.includes("completed before resume"));
  assert.equal(researchEntry.status, "done", "research marked done from checkpoint");
});

// ---------------------------------------------------------------------------
// R3.1.10 — the self-continue: a content job advances at machine speed, not at
// cron speed.
//
// THE FINDING (production, 2026-09-16). The daily batch created six
// geo_article jobs, ran all six inside that one cron invocation, and every one
// of them stopped when the function hit maxDuration — researching,
// benchmarking, drafting, reviewing, none reaching a content_items row.
// Nothing resumed them until the next DAILY tick, so a six-block pipeline
// needed six days to produce one draft.
//
// These tests drive the mechanism with `chunkBudgetMs: 0`, which makes every
// invocation hand off after exactly one block — the worst case the platform
// can impose — and assert that the job still reaches an item, that no block is
// paid for twice, and that the lease is released BEFORE the self-continue is
// fired (see handOff's ordering comment: firing first would make the receiver
// lose the acquire and stall the job until the lease expired).
// ---------------------------------------------------------------------------

/** deps + recorders for the hand-off: lease release, self-continue, ordering. */
function withHandOffRecorders(deps) {
  const events = [];
  const fired = [];
  deps.releaseLease = async (table, jobId, owner) => {
    events.push(`release:${jobId}`);
    return true;
  };
  deps.selfContinue = (jobId) => {
    events.push(`self-continue:${jobId}`);
    fired.push(jobId);
    return { fired: true, reason: null };
  };
  return { events, fired };
}

test("self-continue: a budget hit at a block boundary checkpoints, hands off, and returns a third outcome", async () => {
  const { llm } = makeFakeLlm([LI_WORK_ORDER, RESEARCH_PACK, LI_DRAFT, LI_REVIEW_PASS]);
  const { deps, jobUpdates, items } = makeDeps(llm);
  const { events, fired } = withHandOffRecorders(deps);
  deps.chunkBudgetMs = 0; // hand off at the first boundary there is

  const result = await startContentJob("job-sc-1", deps);

  // NOT an item and NOT null — "checkpointed, more work to do" is its own fact.
  assert.ok(result && result.checkpointed === true, "the hand-off is reported, not silent");
  assert.equal(result.job_id, "job-sc-1");
  assert.equal(result.after, "coordinate", "it stopped after the first completed block");
  assert.equal(result.blocks_run, 1, "real progress was made before handing off");
  assert.equal(result.self_continue.fired, true);
  assert.equal(items.length, 0, "no item yet — the job is mid-pipeline");

  // The checkpoint is durable BEFORE the hand-off, or the next invocation
  // would redo the block we just paid for.
  const checkpointWrites = jobUpdates.filter((u) => u.checkpoint);
  assert.equal(checkpointWrites.length, 1);
  assert.deepEqual(checkpointWrites[0].checkpoint.completedBlocks, ["coordinate"]);
  assert.ok(checkpointWrites[0].checkpoint.workOrder, "the block's output is in the checkpoint");

  // The job is NOT failed: a hand-off must never look like a failure.
  const statuses = jobUpdates.map((u) => u.status).filter(Boolean);
  assert.ok(!statuses.includes("failed"), "a hand-off is not a failure");

  assert.deepEqual(fired, ["job-sc-1"], "exactly one self-continue, naming this job");
});

test("self-continue: the lease is released BEFORE the request is fired", async () => {
  const { llm } = makeFakeLlm([LI_WORK_ORDER, RESEARCH_PACK, LI_DRAFT, LI_REVIEW_PASS]);
  const { deps } = makeDeps(llm);
  const { events } = withHandOffRecorders(deps);
  deps.chunkBudgetMs = 0;

  await startContentJob("job-sc-2", deps);

  const releaseAt = events.indexOf("release:job-sc-2");
  const fireAt = events.indexOf("self-continue:job-sc-2");
  assert.ok(releaseAt >= 0, "the lease is released on the hand-off path");
  assert.ok(fireAt >= 0, "the self-continue is fired");
  assert.ok(
    releaseAt < fireAt,
    "firing first would let the receiving invocation lose the lease acquire and stall the job " +
      "until the lease expired — a slower version of the bug this fixes"
  );
});

test("self-continue: a job started by the batch reaches an item WITHOUT a second cron day", async () => {
  // One shared LLM script across the whole chain: if any invocation re-ran a
  // completed block it would consume a response out of order and the final
  // assertions would fail.
  const { llm, prompts } = makeFakeLlm([LI_WORK_ORDER, RESEARCH_PACK, LI_DRAFT, LI_REVIEW_PASS]);
  const { deps, jobUpdates, items } = makeDeps(llm);
  const { fired } = withHandOffRecorders(deps);
  deps.chunkBudgetMs = 0; // one block per function lifetime — the worst case
  deps.job = {
    id: "job-sc-3",
    brand: "TestDiag",
    playbook: "linkedin_post",
    status: "pending",
    input: { type: "topic", topic: "home collection economics", source: "daily_batch" },
    cost_total: 0,
    checkpoint: null,
  };

  // Stand in for the route's `?job_id=` branch: every self-continue the worker
  // fires becomes another invocation, carrying the checkpoint the previous one
  // persisted. NO cron tick is involved.
  let result = null;
  let invocations = 0;
  while (invocations < 20) {
    invocations += 1;
    result = await startContentJob("job-sc-3", deps);
    if (!result || !result.checkpointed) break;
    // The receiving invocation reads the row the previous one left behind.
    const lastCheckpoint = jobUpdates.filter((u) => u.checkpoint).pop().checkpoint;
    const lastStatus = jobUpdates.map((u) => u.status).filter(Boolean).pop();
    const lastCost = jobUpdates.map((u) => u.cost_total).filter((c) => c != null).pop();
    deps.job = { ...deps.job, status: lastStatus, checkpoint: lastCheckpoint, cost_total: lastCost };
  }

  assert.ok(result && result.id, `the chain produced an item (after ${invocations} invocations)`);
  assert.equal(items.length, 1, "exactly one content_items row — no duplicate from a re-run");
  assert.equal(items[0].status, "awaiting_approval");
  assert.ok(invocations > 1, "the point of the test is that it took several function lifetimes");
  assert.equal(
    fired.length,
    invocations - 1,
    "every invocation but the last handed off; the last one finished the job"
  );

  // No block was paid for twice: the scripted LLM had exactly one response per
  // LLM-backed block, and an extra call would have thrown "fake llm exhausted".
  assert.equal(prompts.length, 4, "coordinate, research, draft, review — each called once");

  const statuses = jobUpdates.map((u) => u.status).filter(Boolean);
  assert.ok(!statuses.includes("failed"), "no invocation in the chain failed");
  assert.equal(statuses[statuses.length - 1], "awaiting_approval");
});

test("self-continue: a resume whose last remaining block ends in a terminal verdict finishes instead of handing off", async () => {
  // R3.1.11 — RENAMED. This was called "a hand-off never happens without at
  // least one block of progress", which it does not prove: its fixture runs the
  // review block either way, so `blocksRun` is 1 by the time any budget check
  // is reached and the `blocksRun > 0` guard in overBudget() is never the
  // reason for the outcome. What it really proves is the hand-off point's
  // placement BELOW the terminal-verdict breaks: a pass is one non-LLM insert
  // from an item, so no round trip is spent on it. The zero-progress guard
  // itself is proven by the test that follows.
  const { llm } = makeFakeLlm([LI_REVIEW_PASS]);
  const { deps, items } = makeDeps(llm);
  const { fired } = withHandOffRecorders(deps);
  deps.chunkBudgetMs = 0;
  deps.job = {
    id: "job-sc-4",
    brand: "TestDiag",
    playbook: "linkedin_post",
    status: "drafting",
    input: {},
    cost_total: 0.02,
    checkpoint: {
      pipeline: ["coordinate", "research", "benchmark", "draft", "review"],
      completedBlocks: ["coordinate", "research", "benchmark", "draft:1"],
      cycle: 1,
      review: null,
      revisions: [],
      workOrder: LI_WORK_ORDER,
      researchPack: RESEARCH_PACK,
      benchmarkNotes: { pack: {} },
      draft: LI_DRAFT,
      factCheck: null,
      critique: "",
    },
  };

  const result = await startContentJob("job-sc-4", deps);

  // Only review remained. It ran (one block of progress), the verdict passed,
  // and the item is one non-LLM insert away — so no hand-off is spent on it.
  assert.ok(result && result.id, "the job finished rather than handing off");
  assert.equal(items.length, 1);
  assert.deepEqual(fired, [], "a terminal verdict is not worth a round trip");
});

/**
 * R3.1.11 — THE ZERO-PROGRESS GUARD: `blocksRun > 0 &&` in overBudget()
 * (src/lib/content/contentWorker.js). Nothing covered it, because every other
 * hand-off point in this suite is reached immediately after a `blocksRun += 1`,
 * so the guard is true whether or not it is written.
 *
 * The one hand-off point that can be reached having run NOTHING is the post-
 * review one: a resume whose checkpoint already holds this cycle's draft AND
 * this cycle's review skips both blocks, then falls through to the budget check
 * with a failing verdict and a cycle still owed. Combine that with an
 * invocation that is ALREADY over budget when it starts — which is the normal
 * case R3.1.14 made expressible, the sweep's fourth job beginning 250 s into a
 * 300 s function — and without the guard this invocation hands the job straight
 * back without writing a single new checkpoint. The receiver reads the same row,
 * makes the same decision, and the job ping-pongs between invocations forever
 * while every log line reads "checkpointed and handed off".
 *
 * THE FIXTURE is a checkpoint whose `cycle` counter lags its completedBlocks
 * (cycle 0, but draft:1 and review:1 recorded, with cycle 1's failing review
 * attached). The current writer cannot produce this row — buildCheckpoint
 * writes `cycle` and the blocks together into one jsonb column, so a killed
 * worker leaves either the old checkpoint or the new one, never a mix. What
 * CAN produce it is a hand-edited rescue or a future writer that drifts, and
 * that is the class of input the guard exists to make harmless (the R3.1.11
 * verifier confirmed the guard is unreachable defensive code against every
 * state today's writer emits). MAX_DRAFT_REVIEW_CYCLES is 2, so cycle 2 is
 * still owed and the loop has real work to do.
 */
function staleReviewBoundaryJob(jobId) {
  return {
    id: jobId,
    brand: "TestDiag",
    playbook: "linkedin_post",
    status: "reviewing",
    input: {},
    cost_total: 0.04,
    checkpoint: {
      pipeline: ["coordinate", "research", "benchmark", "draft", "review"],
      // draft:1 and review:1 are done; the cycle counter did not keep up.
      completedBlocks: ["coordinate", "research", "benchmark", "draft:1", "review:1"],
      cycle: 0,
      review: LI_REVIEW_FAIL,
      revisions: [],
      workOrder: LI_WORK_ORDER,
      researchPack: RESEARCH_PACK,
      benchmarkNotes: { pack: {} },
      draft: LI_DRAFT,
      factCheck: null,
      critique: "",
    },
  };
}

test("R3.1.11 self-continue: an invocation already over budget on entry runs a block before handing off — never zero", async () => {
  const { llm } = makeFakeLlm([LI_DRAFT, LI_REVIEW_PASS]);
  const { deps, jobUpdates, items } = makeDeps(llm);
  const { fired } = withHandOffRecorders(deps);

  // Over budget the moment this invocation begins: the function started 250 s
  // ago and the budget is 90 s. One clock for both, as production has.
  deps.now = () => 250_000;
  deps.invocationStartMs = 0;
  deps.chunkBudgetMs = 90_000;
  deps.job = staleReviewBoundaryJob("job-zero-progress");

  const result = await startContentJob("job-zero-progress", deps);

  assert.ok(result && result.checkpointed === true, "premise: this invocation does hand off");
  assert.notEqual(
    result.blocks_run,
    0,
    "a hand-off with blocks_run: 0 is the ping-pong — the receiving invocation would read the " +
      "identical row, hand off again, and the job would never advance. Restore `blocksRun > 0 &&` " +
      "in overBudget()."
  );
  assert.equal(result.blocks_run, 1, "exactly one block of real progress was bought first");
  assert.equal(
    result.after,
    "draft:2",
    "it handed off after the draft it just paid for, not at the review boundary it walked in on"
  );
  // And that block left a durable checkpoint behind, which is what makes the
  // hand-off progress rather than a round trip.
  const checkpoints = jobUpdates.filter((u) => u.checkpoint).map((u) => u.checkpoint);
  assert.ok(checkpoints.length >= 1, "the block it ran was persisted before the hand-off");
  assert.ok(
    checkpoints[checkpoints.length - 1].completedBlocks.includes("draft:2"),
    "the receiving invocation will not be asked to pay for draft:2 again"
  );
  assert.deepEqual(fired, ["job-zero-progress"]);
  assert.equal(items.length, 0, "still mid-pipeline");
});

test("R3.1.11 self-continue: the chain out of that state terminates instead of ping-ponging", async () => {
  // The same stale row, driven as a chain of invocations (each one already over
  // budget on entry, the worst case the platform can impose). With the guard
  // the chain advances one block per invocation and ends in an item; without it
  // no invocation writes a checkpoint and this loop runs to its cap.
  const { llm } = makeFakeLlm([LI_DRAFT, LI_REVIEW_PASS]);
  const { deps, jobUpdates, items } = makeDeps(llm);
  const { fired } = withHandOffRecorders(deps);
  deps.now = () => 250_000;
  deps.invocationStartMs = 0;
  deps.chunkBudgetMs = 90_000;
  deps.job = staleReviewBoundaryJob("job-zero-progress-chain");

  let result = null;
  let invocations = 0;
  const handOffs = [];
  while (invocations < 8) {
    invocations += 1;
    result = await startContentJob("job-zero-progress-chain", deps);
    if (!result || !result.checkpointed) break;
    handOffs.push(result);
    const lastCheckpoint = jobUpdates.filter((u) => u.checkpoint).pop()?.checkpoint || null;
    const lastStatus = jobUpdates.map((u) => u.status).filter(Boolean).pop();
    deps.job = { ...deps.job, status: lastStatus, checkpoint: lastCheckpoint };
  }

  assert.ok(
    result && result.id,
    `the chain reached an item; instead it handed off ${invocations} times in a row, which is the ` +
      "zero-progress ping-pong"
  );
  assert.equal(items.length, 1, "exactly one content_items row");
  for (const handOff of handOffs) {
    assert.ok(
      handOff.blocks_run >= 1,
      `every hand-off must carry progress; "${handOff.after}" carried ${handOff.blocks_run}`
    );
  }
  assert.equal(fired.length, handOffs.length, "one self-continue per hand-off and no more");
});

test("self-continue: a mid-loop hand-off after a failing review resumes at the next draft cycle", async () => {
  const { llm } = makeFakeLlm([LI_DRAFT, LI_REVIEW_PASS]);
  const { deps, jobUpdates, items } = makeDeps(llm);
  const { fired } = withHandOffRecorders(deps);
  deps.chunkBudgetMs = 0;
  deps.job = {
    id: "job-sc-5",
    brand: "TestDiag",
    playbook: "linkedin_post",
    status: "reviewing",
    input: {},
    cost_total: 0.03,
    checkpoint: {
      pipeline: ["coordinate", "research", "benchmark", "draft", "review"],
      completedBlocks: ["coordinate", "research", "benchmark", "draft:1"],
      cycle: 1,
      review: null,
      revisions: [],
      workOrder: LI_WORK_ORDER,
      researchPack: RESEARCH_PACK,
      benchmarkNotes: { pack: {} },
      draft: LI_DRAFT,
      factCheck: null,
      critique: "",
    },
  };

  // Script a FAILING review for cycle 1 so another cycle is owed.
  const { llm: failingLlm } = makeFakeLlm([LI_REVIEW_FAIL]);
  deps.llm = failingLlm;

  const handOff = await startContentJob("job-sc-5", deps);
  assert.ok(handOff && handOff.checkpointed, "a failing review with budget left hands off");
  assert.equal(handOff.after, "review:1", "it stopped after the review it just paid for");
  assert.deepEqual(fired, ["job-sc-5"]);
  assert.equal(items.length, 0);

  // The receiving invocation, with room to finish.
  const lastCheckpoint = jobUpdates.filter((u) => u.checkpoint).pop().checkpoint;
  assert.ok(lastCheckpoint.review, "the failing review is in the checkpoint");
  const { llm: secondLlm } = makeFakeLlm([LI_DRAFT, LI_REVIEW_PASS]);
  deps.llm = secondLlm;
  deps.chunkBudgetMs = 60_000;
  deps.job = { ...deps.job, status: "reviewing", checkpoint: lastCheckpoint };

  const item = await startContentJob("job-sc-5", deps);
  assert.ok(item && item.id, "the resumed invocation finished the job");
  assert.equal(item.cycle, 2, "it resumed at the SECOND draft cycle, as the checkpoint said");
  assert.equal(item.revisions.length, 1, "the failed cycle-1 draft was archived exactly once");
});

// ---------------------------------------------------------------------------
// R3.1.14 — the budget is measured against the INVOCATION, not against the
// moment this job happened to start.
//
// THE FINDING (production, 2026-09-18 19:15 UTC). The cron sweep ran four jobs
// inside one 300 s function. Each job's 150 s budget was measured from its own
// chunkStartMs, so a job that started 200 s into the invocation still believed
// it had 150 s of runway — it never once evaluated over budget, and the
// platform killed it mid-block with no hand-off. The route now hands the
// worker the invocation's start clock.
// ---------------------------------------------------------------------------

test("R3.1.14 budget: an invocation that is already old hands off after its first block", async () => {
  const { llm } = makeFakeLlm([LI_WORK_ORDER, RESEARCH_PACK, LI_DRAFT, LI_REVIEW_PASS]);
  const { deps, items } = makeDeps(llm);
  const { fired } = withHandOffRecorders(deps);

  // One fake clock for both, exactly as production uses Date.now for both.
  let clock = 250_000;
  deps.now = () => clock;
  // The invocation began 250 s ago; THIS job starts now. Under the old
  // per-job clock it would have had a full budget of runway.
  deps.invocationStartMs = 0;
  deps.chunkBudgetMs = 90_000;

  const result = await startContentJob("job-old-invocation", deps);

  assert.ok(
    result && result.checkpointed === true,
    "the job must hand off: the FUNCTION is nearly out of time even though this job just started"
  );
  assert.equal(result.blocks_run, 1, "one real block of progress first — a hand-off is never free");
  assert.deepEqual(fired, ["job-old-invocation"]);
  assert.equal(items.length, 0);
});

test("R3.1.14 budget: a fresh invocation still runs the whole job in one go", async () => {
  const { llm } = makeFakeLlm([LI_WORK_ORDER, RESEARCH_PACK, LI_DRAFT, LI_REVIEW_PASS]);
  const { deps, items } = makeDeps(llm);
  const { fired } = withHandOffRecorders(deps);

  let clock = 1_000;
  deps.now = () => clock;
  deps.invocationStartMs = 1_000; // this job IS the invocation
  deps.chunkBudgetMs = 90_000;

  const item = await startContentJob("job-fresh-invocation", deps);

  assert.ok(item && item.id, "a short job inside a fresh invocation finishes without a round trip");
  assert.equal(items.length, 1);
  assert.deepEqual(fired, [], "no hand-off was spent");
});

test("R3.1.14 budget: with no invocation clock the worker falls back to its own start", async () => {
  // The fallback keeps every existing caller (and every existing test) exact:
  // a job that IS the invocation measures from itself.
  const { llm } = makeFakeLlm([LI_WORK_ORDER, RESEARCH_PACK, LI_DRAFT, LI_REVIEW_PASS]);
  const { deps, items } = makeDeps(llm);
  const { fired } = withHandOffRecorders(deps);

  let clock = 500_000; // an absolute clock far from zero, and no invocationStartMs
  deps.now = () => clock;
  deps.chunkBudgetMs = 90_000;

  const item = await startContentJob("job-no-clock", deps);

  assert.ok(item && item.id, "the job runs to completion — the elapsed time is 0, not 500_000");
  assert.equal(items.length, 1);
  assert.deepEqual(fired, []);
});

test("R3.1.14 budget: the shipped default leaves headroom for one more content block", async () => {
  const { CONTENT_CHUNK_BUDGET_MS } = await import("./contentWorker.js");
  // 300_000 is the route's maxDuration (src/app/api/content/worker/route.js).
  // The budget is checked AFTER a block, so what is left has to absorb one more
  // block that started just under the line, plus the checkpoint write, the
  // lease release and the hand-off fetch.
  assert.ok(
    CONTENT_CHUNK_BUDGET_MS >= 60_000 && CONTENT_CHUNK_BUDGET_MS <= 90_000,
    `the chunk budget must hand off well before the 300 s platform cap; got ${CONTENT_CHUNK_BUDGET_MS}`
  );
  assert.ok(
    300_000 - CONTENT_CHUNK_BUDGET_MS >= 200_000,
    "at least 200 s must remain after the budget line for the overshooting block and the hand-off"
  );
});

// ---------------------------------------------------------------------------
// R3.5.7 — a worker execution must not rewind a job that already delivered.
//
// Production, 2026-09-18: job 355b0237 reached awaiting_approval with an item
// at 19:17:51; a second execution then wrote a running status back over it, and
// from then on every sweep re-dispatched it. R3.5.6 broke that loop at the
// rescue predicate. These pin the two writes that caused it: startContentJob
// now looks at the row before it spends, and every status write is conditional.
// ---------------------------------------------------------------------------

const { CONTENT_JOB_RUNNING: RUNNING_STATUSES } = await import("../db/content.js");

/** An LLM that fails the test the moment it is called: a refusal must not spend. */
function llmThatMustNotRun() {
  return async () => {
    throw new Error("the LLM was called for a job that had already delivered — that is the double spend");
  };
}

test("R3.5.7 REFUSE — a delivered job is refused with a named outcome: nothing runs, nothing is written", async () => {
  // `failed` is included on purpose: it is the state 355b0237 was actually left in.
  for (const status of ["awaiting_approval", "approved", "published", "rejected", "failed"]) {
    const { deps, jobUpdates, items } = makeDeps(llmThatMustNotRun());
    deps.job = { ...deps.job, status, item_id: "item-already-there" };

    const out = await startContentJob("job-1", deps);

    assert.deepEqual(
      out,
      { refused: true, reason: "already_delivered", job_id: "job-1", status, item_id: "item-already-there" },
      `status "${status}" + item_id must be a refusal — not null (failure), not an item (success)`
    );
    assert.deepEqual(jobUpdates, [], `THE BUG: a "${status}" job was rewound by a status write`);
    assert.deepEqual(items, [], "and no second item row was written to fight the first");
  }
});

test("R3.5.7 REFUSE — item_id alone decides nothing: a job with NO item still runs", async () => {
  // The refusal must not swallow real work. `pending` with no item is the
  // ordinary case and is covered by the happy path; this is the edge: a row
  // whose item_id is null is never "delivered", whatever its status claims.
  const { llm } = makeFakeLlm([LI_WORK_ORDER, RESEARCH_PACK, LI_DRAFT, LI_REVIEW_PASS]);
  const { deps, items } = makeDeps(llm);
  deps.job = { ...deps.job, status: "pending", item_id: null };

  const item = await startContentJob("job-1", deps);

  assert.ok(item && !item.refused, "a job with no item is live work and must run");
  assert.equal(items.length, 1);
});

test("R3.5.7 GUARD — every STATUS write is conditional on a worker-owned status; trace/cost writes are not", async () => {
  const { llm } = makeFakeLlm([LI_WORK_ORDER, RESEARCH_PACK, LI_DRAFT, LI_REVIEW_PASS]);
  const { deps } = makeDeps(llm);
  const writes = [];
  deps.updateContentJob = async (jobId, updates, writeDeps) => {
    writes.push({
      status: updates.status ?? null,
      ifStatusIn: writeDeps?.ifStatusIn ?? null,
      ownershipProbe: !!writeDeps?.ownershipProbe,
    });
    return { id: jobId, ...updates };
  };

  await startContentJob("job-1", deps);

  const statusWrites = writes.filter((w) => w.status);
  assert.ok(statusWrites.length >= 6, "the pipeline writes a status at every stage");
  for (const w of statusWrites) {
    assert.deepEqual(
      w.ifStatusIn,
      RUNNING_STATUSES,
      `the write of "${w.status}" went out UNGUARDED — a second execution could rewind a delivered job with it`
    );
  }
  // The ONE no-status write that is guarded is the pre-item ownership check,
  // which is guarded precisely because it is asking "is this row still ours?".
  for (const w of writes.filter((x) => !x.status && !x.ownershipProbe)) {
    assert.equal(w.ifStatusIn, null, "a write with no status cannot rewind a lifecycle and stays unconditional");
  }
  assert.equal(writes.filter((x) => x.ownershipProbe).length, 1, "exactly one ownership check per delivered item");
});

// The test that stood here ("a refused status write is survived loudly") was
// VACUOUS, and the R3.5.7 verifier caught it: its fixtures let the pipeline
// succeed, so the catch block never ran and "`failed` never reached the row"
// passed without the failure write ever being issued. Worse, it blessed the
// behaviour that turned out to be the bug — carrying on after a refusal. The
// four tests below each FORCE the path they name.

/** A status-write stub whose refusals start at a chosen point. Records everything. */
function guardedUpdateStub({ refuseWhen }) {
  const seen = [];
  const stub = async (jobId, updates, writeDeps) => {
    const entry = {
      status: updates.status ?? null,
      guarded: Array.isArray(writeDeps?.ifStatusIn),
      ownershipProbe: !!writeDeps?.ownershipProbe,
      refused: false,
    };
    seen.push(entry);
    if (entry.guarded && refuseWhen(entry, seen)) {
      entry.refused = true;
      return { refused: true, reason: "status_guard", job_id: jobId, attempted_status: entry.status, detail: "row moved" };
    }
    return { id: jobId, ...updates };
  };
  return { stub, seen };
}

test("R3.5.7 ABORT — a refused status write STOPS the run: the delivered item is never touched", async () => {
  // THE VERIFIER'S FINDING. Another execution delivered this job; every guarded
  // write is now refused. The old code logged and carried on to
  // insertContentItem, whose (job_id, cycle) upsert overwrote the draft a human
  // was reading and rewound an approved item — then returned it as a success.
  const { llm } = makeFakeLlm([LI_WORK_ORDER, RESEARCH_PACK, LI_DRAFT, LI_REVIEW_PASS]);
  const { deps, items } = makeDeps(llm);
  const { stub, seen } = guardedUpdateStub({ refuseWhen: () => true });
  deps.updateContentJob = stub;

  const out = await startContentJob("job-1", deps);

  assert.deepEqual(items, [], "THE BUG: insertContentItem ran and overwrote the delivered item");
  assert.equal(out?.refused, true, "not an item (a fabricated success) and not null (a failure to retry)");
  assert.equal(out.reason, "no_longer_ours");
  assert.equal(out.job_id, "job-1");
  assert.equal(seen.filter((w) => w.refused).length, 1, "the FIRST refusal ends the run — it does not try again five more times");
  assert.equal(
    seen.some((w) => w.status === "failed"),
    false,
    "no failure write is even ATTEMPTED: the row belongs to a delivered job, not to a failed one"
  );
});

test("R3.5.7 ABORT — delivered out from under us DURING review: the ownership check stops the item write", async () => {
  // Every status write succeeds ("reviewing" was the last). Then, while the
  // review LLM call runs, another execution delivers. Only the pre-item
  // ownership check can see that — without it the upsert goes ahead.
  const { llm } = makeFakeLlm([LI_WORK_ORDER, RESEARCH_PACK, LI_DRAFT, LI_REVIEW_PASS]);
  const { deps, items } = makeDeps(llm);
  const { stub, seen } = guardedUpdateStub({ refuseWhen: (entry) => entry.ownershipProbe });
  deps.updateContentJob = stub;

  const out = await startContentJob("job-1", deps);

  const probe = seen.find((w) => w.ownershipProbe);
  assert.ok(probe, "the row's ownership must be asked for immediately before the item write");
  assert.equal(probe.guarded, true, "and asked of the DATABASE, as a guarded write — not read and then trusted");
  assert.equal(probe.status, null, "it writes no status: it must not add a step to the lifecycle");
  assert.deepEqual(items, [], "the item write did not happen");
  assert.equal(out?.reason, "no_longer_ours");
  assert.deepEqual(
    seen.map((w) => w.status).filter(Boolean),
    ["coordinating", "researching", "benchmarking", "drafting", "reviewing"],
    "the run got all the way to review before it was stopped — and never wrote awaiting_approval"
  );
});

test("R3.5.7 GUARD — a GENUINE mid-pipeline failure writes `failed` THROUGH the guard", async () => {
  // Unpinned until the verifier mutated it: the failure write at the end of the
  // catch block could go out unguarded and nothing noticed. The LLM script is
  // too short on purpose, so the pipeline really throws and the catch really runs.
  const { llm } = makeFakeLlm([LI_WORK_ORDER]);
  const { deps } = makeDeps(llm);
  const { stub, seen } = guardedUpdateStub({ refuseWhen: () => false });
  deps.updateContentJob = stub;

  const out = await startContentJob("job-1", deps);

  assert.equal(out, null, "a real failure is still null — the refusal outcomes must not swallow it");
  const failWrite = seen.find((w) => w.status === "failed");
  assert.ok(failWrite, "the pipeline threw, so a failure write must have been issued");
  assert.equal(
    failWrite.guarded,
    true,
    "THE SURVIVING MUTATION: an unguarded `failed` write stamps failed over a job that reached the human gate"
  );
});

test("R3.5.7 GUARD — when that failure write is REFUSED, `failed` never lands and nothing goes around the guard", async () => {
  // The run fails for a real reason, but by then the row was delivered by
  // someone else. `failed` must not overwrite awaiting_approval, and the worker
  // must not retry the write unguarded to "make sure".
  const { llm } = makeFakeLlm([LI_WORK_ORDER]);
  const { deps, items } = makeDeps(llm);
  const { stub, seen } = guardedUpdateStub({ refuseWhen: (entry) => entry.status === "failed" });
  deps.updateContentJob = stub;

  const out = await startContentJob("job-1", deps);

  assert.equal(out, null);
  const failWrites = seen.filter((w) => w.status === "failed");
  assert.equal(failWrites.length, 1, "asked once, refused once — no second attempt");
  assert.equal(failWrites[0].guarded, true);
  assert.equal(failWrites[0].refused, true);
  assert.deepEqual(items, []);
});
