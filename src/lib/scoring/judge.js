import { generateContent } from "../gemini.js";

const POSITIVE_WORDS = [
  "best", "great", "excellent", "top", "lead", "leading", "recommend", "recommended",
  "awesome", "good", "perfect", "advantage", "strong", "fast", "innovative", "reliable",
  "winner", "outstanding", "superior", "quality", "preferred", "easy", "clean"
];

const NEGATIVE_WORDS = [
  "worst", "poor", "bad", "slow", "expensive", "difficult", "complicated", "weak",
  "lagging", "lacks", "shortcoming", "issue", "bug", "flaw", "concern", "problem",
  "limit", "limitation", "drawback", "avoid", "negative", "fail"
];

/**
 * Extracts brand aliases from a brand name and its website URL.
 * Sorted from longest to shortest to ensure precedence in matching.
 */
export function getBrandAliases(brand, website) {
  const aliases = new Set();
  
  if (brand && typeof brand === "string") {
    const trimmedBrand = brand.trim();
    if (trimmedBrand) {
      aliases.add(trimmedBrand);
      aliases.add(trimmedBrand.toLowerCase());

      // Remove suffixes like Corp, Inc, LLC, Software, Co, Ltd
      const cleanRegex = /\b(corp|corporation|inc|incorporated|llc|co|ltd|software|technologies|systems)\b/gi;
      const cleaned = trimmedBrand.replace(cleanRegex, "").trim();
      if (cleaned && cleaned !== trimmedBrand) {
        aliases.add(cleaned);
        aliases.add(cleaned.toLowerCase());
      }
    }
  }

  if (website && typeof website === "string") {
    try {
      let cleanedUrl = website.trim().toLowerCase();
      if (!/^https?:\/\//i.test(cleanedUrl)) {
        cleanedUrl = "http://" + cleanedUrl;
      }
      const parsed = new URL(cleanedUrl);
      const hostname = parsed.hostname.replace(/^www\./i, "");
      aliases.add(hostname);
      
      const domainName = hostname.split(".")[0];
      if (domainName && domainName.length > 1) {
        aliases.add(domainName);
      }
    } catch (e) {
      // ignore
    }
  }

  return Array.from(aliases)
    .filter(alias => alias && alias.length >= 2)
    .sort((a, b) => b.length - a.length);
}

/**
 * Deterministically checks for brand mention.
 */
export function detectMention(text, aliases) {
  if (!text || !aliases || aliases.length === 0) {
    return false;
  }
  
  for (const alias of aliases) {
    const cleanAlias = alias.toLowerCase();
    const escaped = cleanAlias.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
    const regexStr = `(?:^|[^a-zA-Z0-9_])${escaped}(?:$|[^a-zA-Z0-9_])`;
    const regex = new RegExp(regexStr, "i");
    
    if (regex.test(text)) {
      return true;
    }
  }
  return false;
}

/**
 * Deterministically detects position.
 */
export function detectPosition(text, aliases, competitors = []) {
  if (!detectMention(text, aliases)) {
    return "omitted";
  }
  
  let firstBrandIdx = Infinity;
  let matchedAlias = "";
  for (const alias of aliases) {
    const escaped = alias.toLowerCase().replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
    const regex = new RegExp(`(?:^|[^a-zA-Z0-9_])(${escaped})(?:$|[^a-zA-Z0-9_])`, "i");
    const match = regex.exec(text);
    if (match) {
      const idx = match.index;
      if (idx < firstBrandIdx) {
        firstBrandIdx = idx;
        matchedAlias = alias;
      }
    }
  }
  
  if (firstBrandIdx === Infinity) {
    return "omitted";
  }
  
  // Rule 1: If the brand alias itself contains a dot (e.g. "acme.io")
  // or if the matched text is part of a URL/domain name in the context window.
  const isUrlMatch = /\b[a-zA-Z0-9-]+\.(com|io|app|org|net|co|gov|edu|sh|xyz|info)\b/i;
  const matchWindow = text.substring(
    Math.max(0, firstBrandIdx - 15),
    Math.min(text.length, firstBrandIdx + matchedAlias.length + 15)
  );

  if (matchedAlias.includes(".") || isUrlMatch.test(matchWindow)) {
    return "cited";
  }
  
  // Check if competitors are mentioned
  let competitorMentioned = false;
  for (const comp of competitors) {
    const compAliases = getBrandAliases(comp, "");
    if (detectMention(text, compAliases)) {
      competitorMentioned = true;
      break;
    }
  }
  
  const relativePos = firstBrandIdx / (text.length || 1);
  
  if (relativePos >= 0.7) {
    return "cited";
  }
  
  if (competitorMentioned) {
    return "compared";
  }
  
  return "recommended";
}

/**
 * Deterministically detects sentiment in a window around first brand match.
 */
export function detectSentiment(text, aliases) {
  if (!text || !aliases || aliases.length === 0) {
    return "neutral";
  }

  const lowerText = text.toLowerCase();
  let firstBrandIdx = -1;
  let matchLength = 0;

  for (const alias of aliases) {
    const escaped = alias.toLowerCase().replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
    const regex = new RegExp(`(?:^|[^a-zA-Z0-9_])(${escaped})(?:$|[^a-zA-Z0-9_])`, "i");
    const match = regex.exec(text);
    if (match) {
      firstBrandIdx = match.index;
      matchLength = match[1].length;
      break;
    }
  }

  if (firstBrandIdx === -1) {
    return "neutral";
  }

  const start = Math.max(0, firstBrandIdx - 100);
  const end = Math.min(text.length, firstBrandIdx + matchLength + 100);
  const windowText = lowerText.substring(start, end);

  let positiveCount = 0;
  let negativeCount = 0;

  POSITIVE_WORDS.forEach(word => {
    const regex = new RegExp(`\\b${word}\\b`, "g");
    const matches = windowText.match(regex);
    if (matches) positiveCount += matches.length;
  });

  NEGATIVE_WORDS.forEach(word => {
    const regex = new RegExp(`\\b${word}\\b`, "g");
    const matches = windowText.match(regex);
    if (matches) negativeCount += matches.length;
  });

  if (positiveCount > negativeCount) {
    return "positive";
  } else if (negativeCount > positiveCount) {
    return "negative";
  }
  return "neutral";
}

/**
 * Extract URLs from text.
 */
export function extractCitations(text) {
  if (!text) return [];
  const urlRegex = /https?:\/\/[^\s\)\],;"'<]+/gi;
  const matches = text.match(urlRegex) || [];
  const cleaned = matches.map(url => url.replace(/[.,:;)]+$/, ""));
  return Array.from(new Set(cleaned));
}

/**
 * Deterministic judging logic orchestrator.
 */
export function judgeDeterministic(text, brand, website, competitors = []) {
  const aliases = getBrandAliases(brand, website);
  const mentioned = detectMention(text, aliases);
  
  if (!mentioned) {
    return {
      mentioned: false,
      position: "omitted",
      sentiment: "neutral",
      citations: extractCitations(text),
      competitors_found: [],
      judge_method: "deterministic",
      judge_model_used: ""
    };
  }
  
  const position = detectPosition(text, aliases, competitors);
  const sentiment = detectSentiment(text, aliases);
  const citations = extractCitations(text);
  
  // Find which competitors are present
  const competitorsFound = [];
  for (const comp of competitors) {
    const compAliases = getBrandAliases(comp, "");
    if (detectMention(text, compAliases)) {
      competitorsFound.push(comp);
    }
  }
  
  return {
    mentioned: true,
    position,
    sentiment,
    citations,
    competitors_found: competitorsFound,
    judge_method: "deterministic",
    judge_model_used: ""
  };
}

/**
 * Checks if a response needs LLM verification due to ambiguity (e.g. partial matches or substring match without word boundaries).
 */
export function isAmbiguous(text, brand, website) {
  if (!text) return false;
  
  const aliases = getBrandAliases(brand, website);
  const lowerText = text.toLowerCase();
  
  // 1. Substring match of any alias but without word boundary match
  for (const alias of aliases) {
    const lowerAlias = alias.toLowerCase();
    if (lowerText.includes(lowerAlias) && !detectMention(text, [alias])) {
      return true;
    }
  }
  
  // 2. Multi-word brand: some words present but not the full alias
  const brandWords = brand.split(/\s+/).filter(w => w.length > 2);
  if (brandWords.length > 1) {
    const matchedWords = brandWords.filter(w => lowerText.includes(w.toLowerCase()));
    const hasFullMention = detectMention(text, aliases);
    if (matchedWords.length > 0 && !hasFullMention) {
      return true;
    }
  }
  
  return false;
}

/**
 * Grades the response using LLM as a fallback or for ambiguous mentions.
 */
export async function judgeWithLLM(promptText, responseText, brand, competitors, stats = null) {
  const extractionPrompt = `You are an AI analyzing whether a specific B2B industrial tool is naturally recommended in an AI answer.

Brand being tracked: ${brand}
Competitors list: ${competitors && competitors.length > 0 ? competitors.join(", ") : "None"}
User's question: ${promptText}

AI answer text:
---
${responseText}
---

Rules for "mentioned":
- Only return true if the brand (or its product name) is explicitly named as a solution, recommendation, or relevant option.
- Do NOT count it as mentioned just because the question or context mentioned it — the AI answer itself must bring it up.
- Be strict. Obscure brands should only count if they are genuinely surfaced.

Extract and return ONLY valid JSON:
{
  "mentioned": boolean,
  "position": "recommended" | "compared" | "cited" | "omitted",
  "sentiment": "positive" | "negative" | "neutral",
  "competitors_found": string[],
  "citations": string[],
  "key_phrases": string[]
}`;

  try {
    const { text: jsonStr, model_used: judgeModelUsed } = await generateContent(extractionPrompt, { stats, timeout: 30000 });
    const cleanStr = jsonStr.replace(/```json\n?|\n?```/g, "").trim();
    const result = JSON.parse(cleanStr);
    
    return {
      mentioned: !!result.mentioned,
      position: result.position || "omitted",
      sentiment: result.sentiment || "neutral",
      citations: result.citations || [],
      competitors_found: result.competitors_found || [],
      key_phrases: result.key_phrases || [],
      judge_method: "llm",
      judge_model_used: judgeModelUsed || ""
    };
  } catch (e) {
    console.warn("LLM judge failed:", e.message);
    return null;
  }
}
