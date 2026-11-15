import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runExploreJob, EXPLORE_RUN_JOB_KIND } from "./job.ts";
import { getJobDefinition } from "../jobs/registry.ts";
import { StepFailedError } from "../jobs/index.ts";
import { createMemoryExploreStore } from "./memoryStore.ts";
import "./jobs.ts"; // registers explore jobs

describe("src/lib/explore/job.ts", () => {
  const brandKey = "brand-1";
  const runId = "8d0c3f9e-2b1a-4c5d-9e8f-1a2b3c4d5e6f";
  const now = new Date("2026-10-22T10:30:00.000Z");

  function makeContext(payload = { runId }) {
    const stepsRun: Array<{ name: string; opts: any }> = [];
    return {
      jobId: "job-123",
      kind: EXPLORE_RUN_JOB_KIND,
      brandKey,
      payload,
      stepsRun,
      step: {
        do: async <T>(name: string, opts: any, fn: () => Promise<T>): Promise<T> => {
          stepsRun.push({ name, opts });
          return fn();
        },
        sleep: async () => {},
      },
    } as any;
  }

  it("is registered with deadlineSeconds: 900, maxInvocations: 6, pollAfterSeconds: 3", () => {
    const def = getJobDefinition(EXPLORE_RUN_JOB_KIND);
    assert.ok(def);
    assert.equal(def.deadlineSeconds, 900);
    assert.equal(def.maxInvocations, 6);
    assert.equal(def.pollAfterSeconds, 3);
  });

  it("declares ask step with billed: true and retries: 0 (F11-AC-10)", async () => {
    const store = createMemoryExploreStore();
    const ctx = makeContext();

    await store.createRun({
      id: runId,
      brand_key: brandKey,
      created_by: "user-1",
      job_id: "job-123",
      prompt: "test",
      prompt_hash: "a".repeat(64),
      models: ["chatgpt"],
      web_search: true,
      country: null,
      highlight_brand: null,
      status: "queued",
      plan: [
        {
          model: "chatgpt",
          route: "dataforseo",
          modelName: "gpt-5.6-luna",
          reserveUsd: 0.09,
          skipped: null,
          reusedFrom: null,
          observationId: "obs-1",
        },
      ],
      quote: {},
      approved_max_usd: 0.09,
      hold_id: null,
      question_id: null,
      created_at: now.toISOString(),
      finished_at: null,
    });

    const mockDispatchStore = {
      claim: async () => ({ granted: true, lease_token: "tok-1" }),
      finish: async () => {},
      renew: async () => true,
    };

    await runExploreJob(ctx, {
      store,
      dispatchStore: mockDispatchStore,
      askModel: async () => ({ text: "Answer", cost: 0.05 }),
      settleExploreHold: async () => {},
      now: () => now,
    });

    const askStep = ctx.stepsRun.find((s: any) => s.name === "ask");
    assert.ok(askStep);
    assert.equal(askStep.opts.billed, true);
    assert.equal(askStep.opts.retries, 0);
    assert.equal(askStep.opts.timeoutMs, 220_000);
  });

  it("makes at most one claim and one provider call per non-reused model", async () => {
    const store = createMemoryExploreStore();
    const ctx = makeContext();

    await store.createRun({
      id: runId,
      brand_key: brandKey,
      created_by: "user-1",
      job_id: "job-123",
      prompt: "test",
      prompt_hash: "a".repeat(64),
      models: ["chatgpt", "perplexity"],
      web_search: true,
      country: null,
      highlight_brand: null,
      status: "queued",
      plan: [
        {
          model: "chatgpt",
          route: "dataforseo",
          modelName: "gpt-5.6-luna",
          reserveUsd: 0.09,
          skipped: null,
          reusedFrom: null,
          observationId: "obs-1",
        },
        {
          model: "perplexity",
          route: "dataforseo",
          modelName: "sonar-pro",
          reserveUsd: 0.04,
          skipped: null,
          reusedFrom: null,
          observationId: "obs-2",
        },
      ],
      quote: {},
      approved_max_usd: 0.13,
      hold_id: null,
      question_id: null,
      created_at: now.toISOString(),
      finished_at: null,
    });

    const claims: string[] = [];
    const calls: string[] = [];

    const mockDispatchStore = {
      claim: async (id: string) => {
        claims.push(id);
        return { granted: true, lease_token: `token-${id}` };
      },
      finish: async () => {},
      renew: async () => true,
    };

    await runExploreJob(ctx, {
      store,
      dispatchStore: mockDispatchStore,
      askModel: async ({ entry }: any) => {
        calls.push(entry.model);
        return { text: `Answer for ${entry.model}`, cost: 0.02 };
      },
      settleExploreHold: async () => {},
      now: () => now,
    });

    assert.equal(claims.length, 2);
    assert.equal(calls.length, 2);
  });

  it("finishes failed without retrying on transient provider failure", async () => {
    const store = createMemoryExploreStore();
    const ctx = makeContext();

    await store.createRun({
      id: runId,
      brand_key: brandKey,
      created_by: "user-1",
      job_id: "job-123",
      prompt: "test",
      prompt_hash: "a".repeat(64),
      models: ["chatgpt"],
      web_search: true,
      country: null,
      highlight_brand: null,
      status: "queued",
      plan: [
        {
          model: "chatgpt",
          route: "dataforseo",
          modelName: "gpt-5.6-luna",
          reserveUsd: 0.09,
          skipped: null,
          reusedFrom: null,
          observationId: "obs-fail",
        },
      ],
      quote: {},
      approved_max_usd: 0.09,
      hold_id: null,
      question_id: null,
      created_at: now.toISOString(),
      finished_at: null,
    });

    let callsCount = 0;
    let finishedDecision: any = null;

    const mockDispatchStore = {
      claim: async () => ({ granted: true, lease_token: "token-fail" }),
      finish: async (_id: string, _token: string, _res: any, decision: any) => {
        finishedDecision = decision;
      },
      renew: async () => true,
    };

    await runExploreJob(ctx, {
      store,
      dispatchStore: mockDispatchStore,
      askModel: async () => {
        callsCount += 1;
        throw new Error("503 Gateway Timeout");
      },
      settleExploreHold: async () => {},
      now: () => now,
    });

    assert.equal(callsCount, 1); // exactly ONE call, no retries
    assert.equal(finishedDecision?.state, "failed");
  });

  it("makes no provider call when claim is refused", async () => {
    const store = createMemoryExploreStore();
    const ctx = makeContext();

    await store.createRun({
      id: runId,
      brand_key: brandKey,
      created_by: "user-1",
      job_id: "job-123",
      prompt: "test",
      prompt_hash: "a".repeat(64),
      models: ["chatgpt"],
      web_search: true,
      country: null,
      highlight_brand: null,
      status: "queued",
      plan: [
        {
          model: "chatgpt",
          route: "dataforseo",
          modelName: "gpt-5.6-luna",
          reserveUsd: 0.09,
          skipped: null,
          reusedFrom: null,
          observationId: "obs-refused",
        },
      ],
      quote: {},
      approved_max_usd: 0.09,
      hold_id: null,
      question_id: null,
      created_at: now.toISOString(),
      finished_at: null,
    });

    let askCalled = false;

    const mockDispatchStore = {
      claim: async () => ({ granted: false, reason: "spend_reservation_refused" }),
      finish: async () => {},
      renew: async () => true,
    };

    await runExploreJob(ctx, {
      store,
      dispatchStore: mockDispatchStore,
      askModel: async () => {
        askCalled = true;
        return { text: "Should not be called" };
      },
      settleExploreHold: async () => {},
      now: () => now,
    });

    assert.equal(askCalled, false);
  });

  it("sets status to partial and runs finalize and settle when ask crashes with StepFailedError", async () => {
    const store = createMemoryExploreStore();
    let settleRan = false;

    await store.createRun({
      id: runId,
      brand_key: brandKey,
      created_by: "user-1",
      job_id: "job-123",
      prompt: "test",
      prompt_hash: "a".repeat(64),
      models: ["chatgpt"],
      web_search: true,
      country: null,
      highlight_brand: null,
      status: "queued",
      plan: [
        {
          model: "chatgpt",
          route: "dataforseo",
          modelName: "gpt-5.6-luna",
          reserveUsd: 0.09,
          skipped: null,
          reusedFrom: null,
          observationId: "obs-crash",
        },
      ],
      quote: {},
      approved_max_usd: 0.09,
      hold_id: null,
      question_id: null,
      created_at: now.toISOString(),
      finished_at: null,
    });

    const ctx = {
      jobId: "job-123",
      kind: EXPLORE_RUN_JOB_KIND,
      brandKey,
      payload: { runId },
      stepsRun: [] as any[],
      step: {
        do: async (name: string, opts: any, fn: any) => {
          if (name === "ask") {
            throw new StepFailedError("billed_step_interrupted", "Worker interrupted during billed step");
          }
          return fn();
        },
        sleep: async () => {},
      },
    } as any;

    const res = await runExploreJob(ctx, {
      store,
      dispatchStore: {
        claim: async () => ({ granted: true, lease_token: "tok" }),
        finish: async () => {},
      },
      settleExploreHold: async () => {
        settleRan = true;
      },
      now: () => now,
    });

    assert.equal(res.status, "partial");
    assert.equal(settleRan, true);

    const saved = await store.getRun(brandKey, runId);
    assert.equal(saved?.status, "partial");
  });

  it("touches expired leased rows with a claim call during finalize", async () => {
    const store = createMemoryExploreStore();
    const ctx = makeContext();

    await store.createRun({
      id: runId,
      brand_key: brandKey,
      created_by: "user-1",
      job_id: "job-123",
      prompt: "test",
      prompt_hash: "a".repeat(64),
      models: ["chatgpt"],
      web_search: true,
      country: null,
      highlight_brand: null,
      status: "queued",
      plan: [
        {
          model: "chatgpt",
          route: "dataforseo",
          modelName: "gpt-5.6-luna",
          reserveUsd: 0.09,
          skipped: null,
          reusedFrom: null,
          observationId: "obs-leased-expired",
        },
      ],
      quote: {},
      approved_max_usd: 0.09,
      hold_id: null,
      question_id: null,
      created_at: now.toISOString(),
      finished_at: null,
    });

    let touchCalled = false;
    const mockDispatchStore = {
      claim: async (id: string, opts: any) => {
        if (opts.leaseSeconds === 1) {
          touchCalled = true;
          return { granted: false };
        }
        const obs = store.observations.get(id);
        if (obs) {
          obs.state = "leased";
          obs.lease_until = new Date(now.getTime() - 10_000).toISOString();
        }
        return { granted: false };
      },
      finish: async () => {},
      renew: async () => true,
    };

    await runExploreJob(ctx, {
      store,
      dispatchStore: mockDispatchStore,
      settleExploreHold: async () => {},
      now: () => now,
    });

    assert.equal(touchCalled, true);
  });
});
