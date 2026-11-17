import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { createMemoryJobStore } from "../jobs/memoryStore.ts";
import { enqueueJob } from "../jobs/enqueue.ts";
import { runJob } from "../jobs/runner.ts";
import type { RunEnv } from "../jobs/runner.ts";
import { AppError } from "../../shared/http/errors.ts";
import { setKeywordJobsDeps } from "./jobs.ts";
import "./jobs.ts";
import { createMemorySavedKeywordsRepository } from "./memoryRepository.ts";
import type { KeywordMetricsClient } from "../../shared/providers/dataforseo/keyword-metrics.ts";

const BRAND = "refresh-test-brand";
const OWNER = "tick:test";
const AT = Date.parse("2026-11-10T12:00:00.000Z");
const BUDGET_MS = 240_000;

function createTestHarness() {
  let now = AT;
  const clock = {
    at: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
  const store = createMemoryJobStore({ now: clock.at });
  const continues: string[] = [];
  const runEnvironment: RunEnv = {
    store,
    owner: OWNER,
    deadlineMs: now + BUDGET_MS,
    now: clock.at,
    selfContinue: (id: string) => {
      continues.push(id);
    },
  };
  return { store, clock, continues, runEnvironment };
}

describe("keywords.refresh_metrics job", () => {
  test("only stale keywords are requested and fresh are skipped", async () => {
    const h = createTestHarness();
    const repo = createMemorySavedKeywordsRepository({
      keywords: [
        {
          id: "k1",
          brandKey: BRAND,
          keyword: "stale kw",
          locationCode: 2840,
          languageCode: "en",
          createdAt: new Date(AT - 10 * 86_400_000).toISOString(),
        },
        {
          id: "k2",
          brandKey: BRAND,
          keyword: "fresh kw",
          locationCode: 2840,
          languageCode: "en",
          createdAt: new Date(AT - 10 * 86_400_000).toISOString(),
        },
      ],
      metrics: [
        {
          keyword: "stale kw",
          locationCode: 2840,
          languageCode: "en",
          searchVolume: 100,
          cpc: 1.0,
          competition: 0.5,
          keywordDifficulty: 50,
          intent: "commercial",
          monthlySearches: [],
          fetchedAt: new Date(AT - 10 * 86_400_000).toISOString(), // > 7 days ago -> stale
        },
        {
          keyword: "fresh kw",
          locationCode: 2840,
          languageCode: "en",
          searchVolume: 200,
          cpc: 2.0,
          competition: 0.2,
          keywordDifficulty: 20,
          intent: "informational",
          monthlySearches: [],
          fetchedAt: new Date(AT - 2 * 86_400_000).toISOString(), // 2 days ago -> fresh
        },
      ],
    });

    const requestedKeywords: string[] = [];
    const client: KeywordMetricsClient = {
      labs: {
        keywordOverview: async (_ctx, params) => {
          requestedKeywords.push(...params.keywords);
          return params.keywords.map((kw) => ({
            keyword: kw,
            keyword_info: { search_volume: 150, cpc: 1.5, competition: 0.4 },
            keyword_properties: { keyword_difficulty: 45 },
            search_intent_info: { main_intent: "commercial" },
          })) as any;
        },
      },
      ads: {
        adsSearchVolume: async () => [],
      },
    };

    let logAppended = false;
    setKeywordJobsDeps({
      refresh: {
        repo,
        admin: {} as any,
        client,
        now: () => new Date(AT),
        appendResearch: async () => {
          logAppended = true;
        },
      },
    });

    const { jobId } = await enqueueJob(
      "keywords.refresh_metrics",
      { approvedMaxUsd: 10, requestedBy: "11111111-1111-4111-8111-111111111111" },
      { brandKey: BRAND, singleActiveKey: `keywords.refresh:${BRAND}` },
      { store: h.store },
    );

    const claimed = await h.store.claimDue(OWNER, 1, 300, jobId);
    assert.equal(claimed.length, 1);
    const outcome = await runJob(claimed[0], h.runEnvironment);
    const refreshedJob = h.store.jobs.get(jobId)!;
    assert.equal(outcome, "completed");
    assert.equal(refreshedJob.status, "completed");
    const result = refreshedJob.result as any;
    assert.equal(result.updated, 1);
    assert.equal(result.requested, 1);
    assert.equal(result.skippedFresh, 1);
    assert.equal(result.failedBatches, 0);
    assert.equal(result.totalBatches, 1);
    assert.deepEqual(requestedKeywords, ["stale kw"]);
    assert.equal(logAppended, true);
  });

  test("batches of 700 per market with stable step names and progress calls", async () => {
    const h = createTestHarness();
    const keywords: any[] = [];
    for (let i = 0; i < 750; i++) {
      keywords.push({
        id: `kw_${i}`,
        brandKey: BRAND,
        keyword: `keyword_${String(i).padStart(4, "0")}`,
        locationCode: 2840,
        languageCode: "en",
        createdAt: new Date(AT - 10 * 86_400_000).toISOString(),
      });
    }

    const repo = createMemorySavedKeywordsRepository({ keywords });
    const batchCalls: number[] = [];
    const client: KeywordMetricsClient = {
      labs: {
        keywordOverview: async (_ctx, params) => {
          batchCalls.push(params.keywords.length);
          return params.keywords.map((kw) => ({
            keyword: kw,
            keyword_info: { search_volume: 50 },
          })) as any;
        },
      },
      ads: { adsSearchVolume: async () => [] },
    };

    setKeywordJobsDeps({
      refresh: {
        repo,
        client,
        now: () => new Date(AT),
        appendResearch: async () => {},
      },
    });

    const { jobId } = await enqueueJob(
      "keywords.refresh_metrics",
      { approvedMaxUsd: 10, requestedBy: "11111111-1111-4111-8111-111111111111" },
      { brandKey: BRAND, singleActiveKey: `keywords.refresh:${BRAND}` },
      { store: h.store },
    );

    const claimed = await h.store.claimDue(OWNER, 1, 300, jobId);
    assert.equal(claimed.length, 1);
    const outcome = await runJob(claimed[0], h.runEnvironment);
    assert.equal(outcome, "completed");

    // Two batches: 700 and 50
    assert.deepEqual(batchCalls, [700, 50]);

    const steps = [...h.store.steps.values()].filter((s) => s.job_id === jobId);
    const stepNames = steps.map((s) => s.name);
    assert.ok(stepNames.includes("plan"));
    assert.ok(stepNames.includes("batch:2840:en:0"));
    assert.ok(stepNames.includes("batch:2840:en:1"));

    const refreshedJob = h.store.jobs.get(jobId)!;
    assert.equal(refreshedJob.progress_done, 2);
    assert.equal(refreshedJob.progress_total, 2);
    assert.equal(refreshedJob.progress_label, "Updating keyword stats");
  });

  test("over-approved max USD guard stops and finishes partial", async () => {
    const h = createTestHarness();
    const keywords: any[] = [];
    for (let i = 0; i < 750; i++) {
      keywords.push({
        id: `kw_${i}`,
        brandKey: BRAND,
        keyword: `keyword_${String(i).padStart(4, "0")}`,
        locationCode: 2840,
        languageCode: "en",
        createdAt: new Date(AT - 10 * 86_400_000).toISOString(),
      });
    }

    const repo = createMemorySavedKeywordsRepository({ keywords });
    let batchCount = 0;
    const client: KeywordMetricsClient = {
      labs: {
        keywordOverview: async (_ctx, params) => {
          batchCount++;
          return params.keywords.map((kw) => ({
            keyword: kw,
            keyword_info: { search_volume: 50 },
          })) as any;
        },
      },
      ads: { adsSearchVolume: async () => [] },
    };

    setKeywordJobsDeps({
      refresh: {
        repo,
        client,
        now: () => new Date(AT),
        appendResearch: async () => {},
      },
    });

    // 700 keywords in batch 0 costs ~ 0.012 + 700 * 0.00012 = 0.096.
    // If approvedMaxUsd is 0.10, batch 0 succeeds (0.096 <= 0.10),
    // but batch 1 (needs another 0.012 + 50 * 0.00012 = 0.018, total 0.114 > 0.10) exceeds approvedMaxUsd!
    const { jobId } = await enqueueJob(
      "keywords.refresh_metrics",
      { approvedMaxUsd: 0.10, requestedBy: "11111111-1111-4111-8111-111111111111" },
      { brandKey: BRAND, singleActiveKey: `keywords.refresh:${BRAND}` },
      { store: h.store },
    );

    const claimed = await h.store.claimDue(OWNER, 1, 300, jobId);
    assert.equal(claimed.length, 1);
    const outcome = await runJob(claimed[0], h.runEnvironment);
    assert.equal(outcome, "partial");

    assert.equal(batchCount, 1);
    const refreshedJob = h.store.jobs.get(jobId)!;
    assert.equal(refreshedJob.status, "partial");
    const result = refreshedJob.result as any;
    assert.equal(result.stoppedFor, "over_approved_max");
    assert.equal(result.updated, 700);
  });

  test("a failing batch makes job partial and later batches continue", async () => {
    const h = createTestHarness();
    const keywords: any[] = [];
    for (let i = 0; i < 750; i++) {
      keywords.push({
        id: `kw_${i}`,
        brandKey: BRAND,
        keyword: `keyword_${String(i).padStart(4, "0")}`,
        locationCode: 2840,
        languageCode: "en",
        createdAt: new Date(AT - 10 * 86_400_000).toISOString(),
      });
    }

    const repo = createMemorySavedKeywordsRepository({ keywords });
    let calls = 0;
    const client: KeywordMetricsClient = {
      labs: {
        keywordOverview: async (_ctx, params) => {
          calls++;
          if (calls === 1) {
            throw new Error("Provider temporary network failure");
          }
          return params.keywords.map((kw) => ({
            keyword: kw,
            keyword_info: { search_volume: 50 },
          })) as any;
        },
      },
      ads: { adsSearchVolume: async () => [] },
    };

    setKeywordJobsDeps({
      refresh: {
        repo,
        client,
        now: () => new Date(AT),
        appendResearch: async () => {},
      },
    });

    const { jobId } = await enqueueJob(
      "keywords.refresh_metrics",
      { approvedMaxUsd: 10, requestedBy: "11111111-1111-4111-8111-111111111111" },
      { brandKey: BRAND, singleActiveKey: `keywords.refresh:${BRAND}` },
      { store: h.store },
    );

    const claimed = await h.store.claimDue(OWNER, 1, 300, jobId);
    assert.equal(claimed.length, 1);
    const outcome = await runJob(claimed[0], h.runEnvironment);
    assert.equal(outcome, "partial");

    assert.equal(calls, 2);
    const refreshedJob = h.store.jobs.get(jobId)!;
    assert.equal(refreshedJob.status, "partial");
    const result = refreshedJob.result as any;
    assert.equal(result.failedBatches, 1);
    assert.equal(result.totalBatches, 2);
    assert.equal(result.updated, 50); // Second batch succeeded
  });

  test("second enqueue with same singleActiveKey throws 409 job_already_running", async () => {
    const h = createTestHarness();
    await enqueueJob(
      "keywords.refresh_metrics",
      { approvedMaxUsd: 10, requestedBy: "11111111-1111-4111-8111-111111111111" },
      { brandKey: BRAND, singleActiveKey: `keywords.refresh:${BRAND}` },
      { store: h.store },
    );

    await assert.rejects(
      async () => {
        await enqueueJob(
          "keywords.refresh_metrics",
          { approvedMaxUsd: 10, requestedBy: "11111111-1111-4111-8111-111111111111" },
          { brandKey: BRAND, singleActiveKey: `keywords.refresh:${BRAND}` },
          { store: h.store },
        );
      },
      (err: unknown) => {
        assert(err instanceof AppError);
        assert.equal(err.status, 409);
        assert.equal(err.code, "job_already_running");
        return true;
      },
    );
  });
});
