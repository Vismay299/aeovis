import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  keywordResearchHeaders,
  KEYWORD_RESEARCH_HEADERS,
  SAVED_KEYWORD_EXPORT_HEADERS,
  keywordResearchExportRow,
  savedKeywordExportRow,
  formatCentsForCsv,
  type SavedKeywordRow,
  type KeywordResearchRow,
} from "./keywords.ts";

describe("keywords export mapping and headers", () => {
  it("generates national and local research headers", () => {
    assert.deepEqual(KEYWORD_RESEARCH_HEADERS, [
      "Keyword",
      "Volume",
      "CPC",
      "Competition",
      "Score",
      "Intent",
    ]);

    const localHeaders = keywordResearchHeaders("Springfield,Illinois,United States");
    assert.deepEqual(localHeaders, [
      "Keyword",
      "Volume (Springfield, Illinois, United States)",
      "CPC (Springfield, Illinois, United States)",
      "Competition (Springfield, Illinois, United States)",
      "Score",
      "Intent",
    ]);
  });

  it("exports keyword research row correctly", () => {
    const row: KeywordResearchRow = {
      keyword: "best shoes",
      searchVolume: 12000,
      trend: [{ year: 2026, month: 1, searchVolume: 12000 }],
      keywordDifficulty: 45,
      cpc: 1.54,
      competition: 0.8,
      intent: "commercial",
    };

    const exported = keywordResearchExportRow(row);
    assert.deepEqual(exported, [
      "best shoes",
      12000,
      1.54,
      0.8,
      45,
      "commercial",
    ]);
  });

  it("exports saved keyword row and formats CPC/competition to 2 decimal places in CSV", () => {
    assert.deepEqual(SAVED_KEYWORD_EXPORT_HEADERS, [
      "Keyword",
      "Volume",
      "CPC",
      "Competition",
      "Score",
      "Intent",
      "Tags",
      "Fetched At",
    ]);

    const savedRow: SavedKeywordRow = {
      id: "kw-1",
      keyword: "oversized tees",
      locationCode: 2840,
      languageCode: "en",
      createdAt: "2026-11-10T00:00:00.000Z",
      searchVolume: 8100,
      cpc: 0.4,
      competition: 0.12345,
      keywordDifficulty: 25,
      intent: "transactional",
      monthlySearches: [],
      fetchedAt: "2026-11-10T12:00:00.000Z",
      tags: [
        { id: "t1", name: "Fashion", normalizedName: "fashion", color: "blue" },
        { id: "t2", name: "Tops", normalizedName: "tops", color: "green" },
      ],
    };

    const rowValues = savedKeywordExportRow(savedRow);
    assert.deepEqual(rowValues, [
      "oversized tees",
      8100,
      0.4,
      0.12345,
      25,
      "transactional",
      "Fashion, Tops",
      "2026-11-10T12:00:00.000Z",
    ]);

    const formatted = formatCentsForCsv([rowValues]);
    // Column 2 (CPC) and Column 3 (Competition) formatted with 2 decimal places
    assert.deepEqual(formatted[0], [
      "oversized tees",
      8100,
      "0.40",
      "0.12",
      25,
      "transactional",
      "Fashion, Tops",
      "2026-11-10T12:00:00.000Z",
    ]);
  });

  it("handles null and empty values in saved keyword export", () => {
    const emptyRow: SavedKeywordRow = {
      id: "kw-2",
      keyword: "unknown term",
      locationCode: 2840,
      languageCode: "en",
      createdAt: "2026-11-10T00:00:00.000Z",
      searchVolume: null,
      cpc: null,
      competition: null,
      keywordDifficulty: null,
      intent: null,
      monthlySearches: [],
      fetchedAt: null,
      tags: [],
    };

    const rowValues = savedKeywordExportRow(emptyRow);
    assert.deepEqual(rowValues, [
      "unknown term",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
    ]);

    const formatted = formatCentsForCsv([rowValues]);
    assert.deepEqual(formatted[0], [
      "unknown term",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
    ]);
  });
});
