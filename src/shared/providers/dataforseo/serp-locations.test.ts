import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createMemoryCacheStore } from "../../../server/cache/memoryStore.ts";
import { rankSerpLocations } from "../../serp-location-search.ts";
import {
  fetchSerpLocationsForCountry,
  serpLocationsCacheInput,
} from "./serp-locations.ts";

const fixture = JSON.parse(
  readFileSync(new URL("../../../../tests/fixtures/f13/serp-locations-in.json", import.meta.url), "utf8"),
);

function fakeGet() {
  const paths: string[] = [];
  const get = async (path: string) => {
    paths.push(path);
    return structuredClone(fixture);
  };
  return { get: get as any, paths };
}

describe("fetchSerpLocationsForCountry", () => {
  it("keeps only city, county, municipality, DMA region and region rows", async () => {
    const { get, paths } = fakeGet();
    const rows = await fetchSerpLocationsForCountry("IN", {
      dataforseoGet: get,
      cacheDeps: { store: createMemoryCacheStore() },
    });
    assert.deepEqual(paths, ["/v3/serp/google/locations/in"]);
    const types = new Set(rows.map((row) => row.locationType));
    assert.deepEqual([...types].sort(), ["City", "County", "Municipality", "Region"]);
    for (const dropped of ["India", "Maharashtra,India", "400001,Maharashtra,India", "IIT Bombay,Maharashtra,India", "Bandra,Mumbai,Maharashtra,India"]) {
      assert.equal(rows.some((row) => row.locationName === dropped), false, `${dropped} is excluded`);
    }
    const mumbai = rows.find((row) => row.locationName === "Mumbai,Maharashtra,India");
    assert.deepEqual(mumbai, {
      locationCode: 1007785,
      locationName: "Mumbai,Maharashtra,India",
      displayLabel: "Mumbai, Maharashtra, India",
      locationType: "City",
    });
  });

  it("is cached globally for 30 days, so a second lookup makes no provider call", async () => {
    const { get, paths } = fakeGet();
    const store = createMemoryCacheStore();
    const first = await fetchSerpLocationsForCountry("in", { dataforseoGet: get, cacheDeps: { store } });
    const second = await fetchSerpLocationsForCountry("IN", { dataforseoGet: get, cacheDeps: { store } });
    assert.equal(paths.length, 1);
    assert.deepEqual(second, first);

    const input = serpLocationsCacheInput("IN");
    assert.equal(input.scope, "global");
    assert.equal(input.ttlSeconds, 2592000);
    assert.equal(input.namespace, "dataforseo.serp_locations");
    assert.deepEqual(input.keyParts, ["in"]);
  });

  it("ranking 'mumbai' puts Mumbai,Maharashtra,India first", async () => {
    const { get } = fakeGet();
    const rows = await fetchSerpLocationsForCountry("in", {
      dataforseoGet: get,
      cacheDeps: { store: createMemoryCacheStore() },
    });
    const ranked = rankSerpLocations("mumbai", rows, "in");
    assert.equal(ranked[0]?.locationName, "Mumbai,Maharashtra,India");
    assert.ok(ranked.some((row) => row.locationName === "Navi Mumbai,Maharashtra,India"));
  });
});
