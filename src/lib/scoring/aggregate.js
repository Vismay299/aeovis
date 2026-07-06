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

  const sanitizedRuns = runs.map(r => {
    const { raw_response, ...rest } = r;
    return rest;
  });

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
