import { LlmUnavailableError } from "./llmErrors.js";
import { LLM_ENV, getLlmApiKey, getLlmBaseUrl, getLlmModel, getLlmProvider } from "./llmConfig.js";
import { assertModelPriceable, isFreeModelId, isUnpricedModel, resolveCost } from "./llmPricing.js";
import {
  FAILURE_KIND,
  failureKindOf,
  isRetryableFailure,
  tagHttpFailure,
} from "./engines/httpFailureKind.js";

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
  // Refuse to spend on a model nothing can price (R3.6.1, finding C4). This is
  // deliberately BEFORE the request: an unpriced id is a configuration error,
  // and failing here costs no tokens and no half-finished scan, where the same
  // throw after the completion would discard an answer already paid for.
  // See src/lib/llmPricing.js for the three named cost sources.
  assertModelPriceable(model, provider);

  const url = `${baseUrl}/chat/completions`;
  const isOpenRouter = provider === "openrouter";
  const isMimo = provider === "mimo";
  const wait = (ms) => new Promise((res) => setTimeout(res, ms));

  const isSonarJson = options.jsonMode && provider === "openrouter" &&
    /^perplexity\/sonar(?:$|-|:)/.test(model);
  const messages = [];
  if (options.system) messages.push({ role: "system", content: options.system });
  messages.push({
    role: "user",
    content: isSonarJson
      ? `${prompt}\n\nReturn ONLY the requested valid JSON object or array. No prose or code fences.`
      : prompt,
  });

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
    // Sonar rejects json_object and its strict schemas require a task-specific
    // object shape. Our callers request both arbitrary objects and arrays, so
    // use its supported text mode with an explicit JSON instruction. llmJson
    // still parses/validates the response and retries malformed JSON.
    body.response_format = { type: isSonarJson ? "text" : "json_object" };
  }
  // Paid models: ask OpenRouter to include the real cost in `usage` so the
  // content pipeline's per-item cost cap works off actual spend, not guesses.
  const isPaidModel = !isFreeModelId(model);
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
  // COUNTED, not inferred from `retries`. "Refused on the first call" and
  // "retried to exhaustion" are different operator stories and must not print
  // the same sentence (R3.6.7); the old message always claimed retries + 1.
  let attempts = 0;
  let timeBudgetExceeded = false;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const remainingMs = Number.isFinite(options.deadlineMs) ? options.deadlineMs - Date.now() : Infinity;
    if (remainingMs <= 0) {
      timeBudgetExceeded = true;
      break;
    }
    const timeoutMs = Math.min(options.timeout || 30000, remainingMs);
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      attempts++;
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

      // Keep the abort timer active while reading the response body too.
      // Receiving headers does not mean a streamed completion has finished.
      if (!res.ok) {
        const errText = await res.text();
        // R3.6.7. What stood here was
        //
        //     const retryable = res.status === 429 || res.status >= 500;
        //     if (retryable && attempt < retries) { ...back off... continue; }
        //     throw new Error(...);
        //
        // and that throw landed in this loop's own `catch`, which backed off
        // and went round again for ANY status. The guard decided nothing:
        // measured on this file, a 401 cost 3 calls and 4546ms and then threw
        // LlmUnavailableError{reason:"exhausted_retries"} — so a revoked key,
        // the one failure an operator can actually fix, arrived labelled as a
        // vendor outage in the single field a caller branches on.
        //
        // The status is classified ONCE, here, where the response is still in
        // hand, and the verdict rides on the error for the catch and the final
        // throw to read. Same module as the engine adapters
        // (src/lib/engines/httpFailureKind.js) so the gateway client and the
        // probes cannot disagree about whether a 403 is worth another call.
        // errText is the gateway's own body; the Authorization header is never
        // echoed into it, so no credential reaches this message.
        throw tagHttpFailure(new Error(`${provider} HTTP ${res.status}: ${errText}`), res.status);
      }

      const data = await res.json();
      clearTimeout(timeoutId);
      const text = data?.choices?.[0]?.message?.content || "";
      // Raw and uncoerced on purpose. `|| 0` here would destroy the only
      // evidence resolveCost has that the gateway reported nothing at all,
      // and a priced model with no usage block would price as $0 (R3.6.1).
      const usage = data?.usage;
      const promptTokens = usage?.prompt_tokens;
      const completionTokens = usage?.completion_tokens;
      const tokens =
        Number(usage?.total_tokens) || (Number(promptTokens) || 0) + (Number(completionTokens) || 0);
      // Cost comes from exactly one named source — real spend echoed by the
      // gateway, the `:free` suffix, or the price table — and throws when none
      // of them applies. It used to be `Number(data?.usage?.cost) || 0`, which
      // turned every paid completion on a gateway that does not echo cost
      // (MiMo, and any `custom` one) into a free one. Standing rule 3.
      const { cost, cost_source } = resolveCost({
        model,
        provider,
        usage,
        promptTokens,
        completionTokens,
      });

      if (options.stats) {
        options.stats.tokens = (options.stats.tokens || 0) + tokens;
        options.stats.cost = (options.stats.cost || 0) + cost;
      }

      // cost_source travels with the number so a $0 that was measured never
      // reads the same as a $0 that was assumed (standing rule 1).
      return { text, model_used: model, tokens, cost, cost_source };
    } catch (e) {
      clearTimeout(timeoutId);
      // A pricing refusal is not a transport failure. Retrying it would spend
      // three times over and then relabel it "exhausted_retries", burying the
      // actual cause — the whole point of R3.6.1 is that this one stays
      // legible. Out, immediately, with its own type.
      if (isUnpricedModel(e)) throw e;
      lastErr = e;
      // Permanent: the gateway understood the request and refused it (401, 403,
      // 400, 404...). Leaving the loop on the first response is half the fix —
      // the other half is the reason label below. An untagged failure (abort,
      // socket reset, truncated body) has no verdict on it and stays retryable
      // by failureKindOf's deliberate default, so a recoverable measurement is
      // never discarded.
      if (!isRetryableFailure(e)) break;
      if (Number.isFinite(options.deadlineMs) && Date.now() >= options.deadlineMs) {
        timeBudgetExceeded = true;
        break;
      }
      if (attempt < retries) {
        const backoffMs = 1500 * Math.pow(2, attempt);
        if (Number.isFinite(options.deadlineMs) && Date.now() + backoffMs >= options.deadlineMs) {
          timeBudgetExceeded = true;
          break;
        }
        await wait(backoffMs);
        continue;
      }
    }
  }

  const spent = `${attempts} attempt${attempts === 1 ? "" : "s"}`;
  if (timeBudgetExceeded) {
    throw new LlmUnavailableError(
      `LLM step time budget exceeded after ${spent}; stopped before the worker execution limit`,
      { reason: "deadline_exceeded", provider, model, cause: lastErr }
    );
  }

  // A permanent refusal is not an outage, and must not borrow an outage's
  // label. `reason` is the one field callers branch on (it is propagated
  // verbatim by src/lib/scoring/promptSource.js), so "exhausted_retries" on a
  // revoked key sent an operator looking at the vendor's status page instead of
  // at their own key. Standing rule 1: the two states must not read alike.
  if (failureKindOf(lastErr) === FAILURE_KIND.PERMANENT) {
    const status = lastErr?.status ?? null;
    const reason = status === 401 || status === 403 ? "auth_failed" : "permanent_error";
    // CONDITIONAL on the counted attempts, because a permanent refusal does not
    // only arrive first. 429-then-403 on quota exhaustion and 5xx-then-401 on a
    // mid-run key rotation both reach here with attempts > 1: an earlier
    // transient failure already bought a retry, and the refusal landed on that
    // retry. The first draft of this sentence hardcoded "on the first call" and
    // "not retried" beside the real count, so it printed "on the first call
    // (2 attempts, not retried)" — contradicting itself in one breath and
    // undoing the exact distinction `attempts` is counted for. Every attempt
    // before the last was necessarily a transient failure (the loop only
    // continues when isRetryableFailure said so), so the count names them.
    const whenRefused =
      attempts <= 1
        ? `on the first call (${spent}, not retried — a permanent refusal does not ` +
          `improve with backoff)`
        : `on attempt ${attempts} of ${retries + 1}, after ${attempts - 1} transient ` +
          `failure${attempts === 2 ? "" : "s"} that earned a retry (${spent}; the refusal ` +
          `itself was not retried — a permanent refusal does not improve with backoff)`;
    const err = new LlmUnavailableError(
      `LLM gateway ${baseUrl} refused the request with HTTP ${status} ${whenRefused}: ` +
        `${lastErr?.message || lastErr}`,
      { reason, provider, model, cause: lastErr }
    );
    err.status = status;
    throw err;
  }

  // Same rule as the missing key above: exhausted retries is an outage, not an
  // answer. Throw so the caller has to decide what an unmeasured value looks
  // like instead of silently inheriting an empty string.
  throw new LlmUnavailableError(
    `LLM gateway ${baseUrl} failed after ${spent}: ${lastErr?.message || lastErr}`,
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
