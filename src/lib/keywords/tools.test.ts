import test from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import {
  researchKeywordsTool,
  researchKeywordsInput,
  researchKeywordsOutput,
  type KeywordToolContext,
} from "./tools.ts";

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
