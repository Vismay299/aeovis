const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";

function getBaseUrl() {
  return (process.env.OPENROUTER_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, "");
}

export function getOpenRouterModel() {
  return process.env.OPENROUTER_MODEL || "google/gemma-4-31b-it:free";
}

/**
 * OpenRouter chat-completion client. Mirrors gemini.js's generateContent
 * signature/contract so callers (llm.js) stay swappable between providers.
 */
export async function generateContent(prompt, options = {}, retries = 2) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    console.error("OPENROUTER_API_KEY is not configured.");
    return { text: "", model_used: "" };
  }

  const model = getOpenRouterModel();
  const baseUrl = getBaseUrl();
  const url = `${baseUrl}/chat/completions`;
  const isOpenRouter = baseUrl.includes("openrouter.ai");
  const isMimo = baseUrl.includes("xiaomimimo.com");
  const wait = (ms) => new Promise((res) => setTimeout(res, ms));

  const messages = [];
  if (options.system) messages.push({ role: "system", content: options.system });
  messages.push({ role: "user", content: prompt });

  const body = {
    model,
    messages,
    temperature: options.temperature ?? 0.2,
  };
  const maxTokens = options.max_tokens || options.maxTokens;
  if (maxTokens) {
    if (isMimo) body.max_completion_tokens = maxTokens;
    else body.max_tokens = maxTokens;
  }
  if (options.jsonMode) {
    body.response_format = { type: "json_object" };
  }
  // MiMo is a reasoning model — disable thinking so `message.content` is the
  // final answer only, not interleaved with a hidden reasoning trace that
  // would break robustJsonParse below.
  if (isMimo) {
    body.thinking = { type: "disabled" };
  }

  let lastErr = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const timeoutMs = options.timeout || 30000;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          ...(isOpenRouter ? { "HTTP-Referer": "https://aeovis.app", "X-Title": "aeovis" } : {}),
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!res.ok) {
        const errText = await res.text();
        const retryable = res.status === 429 || res.status >= 500;
        if (retryable && attempt < retries) {
          lastErr = new Error(`OpenRouter HTTP ${res.status}: ${errText}`);
          await wait(1500 * Math.pow(2, attempt));
          continue;
        }
        throw new Error(`OpenRouter HTTP ${res.status}: ${errText}`);
      }

      const data = await res.json();
      const text = data?.choices?.[0]?.message?.content || "";
      const promptTokens = data?.usage?.prompt_tokens || 0;
      const completionTokens = data?.usage?.completion_tokens || 0;
      const tokens = data?.usage?.total_tokens || promptTokens + completionTokens;
      const cost = model.endsWith(":free") ? 0 : 0;

      if (options.stats) {
        options.stats.tokens = (options.stats.tokens || 0) + tokens;
        options.stats.cost = (options.stats.cost || 0) + cost;
      }

      return { text, model_used: model, tokens, cost };
    } catch (e) {
      clearTimeout(timeoutId);
      lastErr = e;
      const isAbort = e.name === "AbortError" || /abort/i.test(e.message || "");
      if (isAbort && attempt < retries) {
        await wait(1500 * Math.pow(2, attempt));
        continue;
      }
      if (attempt < retries) {
        await wait(1500 * Math.pow(2, attempt));
        continue;
      }
    }
  }

  console.error(`[openrouter] all attempts failed after ${retries} retries: ${lastErr}`);
  return { text: "", model_used: "" };
}

/**
 * Defensive JSON parsing for `:free` model output, which often wraps JSON in
 * prose or code fences. Strips fences, tries a direct parse, then falls back
 * to scanning for the first balanced [...] or {...} slice.
 */
export function robustJsonParse(text) {
  if (!text || typeof text !== "string") return null;

  const stripped = text.replace(/```json\s*|```\s*/gi, "").trim();

  try {
    return JSON.parse(stripped);
  } catch {
    // fall through to balanced-slice scan
  }

  // Array case: find the first balanced [...] slice and return it directly.
  const arrStart = stripped.indexOf("[");
  if (arrStart !== -1) {
    const slice = scanBalanced(stripped, arrStart, "[", "]");
    if (slice) {
      try {
        return JSON.parse(slice);
      } catch {
        // fall through
      }
    }
  }

  // Object case: some models (e.g. MiMo) ignore "return a JSON array" and
  // emit JSON Lines instead — one top-level {...} per line, unwrapped.
  // Collect every top-level object we can balance-scan; if there's more
  // than one, treat it as the array the caller asked for.
  const objects = [];
  let cursor = 0;
  while (cursor < stripped.length) {
    const objStart = stripped.indexOf("{", cursor);
    if (objStart === -1) break;
    const slice = scanBalanced(stripped, objStart, "{", "}");
    if (!slice) break;
    try {
      objects.push(JSON.parse(slice));
    } catch {
      // skip unparsable chunk, keep scanning past it
    }
    cursor = objStart + slice.length;
  }

  if (objects.length > 1) return objects;
  if (objects.length === 1) return objects[0];
  return null;
}

/** Scans forward from `start` (which must be at `opener`) for the matching
 * balanced `closer`, respecting quoted strings/escapes. Returns the slice
 * (opener..closer inclusive) or null if never balanced. */
function scanBalanced(str, start, opener, closer) {
  let depth = 0;
  let inString = false;
  let escapeNext = false;
  for (let i = start; i < str.length; i++) {
    const ch = str[i];
    if (escapeNext) {
      escapeNext = false;
      continue;
    }
    if (ch === "\\") {
      escapeNext = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === opener) depth++;
    else if (ch === closer) {
      depth--;
      if (depth === 0) return str.slice(start, i + 1);
    }
  }
  return null;
}
