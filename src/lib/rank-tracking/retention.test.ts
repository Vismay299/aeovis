import test from "node:test";
import assert from "node:assert/strict";
import {
  runRankRetention,
  RANK_RETENTION_MAX_ROUNDS,
  RANK_RETENTION_PRUNE_LIMIT,
  RANK_RETENTION_RUNS_BEFORE_DAYS,
  RANK_RETENTION_TASKS_BEFORE_DAYS,
} from "./retention.ts";
import { createMemoryRankTrackingRepository } from "./memoryRepository.ts";

const NOW = Date.parse("2026-11-14T00:00:00.000Z");
const DAY_MS = 86_400_000;

function retentionCtx() {
  const steps: string[] = [];
  const ctx: any = {
    step: {
      do: async (name: string, _opts: any, fn: () => Promise<any>) => {
        steps.push(name);
        return fn();
      },
    },
  };
  return { steps, ctx };
}

test("prunes in as few rounds as needed and reports totals", async () => {
  const calls: Array<{ runsBefore: string; tasksBefore: string; limit: number }> = [];
  let round = 0;
  const repo: any = {
    prune: async (runsBefore: string, tasksBefore: string, limit: number) => {
      round += 1;
      calls.push({ runsBefore, tasksBefore, limit });
      return round === 1 ? { runs: 1000, tasks: 40 } : { runs: 3, tasks: 5 };
    },
  };
  const { steps, ctx } = retentionCtx();
  const out = await runRankRetention(ctx, { repo, now: () => new Date(NOW) });
  assert.deepEqual(out, { runs: 1003, tasks: 45, rounds: 2 });
  assert.deepEqual(steps, ["prune-1", "prune-2"]);
  assert.equal(calls[0].limit, RANK_RETENTION_PRUNE_LIMIT);
  assert.equal(
    calls[0].runsBefore,
    new Date(NOW - RANK_RETENTION_RUNS_BEFORE_DAYS * DAY_MS).toISOString(),
  );
  assert.equal(
    calls[0].tasksBefore,
    new Date(NOW - RANK_RETENTION_TASKS_BEFORE_DAYS * DAY_MS).toISOString(),
  );
});

test("the prune loop is capped at 20 rounds of 1,000", async () => {
  let calls = 0;
  const repo: any = {
    prune: async () => {
      calls += 1;
      return { runs: 1000, tasks: 10000 };
    },
  };
  const { steps, ctx } = retentionCtx();
  const out = await runRankRetention(ctx, { repo, now: () => new Date(NOW) });
  assert.equal(RANK_RETENTION_MAX_ROUNDS, 20);
  assert.equal(calls, 20, "a full backlog must stop after exactly 20 rounds");
  assert.equal(steps.length, 20);
  assert.equal(steps[0], "prune-1");
  assert.equal(steps[19], "prune-20");
  assert.deepEqual(out, { runs: 20000, tasks: 200000, rounds: 20 });
});

test("a short round stops the loop even when tasks hit the limit", async () => {
  let calls = 0;
  const repo: any = {
    prune: async () => {
      calls += 1;
      return { runs: 999, tasks: 10000 };
    },
  };
  const { ctx } = retentionCtx();
  const out = await runRankRetention(ctx, { repo, now: () => new Date(NOW) });
  assert.equal(calls, 1);
  assert.deepEqual(out, { runs: 999, tasks: 10000, rounds: 1 });
});

test("runs against the memory repository without error", async () => {
  const repo = createMemoryRankTrackingRepository();
  const cfg = await repo.insertConfig({
    brand_key: "brand-r",
    domain: "brand-r.example",
    location_code: 2840,
    language_code: "en",
    location_name: null,
    devices: "mobile",
    serp_depth: 10,
    schedule_interval: "weekly",
    is_active: true,
    next_check_at: new Date(NOW).toISOString(),
    last_checked_at: null,
    last_skip_reason: null,
    last_skip_at: null,
    approved_max_usd: 10,
    approval_id: null,
    created_by: null,
  } as any);
  await repo.tryCreateRun({
    brand_key: "brand-r",
    config_id: cfg.id,
    id: crypto.randomUUID(),
    trigger: "scheduled",
    method: "queued",
    approved_max_usd: 10,
    keyword_ids: [],
    created_by: null,
  } as any);
  const { steps, ctx } = retentionCtx();
  const out = await runRankRetention(ctx, { repo, now: () => new Date(NOW) });
  assert.deepEqual(out, { runs: 0, tasks: 0, rounds: 1 });
  assert.deepEqual(steps, ["prune-1"]);
});
