export async function probePerplexity(prompt, options = {}, retries = 2) {
  const apiKey = process.env.PERPLEXITY_API_KEY;
  if (!apiKey) {
    console.warn("[perplexity] API key not found. Skipping Perplexity probe.");
    return { text: "", model_used: "perplexity-skipped", citations: [], cost: 0.0, tokens: 0 };
  }

  const model = "sonar";
  const body = {
    model,
    messages: [{ role: "user", content: prompt }],
    temperature: options.temperature !== undefined ? options.temperature : 0.4
  };

  const wait = (ms) => new Promise(res => setTimeout(res, ms));
  let lastErr = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const timeoutMs = options.timeout || 30000; // Search models can take longer
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

      const res = await fetch("https://api.perplexity.ai/chat/completions", {
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
        throw new Error(`Perplexity HTTP ${res.status}: ${await res.text()}`);
      }

      const resJson = await res.json();
      const text = resJson.choices?.[0]?.message?.content || "";
      const citations = resJson.citations || [];
      const usage = resJson.usage || {};
      
      const promptTokens = usage.prompt_tokens || 0;
      const completionTokens = usage.completion_tokens || 0;
      const tokens = usage.total_tokens || (promptTokens + completionTokens);

      // Cost: $1.00 / 1M input tokens, $1.00 / 1M output tokens, plus $0.005 flat search fee per query
      const cost = (promptTokens * 1.0 / 1e6) + (completionTokens * 1.0 / 1e6) + 0.005;

      if (options.stats) {
        options.stats.tokens = (options.stats.tokens || 0) + tokens;
        options.stats.cost = (options.stats.cost || 0) + cost;
      }

      return {
        text,
        model_used: model,
        citations,
        cost,
        tokens
      };
    } catch (e) {
      lastErr = e;
      if (attempt < retries) {
        const delay = 1500 * Math.pow(2, attempt);
        await wait(delay);
      }
    }
  }

  console.error(`[scan] Perplexity failed after ${retries} retries: ${lastErr}`);
  return { text: "", model_used: "perplexity-failed", citations: [], cost: 0.0, tokens: 0 };
}
