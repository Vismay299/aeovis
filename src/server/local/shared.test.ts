// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/mcp/tools/local-seo-tools.test.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AppError } from "../../shared/http/appError.ts";
import {
  BUSINESS_DATA_DEFAULT_RADIUS_KM,
  BUSINESS_DATA_MAX_RADIUS_M,
  BUSINESS_DATA_MIN_RADIUS_M,
  DEFAULT_LOCAL_SERP_ZOOM,
  businessIdentifierKeyword,
  businessIdentifierSchema,
  formatBusinessDataCoordinate,
  formatBusinessListingsCoordinate,
  formatCoordinate,
  formatLocalSerpCoordinate,
  listingsNearSchema,
  localSerpNearSchema,
  nearSchema,
  pickRowFields,
  readPath,
  resolveBusinessIdentifier,
} from "./shared.ts";

describe("local/shared helpers", () => {
  it("rejects anything other than exactly one business identifier (400 identifier_required)", () => {
    assert.throws(
      () => resolveBusinessIdentifier({ businessName: "Acme Cafe", cid: "123" }),
      (err: unknown) => {
        assert.ok(err instanceof AppError);
        assert.equal(err.status, 400);
        assert.equal(err.code, "identifier_required");
        assert.equal(err.message, "Provide exactly one business identifier: name, CID or place ID.");
        return true;
      },
    );

    assert.throws(
      () => resolveBusinessIdentifier({}),
      (err: unknown) => {
        assert.ok(err instanceof AppError);
        assert.equal(err.status, 400);
        assert.equal(err.code, "identifier_required");
        return true;
      },
    );

    assert.throws(
      () => resolveBusinessIdentifier({ businessName: "Acme", cid: "123", placeId: "p1" }),
      (err: unknown) => {
        assert.ok(err instanceof AppError);
        assert.equal(err.status, 400);
        assert.equal(err.code, "identifier_required");
        return true;
      },
    );

    const nameResolved = resolveBusinessIdentifier({ businessName: "Acme Cafe" });
    assert.deepEqual(nameResolved, { keyword: "Acme Cafe", cid: undefined, placeId: undefined });

    const cidResolved = resolveBusinessIdentifier({ cid: "123456" });
    assert.deepEqual(cidResolved, { keyword: undefined, cid: "123456", placeId: undefined });

    const placeResolved = resolveBusinessIdentifier({ placeId: "ChIJ123" });
    assert.deepEqual(placeResolved, { keyword: undefined, cid: undefined, placeId: "ChIJ123" });
  });

  it("formats business identifier keyword as cid: / place_id: or raw name", () => {
    assert.equal(businessIdentifierKeyword({ cid: "123456789" }), "cid:123456789");
    assert.equal(businessIdentifierKeyword({ placeId: "place_abc" }), "place_id:place_abc");
    assert.equal(businessIdentifierKeyword({ keyword: "Acme Cafe" }), "Acme Cafe");
  });

  it("formats coordinates dropping trailing zeros and limiting to 7 decimal places", () => {
    assert.equal(formatCoordinate(33.123456789), "33.1234568");
    assert.equal(formatCoordinate(40.0), "40");
    assert.equal(formatCoordinate(-74.0000000), "-74");
    assert.equal(formatCoordinate(-84.987654321), "-84.9876543");
  });

  it("formats business_data coordinates with radius in metres clamped to 200..199999", () => {
    // 5 km -> 5000 m
    assert.equal(
      formatBusinessDataCoordinate({ latitude: 33.123456789, longitude: -84.987654321, radiusKm: 5 }),
      "33.1234568,-84.9876543,5000",
    );
    // default 10 km -> 10000 m
    assert.equal(
      formatBusinessDataCoordinate({ latitude: 40.0, longitude: -74.0 }),
      "40,-74,10000",
    );
    // clamp min 200 m (0.1 km -> 200)
    assert.equal(
      formatBusinessDataCoordinate({ latitude: 40.0, longitude: -74.0, radiusKm: 0.1 }),
      "40,-74,200",
    );
    // clamp max 199999 m (300 km -> 199999)
    assert.equal(
      formatBusinessDataCoordinate({ latitude: 40.0, longitude: -74.0, radiusKm: 300 }),
      "40,-74,199999",
    );
  });

  it("formats business listings coordinates with radius in whole kilometres rounded", () => {
    assert.equal(
      formatBusinessListingsCoordinate({ latitude: 33.123456789, longitude: -84.987654321, radiusKm: 2.6 }),
      "33.1234568,-84.9876543,3",
    );
    assert.equal(
      formatBusinessListingsCoordinate({ latitude: 40.0, longitude: -74.0, radiusKm: 1.2 }),
      "40,-74,1",
    );
    assert.equal(
      formatBusinessListingsCoordinate({ latitude: 40.0, longitude: -74.0, radiusKm: 0.2 }),
      "40,-74,1",
    );
  });

  it("formats local SERP coordinates with optional zoom suffix", () => {
    assert.equal(
      formatLocalSerpCoordinate({ latitude: 40.0, longitude: -74.0 }),
      "40,-74",
    );
    assert.equal(
      formatLocalSerpCoordinate({ latitude: 40.0180874, longitude: -74.0234532, zoom: 13 }),
      "40.0180874,-74.0234532,13z",
    );
  });

  it("validates schemas for near, listingsNear, localSerpNear, and businessIdentifier", () => {
    assert.equal(nearSchema.safeParse({ latitude: 40, longitude: -74, radiusKm: 10 }).success, true);
    assert.equal(nearSchema.safeParse({ latitude: 91, longitude: -74 }).success, false);

    assert.equal(listingsNearSchema.safeParse({ latitude: 40, longitude: -74, radiusKm: 5 }).success, true);
    assert.equal(listingsNearSchema.safeParse({ latitude: 40, longitude: -74, radiusKm: 0.5 }).success, false);

    assert.equal(localSerpNearSchema.safeParse({ latitude: 40, longitude: -74, zoom: 12 }).success, true);
    assert.equal(localSerpNearSchema.safeParse({ latitude: 40, longitude: -74, zoom: 20 }).success, false);

    assert.equal(businessIdentifierSchema.safeParse({ cid: "123456789" }).success, true);
    assert.equal(businessIdentifierSchema.safeParse({ cid: "not-digits" }).success, false);
  });

  it("reads nested paths safely and picks row fields", () => {
    const obj = { a: { b: { c: "hello" } }, x: 42 };
    assert.equal(readPath(obj, "a", "b", "c"), "hello");
    assert.equal(readPath(obj, "a", "b", "missing"), undefined);
    assert.equal(readPath(obj, "nonexistent", "deep"), undefined);
    assert.equal(readPath(null, "foo"), undefined);

    const picked = pickRowFields(obj, ["x", "missing"]);
    assert.deepEqual(picked, { x: 42 });
  });
});
