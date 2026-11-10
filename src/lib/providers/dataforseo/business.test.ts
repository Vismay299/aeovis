// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/lib/dataforseo/business.test.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createBusinessClient,
  fetchBusinessDataTaskResult,
  fetchBusinessListingsCategories,
  fetchBusinessListingsSearch,
  fetchMyBusinessInfo,
  fetchQuestionsAnswers,
  postGoogleReviewsTask,
  postMyBusinessUpdatesTask,
} from "./business.ts";
import { AmbiguousCallError } from "../../spend/errors.ts";
import type { DataforseoRequestOptions } from "./core.ts";

function stubDataforseo(payload: unknown): {
  calls: Array<{ url: string; init?: RequestInit }>;
  options: DataforseoRequestOptions;
} {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
    calls.push({ url, init });
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  return {
    calls,
    options: {
      fetchImpl,
      env: { DATAFORSEO_API_KEY: "test-api-key" },
    },
  };
}

function requestOf(stub: ReturnType<typeof stubDataforseo>) {
  const [call] = stub.calls;
  assert.ok(call, "Expected at least one fetch call");
  const body = call.init?.body;
  return {
    url: call.url,
    body: typeof body === "string" ? (JSON.parse(body) as unknown) : null,
  };
}

const okTask = (path: string[], result: unknown[], cost = 0.002) => ({
  status_code: 20000,
  tasks: [{ status_code: 20000, path, cost, result }],
});

describe("Google business_data fetchers", () => {
  it("sends a coordinate for my_business_info and returns the single item", async () => {
    const stub = stubDataforseo(
      okTask(
        ["v3", "business_data", "google", "my_business_info", "live"],
        [{ items: [{ title: "Acme Cafe", is_claimed: true }], check_url: "https://maps.google.com/?cid=123" }],
      ),
    );

    const result = await fetchMyBusinessInfo(
      {
        keyword: "cid:123",
        locationCoordinate: "33.1234568,-84.9876543,5000",
        locationCode: 2840,
        languageCode: "en",
      },
      stub.options,
    );

    const { url, body } = requestOf(stub);
    assert.equal(
      url,
      "https://api.dataforseo.com/v3/business_data/google/my_business_info/live",
    );
    // The coordinate wins: DataForSEO rejects a request carrying both.
    assert.deepEqual(body, [
      {
        keyword: "cid:123",
        location_coordinate: "33.1234568,-84.9876543,5000",
        language_code: "en",
      },
    ]);
    assert.deepEqual(result.data, {
      title: "Acme Cafe",
      is_claimed: true,
      check_url: "https://maps.google.com/?cid=123",
    });
    assert.equal(result.billing.costUsd, 0.002);
  });

  it("falls back to location_code and treats no-results as an empty success", async () => {
    const stub = stubDataforseo({
      status_code: 20000,
      tasks: [
        {
          status_code: 40501,
          status_message: "No Search Results.",
          path: ["v3", "business_data", "google", "my_business_info", "live"],
          cost: 0.002,
        },
      ],
    });

    const result = await fetchMyBusinessInfo(
      {
        keyword: "Nowhere Cafe",
        locationCode: 2840,
        languageCode: "en",
      },
      stub.options,
    );

    assert.deepEqual(requestOf(stub).body, [
      {
        keyword: "Nowhere Cafe",
        location_code: 2840,
        language_code: "en",
      },
    ]);
    assert.equal(result.data, null);
    // DataForSEO charges for an empty result, so it still has to be metered.
    assert.equal(result.billing.costUsd, 0.002);
  });

  it("posts reviews to regular reviews endpoint when includeOtherSources=false and bills from the post entry", async () => {
    const path = ["v3", "business_data", "google", "reviews", "task_post"];
    const stub = stubDataforseo({
      status_code: 20000,
      tasks: [{ id: "task-1", status_code: 20100, cost: 0.00375, path }],
    });

    const result = await postGoogleReviewsTask(
      {
        cid: "123",
        locationCode: 2840,
        languageCode: "en",
        depth: 20,
        sortBy: "newest",
        includeOtherSources: false,
      },
      stub.options,
    );

    const { url, body } = requestOf(stub);
    assert.equal(url, "https://api.dataforseo.com/v3/business_data/google/reviews/task_post");
    assert.deepEqual(body, [
      {
        cid: "123",
        location_code: 2840,
        language_code: "en",
        depth: 20,
        sort_by: "newest",
        priority: 2,
      },
    ]);
    assert.deepEqual(result, {
      data: "task-1",
      billing: { path, costUsd: 0.00375 },
    });
  });

  it("posts reviews to extended_reviews endpoint when includeOtherSources=true without sort_by", async () => {
    const path = ["v3", "business_data", "google", "extended_reviews", "task_post"];
    const stub = stubDataforseo({
      status_code: 20000,
      tasks: [{ id: "task-2", status_code: 20100, cost: 0.01, path }],
    });

    const result = await postGoogleReviewsTask(
      {
        cid: "123",
        locationCode: 2840,
        languageCode: "en",
        depth: 20,
        sortBy: "newest",
        includeOtherSources: true,
      },
      stub.options,
    );

    const { url, body } = requestOf(stub);
    assert.equal(
      url,
      "https://api.dataforseo.com/v3/business_data/google/extended_reviews/task_post",
    );
    assert.deepEqual(body, [
      {
        cid: "123",
        location_code: 2840,
        language_code: "en",
        depth: 20,
        priority: 2,
      },
    ]);
    assert.deepEqual(result, {
      data: "task-2",
      billing: { path, costUsd: 0.01 },
    });
  });

  it("never replays a task_post on a 5xx (a retry could double-charge)", async () => {
    let callCount = 0;
    const fetchImpl: typeof fetch = async () => {
      callCount++;
      return new Response("upstream error", { status: 500 });
    };

    await assert.rejects(
      async () =>
        postGoogleReviewsTask(
          {
            cid: "123",
            locationCode: 2840,
            languageCode: "en",
            depth: 20,
            sortBy: "newest",
            includeOtherSources: false,
          },
          {
            fetchImpl,
            env: { DATAFORSEO_API_KEY: "test-api-key" },
          },
        ),
      (err: unknown) => {
        assert.ok(err instanceof AmbiguousCallError);
        assert.equal(err.status, 503);
        assert.equal(err.code, "dataforseo_unavailable");
        return true;
      },
    );
    assert.equal(callCount, 1);
  });

  it("reports a queued task as pending instead of failing", async () => {
    const stub = stubDataforseo({
      status_code: 20000,
      tasks: [{ status_code: 40602, status_message: "Task In Queue." }],
    });

    const outcome = await fetchBusinessDataTaskResult(
      { endpoint: "reviews", taskId: "task-1" },
      stub.options,
    );
    assert.deepEqual(outcome, { status: "pending", result: null });
  });

  it("maps the free categories list onto category/businessCount rows", async () => {
    const stub = stubDataforseo(
      okTask(
        ["v3", "business_data", "business_listings", "categories"],
        [
          { category_name: "pizza_restaurant", business_count: 12 },
          { category_name: "plumber" },
        ],
      ),
    );

    const result = await fetchBusinessListingsCategories(stub.options);

    assert.deepEqual(result.data, [
      { category: "pizza_restaurant", businessCount: 12 },
      { category: "plumber", businessCount: null },
    ]);
    assert.equal(result.billing.costUsd, 0.002);
  });

  it("every entry is priced: walks createBusinessClient and asserts each estimator > 0 and feature names", () => {
    type SpyEntry = {
      fetcher: unknown;
      costFn: (input: any) => number;
      defaultFeature: string | null;
    };
    const registered: Record<string, SpyEntry> = {};

    const spyMeter = ((fetcher: unknown, costFn: (input: any) => number, defaultFeature: string | null) => {
      const entry: SpyEntry = { fetcher, costFn, defaultFeature };
      return entry as any;
    }) as any;

    const client = createBusinessClient({ meter: spyMeter });

    // businessListings
    const listings = client.businessListings as unknown as SpyEntry;
    assert.equal(listings.defaultFeature, "local.business");
    const listingsCost = listings.costFn({ limit: 20 });
    assert.ok(listingsCost > 0, `Expected listingsCost > 0, got ${listingsCost}`);

    // myBusinessInfo
    const info = client.myBusinessInfo as unknown as SpyEntry;
    assert.equal(info.defaultFeature, "local.business");
    const infoCost = info.costFn({});
    assert.ok(infoCost > 0, `Expected infoCost > 0, got ${infoCost}`);

    // questionsAnswers
    const qa = client.questionsAnswers as unknown as SpyEntry;
    assert.equal(qa.defaultFeature, "local.business");
    const qaCost = qa.costFn({ depth: 20 });
    assert.ok(qaCost > 0, `Expected qaCost > 0, got ${qaCost}`);

    // reviewsTaskPost (regular)
    const rev = client.reviewsTaskPost as unknown as SpyEntry;
    assert.equal(rev.defaultFeature, "local.reviews");
    const revCost = rev.costFn({ depth: 20, includeOtherSources: false });
    assert.ok(revCost > 0, `Expected revCost > 0, got ${revCost}`);

    // reviewsTaskPost (extended)
    const extCost = rev.costFn({ depth: 20, includeOtherSources: true });
    assert.ok(extCost > 0, `Expected extCost > 0, got ${extCost}`);

    // updatesTaskPost
    const updates = client.updatesTaskPost as unknown as SpyEntry;
    assert.equal(updates.defaultFeature, "local.business");
    const updatesCost = updates.costFn({ depth: 10 });
    assert.ok(updatesCost > 0, `Expected updatesCost > 0, got ${updatesCost}`);
  });

  it("loads and parses synthetic fixtures correctly", async () => {
    const fixtureDir = join(process.cwd(), "tests", "fixtures", "f17");

    // business-info.json
    const infoJson = JSON.parse(await readFile(join(fixtureDir, "business-info.json"), "utf8"));
    const stubInfo = stubDataforseo(infoJson);
    const infoResult = await fetchMyBusinessInfo(
      { keyword: "cid:123456789", locationCoordinate: "37.7749,-122.4194,5000", languageCode: "en" },
      stubInfo.options,
    );
    assert.equal(infoResult.data?.title, "Acme Cafe");
    assert.equal(infoResult.data?.check_url, "https://www.google.com/maps?cid=123456789");

    // business-info-no-results.json
    const noResultsJson = JSON.parse(await readFile(join(fixtureDir, "business-info-no-results.json"), "utf8"));
    const stubNoResults = stubDataforseo(noResultsJson);
    const noResultsOutcome = await fetchMyBusinessInfo(
      { keyword: "cid:nonexistent", locationCode: 2840, languageCode: "en" },
      stubNoResults.options,
    );
    assert.equal(noResultsOutcome.data, null);

    // listings-search.json
    const listingsJson = JSON.parse(await readFile(join(fixtureDir, "listings-search.json"), "utf8"));
    const stubListings = stubDataforseo(listingsJson);
    const listingsResult = await fetchBusinessListingsSearch(
      { locationCoordinate: "37.77,-122.41,10", limit: 5 },
      stubListings.options,
    );
    assert.equal(listingsResult.data.length, 5);
    assert.equal(listingsResult.data[0]?.title, "Business 1");

    // qa.json
    const qaJson = JSON.parse(await readFile(join(fixtureDir, "qa.json"), "utf8"));
    const stubQa = stubDataforseo(qaJson);
    const qaResult = await fetchQuestionsAnswers(
      { keyword: "cid:123456789", locationCoordinate: "37.77,-122.41,5000", languageCode: "en", depth: 20 },
      stubQa.options,
    );
    assert.equal(qaResult.data.length, 3); // 2 answered + 1 unanswered

    // reviews-task-post.json
    const revPostJson = JSON.parse(await readFile(join(fixtureDir, "reviews-task-post.json"), "utf8"));
    const stubRevPost = stubDataforseo(revPostJson);
    const revPostResult = await postGoogleReviewsTask(
      { cid: "123456789", locationCode: 2840, languageCode: "en", depth: 20, includeOtherSources: false },
      stubRevPost.options,
    );
    assert.equal(revPostResult.data, "rev-task-post-1");

    // reviews-task-get-pending.json
    const pendingJson = JSON.parse(await readFile(join(fixtureDir, "reviews-task-get-pending.json"), "utf8"));
    const stubPending = stubDataforseo(pendingJson);
    const pendingOutcome = await fetchBusinessDataTaskResult(
      { endpoint: "reviews", taskId: "rev-task-post-1" },
      stubPending.options,
    );
    assert.equal(pendingOutcome.status, "pending");

    // reviews-task-get-done.json
    const doneJson = JSON.parse(await readFile(join(fixtureDir, "reviews-task-get-done.json"), "utf8"));
    const stubDone = stubDataforseo(doneJson);
    const doneOutcome = await fetchBusinessDataTaskResult(
      { endpoint: "reviews", taskId: "rev-task-post-1" },
      stubDone.options,
    );
    assert.equal(doneOutcome.status, "completed");
    assert.equal(doneOutcome.result?.title, "Acme Cafe");
    assert.equal(Array.isArray(doneOutcome.result?.items), true);
    assert.equal((doneOutcome.result?.items as unknown[]).length, 20);

    // categories.json
    const catJson = JSON.parse(await readFile(join(fixtureDir, "categories.json"), "utf8"));
    const stubCat = stubDataforseo(catJson);
    const catResult = await fetchBusinessListingsCategories(stubCat.options);
    assert.equal(catResult.data.length, 50);
  });
});
