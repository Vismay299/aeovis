import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { promptgenCandidates } from "./promptgenSource.ts";
import { estimateQuestionLlmUsd, QUESTIONS_LLM_BOUNDS } from "./prompts.ts";
import { AppError } from "../../../shared/http/appError.ts";
import { SpendRefused, UnbilledCallError } from "../../../shared/spend/errors.ts";

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

  it("caps promptGen LLM input/output and decrements its remaining aggregate approval", async () => {
    const llmCalls: any[] = [];
    const llmCharges: number[] = [];
    const meterCalls: any[] = [];
    const queries = Array.from(
      { length: 30 },
      (_, i) => `best streetwear brands ${i} ${"streetwear " .repeat(100)} in India`,
    );
    const results = await promptgenCandidates(
      {
        brandKey: "offcult.in",
        jobId: "job-123",
        maxUsd: 0.5,
        model: "openai/gpt-4o-mini",
        onLlmSpend: (usd) => llmCharges.push(usd),
      },
      {
        brand: "Offcult",
        website: "https://offcult.in",
        siteText: `Title\n${"Offcult oversized streetwear ".repeat(500)}`,
        count: 5,
      },
      {
        env: { LLM_HELPER_MODEL: "openai/gpt-4o-mini" },
        fetchPeopleAlsoAsk: async () => queries,
        fetchAutocomplete: async () => [],
        metered: async (opts: any, call: any) => {
          meterCalls.push(opts);
          return (await call()).value;
        },
        llmText: async (opts: any) => {
          llmCalls.push(opts);
          const items = llmCalls.length === 1
            ? [{ text: "best streetwear brands in India", topic: "Streetwear" }]
            : [
                { text: "top streetwear brands in India", topic: "Streetwear" },
                { text: "trusted streetwear brands in India", topic: "Streetwear" },
                { text: "streetwear brands for college students", topic: "College" },
                { text: "best graphic tee brands in India", topic: "Graphic tees" },
              ];
          return { text: JSON.stringify(items), usd: llmCalls.length / 100 };
        },
      } as any,
    );

    assert.equal(results.length, 5);
    assert.equal(llmCalls.length, 2);
    for (const call of llmCalls) {
      assert.ok((call.system + call.prompt).length <= QUESTIONS_LLM_BOUNDS.promptgen.inputChars);
      assert.equal(call.maxOutputTokens, QUESTIONS_LLM_BOUNDS.promptgen.outputTokens);
    }
    assert.ok(meterCalls.length > 0);
    assert.ok(llmCalls[1].maxUsd < llmCalls[0].maxUsd);
    assert.deepEqual(llmCharges, [0.01, 0.02]);
  });

  it("accounts estimates for settled helper failures but excludes unbilled and pre-reservation refusals", async () => {
    const model = "openai/gpt-4o-mini";
    const env = { LLM_HELPER_MODEL: model };
    const ctx = {
      brandKey: "offcult.in",
      maxUsd: 0.5,
      model,
    };
    const input = {
      brand: "Offcult",
      website: "https://offcult.in",
      siteText: "Offcult oversized streetwear",
      count: 5,
    };
    const invoke = async (failure: Error) => {
      const charges: number[] = [];
      let llmOptions: any;
      await assert.rejects(
        promptgenCandidates(
          { ...ctx, onLlmSpend: (usd) => charges.push(usd) },
          input,
          {
            env,
            fetchPeopleAlsoAsk: async () => [],
            fetchAutocomplete: async () => [],
            metered: async (_opts: any, call: any) => (await call()).value,
            llmText: async (opts: any) => {
              llmOptions = opts;
              throw failure;
            },
          } as any,
        ),
        (error: unknown) => error === failure,
      );
      const estimateUsd = estimateQuestionLlmUsd(
        model,
        (llmOptions.system + llmOptions.prompt).length,
        llmOptions.maxOutputTokens,
        env,
      );
      return { charges, estimateUsd };
    };

    for (const failure of [
      Object.assign(new Error("provider outcome unknown"), { name: "AmbiguousCallError" }),
      new Error("provider transport failed after reservation"),
    ]) {
      const { charges, estimateUsd } = await invoke(failure);
      assert.deepEqual(charges, [estimateUsd]);
    }

    for (const failure of [
      new UnbilledCallError("gateway refused the request"),
      new SpendRefused("daily_cap"),
      new AppError(503, "llm_not_configured", "LLM is not configured."),
      new AppError(500, "spend_config_invalid", "Spend control config is invalid."),
    ]) {
      const { charges } = await invoke(failure);
      assert.deepEqual(charges, []);
    }
  });
});
