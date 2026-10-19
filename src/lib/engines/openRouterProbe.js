import { classifyProviderFailure, sanitizeProviderText } from './providerFailure.js';
import { normalizeUrl } from "../scoring/citations.js";
import { getLlmApiKey, getLlmBaseUrl, getLlmProvider } from "../llmConfig.js";
import { assertModelPriceable, isUnpricedModel, resolveCost } from "../llmPricing.js";
import {
  FAILURE_KIND,
  failureKindOf,
  isRetryableFailure,
  tagHttpFailure,
} from "./httpFailureKind.js";

const MAX_RETRIES = 2;
const TIMEOUT_MS = 45000;
const RETRY_BASE_DELAY_MS = 1000;
const WEB_SEARCH_TOOL = "openrouter:web_search";

export const DEFAULT_OPENROUTER_MODELS = Object.freeze({
  chatgpt: "openai/gpt-6-luna",
  perplexity: "perplexity/sonar",
  gemini: "google/gemini-3.8-flash",
});

const MODEL_ENV = Object.freeze({
  chatgpt: ["OPENROUTER_OPENAI_MODEL", "OPENAI_MODEL"],
  perplexity: ["OPENROUTER_PERPLEXITY_MODEL", "PERPLEXITY_MODEL"],
  gemini: ["OPENROUTER_GEMINI_MODEL", "GEMINI_MODEL"],
});

/** The provider model chosen for an answer engine; model ids stay configurable per deployment. */
export function getOpenRouterEngineModel(engine, env = process.env) {
  const names = MODEL_ENV[engine];
  if (!names) throw new Error(`Unknown OpenRouter answer engine: ${engine}`);
  for (const name of names) {
    const value = String(env?.[name] || "").trim();
    if (value) return value;
  }
  return DEFAULT_OPENROUTER_MODELS[engine];
}

/** Whether the shared gateway and this engine's model are ready to call. */
export function isOpenRouterEngineConfigured(engine, env = process.env) {
  return Boolean(
    getLlmApiKey(env) &&
      getLlmProvider(getLlmBaseUrl(env)) === "openrouter" &&
      getOpenRouterEngineModel(engine, env)
  );
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function textFromMessage(message) {
  if (typeof message?.content === "string") return message.content.trim();
  if (Array.isArray(message?.content)) {
    return message.content
      .map((part) => (typeof part === "string" ? part : part?.text || ""))
      .filter(Boolean)
      .join("\n")
      .trim();
  }
  return "";
}

function citationReference(candidate) {
  const nested = candidate?.url_citation || candidate?.citation || candidate;
  const href = typeof nested === "string" ? nested : nested?.url || nested?.href;
  if (!href || !/^https?:\/\//i.test(href)) return null;
  const title = typeof nested === "object" ? nested.title || nested.name || "" : "";
  return { href, title, source: title };
}

export function extractOpenRouterReferences(response) {
  const message = response?.choices?.[0]?.message || {};
  const candidates = [
    ...(Array.isArray(message.annotations) ? message.annotations : []),
    ...(Array.isArray(message.citations) ? message.citations : []),
    ...(Array.isArray(response?.citations) ? response.citations : []),
  ];
  const references = [];
  const seen = new Set();
  for (const candidate of candidates) {
    const reference = citationReference(candidate);
    if (!reference) continue;
    const key = normalizeUrl(reference.href);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    references.push(reference);
  }
  return references;
}

function measuredCost(model, usage) {
  try {
    const measured = resolveCost({ model, provider: "openrouter", usage });
    return { ...measured, cost_state: "measured", cost_state_detail: null };
  } catch (error) {
    if (!isUnpricedModel(error)) throw error;
    return {
      cost: null,
      cost_source: null,
      cost_state: error.reason === "unmeasured_tokens" ? "unmeasured_tokens" : "unpriced",
      cost_state_detail: error.message,
    };
  }
}

function addStats(stats, usage, cost) {
  if (!stats) return;
  if (cost.cost === null) {
    stats.cost_unmeasured_calls = (stats.cost_unmeasured_calls || 0) + 1;
  } else {
    stats.cost = (stats.cost || 0) + cost.cost;
  }
  const input = usage?.prompt_tokens ?? usage?.input_tokens;
  const output = usage?.completion_tokens ?? usage?.output_tokens;
  if (Number.isFinite(Number(input)) || Number.isFinite(Number(output))) {
    stats.tokens = (stats.tokens || 0) + (Number(input) || 0) + (Number(output) || 0);
  }
}

/**
 * Ask an OpenRouter model with its provider-native search enabled. This keeps
 * ChatGPT and Perplexity model calls behind the single LLM_API_KEY used by the
 * utility/content LLM, while retaining engine-specific model ids and citations.
 */
export async function probeOpenRouterEngine({ engine, query, stats, model = getOpenRouterEngineModel(engine), durableDispatch = false, deadlineAt = null }) {
  const apiKey = getLlmApiKey();
  const baseUrl = getLlmBaseUrl();
  const provider = getLlmProvider(baseUrl);
  if (!apiKey) throw Object.assign(new Error("LLM_API_KEY is not set"), { failureKind: FAILURE_KIND.PERMANENT });
  if (provider !== "openrouter") {
    throw Object.assign(
      new Error(`Answer engines require the OpenRouter gateway; configured gateway is ${provider}`),
      { failureKind: FAILURE_KIND.PERMANENT }
    );
  }

  // OpenRouter reports the actual charge when asked. Fail before a request only
  // if the configured gateway cannot report a cost for this model.
  assertModelPriceable(model, "openrouter");

  // Sonar searches natively and does not support function/tool calling.
  // Sending server tools filters out its only endpoint with HTTP 404.
  const nativeSonar = engine === "perplexity" && /^perplexity\/sonar(?:$|-|:)/.test(model);

  let lastError = null;
  const attempts = durableDispatch ? 1 : MAX_RETRIES + 1;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), Math.max(1,Math.min(TIMEOUT_MS,deadlineAt == null ? TIMEOUT_MS : deadlineAt-Date.now())));
    try {
      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          "HTTP-Referer": "https://aeovis.app",
          "X-Title": "aeovis",
        },
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: query }],
          ...(nativeSonar ? {} : { tools: [
            {
              type: WEB_SEARCH_TOOL,
              parameters: {
                engine: "native",
                max_total_results: 5,
                user_location: { type: "approximate", country: "IN" },
              },
            },
          ],
          max_tool_calls: 1 }),
          max_tokens: nativeSonar ? 900 : 2500,
          ...(!nativeSonar ? { reasoning: { effort: "minimal" } } : {}),
          usage: { include: true },
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw Object.assign(tagHttpFailure(new Error(`OpenRouter HTTP ${response.status}: ${sanitizeProviderText(body)}`), response.status), {
          provider_failure: classifyProviderFailure({ provider:'openrouter',status:response.status,headers:response.headers,body }),
        });
      }
      const data = await response.json();
      const message = data?.choices?.[0]?.message;
      if (!message) throw new Error("OpenRouter returned no answer message");
      const usage = data.usage || null;
      const cost = measuredCost(model, usage);
      addStats(stats, usage, cost);
      const references = extractOpenRouterReferences(data);
      if (!textFromMessage(message) && references.length === 0) {
        throw new Error(`OpenRouter returned an empty answer (finish reason: ${data?.choices?.[0]?.finish_reason || "unknown"})`);
      }
      const returnedModel = data?.model || model;
      return {
        text: textFromMessage(message),
        citations: references.map((item) => normalizeUrl(item.href)).filter(Boolean),
        references,
        usage,
        model: returnedModel,
        requested_model: model,
        returned_model: returnedModel,
        provider_request_id: data?.id || null,
        search_requests: Number(usage?.server_tool_use?.web_search_requests) || 0,
        ...cost,
        error: null,
        error_kind: null,
      };
    } catch (error) {
      lastError = error;
      if (attempt + 1 >= attempts || !isRetryableFailure(error)) break;
      await delay(RETRY_BASE_DELAY_MS * (2 ** attempt));
    } finally {
      clearTimeout(timeoutId);
    }
  }
  const message = sanitizeProviderText(lastError?.message) || "OpenRouter answer probe failed";
  return {
    text: "",
    citations: [],
    references: [],
    usage: null,
    model,
    search_requests: 0,
    cost: null,
    cost_source: null,
    cost_state: "probe_failed",
    cost_state_detail: message,
    error: message,
    error_kind: failureKindOf(lastError),
    provider_failure: lastError?.provider_failure || classifyProviderFailure({provider:"openrouter",error:lastError}),
  };
}
