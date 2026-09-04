/**
 * Model price table for the utility/content LLM path (R3.6.1, findings C4/S18).
 *
 * THE BUG THIS REPLACES
 * --------------------
 * `generateContent` used to price a completion like this:
 *
 *     const cost = model.endsWith(":free") ? 0 : Number(data?.usage?.cost) || 0;
 *
 * Read the paid branch carefully. `Number(undefined) || 0` is `0`. Only
 * OpenRouter echoes `usage.cost`; MiMo — the gateway this deployment actually
 * talks to — does not, and neither does any `custom` OpenAI-compatible
 * gateway. So every paid completion on every non-OpenRouter gateway was
 * recorded as costing exactly nothing, and `docs/vendors/mimo.md` had to carry
 * a footnote begging readers not to believe the number. The content
 * pipeline's per-item cost cap (`CONTENT_MAX_COST_PER_ITEM`, enforced in
 * src/lib/content/contentWorker.js) compares real spend against a budget using
 * that value: a cap that can never trip is not a cap.
 *
 * Standing rule 3: an unpriced model id fails loud, never $0.
 *
 * THE CONTRACT
 * ------------
 * A cost is only ever produced from one of three NAMED sources, returned
 * alongside it as `cost_source` so a $0 that was measured never looks like a
 * $0 that was assumed (standing rule 1):
 *
 *   "gateway"      the gateway echoed a finite `usage.cost` — authoritative
 *                  actual spend, and it wins over every estimate below.
 *   "free_tier"    the model id ends in `:free`. The suffix is a pricing
 *                  claim, not decoration.
 *   "price_table"  computed from token counts and a per-million-token rate,
 *                  either built in below or declared in LLM_MODEL_PRICES.
 *
 * There is no fourth branch. A model id that matches none of them throws
 * `UnpricedModelError` — and throws BEFORE the request is sent whenever that
 * is knowable (see `assertModelPriceable`), so an unpriced deployment fails on
 * its first call instead of halfway through a scan it already paid for.
 */

/** USD-per-million-token rates, keyed by exact model id. */
const PRICES_PER_MTOK = Object.freeze({
  // Anthropic list price, $3 / $15 per million tokens, current 2026-09.
  // This is the default CONTENT_MODEL (src/lib/llm.js getContentModel), i.e.
  // the one id in this repo that is paid by default and therefore the one that
  // was silently costing $0 on MiMo.
  "anthropic/claude-sonnet-4.5": Object.freeze({ input: 3, output: 15 }),
});

/**
 * The built-in table, exported for tests and for the operator-facing error
 * message. Deliberately tiny: an entry here is a claim about a vendor's list
 * price, and a wrong claim is only marginally better than the $0 it replaces.
 * Prefer declaring rates in the environment (LLM_MODEL_PRICES) over guessing
 * one into this file.
 */
export const BUILT_IN_MODEL_PRICES = PRICES_PER_MTOK;

/**
 * Operator-declared rates, so switching gateway does not require a code
 * deploy. JSON object of `{ "<model id>": { "input": n, "output": n } }` in USD
 * per million tokens; a bare number means the same rate both ways.
 */
export const MODEL_PRICES_ENV = "LLM_MODEL_PRICES";

/**
 * Typed pricing failure.
 *
 * Sibling of LlmUnavailableError in intent: the caller must be forced to see
 * that no cost could be established, rather than inherit a plausible-looking
 * zero. `reason` discriminates the three ways that happens.
 */
export class UnpricedModelError extends Error {
  /**
   * @param {string} message
   * @param {{reason?: "unpriced_model"|"gateway_reported_no_cost"|"malformed_declaration",
   *          model?: string, provider?: string, cause?: unknown}} [meta]
   */
  constructor(message, meta = {}) {
    super(message);
    this.name = "UnpricedModelError";
    this.reason = meta.reason || "unpriced_model";
    this.model = meta.model || null;
    this.provider = meta.provider || null;
    if (meta.cause !== undefined) this.cause = meta.cause;
  }
}

/**
 * Matches by name as well as by instance, for the same reason
 * `isLlmUnavailable` does: Next.js can load a module twice (server bundle and
 * route bundle) and `instanceof` alone stops holding across that boundary.
 */
export function isUnpricedModel(err) {
  return Boolean(err) && (err instanceof UnpricedModelError || err.name === "UnpricedModelError");
}

/** A `:free` suffix is a pricing claim: this id costs nothing to call. */
export function isFreeModelId(model) {
  return String(model || "").endsWith(":free");
}

/**
 * Whether a gateway echoes real USD spend in `usage.cost`. Only OpenRouter
 * does, and only when the request asked for it (`usage: { include: true }`,
 * which src/lib/openrouter.js sends for paid ids). Everything else must be
 * priced from the table or refused.
 */
export function gatewayReportsCost(provider) {
  return provider === "openrouter";
}

const normaliseRate = (raw) => {
  if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0) {
    return { input: raw, output: raw };
  }
  if (raw && typeof raw === "object") {
    const input = Number(raw.input ?? raw.prompt);
    const output = Number(raw.output ?? raw.completion);
    if (Number.isFinite(input) && input >= 0 && Number.isFinite(output) && output >= 0) {
      return { input, output };
    }
  }
  return null;
};

/**
 * Parse LLM_MODEL_PRICES.
 *
 * A malformed declaration THROWS rather than being skipped. Ignoring it would
 * silently drop back to "unpriced", and an operator who typo'd their price map
 * deserves to hear about the typo, not about the model (standing rule 1).
 */
export function readDeclaredPrices(env = process.env) {
  const raw = String(env?.[MODEL_PRICES_ENV] ?? "").trim();
  if (!raw) return {};

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new UnpricedModelError(
      `${MODEL_PRICES_ENV} is not valid JSON: ${e.message}. Expected ` +
        `{"<model id>": {"input": <usd per 1M tokens>, "output": <usd per 1M tokens>}}.`,
      { reason: "malformed_declaration", cause: e }
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new UnpricedModelError(
      `${MODEL_PRICES_ENV} must be a JSON object keyed by model id, got ${Array.isArray(parsed) ? "an array" : typeof parsed}.`,
      { reason: "malformed_declaration" }
    );
  }

  const out = {};
  for (const [id, rate] of Object.entries(parsed)) {
    const normalised = normaliseRate(rate);
    if (!normalised) {
      throw new UnpricedModelError(
        `${MODEL_PRICES_ENV} entry for "${id}" is not a usable rate. Give a number, ` +
          `or {"input": n, "output": n}, in USD per 1M tokens.`,
        { reason: "malformed_declaration", model: id }
      );
    }
    out[id] = normalised;
  }
  return out;
}

/**
 * The rate for `model`, or null when nothing prices it. An operator
 * declaration wins over the built-in table so a stale hard-coded rate can
 * always be corrected without a deploy.
 */
export function lookupModelPrice(model, env = process.env) {
  const id = String(model || "");
  if (!id) return null;
  const declared = readDeclaredPrices(env)[id];
  if (declared) return { ...declared, declared: true };
  const builtIn = PRICES_PER_MTOK[id];
  if (builtIn) return { ...builtIn, declared: false };
  return null;
}

/** Every id this process can price without help, for the error message. */
function priceableIds(env) {
  return [...new Set([...Object.keys(PRICES_PER_MTOK), ...Object.keys(readDeclaredPrices(env))])].sort();
}

const alerted = new Set();

/** Test seam: forget which unpriced-model alerts have already been emitted. */
export function resetUnpricedAlerts() {
  alerted.clear();
}

/**
 * The alert half of "throws and alerts". This repo has no alerting service, so
 * the alert surface is a greppable stderr line plus the typed throw the caller
 * is about to receive; a monitor keys on `[llm-price] UNPRICED MODEL`.
 *
 * De-duplicated per model+provider per process, the same way llmConfig
 * de-duplicates its deprecation warning: the throw always happens, every time,
 * but a caller that retries must not turn one misconfiguration into a log
 * flood that buries it.
 */
function alertUnpriced(model, provider, env) {
  const key = `${provider}::${model}`;
  if (alerted.has(key)) return;
  alerted.add(key);
  console.error(
    `[llm-price] UNPRICED MODEL "${model}" on gateway "${provider}" — refusing to record $0 for ` +
      `paid inference. Declare a rate in ${MODEL_PRICES_ENV}, or use a ":free" model id. ` +
      `Priced ids: ${priceableIds(env).join(", ") || "(none)"}.`
  );
}

function throwUnpriced(model, provider, env, extra) {
  alertUnpriced(model, provider, env);
  throw new UnpricedModelError(
    `No price for model "${model}" on gateway "${provider}". ${extra} ` +
      `Set ${MODEL_PRICES_ENV} to declare USD-per-1M-token rates for it, or point ` +
      `LLM_MODEL at a ":free" id. Recording $0 for paid inference is not an option.`,
    { reason: "unpriced_model", model, provider }
  );
}

/**
 * Pre-flight gate: can this model be priced AT ALL on this gateway?
 *
 * Called before the request is sent. Failing here rather than after the
 * completion is the deliberate choice — a mid-scan throw discards an answer
 * that was already paid for, while a pre-flight throw costs nothing and puts
 * the failure on the first call after a bad deploy, where an operator can
 * still read it as a configuration error.
 *
 * Returns the source the cost will come from ("free_tier" | "price_table" |
 * "gateway"), or throws UnpricedModelError.
 */
export function assertModelPriceable(model, provider, env = process.env) {
  if (isFreeModelId(model)) return "free_tier";
  if (lookupModelPrice(model, env)) return "price_table";
  // OpenRouter is asked for `usage.include` on paid ids and answers with real
  // spend, so an id we have no rate for is still priceable there. If the echo
  // then fails to arrive, resolveCost throws after the fact rather than
  // inventing a zero.
  if (gatewayReportsCost(provider)) return "gateway";
  return throwUnpriced(model, provider, env, `Gateway "${provider}" does not report usage.cost.`);
}

/**
 * Turn a completion's usage block into a cost with a named source, or throw.
 *
 * @param {{model: string, provider: string, usage?: object, promptTokens?: number,
 *          completionTokens?: number, env?: object}} args
 * @returns {{cost: number, cost_source: "gateway"|"free_tier"|"price_table"}}
 */
export function resolveCost({
  model,
  provider,
  usage,
  promptTokens,
  completionTokens,
  env = process.env,
}) {
  // 1. Actual spend, when the gateway reports it.
  //
  //    Two traps live in this one line. `Number(undefined) || 0` was the
  //    original bug — absent read as free. `Number(null)` is 0, so a coerce-
  //    first check would read a null field as a measured zero, which is the
  //    same bug wearing a different mask. So: the field must ARRIVE as a
  //    number (or a numeric string, since some gateways stringify it), and
  //    only then is a genuine 0.0 — promo credit, cached prompt — kept as the
  //    measurement it is.
  const raw = usage?.cost;
  const reported =
    typeof raw === "string" && raw.trim() !== "" ? Number(raw) : typeof raw === "number" ? raw : NaN;
  if (Number.isFinite(reported) && reported >= 0) {
    return { cost: reported, cost_source: "gateway" };
  }

  // 2. A free id costs nothing, by definition of the suffix.
  if (isFreeModelId(model)) return { cost: 0, cost_source: "free_tier" };

  // 3. Tokens x rate. Zero or absent token counts give a real 0 from a real
  //    rate — a priced model that used no tokens is measured, not unknown, and
  //    must not be confused with an id nothing can price.
  const price = lookupModelPrice(model, env);
  if (price) {
    const inTok = Number(promptTokens ?? usage?.prompt_tokens ?? 0) || 0;
    const outTok = Number(completionTokens ?? usage?.completion_tokens ?? 0) || 0;
    const cost = (inTok / 1e6) * price.input + (outTok / 1e6) * price.output;
    return { cost, cost_source: "price_table" };
  }

  // 4. Nothing left. This is reachable when a cost-reporting gateway passed the
  //    pre-flight gate and then did not echo `usage.cost` after all.
  return throwUnpriced(
    model,
    provider,
    env,
    gatewayReportsCost(provider)
      ? "The gateway was asked for usage.cost and did not return it."
      : `Gateway "${provider}" does not report usage.cost.`
  );
}
