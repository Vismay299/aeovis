// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu): src/server/features/rank-tracking/services/scheduledRankChecks.test.ts.
import test from "node:test";
import assert from "node:assert/strict";
import { admitByUnitBudget } from "./schedules.ts";

test("zero-unit configs are admitted without consuming the budget", () => {
  const result = admitByUnitBudget([
    { id: "empty", keywordCount: 0, devices: "both" },
    { id: "one", keywordCount: 10, devices: "mobile" },
  ], 10);
  assert.deepEqual(result.admitted.map((config) => config.id), ["empty", "one"]);
  assert.equal(result.unitsStarted, 10);
});

test("first non-empty config is admitted even when it exceeds the budget", () => {
  const result = admitByUnitBudget([
    { id: "large", keywordCount: 1000, devices: "both" },
    { id: "next", keywordCount: 1, devices: "mobile" },
  ], 1000);
  assert.deepEqual(result.admitted.map((config) => config.id), ["large"]);
  assert.deepEqual(result.deferred.map((config) => config.id), ["next"]);
});

test("the first overflow defers the rest of the list", () => {
  const result = admitByUnitBudget([
    { id: "a", keywordCount: 600, devices: "mobile" },
    { id: "b", keywordCount: 401, devices: "mobile" },
    { id: "c", keywordCount: 0, devices: "mobile" },
  ], 1000);
  assert.deepEqual(result.admitted.map((config) => config.id), ["a"]);
  assert.deepEqual(result.deferred.map((config) => config.id), ["b", "c"]);
  assert.equal(result.stoppedByBudget, true);
});
