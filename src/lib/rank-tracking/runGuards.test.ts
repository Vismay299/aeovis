import test from "node:test";
import assert from "node:assert/strict";
import { beginRankCheckRun, failRunIfActive, staleReason, getLatestRunView } from "./runGuards.ts";
import { createMemoryRankTrackingRepository } from "./memoryRepository.ts";
import { AppError } from "../http/appError.ts";

function repoWithConfig(brand = "brand-a") {
  const repo = createMemoryRankTrackingRepository();
  return repo;
}

test("second check returns already_running with activeRunId", async () => {
  const repo = repoWithConfig();
  const cfg = await repo.insertConfig({ brand_key: "brand-a", domain: "example.com", location_code: 2840, language_code: "en", location_name: null, devices: "mobile", serp_depth: 10, schedule_interval: "weekly", is_active: true, next_check_at: null, created_by: null } as any);
  const fakeEnqueue = async () => ({ jobId: "job-1", deduped: false });
  const fakeRunning = async () => ({ status: "running" });
  const r1 = await beginRankCheckRun({ brandKey: "brand-a", userId: "u1" }, { configId: cfg.id, trigger: "manual", approvedMaxUsd: 5 }, { repo, enqueueJob: fakeEnqueue as any, getJobStatus: fakeRunning as any } as any);
  assert.equal(r1.ok, true);
  const r2 = await beginRankCheckRun({ brandKey: "brand-a", userId: "u1" }, { configId: cfg.id, trigger: "manual", approvedMaxUsd: 5 }, { repo, enqueueJob: fakeEnqueue as any, getJobStatus: fakeRunning as any } as any);
  assert.equal(r2.ok, false);
  if (!r2.ok) assert.ok((r2 as any).activeRunId);
});

test("stale blocker (terminal job) replaced once; startup grace; job_already_running mapped", async () => {
  const repo = repoWithConfig();
  const cfg = await repo.insertConfig({ brand_key: "brand-a", domain: "example.com", location_code: 2840, language_code: "en", location_name: null, devices: "mobile", serp_depth: 10, schedule_interval: "weekly", is_active: true, next_check_at: null, created_by: null } as any);
  // active run with old job that is terminal
  const runId = crypto.randomUUID();
  await repo.tryCreateRun({ brand_key: "brand-a", config_id: cfg.id, id: runId, trigger: "manual", method: "live", approved_max_usd: 5, keyword_ids: [], created_by: null } as any);
  await repo.updateRun("brand-a", runId, { job_id: "job-old", status: "running" } as any);
  // hack started_at to old
  const mem = repo as any;
  mem.runs.get(runId).started_at = new Date(Date.now() - 10 * 60 * 1000).toISOString();

  const fakeTerminal = async () => ({ status: "completed" });
  const sr = await staleReason({ ...(await repo.getRun("brand-a", runId)), job_id: "job-old" }, { getJobStatus: fakeTerminal as any } as any);
  assert.equal(sr, "The check stopped without finishing");

  // begin should fail stale and retry once → new run
  let enqueued = 0;
  const fakeEnqueue = async () => { enqueued++; return { jobId: "job-new", deduped: false }; };
  const res = await beginRankCheckRun({ brandKey: "brand-a", userId: null }, { configId: cfg.id, trigger: "manual", approvedMaxUsd: 5 }, { repo, enqueueJob: fakeEnqueue as any, getJobStatus: fakeTerminal as any } as any);
  assert.equal(res.ok, true);
  assert.equal(enqueued, 1);
  const old = await repo.getRun("brand-a", runId);
  assert.equal(old?.status, "failed");

  // startup grace: null job_id and young → null
  const runId2 = crypto.randomUUID();
  await repo.tryCreateRun({ brand_key: "brand-b", config_id: (await repo.insertConfig({ brand_key: "brand-b", domain: "x.com", location_code: 2840, language_code: "en", location_name: null, devices: "mobile", serp_depth: 10, schedule_interval: "weekly", is_active: true, next_check_at: null, created_by: null } as any)).id, id: runId2, trigger: "manual", method: "live", approved_max_usd: 5, keyword_ids: [], created_by: null } as any);
  const r2 = await repo.getRun("brand-b", runId2);
  assert.equal(await staleReason(r2, {} as any), null);

  // job_already_running mapped
  const repo2 = createMemoryRankTrackingRepository();
  const cfg2 = await repo2.insertConfig({ brand_key: "brand-a", domain: "example.com", location_code: 2840, language_code: "en", location_name: null, devices: "mobile", serp_depth: 10, schedule_interval: "weekly", is_active: true, next_check_at: null, created_by: null } as any);
  const fakeConflict = async () => { throw new AppError(409, "job_already_running", "conflict"); };
  const rc = await beginRankCheckRun({ brandKey: "brand-a", userId: null }, { configId: cfg2.id, trigger: "manual", approvedMaxUsd: 5 }, { repo: repo2, enqueueJob: fakeConflict as any } as any);
  assert.equal(rc.ok, false);
});

test("getLatestRunView never writes", async () => {
  const repo = createMemoryRankTrackingRepository();
  const cfg = await repo.insertConfig({ brand_key: "brand-a", domain: "example.com", location_code: 2840, language_code: "en", location_name: null, devices: "mobile", serp_depth: 10, schedule_interval: "live" as any, is_active: true, next_check_at: null, created_by: null } as any);
  const v0 = await getLatestRunView("brand-a", cfg.id, { repo, getJobStatus: async () => ({ status: "running" }) as any } as any);
  assert.equal(v0, null);
  const runId = crypto.randomUUID();
  await repo.tryCreateRun({ brand_key: "brand-a", config_id: cfg.id, id: runId, trigger: "manual", method: "live", approved_max_usd: 5, keyword_ids: [], created_by: null } as any);
  await repo.updateRun("brand-a", runId, { job_id: "j1", status: "running", phase: "checking" } as any);
  const before = await repo.getRun("brand-a", runId);
  const view = await getLatestRunView("brand-a", cfg.id, { repo, getJobStatus: async () => ({ status: "running" }) as any } as any);
  const after = await repo.getRun("brand-a", runId);
  assert.deepEqual(before, after);
  assert.equal(view?.pollAfterSeconds, 3);
  assert.equal(view?.maybeStale, false);
});
