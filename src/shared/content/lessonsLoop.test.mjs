import { test } from "node:test";
import assert from "node:assert/strict";

/**
 * R5.4.1 — the lessons loop, closed end to end, offline.
 *
 * contentWorker.test.mjs already proves a lesson handed to `deps.listLessons`
 * shows up in the prompts. What it cannot prove is the LOOP: that a lesson the
 * learn step STORES is the one the next job LOADS, and that the next draft is
 * different because of it. A false success here looks like a Studio that
 * accepts feedback, says "lesson saved", and keeps writing the same post.
 *
 * So nothing on the lesson path is faked:
 *   - runLearn writes through the real db/content.js insertLessons,
 *   - startContentJob reads through the real db/content.js listLessons
 *     (no `deps.listLessons` override), which is the brand+playbook+active
 *     filter the production code applies,
 *   - both land in db/content.js's memory store because db.js has no client.
 * Only the model is scripted. The draft model is prompt-sensitive: it "obeys"
 * the lesson iff the lesson text is in the draft prompt it receives, so the
 * draft can only change if the worker really carried the stored lesson into
 * the Writer's prompt. Assertions run on the draft prompt, the queued item,
 * and the agent_trace the worker persists to content_jobs.
 *
 * Credentials are cleared before the module graph loads (same reason and
 * mechanism as contentWorker.test.mjs, R3.2.4): with db.js's client null,
 * the lease, ledger and lesson writes all stay in memory.
 */
delete process.env.NEXT_PUBLIC_SUPABASE_URL;
delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

const { startContentJob } = await import("./contentWorker.js");
const { runLearn } = await import("./steps/learn.js");
const { insertLessons, listLessons } = await import("../../server/db/content.js");
const { supabase } = await import("../../server/db.js");

assert.equal(
  supabase,
  null,
  "db.js still has a client: lesson inserts in this file would land on production"
);

// --- fixtures (shapes copied from contentWorker.test.mjs) -------------------

const BRAND = "LessonsLoopDiag"; // unique, so the shared memory store has no strays
const PLAYBOOK = "linkedin_post";
const LESSON = "Never close a post with a pitch for the brand; end on a question.";
const OTHER_PLAYBOOK_LESSON = "Open every article with a comparison table.";

const WORK_ORDER = {
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

const BODY_CORE =
  "18% of every home-collection order goes to logistics.\n\n" +
  "Most diagnostics COOs can quote reagent costs to the rupee. Almost none can quote that number. " +
  "Home collection is the fastest-growing order line for every chain that offers it, and the only one " +
  "where costs scale per order, not per batch. Phlebotomist time, travel, cold-chain handling: none of it amortizes. " +
  "Treat home collection as its own P&L with its own pricing floor.";

const PITCH_ENDING = "\n\nBook a LessonsLoopDiag cost audit today and fix your margins.";
const QUESTION_ENDING = "\n\nWhat does your cost-per-visit come to?";

const REVIEW_PASS = {
  scores: { facts_vs_research: 0.9, hook_strength: 0.85, persona_fit: 0.85, format_checklist: 0.9, ymyl_compliance: 1.0 },
  verdict: "pass",
  ymyl_violation: false,
  violations: [],
  critique: "",
};

// --- harness -----------------------------------------------------------------

/**
 * linkedin_post call order: coordinate, research, draft, review. The draft
 * reply is computed from the prompt the Writer actually received.
 */
function makeModel() {
  const prompts = [];
  const script = [
    () => WORK_ORDER,
    () => RESEARCH_PACK,
    (prompt) =>
      prompt.includes(LESSON)
        ? { title: "margin-trap-ends-on-a-question", body_md: BODY_CORE + QUESTION_ENDING, levers_used: ["data_point"] }
        : { title: "margin-trap-ends-on-a-pitch", body_md: BODY_CORE + PITCH_ENDING, levers_used: ["data_point"] },
    () => REVIEW_PASS,
  ];
  const llm = async (prompt, options = {}) => {
    prompts.push(prompt);
    if (options.stats) options.stats.cost = (options.stats.cost || 0) + 0.001;
    const next = script.shift();
    if (!next) throw new Error("scripted model exhausted");
    return next(prompt);
  };
  return { llm, prompts };
}

async function runJob(jobId) {
  const { llm, prompts } = makeModel();
  const jobUpdates = [];
  const items = [];
  const listLessonsCalls = [];
  const deps = {
    llm,
    scrape: async () => "No website content available.",
    job: {
      id: jobId,
      brand: BRAND,
      playbook: PLAYBOOK,
      status: "pending",
      input: { type: "topic", topic: "home collection economics", brand_profile: "healthcare-cxo" },
    },
    updateContentJob: async (id, updates) => {
      jobUpdates.push({ id, ...updates });
      return { id, ...updates };
    },
    insertContentItem: async (item) => {
      const record = { id: `item-${jobId}`, ...item };
      items.push(record);
      return record;
    },
    getScansForBrand: async () => [],
    getBrandBrief: async () => null,
    upsertBrandBrief: async () => ({}),
    listKnowledgeBlocks: async () => [],
    // NOTE: no listLessons override — the worker must use db/content.js's.
  };
  // Spy without replacing: count what the real store returned at load time.
  const before = await listLessons(BRAND, PLAYBOOK, { activeOnly: true });
  listLessonsCalls.push(before.map((l) => l.lesson));

  const item = await startContentJob(jobId, deps);
  assert.ok(item, `job ${jobId} should reach the approval queue`);

  const draftPrompt = prompts[2];
  const traced = [...jobUpdates].reverse().find((u) => Array.isArray(u.agent_trace));
  const draftTrace = traced.agent_trace.find((t) => t.step === "draft");
  return { item: items[0], draftPrompt, draftTrace, storeAtStart: listLessonsCalls[0] };
}

function clearBrandLessons() {
  for (const [id, l] of global.memoryContentLessons) {
    if (l.brand === BRAND) global.memoryContentLessons.delete(id);
  }
}

// --- the loop ------------------------------------------------------------------

test("a lesson stored by the learn step changes the next draft (prompt, item, trace)", async (t) => {
  clearBrandLessons();
  t.after(clearBrandLessons);

  // Noise the real filter must exclude: same brand, different playbook.
  await insertLessons(BRAND, "geo_article", [OTHER_PLAYBOOK_LESSON], null);

  // (1) First draft, no active lessons for this brand+playbook.
  const first = await runJob("loop-job-1");
  assert.deepEqual(first.storeAtStart, [], "precondition: no linkedin_post lessons yet");
  assert.ok(
    first.draftPrompt.includes("(none yet — this brand+playbook has no stored lessons)"),
    "first draft prompt states there are no lessons"
  );
  assert.ok(!first.draftPrompt.includes(LESSON));
  assert.ok(!first.draftPrompt.includes(OTHER_PLAYBOOK_LESSON), "other-playbook lesson must not leak");
  assert.ok(first.item.body_md.endsWith(PITCH_ENDING.trim()));
  assert.equal(first.draftTrace.status, "done");
  assert.match(first.draftTrace.summary, /margin-trap-ends-on-a-pitch/);

  // (2) Human feedback → learn step distills and STORES the lesson.
  const learned = await runLearn(
    {
      brand: BRAND,
      playbook: PLAYBOOK,
      verdict: "changes_requested",
      comment: "the ending is a sales pitch, we never pitch. end on a question.",
      item: first.item,
    },
    { llm: async () => ({ lessons: [{ lesson: LESSON, supersedes: null }] }), sourceFeedbackId: "fb-loop-1" }
  );
  assert.equal(learned.inserted.length, 1, "learn step must persist the lesson");
  const stored = await listLessons(BRAND, PLAYBOOK, { activeOnly: true });
  assert.deepEqual(stored.map((l) => l.lesson), [LESSON], "store returns it as active for brand+playbook");

  // (3) Next job: the stored lesson reaches the Writer and the draft changes.
  const second = await runJob("loop-job-2");
  assert.deepEqual(second.storeAtStart, [LESSON]);
  assert.ok(second.draftPrompt.includes(`- ${LESSON}`), "second draft prompt carries the stored lesson");
  assert.ok(!second.draftPrompt.includes("(none yet"), "no-lessons placeholder is gone");
  assert.ok(!second.draftPrompt.includes(OTHER_PLAYBOOK_LESSON), "other-playbook lesson still must not leak");

  assert.notEqual(second.item.body_md, first.item.body_md, "the draft changed");
  assert.ok(second.item.body_md.endsWith(QUESTION_ENDING.trim()));
  assert.ok(!second.item.body_md.includes("Book a LessonsLoopDiag"));
  assert.notEqual(second.draftTrace.summary, first.draftTrace.summary, "the persisted trace records the change");
  assert.match(second.draftTrace.summary, /margin-trap-ends-on-a-question/);
});

test("a deactivated (superseded) lesson stops altering drafts", async (t) => {
  clearBrandLessons();
  t.after(clearBrandLessons);

  await insertLessons(BRAND, PLAYBOOK, [LESSON], null);
  // Learn step supersedes it with a different lesson.
  await runLearn(
    { brand: BRAND, playbook: PLAYBOOK, verdict: "changes_requested", comment: "a soft CTA is fine actually", item: {} },
    {
      llm: async () => ({
        lessons: [{ lesson: "A soft call to action at the end is acceptable.", supersedes: LESSON }],
      }),
    }
  );

  const run = await runJob("loop-job-3");
  assert.ok(!run.draftPrompt.includes(LESSON), "superseded lesson must not reach the Writer");
  assert.ok(run.draftPrompt.includes("A soft call to action at the end is acceptable."));
  assert.match(run.draftTrace.summary, /margin-trap-ends-on-a-pitch/);
});
