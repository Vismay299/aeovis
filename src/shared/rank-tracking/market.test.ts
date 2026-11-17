import test from "node:test";
import assert from "node:assert/strict";
import { normalizeTrackedDomain, resolveTrackerMarket } from "./market.ts";

test("normalizeTrackedDomain strips protocol, www, and path and lowercases", () => {
  assert.equal(normalizeTrackedDomain("https://WWW.Offcult.in/shop?x=1"), "offcult.in");
});

test("normalizeTrackedDomain rejects empty or malformed domains", () => {
  for (const value of ["", "https://", "not a domain", "localhost"]) {
    assert.throws(() => normalizeTrackedDomain(value), (error: unknown) =>
      error instanceof Error && "code" in error && error.code === "invalid_domain",
    );
  }
});

test("resolveTrackerMarket inherits the workspace market and resolves explicit countries", () => {
  assert.deepEqual(resolveTrackerMarket({}, { website_host: "shop.example.in" }), { locationCode: 2356, languageCode: "en" });
  assert.deepEqual(resolveTrackerMarket({ locationCode: 2840 }, { website_host: "shop.example.in" }), { locationCode: 2840, languageCode: "en" });
});

test("resolveTrackerMarket rejects an unsupported country code", () => {
  assert.throws(() => resolveTrackerMarket({ locationCode: 999999 }, { website_host: "example.com" }), (error: unknown) =>
    error instanceof Error && "code" in error && error.code === "invalid_location",
  );
});
