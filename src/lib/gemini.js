import { GoogleGenerativeAI } from "@google/generative-ai";

export async function generateContent(prompt) {
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

  let lastErr = null;
  for (const modelName of MODEL_FALLBACKS) {
    try {
      const model = genAI.getGenerativeModel({ model: modelName });
      const result = await model.generateContent(prompt);
      const response = await result.response;
      return response.text();
    } catch (e) {
      lastErr = e;
      continue;
    }
  }

  console.error(`[scan] all models failed: ${lastErr}`);
  return "";
}
