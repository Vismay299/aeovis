import test from "node:test";
import assert from "node:assert/strict";
import {
  createGenerateQuestionsTool,
  createResearchQuestionsTool,
} from "./questionsResearch.ts";
import type { ToolHandlerContext } from "../types.ts";

function context(): ToolHandlerContext {
  return {
    admin: {} as any,
    brand: {
      brandKey: "brand-a",
      role: "owner",
      display_name: "Acme",
      website: "https://acme.test",
      website_host: "acme.test",
      aliases: [],
      is_active: true,
    },
    userId: "user-a",
    user: { id: "user-a", email: "owner@acme.test" },
    role: "owner",
    requestId: "test",
    source: "test",
  };
}

function isUuid(value: unknown): boolean {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  );
}

test("research_questions refuses without maxUsd before calling F08", async () => {
  let calls = 0;
  const tool = createResearchQuestionsTool({
    researchQuestions: (async () => {
      calls += 1;
      return { keyword: "shoes", questions: [], recent: null, dataset: "us-en" };
    }) as any,
  });

  await assert.rejects(() => tool.handler(context(), { keyword: "shoes" }));
  assert.equal(calls, 0);
});

test("research_questions passes a fresh request id, the keyword and the approved maximum", async () => {
  let received: any;
  const tool = createResearchQuestionsTool({
    researchQuestions: (async (_admin: any, ws: any, input: any) => {
      received = { brandKey: ws.brandKey, input };
      return {
        keyword: input.keyword,
        questions: [{ text: "What are the best running shoes?", variants: [], sources: [], ownDomainCited: false, brandMentioned: false, tracked: false }],
        recent: null,
        dataset: "us-en",
      };
    }) as any,
  });

  const output = (await tool.handler(context(), { keyword: "shoes", maxUsd: 0.4 })) as any;

  assert.equal(received.brandKey, "brand-a");
  assert.equal(received.input.keyword, "shoes");
  assert.equal(received.input.maxUsd, 0.4);
  assert.ok(isUuid(received.input.requestId));
  assert.equal(output.questions[0].text, "What are the best running shoes?");
});

test("generate_questions refuses without maxUsd before calling F08", async () => {
  let calls = 0;
  const tool = createGenerateQuestionsTool({
    generateQuestions: (async () => {
      calls += 1;
      return { topic: "shoes", questions: [] };
    }) as any,
  });

  await assert.rejects(() => tool.handler(context(), {}));
  assert.equal(calls, 0);
});

test("generate_questions passes the topic, exclusions and the approved maximum without saving", async () => {
  let received: any;
  const tool = createGenerateQuestionsTool({
    generateQuestions: (async (_admin: any, ws: any, input: any) => {
      received = { brandKey: ws.brandKey, input };
      return { topic: input.topic ?? "General", questions: ["Which shoes last longest?"] };
    }) as any,
  });

  const output = (await tool.handler(context(), {
    topic: "shoes",
    excludeQuestions: ["What are the best running shoes?"],
    maxUsd: 0.25,
  })) as any;

  assert.equal(received.brandKey, "brand-a");
  assert.equal(received.input.topic, "shoes");
  assert.deepEqual(received.input.excludeQuestions, ["What are the best running shoes?"]);
  assert.equal(received.input.maxUsd, 0.25);
  assert.ok(isUuid(received.input.requestId));
  assert.deepEqual(output, {
    topic: "shoes",
    questions: ["Which shoes last longest?"],
  });
});
