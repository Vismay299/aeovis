import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register(new URL("../../customerRoutes.test.hooks.mjs", import.meta.url).href);

const route = await import("../../../app/api/customer/scan/report/[scan_id]/route.ts");

const BRAND_A = "workspace-a";

const SCAN = {
  id: "scan-a",
  brand: "Offcult",
  url: "https://offcult.in",
  scanned_at: "2026-10-21T09:00:00.000Z",
  created_at: "2026-10-21T09:00:00.000Z",
  visibility_pct: 42,
  prompts_tracked: 2,
  prompts_mentioned: 1,
  platform: ["chatgpt"],
  raw_results: {},
  origin_job_id: null,
  brand_key: BRAND_A,
};

function makeAdmin(linkRows) {
  const tables = {
    scans: [SCAN],
    prompt_results: [
      {
        id: "result-1",
        query: "Best Oversized Tees in India",
        engine: "chatgpt",
        answer_text: "An answer",
        answered: true,
        mentioned: true,
        brand_cited: false,
        position: 1,
        sentiment: null,
        raw: {},
        created_at: "2026-10-21T09:00:00.000Z",
      },
      {
        id: "result-2",
        query: "Unlinked question wording",
        engine: "chatgpt",
        answer_text: "An answer",
        answered: true,
        mentioned: false,
        brand_cited: false,
        position: null,
        sentiment: null,
        raw: {},
        created_at: "2026-10-21T09:00:00.000Z",
      },
    ],
    question_answer_links: linkRows,
  };
  const admin = {
    from(table) {
      let rows = (tables[table] ?? []).slice();
      const query = {
        select: () => query,
        eq: (col, value) => {
          rows = rows.filter((row) => row[col] === value);
          return query;
        },
        order: () => query,
        limit: () => query,
        maybeSingle: async () => ({ data: rows[0] ?? null, error: null }),
        single: async () => ({ data: rows[0] ?? null, error: null }),
        then: (resolve) => Promise.resolve({ data: rows, error: null }).then(resolve),
      };
      return query;
    },
  };
  globalThis.customerRouteFixture = {
    admin,
    context: {
      client: null,
      user: { id: "user-a" },
      error: null,
      brands: [{ brandKey: BRAND_A, display_name: "Workspace", website: "https://a.example", role: "owner" }],
    },
  };
  return admin;
}

test("scan report adds questionIdByQuery keyed by the client grouping key", async () => {
  makeAdmin([
    {
      asked_text: "Best oversized tees in India",
      question_id: "0b9c2d4e-6f70-4a81-9b2c-3d4e5f607182",
      scan_id: "scan-a",
      brand_key: BRAND_A,
    },
  ]);
  const response = await route.GET(new Request("https://app.test/report"), {
    params: { scan_id: "scan-a" },
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.questionIdByQuery, {
    "best oversized tees in india": "0b9c2d4e-6f70-4a81-9b2c-3d4e5f607182",
  });
  assert.ok(!("unlinked question wording" in body.questionIdByQuery));
});

test("scan report answers an empty map when nothing is linked", async () => {
  makeAdmin([]);
  const response = await route.GET(new Request("https://app.test/report"), {
    params: { scan_id: "scan-a" },
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.questionIdByQuery, {});
});
