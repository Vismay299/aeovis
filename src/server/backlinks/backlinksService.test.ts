import test, { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  profileOverview,
  profileBacklinksPage,
  profileReferringDomainsPage,
  profileTopPagesPage,
  buildBacklinksDateRange,
  type BacklinksServiceDeps,
} from "./backlinksService.ts";
import { createMemoryCacheStore } from "../cache/memoryStore.ts";
import type { BacklinksClient } from "../../shared/providers/dataforseo/backlinks.ts";
import { AppError } from "../../shared/http/appError.ts";

function createHarness() {
  const store = createMemoryCacheStore();
  const cacheDeps = { store };

  const calls = {
    summary: [] as any[],
    history: [] as any[],
    rows: [] as any[],
    referringDomains: [] as any[],
    domainPages: [] as any[],
  };

  let rowsHandler: ((ctx: any, input: any) => Promise<any>) | null = null;

  const fakeClient: BacklinksClient = {
    summary: (async (ctx: any, input: any) => {
      calls.summary.push({ ctx, input });
      return {
        data: {
          backlinks: 1200,
          referring_domains: 100,
          referring_pages: 90,
          rank: 50,
        },
      };
    }) as any,
    history: (async (ctx: any, input: any) => {
      calls.history.push({ ctx, input });
      return {
        data: [{ date: "2026-02-01", backlinks: 1000, referring_domains: 80 }],
      };
    }) as any,
    rows: (async (ctx: any, input: any) => {
      calls.rows.push({ ctx, input });
      if (rowsHandler) return rowsHandler(ctx, input);
      return {
        data: {
          items: [
            {
              url_from: "https://source.example/post",
              domain_from: "source.example",
              url_to: "https://example.com/target",
              anchor: "Link",
              item_type: "organic",
              dofollow: true,
              rel_attributes: [],
              rank: 40,
              domain_from_rank: 50,
              page_from_rank: 30,
              backlink_spam_score: 10,
              first_seen: "2026-01-01",
              last_seen: "2026-10-06 10:00:00 +00:00",
              is_lost: false,
              is_broken: false,
              links_count: 1,
            },
          ],
          totalCount: 450,
        },
      };
    }) as any,
    referringDomains: (async (ctx: any, input: any) => {
      calls.referringDomains.push({ ctx, input });
      return {
        data: {
          items: [
            {
              domain: "source.example",
              backlinks: 10,
              referring_pages: 5,
              rank: 45,
              backlinks_spam_score: null,
              target_spam_score: 4,
              first_seen: "2026-01-01",
              broken_backlinks: 0,
              broken_pages: 0,
            },
          ],
          totalCount: 1,
        },
      };
    }) as any,
    domainPages: (async (ctx: any, input: any) => {
      calls.domainPages.push({ ctx, input });
      return {
        data: {
          items: [
            {
              page: "https://example.com/about",
              backlinks: 50,
              referring_domains: 12,
              rank: 35,
              broken_backlinks: 0,
            },
          ],
          totalCount: 1,
        },
      };
    }) as any,
  };

  const makeDeps = (
    overrides: Partial<BacklinksServiceDeps> = {},
  ): BacklinksServiceDeps => ({
    client: fakeClient,
    brandKey: "brand-123",
    requestId: "00000000-0000-0000-0000-000000000001",
    cacheOnly: false,
    cacheDeps,
    now: () => new Date("2026-10-21T09:30:00.000Z"),
    ...overrides,
  });

  return {
    store,
    cacheDeps,
    calls,
    fakeClient,
    makeDeps,
    setRowsHandler: (fn: typeof rowsHandler) => {
      rowsHandler = fn;
    },
  };
}

const pageInputDefaults = {
  page: 1,
  pageSize: 100,
  sortField: "rank" as const,
  sortOrder: "desc" as const,
  filters: {},
};

describe("BacklinksService (ported billing cases)", () => {
  it("profiles only the summary and history for the overview and reuses cache on repeat", async () => {
    const { calls, makeDeps } = createHarness();
    const deps = makeDeps();

    const first = await profileOverview({ target: "example.com" }, deps);
    const second = await profileOverview({ target: "example.com" }, deps);

    assert.ok(first);
    assert.equal(first.overview.summary.backlinks, 1200);
    assert.equal(first.overview.trends.length, 1);
    assert.equal(calls.rows.length, 0);
    assert.equal(calls.referringDomains.length, 0);
    assert.equal(calls.domainPages.length, 0);
    assert.equal(calls.summary.length, 1);
    assert.equal(calls.history.length, 1);
    assert.equal(first.cached, false);
    assert.ok(second);
    assert.equal(second.cached, true);
    assert.deepEqual(second.overview, first.overview);
  });

  it("profiles backlink rows per page with offset and total count", async () => {
    const { calls, makeDeps } = createHarness();
    const deps = makeDeps();

    const result = await profileBacklinksPage(
      {
        ...pageInputDefaults,
        target: "example.com",
        page: 2,
        sortField: "rank",
        filters: { include: "blog" },
      },
      deps,
      { hideSpam: false },
    );

    assert.ok(result);
    assert.equal(calls.rows.length, 1);
    const callInput = calls.rows[0].input;
    assert.equal(callInput.target, "example.com");
    assert.equal(callInput.limit, 100);
    assert.equal(callInput.offset, 100);
    assert.deepEqual(callInput.orderBy, ["rank,desc"]);
    assert.equal(callInput.hideSpam, false);
    assert.deepEqual(callInput.filters, [["url_from", "ilike", "%blog%"]]);

    assert.equal(result.rows.length, 1);
    assert.equal(result.totalCount, 450);
    assert.equal(result.hasMore, true);
    assert.equal(result.page, 2);
  });

  it("does not fall back to target spam score for referring domains", async () => {
    const { makeDeps } = createHarness();
    const deps = makeDeps();

    const domains = await profileReferringDomainsPage(
      {
        ...pageInputDefaults,
        target: "example.com",
        sortField: "backlinks",
      },
      deps,
    );

    assert.ok(domains);
    assert.equal(domains.rows.length, 1);
    assert.equal(domains.rows[0]?.spamScore, null);
  });

  it("keeps page cache entries isolated per page, organization, and scope", async () => {
    const { calls, makeDeps } = createHarness();
    const depsA = makeDeps({ brandKey: "org_123" });
    const depsB = makeDeps({ brandKey: "org_456" });

    const input = {
      ...pageInputDefaults,
      target: "example.com",
      scope: "domain" as const,
      sortField: "rank" as const,
    };

    await profileBacklinksPage(input, depsA);
    await profileBacklinksPage(input, depsA);
    assert.equal(calls.rows.length, 1);

    await profileBacklinksPage({ ...input, page: 2 }, depsA);
    assert.equal(calls.rows.length, 2);

    await profileBacklinksPage(input, depsB);
    assert.equal(calls.rows.length, 3);

    await profileBacklinksPage({ ...input, scope: "subdomains" }, depsA);
    assert.equal(calls.rows.length, 4);
  });

  it("builds subfolder overview totals from two filtered backlink counts", async () => {
    const { calls, makeDeps, setRowsHandler } = createHarness();
    let rowsCallIndex = 0;
    setRowsHandler(async (_ctx, _input) => {
      rowsCallIndex++;
      if (rowsCallIndex === 1) {
        return { data: { items: [], totalCount: 2500 } };
      }
      return { data: { items: [], totalCount: 180 } };
    });

    const deps = makeDeps();
    const res = await profileOverview(
      { target: "example.com/blog", scope: "subfolder" },
      deps,
    );

    assert.ok(res);
    assert.equal(res.overview.summary.backlinks, 2500);
    assert.equal(res.overview.summary.referringDomains, 180);
    assert.equal(res.overview.summary.rank, null);
    assert.deepEqual(res.overview.trends, []);
    assert.equal(calls.summary.length, 0);
    assert.equal(calls.history.length, 0);
    assert.equal(calls.rows.length, 2);

    assert.equal(calls.rows[0].input.mode, "as_is");
    assert.equal(calls.rows[0].input.limit, 1);
    assert.equal(calls.rows[0].input.hideSpam, false);

    assert.equal(calls.rows[1].input.mode, "one_per_domain");
    assert.equal(calls.rows[1].input.limit, 1);
    assert.equal(calls.rows[1].input.hideSpam, false);
  });

  it("shows the provider's last_seen timestamp in backlink results", async () => {
    const { makeDeps } = createHarness();
    const deps = makeDeps();

    const result = await profileBacklinksPage(
      { ...pageInputDefaults, target: "example.com", sortField: "rank" },
      deps,
      { hideSpam: false },
    );

    assert.ok(result);
    assert.equal(result.rows[0]?.lastSeen, "2026-10-06 10:00:00 +00:00");
  });
});

describe("BacklinksService (additional P2.T2.S3 cases)", () => {
  it("exact URL makes no history call", async () => {
    const { calls, makeDeps } = createHarness();
    const deps = makeDeps();

    const res = await profileOverview(
      { target: "https://example.com/page", scope: "exact_url" },
      deps,
    );

    assert.ok(res);
    assert.equal(calls.summary.length, 1);
    assert.equal(calls.history.length, 0);
    assert.deepEqual(res.overview.trends, []);
  });

  it("subfolder calls are sequential (second starts after the first resolves)", async () => {
    const { makeDeps, setRowsHandler } = createHarness();
    let firstActive = false;
    let sequenceViolated = false;

    setRowsHandler(async (_ctx, input) => {
      if (input.mode === "as_is") {
        firstActive = true;
        await new Promise((r) => setTimeout(r, 10));
        firstActive = false;
        return { data: { items: [], totalCount: 100 } };
      }
      if (input.mode === "one_per_domain") {
        if (firstActive) sequenceViolated = true;
        return { data: { items: [], totalCount: 20 } };
      }
      return { data: { items: [], totalCount: 0 } };
    });

    const deps = makeDeps();
    await profileOverview(
      { target: "example.com/blog", scope: "subfolder" },
      deps,
    );

    assert.equal(sequenceViolated, false);
  });

  it("history range ends yesterday UTC with a fixed clock", () => {
    const fixedDate = new Date("2026-10-21T09:30:00.000Z");
    const range = buildBacklinksDateRange(fixedDate);
    assert.equal(range.dateTo, "2026-10-20");
    assert.equal(range.dateFrom, "2025-10-20");
  });

  it("referring domains always sends hideSpam: false", async () => {
    const { calls, makeDeps } = createHarness();
    const deps = makeDeps();

    await profileReferringDomainsPage(
      { ...pageInputDefaults, target: "example.com" },
      deps,
    );

    assert.equal(calls.referringDomains.length, 1);
    assert.equal(calls.referringDomains[0].input.hideSpam, false);
  });

  it("referring domains refuses subfolder scope with 400 subfolder_not_supported", async () => {
    const { makeDeps } = createHarness();
    const deps = makeDeps();

    await assert.rejects(
      async () =>
        profileReferringDomainsPage(
          { ...pageInputDefaults, target: "example.com/sub", scope: "subfolder" },
          deps,
        ),
      (err: any) => {
        assert.ok(err instanceof AppError);
        assert.equal(err.status, 400);
        assert.equal(err.code, "subfolder_not_supported");
        assert.match(
          err.message,
          /Referring domains can't be broken down for a subfolder/,
        );
        return true;
      },
    );
  });

  it("spam condition counts 2 (400 filters_over_budget at 7 user conditions with spam hiding)", async () => {
    const { makeDeps } = createHarness();
    const deps = makeDeps();

    // 7 user conditions + hideSpam (counts 2) = 9 > 8 -> budget error
    await assert.rejects(
      async () =>
        profileBacklinksPage(
          {
            ...pageInputDefaults,
            target: "example.com",
            filters: { exclude: "a,b,c,d,e,f,g" },
          },
          deps,
          { hideSpam: true },
        ),
      (err: any) => {
        assert.ok(err instanceof AppError);
        assert.equal(err.status, 400);
        assert.equal(err.code, "filters_over_budget");
        return true;
      },
    );

    // With hideSpam false, 7 conditions <= 8 budget -> passes
    const pass = await profileBacklinksPage(
      {
        ...pageInputDefaults,
        target: "example.com",
        filters: { exclude: "a,b,c,d,e,f,g" },
      },
      deps,
      { hideSpam: false },
    );
    assert.ok(pass);
  });

  it("cacheOnly miss returns null with zero calls", async () => {
    const { calls, makeDeps } = createHarness();
    const deps = makeDeps({ cacheOnly: true });

    const overview = await profileOverview({ target: "not-cached.com" }, deps);
    assert.equal(overview, null);
    assert.equal(calls.summary.length, 0);
    assert.equal(calls.history.length, 0);

    const rows = await profileBacklinksPage(
      { ...pageInputDefaults, target: "not-cached.com" },
      deps,
    );
    assert.equal(rows, null);
    assert.equal(calls.rows.length, 0);

    const domains = await profileReferringDomainsPage(
      { ...pageInputDefaults, target: "not-cached.com" },
      deps,
    );
    assert.equal(domains, null);
    assert.equal(calls.referringDomains.length, 0);

    const pages = await profileTopPagesPage(
      { ...pageInputDefaults, target: "not-cached.com" },
      deps,
    );
    assert.equal(pages, null);
    assert.equal(calls.domainPages.length, 0);
  });

  it("onFetchedSummary called on a fetch only", async () => {
    const { makeDeps } = createHarness();
    let hookCalls = 0;
    const deps = makeDeps({
      onFetchedSummary: async (_overview) => {
        hookCalls++;
      },
    });

    const first = await profileOverview({ target: "fresh.com" }, deps);
    assert.ok(first);
    assert.equal(hookCalls, 1);

    const second = await profileOverview({ target: "fresh.com" }, deps);
    assert.ok(second);
    assert.equal(hookCalls, 1); // Not called on cache hit
  });
});
