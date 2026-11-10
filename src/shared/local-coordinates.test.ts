import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { googleMapsPointUrl, parseMapsLocation } from "./local-coordinates.ts";

describe("shared/local-coordinates", () => {
  it("parses Google Maps URL with @lat,lng,<z>z", () => {
    const parsed = parseMapsLocation("https://www.google.com/maps/@19.0760,72.8777,14z");
    assert.deepEqual(parsed, {
      latitude: 19.076,
      longitude: 72.8777,
      zoom: 14,
    });
  });

  it("clamps zoom to 4..18", () => {
    const low = parseMapsLocation("https://www.google.com/maps/@19.0760,72.8777,2z");
    assert.equal(low?.zoom, 4);

    const high = parseMapsLocation("https://www.google.com/maps/@19.0760,72.8777,22z");
    assert.equal(high?.zoom, 18);
  });

  it("parses place URL with !3d<lat>!4d<lng> returning zoom null", () => {
    const parsed = parseMapsLocation(
      "https://www.google.com/maps/place/Acme+Cafe/@19.0760,72.8777,15z/data=!4m6!3m5!1s0x0:0x0!8m2!3d19.07!4d72.87",
    );
    // Notice: if both @ and !3d exist, @ match matches first or !3d.
    // If testing place URL without @:
    const placeOnly = parseMapsLocation(
      "https://www.google.com/maps/place/Acme+Cafe/data=!4m6!3m5!1s0x0:0x0!8m2!3d19.07!4d72.87",
    );
    assert.deepEqual(placeOnly, {
      latitude: 19.07,
      longitude: 72.87,
      zoom: null,
    });
  });

  it("parses plain 'lat, lng' and 'lat lng' strings", () => {
    const comma = parseMapsLocation("19.0760, 72.8777");
    assert.deepEqual(comma, {
      latitude: 19.076,
      longitude: 72.8777,
      zoom: null,
    });

    const space = parseMapsLocation("19.0760 72.8777");
    assert.deepEqual(space, {
      latitude: 19.076,
      longitude: 72.8777,
      zoom: null,
    });
  });

  it("rejects out-of-range values", () => {
    assert.equal(parseMapsLocation("91,0"), null);
    assert.equal(parseMapsLocation("-91,0"), null);
    assert.equal(parseMapsLocation("0,181"), null);
    assert.equal(parseMapsLocation("0,-181"), null);
    assert.equal(parseMapsLocation("https://www.google.com/maps/@91,0,14z"), null);
  });

  it("rejects short links like maps.app.goo.gl without network calls", () => {
    assert.equal(parseMapsLocation("https://maps.app.goo.gl/abc"), null);
    assert.equal(parseMapsLocation("https://goo.gl/maps/xyz"), null);
  });

  it("rejects arbitrary text, empty string, or invalid coordinates", () => {
    assert.equal(parseMapsLocation(""), null);
    assert.equal(parseMapsLocation("    "), null);
    assert.equal(parseMapsLocation("hello world"), null);
    assert.equal(parseMapsLocation("123 Main St, Springfield"), null);
  });

  it("verifies the module has no fetch reference in source text", () => {
    const source = readFileSync(join(process.cwd(), "src", "shared", "local-coordinates.ts"), "utf8");
    assert.equal(source.includes("fetch"), false, "Module must not reference fetch");
  });

  it("builds googleMapsPointUrl with and without keyword", () => {
    const withKeyword = googleMapsPointUrl(19.076, 72.8777, 14, "coffee shop");
    assert.equal(
      withKeyword,
      "https://www.google.com/maps/search/coffee%20shop/@19.076,72.8777,14z",
    );

    const withoutKeyword = googleMapsPointUrl(19.076, 72.8777, 14);
    assert.equal(
      withoutKeyword,
      "https://www.google.com/maps/@19.076,72.8777,14z",
    );
  });
});
