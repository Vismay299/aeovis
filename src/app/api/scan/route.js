import { NextResponse } from "next/server";
import { INDUSTRY_PROMPTS } from "@/data/industries";
import { generateContent } from "@/lib/gemini";
import { insertScan } from "@/lib/db";

const POSITIVE_WORDS = ["great", "best", "top", "excellent", "recommend", "leading", "powerful"];
const NEGATIVE_WORDS = ["expensive", "limited", "poor", "lacking", "outdated", "issues"];

export async function POST(request) {
  try {
    const payload = await request.json();
    const brand = (payload.brand || "").trim();
    const url = (payload.url || "").trim();
    const industry = (payload.industry || "").trim();
    const competitorsRaw = payload.competitors || "";

    if (!brand) {
      return NextResponse.json({ detail: "Brand name is required." }, { status: 400 });
    }
    if (!INDUSTRY_PROMPTS[industry]) {
      return NextResponse.json({ detail: "Invalid industry." }, { status: 400 });
    }

    const competitors = competitorsRaw
      ? competitorsRaw.split(",").map(c => c.trim()).filter(Boolean)
      : [];
    const prompts = INDUSTRY_PROMPTS[industry].prompts;

    const results = [];
    let promptsMentioned = 0;

    for (const promptText of prompts) {
      let fullPrompt = promptText;
      if (url) {
        fullPrompt = `${promptText}\n\nFor context, the brand being evaluated is ${brand} (${url}). Consider it alongside other relevant options.`;
      }

      let responseText = "";
      try {
        responseText = await generateContent(fullPrompt);
      } catch (e) {
        // keep empty
      }

      const result = analyzeResponse(promptText, responseText, brand, competitors);
      if (result.mentioned) {
        promptsMentioned += 1;
      }
      results.push(result);
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
      results,
      scanned_at: scannedAt,
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

function analyzeResponse(promptText, responseText, brand, competitors) {
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
