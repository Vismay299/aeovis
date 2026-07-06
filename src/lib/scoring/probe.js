import { generateContent } from "@/lib/gemini";
import { PROBE_TEMPERATURE } from "./constants.js";
import { scorePromptResult } from "./computeVisibilityScore.js";
import { judgeDeterministic, isAmbiguous, judgeWithLLM } from "./judge.js";

/**
 * Runs a single probe for a given prompt and analyzes the result.
 *
 * @param {string} promptText - The prompt to run
 * @param {string} brand - Brand name
 * @param {Array} competitors - List of competitors
 * @param {string} url - Brand URL
 * @param {Object} stats - Stats accumulator object
 * @returns {Promise<Object>} Single prompt run analysis result
 */
export async function probePromptOnce(promptText, brand, competitors, url, stats) {
  let fullPrompt = promptText;
  if (competitors && competitors.length > 0) {
    fullPrompt = `${promptText}\n\nConsider these existing options if relevant: ${competitors.join(", ")}.`;
  }

  let responseText = "";
  let modelUsed = "";
  try {
    const res = await generateContent(fullPrompt, { temperature: PROBE_TEMPERATURE, stats, timeout: 20000 });
    responseText = res.text;
    modelUsed = res.model_used;
  } catch (e) {
    // keep empty
  }

  const analysisResult = await runJudgePipeline(promptText, responseText, brand, competitors, url, stats);
  analysisResult.raw_response = responseText ? responseText.slice(0, 8192) : "";
  analysisResult.model_used = modelUsed || "";
  analysisResult.probe_temperature = PROBE_TEMPERATURE;
  analysisResult.prompt_score = Math.round(scorePromptResult(analysisResult, url) * 1000) / 10;
  
  return analysisResult;
}

/**
 * Runs a prompt multiple times in parallel.
 *
 * @param {string} promptText - The prompt to run
 * @param {string} brand - Brand name
 * @param {Array} competitors - List of competitors
 * @param {string} url - Brand URL
 * @param {Object} stats - Stats accumulator object
 * @param {number} N - Number of runs
 * @returns {Promise<Array>} Array of analysis results
 */
export async function probePromptMultiple(promptText, brand, competitors, url, stats, N = 3) {
  const promises = Array.from({ length: N }).map(() =>
    probePromptOnce(promptText, brand, competitors, url, stats)
  );
  return Promise.all(promises);
}

/**
 * Decoupled Judge Orchestrator Pipeline
 */
async function runJudgePipeline(promptText, responseText, brand, competitors, url, stats) {
  if (!responseText) {
    console.log("judge: skipped (empty response)");
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
    console.log("judge: deterministic");
    const detResult = judgeDeterministic(responseText, brand, url, competitors);
    return {
      prompt: promptText,
      response_snippet: responseText.slice(0, 300),
      key_phrases: [],
      ...detResult
    };
  }

  console.log("judge: llm (ambiguous)");
  const llmResult = await judgeWithLLM(promptText, responseText, brand, competitors, stats);
  if (llmResult) {
    return {
      prompt: promptText,
      response_snippet: responseText.slice(0, 300),
      ...llmResult
    };
  }

  console.warn("LLM judge failed, falling back to deterministic");
  const detResult = judgeDeterministic(responseText, brand, url, competitors);
  detResult.judge_method = "fallback";
  return {
    prompt: promptText,
    response_snippet: responseText.slice(0, 300),
    key_phrases: [],
    ...detResult
  };
}
