import { GoogleGenerativeAI } from "@google/generative-ai";

export async function generateContent(prompt, options = {}, retries = 2) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error("GEMINI_API_KEY is not configured.");
    return { text: "", model_used: "" };
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
      const timeoutMs = options.timeout || 20000;
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
      let raceTimeoutId = null;

      try {
        const model = genAI.getGenerativeModel({ 
          model: modelName,
          ...modelConfig 
        });

        // R6.5.6 (finding A1): requestOptions is the SDK's SECOND ARGUMENT, not a
        // field on it. `{ requestOptions }` hid the signal from buildFetchOptions,
        // so the fetch init had no `signal` and the controller was inert — the
        // request was abandoned by Promise.race, never cancelled. Pinned by
        // src/lib/geminiAbort.test.mjs; do not re-wrap this.
        //
        // No `timeout` here on purpose: the SDK's timeout branch schedules its own
        // setTimeout(abort) that it never clears, so it would strand one timer per
        // rung for the full deadline — the same leak, moved. The controller above
        // is the deadline, and the finally block does clear it.
        const requestOptions = { signal: controller.signal };
        const resultPromise = model.generateContent(prompt, requestOptions);

        const result = await Promise.race([
          resultPromise,
          new Promise((_, reject) => {
            raceTimeoutId = setTimeout(() => reject(new Error("Gemini timeout")), timeoutMs);
          })
        ]);

        const response = await result.response;
        
        let tokens = 0;
        let cost = 0.0;
        if (response.usageMetadata) {
          const promptTokens = response.usageMetadata.promptTokenCount || 0;
          const candidatesTokens = response.usageMetadata.candidatesTokenCount || 0;
          tokens = response.usageMetadata.totalTokenCount || (promptTokens + candidatesTokens);
          cost = (promptTokens * 0.075 / 1e6) + (candidatesTokens * 0.30 / 1e6);
          
          if (options.stats) {
            options.stats.tokens = (options.stats.tokens || 0) + tokens;
            options.stats.cost = (options.stats.cost || 0) + cost;
          }
        }

        return { text: response.text(), model_used: modelName, tokens, cost };
      } catch (e) {
        lastErr = e;
        continue; // try next model
      } finally {
        // Retire THIS rung before the ladder advances. Clearing the deadlines is
        // what stops five models x three attempts stranding fifteen live timers.
        // The abort is belt-and-braces (today the deadline above fires at the
        // same instant the race gives up) but it is what makes clearing the
        // deadline safe: otherwise an in-flight rung would have nothing left to
        // stop it. No test kills this line on its own.
        clearTimeout(timeoutId);
        if (raceTimeoutId !== null) clearTimeout(raceTimeoutId);
        controller.abort();
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
  return { text: "", model_used: "" };
}
