import test from "node:test";
import assert from "node:assert/strict";
import { assistantConfigured, readAssistantConfig } from "./config.ts";

const BASE_ENV = { LLM_API_KEY: "test-key", LLM_BASE_URL: "https://openrouter.ai/api/v1" };

test("config: the §6.2.7 defaults are exact", () => {
  const cfg = readAssistantConfig({ ...BASE_ENV, ASSISTANT_MODEL: "anthropic/claude-sonnet-4.5" });
  assert.equal(cfg.turnMaxUsd, 0.5);
  assert.equal(cfg.maxSteps, 25);
  assert.equal(cfg.maxOutputTokens, 8_000);
  assert.equal(cfg.deadlineMs, 240_000);
  assert.equal(cfg.compactAfterTokens, 120_000);
  assert.equal(cfg.maxInputTokens, 160_000);
  assert.equal(cfg.perUserHour, 30);
  assert.equal(cfg.perWorkspaceDay, 300);
  assert.equal(cfg.approvalTtlSeconds, 900);
});

test("config: model is ASSISTANT_MODEL, then LLM_HELPER_MODEL, then getContentModel()", () => {
  assert.equal(
    readAssistantConfig({ ASSISTANT_MODEL: "model-a", LLM_HELPER_MODEL: "model-b" }).model,
    "model-a",
  );
  assert.equal(readAssistantConfig({ LLM_HELPER_MODEL: "model-b" }).model, "model-b");
  const fallback = readAssistantConfig({});
  assert.ok(fallback.model.length > 0);
  assert.equal(fallback.model, process.env.CONTENT_MODEL || "anthropic/claude-sonnet-4.5");
});

test("config: valid numeric env values are parsed", () => {
  const cfg = readAssistantConfig({
    ASSISTANT_TURN_MAX_USD: "0.25",
    ASSISTANT_MAX_STEPS: "7",
    ASSISTANT_MAX_OUTPUT_TOKENS: "1234",
    ASSISTANT_TURN_DEADLINE_MS: "30000",
    ASSISTANT_COMPACT_AFTER_TOKENS: "5000",
    ASSISTANT_MAX_INPUT_TOKENS: "9000",
    ASSISTANT_TURNS_PER_USER_HOUR: "5",
    ASSISTANT_TURNS_PER_WORKSPACE_DAY: "50",
    ASSISTANT_APPROVAL_TTL_SECONDS: "120",
  });
  assert.deepEqual(
    {
      turnMaxUsd: cfg.turnMaxUsd,
      maxSteps: cfg.maxSteps,
      maxOutputTokens: cfg.maxOutputTokens,
      deadlineMs: cfg.deadlineMs,
      compactAfterTokens: cfg.compactAfterTokens,
      maxInputTokens: cfg.maxInputTokens,
      perUserHour: cfg.perUserHour,
      perWorkspaceDay: cfg.perWorkspaceDay,
      approvalTtlSeconds: cfg.approvalTtlSeconds,
    },
    {
      turnMaxUsd: 0.25,
      maxSteps: 7,
      maxOutputTokens: 1234,
      deadlineMs: 30_000,
      compactAfterTokens: 5_000,
      maxInputTokens: 9_000,
      perUserHour: 5,
      perWorkspaceDay: 50,
      approvalTtlSeconds: 120,
    },
  );
});

test("config: an out-of-range value falls back and warns once, naming only the key", () => {
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (message: string, props?: { key?: string }) => {
    warnings.push(message + ":" + String(props?.key));
  };
  try {
    const cfg = readAssistantConfig(
      {
        ASSISTANT_TURN_MAX_USD: "0",
        ASSISTANT_MAX_STEPS: "0",
        ASSISTANT_MAX_OUTPUT_TOKENS: "9.5",
        ASSISTANT_TURN_DEADLINE_MS: "not-a-number",
        ASSISTANT_TURNS_PER_USER_HOUR: "-1",
        ASSISTANT_APPROVAL_TTL_SECONDS: "10",
      },
      { warn: (key) => warnings.push(key) },
    );
    assert.equal(cfg.turnMaxUsd, 0.5);
    assert.equal(cfg.maxSteps, 25);
    assert.equal(cfg.maxOutputTokens, 8_000);
    assert.equal(cfg.deadlineMs, 240_000);
    assert.equal(cfg.perUserHour, 30);
    assert.equal(cfg.approvalTtlSeconds, 900);
    assert.deepEqual(warnings.sort(), [
      "approvalTtlSeconds",
      "deadlineMs",
      "maxOutputTokens",
      "maxSteps",
      "perUserHour",
      "turnMaxUsd",
    ]);
  } finally {
    console.warn = original;
  }
});

test("config: a blank env value is the default, not a warning", () => {
  const warnings: string[] = [];
  const cfg = readAssistantConfig({ ASSISTANT_MAX_STEPS: "   " }, { warn: (key) => warnings.push(key) });
  assert.equal(cfg.maxSteps, 25);
  assert.deepEqual(warnings, []);
});

test("configured: no key is llm_not_configured", () => {
  assert.deepEqual(assistantConfigured({ ASSISTANT_MODEL: "anthropic/claude-sonnet-4.5" }), {
    ok: false,
    code: "llm_not_configured",
  });
});

test("configured: a priced model on OpenRouter is ok", () => {
  assert.deepEqual(
    assistantConfigured({ ...BASE_ENV, ASSISTANT_MODEL: "anthropic/claude-sonnet-4.5" }),
    { ok: true },
  );
});

test("configured: an unpriced model on a gateway that does not report cost is model_unpriced", () => {
  assert.deepEqual(
    assistantConfigured({
      LLM_API_KEY: "test-key",
      LLM_BASE_URL: "https://llm.example/v1",
      ASSISTANT_MODEL: "some-unpriced-model",
    }),
    { ok: false, code: "model_unpriced" },
  );
});

test("configured: an unpriced model on OpenRouter is priceable from the cost echo", () => {
  assert.deepEqual(
    assistantConfigured({ ...BASE_ENV, ASSISTANT_MODEL: "some-unpriced-model" }),
    { ok: true },
  );
});
