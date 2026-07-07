import test from 'node:test';
import assert from 'node:assert/strict';
import { getBrandAliases } from './aliases.js';
import { detectMention, detectPosition, detectSentiment, extractCitations } from './judge.js';

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
