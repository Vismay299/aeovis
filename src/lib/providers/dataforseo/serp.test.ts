// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/lib/dataforseo/serp.test.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import assert from "node:assert/strict";
import { test } from "node:test";
import { ChargedCallError, UnbilledCallError } from "../../spend/errors.ts";
import {
  fetchLiveSerp,
  fetchLocalSerpTaskResult,
  fetchRankCheckTaskResult,
  postLocalSerpTasks,
  postRankCheckTasks,
} from "./serp.ts";

const oldKey = process.env.DATAFORSEO_API_KEY;
const oldFetch = globalThis.fetch;

function setup(fetchImpl: typeof fetch): void {
  process.env.DATAFORSEO_API_KEY = "test-only-key";
  globalThis.fetch = fetchImpl;
}

function restore(): void {
  if (oldKey === undefined) delete process.env.DATAFORSEO_API_KEY;
  else process.env.DATAFORSEO_API_KEY = oldKey;
  globalThis.fetch = oldFetch;
}

function parseDataforseoRequestBody(init: RequestInit | undefined): unknown {
  const body = init?.body;
  if (typeof body !== "string") {
    throw new Error("Expected DataForSEO request body to be a string");
  }
  return JSON.parse(body) as unknown;
}

test("live SERP returns an empty result for DataForSEO's no-results task", async () => {
  setup(async () =>
    Response.json({
      status_code: 20000,
      tasks: [
        {
          status_code: 40102,
          status_message: "No Search Results.",
          path: ["v3", "serp", "google", "organic", "live", "advanced"],
          cost: 0.002,
          result_count: 0,
          result: [],
        },
      ],
    }),
  );
  try {
    const outcome = await fetchLiveSerp({
      keyword: "obscure query",
      locationCode: 2840,
      languageCode: "en",
    });
    assert.deepEqual(outcome.data, []);
    assert.equal(outcome.billing.costUsd, 0.002);
  } finally {
    restore();
  }
});

test("rank check task queue posts queued tasks, maps ids by tag, and sums cost over all entries", async () => {
  const calls: Array<[string | URL | Request, RequestInit | undefined]> = [];
  setup(async (url, init) => {
    calls.push([url, init]);
    return Response.json({
      status_code: 20000,
      tasks: [
        {
          id: "task-a",
          status_code: 20100,
          cost: 0.0006,
          data: { tag: "kw-1:desktop" },
        },
        {
          id: "task-b",
          status_code: 20100,
          cost: 0.0006,
          data: { tag: "kw-1:mobile" },
        },
        {
          id: "task-c",
          status_code: 40006,
          status_message: "Task Limit Exceeded",
          cost: 0.0006,
          data: { tag: "kw-2:desktop" },
        },
      ],
    });
  });

  try {
    const result = await postRankCheckTasks({
      tasks: [
        { keyword: "alpha", keywordId: "kw-1", device: "desktop" },
        { keyword: "alpha", keywordId: "kw-1", device: "mobile" },
        { keyword: "beta", keywordId: "kw-2", device: "desktop" },
      ],
      locationCode: 2840,
      languageCode: "en",
      depth: 20,
      targetDomain: "example.com",
    });

    assert.equal(calls.length, 1);
    const urlStr = typeof calls[0][0] === "string" ? calls[0][0] : String(calls[0][0]);
    assert.equal(urlStr, "https://api.dataforseo.com/v3/serp/google/organic/task_post");

    const stopCrawl = {
      stop_crawl_on_match: [
        { match_value: "example.com", match_type: "with_subdomains" },
      ],
      find_targets_in: ["organic"],
    };

    const body = parseDataforseoRequestBody(calls[0][1]) as Array<Record<string, unknown>>;
    assert.equal(body.length, 3);
    for (const item of body) {
      assert.deepEqual(item.stop_crawl_on_match, stopCrawl.stop_crawl_on_match);
      assert.deepEqual(item.find_targets_in, stopCrawl.find_targets_in);
    }

    assert.deepEqual(result.data, [
      {
        keyword: "alpha",
        keywordId: "kw-1",
        device: "desktop",
        taskId: "task-a",
      },
      {
        keyword: "alpha",
        keywordId: "kw-1",
        device: "mobile",
        taskId: "task-b",
      },
    ]);

    assert.ok(Math.abs(result.billing.costUsd - 0.0018) < 1e-6);
    assert.deepEqual(result.billing.path, [
      "v3",
      "serp",
      "google",
      "organic",
      "task_post",
    ]);
  } finally {
    restore();
  }
});

test("rank check task queue reports a queued task still in progress as pending", async () => {
  setup(async () =>
    Response.json({
      status_code: 20000,
      tasks: [{ id: "task-a", status_code: 40602 }],
    }),
  );
  try {
    const outcome = await fetchRankCheckTaskResult({
      taskId: "task-a",
      keywordId: "kw-1",
      keyword: "alpha",
      targetDomain: "example.com",
    });
    assert.deepEqual(outcome, { status: "pending" });
  } finally {
    restore();
  }
});

test("rank check task queue parses a completed queued task into a rank check result", async () => {
  setup(async () =>
    Response.json({
      status_code: 20000,
      tasks: [
        {
          id: "task-a",
          status_code: 20000,
          cost: 0,
          path: ["v3", "serp", "google", "organic", "task_get", "advanced"],
          result: [
            {
              items: [
                {
                  type: "organic",
                  rank_group: 3,
                  rank_absolute: 4,
                  domain: "www.example.com",
                  url: "https://www.example.com/page",
                },
              ],
            },
          ],
        },
      ],
    }),
  );
  try {
    const outcome = await fetchRankCheckTaskResult({
      taskId: "task-a",
      keywordId: "kw-1",
      keyword: "alpha",
      targetDomain: "example.com",
    });
    assert.deepEqual(outcome, {
      status: "completed",
      result: {
        keywordId: "kw-1",
        keyword: "alpha",
        position: 3,
        url: "https://www.example.com/page",
        serpFeatures: ["organic"],
      },
    });
  } finally {
    restore();
  }
});

test("Maps task queue posts one task per coordinate, maps ids back by tag, and bills every entry", async () => {
  const calls: Array<[string | URL | Request, RequestInit | undefined]> = [];
  setup(async (url, init) => {
    calls.push([url, init]);
    return Response.json({
      status_code: 20000,
      tasks: [
        {
          id: "task-c",
          status_code: 20100,
          cost: 0.0012,
          data: { tag: "2" },
        },
        {
          status_code: 40501,
          status_message: "Invalid Field",
          cost: 0.0006,
          data: { tag: "1" },
        },
        {
          id: "task-a",
          status_code: 20100,
          cost: 0.0012,
          data: { tag: "0" },
        },
      ],
    });
  });

  try {
    const result = await postLocalSerpTasks({
      keyword: "coffee",
      locationCoordinates: ["1,1,13z", "2,2,13z", "3,3,13z"],
      languageCode: "en",
      device: "mobile",
      depth: 20,
    });

    const body = parseDataforseoRequestBody(calls[0][1]) as Array<Record<string, unknown>>;
    assert.equal(body.length, 3);
    assert.equal(body[0].location_coordinate, "1,1,13z");
    assert.equal(body[0].priority, 2);
    assert.equal(body[0].tag, "0");
    assert.equal(body[1].location_coordinate, "2,2,13z");
    assert.equal(body[1].priority, 2);
    assert.equal(body[1].tag, "1");
    assert.equal(body[2].location_coordinate, "3,3,13z");
    assert.equal(body[2].priority, 2);
    assert.equal(body[2].tag, "2");

    assert.deepEqual(result.data, ["task-a", null, "task-c"]);
    assert.ok(Math.abs(result.billing.costUsd - 0.003) < 1e-6);
  } finally {
    restore();
  }
});

test("Maps task queue keeps DataForSEO's charge when it rejects every entry", async () => {
  setup(async () =>
    Response.json({
      status_code: 20000,
      tasks: [
        {
          status_code: 40501,
          status_message: "Invalid Field: 'location_coordinate'.",
          cost: 0.0012,
          path: ["v3", "serp", "google", "maps", "task_post"],
          data: { tag: "0" },
        },
      ],
    }),
  );

  try {
    const posting = postLocalSerpTasks({
      keyword: "coffee",
      locationCoordinates: ["1,1,13z"],
      languageCode: "en",
      device: "mobile",
      depth: 20,
    });
    await assert.rejects(posting, (err: unknown) => {
      assert.ok(err instanceof ChargedCallError);
      assert.equal(err.actualUsd, 0.0012);
      return true;
    });
  } finally {
    restore();
  }
});

test("reads a queued Maps task as pending, its items once done, and No Search Results as an empty SERP", async () => {
  const items = [{ type: "maps_search", rank_absolute: 1, cid: "123" }];
  let callCount = 0;
  setup(async () => {
    callCount += 1;
    if (callCount === 1) {
      return Response.json({
        status_code: 20000,
        tasks: [{ status_code: 40602 }],
      });
    }
    if (callCount === 2) {
      return Response.json({
        status_code: 20000,
        tasks: [{ status_code: 20000, result: [{ items }] }],
      });
    }
    return Response.json({
      status_code: 20000,
      tasks: [
        { status_code: 40102, status_message: "No Search Results." },
      ],
    });
  });

  try {
    assert.deepEqual(await fetchLocalSerpTaskResult("task-a"), {
      status: "pending",
    });
    assert.deepEqual(await fetchLocalSerpTaskResult("task-a"), {
      status: "completed",
      items,
    });
    assert.deepEqual(await fetchLocalSerpTaskResult("task-b"), {
      status: "completed",
      items: [],
    });
  } finally {
    restore();
  }
});

test("task_post refuses an empty or oversized batch before dispatch as unbilled", async () => {
  let calls = 0;
  setup(async () => {
    calls += 1;
    return Response.json({ status_code: 20000, tasks: [] });
  });
  try {
    await assert.rejects(
      postLocalSerpTasks({ keyword: "k", locationCoordinates: [], languageCode: "en", device: "desktop", depth: 10 }),
      (error: unknown) => error instanceof UnbilledCallError,
    );
    await assert.rejects(
      postRankCheckTasks({ tasks: [], locationCode: 2356, languageCode: "en", depth: 10, targetDomain: "example.com" }),
      (error: unknown) => error instanceof UnbilledCallError,
    );
    assert.equal(calls, 0);
  } finally {
    restore();
  }
});
