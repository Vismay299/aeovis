import test from "node:test";
import assert from "node:assert/strict";
import { runFinalizePhase } from "./scanWorker.js";

/**
 * R2.3.1 — two-pass finalize: the discovered roster must feed the headline.
 *
 * Finalize used to summarize FIRST and discover competitors SECOND. Probe-time
 * judging only knows the competitors the user typed, so on a scan where nobody
 * typed any, every row's `brands` held [self] alone when the headline was
 * computed. Three things then failed together, and all of them failed quietly:
 *
 *   - the eliciting gate disables itself unless a non-self brand appears
 *     somewhere in the slice, so it fell back to scoring over every answered
 *     prompt — including the taxonomy answers naming no vendor that are the
 *     exact cap it exists to lift;
 *   - Share of Voice was self / self = 100%;
 *   - top rivals had no rivals.
 *
 * The accept is that all three ENGAGE on a scan where the user typed no
 * competitors, so that is what these assert — against a fixture where some
 * answers name vendors and some deliberately do not.
 */

const RIVALS = ["Rival One", "Rival Two"];

/** Answers that name vendors, and answers that name nobody. */
const ANSWERS = {
  // Eliciting: these name at least one roster vendor.
  namesAcmeAndRival: "Acme is a strong option, though Rival One is also popular.",
  namesRivalsOnly: "Rival One and Rival Two dominate this category.",
  namesAcmeOnly: "Acme is the one most teams start with.",
  // Dead: taxonomy/how-to answers naming no vendor at all. These are what the
  // eliciting gate must exclude from the denominator.
  deadHowTo: "Measure the room in square feet, then divide by the tile size.",
  deadTaxonomy: "Prices vary by material, finish and thickness.",
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
    // Returns an ARRAY — finalize reads savedScan?.[0]?.id (scanWorker.js:891).
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

function row(engine, promptText, text, visible) {
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
    // Probe-time roster: SELF ONLY. This is the state the bug came from — the
    // user typed no competitors, so enginePipeline had nobody else to judge.
    brands: [{ name: "Acme", is_self: true, mentioned: visible }],
    error: null,
    cost: 0.001,
  };
}

/** Five answers: three name vendors, two name nobody. */
const FIXTURE = [
  ["q1", ANSWERS.namesAcmeAndRival, true],
  ["q2", ANSWERS.namesRivalsOnly, false],
  ["q3", ANSWERS.namesAcmeOnly, true],
  ["q4", ANSWERS.deadHowTo, false],
  ["q5", ANSWERS.deadTaxonomy, false],
];

async function finalizeWithNoTypedCompetitors({ discovered }) {
  const backend = makeFakeBackend();
  const jobId = "job-r231";

  let seq = 0;
  for (const engine of ["aio", "chatgpt"]) {
    FIXTURE.forEach(([q, text, visible]) => {
      backend.promptResults.push({
        id: `r${seq++}`,
        job_id: jobId,
        brand: "acme.com",
        query: q,
        engine,
        is_branded_query: false,
        raw: row(engine, q, text, visible),
      });
    });
  }

  const checkpoint = {
    brand: "Acme",
    url: "acme.com",
    industry: "saas",
    // THE CONDITION UNDER TEST: the user typed nothing.
    competitors: [],
    competitors_raw: "",
    prompt_key: "acme.com",
    unbranded_texts: FIXTURE.map(([q]) => q),
    engines: ["aio", "chatgpt"],
    stats: { cost: 0, tokens: 0 },
  };

  const job = await runFinalizePhase(jobId, checkpoint, {
    ...backend.deps,
    resolveEnabledEngines: () => [{ name: "aio" }, { name: "chatgpt" }],
    extractCompetitors: async () => discovered.map((name) => ({ name, source: "discovered" })),
  });

  return { job, backend };
}

test("R2.3.1 — the eliciting gate engages when no competitors were typed", async () => {
  const { job } = await finalizeWithNoTypedCompetitors({ discovered: RIVALS });
  const aio = job.run_record.engines.aio;

  // The gate needs a non-self brand in the slice before it will engage. With
  // the roster discovered BEFORE summarizing, it does.
  assert.equal(aio.non_branded_with_answer, 5, "all five answers came back");
  assert.equal(
    aio.eliciting_queries,
    3,
    "only the three answers naming a vendor belong in the denominator"
  );
  assert.equal(aio.dead_prompts, 2, "the how-to and taxonomy answers are excluded");

  // Before the reorder the gate disabled itself and scored 2/5 = 40%.
  assert.equal(aio.share_of_ai_pct, 66.7, "2 visible of 3 eliciting, not 2 of 5");
});

test("R2.3.1 — Share of Voice engages and is not a self-only 100%", async () => {
  const { job } = await finalizeWithNoTypedCompetitors({ discovered: RIVALS });
  const aio = job.run_record.engines.aio;

  assert.notEqual(aio.share_of_voice_pct, 100, "self/self = 100% was the bug");
  assert.ok(
    aio.share_of_voice_pct > 0 && aio.share_of_voice_pct < 100,
    `SOV must reflect a real split, got ${aio.share_of_voice_pct}`
  );
  assert.ok(aio.total_brand_mentions > aio.self_mentions, "rivals were counted too");
});

test("R2.3.1 — top rivals engage", async () => {
  const { job } = await finalizeWithNoTypedCompetitors({ discovered: RIVALS });
  const aio = job.run_record.engines.aio;

  assert.ok(Array.isArray(aio.top_rivals) && aio.top_rivals.length > 0, "top_rivals must be populated");
  const names = aio.top_rivals.map((r) => r.name || r);
  assert.ok(names.some((n) => RIVALS.includes(n)), `expected a discovered rival, got ${JSON.stringify(names)}`);
});

test("R2.3.1 — rows are re-judged, so result_brands carries the rivals too", async () => {
  const { backend } = await finalizeWithNoTypedCompetitors({ discovered: RIVALS });

  const rivalRows = backend.resultBrands.filter((r) => !(r.is_self ?? r.isSelf));
  assert.ok(rivalRows.length > 0, "result_brands must hold rival rows, not self only");
});

test("R2.3.1 — an empty discovered roster still degrades honestly, not to a fake 100%", async () => {
  // The extractor RAN and genuinely found nobody. SOV of 100% is then a real
  // measurement, but the eliciting gate must stay disabled rather than score
  // against a self-only roster — absence of a rival roster is absence of
  // evidence, not evidence that nothing was elicited.
  const { job } = await finalizeWithNoTypedCompetitors({ discovered: [] });
  const aio = job.run_record.engines.aio;

  assert.equal(aio.eliciting_queries, 5, "with no rivals the gate must not engage");
  assert.equal(aio.dead_prompts, 0);
});
