import assert from "node:assert/strict";
import { test } from "node:test";
import {
  appendLocalResearch,
  fetchResearchFeature,
  fetchResearchKey,
  fetchResearchSummary,
  gridResearchKey,
  gridResearchSummary,
  profileResearchKey,
  profileResearchSummary,
  recentResearchWarning,
  RECENT_RESEARCH_DAYS,
  serpResearchKey,
  serpResearchSummary,
} from "./research.ts";

test("profile key and summaries", () => {
  assert.equal(profileResearchKey({ cid: "123", placeId: "p" }), "profile|123");
  assert.equal(profileResearchKey({ placeId: "ChIJ1" }), "profile|ChIJ1");
  assert.equal(profileResearchKey({ name: "Acme" }), "profile|Acme");
  assert.equal(
    profileResearchSummary({ title: "Acme Cafe", category: "Coffee shop", rating: 4.6, votes: 210 }),
    "Google Business Profile for Acme Cafe: Coffee shop, 4.6★ from 210 reviews.",
  );
  assert.equal(profileResearchSummary({ identifier: "Acme" }), "No Google Business Profile matched Acme.");
});

test("fetch summaries and the spend feature per kind", () => {
  assert.equal(fetchResearchSummary({ kind: "reviews", title: "Acme", collected: 20, total: 210 }), "Reviews for Acme: collected 20 of 210.");
  assert.equal(fetchResearchSummary({ kind: "extended_reviews", title: "Acme", collected: 20, total: null }), "Reviews for Acme: collected 20 of 20.");
  assert.equal(fetchResearchSummary({ kind: "updates", title: "Acme", collected: 4 }), "Posts on Acme's profile: 4 collected.");
  assert.equal(fetchResearchSummary({ kind: "questions", title: "Acme", collected: 3 }), "Questions on Acme's profile: 3 collected.");
  assert.equal(fetchResearchFeature("reviews"), "local.reviews");
  assert.equal(fetchResearchFeature("extended_reviews"), "local.reviews");
  assert.equal(fetchResearchFeature("updates"), "local.business");
  assert.equal(fetchResearchFeature("questions"), "local.business");
  assert.equal(fetchResearchKey({ kind: "reviews", cid: "1", depth: 20 }), "reviews|1|20");
});

test("grid and serp keys and summaries", () => {
  assert.equal(gridResearchKey({ keyword: "streetwear store", latitude: 19.076, longitude: 72.8777, gridSize: 3, spacingKm: 2 }), "streetwear store|19.076|72.8777|3|2");
  assert.equal(
    gridResearchSummary({ keyword: "streetwear store", gridSize: 3, spacingKm: 2, found: 7, searched: 9, averageRank: 4.29 }),
    "Map ranking grid for “streetwear store” (3×3, 2 km): ranked at 7 of 9 points, average 4.29.",
  );
  assert.equal(serpResearchKey({ keyword: "k", latitude: 1, longitude: 2, zoom: 12, searchType: "maps" }), "serp|k|1|2|12|maps");
  assert.equal(
    serpResearchSummary({ keyword: "k", latitude: 1, longitude: 2, count: 20, ownRank: null }),
    "Local results for “k” near 1,2: 20 businesses; you rank not in the results.",
  );
});

test("appendLocalResearch writes kind, key, summary and the actor, and never throws", async () => {
  const seen: unknown[] = [];
  const ws = { admin: {} as never, brandKey: "b", user: { id: "u1" } };
  const ok = await appendLocalResearch(
    ws,
    { kind: "local.grid", researchKey: "k", summary: "s", spendUsd: 0.01 },
    { appendResearch: async (_admin, input) => void seen.push(input) },
  );
  assert.equal(ok, true);
  assert.deepEqual(seen[0], { brandKey: "b", kind: "local.grid", researchKey: "k", summary: "s", spendUsd: 0.01, author: "user", actorUserId: "u1" });
  const failed = await appendLocalResearch(
    ws,
    { kind: "local.grid", researchKey: "k", summary: "s" },
    {
      appendResearch: async () => {
        throw new Error("db down");
      },
    },
  );
  assert.equal(failed, false);
});

test("recent_research warning: found within 90 days, otherwise null; lookup errors are ignored", async () => {
  const calls: unknown[] = [];
  const warning = await recentResearchWarning(
    {} as never,
    { brandKey: "b", kind: "local.business", researchKey: "profile|123" },
    {
      findRecentResearch: async (_admin, input) => {
        calls.push(input);
        return { id: "1", entryDate: "2026-10-01", summary: "Google Business Profile for Acme Cafe.", spendUsd: 0.0054, createdAt: "2026-10-01T00:00:00Z" };
      },
    },
  );
  assert.deepEqual(warning, { code: "recent_research", message: "You looked this up on 2026-10-01: Google Business Profile for Acme Cafe." });
  assert.deepEqual(calls[0], { brandKey: "b", kind: "local.business", researchKey: "profile|123", days: RECENT_RESEARCH_DAYS });
  assert.equal(RECENT_RESEARCH_DAYS, 90);
  assert.equal(await recentResearchWarning({} as never, { brandKey: "b", kind: "local.serp", researchKey: "x" }, { findRecentResearch: async () => null }), null);
  assert.equal(
    await recentResearchWarning({} as never, { brandKey: "b", kind: "local.serp", researchKey: "x" }, {
      findRecentResearch: async () => {
        throw new Error("nope");
      },
    }),
    null,
  );
});
