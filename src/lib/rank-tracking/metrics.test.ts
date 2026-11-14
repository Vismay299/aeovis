// F15 Phase 4 (P4.T1.S2): keyword stats refresh server.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AppError } from "../http/appError.ts";
import { refreshKeywordMetrics } from "./metrics.ts";
import { estimateMetricsRun } from "../pricing/actions/rankTracking.ts";
import { getPricedAction } from "../pricing/pricedActions.ts";
import { createMemoryRankTrackingRepository } from "./memoryRepository.ts";
import { POST as metricsRefreshPost } from "../../app/api/customer/rank-tracking/configs/[configId]/metrics/refresh/route.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const overviewFixture = JSON.parse(
  readFileSync(join(HERE, "../../../tests/fixtures/f15/keyword-overview-3.json"), "utf8"),
) as {
  items: Array<{
    keyword: string;
    keyword_info?: { search_volume?: number | null; cpc?: number | null; competition?: number | null } | null;
    keyword_properties?: { keyword_difficulty?: number | null } | null;
  }>;
};

const overviewRows = overviewFixture.items.map((item) => ({
  keyword: item.keyword,
  searchVolume: item.keyword_info?.search_volume ?? null,
  cpc: item.keyword_info?.cpc ?? null,
  competition: item.keyword_info?.competition ?? null,
  competitionLevel: null,
  keywordDifficulty: item.keyword_properties?.keyword_difficulty ?? null,
  intent: null,
  monthlySearches: [],
}));

const NOW = new Date("2026-10-21T00:00:00.000Z");
const freshAt = NOW.toISOString();
const staleAt = new Date(NOW.getTime() - 8 * 86_400_000).toISOString();

function makeMetricsAdmin(rows: Array<{ keyword: string; search_volume: number | null; keyword_difficulty: number | null; cpc: number | null; fetched_at: string }>) {
  const tables: string[] = [];
  const inArgs: unknown[] = [];
  const admin = {
    from: (table: string) => {
      tables.push(table);
      if (table !== "keyword_metrics") throw new Error(`unexpected table ${table}`);
      return {
        select: () => ({
          eq: () => ({
            eq: () => ({
              in: async (values: unknown) => {
                inArgs.push(values);
                return { data: rows, error: null };
              },
            }),
          }),
        }),
      };
    },
  };
  return { tables, inArgs, admin: admin as any };
}

function makeFakeFetch(rows: typeof overviewRows) {
  const calls: any[] = [];
  const fetch = (async (_client: any, params: any) => {
    calls.push(params);
    return rows;
  }) as any;
  return { calls, fetch };
}

function spies() {
  const upserts: Array<{ admin: any; rows: any[] }> = [];
  const logs: any[] = [];
  return {
    upserts,
    logs,
    upsertMetrics: (async (admin: any, rows: any[]) => {
      upserts.push({ admin, rows });
    }) as any,
    appendResearch: (async (_admin: any, input: any) => {
      logs.push(input);
    }) as any,
  };
}

const repoWs = (admin: any, brandKey = "brand-a") => ({ brandKey, userId: "user-1", admin });

async function seedNational(repo: ReturnType<typeof createMemoryRankTrackingRepository>, keywords: string[], brandKey = "brand-a", locationCode = 2840, languageCode = "en") {
  const config = await repo.insertConfig({
    brand_key: brandKey,
    domain: "example.com",
    location_code: locationCode,
    language_code: languageCode,
    location_name: null,
    devices: "mobile",
    serp_depth: 40,
    schedule_interval: "weekly",
    is_active: true,
    next_check_at: null,
    created_by: null,
  } as any);
  const ids = await repo.addKeywords(brandKey, config.id, keywords.map((keyword) => ({ keyword })));
  return { config, ids };
}

test("national: fresh rows are copied free, nothing is bought", async () => {
  const repo = createMemoryRankTrackingRepository();
  const keywords = overviewFixture.items.map((item) => item.keyword);
  const { config } = await seedNational(repo, keywords);
  const admin = makeMetricsAdmin(
    overviewFixture.items.map((item) => ({
      keyword: item.keyword,
      search_volume: item.keyword_info?.search_volume ?? null,
      keyword_difficulty: item.keyword_properties?.keyword_difficulty ?? null,
      cpc: item.keyword_info?.cpc ?? null,
      fetched_at: freshAt,
    })),
  );
  const fetcher = makeFakeFetch(overviewRows);
  const s = spies();
  const out = await refreshKeywordMetrics(
    repoWs(admin.admin) as any,
    config.id,
    { maxUsd: 1, requestId: crypto.randomUUID() },
    { repo, fetchKeywordMetricsForList: fetcher.fetch, upsertMetrics: s.upsertMetrics, appendResearch: s.appendResearch, now: () => NOW },
  );
  assert.deepEqual(out, { updated: 3, fromCache: 3, bought: 0 });
  assert.equal(fetcher.calls.length, 0);
  assert.equal(s.upserts.length, 0);
  const stored = await repo.listKeywords("brand-a", config.id);
  for (const row of stored) {
    assert.equal(row.metrics_source, "cache");
    assert.equal(row.metrics_fetched_at, freshAt);
  }
  assert.equal(s.logs.length, 1);
  assert.equal(s.logs[0].kind, "rank_tracking.metrics");
  assert.equal(s.logs[0].researchKey, config.id);
  assert.ok(s.logs[0].summary.includes("example.com"));
});

test("national: stale rows are bought, upserted, and merged with the cache", async () => {
  const repo = createMemoryRankTrackingRepository();
  const keywords = overviewFixture.items.map((item) => item.keyword);
  const { config } = await seedNational(repo, keywords);
  const admin = makeMetricsAdmin([
    {
      keyword: keywords[0],
      search_volume: 1,
      keyword_difficulty: 1,
      cpc: 0.01,
      fetched_at: freshAt,
    },
    {
      keyword: keywords[1],
      search_volume: 1,
      keyword_difficulty: 1,
      cpc: 0.01,
      fetched_at: staleAt,
    },
  ]);
  const fetcher = makeFakeFetch(overviewRows);
  const s = spies();
  const requestId = crypto.randomUUID();
  const out = await refreshKeywordMetrics(
    repoWs(admin.admin) as any,
    config.id,
    { maxUsd: 1, requestId },
    { repo, fetchKeywordMetricsForList: fetcher.fetch, upsertMetrics: s.upsertMetrics, appendResearch: s.appendResearch, now: () => NOW },
  );
  assert.deepEqual(out, { updated: 3, fromCache: 1, bought: 2 });
  assert.equal(fetcher.calls.length, 1);
  assert.equal(fetcher.calls[0].locationCode, 2840);
  assert.equal(fetcher.calls[0].languageCode, "en");
  assert.equal(fetcher.calls[0].locationName, undefined);
  assert.deepEqual([...fetcher.calls[0].keywords].sort(), [keywords[1].toLowerCase(), keywords[2].toLowerCase()].sort());
  const callCtx = fetcher.calls[0].call("batch-0:labs");
  assert.equal(callCtx.feature, "rank_tracking.metrics");
  assert.ok(String(callCtx.idempotencyKey).includes(requestId));
  assert.equal(callCtx.maxUsd, 1);
  assert.equal(s.upserts.length, 1);
  assert.equal(s.upserts[0].rows.length, 2);
  for (const row of s.upserts[0].rows) {
    assert.equal(row.source, "labs");
    assert.equal(row.location_code, 2840);
    assert.equal(row.language_code, "en");
  }
  const stored = await repo.listKeywords("brand-a", config.id);
  const byKeyword = new Map(stored.map((row) => [row.keyword, row]));
  assert.equal(byKeyword.get(keywords[0])?.metrics_source, "cache");
  assert.equal(byKeyword.get(keywords[1])?.metrics_source, "labs");
  assert.equal(byKeyword.get(keywords[1])?.search_volume, 9900);
  assert.equal(byKeyword.get(keywords[2])?.metrics_source, "labs");
  assert.equal(s.logs.length, 1);
});

test("Ads country upserts with the google_ads source", async () => {
  const repo = createMemoryRankTrackingRepository();
  const { config } = await seedNational(repo, ["alpha", "beta"], "brand-a", 2020, "ca");
  const admin = makeMetricsAdmin([]);
  const rows = [
    { keyword: "alpha", searchVolume: 500, cpc: 0.2, competition: 0.3, competitionLevel: null, keywordDifficulty: null, intent: null, monthlySearches: [] },
    { keyword: "beta", searchVolume: 600, cpc: 0.25, competition: 0.4, competitionLevel: null, keywordDifficulty: null, intent: null, monthlySearches: [] },
  ];
  const fetcher = makeFakeFetch(rows);
  const s = spies();
  const out = await refreshKeywordMetrics(
    repoWs(admin.admin) as any,
    config.id,
    { maxUsd: 1, requestId: crypto.randomUUID() },
    { repo, fetchKeywordMetricsForList: fetcher.fetch, upsertMetrics: s.upsertMetrics, appendResearch: s.appendResearch, now: () => NOW },
  );
  assert.deepEqual(out, { updated: 2, fromCache: 0, bought: 2 });
  assert.equal(fetcher.calls[0].languageCode, "ca");
  assert.equal(s.upserts[0].rows[0].source, "google_ads");
  const stored = await repo.listKeywords("brand-a", config.id);
  for (const row of stored) {
    assert.equal(row.metrics_source, "google_ads");
  }
});

test("local: every keyword is bought with locationName and never written to keyword_metrics", async () => {
  const repo = createMemoryRankTrackingRepository();
  const config = await repo.insertConfig({
    brand_key: "brand-a",
    domain: "example.com",
    location_code: 2356,
    language_code: "en",
    location_name: "Mumbai",
    devices: "mobile",
    serp_depth: 40,
    schedule_interval: "weekly",
    is_active: true,
    next_check_at: null,
    created_by: null,
  } as any);
  await repo.addKeywords("brand-a", config.id, [{ keyword: "oversized t shirts" }, { keyword: "baggy t shirts" }]);
  const admin = makeMetricsAdmin([]);
  const rows = [
    { keyword: "oversized t shirts", searchVolume: 13000, cpc: 0.5, competition: 0.6, competitionLevel: null, keywordDifficulty: 34, intent: null, monthlySearches: [] },
    { keyword: "baggy t shirts", searchVolume: 9000, cpc: 0.4, competition: 0.5, competitionLevel: null, keywordDifficulty: 41, intent: null, monthlySearches: [] },
  ];
  const fetcher = makeFakeFetch(rows);
  const s = spies();
  const requestId = crypto.randomUUID();
  const out = await refreshKeywordMetrics(
    repoWs(admin.admin) as any,
    config.id,
    { maxUsd: 1, requestId },
    { repo, fetchKeywordMetricsForList: fetcher.fetch, upsertMetrics: s.upsertMetrics, appendResearch: s.appendResearch, now: () => NOW },
  );
  assert.deepEqual(out, { updated: 2, fromCache: 0, bought: 2 });
  assert.equal(fetcher.calls.length, 1);
  assert.equal(fetcher.calls[0].locationName, "Mumbai");
  assert.equal(admin.tables.length, 0);
  assert.equal(s.upserts.length, 0);
  const stored = await repo.listKeywords("brand-a", config.id);
  for (const row of stored) {
    assert.equal(row.metrics_source, "google_ads");
    assert.ok((row.search_volume ?? 0) > 0);
  }
  assert.equal(s.logs[0].kind, "rank_tracking.metrics");
});

test("unknown tracker is refused before any provider call", async () => {
  const repo = createMemoryRankTrackingRepository();
  const admin = makeMetricsAdmin([]);
  const fetcher = makeFakeFetch(overviewRows);
  const s = spies();
  await assert.rejects(
    () =>
      refreshKeywordMetrics(
        repoWs(admin.admin) as any,
        "00000000-0000-4000-8000-000000000000",
        { maxUsd: 1, requestId: crypto.randomUUID() },
        { repo, fetchKeywordMetricsForList: fetcher.fetch, upsertMetrics: s.upsertMetrics, appendResearch: s.appendResearch, now: () => NOW },
      ),
    (err: any) => err instanceof AppError && err.status === 404 && err.code === "tracker_not_found",
  );
  assert.equal(fetcher.calls.length, 0);
  assert.equal(admin.tables.length, 0);
});

test("provider failure maps to rank_metrics_unavailable", async () => {
  const repo = createMemoryRankTrackingRepository();
  const { config } = await seedNational(repo, ["alpha"]);
  const admin = makeMetricsAdmin([]);
  const s = spies();
  await assert.rejects(
    () =>
      refreshKeywordMetrics(
        repoWs(admin.admin) as any,
        config.id,
        { maxUsd: 1, requestId: crypto.randomUUID() },
        {
          repo,
          fetchKeywordMetricsForList: (async () => {
            throw new AppError(500, "dataforseo_call_failed", "boom");
          }) as any,
          upsertMetrics: s.upsertMetrics,
          appendResearch: s.appendResearch,
          now: () => NOW,
        },
      ),
    (err: any) => err instanceof AppError && err.status === 502 && err.code === "rank_metrics_unavailable",
  );
});

test("priced action: blocked nothing_to_refresh, national and local lines, approval rule", async () => {
  const ctxFor = (admin: any, brandKey = "brand-a") => ({ brandKey, admin, env: {}, now: NOW });
  assert.equal(getPricedAction("rank_tracking.metrics.run")?.requireApproval, true);
  assert.equal(getPricedAction("rank_tracking.metrics.run")?.feature, "rank_tracking.metrics");

  const foreign = createMemoryRankTrackingRepository();
  const missing = await estimateMetricsRun(ctxFor({} as any, "brand-a") as any, { configId: crypto.randomUUID() } as any, { repo: foreign } as any);
  assert.equal(missing.blocked?.code, "tracker_not_found");

  const repo = createMemoryRankTrackingRepository();
  const keywords = overviewFixture.items.map((item) => item.keyword);
  const { config } = await seedNational(repo, keywords);
  const freshAdmin = makeMetricsAdmin(
    keywords.map((keyword) => ({ keyword, search_volume: 1, keyword_difficulty: 1, cpc: 0.1, fetched_at: freshAt })),
  );
  const blocked = await estimateMetricsRun(ctxFor(freshAdmin.admin) as any, { configId: config.id } as any, { repo, now: () => NOW } as any);
  assert.equal(blocked.blocked?.code, "nothing_to_refresh");

  const staleAdmin = makeMetricsAdmin([]);
  const quote = await estimateMetricsRun(ctxFor(staleAdmin.admin) as any, { configId: config.id } as any, { repo, now: () => NOW } as any);
  assert.equal(quote.blocked, null);
  assert.equal(quote.lines.length, 1);
  assert.equal(quote.lines[0].label, "Keyword stats for 3 keywords");
  assert.equal(quote.units.find((unit) => unit.key === "fromCache")?.count, 0);
  assert.equal(quote.units.find((unit) => unit.key === "stale")?.count, 3);

  const local = createMemoryRankTrackingRepository();
  const localConfig = await local.insertConfig({
    brand_key: "brand-a",
    domain: "example.com",
    location_code: 2356,
    language_code: "en",
    location_name: "Mumbai",
    devices: "mobile",
    serp_depth: 40,
    schedule_interval: "weekly",
    is_active: true,
    next_check_at: null,
    created_by: null,
  } as any);
  await local.addKeywords("brand-a", localConfig.id, [{ keyword: "alpha" }]);
  const localQuote = await estimateMetricsRun(ctxFor({} as any) as any, { configId: localConfig.id } as any, { repo: local, now: () => NOW } as any);
  assert.equal(localQuote.blocked, null);
  assert.equal(localQuote.lines.length, 2);
  assert.equal(localQuote.lines[0].label, "City volume for 1 keywords in Mumbai");
  assert.equal(localQuote.lines[1].label, "Difficulty for 1 keywords");
});

function routeRequest(body: unknown) {
  return new Request("http://localhost/api/customer/rank-tracking/configs/x/metrics/refresh", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const routeWs = { user: { id: "user-1" }, brandKey: "brand-a", brand: { brandKey: "brand-a" }, role: "member", admin: {} as any };

test("route: flag off returns 404 before any provider call", async () => {
  let refreshCalls = 0;
  let providerCalls = 0;
  const repo = createMemoryRankTrackingRepository();
  const { config } = await seedNational(repo, ["kw"]);
  const res = await metricsRefreshPost(
    routeRequest({ requestId: crypto.randomUUID() }),
    { params: Promise.resolve({ configId: config.id }) },
    {
      requireWorkspace: (async () => routeWs) as any,
      isFeatureEnabled: (async () => false) as any,
      repo,
      requireApprovedPrice: (async () => {
        throw new Error("must not quote when flag is off");
      }) as any,
      refreshKeywordMetrics: (async () => {
        refreshCalls++;
        providerCalls++;
        return { updated: 0, fromCache: 0, bought: 0 };
      }) as any,
    },
  );
  assert.equal(res.status, 404);
  assert.equal((await res.json()).code, "feature_unavailable");
  assert.equal(refreshCalls, 0);
  assert.equal(providerCalls, 0);
});

test("route: nothing_to_refresh returns 409 before any provider call", async () => {
  let refreshCalls = 0;
  const repo = createMemoryRankTrackingRepository();
  const { config } = await seedNational(repo, ["kw"]);
  const res = await metricsRefreshPost(
    routeRequest({ requestId: crypto.randomUUID() }),
    { params: Promise.resolve({ configId: config.id }) },
    {
      requireWorkspace: (async () => routeWs) as any,
      isFeatureEnabled: (async () => true) as any,
      repo,
      requireApprovedPrice: (async () => {
        throw new AppError(409, "nothing_to_refresh", "Every keyword's stats were updated in the last 7 days.");
      }) as any,
      refreshKeywordMetrics: (async () => {
        refreshCalls++;
        return { updated: 0, fromCache: 0, bought: 0 };
      }) as any,
    },
  );
  assert.equal(res.status, 409);
  assert.equal((await res.json()).code, "nothing_to_refresh");
  assert.equal(refreshCalls, 0);
});

test("route: approval_required returns 400 before any provider call", async () => {
  let refreshCalls = 0;
  const repo = createMemoryRankTrackingRepository();
  const { config } = await seedNational(repo, ["kw"]);
  const res = await metricsRefreshPost(
    routeRequest({ maxUsd: 0.5, requestId: crypto.randomUUID() }),
    { params: Promise.resolve({ configId: config.id }) },
    {
      requireWorkspace: (async () => routeWs) as any,
      isFeatureEnabled: (async () => true) as any,
      repo,
      requireApprovedPrice: (async () => {
        throw new AppError(400, "approval_required", "Approval required.", { details: { quote: { totalUsd: 0.1 } } });
      }) as any,
      refreshKeywordMetrics: (async () => {
        refreshCalls++;
        return { updated: 0, fromCache: 0, bought: 0 };
      }) as any,
    },
  );
  assert.equal(res.status, 400);
  assert.equal((await res.json()).code, "approval_required");
  assert.equal(refreshCalls, 0);
});

test("route: success returns the refresh result with no-store", async () => {
  const repo = createMemoryRankTrackingRepository();
  const keywords = overviewFixture.items.map((item) => item.keyword);
  const { config } = await seedNational(repo, keywords);
  const admin = makeMetricsAdmin(
    keywords.map((keyword) => ({ keyword, search_volume: 1, keyword_difficulty: 1, cpc: 0.1, fetched_at: freshAt })),
  );
  const fetcher = makeFakeFetch(overviewRows);
  const s = spies();
  const requestId = crypto.randomUUID();
  const res = await metricsRefreshPost(
    routeRequest({ requestId }),
    { params: Promise.resolve({ configId: config.id }) },
    {
      requireWorkspace: (async () => ({ ...routeWs, admin: admin.admin })) as any,
      isFeatureEnabled: (async () => true) as any,
      repo,
      requireApprovedPrice: (async () => ({ quote: { totalUsd: 0 }, approvedMaxUsd: 0.5, source: "dialog" })) as any,
      refreshKeywordMetrics: ((w: any, id: any, i: any) =>
        refreshKeywordMetrics(w, id, i, {
          repo,
          fetchKeywordMetricsForList: fetcher.fetch,
          upsertMetrics: s.upsertMetrics,
          appendResearch: s.appendResearch,
          now: () => NOW,
        })) as any,
    },
  );
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { updated: 3, fromCache: 3, bought: 0 });
  assert.equal(fetcher.calls.length, 0);
  assert.equal(res.headers.get("cache-control"), "no-store");
});
