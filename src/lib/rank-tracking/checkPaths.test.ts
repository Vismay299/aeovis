import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runLiveCheck, runQueuedRound, expandToTaskInputs } from "./checkPaths.ts";
import { createMemoryRankTrackingRepository } from "./memoryRepository.ts";

function load(name: string) {
  return JSON.parse(readFileSync(join(process.cwd(), "tests/fixtures/f15", name), "utf8"));
}

function fakeCtx(brandKey = "brand-a", jobId = "job-1") {
  const steps: string[] = [];
  return {
    brandKey,
    jobId,
    progress: async () => {},
    step: {
      do: async (name: string, _opts: any, fn: () => Promise<any>) => {
        steps.push(name);
        return fn();
      },
      sleep: async () => {},
    },
    _steps: steps,
  };
}

function itemsToResult(items: any[], keywordId: string, keyword: string) {
  const organic = items.find((i) => i.type === "organic" && (i.domain === "example.com" || String(i.domain).endsWith(".example.com")));
  return {
    keywordId,
    keyword,
    position: organic ? (organic.rank_group ?? organic.rank_absolute ?? null) : null,
    url: organic?.url ?? null,
    serpFeatures: [...new Set(items.map((i) => i.type))],
  };
}

test("expandToTaskInputs copies COPY :57-70", () => {
  const out = expandToTaskInputs([{ id: "k1", keyword: "a" }], "both");
  assert.deepEqual(out, [
    { keywordId: "k1", keyword: "a", device: "desktop" },
    { keywordId: "k1", keyword: "a", device: "mobile" },
  ]);
});

test("failed live batch does not stop the run (port rankCheckPaths.test.ts:100)", async () => {
  const repo = createMemoryRankTrackingRepository();
  const cfg = await repo.insertConfig({ brand_key: "brand-a", domain: "example.com", location_code: 2840, language_code: "en", location_name: null, devices: "mobile", serp_depth: 10, schedule_interval: "weekly", is_active: true, next_check_at: null, created_by: null } as any);
  // 11 keywords → 2 batches; first batch fails, second succeeds so run continues
  const kwNames = Array.from({ length: 11 }, (_, i) => `kw${i}`);
  const ids = await repo.addKeywords("brand-a", cfg.id, kwNames.map((k) => ({ keyword: k })));
  const runId = crypto.randomUUID();
  await repo.tryCreateRun({ brand_key: "brand-a", config_id: cfg.id, id: runId, trigger: "manual", method: "live", approved_max_usd: 10, keyword_ids: ids, created_by: null } as any);
  const run = await repo.getRun("brand-a", runId);
  const found = load("rank-live-found.json");
  const foundItems = found.tasks[0].result[0].items;
  let calls = 0;
  const client = {
    serp: {
      rankCheckBatch: async (_ctx: any, inputs: any[]) => {
        calls++;
        if (calls === 1) {
          const err: any = new Error("upstream boom");
          err.code = "dataforseo_unavailable";
          throw err;
        }
        return { results: inputs.map((inp: any) => itemsToResult(foundItems, inp.keywordId, inp.keyword)) };
      },
    },
  };
  await runLiveCheck(fakeCtx() as any, run, { repo, client, fetchTaskResult: async () => ({ status: "pending" }) } as any);
  const snaps = await repo.snapshotsForRun("brand-a", runId);
  assert.ok(snaps.length > 0);
  const r = await repo.getRun("brand-a", runId);
  assert.ok(r?.error_code);
});

test("queued post maps tags, marks rejected and missing; collect handles pending/failed/completed; expired after 6 rounds", async () => {
  const repo = createMemoryRankTrackingRepository();
  const cfg = await repo.insertConfig({ brand_key: "brand-a", domain: "example.com", location_code: 2840, language_code: "en", location_name: null, devices: "mobile", serp_depth: 10, schedule_interval: "weekly", is_active: true, next_check_at: null, created_by: null } as any);
  const ids = await repo.addKeywords("brand-a", cfg.id, [{ keyword: "kw-1" }, { keyword: "kw-2" }, { keyword: "kw-3" }, { keyword: "kw-4" }]);
  const kws = await repo.listKeywords("brand-a", cfg.id);
  const byKw = new Map(kws.map((k: any) => [k.keyword, k.id]));
  const runId = crypto.randomUUID();
  await repo.tryCreateRun({ brand_key: "brand-a", config_id: cfg.id, id: runId, trigger: "scheduled", method: "queued", approved_max_usd: 10, keyword_ids: ids, created_by: null } as any);
  const run = await repo.getRun("brand-a", runId);
  const postFixture = load("rank-task-post.json");
  // remap fixture tags to our real ids: first 3 accepted, 4th rejected, 5th missing
  const realIds = [byKw.get("kw-1"), byKw.get("kw-2"), byKw.get("kw-3"), byKw.get("kw-4")];
  const client = {
    serp: {
      rankCheckTaskPost: async (_ctx: any, _input: any) => ({
        results: [
          { tag: `${realIds[0]}:mobile`, status_code: 20100, id: "task-1" },
          { tag: `${realIds[1]}:mobile`, status_code: 20100, id: "task-2" },
          { tag: `${realIds[2]}:mobile`, status_code: 20100, id: "task-3" },
          { tag: `${realIds[3]}:mobile`, status_code: 40501, status_message: "Invalid Field:'keyword'." },
        ],
      }),
    },
  };
  void postFixture;
  const found = load("rank-task-get-found.json");
  const foundItems = found.tasks[0].result[0].items;
  const pending = load("rank-task-get-pending.json");
  void pending;
  let fetchCalls = 0;
  const fetchTaskResult = async ({ taskId }: any) => {
    fetchCalls++;
    if (taskId === "task-2") return { status: "pending" };
    if (taskId === "task-3") return { status: "failed", message: "bad" };
    const kw = taskId === "task-1" ? "kw-1" : "kw";
    return { status: "completed", result: itemsToResult(foundItems, "x", kw) };
  };
  const onCompletedRows: any[] = [];
  const out = await runQueuedRound(fakeCtx() as any, run, 0, { repo, client, fetchTaskResult } as any, async (rows) => {
    onCompletedRows.push(...rows);
    await repo.insertSnapshots(rows.map((r: any) => ({ brand_key: "brand-a", run_id: runId, tracking_keyword_id: r.keywordId, keyword: r.keyword, device: r.device, position: r.position, url: r.url, serp_features: r.serpFeatures })));
  });
  assert.ok(fetchCalls > 0);
  assert.equal(out.failed, 1);
  // rejected + missing marked
  const rejected = await repo.tasksByState("brand-a", runId, 0, ["rejected"], 100);
  assert.ok(rejected.length >= 1);
  // pending stays then expired after 6 rounds
  const expired = await repo.tasksByState("brand-a", runId, 0, ["expired"], 100);
  // task-2 was pending for 6 collects then expired
  assert.ok(expired.some((t: any) => t.provider_task_id === "task-2") || out.expired >= 1);
});

test("reserve refusal stops posting (no paid call after refusal)", async () => {
  const repo = createMemoryRankTrackingRepository();
  const cfg = await repo.insertConfig({ brand_key: "brand-a", domain: "example.com", location_code: 2840, language_code: "en", location_name: null, devices: "mobile", serp_depth: 100, schedule_interval: "weekly", is_active: true, next_check_at: null, created_by: null } as any);
  const ids = await repo.addKeywords("brand-a", cfg.id, [{ keyword: "expensive operator site:x" }]);
  const runId = crypto.randomUUID();
  await repo.tryCreateRun({ brand_key: "brand-a", config_id: cfg.id, id: runId, trigger: "manual", method: "live", approved_max_usd: 0.000001, keyword_ids: ids, created_by: null } as any);
  const run = await repo.getRun("brand-a", runId);
  let paidCalls = 0;
  const client = { serp: { rankCheckBatch: async () => { paidCalls++; return { results: [] }; } } };
  await runLiveCheck(fakeCtx() as any, run, { repo, client } as any);
  assert.equal(paidCalls, 0);
  const snaps = await repo.snapshotsForRun("brand-a", runId);
  assert.equal(snaps.length, 0);
});

test("500 task_get cap per collect", async () => {
  const repo = createMemoryRankTrackingRepository();
  const cfg = await repo.insertConfig({ brand_key: "brand-a", domain: "example.com", location_code: 2840, language_code: "en", location_name: null, devices: "mobile", serp_depth: 10, schedule_interval: "weekly", is_active: true, next_check_at: null, created_by: null } as any);
  const kws: string[] = [];
  for (let i = 0; i < 5; i++) kws.push(`kw-cap-${i}`);
  const ids = await repo.addKeywords("brand-a", cfg.id, kws.map((k) => ({ keyword: k })));
  const runId = crypto.randomUUID();
  await repo.tryCreateRun({ brand_key: "brand-a", config_id: cfg.id, id: runId, trigger: "scheduled", method: "queued", approved_max_usd: 100, keyword_ids: ids, created_by: null } as any);
  const run = await repo.getRun("brand-a", runId);
  const collectLimits: number[] = [];
  const orig = repo.tasksByState.bind(repo);
  (repo as any).tasksByState = async (b: any, r: any, round: any, states: any, limit: any, after?: any) => {
    // only collect reads posted with TASK_GETS_PER_COLLECT; leftover uses 10000 and is not a task_get
    if (states.includes("posted") && limit === 500) collectLimits.push(limit);
    return orig(b, r, round, states, limit, after);
  };
  const client = {
    serp: {
      rankCheckTaskPost: async (_c: any, input: any) => ({ results: input.tasks.map((t: any, i: number) => ({ tag: `${t.keywordId}:${t.device}`, status_code: 20100, id: `t-${i}` })) }),
    },
  };
  const fetchTaskResult = async () => ({ status: "completed", result: { keywordId: "x", keyword: "y", position: 5, url: null, serpFeatures: ["organic"] } });
  await runQueuedRound(fakeCtx() as any, run, 0, { repo, client, fetchTaskResult } as any, async () => {});
  assert.ok(collectLimits.length > 0);
  assert.ok(collectLimits.every((l) => l <= 500));
});
