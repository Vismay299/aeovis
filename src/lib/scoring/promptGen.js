import { scrapeForSummary } from "../firecrawl.js";
import { fetchPeopleAlsoAsk, fetchAutocomplete } from "../engines/serp.js";
import { getBrandAliases } from "./aliases.js";
import { isBrandedQuery } from "./aioQueryClassify.js";
import { llmJson } from "../llm.js";
import { INDUSTRY_PROMPTS } from "../../data/industries.js";

const INTENT_TIERS = ["informational", "commercial", "comparison", "problem_aware"];

/**
 * Small local industry-key resolver. Kept local so this module's only LLM
 * dependency stays `llmJson` (OpenRouter free model) — nothing here may reach
 * a paid provider.
 */
function resolveIndustryPack(industry) {
  if (!industry) return null;
  const normalized = String(industry).trim().toLowerCase();
  if (!normalized) return null;
  if (INDUSTRY_PROMPTS[normalized]) return INDUSTRY_PROMPTS[normalized];
  for (const pack of Object.values(INDUSTRY_PROMPTS)) {
    if (pack.label && pack.label.toLowerCase() === normalized) return pack;
  }
  return null;
}

function wordCount(text) {
  return String(text || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;
}

function buildGenPrompt({ brand, website, industryHint, websiteSnippet, need, avoid = [], seedQueries = [] }) {
  let seedSection = "";
  if (seedQueries.length > 0) {
    const capped = seedQueries.slice(0, 30);
    seedSection = `\nReal queries observed on Google for this category (use as grounding, vary and expand):\n${capped.join("\n")}\n`;
  }

  return `You are a market researcher reconstructing the REAL Google Search Console query
report for a company's product category — the messy, specific, varied things actual
buyers in India type into Google, not marketing copy.

Website: ${website}
${industryHint ? `Industry: ${industryHint}` : ""}
Website summary:
${(websiteSnippet || "").slice(0, 2500)}
${seedSection}
Step 1 (do this silently, do not output it): from the summary above, identify 6-10
DISTINCT angles a real buyer of this category cares about — e.g. a specific feature,
a price point, a use case, a named competitor/alternative, a pain point, a target
audience (student/freelancer/small business/enterprise), a comparison, a "how do I"
task. Every angle must be genuinely different from the others.

Step 2: write ${need} UNBRANDED Google queries, spread across those angles (roughly
2-4 queries per angle, not all queries about the same one thing). Never repeat the
same sentence template with one word swapped — vary sentence structure, length, and
phrasing the way different real people would type it.

Style rules (this is what makes it realistic, follow closely):
- 3-9 words, lowercase like a real search bar, no punctuation at the end.
- Never use stiff commercial verbs a real person doesn't type: no "purchase X license",
  "subscribe to X service", "buy X software". Real people type things like
  "X pricing", "X free trial", "is X worth it", "cheapest X for small business".
- Mix these intent tiers roughly evenly: informational ("how does X work"),
  commercial ("X pricing india", "X free plan"), comparison ("X vs Y", "best X 2025"),
  problem_aware (a real frustration or task, e.g. "site looks unprofessional fix",
  "landing page not converting", "need a website by tomorrow").
- Never include the brand name "${brand}" or its domain in any query.
- No duplicate or near-duplicate queries.
${avoid.length ? `- Avoid repeating any of these already-collected queries: ${avoid.slice(0, 30).join(" | ")}` : ""}

Bad examples (too templated/stiff, do NOT write like this):
"purchase AI website builder license", "subscribe to AI website builder service",
"AI website builder monthly fee", "AI website builder trial offer"

Good examples (natural, varied, specific):
"cheapest website builder for small business india", "wix vs squarespace which is better",
"free website builder no credit card needed", "how to make a website in one day",
"best drag and drop website builder for beginners", "landing page not converting help"

Return ONLY a JSON array of objects, no commentary, in this exact shape. Give each item
a short "topic" naming the specific angle it came from (angles should vary across items,
not all be the same string):
[{"text": "...", "topic": "...", "intent_tier": "informational|commercial|comparison|problem_aware"}]`;
}

/**
 * Guarantees exactly `count` unbranded query objects for a scan, or throws.
 * Passes, in order: LLM gen (1-2 calls) -> PAA/autocomplete realism blend ->
 * static industry-pack top-up. Never imports a provider directly — only
 * `llmJson` (OpenRouter free model, no paid fallback).
 */
export async function generateUnbrandedPrompts(
  brand,
  website,
  industry,
  stats,
  count = 30,
  deps = {}
) {
  const llmJsonFn = deps.llmJson || llmJson;
  const scrapeFn = deps.scrapeForSummary || scrapeForSummary;
  const paaFn = deps.fetchPeopleAlsoAsk || fetchPeopleAlsoAsk;
  const autoFn = deps.fetchAutocomplete || fetchAutocomplete;

  const brandAliases = getBrandAliases(brand, website);
  const collected = [];
  const seen = new Set();

  const add = (item) => {
    if (!item) return;
    const text = typeof item === "string" ? item : item.text;
    if (typeof text !== "string") return;
    const trimmed = text.trim();
    if (!trimmed) return;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) return;
    if (isBrandedQuery(trimmed, brandAliases)) return;
    if (wordCount(trimmed) < 2) return;

    const intentTier =
      typeof item === "object" && INTENT_TIERS.includes(item.intent_tier)
        ? item.intent_tier
        : "informational";

    seen.add(key);
    collected.push({
      text: trimmed,
      topic: (typeof item === "object" && item.topic) || "General",
      intent_tier: intentTier,
      source: (typeof item === "object" && item.source) || "llm_generated",
    });
  };

  let websiteSnippet = "";
  try {
    websiteSnippet = (await scrapeFn(website)) || "";
  } catch {
    // best-effort; prompt gen still works with an empty snippet
  }

  const industryPack = resolveIndustryPack(industry);
  const industryHint = industryPack?.label || industry || "";

  // 5b: PAA-seeding — derive seed terms and fetch real Google queries BEFORE
  // the LLM pass so the prompt is grounded in actual search behaviour.
  let seedQueries = [];
  try {
    const seedTerms = [];
    if (industryHint) {
      seedTerms.push(industryHint);
      // Add variation terms from industry label
      const words = industryHint.toLowerCase().split(/\s+/).filter((w) => w.length > 3);
      seedTerms.push(...words.slice(0, 3));
    }
    // Add top words from the scraped website title (extract first 2 meaningful words)
    if (websiteSnippet) {
      const firstLine = websiteSnippet.split("\n")[0] || "";
      const titleWords = firstLine
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, "")
        .split(/\s+/)
        .filter((w) => w.length > 4 && !["about", "contact", "home", "page"].includes(w))
        .slice(0, 3);
      seedTerms.push(...titleWords);
    }
    const uniqueTerms = [...new Set(seedTerms)].slice(0, 5);

    const paaResults = [];
    for (const term of uniqueTerms) {
      if (paaResults.length >= 30) break;
      try {
        const result = await Promise.race([
          Promise.all([paaFn(term), autoFn(term)]),
          new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 10000)),
        ]);
        const [paa, autos] = result;
        const merged = [...(paa || []), ...(autos || [])];
        for (const q of merged) {
          if (typeof q === "string" && q.trim() && !paaResults.includes(q.trim())) {
            paaResults.push(q.trim());
          }
        }
      } catch {
        // best-effort per term
      }
    }
    seedQueries = paaResults;
  } catch {
    // best-effort; prompt gen still works without seeds
  }

  // Pass 1
  const prompt1 = buildGenPrompt({
    brand,
    website,
    industryHint,
    websiteSnippet,
    need: count + 10,
    seedQueries,
  });
  const result1 = await llmJsonFn(prompt1, { stats, timeout: 25000, temperature: 0.85 });
  if (Array.isArray(result1)) result1.forEach(add);

  // Pass 2 (only if short)
  if (collected.length < count) {
    const prompt2 = buildGenPrompt({
      brand,
      website,
      industryHint,
      websiteSnippet,
      need: count - collected.length + 6,
      avoid: collected.map((c) => c.text),
      seedQueries,
    });
    const result2 = await llmJsonFn(prompt2, { stats, timeout: 25000, temperature: 0.85 });
    if (Array.isArray(result2)) result2.forEach(add);
  }

  // Realism blend (only if still short) — best-effort, may need a SERP key.
  if (collected.length < count) {
    const topTopics = [...new Set(collected.slice(0, 5).map((c) => c.topic))];
    for (const topic of topTopics) {
      if (collected.length >= count) break;
      try {
        const paa = await paaFn(topic);
        (paa || []).forEach((text) => add({ text, topic, source: "paa" }));
      } catch (err) {
        console.warn(`[promptGen] PAA fetch failed for "${topic}":`, err.message);
      }
      if (collected.length >= count) break;
      try {
        const autos = await autoFn(topic);
        (autos || []).forEach((text) => add({ text, topic, source: "autocomplete" }));
      } catch (err) {
        console.warn(`[promptGen] Autocomplete fetch failed for "${topic}":`, err.message);
      }
    }
  }

  // Industry-pack top-up (last resort) — never returns fewer than count.
  if (collected.length < count) {
    const pack = industryPack || Object.values(INDUSTRY_PROMPTS)[0];
    (pack?.prompts || []).forEach((text) =>
      add({ text, topic: pack.label || "Industry", source: "industry_fallback" })
    );
  }

  if (collected.length < count) {
    throw new Error(
      `generateUnbrandedPrompts: only produced ${collected.length}/${count} unbranded prompts. ` +
        `Check that OPENROUTER_API_KEY is set and OPENROUTER_MODEL ("${
          process.env.OPENROUTER_MODEL || "google/gemma-4-31b-it:free"
        }") is available on OpenRouter.`
    );
  }

  return collected.slice(0, count);
}
