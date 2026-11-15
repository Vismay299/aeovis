import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  exploreRunInputSchema,
  exploreModelLabel,
  countryLabel,
  supportsWebSearchCountry,
  exploreModelResultSchema,
} from "./explore.ts";

describe("src/shared/explore.ts", () => {
  it("validates standard input with defaults", () => {
    const parsed = exploreRunInputSchema.parse({
      prompt: "What are the best CRM tools?",
      models: ["chatgpt"],
    });
    assert.equal(parsed.prompt, "What are the best CRM tools?");
    assert.deepEqual(parsed.models, ["chatgpt"]);
    assert.equal(parsed.webSearch, true);
    assert.equal(parsed.country, null);
    assert.equal(parsed.highlightBrand, null);
    assert.equal(parsed.fresh, false);
  });

  it("handles prompt length edge cases: 500 chars allowed, 501 chars rejected", () => {
    const p500 = "a".repeat(500);
    const valid = exploreRunInputSchema.safeParse({
      prompt: p500,
      models: ["chatgpt"],
    });
    assert.equal(valid.success, true);

    const p501 = "a".repeat(501);
    const invalid = exploreRunInputSchema.safeParse({
      prompt: p501,
      models: ["chatgpt"],
    });
    assert.equal(invalid.success, false);

    const empty = exploreRunInputSchema.safeParse({
      prompt: "   ",
      models: ["chatgpt"],
    });
    assert.equal(empty.success, false);
  });

  it("collapses duplicate models and validates model array bounds", () => {
    // Duplicates collapsed
    const dups = exploreRunInputSchema.parse({
      prompt: "test",
      models: ["chatgpt", "chatgpt"],
    });
    assert.deepEqual(dups.models, ["chatgpt"]);

    // Duplicates collapsing 4 items down to 3
    const dups4 = exploreRunInputSchema.parse({
      prompt: "test",
      models: ["chatgpt", "gemini", "perplexity", "chatgpt"],
    });
    assert.deepEqual(dups4.models, ["chatgpt", "gemini", "perplexity"]);

    // Empty models array rejected
    const empty = exploreRunInputSchema.safeParse({
      prompt: "test",
      models: [],
    });
    assert.equal(empty.success, false);

    // 4 distinct items rejected (e.g. invalid enum or exceeding max 3)
    const tooMany = exploreRunInputSchema.safeParse({
      prompt: "test",
      models: ["chatgpt", "gemini", "perplexity", "other"],
    });
    assert.equal(tooMany.success, false);
  });

  it("validates highlightBrand length: 100 chars allowed, 101 rejected", () => {
    const b100 = "b".repeat(100);
    const valid = exploreRunInputSchema.safeParse({
      prompt: "test",
      models: ["chatgpt"],
      highlightBrand: b100,
    });
    assert.equal(valid.success, true);

    const b101 = "b".repeat(101);
    const invalid = exploreRunInputSchema.safeParse({
      prompt: "test",
      models: ["chatgpt"],
      highlightBrand: b101,
    });
    assert.equal(invalid.success, false);
  });

  it("validates country code regex: ISO uppercase only", () => {
    const us = exploreRunInputSchema.safeParse({
      prompt: "test",
      models: ["chatgpt"],
      country: "US",
    });
    assert.equal(us.success, true);

    const lower = exploreRunInputSchema.safeParse({
      prompt: "test",
      models: ["chatgpt"],
      country: "us",
    });
    assert.equal(lower.success, false);

    const threeLetters = exploreRunInputSchema.safeParse({
      prompt: "test",
      models: ["chatgpt"],
      country: "USA",
    });
    assert.equal(threeLetters.success, false);

    const nullCountry = exploreRunInputSchema.safeParse({
      prompt: "test",
      models: ["chatgpt"],
      country: null,
    });
    assert.equal(nullCountry.success, true);
  });

  it("formats model and country labels correctly", () => {
    assert.equal(exploreModelLabel("chatgpt"), "ChatGPT");
    assert.equal(exploreModelLabel("gemini"), "Gemini");
    assert.equal(exploreModelLabel("perplexity"), "Perplexity");

    assert.equal(countryLabel(null), "No country preference");
    assert.equal(countryLabel(undefined), "No country preference");
    assert.equal(countryLabel("US"), "United States");
    assert.equal(countryLabel("IN"), "India");
  });

  it("checks supportsWebSearchCountry rules", () => {
    // null country is always supported
    assert.equal(supportsWebSearchCountry("gemini", null), true);
    assert.equal(supportsWebSearchCountry("chatgpt", null), true);

    // With country: Gemini unsupported, ChatGPT / Perplexity supported
    assert.equal(supportsWebSearchCountry("gemini", "US"), false);
    assert.equal(supportsWebSearchCountry("chatgpt", "US"), true);
    assert.equal(supportsWebSearchCountry("perplexity", "IN"), true);
  });

  it("validates exploreModelResultSchema discriminated union", () => {
    const successResult = exploreModelResultSchema.parse({
      status: "success",
      model: "chatgpt",
      label: "ChatGPT",
      route: "dataforseo",
      modelName: "gpt-5.6-luna",
      text: "The answer is 42.",
      truncated: false,
      citations: [
        {
          url: "https://example.com",
          domain: "example.com",
          title: "Example",
          matchedBrand: false,
        },
      ],
      fanOutQueries: ["query 1"],
      fanOutReported: true,
      brandMentioned: false,
      workspaceBrandMentioned: false,
      outputTokens: 42,
      webSearch: true,
      countryHint: "US",
      costUsd: 0.05,
      costState: "measured",
      reusedFrom: null,
      observationId: "obs-1",
      observedAt: "2026-10-22T09:30:00.000Z",
    });
    assert.equal(successResult.status, "success");

    const errorResult = exploreModelResultSchema.parse({
      status: "error",
      model: "gemini",
      label: "Gemini",
      errorCode: "UNSUPPORTED_COUNTRY",
      message: "Gemini doesn't support country selection.",
      costUsd: 0,
    });
    assert.equal(errorResult.status, "error");
  });
});
