// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/mcp/tools/local-seo-tools.test.ts:136-240 (resumable when queued;
//   collection failure keeps the fetch; resume without a new post)
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import assert from "node:assert/strict";
import { test } from "node:test";
import { AppError } from "../../shared/http/appError.ts";
import { ChargedCallError, SpendRefused, UnbilledCallError } from "../../shared/spend/errors.ts";
import { saveBusiness } from "./businesses.ts";
import { collectFetch, INLINE_POLL_ATTEMPTS, INLINE_POLL_INTERVAL_MS, listFetches, startFetch } from "./fetches.ts";
import { fixture, fixtureResult, localKit, makeWs, type LocalKit } from "./testKit.ts";

const ws = makeWs();
const REQ1 = "11111111-aaaa-4aaa-8aaa-111111111111";
const REQ2 = "22222222-aaaa-4aaa-8aaa-222222222222";
const REQ3 = "33333333-aaaa-4aaa-8aaa-333333333333";
const TASK = "rev-task-post-1";

const donePayload = () => ({ status: "completed" as const, result: fixtureResult("reviews-task-get-done.json") });
const pending = { status: "pending" as const, result: null };

async function kitWithBusiness(
  responders: Parameters<typeof localKit>[0],
  taskResults: Array<unknown | Error>,
  business: { cid?: string; latitude?: number; longitude?: number } = { cid: "123456789", latitude: 37.7749, longitude: -122.4194 },
): Promise<{ kit: LocalKit; businessId: string; polls: Array<{ endpoint: string; taskId: string }> }> {
  const polls: Array<{ endpoint: string; taskId: string }> = [];
  let index = 0;
  const kit = localKit(responders, {
    fetchTaskResult: (async (input: { endpoint: string; taskId: string }) => {
      polls.push(input);
      const next = taskResults[Math.min(index, taskResults.length - 1)];
      index += 1;
      if (next instanceof Error) throw next;
      return next;
    }) as never,
  });
  const saved = await saveBusiness(ws, { role: "own", title: "Acme Cafe", ...business }, kit.deps);
  return { kit, businessId: saved.id, polls };
}

const postsReviews = { reviewsTaskPost: () => ({ data: TASK, costUsd: 0.004 }) };

test("reviews: one paid post, the task id is stored, inline polling completes and logs one research entry", async () => {
  const { kit, businessId, polls } = await kitWithBusiness(postsReviews, [pending, donePayload()]);
  const view = await startFetch(ws, { kind: "reviews", businessId, depth: 20, maxUsd: 0.01, requestId: REQ1 }, kit.deps);
  assert.equal(view.status, "completed");
  assert.equal(view.itemCount, 20);
  assert.equal(view.items?.length, 20);
  assert.equal(view.reused, false);
  assert.equal(view.pollAfterSeconds, null);
  assert.deepEqual(view.totals, { title: "Acme Cafe", reviewsCount: 210, rating: 4.6 });
  assert.deepEqual(view.params, { depth: 20, sortBy: "newest", includeOtherSources: false });
  assert.equal(kit.harness.calls.reviewsTaskPost?.length, 1, "exactly one paid post");
  const post = kit.harness.calls.reviewsTaskPost?.[0];
  assert.equal(post.cid, "123456789");
  assert.equal(post.sortBy, "newest");
  assert.equal(post.locationCoordinate, "37.7749,-122.4194,10000");
  assert.equal(kit.harness.spend.ledger.length, 1);
  assert.equal(kit.harness.spend.ledger[0]?.feature, "local.reviews");
  assert.deepEqual(polls.map((p) => p.endpoint), ["reviews", "reviews"]);
  assert.deepEqual(kit.clock.slept, [4000, 4000], "waits 4 s before each poll");
  const row = kit.store.fetches.get(view.id);
  assert.equal(row?.provider_task_id, TASK);
  assert.equal(kit.research.length, 1);
  assert.equal(kit.research[0]?.kind, "local.reviews");
  assert.equal(kit.research[0]?.summary, "Reviews for Acme Cafe: collected 20 of 210.");
  assert.ok(kit.logs.includes(`[local] fetch ${view.id} reviews completed`));
});

test("review rows are trimmed to the allow-list but keep review text and owner replies whole", async () => {
  const done = donePayload();
  (done.result.items[0] as Record<string, unknown>).image_url = "https://example.test/x.png";
  (done.result.items[0] as Record<string, unknown>).xpath = "/html/body";
  const { kit, businessId } = await kitWithBusiness(postsReviews, [done]);
  const view = await startFetch(ws, { kind: "reviews", businessId, depth: 20, maxUsd: 0.01, requestId: REQ1 }, kit.deps);
  const first = view.items?.[0] as Record<string, unknown>;
  assert.equal(first.review_text, "Great coffee and friendly staff.");
  assert.equal(first.owner_answer, "Thank you for the review!");
  assert.equal(first.image_url, undefined);
  assert.equal(first.xpath, undefined);
  assert.equal(view.items?.filter((i) => (i as Record<string, unknown>).owner_answer).length, 6);
});

test("a queued task answers 202-style processing after 5 polls of 4 s, and the paid task is never lost", async () => {
  const { kit, businessId } = await kitWithBusiness(postsReviews, [pending]);
  const view = await startFetch(ws, { kind: "reviews", businessId, depth: 20, maxUsd: 0.01, requestId: REQ1 }, kit.deps);
  assert.equal(view.status, "processing");
  assert.equal(view.pollAfterSeconds, 5);
  assert.equal(view.items, null);
  assert.equal(kit.clock.slept.length, INLINE_POLL_ATTEMPTS);
  assert.equal(kit.clock.slept.reduce((a, b) => a + b, 0), INLINE_POLL_ATTEMPTS * INLINE_POLL_INTERVAL_MS);
  assert.equal(kit.store.fetches.get(view.id)?.provider_task_id, TASK);
  assert.equal(kit.research.length, 0, "no research entry until the fetch completes");
});

test("collect resumes without a new post, is free, and is throttled to one provider read per 4 s", async () => {
  const { kit, businessId, polls } = await kitWithBusiness(postsReviews, [pending, pending, pending, pending, pending, donePayload()]);
  const started = await startFetch(ws, { kind: "reviews", businessId, depth: 20, maxUsd: 0.01, requestId: REQ1 }, kit.deps);
  assert.equal(started.status, "processing");
  const readsAfterStart = polls.length;

  const first = await collectFetch(ws, started.id, kit.deps);
  assert.equal(first.status, "completed", "the next collection finishes it");
  assert.equal(first.items?.length, 20);
  assert.equal(polls.length, readsAfterStart + 1);
  assert.equal(kit.harness.calls.reviewsTaskPost?.length, 1, "no second post");
  assert.equal(kit.harness.spend.ledger.length, 1, "collection costs nothing");
  assert.equal(kit.research.length, 1);

  const again = await collectFetch(ws, started.id, kit.deps);
  assert.equal(again.status, "completed");
  assert.equal(polls.length, readsAfterStart + 1, "a completed fetch is served from storage");
});

test("two collections inside 4 s make one provider read", async () => {
  const { kit, businessId, polls } = await kitWithBusiness(postsReviews, [pending]);
  const started = await startFetch(ws, { kind: "reviews", businessId, depth: 20, maxUsd: 0.01, requestId: REQ1 }, kit.deps);
  const base = polls.length;
  kit.clock.advance(5000);
  await collectFetch(ws, started.id, kit.deps);
  await collectFetch(ws, started.id, kit.deps);
  assert.equal(polls.length, base + 1);
  kit.clock.advance(4500);
  await collectFetch(ws, started.id, kit.deps);
  assert.equal(polls.length, base + 2);
});

test("a collection error keeps the fetch collectable and returns it as processing", async () => {
  const transient = new AppError(502, "dataforseo_unavailable", "network");
  const { kit, businessId } = await kitWithBusiness(postsReviews, [transient, donePayload()]);
  const view = await startFetch(ws, { kind: "reviews", businessId, depth: 20, maxUsd: 0.01, requestId: REQ1 }, kit.deps);
  assert.equal(view.status, "processing");
  assert.equal(kit.store.fetches.get(view.id)?.provider_task_id, TASK);
  assert.equal(kit.harness.calls.reviewsTaskPost?.length, 1);
  kit.clock.advance(5000);
  const done = await collectFetch(ws, view.id, kit.deps);
  assert.equal(done.status, "completed");
  assert.equal(kit.harness.calls.reviewsTaskPost?.length, 1, "resumed without a new post");
});

test("a provider failure status marks the fetch failed with the message trimmed", async () => {
  const failure = new AppError(502, "dataforseo_task_failed", "x".repeat(400));
  const { kit, businessId } = await kitWithBusiness(postsReviews, [failure]);
  const view = await startFetch(ws, { kind: "reviews", businessId, depth: 20, maxUsd: 0.01, requestId: REQ1 }, kit.deps);
  assert.equal(view.status, "failed");
  assert.equal(view.error?.code, "dataforseo_task_failed");
  assert.equal(view.error?.message.length, 300);
  assert.equal(view.pollAfterSeconds, null);
});

test("the same business and parameters within 60 minutes reuse the earlier fetch with no spend", async () => {
  const { kit, businessId } = await kitWithBusiness(postsReviews, [donePayload()]);
  const first = await startFetch(ws, { kind: "reviews", businessId, depth: 20, maxUsd: 0.01, requestId: REQ1 }, kit.deps);
  kit.clock.advance(59 * 60_000);
  const second = await startFetch(ws, { kind: "reviews", businessId, depth: 20, maxUsd: 0.01, requestId: REQ2 }, kit.deps);
  assert.equal(second.id, first.id);
  assert.equal(second.reused, true);
  assert.equal(second.items?.length, 20);
  assert.equal(kit.harness.calls.reviewsTaskPost?.length, 1);
  assert.equal(kit.research.length, 1, "reuse writes no research entry");
  // Different parameters are a new purchase.
  const deeper = await startFetch(ws, { kind: "reviews", businessId, depth: 50, maxUsd: 0.01, requestId: REQ3 }, kit.deps);
  assert.notEqual(deeper.id, first.id);
  assert.equal(kit.harness.calls.reviewsTaskPost?.length, 2);
});

test("after 60 minutes the earlier fetch is no longer reused", async () => {
  const { kit, businessId } = await kitWithBusiness(postsReviews, [donePayload()]);
  const first = await startFetch(ws, { kind: "reviews", businessId, depth: 20, maxUsd: 0.01, requestId: REQ1 }, kit.deps);
  kit.clock.advance(61 * 60_000);
  const second = await startFetch(ws, { kind: "reviews", businessId, depth: 20, maxUsd: 0.01, requestId: REQ2 }, kit.deps);
  assert.notEqual(second.id, first.id);
  assert.equal(second.reused, false);
  assert.equal(kit.harness.calls.reviewsTaskPost?.length, 2);
});

test("a repeated requestId returns the same fetch and buys nothing more", async () => {
  const failure = new AppError(502, "dataforseo_task_failed", "provider said no");
  const { kit, businessId } = await kitWithBusiness(postsReviews, [failure]);
  const first = await startFetch(ws, { kind: "reviews", businessId, depth: 20, maxUsd: 0.01, requestId: REQ1 }, kit.deps);
  assert.equal(first.status, "failed", "failed fetches are excluded from reuse");
  const retry = await startFetch(ws, { kind: "reviews", businessId, depth: 20, maxUsd: 0.01, requestId: REQ1 }, kit.deps);
  assert.equal(retry.id, first.id);
  assert.equal(retry.status, "failed");
  assert.equal(kit.harness.calls.reviewsTaskPost?.length, 1);
});

test("reviews from other sites use the extended endpoint and ignore the sort", async () => {
  const { kit, businessId, polls } = await kitWithBusiness(postsReviews, [{ status: "completed", result: fixtureResult("reviews-task-get-done.json") }]);
  const view = await startFetch(
    ws,
    { kind: "reviews", businessId, depth: 20, sortBy: "highest_rating", includeOtherSources: true, maxUsd: 0.02, requestId: REQ1 },
    kit.deps,
  );
  assert.equal(view.kind, "extended_reviews");
  assert.equal(view.params.includeOtherSources, true);
  assert.equal(view.params.sortBy, undefined);
  const post = kit.harness.calls.reviewsTaskPost?.[0];
  assert.equal(post.includeOtherSources, true);
  assert.equal(post.sortBy, undefined);
  assert.equal(polls[0]?.endpoint, "extended_reviews");
});

test("posts: queued updates post, endpoint my_business_updates, rows trimmed", async () => {
  const done = {
    status: "completed" as const,
    result: {
      title: "Acme Cafe",
      items: [{ rank_absolute: 1, author: "Acme Cafe", post_date: "2026-11-01", post_text: "New menu", snippet: "New menu", url: "https://example.com", links: [{ title: "Menu", url: "https://example.com/menu" }], image_url: "https://example.test/x.png" }],
    },
  };
  const { kit, businessId, polls } = await kitWithBusiness({ updatesTaskPost: () => ({ data: "upd-1", costUsd: 0.003 }) }, [done]);
  const view = await startFetch(ws, { kind: "updates", businessId, depth: 10, maxUsd: 0.01, requestId: REQ1 }, kit.deps);
  assert.equal(view.status, "completed");
  assert.equal(view.kind, "updates");
  const post = kit.harness.calls.updatesTaskPost?.[0];
  assert.equal(post.keyword, "cid:123456789");
  assert.equal(polls[0]?.endpoint, "my_business_updates");
  const item = view.items?.[0] as Record<string, unknown>;
  assert.equal(item.post_text, "New menu");
  assert.equal(item.image_url, undefined);
  assert.equal(kit.harness.spend.ledger[0]?.feature, "local.business");
  assert.equal(kit.research[0]?.kind, "local.business");
  assert.equal(kit.research[0]?.summary, "Posts on Acme Cafe's profile: 1 collected.");
});

test("questions combine answered and unanswered rows, trim them and store like a completed fetch", async () => {
  const qa = fixtureResult("qa.json");
  const combined = [...qa.items, ...qa.items_without_answers];
  const { kit, businessId, polls } = await kitWithBusiness({ questionsAnswers: () => ({ data: combined, costUsd: 0.0054 }) }, [pending]);
  const view = await startFetch(ws, { kind: "questions", businessId, depth: 20, maxUsd: 0.01, requestId: REQ1 }, kit.deps);
  assert.equal(view.status, "completed");
  assert.equal(view.itemCount, 3);
  assert.equal(polls.length, 0, "live call: no task polling");
  assert.equal(kit.clock.slept.length, 0);
  const call = kit.harness.calls.questionsAnswers?.[0];
  assert.equal(call.keyword, "cid:123456789");
  assert.equal(call.depth, 20);
  const [answered, , unanswered] = view.items as Array<Record<string, unknown>>;
  assert.equal(answered?.question_text, "Do you offer vegan options?");
  assert.equal((answered?.items as unknown[]).length, 1);
  assert.deepEqual(unanswered?.items, []);
  assert.equal(kit.research[0]?.summary, "Questions on Acme Cafe's profile: 3 collected.");
  assert.equal(kit.store.fetches.get(view.id)?.status, "completed");
});

test("questions need a known location: 400 business_location_required and no spend", async () => {
  const { kit, businessId } = await kitWithBusiness({ questionsAnswers: () => ({ data: [] }) }, [pending], { cid: "55" });
  await assert.rejects(
    startFetch(ws, { kind: "questions", businessId, depth: 20, maxUsd: 0.01, requestId: REQ1 }, kit.deps),
    (err: unknown) => err instanceof AppError && err.status === 400 && err.code === "business_location_required",
  );
  assert.equal(kit.harness.calls.questionsAnswers, undefined);
  assert.equal(kit.store.fetches.size, 0);
});

test("a business from another workspace is a 404 before any spend", async () => {
  const { kit } = await kitWithBusiness(postsReviews, [pending]);
  const foreign = await saveBusiness(makeWs("other.example"), { role: "own", title: "Theirs", cid: "777" }, kit.deps);
  await assert.rejects(
    startFetch(ws, { kind: "reviews", businessId: foreign.id, depth: 20, maxUsd: 0.01, requestId: REQ1 }, kit.deps),
    (err: unknown) => err instanceof AppError && err.status === 404 && err.code === "business_not_found",
  );
  assert.equal(kit.harness.calls.reviewsTaskPost, undefined);
});

test("a disabled spend control drops the placeholder row and surfaces SpendRefused", async () => {
  const polls: unknown[] = [];
  const kit = localKit(postsReviews, { fetchTaskResult: (async (i: unknown) => polls.push(i)) as never }, { enabled: false });
  const saved = await saveBusiness(ws, { role: "own", title: "Acme", cid: "9" }, kit.deps);
  await assert.rejects(
    startFetch(ws, { kind: "reviews", businessId: saved.id, depth: 20, maxUsd: 0.01, requestId: REQ1 }, kit.deps),
    (err: unknown) => err instanceof SpendRefused && err.reason === "feature_disabled",
  );
  assert.equal(kit.store.fetches.size, 0);
  assert.equal(polls.length, 0);
});

test("an unbilled provider error deletes the row and maps to 502 local_unavailable", async () => {
  const { kit, businessId } = await kitWithBusiness(
    {
      reviewsTaskPost: () => {
        throw new UnbilledCallError("upstream rejected", { code: "dataforseo_invalid_request", status: 400 });
      },
    },
    [pending],
  );
  await assert.rejects(
    startFetch(ws, { kind: "reviews", businessId, depth: 20, maxUsd: 0.01, requestId: REQ1 }, kit.deps),
    (err: unknown) => err instanceof AppError && err.status === 502 && err.code === "local_unavailable",
  );
  assert.equal(kit.store.fetches.size, 0);
});

test("a charged failure keeps a failed row with the fixed message, and is never retried", async () => {
  let posts = 0;
  const { kit, businessId } = await kitWithBusiness(
    {
      reviewsTaskPost: () => {
        posts += 1;
        throw new ChargedCallError("task failed", { actualUsd: 0.004, provider: "dataforseo", endpoint: "reviews/task_post" });
      },
    },
    [pending],
  );
  const view = await startFetch(ws, { kind: "reviews", businessId, depth: 20, maxUsd: 0.01, requestId: REQ1 }, kit.deps);
  assert.equal(view.status, "failed");
  assert.equal(view.error?.message, "Google data could not be collected. Try again later.");
  assert.equal(posts, 1);
});

test("listFetches filters by business and kind, newest first, and is workspace-scoped", async () => {
  const { kit, businessId } = await kitWithBusiness(postsReviews, [donePayload()]);
  await startFetch(ws, { kind: "reviews", businessId, depth: 20, maxUsd: 0.01, requestId: REQ1 }, kit.deps);
  kit.clock.advance(1000);
  await startFetch(ws, { kind: "reviews", businessId, depth: 50, maxUsd: 0.01, requestId: REQ2 }, kit.deps);
  const all = await listFetches(ws, { limit: 20 }, kit.deps);
  assert.deepEqual(all.map((f) => f.params.depth), [50, 20]);
  assert.equal(all[0]?.itemCount, 20);
  assert.equal((await listFetches(ws, { kind: "updates", limit: 20 }, kit.deps)).length, 0);
  assert.equal((await listFetches(makeWs("other.example"), { limit: 20 }, kit.deps)).length, 0);
});

test("collectFetch of an unknown or foreign fetch is 404 fetch_not_found", async () => {
  const { kit, businessId } = await kitWithBusiness(postsReviews, [donePayload()]);
  const view = await startFetch(ws, { kind: "reviews", businessId, depth: 20, maxUsd: 0.01, requestId: REQ1 }, kit.deps);
  await assert.rejects(
    collectFetch(makeWs("other.example"), view.id, kit.deps),
    (err: unknown) => err instanceof AppError && err.status === 404 && err.code === "fetch_not_found",
  );
  assert.ok(fixture("reviews-task-get-pending.json"), "fixtures load");
});
