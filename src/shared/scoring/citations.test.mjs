import test from 'node:test';
import assert from 'node:assert/strict';
import { extractBrandDomain, normalizeUrl, classifyCitation, aggregateTopDomains } from './citations.js';

test('extractBrandDomain - parsing correctness', () => {
  assert.equal(extractBrandDomain("https://www.acme.io/pricing"), "acme.io");
  assert.equal(extractBrandDomain("http://beta.com"), "beta.com");
  assert.equal(extractBrandDomain("linear.app/docs"), "linear.app");
  assert.equal(extractBrandDomain(""), "");
  assert.equal(extractBrandDomain(null), "");
});

test('normalizeUrl - strips queries and trailing slash', () => {
  assert.equal(normalizeUrl("https://www.acme.io/pricing?ref=google"), "https://www.acme.io/pricing");
  assert.equal(normalizeUrl("http://beta.com/docs/"), "http://beta.com/docs");
  assert.equal(normalizeUrl("linear.app"), "http://linear.app");
});

test('classifyCitation - brand, competitor, third party', () => {
  const brandUrl = "https://acme.io";
  const competitors = ["Beta CRM", "Linear"];
  
  assert.equal(classifyCitation("https://acme.io/docs", brandUrl, competitors), "brand");
  assert.equal(classifyCitation("https://www.acme.io", brandUrl, competitors), "brand");
  
  assert.equal(classifyCitation("https://beta.com/pricing", brandUrl, competitors), "competitor");
  assert.equal(classifyCitation("https://linear.app", brandUrl, competitors), "competitor");
  
  assert.equal(classifyCitation("https://google.com", brandUrl, competitors), "third_party");
});

test('aggregateTopDomains - counts and sorts correctly', () => {
  const results = [
    { citations: ["https://acme.io/pricing", "https://google.com"] },
    { citations: ["https://acme.io/docs", "https://linear.app"] },
    { citations: ["https://google.com"] }
  ];
  const brandUrl = "https://acme.io";
  const competitors = ["Linear"];
  
  const aggregated = aggregateTopDomains(results, brandUrl, competitors);
  
  assert.equal(aggregated.length, 3);
  
  // Sorted by count descending, then alphabetically
  assert.equal(aggregated[0].domain, "acme.io");
  assert.equal(aggregated[0].count, 2);
  assert.equal(aggregated[0].type, "brand");
  
  assert.equal(aggregated[1].domain, "google.com");
  assert.equal(aggregated[1].count, 2);
  assert.equal(aggregated[1].type, "third_party");
  
  assert.equal(aggregated[2].domain, "linear.app");
  assert.equal(aggregated[2].count, 1);
  assert.equal(aggregated[2].type, "competitor");
});
