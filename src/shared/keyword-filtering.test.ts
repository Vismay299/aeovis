import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { KeywordIntent, KeywordResearchRow } from "./keywords.ts";
import {
  EMPTY_FILTERS,
  parseIntentFilter,
  toggleIntentFilter,
  applyKeywordFiltersAndSort,
  groupSharedVolumeRows,
  keywordResearchPageEnds,
  lastTwelveMonths,
  formatNumber,
  formatCompactNumber,
  type KeywordResearchDisplayRow,
  type KeywordFilterValues,
} from "./keyword-filtering.ts";

const SERIES = [
  { year: 2026, month: 7, searchVolume: 110000 },
  { year: 2026, month: 8, searchVolume: 90500 },
];

function makeRow(overrides: Partial<KeywordResearchRow>): KeywordResearchRow {
  return {
    keyword: "caregiving",
    searchVolume: 110000,
    trend: SERIES,
    keywordDifficulty: 61,
    cpc: 8.14,
    competition: 0.27,
    intent: "informational",
    ...overrides,
  };
}

describe("groupSharedVolumeRows", () => {
  it("keeps variants visible after their leader with their own metrics", () => {
    const rows = [
      makeRow({ keyword: "caregiving" }),
      makeRow({ keyword: "respite care", searchVolume: 165000 }),
      makeRow({ keyword: "caregiver", keywordDifficulty: 45 }),
    ];

    const grouped = groupSharedVolumeRows(rows, undefined, true);

    assert.deepEqual(grouped.map((r) => r.keyword), [
      "caregiving",
      "caregiver",
      "respite care",
    ]);
    assert.deepEqual(grouped[1], {
      ...rows[2],
      parentKeyword: "caregiving",
    });
    assert.equal(grouped[0].parentKeyword, null);
    assert.equal(grouped[2].parentKeyword, null);

    const ungrouped = groupSharedVolumeRows(rows, "caregiver", false);
    assert.deepEqual(
      ungrouped,
      rows.map((k) => ({ ...k, parentKeyword: null })),
    );
  });

  it("leads a group with the searched keyword as typed", () => {
    const rows = [
      makeRow({ keyword: "caregiver" }),
      makeRow({ keyword: "caregiving" }),
    ];

    const [group, child] = groupSharedVolumeRows(rows, " Caregiving", true);

    assert.equal(group.keyword, "caregiving");
    assert.deepEqual(child, {
      ...rows[0],
      parentKeyword: "caregiving",
    });
  });

  it("keeps rows apart when the shared number is a flat or low-volume bucket", () => {
    const flat = [{ year: 2026, month: 8, searchVolume: 5400 }];
    const rows = [
      makeRow({ keyword: "a", searchVolume: 5400, trend: flat }),
      makeRow({ keyword: "b", searchVolume: 5400, trend: flat }),
      makeRow({ keyword: "c", searchVolume: 90 }),
      makeRow({ keyword: "d", searchVolume: 90 }),
    ];

    assert.equal(groupSharedVolumeRows(rows, undefined, true).length, 4);
  });
});

describe("keywordResearchPageEnds", () => {
  function pageRow(
    keyword: string,
    parentKeyword: string | null = null,
  ): KeywordResearchDisplayRow {
    return {
      keyword,
      parentKeyword,
      searchVolume: null,
      cpc: null,
      competition: null,
      keywordDifficulty: null,
      intent: "unknown",
      trend: [],
    };
  }

  it("keeps the boundary parent and all its children on the same page", () => {
    const rows = [
      ...Array.from({ length: 49 }, (_, index) => pageRow(String(index))),
      pageRow("parent"),
      pageRow("child1", "parent"),
      pageRow("child2", "parent"),
      ...Array.from({ length: 50 }, (_, index) => pageRow(`next${index}`)),
    ];
    const ends = keywordResearchPageEnds(rows, 50);
    assert.deepEqual(ends, [52, 102]);
    const pages = ends.map((end, index) => rows.slice(ends[index - 1] ?? 0, end));
    assert.deepEqual(pages.flat(), rows);
    assert.equal(pages.every((page) => page[0].parentKeyword === null), true);
  });

  it("allows an oversized family and retains ordinary boundaries with grouping off", () => {
    const rows = [
      pageRow("parent"),
      pageRow("one", "parent"),
      pageRow("two", "parent"),
      pageRow("next"),
    ];
    assert.deepEqual(keywordResearchPageEnds(rows, 2), [3, 4]);
    assert.deepEqual(
      keywordResearchPageEnds(
        rows.map((item) => ({ ...item, parentKeyword: null })),
        2,
      ),
      [2, 4],
    );
    assert.deepEqual(keywordResearchPageEnds([], 50), []);
  });
});

describe("toggleIntentFilter and parseIntentFilter", () => {
  it("adds and removes intents while keeping canonical order", () => {
    assert.deepEqual(parseIntentFilter("transactional,informational"), [
      "informational",
      "transactional",
    ]);
    assert.equal(
      toggleIntentFilter("transactional", "informational"),
      "informational,transactional",
    );
    assert.equal(
      toggleIntentFilter("informational,transactional", "informational"),
      "transactional",
    );
  });
});

describe("applyKeywordFiltersAndSort", () => {
  const testRows: KeywordResearchRow[] = [
    makeRow({ keyword: "buy running shoes", intent: "transactional", searchVolume: 500, cpc: 2.0, keywordDifficulty: 40 }),
    makeRow({ keyword: "best running shoes", intent: "commercial", searchVolume: 800, cpc: 1.5, keywordDifficulty: 50 }),
    makeRow({ keyword: "how to run", intent: "informational", searchVolume: 1200, cpc: 0.5, keywordDifficulty: 20 }),
    makeRow({ keyword: "nike store", intent: "navigational", searchVolume: 2000, cpc: 3.0, keywordDifficulty: 60 }),
    makeRow({ keyword: "mystery term", intent: "unknown", searchVolume: null, cpc: null, keywordDifficulty: null }),
  ];

  it("filters by intent and sorts by keyword ascending", () => {
    const res = applyKeywordFiltersAndSort({
      rows: testRows,
      filters: { ...EMPTY_FILTERS, intents: "transactional,commercial" },
      sortField: "keyword",
      sortDir: "asc",
    });
    assert.deepEqual(res.map((r) => r.keyword), [
      "best running shoes",
      "buy running shoes",
    ]);
  });

  it("filters by volume range", () => {
    const res = applyKeywordFiltersAndSort({
      rows: testRows,
      filters: { ...EMPTY_FILTERS, minVol: "700", maxVol: "1500" },
      sortField: "searchVolume",
      sortDir: "desc",
    });
    assert.deepEqual(res.map((r) => r.keyword), [
      "how to run",
      "best running shoes",
    ]);
  });

  it("handles null values as -1 in sorting", () => {
    const res = applyKeywordFiltersAndSort({
      rows: testRows,
      filters: EMPTY_FILTERS,
      sortField: "searchVolume",
      sortDir: "asc",
    });
    assert.equal(res[0].keyword, "mystery term");
  });
});

describe("format helpers", () => {
  it("formats numbers and handles null with em-dash", () => {
    assert.equal(formatNumber(null), "—");
    assert.equal(formatNumber(undefined), "—");
    assert.equal(formatNumber(12500), "12,500");

    assert.equal(formatCompactNumber(null), "—");
    assert.equal(formatCompactNumber(undefined), "—");
    assert.equal(formatCompactNumber(1250000), "1.3M");
  });

  it("lastTwelveMonths sorts and returns last 12", () => {
    const trend = Array.from({ length: 15 }, (_, i) => ({
      year: 2025,
      month: i + 1,
      searchVolume: i * 100,
    }));
    const sliced = lastTwelveMonths(trend);
    assert.equal(sliced.length, 12);
    assert.equal(sliced[0].month, 4);
    assert.equal(sliced[11].month, 15);
  });
});
