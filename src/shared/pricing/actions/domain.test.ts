import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  estimateDomainLookupRun,
  estimateDomainKeywordsPage,
  estimateDomainPagesPage,
  estimateDomainCompetitorsRun,
} from "./domain.ts";
import { getPricedAction } from "../pricedActions.ts";
import type { PricingContext } from "../pricedActions.ts";

function createMockContext(brandKey = "brand_1"): PricingContext {
  return {
    brandKey,
    admin: {} as any,
    env: {},
    now: new Date("2026-10-21T09:30:00.000Z"),
  };
}

describe("domain pricing actions", () => {
  it("registers actions in priced actions registry with correct keys, features, and approval rules", () => {
    const lookup = getPricedAction("domain.lookup.run");
    assert.ok(lookup);
    assert.equal(lookup.feature, "domain.research");
    assert.equal(lookup.requireApproval, false);

    const kwPage = getPricedAction("domain.keywords.page");
    assert.ok(kwPage);
    assert.equal(kwPage.feature, "domain.research");
    assert.equal(kwPage.requireApproval, false);

    const pagesPage = getPricedAction("domain.pages.page");
    assert.ok(pagesPage);
    assert.equal(pagesPage.feature, "domain.research");
    assert.equal(pagesPage.requireApproval, false);

    const competitors = getPricedAction("domain.competitors.run");
    assert.ok(competitors);
    assert.equal(competitors.feature, "domain.competitors");
    assert.equal(competitors.requireApproval, true);
  });

  it("calculates worked example $0.03012 for offcult.in, India, page size 50 (keywords tab)", async () => {
    const ctx = createMockContext();
    const quote = await estimateDomainLookupRun(
      ctx,
      {
        domain: "offcult.in",
        locationCode: 2356,
        languageCode: "en",
        tab: "keywords",
        pageSize: 50,
      },
      {
        findRecentResearch: async () => null,
      },
    );

    assert.equal(quote.blocked, null);
    // Overview $0.01212 + Keywords $0.018 = $0.03012
    assert.equal(quote.totalUsd, 0.03012);
    assert.equal(quote.lines.length, 2);
    assert.equal(quote.lines[0].label, "Domain overview");
    assert.equal(quote.lines[0].totalUsd, 0.01212);
    assert.equal(quote.lines[1].label, "First 50 ranked keywords");
    assert.equal(quote.lines[1].totalUsd, 0.018);

    assert.equal(quote.warnings.length, 1);
    assert.equal(quote.warnings[0].code, "cache_note");
    assert.equal(
      quote.warnings[0].message,
      "Looking up the same domain and market again within 12 hours is free.",
    );
  });

  it("calculates pages tab lines for domain.lookup.run", async () => {
    const ctx = createMockContext();
    const quote = await estimateDomainLookupRun(
      ctx,
      {
        domain: "offcult.in",
        locationCode: 2356,
        languageCode: "en",
        tab: "pages",
        pageSize: 50,
      },
      {
        findRecentResearch: async () => null,
      },
    );

    assert.equal(quote.blocked, null);
    assert.equal(quote.totalUsd, 0.03012);
    assert.equal(quote.lines.length, 2);
    assert.equal(quote.lines[0].label, "Domain overview");
    assert.equal(quote.lines[1].label, "First 50 top pages");
  });

  it("calculates competitors tab line for domain.lookup.run (no second line)", async () => {
    const ctx = createMockContext();
    const quote = await estimateDomainLookupRun(
      ctx,
      {
        domain: "offcult.in",
        locationCode: 2356,
        languageCode: "en",
        tab: "competitors",
        pageSize: 50,
      },
      {
        findRecentResearch: async () => null,
      },
    );

    assert.equal(quote.blocked, null);
    assert.equal(quote.totalUsd, 0.01212);
    assert.equal(quote.lines.length, 1);
    assert.equal(quote.lines[0].label, "Domain overview");
  });

  it("blocks invalid target with invalid_target message", async () => {
    const ctx = createMockContext();
    const quote = await estimateDomainLookupRun(ctx, {
      domain: "example.por",
      tab: "keywords",
      pageSize: 50,
    });

    assert.ok(quote.blocked);
    assert.equal(quote.blocked.code, "invalid_target");
    assert.equal(quote.blocked.message, "Enter a valid domain like example.com");
    assert.equal(quote.totalUsd, 0);
  });

  it("warns recent_research when one exists within 90 days", async () => {
    const ctx = createMockContext();
    const quote = await estimateDomainLookupRun(
      ctx,
      {
        domain: "offcult.in",
        locationCode: 2356,
        languageCode: "en",
        tab: "keywords",
        pageSize: 50,
      },
      {
        findRecentResearch: async () => ({
          id: "res_1",
          entryDate: "2026-10-15",
          summary: "312 organic keywords",
          spendUsd: 0.03,
          createdAt: "2026-10-15T10:00:00Z",
        }),
      },
    );

    assert.equal(quote.warnings.length, 2);
    const recent = quote.warnings.find((w) => w.code === "recent_research");
    assert.ok(recent);
    assert.equal(
      recent.message,
      "You looked this up on 2026-10-15: 312 organic keywords",
    );
  });

  it("estimates domain.keywords.page correctly", async () => {
    const ctx = createMockContext();
    const quote = await estimateDomainKeywordsPage(ctx, {
      domain: "offcult.in",
      pageSize: 50,
    });
    assert.equal(quote.totalUsd, 0.018);
    assert.equal(quote.lines[0].label, "50 ranked keywords");
  });

  it("estimates domain.pages.page correctly", async () => {
    const ctx = createMockContext();
    const quote = await estimateDomainPagesPage(ctx, {
      domain: "offcult.in",
      pageSize: 50,
    });
    assert.equal(quote.totalUsd, 0.018);
    assert.equal(quote.lines[0].label, "50 top pages");
  });

  it("estimates domain.competitors.run correctly with cache_note warning", async () => {
    const ctx = createMockContext();
    const quote = await estimateDomainCompetitorsRun(ctx, {
      domain: "offcult.in",
      keywordCount: 50,
      limit: 50,
    });
    assert.equal(quote.totalUsd, 0.018);
    assert.equal(
      quote.lines[0].label,
      "Competitor analysis across 50 keywords (up to 50 domains)",
    );
    assert.equal(quote.warnings.length, 1);
    assert.equal(quote.warnings[0].code, "cache_note");
    assert.equal(
      quote.warnings[0].message,
      "The same keywords and market are reused for 12 hours.",
    );
  });
});
