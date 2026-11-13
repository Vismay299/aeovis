import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  CLUSTER_SYSTEM,
  clusterOutputSchema,
  validateClusters,
  buildClusterPrompt,
  estimateClusterPromptChars,
  runClusterJob,
  type ClusterJobDeps,
} from "./clustering.ts";
import { createMemorySavedKeywordsRepository } from "./memoryRepository.ts";
import { LONG_PAID_STEP } from "../jobs/stepConfigs.ts";

test("clusterOutputSchema parses valid output", () => {
  const o = {
    clusters: [
      {
        name: "Oversized tees",
        intent: "commercial",
        priority: "high",
        targetPage: "https://example.com/tees",
        rationale: "r",
        keywordIndexes: [0, 1],
      },
    ],
  };
  const parsed = clusterOutputSchema.parse(o);
  assert.equal(parsed.clusters.length, 1);
});

test("validateClusters drops out-of-range and repeated indexes", () => {
  const output = {
    clusters: [
      { name: "A", intent: "commercial" as const, priority: "high" as const, targetPage: null, rationale: "r", keywordIndexes: [0, 5, 1] },
      { name: "B", intent: "informational" as const, priority: "low" as const, targetPage: null, rationale: "r", keywordIndexes: [1, 2] },
    ],
  };
  const { clusters, unsorted } = validateClusters(output, 3);
  assert.equal(clusters.length, 2);
  assert.deepEqual(clusters[0].keywordIndexes, [0, 1]);
  assert.deepEqual(clusters[1].keywordIndexes, [2]);
  assert.deepEqual(unsorted, []);
});

test("validateClusters removes empty clusters and unassigned go to unsorted", () => {
  const output = {
    clusters: [
      { name: "A", intent: "commercial" as const, priority: "high" as const, targetPage: null, rationale: "r", keywordIndexes: [0] },
      { name: "B", intent: "informational" as const, priority: "low" as const, targetPage: null, rationale: "r", keywordIndexes: [10] },
    ],
  };
  const { clusters, unsorted } = validateClusters(output, 3);
  assert.equal(clusters.length, 1);
  assert.deepEqual(unsorted, [1, 2]);
});

test("validateClusters de-duplicates names with (2)", () => {
  const output = {
    clusters: [
      { name: "Tees", intent: "commercial" as const, priority: "high" as const, targetPage: null, rationale: "r", keywordIndexes: [0] },
      { name: "tees", intent: "informational" as const, priority: "low" as const, targetPage: null, rationale: "r", keywordIndexes: [1] },
    ],
  };
  const { clusters } = validateClusters(output, 2);
  assert.equal(clusters[0].name, "Tees");
  assert.equal(clusters[1].name, "tees (2)");
});

test("buildClusterPrompt contains unknown for null volume and no duplicate keywords", () => {
  const rows = [
    { keyword: "oversized tee", searchVolume: null, keywordDifficulty: null, intent: "unknown" },
    { keyword: "big tee", searchVolume: 100, keywordDifficulty: 20, intent: "commercial" },
  ];
  const p = buildClusterPrompt(rows, "");
  assert.match(p, /vol unknown/);
  assert.match(p, /kd unknown/);
  // no keyword appears twice? check lines count
  assert.equal(p.split("\n").filter((l) => l.startsWith("0 |")).length, 1);
  assert.equal(p.split("\n").filter((l) => l.startsWith("1 |")).length, 1);
});

test("estimateClusterPromptChars grows with keyword length", () => {
  const short = estimateClusterPromptChars([{ keyword: "a" }]);
  const long = estimateClusterPromptChars([{ keyword: "a".repeat(100) }]);
  assert.ok(long > short);
});

test("CLUSTER_SYSTEM contains key phrases", () => {
  assert.match(CLUSTER_SYSTEM, /page-level topics/);
  assert.match(CLUSTER_SYSTEM, /Use every keyword index exactly once/);
});

const llmClusterFixture = JSON.parse(
  await readFile(
    new URL("../../../tests/fixtures/f13/llm-cluster.json", import.meta.url),
    "utf8",
  ),
);

test("runClusterJob maps the llm-cluster.json fixture to a proposal without live calls", async () => {
  type LlmCall = Parameters<NonNullable<ClusterJobDeps["llmObject"]>>[0];
  const seen: LlmCall[] = [];
  const jobId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const repo = createMemorySavedKeywordsRepository();
  const names = Array.from({ length: 12 }, (_, i) => `fixture keyword ${i + 1}`);
  const saved = await repo.save({
    brandKey: "test-brand",
    keywords: names,
    locationCode: 2356,
    languageCode: "en",
  });
  assert.equal(saved.created, 12);
  const ids = saved.savedKeywordIds;
  const deps: ClusterJobDeps = {
    admin: {},
    repo,
    llmObject: async (i: LlmCall) => {
      seen.push(i);
      return llmClusterFixture;
    },
    getProjectContextByKey: (async () => ({
      sections: [],
      customSections: [],
      competitors: [],
      keyPages: [],
      researchLog: [],
      researchLogLimited: false,
    })) as unknown as ClusterJobDeps["getProjectContextByKey"],
    renderProjectContextMarkdown: () => "# Project context\n\nNo sections yet.",
    appendResearch: async () => {},
  };
  // A job context that memoises steps the way the F01 runner does.
  const memo = new Map<string, unknown>();
  const stepOptions: Record<string, unknown> = {};
  const jobCtx = {
    jobId,
    brandKey: "test-brand",
    payload: { savedKeywordIds: ids, approvedMaxUsd: 0.05, requestedBy: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" },
    step: {
      async do<T>(name: string, options: unknown, fn: () => Promise<T>): Promise<T> {
        stepOptions[name] = options;
        if (!memo.has(name)) memo.set(name, await fn());
        return memo.get(name) as T;
      },
    },
  };
  const result = await runClusterJob(jobCtx, deps);
  // A replay of the same job returns the memoised proposal without a new call.
  const replay = await runClusterJob(jobCtx, deps);
  assert.deepEqual(replay.result, result.result);
  assert.deepEqual(stepOptions.cluster, LONG_PAID_STEP);

  assert.equal(result.status, "completed");
  // The paid LLM runs exactly once: no replayed paid calls.
  assert.equal(seen.length, 1);
  const call = seen[0];
  assert.equal(call.brandKey, "test-brand");
  assert.equal(call.feature, "keywords.clustering");
  assert.equal(call.maxUsd, 0.05);
  assert.equal(call.idempotencyKey, `job:${jobId}:cluster`);
  assert.equal(call.maxOutputTokens, 8000);
  assert.equal(call.timeoutMs, 180000);
  assert.equal(call.model, undefined);
  assert.equal(call.schema, clusterOutputSchema);

  // Every keyword lands in exactly one topic; fixture has 8 + 4.
  assert.equal(result.result.clusters.length, 2);
  assert.equal(result.result.clusters[0].name, "Oversized tees");
  assert.equal(result.result.clusters[0].savedKeywordIds.length, 8);
  assert.equal(result.result.clusters[1].savedKeywordIds.length, 4);
  assert.deepEqual(result.result.unsorted, []);
  const assigned = result.result.clusters.flatMap((c) => c.savedKeywordIds).sort();
  assert.deepEqual(assigned, [...ids].sort());
  assert.equal(result.result.model, llmClusterFixture.model);
  assert.equal(result.result.usd, llmClusterFixture.usd);
});
