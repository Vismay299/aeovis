import test from "node:test";
import assert from "node:assert/strict";
import { runFinalizePhase } from "../workers/scanWorker.js";
import { makeMemoryScanBackend } from "../demo/memoryScanBackend.js";
import { resolveEntityEvidence } from "./entityEvidence.js";

// Mirrors the retained production QA scan: Google returned valid SERPs without an
// AI Overview, ChatGPT answered without naming the brand, and the other engines
// were never attempted. Empty slices resolve no entities, so they are not an
// "older entity policy" and must not hide the headline's real refusal reason.
async function finalize(rowsFor, engines, questions = 3) {
  const backend = makeMemoryScanBackend(), jobId = `entity-policy-${engines.join("-")}-${questions}`;
  const queries = Array.from({ length: questions }, (_, i) => `Buyer question ${i}`);
  const rows = [];
  for (const engine of engines) queries.forEach((query, i) => {
    const raw = rowsFor(engine, i);
    if (raw) rows.push({ id: `${engine}-${i}`, job_id: jobId, engine, query, answered: raw.answer_present === true,
      raw: { engine, prompt: query, references: [], brands: [], cost: null, brand_cited: false, error: null, ...raw } });
  });
  await backend.deps.upsertPromptResults(rows);
  const job = await runFinalizePhase(jobId, { brand: "Acme", url: "https://acme.example", prompt_key: "acme.example", competitors: [], engines,
    queries: queries.map((text) => ({ text })), unbranded_texts: queries.map((q) => q.toLowerCase()), geo: "in", stats: {}, model_policy_version: "fixture-only" },
  { ...backend.deps, resolveEnabledEngines: () => engines.map((name) => ({ name })), extractCompetitors: async () => [] });
  return job.run_record.summary_stats.headline_metric;
}

// The worker stores each row's entity evidence before finalization.
const evidence = (text) => resolveEntityEvidence({ brand: "Acme", website: "https://acme.example", text });
const noAio = () => ({ answer_present: false, aio_present: false, serp_state: "valid_serp", text: "", visible: false, brand_mentioned_in_text: false, entity_evidence: evidence("") });
const unnamed = () => { const text = "Globex and Initech are common choices."; return { answer_present: true, text, visible: false, brand_mentioned_in_text: false, entity_evidence: evidence(text) }; };

test("R05 empty engine slices do not turn a thin headline into an entity-policy mix", async (t) => {
  t.mock.method(console, "log", () => {});t.mock.method(console, "warn", () => {});
  const engines = ["aio", "chatgpt", "gemini", "perplexity"];
  const headline = await finalize((engine) => engine === "aio" ? noAio() : engine === "chatgpt" ? unnamed() : null, engines, 1);
  assert.equal(headline.qualified_pct, null);
  assert.notEqual(headline.qualified_reason, "entity_resolution_policy_mixed");
  assert.equal(headline.qualified_reason, "insufficient_distinct_eligible_prompts");
});
