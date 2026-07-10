import test from "node:test";
import assert from "node:assert/strict";
import {
  countCompetitorsFound,
  isCompetitorsConfigured,
  normalizeResult,
} from "./api.js";
import {
  isBrandPresenceQuery,
  resolveQueryIntentTier,
  buildBrandedQueries,
} from "../lib/scoring/aioQueryClassify.js";

test("countCompetitorsFound — only competitors with AIO signal", () => {
  const competitors = [
    { name: "Alpha", visibilityScore: 12.5, mentions: 1, citations: 0 },
    { name: "Beta", visibilityScore: 0, mentions: 0, citations: 0 },
    { name: "Gamma", visibilityScore: 0, mentions: 0, citations: 1 },
  ];
  assert.equal(countCompetitorsFound(competitors), 2);
});

test("isCompetitorsConfigured — raw string or competitor rows", () => {
  assert.equal(isCompetitorsConfigured([], ""), false);
  assert.equal(isCompetitorsConfigured([], "  "), false);
  assert.equal(isCompetitorsConfigured([], "HubSpot, Salesforce"), true);
  assert.equal(
    isCompetitorsConfigured([{ name: "HubSpot", mentions: 0 }], ""),
    true
  );
});

test("resolveQueryIntentTier — branded_seed is branded; alias-hit PAA is not", () => {
  assert.equal(
    resolveQueryIntentTier({ text: "Acme reviews", source: "branded_seed" }),
    "branded"
  );
  assert.equal(
    resolveQueryIntentTier({
      text: "acme vs rival",
      source: "paa",
      intent_tier: "exploratory",
    }),
    "exploratory"
  );
  // Alias hit without tier must NOT become branded (that broke Brand Presence)
  assert.equal(
    resolveQueryIntentTier({ text: "acme vs rival", source: "paa" }),
    "exploratory"
  );
  assert.equal(
    resolveQueryIntentTier({
      text: "acme vs rival",
      source: "paa",
      intent_tier: "branded",
    }),
    "branded",
    "explicit branded intent still allowed"
  );
  assert.ok(isBrandPresenceQuery({ source: "branded_seed" }));
  assert.ok(!isBrandPresenceQuery({ source: "paa", intent_tier: "exploratory" }));
});

test("buildBrandedQueries stamps intent_tier branded", () => {
  const seeds = buildBrandedQueries("Acme", "acme.com");
  assert.ok(seeds.length > 0);
  assert.ok(seeds.every((q) => q.source === "branded_seed" && q.intent_tier === "branded"));
});

test("normalizeResult — competitorsFound KPI uses detection count, not list length", () => {
  const runRecord = {
    brand: "Acme",
    url: "acme.io",
    visibility_pct: 40,
    competitors_raw: "Alpha, Beta, Gamma",
    competitors: [
      { name: "Alpha", mentions: 2, citations: 0, visibilityScore: 20 },
      { name: "Beta", mentions: 0, citations: 0, visibilityScore: 0 },
      { name: "Gamma", mentions: 0, citations: 1, visibilityScore: 10 },
    ],
    results: [
      {
        prompt: "best crm tools",
        is_branded_query: false,
        aio_present: true,
        brand_mentioned_in_text: false,
        brand_cited: false,
        aio_citations: [],
      },
    ],
    summary_stats: {
      visibility_pct: 40,
      non_branded_with_aio: 1,
      visible_non_branded: 0,
      aio_coverage_pct: 100,
    },
  };

  const normalized = normalizeResult(runRecord, "Acme", "acme.io");
  assert.equal(normalized.competitorsConfigured, true);
  assert.equal(normalized.competitorsFound, 2);
  assert.equal(normalized.competitors.length, 3);
});

test("normalizeResult — blank form still auto-discovers co-mentions from AIO text", () => {
  const runRecord = {
    brand: "Italica",
    url: "italicatiles.com",
    visibility_pct: 0,
    competitors_raw: "",
    competitors: [],
    results: [
      {
        prompt: "best tile brands india",
        is_branded_query: false,
        aio_present: true,
        brand_mentioned_in_text: false,
        brand_cited: false,
        aio_text: "Top brands include Kajaria and Somany for home tiles.",
        aio_citations: ["https://www.kajaria.com/tiles"],
        aio_references: [
          { href: "https://somanyceramics.com", source: "Somany", title: "Tiles" },
        ],
      },
    ],
    summary_stats: {
      visibility_pct: 0,
      non_branded_with_aio: 1,
      visible_non_branded: 0,
      aio_coverage_pct: 100,
    },
  };

  const normalized = normalizeResult(runRecord, "Italica", "italicatiles.com");
  assert.ok(normalized.competitorsFound >= 1, "should discover co-mentions");
  assert.equal(normalized.competitorsConfigured, true);
  assert.ok(
    normalized.competitors.some((c) => /kajaria|somany/i.test(c.name)),
    "Kajaria or Somany auto-found"
  );
});

test("normalizeResult — Brand Presence panel uses branded_seed/intent, not every alias hit", () => {
  const runRecord = {
    brand: "Wrike",
    url: "wrike.com",
    visibility_pct: 50,
    results: [
      {
        prompt: "best project management software",
        is_branded_query: false,
        source: "paa",
        intent_tier: "exploratory",
        aio_present: true,
        brand_mentioned_in_text: true,
        brand_cited: false,
        aio_citations: [],
      },
      {
        prompt: "is wrike good for teams",
        is_branded_query: true,
        source: "paa",
        intent_tier: "exploratory",
        aio_present: true,
        brand_mentioned_in_text: true,
        brand_cited: false,
        aio_citations: [],
      },
      {
        prompt: "Wrike",
        is_branded_query: true,
        source: "branded_seed",
        intent_tier: "branded",
        aio_present: true,
        brand_mentioned_in_text: true,
        brand_cited: true,
        aio_citations: [],
      },
      {
        prompt: "what is Wrike",
        is_branded_query: true,
        source: "branded_seed",
        intent_tier: "branded",
        aio_present: true,
        brand_mentioned_in_text: false,
        brand_cited: false,
        aio_citations: [],
      },
    ],
    summary_stats: {
      visibility_pct: 50,
      non_branded_with_aio: 1,
      visible_non_branded: 1,
      aio_coverage_pct: 100,
      branded_visibility_pct: 100,
      branded_with_aio: 2,
    },
  };

  const normalized = normalizeResult(runRecord, "Wrike", "wrike.com");
  assert.equal(normalized.promptsAnalyzed, 1, "headline uses non-branded only");
  assert.equal(normalized.brandedPromptsCount, 3, "alias-branded count kept for diagnostics");
  assert.equal(normalized.brandPresencePromptsCount, 2, "own-name panel capped to seeds");
  assert.equal(normalized.brandPresenceResults.length, 2);
  assert.equal(normalized.brandPresenceWithAio, 2, "own-name queries with AIO");
  assert.equal(normalized.brandedWithAio, 2);
  assert.equal(normalized.visibleBranded, 1, "visible in 1 of 2 own-name AIOs");
  assert.equal(normalized.brandedVisibilityPct, 50, "50% visible of 2 own-name queries");
  assert.equal(normalized.queriesTracked, 4, "all probed queries counted");
  assert.equal(normalized.aliasBrandedOnlyCount, 1, "alias-hit not in brand presence");
});

test("normalizeResult — citation-only row counts as visible when recomputing", () => {
  const runRecord = {
    brand: "Acme",
    url: "acme.com",
    visibility_pct: 20,
    aio_coverage_pct: 0, // disagree → force recompute
    results: [
      {
        prompt: "q1",
        is_branded_query: false,
        aio_present: true,
        brand_mentioned_in_text: false,
        brand_cited: true,
        aio_citations: ["https://acme.com/page"],
      },
      {
        prompt: "q2",
        is_branded_query: false,
        aio_present: true,
        brand_mentioned_in_text: false,
        brand_cited: false,
      },
      {
        prompt: "q3",
        is_branded_query: false,
        aio_present: true,
        brand_mentioned_in_text: false,
        brand_cited: false,
      },
      {
        prompt: "q4",
        is_branded_query: false,
        aio_present: true,
        brand_mentioned_in_text: false,
        brand_cited: false,
      },
      {
        prompt: "q5",
        is_branded_query: false,
        aio_present: true,
        brand_mentioned_in_text: false,
        brand_cited: false,
      },
    ],
  };

  const n = normalizeResult(runRecord, "Acme", "acme.com");
  assert.equal(n.visibilityScore, 20);
  assert.equal(n.nonBrandedWithAio, 5);
  assert.equal(n.visibleNonBranded, 1);
  assert.equal(n.aioCoveragePct, 100);
});

test("normalizeResult — double normalize is stable (session re-entry)", () => {
  const runRecord = {
    brand: "Acme",
    url: "acme.com",
    visibility_pct: 50,
    competitors_raw: "Rival",
    competitors: [{ name: "Rival", mentions: 1, citations: 0, visibilityScore: 10 }],
    results: [
      {
        prompt: "best tools",
        is_branded_query: false,
        source: "paa",
        intent_tier: "exploratory",
        aio_present: true,
        brand_mentioned_in_text: true,
        brand_cited: false,
      },
      {
        prompt: "Acme",
        is_branded_query: true,
        source: "branded_seed",
        intent_tier: "branded",
        aio_present: true,
        brand_mentioned_in_text: true,
        brand_cited: false,
      },
    ],
    summary_stats: {
      visibility_pct: 50,
      non_branded_with_aio: 1,
      visible_non_branded: 1,
      aio_coverage_pct: 100,
    },
  };

  const first = normalizeResult(runRecord, "Acme", "acme.com");
  const second = normalizeResult(first, "Acme", "acme.com");
  assert.equal(second.visibilityScore, first.visibilityScore);
  assert.equal(second.queriesTracked, first.queriesTracked);
  assert.equal(second.brandPresencePromptsCount, first.brandPresencePromptsCount);
  assert.equal(second.competitorsFound, first.competitorsFound);
});
