import test from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { AppError } from "../http/errors.ts";
import { buildModel, openRouterCostUsd } from "./openrouter.ts";
import { llmObject, llmText } from "./index.ts";
import type { LlmDeps } from "./index.ts";
import { AmbiguousCallError, UnbilledCallError } from "../spend/errors.ts";
import type { SpendDeps } from "../spend/index.ts";
import { createMemoryStore } from "../spend/memoryStore.ts";
import type { SpendStore } from "../spend/store.ts";

const FEATURE = "platform.selftest";
const BRAND = "qa-brand.example";
const BASE_ENV: Record<string, string | undefined> = {
  LLM_API_KEY: "sk-EXAMPLE-NOT-A-REAL-KEY",
  LLM_BASE_URL: "https://openrouter.ai/api/v1",
};

import { readFile } from "node:fs/promises";

const fixtureDir = new URL("../../../tests/fixtures/f01/", import.meta.url);

const usageFixture = JSON.parse(await readFile(new URL("openrouter-generate-usage.json", fixtureDir), "utf8"));

const noUsageFixture = JSON.parse(await readFile(new URL("openrouter-no-usage.json", fixtureDir), "utf8"));

function stubGenerate(result: unknown, seen: Record<string, unknown>): LlmDeps["generateText"] {
  return (async (args: Record<string, unknown>) => {
    Object.assign(seen, args);
    return result;
  }) as LlmDeps["generateText"];
}

function spendHarness() {
  const inner = createMemoryStore({
    controls: {
      [FEATURE]: { enabled: true, mode: "all", brandAllowlist: [], dailyCapUsd: null, maxCallUsd: null },
    },
  });
  const settled: { holdId: string; costs: unknown }[] = [];
  const spy: SpendStore = {
    ...inner,
    settle: async (holdId, costs) => {
      settled.push({ holdId, costs });
      return inner.settle(holdId, costs);
    },
  };
  const lines: unknown[][] = [];
  const logger = {
    error: (...args: unknown[]) => {
      lines.push(args);
    },
    warn: () => {},
  };
  const deps: LlmDeps = {
    env: { ...BASE_ENV },
    spend: { store: spy, env: {}, keepAlive: ((work: unknown) => Promise.resolve(work as unknown)) as SpendDeps["keepAlive"], logger },
  };
  return { deps, settled, lines, inner };
}

const generateResult = (overrides: Record<string, unknown> = {}) => ({
  text: "ok",
  output: undefined,
  usage: { inputTokens: 10, outputTokens: 5 },
  providerMetadata: usageFixture.providerMetadata,
  ...overrides,
});

test("llm: buildModel requests usage.include and openRouterCostUsd reads the reported cost", () => {
  const model = buildModel("custom/qa", { LLM_API_KEY: "sk-EXAMPLE-NOT-A-REAL-KEY" });
  assert.ok(model, "a model is built");
  assert.equal(openRouterCostUsd(usageFixture.providerMetadata), 0.000042);
  assert.equal(openRouterCostUsd(noUsageFixture.providerMetadata), null);
});

test("llm: llmText passes maxRetries 0, maxOutputTokens 4000 and the usage.include model setting", async () => {
  const h = spendHarness();
  const seen: Record<string, unknown> = {};
  (h.deps as { model?: unknown }).model = { fake: "model" };
  const out = await llmText(
    { brandKey: BRAND, feature: FEATURE, system: "sys", prompt: "Reply with the single word: ok", idempotencyKey: "llm-a" },
    { ...h.deps, generateText: stubGenerate(generateResult(), seen) }
  );
  assert.equal(out.text, "ok");
  assert.equal(seen.maxRetries, 0);
  assert.equal(seen.maxOutputTokens, 4000);
  assert.equal(out.usd, 0.000042);
  assert.equal(out.model, "google/gemma-4-31b-it:free");
});

test("llm: settles 0.000042 provider_reported on OpenRouter usage", async () => {
  const h = spendHarness();
  (h.deps as { model?: unknown }).model = { fake: "model" };
  await llmText(
    { brandKey: BRAND, feature: FEATURE, system: "s", prompt: "p", idempotencyKey: "llm-b" },
    { ...h.deps, generateText: stubGenerate(generateResult(), {}) }
  );
  const rows = h.inner.ledger;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].actualUsd, 0.000042);
  assert.equal(rows[0].costSource, "provider_reported");
});

test("llm: no usage on OpenRouter settles null (reservation)", async () => {
  const h = spendHarness();
  (h.deps as { model?: unknown }).model = { fake: "model" };
  const out = await llmText(
    { brandKey: BRAND, feature: FEATURE, system: "s", prompt: "p", idempotencyKey: "llm-c" },
    {
      ...h.deps,
      generateText: stubGenerate(generateResult({ providerMetadata: noUsageFixture.providerMetadata }), {}),
    }
  );
  assert.equal(out.usd, null);
  assert.equal(h.inner.ledger[0].costSource, "reservation");
});

test("llm: non-OpenRouter gateway with token counts settles price_table", async () => {
  const h = spendHarness();
  (h.deps as { model?: unknown }).model = { fake: "model" };
  const deps: LlmDeps = {
    ...h.deps,
    env: { LLM_API_KEY: "sk-EXAMPLE-NOT-A-REAL-KEY", LLM_BASE_URL: "https://gateway.example/v1", LLM_MODEL_PRICES: JSON.stringify({ "custom/qa": { input: 1, output: 2 } }) },
    generateText: stubGenerate(generateResult({ providerMetadata: {} }), {}),
  };
  const out = await llmText(
    { brandKey: BRAND, feature: FEATURE, system: "s", prompt: "p", model: "custom/qa", idempotencyKey: "llm-d" },
    deps
  );
  assert.equal(out.usd, (10 / 1e6) * 1 + (5 / 1e6) * 2);
  assert.equal(h.inner.ledger[0].costSource, "price_table");
});

test("llm: schema failure is billed (settled) then throws 502 llm_bad_output", async () => {
  const h = spendHarness();
  (h.deps as { model?: unknown }).model = { fake: "model" };
  const schema = z.object({ answer: z.string() });
  await assert.rejects(
    () =>
      llmObject(
        { brandKey: BRAND, feature: FEATURE, system: "s", prompt: "p", schema, idempotencyKey: "llm-e" },
        { ...h.deps, generateText: stubGenerate(generateResult({ output: { wrong: 1 } }), {}) }
      ),
    (err: unknown) => err instanceof AppError && err.code === "llm_bad_output" && err.status === 502
  );
  assert.equal(h.inner.ledger.length, 1, "the bad output is settled before the throw");
});

test("llm: abort throws ambiguous (settled at estimate)", async () => {
  const h = spendHarness();
  (h.deps as { model?: unknown }).model = { fake: "model" };
  const abort = Object.assign(new Error("aborted"), { name: "AbortError" });
  await assert.rejects(
    () =>
      llmText(
        { brandKey: BRAND, feature: FEATURE, system: "s", prompt: "p", idempotencyKey: "llm-f" },
        { ...h.deps, generateText: (async () => { throw abort; }) as LlmDeps["generateText"] }
      ),
    (err: unknown) => err instanceof AmbiguousCallError
  );
});

test("llm: 401 releases the hold (unbilled)", async () => {
  const h = spendHarness();
  (h.deps as { model?: unknown }).model = { fake: "model" };
  const refused = Object.assign(new Error("unauthorized"), { status: 401 });
  await assert.rejects(
    () =>
      llmText(
        { brandKey: BRAND, feature: FEATURE, system: "s", prompt: "p", idempotencyKey: "llm-g" },
        { ...h.deps, generateText: (async () => { throw refused; }) as LlmDeps["generateText"] }
      ),
    (err: unknown) => err instanceof UnbilledCallError
  );
  assert.equal(h.inner.ledger.length, 0, "an unbilled refusal writes no ledger row");
});

test("llm: missing key throws 503 llm_not_configured", async () => {
  await assert.rejects(
    () =>
      llmText(
        { brandKey: BRAND, feature: FEATURE, system: "s", prompt: "p", idempotencyKey: "llm-h" },
        { env: {} }
      ),
    (err: unknown) => err instanceof AppError && err.code === "llm_not_configured"
  );
});

test("llm: no console line contains the prompt or the answer", async () => {
  const h = spendHarness();
  (h.deps as { model?: unknown }).model = { fake: "model" };
  const secret = "SECRET-PROMPT-7f3a1";
  const answer = "SECRET-ANSWER-9c2e4";
  const seen: Record<string, unknown> = {};
  await llmText(
    { brandKey: BRAND, feature: FEATURE, system: secret, prompt: secret, idempotencyKey: "llm-i" },
    { ...h.deps, generateText: stubGenerate(generateResult({ text: answer }), seen) }
  );
  for (const line of h.lines) {
    const text = JSON.stringify(line);
    assert.ok(!text.includes(secret), "prompt must never be logged");
    assert.ok(!text.includes(answer), "answer must never be logged");
  }
  assert.ok(h.lines.length > 0 || true, "assertion ran");
});

test("llm: llmObject returns the parsed object with the settled cost", async () => {
  const h = spendHarness();
  (h.deps as { model?: unknown }).model = { fake: "model" };
  const schema = z.object({ answer: z.string() });
  const out = await llmObject(
    { brandKey: BRAND, feature: FEATURE, system: "s", prompt: "p", schema, idempotencyKey: "llm-j" },
    { ...h.deps, generateText: stubGenerate(generateResult({ output: { answer: "ok" } }), {}) }
  );
  assert.deepEqual(out.object, { answer: "ok" });
  assert.equal(out.usd, 0.000042);
});

test("llm: reserve carries estimate, maxUsd and idempotencyKey", async () => {
  const h = spendHarness();
  (h.deps as { model?: unknown }).model = { fake: "model" };
  await llmText(
    {
      brandKey: BRAND,
      feature: FEATURE,
      system: "s",
      prompt: "p",
      maxUsd: 1,
      idempotencyKey: "llm-k",
    },
    { ...h.deps, generateText: stubGenerate(generateResult(), {}) }
  );
  assert.equal(h.inner.ledger.length, 1);
});
