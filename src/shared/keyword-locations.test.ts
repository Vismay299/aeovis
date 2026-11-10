import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  LOCATION_OPTIONS,
  formatLocationLabel,
  getIsoCountryCode,
  getKeywordDataProvider,
  getLanguageCode,
  isLabsLocationCode,
  isSupportedLanguageCode,
  isSupportedLocationCode,
  resolveKeywordDataLanguage,
  resolveLabsMarket,
  resolveMarket,
  defaultLocationForHost,
  workspaceMarket,
} from "./keyword-locations.ts";

describe("keyword locations", () => {
  it("routes Google-Ads-only countries to google_ads and unknown codes to labs", () => {
    assert.equal(getKeywordDataProvider(2352), "google_ads"); // Iceland
    assert.equal(isSupportedLocationCode(2352), true);
    assert.equal(isLabsLocationCode(2352), false);
    assert.equal(getLanguageCode(2352), "is");
    // Labs rejects unknown codes upstream.
    assert.equal(getKeywordDataProvider(999999), "labs");
    assert.equal(isSupportedLocationCode(999999), false);
  });

  it("accepts every supported language code and rejects unknown ones", () => {
    // Every per-country default we send is, by construction, a supported code.
    for (const option of LOCATION_OPTIONS) {
      assert.equal(isSupportedLanguageCode(option.languageCode), true);
    }
    assert.equal(isSupportedLanguageCode("en"), true);
    assert.equal(isSupportedLanguageCode("zh-TW"), true);
    // Non-default codes from the master picker list are valid too (e.g. Hindi).
    assert.equal(isSupportedLanguageCode("hi"), true);
    // Malformed/unsupported codes DataForSEO would reject as a charged failure.
    assert.equal(isSupportedLanguageCode("english"), false);
    assert.equal(isSupportedLanguageCode("en-US"), false);
    assert.equal(isSupportedLanguageCode("zh-tw"), false);
  });

  it("keeps the picker sorted alphabetically with unique codes", () => {
    const labels = LOCATION_OPTIONS.map((option) => option.label);
    const sorted = [...labels].sort((a, b) => a.localeCompare(b));
    assert.deepEqual(labels, sorted);
    const codes = LOCATION_OPTIONS.map((option) => option.code);
    assert.equal(new Set(codes).size, codes.length);
  });
});

describe("getIsoCountryCode", () => {
  it("maps the UK display label to its ISO code gb", () => {
    assert.equal(getIsoCountryCode(2826), "gb");
  });
});

describe("formatLocationLabel", () => {
  it("trims uneven spacing around canonical name segments and truncates to maxSegments", () => {
    assert.equal(
      formatLocationLabel("Portland-Auburn, ME,United States"),
      "Portland-Auburn, ME, United States",
    );
    assert.equal(
      formatLocationLabel("Springfield,Illinois,United States", 2),
      "Springfield, Illinois",
    );
  });
});

describe("resolveMarket", () => {
  const vietnamProject = { locationCode: 2704, languageCode: "vi" };

  it("snaps the language to a location override instead of borrowing the project's", () => {
    // A Vietnam project querying Germany must not send Vietnamese.
    assert.deepEqual(resolveMarket({ locationCode: 2276 }, vietnamProject), {
      locationCode: 2276,
      languageCode: "de",
    });
  });

  it("keeps the project language when the override matches the project location", () => {
    const spanishUs = { locationCode: 2840, languageCode: "es" };
    assert.deepEqual(resolveMarket({ locationCode: 2840 }, spanishUs), {
      locationCode: 2840,
      languageCode: "es",
    });
  });
});

describe("resolveLabsMarket", () => {
  it("inherits a Labs-served project market like resolveMarket does", () => {
    assert.deepEqual(
      resolveLabsMarket({}, { locationCode: 2704, languageCode: "vi" }),
      { locationCode: 2704, languageCode: "vi" },
    );
  });

  it("falls back to the US when the project market is Google-Ads-served", () => {
    assert.deepEqual(
      resolveLabsMarket({}, { locationCode: 2352, languageCode: "en" }),
      { locationCode: 2840, languageCode: "en" },
    );
  });

  it("falls back to the US when the project pair is not served", () => {
    assert.deepEqual(
      resolveLabsMarket({}, { locationCode: 2276, languageCode: "vi" }),
      { locationCode: 2840, languageCode: "en" },
    );
  });

  it("leaves an explicit location alone so the caller's assert can reject it", () => {
    const res = resolveLabsMarket(
      { locationCode: 2352 },
      { locationCode: 2704, languageCode: "vi" },
    );
    assert.equal(res.locationCode, 2352);
  });
});

describe("resolveKeywordDataLanguage", () => {
  it("falls back to the country default for a SERP-only pair", () => {
    assert.equal(resolveKeywordDataLanguage(2840, "es"), "es");
    assert.equal(resolveKeywordDataLanguage(2203, "en"), "cs");
    assert.equal(resolveKeywordDataLanguage(2352, "en"), "is");
  });
});

describe("defaultLocationForHost", () => {
  it("maps country code TLDs to expected location codes", () => {
    assert.equal(defaultLocationForHost("offcult.in"), 2356); // India
    assert.equal(defaultLocationForHost("shop.example.co.uk"), 2826); // UK
    assert.equal(defaultLocationForHost("example.uk"), 2826); // UK
    assert.equal(defaultLocationForHost("store.example.com.au"), 2036); // Australia
    assert.equal(defaultLocationForHost("example.au"), 2036); // Australia
    assert.equal(defaultLocationForHost("business.ca"), 2124); // Canada
    assert.equal(defaultLocationForHost("tech.sg"), 2702); // Singapore
    assert.equal(defaultLocationForHost("dubai.ae"), 2784); // UAE
    assert.equal(defaultLocationForHost("example.com"), 2840); // US default
    assert.equal(defaultLocationForHost("unknown.org"), 2840); // default
  });
});

describe("workspaceMarket", () => {
  it("uses default codes when present on brand", () => {
    assert.deepEqual(
      workspaceMarket({
        website_host: "example.in",
        default_location_code: 2840,
        default_language_code: "es",
      }),
      { locationCode: 2840, languageCode: "es" },
    );
  });

  it("derives location from website_host when not specified", () => {
    assert.deepEqual(
      workspaceMarket({
        website_host: "example.in",
      }),
      { locationCode: 2356, languageCode: "en" },
    );
  });
});
