import test from 'node:test';
import assert from 'node:assert/strict';
import { computeVisibilityScore, scorePromptResult, computeScanStats, computeIntentBreakdown, computeTopicScores } from './computeVisibilityScore.js';
import { aggregatePromptRuns } from './aggregate.js';
import { normalizeTopic, slugifyTopic } from './topics.js';

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
  const results = [
    { prompt_score: 100, prompt_score_stddev: 0 },
    { prompt_score: 50, prompt_score_stddev: 10 },
    { prompt_score: 0, prompt_score_stddev: 20 }
  ];
  // Mean is 50. avgStddev is (0 + 10 + 20) / 3 = 10 -> "medium" stability
  // CI is ±avgStddev = [40, 60]
  const stats = computeScanStats(results, 50);
  assert.equal(stats.score_ci_low, 40);
  assert.equal(stats.score_ci_high, 60);
  assert.equal(stats.stability, "medium");
  assert.equal(stats.average_stddev, 10);
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
