import { normalizeUrl } from "../scoring/citations.js";

const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const MAX_RETRIES = 2;
const TIMEOUT_MS = 45000;

export function isChatGptConfigured() {
  return !!process.env.OPENAI_API_KEY;
}

function delay(ms) {
  return new Promise((res) => setTimeout(res, ms));
}

export async function probeChatGpt(query, options = {}) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.warn("[chatgpt] OPENAI_API_KEY not set — skipping");
    return { text: "", citations: [], references: [], cost: 0, error: "OPENAI_API_KEY not set" };
  }

  const body = {
    model: OPENAI_MODEL,
    tools: [
      {
        type: "web_search",
        user_location: { type: "approximate", country: "IN" },
      },
    ],
    input: query,
  };

  let lastErr = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

      const res = await fetch(OPENAI_RESPONSES_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!res.ok) {
        const errorText = await res.text().catch(() => "");
        const err = new Error(`OpenAI HTTP ${res.status}: ${errorText}`);
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

      const textParts = [];
      const references = [];
      const citationUrls = new Set();

      const outputs = resJson.output || [];
      for (const item of outputs) {
        if (item.type === "message" && item.role === "assistant") {
          for (const part of item.content || []) {
            if (part.type === "output_text") {
              textParts.push(part.text || "");
              // extract annotations
              for (const ann of part.annotations || []) {
                if (ann.type === "url_citation") {
                  const url = ann.url || "";
                  const title = ann.title || "";
                  if (url) {
                    references.push({ href: url, title, source: title });
                    citationUrls.add(normalizeUrl(url));
                  }
                }
              }
            }
          }
        }
      }

      const text = textParts.join("\n").trim();

      let cost = 0.01; // base web_search tool fee
      if (resJson.usage) {
        const inputTokens = resJson.usage.input_tokens || 0;
        const outputTokens = resJson.usage.output_tokens || 0;
        // gpt-4o-mini: $0.15/1M input, $0.60/1M output
        cost += (inputTokens * 0.15 + outputTokens * 0.60) / 1e6;
      }

      if (options.stats) {
        options.stats.cost = (options.stats.cost || 0) + cost;
        if (resJson.usage) {
          options.stats.tokens =
            (options.stats.tokens || 0) +
            (resJson.usage.input_tokens || 0) +
            (resJson.usage.output_tokens || 0);
        }
      }

      return {
        text,
        citations: [...citationUrls],
        references,
        cost,
        error: null,
      };
    } catch (e) {
      lastErr = e;
      if (attempt < MAX_RETRIES) {
        await delay(1000 * Math.pow(2, attempt));
      }
    }
  }

  console.error(`[chatgpt] probe failed after ${MAX_RETRIES} retries: ${lastErr?.message || lastErr}`);
  return { text: "", citations: [], references: [], cost: 0, error: lastErr?.message || "ChatGPT probe failed" };
}
