import {
  NO_CONTENT_SENTINEL,
  SCRAPE_STATE,
  normalizeScrapeResult,
  scrapeSite,
  summarizeScrape,
} from "../firecrawl.js";
import { isPolicyRefusal } from "../ssrfGuard.js";
import { fetchPeopleAlsoAsk, fetchAutocomplete } from "../engines/serp.js";
import { getBrandAliases } from "./aliases.js";
import { isBrandedQuery } from "./aioQueryClassify.js";
import { isEliciting, assessPromptSet, MIN_ELICITING_RATIO } from "./promptQuality.js";
import { llmJson } from "../llm.js";
import { getLlmBaseUrl, getLlmModel } from "../llmConfig.js";
import { INDUSTRY_PROMPTS } from "../../data/industries.js";

const INTENT_TIERS = ["informational", "commercial", "comparison", "problem_aware"];

/**
 * Deadline for one seed term's PAA + autocomplete pair. Exported so a test can
 * assert on the timer rather than wait for it: the whole point of R3.7.6 is that
 * this deadline is CLEARED when the fetch settles first, so nothing should ever
 * observe it elapsing.
 */
export const SEED_FETCH_TIMEOUT_MS = 10000;

/**
 * Small local industry-key resolver. Kept local so this module's only LLM
 * dependency stays `llmJson` (the free utility model on LLM_BASE_URL) —
 * nothing here may reach a paid provider.
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

/**
 * The one place a scraped website snippet is allowed to become prompt text.
 *
 * R3.7.2, finding B7: a degraded scrape used to arrive here as the sentence
 * "No website content available." and was interpolated under the heading
 * "Website summary:", so the model read it as the site's own copy. Anything
 * that is not real content collapses to "" here — including the legacy
 * sentinel, which a caller that still injects the old string-returning scraper
 * can otherwise smuggle in. This is the belt to scrapeSite's braces: the
 * sentinel is not produced any more AND it is not accepted here.
 */
export function sanitizeWebsiteSnippet(content) {
  if (typeof content !== "string") return "";
  const trimmed = content.trim();
  if (!trimmed) return "";
  if (trimmed === NO_CONTENT_SENTINEL) return "";
  return trimmed;
}

function buildGenPrompt({ brand, website, industryHint, websiteSnippet, need, avoid = [], seedQueries = [] }) {
  let seedSection = "";
  if (seedQueries.length > 0) {
    const capped = seedQueries.slice(0, 30);
    seedSection = `\nReal queries observed on Google for this category (use as grounding, vary and expand):\n${capped.join("\n")}\n`;
  }

  return `You are building a measurement instrument. Each query you write will be sent to
an AI assistant (Google AI Overviews, ChatGPT, Perplexity), and we will check WHICH
VENDOR BRANDS the assistant names in its answer. A query is only useful to us if a
real assistant would answer it by naming specific companies, brands, or products.

THE ONE RULE THAT MATTERS
Before writing each query ask: "would an AI assistant answer this by naming actual
brands?" If the honest answer is no — it would return a definition, a calculation, a
how-to, or a comparison of MATERIALS rather than VENDORS — do not write it.

Queries that FAIL this test (never write these):
  "how to calculate tiles needed for room"     -> arithmetic, names nobody
  "how much do vitrified tiles cost per sqft"  -> a price range, names nobody
  "can i install tiles over old tiles"         -> a how-to, names nobody
  "what is double charge tile"                 -> a definition, names nobody
  "matte finish tiles pros and cons"           -> compares materials, not brands

Queries that PASS (write these):
  "best tile brands in india"                  -> brand list
  "top vitrified tile manufacturers"           -> brand list
  "kajaria vs somany which is better"          -> names both, plus alternatives
  "most trusted tile companies in bangalore"   -> vendor list
  "alternatives to orientbell tiles"           -> competing brands
  "trusted tile shop near me bangalore"        -> local vendors

Website: ${website}
${industryHint ? `Industry: ${industryHint}` : ""}
${
    // R3.7.2: no summary means the heading is omitted entirely. An empty — or,
    // as it used to be, apologetic — "Website summary:" block is itself a claim
    // that we read the site, and the model answers it as if we had.
    sanitizeWebsiteSnippet(websiteSnippet)
      ? `Website summary:\n${sanitizeWebsiteSnippet(websiteSnippet).slice(0, 2500)}`
      : ""
  }
${seedSection}
Step 1 (do this silently, do not output it): from the summary above, identify 6-10
DISTINCT buyer DECISIONS in this category — a use case, a budget level, a customer
segment, a quality tier, a region, a named rival, a specific application. These are
the axes a buyer picks a VENDOR along, not the things they want explained to them.
Every decision must be genuinely different from the others.

Step 2: write ${need} UNBRANDED vendor-selection queries, spread across those decisions
(roughly 2-4 per decision, not all about the same one thing). Never repeat the
same sentence template with one word swapped — vary sentence structure, length, and
phrasing the way different real people would type it.

Style rules (this is what makes it realistic, follow closely):
- 3-9 words, lowercase like a real search bar, no punctuation at the end.
- Never use stiff commercial verbs a real person doesn't type: no "purchase X license",
  "subscribe to X service", "buy X software". Real people type things like
  "best X for small business", "X vs Y", "is X worth it", "cheapest X in india".
- AT LEAST 80% must contain an explicit vendor-seeking cue: best / top / leading /
  which / who / vs / compare / alternatives / brands / companies / manufacturers /
  suppliers / shops / near me / most trusted / reviews / worth it.
- The remainder may be softer buying questions, but each must still plausibly return
  a list of named brands. If it would return a definition or a calculation, drop it.
- Never include the brand name "${brand}" or its domain in any query.
- No duplicate or near-duplicate queries.
${avoid.length ? `- Avoid repeating any of these already-collected queries: ${avoid.slice(0, 30).join(" | ")}` : ""}

Bad examples — these name nobody, so they measure nothing (do NOT write these):
"how to make a website in one day", "what is a landing page",
"website builder monthly fee calculator", "how many pages should a site have"

Good examples (natural, varied, specific, and they all return brand lists):
"best website builder for small business india", "wix vs squarespace which is better",
"top ecommerce platforms for indian sellers", "alternatives to shopify for small stores",
"most trusted web design agencies bangalore", "which website builder is best for beginners"

Return ONLY a JSON array of objects, no commentary, in this exact shape. Give each item
a short "topic" naming the buyer decision it came from (topics should vary across items,
not all be the same string):
[{"text": "...", "topic": "...", "intent_tier": "commercial|comparison|informational|problem_aware"}]`;
}

/**
 * Which scraper this run uses, and how a legacy one is made safe.
 *
 * `deps.scrapeSite` is the current contract ({ content, state, ... }).
 * `deps.scrapeForSummary` is the pre-R3.7.2 string contract and several test
 * suites still inject it. It is ADAPTED rather than trusted: a string is turned
 * into a proper envelope, and the legacy sentinel is recognised as "there was
 * nothing" instead of being carried forward as content. That is what keeps the
 * sentence out of a prompt even when the caller is old.
 */
function resolveScraper(deps = {}) {
  if (deps.scrapeSite) return deps.scrapeSite;
  const legacy = deps.scrapeForSummary;
  if (!legacy) return scrapeSite;
  return async (url) => normalizeScrapeResult(await legacy(url));
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
  const scrapeFn = resolveScraper(deps);
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
  let scrapeState = null;
  try {
    const scrape = await scrapeFn(website);
    scrapeState = summarizeScrape(scrape);
    // The ONLY assignment of prompt-bound site text in this function, and it
    // goes through the sanitizer: a null, a blank, or the legacy sentinel all
    // become "" rather than becoming words in an LLM prompt (R3.7.2 / B7).
    websiteSnippet = sanitizeWebsiteSnippet(scrape?.content);
  } catch (err) {
    // R3.7.4 / rule 1: an SSRF POLICY refusal is not "the page had no content".
    // This catch used to swallow it, so a scan whose website URL we refused to
    // fetch went on to produce 30 prompts that merely LOOK thin — a silent skip
    // dressed as a success, with one log line as the only trace. Rethrow: the
    // scan fails loudly and the refusal reaches whoever submitted the URL.
    //
    // Everything else stays best-effort on purpose. scrapeSite already reports
    // state=unavailable for an unusable target (a typo, an NXDOMAIN) and for an
    // unreachable site, so what reaches this catch is a genuine defect, and a
    // brand's site being momentarily down is not a reason to refuse to generate
    // prompts for it.
    if (isPolicyRefusal(err)) throw err;
    console.warn(`[promptGen] website scrape failed for "${website}":`, err?.message || err);
    scrapeState = {
      state: SCRAPE_STATE.UNAVAILABLE,
      state_reason: "scrape_threw",
      reasons: ["scrape_threw"],
      detail: String(err?.message || err).slice(0, 200),
      source: null,
      content_chars: 0,
    };
  }

  // Record the state where it can travel with the scan. `stats` is the mutable
  // accumulator the worker already threads through this call for cost/tokens,
  // and it is the only channel that crosses back into the sourcing phase
  // without changing a signature the chunk worker owns.
  //
  // THIS FIELD HAS A PRODUCTION READER, and the warning below is not the only
  // trace. runSourcingPhase in src/lib/workers/scanWorker.js reads
  // `stats.website_scrape` immediately after sourceUnbrandedQueries returns and,
  // when the state is not `ok`, calls recordSkip with
  // CHUNK_SKIP_REASONS.WEBSITE_SCRAPE_DEGRADED — so the degrade lands in the
  // chunk's scan_runs row under `detail.skips`, durably, and rides the
  // checkpoint's `stats` so it survives a resume. Renaming or dropping this
  // field silently un-records the degrade; scanChunkLedger.test.mjs holds it.
  if (stats && typeof stats === "object") {
    stats.website_scrape = scrapeState;
  }

  if (scrapeState && scrapeState.state !== SCRAPE_STATE.OK) {
    // A degraded scrape is not a successful one. Said out loud, with the reason
    // and the size of what we actually got, so "the site was read" and "the
    // site was not read" never look the same in a log again.
    console.warn(
      `[promptGen] website scrape for "${website}" is ${scrapeState.state} ` +
        `(${scrapeState.state_reason}${scrapeState.detail ? `: ${scrapeState.detail}` : ""}) — ` +
        `${scrapeState.content_chars ?? "an unrecorded number of"} chars of site content ` +
        `available to prompt generation. ` +
        `These prompts are grounded in the brand name and industry alone.`
    );
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
      // R3.7.6 (finding A1): the deadline is held in a variable and cleared in a
      // `finally`, not left to expire. The executor below runs synchronously
      // inside `new Promise`, so `seedTimeoutId` is always assigned before the
      // first await — there is no path that reaches the finally with the timer
      // scheduled but unrecorded.
      //
      // Uncleared, this stranded ONE live 10s Timeout per seed term (up to five)
      // on every call: ten seconds of event loop kept alive after prompt
      // generation had already returned, which is a held-open serverless
      // invocation billed for nothing and, on the long-lived fleet, a timer per
      // term per scan. Same shape and same fix as R6.5.6 in src/lib/gemini.js:92.
      let seedTimeoutId = null;
      try {
        const result = await Promise.race([
          Promise.all([paaFn(term), autoFn(term)]),
          new Promise((_, reject) => {
            seedTimeoutId = setTimeout(
              () => reject(new Error(`seed term timeout after ${SEED_FETCH_TIMEOUT_MS}ms`)),
              SEED_FETCH_TIMEOUT_MS
            );
          }),
        ]);
        const [paa, autos] = result;
        const merged = [...(paa || []), ...(autos || [])];
        for (const q of merged) {
          if (typeof q === "string" && q.trim() && !paaResults.includes(q.trim())) {
            paaResults.push(q.trim());
          }
        }
      } catch (err) {
        // R3.7.6 / rule 1: still best-effort per term, but no longer silent. A
        // seed term that timed out or threw produced zero queries, and the
        // sibling branches in the realism blend below already say so; this one
        // used to look identical to a term that legitimately had nothing.
        console.warn(
          `[promptGen] seed fetch failed for "${term}" — 0 seed queries from this term:`,
          err?.message || err
        );
      } finally {
        if (seedTimeoutId !== null) clearTimeout(seedTimeoutId);
      }
    }
    seedQueries = paaResults;
  } catch (err) {
    // R3.7.6 / rule 1: prompt generation genuinely does still work without
    // seeds, so this stays best-effort — but an ungrounded prompt set must not
    // be indistinguishable from a seeded one in the log.
    console.warn(
      `[promptGen] seed derivation failed for "${brand}" — generating prompts with no PAA seeding:`,
      err?.message || err
    );
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
        `Check that LLM_API_KEY is set and that LLM_MODEL ("${getLlmModel()}") is available on ` +
        `the configured gateway LLM_BASE_URL ("${getLlmBaseUrl()}") — a model id valid on one ` +
        `OpenAI-compatible gateway is routinely invalid on another.`
    );
  }

  // --- Elicitation gate ----------------------------------------------------
  // We over-generate (count + 10), so the trim down to `count` is free leverage:
  // keep vendor-selection queries before informational ones. A prompt that
  // cannot make an assistant name a brand cannot measure brand visibility, and
  // every one we keep is a guaranteed zero in the denominator (see
  // promptQuality.js for the Italica measurement that motivated this).
  //
  // Stable within each group: the LLM's own ordering is preserved, so this
  // re-ranks by usefulness without reshuffling otherwise-equivalent prompts.
  const ranked = [
    ...collected.filter((q) => isEliciting(q.text)),
    ...collected.filter((q) => !isEliciting(q.text)),
  ];
  const chosen = ranked.slice(0, count);

  const health = assessPromptSet(chosen);
  if (!health.ok) {
    // Not fatal: a thin category genuinely may not support 75% vendor queries,
    // and a scan with a weak set still beats no scan. But it IS logged loudly,
    // and the scan persists elicitation_rate_pct so the dashboard can say the
    // measurement is low-confidence rather than quietly reporting a hard zero.
    console.warn(
      `[promptGen] LOW ELICITATION for "${brand}": only ${health.eliciting}/${health.total} ` +
        `(${Math.round(health.ratio * 100)}%) of the prompt set is a vendor-selection query ` +
        `(want >=${Math.round(MIN_ELICITING_RATIO * 100)}%). ${health.diagnostic} prompts cannot ` +
        `produce a brand mention and will drag the visibility denominator.`
    );
  } else {
    console.log(
      `[promptGen] "${brand}" prompt set: ${health.eliciting}/${health.total} eliciting ` +
        `(${Math.round(health.ratio * 100)}%)`
    );
  }

  return chosen;
}
