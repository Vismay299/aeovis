import { makeMemoryScanBackend } from "./memoryScanBackend.js";
import { runScanChunk } from "../workers/scanWorker.js";
import { ENGINE_LABELS } from "../../shared/engines/deployedEngines.js";

export const MOCK_ENGINES = ["aio", "chatgpt", "gemini", "perplexity"];
const TOPICS = ["vitrified", "porcelain", "bathroom", "outdoor", "kitchen", "large format", "anti skid", "wall", "floor", "premium"];

// Simulated answers exercise the actual checkpoint worker and scoring code.
// ALL persistence and effect dependencies are injected, even when the server
// has production database credentials. A simulation never enters live history.
export async function runMockScan({ brand = "Italica", url = "https://italicatiles.com/" } = {}) {
  const domain = new URL(url).hostname;
  const tileExample = domain === "italicatiles.com";
  const topics = tileExample ? TOPICS : ["popular", "affordable", "premium", "trusted", "local", "online", "specialist", "established", "new", "recommended"];
  const backend = makeMemoryScanBackend();
  const prompts = topics.flatMap((topic) => tileExample ? [
    `best ${topic} tile brands in India`,
    `top ${topic} tile manufacturers for home renovation`,
    `which ${topic} tile companies offer reliable quality`,
  ] : [
    `best ${topic} providers for this category`,
    `compare ${topic} services for a first-time buyer`,
    `how to choose ${topic} solutions for my needs`,
  ]).map((text) => ({ text, topic: tileExample ? "Tiles" : "Example buyer questions", source: "simulation", intent_tier: "commercial", enabled: true }));
  const job = await backend.deps.createScanJob({ brand, url, industry: tileExample ? "tiles" : "other", competitors: "Example Rival One, Example Rival Two" });
  const engines = MOCK_ENGINES.map((name, engineIndex) => ({
    name, label: ENGINE_LABELS[name], concurrency: 4,
    probe: async (query) => {
      const index = prompts.findIndex((p) => p.text === query.text);
      const visible = (index + engineIndex) % 3 === 0;
      return {
        engine: name, prompt: query.text, topic: query.topic, source: "simulation", intent_tier: query.intent_tier,
        is_branded_query: false, answer_present: true, aio_present: true,
        text: visible ? `Simulated answer: ${brand} and Example Rival One are options for this buyer question.` : "Simulated answer: Example Rival One and Example Rival Two are options for this buyer question.",
        references: visible ? [{ href: url, domain, title: "Simulated citation", source: "simulation" }] : [],
        citations: visible ? [url] : [], brand_mentioned_in_text: visible, brand_cited: visible, visible,
        competitors_found_in_text: ["Example Rival One"], competitors_cited: [], brands: [], error: null,
        cost: 0, cost_source: "simulation", cost_state: "measured", citations_state: "verified",
      };
    },
  }));
  const deps = {
    ...backend.deps, client: null, promptTarget: 30,
    getScanSchedule: async () => null,
    insertScanScheduleIfNotExists: async () => ({ brand: domain, inserted: true }),
    getPromptsForBrand: async () => prompts,
    upsertPrompts: async () => ({}), buildBrandedQueries: () => [],
    generateUnbrandedPrompts: async () => { throw new Error("Simulation cannot call a provider"); },
    resolveEnabledEngines: () => engines,
    getScansByDomain: async () => [], getResultBrandsForScan: async () => [],
    extractCompetitors: async ({ userCompetitors }) => userCompetitors.map((name) => ({ name, source: "simulation" })),
  };
  for (let chunk = 0; chunk < 5 && job.status !== "complete" && job.status !== "failed"; chunk++) await runScanChunk(job.id, deps);
  if (job.status !== "complete") throw new Error(job.error_message || "Simulation did not finish");
  return { simulation: true, status: job.status, prompt_count: prompts.length, answer_count: backend.promptResults.length, scan: { ...job.run_record, simulation: true, prompt_source: "simulation" }, results: backend.promptResults, chunks: backend.scanRuns.length };
}
