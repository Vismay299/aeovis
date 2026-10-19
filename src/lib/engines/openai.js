import { classifyProviderFailure, sanitizeProviderText } from './providerFailure.js';
import { normalizeUrl } from "../scoring/citations.js";
import {
  FAILURE_KIND,
  failureKindOf,
  isRetryableFailure,
  tagHttpFailure,
} from "./httpFailureKind.js";
import {
  assertModelPriceable,
  isUnpricedModel,
  resolveCost,
  resolveToolFee,
} from "../llmPricing.js";
import { isOpenRouterEngineConfigured, probeOpenRouterEngine } from "./openRouterProbe.js";

const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
const MAX_RETRIES = 2;
const TIMEOUT_MS = 45000;

/** Gateway name for llmPricing's error messages. Not a cost-echoing gateway. */
export const OPENAI_PROVIDER = "openai";

/** The one built-in tool this adapter attaches, and therefore always pays for. */
export const OPENAI_TOOL = "web_search";

/** Used when OPENAI_MODEL is unset. Priced in src/lib/llmPricing.js. */
export const DEFAULT_OPENAI_MODEL = "gpt-4o-mini";

/**
 * The model id this probe will actually call.
 *
 * Read PER CALL, not once at module load. R3.6.6: the id is env-overridable and
 * the price must be keyed on it, so a module-level snapshot would let a process
 * price one model while calling another — the same class of lie, just harder to
 * see. It also makes the unpriced path testable without re-importing the module.
 */
export function getOpenAiModel(env = process.env) {
  return String(env?.OPENAI_MODEL || "").trim() || DEFAULT_OPENAI_MODEL;
}

/**
 * Why `cost` is what it is — a MEASUREMENT or the absence of one (R3.6.6,
 * standing rule 1). `cost` is a number only in the `measured` state; every
 * other state carries `cost: null`, never 0, because a $0 that nobody could
 * compute and a $0 that was genuinely spent are different facts and a spend
 * ledger that adds them together reports the first as the second.
 *
 * Sibling of CITATIONS_STATE in src/lib/engines/perplexity.js.
 */
export const COST_STATE = Object.freeze({
  /** Priced from llmPricing, keyed on the model id actually sent. */
  MEASURED: "measured",
  /** No native OpenAI key or shared OpenRouter key: no request was made. */
  NOT_CONFIGURED: "not_configured",
  /** The request never succeeded, so there is no completion to price. */
  PROBE_FAILED: "probe_failed",
  /** OPENAI_MODEL (or its web_search fee) is absent from the price table. */
  UNPRICED: "unpriced",
  /** The model is priced, but OpenAI returned no usable token counts. */
  UNMEASURED_TOKENS: "unmeasured_tokens",
});

/**
 * Record that this probe produced no cost number.
 *
 * stats.cost is what becomes `cost_total` on the scan row. Leaving it untouched
 * is correct — adding 0 would fabricate a measurement — but a run where every
 * probe was unpriced would then be indistinguishable from a run that was
 * genuinely free. The counter is the difference between measured zero and never
 * measured.
 */
function noteUnmeasuredCost(stats) {
  if (!stats) return;
  stats.cost_unmeasured_calls = (stats.cost_unmeasured_calls || 0) + 1;
}

function unpricedOutcome(stats, state, detail, error = null) {
  noteUnmeasuredCost(stats);
  return {
    text: "",
    citations: [],
    references: [],
    cost: null,
    cost_source: null,
    cost_state: state,
    cost_state_detail: detail,
    error,
  };
}

export function isChatGptConfigured() {
  return !!process.env.OPENAI_API_KEY || isOpenRouterEngineConfigured("chatgpt");
}

function delay(ms) {
  return new Promise((res) => setTimeout(res, ms));
}

export async function probeChatGpt(query, options = {}) {
  const stats = options.stats;
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    if (isOpenRouterEngineConfigured("chatgpt")) {
      const result = await probeOpenRouterEngine({
        engine: "chatgpt",
        query,
        stats,
        durableDispatch: options.durableDispatch, deadlineAt: options.deadlineAt,
      });
      return {
        text: result.text,
        citations: result.citations,
        references: result.references,
        cost: result.cost,
        cost_source: result.cost_source,
        cost_state: result.cost_state,
        cost_state_detail: result.cost_state_detail,
        model: result.model,
        requested_model: result.requested_model,
        returned_model: result.returned_model,
        provider_request_id: result.provider_request_id,
        search_requests: result.search_requests,
        usage: result.usage,
        error: result.error,
        error_kind: result.error_kind,
        provider_failure: result.provider_failure,
      };
    }
    console.warn("[chatgpt] no OPENAI_API_KEY or shared OpenRouter LLM_API_KEY — skipping");
    return unpricedOutcome(
      stats,
      COST_STATE.NOT_CONFIGURED,
      "no request was made, so no cost exists to report",
      "OPENAI_API_KEY or shared OpenRouter LLM_API_KEY not set"
    );
  }

  const model = getOpenAiModel();

  // PRE-FLIGHT PRICING GATE (R3.6.6).
  //
  // This file used to open the cost calculation with `let cost = 0.01` and add
  // gpt-4o-mini's per-token rates, both hard-coded, while OPENAI_MODEL is
  // env-overridable. Pointing the adapter at any other model left every probe
  // priced at gpt-4o-mini's rates and REPORTED AS SPEND — a number that looks
  // measured, survives inspection and is simply wrong. Standing rule 3: an
  // unpriced model id fails loud, never $0, and never a plausible substitute.
  //
  // The gate runs BEFORE the request, like openrouter.js's, for the reason
  // given there: refusing costs nothing, while discovering it after the
  // completion throws away an answer already paid for. Refusing to probe at all
  // is the fail-CLOSED choice — an unpriced deployment yields an engine full of
  // loud error rows rather than a scan quietly billed at some other model's
  // prices. The remedy is one env var and the message names it.
  let toolFee;
  try {
    assertModelPriceable(model, OPENAI_PROVIDER);
    toolFee = resolveToolFee({ model, tool: OPENAI_TOOL, provider: OPENAI_PROVIDER });
  } catch (e) {
    if (!isUnpricedModel(e)) throw e;
    console.error(
      `[chatgpt] REFUSING to probe with OPENAI_MODEL="${model}": ${e.message}`
    );
    return unpricedOutcome(stats, COST_STATE.UNPRICED, e.message, e.message);
  }

  const body = {
    model,
    tools: [
      {
        // Same constant the fee above was priced with, so the tool that is
        // billed and the tool that is priced cannot drift apart.
        type: OPENAI_TOOL,
        user_location: { type: "approximate", country: "IN" },
      },
    ],
    input: query,
  };

  let lastErr = null;
  // How many requests this probe actually SPENT. Reported below instead of the
  // constant MAX_RETRIES, which the old failure line printed whether or not the
  // retries happened (standing rule 1: a skip is not a success, and "after 2
  // retries" on a call that was made once is a log that lies).
  let attempts = 0;

  const maxRetries = options.durableDispatch ? 0 : MAX_RETRIES;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), Math.max(1,Math.min(TIMEOUT_MS,options.deadlineAt == null ? TIMEOUT_MS : options.deadlineAt-Date.now())));
    try {

      attempts++;
      let res;
      res = await fetch(OPENAI_RESPONSES_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });


      if (!res.ok) {
        const errorText = await res.text().catch(() => "");
        // R2.2.13. What stood here was
        //
        //     if (res.status === 429 || res.status >= 500) { ...retry... }
        //     throw err;
        //
        // and the throw landed in this loop's own `catch`, which backed off and
        // went round again regardless. The guard decided nothing: measured on
        // this file, a 401 cost 3 calls and 3013ms — identical in count and
        // timing to a genuine upstream outage, so the one failure an operator
        // can fix was indistinguishable from vendor flakiness.
        //
        // The status is now classified ONCE, here, where the response is still
        // in hand, and the verdict rides on the error for the catch to read.
        // Shared with src/lib/engines/perplexity.js via httpFailureKind.js so
        // the two adapters cannot disagree about whether a 403 is worth a retry.
        throw Object.assign(tagHttpFailure(new Error(`OpenAI HTTP ${res.status}: ${sanitizeProviderText(errorText)}`), res.status), {
          provider_failure: classifyProviderFailure({provider:'openai',status:res.status,headers:res.headers,body:errorText}),
        });
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

      // Tokens x rate, keyed on the model that was ACTUALLY sent, plus the
      // per-call web_search fee priced in the same table. The Responses API
      // names its counters input_tokens/output_tokens, so they are passed
      // explicitly rather than handing resolveCost a usage block it would read
      // with Chat Completions field names and find empty.
      //
      // `usage` absent entirely is NOT priced as zero tokens: a priced model
      // that consumed nothing and a gateway that never said what it consumed
      // are different facts, and resolveCost throws unmeasured_tokens for the
      // second. The answer still comes back — it was paid for, and discarding
      // it would lose a measurement to protect a number — but its cost is null
      // with a reason, never 0.
      let cost = null;
      let costSource = null;
      let costState = COST_STATE.MEASURED;
      let costStateDetail = null;
      try {
        const tokenCost = resolveCost({
          model,
          provider: OPENAI_PROVIDER,
          promptTokens: resJson.usage?.input_tokens,
          completionTokens: resJson.usage?.output_tokens,
        });
        cost = tokenCost.cost + toolFee.cost;
        costSource =
          tokenCost.cost_source === toolFee.cost_source
            ? tokenCost.cost_source
            : `${tokenCost.cost_source}+${toolFee.cost_source}`;
      } catch (e) {
        if (!isUnpricedModel(e)) throw e;
        costState =
          e.reason === "unmeasured_tokens" ? COST_STATE.UNMEASURED_TOKENS : COST_STATE.UNPRICED;
        costStateDetail = e.message;
        console.error(`[chatgpt] cost not measurable for model "${model}": ${e.message}`);
      }

      if (stats) {
        if (cost === null) {
          noteUnmeasuredCost(stats);
        } else {
          stats.cost = (stats.cost || 0) + cost;
        }
        if (resJson.usage) {
          stats.tokens =
            (stats.tokens || 0) +
            (resJson.usage.input_tokens || 0) +
            (resJson.usage.output_tokens || 0);
        }
      }

      return {
        text,
        citations: [...citationUrls],
        references,
        cost,
        cost_source: costSource,
        cost_state: costState,
        cost_state_detail: costStateDetail,
        model: resJson?.model || model,
        requested_model: model,
        returned_model: resJson?.model || null,
        provider_request_id: resJson?.id || null,
        search_requests: 1,
        usage: resJson?.usage || null,
        error: null,
      };
    } catch (e) {
      lastErr = e;
      // Permanent: OpenAI understood the request and refused it. Leaving the
      // loop on the first response is the whole fix — two more calls and three
      // more seconds buy the same refusal, and the transport-noise default in
      // failureKindOf keeps an unrecognisable failure retryable.
      if (!isRetryableFailure(e)) break;
      if (attempt < maxRetries) {
        await delay(1000 * Math.pow(2, attempt));
      }
    } finally { clearTimeout(timeoutId); }
  }

  const kind = failureKindOf(lastErr);
  // The attempt count is COUNTED, not inferred from MAX_RETRIES: "refused on
  // the first call" and "retried to exhaustion" are different operator stories
  // and must not print the same sentence.
  const spent = `${attempts} call${attempts === 1 ? "" : "s"}`;
  console.error(
    `[chatgpt] probe failed after ${spent} [${kind}${
      kind === FAILURE_KIND.PERMANENT
        ? ", not retried — check OPENAI_API_KEY / request shape"
        : ""
    }]: ${lastErr?.message || lastErr}`
  );
  // cost: null, not 0. A probe that never got a completion has no priced call
  // to report; OpenAI may still have billed the attempts, and claiming a
  // measured $0 for them is the fabrication this task exists to remove.
  return { ...unpricedOutcome(
    stats,
    COST_STATE.PROBE_FAILED,
    `no completion was returned after ${spent}, so nothing could be priced`,
    sanitizeProviderText(lastErr?.message) || "ChatGPT probe failed"
  ), provider_failure: lastErr?.provider_failure || classifyProviderFailure({provider:"openai",error:lastErr}) };
}
