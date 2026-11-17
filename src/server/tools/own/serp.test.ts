import test from "node:test";
import assert from "node:assert/strict";
import {
  createFindSerpCompetitorsTool,
  createGetSerpResultsTool,
} from "./serp.ts";
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

test("get_serp_results refuses without maxUsd before calling F13", async () => {
  let calls = 0;
  const tool = createGetSerpResultsTool({
    runSerpRequest: (async () => {
      calls += 1;
      return { items: [], cached: false, fetchedAt: "", depth: 20 };
    }) as any,
  });

  await assert.rejects(() => tool.handler(context(), { keyword: "shoes" }));
  assert.equal(calls, 0);
});

test("get_serp_results passes the market, depth and approved maximum, and maps five fields", async () => {
  let received: any;
  const tool = createGetSerpResultsTool({
    runSerpRequest: (async (ws: any, input: any) => {
      received = { brandKey: ws.brandKey, input };
      return {
        items: [
          {
            rank: 1,
            title: "Shoes",
            url: "https://shop.example/a",
            domain: "shop.example",
            description: "Running shoes",
            etv: 100,
            isNew: false,
            rankChange: null,
          },
        ],
        cached: true,
        fetchedAt: "2026-11-17T09:00:00.000Z",
        depth: 100,
      };
    }) as any,
  });

  const output = (await tool.handler(context(), {
    keyword: "shoes",
    depth: 100,
    maxUsd: 0.3,
  })) as any;

  assert.equal(received.brandKey, "brand-a");
  assert.equal(received.input.keyword, "shoes");
  assert.equal(received.input.depth, 100);
  assert.equal(received.input.maxUsd, 0.3);
  assert.equal(received.input.cacheOnly, false);
  assert.ok(isUuid(received.input.requestId));
  assert.deepEqual(output, {
    items: [
      {
        rank: 1,
        title: "Shoes",
        url: "https://shop.example/a",
        domain: "shop.example",
        description: "Running shoes",
      },
    ],
    cached: true,
    fetchedAt: "2026-11-17T09:00:00.000Z",
    depth: 100,
  });
});

test("find_serp_competitors refuses without maxUsd before calling F14", async () => {
  let calls = 0;
  const tool = createFindSerpCompetitorsTool({
    runSerpCompetitorsRequest: (async () => {
      calls += 1;
      return { status: "ok", keywordCount: 1, competitors: [] };
    }) as any,
  });

  await assert.rejects(() =>
    tool.handler(context(), { domain: "acme.test", keywords: ["shoes"] }),
  );
  assert.equal(calls, 0);
});

test("find_serp_competitors passes the keywords and returns the competitor count", async () => {
  let received: any;
  const tool = createFindSerpCompetitorsTool({
    runSerpCompetitorsRequest: (async (ws: any, input: any) => {
      received = { brandKey: ws.brandKey, input };
      return {
        status: "ok",
        keywordCount: input.keywords.length,
        competitors: [{ domain: "rival.example" }, { domain: "other.example" }],
        cached: false,
        fetchedAt: "2026-11-17T09:00:00.000Z",
      };
    }) as any,
  });

  const output = (await tool.handler(context(), {
    domain: "acme.test",
    keywords: ["shoes", "socks"],
    maxUsd: 0.9,
  })) as any;

  assert.equal(received.brandKey, "brand-a");
  assert.equal(received.input.domain, "acme.test");
  assert.deepEqual(received.input.keywords, ["shoes", "socks"]);
  assert.equal(received.input.limit, 50);
  assert.equal(received.input.maxUsd, 0.9);
  assert.ok(isUuid(received.input.requestId));
  assert.equal(output.totalCount, 2);
  assert.equal(output.competitors.length, 2);
});
