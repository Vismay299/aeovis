import test, { describe } from "node:test";
import assert from "node:assert/strict";
import type { SupabaseClient } from "@supabase/supabase-js";
import { AppError } from "../../shared/http/errors.ts";
import { createSavedKeywordsRepository } from "./repository.ts";
import type { SavedKeywordRow } from "../../shared/keywords.ts";

const BRAND = "export-test-brand";

type RpcCall = { fn: string; args: Record<string, unknown> };

type RpcResult = {
  data: unknown;
  // Supabase returns a PostgrestError, which extends Error
  // (@supabase/postgrest-js/src/PostgrestError.ts:25), so the repository's
  // message-based mapping reads .message from a real Error.
  error: Error | null;
};

function fakeAdmin(result: RpcResult): {
  admin: SupabaseClient;
  calls: RpcCall[];
} {
  const calls: RpcCall[] = [];
  const admin = {
    rpc: async (fn: string, args: Record<string, unknown>) => {
      calls.push({ fn, args });
      return result;
    },
  };
  return { admin: admin as unknown as SupabaseClient, calls };
}

function row(index: number): SavedKeywordRow {
  return {
    id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    keyword: `kw-${index}`,
    locationCode: 2840,
    languageCode: "en",
    createdAt: "2026-11-01T00:00:00.000Z",
    searchVolume: null,
    cpc: null,
    competition: null,
    keywordDifficulty: null,
    intent: null,
    monthlySearches: [],
    fetchedAt: null,
    tags: [],
  };
}

function rows(count: number): SavedKeywordRow[] {
  return Array.from({ length: count }, (_, index) => row(index));
}

async function captureError(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => null,
    (err: unknown) => err,
  );
}

describe("saved keywords repository export", () => {
  test("asks for at most 5000 rows and forwards the list defaults", async () => {
    const { admin, calls } = fakeAdmin({
      data: { rows: [], totalCount: 0 },
      error: null,
    });
    const repo = createSavedKeywordsRepository(admin);

    await repo.listAllForExport({
      brandKey: BRAND,
      filters: { search: "tee" },
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].fn, "list_saved_keywords");
    // Fails on the pre-fix code, which sent p_limit: 5001 — above migration
    // 102's 1..5000 guard, so every export raised saved_keywords_invalid:list.
    assert.equal(calls[0].args.p_limit, 5000);
    assert.equal(calls[0].args.p_offset, 0);
    assert.equal(calls[0].args.p_sort, "fetchedAt");
    assert.equal(calls[0].args.p_order, "desc");
    assert.equal(calls[0].args.p_brand, BRAND);
    assert.deepEqual(calls[0].args.p_filters, { search: "tee" });
  });

  test("forwards an explicit sort and order", async () => {
    const { admin, calls } = fakeAdmin({
      data: { rows: [], totalCount: 0 },
      error: null,
    });
    const repo = createSavedKeywordsRepository(admin);

    await repo.listAllForExport({
      brandKey: BRAND,
      sort: "keyword",
      order: "asc",
    });

    assert.equal(calls[0].args.p_sort, "keyword");
    assert.equal(calls[0].args.p_order, "asc");
  });

  test("5000 rows with totalCount 5200 returns 5000 rows and truncated true", async () => {
    const { admin } = fakeAdmin({
      data: { rows: rows(5000), totalCount: 5200 },
      error: null,
    });
    const repo = createSavedKeywordsRepository(admin);

    const result = await repo.listAllForExport({ brandKey: BRAND });

    assert.equal(result.rows.length, 5000);
    assert.equal(result.totalCount, 5200);
    assert.equal(result.truncated, true);
  });

  test("totalCount 5000 is not truncated", async () => {
    const { admin } = fakeAdmin({
      data: { rows: rows(5000), totalCount: 5000 },
      error: null,
    });
    const repo = createSavedKeywordsRepository(admin);

    const result = await repo.listAllForExport({ brandKey: BRAND });

    assert.equal(result.rows.length, 5000);
    assert.equal(result.totalCount, 5000);
    assert.equal(result.truncated, false);
  });

  test("an rpc error maps to 400 invalid_request", async () => {
    const { admin } = fakeAdmin({
      data: null,
      error: new Error("saved_keywords_invalid:list"),
    });
    const repo = createSavedKeywordsRepository(admin);

    const error = await captureError(repo.listAllForExport({ brandKey: BRAND }));

    assert.ok(error instanceof AppError);
    assert.equal(error.status, 400);
    assert.equal(error.code, "invalid_request");
    assert.equal(error.message, "These keywords could not be saved.");
  });

  test("a generic rpc error maps to 503 keywords_unavailable", async () => {
    const { admin } = fakeAdmin({
      data: null,
      error: new Error("connection reset"),
    });
    const repo = createSavedKeywordsRepository(admin);

    const error = await captureError(repo.listAllForExport({ brandKey: BRAND }));

    assert.ok(error instanceof AppError);
    assert.equal(error.status, 503);
    assert.equal(error.code, "keywords_unavailable");
  });
});
