import { test } from "node:test";
import assert from "node:assert/strict";

/**
 * R3.2.4 — this suite is hermetic BY CONSTRUCTION, not by an unset shell.
 *
 * Two cases below run `startContentJob`, which acquires and renews a lease with
 * `acquireLease("content_jobs", ...)` / `renewLease(...)`. Neither takes an
 * injectable client from here — both resolve db.js's module-level one, which is
 * built at import time from NEXT_PUBLIC_SUPABASE_URL / _ANON_KEY. So with
 * credentials loaded (what src/lib/liveDbGate.js tells live-test authors to do)
 * those cases issued real `UPDATE content_jobs` statements against production,
 * on a job id that exists only in this file. Nothing here ever intended to
 * touch a database; it was kept off one by the accident of an unset variable.
 *
 * Clearing the credentials FIRST and importing the module graph afterwards
 * makes db.js's client null no matter how the suite is invoked. The imports
 * have to be dynamic for that to work: static ones are hoisted and evaluated
 * before any statement in this file, so db.js would capture the credentials
 * before the two `delete`s ran. All of them are dynamic rather than only the
 * ones that reach db.js today, because which import reaches it is not this
 * file's business to track.
 */
delete process.env.NEXT_PUBLIC_SUPABASE_URL;
delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

const { validatePipeline, resolvePipeline, DEFAULT_PIPELINES, getBlock } = await import("./agents/blocks.js");
const { validateFactCheck } = await import("./schemas.js");
const { formatKnowledge } = await import("./steps/shared.js");
const { renderDirective } = await import("./steps/transform.js");
const { initTrace } = await import("./agents/trace.js");
const { startContentJob } = await import("./contentWorker.js");
const { supabase } = await import("../db.js");

assert.equal(
  supabase,
  null,
  "db.js still has a client: the credential clearing above did not take effect, and the two " +
    "startContentJob cases below would write to production's content_jobs"
);

// --- pipeline validation ---------------------------------------------------

test("validatePipeline accepts the default crew and a custom crew", () => {
  assert.equal(validatePipeline(DEFAULT_PIPELINES.geo_article).ok, true);
  const custom = validatePipeline([
    "coordinate", "research", "benchmark", "draft", "voice_polish", "translate", "fact_check", "review",
  ]);
  assert.equal(custom.ok, true);
});

test("validatePipeline enforces the locked posts", () => {
  assert.ok(!validatePipeline(["research", "draft", "review"]).ok, "must start with coordinate");
  assert.ok(!validatePipeline(["coordinate", "draft", "fact_check"]).ok, "must end with review");
  assert.ok(!validatePipeline(["coordinate", "research", "review"]).ok, "must include draft");
});

test("validatePipeline enforces block ordering by kind", () => {
  const r = validatePipeline(["coordinate", "draft", "research", "review"]);
  assert.ok(!r.ok);
  assert.ok(r.errors.some((e) => e.includes("before the Writer")));

  const r2 = validatePipeline(["coordinate", "translate", "draft", "review"]);
  assert.ok(!r2.ok);
  assert.ok(r2.errors.some((e) => e.includes("after the Writer")));
});

test("validatePipeline rejects unknown and duplicate blocks", () => {
  assert.ok(!validatePipeline(["coordinate", "draft", "flying_block", "review"]).ok);
  assert.ok(!validatePipeline(["coordinate", "research", "research", "draft", "review"]).ok);
});

test("resolvePipeline falls back to the base default on invalid pipelines", () => {
  const agent = { base: "geo_article", pipeline: ["draft"] };
  assert.deepEqual(resolvePipeline(agent), DEFAULT_PIPELINES.geo_article);
  const good = { base: "geo_article", pipeline: ["coordinate", "draft", "tighten", "review"] };
  assert.deepEqual(resolvePipeline(good), ["coordinate", "draft", "tighten", "review"]);
});

// --- fact-check validator (code owns the pass rule) -------------------------

test("validateFactCheck: fabricated or banned issues force a fail", () => {
  const r = validateFactCheck({
    passed: true, // model lied
    issues: [{ claim: "18% goes to logistics", problem: "no source", kind: "fabricated" }],
    critique: "1. Remove the number.",
  });
  assert.equal(r.ok, true);
  assert.equal(r.value.passed, false);
});

test("validateFactCheck: overstated issues alone do not fail", () => {
  const r = validateFactCheck({
    passed: true,
    issues: [{ claim: "the biggest chain", problem: "source says among the biggest", kind: "overstated" }],
    critique: "",
  });
  assert.equal(r.value.passed, true);
  assert.equal(r.value.issues.length, 1);
});

// --- knowledge formatting ----------------------------------------------------

test("formatKnowledge orders by precedence, labels types, and caps size", () => {
  const out = formatKnowledge([
    { type: "banned_claims", title: "Never say", content: "We never claim NABL accreditation for the Pune lab.", active: true },
    { type: "url", title: "Pricing page", content: "Corporate packages start at ₹1,499.", source_url: "https://x.in/pricing", active: true },
    { type: "snippet", title: "Inactive", content: "should not appear", active: false },
  ]);
  assert.ok(out.indexOf("BANNED CLAIMS") < out.indexOf("PINNED SOURCE"), "drag order preserved");
  assert.ok(out.includes("https://x.in/pricing"));
  assert.ok(!out.includes("should not appear"), "inactive blocks excluded");
});

test("formatKnowledge is honest when empty", () => {
  assert.ok(formatKnowledge([]).includes("no knowledge blocks"));
});

// --- transform directive interpolation --------------------------------------

test("renderDirective interpolates block config with defaults", () => {
  const block = getBlock("translate");
  const withCfg = renderDirective(block, { block_config: { translate: { language: "Marathi" } } });
  assert.ok(withCfg.includes("Marathi"));
  const withDefault = renderDirective(block, {});
  assert.ok(withDefault.includes("Hindi"));
});

// --- dynamic trace -----------------------------------------------------------

test("initTrace builds entries for a custom pipeline from the registry", () => {
  const t = initTrace(["coordinate", "draft", "translate", "fact_check", "review"]);
  assert.deepEqual(t.map((x) => x.step), ["coordinate", "draft", "translate", "fact_check", "review"]);
  assert.equal(t[2].name, "Translator");
  assert.equal(t[3].emoji, "🧾");
});

// --- end-to-end: custom crew through the worker ------------------------------

const WORK_ORDER = {
  angle: "a", title_hint: "t",
  target_queries: ["q"], fan_out: ["a", "b", "c"],
  sections: [{ h2: "H?", sub_query: "a", evidence_note: "x" }], notes: "",
};
const PACK = {
  sources: [{ url: "https://s.com", title: "s", type: "cited_page", key_points: [] }],
  stats: [{ stat: "18%", source_url: "https://s.com" }],
  quotes: [], paa: [], angles: [], unsupported_subqueries: [],
};
const BENCH = {
  format_distribution: { listicle: 100 }, dominant_format: "listicle",
  directive: "Build a listicle.", earned_placement: false,
  engine_divergence: "none observed", structural_notes: [],
};
const DRAFT = { title: "T", body_md: "## 1. Item\n" + "x ".repeat(900), meta_description: "m", levers_used: [] };
const HINDI_DRAFT = { title: "T-hi", body_md: "## १. आइटम\n" + "य ".repeat(900), meta_description: "m", levers_used: [] };
const FACT_CHECK_OK = { passed: true, issues: [{ claim: "18%", problem: "matches source but rounded", kind: "overstated" }], critique: "" };
const REVIEW_PASS = {
  scores: { facts_vs_research: 0.9, citation_validity: 0.85, authority_specificity: 0.85, brand_voice: 0.8, channel_checklist: 0.9, ymyl_compliance: 1.0 },
  verdict: "pass", ymyl_violation: false, violations: [], critique: "",
};

test("worker runs a custom crew: transforms + fact-check between Writer and Editor", async () => {
  const responses = [WORK_ORDER, PACK, BENCH, DRAFT, HINDI_DRAFT, FACT_CHECK_OK, REVIEW_PASS];
  const prompts = [];
  const llm = async (p, o = {}) => {
    prompts.push(p);
    if (o.stats) o.stats.cost = (o.stats.cost || 0) + 0.001;
    return responses.shift();
  };

  const agent = {
    name: "Hindi Listicle Writer", emoji: "🔢", base: "geo_article", format: "listicle",
    channel: "blog", length_hint: "", design_rules: [], format_config: {},
    custom_instructions: "", rubric_emphasis: {},
    pipeline: ["coordinate", "research", "benchmark", "draft", "translate", "fact_check", "review"],
    block_config: { translate: { language: "Hindi" } },
  };

  const jobUpdates = [];
  const items = [];
  const deps = {
    llm,
    scrape: async () => "No website content available.",
    job: { id: "j1", brand: "B", playbook: "geo_article", status: "pending", input: { query: "q" }, agent_snapshot: agent },
    updateContentJob: async (id, u) => (jobUpdates.push(u), { id, ...u }),
    insertContentItem: async (i) => (items.push({ id: "i1", ...i }), { id: "i1", ...i }),
    listLessons: async () => [],
    getScansForBrand: async () => [],
    getBrandBrief: async () => null,
    upsertBrandBrief: async () => ({}),
    listKnowledgeBlocks: async () => [
      { type: "banned_claims", title: "No NABL claim", content: "Never claim NABL for Pune.", active: true },
    ],
  };

  const item = await startContentJob("j1", deps);
  assert.ok(item, "job completes");

  // Trace covers the full custom crew, all done.
  const final = jobUpdates[jobUpdates.length - 1].agent_trace;
  assert.deepEqual(
    final.map((t) => t.step),
    ["coordinate", "research", "benchmark", "draft", "translate", "fact_check", "review"]
  );
  assert.ok(final.every((t) => t.status === "done"));
  assert.ok(final[4].summary.includes("Translator"), "translator summary present");

  // The translated draft (not the original) is what got saved.
  assert.equal(items[0].title, "T-hi");

  // Transform prompt carried the language config + knowledge block.
  const translatePrompt = prompts[4];
  assert.ok(translatePrompt.includes("Hindi"));
  assert.ok(translatePrompt.includes("Never claim NABL"));

  // Fact-check findings landed in the rubric violations.
  assert.ok(items[0].rubric.violations.some((v) => v.rule === "fact_check:overstated"));
  assert.equal(items[0].rubric.fact_check.passed, false, "a model verdict cannot qualify this fixture without captured sources");
  assert.ok(items[0].rubric.violations.some(v=>v.rule==="fact_check:missing_evidence"));

  // Review prompt saw the fact-check findings and the knowledge.
  const reviewPrompt = prompts[6];
  assert.ok(reviewPrompt.includes("Independent fact-check"));
  assert.ok(reviewPrompt.includes("Never claim NABL"));
});

test("worker: failed fact-check flags the item below_threshold even when review passes", async () => {
  const FC_FAIL = { passed: false, issues: [{ claim: "fake 99%", problem: "no source", kind: "fabricated" }], critique: "1. Cut it." };
  const responses = [WORK_ORDER, PACK, BENCH, DRAFT, FC_FAIL, REVIEW_PASS];
  const llm = async () => responses.shift();

  const agent = {
    name: "Checked Writer", emoji: "🧾", base: "geo_article", format: "article",
    pipeline: ["coordinate", "research", "benchmark", "draft", "fact_check", "review"],
    block_config: {}, format_config: {}, design_rules: [], rubric_emphasis: {},
  };

  const items = [];
  const deps = {
    llm,
    scrape: async () => "No website content available.",
    job: { id: "j1", brand: "B", playbook: "geo_article", status: "pending", input: {}, agent_snapshot: agent },
    updateContentJob: async (id, u) => ({ id, ...u }),
    insertContentItem: async (i) => (items.push({ id: "i1", ...i }), { id: "i1", ...i }),
    listLessons: async () => [],
    getScansForBrand: async () => [],
    getBrandBrief: async () => null,
    upsertBrandBrief: async () => ({}),
    listKnowledgeBlocks: async () => [],
  };

  const item = await startContentJob("j1", deps);
  assert.ok(item);
  assert.equal(items[0].rubric.below_threshold, true, "fact-check fail flags the item");
  assert.equal(items[0].rubric.fact_check.passed, false);
  assert.ok(items[0].rubric.violations.some((v) => v.rule === "fact_check:fabricated"));
});
