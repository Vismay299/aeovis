import { LlmUnavailableError } from "./llmErrors.js";
import { LLM_ENV, getLlmApiKey, getLlmBaseUrl, getLlmModel, getLlmProvider } from "./llmConfig.js";

export { getLlmModel };

/**
 * OpenAI-compatible chat-completion client for the utility LLM. Mirrors
 * gemini.js's generateContent signature/contract so callers (llm.js) stay
 * swappable between providers.
 *
 * The gateway is whatever LLM_BASE_URL names (OpenRouter by default, MiMo on
 * the current deployment); per-gateway request quirks come from
 * getLlmProvider(), not from a variable named after one vendor. See
 * docs/vendors/mimo.md.
 *
 * `options.model` overrides the default free model — used only by the
 * content pipeline (llm.js contentLlmJson) for paid content generation.
 */
export async function generateContent(prompt, options = {}, retries = 2) {
  const baseUrl = getLlmBaseUrl();
  const provider = getLlmProvider(baseUrl);
  const apiKey = getLlmApiKey();
  if (!apiKey) {
    // Do NOT return { text: "" } here. An unconfigured key is not an empty
    // answer, and every caller that cannot tell them apart fabricates a clean
    // result from a total outage (finding B6 -> the false 100% SOV, A8).
    throw new LlmUnavailableError(
      `${LLM_ENV.apiKey.canonical} is not configured (legacy ${LLM_ENV.apiKey.legacy} is also unset)`,
      { reason: "missing_key", provider }
    );
  }

  const model = options.model || getLlmModel();
  const url = `${baseUrl}/chat/completions`;
  const isOpenRouter = provider === "openrouter";
  const isMimo = provider === "mimo";
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
  // Paid models: ask OpenRouter to include the real cost in `usage` so the
  // content pipeline's per-item cost cap works off actual spend, not guesses.
  const isPaidModel = !model.endsWith(":free");
  if (isOpenRouter && isPaidModel) {
    body.usage = { include: true };
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
          lastErr = new Error(`${provider} HTTP ${res.status}: ${errText}`);
          await wait(1500 * Math.pow(2, attempt));
          continue;
        }
        throw new Error(`${provider} HTTP ${res.status}: ${errText}`);
      }

      const data = await res.json();
      const text = data?.choices?.[0]?.message?.content || "";
      const promptTokens = data?.usage?.prompt_tokens || 0;
      const completionTokens = data?.usage?.completion_tokens || 0;
      const tokens = data?.usage?.total_tokens || promptTokens + completionTokens;
      // Free models cost 0; paid models report real USD cost when
      // `usage.include` was requested (OpenRouter only).
      const cost = model.endsWith(":free") ? 0 : Number(data?.usage?.cost) || 0;

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

  // Same rule as the missing key above: exhausted retries is an outage, not an
  // answer. Throw so the caller has to decide what an unmeasured value looks
  // like instead of silently inheriting an empty string.
  throw new LlmUnavailableError(
    `LLM gateway ${baseUrl} failed after ${retries + 1} attempt(s): ${lastErr?.message || lastErr}`,
    { reason: "exhausted_retries", provider, model, cause: lastErr }
  );
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
