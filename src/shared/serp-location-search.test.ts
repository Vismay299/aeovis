// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/shared/serp-location-search.test.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { rankSerpLocations } from "./serp-location-search.ts";

const locations = [
  { locationName: "South Portland,Maine,United States", locationType: "City" },
  { locationName: "Portland, OR,Oregon,United States", locationType: "DMA Region" },
  { locationName: "Portland,Oregon,United States", locationType: "City" },
  { locationName: "Portland,Maine,United States", locationType: "City" },
  { locationName: "Portland,Texas,United States", locationType: "City" },
  { locationName: "Catonsville,Maryland,United States", locationType: "City" },
  { locationName: "New City,New York,United States", locationType: "City" },
  { locationName: "New York,New York,United States", locationType: "City" },
  { locationName: "La Crosse,Wisconsin,United States", locationType: "City" },
];

describe("rankSerpLocations", () => {
  it("ranks exact first-segment cities above prefixed names and DMA regions", () => {
    const names = rankSerpLocations("Portland", locations).map((location) => location.locationName);
    assert.deepEqual(names.slice(0, 2), ["Portland,Maine,United States", "Portland,Oregon,United States"]);
    assert.ok(names.indexOf("South Portland,Maine,United States") > names.indexOf("Portland, OR,Oregon,United States"));
  });

  it("expands a US state abbreviation so 'Catonsville MD' matches the canonical row", () => {
    assert.deepEqual(rankSerpLocations("Catonsville MD", locations, "us"), [
      { locationName: "Catonsville,Maryland,United States", locationType: "City" },
    ]);
  });

  it("prefers the place whose name is the whole query over first-token matches", () => {
    assert.equal(rankSerpLocations("New York", locations)[0]?.locationName, "New York,New York,United States");
  });

  it("never reads the place name itself as a state abbreviation", () => {
    assert.equal(rankSerpLocations("La Crosse", locations, "us")[0]?.locationName, "La Crosse,Wisconsin,United States");
  });

  it("returns every same-named town across many states", () => {
    const arlingtons = Array.from({ length: 20 }, (_, index) => ({
      locationName: `Arlington,State ${index},United States`,
      locationType: "City",
    }));
    assert.equal(rankSerpLocations("Arlington", arlingtons).length, 20);
  });
});
