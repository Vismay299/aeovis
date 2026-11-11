import test, { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  backlinksFilterBudgetError,
  EMPTY_BACKLINKS_FILTERS,
  truncateMiddle,
  formatSpamScore,
  formatDecimal,
  formatNumber,
  buildSummaryStats,
  buildBacklinksTabFilename,
  buildBacklinksTabExport,
  type BacklinksRow,
  type ReferringDomainRow,
  type BacklinksSummary,
} from "./backlinks.ts";
import { buildCsv } from "../lib/export/csv.ts";

function makeBacklinkRow(overrides: Partial<BacklinksRow> = {}): BacklinksRow {
  return {
    domainFrom: "example.org",
    urlFrom: "https://example.org/post",
    urlTo: "https://example.com/path",
    anchor: "Example",
    itemType: "organic",
    isDofollow: true,
    relAttributes: ["noopener", "noreferrer"],
    rank: 123,
    domainFromRank: 45,
    pageFromRank: 12,
    spamScore: 10,
    firstSeen: "2025-01-01",
    lastSeen: "2025-01-15",
    isLost: false,
    isBroken: false,
    linksCount: 2,
    ...overrides,
  };
}

function makeReferringDomainRow(
  overrides: Partial<ReferringDomainRow> = {},
): ReferringDomainRow {
  return {
    domain: "source.com",
    backlinks: 12,
    referringPages: 7,
    rank: 101,
    spamScore: 4,
    firstSeen: "2024-05-10",
    brokenBacklinks: 1,
    brokenPages: 0,
    ...overrides,
  };
}

function buildTabCsv(
  ...args: Parameters<typeof buildBacklinksTabExport>
): string {
  const { headers, rows } = buildBacklinksTabExport(...args);
  return buildCsv(headers, rows);
}

describe("BacklinksTable spam score formatting (zero vs missing)", () => {
  it("distinguishes zero from missing spam scores without changing boundary values", () => {
    const scores = [undefined, null, 0, 39, 40].map((score) =>
      formatSpamScore(score),
    );
    assert.deepEqual(
      scores.map((s) => s.text),
      ["—", "—", "0", "39", "40"],
    );
    assert.deepEqual(
      scores.map((s) => s.unknown),
      [true, true, false, false, false],
    );

    assert.equal(formatDecimal(null), "—");
    assert.equal(formatDecimal(undefined), "—");
    assert.equal(formatDecimal(0), "0.0");
    assert.equal(formatNumber(0), "0");
    assert.equal(formatNumber(null), "—");

    const summary: BacklinksSummary = {
      rank: null,
      backlinks: 0,
      referringPages: null,
      referringDomains: 10,
      brokenBacklinks: null,
      brokenPages: 0,
      backlinksSpamScore: null,
      targetSpamScore: 0,
      newBacklinks: null,
      lostBacklinks: null,
      newReferringDomains: null,
      lostReferringDomains: null,
    };
    const stats = buildSummaryStats({ summary });
    const targetSpamStat = stats.find((s) => s.label === "Target Spam Score");
    const backlinkSpamStat = stats.find((s) => s.label === "Backlink Spam Score");
    assert.equal(targetSpamStat?.value, "0.0");
    assert.equal(backlinkSpamStat?.value, "—");
  });
});

describe("backlinksFilterTypes (budget error handling)", () => {
  it("preserves seven saved conditions and offers recovery before a filtered request", () => {
    const values = { ...EMPTY_BACKLINKS_FILTERS, exclude: "a,b,c,d,e,f,g" };
    assert.match(
      backlinksFilterBudgetError(values, "subdomains", true) || "",
      /choose All links \(spammy included\) from Best links/,
    );
    assert.equal(backlinksFilterBudgetError(values, "subdomains", false), null);
  });

  it("accounts for subfolder conditions and accepts the exact remaining budget", () => {
    const values = { ...EMPTY_BACKLINKS_FILTERS, exclude: "a,b" };
    assert.equal(backlinksFilterBudgetError(values, "subfolder", true), null);
    assert.match(
      backlinksFilterBudgetError(
        { ...values, exclude: "a,b,c" },
        "subfolder",
        true,
      ) || "",
      /2-condition limit/,
    );
  });
});

describe("truncateMiddle", () => {
  it("never returns a string longer than maxLength", () => {
    const value = "/very/long/path/segment/that/keeps/going/here";
    for (let maxLength = 0; maxLength <= value.length; maxLength++) {
      assert.ok(truncateMiddle(value, maxLength).length <= maxLength);
    }
  });

  it("keeps head and tail around a middle ellipsis", () => {
    assert.equal(truncateMiddle("abcdefghijklmno", 10), "abc...mno");
    assert.equal(truncateMiddle("/very/long/path/segment/here", 12), "/ver...here");
  });
});

describe("buildBacklinksTabFilename", () => {
  it("normalizes the target into the filename per tab", () => {
    assert.equal(
      buildBacklinksTabFilename("backlinks", "https://Example.com/path?q=1"),
      "backlinks-backlinks-example.com-path-q-1",
    );
    assert.equal(
      buildBacklinksTabFilename("domains", "Example.com"),
      "backlinks-referring-domains-example.com",
    );
    assert.equal(
      buildBacklinksTabFilename("pages", "docs.example.com"),
      "backlinks-top-pages-docs.example.com",
    );
  });
});

describe("buildBacklinksTabExport", () => {
  it("builds backlinks csv with backlink-specific columns", () => {
    const content = buildTabCsv({
      tab: "backlinks",
      rows: {
        backlinks: [makeBacklinkRow()],
        referringDomains: [],
        topPages: [],
      },
    });

    assert.ok(content.includes('"Domain","Source URL","Target URL"'));
    assert.ok(!content.includes('"Ahrefs DR"'));
    assert.ok(content.includes('"example.org"'));
    assert.ok(content.includes('"noopener, noreferrer"'));
  });

  it("includes an Ahrefs DR column when ratings are loaded", () => {
    const content = buildTabCsv({
      tab: "domains",
      domainRatings: { "source.com": 71.5, "other.com": null },
      rows: {
        backlinks: [],
        referringDomains: [makeReferringDomainRow()],
        topPages: [],
      },
    });

    assert.ok(content.includes('"Rank","Ahrefs DR","Spam Score"'));
    assert.ok(content.includes('"71.5"'));
  });

  it("keys backlink Ahrefs DR off the www-stripped source domain", () => {
    const content = buildTabCsv({
      tab: "backlinks",
      domainRatings: { "example.org": 33 },
      rows: {
        backlinks: [makeBacklinkRow({ domainFrom: "www.example.org" })],
        referringDomains: [],
        topPages: [],
      },
    });

    assert.ok(content.includes('"Domain Rank","Ahrefs DR","Source Page Rank"'));
    assert.ok(content.includes('"33"'));
  });

  it("builds referring domains csv", () => {
    const content = buildTabCsv({
      tab: "domains",
      rows: {
        backlinks: [],
        referringDomains: [makeReferringDomainRow()],
        topPages: [],
      },
    });

    assert.ok(content.includes('"Domain","Backlinks","Referring Pages"'));
    assert.ok(content.includes('"source.com"'));
  });

  it("builds top pages csv", () => {
    const content = buildTabCsv({
      tab: "pages",
      rows: {
        backlinks: [],
        referringDomains: [],
        topPages: [
          {
            page: "https://docs.example.com/start",
            backlinks: 22,
            referringDomains: 9,
            rank: 88,
            brokenBacklinks: 0,
          },
        ],
      },
    });

    assert.ok(
      content.includes(
        '"Page","Backlinks","Referring Domains","Rank","Broken Backlinks"',
      ),
    );
    assert.ok(content.includes('"https://docs.example.com/start"'));
  });
});
