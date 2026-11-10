import assert from "node:assert/strict";
import { test } from "node:test";
import {
  fetchDomainRankOverview,
  fetchKeywordIdeas,
  fetchKeywordOverview,
  fetchKeywordSuggestions,
  fetchRankedKeywords,
  fetchRelatedKeywords,
  fetchRelevantPages,
  fetchSerpCompetitors,
  createLabsClient,
} from "./labs.ts";

const dummyEnv = {
  DATAFORSEO_API_KEY: "dummy-key",
};

test("sends ignoreSynonyms to DataForSEO as ignore_synonyms", async () => {
  let capturedBody: string | undefined;
  const fetchImpl: typeof fetch = async (_url, init) => {
    capturedBody = init?.body as string;
    return Response.json({
      status_code: 20000,
      tasks: [
        {
          status_code: 20000,
          path: ["v3", "dataforseo_labs", "google", "related_keywords", "live"],
          cost: 0.01212,
          result: [{ items: [] }],
        },
      ],
    });
  };

  await fetchRelatedKeywords(
    {
      keyword: "caregiving",
      locationCode: 2840,
      languageCode: "en",
      limit: 150,
      ignoreSynonyms: true,
    },
    { env: dummyEnv, fetchImpl },
  );

  assert.ok(capturedBody, "Expected request body to be captured");
  const parsed = JSON.parse(capturedBody);
  assert.equal(parsed[0].ignore_synonyms, true);
  assert.equal(parsed[0].depth, 3);
  assert.equal(parsed[0].include_serp_info, false);
});

test("fetchRelatedKeywords sends expected request body", async () => {
  let capturedBody: string | undefined;
  const fetchImpl: typeof fetch = async (_url, init) => {
    capturedBody = init?.body as string;
    return Response.json({
      status_code: 20000,
      tasks: [
        {
          status_code: 20000,
          path: ["v3", "dataforseo_labs", "google", "related_keywords", "live"],
          cost: 0.01212,
          result: [{ items: [] }],
        },
      ],
    });
  };

  await fetchRelatedKeywords(
    {
      keyword: "caregiving",
      locationCode: 2840,
      languageCode: "en",
      limit: 150,
      depth: 3,
      includeClickstreamData: false,
      ignoreSynonyms: false,
    },
    { env: dummyEnv, fetchImpl },
  );

  assert.ok(capturedBody);
  const parsed = JSON.parse(capturedBody);
  assert.deepEqual(parsed[0], {
    keyword: "caregiving",
    location_code: 2840,
    language_code: "en",
    limit: 150,
    depth: 3,
    ignore_synonyms: false,
    include_clickstream_data: false,
    include_serp_info: false,
  });
});

test("fetchKeywordSuggestions sends expected request body", async () => {
  let capturedBody: string | undefined;
  const fetchImpl: typeof fetch = async (_url, init) => {
    capturedBody = init?.body as string;
    return Response.json({
      status_code: 20000,
      tasks: [
        {
          status_code: 20000,
          path: ["v3", "dataforseo_labs", "google", "keyword_suggestions", "live"],
          cost: 0.01212,
          result: [{ items: [] }],
        },
      ],
    });
  };

  await fetchKeywordSuggestions(
    {
      keyword: "caregiving",
      locationCode: 2840,
      languageCode: "en",
      limit: 150,
      includeClickstreamData: false,
      ignoreSynonyms: true,
    },
    { env: dummyEnv, fetchImpl },
  );

  assert.ok(capturedBody);
  const parsed = JSON.parse(capturedBody);
  assert.deepEqual(parsed[0], {
    keyword: "caregiving",
    location_code: 2840,
    language_code: "en",
    limit: 150,
    include_clickstream_data: false,
    include_serp_info: false,
    include_seed_keyword: true,
    ignore_synonyms: true,
    exact_match: false,
  });
});

test("fetchKeywordIdeas sends expected request body", async () => {
  let capturedBody: string | undefined;
  const fetchImpl: typeof fetch = async (_url, init) => {
    capturedBody = init?.body as string;
    return Response.json({
      status_code: 20000,
      tasks: [
        {
          status_code: 20000,
          path: ["v3", "dataforseo_labs", "google", "keyword_ideas", "live"],
          cost: 0.01212,
          result: [{ items: [] }],
        },
      ],
    });
  };

  await fetchKeywordIdeas(
    {
      keyword: "caregiving",
      locationCode: 2840,
      languageCode: "en",
      limit: 150,
      includeClickstreamData: false,
      ignoreSynonyms: false,
    },
    { env: dummyEnv, fetchImpl },
  );

  assert.ok(capturedBody);
  const parsed = JSON.parse(capturedBody);
  assert.deepEqual(parsed[0], {
    keywords: ["caregiving"],
    location_code: 2840,
    language_code: "en",
    limit: 150,
    include_clickstream_data: false,
    include_serp_info: false,
    ignore_synonyms: false,
    closely_variants: false,
  });
});

test("fetchKeywordOverview sends expected request body", async () => {
  let capturedBody: string | undefined;
  const fetchImpl: typeof fetch = async (_url, init) => {
    capturedBody = init?.body as string;
    return Response.json({
      status_code: 20000,
      tasks: [
        {
          status_code: 20000,
          path: ["v3", "dataforseo_labs", "google", "keyword_overview", "live"],
          cost: 0.01212,
          result: [{ items: [] }],
        },
      ],
    });
  };

  await fetchKeywordOverview(
    {
      keywords: ["caregiving", "elder care"],
      locationCode: 2840,
      languageCode: "en",
      includeClickstreamData: true,
    },
    { env: dummyEnv, fetchImpl },
  );

  assert.ok(capturedBody);
  const parsed = JSON.parse(capturedBody);
  assert.deepEqual(parsed[0], {
    keywords: ["caregiving", "elder care"],
    location_code: 2840,
    language_code: "en",
    include_clickstream_data: true,
  });
});

test("every entry of createLabsClient is priced (> 0)", () => {
  const pricedEntries: Array<{ estimate: number; defaultFeature: string | null }> = [];
  const spyMeter = (
    _fetcher: unknown,
    estimate: (input: any) => number,
    defaultFeature: string | null,
  ) => {
    const est = estimate({ limit: 1, keywords: ["x"], includeClickstreamData: false });
    assert.ok(est > 0, `Expected estimator to return > 0, got ${est}`);
    pricedEntries.push({ estimate: est, defaultFeature });
    return () => Promise.resolve({});
  };

  const client = createLabsClient({ meter: spyMeter as any });
  // Verify all 8 client endpoints exist
  assert.ok(client.keywords.related);
  assert.ok(client.keywords.suggestions);
  assert.ok(client.keywords.ideas);
  assert.ok(client.labs.keywordOverview);
  assert.ok(client.labs.serpCompetitors);
  assert.ok(client.domain.rankOverview);
  assert.ok(client.domain.rankedKeywords);
  assert.ok(client.domain.relevantPages);

  // 8 endpoints registered through meter
  assert.equal(pricedEntries.length, 8);
  for (const entry of pricedEntries) {
    assert.ok(entry.estimate > 0);
  }
});
