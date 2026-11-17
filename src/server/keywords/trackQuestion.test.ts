import test from "node:test";
import assert from "node:assert/strict";
import type { SupabaseClient } from "@supabase/supabase-js";
import { trackKeywordAsQuestion } from "./trackQuestion.ts";
import { AppError } from "../../shared/http/appError.ts";
import type { addWorkspaceQuestion } from "../questions/workspaceQuestions.ts";

const BASE = {
  brandKey: "test-brand",
  userId: "user-1",
  keyword: "oversized t shirt",
  text: "Which brands make the best oversized t-shirts in India?",
  locationCode: 2356,
  languageCode: "en",
};

const fakeAdmin = {} as unknown as SupabaseClient;

function fakeQuestion(overrides: Record<string, unknown> = {}) {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    brandKey: BASE.brandKey,
    text: BASE.text,
    textNormalized: BASE.text.toLowerCase(),
    topic: "General",
    origin: "manual",
    status: "active",
    branded: false,
    cohort: "core",
    replacedBy: null,
    duplicateReason: null,
    sourceRef: {
      kind: "keyword",
      keyword: BASE.keyword,
      locationCode: BASE.locationCode,
      languageCode: BASE.languageCode,
    },
    createdBy: BASE.userId,
    createdAt: "2026-11-10T12:00:00.000Z",
    updatedAt: "2026-11-10T12:00:00.000Z",
    archivedAt: null,
    ...overrides,
  };
}

type AddFn = typeof addWorkspaceQuestion;

test("trackKeywordAsQuestion calls add with origin manual and keyword sourceRef", async () => {
  const seen: Parameters<AddFn>[1][] = [];
  const add: AddFn = (async (admin: SupabaseClient, input: Parameters<AddFn>[1]) => {
    seen.push(input);
    return { question: fakeQuestion(), created: true, revived: false };
  }) as unknown as AddFn;
  const result = await trackKeywordAsQuestion(fakeAdmin, BASE, { add });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].brandKey, "test-brand");
  assert.equal(seen[0].text, BASE.text);
  assert.equal(seen[0].origin, "manual");
  assert.equal(seen[0].createdBy, "user-1");
  assert.equal(seen[0].topic, undefined);
  assert.deepEqual(seen[0].sourceRef, {
    kind: "keyword",
    keyword: "oversized t shirt",
    locationCode: 2356,
    languageCode: "en",
  });
  assert.equal(result.created, true);
  assert.equal(result.revived, false);
  assert.equal(result.question.id, "11111111-1111-4111-8111-111111111111");
});

test("trackKeywordAsQuestion forwards topic and passes through created/revived", async () => {
  const seen: Parameters<AddFn>[1][] = [];
  const addTopic: AddFn = (async (admin: SupabaseClient, input: Parameters<AddFn>[1]) => {
    seen.push(input);
    return { question: fakeQuestion({ topic: "Tees" }), created: false, revived: true };
  }) as unknown as AddFn;
  const revived = await trackKeywordAsQuestion(fakeAdmin, { ...BASE, topic: "Tees" }, { add: addTopic });
  assert.equal(seen[0].topic, "Tees");
  assert.equal(revived.created, false);
  assert.equal(revived.revived, true);
});

test("trackKeywordAsQuestion passes question_limit through with no partial write", async () => {
  let writes = 0;
  const add: AddFn = (async () => {
    writes += 1;
    throw new AppError(409, "question_limit", "You can track up to 100 questions. Archive unused questions first.");
  }) as unknown as AddFn;
  await assert.rejects(
    trackKeywordAsQuestion(fakeAdmin, BASE, { add }),
    (err: unknown) => err instanceof AppError && err.code === "question_limit",
  );
  assert.equal(writes, 1);
});

test("trackKeywordAsQuestion passes topic_limit through", async () => {
  const add: AddFn = (async () => {
    throw new AppError(409, "topic_limit", "You can use up to 30 topics. Archive the questions of an unused topic first.");
  }) as unknown as AddFn;
  await assert.rejects(
    trackKeywordAsQuestion(fakeAdmin, BASE, { add }),
    (err: unknown) => err instanceof AppError && err.code === "topic_limit",
  );
});
