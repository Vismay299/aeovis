// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/lib/dataforseo/ai.test.ts and endpoints.test.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { AppError } from "../../http/appError.ts";
import { AmbiguousCallError } from "../../spend/errors.ts";
import { fetchLlmResponse } from "./ai.ts";

const oldKey = process.env.DATAFORSEO_API_KEY;
const oldFetch = globalThis.fetch;
const fixtureDir = "tests/fixtures/f02/";

function readFixture(name: string): unknown {
  return JSON.parse(readFileSync(fixtureDir + name, "utf8"));
}

function catalogue(names: string[]): Response {
  return Response.json({
    status_code: 20000,
    tasks: [{ status_code: 20000, result: names.map((model_name) => ({ model_name })) }],
  });
}

function setup(fetchImpl: typeof fetch): void {
  process.env.DATAFORSEO_API_KEY = "test-only";
  globalThis.fetch = fetchImpl;
}

function restore(): void {
  if (oldKey === undefined) delete process.env.DATAFORSEO_API_KEY;
  else process.env.DATAFORSEO_API_KEY = oldKey;
  globalThis.fetch = oldFetch;
}

test("unknown model names are refused before any billed POST", async () => {
  let posts = 0;
  setup(async (_input, init) => {
    if (init?.method === "POST") {
      posts += 1;
      throw new Error("POST must not run");
    }
    return catalogue(["gpt-5.5"]);
  });
  try {
    await assert.rejects(
      fetchLlmResponse({
        modelSlug: "chat_gpt",
        modelName: "unknown-model",
        userPrompt: "synthetic question",
      }),
      (error: unknown) =>
        error instanceof AppError && error.code === "dataforseo_model_unsupported",
    );
    assert.equal(posts, 0);
  } finally {
    restore();
  }
});

test("Claude model requests set force_web_search and clamp output tokens", async () => {
  let body: Record<string, unknown> | null = null;
  setup(async (_input, init) => {
    if (init?.method === "GET") return catalogue(["claude-sonnet-5"]);
    body = JSON.parse(String(init?.body))[0];
    return Response.json(readFixture("llm-responses-claude.json"));
  });
  try {
    const result = await fetchLlmResponse({
      modelSlug: "claude",
      modelName: "claude-sonnet-5",
      userPrompt: "synthetic question",
      webSearch: true,
      webSearchCountryCode: "IN",
      maxOutputTokens: 9999,
    });
    const capturedBody = body as unknown as Record<string, unknown> | null;
    assert.equal(capturedBody?.force_web_search, true);
    assert.equal(capturedBody?.web_search_country_iso_code, "IN");
    assert.equal(capturedBody?.max_output_tokens, 4096);
    assert.equal(result.data.model_name, "claude-sonnet-5");
  } finally {
    restore();
  }
});

test("country is sent only for web search, and Gemini never receives it", async () => {
  let bodies: Array<Record<string, unknown>> = [];
  setup(async (_input, init) => {
    if (init?.method === "GET") return catalogue(["gpt-5.5"]);
    bodies.push(JSON.parse(String(init?.body))[0]);
    return Response.json(readFixture("llm-responses-no-search.json"));
  });
  try {
    await fetchLlmResponse({
      modelSlug: "chat_gpt",
      modelName: "gpt-5.5",
      userPrompt: "synthetic",
      webSearch: false,
      webSearchCountryCode: "IN",
      maxOutputTokens: 1,
    });
    assert.equal(bodies[0].web_search, false);
    assert.equal("web_search_country_iso_code" in bodies[0], false);
    assert.equal(bodies[0].max_output_tokens, 256);
  } finally {
    restore();
  }

  let geminiPosts = 0;
  setup(async (_input, init) => {
    if (init?.method === "GET") return catalogue(["gemini-2.5-pro"]);
    geminiPosts += 1;
    return Response.json(readFixture("llm-responses-no-search.json"));
  });
  try {
    await assert.rejects(
      fetchLlmResponse({
        modelSlug: "gemini",
        modelName: "gemini-2.5-pro",
        userPrompt: "synthetic",
        webSearch: true,
        webSearchCountryCode: "IN",
      }),
      AppError,
    );
    assert.equal(geminiPosts, 0);
  } finally {
    restore();
  }
});

test("billed LLM response POST is never retried", async () => {
  let calls = 0;
  setup(async (_input, init) => {
    calls += 1;
    if (init?.method === "GET") return catalogue(["gpt-5.5"]);
    return new Response("upstream error", { status: 503 });
  });
  try {
    await assert.rejects(
      fetchLlmResponse({
        modelSlug: "chat_gpt",
        modelName: "gpt-5.5",
        userPrompt: "synthetic",
        webSearch: false,
      }),
      AmbiguousCallError,
    );
    assert.equal(calls, 1); // the model catalogue is cached; only the POST runs
  } finally {
    restore();
  }
});
