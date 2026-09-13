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

function getSerpProvider() {
  const explicit = (process.env.SERP_PROVIDER || "").trim().toLowerCase();
  if (explicit === "brightdata") return getBrightDataApiKey() ? "brightdata" : null;
  if (explicit === "serpapi") return resolveSerpCredentials() ? "serpapi" : null;
  if (getBrightDataApiKey()) return "brightdata";
  if (resolveSerpCredentials()) return "serpapi";
  return null;
}

function isSerpConfigured() {
  return !!getSerpProvider();
}

function resolveSerpCredentials() {
  const raw = (process.env.SERPAPI_KEY || "").trim();
  if (!raw) return null;

  const toBasicAuth = (value) => `Basic ${Buffer.from(value).toString("base64")}`;

  if (/^[A-Za-z0-9+/]+=*$/.test(raw) && raw.length > 20) {
    try {
      const decoded = Buffer.from(raw, "base64").toString("utf8");
      if (decoded.includes("@") && decoded.includes(":")) {
        return { authHeader: `Basic ${raw}` };
      }
    } catch {
      // Fall through to plain key handling.
    }
  }

  if (raw.includes("@") && raw.includes(":")) {
    return { authHeader: toBasicAuth(raw) };
  }

  return { apiKey: raw };
}

async function serpFetch(searchParams, options = {}) {
  const creds = resolveSerpCredentials();
  if (!creds) {
    throw new Error("SERPAPI_KEY is not configured.");
  }

  const params = new URLSearchParams(searchParams);
  if (creds.apiKey) {
    params.set("api_key", creds.apiKey);
  }

  const headers = {};
  if (creds.authHeader) {
    headers.Authorization = creds.authHeader;
  }

  return fetch(`https://serpapi.com/search?${params.toString()}`, {
    method: "GET",
    headers,
    signal: options.signal,
  });
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
 * SerpAPI Google search adapter to fetch Google AI Overview responses.
 *
 * @param {string} prompt - Search query/prompt
 * @param {Object} options - Mapping options (timeout, stats, etc.)
 * @param {number} retries - Retry attempts
 * @returns {Promise<Object>} Probe result: { text, model_used, citations, cost, tokens }
 */
export async function probeGoogleAiOverview(prompt, options = {}, retries = 2) {
  const provider = getSerpProvider();
  if (!provider) {
    console.warn("[serp] No SERP provider configured. Skipping Google AI Overview probe.");
    return { text: "", model_used: "google_ai_overview-skipped", citations: [], cost: 0.0, tokens: 0 };
  }

  if (provider === "brightdata") {
    return probeGoogleAiOverviewBrightData(prompt, options);
  }

  // R3.6.4 — the per-query price comes from the price table in
  // src/lib/llmPricing.js, and it is resolved HERE, before the retry loop.
  // Inside that loop every throw is caught, retried, and finally turned into a
  // `cost: 0.0` skip return, so a pricing refusal raised in there would be
  // laundered into precisely the silent $0 the table exists to prevent
  // (standing rules 1 and 2).
  const perQueryCost = resolveSerpQueryCost({ provider: "serpapi" }).cost;

  const geo = resolveSerpGeo(options.geo);
  const device = process.env.SERP_DEVICE || "desktop";

  // hl=en is required for AI Overview support
  const searchParams = new URLSearchParams({
    q: prompt,
    engine: "google",
    gl: geo,
    hl: "en",
    device: device
  });

  const wait = (ms) => new Promise(res => setTimeout(res, ms));
  let lastErr = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const timeoutMs = options.timeout || 30000;
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

      const res = await serpFetch(searchParams, { signal: controller.signal });

      clearTimeout(timeoutId);

      if (!res.ok) {
        throw new Error(`SerpAPI HTTP ${res.status}: ${await res.text()}`);
      }

      let resJson = await res.json();
      if (resJson.error) {
        const authError = String(resJson.error).toLowerCase().includes("invalid api key");
        if (authError) {
          const creds = resolveSerpCredentials();
          if (creds?.authHeader && !global.__serpLoginCredentialWarned) {
            global.__serpLoginCredentialWarned = true;
            console.warn(
              "[serp] SerpAPI rejected the credential. SERPAPI_KEY must be your private API key from https://serpapi.com/manage-api-key — not your login email/password."
            );
          }
        }
        return { text: "", model_used: "google_ai_overview-skipped", citations: [], cost: 0.0, tokens: 0 };
      }

      let cost = perQueryCost; // SerpAPI flat rate for one search query

      // Handle deferred loading using SGE token
      const pageToken = resJson.ai_overview?.page_token || 
                        resJson.ai_overview_deferred?.token || 
                        resJson.ai_overview?.deferred_token;

      if (pageToken) {
        const followUpParams = new URLSearchParams({
          engine: "google_ai_overview",
          page_token: pageToken,
        });
        const followUpRes = await serpFetch(followUpParams, { signal: controller.signal });
        if (followUpRes.ok) {
          const followUpJson = await followUpRes.json();
          if (followUpJson.ai_overview) {
            resJson.ai_overview = followUpJson.ai_overview;
          }
          // The deferred overview fetch is a SECOND billed search at the same
          // per-query rate, so the table value is added again rather than
          // restated as a literal.
          cost += perQueryCost;
        }
      }
      
      let text = "";
      let citations = [];
      
      if (resJson.ai_overview) {
        text = resJson.ai_overview.text || "";
        if (Array.isArray(resJson.ai_overview.text_blocks)) {
          text = extractTextFromBlocks(resJson.ai_overview.text_blocks);
        }
        const refs = resJson.ai_overview.references || [];
        citations = refs.map(r => r.link).filter(Boolean).map(normalizeUrl);
      }

      if (options.stats) {
        options.stats.cost = (options.stats.cost || 0) + cost;
      }

      const hasOverview = !!text?.trim();
      return {
        text,
        model_used: hasOverview ? "google_ai_overview" : "google_ai_overview-skipped",
        citations,
        cost,
        tokens: 0
      };
    } catch (e) {
      lastErr = e;
      if (attempt < retries) {
        const delay = 1000 * Math.pow(2, attempt);
        await wait(delay);
      }
    }
  }

  const authError = String(lastErr?.message || lastErr).includes("401");
  if (authError) {
    console.warn("[serp] SERPAPI_KEY is invalid — skipping Google AI Overview for this scan.");
    return { text: "", model_used: "google_ai_overview-skipped", citations: [], cost: 0.0, tokens: 0 };
  }

  console.warn(`[serp] Google AI Overview unavailable after ${retries} retries — skipping: ${lastErr}`);
  return { text: "", model_used: "google_ai_overview-skipped", citations: [], cost: 0.0, tokens: 0 };
}

/**
 * Fetches "People Also Ask" questions using SerpAPI search results.
 *
 * @param {Array|string} seedTerms - Search term(s) to fetch queries for
 * @returns {Promise<Array<string>>} List of question strings
 */
async function probeGoogleAiOverviewBrightData(prompt, options = {}) {
  // R3.6.4 — resolved before the try, and outside it, for the same reason as
  // the SerpAPI branch above: the catch below converts any throw into a
  // `cost: 0.0` skipped probe, which is the one shape a pricing refusal must
  // never take. An unpriced provider therefore propagates to the caller.
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

export async function fetchPeopleAlsoAsk(seedTerms, options = {}) {
  if (!isSerpConfigured()) {
    console.warn("[serp] No SERP provider configured. PAA fetch returning empty list.");
    return [];
  }

  const provider = getSerpProvider();
  const questions = new Set();
  const terms = Array.isArray(seedTerms) ? seedTerms : [seedTerms];

  for (const term of terms.slice(0, 3)) {
    try {
      if (provider === "brightdata") {
        const data = await brightDataSearch(term, { aiOverview: false, timeout: 30000, geo: options.geo });
        extractBrightDataPaa(data).forEach((q) => questions.add(q));
        continue;
      }

      // R1.6.2 — resolved per call, not at module load, so a SERP_GEO set
      // after import (or per-request in tests) is honoured. The Bright Data
      // branch above already routes through resolveSerpGeo() inside
      // brightDataSearch; a literal here would seed the India-first prompt
      // set from US People-Also-Ask questions under SerpAPI and Indian ones
      // under Bright Data — prompt sets that are not comparable.
      const searchParams = new URLSearchParams({
        q: term,
        engine: "google",
        hl: "en",
        gl: resolveSerpGeo(options.geo),
      });
      const res = await serpFetch(searchParams);
      if (res.ok) {
        const data = await res.json();
        const paa = data.people_also_ask || [];
        paa.forEach((item) => {
          if (item.question) {
            questions.add(item.question);
          }
        });
      }
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

