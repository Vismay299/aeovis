// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/features/ai-visibility/services/aiVisibilityCost.test.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import test from "node:test";
import assert from "node:assert/strict";
import {
  AI_ENGINE_LABELS,
  AI_LIVE_RECORD_COST_USD,
  AI_RECORD_COST_USD,
  aiAnswerUsd,
  aiCostForAnswers,
  aiEngineUsesModelApi,
  llmResponseUsd,
  scheduledChecksPerMonth,
} from "./ai-visibility-pricing.ts";
import type { AiEngine } from "./ai-visibility-pricing.ts";

const chatgpt = (count: number): AiEngine[] =>
  Array<AiEngine>(count).fill("chatgpt");

/** Raw USD, compared to the ten decimal places the ported cases are quoted at. */
function near(actual: number, expected: number): void {
  assert.ok(Math.abs(actual - expected) < 1e-10, `${actual} != ${expected}`);
}

test("prices one answer per engine and mode", () => {
  // F03-AC-02: the queued and live prices for the three scraper engines.
  near(AI_RECORD_COST_USD, 0.0012);
  near(AI_LIVE_RECORD_COST_USD, 0.004);
  for (const engine of ["chatgpt", "gemini", "google_ai_overview"] as const) {
    near(aiAnswerUsd(engine, "queued"), 0.0012);
    near(aiAnswerUsd(engine, "live"), 0.004);
  }
  // Claude and Perplexity always use the model API, at the web-search price.
  for (const mode of ["queued", "live"] as const) {
    near(aiAnswerUsd("claude", mode), 0.18);
    near(aiAnswerUsd("perplexity", mode), 0.04);
  }
});

test("marks only Claude and Perplexity as model-API engines", () => {
  for (const engine of ["claude", "perplexity"] as const) {
    assert.equal(aiEngineUsesModelApi(engine), true);
  }
  for (const engine of ["chatgpt", "gemini", "google_ai_overview"] as const) {
    assert.equal(aiEngineUsesModelApi(engine), false);
  }
});

test("quotes self-hosted provider cost without markup or credits", () => {
  assert.deepEqual(aiCostForAnswers(chatgpt(12), "queued"), {
    providerCostUsd: 0.0144,
  });
  assert.deepEqual(aiCostForAnswers(chatgpt(3), "queued"), {
    providerCostUsd: 0.0036,
  });
  assert.deepEqual(aiCostForAnswers([], "queued"), { providerCostUsd: 0 });
});

test("quotes live answers for manual runs at the live price", () => {
  assert.equal(aiCostForAnswers(chatgpt(3), "live").providerCostUsd, 0.012);
});

test("prices Claude and Perplexity at model API rates on every run", () => {
  for (const mode of ["queued", "live"] as const) {
    assert.equal(
      aiCostForAnswers(["claude", "perplexity"], mode).providerCostUsd,
      0.22,
    );
  }
});

test("labels every engine", () => {
  assert.deepEqual(AI_ENGINE_LABELS, {
    chatgpt: "ChatGPT",
    gemini: "Gemini",
    google_ai_overview: "Google AI Overviews",
    claude: "Claude",
    perplexity: "Perplexity",
  });
});

test("counts one check per scheduled run", () => {
  assert.equal(scheduledChecksPerMonth("daily"), 30);
  assert.equal(scheduledChecksPerMonth("weekly"), 4);
  assert.equal(scheduledChecksPerMonth("monthly"), 1);
});

test("prices one live LLM response per model, with and without web search", () => {
  const table = {
    chat_gpt: { webSearch: 0.09, noSearch: 0.05 },
    claude: { webSearch: 0.18, noSearch: 0.08 },
    gemini: { webSearch: 0.11, noSearch: 0.05 },
    perplexity: { webSearch: 0.04, noSearch: 0.04 },
  } as const;
  for (const [slug, row] of Object.entries(table)) {
    near(llmResponseUsd(slug as keyof typeof table, true), row.webSearch);
    near(llmResponseUsd(slug as keyof typeof table, false), row.noSearch);
  }
});
