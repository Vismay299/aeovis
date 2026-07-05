import { generateContent } from "./gemini.js";
import { scrapeForSummary } from "./firecrawl.js";

async function summarizeWebsiteContent(rawContent, brand, industry) {
  if (!rawContent || rawContent.length < 200) return rawContent;

  const summaryPrompt = `You are an expert content analyst. Summarize the key offerings, products/services, unique value propositions, and target audience for the following website content.

Brand: ${brand}
Industry: ${industry || "General"}

Website content (may be truncated):
${rawContent.slice(0, 5000)}

Return ONLY a concise 300-500 word summary focused on what makes this brand distinct. No introductions, no JSON, just the summary text.`;

  try {
    const summary = await generateContent(summaryPrompt, { stats, timeout: 20000 });
    return summary.trim() || rawContent.slice(0, 3000);
  } catch (e) {
    console.warn("Gemini summarization failed, using raw content");
    return rawContent.slice(0, 3000);
  }
}

export async function generatePromptsForBrand(brand, website, industry = "", stats = null) {
  let websiteSummary = await scrapeForSummary(website);
  websiteSummary = await summarizeWebsiteContent(websiteSummary, brand, industry);

  const genPrompt = `You are an expert Answer Engine Optimization strategist. Your job is to generate realistic questions that real users would type into AI chatbots (ChatGPT, Claude, Perplexity, Gemini, etc.) about this specific brand.

Brand Name: ${brand}
Website: ${website || "not provided"}
Industry / Category: ${industry || "General"}
Key offerings / summary from website:
${(websiteSummary || "").slice(0, 4000)}

Generate 15-20 high-quality, diverse prompts. Mix:
- Informational / "how to" questions
- Comparison and "vs" questions (relevant competitors if known)
- "Best for [use case]" questions
- Problem-solving / pain point questions
- Buyer journey questions (awareness, consideration, decision)

Return ONLY a valid JSON array of objects with this structure:
[{"text": "...", "topic_suggestion": "..."}]

Do not add any extra text, markdown, or explanations outside the JSON.`;

  try {
    // Use structured JSON mode for more reliable output
    const responseText = await generateContent(genPrompt, { jsonMode: true, stats, timeout: 30000 });
    // Parse directly since we requested JSON
    let promptsArray;
    try {
      promptsArray = JSON.parse(responseText.trim());
    } catch {
      // Fallback to regex extraction
      const jsonMatch = responseText.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        promptsArray = JSON.parse(jsonMatch[0]);
      }
    }

    if (Array.isArray(promptsArray) && promptsArray.length > 0) {
      return promptsArray.map(p => p.text || p.prompt || p).filter(Boolean);
    }
    return [];
  } catch (e) {
    console.error("Failed to generate custom prompts:", e);
    return [];
  }
}
