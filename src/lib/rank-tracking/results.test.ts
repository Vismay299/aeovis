import test from "node:test";
import assert from "node:assert/strict";
import { getLatestResults, getKeywordHistory, getConfigTrend, getPositionMatrix } from "./results.ts";
import { createMemoryRankTrackingRepository } from "./memoryRepository.ts";

async function seed() {
  const repo = createMemoryRankTrackingRepository();
  const cfg = await repo.insertConfig({ brand_key: "brand-a", domain: "example.com", location_code: 2840, language_code: "en", location_name: null, devices: "both", serp_depth: 20, schedule_interval: "weekly", is_active: true, next_check_at: null, created_by: null } as any);
  const ids = await repo.addKeywords("brand-a", cfg.id, [{ keyword: "kw1" }, { keyword: "kw2" }]);
  const kws = await repo.listKeywords("brand-a", cfg.id);
  return { repo, cfg, kws, ids };
}

test("latest results compare 1d/7d with earliest fallback and checkedAt", async () => {
  const { repo, cfg, kws } = await seed();
  const past = new Date(Date.now() - 10 * 86400000).toISOString();
  const recent = new Date(Date.now() - 1000).toISOString();
  const run1 = crypto.randomUUID();
  await repo.tryCreateRun({ brand_key: "brand-a", config_id: cfg.id, id: run1, trigger: "manual", method: "live", approved_max_usd: 10, keyword_ids: [], created_by: null } as any);
  await repo.updateRun("brand-a", run1, { status: "completed", completed_at: past, keywords_total: 2 } as any);
  await repo.insertSnapshots([
    { brand_key: "brand-a", run_id: run1, tracking_keyword_id: kws[0].id, keyword: "kw1", device: "mobile", position: 9, url: null, serp_features: [], checked_at: past },
    { brand_key: "brand-a", run_id: run1, tracking_keyword_id: kws[0].id, keyword: "kw1", device: "desktop", position: 8, url: null, serp_features: [], checked_at: past },
  ]);
  const run2 = crypto.randomUUID();
  await repo.tryCreateRun({ brand_key: "brand-a", config_id: cfg.id, id: run2, trigger: "manual", method: "live", approved_max_usd: 10, keyword_ids: [], created_by: null } as any);
  await repo.updateRun("brand-a", run2, { status: "completed", completed_at: recent, keywords_total: 2 } as any);
  await repo.insertSnapshots([
    { brand_key: "brand-a", run_id: run2, tracking_keyword_id: kws[0].id, keyword: "kw1", device: "mobile", position: 7, url: "https://example.com/kw1", serp_features: ["ai_overview"], checked_at: recent },
  ]);
  const out = await getLatestResults({ brandKey: "brand-a" } as any, cfg.id, "7d", { repo } as any);
  assert.equal(out.rows.length, 2);
  const kw1 = out.rows.find((r: any) => r.keyword === "kw1");
  assert.equal(kw1.mobile.position, 7);
  assert.equal(kw1.mobile.previousPosition, 9);
  assert.equal(kw1.desktop.position, 8);
  assert.equal(kw1.mobile.checkedAt != null, true);
  // kw2 never checked
  const kw2 = out.rows.find((r: any) => r.keyword === "kw2");
  assert.equal(kw2.mobile.checkedAt, null);
  assert.equal(kw2.mobile.position, null);
  assert.equal(kw2.aiQuestion, null);
});

test("tracker must exist before any other read", async () => {
  const { repo } = await seed();
  await assert.rejects(() => getLatestResults({ brandKey: "brand-a" } as any, "00000000-0000-4000-8000-000000000000", "7d", { repo } as any), (e: any) => e.code === "tracker_not_found");
});

test("trend maps notRanking/notChecked, freshness from newest snapshot", async () => {
  const { repo, cfg, kws } = await seed();
  const runId = crypto.randomUUID();
  await repo.tryCreateRun({ brand_key: "brand-a", config_id: cfg.id, id: runId, trigger: "manual", method: "live", approved_max_usd: 10, keyword_ids: [], created_by: null } as any);
  await repo.updateRun("brand-a", runId, { status: "completed", keywords_total: 2 } as any);
  await repo.insertSnapshots([{ brand_key: "brand-a", run_id: runId, tracking_keyword_id: kws[0].id, keyword: "kw1", device: "mobile", position: 2, url: null, serp_features: ["ai_overview"], checked_at: new Date(Date.now() - 1000).toISOString() }]);
  const pts = await getConfigTrend({ brandKey: "brand-a" } as any, cfg.id, "mobile", 730, { repo } as any);
  assert.ok(pts.length >= 1);
  const p = pts[0];
  assert.equal(p.top3, 1);
  assert.equal(p.notRanking, 1);
  assert.equal(p.notChecked, 1);
  assert.equal(p.aiOverview, 1);
  assert.equal(p.checked, 1);
  const hist = await getKeywordHistory({ brandKey: "brand-a" } as any, cfg.id, kws[0].id, 90, { repo } as any);
  assert.ok(hist.length >= 1);
  const mat = await getPositionMatrix({ brandKey: "brand-a" } as any, cfg.id, "mobile", 12, { repo } as any);
  assert.ok(mat.length >= 1);
});
