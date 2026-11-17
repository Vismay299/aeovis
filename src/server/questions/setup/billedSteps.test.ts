import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SINGLE_ATTEMPT, LONG_PAID_STEP, READ_STEP, DB_STEP } from "../../jobs/stepConfigs.ts";
import { runQuestionSetup } from "./research.ts";

describe("setup job step configurations and billed guards (F08-AC-13)", () => {
  it("enforces SINGLE_ATTEMPT for metered single-shot steps", () => {
    assert.strictEqual(SINGLE_ATTEMPT.billed, true);
    assert.strictEqual(SINGLE_ATTEMPT.retries, 0);
  });

  it("enforces LONG_PAID_STEP for promptgen", () => {
    assert.strictEqual(LONG_PAID_STEP.billed, true);
    assert.strictEqual(LONG_PAID_STEP.retries, 0);
    assert.ok(LONG_PAID_STEP.timeoutMs >= 200_000);
  });

  it("enforces READ_STEP and DB_STEP are unbilled and can retry", () => {
    assert.strictEqual(READ_STEP.billed, undefined);
    assert.ok(READ_STEP.retries > 0);
    assert.strictEqual(DB_STEP.billed, undefined);
    assert.ok(DB_STEP.retries > 0);
  });

  it("runs every metered fake inside a billed, single-attempt job step", async () => {
    const payload = {
      brandKey: "brand.example",
      approvedMaxUsd: 1,
      requestedBy: "00000000-0000-0000-0000-000000000001",
      website: "https://brand.example",
      ownHost: "brand.example",
      displayName: "Brand",
      market: { country: "in", language: "en" },
    };
    const steps: Array<{ name: string; opts: { billed?: boolean; retries: number } }> = [];
    const meteredSteps: Array<{ name: string; billed?: boolean; retries: number }> = [];
    let activeStep: (typeof steps)[number] | undefined;
    let fetcherCalls = 0;
    let meterCalls = 0;
    const ctx: any = {
      jobId: "00000000-0000-0000-0000-000000000002",
      brandKey: payload.brandKey,
      payload,
      trigger: "manual",
      step: {
        async do(name: string, opts: any, fn: () => Promise<unknown>) {
          const record = { name, opts };
          steps.push(record);
          activeStep = record;
          try {
            return await fn();
          } finally {
            activeStep = undefined;
          }
        },
        async sleep() {},
      },
      async progress() {},
    };
    const metered = async (_input: unknown, call: () => Promise<unknown>) => {
      assert.ok(activeStep, "metered call must run inside step.do");
      meteredSteps.push({
        name: activeStep.name,
        billed: activeStep.opts.billed,
        retries: activeStep.opts.retries,
      });
      meterCalls += 1;
      return call();
    };
    const questions = [
      "Where can I buy a heavyweight cotton t-shirt?",
      "What makes an oversized tee comfortable?",
      "How should I wash a printed t-shirt?",
      "Which t-shirt fit works for warm weather?",
      "How do I choose a durable graphic tee?",
    ];
    const mockAdmin: any = {
      from() {
        const chain: any = {
          eq() { return chain; },
          order() { return chain; },
          then(resolve: (value: unknown) => unknown) {
            return Promise.resolve({ data: [], error: null }).then(resolve);
          },
        };
        return { select() { return chain; } };
      },
    };

    await runQuestionSetup(ctx, {
      admin: mockAdmin,
      repo: {
        listSections: async () => [{ key: "business_overview", content: "Saved overview." }],
        listCompetitors: async () => [{ name: "Rival", domain: "rival.example" }],
      } as any,
      appendResearch: async () => {},
      env: { QUESTION_SETUP_PROMPTGEN: "off" },
      model: "openai/gpt-4o-mini",
      metered: metered as any,
      llmObject: async (options: any) => {
        assert.ok(activeStep, "LLM adapter must run inside step.do");
        assert.ok(options.idempotencyKey);
        const object = await metered(
          { feature: options.feature, maxUsd: options.maxUsd },
          async () => {
            fetcherCalls += 1;
            return {
              object: {
                topics: Array.from({ length: 5 }, (_, index) => ({
                  name: `Topic ${index + 1}`,
                  questions,
                })),
                suggestedKeywords: [],
                persona: "Online apparel shoppers.",
              },
            };
          },
        );
        return object;
      },
    } as any);

    assert.ok(meterCalls > 0);
    assert.equal(fetcherCalls, meterCalls, "every fake provider fetch must pass through metered");
    assert.ok(meteredSteps.every((step) => step.billed === true && step.retries === 0));
    assert.ok(steps.some((step) => step.name === "draft" && step.opts.billed === true));
  });
});
