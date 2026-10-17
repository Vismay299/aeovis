import { generateContent } from "../gemini.js";
import { getBrandAliases } from "./aliases.js";
import {
  judgeBrandsSymmetricV2,
  classifyEntityRelationshipAndSentiment,
  extractListRank,
  RELATIONSHIP,
  JUDGE_VERSION,
} from "./judgeRelationship.js";

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
 * Returns the character index of the first (leftmost) word-boundary match of
 * any alias in `aliases`, or -1 if none match. P1.1 in-answer-position
 * building block.
 *
 * Uses the same boundary definition as detectMention (a non-alphanumeric/
 * underscore character, or start/end of string) but via zero-width
 * lookaround so the returned index is the alias's own first character —
 * never shifted by a consumed boundary character — and "a match was found
 * here" always agrees with what detectMention(text, aliases) would return.
 */
export function findFirstMentionIndex(text, aliases) {
  if (!text || !aliases || aliases.length === 0) return -1;

  let firstIdx = Infinity;
  for (const alias of aliases) {
    const cleanAlias = alias.toLowerCase();
    const escaped = cleanAlias.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
    const regex = new RegExp(`(?<![a-zA-Z0-9_])${escaped}(?![a-zA-Z0-9_])`, "i");
    const match = regex.exec(text);
    if (match && match.index < firstIdx) {
      firstIdx = match.index;
    }
  }
  return firstIdx === Infinity ? -1 : firstIdx;
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
 * P1.1 sentiment contract: the deterministic categorical detector
 * (detectSentiment) mapped to a 0-100 int.
 *
 *   positive -> 100, neutral -> 50, negative -> 0
 *
 * IMPORTANT — null vs 0: this returns `null` (never `0`) when `aliases`
 * isn't mentioned in `text` at all. `0` means "mentioned and read as
 * negative"; `null` means "brand absent from this answer". Averaging those
 * two cases together would silently drag sentiment_avg down for every answer
 * a brand simply wasn't in — see src/lib/analytics/rollup.js's
 * computeBrandRollups, which relies on this distinction to filter absent
 * brands out of the mean instead of scoring them as maximally negative.
 */
const SENTIMENT_SCORE = { positive: 100, neutral: 50, negative: 0 };

export function detectSentimentScore(text, aliases) {
  if (!detectMention(text, aliases)) return null;
  const category = detectSentiment(text, aliases);
  return SENTIMENT_SCORE[category] ?? 50;
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
 * NOTE on LLM Disagreement Scope: To preserve scan performance and control API costs,
 * the LLM judge is selectively triggered only when the response is marked as ambiguous (isAmbiguous).
 * Deterministic vs LLM judge disagreement is therefore tracked only on these ambiguous runs.
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
 * P1.2 symmetric per-answer brand judging: computes mention + in-answer
 * position + sentiment for the self brand AND every tracked competitor from
 * the SAME answer text, reusing the exact deterministic alias-matching
 * machinery detectMention/findFirstMentionIndex/detectSentiment already use
 * (no LLM — see the deterministic-vs-LLM note below).
 *
 * `brands` is `[{ name, aliases, isSelf }, ...]`. Callers build this with
 * getBrandAliases(brand, url) for the self brand and getBrandAliases(comp, "")
 * for each tracked competitor (no website known for a rival) — exactly
 * mirroring enginePipeline.js's findCompetitorsInText/findCompetitorsCited
 * (see buildTrackedBrandRoster there).
 *
 * Position contract (P1.1): the 1-based rank of a brand's FIRST alias
 * occurrence among the ordered distinct brand mentions in the text — e.g. if
 * the text names [Rival A, You, Rival B] in that reading order, You are
 * position 2. Ranking is scoped to the roster passed in here (there is no
 * way to rank against untracked brands we have no aliases for). This is NOT
 * brand_organic_position (organic SERP rank from Bright Data) — an entirely
 * separate signal that stays untouched.
 *
 * Sentiment contract (P1.1): see detectSentimentScore — positive=100,
 * neutral=50, negative=0, null (never 0) when unmentioned.
 *
 * Returns one record per input brand, in the SAME order as `brands`,
 * REGARDLESS of whether it was mentioned — symmetric: self and every
 * competitor always get a record, so result_brands can carry a complete
 * one-row-per-tracked-brand matrix per answer, not just the brands that
 * happened to be mentioned.
 *
 * Deterministic-only (no LLM assist): the contract above is fully mechanical
 * — a word-boundary regex scan plus a keyword-window sentiment count — with
 * no ambiguous judgment call for a model to resolve, so an LLM pass would
 * only add latency/cost/a new failure mode on the hot probing path (this
 * runs once per probe, and a scan already fans out to dozens of probes)
 * without changing the answer. See judge.js's own judgeWithLLM/isAmbiguous
 * for the (separately dead, pre-existing) pattern this deliberately does not
 * extend.
 */
export function judgeBrandsSymmetric(text, brands, options = {}) {
  const v2Results = judgeBrandsSymmetricV2(text, brands, options);
  return v2Results.map((r) => ({
    name: r.name,
    is_self: r.is_self,
    mentioned: r.mentioned,
    position: r.first_mention_order,
    first_mention_order: r.first_mention_order,
    relationship: r.relationship,
    list_rank: r.list_rank,
    list_rank_reason: r.list_rank_reason,
    sentiment: r.sentiment_score,
    sentiment_label: r.sentiment,
    spans: r.spans,
    judge_method: r.judge_method,
    judge_version: r.judge_version,
  }));
}

export {
  judgeBrandsSymmetricV2,
  classifyEntityRelationshipAndSentiment,
  extractListRank,
  RELATIONSHIP,
  JUDGE_VERSION,
};

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
