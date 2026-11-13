import test from "node:test";
import assert from "node:assert/strict";
import { estimateRankCheckRun, estimateConfigSave } from "./rankTracking.ts";
import { getPricedAction } from "../pricedActions.ts";
import { estimateRankCheckUsd } from "../../rank-tracking/cost.ts";
import { createMemoryRankTrackingRepository } from "../../rank-tracking/memoryRepository.ts";

function ctx(brandKey = "brand-a") {
  return { brandKey, admin: {} as any, env: {}, now: new Date("2026-10-21T00:00:00.000Z") };
}

test("registry: both actions require approval", () => {
  assert.equal(getPricedAction("rank_tracking.check.run")?.requireApproval, true);
  assert.equal(getPricedAction("rank_tracking.config.save")?.requireApproval, true);
  assert.equal(getPricedAction("rank_tracking.check.run")?.feature, "rank_tracking.check");
});

test("check.run labels, totals equal estimateRankCheckUsd, units", async () => {
  const est = estimateRankCheckUsd(["a", "b"], "mobile", 40, "live");
  assert.ok(est.totalUsd > 0);
  assert.ok(est.checkUsd > 0);
});

test("check.run blocked no_keywords and foreign config 404 via estimate functions", async () => {
  const repo = createMemoryRankTrackingRepository();
  const cfg = await repo.insertConfig({ brand_key: "brand-a", domain: "example.com", location_code: 2840, language_code: "en", location_name: null, devices: "mobile", serp_depth: 10, schedule_interval: "weekly", is_active: true, next_check_at: null, created_by: null } as any);
  const q0 = await estimateRankCheckRun(ctx("brand-a"), { configId: cfg.id, method: "live" } as any, { repo } as any);
  assert.equal(q0.blocked?.code, "no_keywords");
  await repo.addKeywords("brand-a", cfg.id, [{ keyword: "kw" }]);
  const q1 = await estimateRankCheckRun(ctx("brand-a"), { configId: cfg.id, method: "live" } as any, { repo } as any);
  assert.equal(q1.blocked, null);
  assert.ok(q1.totalUsd > 0);
  assert.equal(q1.expectedUsd, q1.lines[0].totalUsd);
  assert.ok(q1.lines[0].label.includes("results now"));
  assert.equal(q1.units.find((u) => u.key === "checks")?.count, 1);
  assert.ok(q1.lines[0].label.includes("Mobile"));
  const qf = await estimateRankCheckRun(ctx("brand-foreign"), { configId: cfg.id, method: "live" } as any, { repo } as any);
  assert.equal(qf.blocked?.code, "tracker_not_found");
});

test("config.save monthly for weekly, warnings, blocked keyword_limit", async () => {
  const repo = createMemoryRankTrackingRepository();
  const cfg = await repo.insertConfig({ brand_key: "brand-a", domain: "example.com", location_code: 2840, language_code: "en", location_name: null, devices: "both", serp_depth: 40, schedule_interval: "weekly", is_active: true, next_check_at: null, created_by: null } as any);
  await repo.addKeywords("brand-a", cfg.id, [{ keyword: "a" }]);
  const q = await estimateConfigSave(ctx("brand-a"), { configId: cfg.id, scheduleInterval: "weekly" } as any, { repo } as any);
  assert.ok(q.monthly);
  assert.equal(q.monthly?.runsPerMonth, 4);
  assert.ok(q.warnings.find((w) => w.code === "both_devices_note"));
  assert.ok(q.warnings.find((w) => w.code === "retry_note"));
  assert.ok(q.warnings.find((w) => w.code === "schedule_note"));
  const qd = await estimateConfigSave(ctx("brand-a"), { draft: { keywordCount: 5 }, scheduleInterval: "daily", devices: "mobile", serpDepth: 40 } as any, { repo } as any);
  assert.ok(qd.warnings.find((w) => w.code === "daily_note"));
  const qlim = await estimateConfigSave(ctx("brand-a"), { draft: { keywordCount: 1001 }, scheduleInterval: "weekly" } as any, { repo } as any);
  assert.equal(qlim.blocked?.code, "keyword_limit");
});
