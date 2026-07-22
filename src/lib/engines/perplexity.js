import { normalizeUrl } from "../scoring/citations.js";

const PERPLEXITY_CHAT_URL = "https://api.perplexity.ai/chat/completions";
const PERPLEXITY_SEARCH_URL = "https://api.perplexity.ai/search";
const PERPLEXITY_MODEL = process.env.PERPLEXITY_MODEL || "sonar";
const MAX_RETRIES = 2;
const TIMEOUT_MS = 45000;

export function isPerplexityConfigured() {
  return !!process.env.PERPLEXITY_API_KEY;
}

function delay(ms) {
  return new Promise((res) => setTimeout(res, ms));
}

async function perplexityFetch(url, body, apiKey) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    return res;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function probeAnswer(query, apiKey) {
  let lastErr = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await perplexityFetch(
        PERPLEXITY_CHAT_URL,
        {
          model: PERPLEXITY_MODEL,
          messages: [{ role: "user", content: query }],
          web_search_options: { user_location: { country: "IN" } },
        },
        apiKey
      );

      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        const err = new Error(`Perplexity answer HTTP ${res.status}: ${errText}`);
        if (res.status === 429 || res.status >= 500) {
          lastErr = err;
          if (attempt < MAX_RETRIES) {
            await delay(1000 * Math.pow(2, attempt));
            continue;
          }
        }
        throw err;
      }

      const resJson = await res.json();
      const text = resJson.choices?.[0]?.message?.content || "";
      const cost = resJson.usage?.cost?.total_cost ?? resJson.usage?.total_cost ?? 0.005;

      return { text: text.trim(), cost, error: null, usage: resJson.usage || null };
    } catch (e) {
      lastErr = e;
      if (attempt < MAX_RETRIES) {
        await delay(1000 * Math.pow(2, attempt));
      }
    }
  }

  return {
    text: "",
    cost: 0,
    error: lastErr?.message || "Perplexity answer probe failed",
    usage: null,
  };
}

async function probeSearch(query, apiKey) {
  let lastErr = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await perplexityFetch(
        PERPLEXITY_SEARCH_URL,
        { query, max_results: 10 },
        apiKey
      );

      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        const err = new Error(`Perplexity search HTTP ${res.status}: ${errText}`);
        if (res.status === 429 || res.status >= 500) {
          lastErr = err;
          if (attempt < MAX_RETRIES) {
            await delay(1000 * Math.pow(2, attempt));
            continue;
          }
        }
        throw err;
      }

      const resJson = await res.json();
      const results = resJson.results || [];

      const references = results.map((r) => ({
        href: r.url || "",
        title: r.title || "",
        source: r.title || "",
      }));

      const citations = [...new Set(references.map((r) => normalizeUrl(r.href)).filter(Boolean))];

      return { references, citations, cost: 0.005, error: null };
    } catch (e) {
      lastErr = e;
      if (attempt < MAX_RETRIES) {
        await delay(1000 * Math.pow(2, attempt));
      }
    }
  }

  return {
    references: [],
    citations: [],
    cost: 0,
    error: lastErr?.message || "Perplexity search probe failed",
  };
}

export async function probePerplexity(query, options = {}) {
  const apiKey = process.env.PERPLEXITY_API_KEY;
  if (!apiKey) {
    console.warn("[perplexity] PERPLEXITY_API_KEY not set — skipping");
    return { text: "", citations: [], references: [], cost: 0, error: "PERPLEXITY_API_KEY not set" };
  }

  const [answer, search] = await Promise.all([
    probeAnswer(query, apiKey),
    probeSearch(query, apiKey),
  ]);

  // If answer failed entirely, return error
  if (answer.error && !answer.text) {
    console.error(`[perplexity] Both answer and search failed for query: "${query}"`);
    return {
      text: "",
      citations: search.citations,
      references: search.references,
      cost: answer.cost + search.cost,
      error: answer.error,
    };
  }

  const totalCost = answer.cost + search.cost;

  if (options.stats) {
    options.stats.cost = (options.stats.cost || 0) + totalCost;
    if (answer.usage) {
      options.stats.tokens =
        (options.stats.tokens || 0) +
        (answer.usage.prompt_tokens || 0) +
        (answer.usage.completion_tokens || 0);
    }
  }

  return {
    text: answer.text,
    citations: search.citations,
    references: search.references,
    cost: totalCost,
    error: null,
  };
}
