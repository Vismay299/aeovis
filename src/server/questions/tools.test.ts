import test from "node:test";
import assert from "node:assert/strict";
import {
  listQuestionsTool,
  addQuestionsTool,
  type QuestionToolContext,
} from "./tools.ts";
import type { WorkspaceQuestion, QuestionSettings } from "./workspaceQuestions.ts";

function makeQuestion(overrides: Partial<WorkspaceQuestion> = {}): WorkspaceQuestion {
  return {
    id: "q-1",
    brandKey: "test.com",
    text: "Which running shoes are best for marathons?",
    textNormalized: "which running shoes are best for marathons?",
    topic: "Shoes",
    origin: "manual",
    status: "active",
    branded: false,
    cohort: "core",
    replacedBy: null,
    duplicateReason: null,
    sourceRef: null,
    createdBy: "user-1",
    createdAt: "2026-10-21T10:00:00.000Z",
    updatedAt: "2026-10-21T10:00:00.000Z",
    archivedAt: null,
    ...overrides,
  };
}

test("list_questions tool filters by status and returns approvedVersion and dirty", async () => {
  const qActive = makeQuestion({ id: "q-1", status: "active" });
  const qPaused = makeQuestion({ id: "q-2", status: "paused", text: "Paused question text" });
  const qArchived = makeQuestion({ id: "q-3", status: "archived", text: "Archived question text" });

  const ctx: QuestionToolContext = {
    admin: {} as any,
    brand: { brandKey: "test.com" },
    userId: "user-1",
    deps: {
      listWorkspaceQuestions: async () => [qActive, qPaused, qArchived],
      readQuestionSettings: async () => ({
        brandKey: "test.com",
        revision: 1,
        persona: "Runners",
        country: "in",
        language: "en",
        researchKeywords: [],
        setupJobId: null,
        setupSavedJobId: null,
        setupSavedAt: null,
        backfilledAt: null,
      }),
      repairWorkflowStore: (() => ({
        list: async () => [
          {
            artifact_key: "default",
            version: 3,
            state: "approved",
            payload: {
              persona: "Runners",
              prompts: [{ text: "Which running shoes are best for marathons?" }],
            },
          },
        ],
      })) as any,
    },
  };

  // Default input: status "active"
  const defaultRes = await listQuestionsTool.handler(ctx, {});
  assert.equal(defaultRes.questions.length, 1);
  assert.equal(defaultRes.questions[0].id, "q-1");
  assert.equal(defaultRes.approvedVersion, 3);
  assert.equal(defaultRes.dirty, false);

  // Status "all"
  const allRes = await listQuestionsTool.handler(ctx, { status: "all" });
  assert.equal(allRes.questions.length, 3);

  // Status "archived"
  const archivedRes = await listQuestionsTool.handler(ctx, { status: "archived" });
  assert.equal(archivedRes.questions.length, 1);
  assert.equal(archivedRes.questions[0].id, "q-3");
});

test("add_questions tool adds questions with origin ai_generate and counts added, revived, skipped", async () => {
  const addedCalls: any[] = [];
  const ctx: QuestionToolContext = {
    admin: {} as any,
    brand: { brandKey: "test.com" },
    userId: "user-1",
    deps: {
      addWorkspaceQuestion: async (_admin, input) => {
        addedCalls.push(input);
        if (input.text.includes("new")) {
          return { question: makeQuestion({ text: input.text }), created: true, revived: false };
        }
        if (input.text.includes("revive")) {
          return { question: makeQuestion({ text: input.text }), created: false, revived: true };
        }
        return { question: makeQuestion({ text: input.text }), created: false, revived: false };
      },
    },
  };

  const res = await addQuestionsTool.handler(ctx, {
    questions: [
      { text: "Which new running shoes exist in India?", topic: "Shoes" },
      { text: "Where to revive running gear?", topic: "Gear" },
      { text: "Existing running questions to skip", topic: "General" },
    ],
  });

  assert.equal(res.added, 1);
  assert.equal(res.revived, 1);
  assert.equal(res.skipped, 1);
  assert.equal(addedCalls.length, 3);
  assert.ok(addedCalls.every((c) => c.origin === "ai_generate"));
});

test("add_questions rejects questions with invalid length", async () => {
  const ctx: QuestionToolContext = {
    admin: {} as any,
    brand: { brandKey: "test.com" },
    userId: "user-1",
  };

  await assert.rejects(
    async () => addQuestionsTool.handler(ctx, { questions: [{ text: "Short" }] }),
    /too_small/
  );
});
