// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/lib/dataforseo/client.test.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import assert from "node:assert/strict";
import { test } from "node:test";
import { AppError } from "../../http/appError.ts";
import {
  AmbiguousCallError,
  ChargedCallError,
  SpendRefused,
  UnbilledCallError,
} from "../../spend/errors.ts";
import { createMemoryStore } from "../../spend/memoryStore.ts";
import type { MemoryControl, MemorySpendStore } from "../../spend/memoryStore.ts";
import { createDataforseoClient, meter, meterBatch } from "./client.ts";
import type { DataforseoCallContext } from "./client.ts";
import type { DataforseoApiResponse } from "./envelope.ts";

const FEATURE = "providers.dataforseo.selftest";
const BRAND = "test-brand.example";

function makeHarness(control: Partial<MemoryControl> = {}) {
  const store: MemorySpendStore = createMemoryStore({
    controls: {
      [FEATURE]: {
        enabled: true,
        mode: "all",
        brandAllowlist: [],
        dailyCapUsd: null,
        maxCallUsd: null,
        ...control,
      },
    },
  });
  return {
    store,
    deps: {
      spendDeps: { store },
    },
  };
}

const serpPath = ["v3", "serp", "google", "organic", "live", "advanced"];
const mockSerpItem = {
  type: "organic",
  rank_group: 1,
  domain: "example.com",
};

test("meter never calls the provider when the spend reservation is refused", async () => {
  const { deps } = makeHarness({ enabled: false });
  let providerCalls = 0;
  const fetcher = async () => {
    providerCalls += 1;
    return { data: [mockSerpItem], billing: { costUsd: 0.002, path: serpPath } };
  };

  const meteredLive = meter(fetcher, () => 0.002, FEATURE, deps);
  const ctx: DataforseoCallContext = {
    brandKey: BRAND,
    idempotencyKey: "refused-call-1",
  };

  await assert.rejects(
    meteredLive(ctx, {}),
    (err: unknown) => err instanceof SpendRefused && err.reason === "feature_disabled",
  );
  assert.equal(providerCalls, 0);
});

test("meter holds the estimate, then confirms the hold at the billed cost", async () => {
  const { store, deps } = makeHarness();
  const fetcher = async () => ({
    data: [mockSerpItem],
    billing: { costUsd: 0.0015, path: serpPath },
  });

  const meteredLive = meter(fetcher, () => 0.004, FEATURE, deps);
  const ctx: DataforseoCallContext = {
    brandKey: BRAND,
    idempotencyKey: "success-call-1",
  };

  const result = await meteredLive(ctx, {});
  assert.deepEqual(result, [mockSerpItem]);

  const holds = Array.from(store.holds.values());
  assert.equal(holds.length, 1);
  const hold = holds[0];
  assert.equal(hold.status, "settled");
  assert.equal(hold.estimateUsd, 0.004);
  assert.equal(hold.actualUsd, 0.0015);

  const ledger = Array.from(store.ledger.values());
  assert.equal(ledger.length, 1);
  assert.equal(ledger[0].accountedUsd, 0.0015);
  assert.equal(ledger[0].costSource, "provider_reported");
});

test("meter confirms a charged DataForSEO task failure at its cost before rethrowing", async () => {
  const { store, deps } = makeHarness();
  const fetcher = async () => {
    throw new ChargedCallError("Task failed", {
      actualUsd: 0.0012,
      provider: "dataforseo",
      endpoint: "/v3/serp/google/organic/live/advanced",
      status: 502,
      code: "dataforseo_task_failed",
    });
  };

  const meteredLive = meter(fetcher, () => 0.004, FEATURE, deps);
  const ctx: DataforseoCallContext = {
    brandKey: BRAND,
    idempotencyKey: "charged-err-1",
  };

  await assert.rejects(
    meteredLive(ctx, {}),
    (err: unknown) => err instanceof ChargedCallError && err.actualUsd === 0.0012,
  );

  const holds = Array.from(store.holds.values());
  assert.equal(holds.length, 1);
  const hold = holds[0];
  assert.equal(hold.status, "settled");
  assert.equal(hold.actualUsd, 0.0012);
});

test("meter releases the hold for an unbilled invalid-field failure and throws error", async () => {
  const { store, deps } = makeHarness();
  const fetcher = async () => {
    throw new UnbilledCallError("Invalid Field: 'keyword'", {
      status: 422,
      code: "dataforseo_invalid_field",
      details: { field: "keyword" },
    });
  };

  const meteredLive = meter(fetcher, () => 0.004, FEATURE, deps);
  const ctx: DataforseoCallContext = {
    brandKey: BRAND,
    idempotencyKey: "invalid-field-1",
  };

  await assert.rejects(
    meteredLive(ctx, {}),
    (err: unknown) => err instanceof UnbilledCallError && err.code === "dataforseo_invalid_field",
  );

  const holds = Array.from(store.holds.values());
  assert.equal(holds.length, 1);
  const hold = holds[0];
  assert.equal(hold.status, "released");
  assert.equal(hold.releaseReason, "unbilled_error");
});

test("meter releases the hold when transport failure occurs before billing (UnbilledCallError)", async () => {
  const { store, deps } = makeHarness();
  const fetcher = async () => {
    throw new UnbilledCallError("DataForSEO request failed", {
      status: 502,
      code: "dataforseo_request_failed",
    });
  };

  const meteredLive = meter(fetcher, () => 0.004, FEATURE, deps);
  const ctx: DataforseoCallContext = {
    brandKey: BRAND,
    idempotencyKey: "transport-unbilled-1",
  };

  await assert.rejects(
    meteredLive(ctx, {}),
    (err: unknown) => err instanceof UnbilledCallError && err.code === "dataforseo_request_failed",
  );

  const holds = Array.from(store.holds.values());
  assert.equal(holds.length, 1);
  const hold = holds[0];
  assert.equal(hold.status, "released");
  assert.equal(hold.releaseReason, "unbilled_error");
});

test("meter settles ambiguous failure at estimate (actualUsd: null)", async () => {
  const { store, deps } = makeHarness();
  const fetcher = async () => {
    throw new AmbiguousCallError("POST timed out", {
      status: 504,
      code: "dataforseo_timeout",
    });
  };

  const meteredLive = meter(fetcher, () => 0.004, FEATURE, deps);
  const ctx: DataforseoCallContext = {
    brandKey: BRAND,
    idempotencyKey: "ambiguous-call-1",
  };

  await assert.rejects(
    meteredLive(ctx, {}),
    (err: unknown) => err instanceof AmbiguousCallError && err.code === "dataforseo_timeout",
  );

  const holds = Array.from(store.holds.values());
  assert.equal(holds.length, 1);
  const hold = holds[0];
  assert.equal(hold.status, "settled");
  // Ambiguous call leaves actualUsd null, counted at the estimate
  assert.equal(hold.actualUsd, null);
});

test("missing feature throws AppError(500, spend_feature_required) before reservation", async () => {
  const { store, deps } = makeHarness();
  let called = false;
  const meteredLive = meter(async () => {
    called = true;
    return { data: [], billing: { costUsd: 0, path: serpPath } };
  }, () => 0.004, null, deps);

  const ctx: DataforseoCallContext = {
    brandKey: BRAND,
    idempotencyKey: "no-feature-1",
  };

  await assert.rejects(
    meteredLive(ctx, {}),
    (err: unknown) => err instanceof AppError && err.code === "spend_feature_required",
  );
  assert.equal(called, false);
  assert.equal(store.holds.size, 0);
});

test("meterBatch bills the batch with one hold on summed estimate and settles on billed calls", async () => {
  const { store, deps } = makeHarness();

  let callIndex = 0;
  const fetcher = async (input: { id: string }) => {
    callIndex += 1;
    if (input.id === "fail-unbilled") {
      throw new UnbilledCallError("Rate limited", { status: 429, code: "dataforseo_rate_limited" });
    }
    return {
      data: { id: input.id },
      billing: { costUsd: 0.001, path: serpPath },
    };
  };

  const batchRunner = meterBatch(fetcher, () => 0.002, FEATURE, deps);
  const ctx: DataforseoCallContext = {
    brandKey: BRAND,
    idempotencyKey: "batch-1",
  };

  const outcomes = await batchRunner(ctx, [
    { id: "call-1" },
    { id: "fail-unbilled" },
    { id: "call-3" },
  ]);

  assert.equal(outcomes.length, 3);
  assert.equal(outcomes[0].status, "fulfilled");
  assert.equal(outcomes[1].status, "rejected");
  assert.equal(outcomes[2].status, "fulfilled");

  const holds = Array.from(store.holds.values());
  assert.equal(holds.length, 1);
  const hold = holds[0];
  assert.equal(hold.status, "settled");
  // 3 calls * 0.002 estimate = 0.006 total estimate
  assert.equal(hold.estimateUsd, 0.006);
  // 2 fulfilled calls * 0.001 = 0.002 settled
  assert.equal(hold.actualUsd, 0.002);
});

test("meterBatch releases hold when no calls were billed", async () => {
  const { store, deps } = makeHarness();

  const fetcher = async () => {
    throw new UnbilledCallError("Bad request", { status: 400, code: "dataforseo_request_refused" });
  };

  const batchRunner = meterBatch(fetcher, () => 0.002, FEATURE, deps);
  const ctx: DataforseoCallContext = {
    brandKey: BRAND,
    idempotencyKey: "batch-all-unbilled",
  };

  const outcomes = await batchRunner(ctx, [{ id: "1" }, { id: "2" }]);
  assert.equal(outcomes.every((o) => o.status === "rejected"), true);

  const holds = Array.from(store.holds.values());
  assert.equal(holds.length, 1);
  const hold = holds[0];
  assert.equal(hold.status, "released");
  assert.equal(hold.releaseReason, "not_billed");
});

test("meterBatch returns the call outcomes when releasing an unbilled hold fails", async () => {
  const { deps } = makeHarness();
  const errors: unknown[] = [];
  const fetcher = async (): Promise<DataforseoApiResponse<unknown>> => {
    throw new UnbilledCallError("Bad request", { status: 400, code: "dataforseo_request_refused" });
  };
  const batchRunner = meterBatch(fetcher, () => 0.002, FEATURE, {
    ...deps,
    spendDeps: { ...deps.spendDeps, logger: { error: (...a: unknown[]) => errors.push(a), warn: () => {} } },
    releaseSpend: async () => {
      throw new Error("store down");
    },
  });

  const outcomes = await batchRunner(
    { brandKey: BRAND, idempotencyKey: "batch-release-fails" },
    [{ id: "1" }],
  );
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0].status, "rejected");
  assert.ok((outcomes[0] as PromiseRejectedResult).reason instanceof UnbilledCallError);
  assert.equal(errors.length, 1);
});

test("every entry of createDataforseoClient is priced with estimateUsd > 0", async () => {
  const observedEstimates: Array<{ name: string; estimateUsd: number }> = [];

  const spyMetered = async (
    i: { estimateUsd: number; feature: string; idempotencyKey: string },
    call: () => Promise<unknown>,
  ) => {
    observedEstimates.push({ name: i.idempotencyKey, estimateUsd: i.estimateUsd });
    return (await call()) as any;
  };

  const spyReserve = async (
    i: { estimateUsd: number; feature: string; idempotencyKey: string },
  ) => {
    observedEstimates.push({ name: i.idempotencyKey, estimateUsd: i.estimateUsd });
    return { holdId: "spy-hold", existing: false };
  };

  const client = createDataforseoClient({
    metered: spyMetered as any,
    reserveSpend: spyReserve as any,
    settleSpendBatch: async () => {},
    releaseSpend: async () => true,
    keepAlive: async () => {},
    fetchers: {
      fetchLiveSerp: async () => ({ data: [], billing: { costUsd: 0.002, path: ["serp"] } }),
      fetchRankCheckSerp: async () => ({
        data: { keywordId: "k", keyword: "q", position: 1, url: null, serpFeatures: [] },
        billing: { costUsd: 0.002, path: ["serp"] },
      }),
      postRankCheckTasks: async () => ({ data: [], billing: { costUsd: 0.002, path: ["serp"] } }),
      fetchLocalSerp: async () => ({ data: [], billing: { costUsd: 0.002, path: ["serp"] } }),
      postLocalSerpTasks: async () => ({ data: [], billing: { costUsd: 0.002, path: ["serp"] } }),
      fetchLlmMentionsSearch: async () => ({ data: [], billing: { costUsd: 0.002, path: ["ai"] } }),
      fetchLlmAggregatedMetrics: async () => ({ data: {} as any, billing: { costUsd: 0.002, path: ["ai"] } }),
      fetchLlmTopPages: async () => ({ data: [], billing: { costUsd: 0.002, path: ["ai"] } }),
      fetchLlmCrossAggregatedMetrics: async () => ({ data: [], billing: { costUsd: 0.002, path: ["ai"] } }),
    },
  });

  const ctx = (name: string): DataforseoCallContext => ({
    brandKey: BRAND,
    idempotencyKey: name,
    feature: FEATURE,
  });

  // Call every entry on client.serp
  await client.serp.live(ctx("serp.live"), { keyword: "shoes", locationCode: 2840, languageCode: "en" });
  await client.serp.rankCheckBatch(ctx("serp.rankCheckBatch"), [
    { keyword: "shoes", keywordId: "k1", locationCode: 2840, languageCode: "en", device: "desktop", targetDomain: "example.com", depth: 10 },
  ]);
  await client.serp.rankCheckTaskPost(ctx("serp.rankCheckTaskPost"), {
    tasks: [{ keyword: "shoes", keywordId: "k1", device: "desktop" }],
    locationCode: 2840,
    languageCode: "en",
    depth: 10,
    targetDomain: "example.com",
  });
  await client.serp.local(ctx("serp.local"), { keyword: "pizza", languageCode: "en", searchType: "maps", device: "desktop", depth: 20 });
  await client.serp.localTaskPost(ctx("serp.localTaskPost"), {
    keyword: "pizza",
    locationCoordinates: ["1,1,13z"],
    languageCode: "en",
    device: "desktop",
    depth: 20,
  });

  // Call every entry on client.aiSearch
  await client.aiSearch.mentionsSearch(ctx("aiSearch.mentionsSearch"), {
    target: { domain: "example.com" },
    platform: "chat_gpt",
    locationCode: 2840,
    languageCode: "en",
  });
  await client.aiSearch.aggregatedMetrics(ctx("aiSearch.aggregatedMetrics"), {
    target: { domain: "example.com" },
    platform: "chat_gpt",
    locationCode: 2840,
    languageCode: "en",
  });
  await client.aiSearch.topPages(ctx("aiSearch.topPages"), {
    target: { domain: "example.com" },
    platform: "chat_gpt",
    locationCode: 2840,
    languageCode: "en",
  });
  await client.aiSearch.crossAggregatedMetrics(ctx("aiSearch.crossAggregatedMetrics"), {
    groups: [
      { key: "g1", target: { domain: "example.com" } },
      { key: "g2", target: { domain: "competitor.com" } },
    ],
    platform: "chat_gpt",
    locationCode: 2840,
    languageCode: "en",
  });

  assert.equal(observedEstimates.length, 9);
  for (const obs of observedEstimates) {
    assert.ok(
      obs.estimateUsd > 0,
      `Expected estimateUsd > 0 for entry ${obs.name}, got ${obs.estimateUsd}`,
    );
  }
});
