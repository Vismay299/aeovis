import test from "node:test";
import assert from "node:assert/strict";
import { GET } from "../../app/api/customer/keywords/locations/route.ts";

const workspace = { user: { id: "u1" }, brandKey: "acme", brand: { brandKey: "acme" }, role: "member", admin: {} };
const rows = [
  { locationCode: 9062154, locationName: "Navi Mumbai,Maharashtra,India", displayLabel: "Navi Mumbai, Maharashtra, India", locationType: "City" },
  { locationCode: 1007785, locationName: "Mumbai,Maharashtra,India", displayLabel: "Mumbai, Maharashtra, India", locationType: "City" },
  { locationCode: 1007788, locationName: "Pune,Maharashtra,India", displayLabel: "Pune, Maharashtra, India", locationType: "City" },
];

function req(query) {
  return new Request(`http://localhost/api/customer/keywords/locations?${new URLSearchParams(query)}`);
}

function deps(overrides = {}) {
  const fetched = [];
  return {
    fetched,
    requireWorkspace: async () => workspace,
    isFeatureEnabled: async (name) => name === "keyword_research",
    fetchSerpLocationsForCountry: async (iso) => { fetched.push(iso); return rows; },
    ...overrides,
  };
}

test("locations route", async (t) => {
  await t.test("ranks the country's registry and returns the public fields", async () => {
    const d = deps();
    const res = await GET(req({ brand_key: "acme", country: "IN", q: "mum" }), null, d);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "no-store");
    const body = await res.json();
    assert.deepEqual(d.fetched, ["in"]);
    assert.deepEqual(body.locations.map((l) => l.locationName), ["Mumbai,Maharashtra,India", "Navi Mumbai,Maharashtra,India"]);
    assert.deepEqual(Object.keys(body.locations[0]).sort(), ["displayLabel", "locationName", "locationType"]);
  });

  await t.test("caps the list at 20", async () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ locationCode: i, locationName: `Springfield,State ${i},United States`, displayLabel: "x", locationType: "City" }));
    const res = await GET(req({ brand_key: "acme", country: "us", q: "springfield" }), null, deps({ fetchSerpLocationsForCountry: async () => many }));
    assert.equal((await res.json()).locations.length, 20);
  });

  await t.test("local_seo alone admits the route", async () => {
    const res = await GET(req({ brand_key: "acme", country: "us", q: "a" }), null, deps({ isFeatureEnabled: async (name) => name === "local_seo" }));
    assert.equal(res.status, 200);
  });

  await t.test("404 feature_unavailable when no gating flag is on", async () => {
    const res = await GET(req({ brand_key: "acme", country: "us", q: "a" }), null, deps({ isFeatureEnabled: async () => false }));
    assert.equal(res.status, 404);
    assert.equal((await res.json()).code, "feature_unavailable");
  });

  await t.test("400 invalid_request for a bad country or empty query", async () => {
    for (const query of [{ brand_key: "acme", country: "usa", q: "a" }, { brand_key: "acme", country: "us", q: "" }, { country: "us", q: "a" }]) {
      const res = await GET(req(query), null, deps());
      assert.equal(res.status, 400, JSON.stringify(query));
      assert.equal((await res.json()).code, "invalid_request");
    }
  });

  await t.test("503 locations_unavailable when the registry cannot be loaded", async () => {
    const res = await GET(req({ brand_key: "acme", country: "us", q: "a" }), null, deps({ fetchSerpLocationsForCountry: async () => { throw new Error("down"); } }));
    assert.equal(res.status, 503);
    const body = await res.json();
    assert.equal(body.code, "locations_unavailable");
    assert.equal(body.error, "Locations could not be loaded. Please retry.");
  });
});
