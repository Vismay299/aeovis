import test from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import {
  researchKeywordsTool,
  researchKeywordsInput,
  researchKeywordsOutput,
  listSavedKeywordsTool,
  listSavedKeywordsInput,
  listSavedKeywordsOutput,
  saveKeywordsTool,
  saveKeywordsInput,
  saveKeywordsOutput,
  type KeywordToolContext,
} from "./tools.ts";
import { createMemorySavedKeywordsRepository } from "./memoryRepository.ts";

test("research_keywords tool", async (t) => {
  await t.test("input schema is closed (rejects unknown properties)", () => {
    assert.throws(
      () =>
        researchKeywordsInput.parse({
          keyword: "seo tools",
          maxUsd: 1.0,
          unexpectedKey: "disallowed",
        }),
      (err: unknown) => err instanceof z.ZodError,
    );
  });

  await t.test("input schema validates valid inputs", () => {
    const parsed = researchKeywordsInput.parse({
      keyword: "seo tools",
      maxUsd: 1.0,
    });
    assert.equal(parsed.keyword, "seo tools");
    assert.equal(parsed.resultLimit, 150);
    assert.equal(parsed.maxUsd, 1.0);
  });

  await t.test("input schema rejects negative or zero maxUsd", () => {
    assert.throws(
      () =>
        researchKeywordsInput.parse({
          keyword: "seo tools",
          maxUsd: 0,
        }),
      (err: unknown) => err instanceof z.ZodError,
    );
  });

  await t.test("output schema parses loosely", () => {
    const validOutput = researchKeywordsOutput.parse({
      rows: [{ keyword: "test", searchVolume: 100 }],
      source: "blended",
      cached: false,
      extraProperty: "allowed",
    });
    assert.equal(validOutput.source, "blended");
    assert.equal(validOutput.cached, false);
    assert.equal(validOutput.rows.length, 1);
  });

  await t.test("handler runs research and returns expected output shape", async () => {
    let researchCalled = false;
    const ctx: KeywordToolContext = {
      admin: {} as any,
      brand: { brandKey: "example.com", website_host: "example.com" },
      userId: "user-1",
      deps: {
        requireApprovedPrice: async () => ({
          approvedMaxUsd: 0.1,
          quote: {} as any,
          source: "dialog",
        }),
        research: async (_input, deps) => {
          researchCalled = true;
          assert.equal(deps.maxUsd, 0.1);
          return {
            result: {
              rows: [
                {
                  keyword: "seo tools",
                  searchVolume: 1000,
                  trend: [],
                  cpc: 2.0,
                  competition: 0.5,
                  keywordDifficulty: 50,
                  intent: "commercial",
                },
              ],
              source: "blended",
              usedFallback: false,
            },
            cached: false,
            fetched: true,
            fetchedAt: "2026-11-10T12:00:00.000Z",
          };
        },
      },
    };

    const result = await researchKeywordsTool.handler(ctx, {
      keyword: "seo tools",
      maxUsd: 0.5,
    });

    assert.equal(researchCalled, true);
    assert.equal(result.cached, false);
    assert.equal(result.source, "blended");
    assert.equal(result.rows.length, 1);
  });
});

test("list_saved_keywords tool", async (t) => {
  await t.test("input schema is closed", () => {
    assert.throws(
      () =>
        listSavedKeywordsInput.parse({
          search: "test",
          extra: "rejected",
        }),
      (err: unknown) => err instanceof z.ZodError,
    );
  });

  await t.test("input schema applies defaults", () => {
    const parsed = listSavedKeywordsInput.parse({});
    assert.equal(parsed.sort, "searchVolume");
    assert.equal(parsed.limit, 100);
  });

  await t.test("output schema accepts rows and totalCount loosely", () => {
    const output = listSavedKeywordsOutput.parse({
      rows: [{ id: "kw-1", keyword: "seo" }],
      totalCount: 1,
      extra: true,
    });
    assert.equal(output.totalCount, 1);
    assert.equal(output.rows.length, 1);
  });

  await t.test("handler queries saved keywords with repo", async () => {
    const repo = createMemorySavedKeywordsRepository();
    await repo.save({
      brandKey: "example.com",
      keywords: ["seo tool", "keyword research"],
      locationCode: 2840,
      languageCode: "en",
    });

    const ctx: KeywordToolContext = {
      admin: {} as any,
      brand: { brandKey: "example.com", website_host: "example.com" },
      userId: "user-1",
      deps: { repo },
    };

    const result = await listSavedKeywordsTool.handler(ctx, {
      search: "tool",
    });

    assert.equal(result.totalCount, 1);
    assert.equal(result.rows.length, 1);
    assert.equal((result.rows[0] as any).keyword, "seo tool");
  });
});

test("save_keywords tool", async (t) => {
  await t.test("input schema is closed", () => {
    assert.throws(
      () =>
        saveKeywordsInput.parse({
          keywords: ["seo"],
          extra: "rejected",
        }),
      (err: unknown) => err instanceof z.ZodError,
    );
  });

  await t.test("input schema rejects empty keyword array", () => {
    assert.throws(
      () =>
        saveKeywordsInput.parse({
          keywords: [],
        }),
      (err: unknown) => err instanceof z.ZodError,
    );
  });

  await t.test("output schema validates output", () => {
    const output = saveKeywordsOutput.parse({
      savedKeywordIds: ["id-1", "id-2"],
      created: 2,
      extra: "allowed",
    });
    assert.equal(output.created, 2);
    assert.equal(output.savedKeywordIds.length, 2);
  });

  await t.test("handler saves keywords and returns created count and ids", async () => {
    const repo = createMemorySavedKeywordsRepository();
    const ctx: KeywordToolContext = {
      admin: {} as any,
      brand: { brandKey: "example.com", website_host: "example.com" },
      userId: "user-1",
      deps: { repo },
    };

    const result = await saveKeywordsTool.handler(ctx, {
      keywords: ["ranking checker", "seo audit"],
      tags: ["priority"],
      locationCode: 2840,
    });

    assert.equal(result.created, 2);
    assert.equal(result.savedKeywordIds.length, 2);

    // Save again: idempotent, created = 0
    const result2 = await saveKeywordsTool.handler(ctx, {
      keywords: ["ranking checker"],
      locationCode: 2840,
    });
    assert.equal(result2.created, 0);
    assert.equal(result2.savedKeywordIds[0], result.savedKeywordIds[0]);
  });
});
