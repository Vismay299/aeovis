import { NextResponse } from "next/server";
import { INDUSTRY_PROMPTS } from "@/data/industries";
import { generateContent } from "@/lib/gemini";
import { insertScan } from "@/lib/db";
import { generatePromptsForBrand } from "@/lib/prompts";

const POSITIVE_WORDS = ["great", "best", "top", "excellent", "recommend", "leading", "powerful"];
const NEGATIVE_WORDS = ["expensive", "limited", "poor", "lacking", "outdated", "issues"];

export async function POST(request) {
  try {
    const payload = await request.json();
    const stats = { tokens: 0 };
    const brand = (payload.brand || "").trim();
    const url = (payload.url || "").trim();
    const industry = (payload.industry || "").trim();
    const competitorsRaw = payload.competitors || "";

    if (!brand) {
      return NextResponse.json({ detail: "Brand name is required." }, { status: 400 });
    }
    // Industry is recommended for fallback and categorization, but dynamic prompt generation works without it
    const hasValidIndustry = !!INDUSTRY_PROMPTS[industry];

    const competitors = competitorsRaw
      ? competitorsRaw.split(",").map(c => c.trim()).filter(Boolean)
      : [];

    let prompts = await generatePromptsForBrand(brand, url, industry);
    const usedDynamicPrompts = prompts && prompts.length > 0;

    if (!usedDynamicPrompts) {
      if (hasValidIndustry) {
        console.log("Fallback to static industry prompts");
        prompts = INDUSTRY_PROMPTS[industry].prompts;
      } else {
        console.warn("No dynamic prompts generated and no valid industry for fallback");
        prompts = [];
      }
    }

    console.log(`[scan] Used dynamic prompts: ${usedDynamicPrompts} (${prompts.length} prompts)`);

    const results = [];
    let promptsMentioned = 0;

    // Batch processing to reduce latency
    const chunkSize = 5;
    for (let i = 0; i < prompts.length; i += chunkSize) {
      const chunk = prompts.slice(i, i + chunkSize);
      
      const chunkPromises = chunk.map(async (promptText) => {
        let fullPrompt = promptText;
        let contextLines = [];
        if (url) {
          contextLines.push(`Context: The brand being evaluated is ${brand} (${url}).`);
        }
        if (competitors.length > 0) {
          contextLines.push(`Consider alongside these competitors: ${competitors.join(", ")}.`);
        }
        if (contextLines.length) {
          fullPrompt = `${promptText}\n\n${contextLines.join(" ")} Evaluate fairly and include the brand when relevant.`;
        }

        let responseText = "";
        try {
          responseText = await generateContent(fullPrompt, { stats, timeout: 20000 });
        } catch (e) {
          // keep empty
        }

        return await analyzeResponseWithLLM(promptText, responseText, brand, competitors, stats);
      });

      const chunkResults = await Promise.all(chunkPromises);
      for (const result of chunkResults) {
        if (result.mentioned) {
          promptsMentioned += 1;
        }
        results.push(result);
      }
    }

    const promptsTracked = prompts.length;
    const visibilityPct = promptsTracked
      ? Math.round((promptsMentioned / promptsTracked) * 1000) / 10
      : 0.0;

    const scannedAt = new Date().toISOString();

    const scanRecord = {
      brand,
      url,
      industry,
      platform: "gemini",
      visibility_pct: visibilityPct,
      prompts_tracked: promptsTracked,
      prompts_mentioned: promptsMentioned,
      competitors: competitors,
      competitors_raw: competitorsRaw,
      results,
      scanned_at: scannedAt,
      used_dynamic_prompts: usedDynamicPrompts,
      tokens_used: stats.tokens
    };

    try {
      await insertScan(scanRecord);
    } catch (e) {
      // ignore DB errors
    }

    return NextResponse.json(scanRecord);
  } catch (error) {
    return NextResponse.json({ detail: "Internal Server Error" }, { status: 500 });
  }
}

async function analyzeResponseWithLLM(promptText, responseText, brand, competitors, stats) {
  if (!responseText) {
    return {
      prompt: promptText,
      response_snippet: "",
      mentioned: false,
      position: "omitted",
      sentiment: "neutral",
      competitors_found: [],
      citations: [],
      key_phrases: []
    };
  }

  const extractionPrompt = `You are an AI analyzing how a brand is mentioned in a text.
Brand: ${brand}
Competitors: ${competitors.join(', ') || 'None provided'}
User Prompt: ${promptText}

Text to analyze:
---
${responseText}
---

Extract the following information and return it as a JSON object:
- "mentioned": boolean, true if the brand is mentioned.
- "position": string, one of "recommended" (if strongly recommended early), "compared" (if compared with others), "cited" (if just mentioned as a source), or "omitted" (if not mentioned).
- "sentiment": string, "positive", "negative", or "neutral" towards the brand.
- "competitors_found": array of strings, listing any of the provided competitors found in the text. If none, return empty array. If other competitors are found that were not in the list, you can add them too.
- "citations": array of strings, any URLs or website links cited in the text.
- "key_phrases": array of strings, 2-3 key phrases about the brand.

Respond ONLY with valid JSON. Do not include markdown formatting.`;

  try {
    const jsonStr = await generateContent(extractionPrompt, { jsonMode: true, stats, timeout: 30000 });
    const cleanStr = jsonStr.replace(/```json\n?|\n?```/g, "").trim();
    const result = JSON.parse(cleanStr);
    
    return {
      prompt: promptText,
      response_snippet: responseText.slice(0, 300),
      mentioned: !!result.mentioned,
      position: result.position || "omitted",
      sentiment: result.sentiment || "neutral",
      competitors_found: result.competitors_found || [],
      citations: result.citations || [],
      key_phrases: result.key_phrases || []
    };
  } catch (e) {
    console.warn("LLM extraction failed, using fallback:", e);
    return analyzeResponseFallback(promptText, responseText, brand, competitors);
  }
}

function analyzeResponseFallback(promptText, responseText, brand, competitors) {
  const textLower = responseText.toLowerCase();
  const brandLower = brand.toLowerCase();
  const mentioned = textLower.includes(brandLower);

  let position = "omitted";
  let sentiment = "neutral";
  const competitorsFound = [];

  if (mentioned) {
    const idx = textLower.indexOf(brandLower);
    const textLen = responseText.length || 1;
    const relative = idx / textLen;

    if (relative <= 0.2) position = "recommended";
    else if (relative <= 0.5) position = "compared";
    else position = "cited";

    sentiment = classifySentiment(responseText, idx, brand);
  }

  for (const comp of competitors) {
    if (textLower.includes(comp.toLowerCase())) {
      competitorsFound.push(comp);
    }
  }

  return {
    prompt: promptText,
    response_snippet: responseText.slice(0, 300),
    mentioned,
    position,
    sentiment,
    competitors_found: competitorsFound,
    citations: [],
    key_phrases: []
  };
}

function classifySentiment(responseText, brandIdx, brand) {
  const textLower = responseText.toLowerCase();
  const windowStart = Math.max(0, brandIdx - 100);
  const windowEnd = Math.min(textLower.length, brandIdx + brand.length + 100);
  const window = textLower.substring(windowStart, windowEnd);

  let posCount = 0;
  for (const w of POSITIVE_WORDS) {
    if (window.includes(w)) posCount++;
  }

  let negCount = 0;
  for (const w of NEGATIVE_WORDS) {
    if (window.includes(w)) negCount++;
  }

  if (posCount > negCount) return "positive";
  if (negCount > posCount) return "negative";
  return "neutral";
}
