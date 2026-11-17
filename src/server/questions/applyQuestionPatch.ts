// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/features/ai-visibility/services/aiVisibilityConfiguration.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { AppError } from "../../shared/http/appError.ts";
import {
  DEFAULT_TOPIC,
  canonicalQuestionText,
  isBrandedQuestion,
  normalizeQuestionText,
  type QuestionOrigin,
  type QuestionStatus,
  type WorkspaceQuestion,
} from "./workspaceQuestions.ts";

export const questionPatchSchema = z.strictObject({
  questions: z
    .array(
      z.strictObject({
        id: z.uuid().optional(),
        text: z.string().min(1).max(1500),
        topic: z.string().trim().min(1).max(120).optional(),
        paused: z.boolean().optional(),
      }),
    )
    .max(100)
    .optional(),
  archiveIds: z.array(z.uuid()).max(100).optional(),
  reviveIds: z.array(z.uuid()).max(100).optional(),
  setTopic: z
    .strictObject({
      ids: z.array(z.uuid()).min(1).max(100),
      topic: z.string().trim().min(1).max(120),
    })
    .optional(),
  duplicateReasons: z
    .array(
      z.strictObject({
        id: z.uuid(),
        reason: z.string().trim().min(1).max(300).nullable(),
      }),
    )
    .max(100)
    .optional(),
});

export type QuestionPatch = z.infer<typeof questionPatchSchema>;

export type ResolvedQuestionRow =
  | {
      op: "insert";
      id: string;
      text: string;
      topic: string;
      origin: QuestionOrigin;
      status: "active" | "paused";
      branded: boolean;
      source_ref: Record<string, unknown> | null;
    }
  | {
      op: "update";
      id: string;
      topic?: string;
      status?: QuestionStatus;
      branded?: boolean;
      replaced_by?: string | null;
      duplicate_reason?: string | null;
    };

export type QuestionEvent = {
  question_id: string;
  event:
    | "created"
    | "revived"
    | "archived"
    | "paused"
    | "resumed"
    | "topic_changed"
    | "replaced"
    | "duplicate_reason"
    | "approved";
  detail?: Record<string, unknown>;
};

export function projectQuestionPatch(
  current: WorkspaceQuestion[],
  patch: QuestionPatch,
  o: {
    origin: QuestionOrigin;
    aliases: string[];
    newId?: () => string;
    sourceRef?: Record<string, unknown> | null;
  },
): {
  rows: ResolvedQuestionRow[];
  events: QuestionEvent[];
  created: number;
  updated: number;
  skipped: number;
} {
  const initial = current.map((question) => ({ ...question }));
  const working = initial.map((question) => ({ ...question }));
  const initialById = new Map(initial.map((question) => [question.id, question]));
  const inserts = new Map<string, Extract<ResolvedQuestionRow, { op: "insert" }>>();
  const updates = new Map<string, Extract<ResolvedQuestionRow, { op: "update" }>>();
  const events: QuestionEvent[] = [];
  const touched = new Set<string>();
  let skipped = 0;
  const makeId = o.newId ?? randomUUID;

  const questionAt = (id: string, index?: number): WorkspaceQuestion => {
    const question = working.find((row) => row.id === id);
    if (!question) {
      throw new AppError(
        400,
        "question_unknown",
        "A question id is not part of this workspace. Reload and try again.",
        index === undefined ? undefined : { details: { index } },
      );
    }
    return question;
  };

  const event = (
    questionId: string,
    name: QuestionEvent["event"],
    detail?: Record<string, unknown>,
  ) => events.push({ question_id: questionId, event: name, ...(detail ? { detail } : {}) });

  const write = (question: WorkspaceQuestion) => {
    const insert = inserts.get(question.id);
    if (insert) {
      insert.topic = question.topic;
      insert.status = question.status === "archived" ? "active" : question.status;
      insert.branded = question.branded;
      return;
    }
    const before = initialById.get(question.id);
    if (!before) return;
    const fields: Extract<ResolvedQuestionRow, { op: "update" }> = {
      op: "update",
      id: question.id,
    };
    if (question.topic !== before.topic) fields.topic = question.topic;
    if (question.status !== before.status) fields.status = question.status;
    if (question.branded !== before.branded) fields.branded = question.branded;
    if (question.replacedBy !== before.replacedBy) fields.replaced_by = question.replacedBy;
    if (question.duplicateReason !== before.duplicateReason)
      fields.duplicate_reason = question.duplicateReason;
    if (Object.keys(fields).length === 2) updates.delete(question.id);
    else updates.set(question.id, fields);
  };

  const setStatus = (question: WorkspaceQuestion, status: QuestionStatus) => {
    if (question.status === status) return false;
    const previous = question.status;
    question.status = status;
    question.archivedAt = status === "archived" ? question.archivedAt : null;
    write(question);
    if (status === "archived") event(question.id, "archived");
    else if (status === "paused") event(question.id, "paused");
    else if (previous === "paused") event(question.id, "resumed");
    else event(question.id, "revived");
    return true;
  };

  for (const [index, input] of (patch.questions ?? []).entries()) {
    const existing = input.id ? questionAt(input.id, index) : undefined;
    if (existing && touched.has(existing.id))
      throw new AppError(400, "duplicate_edit", "A question may be edited only once per save.");
    if (existing) touched.add(existing.id);

    const text = canonicalQuestionText(input.text);
    const topic = input.topic ?? existing?.topic ?? DEFAULT_TOPIC;
    const status: QuestionStatus = input.paused === undefined
      ? existing?.status ?? "active"
      : input.paused
        ? "paused"
        : "active";
    const branded = isBrandedQuestion(text, o.aliases);
    if (text.length < (branded ? 2 : 8))
      throw new AppError(400, "question_invalid", "Questions need at least 8 characters.", {
        details: { index },
      });

    if (existing && normalizeQuestionText(existing.text) === normalizeQuestionText(text)) {
      if (existing.topic !== topic) {
        existing.topic = topic;
        write(existing);
        event(existing.id, "topic_changed", { topic });
      }
      if (existing.status !== status) setStatus(existing, status);
      if (existing.branded !== branded) {
        existing.branded = branded;
        write(existing);
      }
      continue;
    }

    const duplicate = working.find(
      (question) =>
        question.id !== existing?.id &&
        question.status !== "archived" &&
        normalizeQuestionText(question.text) === normalizeQuestionText(text),
    );
    if (duplicate) {
      if (existing)
        throw new AppError(409, "question_duplicate", "This edit duplicates another active question.");
      skipped++;
      continue;
    }

    const archived = working.find(
      (question) =>
        question.id !== existing?.id &&
        question.status === "archived" &&
        normalizeQuestionText(question.text) === normalizeQuestionText(text),
    );
    const newQuestionId = archived?.id ?? makeId();
    if (existing && existing.status !== "archived") {
      setStatus(existing, "archived");
      existing.replacedBy = newQuestionId;
      write(existing);
      event(existing.id, "replaced", { replaced_by: newQuestionId });
    }

    if (archived) {
      archived.topic = topic;
      archived.branded = branded;
      if (archived.status !== status) {
        archived.status = status;
        archived.archivedAt = null;
        write(archived);
      } else {
        write(archived);
      }
      event(archived.id, "revived");
      if (existing) {
        existing.replacedBy = archived.id;
        write(existing);
      }
    } else {
      const inserted: Extract<ResolvedQuestionRow, { op: "insert" }> = {
        op: "insert",
        id: newQuestionId,
        text,
        topic,
        origin: o.origin,
        status: status === "archived" ? "active" : status,
        branded,
        source_ref: o.sourceRef ?? null,
      };
      inserts.set(newQuestionId, inserted);
      working.push({
        id: newQuestionId,
        brandKey: current[0]?.brandKey ?? "",
        text,
        textNormalized: normalizeQuestionText(text),
        topic,
        origin: o.origin,
        status: inserted.status,
        branded,
        cohort: "core",
        replacedBy: null,
        duplicateReason: null,
        sourceRef: o.sourceRef ?? null,
        createdBy: null,
        createdAt: "",
        updatedAt: "",
        archivedAt: null,
      });
      event(newQuestionId, "created", { origin: o.origin });
    }
  }

  for (const id of patch.archiveIds ?? []) setStatus(questionAt(id), "archived");
  for (const id of patch.reviveIds ?? []) setStatus(questionAt(id), "active");
  if (patch.setTopic) {
    for (const id of patch.setTopic.ids) {
      const question = questionAt(id);
      if (question.topic === patch.setTopic.topic) continue;
      question.topic = patch.setTopic.topic;
      write(question);
      event(id, "topic_changed", { topic: patch.setTopic.topic });
    }
  }
  for (const item of patch.duplicateReasons ?? []) {
    const question = questionAt(item.id);
    if (question.duplicateReason === item.reason) continue;
    question.duplicateReason = item.reason;
    write(question);
    event(item.id, "duplicate_reason", { reason: item.reason });
  }

  const beforeActive = initial.filter((question) => question.status !== "archived");
  const afterActive = working.filter((question) => question.status !== "archived");
  const beforeTopics = new Set(beforeActive.map((question) => question.topic.toLowerCase()));
  const afterTopics = new Set(afterActive.map((question) => question.topic.toLowerCase()));
  if (afterActive.length > 100 && afterActive.length > beforeActive.length)
    throw new AppError(409, "question_limit", "You can track up to 100 questions. Archive unused questions first.");
  if (afterTopics.size > 30 && afterTopics.size > beforeTopics.size)
    throw new AppError(409, "topic_limit", "You can use up to 30 topics. Archive the questions of an unused topic first.");

  const resolvedRows: ResolvedQuestionRow[] = [...updates.values(), ...inserts.values()];
  return {
    rows: resolvedRows,
    events,
    created: inserts.size,
    updated: updates.size,
    skipped,
  };
}
