import { generateContent } from "./gemini.js";
import { scrapeForSummary } from "./firecrawl.js";

async function summarizeWebsiteContent(rawContent, brand, industry, stats = null) {
  if (!rawContent || rawContent.length < 200) return rawContent;

  const summaryPrompt = `You are an expert B2B buyer intent analyst.

Analyze the website content below and create a summary that will help generate realistic questions a potential customer would actually ask an AI chatbot.

Focus on:
- The real frustrations and pains the target audience faces (describe them using language from the site).
- How they would naturally describe their situation and current problems.
- Who the typical buyer is (job/role, industry, mindset) and what outcomes they want.
- Common problem areas this product solves, and the language used to describe them.
- Any tools or current ways of working they mention (e.g. Excel, existing software, manual processes).

Do not just repeat features. Focus on the buyer's pains, goals, and natural search language.

Website content (may be truncated):
${rawContent.slice(0, 5000)}

Brand reference: ${brand} (do not center the summary on the brand name itself)
Industry: ${industry || "General"}

Return ONLY a concise 300-500 word summary. No introductions or JSON.`;

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
  websiteSummary = await summarizeWebsiteContent(websiteSummary, brand, industry, stats);

  const genPrompt = `You are an expert in real buyer search behavior for B2B products and services.

Your job is to generate realistic questions that a potential customer would actually type into Gemini, ChatGPT or Perplexity when looking for solutions to problems in their business or daily life.

Use the website summary below to understand the specific pains, language, and use cases for THIS product.

Website summary:
${(websiteSummary || "").slice(0, 3500)}

Generate 18-22 natural, realistic prompts that real users would type.

CRITICAL RULES:
- Most prompts must NOT contain the brand name "${brand}". Real users searching for help usually have never heard of this specific brand or product.
- Base the questions on the pains and language described in the summary above. Do not invent unrelated problems.
- Write the way real people (not technical experts) actually talk and search.
- Focus on the problem the user is facing and the outcome they want.
- Use the provided summary to make questions relevant to this exact offering.

Good examples of style (adapt the style to the summary, do not copy these literally):
  - "How do I solve [specific pain from summary] without [current painful way]?"
  - "I only find out about [problem] after it costs me money, how can I catch this earlier?"
  - "Tools to [desired outcome] for [audience from summary]"
  - "Why do I keep getting surprised by [problem]?"

Generate a diverse mix:
- Problem awareness questions
- "How do I..." or "What's the best way to..." questions
- Questions about integrating with tools they already use
- Questions about avoiding big projects or manual work
- "Best [tool/category] for [use case]" queries

Return ONLY a valid JSON array of objects:
[{"text": "the exact question a user would type"}]

Do not add any extra text, explanations, or markdown outside the JSON.`;

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
