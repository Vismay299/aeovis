import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  aiTrackingTaskBody,
  fetchAiTrackingTaskResult,
  postAiTrackingTasks,
  providerLanguageCode,
} from "./ai-tracking.ts";

const fixtures = "tests/fixtures/f02/";
function fixture(name: string): unknown {
  return JSON.parse(readFileSync(fixtures + name, "utf8"));
}
function withEnvAndFetch(
  fetchImpl: typeof fetch,
  run: () => Promise<unknown>,
): Promise<unknown> {
  const oldKey = process.env.DATAFORSEO_API_KEY;
  const oldFetch = globalThis.fetch;
  process.env.DATAFORSEO_API_KEY = "test-only";
  globalThis.fetch = fetchImpl;
  return run().finally(() => {
    if (oldKey === undefined) delete process.env.DATAFORSEO_API_KEY;
    else process.env.DATAFORSEO_API_KEY = oldKey;
    globalThis.fetch = oldFetch;
  });
}

test("task body escapes literal percent and plus and applies engine market rules", () => {
  const body = aiTrackingTaskBody(
    "chatgpt",
    { locationCode: 2356, languageCode: "en" },
    { tag: "q-1", prompt: "best 50% + tools" },
  );
  assert.deepEqual(body, {
    keyword: "best 50%25 %2B tools",
    location_code: 2356,
    language_code: "en",
    tag: "q-1",
  });
  assert.equal(providerLanguageCode("gemini", "nb"), "no");
  assert.equal(providerLanguageCode("gemini", "tl"), "fil");
  assert.equal(providerLanguageCode("gemini", "pt"), "pt-BR");
  assert.equal(providerLanguageCode("chatgpt", "pt"), "pt");
});

test("Google AI Overview task body has depth and async loading", () => {
  assert.deepEqual(
    aiTrackingTaskBody(
      "google_ai_overview",
      { locationCode: 2356, languageCode: "hi" },
      { tag: "q-1", prompt: "question" },
    ),
    {
      keyword: "question",
      location_code: 2356,
      language_code: "hi",
      depth: 10,
      load_async_ai_overview: true,
      tag: "q-1",
    },
  );
});

test("task_post enforces 1..100 tasks before fetch", async () => {
  let calls = 0;
  const fetchImpl: typeof fetch = async () => {
    calls += 1;
    return Response.json({});
  };
  await assert.rejects(
    withEnvAndFetch(fetchImpl, () =>
      postAiTrackingTasks({
        engine: "chatgpt",
        locationCode: 2356,
        languageCode: "en",
        tasks: [],
      }),
    ),
  );
  await assert.rejects(
    withEnvAndFetch(fetchImpl, () =>
      postAiTrackingTasks({
        engine: "chatgpt",
        locationCode: 2356,
        languageCode: "en",
        tasks: Array.from({ length: 101 }, (_, i) => ({ tag: "q" + i, prompt: "q" })),
      }),
    ),
  );
  assert.equal(calls, 0);
});

test("task_post returns accepted and rejected tags and sums all entry costs", async () => {
  const oldKey = process.env.DATAFORSEO_API_KEY;
  const oldFetch = globalThis.fetch;
  process.env.DATAFORSEO_API_KEY = "test-only";
  globalThis.fetch = async () => Response.json(fixture("scraper-task-post.json"));
  try {
    const result = await postAiTrackingTasks({
      engine: "chatgpt",
      locationCode: 2356,
      languageCode: "en",
      tasks: [
        { tag: "q1", prompt: "one" },
        { tag: "q2", prompt: "two" },
        { tag: "q3", prompt: "three" },
        { tag: "q4", prompt: "four" },
      ],
    });
    assert.deepEqual(result.data, {
      posted: [
        { tag: "q1", taskId: "task-1" },
        { tag: "q2", taskId: "task-2" },
      ],
      rejected: [
        { tag: "q3", statusCode: 40501, message: "Invalid Field: 'keyword'.", costUsd: 0 },
        { tag: "q4", statusCode: 40501, message: "Invalid Field: 'language_code'.", costUsd: 0.0012 },
      ],
    });
    assert.equal(result.billing.costUsd, 0.0036);
    assert.deepEqual(result.billing.path, [
      "v3",
      "ai_optimization",
      "chat_gpt",
      "llm_scraper",
      "task_post",
    ]);
  } finally {
    if (oldKey === undefined) delete process.env.DATAFORSEO_API_KEY;
    else process.env.DATAFORSEO_API_KEY = oldKey;
    globalThis.fetch = oldFetch;
  }
});

test("task_get maps pending status codes and returns the result cost", async () => {
  const oldKey = process.env.DATAFORSEO_API_KEY;
  const oldFetch = globalThis.fetch;
  process.env.DATAFORSEO_API_KEY = "test-only";
  globalThis.fetch = async () => Response.json(fixture("scraper-task-get-pending.json"));
  try {
    assert.deepEqual(await fetchAiTrackingTaskResult({ engine: "chatgpt", taskId: "t1" }), {
      status: "pending",
    });
    globalThis.fetch = async () => Response.json(fixture("scraper-task-get-done.json"));
    assert.deepEqual(await fetchAiTrackingTaskResult({ engine: "chatgpt", taskId: "t1" }), {
      status: "completed",
      result: {
        datetime: "2026-10-01 12:00:00 +00:00",
        markdown: "Sample answer.",
        sources: [{ url: "https://example.test/" }],
      },
      costUsd: 0.0012,
    });
    globalThis.fetch = async () => Response.json(fixture("scraper-task-get-backend-failed.json"));
    assert.deepEqual(await fetchAiTrackingTaskResult({ engine: "chatgpt", taskId: "t1" }), {
      status: "failed",
      message: "Internal SE Server Error.",
      code: "dataforseo_unavailable",
      retryable: true,
      costUsd: 0.0012,
    });
  } finally {
    if (oldKey === undefined) delete process.env.DATAFORSEO_API_KEY;
    else process.env.DATAFORSEO_API_KEY = oldKey;
    globalThis.fetch = oldFetch;
  }
});

test("Google task_get returns AI Overview result, a normal SERP without overview, and no-results", async () => {
  const oldKey = process.env.DATAFORSEO_API_KEY;
  const oldFetch = globalThis.fetch;
  process.env.DATAFORSEO_API_KEY = "test-only";
  globalThis.fetch = async () => Response.json(fixture("serp-aio-task-get.json"));
  try {
    const aio = await fetchAiTrackingTaskResult({ engine: "google_ai_overview", taskId: "g1" });
    assert.equal(aio.status, "completed");
    assert.equal((aio as { result: { items: unknown[] } }).result.items.length, 1);
    globalThis.fetch = async () => Response.json(fixture("serp-no-aio-task-get.json"));
    const noAio = await fetchAiTrackingTaskResult({ engine: "google_ai_overview", taskId: "g2" });
    assert.equal(noAio.status, "completed");
    globalThis.fetch = async () => Response.json(fixture("serp-no-results.json"));
    const empty = await fetchAiTrackingTaskResult({ engine: "google_ai_overview", taskId: "g3" });
    assert.deepEqual(empty, { status: "completed", result: null, costUsd: 0 });
  } finally {
    if (oldKey === undefined) delete process.env.DATAFORSEO_API_KEY;
    else process.env.DATAFORSEO_API_KEY = oldKey;
    globalThis.fetch = oldFetch;
  }
});

test("one live answer is posted once and returns provider cost", async () => {
  let calls = 0;
  const oldKey = process.env.DATAFORSEO_API_KEY;
  const oldFetch = globalThis.fetch;
  process.env.DATAFORSEO_API_KEY = "test-only";
  globalThis.fetch = async (_input, init) => {
    calls += 1;
    assert.equal(init?.method, "POST");
    return Response.json({
      status_code: 20000,
      tasks: [{ status_code: 20000, path: ["v3", "ai_optimization", "chat_gpt", "llm_scraper", "live", "advanced"], cost: 0.004, result: [{ markdown: "Live." }] }],
    });
  };
  try {
    const result = await import("./ai-tracking.ts").then(({ fetchAiTrackingLiveAnswer }) =>
      fetchAiTrackingLiveAnswer({
        engine: "chatgpt",
        locationCode: 2356,
        languageCode: "en",
        task: { tag: "q1", prompt: "question" },
      }),
    );
    assert.equal(calls, 1);
    assert.equal(result.billing.costUsd, 0.004);
    assert.deepEqual(result.data, { status: "completed", result: { markdown: "Live." } });
  } finally {
    if (oldKey === undefined) delete process.env.DATAFORSEO_API_KEY;
    else process.env.DATAFORSEO_API_KEY = oldKey;
    globalThis.fetch = oldFetch;
  }
});
