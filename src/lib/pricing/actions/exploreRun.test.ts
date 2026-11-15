import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { estimateExploreRun } from "./exploreRun.ts";
import { getPricedAction } from "../pricedActions.ts";
import "./index.ts"; // registers all actions

describe("src/lib/pricing/actions/exploreRun.ts", () => {
  const dummyCtx = {
    brandKey: "brand-1",
    admin: {} as any,
    env: {
      FEATURE_DATAFORSEO_ENGINES: "on",
      DATAFORSEO_API_KEY: "test-key",
      EXPLORE_OPENROUTER_RESERVE_USD: "0.18",
    },
    now: new Date("2026-10-22T09:30:00.000Z"),
  };

  it("is registered in the priced action registry with requireApproval: true", () => {
    const action = getPricedAction("ai_visibility.explore.run");
    assert.ok(action);
    assert.equal(action.key, "ai_visibility.explore.run");
    assert.equal(action.feature, "ai_visibility.explore");
    assert.equal(action.requireApproval, true);
  });

  it("calculates micro-dollar sum exactly (0.09 + 0.18 = 0.27 via micros)", async () => {
    const quote = await estimateExploreRun(
      dummyCtx,
      {
        prompt: "best running shoes",
        models: ["chatgpt", "perplexity"],
        webSearch: true,
        country: null,
        highlightBrand: null,
        fresh: true,
      },
      {
        dispatchControl: async () => ({ paused: false, brand_allowlist: [] }),
        resolveRoutes: async () => [
          {
            model: "chatgpt",
            route: "dataforseo",
            modelName: "gpt-5.6-luna",
            reserveUsd: 0.09,
            skipped: null,
          },
          {
            model: "perplexity",
            route: "openrouter",
            modelName: "perplexity/sonar-reasoning-pro",
            reserveUsd: 0.18,
            skipped: null,
          },
        ],
      },
    );

    assert.equal(quote.totalUsd, 0.27);
    assert.equal(quote.lines.length, 2);
    assert.equal(quote.lines[0].label, "ChatGPT · up to $0.09");
    assert.equal(quote.lines[0].totalUsd, 0.09);
    assert.equal(quote.lines[1].label, "Perplexity · up to $0.18");
    assert.equal(quote.lines[1].totalUsd, 0.18);
    assert.equal(quote.blocked, null);
    assert.deepEqual(quote.units, [
      { key: "models", label: "models", count: 2 },
      { key: "reused", label: "reused answers", count: 0 },
    ]);
    assert.deepEqual(quote.warnings, [
      {
        code: "cost_note",
        message: "You pay only the provider's charge for each answer, up to this amount.",
      },
    ]);
  });

  it("quotes reused model at $0.00 and marks it in units", async () => {
    const reusedMap = new Map([
      [
        "chatgpt" as const,
        {
          observationId: "obs-1",
          runId: "run-1",
          observedAt: "2026-10-21T09:30:00.000Z",
          configVersion: "v1",
        },
      ],
    ]);

    const quote = await estimateExploreRun(
      dummyCtx,
      {
        prompt: "best running shoes",
        models: ["chatgpt", "perplexity"],
        webSearch: true,
        country: null,
        highlightBrand: null,
        fresh: false,
      },
      {
        dispatchControl: async () => ({ paused: false }),
        findReusable: async () => reusedMap,
        resolveRoutes: async () => [
          {
            model: "chatgpt",
            route: "dataforseo",
            modelName: "gpt-5.6-luna",
            reserveUsd: 0.09,
            skipped: null,
          },
          {
            model: "perplexity",
            route: "dataforseo",
            modelName: "sonar-reasoning-pro",
            reserveUsd: 0.04,
            skipped: null,
          },
        ],
      },
    );

    assert.equal(quote.totalUsd, 0.04);
    assert.equal(quote.lines[0].label, "ChatGPT · reused (last 7 days)");
    assert.equal(quote.lines[0].totalUsd, 0);
    assert.equal(quote.lines[1].label, "Perplexity · up to $0.04");
    assert.equal(quote.lines[1].totalUsd, 0.04);
    assert.deepEqual(quote.units, [
      { key: "models", label: "models", count: 2 },
      { key: "reused", label: "reused answers", count: 1 },
    ]);
  });

  it("quotes skipped model for unsupported country at $0.00", async () => {
    const quote = await estimateExploreRun(
      dummyCtx,
      {
        prompt: "best running shoes",
        models: ["chatgpt", "gemini"],
        webSearch: true,
        country: "IN",
        highlightBrand: null,
        fresh: false,
      },
      {
        dispatchControl: async () => ({ paused: false }),
        findReusable: async () => new Map(),
        resolveRoutes: async () => [
          {
            model: "chatgpt",
            route: "dataforseo",
            modelName: "gpt-5.6-luna",
            reserveUsd: 0.09,
            skipped: null,
          },
          {
            model: "gemini",
            route: null,
            modelName: null,
            reserveUsd: 0,
            skipped: "UNSUPPORTED_COUNTRY",
          },
        ],
      },
    );

    assert.equal(quote.totalUsd, 0.09);
    assert.equal(quote.lines[0].label, "ChatGPT · up to $0.09");
    assert.equal(quote.lines[1].label, "Gemini · skipped (not available for India)");
    assert.equal(quote.lines[1].totalUsd, 0);
  });

  it("blocks with exact collection_paused copy when dispatch is paused and brand is not allowlisted", async () => {
    const quote = await estimateExploreRun(
      dummyCtx,
      {
        prompt: "best running shoes",
        models: ["chatgpt"],
        webSearch: true,
        country: null,
        highlightBrand: null,
        fresh: false,
      },
      {
        dispatchControl: async () => ({ paused: true, brand_allowlist: ["allowed-brand"] }),
        findReusable: async () => new Map(),
        resolveRoutes: async () => [
          {
            model: "chatgpt",
            route: "dataforseo",
            modelName: "gpt-5.6-luna",
            reserveUsd: 0.09,
            skipped: null,
          },
        ],
      },
    );

    assert.deepEqual(quote.blocked, {
      code: "collection_paused",
      message: "Answer collection is paused for maintenance, so this question cannot be asked now.",
    });
  });

  it("does not block with collection_paused when dispatch is paused but brand is allowlisted", async () => {
    const allowlistedCtx = { ...dummyCtx, brandKey: "allowed-brand" };
    const quote = await estimateExploreRun(
      allowlistedCtx,
      {
        prompt: "best running shoes",
        models: ["chatgpt"],
        webSearch: true,
        country: null,
        highlightBrand: null,
        fresh: false,
      },
      {
        dispatchControl: async () => ({ paused: true, brand_allowlist: ["allowed-brand"] }),
        findReusable: async () => new Map(),
        resolveRoutes: async () => [
          {
            model: "chatgpt",
            route: "dataforseo",
            modelName: "gpt-5.6-luna",
            reserveUsd: 0.09,
            skipped: null,
          },
        ],
      },
    );

    assert.equal(quote.blocked, null);
    assert.equal(quote.totalUsd, 0.09);
  });

  it("blocks with exact no_models_available copy when all models are skipped or unavailable and none reused", async () => {
    const quote = await estimateExploreRun(
      dummyCtx,
      {
        prompt: "best running shoes",
        models: ["gemini"],
        webSearch: true,
        country: "IN",
        highlightBrand: null,
        fresh: false,
      },
      {
        dispatchControl: async () => ({ paused: false }),
        findReusable: async () => new Map(),
        resolveRoutes: async () => [
          {
            model: "gemini",
            route: null,
            modelName: null,
            reserveUsd: 0,
            skipped: "UNSUPPORTED_COUNTRY",
          },
        ],
      },
    );

    assert.deepEqual(quote.blocked, {
      code: "no_models_available",
      message: "None of the selected models can answer right now. Choose another model or try again later.",
    });
  });
});
