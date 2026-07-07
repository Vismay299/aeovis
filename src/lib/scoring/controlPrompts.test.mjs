import test from 'node:test';
import assert from 'node:assert/strict';
import { detectMention } from './judge.js';
import { getBrandAliases } from './aliases.js';

test('detectMention - control prompt matching correctness', () => {
  // iPhone expected mention "Apple"
  assert.ok(detectMention("This is made by Apple in California.", ["Apple"]));
  assert.ok(detectMention("Apple's new device is here.", ["Apple"]));
  
  // Word boundary checks: Pineapple contains Apple but should not match!
  assert.ok(!detectMention("I ate a pineapple.", ["Apple"]));
});

test('brand-in-prompt detection logic simulation', () => {
  const brand = "Acme";
  const website = "acme.io";
  const aliases = getBrandAliases(brand, website); // ['acme', 'acme.io']

  const promptText1 = "What is the best CRM tool for startups?";
  const promptText2 = "Why is Acme CRM so popular?";

  const hasBrandAlias1 = aliases.some(alias => {
    const escaped = alias.toLowerCase().replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
    const regex = new RegExp(`(?:^|[^a-zA-Z0-9_])${escaped}(?:$|[^a-zA-Z0-9_])`, "i");
    return regex.test(promptText1.toLowerCase());
  });

  const hasBrandAlias2 = aliases.some(alias => {
    const escaped = alias.toLowerCase().replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
    const regex = new RegExp(`(?:^|[^a-zA-Z0-9_])${escaped}(?:$|[^a-zA-Z0-9_])`, "i");
    return regex.test(promptText2.toLowerCase());
  });

  assert.equal(hasBrandAlias1, false);
  assert.equal(hasBrandAlias2, true);
});

test('probe failure rate mathematical threshold', () => {
  const brandRuns = [
    { model_used: "gemini", raw_response: "Acme is a great tool." },
    { model_used: "perplexity-failed", raw_response: "" }, // failed probe
    { model_used: "openai", raw_response: "" }, // empty response is a failure
    { model_used: "gemini-skipped", raw_response: "" } // skipped engine is ignored
  ];

  const totalBrandProbes = brandRuns.length;
  const failedBrandProbes = brandRuns.filter(run => {
    const isFailed = run.model_used?.endsWith("-failed");
    const isEmpty = !run.raw_response?.trim();
    const isSkipped = run.model_used?.includes("skipped");
    return isFailed || (isEmpty && !isSkipped);
  }).length;

  const probeFailureRate = totalBrandProbes > 0 ? failedBrandProbes / totalBrandProbes : 0.0;
  // total probes = 4. failed probes = perplexity-failed (1) + empty openai (1) = 2. rate = 2 / 4 = 50%
  assert.equal(probeFailureRate, 0.50);
});
