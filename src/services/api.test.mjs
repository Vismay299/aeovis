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

test("normalizeResult — multi-engine rows count unique prompts, not engine rows", () => {
  const mk = (prompt, engine, overrides = {}) => ({
    prompt,
    engine,
    is_branded_query: false,
    intent_tier: "informational",
    source: "llm_generated",
    answer_present: true,
    aio_present: engine === "aio",
    text: "answer text",
    citations: [],
    references: [],
    brand_mentioned_in_text: false,
    brand_cited: false,
    visible: false,
    error: null,
    ...overrides,
  });

  const record = {
    brand: "Acme",
    url: "acme.com",
    prompts_tracked: 3,
    engines: {
      aio: { engine: "aio", share_of_ai_pct: 33.3, non_branded_with_answer: 3, data_source_issue: false },
      perplexity: { engine: "perplexity", share_of_ai_pct: 66.7, non_branded_with_answer: 3, data_source_issue: false },
    },
    visibility_index_pct: 50,
    engines_counted: 2,
    summary_stats: {
      visibility_pct: 33.3,
      share_of_ai_pct: 33.3,
      non_branded_with_aio: 3,
      visible_non_branded: 1,
    },
    results: [
      // 3 unbranded prompts x 2 engines = 6 rows
      mk("best widget for home", "aio", { visible: true, brand_mentioned_in_text: true }),
      mk("best widget for home", "perplexity", { visible: true, brand_mentioned_in_text: true }),
      mk("widget vs gadget", "aio"),
      mk("widget vs gadget", "perplexity"),
      mk("cheap widgets online", "aio"),
      mk("cheap widgets online", "perplexity"),
      // 1 brand-presence prompt x 2 engines: answered+visible on perplexity only
      mk("what is Acme", "aio", {
        is_branded_query: true,
        source: "branded_seed",
        intent_tier: "branded",
        answer_present: false,
        aio_present: false,
      }),
      mk("what is Acme", "perplexity", {
        is_branded_query: true,
        source: "branded_seed",
        intent_tier: "branded",
        visible: true,
        brand_mentioned_in_text: true,
      }),
    ],
  };

  const out = normalizeResult(record, "Acme", "acme.com");

  assert.equal(out.isMultiEngine, true);
  // Prompt-denominated counts are unique prompts, not rows
  assert.equal(out.promptsAnalyzed, 3);
  assert.equal(out.queriesTracked, 4);
  assert.equal(out.brandedPromptsCount, 1);
  assert.equal(out.brandPresencePromptsCount, 1);
  // Brand presence: answered/visible on >=1 engine counts the PROMPT once
  assert.equal(out.brandPresenceWithAio, 1);
  assert.equal(out.visibleBranded, 1);
  assert.equal(out.brandedVisibilityPct, 100);
  // Result arrays keep per-engine rows for the engine-filtered views
  assert.equal(out.nonBrandedResults.length, 6);
  // Multi-engine summary references both surfaces
  assert.match(out.summary, /Perplexity/);
});

test("normalizeResult — single-engine counts unchanged by unique-prompt logic", () => {
  const row = (prompt, overrides = {}) => ({
    prompt,
    is_branded_query: false,
    intent_tier: "informational",
    source: "llm_generated",
    aio_present: true,
    aio_text: "text",
    aio_citations: [],
    brand_mentioned_in_text: false,
    brand_cited: false,
    visible: false,
    error: null,
    ...overrides,
  });

  const record = {
    brand: "Acme",
    url: "acme.com",
    summary_stats: {
      visibility_pct: 50,
      non_branded_with_aio: 2,
      visible_non_branded: 1,
    },
    results: [
      row("q one", { visible: true, brand_mentioned_in_text: true }),
      row("q two"),
      row("what is Acme", { is_branded_query: true, source: "branded_seed", intent_tier: "branded" }),
    ],
  };

  const out = normalizeResult(record, "Acme", "acme.com");
  assert.equal(out.isMultiEngine, false);
  assert.equal(out.promptsAnalyzed, 2);
  assert.equal(out.queriesTracked, 3);
  assert.equal(out.brandPresencePromptsCount, 1);
  assert.equal(out.brandPresenceWithAio, 1);
});

/**
 * R2.7.3 (finding C1) — normalizeResult must not invent a collection time.
 *
 * The scanTimestamp chain used to end in `?? new Date().toISOString()`, so a
 * run record with no `scanned_at` came out stamped with the moment the page
 * normalized it and the dashboard rendered "just now". Unknown age must stay
 * unknown: null, which the UI renders as an em dash plus a state chip.
 */
test("normalizeResult — a record with no scanned_at gets a null scanTimestamp", () => {
  const record = {
    brand: "Acme",
    url: "acme.com",
    summary_stats: { visibility_pct: 50, non_branded_with_aio: 1, visible_non_branded: 1 },
    results: [
      {
        prompt: "q one",
        is_branded_query: false,
        intent_tier: "informational",
        source: "llm_generated",
        aio_present: true,
        aio_text: "text",
        aio_citations: [],
        brand_mentioned_in_text: true,
        brand_cited: false,
        visible: true,
        error: null,
      },
    ],
  };

  const out = normalizeResult(record, "Acme", "acme.com");
  assert.equal(
    out.scanTimestamp,
    null,
    "a missing collection time must be null, not the current clock"
  );
});

test("normalizeResult — a real scanned_at is preserved verbatim", () => {
  const scannedAt = "2026-08-20T09:30:00.000Z";
  const record = {
    brand: "Acme",
    url: "acme.com",
    scanned_at: scannedAt,
    summary_stats: { visibility_pct: 50, non_branded_with_aio: 1, visible_non_branded: 1 },
    results: [],
  };

  assert.equal(normalizeResult(record, "Acme", "acme.com").scanTimestamp, scannedAt);
  assert.equal(
    normalizeResult(
      { ...record, scanned_at: undefined, scanTimestamp: scannedAt },
      "Acme",
      "acme.com"
    ).scanTimestamp,
    scannedAt,
    "the camelCase carrier still works"
  );
});

test("multi-engine coverage and presence are per question across engines, not the Google slice's", async () => {
  const { normalizeResult } = await import("./api.js");
  const q = (i) => `Question ${i}`;
  const results = [];
  for (let i = 0; i < 4; i++) {
    results.push({ engine: "aio", prompt: q(i), answer_present: false, aio_present: false, serp_state: "valid_serp" });
    results.push({ engine: "chatgpt", prompt: q(i), answer_present: true, brand_mentioned_in_text: i === 0 });
  }
  results.push({ engine: "gemini", prompt: q(3), answer_present: true, brand_mentioned_in_text: true, error: "timeout" });
  const summary_stats = { non_branded_with_aio: 0, visible_non_branded: 0, aio_coverage_pct: 0, presence_rate_pct: 0, insufficient_sample: true, headline_qualified: true };
  const r = normalizeResult({ brand: "Acme", url: "https://acme.example", engines: { aio: {}, chatgpt: {} }, summary_stats, results, prompts_tracked: 4 });
  assert.equal(r.nonBrandedWithAio, 4, "every question was answered by some engine");
  assert.equal(r.visibleCount, 1, "named on one question; an errored row does not count");
  assert.equal(r.aioCoveragePct, 100);assert.equal(r.presenceRatePct, 25);
  assert.equal(r.insufficientSample, false, "a qualified multi-engine headline is not a small sample");
  const single = normalizeResult({ brand: "Acme", url: "https://acme.example", summary_stats, results: results.filter((x) => x.engine === "aio") });
  assert.equal(single.nonBrandedWithAio, 0, "single-engine AIO scans keep their own summary");
});
