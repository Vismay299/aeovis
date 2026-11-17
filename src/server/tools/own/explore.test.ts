import test from "node:test";
import assert from "node:assert/strict";
import {
  createExploreQuestionTool,
  createGetExploreRunTool,
} from "./explore.ts";
import type { ToolHandlerContext } from "../types.ts";

function context(): ToolHandlerContext {
  return {
    admin: {} as any,
    brand: {
      brandKey: "brand-a",
      role: "owner",
      display_name: "Acme",
      website: "https://acme.test",
      website_host: "acme.test",
      aliases: [],
      is_active: true,
    },
    userId: "user-a",
    user: { id: "user-a", email: "owner@acme.test" },
    role: "owner",
    requestId: "test",
    source: "test",
  };
}

test("explore_question refuses a paid question without maxUsd before calling F11", async () => {
  let calls = 0;
  const tool = createExploreQuestionTool({
    startExploreRun: (async () => {
      calls += 1;
      return { runId: "run-1", jobId: null, status: "completed", pollAfterSeconds: null };
    }) as any,
  });

  await assert.rejects(() =>
    tool.handler(context(), { prompt: "best running shoes", models: ["chatgpt"] }),
  );
  assert.equal(calls, 0);
});

test("explore_question binds the workspace and passes the approved maximum to F11", async () => {
  let received: any;
  const tool = createExploreQuestionTool({
    startExploreRun: (async (_client: any, params: any) => {
      received = params;
      return { runId: "run-9", jobId: "job-1", status: "queued", pollAfterSeconds: 3 };
    }) as any,
  });

  const output = (await tool.handler(context(), {
    prompt: "best running shoes",
    models: ["chatgpt"],
    maxUsd: 0.5,
  })) as any;

  assert.deepEqual(output, { runId: "run-9", status: "queued", pollAfterSeconds: 3 });
  assert.equal(received.brandKey, "brand-a");
  assert.equal(received.userId, "user-a");
  assert.equal(received.body.maxUsd, 0.5);
  assert.equal(received.body.brand_key, undefined);
});

test("get_explore_run binds the workspace and reports every result as completed", async () => {
  let received: any;
  const tool = createGetExploreRunTool({
    getExploreRun: (async (_client: any, brandKey: string, runId: string) => {
      received = { brandKey, runId };
      return {
        runId,
        status: "completed",
        pollAfterSeconds: null,
        prompt: "best running shoes",
        highlightBrand: null,
        webSearch: true,
        country: null,
        createdAt: "2026-11-17T09:00:00.000Z",
        finishedAt: "2026-11-17T09:00:05.000Z",
        approvedMaxUsd: 0.5,
        cost: { knownUsd: 0.12, unknownModels: 0 },
        questionId: null,
        results: [
          { status: "success", model: "chatgpt" },
          { status: "error", model: "gemini" },
        ],
      };
    }) as any,
  });

  const output = (await tool.handler(context(), {
    runId: "9e8d0000-0000-4000-8000-000000000001",
  })) as any;

  assert.equal(received.brandKey, "brand-a");
  assert.equal(received.runId, "9e8d0000-0000-4000-8000-000000000001");
  assert.equal(output.completedModels, 2);
  assert.equal(output.results.length, 2);
});
