// F15 Phase 4 (P4.T1.S1): keyword suggestions server.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AppError } from "../http/appError.ts";
import { suggestKeywordsForDomain } from "./suggestions.ts";
import { estimateSuggestionsRun } from "../pricing/actions/rankTracking.ts";
import { getPricedAction } from "../pricing/pricedActions.ts";
import { POST as suggestionsPost } from "../../app/api/customer/rank-tracking/suggestions/route.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const rankedFixture = JSON.parse(
  readFileSync(join(HERE, "../../../tests/fixtures/f15/labs-ranked-keywords-100.json"), "utf8"),
) as { items: unknown[] };

function makeFakeCache() {
  const store = new Map<string, { value: any; fetchedAt: string }>();
  const cached = async (input: any, fetcher: () => Promise<any>) => {
    const key = JSON.stringify([input.namespace, input.version, input.keyParts, input.scope, input.brandKey]);
    const hit = store.get(key);
    if (hit) return { value: hit.value, hit: true, fetchedAt: hit.fetchedAt };
    const value = await fetcher();
    const fetchedAt = new Date().toISOString();
    store.set(key, { value, fetchedAt });
    return { value, hit: false, fetchedAt };
  };
  return { store, cached: cached as any };
}

function makeFakeLabs(items: unknown[]) {
  const calls: Array<{ ctx: any; input: any }> = [];
  const rankedKeywords = async (ctx: any, input: any) => {
    calls.push({ ctx, input });
    return { items, totalCount: (items as unknown[]).length };
  };
  return { calls, labs: { domain: { rankedKeywords } } as any };
}

const ws = { brandKey: "brand-a", userId: "user-1", admin: {} as any };

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

test("cacheOnly miss returns null without spending", async () => {
  const cache = makeFakeCache();
  const labs = makeFakeLabs(rankedFixture.items);
  const s = spies();
  const out = await suggestKeywordsForDomain(
    ws as any,
    { domain: "example.com", locationCode: 2840, cacheOnly: true, requestId: crypto.randomUUID() },
    { labs: labs.labs.domain, cached: cache.cached, upsertMetrics: s.upsertMetrics, appendResearch: s.appendResearch },
  );
  assert.equal(out, null);
  assert.equal(labs.calls.length, 0);
  assert.equal(s.upserts.length, 0);
  assert.equal(s.logs.length, 0);
});

test("paid fetch maps rows, caches non-empty results, upserts labs_ranked", async () => {
  const cache = makeFakeCache();
  const labs = makeFakeLabs(rankedFixture.items);
  const s = spies();
  const input = { domain: "https://www.example.com/shop", locationCode: 2840, cacheOnly: false, requestId: crypto.randomUUID() };
  const deps = { labs: labs.labs.domain, cached: cache.cached, upsertMetrics: s.upsertMetrics, appendResearch: s.appendResearch };
  const first = await suggestKeywordsForDomain(ws as any, input, deps);
  assert.ok(first);
  assert.equal(first.cached, false);
  assert.equal(first.keywords.length, rankedFixture.items.length);
  // Honest output of the F14 mapper for the F15 fixture: the fixture carries
  // rank_group (not rank_absolute) and keyword_data.cpc (not
  // keyword_info.cpc), so position/cpc map to null. See SPEC GAP in handoff.
  assert.deepEqual(first.keywords[0], {
    keyword: "oversized t shirts",
    position: null,
    searchVolume: 12100,
    traffic: 410.5,
    cpc: null,
    keywordDifficulty: 34,
  });
  assert.equal(labs.calls.length, 1);
  assert.equal(labs.calls[0].ctx.feature, "rank_tracking.suggestions");
  assert.ok(String(labs.calls[0].ctx.idempotencyKey).includes(input.requestId));
  assert.deepEqual(labs.calls[0].input, {
    target: "example.com",
    locationCode: 2840,
    languageCode: "en",
    limit: 100,
    orderBy: ["ranked_serp_element.serp_item.etv,desc"],
  });
  assert.equal(s.upserts.length, 1);
  assert.ok(s.upserts[0].rows.length > 0);
  for (const row of s.upserts[0].rows) {
    assert.equal(row.source, "labs_ranked");
    assert.equal(row.location_code, 2840);
    assert.equal(row.language_code, "en");
  }
  assert.equal(s.logs.length, 1);
  assert.equal(s.logs[0].kind, "rank_tracking.suggestions");
  assert.equal(s.logs[0].researchKey, "example.com|2840|en");
  assert.ok(s.logs[0].summary.includes("example.com"));
  assert.ok(s.logs[0].summary.includes(`${rankedFixture.items.length} found`));

  const second = await suggestKeywordsForDomain(ws as any, input, deps);
  assert.ok(second);
  assert.equal(second.cached, true);
  assert.deepEqual(second.keywords, first.keywords);
  assert.equal(labs.calls.length, 1);
  assert.equal(s.upserts.length, 1);
});

test("empty fetch is not cached: the provider is called again", async () => {
  const cache = makeFakeCache();
  const labs = makeFakeLabs([]);
  const s = spies();
  const input = { domain: "example.com", locationCode: 2840, cacheOnly: false, requestId: crypto.randomUUID() };
  const deps = { labs: labs.labs.domain, cached: cache.cached, upsertMetrics: s.upsertMetrics, appendResearch: s.appendResearch };
  const first = await suggestKeywordsForDomain(ws as any, input, deps);
  assert.deepEqual(first?.keywords, []);
  const second = await suggestKeywordsForDomain(ws as any, input, deps);
  assert.deepEqual(second?.keywords, []);
  assert.equal(labs.calls.length, 2);
  assert.equal(s.upserts.length, 0);
  assert.equal(s.logs.length, 0);
});

test("non-Labs country is refused with 422 before any spend", async () => {
  const cache = makeFakeCache();
  const labs = makeFakeLabs(rankedFixture.items);
  const s = spies();
  await assert.rejects(
    () =>
      suggestKeywordsForDomain(
        ws as any,
        { domain: "example.com", locationCode: 2020, cacheOnly: false, requestId: crypto.randomUUID() },
        { labs: labs.labs.domain, cached: cache.cached, upsertMetrics: s.upsertMetrics, appendResearch: s.appendResearch },
      ),
    (err: any) => err instanceof AppError && err.status === 422 && err.code === "suggestions_unavailable",
  );
  assert.equal(labs.calls.length, 0);
  assert.equal(s.upserts.length, 0);
  assert.equal(s.logs.length, 0);
});

test("invalid domain is refused before any spend", async () => {
  const cache = makeFakeCache();
  const labs = makeFakeLabs(rankedFixture.items);
  const s = spies();
  await assert.rejects(
    () =>
      suggestKeywordsForDomain(
        ws as any,
        { domain: "not a domain!!!", locationCode: 2840, cacheOnly: false, requestId: crypto.randomUUID() },
        { labs: labs.labs.domain, cached: cache.cached, upsertMetrics: s.upsertMetrics, appendResearch: s.appendResearch },
      ),
    (err: any) => err instanceof AppError && err.status === 400 && err.code === "invalid_domain",
  );
  assert.equal(labs.calls.length, 0);
});

test("priced action: blocked for non-Labs country, line label and approval rule", async () => {
  const ctx = (brandKey = "brand-a") => ({ brandKey, admin: {} as any, env: {}, now: new Date("2026-10-21T00:00:00.000Z") });
  assert.equal(getPricedAction("rank_tracking.suggestions.run")?.requireApproval, false);
  assert.equal(getPricedAction("rank_tracking.suggestions.run")?.feature, "rank_tracking.suggestions");
  const blocked = await estimateSuggestionsRun(ctx(), { domain: "example.com", locationCode: 2020 } as any, { findRecentResearch: async () => null } as any);
  assert.equal(blocked.blocked?.code, "suggestions_unavailable");
  const ok = await estimateSuggestionsRun(ctx(), { domain: "example.com", locationCode: 2840 } as any, { findRecentResearch: async () => null } as any);
  assert.equal(ok.blocked, null);
  assert.equal(ok.lines.length, 1);
  assert.equal(ok.lines[0].label, "Up to 100 keywords this domain ranks for");
  assert.equal(ok.totalUsd, 0.024);
  assert.ok(ok.warnings.find((warning) => warning.code === "cache_note"));
  const recent = await estimateSuggestionsRun(
    ctx(),
    { domain: "example.com", locationCode: 2840 } as any,
    { findRecentResearch: async () => ({ entryDate: "2026-10-19", summary: "old" }) } as any,
  );
  assert.ok(recent.warnings.find((warning) => warning.code === "recent_research"));
});

function routeRequest(body: unknown) {
  return new Request("http://localhost/api/customer/rank-tracking/suggestions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const routeWs = { user: { id: "user-1" }, brandKey: "brand-a", brand: { brandKey: "brand-a" }, role: "member", admin: {} as any };

test("route: flag off returns 404 before any provider call", async () => {
  let suggestCalls = 0;
  let providerCalls = 0;
  const cache = makeFakeCache();
  const res = await suggestionsPost(
    routeRequest({ domain: "example.com", locationCode: 2840, requestId: crypto.randomUUID() }),
    null,
    {
      requireWorkspace: (async () => routeWs) as any,
      isFeatureEnabled: (async () => false) as any,
      requireApprovedPrice: (async () => { throw new Error("must not quote when flag is off"); }) as any,
      suggestKeywordsForDomain: (async () => {
        suggestCalls++;
        providerCalls++;
        return { keywords: [], cached: false, fetchedAt: new Date().toISOString() };
      }) as any,
    },
  );
  assert.equal(res.status, 404);
  assert.equal((await res.json()).code, "feature_unavailable");
  assert.equal(suggestCalls, 0);
  assert.equal(providerCalls, 0);
  void cache;
});

test("route: non-Labs country returns 422 before quote and provider call", async () => {
  let quoteCalls = 0;
  let suggestCalls = 0;
  const res = await suggestionsPost(
    routeRequest({ domain: "example.com", locationCode: 2020, requestId: crypto.randomUUID() }),
    null,
    {
      requireWorkspace: (async () => routeWs) as any,
      isFeatureEnabled: (async () => true) as any,
      requireApprovedPrice: (async () => {
        quoteCalls++;
        return { quote: { totalUsd: 0.024 }, approvedMaxUsd: 0.024, source: "implicit" };
      }) as any,
      suggestKeywordsForDomain: (async () => {
        suggestCalls++;
        return { keywords: [], cached: false, fetchedAt: new Date().toISOString() };
      }) as any,
    },
  );
  assert.equal(res.status, 422);
  assert.equal((await res.json()).code, "suggestions_unavailable");
  assert.equal(quoteCalls, 0);
  assert.equal(suggestCalls, 0);
});

test("route: spend refusal returns before any provider call", async () => {
  let suggestCalls = 0;
  let providerCalls = 0;
  const res = await suggestionsPost(
    routeRequest({ domain: "example.com", locationCode: 2840, maxUsd: 0.001, requestId: crypto.randomUUID() }),
    null,
    {
      requireWorkspace: (async () => routeWs) as any,
      isFeatureEnabled: (async () => true) as any,
      requireApprovedPrice: (async () => {
        throw new AppError(409, "price_changed", "changed", { details: { quote: { totalUsd: 0.024 } } });
      }) as any,
      suggestKeywordsForDomain: (async () => {
        suggestCalls++;
        providerCalls++;
        return { keywords: [], cached: false, fetchedAt: new Date().toISOString() };
      }) as any,
    },
  );
  assert.equal(res.status, 409);
  assert.equal((await res.json()).code, "price_changed");
  assert.equal(suggestCalls, 0);
  assert.equal(providerCalls, 0);
});

test("route: cacheOnly miss returns { keywords: null } with no provider call", async () => {
  const cache = makeFakeCache();
  const labs = makeFakeLabs(rankedFixture.items);
  const s = spies();
  const requestId = crypto.randomUUID();
  const res = await suggestionsPost(
    routeRequest({ domain: "example.com", locationCode: 2840, cacheOnly: true, requestId }),
    null,
    {
      requireWorkspace: (async () => routeWs) as any,
      isFeatureEnabled: (async () => true) as any,
      requireApprovedPrice: (async () => {
        throw new Error("cacheOnly must not quote");
      }) as any,
      suggestKeywordsForDomain: ((w: any, i: any) =>
        suggestKeywordsForDomain(w, i, {
          labs: labs.labs.domain,
          cached: cache.cached,
          upsertMetrics: s.upsertMetrics,
          appendResearch: s.appendResearch,
        })) as any,
    },
  );
  assert.equal(res.status, 200);
  const missBody = (await res.json()) as { keywords: unknown; cached: boolean; fetchedAt: string };
  assert.equal(missBody.keywords, null);
  assert.equal(missBody.cached, true);
  assert.ok(typeof missBody.fetchedAt === "string");
  assert.equal(labs.calls.length, 0);
  assert.equal(res.headers.get("cache-control"), "no-store");
});

test("route: paid fetch is approved before the provider call", async () => {
  const cache = makeFakeCache();
  const labs = makeFakeLabs(rankedFixture.items);
  const s = spies();
  const order: string[] = [];
  const requestId = crypto.randomUUID();
  const res = await suggestionsPost(
    routeRequest({ domain: "example.com", locationCode: 2840, requestId }),
    null,
    {
      requireWorkspace: (async () => routeWs) as any,
      isFeatureEnabled: (async () => true) as any,
      requireApprovedPrice: (async () => {
        order.push("approve");
        return { quote: { totalUsd: 0.024 }, approvedMaxUsd: 0.024, source: "implicit" };
      }) as any,
      suggestKeywordsForDomain: ((w: any, i: any) => {
        order.push("fetch");
        return suggestKeywordsForDomain(w, i, {
          labs: labs.labs.domain,
          cached: cache.cached,
          upsertMetrics: s.upsertMetrics,
          appendResearch: s.appendResearch,
        });
      }) as any,
    },
  );
  assert.equal(res.status, 200);
  assert.deepEqual(order, ["approve", "fetch"]);
  const body = await res.json();
  assert.equal(body.keywords.length, rankedFixture.items.length);
  assert.equal(body.cached, false);
});
