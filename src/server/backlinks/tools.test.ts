import test from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import {
  backlinksTools,
  getBacklinksOverviewTool,
  listBacklinksTool,
  listReferringDomainsTool,
  getBacklinkHistoryTool,
  type BacklinksToolContext,
} from "./tools.ts";

function makeContext(over: Partial<BacklinksToolContext> = {}): BacklinksToolContext {
  return {
    brand: {
      brandKey: "offcult.in",
      website_host: "offcult.in",
      display_name: "Offcult",
    },
    ...over,
  };
}

test("backlinks tools carry expected names and descriptions", () => {
  assert.deepEqual(
    backlinksTools.map((t) => t.name),
    ["get_backlinks_overview", "list_backlinks", "list_referring_domains", "get_backlink_history"],
  );
  assert.equal(
    getBacklinksOverviewTool.description,
    "Look up high-level backlink counts and metrics for a domain, subfolder or exact URL. Paid tool; pass maxUsd to confirm approval.",
  );
  assert.equal(
    listBacklinksTool.description,
    "Fetch individual backlinks for a target. Paid tool; pass maxUsd to confirm approval.",
  );
  assert.equal(
    listReferringDomainsTool.description,
    "Fetch referring domains pointing to a domain or subdomains target. Paid tool; pass maxUsd to confirm approval.",
  );
});

test("get_backlink_history is closed and refuses without workspace storage", async () => {
  assert.equal(getBacklinkHistoryTool.input.safeParse({ target: "offcult.in", scope: "subdomains", extra: true }).success, false);
  await assert.rejects(
    getBacklinkHistoryTool.handler(makeContext(), { target: "offcult.in", scope: "subdomains" }),
    (error: any) => error.code === "snapshots_unavailable",
  );
});

test("all tool inputs are closed objects and all outputs are loose objects", () => {
  for (const tool of backlinksTools) {
    const input = z.toJSONSchema(tool.input, { io: "input" }) as {
      additionalProperties?: unknown;
    };
    assert.equal(
      input.additionalProperties,
      false,
      `${tool.name}: input must be closed`,
    );
    const output = z.toJSONSchema(tool.output, { io: "output" }) as {
      additionalProperties?: unknown;
    };
    assert.notEqual(
      output.additionalProperties,
      false,
      `${tool.name}: output must stay loose`,
    );
  }
});

test("get_backlinks_overview input rejects unknown fields", () => {
  assert.equal(
    getBacklinksOverviewTool.input.safeParse({ target: "offcult.in", extra: true })
      .success,
    false,
  );
  assert.equal(
    getBacklinksOverviewTool.input.safeParse({ target: "offcult.in", maxUsd: 0.05 })
      .success,
    true,
  );
});

test("list_backlinks input rejects unknown fields", () => {
  assert.equal(
    listBacklinksTool.input.safeParse({ target: "offcult.in", invalid: 123 })
      .success,
    false,
  );
  assert.equal(
    listBacklinksTool.input.safeParse({ target: "offcult.in", page: 1, pageSize: 50 })
      .success,
    true,
  );
});

test("list_referring_domains input rejects unknown fields", () => {
  assert.equal(
    listReferringDomainsTool.input.safeParse({ target: "offcult.in", unknown: "no" })
      .success,
    false,
  );
  assert.equal(
    listReferringDomainsTool.input.safeParse({ target: "offcult.in", pageSize: 100 })
      .success,
    true,
  );
});

test("get_backlinks_overview handler returns ok result", async () => {
  let calledWith: { input: any; deps: any } | null = null;
  const ctx = makeContext({
    deps: {
      profileOverview: async (input, deps) => {
        calledWith = { input, deps };
        return {
          overview: {
            target: "offcult.in",
            displayTarget: "offcult.in",
            scope: "subdomains",
            summary: {
              rank: 21,
              backlinks: 4120,
              referringPages: 2980,
              referringDomains: 312,
              brokenBacklinks: 14,
              brokenPages: 3,
              backlinksSpamScore: 12,
              targetSpamScore: 4,
              newBacklinks: 85,
              lostBacklinks: 40,
              newReferringDomains: 9,
              lostReferringDomains: 5,
            },
            trends: [],
            newLostTrends: [],
            fetchedAt: "2026-10-21T09:30:00.000Z",
          },
          cached: false,
          fetchedAt: "2026-10-21T09:30:00.000Z",
        };
      },
    },
  });

  const res = await getBacklinksOverviewTool.handler(ctx, {
    target: "offcult.in",
    maxUsd: 0.1,
  });
  assert.equal(res.status, "ok");
  assert.equal(res.target, "offcult.in");
  assert.equal(res.summary?.backlinks, 4120);
  assert.ok(calledWith);
  assert.equal((calledWith as any).deps.maxUsd, 0.1);
});

test("get_backlinks_overview handler returns not_cached when cacheOnly misses", async () => {
  const ctx = makeContext({
    deps: {
      profileOverview: async () => null,
    },
  });

  const res = await getBacklinksOverviewTool.handler(ctx, {
    target: "offcult.in",
    cacheOnly: true,
  });
  assert.equal(res.status, "not_cached");
  assert.equal(res.target, "offcult.in");
});

test("list_backlinks handler returns ok result and not_cached on miss", async () => {
  const ctxOk = makeContext({
    deps: {
      profileBacklinksPage: async () => ({
        rows: [
          {
            domainFrom: "source.example",
            urlFrom: "https://source.example/page",
            urlTo: "https://example.com",
            anchor: "anchor",
            itemType: "anchor",
            isDofollow: true,
            relAttributes: [],
            rank: 45,
            domainFromRank: 50,
            pageFromRank: 40,
            spamScore: 10,
            firstSeen: "2026-01-01T00:00:00Z",
            lastSeen: "2026-02-01T00:00:00Z",
            isLost: false,
            isBroken: false,
            linksCount: 1,
          },
        ],
        totalCount: 1,
        hasMore: false,
        page: 1,
        pageSize: 50,
        cached: false,
        fetchedAt: "2026-10-21T09:30:00.000Z",
        provenance: { gateway: "dataforseo" },
      }),
    },
  });

  const resOk = await listBacklinksTool.handler(ctxOk, {
    target: "offcult.in",
    page: 1,
    pageSize: 50,
  });
  assert.equal(resOk.status, "ok");
  assert.equal(resOk.rows?.length, 1);

  const ctxMiss = makeContext({
    deps: {
      profileBacklinksPage: async () => null,
    },
  });

  const resMiss = await listBacklinksTool.handler(ctxMiss, {
    target: "offcult.in",
    cacheOnly: true,
  });
  assert.equal(resMiss.status, "not_cached");
});

test("list_referring_domains handler returns ok result and not_cached on miss", async () => {
  const ctxOk = makeContext({
    deps: {
      profileReferringDomainsPage: async () => ({
        rows: [
          {
            domain: "source.example",
            backlinks: 10,
            referringPages: 5,
            rank: 45,
            spamScore: 12,
            firstSeen: "2026-01-01T00:00:00Z",
            brokenBacklinks: 0,
            brokenPages: 0,
          },
        ],
        totalCount: 1,
        hasMore: false,
        page: 1,
        pageSize: 50,
        cached: false,
        fetchedAt: "2026-10-21T09:30:00.000Z",
        provenance: { gateway: "dataforseo" },
      }),
    },
  });

  const resOk = await listReferringDomainsTool.handler(ctxOk, {
    target: "offcult.in",
    page: 1,
    pageSize: 50,
  });
  assert.equal(resOk.status, "ok");
  assert.equal(resOk.rows?.length, 1);

  const ctxMiss = makeContext({
    deps: {
      profileReferringDomainsPage: async () => null,
    },
  });

  const resMiss = await listReferringDomainsTool.handler(ctxMiss, {
    target: "offcult.in",
    cacheOnly: true,
  });
  assert.equal(resMiss.status, "not_cached");
});
