import assert from "node:assert/strict";
import { test } from "node:test";
import { AppError } from "../http/appError.ts";
import { SpendRefused } from "../spend/errors.ts";
import { listBusinesses, saveBusiness } from "./businesses.ts";
import { startFetch } from "./fetches.ts";
import { lookupBusinessProfile, refreshBusinessProfile, toProfileView } from "./profile.ts";
import { fixtureResult, localKit, makeWs } from "./testKit.ts";

const ws = makeWs();
const REQ = "22222222-2222-4222-8222-222222222222";

function infoItem(): Record<string, unknown> {
  const result = fixtureResult("business-info.json");
  return { ...result.items[0], check_url: result.check_url };
}

test("toProfileView maps the fixture: hours spans, rating distribution, claimed, coordinates", () => {
  const view = toProfileView(infoItem());
  assert.equal(view.title, "Acme Cafe");
  assert.equal(view.category, "Coffee shop");
  assert.deepEqual(view.additionalCategories, ["Bakery", "Espresso bar"]);
  assert.deepEqual(view.rating, { value: 4.6, votes: 210 });
  assert.deepEqual(view.ratingDistribution, { "1": 5, "2": 5, "3": 10, "4": 40, "5": 150 });
  assert.equal(view.isClaimed, true);
  assert.equal(view.cid, "123456789");
  assert.equal(view.placeId, "ChIJ1234567890");
  assert.equal(view.currentStatus, "open");
  assert.equal(view.totalPhotos, 42);
  assert.equal(view.website, "https://example.com");
  assert.equal(view.checkUrl, "https://www.google.com/maps?cid=123456789");
  assert.equal(view.hours?.length, 7);
  assert.deepEqual(view.hours?.[0], { day: "monday", spans: [{ open: "08:00", close: "17:00" }] });
  assert.deepEqual(view.hours?.[4], { day: "friday", spans: [{ open: "08:00", close: "18:00" }] });
  assert.deepEqual(view.hours?.[6], { day: "sunday", spans: [] });
});

test("toProfileView turns an unsafe URL into null and tolerates missing sections", () => {
  const view = toProfileView({ title: "X", url: "javascript:alert(1)", check_url: "data:text/html,hi" });
  assert.equal(view.website, null);
  assert.equal(view.checkUrl, null);
  assert.equal(view.hours, null);
  assert.equal(view.ratingDistribution, null);
  assert.deepEqual(view.additionalCategories, []);
  assert.deepEqual(view.rating, { value: null, votes: null });
});

test("lookup by CID sends the cid: keyword with a metre radius and logs one research entry", async () => {
  const kit = localKit({ myBusinessInfo: () => ({ data: infoItem(), costUsd: 0.0054 }) });
  const out = await lookupBusinessProfile(
    ws,
    { identifier: { cid: "123456789" }, near: { latitude: 19.076, longitude: 72.8777 }, requestId: REQ, maxUsd: 0.01 },
    kit.deps,
  );
  assert.equal(out.profile?.title, "Acme Cafe");
  assert.equal(out.businessId, null);
  const call = kit.harness.calls.myBusinessInfo?.[0];
  assert.equal(call.keyword, "cid:123456789");
  assert.equal(call.locationCoordinate, "19.076,72.8777,10000");
  assert.equal(kit.research.length, 1);
  assert.equal(kit.research[0]?.kind, "local.business");
  assert.equal(kit.research[0]?.researchKey, "profile|123456789");
  assert.equal(kit.research[0]?.summary, "Google Business Profile for Acme Cafe: Coffee shop, 4.6★ from 210 reviews.");
  assert.equal(kit.harness.spend.ledger.length, 1);
  assert.equal(kit.harness.spend.ledger[0]?.feature, "local.business");
});

test("lookup without a coordinate falls back to the workspace market location code", async () => {
  const kit = localKit({ myBusinessInfo: () => ({ data: infoItem() }) });
  await lookupBusinessProfile(ws, { identifier: { businessName: "Acme Cafe" }, requestId: REQ, maxUsd: 0.01 }, kit.deps);
  const call = kit.harness.calls.myBusinessInfo?.[0];
  assert.equal(call.keyword, "Acme Cafe");
  assert.equal(typeof call.locationCode, "number");
  assert.equal(call.locationCoordinate, undefined);
});

test("lookup needs exactly one identifier (400 identifier_required) and spends nothing", async () => {
  const kit = localKit({ myBusinessInfo: () => ({ data: infoItem() }) });
  await assert.rejects(
    lookupBusinessProfile(ws, { identifier: { cid: "1", businessName: "x" }, requestId: REQ }, kit.deps),
    (err: unknown) => err instanceof AppError && err.code === "identifier_required",
  );
  assert.equal(kit.harness.calls.myBusinessInfo, undefined);
});

test("no match is an empty success with its own research summary", async () => {
  const kit = localKit({ myBusinessInfo: () => ({ data: null }) });
  const out = await lookupBusinessProfile(ws, { identifier: { businessName: "Nobody" }, requestId: REQ, maxUsd: 0.01 }, kit.deps);
  assert.deepEqual(out, { profile: null, businessId: null });
  assert.equal(kit.research[0]?.summary, "No Google Business Profile matched Nobody.");
});

test("save as own stores identity and the server-fetched profile", async () => {
  const kit = localKit({ myBusinessInfo: () => ({ data: infoItem() }) });
  const out = await lookupBusinessProfile(
    ws,
    { identifier: { cid: "123456789" }, save: "own", requestId: REQ, maxUsd: 0.01 },
    kit.deps,
  );
  assert.ok(out.businessId);
  const [saved] = await listBusinesses(ws, kit.deps);
  assert.equal(saved?.role, "own");
  assert.equal(saved?.title, "Acme Cafe");
  assert.equal(saved?.placeId, "ChIJ1234567890");
  assert.equal(saved?.profile?.category, "Coffee shop");
  assert.ok(saved?.profileFetchedAt);
});

test("a disabled spend control surfaces as SpendRefused and nothing is saved", async () => {
  const kit = localKit({ myBusinessInfo: () => ({ data: infoItem() }) }, {}, { enabled: false });
  await assert.rejects(
    lookupBusinessProfile(ws, { identifier: { cid: "1" }, save: "own", requestId: REQ, maxUsd: 0.01 }, kit.deps),
    (err: unknown) => err instanceof SpendRefused && err.reason === "feature_disabled",
  );
  assert.equal(kit.store.businesses.size, 0);
  assert.equal(kit.harness.calls.myBusinessInfo, undefined);
});

test("refreshBusinessProfile updates the stored profile and keeps the role", async () => {
  const kit = localKit({ myBusinessInfo: () => ({ data: infoItem() }) });
  const saved = await saveBusiness(ws, { role: "competitor", title: "Acme", cid: "123456789", latitude: 37.7749, longitude: -122.4194 }, kit.deps);
  const profile = await refreshBusinessProfile(ws, saved.id, { requestId: REQ, maxUsd: 0.01 }, kit.deps);
  assert.equal(profile?.title, "Acme Cafe");
  const call = kit.harness.calls.myBusinessInfo?.[0];
  assert.equal(call.keyword, "cid:123456789");
  assert.equal(call.locationCoordinate, "37.7749,-122.4194,10000");
  const [after] = await listBusinesses(ws, kit.deps);
  assert.equal(after?.role, "competitor");
  assert.equal(after?.profile?.title, "Acme Cafe");
});

test("refreshBusinessProfile 404s for a business that is not in the workspace", async () => {
  const kit = localKit({ myBusinessInfo: () => ({ data: infoItem() }) });
  const saved = await saveBusiness(makeWs("other.example"), { role: "own", title: "X", cid: "5" }, kit.deps);
  await assert.rejects(
    refreshBusinessProfile(ws, saved.id, { requestId: REQ }, kit.deps),
    (err: unknown) => err instanceof AppError && err.status === 404 && err.code === "business_not_found",
  );
  assert.equal(kit.harness.calls.myBusinessInfo, undefined);
});

test("refreshBusinessProfile stores the profile's coordinates, so Q&A is no longer blocked", async () => {
  const kit = localKit({
    myBusinessInfo: () => ({ data: infoItem() }),
    questionsAnswers: () => ({ data: [{ question_id: "q1", question_text: "Open late?", items: [] }] }),
  });
  const saved = await saveBusiness(ws, { role: "own", title: "Acme", cid: "123456789" }, kit.deps);
  assert.equal(saved.latitude, null);
  await assert.rejects(
    startFetch(ws, { kind: "questions", businessId: saved.id, depth: 20, maxUsd: 0.01, requestId: REQ }, kit.deps),
    (err: unknown) => err instanceof AppError && err.status === 400 && err.code === "business_location_required",
  );

  await refreshBusinessProfile(ws, saved.id, { requestId: "33333333-3333-4333-8333-333333333333", maxUsd: 0.01 }, kit.deps);
  const [after] = await listBusinesses(ws, kit.deps);
  assert.equal(after?.latitude, 37.7749);
  assert.equal(after?.longitude, -122.4194);
  assert.equal(after?.profile?.title, "Acme Cafe");

  const view = await startFetch(ws, { kind: "questions", businessId: saved.id, depth: 20, maxUsd: 0.01, requestId: "44444444-4444-4444-8444-444444444444" }, kit.deps);
  assert.equal(view.status, "completed");
  assert.equal(kit.harness.calls.questionsAnswers?.[0].locationCoordinate, "37.7749,-122.4194,10000");
});

test("a profile without coordinates keeps the coordinates already stored", async () => {
  const noCoords = { ...infoItem(), latitude: null, longitude: null };
  const kit = localKit({ myBusinessInfo: () => ({ data: noCoords }) });
  const saved = await saveBusiness(ws, { role: "own", title: "Acme", cid: "123456789", latitude: 1.5, longitude: 2.5 }, kit.deps);
  await refreshBusinessProfile(ws, saved.id, { requestId: REQ, maxUsd: 0.01 }, kit.deps);
  const [after] = await listBusinesses(ws, kit.deps);
  assert.equal(after?.latitude, 1.5);
  assert.equal(after?.longitude, 2.5);
});
