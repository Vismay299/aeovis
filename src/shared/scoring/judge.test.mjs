import test from 'node:test';
import assert from 'node:assert/strict';
import { getBrandAliases } from './aliases.js';
import {
  detectMention,
  detectPosition,
  detectSentiment,
  extractCitations,
  detectSentimentScore,
  findFirstMentionIndex,
  judgeBrandsSymmetric,
} from './judge.js';

test('getBrandAliases - extraction and formatting', () => {
  const aliases = getBrandAliases("Acme Corp", "https://acme.io");
  assert.ok(aliases.includes("Acme Corp"));
  assert.ok(aliases.includes("acme.io"));
  assert.ok(aliases.includes("Acme"));
  assert.ok(aliases.includes("acme"));
  
  // Hand-sorted by length descending
  assert.equal(aliases[0], "Acme Corp");
});

test('detectMention - word boundary checks', () => {
  const aliases = ["Acme", "acme.io"];
  
  // Standard matches
  assert.equal(detectMention("Acme is the best B2B software.", aliases), true);
  assert.equal(detectMention("We highly recommend acme.", aliases), true);
  assert.equal(detectMention("Check out acme.io for details.", aliases), true);
  
  // Word boundary failures
  assert.equal(detectMention("This is an acmeist philosophy.", aliases), false);
  assert.equal(detectMention("acme-like solutions are here.", aliases), true); // hyphen acts as non-alphanumeric boundary
});

test('detectPosition - hierarchy checks', () => {
  const aliases = ["Acme"];
  const competitors = ["Beta CRM"];
  
  // Recommended
  assert.equal(detectPosition("We recommend Acme.", aliases, competitors), "recommended");
  
  // Compared
  assert.equal(detectPosition("Comparing Acme and Beta CRM side by side.", aliases, competitors), "compared");
  
  // Cited (surrounding domain matching or far in the text)
  assert.equal(detectPosition("Visit the acme.io website for docs.", aliases, competitors), "cited");
  
  // Omitted
  assert.equal(detectPosition("HubSpot is our top choice.", aliases, competitors), "omitted");
});

test('detectSentiment - polarity checks', () => {
  const aliases = ["Acme"];
  
  assert.equal(detectSentiment("Acme is the best and most reliable tool.", aliases), "positive");
  assert.equal(detectSentiment("Acme has been slow and difficult to configure.", aliases), "negative");
  assert.equal(detectSentiment("Acme is a CRM software.", aliases), "neutral");
});

test('extractCitations - regex parser', () => {
  const text = "Links: https://acme.io/pricing and http://beta.com/docs.";
  const urls = extractCitations(text);
  assert.equal(urls.length, 2);
  assert.ok(urls.includes("https://acme.io/pricing"));
  assert.ok(urls.includes("http://beta.com/docs"));
});

// =============================================================================
// P1.1 — findFirstMentionIndex (in-answer position building block)
// =============================================================================

test('findFirstMentionIndex - returns the earliest word-boundary alias match', () => {
  const aliases = ["Acme", "acme.io"];
  assert.equal(findFirstMentionIndex("Visit acme.io for Acme docs.", aliases), 6, "acme.io occurs before the later Acme mention");
  assert.equal(findFirstMentionIndex("Nothing relevant here.", aliases), -1);
});

test('findFirstMentionIndex - agrees with detectMention on word-boundary edge cases', () => {
  const aliases = ["Acme"];
  assert.equal(findFirstMentionIndex("This is an acmeist philosophy.", aliases), -1, "substring without a word boundary must not match, same as detectMention");
  assert.equal(findFirstMentionIndex("acme-like solutions are here.", aliases), 0, "hyphen is a valid boundary, same as detectMention");
});

test('findFirstMentionIndex - empty text/aliases return -1, never throw', () => {
  assert.equal(findFirstMentionIndex("", ["Acme"]), -1);
  assert.equal(findFirstMentionIndex("Acme is great", []), -1);
  assert.equal(findFirstMentionIndex("Acme is great", null), -1);
});

// =============================================================================
// P1.1 — detectSentimentScore (0-100 mapping, null vs 0)
// =============================================================================

test('detectSentimentScore - maps positive/neutral/negative to 100/50/0', () => {
  const aliases = ["Acme"];
  assert.equal(detectSentimentScore("Acme is the best and most reliable tool.", aliases), 100);
  assert.equal(detectSentimentScore("Acme is a CRM software.", aliases), 50);
  assert.equal(detectSentimentScore("Acme has been slow and difficult to configure.", aliases), 0);
});

test('detectSentimentScore - null (never 0) when the brand is not mentioned at all', () => {
  const aliases = ["Acme"];
  const result = detectSentimentScore("HubSpot is our top choice.", aliases);
  assert.equal(result, null, "absence must be null");
  assert.notEqual(result, 0, "absence must never collapse to the negative score — null and 0 mean different things");
});

// =============================================================================
// P1.2 — judgeBrandsSymmetric (symmetric self+rival mention/position/sentiment)
// =============================================================================

test('judgeBrandsSymmetric - ranks position by first-occurrence order across the tracked roster (contract example: [Rival A, You, Rival B] -> You is position 2)', () => {
  const roster = [
    { name: "You", aliases: ["You Inc"], isSelf: true },
    { name: "Rival A", aliases: ["Rival A"], isSelf: false },
    { name: "Rival B", aliases: ["Rival B"], isSelf: false },
  ];
  const text = "Rival A is popular, but You Inc is catching up fast, while Rival B trails behind.";
  const result = judgeBrandsSymmetric(text, roster);

  assert.equal(result.find((r) => r.name === "Rival A").position, 1);
  assert.equal(result.find((r) => r.name === "You").position, 2);
  assert.equal(result.find((r) => r.name === "Rival B").position, 3);
});

test('judgeBrandsSymmetric - emits one record per tracked brand regardless of mention (symmetric), in roster order', () => {
  const roster = [
    { name: "Acme", aliases: ["Acme"], isSelf: true },
    { name: "Mentioned Rival", aliases: ["Mentioned Rival"], isSelf: false },
    { name: "Absent Rival", aliases: ["Absent Rival"], isSelf: false },
  ];
  const text = "Acme and Mentioned Rival are both solid CRM picks.";
  const result = judgeBrandsSymmetric(text, roster);

  assert.equal(result.length, 3, "self + every tracked competitor gets a record, mentioned or not");
  assert.deepEqual(result.map((r) => r.name), ["Acme", "Mentioned Rival", "Absent Rival"], "same order as the input roster");

  const acme = result[0];
  assert.equal(acme.is_self, true);
  assert.equal(acme.mentioned, true);

  const mentionedRival = result[1];
  assert.equal(mentionedRival.is_self, false);
  assert.equal(mentionedRival.mentioned, true);

  const absentRival = result[2];
  assert.equal(absentRival.is_self, false);
  assert.equal(absentRival.mentioned, false);
  assert.equal(absentRival.position, null);
  assert.equal(absentRival.sentiment, null, "never 0 for a brand that was never mentioned");
});

test('judgeBrandsSymmetric - a negatively-reviewed but mentioned brand scores sentiment 0, distinct from an absent brand\'s null', () => {
  const roster = [
    { name: "Acme", aliases: ["Acme"], isSelf: true },
    { name: "Absent Co", aliases: ["Absent Co"], isSelf: false },
  ];
  const text = "Acme has been slow, buggy, and a poor experience overall.";
  const result = judgeBrandsSymmetric(text, roster);

  const acme = result.find((r) => r.name === "Acme");
  const absent = result.find((r) => r.name === "Absent Co");

  assert.equal(acme.mentioned, true);
  assert.equal(acme.sentiment, 0, "mentioned + negative -> a real score of 0");
  assert.equal(absent.mentioned, false);
  assert.equal(absent.sentiment, null, "not mentioned -> null, NEVER 0 -- 0 and null must never be conflated");
});

test('judgeBrandsSymmetric - ranks by whichever alias form of a brand occurs first (multiple alias forms per brand)', () => {
  const roster = [
    { name: "Acme", aliases: ["Acme Corp", "Acme", "acme.io"], isSelf: true },
    { name: "Rival", aliases: ["Rival"], isSelf: false },
  ];
  const text = "Check out acme.io first, then compare against Rival.";
  const result = judgeBrandsSymmetric(text, roster);
  assert.equal(result.find((r) => r.name === "Acme").position, 1, "matched via the acme.io alias form");
  assert.equal(result.find((r) => r.name === "Rival").position, 2);
});

test('judgeBrandsSymmetric - position is scoped to the tracked roster only, unaffected by which competitors are tracked', () => {
  // Same text, but only ONE of the two mentioned brands is tracked -> ranking
  // is relative to the roster passed in, not to every entity in the text.
  const roster = [{ name: "You", aliases: ["You Inc"], isSelf: true }];
  const text = "Rival A leads the market, though You Inc is a fast follower.";
  const result = judgeBrandsSymmetric(text, roster);
  assert.equal(result.length, 1);
  assert.equal(result[0].position, 1, "the only tracked brand is always rank 1 among itself");
});

test('judgeBrandsSymmetric - empty/missing text or roster does not throw', () => {
  const [empty] = judgeBrandsSymmetric("", [{ name: "Acme", aliases: ["Acme"], isSelf: true }]);
  assert.equal(empty.name, "Acme");
  assert.equal(empty.is_self, true);
  assert.equal(empty.mentioned, false);
  assert.equal(empty.position, null);
  assert.equal(empty.sentiment, null);
  assert.equal(empty.list_rank_reason, "empty_text");
  assert.deepEqual(judgeBrandsSymmetric("Acme is great.", []), []);
  assert.deepEqual(judgeBrandsSymmetric("Acme is great.", undefined), []);
});

test('judgeBrandsSymmetric - integrates with getBrandAliases exactly as enginePipeline.js resolves them (self by brand+url, rival by name only)', () => {
  const selfAliases = getBrandAliases("Acme Corp", "https://acme.io");
  const rivalAliases = getBrandAliases("Beta CRM", "");
  const roster = [
    { name: "Acme Corp", aliases: selfAliases, isSelf: true },
    { name: "Beta CRM", aliases: rivalAliases, isSelf: false },
  ];
  const text = "Beta CRM is fine, but acme.io is the better long-term bet.";
  const result = judgeBrandsSymmetric(text, roster);
  assert.equal(result.find((r) => r.name === "Beta CRM").position, 1);
  assert.equal(result.find((r) => r.name === "Acme Corp").position, 2, "matched via the acme.io domain alias");
});
