/**
 * R1.7.3 — Demoted API adapters to explicit fallback; dead paths removed.
 *
 * The SerpAPI (serpapi.com) probe path and the resolveSerpCredentials / serpFetch
 * functions it depended on were dead: the engine capability gate in
 * src/lib/scoring/enginePipeline.js's ENGINE_REGISTRY requires BRIGHTDATA_API_KEY,
 * so a deployment without it never reaches probeGoogleAiOverview, and a
 * deployment WITH it hits the Bright Data branch first. SERPAPI_KEY was left
 * standing as a stale credential that could only cause confusion.
 *
 * All SERP routes now go through Bright Data exclusively.
 */

import { normalizeUrl } from "../scoring/citations.js";
import { resolveSerpQueryCost } from "../llmPricing.js";
import { resolveSerpGeo } from "./serpGeo.js";
import {
  getBrightDataApiKey,
  brightDataSearch,
  extractBrightDataAiOverview,
  extractBrightDataPaa,
  isBrightDataZoneError,
} from "./brightdata.js";

/**
 * Whether Bright Data is the SERP provider and is configured.
 *
 * R1.7.3 — the old getSerpProvider() fell back to SERPAPI_KEY when
 * BRIGHTDATA_API_KEY was absent, which let a stale key through to serpapi.com
 * from promptGen's PAA path while the engine gate had already rejected the
 * capability. Now it is a single boolean: Bright Data is the SERP provider,
 * and it needs its key.
 */
export function isBrightDataConfigured() {
  return !!getBrightDataApiKey();
}

/**
 * Recursively extracts and formats text from SerpAPI Google SGE/AI Overview blocks.
 * Handles text snippets, lists, and child blocks cleanly.
 *
 * @param {Array|Object} blocks - Block payload from SerpAPI JSON
 * @returns {string} Formatted text content
 */
export function extractTextFromBlocks(blocks) {
  if (!blocks) return "";
  if (!Array.isArray(blocks)) {
    if (typeof blocks === "object" && blocks !== null) {
      let parts = [];
      if (blocks.snippet) {
        parts.push(blocks.snippet);
      }
      if (blocks.header) {
        parts.push(blocks.header);
      }
      if (blocks.content) {
        parts.push(extractTextFromBlocks(blocks.content));
      }
      const tableData = blocks.table || (blocks.headers && blocks.rows ? blocks : null);
      if (tableData && Array.isArray(tableData.headers) && Array.isArray(tableData.rows)) {
        const hStr = tableData.headers.join(" | ");
        const rStr = tableData.rows.map(r => Array.isArray(r) ? r.join(" | ") : String(r)).join("\n");
        parts.push(`${hStr}\n${rStr}`);
      }
      if (Array.isArray(blocks.list)) {
        parts.push(extractTextFromBlocks(blocks.list));
      }
      if (Array.isArray(blocks.text_blocks)) {
        parts.push(extractTextFromBlocks(blocks.text_blocks));
      }
      return parts.join("\n");
    }
    return String(blocks);
  }

  return blocks
    .map(block => {
      if (typeof block === "string") return block;
      if (typeof block === "object" && block !== null) {
        let parts = [];
        if (block.snippet) {
          parts.push(block.snippet);
        }
        if (block.header) {
          parts.push(block.header);
        }
        if (block.content) {
          parts.push(extractTextFromBlocks(block.content));
        }
        const tableData = block.table || (block.headers && block.rows ? block : null);
        if (tableData && Array.isArray(tableData.headers) && Array.isArray(tableData.rows)) {
          const hStr = tableData.headers.join(" | ");
          const rStr = tableData.rows.map(r => Array.isArray(r) ? r.join(" | ") : String(r)).join("\n");
          parts.push(`${hStr}\n${rStr}`);
        }
        if (Array.isArray(block.list)) {
          const items = block.list
            .map(item => {
              const itemText = typeof item === "string" ? item : (item.snippet || "");
              return itemText ? `- ${itemText}` : "";
            })
            .filter(Boolean);
          if (items.length > 0) {
            parts.push(items.join("\n"));
          }
        }
        if (Array.isArray(block.text_blocks)) {
          parts.push(extractTextFromBlocks(block.text_blocks));
        }
        return parts.join("\n");
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

/**
 * Probe Google AI Overview via Bright Data (R1.7.3 — SerpAPI path removed).
 *
 * @param {string} prompt - Search query/prompt
 * @param {Object} options - Mapping options (timeout, stats, etc.)
 * @returns {Promise<Object>} Probe result: { text, model_used, citations, cost, tokens }
 */
export async function probeGoogleAiOverview(prompt, options = {}) {
  if (!isBrightDataConfigured()) {
    console.warn("[serp] No Bright Data SERP provider configured. Skipping Google AI Overview probe.");
    return { text: "", model_used: "google_ai_overview-skipped", citations: [], cost: 0.0, tokens: 0 };
  }

  // R3.6.4 — resolved before the try, and outside it: the catch below converts
  // any throw into a `cost: 0.0` skipped probe, which is the one shape a pricing
  // refusal must never take. An unpriced provider therefore propagates to the caller.
  const { cost } = resolveSerpQueryCost({ provider: "brightdata" });

  try {
    const data = await brightDataSearch(prompt, { ...options, aiOverview: true });
    const { text, citations } = extractBrightDataAiOverview(data);

    if (options.stats) {
      options.stats.cost = (options.stats.cost || 0) + cost;
    }

    const hasOverview = !!text?.trim();
    return {
      text,
      model_used: hasOverview ? "google_ai_overview" : "google_ai_overview-skipped",
      citations,
      cost,
      tokens: 0,
    };
  } catch (e) {
    const msg = (e?.message || String(e)).toLowerCase();
    if (msg.includes("rate limit") || msg.includes("quota")) {
      throw e;
    }
    console.warn(`[brightdata] Google AI Overview unavailable — skipping: ${e?.message || e}`);
    return { text: "", model_used: "google_ai_overview-skipped", citations: [], cost: 0.0, tokens: 0 };
  }
}

/**
 * Fetches "People Also Ask" questions via Bright Data SERP (R1.7.3 — SerpAPI path removed).
 *
 * @param {Array|string} seedTerms - Search term(s) to fetch queries for
 * @param {object} [options]
 * @param {string} [options.geo] - override geo for the search
 * @returns {Promise<Array<string>>} List of question strings
 */
export async function fetchPeopleAlsoAsk(seedTerms, options = {}) {
  if (!isBrightDataConfigured()) {
    console.warn("[serp] No Bright Data SERP provider configured. PAA fetch returning empty list.");
    return [];
  }

  const questions = new Set();
  const terms = Array.isArray(seedTerms) ? seedTerms : [seedTerms];

  for (const term of terms.slice(0, 3)) {
    try {
      const data = await brightDataSearch(term, { aiOverview: false, timeout: 30000, geo: options.geo });
      extractBrightDataPaa(data).forEach((q) => questions.add(q));
    } catch (e) {
      // R2.2.8 / rule 1: a typed zone failure is a CONFIGURATION defect, not a
      // per-term miss, and it must not be flattened into an empty list. Caught
      // here and swallowed, a dead Bright Data zone returned `[]` — which is
      // byte-for-byte what "Google had no People-Also-Ask for this term" returns
      // — so generateUnbrandedPrompts seeded the whole prompt set from nothing
      // and emitted not one line about it. Every remaining term would fail
      // identically against the same dead zone, so there is nothing to salvage
      // by continuing: propagate, and let the caller record the degrade.
      //
      // Same rule brightDataSearch applies inside its own retry catch
      // (src/lib/engines/brightdata.js: `if (isBrightDataZoneError(err)) throw err`).
      if (isBrightDataZoneError(e)) {
        console.warn(
          `[serp] PAA fetch ABORTED at term "${term}" — the Bright Data SERP zone is unusable ` +
            `(${e.reason}), so no term can succeed. Propagating instead of returning ` +
            `${questions.size} questions as if the search had run:`,
          e
        );
        throw e;
      }
      // The error object, not just its message: `reason`/`cause`/stack are what
      // tell a transient 503 apart from a credential fault in a log.
      console.warn(`[serp] PAA fetch failed for term "${term}":`, e);
    }
  }
  return Array.from(questions);
}

/**
 * Fetches Google search autocomplete suggestions for seed terms.
 * Uses the free suggestqueries.google.com endpoint for efficiency.
 *
 * @param {Array|string} seedTerms - Search term(s)
 * @returns {Promise<Array<string>>} List of suggestion strings
 */
export async function fetchAutocomplete(seedTerms) {
  const suggestions = new Set();
  const terms = Array.isArray(seedTerms) ? seedTerms : [seedTerms];
  
  for (const term of terms.slice(0, 3)) {
    try {
      const res = await fetch(`https://suggestqueries.google.com/complete/search?client=chrome&q=${encodeURIComponent(term)}`);
      if (res.ok) {
        const data = await res.json();
        if (data && Array.isArray(data[1])) {
          data[1].forEach(sug => suggestions.add(sug));
        }
      }
    } catch (e) {
      // R2.2.8: the error object, not a bare message — same reason as the PAA
      // catch above. No zone branch here: this endpoint is Google's own
      // suggest service and never routes through a Bright Data zone.
      console.warn(`[serp] Autocomplete fetch failed for term "${term}":`, e);
    }
  }
  return Array.from(suggestions);
}

