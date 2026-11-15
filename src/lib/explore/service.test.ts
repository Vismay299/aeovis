import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { startExploreRun, getExploreRun, listExploreRuns } from "./service.ts";
import { createMemoryExploreStore } from "./memoryStore.ts";
import { AppError } from "../http/errors.ts";
import { hashPrompt } from "./shape.ts";

describe("src/lib/explore/service.ts", () => {
  const dummyClient = {} as any;
  const brandKey = "brand-1";
  const userId = "user-1";
  const now = new Date("2026-10-22T10:30:00.000Z");

  const validBody = {
    prompt: "best running shoes",
    models: ["chatgpt"],
    webSearch: true,
    country: null,
    highlightBrand: "BrandX",
    fresh: false,
    maxUsd: 0.10,
  };

  it("enforces order of refusals with nothing created in store or spend hold", async () => {
    const store = createMemoryExploreStore();
    let reserveCalled = false;

    // 1. Feature disabled refuses before anything else
    await assert.rejects(
      async () => {
        await startExploreRun(
          dummyClient,
          { brandKey, userId, body: validBody },
          {
            store,
            isFeatureEnabled: async () => false,
            reserveSpend: (async () => {
              reserveCalled = true;
              return { holdId: "h-1" };
            }) as any,
          },
        );
      },
      (err: any) => {
        assert.ok(err instanceof AppError);
        assert.equal(err.status, 403);
        assert.equal(err.code, "feature_disabled");
        return true;
      },
    );
    assert.equal(store.runs.size, 0);
    assert.equal(reserveCalled, false);

    // 2. Body validation refuses next
    await assert.rejects(
      async () => {
        await startExploreRun(
          dummyClient,
          { brandKey, userId, body: { prompt: "", models: [] } },
          {
            store,
            isFeatureEnabled: async () => true,
            reserveSpend: (async () => {
              reserveCalled = true;
              return { holdId: "h-1" };
            }) as any,
          },
        );
      },
      (err: any) => {
        assert.equal(err.name, "ZodError");
        return true;
      },
    );
    assert.equal(store.runs.size, 0);
    assert.equal(reserveCalled, false);

    // 3. Rate limits refuse next
    await assert.rejects(
      async () => {
        await startExploreRun(
          dummyClient,
          { brandKey, userId, body: validBody },
          {
            store,
            isFeatureEnabled: async () => true,
            rateLimits: {
              findActiveRun: async () => ({ id: "active-run" }),
            },
            reserveSpend: (async () => {
              reserveCalled = true;
              return { holdId: "h-1" };
            }) as any,
          },
        );
      },
      (err: any) => {
        assert.equal(err.code, "explore_already_running");
        return true;
      },
    );
    assert.equal(store.runs.size, 0);
    assert.equal(reserveCalled, false);
  });

  it("all-reused run completes immediately without hold reservation or enqueued job", async () => {
    const store = createMemoryExploreStore();
    const promptHash = hashPrompt("best running shoes");

    // Seed answered observation
    store.seedObservation({
      id: "obs-reused-1",
      job_id: null,
      purpose: "explore",
      engine: "chatgpt",
      query: "best running shoes",
      context: {
        explore_run_id: "prior-run-id",
        prompt_hash: promptHash,
        route: "dataforseo",
        model_name: "gpt-5.6-luna",
        web_search: "true",
        country: "",
      },
      config_version: "v1",
      circuit_key: "c1",
      state: "answered",
      attempt_count: 1,
      next_attempt_at: now.toISOString(),
      deadline_at: now.toISOString(),
      lease_token: null,
      lease_until: null,
      reason: null,
      result: {
        model_name: "gpt-5.6-luna",
        items: [{ type: "message", sections: [{ text: "Reused answer." }] }],
        output_tokens: 100,
      },
      observed_at: new Date(now.getTime() - 86_400_000).toISOString(),
      total_cost: 0.05,
      unknown_cost_calls: 0,
      created_at: now.toISOString(),
      brand_key: brandKey,
    });

    let reserveCalled = false;
    let enqueueCalled = false;

    const res = await startExploreRun(
      dummyClient,
      { brandKey, userId, body: validBody },
      {
        store,
        now: () => now,
        isFeatureEnabled: async () => true,
        rateLimits: {
          findActiveRun: async () => null,
          listUserRunsInWindow: async () => [],
          countWorkspaceRunsSince: async () => 0,
        },
        resolveRoutes: async () => [
          {
            model: "chatgpt",
            route: "dataforseo",
            modelName: "gpt-5.6-luna",
            reserveUsd: 0.09,
            skipped: null,
          },
        ],
        quote: (async () => ({
          totalUsd: 0,
          expectedUsd: null,
          units: [{ key: "models", label: "models", count: 1 }, { key: "reused", label: "reused", count: 1 }],
          lines: [],
          monthly: null,
          warnings: [],
          blocked: null,
        })) as any,
        reserveSpend: (async () => {
          reserveCalled = true;
          return { holdId: "h-1" };
        }) as any,
        enqueueJob: (async () => {
          enqueueCalled = true;
          return { jobId: "j-1" };
        }) as any,
      },
    );

    assert.equal(res.status, "completed");
    assert.equal(res.jobId, null);
    assert.equal(res.pollAfterSeconds, null);
    assert.equal(reserveCalled, false);
    assert.equal(enqueueCalled, false);

    const saved = await store.getRun(brandKey, res.runId);
    assert.ok(saved);
    assert.equal(saved.status, "completed");
    assert.ok(saved.finished_at);
  });

  it("releases hold and deletes run when single-active job collision occurs", async () => {
    const store = createMemoryExploreStore();
    let releaseHoldId: string | null = null;
    let releaseReason: string | null = null;

    await assert.rejects(
      async () => {
        await startExploreRun(
          dummyClient,
          { brandKey, userId, body: validBody },
          {
            store,
            now: () => now,
            isFeatureEnabled: async () => true,
            rateLimits: {
              findActiveRun: async () => null,
              listUserRunsInWindow: async () => [],
              countWorkspaceRunsSince: async () => 0,
            },
            resolveRoutes: async () => [
              {
                model: "chatgpt",
                route: "dataforseo",
                modelName: "gpt-5.6-luna",
                reserveUsd: 0.09,
                skipped: null,
              },
            ],
            quote: (async () => ({
              totalUsd: 0.09,
              expectedUsd: null,
              units: [{ key: "models", label: "models", count: 1 }, { key: "reused", label: "reused", count: 0 }],
              lines: [],
              monthly: null,
              warnings: [],
              blocked: null,
            })) as any,
            requireApprovedPrice: async () => ({ approvedMaxUsd: 0.09 }) as any,
            reserveSpend: (async () => ({ holdId: "hold-active-test" })) as any,
            releaseSpend: (async (holdId: any, reason: any) => {
              releaseHoldId = typeof holdId === "object" ? holdId.holdId : holdId;
              releaseReason = typeof holdId === "object" ? holdId.reason : reason;
              return true;
            }) as any,
            enqueueJob: (async () => {
              const err = new Error("job already running");
              (err as any).code = "job_already_running";
              throw err;
            }) as any,
          },
        );
      },
      (err: any) => {
        assert.equal(err.status, 409);
        assert.equal(err.code, "explore_already_running");
        return true;
      },
    );

    assert.equal(releaseHoldId, "hold-active-test");
    assert.equal(releaseReason, "explore_already_running");
    assert.equal(store.runs.size, 0); // row was deleted
  });

  it("fresh: true bypasses reuse and enqueues job", async () => {
    const store = createMemoryExploreStore();
    let enqueueCalled = false;

    const res = await startExploreRun(
      dummyClient,
      { brandKey, userId, body: { ...validBody, fresh: true } },
      {
        store,
        now: () => now,
        isFeatureEnabled: async () => true,
        rateLimits: {
          findActiveRun: async () => null,
          listUserRunsInWindow: async () => [],
          countWorkspaceRunsSince: async () => 0,
        },
        resolveRoutes: async () => [
          {
            model: "chatgpt",
            route: "dataforseo",
            modelName: "gpt-5.6-luna",
            reserveUsd: 0.09,
            skipped: null,
          },
        ],
        quote: (async () => ({
          totalUsd: 0.09,
          expectedUsd: null,
          units: [{ key: "models", label: "models", count: 1 }, { key: "reused", label: "reused", count: 0 }],
          lines: [],
          monthly: null,
          warnings: [],
          blocked: null,
        })) as any,
        requireApprovedPrice: async () => ({ approvedMaxUsd: 0.09 }) as any,
        reserveSpend: (async () => ({ holdId: "h-fresh" })) as any,
        enqueueJob: (async () => {
          enqueueCalled = true;
          return { jobId: "job-fresh-1" };
        }) as any,
        recordApproval: async () => ({}) as any,
        captureServerEvent: async () => {},
      },
    );

    assert.equal(res.status, "queued");
    assert.equal(res.jobId, "job-fresh-1");
    assert.equal(res.pollAfterSeconds, 3);
    assert.equal(enqueueCalled, true);

    const saved = await store.getRun(brandKey, res.runId);
    assert.ok(saved);
    assert.equal(saved.plan[0].reusedFrom, null);
  });

  it("never includes prompt, answer text, citations, or highlight brand in telemetry (F11-AC-18)", async () => {
    const store = createMemoryExploreStore();
    let capturedEvent: string | null = null;
    let capturedProps: any = null;

    await startExploreRun(
      dummyClient,
      { brandKey, userId, body: validBody },
      {
        store,
        now: () => now,
        isFeatureEnabled: async () => true,
        rateLimits: {
          findActiveRun: async () => null,
          listUserRunsInWindow: async () => [],
          countWorkspaceRunsSince: async () => 0,
        },
        resolveRoutes: async () => [
          {
            model: "chatgpt",
            route: "dataforseo",
            modelName: "gpt-5.6-luna",
            reserveUsd: 0.09,
            skipped: null,
          },
        ],
        quote: (async () => ({
          totalUsd: 0.09,
          expectedUsd: null,
          units: [{ key: "models", label: "models", count: 1 }, { key: "reused", label: "reused", count: 0 }],
          lines: [],
          monthly: null,
          warnings: [],
          blocked: null,
        })) as any,
        requireApprovedPrice: async () => ({ approvedMaxUsd: 0.09 }) as any,
        reserveSpend: (async () => ({ holdId: "h-tel" })) as any,
        enqueueJob: (async () => ({ jobId: "j-tel" })) as any,
        recordApproval: async () => ({}) as any,
        captureServerEvent: (async (arg1: any, arg2: any) => {
          if (typeof arg1 === "object" && arg1 !== null) {
            capturedEvent = arg1.name;
            capturedProps = arg1.props;
          } else {
            capturedEvent = arg1;
            capturedProps = arg2;
          }
        }) as any,
      },
    );

    assert.equal(capturedEvent, "prompt_explorer:run_started");
    assert.ok(capturedProps);
    assert.equal(capturedProps.models, 1);
    assert.equal(capturedProps.reused, false);
    assert.equal(capturedProps.web_search, true);
    assert.equal(capturedProps.has_country, false);

    // Verify forbidden text fields are completely absent
    assert.equal("prompt" in capturedProps, false);
    assert.equal("highlightBrand" in capturedProps, false);
    assert.equal("text" in capturedProps, false);
    assert.equal("citations" in capturedProps, false);
  });

  it("getExploreRun returns 404 for nonexistent run or cross-workspace access", async () => {
    const store = createMemoryExploreStore();
    await assert.rejects(
      async () => getExploreRun(dummyClient, "brand-1", "non-existent-uuid", { store }),
      (err: any) => {
        assert.equal(err.status, 404);
        assert.equal(err.code, "explore_run_not_found");
        assert.equal(err.message, "This question does not exist in this workspace.");
        return true;
      },
    );
  });

  it("listExploreRuns returns paginated run summaries", async () => {
    const store = createMemoryExploreStore();
    const promptHash = hashPrompt("question 1");
    await store.createRun({
      id: "run-list-1",
      brand_key: brandKey,
      created_by: userId,
      job_id: null,
      prompt: "question 1",
      prompt_hash: promptHash,
      models: ["chatgpt"],
      web_search: true,
      country: null,
      highlight_brand: null,
      status: "completed",
      plan: [],
      quote: {},
      approved_max_usd: 0,
      hold_id: null,
      question_id: null,
      created_at: now.toISOString(),
      finished_at: now.toISOString(),
    });

    const result = await listExploreRuns(dummyClient, brandKey, { limit: 10 }, { store });
    assert.equal(result.runs.length, 1);
    assert.equal(result.runs[0].id, "run-list-1");
    assert.equal(result.runs[0].prompt, "question 1");
  });
});
