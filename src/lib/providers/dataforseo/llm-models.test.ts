// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/lib/dataforseo/llm-models.test.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  FALLBACK_MODEL_NAMES,
  isKnownLlmModelName,
  resolveLatestLlmModelName,
  type LlmModelDependencies,
} from "./llm-models.ts";

function dependencies(
  names: string[],
  extra: Partial<LlmModelDependencies> = {},
): LlmModelDependencies {
  return {
    env: { DATAFORSEO_API_KEY: "test-only" },
    cache: new Map(),
    fetchImpl: async () =>
      Response.json({
        status_code: 20000,
        tasks: [{
          status_code: 20000,
          result: names.map((model_name) => ({ model_name })),
        }],
      }),
    ...extra,
  };
}

test("ChatGPT pin is honored while it remains listed", async () => {
  const deps = dependencies(["gpt-5.5", "gpt-5.6-luna", "gpt-5"]);
  assert.equal(await resolveLatestLlmModelName("chat_gpt", deps), "gpt-5.6-luna");
});

test("highest plain flagship alias wins when the pin is gone", async () => {
  const chat = dependencies(["o4-mini", "gpt-5.6-terra", "gpt-5.5", "gpt-5.5-2026-04-23", "gpt-5-mini", "gpt-5"]);
  assert.equal(await resolveLatestLlmModelName("chat_gpt", chat), "gpt-5.5");

  const claude = dependencies(["claude-opus-5", "claude-sonnet-4-6", "claude-sonnet-5-5", "claude-sonnet-4-5-20250929"]);
  assert.equal(await resolveLatestLlmModelName("claude", claude), "claude-sonnet-5-5");
});

test("listed snapshot is used if the catalogue has no flagship alias", async () => {
  const deps = dependencies(["sonar-pro", "sonar"]);
  assert.equal(await resolveLatestLlmModelName("perplexity", deps), "sonar-pro");
});

test("static snapshot is used when catalogue is unreachable and failures are not cached", async () => {
  let calls = 0;
  const deps: LlmModelDependencies = {
    env: { DATAFORSEO_API_KEY: "test-only" },
    cache: new Map(),
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) throw new Error("network unavailable");
      return Response.json({
        status_code: 20000,
        tasks: [{ status_code: 20000, result: [{ model_name: "gpt-5.5" }] }],
      });
    },
  };
  assert.equal(await resolveLatestLlmModelName("chat_gpt", deps), FALLBACK_MODEL_NAMES.chat_gpt[0]);
  assert.equal(await isKnownLlmModelName("chat_gpt", "gpt-5.5", deps), true);
  assert.equal(calls, 2);
});

test("environment override wins only when catalogue lists it", async () => {
  const good = dependencies(["gpt-5.5", "gpt-5.4"], {
    env: {
      DATAFORSEO_API_KEY: "test-only",
      DATAFORSEO_LLM_MODEL_CHAT_GPT: "gpt-5.4",
    },
  });
  assert.equal(await resolveLatestLlmModelName("chat_gpt", good), "gpt-5.4");

  const warnings: unknown[][] = [];
  const oldWarn = console.warn;
  console.warn = (...args: unknown[]) => warnings.push(args);
  try {
    const invalid = dependencies(["gpt-5.5", "gpt-5"], {
      env: {
        DATAFORSEO_API_KEY: "test-only",
        DATAFORSEO_LLM_MODEL_CHAT_GPT: "gpt-9",
      },
    });
    assert.equal(await resolveLatestLlmModelName("chat_gpt", invalid), "gpt-5.5");
    assert.deepEqual(warnings, [["[dataforseo] model override not in catalogue", { slug: "chat_gpt" }]]);
  } finally {
    console.warn = oldWarn;
  }
});
