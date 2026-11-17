import { GoogleGenerativeAI } from "@google/generative-ai";
import { isUnpricedModel, resolveCost, MODEL_PRICES_ENV } from "./llmPricing.js";

/**
 * Gateway name for llmPricing's error messages. Google does not echo USD spend
 * on the generateContent response, so a cost here can only ever come from the
 * price table — never from the gateway.
 */
export const GEMINI_PROVIDER = "google";

/**
 * Why `cost` is what it is — a MEASUREMENT or the absence of one (R3.6.5,
 * standing rules 1 and 3). `cost` is a number ONLY in the `measured` state;
 * every other state carries `cost: null`, never 0.
 *
 * THREE COPIES OF THIS VOCABULARY EXIST and they must not drift: here,
 * src/shared/engines/openai.js (R3.6.6, the original) and
 * src/shared/engines/perplexity.js (R3.6.5). They are duplicated rather than
 * shared because the natural home is src/shared/llmPricing.js and that file was
 * owned by another task while this one was built; hoisting it there is a
 * follow-up. Until then src/shared/engines/costStateVocabulary.test.mjs asserts
 * all three are deep-equal, so a divergent edit fails the suite.
 */
export const COST_STATE = Object.freeze({
  /** Priced from llmPricing, keyed on the model id that actually answered. */
  MEASURED: "measured",
  /** No GEMINI_API_KEY: nothing was called, so nothing was spent OR measured. */
  NOT_CONFIGURED: "not_configured",
  /** No rung of the model ladder returned a completion, so nothing can be priced. */
  PROBE_FAILED: "probe_failed",
  /** The model that answered has no rate in the price table. */
  UNPRICED: "unpriced",
  /** The model has a rate, but Gemini returned no usable token counts. */
  UNMEASURED_TOKENS: "unmeasured_tokens",
});

/**
 * Record that this call produced no cost number.
 *
 * Leaving `stats.cost` untouched is correct — adding 0 would fabricate a
 * measurement — but a run in which every call was unpriced would then be
 * indistinguishable from a run that was genuinely free. This counter is the
 * difference between a measured zero and a never-measured one (standing rule 1).
 * Same field name as src/shared/engines/openai.js's, so one accumulator serves
 * every engine.
 */
function noteUnmeasuredCost(stats) {
  if (!stats) return;
  stats.cost_unmeasured_calls = (stats.cost_unmeasured_calls || 0) + 1;
}

/**
 * The shape returned when there is no completion to price: a missing key, or a
 * ladder that failed on every rung.
 *
 * `cost: null`, never 0. Before R3.6.5 this returned the bare pair
 * `{ text: "", model_used: "" }` and its one adapter turned the absent cost into
 * `res.cost || 0.0` — so a Gemini outage and a free successful answer were the
 * same two numbers. The state field is what makes them different facts.
 */
function noCompletion(stats, state, detail) {
  noteUnmeasuredCost(stats);
  return {
    text: "",
    model_used: "",
    tokens: null,
    cost: null,
    cost_source: null,
    cost_state: state,
    cost_state_detail: detail,
  };
}

export async function generateContent(prompt, options = {}, retries = 2) {
  const stats = options.stats;
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error("GEMINI_API_KEY is not configured.");
    return noCompletion(
      stats,
      COST_STATE.NOT_CONFIGURED,
      "GEMINI_API_KEY is not set, so no request was made and no cost exists to report"
    );
  }

  const genAI = new GoogleGenerativeAI(apiKey);

  const MODEL_FALLBACKS = [
    "gemini-2.5-flash-lite",
    "gemini-flash-lite-latest",
    "gemini-3.1-flash-lite",
    "gemini-2.5-flash",
    "gemini-3-flash-preview",
  ];

  const modelConfig = { generationConfig: {} };
  if (options.jsonMode) {
    modelConfig.generationConfig.responseMimeType = "application/json";
    modelConfig.generationConfig.temperature = 0.1;
  }
  if (options.temperature !== undefined) {
    modelConfig.generationConfig.temperature = options.temperature;
  }

  const wait = (ms) => new Promise(res => setTimeout(res, ms));
  let lastErr = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    for (const modelName of MODEL_FALLBACKS) {
      const timeoutMs = options.timeout || 20000;
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
      let raceTimeoutId = null;

      try {
        const model = genAI.getGenerativeModel({
          model: modelName,
          ...modelConfig
        });

        // R6.5.6 (finding A1): requestOptions is the SDK's SECOND ARGUMENT, not a
        // field on it. `{ requestOptions }` hid the signal from buildFetchOptions,
        // so the fetch init had no `signal` and the controller was inert — the
        // request was abandoned by Promise.race, never cancelled. Pinned by
        // src/shared/geminiAbort.test.mjs; do not re-wrap this.
        //
        // No `timeout` here on purpose: the SDK's timeout branch schedules its own
        // setTimeout(abort) that it never clears, so it would strand one timer per
        // rung for the full deadline — the same leak, moved. The controller above
        // is the deadline, and the finally block does clear it.
        const requestOptions = { signal: controller.signal };
        const resultPromise = model.generateContent(prompt, requestOptions);

        const result = await Promise.race([
          resultPromise,
          new Promise((_, reject) => {
            raceTimeoutId = setTimeout(() => reject(new Error("Gemini timeout")), timeoutMs);
          })
        ]);

        const response = await result.response;

        // PRICING (R3.6.5). What used to live here was:
        //
        //     let cost = 0.0;
        //     if (response.usageMetadata) {
        //       cost = (promptTokens * 0.075 / 1e6) + (candidatesTokens * 0.30 / 1e6);
        //     }
        //
        // Two fabrications in four lines. First, those two rates are hard-coded
        // and are not the list price of ANY id in MODEL_FALLBACKS — the ladder
        // spans flash-lite and flash tiers, whose real rates differ several-fold,
        // and whichever rung answered was billed at the same invented number.
        // Second, a response with no `usageMetadata` at all kept `cost = 0.0` and
        // returned it as if measured, so "Google did not say what this consumed"
        // and "this consumed nothing" were the same value in `stats.cost`.
        //
        // Both go through resolveCost now, keyed on the rung that actually
        // answered, which is the only id it could ever be true for. Nothing is
        // priced in this file: with no rate declared the call still returns its
        // text — the answer was paid for and discarding it to protect a number
        // would be the worse trade — but its cost is null with a reason
        // (standing rule 3: fails loud, never $0).
        //
        // Deliberately NOT a pre-flight refusal like src/shared/engines/openai.js's.
        // That adapter knows its one model id before the request; this ladder does
        // not know which of five rungs will answer until one does, so the only
        // honest gate is after the fact.
        let tokens = null;
        let cost = null;
        let costSource = null;
        let costState = COST_STATE.MEASURED;
        let costStateDetail = null;

        const usage = response.usageMetadata;
        if (usage) {
          const promptTokens = usage.promptTokenCount || 0;
          const candidatesTokens = usage.candidatesTokenCount || 0;
          tokens = usage.totalTokenCount || (promptTokens + candidatesTokens);
        }

        try {
          // `usage` absent means the counts were never REPORTED, so undefined is
          // passed rather than 0 — resolveCost distinguishes the two and throws
          // `unmeasured_tokens` for the first instead of pricing it as free.
          const priced = resolveCost({
            model: modelName,
            provider: GEMINI_PROVIDER,
            promptTokens: usage ? usage.promptTokenCount : undefined,
            completionTokens: usage ? usage.candidatesTokenCount : undefined,
          });
          cost = priced.cost;
          costSource = priced.cost_source;
        } catch (e) {
          if (!isUnpricedModel(e)) throw e;
          costState =
            e.reason === "unmeasured_tokens" ? COST_STATE.UNMEASURED_TOKENS : COST_STATE.UNPRICED;
          costStateDetail = e.message;
          console.error(
            `[gemini] cost not measurable for model "${modelName}": ${e.message} ` +
              `Declare a rate in ${MODEL_PRICES_ENV} to price this ladder.`
          );
        }

        if (stats) {
          if (tokens !== null) stats.tokens = (stats.tokens || 0) + tokens;
          if (cost === null) {
            noteUnmeasuredCost(stats);
          } else {
            stats.cost = (stats.cost || 0) + cost;
          }
        }

        return {
          text: response.text(),
          model_used: modelName,
          tokens,
          cost,
          cost_source: costSource,
          cost_state: costState,
          cost_state_detail: costStateDetail,
        };
      } catch (e) {
        lastErr = e;
        continue; // try next model
      } finally {
        // Retire THIS rung before the ladder advances. Clearing the deadlines is
        // what stops five models x three attempts stranding fifteen live timers.
        // The abort is belt-and-braces (today the deadline above fires at the
        // same instant the race gives up) but it is what makes clearing the
        // deadline safe: otherwise an in-flight rung would have nothing left to
        // stop it. No test kills this line on its own.
        clearTimeout(timeoutId);
        if (raceTimeoutId !== null) clearTimeout(raceTimeoutId);
        controller.abort();
      }
    }

    // Backoff before retrying the full model cascade
    if (attempt < retries) {
      const delay = 1000 * Math.pow(2, attempt);
      console.warn(`[gemini] Attempt ${attempt + 1} failed. Retrying in ${delay}ms...`);
      await wait(delay);
    }
  }

  console.error(`[scan] all models failed after ${retries} retries: ${lastErr}`);
  return noCompletion(
    stats,
    COST_STATE.PROBE_FAILED,
    `no rung of the model ladder returned a completion after ${retries} retries ` +
      `(last error: ${lastErr?.message || lastErr}), so nothing could be priced`
  );
}
