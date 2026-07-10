import { fetchPeopleAlsoAsk, fetchAutocomplete } from "../engines/serp.js";
import { scrapeForSummary } from "../firecrawl.js";
import { generateContent } from "../gemini.js";
import { INDUSTRY_PROMPTS } from "../../data/industries.js";
import { getBrandAliases } from "./aliases.js";
import {
  isBrandedQuery,
  isBrandPresenceQuery,
  resolveQueryIntentTier,
  dedupeQueriesByText,
  buildBrandedQueries,
} from "./aioQueryClassify.js";

export {
  isBrandedQuery,
  isBrandPresenceQuery,
  resolveQueryIntentTier,
  dedupeQueriesByText,
  buildBrandedQueries,
};

const MAX_NON_BRANDED = 18;

/** Maps normalized industry strings to INDUSTRY_PROMPTS keys (saas, ecommerce, finance, agency). */
const INDUSTRY_ALIAS_TO_KEY = Object.entries(INDUSTRY_PROMPTS).reduce(
  (map, [key, { label }]) => {
    map[key] = key;
    if (label) {
      const lower = label.toLowerCase();
      map[lower] = key;
      map[lower.replace(/[\s-]+/g, "")] = key;
    }
    return map;
  },
  {
    "e-commerce": "ecommerce",
    "e commerce": "ecommerce",
  }
);

/**
 * Normalizes an industry string to a known INDUSTRY_PROMPTS entry.
 * Accepts keys ("saas", "ecommerce"), labels ("SaaS", "E-commerce"), and common aliases.
 */
export function resolveIndustry(industry) {
  if (!industry) return null;
  const normalized = String(industry).trim().toLowerCase();
  if (!normalized) return null;

  const key =
    INDUSTRY_ALIAS_TO_KEY[normalized] ||
    INDUSTRY_ALIAS_TO_KEY[normalized.replace(/[\s-]+/g, "")] ||
    (INDUSTRY_PROMPTS[normalized] ? normalized : null);

  return key ? INDUSTRY_PROMPTS[key] : null;
}

/**
 * Extracts category seed terms from the brand's website + industry using Gemini.
 * The goal is to produce a small set of NON-BRANDED category terms that real
 * buyers would type into Google. These seeds drive PAA + Autocomplete.
 */
async function deriveCategorySeeds(brand, website, industry, stats) {
  const seeds = new Set();

  // Scrape site + ask Gemini for 4-6 category seed terms (no brand names)
  let websiteSnippet = "";
  try {
    websiteSnippet = (await scrapeForSummary(website)) || "";
  } catch {}

  const industryPrompts = resolveIndustry(industry);
  const industryHint = industryPrompts?.label || industry || "";

  const prompt = `You are an expert in real buyer search behaviour.

Given the website snippet below, output 5-7 SHORT category seed terms (2-4 words each)
that a customer would type into Google to look for products/services in this category.

Rules:
- Do NOT include the brand name "${brand}" or the domain "${website}".
- Do NOT include long conversational questions ("how do I …", "what is …") — just short category keywords.
- Every seed MUST be at least 2 words long. Never output a single generic word like "saas" — it produces noise.
- Focus on the CATEGORY of solution, not the brand. Examples of good style:
   "project management software"
   "customer support ticket tool"
   "invoice automation for freelancers"
${industryHint ? `- Broad industry: "${industryHint}"` : ""}

Website snippet:
${(websiteSnippet || "").slice(0, 2500)}

Return ONLY a JSON array of strings, no commentary.`;

  try {
    const { text } = await generateContent(prompt, { jsonMode: true, stats, timeout: 20000 });
    const cleaned = text.replace(/```json\n?|\n?```/g, "").trim();
    const arr = JSON.parse(cleaned);
    if (Array.isArray(arr)) {
      arr.forEach((s) => {
        if (typeof s === "string") {
          const trimmed = s.trim().toLowerCase();
          // Only accept multi-word seeds of at least 8 chars
          if (trimmed.length >= 8 && trimmed.split(/\s+/).length >= 2) {
            seeds.add(trimmed);
          }
        }
      });
    }
  } catch (err) {
    console.warn("[aioPrompts] Category seed generation failed:", err.message);
  }

  // Fallback: derive multi-word phrases from static industry prompts
  if (seeds.size === 0 && industryPrompts?.prompts) {
    industryPrompts.prompts.forEach((p) => {
      const words = p.toLowerCase().split(/\s+/).slice(0, 4).join(" ");
      if (words.length >= 8) seeds.add(words);
    });
  }

  return Array.from(seeds).slice(0, 6);
}

/**
 * Fetches PAA + Autocomplete queries for a set of category seeds.
 * Returns deduplicated non-branded queries only.
 */
async function fetchCategoryQueries(seeds, brandAliases) {
  const queries = [];
  const seen = new Set();

  const push = (text, source, topic) => {
    const key = text.toLowerCase().trim();
    if (!key || seen.has(key)) return;
    if (isBrandedQuery(key, brandAliases)) return; // exclude branded queries here
    // Drop very short 1-word or 2-word garbage (single generic terms like "saas"
    // pull in unrelated PAA/autocomplete like "saas stocks" or "apocalypse").
    if (key.length < 8) return;
    seen.add(key);
    queries.push({ text, source, topic });
  };

  for (const seed of seeds) {
    // Skip generic single-word seeds — they pull in low-quality noise
    if (seed.split(/\s+/).length < 2) continue;
    try {
      const paa = await fetchPeopleAlsoAsk(seed);
      (paa || []).slice(0, 6).forEach((q) => push(q, "paa", `PAA — ${seed}`));
    } catch (err) {
      console.warn(`[aioPrompts] PAA fetch failed for "${seed}":`, err.message);
    }
    try {
      const autos = await fetchAutocomplete(seed);
      (autos || []).slice(0, 6).forEach((q) => push(q, "autocomplete", `Autocomplete — ${seed}`));
    } catch (err) {
      console.warn(`[aioPrompts] Autocomplete fetch failed for "${seed}":`, err.message);
    }
    if (queries.length >= MAX_NON_BRANDED) break;
  }

  // Include multi-word seed terms themselves as queries (they often surface AIO)
  seeds
    .filter((s) => s.split(/\s+/).length >= 2)
    .forEach((seed) => push(seed, "seed", `Seed — ${seed}`));

  return queries.slice(0, MAX_NON_BRANDED);
}

/**
 * Main entry point: build the full query list for an AIO-only scan.
 */
export async function buildAioQueries(brand, website, industry, stats) {
  const brandAliases = getBrandAliases(brand, website);
  const seeds = await deriveCategorySeeds(brand, website, industry, stats);
  console.log(`[aioPrompts] Category seeds:`, seeds);

  const nonBranded = await fetchCategoryQueries(seeds, brandAliases);

  // Fallback: if PAA + autocomplete produced nothing, use the static
  // industry prompts (they are already non-branded).
  const industryFallback = resolveIndustry(industry);
  if (nonBranded.length === 0 && industryFallback) {
    industryFallback.prompts.forEach((text) => {
      nonBranded.push({ text, source: "industry_fallback", topic: "Industry Fallback" });
    });
  }

  const branded = buildBrandedQueries(brand, website);
  return {
    seeds,
    queries: [...nonBranded, ...branded],
    nonBrandedCount: nonBranded.length,
    brandedCount: branded.length,
  };
}
