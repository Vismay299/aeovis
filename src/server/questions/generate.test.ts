import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { generateQuestions } from "./generate.ts";
import { AppError } from "../../shared/http/appError.ts";
import type { Workspace } from "../workspace/requireWorkspace.ts";
import { estimateQuestionsGenerate } from "../../shared/pricing/actions/questions.ts";
import { estimateQuestionLlmUsd, QUESTIONS_LLM_BOUNDS } from "./setup/prompts.ts";

describe("generateQuestions (F08-AC-17)", () => {
  const mockAdmin: any = {};
  const dummyWorkspace: Workspace = {
    brandKey: "offcult.in",
    user: { id: "00000000-0000-0000-0000-000000000001", email: "user@example.com" },
    role: "owner",
    admin: mockAdmin,
    brand: {
      display_name: "Offcult",
      website: "https://offcult.in",
      website_host: "offcult.in",
      aliases: ["Offcult"],
      brandKey: "offcult.in",
      role: "owner",
      is_active: true,
    },
  };

  it("generates 5 distinct questions for a requested topic", async () => {
    const mockDeps = {
      listWorkspaceQuestions: async () => [],
      readQuestionSettings: async () => ({
        country: "in",
        language: "en",
      } as any),
      repo: {
        listSections: async () => [
          { key: "business_overview", content: "Offcult streetwear in India" },
        ],
        listCompetitors: async () => [],
      } as any,
      llmObject: async () => ({
        object: {
          name: "Oversized Tees",
          questions: [
            "What is the best oversized t-shirt brand in India?",
            "How do heavy cotton oversized tees fit?",
            "Where to find aesthetic back print tees?",
            "Are streetwear drop-shoulder tees machine washable?",
            "What fabric weight is best for summer oversized tees?",
          ],
        },
      }),
    };

    const res = await generateQuestions(
      mockAdmin,
      dummyWorkspace,
      {
        requestId: "00000000-0000-0000-0000-000000000001",
        topic: "Oversized Tees",
        excludeQuestions: [],
      },
      mockDeps as any,
    );

    assert.strictEqual(res.topic, "Oversized Tees");
    assert.strictEqual(res.questions.length, 5);
  });

  it("fits large context and question history within the input reserved by its quote", async () => {
    const model = "openai/gpt-4o-mini";
    const env = { LLM_HELPER_MODEL: model };
    const quote = await estimateQuestionsGenerate(
      {
        brandKey: "offcult.in",
        admin: {} as any,
        env,
        now: new Date(),
      },
      { topic: "Existing Topic 0" },
      { model },
    );
    const existing = Array.from({ length: 50 }, (_, i) => ({
      id: `q-${i}`,
      text: `Existing question ${i} ${"streetwear ".repeat(120)}`,
      textNormalized: `existing question ${i}`,
      topic: `Existing Topic ${i % 30}`,
      status: "active" as const,
    }));
    let llmInput: any;
    const mockDeps = {
      listWorkspaceQuestions: async () => existing as any,
      readQuestionSettings: async () => ({ country: "in", language: "en" } as any),
      repo: {
        listSections: async () =>
          Array.from({ length: 20 }, (_, i) => ({
            key: `context-${i}`,
            content: `Business context ${i} ${"oversized streetwear ".repeat(300)}`,
          })),
        listCompetitors: async () =>
          Array.from({ length: 50 }, (_, i) => ({
            name: `Competitor ${i} ${"brand ".repeat(20)}`,
            domain: `competitor-${i}.example`,
          })),
      } as any,
      llmObject: async (opts: any) => {
        llmInput = opts;
        return {
          object: {
            name: "Existing Topic 0",
            questions: [
              "Which streetwear brands are popular in India?",
              "Where can I find premium graphic tees?",
              "What brands make heavyweight oversized shirts?",
              "Which labels sell anime inspired streetwear?",
              "What are trusted streetwear shops in India?",
            ],
          },
        };
      },
    };

    const result = await generateQuestions(
      mockAdmin,
      dummyWorkspace,
      {
        requestId: "00000000-0000-0000-0000-000000000099",
        topic: "Existing Topic 0",
        excludeQuestions: Array.from({ length: 10 }, (_, i) => `Excluded ${i} ${"streetwear ".repeat(120)}`),
        maxUsd: quote.totalUsd,
      },
      mockDeps as any,
    );

    assert.equal(result.questions.length, 5);
    assert.ok(
      (llmInput.system + llmInput.prompt).length <= QUESTIONS_LLM_BOUNDS.generate.inputChars,
    );
    assert.equal(llmInput.maxOutputTokens, QUESTIONS_LLM_BOUNDS.generate.outputTokens);
    assert.equal(llmInput.maxUsd, quote.totalUsd);
    assert.ok(
      estimateQuestionLlmUsd(
        model,
        (llmInput.system + llmInput.prompt).length,
        llmInput.maxOutputTokens,
        env,
      ) <= quote.totalUsd,
    );
  });

  it("rejects with question_limit when 100 unarchived questions exist", async () => {
    const mock100 = Array.from({ length: 100 }, (_, i) => ({
      id: `q-${i}`,
      text: `Question ${i}`,
      textNormalized: `question ${i}`,
      topic: "General",
      status: "active" as const,
    }));

    const mockDeps = {
      listWorkspaceQuestions: async () => mock100 as any,
    };

    await assert.rejects(
      async () => {
        await generateQuestions(
          mockAdmin,
          dummyWorkspace,
          {
            requestId: "00000000-0000-0000-0000-000000000001",
            excludeQuestions: [],
          },
          mockDeps as any,
        );
      },
      (err: any) => {
        assert.ok(err instanceof AppError);
        assert.strictEqual(err.code, "question_limit");
        assert.strictEqual(err.status, 409);
        return true;
      },
    );
  });

  it("rejects with topic_limit when 30 topics exist and a new one is requested", async () => {
    const mock30Topics = Array.from({ length: 30 }, (_, i) => ({
      id: `q-${i}`,
      text: `Question in topic ${i}`,
      textNormalized: `question in topic ${i}`,
      topic: `Topic ${i}`,
      status: "active" as const,
    }));

    const mockDeps = {
      listWorkspaceQuestions: async () => mock30Topics as any,
    };

    await assert.rejects(
      async () => {
        await generateQuestions(
          mockAdmin,
          dummyWorkspace,
          {
            requestId: "00000000-0000-0000-0000-000000000001",
            topic: "Brand New Topic 31",
            excludeQuestions: [],
          },
          mockDeps as any,
        );
      },
      (err: any) => {
        assert.ok(err instanceof AppError);
        assert.strictEqual(err.code, "topic_limit");
        assert.strictEqual(err.status, 409);
        return true;
      },
    );
  });

  it("throws no_new_questions when all returned questions duplicate existing ones", async () => {
    const existing = [
      {
        id: "q-1",
        text: "What is the best oversized t-shirt brand in India?",
        textNormalized: "what is the best oversized t-shirt brand in india?",
        topic: "General",
        status: "active" as const,
      },
    ];

    const mockDeps = {
      listWorkspaceQuestions: async () => existing as any,
      readQuestionSettings: async () => ({ country: "in", language: "en" } as any),
      repo: {
        listSections: async () => [],
        listCompetitors: async () => [],
      } as any,
      llmObject: async () => ({
        object: {
          name: "General",
          questions: [
            "What is the best oversized t-shirt brand in India?",
            "What is the best oversized t-shirt brand in India?",
            "What is the best oversized t-shirt brand in India?",
            "What is the best oversized t-shirt brand in India?",
            "What is the best oversized t-shirt brand in India?",
          ],
        },
      }),
    };

    await assert.rejects(
      async () => {
        await generateQuestions(
          mockAdmin,
          dummyWorkspace,
          {
            requestId: "00000000-0000-0000-0000-000000000001",
            topic: "General",
            excludeQuestions: [],
          },
          mockDeps as any,
        );
      },
      (err: any) => {
        assert.ok(err instanceof AppError);
        assert.strictEqual(err.code, "no_new_questions");
        assert.strictEqual(err.status, 422);
        return true;
      },
    );
  });
});
