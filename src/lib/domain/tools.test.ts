import test from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import {
  domainTools,
  getDomainOverviewTool,
  getRankedKeywordsTool,
  type DomainToolContext,
} from "./tools.ts";

function makeContext(over: Partial<DomainToolContext> = {}): DomainToolContext {
  return {
    brand: {
      brandKey: "offcult.in",
      website_host: "offcult.in",
      display_name: "Offcult",
    },
    ...over,
  };
}

test("domain tools carry expected names and descriptions", () => {
  assert.deepEqual(
    domainTools.map((t) => t.name),
    ["get_domain_overview", "get_ranked_keywords"],
  );
  assert.equal(
    getDomainOverviewTool.description,
    "Look up high-level organic traffic and keyword counts for a domain or subfolder. Paid tool; pass maxUsd to confirm approval.",
  );
  assert.equal(
    getRankedKeywordsTool.description,
    "Fetch top organic ranked keywords for a domain or subfolder. Paid tool; pass maxUsd to confirm approval.",
  );
});

test("both inputs are closed objects and both outputs are loose objects", () => {
  for (const tool of domainTools) {
    const input = z.toJSONSchema(tool.input, { io: "input" }) as { additionalProperties?: unknown };
    assert.equal(input.additionalProperties, false, `${tool.name}: input must be closed`);
    const output = z.toJSONSchema(tool.output, { io: "output" }) as { additionalProperties?: unknown };
    assert.notEqual(output.additionalProperties, false, `${tool.name}: output must stay loose`);
  }
});

test("get_domain_overview input rejects unknown fields", () => {
  assert.equal(
    getDomainOverviewTool.input.safeParse({ domain: "offcult.in", extra: true }).success,
    false,
  );
  assert.equal(
    getDomainOverviewTool.input.safeParse({ domain: "offcult.in", maxUsd: 0.05 }).success,
    true,
  );
});

test("get_ranked_keywords input rejects unknown fields", () => {
  assert.equal(
    getRankedKeywordsTool.input.safeParse({ domain: "offcult.in", invalidField: "fail" }).success,
    false,
  );
  assert.equal(
    getRankedKeywordsTool.input.safeParse({ domain: "offcult.in", page: 1, pageSize: 50 }).success,
    true,
  );
});

test("get_domain_overview handler returns ok result", async () => {
  let calledWith: { input: any; deps: any } | null = null;
  const ctx = makeContext({
    deps: {
      getOverview: async (input, deps) => {
        calledWith = { input, deps };
        return {
          domain: "offcult.in",
          displayTarget: "offcult.in",
          scope: "subdomains",
          organicTraffic: 1200,
          organicKeywords: 350,
          hasData: true,
          cached: false,
          fetchedAt: "2026-10-21T09:30:00.000Z",
          provenance: { gateway: "dataforseo" },
        };
      },
    },
  });

  const res = await getDomainOverviewTool.handler(ctx, { domain: "offcult.in", maxUsd: 0.05 });
  assert.equal(res.status, "ok");
  assert.equal(res.domain, "offcult.in");
  assert.equal(res.organicTraffic, 1200);
  if (!calledWith) assert.fail("expected getOverview to be called");
  assert.equal((calledWith as any).input.domain, "offcult.in");
  assert.equal((calledWith as any).deps.maxUsd, 0.05);
});

test("get_domain_overview handler returns not_cached when cacheOnly misses", async () => {
  const ctx = makeContext({
    deps: {
      getOverview: async () => null,
    },
  });

  const res = await getDomainOverviewTool.handler(ctx, { domain: "offcult.in", cacheOnly: true });
  assert.equal(res.status, "not_cached");
  assert.equal(res.domain, "offcult.in");
});

test("get_ranked_keywords handler returns ok result", async () => {
  const ctx = makeContext({
    deps: {
      getKeywordsPage: async (input) => ({
        domain: input.domain,
        page: input.page,
        pageSize: input.pageSize,
        totalCount: 100,
        hasMore: true,
        keywords: [
          {
            keyword: "hoodies",
            position: 3,
            searchVolume: 12000,
            traffic: 500,
            cpc: 0.5,
            url: "https://offcult.in/hoodies",
            relativeUrl: "/hoodies",
            keywordDifficulty: 25,
          },
        ],
        cached: true,
        fetchedAt: "2026-10-21T09:30:00.000Z",
        provenance: { gateway: "dataforseo" },
      }),
    },
  });

  const res = await getRankedKeywordsTool.handler(ctx, {
    domain: "offcult.in",
    page: 1,
    pageSize: 50,
  });
  assert.equal(res.status, "ok");
  assert.equal(res.totalCount, 100);
  assert.equal(res.hasMore, true);
  assert.ok(res.keywords);
  assert.equal(res.keywords.length, 1);
});
