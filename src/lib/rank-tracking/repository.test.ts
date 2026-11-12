import test from "node:test";
import assert from "node:assert/strict";
import { createMemoryRankTrackingRepository } from "./memoryRepository.ts";
import { mapRepositoryError, type RankConfig, type RankRun } from "./repository.ts";

const now = () => new Date("2026-11-01T12:00:00.000Z");
function config(id = "c1", brand = "brand-a"): RankConfig {
  return { id, brand_key: brand, domain: `${id}.example`, location_code: 2840, language_code: "en", location_name: null,
    devices: "both", serp_depth: 40, schedule_interval: "weekly", is_active: true, last_checked_at: null,
    next_check_at: "2026-11-01T00:00:00.000Z", last_skip_reason: null, last_skip_at: null, approved_max_usd: 2,
    approval_id: null, created_by: null, created_at: "2026-10-01T00:00:00.000Z", updated_at: "2026-10-01T00:00:00.000Z" };
}
function run(id: string, configId: string, status: RankRun["status"], started: string, subset = false): RankRun {
  const c = config(configId);
  return { id, brand_key: c.brand_key, config_id: configId, job_id: null, trigger: "manual", method: "live", status,
    phase: null, domain: c.domain, location_code: c.location_code, language_code: c.language_code, location_name: null,
    devices: "both", serp_depth: 40, keyword_ids: [], is_subset_run: subset, keywords_total: 2, keywords_checked: 2,
    approved_max_usd: 2, reserved_usd: 0, error_code: null, error_message: null, created_by: null,
    started_at: started, completed_at: status === "completed" ? started : null };
}

test("memory repository scopes tenants and implements keyword, market, and schedule semantics", async () => {
  const repo = createMemoryRankTrackingRepository({ now, configs: [config(), config("c2", "brand-b")] });
  assert.equal(await repo.getConfig("brand-b", "c1"), null);
  assert.equal(await repo.findConfigByMarket("brand-a", "c1.example", 2840, "en", null)?.then((x) => x?.id), "c1");
  assert.equal(await repo.countActiveConfigs("brand-a"), 1);
  const [summary] = await repo.listSummaries("brand-a");
  assert.equal(summary.keyword_count, 0);
  assert.deepEqual(Object.keys(summary).sort(), [
    "approved_max_usd",
    "created_at",
    "devices",
    "domain",
    "id",
    "keyword_count",
    "language_code",
    "last_checked_at",
    "last_run_completed_at",
    "last_run_status",
    "last_skip_at",
    "last_skip_reason",
    "location_code",
    "location_name",
    "next_check_at",
    "schedule_interval",
    "serp_depth",
  ]);
  const ids = await repo.addKeywords("brand-a", "c1", [{ keyword: "first" }, { keyword: "first" }, { keyword: "second" }]);
  assert.equal(ids.length, 2);
  assert.equal((await repo.keywordCounts("brand-a", ["c1", "c2"])).get("c1"), 2);
  assert.equal((await repo.listKeywords("brand-b", "c1")).length, 0);
  await repo.setPinned("brand-a", "c1", [ids[0]], true);
  assert.ok((await repo.listKeywords("brand-a", "c1"))[0].pinned_at);
  await repo.updateKeywordMetrics("brand-a", [{ id: ids[0], search_volume: 42, metrics_source: "cache" }]);
  assert.equal((await repo.listKeywords("brand-a", "c1"))[0].search_volume, 42);
  assert.equal(await repo.removeKeywords("brand-a", "c1", [ids[1]]), 1);
  assert.equal(await repo.listDueConfigs("2026-11-02T00:00:00.000Z").then((rows) => rows.length), 2);
  assert.equal(await repo.claimConfig("brand-a", "c1", "stale", "2026-11-03T00:00:00.000Z"), false);
  assert.equal(await repo.claimConfig("brand-a", "c1", "2026-11-01T00:00:00.000Z", "2026-11-03T00:00:00.000Z", { reason: "no_keywords" }), true);
  assert.equal((await repo.getConfig("brand-a", "c1"))?.last_skip_reason, "no_keywords");
});

test("memory keyword addition validates the whole batch before mutating", async () => {
  const repo = createMemoryRankTrackingRepository({ now, configs: [config()] });

  await assert.rejects(
    repo.addKeywords("brand-a", "c1", [
      { keyword: "valid keyword" },
      { keyword: "INVALID LATER ROW" },
    ]),
    /Rank tracking could not be saved/,
  );

  assert.deepEqual(await repo.listKeywords("brand-a", "c1"), []);
});

test("run claims are single-active and reservations respect the approved maximum", async () => {
  const repo = createMemoryRankTrackingRepository({ now, configs: [config()] });
  const input = { id: "run-a", brand_key: "brand-a", config_id: "c1", trigger: "manual" as const, method: "live" as const, approved_max_usd: 1, keyword_ids: [], created_by: null };
  assert.equal(await repo.tryCreateRun(input), true);
  assert.equal(await repo.tryCreateRun({ ...input, id: "run-b" }), false);
  assert.equal((await repo.getActiveRun("brand-a", "c1"))?.id, "run-a");
  assert.equal(await repo.reserve("brand-a", "run-a", 0.6), true);
  assert.equal(await repo.reserve("brand-a", "run-a", 0.5), false);
  assert.equal((await repo.getRun("brand-b", "run-a")), null);
  await repo.setRunErrorIfEmpty("brand-a", "run-a", "first_error", "first");
  await repo.setRunErrorIfEmpty("brand-a", "run-a", "second_error", "second");
  assert.equal((await repo.getRun("brand-a", "run-a"))?.error_code, "first_error");
  await repo.updateRun("brand-a", "run-a", { status: "completed", completed_at: "2026-11-01T12:01:00.000Z" });
  assert.equal(await repo.tryCreateRun({ ...input, id: "run-b" }), true);
});

test("snapshot queries use completed full runs, date cutoffs, and disjoint trend buckets", async () => {
  const completed1 = run("r1", "c1", "completed", "2026-10-01T00:00:00.000Z");
  const completed2 = run("r2", "c1", "completed", "2026-10-02T00:00:00.000Z");
  const subset = run("r3", "c1", "completed", "2026-10-03T00:00:00.000Z", true);
  const pending = run("r4", "c1", "running", "2026-10-04T00:00:00.000Z");
  const rows = [
    { id: 1, brand_key: "brand-a", run_id: "r1", tracking_keyword_id: "k1", keyword: "alpha", device: "desktop" as const, position: 2, url: null, serp_features: [], checked_at: "2026-10-01T01:00:00.000Z" },
    { id: 2, brand_key: "brand-a", run_id: "r1", tracking_keyword_id: "k1", keyword: "alpha", device: "mobile" as const, position: null, url: null, serp_features: [], checked_at: "2026-10-01T01:00:00.000Z" },
    { id: 3, brand_key: "brand-a", run_id: "r2", tracking_keyword_id: "k1", keyword: "alpha", device: "desktop" as const, position: 8, url: null, serp_features: ["ai_overview"], checked_at: "2026-10-02T01:00:00.000Z" },
    { id: 4, brand_key: "brand-a", run_id: "r2", tracking_keyword_id: "k2", keyword: "beta", device: "desktop" as const, position: 16, url: null, serp_features: [], checked_at: "2026-10-02T01:00:00.000Z" },
    { id: 5, brand_key: "brand-a", run_id: "r3", tracking_keyword_id: "k1", keyword: "alpha", device: "desktop" as const, position: 1, url: null, serp_features: [], checked_at: "2026-10-03T01:00:00.000Z" },
    { id: 6, brand_key: "brand-a", run_id: "r4", tracking_keyword_id: "k1", keyword: "alpha", device: "desktop" as const, position: 1, url: null, serp_features: [], checked_at: "2026-10-04T01:00:00.000Z" },
  ];
  const repo = createMemoryRankTrackingRepository({ now, configs: [config()], runs: [completed1, completed2, subset, pending], snapshots: rows });
  assert.equal((await repo.latestSnapshots("brand-a", "c1"))[0].position, 1);
  assert.equal((await repo.latestSnapshots("brand-a", "c1", "2026-10-01T23:59:59.000Z")).find((x) => x.device === "desktop")?.position, 2);
  assert.deepEqual(await repo.bestPositions("brand-a", "c1"), [{ tracking_keyword_id: "k1", position: 1 }, { tracking_keyword_id: "k2", position: 16 }]);
  assert.equal((await repo.earliestSnapshots("brand-a", "c1", ["k1"])).find((x) => x.device === "desktop")?.position, 2);
  assert.equal((await repo.keywordHistory("brand-a", "c1", "k1", "2026-10-02T00:00:00.000Z")).length, 2);
  const trend = await repo.configTrend("brand-a", "c1", "desktop", "2026-10-01T00:00:00.000Z");
  assert.equal(trend.length, 2);
  assert.deepEqual([trend[1].top3, trend[1].top4to10, trend[1].top11to20, trend[1].ai_overview], [0, 1, 1, 1]);
  assert.equal((await repo.positionMatrix("brand-a", "c1", "desktop", 2)).length, 3);

  const mobileTrend = await repo.configTrend("brand-a", "c1", "mobile", "2026-10-01T00:00:00.000Z");
  assert.equal(mobileTrend.length, 2);
  assert.equal(mobileTrend[1].total, 0);
  assert.equal(mobileTrend[1].keywords_total - mobileTrend[1].total, 2);
  const mobileMatrix = await repo.positionMatrix("brand-a", "c1", "mobile", 2);
  assert.equal(mobileMatrix.length, 3);
  assert.ok(mobileMatrix.every((cell) => cell.position === null));

  const emptyRun = run("r5", "c1", "completed", "2026-10-05T00:00:00.000Z");
  const emptyRepo = createMemoryRankTrackingRepository({ now, configs: [config()], runs: [emptyRun] });
  assert.deepEqual(await emptyRepo.positionMatrix("brand-a", "c1", "desktop", 1), [
    {
      run_id: "r5",
      checked_at: "2026-10-05T00:00:00.000Z",
      tracking_keyword_id: null,
      position: null,
    },
  ]);
});

test("task persistence, expiration, pruning, and error mapping keep bounded semantics", async () => {
  const old = run("old", "c1", "failed", "2020-01-01T00:00:00.000Z");
  const live = run("live", "c1", "running", "2026-11-01T12:00:00.000Z");
  const repo = createMemoryRankTrackingRepository({ now, configs: [config()], runs: [old, live] });
  const task = { brand_key: "brand-a", run_id: "live", round: 0, tracking_keyword_id: "k1", keyword: "alpha", device: "mobile" as const, state: "planned" as const };
  await repo.insertTasks([task, task]);
  const listed = await repo.tasksByState("brand-a", "live", 0, ["planned"], 10);
  assert.equal(listed.length, 1);
  assert.equal(await repo.expireTasks("brand-a", "live", 0), 1);
  assert.equal((await repo.tasksByState("brand-a", "live", 0, ["expired"], 10))[0].state, "expired");
  assert.deepEqual(await repo.prune("2021-01-01T00:00:00.000Z", "2021-01-01T00:00:00.000Z", 10), { runs: 1, tasks: 0 });
  assert.equal(await repo.getRun("brand-a", "old"), null);
  assert.equal(mapRepositoryError({ message: "rank_config_not_found" }).code, "tracker_not_found");
  assert.equal(mapRepositoryError({ message: "rank_keywords_cap:1000" }).code, "keyword_limit");
  assert.equal(mapRepositoryError({ message: "unexpected" }).status, 503);
});
