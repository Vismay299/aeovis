import { normalizeUrl } from "../scoring/citations.js";

/**
 * SerpAPI Google search adapter to fetch Google AI Overview responses.
 *
 * @param {string} prompt - Search query/prompt
 * @param {Object} options - Mapping options (timeout, stats, etc.)
 * @param {number} retries - Retry attempts
 * @returns {Promise<Object>} Probe result: { text, model_used, citations, cost, tokens }
 */
export async function probeGoogleAiOverview(prompt, options = {}, retries = 2) {
  const apiKey = process.env.SERPAPI_KEY;
  if (!apiKey) {
    console.warn("[serp] SERPAPI_KEY not configured. Skipping Google AI Overview probe.");
    return { text: "", model_used: "google_ai_overview-skipped", citations: [], cost: 0.0, tokens: 0 };
  }

  const geo = process.env.SERP_GEO || "us";
  const device = process.env.SERP_DEVICE || "desktop";
  
  const searchParams = new URLSearchParams({
    q: prompt,
    api_key: apiKey,
    engine: "google",
    gl: geo,
    device: device
  });

  const wait = (ms) => new Promise(res => setTimeout(res, ms));
  let lastErr = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const timeoutMs = options.timeout || 30000;
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

      const res = await fetch(`https://serpapi.com/search?${searchParams.toString()}`, {
        method: "GET",
        signal: controller.signal
      });

      clearTimeout(timeoutId);

      if (!res.ok) {
        throw new Error(`SerpAPI HTTP ${res.status}: ${await res.text()}`);
      }

      let resJson = await res.json();

      // P8b-S03: Handle deferred loading using page_token
      const pageToken = resJson.ai_overview?.page_token || 
                        resJson.ai_overview_deferred?.token || 
                        resJson.ai_overview?.deferred_token;

      if (pageToken) {
        const followUpParams = new URLSearchParams({
          engine: "google_ai_overview",
          page_token: pageToken,
          api_key: apiKey
        });
        const followUpRes = await fetch(`https://serpapi.com/search?${followUpParams.toString()}`, {
          method: "GET",
          signal: controller.signal
        });
        if (followUpRes.ok) {
          const followUpJson = await followUpRes.json();
          // Merge or overwrite with follow-up JSON
          if (followUpJson.ai_overview) {
            resJson.ai_overview = followUpJson.ai_overview;
          }
        }
      }
      
      let text = "";
      let citations = [];
      
      if (resJson.ai_overview) {
        text = resJson.ai_overview.text || "";
        if (Array.isArray(resJson.ai_overview.text_blocks)) {
          text = resJson.ai_overview.text_blocks.map(b => b.text).filter(Boolean).join("\n");
        }
        const refs = resJson.ai_overview.references || [];
        citations = refs.map(r => r.link).filter(Boolean).map(normalizeUrl);
      }

      // SerpAPI estimated developer cost per query is $0.01
      const cost = 0.01;

      if (options.stats) {
        options.stats.cost = (options.stats.cost || 0) + cost;
      }

      return {
        text,
        model_used: "google-ai-overview",
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

  console.error(`[serp] Google AI Overview failed after ${retries} retries: ${lastErr}`);
  return { text: "", model_used: "google_ai_overview-failed", citations: [], cost: 0.0, tokens: 0 };
}
