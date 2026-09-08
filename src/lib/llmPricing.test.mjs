import test from "node:test";
import assert from "node:assert/strict";
import {
  BUILT_IN_MODEL_PRICES,
  BUILT_IN_TOOL_FEES,
  MODEL_PRICES_ENV,
  TOOL_FEES_ENV,
  UnpricedModelError,
  assertModelPriceable,
  gatewayReportsCost,
  isFreeModelId,
  isUnpricedModel,
  lookupModelPrice,
  lookupToolFee,
  readDeclaredPrices,
  readDeclaredToolFees,
  resetUnpricedAlerts,
  resolveCost,
  resolveToolFee,
} from "./llmPricing.js";

/**
 * R3.6.1 (findings C4/S18) — unit-level cover for the price table itself.
 * The integration side (that generateContent refuses before spending, and that
 * cost_source travels with the number) lives in openrouter.test.mjs.
 */

/** Every call in here is env-explicit, so nothing reads the ambient process. */
const NO_ENV = {};
const declaring = (json) => ({ [MODEL_PRICES_ENV]: json });

const silenced = (fn) => {
  const real = console.error;
  console.error = () => {};
  try {
    return fn();
  } finally {
    console.error = real;
  }
};

test("isFreeModelId - the ':free' suffix is the whole claim", () => {
  assert.equal(isFreeModelId("google/gemma-4-31b-it:free"), true);
  // The near-miss from docs/vendors/gateway-catalog.md: z-ai/glm-5.2 without
  // the suffix is billed at $1.19/M and used to be recorded as free.
  assert.equal(isFreeModelId("z-ai/glm-5.2"), false);
  assert.equal(isFreeModelId(":free-ish"), false);
  assert.equal(isFreeModelId(""), false);
  assert.equal(isFreeModelId(undefined), false);
});

test("gatewayReportsCost - only OpenRouter echoes real spend", () => {
  assert.equal(gatewayReportsCost("openrouter"), true);
  assert.equal(gatewayReportsCost("mimo"), false);
  assert.equal(gatewayReportsCost("custom"), false);
  assert.equal(gatewayReportsCost(undefined), false);
});

test("the built-in table prices the one model this repo pays for by default", () => {
  const rate = lookupModelPrice("anthropic/claude-sonnet-4.5", NO_ENV);
  assert.deepEqual(
    { input: rate.input, output: rate.output, declared: rate.declared },
    { input: 3, output: 15, declared: false }
  );
  assert.equal(lookupModelPrice("some/model-nobody-priced", NO_ENV), null);
  assert.ok(Object.isFrozen(BUILT_IN_MODEL_PRICES), "the table must not be mutable at runtime");
});

test("an operator declaration overrides a stale built-in rate", () => {
  const rate = lookupModelPrice(
    "anthropic/claude-sonnet-4.5",
    declaring('{"anthropic/claude-sonnet-4.5":{"input":9,"output":99}}')
  );
  assert.deepEqual({ input: rate.input, output: rate.output, declared: rate.declared }, {
    input: 9,
    output: 99,
    declared: true,
  });
});

test("a bare number declares the same rate both ways", () => {
  assert.deepEqual(readDeclaredPrices(declaring('{"some/model":2}')), {
    "some/model": { input: 2, output: 2 },
  });
  assert.deepEqual(readDeclaredPrices(declaring('{"free/thing":0}')), {
    "free/thing": { input: 0, output: 0 },
  });
});

test("an absent declaration is empty, not an error", () => {
  assert.deepEqual(readDeclaredPrices(NO_ENV), {});
  assert.deepEqual(readDeclaredPrices({ [MODEL_PRICES_ENV]: "   " }), {});
});

test("a MALFORMED declaration throws rather than being quietly skipped", () => {
  // Standing rule 1: skipping it would drop straight back to "unpriced" and
  // blame the model for the operator's typo.
  for (const bad of ["{not json", "[]", '"a string"', '{"m":"free"}', '{"m":{"input":1}}', '{"m":-2}']) {
    const caught = (() => {
      try {
        readDeclaredPrices(declaring(bad));
        return null;
      } catch (e) {
        return e;
      }
    })();
    assert.ok(isUnpricedModel(caught), `${bad} must be refused, got ${caught}`);
    assert.equal(caught.reason, "malformed_declaration");
    assert.match(caught.message, new RegExp(MODEL_PRICES_ENV));
  }
});

test("assertModelPriceable - names the source it will price from", () => {
  assert.equal(assertModelPriceable("x/y:free", "mimo", NO_ENV), "free_tier");
  assert.equal(assertModelPriceable("anthropic/claude-sonnet-4.5", "mimo", NO_ENV), "price_table");
  assert.equal(assertModelPriceable("m", "custom", declaring('{"m":1}')), "price_table");
  // Unknown on OpenRouter is still priceable: usage.include answers for it.
  assert.equal(assertModelPriceable("z-ai/glm-5.2", "openrouter", NO_ENV), "gateway");
});

test("assertModelPriceable - an unknown id on a silent gateway throws with the remedy", () => {
  resetUnpricedAlerts();
  const caught = silenced(() => {
    try {
      assertModelPriceable("MiMo-VL-7B-RL", "mimo", NO_ENV);
      return null;
    } catch (e) {
      return e;
    }
  });
  assert.ok(caught instanceof UnpricedModelError);
  assert.equal(caught.reason, "unpriced_model");
  assert.equal(caught.model, "MiMo-VL-7B-RL");
  assert.equal(caught.provider, "mimo");
  assert.match(caught.message, new RegExp(MODEL_PRICES_ENV), "the error must name the fix");
  assert.match(caught.message, /not an option/);
});

test("isUnpricedModel matches by name too, across duplicated module instances", () => {
  // Next.js can load a module twice (server bundle + route bundle), which makes
  // `instanceof` alone unreliable — the same reason isLlmUnavailable does this.
  assert.equal(isUnpricedModel({ name: "UnpricedModelError" }), true);
  assert.equal(isUnpricedModel(new Error("nope")), false);
  assert.equal(isUnpricedModel(null), false);
});

test("resolveCost - the three named sources, and nothing else", () => {
  assert.deepEqual(
    resolveCost({ model: "z-ai/glm-5.2", provider: "openrouter", usage: { cost: 1.5 }, env: NO_ENV }),
    { cost: 1.5, cost_source: "gateway" }
  );
  assert.deepEqual(resolveCost({ model: "a:free", provider: "mimo", env: NO_ENV }), {
    cost: 0,
    cost_source: "free_tier",
  });
  assert.deepEqual(
    resolveCost({
      model: "anthropic/claude-sonnet-4.5",
      provider: "mimo",
      promptTokens: 1000000,
      completionTokens: 0,
      env: NO_ENV,
    }),
    { cost: 3, cost_source: "price_table" }
  );
});

test("resolveCost - a nonsense usage.cost falls through instead of poisoning the number", () => {
  // NaN or a negative is not a measurement. Falling through to the table beats
  // recording NaN, and beats recording 0 twice over.
  for (const cost of [NaN, -1, "free", null, undefined]) {
    const out = resolveCost({
      model: "anthropic/claude-sonnet-4.5",
      provider: "openrouter",
      usage: { cost, prompt_tokens: 1000000, completion_tokens: 0 },
      env: NO_ENV,
    });
    assert.deepEqual(out, { cost: 3, cost_source: "price_table" }, `usage.cost=${cost}`);
  }
});

test("resolveCost - usage token fields are used when the caller passes none", () => {
  assert.deepEqual(
    resolveCost({
      model: "anthropic/claude-sonnet-4.5",
      provider: "mimo",
      usage: { prompt_tokens: 2000000, completion_tokens: 1000000 },
      env: NO_ENV,
    }),
    { cost: 21, cost_source: "price_table" } // 2*3 + 1*15
  );
});

test("resolveCost - a priced model with no tokens is a MEASURED zero", () => {
  const out = resolveCost({
    model: "anthropic/claude-sonnet-4.5",
    provider: "mimo",
    usage: { prompt_tokens: 0, completion_tokens: 0 },
    env: NO_ENV,
  });
  assert.deepEqual(out, { cost: 0, cost_source: "price_table" });
  // And it is NOT the same claim as a free model's zero, nor an unpriced one.
  assert.notEqual(out.cost_source, "free_tier");
});

test("resolveCost - an unpriced id throws, and there is no branch that returns 0 for it", () => {
  resetUnpricedAlerts();
  for (const provider of ["mimo", "custom", "openrouter"]) {
    const caught = silenced(() => {
      try {
        return resolveCost({
          model: "nobody/prices-this",
          provider,
          usage: { prompt_tokens: 10, completion_tokens: 10 },
          env: NO_ENV,
        });
      } catch (e) {
        return e;
      }
    });
    assert.ok(isUnpricedModel(caught), `${provider} must refuse, got ${JSON.stringify(caught)}`);
    assert.equal(caught.provider, provider);
  }
});

test("resolveCost - a priced model with UNREPORTED tokens throws instead of pricing 0 x rate", () => {
  // The sibling of the usage.cost bug, one field over: `Number(promptTokens ??
  // usage?.prompt_tokens ?? 0) || 0` made every one of these look identical to
  // the measured zero above. Each case is a gateway that told us nothing.
  const unmeasured = [
    undefined,
    {},
    { total_tokens: 40 }, // a total with no breakdown is not a breakdown
    { prompt_tokens: null, completion_tokens: null },
    { prompt_tokens: "", completion_tokens: "" },
    { prompt_tokens: "abc", completion_tokens: {} },
    { prompt_tokens: NaN, completion_tokens: -1 },
  ];
  for (const usage of unmeasured) {
    resetUnpricedAlerts();
    const caught = silenced(() => {
      try {
        return resolveCost({
          model: "anthropic/claude-sonnet-4.5",
          provider: "mimo",
          usage,
          env: NO_ENV,
        });
      } catch (e) {
        return e;
      }
    });
    assert.ok(isUnpricedModel(caught), `usage=${JSON.stringify(usage)} must refuse, got ${JSON.stringify(caught)}`);
    assert.equal(caught.reason, "unmeasured_tokens", `usage=${JSON.stringify(usage)}`);
    assert.match(caught.message, /reported no token counts/);
  }
});

test("resolveCost - a reported count on either side is still a measurement", () => {
  // Strictly one side missing must NOT throw: the half we were given is real,
  // and refusing it would turn a partial meter into an outage.
  const inOnly = resolveCost({
    model: "anthropic/claude-sonnet-4.5",
    provider: "mimo",
    usage: { prompt_tokens: 1000000 },
    env: NO_ENV,
  });
  assert.deepEqual(inOnly, { cost: 3, cost_source: "price_table" });

  // Numeric strings count as reported — some gateways stringify usage.
  const stringy = resolveCost({
    model: "anthropic/claude-sonnet-4.5",
    provider: "mimo",
    usage: { prompt_tokens: "0", completion_tokens: "1000000" },
    env: NO_ENV,
  });
  assert.deepEqual(stringy, { cost: 15, cost_source: "price_table" });

  // A gateway-echoed cost still wins outright, tokens or no tokens.
  assert.deepEqual(
    resolveCost({ model: "anthropic/claude-sonnet-4.5", provider: "openrouter", usage: { cost: 0 }, env: NO_ENV }),
    { cost: 0, cost_source: "gateway" }
  );
  // As does a :free suffix — an unmetered free call is not an unpriced one.
  assert.deepEqual(resolveCost({ model: "a:free", provider: "mimo", usage: undefined, env: NO_ENV }), {
    cost: 0,
    cost_source: "free_tier",
  });
});

test("resolveCost - OpenRouter's missing echo is named as such in the message", () => {
  resetUnpricedAlerts();
  const caught = silenced(() => {
    try {
      resolveCost({ model: "nobody/prices-this", provider: "openrouter", env: NO_ENV });
      return null;
    } catch (e) {
      return e;
    }
  });
  assert.match(caught.message, /asked for usage\.cost and did not return it/);
});

/**
 * R3.6.6 — per-call tool fees.
 *
 * src/lib/engines/openai.js hard-coded `let cost = 0.01; // base web_search
 * tool fee` beside a hard-coded gpt-4o-mini token rate, with an env-overridable
 * model id. The fee is now a fourth named source keyed by the same model id, so
 * an id nobody priced cannot inherit another model's fee — and cannot silently
 * lose it either, which on a short probe is the LARGER of the two errors.
 */

const declaringTools = (json) => ({ [TOOL_FEES_ENV]: json });

test("R3.6.6 lookupToolFee - keyed by model id, and an operator declaration wins", () => {
  const builtIn = lookupToolFee("gpt-4o-mini", "web_search", NO_ENV);
  assert.deepEqual(builtIn, { usd: 0.01, declared: false });

  // The bug in one assertion: another model does NOT inherit gpt-4o-mini's fee.
  assert.equal(lookupToolFee("acme/other", "web_search", NO_ENV), null);
  // Nor does a tool the model has no fee for.
  assert.equal(lookupToolFee("gpt-4o-mini", "code_interpreter", NO_ENV), null);

  assert.deepEqual(
    lookupToolFee("gpt-4o-mini", "web_search", declaringTools('{"gpt-4o-mini":{"web_search":0.03}}')),
    { usd: 0.03, declared: true }
  );
  // A declared 0 is a real claim ("this tool is free here"), not a missing one.
  assert.deepEqual(
    lookupToolFee("acme/other", "web_search", declaringTools('{"acme/other":{"web_search":0}}')),
    { usd: 0, declared: true }
  );
  assert.ok(Object.isFrozen(BUILT_IN_TOOL_FEES), "the fee table must not be mutable at runtime");
});

test("R3.6.6 resolveToolFee - a priced pair returns a named source; calls multiply", () => {
  assert.deepEqual(resolveToolFee({ model: "gpt-4o-mini", tool: "web_search", provider: "openai", env: NO_ENV }), {
    cost: 0.01,
    cost_source: "tool_price_table",
  });
  assert.deepEqual(
    resolveToolFee({ model: "gpt-4o-mini", tool: "web_search", provider: "openai", calls: 3, env: NO_ENV }),
    { cost: 0.03, cost_source: "tool_price_table" }
  );
});

test("R3.6.6 resolveToolFee - an unpriced tool throws loud, never $0 and never omitted", () => {
  resetUnpricedAlerts();
  const caught = silenced(() => {
    try {
      resolveToolFee({ model: "acme/other", tool: "web_search", provider: "openai", env: NO_ENV });
      return null;
    } catch (e) {
      return e;
    }
  });
  assert.ok(isUnpricedModel(caught), "must be a typed UnpricedModelError");
  assert.equal(caught.reason, "unpriced_tool");
  assert.equal(caught.model, "acme/other");
  assert.equal(caught.tool, "web_search");
  assert.match(caught.message, new RegExp(TOOL_FEES_ENV));
  assert.match(caught.message, /not an option/);
});

test("R3.6.6 readDeclaredToolFees - a malformed declaration throws instead of degrading to unpriced", () => {
  assert.deepEqual(readDeclaredToolFees(NO_ENV), {});
  assert.deepEqual(readDeclaredToolFees(declaringTools("   ")), {});
  assert.deepEqual(readDeclaredToolFees(declaringTools('{"m":{"web_search":"0.02"}}')), {
    m: { web_search: 0.02 },
  });

  for (const bad of ["{oops", "[]", '{"m":5}', '{"m":{"web_search":"free"}}', '{"m":{"web_search":-1}}']) {
    assert.throws(
      () => readDeclaredToolFees(declaringTools(bad)),
      (e) => isUnpricedModel(e) && e.reason === "malformed_declaration",
      `expected ${bad} to be refused`
    );
  }
});

test("R3.6.6 - the built-in table prices the model the ChatGPT probe calls by default", () => {
  const rate = lookupModelPrice("gpt-4o-mini", NO_ENV);
  assert.deepEqual({ input: rate.input, output: rate.output, declared: rate.declared }, {
    input: 0.15,
    output: 0.6,
    declared: false,
  });
  // And an env-overridden id is not quietly priced at that row.
  assert.equal(lookupModelPrice("gpt-9-omni", NO_ENV), null);
});
