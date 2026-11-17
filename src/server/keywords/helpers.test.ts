import test, { describe, it } from "node:test";
import assert from "node:assert/strict";
import { interleaveRows, normalizeIntent, normalizeKeyword, type EnrichedKeyword } from "./helpers.ts";

const row = (keyword: string): EnrichedKeyword => ({
  keyword,
  searchVolume: 1000,
  trend: [{ year: 2026, month: 7, searchVolume: 1000 }],
  cpc: 1.5,
  competition: 0.4,
  keywordDifficulty: 20,
  intent: "informational",
});

describe("helpers", () => {
  it("normalizes keywords", () => {
    assert.equal(normalizeKeyword("  Hello World  "), "hello world");
  });

  it("normalizes intent across variants", () => {
    assert.equal(normalizeIntent("informational"), "informational");
    assert.equal(normalizeIntent("Commercial search"), "commercial");
    assert.equal(normalizeIntent("TRANSACTIONAL"), "transactional");
    assert.equal(normalizeIntent("navigational query"), "navigational");
    assert.equal(normalizeIntent(null), "unknown");
    assert.equal(normalizeIntent("other"), "unknown");
  });

  describe("interleaveRows", () => {
    const cases = [
      {
        name: "alternates sources, dedupes by keyword, and respects the limit",
        first: ["a", "b", "c"],
        second: ["x", "a", "y"],
        limit: 4,
        expected: ["a", "x", "b", "c"],
      },
      {
        name: "drains the longer source when the other runs out",
        first: ["a"],
        second: ["x", "y", "z"],
        limit: 10,
        expected: ["a", "x", "y", "z"],
      },
    ];

    for (const c of cases) {
      it(c.name, () => {
        const rows = interleaveRows(c.first.map(row), c.second.map(row), c.limit);
        assert.deepEqual(rows.map((r) => r.keyword), c.expected);
      });
    }
  });
});
