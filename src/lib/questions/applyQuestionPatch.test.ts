// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/features/ai-visibility/services/aiVisibilityConfiguration.test.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.
import test from "node:test";
import assert from "node:assert/strict";
import { AppError } from "../http/appError.ts";
import type { WorkspaceQuestion } from "./workspaceQuestions.ts";
import { projectQuestionPatch } from "./applyQuestionPatch.ts";

const at = "2026-11-01T00:00:00.000Z";
const question = (
  id: string,
  text: string,
  options: Partial<WorkspaceQuestion> = {},
): WorkspaceQuestion => ({
  id,
  brandKey: "workspace-a",
  text,
  textNormalized: text.toLowerCase(),
  topic: "General",
  origin: "manual",
  status: "active",
  branded: false,
  cohort: "core",
  replacedBy: null,
  duplicateReason: null,
  sourceRef: null,
  createdBy: null,
  createdAt: at,
  updatedAt: at,
  archivedAt: null,
  ...options,
});
const opts = (id = "new-id") => ({ origin: "manual" as const, aliases: [], newId: () => id });

test("new wording archives the old question, links it to the replacement, and adds an immutable row", () => {
  const before = question("q1", "Which accounting tools suit small teams?");
  const result = projectQuestionPatch(
    [before],
    { questions: [{ id: before.id, text: "Which accounting platforms suit small teams?" }] },
    opts("q2"),
  );
  assert.deepEqual(result.rows, [
    { op: "update", id: "q1", status: "archived", replaced_by: "q2" },
    {
      op: "insert",
      id: "q2",
      text: "Which accounting platforms suit small teams?",
      topic: "General",
      origin: "manual",
      status: "active",
      branded: false,
      source_ref: null,
    },
  ]);
  assert.deepEqual(result.events.map(({ question_id, event }) => [question_id, event]), [
    ["q1", "archived"],
    ["q1", "replaced"],
    ["q2", "created"],
  ]);
  assert.equal(before.status, "active", "projection must not mutate input rows");
  assert.equal(result.created, 1);
  assert.equal(result.updated, 1);
});

test("same wording moves or pauses in place and preserves the stored text", () => {
  const before = question("q1", "Which accounting tools suit small teams?");
  const result = projectQuestionPatch(
    [before],
    { questions: [{ id: before.id, text: before.text, topic: "Accounting", paused: true }] },
    opts(),
  );
  assert.deepEqual(result.rows, [
    { op: "update", id: "q1", topic: "Accounting", status: "paused" },
  ]);
  assert.deepEqual(result.events.map((item) => item.event), ["topic_changed", "paused"]);
});

test("re-adding archived wording revives the same identity and history", () => {
  const archived = question("q-archived", "Where can I compare accounting tools?", {
    status: "archived",
    archivedAt: at,
  });
  const result = projectQuestionPatch(
    [archived],
    { questions: [{ text: "  Where can I compare accounting   tools? " }] },
    opts("unused-id"),
  );
  assert.deepEqual(result.rows, [
    { op: "update", id: "q-archived", status: "active" },
  ]);
  assert.equal(result.rows.some((row) => row.op === "insert"), false);
  assert.deepEqual(result.events.map((item) => [item.question_id, item.event]), [
    ["q-archived", "revived"],
  ]);
});

test("new duplicates are skipped but editing into another active wording is refused", () => {
  const first = question("q1", "Which accounting tools suit small teams?");
  const second = question("q2", "How do small teams handle annual invoicing?");
  const skipped = projectQuestionPatch(
    [first, second],
    { questions: [{ text: " WHICH  ACCOUNTING TOOLS SUIT SMALL TEAMS? " }] },
    opts(),
  );
  assert.equal(skipped.skipped, 1);
  assert.deepEqual(skipped.rows, []);

  assert.throws(
    () => projectQuestionPatch(
      [first, second],
      { questions: [{ id: second.id, text: first.text }] },
      opts(),
    ),
    (error: unknown) => error instanceof AppError && error.code === "question_duplicate" && error.status === 409,
  );
});

test("unknown ids and repeated edits have stable refusals", () => {
  const first = question("q1", "Which accounting tools suit small teams?");
  assert.throws(
    () => projectQuestionPatch([first], { questions: [{ id: "missing", text: first.text }] }, opts()),
    (error: unknown) => error instanceof AppError && error.code === "question_unknown" && error.status === 400,
  );
  assert.throws(
    () => projectQuestionPatch(
      [first],
      { questions: [{ id: first.id, text: first.text }, { id: first.id, text: first.text }] },
      opts(),
    ),
    (error: unknown) => error instanceof AppError && error.code === "duplicate_edit" && error.status === 400,
  );
});

test("case and whitespace only edits do not change text, state, rows, or events", () => {
  const first = question("q1", "Which accounting tools suit small teams?");
  const result = projectQuestionPatch(
    [first],
    { questions: [{ id: first.id, text: " WHICH  accounting tools suit small teams? " }] },
    opts(),
  );
  assert.deepEqual(result.rows, []);
  assert.deepEqual(result.events, []);
  assert.equal(result.updated, 0);
});

test("non-branded short wording is rejected with question_invalid", () => {
  assert.throws(
    () => projectQuestionPatch([], { questions: [{ text: "Why?" }] }, opts()),
    (error: unknown) => error instanceof AppError && error.code === "question_invalid" && error.status === 400,
  );
});

test("question and topic caps prevent growth while archived capacity can be reused", () => {
  const full = Array.from({ length: 100 }, (_, index) =>
    question(`q${index}`, `Question ${index} about this useful accounting product?`, {
      topic: `Topic ${index % 30}`,
    }),
  );
  assert.throws(
    () => projectQuestionPatch(full, { questions: [{ text: "A new useful accounting question for teams?", topic: "Topic 1" }] }, opts()),
    (error: unknown) => error instanceof AppError && error.code === "question_limit" && error.status === 409,
  );

  const topics = Array.from({ length: 30 }, (_, index) =>
    question(`t${index}`, `Question ${index} about an accounting service?`, { topic: `Topic ${index}` }),
  );
  assert.throws(
    () => projectQuestionPatch(topics, { questions: [{ text: "A new accounting question about services?", topic: "New topic" }] }, opts()),
    (error: unknown) => error instanceof AppError && error.code === "topic_limit" && error.status === 409,
  );

  const reused = projectQuestionPatch(
    full,
    {
      archiveIds: [full[0].id],
      questions: [{ text: "A replacement accounting question for small teams?", topic: "Topic 1" }],
    },
    opts("replacement"),
  );
  assert.equal(reused.rows.filter((row) => row.op === "insert").length, 1);
  assert.equal(reused.rows.find((row) => row.id === full[0].id)?.op, "update");
  assert.equal(reused.created, 1);
});

test("archive, topic, duplicate-reason, and revival edits produce explicit events", () => {
  const first = question("q1", "Which accounting tools suit small teams?");
  const second = question("q2", "How do small teams handle annual invoicing?", {
    status: "archived",
    archivedAt: at,
  });
  const result = projectQuestionPatch(
    [first, second],
    {
      archiveIds: [first.id],
      reviveIds: [second.id],
      setTopic: { ids: [second.id], topic: "Accounting" },
      duplicateReasons: [{ id: first.id, reason: "Different buyer intents." }],
    },
    opts(),
  );
  assert.deepEqual(result.rows, [
    { op: "update", id: "q1", status: "archived", duplicate_reason: "Different buyer intents." },
    { op: "update", id: "q2", status: "active", topic: "Accounting" },
  ]);
  assert.deepEqual(result.events.map((item) => item.event), [
    "archived",
    "revived",
    "topic_changed",
    "duplicate_reason",
  ]);
});
