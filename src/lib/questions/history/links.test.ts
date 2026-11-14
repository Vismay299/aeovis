import test from "node:test";
import assert from "node:assert/strict";
import { linkBeforeRead, linkQuestionAnswers } from "./links.ts";
import type { SupabaseClient } from "@supabase/supabase-js";

type RpcCall = { name: string; args: Record<string, unknown> };

function fakeAdmin(impl: (name: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>): { admin: SupabaseClient; calls: RpcCall[] } {
  const calls: RpcCall[] = [];
  const admin = {
    rpc: async (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args });
      return impl(name, args);
    },
  } as unknown as SupabaseClient;
  return { admin, calls };
}

test("linkQuestionAnswers maps options to the link_question_answers RPC args", async () => {
  const { admin, calls } = fakeAdmin(async () => ({
    data: { scan: 3, explore: 1, legacy: 2, imported: 0, unmatched: 4 },
    error: null,
  }));
  const result = await linkQuestionAnswers(admin, "offcult.in", {
    limit: 500,
    importMissing: true,
    linkedBy: "backfill",
  });
  assert.deepEqual(result, { scan: 3, explore: 1, legacy: 2, imported: 0, unmatched: 4 });
  assert.deepEqual(calls, [{
    name: "link_question_answers",
    args: { p_brand: "offcult.in", p_limit: 500, p_import_missing: true, p_linked_by: "backfill" },
  }]);
});

test("linkQuestionAnswers defaults to limit 2000 without import as periodic", async () => {
  const { admin, calls } = fakeAdmin(async () => ({ data: {}, error: null }));
  const result = await linkQuestionAnswers(admin, "offcult.in");
  assert.deepEqual(result, { scan: 0, explore: 0, legacy: 0, imported: 0, unmatched: 0 });
  assert.deepEqual(calls, [{
    name: "link_question_answers",
    args: { p_brand: "offcult.in", p_limit: 2000, p_import_missing: false, p_linked_by: "periodic" },
  }]);
});

test("linkBeforeRead links at most 500 rows as read and returns null", async () => {
  const { admin, calls } = fakeAdmin(async () => ({
    data: { scan: 1, explore: 0, legacy: 0, imported: 0, unmatched: 0 },
    error: null,
  }));
  const result = await linkBeforeRead(admin, "offcult.in");
  assert.equal(result, null);
  assert.deepEqual(calls, [{
    name: "link_question_answers",
    args: { p_brand: "offcult.in", p_limit: 500, p_import_missing: false, p_linked_by: "read" },
  }]);
});

test("linkBeforeRead swallows errors and logs only the brand key, never text", async () => {
  const failingQuestion = "Best oversized tees in India";
  const failingAnswer = "Popular oversized t-shirt brands include Bewakoof";
  const { admin } = fakeAdmin(async () => {
    throw new Error(`boom for ${failingQuestion}: ${failingAnswer}`);
  });
  const logged: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    logged.push(args.map(String).join(" "));
  };
  try {
    const result = await linkBeforeRead(admin, "offcult.in");
    assert.equal(result, null);
  } finally {
    console.error = original;
  }
  assert.deepEqual(logged, ["[question-history] lazy link failed offcult.in"]);
  for (const line of logged) {
    assert.ok(!line.includes(failingQuestion), "question text must never be logged");
    assert.ok(!line.includes(failingAnswer), "answer text must never be logged");
  }
});
