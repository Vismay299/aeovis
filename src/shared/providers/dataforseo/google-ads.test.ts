import assert from "node:assert/strict";
import { test } from "node:test";
import {
  isAdsKeyword,
  fetchAdsSearchVolume,
  fetchAdsKeywordIdeas,
  createGoogleAdsClient,
} from "./google-ads.ts";

const dummyEnv = {
  DATAFORSEO_API_KEY: "dummy-key",
};

test("isAdsKeyword validates character limits, word count and forbidden characters", () => {
  // Length limits: 80 chars passes, 81 chars fails
  const eightyChars = "a".repeat(80);
  const eightyOneChars = "a".repeat(81);
  assert.equal(isAdsKeyword(eightyChars), true);
  assert.equal(isAdsKeyword(eightyOneChars), false);

  // Word limits: 10 words passes, 11 words fails
  const tenWords = "one two three four five six seven eight nine ten";
  const elevenWords = "one two three four five six seven eight nine ten eleven";
  assert.equal(isAdsKeyword(tenWords), true);
  assert.equal(isAdsKeyword(elevenWords), false);

  // Forbidden characters: ! @ % , * ( ) { } < > | ^ ~ ; = ? `
  assert.equal(isAdsKeyword("cheap hotel!"), false);
  assert.equal(isAdsKeyword("cheap hotel?"), false);
  assert.equal(isAdsKeyword("cheap (hotel)"), false);
  assert.equal(isAdsKeyword("hotel @ beach"), false);
  assert.equal(isAdsKeyword("50% off hotel"), false);
  assert.equal(isAdsKeyword("hotel, motels"), false);
  assert.equal(isAdsKeyword("hotel * stars"), false);
  assert.equal(isAdsKeyword("hotel {luxury}"), false);
  assert.equal(isAdsKeyword("hotel <pool>"), false);
  assert.equal(isAdsKeyword("hotel | resort"), false);
  assert.equal(isAdsKeyword("hotel ^ top"), false);
  assert.equal(isAdsKeyword("hotel ~ near"), false);
  assert.equal(isAdsKeyword("hotel; booking"), false);
  assert.equal(isAdsKeyword("hotel = best"), false);
  assert.equal(isAdsKeyword("hotel `deal`"), false);

  // Emoji rejected
  assert.equal(isAdsKeyword("hotel 🏨"), false);
  assert.equal(isAdsKeyword("best hotel ✨"), false);

  // Normal keywords pass
  assert.equal(isAdsKeyword("hotel reykjavik"), true);
  assert.equal(isAdsKeyword("best bed and breakfast in iceland"), true);
});

test("fetchAdsSearchVolume uses location_code when locationName is absent", async () => {
  let capturedBody: string | undefined;
  const fetchImpl: typeof fetch = async (_url, init) => {
    capturedBody = init?.body as string;
    return Response.json({
      status_code: 20000,
      tasks: [
        {
          status_code: 20000,
          path: ["v3", "keywords_data", "google_ads", "search_volume", "live"],
          cost: 0.09,
          result: [{ keyword: "hotel reykjavik", search_volume: 1300 }],
        },
      ],
    });
  };

  const res = await fetchAdsSearchVolume(
    {
      keywords: ["hotel reykjavik"],
      locationCode: 2352,
      languageCode: "is",
    },
    { env: dummyEnv, fetchImpl },
  );

  assert.ok(capturedBody);
  const parsed = JSON.parse(capturedBody);
  assert.deepEqual(parsed[0], {
    keywords: ["hotel reykjavik"],
    location_code: 2352,
    language_code: "is",
  });
  assert.equal("location_name" in parsed[0], false);
  assert.equal(res.data.length, 1);
});

test("fetchAdsSearchVolume uses location_name when provided", async () => {
  let capturedBody: string | undefined;
  const fetchImpl: typeof fetch = async (_url, init) => {
    capturedBody = init?.body as string;
    return Response.json({
      status_code: 20000,
      tasks: [
        {
          status_code: 20000,
          path: ["v3", "keywords_data", "google_ads", "search_volume", "live"],
          cost: 0.09,
          result: [{ keyword: "plumber near me", search_volume: 260 }],
        },
      ],
    });
  };

  await fetchAdsSearchVolume(
    {
      keywords: ["plumber near me"],
      locationCode: 2840,
      languageCode: "en",
      locationName: "Springfield,Illinois,United States",
    },
    { env: dummyEnv, fetchImpl },
  );

  assert.ok(capturedBody);
  const parsed = JSON.parse(capturedBody);
  assert.deepEqual(parsed[0], {
    keywords: ["plumber near me"],
    location_name: "Springfield,Illinois,United States",
    language_code: "en",
  });
  assert.equal("location_code" in parsed[0], false);
});

test("fetchAdsKeywordIdeas truncates to limit and sends sort_by: search_volume", async () => {
  let capturedBody: string | undefined;
  const fetchImpl: typeof fetch = async (_url, init) => {
    capturedBody = init?.body as string;
    return Response.json({
      status_code: 20000,
      tasks: [
        {
          status_code: 20000,
          path: ["v3", "keywords_data", "google_ads", "keywords_for_keywords", "live"],
          cost: 0.09,
          result: [
            { keyword: "hotel reykjavik", search_volume: 1300 },
            { keyword: "best hotel reykjavik", search_volume: 800 },
            { keyword: "cheap hotel reykjavik", search_volume: 600 },
          ],
        },
      ],
    });
  };

  const res = await fetchAdsKeywordIdeas(
    {
      keyword: "hotel reykjavik",
      locationCode: 2352,
      languageCode: "is",
      limit: 2,
    },
    { env: dummyEnv, fetchImpl },
  );

  assert.ok(capturedBody);
  const parsed = JSON.parse(capturedBody);
  assert.deepEqual(parsed[0], {
    keywords: ["hotel reykjavik"],
    location_code: 2352,
    language_code: "is",
    sort_by: "search_volume",
  });
  // Truncated from 3 to limit 2
  assert.equal(res.data.length, 2);
  assert.equal(res.data[0].keyword, "hotel reykjavik");
  assert.equal(res.data[1].keyword, "best hotel reykjavik");
});

test("every entry of createGoogleAdsClient is priced (> 0)", () => {
  const pricedEntries: Array<{ estimate: number; defaultFeature: string | null }> = [];
  const spyMeter = (
    _fetcher: unknown,
    estimate: (input: any) => number,
    defaultFeature: string | null,
  ) => {
    const est = estimate({ limit: 1, keywords: ["x"] });
    assert.ok(est > 0, `Expected estimator to return > 0, got ${est}`);
    pricedEntries.push({ estimate: est, defaultFeature });
    return () => Promise.resolve({});
  };

  const client = createGoogleAdsClient({ meter: spyMeter as any });
  assert.ok(client.adsIdeas);
  assert.ok(client.adsSearchVolume);

  assert.equal(pricedEntries.length, 2);
  assert.equal(pricedEntries[0].defaultFeature, "keywords.research");
  assert.equal(pricedEntries[1].defaultFeature, null);
  for (const entry of pricedEntries) {
    assert.ok(entry.estimate > 0);
  }
});
