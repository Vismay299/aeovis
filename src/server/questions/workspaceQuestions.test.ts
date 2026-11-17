import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { AppError } from "../../shared/http/appError.ts";
import { getBrandAliases } from "../../shared/scoring/aliases.js";
import {
  addWorkspaceQuestion,
  canonicalQuestionText,
  isBrandedQuestion,
  normalizeQuestionText,
  type WorkspaceQuestion,
} from "./workspaceQuestions.ts";
import type { SupabaseClient } from "@supabase/supabase-js";

type NormalizeCase = { name: string; raw: string; canonical: string; normalized: string };
const cases = JSON.parse(
  readFileSync(new URL("../../../tests/fixtures/f08/normalize-cases.json", import.meta.url), "utf8"),
) as NormalizeCase[];

function fakeAdmin({
  rpcError = null,
  rpcData = {
    id: "00000000-0000-4000-8000-000000000001",
    status: "active",
    created: true,
    revived: false,
    revision: 1,
  },
}: {
  rpcError?: { code?: string; message: string } | null;
  rpcData?: Record<string, unknown>;
} = {}): { admin: SupabaseClient; calls: { name: string; args: Record<string, unknown> }[] } {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const question: WorkspaceQuestion = {
    id: "00000000-0000-4000-8000-000000000001",
    brandKey: "offcult.in",
    text: "Which brands sell tees?",
    textNormalized: "which brands sell tees?",
    topic: "General",
    origin: "import",
    status: "archived",
    branded: false,
    cohort: "core",
    replacedBy: null,
    duplicateReason: null,
    sourceRef: null,
    createdBy: null,
    createdAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-01T00:00:00.000Z",
    archivedAt: "2026-11-01T00:00:00.000Z",
  };
  const admin = {
    from(table: string) {
      let filters: Record<string, unknown> = {};
      const query = {
        select() { return this; },
        eq(column: string, value: unknown) { filters[column] = value; return this; },
        maybeSingle: async () => ({
          data: table === "customer_brands" ? { display_name: "Offcult", website: "https://offcult.in" } : null,
          error: null,
        }),
        single: async () => ({ data: filters.id === question.id ? {
          id: question.id,
          brand_key: question.brandKey,
          text: question.text,
          text_normalized: question.textNormalized,
          topic: question.topic,
          origin: question.origin,
          status: question.status,
          branded: question.branded,
          cohort: question.cohort,
          replaced_by: question.replacedBy,
          duplicate_reason: question.duplicateReason,
          source_ref: question.sourceRef,
          created_by: question.createdBy,
          created_at: question.createdAt,
          updated_at: question.updatedAt,
          archived_at: question.archivedAt,
        } : null, error: null }),
      };
      return query;
    },
    async rpc(name: string, args: Record<string, unknown>) {
      calls.push({ name, args });
      return { data: rpcData, error: rpcError };
    },
  } as unknown as SupabaseClient;
  return { admin, calls };
}

test("canonical and normalized question text match the shared fixture", () => {
  for (const row of cases) {
    assert.equal(canonicalQuestionText(row.raw), row.canonical, row.name);
    assert.equal(normalizeQuestionText(row.raw), row.normalized, row.name);
    assert.equal(normalizeQuestionText(row.canonical), row.normalized, row.name);
  }
});

test("branded detection uses the same whole-word alias rule as panel validation", () => {
  const aliases = getBrandAliases("Offcult", "https://offcult.in");
  assert.equal(isBrandedQuestion("Is Offcult good for streetwear?", aliases), true);
  assert.equal(isBrandedQuestion("What about offcult.in?", aliases), true);
  assert.equal(isBrandedQuestion("What about offcultxin?", aliases), false);
  assert.equal(isBrandedQuestion("Is Tradeoffcult a good brand?", aliases), false);
});

test("addWorkspaceQuestion calls the single-question RPC and returns its stored row", async () => {
  const { admin, calls } = fakeAdmin({
    rpcData: {
      id: "00000000-0000-4000-8000-000000000001",
      status: "archived",
      created: true,
      revived: false,
      revision: 1,
    },
  });
  const result = await addWorkspaceQuestion(admin, {
    brandKey: "offcult.in",
    text: "Which\u00a0brands sell tees?",
    origin: "import",
    status: "archived",
    createdBy: null,
  });
  assert.equal(result.question.id, "00000000-0000-4000-8000-000000000001");
  assert.equal(result.question.status, "archived");
  assert.equal(result.created, true);
  assert.equal(result.revived, false);
  assert.deepEqual(calls[0], {
    name: "add_workspace_question",
    args: {
      p_brand: "offcult.in",
      p_text: "Which brands sell tees?",
      p_topic: "General",
      p_origin: "import",
      p_status: "archived",
      p_branded: false,
      p_source_ref: null,
      p_actor: null,
    },
  });
});

test("question RPC failures map to the stable public error contract", async (t) => {
  const cases = [
    [{ message: "question_cap:questions" }, "question_limit", 409],
    [{ message: "question_cap:topics" }, "topic_limit", 409],
    [{ message: "question_revision_conflict" }, "revision_conflict", 409],
    [{ code: "23505", message: "unique violation" }, "question_duplicate", 409],
    [{ message: "question_text_immutable" }, "internal_error", 500],
    [{ message: "database unavailable" }, "questions_unavailable", 503],
  ] as const;
  for (const [rpcError, code, status] of cases) {
    await t.test(code, async () => {
      const { admin } = fakeAdmin({ rpcError });
      await assert.rejects(
        () => addWorkspaceQuestion(admin, {
          brandKey: "offcult.in",
          text: "Which brands sell tees?",
          origin: "manual",
          createdBy: null,
        }),
        (error: unknown) => {
          assert.ok(error instanceof AppError);
          assert.equal(error.code, code);
          assert.equal(error.status, status);
          return true;
        },
      );
    });
  }
});
