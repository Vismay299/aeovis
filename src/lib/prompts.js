import { generateContent } from "./gemini";
import { scrapeForSummary } from "./firecrawl";

export async function generatePromptsForBrand(brand, website, industry) {
  const websiteSummary = await scrapeForSummary(website);

  const prompt = `You are an expert Answer Engine Optimization strategist. Your job is to generate realistic questions that real users would type into AI chatbots (ChatGPT, Claude, Perplexity, etc.) about a specific brand or topic.

Brand Name: ${brand}
Website: ${website}
Industry / Category: ${industry}
Key offerings from website: ${websiteSummary}

Generate 15-20 high-quality, diverse prompts. Mix:
- Informational / "how to" questions
- Comparison and "vs" questions
- "Best for [use case]" questions
- Problem-solving / pain point questions
- Buyer journey questions (awareness, consideration, decision)

Return ONLY a valid JSON array of objects with this structure:
[{"text": "...", "topic_suggestion": "..."}]

Do not add any extra text or markdown formatting outside the JSON array.`;

  try {
    const responseText = await generateContent(prompt);
    // Attempt to extract JSON if it was wrapped in markdown
    const jsonMatch = responseText.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      const promptsArray = JSON.parse(jsonMatch[0]);
      if (Array.isArray(promptsArray) && promptsArray.length > 0) {
        return promptsArray.map(p => p.text);
      }
    }
    return [];
  } catch (e) {
    console.error("Failed to generate custom prompts:", e);
    return [];
  }
}
