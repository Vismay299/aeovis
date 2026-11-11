// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/mcp/tools/dataforseo-research-tools.ts:284-309, 1001-1048
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import assert from "node:assert/strict";
import { test } from "node:test";
import { SpendRefused } from "../spend/errors.ts";
import { saveBusiness } from "./businesses.ts";
import { getLocalSerpResults } from "./localSerp.ts";
import { localKit, makeWs } from "./testKit.ts";

const ws = makeWs();
const OWN_CID = "1234567890123456789";
const REQ1 = "11111111-cccc-4ccc-8ccc-111111111111";
const REQ2 = "22222222-cccc-4ccc-8ccc-222222222222";
const near = { latitude: 19.076, longitude: 72.8777 };

function mapsItems(): Array<Record<string, unknown>> {
  return Array.from({ length: 20 }, (_, i) => {
    const rank = i + 1;
    const own = rank === 4;
    return {
      type: "maps_search",
      rank_group: rank,
      rank_absolute: rank,
      title: own ? "Offcult Store" : `Business ${rank}`,
      domain: own ? "other-domain.example" : `b${rank}.example`,
      url: rank === 5 ? "javascript:alert(1)" : `https://b${rank}.example`,
      phone: "+91 22 0000 0000",
      address: `${rank} Main Road`,
      category: "Clothing store",
      additional_categories: ["Shoe store"],
      rating: { value: 4.6, votes_count: 1200 + rank },
      price_level: "$$",
      is_claimed: true,
      cid: own ? OWN_CID : String(9000 + rank),
      place_id: `place-${rank}`,
      latitude: 19.07 + rank / 1000,
      longitude: 72.87,
      total_photos: 12,
      image: "https://example.test/skip.png",
      xpath: "/html/body/div",
    };
  });
}

const base = { keyword: "streetwear store", near, searchType: "maps" as const, device: "mobile" as const, depth: 20, maxUsd: 0.01, requestId: REQ1 };

test("defaults: zoom 12 suffix, no places search, rows trimmed, own business flagged by CID", async () => {
  const kit = localKit({ localSerp: () => ({ data: mapsItems(), costUsd: 0.002 }) });
  await saveBusiness(ws, { role: "own", title: "Offcult Store", cid: OWN_CID }, kit.deps);
  const out = await getLocalSerpResults(ws, base, kit.deps);
  const call = kit.harness.calls.localSerp?.[0];
  assert.equal(call.locationCoordinate, "19.076,72.8777,12z");
  assert.equal(call.searchType, "maps");
  assert.equal(call.device, "mobile");
  assert.equal(call.depth, 20);
  assert.equal(call.searchPlaces, false);
  assert.equal(call.keyword, "streetwear store");
  assert.equal(out.results.length, 20);
  assert.equal(out.cached, false);
  const own = out.results.find((r) => r.isOwn);
  assert.equal(own?.rank, 4);
  assert.equal(own?.title, "Offcult Store");
  assert.equal(out.ownRank, 4);
  assert.equal(out.results.filter((r) => r.isOwn).length, 1);
  const first = out.results[0] as unknown as Record<string, unknown>;
  assert.equal(first.image, undefined);
  assert.equal(first.xpath, undefined);
  assert.equal(out.results[0]?.rating, 4.6);
  assert.equal(out.results[0]?.votes, 1201);
  assert.equal(out.results[4]?.url, null, "an unsafe URL becomes null");
  assert.equal(kit.harness.spend.ledger[0]?.feature, "local.serp");
});

test("a cached second call has no spend, even from another workspace, and no new research entry", async () => {
  const kit = localKit({ localSerp: () => ({ data: mapsItems(), costUsd: 0.002 }) });
  const first = await getLocalSerpResults(ws, base, kit.deps);
  const second = await getLocalSerpResults(ws, { ...base, requestId: REQ2 }, kit.deps);
  assert.equal(first.cached, false);
  assert.equal(second.cached, true);
  assert.equal(kit.harness.calls.localSerp?.length, 1);
  assert.equal(kit.harness.spend.ledger.length, 1);
  assert.equal(kit.research.length, 1, "only the miss is logged");
  const other = await getLocalSerpResults(makeWs("other.example"), { ...base, requestId: "33333333-cccc-4ccc-8ccc-333333333333" }, kit.deps);
  assert.equal(other.cached, true);
  assert.equal(kit.harness.calls.localSerp?.length, 1);
  assert.equal(kit.store.searches.length, 3);
  assert.deepEqual(kit.store.searches.map((s) => s.cached), [false, true, true]);
});

test("a different zoom, type, device or depth is a different cache entry", async () => {
  const kit = localKit({ localSerp: () => ({ data: mapsItems(), costUsd: 0.002 }) });
  await getLocalSerpResults(ws, base, kit.deps);
  await getLocalSerpResults(ws, { ...base, near: { ...near, zoom: 14 }, requestId: REQ2 }, kit.deps);
  await getLocalSerpResults(ws, { ...base, searchType: "local_finder", requestId: "33333333-cccc-4ccc-8ccc-333333333333" }, kit.deps);
  assert.equal(kit.harness.calls.localSerp?.length, 3);
  assert.equal(kit.harness.calls.localSerp?.[1].locationCoordinate, "19.076,72.8777,14z");
  assert.equal(kit.harness.calls.localSerp?.[2].searchType, "local_finder");
});

test("own business is matched by place ID, and falls back to the workspace domain", async () => {
  const kit = localKit({ localSerp: () => ({ data: mapsItems() }) });
  await saveBusiness(ws, { role: "own", title: "Offcult", placeId: "place-7" }, kit.deps);
  const byPlace = await getLocalSerpResults(ws, base, kit.deps);
  assert.equal(byPlace.ownRank, 7);

  const kit2 = localKit({
    localSerp: () => ({
      data: [
        { title: "Not us", rank_absolute: 1, domain: "someone.example", cid: "1" },
        { title: "Offcult", rank_absolute: 2, domain: "offcult.example", cid: "2" },
      ],
    }),
  });
  const byDomain = await getLocalSerpResults(ws, base, kit2.deps);
  assert.equal(byDomain.ownRank, 2, "domain equals the workspace host without www.");
  assert.deepEqual(byDomain.results.map((r) => r.isOwn), [false, true]);
});

test("saved competitors are flagged isCompetitor", async () => {
  const kit = localKit({ localSerp: () => ({ data: mapsItems() }) });
  await saveBusiness(ws, { role: "competitor", title: "Business 2", cid: "9002" }, kit.deps);
  const out = await getLocalSerpResults(ws, base, kit.deps);
  assert.deepEqual(out.results.filter((r) => r.isCompetitor).map((r) => r.rank), [2]);
  assert.equal(out.ownRank, null);
});

test("an empty result is not cached and the history row records zero results", async () => {
  const kit = localKit({ localSerp: () => ({ data: [], costUsd: 0.002 }) });
  const out = await getLocalSerpResults(ws, base, kit.deps);
  assert.deepEqual(out.results, []);
  assert.equal(out.ownRank, null);
  await getLocalSerpResults(ws, { ...base, requestId: REQ2 }, kit.deps);
  assert.equal(kit.harness.calls.localSerp?.length, 2);
  assert.equal(kit.store.searches[0]?.resultCount, 0);
});

test("history row stores parameters and counts; research entry carries the summary", async () => {
  const kit = localKit({ localSerp: () => ({ data: mapsItems() }) });
  await saveBusiness(ws, { role: "own", title: "Offcult Store", cid: OWN_CID }, kit.deps);
  await getLocalSerpResults(ws, base, kit.deps);
  const row = kit.store.searches[0];
  assert.equal(row?.kind, "local_serp");
  assert.equal(row?.resultCount, 20);
  assert.equal(row?.ownRank, 4);
  assert.equal(row?.cacheKey.length, 64);
  assert.equal(kit.research[0]?.kind, "local.serp");
  assert.equal(kit.research[0]?.summary, "Local results for “streetwear store” near 19.076,72.8777: 20 businesses; you rank 4.");
});

test("a disabled spend control refuses before any provider call", async () => {
  const kit = localKit({ localSerp: () => ({ data: mapsItems() }) }, {}, { enabled: false });
  await assert.rejects(getLocalSerpResults(ws, base, kit.deps), (err: unknown) => err instanceof SpendRefused && err.reason === "feature_disabled");
  assert.equal(kit.harness.calls.localSerp, undefined);
});
