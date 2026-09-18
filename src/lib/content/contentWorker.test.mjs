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

test("self-continue: a hand-off never happens without at least one block of progress", async () => {
  // A job whose checkpoint already covers every block it would run this
  // invocation must NOT hand off — two invocations that each advance zero
  // blocks would ping-pong the job forever.
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
