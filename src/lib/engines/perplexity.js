import { classifyProviderFailure, sanitizeProviderText } from './providerFailure.js';
import { normalizeUrl } from "../scoring/citations.js";
// `export ... from` below re-exports these for callers; this import is what
// makes them usable INSIDE this module.
import {
  FAILURE_KIND,
  failureKindOf,
  isRetryableFailure,
  tagHttpFailure,
} from "./httpFailureKind.js";
import {
  isUnpricedModel,
  resolveCost,
  resolveToolFee,
  MODEL_PRICES_ENV,
  TOOL_FEES_ENV,
} from "../llmPricing.js";
import { isOpenRouterEngineConfigured, probeOpenRouterEngine } from "./openRouterProbe.js";

const PERPLEXITY_CHAT_URL = "https://api.perplexity.ai/chat/completions";
const PERPLEXITY_SEARCH_URL = "https://api.perplexity.ai/search";
const MAX_RETRIES = 2;
const TIMEOUT_MS = 45000;
const RETRY_BASE_DELAY_MS = 1000;

/** Gateway name for llmPricing's error messages. Does not echo USD spend. */
export const PERPLEXITY_PROVIDER = "perplexity";

/** Used when PERPLEXITY_MODEL is unset. */
export const DEFAULT_PERPLEXITY_MODEL = "sonar";

/**
 * The /search leg is billed per REQUEST, not per token, so it is priced through
 * llmPricing's per-call tool-fee table rather than its per-token one. This is
 * the tool name that table is keyed by, e.g.
 * `LLM_TOOL_FEES={"sonar":{"search":0.005}}`.
 */
export const PERPLEXITY_SEARCH_TOOL = "search";

/**
 * The model id this probe will actually send.
 *
 * Read PER CALL, not once at module load (R3.6.6's lesson, applied here by
 * R3.6.5): the id is env-overridable and the price is keyed on it, so a
 * module-level snapshot would let a process price one model while calling
 * another — the same lie, harder to see.
 */
export function getPerplexityModel(env = process.env) {
  return String(env?.PERPLEXITY_MODEL || "").trim() || DEFAULT_PERPLEXITY_MODEL;
}

/**
 * Why `cost` is what it is — a MEASUREMENT or the absence of one (R3.6.5,
 * standing rules 1 and 3). `cost` is a number ONLY in the `measured` state;
 * every other state carries `cost: null`, never 0.
 *
 * Duplicated from src/lib/engines/openai.js and src/lib/gemini.js; see the note
 * on the copy in src/lib/gemini.js for why, and
 * src/lib/engines/costStateVocabulary.test.mjs for the guard that stops the
 * three drifting apart.
 */
export const COST_STATE = Object.freeze({
  /** Priced from llmPricing, keyed on the model id actually sent. */
  MEASURED: "measured",
  /** No native Perplexity key or shared OpenRouter key: no request was made. */
  NOT_CONFIGURED: "not_configured",
  /** The leg never succeeded, so there is no call to price. */
  PROBE_FAILED: "probe_failed",
  /** PERPLEXITY_MODEL (or its /search per-call fee) is absent from the price table. */
  UNPRICED: "unpriced",
  /** The model is priced, but Perplexity returned no usable token counts. */
  UNMEASURED_TOKENS: "unmeasured_tokens",
});

/**
 * Which of two non-measured states an operator should be told about first, when
 * the two legs disagree. Highest wins. A missing key outranks everything (one
 * fix cures the whole scan); a dead leg outranks a pricing gap (the answer is
 * the thing that was lost); an unpriced model outranks unmeasured tokens (you
 * cannot want token counts for a model you have no rate for).
 */
const COST_STATE_SEVERITY = Object.freeze({
  [COST_STATE.MEASURED]: 0,
  [COST_STATE.UNMEASURED_TOKENS]: 1,
  [COST_STATE.UNPRICED]: 2,
  [COST_STATE.PROBE_FAILED]: 3,
  [COST_STATE.NOT_CONFIGURED]: 4,
});

/**
 * Record that this probe produced no cost number. Same field as
 * src/lib/engines/openai.js's, so one accumulator serves every engine: leaving
 * `stats.cost` alone is right (adding 0 would fabricate a measurement) but a
 * scan where nothing could be priced must not read as a scan that was free.
 */
function noteUnmeasuredCost(stats) {
  if (!stats) return;
  stats.cost_unmeasured_calls = (stats.cost_unmeasured_calls || 0) + 1;
}

/**
 * A USD figure Perplexity actually REPORTED, or null when it did not.
 *
 * Perplexity nests real spend at `usage.cost.total_cost` on the plans that
 * return it and has also shipped a flat `usage.total_cost`; both are accepted,
 * and so is a bare numeric `usage.cost` for symmetry with every other
 * OpenAI-compatible gateway. Deliberately not `Number(x) || fallback`: that is
 * the exact shape (`?? 0.005`) this function replaces, in which undefined, null
 * and "" all became a number nobody measured.
 */
function reportedUsdCost(usage) {
  for (const candidate of [usage?.cost?.total_cost, usage?.total_cost, usage?.cost]) {
    if (typeof candidate === "number" && Number.isFinite(candidate) && candidate >= 0) {
      return candidate;
    }
    if (typeof candidate === "string" && candidate.trim() !== "") {
      const n = Number(candidate);
      if (Number.isFinite(n) && n >= 0) return n;
    }
  }
  return null;
}

/**
 * Whether a failed Perplexity call is worth trying again (R2.2.10).
 *
 * The classification itself moved to src/lib/engines/httpFailureKind.js in
 * R2.2.13, when src/lib/engines/openai.js turned out to carry the identical
 * dead guard and needed the identical verdict. Re-exported here, unchanged and
 * by reference, so every existing importer of these names keeps working and
 * there is still exactly ONE definition of "is a 403 worth retrying" in the
 * codebase. Do not re-declare them here; see that module's header for the
 * policy and why an unreadable status defaults to transient.
 */
export {
  FAILURE_KIND,
  classifyHttpStatus,
  failureKindOf,
  isRetryableFailure,
} from "./httpFailureKind.js";

function httpError(leg, status, bodyText) {
  return tagHttpFailure(new Error(`Perplexity ${leg} HTTP ${status}: ${bodyText}`), status);
}

/**
 * Whether this probe's `citations` array is a MEASUREMENT or an absence of one
 * (R2.2.2, finding B2).
 *
 * A Perplexity probe is two independent calls: /chat/completions produces the
 * answer, /search produces the citation list. They fail independently. Before
 * this vocabulary existed, a dead /search leg returned `citations: []` and
 * `error: null` — byte-identical to a healthy /search that genuinely found
 * nothing to cite. "We asked and there were none" and "we could not ask" were
 * the same value, so every citation-share denominator downstream counted the
 * outage as a confirmed zero for the brand.
 *
 *   verified   — the /search leg answered. `citations` is a real measurement,
 *                including a genuine empty array.
 *   unverified — the /search leg never answered. `citations` is `[]` because
 *                there is nothing to put there, NOT because there were none.
 *                Excluded from citation-share denominators.
 *
 * Naming matches the `state` / `state_reason` pair the repo already uses for
 * degradable subsystems (SCRAPE_STATE in src/lib/firecrawl.js, SHARE_STATE in
 * src/components/perceev/charts/shareOfVoice.js), so a row can carry an engine
 * `state` and a `citations_state` without the two vocabularies colliding.
 */
export const CITATIONS_STATE = Object.freeze({
  VERIFIED: "verified",
  UNVERIFIED: "unverified",
});

/** Why `citations_state` is not `verified`. Machine tokens; detail carries prose. */
export const CITATIONS_STATE_REASON = Object.freeze({
  /** /search errored or timed out through every retry. The answer leg may be fine. */
  SEARCH_LEG_FAILED: "search_leg_failed",
  /**
   * /search was REFUSED — 401/403/4xx — so it was not retried (R2.2.10).
   *
   * Same `unverified` state as SEARCH_LEG_FAILED, because in both cases the
   * citation list was not observed and must stay out of a citation-share
   * denominator. Split from it because the operator response differs: this one
   * is a configuration fault that will repeat on every prompt of every scan
   * until a human fixes the key, not a vendor blip that may clear on its own.
   */
  SEARCH_LEG_REJECTED: "search_leg_rejected",
  /** No native Perplexity key or shared OpenRouter key, so no request was made. */
  NOT_CONFIGURED: "perplexity_not_configured",
  /** Shared OpenRouter call succeeded, but the model did not use web search or return sources. */
  SEARCH_NOT_USED: "web_search_not_used",
});

const MAX_DETAIL_CHARS = 200;

/**
 * True when this row's citation list must NOT enter a citation-share
 * denominator: we did not observe the citations, so the row is evidence of
 * nothing either way.
 *
 * Deliberately a POSITIVE test for the unverified state rather than a
 * "is it measured?" predicate with a default. Rows from single-leg engines
 * carry no unverified marker — `citations_state` is null on a ChatGPT row and
 * absent entirely on an AIO one, since those engines return their citations on
 * the same call as their answer and have no separate leg to lose — and a
 * default would have to guess which way to read that. Asking "was this
 * explicitly marked unverified?" needs no guess and can never quietly exclude a
 * real measurement.
 *
 * THE CALLER THAT MATTERS is summarizeEngineSlice in
 * src/lib/scoring/enginePipeline.js, which builds the citation-share pool with
 * it. R2.2.2 was rejected once for having this predicate with no production
 * caller and no field on the row for it to read.
 *
 * @param {{citations_state?: string}|null|undefined} row a probe result or a
 *        persisted result row.
 */
export function hasUnverifiedCitations(row) {
  return row?.citations_state === CITATIONS_STATE.UNVERIFIED;
}

export function isPerplexityConfigured() {
  return !!process.env.PERPLEXITY_API_KEY || isOpenRouterEngineConfigured("perplexity");
}

function detailOf(value) {
  const text = String(value ?? "");
  return text.slice(0, MAX_DETAIL_CHARS) || null;
}

function delay(ms) {
  return new Promise((res) => setTimeout(res, ms));
}

async function perplexityFetch(url, body, apiKey, options = {}) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), Math.max(1,Math.min(TIMEOUT_MS,options.deadlineAt == null ? TIMEOUT_MS : options.deadlineAt-Date.now())));

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
    // Consume the body while its abort timer is still armed.
    if (res.ok) {
      const data = await res.json();
      return { ok:res.ok,status:res.status,headers:res.headers,json:async()=>data };
    }
    const bodyText = await res.text();
    return {ok:res.ok,status:res.status,headers:res.headers,text:async()=>bodyText};
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Run one leg with the retry POLICY applied, not a retry reflex (R2.2.10).
 *
 * The classification decides; there is no status test inline here and none in
 * either caller. A permanent failure leaves the loop on the first response, so
 * the call count for a 401 is 1 and not 3. Whatever finally failed is rethrown
 * with its `failureKind` intact so the caller can report the KIND, not just the
 * message.
 *
 * @param {string} leg "answer" | "search", for the failure message.
 * @param {() => Promise<any>} run one attempt.
 */
async function withRetry(leg, run, options = {}) {
  let lastErr = null;

  const maxRetries = options.durableDispatch ? 0 : MAX_RETRIES;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await run();
    } catch (e) {
      lastErr = e;
      // Permanent: the vendor already answered the question. Stop here rather
      // than spend two more calls and three seconds to be refused twice more.
      if (!isRetryableFailure(e)) break;
      if (attempt < maxRetries) {
        await delay(RETRY_BASE_DELAY_MS * Math.pow(2, attempt));
      }
    }
  }

  throw lastErr ?? new Error(`Perplexity ${leg} probe failed`);
}

async function probeAnswer(query, apiKey, model, options = {}) {
  try {
    return await withRetry("answer", async () => {
      const res = await perplexityFetch(
        PERPLEXITY_CHAT_URL,
        {
          model,
          messages: [{ role: "user", content: query }],
          web_search_options: { user_location: { country: "IN" } },
        },
        apiKey, options
      );

      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        throw Object.assign(httpError("answer",res.status,sanitizeProviderText(errText)),{ provider_failure:classifyProviderFailure({provider:"perplexity",status:res.status,headers:res.headers,body:errText}) });
      }

      const resJson = await res.json();
      const text = resJson.choices?.[0]?.message?.content || "";

      // PRICING (R3.6.5). The line this replaces was
      //
      //     const cost = resJson.usage?.cost?.total_cost
      //               ?? resJson.usage?.total_cost ?? 0.005;
      //
      // and that trailing literal is the whole finding: on every response
      // without a `usage` block — which is every response on the plans that do
      // not itemise spend — the probe reported a number nobody had measured,
      // in the same field, with the same type, as one Perplexity had actually
      // billed. It then accumulated into `stats.cost` and became `cost_total`
      // on the scan row. A guess wearing the costume of a measurement is worse
      // than a null, because it survives inspection.
      //
      // Now: a REPORTED figure is `gateway` spend; failing that, tokens x a
      // declared rate is `price_table`; failing that there is no cost, only
      // `cost: null` and a state saying which (standing rule 3). The answer
      // text is still returned either way — it is the measurement the scan
      // exists for, and throwing it away to protect a cost field would trade
      // the finding for the footnote.
      const usage = resJson.usage || null;
      const reported = reportedUsdCost(usage);
      let cost = null;
      let costSource = null;
      let costState = COST_STATE.MEASURED;
      let costStateDetail = null;
      try {
        const priced = resolveCost({
          model,
          provider: PERPLEXITY_PROVIDER,
          // `cost` normalised to the flat numeric field resolveCost reads;
          // undefined (not 0) when nothing was reported, so an absent figure
          // cannot be mistaken for a measured zero.
          usage: { ...(usage || {}), cost: reported === null ? undefined : reported },
        });
        cost = priced.cost;
        costSource = priced.cost_source;
      } catch (e) {
        if (!isUnpricedModel(e)) throw e;
        costState =
          e.reason === "unmeasured_tokens" ? COST_STATE.UNMEASURED_TOKENS : COST_STATE.UNPRICED;
        costStateDetail = e.message;
        console.error(
          `[perplexity] answer-leg cost not measurable for model "${model}": ${e.message} ` +
            `Declare a rate in ${MODEL_PRICES_ENV} to price it.`
        );
      }

      return {
        text: text.trim(),
        cost,
        cost_source: costSource,
        cost_state: costState,
        cost_state_detail: costStateDetail,
        error: null,
        error_kind: null,
        usage,
      };
    }, options);
  } catch (e) {
    return {
      text: "",
      // null, not 0. The call never returned a completion, so there is nothing
      // to price; Perplexity may well have billed the attempts, and claiming a
      // measured $0 for them is the fabrication this task removes.
      cost: null,
      cost_source: null,
      cost_state: COST_STATE.PROBE_FAILED,
      cost_state_detail: e?.message || "Perplexity answer probe failed",
      error: e?.message || "Perplexity answer probe failed",
      error_kind: failureKindOf(e),
      provider_failure: e.provider_failure || classifyProviderFailure({provider:"perplexity",error:e}),
      usage: null,
    };
  }
}

async function probeSearch(query, apiKey, model, options = {}) {
  try {
    return await withRetry("search", async () => {
      const res = await perplexityFetch(
        PERPLEXITY_SEARCH_URL,
        { query, max_results: 10 },
        apiKey, options
      );

      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        throw Object.assign(httpError("search",res.status,sanitizeProviderText(errText)),{ provider_failure:classifyProviderFailure({provider:"perplexity",status:res.status,headers:res.headers,body:errText}) });
      }

      const resJson = await res.json();
      const results = resJson.results || [];

      const references = results.map((r) => ({
        href: r.url || "",
        title: r.title || "",
        source: r.title || "",
      }));

      const citations = [...new Set(references.map((r) => normalizeUrl(r.href)).filter(Boolean))];

      // PRICING (R3.6.5). This leg used to return the literal `cost: 0.005` on
      // every successful call — not a fallback for a missing figure but an
      // invention with nothing behind it at all, since /search returns no usage
      // block to fall back FROM. Two of those literals summed to the $0.01 a
      // probe with no vendor accounting reported as spend.
      //
      // /search is billed per REQUEST, so it is priced through llmPricing's
      // per-call tool-fee table, not its per-token one: the two units must never
      // share a table. With no fee declared there is no cost — `cost: null` and
      // a state — rather than a plausible number.
      let cost = null;
      let costSource = null;
      let costState = COST_STATE.MEASURED;
      let costStateDetail = null;
      try {
        const fee = resolveToolFee({
          model,
          tool: PERPLEXITY_SEARCH_TOOL,
          provider: PERPLEXITY_PROVIDER,
        });
        cost = fee.cost;
        costSource = fee.cost_source;
      } catch (e) {
        if (!isUnpricedModel(e)) throw e;
        costState = COST_STATE.UNPRICED;
        costStateDetail = e.message;
        console.error(
          `[perplexity] search-leg cost not measurable for model "${model}": ${e.message} ` +
            `Declare it in ${TOOL_FEES_ENV}, e.g. {"${model}":{"${PERPLEXITY_SEARCH_TOOL}":0.005}}.`
        );
      }

      return {
        references,
        citations,
        cost,
        cost_source: costSource,
        cost_state: costState,
        cost_state_detail: costStateDetail,
        error: null,
        error_kind: null,
      };
    }, options);
  } catch (e) {
    return {
      references: [],
      citations: [],
      // null, not 0: no request succeeded, so no per-call fee was earned by a
      // measurement. See the answer leg's catch.
      cost: null,
      cost_source: null,
      cost_state: COST_STATE.PROBE_FAILED,
      cost_state_detail: e?.message || "Perplexity search probe failed",
      error: e?.message || "Perplexity search probe failed",
      error_kind: failureKindOf(e),
      provider_failure: e.provider_failure || classifyProviderFailure({provider:"perplexity",error:e}),
    };
  }
}

/**
 * Fold the two legs' cost verdicts into the one the envelope carries (R3.6.5).
 *
 * The rule is deliberately unforgiving: a total is a number only when EVERY leg
 * produced one. Summing the measured legs and shipping the result as `cost`
 * would report a probe as cheaper than it was, in a field indistinguishable from
 * an honest total — the same class of lie as the `?? 0.005` this replaces, just
 * quieter. Callers that want the surviving half can read the per-leg breakdown
 * in `cost_state_detail`.
 *
 * @param {{cost: number|null, cost_source: string|null, cost_state: string,
 *          cost_state_detail: string|null}} answer
 * @param {{cost: number|null, cost_source: string|null, cost_state: string,
 *          cost_state_detail: string|null}} search
 */
function combineCostStates(answer, search) {
  const legs = [
    ["answer", answer],
    ["search", search],
  ];

  // The test is `cost_state !== measured`, NOT `cost === null`. Those are the
  // same thing only while every leg upholds the invariant, and this function is
  // the last place that can notice one that does not — a leg that carries both a
  // number and a non-measured verdict is a fabrication that has already happened,
  // and summing it would launder it into the total. Belt and braces on both.
  const isMeasured = (leg) => leg.cost_state === COST_STATE.MEASURED && typeof leg.cost === "number";
  const unmeasured = legs.filter(([, leg]) => !isMeasured(leg));
  if (unmeasured.length === 0) {
    const sources = [...new Set(legs.map(([, leg]) => leg.cost_source).filter(Boolean))];
    return {
      cost: answer.cost + search.cost,
      cost_source: sources.length === 1 ? sources[0] : sources.sort().join("+") || null,
      cost_state: COST_STATE.MEASURED,
      cost_state_detail: null,
    };
  }

  // Report the leg whose failure an operator should act on first, and name both
  // in the detail so neither is hidden behind the other.
  const worst = unmeasured.reduce((a, b) =>
    (COST_STATE_SEVERITY[b[1].cost_state] ?? 0) > (COST_STATE_SEVERITY[a[1].cost_state] ?? 0) ? b : a
  );
  const detail = legs
    .map(([name, leg]) =>
      isMeasured(leg)
        ? `${name}: measured ${leg.cost}`
        : `${name}: ${leg.cost_state}${leg.cost_state_detail ? ` — ${leg.cost_state_detail}` : ""}`
    )
    .join(" | ");

  return {
    cost: null,
    cost_source: null,
    cost_state: worst[1].cost_state,
    cost_state_detail: detail,
  };
}

/**
 * Probe Perplexity: one answer call, one citation call, reported separately.
 *
 * The two legs fail independently, so the envelope reports them independently.
 * `error` remains the ANSWER leg's error — a dead /search does not invalidate a
 * real answer, and promoting it to `error` would throw away a genuine mention
 * measurement. What a dead /search does invalidate is the citation list, and
 * that is what `citations_state` says (R2.2.2, finding B2).
 *
 * `error_kind` (R2.2.10) says whether that `error` is worth retrying at a higher
 * level or is a configuration fault that will repeat identically on every
 * remaining prompt. It is null exactly when `error` is null.
 *
 * HONEST LIMIT of `error_kind`: probeTextEngine in enginePipeline.js copies a
 * fixed list of fields off this envelope, and `error_kind` is not yet on that
 * list, so today it reaches this module's own log line and any direct caller,
 * not the persisted row. Carrying it onto the row is a follow-up on that file
 * (owned elsewhere while R2.2.10 was built). The one failure-kind signal that
 * DOES survive the hop is `citations_state_reason`, which is already copied —
 * hence SEARCH_LEG_REJECTED below.
 *
 * COST (R3.6.5). `cost` is a number ONLY when `cost_state === "measured"`, which
 * requires BOTH legs to have been priced. A partial sum is not a cheaper probe,
 * it is an understated one, and an understated number presented in the same
 * field as a real one is the defect this task exists to remove — so a probe with
 * any unpriced or failed leg reports `cost: null` and says which leg in
 * `cost_state_detail`. Nothing is added to `options.stats.cost` in that case;
 * `options.stats.cost_unmeasured_calls` is incremented instead, so a scan that
 * measured nothing cannot be read as a scan that cost nothing.
 *
 * @returns {Promise<{text: string, citations: string[], references: object[],
 *          cost: number|null, cost_source: string|null, cost_state: string,
 *          cost_state_detail: string|null, error: string|null,
 *          error_kind: string|null, citations_state: string,
 *          citations_state_reason: string|null,
 *          citations_state_detail: string|null}>}
 */
export async function probePerplexity(query, options = {}) {
  const apiKey = process.env.PERPLEXITY_API_KEY;
  if (!apiKey) {
    if (isOpenRouterEngineConfigured("perplexity")) {
      const result = await probeOpenRouterEngine({
        engine: "perplexity",
        query,
        stats: options.stats,
        durableDispatch: options.durableDispatch, deadlineAt: options.deadlineAt,
      });
      const searchObserved = result.search_requests > 0 || result.references.length > 0;
      const citationsState = searchObserved
        ? {
            citations_state: CITATIONS_STATE.VERIFIED,
            citations_state_reason: null,
            citations_state_detail: null,
          }
        : {
            citations_state: CITATIONS_STATE.UNVERIFIED,
            citations_state_reason: CITATIONS_STATE_REASON.SEARCH_NOT_USED,
            citations_state_detail: "OpenRouter returned no web-search activity or citation references",
          };
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
        ...citationsState,
      };
    }
    console.warn("[perplexity] no PERPLEXITY_API_KEY or shared OpenRouter LLM_API_KEY — skipping");
    noteUnmeasuredCost(options.stats);
    return {
      text: "",
      citations: [],
      references: [],
      // Nothing was called, so nothing was spent OR measured. `0` here made an
      // unconfigured deployment's scan indistinguishable from a free one.
      cost: null,
      cost_source: null,
      cost_state: COST_STATE.NOT_CONFIGURED,
      cost_state_detail: "No PERPLEXITY_API_KEY or shared OpenRouter LLM_API_KEY is set, so no request was made",
      error: "PERPLEXITY_API_KEY or shared OpenRouter LLM_API_KEY not set",
      // A missing key is a config fault, not a blip: nothing will change until
      // a human sets it.
      error_kind: FAILURE_KIND.PERMANENT,
      // Nothing was asked, so the empty citation list is not a finding of
      // "no citations" either.
      citations_state: CITATIONS_STATE.UNVERIFIED,
      citations_state_reason: CITATIONS_STATE_REASON.NOT_CONFIGURED,
      citations_state_detail: null,
    };
  }

  const model = getPerplexityModel();

  const [answer, search] = await Promise.all([
    probeAnswer(query, apiKey, model, options),
    probeSearch(query, apiKey, model, options),
  ]);

  // The two legs are priced independently and can disagree. `cost` is a sum
  // ONLY when both were measured; otherwise it is null and the detail names the
  // leg that could not be priced, so a partial sum never leaves this function
  // wearing the type of a total.
  const costState = combineCostStates(answer, search);

  const citationsState = search.error
    ? {
        citations_state: CITATIONS_STATE.UNVERIFIED,
        // Refused vs. died: same unverified list, different operator action.
        citations_state_reason:
          search.error_kind === FAILURE_KIND.PERMANENT
            ? CITATIONS_STATE_REASON.SEARCH_LEG_REJECTED
            : CITATIONS_STATE_REASON.SEARCH_LEG_FAILED,
        citations_state_detail: detailOf(search.error),
      }
    : {
        citations_state: CITATIONS_STATE.VERIFIED,
        citations_state_reason: null,
        citations_state_detail: null,
      };

  // If answer failed entirely, return error
  if (answer.error && !answer.text) {
    // The old line here claimed BOTH legs failed whenever the answer leg did.
    // Say which one actually died: /search may well have returned citations.
    console.error(
      `[perplexity] Answer leg failed for query: "${query}" — ${answer.error} ` +
        `[${answer.error_kind}${
          answer.error_kind === FAILURE_KIND.PERMANENT
            ? ", not retried — check PERPLEXITY_API_KEY / request shape"
            : `, retried ${options.durableDispatch ? 1 : MAX_RETRIES + 1}x`
        }] ` +
        `(citations ${citationsState.citations_state}` +
        `${citationsState.citations_state_reason ? `: ${citationsState.citations_state_reason}` : ""})`
    );
    if (options.stats && costState.cost === null) noteUnmeasuredCost(options.stats);
    return {
      text: "",
      citations: search.citations,
      references: search.references,
      ...costState,
      error: answer.error,
      error_kind: answer.error_kind,
      provider_failure: answer.provider_failure,
      ...citationsState,
    };
  }

  if (search.error) {
    // The answer survived, so this row is kept and scored for mentions. Its
    // citation list is NOT a zero — say so here rather than let a silent []
    // reach a denominator.
    console.warn(
      `[perplexity] Citation leg failed for query: "${query}" — ${search.error} ` +
        `[${search.error_kind}]. ` +
        `Answer kept; citations marked ${CITATIONS_STATE.UNVERIFIED} ` +
        `(${citationsState.citations_state_reason}), not zero.`
    );
  }

  if (options.stats) {
    // Only a measured total accrues. Adding a null as 0 would put "we could not
    // price this" and "this was free" into the same running total; the counter
    // is what keeps them apart (standing rule 1).
    if (costState.cost === null) {
      noteUnmeasuredCost(options.stats);
    } else {
      options.stats.cost = (options.stats.cost || 0) + costState.cost;
    }
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
    model: model,
    requested_model: model,
    returned_model: model,
    search_requests: search.error ? 0 : 1,
    usage: answer.usage || null,
    ...costState,
    error: null,
    error_kind: null,
    provider_failure: search.provider_failure || null,
    ...citationsState,
  };
}
