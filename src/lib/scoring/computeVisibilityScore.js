import { POSITION_WEIGHTS, SENTIMENT_WEIGHTS, CITATION_BONUS, INTENT_WEIGHTS } from "./constants.js";
import { normalizeTopic } from "./topics.js";

function extractDomain(urlStr) {
  if (!urlStr) return "";
  try {
    let cleaned = urlStr.trim().toLowerCase();
    if (!/^https?:\/\//i.test(cleaned)) {
      cleaned = 'http://' + cleaned;
    }
    const parsed = new URL(cleaned);
    return parsed.hostname.replace(/^www\./i, '');
  } catch (e) {
    return "";
  }
}

/**
 * Computes a weighted score (0.0 to 1.0) for a single prompt result.
 * Formula: mention (0/1) * position_weight * sentiment_weight + citation_bonus (capped at 1.0)
 *
 * @param {Object} result - Prompt result object
 * @param {string} brandUrl - Brand domain/URL to check for citations
 * @returns {number} Float between 0.0 and 1.0
 */
export function scorePromptResult(result, brandUrl = "") {
  if (!result || !result.mentioned) {
    return 0.0;
  }

  const posWeight = POSITION_WEIGHTS[result.position] ?? 0.0;
  const sentWeight = SENTIMENT_WEIGHTS[result.sentiment] ?? 0.0;
  let score = posWeight * sentWeight;

  const brandDomain = extractDomain(brandUrl);
  if (brandDomain && result.citations && result.citations.length > 0) {
    const hasBrandCitation = result.citations.some(c => c.toLowerCase().includes(brandDomain));
    if (hasBrandCitation) {
      score = Math.min(1.0, score + CITATION_BONUS);
    }
  }

  return Math.round(score * 10000) / 10000;
}

/**
 * Computes the overall composite visibility score based on prompt results.
 * Phase 3: Weighted mean based on intent tier weights.
 *
 * @param {Array} results - Array of prompt result objects
 * @param {string} brandUrl - Brand URL to check for citations
 * @returns {number} Visibility percentage (0-100)
 */
export function computeVisibilityScore(results, brandUrl = "") {
  if (!results || results.length === 0) {
    return 0.0;
  }
  let totalScore = 0.0;
  let totalWeight = 0.0;
  results.forEach((r) => {
    const tier = r.intent_tier || "exploratory";
    const weight = r.weight ?? INTENT_WEIGHTS[tier] ?? 1.0;
    const promptScore = r.prompt_score !== undefined ? r.prompt_score : (scorePromptResult(r, brandUrl) * 100);
    totalScore += promptScore * weight;
    totalWeight += weight;
  });
  return Math.round((totalScore / (totalWeight || 1)) * 10) / 10;
}

/**
 * Computes average visibility score per intent tier.
 *
 * @param {Array} results - Array of prompt result objects
 * @param {string} brandUrl - Brand URL to check for citations
 * @returns {Object} Key-value of intent tier to average score
 */
export function computeIntentBreakdown(results, brandUrl = "") {
  const breakdown = {
    high_intent: { sum: 0, count: 0 },
    comparison: { sum: 0, count: 0 },
    problem_aware: { sum: 0, count: 0 },
    exploratory: { sum: 0, count: 0 },
    branded: { sum: 0, count: 0 },
  };

  results.forEach(r => {
    const tier = r.intent_tier || "exploratory";
    const score = r.prompt_score !== undefined ? r.prompt_score : (scorePromptResult(r, brandUrl) * 100);
    if (breakdown[tier]) {
      breakdown[tier].sum += score;
      breakdown[tier].count += 1;
    }
  });

  const finalBreakdown = {};
  for (const tier in breakdown) {
    const { sum, count } = breakdown[tier];
    finalBreakdown[tier] = count > 0 ? Math.round((sum / count) * 10) / 10 : 0.0;
  }
  return finalBreakdown;
}

/**
 * Computes scan-level statistics including confidence intervals and stability.
 *
 * @param {Array} results - Aggregated prompt results
 * @param {number} visibilityScore - The computed visibility score
 * @returns {Object} Scan stats containing score_ci_low, score_ci_high, and stability
 */
export function computeScanStats(results, visibilityScore) {
  if (!results || results.length === 0) {
    return {
      score_ci_low: visibilityScore,
      score_ci_high: visibilityScore,
      stability: "high",
      average_stddev: 0.0
    };
  }

  // Get average stddev of multiple probe runs per prompt
  const stddevs = results.map(r => r.prompt_score_stddev || 0.0);
  const avgStddev = stddevs.reduce((a, b) => a + b, 0) / results.length;

  let stability = "high";
  if (avgStddev > 15) stability = "volatile";
  else if (avgStddev > 5) stability = "medium";

  // Base CI on run-level uncertainty (avgStddev)
  const score_ci_low = Math.round(Math.max(0, visibilityScore - avgStddev) * 10) / 10;
  const score_ci_high = Math.round(Math.min(100, visibilityScore + avgStddev) * 10) / 10;

  return {
    score_ci_low,
    score_ci_high,
    stability,
    average_stddev: Math.round(avgStddev * 10) / 10
  };
}

/**
 * Computes average visibility score per normalized topic.
 *
 * @param {Array} results - Array of prompt result objects
 * @param {string} brandUrl - Brand URL to check for citations
 * @returns {Object} Key-value of topic to average score
 */
export function computeTopicScores(results, brandUrl = "") {
  if (!results || results.length === 0) {
    return {};
  }

  const groups = {};
  results.forEach(r => {
    const topic = normalizeTopic(r.topic || "General");
    const score = r.prompt_score !== undefined ? r.prompt_score : (scorePromptResult(r, brandUrl) * 100);
    if (!groups[topic]) {
      groups[topic] = { sum: 0, count: 0 };
    }
    groups[topic].sum += score;
    groups[topic].count += 1;
  });

  const topicScores = {};
  for (const topic in groups) {
    const { sum, count } = groups[topic];
    topicScores[topic] = count > 0 ? Math.round((sum / count) * 10) / 10 : 0.0;
  }
  return topicScores;
}
