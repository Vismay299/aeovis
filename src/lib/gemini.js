import { GoogleGenerativeAI } from "@google/generative-ai";

export async function generateContent(prompt, options = {}, retries = 2) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error("GEMINI_API_KEY is not configured.");
    return "";
  }

  const genAI = new GoogleGenerativeAI(apiKey);

  const MODEL_FALLBACKS = [
    "gemini-2.5-flash-lite",
    "gemini-flash-lite-latest",
    "gemini-3.1-flash-lite",
    "gemini-2.5-flash",
    "gemini-3-flash-preview",
  ];

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

        // Natively pass AbortController to the Google SDK if supported, while keeping Promise.race as a safety net
        const requestOptions = { timeout: timeoutMs, signal: controller.signal };
        const resultPromise = model.generateContent(prompt, { requestOptions });
        
        const result = await Promise.race([
          resultPromise,
          new Promise((_, reject) => setTimeout(() => reject(new Error("Gemini timeout")), timeoutMs))
        ]);

        clearTimeout(timeoutId);
        const response = await result.response;
        
        // Token cost logging via object reference
        if (response.usageMetadata && response.usageMetadata.totalTokenCount) {
          const used = response.usageMetadata.totalTokenCount;
          if (options.stats) {
            options.stats.tokens = (options.stats.tokens || 0) + used;
          }
        }

        return response.text();
      } catch (e) {
        lastErr = e;
        continue; // try next model
      }
    }
    
    // Backoff before retrying the full model cascade
    if (attempt < retries) {
      const delay = 1000 * Math.pow(2, attempt);
      console.warn(`[gemini] Attempt ${attempt + 1} failed. Retrying in ${delay}ms...`);
      await wait(delay);
    }
  }

  console.error(`[scan] all models failed after ${retries} retries: ${lastErr}`);
  return "";
}
