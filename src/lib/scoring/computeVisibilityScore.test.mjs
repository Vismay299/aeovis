import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeVisibilityScore,
  scorePromptResult,
  computeScanStats,
  computeIntentBreakdown,
  computeTopicScores,
  computeShareOfVoice,
  computeWinRate,
  computeCompetitorVisibility,
  computeGapScores
} from './computeVisibilityScore.js';
import { aggregatePromptRuns, aggregateMultiEnginePromptRuns } from './aggregate.js';
import { normalizeTopic, slugifyTopic } from './topics.js';

// ... (existing test functions remain unchanged)
// We will replace all content starting from line 7 to the end to append the new tests cleanly.
test('scorePromptResult - basic combinations', () => {
  // mentioned + recommended + positive = 1.0
  assert.equal(scorePromptResult({ mentioned: true, position: 'recommended', sentiment: 'positive' }), 1.0);
  
  // mentioned + compared + neutral = 0.6 * 0.5 = 0.3
  assert.equal(scorePromptResult({ mentioned: true, position: 'compared', sentiment: 'neutral' }), 0.3);

  // mentioned + cited + negative = 0.3 * 0.0 = 0.0
  assert.equal(scorePromptResult({ mentioned: true, position: 'cited', sentiment: 'negative' }), 0.0);

  // omitted / not mentioned = 0.0
  assert.equal(scorePromptResult({ mentioned: false, position: 'recommended', sentiment: 'positive' }), 0.0);
  assert.equal(scorePromptResult({ mentioned: true, position: 'omitted', sentiment: 'positive' }), 0.0);
});

test('scorePromptResult - citation bonus', () => {
  // mentioned + compared + neutral + citation = 0.3 + 0.15 = 0.45
  const result = {
    mentioned: true,
    position: 'compared',
    sentiment: 'neutral',
    citations: ['https://acme.com/pricing', 'https://other.com']
  };
  assert.equal(scorePromptResult(result, 'https://www.acme.com'), 0.45);
  
  // Capped at 1.0
  const resultMax = {
    mentioned: true,
    position: 'recommended',
    sentiment: 'positive',
    citations: ['https://acme.com/pricing']
  };
  assert.equal(scorePromptResult(resultMax, 'acme.com'), 1.0);
});

test('computeVisibilityScore - average score', () => {
  const results = [
    { mentioned: true, position: 'recommended', sentiment: 'positive' }, // 1.0 -> 100
    { mentioned: true, position: 'compared', sentiment: 'neutral' },    // 0.3 -> 30
    { mentioned: false }                                                 // 0.0 -> 0
  ];
  // Since no intent_tier is specified, they fallback to exploratory (weight 1.0).
  // Total weight is 3.0. Average is (100 + 30 + 0) / 3 = 43.3
  assert.equal(computeVisibilityScore(results), 43.3);
});

test('computeVisibilityScore - empty results', () => {
  assert.equal(computeVisibilityScore([]), 0.0);
  assert.equal(computeVisibilityScore(null), 0.0);
});

test('aggregatePromptRuns - simple aggregation', () => {
  const runs = [
    {
      prompt: "test",
      mentioned: true,
      position: "recommended",
      sentiment: "positive",
      competitors_found: ["comp1"],
      citations: ["c1"],
      key_phrases: ["kp1"],
      raw_response: "res1",
      model_used: "m1",
      probe_temperature: 0.4,
      prompt_score: 100,
      judge_method: "llm",
      judge_model_used: "jm1"
    },
    {
      prompt: "test",
      mentioned: true,
      position: "compared",
      sentiment: "neutral",
      competitors_found: ["comp2"],
      citations: ["c2"],
      key_phrases: ["kp2"],
      raw_response: "res2",
      model_used: "m2",
      probe_temperature: 0.4,
      prompt_score: 30,
      judge_method: "llm",
      judge_model_used: "jm1"
    },
    {
      prompt: "test",
      mentioned: false,
      position: "omitted",
      sentiment: "neutral",
      competitors_found: [],
      citations: [],
      key_phrases: [],
      raw_response: "res3",
      model_used: "m3",
      probe_temperature: 0.4,
      prompt_score: 0,
      judge_method: "skipped",
      judge_model_used: ""
    }
  ];

  const aggregated = aggregatePromptRuns(runs);
  
  assert.equal(aggregated.prompt, "test");
  assert.equal(aggregated.mentioned, true); // 2/3 is true
  // Note: recommended and compared both have count 1, getMostCommon picks the first one encountered (recommended)
  assert.equal(aggregated.position, "recommended");
  assert.equal(aggregated.sentiment, "positive");
  assert.deepEqual(aggregated.competitors_found.sort(), ["comp1", "comp2"].sort());
  assert.deepEqual(aggregated.citations.sort(), ["c1", "c2"].sort());
  assert.deepEqual(aggregated.key_phrases.sort(), ["kp1", "kp2"].sort());
  assert.equal(aggregated.prompt_score, 30); // Median of 100, 30, 0 is 30
  assert.equal(aggregated.prompt_score_stddev, 51.3); // stddev of [100, 30, 0] is 51.3
  assert.equal(aggregated.run_details.length, 3);
});

test('computeScanStats - calculations', () => {
  const results = Array.from({ length: 30 }, (_, i) => ({
    prompt_score: i < 15 ? 100 : 0,
    prompt_score_stddev: 10,
    mentioned: i < 15
  }));
  // total prompts = 30, mentioned = 15
  // For industry "saas", prior = 0.35
  const stats = computeScanStats(results, 50, "saas");
  assert.equal(stats.score_ci_low, 33.5);
  assert.equal(stats.score_ci_high, 59.2);
  assert.equal(stats.stability, "medium");
  assert.equal(stats.average_stddev, 10);
  assert.equal(stats.sample_size_adequacy, true);

  // Test small sample size warning
  const smallResults = Array.from({ length: 29 }, (_, i) => ({
    prompt_score: i < 15 ? 100 : 0,
    prompt_score_stddev: 5,
    mentioned: i < 15
  }));
  const smallStats = computeScanStats(smallResults, 50, "saas");
  assert.equal(smallStats.sample_size_adequacy, false);
});

test('computeVisibilityScore - weighted mean', () => {
  const results = [
    { prompt_score: 100, intent_tier: 'high_intent' }, // Weight 3.0 -> Weighted score: 300
    { prompt_score: 50, intent_tier: 'branded' },      // Weight 0.5 -> Weighted score: 25
    { prompt_score: 0, intent_tier: 'exploratory' }    // Weight 1.0 -> Weighted score: 0
  ];
  // Total score = 300 + 25 + 0 = 325
  // Total weight = 3.0 + 0.5 + 1.0 = 4.5
  // Weighted mean = 325 / 4.5 = 72.2
  assert.equal(computeVisibilityScore(results), 72.2);
});

test('computeIntentBreakdown - calculations', () => {
  const results = [
    { prompt_score: 100, intent_tier: 'high_intent' },
    { prompt_score: 80, intent_tier: 'high_intent' },
    { prompt_score: 40, intent_tier: 'branded' }
  ];
  const breakdown = computeIntentBreakdown(results);
  assert.equal(breakdown.high_intent, 90.0);
  assert.equal(breakdown.branded, 40.0);
  assert.equal(breakdown.comparison, 0.0);
});

test('computeTopicScores - calculations', () => {
  const results = [
    { prompt_score: 100, topic: 'Pricing' },
    { prompt_score: 50, topic: 'pricing ' }, // lower/upper/trim normalization test
    { prompt_score: 0, topic: 'Features' }
  ];
  const scores = computeTopicScores(results);
  assert.equal(scores.Pricing, 75.0);
  assert.equal(scores.Features, 0.0);
});

test('normalizeTopic - edge cases', () => {
  assert.equal(normalizeTopic(null), "General");
  assert.equal(normalizeTopic(undefined), "General");
  assert.equal(normalizeTopic(""), "General");
  assert.equal(normalizeTopic("   "), "General");
  assert.equal(normalizeTopic("pricing"), "Pricing");
  assert.equal(normalizeTopic("product features"), "Product Features");
  assert.equal(normalizeTopic("  INTEGRATIONS  "), "Integrations");
  assert.equal(normalizeTopic("mixEd_CASE-topic"), "Mixed_case-topic"); // trims and title-cases segments
});

test('slugifyTopic - format', () => {
  assert.equal(slugifyTopic("Product Features"), "product-features");
  assert.equal(slugifyTopic("  INTEGRATIONS  "), "integrations");
  assert.equal(slugifyTopic("General"), "general");
});

test('computeShareOfVoice - percentages', () => {
  const results = [
    { mentioned: true, competitors_found: ["beta"] }, // Brand 1, Competitor 1
    { mentioned: true, competitors_found: [] },       // Brand 1, Competitor 0
    { mentioned: false, competitors_found: ["beta"] }  // Brand 0, Competitor 1
  ];
  // Total brand mentions = 2, total competitor mentions = 2. Total = 4.
  // SOV = 2 / 4 = 50.0%
  assert.equal(computeShareOfVoice(results), 50.0);
});

test('computeWinRate - comparisons', () => {
  const results = [
    { mentioned: true, intent_tier: 'comparison', competitors_found: [] },       // Win
    { mentioned: true, intent_tier: 'comparison', competitors_found: ['beta'] }, // Loss (competitor present)
    { mentioned: false, intent_tier: 'comparison', competitors_found: [] },      // Loss (not mentioned)
    { mentioned: true, intent_tier: 'high_intent', competitors_found: [] }       // Ignored (not comparison tier)
  ];
  // Wins = 1, total comparison prompts = 3
  // Win rate = 1 / 3 = 33.3%
  assert.equal(computeWinRate(results, ['beta']), 33.3);
});

test('computeCompetitorVisibility - composite rules', () => {
  const results = [
    {
      intent_tier: 'exploratory',
      run_details: [
        { raw_response: "Beta is an amazing CRM system." }, // mentioned + recommended + neutral = 0.5 * 100 = 50
        { raw_response: "I suggest Beta CRM." }
      ]
    }
  ];
  const vis = computeCompetitorVisibility(results, "Beta");
  // Expected to be around 50%
  assert.ok(vis > 0);
});

test('computeGapScores - calculations', () => {
  const results = [
    {
      prompt_score: 30.0,
      run_details: [
        { raw_response: "Acme is okay. Beta is the best CRM." }
      ]
    }
  ];
  computeGapScores(results, ["Beta"]);
  // Beta score should be high, prompt_score is 30, so gap_score should be positive
  assert.ok(results[0].gap_score > 0);
});

test('computeVisibilityScore - blended visibility with brandUrl', () => {
  const results = [
    { prompt_score: 100.0, intent_tier: 'exploratory', citations: ["https://acme.io/pricing"] }, // Brand cited
    { prompt_score: 100.0, intent_tier: 'exploratory', citations: [] }                           // Brand not cited
  ];
  // Brand cited in 1 of 2 prompts -> Citation Share = 50.0%
  // Mention Visibility = 100.0%
  // Blended visibility = 0.85 * 100.0 + 0.15 * 50.0 = 85.0 + 7.5 = 92.5%
  assert.equal(computeVisibilityScore(results, "https://acme.io"), 92.5);
});

test('aggregateMultiEnginePromptRuns - weighted engine aggregation', () => {
  const runs = [
    // Gemini runs (prompt_score 100.0, weight 0.25)
    { prompt: "crm tool", engine: "gemini", prompt_score: 100.0, mentioned: true, position: "recommended", sentiment: "positive" },
    // OpenAI runs (prompt_score 80.0, weight 0.35)
    { prompt: "crm tool", engine: "openai", prompt_score: 80.0, mentioned: true, position: "compared", sentiment: "positive" }
  ];
  // Active engines: gemini (weight 0.25), openai (weight 0.35)
  // Total weight = 0.60
  // Normalized: gemini = 0.25 / 0.6 = 0.4167, openai = 0.35 / 0.6 = 0.5833
  // Weighted score = 100 * 0.4167 + 80 * 0.5833 = 41.67 + 46.67 = 88.3
  const agg = aggregateMultiEnginePromptRuns(runs);
  assert.equal(agg.prompt, "crm tool");
  assert.equal(agg.prompt_score, 88.3);
  assert.equal(agg.engine_scores.gemini, 100.0);
  assert.equal(agg.engine_scores.openai, 80.0);
});

test('aggregateMultiEnginePromptRuns - hybrid weights when serp present', () => {
  const runs = [
    // google_ai_overview (weight 0.50, score 100)
    { prompt: "crm tool", engine: "google_ai_overview", prompt_score: 100.0, mentioned: true, position: "recommended", sentiment: "positive" },
    // gemini (weight 0.10, score 80)
    { prompt: "crm tool", engine: "gemini", prompt_score: 80.0, mentioned: true, position: "compared", sentiment: "positive" }
  ];
  // Active: google_ai_overview (0.50), gemini (0.10). Total weight = 0.60
  // Normalized: google_ai_overview = 0.50 / 0.6 = 0.8333, gemini = 0.10 / 0.6 = 0.1667
  // Weighted score = 100 * 0.8333 + 80 * 0.1667 = 83.33 + 13.33 = 96.7
  const agg = aggregateMultiEnginePromptRuns(runs);
  assert.equal(agg.prompt, "crm tool");
  assert.equal(agg.prompt_score, 96.7);
  assert.equal(agg.engine_scores.google_ai_overview, 100.0);
  assert.equal(agg.engine_scores.gemini, 80.0);
});

