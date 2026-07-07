import { probeEngine } from "../engines/adapter.js";
import { getEnabledEngines } from "../engines/types.js";
import { PROBE_TEMPERATURE } from "./constants.js";
import { scorePromptResult } from "./computeVisibilityScore.js";
import { judgeDeterministic, isAmbiguous, judgeWithLLM } from "./judge.js";

/**
 * Runs a single probe for a given prompt, engine, and analyzes the result.
 *
 * @param {string} promptText - The prompt to run
 * @param {string} brand - Brand name
 * @param {Array} competitors - List of competitors
 * @param {string} url - Brand URL
 * @param {Object} stats - Stats accumulator object
 * @param {string} engine - Engine to run (gemini | openai | perplexity)
 * @returns {Promise<Object>} Single prompt run analysis result
 */
export async function probePromptOnce(promptText, brand, competitors, url, stats, engine = "gemini") {
  let fullPrompt = promptText;
  if (competitors && competitors.length > 0) {
    fullPrompt = `${promptText}\n\nConsider these existing options if relevant: ${competitors.join(", ")}.`;
  }

  let responseText = "";
  let modelUsed = "";
  let engineCitations = [];
  let cost = 0.0;

  try {
    const res = await probeEngine(engine, fullPrompt, { temperature: PROBE_TEMPERATURE, stats, timeout: 20000 });
    responseText = res.text;
    modelUsed = res.model_used;
    engineCitations = res.citations || [];
    cost = res.cost || 0.0;
  } catch (e) {
    console.error(`[probe] Engine ${engine} failed:`, e);
  }

  const analysisResult = await runJudgePipeline(promptText, responseText, brand, competitors, url, stats);
  
  // Merge engine structured citations (e.g. from Perplexity) with judge citations
  if (engineCitations.length > 0) {
    analysisResult.citations = Array.from(new Set([...(analysisResult.citations || []), ...engineCitations]));
  }

  analysisResult.raw_response = responseText ? responseText.slice(0, 8192) : "";
  analysisResult.model_used = modelUsed || "";
  analysisResult.probe_temperature = PROBE_TEMPERATURE;
  analysisResult.prompt_score = Math.round(scorePromptResult(analysisResult, url) * 1000) / 10;
  analysisResult.cost = cost;
  analysisResult.engine = engine;
  
  return analysisResult;
}

/**
 * Runs a prompt multiple times in parallel against all enabled engines.
 * Handles partial engine failures gracefully by marking them as failed but continuing.
 *
 * @param {string} promptText - The prompt to run
 * @param {string} brand - Brand name
 * @param {Array} competitors - List of competitors
 * @param {string} url - Brand URL
 * @param {Object} stats - Stats accumulator object
 * @param {number} N - Number of runs per engine
 * @returns {Promise<Array>} Array of analysis results across all enabled engines
 */
export async function probePromptMultiple(promptText, brand, competitors, url, stats, N = 3) {
  const enabledEngines = getEnabledEngines();
  const allRuns = [];
  
  for (const engine of enabledEngines) {
    const promises = Array.from({ length: N }).map(async () => {
      try {
        const run = await probePromptOnce(promptText, brand, competitors, url, stats, engine);
        run.engine = engine;
        return run;
      } catch (e) {
        console.error(`[scan] Error probing engine ${engine}:`, e);
        return {
          prompt: promptText,
          response_snippet: "",
          mentioned: false,
          position: "omitted",
          sentiment: "neutral",
          competitors_found: [],
          citations: [],
          key_phrases: [],
          judge_method: "skipped",
          judge_model_used: "",
          raw_response: "",
          model_used: `${engine}-failed`,
          probe_temperature: PROBE_TEMPERATURE,
          prompt_score: 0.0,
          cost: 0.0,
          engine,
          error: e.message
        };
      }
    });
    
    const engineRuns = await Promise.all(promises);
    allRuns.push(...engineRuns);
  }
  
  return allRuns;
}

/**
 * Decoupled Judge Orchestrator Pipeline
 */
async function runJudgePipeline(promptText, responseText, brand, competitors, url, stats) {
  if (!responseText) {
    return {
      prompt: promptText,
      response_snippet: "",
      mentioned: false,
      position: "omitted",
      sentiment: "neutral",
      competitors_found: [],
      citations: [],
      key_phrases: [],
      judge_method: "skipped",
      judge_model_used: ""
    };
  }

  const ambiguous = isAmbiguous(responseText, brand, url);
  if (!ambiguous) {
    const detResult = judgeDeterministic(responseText, brand, url, competitors);
    return {
      prompt: promptText,
      response_snippet: responseText.slice(0, 300),
      key_phrases: [],
      ...detResult
    };
  }

  const llmResult = await judgeWithLLM(promptText, responseText, brand, competitors, stats);
  if (llmResult) {
    return {
      prompt: promptText,
      response_snippet: responseText.slice(0, 300),
      ...llmResult
    };
  }

  const detResult = judgeDeterministic(responseText, brand, url, competitors);
  detResult.judge_method = "fallback";
  return {
    prompt: promptText,
    response_snippet: responseText.slice(0, 300),
    key_phrases: [],
    ...detResult
  };
}
