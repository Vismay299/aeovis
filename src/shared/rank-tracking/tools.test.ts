import test from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import {
  listRankTrackersTool,
  listRankTrackersInput,
  listRankTrackersOutput,
  getRankTrackerTool,
  getRankTrackerInput,
  getRankTrackerOutput,
  addRankTrackingKeywordsTool,
  addRankTrackingKeywordsInput,
  addRankTrackingKeywordsOutput,
  runRankCheckTool,
  runRankCheckInput,
  runRankCheckOutput,
  type RankTrackingToolContext,
} from "./tools.ts";
import { AppError } from "../http/appError.ts";

const VALID_CONFIG_ID = "50000000-0000-4000-8000-000000000001";
const VALID_KEYWORD_ID = "60000000-0000-4000-8000-000000000001";

test("list_rank_trackers tool", async (t) => {
  await t.test("input schema is closed (rejects unknown properties)", () => {
    assert.throws(
      () => listRankTrackersInput.parse({ unexpectedKey: "disallowed" }),
      (err: unknown) => err instanceof z.ZodError,
    );
  });

  await t.test("output schema parses loosely", () => {
    const parsed = listRankTrackersOutput.parse({
      summaries: [{ id: VALID_CONFIG_ID, domain: "perceev.com" }],
      extraProp: 123,
    });
    assert.equal(parsed.summaries.length, 1);
  });

  await t.test("handler lists summaries", async () => {
    const ctx: RankTrackingToolContext = {
      admin: {} as any,
      brand: { brandKey: "acme" },
      deps: {
        listTrackers: async (ws) => {
          assert.equal(ws.brandKey, "acme");
          return [{ id: VALID_CONFIG_ID, domain: "acme.com" }];
        },
      },
    };
    const res = await listRankTrackersTool.handler(ctx, {});
    assert.equal(res.summaries.length, 1);
  });
});

test("get_rank_tracker tool", async (t) => {
  await t.test("input schema is closed and validates fields", () => {
    assert.throws(
      () => getRankTrackerInput.parse({ configId: "invalid-uuid" }),
      (err: unknown) => err instanceof z.ZodError,
    );
    assert.throws(
      () => getRankTrackerInput.parse({ configId: VALID_CONFIG_ID, extra: true }),
      (err: unknown) => err instanceof z.ZodError,
    );
    const parsed = getRankTrackerInput.parse({ configId: VALID_CONFIG_ID, compare: "30d" });
    assert.equal(parsed.configId, VALID_CONFIG_ID);
    assert.equal(parsed.compare, "30d");
  });

  await t.test("output schema parses loosely", () => {
    const parsed = getRankTrackerOutput.parse({
      config: { id: VALID_CONFIG_ID },
      rows: [{ keyword: "test" }],
      run: null,
      extraProp: "yes",
    });
    assert.equal(parsed.rows.length, 1);
    assert.equal(parsed.run, null);
  });

  await t.test("handler sorts pinned keywords first and limits to 200", async () => {
    const rows: Array<{ trackingKeywordId: string; keyword: string; pinned: boolean }> = [];
    for (let i = 0; i < 250; i++) {
      rows.push({
        trackingKeywordId: `kw-${i}`,
        keyword: `keyword ${i}`,
        pinned: i === 220 || i === 240, // only two are pinned, deep in array
      });
    }

    const ctx: RankTrackingToolContext = {
      admin: {} as any,
      brand: { brandKey: "acme" },
      deps: {
        getTracker: async (_ws, configId) => {
          assert.equal(configId, VALID_CONFIG_ID);
          return { tracker: { id: configId, domain: "acme.com" } };
        },
        getLatestResults: async (_ws, configId, compare) => {
          assert.equal(configId, VALID_CONFIG_ID);
          assert.equal(compare, "7d");
          return { rows, run: { id: "run-1", status: "completed" } };
        },
      },
    };

    const res = await getRankTrackerTool.handler(ctx, { configId: VALID_CONFIG_ID });
    assert.equal(res.rows.length, 200);
    // First two must be the pinned ones
    assert.equal(res.rows[0].pinned, true);
    assert.equal(res.rows[1].pinned, true);
    assert.equal(res.rows[2].pinned, false);
    assert.equal((res.run as any).status, "completed");
  });
});

test("add_rank_tracking_keywords tool", async (t) => {
  await t.test("input schema validation", () => {
    assert.throws(
      () => addRankTrackingKeywordsInput.parse({ configId: VALID_CONFIG_ID, keywords: [] }),
      (err: unknown) => err instanceof z.ZodError,
    );
    assert.throws(
      () =>
        addRankTrackingKeywordsInput.parse({
          configId: VALID_CONFIG_ID,
          keywords: ["seo"],
          extra: 123,
        }),
      (err: unknown) => err instanceof z.ZodError,
    );
  });

  await t.test("handler delegates to addKeywords", async () => {
    let called = false;
    const ctx: RankTrackingToolContext = {
      admin: {} as any,
      brand: { brandKey: "acme" },
      deps: {
        addKeywords: async (ws, configId, body) => {
          called = true;
          assert.equal(ws.brandKey, "acme");
          assert.equal(configId, VALID_CONFIG_ID);
          assert.deepEqual(body.keywords, ["perceev", "rank tracker"]);
          assert.equal(body.maxUsd, 2.5);
          return {
            added: 2,
            addedIds: ["id-1", "id-2"],
            skipped: 0,
            metricsFromCache: 1,
            approval: null,
          };
        },
      },
    };

    const res = await addRankTrackingKeywordsTool.handler(ctx, {
      configId: VALID_CONFIG_ID,
      keywords: ["perceev", "rank tracker"],
      maxUsd: 2.5,
    });
    assert.equal(called, true);
    assert.equal(res.added, 2);
  });
});

test("run_rank_check tool", async (t) => {
  await t.test("input schema enforces strictly positive maxUsd <= 50", () => {
    assert.throws(
      () =>
        runRankCheckInput.parse({
          configId: VALID_CONFIG_ID,
          maxUsd: 0,
        }),
      (err: unknown) => err instanceof z.ZodError,
    );
    assert.throws(
      () =>
        runRankCheckInput.parse({
          configId: VALID_CONFIG_ID,
          maxUsd: 55,
        }),
      (err: unknown) => err instanceof z.ZodError,
    );
    assert.throws(
      () =>
        runRankCheckInput.parse({
          configId: VALID_CONFIG_ID,
          // missing maxUsd
        }),
      (err: unknown) => err instanceof z.ZodError,
    );
  });

  await t.test("handler refuses when tracker archived or no keywords", async () => {
    const mockRepo = {
      getConfig: async () => ({ id: VALID_CONFIG_ID, is_active: false }),
      listKeywords: async () => [],
    };
    const ctx: RankTrackingToolContext = {
      admin: {} as any,
      brand: { brandKey: "acme" },
      deps: { repo: mockRepo as any },
    };

    await assert.rejects(
      () => runRankCheckTool.handler(ctx, { configId: VALID_CONFIG_ID, maxUsd: 5 }),
      (err: any) => err instanceof AppError && err.code === "tracker_archived",
    );

    mockRepo.getConfig = async () => ({ id: VALID_CONFIG_ID, is_active: true });
    await assert.rejects(
      () => runRankCheckTool.handler(ctx, { configId: VALID_CONFIG_ID, maxUsd: 5 }),
      (err: any) => err instanceof AppError && err.code === "no_keywords",
    );
  });

  await t.test("handler checks approval and begins run", async () => {
    let approvedCalled = false;
    let beginCalled = false;
    const mockRepo = {
      getConfig: async () => ({ id: VALID_CONFIG_ID, is_active: true, location_code: 2840 }),
      listKeywords: async () => [{ id: VALID_KEYWORD_ID, keyword: "perceev" }],
    };
    const ctx: RankTrackingToolContext = {
      admin: {} as any,
      brand: { brandKey: "acme" },
      deps: {
        repo: mockRepo as any,
        requireApprovedPrice: async (_action, _pCtx, _input, maxUsd) => {
          approvedCalled = true;
          assert.equal(maxUsd, 10);
          return { approvedMaxUsd: 1.25, quote: {} as any, source: "dialog" };
        },
        beginRankCheckRun: async (_ws, input) => {
          beginCalled = true;
          assert.equal(input.configId, VALID_CONFIG_ID);
          assert.equal(input.approvedMaxUsd, 1.25);
          return { ok: true, runId: "run-abc", jobId: "job-xyz" };
        },
      },
    };

    const res = await runRankCheckTool.handler(ctx, {
      configId: VALID_CONFIG_ID,
      maxUsd: 10,
    });
    assert.equal(approvedCalled, true);
    assert.equal(beginCalled, true);
    assert.equal(res.runId, "run-abc");
    assert.equal(res.jobId, "job-xyz");
    assert.equal(res.status, "queued");
    assert.equal(res.pollAfterSeconds, 3);
  });

  await t.test("handler throws 409 if check already running", async () => {
    const mockRepo = {
      getConfig: async () => ({ id: VALID_CONFIG_ID, is_active: true }),
      listKeywords: async () => [{ id: VALID_KEYWORD_ID, keyword: "perceev" }],
    };
    const ctx: RankTrackingToolContext = {
      admin: {} as any,
      brand: { brandKey: "acme" },
      deps: {
        repo: mockRepo as any,
        requireApprovedPrice: async () => ({ approvedMaxUsd: 1.0, quote: {} as any, source: "dialog" }),
        beginRankCheckRun: async () => ({ ok: false, reason: "already_running", activeRunId: "run-active" }),
      },
    };

    await assert.rejects(
      () => runRankCheckTool.handler(ctx, { configId: VALID_CONFIG_ID, maxUsd: 5 }),
      (err: any) => err instanceof AppError && err.code === "rank_check_running",
    );
  });
});
