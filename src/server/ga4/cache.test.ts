import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { encryptToken } from "../gsc/oauthCrypto.js";
import { runReport } from "./reporting.ts";
import { getMeasurementHealth } from "./measurementHealth.ts";
import { fakeGa4Admin } from "./fakeAdmin.testkit.ts";
import { createMemoryCacheStore } from "../cache/memoryStore.ts";

process.env.GSC_TOKEN_ENCRYPTION_KEY ??= "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

const fixture = (name: string) =>
  JSON.parse(readFileSync(new URL(`../../../tests/fixtures/f20/${name}`, import.meta.url), "utf8"));

const OWNER = "11111111-1111-4111-8111-111111111111";
const GRANT = "33333333-3333-4333-8333-333333333333";
const NOW = Date.parse("2026-08-06T15:00:00.000Z");

function baseAdmin(updatedAt = "2026-08-01T00:00:00.000Z") {
  return fakeGa4Admin({
    ga4_grants: [
      {
        id: GRANT,
        user_id: OWNER,
        google_sub: "google-sub-a",
        google_email: "owner@example.com",
        status: "active",
        created_at: "2026-08-01T00:00:00.000Z",
        updated_at: "2026-08-01T00:00:00.000Z",
        access_token_expires_at: new Date(NOW + 3_600_000).toISOString(),
        encrypted_access_token: JSON.stringify(encryptToken("ga4_tok", `ga4:${OWNER}:google-sub-a:access`)),
        encrypted_refresh_token: null,
      },
    ],
    ga4_connections: [
      {
        id: "conn-1",
        brand_key: "acme",
        grant_id: GRANT,
        connected_by: OWNER,
        google_sub: "google-sub-a",
        connected_account_email: "owner@example.com",
        property_id: "properties/22",
        property_display_name: "Site B",
        property_time_zone: "Asia/Kolkata",
        property_currency_code: "INR",
        account_display_name: "Client",
        created_at: "2026-08-01T00:00:00.000Z",
        updated_at: updatedAt,
      },
    ],
    customer_brand_memberships: [{ brand_key: "acme", user_id: OWNER, role: "owner" }],
  });
}

const ws = { brandKey: "acme", user: { id: OWNER, email: "owner@example.com" }, role: "owner" as const };

function scriptedData(payloads: unknown[]) {
  let calls = 0;
  const queue = [...payloads];
  const fetchImpl = (async () => {
    calls += 1;
    const next = queue.shift();
    if (next instanceof Error) throw next;
    return Response.json(next);
  }) as typeof fetch;
  return { fetchImpl, calls: () => calls };
}

function cacheDeps(store: ReturnType<typeof createMemoryCacheStore>) {
  const held: Array<Promise<unknown>> = [];
  return {
    store,
    now: () => NOW,
    keepAlive: ((work: unknown) => {
      held.push(Promise.resolve(work));
      return Promise.resolve();
    }) as never,
    held,
  };
}

describe("GA4 report caching", () => {
  it("caches a report hit with the same dataAsOf and no second Google call", async () => {
    const store = createMemoryCacheStore();
    const deps = cacheDeps(store);
    const first = scriptedData([fixture("run-report-landing-pages.json")]);
    const one = await runReport(baseAdmin(), ws, { kind: "landing_pages", limit: 1, offset: 1 }, { ...deps, fetchImpl: first.fetchImpl });
    await Promise.all(deps.held.splice(0));
    assert.equal(one.cached, false);
    assert.equal(first.calls(), 1);

    const second = scriptedData([fixture("run-report-landing-pages.json")]);
    const two = await runReport(baseAdmin(), ws, { kind: "landing_pages", limit: 1, offset: 1 }, { ...deps, store, fetchImpl: second.fetchImpl, now: () => NOW });
    assert.equal(two.cached, true);
    assert.equal(two.dataAsOf, one.dataAsOf);
    assert.equal(second.calls(), 0);
  });

  it("changes the key when the property connection changes", async () => {
    const store = createMemoryCacheStore();
    const deps = cacheDeps(store);
    const first = scriptedData([fixture("run-report-landing-pages.json")]);
    await runReport(baseAdmin("2026-08-01T00:00:00.000Z"), ws, { kind: "landing_pages" }, { ...deps, fetchImpl: first.fetchImpl });
    await Promise.all(deps.held.splice(0));
    assert.equal(first.calls(), 1);

    const second = scriptedData([fixture("run-report-landing-pages.json")]);
    const result = await runReport(baseAdmin("2026-08-02T00:00:00.000Z"), ws, { kind: "landing_pages" }, { ...deps, store, fetchImpl: second.fetchImpl, now: () => NOW });
    assert.equal(result.cached, false);
    assert.equal(second.calls(), 1);
  });

  it("does not cache thrown fetchers", async () => {
    const store = createMemoryCacheStore();
    const deps = cacheDeps(store);
    const failing = scriptedData([new Error("boom")]);
    await assert.rejects(runReport(baseAdmin(), ws, { kind: "landing_pages" }, { ...deps, fetchImpl: failing.fetchImpl }));
    assert.equal(store.rows.size, 0);
    const succeeding = scriptedData([fixture("run-report-landing-pages.json")]);
    const result = await runReport(baseAdmin(), ws, { kind: "landing_pages" }, { ...deps, store, fetchImpl: succeeding.fetchImpl, now: () => NOW });
    assert.equal(result.cached, false);
    assert.equal(succeeding.calls(), 1);
  });

  it("caches measurement health separately from reports", async () => {
    const store = createMemoryCacheStore();
    const deps = cacheDeps(store);
    let calls = 0;
    const fetchImpl = (async (input: RequestInfo | URL) => {
      calls += 1;
      const url = String(input);
      if (url.includes("dataStreams")) return Response.json(fixture("data-streams.json"));
      if (url.includes("enhancedMeasurementSettings")) return Response.json(fixture("enhanced-measurement.json"));
      if (url.includes("keyEvents")) return Response.json(fixture("key-events.json"));
      if (url.includes("customDimensions")) return Response.json(fixture("custom-dimensions.json"));
      if (url.includes("customMetrics")) return Response.json(fixture("custom-metrics.json"));
      throw new Error(`unexpected ${url}`);
    }) as typeof fetch;
    const one = await getMeasurementHealth(baseAdmin(), ws, { ...deps, fetchImpl });
    await Promise.all(deps.held.splice(0));
    assert.equal(one.cached, false);
    const before = calls;
    const two = await getMeasurementHealth(baseAdmin(), ws, { ...deps, store, fetchImpl, now: () => NOW });
    assert.equal(two.cached, true);
    assert.equal(two.dataAsOf, one.dataAsOf);
    assert.equal(calls, before);
  });
});
