import test from "node:test";
import assert from "node:assert/strict";
import { countRowCitations, summarizeSources } from "./sourcesMetrics.js";

/**
 * R2.7.2 (finding A10) — "Sources cited: 0" beside "Distinct domains: 14".
 *
 * The rows below are the shape src/lib/scoring/enginePipeline.js actually
 * produces and scanWorker.js stores verbatim in raw_results.results: no
 * `aio_citations` key anywhere, `references` carrying the URLs, `citations`
 * carrying their deduped hrefs.
 */
const v9AioRow = () => ({
  engine: "aio",
  prompt: "best vitrified tiles in india",
  answer_present: true,
  aio_present: true,
  text: "…",
  citations: ["https://kajaria.com/tiles", "https://somany.com/a"],
  references: [
    { href: "https://kajaria.com/tiles", title: "Tiles", source: "Kajaria", domain: "kajaria.com" },
    { href: "https://somany.com/a", title: "A", source: "Somany", domain: "somany.com" },
    { href: "https://kajaria.com/tiles?utm=1", title: "Tiles", source: "Kajaria", domain: "kajaria.com" },
  ],
});

const v8Row = () => ({
  aio_present: true,
  aio_citations: ["https://acme.com/page"],
  aio_references: [{ href: "https://acme.com/page", domain: "acme.com" }],
});

test("countRowCitations reads the v9 field names the pipeline writes", () => {
  // references first: they are what top_domains is aggregated from.
  assert.equal(countRowCitations(v9AioRow()), 3);
});

test("countRowCitations falls back to citations when a row has no references", () => {
  assert.equal(countRowCitations({ citations: ["https://a.com", "https://b.com"] }), 2);
  assert.equal(countRowCitations({ aioCitations: ["https://a.com"], references: [] }), 1);
});

test("countRowCitations still reads legacy v8 rows", () => {
  assert.equal(countRowCitations(v8Row()), 1);
});

test("countRowCitations separates a measured zero from a row that was never counted", () => {
  // An answered prompt the engine cited nothing in: arrays present, empty.
  assert.equal(countRowCitations({ aio_present: true, citations: [], references: [] }), 0);
  // A row carrying no citation list of any vintage was never counted.
  assert.equal(countRowCitations({ aio_present: true, text: "…" }), null);
  assert.equal(countRowCitations(null), null);
});

test("summarizeSources counts a v9 scan instead of reporting zero", () => {
  const summary = summarizeSources({
    rawResults: [v9AioRow(), v9AioRow()],
    topDomains: [
      { domain: "kajaria.com", count: 2, type: "brand" },
      { domain: "somany.com", count: 2, type: "competitor" },
    ],
  });
  assert.equal(summary.state, "measured");
  assert.equal(summary.totalCitations, 6);
});

test("summarizeSources reports a real measured zero as zero", () => {
  const summary = summarizeSources({
    rawResults: [{ aio_present: true, citations: [], references: [] }],
    topDomains: [],
  });
  assert.equal(summary.state, "measured");
  assert.equal(summary.totalCitations, 0);
});

test("summarizeSources reports never-counted as null, not zero", () => {
  const noRows = summarizeSources({ rawResults: [], topDomains: [] });
  assert.equal(noRows.state, "not_recorded");
  assert.equal(noRows.totalCitations, null);
  assert.match(noRows.note, /never counted/);

  const noLists = summarizeSources({
    rawResults: [{ aio_present: true, text: "…" }],
    topDomains: [],
  });
  assert.equal(noLists.state, "not_recorded");
  assert.equal(noLists.totalCitations, null);
});

test("A10 — the contradiction is unreachable: no number is emitted below the domain count", () => {
  // The exact reported symptom: rows the view cannot count, 14 aggregated
  // domains. It must not answer "0".
  const domains = Array.from({ length: 14 }, (_, i) => ({
    domain: `d${i}.com`,
    count: 1,
    type: "third_party",
  }));

  const deadFieldRows = summarizeSources({
    rawResults: [{ aio_present: true, text: "…" }, { aio_present: true, text: "…" }],
    topDomains: domains,
  });
  assert.equal(deadFieldRows.totalCitations, null);
  assert.equal(deadFieldRows.state, "not_recorded");

  const emptyListRows = summarizeSources({
    rawResults: [{ citations: [], references: [] }],
    topDomains: domains,
  });
  assert.equal(emptyListRows.totalCitations, null);
  assert.equal(emptyListRows.state, "inconsistent");
  assert.match(emptyListRows.note, /14 distinct domains/);

  // And a partial count that still cannot account for the domains is refused
  // rather than printed.
  const partial = summarizeSources({
    rawResults: [{ citations: ["https://d0.com/a", "https://d1.com/b"] }],
    topDomains: domains,
  });
  assert.equal(partial.totalCitations, null);
  assert.equal(partial.state, "inconsistent");
});

test("A10 — every measured total is consistent with the domain count it renders beside", () => {
  const rowShapes = [
    v9AioRow(),
    v8Row(),
    { citations: [], references: [] },
    { aio_present: true, text: "…" },
    { references: [{ href: "https://x.com/1", domain: "x.com" }] },
    null,
  ];
  for (let mask = 0; mask < 1 << rowShapes.length; mask += 1) {
    const rawResults = rowShapes.filter((_, i) => mask & (1 << i));
    for (let domainCount = 0; domainCount <= 6; domainCount += 1) {
      const topDomains = Array.from({ length: domainCount }, (_, i) => ({
        domain: `d${i}.com`,
        count: 1,
        type: "third_party",
      }));
      const { totalCitations, state } = summarizeSources({ rawResults, topDomains });
      if (state !== "measured") {
        assert.equal(totalCitations, null, "a non-measured state must render as an em dash");
        continue;
      }
      assert.ok(
        totalCitations >= domainCount,
        `measured total ${totalCitations} contradicts ${domainCount} distinct domains`
      );
    }
  }
});
