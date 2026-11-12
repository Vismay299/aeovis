// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu): src/shared/rank-tracking.test.ts.
import test from "node:test";
import assert from "node:assert/strict";
import { estimatePairsUsd, estimateRankCheckUsd, estimateScheduledRankCheckUsd } from "./cost.ts";

test("estimateRankCheckUsd matches the raw USD parity cases", () => {
  assert.equal(estimateRankCheckUsd(Array(4).fill("keyword"), "desktop", 10, "live").totalUsd, 0.0128);
  assert.equal(estimateRankCheckUsd(Array(1000).fill("keyword"), "both", 40, "live").totalUsd, 20.8);
  assert.equal(estimateRankCheckUsd(Array(104).fill("keyword"), "desktop", 10, "queued").totalUsd, 0.1872);
  assert.equal(estimateRankCheckUsd(Array(1000).fill("keyword"), "both", 40, "queued").totalUsd, 11.7);
});

test("operator keywords are multiplied by five, including pair estimates", () => {
  const ordinary = estimateRankCheckUsd(["keyword"], "mobile", 10, "live");
  const operator = estimateRankCheckUsd(["site:example.com"], "mobile", 10, "live");
  assert.equal(operator.checkUsd, ordinary.checkUsd * 5);
  assert.equal(estimatePairsUsd([{ keyword: "site:x" }], 10, "queued"), 0.003);
});

test("weekly scheduled estimate multiplies the queued per-check amount by four", () => {
  const estimate = estimateScheduledRankCheckUsd(["keyword"], "mobile", 10, "weekly");
  assert.equal(estimate.runsPerMonth, 4);
  assert.equal(estimate.monthlyUsd, estimate.perCheckUsd * 4);
});
