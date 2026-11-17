import test from "node:test";
import assert from "node:assert/strict";
import { runFinalizePhase } from "../../server/workers/scanWorker.js";
import { summarizeEngineSlice } from "./enginePipeline.js";

/**
 * R2.3.2 — Tests: an empty-competitors scan gets the gate, SOV, and top rivals.
 *
 * This is the shape of most free scans: the user enters only their domain/brand,
 * with no typed competitors. Probe-time judging only knows the competitors the
 * user typed, so probe rows initially carry only [self] in `brands`.
 *
 * In two-pass finalize (R2.3.1), competitor extraction resolves discovered rivals,
 * rows are re-judged symmetrically against the discovered roster, and only then
 * are engine slices summarized.
 *
 * The acceptance criteria for R2.3.2:
 * A fixture scan with no typed competitors produces:
 *   1. A gated score (the eliciting gate engages, excluding dead prompts from denominator).
 *   2. A non-null Share of Voice (reflecting real brand vs rival mentions, not 100% self-lie).
 *   3. A populated rival list (top_rivals containing discovered rivals with mention counts).
 */

const DISCOVERED_RIVALS = ["RivalAlpha", "RivalBeta"];

const FIXTURE_ANSWERS = {
  namesBrandAndRival: "Acme is a popular platform, though RivalAlpha also offers great features.",
  namesRivalOnly: "RivalAlpha and RivalBeta lead this space.",
  namesBrandOnly: "Acme is the premier choice for enterprise.",
  // Dead prompts: how-to/taxonomy answers naming no vendor at all.
  deadHowTo: "To install, follow the step-by-step documentation in the user manual.",
  deadTaxonomy: "Pricing models typically range from flat monthly fees to usage-based tiers.",
};

function makeFakeBackend() {
  const jobs = new Map();
  const promptResults = [];
  const resultBrands = [];
  const scans = [];

  const deps = {
    updateScanJob: async (id, patch) => {
      const j = jobs.get(id) || { id, status: "scoring" };
      Object.assign(j, patch);
      jobs.set(id, j);
      return j;
    },
    claimJobStatus: async () => true,
    getPromptResultsForJob: async () => promptResults,
    insertScan: async (rec) => {
      const id = `scan-${scans.length + 1}`;
      scans.push({ id, ...rec });
      return [{ id }];
    },
    stampScanIdForJob: async () => {},
    deleteCitationsForJob: async () => {},
    insertCitations: async () => {},
    deleteResultBrandsForJob: async () => {
      resultBrands.length = 0;
    },
    insertResultBrands: async (rows) => {
      resultBrands.push(...rows);
      return rows;
    },
    upsertBrandMetricsDaily: async () => {},
    getScansByDomain: async () => [],
    getResultBrandsForScan: async () => [],
    listDueSchedules: async () => [],
    upsertScanSchedule: async () => {},
    selfContinue: () => {},
  };

  return { jobs, promptResults, resultBrands, scans, deps };
}

function createProbeRow(engine, promptText, text, visible) {
  return {
    engine,
    prompt: promptText,
    is_branded_query: false,
    topic: "General",
    source: "llm_generated",
    intent_tier: "informational",
    answer_present: true,
    aio_present: true,
    text,
    citations: [],
    references: [],
    brand_mentioned_in_text: visible,
    brand_cited: false,
    visible,
    competitors_found_in_text: [],
    competitors_cited: [],
    // Initial probe-time state: USER TYPED NO COMPETITORS, so [self] ONLY.
    brands: [{ name: "Acme", is_self: true, mentioned: visible }],
    error: null,
    cost: 0.001,
  };
}

const FIVE_ANSWER_FIXTURE = [
  ["q1", FIXTURE_ANSWERS.namesBrandAndRival, true],
  ["q2", FIXTURE_ANSWERS.namesRivalOnly, false],
  ["q3", FIXTURE_ANSWERS.namesBrandOnly, true],
  ["q4", FIXTURE_ANSWERS.deadHowTo, false],
  ["q5", FIXTURE_ANSWERS.deadTaxonomy, false],
];

async function runFixtureScanWithNoTypedCompetitors({
  discovered = DISCOVERED_RIVALS,
  extractorOffline = false,
  engines = ["aio", "chatgpt"],
} = {}) {
  const backend = makeFakeBackend();
  const jobId = "job-empty-competitors-fixture";

  let seq = 0;
  for (const engine of engines) {
    FIVE_ANSWER_FIXTURE.forEach(([q, text, visible]) => {
      backend.promptResults.push({
        id: `row-${seq++}`,
        job_id: jobId,
        brand: "acme.com",
        query: q,
        engine,
        is_branded_query: false,
        raw: createProbeRow(engine, q, text, visible),
      });
    });
  }

  const checkpoint = {
    brand: "Acme",
    url: "acme.com",
    industry: "saas",
    // THE CONDITION UNDER TEST: The user typed no competitors.
    competitors: [],
    competitors_raw: "",
    prompt_key: "acme.com",
    unbranded_texts: FIVE_ANSWER_FIXTURE.map(([q]) => q),
    engines,
    stats: { cost: 0, tokens: 0 },
  };

  const job = await runFinalizePhase(jobId, checkpoint, {
    ...backend.deps,
    resolveEnabledEngines: () => engines.map((name) => ({ name })),
    extractCompetitors: async () => {
      if (extractorOffline) {
        const err = new Error("LLM provider unreachable");
        err.reason = "network_timeout";
        throw err;
      }
      return discovered.map((name) => ({ name, domain: "", source: "discovered" }));
    },
  });

  return { job, backend };
}

test("R2.3.2 ACCEPT — empty-competitors scan produces gated score, non-null SOV, and populated rivals", async () => {
  const { job } = await runFixtureScanWithNoTypedCompetitors({
    discovered: DISCOVERED_RIVALS,
  });

  const aio = job.run_record.engines.aio;
  assert.ok(aio, "aio engine summary must exist");

  // 1. GATED SCORE
  // Out of 5 non-branded answered queries, 2 are dead prompts naming no vendor.
  // The eliciting gate MUST engage and filter them out.
  assert.equal(aio.non_branded_with_answer, 5, "total answered queries is 5");
  assert.equal(aio.eliciting_queries, 3, "eliciting pool excludes dead how-to/taxonomy prompts");
  assert.equal(aio.dead_prompts, 2, "exactly 2 dead prompts detected");
  // Visibility is computed over eliciting pool (2 visible / 3 eliciting = 66.7%), NOT 2/5 (40%).
  assert.equal(aio.share_of_ai_pct, 66.7, "score must be gated (66.7%), not ungated (40%)");

  // 2. NON-NULL SOV
  // Share of voice must be a real percentage reflecting rival mentions, NOT null and NOT 100%.
  assert.ok(aio.share_of_voice_pct != null, "SOV must be non-null");
  assert.notEqual(aio.share_of_voice_pct, 100, "SOV must not be a self-only 100% lie");
  assert.ok(
    aio.share_of_voice_pct > 0 && aio.share_of_voice_pct < 100,
    `SOV must reflect a real distribution (got ${aio.share_of_voice_pct})`
  );
  assert.ok(
    aio.total_brand_mentions > aio.self_mentions,
    `total mentions (${aio.total_brand_mentions}) must exceed self mentions (${aio.self_mentions})`
  );

  // 3. POPULATED RIVAL LIST
  assert.ok(Array.isArray(aio.top_rivals) && aio.top_rivals.length > 0, "top_rivals must be populated");
  const rivalNames = aio.top_rivals.map((r) => r.name || r);
  assert.ok(
    rivalNames.some((name) => DISCOVERED_RIVALS.includes(name)),
    `top_rivals must include discovered rivals, got: ${JSON.stringify(rivalNames)}`
  );
  assert.ok(
    aio.top_rivals.every((r) => r.mentions > 0 && r.share_pct > 0),
    "each top rival must carry positive mentions and share_pct"
  );
});

test("R2.3.2 DEGRADATION TRUTH — empty discovered roster honestly disables gate and reports null SOV", async () => {
  // When extractor runs and genuinely finds NO rivals:
  // - Gate must stay disabled (cannot filter without rivals; absence of evidence).
  // - SOV is null (not 100%) because no rival roster exists to measure against.
  const { job } = await runFixtureScanWithNoTypedCompetitors({ discovered: [] });
  const aio = job.run_record.engines.aio;

  assert.equal(aio.eliciting_queries, 5, "without rivals the gate must not engage");
  assert.equal(aio.dead_prompts, 0);
  assert.equal(aio.share_of_voice_pct, null, "SOV must be null without rivals, never a fake 100%");
  assert.deepEqual(aio.top_rivals, [], "top_rivals must be empty when no rivals discovered");
});

test("R2.3.2 PROOF-BY-SABOTAGE — bypassing re-judge fails all three acceptance criteria", () => {
  // SABOTAGE DEMONSTRATION:
  // If rows are summarized with only their probe-time [self] roster (as happened pre-R2.3.1):
  const probeTimeRows = FIVE_ANSWER_FIXTURE.map(([q, text, visible]) => ({
    query: q,
    error: null,
    answer_present: true,
    is_branded_query: false,
    visible,
    brand_mentioned_in_text: visible,
    brand_cited: false,
    // Sabotaged state: un-rejudged probe-time rows have ONLY Acme.
    brands: [{ name: "Acme", is_self: true, mentioned: visible }],
  }));

  const sabotagedSlice = summarizeEngineSlice(probeTimeRows, "aio");

  // Criterion 1 SABOTAGE: Gate FAILS to engage
  assert.equal(sabotagedSlice.eliciting_queries, 5, "sabotage: gate did not engage (5 instead of 3)");
  assert.equal(sabotagedSlice.dead_prompts, 0, "sabotage: dead prompts were not excluded");
  assert.equal(sabotagedSlice.share_of_ai_pct, 40, "sabotage: score is ungated (40% instead of 66.7%)");

  // Criterion 2 SABOTAGE: SOV is null (cannot compute without rivals)
  assert.equal(sabotagedSlice.share_of_voice_pct, null, "sabotage: SOV is null without discovered roster");

  // Criterion 3 SABOTAGE: Rivals list is empty
  assert.deepEqual(sabotagedSlice.top_rivals, [], "sabotage: rivals list is empty without discovered roster");
});
