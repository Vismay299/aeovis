import { GoogleGenerativeAI } from "@google/generative-ai";

const MODEL_FALLBACKS = [
  "gemini-2.5-flash-lite",
  "gemini-flash-lite-latest",
  "gemini-3.1-flash-lite",
  "gemini-2.5-flash",
  "gemini-3-flash-preview",
];

export async function probeGemini(prompt, options = {}, retries = 2) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.warn("GEMINI_API_KEY is not configured.");
    return { text: "", model_used: "gemini-skipped", citations: [], cost: 0.0, tokens: 0 };
  }

  const genAI = new GoogleGenerativeAI(apiKey);

  const modelConfig = { generationConfig: {} };
  if (options.jsonMode) {
    modelConfig.generationConfig.responseMimeType = "application/json";
    modelConfig.generationConfig.temperature = 0.1;
  }
  if (options.temperature !== undefined) {
    modelConfig.generationConfig.temperature = options.temperature;
  }

  const wait = (ms) => new Promise(res => setTimeout(res, ms));
  let lastErr = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    for (const modelName of MODEL_FALLBACKS) {
      try {
        const model = genAI.getGenerativeModel({ 
          model: modelName,
          ...modelConfig 
        });

        const timeoutMs = options.timeout || 20000;
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

        const requestOptions = { timeout: timeoutMs, signal: controller.signal };
        const resultPromise = model.generateContent(prompt, { requestOptions });
        
        const result = await Promise.race([
          resultPromise,
          new Promise((_, reject) => setTimeout(() => reject(new Error("Gemini timeout")), timeoutMs))
        ]);

        clearTimeout(timeoutId);
        const response = await result.response;
        
        let tokens = 0;
        let cost = 0.0;

        if (response.usageMetadata) {
          const promptTokens = response.usageMetadata.promptTokenCount || 0;
          const candidatesTokens = response.usageMetadata.candidatesTokenCount || 0;
          tokens = response.usageMetadata.totalTokenCount || (promptTokens + candidatesTokens);
          
          // Cost: $0.075 / 1M input tokens, $0.30 / 1M output tokens (Gemini 2.5 Flash)
          cost = (promptTokens * 0.075 / 1e6) + (candidatesTokens * 0.30 / 1e6);
          
          if (options.stats) {
            options.stats.tokens = (options.stats.tokens || 0) + tokens;
            options.stats.cost = (options.stats.cost || 0) + cost;
          }
        }

        return {
          text: response.text(),
          model_used: modelName,
          citations: [], // Gemini does not return structured citation fields natively
          cost,
          tokens
        };
      } catch (e) {
        lastErr = e;
        continue;
      }
    }
    
    if (attempt < retries) {
      const delay = 1000 * Math.pow(2, attempt);
      await wait(delay);
    }
  }

  console.error(`[scan] Gemini failed after ${retries} retries: ${lastErr}`);
  return { text: "", model_used: "gemini-failed", citations: [], cost: 0.0, tokens: 0 };
}
