import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  estimateBacklinksLookupRun,
  estimateBacklinksPage,
  estimateBacklinksExpandDomain,
  estimateBacklinksSnapshotsTrack,
} from "./backlinks.ts";
import { getPricedAction } from "../pricedActions.ts";
import type { PricingContext } from "../pricedActions.ts";
import "./index.ts";

function createMockContext(brandKey = "brand_1"): PricingContext {
  return {
    brandKey,
    admin: {} as any,
    env: {},
    now: new Date("2026-10-21T09:30:00.000Z"),
  };
}

describe("backlinks pricing actions", () => {
  it("registers actions in priced actions registry with correct keys, features, and approval rules", () => {
    const lookup = getPricedAction("backlinks.lookup.run");
    assert.ok(lookup);
    assert.equal(lookup.feature, "backlinks.research");
    assert.equal(lookup.requireApproval, false);

    const page = getPricedAction("backlinks.page");
    assert.ok(page);
    assert.equal(page.feature, "backlinks.research");
    assert.equal(page.requireApproval, false);

    const expand = getPricedAction("backlinks.expand_domain");
    assert.ok(expand);
    assert.equal(expand.feature, "backlinks.research");
    assert.equal(expand.requireApproval, false);

    const snapshots = getPricedAction("backlinks.snapshots.track");
    assert.ok(snapshots);
    assert.equal(snapshots.feature, "backlinks.snapshots");
    assert.equal(snapshots.requireApproval, true);
  });

  it("calculates worked example $0.087012 for offcult.in, subdomains, 50 backlinks with fixed clock", async () => {
    const ctx = createMockContext();
    const fixedNow = new Date("2026-10-21T09:30:00.000Z");
    const quote = await estimateBacklinksLookupRun(
      ctx,
      {
        target: "offcult.in",
        scope: "subdomains",
        tab: "backlinks",
        pageSize: 50,
      },
      {
        now: () => fixedNow,
        findRecentResearch: async () => null,
      },
    );

    assert.equal(quote.blocked, null);
    // Summary 0.024036 + History 0.037176 + First page 0.0258 = $0.087012
    assert.equal(quote.totalUsd, 0.087012);
    assert.equal(quote.lines.length, 3);
    assert.equal(quote.lines[0].label, "Backlink summary");
    assert.equal(quote.lines[0].quantity, 1);
    assert.equal(quote.lines[0].totalUsd, 0.024036);

    assert.equal(quote.lines[1].label, "12 months of history");
    assert.equal(quote.lines[1].quantity, 1);
    assert.equal(quote.lines[1].totalUsd, 0.037176);

    assert.equal(quote.lines[2].label, "First 50 backlinks");
    assert.equal(quote.lines[2].quantity, 1);
    assert.equal(quote.lines[2].totalUsd, 0.0258);

    assert.equal(quote.warnings.length, 1);
    assert.equal(quote.warnings[0].code, "cache_note");
    assert.equal(
      quote.warnings[0].message,
      "Looking up the same target again within 6 hours is free.",
    );
  });

  it("calculates exact URL quote (summary only, no history)", async () => {
    const ctx = createMockContext();
    const quote = await estimateBacklinksLookupRun(
      ctx,
      {
        target: "https://example.com/some-page",
        scope: "exact_url",
        tab: "backlinks",
        pageSize: 50,
      },
      {
        findRecentResearch: async () => null,
      },
    );

    assert.equal(quote.blocked, null);
    assert.equal(quote.lines.length, 2);
    assert.equal(quote.lines[0].label, "Backlink summary");
    assert.equal(quote.lines[0].totalUsd, 0.024036);
    assert.equal(quote.lines[1].label, "First 50 backlinks");
    assert.equal(quote.lines[1].totalUsd, 0.0258);
    assert.equal(quote.totalUsd, 0.049836);
  });

  it("calculates subfolder quote (filtered backlink totals 2 requests, no history)", async () => {
    const ctx = createMockContext();
    const quote = await estimateBacklinksLookupRun(
      ctx,
      {
        target: "example.com/blog",
        scope: "subfolder",
        tab: "backlinks",
        pageSize: 50,
      },
      {
        findRecentResearch: async () => null,
      },
    );

    assert.equal(quote.blocked, null);
    assert.equal(quote.lines.length, 2);
    assert.equal(
      quote.lines[0].label,
      "Filtered backlink totals (2 requests)",
    );
    assert.equal(quote.lines[0].quantity, 2);
    assert.equal(quote.lines[0].unitUsd, 0.024036);
    assert.equal(quote.lines[0].totalUsd, 0.048072);
    assert.equal(quote.lines[1].label, "First 50 backlinks");
    assert.equal(quote.lines[1].totalUsd, 0.0258);
    assert.equal(quote.totalUsd, 0.073872);
  });

  it("blocks subfolder on referring domains tab with subfolder_not_supported", async () => {
    const ctx = createMockContext();
    const quote = await estimateBacklinksLookupRun(
      ctx,
      {
        target: "example.com/blog",
        scope: "subfolder",
        tab: "domains",
        pageSize: 50,
      },
      {
        findRecentResearch: async () => null,
      },
    );

    assert.ok(quote.blocked);
    assert.equal(quote.blocked.code, "subfolder_not_supported");
    assert.equal(
      quote.blocked.message,
      "Referring domains can't be broken down for a subfolder — use the Backlinks tab, or switch to Domain or Subdomains scope.",
    );
    assert.equal(quote.totalUsd, 0);
  });

  it("blocks invalid target with invalid_target", async () => {
    const ctx = createMockContext();
    const quote = await estimateBacklinksLookupRun(ctx, {
      target: "https://example.com/page?query=1",
      scope: "exact_url",
      tab: "backlinks",
      pageSize: 50,
    });

    assert.ok(quote.blocked);
    assert.equal(quote.blocked.code, "invalid_target");
    assert.equal(quote.totalUsd, 0);
  });

  it("includes recent_research warning when previous research within 90 days exists", async () => {
    const ctx = createMockContext();
    const quote = await estimateBacklinksLookupRun(
      ctx,
      {
        target: "example.com",
        scope: "domain",
        tab: "backlinks",
        pageSize: 50,
      },
      {
        findRecentResearch: async () => ({
          id: "rec-1",
          entryDate: "2026-10-10",
          summary: "Backlinks for example.com: 1200 backlinks from 80 domains.",
          spendUsd: 0.05,
          createdAt: "2026-10-10T10:00:00Z",
        }),
      },
    );

    assert.equal(quote.warnings.length, 2);
    assert.equal(quote.warnings[0].code, "cache_note");
    assert.equal(quote.warnings[1].code, "recent_research");
    assert.equal(
      quote.warnings[1].message,
      "You looked this up on 2026-10-10: Backlinks for example.com: 1200 backlinks from 80 domains.",
    );
  });

  it("calculates backlinks.page for backlinks, domains, and pages tabs", async () => {
    const ctx = createMockContext();

    const blPage = await estimateBacklinksPage(ctx, {
      tab: "backlinks",
      pageSize: 50,
    });
    assert.equal(blPage.totalUsd, 0.0258);
    assert.equal(blPage.lines[0].label, "50 backlinks");

    const domainsPage = await estimateBacklinksPage(ctx, {
      tab: "domains",
      pageSize: 100,
    });
    // 0.024 + 100 * 0.000036 = 0.0276
    assert.equal(domainsPage.totalUsd, 0.0276);
    assert.equal(domainsPage.lines[0].label, "100 referring domains");

    const pagesPage = await estimateBacklinksPage(ctx, {
      tab: "pages",
      pageSize: 200,
    });
    // 0.024 + 200 * 0.000036 = 0.0312
    assert.equal(pagesPage.totalUsd, 0.0312);
    assert.equal(pagesPage.lines[0].label, "200 top pages");
  });

  it("calculates backlinks.expand_domain up to 100 links", async () => {
    const ctx = createMockContext();
    const expand = await estimateBacklinksExpandDomain(ctx, {});
    // 0.024 + 100 * 0.000036 = 0.0276
    assert.equal(expand.totalUsd, 0.0276);
    assert.equal(
      expand.lines[0].label,
      "All links from one domain (up to 100)",
    );
  });

  it("projects four weekly summary calls per month and requires approval", async () => {
    const ctx = createMockContext();
    const quote = await estimateBacklinksSnapshotsTrack(ctx, {
      target: "offcult.in",
      scope: "subdomains",
      interval: "weekly",
    });
    assert.equal(quote.blocked, null);
    assert.equal(quote.monthly?.runsPerMonth, 4);
    assert.equal(quote.monthly?.totalUsd, quote.totalUsd);
    assert.equal(quote.lines[0].label, "Backlink summary for offcult.in");
    assert.equal(quote.lines[0].quantity, 4);
    assert.equal(quote.totalUsd, 0.096144);
  });
});
