// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/routes/_app/p/$projectId/saved.tsx
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import test from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { parseSearchParams, buildSearch } from "./urlState.ts";

test("parseSearchParams: missing params return defaults", () => {
  const schema = z.object({
    page: z.number(),
    view: z.string(),
  });
  const defaults = { page: 1, view: "all" };
  const params = new URLSearchParams("");

  const parsed = parseSearchParams(params, schema, defaults);
  assert.deepEqual(parsed, { page: 1, view: "all" });
});

test("parseSearchParams: ?page=3 with default page: 1 coerces to number 3", () => {
  const schema = z.object({
    page: z.number(),
    view: z.string(),
  });
  const defaults = { page: 1, view: "all" };
  const params = new URLSearchParams("page=3");

  const parsed = parseSearchParams(params, schema, defaults);
  assert.deepEqual(parsed, { page: 3, view: "all" });
});

test("parseSearchParams: ?view=bogus&q=x -> view default, q 'x'", () => {
  const schema = z.object({
    view: z.enum(["all", "naming", "missing", "unanswered"]),
    q: z.string(),
  });
  const defaults = { view: "all", q: "" };
  const params = new URLSearchParams("view=bogus&q=x");

  const parsed = parseSearchParams(params, schema, defaults);
  assert.deepEqual(parsed, { view: "all", q: "x" });
});

test("parseSearchParams: repeated ?tags=a&tags=b with arrays: ['tags'] -> ['a', 'b']", () => {
  const schema = z.object({
    tags: z.array(z.string()),
    view: z.string(),
  });
  const defaults = { tags: [] as string[], view: "all" };
  const params = new URLSearchParams("tags=a&tags=b");

  const parsed = parseSearchParams(params, schema, defaults, ["tags"]);
  assert.deepEqual(parsed, { tags: ["a", "b"], view: "all" });
});

test("buildSearch: drops defaults, empty strings, empty arrays, keeps unknown keys, and sorts", () => {
  const defaults: { page: number; view: string; q: string; tags: string[]; [key: string]: unknown } = {
    page: 1,
    view: "all",
    q: "",
    tags: [],
  };
  const current = new URLSearchParams("existing=keep&page=2");

  // Patching page back to default 1, view to "all", q to "", tags to [], and a new valid filter
  const search = buildSearch(
    current,
    { page: 1, view: "all", q: "", tags: [], filter: "active" as any },
    defaults
  );

  // 'page' is default 1 (dropped), 'view' is default 'all' (dropped), 'q' is "" (dropped), 'tags' is [] (dropped),
  // 'existing' is kept, 'filter' is set.
  // Sorted alphabetically: existing=keep&filter=active
  assert.equal(search, "?existing=keep&filter=active");
});

test("buildSearch: returns empty string when all params are default or dropped", () => {
  const defaults = { page: 1, view: "all" };
  const current = new URLSearchParams("page=1");
  const search = buildSearch(current, { page: 1, view: "all" }, defaults);
  assert.equal(search, "");
});
