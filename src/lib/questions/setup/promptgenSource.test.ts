import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { promptgenCandidates } from "./promptgenSource.ts";

describe("promptgenSource (P3.T2.S2)", () => {
  it("uses provided siteText without making a second scrape", async () => {
    let scrapeCalled = false;
    const scrapeSpy: any = async () => {
      scrapeCalled = true;
      return {
        content: "Offcult anime oversized streetwear",
        state: "ok",
        source: "provided",
      };
    };

    const mockLlmText: any = async () => ({
      text: JSON.stringify([
        { text: "Where to buy oversized tees in India?", topic: "Oversized Tees", intent_tier: "informational" },
        { text: "Best anime graphic tees online", topic: "Anime Tees", intent_tier: "informational" },
      ]),
    });

    const results = await promptgenCandidates(
      { brandKey: "offcult.in" },
      {
        brand: "Offcult",
        website: "https://offcult.in",
        siteText: "Offcult anime oversized streetwear",
        count: 5,
      },
      {
        scrapeSite: scrapeSpy,
        llmText: mockLlmText,
        fetchPeopleAlsoAsk: async () => [],
        fetchAutocomplete: async () => [],
        metered: async (_opts: any, fn: any) => (await fn()).value,
      },
    );

    assert.equal(scrapeCalled, false);
    assert.ok(results.length >= 2);
    assert.equal(results[0].text, "Where to buy oversized tees in India?");
    assert.equal(results[0].topic, "Oversized Tees");
  });

  it("calls metered PAA per term and drops industry_fallback items", async () => {
    let paaMeterCalls = 0;
    const mockMetered: any = async (opts: any, fn: any) => {
      paaMeterCalls += 1;
      assert.equal(opts.feature, "questions.setup");
      assert.ok(opts.estimateUsd > 0);
      const res = await fn();
      return res.value;
    };

    const mockPaa: any = async () => [
      "Are oversized t-shirts comfortable in summer?",
    ];

    let llmCallCount = 0;
    const mockLlmText: any = async () => {
      llmCallCount += 1;
      // Return 1 prompt so it needs more and triggers realism blend
      return {
        text: JSON.stringify([
          { text: "Heavyweight streetwear brands", topic: "Streetwear", intent_tier: "informational" },
        ]),
      };
    };

    const results = await promptgenCandidates(
      { brandKey: "offcult.in", jobId: "job-123" },
      {
        brand: "Offcult",
        website: "https://offcult.in",
        siteText: "Offcult anime streetwear",
        count: 5,
      },
      {
        llmText: mockLlmText,
        fetchPeopleAlsoAsk: mockPaa,
        fetchAutocomplete: async () => [],
        metered: mockMetered,
      },
    );

    // Assert industry fallback is dropped
    const sources = results.map((r) => r.source);
    assert.equal(sources.includes("industry_fallback"), false);
    assert.ok(paaMeterCalls <= 3, "PAA is capped at three metered terms");
    assert.ok(llmCallCount <= 2, "promptGen is capped at two LLM calls");
  });
});
