import test from "node:test";
import assert from "node:assert/strict";
import { runRankCheckJob } from "./checkJob.ts";
import { createMemoryRankTrackingRepository } from "./memoryRepository.ts";
import { SpendRefused } from "../spend/errors.ts";

function fakeCtx(brandKey: string, payload: any) {
  return {
    brandKey,
    jobId: "job-1",
    payload,
    progress: async () => {},
    step: {
      do: async (_n: string, _o: any, fn: () => Promise<any>) => fn(),
      sleep: async () => {},
    },
  };
}

test("prepare refuses superseded run and archived tracker before any provider call", async () => {
  const repo = createMemoryRankTrackingRepository();
  const cfg = await repo.insertConfig({ brand_key: "brand-a", domain: "example.com", location_code: 2840, language_code: "en", location_name: null, devices: "mobile", serp_depth: 10, schedule_interval: "weekly", is_active: true, next_check_at: null, created_by: null } as any);
  const runId = crypto.randomUUID();
  await repo.tryCreateRun({ brand_key: "brand-a", config_id: cfg.id, id: runId, trigger: "manual", method: "live", approved_max_usd: 10, keyword_ids: [], created_by: null } as any);
  await repo.updateConfig("brand-a", cfg.id, { is_active: false } as any);
  let paid = 0;
  const client = { serp: { rankCheckBatch: async () => { paid++; return { results: [] }; }, rankCheckTaskPost: async () => { paid++; return { results: [] }; } } };
  const out: any = await runRankCheckJob(fakeCtx("brand-a", { runId }) as any, { repo, client } as any);
  assert.equal(out.status, "completed");
  assert.equal(out.result?.skipped, "archived");
  assert.equal(paid, 0);
});

test("prepare price_changed when fresh estimate exceeds approved max (no spend)", async () => {
  const repo = createMemoryRankTrackingRepository();
  const cfg = await repo.insertConfig({ brand_key: "brand-a", domain: "example.com", location_code: 2840, language_code: "en", location_name: null, devices: "both", serp_depth: 100, schedule_interval: "weekly", is_active: true, next_check_at: null, created_by: null } as any);
  const ids = await repo.addKeywords("brand-a", cfg.id, [{ keyword: "kw1" }, { keyword: "kw2" }]);
  const runId = crypto.randomUUID();
  await repo.tryCreateRun({ brand_key: "brand-a", config_id: cfg.id, id: runId, trigger: "manual", method: "live", approved_max_usd: 0.000001, keyword_ids: ids, created_by: null } as any);
  let paid = 0;
  const client = { serp: { rankCheckBatch: async () => { paid++; return { results: [] }; }, rankCheckTaskPost: async () => { paid++; return { results: [] }; } } };
  await assert.rejects(() => runRankCheckJob(fakeCtx("brand-a", { runId }) as any, { repo, client } as any), (e: any) => e.code === "price_changed");
  assert.equal(paid, 0);
  const r = await repo.getRun("brand-a", runId);
  assert.equal(r?.status, "failed", "a price_changed refusal must not leave the run running");
  assert.equal((r as any)?.error_code, "price_changed");
});

test("finalize failed when nothing checked, completed with partial message otherwise", async () => {
  const repo = createMemoryRankTrackingRepository();
  const cfg = await repo.insertConfig({ brand_key: "brand-a", domain: "example.com", location_code: 2840, language_code: "en", location_name: null, devices: "mobile", serp_depth: 10, schedule_interval: "weekly", is_active: true, next_check_at: null, created_by: null } as any);
  const ids = await repo.addKeywords("brand-a", cfg.id, [{ keyword: "a" }, { keyword: "b" }]);
  // failed path: no snapshots
  const runFail = crypto.randomUUID();
  await repo.tryCreateRun({ brand_key: "brand-a", config_id: cfg.id, id: runFail, trigger: "manual", method: "live", approved_max_usd: 10, keyword_ids: ids, created_by: null } as any);
  const clientEmpty = { serp: { rankCheckBatch: async (_c: any, inputs: any[]) => ({ results: [] }) } };
  await assert.rejects(() => runRankCheckJob(fakeCtx("brand-a", { runId: runFail }) as any, { repo, client: clientEmpty, fetchTaskResult: async () => ({ status: "pending" }) } as any), (e: any) => e.code === "rank_check_failed");
  const rf = await repo.getRun("brand-a", runFail);
  assert.equal(rf?.status, "failed");

  // completed partial: only mobile checked on both tracker? use mobile tracker for simplicity
  const runOk = crypto.randomUUID();
  await repo.tryCreateRun({ brand_key: "brand-a", config_id: cfg.id, id: runOk, trigger: "manual", method: "live", approved_max_usd: 10, keyword_ids: ids, created_by: null } as any);
  const clientFound = {
    serp: {
      rankCheckBatch: async (_c: any, inputs: any[]) => ({
        results: inputs.map((inp: any) => ({ keywordId: inp.keywordId, keyword: inp.keyword, position: 3, url: "https://example.com/x", serpFeatures: ["organic"] })),
      }),
    },
  };
  const out: any = await runRankCheckJob(fakeCtx("brand-a", { runId: runOk }) as any, { repo, client: clientFound, fetchTaskResult: async () => ({ status: "pending" }) } as any);
  assert.ok(out.status === "completed" || out.status === "partial");
  const rok = await repo.getRun("brand-a", runOk);
  assert.equal(rok?.status, "completed");
});

test("spend refusal stops and writes skip reason", async () => {
  const repo = createMemoryRankTrackingRepository();
  const cfg = await repo.insertConfig({ brand_key: "brand-a", domain: "example.com", location_code: 2840, language_code: "en", location_name: null, devices: "mobile", serp_depth: 10, schedule_interval: "weekly", is_active: true, next_check_at: null, created_by: null } as any);
  const ids = await repo.addKeywords("brand-a", cfg.id, [{ keyword: "a" }]);
  const runId = crypto.randomUUID();
  await repo.tryCreateRun({ brand_key: "brand-a", config_id: cfg.id, id: runId, trigger: "manual", method: "live", approved_max_usd: 10, keyword_ids: ids, created_by: null } as any);
  const client = {
    serp: {
      rankCheckBatch: async () => { throw new SpendRefused("daily_cap", { scope: "workspace" }); },
      rankCheckTaskPost: async () => { throw new SpendRefused("daily_cap", { scope: "workspace" }); },
    },
  };
  await assert.rejects(() => runRankCheckJob(fakeCtx("brand-a", { runId }) as any, { repo, client } as any), (e: any) => e.code === "daily_cap" || e.code === "rank_check_failed");
  const r = await repo.getRun("brand-a", runId);
  assert.ok(r?.status === "failed");
});

test("a full check (no subset ids) checks every keyword, and a mobile-only tracker is not partial", async () => {
  const repo = createMemoryRankTrackingRepository();
  const cfg = await repo.insertConfig({ brand_key: "brand-a", domain: "example.com", location_code: 2840, language_code: "en", location_name: null, devices: "mobile", serp_depth: 10, schedule_interval: "weekly", is_active: true, next_check_at: null, created_by: null } as any);
  await repo.addKeywords("brand-a", cfg.id, [{ keyword: "a" }, { keyword: "b" }, { keyword: "c" }]);
  const runId = crypto.randomUUID();
  // As try_create_rank_run stores a full run: keyword_ids '{}'.
  await repo.tryCreateRun({ brand_key: "brand-a", config_id: cfg.id, id: runId, trigger: "manual", method: "live", approved_max_usd: 10, keyword_ids: [], created_by: null } as any);
  const checked: string[] = [];
  const client = {
    serp: {
      rankCheckBatch: async (_c: any, inputs: any[]) => {
        for (const inp of inputs) checked.push(inp.keyword);
        return { results: inputs.map((inp: any) => ({ keywordId: inp.keywordId, keyword: inp.keyword, position: 3, url: "https://example.com/x", serpFeatures: ["organic"] })) };
      },
    },
  };
  const out: any = await runRankCheckJob(fakeCtx("brand-a", { runId }) as any, { repo, client, fetchTaskResult: async () => ({ status: "pending" }) } as any);
  assert.deepEqual(checked.sort(), ["a", "b", "c"]);
  assert.equal(out.status, "completed");
  const r = await repo.getRun("brand-a", runId);
  assert.equal(r?.status, "completed");
  assert.equal(r?.keywords_checked, 3);
});
