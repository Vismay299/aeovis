import test from "node:test";
import assert from "node:assert/strict";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createProjectContextRepository } from "./repository.ts";

test("brief import state reads checked_at and imported without creating state", async () => {
  const results = [
    null,
    { brief_import_checked_at: "2026-10-25T00:30:00.000Z", brief_imported: false },
    { brief_import_checked_at: "2026-10-25T00:30:00.000Z", brief_imported: true },
  ];
  const queries: Array<{ table: string; selected: string | null; brandKey: string | null }> = [];
  const admin = {
    from(table: string) {
      const query = { table, selected: null as string | null, brandKey: null as string | null };
      queries.push(query);
      return {
        select(columns: string) {
          query.selected = columns;
          return this;
        },
        eq(column: string, value: string) {
          assert.equal(column, "brand_key");
          query.brandKey = value;
          return this;
        },
        async maybeSingle() {
          return { data: results.shift() ?? null, error: null };
        },
      };
    },
  } as unknown as SupabaseClient;
  const repo = createProjectContextRepository(admin);

  assert.deepEqual(await repo.getBriefImportState("brand.example"), { checkedAt: null, imported: false });
  assert.deepEqual(await repo.getBriefImportState("brand.example"), {
    checkedAt: "2026-10-25T00:30:00.000Z",
    imported: false,
  });
  assert.deepEqual(await repo.getBriefImportState("brand.example"), {
    checkedAt: "2026-10-25T00:30:00.000Z",
    imported: true,
  });
  assert.deepEqual(queries, Array.from({ length: 3 }, () => ({
    table: "project_memory_state",
    selected: "brief_import_checked_at,brief_imported",
    brandKey: "brand.example",
  })));
});
