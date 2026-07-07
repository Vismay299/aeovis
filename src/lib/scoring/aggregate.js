import { ENGINE_DEFAULT_WEIGHTS, ENGINE_HYBRID_WEIGHTS } from "../engines/types.js";

function getStdDev(array) {
  const n = array.length;
  if (n <= 1) return 0;
  const mean = array.reduce((a, b) => a + b, 0) / n;
  return Math.sqrt(array.map(x => Math.pow(x - mean, 2)).reduce((a, b) => a + b, 0) / (n - 1));
}

function getMedian(array) {
  if (array.length === 0) return 0;
  const sorted = [...array].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function getMostCommon(array, fallback = "") {
  if (array.length === 0) return fallback;
  const counts = {};
  let maxCount = 0;
  let mostCommon = fallback;
  for (const item of array) {
    counts[item] = (counts[item] || 0) + 1;
    if (counts[item] > maxCount) {
      maxCount = counts[item];
      mostCommon = item;
    }
  }
  return mostCommon;
}

const uniqueUnion = (arrays) => [...new Set(arrays.flat())].filter(Boolean);

/**
 * Aggregates multiple run analysis results for a single prompt.
 *
 * @param {Array} runs - Array of result objects from individual runs
 * @returns {Object} Aggregated prompt result object
 */
export function aggregatePromptRuns(runs) {
  if (!runs || runs.length === 0) {
    return null;
  }

  const promptText = runs[0].prompt;
  const runsMentioned = runs.filter(r => r.mentioned);
  const mentioned = runsMentioned.length >= runs.length / 2;

  // Most common position/sentiment among mentioned runs, falling back to all runs if never mentioned
  const position = getMostCommon(
    (runsMentioned.length > 0 ? runsMentioned : runs).map(r => r.position),
    "omitted"
  );
  const sentiment = getMostCommon(
    (runsMentioned.length > 0 ? runsMentioned : runs).map(r => r.sentiment),
    "neutral"
  );

  const competitors_found = uniqueUnion(runs.map(r => r.competitors_found || []));
  const citations = uniqueUnion(runs.map(r => r.citations || []));
  const key_phrases = uniqueUnion(runs.map(r => r.key_phrases || []));

  const promptScores = runs.map(r => r.prompt_score || 0);
  const prompt_score = Math.round(getMedian(promptScores) * 10) / 10;
  const prompt_score_stddev = Math.round(getStdDev(promptScores) * 10) / 10;

  const sanitizedRuns = runs;

  return {
    prompt: promptText,
    mentioned,
    position,
    sentiment,
    competitors_found,
    citations,
    key_phrases,
    raw_response: runs[0].raw_response || "",
    model_used: runs[0].model_used || "",
    probe_temperature: runs[0].probe_temperature || null,
    prompt_score,
    prompt_score_stddev,
    run_details: sanitizedRuns,
    judge_method: getMostCommon(runs.map(r => r.judge_method), "deterministic"),
    judge_model_used: getMostCommon(runs.map(r => r.judge_model_used), "")
  };
}


/**
 * Aggregates multiple run results across all enabled engines for a prompt.
 *
 * @param {Array} runs - Array of run result objects (each containing an .engine property)
 * @returns {Object} Multi-engine aggregated prompt result object
 */
export function aggregateMultiEnginePromptRuns(runs) {
  if (!runs || runs.length === 0) return null;
  
  // Group by engine
  const runsByEngine = {};
  runs.forEach(r => {
    const engine = r.engine || "gemini";
    if (!runsByEngine[engine]) {
      runsByEngine[engine] = [];
    }
    runsByEngine[engine].push(r);
  });
  
  // Aggregate per engine
  const engineAggs = {};
  const activeEngines = [];
  
  Object.entries(runsByEngine).forEach(([engine, engineRuns]) => {
    const agg = aggregatePromptRuns(engineRuns);
    if (agg) {
      engineAggs[engine] = agg;
      activeEngines.push(engine);
    }
  });
  
  if (activeEngines.length === 0) return null;
  
  // Choose weights dictionary based on active engines:
  // If google_ai_overview is one of the active engines, we use ENGINE_HYBRID_WEIGHTS!
  const hasSerp = activeEngines.includes("google_ai_overview");
  const weightsDict = hasSerp ? ENGINE_HYBRID_WEIGHTS : ENGINE_DEFAULT_WEIGHTS;

  // Normalize weights for active engines
  let totalWeight = 0.0;
  activeEngines.forEach(eng => {
    totalWeight += weightsDict[eng] ?? 0.25;
  });
  if (totalWeight === 0) totalWeight = 1.0;
  
  const normalizedWeights = {};
  activeEngines.forEach(eng => {
    normalizedWeights[eng] = (weightsDict[eng] ?? 0.25) / totalWeight;
  });
  
  // Calculate weighted prompt score and mentioned rate
  let weightedScore = 0.0;
  let weightedMentionRate = 0.0;
  
  const engine_scores = {};
  activeEngines.forEach(eng => {
    const agg = engineAggs[eng];
    weightedScore += agg.prompt_score * normalizedWeights[eng];
    weightedMentionRate += (agg.mentioned ? 1.0 : 0.0) * normalizedWeights[eng];
    engine_scores[eng] = agg.prompt_score;
  });
  
  // Sort engines by weight descending to find primary engine
  const sortedActive = [...activeEngines].sort((a, b) => {
    return (ENGINE_DEFAULT_WEIGHTS[b] ?? 0.25) - (ENGINE_DEFAULT_WEIGHTS[a] ?? 0.25);
  });
  const primaryEngine = sortedActive[0];
  const primaryAgg = engineAggs[primaryEngine];
  
  const promptText = primaryAgg.prompt;
  const mentioned = weightedMentionRate >= 0.5;
  
  const position = primaryAgg.position;
  const sentiment = primaryAgg.sentiment;
  const competitors_found = uniqueUnion(Object.values(engineAggs).map(a => a.competitors_found || []));
  const citations = uniqueUnion(Object.values(engineAggs).map(a => a.citations || []));
  const key_phrases = uniqueUnion(Object.values(engineAggs).map(a => a.key_phrases || []));
  
  return {
    prompt: promptText,
    mentioned,
    position,
    sentiment,
    competitors_found,
    citations,
    key_phrases,
    raw_response: primaryAgg.raw_response,
    model_used: primaryAgg.model_used,
    probe_temperature: primaryAgg.probe_temperature,
    prompt_score: Math.round(weightedScore * 10) / 10,
    prompt_score_stddev: primaryAgg.prompt_score_stddev,
    run_details: runs,
    engine_scores,
    engine_details: engineAggs,
    judge_method: primaryAgg.judge_method,
    judge_model_used: primaryAgg.judge_model_used
  };
}
