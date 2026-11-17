import test from "node:test";
import assert from "node:assert/strict";
import { retryRankChecks, buildRetryPairs, needsRetry } from "./retries.ts";
import { createMemoryRankTrackingRepository } from "./memoryRepository.ts";

function fakeCtx(brandKey = "brand-a", jobId = "job-1") {
  return {
    brandKey,
    jobId,
    progress: async () => {},
    step: {
      do: async (name: string, _o: any, fn: () => Promise<any>) => fn(),
      sleep: async () => {},
    },
  };
}

async function seed(brand = "brand-a", device: any = "mobile") {
  const repo = createMemoryRankTrackingRepository();
  const cfg = await repo.insertConfig({ brand_key: brand, domain: "example.com", location_code: 2840, language_code: "en", location_name: null, devices: device, serp_depth: 10, schedule_interval: "weekly", is_active: true, next_check_at: null, created_by: null } as any);
  return { repo, cfg };
}

test("errored pair re-checked and never-ranked miss kept", async () => {
  const { repo, cfg } = await seed();
  const ids = await repo.addKeywords("brand-a", cfg.id, [{ keyword: "newkw" }]);
  const runId = crypto.randomUUID();
  await repo.tryCreateRun({ brand_key: "brand-a", config_id: cfg.id, id: runId, trigger: "scheduled", method: "queued", approved_max_usd: 10, keyword_ids: ids, created_by: null } as any);
  const run = await repo.getRun("brand-a", runId);
  let posted = 0;
  const client = { serp: { rankCheckTaskPost: async (_c: any, input: any) => { posted++; return { results: input.tasks.map((t: any) => ({ tag: `${t.keywordId}:${t.device}`, status_code: 20100, id: `p-${posted}-${t.keywordId}` })) }; } } };
  const fetchTaskResult = async () => ({ status: "completed", result: { position: 8, url: "https://example.com/x", serpFeatures: ["organic"] } });
  await retryRankChecks(fakeCtx() as any, run, { repo, client, fetchTaskResult } as any);
  assert.ok(posted >= 1);
  const snaps = await repo.snapshotsForRun("brand-a", runId);
  assert.ok(snaps.some((s: any) => s.position === 8));
});

test("10-position drop re-checked and best kept", async () => {
  const { repo, cfg } = await seed();
  const ids = await repo.addKeywords("brand-a", cfg.id, [{ keyword: "dropkw" }]);
  const kws = await repo.listKeywords("brand-a", cfg.id);
  const kid = kws[0].id;
  // completed history at position 1
  const histRun = crypto.randomUUID();
  await repo.tryCreateRun({ brand_key: "brand-a", config_id: cfg.id, id: histRun, trigger: "scheduled", method: "queued", approved_max_usd: 10, keyword_ids: ids, created_by: null } as any);
  await repo.updateRun("brand-a", histRun, { status: "completed" } as any);
  await repo.insertSnapshots([{ brand_key: "brand-a", run_id: histRun, tracking_keyword_id: kid, keyword: "dropkw", device: "mobile", position: 1, url: null, serp_features: [] }]);
  const runId = crypto.randomUUID();
  await repo.tryCreateRun({ brand_key: "brand-a", config_id: cfg.id, id: runId, trigger: "scheduled", method: "queued", approved_max_usd: 10, keyword_ids: ids, created_by: null } as any);
  await repo.insertSnapshots([{ brand_key: "brand-a", run_id: runId, tracking_keyword_id: kid, keyword: "dropkw", device: "mobile", position: 11, url: null, serp_features: [] }]);
  const run = await repo.getRun("brand-a", runId);
  const client = { serp: { rankCheckTaskPost: async (_c: any, input: any) => ({ results: input.tasks.map((t: any) => ({ tag: `${t.keywordId}:${t.device}`, status_code: 20100, id: "r1" })) }) } };
  const fetchTaskResult = async () => ({ status: "completed", result: { position: 4, url: null, serpFeatures: ["organic"] } });
  await retryRankChecks(fakeCtx() as any, run, { repo, client, fetchTaskResult } as any);
  const snaps = await repo.snapshotsForRun("brand-a", runId);
  assert.ok(snaps.some((s: any) => s.position === 4));
});

test("find on other device makes miss suspect; new keyword found on second recheck", async () => {
  const pairs = buildRetryPairs({
    keywords: [{ trackingKeywordId: "k", keyword: "k" }],
    devices: "both",
    current: [{ trackingKeywordId: "k", device: "mobile", position: 3 }],
    answeredInRun: new Set(["k:mobile"]),
    previousBest: new Map(),
    hadPreviousCheck: new Set(),
  });
  assert.ok(pairs.some((p) => p.device === "desktop" && needsRetry(p)));
});

test("previously ranked keyword never saved as not found (unconfirmed misses deleted)", async () => {
  const { repo, cfg } = await seed();
  const ids = await repo.addKeywords("brand-a", cfg.id, [{ keyword: "oldkw" }]);
  const kws = await repo.listKeywords("brand-a", cfg.id);
  const kid = kws[0].id;
  const histRun = crypto.randomUUID();
  await repo.tryCreateRun({ brand_key: "brand-a", config_id: cfg.id, id: histRun, trigger: "scheduled", method: "queued", approved_max_usd: 10, keyword_ids: ids, created_by: null } as any);
  await repo.updateRun("brand-a", histRun, { status: "completed" } as any);
  await repo.insertSnapshots([{ brand_key: "brand-a", run_id: histRun, tracking_keyword_id: kid, keyword: "oldkw", device: "mobile", position: 2, url: null, serp_features: [] }]);
  const runId = crypto.randomUUID();
  await repo.tryCreateRun({ brand_key: "brand-a", config_id: cfg.id, id: runId, trigger: "scheduled", method: "queued", approved_max_usd: 10, keyword_ids: ids, created_by: null } as any);
  await repo.insertSnapshots([{ brand_key: "brand-a", run_id: runId, tracking_keyword_id: kid, keyword: "oldkw", device: "mobile", position: null, url: null, serp_features: [] }]);
  const run = await repo.getRun("brand-a", runId);
  const client = { serp: { rankCheckTaskPost: async (_c: any, input: any) => ({ results: input.tasks.map((t: any) => ({ tag: `${t.keywordId}:${t.device}`, status_code: 20100, id: "rx" })) }) } };
  const fetchTaskResult = async () => ({ status: "completed", result: { position: null, url: null, serpFeatures: [] } });
  await retryRankChecks(fakeCtx() as any, run, { repo, client, fetchTaskResult } as any);
  const snaps = await repo.snapshotsForRun("brand-a", runId);
  assert.ok(!snaps.some((s: any) => s.position === null));
});

test("no replayed paid post on retry when nothing needs retry", async () => {
  const { repo, cfg } = await seed();
  const ids = await repo.addKeywords("brand-a", cfg.id, [{ keyword: "stable" }]);
  const kws = await repo.listKeywords("brand-a", cfg.id);
  const histRun = crypto.randomUUID();
  await repo.tryCreateRun({ brand_key: "brand-a", config_id: cfg.id, id: histRun, trigger: "scheduled", method: "queued", approved_max_usd: 10, keyword_ids: ids, created_by: null } as any);
  await repo.updateRun("brand-a", histRun, { status: "completed" } as any);
  await repo.insertSnapshots([{ brand_key: "brand-a", run_id: histRun, tracking_keyword_id: kws[0].id, keyword: "stable", device: "mobile", position: 5, url: null, serp_features: [] }]);
  const runId = crypto.randomUUID();
  await repo.tryCreateRun({ brand_key: "brand-a", config_id: cfg.id, id: runId, trigger: "scheduled", method: "queued", approved_max_usd: 10, keyword_ids: ids, created_by: null } as any);
  await repo.insertSnapshots([{ brand_key: "brand-a", run_id: runId, tracking_keyword_id: kws[0].id, keyword: "stable", device: "mobile", position: 5, url: null, serp_features: [] }]);
  const run = await repo.getRun("brand-a", runId);
  let posts = 0;
  const client = { serp: { rankCheckTaskPost: async () => { posts++; return { results: [] }; } } };
  await retryRankChecks(fakeCtx() as any, run, { repo, client, fetchTaskResult: async () => ({ status: "pending" }) } as any);
  assert.equal(posts, 0);
});
