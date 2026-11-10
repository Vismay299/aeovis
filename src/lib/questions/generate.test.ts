import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { generateQuestions } from "./generate.ts";
import { AppError } from "../http/appError.ts";
import type { Workspace } from "../workspace/requireWorkspace.ts";

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
