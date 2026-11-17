// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/features/rank-tracking/services/RankTrackingService.test.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.
import test from "node:test";
import assert from "node:assert/strict";
import { createConfig, updateConfig, addKeywords } from "./service.ts";
import { createMemoryRankTrackingRepository } from "./memoryRepository.ts";
import { AppError } from "../http/appError.ts";

function ws(repo: any, brandKey = "brand-a") {
  const admin: any = {
    from: () => ({
      select: () => ({ eq: () => ({ eq: () => ({ in: async () => ({ data: [], error: null }) }) }) }),
    }),
  };
  return { brandKey, userId: "user-1", admin, website_host: "example.com" };
}

function noLocation() {
  return async () => [{ locationName: "Mumbai", locationCode: 10293, locationType: "City", displayLabel: "Mumbai" }];
}

test("create normalises domain and rejects invalid", async () => {
  const repo = createMemoryRankTrackingRepository();
  const w = ws(repo);
  const out = await createConfig(w as any, { domain: "https://WWW.Offcult.in/shop?x=1", locationCode: 2840, languageCode: "en" }, { repo, fetchSerpLocationsForCountry: async () => [] } as any);
  assert.equal(out.tracker.domain, "offcult.in");
  await assert.rejects(() => createConfig(w as any, { domain: "not a domain!!!" } as any, { repo } as any), (e: any) => e instanceof AppError && e.code === "invalid_domain");
  await assert.rejects(() => createConfig(w as any, { domain: "" } as any, { repo } as any), (e: any) => e instanceof AppError && e.code === "invalid_domain");
});

test("duplicate active tracker is 409 tracker_exists", async () => {
  const repo = createMemoryRankTrackingRepository();
  const w = ws(repo);
  await createConfig(w as any, { domain: "example.com", locationCode: 2840, languageCode: "en" }, { repo, fetchSerpLocationsForCountry: async () => [] } as any);
  await assert.rejects(() => createConfig(w as any, { domain: "example.com", locationCode: 2840, languageCode: "en" }, { repo, fetchSerpLocationsForCountry: async () => [] } as any), (e: any) => e.code === "tracker_exists");
});

test("language/location coexist, archived reactivation keeps history", async () => {
  const repo = createMemoryRankTrackingRepository();
  const w = ws(repo);
  const a = await createConfig(w as any, { domain: "example.com", locationCode: 2840, languageCode: "en" }, { repo, fetchSerpLocationsForCountry: async () => [] } as any);
  const b = await createConfig(w as any, { domain: "example.com", locationCode: 2840, languageCode: "de" }, { repo, fetchSerpLocationsForCountry: async () => [] } as any);
  assert.notEqual(a.tracker.id, b.tracker.id);
  await repo.updateConfig("brand-a", a.tracker.id, { is_active: false } as any);
  const re = await createConfig(w as any, { domain: "example.com", locationCode: 2840, languageCode: "en" }, { repo, fetchSerpLocationsForCountry: async () => [] } as any);
  assert.equal(re.tracker.id, a.tracker.id);
});

test("cap at 500 is enforced", async () => {
  const repo = createMemoryRankTrackingRepository();
  const w = ws(repo);
  for (let i = 0; i < 500; i++) {
    await repo.insertConfig({ brand_key: "brand-a", domain: `d${i}.com`, location_code: 2840, language_code: "en", location_name: null, devices: "mobile", serp_depth: 40, schedule_interval: "weekly", is_active: true, next_check_at: null, created_by: null } as any);
  }
  await assert.rejects(() => createConfig(w as any, { domain: "new.com", locationCode: 2840 }, { repo, fetchSerpLocationsForCountry: async () => [] } as any), (e: any) => e.code === "tracker_limit");
});

test("unknown city is 409 unknown_location before duplicate check and before spend", async () => {
  const repo = createMemoryRankTrackingRepository();
  const w = ws(repo);
  let spent = 0;
  const fakeFetch = async () => {
    spent++;
    return [];
  };
  await assert.rejects(() => createConfig(w as any, { domain: "example.com", locationCode: 2840, languageCode: "en", locationName: "Nowhereville" }, { repo, fetchSerpLocationsForCountry: fakeFetch } as any), (e: any) => e.code === "unknown_location");
  assert.equal(spent, 1);
  assert.equal(await repo.countActiveConfigs("brand-a"), 0);
});

test("weekly time without weekday is 400, manual with time is 400", async () => {
  const repo = createMemoryRankTrackingRepository();
  const w = ws(repo);
  await assert.rejects(() => createConfig(w as any, { domain: "example.com", locationCode: 2840, scheduleInterval: "weekly", scheduleTime: { hour: 4, minute: 0 } }, { repo, fetchSerpLocationsForCountry: async () => [] } as any), (e: any) => e.code === "schedule_weekday_required");
  await assert.rejects(() => createConfig(w as any, { domain: "example.com", locationCode: 2840, scheduleInterval: "manual", scheduleTime: { hour: 4, minute: 0 } }, { repo, fetchSerpLocationsForCountry: async () => [] } as any), (e: any) => e.code === "schedule_time_without_schedule");
});

test("addKeywords lowercases, dedupes, caps, cache prefill, approval required/changed/stored", async () => {
  const repo = createMemoryRankTrackingRepository();
  const fakeAdmin: any = {
    from: (table: string) => {
      if (table === "keyword_metrics") {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                in: async () => ({
                  data: [{ keyword: "hello", search_volume: 100, keyword_difficulty: 10, cpc: 0.5, fetched_at: new Date().toISOString() }],
                  error: null,
                }),
              }),
            }),
          }),
        };
      }
      return { select: () => ({ eq: () => ({ eq: () => ({ in: async () => ({ data: [], error: null }) }) }) }) };
    },
  };
  const w = { brandKey: "brand-a", userId: "user-1", admin: fakeAdmin };
  const cfg = await createConfig(w as any, { domain: "example.com", locationCode: 2840, scheduleInterval: "manual" }, { repo, fetchSerpLocationsForCountry: async () => [] } as any);
  const out = await addKeywords(w as any, cfg.tracker.id, { keywords: ["Hello", "hello", "WORLD"], matchCase: false }, { repo } as any);
  assert.equal(out.added, 2);
  assert.equal(out.skipped, 1);
  assert.equal(out.metricsFromCache, 1);

  // match-case preserves case
  const cfg2 = await createConfig({ brandKey: "brand-b", userId: "u", admin: fakeAdmin } as any, { domain: "example.com", locationCode: 2840, scheduleInterval: "manual" }, { repo, fetchSerpLocationsForCountry: async () => [] } as any);
  const out2 = await addKeywords({ brandKey: "brand-b", userId: "u", admin: fakeAdmin } as any, cfg2.tracker.id, { keywords: ["Hello"], matchCase: true }, { repo } as any);
  assert.equal(out2.added, 1);

  // scheduled approval required before insert
  const cfg3 = await createConfig({ brandKey: "brand-c", userId: "u", admin: fakeAdmin } as any, { domain: "example.com", locationCode: 2840, scheduleInterval: "weekly" }, { repo, fetchSerpLocationsForCountry: async () => [] } as any);
  let inserted = false;
  const countingRepo = { ...repo, addKeywords: async (b: any, c: any, rows: any) => { inserted = true; return repo.addKeywords(b, c, rows); } };
  const fakeQuote = async () => ({ totalUsd: 1.5, checkUsd: 0.5, retryUsd: 1.0, pairs: 2 });
  await assert.rejects(() => addKeywords({ brandKey: "brand-c", userId: "u", admin: fakeAdmin } as any, cfg3.tracker.id, { keywords: ["kw1"] }, { repo: countingRepo as any, quote: fakeQuote as any } as any), (e: any) => e.code === "approval_required");
  assert.equal(inserted, false);
  // price_changed when maxUsd too low
  const fakeRequire = async () => { throw new AppError(409, "price_changed", "changed", { details: { quote: { totalUsd: 1.5 } } }); };
  await assert.rejects(() => addKeywords({ brandKey: "brand-c", userId: "u", admin: fakeAdmin } as any, cfg3.tracker.id, { keywords: ["kw1"], maxUsd: 0.1 }, { repo: countingRepo as any, quote: fakeQuote as any, requireApprovedPrice: fakeRequire as any } as any), (e: any) => e.code === "price_changed");
  assert.equal(inserted, false);
  // adequate maxUsd stores approval
  const okRequire = async () => ({ quote: { totalUsd: 1.5 }, approvedMaxUsd: 2, source: "dialog" as const });
  let recorded = 0;
  const okRecord = async () => { recorded++; return "appr-1"; };
  const out3 = await addKeywords({ brandKey: "brand-c", userId: "u", admin: fakeAdmin } as any, cfg3.tracker.id, { keywords: ["kw1"], maxUsd: 2 }, { repo: countingRepo as any, quote: fakeQuote as any, requireApprovedPrice: okRequire as any, recordApproval: okRecord as any } as any);
  assert.equal(out3.added, 1);
  assert.equal(recorded, 1);
  assert.equal(out3.approval.approvedMaxUsd, 2);
});
