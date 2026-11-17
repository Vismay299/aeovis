import test from "node:test";
import assert from "node:assert/strict";
import {
  extractNamesFromText,
  extractNamesFromCitations,
  discoverCompetitorNames,
  buildCompetitorLeaderboard,
  computeCoMentionMetrics,
} from "./coMentions.js";

test("extractNamesFromText finds brand-like proper nouns", () => {
  const text =
    "Leading tile brands in India include Kajaria, Somany, and RAK Ceramics for bathrooms.";
  const names = extractNamesFromText(text);
  assert.ok(names.some((n) => /kajaria/i.test(n)));
  assert.ok(names.some((n) => /somany/i.test(n)));
  assert.ok(names.some((n) => /rak/i.test(n)));
});

test("extractNamesFromCitations uses domains and sources", () => {
  const names = extractNamesFromCitations(
    ["https://www.kajaria.com/products", "https://italicatiles.com/about"],
    [{ href: "https://somanyceramics.com/x", source: "Somany Ceramics", title: "Tiles" }],
    "italicatiles.com"
  );
  assert.ok(names.some((n) => /kajaria/i.test(n)));
  assert.ok(names.some((n) => /somany/i.test(n)));
  // brand domain excluded
  assert.ok(!names.some((n) => /italica/i.test(n)));
});

test("discoverCompetitorNames excludes tracked brand and stopwords", () => {
  const results = [
    {
      is_branded_query: false,
      aio_present: true,
      aio_text:
        "Best vitrified tiles: Kajaria and Somany lead the market in India. Google lists quality brands.",
      aio_citations: ["https://kajaria.com/a", "https://somanyceramics.com/b"],
      aio_references: [],
    },
  ];
  const names = discoverCompetitorNames(
    results,
    "Italica",
    "https://italicatiles.com",
    []
  );
  assert.ok(names.some((n) => /kajaria/i.test(n)));
  assert.ok(names.some((n) => /somany/i.test(n)));
  assert.ok(!names.some((n) => /italica/i.test(n)));
  assert.ok(!names.some((n) => /^google$/i.test(n)));
});

test("buildCompetitorLeaderboard scores co-mention rates Blank-style", () => {
  const results = [
    {
      is_branded_query: false,
      aio_present: true,
      visible: false,
      aio_text: "Kajaria and Somany are top tile brands.",
      aio_citations: ["https://kajaria.com"],
      aio_references: [],
    },
    {
      is_branded_query: false,
      aio_present: true,
      visible: false,
      aio_text: "Kajaria remains popular for bathrooms.",
      aio_citations: [],
      aio_references: [],
    },
    {
      is_branded_query: false,
      aio_present: true,
      visible: true,
      aio_text: "Generic advice about floor tiles only.",
      aio_citations: [],
      aio_references: [],
    },
  ];

  const board = buildCompetitorLeaderboard({
    results,
    brand: "Italica",
    brandUrl: "italicatiles.com",
    userCompetitors: [],
    max: 10,
  });

  assert.ok(board.length >= 1);
  const kajaria = board.find((c) => /kajaria/i.test(c.name));
  assert.ok(kajaria, "Kajaria discovered");
  // appears in 2 of 3 non-branded AIOs → ~66.7%
  assert.ok(kajaria.visibilityScore >= 60);
  assert.equal(kajaria.source, "discovered");
  assert.ok(kajaria.tier);
});

test("user competitors always listed even at zero; discovered need signal", () => {
  const results = [
    {
      is_branded_query: false,
      aio_present: true,
      visible: false,
      aio_text: "Only Kajaria is mentioned here.",
      aio_citations: [],
      aio_references: [],
    },
  ];
  const board = buildCompetitorLeaderboard({
    results,
    brand: "Italica",
    brandUrl: "italicatiles.com",
    userCompetitors: ["Orient Bell"],
    max: 10,
  });
  const orient = board.find((c) => /orient/i.test(c.name));
  assert.ok(orient, "user competitor kept");
  assert.equal(orient.visibilityScore, 0);
  assert.equal(orient.source, "user");
  const kajaria = board.find((c) => /kajaria/i.test(c.name));
  assert.ok(kajaria);
  assert.equal(kajaria.source, "discovered");
});

test("computeCoMentionMetrics denom is non-branded AIOs only", () => {
  const results = [
    {
      is_branded_query: true,
      aio_present: true,
      aio_text: "Kajaria vs Italica branded query",
      aio_citations: [],
    },
    {
      is_branded_query: false,
      aio_present: true,
      visible: false,
      aio_text: "Kajaria tiles",
      aio_citations: [],
    },
  ];
  const metrics = computeCoMentionMetrics(results, ["Kajaria"], {
    userCompetitors: ["Kajaria"],
  });
  // Only 1 non-branded AIO → 100% if mentioned there
  assert.equal(metrics[0].visibilityScore, 100);
});
