import { POSITION_WEIGHTS, SENTIMENT_WEIGHTS, CITATION_BONUS, INTENT_WEIGHTS, CITATION_SHARE_WEIGHT } from "./constants.js";
import { normalizeTopic } from "./topics.js";
import { judgeDeterministic } from "./judge.js";
import { extractBrandDomain, classifyCitation, computeBrandCitationShare, computeCompetitorCitationShare } from "./citations.js";

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
  
  const mentionVisibility = totalScore / (totalWeight || 1);
  
  if (brandUrl) {
    const brandCitationShare = computeBrandCitationShare(results, brandUrl);
    const blended = (1 - CITATION_SHARE_WEIGHT) * mentionVisibility + CITATION_SHARE_WEIGHT * brandCitationShare;
    return Math.round(blended * 10) / 10;
  }
  
  return Math.round(mentionVisibility * 10) / 10;
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

/**
 * Computes the overall Share of Voice percentage (brand mentions / total brand+competitor mentions).
 *
 * @param {Array} results - Array of prompt result objects
 * @returns {number} Share of Voice percentage (0-100)
 */
export function computeShareOfVoice(results) {
  if (!results || results.length === 0) return 0.0;
  let brandMentions = 0;
  let competitorMentions = 0;
  
  results.forEach(r => {
    if (r.mentioned) brandMentions++;
    competitorMentions += (r.competitors_found || []).length;
  });
  
  const total = brandMentions + competitorMentions;
  return total > 0 ? Math.round((brandMentions / total) * 1000) / 10 : 0.0;
}

/**
 * Computes win rate on comparison prompts (brand mentioned, competitors not mentioned).
 *
 * @param {Array} results - Array of prompt result objects
 * @param {Array} competitors - List of competitor brand names
 * @returns {number} Win rate percentage (0-100)
 */
export function computeWinRate(results, competitors = []) {
  if (!results || results.length === 0) return 0.0;
  const comparisonPrompts = results.filter(r => r.intent_tier === "comparison");
  if (comparisonPrompts.length === 0) return 0.0;

  let wins = 0;
  comparisonPrompts.forEach(r => {
    if (r.mentioned) {
      const hasCompetitor = (r.competitors_found || []).some(c =>
        competitors.some(comp => comp.toLowerCase() === c.toLowerCase())
      );
      if (!hasCompetitor) {
        wins++;
      }
    }
  });
  
  return Math.round((wins / comparisonPrompts.length) * 1000) / 10;
}

/**
 * Computes the overall composite visibility score for a single competitor using identical composite rules.
 *
 * @param {Array} results - Array of prompt result objects
 * @param {string} competitor - Competitor name to score
 * @returns {number} Visibility percentage (0-100)
 */
export function computeCompetitorVisibility(results, competitor) {
  if (!results || results.length === 0) return 0.0;
  
  let totalScore = 0.0;
  let totalWeight = 0.0;
  
  results.forEach(r => {
    const tier = r.intent_tier || "exploratory";
    const weight = r.weight ?? INTENT_WEIGHTS[tier] ?? 1.0;
    
    let compPromptScore = 0.0;
    
    if (r.run_details && r.run_details.length > 0) {
      const runScores = r.run_details.map(run => {
        if (!run.raw_response) {
          const found = (run.competitors_found || []).some(c => c.toLowerCase() === competitor.toLowerCase());
          return found ? 100.0 : 0.0;
        }
        const compResult = judgeDeterministic(run.raw_response, competitor, "", []);
        return scorePromptResult(compResult, "") * 100;
      });
      
      const sorted = [...runScores].sort((a, b) => a - b);
      const mid = Math.floor(sorted.length / 2);
      compPromptScore = sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    } else {
      const found = (r.competitors_found || []).some(c => c.toLowerCase() === competitor.toLowerCase());
      compPromptScore = found ? 100.0 : 0.0;
    }
    
    totalScore += compPromptScore * weight;
    totalWeight += weight;
  });
  
  return Math.round((totalScore / (totalWeight || 1)) * 10) / 10;
}

/**
 * Computes gap_score per prompt vs the top competitor on that prompt.
 * Formula: gap_score = max(competitor_prompt_score) - brand_prompt_score
 *
 * @param {Array} results - Array of prompt result objects
 * @param {Array} competitors - List of competitor brand names
 */
export function computeGapScores(results, competitors = []) {
  if (!results || results.length === 0 || !competitors || competitors.length === 0) {
    return;
  }
  
  results.forEach(r => {
    let maxCompScore = 0.0;
    
    competitors.forEach(comp => {
      let compPromptScore = 0.0;
      if (r.run_details && r.run_details.length > 0) {
        const runScores = r.run_details.map(run => {
          if (!run.raw_response) {
            const found = (run.competitors_found || []).some(c => c.toLowerCase() === comp.toLowerCase());
            return found ? 100.0 : 0.0;
          }
          const compResult = judgeDeterministic(run.raw_response, comp, "", []);
          return scorePromptResult(compResult, "") * 100;
        });
        const sorted = [...runScores].sort((a, b) => a - b);
        const mid = Math.floor(sorted.length / 2);
        compPromptScore = sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
      } else {
        const found = (r.competitors_found || []).some(c => c.toLowerCase() === comp.toLowerCase());
        compPromptScore = found ? 100.0 : 0.0;
      }
      
      if (compPromptScore > maxCompScore) {
        maxCompScore = compPromptScore;
      }
    });
    
    r.gap_score = Math.round((maxCompScore - (r.prompt_score || 0.0)) * 10) / 10;
  });
}

export { extractBrandDomain, classifyCitation, aggregateTopDomains, computeBrandCitationShare, computeCompetitorCitationShare } from "./citations.js";
