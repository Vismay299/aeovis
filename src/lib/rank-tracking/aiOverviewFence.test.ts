import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { runLiveCheck, runQueuedRound } from "./checkPaths.ts";
import { createMemoryRankTrackingRepository } from "./memoryRepository.ts";

test("no file under src/lib/rank-tracking imports answers.ts", () => {
  const root = "src/lib/rank-tracking";
  const files: string[] = [];
  function walk(dir: string) {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if ((p.endsWith(".ts") || p.endsWith(".mjs") || p.endsWith(".js")) && !p.endsWith(".test.ts") && !p.endsWith(".test.mjs")) files.push(p);
    }
  }
  walk(root);
  for (const f of files) {
    const src = readFileSync(f, "utf8");
    assert.ok(!src.includes("providers/dataforseo/answers"), `${f} imports answers.ts`);
    assert.ok(!src.includes("load_async_ai_overview"), `${f} contains load_async_ai_overview`);
  }
});

test("fence: load_async_ai_overview string absent from rank-tracking sources", () => {
  const root = "src/lib/rank-tracking";
  const files: string[] = [];
  function walk(dir: string) {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (!p.endsWith(".test.ts") && !p.endsWith(".test.mjs") && !p.endsWith(".test.js")) files.push(p);
    }
  }
  walk(root);
  for (const f of files) {
    const src = readFileSync(f, "utf8");
    assert.ok(!src.includes("load_async_ai_overview"), `${f} contains load_async_ai_overview`);
  }
});

function fakeCtx() {
  return {
    brandKey: "brand-a",
    jobId: "job-fence",
    progress: async () => {},
    step: { do: async (_n: string, _o: any, fn: () => Promise<any>) => fn(), sleep: async () => {} },
  };
}

test("live and queued runs never send load_async_ai_overview; ai_overview stored as type only", async () => {
  const found = JSON.parse(readFileSync(join(process.cwd(), "tests/fixtures/f15/rank-live-found.json"), "utf8"));
  const items = found.tasks[0].result[0].items;
  const bodies: any[] = [];
  const repo = createMemoryRankTrackingRepository();
  const cfg = await repo.insertConfig({ brand_key: "brand-a", domain: "example.com", location_code: 2840, language_code: "en", location_name: null, devices: "mobile", serp_depth: 10, schedule_interval: "weekly", is_active: true, next_check_at: null, created_by: null } as any);
  const ids = await repo.addKeywords("brand-a", cfg.id, [{ keyword: "fence-kw" }]);
  const kws = await repo.listKeywords("brand-a", cfg.id);
  const runLive = crypto.randomUUID();
  await repo.tryCreateRun({ brand_key: "brand-a", config_id: cfg.id, id: runLive, trigger: "manual", method: "live", approved_max_usd: 10, keyword_ids: ids, created_by: null } as any);
  const liveRun = await repo.getRun("brand-a", runLive);
  const client: any = {
    serp: {
      rankCheckBatch: async (_ctx: any, inputs: any[]) => {
        bodies.push(inputs);
        assert.ok(!JSON.stringify(inputs).includes("load_async_ai_overview"));
        return {
          results: inputs.map((inp: any) => {
            const organic = items.find((i: any) => i.domain === "example.com");
            return {
              keywordId: inp.keywordId,
              keyword: inp.keyword,
              position: organic.rank_group,
              url: organic.url,
              serpFeatures: [...new Set(items.map((i: any) => i.type))],
            };
          }),
        };
      },
      rankCheckTaskPost: async (_ctx: any, input: any) => {
        bodies.push(input);
        assert.ok(!JSON.stringify(input).includes("load_async_ai_overview"));
        return { results: input.tasks.map((t: any) => ({ tag: `${t.keywordId}:${t.device}`, status_code: 20100, id: `f-${t.keywordId}` })) };
      },
    },
  };
  await runLiveCheck(fakeCtx() as any, liveRun, { repo, client, fetchTaskResult: async () => ({ status: "pending" }) } as any);
  const snaps = await repo.snapshotsForRun("brand-a", runLive);
  assert.ok(snaps.length > 0);
  for (const s of snaps) {
    assert.ok((s as any).serp_features.includes("ai_overview"));
    assert.ok(!JSON.stringify(s).includes('"text":"x"'));
  }
  await repo.updateRun("brand-a", runLive, { status: "completed", completed_at: new Date().toISOString() } as any);
  // queued (separate run after completing live to satisfy single-active guard)
  const runQ = crypto.randomUUID();
  await repo.tryCreateRun({ brand_key: "brand-a", config_id: cfg.id, id: runQ, trigger: "scheduled", method: "queued", approved_max_usd: 10, keyword_ids: ids, created_by: null } as any);
  const qRun = await repo.getRun("brand-a", runQ);
  const fetchTaskResult = async () => ({ status: "completed", result: { position: 3, url: "https://example.com/page", serpFeatures: ["ai_overview", "organic"] } });
  await runQueuedRound(fakeCtx() as any, qRun, 0, { repo, client, fetchTaskResult } as any, async (rows) => {
    await repo.insertSnapshots(rows.map((r: any) => ({ brand_key: "brand-a", run_id: runQ, tracking_keyword_id: r.keywordId, keyword: r.keyword, device: r.device, position: r.position, url: r.url, serp_features: r.serpFeatures })));
  });
  for (const b of bodies) assert.ok(!JSON.stringify(b).includes("load_async_ai_overview"));
  void kws;
});
