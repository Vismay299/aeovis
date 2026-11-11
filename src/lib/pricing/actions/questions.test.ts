import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  estimateQuestionsSetup,
  estimateQuestionsGenerate,
  estimateQuestionsResearch,
  questionsSetupAction,
  questionsGenerateAction,
  questionsResearchAction,
  FREE_READS_FIRST_WARNING,
  CACHE_NOTE_WARNING,
} from "./questions.ts";
import type { PricingContext } from "../pricedActions.ts";
import { estimateQuestionLlmUsd, QUESTIONS_LLM_BOUNDS } from "../../questions/setup/prompts.ts";
import { serpQueryUsd } from "../perceev.ts";

function fakeContext(overrides?: Partial<PricingContext>): PricingContext {
  return {
    brandKey: "test.example",
    admin: {} as any,
    env: {
      ENGINES: "aio",
      LLM_HELPER_MODEL: "google/gemma-4-31b-it:free",
    },
    now: new Date("2026-11-10T12:00:00Z"),
    ...overrides,
  };
}

describe("questions priced actions (F08-AC-11)", () => {
  it("quotes setup with all lines when overview and competitors are missing", async () => {
    const ctx = fakeContext();
    const result = await estimateQuestionsSetup(ctx, {}, {
      checkOverviewMissing: async () => true,
      checkCompetitorsMissing: async () => true,
      checkSetupRunning: async () => false,
      countUnarchivedQuestions: async () => 10,
    });

    assert.equal(result.blocked, null);
    assert.deepEqual(result.warnings, [{ ...FREE_READS_FIRST_WARNING }]);

    const labels = result.lines.map((l) => l.label);
    assert.ok(labels.includes("Website pages read with a browser service"));
    assert.ok(labels.includes("Search results for competitors"));
    assert.ok(labels.includes("Competitor pages read with a browser service"));
    assert.ok(labels.includes("AI drafting"));
    assert.ok(labels.includes("Search-grounded questions"));

    const websiteLine = result.lines.find((l) => l.label === "Website pages read with a browser service");
    assert.equal(websiteLine?.quantity, 3);
    assert.equal(websiteLine?.totalUsd, 3 * 0.005);

    const serpLine = result.lines.find((l) => l.label === "Search results for competitors");
    assert.equal(serpLine?.quantity, 2);

    const compScrapeLine = result.lines.find((l) => l.label === "Competitor pages read with a browser service");
    assert.equal(compScrapeLine?.quantity, 10);
    assert.equal(compScrapeLine?.totalUsd, 10 * 0.005);

    assert.ok(result.totalUsd > 0);
  });

  it("omits website scrape lines when overview is present", async () => {
    const ctx = fakeContext();
    const result = await estimateQuestionsSetup(ctx, {}, {
      checkOverviewMissing: async () => false,
      checkCompetitorsMissing: async () => true,
      checkSetupRunning: async () => false,
      countUnarchivedQuestions: async () => 0,
    });

    const labels = result.lines.map((l) => l.label);
    assert.equal(labels.includes("Website pages read with a browser service"), false);
    assert.ok(labels.includes("Search results for competitors"));
    assert.ok(labels.includes("Competitor pages read with a browser service"));
  });

  it("omits competitor lines when competitors are already present", async () => {
    const ctx = fakeContext();
    const result = await estimateQuestionsSetup(ctx, {}, {
      checkOverviewMissing: async () => true,
      checkCompetitorsMissing: async () => false,
      checkSetupRunning: async () => false,
      countUnarchivedQuestions: async () => 0,
    });

    const labels = result.lines.map((l) => l.label);
    assert.ok(labels.includes("Website pages read with a browser service"));
    assert.equal(labels.includes("Search results for competitors"), false);
    assert.equal(labels.includes("Competitor pages read with a browser service"), false);
  });

  it("omits both site and competitor lines when both are present", async () => {
    const ctx = fakeContext();
    const result = await estimateQuestionsSetup(ctx, {}, {
      checkOverviewMissing: async () => false,
      checkCompetitorsMissing: async () => false,
      checkSetupRunning: async () => false,
      countUnarchivedQuestions: async () => 0,
    });

    const labels = result.lines.map((l) => l.label);
    assert.equal(labels.includes("Website pages read with a browser service"), false);
    assert.equal(labels.includes("Search results for competitors"), false);
    assert.equal(labels.includes("Competitor pages read with a browser service"), false);
    assert.ok(labels.includes("AI drafting"));
    assert.ok(labels.includes("Search-grounded questions"));
  });

  it("blocks setup when setup is already running", async () => {
    const ctx = fakeContext();
    const result = await estimateQuestionsSetup(ctx, {}, {
      checkOverviewMissing: async () => true,
      checkCompetitorsMissing: async () => true,
      checkSetupRunning: async () => true,
      countUnarchivedQuestions: async () => 5,
    });

    assert.deepEqual(result.blocked, {
      code: "setup_running",
      message: "Setup is already running.",
    });
  });

  it("blocks setup when question limit (100) is reached", async () => {
    const ctx = fakeContext();
    const result = await estimateQuestionsSetup(ctx, {}, {
      checkOverviewMissing: async () => true,
      checkCompetitorsMissing: async () => true,
      checkSetupRunning: async () => false,
      countUnarchivedQuestions: async () => 100,
    });

    assert.deepEqual(result.blocked, {
      code: "question_limit",
      message: "You can track up to 100 questions. Archive unused questions first.",
    });
  });

  it("reflects FIRECRAWL_SCRAPE_USD env override", async () => {
    const ctx = fakeContext({
      env: {
        FIRECRAWL_SCRAPE_USD: "0.02",
        LLM_HELPER_MODEL: "google/gemma-4-31b-it:free",
      },
    });
    const result = await estimateQuestionsSetup(ctx, {}, {
      checkOverviewMissing: async () => true,
      checkCompetitorsMissing: async () => true,
      checkSetupRunning: async () => false,
      countUnarchivedQuestions: async () => 0,
    });

    const websiteLine = result.lines.find((l) => l.label === "Website pages read with a browser service");
    assert.equal(websiteLine?.unitUsd, 0.02);
    assert.equal(websiteLine?.totalUsd, 0.06);
  });

  it("quotes questions.generate.run", async () => {
    const ctx = fakeContext();
    const result = await estimateQuestionsGenerate(ctx, { topic: "Test Topic" });
    assert.equal(result.lines.length, 1);
    assert.equal(result.lines[0].label, "AI drafting");
    assert.equal(result.totalUsd, result.expectedUsd);
    assert.equal(result.blocked, null);
    assert.deepEqual(result.warnings, []);
  });

  it("quotes the enforced maximum input and output for setup and Generate", async () => {
    const model = "openai/gpt-4o-mini";
    const ctx = fakeContext({ env: { LLM_HELPER_MODEL: model, QUESTION_SETUP_PROMPTGEN: "on" } });
    const setup = await estimateQuestionsSetup(ctx, {}, {
      checkOverviewMissing: async () => true,
      checkCompetitorsMissing: async () => true,
      checkSetupRunning: async () => false,
      countUnarchivedQuestions: async () => 0,
      model,
    });
    const setupAi = setup.lines.find((line) => line.label === "AI drafting");
    const setupExpected =
      estimateQuestionLlmUsd(model, QUESTIONS_LLM_BOUNDS.setupDraft.inputChars, QUESTIONS_LLM_BOUNDS.setupDraft.outputTokens, ctx.env) +
      estimateQuestionLlmUsd(model, QUESTIONS_LLM_BOUNDS.setupPick.inputChars, QUESTIONS_LLM_BOUNDS.setupPick.outputTokens, ctx.env) +
      estimateQuestionLlmUsd(model, QUESTIONS_LLM_BOUNDS.setupVerify.inputChars, QUESTIONS_LLM_BOUNDS.setupVerify.outputTokens, ctx.env);
    assert.equal(setupAi?.totalUsd, Math.round(setupExpected * 1_000_000) / 1_000_000);

    const promptgen = setup.lines.find((line) => line.label === "Search-grounded questions");
    assert.ok(promptgen);
    assert.equal(
      promptgen.totalUsd,
      Math.round(
        (3 * serpQueryUsd("brightdata", 1, ctx.env) +
          2 * estimateQuestionLlmUsd(
            model,
            QUESTIONS_LLM_BOUNDS.promptgen.inputChars,
            QUESTIONS_LLM_BOUNDS.promptgen.outputTokens,
            ctx.env,
          )) *
          1_000_000,
      ) / 1_000_000,
    );

    const generate = await estimateQuestionsGenerate(ctx, { topic: "Streetwear" }, { model });
    assert.equal(
      generate.totalUsd,
      estimateQuestionLlmUsd(
        model,
        QUESTIONS_LLM_BOUNDS.generate.inputChars,
        QUESTIONS_LLM_BOUNDS.generate.outputTokens,
        ctx.env,
      ),
    );
  });

  it("quotes questions.research.run with dataset and relevance lines", async () => {
    const ctx = fakeContext();
    const result = await estimateQuestionsResearch(ctx, { keyword: "t-shirts" });
    assert.equal(result.lines.length, 2);
    assert.equal(result.lines[0].label, "Question dataset search");
    assert.equal(result.lines[1].label, "Relevance check");
    assert.equal(result.lines[0].totalUsd, 0.2); // 0.1 + 100 * 0.001
    assert.equal(result.totalUsd, result.expectedUsd);
    assert.deepEqual(result.warnings, [{ ...CACHE_NOTE_WARNING }]);
  });

  it("registers actions with correct properties", () => {
    assert.equal(questionsSetupAction.key, "questions.setup.run");
    assert.equal(questionsSetupAction.feature, "questions.setup");
    assert.equal(questionsSetupAction.requireApproval, true);

    assert.equal(questionsGenerateAction.key, "questions.generate.run");
    assert.equal(questionsGenerateAction.feature, "questions.generate");
    assert.equal(questionsGenerateAction.requireApproval, false);

    assert.equal(questionsResearchAction.key, "questions.research.run");
    assert.equal(questionsResearchAction.feature, "questions.research");
    assert.equal(questionsResearchAction.requireApproval, false);
  });
});
