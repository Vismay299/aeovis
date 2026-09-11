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
 *
 * `price_table` additionally requires the gateway to have REPORTED token
 * counts. A priced model that genuinely consumed nothing is a measured $0; a
 * gateway that returned no `usage` block measured nothing at all, and the two
 * must not render as the same number (standing rule 1). The second throws
 * `UnpricedModelError` with reason `unmeasured_tokens`.
 *
 * PER-CALL TOOL FEES (R3.6.6)
 * ---------------------------
 * Some calls are billed twice: once per token and once per built-in tool
 * invocation. src/lib/engines/openai.js always attaches OpenAI's `web_search`
 * tool, and that tool's flat fee DOMINATES the token cost by roughly two orders
 * of magnitude on a short probe — it opened the file as
 *
 *     let cost = 0.01; // base web_search tool fee
 *
 * next to a hard-coded gpt-4o-mini per-token rate, while `OPENAI_MODEL` is
 * env-overridable. Point the adapter at another model and every probe was still
 * priced, and REPORTED AS SPEND, at gpt-4o-mini's rates and gpt-4o-mini's tool
 * fee. That is worse than a $0: a wrong number survives inspection.
 *
 * So a tool fee is a fourth named source, `tool_price_table`, keyed by the same
 * model id as the token rate and declarable in LLM_TOOL_FEES. An id with no fee
 * for a tool it is about to call throws `UnpricedModelError` with reason
 * `unpriced_tool`. Dropping the fee instead — pricing only the tokens — would
 * be the same false success wearing a smaller number.
 *
 * PER-QUERY SERP PRICES (R3.6.4)
 * ------------------------------
 * A SERP query is billed per REQUEST by the vendor and has no model id and no
 * tokens at all, so it gets a third table and a fifth named source,
 * `serp_price_table`. The three units must never share a table: a number read
 * out of the wrong one is off by orders of magnitude and still looks like
 * money.
 *
 * The rows are not new claims. `0.0015` was written out three times — once in
 * src/lib/engines/serp.js and once next to each of the two pipelines'
 * `brightDataSearch` calls (src/lib/scoring/aioPipeline.js,
 * src/lib/scoring/enginePipeline.js) — and SerpAPI's `0.01` twice more in
 * serp.js. Copies of a price drift independently and nothing notices, because
 * a drifted cost is still a plausible cost. Same numbers, one home, and an
 * unknown provider id throws `UnpricedModelError` with reason
 * `unpriced_serp_query` rather than billing a scan at $0.
 */

/** USD-per-million-token rates, keyed by exact model id. */
const PRICES_PER_MTOK = Object.freeze({
  // Anthropic list price, $3 / $15 per million tokens, current 2026-09.
  // This is the default CONTENT_MODEL (src/lib/llm.js getContentModel), i.e.
  // the one id in this repo that is paid by default and therefore the one that
  // was silently costing $0 on MiMo.
  "anthropic/claude-sonnet-4.5": Object.freeze({ input: 3, output: 15 }),

  // R3.6.6. The DEFAULT_OPENAI_MODEL in src/lib/engines/openai.js, and the only
  // id its hard-coded `(in * 0.15 + out * 0.60) / 1e6` was ever true for. The
  // rate is carried over unchanged and merely moved behind the model id, so
  // that an OPENAI_MODEL pointed anywhere else now MISSES the table and fails
  // loud instead of quietly inheriting this row.
  "gpt-4o-mini": Object.freeze({ input: 0.15, output: 0.6 }),
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
 * USD per single invocation of a built-in provider tool, keyed by model id and
 * then by tool name (R3.6.6).
 *
 * Per-CALL, not per-token: these two units must never share a table, because a
 * number read out of the wrong one is off by six orders of magnitude and still
 * looks like money.
 */
const TOOL_FEES_PER_CALL = Object.freeze({
  // OpenAI's hosted `web_search` tool on gpt-4o-mini. $0.01 per call is the
  // figure src/lib/engines/openai.js already used; R3.6.6 moved it here rather
  // than restating or re-deriving it, so this row is the SAME claim the repo
  // was making, now keyed by the model it was ever true for and overridable
  // without a deploy. Verify against OpenAI's tool pricing page before trusting
  // it for a bill; prefer LLM_TOOL_FEES to editing this.
  "gpt-4o-mini": Object.freeze({ web_search: 0.01 }),
});

/** The built-in tool-fee table, exported for tests and error messages. */
export const BUILT_IN_TOOL_FEES = TOOL_FEES_PER_CALL;

/**
 * Operator-declared per-call tool fees. JSON object of
 * `{ "<model id>": { "<tool>": <usd per call> } }`.
 */
export const TOOL_FEES_ENV = "LLM_TOOL_FEES";

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
   * @param {{reason?: "unpriced_model"|"unmeasured_tokens"|"unpriced_tool"|"unpriced_serp_query"
   *                  |"malformed_declaration",
   *          model?: string, provider?: string, tool?: string, cause?: unknown}} [meta]
   */
  constructor(message, meta = {}) {
    super(message);
    this.name = "UnpricedModelError";
    this.reason = meta.reason || "unpriced_model";
    this.model = meta.model || null;
    this.provider = meta.provider || null;
    this.tool = meta.tool || null;
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

/**
 * Parse LLM_TOOL_FEES. Malformed input throws for the same reason
 * readDeclaredPrices does: a typo'd fee map that is silently skipped downgrades
 * to "unpriced" and sends the operator hunting the wrong bug.
 */
export function readDeclaredToolFees(env = process.env) {
  const raw = String(env?.[TOOL_FEES_ENV] ?? "").trim();
  if (!raw) return {};

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new UnpricedModelError(
      `${TOOL_FEES_ENV} is not valid JSON: ${e.message}. Expected ` +
        `{"<model id>": {"<tool>": <usd per call>}}.`,
      { reason: "malformed_declaration", cause: e }
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new UnpricedModelError(
      `${TOOL_FEES_ENV} must be a JSON object keyed by model id, got ${Array.isArray(parsed) ? "an array" : typeof parsed}.`,
      { reason: "malformed_declaration" }
    );
  }

  const out = {};
  for (const [id, tools] of Object.entries(parsed)) {
    if (!tools || typeof tools !== "object" || Array.isArray(tools)) {
      throw new UnpricedModelError(
        `${TOOL_FEES_ENV} entry for "${id}" must be an object of {"<tool>": <usd per call>}.`,
        { reason: "malformed_declaration", model: id }
      );
    }
    const perTool = {};
    for (const [tool, fee] of Object.entries(tools)) {
      const n = typeof fee === "string" && fee.trim() !== "" ? Number(fee) : fee;
      if (typeof n !== "number" || !Number.isFinite(n) || n < 0) {
        throw new UnpricedModelError(
          `${TOOL_FEES_ENV} fee for "${id}" tool "${tool}" is not a usable rate. ` +
            `Give a non-negative number of USD per tool call.`,
          { reason: "malformed_declaration", model: id, tool }
        );
      }
      perTool[tool] = n;
    }
    out[id] = perTool;
  }
  return out;
}

/**
 * The per-call fee for `tool` on `model`, or null when nothing prices it. An
 * operator declaration wins over the built-in table, exactly as it does for
 * token rates.
 */
export function lookupToolFee(model, tool, env = process.env) {
  const id = String(model || "");
  const name = String(tool || "");
  if (!id || !name) return null;
  const declared = readDeclaredToolFees(env)[id];
  if (declared && Object.hasOwn(declared, name)) {
    return { usd: declared[name], declared: true };
  }
  const builtIn = TOOL_FEES_PER_CALL[id];
  if (builtIn && Object.hasOwn(builtIn, name)) {
    return { usd: builtIn[name], declared: false };
  }
  return null;
}

/** Every `<model id>:<tool>` pair this process can price, for error messages. */
function priceableTools(env) {
  const pairs = [];
  for (const [id, tools] of Object.entries(TOOL_FEES_PER_CALL)) {
    for (const tool of Object.keys(tools)) pairs.push(`${id}:${tool}`);
  }
  for (const [id, tools] of Object.entries(readDeclaredToolFees(env))) {
    for (const tool of Object.keys(tools)) pairs.push(`${id}:${tool}`);
  }
  return [...new Set(pairs)].sort();
}

/**
 * The per-call fee for a tool this request is about to invoke, as a cost with a
 * named source, or a loud throw.
 *
 * Deliberately NOT defaulting to 0 for an unknown pair. A tool fee that is
 * silently dropped makes the reported cost smaller than the invoice by the
 * largest term in it, and a smaller wrong number is still a wrong number
 * (standing rule 3). Call it before the request goes out — nothing about the
 * answer changes the fee, so failing here costs nothing.
 *
 * @param {{model: string, tool: string, provider: string, calls?: number, env?: object}} args
 * @returns {{cost: number, cost_source: "tool_price_table"}}
 */
export function resolveToolFee({ model, tool, provider, calls = 1, env = process.env }) {
  const fee = lookupToolFee(model, tool, env);
  if (!fee) {
    const remedy =
      `Declare it in ${TOOL_FEES_ENV}, e.g. {"${model}": {"${tool}": 0.01}} in USD per call.`;
    alertUnpriced(model, provider, env, remedy);
    throw new UnpricedModelError(
      `No per-call fee for tool "${tool}" on model "${model}" (gateway "${provider}"). ` +
        `${remedy} Priced tools: ${priceableTools(env).join(", ") || "(none)"}. ` +
        `Recording $0, or silently omitting the fee, for a billed tool call is not an option.`,
      { reason: "unpriced_tool", model, provider, tool }
    );
  }
  const n = Number.isFinite(calls) && calls >= 0 ? calls : 1;
  return { cost: fee.usd * n, cost_source: "tool_price_table" };
}

/**
 * USD per single SERP query, keyed by SERP provider id (R3.6.4).
 *
 * Per-QUERY: a third unit, kept in a third table for the reason given at the
 * top of this file. The keys are the ids `getSerpProvider()` returns in
 * src/lib/engines/serp.js, so the provider that is called and the provider that
 * is priced cannot drift apart.
 */
const SERP_QUERY_PRICES = Object.freeze({
  // Bright Data SERP API, ~$1.50 per 1,000 requests. One `brightDataSearch`
  // call is one billed query whether or not an AI Overview comes back with it,
  // which is why an empty overview still costs this and must not report $0.
  // Carried over unchanged from the three literals it replaces.
  brightdata: 0.0015,
  // SerpAPI's flat per-search rate, carried over from src/lib/engines/serp.js.
  // A deferred AI Overview fetch is a SECOND search billed at the same rate, so
  // that path pays this twice — see probeGoogleAiOverview.
  serpapi: 0.01,
});

/** The built-in per-query SERP table, exported for tests and error messages. */
export const BUILT_IN_SERP_QUERY_PRICES = SERP_QUERY_PRICES;

/**
 * Operator-declared per-query SERP prices, so a renegotiated vendor rate is an
 * env change rather than a deploy. JSON object of
 * `{ "<serp provider id>": <usd per query> }`.
 */
export const SERP_QUERY_PRICES_ENV = "SERP_QUERY_PRICES";

/**
 * Parse SERP_QUERY_PRICES. Malformed input throws, for the same reason
 * readDeclaredPrices does: silently skipping a typo'd declaration downgrades
 * the provider to "unpriced" and sends the operator hunting the wrong bug.
 */
export function readDeclaredSerpQueryPrices(env = process.env) {
  const raw = String(env?.[SERP_QUERY_PRICES_ENV] ?? "").trim();
  if (!raw) return {};

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new UnpricedModelError(
      `${SERP_QUERY_PRICES_ENV} is not valid JSON: ${e.message}. Expected ` +
        `{"<serp provider id>": <usd per query>}.`,
      { reason: "malformed_declaration", cause: e }
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new UnpricedModelError(
      `${SERP_QUERY_PRICES_ENV} must be a JSON object keyed by SERP provider id, got ` +
        `${Array.isArray(parsed) ? "an array" : typeof parsed}.`,
      { reason: "malformed_declaration" }
    );
  }

  const out = {};
  for (const [id, price] of Object.entries(parsed)) {
    const n = typeof price === "string" && price.trim() !== "" ? Number(price) : price;
    if (typeof n !== "number" || !Number.isFinite(n) || n < 0) {
      throw new UnpricedModelError(
        `${SERP_QUERY_PRICES_ENV} price for "${id}" is not a usable rate. ` +
          `Give a non-negative number of USD per query.`,
        { reason: "malformed_declaration", provider: id }
      );
    }
    out[id] = n;
  }
  return out;
}

/**
 * The per-query price for a SERP provider, or null when nothing prices it. An
 * operator declaration wins over the built-in table, exactly as it does for
 * token rates and tool fees.
 */
export function lookupSerpQueryPrice(provider, env = process.env) {
  const id = String(provider || "");
  if (!id) return null;
  const declared = readDeclaredSerpQueryPrices(env);
  if (Object.hasOwn(declared, id)) return { usd: declared[id], declared: true };
  if (Object.hasOwn(SERP_QUERY_PRICES, id)) return { usd: SERP_QUERY_PRICES[id], declared: false };
  return null;
}

/** Every SERP provider id this process can price, for error messages. */
function priceableSerpProviders(env) {
  return [
    ...new Set([...Object.keys(SERP_QUERY_PRICES), ...Object.keys(readDeclaredSerpQueryPrices(env))]),
  ].sort();
}

/**
 * The cost of `queries` billed SERP queries on `provider`, as a cost with a
 * named source, or a loud throw.
 *
 * Call it BEFORE the request goes out, and outside whatever try/catch wraps
 * the probe. Both SERP call paths in this repo swallow throws into a
 * `cost: 0.0` skip return or an error row, so a refusal raised inside one of
 * them would be laundered into exactly the silent $0 this table exists to
 * prevent (standing rules 1 and 2). Nothing about the answer changes the
 * price, so resolving first costs nothing.
 *
 * @param {{provider: string, queries?: number, env?: object}} args
 * @returns {{cost: number, cost_source: "serp_price_table"}}
 */
export function resolveSerpQueryCost({ provider, queries = 1, env = process.env }) {
  // Deliberately NOT resolveToolFee's `Number.isFinite(calls) ? calls : 1`
  // shape: a query count that arrived as undefined/NaN is a caller bug, and
  // quietly pricing it as one query invents a number nobody measured.
  if (typeof queries !== "number" || !Number.isFinite(queries) || queries < 0) {
    throw new TypeError(
      `resolveSerpQueryCost: "queries" must be a finite, non-negative number, got ` +
        `${JSON.stringify(queries)}. Defaulting a bad count would fabricate a cost.`
    );
  }

  const price = lookupSerpQueryPrice(provider, env);
  if (!price) {
    const remedy =
      `Declare it in ${SERP_QUERY_PRICES_ENV}, e.g. {"${provider}": 0.002} — USD per query, ` +
      `and that number is SHAPE, not a quote: read it off the vendor's price page.`;
    alertUnpricedSerpProvider(provider, env, remedy);
    throw new UnpricedModelError(
      `No per-query price for SERP provider "${provider}". ${remedy} ` +
        `Priced SERP providers: ${priceableSerpProviders(env).join(", ") || "(none)"}. ` +
        `Recording $0 for a billed SERP query is not an option.`,
      { reason: "unpriced_serp_query", provider }
    );
  }
  return { cost: price.usd * queries, cost_source: "serp_price_table" };
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
function alertUnpriced(
  model,
  provider,
  env,
  remedy = `Declare a rate in ${MODEL_PRICES_ENV}, or use a ":free" model id.`
) {
  const key = `${provider}::${model}`;
  if (alerted.has(key)) return;
  alerted.add(key);
  console.error(
    `[llm-price] UNPRICED MODEL "${model}" on gateway "${provider}" — refusing to record $0 for ` +
      `paid inference. ${remedy} ` +
      `Priced ids: ${priceableIds(env).join(", ") || "(none)"}.`
  );
}

/**
 * The alert half of "throws and alerts" for a SERP provider (R3.6.4).
 *
 * Shares `alerted` with alertUnpriced so one misconfiguration is one line per
 * process, and keeps the `[llm-price] UNPRICED` prefix a monitor can key on.
 * It does NOT reuse alertUnpriced itself: that message names a model id and
 * lists priced MODEL ids, and telling an operator whose SERP provider is
 * unpriced that "gpt-4o-mini" is available would send them to the wrong table.
 */
function alertUnpricedSerpProvider(provider, env, remedy) {
  const key = `serp::${provider}`;
  if (alerted.has(key)) return;
  alerted.add(key);
  console.error(
    `[llm-price] UNPRICED SERP PROVIDER "${provider}" — refusing to record $0 for a billed ` +
      `SERP query. ${remedy} ` +
      `Priced SERP providers: ${priceableSerpProviders(env).join(", ") || "(none)"}.`
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
 * The rate is known but the meter is missing: a priced model whose completion
 * came back with no usable token counts at all. `tokens x rate` has no tokens,
 * so there is no cost to report — only a fabricated one.
 */
function throwUnmeasured(model, provider, env) {
  const remedy =
    `The gateway returned no usable token counts, so tokens x rate cannot be computed. ` +
    `Use a ":free" id, or a gateway that returns a "usage" block.`;
  alertUnpriced(model, provider, env, remedy);
  throw new UnpricedModelError(
    `Model "${model}" has a rate, but gateway "${provider}" reported no token counts for this ` +
      `completion (no usable usage.prompt_tokens or usage.completion_tokens), so its cost cannot ` +
      `be computed. ${remedy} Recording $0 for paid inference is not an option: a priced model ` +
      `that consumed nothing and a gateway that measured nothing are different facts.`,
    { reason: "unmeasured_tokens", model, provider }
  );
}

/**
 * A token count the gateway actually REPORTED, or null when it did not.
 *
 * Deliberately not `Number(x) || 0`: `undefined`, `null`, `""`, `"abc"` and
 * `NaN` all coerce to a 0 indistinguishable from a real zero. That is the same
 * trap as `Number(data?.usage?.cost) || 0`, one field over, and it is how a
 * completion with no `usage` block at all came to be billed as a price-table
 * $0. Numeric strings are accepted because some gateways stringify counts.
 */
function reportedTokens(...candidates) {
  for (const candidate of candidates) {
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

  // 3. Tokens x rate — and only when the tokens were actually REPORTED.
  //
  //    This used to read `Number(promptTokens ?? usage?.prompt_tokens ?? 0)
  //    || 0`, which is the coerce-then-default shape condemned above for
  //    `usage.cost`, one field over. It made a completion with no `usage`
  //    block at all — the shape MiMo returns on some paths — resolve to the
  //    same `{cost: 0, cost_source: "price_table"}` as a genuine zero-token
  //    call, and `stats.cost` then accumulated a fabricated zero for paid
  //    inference. "This priced model consumed nothing" and "this gateway never
  //    said what it consumed" are different facts (standing rule 1), so the
  //    second one throws instead of being priced.
  //
  //    A reported 0 on either side is still a measurement and still prices; it
  //    takes BOTH sides being unreported to be unmeasured, because OpenAI-
  //    compatible gateways emit `prompt_tokens` and `completion_tokens`
  //    together or not at all.
  const price = lookupModelPrice(model, env);
  if (price) {
    const inTok = reportedTokens(promptTokens, usage?.prompt_tokens);
    const outTok = reportedTokens(completionTokens, usage?.completion_tokens);
    if (inTok === null && outTok === null) return throwUnmeasured(model, provider, env);
    const cost = ((inTok ?? 0) / 1e6) * price.input + ((outTok ?? 0) / 1e6) * price.output;
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
