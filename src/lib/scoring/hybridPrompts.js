import { generatePromptsForBrand } from "../prompts.js";
import { fetchPeopleAlsoAsk, fetchAutocomplete } from "../engines/serp.js";

const MAX_PROMPTS = 20;
const PAA_LIMIT = 7;
const AUTOCOMPLETE_LIMIT = 7;

export function mergePromptPools(...pools) {
  const seen = new Set();
  const merged = [];

  for (const pool of pools) {
    for (const prompt of pool) {
      const text = (prompt.text || "").toLowerCase().trim();
      if (!text || seen.has(text)) continue;
      seen.add(text);
      merged.push(prompt);
      if (merged.length >= MAX_PROMPTS) return merged;
    }
  }

  return merged;
}

export async function fetchExternalQueryPrompts(brand, url, industry) {
  const seedTerms = [brand, url, industry].filter(Boolean);
  const external = [];

  try {
    const paaQuestions = await fetchPeopleAlsoAsk(seedTerms);
    if (paaQuestions?.length > 0) {
      external.push(
        ...paaQuestions.slice(0, PAA_LIMIT).map((q) => ({
          text: q,
          intent_tier: "exploratory",
          topic: "People Also Ask",
          weight: 1.0,
          source: "paa",
        }))
      );
    }
  } catch (err) {
    console.warn("[hybrid] PAA fetch failed:", err.message);
  }

  try {
    const suggestions = await fetchAutocomplete(brand);
    if (suggestions?.length > 0) {
      external.push(
        ...suggestions.slice(0, AUTOCOMPLETE_LIMIT).map((q) => ({
          text: q,
          intent_tier: "exploratory",
          topic: "Autocomplete",
          weight: 1.0,
          source: "autocomplete",
        }))
      );
    }
  } catch (err) {
    console.warn("[hybrid] Autocomplete fetch failed:", err.message);
  }

  return external;
}

export async function buildHybridPromptPool(brand, url, industry, stats = null) {
  const [externalPrompts, llmPrompts] = await Promise.all([
    fetchExternalQueryPrompts(brand, url, industry),
    generatePromptsForBrand(brand, url, industry, stats).catch((err) => {
      console.warn("[hybrid] LLM prompt generation failed:", err.message);
      return [];
    }),
  ]);

  const normalizedLlm = (llmPrompts || []).map((p) => ({
    ...p,
    source: p.source || "llm_generated",
  }));

  const pool = mergePromptPools(externalPrompts, normalizedLlm);
  console.log(
    `[hybrid] Built prompt pool: ${pool.length} total (${externalPrompts.length} external, ${normalizedLlm.length} LLM)`
  );
  return pool;
}