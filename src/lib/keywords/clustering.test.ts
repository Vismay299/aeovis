import test from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import {
  CLUSTER_SYSTEM,
  clusterOutputSchema,
  validateClusters,
  buildClusterPrompt,
  estimateClusterPromptChars,
} from "./clustering.ts";

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
