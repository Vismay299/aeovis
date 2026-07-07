export async function probeOpenAI(prompt, options = {}, retries = 2) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.warn("[openai] API key not found. Skipping OpenAI probe.");
    return { text: "", model_used: "openai-skipped", citations: [], cost: 0.0, tokens: 0 };
  }

  const model = "gpt-4o-mini";
  const body = {
    model,
    messages: [{ role: "user", content: prompt }],
    temperature: options.temperature !== undefined ? options.temperature : 0.4
  };

  if (options.jsonMode) {
    body.response_format = { type: "json_object" };
    body.temperature = 0.1;
  }

  const wait = (ms) => new Promise(res => setTimeout(res, ms));
  let lastErr = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const timeoutMs = options.timeout || 20000;
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

      const res = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${apiKey}`
        },
        body: JSON.stringify(body),
        signal: controller.signal
      });

      clearTimeout(timeoutId);

      if (!res.ok) {
        throw new Error(`OpenAI HTTP ${res.status}: ${await res.text()}`);
      }

      const resJson = await res.json();
      const text = resJson.choices?.[0]?.message?.content || "";
      const usage = resJson.usage || {};
      
      const promptTokens = usage.prompt_tokens || 0;
      const completionTokens = usage.completion_tokens || 0;
      const tokens = usage.total_tokens || (promptTokens + completionTokens);

      // Cost: $0.15 / 1M input tokens, $0.60 / 1M output tokens (gpt-4o-mini)
      const cost = (promptTokens * 0.15 / 1e6) + (completionTokens * 0.60 / 1e6);

      if (options.stats) {
        options.stats.tokens = (options.stats.tokens || 0) + tokens;
        options.stats.cost = (options.stats.cost || 0) + cost;
      }

      return {
        text,
        model_used: model,
        citations: [], // OpenAI does not return structured references in chat completion
        cost,
        tokens
      };
    } catch (e) {
      lastErr = e;
      if (attempt < retries) {
        const delay = 1000 * Math.pow(2, attempt);
        await wait(delay);
      }
    }
  }

  console.error(`[scan] OpenAI failed after ${retries} retries: ${lastErr}`);
  return { text: "", model_used: "openai-failed", citations: [], cost: 0.0, tokens: 0 };
}
